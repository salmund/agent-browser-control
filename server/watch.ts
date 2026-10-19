/**
 * Surveillances persistantes (SG15) : le démon, déjà persistant, évalue
 * périodiquement des conditions dans les onglets des agents (texte apparu,
 * sélecteur présent, expression JS vraie) et consigne les déclenchements.
 * L'agent déclare (declare), le démon vérifie seul (tick), l'agent relit
 * (list) ou force (check). Évaluations via l'outil javascript (propriété
 * de l'onglet vérifiée par l'extension, comme tout appel).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./common.ts";

export type WatchCond = { text: string } | { selector: string } | { js: string };

export interface Watcher {
  id: string;
  name: string;
  agent: string;
  tabId: number;
  cond: WatchCond;
  intervalSec: number;
  createdAt: number;
  expiresAt: number | null;
  /** Dernier état : armed (jamais déclenchée), triggered, error, paused. */
  state: "armed" | "triggered" | "error" | "paused";
  stateNote: string;
  lastCheckAt: number | null;
  nextCheckAt: number;
  errors: number;
  triggers: number;
  lastValue: string;
}

export const WATCH_MIN_INTERVAL = 15;
export const WATCH_MAX_INTERVAL = 86_400;
export const WATCH_MAX_ERRORS = 5;

export const watchesFile = (dir: string = CONFIG_DIR) => join(dir, "watches.json");

export function loadWatches(file?: string): Watcher[] {
  const f = file ?? watchesFile();
  if (!existsSync(f)) return [];
  try {
    const o = JSON.parse(readFileSync(f, "utf8")) as { watchers?: unknown };
    return Array.isArray(o.watchers) ? (o.watchers as Watcher[]).filter((w) => w && typeof w.id === "string") : [];
  } catch {
    return [];
  }
}

export function saveWatches(watchers: Watcher[], file?: string): void {
  const f = file ?? watchesFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ watchers }, null, 2) + "\n", { mode: 0o600 });
}

export const condText = (c: WatchCond) =>
  "text" in c ? `texte ${JSON.stringify(c.text)}` : "selector" in c ? `sélecteur ${JSON.stringify(c.selector)}` : "expression JS";

/** Sonde JS : renvoie toujours un JSON {match, value} (texte et sélecteur). */
export function probeCode(cond: WatchCond): string {
  if ("text" in cond) {
    return `(() => { const t = document.body ? document.body.innerText : ""; const i = t.indexOf(${JSON.stringify(cond.text)}); return JSON.stringify({ match: i >= 0, value: i >= 0 ? t.slice(Math.max(0, i - 60), i + 140) : t.slice(0, 200) }); })()`;
  }
  if ("selector" in cond) {
    return `(() => { let n = -1; try { n = document.querySelectorAll(${JSON.stringify(cond.selector)}).length; } catch (e) { return JSON.stringify({ match: false, value: "sélecteur invalide" }); } const first = n > 0 ? (document.querySelector(${JSON.stringify(cond.selector)}).innerText || "").slice(0, 200) : ""; return JSON.stringify({ match: n > 0, value: n + " élément(s)" + (first ? " : " + first : "") }); })()`;
  }
  return cond.js;
}

/**
 * Interprète le texte renvoyé par l'outil javascript : JSON {match, value} des
 * sondes, sinon valeur brute (vide, false, null, undefined et 0 = pas de match).
 */
export function parseProbeResult(out: string, cond: WatchCond): { match: boolean; value: string } {
  const text = (out ?? "").trim().replace(/^<page_content[^>]*>\n?/, "").replace(/\n?<\/page_content>$/, "").trim();
  if ("text" in cond || "selector" in cond) {
    try {
      const o = JSON.parse(text) as { match?: unknown; value?: unknown };
      return { match: o.match === true, value: String(o.value ?? "").slice(0, 500) };
    } catch {
      return { match: false, value: text.slice(0, 500) };
    }
  }
  const falsy = ["", "false", "null", "undefined", "0", "[]", "{}", '""', "''"];
  return { match: !falsy.includes(text), value: text.slice(0, 500) };
}

/** Échéance dépassée, pause auto après trop d'erreurs, prochaine vérification. */
export function watchDue(w: Watcher, now: number): boolean {
  if (w.state === "paused") return false;
  if (w.expiresAt && now >= w.expiresAt) return false;
  return now >= w.nextCheckAt;
}

export function describeWatcher(w: Watcher): string {
  const state = { armed: "armée", triggered: "DÉCLENCHÉE", error: "erreur", paused: "en pause" }[w.state];
  const parts = [`${w.id} « ${w.name} » (${state})`, `condition : ${condText(w.cond)}`, `onglet ${w.tabId}`, `toutes les ${w.intervalSec} s`];
  if (w.triggers) parts.push(`${w.triggers} déclenchement(s)`);
  if (w.stateNote) parts.push(w.stateNote);
  if (w.lastValue && w.state === "triggered") parts.push(`vu : ${w.lastValue.slice(0, 200)}`);
  return parts.join(" · ");
}
