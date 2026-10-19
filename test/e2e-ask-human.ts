/**
 * Test end-to-end de ask_human (SG14), chemins automatisables :
 * 1. question manquante : erreur claire, sans attendre ;
 * 2. onglet inconnu : erreur claire ;
 * 3. timeout court (10 s) sans réponse : erreur « Sans réponse », demande nettoyée
 *    (une relance immédiate ne voit pas de demande fantôme).
 * Le chemin heureux (clic « C'est fait » dans le panneau) exige un humain :
 * le vérifier à la main une fois (voir docs/ask-human.md).
 *
 * Lancer avec : node test/e2e-ask-human.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-ask-human-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de ask_human ===");

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

  console.log("\n2. Question manquante : erreur immédiate...");
  const bad = (await client.callTool({ name: "ask_human", arguments: { tabId, question: "  " } })) as unknown as {
    isError?: true;
    content: { type: string; text?: string }[];
  };
  assert.strictEqual(bad.isError, true, "erreur remontée");
  assert.ok(bad.content.map((b) => b.text ?? "").join("\n").includes("'question' requise"), "diagnostic");

  console.log("\n3. Onglet inconnu : erreur immédiate...");
  const badTab = (await client.callTool({ name: "ask_human", arguments: { tabId: 999999999, question: "test" } })) as unknown as {
    isError?: true;
    content: { type: string; text?: string }[];
  };
  assert.strictEqual(badTab.isError, true, "erreur remontée");

  console.log("\n4. Timeout court sans réponse (~10 s, ne rien cliquer)...");
  const started = Date.now();
  const res = (await client.callTool({ name: "ask_human", arguments: { tabId, question: "TEST E2E : ne pas répondre", timeout: 10 } })) as unknown as {
    isError?: true;
    content: { type: string; text?: string }[];
  };
  const elapsed = Date.now() - started;
  assert.strictEqual(res.isError, true, "échec remonté");
  assert.ok(res.content.map((b) => b.text ?? "").join("\n").includes("Sans réponse"), "mention du timeout");
  assert.ok(elapsed >= 9000 && elapsed < 30000, `attente réelle (${Math.round(elapsed / 1000)} s)`);

  console.log("\n✅ TOUS LES TESTS E2E AUTOMATISABLES DE ASK_HUMAN ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
