/**
 * Test end-to-end de la découverte passive des API (ST10) :
 * 1. page qui charge du JSON (fetch ×2, paginé) : read_page et get_page_text
 *    signalent l'appel en tête, avec « paginable » ;
 * 2. page sans JSON (example.com) : aucun hint (pas de bruit).
 *
 * Lancer avec : node test/e2e-api-hint.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/app") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><head><title>App JSON</title></head><body><div id=status>attente</div></body></html>");
  } else if (url.pathname === "/api/feed") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [1, 2, 3] }));
  } else {
    res.writeHead(404);
    res.end("nope");
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const client = new Client({ name: "e2e-api-hint-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de découverte passive ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const created: number[] = [];
try {
  console.log(`\n1. Serveur local sur 127.0.0.1:${port}, page + 2 fetch JSON...`);
  const createRes = await client.callTool({ name: "tabs_create", arguments: { url: `http://127.0.0.1:${port}/app` } });
  const tabId = Number(textOf(createRes).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);

  await client.callTool({
    name: "javascript",
    arguments: { tabId, code: `fetch("/api/feed?page=1").then(() => fetch("/api/feed?page=2")).then(() => "feeds-ok")` },
  });
  // Laisse le réseau se terminer (le hint lit les réponses reçues).
  await new Promise((r) => setTimeout(r, 1500));

  console.log("\n2. read_page signale l'appel...");
  const tree = textOf(await client.callTool({ name: "read_page", arguments: { tabId, filter: "interactive" } }));
  console.log(tree.split("\n").slice(0, 5).join("\n"));
  assert.ok(tree.includes("Données JSON détectées"), "hint présent");
  assert.ok(tree.includes("GET /api/feed?page"), "appel groupé avec param");
  assert.ok(tree.includes("paginable"), "pagination détectée");
  assert.ok(tree.includes("2 appel(s)"), "compte des appels");

  console.log("\n3. get_page_text aussi...");
  const text = textOf(await client.callTool({ name: "get_page_text", arguments: { tabId } }));
  assert.ok(text.includes("Données JSON détectées"), "hint présent");

  console.log("\n4. Page sans JSON : silence...");
  const plain = textOf(await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } }));
  const tab2 = Number(plain.match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tab2, "tabId 2 extrait");
  created.push(tab2);
  const tree2 = textOf(await client.callTool({ name: "read_page", arguments: { tabId: tab2, filter: "interactive" } }));
  assert.ok(!tree2.includes("Données JSON détectées"), "pas de hint sans JSON");

  console.log("\n✅ TOUS LES TESTS E2E DE DÉCOUVERTE PASSIVE ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
  server.close();
}
