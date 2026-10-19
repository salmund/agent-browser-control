// Outils DevTools avancés (v0.3) : interception réseau, corps de réponse, stockage,
// performance, émulation, PDF. Chargé par background.js (importScripts) ; utilise ses
// fonctions (cdp, assertOwned, ok, text, fail, untrusted, sleep, networkLogs…) à l'exécution.

// ---------------------------------------------------------------------------
// Interception réseau (CDP Fetch)
// ---------------------------------------------------------------------------

const interceptRules = new Map(); // tabId -> [{ id, urlPattern, regex, method, effect, ... , hits }]
let ruleCounter = 0;

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function headerList(obj) {
  return Object.entries(obj).map(([name, value]) => ({ name, value: String(value) }));
}

/**
 * Motif CDP (Fetch.enable) d'une règle : seules les requêtes susceptibles de correspondre sont
 * suspendues, pas toutes celles de l'onglet. Les motifs CDP sont sensibles à la casse, la règle
 * non (regex /i) : on filtre donc sur l'hôte (toujours en minuscules dans une URL normalisée),
 * la regex de la règle tranchant ensuite. Sans hôte reconnaissable (« *\/api/* »), tout est suspendu.
 */
function interceptPatternFor(glob) {
  let rest = String(glob ?? "").trim().replace(/^\*+/, "");
  rest = rest.replace(/^(?:[a-z][a-z0-9+.-]*|\*):\/\//i, "").replace(/^\*+/, "");
  const host = /^\.?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=[/:*?#]|$)/i.exec(rest)?.[1];
  if (!host) return "*";
  return `*${host.toLowerCase()}*`;
}

async function syncFetch(tabId) {
  const rules = interceptRules.get(tabId) ?? [];
  if (!rules.length) {
    await cdp(tabId, "Fetch.disable").catch(() => {});
    return;
  }
  const globs = [...new Set(rules.map((r) => interceptPatternFor(r.urlPattern)))];
  const patterns = (globs.includes("*") ? ["*"] : globs).map((urlPattern) => ({ urlPattern, requestStage: "Request" }));
  await cdp(tabId, "Fetch.enable", { patterns });
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (method === "Fetch.requestPaused") handlePausedRequest(tabId, params).catch(() => {});
});
chrome.debugger.onDetach.addListener(({ tabId }) => interceptRules.delete(tabId));

/** Requête suspendue : appliquer la règle ; en cas d'erreur, toujours la relâcher (sinon la page attend sans fin). */
async function handlePausedRequest(tabId, p) {
  try {
    await applyInterceptRule(tabId, p);
  } catch {
    await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
  }
}

async function applyInterceptRule(tabId, p) {
  const send = (method, args) => chrome.debugger.sendCommand({ tabId }, method, args);
  const requestId = p.requestId;
  const rule = (interceptRules.get(tabId) ?? []).find(
    (r) => r.regex.test(p.request.url) && (!r.method || r.method === p.request.method),
  );
  if (!rule) return send("Fetch.continueRequest", { requestId });
  rule.hits++;

  switch (rule.effect) {
    case "block":
      return send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    case "mock":
      return send("Fetch.fulfillRequest", {
        requestId,
        responseCode: rule.status ?? 200,
        responseHeaders: headerList({
          "Content-Type": rule.contentType ?? "application/json",
          "Access-Control-Allow-Origin": "*",
          ...(rule.headers ?? {}),
        }),
        body: utf8ToBase64(rule.body ?? ""),
      });
    case "modify_headers": {
      // Fusion insensible à la casse ; une valeur null supprime l'en-tête.
      const merged = new Map(Object.entries(p.request.headers).map(([k, v]) => [k.toLowerCase(), [k, v]]));
      for (const [k, v] of Object.entries(rule.headers ?? {})) {
        if (v === null) merged.delete(k.toLowerCase());
        else merged.set(k.toLowerCase(), [k, v]);
      }
      return send("Fetch.continueRequest", {
        requestId,
        headers: [...merged.values()].map(([name, value]) => ({ name, value: String(value) })),
      });
    }
    case "delay":
      await sleep(rule.delayMs ?? 2000);
      return send("Fetch.continueRequest", { requestId });
    default:
      return send("Fetch.continueRequest", { requestId });
  }
}

function describeRule(r) {
  const what = {
    block: "bloquer",
    mock: `réponse simulée ${r.status ?? 200} (${r.contentType ?? "application/json"}, ${(r.body ?? "").length} car.)`,
    modify_headers: `en-têtes modifiés : ${Object.keys(r.headers ?? {}).join(", ")}`,
    delay: `retarder de ${r.delayMs ?? 2000} ms`,
  }[r.effect];
  return `- ${r.id} : ${r.method ? `${r.method} ` : ""}${r.urlPattern} → ${what} (${r.hits} requête(s) interceptée(s))`;
}

async function networkIntercept(agent, args) {
  const { tabId, action } = args;
  await assertOwned(agent, tabId);
  const rules = interceptRules.get(tabId) ?? [];

  switch (action) {
    case "add": {
      if (!args.urlPattern) throw new Error("'urlPattern' requis (glob, ex. '*api.example.com/users*').");
      if (!["block", "mock", "modify_headers", "delay"].includes(args.effect)) {
        throw new Error("'effect' attendu : block, mock, modify_headers ou delay.");
      }
      const rule = {
        id: `rule_${++ruleCounter}`,
        urlPattern: args.urlPattern,
        regex: globToRegex(args.urlPattern),
        method: args.method?.toUpperCase(),
        effect: args.effect,
        status: args.status,
        body: typeof args.body === "string" || args.body === undefined ? args.body : JSON.stringify(args.body),
        contentType: args.contentType,
        headers: args.headers,
        delayMs: args.delayMs,
        hits: 0,
      };
      interceptRules.set(tabId, [...rules, rule]);
      await syncFetch(tabId);
      return ok(text(`Règle ajoutée :\n${describeRule(rule)}\nElle s'applique aux prochaines requêtes (recharger la page si besoin).`));
    }
    case "list":
      return ok(text(rules.length ? `Règles actives :\n${rules.map(describeRule).join("\n")}` : "Aucune règle d'interception."));
    case "remove": {
      if (!rules.some((r) => r.id === args.ruleId)) throw new Error(`Règle ${args.ruleId} introuvable.`);
      interceptRules.set(tabId, rules.filter((r) => r.id !== args.ruleId));
      await syncFetch(tabId);
      return ok(text(`Règle ${args.ruleId} supprimée.`));
    }
    case "clear":
      interceptRules.delete(tabId);
      await syncFetch(tabId);
      return ok(text("Toutes les règles d'interception de cet onglet sont supprimées."));
    default:
      throw new Error("action attendue : add, list, remove ou clear.");
  }
}

// ---------------------------------------------------------------------------
// Corps de réponse
// ---------------------------------------------------------------------------

const TEXT_MIME = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded|ld\+json|graphql)|image\/svg)/i;

