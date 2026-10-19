// Vue Activité : demandes en attente, agents en direct, journal.

import { $, el, button, icon, iconButton, clock, send, toast } from "./dom.js";
import { describe, duration, ago, hostOf } from "./labels.js";

const LABEL_SEP = " · ";
const PRIVATE_SUFFIX = " (privé)";
const RECENT_MS = 60 * 60_000; // un agent sans onglet reste affiché une heure après sa dernière action

const state = {
  activity: [],
  groups: {},
  pausedAgents: [],
  asks: [],
  approvals: [],
  unlocks: [], // agents qui attendent que l'utilisateur ouvre son coffre (Vaultwarden, Bitwarden)
  filter: "",
  errorsOnly: false,
  expanded: new Set(),
  confirming: null, // agent dont on confirme la fermeture des onglets
  lanes: [],
  knownAgents: [], // noms d'agents gardés par le service worker (storage.local) : survivent au rechargement
  idleOpen: false, // agents récents sans onglet : repliés par défaut
  messages: [], // messages de l'utilisateur aux agents (remis avec leur prochaine réponse d'outil)
  composing: null, // agent à qui l'utilisateur écrit
  drafts: new Map(), // brouillon par agent : survit aux rafraîchissements de la liste
};

const withoutPrivate = (title = "") => (title.endsWith(PRIVATE_SUFFIX) ? title.slice(0, -PRIVATE_SUFFIX.length) : title);
const baseAgent = (actor) => actor.split(LABEL_SEP)[0];

// --- Agents ------------------------------------------------------------------------

/** Lignes d'agents : groupes d'onglets vivants (privé fusionné) + agents actifs récemment. */
async function computeLanes() {
  const live = await chrome.tabGroups.query({});
  const known = new Set([...Object.keys(state.groups), ...state.activity.map((a) => a.agent)].map(withoutPrivate));
  const rememberedIds = new Set(Object.values(state.groups));
  // Groupe « agent » ou « agent · étiquette » d'un agent déjà vu : le sien, même après un rechargement.
  const ofKnownAgent = (actor) => state.knownAgents.some((a) => actor === a || actor.startsWith(a + LABEL_SEP));
  const lanes = new Map();
  const laneFor = (actor) => {
    if (!lanes.has(actor)) lanes.set(actor, { actor, agent: baseAgent(actor), groups: [], tabs: [], color: null });
    return lanes.get(actor);
  };
  for (const g of live) {
    const actor = withoutPrivate(g.title ?? "");
    if (!rememberedIds.has(g.id) && !known.has(actor) && !ofKnownAgent(actor)) continue;
    const lane = laneFor(actor);
    lane.groups.push(g);
    lane.color ??= g.color;
  }
  await Promise.all([...lanes.values()].map(async (lane) => {
    const tabs = await Promise.all(lane.groups.map((g) => chrome.tabs.query({ groupId: g.id })));
    lane.tabs = tabs.flat();
  }));
  const now = Date.now();
  for (const entry of state.activity) {
    if (now - entry.t > RECENT_MS && !lanes.has(entry.agent)) continue;
    const lane = laneFor(entry.agent);
    lane.color ??= entry.color;
    lane.last ??= entry; // activité : la plus récente d'abord
  }
  // Un agent sans onglet dont les sous-agents ont les leurs ne garde pas sa ligne.
  const all = [...lanes.values()];
  const visible = all.filter((l) => l.tabs.length || l.last && !all.some((o) => o !== l && o.agent === l.actor && o.tabs.length));
  // Ordre : agent principal puis ses sous-agents. À la première vue, les plus récemment actifs d'abord ;
  // ensuite l'ordre ne bouge plus (une ligne qui remonte à chaque action ferait cliquer sur la mauvaise).
  const recency = (l) => l.last?.t ?? 0;
  const parents = new Map();
  for (const l of visible) {
    const p = parents.get(l.agent) ?? { agent: l.agent, rows: [], t: 0 };
    p.rows.push(l);
    p.t = Math.max(p.t, recency(l));
    parents.set(l.agent, p);
  }
  const ordered = [...parents.values()]
    .sort((a, b) => b.t - a.t || a.agent.localeCompare(b.agent))
    .flatMap((p) => p.rows.sort((a, b) => (a.actor === p.agent ? -1 : b.actor === p.agent ? 1 : recency(b) - recency(a))));
  for (const l of ordered) {
    if (!laneRank.has(l.agent)) laneRank.set(l.agent, laneRank.size);
    if (!laneRank.has(l.actor)) laneRank.set(l.actor, laneRank.size);
  }
  const rank = (l) => [laneRank.get(l.agent), l.actor === l.agent ? -1 : laneRank.get(l.actor)];
  return ordered.sort((a, b) => {
    const [pa, sa] = rank(a);
    const [pb, sb] = rank(b);
    return pa - pb || sa - sb;
  });
}

