/**
 * Test end-to-end des gardes anti-clic-dans-le-vide (P1) :
 * 1. Un bouton normal est accepté (garde passante, pas de faux positif).
 * 2. Un bouton fixe hors écran (left:-9999px, façon « charger plus » en sortie
 *    d'animation) : clic refusé avec diagnostic, pas de clic dans le vide.
 * 3. Un bouton recouvert par une modale : clic refusé, recouvrement nommé.
 * 4. find exclut les éléments fixes hors écran (avec compteur).
 * 5. read_page omet un élément garé hors du document à gauche ou à droite (invisible,
 *    comme un menu hors canevas) et signale par « (hors écran) » un fixe sorti par le
 *    haut (toujours dans l'arbre : on peut vouloir savoir qu'il existe). La ref du
 *    fantôme horizontal reste accessible par find css: (intention explicite).
 *
 * La livraison physique du clic (le gestionnaire a-t-il tiré ?) dépend de
 * l'environnement : onglet volé qui ne peint pas, navigateur en arrière-plan
 * ou utilisateur qui reprend la main entre-temps. Le test calibre donc
 * l'input réel une fois (clic sonde + scrutation) et ne vérifie les effets
 * physiques que s'il est livré, en le disant explicitement sinon.
 *
 * Les clics y forcent silent: false (vrai clic) : le test vérifie les gardes et l entrée physique.
 * Lancer avec : node test/e2e-click-guard.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-click-guard-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E des gardes de clic ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scrute window.__clicked jusqu'à y voir `id` (12 s max) : true si l'input physique est livré. */
const waitClicked = async (tabId: number, id: string): Promise<boolean> => {
  for (let i = 0; i < 6; i++) {
    const flag = textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: "window.__clicked.join(',')" } }));
    if (flag.split(",").includes(id)) return true;
    await sleep(2000);
  }
  return false;
};

