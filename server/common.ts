import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOST = "127.0.0.1";
export const PORT = Number(process.env.ABC_PORT ?? 7878);
export const BASE_URL = `http://${HOST}:${PORT}`;

export const CONFIG_DIR = join(homedir(), ".agent-browser-control");
const TOKEN_FILE = join(CONFIG_DIR, "token");

/** Jeton partagé entre le démon et les shims MCP. Créé au premier lancement. */
export function getToken(): string {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
  return readFileSync(TOKEN_FILE, "utf8").trim();
}

/** Requête envoyée par un shim MCP au démon. */
export interface CallRequest {
  agent: string;
  tool: string;
  args: Record<string, unknown>;
}

/** Réglages de l'utilisateur (panneau de l'extension), persistés par le démon. */
export interface UserSettings {
  scriptsEnabled: boolean;
}

/**
 * Réglages effectifs : tout ce qui n'est pas explicitement désactivé est activé
 * (browser_script est activé par défaut ; seul un `false` explicite le coupe).
 */
export function normalizeSettings(saved: unknown): UserSettings {
  const flag = (saved as { scriptsEnabled?: unknown } | null | undefined)?.scriptsEnabled;
  return { scriptsEnabled: flag !== false };
}

/** Noms des outils à retirer de la liste MCP selon les réglages (browser_script si désactivé). */
export function disabledToolNames(settings: { scriptsEnabled?: unknown } | undefined): string[] {
  return settings?.scriptsEnabled === false ? ["browser_script"] : [];
}

/** Contenu MCP renvoyé par l'extension. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface CallResult {
  [key: string]: unknown;
  content: ToolContent[];
  isError?: boolean;
}
