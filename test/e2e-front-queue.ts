/**
 * Test end-to-end de la file de premier plan (SG17) : deux agents agissent en
 * même temps dans deux onglets (survols par lots, qui tiennent le devant) :
 * les deux réussissent, sans collision ni interblocage, et les onglets
 * restent utilisables après (retour à l'utilisateur).
 *
 * Lancer avec : node test/e2e-front-queue.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const open = async (name: string): Promise<Client> => {
  const c = new Client({ name, version: "1.0.0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));
  return c;
};

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

console.log("=== Démarrage des tests E2E de la file de premier plan ===");

const clientA = await open("e2e-front-a-test");
const clientB = await open("e2e-front-b-test");
const tabs: { client: Client; tabId: number }[] = [];
try {
  console.log("\n1. Deux agents, deux onglets + fixtures...");
  const setup = async (client: Client, label: string): Promise<{ tabId: number; ref: string }> => {
    const created = textOf(await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } }));
    const tabId = Number(created.match(/tabId\s+(\d+)/)?.[1]);
    assert.ok(tabId, "tabId extrait");
    tabs.push({ client, tabId });
    await client.callTool({
      name: "javascript",
      arguments: { tabId, code: `document.body.innerHTML = '<button>${label}</button>'; "fixture-ok"` },
    });
    const found = textOf(await client.callTool({ name: "find", arguments: { tabId, query: label } }));
    const ref = found.match(/\[(ref_\d+)\]/)?.[1];
    assert.ok(ref, `ref pour ${label}`);
    return { tabId, ref };
  };
  const a = await setup(clientA, "Bouton Agent Aaa");
  const b = await setup(clientB, "Bouton Agent Bbb");

  console.log("\n2. Survols concurrents par lots (fenêtre tenue)...");
  const batch = (client: Client, tabId: number, ref: string) =>
    client.callTool({
      name: "computer",
      arguments: { tabId, steps: [{ action: "hover", ref }, { action: "wait", duration: 1 }, { action: "hover", ref }] },
    });
  const [resA, resB] = await Promise.all([batch(clientA, a.tabId, a.ref), batch(clientB, b.tabId, b.ref)]);
  const textA = textOf(resA);
  const textB = textOf(resB);
  assert.ok(textA.includes("Survol"), "agent A : survols réussis");
  assert.ok(textB.includes("Survol"), "agent B : survols réussis");
  assert.ok(!textA.includes("refusé") && !textB.includes("refusé"), "aucun clic refusé par collision");

  console.log("\n3. Onglets utilisables après (2 s)...");
  await new Promise((r) => setTimeout(r, 2000));
  const readA = textOf(await clientA.callTool({ name: "read_page", arguments: { tabId: a.tabId, filter: "interactive" } }));
  const readB = textOf(await clientB.callTool({ name: "read_page", arguments: { tabId: b.tabId, filter: "interactive" } }));
  assert.ok(readA.includes("Bouton Agent Aaa") && readB.includes("Bouton Agent Bbb"), "lectures OK après concurrence");

  console.log("\n✅ TOUS LES TESTS E2E DE LA FILE DE PREMIER PLAN ONT RÉUSSI !");
} finally {
  for (const t of tabs) {
    await t.client.callTool({ name: "tabs_close", arguments: { tabId: t.tabId } }).catch(() => {});
  }
  await clientA.close();
  await clientB.close();
}