const textOfError = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, true, "outil en erreur attendue");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const refOf = (tree: string, label: string): string => {
  // describe() met le nom avant la ref : button "X" [ref_N]
  const direct = tree.match(new RegExp(`"${label}"\\s*\\[((?:f\\d+:)?ref_\\d+)\\]`));
  assert.ok(direct, `ref trouvée pour « ${label} »`);
  return direct[1];
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
        window.__clicked = [];
        const mk = (id, label) => {
          const b = document.createElement("button");
          b.id = id; b.textContent = label;
          b.style.cssText = "display:block;margin:20px;padding:12px 24px;font-size:16px;";
          b.addEventListener("click", () => window.__clicked.push(id));
          return b;
        };
        document.body.appendChild(mk("btn-ok", "Bouton cliquable témoin"));
        // Bouton fantôme : fixe, garé hors écran (animation de sortie façon Angular).
        const ghost = mk("btn-ghost", "Charger plus de messages fantôme");
        ghost.style.position = "fixed";
        ghost.style.left = "-9999px";
        ghost.style.top = "160px";
        document.body.appendChild(ghost);
        // Fantôme vertical : fixe, sorti par le haut (reste dans l'arbre, marqué hors écran).
        const ghostUp = mk("btn-ghost-up", "Bouton parti vers le haut");
        ghostUp.style.position = "fixed";
        ghostUp.style.left = "20px";
        ghostUp.style.top = "-9999px";
        document.body.appendChild(ghostUp);
        // Bouton recouvert : modale opaque par-dessus, dans le même conteneur.
        const wrap = document.createElement("div");
        wrap.style.cssText = "position:relative;display:inline-block;margin:20px;";
        const covered = mk("btn-covered", "Bouton recouvert témoin");
        covered.style.margin = "0";
        const modal = document.createElement("div");
        modal.id = "modal-cover";
        modal.textContent = "Modale de test";
        modal.style.cssText = "position:absolute;inset:0;background:rgba(200,0,0,.85);color:#fff;display:flex;align-items:center;justify-content:center;";
        wrap.appendChild(covered);
        wrap.appendChild(modal);
        document.body.appendChild(wrap);
        // Bouton sous la ligne de flottaison : le scroll auto doit toujours marcher.
        const spacer = document.createElement("div");
        spacer.style.height = "300vh";
        document.body.appendChild(spacer);
        document.body.appendChild(mk("btn-fold", "Bouton sous la ligne de flottaison"));
        return "fixture-ok";
      })()`,
    },
  });

  console.log("\n2. Lecture de l'arbre + extraction des refs...");
  const tree = textOf(await client.callTool({ name: "read_page", arguments: { tabId, filter: "interactive" } }));
  const refOk = refOf(tree, "Bouton cliquable témoin");
  // Garé à left:-9999px : hors du document, donc absent de l'arbre ; sa ref vient de find css:.
  assert.ok(!tree.includes("Charger plus de messages fantôme"), "fantôme horizontal absent de read_page");
  const viaCss = textOf(await client.callTool({ name: "find", arguments: { tabId, query: "css:#btn-ghost" } }));
  const refGhost = refOf(viaCss, "Charger plus de messages fantôme");
  const refCovered = refOf(tree, "Bouton recouvert témoin");
  const refFold = refOf(tree, "Bouton sous la ligne de flottaison");
  console.log(`refs : ok=${refOk} fantôme=${refGhost} recouvert=${refCovered} fold=${refFold}`);

  console.log("\n3. read_page signale le fantôme vertical « (hors écran) »...");
  assert.ok(/"Bouton parti vers le haut" \[ref_\d+\][^\n]*\(hors écran\)/.test(tree), "suffixe (hors écran) sur le fixe sorti par le haut");

  console.log("\n4. Clic normal : accepté (garde passante)...");
  const clickOk = textOf(await client.callTool({ name: "computer", arguments: { tabId, action: "left_click", ref: refOk, silent: false } }));
  assert.ok(clickOk.includes("left_click en"), "clic accepté, pas de faux positif de la garde");

  console.log("\n4b. Calibration de l'input physique...");
  const inputWorks = await waitClicked(tabId, "btn-ok");
  console.log(inputWorks
    ? "input physique livré : les assertions d'effet sont vérifiées."
    : "input physique NON livré (onglet volé non peint / navigateur occupé) : assertions d'effet ignorées.");

  console.log("\n5. Clic sous la ligne de flottaison : scroll auto, accepté...");
  textOf(await client.callTool({ name: "computer", arguments: { tabId, action: "left_click", ref: refFold, silent: false } }));
  if (inputWorks) {
    assert.ok(await waitClicked(tabId, "btn-fold"), "le clic après scroll a atteint le bouton");
  } else {
    console.log("(effet physique non vérifiable ici, acceptation seule)");
  }

  console.log("\n6. Clic fantôme : refusé avec diagnostic...");
  const ghostErr = textOfError(await client.callTool({ name: "computer", arguments: { tabId, action: "left_click", ref: refGhost, silent: false } }));
  console.log(ghostErr.split("\n").slice(0, 3).join("\n"));
  assert.ok(/hors écran/.test(ghostErr), "diagnostic hors écran");
  if (inputWorks) {
    const clicked3 = textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: "window.__clicked.join(',')" } }));
    assert.ok(!clicked3.includes("btn-ghost"), "aucun clic parti dans le vide");
  }

  console.log("\n7. Clic recouvert : refusé, recouvrement nommé...");
  const coverErr = textOfError(await client.callTool({ name: "computer", arguments: { tabId, action: "left_click", ref: refCovered, silent: false } }));
  console.log(coverErr.split("\n").slice(0, 3).join("\n"));
  assert.ok(/recouvert/.test(coverErr), "diagnostic de recouvrement");
  assert.ok(/modal-cover|Modale de test/.test(coverErr), "l'élément recouvrant est nommé");

  console.log("\n8. find exclut le fantôme, avec compteur...");
  const found = textOf(await client.callTool({ name: "find", arguments: { tabId, query: "fantôme" } }));
  console.log(found.split("\n").slice(0, 3).join("\n"));
  assert.ok(!found.includes("btn-ghost") && !found.includes("[ref_"), "aucune ref proposée pour le fantôme");
  assert.ok(/masqué\(s\) ignoré\(s\)/.test(found), "compteur de masqués présent");

  console.log("\n9. find css: explicite garde le fantôme (intention explicite)...");
  const foundCss = textOf(await client.callTool({ name: "find", arguments: { tabId, query: "css:#btn-ghost" } }));
  assert.ok(foundCss.includes("fantôme"), "le sélecteur explicite retrouve l'élément");

  console.log("\n✅ TOUS LES TESTS E2E DES GARDES DE CLIC ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
