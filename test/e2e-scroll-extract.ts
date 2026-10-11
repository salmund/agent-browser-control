/**
 * Test end-to-end de scroll_extract (P0) :
 * 1. Liste à chargement progressif (5 pages de 20 lignes, une différée de 600 ms) :
 *    TOUT extrait en un appel, ordre conservé, sans doublon, conteneur auto-détecté.
 * 2. Pagination limit/offset.
 * 3. extract html.
 * 4. direction up sur la même liste chargée.
 * 5. Gros volume (500 lignes longues) : contenu complet en fichier JSON + aperçu.
 *
 * Lancer avec : node test/e2e-scroll-extract.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-scroll-extract-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de scroll_extract ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const rowsOf = (out: string): string[] =>
  out.split("\n").filter((l) => l.startsWith("- Ligne ")).map((l) => l.slice(2).trim());

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
        const feed = document.createElement("div");
        feed.id = "feed";
        feed.style.cssText = "height:300px;overflow-y:auto;border:1px solid #000;padding:0;margin:0;box-sizing:border-box;";
        document.body.appendChild(feed);
        let page = 0, pending = false;
        const appendPage = () => {
          for (let i = 1; i <= 20; i++) {
            const d = document.createElement("div");
            d.className = "row";
            d.style.cssText = "height:30px;margin:0;padding:0;box-sizing:border-box;";
            d.textContent = "Ligne " + (page * 20 + i);
            feed.appendChild(d);
          }
          page++;
          pending = false;
        };
        appendPage();
        feed.addEventListener("scroll", () => {
          if (pending || page >= 5) return;
          if (feed.scrollTop + feed.clientHeight < feed.scrollHeight - 40) return;
          pending = true;
          // Page 3 différée (600 ms) : exerce l'attente intelligente (waitMs), pas un sleep fixe.
          if (page === 2) setTimeout(appendPage, 600);
          else appendPage();
        });
        // Gros volume : 500 lignes longues (~55 000 car.), déjà chargées.
        const big = document.createElement("div");
        big.id = "big";
        big.style.cssText = "height:200px;overflow-y:auto;margin-top:20px;";
        for (let i = 1; i <= 500; i++) {
          const d = document.createElement("div");
          d.className = "bigrow";
          d.style.cssText = "height:20px;margin:0;padding:0;box-sizing:border-box;overflow:hidden;white-space:nowrap;";
          d.textContent = "Grosse ligne " + i + " " + "x".repeat(90);
          big.appendChild(d);
        }
        document.body.appendChild(big);
        return "fixture-ok";
      })()`,
    },
  });

  console.log("\n2. Extraction complète en un appel...");
  const out = textOf(await client.callTool({ name: "scroll_extract", arguments: { tabId, item: ".row" } }));
  console.log(out.split("\n").slice(0, 3).join("\n") + "\n...");
  assert.ok(out.includes("100 item(s) au total"), "les 5 pages (100 lignes) extraites");
  assert.ok(out.includes("div#feed"), "conteneur auto-détecté");
  assert.ok(!out.includes("maxRounds"), "fin naturelle, pas par garde-fou");
  const rows = rowsOf(out);
  assert.strictEqual(rows.length, 100, "100 lignes renvoyées");
  assert.strictEqual(new Set(rows).size, 100, "aucun doublon");
  assert.strictEqual(rows[0], "Ligne 1", "ordre : première");
  assert.strictEqual(rows[99], "Ligne 100", "ordre : dernière");

  console.log("\n3. Pagination limit/offset...");
  const page2 = textOf(await client.callTool({ name: "scroll_extract", arguments: { tabId, item: ".row", limit: 10, offset: 80 } }));
  const rows2 = rowsOf(page2);
  assert.strictEqual(rows2.length, 10, "10 lignes paginées");
  assert.strictEqual(rows2[0], "Ligne 81", "offset respecté");
  assert.strictEqual(rows2[9], "Ligne 90", "fin de page");
  assert.ok(page2.includes("Tronqué par limit/offset"), "troncature signalée");

  console.log("\n4. extract html...");
  const html = textOf(await client.callTool({ name: "scroll_extract", arguments: { tabId, item: ".row", extract: "html", limit: 2 } }));
  assert.ok(html.includes("<div"), "HTML brut renvoyé");
  assert.ok(html.includes("Ligne 1"), "contenu présent dans le HTML");

  console.log("\n5. direction up (liste déjà chargée)...");
  const up = textOf(await client.callTool({ name: "scroll_extract", arguments: { tabId, item: ".row", direction: "up" } }));
  assert.ok(up.includes("100 item(s) au total"), "remontée complète");

  console.log("\n6. Gros volume : fichier JSON complet + aperçu...");
  const big = textOf(await client.callTool({ name: "scroll_extract", arguments: { tabId, item: ".bigrow" } }));
  console.log(big.split("\n").slice(0, 4).join("\n") + "\n...");
  assert.ok(big.includes("500 item(s) au total"), "500 lignes comptées");
  const m = big.match(/fichier : (.+\.json)/);
  assert.ok(m, "chemin du fichier JSON présent ({path} remplacé)");
  const jsonPath = m[1].trim();
  assert.ok(jsonPath.startsWith(homedir()), "fichier sous le home");
  assert.ok(existsSync(jsonPath), `fichier écrit : ${jsonPath}`);
  const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as { meta: { total: number }; items: string[] };
  assert.strictEqual(parsed.items.length, 500, "500 items dans le fichier");
  assert.ok(parsed.items[0].includes("Grosse ligne 1"), "premier item intact");
  assert.ok(parsed.items[499].includes("Grosse ligne 500"), "dernier item intact");

  console.log("\n✅ TOUS LES TESTS E2E DE SCROLL_EXTRACT ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
