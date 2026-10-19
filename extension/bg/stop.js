// Agent Browser Control, service worker : arrêt d'urgence, pause par agent et annulation des appels.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// STOP / reprise
// ---------------------------------------------------------------------------

const PAUSED_MESSAGE =
  "L'utilisateur a arrêté le contrôle du navigateur (bouton STOP). Ne pas réessayer : " +
  "attendre qu'il le réactive et qu'il le demande explicitement.";

const agentPausedMessage = (who) =>
  `L'utilisateur a mis l'agent « ${who} » en pause depuis le panneau. Ne pas réessayer : ` +
  "attendre qu'il le relance et qu'il le demande explicitement.";

let paused = false;
/** Agents mis en pause un par un depuis le panneau (« agent » couvre aussi ses sous-agents). */
const pausedAgents = new Set();
/** Onglets des agents en pause : toute commande CDP ou tout appel de page y échoue aussitôt. */
const pausedTabs = new Set();

/**
 * Appels en cours : clé -> { agent, actor, tabId, abort(message) }. STOP, la pause d'un agent et
 * l'annulation par le démon (délai dépassé) répondent tout de suite à l'agent via abort().
 */
const runningCalls = new Map();
/** Onglets dont un appel annulé tourne encore : les boucles d'attente s'y arrêtent (isHalted). */
const haltedTabs = new Map(); // tabId -> nombre d'appels annulés encore en vol

const pausedLoaded = chrome.storage.session.get(["paused", "pausedAgents"]).then(async ({ paused: p, pausedAgents: list = [] }) => {
  paused = !!p;
  for (const a of list) pausedAgents.add(a);
  await refreshPausedTabs().catch(() => {});
  updateBadge();
});

/**
 * Garde appelée avant chaque commande CDP, appel de page ou attachement : un outil abandonné (STOP,
 * agent en pause) s'interrompt à sa prochaine étape au lieu de continuer en arrière-plan.
 */
function assertRunning(tabId) {
  if (paused) throw new Error(PAUSED_MESSAGE);
  if (tabId !== undefined && pausedTabs.has(tabId)) throw new Error("Agent mis en pause par l'utilisateur dans le panneau.");
}

/** Un appel annulé tourne encore sur cet onglet : les boucles d'attente (wait_for, défilements) s'arrêtent. */
const isHalted = (tabId) => (haltedTabs.get(tabId) ?? 0) > 0;

/** Clé de pause qui couvre cet acteur (« agent » ou « agent · étiquette »), ou null. */
function pausedKeyFor(actor) {
  if (pausedAgents.has(actor)) return actor;
  const base = actor.split(LABEL_SEP)[0];
  return pausedAgents.has(base) ? base : null;
}

/** Recalcule les onglets des agents en pause (à la pause, à la reprise, au chargement). */
async function refreshPausedTabs() {
  pausedTabs.clear();
  for (const key of pausedAgents) {
    const [agent, label = ""] = key.split(LABEL_SEP);
    for (const tab of await agentTabs(agent, label)) pausedTabs.add(tab.id);
  }
}

/** Interrompt les appels en cours qui satisfont `match`, avec `message` comme réponse à l'agent. */
function abortCalls(match, message) {
  for (const call of runningCalls.values()) if (match(call)) call.abort(message);
}

async function stopAll() {
  paused = true;
  abortCalls(() => true, PAUSED_MESSAGE);
  credDenyPending("Arrêt d'urgence (bouton STOP).").catch(() => {});
  bwUnlockSettle({ ok: false, error: "Arrêt d'urgence (bouton STOP)." });
  askDenyPending("Arrêt d'urgence (bouton STOP).").catch(() => {});
  for (const runId of scriptRuns.keys()) {
    chrome.runtime.sendMessage({ target: "offscreen", type: "abort-script", runId }).catch(() => {});
  }
  await chrome.storage.session.set({ paused: true });
  for (const tabId of [...attached]) await chrome.debugger.detach({ tabId }).catch(() => {});
  attached.clear();
  updateBadge();
}

async function resume() {
  paused = false;
  await chrome.storage.session.set({ paused: false });
  updateBadge();
}

/** Pause ou reprise d'un agent (ou d'un sous-agent) depuis le panneau. */
async function setAgentPaused(agent, on) {
  if (typeof agent !== "string" || !agent) return;
  if (on) {
    pausedAgents.add(agent);
    await refreshPausedTabs().catch(() => {});
    const covered = (call) => call.actor === agent || call.agent === agent || call.actor.startsWith(agent + LABEL_SEP);
    abortCalls(covered, agentPausedMessage(agent));
    for (const [runId, run] of scriptRuns) {
      if (covered({ actor: run.actor ?? run.agent, agent: run.agent })) {
        chrome.runtime.sendMessage({ target: "offscreen", type: "abort-script", runId }).catch(() => {});
      }
    }
    // Ses onglets lâchent le debugger : une commande en vol échoue, la suivante est refusée par assertRunning.
    for (const tabId of pausedTabs) {
      await giveBack(tabId).catch(() => {});
      if (attached.has(tabId)) await chrome.debugger.detach({ tabId }).catch(() => {});
      attached.delete(tabId);
    }
  } else {
    pausedAgents.delete(agent);
    await refreshPausedTabs().catch(() => {});
  }
  await chrome.storage.session.set({ pausedAgents: [...pausedAgents] });
}

/** Le démon a abandonné l'appel (délai dépassé) : l'agent a déjà sa réponse, on coupe le travail restant. */
function cancelDaemonCall(daemonId) {
  for (const call of runningCalls.values()) {
    if (call.daemonId === daemonId) call.abort("Appel annulé par le démon (délai dépassé).", { halt: true });
  }
}
