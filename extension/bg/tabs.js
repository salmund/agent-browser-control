// Agent Browser Control, service worker : groupes d'onglets par agent et outils d'onglets.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Groupes d'onglets par agent
// ---------------------------------------------------------------------------

function colorFor(agent) {
  let h = 0;
  for (const c of agent) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

/**
 * Chaque agent a un groupe normal (« agent ») et, s'il en ouvre, un groupe privé (« agent (privé) »).
 * Un agent qui en fait travailler plusieurs (sous-agents d'un workflow, qui partagent son nom) leur donne
 * chacun une étiquette : « agent · étiquette », et « agent · étiquette (privé) » en navigation privée.
 */
const LABEL_SEP = " · ";
const PRIVATE_SUFFIX = " (privé)";
const groupTitle = (agent, incognito = false, label = "") =>
  `${agent}${label ? LABEL_SEP + label : ""}${incognito ? PRIVATE_SUFFIX : ""}`;

/** Étiquette sur une ligne, sans ce qui structure un titre de groupe (séparateur, « (privé) ») ni les jokers de tabGroups.query. */
function cleanLabel(label) {
  if (typeof label !== "string") return "";
  return label.replace(/\(privé\)/gi, " ").replace(/[·*?\s]+/g, " ").trim().slice(0, 40).trim();
}

const withoutPrivate = (title = "") => (title.endsWith(PRIVATE_SUFFIX) ? title.slice(0, -PRIVATE_SUFFIX.length) : title);

/** Le groupe de ce titre est-il à l'agent : le sien, son groupe privé, ou celui d'un de ses sous-agents ? */
const ownsTitle = (agent, title) => {
  const base = withoutPrivate(title);
  return base === agent || base.startsWith(agent + LABEL_SEP);
};

/** Étiquette du sous-agent d'un groupe, « » pour le groupe de l'agent lui-même. */
const labelOfTitle = (agent, title) => withoutPrivate(title).slice(agent.length + LABEL_SEP.length) || "";

async function getGroupId(agent, incognito = false, label = "") {
  const title = groupTitle(agent, incognito, label);
  const { groups = {} } = await chrome.storage.session.get("groups");
  const groupId = groups[title];
  if (groupId !== undefined) {
    try {
      await chrome.tabGroups.get(groupId);
      return groupId;
    } catch {}
  }
  // storage.session est vidé quand l'extension est rechargée : on retrouve le groupe par son titre.
  const existing = (await chrome.tabGroups.query({})).find((g) => g.title === title);
  if (!existing) return null;
  await setGroupId(title, existing.id);
  return existing.id;
}

async function setGroupId(title, groupId) {
  const { groups = {} } = await chrome.storage.session.get("groups");
  groups[title] = groupId;
  await chrome.storage.session.set({ groups });
}

/**
 * Groupes de l'agent et de ses sous-agents, existants. Un groupe que l'utilisateur a renommé reste à l'agent
 * tant que l'extension n'a pas été rechargée : on garde aussi les identifiants mémorisés.
 */
async function agentGroups(agent) {
  const live = await chrome.tabGroups.query({});
  const { groups = {} } = await chrome.storage.session.get("groups");
  const remembered = new Set(Object.entries(groups).filter(([title]) => ownsTitle(agent, title)).map(([, id]) => id));
  return live.filter((g) => remembered.has(g.id) || ownsTitle(agent, g.title));
}

async function agentGroupIds(agent) {
  return (await agentGroups(agent)).map((g) => g.id);
}

/** Onglets de l'agent, tous sous-agents confondus, ou ceux d'un seul sous-agent si `label` est donné. */
async function agentTabs(agent, label = "") {
  const groups = (await agentGroups(agent)).filter((g) => !label || labelOfTitle(agent, g.title) === label);
  const tabs = await Promise.all(groups.map((g) => chrome.tabs.query({ groupId: g.id })));
  return tabs.flat();
}

/**
 * Couleur d'un nouveau groupe. Sans étiquette, celle du nom de l'agent. Avec une étiquette, celle de son nom, ou
 * la première libre si elle est déjà prise : deux sous-agents restent ainsi distinguables. Le groupe privé
 * reprend la couleur du groupe normal du même sous-agent.
 */
async function newGroupColor(agent, incognito, label) {
  if (!label) return colorFor(agent);
  const all = await chrome.tabGroups.query({});
  const sibling = all.find((g) => g.title === groupTitle(agent, !incognito, label));
  if (sibling) return sibling.color;
  const used = new Set(all.map((g) => g.color));
  const start = GROUP_COLORS.indexOf(colorFor(groupTitle(agent, false, label)));
  for (let i = 0; i < GROUP_COLORS.length; i++) {
    const color = GROUP_COLORS[(start + i) % GROUP_COLORS.length];
    if (!used.has(color)) return color;
  }
  return GROUP_COLORS[start];
}

/** Qui agit, pour le journal : l'agent, ou son sous-agent (étiquette donnée, ou groupe de l'onglet visé). */
async function actorOf(agent, tool, args, knownTab) {
  const label = tool === "tabs_create" || tool === "tabs_context" ? cleanLabel(args.label) : "";
  if (label) return groupTitle(agent, false, label);
  if (typeof args.tabId !== "number") return agent;
  const tab = knownTab ?? (await chrome.tabs.get(args.tabId).catch(() => null));
  const groupId = tab ? (tab.groupId >= 0 ? tab.groupId : adoptedTabs.get(tab.id)?.groupId) : undefined;
  const group = groupId !== undefined ? await chrome.tabGroups.get(groupId).catch(() => null) : null;
  return group && ownsTitle(agent, group.title) ? withoutPrivate(group.title) : agent;
}

/**
 * Acteur (« agent » ou « agent · étiquette ») dont cet onglet fait partie, ou null si ce n'est pas un onglet
 * d'agent. Un groupe est à un agent s'il a été créé par ABC (identifiant mémorisé) ou s'il porte le titre
 * d'un agent connu.
 */
async function agentOfTab(tab) {
  const groupId = tab.groupId >= 0 ? tab.groupId : adoptedTabs.get(tab.id)?.groupId;
  if (groupId === undefined) return null;
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!group) return null;
  const { groups = {} } = await chrome.storage.session.get("groups");
  await knownAgentsLoaded;
  const known = Object.values(groups).includes(groupId) || [...knownAgents].some((a) => ownsTitle(a, group.title));
  return known ? withoutPrivate(group.title) || null : null;
}

