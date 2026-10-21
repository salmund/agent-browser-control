// Agent Browser Control, service worker : repli quand le navigateur refuse le debugger.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Sans debugger : ce que cdp() peut rejouer par chrome.scripting
// ---------------------------------------------------------------------------
//
// Depuis Chrome 155, chrome.debugger.attach est refusé sur tous les onglets (« Host access is restricted by
// policy. ») dès que l'extension a une liste runtime_blocked_hosts non vide : Comet en impose une à toutes les
// extensions, codée en dur (sites de Perplexity). Le refus vaut pour tout le navigateur : cdp.js le retient, et cdp()
// passe par ici. Ce qui se rejoue : évaluation dans le monde de la page, souris et clavier par événements de page
// (isTrusted vaut false : certains sites les ignorent), saisie de texte, capture de l'onglet affiché. Le reste
// (réseau, console, émulation, boîtes de dialogue, envoi de fichier) échoue avec la cause et le remède.
// Remède durable : stratégie ExtensionSettings qui donne à l'extension une liste vide (une entrée par identifiant
// remplace celle de tout le monde) ; vérifié sur Comet 155. Jusqu'à Chrome 160 : l'option DEBUGGER_FLAG.

const DEBUGGER_FLAG = "--disable-features=ExtensionDebuggerStrictPolicyRestrictions";
/** Remède à donner à l'agent et à l'utilisateur, avec l'identifiant de cette extension. */
const debuggerRemedy = () =>
  `Remède durable : stratégie ExtensionSettings {"${chrome.runtime.id}": {"runtime_blocked_hosts": []}} ` +
  "(Comet : HKCU\\Software\\Policies\\Perplexity\\Comet, voir le README), puis redémarrer le navigateur ; " +
  `ou, jusqu'à Chrome 160, lancer le navigateur avec ${DEBUGGER_FLAG}.`;
const DEBUGGER_RETRY_MS = 60_000; // refus constaté : nouvel essai d'attachement au plus une fois par minute
const DEBUGGERLESS_NOTE_MS = 10 * 60_000; // avertissement à l'agent : une fois par onglet et par 10 min

let debuggerBlock = null; // { since, message } tant que le navigateur refuse le debugger
const debuggerlessUsed = new Set(); // onglets où un repli a servi depuis la dernière réponse d'outil
const debuggerlessToldAt = new Map(); // tabId -> dernier avertissement donné à l'agent

chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerlessUsed.delete(tabId);
  debuggerlessToldAt.delete(tabId);
});

class DebuggerBlockedError extends Error {}

const isPolicyRefusal = (err) => /restricted by policy/i.test(String(err?.message ?? err));

/** Refus récent : inutile de retenter l'attachement. */
const debuggerBlockFresh = () => !!debuggerBlock && Date.now() - debuggerBlock.since < DEBUGGER_RETRY_MS;

function debuggerBlockedError(method) {
  return new DebuggerBlockedError(
    `${method ? `${method} indisponible : ` : ""}le navigateur refuse le debugger à ABC ` +
    `(« ${debuggerBlock?.message ?? "restricted by policy"} » : sites bloqués pour les extensions, règle de Chrome 155 et plus). ` +
    debuggerRemedy(),
  );
}

/** Refus par stratégie : retenu pour tout le navigateur, signalé au démon (/health : debuggerBlocked). */
function noteDebuggerBlocked(err) {
  const first = !debuggerBlock;
  debuggerBlock = { since: Date.now(), message: String(err?.message ?? err).slice(0, 200) };
  if (first) sendSettings().catch(() => {});
}

function noteDebuggerUsable() {
  if (!debuggerBlock) return;
  debuggerBlock = null;
  sendSettings().catch(() => {});
}

/** Avertissement joint à la réponse d'un outil qui a agi sans debugger (une fois par onglet et par 10 min). */
function debuggerlessNote(tabId) {
  if (!debuggerlessUsed.delete(tabId)) return "";
  if (Date.now() - (debuggerlessToldAt.get(tabId) ?? 0) < DEBUGGERLESS_NOTE_MS) return "";
  debuggerlessToldAt.set(tabId, Date.now());
  return "ℹ Le navigateur refuse le debugger à ABC (sites bloqués pour les extensions, Chrome 155 et plus) : gestes " +
    "rejoués par événements de page, que certains sites ignorent, et ni réseau ni console observés. Vérifier l'effet. " +
    debuggerRemedy();
}

