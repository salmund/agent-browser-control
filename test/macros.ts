/**
 * Tests des macros auto-apprises (ST9) : squelettes, fouille, génération,
 * stockage site. Lancer avec : node test/macros.ts
 */
import assert from "node:assert";
import {
  deleteSiteMacro,
  formatSiteBrief,
  getSiteMacros,
  getSiteMacrosForHost,
  hostHasMemory,
  macroToScript,
  mineMacros,
  setSiteCall,
  setSiteMacro,
  skeletonKey,
  type LogCall,
  type SiteEntry,
} from "../server/analysis.ts";

// Squelettes : refs renumérotées, compteurs et saisies ignorés, code neutralisé.
assert.strictEqual(
  skeletonKey("computer", { tabId: 1, action: "left_click", ref: "ref_3" }),
  skeletonKey("computer", { tabId: 9, action: "left_click", ref: "ref_42" }),
  "refs normalisées",
);
assert.strictEqual(
  skeletonKey("computer", { action: "left_click", ref: "f2:ref_5" }),
  skeletonKey("computer", { action: "left_click", ref: "ref_5" }),
  "refs de frame normalisées",
);
assert.strictEqual(
  skeletonKey("javascript", { code: "document.querySelector('a').click()" }),
  skeletonKey("javascript", { code: 'document.querySelector("b").click()' }),
  "littéraux neutralisés",
);
assert.notStrictEqual(
  skeletonKey("javascript", { code: "document.querySelector('a').click()" }),
  skeletonKey("javascript", { code: "location.href" }),
  "structures différentes distinguées",
);
assert.strictEqual(
  skeletonKey("computer", { action: "type", text: "secret", ref: "ref_1" }),
  skeletonKey("computer", { action: "type", text: "autre", ref: "ref_1" }),
  "saisies exclues",
);

// Fouille : séquence répétée trouvée malgré refs et littéraux différents.
const flow = (ref: string, item: string): LogCall[] => [
  { agent: "moi", tool: "navigate", args: { url: "https://boutique.fr/liste" } },
  { agent: "moi", tool: "find", args: { query: "panier" } },
  { agent: "moi", tool: "computer", args: { action: "left_click", ref } },
  { agent: "moi", tool: "javascript", args: { code: `document.querySelector('${item}').textContent` } },
];
const calls: LogCall[] = [
  ...flow("ref_3", "#prix-a"),
  { agent: "moi", tool: "get_page_text", args: {}, error: true },
  ...flow("ref_7", "#prix-b"),
  { agent: "autre", tool: "navigate", args: { url: "https://ailleurs.fr/" } },
  { agent: "autre", tool: "find", args: { query: "x" } },
];
const found = mineMacros(calls);
assert.strictEqual(found.length, 1, "une macro apprise");
assert.strictEqual(found[0].occurs, 2, "deux occurrences");
assert.strictEqual(found[0].host, "boutique.fr", "hôte attribué");
assert.strictEqual(found[0].steps.length, 4, "quatre étapes");
assert.strictEqual(mineMacros(calls, { minOccurs: 3 }).length, 0, "seuil respecté");
assert.strictEqual(mineMacros(calls, { site: "ailleurs.fr" }).length, 0, "filtre site");

// Génération : primitives, échappement, placeholders.
const gen = macroToScript([
  { tool: "navigate", args: { tabId: 1, url: "https://boutique.fr/liste" } },
  { tool: "find", args: { query: "panier" } },
  { tool: "computer", args: { action: "left_click", ref: "ref_3" } },
  { tool: "computer", args: { action: "left_click", coordinate: [10, 20] } },
  { tool: "computer", args: { action: "key", text: "Enter" } },
  { tool: "form_input", args: { ref: "ref_4", value: "<masqué>" } },
  { tool: "javascript", args: { code: "localStorage.getItem(`clé-${x}`)" } },
  { tool: "wait_for", args: { tabId: 1, text: "ok", timeout: 5 } },
  { tool: "devtools", args: { tabId: 1, action: "har", op: "status" } },
]);
assert.ok(gen.code.includes('await nav("https://boutique.fr/liste");'), "nav");
assert.ok(gen.code.includes('await find("panier");'), "find");
assert.ok(gen.code.includes("await click([10, 20]);"), "clic coordonnées");
assert.ok(gen.code.includes('await key("Enter");'), "touche");
assert.ok(gen.code.includes('await js("localStorage.getItem(`clé-${x}`)");'), "js en littéral JSON");
// Le littéral rend le code à l'identique, échappements et regex compris (String.raw les doublait).
const tricky = String.raw`/\d+\s"a"\\/.test(x) && ${"`${y}`"}`;
const trickyLine = macroToScript([{ tool: "javascript", args: { code: tricky } }]).code.split("\n").find((l) => l.startsWith("await js("))!;
assert.strictEqual(JSON.parse(trickyLine.slice("await js(".length, -2)), tricky, "code restitué à l'identique");
assert.ok(gen.code.includes('await waitFor({"text":"ok","timeout":5});'), "waitFor sans tabId");
assert.ok(gen.code.includes('await call("devtools", {"action":"har","op":"status"});'), "repli call()");
assert.ok(gen.code.includes("À-COMPLÉTER"), "placeholders");
assert.strictEqual(gen.placeholders, 2, "clic par ref + saisie");

// Stockage : ajout, lecture hôte exact/parent, suppression, brief, mémoire.
let api: Record<string, SiteEntry> = {};
assert.deepStrictEqual(getSiteMacros(undefined), []);
api = setSiteMacro(api, "boutique.fr", { name: "panier", code: "await nav(1);", steps: ["navigate"], updated: "2026-10-13" });
assert.strictEqual(getSiteMacros(api["boutique.fr"]).length, 1);
api = setSiteMacro(api, "www.boutique.fr", { name: "panier", code: "await nav(2);", steps: ["navigate"], updated: "2026-10-13" });
assert.strictEqual(getSiteMacrosForHost(api, "www.boutique.fr")[0].code, "await nav(2);", "hôte exact gagne");
assert.strictEqual(getSiteMacrosForHost(api, "fr.boutique.fr").length, 1, "parent couvre");
assert.strictEqual(getSiteMacrosForHost(api, "autre.fr").length, 0);
api = setSiteCall(api, "boutique.fr", { name: "a", method: "GET", path: "/", updated: "2026-10-13" });
assert.strictEqual(getSiteMacros(api["boutique.fr"]).length, 1, "setSiteCall préserve les macros");
const brief = formatSiteBrief(api, "boutique.fr") ?? "";
assert.ok(brief.includes("1 macro") && brief.includes("« panier »"), "brief cite la macro");
assert.strictEqual(hostHasMemory({ "m.fr": { calls: [], routes: {}, macros: [{ name: "x", code: "c", steps: [], updated: "d" }] } }, "m.fr"), true);
assert.strictEqual(deleteSiteMacro(api, "boutique.fr", "absente").removed, false);
const del = deleteSiteMacro(api, "boutique.fr", "panier");
assert.strictEqual(del.removed, true);
assert.ok("boutique.fr" in del.api, "site avec appel seul survit");
const delLast = deleteSiteMacro({ "s.fr": { calls: [], routes: {}, macros: [{ name: "x", code: "c", steps: [], updated: "d" }] } }, "s.fr", "x");
assert.deepStrictEqual(delLast.api, {}, "site vidé disparaît");

console.log("macros : OK (squelettes, fouille, génération, stockage, brief)");
