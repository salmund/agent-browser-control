/**
 * Test end-to-end des surveillances (SG15) :
 * 1. declare texte présent : armée, état initial « déjà vraie », sans déclencher ;
 * 2. check : DÉCLENCHÉE ;
 * 3. declare texte absent : armée, check sans déclencher ;
 * 4. declare sélecteur + js : check déclenche ;
 * 5. list/validations/cancel.
 *
 * Lancer avec : node test/e2e-watch.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-watch-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E des surveillances ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const created: number[] = [];
const watches: string[] = [];
try {
  console.log("\n0. Ménage (les orphelines d'un run interrompu sont persistantes)...");
  const pre = textOf(await client.callTool({ name: "watch", arguments: { action: "list" } }));
  for (const m of pre.matchAll(/^-\s+(w\S+)/gm)) {
    await client.callTool({ name: "watch", arguments: { action: "cancel", id: m[1] } }).catch(() => {});
  }

  console.log("\n1. Création de l'onglet...");
  const createRes = await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } });
  const tabId = Number(textOf(createRes).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);

  console.log("\n2. Fixture injectée (pas de dépendance au DOM d'example.com)...");
  const fix = textOf(
    await client.callTool({
      name: "javascript",
      arguments: { tabId, code: `document.body.innerHTML = '<h1>Guet Titre ABC</h1><p>signature-watch-xyz</p>'; 'fixture-ok'` },
    }),
  );
  assert.ok(fix.includes("fixture-ok"), "fixture posée");

  console.log("\n3. declare texte présent (pas de déclenchement initial)...");
  const d1 = textOf(await client.callTool({ name: "watch", arguments: { action: "declare", tabId, text: "signature-watch-xyz", interval: 3600, name: "w-texte" } }));
  console.log(d1.split("\n")[0]);
  const id1 = d1.match(/Surveillance (w\S+) /)?.[1];
  assert.ok(id1, "id renvoyé");
  watches.push(id1);
  assert.ok(d1.includes("armée"), "armée");
  assert.ok(d1.includes("déjà vraie"), "état initial constaté");

  console.log("\n4. check : déclenchée...");
  const c1 = textOf(await client.callTool({ name: "watch", arguments: { action: "check", id: id1 } }));
  assert.ok(c1.includes("triggered"), "état déclenché");
  assert.ok(c1.includes("signature-watch-xyz"), "valeur vue");

  console.log("\n5. Texte absent : armée, check sans déclencher...");
  const d2 = textOf(await client.callTool({ name: "watch", arguments: { action: "declare", tabId, text: "zzz-absent-zzz", interval: 3600 } }));
  const id2 = d2.match(/Surveillance (w\S+) /)?.[1];
  assert.ok(id2, "id 2 renvoyé");
  watches.push(id2);
  assert.ok(d2.includes("condition absente"), "état initial absent");
  const c2 = textOf(await client.callTool({ name: "watch", arguments: { action: "check", id: id2 } }));
  assert.ok(!c2.includes("triggered"), "pas de déclenchement");

  console.log("\n6. Sélecteur + js...");
  const d3 = textOf(await client.callTool({ name: "watch", arguments: { action: "declare", tabId, selector: "h1", interval: 3600 } }));
  watches.push(d3.match(/Surveillance (w\S+) /)?.[1] as string);
  const c3 = textOf(await client.callTool({ name: "watch", arguments: { action: "check", id: watches[2] } }));
  assert.ok(c3.includes("triggered"), "sélecteur déclenche");
  const d4 = textOf(await client.callTool({ name: "watch", arguments: { action: "declare", tabId, js: "document.title", interval: 3600 } }));
  watches.push(d4.match(/Surveillance (w\S+) /)?.[1] as string);
  const c4 = textOf(await client.callTool({ name: "watch", arguments: { action: "check", id: watches[3] } }));
  assert.ok(c4.includes("triggered"), "js déclenche");

  console.log("\n7. list + validations...");
  const list = textOf(await client.callTool({ name: "watch", arguments: { action: "list" } }));
  assert.ok(list.includes("w-texte"), "listée");
  const bad = (await client.callTool({ name: "watch", arguments: { action: "declare", tabId, text: "a", selector: "b" } })) as unknown as {
    isError?: true;
    content: { type: string; text?: string }[];
  };
  assert.strictEqual(bad.isError, true, "deux conditions refusées");
  const unknown = (await client.callTool({ name: "watch", arguments: { action: "check", id: "wzzz" } })) as unknown as {
    isError?: true;
    content: { type: string; text?: string }[];
  };
  assert.strictEqual(unknown.isError, true, "id inconnu refusé");

  console.log("\n8. cancel...");
  for (const id of watches) {
    const done = textOf(await client.callTool({ name: "watch", arguments: { action: "cancel", id } }));
    assert.ok(done.includes("supprimée"), `cancel ${id}`);
  }
  watches.length = 0;
  const empty = textOf(await client.callTool({ name: "watch", arguments: { action: "list" } }));
  assert.ok(empty.includes("Aucune surveillance"), "liste vide");

  console.log("\n✅ TOUS LES TESTS E2E DES SURVEILLANCES ONT RÉUSSI !");
} finally {
  for (const id of watches) {
    await client.callTool({ name: "watch", arguments: { action: "cancel", id } }).catch(() => {});
  }
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
