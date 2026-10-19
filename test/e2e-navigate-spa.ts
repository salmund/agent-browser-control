/**
 * Test end-to-end de navigate SPA (ST8) :
 * 1. mini-SPA locale (routeur pushState + liens, marqueur React pour la sonde) ;
 * 2. navigate même origine : sans rechargement (compteur sessionStorage inchangé) ;
 * 3. spa: false : rechargement complet (compteur +1) ;
 * 4. route sans lien : repli pushState suivi par le routeur (popstate), même à longueur de texte égale ;
 * 5. routeur qui ignore popstate (comme Next.js) : pas de « navigation SPA » sur l'ancien contenu,
 *    rechargement complet vers la bonne vue ;
 * 6. origine différente : navigation complète, sans chemin SPA.
 *
 * Lancer avec : node test/e2e-navigate-spa.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PAGE = `<!doctype html><html><head><title>Mini SPA</title></head><body>
<nav><a href="/spa/view1">Vue 1</a> <a href="/spa/view2">Vue 2</a></nav>
<div id="vue">ACCUEIL</div>
<script>
sessionStorage.__spaLoads = String(Number(sessionStorage.__spaLoads || 0) + 1);
window.React = {};
function render() {
  document.getElementById("vue").textContent =
    location.pathname.includes("view3") ? "VUE3" : location.pathname.includes("view2") ? "VUE2" : location.pathname.includes("view1") ? "VUE1" : "ACCUEIL";
}
document.querySelectorAll("a").forEach((a) => a.addEventListener("click", (e) => {
  e.preventDefault();
  history.pushState({}, "", a.getAttribute("href"));
  render();
}));
window.addEventListener("popstate", render);
render();
</script></body></html>`;

// Routeur qui n'écoute pas popstate (Next.js ignore un état qui n'est pas le sien) : la vue ne suit qu'un chargement.
const SOURD = `<!doctype html><html><head><title>Routeur sourd</title></head><body>
<div id="vue"></div>
<script>
sessionStorage.__spaLoads = String(Number(sessionStorage.__spaLoads || 0) + 1);
window.React = {};
document.getElementById("vue").textContent = "SOURD-" + location.pathname.split("/").pop().toUpperCase();
</script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname.startsWith("/spa") || url.pathname.startsWith("/sourd")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(url.pathname.startsWith("/sourd") ? SOURD : PAGE);
  } else {
    res.writeHead(404);
    res.end("nope");
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const client = new Client({ name: "e2e-navigate-spa-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de navigate SPA ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const loadsOf = async (tabId: number): Promise<string> =>
  textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: "sessionStorage.__spaLoads" } }))
    .replace(/<\/?page_content[^>]*>/g, "")
    .trim();

const created: number[] = [];
try {
  console.log(`\n1. Serveur local sur 127.0.0.1:${port}, création de l'onglet...`);
  const createRes = await client.callTool({ name: "tabs_create", arguments: { url: `http://127.0.0.1:${port}/spa` } });
  const tabId = Number(textOf(createRes).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);
  assert.strictEqual(await loadsOf(tabId), "1", "un chargement initial");

  console.log("\n2. navigate même origine : chemin SPA, sans rechargement...");
  const spa = textOf(await client.callTool({ name: "navigate", arguments: { tabId, url: `http://127.0.0.1:${port}/spa/view2` } }));
  console.log(spa);
  assert.ok(spa.includes("navigation SPA"), "chemin SPA annoncé");
  assert.strictEqual(await loadsOf(tabId), "1", "aucun rechargement");
  const vue = textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: "document.getElementById('vue').textContent" } }));
  assert.ok(vue.includes("VUE2"), "vue routeur affichée");

  console.log("\n3. spa: false : rechargement complet...");
  const full = textOf(await client.callTool({ name: "navigate", arguments: { tabId, url: `http://127.0.0.1:${port}/spa/view1`, spa: false } }));
  assert.ok(!full.includes("navigation SPA"), "pas de chemin SPA");
  assert.strictEqual(await loadsOf(tabId), "2", "page rechargée");

  const vueDe = async (tabId: number) =>
    textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: "document.getElementById('vue').textContent" } }));

  console.log("\n4. Route sans lien : repli pushState, même longueur de texte (VUE1 -> VUE3)...");
  const push = textOf(await client.callTool({ name: "navigate", arguments: { tabId, url: `http://127.0.0.1:${port}/spa/view3` } }));
  console.log(push);
  assert.ok(push.includes("navigation SPA (pushState)"), "repli pushState annoncé");
  assert.strictEqual(await loadsOf(tabId), "2", "aucun rechargement");
  assert.ok((await vueDe(tabId)).includes("VUE3"), "vue 3 affichée");

  console.log("\n5. Routeur sourd à popstate : rechargement vers la bonne vue...");
  await client.callTool({ name: "navigate", arguments: { tabId, url: `http://127.0.0.1:${port}/sourd/a`, spa: false } });
  const avant = Number(await loadsOf(tabId));
  const sourd = textOf(await client.callTool({ name: "navigate", arguments: { tabId, url: `http://127.0.0.1:${port}/sourd/b` } }));
  console.log(sourd);
  assert.ok(!sourd.includes("navigation SPA"), "pas de succès SPA annoncé sur l'ancien contenu");
  assert.ok((await vueDe(tabId)).includes("SOURD-B"), "la vue cible est affichée");
  assert.strictEqual(Number(await loadsOf(tabId)), avant + 1, "un rechargement complet");

  console.log("\n6. Origine différente : navigation complète...");
  const cross = textOf(await client.callTool({ name: "navigate", arguments: { tabId, url: "https://example.com" } }));
  assert.ok(!cross.includes("navigation SPA"), "pas de chemin SPA inter-origines");
  assert.ok(cross.includes("example.com"), "navigation effectuée");

  console.log("\n✅ TOUS LES TESTS E2E DE NAVIGATE SPA ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
  server.close();
}
