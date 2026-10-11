/**
 * Test end-to-end de read_page labels/include (P4) :
 * 1. Par défaut (interactif), les messages de chat non interactifs sont absents.
 * 2. labels=true les inclut avec leur aria-label complet (expéditeur + date).
 * 3. include force une liste d'éléments, même non interactifs.
 * 4. En mode all sans labels, le texte brut apparaît mais pas les métadonnées aria.
 * 5. include invalide : erreur claire.
 *
 * Lancer avec : node test/e2e-readpage-labels.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-readpage-labels-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de read_page labels/include ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const created: number[] = [];
try {
  console.log("\n1. Création de l'onglet + injection de la fixture (chat façon Messages)...");
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
        const chat = document.createElement("div");
        chat.id = "chat";
        const m1 = document.createElement("mws-text-message-part");
        m1.setAttribute("aria-label", "Vous avez dit : J'arrive vers 30. Envoyé le 9 septembre 2026 à 07:46.");
        m1.textContent = "J'arrive vers 30";
        const m2 = document.createElement("mws-text-message-part");
        m2.setAttribute("aria-label", "Papa a écrit : Ok. Reçu le 9 septembre 2026 à 07:47.");
        m2.textContent = "Ok";
        const b = document.createElement("button");
        b.textContent = "Répondre";
        chat.append(m1, m2, b);
        document.body.appendChild(chat);
        return "fixture-ok";
      })()`,
    },
  });

  console.log("\n2. Interactif par défaut : messages absents...");
  const tree = textOf(await client.callTool({ name: "read_page", arguments: { tabId, filter: "interactive" } }));
  assert.ok(tree.includes("Répondre"), "bouton présent");
  assert.ok(!tree.includes("Vous avez dit"), "message 1 absent par défaut");
  assert.ok(!tree.includes("Papa a écrit"), "message 2 absent par défaut");

  console.log("\n3. labels=true : messages avec expéditeur + date...");
  const labeled = textOf(await client.callTool({ name: "read_page", arguments: { tabId, filter: "interactive", labels: true } }));
  console.log(labeled.split("\n").filter((l) => l.includes("dit :") || l.includes("écrit :")).join("\n"));
  assert.ok(labeled.includes("Vous avez dit"), "message 1 nommé");
  assert.ok(labeled.includes("Envoyé le 9 septembre"), "date du message 1");
  assert.ok(labeled.includes("Papa a écrit"), "message 2 nommé");
  assert.ok(/labeled "Vous avez dit[^"]*"\s*\[(f\d+:)?ref_\d+\]/.test(labeled), "rôle labeled + ref");

  console.log("\n4. include force la liste...");
  const included = textOf(await client.callTool({ name: "read_page", arguments: { tabId, filter: "interactive", include: "mws-text-message-part" } }));
  assert.ok(included.includes("Vous avez dit") && included.includes("Papa a écrit"), "messages forcés dans l'arbre");

  console.log("\n5. Mode all sans labels : texte brut, pas de métadonnées...");
  const all = textOf(await client.callTool({ name: "read_page", arguments: { tabId, filter: "all" } }));
  assert.ok(all.includes("J'arrive vers 30"), "texte brut présent");
  assert.ok(!all.includes("Envoyé le 9 septembre"), "date absente sans labels (le manque comblé)");

  console.log("\n6. include invalide : erreur claire...");
  const bad = await client.callTool({ name: "read_page", arguments: { tabId, filter: "interactive", include: "(((" } }) as unknown as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(bad.isError, true, "erreur remontée");
  assert.ok(bad.content.map((b) => b.text ?? "").join("\n").includes("invalide"), "message d'erreur clair");

  console.log("\n✅ TOUS LES TESTS E2E DE READ_PAGE LABELS ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
