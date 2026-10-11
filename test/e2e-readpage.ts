/**
 * Test end-to-end de read_page / find / get_page_text sur deux cas réels (Discord) :
 * 1. Contenu HTML dans <foreignObject> d'un <svg> (rail de serveurs Discord) : lu,
 *    avec le nom du treeitem (label visuellement masqué) et une ref cliquable.
 * 2. Grand canvas décoratif en toile de fond + contenu HTML : get_page_text ne doit
 *    PAS déclencher le fallback OCR (comportement canvas conservé sinon, cas témoin).
 *
 * Lancer avec : node test/e2e-readpage.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-readpage-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de read_page ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const created: number[] = [];
try {
  // 1. Fixture façon Discord : canvas décoratif plein écran + article HTML + svg/foreignObject.
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
        const c = document.createElement("canvas");
        c.id = "e2e-backdrop";
        c.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:0;";
        c.width = innerWidth; c.height = innerHeight;
        document.body.prepend(c);
        const main = document.createElement("main");
        main.style.cssText = "position:relative;z-index:1;min-height:110vh;";
        main.innerHTML =
          "<h1>Article de test</h1><p>" + "Texte de contenu réel en HTML. ".repeat(40) + "</p>" +
          '<svg width="60" height="60" role="none"><foreignObject x="0" y="0" width="60" height="60">' +
          '<div role="treeitem" tabindex="-1" data-list-item-id="guildsnav___test">' +
          '<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);">' +
          "Serveur de test Rattus</span></div></foreignObject></svg>" +
          "<button>Valider</button>";
        document.body.appendChild(main);
        return "fixture-ok";
      })()`,
    },
  });

  // 2. read_page interactif voit le treeitem dans le foreignObject, nommé, avec ref.
  console.log("\n2. Test read_page interactif (foreignObject)...");
  const tree = textOf(await client.callTool({ name: "read_page", arguments: { tabId, filter: "interactive" } }));
  console.log(tree.split("\n").slice(0, 12).join("\n") + "\n...");
  assert.ok(tree.includes("treeitem"), "le treeitem du foreignObject est lu");
  assert.ok(tree.includes("Serveur de test Rattus"), "le treeitem est nommé par son label masqué");
  assert.ok(/treeitem "Serveur de test Rattus" \[ref_\d+\]/.test(tree), "le treeitem a une ref cliquable");
  assert.ok(tree.includes("Valider"), "le bouton hors svg est toujours lu");

  // 3. find retrouve le treeitem par son nom.
  console.log("\n3. Test find sur le treeitem...");
  const found = textOf(await client.callTool({ name: "find", arguments: { tabId, query: "Rattus" } }));
  console.log(found.split("\n").slice(0, 4).join("\n"));
  assert.ok(found.includes("treeitem"), "find retourne le treeitem (pas seulement du texte)");

  // 4. get_page_text : contenu HTML réel + canvas décoratif → pas de fallback OCR.
  console.log("\n4. Test get_page_text sans OCR sur canvas décoratif...");
  const body = textOf(await client.callTool({ name: "get_page_text", arguments: { tabId } }));
  assert.ok(body.includes("Texte de contenu réel"), "texte HTML présent");
  assert.ok(!body.includes("dessinée dans un <canvas>"), "pas de fallback OCR sur toile de fond décorative");

  // 5. Témoin : canvas opaque au premier plan + presque pas de texte → OCR conservé.
  console.log("\n5. Test témoin canvas au premier plan (OCR conservé)...");
  const createRes2 = await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } });
  const tabId2 = Number(textOf(createRes2).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId2, "tabId2 extrait");
  created.push(tabId2);
  await client.callTool({
    name: "javascript",
    arguments: {
      tabId: tabId2,
      code: `(() => {
        document.body.innerHTML = "<p>OK</p>";
        const c = document.createElement("canvas");
        c.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:9999;background:#fff;";
        c.width = innerWidth; c.height = innerHeight;
        const g = c.getContext("2d");
        g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = "#000"; g.font = "48px sans-serif"; g.fillText("CANVAS", 60, 120);
        document.body.appendChild(c);
        return "canvas-ok";
      })()`,
    },
  });
  const body2 = textOf(await client.callTool({ name: "get_page_text", arguments: { tabId: tabId2 } }));
  assert.ok(body2.includes("dessinée dans un <canvas>"), "fallback OCR conservé quand le canvas porte le contenu");

  console.log("\n✅ TOUS LES TESTS E2E DE READ_PAGE ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
