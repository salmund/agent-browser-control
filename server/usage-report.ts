/**
 * Rapport d'usage tiré du journal du démon (actions.log) : où part le temps, ce qui échoue, ce qui est
 * répété pour rien. Fonction pure (lignes -> Markdown) : le script scripts/usage-report.ts lit le fichier.
 * C'est le compte rendu qu'on écrivait à la main après une session, produit tout seul.
 */

export interface LogLine {
  t?: string;
  agent?: string;
  tool?: string;
  args?: Record<string, unknown>;
  ms?: number;
  error?: boolean;
  errorText?: string;
  event?: string;
}

export interface ReportOptions {
  /** Ne garder que les lignes depuis cet instant (ms epoch). */
  since?: number;
  /** Ne garder que cet agent. */
  agent?: string;
  /** Fenêtre (ms) dans laquelle trois appels identiques comptent comme une boucle de réessai. */
  retryWindowMs?: number;
}

const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const fmtMs = (ms: number): string => (ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

export function parseLog(text: string): LogLine[] {
  const out: LogLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line) as LogLine);
    } catch {
      // ligne tronquée ou rotation en cours : ignorée
    }
  }
  return out;
}

/** Clé d'un appel pour repérer les répétitions : outil, action, cible ou URL. */
function callKey(l: LogLine): string {
  const a = l.args ?? {};
  const where = a.ref ?? a.target ?? a.url ?? a.query ?? a.selector ?? "";
  return `${l.tool}|${a.action ?? ""}|${String(where).slice(0, 80)}|${a.tabId ?? ""}`;
}

function hostOf(l: LogLine): string | null {
  const url = l.args?.url;
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function buildReport(lines: LogLine[], opts: ReportOptions = {}): string {
  const calls = lines.filter((l) => l.tool && typeof l.ms === "number").filter((l) => {
    if (opts.agent && l.agent !== opts.agent) return false;
    if (opts.since && l.t && Date.parse(l.t) < opts.since) return false;
    return true;
  });
  if (!calls.length) return "# Rapport d'usage ABC\n\nAucun appel dans la période.\n";

  const out: string[] = ["# Rapport d'usage ABC", ""];
  const total = calls.reduce((s, c) => s + (c.ms ?? 0), 0);
  const errors = calls.filter((c) => c.error);
  out.push(`${calls.length} appels, ${fmtMs(total)} cumulés, ${errors.length} en erreur (${Math.round((100 * errors.length) / calls.length)} %).`, "");

  // Par outil
  const byTool = new Map<string, LogLine[]>();
  for (const c of calls) byTool.set(c.tool!, [...(byTool.get(c.tool!) ?? []), c]);
  const rows = [...byTool.entries()].map(([tool, list]) => {
    const ms = list.map((c) => c.ms!).sort((a, b) => a - b);
    return { tool, n: list.length, sum: ms.reduce((s, x) => s + x, 0), med: pct(ms, 0.5), p95: pct(ms, 0.95), err: list.filter((c) => c.error).length };
  }).sort((a, b) => b.sum - a.sum);
  out.push("## Où part le temps", "", "| Outil | Appels | Total | Médiane | p95 | Erreurs |", "| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const r of rows.slice(0, 12)) out.push(`| ${r.tool} | ${r.n} | ${fmtMs(r.sum)} | ${fmtMs(r.med)} | ${fmtMs(r.p95)} | ${r.err} |`);
  out.push("");

  // Appels les plus lents
  const slow = [...calls].sort((a, b) => b.ms! - a.ms!).slice(0, 8);
  out.push("## Appels les plus lents", "");
  for (const c of slow) out.push(`- ${fmtMs(c.ms!)} : ${c.tool}${c.args?.action ? ` ${String(c.args.action)}` : ""}${c.error ? " (erreur)" : ""}${c.t ? ` à ${c.t.slice(11, 19)}` : ""}`);
  out.push("");

  // Erreurs les plus fréquentes
  const errTexts = new Map<string, number>();
  for (const c of errors) {
    const key = `${c.tool} : ${String(c.errorText ?? "(sans texte)").replace(/\s+/g, " ").replace(/\d{4,}/g, "N").slice(0, 110)}`;
    errTexts.set(key, (errTexts.get(key) ?? 0) + 1);
  }
  if (errTexts.size) {
    out.push("## Erreurs les plus fréquentes", "");
    for (const [k, n] of [...errTexts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) out.push(`- ${n} x ${k}`);
    out.push("");
  }

  // Boucles de réessai : le même appel au moins 3 fois dans la fenêtre, par le même agent
  const window = opts.retryWindowMs ?? 60_000;
  const loops: string[] = [];
  const groups = new Map<string, LogLine[]>();
  for (const c of calls) groups.set(`${c.agent}|${callKey(c)}`, [...(groups.get(`${c.agent}|${callKey(c)}`) ?? []), c]);
  for (const [key, list] of groups) {
    if (list.length < 3 || list[0].tool === "wait_for" || list[0].tool === "tabs_context") continue;
    const times = list.map((c) => (c.t ? Date.parse(c.t) : 0)).sort((a, b) => a - b);
    for (let i = 0; i + 2 < times.length; i++) {
      if (times[i + 2] - times[i] <= window) {
        loops.push(`- ${list.length} x ${key.split("|").slice(1, 4).filter(Boolean).join(" ")} (agent ${list[0].agent ?? "?"}, ${list.filter((c) => c.error).length} erreur(s))`);
        break;
      }
    }
  }
  if (loops.length) out.push("## Appels répétés (boucles de réessai probables)", "", ...loops.slice(0, 8), "");

  // Sites visités
  const hosts = new Map<string, number>();
  for (const c of calls) {
    const h = hostOf(c);
    if (h) hosts.set(h, (hosts.get(h) ?? 0) + 1);
  }
  if (hosts.size) {
    out.push("## Sites ouverts", "");
    for (const [h, n] of [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) out.push(`- ${h} : ${n} navigation(s)`);
    out.push("");
  }

  // Pistes déduites
  const tips: string[] = [];
  const finds = byTool.get("find")?.length ?? 0;
  const actions = (byTool.get("computer")?.length ?? 0) + (byTool.get("form_input")?.length ?? 0);
  if (finds >= 5 && actions && finds / actions > 0.6) tips.push("Beaucoup de `find` pour peu d'actions : viser par `target` (libellé) évite l'aller-retour.");
  if ((byTool.get("read_page")?.length ?? 0) >= 8) tips.push("Nombreux `read_page` : `diff`, `viewport` ou `maxItems` réduisent le contexte consommé.");
  if (errors.length / calls.length > 0.15) tips.push("Plus de 15 % d'appels en erreur : lire la section Erreurs ci-dessus avant d'insister.");
  if (loops.length) tips.push("Des appels identiques se répètent en rafale : l'action n'a probablement pas l'effet attendu, changer d'approche plutôt que réessayer.");
  if (tips.length) out.push("## Pistes", "", ...tips.map((t) => `- ${t}`), "");

  return out.join("\n");
}