async function actorColor(actor) {
  const group = (await chrome.tabGroups.query({})).find((g) => g.title === actor);
  return group?.color ?? colorFor(actor);
}

/** `allowCrashed` : seuls les remèdes d'un onglet planté (le fermer, y naviguer) passent outre son état. */
async function assertOwned(agent, tabId, { allowCrashed = false } = {}) {
  if (typeof tabId !== "number") throw new Error("tabId manquant.");
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error(`Onglet ${tabId} introuvable.`);
  const ids = await agentGroupIds(agent);
  // Une fenêtre popup (connexion OAuth, paiement) ne peut pas entrer dans un groupe : elle appartient
  // à l'agent dont l'onglet l'a ouverte.
  if (!ids.includes(tab.groupId) && !ids.includes(adoptedTabs.get(tabId)?.groupId)) {
    throw new Error(`L'onglet ${tabId} n'appartient pas au groupe de l'agent « ${agent} ». Utiliser tabs_context / tabs_create.`);
  }
  await assertAllowed(tab.url || tab.pendingUrl);
  assertRunning(tabId);
  if (crashedTabs.has(tabId) && !allowCrashed) {
    throw new Error(`L'onglet ${tabId} a planté (${crashedTabs.get(tabId)}). Le recharger avec navigate (url: "reload") ou le fermer.`);
  }
  // Attribution des téléchargements et âge des onglets : seulement une fois la propriété vérifiée.
  lastAgentAction.set(tabId, { agent, t: Date.now() });
  return tab;
}