async function networkGetBody(agent, { tabId, requestId }) {
  await assertOwned(agent, tabId);
  if (!requestId) throw new Error("'requestId' requis (colonne id de read_network_requests).");
  const entry = networkLogs.get(tabId)?.get(requestId);
  let res;
  try {
    res = await cdp(tabId, "Network.getResponseBody", { requestId });
  } catch (err) {
    throw new Error(`Corps indisponible (${err.message}). Il n'est conservé que pour les requêtes récentes de la page courante.`);
  }
  const mime = entry?.mimeType ?? "";
  let body = res.body;
  if (res.base64Encoded) {
    if (!TEXT_MIME.test(mime)) {
      return ok(text(`Contenu binaire (${mime || "type inconnu"}), ${Math.round((body.length * 3) / 4)} octets. Non affiché.`));
    }
    body = new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)));
  }
  if (/json/i.test(mime)) {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {}
  }
  const truncated = body.length > 50_000;
  if (truncated) body = body.slice(0, 50_000);
  const header = `${entry ? `${entry.method} ${entry.status ?? ""} ${entry.url}\n` : ""}Type : ${mime || "inconnu"}${truncated ? " (tronqué à 50 000 caractères)" : ""}`;
  return ok(text(`${header}\n${untrusted(body)}`));
}

/**
 * network_har : l'enregistrement réseau persistant de l'onglet, tenu par le démon (il survit au
 * rechargement de l'extension). L'extension vérifie seulement que l'onglet est à l'agent.
 */
async function networkHar(agent, { tabId, action = "status", requestId, urlPattern, limit, name, secrets, keep, label, saved, format }) {
  if (action !== "saved") await assertOwned(agent, tabId);
  const actions = ["status", "list", "body", "bodies", "export", "export-code", "keep", "clear", "saved"];
  if (!actions.includes(action)) throw new Error(`action attendue : ${actions.join(", ")}.`);
  if (action === "body" && !requestId) throw new Error("'requestId' requis pour action=\"body\" (colonne id de list).");
  if (urlPattern) compileRegex(urlPattern);
  return { content: [text("HAR persistant")], _har: { action, tabId, requestId, urlPattern, limit, name, secrets, keep, label, saved, format } };
}

/**
 * site_api, action save_call : mémorise une requête du HAR (méthode, chemin, params,
 * jamais de valeurs) pour rejouer vite la prochaine fois. L'extension vérifie que
 * l'onglet est à l'agent (sauf relecture d'un enregistrement gardé) ; le démon dérive
 * et persiste. Les autres actions (list, save_route, delete) sont servies par le démon seul.
 */
