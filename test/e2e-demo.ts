/**
 * Test end-to-end du mode démonstration (SG16) :
 * 1. start, clic + saisie + mot de passe (via computer, événements de confiance),
 *    stop : étapes, mot de passe masqué, code rejouable, note suggérée ;
 * 2. navigation pendant l'enregistrement : URL conservée, détail perdu (noté) ;
 * 3. erreurs : double start, stop sans start, action inconnue.
 *
 * Lancer avec : node test/e2e-demo.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-demo-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E du mode démonstration ===");

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
          '<button id="btn-demo">Bouton Demo Clic</button>' +
          '<input id="champ-demo" type="text" aria-label="Champ Demo">' +
          '<input id="mdp-demo" type="password" aria-label="Mot de passe Demo">';
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
  const btn = await refOf("Bouton Demo Clic");
  const champ = await refOf("Champ Demo");
  const mdp = await refOf("Mot de passe Demo");

  console.log("\n2. start + parcours + stop...");
  const started = textOf(await client.callTool({ name: "demo", arguments: { tabId, action: "start" } }));
  assert.ok(started.includes("Enregistrement démarré"), "démarrage annoncé");
  textOf(await client.callTool({ name: "computer", arguments: { tabId, action: "left_click", ref: btn } }));
  textOf(await client.callTool({ name: "computer", arguments: { tabId, action: "type", ref: champ, text: "texte-demo-123" } }));
  textOf(await client.callTool({ name: "computer", arguments: { tabId, action: "type", ref: mdp, text: "secret-ne-pas-lire" } }));
  const stopped = textOf(await client.callTool({ name: "demo", arguments: { tabId, action: "stop" } }));
  console.log(stopped.split("\n").slice(0, 8).join("\n") + "\n...");
  assert.ok(stopped.includes("Clic") && stopped.includes("Bouton Demo Clic"), "clic enregistré");
  assert.ok(stopped.includes("texte-demo-123"), "saisie enregistrée");
  assert.ok(stopped.includes("masqué") && !stopped.includes("secret-ne-pas-lire"), "mot de passe masqué");
  assert.ok(stopped.includes("```js") && stopped.includes("await clic("), "code rejouable");
  assert.ok(stopped.includes("save_macro"), "piste d'enregistrement");

  console.log("\n3. Navigation pendant l'enregistrement...");
  textOf(await client.callTool({ name: "demo", arguments: { tabId, action: "start" } }));
  textOf(await client.callTool({ name: "navigate", arguments: { tabId, url: "https://example.org" } }));
  const navStop = textOf(await client.callTool({ name: "demo", arguments: { tabId, action: "stop" } }));
  assert.ok(navStop.includes("Navigation : https://example.org"), "URL conservée");

  console.log("\n4. Erreurs...");
  textOf(await client.callTool({ name: "demo", arguments: { tabId, action: "start" } }));
  const dbl = (await client.callTool({ name: "demo", arguments: { tabId, action: "start" } })) as unknown as {
    isError?: true;
    content: { type: string; text?: string }[];
  };
  assert.strictEqual(dbl.isError, true, "double start refusé");
  textOf(await client.callTool({ name: "demo", arguments: { tabId, action: "stop" } }));
  const nostop = (await client.callTool({ name: "demo", arguments: { tabId, action: "stop" } })) as unknown as {
    isError?: true;
    content: { type: string; text?: string }[];
  };
  assert.strictEqual(nostop.isError, true, "stop sans start refusé");
  const bad = (await client.callTool({ name: "demo", arguments: { tabId, action: "pause" } })) as unknown as {
    isError?: true;
    content: { type: string; text?: string }[];
  };
  assert.strictEqual(bad.isError, true, "action inconnue refusée");

  console.log("\n✅ TOUS LES TESTS E2E DU MODE DÉMONSTRATION ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
