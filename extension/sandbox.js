// Bac à sable des scripts d'agent (outil browser_script).
// Page « sandbox » du manifest : origine unique, aucune API chrome.*, réseau bloqué par CSP.
// Le script ne peut agir qu'en appelant les outils de l'extension, relayés par le document offscreen.

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runs = new Map(); // runId -> { pending: Map(callId -> { resolve }), aborted }
let nextCallId = 0;

/** Le contenu des pages arrive encapsulé comme non fiable : le script travaille sur le texte brut. */
function unwrap(text) {
  const m = /^<page_content[^>]*>\n([\s\S]*)\n<\/page_content>$/.exec(text.trim());
  return m ? m[1] : text;
}

function makeApi(runId, initialTab, output) {
  const run = runs.get(runId);
  let tab = initialTab;
  const MAX_CALLS = 500;

  async function call(tool, args = {}) {
    if (run.aborted) throw new Error("Script arrêté (bouton STOP ou délai dépassé).");
    if (++output.calls > MAX_CALLS) throw new Error(`Plus de ${MAX_CALLS} appels d'outils : script interrompu.`);
    const callId = ++nextCallId;
    const result = await new Promise((resolve) => {
      run.pending.set(callId, { resolve });
      parent.postMessage({ kind: "call", runId, callId, tool, args }, "*");
    });
    const texts = [];
    const images = [];
    for (const c of result?.content ?? []) {
      if (c.type === "text") texts.push(unwrap(c.text));
      else if (c.type === "image") images.push(c);
    }
    return { text: texts.join("\n"), images, isError: !!result?.isError };
  }

  // Variante qui lève une erreur si l'outil échoue : le script peut utiliser try/catch.
  async function must(tool, args) {
    const res = await call(tool, args);
    if (res.isError) throw new Error(res.text.startsWith(`${tool} :`) ? res.text : `${tool} : ${res.text}`);
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
    fill: async (ref, value) => (await must("form_input", withTab({ ref, value }))).text,
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
    wait: (seconds) => new Promise((r) => setTimeout(r, Math.min(seconds, 60) * 1000)),
    waitFor: async (conditions) => (await must("wait_for", withTab(conditions))).text,
    dialog: async (accept = true, promptText) => (await must("handle_dialog", withTab({ accept, promptText }))).text,
    log: (...parts) => {
      output.logs.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
    },
  };
}

async function runScript({ runId, code, tabId }) {
  runs.set(runId, { pending: new Map(), aborted: false });
  const output = { logs: [], images: [], calls: 0 };
  const api = makeApi(runId, tabId, output);
  const names = Object.keys(api);
  try {
    const fn = new AsyncFunction(...names, code);
    const value = await fn(...names.map((n) => api[n]));
    parent.postMessage({ kind: "done", runId, value: value === undefined ? null : JSON.parse(JSON.stringify(value)), ...output }, "*");
  } catch (err) {
    parent.postMessage({ kind: "done", runId, error: `${err?.name ?? "Error"}: ${err?.message ?? err}`, ...output }, "*");
  } finally {
    runs.delete(runId);
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const msg = event.data;
  if (msg?.kind === "run") runScript(msg);
  else if (msg?.kind === "call-result") runs.get(msg.runId)?.pending.get(msg.callId)?.resolve(msg.result);
  else if (msg?.kind === "abort") {
    const run = runs.get(msg.runId);
    if (!run) return;
    run.aborted = true;
    for (const p of run.pending.values()) p.resolve({ content: [{ type: "text", text: "Script arrêté." }], isError: true });
  }
});

parent.postMessage({ kind: "ready" }, "*");