/** Rang de première apparition de chaque agent et sous-agent : l'ordre des lignes reste stable. */
const laneRank = new Map();

async function focusLane(lane) {
  const tab = lane.tabs.find((t) => t.active) ?? lane.tabs.at(-1);
  if (!tab) return;
  for (const g of lane.groups) await chrome.tabGroups.update(g.id, { collapsed: false }).catch(() => {});
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function closeLaneTabs(lane) {
  const ids = lane.tabs.map((t) => t.id);
  state.confirming = null;
  if (ids.length) await chrome.tabs.remove(ids).catch(() => {});
  toast(`${ids.length} onglet${ids.length > 1 ? "s" : ""} fermé${ids.length > 1 ? "s" : ""}`);
}

const isPaused = (actor) => state.pausedAgents.includes(actor) || state.pausedAgents.includes(baseAgent(actor));

function laneNow(lane, now) {
  const row = el("div", "lane-now");
  const last = lane.last;
  if (!last) {
    row.append(el("span", "now-text", lane.tabs.length ? "Aucune action récente" : "Plus d'onglet ouvert"));
    return row;
  }
  const { verb, target } = describe(last);
  const where = last.host && last.host !== target ? last.host : "";
  const textNode = el("span", "now-text");
  if (last.status !== "running") textNode.append(document.createTextNode(last.status === "error" ? "Échec : " : "Dernière action : "));
  textNode.append(el("span", "now-verb", verb));
  if (target) textNode.append(document.createTextNode(` ${target}`));
  if (where) textNode.append(document.createTextNode(`, ${where}`));
  textNode.title = textNode.textContent;
  const timeNode = el("span", "now-time");
  timeNode.dataset.t = last.t;
  timeNode.dataset.running = String(last.status === "running");
  timeNode.textContent = last.status === "running" ? duration(now - last.t) : ago(last.t, now);
  row.append(textNode, timeNode);
  return row;
}

/** Agent sans onglet ni action en cours : il a fini, sa ligne passe dans le groupe replié. */
const isIdle = (lane) => !lane.tabs.length && lane.last?.status !== "running" && !isPaused(lane.actor);

/** Ligne compacte d'un agent qui a fini : nom, dernière action, ancienneté. */
function idleRow(lane, now) {
  const li = el("li", "lane idle");
  li.style.setProperty("--c", `var(--grp-${lane.color ?? "grey"})`);
  li.dataset.status = lane.last?.status ?? "idle";
  const head = el("div", "lane-head");
  const name = el("span", "lane-name", lane.actor);
  name.title = lane.actor;
  head.append(name);
  li.append(head, laneNow(lane, now));
  return li;
}

// --- Messages aux agents ----------------------------------------------------------------

const hhmm = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const MESSAGE_SHOWN_MS = 15 * 60_000; // un message lu reste visible un quart d'heure sous la ligne

async function sendMessage(actor, textarea) {
  const value = textarea.value.trim();
  if (!value) return textarea.focus();
  const res = await send({ type: "agent-message", to: actor, text: value });
  if (!res?.ok) return toast(res?.error ?? "Message non envoyé");
  state.drafts.delete(actor);
  state.composing = null;
  toast("Message envoyé : il le lira à sa prochaine action");
  renderLanes();
}

/** Zone de saisie sous la ligne d'un agent. Entrée envoie, Maj+Entrée va à la ligne, Échap ferme. */
function composer(lane) {
  const form = el("form", "composer");
  const ta = el("textarea", "composer-input");
  ta.rows = 2;
  ta.maxLength = 4000;
  ta.placeholder = isPaused(lane.actor)
    ? "Consigne pour l'agent en pause : il la lira avec le refus de sa prochaine action"
    : "Message pour l'agent : il le lira à sa prochaine action";
  ta.setAttribute("aria-label", `Message pour ${lane.actor}`);
  ta.value = state.drafts.get(lane.actor) ?? "";
  ta.dataset.actor = lane.actor;
  ta.addEventListener("input", () => state.drafts.set(lane.actor, ta.value));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage(lane.actor, ta);
    } else if (e.key === "Escape") {
      state.composing = null;
      renderLanes();
    }
  });
  const actions = el("div", "composer-actions");
  const hint = el("span", "composer-hint", "Entrée pour envoyer");
  actions.append(
    hint,
    button("Annuler", "plain-button", () => { state.composing = null; renderLanes(); }),
    button("Envoyer", "solid-button", () => sendMessage(lane.actor, ta)),
  );
  form.addEventListener("submit", (e) => e.preventDefault());
  form.append(ta, actions);
  return form;
}

