/**
 * Met à jour Agent Browser Control : git pull, dépendances, arrêt propre du démon (POST /shutdown,
 * qui attend la fin des appels en cours) et démarrage du nouveau, recharge de l'extension, puis
 * vérification des versions (démon + extension, plus de couples désynchronisés).
 * Lancer avec : npm run update (depuis la racine du dépôt).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, getToken } from "../server/common.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const health = () =>
  fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.json() as Promise<{ version?: string; extensionConnected?: boolean; extensionVersion?: string; versionMismatch?: boolean }>)
    .catch(() => null);

if (!existsSync(join(ROOT, ".git"))) {
  console.error("Pas un dépôt git : mise à jour impossible (réinstaller depuis le dépôt).");
  process.exit(1);
}
console.log("=== git pull ===");
try {
  run("git", ["pull", "--ff-only"]);
} catch {
  console.error("git pull impossible (modifications locales ?) : commiter ou remiser avant de mettre à jour.");
  process.exit(1);
}

console.log("=== npm install ===");
try {
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"]);
} catch {
  console.error("npm install a échoué.");
  process.exit(1);
}

const token = getToken();

console.log("=== redémarrage du démon ===");
if (await health()) {
  const res = await fetch(`${BASE_URL}/shutdown`, { method: "POST", headers: { "x-abc-token": token } }).catch(() => null);
  if (!res || !res.ok) {
    console.error(
      `Arrêt du démon impossible (${res ? res.status : "injoignable"}) : démon trop ancien pour /shutdown ? ` +
        "Arrêter le processus « node server/daemon.ts » à la main, puis relancer npm run update.",
    );
    process.exit(1);
  }
  // Il attend jusqu'à 10 s la fin des appels en cours.
  for (let i = 0; i < 30 && (await health()); i++) await sleep(500);
  if (await health()) {
    console.error("Le démon ne s'est pas arrêté en 15 s.");
    process.exit(1);
  }
}
spawn(process.execPath, [join(ROOT, "server", "daemon.ts")], { detached: true, stdio: "ignore", windowsHide: true }).unref();
let started: Awaited<ReturnType<typeof health>> = null;
for (let i = 0; i < 50 && !started; i++) {
  await sleep(100);
  started = await health();
}
if (!started) {
  console.error("Le nouveau démon ne répond pas : le lancer à la main (npm run daemon) pour voir l'erreur.");
  process.exit(1);
}
console.log(`Démon ${started.version} démarré.`);

console.log("=== recharge de l'extension ===");
// L'extension se reconnecte seule au nouveau démon (délai de reconnexion jusqu'à 30 s).
for (let i = 0; i < 40 && !(await health())?.extensionConnected; i++) await sleep(1000);
const reload = await fetch(`${BASE_URL}/reload-extension`, { method: "POST", headers: { "x-abc-token": token } }).catch(() => null);
if (!reload || !reload.ok) {
  console.error(`Recharge impossible : ${reload ? `${reload.status} ${await reload.text()}` : "démon injoignable"} (navigateur fermé ?). Recharger l'extension à la main (chrome://extensions).`);
  process.exit(1);
}

console.log("=== versions ===");
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  const h = await health();
  if (h?.extensionConnected && h.extensionVersion) {
    console.log(`Démon ${h.version}, extension ${h.extensionVersion}.`);
    if (h.versionMismatch) {
      console.error("Désynchronisées : recharger l'extension (chrome://extensions) et relancer npm run update.");
      process.exit(1);
    }
    console.log("Mise à jour terminée, versions cohérentes.");
    process.exit(0);
  }
}
console.error("L'extension ne s'est pas reconnectée (navigateur fermé ?).");
process.exit(1);
