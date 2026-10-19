// Vue Réglages : comportement, sites interdits, raccourcis, diagnostic.
// Ces réglages ne sont modifiables que par l'utilisateur (le panneau), jamais par un agent.

import { $, el, iconButton, send, toast } from "./dom.js";

// --- Interrupteurs -------------------------------------------------------------------------

const SWITCHES = [
  {
    id: "focus-toggle", key: "foregroundTabs", fallback: false, hint: "focus-hint",
    on: "L'onglet sur lequel un agent agit passe devant. Menus et animations plus fiables, mais votre onglet change.",
    off: "Les agents travaillent en arrière-plan. Leur onglet ne passe devant que le temps d'un clic ou d'un défilement.",
  },
  {
    id: "scripts-toggle", key: "scriptsEnabled", fallback: true, hint: "scripts-hint",
    on: "Un agent peut enchaîner des dizaines d'actions en un seul appel, beaucoup plus vite.",
    off: "Les agents agissent pas à pas et voient chaque page avant d'agir.",
  },
  {
    id: "overlay-toggle", key: "showGestures", fallback: true, hint: "overlay-hint",
    on: "Un halo marque l'élément cliqué ou rempli par l'agent, dans la page.",
    off: "Rien ne s'affiche dans la page : les actions sont un peu plus rapides.",
  },
  {
    id: "autologin-toggle", key: "autoLogin", fallback: false, hint: "autologin-hint",
    on: "Les agents remplissent vos identifiants sans vous demander, seulement sur les sites associés à chaque compte. Plusieurs comptes pour un site : vous choisissez.",
    off: "Chaque connexion d'un agent attend votre accord ici, sauf sur les sites marqués « Toujours autoriser ».",
  },
  {
    id: "bwkeep-toggle", key: "bwKeepUnlocked", fallback: false, hint: "bwkeep-hint",
    on: "Le coffre reste déverrouillé après un redémarrage du PC ou d'ABC : la session est gardée sur ce PC, chiffrée pour votre compte Windows. « Verrouiller » (onglet Secrets) l'efface.",
    off: "Le coffre se reverrouille à chaque redémarrage d'ABC : mot de passe maître à retaper.",
  },
];

for (const s of SWITCHES) {
  const input = $(s.id);
  const render = (on) => {
    input.checked = on;
    $(s.hint).textContent = on ? s.on : s.off;
  };
  input.addEventListener("change", async () => {
    await chrome.storage.local.set({ [s.key]: input.checked });
    render(input.checked);
  });
  chrome.storage.local.get(s.key).then((v) => render(v[s.key] === undefined ? s.fallback : v[s.key] === true));
}

// --- Sites interdits -------------------------------------------------------------------------

let blocklist = [];

function normalizeDomain(input) {
  return input.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#:].*$/, "").replace(/^www\./, "");
}

function renderBlocklist() {
  $("blocked-empty").hidden = blocklist.length > 0;
  $("blocked").replaceChildren(...blocklist.map((domain) => {
    const li = el("li", null, domain);
    li.append(iconButton("close", `Autoriser de nouveau ${domain}`, () => saveBlocklist(blocklist.filter((d) => d !== domain)), "icon-button danger"));
    return li;
  }));
}

async function saveBlocklist(next) {
  blocklist = next;
  await chrome.storage.local.set({ blocklist });
  renderBlocklist();
}

$("block-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const domains = $("block-input").value.split(/[\s,;]+/).map(normalizeDomain).filter((d) => d.includes("."));
  if (!domains.length) return toast("Indiquez un domaine, par exemple mabanque.fr");
  saveBlocklist([...new Set([...blocklist, ...domains])]);
  $("block-input").value = "";
});

$("block-current").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const host = tab?.url?.startsWith("http") ? normalizeDomain(new URL(tab.url).hostname) : "";
  if (!host) return toast("L'onglet affiché n'est pas une page web");
  if (blocklist.includes(host)) return toast(`${host} est déjà interdit`);
  await saveBlocklist([...blocklist, host]);
  toast(`${host} interdit aux agents`);
});

chrome.storage.local.get("blocklist").then(({ blocklist: list = [] }) => {
  blocklist = list;
  renderBlocklist();
});
chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.blocklist) {
    blocklist = changes.blocklist.newValue ?? [];
    renderBlocklist();
  }
});

// --- Raccourcis clavier ---------------------------------------------------------------------

const COMMAND_LABELS = {
  "stop-all": "Tout arrêter",
  "resume-all": "Reprendre",
  _execute_action: "Ouvrir ce panneau",
};

async function renderShortcuts() {
  const commands = (await chrome.commands?.getAll?.().catch(() => [])) ?? [];
  const dl = $("shortcuts");
  dl.replaceChildren();
  for (const c of commands) {
    const label = COMMAND_LABELS[c.name] ?? c.description ?? c.name;
    const dd = el("dd");
    if (c.shortcut) dd.append(el("kbd", null, c.shortcut.replace("Shift", "Maj")));
    else dd.append(el("span", "hint", "aucun"));
    dl.append(el("dt", null, label), dd);
  }
}

$("edit-shortcuts").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
renderShortcuts();

// --- Extension : version, connexion, diagnostic ---------------------------------------------

export async function renderAbout(session = {}) {
  const manifest = chrome.runtime.getManifest();
  const dl = $("about");
  const groups = Object.keys(session.groups ?? {}).length;
  const facts = [
    ["Version", manifest.version],
    ["Démon", session.connected ? "connecté (127.0.0.1:7878)" : "non connecté"],
    ["Groupes d'agents", String(groups)],
  ];
  if (session.daemonVersion) facts.splice(2, 0, ["Version du démon", session.daemonVersion]);
  dl.replaceChildren(...facts.flatMap(([k, v]) => [el("dt", null, k), el("dd", null, v)]));
}

$("copy-diagnostic").addEventListener("click", async () => {
  const res = await send({ type: "diagnostic" });
  const text = res?.ok ? JSON.stringify(res.result, null, 2) : `Diagnostic indisponible : ${res?.error ?? "?"}`;
  await navigator.clipboard.writeText(text).then(() => toast("Diagnostic copié"), () => toast("Copie impossible"));
});

$("reload-extension").addEventListener("click", () => chrome.runtime.reload());