/** Messages en attente (avec « Retirer ») et récemment lus, sous la ligne de l'agent. */
function laneMessages(lane, now) {
  const mine = state.messages.filter((m) => m.to === lane.actor && (!m.deliveredAt || now - m.deliveredAt < MESSAGE_SHOWN_MS));
  if (!mine.length) return null;
  const list = el("ul", "lane-msgs");
  for (const m of mine.slice(-3)) {
    const li = el("li", "lane-msg");
    li.dataset.state = m.deliveredAt ? "read" : "pending";
    li.append(el("span", "msg-state", m.deliveredAt ? `Lu à ${hhmm.format(m.deliveredAt)}` : "En attente"));
    const body = el("span", "msg-text", m.text);
    body.title = m.text;
    li.append(body);
    if (!m.deliveredAt) {
      li.append(button("Retirer", "text-button", async () => {
        const res = await send({ type: "agent-message-cancel", id: m.id });
        if (!res?.ok) toast(res?.error ?? "Impossible de retirer le message");
      }));
    }
    list.append(li);
  }
  return list;
}

function renderLanes() {
  // Le rendu remplace les lignes : un brouillon en cours de saisie garde son texte (state.drafts),
  // son focus et sa sélection.
  const active = document.activeElement?.matches?.(".composer-input") ? document.activeElement : null;
  const caret = active ? [active.dataset.actor, active.selectionStart, active.selectionEnd] : null;
  const now = Date.now();
  const lanes = state.lanes;
  const busy = lanes.filter((l) => !isIdle(l));
  const idle = lanes.filter(isIdle);
  $("lanes-empty").hidden = lanes.length > 0;
  const running = lanes.filter((l) => l.last?.status === "running").length;
  const tabs = lanes.reduce((n, l) => n + l.tabs.length, 0);
  $("agents-meta").textContent = lanes.length
    ? [running ? `${running} au travail` : "", `${tabs} onglet${tabs > 1 ? "s" : ""}`].filter(Boolean).join(", ")
    : "";

  const rows = busy.map((lane) => {
    const li = el("li", "lane");
    if (lane.actor !== lane.agent) li.classList.add("sub");
    li.style.setProperty("--c", `var(--grp-${lane.color ?? "grey"})`);
    li.dataset.status = lane.last?.status ?? "idle";
    const paused = isPaused(lane.actor);
    if (paused) li.dataset.status = "paused";

    const head = el("div", "lane-head");
    const name = el("span", "lane-name");
    if (lane.actor === lane.agent) name.textContent = lane.agent;
    else name.append(el("span", "lane-label", lane.actor.slice(lane.agent.length + LABEL_SEP.length)));
    name.title = lane.actor;
    head.append(name);
    const n = lane.tabs.length;
    const count = n ? `${n} onglet${n > 1 ? "s" : ""}` : "aucun onglet";
    // En pause, la pastille prend la place du nombre d'onglets (gardé en infobulle) : la ligne tient en 320 px.
    if (paused) {
      const pill = el("span", "lane-state paused", "en pause");
      pill.title = count;
      head.append(pill);
    } else {
      head.append(el("span", "lane-tabs", count));
    }

    if (state.confirming === lane.actor) {
      const confirm = el("span", "lane-confirm");
      confirm.append(
        el("span", null, `Fermer ${n} onglet${n > 1 ? "s" : ""} ?`),
        button("Fermer", "plain-button confirm-danger", () => closeLaneTabs(lane).then(refreshLanes)),
        button("Annuler", "plain-button", () => { state.confirming = null; renderLanes(); }),
      );
      head.append(confirm);
    } else {
      const actions = el("span", "lane-actions");
      const show = iconButton("eye", `Afficher les onglets de ${lane.actor}`, () => focusLane(lane));
      show.disabled = !n;
      const pause = paused
        ? iconButton("play", `Laisser ${lane.actor} reprendre`, () => send({ type: "agent-pause", agent: lane.actor, paused: false }))
        : iconButton("pause", `Mettre ${lane.actor} en pause (ses actions en cours sont coupées)`, () => send({ type: "agent-pause", agent: lane.actor, paused: true }));
      // La pause d'un agent principal couvre ses sous-agents : pas de reprise individuelle tant qu'il est en pause.
      if (paused && !state.pausedAgents.includes(lane.actor)) pause.disabled = true;
      const close = iconButton("close", `Fermer les onglets de ${lane.actor}`, () => { state.confirming = lane.actor; renderLanes(); }, "icon-button danger");
      close.disabled = !n;
      const write = iconButton("message", `Écrire à ${lane.actor}`, () => {
        state.composing = state.composing === lane.actor ? null : lane.actor;
        renderLanes();
        if (state.composing) document.querySelector(".composer-input")?.focus();
      });
      write.setAttribute("aria-pressed", String(state.composing === lane.actor));
      actions.append(write, show, pause, close);
      head.append(actions);
    }
    li.append(head, laneNow(lane, now));
    const msgs = laneMessages(lane, now);
    if (msgs) li.append(msgs);
    if (state.composing === lane.actor) li.append(composer(lane));
    return li;
  });

  if (idle.length) {
    const group = el("li", "lanes-idle");
    const toggle = button(null, "idle-toggle", () => {
      state.idleOpen = !state.idleOpen;
      renderLanes();
    });
    toggle.setAttribute("aria-expanded", String(state.idleOpen));
    toggle.append(icon("chevron"), el("span", null, `${idle.length} agent${idle.length > 1 ? "s" : ""} sans onglet ouvert`));
    group.append(toggle);
    if (state.idleOpen) {
      const list = el("ul", "lanes");
      list.append(...idle.map((lane) => idleRow(lane, now)));
      group.append(list);
    }
    rows.push(group);
  }
  if (state.composing && !busy.some((l) => l.actor === state.composing)) state.composing = null;
  $("lanes").replaceChildren(...rows);
  if (caret) {
    const ta = [...document.querySelectorAll(".composer-input")].find((t) => t.dataset.actor === caret[0]);
    if (ta) {
      ta.focus();
      ta.setSelectionRange(caret[1], caret[2]);
    }
  }
}

