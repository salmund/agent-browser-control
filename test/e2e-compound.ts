/**
 * Test end-to-end des actions composées avec le vrai navigateur :
 * 1. tabs_create avec url + snapshot: true
 * 2. navigate avec snapshot: true
 * 3. computer clic avec snapshot: true / scroll avec then: "diff"
 * 4. waitDomSettle ne laisse aucune globale __abc* dans la page
 * 5. lecture multi-frame (iframe injectée)
 * 6. bandeau cookies détecté + arbre complet (overlay en parallèle)
 * 7. tabs_close pour nettoyer
 *
 * Lancer avec : node test/e2e-compound.ts
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-compound-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E des actions composées ===");

let createdTabId: number | null = null;
try {
  // 1. Test tabs_create avec url + snapshot: true
  console.log("\n1. Test tabs_create(url, snapshot: true)...");
  const createRes = await client.callTool({
    name: "tabs_create",
    arguments: { url: "https://example.com", snapshot: true },
  });
  assert.strictEqual(createRes.isError, undefined, "tabs_create sans erreur");
  const createText = (createRes.content as { type: string; text: string }[])[0].text;
  console.log("Sortie tabs_create :\n" + createText.slice(0, 300) + "...\n");

  assert.ok(createText.includes("Onglet créé"), "Contient 'Onglet créé'");
  assert.ok(createText.includes("example.com"), "Contient l'URL example.com");
  assert.ok(createText.includes("ref_"), "Contient l'arbre d'accessibilité avec des refs");
  assert.ok(createText.toLowerCase().includes("more") || createText.includes("ref_1"), "Contient le lien de la page");
  assert.ok(createText.includes("Éléments interactifs :"), "Cadrage interactif présent (nombre + renvoi filter=all)");
  assert.ok(createText.includes('filter="all"'), "Renvoi vers filter=all présent");

  // Extraire le tabId
  const match = createText.match(/tabId\s+(\d+)/);
  assert.ok(match, "tabId extrait");
  createdTabId = Number(match[1]);
  console.log(`TabId créé : ${createdTabId}`);

  // 2. Test navigate avec snapshot: true
  console.log("\n2. Test navigate(snapshot: true)...");
  const navRes = await client.callTool({
    name: "navigate",
    arguments: { tabId: createdTabId, url: "https://example.com", snapshot: true },
  });
  assert.strictEqual(navRes.isError, undefined, "navigate sans erreur");
  const navText = (navRes.content as { type: string; text: string }[])[0].text;
  console.log("Sortie navigate :\n" + navText.slice(0, 300) + "...\n");

  assert.ok(navText.includes("Navigation terminée"), "Contient 'Navigation terminée'");
  assert.ok(navText.includes("ref_"), "Contient l'arbre avec des refs directement dans navigate");

  // 3. Test computer clic avec then: 'read' / snapshot: true
  console.log("\n3. Test computer(left_click, ref, snapshot: true)...");
  // Extraire la ref du premier lien
  const refMatch = navText.match(/\[(ref_\d+)\]/);
  assert.ok(refMatch, "ref trouvée dans l'arbre");
  const linkRef = refMatch[1];
  console.log(`Clic sur ${linkRef} avec snapshot: true...`);

  const clickRes = await client.callTool({
    name: "computer",
    arguments: { tabId: createdTabId, action: "left_click", ref: linkRef, snapshot: true },
  });
  assert.strictEqual(clickRes.isError, undefined, "computer sans erreur");
  const clickText = (clickRes.content as { type: string; text: string }[])[0].text;
  console.log("Sortie computer :\n" + clickText.slice(0, 450) + "...\n");

  assert.ok(clickText.includes("left_click en"), "Contient confirmation du clic");
  assert.ok(clickText.includes("iana.org") || clickText.includes("Domains") || clickText.includes("ref_"), "Contient le nouvel arbre après le clic");

  // 3b. Test computer scroll avec then: 'diff'
  console.log("\n3b. Test computer(scroll, then: 'diff')...");
  const scrollRes = await client.callTool({
    name: "computer",
    arguments: { tabId: createdTabId, action: "scroll", scroll_direction: "down", scroll_amount: 3, then: "diff" },
  });
  assert.strictEqual(scrollRes.isError, undefined, "scroll sans erreur");
  const scrollText = (scrollRes.content as { type: string; text: string }[])[0].text;
  console.log("Sortie scroll avec diff :\n" + scrollText.slice(0, 350) + "...\n");
  assert.ok(scrollText.includes("Défilement down"), "Confirmation du défilement");

  // 4. waitDomSettle ne laisse aucune trace dans la page (observer déconnecté, globales supprimées).
  // Sonde réessayée 4 fois : sous charge (suite complète, PC occupé), le nettoyage du scroll
  // précédent peut ne pas être visible à la première lecture. Un résidu persistant échoue toujours.
  console.log("\n4. Test nettoyage waitDomSettle...");
  let probeText = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const probeRes = await client.callTool({
      name: "javascript",
      arguments: { tabId: createdTabId, code: "typeof window.__abcObserver + '/' + typeof window.__abcLastMutation" },
    });
    probeText = (probeRes.content as { type: string; text: string }[])[0].text;
    if (probeText.includes("undefined/undefined")) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.ok(probeText.includes("undefined/undefined"), `Globales __abc* nettoyées (reçu : ${probeText.slice(0, 80)})`);

  // 5. inAllFrames multi-frame : iframe injectée, arbre principal + section iframe.
  console.log("\n5. Test lecture multi-frame (iframe injectée)...");
  await client.callTool({
    name: "javascript",
    arguments: {
      tabId: createdTabId,
      code: "(async () => { const f = document.createElement('iframe'); f.srcdoc = '<p>cadre test</p>'; f.style.width = '300px'; f.style.height = '100px'; document.body.appendChild(f); await new Promise((r) => { f.onload = r; setTimeout(r, 3000); }); return 'iframe-ok'; })()",
    },
  });
  const frameRes = await client.callTool({ name: "read_page", arguments: { tabId: createdTabId, filter: "all" } });
  const frameText = (frameRes.content as { type: string; text: string }[])[0].text;
  assert.ok(frameText.includes("=== iframe"), "Section iframe présente");
  assert.ok(frameText.includes("cadre test"), "Contenu de l'iframe lu");

  // 6. overlayNotice en parallèle : faux bandeau cookies détecté + arbre complet.
  console.log("\n6. Test bandeau cookies (overlay + arbre)...");
  await client.callTool({
    name: "javascript",
    arguments: {
      tabId: createdTabId,
      code: "const d = document.createElement('div'); d.id = 'e2e-cookies'; d.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:120px;background:#fff;z-index:9999;color:#000'; d.innerHTML = 'Nous utilisons des cookies pour la mesure. <button>Refuser</button> <button>Accepter</button>'; document.body.appendChild(d); 'banner-ok'",
    },
  });
  const bannerRes = await client.callTool({ name: "read_page", arguments: { tabId: createdTabId, filter: "interactive" } });
  const bannerText = (bannerRes.content as { type: string; text: string }[])[0].text;
  assert.ok(bannerText.includes("bannière de cookies"), "Avis bandeau présent");
  assert.ok(bannerText.includes("Refuser") && bannerText.includes("[ref_"), "Boutons + arbre présents");

  console.log("\n✅ TOUS LES TESTS E2E DES ACTIONS COMPOSÉES ONT RÉUSSI !");
} finally {
  if (createdTabId !== null) {
    console.log(`\nNettoyage : fermeture de l'onglet ${createdTabId}...`);
    await client.callTool({ name: "tabs_close", arguments: { tabId: createdTabId } }).catch(() => {});
  }
  await client.close();
}
