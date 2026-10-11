/**
 * Test end-to-end de wait_for scroll + countStable (P3) :
 * 1. scroll down : cible paresseuse (injectée au scroll de la fenêtre) trouvée en scrollant.
 * 2. scroll up : même chose en remontant.
 * 3. countStable : N éléments qui arrivent par vagues, résolu quand ça ne bouge plus.
 *
 * Lancer avec : node test/e2e-wait-scroll.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-wait-scroll-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E de wait_for scroll/countStable ===");

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
        const spacer = document.createElement("div");
        spacer.style.height = "300vh";
        document.body.appendChild(spacer);
        let downDone = false, upDone = false;
        window.addEventListener("scroll", () => {
          if (!downDone && window.scrollY > 500) {
            downDone = true;
            const d = document.createElement("div");
            d.id = "cible-lazy";
            d.textContent = "CIBLE APPARUE EN BAS";
            document.body.appendChild(d);
          }
          if (!upDone && window.scrollY < 200 && downDone) {
            upDone = true;
            const d = document.createElement("div");
            d.id = "cible-haute";
            d.textContent = "CIBLE APPARUE EN HAUT";
            document.body.prepend(d);
          }
        });
        return "fixture-ok";
      })()`,
    },
  });

  console.log("\n2. scroll down jusqu'à la cible paresseuse...");
  const down = textOf(await client.callTool({
    name: "wait_for",
    arguments: { tabId, selector: "#cible-lazy", scroll: { direction: "down" }, timeout: 30 },
  }));
  console.log(down.split("\n")[0]);
  assert.ok(down.includes("Condition remplie"), "cible trouvée en scrollant");
  assert.ok(/\d+ scroll\(s\)/.test(down), "compte de scrolls annoncé");

  console.log("\n3. scroll up jusqu'à la cible haute...");
  const up = textOf(await client.callTool({
    name: "wait_for",
    arguments: { tabId, selector: "#cible-haute", scroll: { direction: "up" }, timeout: 30 },
  }));
  console.log(up.split("\n")[0]);
  assert.ok(up.includes("Condition remplie"), "cible haute trouvée en remontant");

  console.log("\n4. countStable sur une liste qui pousse par vagues...");
  await client.callTool({
    name: "javascript",
    arguments: {
      tabId,
      code: `(() => {
        let n = 0;
        const timer = setInterval(() => {
          n++;
          const d = document.createElement("div");
          d.className = "grow-row";
          d.textContent = "pousse " + n;
          document.body.appendChild(d);
          if (n >= 4) clearInterval(timer);
        }, 300);
        return "growing";
      })()`,
    },
  });
  const stable = textOf(await client.callTool({
    name: "wait_for",
    arguments: { tabId, countStable: { selector: ".grow-row", stableMs: 1200, minCount: 4 }, timeout: 30 },
  }));
  console.log(stable.split("\n")[0]);
  assert.ok(stable.includes("Condition remplie"), "stabilité détectée");
  assert.ok(stable.includes("4 élément(s) stable(s)"), "compte final exact");

  console.log("\n✅ TOUS LES TESTS E2E DE WAIT_FOR SCROLL/COUNT ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
}
