/**
 * Serveur MCP d'Agent Browser Control, commun au shim stdio (server/mcp.ts) et à
 * l'endpoint HTTP natif du démon (/mcp) : mêmes définitions d'outils, même filtrage
 * selon les réglages, mêmes consignes. Seuls le transport et l'appel diffèrent.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallResult } from "./common.ts";
import { SERVER_INSTRUCTIONS, TOOLS } from "./tools.ts";

export interface AbcServerOptions {
  info: { name: string; version: string };
  /** Le transport sait-il annoncer un changement de liste (stdio oui, HTTP sans état non) ? */
  listChanged: boolean;
  /** Outils désactivés par l'utilisateur (browser_script), retirés de la liste. */
  disabled: () => Set<string> | Promise<Set<string>>;
  /** Exécute un outil ; une exception devient un résultat en erreur. */
  call: (tool: string, args: Record<string, unknown>) => Promise<CallResult>;
  /** Descriptions calculées (catalogue des fonctions dans celle de skill) ; null ou absent : descriptions fixes. */
  describe?: () => Record<string, string> | null | Promise<Record<string, string> | null>;
  /** Définitions du démon en service (shim stdio, peut-être plus ancien que lui) ; null ou absent : celles de ce code. */
  definitions?: () => Tool[] | null | Promise<Tool[] | null>;
}

export function createAbcServer(opts: AbcServerOptions): Server {
  const server = new Server(opts.info, {
    capabilities: { tools: { listChanged: opts.listChanged }, logging: {} },
    instructions: SERVER_INSTRUCTIONS,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const disabled = await opts.disabled();
    const described = (await Promise.resolve(opts.describe?.()).catch(() => null)) ?? {};
    const tools = (await Promise.resolve(opts.definitions?.()).catch(() => null)) ?? TOOLS;
    return {
      tools: tools.filter((t) => !disabled.has(t.name)).map((t) => (described[t.name] ? { ...t, description: described[t.name] } : t)),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await opts.call(req.params.name, req.params.arguments ?? {});
    } catch (err) {
      return { content: [{ type: "text", text: String(err instanceof Error ? err.message : err) }], isError: true };
    }
  });
  return server;
}
