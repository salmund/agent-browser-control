#!/usr/bin/env node
/**
 * Banc de vitesse : rejoue un parcours type via le démon (ouvrir un onglet, naviguer sur des sites réels,
 * lire, capturer en arrière-plan, saisir dans un champ) et affiche médiane / 90e centile par étape.
 *   node test/bench.ts [--rounds 2] [--out test/out/bench-avant.json]
 * Comparer deux runs : node test/bench.ts --compare test/out/bench-avant.json test/out/bench-apres.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BASE_URL, getToken } from "../server/common.ts";

const SITES = [
  "https://fr.wikipedia.org/wiki/Altair",
  "https://www.lemonde.fr/",
  "https://github.com/trending",
  "https://www.amazon.fr/",
  "https://news.ycombinator.com/",
  "https://www.youtube.com/",
  "https://stackoverflow.com/questions",
  "https://www.bbc.com/news",
];

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

type Sample = { step: string; ms: number; error: boolean };

const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

function summarize(samples: Sample[]) {
  const by = new Map<string, Sample[]>();
  for (const s of samples) by.set(s.step, [...(by.get(s.step) ?? []), s]);
  const rows: Record<string, { n: number; p50: number; p90: number; max: number; err: number }> = {};
  for (const [step, list] of by) {
    const ms = list.map((s) => s.ms).sort((a, b) => a - b);
    rows[step] = { n: ms.length, p50: q(ms, 0.5), p90: q(ms, 0.9), max: ms.at(-1)!, err: list.filter((s) => s.error).length };
  }
  return rows;
}

if (process.argv.includes("--compare")) {
  const i = process.argv.indexOf("--compare");
  const [a, b] = [process.argv[i + 1], process.argv[i + 2]].map((f) => summarize(JSON.parse(readFileSync(f, "utf8"))));
  const table: Record<string, unknown> = {};
  for (const step of Object.keys(a)) {
    if (!b[step]) continue;
    table[step] = {
      "p50 avant": a[step].p50, "p50 après": b[step].p50,
      "p90 avant": a[step].p90, "p90 après": b[step].p90,
      "gain p50": `${Math.round(100 * (1 - b[step].p50 / a[step].p50))} %`,
      "err avant/après": `${a[step].err}/${b[step].err}`,
    };
  }
  console.table(table);
  process.exit(0);
}

const token = getToken();
const samples: Sample[] = [];

async function call(step: string, tool: string, args: Record<string, unknown>) {
  const t0 = performance.now();
  const res = await fetch(`${BASE_URL}/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-abc-token": token },
    body: JSON.stringify({ agent: "bench", tool, args }),
  });
  const json = (await res.json()) as { content?: { type: string; text?: string }[]; isError?: boolean };
  const ms = Math.round(performance.now() - t0);
  const error = !res.ok || json.isError === true;
  samples.push({ step, ms, error });
  const txt = json.content?.find((c) => c.type === "text")?.text ?? "";
  console.log(`${step.padEnd(22)} ${String(ms).padStart(6)} ms${error ? "  ERREUR " + txt.slice(0, 120) : ""}`);
  return txt;
}

const rounds = Number(arg("--rounds") ?? 1);
for (let r = 0; r < rounds; r++) {
  const created = await call("tabs_create", "tabs_create", { url: SITES[0] });
  const tabId = Number(/tabId\D*(\d+)/i.exec(created)?.[1] ?? /\b(\d{6,})\b/.exec(created)?.[1]);
  if (!tabId) throw new Error(`tabId introuvable : ${created}`);
  for (const url of SITES.slice(1)) {
    await call("navigate", "navigate", { tabId, url });
    await call("read_page", "read_page", { tabId, filter: "interactive" });
    await call("screenshot (fond)", "computer", { tabId, action: "screenshot", scale: 0.5 });
  }
  // Saisie ciblée dans un champ : clic + texte, onglet en arrière-plan.
  await call("navigate", "navigate", { tabId, url: "https://fr.wikipedia.org/wiki/Spécial:Recherche" });
  const found = await call("find", "find", { tabId, query: "css:input[name=search]" });
  const ref = /(ref_\d+)/.exec(found)?.[1];
  if (ref) {
    await call("type (ciblé)", "computer", { tabId, action: "type", ref, text: "Altair" });
    await call("left_click", "computer", { tabId, action: "left_click", ref });
  }
  await call("navigate+snapshot", "navigate", { tabId, url: "https://fr.wikipedia.org/wiki/Navigateur_web", snapshot: true });
  await call("tabs_close", "tabs_close", { tabId });
}

console.table(summarize(samples));
const out = arg("--out");
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(samples, null, 1));
  console.log(`Écrit : ${out}`);
}
