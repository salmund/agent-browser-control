// Agent Browser Control, service worker : capture console, réseau et HAR.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (tabId === undefined) return;
  if (method.startsWith("Network.")) trackInflight(tabId, method, params);

  if (method === "Target.attachedToTarget") {
    // Sous-cible (worker, iframe) : on y active le réseau ; ses événements arrivent avec le même tabId.
    const child = { tabId, sessionId: params.sessionId };
    chrome.debugger.sendCommand(child, "Network.enable").catch(() => {});
    if (params.targetInfo.type === "iframe") {
      chrome.debugger.sendCommand(child, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    }
    return;
  }

  if (method === "Runtime.consoleAPICalled") {
    const list = consoleLogs.get(tabId) ?? consoleLogs.set(tabId, []).get(tabId);
    const frame = params.stackTrace?.callFrames?.[0];
    pushCapped(list, {
      t: params.timestamp,
      level: params.type === "warning" ? "warn" : params.type,
      text: params.args.map(remoteObjectToString).join(" "),
      source: frame ? `${frame.url}:${frame.lineNumber + 1}` : "",
    }, MAX_CONSOLE);
  } else if (method === "Runtime.exceptionThrown") {
    const list = consoleLogs.get(tabId) ?? consoleLogs.set(tabId, []).get(tabId);
    const d = params.exceptionDetails;
    pushCapped(list, {
      t: params.timestamp,
      level: "error",
      text: d.exception?.description ?? d.text,
      source: d.url ? `${d.url}:${d.lineNumber + 1}` : "",
    }, MAX_CONSOLE);
  } else if (method === "Log.entryAdded") {
    const list = consoleLogs.get(tabId) ?? consoleLogs.set(tabId, []).get(tabId);
    const e = params.entry;
    pushCapped(list, { t: e.timestamp, level: e.level === "warning" ? "warn" : e.level, text: e.text, source: e.url ?? "", kind: e.source }, MAX_CONSOLE);
  } else if (method === "Network.requestWillBeSent") {
    const map = networkLogs.get(tabId) ?? networkLogs.set(tabId, new Map()).get(tabId);
    const previous = map.get(params.requestId);
    if (previous && params.redirectResponse) {
      // Redirection : même requestId ; l'étape précédente part au HAR sous son propre identifiant.
      previous.id = `${params.requestId}:${previous.redirects ?? 0}`;
      setResponse(previous, params.redirectResponse);
      previous.duration = Math.round((params.timestamp - previous.ts) * 1000);
      harPush(tabId, previous);
    }
    const extra = pendingExtraHeaders.get(params.requestId)?.headers;
    pendingExtraHeaders.delete(params.requestId);
    // Requête partie pendant le silence qui suit un remplissage de secret : son corps n'est jamais gardé,
    // même si elle se termine après la fin du silence.
    const muted = (harMutedUntil.get(tabId) ?? 0) > Date.now();
    map.set(params.requestId, {
      id: params.requestId,
      t: params.wallTime * 1000,
      ts: params.timestamp,
      method: params.request.method,
      url: params.request.url,
      type: params.type ?? "",
      page: params.documentURL,
      status: null,
      requestHeaders: { ...params.request.headers, ...extra },
      postData: muted ? undefined : params.request.postData?.slice(0, HAR_MAX_POST),
      redirects: previous && params.redirectResponse ? (previous.redirects ?? 0) + 1 : 0,
      ...(muted && { muted: true }),
    });
    if (map.size > MAX_NETWORK) map.delete(map.keys().next().value);
  } else if (method === "Network.requestWillBeSentExtraInfo") {
    // En-têtes réellement envoyés, cookies compris (absents de requestWillBeSent) ; peut arriver avant.
    const entry = networkLogs.get(tabId)?.get(params.requestId);
    if (entry) Object.assign(entry.requestHeaders, params.headers);
    else {
      pendingExtraHeaders.set(params.requestId, { tabId, headers: params.headers });
      // Requêtes dont requestWillBeSent n'arrive jamais (cible d'un worker) : pas d'accumulation.
      if (pendingExtraHeaders.size > 300) pendingExtraHeaders.delete(pendingExtraHeaders.keys().next().value);
    }
  } else if (method === "Network.responseReceived") {
    const entry = networkLogs.get(tabId)?.get(params.requestId);
    if (entry) setResponse(entry, params.response);
  } else if (method === "Network.responseReceivedExtraInfo") {
    const entry = networkLogs.get(tabId)?.get(params.requestId);
    if (entry) entry.responseHeaders = { ...entry.responseHeaders, ...params.headers };
  } else if (method === "Network.loadingFinished") {
    const entry = networkLogs.get(tabId)?.get(params.requestId);
    if (entry) harFinish(tabId, entry, params);
  } else if (method === "Network.loadingFailed") {
    const entry = networkLogs.get(tabId)?.get(params.requestId);
    if (entry) {
      entry.error = params.canceled ? "canceled" : params.errorText;
      entry.duration = Math.round((params.timestamp - entry.ts) * 1000);
      harPush(tabId, entry);
    }
  }
});

// ---------------------------------------------------------------------------
// HAR persistant : chaque requête terminée part au démon, qui l'écrit sur disque (server/har.ts).
// La mémoire de l'extension ne garde que le résumé ; en-têtes et corps ne font que transiter.
// ---------------------------------------------------------------------------