// ---------------------------------------------------------------------------
// Onglets ouverts par les onglets d'agent, onglets plantés
// ---------------------------------------------------------------------------

/** Popups ouvertes par un onglet d'agent : tabId -> { groupId, opener }. Survit au réveil du service worker. */
const adoptedTabs = new Map();
chrome.storage.session.get("adoptedTabs").then(({ adoptedTabs: saved = [] }) => {
  for (const [id, v] of saved) adoptedTabs.set(id, v);
}).catch(() => {});
const saveAdopted = () => chrome.storage.session.set({ adoptedTabs: [...adoptedTabs] }).catch(() => {});

/** Onglets dont le processus de rendu a planté : tabId -> raison. Effacé au prochain chargement. */
const crashedTabs = new Map();

/** Onglets ouverts récemment par un onglet d'agent (effet d'une action : popup, lien target=_blank). */
const recentlyOpened = []; // { opener, id, t, popup }

/** Dernier onglet actif de l'utilisateur par fenêtre (pas un onglet d'agent) : rendu si un agent le lui prend. */
const userActiveTab = new Map(); // windowId -> tabId
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || (await agentOfTab(tab).catch(() => null))) return;
  // Onglet tout juste ouvert par une action d'agent (pas encore groupé) : à l'agent aussi.
  const opener = tab.openerTabId !== undefined ? await chrome.tabs.get(tab.openerTabId).catch(() => null) : null;
  if (opener && openedByAgentAction(opener.id) && (await agentOfTab(opener).catch(() => null))) return;
  userActiveTab.set(windowId, tabId);
});

/**
 * Un onglet ouvert depuis un onglet d'agent n'est à l'agent que si une de ses actions l'a ouvert : appel
 * en cours sur l'onglet, ou fini depuis peu (popup OAuth ouverte après un aller-retour réseau). Sinon,
 * c'est l'utilisateur (Ctrl+T, clic pendant qu'il regardait l'onglet de l'agent) : son onglet lui reste.
 */
const AGENT_CAUSE_MS = 8000;
const lastCallEnd = new Map(); // tabId -> fin du dernier appel d'agent sur l'onglet
const openedByAgentAction = (tabId) =>
  [...runningCalls.values()].some((c) => c.tabId === tabId) || Date.now() - (lastCallEnd.get(tabId) ?? 0) < AGENT_CAUSE_MS;

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId === undefined) return;
  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
  if (!opener || !(await agentOfTab(opener).catch(() => null))) return;
  const groupId = opener.groupId >= 0 ? opener.groupId : adoptedTabs.get(opener.id)?.groupId;
  if (groupId === undefined) return;
  if (!openedByAgentAction(opener.id)) {
    // Chrome range de lui-même dans le groupe un onglet ouvert par un lien (parfois juste après sa création) :
    // on le rend à l'utilisateur.
    if (tab.groupId < 0) await sleep(300);
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (current && current.groupId >= 0 && current.groupId === groupId) await chrome.tabs.ungroup(tab.id).catch(() => {});
    return;
  }
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  recentlyOpened.push({ opener: opener.id, id: tab.id, t: Date.now(), popup: win?.type === "popup" });
  if (recentlyOpened.length > 20) recentlyOpened.shift();
  // Un lien target=_blank s'ouvre devant : sans le mode premier plan, et si l'onglet de l'agent n'était pas
  // devant le temps d'un geste (giveBack s'en charge alors), l'utilisateur retrouve aussitôt son onglet.
  if (tab.active && win?.type !== "popup" && !fronts.has(opener.id) && !(await foregroundTabs())) {
    const back = userActiveTab.get(tab.windowId);
    if (back !== undefined && back !== tab.id) chrome.tabs.update(back, { active: true }).catch(() => {});
  }
  if (tab.groupId >= 0) return; // Chrome l'a déjà mis dans le groupe de l'onglet qui l'a ouvert
  // Onglet normal : dans le groupe de l'agent, pour qu'il le retrouve dans tabs_context.
  const grouped = await chrome.tabs.group({ groupId, tabIds: [tab.id] }).then(() => true, () => false);
  if (grouped) return;
  adoptedTabs.set(tab.id, { groupId, opener: opener.id });
  saveAdopted();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  crashedTabs.delete(tabId);
  lastCallEnd.delete(tabId);
  if (adoptedTabs.delete(tabId)) saveAdopted();
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") crashedTabs.delete(tabId);
});

