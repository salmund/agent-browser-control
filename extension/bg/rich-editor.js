// Éditeurs riches pilotés par leur propre API, depuis le monde principal de la page.
// Pourquoi : coller du texte multiligne par insertText dans CKEditor 5 (Sogo, webmails, CMS) casse son
// modèle interne (CKEditorError view-renderer-filler-was-lost, paragraphes vides en trop, éditeur figé).
// Avec setData() le contenu est posé d'un coup, proprement, et l'éditeur reste utilisable.
// Pris en charge : CKEditor 5 (element.ckeditorInstance) et Quill (.ql-container.__quill).
// Les autres éditeurs gardent le chemin générique de page.js (fillEditable).

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Texte brut -> HTML : ligne vide = nouveau paragraphe, saut simple = <br>. */
function plainToHtml(value) {
  const blocks = String(value ?? "").replace(/\r\n?/g, "\n").split(/\n{2,}/).map((b) => b.replace(/^\n+|\n+$/g, "")).filter(Boolean);
  return blocks.map((b) => `<p>${escapeHtml(b).replace(/\n/g, "<br>")}</p>`).join("");
}

function markdownInline(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, "$1<em>$2</em>");
}

/** Markdown léger (titres #, listes - et 1., **gras**, *italique*, paragraphes) -> HTML. */
function markdownToHtml(md) {
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(markdownInline).join("<br>")}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of String(md ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    let m;
    if ((m = /^\s*[-*•]\s+(.*)$/.exec(line)) || (m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      const kind = /^\s*\d/.test(line) ? "ol" : "ul";
      flushPara();
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${markdownInline(m[1])}</li>`);
      continue;
    }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flushPara();
      closeList();
      out.push(`<h${m[1].length}>${markdownInline(m[2])}</h${m[1].length}>`);
      continue;
    }
    closeList();
    para.push(line);
  }
  flushPara();
  closeList();
  return out.join("");
}

/** format : "text" (défaut), "html" (tel quel, l'éditeur le nettoie) ou "markdown". */
function richTextToHtml(value, format) {
  const f = String(format ?? "text").toLowerCase();
  if (f === "html") return String(value ?? "");
  if (f === "markdown" || f === "md") return markdownToHtml(value);
  if (f === "text" || f === "plain" || f === "") return plainToHtml(value);
  throw new Error(`format « ${format} » inconnu : text, html ou markdown.`);
}

/**
 * Pose `html` dans l'éditeur riche désigné par `selector` (attribut posé par markRef, retiré ici).
 * Renvoie { kind, len } si une API d'éditeur connue a pris le contenu, null si aucune (chemin générique),
 * ou lève une erreur franche si l'API a refusé.
 */
async function fillRichEditorApi(tabId, selector, html, wantsText) {
  const source = `((sel, html) => {
    const el = document.querySelector(sel);
    if (!el) return { error: "élément introuvable" };
    try {
      const ck = el.ckeditorInstance;
      if (ck && typeof ck.setData === "function") {
        ck.setData(html);
        const text = String(ck.getData() || "").replace(/<[^>]*>/g, "").trim();
        return { kind: "CKEditor 5 (setData)", len: text.length };
      }
      const box = el.closest(".ql-container");
      const quill = box && box.__quill;
      if (quill && quill.clipboard) {
        quill.setContents([]);
        quill.clipboard.dangerouslyPasteHTML(0, html);
        return { kind: "Quill (clipboard)", len: String(quill.getText() || "").trim().length };
      }
      // Tiptap : l'instance est posée sur l'élément ProseMirror (el.editor).
      const tip = el.editor;
      if (tip && tip.commands && typeof tip.commands.setContent === "function") {
        tip.commands.setContent(html);
        return { kind: "Tiptap (setContent)", len: String(tip.getText ? tip.getText() : el.textContent || "").trim().length };
      }
      // Lexical : état reconstruit en JSON (paragraphes et retours à la ligne ; mise en forme riche non reprise).
      const lex = el.__lexicalEditor;
      if (lex && typeof lex.parseEditorState === "function" && typeof lex.setEditorState === "function") {
        const tpl = document.createElement("template");
        tpl.innerHTML = html;
        const textNode = (t) => ({ detail: 0, format: 0, mode: "normal", style: "", text: t, type: "text", version: 1 });
        const para = (children) => ({ children, direction: null, format: "", indent: 0, type: "paragraph", version: 1 });
        const paras = [];
        const blocks = tpl.content.children.length ? [...tpl.content.children] : [tpl.content];
        for (const b of blocks) {
          const rows = b.matches && b.matches("ul,ol") ? [...b.children] : [b];
          for (const r of rows) {
            const kids = [];
            String(r.innerHTML !== undefined ? r.innerHTML : r.textContent).split(new RegExp("<br[ ]*[/]?>", "i")).forEach((chunk, i) => {
              if (i) kids.push({ type: "linebreak", version: 1 });
              const d = document.createElement("div");
              d.innerHTML = chunk;
              if (d.textContent) kids.push(textNode(d.textContent));
            });
            paras.push(para(kids));
          }
        }
        const state = { root: { children: paras.length ? paras : [para([])], direction: null, format: "", indent: 0, type: "root", version: 1 } };
        lex.setEditorState(lex.parseEditorState(JSON.stringify(state)));
        return { kind: "Lexical (setEditorState)", len: String(el.textContent || "").trim().length };
      }
      return null;
    } catch (e) {
      return { error: String((e && e.message) || e).slice(0, 200) };
    } finally {
      el.removeAttribute("data-abc-target");
    }
  })(${JSON.stringify(selector)}, ${JSON.stringify(html)})`;
  const res = await evaluate(tabId, source);
  if (!res) return null;
  if (res.error) throw new Error(`Éditeur riche : l'API de l'éditeur a refusé le contenu (${res.error}). Écrire avec computer (clic + type) ou passer par le mode Source de l'éditeur.`);
  if (wantsText && res.len === 0) throw new Error(`Éditeur riche (${res.kind}) : contenu vide après l'écriture, rien n'a été pris en compte.`);
  return res;
}
