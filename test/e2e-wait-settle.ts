/**
 * Test end-to-end de wait_for settle + diagnostic (QW2) :
 * 1. settle: true sur une page statique : résolu vite, avec le détail « page stabilisée ».
 * 2. timeout sur un texte impossible : erreur qui détaille l'observé (URL, réseau, DOM, texte).
 *
 * Lancer avec : node test/e2e-wait-settle.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-wait-settle-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de wait_for settle/diagnostic ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const created: number[] = [];
try {
  console.log("\n1. Création de l'onglet...");
  const createRes = await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } });
  const tabId = Number(textOf(createRes).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);

  console.log("\n2. settle sur une page statique...");
  const settled = textOf(await client.callTool({ name: "wait_for", arguments: { tabId, settle: true, timeout: 15 } }));
  console.log(settled.split("\n")[0]);
  assert.ok(settled.includes("Condition remplie"), "settle résolu");
  assert.ok(settled.includes("stabilisée"), "détail de stabilisation annoncé");

  console.log("\n3. timeout avec diagnostic...");
  const res = (await client.callTool({
    name: "wait_for",
    arguments: { tabId, text: "texte qui n'existe nulle part 8f3a29", timeout: 1.5 },
  })) as unknown as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(res.isError, true, "le timeout reste une erreur");
  const diag = res.content.map((b) => b.text ?? "").join("\n");
  console.log(diag);
  assert.ok(diag.includes("Délai dépassé"), "mention du délai");
  assert.ok(diag.includes("URL actuelle"), "URL observée");
  assert.ok(diag.includes("Réseau :"), "état réseau observé");
  assert.ok(diag.includes("DOM :"), "état DOM observé");
  assert.ok(diag.includes("Texte :"), "état texte observé");

  console.log("\n✅ TOUS LES TESTS E2E DE WAIT_FOR SETTLE/DIAGNOSTIC ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
