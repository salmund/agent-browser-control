/**
 * Test sans navigateur de bg/rich-editor.js : conversion du texte vers le HTML posé dans CKEditor / Quill
 * (text, markdown, html), échappement, format inconnu refusé.
 *
 * Lancer avec : node test/rich-editor.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx: Record<string, unknown> = {};
vm.createContext(ctx);
vm.runInContext(readFileSync("extension/bg/rich-editor.js", "utf8") + "\nthis.richTextToHtml = richTextToHtml;", ctx);
const toHtml = ctx.richTextToHtml as (value: unknown, format?: string) => string;

// texte : ligne vide = paragraphe, saut simple = <br>, rien n'est interprété
assert.strictEqual(toHtml("Salut,\n\nBonne journée\nLouis"), "<p>Salut,</p><p>Bonne journée<br>Louis</p>");
assert.strictEqual(toHtml("a < b & \"c\""), "<p>a &lt; b &amp; &quot;c&quot;</p>");
assert.strictEqual(toHtml("**pas gras**"), "<p>**pas gras**</p>", "le texte brut n'interprète pas le markdown");
assert.strictEqual(toHtml(""), "");
assert.strictEqual(toHtml("\n\n\nun\n\n\n\ndeux\n\n"), "<p>un</p><p>deux</p>", "lignes vides multiples = un seul saut de paragraphe");
assert.strictEqual(toHtml("x", "text"), "<p>x</p>");

// markdown : listes, gras, italique, titres
const md = toHtml("Titre\n\n1. un **gras**\n2. deux\n\n- a\n- b\n\n# Gros", "markdown");
assert.strictEqual(md, "<p>Titre</p><ol><li>un <strong>gras</strong></li><li>deux</li></ol><ul><li>a</li><li>b</li></ul><h1>Gros</h1>");
assert.strictEqual(toHtml("du *italique* ici", "markdown"), "<p>du <em>italique</em> ici</p>");
assert.strictEqual(toHtml("<b>x</b>", "markdown"), "<p>&lt;b&gt;x&lt;/b&gt;</p>", "le HTML du markdown est échappé");
assert.strictEqual(toHtml("l1\nl2", "md"), "<p>l1<br>l2</p>");

// html : tel quel (l'éditeur le nettoie lui-même)
assert.strictEqual(toHtml("<p>ok</p>", "html"), "<p>ok</p>");

// format inconnu : erreur nette
assert.throws(() => toHtml("x", "rtf"), /format « rtf » inconnu/);

console.log("rich-editor : OK");
