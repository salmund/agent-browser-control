/**
 * Cohérence des versions (ST12) : package.json, manifest, démon, shim MCP et
 * créateur HAR partagent la même version (plus de couples désynchronisés).
 * Lancer avec : node test/version.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8")).version as string;
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8")).version as string;
const daemon = readFileSync("server/daemon.ts", "utf8").match(/const VERSION = "([^"]+)"/)?.[1];
const shim = readFileSync("server/mcp.ts", "utf8").match(/\{ name: "agent-browser-control", version: "([^"]+)" \}/)?.[1];
const har = readFileSync("server/har.ts", "utf8").match(/creator: \{ name: "Agent Browser Control", version: "([^"]+)" \}/)?.[1];

for (const [nom, v] of Object.entries({ manifest, daemon, shim, har })) {
  assert.ok(v, `version lisible (${nom})`);
  assert.strictEqual(v, pkg, `${nom} (${v}) suit package.json (${pkg})`);
}
assert.match(pkg, /^\d+\.\d+\.\d+$/, "semver");

console.log(`versions cohérentes : ${pkg}`);