/** Exécute func(...args) dans la frame principale de l'onglet : monde de la page ("MAIN") ou monde isolé d'ABC. */
async function runInTab(tabId, func, args = [], world = "ISOLATED", timeoutMs = 60_000) {
  assertRunning(tabId);
  const [res] = await withTimeout(chrome.scripting.executeScript({ target: { tabId }, world, func, args }), timeoutMs, "Script de page");
  if (res?.error) throw new Error(String(res.error?.message ?? res.error));
  return res?.result;
}

/** Commandes CDP rejouées sans debugger : même forme de réponse que Chrome, pour les appelants de cdp(). */
const DEBUGGERLESS = {
  "Runtime.evaluate": evaluateWithoutDebugger,
  "Runtime.releaseObject": async () => ({}),
  "Input.dispatchMouseEvent": (tabId, p) => gestureWithoutDebugger(tabId, mouseEventInPage, p),
  "Input.dispatchKeyEvent": (tabId, p) => gestureWithoutDebugger(tabId, keyEventInPage, p),
  "Input.insertText": (tabId, p) => gestureWithoutDebugger(tabId, insertTextInPage, p.text ?? ""),
  "Page.captureScreenshot": captureWithoutDebugger,
};

async function cdpWithoutDebugger(tabId, method, params) {
  const replay = DEBUGGERLESS[method];
  if (!replay) throw debuggerBlockedError(method);
  debuggerlessUsed.add(tabId);
  return replay(tabId, params ?? {});
}

async function gestureWithoutDebugger(tabId, func, arg) {
  const res = await runInTab(tabId, func, [arg], "ISOLATED", 65_000);
  if (res && res.ok === false) throw new Error(`Geste impossible : ${res.reason}, et ${debuggerBlockedError().message}`);
  return {};
}

async function evaluateWithoutDebugger(tabId, { expression, awaitPromise = false, returnByValue = false }) {
  const out = await runInTab(tabId, evalInPage, [String(expression), !!awaitPromise, !returnByValue], "MAIN", awaitPromise ? 120_000 : 60_000);
  if (!out?.exception) return { result: out?.result ?? { type: "undefined" } };
  const description = out.exception.csp
    ? `Rien n'a été exécuté : la page interdit l'évaluation de code texte (CSP) et ${debuggerBlockedError().message}`
    : out.exception.description;
  return {
    result: { type: "object", subtype: "error", description },
    exceptionDetails: { text: "Uncaught", exception: { type: "object", subtype: "error", description } },
  };
}

/** captureVisibleTab ne voit que l'onglet affiché : un onglet de fond repasse par le premier plan (captureShot). */
async function captureWithoutDebugger(tabId, { format = "png", quality }) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new CaptureTimeout();
  try {
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, format === "jpeg" ? { format, quality: quality ?? 90 } : { format });
    return { data: url.slice(url.indexOf(",") + 1) };
  } catch (err) {
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (win?.state !== "minimized") throw err;
    throw new Error("Capture impossible : la fenêtre du navigateur est réduite, et sans debugger seul ce qui est affiché à l'écran " +
      "se capture. La restaurer, ou lire la page en texte (read_page, get_page_text).");
  }
}

// ---------------------------------------------------------------------------
// Fonctions de page : sérialisées avec toString(), ne rien y référencer hors d'elles-mêmes
// ---------------------------------------------------------------------------

/**
 * Monde de la page : évalue une expression texte comme Runtime.evaluate. Valeur rendue en JSON ; un Element (ou une
 * liste d'Elements) est marqué comme le fait serializeNodesAsRefs (javascript.js), pour devenir des refs.
 * Une CSP sans 'unsafe-eval' interdit eval ici : signalé (csp), rien n'est exécuté.
 */
