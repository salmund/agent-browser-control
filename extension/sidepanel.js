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
  const agents = await agentGroups();
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