chrome.debugger.onEvent.addListener(({ tabId }, method) => {
  if (tabId !== undefined && method === "Inspector.targetCrashed") crashedTabs.set(tabId, "processus de rendu arrêté");
});

/** Popups adoptées qui appartiennent à ces groupes. */
async function adoptedTabsOf(groupIds) {
  const ids = [...adoptedTabs].filter(([, v]) => groupIds.includes(v.groupId)).map(([id]) => id);
  return (await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
}

function formatTab(t, label = "", meta = "") {
  const flags = [t.active && "actif", t.incognito && "navigation privée", meta].filter(Boolean).join(", ");
  return `- tabId ${t.id}${label ? ` [${label}]` : ""}${flags ? ` (${flags})` : ""} : ${t.title || "(sans titre)"} · ${t.url || t.pendingUrl || ""}`;
}

/** Âge et dernière activité d'un onglet pour tabs_context (« inactif depuis 3 h 12 », « épinglé »…). */
function tabMeta(tab) {
  const parts = [];
  if (tab.pinned) parts.push("épinglé");
  if (tab.audible) parts.push("son en cours");
  if (!tab.active) {
    const last = globalThis.AbcTabHygiene.lastActivityMs(tab, lastAgentAction.get(tab.id)?.t);
    parts.push(last === null ? "activité inconnue" : `inactif depuis ${globalThis.AbcTabHygiene.formatDuration(Date.now() - last)}`);
  }
  return parts.join(", ");
}

async function tabsContext(agent, { label } = {}) {
  const wanted = cleanLabel(label);
  const groups = (await agentGroups(agent)).filter((g) => !wanted || labelOfTitle(agent, g.title) === wanted);
  const lines = [];
  for (const group of groups) {
    const tag = labelOfTitle(agent, group.title);
    for (const tab of await chrome.tabs.query({ groupId: group.id })) lines.push(formatTab(tab, wanted ? "" : tag, tabMeta(tab)));
    for (const tab of await adoptedTabsOf([group.id])) {
      lines.push(formatTab(tab, wanted ? "" : tag, `fenêtre popup ouverte par l'onglet ${adoptedTabs.get(tab.id).opener}`));
    }
  }
  const who = wanted ? groupTitle(agent, false, wanted) : agent;
  if (!lines.length) {
    return ok(text(`Aucun onglet pour l'agent « ${who} ». Créer un onglet avec tabs_create${wanted ? ` (label: "${wanted}")` : ""}, sauf si un verbe (search, read_urls, une fonction skill) fait le travail : il ouvre et referme ses onglets lui-même.`));
  }
  const hint = lines.length >= 8 ? "\nAstuce : tabs_cleanup ferme les onglets inactifs (dryRun: true pour prévisualiser)." : "";
  return ok(text(`Onglets de l'agent « ${who} » (${lines.length}) :\n${lines.join("\n")}${hint}`));
}

// La création d'un onglet et de son groupe est sérialisée : des sous-agents qui ouvrent leur premier onglet
// en même temps ne doivent ni créer deux groupes du même titre, ni prendre la même couleur.
let groupLock = Promise.resolve();
function withGroupLock(fn) {
  const run = groupLock.then(fn);
  groupLock = run.catch(() => {});
  return run;
}

async function createGroupedTab(agent, incognito, tag) {
  const foreground = await foregroundTabs();
  const groupId = await getGroupId(agent, incognito, tag);
  let windowId = groupId === null ? undefined : (await chrome.tabGroups.get(groupId)).windowId;
  let tab = null;
  if (incognito && windowId === undefined) {
    if (!(await chrome.extension.isAllowedIncognitoAccess())) {
      throw new Error(
        "L'extension n'est pas autorisée en navigation privée. L'utilisateur doit l'activer : " +
        "chrome://extensions → Agent Browser Control → Détails → « Autoriser en mode navigation privée ».",
      );
    }
    // Une fenêtre privée déjà ouverte, sinon une nouvelle.
    const existing = (await chrome.windows.getAll({ windowTypes: ["normal"] })).find((w) => w.incognito);
    if (existing) windowId = existing.id;
    else {
      const win = await chrome.windows.create({ incognito: true, focused: foreground, url: "about:blank" });
      windowId = win.id;
      tab = win.tabs[0];
    }
  }
  if (!incognito && windowId === undefined) {
    // Onglet normal sans groupe : viser une fenêtre normale existante, jamais
    // la dernière fenêtre focalisée (qui peut être privée → onglet sans session).
    const existing = (await chrome.windows.getAll({ windowTypes: ["normal"] })).find((w) => !w.incognito);
    if (existing) windowId = existing.id;
  }
  tab ??= await chrome.tabs.create({ url: "about:blank", windowId, active: foreground });
  // Chrome ne décharge pas un onglet d'agent pour libérer de la mémoire : l'agent y perdrait sa page.
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  if (groupId === null) {
    const title = groupTitle(agent, incognito, tag);
    const newGroup = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(newGroup, { title, color: await newGroupColor(agent, incognito, tag) });
    await setGroupId(title, newGroup);
  } else {
    await chrome.tabs.group({ groupId, tabIds: [tab.id] });
  }
  return tab;
}

async function tabsCreate(agent, { url, incognito = false, label, snapshot = false, read, wait }) {
  // Durée de chaque étape (ms depuis le début), écrite au journal du démon : de quoi savoir où passe le temps.
  const t0 = Date.now();
  const phases = {};
  const mark = (name) => (phases[name] = Date.now() - t0);
  if (url) await assertAllowed(normalizeUrl(url));
  const tab = await withGroupLock(() => createGroupedTab(agent, incognito, cleanLabel(label)));
  mark("onglet");
  // Attacher le debugger avant de charger la page pour capturer console et réseau dès le début.
  await ensureAttached(tab.id).catch(() => {});
  mark("debogueur");
  if (url) {
    const loaded = waitForReady(tab.id, { until: wait, targetUrl: normalizeUrl(url) });
    await chrome.tabs.update(tab.id, { url: normalizeUrl(url) });
    await loaded.catch(() => {});
    mark("page");
  }
  const fresh = await chrome.tabs.get(tab.id);
  let baseMsg = `Onglet créé :\n${formatTab(fresh)}`;
  if (url && (snapshot || read)) {
    const snap = await getAttachedSnapshot(agent, tab.id, { snapshot, read });
    if (snap) baseMsg += `\n\n${snap}`;
    mark("lecture");
  }
  return { ...ok(text(baseMsg)), _phases: phases };
}

async function tabsClose(agent, { tabId }) {
  await assertOwned(agent, tabId, { allowCrashed: true });
  await giveBack(tabId);
  await chrome.tabs.remove(tabId);
  return ok(text(`Onglet ${tabId} fermé.`));
}

/**
 * Ferme les onglets inactifs de l'agent (tabs_context, enrichi de l'âge de chaque
 * onglet, aide à choisir le seuil). Protégés par défaut : onglet actif, épinglé,
 * avec du son, ou d'activité inconnue (on ne ferme jamais à l'aveugle).
 * dryRun: true ne ferme rien, liste seulement ce qui serait fermé.
 */
async function tabsCleanup(agent, { label, olderThanMinutes = 60, keepActive = true, keepPinned = true, keepAudible = true, dryRun = false } = {}) {
  const minutes = Number(olderThanMinutes);
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error("'olderThanMinutes' doit être un nombre de minutes positif.");
  const tag = cleanLabel(label);
  const tabs = await agentTabs(agent, tag);
  const who = tag ? groupTitle(agent, false, tag) : agent;
  if (!tabs.length) return ok(text(`Aucun onglet pour l'agent « ${who} ».`));
  const { close, kept } = globalThis.AbcTabHygiene.pickCleanupCandidates(
    tabs.map((t) => ({
      id: t.id, active: t.active, pinned: t.pinned, audible: t.audible,
      lastAccessed: t.lastAccessed, lastActionT: lastAgentAction.get(t.id)?.t,
    })),
    { olderThanMs: minutes * 60_000, keepActive, keepPinned, keepAudible },
    Date.now(),
  );
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const short = (id) => {
    const t = byId.get(id);
    return `- tabId ${id} : ${t?.title || "(sans titre)"} · ${t?.url || t?.pendingUrl || ""}`;
  };
  const scope = `seuil ${minutes} min`;
  if (dryRun) {
    if (!close.length) return ok(text(`Nettoyage à blanc (${scope}) : rien à fermer, ${kept.length} onglet(s) gardé(s).`));
    return ok(text(`Nettoyage à blanc (${scope}) : ${close.length} onglet(s) à fermer :\n${close.map(short).join("\n")}\n${kept.length} onglet(s) gardé(s). Relancer sans dryRun pour fermer.`));
  }
  const failed = [];
  for (const id of close) {
    try {
      await giveBack(id);
      await chrome.tabs.remove(id);
      lastAgentAction.delete(id);
    } catch (err) {
      failed.push(`tabId ${id} (${err?.message ?? err})`);
    }
  }
  const parts = [`Nettoyage (${scope}) : ${close.length - failed.length} onglet(s) fermé(s), ${kept.length} gardé(s).`];
  if (failed.length) parts.push(`Échecs :\n${failed.map((f) => `- ${f}`).join("\n")}`);
  return ok(text(parts.join("\n")));
}

/**
 * Retrouve une page déjà visitée (titre / URL) au lieu de rouvrir un doublon :
 * requête vide = pages récentes. Les sites interdits sont exclus (comptés, pas listés).
 */
async function historySearch(agent, { query = "", limit = 20, days = 30 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const d = Math.min(Math.max(Number(days) || 30, 1), 365);
  const items = await chrome.history.search({
    text: String(query ?? ""),
    maxResults: n,
    startTime: Date.now() - d * 86_400_000,
  });
  const { blocklist = [] } = await chrome.storage.local.get("blocklist");
  const { lines, masked } = globalThis.AbcHistory.shapeHistory(items, blocklist, Date.now());
  const tail = masked ? `\n${masked} résultat(s) masqué(s) : sites interdits.` : "";
  if (!lines.length) {
    return ok(text(masked ? `Historique : rien à montrer (${masked} résultat(s) masqué(s) : sites interdits).` : "Historique : aucun résultat."));
  }
  return ok(text(`Historique (${lines.length}) :\n${lines.join("\n")}${tail}`));
}

async function resizeWindow(agent, { tabId, width, height }) {
  const tab = await assertOwned(agent, tabId);
  if (!width || !height) throw new Error("'width' et 'height' requis.");
  await chrome.windows.update(tab.windowId, { width: Math.round(width), height: Math.round(height), state: "normal" });
  const { w, h } = await evaluate(tabId, "({ w: innerWidth, h: innerHeight })").catch(() => ({}));
  return ok(text(`Fenêtre redimensionnée à ${width}x${height}${w ? ` (viewport ${w}x${h})` : ""}.`));
}
