/**
 * Test end-to-end de wait_for settle + diagnostic (QW2) :
 * 1. settle: true sur une page statique : résolu vite, avec le détail « page stabilisée ».
 * 2. timeout sur un texte impossible : erreur qui détaille l'observé (URL, réseau, DOM, texte).
 * 3. page locale avec un indicateur de chargement figé et un carrousel qui change de classe toutes les
 *    100 ms : settle aboutit quand même (indicateur ignoré, animation sans effet sur la stabilité) ;
 *    le libellé de chargement du diagnostic garde ses « s ».
 *
 * Lancer avec : node test/e2e-wait-settle.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Indicateur qui ne disparaît jamais, carrousel animé par ses classes : rien de tout ça n'est un chargement en cours.
const FIGEE = `<!doctype html><html><head><title>Indicateur figé</title></head><body>
<div class="loading-spinner">Chargement des sessions</div>
<div id="carrousel" class="diapo-0">Diaporama</div>
<script>
let i = 0;
setInterval(() => { document.getElementById("carrousel").className = "diapo-" + (++i % 5); }, 100);
</script></body></html>`;
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(FIGEE);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const client = new Client({ name: "e2e-wait-settle-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de wait_for settle/diagnostic ===");

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

  console.log("\n2. settle sur une page statique...");
  const settled = textOf(await client.callTool({ name: "wait_for", arguments: { tabId, settle: true, timeout: 15 } }));
  console.log(settled.split("\n")[0]);
  assert.ok(settled.includes("Condition remplie"), "settle résolu");
  assert.ok(settled.includes("stabilisée"), "détail de stabilisation annoncé");

  console.log("\n3. timeout avec diagnostic...");
  const res = (await client.callTool({
    name: "wait_for",
    arguments: { tabId, text: "texte qui n'existe nulle part 8f3a29", timeout: 1.5 },
  })) as unknown as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(res.isError, true, "le timeout reste une erreur");
  const diag = res.content.map((b) => b.text ?? "").join("\n");
  console.log(diag);
  assert.ok(diag.includes("Délai dépassé"), "mention du délai");
  assert.ok(diag.includes("URL actuelle"), "URL observée");
  assert.ok(diag.includes("Réseau :"), "état réseau observé");
  assert.ok(diag.includes("DOM :"), "état DOM observé");
  assert.ok(diag.includes("Texte :"), "état texte observé");

  console.log("\n4. Indicateur figé et carrousel animé...");
  await client.callTool({ name: "navigate", arguments: { tabId, url: `http://127.0.0.1:${port}/figee` } });
  const t0 = Date.now();
  const figee = textOf(await client.callTool({ name: "wait_for", arguments: { tabId, settle: true, timeout: 10 } }));
  console.log(`${figee.split("\n")[0]} (${Date.now() - t0} ms)`);
  assert.ok(figee.includes("Condition remplie"), "settle résolu malgré l'indicateur figé");
  assert.ok(figee.includes("ignoré"), "indicateur figé signalé comme ignoré");
  assert.ok(Date.now() - t0 < 6000, "résolu en moins de 6 s");

  console.log("\n5. Libellé de chargement du diagnostic...");
  const diag2 = (await client.callTool({
    name: "wait_for",
    arguments: { tabId, text: "texte qui n'existe nulle part 8f3a29", timeout: 1 },
  })) as unknown as { content: { type: string; text?: string }[] };
  const diagText = diag2.content.map((b) => b.text ?? "").join("\n");
  assert.ok(diagText.includes("Chargement des sessions"), "libellé intact (les « s » ne sont pas avalés)");

  console.log("\n✅ TOUS LES TESTS E2E DE WAIT_FOR SETTLE/DIAGNOSTIC ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
  server.close();
}
