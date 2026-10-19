// Agent Browser Control, service worker : demandes à l'utilisateur relayées hors du navigateur.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Relais des demandes (Argos : Telegram, interface web)
// ---------------------------------------------------------------------------
// Sur une machine sans écran (Orion), personne ne voit le panneau. Chaque demande (accord pour un secret,
// passage de main, coffre verrouillé) part aussi au démon, qui la relaie si l'utilisateur a configuré un
// relais (relay.json). La réponse revient par le démon et a les mêmes effets qu'un clic dans le panneau.
// Le mot de passe maître, lui, ne passe jamais par le relais : seulement par le panneau.

const RELAY_KEYS = { askRequests: "ask", credApprovals: "credential", bwUnlockRequests: "unlock" };

function relayDescribe(kind, r) {
  if (kind === "ask") {
    return {
      text: `${r.agent} vous passe la main : ${r.question}`,
      detail: r.context ?? "",
      site: hostOf(r.url ?? "") || r.title || "",
      choices: [{ id: "done", label: "C'est fait" }, { id: "cancel", label: "Annuler la demande" }],
    };
  }
  if (kind === "credential") {
    const what = r.use === "login" ? "votre identifiant" : r.fields > 1 ? "votre identifiant et votre mot de passe" : "un mot de passe";
    const accounts = (r.candidates ?? []).slice(0, 4);
    const allow = accounts.length
      ? accounts.map((c) => ({ id: `allow:${c.id}`, label: `Autoriser ${c.name}${c.username ? ` (${c.username})` : ""}` }))
      : [{ id: "allow", label: "Autoriser une fois" }];
    return {
      text: `${r.agent} veut remplir ${what} « ${r.label} » sur ${r.frameHost || r.tabHost}`,
      detail: r.vault ? `Depuis votre coffre ${r.vault}.` : "Depuis le coffre intégré d'ABC.",
      site: r.frameHost || r.tabHost || "",
      choices: [...allow, { id: "deny", label: "Refuser" }],
    };
  }
  return {
    text: `${r.agent} a besoin de votre coffre ${r.vault ?? "Vaultwarden"}, ${r.needsLogin ? "à connecter" : "verrouillé"}${r.host ? ` (pour ${r.host})` : ""}`,
    detail: "Le mot de passe maître se tape seulement dans le panneau d'ABC, sur le bureau de la machine : jamais dans une messagerie.",
    site: r.host ?? "",
    choices: [{ id: "decline", label: "Refuser" }],
  };
}

function relaySend(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

chrome.storage.session.onChanged.addListener((changes) => {
  for (const [key, kind] of Object.entries(RELAY_KEYS)) {
    if (!(key in changes)) continue;
    const before = new Map((changes[key].oldValue ?? []).map((r) => [String(r.id), r]));
    const after = new Map((changes[key].newValue ?? []).map((r) => [String(r.id), r]));
    for (const [id, r] of after) {
      if (!before.has(id)) relaySend({ type: "user-request", id: `${kind}:${id}`, kind, agent: r.agent, until: r.until ?? null, ...relayDescribe(kind, r) });
    }
    for (const id of before.keys()) {
      if (!after.has(id)) relaySend({ type: "user-request-done", id: `${kind}:${id}` });
    }
  }
});

/** Démon (re)connecté : il a pu redémarrer et oublier les demandes en cours ; il ignore celles qu'il connaît déjà. */
async function relayResync() {
  const stored = await chrome.storage.session.get(Object.keys(RELAY_KEYS)).catch(() => ({}));
  for (const [key, kind] of Object.entries(RELAY_KEYS)) {
    for (const r of stored[key] ?? []) {
      relaySend({ type: "user-request", id: `${kind}:${r.id}`, kind, agent: r.agent, until: r.until ?? null, ...relayDescribe(kind, r) });
    }
  }
}

/** Accord ou refus pour un secret : depuis le panneau ou depuis le relais. Faux si la demande n'existe plus. */
function decideCredential(id, decision, { itemId, remember = false, where = "dans le panneau latéral" } = {}) {
  const p = credPending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  credPending.delete(id);
  credDropApproval(id).catch(() => {});
  // Élément Vaultwarden choisi (plusieurs comptes pour le site) et « toujours sur ce site ».
  p.resolve(decision === "allow"
    ? { ok: true, itemId: typeof itemId === "string" && itemId ? itemId : undefined, remember: remember === true }
    : { ok: false, error: `Remplissage refusé par l'utilisateur ${where}.` });
  return true;
}

/** Fin d'un passage de main (ask_human) : depuis le panneau ou depuis le relais. */
function decideAsk(id, decision, { note = "", where = "dans le panneau latéral" } = {}) {
  const p = askPending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  askPending.delete(id);
  askDrop(id).catch(() => {});
  chrome.notifications.clear(id).catch(() => {});
  p.resolve(decision === "done"
    ? { ok: true, note: String(note ?? "").trim().slice(0, 2000) }
    : { ok: false, error: `L'utilisateur a annulé la demande ${where}.` });
  return true;
}

/** Réponse venue du relais, transmise par le démon : { id: "kind:id", decision, note? }. */
function relayDecision(msg) {
  const [kind, rawId = ""] = String(msg.id ?? "").split(/:(.*)/s);
  const choice = String(msg.decision ?? "");
  const where = "depuis Argos";
  if (kind === "credential") {
    const [verb, itemId] = choice.split(/:(.*)/s);
    return decideCredential(Number(rawId), verb === "allow" ? "allow" : "deny", { itemId, where });
  }
  if (kind === "ask") return decideAsk(rawId, choice === "done" ? "done" : "cancel", { note: msg.note, where });
  if (kind === "unlock" && choice === "decline") {
    bwUnlockSettle({ ok: false, error: "L'utilisateur n'a pas déverrouillé son coffre (refus depuis Argos)." });
    return true;
  }
  return false;
}
