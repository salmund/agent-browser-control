// Agent Browser Control, service worker : connexion au démon et messages du panneau.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Connexion au démon
// ---------------------------------------------------------------------------

let ws = null;
let pingTimer = null;
let reconnectDelay = 500;
let reconnectTimer = null;

function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  clearTimeout(reconnectTimer);
  const socket = new WebSocket(DAEMON_URL);
  ws = socket;

  // Chaque gestionnaire vérifie qu'il parle encore au socket courant : un ancien socket qui se ferme
  // en retard ne doit ni effacer le nouveau, ni relancer une reconnexion en double.
  socket.onopen = () => {
    if (ws !== socket) return;
    reconnectDelay = 1000;
    setStatus(true);
    chrome.storage.session.set({ connError: "" }).catch(() => {});
    clearInterval(pingTimer);
    // L'activité WebSocket maintient le service worker MV3 en vie.
    pingTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send('{"type":"ping"}'), PING_MS);
    sendSettings();
  };

  socket.onmessage = async (event) => {
    if (ws !== socket) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return; // trame illisible : ignorée plutôt que de casser le gestionnaire
    }
    if (!msg || typeof msg !== "object") return;
    // Rechargement demandé par le démon (npm run reload-extension), pour le développement.
    if (msg.type === "reload") return chrome.runtime.reload();
    // Réponse à un appel vers le démon (ex. résolution Bitwarden).
    if (msg.type === "daemon-rpc") return handleDaemonRpc(msg);
    // Présentation du démon : sa version, affichée dans le panneau.
    if (msg.type === "hello") {
      const daemonVersion = String(msg.version ?? msg.daemonVersion ?? "");
      chrome.storage.session.set({ daemonVersion }).catch(() => {});
      syncBwKeep();
      relayResync();
      return;
    }
    // Réponse de l'utilisateur venue d'Argos (Telegram, web), relayée par le démon (bg/relay.js).
    if (msg.type === "relay-decision") {
      const ok = relayDecision(msg);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "relay-decision-result", reqId: msg.reqId, ok }));
      return;
    }
    // Le démon a abandonné un appel (délai dépassé, client parti) : on coupe le travail restant.
    if (msg.type === "cancel") return cancelDaemonCall(msg.id);
    if (msg.type === "pong" || typeof msg.id !== "number") return;
    const result = await runTool(msg.agent, msg.tool, msg.args ?? {}, { daemonId: msg.id });
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: msg.id, result }));
  };

  socket.onclose = (event) => {
    if (ws !== socket) return;
    clearInterval(pingTimer);
    ws = null;
    setStatus(false);
    // 4003 : le démon a épinglé une autre installation de l'extension. Inutile d'insister toutes les
    // secondes : on espace, et le panneau affiche la marche à suivre.
    const refused = event?.code === 4003;
    chrome.storage.session.set({ connError: refused ? "Le démon accepte une autre installation de l'extension. Pour autoriser celle-ci : npm run unpin-extension, puis Reconnecter." : "" }).catch(() => {});
    for (const [, p] of daemonRpcPending) {
      clearTimeout(p.timer);
      p.reject(new Error("Démon déconnecté pendant l'appel."));
    }
    daemonRpcPending.clear();
    // Le démon ne recevra plus les réponses : les appels en cours s'arrêtent.
    abortCalls((call) => call.daemonId !== undefined, "Démon déconnecté pendant l'appel.");
    reconnectTimer = setTimeout(connect, refused ? 60_000 : reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  };

  socket.onerror = () => {}; // onclose suit toujours.
}

function setStatus(connected) {
  chrome.storage.session.set({ connected }).catch(() => {});
  updateBadge();
}

// ---------------------------------------------------------------------------
// Appels vers le démon (l'extension demande, le démon exécute côté système)
// ---------------------------------------------------------------------------

