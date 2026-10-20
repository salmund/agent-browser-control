/**
 * Test end-to-end des gestes silencieux (clics par événements, sans passer l'onglet devant) :
 * 1. Un clic sur un bouton d'un onglet en arrière-plan part par événements (isTrusted faux, réponse « silencieux »),
 *    l'onglet de l'agent ne devient pas l'onglet actif, l'effet est constaté.
 * 2. Une case à cocher bascule une seule fois (pas de double clic).
 * 3. type dans un champ : focus sans clic, texte saisi.
 * 4. silent: false impose un vrai clic (isTrusted vrai).
 * 5. Éléments qui exigent un vrai clic (champ fichier, lien target=_blank) : pas de clic silencieux, repli sur le vrai geste.
 * 6. Un clic silencieux sans effet porte l'indice « silent: false ».
 * 7. Étapes : un enchaînement de clics silencieux reste en arrière-plan.
 *
 * Lancer avec : node test/e2e-silent-gestures.ts (extension rechargée + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-silent-gestures-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E gestes silencieux ===");

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
      '<button id="b1">Compter un clic</button><div id="out">0</div><div id="trusted">-</div>',
      '<label><input id="cb" type="checkbox"> Recevoir la lettre</label><div id="cbn">0</div>',
      '<input id="champ" type="text" aria-label="Zone de saisie">',
      '<input id="up" type="file" aria-label="Pièce jointe">',
      '<a id="lien" href="https://example.com/?x=1" target="_blank">Ouvrir ailleurs</a>',
      '<button id="muet">Bouton muet</button>',
      '<button id="s1">Alpha</button><button id="s2">Omega</button><div id="steps"></div>',
    ].join("");
    let n = 0, cb = 0;
    document.getElementById("b1").addEventListener("click", (e) => { n++; document.getElementById("out").textContent = String(n); document.getElementById("trusted").textContent = e.isTrusted ? "vrai" : "faux"; });
    document.getElementById("cb").addEventListener("change", () => { cb++; document.getElementById("cbn").textContent = String(cb); });
    for (const id of ["s1", "s2"]) document.getElementById(id).addEventListener("click", () => { document.getElementById("steps").textContent += id; });
    return "ok";
  })()`);
  const refOf = async (label: string): Promise<string> => {
    const found = textOf(await call("find", { tabId, query: label }));
    const ref = found.match(/\[(ref_\d+)\]/)?.[1];
    assert.ok(ref, `ref pour ${label}`);
    return ref;
  };
  const notActive = async () => {
    const ctx = textOf(await call("tabs_context", {}));
    assert.ok(!ctx.includes(`tabId ${tabId} (actif`), "l'onglet de l'agent n'est pas passé devant : " + ctx.slice(0, 200));
  };

  console.log("\n1. Clic silencieux...");
  const r1 = textOf(await call("computer", { tabId, action: "left_click", ref: await refOf("Compter un clic") }));
  console.log(r1);
  assert.ok(/silencieux/.test(r1), "réponse silencieuse");
  assert.strictEqual(await js("document.getElementById('out').textContent"), "1", "un seul clic");
  assert.strictEqual(await js("document.getElementById('trusted').textContent"), "faux", "événements synthétiques (isTrusted faux)");
  assert.ok(/Effet : /.test(r1) && !/Effet : inchangé/.test(r1), "effet constaté");
  await notActive();

  console.log("\n2. Case à cocher...");
  await call("computer", { tabId, action: "left_click", ref: await refOf("Recevoir la lettre") });
  assert.strictEqual(await js("document.getElementById('cbn').textContent"), "1", "basculée une seule fois");
  assert.strictEqual(await js("String(document.getElementById('cb').checked)"), "true");

  console.log("\n3. type dans un champ...");
  const r3 = textOf(await call("computer", { tabId, action: "type", ref: await refOf("Zone de saisie"), text: "Bonjour" }));
  console.log(r3);
  assert.strictEqual(await js("document.getElementById('champ').value"), "Bonjour", "texte saisi");
  await notActive();

  console.log("\n4. silent: false...");
  const r4 = textOf(await call("computer", { tabId, action: "left_click", ref: await refOf("Compter un clic"), silent: false }));
  console.log(r4);
  assert.ok(!/silencieux/.test(r4), "pas de clic silencieux");
  assert.strictEqual(await js("document.getElementById('trusted').textContent"), "vrai", "vrai clic (isTrusted vrai)");

  console.log("\n5. Éléments qui exigent un vrai clic...");
  const r5 = textOf(await call("computer", { tabId, action: "left_click", ref: await refOf("Ouvrir ailleurs") }));
  console.log(r5);
  assert.ok(!/silencieux/.test(r5), "lien target=_blank : vrai clic");
  assert.ok(/onglet\(s\) ouvert\(s\)|tabId/.test(r5), "l'onglet ouvert est signalé");

  console.log("\n6. Clic silencieux sans effet : indice...");
  const r6 = textOf(await call("computer", { tabId, action: "left_click", ref: await refOf("Bouton muet") }));
  console.log(r6);
  assert.ok(/silencieux/.test(r6) && /silent: false/.test(r6), "indice donné");

  console.log("\n7. Étapes silencieuses...");
  const r7 = textOf(await call("computer", {
    tabId,
    steps: [{ action: "left_click", target: "Alpha" }, { action: "left_click", target: "Omega" }],
  }));
  console.log(r7);
  assert.strictEqual(await js("document.getElementById('steps').textContent"), "s1s2", "deux clics, dans l'ordre");
  assert.ok((r7.match(/silencieux/g) ?? []).length >= 2, "les deux étapes en silence");
  await notActive();

  console.log("\n✅ TOUS LES TESTS E2E GESTES SILENCIEUX ONT RÉUSSI !");
} finally {
  for (const id of created) await call("tabs_close", { tabId: id }).catch(() => {});
  await client.close();
}
