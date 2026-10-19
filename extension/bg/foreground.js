// Agent Browser Control, service worker : premier plan des onglets.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

/**
 * Par défaut les agents travaillent en arrière-plan : ils ne changent ni l'onglet actif ni la fenêtre de
 * l'utilisateur, qui garde la main sur son navigateur (sauf le temps d'un geste à la souris, voir withForeground).
 * L'option « premier plan » du panneau redonne l'ancien comportement (onglet visé devant à chaque action).
 */
async function foregroundTabs() {
  const { foregroundTabs: on = false } = await chrome.storage.local.get("foregroundTabs");
  return on === true;
}

/**
 * Chrome suspend les animations (requestAnimationFrame) des onglets masqués : menus et
 * transitions ne s'y exécutent pas. En mode premier plan, on met l'onglet devant avant d'agir.
 */
async function bringToFront(tab) {
  if (!tab.active && (await foregroundTabs())) {
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(150);
  }
  await refreshDeviceOverride(tab.id); // onglet émulé : voir devtools.js
}

// Un onglet masqué ne dessine rien : pas de requestAnimationFrame (les listes virtualisées restent vides), et
// Chrome y laisse les événements souris sans réponse jusqu'à leur délai (un clic y prend ~5 s, un défilement 60 s).
// Dans ces cas seulement, l'onglet passe devant le temps du geste, puis l'utilisateur retrouve le sien.
const FRONT_HOLD_MS = 800; // garde après le geste : des gestes enchaînés ne font pas d'allers-retours
const fronts = new Map(); // tabId -> { windowId, previousId, uses, timer, ready }
const hoverSeq = new Map(); // tabId -> dernier survol (garde les rejouements différés)

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(fronts.get(tabId)?.timer);
  fronts.delete(tabId);
});

/** Attend que la page ait repris son rendu : visible, puis deux images dessinées (1,5 s au plus). */
async function waitRendering(tabId) {
  const probe = `document.visibilityState === "visible" && new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`;
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const drawn = await Promise.race([
      cdp(tabId, "Runtime.evaluate", { expression: probe, returnByValue: true, awaitPromise: true }).then((res) => res.result?.value === true),
      sleep(400).then(() => false),
    ]).catch(() => false);
    if (drawn) return;
    await sleep(50);
  }
}

/** Met l'onglet devant s'il ne l'est pas ; renvoie le prêt à rendre avec releaseFront, ou null s'il n'y a rien à rendre. */
async function takeFront(tab) {
  let front = fronts.get(tab.id);
  if (!front) {
    const { active, windowId } = await chrome.tabs.get(tab.id);
    if (active) return null; // l'utilisateur est déjà sur cet onglet
    const [previous] = await chrome.tabs.query({ windowId, active: true });
    // Un autre onglet agent occupe déjà le devant (file, minuteur en cours) : on hérite
    // de SON précédent (l'onglet de l'utilisateur), pas de lui : sinon les retours
    // chaîneraient d'agent en agent au lieu de rendre son onglet à l'utilisateur.
    const holder = [...fronts.values()].find((f) => f.windowId === windowId);
    front = { windowId, previousId: holder?.previousId ?? previous?.id, uses: 0, timer: null, ready: null };
    fronts.set(tab.id, front);
    front.ready = chrome.tabs.update(tab.id, { active: true }).then(() => waitRendering(tab.id));
  }
  clearTimeout(front.timer);
  front.uses++;
  try {
    await front.ready;
  } catch (err) {
    fronts.delete(tab.id);
    throw err;
  }
  return front;
}

function releaseFront(tabId, front) {
  if (--front.uses > 0) return;
  front.timer = setTimeout(() => giveBack(tabId), FRONT_HOLD_MS);
}

/** Rend à l'utilisateur l'onglet qu'il avait, s'il n'a pas changé d'onglet entre-temps. */
async function giveBack(tabId) {
  const front = fronts.get(tabId);
  if (!front) return;
  fronts.delete(tabId);
  clearTimeout(front.timer);
  const [current] = await chrome.tabs.query({ windowId: front.windowId, active: true }).catch(() => []);
  // Un onglet ouvert par l'action (lien target=_blank) est passé devant : il est à l'agent, pas à l'utilisateur.
  const openedByAgent = recentlyOpened.some((o) => o.id === current?.id && o.opener === tabId);
  if ((current?.id !== tabId && !openedByAgent) || front.previousId === undefined) return;
  await chrome.tabs.update(front.previousId, { active: true }).catch(() => {});
}

/** File d'attente du premier plan par fenêtre : les passages devant s'y succèdent sans se recouvrir. */
const frontQueues = new Map(); // windowId -> promesse du dernier détenteur
const frontHolders = new Map(); // windowId -> tabId qui occupe le devant (imbrication : get_page_text sous withDrawnPage)

async function withFrontQueue(windowId, fn, tabId) {
  // Le même onglet est déjà devant (appel imbriqué) : direct, sinon interblocage. Un autre onglet de la
  // fenêtre, lui, attend son tour : deux agents ne doivent pas se disputer l'onglet actif.
  if (frontHolders.has(windowId) && frontHolders.get(windowId) === tabId) return fn();
  const prev = frontQueues.get(windowId) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise((r) => {
    release = r;
  });
  // Chaîne synchrone : l'ordre d'appel = l'ordre de passage (FIFO).
  frontQueues.set(windowId, prev.catch(() => {}).then(() => gate));
  await prev.catch(() => {});
  frontHolders.set(windowId, tabId);
  try {
    return await fn();
  } finally {
    frontHolders.delete(windowId);
    release();
  }
}

async function withForeground(tab, fn) {
  if (await foregroundTabs()) {
    await bringToFront(tab);
    return fn();
  }
  return withFrontQueue(tab.windowId, async () => {
    assertRunning(tab.id); // STOP ou pause pendant l'attente dans la file
    const front = await takeFront(tab);
    try {
      // Onglet émulé : Chrome peut avoir perdu l'échelle émulée (voir refreshDeviceOverride, devtools.js).
      await refreshDeviceOverride(tab.id);
      return await fn();
    } finally {
      if (front) releaseFront(tab.id, front);
    }
  }, tab.id);
}

const MOUSE_ACTIONS = new Set(["left_click", "right_click", "double_click", "triple_click", "left_click_drag", "hover", "scroll"]);

/** Un geste à la souris se fait onglet devant. */
function withFrontForMouse(tool) {
  return async (agent, args) => {
    // type avec ref / coordinate commence par un clic : même traitement qu'un geste à la souris.
    const needsMouse = (a) => MOUSE_ACTIONS.has(a.action) || (a.action === "type" && (a.ref || a.coordinate));
    const clicks = needsMouse(args) || (Array.isArray(args.steps) && args.steps.some((s) => s && needsMouse(s)));
    if (!clicks) return tool(agent, args);
    const tab = await assertOwned(agent, args.tabId);
    return withForeground(tab, () => tool(agent, args));
  };
}

/** Une page masquée dont les listes virtualisées ne sont pas dessinées se lit onglet devant. */
function withDrawnPage(tool) {
  return async (agent, args) => {
    const tab = await assertOwned(agent, args.tabId);
    if (tab.active || (await foregroundTabs()) || !(await inPage(args.tabId, "needsRender").catch(() => false))) {
      return tool(agent, args);
    }
    return withForeground(tab, () => tool(agent, args));
  };
}
