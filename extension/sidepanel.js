const $ = (id) => document.getElementById(id);

let activity = [];
let agentFilter = null;

// --- Statut + arrêt d'urgence ---------------------------------------------------

function renderStatus({ connected, paused }) {
  $("status").dataset.state = connected ? "on" : "off";
  $("status-title").textContent = connected ? "Connecté au démon" : "Démon arrêté";
  $("status-hint").textContent = connected ? "" : "Il démarre tout seul dès qu'un agent se connecte.";

  $("estop").dataset.paused = String(!!paused);
  $("stop").disabled = !!paused;
  $("stop-label").textContent = paused ? "Agents arrêtés" : "Arrêter tous les agents";
  $("estop-caption").textContent = paused
    ? "Agents arrêtés. Leurs demandes sont refusées jusqu'au réarmement."
    : "Coupe les actions en cours et libère les onglets pilotés.";
  $("resume").hidden = !paused;
}

$("stop").onclick = () => chrome.runtime.sendMessage({ type: "stop" });
$("resume").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "resume" });
  $("stop").focus();
};
$("reconnect").onclick = () => chrome.runtime.sendMessage({ type: "reconnect" });

// --- Agents + journal ------------------------------------------------------------

const time = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function duration(ms) {
  if (ms == null) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

/** Agents connus (groupe d'onglets ou activité), avec leur groupe s'il existe encore. */
async function agentGroups() {
  const { groups = {} } = await chrome.storage.session.get("groups");
  const names = new Set([...Object.keys(groups), ...activity.map((a) => a.agent)]);
  const result = [];
  for (const agent of names) {
    let group = null;
    try {
      group = groups[agent] !== undefined ? await chrome.tabGroups.get(groups[agent]) : null;
    } catch {}
    // Après un rechargement de l'extension, le groupe se retrouve par son titre.
    group ??= (await chrome.tabGroups.query({ title: agent }))[0] ?? null;
    const tabs = group ? await chrome.tabs.query({ groupId: group.id }) : [];
    const color = group?.color ?? activity.find((a) => a.agent === agent)?.color ?? "grey";
    result.push({ agent, group, tabs, color });
  }
  return result.sort((a, b) => b.tabs.length - a.tabs.length || a.agent.localeCompare(b.agent));
}

/** Met au premier plan le groupe d'onglets de l'agent : fenêtre, groupe déplié, onglet actif. */
async function focusAgent({ group, tabs }) {
  const tab = tabs.find((t) => t.active) ?? tabs.at(-1);
  await chrome.tabGroups.update(group.id, { collapsed: false });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function renderAgents() {
  const all = await agentGroups();
  // Un agent sans onglet dont les sous-agents (« agent · étiquette ») ont les leurs ne garde pas sa pastille.
  const agents = all.filter((a) => a.tabs.length || !all.some((b) => b.agent.startsWith(`${a.agent} · `)));
  $("agent-chips").replaceChildren(...agents.map((a) => {
    const chip = el("button", "agent-chip");
    chip.type = "button";
    chip.style.setProperty("--c", `var(--grp-${a.color})`);
    const n = a.tabs.length;
    chip.append(el("span", null, a.agent), el("span", "count", n ? `${n} onglet${n > 1 ? "s" : ""}` : "aucun onglet"));
    chip.disabled = !n;
    chip.title = n ? `Aller aux onglets de ${a.agent}` : `${a.agent} n'a plus d'onglet ouvert`;
    chip.onclick = () => focusAgent(a);
    return chip;
  }));

  const select = $("agent-filter");
  const names = [...new Set(activity.map((a) => a.agent))];
  if (agentFilter && !names.includes(agentFilter)) agentFilter = null;
  select.replaceChildren(el("option", null, "Tous les agents"), ...names.map((n) => el("option", null, n)));
  select.options[0].value = "";
  select.value = agentFilter ?? "";
}

$("agent-filter").onchange = (event) => {
  agentFilter = event.target.value || null;
  renderActivity();
};

// Les pastilles suivent l'ouverture et la fermeture des onglets des agents.
let agentsTimer = null;
const refreshAgents = () => {
  clearTimeout(agentsTimer);
  agentsTimer = setTimeout(renderAgents, 150);
};
chrome.tabs.onCreated.addListener(refreshAgents);
chrome.tabs.onRemoved.addListener(refreshAgents);
chrome.tabs.onUpdated.addListener((_id, info) => "groupId" in info && refreshAgents());
chrome.tabGroups.onUpdated.addListener(refreshAgents);
chrome.tabGroups.onRemoved.addListener(refreshAgents);

function renderActivity() {
  const rows = activity.filter((a) => !agentFilter || a.agent === agentFilter);
  $("activity-empty").hidden = rows.length > 0;
  $("activity").hidden = rows.length === 0;

  $("activity").replaceChildren(...rows.map((a) => {
    const li = el("li", "entry");
    li.dataset.status = a.status;
    li.style.setProperty("--c", `var(--grp-${a.color ?? "grey"})`);

    const main = el("div", "entry-main");
    const title = el("div");
    title.append(el("span", "entry-tool", a.tool));
    if (!agentFilter) title.append(el("span", "entry-agent", a.agent));
    main.append(title);
    if (a.summary) {
      const detail = el("span", "entry-detail", a.summary);
      detail.title = a.summary;
      main.append(detail);
    }
    if (a.status === "error" && a.error) main.append(el("span", "entry-error", a.error));

    const meta = el("div", "entry-meta");
    const state = { running: "En cours", ok: duration(a.ms), error: "Échec" }[a.status] ?? "";
    meta.append(el("span", "entry-state", state), el("time", null, time.format(a.t)));
    li.append(main, meta);
    return li;
  }));
}

function render() {
  renderAgents();
  renderActivity();
}

// --- Sites interdits ---------------------------------------------------------------

let blocklist = [];

function normalizeDomain(input) {
  return input.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/^www\./, "");
}

function renderBlocklist() {
  $("blocked-empty").hidden = blocklist.length > 0;
  $("blocked").replaceChildren(...blocklist.map((domain) => {
    const li = el("li", null, domain);
    const remove = el("button", null, "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Autoriser à nouveau ${domain}`);
    remove.onclick = () => saveBlocklist(blocklist.filter((d) => d !== domain));
    li.append(remove);
    return li;
  }));
}

async function saveBlocklist(next) {
  blocklist = next;
  await chrome.storage.local.set({ blocklist });
  renderBlocklist();
}

$("block-form").onsubmit = (event) => {
  event.preventDefault();
  const domains = $("block-input").value.split(/[\s,]+/).map(normalizeDomain).filter(Boolean);
  if (!domains.length) return;
  saveBlocklist([...new Set([...blocklist, ...domains])]);
  $("block-input").value = "";
};

// --- Premier plan ---------------------------------------------------------------------

function renderFocus(enabled) {
  $("focus-toggle").checked = enabled;
  $("focus-hint").textContent = enabled
    ? "Activé : l'onglet sur lequel un agent agit passe devant. Animations et menus fiables, mais votre onglet change."
    : "Désactivé : les agents travaillent en arrière-plan. Leur onglet ne passe devant que le temps d'un clic ou d'un défilement, puis vous retrouvez le vôtre.";
}

$("focus-toggle").onchange = async (event) => {
  await chrome.storage.local.set({ foregroundTabs: event.target.checked });
  renderFocus(event.target.checked);
};

chrome.storage.local.get("foregroundTabs").then(({ foregroundTabs = false }) => renderFocus(foregroundTabs === true));

// --- Scripts d'agent ------------------------------------------------------------------

function renderScripts(enabled) {
  $("scripts-toggle").checked = enabled;
  $("scripts-hint").textContent = enabled
    ? "Activé : un agent peut enchaîner des dizaines d'actions en un appel, sans voir les pages entre deux."
    : "Désactivé : les agents agissent pas à pas, et voient chaque page avant d'agir.";
}

$("scripts-toggle").onchange = async (event) => {
  await chrome.storage.local.set({ scriptsEnabled: event.target.checked });
  renderScripts(event.target.checked);
};

chrome.storage.local.get("scriptsEnabled").then(({ scriptsEnabled = false }) => renderScripts(scriptsEnabled === true));

// --- Synchronisation ---------------------------------------------------------------

async function refresh() {
  const state = await chrome.storage.session.get(["connected", "paused", "activity"]);
  activity = state.activity ?? [];
  renderStatus(state);
  render();
}

chrome.storage.session.onChanged.addListener(refresh);
chrome.storage.local.get("blocklist").then(({ blocklist: list = [] }) => {
  blocklist = list;
  renderBlocklist();
});
refresh();

// --- Secrets (credentials_fill) ----------------------------------------------------
// Les valeurs en clair n'existent que chiffrées dans chrome.storage.local.
// La phrase secrète ne sort jamais de ce panneau ; seule la clé dérivée (opaque)
// est transmise au service worker pour la session navigateur.

const CRED_FORMAT = "abc-credentials-v1";
let credKey = null;
let credStore = null;
let credApprovals = [];

const $s = (id) => document.getElementById(id);

function credSlotIdOk(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}

function normalizeHosts(input) {
  return AbcSlotsCrypto.extractHosts(input).hosts;
}

function renderHostsPreview() {
  const box = $s("slot-hosts-preview");
  if (!box) return;
  const { hosts, ignored } = AbcSlotsCrypto.extractHosts($s("slot-hosts").value);
  box.replaceChildren();
  for (const h of hosts) box.append(el("span", "slot-chip", h));
  for (const bad of ignored) box.append(el("span", "slot-chip ignored", bad));
}

async function loadCredStore() {
  const { credSlots } = await chrome.storage.local.get("credSlots");
  credStore = credSlots?.format === CRED_FORMAT ? credSlots : null;
  return credStore;
}

function renderSecrets() {
  const locked = !credKey;
  $s("secrets-state").dataset.locked = String(locked);
  $s("secrets-state").textContent = locked ? "verrouillé" : "déverrouillé";
  $s("unlock-form").hidden = !locked;
  $s("secrets-open").hidden = locked;
  if (locked) return;
  const slots = Object.values(credStore?.slots ?? {});
  $s("slots-empty").hidden = slots.length > 0;
  $s("slots").replaceChildren(...slots.map((slot) => {
    const li = el("li", "slot-item");
    const top = el("div", "slot-top");
    top.append(el("span", "slot-id", slot.id));
    top.append(el("span", null, slot.label ?? ""));
    const remove = el("button", null, "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Révoquer le secret ${slot.id}`);
    remove.onclick = () => revokeSlot(slot.id);
    top.append(remove);
    li.append(top);
    li.append(el("div", "slot-hosts", slot.hosts.join(" · ")));
    const actions = el("div", "slot-actions");
    const policy = document.createElement("select");
    policy.setAttribute("aria-label", `Usage du secret ${slot.id}`);
    for (const [value, label] of [["ask", "Demander à chaque fois"], ["always", "Toujours autoriser"]]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      policy.append(opt);
    }
    policy.value = slot.policy === "always" ? "always" : "ask";
    policy.onchange = () => setSlotPolicy(slot.id, policy.value);
    actions.append(policy);
    li.append(actions);
    return li;
  }));
  $s("approvals").replaceChildren(...credApprovals.map((a) => {
    const card = el("div", "approval");
    const p = el("p", null, "");
    p.append(el("strong", null, a.agent), document.createTextNode(` demande le secret « ${a.label} »`));
    card.append(p);
    card.append(el("div", "approval-site", `vers ${a.tabHost || "(site inconnu)"}`));
    const actions = el("div", "approval-actions");
    const allow = el("button", "allow", "Autoriser une fois");
    allow.type = "button";
    allow.onclick = () => decideApproval(a.id, "allow");
    const deny = el("button", "deny", "Refuser");
    deny.type = "button";
    deny.onclick = () => decideApproval(a.id, "deny");
    actions.append(allow, deny);
    card.append(actions);
    return card;
  }));
}

async function decideApproval(id, decision) {
  await chrome.runtime.sendMessage({ type: "credential-decision", id, decision }).catch(() => {});
}

$s("unlock-form").onsubmit = async (event) => {
  event.preventDefault();
  $s("unlock-error").hidden = true;
  const pass = $s("unlock-input").value;
  $s("unlock-input").value = "";
  if (!pass) return;
  try {
    await loadCredStore();
    let key;
    if (!credStore) {
      // Premier usage : la phrase choisie ici crée le coffre (elle n'est jamais stockée).
      if (pass.length < 8) throw new Error("Phrase trop courte pour créer le coffre (8 caractères minimum).");
      const salt = AbcSlotsCrypto.newSalt();
      key = await AbcSlotsCrypto.deriveKey(pass, Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)));
      const verifier = await AbcSlotsCrypto.encryptWithKey(key, AbcSlotsCrypto.VERIFIER_TEXT);
      credStore = { format: CRED_FORMAT, salt, verifier, slots: {} };
      await chrome.storage.local.set({ credSlots: credStore });
    } else {
      const salt = Uint8Array.from(atob(credStore.salt), (c) => c.charCodeAt(0));
      key = await AbcSlotsCrypto.deriveKey(pass, salt);
      const check = await AbcSlotsCrypto.decryptWithKey(key, credStore.verifier.iv, credStore.verifier.data);
      if (check !== AbcSlotsCrypto.VERIFIER_TEXT) throw new Error("Phrase secrète incorrecte.");
    }
    credKey = key;
    await chrome.runtime.sendMessage({ type: "credentials-unlock", dek: await AbcSlotsCrypto.exportRawKey(key) });
    renderSecrets();
  } catch (err) {
    credKey = null;
    $s("unlock-error").textContent = err?.message ?? String(err);
    $s("unlock-error").hidden = false;
  }
};

$s("lock-button").onclick = async () => {
  credKey = null;
  await chrome.runtime.sendMessage({ type: "credentials-lock" }).catch(() => {});
  renderSecrets();
};

$s("slot-form").onsubmit = async (event) => {
  event.preventDefault();
  $s("slot-error").hidden = true;
  try {
    if (!credKey) throw new Error("Coffre verrouillé.");
    const id = $s("slot-id").value.trim().toLowerCase();
    const label = $s("slot-label").value.trim() || id;
    const hosts = normalizeHosts($s("slot-hosts").value);
    const login = $s("slot-login").value.trim();
    const secret = $s("slot-secret").value;
    $s("slot-secret").value = "";
    if (!credSlotIdOk(id)) throw new Error("Nom technique invalide : minuscules, chiffres, tirets (ex. sso-rouen-mdp).");
    if (!hosts.length) throw new Error("Indiquer au moins un site autorisé (ex. univ-rouen.fr).");
    if (!secret) throw new Error("Secret vide.");
    const store = await loadCredStore();
    if (!store) throw new Error("Coffre introuvable : déverrouillez d'abord (la phrase choisie crée le coffre).");
    if (store.slots[id]) throw new Error(`Un secret "${id}" existe déjà (révoquez-le d'abord pour le remplacer).`);
    const enc = await AbcSlotsCrypto.encryptWithKey(credKey, secret);
    store.slots[id] = {
      id, label, login: login || undefined, hosts, policy: $s("slot-policy").value === "always" ? "always" : "ask",
      created: new Date().toISOString(), iv: enc.iv, data: enc.data,
    };
    await chrome.storage.local.set({ credSlots: store });
    credStore = store;
    $s("slot-id").value = "";
    $s("slot-label").value = "";
    $s("slot-hosts").value = "";
    $s("slot-login").value = "";
    renderHostsPreview();
    renderSecrets();
  } catch (err) {
    $s("slot-error").textContent = err?.message ?? String(err);
    $s("slot-error").hidden = false;
  }
};

$s("slot-hosts").addEventListener("input", renderHostsPreview);

$s("slot-current-site").onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = tab?.url?.startsWith("http") ? new URL(tab.url).hostname.toLowerCase() : "";
    if (!host) return;
    const field = $s("slot-hosts");
    const cur = field.value.trim();
    if (!AbcSlotsCrypto.extractHosts(cur).hosts.includes(host)) {
      field.value = cur ? `${cur} ${host}` : host;
    }
    renderHostsPreview();
    field.focus();
  } catch { /* onglet illisible : saisie manuelle */ }
};

async function revokeSlot(id) {
  for (const a of credApprovals.filter((x) => x.slotId === id)) {
    await decideApproval(a.id, "deny");
  }
  const store = (await loadCredStore()) ?? credStore;
  if (store?.slots[id]) {
    delete store.slots[id];
    await chrome.storage.local.set({ credSlots: store });
    credStore = store;
  }
  renderSecrets();
}

async function setSlotPolicy(id, policy) {
  const store = (await loadCredStore()) ?? credStore;
  const slot = store?.slots[id];
  if (!slot) return;
  slot.policy = policy === "always" ? "always" : "ask";
  await chrome.storage.local.set({ credSlots: store });
  credStore = store;
  renderSecrets();
}

// Demandes d'approbation : publiées par le service worker, affichées ici.
async function refreshCredApprovals() {
  const { credApprovals: list = [] } = await chrome.storage.session.get("credApprovals");
  credApprovals = list;
}

chrome.storage.session.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.credApprovals) refreshCredApprovals().then(renderSecrets);
});
chrome.storage.local.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.credSlots) loadCredStore().then(renderSecrets);
});

loadCredStore().then(() => refreshCredApprovals().then(renderSecrets));