let lanesTimer = null;
export function refreshLanes() {
  clearTimeout(lanesTimer);
  lanesTimer = setTimeout(async () => {
    state.lanes = await computeLanes();
    renderLanes();
    renderFilter();
  }, 80);
}

// --- Journal ---------------------------------------------------------------------------

function renderFilter() {
  const select = $("agent-filter");
  const names = [...new Set(state.activity.map((a) => a.agent))].sort();
  if (state.filter && !names.includes(state.filter)) state.filter = "";
  const current = [...select.options].map((o) => o.value).join("\n");
  const wanted = ["", ...names].join("\n");
  if (current !== wanted) {
    select.replaceChildren(el("option", null, "Tous les agents"), ...names.map((n) => el("option", null, n)));
    select.options[0].value = "";
  }
  select.value = state.filter;
  select.hidden = names.length < 2 && !state.filter;
}

function entryDetail(a) {
  const box = el("div", "entry-detail");
  const dl = el("dl");
  const row = (label, value, cls) => {
    if (value == null || value === "") return;
    const dd = el("dd", cls, value);
    dl.append(el("dt", null, label), dd);
  };
  row("Outil", a.tool + (a.action ? ` (${a.action})` : ""), "code");
  row("Paramètres", a.summary, "code");
  row("Agent", a.agent);
  row("Site", a.host);
  row("Début", clock.format(a.t));
  if (a.status !== "running") row("Durée", duration(a.ms));
  if (a.status === "error") row("Erreur", a.error, "full-error");
  box.append(dl);
  const actions = el("div", "button-row");
  if (typeof a.tabId === "number") {
    actions.append(button("Afficher l'onglet", "plain-button", async () => {
      const tab = await chrome.tabs.get(a.tabId).catch(() => null);
      if (!tab) return toast("Cet onglet est fermé");
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }));
  }
  actions.append(button("Copier", "plain-button", async () => {
    const lines = [`${a.tool}${a.action ? ` ${a.action}` : ""} ${a.summary ?? ""}`.trim(), `agent : ${a.agent}`, `heure : ${new Date(a.t).toLocaleString("fr-FR")}`];
    if (a.host) lines.push(`site : ${a.host}`);
    if (a.ms != null) lines.push(`durée : ${duration(a.ms)}`);
    if (a.error) lines.push(`erreur : ${a.error}`);
    await navigator.clipboard.writeText(lines.join("\n")).then(() => toast("Copié"), () => toast("Copie impossible"));
  }));
  box.append(actions);
  return box;
}

