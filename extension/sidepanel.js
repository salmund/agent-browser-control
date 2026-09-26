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

function renderAgents() {
  const counts = new Map();
  for (const a of activity) {
    const c = counts.get(a.agent) ?? { n: 0, color: a.color };
    c.n++;
    counts.set(a.agent, c);
  }
  if (agentFilter && !counts.has(agentFilter)) agentFilter = null;

  $("agent-filters").replaceChildren(...[...counts].map(([agent, { n, color }]) => {
    const chip = el("button", "agent-chip");
    chip.type = "button";
    chip.style.setProperty("--c", `var(--grp-${color ?? "grey"})`);
    chip.setAttribute("aria-pressed", String(agentFilter === agent));
    chip.title = agentFilter === agent ? "Afficher tous les agents" : `N'afficher que ${agent}`;
    chip.append(el("span", null, agent), el("span", "count", String(n)));
    chip.onclick = () => {
      agentFilter = agentFilter === agent ? null : agent;
      render();
    };
    return chip;
  }));
}

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
