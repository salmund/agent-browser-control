/**
 * Tests des surveillances (SG15, sans navigateur) : sondes, interprétation,
 * échéances, persistance. Lancer avec : node test/watch.ts
 */
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  condText,
  describeWatcher,
  loadWatches,
  parseProbeResult,
  probeCode,
  saveWatches,
  watchDue,
  type Watcher,
} from "../server/watch.ts";

// Sondes : JS valide, JSON {match, value}, condition injectée sans casser la syntaxe.
const textProbe = probeCode({ text: `l'océan "bleu"` });
assert.ok(textProbe.includes("innerText") && textProbe.includes("match"), "sonde texte");
assert.ok(textProbe.includes(JSON.stringify(`l'océan "bleu"`)), "texte échappé");
new Function(textProbe);
const selProbe = probeCode({ selector: "div.prix" });
assert.ok(selProbe.includes("querySelectorAll") && selProbe.includes("sélecteur invalide"), "sonde sélecteur");
new Function(selProbe);
assert.strictEqual(probeCode({ js: "location.href" }), "location.href", "js repris tel quel");

// Interprétation : sondes JSON, valeurs brutes, enveloppe page_content retirée.
assert.deepStrictEqual(parseProbeResult('{"match":true,"value":"vu : x"}', { text: "x" }), { match: true, value: "vu : x" });
assert.deepStrictEqual(parseProbeResult('{"match":false,"value":"..."}', { selector: "y" }), { match: false, value: "..." });
assert.deepStrictEqual(parseProbeResult("pas du json", { text: "x" }), { match: false, value: "pas du json" });
assert.deepStrictEqual(parseProbeResult("bonjour", { js: "1" }), { match: true, value: "bonjour" });
for (const f of ["", "false", "null", "undefined", "0"]) {
  assert.strictEqual(parseProbeResult(f, { js: "1" }).match, false, `falsy : ${JSON.stringify(f)}`);
}
const wrapped = '<page_content note="x">\n{"match":true,"value":"ok"}\n</page_content>';
assert.deepStrictEqual(parseProbeResult(wrapped, { text: "x" }), { match: true, value: "ok" }, "enveloppe retirée");

// Échéances.
const base: Watcher = {
  id: "w1", name: "n", agent: "a", tabId: 1, cond: { text: "x" }, intervalSec: 60,
  createdAt: 1_000, expiresAt: null, state: "armed", stateNote: "", lastCheckAt: null,
  nextCheckAt: 2_000, errors: 0, triggers: 0, lastValue: "",
};
assert.strictEqual(watchDue(base, 1_999), false, "pas due");
assert.strictEqual(watchDue(base, 2_000), true, "due");
assert.strictEqual(watchDue({ ...base, state: "paused" }, 9_999), false, "pause");
assert.strictEqual(watchDue({ ...base, expiresAt: 1_500 }, 9_999), false, "expirée");
assert.ok(describeWatcher({ ...base, state: "triggered", triggers: 2, lastValue: "vu" }).includes("DÉCLENCHÉE"), "description");
assert.strictEqual(condText({ selector: "a" }), 'sélecteur "a"');

// Persistance : roundtrip, fichier absent, JSON invalide.
const dir = mkdtempSync(join(tmpdir(), "abc-watch-"));
try {
  const file = join(dir, "w.json");
  assert.deepStrictEqual(loadWatches(file), [], "absent => vide");
  saveWatches([base], file);
  assert.strictEqual(loadWatches(file)[0].id, "w1", "roundtrip");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, "pas du json");
  assert.deepStrictEqual(loadWatches(file), [], "invalide => vide");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("watch : OK (sondes, interprétation, échéances, persistance)");
