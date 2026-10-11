/**
 * Couche d'analyse API (ABC) : fonctions pures partagées entre le démon et les tests.
 * Règle d'or : aucun secret ne sort d'ici — noms et schémas uniquement, valeurs masquées.
 */
import { gunzipSync } from "node:zlib";

/** Clés sensibles : on n'en renvoie jamais la valeur, seulement le nom. */
const SENSITIVE_KEY = /(cookie|token|csrf|xsrf|auth|password|passwd|secret|api[-_]?key|session|jwt|set-cookie)/i;

export function isSensitiveKey(name: string): boolean {
  return SENSITIVE_KEY.test(name);
}

/** Valeur masquée, avec la longueur pour garder l'info utile sans le secret. */
export function maskValue(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return `<masqué, ${s.length} car.>`;
}

/** Noms des paramètres query d'une URL (jamais les valeurs). */
export function queryParamNames(url: string): string[] {
  try {
    const names: string[] = [];
    for (const k of new URL(url).searchParams.keys()) if (!names.includes(k)) names.push(k);
    return names.slice(0, 30);
  } catch {
    return [];
  }
}

/** Schéma JSON : types uniquement, jamais les valeurs (miroir de devtools.js). */
export function inferSchema(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const kinds = [...new Set(value.slice(0, 3).map((v) => inferSchema(v, depth + 1)))];
    return `[${kinds.join(" | ")}]`;
  }
  if (typeof value !== "object") return typeof value;
  if (depth > 2) return "{…}";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const shown = keys.slice(0, 20);
  const inner = shown.map((k) => `${JSON.stringify(k)}: ${inferSchema(obj[k], depth + 1)}`).join(", ");
  return `{${inner}${keys.length > shown.length ? `, +${keys.length - shown.length} clés` : ""}}`;
}

export interface ExportRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** En-têtes sûrs pour l'export : les sensibles deviennent <masqué>. */
export function safeHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = isSensitiveKey(k) ? "<masqué>" : v;
  return out;
}

/** Exporte la requête en curl (secrets masqués, cookies du navigateur non copiés). */
export function buildCurl(req: ExportRequest): string {
  const m = req.method.toUpperCase();
  const lines = [`curl -X ${m} ${JSON.stringify(req.url)}`];
  for (const [k, v] of Object.entries(safeHeaders(req.headers))) lines.push(`  -H ${JSON.stringify(`${k}: ${v}`)}`);
  if (req.body !== undefined) lines.push(`  --data ${JSON.stringify(req.body.slice(0, 4000))}`);
  lines.push(`  # cookies + jetons CSRF : repris du navigateur, non copiés ici`);
  return lines.join(" \\\n");
}

