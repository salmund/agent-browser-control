/**
 * Test end-to-end de replay_paginated (P7) :
 * 1. Serveur local avec API paginée (3 pages × 10 items, curseur ?page=).
 * 2. L'appel graine est capturé dans le trafic de l'onglet.
 * 3. replay_paginated suit le curseur et fusionne les 30 items, sans scroller.
 * 4. Motif sans match : erreur claire avec piste (recharger / refaire l'action).
 *
 * Lancer avec : node test/e2e-replay.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PAGE_SIZE = 10;
const PAGE_COUNT = 3;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/app") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><head><title>App paginée</title></head><body><div id=status>attente</div></body></html>");
  } else if (url.pathname === "/api/items") {
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const items = Array.from({ length: PAGE_SIZE }, (_, i) => `item ${(page - 1) * PAGE_SIZE + i + 1}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items, next: page < PAGE_COUNT ? page + 1 : null }));
  } else {
    res.writeHead(404);
    res.end("nope");
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const client = new Client({ name: "e2e-replay-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de replay_paginated ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const created: number[] = [];
try {
  console.log(`\n1. Serveur local sur 127.0.0.1:${port}, création de l'onglet...`);
  const createRes = await client.callTool({ name: "tabs_create", arguments: { url: `http://127.0.0.1:${port}/app` } });
  const tabId = Number(textOf(createRes).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);

  console.log("\n2. Appel graine depuis la page (après attachement, donc capturé)...");
  // javascript attache le debugger AVANT d'évaluer : le fetch qui suit est forcément capturé.
  await client.callTool({
    name: "javascript",
    arguments: {
      tabId,
      code: `fetch("/api/items?page=1").then((r) => r.json()).then((j) => { document.querySelector("#status").textContent = "SEED:" + j.items.length; })`,
    },
  });
  const seeded = textOf(await client.callTool({ name: "wait_for", arguments: { tabId, text: "SEED:10", timeout: 15 } }));
  assert.ok(seeded.includes("Condition remplie"), "graine chargée");
  const net = textOf(await client.callTool({ name: "devtools", arguments: { tabId, action: "network", urlPattern: "api/items" } }));
  assert.ok(net.includes("/api/items?page=1"), "appel graine capturé dans le trafic");

  console.log("\n3. Replay de la pagination (3 pages, 30 items)...");
  const replay = textOf(await client.callTool({
    name: "replay_paginated",
    arguments: {
      tabId,
      urlPattern: "api/items",
      cursor: { in: "query:page", out: "json:next" },
      itemsPath: "json:items",
      maxPages: 5,
    },
  }));
  console.log(replay.split("\n").slice(0, 3).join("\n") + "\n...");
  assert.ok(replay.includes("3 page(s)"), "3 pages rejouées");
  assert.ok(replay.includes("30 item(s)"), "30 items fusionnés");
  assert.ok(replay.includes("curseur épuisé"), "fin naturelle (curseur null)");
  assert.ok(replay.includes("- item 1") && replay.includes("- item 30"), "premier et dernier items");

  console.log("\n4. Motif sans match : erreur claire...");
  const miss = await client.callTool({
    name: "replay_paginated",
    arguments: { tabId, urlPattern: "api/inexistante", cursor: { in: "query:page", out: "json:next" }, itemsPath: "json:items" },
  }) as unknown as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(miss.isError, true, "erreur remontée");
  const missText = miss.content.map((b) => b.text ?? "").join("\n");
  console.log(missText.split("\n").slice(0, 2).join("\n"));
  assert.ok(missText.includes("Aucun appel capturé"), "diagnostic clair");

  console.log("\n5. export-code : l'appel graine rejouable en curl/Python...");
  const code = textOf(await client.callTool({
    name: "devtools",
    arguments: { tabId, action: "har", op: "export-code", urlPattern: "api/items", format: "both" },
  }));
  console.log(code.split("\n").slice(0, 4).join("\n") + "\n...");
  assert.ok(code.includes("curl -X GET"), "export curl");
  assert.ok(code.includes("requests.get("), "export python");
  assert.ok(code.includes("/api/items"), "URL de l'appel graine");

  console.log("\n✅ TOUS LES TESTS E2E DE REPLAY_PAGINATED ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
  server.close();
}