let daemonRpcId = 0;
const daemonRpcPending = new Map();
// Délai large : une synchro Bitwarden peut prendre jusqu'à 60 s côté démon.
const DAEMON_RPC_TIMEOUT_MS = 65_000;

/** Réglage « Garder Vaultwarden déverrouillé » (panneau) transmis au démon, qui garde la session. */
async function syncBwKeep() {
  const { bwKeepUnlocked = false } = await chrome.storage.local.get("bwKeepUnlocked").catch(() => ({}));
  return daemonRpc("bw-keep", { on: bwKeepUnlocked === true }).catch(() => {});
}
chrome.storage.local.onChanged.addListener((changes) => {
  if ("bwKeepUnlocked" in changes) syncBwKeep();
});

function daemonRpc(op, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("Démon non connecté."));
      return;
    }
    const reqId = ++daemonRpcId;
    const timer = setTimeout(() => {
      daemonRpcPending.delete(reqId);
      reject(new Error(`Le démon n'a pas répondu (${op}).`));
    }, DAEMON_RPC_TIMEOUT_MS);
    daemonRpcPending.set(reqId, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: "daemon-rpc", reqId, op, params }));
  });
}

function handleDaemonRpc(msg) {
  const p = daemonRpcPending.get(msg.reqId);
  if (!p) return;
  clearTimeout(p.timer);
  daemonRpcPending.delete(msg.reqId);
  if (msg.ok) p.resolve(msg.result ?? {});
  else p.reject(Object.assign(new Error(msg.error || "Échec de l'appel au démon."), { reason: msg.result?.reason }));
}

// ---------------------------------------------------------------------------
// Badge de l'icône : arrêt, déconnexion, ou nombre de demandes qui attendent l'utilisateur
// ---------------------------------------------------------------------------

async function updateBadge() {
  const { connected, askRequests = [], credApprovals = [], bwUnlockRequests = [] } =
    await chrome.storage.session.get(["connected", "askRequests", "credApprovals", "bwUnlockRequests"]);
  const waiting = askRequests.length + credApprovals.length + bwUnlockRequests.length;
  let text = "";
  let color = "#b91c1c";
  if (paused) text = "stop";
  else if (!connected) text = "off";
  else if (waiting) {
    text = String(waiting);
    color = "#d97706";
  }
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  chrome.action.setTitle({
    title: paused ? "Agent Browser Control : arrêté (STOP)"
      : !connected ? "Agent Browser Control : démon non connecté"
        : waiting ? `Agent Browser Control : ${waiting} demande(s) en attente`
          : "Agent Browser Control",
  }).catch(() => {});
}

chrome.storage.session.onChanged.addListener((changes) => {
  if ("askRequests" in changes || "credApprovals" in changes || "bwUnlockRequests" in changes) updateBadge();
});

// ---------------------------------------------------------------------------
// Démarrage, raccourcis clavier
// ---------------------------------------------------------------------------

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Code à jour. Chrome garde en cache les scripts du service worker d'une extension non empaquetée tant que sa version
// ne change pas, même d'un redémarrage du navigateur à l'autre : du code modifié sur le disque (git pull, copie sur
// un banc d'essai) ne tournerait qu'après un rechargement à la main, et l'ancien code répondrait sans rien dire.
// L'empreinte des scripts est notée à l'événement install du service worker, le seul moment où Chrome vient de les
// lire sur le disque (runtime.onInstalled ne convient pas : avec --load-extension, il revient à chaque démarrage,
// code en cache compris, et onStartup ne vient pas). Au démarrage du navigateur, un service worker sorti du cache
// compare l'empreinte du disque à la sienne. Différente :
// - démarrage ordinaire (onStartup) : l'extension se recharge (une fois par empreinte : pas de boucle) ;
// - extension chargée par --load-extension (onInstalled) : un rechargement la couperait jusqu'au prochain démarrage
//   du navigateur (constaté sur Orion). Elle le signale au démon (/health : extensionStale), au lanceur d'agir.
let codeFreshlyRead = false; // ce service worker vient d'être installé : ses scripts sortent du disque
let codeStale = false; // code en cache différent du disque, rechargement impossible ou déjà tenté
async function diskCodeStamp() {
  const texts = await Promise.all(["background.js", ...SW_SCRIPTS].map((f) =>
    fetch(chrome.runtime.getURL(f), { cache: "no-store" }).then((r) => r.text())));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texts.join("\0")));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