function entryNode(a, showAgent) {
  const li = el("li", "entry");
  li.dataset.id = a.id;
  li.dataset.status = a.status;
  li.style.setProperty("--c", `var(--grp-${a.color ?? "grey"})`);

  const row = button(null, "entry-row");
  const open = state.expanded.has(a.id);
  row.setAttribute("aria-expanded", String(open));
  const time = el("time", "entry-time", clock.format(a.t));
  time.dateTime = new Date(a.t).toISOString();

  const main = el("span", "entry-main");
  const line = el("span", "entry-line");
  const { verb, target } = describe(a);
  const label = el("span", "entry-text");
  label.append(document.createTextNode(verb));
  const extra = target || (a.host && a.tool !== "navigate" ? a.host : "");
  if (extra) label.append(document.createTextNode(" "), el("span", "entry-target", extra));
  label.title = label.textContent;
  line.append(label);
  main.append(line);
  if (showAgent) main.append(el("span", "entry-agent", a.agent));
  if (a.status === "error" && a.error && !open) main.append(el("span", "entry-error", a.error));

  const stateText = { running: "en cours", ok: duration(a.ms), error: "échec" }[a.status] ?? "";
  row.append(time, main, el("span", "entry-state", stateText));
  row.addEventListener("click", () => {
    if (state.expanded.has(a.id)) state.expanded.delete(a.id);
    else state.expanded.add(a.id);
    renderEntries(true);
  });
  li.append(row);
  if (open) li.append(entryDetail(a));
  li.dataset.sig = `${a.status}|${a.ms}|${a.color}|${open}|${showAgent}`;
  return li;
}

