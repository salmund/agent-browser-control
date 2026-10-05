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
    if (tabindex !== null && Number(tabindex) >= 0) return true;
    return hasPointerCursor(el);
  }

  /**
   * Beaucoup d'interfaces (éditeurs, applis de dessin, SPA) font leurs boutons avec des <div> sans rôle :
   * le curseur en main est alors le meilleur indice qu'on peut cliquer. Le curseur s'hérite : on ne garde
   * que le plus haut élément de la chaîne, pas chacun de ses enfants.
   */
  function hasPointerCursor(el) {
    if (["HTML", "BODY"].includes(el.tagName)) return false;
    if (getComputedStyle(el).cursor !== "pointer") return false;
    const parent = el.parentElement;
    return !parent || getComputedStyle(parent).cursor !== "pointer";
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

  const lastReads = new Map(); // options de lecture -> lignes, pour diff=true

  function inViewport(el) {
    if (getComputedStyle(el).display === "contents") return true;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  /**
   * viewport : seulement ce qui est à l'écran. diff : seulement ce qui a changé depuis la lecture
   * précédente avec les mêmes options. frame : lecture d'une iframe (null si minuscule ou vide).
   */
  function readPage({ filter = "all", ref, viewport = false, diff = false, frame = false } = {}) {
    if (frame && (innerWidth < 30 || innerHeight < 30)) return null; // pixels de suivi, iframes cachées
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
        if (viewport && !inViewport(child)) continue;
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

    if (frame && !lines.length) return null;
    const scope = viewport ? " (partie visible seulement)" : "";
    const header = `Page : ${document.title}\nURL : ${location.href}\nViewport : ${innerWidth}x${innerHeight}${scope}`;
    const footer = truncated
      ? "\n[Tronqué : utiliser filter='interactive', viewport=true ou ref pour cibler un sous-arbre.]"
      : "";

    const key = JSON.stringify([filter, ref ?? null, viewport]);
    const previous = lastReads.get(key);
    lastReads.set(key, lines);
    if (diff && previous) {
      // Les refs sont stables d'une lecture à l'autre : une ligne identique = élément inchangé.
      const before = new Set(previous);
      const after = new Set(lines);
      const bare = (l) => l.trim().replace(/^- /, "");
      const removed = previous.filter((l) => !after.has(l)).map((l) => "- " + bare(l));
      const added = lines.filter((l) => !before.has(l)).map((l) => "+ " + bare(l));
      if (!removed.length && !added.length) {
        return frame ? null : `${header}\n\nAucun changement depuis la dernière lecture.`;
      }
      return `${header}\n\nChangements depuis la dernière lecture (${added.length} ajout(s), ${removed.length} retrait(s)) :\n` +
        [...removed, ...added].join("\n") + footer;
    }
    const note = diff ? "\n[Première lecture : les suivantes avec diff=true ne montreront que les changements.]" : "";
    let imagesBlock = "";
    if (!frame) {
      // Images générées ou intégrées, avec ref directe pour save_image : le cas qui
      // manque quand l'arbre n'en montre aucune (canvas, svg, <img> sans nom).
      const imgs = listImages(80, 10).map((img) => {
        const label = img.alt ? ` ${JSON.stringify(img.alt)}` : "";
        return `- image (${img.w}×${img.h}, ${img.srcType})${label} [${img.ref}]`;
      });
      if (imgs.length) imagesBlock = `\n\nImages à l'écran (${imgs.length}) :\n${imgs.join("\n")}`;
    }
    return `${header}\n\n${lines.join("\n") || "(aucun élément)"}${imagesBlock}${footer}${note}`;
  }

  /**
   * Fait défiler jusqu'à l'élément et renvoie son centre en coordonnées du viewport de la page
   * principale : dans une iframe, on ajoute la position de chaque iframe parente.
   */
  async function locate(ref) {
    const el = elementFor(ref);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) throw new Error(`Élément ${ref} sans dimensions (invisible ?).`);
    const offset = await frameOffset();
    return { x: Math.round(offset.x + r.left + r.width / 2), y: Math.round(offset.y + r.top + r.height / 2) };
  }

  // --- Position d'une iframe dans la page principale ------------------------------------
  // Une frame d'une autre origine ne peut pas lire sa position : elle la demande à sa frame
  // parente par postMessage ; la parente reconnaît l'iframe émettrice (contentWindow === source),
  // mesure sa position, y ajoute la sienne (récursivement) et répond.

  const pendingOffsets = new Map();

  function frameOffset() {
    if (window === top) return Promise.resolve({ x: 0, y: 0 });
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pendingOffsets.set(id, resolve);
      parent.postMessage({ __abc: "offset?", id }, "*");
      setTimeout(() => {
        if (pendingOffsets.delete(id)) reject(new Error("Position de l'iframe introuvable : relancer read_page puis réessayer."));
      }, 2000);
    });
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.__abc === "offset?") {
      const iframe = [...document.querySelectorAll("iframe, frame")].find((f) => f.contentWindow === event.source);
      if (!iframe) return;
      const r = iframe.getBoundingClientRect();
      frameOffset().then((mine) => {
        event.source.postMessage(
          { __abc: "offset!", id: data.id, x: mine.x + r.left + iframe.clientLeft, y: mine.y + r.top + iframe.clientTop },
          "*",
        );
      }, () => {});
    } else if (data?.__abc === "offset!" && event.source === parent) {
      pendingOffsets.get(data.id)?.({ x: data.x, y: data.y });
      pendingOffsets.delete(data.id);
    }
  });

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
  function find({ query, limit = 20, structured = false }) {
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
    if (structured) return { total, items: matches.slice(0, limit).map((m, i) => ({ line: lines[i], score: m.score })) };
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
  /**
   * Remplit un champ avec un secret (outil credentials_fill) : même mécanisme que
   * formInput, mais la valeur ne doit jamais être recopiée dans le retour.
   */
  function fillSecret({ ref, value }) {
    const el = elementFor(ref);
    if (el.tagName === "SELECT" || el.type === "checkbox" || el.type === "radio" || el.type === "file") {
      throw new Error(`${ref} n'est pas un champ de saisie de secret (réservé aux identifiants / mots de passe).`);
    }
    el.scrollIntoView({ block: "center", behavior: "instant" });
    if (el.isContentEditable) {
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
    return `${ref} rempli.`;
  }

  function markRef(ref) {
    elementFor(ref).setAttribute("data-abc-target", ref);
    return `[data-abc-target="${ref}"]`;
  }

  // --- Retour visuel : bordure lumineuse + impulsion au point d'action ---------------

  let overlayRoot = null;
  let hideTimer = null;

  function ensureOverlay() {
    if (overlayRoot?.host.isConnected) return overlayRoot;
    // Bordures orphelines (extension rechargée, script réinjecté) : personne ne les masquerait plus.
    for (const old of document.querySelectorAll("#abc-overlay")) old.remove();
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
        .gesture { position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
                   padding: 6px 14px; border-radius: 999px; background: rgb(139, 92, 246); color: #fff;
                   font: 600 13px/1.3 system-ui, sans-serif; box-shadow: 0 4px 14px rgba(0, 0, 0, .25); }
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

  /** Masque la bordure, puis attend que la page soit redessinée : sinon une capture la verrait encore. */
  async function hideOverlay() {
    const hosts = [...document.querySelectorAll("#abc-overlay")].filter((h) => h.style.display !== "none");
    if (!hosts.length) return;
    for (const h of hosts) h.style.display = "none";
    // Dans un onglet masqué, requestAnimationFrame ne se déclenche jamais : on n'attend pas plus de 150 ms.
    await Promise.race([
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      new Promise((r) => setTimeout(r, 150)),
    ]);
  }

  /**
   * Page masquée dont une liste virtualisée n'a dessiné aucune ligne : ces listes (AngularJS Material, CDK,
   * react-window…) n'affichent leurs lignes qu'au premier rendu, que Chrome ne fait pas dans un onglet masqué.
   */
  function needsRender() {
    if (document.visibilityState !== "hidden") return false;
    const selector = [
      "md-virtual-repeat-container", "cdk-virtual-scroll-viewport", "[data-virtuoso-scroller]",
      "[class*='virtual-scroll']", "[class*='virtual-list']", "[class*='virtualized']", "[class*='react-window']",
    ].join(",");
    return [...document.querySelectorAll(selector)].some((el) => el.clientHeight > 20 && !(el.innerText || "").trim());
  }

  const isFileInput = (ref) => {
    const el = elementFor(ref);
    return el.tagName === "INPUT" && el.type === "file";
  };

  // --- Images : récupérer le fichier d'une image de la page ------------------------------------

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /** La plus grande image (ou canvas) visible à l'écran, au moins 80 px de côté. */
  /**
   * Inventaire des images visibles à l'écran (img, canvas, svg ≥ 40 px) : sert au
   * diagnostic de wait_for, à la condition image:true, à l'attente de save_image
   * et à la section "Images à l'écran" de read_page. Triées par surface décroissante.
   */
  function imageKind(el) {
    if (el.tagName === "CANVAS") return "canvas";
    if (el instanceof SVGSVGElement) return "svg";
    const src = el.currentSrc || el.src || "";
    if (src.startsWith("blob:")) return "blob";
    if (src.startsWith("data:")) return "data";
    if (/^https?:/.test(src)) return "http";
    if (!el.complete || !el.naturalWidth) return "incomplète";
    return "http";
  }

  function listImages(minSize = 40, cap = 15) {
    const out = [];
    for (const el of document.querySelectorAll("img, canvas, svg")) {
      if (el.closest("#abc-overlay")) continue;
      if (!isVisible(el) || !inViewport(el)) continue;
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (w < minSize || h < minSize) continue;
      const src = el.currentSrc || el.src || "";
      out.push({
        tag: el instanceof SVGSVGElement ? "svg" : el.tagName.toLowerCase(),
        w, h,
        srcType: imageKind(el),
        src: String(src).slice(0, 80),
        alt: (el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || "").slice(0, 80),
        ref: refFor(el),
      });
    }
    out.sort((a, b) => b.w * b.h - a.w * a.h);
    return out.slice(0, cap);
  }

  /** Plus grande image sauvegardable (≥ 80 px), ou null : attente de save_image. */
  function usableImage() {
    const found = listImages(80, 1)[0];
    return found ? { w: found.w, h: found.h, ref: found.ref } : null;
  }

  function largestImage() {
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll("img, canvas, svg")) {
      if (el.closest("#abc-overlay") || !isVisible(el) || !inViewport(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 80) continue;
      if (r.width * r.height > bestArea) {
        best = el;
        bestArea = r.width * r.height;
      }
    }
    return best;
  }

  /**
   * Contenu d'une image, par la première méthode qui marche : fetch depuis la page (blob:, data:,
   * images du site avec la session de l'utilisateur), puis canvas ; sinon l'URL, que l'extension
   * téléchargera elle-même (images publiques d'un autre domaine).
   */
  async function imageData({ ref } = {}) {
    let el = ref ? elementFor(ref) : largestImage();
    if (!el) throw new Error("Aucune image visible à l'écran : préciser une ref (read_page / find).");
    if (!["IMG", "CANVAS"].includes(el.tagName) && !(el instanceof SVGSVGElement)) {
      const inner = el.querySelector("img, canvas, svg");
      if (!inner) throw new Error(`${ref} n'est pas une image et n'en contient pas.`);
      el = inner;
    }
    const alt = el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || "";

    if (el instanceof SVGSVGElement) {
      const xml = new XMLSerializer().serializeToString(el);
      const base64 = await blobToBase64(new Blob([xml], { type: "image/svg+xml" }));
      return { kind: "data", base64, mime: "image/svg+xml", alt, w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) };
    }
    if (el.tagName === "CANVAS") {
      try {
        const blob = await new Promise((r) => el.toBlob(r, "image/png"));
        return { kind: "data", base64: await blobToBase64(blob), mime: "image/png", alt, w: el.width, h: el.height };
      } catch {
        throw new Error("Ce canvas contient des images d'un autre site : le navigateur en interdit la lecture.");
      }
    }

    if (!el.complete || !el.naturalWidth) {
      // Image en chargement différé (loading="lazy") : elle ne se charge qu'une fois à l'écran.
      el.scrollIntoView({ block: "center", behavior: "instant" });
      const loaded = await Promise.race([
        new Promise((r) => el.addEventListener("load", () => r(true), { once: true })),
        new Promise((r) => setTimeout(() => r(el.complete && el.naturalWidth > 0), 8000)),
      ]);
      if (!loaded) throw new Error("L'image ne s'est pas chargée (8 s) : vérifier qu'elle s'affiche, puis réessayer.");
    }
    const src = el.currentSrc || el.src;
    const meta = { alt, w: el.naturalWidth, h: el.naturalHeight };
    try {
      const res = await fetch(src);
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type.startsWith("image/")) return { kind: "data", base64: await blobToBase64(blob), mime: blob.type, ...meta };
      }
    } catch {}
    try {
      const canvas = document.createElement("canvas");
      canvas.width = el.naturalWidth;
      canvas.height = el.naturalHeight;
      canvas.getContext("2d").drawImage(el, 0, 0);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      return { kind: "data", base64: await blobToBase64(blob), mime: "image/png", ...meta };
    } catch {}
    if (/^https?:/i.test(src)) return { kind: "url", url: src, ...meta };
    throw new Error("Impossible de lire cette image.");
  }

  // --- Fenêtre qui recouvre la page (bannière de cookies, modale) ----------------------------

  const CONSENT_RE = /cookie|consentement|traceur|rgpd|gdpr|vie privée|privacy|données personnelles/i;

  /** elementFromPoint qui traverse les shadow DOM. */
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  /** Le plus haut conteneur fixe / modal au-dessus d'un élément (en sortant des shadow DOM). */
  function coveringAncestor(el) {
    let found = null;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement || n.getRootNode().host) {
      const st = getComputedStyle(n);
      if (st.position === "fixed" || st.position === "sticky" || n.getAttribute("aria-modal") === "true" ||
          n.getAttribute("role") === "dialog" || n.tagName === "DIALOG") found = n;
    }
    return found;
  }

  const CMP_RE = /cookie|consent|privacy|didomi|onetrust|axeptio|tarteaucitron|tc-privacy|cmp|gdpr|rgpd|sp_message|qc-cmp|usercentrics/i;

  /** Le conteneur qui porte vraiment la fenêtre (texte + boutons), quand le calque trouvé n'est qu'un fond. */
  function overlayContent() {
    const candidates = [
      ...document.querySelectorAll("[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]"),
      ...[...document.querySelectorAll("body [id], body [class]")].filter((el) => CMP_RE.test(`${el.id} ${el.className}`)),
    ];
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      if (!isVisible(el) || !inViewport(el)) continue;
      const scope = el.shadowRoot ?? el;
      const buttons = scope.querySelectorAll("button, a[href], [role=button], input[type=button], input[type=submit]").length;
      const text = (el.innerText || scope.textContent || "").trim();
      if (!buttons || text.length < 20) continue;
      // Le plus petit conteneur qui a tout : on préfère moins de texte à boutons égaux.
      const score = Math.min(buttons, 8) * 1000 - Math.min(text.length, 999);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  function blockingOverlay() {
    const W = innerWidth;
    const H = innerHeight;
    const points = [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7], [0.5, 0.93], [0.5, 0.07]];
    const roots = new Set();
    for (const [px, py] of points) {
      const el = deepElementFromPoint(W * px, H * py);
      const root = el && !el.closest?.("#abc-overlay") && coveringAncestor(el);
      if (root) roots.add(root);
    }
    let best = null;
    for (const root of roots) {
      const r = root.getBoundingClientRect();
      const visibleArea = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0));
      const cover = Math.min(1, visibleArea / (W * H));
      const scope = root.shadowRoot ?? root;
      const text = (root.innerText || scope.textContent || "").slice(0, 3000);
      const consent = CONSENT_RE.test(text) || CONSENT_RE.test(`${root.id} ${root.className}`);
      const modal = root.getAttribute("aria-modal") === "true" || root.tagName === "DIALOG" || cover >= 0.5;
      // Les en-têtes et barres de navigation fixes ne gênent pas : on ne garde que les fenêtres qui recouvrent.
      if (!consent && !modal) continue;
      const score = (consent ? 2 : 0) + cover;
      if (!best || score > best.score) best = { root, scope, cover, consent, score };
    }
    if (!best) return null;
    let { root, scope } = best;
    if ((root.innerText || scope.textContent || "").trim().length < 20) {
      const content = overlayContent();
      if (content) {
        root = content;
        scope = content.shadowRoot ?? content;
      }
    }
    const heading = scope.querySelector("h1, h2, h3, [role=heading]")?.innerText;
    const title = clean(heading || root.getAttribute("aria-label") || root.innerText || scope.textContent, 90);
    const label = (b) => clean(b.innerText || b.value || b.getAttribute("aria-label") || b.getAttribute("title") || "", 50);
    const buttons = [...scope.querySelectorAll("button, a[href], [role=button], input[type=button], input[type=submit]")]
      .filter((b) => isVisible(b) && label(b))
      .slice(0, 8)
      .map((b) => ({ name: label(b), ref: refFor(b) }));
    return {
      consent: best.consent,
      cover: Math.round(best.cover * 100),
      title,
      buttons,
      inIframe: !buttons.length && !!scope.querySelector("iframe"),
    };
  }

  // --- Gestes de l'agent : prévenir l'humain et repérer ses interférences --------------------

  let pointerLog = null;
  const recordPointer = (e) => pointerLog?.push([Math.round(e.clientX), Math.round(e.clientY)]);
  window.addEventListener("pointermove", recordPointer, true);
  window.addEventListener("pointerdown", recordPointer, true);

  /** Début d'un geste : étiquette pour l'humain, et enregistrement des positions de pointeur. */
  function gestureStart() {
    pointerLog = [];
    const { host, shadow } = ensureOverlay();
    host.style.display = "block";
    clearTimeout(hideTimer);
    if (!shadow.querySelector(".gesture")) {
      const label = document.createElement("div");
      label.className = "gesture";
      label.textContent = "Un agent agit sur cette page : ne touchez pas la souris ici";
      shadow.appendChild(label);
    }
  }

  /** Fin d'un geste : renvoie les positions reçues par la page pendant le geste. */
  function gestureEnd() {
    const log = pointerLog ?? [];
    pointerLog = null;
    overlayRoot?.shadow.querySelector(".gesture")?.remove();
    hideTimer = setTimeout(hideOverlay, 4000);
    return log;
  }

  /** Adresse d'un lien (ou d'un élément qui en contient un) : pour télécharger le fichier qu'il désigne. */
  function linkHref(ref) {
    const el = elementFor(ref);
    const link = el.closest("a[href]") ?? el.querySelector("a[href]");
    const url = link?.href ?? el.getAttribute("src") ?? el.getAttribute("data-href");
    if (!url) throw new Error(`${ref} n'est pas un lien vers un fichier.`);
    return new URL(url, location.href).href;
  }

  function clickRef(ref) {
    const el = elementFor(ref);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.click();
    return true;
  }

  globalThis.__abc = { readPage, locate, pageText, find, formInput, fillSecret, listImages, usableImage, markRef, isFileInput, overlay, hideOverlay, needsRender, imageData, blockingOverlay, gestureStart, gestureEnd, linkHref, clickRef };
})();
