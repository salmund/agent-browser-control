/**
 * Test de bout en bout sans navigateur : client MCP → shim → démon → fausse extension.
 * Lancer avec : node test/smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

const PORT = "7899";
const env = { ...process.env, ABC_PORT: PORT } as Record<string, string>;

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"], env }));

const { tools } = await client.listTools();
console.log("outils :", tools.map((t) => t.name).join(", "));

// Une page web (Origin http) doit être refusée.
const web = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { origin: "https://evil.example" } });
console.log("requête avec Origin web :", web.status);

const ext = new WebSocket(`ws://127.0.0.1:${PORT}/ext`, { origin: "chrome-extension://fake" });
ext.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (typeof msg.id !== "number") return;
  ext.send(JSON.stringify({ id: msg.id, result: { content: [{ type: "text", text: `echo ${msg.agent}/${msg.tool}` }] } }));
});
await new Promise((r) => ext.on("open", r));

const res = await client.callTool({ name: "tabs_context", arguments: {} });
console.log("réponse :", JSON.stringify(res.content));

ext.close();
await client.close();
