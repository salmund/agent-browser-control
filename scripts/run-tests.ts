/**
 * Lanceur de la suite ABC (portable, pas de shell) :
 * - `node scripts/run-tests.ts` : typecheck + syntaxe extension + tests sans navigateur (CI).
 * - `node scripts/run-tests.ts --e2e` : tests navigateur (Comet + extension, en local).
 * - `node scripts/run-tests.ts --all` : les deux.
 */
import { execFileSync } from "node:child_process";

const FAST: { name: string; cmd: string; args: string[]; shell?: boolean }[] = [
  // npx est un .cmd sur Windows : passe par le shell (sans ça, ENOENT silencieux).
  { name: "typecheck", cmd: "npx", args: ["tsc", "--noEmit"], shell: true },
  { name: "syntaxe extension", cmd: process.execPath, args: ["scripts/check-extension-syntax.ts"] },
  ...["extension-load", "devtools-unit", "settings", "analysis", "har-bodies", "har-export-code", "history", "housekeeping", "js-eval", "macros", "readme", "version", "watch", "ws-mask", "credentials", "bitwarden", "bw-keep", "bw-serve", "relay", "tabs-cleanup", "hardening", "smoke", "mcp-http", "pointer"].map(
    (t) => ({ name: `test/${t}`, cmd: process.execPath, args: [`test/${t}.ts`] }),
  ),
];

const E2E = [
  "e2e-readpage",
  "e2e-agent-control",
  "e2e-sandbox",
  "e2e-reader-wiki",
  "e2e-dropdowns",
  "e2e-compound",
  "e2e-aisites",
  "e2e-recording",
  "e2e-click-guard",
  "e2e-scroll-extract",
  "e2e-query",
  "e2e-wait-scroll",
  "e2e-readpage-labels",
  "e2e-find-relevance",
  "e2e-computer-steps",
  "e2e-replay",
  "e2e-site-brief",
  "e2e-action-effect",
  "e2e-visibility",
  "e2e-wait-settle",
  "e2e-js-refs",
  "e2e-ref-heal",
  "e2e-devtools",
  "e2e-read-tables",
  "e2e-navigate-spa",
  "e2e-script-resume",
  "e2e-form-rich",
  "e2e-api-hint",
  "e2e-macros",
  "e2e-ask-human",
  "e2e-watch",
  "e2e-demo",
  "e2e-front-queue",
].map((t) => ({ name: `test/${t}`, cmd: process.execPath, args: [`test/${t}.ts`] }));

const mode = process.argv[2] ?? "";
const steps = mode === "--e2e" ? E2E : mode === "--all" ? [...FAST, ...E2E] : FAST;

let failed = 0;
for (const s of steps) {
  process.stdout.write(`===== ${s.name} =====\n`);
  try {
    execFileSync(s.cmd, s.args, { stdio: "inherit", timeout: 300_000, shell: (s as { shell?: boolean }).shell ?? false });
  } catch {
    failed++;
    process.stdout.write(`!! ÉCHEC : ${s.name}\n`);
  }
}
process.stdout.write(failed ? `\n${failed} étape(s) en échec.\n` : `\nSuite OK (${steps.length} étapes).\n`);
process.exit(failed ? 1 : 0);
