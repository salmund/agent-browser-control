/**
 * Outillage des tests qui démarrent un démon : port libre, dossier de configuration
 * temporaire (jamais le vrai ~/.agent-browser-control), fausse extension, arrêt propre.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

/** Port TCP libre sur 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export interface TestEnv {
  port: number;
  dir: string;
  configDir: string;
  outputDir: string;
  env: Record<string, string>;
  base: string;
  token: () => string;
  cleanup: () => void;
}

/** Dossiers temporaires et variables d'environnement d'un démon de test. */
export async function testEnv(name: string, extra: Record<string, string> = {}): Promise<TestEnv> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), `abc-${name}-`));
  const configDir = join(dir, "config");
  const outputDir = join(dir, "sorties");
  const env = { ...(process.env as Record<string, string>), ABC_PORT: String(port), ABC_CONFIG_DIR: configDir, ABC_OUTPUT_DIR: outputDir, ...extra };
  return {
    port,
    dir,
    configDir,
    outputDir,
    env,
    base: `http://127.0.0.1:${port}`,
    token: () => readFileSync(join(configDir, "token"), "utf8").trim(),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

/** Démarre directement un démon (sans shim) et attend /health. */
export async function startDaemon(t: TestEnv): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["server/daemon.ts"], { env: t.env, stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await fetch(`${t.base}/health`).then((r) => r.ok).catch(() => false)) return child;
  }
  child.kill();
  throw new Error("le démon de test ne démarre pas");
}

/** Arrête le démon de test par /shutdown et attend qu'il ne réponde plus. */
export async function stopDaemon(t: TestEnv): Promise<boolean> {
  const res = await fetch(`${t.base}/shutdown`, { method: "POST", headers: { "x-abc-token": t.token() } }).catch(() => null);
  if (!res?.ok) return false;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (!(await fetch(`${t.base}/health`).then((r) => r.ok).catch(() => false))) return true;
  }
  return false;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Attend une condition (sondage), échoue après `ms`. */
export async function until(cond: () => boolean, ms = 5000, label = "condition"): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error(`délai dépassé : ${label}`);
}

export interface FakeExtension {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  closed: { code: number; reason: string } | null;
  opened: Promise<void>;
}

/**
 * Fausse extension : se connecte avec l'origine donnée, note les messages reçus et
 * répond aux appels via `answer` (null : ne répond pas, pour simuler un outil bloqué).
 */
export function fakeExtension(
  port: number,
  origin: string,
  answer: (msg: { id: number; agent: string; tool: string; args: Record<string, unknown> }) => unknown = (m) => ({
    content: [{ type: "text", text: `echo ${m.agent}/${m.tool}` }],
  }),
): FakeExtension {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, { origin });
  const ext: FakeExtension = { ws, messages: [], closed: null, opened: new Promise((r) => ws.once("open", () => r())) };
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    ext.messages.push(msg);
    if (typeof msg.id !== "number" || msg.type) return;
    const result = answer(msg);
    if (result !== null) ws.send(JSON.stringify({ id: msg.id, result }));
  });
  ws.on("close", (code, reason) => (ext.closed = { code, reason: reason.toString() }));
  ws.on("error", () => {});
  return ext;
}
