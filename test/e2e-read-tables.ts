/**
 * Test end-to-end de read_tables (QW7) :
 * 1. tableau avec en-tête + colspan/rowspan : Markdown exact ;
 * 2. variante CSV ;
 * 3. sélecteur ciblé + tableau sans match.
 *
 * Lancer avec : node test/e2e-read-tables.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-read-tables-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de read_tables ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const created: number[] = [];
try {
  console.log("\n1. Création de l'onglet + fixture...");
  const createRes = await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } });
  const tabId = Number(textOf(createRes).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);

  await client.callTool({
    name: "javascript",
    arguments: {
      tabId,
      code: `(() => {
        document.body.innerHTML =
          '<table id="prix"><caption>Tarifs</caption>' +
          "<tr><th>Produit</th><th>Prix</th></tr>" +
          "<tr><td rowspan='2'>Pommes</td><td>1,20</td></tr>" +
          "<tr><td>1,00 (promo)</td></tr>" +
          "<tr><td colspan='2'>Total : 2,20</td></tr></table>" +
          '<table id="simple"><tr><td>a</td><td>b</td></tr></table>';
        return "fixture-ok";
      })()`,
    },
  });

  console.log("\n2. Markdown (colspan/rowspan, légende)...");
  const md = textOf(await client.callTool({ name: "read_tables", arguments: { tabId, selector: "#prix" } }));
  console.log(md);
  assert.ok(md.includes("Tarifs"), "légende reprise");
  assert.ok(md.includes("| Produit | Prix |"), "en-tête");
  assert.ok(md.includes("| --- | --- |"), "séparateur");
  assert.ok(md.includes("| Pommes | 1,00 (promo) |"), "rowspan descendu");
  assert.ok(md.includes("| Total : 2,20 | Total : 2,20 |"), "colspan répété");

  console.log("\n3. CSV...");
  const csv = textOf(await client.callTool({ name: "read_tables", arguments: { tabId, selector: "#simple", format: "csv" } }));
  console.log(csv);
  assert.ok(csv.includes("a,b"), "ligne CSV");

  console.log("\n4. Compte global + sans match...");
  const all = textOf(await client.callTool({ name: "read_tables", arguments: { tabId } }));
  assert.ok(all.includes("2 tableau(x) sur 2"), "deux tableaux trouvés");
  const none = textOf(await client.callTool({ name: "read_tables", arguments: { tabId, selector: "#inexistant" } }));
  assert.ok(none.includes("Aucun tableau"), "message net sans match");

  console.log("\n✅ TOUS LES TESTS E2E DE READ_TABLES ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
