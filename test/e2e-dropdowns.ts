/**
 * Test end-to-end des menus déroulants (constats live eBay / Figaro) :
 * 1. Survol d'un menu JS (ouvre sur mouseenter, ferme sur mouseleave) : le panneau
 *    reste ouvert en onglet masqué (le survol est rejoué par événements après la
 *    restitution de l'onglet, dont le mouseleave fermait le menu). Avant : fermé.
 * 2. Fond vide d'un menu ouvert (attrape-clic plein écran + bouton aria-expanded) :
 *    pas d'avis de fenêtre bloquante. Avant : avertissement abusif.
 * 3. Témoin : même fond sans menu ouvert -> avis conservé.
 *
 * Lancer avec : node test/e2e-dropdowns.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-dropdowns-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E des menus ===");

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

  // 1. Menu JS ouvre sur enter / ferme sur leave.
  console.log("\n1. Test survol persistant...");
  await client.callTool({
    name: "javascript",
    arguments: {
      tabId,
      code: `(() => {
        const nav = document.createElement("div");
        nav.innerHTML = '<span id="e2e-cat" style="cursor:pointer">Catégories</span>' +
          '<div id="e2e-panel" style="display:none"><a href="https://example.com/a">Article A</a></div>';
        document.body.appendChild(nav);
        const cat = document.getElementById("e2e-cat");
        const panel = document.getElementById("e2e-panel");
        cat.addEventListener("mouseenter", () => { panel.style.display = "block"; });
        cat.addEventListener("mouseleave", () => { panel.style.display = "none"; });
        return "menu-ok";
      })()`,
    },
  });
  const found = textOf(await client.callTool({ name: "find", arguments: { tabId, query: "Catégories" } }));
  const ref = found.match(/\[(ref_\d+)\]/)?.[1];
  assert.ok(ref, "ref du déclencheur trouvée");
  await client.callTool({ name: "computer", arguments: { tabId, action: "hover", ref } });
  const opened = textOf(
    await client.callTool({ name: "wait_for", arguments: { tabId, text: "Article A", timeout: 10 } }),
  );
  assert.ok(!opened.includes("non remplie"), "le panneau reste ouvert après restitution");
  const tree = textOf(await client.callTool({ name: "read_page", arguments: { tabId, filter: "interactive" } }));
  assert.ok(tree.includes("Article A"), "le lien du panneau est lisible");

  // 2. Fond vide + menu ouvert : pas d'avis.
  console.log("\n2. Test fond de menu (pas d'avis)...");
  await client.callTool({
    name: "javascript",
    arguments: {
      tabId,
      code: `(() => {
        document.getElementById("e2e-panel").style.display = "none";
        const btn = document.createElement("button");
        btn.id = "e2e-menubtn";
        btn.textContent = "Menu";
        btn.setAttribute("aria-expanded", "true");
        document.body.appendChild(btn);
        const layer = document.createElement("div");
        layer.id = "e2e-layer";
        layer.style.cssText = "position:fixed;inset:0;z-index:9999;";
        document.body.appendChild(layer);
        return "layer-ok";
      })()`,
    },
  });
  const tree2 = textOf(await client.callTool({ name: "read_page", arguments: { tabId, filter: "interactive" } }));
  assert.ok(!tree2.includes("recouvre la page"), "pas d'avis sur le fond vide d'un menu ouvert");

  // 3. Témoin : même fond sans menu ouvert -> avis conservé.
  console.log("\n3. Test témoin fond seul (avis conservé)...");
  await client.callTool({
    name: "javascript",
    arguments: {
      tabId,
      code: `document.getElementById("e2e-menubtn").setAttribute("aria-expanded", "false"); "closed-ok"`,
    },
  });
  const tree3 = textOf(await client.callTool({ name: "read_page", arguments: { tabId, filter: "interactive" } }));
  assert.ok(tree3.includes("recouvre la page"), "avis conservé sur fond vide sans menu");

  console.log("\n✅ TOUS LES TESTS E2E DES MENUS ONT RÉUSSI !");
} finally {
  if (tabId !== null) {
    await client.callTool({ name: "tabs_close", arguments: { tabId } }).catch(() => {});
  }
  await client.close();
}
