// Agent Browser Control, service worker : téléchargements.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// downloads : télécharger un fichier avec la session de l'utilisateur, attendre un téléchargement
// déclenché par un clic, lister ceux de l'agent. Un agent ne voit que les siens, jamais l'historique.
// ---------------------------------------------------------------------------

const lastAgentAction = new Map(); // tabId -> { agent, t } : dernier outil appelé sur l'onglet
const agentDownloads = new Map(); // downloadId -> { agent, tabId, t }
const downloadWaiters = new Set(); // (downloadId, agent) => void

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

// Un téléchargement qui démarre juste après une action d'agent, depuis l'origine de son onglet, est le sien.
chrome.downloads.onCreated.addListener(async (item) => {
  if (agentDownloads.has(item.id)) return;
  for (const [tabId, act] of lastAgentAction) {
    if (Date.now() - act.t > 15_000) continue;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const origin = originOf(tab?.url);
    if (origin && [item.referrer, item.url, item.finalUrl].some((u) => originOf(u) === origin)) {
      agentDownloads.set(item.id, { agent: act.agent, tabId, t: Date.now() });
      for (const cb of downloadWaiters) cb(item.id, act.agent);
      return;
    }
  }
});

function formatBytes(n) {
  if (!n || n < 0) return "taille inconnue";
  return n > 1_048_576 ? `${(n / 1_048_576).toFixed(1).replace(".", ",")} Mo` : `${Math.round(n / 1024)} Ko`;
}

/** Attend la fin d'un téléchargement ; renvoie l'élément final. */
function downloadDone(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const check = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (!item) return finish(reject, new Error("Téléchargement introuvable."));
      if (item.state === "complete") return finish(resolve, item);
      if (item.state === "interrupted") return finish(reject, new Error(`Téléchargement interrompu (${item.error ?? "erreur inconnue"}).`));
      if (item.danger && !["safe", "accepted"].includes(item.danger)) {
        return finish(reject, new Error(`Le navigateur bloque ce fichier comme potentiellement dangereux (${item.danger}) : c'est à l'utilisateur d'en décider.`));
      }
    };
    const listener = (delta) => delta.id === id && check();
    const timer = setTimeout(() => finish(reject, new Error(`Toujours en cours après ${timeoutMs / 1000} s ; relancer downloads action=wait plus tard.`)), timeoutMs);
    function finish(fn, value) {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      fn(value);
    }
    chrome.downloads.onChanged.addListener(listener);
    check();
  });
}

const READABLE = /\.(pdf|docx|pptx|xlsx|txt|md|csv|json|srt|vtt|html?|xml|log)$/i;
const describeDownload = (item) =>
  `${item.filename.split(/[\\/]/).pop()} (${formatBytes(item.fileSize || item.totalBytes)})\n` +
  `Chemin : ${item.filename}\nSource : ${item.finalUrl || item.url}` +
  (READABLE.test(item.filename) ? `\nPour le lire : read_document avec path="${item.filename.replace(/\\/g, "/")}"` : "");

async function downloads(agent, args) {
  const { action = "list", tabId } = args;
  const timeoutMs = Math.min(Math.max(Number(args.timeout ?? 60), 1), 280) * 1000;

  if (action === "download") {
    let url = args.url;
    if (args.ref) {
      await assertOwned(agent, tabId);
      const target = parseRef(args.ref);
      url = await inPage(tabId, "linkHref", target.ref, target.frameId);
    } else if (typeof tabId === "number") {
      await assertOwned(agent, tabId);
    }
    if (!/^https?:\/\//i.test(url ?? "")) throw new Error("'url' (http, https) ou 'ref' d'un lien requis.");
    await assertAllowed(url);
    const safe = args.filename ? String(args.filename).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 150) : null;
    const id = await chrome.downloads.download({
      url,
      saveAs: false,
      conflictAction: "uniquify",
      ...(safe ? { filename: `agent-browser-control/${safe}` } : {}),
    });
    agentDownloads.set(id, { agent, tabId, t: Date.now() });
    const item = await downloadDone(id, timeoutMs);
    return ok(text(`Téléchargé : ${describeDownload(item)}`));
  }

  if (action === "wait") {
    // Un téléchargement de l'agent déjà apparu dans les 30 dernières secondes, sinon le prochain.
    const recent = [...agentDownloads].filter(([, d]) => d.agent === agent && Date.now() - d.t < 30_000).map(([id]) => id);
    const id = recent.at(-1) ?? await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        downloadWaiters.delete(cb);
        reject(new Error(`Aucun téléchargement n'a démarré en ${timeoutMs / 1000} s. Vérifier que le clic a bien lancé un téléchargement (ou utiliser action=download avec le lien).`));
      }, timeoutMs);
      const cb = (downloadId, who) => {
        if (who !== agent) return;
        clearTimeout(timer);
        downloadWaiters.delete(cb);
        resolve(downloadId);
      };
      downloadWaiters.add(cb);
    });
    const item = await downloadDone(id, timeoutMs);
    return ok(text(`Téléchargé : ${describeDownload(item)}`));
  }

  if (action === "list") {
    const mine = [...agentDownloads].filter(([, d]) => d.agent === agent);
    if (!mine.length) return ok(text("Aucun téléchargement de cet agent depuis le démarrage de l'extension."));
    const lines = [];
    for (const [id] of mine.slice(-30)) {
      const [item] = await chrome.downloads.search({ id });
      if (!item) continue;
      const state = { complete: "terminé", in_progress: "en cours", interrupted: `interrompu (${item.error})` }[item.state] ?? item.state;
      lines.push(`- [${state}] ${item.filename}  (${formatBytes(item.fileSize || item.totalBytes)})`);
    }
    return ok(text(`Téléchargements de l'agent :\n${lines.join("\n")}`));
  }

  throw new Error("action attendue : download, wait ou list.");
}
