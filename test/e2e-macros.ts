/**
 * Test end-to-end des macros site_api (ST9) : save_macro / list / delete (kind=macro),
 * plus le câblage de suggest_macros (pas d'erreur, réponse textuelle).
 * La fouille elle-même est couverte par test/macros.ts (déterministe).
 *
 * Lancer avec : node test/e2e-macros.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-macros-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E des macros ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const SITE = "e2e-macros-test.invalid";
try {
  console.log("\n1. save_macro...");
  const saved = textOf(
    await client.callTool({
      name: "site_api",
      arguments: { action: "save_macro", site: SITE, name: "tournee-test", code: 'await nav("https://example.com");\nreturn "macro-ok";' },
    }),
  );
  console.log(saved);
  assert.ok(saved.includes("tournee-test"), "macro enregistrée");

  console.log("\n2. list la montre...");
  const list = textOf(await client.callTool({ name: "site_api", arguments: { action: "list" } }));
  assert.ok(list.includes(SITE) && list.includes("tournee-test"), "macro listée");
  assert.ok(list.includes("await nav("), "étapes listées");

  console.log("\n3. Réenregistrer écrase...");
  textOf(
    await client.callTool({
      name: "site_api",
      arguments: { action: "save_macro", site: SITE, name: "tournee-test", code: 'await text();\nreturn "v2";' },
    }),
  );
  const list2 = textOf(await client.callTool({ name: "site_api", arguments: { action: "list" } }));
  assert.ok(list2.includes("await text();"), "code mis à jour");
  assert.ok(!list2.includes("await nav("), "ancien code remplacé");

  console.log("\n4. delete kind=macro...");
  const del = textOf(await client.callTool({ name: "site_api", arguments: { action: "delete", kind: "macro", site: SITE, name: "tournee-test" } }));
  assert.ok(del.includes("supprimé"), "macro supprimée");
  const list3 = textOf(await client.callTool({ name: "site_api", arguments: { action: "list" } }));
  assert.ok(!list3.includes("tournee-test"), "macro partie");

  console.log("\n5. save_macro invalide : erreur claire...");
  const bad = (await client.callTool({ name: "site_api", arguments: { action: "save_macro", site: SITE, name: "", code: "" } })) as unknown as {
    isError?: true;
    content: { type: string; text?: string }[];
  };
  assert.strictEqual(bad.isError, true, "erreur remontée");

  console.log("\n6. suggest_macros : câblage (contenu non déterministe)...");
  const sug = textOf(await client.callTool({ name: "site_api", arguments: { action: "suggest_macros", minOccurs: 1000000000 } }));
  assert.ok(sug.includes("Aucune séquence répétée"), "fouille vide avec seuil absurde");
  const sug2 = textOf(await client.callTool({ name: "site_api", arguments: { action: "suggest_macros" } }));
  assert.ok(sug2.length > 20, "réponse textuelle");

  console.log("\n✅ TOUS LES TESTS E2E DES MACROS ONT RÉUSSI !");
} finally {
  await client.callTool({ name: "site_api", arguments: { action: "delete", kind: "macro", site: SITE, name: "tournee-test" } }).catch(() => {});
  await client.close();
}
