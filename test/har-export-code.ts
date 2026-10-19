/**
 * Tests de devtools har export-code (server/har.ts pickEntry + exportCodeText) :
 * sélection par requestId ou motif, sortie curl/Python, secrets masqués.
 * Lancer avec : node test/har-export-code.ts
 */
import assert from "node:assert";
import { exportCodeText, pickEntry, type HarEntry } from "../server/har.ts";

const entries: HarEntry[] = [
  { id: "1.1", t: 1, method: "GET", url: "https://site.example/page" },
  {
    id: "2.2", t: 2, method: "POST", url: "https://api.example/items?token=SECRET123&page=2", status: 200,
    requestHeaders: { "content-type": "application/json", authorization: "Bearer TOKENSECRET" },
    postData: JSON.stringify({ q: "recherche", api_key: "CLESECRETE" }),
  },
];

// Sélection.
assert.strictEqual(pickEntry(entries, { requestId: "1.1" })?.url, "https://site.example/page");
assert.strictEqual(pickEntry(entries, { requestId: "9.9" }), null);
assert.strictEqual(pickEntry(entries, { urlPattern: "api\\.example/items" })?.id, "2.2");
assert.strictEqual(pickEntry(entries, { urlPattern: "introuvable" }), null);
assert.strictEqual(pickEntry(entries, { urlPattern: "([" }), null, "regex invalide");
assert.strictEqual(pickEntry(entries, {}), null);

// Sorties.
const both = exportCodeText(entries[1]);
assert.ok(both.includes("--- curl ---") && both.includes("--- python ---"), "les deux formats par défaut");
assert.ok(exportCodeText(entries[1], "curl").startsWith("POST ") && exportCodeText(entries[1], "curl").includes("curl -X POST"), "curl seul");
assert.ok(exportCodeText(entries[1], "python").includes("requests.post("), "python seul");

// Secrets masqués partout (URL, en-têtes, corps), jamais en clair.
for (const out of [both, exportCodeText(entries[1], "curl"), exportCodeText(entries[1], "python")]) {
  assert.ok(!out.includes("SECRET123") && !out.includes("TOKENSECRET") && !out.includes("CLESECRETE"), "aucun secret en clair");
  assert.ok(out.includes("masqué"), "masquage visible");
}
assert.ok(both.includes("page=2"), "paramètre non sensible conservé");
assert.ok(both.includes("recherche"), "corps non sensible conservé");

console.log("har export-code : OK");
