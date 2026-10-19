/**
 * `bw serve` persistant : le CLI Bitwarden met 3 à 4 s à chaque appel (démarrage de Node, puis déchiffrement du
 * coffre), soit une quinzaine de secondes pour lister puis remplir un identifiant. Tant que le coffre est ouvert,
 * le démon garde un `bw serve` qui répond en quelques millisecondes ; le CLI ne sert plus qu'au reste (connexion,
 * déverrouillage, verrouillage) et en secours.
 *
 * Sécurité : l'API de `bw serve` n'a pas d'authentification. Elle n'écoute donc jamais sur un port TCP, mais sur
 * un socket unix dans un dossier 0700 (Linux, macOS) ou sur un tube nommé au nom aléatoire (Windows) : seul le
 * compte de l'utilisateur la joint, pas un agent qui tourne sous un autre compte. La protection d'origine de bw
 * reste active (requêtes avec en-tête Origin refusées). La clé de session passe par l'environnement, jamais par argv.
 *
 * Fiabilité : chaque méthode renvoie `undefined` quand le serveur n'est pas disponible (pas encore prêt, en panne,
 * réponse illisible) : l'appelant passe alors par le CLI, et le serveur est relancé (5 s, puis 30 s, puis 2 min).
 * Une erreur du coffre lui-même (verrouillé, élément introuvable) est levée en BwError, comme le ferait le CLI.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  BW_ENV_APPDATA,
  BW_ENV_SESSION,
  BwError,
  bwCandidates,
  isBwField,
  parseBwStatus,
  scrubBwError,
  type BwCandidate,
  type BwField,
  type BwStatus,
} from "./bitwarden.ts";

/** Hôte attendu par la protection de `bw serve` : son port par défaut, même sur un socket. */
const SERVE_HOST = "localhost:8087";
const READY_TIMEOUT_MS = 20_000;
/** Attente d'un serveur en cours de démarrage avant de passer par le CLI. */
const WAIT_START_MS = 8_000;
const CALL_TIMEOUT_MS = 10_000;
const SYNC_TIMEOUT_MS = 60_000;
const RETRY_MS = [5_000, 30_000, 120_000];
/** Adresse fictive (TLD réservé) pour le préchauffage : aucun élément du coffre n'y correspond. */
const WARMUP_URL = "https://abc-prechauffage.invalid";

export interface BwServeOptions {
  /** Chemin du CLI, résolu à la demande (null : CLI introuvable, pas de serveur). */
  bwPath: () => Promise<string | null>;
  appDataDir?: string;
  /** Dossier de configuration d'ABC : le socket vit dans son sous-dossier `bw-serve` (0700). */
  configDir: string;
  log: (entry: Record<string, unknown>) => void;
  enabled?: boolean;
  /** Tests : programme lancé à la place du CLI (arguments placés avant `serve`), délais de relance. */
  command?: { exe: string; args: string[] };
  retryMs?: number[];
}

export interface BwServe {
  /** Lance le serveur pour cette session (le relance si elle change) ; sans session, l'arrête. */
  setSession(key: string | null): void;
  status(): Promise<BwStatus | undefined>;
  matchUrl(url: string): Promise<BwCandidate[] | undefined>;
  search(query: string): Promise<BwCandidate[] | undefined>;
  resolve(itemId: string, field: BwField): Promise<string | undefined>;
  sync(): Promise<boolean | undefined>;
  stop(): void;
  info(): { running: boolean; ready: boolean; pid: number | null; failures: number };
}

