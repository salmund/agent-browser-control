/**
 * Client MCP en ligne de commande, pour tester l'extension réelle comme le ferait un agent.
 *   node test/call.ts <outil> '<json args>'
 * Les images renvoyées sont enregistrées dans test/out/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, rawArgs = "{}"] = process.argv.slice(2);
if (!tool) {
  console.error("Usage : node test/call.ts <outil> '<json args>'");
  process.exit(1);
}

const client = new Client({ name: "e2e-test", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

const res = await client.callTool({ name: tool, arguments: JSON.parse(rawArgs) });
mkdirSync("test/out", { recursive: true });
for (const item of res.content as { type: string; text?: string; data?: string; mimeType?: string }[]) {
  if (item.type === "text") console.log(item.text);
  else if (item.type === "image") {
    const file = `test/out/${tool}-${Date.now()}.${item.mimeType === "image/png" ? "png" : "jpg"}`;
    writeFileSync(file, Buffer.from(item.data!, "base64"));
    console.log(`[image enregistrée : ${file}]`);
  }
}
if (res.isError) console.log("(isError)");
await client.close();
