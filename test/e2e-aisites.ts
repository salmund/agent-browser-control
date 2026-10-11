/**
 * Test end-to-end de l'utilisabilité des sites IA (constats live sur Copilot / ChatGPT) :
 * 1. form_input remplit un éditeur contenteditable CONTRÔLÉ (façon React : les
 *    modifications non fiables sont restaurées, seules les transactions d'édition
 *    natives passent). Avant le correctif, le texte ne prenait pas (Copilot).
 * 2. Un panneau d'écriture fixe et grand (compositeur façon ChatGPT : champ riche
 *    + bouton, 60 %+ de l'écran) ne déclenche PAS l'avis de fenêtre bloquante.
 * 3. Témoin : le même panneau SANS champ d'édition déclenche toujours l'avis.
 *
 * Lancer avec : node test/e2e-aisites.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-aisites-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E des sites IA ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

let tabId: number | null = null;
try {
  const createRes = await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } });
  tabId = Number(textOf(createRes).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");

  // 1. Éditeur contrôlé façon React.
  console.log("\n1. Test form_input sur contenteditable contrôlé...");
  await client.callTool({
    name: "javascript",
    arguments: {
      tabId,
      code: `(() => {
        const ed = document.createElement("div");
        ed.id = "e2e-controlled";
        ed.setAttribute("contenteditable", "true");
        ed.setAttribute("aria-label", "Éditeur contrôlé");
        ed.textContent = "ancien";
        document.body.appendChild(ed);
        window.__e2eState = "ancien";
        ed.addEventListener("beforeinput", (e) => {
          if (!e.isTrusted) { e.preventDefault(); ed.textContent = window.__e2eState; }
        });
        ed.addEventListener("input", (e) => {
          if (e.isTrusted) window.__e2eState = ed.textContent;
          else ed.textContent = window.__e2eState;
        });
        return "editor-ok";
      })()`,
    },
  });
  const found = textOf(await client.callTool({ name: "find", arguments: { tabId, query: "Éditeur contrôlé" } }));
  const ref = found.match(/\[(ref_\d+)\]/)?.[1];
  assert.ok(ref, `ref de l'éditeur trouvée (${found.slice(0, 100)})`);
  const filled = textOf(await client.callTool({ name: "form_input", arguments: { tabId, ref, value: "nouveau texte" } }));
  console.log(filled.slice(0, 120));
  const state = textOf(
    await client.callTool({
      name: "javascript",
      arguments: { tabId, code: `document.getElementById("e2e-controlled").textContent + "|" + window.__e2eState` },
    }),
  );
  assert.ok(state.includes("nouveau texte|nouveau texte"), `texte accepté par l'éditeur contrôlé (reçu : ${state.slice(0, 80)})`);

  // 2. Compositeur fixe et grand : pas d'avis de fenêtre bloquante.
  console.log("\n2. Test compositeur (pas d'avis bloquant)...");
  await client.callTool({
    name: "javascript",
    arguments: {
      tabId,
      code: `(() => {
        const p = document.createElement("div");
        p.id = "e2e-composer";
        p.style.cssText = "position:fixed;left:5%;right:5%;bottom:0;height:70vh;background:#fff;z-index:9999;color:#000;";
        p.innerHTML = '<div contenteditable="true" aria-label="Message">Bonjour</div><button>Envoyer</button>';
        document.body.appendChild(p);
        return "composer-ok";
      })()`,
    },
  });
  const tree = textOf(await client.callTool({ name: "read_page", arguments: { tabId, filter: "interactive" } }));
  assert.ok(!tree.includes("recouvre la page"), "pas d'avis de fenêtre bloquante sur un compositeur");

  // 3. Témoin : grand panneau fixe sans champ d'édition -> avis conservé.
  console.log("\n3. Test témoin grand panneau (avis conservé)...");
  await client.callTool({
    name: "javascript",
    arguments: {
      tabId,
      code: `(() => {
        document.getElementById("e2e-composer")?.remove();
        const p = document.createElement("div");
        p.id = "e2e-panel";
        p.style.cssText = "position:fixed;left:5%;right:5%;bottom:0;height:70vh;background:#fff;z-index:9999;color:#000;";
        p.innerHTML = "<p>Offre spéciale, dépêchez-vous.</p><button>Voir</button><button>Fermer</button>";
        document.body.appendChild(p);
        return "panel-ok";
      })()`,
    },
  });
  const tree2 = textOf(await client.callTool({ name: "read_page", arguments: { tabId, filter: "interactive" } }));
  assert.ok(tree2.includes("recouvre la page"), "avis conservé sur un grand panneau sans champ");

  console.log("\n✅ TOUS LES TESTS E2E DES SITES IA ONT RÉUSSI !");
} finally {
  if (tabId !== null) {
    await client.callTool({ name: "tabs_close", arguments: { tabId } }).catch(() => {});
  }
  await client.close();
}
