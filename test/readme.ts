/**
 * Garde-fou des README : chaque outil de server/tools.ts est cité dans
 * README.md et README.en.md, et les compteurs valent le nombre d'outils.
 * Régénérer avec : npm run build-readme
 * Lancer avec : node test/readme.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { TOOLS } from "../server/tools.ts";

const fr = readFileSync("README.md", "utf8");
const en = readFileSync("README.en.md", "utf8");
for (const t of TOOLS) {
  assert.ok(fr.includes(`\`${t.name}\``), `README.md ne cite pas ${t.name}`);
  assert.ok(en.includes(`\`${t.name}\``), `README.en.md ne cite pas ${t.name}`);
}
assert.ok(fr.includes(`Les ${TOOLS.length} outils`), "compteur FR (nav)");
assert.ok(fr.includes(`dispose des ${TOOLS.length} outils`), "compteur FR (intro)");
assert.ok(en.includes(`The ${TOOLS.length} tools`), "compteur EN (nav)");
assert.ok(en.includes(`all ${TOOLS.length} tools`), "compteur EN (intro)");

console.log(`readme : OK (${TOOLS.length} outils cités dans les deux README)`);
