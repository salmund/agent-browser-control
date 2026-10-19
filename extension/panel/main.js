// Panneau latéral d'Agent Browser Control : en-tête (connexion, arrêt), vues, synchronisation.

import { $, send } from "./dom.js";
import { applySession } from "./activity.js";
import { renderAbout } from "./settings.js";
import { startSecrets, syncVaultState } from "./secrets.js";

// --- En-tête : connexion et arrêt ----------------------------------------------------------------

function renderStatus({ connected = false, paused = false, connError = "" }) {
  $("bar").dataset.state = connected ? "on" : "off";
  $("bar").dataset.paused = String(!!paused);
  $("conn-title").textContent = connected ? "Connecté" : connError ? "Connexion refusée" : "Démon arrêté";
  $("conn-hint").textContent = connected ? "" : connError || "Il démarre dès qu'un agent se connecte.";
  $("paused").hidden = !paused;
}

$("stop").addEventListener("click", async () => {
  await send({ type: "stop" });
  $("resume").focus();
});
$("resume").addEventListener("click", async () => {
  await send({ type: "resume" });
  $("stop").focus();
});
$("reconnect").addEventListener("click", () => send({ type: "reconnect" }));

// --- Vues (onglets) ----------------------------------------------------------------------------

const VIEWS = ["activity", "settings", "secrets"];

function showView(name, { focus = false } = {}) {
  for (const v of VIEWS) {
    const tab = $(`tab-${v}`);
    const on = v === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`view-${v}`).hidden = !on;
    if (on && focus) tab.focus();
  }
  if (name === "secrets") startSecrets();
  sessionStorage.setItem("abc-view", name);
}

for (const v of VIEWS) $(`tab-${v}`).addEventListener("click", () => showView(v));
$("tab-activity").parentElement.addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  const current = VIEWS.findIndex((v) => $(`tab-${v}`).getAttribute("aria-selected") === "true");
  const next = e.key === "Home" ? 0 : e.key === "End" ? VIEWS.length - 1 : (current + (e.key === "ArrowRight" ? 1 : -1) + VIEWS.length) % VIEWS.length;
  showView(VIEWS[next], { focus: true });
  e.preventDefault();
});

// --- Synchronisation avec le service worker --------------------------------------------------------

const SESSION_KEYS = ["connected", "paused", "connError", "activity", "groups", "pausedAgents", "askRequests", "credApprovals", "bwUnlockRequests", "agentMessages", "daemonVersion"];
const session = {};
let lastRequests = 0;

function apply(values) {
  Object.assign(session, values);
  if ("connected" in values || "paused" in values || "connError" in values) renderStatus(session);
  const { requests } = applySession(values);
  // Une nouvelle demande d'un agent est urgente : la vue Activité passe devant, sauf saisie en cours.
  if (requests > lastRequests && !document.activeElement?.matches("input, select, textarea")) showView("activity");
  lastRequests = requests;
  if ("connected" in values || "groups" in values || "daemonVersion" in values) renderAbout(session);
}

chrome.storage.session.onChanged.addListener((changes) => {
  const values = {};
  for (const key of SESSION_KEYS) if (key in changes) values[key] = changes[key].newValue;
  if (Object.keys(values).length) apply(values);
});

chrome.storage.session.get(SESSION_KEYS).then((values) => {
  for (const key of SESSION_KEYS) if (!(key in values)) values[key] = undefined;
  apply(values);
});

showView(VIEWS.includes(sessionStorage.getItem("abc-view")) ? sessionStorage.getItem("abc-view") : "activity");
syncVaultState();
