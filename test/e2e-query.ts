/**
 * Test end-to-end de query + sorties fichier (P2) :
 * 1. countOnly : compter sans renvoyer.
 * 2. Filtres contains / regex calculés dans la page.
 * 3. Projections attrs / aria + pagination limit/offset.
 * 4. Gros volume query (>40k) : JSON complet en fichier + aperçu.
 * 5. Gros résultat javascript (>50k) : texte complet en fichier, plus de troncature sèche.
 *
 * Lancer avec : node test/e2e-query.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-query-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de query ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
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
        for (let i = 1; i <= 300; i++) {
          const d = document.createElement("div");
          d.className = "q";
          d.id = "q" + i;
          d.setAttribute("data-kind", i % 2 ? "impair" : "pair");
          d.setAttribute("aria-label", "aria-" + i);
          d.textContent = "Enregistrement " + i;
          document.body.appendChild(d);
        }
        for (let i = 1; i <= 400; i++) {
          const d = document.createElement("div");
          d.className = "qlong";
          d.textContent = "Longue ligne " + i + " " + "z".repeat(140);
          document.body.appendChild(d);
        }
        return "fixture-ok";
      })()`,
    },
  });

  console.log("\n2. countOnly...");
  const count = textOf(await client.callTool({ name: "query", arguments: { tabId, selector: ".q", countOnly: true } }));
  console.log(count.split("\n")[1] ?? count);
  assert.ok(count.includes("300 correspondance(s)"), "total exact");
  assert.ok(!count.includes("Enregistrement 1\n"), "rien renvoyé");

  console.log("\n3. Filtres contains / regex...");
  const contains = textOf(await client.callTool({ name: "query", arguments: { tabId, selector: ".q", filter: { contains: "Enregistrement 1" }, countOnly: true } }));
  assert.ok(contains.includes("111 correspondance(s)"), `contains exact (reçu : ${contains.slice(0, 120)})`);
  const regex = textOf(await client.callTool({ name: "query", arguments: { tabId, selector: ".q", filter: { regex: "^Enregistrement 1\\d$" }, countOnly: true } }));
  assert.ok(regex.includes("10 correspondance(s)"), `regex exact (reçu : ${regex.slice(0, 120)})`);

  console.log("\n4. Projections attrs / aria + pagination...");
  const attrs = textOf(await client.callTool({ name: "query", arguments: { tabId, selector: ".q", extract: { attrs: ["id", "data-kind"] }, limit: 2 } }));
  assert.ok(attrs.includes('"id":"q1"') && attrs.includes('"data-kind":"impair"'), "attributs projetés");
  const aria = textOf(await client.callTool({ name: "query", arguments: { tabId, selector: ".q", extract: "aria", limit: 1 } }));
  assert.ok(aria.includes("aria-1"), "aria-label projeté");
  const page = textOf(await client.callTool({ name: "query", arguments: { tabId, selector: ".q", limit: 5, offset: 295 } }));
  assert.ok(page.includes("Enregistrement 296") && page.includes("Enregistrement 300"), "page 296-300");
  assert.ok(!page.includes("Tronqué par limit/offset"), "pas de troncature en fin exacte");

  console.log("\n5. Gros volume query : fichier JSON complet...");
  const big = textOf(await client.callTool({ name: "query", arguments: { tabId, selector: ".qlong", limit: 500 } }));
  assert.ok(big.includes("400 correspondance(s)"), "400 comptés");
  const m = big.match(/fichier : (.+\.json)/);
  assert.ok(m, "chemin du fichier JSON présent");
  assert.ok(existsSync(m[1].trim()), "fichier écrit");
  const parsed = JSON.parse(readFileSync(m[1].trim(), "utf8")) as { items: string[] };
  assert.strictEqual(parsed.items.length, 400, "400 items dans le fichier");
  assert.ok(parsed.items[399].includes("Longue ligne 400"), "dernier item intact");

  console.log("\n6. Gros résultat javascript : fichier texte complet...");
  const js = textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: '"y".repeat(60000)' } }));
  assert.ok(!js.includes("[Tronqué]"), "plus de troncature sèche");
  assert.ok(js.includes("60000 caractères"), "taille annoncée");
  const mj = js.match(/fichier : (.+\.txt)/);
  assert.ok(mj, "chemin du fichier texte présent");
  assert.ok(existsSync(mj[1].trim()), "fichier écrit");
  assert.strictEqual(readFileSync(mj[1].trim(), "utf8").length, 60000, "contenu complet");

  console.log("\n✅ TOUS LES TESTS E2E DE QUERY ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
