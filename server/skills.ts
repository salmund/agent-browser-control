/**
 * Fonctions d'ABC (skills) : un parcours entier derrière un seul appel.
 *
 * Une fonction est un fichier .js : un en-tête `/** @skill {…json…} *\/` (nom, description, paramètres, site)
 * puis le corps d'une fonction async exécutée dans le bac à sable de browser_script, avec `args` et les mêmes
 * outils (nav, js, open, page, http, skill…). Deux sources, même format :
 *  - intégrées, livrées avec ABC (dossier skills/ du dépôt) : web.search, web.images, web.videos, web.read ;
 *  - apprises, écrites par les agents après un premier parcours (dossier skills/ de la configuration).
 * Le démon les décrit (catalogue servi dès tabs_context), valide les arguments, les exécute par l'extension et
 * tient leurs statistiques : une fonction apprise qui échoue est signalée à réparer.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { siteKeyCovers } from "./analysis.ts";

export type SkillParamType = "string" | "number" | "boolean" | "array" | "object";

export interface SkillParam {
  type: SkillParamType;
  description?: string;
  default?: unknown;
  required?: boolean;
  enum?: unknown[];
}

export interface SkillMeta {
  name: string;
  description: string;
  params: Record<string, SkillParam>;
  /** Hôte couvert (le domaine nu couvre ses sous-domaines) ; absent : fonction générale. */
  site?: string;
  /** write : la fonction agit au nom de l'utilisateur (envoi, publication, achat…). */
  effects?: "read" | "write";
  returns?: string;
  author?: string;
  created?: string;
  updated?: string;
  version?: number;
}

export interface Skill extends SkillMeta {
  code: string;
  source: "builtin" | "learned";
  file: string;
}

export interface SkillStats {
  runs: number;
  ok: number;
  fail: number;
  /** Échecs consécutifs (remis à zéro au premier succès). */
  streak: number;
  totalMs: number;
  lastRun?: string;
  lastOk?: string;
  lastError?: string;
}

export const SKILL_CODE_MAX = 30_000;
const NAME_RE = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/;
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TYPES: SkillParamType[] = ["string", "number", "boolean", "array", "object"];
const HEADER_RE = /^\s*\/\*\*\s*@skill\s*([\s\S]*?)\*\/[ \t]*\r?\n?/;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => unknown;

/** Les fonctions apprises vivent dans <config>/skills, leurs statistiques à côté. */
export function learnedDir(configDir: string): string {
  return join(configDir, "skills");
}

function statsFile(configDir: string): string {
  return join(configDir, "skills-stats.json");
}

export function validName(name: string): boolean {
  return name.length <= 64 && NAME_RE.test(name);
}

/** Lit un fichier de fonction : en-tête JSON + corps. null si l'en-tête manque ou est illisible. */
export function parseSkillFile(raw: string, source: Skill["source"], file: string): Skill | null {
  const m = HEADER_RE.exec(raw);
  if (!m) return null;
  let meta: SkillMeta;
  try {
    meta = JSON.parse(m[1]) as SkillMeta;
  } catch {
    return null;
  }
  if (!meta || typeof meta.name !== "string" || !validName(meta.name)) return null;
  const code = raw.slice(m[0].length);
  return {
    ...meta,
    description: String(meta.description ?? ""),
    params: meta.params && typeof meta.params === "object" ? meta.params : {},
    code,
    source,
    file,
  };
}

/** Texte du fichier d'une fonction (en-tête lisible, puis le code). */
export function formatSkillFile(meta: SkillMeta, code: string): string {
  return `/** @skill\n${JSON.stringify(meta, null, 2)}\n*/\n${code.replace(/^\s*\n/, "")}${code.endsWith("\n") ? "" : "\n"}`;
}

function readDirSkills(dir: string, source: Skill["source"]): Skill[] {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const file = join(dir, f);
    try {
      if (!statSync(file).isFile()) continue;
      const skill = parseSkillFile(readFileSync(file, "utf8"), source, file);
      if (skill) out.push(skill);
    } catch {}
  }
  return out;
}