const HAR_MAX_BODY = 2 * 1024 * 1024; // corps de réponse gardé jusqu'à 2 Mo
const HAR_MAX_POST = 256 * 1024;
const HAR_BODY_TYPES = new Set(["XHR", "Fetch", "Document", "EventSource", "Other"]);
const pendingExtraHeaders = new Map(); // requestId -> en-têtes arrivés avant requestWillBeSent
const harQueue = []; // entrées en attente si le démon est momentanément injoignable

function setResponse(entry, response) {
  entry.status = response.status;
  entry.statusText = response.statusText;
  entry.mimeType = response.mimeType;
  entry.httpVersion = response.protocol;
  entry.responseHeaders = { ...response.headers, ...entry.responseHeaders };
}

async function harFinish(tabId, entry, params) {
  entry.duration = Math.round((params.timestamp - entry.ts) * 1000);
  const wantsBody = HAR_BODY_TYPES.has(entry.type) && TEXT_MIME.test(entry.mimeType ?? "") && (params.encodedDataLength ?? 0) <= HAR_MAX_BODY * 2;
  if (wantsBody && !entry.muted && attached.has(tabId) && (harMutedUntil.get(tabId) ?? 0) <= Date.now()) {
    try {
      // Commande directe (pas cdp) : la capture ne doit ni réattacher l'onglet, ni attendre une boîte ouverte.
      const res = await withTimeout(chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId: params.requestId }), 10_000, "Corps de réponse");
      let body = res.body ?? "";
      const raw = body.length;
      if (res.base64Encoded) {
        // Ne décoder que ce qui sera gardé : une réponse compressée peut peser des dizaines de Mo une fois décodée.
        const keep = Math.ceil((HAR_MAX_BODY * 4) / 3 / 4) * 4;
        body = new TextDecoder().decode(Uint8Array.from(atob(body.slice(0, keep)), (c) => c.charCodeAt(0)));
      }
      entry.body = body.length > HAR_MAX_BODY ? body.slice(0, HAR_MAX_BODY) : body;
      entry.bodyTruncated = body.length > HAR_MAX_BODY || (res.base64Encoded && raw > Math.ceil((HAR_MAX_BODY * 4) / 3));
    } catch {}
  }
  harPush(tabId, entry);
  delete entry.body; // la mémoire ne garde que le résumé
}

function harPush(tabId, entry) {
  const { ts, redirects, muted, ...rest } = entry;
  // Fenêtre de silence après un remplissage de secret : on ne garde pas les corps
  // envoyés (formulaires de login) ni les corps reçus, pour ne jamais enregistrer
  // un mot de passe dans le HAR persistant.
  if (muted || (harMutedUntil.get(tabId) ?? 0) > Date.now()) {
    delete rest.postData;
    delete rest.body;
    rest.bodyTruncated = true;
  }
  const msg = JSON.stringify({ type: "har", tabId, entry: rest });
  if (ws?.readyState === WebSocket.OPEN) {
    while (harQueue.length) ws.send(harQueue.shift());
    ws.send(msg);
  } else if (harQueue.length < 300) {
    harQueue.push(msg);
  }
}

function compileRegex(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    throw new Error(`Expression régulière invalide : ${pattern}`);
  }
}

async function readConsoleMessages(agent, { tabId, pattern, onlyErrors, limit = 100, clear }) {
  await assertOwned(agent, tabId);
  await ensureAttached(tabId);
  const re = compileRegex(pattern);
  const all = consoleLogs.get(tabId) ?? [];
  let list = all.filter((m) => (!onlyErrors || m.level === "error") && (!re || re.test(m.text)));
  const total = list.length;
  list = list.slice(-limit);
  if (clear) consoleLogs.set(tabId, []);
  if (!list.length) {
    return ok(text("Aucun message console" + (all.length ? " correspondant." : " capturé (la capture commence à l'attachement du debugger ; recharger la page si besoin).")));
  }
  const lines = list.map((m) => {
    const body = m.text.length > 600 ? `${m.text.slice(0, 600)}… [${m.text.length} car.]` : m.text;
    return `[${m.level}] ${body}${m.source ? `  (${m.source})` : ""}`;
  });
  const header = total > list.length ? `${list.length} derniers messages sur ${total} :` : `${total} message(s) :`;
  return ok(text(`${header}\n${untrusted(lines.join("\n"))}`));
}

async function readNetworkRequests(agent, { tabId, urlPattern, limit = 100, clear }) {
  await assertOwned(agent, tabId);
  await ensureAttached(tabId);
  const re = compileRegex(urlPattern);
  const all = [...(networkLogs.get(tabId)?.values() ?? [])];
  let list = all.filter((r) => !re || re.test(r.url));
  const total = list.length;
  list = list.slice(-limit);
  if (clear) networkLogs.set(tabId, new Map());
  if (!list.length) {
    return ok(text("Aucune requête" + (all.length ? " correspondante." : " capturée (recharger la page si besoin).")));
  }
  const lines = list.map((r) => {
    const status = r.error ? `ERR ${r.error}` : r.status ?? "…";
    return `${r.id}  ${r.method} ${status} ${r.type ? `[${r.type}] ` : ""}${r.url.slice(0, 300)}`;
  });
  const header = (total > list.length ? `${list.length} dernières requêtes sur ${total}` : `${total} requête(s)`) +
    " (id, méthode, statut, type, URL ; corps via devtools action=\"body\") :";
  return ok(text(`${header}\n${untrusted(lines.join("\n"))}`));
}
