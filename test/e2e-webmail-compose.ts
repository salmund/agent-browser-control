/**
 * Test end-to-end des gains de vitesse issus du retour d'usage « mail à Neva » (20/10/2026),
 * sur une fausse page de webmail (fixture injectée dans un onglet example.com) :
 * 1. Éditeur riche à API (CKEditor 5 simulé) : form_input passe par setData, texte multiligne en vrais
 *    paragraphes, format markdown (listes, gras), pas de paragraphe vide en trop.
 * 2. Champ destinataire à puces (combobox aria-haspopup=menu) : l'adresse tapée choisit l'unique suggestion
 *    qui la contient, la puce existe.
 * 3. Action à effet tardif (routeur lent) : « Effet » ne dit plus « inchangé » à tort.
 * 4. navigate vers un #fragment que le routeur n'a pas suivi : repli sur le clic du lien, annoncé.
 * 5. file_upload : attend la fin de la requête d'envoi et confirme que le nom est visible.
 * 6. read_page diff : une fenêtre modale (fond masqué) ne liste pas 60 retraits.
 * 7. Ref périmée d'un bouton « Envoyer » dont le contexte a changé : refus (prudence) MAIS avec la ref actuelle.
 *
 * Lancer avec : node test/e2e-webmail-compose.ts (extension rechargée + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-webmail-compose-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E webmail (compose) ===");

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

  await call("javascript", {
    tabId,
    code: `(() => {
      document.body.innerHTML = [
        '<div id="bg">' + Array.from({ length: 60 }, (_, i) => '<button>Fond ' + (i + 1) + '</button>').join('') + '</div>',
        '<div id="compose">',
        '  <input id="to" role="combobox" aria-haspopup="menu" aria-expanded="false" aria-controls="lb" aria-label="Ajouter un destinataire" autocomplete="off">',
        '  <ul id="lb" role="listbox" style="display:none"></ul><div id="chips" role="listbox" aria-label="Destinataires"></div>',
        '  <div id="ed" contenteditable="true" aria-label="Corps du message" class="ck-editor__editable ck-content"></div>',
        '  <input id="up" type="file" aria-label="Joindre">',
        '  <div id="files"></div>',
        '  <button id="slow">Actualiser</button><div id="slowout">rien</div>',
        '  <button id="envoyer">Envoyer</button>',
        '</div>',
        '<div id="nav"><a href="#!/Drafts">Brouillons</a></div><div id="view">Envoyés</div>',
      ].join("");

      // CKEditor 5 simulé : l'API est sur l'élément, dans le monde de la page (invisible du monde isolé).
      const ed = document.getElementById("ed");
      ed.ckeditorInstance = { _d: "", setData(h) { this._d = h; ed.innerHTML = h; }, getData() { return this._d; } };
      // Comme le vrai : un insertText sauvage casserait l'éditeur.
      ed.addEventListener("beforeinput", () => { window.__wildInput = (window.__wildInput || 0) + 1; });

      // Champ destinataires : liste de suggestions, puce à la sélection.
      const to = document.getElementById("to"), lb = document.getElementById("lb");
      to.addEventListener("input", () => {
        const v = to.value.toLowerCase();
        lb.innerHTML = v ? '<li role="option">Neva Aygun &lt;neva.aygun@univ-rouen.fr&gt;</li><li role="option">Autre Personne &lt;autre@exemple.fr&gt;</li>' : "";
        lb.style.display = v ? "block" : "none";
        to.setAttribute("aria-expanded", v ? "true" : "false");
      });
      lb.addEventListener("click", (e) => {
        const li = e.target.closest("li"); if (!li) return;
        const c = document.createElement("span"); c.setAttribute("role", "option"); c.className = "chip"; c.textContent = li.textContent;
        document.getElementById("chips").appendChild(c);
        to.value = ""; lb.style.display = "none"; lb.innerHTML = ""; to.setAttribute("aria-expanded", "false");
      });

      // Routeur lent : la page réagit 450 ms après le clic.
      document.getElementById("slow").addEventListener("click", () => setTimeout(() => { document.getElementById("slowout").textContent = "mis à jour tardivement avec un texte plus long"; }, 450));

      // Routeur à hash qui n'écoute pas hashchange : seul le clic sur le lien le fait changer de vue.
      document.querySelector("#nav a").addEventListener("click", (e) => { setTimeout(() => { document.getElementById("view").textContent = "Brouillons : 14 messages"; }, 150); });

      // Envoi de fichier : POST, puis la puce de la pièce jointe apparaît à la réponse.
      document.getElementById("up").addEventListener("change", (e) => {
        const f = e.target.files[0];
        fetch("/upload-fixture", { method: "POST", body: "x" }).finally(() => { document.getElementById("files").textContent = f.name + " joint"; });
      });
      return "fixture-ok";
    })()`,
  });
  const refOf = async (label: string): Promise<string> => {
    const found = textOf(await call("find", { tabId, query: label }));
    const ref = found.match(/\[(ref_\d+)\]/)?.[1];
    assert.ok(ref, `ref pour ${label}`);
    return ref;
  };
  // Le retour de javascript est enveloppé dans <page_content> (donnée non fiable) : on ne garde que la valeur.
  const js = async (code: string) =>
    textOf(await call("javascript", { tabId, code })).replace(/^<page_content[^>]*>\n?/, "").replace(/\n?<\/page_content>\s*$/, "");

  console.log("\n1. Éditeur riche à API (setData)...");
  const body = "Salut Neva,\n\nVoici le PDF.\nÀ bientôt,\n\nLouis";
  const r1 = textOf(await call("form_input", { tabId, ref: await refOf("Corps du message"), value: body }));
  console.log(r1);
  assert.ok(/CKEditor 5 \(setData\)/.test(r1), "API de l'éditeur utilisée");
  assert.strictEqual((await js("document.getElementById('ed').innerHTML")).trim(), "<p>Salut Neva,</p><p>Voici le PDF.<br>À bientôt,</p><p>Louis</p>", "vrais paragraphes, aucun paragraphe vide");
  assert.strictEqual((await js("String(window.__wildInput || 0)")).trim(), "0", "aucun insertText sauvage dans l'éditeur");
  const r1b = textOf(await call("form_input", { tabId, ref: await refOf("Corps du message"), value: "Liste :\n\n1. un\n2. **deux**\n\n- a\n- b", format: "markdown" }));
  assert.ok(/CKEditor 5/.test(r1b), "markdown aussi par l'API");
  assert.strictEqual((await js("document.getElementById('ed').innerHTML")).trim(), "<p>Liste :</p><ol><li>un</li><li><strong>deux</strong></li></ol><ul><li>a</li><li>b</li></ul>", "markdown converti en listes et gras");
  const r1c = textOf(await call("form_input", { tabId, ref: await refOf("Corps du message"), value: "<p>brut</p>", format: "html" }));
  assert.ok(/CKEditor 5/.test(r1c));
  assert.strictEqual((await js("document.getElementById('ed').innerHTML")).trim(), "<p>brut</p>", "html tel quel");

  console.log("\n2. Champ destinataire à puces...");
  const r2 = textOf(await call("form_input", { tabId, ref: await refOf("Ajouter un destinataire"), value: "neva.aygun@univ-rouen.fr" }));
  console.log(r2);
  assert.ok(/suggestion choisie/.test(r2), "suggestion choisie");
  assert.strictEqual((await js("document.querySelector('#chips .chip')?.textContent || ''")).trim(), "Neva Aygun <neva.aygun@univ-rouen.fr>", "puce créée avec la bonne personne");
  assert.strictEqual((await js("document.querySelectorAll('#chips .chip').length")).trim(), "1", "une seule puce");

  console.log("\n3. Effet tardif...");
  const r3 = textOf(await call("computer", { tabId, action: "left_click", ref: await refOf("Actualiser") }));
  console.log(r3);
  assert.ok(!/Effet : inchangé/.test(r3), "l'effet tardif est constaté");
  assert.ok(/Effet : .*(car\.|texte)/.test(r3), "le changement de texte est rapporté");

  console.log("\n4. navigate vers un #fragment non suivi...");
  const r4 = textOf(await call("navigate", { tabId, url: "#!/Drafts" }));
  console.log(r4);
  assert.ok(/routeur de la page n'avait pas suivi|lien « Brouillons »/.test(r4), "repli sur le clic annoncé");
  assert.ok((await js("document.getElementById('view').textContent")).includes("Brouillons : 14"), "la vue a changé");

  console.log("\n5. file_upload attend la fin de l'envoi...");
  const dir = mkdtempSync(join(tmpdir(), "abc-up-"));
  const file = join(dir, "planche-test.pdf");
  writeFileSync(file, "%PDF-1.4 test");
  const upRef = (textOf(await call("find", { tabId, query: "css:#up" })).match(/\[(ref_\d+)\]/) ?? [])[1];
  assert.ok(upRef, "ref du champ fichier");
  const r5 = textOf(await call("file_upload", { tabId, ref: upRef, paths: [file] }));
  console.log(r5);
  assert.ok(/nom\(s\) visible\(s\) dans la page/.test(r5), "le nom du fichier est visible à la fin de l'attente");

  console.log("\n6. diff : fond masqué par une modale...");
  await call("read_page", { tabId, filter: "interactive" });
  await js("document.getElementById('bg').style.display = 'none'; 'ok'");
  const r6 = textOf(await call("read_page", { tabId, filter: "interactive", diff: true }));
  const removedLines = r6.split("\n").filter((l) => l.startsWith("- ")).length;
  console.log(r6.split("\n").slice(0, 6).join("\n"));
  assert.ok(removedLines <= 26, `retraits plafonnés (${removedLines} lignes listées)`);
  assert.ok(/retrait\(s\) non listé\(s\)/.test(r6), "le reste est compté, pas listé");
  await js("document.getElementById('bg').style.display = ''; 'ok'");

  console.log("\n7. Ref périmée d'un bouton destructif : refus + ref actuelle...");
  const sendRef = await refOf("Envoyer");
  await js(`(() => { const old = document.getElementById('envoyer'); const c = old.parentElement;
    const neu = document.createElement('button'); neu.id = 'envoyer'; neu.textContent = 'Envoyer';
    c.insertBefore(Object.assign(document.createElement('p'), { textContent: 'Autre message, autre destinataire, contexte entièrement différent' }), old);
    neu.removeAttribute('id'); const twin = neu.cloneNode(true); old.replaceWith(neu); c.appendChild(twin); return 'ok'; })()`);
  const stale = (await call("computer", { tabId, action: "left_click", ref: sendRef })) as Res;
  const staleText = all(stale);
  console.log(staleText.slice(0, 300));
  assert.strictEqual(stale.isError, true, "deux boutons « Envoyer » possibles : on ne devine pas");
  assert.ok(/Éléments actuels de même nom \(2\)/.test(staleText), "le refus liste les deux candidats");
  const fresh = [...staleText.matchAll(/ref_\d+/g)].map((m) => m[0]).filter((r) => r !== sendRef);
  assert.ok(fresh.length >= 2, "avec leurs refs actuelles");
  const ok2 = (await call("computer", { tabId, action: "left_click", ref: fresh[0] })) as Res;
  assert.strictEqual(ok2.isError, undefined, "la ref proposée est utilisable telle quelle");

  console.log("\n✅ TOUS LES TESTS E2E WEBMAIL ONT RÉUSSI !");
} finally {
  for (const id of created) await call("tabs_close", { tabId: id }).catch(() => {});
  await client.close();
}