async function siteApi(agent, { action = "list", tabId, requestId, name, saved, site, text: note }) {
  if (action === "note" && !site) {
    const tab = await assertOwned(agent, tabId);
    let host = "";
    try {
      host = new URL(tab.url ?? tab.pendingUrl ?? "").hostname;
    } catch {}
    if (!host) throw new Error("Site de l'onglet indéterminé : préciser 'site'.");
    return { content: [text("Site API")], _siteApi: { action, tabId, site: host, text: note } };
  }
  if (action !== "save_call") throw new Error(`Action ${action} : servie par le démon, sans passer par l'extension.`);
  if (!saved) await assertOwned(agent, tabId);
  if (!requestId) throw new Error("'requestId' requis (colonne id de devtools action=\"har\" op=\"list\").");
  return { content: [text("Site API")], _siteApi: { action, tabId, requestId, name, saved } };
}

// ---------------------------------------------------------------------------
// Stockage : cookies, localStorage, sessionStorage
// ---------------------------------------------------------------------------

// Cookies dont la valeur vaut une session ou un jeton : masqués par défaut (reveal: true pour les voir).
const SENSITIVE_COOKIE = /sess|sid|token|auth|jwt|csrf|xsrf|secret|login|remember|passw|key|credential|identity|refresh|bearer|saml|oauth|^__(host|secure)-/i;

/** Cookie à masquer : HttpOnly (illisible par la page elle-même) ou nom typique de session / jeton. */
function cookieIsSensitive(c) {
  return !!c.httpOnly || SENSITIVE_COOKIE.test(c.name ?? "");
}

function formatCookie(c, reveal = false) {
  const flags = [c.httpOnly && "HttpOnly", c.secure && "Secure", c.sameSite && `SameSite=${c.sameSite}`].filter(Boolean).join(" ");
  const expires = c.session ? "session" : new Date(c.expires * 1000).toISOString().slice(0, 16).replace("T", " ");
  const hidden = !reveal && cookieIsSensitive(c);
  const value = hidden
    ? `<masqué, ${c.value.length} car.>`
    : c.value.length > 200 ? `${c.value.slice(0, 200)}… [${c.value.length} car.]` : c.value;
  return `- ${c.name}=${value}\n    ${c.domain}${c.path} · expire : ${expires}${flags ? ` · ${flags}` : ""}`;
}

