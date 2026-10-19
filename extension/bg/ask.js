// Agent Browser Control, service worker : passage de main (ask_human).
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// ask_human : passage de main à l'utilisateur dans le vrai onglet
// ---------------------------------------------------------------------------

const ASK_KEY = "askRequests";

/** Demandes en attente : id -> { resolve, timer }. Même pattern que credPending. */
const askPending = new Map();
let askCounter = Date.now() % 100_000; // ids distincts d'une vie du service worker à l'autre

// Les promesses des demandes meurent avec le service worker : au démarrage, celles qui restent affichées
// dans le panneau n'ont plus personne pour les attendre.
chrome.storage.session.set({ [ASK_KEY]: [], credApprovals: [] }).catch(() => {});

/** Notification système d'une demande qui attend l'utilisateur (le panneau peut être fermé). */
function notifyRequest(id, title, message) {
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon-48.png",
    title,
    message: message.slice(0, 200),
    requireInteraction: true,
    priority: 2,
  }).catch(() => {});
}

// Un clic sur la notification ouvre le panneau (là où l'on répond) dans la fenêtre courante.
chrome.notifications.onClicked.addListener(async (id) => {
  if (!/^(ask_|cred-)/.test(id)) return;
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (win) chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
  chrome.notifications.clear(id).catch(() => {});
});

async function askPublish(list) {
  await chrome.storage.session.set({ [ASK_KEY]: list });
}

async function askDrop(id) {
  const { [ASK_KEY]: current = [] } = await chrome.storage.session.get(ASK_KEY);
  await askPublish(current.filter((a) => a.id !== id));
}

/** Toute demande en attente est annulée (STOP). */
async function askDenyPending(reason) {
  for (const [id, p] of [...askPending]) {
    clearTimeout(p.timer);
    askPending.delete(id);
    await askDrop(id);
    chrome.notifications.clear(id).catch(() => {});
    p.resolve({ ok: false, error: reason });
  }
}

/**
 * L'agent passe la main : captcha, 2FA, choix ambigu, validation. L'onglet passe
 * devant, une notification + une demande dans le panneau affichent la question ;
 * l'outil répond quand l'utilisateur clique « C'est fait » (note éventuelle) ou
 * « Annuler ». Retour : effet constaté dans la page + note. Pas de restauration
 * de l'onglet : l'utilisateur vient d'y agir, on l'y laisse (comme l'auth).
 */
async function askHuman(agent, { tabId, question, context, timeout }) {
  const tab = await assertOwned(agent, tabId);
  if (typeof question !== "string" || !question.trim()) {
    throw new Error("'question' requise : que doit faire ou décider l'utilisateur ?");
  }
  const limitMs = Math.min(Math.max(Number(timeout ?? 300) * 1000 || 300_000, 10_000), 600_000);
  const before = await inPage(tabId, "pageDigest").catch(() => null);
  await bringToFront(tab);
  const id = `ask_${++askCounter}`;
  const entry = {
    id, agent, tabId,
    question: question.trim().slice(0, 2000),
    context: String(context ?? "").trim().slice(0, 2000),
    url: tab.url ?? "", title: tab.title ?? "", at: Date.now(), until: Date.now() + limitMs,
  };
  const { [ASK_KEY]: current = [] } = await chrome.storage.session.get(ASK_KEY);
  await askPublish([...current, entry]);
  notifyRequest(id, `Agent ${agent} : action requise`, entry.question);
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  try {
    const decision = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        askPending.delete(id);
        askDrop(id).catch(() => {});
        chrome.notifications.clear(id).catch(() => {});
        resolve({ ok: false, error: `Sans réponse de l'utilisateur après ${Math.round(limitMs / 1000)} s : annuler, reformuler la demande, ou continuer sans lui.` });
      }, limitMs);
      askPending.set(id, { resolve, timer });
    });
    if (!decision.ok) return fail(decision.error);
    const after = await inPage(tabId, "pageDigest").catch(() => null);
    const delta = before && after ? formatDelta(before, after) : "";
    const note = decision.note ? `\nNote de l'utilisateur : ${untrusted(decision.note)}` : "";
    await recordFrame(tabId, `ask_human ${id}`);
    return ok(text(`Utilisateur : fait.${delta && delta !== "inchangé" ? `\nEffet constaté : ${delta}` : ""}${note}`));
  } finally {
    chrome.notifications.clear(id).catch(() => {});
    await askDrop(id).catch(() => {});
  }
}
