/**
 * Test de bout en bout sans navigateur : client MCP → shim → démon → fausse extension.
 * Démon de test sur un port libre, dans un dossier de configuration temporaire (jamais le
 * vrai ~/.agent-browser-control), arrêté à la fin par /shutdown.
 * Couvre : refus web / Host / jeton, épinglage de l'extension (hello, refus 4003, remplacement
 * par la même origine), appels en attente rejetés à la déconnexion, expiration + cancel +
 * fichier tardif, file_upload contrôlé par le démon, flux /events sans secret.
 * Lancer avec : node test/smoke.ts
 */
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOLS } from "../server/tools.ts";
import { fakeExtension, sleep, stopDaemon, testEnv, until } from "./harness.ts";

const VERSION = JSON.parse(readFileSync("package.json", "utf8")).version as string;
const t = await testEnv("smoke", { ABC_TIMEOUT_OVERRIDE_MS: "1500" });
const textOf = (r: unknown) => ((r as { content?: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
const logText = () => (existsSync(join(t.configDir, "actions.log")) ? readFileSync(join(t.configDir, "actions.log"), "utf8") : "");

/** Requête brute (pour forger l'en-tête Host, ce que fetch ne permet pas). */
function rawGet(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: t.port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

const client = new Client({ name: "smoke", version: "0" });
let stopped = false;
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"], env: t.env }));
  const { tools } = await client.listTools();
  assert.strictEqual(tools.length, TOOLS.length, "tous les outils listés");
  console.log(`outils : ${tools.length}`);

  // Accès : page web (Origin), Host inattendu, jeton absent ou faux, corps invalide.
  assert.strictEqual((await fetch(`${t.base}/health`, { headers: { origin: "https://evil.example" } })).status, 403, "Origin web refusée");
  assert.strictEqual(await rawGet("/health", { host: `evil.example:${t.port}` }), 403, "Host inattendu refusé");
  assert.strictEqual(await rawGet("/health", { host: `localhost:${t.port}` }), 200, "localhost accepté");
  const post = (path: string, body: string, token = t.token()) =>
    fetch(`${t.base}${path}`, { method: "POST", headers: { "x-abc-token": token, "content-type": "application/json" }, body });
  assert.strictEqual((await post("/call", "{}", "faux")).status, 401, "jeton faux refusé");
  assert.strictEqual((await post("/call", '{"tool":5}')).status, 400, "tool non textuel refusé");
  assert.strictEqual((await post("/call", "[1]")).status, 400, "tableau refusé");
  assert.strictEqual((await post("/call", "pas du json")).status, 400, "JSON invalide refusé");
  assert.strictEqual((await fetch(`${t.base}/events`)).status, 401, "/events exige le jeton");

  // Flux d'événements.
  const ctrl = new AbortController();
  const events = await fetch(`${t.base}/events`, { headers: { authorization: `Bearer ${t.token()}` }, signal: ctrl.signal });
  assert.strictEqual(events.status, 200, "/events ouvert avec Bearer");
  let eventsText = "";
  void (async () => {
    const reader = events.body!.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        eventsText += dec.decode(value, { stream: true });
      }
    } catch {}
  })();

  // Fausse extension : hello, épinglage, appel relayé.
  let blocked: number[] = [];
  const answer = (m: { id: number; agent: string; tool: string; args: Record<string, unknown> }) => {
    if (m.tool === "wait_for") {
      blocked.push(m.id);
      return null;
    }
    return { content: [{ type: "text", text: `echo ${m.agent}/${m.tool}` }] };
  };
  const ext = fakeExtension(t.port, "chrome-extension://fake", answer);
  await ext.opened;
  await until(() => ext.messages.some((m) => m.type === "hello"), 3000, "hello");
  assert.deepStrictEqual(ext.messages[0], { type: "hello", version: VERSION }, "hello en premier, avec la version");
  assert.strictEqual(readFileSync(join(t.configDir, "extension-origin"), "utf8").trim(), "chrome-extension://fake", "origine épinglée dans le dossier de test");
  const first = textOf(await client.callTool({ name: "tabs_context", arguments: {} }));
  assert.ok(first.startsWith("echo smoke/tabs_context"), "appel relayé");
  assert.ok(/Fonctions ABC/.test(first) && /web\.search\(query/.test(first), "catalogue des fonctions servi en début de session");

  // Une autre origine est refusée (4003), l'extension épinglée reste en service.
  const intrus = fakeExtension(t.port, "chrome-extension://intrus");
  await until(() => intrus.closed !== null, 3000, "refus de l'intrus");
  assert.strictEqual(intrus.closed!.code, 4003, "close 4003");
  assert.ok(intrus.closed!.reason.includes("unpin-extension"), "raison actionnable");
  assert.strictEqual(textOf(await client.callTool({ name: "tabs_context", arguments: {} })), "echo smoke/tabs_context", "épinglée toujours servie (catalogue pas répété)");
  await until(() => logText().includes('"event":"extension_refused"'), 2000, "refus journalisé");
  assert.ok(logText().includes("npm run unpin-extension"), "message de réinitialisation journalisé");

  // Journal et flux : arguments masqués (valeur saisie réduite à sa longueur).
  await client.callTool({ name: "form_input", arguments: { tabId: 1, ref: "ref_1", value: "secret-xyz-123" } });
  await until(() => eventsText.includes('"tool":"form_input"'), 3000, "événement form_input");
  assert.ok(!eventsText.includes("secret-xyz-123") && !logText().includes("secret-xyz-123"), "aucune valeur saisie en clair");
  assert.ok(eventsText.includes("<14 car.>"), "longueur seulement");
  assert.ok(eventsText.includes('"event":"extension_connected"'), "connexion de l'extension dans le flux");

  // file_upload : refusé par le démon, sans rien transmettre à l'extension.
  const before = ext.messages.length;
  const up = await client.callTool({ name: "file_upload", arguments: { tabId: 1, ref: "ref_2", paths: [join(t.configDir, "token")] } });
  assert.strictEqual(up.isError, true, "envoi du jeton refusé");
  assert.ok(textOf(up).includes("refusé"), "message clair");
  assert.strictEqual(ext.messages.length, before, "rien transmis à l'extension");

  // Expiration : message actionnable, cancel envoyé, réponse tardive avec fichier enregistrée.
  const slow = await client.callTool({ name: "wait_for", arguments: { tabId: 1, text: "bloque" } });
  assert.strictEqual(slow.isError, true, "expiration en erreur");
  assert.ok(textOf(slow).includes("Délai dépassé") && textOf(slow).includes("vérifier l'état de la page"), "message actionnable");
  const lateId = blocked[0];
  await until(() => ext.messages.some((m) => m.type === "cancel" && m.id === lateId), 2000, "cancel reçu");
  ext.ws.send(
    JSON.stringify({
      id: lateId,
      result: { content: [{ type: "text", text: "tard {path}" }], _file: { name: "../tardif rapport.txt", base64: Buffer.from("contenu tardif").toString("base64") } },
    }),
  );
  await until(() => logText().includes('"event":"late_result"'), 3000, "late_result");
  const latePath = join(t.outputDir, "tardif_rapport.txt");
  assert.ok(existsSync(latePath) && readFileSync(latePath, "utf8") === "contenu tardif", "fichier tardif enregistré, nom assaini");

  // Déconnexion pendant un appel : rejet immédiat, message explicite.
  blocked = [];
  const cut = client.callTool({ name: "wait_for", arguments: { tabId: 1, text: "coupure" } });
  await until(() => blocked.length === 1, 1000, "appel reçu");
  ext.ws.close();
  const cutRes = await cut;
  assert.ok(textOf(cutRes).includes("Extension déconnectée pendant l'appel"), "appel rejeté à la déconnexion");

  // Même origine : la reconnexion remplace l'ancienne socket, ses appels en attente sont rejetés.
  const ext2 = fakeExtension(t.port, "chrome-extension://fake", answer);
  await ext2.opened;
  blocked = [];
  const orphan = client.callTool({ name: "wait_for", arguments: { tabId: 1, text: "remplacement" } });
  await until(() => blocked.length === 1, 1000, "appel reçu par ext2");
  const ext3 = fakeExtension(t.port, "chrome-extension://fake", answer);
  await ext3.opened;
  await until(() => ext2.closed !== null, 2000, "ext2 remplacée");
  assert.strictEqual(ext2.closed!.reason, "replaced", "ancienne socket fermée (replaced)");
  assert.ok(textOf(await orphan).includes("Extension déconnectée pendant l'appel"), "pas d'appel orphelin");
  assert.strictEqual(textOf(await client.callTool({ name: "tabs_context", arguments: {} })), "echo smoke/tabs_context", "nouvelle socket servie");

  // Arrêt propre du démon de test.
  ctrl.abort();
  ext3.ws.close();
  await client.close();
  stopped = await stopDaemon(t);
  assert.ok(stopped, "démon arrêté par /shutdown");
  console.log("smoke : OK (accès, épinglage, hello, remplacement, déconnexion, expiration + cancel, fichier tardif, file_upload, /events, /shutdown)");
} finally {
  if (!stopped) await stopDaemon(t).catch(() => false);
  await client.close().catch(() => {});
  await sleep(300);
  t.cleanup();
}
