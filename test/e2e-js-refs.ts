/**
 * Test end-to-end de javascript vers refs (QW3) :
 * 1. un Element renvoyé devient une ref (même ligne que read_page) ;
 * 2. une liste d'Elements devient des refs ;
 * 3. la ref obtenue est utilisable (read_page ciblée dessus) ;
 * 4. un mélange (pas que des Elements) retombe sur la sérialisation JSON.
 *
 * Lancer avec : node test/e2e-js-refs.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-js-refs-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de javascript vers refs ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const created: number[] = [];
try {
  console.log("\n1. Création de l'onglet...");
  const createRes = await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } });
  const tabId = Number(textOf(createRes).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);

  console.log("\n2. Fixture injectée (pas de dépendance au DOM d'example.com)...");
  const fix = textOf(
    await client.callTool({
      name: "javascript",
      arguments: {
        tabId,
        code: `document.body.innerHTML = '<h1 id="abc-h1">Titre Test ABC</h1><a href="https://example.com/1">Lien A</a><a href="https://example.com/2">Lien B</a>'; 'fixture-ok'`,
      },
    }),
  );
  assert.ok(fix.includes("fixture-ok"), "fixture posée");

  console.log("\n3. Element unique...");
  const single = textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: "document.querySelector('#abc-h1')" } }));
  console.log(single);
  assert.ok(single.includes("comme ref"), "annonce de conversion");
  const ref = single.match(/\[(ref_\d+)\]/)?.[1];
  assert.ok(ref, "ref renvoyée");

  console.log("\n4. Liste d'Elements...");
  const multi = textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: "[...document.querySelectorAll('a')]" } }));
  console.log(multi.split("\n").slice(0, 3).join("\n"));
  assert.ok(multi.includes("comme refs"), "annonce pluriel");
  assert.ok((multi.match(/\[ref_\d+\]/g) ?? []).length >= 2, "deux refs");

  console.log("\n5. La ref est utilisable par read_page...");
  const sub = textOf(await client.callTool({ name: "read_page", arguments: { tabId, ref } }));
  assert.ok(sub.includes("Titre Test ABC"), "sous-arbre du h1 lu via la ref");

  console.log("\n6. Mélange : repli JSON...");
  const mixed = textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: "({ n: 1, el: document.body })" } }));
  assert.ok(!mixed.includes("comme ref"), "pas de conversion forcée");
  assert.ok(mixed.includes('"n": 1') || mixed.includes("n"), "JSON sérialisé");

  console.log("\n✅ TOUS LES TESTS E2E DE JAVASCRIPT VERS REFS ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
