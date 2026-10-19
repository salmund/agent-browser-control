/**
 * Test end-to-end du brief site_api : une note + une route enregistrées sur
 * example.com doivent apparaître EN TÊTE des réponses de navigate et de
 * tabs_create (routes d'abord, puis notes), pas noyées en fin de réponse.
 * Nettoie sa mémoire après lui (site_api delete).
 * Lancer avec : node test/e2e-site-brief.ts
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const NOTE = "BREF-TEST : naviguer direct, ne jamais cliquer au hasard.";
const ROUTE = "BREF-TEST-accueil";

const client = new Client({ name: "e2e-site-brief-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await client.callTool({ name, arguments: args });
  const c = res.content as { type: string; text?: string }[];
  return c.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

let tabId: number | null = null;
let tabId2: number | null = null;
try {
  await call("site_api", { action: "note", site: "example.com", text: NOTE });
  await call("site_api", { action: "save_route", site: "example.com", name: ROUTE, url: "https://example.com/" });

  // 1. navigate : brief en tête.
  const created = await call("tabs_create", {});
  tabId = Number((created.match(/tabId\s+(\d+)/) as RegExpMatchArray)[1]);
  const nav = await call("navigate", { tabId, url: "https://example.com/" });
  // Brief encadré comme une donnée non vérifiée (écrit par des agents).
  assert.ok(nav.startsWith("<site_memory ") && nav.includes("\nPlaybook example.com ("), "brief en tête de navigate : " + nav.slice(0, 200));
  assert.ok(nav.includes(NOTE), "note servie par navigate");
  assert.ok(nav.includes(ROUTE), "route servie par navigate");
  assert.ok(nav.indexOf(ROUTE) < nav.indexOf(NOTE), "routes avant notes");
  console.log("navigate : brief en tête OK.");

  // 2. tabs_create avec url : même brief (déclencheur ajouté).
  const created2 = await call("tabs_create", { url: "https://example.com/" });
  tabId2 = Number((created2.match(/tabId\s+(\d+)/) as RegExpMatchArray)[1]);
  assert.ok(created2.startsWith("<site_memory ") && created2.includes("\nPlaybook example.com ("), "brief en tête de tabs_create : " + created2.slice(0, 200));
  assert.ok(created2.includes(NOTE), "note servie par tabs_create");
  console.log("tabs_create : brief en tête OK.");

  console.log("\n✅ E2E BRIEF SITE OK");
} finally {
  await call("site_api", { action: "delete", site: "example.com", name: NOTE, kind: "note" }).catch(() => {});
  await call("site_api", { action: "delete", site: "example.com", name: ROUTE, kind: "route" }).catch(() => {});
  if (tabId !== null) await client.callTool({ name: "tabs_close", arguments: { tabId } }).catch(() => {});
  if (tabId2 !== null) await client.callTool({ name: "tabs_close", arguments: { tabId: tabId2 } }).catch(() => {});
  await client.close();
}
