/**
 * Tests unitaires du ménage (sans navigateur) : rotation du journal, purge des sorties.
 * Lancer avec : node test/housekeeping.ts
 */
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeOlderThan, rotateFile } from "../server/housekeeping.ts";

const dir = mkdtempSync(join(tmpdir(), "abc-menage-"));
try {
  // Rotation : sous le seuil, rien ne bouge.
  const small = join(dir, "petit.log");
  writeFileSync(small, "x".repeat(100));
  assert.strictEqual(rotateFile(small, 1024, 2), false);
  assert.ok(existsSync(small) && !existsSync(`${small}.1`));
  assert.strictEqual(rotateFile(join(dir, "absent.log"), 10, 2), false);

  // Rotation : au-delà du seuil, décalage des générations, la vieille saute.
  const big = join(dir, "gros.log");
  writeFileSync(join(dir, "gros.log.1"), "gen1");
  writeFileSync(join(dir, "gros.log.2"), "gen2");
  writeFileSync(big, "x".repeat(100));
  assert.strictEqual(rotateFile(big, 10, 2), true);
  assert.ok(!existsSync(big), "le courant est archivé");
  assert.strictEqual(readFileSync(join(dir, "gros.log.1"), "utf8"), "x".repeat(100));
  assert.strictEqual(readFileSync(join(dir, "gros.log.2"), "utf8"), "gen1");
  assert.ok(!existsSync(join(dir, "gros.log.3")), "pas de génération surnuméraire");

  // Purge : vieux fichiers supprimés, récents et dossiers gardés.
  const old = join(dir, "vieux.png");
  const fresh = join(dir, "recent.png");
  const sub = join(dir, "sous-dossier");
  writeFileSync(old, "vieux");
  writeFileSync(fresh, "recent");
  mkdirSync(sub);
  const hour = 3600_000;
  const now = Date.now();
  const { utimesSync } = await import("node:fs");
  utimesSync(old, new Date(now - 2 * hour), new Date(now - 2 * hour));
  const deleted = purgeOlderThan(dir, hour, now);
  assert.deepStrictEqual(deleted, ["vieux.png"]);
  assert.ok(!existsSync(old) && existsSync(fresh) && existsSync(sub));
  assert.deepStrictEqual(purgeOlderThan(join(dir, "absent"), hour, now), []);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("housekeeping : OK (rotation, purge)");
