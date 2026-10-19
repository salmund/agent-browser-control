/**
 * Test end-to-end de la reprise browser_script (ST11) :
 * 1. un script échoue côté script après 2 appels : point de reprise annoncé (trace + from) ;
 * 2. le code corrigé reprend : les appels déjà réussis sont rejoués sans ré-exécution
 *    (compteur page inchangé) et le script se termine ;
 * 3. trace inconnue : erreur claire.
 *
 * Lancer avec : node test/e2e-script-resume.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-script-resume-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de reprise browser_script ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const created: number[] = [];
try {
  console.log("\n1. Création de l'onglet...");
  const createRes = await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } });
  const tabId = Number(textOf(createRes).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);

  console.log("\n2. Script en échec après 2 appels...");
  const failed = (await client.callTool({
    name: "browser_script",
    arguments: {
      tabId,
      code: `const a = await js('window.__c = (window.__c || 0) + 1');
const b = await js('window.__c = (window.__c || 0) + 10');
throw new Error('BOUM-APRES-2-APPELS');
return [a, b];`,
    },
  })) as unknown as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(failed.isError, true, "échec remonté");
  const failText = failed.content.map((b) => b.text ?? "").join("\n");
  console.log(failText);
  assert.ok(failText.includes("BOUM-APRES-2-APPELS"), "erreur du script");
  assert.ok(failText.includes("après 2 appel(s)"), "compte des appels réussis");
  const trace = failText.match(/trace: "(script_\w+)"/)?.[1];
  const from = Number(failText.match(/from: (\d+)/)?.[1]);
  assert.ok(trace, "trace annoncée");
  assert.strictEqual(from, 3, "reprise depuis l'appel 3");

  console.log("\n3. Reprise avec le code corrigé (pas de ré-exécution)...");
  const resumed = textOf(
    await client.callTool({
      name: "browser_script",
      arguments: {
        tabId,
        resume: { trace, from },
        code: `const a = await js('window.__c = (window.__c || 0) + 1');
const b = await js('window.__c = (window.__c || 0) + 10');
const c = await js('window.__c');
return { a, b, c };`,
      },
    }),
  );
  console.log(resumed);
  assert.ok(resumed.includes("1 rejoué(s)") || resumed.includes("2 rejoué(s)"), "rejeu annoncé");
  assert.ok(resumed.includes('"a": 1'), "appel 1 rejoué (valeur enregistrée)");
  assert.ok(resumed.includes('"b": 11'), "appel 2 rejoué (valeur enregistrée)");
  assert.ok(resumed.includes('"c": 11'), "compteur inchangé : aucune ré-exécution");

  console.log("\n4. Trace inconnue : erreur claire...");
  const bad = (await client.callTool({
    name: "browser_script",
    arguments: { tabId, resume: { trace: "script_999999", from: 1 }, code: "return 1;" },
  })) as unknown as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(bad.isError, true, "erreur remontée");
  assert.ok(bad.content.map((b) => b.text ?? "").join("\n").includes("expirée ou inconnue"), "diagnostic");

  console.log("\n✅ TOUS LES TESTS E2E DE REPRISE BROWSER_SCRIPT ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
