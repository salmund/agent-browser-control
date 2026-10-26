/**
 * Serveur MCP commun (server/mcp-server.ts), sans démon : la liste d'outils vient du démon quand il la fournit (un
 * shim démarré avant une mise à jour sert ainsi les nouveaux outils), sinon de ce code ; le filtrage des outils
 * désactivés et les descriptions calculées valent pour les deux.
 * Lancer avec : node test/mcp-server.ts
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createAbcServer } from "../server/mcp-server.ts";
import { TOOLS } from "../server/tools.ts";

async function noms(opts: { definitions?: () => Tool[] | null | Promise<Tool[] | null>; disabled?: string[]; describe?: Record<string, string> }) {
  const server = createAbcServer({
    info: { name: "essai", version: "0" },
    listChanged: true,
    disabled: () => new Set(opts.disabled ?? []),
    call: async () => ({ content: [] }),
    describe: () => opts.describe ?? null,
    definitions: opts.definitions,
  });
  const [cote, coteServeur] = InMemoryTransport.createLinkedPair();
  await server.connect(coteServeur);
  const client = new Client({ name: "essai", version: "0" });
  await client.connect(cote);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

const neuf: Tool = { name: "outil_neuf", description: "apparu après le démarrage du shim", inputSchema: { type: "object", properties: {} } };
const duDemon = [...TOOLS.filter((t) => t.name !== "site_api"), neuf];

// Sans définitions du démon : celles de ce code.
assert.strictEqual((await noms({})).length, TOOLS.length, "sans démon : les outils de ce code");
assert.strictEqual((await noms({ definitions: () => null })).length, TOOLS.length, "démon muet : repli sur ce code");
assert.strictEqual((await noms({ definitions: () => Promise.reject(new Error("coupé")) })).length, TOOLS.length, "erreur : repli sur ce code");

// Avec : la liste du démon fait foi (outil nouveau servi, outil retiré absent).
const servis = await noms({ definitions: () => duDemon, disabled: ["browser_script"], describe: { outil_neuf: "décrit par le démon" } });
const parNom = new Map(servis.map((t) => [t.name, t]));
assert.ok(parNom.has("outil_neuf"), "outil apparu côté démon servi");
assert.ok(!parNom.has("site_api"), "outil retiré côté démon absent");
assert.ok(!parNom.has("browser_script"), "outil désactivé retiré de la liste du démon aussi");
assert.strictEqual(parNom.get("outil_neuf")!.description, "décrit par le démon", "description calculée appliquée");
assert.strictEqual(servis.length, duDemon.length - 1);

console.log("mcp-server : OK (définitions du démon, repli, filtrage, descriptions)");