/** Rendu par clé : les lignes existantes ne bougent pas (le focus clavier et le défilement tiennent). */
function renderEntries(force = false) {
  const rows = state.activity.filter((a) => (!state.filter || a.agent === state.filter) && (!state.errorsOnly || a.status === "error"));
  const multi = !state.filter && new Set(state.activity.map((a) => a.agent)).size > 1;
  // Le nom de l'agent n'apparaît que quand il change d'une ligne à la suivante.
  const showAgentAt = (i) => multi && (i === 0 || rows[i - 1].agent !== rows[i].agent);
  const list = $("entries");
  $("entries-empty").hidden = rows.length > 0;
  $("entries-empty").textContent = state.errorsOnly
    ? "Aucun échec dans le journal."
    : "Rien pour l'instant. Chaque action d'un agent s'affiche ici, en direct.";

  const existing = new Map([...list.children].map((li) => [li.dataset.id, li]));
  const wanted = new Set(rows.map((a) => String(a.id)));
  for (const [id, li] of existing) if (!wanted.has(id)) li.remove();
  rows.forEach((a, i) => {
    const id = String(a.id);
    const showAgent = showAgentAt(i);
    let li = existing.get(id);
    const sig = `${a.status}|${a.ms}|${a.color}|${state.expanded.has(a.id)}|${showAgent}`;
    if (li && (force || li.dataset.sig !== sig)) {
      const fresh = entryNode(a, showAgent);
      const hadFocus = li.contains(document.activeElement);
      li.replaceWith(fresh);
      if (hadFocus) fresh.querySelector(".entry-row").focus();
      li = fresh;
    } else if (!li) {
      li = entryNode(a, showAgent);
    }
    const at = list.children[i];
    if (at !== li) list.insertBefore(li, at ?? null);
  });
}

$("agent-filter").addEventListener("change", (e) => {
  state.filter = e.target.value;
  renderEntries(true);
});
$("errors-only").addEventListener("click", (e) => {
  state.errorsOnly = !state.errorsOnly;
  e.currentTarget.setAttribute("aria-pressed", String(state.errorsOnly));
  renderEntries(true);
});
$("clear-journal").append(icon("trash"));
$("clear-journal").addEventListener("click", async () => {
  await send({ type: "activity-clear" });
  state.expanded.clear();
  toast("Journal effacé");
});

// --- Demandes en attente ------------------------------------------------------------

