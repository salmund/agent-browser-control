/**
 * Hygiène des onglets : durées lisibles et sélection des onglets à fermer.
 * Module pur (service worker + tests Node), sans dépendance chrome.
 *
 * Utilisé par `tabs_context` (âge et dernière activité de chaque onglet) et
 * `tabs_cleanup` (ferme les onglets inactifs de l'agent, sans jamais toucher
 * aux onglets protégés : actif, épinglé, avec du son, ou d'activité inconnue).
 */
function formatDuration(ms) {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000));
  if (s < 60) return "moins d'une minute";
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) {
    const rest = min % 60;
    return rest ? `${h} h ${String(rest).padStart(2, "0")}` : `${h} h`;
  }
  const d = Math.floor(h / 24);
  return d === 1 ? "1 jour" : `${d} jours`;
}

/** Dernier signal d'activité connu d'un onglet (accès Chrome ou action d'agent), ou null. */
function lastActivityMs(tab, lastActionT) {
  const seen = [tab && tab.lastAccessed, lastActionT].filter((t) => typeof t === "number" && t > 0);
  return seen.length ? Math.max(...seen) : null;
}

/**
 * Répartit les onglets entre à-fermer et à-garder.
 * tabs : [{ id, active, pinned, audible, lastAccessed, lastActionT }].
 * opts : { olderThanMs (défaut 1 h), keepActive, keepPinned, keepAudible (défaut true) }.
 * now : Date.now().
 */
function pickCleanupCandidates(tabs, opts = {}, now = Date.now()) {
  const olderThanMs = typeof opts.olderThanMs === "number" && opts.olderThanMs >= 0 ? opts.olderThanMs : 3600_000;
  const keepActive = opts.keepActive !== false;
  const keepPinned = opts.keepPinned !== false;
  const keepAudible = opts.keepAudible !== false;
  const close = [];
  const kept = [];
  for (const tab of tabs ?? []) {
    if (keepActive && tab.active) {
      kept.push({ id: tab.id, reason: "onglet actif" });
      continue;
    }
    if (keepPinned && tab.pinned) {
      kept.push({ id: tab.id, reason: "épinglé" });
      continue;
    }
    if (keepAudible && tab.audible) {
      kept.push({ id: tab.id, reason: "son en cours" });
      continue;
    }
    const activity = lastActivityMs(tab, tab.lastActionT);
    if (activity === null) {
      kept.push({ id: tab.id, reason: "activité inconnue" });
      continue;
    }
    const idleMs = now - activity;
    if (idleMs >= olderThanMs) close.push(tab.id);
    else kept.push({ id: tab.id, reason: `vu il y a ${formatDuration(idleMs)}` });
  }
  return { close, kept };
}

globalThis.AbcTabHygiene = { formatDuration, lastActivityMs, pickCleanupCandidates };
