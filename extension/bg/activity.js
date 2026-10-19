// Agent Browser Control, service worker : journal d'activité du panneau.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Journal d'activité (affiché dans le panneau latéral)
// ---------------------------------------------------------------------------

const activity = [];
let activityId = 0;

// storage.session survit au réveil du service worker : on reprend le journal au lieu de l'écraser.
const activityLoaded = chrome.storage.session.get("activity").then(({ activity: saved = [] }) => {
  for (const e of saved.slice(0, MAX_ACTIVITY)) {
    // Un appel « en cours » quand le service worker s'est arrêté n'aura jamais de fin.
    activity.push(e.status === "running" ? { ...e, status: "error", error: "Interrompu (le service worker a redémarré)." } : e);
  }
  activityId = activity.reduce((max, e) => Math.max(max, Number(e.id) || 0), 0);
}).catch(() => {});

const clip = (s, n = 120) => (typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : "");

function summarize(tool, args) {
  const parts = [];
  if (tool === "credentials_fill" && Array.isArray(args.fills)) {
    // Références opaques uniquement : aucune valeur ne transite par cet outil.
    parts.push(args.fills.map((f) => f?.ref).join(", "));
    parts.push(`[${[...new Set(args.fills.map((f) => f?.slot))].join(", ")}]`);
    if (args.submitRef) parts.push(`-> ${args.submitRef}`);
    return parts.join(" ").slice(0, 120);
  }
  if (args.action) parts.push(tool === "devtools" && args.op ? `${args.action} ${args.op}` : args.action);
  if (typeof args.url === "string") parts.push(args.url);
  if (args.ref) parts.push(args.ref);
  if (Array.isArray(args.coordinate)) parts.push(`(${args.coordinate.join(", ")})`);
  if (args.query) parts.push(JSON.stringify(args.query));
  if (args.item) parts.push(args.item);
  if (args.selector) parts.push(args.selector);
  if (args.urlPattern) parts.push(args.urlPattern);
  if (tool === "computer" && args.action === "key" && args.text) parts.push(args.text);
  if (Array.isArray(args.steps)) parts.push(`${args.steps.length} étapes`);
  return parts.join(" ").slice(0, 120);
}

/**
 * Ce sur quoi porte l'action, pour la phrase du panneau (« Cherche "Refuser" », « Va sur wikipedia.org »).
 * Jamais de texte saisi (type) ni de valeur de champ : ils peuvent être sensibles.
 */
function activityTarget(tool, args) {
  switch (tool) {
    case "navigate":
    case "tabs_create":
      return clip(args.url, 200);
    case "find":
    case "history_search":
      return args.query ? `« ${clip(String(args.query), 60)} »` : "";
    case "wait_for": {
      const what = args.text ?? args.selector ?? args.textGone ?? args.urlContains ?? args.countStable?.selector;
      if (what) return `« ${clip(String(what), 60)} »`;
      if (args.authSettled) return "la fin de la connexion";
      if (args.settle || args.networkIdle || args.domSettled) return "que la page soit prête";
      return "";
    }
    case "computer":
      // Les refs et coordonnées ne parlent pas à l'utilisateur : elles restent dans le détail (summary).
      if (args.action === "key") return clip(args.text ?? "", 40);
      if (args.action === "scroll" && args.scroll_direction) return { up: "vers le haut", down: "vers le bas", left: "vers la gauche", right: "vers la droite" }[args.scroll_direction] ?? "";
      return "";
    case "form_input": {
      const n = Array.isArray(args.fields) ? args.fields.length : args.ref ? 1 : 0;
      return n > 1 ? `${n} champs` : "";
    }
    case "scroll_extract":
      return clip(args.item ?? "", 60);
    case "query":
    case "read_tables":
      return clip(args.selector ?? "", 60);
    case "ask_human":
      return clip(args.question ?? "", 80);
    case "site_api":
    case "downloads":
    case "devtools":
      return clip([args.op, args.site, args.url, args.urlPattern].filter(Boolean).join(" "), 80);
    default:
      return "";
  }
}

let publishTimer = null;
/** Le panneau relit tout le tableau : on regroupe les écritures (un script d'agent en fait des centaines). */
function publishActivity({ now = false } = {}) {
  clearTimeout(publishTimer);
  if (now) {
    chrome.storage.session.set({ activity }).catch(() => {});
    return;
  }
  publishTimer = setTimeout(() => chrome.storage.session.set({ activity }).catch(() => {}), 120);
}

function logActivity(entry) {
  activity.unshift(entry);
  activity.length = Math.min(activity.length, MAX_ACTIVITY);
  publishActivity();
}

function clearActivity() {
  activity.length = 0;
  publishActivity({ now: true });
}

// --- Registre des agents ------------------------------------------------------------------
// storage.session (et donc la table titre -> groupe) est vidé au rechargement de l'extension : le panneau
// retrouve les groupes des agents par leur nom, gardé ici dans storage.local.

const knownAgents = new Set();
const knownAgentsLoaded = chrome.storage.local.get("knownAgents").then(({ knownAgents: list = [] }) => {
  for (const a of list) knownAgents.add(a);
}).catch(() => {});

async function rememberAgent(agent) {
  await knownAgentsLoaded;
  if (!agent || knownAgents.has(agent)) return;
  knownAgents.add(agent);
  // Les noms d'agents de test (e2e-…) n'ont pas à s'accumuler : on garde les 30 plus récents.
  const list = [...knownAgents].slice(-30);
  await chrome.storage.local.set({ knownAgents: list }).catch(() => {});
}
