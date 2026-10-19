// Agent Browser Control, service worker : souris réelle.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Souris réelle (réglage du panneau, pour une machine dont l'écran sert aux agents)
// ---------------------------------------------------------------------------
// Par CDP, le pointeur d'un agent saute sur le centre exact de sa cible, sans trajet : les protections anti-robot
// (Turnstile, reCAPTCHA, DataDome…) le repèrent. Avec le réglage « Souris réelle », clics, survols, défilements et
// glisser passent, sur les pages qui le justifient (pointerReason, plus bas), par le vrai pointeur de la machine,
// que le démon déplace le long d'un trajet de main
// (server/pointer.ts, Linux X11). Ici : le point de la page converti en pixels d'écran, la vérification que la page a
// vu le pointeur arriver au bon endroit (mousemove reçus dans le monde isolé, invisible du site, toutes frames),
// une correction au besoin, puis le geste. Si la souris réelle fait défaut avant le geste (démon incapable, page non
// affichée, fenêtre recouverte), le geste CDP prend le relais et la réponse le signale.

const POINTER_STATUS_MS = 60_000; // capacité du démon, revue chaque minute
const WHEEL_STEP_PX = 100; // un cran de molette, à l'échelle des deltas CDP d'ABC (scroll_amount × 100)
let pointerStatus = { at: 0, ok: false, why: "" };
let pointerChain = Promise.resolve(); // un seul pointeur : les gestes passent un par un, tous agents confondus
const pointerNotes = new Map(); // tabId -> pourquoi le dernier geste est resté simulé

async function nativePointerOn() {
  const { nativePointer: on = false } = await chrome.storage.local.get("nativePointer");
  return on === true;
}

/** Échec d'avant le geste : rien n'a été cliqué, le geste CDP peut prendre le relais. */
const pointerEarly = (why) => Object.assign(new Error(why), { pointerEarly: true });

async function pointerReady() {
  if (Date.now() - pointerStatus.at < POINTER_STATUS_MS) return pointerStatus;
  const res = await daemonRpc("pointer", { action: "status" }).catch((err) => ({ ok: false, why: err.message }));
  pointerStatus = { at: Date.now(), ok: res.ok === true, why: String(res.why ?? "") };
  return pointerStatus;
}

/**
 * Exécuté dans chaque frame (monde isolé) : garde le dernier mouvement réel du pointeur ; dans la page, rend aussi
 * la géométrie de la fenêtre. Fonction autonome : chrome.scripting la sérialise.
 */
function pointerProbe() {
  if (!globalThis.__abcPointerWatch) {
    globalThis.__abcPointerWatch = true;
    addEventListener("mousemove", (e) => {
      if (e.isTrusted) globalThis.__abcPointerSeen = { sx: e.screenX, sy: e.screenY, cx: e.clientX, cy: e.clientY, t: Date.now() };
    }, { capture: true, passive: true });
  }
  const seen = globalThis.__abcPointerSeen ?? null;
  if (window !== window.top) return { seen };
  return {
    top: true, seen, screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight,
    scale: devicePixelRatio, scroll: [scrollX, scrollY], visible: document.visibilityState === "visible",
  };
}

async function probePointer(tabId) {
  const run = (target) => chrome.scripting.executeScript({ target, world: "ISOLATED", func: pointerProbe });
  const results = await run({ tabId, allFrames: true })
    .catch(() => run({ tabId }))
    .catch((err) => { throw pointerEarly(`page inaccessible (${err.message}).`); });
  const page = results.find((r) => r.frameId === 0)?.result;
  if (!page?.top) throw pointerEarly("page inaccessible.");
  // Le pointeur peut finir sur une iframe (case Turnstile) : la page n'en voit rien, l'iframe si.
  const last = results.map((r) => r.result?.seen).filter(Boolean).reduce((a, b) => (!a || b.t > a.t ? b : a), null);
  return { ...page, last };
}

/** Coin haut gauche de la partie visible de la page, en pixels d'écran (CSS) : mesuré, ou estimé. */
function viewportOrigin(m, since = 0) {
  if (m.seen && m.seen.t >= since) return { x: m.seen.sx - m.seen.cx, y: m.seen.sy - m.seen.cy };
  // Estimation : bordures égales, barres en haut. Un panneau latéral la fausse : la vérification corrige.
  const side = Math.max(0, (m.outerWidth - m.innerWidth) / 2);
  return { x: m.screenX + side, y: m.screenY + m.outerHeight - m.innerHeight - side };
}