async function storage(agent, args) {
  const { tabId, type, action } = args;
  const tab = await assertOwned(agent, tabId);

  if (type === "cookies") {
    const url = tab.url;
    switch (action) {
      case "get": {
        const { cookies } = await cdp(tabId, "Network.getCookies", { urls: [url] });
        const list = args.name ? cookies.filter((c) => c.name === args.name) : cookies;
        if (!list.length) return ok(text("Aucun cookie."));
        const reveal = args.reveal === true;
        const masked = reveal ? 0 : list.filter(cookieIsSensitive).length;
        const note = masked
          ? `\n(${masked} valeur(s) masquée(s) : cookies HttpOnly ou de session / jeton. reveal: true pour les afficher, seulement si la tâche l'exige.)`
          : "";
        return ok(text(`${list.length} cookie(s) pour ${new URL(url).host} :\n${untrusted(list.map((c) => formatCookie(c, reveal)).join("\n"))}${note}`));
      }
      case "set": {
        if (!args.name || args.value === undefined) throw new Error("'name' et 'value' requis.");
        const { success } = await cdp(tabId, "Network.setCookie", {
          name: args.name,
          value: String(args.value),
          url,
          ...(args.domain && { domain: args.domain }),
          ...(args.path && { path: args.path }),
          ...(args.secure !== undefined && { secure: args.secure }),
          ...(args.httpOnly !== undefined && { httpOnly: args.httpOnly }),
          ...(args.sameSite && { sameSite: args.sameSite }),
          ...(args.expires && { expires: args.expires }),
        });
        if (success === false) throw new Error("Cookie refusé par le navigateur (domaine ou attributs invalides).");
        return ok(text(`Cookie ${args.name} défini.`));
      }
      case "delete":
        if (!args.name) throw new Error("'name' requis.");
        await cdp(tabId, "Network.deleteCookies", {
          name: args.name, url, ...(args.domain && { domain: args.domain }), ...(args.path && { path: args.path }),
        });
        return ok(text(`Cookie ${args.name} supprimé.`));
      case "clear": {
        const { cookies } = await cdp(tabId, "Network.getCookies", { urls: [url] });
        for (const c of cookies) await cdp(tabId, "Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path });
        return ok(text(`${cookies.length} cookie(s) supprimé(s) pour ${new URL(url).host}.`));
      }
    }
  } else if (type === "localStorage" || type === "sessionStorage") {
    const store = type;
    const name = JSON.stringify(args.name ?? "");
    const expressions = {
      get: args.name
        ? `${store}.getItem(${name})`
        : `JSON.stringify(Object.fromEntries(Object.keys(${store}).map(k => [k, ${store}.getItem(k)])), null, 2)`,
      set: `${store}.setItem(${name}, ${JSON.stringify(String(args.value ?? ""))}), "ok"`,
      delete: `${store}.removeItem(${name}), "ok"`,
      clear: `(${store}.clear(), "ok")`,
    };
    if (!expressions[action]) throw new Error("action attendue : get, set, delete ou clear.");
    if ((action === "set" || action === "delete") && !args.name) throw new Error("'name' requis.");
    const res = await cdp(tabId, "Runtime.evaluate", { expression: expressions[action], returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    const value = res.result.value;
    if (action === "get") {
      if (value === null || value === undefined) return ok(text(args.name ? `Clé ${args.name} absente.` : "Stockage vide."));
      const shown = value.length > 50_000 ? `${value.slice(0, 50_000)}\n[Tronqué]` : value;
      return ok(text(untrusted(shown)));
    }
    return ok(text({ set: `${args.name} défini.`, delete: `${args.name} supprimé.`, clear: `${store} vidé.` }[action]));
  }
  throw new Error("type attendu : cookies, localStorage ou sessionStorage ; action : get, set, delete ou clear.");
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

const VITALS_SCRIPT = `(async () => {
  const observe = (type, onEntries) => new Promise((resolve) => {
    try { new PerformanceObserver((l) => onEntries(l.getEntries())).observe({ type, buffered: true }); } catch {}
    setTimeout(resolve, 150);
  });
  let lcp = null, cls = 0, inp = 0;
  await Promise.all([
    observe("largest-contentful-paint", (e) => { lcp = e[e.length - 1]; }),
    observe("layout-shift", (e) => { for (const s of e) if (!s.hadRecentInput) cls += s.value; }),
    observe("event", (e) => { for (const x of e) if (x.interactionId) inp = Math.max(inp, x.duration); }),
  ]);
  const nav = performance.getEntriesByType("navigation")[0];
  const paint = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, Math.round(p.startTime)]));
  const resources = performance.getEntriesByType("resource");
  const byType = {};
  for (const r of resources) {
    const t = byType[r.initiatorType] ??= { n: 0, kb: 0 };
    t.n++; t.kb += (r.transferSize || 0) / 1024;
  }
  return {
    url: location.href,
    ttfb: nav && Math.round(nav.responseStart),
    domContentLoaded: nav && Math.round(nav.domContentLoadedEventEnd),
    load: nav && Math.round(nav.loadEventEnd),
    fcp: paint["first-contentful-paint"],
    lcp: lcp && { ms: Math.round(lcp.startTime), element: lcp.element ? lcp.element.tagName.toLowerCase() + (lcp.element.id ? "#" + lcp.element.id : "") : null },
    cls: Math.round(cls * 1000) / 1000,
    inp: inp || null,
    transferKb: Math.round(resources.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024 + (nav?.transferSize || 0) / 1024),
    requests: resources.length + 1,
    byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.n + " req, " + Math.round(v.kb) + " Ko"])),
  };
})()`;

function rate(value, good, poor) {
  if (value == null) return "";
  return value <= good ? " ✓ bon" : value <= poor ? " ~ à améliorer" : " ✗ mauvais";
}

async function performanceMetrics(agent, { tabId }) {
  await assertOwned(agent, tabId);
  await cdp(tabId, "Performance.enable").catch(() => {});
  const [{ metrics }, vitalsRes] = await Promise.all([
    cdp(tabId, "Performance.getMetrics"),
    cdp(tabId, "Runtime.evaluate", { expression: VITALS_SCRIPT, awaitPromise: true, returnByValue: true }),
  ]);
  const m = Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
  const v = vitalsRes.result?.value ?? {};
  const ms = (x) => (x == null ? "n/d" : `${x} ms`);
  const lines = [
    `Performance de ${v.url}`,
    "",
    "Web Vitals :",
    `- LCP : ${v.lcp ? `${v.lcp.ms} ms${v.lcp.element ? ` (${v.lcp.element})` : ""}` : "n/d"}${rate(v.lcp?.ms, 2500, 4000)}`,
    `- CLS : ${v.cls}${rate(v.cls, 0.1, 0.25)}`,
    `- INP (pire interaction observée) : ${v.inp ? `${Math.round(v.inp)} ms${rate(v.inp, 200, 500)}` : "aucune interaction"}`,
    `- FCP : ${ms(v.fcp)}${rate(v.fcp, 1800, 3000)}`,
    `- TTFB : ${ms(v.ttfb)}${rate(v.ttfb, 800, 1800)}`,
    "",
    "Chargement :",
    `- DOMContentLoaded : ${ms(v.domContentLoaded)} · load : ${ms(v.load)}`,
    `- ${v.requests} requêtes, ${v.transferKb} Ko transférés`,
    ...Object.entries(v.byType ?? {}).map(([k, s]) => `  - ${k} : ${s}`),
    "",
    "Runtime :",
    `- Tas JS : ${Math.round((m.JSHeapUsedSize ?? 0) / 1048576)} Mo utilisés / ${Math.round((m.JSHeapTotalSize ?? 0) / 1048576)} Mo`,
    `- Nœuds DOM : ${m.Nodes} · écouteurs : ${m.JSEventListeners} · documents : ${m.Documents}`,
    `- Layouts : ${m.LayoutCount} (${Math.round((m.LayoutDuration ?? 0) * 1000)} ms) · recalculs de style : ${m.RecalcStyleCount} (${Math.round((m.RecalcStyleDuration ?? 0) * 1000)} ms)`,
    `- Temps de script : ${Math.round((m.ScriptDuration ?? 0) * 1000)} ms · tâches : ${Math.round((m.TaskDuration ?? 0) * 1000)} ms`,
  ];
  return ok(text(lines.join("\n")));
}

// ---------------------------------------------------------------------------
// Émulation
// ---------------------------------------------------------------------------

const DEVICES = {
  "iphone-15": {
    width: 393, height: 852, deviceScaleFactor: 3, mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
  "pixel-8": {
    width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true,
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
    // Client Hints (Sec-CH-UA-*, navigator.userAgentData) cohérents avec le user-agent Android.
    userAgentMetadata: {
      brands: [
        { brand: "Chromium", version: "140" }, { brand: "Google Chrome", version: "140" }, { brand: "Not=A?Brand", version: "24" },
      ],
      fullVersionList: [
        { brand: "Chromium", version: "140.0.0.0" }, { brand: "Google Chrome", version: "140.0.0.0" }, { brand: "Not=A?Brand", version: "24.0.0.0" },
      ],
      fullVersion: "140.0.0.0",
      platform: "Android", platformVersion: "15.0.0", architecture: "", model: "Pixel 8", mobile: true, bitness: "", wow64: false,
    },
  },
  ipad: {
    width: 820, height: 1180, deviceScaleFactor: 2, mobile: true,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    platform: "iPad",
  },
};
DEVICES["iphone-15"].platform = "iPhone";
// Safari n'envoie pas de Client Hints : sans userAgentMetadata, Chrome les désactive (cohérent pour iPhone et iPad).

/**
 * État tactile émulé par onglet, lu par le service worker : sous émulation mobile, un tap doit partir
 * en Input.dispatchTouchEvent (touchstart / touchend) plutôt qu'en clic souris.
 * Exposé sur globalThis.AbcDevtools (pas de nouveau nom global nu : portée partagée avec bg/).
 */
const emulationStates = new Map(); // tabId -> { touch, mobile, device, maxTouchPoints }
chrome.debugger.onDetach.addListener(({ tabId }) => emulationStates.delete(tabId)); // Chrome a tout effacé
chrome.tabs.onRemoved.addListener((tabId) => emulationStates.delete(tabId));
globalThis.AbcDevtools = {
  emulationStates,
  touchEnabled: (tabId) => !!emulationStates.get(tabId)?.touch,
};

// Débits en octets/s, latence en ms (valeurs proches des préréglages DevTools).
const NETWORKS = {
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  "slow-3g": { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  "fast-3g": { offline: false, latency: 563, downloadThroughput: 180_000, uploadThroughput: 84_375 },
  "4g": { offline: false, latency: 60, downloadThroughput: 1_500_000, uploadThroughput: 750_000 },
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

const originalUserAgents = new Map(); // tabId -> UA d'origine, pour la réinitialisation

// Émulation d'appareil et capture. Après un Page.captureScreenshot sur un onglet émulé (souvent passé devant
// le temps de la capture), Chrome perd le facteur d'échelle émulé : la page reste à ×3 mais la vue repart à
// l'échelle de l'écran réel. Les clics arrivent alors réduits (iPhone 15 sur un écran à 125 % : (285, 35)
// reçu en (118, 14), soit ×1,25/3) et la capture suivante sort en mosaïque. Réappliquer l'émulation avant
// chaque capture et chaque geste remet la vue en accord avec la page (mêmes valeurs : aucun resize côté page).
const deviceOverrides = new Map(); // tabId -> paramètres de Emulation.setDeviceMetricsOverride en vigueur

chrome.debugger.onDetach.addListener(({ tabId }) => deviceOverrides.delete(tabId)); // Chrome a tout effacé

/** Réapplique l'émulation d'appareil de l'onglet, s'il en a une (après un passage au premier plan). */
async function refreshDeviceOverride(tabId) {
  const params = deviceOverrides.get(tabId);
  if (params) await cdp(tabId, "Emulation.setDeviceMetricsOverride", params).catch(() => {});
}

async function emulate(agent, args) {
  const { tabId } = args;
  await assertOwned(agent, tabId);
  const done = [];

  if (args.reset) {
    deviceOverrides.delete(tabId);
    emulationStates.delete(tabId);
    await cdp(tabId, "Emulation.clearDeviceMetricsOverride");
    await cdp(tabId, "Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp(tabId, "Emulation.setEmitTouchEventsForMouse", { enabled: false }).catch(() => {});
    // userAgent vide : retour au user-agent ET aux Client Hints du navigateur (pas de valeur figée).
    await cdp(tabId, "Emulation.setUserAgentOverride", { userAgent: "" }).catch(async () => {
      if (originalUserAgents.has(tabId)) await cdp(tabId, "Emulation.setUserAgentOverride", { userAgent: originalUserAgents.get(tabId) });
    });
    originalUserAgents.delete(tabId);
    await cdp(tabId, "Network.emulateNetworkConditions", NETWORKS.none);
    await cdp(tabId, "Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp(tabId, "Emulation.setEmulatedMedia", { features: [] });
    await cdp(tabId, "Emulation.clearGeolocationOverride");
    return ok(text("Émulation réinitialisée (appareil, réseau, CPU, thème, géolocalisation)."));
  }

  if (args.device || args.width) {
    const preset = args.device && args.device !== "custom" ? DEVICES[args.device] : null;
    if (args.device && args.device !== "custom" && !preset) throw new Error(`Appareil inconnu. Choix : ${Object.keys(DEVICES).join(", ")}, ou width/height.`);
    const d = { ...preset, ...(args.width && { width: args.width }), ...(args.height && { height: args.height }) };
    if (!d.width || !d.height) throw new Error("'width' et 'height' requis pour un appareil personnalisé.");
    const metrics = { width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor ?? 1, mobile: !!(d.mobile ?? args.mobile) };
    await cdp(tabId, "Emulation.setDeviceMetricsOverride", metrics);
    deviceOverrides.set(tabId, metrics);
    const touch = !!(d.mobile ?? args.mobile);
    await cdp(tabId, "Emulation.setTouchEmulationEnabled", touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    // Pas de Emulation.setEmitTouchEventsForMouse(true) : l'émulateur tactile avale alors les
    // Input.dispatchMouseEvent du service worker, qui attendent un accusé qui ne vient jamais (clic
    // bloqué jusqu'au délai). Les taps passent par Input.dispatchTouchEvent (voir touchEnabled).
    await cdp(tabId, "Emulation.setEmitTouchEventsForMouse", { enabled: false }).catch(() => {});
    emulationStates.set(tabId, { touch, mobile: metrics.mobile, device: args.device ?? "custom", maxTouchPoints: touch ? 5 : 0 });
    if (d.userAgent) {
      if (!originalUserAgents.has(tabId)) originalUserAgents.set(tabId, await evaluate(tabId, "navigator.userAgent"));
      await cdp(tabId, "Emulation.setUserAgentOverride", {
        userAgent: d.userAgent,
        ...(d.platform && { platform: d.platform }),
        ...(d.userAgentMetadata && { userAgentMetadata: d.userAgentMetadata }),
      });
    }
    done.push(`appareil ${args.device ?? "personnalisé"} ${d.width}x${d.height}${d.userAgent ? " (user-agent changé : recharger la page pour qu'il s'applique partout)" : ""}`);
  }

  if (args.network) {
    const conditions = NETWORKS[args.network];
    if (!conditions) throw new Error(`Réseau inconnu. Choix : ${Object.keys(NETWORKS).join(", ")}.`);
    await cdp(tabId, "Network.emulateNetworkConditions", conditions);
    done.push(`réseau ${args.network}`);
  }

  if (args.cpuThrottling) {
    await cdp(tabId, "Emulation.setCPUThrottlingRate", { rate: Math.max(1, args.cpuThrottling) });
    done.push(`CPU ralenti ×${Math.max(1, args.cpuThrottling)}`);
  }

  if (args.colorScheme) {
    const features = args.colorScheme === "none" ? [] : [{ name: "prefers-color-scheme", value: args.colorScheme }];
    await cdp(tabId, "Emulation.setEmulatedMedia", { features });
    done.push(`thème ${args.colorScheme}`);
  }

  if (args.geolocation) {
    const { latitude, longitude, accuracy = 50 } = args.geolocation;
    await cdp(tabId, "Emulation.setGeolocationOverride", { latitude, longitude, accuracy });
    done.push(`position ${latitude}, ${longitude} (le site doit quand même avoir l'autorisation de géolocalisation)`);
  }

  if (!done.length) throw new Error("Rien à émuler : préciser device, width/height, network, cpuThrottling, colorScheme, geolocation ou reset.");
  const { w, h } = await evaluate(tabId, "({ w: innerWidth, h: innerHeight })");
  return ok(text(`Émulation active : ${done.join(" ; ")}.\nViewport actuel : ${w}x${h}. Elle reste active tant que l'agent pilote l'onglet (emulate reset pour l'annuler).`));
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

async function pdf(agent, { tabId, filename, landscape = false, printBackground = true }) {
  const tab = await assertOwned(agent, tabId);
  const { data } = await cdp(tabId, "Page.printToPDF", { landscape, printBackground, preferCSSPageSize: true });
  const stem = (filename || tab.title || "page").replace(/\.pdf$/i, "").slice(0, 80);
  return { content: [text(`PDF exporté : {path}`)], _file: { name: `${stem}.pdf`, base64: data } };
}

// ---------------------------------------------------------------------------
// WebSocket : connexions et messages (CDP Network)
// ---------------------------------------------------------------------------

const MAX_WS_FRAMES = 1000; // par onglet, tous sockets confondus
const MAX_WS_PAYLOAD = 4000; // caractères gardés par message (après masquage)
const MAX_WS_MASK_INPUT = 256_000; // caractères analysés pour le masquage (au-delà : repli regex sur la coupure)
const wsLogs = new Map(); // tabId -> { sockets: Map(requestId -> { url, opened, closed, sent, received }), frames: [] }

function wsState(tabId) {
  let state = wsLogs.get(tabId);
  if (!state) wsLogs.set(tabId, (state = { sockets: new Map(), frames: [] }));
  return state;
}

function wsSocket(state, requestId) {
  let socket = state.sockets.get(requestId);
  if (!socket) {
    // Frames d'un socket ouvert avant que l'agent ne prenne l'onglet en main
    socket = { url: "(ouvert avant le début de la capture)", opened: null, closed: null, sent: 0, received: 0 };
    state.sockets.set(requestId, socket);
  }
  return socket;
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (tabId === undefined || !method.startsWith("Network.webSocket")) return;
  const state = wsState(tabId);
  if (method === "Network.webSocketCreated") {
    state.sockets.set(params.requestId, { url: globalThis.AbcWsMask.maskPairs(params.url ?? ""), opened: Date.now(), closed: null, sent: 0, received: 0 });
  } else if (method === "Network.webSocketClosed") {
    wsSocket(state, params.requestId).closed = Date.now();
  } else if (method === "Network.webSocketFrameReceived" || method === "Network.webSocketFrameSent") {
    const socket = wsSocket(state, params.requestId);
    const dir = method === "Network.webSocketFrameSent" ? "sent" : "received";
    socket[dir]++;
    const { opcode, payloadData = "" } = params.response;
    const binary = opcode === 2;
    state.frames.push({
      socket: params.requestId,
      dir,
      t: Date.now(),
      size: binary ? Math.round((payloadData.length * 3) / 4) : payloadData.length,
      // Masquer AVANT de tronquer : une coupure au milieu d'un JSON empêcherait son analyse (secret
      // laissé en clair). La borne de 256 000 car. évite d'analyser une trame géante pour rien.
      data: binary ? null : String(globalThis.AbcWsMask.maskBody(payloadData.slice(0, MAX_WS_MASK_INPUT))).slice(0, MAX_WS_PAYLOAD),
    });
    if (state.frames.length > MAX_WS_FRAMES) state.frames.splice(0, state.frames.length - MAX_WS_FRAMES);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => wsLogs.delete(tabId));

async function readWebsocketMessages(agent, { tabId, urlPattern, pattern, direction = "all", limit = 50, clear }) {
  await assertOwned(agent, tabId);
  await ensureAttached(tabId);
  const state = wsState(tabId);
  const urlRe = compileRegex(urlPattern);
  const dataRe = compileRegex(pattern);
  const sockets = [...state.sockets].filter(([, s]) => !urlRe || urlRe.test(s.url));
  const ids = new Set(sockets.map(([id]) => id));

  let frames = state.frames.filter(
    (f) => ids.has(f.socket) && (direction === "all" || f.dir === direction) && (!dataRe || (f.data && dataRe.test(f.data))),
  );
  const total = frames.length;
  frames = frames.slice(-limit);
  if (clear) state.frames = [];

  if (!sockets.length) {
    return ok(text(
      "Aucune connexion WebSocket capturée. La capture commence quand l'agent prend l'onglet en main : " +
      "recharger la page (navigate url='reload') pour voir les sockets ouverts au chargement.",
    ));
  }
  const time = (t) => new Date(t).toISOString().slice(11, 23);
  const socketLines = sockets.map(([id, s]) =>
    `- ${id} ${s.closed ? "fermé" : "ouvert"} · ${s.received} reçus / ${s.sent} envoyés · ${s.url.slice(0, 200)}`);
  const frameLines = frames.map((f) =>
    `${time(f.t)} ${f.dir === "sent" ? "→" : "←"} [${f.socket}] ${f.data === null ? `(binaire, ${f.size} octets)` : f.data}`);
  const header = total > frames.length ? `${frames.length} derniers messages sur ${total}` : `${total} message(s)`;
  return ok(text(
    `Connexions :\n${socketLines.join("\n")}\n\n${header} (← reçu, → envoyé) :\n` +
    untrusted(frameLines.join("\n") || "(aucun message correspondant)"),
  ));
}

// ---------------------------------------------------------------------------
// Requête HTTP depuis l'extension (hors CSP et CORS de la page)
// ---------------------------------------------------------------------------

const HTTP_MAX_BODY = 50_000;

async function httpRequest(agent, { url, method = "GET", headers = {}, body, timeoutMs = 30_000 }) {
  if (!/^https?:\/\//i.test(url ?? "")) throw new Error("'url' doit commencer par http:// ou https://.");
  await assertAllowed(url);
  const started = Date.now();
  // Sans cookies : l'agent interroge des API, il n'agit pas au nom de l'utilisateur sur ses comptes.
  const res = await fetch(url, {
    method: method.toUpperCase(),
    headers,
    body: body === undefined || body === null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    credentials: "omit",
    redirect: "follow",
    signal: AbortSignal.timeout(Math.min(timeoutMs, 60_000)),
  });
  const ms = Date.now() - started;
  const type = res.headers.get("content-type") ?? "";
  const shownHeaders = ["content-type", "content-length", "cache-control", "date", "retry-after", "x-ratelimit-remaining"]
    .filter((h) => res.headers.has(h))
    .map((h) => `${h}: ${res.headers.get(h)}`)
    .join("\n");

  let content;
  if (TEXT_MIME.test(type) || type === "") {
    content = await res.text();
    if (/json/i.test(type)) {
      try {
        content = JSON.stringify(JSON.parse(content), null, 2);
      } catch {}
    }
    if (content.length > HTTP_MAX_BODY) content = `${content.slice(0, HTTP_MAX_BODY)}\n[Tronqué : ${content.length} caractères au total]`;
  } else {
    const size = (await res.arrayBuffer()).byteLength;
    content = `(contenu binaire ${type}, ${size} octets, non affiché)`;
  }
  const status = `${res.status} ${res.statusText}`.trim();
  return {
    content: [text(`${method.toUpperCase()} ${res.url} → ${status} en ${ms} ms\n${shownHeaders}\n\n${untrusted(content)}`)],
    ...(res.ok ? {} : { isError: true }),
  };
}


// ---------------------------------------------------------------------------
// devtools : les 12 outils DevTools rarement utilisés en un seul (action + op).
// Les anciens noms restent enregistrés dans TOOLS (compatibilité des scripts).
// ---------------------------------------------------------------------------

const DEVTOOLS_ACTIONS = ["console", "network", "body", "intercept", "storage", "perf", "emulate", "pdf", "websocket", "http", "har", "resize"];

async function devtools(agent, args) {
  const { action, op, ...rest } = args;
  switch (action) {
    case "console": return readConsoleMessages(agent, rest);
    case "network": return readNetworkRequests(agent, rest);
    case "body": return networkGetBody(agent, rest);
    case "intercept": return networkIntercept(agent, { ...rest, action: op ?? rest.action });
    case "storage": return storage(agent, { ...rest, action: op ?? rest.action });
    case "perf": return performanceMetrics(agent, rest);
    case "emulate": return emulate(agent, rest);
    case "pdf": return pdf(agent, rest);
    case "websocket": return readWebsocketMessages(agent, rest);
    case "http": return httpRequest(agent, rest);
    case "har": return networkHar(agent, { ...rest, action: op ?? rest.action ?? "status" });
    case "resize": return resizeWindow(agent, rest);
    default: throw new Error(`action attendue : ${DEVTOOLS_ACTIONS.join(", ")}.`);
  }
}
