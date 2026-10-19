/**
 * Test end-to-end du relais des scripts (extension/offscreen.js + sandbox.js) sans recharger
 * l'extension : un petit serveur local sert offscreen.js, sandbox.html et sandbox.js, et une page
 * hôte remplace chrome.runtime par une maquette (le service worker). On vérifie :
 * 1. Exécution simple et relais d'un appel d'outil, avec le bon runId côté service worker.
 * 2. Isolation : un script ne peut ni terminer ni appeler des outils au nom d'un autre
 *    (le script est identifié par sa fenêtre, pas par le runId écrit dans le message).
 * 3. Une iframe qui navigue fait échouer son script (« a navigué »).
 * 4. wait() est interrompu par l'arrêt (réponse rapide, pas de blocage de 30 s).
 * 5. Script qui ne rend pas la main après l'arrêt : iframe détruite, réponse stuck,
 *    message script-stuck envoyé au service worker.
 * 6. Une iframe par script : après les exécutions, seule l'iframe de réserve reste.
 *
 * Lancer avec : node test/e2e-sandbox.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXT = join(import.meta.dirname, "..", "extension");

// Page hôte : maquette de chrome.runtime (le service worker) puis le vrai offscreen.js.
const HARNESS = `<!doctype html><meta charset="utf-8"><title>Banc sandbox</title><body>
<script>
  const listeners = [];
  window.__calls = [];
  window.__stuck = [];
  window.chrome = { runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    sendMessage: async (msg) => {
      if (msg.type === "script-call") {
        window.__calls.push({ runId: msg.runId, tool: msg.tool });
        return { content: [{ type: "text", text: "echo:" + msg.tool }] };
      }
      if (msg.type === "script-stuck") window.__stuck.push(msg);
      return undefined;
    },
  } };
  let n = 0;
  window.runScript = (code, runId = "run_" + (++n)) => new Promise((resolve) => {
    for (const fn of listeners) fn({ target: "offscreen", type: "run-script", runId, code }, {}, resolve);
  });
  window.abortScript = (runId) => { for (const fn of listeners) fn({ target: "offscreen", type: "abort-script", runId }, {}, () => {}); };
</script>
<script src="offscreen.js"></script>`;

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const files: Record<string, [string, string]> = {
    "/offscreen.js": [join(EXT, "offscreen.js"), "text/javascript"],
    "/sandbox.js": [join(EXT, "sandbox.js"), "text/javascript"],
    "/sandbox.html": [join(EXT, "sandbox.html"), "text/html"],
  };
  if (path === "/harness.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HARNESS);
  } else if (files[path]) {
    res.writeHead(200, { "content-type": `${files[path][1]}; charset=utf-8` });
    res.end(readFileSync(files[path][0]));
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const client = new Client({ name: "e2e-sandbox-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

console.log("=== Démarrage des tests E2E du relais de scripts (offscreen + sandbox) ===");

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  if (c.isError) console.log("Erreur d'outil : " + c.content.map((b) => b.text ?? "").join(" | "));
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};
const unwrap = (t: string) => t.replace(/^[\s\S]*?<page_content[^>]*>\n?/, "").replace(/\n?<\/page_content>[\s\S]*$/, "").trim();

const created: number[] = [];
try {
  console.log("\n1. Page hôte locale...");
  const createRes = await client.callTool({ name: "tabs_create", arguments: { url: `http://127.0.0.1:${port}/harness.html` } });
  const tabId = Number(textOf(createRes).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);
  const js = async (code: string) => JSON.parse(unwrap(textOf(await client.callTool({ name: "javascript", arguments: { tabId, code } }))));

  console.log("\n2. Exécution simple + relais d'appel d'outil...");
  const simple = await js(`(async () => JSON.stringify(await runScript("return 1 + 1")))()`);
  assert.strictEqual(simple.value, 2, "valeur renvoyée");
  const relay = await js(`(async () => JSON.stringify({ r: await runScript('const r = await call("find", {}); return r.text;', "run_relais"), calls: window.__calls }))()`);
  assert.strictEqual(relay.r.value, "echo:find", "résultat de l'outil relayé");
  assert.deepStrictEqual(relay.calls.at(-1), { runId: "run_relais", tool: "find" }, "runId réel transmis au service worker");

  console.log("\n3. Isolation entre scripts...");
  const iso = await js(`(async () => {
    window.__calls = [];
    const a = runScript('await wait(1.5); return "A";', "run_A");
    await new Promise((r) => setTimeout(r, 300));
    const b = runScript('parent.postMessage({ kind: "call", runId: "run_A", callId: 1, tool: "pirate", args: {} }, "*"); await new Promise((r) => setTimeout(r, 200)); parent.postMessage({ kind: "done", runId: "run_A", value: "pirate" }, "*"); return "B";', "run_B");
    return JSON.stringify({ a: await a, b: await b, calls: window.__calls });
  })()`);
  assert.strictEqual(iso.a.value, "A", "le script A n'est pas terminé par B");
  assert.ok(!iso.calls.some((c: { runId: string }) => c.runId === "run_A"), "aucun appel d'outil au nom de A");
  assert.ok(iso.calls.some((c: { runId: string; tool: string }) => c.runId === "run_B" && c.tool === "pirate"), "l'appel de B reste attribué à B");

  console.log("\n4. Navigation de l'iframe...");
  const nav = await js(`(async () => JSON.stringify(await runScript('location.href = "sandbox.html?x=1"; await new Promise(() => {});')))()`);
  assert.ok(/navigué/.test(nav.error ?? ""), `script arrêté après navigation (${nav.error})`);

  console.log("\n5. wait() interrompu par l'arrêt...");
  const waited = await js(`(async () => {
    const t0 = Date.now();
    const p = runScript("await wait(30); return 1;", "run_wait");
    await new Promise((r) => setTimeout(r, 400));
    abortScript("run_wait");
    const res = await p;
    return JSON.stringify({ res, ms: Date.now() - t0 });
  })()`);
  assert.ok(/arrêté/.test(waited.res.error ?? ""), "erreur d'arrêt");
  assert.ok(!waited.res.stuck, "pas besoin de détruire l'iframe");
  assert.ok(waited.ms < 3000, `réponse rapide (${waited.ms} ms)`);

  console.log("\n6. Script qui ne rend pas la main : iframe détruite, signal stuck...");
  const stuck = await js(`(async () => {
    window.__stuck = [];
    const t0 = Date.now();
    const p = runScript("await new Promise(() => {});", "run_stuck");
    await new Promise((r) => setTimeout(r, 400));
    abortScript("run_stuck");
    const res = await p;
    await new Promise((r) => setTimeout(r, 100));
    return JSON.stringify({ res, ms: Date.now() - t0, stuck: window.__stuck });
  })()`);
  assert.strictEqual(stuck.res.stuck, true, "réponse marquée stuck");
  assert.ok(stuck.ms >= 4000 && stuck.ms < 8000, `délai d'environ 4,5 s (${stuck.ms} ms)`);
  assert.deepStrictEqual(stuck.stuck, [{ type: "script-stuck", runId: "run_stuck", handled: true }], "message script-stuck envoyé");

  console.log("\n7. Une iframe par script...");
  const frames = await js(`(async () => { await new Promise((r) => setTimeout(r, 300)); return JSON.stringify(document.querySelectorAll("iframe").length); })()`);
  assert.strictEqual(frames, 1, "seule l'iframe de réserve subsiste");
  const attr = await js(`JSON.stringify(document.querySelector("iframe").getAttribute("sandbox"))`);
  assert.strictEqual(attr, "allow-scripts", "attribut sandbox posé");

  console.log("\n✅ TOUS LES TESTS E2E DU RELAIS DE SCRIPTS ONT RÉUSSI !");
} finally {
  for (const id of created) {
    await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  }
  await client.close();
  server.close();
}
