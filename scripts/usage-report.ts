/**
 * Rapport d'usage tiré du journal du démon.
 *   node scripts/usage-report.ts [--since 24h|90m|7d] [--agent nom] [--file chemin] [--out rapport.md]
 * Sans --file : ~/.agent-browser-control/actions.log (et actions.log.1 s'il existe).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildReport, parseLog } from "../server/usage-report.ts";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function sinceMs(spec: string | undefined): number | undefined {
  if (!spec) return undefined;
  const m = /^(\d+)\s*(m|h|d)$/.exec(spec);
  if (!m) throw new Error(`--since attend 90m, 24h ou 7d (reçu : ${spec}).`);
  return Date.now() - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
}

const dir = join(homedir(), ".agent-browser-control");
const files = arg("--file") ? [arg("--file")!] : [join(dir, "actions.log.1"), join(dir, "actions.log")];
const text = files.filter((f) => existsSync(f)).map((f) => readFileSync(f, "utf8")).join("\n");
if (!text) {
  console.error("Aucun journal trouvé.");
  process.exit(1);
}
const report = buildReport(parseLog(text), { since: sinceMs(arg("--since")), agent: arg("--agent") });
if (arg("--out")) writeFileSync(arg("--out")!, report, "utf8");
else process.stdout.write(report);
