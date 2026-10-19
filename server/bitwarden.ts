/**
 * Pont Bitwarden (CLI `bw`) : résout les secrets d'un coffre Bitwarden pour credentials_fill.
 *
 * Principe : les slots dits "externes" ne stockent aucune valeur, seulement une référence
 * (id d'item Bitwarden). Au moment du remplissage, l'extension demande au démon de résoudre
 * la valeur via le CLI, puis remplit aveuglément. Comme pour le coffre intégré :
 * règle d'or, aucun secret en clair dans les paramètres MCP, les retours agent, les logs
 * ou le HAR. Les valeurs ne transitent que sur le WebSocket local démon <-> extension.
 *
 * Hygiène d'exécution :
 * - `bw` est lancé via execFile, sans shell (pas d'injection par un nom d'item piégé).
 * - Le mot de passe maître et la clé de session passent par l'environnement
 *   (ABC_BW_PASSWORD + --passwordenv, BW_SESSION), jamais en argv (visible via ps).
 * - La clé de session vit en mémoire du démon uniquement ; `bw lock` la détruit aussi
 *   côté CLI. Le mot de passe maître sert une fois à `bw unlock` puis est abandonné.
 * - `bw get password|username <id> --raw` ne renvoie que le champ demandé, pas l'item
 *   complet. La recherche (`bw-search`) renvoie des candidats expurgés (id, nom,
 *   identifiant, urls) : mots de passe, notes et champs perso sont jetés côté démon.
 */
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const BW_ENV_SESSION = "BW_SESSION";
export const BW_ENV_PASSWORD = "ABC_BW_PASSWORD";
export const BW_UNLOCK_TIMEOUT_MS = 30_000;
export const BW_DEFAULT_TIMEOUT_MS = 30_000;
export const BW_SYNC_TIMEOUT_MS = 60_000;
/** Connexion : dérivation de la clé puis synchronisation complète du coffre (sous le délai RPC de l'extension, 65 s). */
export const BW_LOGIN_TIMEOUT_MS = 55_000;

export type BwState = "unauthenticated" | "locked" | "unlocked" | "unknown";

export interface BwStatus {
  state: BwState;
  email?: string;
  serverUrl?: string;
}

export interface BwCandidate {
  id: string;
  name: string;
  username?: string;
  uris: string[];
}

export type BwField = "username" | "password";

/** Erreur d'usage (CLI absent, coffre verrouillé…) : message destiné à l'utilisateur. */
export class BwError extends Error {}

/**
 * `bw status` renvoie du JSON : {"serverUrl":…,"lastSync":…,"userEmail"?,"status":"locked"|…}.
 * Tolérant : un JSON inattendu donne "unknown", jamais d'exception.
 */
export function parseBwStatus(text: string): BwStatus {
  try {
    // Le CLI peut écrire une ligne d'information avant le JSON (profil neuf : « creating it instead ») :
    // on ne lit que l'objet.
    const start = text.indexOf("{");
    const raw = JSON.parse(start > 0 ? text.slice(start) : text) as { status?: unknown; userEmail?: unknown; serverUrl?: unknown };
    const state = raw?.status;
    if (state !== "unauthenticated" && state !== "locked" && state !== "unlocked") return { state: "unknown" };
    const out: BwStatus = { state };
    if (typeof raw.userEmail === "string" && raw.userEmail) out.email = raw.userEmail;
    if (typeof raw.serverUrl === "string" && raw.serverUrl) out.serverUrl = raw.serverUrl;
    return out;
  } catch {
    return { state: "unknown" };
  }
}

/**
 * `bw list items` renvoie le coffre complet en JSON (mots de passe et notes inclus).
 * N'en garde que l'identification (id, nom, identifiant, urls) : tout le reste est jeté
 * avant même de quitter ce module. Les items sans id sont ignorés.
 */
export function parseBwItems(text: string): BwCandidate[] {
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw)) throw new BwError("Réponse inattendue du CLI Bitwarden (liste).");
  const out: BwCandidate[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string" || !rec.id) continue;
    const login = (rec.login ?? {}) as Record<string, unknown>;
    const uris: string[] = [];
    if (Array.isArray(login.uris)) {
      for (const u of login.uris) {
        const uri = (u as Record<string, unknown>)?.uri;
        if (typeof uri === "string" && uri) uris.push(uri);
      }
    }
    const cand: BwCandidate = { id: rec.id, name: typeof rec.name === "string" ? rec.name : rec.id, uris };
    if (typeof login.username === "string" && login.username) cand.username = login.username;
    out.push(cand);
  }
  return out;
}

