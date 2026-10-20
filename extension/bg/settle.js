// Attente commune « la page a fini de réagir » : une seule primitive pour la détection d'effet (computer,
// form_input), file_upload et navigate, au lieu d'une heuristique par outil.
// Trois signaux, combinables : requêtes réseau en cours depuis `since`, DOM calme, condition de l'appelant.
// Toujours bornée par maxMs : on rend la main avec ce qu'on sait, jamais d'attente sans fin
// (networkIdle est inutilisable sur Gmail, qui garde des connexions longues ouvertes).

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Requêtes lancées depuis `since` et sans réponse. network : "xhr" (XHR/Fetch), "writes" (écritures seules) ou "none". */
function pendingRequests(tabId, since, network) {
  if (network === "none") return 0;
  return [...(networkLogs.get(tabId)?.values() ?? [])].filter((r) =>
    r.t >= since && r.status == null && !r.error &&
    (network === "writes" ? WRITE_METHODS.has(r.method) && ["XHR", "Fetch", "Other"].includes(r.type) : ["XHR", "Fetch"].includes(r.type))).length;
}

/**
 * Attend la fin de la réaction de la page. Options :
 * - since : début de l'action (défaut : maintenant) ; les requêtes plus anciennes sont ignorées ;
 * - network : "xhr" (défaut), "writes" ou "none" ;
 * - dom : true attend aussi un DOM calme pendant quietMs (défaut false : coûte au moins quietMs) ;
 * - until : async () => booléen, sondée toutes les stepMs ; l'attente s'arrête dès qu'elle renvoie true ;
 * - maxMs, stepMs.
 * Renvoie { waited, reason } : "idle" (tout est calme), "until" (condition remplie) ou "timeout".
 */
async function settle(tabId, { since = Date.now(), network = "xhr", dom = false, quietMs = 200, until = null, maxMs = 800, stepMs = 100 } = {}) {
  const start = Date.now();
  const end = start + maxMs;
  while (true) {
    if (until && (await until().catch(() => false))) return { waited: Date.now() - start, reason: "until" };
    const busy = pendingRequests(tabId, since, network) > 0;
    if (!busy && !until) {
      if (dom) await waitDomSettle(tabId, quietMs, Math.max(0, end - Date.now()), since).catch(() => {});
      return { waited: Date.now() - start, reason: Date.now() < end ? "idle" : "timeout" };
    }
    if (Date.now() >= end) return { waited: Date.now() - start, reason: "timeout" };
    await sleep(stepMs);
  }
}
