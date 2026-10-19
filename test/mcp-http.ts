/**
 * Endpoint MCP natif du démon (POST /mcp, Streamable HTTP sans état) : client SDK HTTP
 * contre un démon de test (port libre, dossier temporaire) et une fausse extension.
 * Couvre : jeton (Bearer ou x-abc-token), mêmes outils que le shim, nom d'agent par ?agent=,
 * filtrage de browser_script selon les réglages, GET/DELETE en 405, arrêt par /shutdown.
 * Lancer avec : node test/mcp-http.ts
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOOLS } from "../server/tools.ts";
import { fakeExtension, sleep, startDaemon, stopDaemon, testEnv } from "./harness.ts";

const t = await testEnv("mcp-http");
const textOf = (r: unknown) => ((r as { content?: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");

async function connect(headers: Record<string, string>, agent = "http-test"): Promise<Client> {
  const client = new Client({ name: "client-http", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp?agent=${agent}`), { requestInit: { headers } }));
  return client;
}

const child = await startDaemon(t);
let stopped = false;
try {
  // Sans jeton, ou avec un faux : refusé.
  await assert.rejects(connect({}), "sans jeton refusé");
  await assert.rejects(connect({ authorization: "Bearer faux" }), "faux jeton refusé");

  const ext = fakeExtension(t.port, "chrome-extension://fake");
  await ext.opened;

  // Bearer : mêmes outils que le shim, appel relayé avec le nom d'agent de l'URL.
  const client = await connect({ authorization: `Bearer ${t.token()}` });
  const { tools } = await client.listTools();
  assert.deepStrictEqual(tools.map((x) => x.name), TOOLS.map((x) => x.name), "mêmes outils, même ordre");
  assert.ok(client.getInstructions()?.includes("tabs_context"), "mêmes consignes");
  assert.strictEqual(textOf(await client.callTool({ name: "tabs_context", arguments: {} })), "echo http-test/tabs_context", "appel relayé");
  // Outil local (sans extension) : site_api list répond depuis le démon.
  assert.ok(textOf(await client.callTool({ name: "site_api", arguments: { action: "list" } })).includes("Site API vide"), "outil local");

  // x-abc-token accepté aussi.
  const client2 = await connect({ "x-abc-token": t.token() }, "autre");
  assert.strictEqual(textOf(await client2.callTool({ name: "tabs_context", arguments: {} })), "echo autre/tabs_context", "x-abc-token");

  // Réglage « browser_script désactivé » envoyé par l'extension : retiré de la liste.
  ext.ws.send(JSON.stringify({ type: "settings", settings: { scriptsEnabled: false }, extensionVersion: "0.0.0-test" }));
  await sleep(200);
  const filtered = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(!filtered.includes("browser_script") && filtered.length === TOOLS.length - 1, "browser_script filtré");

  // GET et DELETE : 405 (sans état), avec le jeton.
  for (const method of ["GET", "DELETE"]) {
    const res = await fetch(`${t.base}/mcp`, { method, headers: { authorization: `Bearer ${t.token()}`, accept: "text/event-stream" } });
    assert.strictEqual(res.status, 405, `${method} /mcp : 405`);
  }

  await client.close();
  await client2.close();
  ext.ws.close();
  stopped = await stopDaemon(t);
  assert.ok(stopped, "démon arrêté par /shutdown");
  console.log("mcp-http : OK (jeton, outils, consignes, agent, outil local, filtrage, 405, /shutdown)");
} finally {
  if (!stopped) child.kill();
  await sleep(300);
  t.cleanup();
}
