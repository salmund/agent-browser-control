// Agent Browser Control, service worker : appels au script de page.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Script de page (monde isolé)
// ---------------------------------------------------------------------------

/** Exécuté dans la frame : appelle une fonction de page.js (éventuellement async). */
async function callPageFunction(name, a) {
  try {
    const api = globalThis.__abc;
    if (!api) return { missing: true };
    if (typeof api[name] !== "function") {
      // page.js d'une version précédente de l'extension (onglet injecté avant une mise à jour) : on le
      // remplace par la version actuelle au lieu d'échouer sur une fonction inconnue.
      delete globalThis.__abc;
      return { missing: true };
    }
    return { value: await api[name](a) };
  } catch (e) {
    return { error: e.message };
  }
}

/** "f12:ref_3" désigne un élément de l'iframe 12 ; "ref_3", un élément de la page principale. */
function parseRef(ref) {
  const m = /^f(\d+):(ref_\d+)$/.exec(ref ?? "");
  return m ? { frameId: Number(m[1]), ref: m[2] } : { frameId: 0, ref };
}

/** Préfixe les refs d'une iframe, pour que les outils sachent dans quelle frame agir. */
const prefixRefs = (text, frameId) => (frameId ? text.replace(/\[ref_(\d+)\]/g, `[f${frameId}:ref_$1]`) : text);

/**
 * Délai maximal d'un appel de page : une page figée (boucle JS) ne doit pas bloquer l'outil, ni la file du
 * premier plan de la fenêtre. Les fonctions qui défilent ou téléchargent ont droit à plus.
 */
const LONG_PAGE_FUNCTIONS = new Set(["scrollExtract", "fetchJson", "imageData", "pageText", "findScan"]);
/** Fonctions bornées par construction (dismissConsent : deux passes de 2 s) : une page figée ne coûte pas 45 s. */
const SHORT_PAGE_FUNCTIONS = new Map([["dismissConsent", 10_000]]);
function pageTimeout(fnName, arg) {
  const own = Number(arg?.timeout ?? arg?.timeoutMs);
  if (Number.isFinite(own) && own > 0) return Math.min(own + 10_000, 300_000);
  return LONG_PAGE_FUNCTIONS.has(fnName) ? 180_000 : (SHORT_PAGE_FUNCTIONS.get(fnName) ?? 45_000);
}

async function inPage(tabId, fnName, arg, frameId = 0) {
  assertNoDialog(tabId);
  assertRunning(tabId);
  const target = { tabId, frameIds: [frameId] };
  // page.js persiste par document (monde isolé + garde __abc) : appeler d'abord, injecter si absent.
  const run = async () => {
    const attempt = () => chrome.scripting.executeScript({ target, func: callPageFunction, args: [fnName, arg ?? null] });
    let [res] = await attempt();
    if (res?.result?.missing) {
      await chrome.scripting.executeScript({ target, files: ["page.js"] });
      [res] = await attempt();
      if (res?.result?.missing) throw new Error("page.js non injectable dans cet onglet (navigation en cours ?).");
    }
    return res;
  };
  const res = await withTimeout(raceDialog(tabId, run()), pageTimeout(fnName, arg), `Script de page (${fnName})`);
  if (res?.result?.error) throw new Error(res.result.error);
  return res?.result?.value;
}

/** Même appel dans toutes les frames de l'onglet ; renvoie [{ frameId, value }] (frames injoignables ignorées). */
async function inAllFrames(tabId, fnName, arg) {
  assertNoDialog(tabId);
  assertRunning(tabId);
  const target = { tabId, allFrames: true };
  const run = async () => {
    const attempt = () => chrome.scripting.executeScript({ target, func: callPageFunction, args: [fnName, arg ?? null] });
    let results = await attempt();
    if (results.some((r) => r?.result?.missing)) {
      await chrome.scripting.executeScript({ target, files: ["page.js"] });
      results = (await attempt()).map((r) =>
        r?.result?.missing ? { ...r, result: { error: "page.js non injectable dans cette frame (navigation en cours ?)." } } : r,
      );
    }
    return results;
  };
  let results;
  try {
    results = await withTimeout(raceDialog(tabId, run()), pageTimeout(fnName, arg), `Script de page (${fnName})`);
  } catch (err) {
    if (err instanceof DialogOpenError || /pas de réponse après/.test(err?.message)) throw err;
    // Une frame refuse l'injection (page interne…) : on se rabat sur la page principale.
    return [{ frameId: 0, value: await inPage(tabId, fnName, arg) }];
  }
  const main = results.find((r) => r.frameId === 0);
  if (main?.result?.error) throw new Error(main.result.error);
  return results.filter((r) => r.result && !r.result.error).map((r) => ({ frameId: r.frameId, value: r.result.value }));
}

