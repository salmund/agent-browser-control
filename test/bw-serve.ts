/**
 * Tests du `bw serve` persistant (server/bw-serve.ts), avec un faux serveur (test/bw-serve-fake.ts) :
 * démarrage lié à la session, réponses expurgées, erreurs du coffre, repli (undefined) quand le serveur fait
 * défaut puis relance, arrêt, dossier du socket privé. Hermétique : aucun CLI Bitwarden requis.
 * Lancer avec : node test/bw-serve.ts
 */
import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { BwError } from "../server/bitwarden.ts";
import { createBwServe, type BwServe } from "../server/bw-serve.ts";

const fake = join(import.meta.dirname, "bw-serve-fake.ts");
const configDir = mkdtempSync(join(tmpdir(), "abc-bw-serve-test-"));
const logs: Record<string, unknown>[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(extra: { enabled?: boolean } = {}): BwServe {
  return createBwServe({
    bwPath: async () => null, // jamais appelé : `command` le remplace
    configDir,
    log: (e) => logs.push(e),
    command: { exe: process.execPath, args: [fake] },
    retryMs: [300, 300],
    ...extra,
  });
}

async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(50);
  assert.ok(cond(), "condition non atteinte à temps");
}

const serve = make();
try {
  // Sans session : rien ne tourne, tout passe par le CLI.
  assert.strictEqual(await serve.matchUrl("https://discord.com/login"), undefined);
  assert.strictEqual(serve.info().running, false);

  // Session valide : le serveur démarre, la première requête attend qu'il soit prêt.
  serve.setSession("cle-ok");
  const st = await serve.status();
  assert.strictEqual(st?.state, "unlocked");
  assert.ok(serve.info().ready);
  assert.ok(logs.some((e) => e.event === "bw-serve" && e.ok === true), "démarrage journalisé");

  // Correspondance par origine (chemin et requête retirés), candidats expurgés.
  const items = await serve.matchUrl("https://discord.com/login?next=/channels");
  assert.deepStrictEqual(items, [{ id: "it-1", name: "discord.com", username: "louis", uris: ["https://discord.com"] }]);
  assert.ok(!JSON.stringify(items).includes("mdp-faux-secret-9") && !JSON.stringify(items).includes("confidentielle"));
  assert.deepStrictEqual(await serve.matchUrl("chrome://extensions"), []);
  assert.deepStrictEqual((await serve.search("autre"))?.map((i) => i.id), ["it-2"]);

  // Valeurs et erreurs du coffre.
  assert.strictEqual(await serve.resolve("it-1", "password"), "mdp-faux-secret-9");
  assert.strictEqual(await serve.resolve("it-1", "username"), "louis");
  await assert.rejects(serve.resolve("inconnu", "password"), (e: unknown) => e instanceof BwError && /Not found/.test(String((e as Error).message)));
  await assert.rejects(serve.resolve("it-1", "notes" as never), BwError);
  assert.strictEqual(await serve.sync(), true);

  // Aucun secret dans le journal.
  assert.ok(!JSON.stringify(logs).includes("mdp-faux-secret-9") && !JSON.stringify(logs).includes("cle-ok"));

  // Dossier du socket privé (POSIX).
  if (platform() !== "win32") {
    const mode = statSync(join(configDir, "bw-serve")).mode & 0o777;
    assert.strictEqual(mode, 0o700, `dossier du socket en ${mode.toString(8)}`);
  }

  // Panne : le serveur meurt, l'appel suivant passe par le CLI (undefined), puis il est relancé.
  const pid = serve.info().pid!;
  process.kill(pid);
  await until(() => !serve.info().running);
  assert.strictEqual(await serve.resolve("it-1", "password"), undefined, "repli sur le CLI pendant la relance");
  await until(() => serve.info().ready);
  assert.notStrictEqual(serve.info().pid, pid);
  assert.strictEqual(await serve.resolve("it-1", "password"), "mdp-faux-secret-9");

  // Session refusée par le serveur : pas de serveur, repli sur le CLI.
  serve.setSession("cle-perimee");
  assert.strictEqual(await serve.status(), undefined);
  assert.ok(logs.some((e) => e.event === "bw-serve" && e.ok === false && String(e.reason).includes("session refusée")));

  // Nouvelle session valide, puis verrouillage : arrêt et socket supprimé.
  serve.setSession("cle-ok");
  assert.strictEqual((await serve.status())?.state, "unlocked");
  serve.setSession(null);
  assert.strictEqual(serve.info().running, false);
  if (platform() !== "win32") assert.ok(!existsSync(join(configDir, "bw-serve", "bw.sock")), "socket supprimé");
  assert.strictEqual(await serve.status(), undefined);

  // Désactivé (ABC_BW_SERVE=0) : jamais lancé.
  const off = make({ enabled: false });
  off.setSession("cle-ok");
  assert.strictEqual(await off.status(), undefined);
  assert.strictEqual(off.info().running, false);
  off.stop();

  console.log("bw serve : ok");
} finally {
  serve.stop();
  await sleep(200);
  rmSync(configDir, { recursive: true, force: true });
}
