// Injecté dans le monde isolé de l'extension (persistant par frame).
// Construit l'arbre d'accessibilité compact et gère les refs d'éléments.
(() => {
  if (globalThis.__abc) return;

  const MAX_CHARS = 40_000;
  const refs = new Map(); // ref -> WeakRef<Element>
  const ids = new WeakMap(); // Element -> ref
  let counter = 0;

  function refFor(el) {
    let ref = ids.get(el);
    if (!ref) {
      ref = `ref_${++counter}`;
      ids.set(el, ref);
      refs.set(ref, new WeakRef(el));
    }
    return ref;
  }

  function elementFor(ref) {
    const el = refs.get(ref)?.deref();
    if (!el || !el.isConnected) throw new Error(`Élément ${ref} introuvable : relancer read_page.`);
    return el;
  }

  const INPUT_ROLES = {
    button: "button", submit: "button", reset: "button", image: "button",
    checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton",
    search: "searchbox", email: "textbox", tel: "textbox", url: "textbox",
    text: "textbox", password: "textbox", date: "textbox", "datetime-local": "textbox",
    time: "textbox", month: "textbox", week: "textbox", color: "button", file: "button",
  };

  const TAG_ROLES = {
    button: "button", select: "combobox", textarea: "textbox", img: "img",
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    nav: "navigation", main: "main", header: "banner", footer: "contentinfo", aside: "complementary",
    form: "form", ul: "list", ol: "list", li: "listitem", table: "table", tr: "row",
    td: "cell", th: "columnheader", dialog: "dialog", summary: "button", option: "option",
    article: "article", iframe: "iframe", video: "video", audio: "audio",
  };

  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "textbox", "searchbox", "combobox", "slider",
    "spinbutton", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
    "treeitem", "listbox",
  ]);

  // Rôles dont le nom résume le contenu : on ne descend pas dans leurs enfants.
  const LEAF_ROLES = new Set([
    "button", "link", "heading", "img", "textbox", "searchbox", "checkbox", "radio",
    "slider", "spinbutton", "switch", "option", "tab", "menuitem", "combobox", "iframe",
  ]);

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD", "META", "LINK"]);

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "input") {
      if (el.type === "hidden") return null;
      return INPUT_ROLES[el.type] ?? "textbox";
    }
    if (tag === "section" && (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"))) return "region";
    if (el.isContentEditable && el.parentElement && !el.parentElement.isContentEditable) return "textbox";
    return TAG_ROLES[tag] ?? null;
  }

  function clean(text, max = 100) {
    const t = (text ?? "").replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max) + "…" : t;
  }

  function nameOf(el, role) {
    const label = el.getAttribute("aria-label");
    if (label) return clean(label);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (clean(text)) return clean(text);
    }
    if (el.labels?.length) return clean([...el.labels].map((l) => l.innerText).join(" "));
    if (role === "img") return clean(el.getAttribute("alt") ?? el.getAttribute("title") ?? "");
    if (["button", "link", "heading", "option", "tab", "menuitem", "cell", "columnheader", "listitem", "summary"].includes(role)) {
      const text = clean(el.innerText);
      if (text) return text;
    }
    const own = clean(el.getAttribute("placeholder") ?? el.getAttribute("title") ?? "");
    if (own || !INTERACTIVE_ROLES.has(role)) return own;
    // Boutons à icône : nom porté par l'icône, sinon indice du développeur (data-testid).
    const inner = el.querySelector("[aria-label], svg title, img[alt]:not([alt=''])");
    const fromIcon = inner?.getAttribute("aria-label") ?? inner?.getAttribute("alt") ?? inner?.textContent;
    if (clean(fromIcon)) return clean(fromIcon);
    const hint = el.getAttribute("data-testid") ?? el.getAttribute("data-tooltip") ?? el.getAttribute("data-tip");
    return hint ? `(${clean(hint, 60)})` : "";
  }

  function isVisible(el) {
    if (el.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    // display:contents n'a pas de boîte : checkVisibility() renverrait false alors que les enfants sont visibles.
    if (style.display === "contents") return true;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: false })) return false;
    return true;
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute("onclick")) return true;
    const tabindex = el.getAttribute("tabindex");
    return tabindex !== null && Number(tabindex) >= 0;
  }

  function describe(el, role) {
    const parts = [role];
    const name = nameOf(el, role);
    if (name) parts.push(JSON.stringify(name));
    parts.push(`[${refFor(el)}]`);
    if (role === "heading") parts.push(`level=${el.tagName.match(/\d/)?.[0] ?? el.getAttribute("aria-level") ?? "?"}`);
    if (role === "link") {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:")) parts.push(`href=${JSON.stringify(clean(href, 150))}`);
    }
    if ("value" in el && ["textbox", "searchbox", "combobox", "spinbutton", "slider"].includes(role) && el.value) {
      parts.push(`value=${JSON.stringify(clean(el.type === "password" ? "••••" : el.value, 200))}`);
    }
    if (el.tagName === "INPUT" && el.type === "file") parts.push("type=file");
    if (el.checked || el.getAttribute("aria-checked") === "true") parts.push("checked");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    if (el.getAttribute("aria-expanded")) parts.push(`expanded=${el.getAttribute("aria-expanded")}`);
    if (el.getAttribute("aria-selected") === "true") parts.push("selected");
    return parts.join(" ");
  }

  function readPage({ filter = "all", ref } = {}) {
    const interactiveOnly = filter === "interactive";
    const lines = [];
    let size = 0;
    let truncated = false;

    let lastText = null; // { depth, text } si la dernière ligne émise est du texte

    function emitText(depth, t) {
      // Fusionne les fragments de texte consécutifs (ex. <p>un <strong>mot</strong> clé</p>).
      if (lastText?.depth === depth && !truncated) {
        lastText.text = clean(`${lastText.text} ${t}`, 300);
        lines[lines.length - 1] = "  ".repeat(depth) + "- text " + JSON.stringify(lastText.text);
        return;
      }
      emit(depth, `text ${JSON.stringify(t)}`);
      lastText = { depth, text: t };
    }

    function emit(depth, text) {
      lastText = null;
      if (truncated) return;
      const line = "  ".repeat(depth) + "- " + text;
      size += line.length + 1;
      if (size > MAX_CHARS) {
        truncated = true;
        return;
      }
      lines.push(line);
    }

    function walk(node, depth) {
      if (truncated) return;
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (!interactiveOnly) {
            const text = clean(child.textContent, 300);
            if (text) emitText(depth, text);
          }
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(child.tagName.toUpperCase())) continue;
        if (!isVisible(child)) continue;
        visit(child, depth);
      }
      if (node.shadowRoot) walk(node.shadowRoot, depth);
    }

    function visit(el, depth) {
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      // Les images décoratives (sans nom) sont du bruit.
      const decorative = role === "img" && !interactive && !nameOf(el, role);
      const shown = interactiveOnly ? interactive : (role !== null && !decorative) || interactive;
      if (shown) {
        emit(depth, describe(el, role ?? "generic"));
        if (!LEAF_ROLES.has(role)) walk(el, depth + 1);
      } else {
        walk(el, depth);
      }
    }

    const root = ref ? elementFor(ref) : document.body;
    if (ref) visit(root, 0);
    else walk(root, 0);

    const header = `Page : ${document.title}\nURL : ${location.href}\nViewport : ${innerWidth}x${innerHeight}`;
    const footer = truncated
      ? "\n[Tronqué : utiliser filter='interactive' ou ref pour cibler un sous-arbre.]"
      : "";
    return `${header}\n\n${lines.join("\n") || "(aucun élément)"}${footer}`;
  }

  /** Fait défiler jusqu'à l'élément et renvoie son centre en coordonnées viewport. */
  function locate(ref) {
    const el = elementFor(ref);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) throw new Error(`Élément ${ref} sans dimensions (invisible ?).`);
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  function pageText() {
    const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
    const max = 50_000;
    return {
      title: document.title,
      url: location.href,
      text: text.length > max ? text.slice(0, max) + "\n[Tronqué]" : text,
    };
  }

  /** Recherche d'éléments par texte (nom accessible, placeholder, valeur…) ou par sélecteur 'css:…'. */
  function find({ query, limit = 20 }) {
    if (!query) throw new Error("'query' manquant.");
    let matches;
    if (query.startsWith("css:")) {
      matches = [...document.querySelectorAll(query.slice(4))]
        .filter((el) => !el.closest("#abc-overlay") && isVisible(el))
        .map((el) => ({ el, role: roleOf(el) ?? "generic", score: 1 }));
    } else {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      matches = [];
      for (const el of document.body.querySelectorAll("*")) {
        if (SKIP_TAGS.has(el.tagName.toUpperCase()) || el.closest("#abc-overlay")) continue;
        const role = roleOf(el);
        const ownText = [...el.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join(" ");
        if (!role && !isInteractive(el, role) && !clean(ownText)) continue;
        const haystack = [
          role, role ? nameOf(el, role) : "", ownText, el.getAttribute("placeholder"),
          el.getAttribute("title"), el.getAttribute("alt"), el.getAttribute("aria-label"),
          el.getAttribute("name"), el.id, "value" in el ? el.value : "",
        ].join(" ").toLowerCase();
        const hits = terms.filter((t) => haystack.includes(t)).length;
        if (hits < Math.ceil(terms.length / 2) || !isVisible(el)) continue;
        const score = hits / terms.length + (isInteractive(el, role) ? 0.5 : 0);
        matches.push({ el, role: role ?? "text", score });
      }
      matches.sort((a, b) => b.score - a.score);
    }
    const total = matches.length;
    const lines = matches.slice(0, limit).map(({ el, role }) => {
      let line = "- " + describe(el, role);
      if (role === "text" || role === "generic") {
        const t = clean(el.innerText, 120);
        if (t) line += ` ${JSON.stringify(t)}`;
      }
      return line;
    });
    const more = total > limit ? `\n(${total - limit} autres résultats non affichés)` : "";
    return lines.length ? `${total} résultat(s) pour ${JSON.stringify(query)} :\n${lines.join("\n")}${more}` : `Aucun élément trouvé pour ${JSON.stringify(query)}.`;
  }

  /** Définit la valeur d'un champ de formulaire en déclenchant les événements attendus par les frameworks. */
  function formInput({ ref, value }) {
    const el = elementFor(ref);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    if (el.tagName === "SELECT") {
      const wanted = String(value);
      const option = [...el.options].find((o) => o.value === wanted || o.text.trim() === wanted);
      if (!option) throw new Error(`Option ${JSON.stringify(wanted)} absente. Options : ${[...el.options].map((o) => o.text.trim()).join(", ")}`);
      el.value = option.value;
    } else if (el.type === "checkbox" || el.type === "radio") {
      const wanted = value === true || value === "true" || value === "on";
      if (el.checked !== wanted) el.click(); // click() déclenche les handlers des frameworks
      return `${ref} ${wanted ? "coché" : "décoché"}.`;
    } else if (el.isContentEditable) {
      el.focus();
      el.textContent = String(value);
    } else if ("value" in el) {
      el.focus();
      // Setter natif : contourne le suivi de valeur de React pour que l'événement 'input' soit pris en compte.
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      if (setter) setter.call(el, String(value));
      else el.value = String(value);
    } else {
      throw new Error(`${ref} n'est pas un champ de formulaire.`);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return `${ref} = ${JSON.stringify(el.type === "password" ? "••••" : String(value))}.`;
  }

  /** Pose un attribut temporaire pour retrouver l'élément depuis le monde principal (CDP). */
  function markRef(ref) {
    elementFor(ref).setAttribute("data-abc-target", ref);
    return `[data-abc-target="${ref}"]`;
  }

  // --- Retour visuel : bordure lumineuse + impulsion au point d'action ---------------

  let overlayRoot = null;
  let hideTimer = null;

  function ensureOverlay() {
    if (overlayRoot?.isConnected) return overlayRoot;
    const host = document.createElement("div");
    host.id = "abc-overlay";
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        .frame { position: fixed; inset: 0; box-shadow: inset 0 0 0 3px rgba(139, 92, 246, .85), inset 0 0 24px rgba(139, 92, 246, .45); }
        .pulse { position: fixed; width: 24px; height: 24px; margin: -12px 0 0 -12px; border-radius: 50%;
                 background: rgba(139, 92, 246, .35); border: 2px solid rgb(139, 92, 246);
                 animation: p .6s ease-out forwards; }
        @keyframes p { to { transform: scale(2.2); opacity: 0; } }
      </style>
      <div class="frame"></div>`;
    document.documentElement.appendChild(host);
    overlayRoot = { host, shadow };
    return overlayRoot;
  }

  function overlay({ x, y } = {}) {
    const { host, shadow } = ensureOverlay();
    host.style.display = "block";
    if (typeof x === "number" && typeof y === "number") {
      const dot = document.createElement("div");
      dot.className = "pulse";
      dot.style.left = `${x}px`;
      dot.style.top = `${y}px`;
      shadow.appendChild(dot);
      setTimeout(() => dot.remove(), 700);
    }
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideOverlay, 4000);
  }

  function hideOverlay() {
    if (overlayRoot?.host) overlayRoot.host.style.display = "none";
  }

  const isFileInput = (ref) => {
    const el = elementFor(ref);
    return el.tagName === "INPUT" && el.type === "file";
  };

  globalThis.__abc = { readPage, locate, pageText, find, formInput, markRef, isFileInput, overlay, hideOverlay };
})();
