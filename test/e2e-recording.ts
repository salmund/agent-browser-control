/**
 * Test end-to-end de l'enregistrement GIF : start -> actions -> stop -> export.
 * Couvre le chemin recordFrame (pauses de stabilisation conservées pendant
 * l'enregistrement) et vérifie que le fichier produit existe et n'est pas vide.
 * Lancer avec : node test/e2e-recording.ts
 */
import assert from "node:assert";
import { statSync, unlinkSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-recording-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

let tabId: number | null = null;
let gifPath: string | null = null;
try {
  const createRes = await client.callTool({
    name: "tabs_create",
    arguments: { url: "https://example.com", snapshot: true },
  });
  const createText = (createRes.content as { type: string; text: string }[])[0].text;
  tabId = Number((createText.match(/tabId\s+(\d+)/) as RegExpMatchArray)[1]);
  const ref = (createText.match(/\[(ref_\d+)\]/) as RegExpMatchArray)[1];
  console.log(`Onglet ${tabId}, ref ${ref}`);

  await client.callTool({ name: "gif_creator", arguments: { tabId, action: "start_recording" } });
  console.log("Enregistrement démarré.");
  await client.callTool({ name: "computer", arguments: { tabId, action: "hover", ref } });
  await client.callTool({ name: "computer", arguments: { tabId, action: "scroll", scroll_direction: "down", scroll_amount: 2 } });
  const stopRes = await client.callTool({ name: "gif_creator", arguments: { tabId, action: "stop_recording" } });
  const stopText = (stopRes.content as { type: string; text: string }[])[0].text;
  console.log("Arrêt : " + stopText.slice(0, 120));
  const n = Number((stopText.match(/(\d+) image\(s\)/) as RegExpMatchArray)[1]);
  assert.ok(n >= 3, `Au moins 3 images (début + actions + fin), reçu ${n}`);

  const expRes = await client.callTool({
    name: "gif_creator",
    arguments: { tabId, action: "export", format: "gif", quality: "standard", filename: "e2e-recording-test" },
  });
  const expText = (expRes.content as { type: string; text: string }[])[0].text;
  const m = expText.match(/([A-Z]:\\[^\n"']*?\.gif)/);
  assert.ok(m, "Chemin du GIF dans la réponse : " + expText.slice(0, 200));
  gifPath = m[1];
  const size = statSync(gifPath).size;
  assert.ok(size > 1000, `GIF non vide (${size} octets)`);
  console.log(`\n✅ E2E ENREGISTREMENT OK (${n} images, ${size} octets : ${gifPath})`);
} finally {
  if (gifPath) {
    try {
      unlinkSync(gifPath);
    } catch {}
  }
  if (tabId !== null) await client.callTool({ name: "tabs_close", arguments: { tabId } }).catch(() => {});
  await client.close();
}
