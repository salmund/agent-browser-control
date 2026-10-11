/**
 * Test end-to-end du batch computer steps + digest (P6) :
 * 1. Trois actions en un appel, digest initial + delta par étape (croissance détectée).
 * 2. Arrêt à la première erreur, sans exécuter la suite (prouvé par le temps).
 * 3. 'screenshot' refusé en étape.
 *
 * Lancer avec : node test/e2e-computer-steps.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-computer-steps-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E du batch computer ===");

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
        let n = 0;
        const timer = setInterval(() => {
          n++;
          const d = document.createElement("div");
          d.className = "grow";
          d.textContent = "contenu qui pousse numéro " + n + " avec du texte en plus";
          document.body.appendChild(d);
          if (n >= 3) clearInterval(timer);
        }, 500);
        const spacer = document.createElement("div");
        spacer.style.height = "300vh";
        document.body.appendChild(spacer);
        const b = document.createElement("button");
        b.id = "bas";
        b.textContent = "Bouton du bas";
        document.body.appendChild(b);
        return "fixture-ok";
      })()`,
    },
  });
  const tree = textOf(await client.callTool({ name: "read_page", arguments: { tabId, filter: "interactive" } }));
  const refBas = tree.match(/"Bouton du bas"\s*\[(ref_\d+)\]/)?.[1];
  assert.ok(refBas, "ref du bouton du bas");

  console.log("\n2. Batch de 3 actions en un appel, avec deltas...");
  const batch = textOf(await client.callTool({
    name: "computer",
    arguments: { tabId, steps: [{ action: "scroll_to", ref: refBas }, { action: "wait", duration: 1 }, { action: "wait", duration: 2 }] },
  }));
  console.log(batch);
  assert.ok(batch.includes("Digest initial"), "digest initial présent");
  assert.ok(batch.includes("Étape 1/3 [scroll_to"), "étape 1");
  assert.ok(batch.includes("Étape 2/3 [wait]"), "étape 2");
  assert.ok(batch.includes("Étape 3/3 [wait]"), "étape 3");
  assert.ok(/\+\d+ car\./.test(batch), "croissance du texte détectée dans un delta");

  console.log("\n3. Arrêt à la première erreur (la suite ne tourne pas)...");
  const t0 = Date.now();
  const bad = await client.callTool({
    name: "computer",
    arguments: { tabId, steps: [{ action: "wait", duration: 1 }, { action: "action_inexistante" }, { action: "wait", duration: 5 }] },
  }) as unknown as { isError?: true; content: { type: string; text?: string }[] };
  const elapsed = Date.now() - t0;
  const badText = bad.content.map((b) => b.text ?? "").join("\n");
  console.log(badText);
  console.log(`durée : ${(elapsed / 1000).toFixed(1)} s`);
  assert.strictEqual(bad.isError, true, "batch en erreur");
  assert.ok(badText.includes("ÉCHEC"), "échec signalé");
  assert.ok(badText.includes("1 étape(s) déjà exécutée(s)"), "compte des étapes exécutées");
  assert.ok(elapsed < 4500, `le wait 5 n'a pas tourné (${elapsed} ms) : arrêt immédiat`);

  console.log("\n4. Screenshot refusé en étape...");
  const shot = await client.callTool({
    name: "computer",
    arguments: { tabId, steps: [{ action: "screenshot" }] },
  }) as unknown as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(shot.isError, true, "batch en erreur");
  assert.ok(shot.content.map((b) => b.text ?? "").join("\n").includes("interdit"), "raison claire");

  console.log("\n✅ TOUS LES TESTS E2E DU BATCH COMPUTER ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
