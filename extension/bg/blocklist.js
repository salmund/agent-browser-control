// Agent Browser Control, service worker : sites interdits.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Sites interdits
// ---------------------------------------------------------------------------

/** Domaine comparable : minuscules, sans point final, sans www. ; une entrée de liste peut être une URL. */
function normalizeHost(value) {
  let s = String(value ?? "").trim().toLowerCase();
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*:/.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return "";
    }
  }
  return s.replace(/^\*\./, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/\.$/, "").replace(/^www\./, "");
}

/** Hôte réel d'une URL : blob: et filesystem: portent l'origine qui les a créés. */
function hostForBlocklist(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "blob:" || u.protocol === "filesystem:") return hostForBlocklist(u.pathname);
    return normalizeHost(u.hostname);
  } catch {
    return "";
  }
}

let blocklistCache = null;
chrome.storage.local.onChanged.addListener((changes) => {
  if ("blocklist" in changes) blocklistCache = null;
});

async function blocklistEntries() {
  if (!blocklistCache) {
    const { blocklist = [] } = await chrome.storage.local.get("blocklist");
    blocklistCache = blocklist.map(normalizeHost).filter(Boolean);
  }
  return blocklistCache;
}

/** Entrée de la liste qui couvre cette URL, ou null. */
async function blockedBy(url) {
  const host = hostForBlocklist(url);
  if (!host) return null;
  return (await blocklistEntries()).find((d) => host === d || host.endsWith(`.${d}`)) ?? null;
}

async function assertAllowed(url) {
  // Les pages de l'extension (panneau, coffre) parlent au service worker avec les droits de l'utilisateur :
  // un agent qui y exécuterait du JavaScript pourrait approuver ses propres demandes de secret.
  if (String(url ?? "").startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
    throw new Error("Les pages d'Agent Browser Control (panneau, secrets) sont réservées à l'utilisateur : un agent ne peut ni les ouvrir ni y agir.");
  }
  const hit = await blockedBy(url);
  if (hit) throw new Error(`Le site ${hostForBlocklist(url)} est interdit aux agents (liste de blocage : ${hit}).`);
}

// Une redirection, un lien ou un script peuvent mener un onglet d'agent vers un site interdit sans
// passer par navigate : on le ramène aussitôt sur une page vide.
chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (!change.url || tab.groupId < 0) return;
  const hit = await blockedBy(change.url).catch(() => null);
  if (!hit) return;
  const actor = await agentOfTab(tab).catch(() => null);
  if (!actor) return;
  await chrome.tabs.update(tabId, { url: "about:blank" }).catch(() => {});
  logActivity({
    id: ++activityId, t: Date.now(), agent: actor, color: await actorColor(actor).catch(() => "grey"), tool: "navigate",
    summary: `Site interdit quitté : ${hit}`, target: hit, host: hit, tabId, status: "error",
    error: `L'onglet est arrivé sur ${hit}, qui est dans la liste de blocage : il a été vidé.`, ms: 0,
  });
});