/** Attend que la page ne défile plus (défilement doux) : on ne vise pas une cible qui bouge. 1,5 s au plus. */
async function settledProbe(tabId) {
  let m = await probePointer(tabId);
  for (let i = 0; i < 15; i++) {
    await sleep(80);
    const again = await probePointer(tabId);
    const still = again.scroll[0] === m.scroll[0] && again.scroll[1] === m.scroll[1];
    m = again;
    if (still) break;
  }
  return m;
}

/** Dernier mouvement vu après `since`, une fois stable (l'événement suit l'image suivante). */
async function landedProbe(tabId, since) {
  let m = null;
  let prev = null;
  for (let i = 0; i < 10; i++) {
    await sleep(25);
    m = await probePointer(tabId);
    if (m.last && m.last.t >= since && prev && prev.t === m.last.t) return m;
    prev = m.last;
  }
  return m?.last && m.last.t >= since ? m : null;
}

/** Amène le vrai pointeur sur `point` (coordonnées de la page), en vérifiant qu'il y est. */
async function pointerApproach(tabId, point, ref, why) {
  let m = await settledProbe(tabId);
  if (!m.visible) throw pointerEarly("la page n'est pas affichée à l'écran.");
  const relocate = async (p) => (ref ? locateRef(tabId, ref).catch(() => p) : p);
  let p = await relocate(point);
  if (p.x < 0 || p.y < 0 || p.x > m.innerWidth || p.y > m.innerHeight) throw pointerEarly("le point est hors de la partie visible de la page.");
  const start = Date.now();
  const k = m.scale || 1;
  let origin = viewportOrigin(m);
  const screen = (q) => ({ x: Math.round((origin.x + q.x) * k), y: Math.round((origin.y + q.y) * k) });
  for (let attempt = 0; attempt < 3; attempt++) {
    const since = Date.now();
    await daemonRpc("pointer", { action: "move", ...screen(p), ...(attempt === 0 && why && { why }) }).catch((err) => { throw pointerEarly(err.message); });
    m = await landedProbe(tabId, since);
    if (!m) throw pointerEarly("la page n'a pas vu le pointeur arriver (fenêtre recouverte ?).");
    origin = viewportOrigin(m, start);
    p = await relocate(p); // la cible a pu bouger pendant le trajet
    const dx = origin.x + p.x - m.last.sx;
    const dy = origin.y + p.y - m.last.sy;
    if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2) return { origin, k, point: p };
  }
  throw pointerEarly("le pointeur n'atteint pas sa cible.");
}

const modifierKeys = (mask) => [[1, "alt"], [2, "ctrl"], [4, "super"], [8, "shift"]].filter(([bit]) => mask & bit).map(([, key]) => key);

async function nativeGesture(tabId, g) {
  const status = await pointerReady();
  if (!status.ok) throw pointerEarly(status.why || "le démon ne pilote pas le pointeur de cette machine.");
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw pointerEarly("l'onglet n'est pas devant.");
  const win = await chrome.windows.get(tab.windowId);
  if (win.state === "minimized") throw pointerEarly("la fenêtre est réduite.");
  if (!win.focused) await chrome.windows.update(win.id, { focused: true }).catch(() => {});
  const first = g.action === "drag" ? g.points[0] : g.point;
  const { origin, k, point } = await pointerApproach(tabId, first, g.ref, g.why);
  // Le pointeur est sur sa cible : à partir d'ici, un échec est une erreur, plus un repli.
  if (g.ref && g.action === "click") await assertHit(tabId, g.ref, point);
  const keys = modifierKeys(g.modifiers ?? 0);
  switch (g.action) {
    case "move":
      return;
    case "click":
      return daemonRpc("pointer", { action: "press", button: g.button, count: g.count, keys });
    case "wheel": {
      const vertical = g.deltaY !== 0;
      const delta = vertical ? g.deltaY : g.deltaX;
      const direction = vertical ? (delta < 0 ? "up" : "down") : delta < 0 ? "left" : "right";
      return daemonRpc("pointer", { action: "wheel", direction, notches: Math.max(1, Math.round(Math.abs(delta) / WHEEL_STEP_PX)) });
    }
    case "drag":
      // Le trajet d'approche n'est pas le geste : le relevé des positions (geste perturbé ?) repart d'ici.
      await inPage(tabId, "gestureStart").catch(() => {});
      return daemonRpc("pointer", {
        action: "drag", keys,
        points: g.points.map((q) => [Math.round((origin.x + q.x) * k), Math.round((origin.y + q.y) * k)]),
      });
  }
}