self.addEventListener("install", () => {
  codeFreshlyRead = true;
  diskCodeStamp().then((codeStamp) => chrome.storage.local.set({ codeStamp })).catch(() => {});
});
async function checkCodeOnDisk(canReload) {
  if (codeFreshlyRead) return;
  try {
    const [{ codeStamp, codeReloadFor }, disk] = await Promise.all([chrome.storage.local.get(["codeStamp", "codeReloadFor"]), diskCodeStamp()]);
    if (codeStamp === disk) return;
    if (!codeStamp) return chrome.storage.local.set({ codeStamp: disk });
    if (!canReload || codeReloadFor === disk) {
      codeStale = true;
      return sendSettings();
    }
    await chrome.storage.local.set({ codeReloadFor: disk });
    chrome.runtime.reload();
  } catch {}
}
chrome.runtime.onStartup.addListener(() => checkCodeOnDisk(true));
chrome.runtime.onInstalled.addListener(() => checkCodeOnDisk(false));

// Raccourcis (chrome://extensions/shortcuts) : l'arrêt d'urgence marche même panneau fermé.
chrome.commands.onCommand.addListener((command) => {
  if (command === "stop-all") stopAll().catch(() => {});
  else if (command === "resume-all") resume().catch(() => {});
});

// ---------------------------------------------------------------------------
// Messages du panneau et du document offscreen
// ---------------------------------------------------------------------------

