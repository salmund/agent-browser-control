// Document offscreen : encode un enregistrement en vidéo WebM (MediaRecorder n'existe pas
// dans le service worker). Les images sont rejouées à leur rythme réel.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function encodeWebm({ frames, width, height, style }) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  // captureStream(0) + requestFrame() : on émet les images nous-mêmes, sans dépendre du rendu
  // (le document offscreen n'est jamais affiché).
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (recorder.onstop = r));
  recorder.start(500);

  for (const frame of frames) {
    const bitmap = await createImageBitmap(await (await fetch(frame.dataUrl)).blob());
    drawAnnotatedFrame(ctx, bitmap, frame, width, height, style);
    bitmap.close();
    // Réémet l'image toutes les 100 ms pour que la vidéo garde un rythme régulier.
    const end = performance.now() + frame.delayMs;
    while (performance.now() < end) {
      track.requestFrame();
      await sleep(Math.min(100, end - performance.now()));
    }
  }
  track.requestFrame();
  recorder.stop();
  await stopped;

  const blob = new Blob(chunks, { type: "video/webm" });
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
  return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), size: blob.size };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== "offscreen" || msg.type !== "encode-webm") return;
  encodeWebm(msg).then(reply, (err) => reply({ error: String(err?.message ?? err) }));
  return true; // réponse asynchrone
});

// ---------------------------------------------------------------------------
// Scripts d'agent : chaque script s'exécute dans SA propre iframe sandbox (origine opaque, sans
// réseau). Les messages d'une iframe ne concernent que son script : le script est identifié par
// la fenêtre émettrice (event.source), jamais par le runId écrit dans le message (un script ne
// peut ni répondre ni appeler des outils au nom d'un autre). Une iframe sert une seule fois.
// ---------------------------------------------------------------------------

const STUCK_MS = 4500; // après une interruption, délai avant de jeter l'iframe (sous les 5 s du service worker)

const scriptRuns = new Map(); // runId -> { frame, reply, stuckTimer, done }
const frameRuns = new Map(); // contentWindow -> runId
let spare = null; // iframe préchargée pour le prochain script : { frame, ready, loads }

/** Nouvelle iframe sandbox, prête quand elle a envoyé « ready ». */
function createSandbox() {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts"); // en plus de la CSP sandbox du manifest
  frame.src = "sandbox.html";
  const box = { frame, loads: 0, isReady: false };
  box.ready = new Promise((resolve) => (box.resolveReady = resolve));
  frame.addEventListener("load", () => {
    box.loads++;
    // L'iframe a navigué (location changée par le script) : son contenu n'est plus le nôtre.
    if (box.loads > 1) discardSandbox(box, "Le bac à sable a navigué (page remplacée par le script) : script arrêté.");
  });
  box.timeout = setTimeout(() => {
    if (!box.isReady) discardSandbox(box, "Le bac à sable ne s'est pas chargé (10 s).");
  }, 10_000);
  document.body.append(frame);
  return box;
}

function takeSandbox() {
  const box = spare && spare.frame.isConnected ? spare : createSandbox();
  spare = createSandbox(); // la suivante se charge pendant que celle-ci travaille
  return box;
}

/** Retire une iframe ; si un script y tournait, il échoue avec ce motif. */
function discardSandbox(box, reason) {
  clearTimeout(box.timeout);
  const win = box.frame.contentWindow;
  const runId = win ? frameRuns.get(win) : null;
  if (win) frameRuns.delete(win);
  box.frame.remove();
  box.resolveReady?.(false);
  if (spare === box) spare = null;
  if (runId) finishRun(runId, { error: reason, logs: [], images: [], calls: null });
}

function finishRun(runId, result) {
  const run = scriptRuns.get(runId);
  if (!run || run.done) return;
  run.done = true;
  clearTimeout(run.stuckTimer);
  scriptRuns.delete(runId);
  try {
    run.reply(result);
  } catch {}
  // Une iframe ne sert qu'une fois : l'état d'un script ne fuit pas dans le suivant.
  const win = run.box.frame.contentWindow;
  if (win) frameRuns.delete(win);
  clearTimeout(run.box.timeout);
  run.box.frame.remove();
}

window.addEventListener("message", async (e) => {
  // Une page sandbox a une origine opaque : « null ». Toute autre origine est ignorée.
  if (e.origin !== "null" || !e.source) return;
  const msg = e.data;
  if (msg?.kind === "ready") {
    const box = [spare, ...[...scriptRuns.values()].map((r) => r.box)].find((b) => b && b.frame.contentWindow === e.source);
    if (box && !box.isReady) {
      box.isReady = true;
      clearTimeout(box.timeout);
      box.resolveReady(true);
    }
    return;
  }
  const runId = frameRuns.get(e.source);
  const run = runId ? scriptRuns.get(runId) : null;
  if (!run) return;
  if (msg?.kind === "call") {
    const result = await chrome.runtime
      .sendMessage({ type: "script-call", runId, tool: msg.tool, args: msg.args })
      .catch((err) => ({ content: [{ type: "text", text: String(err?.message ?? err) }], isError: true }));
    if (!run.done) run.box.frame.contentWindow?.postMessage({ kind: "call-result", runId, callId: msg.callId, result }, "*");
  } else if (msg?.kind === "done") {
    const { kind, runId: _ignored, ...result } = msg;
    finishRun(runId, result);
  }
});

async function startRun(msg, reply) {
  if (scriptRuns.has(msg.runId)) {
    reply({ error: "Script déjà en cours avec cet identifiant.", logs: [], images: [], calls: null });
    return;
  }
  const box = takeSandbox();
  const run = { box, reply, stuckTimer: null, done: false, started: false };
  scriptRuns.set(msg.runId, run);
  const ok = await box.ready;
  if (run.done) return; // interrompu ou jeté pendant le chargement
  const win = box.frame.contentWindow;
  if (!ok || !win) {
    finishRun(msg.runId, { error: "Bac à sable indisponible : script non lancé.", logs: [], images: [], calls: null });
    return;
  }
  frameRuns.set(win, msg.runId);
  run.started = true;
  win.postMessage({ kind: "run", runId: msg.runId, code: msg.code, tabId: msg.tabId, replay: msg.replay ?? null, args: msg.args ?? {}, label: msg.label }, "*");
}

function abortRun(runId) {
  const run = scriptRuns.get(runId);
  if (!run || run.done || run.stuckTimer) return;
  if (!run.started) {
    finishRun(runId, { error: "Script arrêté avant son démarrage.", logs: [], images: [], calls: null });
    return;
  }
  run.box.frame.contentWindow?.postMessage({ kind: "abort", runId }, "*");
  // Pas de réponse peu après l'interruption (boucle, attente longue) : on jette l'iframe, ce qui
  // arrête le script, et on prévient le service worker.
  run.stuckTimer = setTimeout(() => {
    if (run.done) return;
    finishRun(runId, {
      error: "Script arrêté : il ne rendait plus la main après son interruption (bac à sable détruit).",
      stuck: true, logs: [], images: [], calls: null,
    });
    chrome.runtime.sendMessage({ type: "script-stuck", runId, handled: true }).catch(() => {});
  }, STUCK_MS);
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "run-script") {
    startRun(msg, reply);
    return true; // réponse asynchrone
  }
  if (msg.type === "abort-script") abortRun(msg.runId);
});

spare = createSandbox();