interface Instance {
  proc: ChildProcess;
  address: string;
  tempDir?: string;
  ok: boolean;
  ready: Promise<boolean>;
  started: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createBwServe(options: BwServeOptions): BwServe {
  const enabled = options.enabled !== false;
  const retryMs = options.retryMs ?? RETRY_MS;
  const win = platform() === "win32";
  const dir = join(options.configDir, "bw-serve");
  const pidFile = join(dir, "bw-serve.pid");
  let session: string | null = null;
  let inst: Instance | null = null;
  let pending: Promise<Instance | null> | null = null;
  let failures = 0;
  let retryAt = 0;

  /** Requête JSON brute au serveur ; rejette sur toute panne de transport ou réponse illisible. */
  function raw(target: Instance, method: "GET" | "POST", path: string, timeoutMs: number): Promise<{ success?: unknown; message?: unknown; data?: any }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { Host: SERVE_HOST, Accept: "application/json" };
      if (method === "POST") headers["Content-Length"] = "0";
      const req = request({ socketPath: target.address, method, path, headers, timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!body || typeof body !== "object") throw new Error("réponse vide");
            resolve(body);
          } catch {
            reject(new Error(`réponse illisible (HTTP ${res.statusCode})`));
          }
        });
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error(`pas de réponse en ${Math.round(timeoutMs / 1000)} s`)));
      req.on("error", reject);
      req.end();
    });
  }

  /** Adresse d'écoute privée : socket dans un dossier 0700, ou tube nommé aléatoire sous Windows. */
  function newAddress(): { address: string; tempDir?: string } {
    if (win) return { address: `\\\\.\\pipe\\abc-bw-${randomBytes(12).toString("hex")}` };
    let base = dir;
    let tempDir: string | undefined;
    // Les chemins de socket sont limités (104 octets sous macOS, 108 sous Linux).
    if (join(base, "bw.sock").length > 100) base = tempDir = mkdtempSync(join(tmpdir(), "abc-bw-"));
    mkdirSync(base, { recursive: true, mode: 0o700 });
    chmodSync(base, 0o700);
    const address = join(base, "bw.sock");
    rmSync(address, { force: true });
    return { address, ...(tempDir && { tempDir }) };
  }

  /** Un serveur laissé par un démon tué net (Linux) : reconnu par sa ligne de commande, puis arrêté. */
  function killOrphan() {
    if (win) return;
    try {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (pid > 1 && cmd.includes("serve") && cmd.includes(join(dir, "bw.sock"))) process.kill(pid);
    } catch {}
    rmSync(pidFile, { force: true });
  }

  function kill(target: Instance) {
    if (inst === target) inst = null;
    try {
      target.proc.kill();
    } catch {}
    if (!win) {
      rmSync(target.address, { force: true });
      if (target.tempDir) rmSync(target.tempDir, { recursive: true, force: true });
      rmSync(pidFile, { force: true });
    }
  }

  function failed(reason: string) {
    failures++;
    const delay = retryMs[Math.min(failures - 1, retryMs.length - 1)];
    retryAt = Date.now() + delay;
    options.log({ event: "bw-serve", ok: false, reason, retryInMs: delay });
    setTimeout(() => void ensure(), delay + 20).unref();
  }

  async function waitReady(target: Instance): Promise<boolean> {
    while (Date.now() - target.started < READY_TIMEOUT_MS) {
      if (inst !== target) return false;
      const res = await raw(target, "GET", "/status", 1000).catch(() => null);
      if (res) {
        const st = res.success === true ? parseBwStatus(JSON.stringify(res.data?.template ?? {})) : { state: "unknown" };
        if (st.state !== "unlocked") {
          kill(target);
          failed(`coffre ${st.state} pour bw serve (session refusée)`);
          return false;
        }
        // Le dossier 0700 suffit à fermer le socket aux autres comptes ; le socket lui-même aussi, par prudence.
        if (!win) {
          try {
            chmodSync(target.address, 0o600);
          } catch {}
        }
        // Préchauffage : la première correspondance par adresse déchiffre le coffre et prépare les règles d'adresse
        // (0,3 à 1 s, mesuré) ; la recherche texte ne prépare pas ce chemin. Deux passes sur une adresse fictive.
        for (let i = 0; i < 2; i++) await raw(target, "GET", `/list/object/items?url=${encodeURIComponent(WARMUP_URL)}`, CALL_TIMEOUT_MS).catch(() => {});
        if (inst !== target) return false;
        target.ok = true;
        failures = 0;
        options.log({ event: "bw-serve", ok: true, readyMs: Date.now() - target.started });
        return true;
      }
      await sleep(100);
    }
    kill(target);
    failed(`pas prêt en ${READY_TIMEOUT_MS / 1000} s`);
    return false;
  }

  function launch(exe: string, key: string): Instance {
    killOrphan();
    const { address, tempDir } = newAddress();
    const env: Record<string, string> = { ...(process.env as Record<string, string>), NO_COLOR: "1", [BW_ENV_SESSION]: key };
    if (options.appDataDir) env[BW_ENV_APPDATA] = options.appDataDir;
    const args = [...(options.command?.args ?? []), "serve", "--hostname", `unix://${address}`, "--nointeraction"];
    const proc = spawn(exe, args, { env, stdio: "ignore", windowsHide: true });
    const target: Instance = { proc, address, ...(tempDir && { tempDir }), ok: false, ready: Promise.resolve(false), started: Date.now() };
    inst = target;
    if (!win && proc.pid) {
      try {
        writeFileSync(pidFile, String(proc.pid), { mode: 0o600 });
      } catch {}
    }
    const lost = (why: string) => {
      if (inst !== target) return; // arrêt voulu (verrouillage, nouvelle session, fin du démon)
      kill(target);
      if (session) failed(why);
    };
    proc.on("error", (err) => lost(`lancement impossible : ${scrubBwError(err)}`));
    proc.on("exit", (code, signal) => lost(`arrêt inattendu (${signal ?? `code ${code}`})`));
    target.ready = waitReady(target);
    return target;
  }

  /** Le serveur de la session en cours, lancé au besoin (sauf pendant le délai de relance). */
  function ensure(): Promise<Instance | null> {
    if (inst) return Promise.resolve(inst);
    if (!enabled || !session || Date.now() < retryAt) return Promise.resolve(null);
    if (pending) return pending;
    const p = (async () => {
      try {
        const key = session;
        const exe = options.command?.exe ?? (await options.bwPath());
        if (!exe || !key || key !== session) return null;
        return inst ?? launch(exe, key);
      } catch (err) {
        failed(`lancement impossible : ${scrubBwError(err)}`);
        return null;
      }
    })();
    pending = p;
    void p.finally(() => {
      if (pending === p) pending = null;
    });
    return p;
  }

  /** Serveur prêt (en attendant au plus WAIT_START_MS un démarrage en cours), ou null : passer par le CLI. */
  async function usable(): Promise<Instance | null> {
    const target = await ensure();
    if (!target) return null;
    if (!target.ok && !(await Promise.race([target.ready, sleep(WAIT_START_MS).then(() => false)]))) return null;
    return inst === target && target.ok ? target : null;
  }

  /** `data` d'une réponse réussie ; undefined si le serveur fait défaut ; BwError pour une erreur du coffre. */
  async function call(method: "GET" | "POST", path: string, timeoutMs = CALL_TIMEOUT_MS): Promise<{ data: any } | undefined> {
    const target = await usable();
    if (!target) return undefined;
    let res;
    try {
      res = await raw(target, method, path, timeoutMs);
    } catch (err) {
      // Panne de transport : cet appel passe par le CLI, le serveur est relancé.
      kill(target);
      failed(`requête en échec : ${scrubBwError(err)}`);
      return undefined;
    }
    if (res.success === true) return { data: res.data };
    const message = typeof res.message === "string" && res.message ? res.message : "Échec du serveur Bitwarden local.";
    // Session périmée : le serveur ne servira plus ; le démon verrouille (même message que le CLI).
    if (/vault is locked|not logged in|unauthenticated/i.test(message)) kill(target);
    throw new BwError(scrubBwError(message));
  }

  const listOf = (res: { data: any } | undefined) => (res ? bwCandidates(res.data?.data) : undefined);

  return {
    setSession(key) {
      if (key === session) return;
      session = key;
      failures = 0;
      retryAt = 0;
      if (inst) kill(inst);
      if (key) void ensure();
    },
    async status() {
      const res = await call("GET", "/status");
      return res ? parseBwStatus(JSON.stringify(res.data?.template ?? {})) : undefined;
    },
    async matchUrl(url) {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        throw new BwError("Adresse de page invalide.");
      }
      if (!/^https?:$/.test(target.protocol)) return [];
      // Origine seule, comme pour le CLI : le chemin et la requête de la page ne sortent pas.
      return listOf(await call("GET", `/list/object/items?url=${encodeURIComponent(target.origin)}`));
    },
    async search(query) {
      const q = query.trim();
      if (!q) throw new BwError("Recherche vide.");
      return listOf(await call("GET", `/list/object/items?search=${encodeURIComponent(q)}`));
    },
    async resolve(itemId, field) {
      const id = itemId.trim();
      if (!id) throw new BwError("Référence d'item Bitwarden vide.");
      if (!isBwField(field)) throw new BwError(`Champ invalide : ${JSON.stringify(field)}.`);
      const res = await call("GET", `/object/${field}/${encodeURIComponent(id)}`);
      if (!res) return undefined;
      const value = res.data?.data;
      if (typeof value !== "string") throw new BwError("Réponse inattendue du serveur Bitwarden local.");
      return value;
    },
    async sync() {
      return (await call("POST", "/sync", SYNC_TIMEOUT_MS)) ? true : undefined;
    },
    stop() {
      session = null;
      if (inst) kill(inst);
    },
    info() {
      return { running: !!inst, ready: !!inst?.ok, pid: inst?.proc.pid ?? null, failures };
    },
  };
}