const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}/`;

/** Le message vient-il d'une page de l'extension (panneau, offscreen), et pas d'un script injecté dans un onglet ? */
const fromExtensionPage = (sender) => sender?.id === chrome.runtime.id && !sender.tab && String(sender.url ?? "").startsWith(EXTENSION_ORIGIN);

/** Réponse asynchrone : le résultat de `promise`, ou { ok: false, error } s'il échoue. */
function replyWith(reply, promise) {
  Promise.resolve(promise)
    .then((result) => reply({ ok: true, ...(result !== undefined && { result }) }))
    .catch((err) => reply({ ok: false, error: String(err?.message ?? err), ...(err?.reason && { reason: err.reason }) }));
  return true;
}

/** Diagnostic copiable depuis le panneau : état utile pour un rapport de bug, jamais de secret ni de contenu de page. */
async function diagnostic() {
  const session = await chrome.storage.session.get(["connected", "daemonVersion", "groups"]);
  const local = await chrome.storage.local.get(["foregroundTabs", "scriptsEnabled", "showGestures", "nativePointer", "blocklist"]);
  return {
    extension: chrome.runtime.getManifest().version,
    daemon: session.daemonVersion || null,
    connected: !!session.connected,
    paused,
    pausedAgents: [...pausedAgents],
    browser: navigator.userAgent,
    agentGroups: Object.keys(session.groups ?? {}).length,
    attachedTabs: attached.size,
    runningCalls: [...runningCalls.values()].map((c) => ({ agent: c.actor, tabId: c.tabId ?? null })),
    scripts: scriptRuns.size,
    settings: {
      foregroundTabs: local.foregroundTabs === true,
      scriptsEnabled: local.scriptsEnabled !== false,
      showGestures: local.showGestures !== false,
      nativePointer: local.nativePointer === true,
      blockedSites: (local.blocklist ?? []).length,
    },
    recentErrors: activity.filter((e) => e.status === "error").slice(0, 8)
      .map((e) => ({ t: new Date(e.t).toISOString(), agent: e.agent, tool: e.tool, error: String(e.error ?? "").slice(0, 160) })),
  };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== "object" || msg.target === "offscreen") return;
  if (!fromExtensionPage(sender)) return; // scripts de page : aucun accès aux commandes du panneau

  switch (msg.type) {
    case "script-call": {
      const run = scriptRuns.get(msg.runId);
      if (!run || !String(sender.url).startsWith(`${EXTENSION_ORIGIN}offscreen.html`)) reply(fail("Script inconnu ou terminé."));
      else if (msg.tool === "browser_script") reply(fail("Un script ne peut pas lancer un autre script."));
      else runTool(run.agent, msg.tool, msg.args ?? {}, { parentRun: msg.runId }).then(reply);
      return true;
    }
    case "script-stuck":
      // Le document offscreen signale un script interrompu qui ne rend pas la main. S'il a lui-même
      // détruit l'iframe de ce script (une par script), seul celui-ci s'arrête ; sinon on recrée le document.
      if (msg.handled) scriptRuns.get(msg.runId)?.kill("Script bloqué (boucle infinie ?) : arrêté.");
      else resetOffscreen().catch(() => {});
      return;
    case "reconnect":
      reconnectDelay = 1000;
      connect();
      break;
    case "stop":
      return replyWith(reply, stopAll());
    case "resume":
      return replyWith(reply, resume());
    case "agent-pause":
      return replyWith(reply, setAgentPaused(msg.agent, msg.paused === true));
    case "agent-message":
      return replyWith(reply, postAgentMessage(msg.to, msg.text));
    case "agent-message-cancel":
      return replyWith(reply, cancelAgentMessage(msg.id));
    case "activity-clear":
      clearActivity();
      break;
    case "diagnostic":
      return replyWith(reply, diagnostic());
    case "credentials-state":
      return replyWith(reply, credDek().then((dek) => ({ unlocked: !!dek })));
    case "credential-decision":
      if (!decideCredential(msg.id, msg.decision, { itemId: msg.itemId, remember: msg.remember })) {
        reply({ ok: false, error: "Demande inconnue ou expirée." });
        return;
      }
      break;
    case "bw-unlock-decline":
      bwUnlockSettle({ ok: false, error: "L'utilisateur n'a pas déverrouillé son coffre (refus dans le panneau latéral)." });
      break;
    case "ask-decision":
      if (!decideAsk(msg.id, msg.decision, { note: msg.note })) {
        reply({ ok: false, error: "Demande inconnue ou expirée." });
        return;
      }
      break;
    case "credentials-unlock":
      return replyWith(reply, credUnlock(msg.dek));
    case "credentials-lock":
      return replyWith(reply, credLock().then(() => credDenyPending("Coffre verrouillé par l'utilisateur.")));
    case "bw-status":
    case "bw-unlock":
    case "bw-lock":
    case "bw-sync":
    case "bw-search":
    case "bw-probe":
    case "bw-configure":
    case "bw-login":
    case "bw-logout": {
      // Panneau -> démon (Bitwarden, Vaultwarden). Le mot de passe maître ne transite que sur le WebSocket local.
      const params = {
        "bw-unlock": { password: msg.password ?? "" },
        "bw-search": { query: msg.query ?? "" },
        "bw-probe": { serverUrl: msg.serverUrl ?? "" },
        "bw-configure": { serverUrl: msg.serverUrl ?? "" },
        "bw-login": { email: msg.email ?? "", password: msg.password ?? "", code: msg.code ?? "" },
      }[msg.type] ?? {};
      const call = daemonRpc(msg.type, params);
      // Coffre ouvert depuis le panneau : les agents qui attendaient un déverrouillage repartent.
      if (msg.type === "bw-unlock" || msg.type === "bw-login") call.then(() => bwUnlockSettle({ ok: true }), () => {});
      if (msg.type === "bw-lock" || msg.type === "bw-logout") call.then(() => bwForgetMatches(), () => {});
      return replyWith(reply, call);
    }
    default:
      break;
  }
  reply({ ok: true });
});
connect();
