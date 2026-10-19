/**
 * Test end-to-end du leurre de visibilité (QW1) :
 * 1. un onglet agent (en arrière-plan) se croit visible : visibilityState = visible,
 *    document.hidden = false, hasFocus() = true, garde __abcVisSpoof posée ;
 * 2. le leurre survit à une navigation (script sur chaque nouveau document).
 *
 * Lancer avec : node test/e2e-visibility.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-visibility-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E du leurre de visibilité ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const PROBE = `(() => ({
  state: document.visibilityState,
  hidden: document.hidden,
  focus: document.hasFocus(),
  flag: !!window.__abcVisSpoof,
}))()`;

const created: number[] = [];
try {
  console.log("\n1. Création de l'onglet + attachement (javascript)...");
  const createRes = await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } });
  const tabId = Number(textOf(createRes).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);

  const first = textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: PROBE } }));
  console.log(first);
  const v1 = JSON.parse(first.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
  assert.strictEqual(v1.state, "visible", "visibilityState spoofé");
  assert.strictEqual(v1.hidden, false, "document.hidden spoofé");
  assert.strictEqual(v1.focus, true, "hasFocus() spoofé");
  assert.strictEqual(v1.flag, true, "garde __abcVisSpoof posée");

  console.log("\n2. Navigation : le leurre survit (nouveau document)...");
  textOf(await client.callTool({ name: "navigate", arguments: { tabId, url: "https://example.org" } }));
  const second = textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: PROBE } }));
  console.log(second);
  const v2 = JSON.parse(second.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
  assert.strictEqual(v2.state, "visible", "spoof persistant après navigation");
  assert.strictEqual(v2.flag, true, "garde reposée après navigation");

  console.log("\n✅ TOUS LES TESTS E2E DU LEURRE DE VISIBILITÉ ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
