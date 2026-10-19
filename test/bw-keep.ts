/**
 * Session Bitwarden gardée entre deux démarrages : aller-retour chiffré (DPAPI sous Windows),
 * rien d'écrit si le réglage est inactif, tout effacé quand on le désactive.
 * Lancer avec : node test/bw-keep.ts
 */
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBwKeep } from "../server/bw-keep.ts";

const dir = mkdtempSync(join(tmpdir(), "abc-bwkeep-"));
try {
  const keep = createBwKeep(dir);
  const key = "Zm9vYmFyX2Zha2Vfc2Vzc2lvbl9rZXk=";
  await keep.store(key);
  assert.ok(!existsSync(join(dir, "bitwarden-session")), "réglage inactif : rien sur disque");
  assert.strictEqual(await keep.load(), null);

  keep.setEnabled(true);
  await keep.store(key);
  const raw = readFileSync(join(dir, "bitwarden-session"), "utf8");
  if (process.platform === "win32") assert.ok(!raw.includes(key), "clé chiffrée sur disque (DPAPI)");
  assert.strictEqual(await createBwKeep(dir).load(), key, "relue par un nouveau démon");

  await keep.store(null);
  assert.strictEqual(await keep.load(), null, "verrouiller efface la session gardée");
  await keep.store(key);
  keep.setEnabled(false);
  assert.ok(!existsSync(join(dir, "bitwarden-session")), "désactiver efface la session gardée");
  console.log("bw-keep : OK (chiffrement, relecture, verrouillage, désactivation)");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
