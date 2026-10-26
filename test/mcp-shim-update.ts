/**
 * Shim stdio face à un démon mis à jour pendant la session : un faux démon (HTTP) change de version et ajoute un
 * outil ; le vrai shim doit prévenir l'agent (notifications/tools/list_changed) et servir la nouvelle liste, sans
 * que l'agent relance sa session.
 * Lancer avec : node test/mcp-shim-update.ts
 */
import assert from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "../server/tools.ts";
import { sleep, testEnv, until } from "./harness.ts";

const t = await testEnv("shim-maj");
mkdirSync(t.configDir, { recursive: true });
writeFileSync(join(t.configDir, "token"), "jeton-essai");
const installee = (await import("../package.json", { with: { type: "json" } })).default.version as string;

const neuf: Tool = { name: "outil_neuf", description: "arrivé avec la mise à jour", inputSchema: { type: "object", properties: {} } };
let version = installee;
let outils: Tool[] = TOOLS;
const demon = createServer((req, res) => {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/health") return json(200, { ok: true, version, inflight: 0, skillsVersion: "s1", settings: {} });
  if (req.url === "/skills") return json(200, { version: "s1", descriptions: {}, tools: outils });
  json(404, { error: "not found" }); // /events, /shutdown : le shim s'en passe
});
await new Promise<void>((r) => demon.listen(t.port, "127.0.0.1", () => r()));

const client = new Client({ name: "essai-maj", version: "0" });
let changements = 0;
client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
  changements++;
});
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"], env: t.env }));
  assert.strictEqual((await client.listTools()).tools.length, TOOLS.length, "avant : la liste du démon");
  await sleep(3500); // premier relevé du shim : la référence
  assert.strictEqual(changements, 0, "rien de changé : pas de notification");

  // Mise à jour du démon : nouvelle version, un outil de plus.
  version = `${installee}-suivante`;
  outils = [...TOOLS, neuf];
  await until(() => changements > 0, 8000, "list_changed après la mise à jour du démon");
  const apres = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(apres.includes("outil_neuf"), "le nouvel outil est servi sans relancer la session");
  assert.strictEqual(apres.length, TOOLS.length + 1);
  console.log("mcp-shim-update : OK (démon mis à jour pendant la session : list_changed, nouvelle liste servie)");
} finally {
  await client.close().catch(() => {});
  demon.close();
  await sleep(200);
  t.cleanup();
}
