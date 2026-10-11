/**
 * Test end-to-end de la pertinence de find (P5) :
 * 1. Mots vides : « charger plus de messages » ne remonte pas un texte qui ne contient
 *    que « plus » et « de » (cas réel Google Messages).
 * 2. Plancher 0,6 : un match 1/2 non interactif est écarté, avec compteur.
 * 3. Les interactifs partiels survivent (bonus actionnable).
 * 4. Requête d'un seul mot : comportement inchangé.
 *
 * Lancer avec : node test/e2e-find-relevance.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-find-relevance-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de pertinence find ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const created: number[] = [];
try {
  console.log("\n1. Création de l'onglet + injection de la fixture...");
  const createRes = await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } });
  const tabId = Number(textOf(createRes).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);

  await client.callTool({
    name: "javascript",
    arguments: {
      tabId,
      code: `(() => {
        document.body.innerHTML = "";
        const b = document.createElement("button");
        b.textContent = "Charger plus de messages";
        const noise = document.createElement("div");
        noise.textContent = "Un conducteur a un message concernant votre commande. Répondez STOP pour ne plus recevoir de SMS.";
        const b2 = document.createElement("button");
        b2.textContent = "Facture acquittée de janvier";
        const noise2 = document.createElement("div");
        noise2.textContent = "Votre facture du mois est disponible";
        const rare = document.createElement("div");
        rare.textContent = "Mot unique xyzzy ici";
        document.body.append(b, noise, b2, noise2, rare);
        return "fixture-ok";
      })()`,
    },
  });

  console.log("\n2. Mots vides : le bruit 'plus/de' ne remonte pas...");
  const stop = textOf(await client.callTool({ name: "find", arguments: { tabId, query: "charger plus de messages" } }));
  console.log(stop.split("\n").slice(0, 4).join("\n"));
  assert.ok(stop.includes("Charger plus de messages"), "cible trouvée");
  assert.ok(!stop.includes("conducteur"), "bruit 'plus/de' écarté");

  console.log("\n3. Plancher 0,6 : match 1/2 non interactif écarté, compteur visible...");
  const floor = textOf(await client.callTool({ name: "find", arguments: { tabId, query: "facture acquittée" } }));
  console.log(floor.split("\n").slice(0, 5).join("\n"));
  assert.ok(floor.includes("Facture acquittée"), "bouton complet trouvé");
  assert.ok(!floor.includes("Votre facture du mois"), "match partiel écarté");
  assert.ok(/partiel\(s\) écarté\(s\)/.test(floor), "compteur d'écartés présent");

  console.log("\n4. Requête d'un seul mot : inchangée...");
  const single = textOf(await client.callTool({ name: "find", arguments: { tabId, query: "xyzzy" } }));
  assert.ok(single.includes("xyzzy"), "mot unique trouvé");

  console.log("\n✅ TOUS LES TESTS E2E DE PERTINENCE FIND ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
