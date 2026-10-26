#!/usr/bin/env node
/**
 * Shim MCP stdio, à déclarer dans la config de chaque agent :
 *   node <chemin>/server/mcp.ts [--agent-name <nom>]
 * Relaie les appels d'outils au démon, qu'il démarre si nécessaire.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HOST, PORT, disabledToolNames, getToken, timeoutFor, type CallResult } from "./common.ts";
import { createAbcServer } from "./mcp-server.ts";
import { noticeFor } from "./notify.ts";

const SHIM_INFO = { name: "agent-browser-control", version: "0.9.0" };
/** Attente maximale d'une réponse du démon (ask_human peut durer 615 s). */
const SHIM_TIMEOUT_MAX_MS = 660_000;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Nom explicite, sinon celui annoncé par le client MCP à l'initialisation (ex. "claude-code"). */
function agentName(): string {
  return argValue("--agent-name") ?? process.env.ABC_AGENT_NAME ?? server.getClientVersion()?.name ?? "agent";
}

const token = getToken();

/** Erreur de connexion au démon (rien n'a été envoyé : relancer est sans risque). */
class DaemonUnreachable extends Error {}

/**
 * Requête HTTP au démon avec node:http et un délai explicite (fetch impose un délai
 * d'en-têtes implicite de 300 s, trop court pour ask_human).
 */
function daemonRequest(method: string, path: string, opts: { body?: string; timeoutMs: number; auth?: boolean }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.auth) headers["x-abc-token"] = token;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(opts.body));
    }
    const req = request({ host: HOST, port: PORT, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(opts.timeoutMs, () => req.destroy(Object.assign(new Error("timeout"), { code: "ABC_TIMEOUT" })));
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") reject(new DaemonUnreachable(err.message));
      else reject(err);
    });
    req.end(opts.body);
  });
}

interface Health {
  version?: string;
  inflight?: number;
  settings?: { scriptsEnabled?: boolean };
  skillsVersion?: string;
}

async function health(timeoutMs = 1000): Promise<Health | null> {
  try {
    const res = await daemonRequest("GET", "/health", { timeoutMs });
    return res.status === 200 ? (JSON.parse(res.text) as Health) : null;
  } catch {
    return null;
  }
}

/** Version de l'installation sur disque (celle du démon que ce shim démarrerait). */
function installedVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || SHIM_INFO.version;
  } catch {
    return SHIM_INFO.version;
  }
}

async function waitDaemonDown(maxMs = 12_000): Promise<void> {
  for (const end = Date.now() + maxMs; Date.now() < end; ) {
    if (!(await health(500))) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Démarre le démon s'il ne répond pas. Un démon d'une autre version que l'installation
 * (code mis à jour, démon resté sur l'ancien) est redémarré s'il est inactif.
 */
async function ensureDaemon(): Promise<void> {
  const h = await health();
  if (h) {
    const expected = installedVersion();
    if (!h.version || h.version === expected || (h.inflight ?? 0) > 0) return;
    console.error(`Démon ${h.version}, installation ${expected} : redémarrage du démon inactif.`);
    const res = await daemonRequest("POST", "/shutdown", { timeoutMs: 2000, auth: true }).catch(() => null);
    if (!res || res.status !== 200) return; // démon trop ancien pour /shutdown : on le garde.
    await waitDaemonDown();
  }
  const daemonPath = fileURLToPath(new URL("./daemon.ts", import.meta.url));
  spawn(process.execPath, [daemonPath], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await health()) return;
  }
  throw new Error("Impossible de démarrer le démon Agent Browser Control.");
}

/** Vérification du démon : au premier appel, puis seulement après une erreur de connexion. */
let daemonChecked = false;
// Identifie cette session auprès du démon : le catalogue et les rappels « une fois » valent par session.
const SESSION = randomUUID().slice(0, 12);

async function call(tool: string, args: Record<string, unknown>): Promise<CallResult> {
  if (!daemonChecked) {
    await ensureDaemon();
    daemonChecked = true;
  }
  const body = JSON.stringify({ agent: agentName(), tool, args, session: SESSION });
  const timeoutMs = Math.min(timeoutFor(tool, args) + 30_000, SHIM_TIMEOUT_MAX_MS);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await daemonRequest("POST", "/call", { body, timeoutMs, auth: true });
      // Démon en cours d'arrêt (mise à jour) : l'appel n'a pas été exécuté, on relance sur le nouveau.
      if (res.status === 503 && attempt === 0 && /arrêt/.test(res.text)) {
        await waitDaemonDown();
        await ensureDaemon();
        continue;
      }
      if (res.status !== 200) throw new Error(`Démon : HTTP ${res.status} ${res.text}`);
      return JSON.parse(res.text) as CallResult;
    } catch (err) {
      if (err instanceof DaemonUnreachable && attempt === 0) {
        daemonChecked = false;
        await ensureDaemon();
        daemonChecked = true;
        continue;
      }
      daemonChecked = false;
      if ((err as NodeJS.ErrnoException).code === "ABC_TIMEOUT") {
        throw new Error(`Pas de réponse du démon en ${Math.round(timeoutMs / 1000)} s : l'action a pu être exécutée, vérifier avant de relancer.`);
      }
      if (err instanceof DaemonUnreachable) throw new Error("Démon Agent Browser Control injoignable.");
      if ((err as NodeJS.ErrnoException).code === "ECONNRESET") {
        throw new Error("Connexion au démon perdue pendant l'appel : l'action a pu être exécutée, vérifier avant de relancer.");
      }
      throw err;
    }
  }
}

