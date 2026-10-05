/**
 * Historique de navigation (pur : service worker + tests Node), sans dépendance chrome.
 * Met en forme les résultats de `chrome.history.search` et exclut les sites
 * interdits (même règle suffixe que `assertAllowed` : `example.com` couvre
 * `www.example.com`). Les résultats masqués sont comptés, pas listés : l'agent
 * sait que l'historique n'est pas vide sans voir les sites interdits.
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function blockedHost(host, blocklist) {
  const h = String(host ?? "").toLowerCase();
  if (!h) return null;
  return (blocklist ?? []).find((d) => h === d || h.endsWith(`.${d}`)) ?? null;
}

function shapeHistory(items, blocklist, now = Date.now()) {
  const lines = [];
  let masked = 0;
  for (const it of items ?? []) {
    if (blockedHost(hostOf(it.url), blocklist)) {
      masked++;
      continue;
    }
    const when =
      typeof it.lastVisitTime === "number"
        ? ` · vu il y a ${globalThis.AbcTabHygiene.formatDuration(now - it.lastVisitTime)}`
        : "";
    const count = typeof it.visitCount === "number" && it.visitCount > 1 ? ` (${it.visitCount} visites)` : "";
    lines.push(`- ${it.title || "(sans titre)"} · ${it.url || ""}${when}${count}`);
  }
  return { lines, masked };
}

globalThis.AbcHistory = { hostOf, blockedHost, shapeHistory };
