/**
 * HAR persistant : l'extension pousse chaque requête terminée d'un onglet de l'agent (en-têtes, corps
 * textuels), le démon l'écrit sur disque. L'enregistrement survit au rechargement de l'extension et à la
 * navigation : on peut étudier un parcours après coup, ou re-dériver un client quand un site change.
 *
 * Un HAR contient des sessions actives (cookies, jetons). Par construction :
 * - un fichier par onglet dans ~/.agent-browser-control/har/, droits 0600, jamais dans le dépôt ;
 * - supprimé à la fermeture de l'onglet, sauf `keep` ; un fichier abandonné (navigateur fermé) est purgé
 *   après 24 h ;
 * - l'export vers Téléchargements masque les secrets par défaut ;
 * - les corps d'envoi (postData) sont masqués dès l'écriture (clés sensibles : mots de passe, jetons).
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR } from "./common.ts";
import { buildCurl, buildPython, inferSchema } from "./analysis.ts";
import { ABC_DOWNLOADS_DIR } from "./user-dirs.ts";

export const HAR_DIR = join(CONFIG_DIR, "har");
const KEPT_DIR = join(HAR_DIR, "gardes");
const EXPORT_DIR = ABC_DOWNLOADS_DIR;
const STALE_MS = 24 * 3600_000;
const MAX_FILE_BYTES = 200 * 1024 * 1024; // au-delà, on ne garde plus les corps de réponse

export interface HarEntry {
  id: string;
  t: number; // début, ms epoch
  duration?: number; // ms
  method: string;
  url: string;
  type?: string;
  page?: string; // URL du document à l'origine de la requête
  status?: number;
  statusText?: string;
  httpVersion?: string;
  mimeType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  body?: string; // corps de réponse (texte)
  bodyTruncated?: boolean;
  error?: string;
}

interface Meta {
  tabId: number;
  created: number;
  updated: number;
  keep: boolean;
  label?: string;
}

const entriesFile = (tabId: number) => join(HAR_DIR, `${tabId}.jsonl`);
const metaFile = (tabId: number) => join(HAR_DIR, `${tabId}.json`);

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * État en mémoire des onglets enregistrés : métadonnées (écrites en différé), taille du
 * fichier et existence. Une requête ne coûte plus qu'une écriture disque : l'ajout.
 */
interface TabState {
  meta: Meta;
  size: number;
  fileExists: boolean;
  dirty: boolean;
}
const tabs = new Map<number, TabState>();
const META_FLUSH_MS = 2000;
let flushTimer: NodeJS.Timeout | null = null;

function readMetaFile(tabId: number): Meta | null {
  try {
    return JSON.parse(readFileSync(metaFile(tabId), "utf8"));
  } catch {
    return null;
  }
}

function readMeta(tabId: number): Meta | null {
  return tabs.get(tabId)?.meta ?? readMetaFile(tabId);
}

function writeMeta(meta: Meta) {
  writeFileSync(metaFile(meta.tabId), JSON.stringify(meta), { mode: 0o600 });
}

function tabState(tabId: number): TabState {
  let state = tabs.get(tabId);
  if (!state) {
    let size = 0;
    let fileExists = false;
    try {
      size = statSync(entriesFile(tabId)).size;
      fileExists = true;
    } catch {}
    const meta = readMetaFile(tabId) ?? { tabId, created: Date.now(), updated: 0, keep: false };
    state = { meta, size, fileExists, dirty: false };
    tabs.set(tabId, state);
  }
  return state;
}

/** Écrit les métadonnées en attente (en différé, et à l'arrêt du démon). */
export function flushMeta() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  for (const state of tabs.values()) {
    if (!state.dirty) continue;
    state.dirty = false;
    try {
      ensureDir(HAR_DIR);
      writeMeta(state.meta);
    } catch {}
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushMeta, META_FLUSH_MS);
  flushTimer.unref();
}