export function isBwField(field: unknown): field is BwField {
  return field === "username" || field === "password";
}

/** Message d'erreur nettoyé : une ligne, tronqué, sans écho d'arguments. */
export function scrubBwError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0].slice(0, 300) || "Échec du CLI Bitwarden.";
}

export interface BwRunOptions {
  sessionKey?: string;
  password?: string;
  timeoutMs?: number;
}

export type BwRunner = (
  exe: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

function defaultRunner(exe: string, args: string[], env: Record<string, string>, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(exe, args, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr ?? "").trim().split("\n")[0].slice(0, 200);
        reject(new Error(detail || err.message));
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * Localise le CLI : override ABC_BW_PATH (tests, install exotique), puis PATH
 * (`where`/`which`), puis l'emplacement WinGet sur Windows. Sous Windows, `bw.exe`
 * passe avant les lanceurs npm (`bw`, `bw.cmd`), qu'execFile ne sait pas lancer sans shell.
 */
export async function findBw(runner: BwRunner = defaultRunner): Promise<string | null> {
  if (process.env.ABC_BW_PATH) return process.env.ABC_BW_PATH;
  let fallback: string | undefined;
  try {
    const probe = platform() === "win32" ? "where" : "which";
    const { stdout } = await runner(probe, ["bw"], { ...process.env } as Record<string, string>, 10_000);
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (platform() !== "win32" && lines[0]) return lines[0];
    const exe = lines.find((l) => /\.exe$/i.test(l));
    if (exe) return exe;
    fallback = lines[0];
  } catch {}
  if (platform() === "win32") {
    try {
      const pkgs = join(homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages");
      for (const dir of readdirSync(pkgs)) {
        if (dir.startsWith("Bitwarden.CLI")) return join(pkgs, dir, "bw.exe");
      }
    } catch {}
  }
  return fallback ?? null;
}

export const BW_INSTALL_HINT =
  "CLI Bitwarden introuvable. Installez-le (gratuit) : `winget install --id Bitwarden.CLI`, " +
  "puis connectez-vous dans le panneau de l'extension (onglet Secrets).";

/** Variable du CLI qui choisit son dossier de données (profil). */
export const BW_ENV_APPDATA = "BITWARDENCLI_APPDATA_DIR";

/**
 * Adresse de serveur normalisée : https:// ajouté s'il manque, sans fragment (#/login), sans requête,
 * sans barre finale. Un sous-chemin est gardé (Vaultwarden peut être servi sous /vault).
 * http:// n'est accepté que pour la machine locale. Lève BwError si l'adresse est inutilisable.
 */
export function normalizeServerUrl(input: unknown): string {
  let s = String(input ?? "").trim();
  if (!s) throw new BwError("Adresse du serveur vide.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new BwError(`Adresse de serveur invalide : ${JSON.stringify(String(input)).slice(0, 120)}.`);
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new BwError("Le serveur doit être en https:// (http:// seulement pour localhost).");
  }
  if (u.username || u.password) throw new BwError("L'adresse du serveur ne doit pas contenir d'identifiants.");
  // Lien copié depuis le coffre web (https://hote/#/vault) : le chemin utile est avant le fragment.
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

export type BwServerKind = "vaultwarden" | "bitwarden";

export interface BwServerInfo {
  serverUrl: string;
  kind: BwServerKind;
  version?: string;
}

/**
 * Réponse de `<serveur>/api/config` (Bitwarden et Vaultwarden) : { server: { name }, version }.
 * Vaultwarden se nomme dans `server.name` ; le serveur officiel n'y met rien (null).
 */
export function parseServerConfig(serverUrl: string, text: string): BwServerInfo {
  let raw: { server?: { name?: unknown } | null; version?: unknown; object?: unknown };
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BwError("Ce serveur ne répond pas comme un serveur Bitwarden (réponse illisible sur /api/config).");
  }
  if (!raw || typeof raw !== "object" || (raw.object !== undefined && raw.object !== "config")) {
    throw new BwError("Ce serveur ne répond pas comme un serveur Bitwarden (/api/config inattendu).");
  }
  const name = typeof raw.server?.name === "string" ? raw.server.name : "";
  const info: BwServerInfo = { serverUrl, kind: /vaultwarden/i.test(name) ? "vaultwarden" : "bitwarden" };
  if (typeof raw.version === "string" && raw.version) info.version = raw.version.slice(0, 40);
  return info;
}

/** Vérifie qu'un serveur Bitwarden/Vaultwarden répond depuis cette machine (8 s au plus). */
export async function probeServer(input: unknown, fetchImpl: typeof fetch = fetch): Promise<BwServerInfo> {
  const serverUrl = normalizeServerUrl(input);
  let res: Response;
  try {
    res = await fetchImpl(`${serverUrl}/api/config`, { signal: AbortSignal.timeout(8000), redirect: "follow" });
  } catch (err) {
    const why = err instanceof Error && err.name === "TimeoutError" ? "pas de réponse en 8 s" : scrubBwError(err);
    throw new BwError(`Serveur injoignable depuis ce PC (${why}). Vérifiez l'adresse, et que Tailscale est connecté s'il s'agit d'un serveur privé.`);
  }
  if (!res.ok) throw new BwError(`Le serveur répond ${res.status} sur /api/config : est-ce bien l'adresse du coffre ?`);
  return parseServerConfig(serverUrl, await res.text());
}

/** Le CLI demande un code de connexion en deux étapes (application TOTP, e-mail…). */
export class BwNeedsCodeError extends BwError {
  readonly needsCode = true;
}

const NEEDS_CODE = /code is required|no provider selected|two-?step|two-?factor|new device/i;

export interface BwUnlocked {
  status: BwStatus;
  /** Clé de session : à garder en mémoire uniquement, jamais sur disque ni en log. */
  sessionKey: string;
}

export interface BitwardenClient {
  status(): Promise<BwStatus>;
  unlock(password: string): Promise<BwUnlocked>;
  lock(): Promise<void>;
  sync(sessionKey: string): Promise<void>;
  search(sessionKey: string, query: string): Promise<BwCandidate[]>;
  resolve(sessionKey: string, itemId: string, field: BwField): Promise<string>;
  /** Serveur du profil (Vaultwarden, Bitwarden auto-hébergé, ou bitwarden.com) : exige d'être déconnecté. */
  configServer(serverUrl: string): Promise<void>;
  /** Connexion e-mail + mot de passe maître (+ code en deux étapes si demandé) : renvoie aussi la clé de session. */
  login(email: string, password: string, code?: string): Promise<BwUnlocked>;
  logout(): Promise<void>;
  /** Éléments dont une adresse correspond à cette URL (règles de correspondance du coffre), expurgés. */
  matchUrl(sessionKey: string, url: string): Promise<BwCandidate[]>;
}

export interface BwClientOptions {
  /**
   * Dossier de données du CLI (profil). ABC garde le sien : la connexion au serveur choisi dans le panneau
   * ne touche pas au `bw` que l'utilisateur emploie lui-même dans un terminal.
   */
  appDataDir?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Client fin : construit les appels CLI. Les secrets (mot de passe maître, clé de
 * session) transitent par l'environnement, jamais par argv. Ne logue rien.
 */
export function createBitwardenClient(bwPath: string, runner: BwRunner = defaultRunner, options: BwClientOptions = {}): BitwardenClient {
  async function run(args: string[], opts: BwRunOptions = {}): Promise<string> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), NO_COLOR: "1" };
    if (options.appDataDir) env[BW_ENV_APPDATA] = options.appDataDir;
    const full = [...args];
    if (opts.sessionKey) env[BW_ENV_SESSION] = opts.sessionKey;
    if (opts.password !== undefined) {
      env[BW_ENV_PASSWORD] = opts.password;
      full.push("--passwordenv", BW_ENV_PASSWORD);
    }
    full.push("--nointeraction");
    try {
      const { stdout } = await runner(bwPath, full, env, opts.timeoutMs ?? BW_DEFAULT_TIMEOUT_MS);
      return stdout;
    } catch (err) {
      throw new BwError(scrubBwError(err));
    }
  }

  return {
    async status(): Promise<BwStatus> {
      return parseBwStatus(await run(["status"]));
    },
    async unlock(password: string): Promise<BwUnlocked> {
      if (!password) throw new BwError("Mot de passe maître vide.");
      const sessionKey = (await run(["unlock", "--raw"], { password, timeoutMs: BW_UNLOCK_TIMEOUT_MS })).trim();
      if (!sessionKey || sessionKey.includes("\n")) throw new BwError("Déverrouillage impossible (réponse inattendue).");
      const st = parseBwStatus(await run(["status"], { sessionKey }));
      if (st.state === "unknown") st.state = "unlocked";
      return { status: st, sessionKey };
    },
    async lock(): Promise<void> {
      await run(["lock"]);
    },
    async sync(sessionKey: string): Promise<void> {
      if (!sessionKey) throw new BwError("Coffre Bitwarden verrouillé.");
      await run(["sync"], { sessionKey, timeoutMs: BW_SYNC_TIMEOUT_MS });
    },
    async search(sessionKey: string, query: string): Promise<BwCandidate[]> {
      if (!sessionKey) throw new BwError("Coffre Bitwarden verrouillé.");
      const q = query.trim();
      if (!q) throw new BwError("Recherche vide.");
      return parseBwItems(await run(["list", "items", "--search", q], { sessionKey }));
    },
    async resolve(sessionKey: string, itemId: string, field: BwField): Promise<string> {
      if (!sessionKey) throw new BwError("Coffre Bitwarden verrouillé.");
      if (!itemId.trim()) throw new BwError("Référence d'item Bitwarden vide.");
      if (!isBwField(field)) throw new BwError(`Champ invalide : ${JSON.stringify(field)}.`);
      // `bw get <champ> <id> --raw` : ne renvoie que la valeur demandée.
      const value = await run(["get", field, itemId.trim(), "--raw"], { sessionKey });
      return value.replace(/\n$/, "");
    },
    async configServer(serverUrl: string): Promise<void> {
      await run(["config", "server", normalizeServerUrl(serverUrl)]);
    },
    async login(email: string, password: string, code?: string): Promise<BwUnlocked> {
      const mail = String(email ?? "").trim();
      if (!EMAIL_RE.test(mail)) throw new BwError("Adresse e-mail invalide.");
      if (!password) throw new BwError("Mot de passe maître vide.");
      const otp = String(code ?? "").replace(/\s+/g, "");
      if (otp && !/^[A-Za-z0-9]{4,12}$/.test(otp)) throw new BwError("Code de connexion invalide.");
      // Le code est à usage unique et expire vite : il passe en argv (comme le ferait l'utilisateur),
      // le mot de passe, lui, reste dans l'environnement.
      const attempt = (method?: string) =>
        run(["login", mail, "--raw", ...(otp ? ["--code", otp] : []), ...(method ? ["--method", method] : [])], { password, timeoutMs: BW_LOGIN_TIMEOUT_MS });
      let out: string;
      try {
        out = await attempt();
      } catch (err) {
        const msg = scrubBwError(err);
        // Plusieurs méthodes en deux étapes sur le compte : le code saisi vient de l'application (méthode 0).
        if (otp && /no provider selected/i.test(msg)) out = await attempt("0");
        else if (NEEDS_CODE.test(msg)) {
          throw new BwNeedsCodeError(otp
            ? "Code refusé ou expiré : saisissez le code actuel de votre application d'authentification (ou celui reçu par e-mail)."
            : "Connexion en deux étapes : saisissez le code de votre application d'authentification (ou celui reçu par e-mail).");
        } else if (/incorrect|invalid.*password|username or password/i.test(msg)) {
          throw new BwError("E-mail ou mot de passe maître incorrect.");
        } else throw err;
      }
      const sessionKey = out.trim().split("\n").at(-1)?.trim() ?? "";
      if (!sessionKey || /\s/.test(sessionKey)) throw new BwError("Connexion impossible (réponse inattendue du CLI).");
      const st = parseBwStatus(await run(["status"], { sessionKey }));
      if (st.state === "unknown") st.state = "unlocked";
      return { status: st, sessionKey };
    },
    async logout(): Promise<void> {
      await run(["logout"]).catch((err) => {
        if (!/not logged in/i.test(err instanceof Error ? err.message : String(err))) throw err;
      });
    },
    async matchUrl(sessionKey: string, url: string): Promise<BwCandidate[]> {
      if (!sessionKey) throw new BwError("Coffre Bitwarden verrouillé.");
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        throw new BwError("Adresse de page invalide.");
      }
      if (!/^https?:$/.test(target.protocol)) return [];
      // Origine seule : le chemin et la requête de la page n'ont pas à sortir vers le CLI.
      return parseBwItems(await run(["list", "items", "--url", target.origin], { sessionKey }));
    },
  };
}
