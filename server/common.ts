import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const HOST = "127.0.0.1";
export const PORT = Number(process.env.ABC_PORT ?? 7878);
export const BASE_URL = `http://${HOST}:${PORT}`;

/**
 * Dossier de configuration (jeton, journal, réglages, HAR, épinglage de l'extension).
 * ABC_CONFIG_DIR le remplace : les tests qui démarrent un démon tournent ainsi dans un
 * dossier temporaire, sans toucher au vrai ~/.agent-browser-control.
 */
export const CONFIG_DIR = process.env.ABC_CONFIG_DIR ? resolve(process.env.ABC_CONFIG_DIR) : join(homedir(), ".agent-browser-control");
const TOKEN_FILE = join(CONFIG_DIR, "token");

/** Origine de la première extension acceptée (confiance au premier usage). */
export const EXTENSION_ORIGIN_FILE = join(CONFIG_DIR, "extension-origin");

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

/** Nom d'agent sûr (nom du groupe d'onglets) : chaîne courte, « agent » par défaut. */
export function cleanAgent(value: unknown): string {
  const name = typeof value === "string" ? value.trim().slice(0, 64) : "";
  return name || "agent";
}

/** Valide le corps d'un appel (/call) : objet avec `tool` chaîne, `args` objet facultatif. null sinon. */
export function parseCallRequest(body: unknown): CallRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (typeof o.tool !== "string" || !o.tool.trim() || o.tool.length > 100) return null;
  const args = o.args ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return { agent: cleanAgent(o.agent), tool: o.tool, args: args as Record<string, unknown> };
}

// --- Délais par outil -----------------------------------------------------------------------------

export const DEFAULT_CALL_TIMEOUT_MS = 90_000;
export const SCRIPT_TIMEOUT_MS = 295_000;
export const ASK_TIMEOUT_MAX_MS = 615_000;
/** Marge ajoutée au délai propre d'un outil (le temps de répondre après son attente). */
const MARGIN_MS = 15_000;

const num = (v: unknown, fallback: number) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? fallback : n;
};
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/**
 * Délai d'attente du démon pour un appel, en ms : calé sur l'attente propre de l'outil
 * (mêmes défauts et plafonds que l'extension) plus une marge, 90 s par défaut.
 */
export function timeoutFor(tool: string, args: Record<string, unknown> = {}): number {
  const a = args ?? {};
  switch (tool) {
    case "wait_for": {
      // authSettled : défaut 120 s et plafond 300 s côté extension ; sinon défaut 10 s, plafond 60 s.
      const auth = a.authSettled === true;
      const seconds = clamp(num(a.timeout, auth ? 120 : 10), 0.5, auth ? 300 : 60);
      return seconds * 1000 + MARGIN_MS;
    }
    case "downloads":
      // download et wait attendent tous deux la fin du téléchargement (défaut 60 s, plafond 280 s).
      if (a.action === "wait" || a.action === "download") return Math.min(clamp(num(a.timeout, 60), 1, 280) * 1000 + MARGIN_MS, 295_000);
      return DEFAULT_CALL_TIMEOUT_MS;
    case "gif_creator":
      return a.action === "export" ? 600_000 : DEFAULT_CALL_TIMEOUT_MS;
    case "replay_paginated":
      return Math.min(clamp(Math.trunc(num(a.maxPages, 10)) || 10, 1, 50) * 15_000 + MARGIN_MS, 300_000);
    case "ask_human":
      return Math.min(Math.max(num(a.timeout, 300) * 1000, 10_000) + MARGIN_MS, ASK_TIMEOUT_MAX_MS);
    case "captcha_solve":
      // Résolution complète : case + rondes image (vision) ; large pour les cas difficiles.
      return 600_000;
    case "browser_script":
      return SCRIPT_TIMEOUT_MS;
    case "credentials_fill":
      // Peut attendre l'utilisateur deux fois : déverrouiller son coffre (120 s), puis approuver (75 s).
      return 120_000 + 75_000 + MARGIN_MS;
    case "computer":
      return a.action === "screenshot" ? 30_000 : DEFAULT_CALL_TIMEOUT_MS;
    default:
      return DEFAULT_CALL_TIMEOUT_MS;
  }
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