function countdown(until, now) {
  const s = Math.max(0, Math.round((until - now) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")}` : `${s} s`;
}

async function showTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return toast("Cet onglet est fermé");
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/**
 * Coffre verrouillé pendant qu'un agent attend un identifiant : le mot de passe maître se saisit ici,
 * part au démon local (jamais à l'agent) et relance tous les agents en attente. Les cartes ne sont
 * reconstruites que si la liste change : une saisie en cours n'est pas effacée par une autre demande.
 */
let unlocksKey = "";
function renderUnlocks(now) {
  const key = state.unlocks.map((u) => u.id).join(",");
  if (key === unlocksKey) return;
  unlocksKey = key;
  $("unlocks").replaceChildren(...state.unlocks.map((u) => {
    const card = el("div", "request");
    const who = el("p", "request-who");
    who.append(icon("key"), document.createTextNode(" "), el("strong", null, u.agent),
      document.createTextNode(` a besoin de votre coffre ${u.vault ?? "Bitwarden"}`));
    card.append(who, el("p", "request-question", `Identifiant demandé pour ${u.host || "un site"}.`));
    const error = el("p", "error");
    error.setAttribute("role", "alert");
    const actions = el("div", "request-actions");
    if (u.needsLogin) {
      card.append(el("p", "request-context", "Votre coffre n'est pas encore connecté à l'extension : une seule fois, dans l'onglet Secrets."));
      actions.append(button("Connecter mon coffre", "plain-button allow", () => $("tab-secrets").click()));
    } else {
      const input = el("input");
      input.type = "password";
      input.autocomplete = "off";
      input.placeholder = "Mot de passe maître";
      input.setAttribute("aria-label", `Mot de passe maître ${u.vault ?? "Bitwarden"}`);
      const unlock = async () => {
        if (!input.value) return input.focus();
        go.disabled = true;
        error.textContent = "";
        const res = await send({ type: "bw-unlock", password: input.value });
        go.disabled = false;
        if (res?.ok) {
          input.value = "";
          toast("Coffre déverrouillé");
        } else {
          error.textContent = /invalid master password/i.test(res?.error ?? "") ? "Mot de passe maître incorrect." : (res?.error ?? "Échec du déverrouillage.");
          input.select();
        }
      };
      input.addEventListener("keydown", (e) => e.key === "Enter" && unlock());
      const go = button("Déverrouiller", "plain-button allow", unlock);
      card.append(input);
      actions.append(go);
    }
    actions.append(button("Refuser", "plain-button", () => send({ type: "bw-unlock-decline" })));
    card.append(error, actions);
    const timer = el("p", "request-timer");
    timer.dataset.until = u.until;
    timer.dataset.prefix = "Sans réponse, l'agent abandonne dans ";
    timer.textContent = timer.dataset.prefix + countdown(u.until, now);
    card.append(timer);
    return card;
  }));
}

function renderRequests() {
  const now = Date.now();
  renderUnlocks(now);
  const total = state.asks.length + state.approvals.length + state.unlocks.length;
  $("requests").hidden = total === 0;
  const badge = $("badge-activity");
  badge.hidden = total === 0;
  badge.textContent = String(total);
  badge.setAttribute("aria-label", `${total} demande${total > 1 ? "s" : ""} en attente`);

  $("asks").replaceChildren(...state.asks.map((a) => {
    const card = el("div", "request");
    const who = el("p", "request-who");
    who.append(icon("hand"), document.createTextNode(" "), el("strong", null, a.agent), document.createTextNode(" vous passe la main"));
    card.append(who, el("p", "request-question", a.question ?? ""));
    if (a.context) card.append(el("p", "request-context", a.context));
    const where = el("p", "request-where");
    if (a.title) where.append(document.createTextNode(`${a.title}, `));
    where.append(el("span", "host", hostOf(a.url)));
    card.append(where);
    const note = el("input");
    note.type = "text";
    note.placeholder = "Note pour l'agent (facultatif)";
    note.setAttribute("aria-label", "Note pour l'agent");
    note.addEventListener("keydown", (e) => e.key === "Enter" && send({ type: "ask-decision", id: a.id, decision: "done", note: note.value }));
    card.append(note);
    const actions = el("div", "request-actions");
    actions.append(
      button("C'est fait", "plain-button allow", () => send({ type: "ask-decision", id: a.id, decision: "done", note: note.value })),
      button("Annuler la demande", "plain-button", () => send({ type: "ask-decision", id: a.id, decision: "cancel", note: "" })),
    );
    if (typeof a.tabId === "number") actions.append(button("Afficher l'onglet", "plain-button", () => showTab(a.tabId)));
    card.append(actions);
    if (a.until) {
      const timer = el("p", "request-timer");
      timer.dataset.until = a.until;
      timer.dataset.prefix = "Sans réponse, l'agent reprend dans ";
      timer.textContent = timer.dataset.prefix + countdown(a.until, now);
      card.append(timer);
    }
    return card;
  }));

  $("approvals").replaceChildren(...state.approvals.map((a) => {
    const card = el("div", "request");
    const who = el("p", "request-who");
    const what = (a.fields ?? 1) > 1 ? " veut remplir votre identifiant et votre mot de passe" : a.use === "login" ? " veut remplir un identifiant" : " veut remplir un mot de passe";
    who.append(icon("key"), document.createTextNode(" "), el("strong", null, a.agent), document.createTextNode(what));
    card.append(who, el("p", "request-question", `« ${a.label} » sur ${a.tabHost || "un site inconnu"}`));
    const several = Array.isArray(a.candidates) && a.candidates.length > 1;
    if (a.vault) card.append(el("p", "request-context", several ? "Plusieurs comptes pour ce site : choisissez celui à utiliser." : `Depuis votre coffre ${a.vault}.`));
    // Champ dans une iframe d'un autre site couvert par le slot (ex. connexion intégrée) : à signaler.
    if (a.frameHost) card.append(el("p", "request-context", `Le champ est dans un cadre de ${a.frameHost}.`));
    // Plusieurs éléments du coffre pour ce site : l'utilisateur choisit le compte, pas l'agent.
    let pick = null;
    if (Array.isArray(a.candidates) && a.candidates.length) {
      pick = el("select");
      pick.setAttribute("aria-label", "Compte à utiliser");
      for (const c of a.candidates) {
        const option = el("option", null, c.username ? `${c.name} (${c.username})` : c.name);
        option.value = c.id;
        pick.append(option);
      }
      card.append(pick);
    }
    let remember = null;
    if (a.canRemember) {
      const label = el("label", "request-check");
      remember = el("input");
      remember.type = "checkbox";
      label.append(remember, document.createTextNode(`Toujours autoriser sur ${a.tabHost || "ce site"}`));
      card.append(label);
    }
    const actions = el("div", "request-actions");
    const allow = button("Autoriser une fois", "plain-button allow", () => send({
      type: "credential-decision", id: a.id, decision: "allow",
      ...(pick && { itemId: pick.value }), ...(remember?.checked && { remember: true }),
    }));
    remember?.addEventListener("change", () => (allow.textContent = remember.checked ? "Autoriser" : "Autoriser une fois"));
    actions.append(allow, button("Refuser", "plain-button", () => send({ type: "credential-decision", id: a.id, decision: "deny" })));
    card.append(actions);
    const until = a.until ?? (a.t ? a.t + 75_000 : 0);
    if (until) {
      const timer = el("p", "request-timer");
      timer.dataset.until = until;
      timer.dataset.prefix = "Refus automatique dans ";
      timer.textContent = timer.dataset.prefix + countdown(until, now);
      card.append(timer);
    }
    return card;
  }));
}

// --- Horloge : durées en cours et comptes à rebours --------------------------------------

setInterval(() => {
  const now = Date.now();
  for (const node of document.querySelectorAll(".now-time")) {
    const t = Number(node.dataset.t);
    node.textContent = node.dataset.running === "true" ? duration(now - t) : ago(t, now);
  }
  for (const node of document.querySelectorAll(".request-timer")) {
    node.textContent = node.dataset.prefix + countdown(Number(node.dataset.until), now);
  }
}, 1000);

// --- Synchronisation ---------------------------------------------------------------------

export function applySession(values) {
  let lanes = false;
  let entries = false;
  let requests = false;
  if ("activity" in values) { state.activity = values.activity ?? []; lanes = entries = true; }
  if ("groups" in values) { state.groups = values.groups ?? {}; lanes = true; }
  if ("pausedAgents" in values) { state.pausedAgents = values.pausedAgents ?? []; lanes = true; }
  if ("askRequests" in values) { state.asks = values.askRequests ?? []; requests = true; }
  if ("agentMessages" in values) { state.messages = values.agentMessages ?? []; lanes = true; }
  if ("credApprovals" in values) { state.approvals = values.credApprovals ?? []; requests = true; }
  if ("bwUnlockRequests" in values) { state.unlocks = values.bwUnlockRequests ?? []; requests = true; }
  if (entries) renderEntries();
  if (lanes) refreshLanes();
  if (requests) renderRequests();
  return { requests: state.asks.length + state.approvals.length + state.unlocks.length };
}

chrome.storage.local.get("knownAgents").then(({ knownAgents = [] }) => {
  state.knownAgents = knownAgents;
  refreshLanes();
});
chrome.storage.local.onChanged.addListener((changes) => {
  if (!("knownAgents" in changes)) return;
  state.knownAgents = changes.knownAgents.newValue ?? [];
  refreshLanes();
});

// Les lignes d'agents suivent l'ouverture et la fermeture de leurs onglets.
chrome.tabs.onCreated.addListener(refreshLanes);
chrome.tabs.onRemoved.addListener(refreshLanes);
chrome.tabs.onUpdated.addListener((_id, info) => "groupId" in info && refreshLanes());
chrome.tabGroups.onUpdated.addListener(refreshLanes);
chrome.tabGroups.onRemoved.addListener(refreshLanes);
