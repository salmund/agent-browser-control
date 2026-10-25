/**
 * Garde-fous du démon, en fonctions pures (testables sans démarrer de démon) :
 * masquage des arguments journalisés, troncature des lignes de journal, contrôle
 * des fichiers envoyés par file_upload, jeton, en-tête Host, origine de l'extension,
 * noms des fichiers joints.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { maskHeaders, maskPairs } from "./har.ts";

/** Longueur maximale d'une chaîne dans une ligne de journal. */
export const LOG_STRING_MAX = 2048;

// --- Journal ----------------------------------------------------------------------------------------

/** Clés dont la valeur n'est jamais journalisée (seulement sa longueur). */
const MASKED_KEYS = new Set(["value", "text", "promptText", "body", "postData", "password"]);
/** Outils dont l'URL est journalisée sans sa query. */
const URL_TOOLS = new Set(["navigate", "tabs_create", "site_api"]);
/** Outils dont le code est journalisé tronqué. */
const CODE_TOOLS = new Set(["javascript", "browser_script"]);
const CODE_KEEP = 1900;

const maskValue = (v: unknown) => (v === undefined || v === null ? v : typeof v === "string" ? `<${v.length} car.>` : "<masqué>");

/** URL sans sa query (masquée) ; dans le fragment, seuls les couples clé=valeur sensibles sont masqués. */
export function maskQuery(url: string): string {
  const hash = url.indexOf("#");
  const q = url.indexOf("?");
  const hasQuery = q >= 0 && (hash < 0 || q < hash) && q + 1 < (hash < 0 ? url.length : hash);
  const fragment = hash >= 0 ? url.slice(hash + 1) : "";
  const end = Math.min(...[q, hash].filter((i) => i >= 0), url.length);
  return url.slice(0, end) + (hasQuery ? "?<query masquée>" : "") + (hash >= 0 ? `#${maskPairs(fragment)}` : "");
}

/** Code tronqué à ~2 Ko, avec une empreinte courte pour reconnaître deux codes identiques. */
export function shortenCode(code: string): string {
  if (code.length <= LOG_STRING_MAX) return code;
  const digest = createHash("sha256").update(code).digest("hex").slice(0, 12);
  return `${code.slice(0, CODE_KEEP)}…[tronqué : ${code.length} car., empreinte ${digest}]`;
}

/**
 * Arguments d'un appel tels qu'ils partent au journal : saisies et corps réduits à leur
 * longueur (à toute profondeur : fields, steps…), en-têtes passés au masquage du HAR,
 * query des URL de navigation masquée, code tronqué. Les noms de touches de
 * computer action="key" restent lisibles : ce sont des gestes, pas des données.
 */
export function redactArgs(tool: string, args: unknown): Record<string, unknown> {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 10) return "<…>";
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => walk(x, depth + 1));
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    const keyGesture = tool === "computer" && o.action === "key";
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      if (MASKED_KEYS.has(k) && !(k === "text" && keyGesture)) out[k] = maskValue(val);
      else if (k === "headers" && val && typeof val === "object" && !Array.isArray(val)) {
        out[k] = maskHeaders(Object.fromEntries(Object.entries(val as Record<string, unknown>).map(([h, x]) => [h, String(x)])));
      } else if (k === "url" && typeof val === "string" && URL_TOOLS.has(tool)) out[k] = maskQuery(val);
      else if (k === "code" && typeof val === "string" && CODE_TOOLS.has(tool)) out[k] = shortenCode(val);
      else out[k] = walk(val, depth + 1);
    }
    return out;
  };
  const out = walk(args ?? {}, 0);
  return out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : {};
}

/** Chaque chaîne d'une entrée de journal ramenée à `max` caractères (marqueur de troncature inclus). */
export function truncateStrings<T>(value: T, max = LOG_STRING_MAX): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return v.length > max ? `${v.slice(0, max - 32)}…[tronqué, ${v.length} car.]` : v;
    if (depth > 10 || !v || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, depth + 1)]));
  };
  return walk(value, 0) as T;
}

// --- file_upload ------------------------------------------------------------------------------------

/** Dossiers jamais envoyés à une page (un segment du chemin suffit). */
const FORBIDDEN_DIRS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", "appdata"]);
/** Profils de navigateurs (Windows hors AppData, macOS, Linux). */
const BROWSER_PROFILE =
  /(^|\/)(user data|\.mozilla)(\/|$)|\/library\/application support\/(google|chromium|bravesoftware|microsoft edge|firefox|comet|perplexity|vivaldi|arc)(\/|$)|\/\.config\/(google-chrome[^/]*|chromium|bravesoftware|microsoft-edge[^/]*|vivaldi)(\/|$)/;
