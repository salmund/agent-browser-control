/**
 * Régénère les parties volatiles des README depuis server/tools.ts : compteurs
 * ("Les N outils") et listes d'outils par ligne du tableau. Les blurbs existants
 * ("`tabs_create` (aussi en navigation privée)") sont conservés ; un nouvel outil
 * apparaît sans blurb jusqu'à ce qu'on lui en écrive un. Fins de ligne conservées.
 * Lancer avec : npm run build-readme
 * Quand un outil n'a pas de rubrique ici, le script échoue : l'y ranger.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { TOOLS } from "../server/tools.ts";

const ROWS_FR = ["Onglets", "Voir", "Agir", "DevTools", "Enregistrer, automatiser"] as const;
const ROWS_EN: Record<string, string> = {
  Onglets: "Tabs",
  Voir: "See",
  Agir: "Act",
  DevTools: "DevTools",
  "Enregistrer, automatiser": "Record, automate",
};

/** Rubrique de chaque outil (ligne du tableau des README). */
const CATEGORY: Record<string, string> = {
  tabs_context: "Onglets",
  tabs_create: "Onglets",
  tabs_close: "Onglets",
  tabs_cleanup: "Onglets",
  history_search: "Onglets",
  navigate: "Onglets",
  resize_window: "Onglets",
  read_page: "Voir",
  find: "Voir",
  get_page_text: "Voir",
  read_screen_text: "Voir",
  save_image: "Voir",
  downloads: "Voir",
  read_document: "Voir",
  transcript: "Voir",
  computer: "Agir",
  form_input: "Agir",
  credentials_fill: "Agir",
  credentials_list: "Agir",
  file_upload: "Agir",
  wait_for: "Agir",
  handle_dialog: "Agir",
  javascript: "DevTools",
  read_console_messages: "DevTools",
  read_network_requests: "DevTools",
  network_get_body: "DevTools",
  network_intercept: "DevTools",
  read_websocket_messages: "DevTools",
  http_request: "DevTools",
  storage: "DevTools",
  performance_metrics: "DevTools",
  emulate: "DevTools",
  pdf: "DevTools",
  network_har: "DevTools",
  site_api: "DevTools",
  gif_creator: "Enregistrer, automatiser",
  browser_script: "Enregistrer, automatiser",
  download_media: "Enregistrer, automatiser",
};

const names = TOOLS.map((t) => t.name);
const orphans = names.filter((n) => !CATEGORY[n]);
if (orphans.length) {
  console.error(`Outils sans rubrique dans CATEGORY : ${orphans.join(", ")}`);
  process.exit(1);
}

/** Lignes du texte en conservant chaque fin de ligne. */
function linesOf(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\n|$)/g)?.filter((l) => l.length > 0) ?? [];
}

/** Outils cités dans une ligne de tableau : [{ name, blurb }], blurb = texte après le nom. */
function parseRow(line: string): { name: string; blurb: string }[] {
  const cells = line.split("|");
  const body = cells.length >= 3 ? cells[2] : line;
  return body
    .split("·")
    .map((chunk) => {
      const m = /`([^`]+)`(.*)/.exec(chunk);
      return m ? { name: m[1].trim(), blurb: m[2].trim() } : null;
    })
    .filter((x): x is { name: string; blurb: string } => x !== null);
}

function buildRow(label: string, items: { name: string; blurb: string }[], eol: string): string {
  const body = items.map((i) => (i.blurb ? `\`${i.name}\` ${i.blurb}` : `\`${i.name}\``)).join(" · ");
  return `| **${label}** | ${body} |${eol}`;
}

function rebuild(file: string, labelToCategory: Record<string, string>, counts: [RegExp, string][]): void {
  const raw = readFileSync(file, "utf8");
  const lines = linesOf(raw);
  const isRow = (line: string) => {
    const m = /^\| \*\*(.+?)\*\* \|/.exec(line);
    return m && labelToCategory[m[1]] ? m[1] : null;
  };
  const blurbs = new Map<string, string>();
  for (const line of lines) {
    if (!isRow(line)) continue;
    for (const item of parseRow(line)) if (!blurbs.has(item.name)) blurbs.set(item.name, item.blurb);
  }
  const byLabel = new Map<string, string[]>();
  for (const n of names) {
    const list = byLabel.get(CATEGORY[n]) ?? [];
    list.push(n);
    byLabel.set(CATEGORY[n], list);
  }
  const stray = [...blurbs.keys()].filter((n) => !names.includes(n));
  if (stray.length) console.error(`ATTENTION ${file} : outils cités mais inconnus de tools.ts : ${stray.join(", ")}`);
  const out = lines.map((line) => {
    const m = /^\| \*\*(.+?)\*\* \|/.exec(line);
    const category = m ? labelToCategory[m[1]] : undefined;
    if (!m || !category) {
      let updated = line;
      for (const [re, replacement] of counts) updated = updated.replace(re, replacement);
      return updated;
    }
    const eol = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const items = (byLabel.get(category) ?? []).map((n) => ({ name: n, blurb: blurbs.get(n) ?? "" }));
    return buildRow(m[1], items, eol);
  });
  writeFileSync(file, out.join(""));
}

const n = names.length;
const frLabels: Record<string, string> = Object.fromEntries(ROWS_FR.map((l) => [l, l]));
const enLabels: Record<string, string> = Object.fromEntries(Object.entries(ROWS_EN).map(([fr, en]) => [en, fr]));
rebuild("README.md", frLabels, [
  [/Les \d+ outils/, `Les ${n} outils`],
  [/dispose des \d+ outils/, `dispose des ${n} outils`],
]);
rebuild("README.en.md", enLabels, [
  [/The \d+ tools/, `The ${n} tools`],
  [/all \d+ tools/, `all ${n} tools`],
]);
console.log(`README régénérés : ${n} outils.`);
