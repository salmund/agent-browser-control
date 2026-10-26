// Bac à sable des scripts d'agent (outil browser_script).
// Page « sandbox » du manifest : origine unique, aucune API chrome.*, réseau bloqué par CSP.
// Le script ne peut agir qu'en appelant les outils de l'extension, relayés par le document offscreen.
// Une iframe par script : le document offscreen identifie le script par la fenêtre émettrice, et
// cette page n'accepte qu'un seul « run » (une iframe ne sert jamais deux fois).

// Origine du document parent attendu (offscreen de l'extension) : celle de l'URL de cette page,
// car une page sandbox a elle-même une origine opaque (« null »).
const PARENT_ORIGIN = new URL(location.href).origin;
const toParent = (msg) => parent.postMessage(msg, PARENT_ORIGIN);
let started = false;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runs = new Map(); // runId -> { pending: Map(callId -> { resolve }), waits: Set, aborted }
let nextCallId = 0;

/** Le contenu des pages arrive encapsulé comme non fiable : le script travaille sur le texte brut. */
function unwrap(text) {
  const m = /^<page_content[^>]*>\n([\s\S]*)\n<\/page_content>$/.exec(text.trim());
  return m ? m[1] : text;
}

function makeApi(runId, initialTab, output, replay, label) {
  const run = runs.get(runId);
  let tab = initialTab;
  let depth = 0; // appels skill() imbriqués
  const MAX_CALLS = 500;
  const TRACE_TEXT_MAX = 20_000;
  const TRACE_CALLS_MAX = 200;
  let seq = 0; // numéro d'appel global (rejoués + exécutés), pour la reprise

  async function call(tool, args = {}) {
    seq++;
    output.seq = seq;
    // Reprise : les appels déjà réussis rejouent la trace, sans ré-exécuter
    // (pas de double envoi). Au-delà, exécution normale.
    if (replay && seq <= replay.from) {
      const rec = replay.trace[seq - 1];
      if (!rec) throw new Error(`Reprise impossible : l'appel ${seq} est absent de la trace (trace tronquée ?).`);
      return { text: rec.text, images: [], isError: !!rec.isError, replayed: true };
    }
    if (run.aborted) throw new Error("Script arrêté (bouton STOP ou délai dépassé).");
    if (++output.calls > MAX_CALLS) throw new Error(`Plus de ${MAX_CALLS} appels d'outils : script interrompu.`);
    const callId = ++nextCallId;
    const result = await new Promise((resolve) => {
      run.pending.set(callId, { resolve });
      toParent({ kind: "call", runId, callId, tool, args });
    });
    const texts = [];
    const images = [];
    for (const c of result?.content ?? []) {
      if (c.type === "text") texts.push(unwrap(c.text));
      else if (c.type === "image") images.push(c);
    }
    const text = texts.join("\n");
    if (output.trace.length < TRACE_CALLS_MAX) {
      output.trace.push({
        tool,
        text: text.length > TRACE_TEXT_MAX ? text.slice(0, TRACE_TEXT_MAX) : text,
        ...(text.length > TRACE_TEXT_MAX ? { truncated: true } : {}),
        isError: !!result?.isError,
      });
    } else {
      output.traceComplete = false;
    }
    return { text, images, isError: !!result?.isError };
  }

  // Variante qui lève une erreur si l'outil échoue : le script peut utiliser try/catch.
  async function must(tool, args) {
    const res = await call(tool, args);
    if (res.isError) {
      output.failedToolCall = output.seq ?? 0;
      throw new Error(res.text.startsWith(`${tool} :`) ? res.text : `${tool} : ${res.text}`);
    }
    return res;
  }

  // Onglet explicite (lectures en parallèle) ou onglet courant.
  const withTab = (args, id) => {
    const t = typeof id === "number" ? id : tab;
    if (typeof t !== "number") throw new Error("Aucun onglet : passer tabId à browser_script, appeler open(url) ou use(tabId).");
    return { tabId: t, ...args };
  };
  const target = (t) => (Array.isArray(t) ? { coordinate: t } : t ? { ref: t } : {});
  const parseJs = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return text === "undefined" ? undefined : text;
    }
  };

  const api = {
    call,
    use: (id) => { tab = id; },
    tab: () => tab,
    nav: async (url) => (await must("navigate", withTab({ url }))).text,
    text: async (id) => (await must("get_page_text", withTab({}, id))).text,
    read: async (filter = "interactive") => (await must("read_page", withTab({ filter }))).text,
    find: async (query) => (await must("find", withTab({ query }))).text,
    click: async (t) => (await must("computer", withTab({ action: "left_click", ...target(t) }))).text,
    type: async (text, t) => (await must("computer", withTab({ action: "type", text, ...target(t) }))).text,
    key: async (keys) => (await must("computer", withTab({ action: "key", text: keys }))).text,
    fill: async (refOrFields, value) => {
      if (Array.isArray(refOrFields)) return (await must("form_input", withTab({ fields: refOrFields, submitRef: value }))).text;
      return (await must("form_input", withTab({ ref: refOrFields, value }))).text;
    },
    js: async (code, id) => parseJs((await must("javascript", withTab({ code }, id))).text),
    // Onglet de travail en arrière-plan, fermé à la fin du script s'il réussit (sauf keep()). use: false pour
    // ouvrir sans changer d'onglet courant (plusieurs pages en parallèle).
    open: async (url, { use = true, keep = false, wait } = {}) => {
      const { text } = await must("tabs_create", { url, ...(label ? { label } : {}), ...(wait ? { wait } : {}) });
      const id = Number(/tabId (\d+)/.exec(text)?.[1]);
      if (!id) throw new Error(`open : onglet non créé (${text.slice(0, 200)}).`);
      if (!keep) output.opened.add(id);
      if (use) tab = id;
      return id;
    },
    close: async (id = tab) => {
      if (typeof id !== "number") return;
      output.opened.delete(id);
      if (id === tab) tab = undefined;
      await call("tabs_close", { tabId: id });
    },
    keep: (id = tab) => { output.opened.delete(id); },
    // Texte principal découpé : { title, url, text } (texte de la page, données non fiables).
    page: async (id) => {
      const raw = (await must("get_page_text", withTab({}, id))).text;
      const title = /^Page : (.*)$/m.exec(raw)?.[1] ?? "";
      const url = /^URL : (.*)$/m.exec(raw)?.[1] ?? "";
      const body = /<page_content[^>]*>\n?([\s\S]*?)\n?<\/page_content>/.exec(raw)?.[1] ?? raw;
      return { title, url, text: body };
    },
    // Requête HTTP hors page (sans cookies) : API publiques, flux. Ne lève pas sur un statut d'erreur.
    http: async (url, { method = "GET", headers, body } = {}) => {
      const res = await call("devtools", { action: "http", url, method, headers, body });
      const head = /^\S+ \S+ → (\d+)/.exec(res.text);
      const status = head ? Number(head[1]) : 0;
      if (!head) throw new Error(`http : ${res.text.slice(0, 300)}`);
      const content = /<page_content[^>]*>\n?([\s\S]*?)\n?<\/page_content>/.exec(res.text)?.[1] ?? "";
      let json;
      try {
        json = JSON.parse(content);
      } catch {}
      return { status, ok: status >= 200 && status < 300, body: content, json };
    },
    // Une autre fonction d'ABC (intégrée ou apprise), exécutée ici même avec les mêmes outils.
    skill: async (name, skillArgs = {}) => {
      if (depth >= 4) throw new Error(`skill(${name}) : 4 niveaux d'appels imbriqués au plus.`);
      const res = await call("__skill_source", { name, args: skillArgs });
      if (res.isError) throw new Error(res.text);
      const src = JSON.parse(res.text);
      const saved = tab;
      depth++;
      try {
        const fn = new AsyncFunction(...names, "args", src.code);
        return await fn(...names.map((n) => api[n]), src.args);
      } catch (err) {
        throw new Error(`skill(${name}) : ${err?.message ?? err}`);
      } finally {
        depth--;
        tab = saved;
      }
    },
    shot: async () => {
      const { images } = await must("computer", withTab({ action: "screenshot" }));
      if (output.images.length < 5) output.images.push(...images.slice(0, 1));
      return `capture ${output.images.length} jointe au résultat`;
    },
    // Interrompue par l'arrêt du script (sinon le script resterait endormi jusqu'à 60 s).
    wait: (seconds) => new Promise((resolve, reject) => {
      if (run.aborted) return reject(new Error("Script arrêté (bouton STOP ou délai dépassé)."));
      const w = { reject };
      w.timer = setTimeout(() => {
        run.waits.delete(w);
        resolve();
      }, Math.min(Number(seconds) || 0, 60) * 1000);
      run.waits.add(w);
    }),
    waitFor: async (conditions) => (await must("wait_for", withTab(conditions))).text,
    saveImage: async (ref, filename) => (await must("save_image", withTab({ ref, filename }))).text,
    dialog: async (accept = true, promptText) => (await must("handle_dialog", withTab({ accept, promptText }))).text,
    log: (...parts) => {
      output.logs.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
    },
  };
  const names = Object.keys(api);
  return api;
}