/** Ajoute une requête terminée à l'enregistrement de l'onglet (corps d'envoi masqué dès l'écriture). */
export function appendEntry(tabId: number, entry: HarEntry) {
  if (!Number.isInteger(tabId) || !entry || typeof entry !== "object" || typeof entry.url !== "string" || !entry.url) return;
  const state = tabState(tabId);
  let e: HarEntry = typeof entry.postData === "string" ? { ...entry, postData: maskBody(entry.postData) } : entry;
  if (state.fileExists && e.body && state.size > MAX_FILE_BYTES) e = { ...e, body: undefined, bodyTruncated: true };
  const line = JSON.stringify(e) + "\n";
  const file = entriesFile(tabId);
  try {
    appendFileSync(file, line, { mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    ensureDir(HAR_DIR);
    appendFileSync(file, line, { mode: 0o600 });
  }
  if (!state.fileExists) {
    state.fileExists = true;
    try {
      chmodSync(file, 0o600);
    } catch {}
  }
  state.size += Buffer.byteLength(line);
  state.meta.updated = Date.now();
  state.dirty = true;
  scheduleFlush();
}

/** Onglet fermé : l'enregistrement est supprimé, sauf s'il a été gardé (il part dans gardes/). */
export function closeTab(tabId: number) {
  const meta = readMeta(tabId);
  tabs.delete(tabId);
  if (!meta) return;
  if (meta.keep) {
    ensureDir(KEPT_DIR);
    const name = savedName(meta);
    if (existsSync(entriesFile(tabId))) renameSync(entriesFile(tabId), join(KEPT_DIR, `${name}.jsonl`));
    writeFileSync(join(KEPT_DIR, `${name}.json`), JSON.stringify(meta), { mode: 0o600 });
  }
  for (const f of [entriesFile(tabId), metaFile(tabId)]) if (existsSync(f)) unlinkSync(f);
}

function savedName(meta: Meta) {
  const d = new Date(meta.created);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}h${pad(d.getMinutes())}`;
  const label = (meta.label ?? "").replace(/[^\w.-]+/g, "_").slice(0, 60);
  return `${date}-onglet${meta.tabId}${label ? `-${label}` : ""}`;
}

/** Enregistrements abandonnés (navigateur fermé sans fermer l'onglet) : purgés après 24 h. */
export function purgeStale() {
  if (!existsSync(HAR_DIR)) return;
  for (const name of readdirSync(HAR_DIR)) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const meta = readMeta(Number(m[1]));
    if (meta && !meta.keep && Date.now() - meta.updated > STALE_MS) closeTab(meta.tabId);
  }
}

/** Requêtes enregistrées d'un onglet (ou d'un enregistrement gardé), lues sans bloquer le démon. */
export async function readEntries(tabId: number, saved?: string): Promise<HarEntry[]> {
  const file = saved ? join(KEPT_DIR, `${saved.replace(/[\\/]/g, "")}.jsonl`) : entriesFile(tabId);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: HarEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export function savedRecordings(): string[] {
  if (!existsSync(KEPT_DIR)) return [];
  return readdirSync(KEPT_DIR).filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -6)).sort();
}

// --- Secrets ----------------------------------------------------------------------------------------

const SENSITIVE = /(cookie|token|csrf|xsrf|authoriz|auth[-_]|password|passwd|secret|api[-_]?key|session|sessid|jwt|signature)/i;
const mask = (v: string) => (/^<masqué, \d+ car\.>$/.test(v) ? v : `<masqué, ${v.length} car.>`);

/** Dans un texte quelconque (URL, chemin, en-tête Referer…), les paramètres `clé=valeur` sensibles. */
export function maskPairs(text: string) {
  return text.replace(/([?&;,\s]|^)([\w.\[\]-]+)=([^&#\s"';,]*)/g, (all, sep, key, value) =>
    SENSITIVE.test(key) && value ? `${sep}${key}=${encodeURIComponent(mask(decodeURIComponentSafe(value)))}` : all);
}

function decodeURIComponentSafe(v: string) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export function maskHeaders(h: Record<string, string> = {}) {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, SENSITIVE.test(k) ? mask(String(v)) : maskPairs(String(v))]));
}

const maskUrl = maskPairs;

/**
 * Corps JSON ou formulaire : valeurs des clés sensibles masquées, y compris dans les JSON glissés dans une
 * chaîne et les URL citées dans le texte ; un autre format passe par le masquage des couples clé=valeur.
 */
export function maskBody(body?: string): string | undefined {
  if (!body) return body;
  const walk = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === "object") {
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, SENSITIVE.test(k) && v !== null && typeof v !== "object" ? mask(String(v)) : walk(v)]));
    }
    if (typeof o === "string") {
      if (/^\s*[{[]/.test(o)) {
        try {
          return JSON.stringify(walk(JSON.parse(o)));
        } catch {}
      }
      return maskPairs(o);
    }
    return o;
  };
  try {
    return JSON.stringify(walk(JSON.parse(body)));
  } catch {}
  return maskPairs(body);
}

// --- Présentation -----------------------------------------------------------------------------------

export function listText(entries: HarEntry[], urlPattern?: string, limit = 100) {
  const re = urlPattern ? new RegExp(urlPattern, "i") : null;
  const list = entries.filter((e) => !re || re.test(e.url));
  const shown = list.slice(-limit);
  if (!shown.length) return null;
  const lines = shown.map((e) => {
    const status = e.error ? `ERR ${e.error}` : e.status ?? "…";
    return `${e.id}  ${e.method} ${status} ${e.type ? `[${e.type}] ` : ""}${e.url.slice(0, 300)}${e.body ? "  (corps enregistré)" : ""}`;
  });
  const header = `${shown.length < list.length ? `${shown.length} dernières sur ${list.length}` : `${list.length}`} requête(s) du HAR persistant`;
  return `${header} (id, méthode, statut, type, URL ; corps via devtools action="har" op="body") :\n${lines.join("\n")}`;
}

/**
 * Derniers corps de réponse correspondant au motif : la lecture officielle des SPA,
 * dont le DOM ne montre presque rien. Secrets masqués, schéma des JSON, tronqué à 4000 car.
 */
export function bodiesText(entries: HarEntry[], urlPattern?: string, limit = 5) {
  const re = urlPattern ? new RegExp(urlPattern, "i") : null;
  const list = entries.filter((e) => e.body && (!re || re.test(e.url)));
  const shown = list.slice(-Math.max(1, Math.min(limit || 5, 20)));
  if (!shown.length) return null;
  const lines = shown.map((e) => {
    let body = maskBody(e.body) ?? "";
    let schema = "";
    if (/json/i.test(e.mimeType ?? "")) {
      try {
        schema = `\nschéma : ${inferSchema(JSON.parse(e.body ?? ""))}`;
      } catch {}
      try {
        body = JSON.stringify(JSON.parse(body), null, 1);
      } catch {}
    }
    const cut = body.length > 4000;
    return `--- ${e.id} ${e.method} ${e.status ?? ""} ${e.url.slice(0, 300)}${schema}\n${cut ? body.slice(0, 4000) + "\n[…tronqué…]" : body}`;
  });
  return `${shown.length} dernier(s) corps sur ${list.length} correspondant(s) (secrets masqués) :\n${lines.join("\n")}`;
}

/** Choisit une requête : requestId exact, sinon la plus récente qui matche urlPattern. */
export function pickEntry(entries: HarEntry[], opts: { requestId?: string; urlPattern?: string }): HarEntry | null {
  if (opts.requestId) return [...entries].reverse().find((x) => x.id === opts.requestId) ?? null;
  if (opts.urlPattern) {
    let re: RegExp;
    try {
      re = new RegExp(opts.urlPattern, "i");
    } catch {
      return null;
    }
    return [...entries].reverse().find((x) => re.test(x.url)) ?? null;
  }
  return null;
}

/**
 * Requête rejouable en curl et/ou Python requests : l'agent repart avec un script au lieu
 * de re-cliquer. URL, en-têtes et corps d'envoi masqués comme à l'export (clés sensibles) ;
 * cookies du navigateur jamais copiés (à reprendre de la session).
 */
export function exportCodeText(entry: HarEntry, format = "both"): string {
  const req = {
    method: entry.method || "GET",
    url: maskUrl(entry.url),
    headers: maskHeaders(entry.requestHeaders),
    ...(entry.postData ? { body: maskBody(entry.postData) } : {}),
  };
  const head = `${entry.method} ${maskUrl(entry.url).slice(0, 300)}${entry.status ? ` → ${entry.status}` : ""}`;
  const f = (format || "both").toLowerCase();
  if (f === "curl") return `${head}\n\n${buildCurl(req)}`;
  if (f === "python") return `${head}\n\n${buildPython(req)}`;
  return `${head}\n\n--- curl ---\n${buildCurl(req)}\n\n--- python ---\n${buildPython(req)}`;
}

export function bodyText(entries: HarEntry[], requestId: string) {
  const e = [...entries].reverse().find((x) => x.id === requestId);
  if (!e) return null;
  // Masqué comme dans bodiesText : jetons et mots de passe des corps JSON ou formulaires.
  let body = maskBody(e.body) ?? "";
  if (!body) return `${e.method} ${e.status ?? ""} ${e.url}\nCorps de réponse non enregistré (${e.bodyTruncated ? "enregistrement trop volumineux" : e.mimeType || "type non textuel ou ressource statique"}).`;
  if (/json/i.test(e.mimeType ?? "")) {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {}
  }
  const cut = body.length > 50_000;
  return { header: `${e.method} ${e.status ?? ""} ${e.url}\nType : ${e.mimeType || "inconnu"} (HAR persistant)${cut || e.bodyTruncated ? " (tronqué)" : ""}`, body: cut ? body.slice(0, 50_000) : body };
}

export async function statusText(tabId: number) {
  const meta = readMeta(tabId);
  const entries = await readEntries(tabId);
  const saved = savedRecordings();
  const size = tabs.get(tabId)?.size ?? (existsSync(entriesFile(tabId)) ? statSync(entriesFile(tabId)).size : 0);
  const head = meta
    ? `HAR de l'onglet ${tabId} : ${entries.length} requête(s), ${(size / 1024 / 1024).toFixed(1).replace(".", ",")} Mo, ` +
      `du ${new Date(meta.created).toLocaleString("fr-FR")} au ${new Date(meta.updated).toLocaleString("fr-FR")}. ` +
      (meta.keep ? `Gardé à la fermeture de l'onglet${meta.label ? ` (« ${meta.label} »)` : ""}.` : "Supprimé à la fermeture de l'onglet (keep pour le garder).")
    : `Rien d'enregistré pour l'onglet ${tabId} (l'enregistrement commence quand l'agent agit sur l'onglet).`;
  return `${head}\nEnregistrements gardés : ${saved.length ? saved.join(", ") : "aucun"}.`;
}

export function setKeep(tabId: number, keep: boolean, label?: string) {
  const state = tabState(tabId);
  const meta = state.meta;
  if (!meta.updated) meta.updated = Date.now();
  meta.keep = keep;
  if (label) meta.label = label;
  ensureDir(HAR_DIR);
  writeMeta(meta);
  state.dirty = false;
  return keep
    ? `Le HAR de l'onglet ${tabId} sera gardé à sa fermeture (dans ${KEPT_DIR}). Il contient des sessions : à supprimer quand il ne sert plus.`
    : `Le HAR de l'onglet ${tabId} sera supprimé à sa fermeture.`;
}

/** Supprime un enregistrement gardé. */
export function deleteSaved(name: string) {
  const stem = join(KEPT_DIR, name.replace(/[\\/]/g, ""));
  const found = [`${stem}.jsonl`, `${stem}.json`].filter((f) => existsSync(f));
  for (const f of found) unlinkSync(f);
  return found.length ? `Enregistrement gardé « ${name} » supprimé.` : `Aucun enregistrement gardé nommé « ${name} ».`;
}

export function clearTab(tabId: number) {
  const meta = readMeta(tabId);
  tabs.delete(tabId);
  for (const f of [entriesFile(tabId), metaFile(tabId)]) if (existsSync(f)) unlinkSync(f);
  return meta ? `HAR de l'onglet ${tabId} effacé.` : `Rien à effacer pour l'onglet ${tabId}.`;
}

/** Export au format HAR 1.2 dans Téléchargements ; secrets masqués sauf demande explicite. */
export function exportHar(entries: HarEntry[], name: string, includeSecrets: boolean) {
  ensureDir(EXPORT_DIR);
  const pairs = (h: Record<string, string> = {}) => Object.entries(h).map(([name, value]) => ({ name, value: String(value) }));
  const har = {
    log: {
      version: "1.2",
      creator: { name: "Agent Browser Control", version: "0.10.1" },
      pages: [],
      entries: entries.map((e) => {
        const url = includeSecrets ? e.url : maskUrl(e.url);
        const reqH = includeSecrets ? e.requestHeaders : maskHeaders(e.requestHeaders);
        const resH = includeSecrets ? e.responseHeaders : maskHeaders(e.responseHeaders);
        const post = includeSecrets ? e.postData : maskBody(e.postData);
        const body = includeSecrets ? e.body : maskBody(e.body);
        let query: { name: string; value: string }[] = [];
        try {
          query = [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
        } catch {}
        return {
          startedDateTime: new Date(e.t).toISOString(),
          time: e.duration ?? 0,
          request: {
            method: e.method, url, httpVersion: e.httpVersion ?? "", headers: pairs(reqH), queryString: query, cookies: [],
            headersSize: -1, bodySize: post ? post.length : 0,
            ...(post ? { postData: { mimeType: reqH?.["content-type"] ?? reqH?.["Content-Type"] ?? "", text: post } } : {}),
          },
          response: {
            status: e.status ?? 0, statusText: e.statusText ?? e.error ?? "", httpVersion: e.httpVersion ?? "", headers: pairs(resH), cookies: [],
            content: { size: body?.length ?? 0, mimeType: e.mimeType ?? "", ...(body ? { text: body } : {}) },
            redirectURL: resH?.location ?? resH?.Location ?? "", headersSize: -1, bodySize: body?.length ?? -1,
          },
          cache: {},
          timings: { send: 0, wait: e.duration ?? 0, receive: 0 },
          _resourceType: e.type ?? "",
        };
      }),
    },
  };
  const stem = (name || `abe-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`).replace(/\.har$/i, "").replace(/[^\w.-]+/g, "_");
  let path = join(EXPORT_DIR, `${stem}.har`);
  for (let i = 2; existsSync(path); i++) path = join(EXPORT_DIR, `${stem}-${i}.har`);
  writeFileSync(path, JSON.stringify(har, null, 1), { mode: 0o600 });
  return path;
}
