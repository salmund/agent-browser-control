// Agent Browser Control, service worker : Chrome DevTools Protocol et boîtes de dialogue.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Chrome DevTools Protocol + capture console / réseau
// ---------------------------------------------------------------------------

const attached = new Set();
const attaching = new Map(); // tabId -> promesse d'attachement en cours (appels concurrents)
const consoleLogs = new Map(); // tabId -> [{ t, level, text, source }]
const networkLogs = new Map(); // tabId -> Map(requestId -> entry)

/** Oublie tout ce qui dépend de la session debugger d'un onglet (détachement, fermeture). */
function forgetDebuggerState(tabId) {
  attached.delete(tabId);
  inflight.delete(tabId);
  for (const [requestId, e] of pendingExtraHeaders) if (e.tabId === tabId) pendingExtraHeaders.delete(requestId);
}

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  if (tabId === undefined) return;
  forgetDebuggerState(tabId);
  // L'utilisateur a cliqué « Annuler » sur la barre « … débogue ce navigateur » : c'est un STOP explicite.
  // Sans ça, la commande suivante réattacherait en silence et la barre reviendrait.
  if (reason === "canceled_by_user" && !paused) stopAll().catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  // Le HAR de l'onglet peut dater d'avant un rechargement de l'extension : on prévient toujours le démon.
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "har-close", tabId }));
  forgetDebuggerState(tabId);
  consoleLogs.delete(tabId);
  networkLogs.delete(tabId);
  lastAgentAction.delete(tabId);
  recordings.delete(tabId);
  stoppedRecordings.delete(tabId);
  harMutedUntil.delete(tabId);
});

async function ensureAttached(tabId) {
  assertRunning(tabId);
  if (attached.has(tabId)) return;
  // Deux outils qui attachent en même temps partagent la même promesse : un seul enable, un seul leurre.
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = attachNow(tabId).finally(() => attaching.delete(tabId));
    attaching.set(tabId, pending);
  }
  return pending;
}

async function attachNow(tabId) {
  try {
    await withTimeout(chrome.debugger.attach({ tabId }, "1.3"), 10_000, "Attachement du debugger");
  } catch (err) {
    if (!String(err?.message).toLowerCase().includes("already attached")) throw err;
  }
  const send = (m) => chrome.debugger.sendCommand({ tabId }, m).catch(() => {});
  // Performance dès l'attachement : ses compteurs (layouts, script) ne partent que de là.
  // Page.enable : nécessaire pour être prévenu des boîtes de dialogue.
  await withTimeout(Promise.all([
    send("Runtime.enable"), send("Log.enable"), send("Network.enable"), send("Performance.enable"), send("Page.enable"), send("Inspector.enable"),
  ]), 10_000, "Activation du debugger").catch(() => {});
  // Marqué attaché seulement une fois les domaines actifs : un appel concurrent n'envoie rien avant.
  attached.add(tabId);
  // L'onglet agent se croit toujours visible et actif, même en arrière-plan : les applis qui
  // suspendent leur rendu ou leurs minuteurs quand visibilityState passe à hidden (Gemini,
  // Meta AI, modales différées…) continuent de fonctionner pendant que l'utilisateur garde
  // son onglet. Installé à chaque attachement (une seule fois par session debugger).
  installVisibilitySpoof(tabId).catch(() => {});
  // Workers et iframes d'une autre origine ont leur propre cible : on s'y attache aussi, pour voir
  // leur réseau et leurs WebSocket (les flux temps réel passent souvent par un worker).
  await chrome.debugger
    .sendCommand({ tabId }, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    .catch(() => {});
}

/**
 * Script monde principal : fige l'onglet à l'état « visible et actif ». Idempotent
 * (garde __abcVisSpoof). Ne touche pas aux minuteurs : seul l'état de visibilité
 * et les écouteurs visibilitychange/pagehide sont neutralisés.
 */
const VIS_SPOOF_SOURCE = `(() => {
  if (window.__abcVisSpoof) return "déjà installé";
  window.__abcVisSpoof = true;
  try {
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    document.hasFocus = () => true;
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if ((this === document || this === window) && (type === "visibilitychange" || type === "pagehide")) return;
      return add.call(this, type, listener, options);
    };
  } catch {}
  return "installé";
})()`;

/** Installe le leurre de visibilité : focus émulé + script sur chaque nouveau document + document actuel. */
async function installVisibilitySpoof(tabId) {
  await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: VIS_SPOOF_SOURCE }).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: VIS_SPOOF_SOURCE }).catch(() => {});
}