/** Exporte la requête en Python requests (secrets masqués). */
export function buildPython(req: ExportRequest): string {
  const safe = safeHeaders(req.headers);
  const body = req.body === undefined ? "None" : JSON.stringify(req.body.slice(0, 4000));
  return [
    `import requests`,
    `res = requests.${req.method.toLowerCase()}(${JSON.stringify(req.url)},`,
    `    headers=${JSON.stringify(safe)},`,
    `    data=${body})  # cookies + CSRF : repris de la session navigateur`,
    `print(res.status_code)`,
    `print(res.text[:5000])`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Décodeurs : l'agent les utilise sans écrire de script.
// ---------------------------------------------------------------------------

export interface Decoded {
  format: string;
  text: string;
}

function tryBase64(s: string): string | null {
  const t = s.trim();
  if (!/^[A-Za-z0-9+/=_-]{8,}$/.test(t) || /\s/.test(t)) return null;
  try {
    const b64 = t.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(b64, "base64");
    if (!buf.length) return null;
    const txt = buf.toString("utf8");
    if (!txt || /�/.test(txt.slice(0, 200))) return null;
    return txt;
  } catch {
    return null;
  }
}

function tryJwt(s: string): Decoded | null {
  const parts = s.trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    void header;
    const exp = typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null;
    const keys = Object.keys(payload);
    // On montre les NOMS des claims, pas les valeurs sensibles.
    const shown = keys.map((k) => `${k}: ${isSensitiveKey(k) ? maskValue(payload[k]) : inferSchema(payload[k])}`).join(", ");
    return { format: "jwt", text: `JWT (signature non vérifiée) · claims: {${shown}}${exp ? ` · expire: ${exp}` : ""}` };
  } catch {
    return null;
  }
}

/** Décode sans jamais lever : JWT, base64, urlencodé, formulaire, hex, gzip+base64, JSON. */
export function decode(input: string): Decoded {
  const s = input.trim();
  if (!s) return { format: "vide", text: "(entrée vide)" };
  const jwt = tryJwt(s);
  if (jwt) return jwt;
  if (/^(%[0-9A-Fa-f]{2}|[A-Za-z0-9._~!$&'()*+,;=:@/?-])*%[0-9A-Fa-f]{2}/.test(s) && s.includes("%")) {
    try {
      return { format: "urlencodé", text: decodeURIComponent(s) };
    } catch {}
  }
  if (/^([A-Za-z0-9_.-]+=[^&]*&){1,}[A-Za-z0-9_.-]+=[^&]*$/.test(s)) {
    const names = s.split("&").map((p) => p.split("=")[0]).filter(Boolean);
    return { format: "formulaire", text: `champs: ${[...new Set(names)].join(", ")} (${names.length} paires, valeurs masquées)` };
  }
  if (/^[0-9a-fA-F]{8,}$/.test(s) && s.length % 2 === 0) {
    const txt = Buffer.from(s, "hex").toString("utf8");
    if (txt && !/�/.test(txt.slice(0, 200))) return { format: "hex", text: txt.slice(0, 5000) };
  }
  const b64 = tryBase64(s);
  if (b64) {
    try {
      const ungz = gunzipSync(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64")).toString("utf8");
      return { format: "gzip+base64", text: ungz.slice(0, 5000) };
    } catch {}
    return { format: "base64", text: b64.slice(0, 5000) };
  }
  try {
    return { format: "json", text: `schéma: ${inferSchema(JSON.parse(s))}` };
  } catch {}
  return { format: "texte", text: s.slice(0, 5000) };
}

// ---------------------------------------------------------------------------
// site_api : petit client enregistré par site (persisté côté démon).
// ---------------------------------------------------------------------------

export interface SiteCall {
  name: string;
  method: string;
  path: string;
  params?: string[];
  updated: string;
}

export type SiteEntry = SiteCall[] | { calls?: SiteCall[]; routes?: Record<string, string>; notes?: string[] };

export function siteApiPath(home: string): string {
  return `${home}/.agent-browser-control/site-api.json`;
}

export function loadSiteApi(raw: string | null): Record<string, SiteEntry> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, SiteEntry>;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Récupère les routes (deep links) enregistrées pour un site donné. */
export function getSiteRoutes(entry?: SiteEntry): Record<string, string> {
  if (!entry) return {};
  if (Array.isArray(entry)) return {};
  return entry.routes ?? {};
}

/** Enregistre ou met à jour une route directe pour un site. */
export function setSiteRoute(
  siteApi: Record<string, SiteEntry>,
  site: string,
  name: string,
  url: string
): Record<string, SiteEntry> {
  const current = siteApi[site];
  let calls: SiteCall[] = [];
  let routes: Record<string, string> = {};
  let notes: string[] = [];
  if (Array.isArray(current)) {
    calls = current;
  } else if (current && typeof current === "object") {
    calls = current.calls ?? [];
    routes = { ...(current.routes ?? {}) };
    notes = [...(current.notes ?? [])];
  }
  routes[name] = url;
  return {
    ...siteApi,
    [site]: notes.length ? { calls, routes, notes } : { calls, routes },
  };
}

/** Noms des champs d'un corps de formulaire urlencodé (jamais les valeurs). */
export function formFieldNames(body: string): string[] {
  const names: string[] = [];
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    const raw = (eq >= 0 ? pair.slice(0, eq) : pair).trim();
    if (!raw) continue;
    let name = raw;
    try {
      name = decodeURIComponent(raw.replace(/\+/g, " "));
    } catch {}
    if (name && !names.includes(name)) names.push(name);
  }
  return names.slice(0, 30);
}

/** Clés de premier niveau d'un corps JSON objet (jamais les valeurs). */
export function jsonTopKeys(body: string): string[] {
  try {
    const v: unknown = JSON.parse(body);
    if (v && typeof v === "object" && !Array.isArray(v)) return Object.keys(v).slice(0, 30);
  } catch {}
  return [];
}

export interface HarCallLike {
  method?: string;
  url?: string;
  postData?: string;
  requestHeaders?: Record<string, string>;
}

/**
 * Dérive d'une requête du HAR un SiteCall enregistrable : méthode, chemin sans
 * query, noms des paramètres uniquement (query + champs de formulaire + clés JSON),
 * jamais aucune valeur. Quand le site change, réenregistrer sous le même nom écrase.
 * Renvoie null si l'URL est invalide.
 */
export function deriveSiteCall(
  entry: HarCallLike,
  name?: string,
  today = new Date().toISOString().slice(0, 10),
): { site: string; call: SiteCall } | null {
  let u: URL;
  try {
    u = new URL(entry.url ?? "");
  } catch {
    return null;
  }
  const method = (entry.method ?? "GET").toUpperCase();
  const path = u.pathname || "/";
  const params = [...queryParamNames(u.toString())];
  const contentType =
    Object.entries(entry.requestHeaders ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  const body = entry.postData ?? "";
  if (/urlencoded/i.test(contentType) || (/=/.test(body) && !/^\s*[{[]/.test(body))) params.push(...formFieldNames(body));
  else if (/json/i.test(contentType) || /^\s*\{/.test(body)) params.push(...jsonTopKeys(body));
  const dedup = [...new Set(params)].slice(0, 30);
  const wanted = (name ?? `${method} ${path}`).slice(0, 80);
  return {
    site: u.hostname,
    call: {
      name: wanted || `${method} ${path}`,
      method,
      path,
      ...(dedup.length ? { params: dedup } : {}),
      updated: today,
    },
  };
}

/** Playbook d'un site : lignes de conduite (1 à 3 par visite), servies à l'arrivée. */
export function getSiteNotes(entry?: SiteEntry): string[] {
  if (!entry || Array.isArray(entry)) return [];
  return entry.notes ?? [];
}

function normSiteHost(h: string): string {
  return h.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Une clé couvre un hôte : égalité ou suffixe de domaine (même règle que la
 * blocklist, l'historique et les slots : `pinterest.com` couvre
 * `www.pinterest.com`). Pas de syntaxe `*.` : la clé de domaine nu suffit.
 */
export function siteKeyCovers(host: string, key: string): boolean {
  const h = normSiteHost(host);
  const k = normSiteHost(key);
  if (!h || !k) return false;
  return h === k || h.endsWith(`.${k}`);
}

/**
 * Playbook applicable à un hôte : notes de l'hôte exact d'abord, puis des
 * domaines parents, sans doublons (l'exact gagne en cas de recouvrement).
 */
export function getSiteNotesForHost(api: Record<string, SiteEntry>, host: string): string[] {
  const out: string[] = [];
  for (const k of coveringKeys(api, host)) {
    for (const n of getSiteNotes(api[k])) {
      if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** Clés couvrant un hôte, hôte exact d'abord puis domaines parents. */
function coveringKeys(api: Record<string, SiteEntry>, host: string): string[] {
  const h = normSiteHost(host);
  if (!h) return [];
  return Object.keys(api)
    .filter((k) => siteKeyCovers(h, k))
    .sort((a, b) => b.length - a.length);
}

function siteCalls(entry?: SiteEntry): SiteCall[] {
  if (!entry) return [];
  return Array.isArray(entry) ? entry : (entry.calls ?? []);
}

/**
 * Routes applicables à un hôte : hôte exact d'abord, puis domaines parents
 * (l'exact gagne en cas de même nom).
 */
export function getSiteRoutesForHost(
  api: Record<string, SiteEntry>,
  host: string,
): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const k of coveringKeys(api, host)) {
    for (const [name, url] of Object.entries(getSiteRoutes(api[k]))) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, url });
    }
  }
  return out;
}

/**
 * Appels applicables à un hôte : hôte exact d'abord, puis domaines parents
 * (l'exact gagne en cas de même nom).
 */
export function getSiteCallsForHost(api: Record<string, SiteEntry>, host: string): SiteCall[] {
  const out: SiteCall[] = [];
  const seen = new Set<string>();
  for (const k of coveringKeys(api, host)) {
    for (const c of siteCalls(api[k])) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      out.push(c);
    }
  }
  return out;
}

/** L'hôte a-t-il une mémoire (route, appel ou note, hôte exact ou parent) ? */
export function hostHasMemory(api: Record<string, SiteEntry>, host: string): boolean {
  for (const k of coveringKeys(api, host)) {
    const entry = api[k];
    if (siteCalls(entry).length) return true;
    if (Object.keys(getSiteRoutes(entry)).length) return true;
    if (getSiteNotes(entry).length) return true;
  }
  return false;
}

const BRIEF_ROUTES = 3;
const BRIEF_CALLS = 3;
const BRIEF_NOTES = 3;

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/**
 * Brief servi à l'arrivée sur un site connu : routes d'abord (l'action la
 * plus rentable), puis appels, puis notes. null sans mémoire. Entête avec
 * les totaux, corps borné.
 */
export function formatSiteBrief(api: Record<string, SiteEntry>, host: string): string | null {
  const routes = getSiteRoutesForHost(api, host);
  const calls = getSiteCallsForHost(api, host);
  const notes = getSiteNotesForHost(api, host);
  if (!routes.length && !calls.length && !notes.length) return null;
  const parts: string[] = [];
  if (routes.length) parts.push(plural(routes.length, "route", "routes"));
  if (calls.length) parts.push(plural(calls.length, "appel", "appels"));
  if (notes.length) parts.push(plural(notes.length, "note", "notes"));
  const lines = [`Playbook ${normSiteHost(host)} (${parts.join(", ")}) :`];
  for (const r of routes.slice(0, BRIEF_ROUTES)) lines.push(`→ « ${r.name} » : ${r.url}`);
  for (const c of calls.slice(0, BRIEF_CALLS)) lines.push(`→ « ${c.name} » : ${c.method} ${c.path}`);
  for (const n of notes.slice(0, BRIEF_NOTES)) lines.push(`- ${n}`);
  return lines.join("\n");
}

/** Actions sur un onglet à partir desquelles un parcours est jugé « riche ». */
export const RICH_TAB_MIN_ACTIONS = 8;

/**
 * Faut-il suggérer de mémoriser le parcours à la fermeture de l'onglet ?
 * Jamais sous le seuil, sans hôte attribué, si le site a déjà une mémoire,
 * ou si on l'a déjà suggéré (pas de harcèlement).
 */
export function shouldSuggestMemory(o: {
  actions: number;
  host: string;
  hasMemory: boolean;
  alreadySuggested: boolean;
}): boolean {
  return o.actions >= RICH_TAB_MIN_ACTIONS && !!normSiteHost(o.host) && !o.hasMemory && !o.alreadySuggested;
}

/** Suggestion de mémorisation, chiffrée et actionnable, à ignorer si usage unique. */
export function formatMemorySuggestion(host: string, actions: number): string {
  return (
    `Parcours riche sur ${host} (${actions} actions) sans mémoire site_api : mémoriser pour la prochaine visite ? ` +
    `site_api save_route (deep link sans jeton) + note (1 à 3 lignes de playbook). Ignorer si le parcours était à usage unique.`
  );
}

const MAX_NOTES = 12;
const MAX_NOTE_CHARS = 280;

/** Ajoute une ligne au playbook (doublon exact ignoré, au-delà de 12 les plus anciennes sautent). */
export function addSiteNote(
  siteApi: Record<string, SiteEntry>,
  site: string,
  text: string,
): { api: Record<string, SiteEntry>; added: boolean } {
  const note = text.trim().slice(0, MAX_NOTE_CHARS);
  if (!note) return { api: siteApi, added: false };
  const current = siteApi[site];
  const calls = Array.isArray(current) ? [...current] : [...(current?.calls ?? [])];
  const routes = Array.isArray(current) ? {} : { ...(current?.routes ?? {}) };
  const notes = Array.isArray(current) ? [] : [...(current?.notes ?? [])];
  if (notes.includes(note)) return { api: siteApi, added: false };
  notes.push(note);
  while (notes.length > MAX_NOTES) notes.shift();
  return { api: { ...siteApi, [site]: { calls, routes, notes } }, added: true };
}

/** Supprime une ligne du playbook (texte exact) ; removed=false si absente. */
export function deleteSiteNote(
  siteApi: Record<string, SiteEntry>,
  site: string,
  text: string,
): { api: Record<string, SiteEntry>; removed: boolean } {
  const current = siteApi[site];
  if (Array.isArray(current) || !(current?.notes ?? []).includes(text)) return { api: siteApi, removed: false };
  const calls = [...(current.calls ?? [])];
  const routes = { ...(current.routes ?? {}) };
  const notes = (current.notes ?? []).filter((n) => n !== text);
  if (!calls.length && !Object.keys(routes).length && !notes.length) {
    const rest = { ...siteApi };
    delete rest[site];
    return { api: rest, removed: true };
  }
  return { api: { ...siteApi, [site]: { calls, routes, notes } }, removed: true };
}

/** Supprime un appel enregistré ; removed=false s'il n'existait pas. */
export function deleteSiteCall(
  siteApi: Record<string, SiteEntry>,
  site: string,
  name: string,
): { api: Record<string, SiteEntry>; removed: boolean } {
  const current = siteApi[site];
  const calls = Array.isArray(current) ? [...current] : [...(current?.calls ?? [])];
  const routes = Array.isArray(current) ? {} : { ...(current?.routes ?? {}) };
  const notes = Array.isArray(current) ? [] : [...(current?.notes ?? [])];
  const kept = calls.filter((c) => c.name !== name);
  if (kept.length === calls.length) return { api: siteApi, removed: false };
  if (!kept.length && !Object.keys(routes).length && !notes.length) {
    const rest = { ...siteApi };
    delete rest[site];
    return { api: rest, removed: true };
  }
  return { api: { ...siteApi, [site]: notes.length ? { calls: kept, routes, notes } : { calls: kept, routes } }, removed: true };
}

/** Supprime une route enregistrée ; removed=false si elle n'existait pas. */
export function deleteSiteRoute(
  siteApi: Record<string, SiteEntry>,
  site: string,
  name: string,
): { api: Record<string, SiteEntry>; removed: boolean } {
  const current = siteApi[site];
  if (Array.isArray(current) || !current?.routes?.[name]) return { api: siteApi, removed: false };
  const calls = [...(current.calls ?? [])];
  const routes = { ...current.routes };
  delete routes[name];
  const notes = [...(current.notes ?? [])];
  if (!calls.length && !Object.keys(routes).length && !notes.length) {
    const rest = { ...siteApi };
    delete rest[site];
    return { api: rest, removed: true };
  }
  return { api: { ...siteApi, [site]: notes.length ? { calls, routes, notes } : { calls, routes } }, removed: true };
}

/** Enregistre ou met à jour un appel d'API pour un site. */
export function setSiteCall(
  siteApi: Record<string, SiteEntry>,
  site: string,
  call: SiteCall
): Record<string, SiteEntry> {
  const current = siteApi[site];
  let calls: SiteCall[] = [];
  let routes: Record<string, string> = {};
  let notes: string[] = [];
  if (Array.isArray(current)) {
    calls = [...current];
  } else if (current && typeof current === "object") {
    calls = [...(current.calls ?? [])];
    routes = { ...(current.routes ?? {}) };
    notes = [...(current.notes ?? [])];
  }
  const idx = calls.findIndex((c) => c.name === call.name);
  if (idx >= 0) calls[idx] = call;
  else calls.push(call);
  return {
    ...siteApi,
    [site]: notes.length ? { calls, routes, notes } : { calls, routes },
  };
}