async function runScript({ runId, code, tabId, replay, args, label }) {
  runs.set(runId, { pending: new Map(), waits: new Set(), aborted: false });
  const output = { logs: [], images: [], calls: 0, trace: [], traceComplete: true, opened: new Set() };
  const api = makeApi(runId, tabId, output, replay && Array.isArray(replay.trace) ? { trace: replay.trace, from: Math.max(0, Number(replay.from) || 0) } : null, label);
  const names = Object.keys(api);
  const fullTrace = () => (replay && Array.isArray(replay.trace) ? [...replay.trace.slice(0, Math.max(0, Number(replay.from) || 0)), ...output.trace] : output.trace);
  try {
    const fn = new AsyncFunction(...names, "args", code);
    const value = await fn(...names.map((n) => api[n]), args && typeof args === "object" ? args : {});
    const plain = value === undefined ? null : JSON.parse(JSON.stringify(value));
    // Onglets ouverts par open() : fermés quand le script réussit ; gardés en cas d'échec, pour voir où il s'est arrêté.
    // Un échec de fermeture est dit dans les logs (et retenté une fois), plutôt qu'un onglet laissé en silence.
    await Promise.all([...output.opened].map(async (id) => {
      for (let essai = 0; essai < 2; essai++) {
        const r = await api.call("tabs_close", { tabId: id }).catch((e) => ({ isError: true, text: String(e?.message ?? e) }));
        if (!r.isError) return;
        if (essai) output.logs.push(`open() : onglet tabId ${id} non refermé (${r.text.slice(0, 160)}).`);
        else await new Promise((res) => setTimeout(res, 400));
      }
    }));
    toParent({ kind: "done", runId, value: plain === undefined ? null : plain, logs: output.logs, images: output.images, calls: output.calls });
  } catch (err) {
    toParent({ kind: "done", runId, error: `${err?.name ?? "Error"}: ${err?.message ?? err}`, logs: output.logs, images: output.images, calls: output.calls, failedAt: output.seq ?? 0, failedToolCall: output.failedToolCall ?? null, trace: fullTrace(), traceComplete: output.traceComplete, openTabs: [...output.opened] });
  } finally {
    runs.delete(runId);
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== parent || event.origin !== PARENT_ORIGIN) return;
  const msg = event.data;
  if (msg?.kind === "run") {
    if (started) return; // une seule exécution par iframe
    started = true;
    runScript(msg);
  }
  else if (msg?.kind === "call-result") runs.get(msg.runId)?.pending.get(msg.callId)?.resolve(msg.result);
  else if (msg?.kind === "abort") {
    const run = runs.get(msg.runId);
    if (!run) return;
    run.aborted = true;
    for (const p of run.pending.values()) p.resolve({ content: [{ type: "text", text: "Script arrêté." }], isError: true });
    for (const w of run.waits) {
      clearTimeout(w.timer);
      w.reject(new Error("Script arrêté (bouton STOP ou délai dépassé)."));
    }
    run.waits.clear();
  }
});

toParent({ kind: "ready" });
