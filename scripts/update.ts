/**
 * Met à jour Agent Browser Control sur cet appareil, de la même façon partout (docs/mise-a-jour.md) :
 * calme, instantané des réglages, avance sur la branche, puis le NOUVEAU code prend la suite (dépendances,
 * migrations, démon, extension, vérifications, intégrations) ; en cas d'échec, retour à la version précédente.
 * Ce qui est propre à l'appareil (démon sous systemd, navigateur à relancer, services à attendre,
 * notification) est dans ~/.agent-browser-control/appareil.json.
 *
 * Lancer avec : npm run update [-- --maintenant | --auto | --force]
 *   --maintenant  n'attendre que la fin des appels en cours (pas 90 s de calme)
 *   --auto        lancé par un minuteur : un appareil occupé n'est pas une erreur, on repassera
 *   --force       même déjà à jour, ou si cette version a déjà échoué ici
 * Interne : --etape-b <avant> <cible>, lancé par l'étape A depuis le code tout juste récupéré.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, CONFIG_DIR, disabledToolNames, getToken } from "../server/common.ts";
import { etapeA, etapeB, lireProfil, type Sante } from "../server/maj.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(msg);
const WIN = process.platform === "win32";

if (!existsSync(join(ROOT, ".git"))) {
  console.error("Pas un dépôt git : mise à jour impossible (réinstaller depuis le dépôt).");
  process.exit(1);
}
const { profil, erreurs } = lireProfil(CONFIG_DIR);
for (const e of erreurs) console.error(e);

const git = (a: string[]) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// Sous Windows, seul un .cmd ou un .bat (npm.cmd, par exemple) passe par cmd.exe, qui recolle les arguments tels
// quels : ils sont donc mis entre guillemets. Tout le reste est lancé directement, arguments intacts.
const parCmd = (c: string) => WIN && /\.(cmd|bat)$/i.test(c);
const commande = (cmd: string[]) => {
  if (!parCmd(cmd[0])) return { fichier: cmd[0], args: cmd.slice(1), shell: false };
  const guillemets = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  // La ligne entière, déjà assemblée : Node déconseille de passer des arguments avec shell (DEP0190).
  return { fichier: cmd.map(guillemets).join(" "), args: [] as string[], shell: true };
};
const lancer = (cmd: string[]) => {
  const c = commande(cmd);
  execFileSync(c.fichier, c.args, { cwd: ROOT, stdio: "inherit", shell: c.shell, windowsHide: true });
};
const npmCi = () => lancer([WIN ? "npm.cmd" : "npm", "ci", "--no-audit", "--no-fund"]);

const sante = (): Promise<Sante | null> =>
  fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.json() as Promise<Sante>)
    .catch(() => null);
const lireJson = (url: string) => fetch(url, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
const jeton = () => getToken();

async function arreterDemon(): Promise<void> {
  if (profil.demon) return void lancer(profil.demon.arreter);
  if (!(await sante())) return;
  const res = await fetch(`${BASE_URL}/shutdown`, { method: "POST", headers: { "x-abc-token": jeton() } }).catch(() => null);
  if (!res?.ok) throw new Error(`arrêt du démon refusé (${res ? res.status : "injoignable"}) : l'arrêter à la main (processus « node server/daemon.ts »)`);
  // Il attend jusqu'à 10 s la fin des appels en cours.
  for (let i = 0; i < 30 && (await sante()); i++) await sleep(500);
  if (await sante()) throw new Error("le démon ne s'est pas arrêté en 15 s");
}

function demarrerDemon(): void {
  if (profil.demon) return void lancer(profil.demon.demarrer);
  spawn(process.execPath, [join(ROOT, "server", "daemon.ts")], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true }).unref();
}

const pret = (h: Sante | null) => !!h?.extensionConnected && h.versionMismatch === false && h.extensionStale !== true && h.extensionVersion === h.version;

/**
 * Démon relancé sur le code du disque, extension rechargée (sauf extension: false, code inchangé) et vérifiée ;
 * null si tout est revenu, sinon la raison.
 */
