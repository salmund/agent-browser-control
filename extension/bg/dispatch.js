// Agent Browser Control, service worker : table des outils et exécution.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

const TOOLS = {
  tabs_context: tabsContext,
  tabs_create: tabsCreate,
  tabs_close: tabsClose,
  tabs_cleanup: tabsCleanup,
  history_search: historySearch,
  site_api: siteApi,
  navigate,
  computer: withFrontForMouse(computer),
  read_page: withDrawnPage(readPage),
  find: withDrawnPage(find),
  scroll_extract: scrollExtract,
  query: querySelect,
  read_tables: readTables,
  replay_paginated: replayPaginated,
  form_input: formInput,
  credentials_fill: credentialsFill,
  credentials_list: credentialsList,
  get_page_text: withDrawnPage(getPageText),
  javascript,
  devtools,
  read_console_messages: readConsoleMessages,
  read_network_requests: readNetworkRequests,
  file_upload: fileUpload,
  resize_window: resizeWindow,
  gif_creator: gifCreator,
  network_intercept: networkIntercept,
  network_get_body: networkGetBody,
  network_har: networkHar,
  storage,
  performance_metrics: performanceMetrics,
  emulate,
  pdf,
  read_websocket_messages: readWebsocketMessages,
  browser_script: browserScript,
  wait_for: waitFor,
  save_image: saveImage,
  read_screen_text: readScreenText,
  download_media: downloadMedia,
  transcript,
  downloads,
  handle_dialog: handleDialog,
  http_request: httpRequest,
  ask_human: askHuman,
  demo,
};

let callSeq = 0;

/** Outils qui acceptent `target` (libellé) à la place de `ref`. form_input et steps le résolvent champ par champ. */
const TARGET_TOOLS = new Set(["computer", "file_upload"]);

/**
 * Exécute un outil pour un agent : contrôles (STOP, pause), ligne de journal, puis l'outil lui-même,
 * en course avec abort() (STOP, pause de l'agent, annulation par le démon). Ne rejette jamais.
 * `daemonId` : id de l'appel côté démon (annulation) ; `parentRun` : script qui fait l'appel.
 */
async function runTool(agent, tool, rawArgs, { daemonId, parentRun } = {}) {
  await Promise.all([pausedLoaded, activityLoaded]);
  if (paused) return fail(PAUSED_MESSAGE);
  const fn = TOOLS[tool];
  if (!fn) return fail(`Outil inconnu : ${tool}`);
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};

  const tab = typeof args.tabId === "number" ? await chrome.tabs.get(args.tabId).catch(() => null) : null;
  // Le journal attribue l'action au sous-agent (« agent · étiquette ») quand on peut le savoir, pas seulement à l'agent.
  const actor = await actorOf(agent, tool, args, tab).catch(() => agent);
  const pausedKey = pausedKeyFor(actor);
  // Agent en pause : la consigne que l'utilisateur lui a laissée dans le panneau accompagne le refus.
  if (pausedKey) return parentRun ? fail(agentPausedMessage(pausedKey)) : withAgentMessages(fail(agentPausedMessage(pausedKey)), actor, tool);
  rememberAgent(agent);

  const entry = { id: ++activityId, t: Date.now(), agent: actor, color: "grey", tool, summary: "", status: "running" };
  try {
    entry.color = await actorColor(actor);
    entry.summary = summarize(tool, args);
    entry.target = activityTarget(tool, args);
    if (typeof args.action === "string") entry.action = args.action;
    if (Array.isArray(args.steps)) entry.steps = args.steps.length;
    const where = tool === "navigate" || tool === "tabs_create" ? args.url : tab?.url;
    entry.host = hostOf(where);
    if (tab) entry.tabId = tab.id;
    if (parentRun) entry.parent = parentRun;
  } catch {
    // Arguments inattendus : la ligne reste minimale, l'outil répondra lui-même par une erreur claire.
  }
  logActivity(entry);

  const key = ++callSeq;
  const call = { agent, actor, tabId: tab?.id, daemonId, settled: false, halted: false };
  const aborted = new Promise((resolve) => {
    call.abort = (message, { halt = false } = {}) => {
      if (halt && call.tabId !== undefined && !call.settled && !call.halted) {
        call.halted = true;
        haltedTabs.set(call.tabId, (haltedTabs.get(call.tabId) ?? 0) + 1);
      }
      resolve(fail(message));
    };
  });
  runningCalls.set(key, call);
  // `target` (libellé) à la place d'une ref : résolu ici, après contrôle de propriété de l'onglet.
  const work = Promise.resolve().then(async () => {
    let note = "";
    if (TARGET_TOOLS.has(tool) && typeof args.target === "string" && typeof args.tabId === "number" && !Array.isArray(args.steps)) {
      await assertOwned(agent, args.tabId);
      note = await resolveTarget(args.tabId, args);
    }
    return withNotes(await fn(agent, args), [note]);
  });
  work.catch(() => {}).finally(() => {
    call.settled = true;
    if (call.halted) {
      const n = (haltedTabs.get(call.tabId) ?? 1) - 1;
      if (n > 0) haltedTabs.set(call.tabId, n);
      else haltedTabs.delete(call.tabId);
    }
  });

  let result;
  try {
    result = await Promise.race([work, aborted]);
  } catch (err) {
    result = fail(`${tool} : ${err?.message ?? err}`);
  } finally {
    runningCalls.delete(key);
    if (call.tabId !== undefined) lastCallEnd.set(call.tabId, Date.now());
  }
  if (!result || !Array.isArray(result.content)) result = fail(`${tool} : l'outil n'a rien renvoyé.`);

  if (tool === "tabs_create") {
    // Le groupe d'un nouveau sous-agent vient d'être créé : sa couleur est maintenant connue.
    entry.color = await actorColor(actor).catch(() => entry.color);
    const id = Number(/tabId (\d+)/.exec(result.content[0]?.text ?? "")?.[1]);
    if (id) entry.tabId = id;
  }
  entry.status = result.isError ? "error" : "ok";
  if (result.isError) entry.error = result.content.find((c) => c.type === "text")?.text?.slice(0, 300);
  entry.ms = Date.now() - entry.t;
  publishActivity();
  // Appel fait par un script (browser_script) : c'est le script qui lit la réponse, pas l'agent. Le message
  // attend la réponse du script lui-même.
  return parentRun ? result : withAgentMessages(result, actor, tool);
}
