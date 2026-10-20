/**
 * Test end-to-end de la cible par libellé, des étapes enchaînées et des limites de lecture
 * (fixture injectée dans un onglet example.com) :
 * 1. computer left_click target : le meilleur candidat reçoit le clic, la réponse le dit.
 * 2. target ambigu (deux « Envoyer ») : rien n'est fait, les candidats sont listés avec leur ref.
 * 3. target introuvable : erreur claire.
 * 4. form_input target + submitTarget : champ et bouton visés par libellé, un seul appel.
 * 5. steps fill / navigate / upload : parcours « remplir, joindre » en un appel, cible par étape.
 * 6. read_page maxItems : au plus N éléments listés, le reste est compté.
 * 7. Éditeurs à API (Tiptap, Lexical simulés) : contenu posé par leur API, texte relu.
 * 8. Instantané joint (snapshot) borné à 120 éléments sur une grosse page.
 *
 * Lancer avec : node test/e2e-target-steps.ts (extension rechargée + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-target-steps-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E cible / étapes / limites ===");

type Res = { isError?: true; content: { type: string; text?: string }[] };
const all = (res: unknown) => (res as Res).content.map((b) => b.text ?? "").join("\n");
const textOf = (res: unknown): string => {
  if ((res as Res).isError) console.log("Erreur d'outil : " + all(res));
  assert.strictEqual((res as Res).isError, undefined, "outil sans erreur");
  return all(res);
};
const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

const created: number[] = [];
try {
  const tabId = Number(textOf(await call("tabs_create", { url: "https://example.com" })).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);
  const js = async (code: string) =>
    textOf(await call("javascript", { tabId, code })).replace(/^<page_content[^>]*>\n?/, "").replace(/\n?<\/page_content>\s*$/, "").trim();

  await js(`(() => {
    document.body.innerHTML = [
      '<div id="bg">' + Array.from({ length: 150 }, (_, i) => '<button>Fond ' + (i + 1) + '</button>').join('') + '</div>',
      '<form id="f" onsubmit="return false">',
      '  <label>Objet du message <input id="obj" type="text"></label>',
      '  <button id="valider" type="button">Valider le formulaire</button>',
      '</form>',
      '<button id="lune">Allumer la lune</button><div id="out">rien</div>',
      '<button id="e1">Envoyer</button><button id="e2">Envoyer</button>',
      '<input id="up" type="file" aria-label="Joindre un fichier"><div id="files"></div>',
      '<div id="tip" class="ProseMirror" contenteditable="true" aria-label="Note Tiptap"></div>',
      '<div id="lex" data-lexical-editor="true" contenteditable="true" aria-label="Note Lexical"></div>',
    ].join("");
    document.getElementById("lune").addEventListener("click", () => { document.getElementById("out").textContent = "lune allumée"; });
    document.getElementById("valider").addEventListener("click", () => { document.getElementById("out").textContent = "formulaire validé : " + document.getElementById("obj").value; });
    document.getElementById("up").addEventListener("change", (e) => { document.getElementById("files").textContent = e.target.files[0].name + " joint"; });

    // Tiptap simulé : l'instance est sur l'élément ProseMirror.
    const tip = document.getElementById("tip");
    tip.editor = { commands: { setContent(h) { tip.innerHTML = h; return true; } }, getText() { return tip.textContent; } };
    // Lexical simulé : parseEditorState / setEditorState sur __lexicalEditor, état relu en texte.
    const lex = document.getElementById("lex");
    lex.__lexicalEditor = {
      parseEditorState(json) { return JSON.parse(json); },
      setEditorState(st) {
        lex.innerHTML = st.root.children.map((p) => "<p>" + p.children.map((c) => c.type === "linebreak" ? "<br>" : c.text).join("") + "</p>").join("");
      },
    };
    return "fixture-ok";
  })()`);

  console.log("\n1. computer left_click target...");
  const r1 = textOf(await call("computer", { tabId, action: "left_click", target: "Allumer la lune" }));
  console.log(r1);
  assert.ok(/^Cible « ?"?Allumer la lune"? ?» → ref_\d+|^Cible "Allumer la lune" → ref_\d+/.test(r1), "la résolution est annoncée");
  assert.strictEqual(await js("document.getElementById('out').textContent"), "lune allumée", "le clic a eu lieu");

  console.log("\n2. target ambigu...");
  const amb = (await call("computer", { tabId, action: "left_click", target: "Envoyer" })) as Res;
  const ambText = all(amb);
  console.log(ambText.slice(0, 300));
  assert.strictEqual(amb.isError, true, "ambiguïté refusée");
  assert.ok(/ambiguë/.test(ambText) && (ambText.match(/ref_\d+/g) ?? []).length >= 2, "candidats listés avec leur ref");

  console.log("\n3. target introuvable...");
  const none = (await call("computer", { tabId, action: "left_click", target: "Bouton qui n'existe absolument pas xyzzy" })) as Res;
  assert.strictEqual(none.isError, true);
  assert.ok(/aucun élément trouvé/.test(all(none)), "message clair");

  console.log("\n4. form_input target + submitTarget...");
  const r4 = textOf(await call("form_input", { tabId, target: "Objet du message", value: "Flyers à imprimer", submitTarget: "Valider le formulaire" }));
  console.log(r4);
  assert.ok(/Cible .*Objet du message.* → ref_\d+/.test(r4) && /Cible .*Valider le formulaire.* → ref_\d+/.test(r4), "les deux cibles résolues");
  assert.strictEqual(await js("document.getElementById('out').textContent"), "formulaire validé : Flyers à imprimer", "champ rempli puis bouton cliqué");

  console.log("\n5. steps fill / upload / navigate...");
  const dir = mkdtempSync(join(tmpdir(), "abc-steps-"));
  const file = join(dir, "pj-steps.pdf");
  writeFileSync(file, "%PDF-1.4 test");
  const r5 = textOf(await call("computer", {
    tabId,
    steps: [
      { action: "fill", target: "Objet du message", value: "Étape 1" },
      { action: "upload", target: "Joindre un fichier", paths: [file] },
      { action: "left_click", target: "Allumer la lune" },
    ],
  }));
  console.log(r5);
  assert.ok(/Étape 1\/3 \[fill/.test(r5) && /Étape 2\/3 \[upload/.test(r5) && /Étape 3\/3 \[left_click/.test(r5), "trois étapes exécutées");
  assert.strictEqual(await js("document.getElementById('obj').value"), "Étape 1", "fill par cible");
  assert.ok((await js("document.getElementById('files').textContent")).includes("pj-steps.pdf"), "upload par cible");

  console.log("\n6. read_page maxItems...");
  const r6 = textOf(await call("read_page", { tabId, filter: "interactive", maxItems: 10 }));
  const refLines = r6.split("\n").filter((l) => /\[ref_\d+\]/.test(l)).length;
  console.log(r6.split("\n").slice(-2).join("\n"));
  assert.ok(refLines <= 10, `au plus 10 éléments (${refLines})`);
  assert.ok(/autre\(s\) élément\(s\) non listé\(s\) : maxItems=10/.test(r6), "le reste est compté");

  console.log("\n7. Tiptap et Lexical par leur API...");
  const t = textOf(await call("form_input", { tabId, target: "Note Tiptap", value: "Un\n\nDeux", format: "text" }));
  console.log(t);
  assert.ok(/Tiptap \(setContent\)/.test(t), "Tiptap par setContent");
  assert.strictEqual(await js("document.getElementById('tip').innerHTML"), "<p>Un</p><p>Deux</p>");
  const l = textOf(await call("form_input", { tabId, target: "Note Lexical", value: "Ligne A\nLigne B\n\nFin" }));
  console.log(l);
  assert.ok(/Lexical \(setEditorState\)/.test(l), "Lexical par setEditorState");
  assert.strictEqual(await js("document.getElementById('lex').innerHTML"), "<p>Ligne A<br>Ligne B</p><p>Fin</p>");

  console.log("\n8. Instantané joint borné...");
  const r8 = textOf(await call("computer", { tabId, action: "left_click", target: "Allumer la lune", snapshot: true }));
  const snapRefs = r8.split("\n").filter((l2) => /\[ref_\d+\]/.test(l2)).length;
  console.log(`${snapRefs} éléments dans la réponse`);
  assert.ok(snapRefs <= 121, "instantané borné à 120");
  assert.ok(/non listé\(s\) : maxItems=120/.test(r8), "le reste est compté");

  console.log("\n✅ TOUS LES TESTS E2E CIBLE / ÉTAPES / LIMITES ONT RÉUSSI !");
} finally {
  for (const id of created) await call("tabs_close", { tabId: id }).catch(() => {});
  await client.close();
}