async function relancer({ extension = true } = {}): Promise<string | null> {
  try {
    await arreterDemon();
    demarrerDemon();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  let h: Sante | null = null;
  for (let i = 0; i < 60 && !(h = await sante()); i++) await sleep(250);
  if (!h) return "le démon ne répond pas après son démarrage (le lancer à la main : npm run daemon, pour voir l'erreur)";
  for (let i = 0; i < 40 && !(await sante())?.extensionConnected; i++) await sleep(1000);
  // git ne dit que ce qui change entre deux commits : une extension restée en retard (relance forcée, appareil
  // rattrapé à la main) se recharge aussi.
  const enService = await sante();
  const versionDuDepot = JSON.parse(readFileSync(join(ROOT, "extension", "manifest.json"), "utf8")).version;
  if (!extension && enService?.extensionConnected && (enService.extensionVersion !== versionDuDepot || enService.extensionStale)) {
    log(`L'extension en service (${enService.extensionVersion}) n'est pas celle du dépôt (${versionDuDepot}) : elle sera rechargée.`);
    extension = true;
  }
  const recharger = async () => {
    await fetch(`${BASE_URL}/reload-extension`, { method: "POST", headers: { "x-abc-token": jeton() } }).catch(() => null);
    for (let i = 0; i < 10 && (await sante())?.extensionConnected; i++) await sleep(1000); // elle se débranche le temps de se recharger
  };
  // Un navigateur relancé seul garde en cache le code du service worker tant que la version de l'extension ne change
  // pas : le rechargement relit le code sur le disque (sur Chromium en snap, il coupe aussi l'extension), la relance
  // du navigateur la rebranche (vérifié sur un banc, 26/10/2026).
  const rechargerPuisRelancer = async (pourquoi: string) => {
    log(`${pourquoi} : rechargement de l'extension, puis relance du navigateur (profil de l'appareil).`);
    await recharger();
    try {
      lancer(profil.navigateur!);
    } catch {}
  };
  if (extension && profil.extensionParNavigateur && profil.navigateur) await rechargerPuisRelancer("Extension changée");
  else if (extension) await recharger();
  for (let essai = 0; essai < 2; essai++) {
    for (let i = 0; i < 45; i++) {
      h = await sante();
      if (pret(h)) return null;
      await sleep(2000);
    }
    if (essai || !profil.navigateur) break;
    await rechargerPuisRelancer(h?.extensionStale ? "Code de l'extension resté en cache" : "L'extension ne revient pas");
  }
  if (!h?.extensionConnected) return "l'extension ne s'est pas reconnectée (navigateur fermé ?)";
  if (h.extensionStale) {
    return "le navigateur exécute encore l'ancien code de l'extension (le recharger, puis relancer le navigateur ; ou monter la version de l'extension, que le navigateur relit toujours)";
  }
  return `versions désynchronisées : démon ${h.version}, extension ${h.extensionVersion}`;
}

/** Noms des outils servis par le démon (MCP HTTP, comme un vrai client). */
async function outilsMcp(): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/mcp?agent=mise-a-jour`, {
    method: "POST",
    headers: { authorization: `Bearer ${jeton()}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    signal: AbortSignal.timeout(10_000),
  });
  const texte = await res.text();
  const json = texte.trim().startsWith("{") ? texte : /^data: (.+)$/m.exec(texte)?.[1] ?? "{}";
  return (JSON.parse(json).result?.tools ?? []).map((t: { name: string }) => t.name);
}

async function outilsAttendus(): Promise<string[]> {
  const { TOOLS } = await import("../server/tools.ts");
  const coupes = new Set(disabledToolNames(((await sante()) as { settings?: { scriptsEnabled?: unknown } } | null)?.settings));
  return TOOLS.map((t: { name: string }) => t.name).filter((n: string) => !coupes.has(n));
}

function notifier(titre: string, message: string, priorite: number): void {
  if (!profil.notifier) return;
  const c = commande([...profil.notifier, titre, message, String(priorite)]);
  spawnSync(c.fichier, c.args, { cwd: ROOT, stdio: "ignore", timeout: 15_000, shell: c.shell, windowsHide: true });
}

// Contrat entre les deux étapes, à garder d'une version à l'autre : « node scripts/update.ts --etape-b <avant> <cible> »,
// code 0 si la nouvelle version est en place, sinon la raison dans ce fichier.
const RAISON_B = join(CONFIG_DIR, "maj", "raison-etape-b.txt");

// Fin par process.exitCode, pas process.exit() : sous Windows, Node s'arrête sur une assertion de libuv
// (« !(handle->flags & UV_HANDLE_CLOSING) ») quand process.exit() tombe pendant la fermeture des connexions de fetch,
// et le code de sortie ment alors (constaté le 26/10/2026 après une mise à jour réussie).
if (args[0] === "--etape-b") {
  try {
    await etapeB({ git, npmCi, arreterDemon, relancer, sante, outilsMcp, outilsAttendus, log }, { depot: ROOT, configDir: CONFIG_DIR, profil, avant: args[1], cible: args[2] });
    process.exitCode = 0;
  } catch (err) {
    const raison = err instanceof Error ? err.message : String(err);
    console.error(`Nouvelle version : ${raison}`);
    mkdirSync(join(CONFIG_DIR, "maj"), { recursive: true });
    writeFileSync(RAISON_B, raison);
    process.exitCode = 1;
  }
} else {
  const r = await etapeA(
    { git, npmCi, sante, lireJson, attendre: sleep, etapeB: etapeBNeuve, arreterDemon, relancer, notifier, log },
    { depot: ROOT, configDir: CONFIG_DIR, profil, force: args.includes("--force"), auto: args.includes("--auto"), maintenant: args.includes("--maintenant") },
  );
  process.exitCode = r.code;
}

// Étape B : le script tout juste récupéré, relancé depuis le disque (il sait migrer depuis l'ancienne version).
function etapeBNeuve(avant: string, cible: string): Promise<string | null> {
  return new Promise<string | null>((ok) => {
    rmSync(RAISON_B, { force: true });
    const p = spawn(process.execPath, [join(ROOT, "scripts", "update.ts"), "--etape-b", avant, cible], { cwd: ROOT, stdio: "inherit" });
    const raison = (code: number | null) => {
      try {
        return readFileSync(RAISON_B, "utf8").trim();
      } catch {
        return `la nouvelle version s'est arrêtée (code ${code})`;
      }
    };
    p.on("exit", (code) => ok(code === 0 ? null : raison(code)));
    p.on("error", (err) => ok(`la nouvelle version n'a pas pu être lancée : ${err.message}`));
  });
}