/** Fichiers de secrets : archives réseau, clés, certificats, environnements (.env, .env.local, pas .envoi.pdf). */
const FORBIDDEN_FILE = /(\.(har|pem|key|p12|pfx)$|^id_(rsa|dsa|ecdsa|ed25519)|^\.env(\.[\w-]+)?$|^\.netrc$|^\.git-credentials$)/;

function insideDir(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Raison du refus d'un chemin réel, ou null s'il peut être envoyé. */
export function uploadRefusal(real: string, configDir: string): string | null {
  let config = resolve(configDir);
  try {
    config = realpathSync(config);
  } catch {}
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  if (insideDir(norm(real), norm(config)) || insideDir(norm(real), norm(resolve(configDir)))) {
    return "dossier de configuration d'Agent Browser Control (jeton, journal, HAR)";
  }
  const lower = real.replace(/\\/g, "/").toLowerCase();
  const segments = lower.split("/");
  // Le dossier temporaire du système (sous AppData sur Windows) reste une zone d'échange permise.
  let tmp = tmpdir();
  try {
    tmp = realpathSync(tmp);
  } catch {}
  if (!insideDir(norm(real), norm(tmp))) {
    const dir = segments.find((s) => FORBIDDEN_DIRS.has(s));
    if (dir) return `dossier sensible (${dir})`;
    if (BROWSER_PROFILE.test(lower)) return "profil de navigateur (cookies, sessions)";
  }
  const name = segments.at(-1) ?? "";
  if (FORBIDDEN_FILE.test(name)) return "fichier de secrets (clé, certificat, HAR ou .env)";
  return null;
}

export type UploadCheck = { ok: true; paths: string[] } | { ok: false; error: string };

/**
 * Contrôle des fichiers de file_upload, avant tout envoi à l'extension : chemins absolus
 * existants, chemin réel résolu (liens suivis), refus des secrets. Renvoie les chemins réels.
 */
export function checkUploadPaths(paths: unknown, configDir: string): UploadCheck {
  const fail = (error: string): UploadCheck => ({ ok: false, error: `file_upload : ${error}` });
  if (!Array.isArray(paths) || !paths.length) return fail("'paths' doit être une liste non vide de chemins absolus.");
  if (paths.length > 50) return fail("50 fichiers au plus par appel.");
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string" || !p.trim()) return fail("chemin vide ou non textuel.");
    if (!isAbsolute(p)) return fail(`chemin absolu requis (${p}).`);
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      return fail(
        `fichier introuvable : ${p} (cherché par le démon d'ABC, sous son propre compte : un /tmp ou un bac à sable ` +
          "propre à l'agent lui est invisible, déposer le fichier dans un dossier partagé).",
      );
    }
    try {
      if (!statSync(real).isFile()) return fail(`${p} n'est pas un fichier.`);
    } catch {
      return fail(`fichier illisible : ${p}`);
    }
    const reason = uploadRefusal(real, configDir);
    if (reason) {
      return fail(
        `envoi refusé pour ${p} : ${reason}. Par sécurité, clés, jetons, profils et fichiers de configuration ` +
          "ne sont jamais chargés dans une page. S'il faut vraiment ce fichier, demander à l'utilisateur de le copier ailleurs.",
      );
    }
    out.push(real);
  }
  return { ok: true, paths: out };
}

// --- Accès HTTP / WebSocket -------------------------------------------------------------------------

/** Jeton présenté : en-tête x-abc-token, ou Authorization: Bearer. */
export function requestToken(headers: IncomingHttpHeaders): string | undefined {
  const x = headers["x-abc-token"];
  if (typeof x === "string" && x) return x;
  const auth = headers.authorization;
  const m = typeof auth === "string" ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
  return m ? m[1] : undefined;
}

/** Comparaison du jeton à temps constant (empreintes de même longueur). */
export function tokenMatches(given: unknown, token: string): boolean {
  if (typeof given !== "string" || !given || !token) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/** En-tête Host attendu : 127.0.0.1:PORT ou localhost:PORT (parade au DNS rebinding). */
export function hostAllowed(host: string | undefined, port: number): boolean {
  const h = (host ?? "").toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/** Origine d'une extension Chromium (chrome-extension://<id>). */
export function isExtensionOrigin(origin: string): boolean {
  return /^chrome-extension:\/\/[a-z0-9]+$/i.test(origin);
}

// --- Fichiers joints --------------------------------------------------------------------------------

/** Nom de fichier sûr pour un fichier joint : caractères simples, sans chemin, 100 caractères au plus. */
export function safeFileName(name: unknown, max = 100): string {
  const raw = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const rawExt = extname(raw);
  let ext = rawExt.replace(/[^\w.]+/g, "").slice(0, 12);
  if (ext === ".") ext = "";
  let stem = raw.slice(0, raw.length - rawExt.length).replace(/[^\w.-]+/g, "_").replace(/^[._-]+/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem)) stem = `_${stem}`;
  stem = stem.slice(0, Math.max(1, max - ext.length)) || "fichier";
  return stem + ext;
}
