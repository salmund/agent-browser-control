/**
 * Test sans navigateur du rapport d'usage (server/usage-report.ts) : agrégats par outil, appels lents,
 * erreurs groupées, boucle de réessai repérée, filtres agent et période, lignes illisibles ignorées.
 *
 * Lancer avec : node test/usage-report.ts
 */
import assert from "node:assert";
import { buildReport, parseLog } from "../server/usage-report.ts";

const t0 = Date.parse("2026-10-20T10:00:00.000Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
const line = (o: Record<string, unknown>) => JSON.stringify(o);

const log = [
  line({ t: at(0), agent: "a", tool: "navigate", args: { url: "https://sogo.univ-rouen.fr/" }, ms: 2400, error: false }),
  line({ t: at(5), agent: "a", tool: "form_input", args: { ref: "ref_9" }, ms: 300, error: true, errorText: "Éditeur riche réfractaire 12345" }),
  line({ t: at(8), agent: "a", tool: "form_input", args: { ref: "ref_9" }, ms: 310, error: true, errorText: "Éditeur riche réfractaire 67890" }),
  line({ t: at(11), agent: "a", tool: "form_input", args: { ref: "ref_9" }, ms: 290, error: true, errorText: "Éditeur riche réfractaire 11111" }),
  ...Array.from({ length: 6 }, (_, i) => line({ t: at(20 + i), agent: "a", tool: "find", args: { query: `q${i}` }, ms: 80, error: false })),
  line({ t: at(40), agent: "a", tool: "computer", args: { action: "left_click", ref: "ref_1" }, ms: 400, error: false }),
  line({ t: at(50), agent: "b", tool: "read_page", args: {}, ms: 120, error: false }),
  "{ligne tronquée",
  line({ event: "watch_triggered" }),
].join("\n");

const lines = parseLog(log);
assert.strictEqual(lines.length, 13, "lignes valides gardées, tronquée ignorée");

const r = buildReport(lines);
assert.ok(r.includes("12 appels"), "appels comptés (l'événement sans outil est exclu) : " + r.slice(0, 200));
assert.ok(/\| navigate \| 1 \| 2\.4 s/.test(r), "temps par outil");
assert.ok(r.includes("3 x form_input : Éditeur riche réfractaire N"), "erreurs groupées, nombres normalisés");
assert.ok(r.includes("Appels répétés") && r.includes("3 x form_input"), "boucle de réessai repérée");
assert.ok(r.includes("sogo.univ-rouen.fr : 1 navigation"), "sites ouverts");
assert.ok(r.includes("`find`") && r.includes("target"), "piste find/target déduite");

assert.ok(!buildReport(lines, { agent: "b" }).includes("form_input"), "filtre agent");
assert.ok(buildReport(lines, { since: t0 + 45_000 }).includes("1 appels"), "filtre période : un seul appel restant");
assert.ok(buildReport(lines, { since: t0 + 10 * 3600_000 }).includes("Aucun appel"), "période vide");

console.log("usage-report : OK");