/**
 * Délai maximal d'une commande CDP. Sans lui, une page figée (boucle JS, onglet suspendu) laissait la
 * promesse en suspens et bloquait la file du premier plan de toute la fenêtre. Les gestes souris d'un
 * onglet masqué peuvent attendre longtemps la réponse de Chrome (jusqu'à 60 s pour un défilement).
 */
function cdpTimeout(method, params) {
  if (method.startsWith("Input.")) return 65_000;
  if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") return params?.awaitPromise ? 120_000 : 60_000;
  if (method === "Page.printToPDF" || method === "Page.captureScreenshot") return 60_000;
  return 30_000;
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  if (method === "Page.handleJavaScriptDialog") return chrome.debugger.sendCommand({ tabId }, method, params);
  assertNoDialog(tabId);
  assertRunning(tabId);
  // Une commande qui déclenche une boîte (clic sur « Supprimer » → confirm) ne répondrait qu'à sa fermeture.
  return withTimeout(raceDialog(tabId, chrome.debugger.sendCommand({ tabId }, method, params)), cdpTimeout(method, params), method);
}

// ---------------------------------------------------------------------------
// Boîtes de dialogue JavaScript : elles bloquent la page jusqu'à ce qu'on y réponde
// ---------------------------------------------------------------------------

const dialogs = new Map(); // tabId -> { type, message, defaultPrompt, url }
const dialogWaiters = new Map(); // tabId -> Set(callback)

class DialogOpenError extends Error {}

function dialogError(tabId) {
  const d = dialogs.get(tabId);
  const kind = { alert: "alert", confirm: "confirm", prompt: "prompt", beforeunload: "« quitter la page ? »" }[d.type] ?? d.type;
  return new DialogOpenError(
    `Une boîte de dialogue ${kind} est ouverte sur la page et la bloque : ` +
    `${untrusted(d.message || "(sans message)")}\n` +
    `Y répondre avec handle_dialog (accept: true ou false${d.type === "prompt" ? ", promptText" : ""}) avant toute autre action.`,
  );
}

function assertNoDialog(tabId) {
  if (dialogs.has(tabId)) throw dialogError(tabId);
}

/** Rejette dès qu'une boîte s'ouvre sur l'onglet, pour ne pas attendre indéfiniment. */
function raceDialog(tabId, promise) {
  let callback;
  const opened = new Promise((_, reject) => {
    callback = () => reject(dialogError(tabId));
    let set = dialogWaiters.get(tabId);
    if (!set) dialogWaiters.set(tabId, (set = new Set()));
    set.add(callback);
  });
  return Promise.race([promise, opened]).finally(() => dialogWaiters.get(tabId)?.delete(callback));
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (tabId === undefined) return;
  if (method === "Page.javascriptDialogOpening") {
    dialogs.set(tabId, { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt, url: params.url });
    for (const cb of dialogWaiters.get(tabId) ?? []) cb();
  } else if (method === "Page.javascriptDialogClosed") {
    dialogs.delete(tabId);
  }
});
chrome.debugger.onDetach.addListener(({ tabId }) => dialogs.delete(tabId));

async function handleDialog(agent, { tabId, accept = true, promptText }) {
  await assertOwned(agent, tabId);
  const d = dialogs.get(tabId);
  if (!d) return ok(text("Aucune boîte de dialogue ouverte sur cet onglet."));
  await cdp(tabId, "Page.handleJavaScriptDialog", { accept: !!accept, ...(promptText !== undefined && { promptText: String(promptText) }) });
  dialogs.delete(tabId);
  await sleep(150);
  return ok(text(`Boîte ${d.type} ${accept ? "acceptée" : "refusée"}${promptText !== undefined ? ` (réponse : ${JSON.stringify(String(promptText))})` : ""}.`));
}

async function evaluate(tabId, expression) {
  const res = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true });
  return res.result?.value;
}

function pushCapped(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

function remoteObjectToString(o) {
  if (o.type === "string") return o.value;
  if ("value" in o) return JSON.stringify(o.value);
  return o.description ?? o.type;
}
