// Agent Browser Control, service worker : souris et clavier.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// computer : souris, clavier, capture
// ---------------------------------------------------------------------------

const MODIFIER_BITS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, shift: 8 };

function modifierMask(spec) {
  if (!spec) return 0;
  return spec.toLowerCase().split("+").reduce((m, k) => m | (MODIFIER_BITS[k.trim()] ?? 0), 0);
}

/**
 * Nombre de positions de pointeur reçues par la page à plus de 25 px du tracé de l'agent : ce ne sont pas
 * les siennes, c'est un humain qui a bougé la souris sur la page pendant le geste.
 */
function strayPointerEvents(received, points) {
  const dist = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  let stray = 0;
  for (const [x, y] of received ?? []) {
    let best = Infinity;
    for (let k = 1; k < points.length; k++) best = Math.min(best, dist({ x, y }, points[k - 1], points[k]));
    if (points.length === 1) best = Math.hypot(x - points[0].x, y - points[0].y);
    if (best > 25) stray++;
  }
  return stray;
}

/** Centre d'un élément (page principale ou iframe) en coordonnées du viewport de l'onglet. */
async function locateRef(tabId, ref) {
  const target = parseRef(ref);
  if (target.frameId) {
    // La frame demande sa position à ses parentes : page.js doit y être présent aussi.
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["page.js"] }).catch(() => {});
  }
  return inPage(tabId, "locate", target.ref, target.frameId);
}

async function targetPoint(tabId, { coordinate, ref }) {
  if (ref) return locateRef(tabId, ref);
  if (Array.isArray(coordinate) && coordinate.length === 2) return { x: coordinate[0], y: coordinate[1] };
  throw new Error("Fournir 'coordinate' [x, y] ou 'ref'.");
}

/** Note ajoutée quand locate() a réparé une ref périmée après un re-render de la page. */
const healNote = (point) => (point && point.healed ? " (ref réparée après un re-render de la page)" : "");

/**
 * Garde anti-clic-dans-le-vide : vérifie que le point calculé pour `ref` atteint bien sa cible
 * (pas une modale, une bannière ou un élément déplacé entre-temps). Refs d'iframes exclues :
 * hitTest parle en coordonnées du viewport de sa frame, locate() en coordonnées page.
 */
async function assertHit(tabId, ref, point) {
  if (!ref) return;
  const target = parseRef(ref);
  if (target.frameId) return;
  const res = await inPage(tabId, "hitTest", { x: point.x, y: point.y, ref: target.ref }).catch(() => null);
  if (res && !res.ok) {
    throw new Error(
      `Clic refusé : ${ref} est recouvert au point (${point.x}, ${point.y}) par ${res.cover}. ` +
      "Fermer la fenêtre qui recouvre (bannière, modale), ou cliquer sur l'élément visible.",
    );
  }
}

async function click(tabId, { x, y }, button, count, modifiers, ref) {
  if (await pointerGesture(tabId, { action: "click", point: { x, y }, ref, button, count, modifiers })) return;
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
  for (let i = 1; i <= count; i++) {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i, modifiers });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i, modifiers });
  }
}

/**
 * Glisser le long d'un tracé (au moins deux points), bouton maintenu d'un bout à l'autre : un seul trait
 * pour un logiciel de dessin, un seul geste pour un curseur ou un glisser-déposer.
 */
async function drag(tabId, points, modifiers) {
  if (await pointerGesture(tabId, { action: "drag", points, modifiers })) return;
  const send = (params) => cdp(tabId, "Input.dispatchMouseEvent", { ...params, modifiers });
  const move = (x, y) => send({ type: "mouseMoved", x, y, button: "left", buttons: 1 });
  const [first] = points;
  const last = points.at(-1);
  await send({ type: "mouseMoved", x: first.x, y: first.y, button: "none", buttons: 0 });
  await send({ type: "mousePressed", x: first.x, y: first.y, button: "left", buttons: 1, clickCount: 1 });
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    // Un point intermédiaire tous les ~8 px : les applis de dessin et les curseurs suivent le geste.
    const steps = Math.max(2, Math.min(100, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8)));
    for (let i = 1; i <= steps; i++) await move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  }
  // Pause au point d'arrivée : les logiciels qui lissent le trait dessinent avec un point de retard.
  await move(last.x, last.y);
  await sleep(30);
  await move(last.x, last.y);
  await send({ type: "mouseReleased", x: last.x, y: last.y, button: "left", buttons: 0, clickCount: 1 });
}

const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

function keyDefinition(name) {
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) return named;
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const code = /[a-z]/i.test(name) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : "";
    return { key: name, code, keyCode: upper.charCodeAt(0), text: name };
  }
  throw new Error(`Touche inconnue : ${name}`);
}

async function pressKeys(tabId, spec) {
  for (const combo of spec.trim().split(/\s+/)) {
    const parts = combo.split("+");
    const main = parts.pop();
    const modifiers = modifierMask(parts.join("+"));
    const def = keyDefinition(main);
    // Avec ctrl/alt/meta, pas de texte : c'est un raccourci.
    const withText = def.text && !(modifiers & (1 | 2 | 4));
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers };
    await cdp(tabId, "Input.dispatchKeyEvent", {
      ...base,
      type: withText ? "keyDown" : "rawKeyDown",
      ...(withText ? { text: def.text, unmodifiedText: def.text } : {}),
    });
    await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }
}
