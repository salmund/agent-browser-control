// Injecté dans le monde isolé de l'extension (persistant par frame).
// Construit l'arbre d'accessibilité compact et gère les refs d'éléments.
(() => {
  if (globalThis.__abc) return;

  const MAX_CHARS = 40_000;
  const TEXT_BLOCK_MAX = 1500; // un bloc de texte fusionné (la limite globale borne le reste)
  const refs = new Map(); // ref -> WeakRef<Element>
  const ids = new WeakMap(); // Element -> ref
  const prints = new Map(); // ref -> empreinte (rôle, nom, tag, contexte…), pour réparer après re-render
  const PRINTS_MAX = 3000;
  // Base aléatoire par document (multiple de 1000 entre 1000 et 90000) : une ref d'une page
  // précédente ne désigne pas un élément de la nouvelle page, dont les refs partent d'ailleurs.
  let counter = 1000 * (1 + Math.floor(Math.random() * 90));
  let lastHeal = null; // ref réparée par le dernier adoptRef (signal consommé par locate)
  const secretFields = new WeakSet(); // champs remplis par fillSecret : valeur toujours masquée
  const secretList = []; // WeakRef des mêmes champs (un WeakSet ne s'itère pas : hasLiveSecret)
  const wasPassword = new WeakSet(); // champs vus au moins une fois en type=password

  // --- Caches d'une passe : remis à zéro à chaque appel d'une fonction de page ---------------

  let pass = null;
  function newPass() {
    pass = { styles: new WeakMap(), ctxText: new WeakMap(), offCanvas: new WeakMap(), docRight: null, roots: null };
  }
  newPass();

  /** Style calculé, mémorisé pour la passe (l'objet est vivant : toujours à jour). */
  function style(el) {
    let s = pass.styles.get(el);
    if (!s) {
      s = getComputedStyle(el);
      pass.styles.set(el, s);
    }
    return s;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // --- Parcours profond : shadow DOM ouverts et fermés ---------------------------------------

  // Seuls ces éléments (et les éléments personnalisés) peuvent porter une racine d'ombre.
  const SHADOW_HOSTS = new Set([
    "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "DIV", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6",
    "HEADER", "MAIN", "NAV", "P", "SECTION", "SPAN",
  ]);
  // Le monde isolé voit aussi les racines fermées (chrome.dom.openOrClosedShadowRoot).
  const closedRootOf = (() => {
    try {
      const dom = globalThis.chrome?.dom;
      return typeof dom?.openOrClosedShadowRoot === "function" ? (el) => dom.openOrClosedShadowRoot(el) : null;
    } catch {
      return null;
    }
  })();

  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    if (!closedRootOf || el.id === "abc-overlay" || el.id === "abc-refmarks") return null;
    const tag = el.tagName;
    if (!SHADOW_HOSTS.has(tag) && !tag.includes("-")) return null;
    try {
      return closedRootOf(el) || null;
    } catch {
      return null;
    }
  }

  /** Toutes les racines d'ombre sous root (récursif). Mémorisé pour la passe quand root = document. */
  function shadowRootsUnder(root = document) {
    if (root === document && pass.roots) return pass.roots;
    const out = [];
    const scan = (r) => {
      for (const el of r.querySelectorAll("*")) {
        const sr = shadowOf(el);
        if (sr) {
          out.push(sr);
          scan(sr);
        }
      }
    };
    scan(root);
    if (root === document) pass.roots = out;
    return out;
  }

  /** querySelectorAll qui traverse les shadow DOM (arbre principal d'abord, puis chaque racine). */
  function deepQueryAll(selector, root = document) {
    const out = [...root.querySelectorAll(selector)];
    for (const sr of shadowRootsUnder(root)) out.push(...sr.querySelectorAll(selector));
    return out;
  }

  /** Tous les éléments sous root, contenu des racines d'ombre placé juste après son hôte. */
  function deepAll(root = document.body ?? document.documentElement) {
    const out = [];
    const scan = (r) => {
      for (const el of r.querySelectorAll("*")) {
        out.push(el);
        const sr = shadowOf(el);
        if (sr) scan(sr);
      }
    };
    if (root) scan(root);
    return out;
  }

  function byIdDeep(id) {
    if (!id) return null;
    const direct = document.getElementById(id);
    if (direct) return direct;
    for (const sr of shadowRootsUnder()) {
      const hit = sr.getElementById?.(id);
      if (hit) return hit;
    }
    return null;
  }

  /** Enfants à parcourir dans l'arbre aplati : contenu de la racine d'ombre, nœuds affectés aux slots. */
  function childrenOf(node) {
    if (node.nodeType === 1) {
      if (node.tagName === "SLOT") {
        const assigned = node.assignedNodes({ flatten: true });
        return assigned.length ? assigned : node.childNodes;
      }
      const sr = shadowOf(node);
      if (sr) return sr.childNodes;
    }
    return node.childNodes;
  }

  /** Parent dans l'arbre composé : sort d'une racine d'ombre par son hôte. */
  const composedParent = (n) => (n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host ?? null : n.parentNode);
  /** Parent dans l'arbre aplati : un nœud affecté à un slot remonte par ce slot. */
  const flatParent = (n) => n.assignedSlot ?? composedParent(n);
  const parentElementDeep = (n) => {
    const p = composedParent(n);
    return p && p.nodeType === 1 ? p : null;
  };

  /** anc contient-il node, en traversant shadow DOM et slots ? */
  function flatContains(anc, node) {
    for (let n = node; n; n = composedParent(n)) if (n === anc) return true;
    for (let n = node; n; n = flatParent(n)) if (n === anc) return true;
    return false;
  }

  /** closest() qui sort des racines d'ombre. */
  function closestDeep(el, selector) {
    for (let n = el; n;) {
      const hit = n.closest?.(selector);
      if (hit) return hit;
      const root = n.getRootNode?.();
      n = root && root !== n && root.host ? root.host : null;
    }
    return null;
  }

  // --- Refs, empreintes et réparation -------------------------------------------------------

  // Conteneur dont le texte court sert de contexte à l'empreinte (ligne de liste, formulaire…).
  const CONTAINER_SEL = "li, tr, article, [role=row], [role=listitem], [role=article], form, dialog, [role=dialog], [role=alertdialog]";
  const DESTRUCTIVE = /suppr|delete|archiv|envoyer|send|payer|pay|valider|confirm/i;

  function containerOf(el) {
    const p = parentElementDeep(el);
    return p ? closestDeep(p, CONTAINER_SEL) : null;
  }

  /**
   * Contexte d'un élément : texte court de son conteneur, sans le texte de l'élément lui-même
   * (un bouton qui passe de « Lecture » à « Pause » garde son contexte ; une ligne recyclée non).
   */
  function contextOf(el) {
    const c = containerOf(el);
    if (!c) return "";
    let raw = pass.ctxText.get(c);
    if (raw === undefined) {
      raw = c.textContent || "";
      pass.ctxText.set(c, raw);
    }
    const own = el.textContent || "";
    const at = own ? raw.indexOf(own) : -1;
    const rest = at >= 0 ? raw.slice(0, at) + " " + raw.slice(at + own.length) : raw;
    return `${c.tagName.toLowerCase()}:${clean(rest.slice(0, 600), 80)}`;
  }

  function fingerprint(el, role, name) {
    return {
      tag: el.tagName, role, name, id: el.id || "",
      href: el.tagName === "A" ? (el.getAttribute("href") || "") : "",
      ctx: contextOf(el),
    };
  }

  function sweepRefs() {
    if (prints.size > PRINTS_MAX) {
      let n = 500;
      for (const k of prints.keys()) {
        prints.delete(k);
        if (--n <= 0) break;
      }
    }
    if (refs.size > 20_000) for (const [k, w] of refs) if (!w.deref()) refs.delete(k);
  }

  /**
   * Ref d'un élément (créée au besoin). name : nom courant s'il est déjà calculé. Un nœud recyclé
   * (liste virtualisée : même nœud, autre contenu et autre contexte) reçoit une nouvelle ref ;
   * l'ancienne est détachée et se réparera par son empreinte.
   */
  function refFor(el, role, name) {
    let ref = ids.get(el);
    if (ref && refs.get(ref)?.deref() === el) {
      const fp = prints.get(ref);
      const r = role ?? roleOf(el) ?? "";
      const n = name ?? nameOf(el, r);
      if (!fp) {
        prints.set(ref, fingerprint(el, r, n));
        return ref;
      }
      if (fp.name === n && fp.role === r) return ref;
      const ctx = contextOf(el);
      if (fp.name && fp.name !== n && fp.ctx !== ctx) {
        refs.delete(ref);
        ids.delete(el);
      } else {
        prints.set(ref, { ...fp, role: r, name: n, ctx });
        return ref;
      }
    }
    ref = `ref_${++counter}`;
    ids.set(el, ref);
    refs.set(ref, new WeakRef(el));
    const r = role ?? roleOf(el) ?? "";
    prints.set(ref, fingerprint(el, r, name ?? nameOf(el, r)));
    sweepRefs();
    return ref;
  }

  /** Ref périmée par prudence : nom destructif dont le contexte a changé (ligne recyclée). */
  function isStale(ref, el) {
    const fp = prints.get(ref);
    if (!fp || !fp.name || !DESTRUCTIVE.test(fp.name)) return false;
    return contextOf(el) !== fp.ctx;
  }

  function elementFor(ref) {
    const el = refs.get(ref)?.deref();
    if (el && el.isConnected) {
      if (!isStale(ref, el)) return el;
      refs.delete(ref);
      ids.delete(el);
      const healed = healRef(ref);
      if (healed) return healed;
      throw new Error(
        `Élément ${ref} : le contenu autour de « ${prints.get(ref)?.name} » a changé depuis la lecture (liste recyclée ?) ; ` +
        "action refusée par prudence, relancer read_page ou find.",
      );
    }
    const healed = healRef(ref);
    if (healed) return healed;
    throw new Error(`Élément ${ref} introuvable : relancer read_page.`);
  }

  /**
   * Répare une ref périmée (re-render React/Vue : le nœud a été remplacé) en retrouvant
   * l'élément par son empreinte. Strict : id stable vérifié (et contexte identique si le nom est
   * destructif), ou quadruplet (tag, rôle, nom exact, contexte du conteneur) unique et visible.
   * null si zéro ou plusieurs candidats (on ne devine pas).
   */
  function healRef(ref) {
    const fp = prints.get(ref);
    if (!fp) return null;
    if (fp.id) {
      const byId = byIdDeep(fp.id);
      if (byId && !byId.closest("#abc-overlay") && (roleOf(byId) ?? "") === fp.role && nameOf(byId, fp.role) === fp.name &&
          (!DESTRUCTIVE.test(fp.name) || contextOf(byId) === fp.ctx)) {
        return adoptRef(ref, byId);
      }
    }
    if (!fp.name) return null;
    let found = null;
    let count = 0;
    let list;
    try {
      list = deepQueryAll(CSS.escape(fp.tag.toLowerCase()));
    } catch {
      return null;
    }
    for (let i = 0; i < list.length && count < 2; i++) {
      const c = list[i];
      if (c.closest("#abc-overlay")) continue;
      if ((roleOf(c) ?? "") !== fp.role) continue;
      if (fp.href && c.getAttribute("href") !== fp.href) continue;
      // Pré-filtre bon marché (textContent, sans layout) avant la vérification exacte.
      if (clean(c.textContent, 100) !== fp.name && nameOf(c, fp.role) !== fp.name) continue;
      if (contextOf(c) !== fp.ctx) continue;
      if (!isVisible(c) || hiddenByAncestor(c)) continue;
      if (nameOf(c, fp.role) !== fp.name) continue;
      found = c;
      count++;
    }
    return count === 1 ? adoptRef(ref, found) : null;
  }

  function adoptRef(ref, el) {
    refs.set(ref, new WeakRef(el));
    ids.set(el, ref);
    lastHeal = ref;
    return el;
  }

  /** Oublie la ref d'un élément (elle se réparera par empreinte si on s'en sert encore). */
  function forgetRef(el) {
    const ref = ids.get(el);
    if (ref && refs.get(ref)?.deref() === el) refs.delete(ref);
    ids.delete(el);
  }

  // --- Rôles, noms, visibilité ---------------------------------------------------------------

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
    article: "article", iframe: "iframe", video: "video", audio: "audio", fieldset: "group",
    progress: "progressbar", meter: "meter",
  };

  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "textbox", "searchbox", "combobox", "slider",
    "spinbutton", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
    "treeitem", "listbox",
  ]);

  // Rôles dont le nom résume le contenu : on ne descend que pour les interactifs imbriqués.
  const LEAF_ROLES = new Set([
    "button", "link", "heading", "img", "textbox", "searchbox", "checkbox", "radio",
    "slider", "spinbutton", "switch", "option", "tab", "menuitem", "combobox", "iframe",
  ]);
  // Éléments sans descendants utiles (options d'un select : résumées par describe).
  const NO_NESTED = new Set(["SELECT", "INPUT", "TEXTAREA", "IMG", "IFRAME", "VIDEO", "AUDIO", "OPTION"]);
  // Conteneurs neutres : aplatis quand ils n'ont pas de nom.
  const FLAT_ROLES = new Set(["none", "presentation", "generic", "group"]);
  // Rôles nommés par leur contenu.
  const NAME_FROM_CONTENT = new Set([
    "button", "link", "heading", "option", "tab", "treeitem", "menuitem", "menuitemcheckbox", "menuitemradio",
    "cell", "gridcell", "columnheader", "rowheader", "listitem", "summary", "switch", "checkbox", "radio", "tooltip",
  ]);

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD", "META", "LINK"]);

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit && explicit.trim()) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "input") {
      if (el.type === "hidden") return null;
      return INPUT_ROLES[el.type] ?? "textbox";
    }
    if (tag === "section" && (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"))) return "region";
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return "textbox";
    return TAG_ROLES[tag] ?? null;
  }

  function clean(text, max = 100) {
    const t = (text ?? "").replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max) + "…" : t;
  }

  function labelledByText(el, attr = "aria-labelledby") {
    const ids = el.getAttribute(attr);
    if (!ids) return "";
    const root = el.getRootNode?.();
    return ids.split(/\s+/).map((id) => (root?.getElementById?.(id) ?? document.getElementById(id))?.textContent ?? "").join(" ");
  }

  function nameOf(el, role) {
    const label = el.getAttribute("aria-label");
    if (label && label.trim()) return clean(label);
    const byRef = clean(labelledByText(el));
    if (byRef) return byRef;
    if (el.tagName === "INPUT") {
      // Boutons de formulaire : leur nom est leur valeur (ou le libellé par défaut du navigateur).
      const t = el.type;
      if (t === "submit" || t === "button" || t === "reset") {
        return clean(el.value || (t === "submit" ? "Envoyer" : t === "reset" ? "Réinitialiser" : ""));
      }
      if (t === "image") return clean(el.getAttribute("alt") || el.value || "Envoyer");
    }
    if (el.labels?.length) {
      const t = clean([...el.labels].map((l) => l.innerText).join(" "));
      if (t) return t;
    }
    if (role === "img") return clean(el.getAttribute("alt") ?? el.getAttribute("title") ?? "");
    if (el.tagName === "TABLE" && el.caption) {
      const t = clean(el.caption.innerText);
      if (t) return t;
    }
    if (el.tagName === "FIELDSET") {
      const legend = el.querySelector(":scope > legend");
      if (legend) return clean(legend.innerText);
    }
    if (NAME_FROM_CONTENT.has(role)) {
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

  /** Un input transparent (case personnalisée) reste opérable si son libellé est visible. */
  function labelVisibleFor(el) {
    if (el.tagName !== "INPUT" || !el.labels?.length) return false;
    return [...el.labels].some((l) => l.getClientRects().length && (!l.checkVisibility || l.checkVisibility({ opacityProperty: true })));
  }

  /** Limite droite du document (au-delà, rien ne peut être amené à l'écran). */
  function docRight() {
    if (pass.docRight != null) return pass.docRight;
    const de = document.documentElement;
    const clip = [de, document.body].some((n) => n && /hidden|clip/.test(style(n).overflowX));
    pass.docRight = clip ? innerWidth + scrollX : Math.max(de.scrollWidth, innerWidth);
    return pass.docRight;
  }

  /** Conteneur positionné entièrement hors du document à gauche ou à droite (menu hors canevas). */
  function isOffCanvas(el, s = style(el)) {
    if (s.position !== "fixed" && s.position !== "absolute") return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false; // texte pour lecteurs d'écran : 1 px, on le garde
    if (s.position === "fixed") return r.right <= 0 || r.left >= innerWidth;
    return r.right + scrollX <= 0 || r.left + scrollX >= docRight();
  }

  /** Un ancêtre est-il hors canevas ? (mémorisé pour la passe : find, réparation) */
  function hiddenByAncestor(el) {
    const memo = pass.offCanvas;
    const chain = [];
    let res = false;
    for (let n = parentElementDeep(el); n && n !== document.body && n !== document.documentElement; n = parentElementDeep(n)) {
      const known = memo.get(n);
      if (known !== undefined) {
        res = known;
        break;
      }
      chain.push(n);
      if (isOffCanvas(n)) {
        res = true;
        break;
      }
    }
    for (const n of chain) memo.set(n, res);
    return res;
  }

  function isVisible(el, { offCanvas = true } = {}) {
    if (el.getAttribute("aria-hidden") === "true") return false;
    const s = style(el);
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
    // display:contents n'a pas de boîte : checkVisibility() renverrait false alors que les enfants sont visibles.
    if (s.display === "contents") return true;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: false })) return false;
    // Calque transparent et inerte (menu fermé en fondu, info-bulle éteinte) : ni visible ni cliquable.
    if (s.pointerEvents === "none" && el.checkVisibility && !el.checkVisibility({ opacityProperty: true }) && !labelVisibleFor(el)) return false;
    if (offCanvas && isOffCanvas(el, s)) return false;
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
    if (style(el).cursor !== "pointer") return false;
    const parent = parentElementDeep(el);
    return !parent || style(parent).cursor !== "pointer";
  }

  // --- Champs sensibles ---------------------------------------------------------------------

  const SECRET_AUTOCOMPLETE = /current-password|new-password|one-time-code|\bcc-/i;

  /** Valeur à ne jamais renvoyer : mot de passe (même passé en text), code, carte, secret rempli. */
  function isSensitiveField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (secretFields.has(el) || wasPassword.has(el)) return true;
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return false;
    if (el.type === "password") {
      wasPassword.add(el);
      return true;
    }
    return SECRET_AUTOCOMPLETE.test(el.getAttribute("autocomplete") || "");
  }

  // --- Description d'une ligne ---------------------------------------------------------------

  const TRACKING_PARAM = /^(utm_\w+|xtor|xts|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|yclid|twclid|ttclid|_hsenc|_hsmi|_gl|mkt_tok|vero_id|spm|ref_src|at_(medium|campaign|platform|creation|variant|format|send_date|link|type|detail_placement|emailtype|recipient_id|recipient_list|ptr_name)|pk_\w+|mtm_\w+)$/i;

  /** href compact : chemin relatif si même origine, paramètres de suivi retirés. */
  function compactHref(raw) {
    if (!raw || /^\s*javascript:/i.test(raw)) return null;
    if (raw.startsWith("#")) return clean(raw, 150);
    let u;
    try {
      u = new URL(raw, location.href);
    } catch {
      return clean(raw, 150);
    }
    if (!/^https?:$/.test(u.protocol)) return clean(raw, 150);
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    return clean(u.origin === location.origin ? u.pathname + u.search + u.hash : u.href, 150);
  }

  const TYPE_SHOWN = new Set(["email", "tel", "url", "date", "time", "datetime-local", "month", "week", "password", "color", "file"]);
  const q = (s) => JSON.stringify(s);

  function sliderValue(el) {
    if (el.tagName === "INPUT" && el.type === "range") return `${el.value}/${el.max || 100}`;
    if (el.tagName === "PROGRESS") return el.hasAttribute("value") ? `${el.value}/${el.max}` : null;
    if (el.tagName === "METER") return `${el.value}/${el.max}`;
    const text = el.getAttribute("aria-valuetext");
    if (text) return clean(text, 60);
    const now = el.getAttribute("aria-valuenow");
    if (now === null) return null;
    const max = el.getAttribute("aria-valuemax");
    return max !== null ? `${now}/${max}` : now;
  }

  function invalidNote(el) {
    const aria = el.getAttribute("aria-invalid");
    let invalid = aria === "true" || aria === "grammar" || aria === "spelling";
    let msg = "";
    if (!invalid && el.willValidate && el.validity && !el.validity.valid) {
      let touched = false;
      try {
        touched = el.matches(":user-invalid");
      } catch {}
      invalid = touched || (el.value ?? "") !== "";
    }
    if (!invalid) return null;
    msg = el.validationMessage || clean(labelledByText(el, "aria-errormessage") || labelledByText(el, "aria-describedby"), 120);
    return msg ? `invalid=${q(clean(msg, 120))}` : "invalid";
  }

  /**
   * Ligne compacte d'un élément : rôle, nom, ref, puis ce qui sert à agir (valeur, type, états).
   * nameOverride : nom déjà calculé (élément cliquable générique nommé par son texte).
   */
  function describe(el, role, nameOverride) {
    const parts = [role];
    const name = nameOverride ?? nameOf(el, role);
    if (name) parts.push(q(name));
    parts.push(`[${refFor(el, role === "labeled" || role === "generic" || role === "text" ? roleOf(el) ?? "" : role, nameOverride === undefined ? name : undefined)}]`);
    const tag = el.tagName;
    if (role === "heading") parts.push(`level=${tag.match(/^H(\d)$/)?.[1] ?? el.getAttribute("aria-level") ?? "?"}`);
    if (role === "link") {
      const href = compactHref(el.getAttribute("href"));
      if (href) parts.push(`href=${q(href)}`);
    }
    if (tag === "INPUT" && TYPE_SHOWN.has(el.type)) parts.push(`type=${el.type}`);
    // Valeur courante.
    if (tag === "SELECT") {
      const chosen = [...el.selectedOptions].map((o) => clean(o.text, 60)).filter(Boolean);
      if (chosen.length) parts.push(`value=${q(chosen.join(", "))}`);
      const opts = [...el.options];
      const shown = opts.slice(0, opts.length <= 8 ? 8 : 5).map((o) => q(clean(o.text, 40))).join(" | ");
      parts.push(`options(${opts.length})=${shown}${opts.length > 8 ? " | …" : ""}`);
    } else if (role === "slider" || role === "progressbar" || role === "meter" || role === "scrollbar") {
      const v = sliderValue(el);
      if (v) parts.push(`value=${v}`);
    } else if (["textbox", "searchbox", "combobox", "spinbutton"].includes(role)) {
      let v = "";
      if ("value" in el && (tag === "INPUT" || tag === "TEXTAREA")) v = el.value;
      else if (el.isContentEditable) v = el.innerText;
      else if (role === "combobox") v = "";
      if (v) parts.push(`value=${q(isSensitiveField(el) ? "••••" : clean(v, 200))}`);
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder && clean(placeholder) !== name) parts.push(`placeholder=${q(clean(placeholder, 80))}`);
    // États.
    const ariaChecked = el.getAttribute("aria-checked");
    if (el.indeterminate || ariaChecked === "mixed") parts.push("mixed");
    else if (el.checked || ariaChecked === "true") parts.push("checked");
    else if (role === "checkbox" || role === "switch" || role === "menuitemcheckbox") parts.push("off");
    const pressed = el.getAttribute("aria-pressed");
    if (pressed === "true") parts.push("pressed");
    else if (pressed === "mixed") parts.push("pressed=mixed");
    else if (pressed === "false") parts.push("pressed=false");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    if (el.required || el.getAttribute("aria-required") === "true") parts.push("required");
    if (((tag === "INPUT" || tag === "TEXTAREA") && el.readOnly) || el.getAttribute("aria-readonly") === "true") parts.push("readonly");
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.hasAttribute("aria-invalid")) {
      const inv = invalidNote(el);
      if (inv) parts.push(inv);
    }
    if (el.getAttribute("aria-expanded")) parts.push(`expanded=${el.getAttribute("aria-expanded")}`);
    const popup = el.getAttribute("aria-haspopup");
    if (popup && popup !== "false") parts.push(`haspopup=${popup === "true" ? "menu" : popup}`);
    if (el.getAttribute("aria-selected") === "true") parts.push("selected");
    const current = el.getAttribute("aria-current");
    if (current && current !== "false") parts.push(current === "true" ? "current" : `current=${current}`);
    if (unreachableReason(el)) parts.push("(hors écran)");
    return parts.join(" ");
  }

  const lastReads = new Map(); // options de lecture -> { lines, depths }, pour diff=true

  function inViewport(el) {
    if (style(el).display === "contents") return true;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  /** Hors écran mais susceptible de contenir du visible : boîte vide (portail) ou débordement visible. */
  function mayOverflow(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return true;
    const s = style(el);
    return s.overflowX === "visible" && s.overflowY === "visible";
  }

  /**
   * Élément que même un scroll ne peut pas amener à l'écran : position fixe (le scroll ne déplace
   * pas les fixes) avec le rectangle hors du viewport. Typique des boutons « charger plus » dont
   * l'animation de sortie les gare à left:-9999px : cliquer dessus part dans le vide.
   * Renvoie null, ou la raison lisible.
   */
  function unreachableReason(el) {
    if (!(el instanceof Element)) return null;
    const s = style(el);
    if (s.display === "contents") return null;
    if (s.position !== "fixed") return null;
    const r = el.getBoundingClientRect();
    const outside = r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight;
    if (!outside) return null;
    return `fixe hors écran (left: ${s.left}, top: ${s.top}, rect ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}, viewport ${innerWidth}×${innerHeight})`;
  }

  /** Diagnostic compact d'un élément pour expliquer un clic impossible. */
  function clickDiagnostics(el) {
    const s = style(el);
    const r = el.getBoundingClientRect();
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    return `${el.tagName.toLowerCase()}${id}${cls} (position: ${s.position}, display: ${s.display}, ` +
      `visibility: ${s.visibility}, opacity: ${s.opacity}, ` +
      `rect ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}, viewport ${innerWidth}×${innerHeight})`;
  }

  // --- Tableaux ------------------------------------------------------------------------------

  /**
   * Grille d'un <table> : colspan répété, rowspan descendu, tableaux imbriqués ignorés.
   * cellText : rendu d'une cellule (texte par défaut) ; keepRow : filtre de lignes (viewport).
   */
  function tableGrid(table, maxRows, cellText = (cell) => clean(cell.innerText ?? cell.textContent ?? "", 500), keepRow = null) {
    const grid = [];
    const pending = []; // pending[col] = { left, value } (rowspan en cours)
    for (const tr of table.rows) {
      if (grid.length >= maxRows) break;
      if (tr.closest("table") !== table || !isVisible(tr)) continue;
      if (keepRow && !keepRow(tr)) continue;
      const row = [];
      let col = 0;
      const takePending = () => {
        while (pending[col]) {
          row[col] = pending[col].value;
          if (--pending[col].left <= 0) delete pending[col];
          col++;
        }
      };
      takePending();
      for (const cell of tr.cells) {
        takePending();
        const text = cellText(cell);
        if (text === null) return null;
        const cs = Math.max(1, Math.min(Number(cell.colSpan) || 1, 20));
        const rs = Math.max(1, Math.min(Number(cell.rowSpan) || 1, 50));
        for (let k = 0; k < cs; k++) {
          row[col] = text;
          if (rs > 1) pending[col] = { left: rs - 1, value: text };
          col++;
        }
      }
      takePending();
      grid.push(row);
    }
    return grid;
  }

  const GRID_SEL = "table, [role=grid], [role=table], [role=treegrid]";
  const CELL_SEL = "[role=cell], [role=gridcell], [role=columnheader], [role=rowheader]";

  /** Grille ARIA (role=grid|table|treegrid, row, cell…) ; aria-rowindex / aria-colindex respectés. */
  function ariaGrid(grid, maxRows) {
    let rows = deepQueryAll("[role=row]", grid).filter((r) => closestDeep(parentElementDeep(r), GRID_SEL) === grid && isVisible(r));
    const idx = (r) => Number(r.getAttribute("aria-rowindex"));
    if (rows.length && rows.every((r) => idx(r) > 0)) rows = rows.sort((a, b) => idx(a) - idx(b));
    const out = [];
    for (const r of rows.slice(0, maxRows)) {
      const row = [];
      let col = 0;
      const cells = deepQueryAll(CELL_SEL, r).filter((c) => closestDeep(parentElementDeep(c), "[role=row]") === r);
      for (const c of cells) {
        const ci = Number(c.getAttribute("aria-colindex"));
        if (ci > 0) col = ci - 1;
        const text = clean(c.innerText ?? c.textContent ?? "", 500);
        const span = Math.max(1, Math.min(Number(c.getAttribute("aria-colspan")) || 1, 20));
        for (let k = 0; k < span; k++) row[col++] = text;
      }
      for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = "";
      out.push(row);
    }
    const first = rows.length && idx(rows[0]) > 0 ? idx(rows[0]) : null;
    const last = rows.length && idx(rows[rows.length - 1]) > 0 ? idx(rows[rows.length - 1]) : null;
    const total = Number(grid.getAttribute("aria-rowcount")) || null;
    return { grid: out, first, last, total };
  }

  function gridToMarkdown(grid, header = true) {
    if (!grid.length) return "(tableau vide)";
    const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
    const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    const lines = grid.map((r) => `| ${Array.from({ length: width }, (_, i) => esc(r[i] ?? "")).join(" | ")} |`);
    if (header) lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
    return lines.join("\n");
  }

  function gridToCsv(grid) {
    const esc = (s) => {
      const t = String(s ?? "");
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    return grid.map((r) => r.map(esc).join(",")).join("\n");
  }

  // --- read_page ------------------------------------------------------------------------------

  /** Chemin lisible d'une ligne (ancêtres nommés), pour le diff. */
  function linePath(lines, depths, i) {
    const out = [];
    let depth = depths[i];
    for (let j = i - 1; j >= 0 && depth > 0 && out.length < 6; j--) {
      if (depths[j] >= depth) continue;
      depth = depths[j];
      const m = /^- (\S+)(?: ("(?:[^"\\]|\\.)*"))?/.exec(lines[j].trim());
      if (m && m[2]) {
        const name = JSON.parse(m[2]);
        out.unshift(`${m[1]} ${q(name.length > 40 ? name.slice(0, 40) + "…" : name)}`);
      }
    }
    return out.slice(-3);
  }

  /**
   * viewport : seulement ce qui est à l'écran. diff : seulement ce qui a changé depuis la lecture
   * précédente avec les mêmes options. frame : lecture d'une iframe (null si minuscule ou vide).
   */
  function readPage({ filter = "all", ref, viewport = false, diff = false, frame = false, labels = false, include = null } = {}) {
    if (frame && (innerWidth < 30 || innerHeight < 30)) return null; // pixels de suivi, iframes cachées
    const interactiveOnly = filter === "interactive";
    let includeSet = null;
    if (include) {
      try {
        includeSet = new Set(deepQueryAll(include));
      } catch {
        throw new Error(`Sélecteur include invalide : ${JSON.stringify(include)}.`);
      }
    }
    const lines = [];
    const depths = [];
    let size = 0;
    let truncated = false;

    let lastText = null; // { depth, text } si la dernière ligne émise est du texte
    let textChars = 0; // caractères de texte visibles rencontrés (distingue « vide » de « masqué »)

    function emit(depth, text, raw = false) {
      lastText = null;
      if (truncated) return;
      const line = "  ".repeat(depth) + (raw ? "" : "- ") + text;
      size += line.length + 1;
      if (size > MAX_CHARS) {
        truncated = true;
        return;
      }
      lines.push(line);
      depths.push(depth);
    }

    function emitText(depth, t) {
      if (truncated) return;
      // Fusionne les fragments de texte consécutifs (ex. <p>un <strong>mot</strong> clé</p>).
      if (lastText?.depth === depth) {
        lastText.text = clean(`${lastText.text} ${t}`, TEXT_BLOCK_MAX);
        const line = "  ".repeat(depth) + "- text " + q(lastText.text);
        size += line.length - lines[lines.length - 1].length;
        lines[lines.length - 1] = line;
        if (size > MAX_CHARS) truncated = true;
        return;
      }
      emit(depth, `text ${q(t)}`);
      if (!truncated) lastText = { depth, text: t };
    }

    /** nested : sous un rôle feuille, seuls les interactifs imbriqués sont émis. */
    function walk(node, depth, nested = false) {
      for (const child of childrenOf(node)) {
        if (truncated) return;
        if (child.nodeType === Node.TEXT_NODE) {
          if (nested) continue;
          const text = clean(child.textContent, TEXT_BLOCK_MAX);
          if (text) {
            textChars += text.length;
            if (!interactiveOnly) emitText(depth, text);
          }
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.tagName.toUpperCase();
        // Le <svg> lui-même est ignoré (formes graphiques), mais ses îlots HTML
        // (<foreignObject>, ex. rail de serveurs Discord) sont parcourus.
        if (tag === "SVG") {
          walkForeign(child, depth, nested);
          continue;
        }
        if (SKIP_TAGS.has(tag) || child.id === "abc-overlay" || child.id === "abc-refmarks") continue;
        if (!isVisible(child)) continue;
        let inView = true;
        if (viewport && !inViewport(child)) {
          // Hors écran : on ne l'émet pas, mais un portail (boîte vide) ou un contenu qui déborde
          // peut porter des descendants à l'écran (modales rendues en fin de body).
          if (!mayOverflow(child)) continue;
          inView = false;
        }
        visit(child, depth, nested, inView);
      }
    }

    // Îlots HTML dans un <svg> : seul <foreignObject> est parcouru (récursif sur svg imbriqués).
    function walkForeign(node, depth, nested) {
      for (const child of node.childNodes) {
        if (truncated) return;
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.tagName.toUpperCase();
        if (tag === "FOREIGNOBJECT") visit(child, depth, nested);
        else if (tag === "SVG") walkForeign(child, depth, nested);
      }
    }

    /** Rendu compact d'une cellule : texte, et lignes complètes des interactifs (avec ref). */
    function cellText(cell) {
      const out = [];
      let len = 0;
      const rec = (node) => {
        for (const ch of childrenOf(node)) {
          if (ch.nodeType === Node.TEXT_NODE) {
            const t = clean(ch.textContent, 300);
            if (t) {
              out.push(t);
              len += t.length;
            }
            continue;
          }
          if (ch.nodeType !== Node.ELEMENT_NODE) continue;
          const tag = ch.tagName.toUpperCase();
          if (SKIP_TAGS.has(tag) || !isVisible(ch)) continue;
          const role = roleOf(ch);
          if (ch.tagName === "TABLE") return false;
          if (isInteractive(ch, role)) {
            const line = describe(ch, role ?? "generic", role ? undefined : clean(ch.innerText, 100) || undefined);
            out.push(line);
            len += line.length;
            continue;
          }
          if (rec(ch) === false) return false;
        }
        return true;
      };
      if (rec(cell) === false || len > 400) return null;
      return out.join(" ");
    }

    /** <table> simple rendu en grille Markdown compacte ; false si trop complexe (parcours normal). */
    function renderTable(table, depth) {
      if (table.tagName !== "TABLE" || table.querySelector("table")) return false;
      const rowCount = table.rows.length;
      if (!rowCount || rowCount > 80) return false;
      const keep = viewport ? (tr) => inViewport(tr) : null;
      const grid = tableGrid(table, 80, cellText, keep);
      if (!grid || !grid.length) return false;
      const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
      if (width > 12 || (width < 2 && grid.length < 2)) return false;
      emit(depth, describe(table, "table"));
      const first = [...table.rows].find((tr) => tr.closest("table") === table && isVisible(tr));
      const header = !!first && (first.parentElement?.tagName === "THEAD" || [...first.cells].every((c) => c.tagName === "TH"));
      for (const line of gridToMarkdown(grid, header).split("\n")) {
        if (truncated) break;
        emit(depth + 1, line, true);
      }
      return true;
    }

    function visit(el, depth, nested = false, inView = true) {
      if (truncated) return;
      if (!inView) {
        walk(el, depth, nested);
        return;
      }
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      if (nested) {
        if (interactive) {
          emit(depth, describe(el, role ?? "generic", role ? undefined : clean(el.innerText, 100) || undefined));
          if (!NO_NESTED.has(el.tagName)) walk(el, depth + 1, true);
        } else if (!NO_NESTED.has(el.tagName)) {
          walk(el, depth, true);
        }
        return;
      }
      if (role === "table" && !interactiveOnly && renderTable(el, depth)) return;
      // Les images décoratives (sans nom) sont du bruit.
      const decorative = role === "img" && !interactive && !nameOf(el, role);
      // labels:true : les éléments informatifs non interactifs porteurs d'un aria-label
      // (messages de chat, tuiles riches) sont montrés avec leur nom ; include force une liste.
      const labeled = !!labels && !interactive && !!el.getAttribute("aria-label")?.trim();
      const included = !!includeSet?.has(el);
      let shown = interactiveOnly
        ? interactive || labeled || included
        : (role !== null && !decorative) || interactive || labeled || included;
      // Conteneurs neutres sans nom (div role=presentation, group anonyme) : aplatis.
      if (shown && !interactive && !labeled && !included && FLAT_ROLES.has(role) && !nameOf(el, role)) shown = false;
      if (!shown) {
        walk(el, depth);
        return;
      }
      const shownRole = role ?? (labeled || included ? "labeled" : "generic");
      // Cliquable générique sans nom : nommé par son texte. Court, il le résume entièrement
      // (feuille) ; long, on le tronque en mode interactif et on garde le parcours sinon.
      let override;
      let leaf = LEAF_ROLES.has(role);
      if (interactive && (role === null || role === "generic") && !nameOf(el, role)) {
        const text = clean(el.innerText, 1000);
        if (text && text.length <= 100) {
          override = text;
          leaf = true;
        } else if (text && interactiveOnly) {
          override = clean(text, 100);
        }
      }
      emit(depth, describe(el, shownRole, override));
      if (truncated) return;
      if (leaf) {
        if (!NO_NESTED.has(el.tagName)) walk(el, depth + 1, true);
      } else {
        walk(el, depth + 1);
      }
    }

    const root = ref ? elementFor(ref) : document.body;
    if (ref) visit(root, 0);
    else if (root) walk(root, 0);

    if (frame && !lines.length) return null;
    const scope = viewport ? " (partie visible seulement)" : "";
    const header = `Page : ${document.title}\nURL : ${location.href}\nViewport : ${innerWidth}x${innerHeight}${scope}`;
    const footer = truncated
      ? "\n[Tronqué : utiliser filter='interactive', viewport=true ou ref pour cibler un sous-arbre.]"
      : "";

    const key = JSON.stringify([filter, ref ?? null, viewport, !!labels, include ?? null]);
    const previous = lastReads.get(key);
    lastReads.set(key, { lines, depths });
    if (diff && previous) {
      // Les refs sont stables d'une lecture à l'autre : une ligne identique = élément inchangé.
      const before = new Set(previous.lines);
      const after = new Set(lines);
      const bare = (l) => l.trim().replace(/^- /, "");
      const refIn = (l) => /\[(ref_\d+)\]/.exec(l)?.[1];
      const prevByRef = new Map();
      previous.lines.forEach((l) => {
        const r = refIn(l);
        if (r) prevByRef.set(r, l);
      });
      const changed = [];
      const changedRefs = new Set();
      for (const l of lines) {
        const r = refIn(l);
        const old = r ? prevByRef.get(r) : undefined;
        if (old === undefined || old === l || before.has(l)) continue;
        changedRefs.add(r);
        const [headNew, tailNew = ""] = bare(l).split(`[${r}]`);
        const [headOld, tailOld = ""] = bare(old).split(`[${r}]`);
        const was = headNew === headOld ? tailOld.trim() || "(aucun état)" : bare(old);
        changed.push(`~ ${bare(l)}${tailNew.trim() === tailOld.trim() && headNew === headOld ? "" : ` (avant : ${was})`}`);
      }
      const withPath = (all, depthsOf, i, sign) => {
        const path = linePath(all, depthsOf, i);
        return `${sign} ${path.length ? path.join(" › ") + " › " : ""}${bare(all[i])}`;
      };
      const removed = [];
      previous.lines.forEach((l, i) => {
        if (after.has(l) || changedRefs.has(refIn(l))) return;
        removed.push(withPath(previous.lines, previous.depths, i, "-"));
      });
      const added = [];
      lines.forEach((l, i) => {
        if (before.has(l) || changedRefs.has(refIn(l))) return;
        added.push(withPath(lines, depths, i, "+"));
      });
      if (!removed.length && !added.length && !changed.length) {
        return frame ? null : `${header}\n\nAucun changement depuis la dernière lecture.`;
      }
      return `${header}\n\nChangements depuis la dernière lecture (${added.length} ajout(s), ${removed.length} retrait(s), ${changed.length} modification(s)) :\n` +
        [...removed, ...changed, ...added].join("\n") + footer;
    }
    const note = diff ? "\n[Première lecture : les suivantes avec diff=true ne montreront que les changements.]" : "";
    let imagesBlock = "";
    if (!frame) {
      // Images générées ou intégrées, avec ref directe pour save_image : le cas qui
      // manque quand l'arbre n'en montre aucune (canvas, svg, <img> sans nom).
      const imgs = listImages(80, 10).map((img) => {
        const label = img.alt ? ` ${q(img.alt)}` : "";
        return `- image (${img.w}×${img.h}, ${img.srcType})${label} [${img.ref}]`;
      });
      if (imgs.length) imagesBlock = `\n\nImages à l'écran (${imgs.length}) :\n${imgs.join("\n")}`;
    }
    // Constat, sans interprétation : rien n'a été rendu alors que le DOM est riche.
    // Cas typique : page à squelette (conteneurs posés, contenu pas encore injecté).
    let emptyNotice = "";
    if (!frame && !ref && !lines.length && !imagesBlock && textChars < 20) {
      const nodeCount = document.body ? document.body.querySelectorAll("*").length : 0;
      if (nodeCount >= 150) {
        emptyNotice =
          `\n\nRien à lire : aucun élément et presque pas de texte visibles, alors que la page compte ${nodeCount} nœuds. ` +
          `Le contenu est masqué, pas encore rendu (squelette), ou dessiné hors DOM (canvas/WebGL). ` +
          `Attendre (wait_for) ou vérifier la console.`;
      }
    }
    // En lecture interactive complète, cadrer ce que l'agent voit (et ce qui est masqué).
    // Hors de `lines` pour ne pas polluer les diffs ; absent en mode diff (déjà résumé par +/-).
    // Retiré quand l'arbre est vide à tort (emptyNotice) : « texte statique masqué » serait faux.
    const hint = interactiveOnly && window.top === window && !(diff && previous) && !emptyNotice
      ? `\nÉléments interactifs : ${lines.length}${truncated ? "+" : ""} (texte statique masqué, relire avec filter="all" pour tout voir)`
      : "";
    return `${header}${hint}\n\n${lines.join("\n") || "(aucun élément)"}${emptyNotice}${imagesBlock}${footer}${note}`;
  }

  /**
   * Fait défiler jusqu'à l'élément et renvoie son centre en coordonnées du viewport de la page
   * principale (dans une iframe, on ajoute la position de chaque iframe parente), avec sa taille.
   */
  async function locate(ref) {
    lastHeal = null;
    const el = elementFor(ref);
    const healed = lastHeal === ref; // la ref a été réparée après un re-render
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) throw new Error(`Élément ${ref} sans dimensions (invisible ?). ${clickDiagnostics(el)}`);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // scrollIntoView ne déplace pas les éléments fixes : si le centre reste hors du viewport
    // après le scroll, cliquer partirait dans le vide. Refuser avec un diagnostic net.
    if (cx < -2 || cy < -2 || cx > innerWidth + 2 || cy > innerHeight + 2) {
      const why = unreachableReason(el);
      throw new Error(
        `Élément ${ref} hors écran après scroll, clic impossible` +
        (why ? ` (${why})` : ` (${clickDiagnostics(el)})`) +
        " : la cible est masquée par la page (animation de sortie, onglet caché). Chercher un autre moyen (bouton visible, scroll de la liste).",
      );
    }
    const offset = await frameOffset();
    return {
      x: Math.round(offset.x + cx), y: Math.round(offset.y + cy),
      w: Math.round(r.width), h: Math.round(r.height),
      ...(healed ? { healed: true } : {}),
    };
  }

  /**
   * Vérifie qu'un clic au point (x, y) atteindrait bien l'élément `ref` : l'élément sous le point
   * doit être la cible, un de ses descendants ou un de ses ancêtres (clic qui remonte), en
   * traversant shadow DOM et slots. L'overlay ABC (pointer-events:none) est invisible pour
   * elementFromPoint : le test reste fiable même après le surlignage. Coordonnées du viewport de
   * CETTE frame (refs principales uniquement).
   */
  function hitTest({ x, y, ref }) {
    const el = elementFor(ref);
    const hit = deepElementFromPoint(Math.round(x), Math.round(y));
    if (hit && (hit === el || flatContains(el, hit) || flatContains(hit, el))) return { ok: true };
    const cover = hit
      ? `${clickDiagnostics(hit)}${(() => { try { const known = ids.get(hit); return known ? ` [${known}]` : ""; } catch { return ""; } })()} « ${(hit.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80)} »`
      : "aucun (point hors page ?)";
    return { ok: false, cover };
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
      newPass();
      const iframe = deepQueryAll("iframe, frame").find((f) => f.contentWindow === event.source);
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

  // --- get_page_text : mode lecteur -----------------------------------------------------------

  const READER_SKIP_TAGS = new Set(["NAV", "FOOTER", "ASIDE", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "SELECT", "BUTTON", "DIALOG", "FORM", "HEAD"]);
  const READER_SKIP_ROLES = new Set(["navigation", "complementary", "contentinfo", "banner", "search", "dialog", "alertdialog", "menu", "menubar", "toolbar", "tablist"]);

  /** Bloc principal : main / article dominant, sinon le conteneur le plus dense en paragraphes. */
  function readerRoot() {
    const body = document.body;
    const textLen = (el) => (el.innerText || "").length;
    const mains = deepQueryAll("main, [role=main]").filter((el) => isVisible(el) && textLen(el) >= 200);
    if (mains.length) return mains.sort((a, b) => textLen(b) - textLen(a))[0];
    const articles = deepQueryAll("article, [role=article]").filter((el) => isVisible(el));
    if (articles.length) {
      const lens = articles.map(textLen);
      const total = lens.reduce((a, b) => a + b, 0);
      const best = lens.indexOf(Math.max(...lens));
      if (total && lens[best] >= 0.6 * total && lens[best] >= 200) return articles[best];
    }
    // Densité façon Readability : chaque paragraphe crédite son parent (et à moitié son grand-parent).
    const scores = new Map();
    for (const p of deepQueryAll("p, pre, blockquote, h2, h3, li, td")) {
      const len = clean(p.textContent, 2000).length;
      if (len < 25) continue;
      const parentEl = parentElementDeep(p);
      if (!parentEl) continue;
      scores.set(parentEl, (scores.get(parentEl) ?? 0) + Math.min(len, 1000));
      const grand = parentElementDeep(parentEl);
      if (grand) scores.set(grand, (scores.get(grand) ?? 0) + Math.min(len, 1000) / 2);
    }
    let best = null;
    let bestScore = 0;
    for (const [el, s] of scores) {
      if (s > bestScore && el !== body && el !== document.documentElement && isVisible(el)) {
        best = el;
        bestScore = s;
      }
    }
    return best;
  }

  // Bruit des wikis (MediaWiki et dérivés) : liens « modifier » des titres, palettes de navigation.
  const READER_SKIP_CLASS = /(^|\s)(mw-editsection|editsection|navbox|navbox-container|vertical-navbox|catlinks|printfooter|noprint)(\s|$)/;
  const EDIT_SUFFIX = /\s*\[?\s*(modifier( le code)?|modifier le wikicode|edit( source)?|éditer)(\s*\|\s*(modifier( le code)?|modifier le wikicode|edit( source)?|éditer))*\s*\]?\s*$/i;

  /** Formule : source TeX (alttext, annotation x-tex ou alt de l'image de repli) au lieu des nœuds MathML. */
  function mathText(el) {
    let tex = el.getAttribute("alttext") || el.querySelector?.('annotation[encoding="application/x-tex"]')?.textContent ||
      (el.tagName === "IMG" ? el.getAttribute("alt") : "") || el.textContent || "";
    tex = tex.trim().replace(/^\{\\displaystyle\s*/, "").replace(/^\{\\textstyle\s*/, "");
    if (/^\{\\(display|text)style/.test(el.getAttribute("alttext") || el.getAttribute("alt") || "") && tex.endsWith("}")) tex = tex.slice(0, -1).trim();
    return tex ? ` $${tex.replace(/\s+/g, " ")}$ ` : "";
  }

  /** Texte d'un titre sans ses liens d'édition. */
  function headingText(h) {
    let t = h.innerText;
    if (h.querySelector(".mw-editsection, .editsection")) {
      const copy = h.cloneNode(true);
      for (const e of copy.querySelectorAll(".mw-editsection, .editsection")) e.remove();
      t = copy.textContent;
    }
    return clean(clean(t, 400).replace(EDIT_SUFFIX, ""), 300);
  }

  /** Texte d'un sous-arbre en Markdown léger : titres #, listes -, lignes de tableau | ; menus retirés. */
  function renderReader(root, skip) {
    const out = [];
    let line = "";
    const flush = () => {
      const t = line.replace(/[ \t ]+/g, " ").trim();
      if (t && t !== "-") out.push(t);
      line = "";
    };
    const rec = (node) => {
      for (const ch of childrenOf(node)) {
        if (ch.nodeType === Node.TEXT_NODE) {
          line += ch.textContent.replace(/\s+/g, " ");
          continue;
        }
        if (ch.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = ch.tagName.toUpperCase();
        if (READER_SKIP_TAGS.has(tag) || ch === skip || ch.id === "abc-overlay" || ch.id === "abc-refmarks") continue;
        const role = ch.getAttribute("role");
        if (role && READER_SKIP_ROLES.has(role)) continue;
        if (ch.getAttribute("aria-hidden") === "true") continue;
        if (tag === "HEADER" && !ch.closest("article, main, [role=main]")) continue;
        if (typeof ch.className === "string" && READER_SKIP_CLASS.test(ch.className)) continue;
        if (tag === "BR") {
          flush();
          continue;
        }
        const s = style(ch);
        if (s.display === "none" || s.visibility === "hidden") continue;
        if (tag === "MATH") {
          line += mathText(ch);
          continue;
        }
        if (/^H[1-6]$/.test(tag)) {
          flush();
          const t = headingText(ch);
          if (t) out.push("", `${"#".repeat(Number(tag[1]))} ${t}`, "");
          continue;
        }
        if (tag === "TR") {
          flush();
          const cells = [...ch.cells].map((c) => clean(c.innerText, 200));
          if (cells.some(Boolean)) out.push(`| ${cells.join(" | ")} |`);
          continue;
        }
        if (tag === "PRE") {
          flush();
          out.push((ch.innerText || "").replace(/\n{3,}/g, "\n\n").trimEnd(), "");
          continue;
        }
        if (tag === "LI") {
          flush();
          line = "- ";
          rec(ch);
          flush();
          continue;
        }
        if (tag === "IMG") {
          if (/mwe-math-fallback-image/.test(ch.className)) line += mathText(ch);
          continue;
        }
        const blockish = !/^inline/.test(s.display) && s.display !== "contents";
        if (blockish) {
          flush();
          rec(ch);
          flush();
          if (tag === "P" || tag === "BLOCKQUOTE" || tag === "UL" || tag === "OL" || tag === "TABLE") out.push("");
        } else {
          rec(ch);
        }
      }
    };
    rec(root);
    flush();
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  /**
   * Texte de la page. Mode lecteur par défaut : bloc principal (main, article, ou le plus dense),
   * sans navigation, pied de page, encadrés ni bannière de cookies, titres en Markdown. Repli sur
   * la page entière si le lecteur ramène moins de 20 % du texte (ou full: true). offset : suite
   * d'un texte tronqué.
   */
  function pageText({ offset = 0, full = false, max = 50_000 } = {}) {
    const body = document.body;
    const whole = () => (body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
    let text = null;
    let mode = "page";
    if (!full && body) {
      try {
        const root = readerRoot();
        if (root) {
          const banner = findOverlay();
          const reader = renderReader(root, banner?.consent ? banner.root : null);
          const all = whole();
          if (reader && reader.length >= 0.2 * all.length) {
            text = reader;
            mode = "lecteur";
          } else {
            text = all;
          }
        }
      } catch {
        text = null;
      }
    }
    if (text === null) text = whole();
    const total = text.length;
    const cap = Math.max(1000, Math.min(Number(max) || 50_000, 200_000));
    const start = Math.max(0, Math.min(Number(offset) || 0, total));
    let slice = text.slice(start, start + cap);
    const end = start + slice.length;
    if (mode === "lecteur" && start === 0) slice = `[Mode lecteur : contenu principal, menus et pied de page retirés]\n\n${slice}`;
    if (start > 0) slice = `[Suite à partir du car. ${start} sur ${total}]\n${slice}`;
    if (end < total) slice += `\n[Suite : offset=${end} (${total} car. au total)]`;
    return {
      title: document.title,
      url: location.href,
      text: slice,
      mode, total, offset: start,
      nextOffset: end < total ? end : null,
    };
  }

  /** Mots vides retirés des requêtes : ils matchent partout (« de ») et noient le signal. */
  const STOP_WORDS = new Set([
    "de", "du", "des", "le", "la", "les", "un", "une", "et", "est", "en", "au", "aux",
    "ce", "ces", "dans", "pour", "par", "sur", "pas", "ne", "que", "qui", "quoi", "dont",
    "ou", "il", "elle", "ils", "elles", "je", "tu", "nous", "vous", "on", "se", "sa", "son",
    "ses", "leur", "leurs", "mon", "ma", "mes", "ton", "ta", "tes", "votre", "vos", "notre",
    "nos", "avec", "sans", "sous", "tout", "tous", "toute", "toutes",
    "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "it", "its",
  ]);

  /**
   * GET JSON rejoué dans la page (même session : cookies inclus). Réservé à replay_paginated :
   * même origine que la page uniquement (deuxième garde après celle du background).
   */
  async function fetchJson({ url }) {
    let parsed;
    try {
      parsed = new URL(url, location.href);
    } catch {
      throw new Error(`URL invalide : ${String(url).slice(0, 200)}.`);
    }
    if (parsed.origin !== location.origin) throw new Error(`Refusé : ${parsed.origin} n'est pas l'origine de la page.`);
    const res = await fetch(parsed.toString(), { credentials: "same-origin", signal: AbortSignal.timeout(15000) });
    const body = await res.text();
    return { status: res.status, ok: res.ok, contentType: res.headers.get("content-type") || "", body: body.slice(0, 500_000), bodyTruncated: body.length > 500_000 };
  }

  /**
   * Digest numérique compact de la page (effet constaté entre étapes) : URL, titre, volume de
   * texte, valeurs saisies, interactifs. Petites pages : innerText (voit les menus dépliés).
   * Grosses pages (> 150 000 car.) : textContent, sans layout ; le mode est fixé au premier
   * appel du document pour que avant et après restent comparables.
   */
  let digestMode = null;
  /**
   * Instant de la dernière mutation de contenu (même variable et mêmes règles que domQuietProbe de
   * bg/navigation.js). Posé dès le digest d'avant une action : l'attente qui suit sait si la page a bougé.
   */
  function watchDom() {
    if (globalThis.__abcDomWatch) return;
    const watch = (globalThis.__abcDomWatch = { last: Date.now() });
    try {
      new MutationObserver(() => (watch.last = Date.now())).observe(document.documentElement || document, {
        childList: true, subtree: true, characterData: true, attributeFilter: ["hidden", "open", "aria-hidden", "aria-busy"],
      });
    } catch {}
  }
  function pageDigest() {
    watchDom();
    // formLen : innerText ignore les valeurs des champs ; sans lui, une saisie est « inchangée ».
    // (Limite : cases à cocher et listes déroulantes ne sont pas vues ; leur effet passe par la soumission.)
    let formLen = 0;
    try {
      for (const el of document.querySelectorAll("input,textarea")) formLen += (el.value || "").length;
    } catch {}
    const body = document.body;
    let textLen = 0;
    if (body) {
      if (!digestMode) digestMode = body.textContent.length > 150_000 ? "dom" : "inner";
      textLen = digestMode === "inner" ? (body.innerText || "").length : body.textContent.length;
    }
    return {
      url: location.href,
      title: (document.title || "").slice(0, 80),
      textLen,
      formLen,
      interactive: document.querySelectorAll("a[href],button,input,select,textarea,option,[role=button],[onclick],[tabindex]").length,
    };
  }

  // --- find ------------------------------------------------------------------------------------

  /**
   * Candidats d'une recherche, triés par score (non tronqués). Insensible aux accents et à la casse.
   * Mots vides retirés + plancher de pertinence 0,6 : les matchs partiels non interactifs sont du
   * bruit quasi certain ; les éléments interactifs (bonus +0,5) ne sont en pratique jamais écartés.
   * Un ancêtre non interactif qui ne matche que par le texte de ses enfants retenus est écarté
   * (l'enfant est plus précis), comme un texte déjà représenté par un interactif retenu.
   * Préfiltre sans layout ni style (textContent ⊇ innerText) avant les vérifications coûteuses.
   */
  function matchAll(query) {
    if (!query) throw new Error("'query' manquant.");
    let masked = 0;
    let dropped = 0;
    if (query.startsWith("css:")) {
      // Sélecteur explicite = intention explicite : on garde tout (y compris les <input type=file>
      // visuellement masqués et les éléments hors canevas), locate() refusera avec diagnostic.
      let list;
      try {
        list = deepQueryAll(query.slice(4));
      } catch {
        throw new Error(`Sélecteur invalide : ${JSON.stringify(query.slice(4))}.`);
      }
      const matches = list
        .filter((el) => !el.closest("#abc-overlay") && isVisible(el, { offCanvas: false }))
        .map((el) => ({ el, role: roleOf(el) ?? "generic", score: 1 }));
      return { matches, masked, dropped };
    }
    const raw = fold(query).split(/\s+/).filter(Boolean);
    const kept = raw.filter((t) => !STOP_WORDS.has(t));
    const terms = kept.length ? kept : raw; // requête que de mots vides : comportement inchangé
    const need = Math.ceil(terms.length / 2);
    const hitsIn = (hay) => {
      let n = 0;
      for (const t of terms) if (hay.includes(t)) n++;
      return n;
    };
    const cands = [];
    for (const el of deepAll()) {
      const tag = el.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag) || el.id === "abc-overlay" || el.id === "abc-refmarks") continue;
      if (el instanceof SVGElement && tag !== "FOREIGNOBJECT" && !el.closest("foreignObject")) continue;
      const role = roleOf(el);
      let ownText = "";
      for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) ownText += n.textContent + " ";
      const value = "value" in el && !isSensitiveField(el) && typeof el.value === "string" ? el.value : "";
      const attrs = [
        el.getAttribute("placeholder"), el.getAttribute("title"), el.getAttribute("alt"),
        el.getAttribute("aria-label"), el.getAttribute("name"), el.id, value,
      ].filter(Boolean).join(" ");
      const ownHay = fold(`${role ?? ""} ${ownText} ${attrs}`);
      let ownHits = hitsIn(ownHay);
      if (ownHits < need) {
        // Le nom peut venir du contenu, d'un libellé ou d'aria-labelledby : préfiltre textContent.
        const viaLabel = el.hasAttribute("aria-labelledby") || (el.labels && el.labels.length);
        const viaContent = role && NAME_FROM_CONTENT.has(role);
        if (!viaLabel && !viaContent) continue;
        const cheap = fold(`${viaContent ? el.textContent : ""} ${viaLabel ? labelledByText(el) + " " + [...(el.labels ?? [])].map((l) => l.textContent).join(" ") : ""}`);
        if (hitsIn(`${ownHay} ${cheap}`) < need) continue;
      }
      if (!role && !ownText.trim() && ownHits < need) continue;
      if (!role && !ownText.trim() && !isInteractive(el, role)) continue;
      const name = role ? nameOf(el, role) : "";
      const hits = hitsIn(`${ownHay} ${fold(name)}`);
      if (hits < need) continue;
      if (!isVisible(el, { offCanvas: false })) continue;
      // Hors canevas (lui ou un ancêtre) ou fixe hors écran : présent mais inatteignable, compté à part.
      if (isOffCanvas(el) || hiddenByAncestor(el) || unreachableReason(el)) {
        masked++;
        continue;
      }
      const interactive = isInteractive(el, role);
      const score = hits / terms.length + (interactive ? 0.5 : 0);
      if (score < 0.6) {
        dropped++;
        continue;
      }
      // Match obtenu seulement grâce au texte des descendants (nom tiré du contenu).
      const viaChildren = ownHits < need && !el.getAttribute("aria-label") && !el.hasAttribute("aria-labelledby");
      cands.push({ el, role: role ?? "text", score, interactive, viaChildren });
    }
    const byEl = new Map(cands.map((c) => [c.el, c]));
    const hasMatchedDesc = new Set();
    for (const c of cands) {
      for (let n = composedParent(c.el), d = 0; n && d < 60; n = composedParent(n), d++) {
        if (hasMatchedDesc.has(n)) break;
        hasMatchedDesc.add(n);
      }
    }
    const coveredByInteractive = (c) => {
      for (let n = composedParent(c.el), d = 0; n && d < 60; n = composedParent(n), d++) {
        const anc = byEl.get(n);
        if (anc && anc.interactive) return true;
      }
      return false;
    };
    const matches = cands.filter((c) => {
      if (c.interactive) return true;
      if (c.viaChildren && hasMatchedDesc.has(c.el)) return false;
      return !coveredByInteractive(c);
    });
    matches.sort((a, b) => b.score - a.score);
    return { matches, masked, dropped };
  }

  const DUP_SEL = `${CONTAINER_SEL}, section, fieldset, [role=region], [role=group]`;

  /** « dans listitem « … » » : distingue des résultats identiques par leur conteneur. */
  function dupContext(el) {
    const p = parentElementDeep(el);
    const c = p ? closestDeep(p, DUP_SEL) : null;
    if (!c) return "";
    const role = roleOf(c) ?? c.tagName.toLowerCase();
    let t = clean(c.innerText, 400);
    const own = clean(el.innerText, 200);
    if (own && t.includes(own)) t = t.replace(own, " ");
    t = clean(t, 60);
    return t ? ` dans ${role} « ${t} »` : "";
  }

  /** Lignes des résultats (texte ajouté aux nœuds de texte, contexte pour les doublons). */
  function linesFor(matches) {
    const lines = matches.map(({ el, role }) => {
      let line = "- " + describe(el, role);
      if (role === "text" || role === "generic") {
        const t = clean(el.innerText, 120);
        if (t && !line.includes(q(t))) line += ` ${q(t)}`;
      }
      return line;
    });
    const key = (l) => l.replace(/\[ref_\d+\]/, "");
    const counts = new Map();
    for (const l of lines) counts.set(key(l), (counts.get(key(l)) ?? 0) + 1);
    return lines.map((l, i) => (counts.get(key(l)) > 1 ? l + dupContext(matches[i].el) : l));
  }

  function formatItems(items, query, limit, structured, masked, dropped) {
    const total = items.length;
    const shown = items.slice(0, limit);
    if (structured) return { total, masked, dropped, items: shown.map((it) => ({ line: it.line, score: it.score })) };
    const maskedNote = masked ? `\n(${masked} élément(s) masqué(s) ignoré(s) : fixes hors écran, non cliquables)` : "";
    const droppedNote = dropped ? `\n(${dropped} match(s) partiel(s) écarté(s) : sous le plancher de pertinence)` : "";
    const more = total > limit ? `\n(${total - limit} autres résultats non affichés)` : "";
    return shown.length
      ? `${total} résultat(s) pour ${JSON.stringify(query)} :\n${shown.map((it) => it.line).join("\n")}${more}${maskedNote}${droppedNote}`
      : `Aucun élément trouvé pour ${JSON.stringify(query)}.${maskedNote}${droppedNote}`;
  }

  /**
   * Balaye les conteneurs défilants (listes virtualisées) en collectant les correspondances à
   * chaque étape : les lignes hors écran n'existent pas dans le DOM, on ne peut les trouver qu'en
   * les faisant apparaître. Chaque ligne est décrite au moment du match (une ligne recyclée change
   * de contenu après coup) ; les résultats obtenus après défilement sont signalés, et leur ref est
   * détachée si le nœud a changé entre-temps (réparation par empreinte, ou échec net).
   * Positions restaurées à la fin. Borné : 4 conteneurs, 10 étapes, arrêt si stagnation.
   */
  async function findScan({ query, limit = 20, structured = false }) {
    const seen = new Map(); // clé (élément + ligne) -> { el, line, score, scrolled }
    const keyOf = (line) => line.replace(/\[ref_\d+\]/, "");
    const elKeys = new WeakMap();
    let masked = 0;
    let dropped = 0;
    let scrolled = false;
    const collect = () => {
      newPass();
      const r = matchAll(query);
      masked = Math.max(masked, r.masked);
      dropped = Math.max(dropped, r.dropped);
      const lines = linesFor(r.matches);
      r.matches.forEach((m, i) => {
        let perEl = elKeys.get(m.el);
        if (!perEl) elKeys.set(m.el, (perEl = new Map()));
        const k = keyOf(lines[i]);
        if (perEl.has(k)) return;
        const entry = { el: m.el, line: lines[i], score: m.score, scrolled };
        perEl.set(k, entry);
        seen.set(entry, true);
      });
    };
    collect();
    const doc = document.scrollingElement;
    const scrollers = [];
    if (doc && doc.scrollHeight - doc.clientHeight > 100) scrollers.push(doc);
    for (const el of deepAll()) {
      if (scrollers.length >= 4) break;
      if (el === doc || el.id === "abc-overlay") continue;
      if (el.scrollHeight - el.clientHeight > 100 && el.clientHeight > 40) scrollers.push(el);
    }
    for (const sc of scrollers) {
      const start = sc.scrollTop;
      const max = sc.scrollHeight - sc.clientHeight;
      if (max <= 0) continue;
      const steps = Math.min(10, Math.max(2, Math.ceil(max / (sc.clientHeight || 600))));
      let stagnant = 0;
      try {
        for (let i = 1; i <= steps; i++) {
          sc.scrollTop = (max * i) / steps;
          scrolled = true;
          await sleep(250);
          const before = seen.size;
          collect();
          stagnant = seen.size === before ? stagnant + 1 : 0;
          if (stagnant >= 2 || seen.size >= limit * 3) break;
        }
      } finally {
        sc.scrollTop = start;
      }
    }
    await sleep(50);
    newPass();
    const items = [];
    for (const entry of seen.keys()) {
      let line = entry.line;
      if (entry.scrolled) {
        // Le nœud a-t-il gardé ce contenu après restauration du défilement ?
        const still = entry.el.isConnected && keyOf("- " + describe(entry.el, roleOf(entry.el) ?? (line.startsWith("- text") ? "text" : "generic"))) === keyOf(line.split(" dans ")[0]);
        if (!still) forgetRef(entry.el);
        line += " (trouvé après défilement)";
      }
      items.push({ line, score: entry.score });
    }
    items.sort((a, b) => b.score - a.score);
    return formatItems(items, query, limit, structured, masked, dropped);
  }

  /** Recherche d'éléments (texte ou 'css:…') ; scan=true balaye les listes virtualisées avant de conclure. */
  function find({ query, limit = 20, structured = false, scan = false }) {
    if (scan) return findScan({ query, limit, structured });
    const { matches, masked, dropped } = matchAll(query);
    const lines = linesFor(matches.slice(0, limit));
    const items = matches.map((m, i) => ({ line: lines[i] ?? "", score: m.score }));
    return formatItems(items, query, limit, structured, masked, dropped);
  }

  // --- query / scroll_extract ------------------------------------------------------------------

  /** outerHTML sans la valeur des champs sensibles (mot de passe, code, carte, secret rempli). */
  function safeOuterHTML(el, max = 2000) {
    const fields = el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? [el] : [...el.querySelectorAll("input, textarea")];
    if (!fields.some(isSensitiveField)) return (el.outerHTML || "").slice(0, max);
    const clone = el.cloneNode(true);
    const cloned = clone.tagName === "INPUT" || clone.tagName === "TEXTAREA" ? [clone] : [...clone.querySelectorAll("input, textarea")];
    fields.forEach((f, i) => {
      if (!isSensitiveField(f) || !cloned[i]) return;
      cloned[i].removeAttribute("value");
      if (cloned[i].tagName === "TEXTAREA") cloned[i].textContent = "";
    });
    return (clone.outerHTML || "").slice(0, max);
  }

  function makeReader(extract) {
    return (el) => {
      if (extract === "html") return safeOuterHTML(el, 2000);
      if (extract === "aria") return (el.getAttribute("aria-label") || "").trim().slice(0, 2000);
      if (extract && typeof extract === "object" && Array.isArray(extract.attrs)) {
        const o = {};
        for (const name of extract.attrs) {
          o[name] = String(name).toLowerCase() === "value" && isSensitiveField(el) && el.hasAttribute("value") ? "••••" : el.getAttribute(name);
        }
        return JSON.stringify(o);
      }
      return clean(el.innerText || el.textContent || "", 2000);
    };
  }

  /**
   * Extraction structurée sans scroll : sélecteur CSS + projection (text/html/aria/attrs) +
   * filtre (contains/regex) + pagination + countOnly. Le comptage et le filtrage se font dans
   * la page : compter 2000 lignes coûte une ligne de réponse, pas 2000. Traverse les shadow DOM.
   */
  function query({ selector, extract = "text", filter = null, limit = 200, offset = 0, countOnly = false } = {}) {
    if (!selector || typeof selector !== "string") throw new Error("'selector' requis : sélecteur CSS.");
    let els;
    try {
      els = deepQueryAll(selector).filter((el) => !el.closest("#abc-overlay"));
    } catch {
      throw new Error(`Sélecteur invalide : ${JSON.stringify(selector)}.`);
    }
    const readOne = makeReader(extract);
    let re = null;
    if (filter && typeof filter === "object" && filter.regex) {
      try {
        re = new RegExp(filter.regex, "i");
      } catch {
        throw new Error(`Regex invalide : ${JSON.stringify(filter.regex)}.`);
      }
    }
    const contains = filter && typeof filter === "object" && typeof filter.contains === "string"
      ? filter.contains.toLowerCase()
      : null;
    const all = [];
    for (const el of els) {
      const t = readOne(el);
      if (contains && !t.toLowerCase().includes(contains)) continue;
      if (re && !re.test(t)) continue;
      all.push(t);
    }
    const total = all.length;
    const start = Math.max(0, offset);
    const page = countOnly ? [] : all.slice(start, start + Math.max(0, limit));
    return {
      items: page, count: page.length, total, offset: start, limit,
      truncatedByLimit: !countOnly && total > start + page.length,
    };
  }

  /**
   * Tableaux de la page en Markdown ou CSV : <table> (colspan répété, rowspan descendu) et
   * grilles ARIA (role=grid|table|treegrid), lignes ordonnées par aria-rowindex si présent.
   */
  function tables({ selector, format = "markdown", limit = 10, maxRows = 200 } = {}) {
    let els;
    try {
      els = deepQueryAll(selector || GRID_SEL);
    } catch {
      throw new Error(`Sélecteur invalide : ${JSON.stringify(selector)}.`);
    }
    const isGrid = (el) => el.tagName === "TABLE" || /^(grid|table|treegrid)$/.test(el.getAttribute("role") || "");
    const all = [...new Set(els)].filter((el) => isGrid(el) && !el.closest("#abc-overlay"));
    const picked = all.slice(0, Math.max(1, Math.min(limit || 10, 50)));
    const rows = Math.max(1, Math.min(maxRows || 200, 1000));
    return {
      total: all.length,
      count: picked.length,
      tables: picked.map((table, i) => {
        let grid;
        let caption = "";
        if (table.tagName === "TABLE") {
          grid = tableGrid(table, rows);
          caption = clean(table.querySelector("caption")?.textContent ?? "", 120);
        } else {
          const g = ariaGrid(table, rows);
          grid = g.grid;
          caption = clean(table.getAttribute("aria-label") || labelledByText(table), 100);
          if (g.first && g.last) {
            const range = `lignes ${g.first} à ${g.last}${g.total ? ` sur ${g.total}` : ""}`;
            const virtual = g.total && g.last - g.first + 1 < g.total ? ", grille virtualisée : faire défiler pour la suite" : "";
            caption = caption ? `${caption} (${range}${virtual})` : `${range}${virtual}`;
          }
        }
        return {
          index: i,
          caption,
          rows: grid.length,
          cols: grid.reduce((m, r) => Math.max(m, r.length), 0),
          text: format === "csv" ? gridToCsv(grid) : gridToMarkdown(grid),
        };
      }),
    };
  }

  /**
   * L'onglet peint-il vraiment (RAF qui part) ? Sans paint, ni les scroll events (listes à
   * chargement progressif) ni l'IntersectionObserver ne se déclenchent : scroll_extract doit
   * passer au premier plan au lieu de tourner dans le vide en arrière-plan.
   */
  function canPaint() {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; resolve({ paints: false, visibility: document.visibilityState }); }
      }, 350);
      requestAnimationFrame(() => {
        if (!done) { done = true; clearTimeout(timer); resolve({ paints: true, visibility: document.visibilityState }); }
      });
    });
  }

  /**
   * Extrait tous les items d'une liste à chargement progressif en un appel : scroll répété du
   * conteneur + collecte à chaque étape (le motif « scroll, attendre, recompter » codé à la main
   * sinon). Couvre les listes qui ajoutent au DOM (scroll infini) et les virtualisées (les lignes
   * hors écran n'existent pas dans le DOM : extraction incrémentale, jamais de relecture finale).
   * Déduplique par identité + contenu : un élément revu avec le même texte est sauté, un nœud
   * recyclé qui affiche un nouveau contenu est re-collecté. Les textes strictement identiques
   * portés par des éléments différents (cinq « Ok ») survivent tous. Seuls les items nouveaux ou
   * modifiés (signalés par le MutationObserver) sont relus : la relecture coûte un layout.
   * Attente réactive par MutationObserver (contenu stabilisé, pas sleep fixe) ; listes à bouton
   * via loadMore (clic quand le scroll ne rapporte rien) ; axes down/up/left/right avec bascule
   * automatique sur l'axe qui scrolle vraiment (direction réelle reportée).
   * Position de scroll restaurée à la fin. Appelé en arrière-plan quand l'onglet peint, au premier
   * plan sinon (décision côté background via canPaint : sans paint, pas de scroll events).
   */
  async function scrollExtract({ item, container = null, direction = "down", extract = "text", maxRounds = 40, stableRounds = 2, waitMs = 1200, limit = 3000, offset = 0, loadMore = null } = {}) {
    if (!item || typeof item !== "string") throw new Error("'item' requis : sélecteur CSS des lignes à extraire.");
    let dir = direction === "up" ? "up" : direction === "left" ? "left" : direction === "right" ? "right" : "down";

    let scroller = null;
    try {
      scroller = container ? deepQueryAll(container)[0] ?? null : null;
    } catch {
      throw new Error(`Sélecteur de conteneur invalide : ${JSON.stringify(container)}.`);
    }
    if (container && !scroller) throw new Error(`Conteneur ${JSON.stringify(container)} introuvable.`);
    if (!scroller) {
      // Auto : le plus proche ancêtre scrollable du premier item, sinon la page.
      let first;
      try {
        first = deepQueryAll(item)[0];
      } catch {
        throw new Error(`Sélecteur d'item invalide : ${JSON.stringify(item)}.`);
      }
      if (!first) return { items: [], count: 0, total: 0, rounds: 0, hasMore: false, container: "aucun (sélecteur sans match)", direction: dir };
      scroller = parentElementDeep(first);
      const scrollable = (el) =>
        (el.scrollHeight - el.clientHeight > 40 && el.clientHeight > 40) ||
        (el.scrollWidth - el.clientWidth > 40 && el.clientWidth > 40);
      while (scroller && !scrollable(scroller)) {
        scroller = parentElementDeep(scroller);
      }
      if (!scroller || scroller === document.body || scroller === document.documentElement) scroller = document.scrollingElement;
    }
    const describeScroller = scroller === document.scrollingElement
      ? "page"
      : `${scroller.tagName.toLowerCase()}${scroller.id ? `#${scroller.id}` : ""}${typeof scroller.className === "string" && scroller.className.trim() ? `.${scroller.className.trim().split(/\s+/)[0]}` : ""}`;

    const readOne = makeReader(extract);
    // Déduplique par IDENTITÉ + contenu : un élément déjà vu avec le même texte est sauté
    // (listes par ajout : pas de doublon aux frontières de pages) ; un élément vu dont le texte a
    // changé est re-collecté (listes virtualisées à recyclage de nœuds : même objet, nouveau contenu).
    const seen = new Map(); // Element -> dernier texte collecté
    const items = []; // ordre d'apparition conservé
    const root = scroller === document.scrollingElement ? document : scroller;
    const shadowRoots = shadowRootsUnder(root);
    const listItems = () => (shadowRoots.length
      ? [...root.querySelectorAll(item), ...shadowRoots.flatMap((sr) => [...sr.querySelectorAll(item)])]
      : root.querySelectorAll(item));
    const changed = new Set(); // items touchés par une mutation depuis la dernière collecte
    const collect = () => {
      let added = 0;
      for (const el of listItems()) {
        if (el.closest("#abc-overlay")) continue;
        if (seen.has(el) && !changed.has(el)) continue;
        const t = readOne(el);
        if (seen.get(el) === t) continue;
        seen.set(el, t);
        items.push(t);
        added++;
      }
      changed.clear();
      return added;
    };

    // Axe effectif + bascule automatique : une direction verticale sur un conteneur à scroll
    // horizontal (ou l'inverse) partirait dans le vide ; on bascule et on reporte la direction réelle.
    const canV = scroller.scrollHeight - scroller.clientHeight > 2;
    const canH = scroller.scrollWidth - scroller.clientWidth > 2;
    const vertical = dir === "down" || dir === "up";
    if (vertical && !canV && canH) dir = dir === "up" ? "left" : "right";
    if (!vertical && !canH && canV) dir = dir === "left" ? "up" : "down";
    const horiz = dir === "left" || dir === "right";
    const forward = dir === "down" || dir === "right";
    const pos = () => (horiz ? scroller.scrollLeft : scroller.scrollTop);
    const span = () => (horiz ? scroller.clientWidth || 600 : scroller.clientHeight || 600);
    const full = () => (horiz ? scroller.scrollWidth : scroller.scrollHeight);
    const setPos = (v) => { if (horiz) scroller.scrollLeft = v; else scroller.scrollTop = v; };
    const startPos = pos();
    const atEnd = () => (forward ? pos() + span() >= full() - 2 : pos() <= 2);
    // Balayage déterministe : on part d'un bout pour tout couvrir en un appel.
    setPos(forward ? 0 : full());
    await sleep(150);

    // Attente réactive : un MutationObserver signale l'arrivée de contenu (dirty) au lieu d'un
    // polling aveugle, et note les items modifiés (seuls relus ensuite).
    let dirty = true;
    let lastMut = Date.now();
    const observer = new MutationObserver((records) => {
      dirty = true;
      lastMut = Date.now();
      for (const r of records) {
        const node = r.target.nodeType === Node.ELEMENT_NODE ? r.target : r.target.parentElement;
        const owner = node?.closest?.(item);
        if (owner) changed.add(owner);
      }
    });
    // Scroll natif vs fenêtres bridées : un scroll programmé ne déclenche son événement que si
    // la page peint vraiment (onglet actif MAIS fenêtre occultée = bridé aussi). On écoute le
    // scroll natif ; s'il ne vient pas sous 100 ms, on rejoue un événement scroll synthétique
    // (atteint les listeners du monde principal : même DOM partagé). Sans ça, les listes ne
    // chargent jamais et l'extraction s'arrête au premier écran dès que l'utilisateur travaille.
    let nativeScroll = false;
    const onScroll = () => { nativeScroll = true; };
    const SETTLE_MS = 250; // calme après nouveauté avant de conclure le tour
    const FAST_MS = 300; // hors du bout sans nouveauté : on avance vite
    const settle = async (before, sizeBefore) => {
      const t0 = Date.now();
      let arrived = false;
      let syntheticDone = false;
      for (;;) {
        await sleep(50);
        const now = Date.now();
        if (!syntheticDone && !nativeScroll && now - t0 >= 100) {
          syntheticDone = true;
          try { scroller.dispatchEvent(new Event("scroll")); } catch {}
        }
        if (dirty) { dirty = false; collect(); }
        if (items.length > before || full() !== sizeBefore) arrived = true;
        if (arrived && now - lastMut >= SETTLE_MS) break; // contenu arrivé et stabilisé
        if (!arrived && !atEnd() && now - t0 >= FAST_MS) break; // rien ne vient : avance vite
        if (now - t0 >= waitMs) break; // patience épuisée (mutations permanentes : borné)
      }
      collect();
    };

    let rounds = 0;
    let endStable = 0; // tours sans nouveauté AU BOUT (le lazy-load a droit à stableRounds chances)
    let stuck = 0; // tours sans nouveauté ET sans avance du scroll (sécurité anti-boucle)
    let lastNew = 0;
    let loadMoreClicks = 0;
    let loadMoreDone = !loadMore;
    const clickLoadMore = () => {
      if (loadMoreDone || loadMoreClicks >= Math.max(1, maxRounds)) return false;
      let btn = null;
      try {
        btn = deepQueryAll(loadMore)[0] ?? null;
      } catch {}
      const visible = !!btn && !!(btn.offsetWidth || btn.offsetHeight || (btn.getClientRects && btn.getClientRects().length));
      const disabled = !btn || btn.disabled === true || (btn.getAttribute && btn.getAttribute("aria-disabled") === "true");
      if (!btn || !visible || disabled) { loadMoreDone = true; return false; }
      btn.click();
      loadMoreClicks++;
      return true;
    };
    try {
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      scroller.addEventListener("scroll", onScroll);
      for (let i = 0; i < maxRounds; i++) {
        rounds++;
        const before = items.length;
        const sizeBefore = full();
        collect();
        const step = Math.max(50, span());
        const posBefore = pos();
        nativeScroll = false;
        setPos(pos() + (forward ? step : -step));
        await settle(before, sizeBefore);
        let fresh = items.length - before;
        // Listes à bouton : quand le scroll ne rapporte rien, on clique « charger plus »
        // puis on attend comme après un scroll (même settle réactif).
        if (fresh === 0 && !loadMoreDone) {
          const beforeClick = items.length;
          const sizeBeforeClick = full();
          if (clickLoadMore()) {
            await settle(beforeClick, sizeBeforeClick);
            fresh = items.length - before;
          }
        }
        lastNew = fresh;
        if (atEnd()) {
          endStable = fresh === 0 ? endStable + 1 : 0;
          if (endStable >= Math.max(1, stableRounds)) break;
        } else {
          endStable = 0;
        }
        // Pas de break sur « stable » hors du bout : au milieu de la liste, l'absence de nouveauté
        // veut juste dire qu'on n'a pas encore atteint le déclencheur de chargement.
        stuck = pos() === posBefore && fresh === 0 ? stuck + 1 : 0;
        if (stuck >= Math.max(2, stableRounds)) break;
      }
    } finally {
      try { observer.disconnect(); } catch {}
      try { scroller.removeEventListener("scroll", onScroll); } catch {}
      setPos(startPos);
    }
    const total = items.length;
    const hasMore = rounds >= maxRounds && lastNew > 0;
    const start = Math.max(0, offset);
    const page = items.slice(start, start + Math.max(0, limit));
    return {
      items: page, count: page.length, total, rounds, hasMore, offset: start, limit,
      container: describeScroller, direction: dir, loadMoreClicks,
      truncatedByLimit: total > start + page.length,
    };
  }

  /**
   * Éléments interactifs visibles à l'écran, avec position et ref : base des pastilles
   * de la capture annotée. Main frame uniquement, borné (défaut 30).
   * Seuls les éléments actionnables sont numérotés (pas les landmarks structurels) et les
   * plus grands d'abord : sur une grille d'images, les pastilles tombent sur les visuels,
   * pas sur l'en-tête.
   */
  function refMarks({ limit = 30 } = {}) {
    const max = Math.min(Math.max(Number(limit) || 30, 1), 60);
    const found = [];
    // Pré-filtre par sélecteur natif (rapide) : seuls les candidats passent les tests
    // coûteux (styles calculés). Les <div> cliquables sans rôle ni tabindex n'ont pas de
    // pastille, ils restent accessibles via read_page / find.
    const candidates = deepQueryAll("a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex]");
    for (const el of candidates) {
      if (SKIP_TAGS.has(el.tagName.toUpperCase()) || el.closest("#abc-overlay") || el.closest("#abc-refmarks")) continue;
      const role = roleOf(el);
      if (!isInteractive(el, role)) continue;
      if (!isVisible(el) || !inViewport(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const line = describe(el, role ?? "generic", role ? undefined : clean(el.innerText, 60) || undefined);
      const m = /\[ref_(\d+)\]/.exec(line);
      if (!m) continue;
      found.push({
        ref: `ref_${m[1]}`,
        x: Math.round(r.left),
        y: Math.round(r.top),
        area: r.width * r.height,
        label: line.replace(/^-\s*/, "").replace(/\s*\[ref_\d+\]/, "").slice(0, 60),
      });
    }
    found.sort((a, b) => b.area - a.area);
    return found.slice(0, max).map((mk, i) => ({ n: i + 1, ref: mk.ref, x: mk.x, y: mk.y, label: mk.label }));
  }

  /** Affiche les pastilles numérotées (overlay dédié, retiré par hideRefMarks). */
  function showRefMarks({ marks } = {}) {
    for (const old of document.querySelectorAll("#abc-refmarks")) old.remove();
    const host = document.createElement("div");
    host.id = "abc-refmarks";
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML =
      "<style>.m{position:fixed;min-width:22px;height:22px;padding:0 5px;border-radius:11px;" +
      "background:rgba(139,92,246,.92);color:#fff;font:bold 13px/22px sans-serif;text-align:center;" +
      "box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,.4);}</style>" +
      (marks ?? [])
        .map(
          (mk) =>
            `<div class="m" style="left:${Math.max(0, mk.x - 4)}px;top:${Math.max(0, mk.y - 4)}px;">${mk.n}</div>`,
        )
        .join("");
    document.documentElement.appendChild(host);
    return (marks ?? []).length;
  }

  function hideRefMarks() {
    for (const old of document.querySelectorAll("#abc-refmarks")) old.remove();
  }

  // --- form_input -----------------------------------------------------------------------------

  const BUTTON_TYPES = new Set(["submit", "button", "reset", "image"]);
  const DATE_TYPES = new Set(["date", "time", "datetime-local", "month", "week"]);
  const DATE_FORMATS = { date: "aaaa-mm-jj", time: "hh:mm", "datetime-local": "aaaa-mm-jjThh:mm", month: "aaaa-mm", week: "aaaa-Wss" };
  const tick = (ms = 50) => sleep(ms);
  const truthy = (v) => v === true || v === 1 || ["true", "on", "1", "oui", "yes", "checked", "coché", "coche"].includes(fold(String(v ?? "")).trim());

  /** Formats français (jj/mm/aaaa, 14h30, mm/aaaa) convertis au format des champs date natifs. */
  function frenchDate(type, raw) {
    const s = String(raw).trim();
    const pad = (n) => String(n).padStart(2, "0");
    const d = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T,]+(?:à\s*)?(\d{1,2})\s*[h:]\s*(\d{2})?)?$/i.exec(s);
    if (type === "date" && d && !d[4]) return `${d[3]}-${pad(d[2])}-${pad(d[1])}`;
    if (type === "datetime-local") {
      if (d) return `${d[3]}-${pad(d[2])}-${pad(d[1])}T${pad(d[4] ?? 0)}:${pad(d[5] ?? 0)}`;
      const iso = /^(\d{4}-\d{2}-\d{2})[ ,]+(\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
      if (iso) return `${iso[1]}T${iso[2]}`;
    }
    if (type === "time") {
      const t = /^(\d{1,2})\s*[h:]\s*(\d{2})?(?::(\d{2}))?$/i.exec(s);
      if (t) return `${pad(t[1])}:${pad(t[2] ?? 0)}${t[3] ? `:${t[3]}` : ""}`;
    }
    if (type === "month") {
      const m = /^(\d{1,2})[/.-](\d{4})$/.exec(s);
      if (m) return `${m[2]}-${pad(m[1])}`;
    }
    return s;
  }

  function nativeSetValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    // Setter natif : contourne le suivi de valeur de React pour que l'événement 'input' soit pris en compte.
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function fireInput(el, data) {
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Clic synthétique complet (pointer + souris) : les listes s'ouvrent sur pointerdown, mousedown ou click selon les bibliothèques. */
  function pressOn(el) {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
    try { el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerType: "mouse", isPrimary: true, buttons: 1 })); } catch {}
    el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
    try { el.focus?.({ preventScroll: true }); } catch {}
    try { el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerType: "mouse", isPrimary: true, buttons: 0 })); } catch {}
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0, detail: 1 }));
  }

  function pressKey(el, key) {
    const init = { key, code: key, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  async function waitUntil(fn, ms) {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 >= ms) return null;
      await sleep(50);
    }
  }

  async function setNativeValue(el, ref, value, { blur = true } = {}) {
    const type = el.tagName === "INPUT" ? el.type : "textarea";
    let wanted = value === null || value === undefined ? "" : String(value);
    let note = "";
    if (DATE_TYPES.has(type) && wanted) {
      const converted = frenchDate(type, wanted);
      if (converted !== wanted.trim()) note = ` (converti en ${converted})`;
      wanted = converted;
    }
    if (el.disabled) throw new Error(`${ref} est désactivé : la page n'accepte pas de saisie pour l'instant.`);
    if (el.readOnly) throw new Error(`${ref} est en lecture seule (readonly) : la valeur se choisit autrement (bouton, calendrier, liste) ; cliquer avec computer.`);
    const before = el.value;
    el.focus();
    nativeSetValue(el, wanted);
    fireInput(el, wanted);
    if (blur) el.blur();
    await tick();
    const now = el.value;
    const secret = isSensitiveField(el);
    const shown = (v) => q(secret ? "••••" : v);
    if (wanted !== "" && now === "") {
      if (DATE_TYPES.has(type)) throw new Error(`Valeur ${q(String(value))} refusée par ${ref} (type=${type}) : format attendu ${DATE_FORMATS[type]} (ou jj/mm/aaaa pour une date).`);
      if (type === "number") throw new Error(`Nombre invalide pour ${ref} : ${q(String(value))} (chiffres, point décimal).`);
      throw new Error(`Valeur non prise par ${ref} : le champ est resté vide (champ contrôlé qui l'a refusée ?). Écrire avec computer (clic + type).`);
    }
    if (now !== wanted && now === before && before !== "") {
      throw new Error(`Valeur refusée par ${ref} : la page a rétabli ${shown(before)}. Écrire avec computer (clic + type).`);
    }
    if (now !== wanted) return `${ref} = ${shown(wanted)}${note}. Valeur reformatée par la page : ${shown(now)}.`;
    return `${ref} = ${shown(wanted)}${note}.`;
  }

  async function toggleNative(el, ref, value) {
    const wanted = truthy(value);
    if (el.disabled) throw new Error(`${ref} est désactivé.`);
    if (el.type === "radio" && !wanted && el.checked) {
      throw new Error(`${ref} : un bouton radio ne se décoche pas ; cocher une autre option du même groupe.`);
    }
    if (el.checked !== wanted) el.click(); // click() déclenche les handlers des frameworks
    await tick();
    if (el.checked !== wanted) {
      throw new Error(`${ref} : impossible de le ${wanted ? "cocher" : "décocher"} (la page a annulé le clic) ; essayer avec computer sur la case ou son libellé.`);
    }
    return `${ref} ${wanted ? "coché" : "décoché"}.`;
  }

  async function toggleAria(el, ref, value, role) {
    const wanted = truthy(value);
    const state = () => el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-pressed") === "true";
    if (el.getAttribute("aria-disabled") === "true") throw new Error(`${ref} est désactivé.`);
    if (role === "radio" && !wanted && state()) throw new Error(`${ref} : un bouton radio ne se décoche pas ; choisir une autre option du groupe.`);
    if (state() !== wanted) el.click();
    await tick(80);
    if (state() !== wanted) throw new Error(`${ref} (${role}) : l'état n'a pas changé après le clic ; essayer avec computer.`);
    return `${ref} ${wanted ? "coché" : "décoché"}.`;
  }

  async function selectNative(el, ref, value) {
    const opts = [...el.options];
    const want = Array.isArray(value) ? value.map(String) : [String(value ?? "")];
    const label = (o) => o.text.trim();
    const pick = (w) => {
      const f = fold(w).trim();
      return opts.find((o) => o.value === w) ?? opts.find((o) => label(o) === w) ?? opts.find((o) => fold(label(o)) === f) ??
        (() => {
          const starts = opts.filter((o) => fold(label(o)).startsWith(f));
          return f && starts.length === 1 ? starts[0] : null;
        })();
    };
    const chosen = want.map((w) => [w, pick(w)]);
    const missing = chosen.filter(([, o]) => !o).map(([w]) => w);
    if (missing.length) throw new Error(`Option ${q(missing[0])} absente de ${ref}. Options : ${opts.slice(0, 30).map(label).join(", ")}${opts.length > 30 ? "…" : ""}`);
    if (el.disabled) throw new Error(`${ref} est désactivé.`);
    if (el.multiple) {
      const set = new Set(chosen.map(([, o]) => o));
      for (const o of opts) o.selected = set.has(o);
    } else {
      nativeSetValue(el, chosen[0][1].value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    const ok = chosen.every(([, o]) => o.selected);
    if (!ok) throw new Error(`${ref} : la page a rétabli ${q([...el.selectedOptions].map(label).join(", "))} ; essayer avec computer.`);
    return `${ref} = ${q(chosen.map(([, o]) => label(o)).join(", "))}.`;
  }

  // --- Listes personnalisées (role=combobox, aria-haspopup=listbox) ---

  const OPTION_SEL = "[role=option], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]";

  function visibleListboxes() {
    return deepQueryAll("[role=listbox], [role=menu]").filter((b) => isVisible(b) && b.getClientRects().length);
  }

  function ownedIds(el) {
    const nodes = [el, el.querySelector?.("[role=combobox], [aria-controls], [aria-owns]")].filter(Boolean);
    return nodes.flatMap((n) => [n.getAttribute("aria-controls"), n.getAttribute("aria-owns")]).filter(Boolean).join(" ").split(/\s+/).filter(Boolean);
  }

  function listboxFor(el, before) {
    for (const id of ownedIds(el)) {
      const box = byIdDeep(id);
      if (!box) continue;
      const target = box.matches("[role=listbox], [role=menu]") ? box : box.querySelector("[role=listbox], [role=menu]") ?? box;
      if (isVisible(target) && target.getClientRects().length && target.querySelector(OPTION_SEL)) return target;
    }
    const expanded = el.getAttribute("aria-expanded") === "true";
    const boxes = visibleListboxes().filter((b) => b.querySelector(OPTION_SEL) || deepQueryAll(OPTION_SEL, b).length);
    const fresh = boxes.filter((b) => !before.has(b));
    if (fresh.length) return fresh[fresh.length - 1];
    return expanded && boxes.length ? boxes[boxes.length - 1] : null;
  }

  function optionLabel(o) {
    return clean(o.getAttribute("aria-label") || o.innerText || o.textContent, 120);
  }

  function pickOption(options, wanted) {
    const want = fold(wanted).replace(/\s+/g, " ").trim();
    const f = (o) => fold(optionLabel(o)).replace(/\s+/g, " ").trim();
    const exact = options.find((o) => f(o) === want);
    if (exact) return exact;
    const starts = options.filter((o) => f(o).startsWith(want));
    if (want && starts.length === 1) return starts[0];
    const inc = options.filter((o) => f(o).includes(want));
    return want && inc.length === 1 ? inc[0] : null;
  }

  function closeListbox(el, box) {
    try {
      pressKey(box ?? el, "Escape");
      if (box && box !== el) pressKey(el, "Escape");
    } catch {}
  }

  async function pickCustomOption(el, ref, value) {
    const wanted = String(value ?? "");
    if (!wanted.trim()) throw new Error(`${ref} est une liste personnalisée : préciser l'option voulue (texte affiché).`);
    if (el.getAttribute("aria-disabled") === "true" || el.disabled) throw new Error(`${ref} est désactivé.`);
    const before = new Set(visibleListboxes());
    let box = el.getAttribute("aria-expanded") === "true" ? listboxFor(el, new Set()) : null;
    if (!box) {
      pressOn(el);
      box = await waitUntil(() => listboxFor(el, before), 1500);
    }
    if (!box) {
      try { el.focus(); } catch {}
      pressKey(el, "ArrowDown");
      box = await waitUntil(() => listboxFor(el, before), 800);
    }
    if (!box) {
      throw new Error(`${ref} : la liste ne s'est pas ouverte (clic puis flèche bas essayés). Ouvrir avec computer (clic), puis find sur l'option.`);
    }
    const options = () => deepQueryAll(OPTION_SEL, box).filter((o) => isVisible(o));
    let opt = pickOption(options(), wanted);
    if (!opt) {
      // Liste longue à défilement : quelques pas pour faire apparaître l'option.
      for (let i = 0; i < 8 && !opt && box.scrollHeight - box.clientHeight > 10; i++) {
        const prev = box.scrollTop;
        box.scrollTop += Math.max(100, box.clientHeight * 0.9);
        await sleep(120);
        opt = pickOption(options(), wanted);
        if (box.scrollTop === prev) break;
      }
    }
    if (!opt) {
      const shown = options().slice(0, 15).map(optionLabel);
      closeListbox(el, box);
      throw new Error(`Option ${q(wanted)} absente de la liste de ${ref}. Options visibles : ${shown.join(", ") || "(aucune)"}${options().length > 15 ? "…" : ""}.`);
    }
    const label = optionLabel(opt);
    opt.scrollIntoView({ block: "nearest", behavior: "instant" });
    pressOn(opt);
    const want = fold(label).replace(/\s+/g, " ").trim();
    const shownText = () => fold(clean(`${el.innerText || ""} ${"value" in el ? el.value || "" : ""} ${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`, 400));
    const done = await waitUntil(() => shownText().includes(want) || opt.getAttribute("aria-selected") === "true" || opt.getAttribute("aria-checked") === "true", 800);
    if (!done) {
      closeListbox(el, box);
      throw new Error(`${ref} : option « ${label} » cliquée, mais la valeur affichée n'a pas changé. Vérifier avec read_page, sinon passer par computer.`);
    }
    return `${ref} = ${q(label)} (liste personnalisée : option choisie).`;
  }

  /** Champ texte natif qui pilote une liste de suggestions (autocomplétion). */
  async function fillAutocomplete(el, ref, value) {
    const before = new Set(visibleListboxes());
    const msg = await setNativeValue(el, ref, value, { blur: false });
    const box = await waitUntil(() => listboxFor(el, before), 1200);
    if (!box) return msg;
    const options = deepQueryAll(OPTION_SEL, box).filter((o) => isVisible(o));
    const want = fold(String(value ?? "")).replace(/\s+/g, " ").trim();
    const exact = options.find((o) => fold(optionLabel(o)).replace(/\s+/g, " ").trim() === want);
    const hint = `${el.type} ${el.name} ${el.getAttribute("aria-label") || ""} ${el.placeholder || ""}`;
    const isSearch = el.type === "search" || /search|recherch|buscar|suche|cerca/i.test(hint) || !!el.closest("[role=search], form[role=search], search");
    if (exact && !isSearch) {
      pressOn(exact);
      await tick(120);
      return `${ref} = ${q(optionLabel(exact))} (suggestion choisie dans la liste).`;
    }
    return `${msg} (liste de suggestions ouverte : ${options.length} option(s)${exact ? ", dont une identique : la choisir avec computer si nécessaire" : ""} ; find pour en choisir une.)`;
  }

  /**
   * Remplit un champ par sa ref, avec vérification : la valeur relue après les événements (et
   * un blur) dit si la page l'a prise, reformatée ou refusée. value n'est accepté que pour les
   * champs natifs (input, textarea, select), les éditeurs riches, les cases ARIA et les listes
   * personnalisées (role=combobox, aria-haspopup=listbox) ; sinon erreur nette vers computer.
   */
  async function formInput({ ref, value }) {
    let el = elementFor(ref);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    if (el.tagName === "LABEL" && el.control) el = el.control;
    const role = roleOf(el);
    const tag = el.tagName;
    if (tag === "SELECT") return selectNative(el, ref, value);
    if (tag === "INPUT") {
      const t = el.type;
      if (t === "checkbox" || t === "radio") return toggleNative(el, ref, value);
      if (t === "file") throw new Error(`${ref} est un champ de fichier : utiliser file_upload.`);
      if (BUTTON_TYPES.has(t)) throw new Error(`${ref} est un bouton (input type=${t}) : cliquer avec computer, ou le passer en submitRef.`);
      if (t === "hidden") throw new Error(`${ref} est un champ caché : la page le remplit elle-même.`);
      const popup = el.getAttribute("aria-haspopup");
      if (role === "combobox" && el.readOnly) return pickCustomOption(el, ref, value);
      if (role === "combobox" && (el.getAttribute("aria-autocomplete") === "list" || popup === "listbox" || popup === "true")) {
        return fillAutocomplete(el, ref, value);
      }
      return setNativeValue(el, ref, value);
    }
    if (tag === "TEXTAREA") return setNativeValue(el, ref, value);
    if (el.isContentEditable) {
      const wanted = value === null || value === undefined ? "" : String(value);
      const strategy = await fillEditable(el, wanted);
      return `${ref} = ${q(wanted)} (éditeur riche : ${strategy}).`;
    }
    const popup = el.getAttribute("aria-haspopup");
    if (role === "combobox" || popup === "listbox" || ((role === "button" || role === null) && (popup === "menu" || popup === "true"))) {
      return pickCustomOption(el, ref, value);
    }
    if (role === "checkbox" || role === "switch" || role === "radio" || role === "menuitemcheckbox") return toggleAria(el, ref, value, role);
    const fields = el.querySelectorAll?.("input:not([type=hidden]), textarea, select") ?? [];
    if (fields.length === 1) {
      const inner = fields[0];
      const innerRef = refFor(inner);
      const res = await formInput({ ref: innerRef, value });
      return `${res} (champ ${innerRef} contenu dans ${ref})`;
    }
    throw new Error(
      `${ref} (${role ?? tag.toLowerCase()}) n'est pas un champ natif (input, textarea, select) : form_input ne peut pas y poser de valeur. ` +
      "Cliquer puis taper avec computer ; pour une liste personnalisée, viser son déclencheur (role=combobox ou aria-haspopup=listbox).",
    );
  }

  // --- Éditeurs riches ---

  const KNOWN_EDITORS = ".ProseMirror, [data-lexical-editor], [data-slate-editor], .ql-editor, .DraftEditor-root, .public-DraftEditor-content, .notranslate[data-contents]";
  const normText = (s) => String(s ?? "").replace(/[\s ​]+/g, " ").trim();

  /**
   * Remplit un éditeur riche (contenteditable : compositeurs de chat, Notion…) en essayant dans
   * l'ordre : pipeline natif (insertText : beforeinput/input de confiance, accepté par les
   * frameworks contrôlés), puis par paragraphes, puis textContent + événements pour les seuls
   * éditeurs non contrôlés (jamais pour ProseMirror, Lexical, Slate, Quill, Draft : leur état
   * interne divergerait). Vérifié après ~80 ms sur le texte normalisé (innerText) : échec net avec
   * redirection vers computer, jamais de remplissage silencieux faux.
   */
  async function fillEditable(el, wanted) {
    let root = el;
    while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
    if (root.closest(".cm-content, .cm-editor, .monaco-editor, .ace_editor")) {
      throw new Error("Éditeur de code (CodeMirror, Monaco, Ace) : form_input ne peut pas le remplir, écrire avec computer (clic + type).");
    }
    const known = !!(root.closest(KNOWN_EDITORS) || root.querySelector(":scope > [data-contents], :scope > .public-DraftEditor-content"));
    root.focus();
    const sel = getSelection();
    const target = normText(wanted);
    const current = () => normText(root.innerText);
    const ok = () => (target ? current().includes(target) : current() === "");
    const settle = () => sleep(80);
    if (!target) {
      sel.selectAllChildren(root);
      try { document.execCommand("delete", false); } catch {}
      await settle();
      if (ok()) return "effacé";
      if (!known) {
        root.textContent = "";
        fireInput(root, "");
        await settle();
        if (ok()) return "effacé (textContent)";
      }
      throw new Error("Éditeur riche réfractaire : contenu non effacé, effacer avec computer (Ctrl+A puis Suppr).");
    }
    sel.selectAllChildren(root);
    let native = false;
    try { native = document.execCommand("insertText", false, wanted); } catch { native = false; }
    await settle();
    if (native && ok()) return "insertText natif";
    const paragraphs = wanted.split("\n");
    if (paragraphs.length > 1 || wanted.length > 200) {
      root.focus();
      sel.selectAllChildren(root);
      try { document.execCommand("delete", false); } catch {}
      let all = true;
      paragraphs.forEach((para, i) => {
        if (!all) return;
        if (i > 0) {
          try { document.execCommand("insertParagraph", false); } catch {}
        }
        if (!para) return;
        let done = false;
        try { done = document.execCommand("insertText", false, para); } catch { done = false; }
        if (!done) all = false;
      });
      await settle();
      if (all && ok()) return "insertText par paragraphes";
    }
    if (known) {
      throw new Error("Éditeur riche contrôlé (ProseMirror, Lexical, Slate, Quill ou Draft) réfractaire : contenu non pris en compte, écrire avec computer (clic + type).");
    }
    root.textContent = wanted;
    fireInput(root, wanted);
    await settle();
    if (ok()) return "textContent + événements";
    throw new Error("Éditeur riche réfractaire : contenu non pris en compte, écrire avec computer (clic + type).");
  }

  // --- Secrets (credentials_fill) ---

  function hostCovered(host, scope) {
    const h = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
    const s = String(scope ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (!h || !s) return false;
    return h === s || h.endsWith(`.${s}`);
  }

  /**
   * Remplit un champ avec un secret (outil credentials_fill) : la valeur n'est jamais recopiée
   * dans le retour. hosts (domaines du slot) : refus si la frame n'est sur aucun (iframe d'un
   * autre site). use : "login" exige un input text/email/tel, sinon un input type=password.
   * Sans hosts (ancien service worker) : contrôles d'origine seulement. Le champ rempli est
   * mémorisé : sa valeur reste masquée dans read_page, query et demo même si la page change son type.
   */
  function fillSecret({ ref, value, hosts, use } = {}) {
    const el = elementFor(ref);
    const host = location.hostname.toLowerCase().replace(/\.$/, "");
    const strict = Array.isArray(hosts);
    if (strict && !hosts.some((h) => hostCovered(host, h))) {
      throw new Error(`Refusé : ce champ est sur ${host || "(hôte inconnu)"}, hors du périmètre du secret (${hosts.join(", ")}) ; iframe d'un autre site ?`);
    }
    const what = el.tagName === "INPUT" ? `input type=${el.type}` : el.tagName.toLowerCase();
    if (strict) {
      if (use === "login") {
        if (el.tagName !== "INPUT" || !["text", "email", "tel"].includes(el.type)) {
          throw new Error(`${ref} n'est pas un champ d'identifiant (input text, email ou tel attendu, trouvé : ${what}).`);
        }
      } else if (el.tagName !== "INPUT" || el.type !== "password") {
        throw new Error(`${ref} n'est pas un champ de mot de passe (input type=password attendu, trouvé : ${what}) : secret non rempli.`);
      }
    } else if (el.tagName === "SELECT" || el.type === "checkbox" || el.type === "radio" || el.type === "file") {
      throw new Error(`${ref} n'est pas un champ de saisie de secret (réservé aux identifiants / mots de passe).`);
    }
    el.scrollIntoView({ block: "center", behavior: "instant" });
    if (el.isContentEditable && !("value" in el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"))) {
      el.focus();
      el.textContent = String(value);
    } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      el.focus();
      nativeSetValue(el, String(value));
    } else {
      throw new Error(`${ref} n'est pas un champ de formulaire.`);
    }
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (use !== "login") {
      if (!secretFields.has(el)) secretList.push(new WeakRef(el));
      secretFields.add(el);
    }
    if (el.type === "password") wasPassword.add(el);
    return { ok: true, host, field: use === "login" ? "identifiant" : "secret" };
  }

  /** Un secret rempli par fillSecret est-il encore lisible dans la page (champ présent, non vide) ? */
  function hasLiveSecret() {
    for (let i = secretList.length - 1; i >= 0; i--) {
      const el = secretList[i].deref();
      if (!el) {
        secretList.splice(i, 1);
        continue;
      }
      if (!el.isConnected) continue;
      const v = el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.value : el.textContent;
      if (v) return true;
    }
    return false;
  }

  /** Pose un attribut temporaire pour retrouver l'élément depuis le monde principal (CDP). */
  function markRef(ref) {
    elementFor(ref).setAttribute("data-abc-target", ref);
    return `[data-abc-target="${ref}"]`;
  }

  /**
   * Enregistre comme ref un élément marqué depuis le monde principal (outil javascript :
   * un Element ou une liste d'Elements renvoyée par le script devient utilisable par les
   * autres outils). Le marquage est retiré aussitôt. Même ligne que read_page.
   */
  function refForKey({ key }) {
    const el = deepQueryAll(`[data-abc-js="${CSS.escape(String(key))}"]`)[0];
    if (!el) throw new Error("Élément marqué introuvable (retiré du DOM entre-temps ?).");
    el.removeAttribute("data-abc-js");
    const role = roleOf(el) ?? "élément";
    return describe(el, role);
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
    for (const el of deepQueryAll("img, canvas, svg")) {
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

  /** La plus grande image (ou canvas) visible à l'écran, au moins 80 px de côté. */
  function largestImage() {
    let best = null;
    let bestArea = 0;
    for (const el of deepQueryAll("img, canvas, svg")) {
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

  const CONSENT_RE = /cookie|consentement|traceur|rgpd|gdpr|vie privee|privacy|donnees personnelles|datenschutz|privacidad/;
  // Boutons typiques d'une bannière de consentement (texte replié sans accents).
  const CONSENT_BTN_RE = /accept|autoris|allow|agree|consent|refus|reject|decline|deny|parametr|personnalis|gerer|manage|preferenc|continuer sans|non merci|^ok\b|compris|d'accord|got it|akzeptier|ablehn|aceptar|rechaz|rifiut|accett|einstellung/;
  // Refus, du plus explicite au plus vague (texte replié sans accents).
  const REFUSE_PATTERNS = [
    /tout refuser|refuser tout|reject all|alle ablehnen|rechazar todo|rifiuta tutto/,
    /continuer sans accepter|continue without accepting|sans accepter/,
    /^refuser\b|^je refuse|^reject\b|^decline\b|^deny\b|^ablehnen|^rechazar|^rifiuta/,
    /nur notwendige|only necessary|necessary only|essential only|strictly necessary|uniquement (les )?(cookies )?(necessaires|essentiels)|necessaires uniquement/,
    /refuser|reject|decline|non merci|no thanks/,
  ];
  const CMP_RE = /cookie|consent|privacy|didomi|onetrust|axeptio|tarteaucitron|tc-privacy|cmp|gdpr|rgpd|sp_message|qc-cmp|usercentrics|cybotcookiebot|trustarc|truste/i;
  const KNOWN_CMP = [
    ["didomi", "#didomi-host, #didomi-popup, .didomi-popup-container", "window.Didomi && Didomi.setUserDisagreeToAll()"],
    ["onetrust", "#onetrust-consent-sdk, #onetrust-banner-sdk", "window.OneTrust && OneTrust.RejectAll()"],
    ["cookiebot", "#CybotCookiebotDialog", "window.Cookiebot && Cookiebot.submitCustomConsent(false, false, false)"],
    ["tarteaucitron", "#tarteaucitronRoot", "window.tarteaucitron && tarteaucitron.userInterface.respondAll(false)"],
    ["usercentrics", "#usercentrics-root, #usercentrics-cmp-ui", "window.UC_UI && UC_UI.denyAllConsents().then(() => UC_UI.closeCMP())"],
    ["axeptio", "#axeptio_overlay, .axeptio_widget", null],
    ["quantcast", ".qc-cmp2-container", null],
    ["sourcepoint", "[id^=sp_message_container]", null],
    ["trustarc", "#truste-consent-track, .truste_box_overlay, #consent_blackbar", null],
  ];

  /** elementFromPoint qui traverse les shadow DOM (ouverts et fermés). */
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el) {
      const sr = shadowOf(el);
      if (!sr) break;
      const inner = sr.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  /** Le plus haut conteneur fixe / modal au-dessus d'un élément (en sortant des shadow DOM). */
  function coveringAncestor(el) {
    let found = null;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement || n.getRootNode().host) {
      const st = style(n);
      if (st.position === "fixed" || st.position === "sticky" || n.getAttribute("aria-modal") === "true" ||
          n.getAttribute("role") === "dialog" || n.tagName === "DIALOG") found = n;
    }
    return found;
  }

  const BUTTON_LIKE = "button, a[href], [role=button], input[type=button], input[type=submit]";
  const buttonLabel = (b) => clean(b.innerText || b.value || b.getAttribute("aria-label") || b.getAttribute("title") || "", 50);
  const buttonsIn = (root) => deepQueryAll(BUTTON_LIKE, root.shadowRoot ?? root).concat(root.matches?.(BUTTON_LIKE) ? [root] : []);

  /** Bandeau de navigation (header, nav, footer, rôles banner/navigation/contentinfo) : jamais une bannière de cookies. */
  function isLandmarkBar(el) {
    if (["HEADER", "NAV", "FOOTER"].includes(el.tagName)) return true;
    return ["banner", "navigation", "contentinfo"].includes(el.getAttribute("role") || "");
  }

  /** Bannière de consentement : motif dans le titre ou les 400 premiers caractères ET bouton accepter / refuser / paramétrer. */
  function looksLikeConsent(root, scope, text) {
    if (isLandmarkBar(root)) return false;
    const heading = scope.querySelector?.("h1, h2, h3, h4, [role=heading]")?.innerText || root.getAttribute("aria-label") || "";
    const marked = CONSENT_RE.test(fold(heading)) || CONSENT_RE.test(fold(text.slice(0, 400))) ||
      KNOWN_CMP.some(([, sel]) => root.matches?.(sel) || !!root.closest?.(sel));
    if (!marked) return false;
    return buttonsIn(root).some((b) => isVisible(b) && CONSENT_BTN_RE.test(fold(buttonLabel(b))));
  }

  /** Le conteneur qui porte vraiment la fenêtre (texte + boutons), quand le calque trouvé n'est qu'un fond. */
  function overlayContent() {
    const candidates = [
      ...deepQueryAll("[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]"),
      ...[...document.querySelectorAll("body [id], body [class]")].filter((el) => CMP_RE.test(`${el.id} ${typeof el.className === "string" ? el.className : ""}`)),
    ];
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      if (!isVisible(el) || !inViewport(el)) continue;
      const scope = el.shadowRoot ?? el;
      const buttons = scope.querySelectorAll(BUTTON_LIKE).length;
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

  /** Panneau d'écriture (compositeur de chat IA…), pas une fenêtre bloquante : champ riche, sans champ de compte. */
  function isComposer(scope) {
    if (scope.querySelector("input[type=password], input[type=email]")) return false;
    return !!scope.querySelector("textarea, [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only'], [role=textbox]");
  }

  /** Fenêtre qui recouvre la page : { root, scope, cover, consent } ou null. */
  function findOverlay() {
    const W = innerWidth;
    const H = innerHeight;
    const points = [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7], [0.5, 0.93], [0.5, 0.07]];
    const roots = new Map(); // conteneur -> nombre de points d'échantillonnage où il est au premier plan
    // innerText force une mise en page et peut couvrir toute l'application (Discord) : une seule lecture par conteneur.
    const texts = new Map();
    const fullText = (root, scope) => {
      if (!texts.has(root)) texts.set(root, root.innerText || scope.textContent || "");
      return texts.get(root);
    };
    for (const [px, py] of points) {
      const el = deepElementFromPoint(W * px, H * py);
      const root = el && !el.closest?.("#abc-overlay") && coveringAncestor(el);
      if (root) roots.set(root, (roots.get(root) ?? 0) + 1);
    }
    let best = null;
    for (const [root, hits] of roots) {
      const r = root.getBoundingClientRect();
      const visibleArea = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0));
      const cover = Math.min(1, visibleArea / (W * H));
      const scope = root.shadowRoot ?? root;
      const text = fullText(root, scope).slice(0, 3000);
      const consent = looksLikeConsent(root, scope, text);
      const explicitModal = root.getAttribute("aria-modal") === "true" || root.tagName === "DIALOG";
      const modal = explicitModal || cover >= 0.5;
      // Les en-têtes et barres de navigation fixes ne gênent pas : on ne garde que les fenêtres qui recouvrent.
      if (!consent && !modal) continue;
      if (!consent && !explicitModal && isComposer(scope)) continue;
      // Toile de fond fixe (canvas décoratif) que le contenu recouvre presque partout : elle n'est au
      // premier plan que dans les marges, elle n'intercepte pas les clics sur la page.
      if (!consent && !explicitModal && hits < 3 && !scope.querySelector?.(BUTTON_LIKE) && fullText(root, scope).trim().length < 20) continue;
      const score = (consent ? 2 : 0) + cover;
      if (!best || score > best.score) best = { root, scope, cover, consent, score };
    }
    if (!best) return null;
    let { root, scope } = best;
    // Fond vide d'un menu ouvert (attrape-clic plein écran, ex. Figaro) : pas bloquant.
    // Un vrai modal a du texte ou des boutons ; une bannière consentement a du texte.
    if (!best.consent && fullText(root, scope).trim().length < 20 &&
        !scope.querySelector(BUTTON_LIKE) &&
        deepQueryAll("[aria-expanded='true']").some((el) => isVisible(el))) return null;
    if (fullText(root, scope).trim().length < 20) {
      const content = overlayContent();
      if (content) {
        root = content;
        scope = content.shadowRoot ?? content;
      }
    }
    return { root, scope, cover: best.cover, consent: best.consent };
  }

  function blockingOverlay() {
    const found = findOverlay();
    if (!found) return null;
    const { root, scope } = found;
    const heading = scope.querySelector("h1, h2, h3, [role=heading]")?.innerText;
    const title = clean(heading || root.getAttribute("aria-label") || root.innerText || scope.textContent, 90);
    const buttons = buttonsIn(root)
      .filter((b) => isVisible(b) && buttonLabel(b))
      .slice(0, 8)
      .map((b) => ({ name: buttonLabel(b), ref: refFor(b) }));
    return {
      consent: found.consent,
      cover: Math.round(found.cover * 100),
      title,
      buttons,
      inIframe: !buttons.length && !!scope.querySelector("iframe"),
    };
  }

  /** Bannière de consentement de cette frame : fenêtre qui recouvre, CMP connu, ou (dans une iframe de CMP) le document entier. */
  function consentBanner() {
    const ov = findOverlay();
    if (ov?.consent) return { root: ov.root, how: "overlay" };
    for (const [name, sel] of KNOWN_CMP) {
      for (const el of deepQueryAll(sel)) {
        if (isVisible(el) && el.getClientRects().length && (el.innerText || "").trim().length >= 20) return { root: el, cmp: name };
      }
    }
    if (window !== top && document.body) {
      const text = (document.body.innerText || "").slice(0, 2000);
      if (CONSENT_RE.test(fold(text)) && buttonsIn(document.body).some((b) => isVisible(b) && CONSENT_BTN_RE.test(fold(buttonLabel(b))))) {
        return { root: document.body, frame: true };
      }
    }
    return null;
  }

  function refuseButton(root) {
    let best = null;
    let bestRank = Infinity;
    for (const b of buttonsIn(root)) {
      if (!isVisible(b)) continue;
      const label = fold(buttonLabel(b));
      if (!label || (/accept/.test(label) && !/sans accepter|without accepting/.test(label))) continue;
      const rank = REFUSE_PATTERNS.findIndex((re) => re.test(label));
      if (rank >= 0 && rank < bestRank) {
        best = b;
        bestRank = rank;
      }
    }
    return best;
  }

  function stillShown(el) {
    return el.isConnected && isVisible(el) && el.getClientRects().length > 0 && (el === document.body || el.getBoundingClientRect().height > 2);
  }

  function detectCmp() {
    for (const [name, sel, call] of KNOWN_CMP) if (deepQueryAll(sel).length) return { name, call };
    return null;
  }

  /**
   * Ferme la bannière de consentement en refusant les cookies non essentiels : clic sur le bouton
   * de refus le plus explicite (« Tout refuser », « Continuer sans accepter »…), vérification de
   * la disparition, une seconde passe si un panneau de réglages a pris la place. Marche aussi
   * appelée dans l'iframe d'une CMP (Sourcepoint, TrustArc). Les API des CMP (Didomi, OneTrust…)
   * vivent dans le monde principal : renvoyées dans mainWorld pour que l'extension les exécute.
   */
  async function dismissConsent() {
    const frame = window !== top;
    const banner = consentBanner();
    if (!banner) return { found: false, dismissed: false, how: "aucune bannière de consentement détectée", remaining: false, frame };
    let root = banner.root;
    const clicked = [];
    for (let round = 0; round < 2; round++) {
      const btn = refuseButton(root);
      if (!btn) break;
      const label = buttonLabel(btn);
      clicked.push(label);
      btn.scrollIntoView?.({ block: "nearest", behavior: "instant" });
      pressOn(btn);
      const gone = await waitUntil(() => {
        newPass();
        return !stillShown(root) || (root === document.body && !refuseButton(root));
      }, 2000);
      if (gone) {
        const next = consentBanner();
        if (!next) return { found: true, dismissed: true, how: `clic sur « ${clicked.join(" » puis « ")} »`, remaining: false, frame };
        root = next.root; // second panneau (réglages) : une passe de plus
        continue;
      }
    }
    newPass();
    const left = consentBanner();
    const cmp = detectCmp();
    const how = clicked.length
      ? `clic sur « ${clicked.join(" » puis « ")} » sans fermer la bannière`
      : "aucun bouton de refus trouvé dans la bannière";
    const buttons = left ? buttonsIn(left.root).filter((b) => isVisible(b) && buttonLabel(b)).slice(0, 8).map((b) => `${buttonLabel(b)} [${refFor(b)}]`) : [];
    return {
      found: true, dismissed: !left, how, remaining: !!left, frame,
      ...(cmp ? { cmp: cmp.name } : {}),
      ...(cmp?.call ? { mainWorld: cmp.call } : {}),
      ...(buttons.length ? { buttons } : {}),
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

  /** Clic sur le lien visible vers `path` (même origine) : le routeur SPA intercepte, comme un utilisateur. */
  function spaLinkClick({ path }) {
    const norm = (href) => {
      try {
        const u = new URL(href, location.href);
        return u.origin === location.origin ? u.pathname + u.search + u.hash : null;
      } catch {
        return null;
      }
    };
    const hit = deepQueryAll("a[href]").find((a) => !a.closest("#abc-overlay") && isVisible(a) && norm(a.getAttribute("href")) === path);
    if (!hit) return { clicked: null };
    hit.click();
    return { clicked: clean(hit.innerText ?? "", 80) || "(sans texte)" };
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

  /**
   * Survol par événements (complément du survol souris réel) : les menus pilotés
   * en JS (mouseenter, ex. méga-menus eBay) s'ouvrent même en onglet masqué, où
   * le :hover CSS ne tient pas. Sans effet sur les menus purement CSS.
   */
  function hoverEvents({ x, y }) {
    const el = typeof x === "number" ? deepElementFromPoint(x, y) : null;
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, composed: true }));
    for (let n = el; n && n !== document; n = composedParent(n)) {
      if (n.nodeType === 1) n.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: true }));
    }
    return true;
  }

  // --- Enregistreur de démonstration (outil demo) : clics, saisies, sélections. ---
  let recording = null; // { steps: [], truncated: bool, typeWatch } ou null
  const DEMO_MAX_STEPS = 200;
  const SECRET_TOKENS = new Set(["pwd", "pass", "passwd", "password", "passcode", "passphrase", "mdp", "motdepasse", "secret", "otp", "totp", "pin", "cvc", "cvv", "csc", "mfa", "2fa"]);
  const SECRET_HINT_RE = /password|passwort|mot.?de.?passe|one.?time|security.?code|verification.?code|code.?de.?v[eé]rification|code.?secret/i;

  /** Champ à traiter comme secret dans une démo : mot de passe (même passé en text), code, PIN, carte. */
  function demoSecret(el) {
    if (isSensitiveField(el)) return true;
    if (el.tagName !== "INPUT") return false;
    const hint = `${el.getAttribute("autocomplete") || ""} ${el.name || ""} ${el.id || ""}`;
    if (SECRET_HINT_RE.test(hint)) return true;
    const tokens = hint.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return tokens.some((t) => SECRET_TOKENS.has(t));
  }

  /** Sélecteur robuste : id, test-id, rôle+nom, sinon chemin tag (4 niveaux max). */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return `#${CSS.escape(el.id)}`;
    const testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-abc-target");
    if (testId) return `[data-testid="${testId}"]`;
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur !== document.body && depth < 4; depth++) {
      const tag = cur.tagName.toLowerCase();
      const sibs = [...(cur.parentElement?.children ?? [])].filter((c) => c.tagName === cur.tagName);
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(cur) + 1})` : tag);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function demoPush(step) {
    if (!recording || recording.steps.length >= DEMO_MAX_STEPS) {
      if (recording) recording.truncated = true;
      return;
    }
    recording.steps.push({ t: Date.now(), ...step });
  }

  function recClick(e) {
    const t = e.composedPath?.()[0] instanceof Element ? e.composedPath()[0] : e.target;
    if (!(t instanceof Element) || t.closest("#abc-overlay")) return;
    const el = t.closest("a,button,input,select,textarea,[role=button],[onclick],[tabindex]") ?? (t === document.body ? null : t);
    if (!el) return;
    newPass();
    const role = roleOf(el) ?? el.tagName.toLowerCase();
    demoPush({
      kind: "click",
      role,
      name: demoSecret(el) ? "" : clean(nameOf(el, role) || el.innerText || "", 80),
      selector: cssPath(el),
      href: el.tagName === "A" ? (el.getAttribute("href") || "").slice(0, 200) : undefined,
    });
  }

  function recInput(e) {
    const t = e.composedPath?.()[0];
    const el = t instanceof Element ? t : e.target;
    if (!(el instanceof Element) || el.closest("#abc-overlay")) return;
    const editable = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable;
    if (!editable) return;
    const selector = cssPath(el);
    const last = recording.steps[recording.steps.length - 1];
    if (demoSecret(el)) {
      if (el.type === "password") wasPassword.add(el);
      // Frappes masquées successives dans le même champ : une seule étape.
      if (last && last.kind === "type" && last.masked && last.selector === selector) return;
      demoPush({ kind: "type", selector, masked: true });
      return;
    }
    const value = el.isContentEditable ? (el.innerText ?? "") : (el.value ?? "");
    // Frappe = rafale d'événements : on fusionne dans la dernière étape du même champ.
    if (last && last.kind === "type" && last.selector === selector && !last.masked) last.value = String(value).slice(0, 2000);
    else demoPush({ kind: "type", selector, value: String(value).slice(0, 2000) });
  }

  function recChange(e) {
    const el = e.target;
    if (!(el instanceof Element) || el.closest("#abc-overlay")) return;
    if (el instanceof HTMLSelectElement) {
      demoPush({ kind: "select", selector: cssPath(el), value: el.value.slice(0, 200) });
    } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      demoPush({ kind: "check", selector: cssPath(el), checked: el.checked });
    }
  }

  function startRecord() {
    if (recording) throw new Error("Enregistrement déjà en cours dans cet onglet.");
    // Champs mot de passe existants, et ceux qu'un bouton « afficher » passerait en texte.
    for (const f of deepQueryAll("input[type=password]")) wasPassword.add(f);
    const typeWatch = new MutationObserver((records) => {
      for (const r of records) {
        if (r.attributeName === "type" && /^password$/i.test(r.oldValue || "")) wasPassword.add(r.target);
        if (r.attributeName === "type" && r.target.type === "password") wasPassword.add(r.target);
      }
    });
    try {
      typeWatch.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["type"], attributeOldValue: true });
    } catch {}
    recording = { steps: [], truncated: false, typeWatch };
    document.addEventListener("click", recClick, true);
    document.addEventListener("input", recInput, true);
    document.addEventListener("change", recChange, true);
    return "Enregistrement démarré : montrez le parcours (clics, saisies hors mots de passe, sélections, navigations), puis demo stop.";
  }

  function stopRecord() {
    if (!recording) throw new Error("Aucun enregistrement en cours (demo start d'abord, sans navigation complète entre-temps).");
    document.removeEventListener("click", recClick, true);
    document.removeEventListener("input", recInput, true);
    document.removeEventListener("change", recChange, true);
    try { recording.typeWatch?.disconnect(); } catch {}
    const out = { steps: recording.steps, truncated: recording.truncated };
    recording = null;
    return out;
  }

  const api = {
    readPage, locate, hitTest, pageText, find, scrollExtract, canPaint, query, tables, pageDigest, fetchJson, formInput,
    hoverEvents, fillSecret, hasLiveSecret, listImages, usableImage, markRef, refForKey, isFileInput, overlay, hideOverlay,
    needsRender, imageData, blockingOverlay, dismissConsent, gestureStart, gestureEnd, linkHref, clickRef, spaLinkClick,
    refMarks, showRefMarks, hideRefMarks, startRecord, stopRecord,
  };
  // Chaque appel venu de l'extension ouvre une passe neuve (caches de styles et de contextes).
  // Le service worker passe null quand il n'a pas d'argument : ramené à undefined pour les valeurs par défaut.
  globalThis.__abc = Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, (arg) => {
    newPass();
    return fn(arg ?? undefined);
  }]));
})();
