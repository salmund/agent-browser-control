/**
 * Démon Agent Browser Control.
 * Point de rendez-vous entre les shims MCP (HTTP, authentifiés par jeton)
 * et l'extension du navigateur (WebSocket, origine chrome-extension://).
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { CONFIG_DIR, HOST, PORT, getToken, type CallRequest, type CallResult } from "./common.ts";

const VERSION = "0.4.0";
const CALL_TIMEOUT_MS = 90_000;
const SCRIPT_TIMEOUT_MS = 295_000;
const EXTENSION_WAIT_MS = 10_000;
const LOG_FILE = join(CONFIG_DIR, "actions.log");
const OUTPUT_DIR = join(homedir(), "Downloads", "agent-browser-control");

const token = getToken();

let extension: WebSocket | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: CallResult) => void; timer: NodeJS.Timeout }>();
const extensionWaiters = new Set<() => void>();

function log(entry: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry });
  console.error(line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

function errorResult(text: string): CallResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Attend que l'extension soit connectée (le service worker MV3 peut être en train de se réveiller). */
function waitForExtension(): Promise<boolean> {
  if (extension) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      extensionWaiters.delete(done);
      resolve(extension !== null);
    };
    const timer = setTimeout(done, EXTENSION_WAIT_MS);
    extensionWaiters.add(done);
  });
}

async function forward(req: CallRequest): Promise<CallResult> {
  if (!(await waitForExtension())) {
    return errorResult(
      "L'extension Agent Browser Control n'est pas connectée. Vérifie que le navigateur est ouvert " +
        "et que l'extension est chargée et activée.",
    );
  }
  const id = nextId++;
  // Un script d'agent dure plus longtemps qu'un outil : son propre délai, plus une marge.
  const timeoutMs = req.tool === "browser_script" ? SCRIPT_TIMEOUT_MS : CALL_TIMEOUT_MS;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(errorResult(`Délai dépassé (${timeoutMs / 1000}s) pour l'outil ${req.tool}.`));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    extension!.send(JSON.stringify({ id, ...req }));
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  // Toute requête venant d'une page web porte un en-tête Origin : on refuse.
  if (req.headers.origin) return sendJson(res, 403, { error: "forbidden" });

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { ok: true, version: VERSION, extensionConnected: extension !== null });
  }

  if (req.method === "POST" && req.url === "/reload-extension") {
    if (req.headers["x-abc-token"] !== token) return sendJson(res, 401, { error: "bad token" });
    if (!extension) return sendJson(res, 503, { error: "extension non connectée" });
    extension.send(JSON.stringify({ type: "reload" }));
    log({ event: "extension_reload_requested" });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && req.url === "/call") {
    if (req.headers["x-abc-token"] !== token) return sendJson(res, 401, { error: "bad token" });
    let call: CallRequest;
    try {
      call = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "bad json" });
    }
    const started = Date.now();
    const result = await forward(call);
    log({ agent: call.agent, tool: call.tool, args: redact(call.args), ms: Date.now() - started, error: !!result.isError });
    return sendJson(res, 200, result);
  }

  sendJson(res, 404, { error: "not found" });
});

/** Évite d'écrire le texte saisi en clair dans le journal. */
function redact(args: Record<string, unknown>) {
  if (typeof args?.text === "string" && args.action === "type") return { ...args, text: `<${args.text.length} car.>` };
  if (args?.value !== undefined) return { ...args, value: "<masqué>" };
  return args;
}

/**
 * L'extension peut joindre un fichier (ex. GIF) sous `_file` : le démon l'écrit dans
 * ~/Downloads/agent-browser-control/ et remplace `{path}` dans le texte par le chemin final.
 */
function saveAttachedFile(result: CallResult): CallResult {
  const file = result._file as { name: string; base64: string } | undefined;
  if (!file) return result;
  delete result._file;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const ext = extname(file.name);
  const stem = basename(file.name, ext).replace(/[^\w.-]+/g, "_") || "fichier";
  let path = join(OUTPUT_DIR, stem + ext);
  for (let i = 2; existsSync(path); i++) path = join(OUTPUT_DIR, `${stem}-${i}${ext}`);
  writeFileSync(path, Buffer.from(file.base64, "base64"));
  for (const item of result.content) if (item.type === "text") item.text = item.text.replace("{path}", path);
  return result;
}

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin ?? "";
  if (req.url !== "/ext" || !origin.startsWith("chrome-extension://")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  if (extension && extension !== ws) extension.close(1000, "replaced");
  extension = ws;
  log({ event: "extension_connected", origin: req.headers.origin });
  for (const w of [...extensionWaiters]) w();

  ws.on("message", (raw) => {
    let msg: { id?: number; result?: CallResult; type?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
    if (typeof msg.id !== "number") return;
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    p.resolve(msg.result ? saveAttachedFile(msg.result) : errorResult("Réponse vide de l'extension."));
  });

  ws.on("close", () => {
    if (extension !== ws) return;
    extension = null;
    log({ event: "extension_disconnected" });
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.resolve(errorResult("L'extension s'est déconnectée pendant l'appel."));
      pending.delete(id);
    }
  });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} déjà utilisé : un démon tourne probablement déjà.`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, HOST, () => log({ event: "daemon_started", version: VERSION, port: PORT }));