/** Dernier réglage connu (browser_script désactivé ou non), lu dans /health. */
let lastSettings: Health["settings"] | undefined;
let lastSkillsVersion: string | undefined;

/** Outils que l'utilisateur a désactivés dans le panneau de l'extension (browser_script, activé par défaut). */
async function disabledTools(): Promise<Set<string> | null> {
  const h = await health(2000);
  if (!h) return null;
  lastSettings = h.settings;
  lastSkillsVersion = h.skillsVersion;
  return new Set(disabledToolNames(h.settings));
}

/** Descriptions calculées par le démon : le catalogue des fonctions apprises dans celle de l'outil skill. */
async function toolDescriptions(): Promise<Record<string, string> | null> {
  try {
    const res = await daemonRequest("GET", "/skills", { timeoutMs: 2000, auth: true });
    if (res.status !== 200) return null;
    const body = JSON.parse(res.text) as { descriptions?: Record<string, string> };
    return body.descriptions ?? null;
  } catch {
    return null;
  }
}

const server = createAbcServer({
  info: SHIM_INFO,
  listChanged: true,
  disabled: async () => (await disabledTools()) ?? new Set(disabledToolNames(lastSettings)),
  call,
  describe: toolDescriptions,
});

// Si l'utilisateur change le réglage pendant la session, ou si une fonction est enregistrée, on prévient l'agent
// que la liste a changé. null au départ : le premier relevé sert de référence.
let lastDisabled: string | null = null;
let lastSkills: string | null = null;
setInterval(async () => {
  const set = await disabledTools();
  if (!set) return; // démon injoignable : on garde la dernière référence.
  const current = [...set].join(",");
  const skills = lastSkillsVersion ?? "";
  const changed = (lastDisabled !== null && current !== lastDisabled) || (lastSkills !== null && skills !== lastSkills);
  if (changed) server.sendToolListChanged().catch(() => {});
  lastDisabled = current;
  lastSkills = skills;
}, 3000).unref();

/**
 * Suit GET /events du démon et pousse à l'agent les événements qui le concernent (surveillance déclenchée,
 * navigateur déconnecté) en notifications MCP : plus besoin de sonder watch en boucle. Se reconnecte seul.
 */
function followDaemonEvents(): void {
  let delay = 2000;
  const retry = () => {
    const t = setTimeout(connect, delay);
    t.unref();
    delay = Math.min(delay * 2, 30_000);
  };
  const connect = () => {
    const req = request({ host: HOST, port: PORT, path: "/events", method: "GET", headers: { "x-abc-token": token } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return retry();
      }
      delay = 2000;
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (chunk: string) => {
        buf += chunk;
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = /^data: (.*)$/m.exec(block);
          if (!m) continue;
          try {
            const notice = noticeFor(JSON.parse(m[1]) as Record<string, unknown>, agentName());
            if (notice) server.sendLoggingMessage({ level: notice.level, logger: "agent-browser-control", data: notice.data }).catch(() => {});
          } catch {
            // ligne illisible : ignorée
          }
        }
      });
      res.on("end", retry);
      res.on("error", retry);
    });
    req.on("error", retry);
    req.on("socket", (s) => s.unref());
    req.end();
  };
  connect();
}

await ensureDaemon()
  .then(() => {
    daemonChecked = true;
  })
  .catch((err) => console.error(err.message));
await server.connect(new StdioServerTransport());
followDaemonEvents();