async function evalInPage(source, awaitPromise, markNodes) {
  const run = async (src) => {
    let value = (0, eval)(src);
    if (awaitPromise && value && typeof value.then === "function") value = await value;
    return value;
  };
  let value;
  try {
    try {
      value = await run(source);
    } catch (e) {
      // await de premier niveau (accepté par le mode REPL de Runtime.evaluate) : rejoué dans une fonction async.
      if (!(e instanceof SyntaxError) || !/await is only valid/.test(e.message)) throw e;
      value = await run(`(async () => {\n${source}\n})()`);
    }
  } catch (e) {
    const csp = e instanceof EvalError || /unsafe-eval|TrustedScript/.test(String(e?.message));
    return { exception: { csp, description: e && e.stack ? String(e.stack) : String(e) } };
  }
  const type = typeof value;
  if (value === undefined) return { result: { type: "undefined" } };
  if (value === null) return { result: { type: "object", subtype: "null", value: null } };
  if (type === "function") return { result: { type, description: String(value).slice(0, 300) } };
  if (type === "object" && typeof value.then === "function") return { result: { type, subtype: "promise", description: "Promise" } };
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).join(".")}` : "");
  const isEl = (x) => x instanceof Element;
  const many = Array.isArray(value) || value instanceof NodeList || value instanceof HTMLCollection;
  const els = isEl(value) ? [value] : many && value.length && [...value].every(isEl) ? [...value] : null;
  if (els && markNodes) {
    const stamp = Date.now().toString(36);
    const keys = els.slice(0, 20).map((e, i) => {
      const k = "abc" + stamp + "n" + i;
      e.setAttribute("data-abc-js", k);
      return k;
    });
    return { result: { type, subtype: "node", description: describe(els[0]), abcMarked: { total: els.length, keys } } };
  }
  if (value instanceof Node) return { result: { type, subtype: "node", description: isEl(value) ? describe(value) : value.nodeName } };
  try {
    const json = JSON.stringify(value);
    return { result: { type, value: json === undefined ? null : JSON.parse(json) } };
  } catch {
    return { result: { type, description: String(value).slice(0, 1000) } }; // références circulaires…
  }
}

/** Monde isolé : rejoue un Input.dispatchMouseEvent par événements de page, sur l'élément sous le point. */
function mouseEventInPage(p) {
  let doc = document;
  let x = p.x;
  let y = p.y;
  let el = null;
  for (let depth = 0; depth < 6; depth++) {
    el = doc.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (!el || (el.tagName !== "IFRAME" && el.tagName !== "FRAME")) break;
    let inner = null;
    try {
      inner = el.contentDocument;
    } catch {}
    if (!inner) return { ok: false, reason: "le point tombe dans une iframe d'une autre origine (viser l'élément par sa ref)" };
    const r = el.getBoundingClientRect();
    x -= r.left + el.clientLeft;
    y -= r.top + el.clientTop;
    doc = inner;
  }
  if (!el) return { ok: false, reason: `aucun élément au point (${p.x}, ${p.y})` };
  const view = doc.defaultView;
  const state = globalThis.__abcMouse || (globalThis.__abcMouse = { down: null, over: null });
  const button = { left: 0, middle: 1, right: 2, back: 3, forward: 4 }[p.button] ?? 0;
  const m = p.modifiers | 0;
  const base = {
    bubbles: true, cancelable: true, composed: true, view, clientX: x, clientY: y, screenX: x, screenY: y,
    button, buttons: p.buttons ?? 0, detail: p.clickCount || 0,
    altKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4), shiftKey: !!(m & 8),
  };
  const pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true };
  const fire = (target, Ctor, type, extra = {}) => target.dispatchEvent(new Ctor(type, { ...base, ...extra }));
  if (p.type === "mouseMoved") {
    if (state.over !== el) {
      if (state.over && state.over.isConnected) {
        fire(state.over, PointerEvent, "pointerout", pointer);
        fire(state.over, MouseEvent, "mouseout");
      }
      fire(el, PointerEvent, "pointerover", pointer);
      fire(el, MouseEvent, "mouseover");
      state.over = el;
    }
    fire(el, PointerEvent, "pointermove", pointer);
    fire(el, MouseEvent, "mousemove");
  } else if (p.type === "mousePressed") {
    const buttons = { 0: 1, 1: 4, 2: 2 }[button] ?? 1;
    fire(el, PointerEvent, "pointerdown", { ...pointer, buttons });
    if (fire(el, MouseEvent, "mousedown", { buttons })) {
      const focusable = el.closest('a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]');
      if (focusable) {
        try { focusable.focus({ preventScroll: true }); } catch {}
      } else if (doc.activeElement && doc.activeElement !== doc.body) {
        doc.activeElement.blur();
      }
    }
    state.down = el;
  } else if (p.type === "mouseReleased") {
    fire(el, PointerEvent, "pointerup", pointer);
    fire(el, MouseEvent, "mouseup");
    const down = state.down && state.down.isConnected ? state.down : el;
    state.down = null;
    let target = el;
    while (target && !target.contains(down)) target = target.parentElement;
    target = target || el;
    // Différé : une boîte alert/confirm ouverte par le clic bloquerait la page, et cette réponse avec elle.
    setTimeout(() => {
      if (button === 0) {
        fire(target, MouseEvent, "click");
        if (p.clickCount === 2) fire(target, MouseEvent, "dblclick");
      } else if (button === 2) {
        fire(target, MouseEvent, "contextmenu");
      } else {
        fire(target, PointerEvent, "auxclick", pointer);
      }
    }, 0);
  } else if (p.type === "mouseWheel") {
    const dx = p.deltaX || 0;
    const dy = p.deltaY || 0;
    if (fire(el, WheelEvent, "wheel", { deltaX: dx, deltaY: dy, deltaMode: 0 })) {
      const scrolls = (n) => {
        const cs = getComputedStyle(n);
        const can = (o) => o === "auto" || o === "scroll" || o === "overlay";
        return (dy && n.scrollHeight > n.clientHeight + 1 && can(cs.overflowY)) || (dx && n.scrollWidth > n.clientWidth + 1 && can(cs.overflowX));
      };
      let box = el;
      while (box && box !== doc.body && box !== doc.documentElement && !scrolls(box)) box = box.parentElement || box.getRootNode().host || null;
      if (box && box !== doc.body && box !== doc.documentElement) box.scrollBy({ left: dx, top: dy, behavior: "instant" });
      else view.scrollBy({ left: dx, top: dy, behavior: "instant" });
    }
  }
  return { ok: true };
}

/** Monde isolé : rejoue Input.insertText dans le champ actif (execCommand, sinon valeur + événement input). */
function insertTextInPage(text) {
  // Élément qui a le focus, en traversant les shadow roots ouverts et les iframes de même origine.
  let el = document.activeElement;
  for (let i = 0; i < 20 && el; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    } else if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      let doc = null;
      try {
        doc = el.contentDocument;
      } catch {}
      if (!doc) return { ok: false, reason: "le champ actif est dans une iframe d'une autre origine (form_input sur sa ref)" };
      el = doc.activeElement;
    } else {
      break;
    }
  }
  if (!el) return { ok: true };
  const field = /^(INPUT|TEXTAREA)$/.test(el.tagName);
  if (!field && !el.isContentEditable) return { ok: true }; // sans champ, Chrome n'écrit rien non plus
  let done = false;
  try {
    done = el.ownerDocument.execCommand("insertText", false, text);
  } catch {}
  if (done) return { ok: true };
  if (!field) return { ok: false, reason: "le champ actif refuse la saisie" };
  // Monde isolé : le setter natif contourne le suivi de valeur des frameworks (React), qui verront le changement.
  let start = el.value.length;
  let end = start;
  try {
    start = el.selectionStart ?? start;
    end = el.selectionEnd ?? start;
  } catch {}
  const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, el.value.slice(0, start) + text + el.value.slice(end));
  try {
    el.setSelectionRange(start + text.length, start + text.length);
  } catch {}
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
  return { ok: true };
}

/** Monde isolé : rejoue un Input.dispatchKeyEvent par événements de page, avec l'effet par défaut des touches courantes. */
function keyEventInPage(p) {
  let el = document.activeElement;
  for (let i = 0; i < 20 && el; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    } else if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      let doc = null;
      try {
        doc = el.contentDocument;
      } catch {}
      if (!doc) return { ok: false, reason: "le focus est dans une iframe d'une autre origine" };
      el = doc.activeElement || doc.body;
    } else {
      break;
    }
  }
  const target = el || document.body || document.documentElement;
  const doc = target.ownerDocument;
  const view = doc.defaultView;
  const m = p.modifiers | 0;
  const init = {
    key: p.key, code: p.code, keyCode: p.windowsVirtualKeyCode, which: p.windowsVirtualKeyCode,
    bubbles: true, cancelable: true, composed: true,
    altKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4), shiftKey: !!(m & 8),
  };
  if (p.type === "keyUp") {
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return { ok: true };
  }
  const editable = target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName);
  const insert = (t) => {
    try {
      return doc.execCommand("insertText", false, t);
    } catch {
      return false;
    }
  };
  if (p.type === "char") {
    if (editable) insert(p.text ?? "");
    return { ok: true };
  }
  if (!target.dispatchEvent(new KeyboardEvent("keydown", init))) return { ok: true }; // la page a pris la touche
  const press = (charCode) => target.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode }));
  const clickable = /^(BUTTON|SUMMARY)$/.test(target.tagName) || /^(button|checkbox|radio|submit|reset)$/.test(target.type ?? "") ||
    ["button", "checkbox", "radio", "switch", "menuitem", "tab", "option"].includes(target.getAttribute("role"));
  const shortcut = m & (1 | 2 | 4);
  if (p.key === "Enter") {
    if (!press(13)) return { ok: true };
    if (target.tagName === "TEXTAREA") insert("\n");
    else if (target.isContentEditable) {
      try { doc.execCommand(m & 8 ? "insertLineBreak" : "insertParagraph", false); } catch {}
    } else if (target.tagName === "INPUT" && target.form) {
      // Envoi implicite : le bouton d'envoi par défaut, comme un vrai Entrée.
      const submit = target.form.querySelector('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]');
      try {
        if (submit) submit.click();
        else target.form.requestSubmit();
      } catch {}
    } else if (clickable || target.tagName === "A") target.click();
    return { ok: true };
  }
  if (p.text && !shortcut) {
    if (!press(p.text.charCodeAt(0))) return { ok: true };
    if (editable) insert(p.text);
    else if (p.key === " " && clickable) target.click();
    else if (p.key === " ") view.scrollBy({ top: (m & 8 ? -1 : 1) * view.innerHeight * 0.875, behavior: "instant" });
    return { ok: true };
  }
  if (shortcut && (m & (2 | 4)) && p.key.toLowerCase() === "a") {
    if (editable && typeof target.select === "function") target.select();
    else {
      try { doc.execCommand("selectAll", false); } catch {}
    }
    return { ok: true };
  }
  if (shortcut) return { ok: true };
  if (p.key === "Backspace" || p.key === "Delete") {
    if (editable) {
      try { doc.execCommand(p.key === "Backspace" ? "delete" : "forwardDelete", false); } catch {}
    }
    return { ok: true };
  }
  if (p.key === "Tab") {
    const all = [...doc.querySelectorAll('a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]')]
      .filter((e) => e.tabIndex >= 0 && !e.disabled && e.getClientRects().length);
    if (all.length) {
      const i = all.indexOf(target);
      const next = all[(i + (m & 8 ? -1 : 1) + all.length) % all.length];
      try { next.focus(); } catch {}
    }
    return { ok: true };
  }
  if (!editable) {
    const h = view.innerHeight * 0.875;
    const scroll = { ArrowDown: [0, 40], ArrowUp: [0, -40], ArrowRight: [40, 0], ArrowLeft: [-40, 0], PageDown: [0, h], PageUp: [0, -h] }[p.key];
    if (scroll) view.scrollBy({ left: scroll[0], top: scroll[1], behavior: "instant" });
    else if (p.key === "Home") view.scrollTo({ top: 0, behavior: "instant" });
    else if (p.key === "End") view.scrollTo({ top: doc.documentElement.scrollHeight, behavior: "instant" });
  }
  return { ok: true };
}