/**
 * Toutes les fonctions : intégrées d'abord ; une fonction apprise ne remplace jamais une intégrée du même nom.
 * Relu à chaque appel (quelques fichiers) : une fonction enregistrée sert aussitôt, sans redémarrer le démon.
 */
export function loadSkills(builtinDir: string, configDir: string): Map<string, Skill> {
  const all = new Map<string, Skill>();
  for (const s of readDirSkills(builtinDir, "builtin")) all.set(s.name, s);
  for (const s of readDirSkills(learnedDir(configDir), "learned")) if (!all.has(s.name)) all.set(s.name, s);
  return all;
}

/** Empreinte du catalogue (noms, versions, dates) : le shim prévient l'agent quand elle change. */
export function catalogVersion(skills: Map<string, Skill>): string {
  return [...skills.values()].map((s) => `${s.name}@${s.version ?? 1}:${s.updated ?? ""}`).sort().join("|");
}

// --- Statistiques -----------------------------------------------------------------------------------

export function loadStats(configDir: string): Record<string, SkillStats> {
  try {
    const raw = JSON.parse(readFileSync(statsFile(configDir), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function recordRun(configDir: string, name: string, outcome: { ok: boolean; ms: number; error?: string }): SkillStats {
  const all = loadStats(configDir);
  const s: SkillStats = all[name] ?? { runs: 0, ok: 0, fail: 0, streak: 0, totalMs: 0 };
  const now = new Date().toISOString();
  s.runs++;
  s.totalMs += Math.max(0, Math.round(outcome.ms));
  s.lastRun = now;
  if (outcome.ok) {
    s.ok++;
    s.streak = 0;
    s.lastOk = now;
  } else {
    s.fail++;
    s.streak++;
    s.lastError = String(outcome.error ?? "").slice(0, 300);
  }
  all[name] = s;
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(statsFile(configDir), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  } catch {}
  return s;
}

// --- Arguments --------------------------------------------------------------------------------------

/** Signature lisible : web.search(query, limit?, read?). */
export function signature(skill: Pick<Skill, "name" | "params">): string {
  const ps = Object.entries(skill.params ?? {})
    .sort(([, a], [, b]) => Number(!!b.required) - Number(!!a.required))
    .map(([k, p]) => (p.required ? k : `${k}?`));
  return `${skill.name}(${ps.join(", ")})`;
}

function typeOf(v: unknown): SkillParamType | "null" {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : (typeof v as SkillParamType);
}

/**
 * Arguments validés et complétés (défauts, conversions évidentes : "3" → 3, "true" → true, "a" → ["a"]).
 * Une erreur dit exactement quoi corriger, avec la signature : l'agent corrige en un tour.
 */
export function normalizeArgs(skill: Pick<Skill, "name" | "params">, raw: unknown): { args: Record<string, unknown> } | { error: string } {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const params = skill.params ?? {};
  const sig = signature(skill);
  const unknown = Object.keys(input).filter((k) => !(k in params));
  if (unknown.length) return { error: `Paramètre(s) inconnu(s) : ${unknown.join(", ")}. Signature : ${sig}.` };
  const args: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(params)) {
    let v = input[k];
    if (v === undefined || v === null || v === "") {
      if (p.required) return { error: `Paramètre « ${k} » requis${p.description ? ` (${p.description})` : ""}. Signature : ${sig}.` };
      if (p.default !== undefined) args[k] = p.default;
      continue;
    }
    if (p.type === "number" && typeof v === "string" && v.trim() && Number.isFinite(Number(v))) v = Number(v);
    if (p.type === "boolean" && (v === "true" || v === "false")) v = v === "true";
    if (p.type === "string" && typeof v === "number") v = String(v);
    if (p.type === "array" && !Array.isArray(v)) v = [v];
    const got = typeOf(v);
    if (got !== p.type) return { error: `Paramètre « ${k} » : ${p.type} attendu, ${got} reçu. Signature : ${sig}.` };
    if (Array.isArray(p.enum) && p.enum.length && !p.enum.includes(v)) {
      return { error: `Paramètre « ${k} » : une valeur parmi ${p.enum.map((e) => JSON.stringify(e)).join(", ")}.` };
    }
    args[k] = v;
  }
  return { args };
}

// --- Enregistrement ---------------------------------------------------------------------------------

export interface SaveInput {
  name?: unknown;
  description?: unknown;
  params?: unknown;
  code?: unknown;
  site?: unknown;
  effects?: unknown;
  returns?: unknown;
}

/**
 * Certains modèles servis par une interface web écrivent `&gt;`, `&amp;`… au lieu de `>` et `&` dans le code
 * qu'ils envoient. Si le code ne compile pas mais compile une fois ces entités décodées, on garde le décodé.
 */
export function repairEntities(code: string): string {
  if (!/&(?:gt|lt|amp|quot|#39|#x27);/.test(code)) return code;
  try {
    new AsyncFunction("args", code);
    return code;
  } catch {}
  const decoded = code.replace(/&(gt|lt|amp|quot|#39|#x27);/g, (_, e: string) => ({ gt: ">", lt: "<", amp: "&", quot: '"', "#39": "'", "#x27": "'" })[e]!);
  try {
    new AsyncFunction("args", decoded);
    return decoded;
  } catch {
    return code;
  }
}

/**
 * Une fonction est rejouée, et peut être partagée entre machines : jamais d'e-mail, de jeton ni de mot de passe
 * écrits en dur. Renvoie ce qui a été trouvé, ou null.
 */
export function privateData(text: string): string | null {
  const found: [RegExp, string][] = [
    [/[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "une adresse e-mail"],
    [/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/, "un jeton JWT"],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i, "un jeton Bearer"],
    [/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/, "une clé d'API"],
    [/\b(?:pass(?:word|wd)?|mot_?de_?passe|mdp|secret|api_?key|token)\s*[:=]\s*["'`][^"'`\s]{6,}["'`]/i, "un mot de passe ou un jeton"],
  ];
  for (const [re, what] of found) if (re.test(text)) return what;
  return null;
}

/** Contrôle une fonction avant enregistrement ; le code est compilé (jamais exécuté) pour attraper la syntaxe. */
export function checkSkill(input: SaveInput, builtins: Set<string>): { meta: SkillMeta; code: string } | { error: string } {
  const name = String(input.name ?? "").trim().toLowerCase();
  if (!validName(name)) {
    return { error: "name : « site.verbe » en minuscules (lettres, chiffres, _ ou -, au moins un point), 64 car. max. Ex. leboncoin.recherche." };
  }
  if (builtins.has(name)) return { error: `« ${name} » est une fonction intégrée d'ABC : choisir un autre nom.` };
  const description = String(input.description ?? "").trim();
  if (description.length < 10) return { error: "description : une phrase qui dit ce que la fonction fait et ce qu'elle renvoie (10 car. au moins)." };
  if (description.length > 400) return { error: `description : 400 caractères au plus (la tienne : ${description.length}). Elle est lue dans le catalogue : l'essentiel et ce qu'elle renvoie.` };
  const code = repairEntities(String(input.code ?? ""));
  if (!code.trim()) return { error: "code : corps d'une fonction async (args, nav, js, open, page, http, skill…), avec un return." };
  if (code.length > SKILL_CODE_MAX) return { error: `code : ${SKILL_CODE_MAX} caractères au plus.` };
  if (/\*\//.test(code) && HEADER_RE.test(code)) return { error: "code : ne pas y inclure d'en-tête @skill." };
  try {
    new AsyncFunction("args", code);
  } catch (err) {
    return { error: `code : erreur de syntaxe (${err instanceof Error ? err.message : err}).` };
  }
  const rawParams = input.params ?? {};
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return { error: 'params : objet {nom: {type, description, required?, default?}}, ex. {"query": {"type": "string", "required": true}}.' };
  }
  const params: Record<string, SkillParam> = {};
  for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
    if (!PARAM_RE.test(k)) return { error: `params : nom « ${k} » invalide (identifiant JavaScript).` };
    const p = (typeof v === "string" ? { type: v } : v) as Partial<SkillParam> | null;
    if (!p || typeof p !== "object" || !TYPES.includes(p.type as SkillParamType)) {
      return { error: `params.${k}.type : ${TYPES.join(", ")}.` };
    }
    params[k] = {
      type: p.type as SkillParamType,
      ...(p.description ? { description: String(p.description).slice(0, 200) } : {}),
      ...(p.required ? { required: true } : {}),
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(Array.isArray(p.enum) && p.enum.length ? { enum: p.enum.slice(0, 30) } : {}),
    };
  }
  let site: string | undefined;
  if (input.site !== undefined && input.site !== null && input.site !== "") {
    site = String(input.site).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(site)) return { error: "site : nom d'hôte (ex. leboncoin.fr ; le domaine nu couvre ses sous-domaines)." };
  }
  const effects = input.effects === "write" ? "write" : "read";
  const returns = input.returns ? String(input.returns).slice(0, 200) : undefined;
  const leak = privateData(`${code}\n${description}\n${JSON.stringify(params)}`);
  if (leak) {
    return { error: `Fonction refusée : elle contient ${leak}. Une fonction est rejouée et peut être partagée : jamais de donnée personnelle ni de secret en dur. Passe la valeur en paramètre (args), ou laisse credentials_fill remplir les identifiants.` };
  }
  return { meta: { name, description, params, ...(site ? { site } : {}), effects, ...(returns ? { returns } : {}) }, code };
}

/** Écrit (ou remplace) une fonction apprise ; la version précédente part dans .anciennes/. */
export function writeLearned(configDir: string, meta: SkillMeta, code: string, author: string, previous?: Skill): string {
  const dir = learnedDir(configDir);
  mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const file = join(dir, `${meta.name}.js`);
  const full: SkillMeta = {
    ...meta,
    author: previous?.author && previous.author !== author ? `${previous.author}, ${author}` : author,
    created: previous?.created ?? today,
    updated: today,
    version: (previous?.version ?? 0) + 1,
  };
  if (previous && existsSync(file)) archive(dir, file, meta.name, previous.version ?? 1);
  writeFileSync(file, formatSkillFile(full, code), { mode: 0o600 });
  return file;
}

/** Retire une fonction apprise (gardée dans .anciennes/ : rien ne se perd). */
export function deleteLearned(configDir: string, skill: Skill): void {
  archive(learnedDir(configDir), skill.file, skill.name, skill.version ?? 1, "supprimée");
}

function archive(dir: string, file: string, name: string, version: number, tag = `v${version}`): void {
  const old = join(dir, ".anciennes");
  mkdirSync(old, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  renameSync(file, join(old, `${name}.${tag}.${stamp}.js`));
}

// --- Catalogue --------------------------------------------------------------------------------------

/** Fonctions applicables à un hôte (le domaine nu de la fonction couvre ses sous-domaines). */
export function skillsForHost(skills: Map<string, Skill>, host: string): Skill[] {
  return [...skills.values()].filter((s) => s.site && siteKeyCovers(host, s.site));
}

function statsNote(st: SkillStats | undefined): string {
  if (!st || !st.runs) return "jamais lancée";
  const avg = st.ok ? ` · ${(st.totalMs / st.runs / 1000).toFixed(1).replace(".", ",")} s` : "";
  const warn = st.streak >= 2 ? ` · ⚠ ${st.streak} échecs de suite, à réparer${st.lastError ? ` (${st.lastError.slice(0, 90)})` : ""}` : "";
  return `${st.ok}/${st.runs} réussie(s)${avg}${warn}`;
}

/** Une ligne de catalogue : signature, site, effet, description, statistiques. */
export function skillLine(s: Skill, st?: SkillStats): string {
  const where = s.site ? ` [${s.site}]` : "";
  const write = s.effects === "write" ? " [agit : accord de l'utilisateur requis]" : "";
  const stats = s.source === "learned" ? ` (${statsNote(st)})` : "";
  return `- ${signature(s)}${where}${write} : ${s.description}${stats}`;
}

/**
 * Catalogue servi à l'agent : intégrées en une ligne (elles ont aussi leurs outils search et read_urls),
 * apprises en détail, les plus utilisées d'abord. Borné pour rester bon marché à chaque début de session.
 */
export function formatCatalog(skills: Map<string, Skill>, stats: Record<string, SkillStats>, opts: { max?: number; site?: string } = {}): string {
  const max = opts.max ?? 25;
  const builtin = [...skills.values()].filter((s) => s.source === "builtin");
  let learned = [...skills.values()].filter((s) => s.source === "learned");
  if (opts.site) learned = learned.filter((s) => s.site && (siteKeyCovers(opts.site!, s.site) || siteKeyCovers(s.site, opts.site!)));
  learned.sort((a, b) => (stats[b.name]?.ok ?? 0) - (stats[a.name]?.ok ?? 0) || a.name.localeCompare(b.name));
  const lines = [
    "Fonctions ABC : un parcours entier en 1 appel, sans aller-retour avec le modèle. À essayer AVANT de piloter pas à pas.",
    `Intégrées : ${builtin.map((s) => signature(s)).join(" · ")} (outils search et read_urls).`,
  ];
  if (learned.length) {
    lines.push(`Apprises (${learned.length}) : skill {action: "run", name, args}`);
    for (const s of learned.slice(0, max)) lines.push(skillLine(s, stats[s.name]));
    if (learned.length > max) lines.push(`… et ${learned.length - max} autre(s) : skill {action: "list"}.`);
  } else {
    lines.push("Apprises : aucune pour l'instant. Une recherche ou un relevé réussi sur un site resservira : fige-le avant de répondre, skill {action: \"save\", …}.");
  }
  return lines.join("\n");
}

/** Bloc servi à l'arrivée sur un site qui a des fonctions apprises. */
export function formatSiteSkills(skills: Map<string, Skill>, stats: Record<string, SkillStats>, host: string): string | null {
  const list = skillsForHost(skills, host);
  if (!list.length) return null;
  return [
    `Fonctions apprises pour ${host} (1 appel au lieu du parcours : skill {action: "run", name, args}) :`,
    ...list.slice(0, 8).map((s) => skillLine(s, stats[s.name])),
  ].join("\n");
}

/** Fiche complète d'une fonction (show) : de quoi la relancer, l'adapter ou la réparer. */
export function formatSkillDetail(s: Skill, st?: SkillStats): string {
  const params = Object.entries(s.params ?? {}).map(
    ([k, p]) =>
      `  ${k} : ${p.type}${p.required ? ", requis" : ""}${p.default !== undefined ? `, défaut ${JSON.stringify(p.default)}` : ""}` +
      `${p.enum ? `, parmi ${p.enum.map((e) => JSON.stringify(e)).join("/")}` : ""}${p.description ? ` (${p.description})` : ""}`,
  );
  const meta = [
    `${signature(s)} : ${s.description}`,
    `Source : ${s.source === "builtin" ? "intégrée à ABC" : `apprise (${s.author ?? "?"}, v${s.version ?? 1}, ${s.updated ?? s.created ?? "?"})`}` +
      `${s.site ? ` · site ${s.site}` : ""} · effet ${s.effects ?? "read"}`,
    ...(s.returns ? [`Renvoie : ${s.returns}`] : []),
    ...(params.length ? ["Paramètres :", ...params] : ["Sans paramètre."]),
    ...(st?.runs ? [`Statistiques : ${statsNote(st)}${st.lastError ? ` · dernière erreur : ${st.lastError}` : ""}`] : []),
    `Fichier : ${s.file}`,
  ];
  return `${meta.join("\n")}\n\nCode :\n\`\`\`js\n${s.code.trim()}\n\`\`\``;
}
