/**
 * Les onglets ouverts par open() dans browser_script sont-ils toujours refermés ?
 * Enchaîne des scripts seuls, juste après read_urls et search, et en parallèle, puis compte les onglets.
 *
 * Lancer avec : node test/e2e-fuite-onglets.ts (extension + démon actifs)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-fuite-onglets", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));
type Res = { isError?: true; content: { type: string; text?: string }[] };
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as unknown as Res;
const text = (r: Res) => r.content.map((b) => b.text ?? "").join("\n");
const tabs = async () => new Set((text(await call("tabs_context")).match(/tabId (\d+)/g) ?? []).map((m) => m.slice(6)));
const SCRIPT = { code: "const id = await open(args.url); const p = await page(id); return { id, n: p.text.length };", args: { url: "https://example.com" } };
const leaks: string[] = [];

async function script(label: string): Promise<void> {
  const r = await call("browser_script", SCRIPT);
  const out = text(r);
  const id = /"id": (\d+)/.exec(out)?.[1];
  if (r.isError || !id) return void leaks.push(`${label} : script en erreur (${out.slice(0, 200)})`);
  if (/non refermé/.test(out)) leaks.push(`${label} : ${/open\(\) : .+/.exec(out)?.[0]}`);
  if ((await tabs()).has(id)) leaks.push(`${label} : onglet ${id} encore ouvert`);
}

try {
  const before = await tabs();
  for (let i = 0; i < 10; i++) await script(`seul ${i + 1}`);
  for (let i = 0; i < 3; i++) {
    await call("read_urls", { urls: ["https://example.org"], maxChars: 300 });
    await script(`après read_urls ${i + 1}`);
    await call("search", { query: `example domain ${i}`, limit: 3 });
    await script(`après search ${i + 1}`);
  }
  for (let i = 0; i < 3; i++) await Promise.all([1, 2, 3].map((k) => script(`parallèle ${i + 1}.${k}`)));
  const after = await tabs();
  const extra = [...after].filter((id) => !before.has(id));
  console.log(`onglets avant ${before.size}, après ${after.size}, en trop : ${extra.join(", ") || "aucun"}`);
  console.log(leaks.length ? `fuites :\n${leaks.join("\n")}` : "aucune fuite sur 25 scripts");
  for (const id of extra) await call("tabs_close", { tabId: Number(id) });
  assert.strictEqual(leaks.length + extra.length, 0, "onglets de open() refermés");
  console.log("\n✅ Fuite d'onglets : OK");
} finally {
  await client.close();
}
