/**
 * Test end-to-end du mode lecteur de get_page_text sur une fixture façon MediaWiki (Wikipédia) :
 * liens « modifier » des titres retirés, formules rendues en TeX (alttext / image de repli) au lieu
 * des nœuds MathML éclatés, palettes de navigation (navbox) retirées.
 *
 * Lancer avec : node test/e2e-reader-wiki.ts (extension + démon actifs, Comet ouvert)
 */
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-reader-wiki-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

const textOf = (res: unknown): string => {
  const c = res as { isError?: true; content: { type: string; text?: string }[] };
  assert.strictEqual(c.isError, undefined, "outil sans erreur");
  return c.content.map((b) => b.text ?? "").join("\n");
};

const MATH = '<math alttext="{\\displaystyle x^{2}+y^{2}=r^{2}}"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo>' +
  '<msup><mi>y</mi><mn>2</mn></msup><mo>=</mo><msup><mi>r</mi><mn>2</mn></msup></mrow>' +
  '<annotation encoding="application/x-tex">{\\displaystyle x^{2}+y^{2}=r^{2}}</annotation></semantics></math>';
const HTML =
  '<main id="content"><h1>Cœur humain</h1>' +
  '<div class="mw-heading mw-heading2"><h2 id="Anatomie">Anatomie</h2><span class="mw-editsection"><span class="mw-editsection-bracket">[</span>' +
  '<a href="#">modifier</a><span class="mw-editsection-divider"> | </span><a href="#">modifier le code</a><span class="mw-editsection-bracket">]</span></span></div>' +
  "<p>" + "Le cœur est un organe musculaire creux qui assure la circulation du sang. ".repeat(6) + "</p>" +
  "<p>Formule visible : <span class=\"mwe-math-element\">" + MATH +
  '<img class="mwe-math-fallback-image-inline" style="display:none" alt="{\\displaystyle x^{2}+y^{2}=r^{2}}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></span> fin.</p>' +
  '<p>Formule en image : <span class="mwe-math-element"><span class="mwe-math-mathml-inline" style="display:none">' + MATH.replace(/r\^\{2\}/g, "z") +
  '</span><img class="mwe-math-fallback-image-inline" alt="{\\displaystyle E=mc^{2}}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="12"></span> fin.</p>' +
  '<h3>Valves<span class="mw-editsection">[modifier | modifier le code]</span></h3><p>Les valves empêchent le reflux du sang dans les cavités cardiaques.</p>' +
  '<div class="navbox-container"><table class="navbox"><tr><td>[afficher] v · m Appareil circulatoire</td></tr></table></div></main>';

const created: number[] = [];
try {
  const tabId = Number(textOf(await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } })).match(/tabId\s+(\d+)/)?.[1]);
  assert.ok(tabId, "tabId extrait");
  created.push(tabId);
  textOf(await client.callTool({ name: "javascript", arguments: { tabId, code: `(() => { document.body.innerHTML = ${JSON.stringify(HTML)}; return "ok"; })()` } }));
  const text = textOf(await client.callTool({ name: "get_page_text", arguments: { tabId } }));
  console.log(text.split("\n").slice(0, 30).join("\n"));
  assert.ok(/^## Anatomie$/m.test(text) && /^### Valves$/m.test(text), "titres sans « modifier »");
  assert.ok(!/modifier/.test(text), "aucun lien d'édition");
  assert.ok(text.includes("$x^{2}+y^{2}=r^{2}$"), "formule MathML en TeX sur une ligne");
  assert.ok(text.includes("$E=mc^{2}$"), "formule en image : texte alternatif TeX");
  assert.ok(!/^x$/m.test(text), "pas de caractère par ligne");
  assert.ok(!text.includes("[afficher]") && !text.includes("Appareil circulatoire"), "palette de navigation retirée");
  console.log("\n✅ MODE LECTEUR WIKI : OK");
} finally {
  for (const id of created) await client.callTool({ name: "tabs_close", arguments: { tabId: id } }).catch(() => {});
  await client.close();
}
