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

function makeApi(runId, initialTab, output, replay) {
  const run = runs.get(runId);
  let tab = initialTab;
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

  const withTab = (args) => {
    if (typeof tab !== "number") throw new Error("Aucun onglet : passer tabId à browser_script ou appeler use(tabId).");
    return { tabId: tab, ...args };
  };
  const target = (t) => (Array.isArray(t) ? { coordinate: t } : t ? { ref: t } : {});

  return {
    call,
    use: (id) => { tab = id; },
    tab: () => tab,
    nav: async (url) => (await must("navigate", withTab({ url }))).text,
    text: async () => (await must("get_page_text", withTab())).text,
    read: async (filter = "interactive") => (await must("read_page", withTab({ filter }))).text,
    find: async (query) => (await must("find", withTab({ query }))).text,
    click: async (t) => (await must("computer", withTab({ action: "left_click", ...target(t) }))).text,
    type: async (text, t) => (await must("computer", withTab({ action: "type", text, ...target(t) }))).text,
    key: async (keys) => (await must("computer", withTab({ action: "key", text: keys }))).text,
    fill: async (refOrFields, value) => {
      if (Array.isArray(refOrFields)) return (await must("form_input", withTab({ fields: refOrFields, submitRef: value }))).text;
      return (await must("form_input", withTab({ ref: refOrFields, value }))).text;
    },
    js: async (code) => {
      const { text } = await must("javascript", withTab({ code }));
      try {
        return JSON.parse(text);
      } catch {
        return text === "undefined" ? undefined : text;
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
}

async function runScript({ runId, code, tabId, replay }) {
  runs.set(runId, { pending: new Map(), waits: new Set(), aborted: false });
  const output = { logs: [], images: [], calls: 0, trace: [], traceComplete: true };
  const api = makeApi(runId, tabId, output, replay && Array.isArray(replay.trace) ? { trace: replay.trace, from: Math.max(0, Number(replay.from) || 0) } : null);
  const names = Object.keys(api);
  const fullTrace = () => (replay && Array.isArray(replay.trace) ? [...replay.trace.slice(0, Math.max(0, Number(replay.from) || 0)), ...output.trace] : output.trace);
  try {
    const fn = new AsyncFunction(...names, code);
    const value = await fn(...names.map((n) => api[n]));
    const plain = value === undefined ? null : JSON.parse(JSON.stringify(value));
    toParent({ kind: "done", runId, value: plain === undefined ? null : plain, logs: output.logs, images: output.images, calls: output.calls });
  } catch (err) {
    toParent({ kind: "done", runId, error: `${err?.name ?? "Error"}: ${err?.message ?? err}`, logs: output.logs, images: output.images, calls: output.calls, failedAt: output.seq ?? 0, failedToolCall: output.failedToolCall ?? null, trace: fullTrace(), traceComplete: output.traceComplete });
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
