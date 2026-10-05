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

async function syncFetch(tabId) {
  const rules = interceptRules.get(tabId) ?? [];
  if (rules.length) await cdp(tabId, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  else await cdp(tabId, "Fetch.disable").catch(() => {});
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (method === "Fetch.requestPaused") handlePausedRequest(tabId, params).catch(() => {});
});
chrome.debugger.onDetach.addListener(({ tabId }) => interceptRules.delete(tabId));

async function handlePausedRequest(tabId, p) {
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
async function networkHar(agent, { tabId, action = "status", requestId, urlPattern, limit, name, secrets, keep, label, saved }) {
  if (action !== "saved") await assertOwned(agent, tabId);
  const actions = ["status", "list", "body", "export", "keep", "clear", "saved"];
  if (!actions.includes(action)) throw new Error(`action attendue : ${actions.join(", ")}.`);
  if (action === "body" && !requestId) throw new Error("'requestId' requis pour action=\"body\" (colonne id de list).");
  if (urlPattern) compileRegex(urlPattern);
  return { content: [text("HAR persistant")], _har: { action, tabId, requestId, urlPattern, limit, name, secrets, keep, label, saved } };
}

/**
 * site_api, action save_call : mémorise une requête du HAR (méthode, chemin, params,
 * jamais de valeurs) pour rejouer vite la prochaine fois. L'extension vérifie que
 * l'onglet est à l'agent (sauf relecture d'un enregistrement gardé) ; le démon dérive
 * et persiste. Les autres actions (list, save_route, delete) sont servies par le démon seul.
 */
async function siteApi(agent, { action = "list", tabId, requestId, name, saved }) {
  if (action !== "save_call") throw new Error(`Action ${action} : servie par le démon, sans passer par l'extension.`);
  if (!saved) await assertOwned(agent, tabId);
  if (!requestId) throw new Error("'requestId' requis (colonne id de network_har action=\"list\").");
  return { content: [text("Site API")], _siteApi: { action, tabId, requestId, name, saved } };
}

// ---------------------------------------------------------------------------
// Stockage : cookies, localStorage, sessionStorage
// ---------------------------------------------------------------------------

function formatCookie(c) {
  const flags = [c.httpOnly && "HttpOnly", c.secure && "Secure", c.sameSite && `SameSite=${c.sameSite}`].filter(Boolean).join(" ");
  const expires = c.session ? "session" : new Date(c.expires * 1000).toISOString().slice(0, 16).replace("T", " ");
  const value = c.value.length > 200 ? `${c.value.slice(0, 200)}… [${c.value.length} car.]` : c.value;
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
        return ok(text(list.length ? `${list.length} cookie(s) pour ${new URL(url).host} :\n${untrusted(list.map(formatCookie).join("\n"))}` : "Aucun cookie."));
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
  },
  ipad: {
    width: 820, height: 1180, deviceScaleFactor: 2, mobile: true,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
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

async function emulate(agent, args) {
  const { tabId } = args;
  await assertOwned(agent, tabId);
  const done = [];

  if (args.reset) {
    await cdp(tabId, "Emulation.clearDeviceMetricsOverride");
    await cdp(tabId, "Emulation.setTouchEmulationEnabled", { enabled: false });
    if (originalUserAgents.has(tabId)) await cdp(tabId, "Emulation.setUserAgentOverride", { userAgent: originalUserAgents.get(tabId) });
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
    await cdp(tabId, "Emulation.setDeviceMetricsOverride", {
      width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor ?? 1, mobile: !!(d.mobile ?? args.mobile),
    });
    await cdp(tabId, "Emulation.setTouchEmulationEnabled", { enabled: !!(d.mobile ?? args.mobile), maxTouchPoints: 5 });
    if (d.userAgent) {
      if (!originalUserAgents.has(tabId)) originalUserAgents.set(tabId, await evaluate(tabId, "navigator.userAgent"));
      await cdp(tabId, "Emulation.setUserAgentOverride", { userAgent: d.userAgent });
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
const MAX_WS_PAYLOAD = 4000; // caractères gardés par message
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
    state.sockets.set(params.requestId, { url: params.url, opened: Date.now(), closed: null, sent: 0, received: 0 });
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
      data: binary ? null : payloadData.slice(0, MAX_WS_PAYLOAD),
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
    isError: !res.ok,
  };
}
