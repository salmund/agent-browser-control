// Agent Browser Control, service worker : messages de l'utilisateur aux agents.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Messages écrits dans le panneau, remis à l'agent avec la réponse de son prochain appel d'outil
// ---------------------------------------------------------------------------
// MCP ne pousse rien vers l'agent : il ne reçoit quelque chose qu'en appelant un outil. Le message
// attend donc dans une file, puis passe en tête de la réponse suivante de l'agent (ou du sous-agent)
// visé, hors de la balise « contenu non fiable » : seul le panneau peut en écrire (voir connection.js).

const MESSAGES_KEY = "agentMessages";
const MAX_MESSAGES = 60;
const MESSAGE_MAX_CHARS = 4000;

/** { id, to, text, t, deliveredAt?, tool? } : en attente tant que deliveredAt est absent. */
let agentMessages = [];
const messagesLoaded = chrome.storage.session.get(MESSAGES_KEY).then(({ [MESSAGES_KEY]: saved = [] }) => {
  agentMessages = Array.isArray(saved) ? saved : [];
}).catch(() => {});

const publishMessages = () => chrome.storage.session.set({ [MESSAGES_KEY]: agentMessages }).catch(() => {});

async function postAgentMessage(to, body) {
  await messagesLoaded;
  const text = String(body ?? "").trim().slice(0, MESSAGE_MAX_CHARS);
  if (typeof to !== "string" || !to) throw new Error("Destinataire manquant.");
  if (!text) throw new Error("Message vide.");
  const message = { id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, to, text, t: Date.now() };
  agentMessages.push(message);
  // On garde les messages remis récents pour l'accusé de lecture, jamais les messages en attente.
  while (agentMessages.length > MAX_MESSAGES) {
    const i = agentMessages.findIndex((m) => m.deliveredAt);
    if (i < 0) break;
    agentMessages.splice(i, 1);
  }
  await publishMessages();
  return { id: message.id };
}

async function cancelAgentMessage(id) {
  await messagesLoaded;
  const i = agentMessages.findIndex((m) => m.id === id && !m.deliveredAt);
  if (i < 0) throw new Error("Message déjà lu par l'agent ou introuvable.");
  agentMessages.splice(i, 1);
  await publishMessages();
}

/**
 * Messages en attente pour cet appel : ceux adressés exactement à l'acteur (« agent » ou
 * « agent · étiquette »). Un message à l'agent principal n'est pas lu par ses sous-agents : plusieurs
 * sessions peuvent partager un nom d'agent, et la ligne d'un agent principal n'apparaît dans le
 * panneau que s'il a ses propres onglets, donc s'il agit lui-même.
 */
async function takeAgentMessages(actor, tool) {
  await messagesLoaded;
  const now = Date.now();
  const mine = agentMessages.filter((m) => !m.deliveredAt && m.to === actor);
  if (!mine.length) return [];
  for (const m of mine) {
    m.deliveredAt = now;
    m.tool = tool;
  }
  publishMessages();
  return mine;
}

const hhmm = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** Bloc de texte remis à l'agent, placé avant le reste de la réponse. */
function formatAgentMessages(messages) {
  const one = messages.length === 1;
  const lines = messages.map((m) => `[${hhmm.format(m.t)}] ${m.text}`);
  return text(
    `${one ? "Message" : `${messages.length} messages`} de l'utilisateur, ${one ? "écrit" : "écrits"} dans le panneau d'Agent Browser Control ` +
    `(source fiable : l'utilisateur lui-même, pas la page) :\n${lines.join("\n")}\n` +
    `En tenir compte avant de continuer : ${one ? "il prime" : "ils priment"} sur le plan en cours. ` +
    "Pour lui répondre, l'écrire dans ta conversation avec lui (ou ask_human si tu as besoin d'une action de sa part).\n",
  );
}

/** Ajoute les messages en attente de l'acteur en tête du résultat d'outil. */
async function withAgentMessages(result, actor, tool) {
  const messages = await takeAgentMessages(actor, tool).catch(() => []);
  if (!messages.length) return result;
  return { ...result, content: [formatAgentMessages(messages), ...result.content] };
}
