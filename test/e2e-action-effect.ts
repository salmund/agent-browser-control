/**
 * Test end-to-end de l'effet constaté gratuit : chaque action computer / form_input
 * embarque « Effet : ... » (digest avant/après) dans sa réponse, sans tour LLM.
 * 1. Clic qui ajoute du contenu -> effet chiffré positif.
 * 2. form_input -> effet « champs +N car. » (innerText ignore les champs : formLen).
 * 3. Scroll sans changement -> « Effet : inchangé. ».
 * 4. Screenshot -> pas de ligne d'effet (une lecture ne change rien).
 * 5. Clic refusé (fantôme) -> erreur sans ligne d'effet.
 * 6. Clic qui navigue -> effet « url → ... ».
 * Lancer avec : node test/e2e-action-effect.ts
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-action-effect-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

type Content = { isError?: true; content: { type: string; text?: string }[] };
const textOf = (res: unknown): string => {
  const c = res as Content;
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  return textOf(await client.callTool({ name, arguments: args }));
}

console.log("=== Démarrage des tests E2E de l'effet constaté ===");
let tabId: number | null = null;
try {
  console.log("\n1. Création de l'onglet + fixture...");
  const created = await call("tabs_create", { url: "https://example.com" });
  tabId = Number((created.match(/tabId\s+(\d+)/) as RegExpMatchArray)[1]);
  await call("javascript", {
    tabId,
    code: `(() => {
      const btn = document.createElement("button");
      btn.id = "adder";
      btn.textContent = "Ajouter une ligne";
      let n = 0;
      btn.addEventListener("click", () => {
        n++;
        const p = document.createElement("p");
        p.className = "added";
        p.textContent = "Ligne ajoutée numéro " + n + " avec du contenu visible";
        document.body.appendChild(p);
      });
      document.body.appendChild(btn);
      const input = document.createElement("input");
      input.id = "nom";
      input.type = "text";
      document.body.appendChild(input);
      const ghost = document.createElement("button");
      ghost.id = "ghost";
      ghost.style.cssText = "position:fixed;left:-9999px;top:160px;";
      ghost.textContent = "Fantôme";
      document.body.appendChild(ghost);
      const tall = document.createElement("div");
      tall.style.cssText = "height:3000px;";
      document.body.appendChild(tall);
      return "fixture-ok";
    })()`,
  });

  console.log("\n2. Clic qui ajoute du contenu...");
  const found = await call("find", { tabId, query: "Ajouter une ligne" });
  const ref = (found.match(/\[(ref_\d+)\]/) as RegExpMatchArray)[1];
  // Livraison physique parfois capricieuse sous charge : réessayer, l'effet finit par constater.
  let clicked = "";
  for (let i = 0; i < 3; i++) {
    try {
      clicked = await call("computer", { tabId, action: "left_click", ref });
    } catch {
      continue;
    }
    if (/Effet : .*\+\d+ car\./.test(clicked)) break;
  }
  console.log(clicked.split("\n").slice(0, 3).join("\n"));
  assert.ok(/Effet : .*\+\d+ car\./.test(clicked), "effet chiffré positif après clic");

  console.log("\n3. form_input : effet champs...");
  const foundInput = await call("find", { tabId, query: "css:#nom" });
  const inputRef = (foundInput.match(/\[(ref_\d+)\]/) as RegExpMatchArray)[1];
  const filled = await call("form_input", { tabId, ref: inputRef, value: "Bonjour les champs" });
  console.log(filled.split("\n").slice(-1).join("\n"));
  assert.ok(filled.includes("Effet : champs +18 car."), "saisie constatée via formLen");

  console.log("\n4. Scroll sans changement...");
  const scrolled = await call("computer", { tabId, action: "scroll", scroll_direction: "down", scroll_amount: 2 });
  assert.ok(scrolled.includes("Effet : inchangé."), "scroll sans effet DOM constaté");

  console.log("\n5. Screenshot : pas de ligne d'effet...");
  const shot = await call("computer", { tabId, action: "screenshot", scale: 0.2 });
  assert.ok(!shot.includes("Effet : "), "aucun constat sur une lecture");

  console.log("\n6. Clic refusé : erreur sans ligne d'effet...");
  const foundGhost = await call("find", { tabId, query: "css:#ghost" });
  const ghostRef = (foundGhost.match(/\[(ref_\d+)\]/) as RegExpMatchArray)[1];
  const refused = (await client.callTool({ name: "computer", arguments: { tabId, action: "left_click", ref: ghostRef } })) as Content;
  assert.strictEqual(refused.isError, true, "clic fantôme refusé");
  const refusedText = refused.content.map((b) => b.text ?? "").join("\n");
  assert.ok(!refusedText.includes("Effet : "), "aucun constat sur une action refusée");

  console.log("\n7. Clic qui navigue...");
  const foundLink = await call("find", { tabId, query: "Learn more" });
  const linkRef = (foundLink.match(/\[(ref_\d+)\]/) as RegExpMatchArray)[1];
  let nav = "";
  for (let i = 0; i < 3; i++) {
    try {
      nav = await call("computer", { tabId, action: "left_click", ref: linkRef });
    } catch {
      continue;
    }
    if (nav.includes("url → ")) break;
  }
  assert.ok(nav.includes("url → https://www.iana.org"), "navigation constatée dans l'effet");

  console.log("\n✅ TOUS LES TESTS E2E DE L'EFFET CONSTATÉ ONT RÉUSSI !");
} finally {
  if (tabId !== null) await client.callTool({ name: "tabs_close", arguments: { tabId } }).catch(() => {});
  await client.close();
}