/** Retour visuel (réglage « Montrer les gestes » du panneau), sans jamais faire échouer l'action. */
let gesturesShown = true;
chrome.storage.local.get("showGestures").then(({ showGestures }) => (gesturesShown = showGestures !== false)).catch(() => {});
chrome.storage.local.onChanged.addListener((changes) => {
  if ("showGestures" in changes) gesturesShown = changes.showGestures.newValue !== false;
});
const showOverlay = (tabId, point) => (gesturesShown ? inPage(tabId, "overlay", point ?? {}).catch(() => {}) : Promise.resolve());

/**
 * Avertissement placé en tête des lectures quand une fenêtre recouvre la page (bannière de cookies,
 * modale) : sinon, noyée en fin de page, l'agent ne comprend pas pourquoi ses clics n'aboutissent pas.
 */
async function overlayNotice(tabId) {
  let o;
  try {
    o = await inPage(tabId, "blockingOverlay");
  } catch {
    return "";
  }
  if (!o) return "";
  const what = o.consent ? "Une bannière de cookies" : `Une fenêtre (${o.cover} % de l'écran)`;
  const advice = o.consent
    ? "Tant qu'elle est ouverte, les clics sur la page risquent de tomber dessus : la fermer d'abord, en choisissant " +
      "l'option qui refuse les cookies non essentiels (« Refuser », « Continuer sans accepter »), sauf consigne contraire de l'utilisateur. " +
      "Si le clic reste sans effet juste après le chargement, attendre (wait_for networkIdle) puis réessayer."
    : "Elle intercepte probablement les clics sur la page : la traiter ou la fermer d'abord.";
  const where = o.inIframe ? "\nSes boutons sont dans une iframe : voir la section iframe de read_page." : "";
  const details = [`Titre : ${o.title}`];
  if (o.consent) details.push("Pour la fermer en refusant les cookies non essentiels : computer action=\"dismiss_consent\".");
  if (o.buttons.length) details.push(`Boutons : ${o.buttons.map((b) => `${b.name} [${b.ref}]`).join(" · ")}`);
  return `⚠ ${what} recouvre la page. ${advice}${where}\n${untrusted(details.join("\n"))}\n\n`;
}

const API_NOISE = /(analytics|tracking|telemetry|metrics|beacon|sentry|googletag|gtag|facebook|hotjar|clarity|doubleclick|adservice)/i;

/**
 * Découverte passive : les appels JSON qui alimentent la page, signalés en tête des
 * lectures pour rejouer (devtools har, site_api) au lieu de scroller. Ne rejette jamais.
 */
async function apiHint(tabId) {
  try {
    const entries = [...(networkLogs.get(tabId)?.values() ?? [])];
    if (!entries.length) return "";
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    let pageHost = "";
    try {
      pageHost = new URL(tab?.url ?? "").hostname;
    } catch {}
    const groups = new Map(); // "MÉTHODE chemin" -> { count, status, keys, host }
    for (const e of entries) {
      if (e.method === "OPTIONS" || (e.status && (e.status < 200 || e.status >= 300))) continue;
      // Seulement les appels de la page affichée : ceux d'un site visité avant dans l'onglet ne la concernent pas.
      if (e.page && pageHost && hostOf(e.page) !== hostOf(tab.url)) continue;
      // Type de réponse connu : du JSON (ou un flux d'événements), pas une vidéo chargée par XHR.
      const isJson = e.mimeType
        ? /json|event-stream/i.test(e.mimeType)
        : ["XHR", "Fetch", "EventSource"].includes(e.type);
      if (!isJson || API_NOISE.test(e.url)) continue;
      let u;
      try {
        u = new URL(e.url);
      } catch {
        continue;
      }
      // Chemin cité hors balise non fiable : on n'en garde que les caractères d'un chemin d'API.
      const key = `${e.method} ${u.pathname.replace(/[^\w/.\-:~%@]/g, "").slice(0, 120)}`;
      const g = groups.get(key) ?? { count: 0, status: e.status, keys: [], host: u.hostname };
      g.count++;
      g.status = e.status ?? g.status;
      for (const k of u.searchParams.keys()) {
        const safe = k.replace(/[^\w.\-\[\]]/g, "").slice(0, 30);
        if (safe && !g.keys.includes(safe) && g.keys.length < 6) g.keys.push(safe);
      }
      groups.set(key, g);
    }
    const top = [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3);
    if (!top.length) return "";
    const lines = top.map(([k, g]) => {
      const where = g.host && g.host !== pageHost ? ` (${g.host})` : "";
      const paged = g.keys.some((x) => /^(page|cursor|offset|limit|per_page|p|o)$/i.test(x)) ? ", paginable" : "";
      const keys = g.keys.length ? `?${g.keys.slice(0, 4).join(", ")}` : "";
      return `${k}${keys} : ${g.count} appel(s)${g.status ? `, ${g.status}` : ""}${paged}${where}`;
    });
    return `Données JSON détectées (rejouer plutôt que scroller) :\n${lines.join("\n")}\n` +
      `Détail : devtools action="har" op="bodies" + urlPattern, ou site_api save_call pour mémoriser.\n\n`;
  } catch {
    return "";
  }
}