// ---------------------------------------------------------------------------
// Quand la souris réelle sert-elle ?
// ---------------------------------------------------------------------------
// Un trajet de main coûte 0,5 à 1,5 s par geste : il ne sert que là où une protection juge le comportement.
// Page avec un widget ou un script anti-robot (Turnstile et défi Cloudflare, hCaptcha, reCAPTCHA, Arkose, DataDome,
// PerimeterX, GeeTest), page de connexion (champ de mot de passe visible), ou site où une protection a été vue
// depuis moins de 30 min (le score se construit sur toute la visite). Ailleurs, le geste CDP, rapide. L'agent peut
// trancher pour un geste : computer human: true l'impose, human: false l'écarte.

const PROTECTED_SITE_MS = 30 * 60_000;
const GUARD_CACHE_MS = 3_000; // une rafale de gestes sur la même page ne refait pas la sonde
const protectedSites = new Map(); // hôte -> dernier signal anti-robot
const guardCache = new Map(); // tabId -> { url, at, verdict }
const pointerHumanArg = new Map(); // tabId -> choix de l'agent pour le geste en cours (computer, human)

/** Exécuté dans la page (monde isolé, invisible du site) : protection anti-robot, champ de mot de passe visible. */
function pageGuardProbe() {
  const ANTIBOT = /challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform\/|hcaptcha\.com|\/recaptcha\/|recaptcha\.net|arkoselabs\.com|funcaptcha\.com|captcha-delivery\.com|datadome\.co|px-cdn\.net|perimeterx\.net|geetest\.com/i;
  const src = [...document.querySelectorAll("script[src], iframe[src]")].map((e) => e.src).find((s) => ANTIBOT.test(s));
  let antibot = null;
  if (src) {
    try {
      antibot = new URL(src).hostname;
    } catch {
      antibot = "script";
    }
  } else if (document.querySelector(".cf-turnstile, .h-captcha, .g-recaptcha, #px-captcha, [data-sitekey]")) antibot = "widget";
  const login = [...document.querySelectorAll("input[type=password]")]
    .some((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
  return { antibot, login };
}

/** Raison d'utiliser la souris réelle pour un geste sur cet onglet, ou "" : geste CDP. */
async function pointerReason(tabId) {
  const forced = pointerHumanArg.get(tabId);
  if (forced === true) return "demandée par l'agent";
  if (forced === false) return "";
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  let host = "";
  try {
    host = new URL(tab?.url ?? "").hostname;
  } catch {}
  if (!host) return "";
  const cached = guardCache.get(tabId);
  let verdict = cached && cached.url === tab.url && Date.now() - cached.at < GUARD_CACHE_MS ? cached.verdict : null;
  if (!verdict) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: pageGuardProbe }).catch(() => [null]);
    verdict = res?.result ?? { antibot: null, login: false };
    if (guardCache.size > 50) guardCache.clear();
    guardCache.set(tabId, { url: tab.url, at: Date.now(), verdict });
    if (verdict.antibot) protectedSites.set(host, Date.now());
  }
  if (verdict.antibot) return `protection anti-robot (${verdict.antibot})`;
  if (verdict.login) return "page de connexion";
  const seen = protectedSites.get(host);
  return seen && Date.now() - seen < PROTECTED_SITE_MS ? `site protégé (${host})` : "";
}

/**
 * Fait le geste au vrai pointeur si le réglage est actif et que la page le justifie (pointerReason). Renvoie false
 * quand le geste CDP doit le faire (réglage éteint, page ordinaire, ou souris réelle indisponible avant le geste :
 * la raison va alors dans pointerNote).
 */
async function pointerGesture(tabId, gesture) {
  if (!(await nativePointerOn())) return false;
  const why = await pointerReason(tabId);
  if (!why) return false;
  const run = pointerChain.then(() => nativeGesture(tabId, { ...gesture, why }));
  pointerChain = run.catch(() => {});
  try {
    await run;
    pointerNotes.delete(tabId);
    return true;
  } catch (err) {
    if (!err?.pointerEarly) throw err;
    pointerNotes.set(tabId, err.message);
    return false;
  }
}

/** Note de réponse quand la souris réelle a fait défaut (une seule fois par geste). */
function pointerNote(tabId) {
  const why = pointerNotes.get(tabId);
  pointerNotes.delete(tabId);
  return why ? `\n(Souris réelle indisponible : ${why} Geste simulé à la place.)` : "";
}
