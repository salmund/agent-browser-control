/**
 * Test end-to-end de devtools unifié (QW5) : les 12 actions via action/op, plus
 * la compatibilité des anciens noms directs (read_console_messages, http_request).
 * resize est exclu (redimensionnerait la fenêtre de l'utilisateur).
 *
 * Lancer avec : node test/e2e-devtools.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-devtools-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de devtools ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const dt = async (tabId: number, action: string, extra: Record<string, unknown> = {}) =>
  textOf(await client.callTool({ name: "devtools", arguments: { tabId, action, ...extra } }));

const created: number[] = [];
try {
  console.log("\n1. Création de l'onglet...");
  const createRes = await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } });
  const tabId = Number(textOf(createRes).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);

  console.log("\n2. console...");
  await client.callTool({ name: "javascript", arguments: { tabId, code: `console.log("MARQUEUR-CONSOLE-ABC"); "log-ok"` } });
  const logs = await dt(tabId, "console", { pattern: "MARQUEUR" });
  assert.ok(logs.includes("MARQUEUR-CONSOLE-ABC"), "log retrouvé");

  console.log("\n3. network + body...");
  const net = await dt(tabId, "network", { urlPattern: "example\\.com" });
  assert.ok(net.includes("example.com"), "requêtes listées");
  const reqId = net.match(/^(\S+)\s+(GET|POST|HEAD)/m)?.[1];
  assert.ok(reqId, "requestId extrait");
  const body = await dt(tabId, "body", { requestId: reqId });
  assert.ok(body.includes("Example Domain"), "corps du document lu");

  console.log("\n4. intercept (add/list/clear)...");
  const added = await dt(tabId, "intercept", { op: "add", urlPattern: "*/jamais-charge-abc/*", effect: "block" });
  assert.ok(added.includes("rule_"), "règle créée");
  const rules = await dt(tabId, "intercept", { op: "list" });
  assert.ok(rules.includes("jamais-charge-abc"), "règle listée");
  await dt(tabId, "intercept", { op: "clear" });
  const cleared = await dt(tabId, "intercept", { op: "list" });
  assert.ok(!cleared.includes("jamais-charge-abc"), "règles purgées");

  console.log("\n5. storage (localStorage set/get/delete)...");
  await dt(tabId, "storage", { op: "set", type: "localStorage", name: "abc-cle-test", value: "abc-valeur-test" });
  const stored = await dt(tabId, "storage", { op: "get", type: "localStorage", name: "abc-cle-test" });
  assert.ok(stored.includes("abc-valeur-test"), "valeur relue");
  await dt(tabId, "storage", { op: "delete", type: "localStorage", name: "abc-cle-test" });

  console.log("\n6. perf...");
  const perf = await dt(tabId, "perf");
  assert.ok(/LCP|FCP|TTFB/.test(perf), "Web Vitals mesurés");

  console.log("\n7. emulate (thème + reset)...");
  await dt(tabId, "emulate", { colorScheme: "dark" });
  await dt(tabId, "emulate", { reset: true });

  console.log("\n7b. emulate (appareil) : le clic arrive au point demandé, même après une capture...");
  // Régression : sous émulation ×3 sur un écran à 125 %, après une capture, (285, 35) arrivait en (118, 14)
  // et la capture suivante sortait en mosaïque.
  const js = async (code: string) =>
    textOf(await client.callTool({ name: "javascript", arguments: { tabId, code } })).replace(/<\/?page_content[^>]*>/g, "").trim();
  try {
    for (const device of ["iphone-15", "pixel-8"]) {
      await dt(tabId, "emulate", { device });
      await js(`window.__clics = []; addEventListener("click", (e) => { e.preventDefault(); window.__clics.push([e.clientX, e.clientY]); }, true); "pret"`);
      textOf(await client.callTool({ name: "computer", arguments: { tabId, action: "screenshot", scale: 0.4 } }));
      for (const [x, y] of [[300, 40], [60, 500]]) {
        await client.callTool({ name: "computer", arguments: { tabId, action: "left_click", coordinate: [x, y] } });
        const [cx, cy] = JSON.parse(await js("JSON.stringify(window.__clics.at(-1) ?? null)")) ?? [NaN, NaN];
        assert.ok(Math.abs(cx - x) <= 2 && Math.abs(cy - y) <= 2, `${device} : clic demandé en (${x}, ${y}), reçu en (${cx}, ${cy})`);
      }
    }
  } finally {
    await dt(tabId, "emulate", { reset: true });
  }
  await js(`window.__clics = []; "pret"`);
  await client.callTool({ name: "computer", arguments: { tabId, action: "left_click", coordinate: [120, 80] } });
  const apres = JSON.parse(await js("JSON.stringify(window.__clics.at(-1) ?? null)")) ?? [NaN, NaN];
  assert.ok(Math.abs(apres[0] - 120) <= 2 && Math.abs(apres[1] - 80) <= 2, `après reset : clic reçu en (${apres})`);

  console.log("\n8. pdf...");
  const pdf = await dt(tabId, "pdf", { filename: "e2e-devtools-test" });
  assert.ok(pdf.includes(".pdf"), "PDF exporté");

  console.log("\n9. websocket (aucun socket : pas d'erreur)...");
  await dt(tabId, "websocket");

  console.log("\n10. http (sans tabId)...");
  const http = textOf(await client.callTool({ name: "devtools", arguments: { action: "http", url: "https://example.com" } }));
  assert.ok(http.includes("200"), "GET 200");

  console.log("\n11. har (status + list)...");
  const status = await dt(tabId, "har", { op: "status" });
  assert.ok(/requête/i.test(status), "statut HAR");
  const harList = await dt(tabId, "har", { op: "list", urlPattern: "example\\.com", limit: 5 });
  assert.ok(harList.includes("example.com"), "HAR persistant alimenté");

  console.log("\n12. Compatibilité des anciens noms...");
  const legacyConsole = textOf(await client.callTool({ name: "read_console_messages", arguments: { tabId, pattern: "MARQUEUR", limit: 5 } }));
  assert.ok(legacyConsole.includes("MARQUEUR-CONSOLE-ABC"), "ancien nom console accepté");
  const legacyHttp = textOf(await client.callTool({ name: "http_request", arguments: { url: "https://example.com" } }));
  assert.ok(legacyHttp.includes("200"), "ancien nom http accepté");

  console.log("\n✅ TOUS LES TESTS E2E DE DEVTOOLS ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
