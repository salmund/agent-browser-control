/**
 * Test end-to-end des refs auto-réparées (QW4) :
 * 1. un bouton obtient une ref via find ;
 * 2. la page remplace le nœud (re-render : même texte, nouveau nœud) ;
 * 3. un survol avec l'ancienne ref réussit quand même, avec la note de réparation ;
 * 4. un bouton supprimé sans remplaçant échoue toujours (pas de devinette).
 *
 * Lancer avec : node test/e2e-ref-heal.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-ref-heal-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E des refs auto-réparées ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const created: number[] = [];
try {
  console.log("\n1. Création de l'onglet + fixture...");
  const createRes = await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } });
  const tabId = Number(textOf(createRes).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);

  await client.callTool({
    name: "javascript",
    arguments: {
      tabId,
      code: `(() => {
        document.body.innerHTML = '<button id="cible-heal">Bouton Magique Heal</button><button id="victime">Bouton Fantome Heal</button>';
        return "fixture-ok";
      })()`,
    },
  });

  console.log("\n2. Refs initiales...");
  const found = textOf(await client.callTool({ name: "find", arguments: { tabId, query: "Bouton Magique Heal" } }));
  const ref = found.match(/\[(ref_\d+)\]/)?.[1];
  assert.ok(ref, "ref du bouton cible");
  const found2 = textOf(await client.callTool({ name: "find", arguments: { tabId, query: "Bouton Fantome Heal" } }));
  const refGone = found2.match(/\[(ref_\d+)\]/)?.[1];
  assert.ok(refGone, "ref du bouton fantôme");

  console.log("\n3. Re-render (nœud remplacé) + suppression...");
  await client.callTool({
    name: "javascript",
    arguments: {
      tabId,
      code: `(() => {
        const b = document.getElementById("cible-heal");
        const fresh = document.createElement("button");
        fresh.id = "cible-heal";
        fresh.textContent = "Bouton Magique Heal";
        b.replaceWith(fresh);
        document.getElementById("victime").remove();
        return "rerender-ok";
      })()`,
    },
  });

  console.log("\n4. Survol avec l'ancienne ref : réparée...");
  const hover = textOf(await client.callTool({ name: "computer", arguments: { tabId, action: "hover", ref } }));
  console.log(hover);
  assert.ok(hover.includes("Survol"), "survol réussi malgré le re-render");
  assert.ok(hover.includes("réparée"), "note de réparation présente");

  console.log("\n5. Bouton supprimé : échec net, pas de devinette...");
  const res = (await client.callTool({ name: "computer", arguments: { tabId, action: "hover", ref: refGone } })) as unknown as {
    isError?: true;
    content: { type: string; text?: string }[];
  };
  assert.strictEqual(res.isError, true, "la ref vraiment morte échoue");
  assert.ok(res.content.map((b) => b.text ?? "").join("\n").includes("introuvable"), "message d'élément introuvable");

  console.log("\n✅ TOUS LES TESTS E2E DES REFS AUTO-RÉPARÉES ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
