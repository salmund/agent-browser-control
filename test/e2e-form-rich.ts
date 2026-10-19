/**
 * Test end-to-end de form_input sur éditeurs riches (ST13) :
 * 1. contenteditable simple : rempli, stratégie annoncée, contenu vérifié ;
 * 2. texte long multi-paragraphes (> 200 car.) : rempli et vérifié ;
 * 3. éditeur de code (CodeMirror) : échec net avec redirection vers computer ;
 * 4. non-régression : input texte classique.
 *
 * Lancer avec : node test/e2e-form-rich.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-form-rich-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de form_input éditeurs riches ===");

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
        document.body.innerHTML =
          '<div id="ed" contenteditable="true" aria-label="Zone riche"></div>' +
          '<div class="cm-content" id="cm" contenteditable="true" aria-label="Code"></div>' +
          '<input id="cls" type="text" aria-label="Classique">';
        return "fixture-ok";
      })()`,
    },
  });
  const refOf = async (label: string): Promise<string> => {
    const found = textOf(await client.callTool({ name: "find", arguments: { tabId, query: label } }));
    const ref = found.match(/\[(ref_\d+)\]/)?.[1];
    assert.ok(ref, `ref pour ${label}`);
    return ref;
  };

  console.log("\n2. contenteditable simple...");
  const filled = textOf(await client.callTool({ name: "form_input", arguments: { tabId, ref: await refOf("Zone riche"), value: "Bonjour riche" } }));
  console.log(filled);
  assert.ok(filled.includes("éditeur riche"), "stratégie annoncée");
  const check = textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: "document.getElementById('ed').textContent" } }));
  assert.ok(check.includes("Bonjour riche"), "contenu posé");

  console.log("\n3. Texte long multi-paragraphes...");
  const long = Array.from({ length: 12 }, (_, i) => `paragraphe ${i + 1} avec du contenu pour dépasser les seuils`).join("\n");
  assert.ok(long.length > 200, "fixture > 200 car.");
  textOf(await client.callTool({ name: "form_input", arguments: { tabId, ref: await refOf("Zone riche"), value: long } }));
  const checkLong = textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: "document.getElementById('ed').textContent" } }));
  assert.ok(checkLong.includes("paragraphe 1") && checkLong.includes("paragraphe 12"), "tout le texte posé");

  console.log("\n4. CodeMirror : échec net...");
  const cm = (await client.callTool({ name: "form_input", arguments: { tabId, ref: await refOf("Code"), value: "x" } })) as unknown as {
    isError?: true;
    content: { type: string; text?: string }[];
  };
  assert.strictEqual(cm.isError, true, "échec remonté");
  assert.ok(cm.content.map((b) => b.text ?? "").join("\n").includes("computer"), "redirection vers computer");

  console.log("\n5. Non-régression input classique...");
  textOf(await client.callTool({ name: "form_input", arguments: { tabId, ref: await refOf("Classique"), value: "abc" } }));
  const checkCls = textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: "document.getElementById('cls').value" } }));
  assert.ok(checkCls.includes("abc"), "input rempli");

  console.log("\n✅ TOUS LES TESTS E2E DE FORM_INPUT RICHES ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
