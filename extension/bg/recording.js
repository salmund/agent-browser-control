// Agent Browser Control, service worker : enregistrement GIF / WebM.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Enregistrement (GIF ou vidéo WebM)
// ---------------------------------------------------------------------------

const WEBM_MAX_WIDTH = 1280;
const recordings = new Map(); // tabId -> [{ jpeg, w, h, t, label, point }]
const stoppedRecordings = new Map();

/** Enregistrement GIF en cours sur cet onglet (avec de la place pour une image). */
function isRecording(tabId) {
  const frames = recordings.get(tabId);
  return !!frames && frames.length < MAX_GIF_FRAMES;
}

/** Pause de stabilisation avant une capture : inutile hors enregistrement. */
async function sleepForFrame(tabId, ms) {
  if (isRecording(tabId)) await sleep(ms);
}

async function recordFrame(tabId, label, point) {
  if (!isRecording(tabId)) return;
  try {
    const { jpeg, w, h } = await captureViewport(tabId);
    recordings.get(tabId).push({ jpeg, w, h, t: Date.now(), label, point });
  } catch {}
}

/** Pendant un enregistrement, 'wait' capture une image par seconde (utile pour une vidéo, une animation). */
async function recordingWait(tabId, seconds) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const tick = Date.now();
    await recordFrame(tabId, "");
    await sleep(Math.max(0, Math.min(1000 - (Date.now() - tick), end - Date.now())));
  }
}

async function gifCreator(agent, { tabId, action, filename, format = "gif", quality = "haute", maxWidth, labels = true, border = false }) {
  await assertOwned(agent, tabId);
  switch (action) {
    case "start_recording":
      recordings.set(tabId, []);
      stoppedRecordings.delete(tabId);
      await recordFrame(tabId, "début");
      return ok(text(
        "Enregistrement démarré. Chaque action sur cet onglet ajoute une image ; " +
        "computer action='wait' capture une image par seconde (pour filmer une vidéo ou une animation).",
      ));

    case "stop_recording": {
      const frames = recordings.get(tabId);
      if (!frames) throw new Error("Aucun enregistrement en cours.");
      await recordFrame(tabId, "fin");
      recordings.delete(tabId);
      stoppedRecordings.set(tabId, frames);
      return ok(text(`Enregistrement arrêté : ${frames.length} image(s). Utiliser action='export' (format 'gif' ou 'webm').`));
    }

    case "export": {
      const frames = recordings.get(tabId) ?? stoppedRecordings.get(tabId);
      if (!frames?.length) throw new Error("Aucune image enregistrée.");
      if (!["gif", "webm"].includes(format)) throw new Error("format attendu : 'gif' ou 'webm'.");
      const stem = (filename || `enregistrement-${new Date().toISOString().replace(/[:.]/g, "-")}`).replace(/\.(gif|webm)$/i, "");
      if (!["haute", "standard"].includes(quality)) throw new Error("quality attendue : 'haute' ou 'standard'.");
      const width = Math.min(Math.max(Math.round(maxWidth ?? (format === "webm" ? WEBM_MAX_WIDTH : GIF_MAX_WIDTH)), 200), 1600);
      const style = { labels: labels !== false, border: border === true };
      const base64 = format === "webm"
        ? await renderWebm(frames, width, style)
        : await blobToBase64(new Blob([await renderGif(frames, width, quality, style)]));
      const kind = format === "webm" ? "Vidéo WebM" : "GIF";
      return {
        content: [text(`${kind} exporté (${frames.length} images) : {path}`)],
        _file: { name: `${stem}.${format}`, base64 },
      };
    }

    case "clear":
      recordings.delete(tabId);
      stoppedRecordings.delete(tabId);
      return ok(text("Enregistrement effacé."));

    default:
      throw new Error("action attendue : start_recording, stop_recording, export ou clear.");
  }
}

function outputSize(frames, maxWidth) {
  const { w, h } = frames[0];
  const scale = Math.min(1, maxWidth / w);
  // Dimensions paires : exigées par la plupart des encodeurs vidéo.
  return { width: Math.round((w * scale) / 2) * 2, height: Math.round((h * scale) / 2) * 2 };
}

async function renderGif(frames, maxWidth = GIF_MAX_WIDTH, quality = "haute", style = {}) {
  const { width, height } = outputSize(frames, maxWidth);
  const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
  const encoded = [];
  for (let i = 0; i < frames.length; i++) {
    const bitmap = await createImageBitmap(frames[i].jpeg);
    drawAnnotatedFrame(ctx, bitmap, frames[i], width, height, style);
    bitmap.close();
    encoded.push({ rgba: ctx.getImageData(0, 0, width, height).data, delayMs: frameDelay(frames, i, 400, 3000) });
  }
  return encodeGif(encoded, width, height, { quality });
}

/**
 * Document offscreen unique : encodage vidéo (MediaRecorder) et iframe sandbox des scripts. Création
 * sérialisée : deux appels simultanés ne doivent pas tenter deux documents (Chrome refuse le second).
 */
let offscreenCreating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  offscreenCreating ??= chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS", "IFRAME_SCRIPTING"],
    justification: "Encodage vidéo des enregistrements et exécution isolée des scripts d'agent",
  }).catch((err) => {
    if (!/single offscreen/i.test(String(err?.message))) throw err;
  }).finally(() => {
    offscreenCreating = null;
  });
  await offscreenCreating;
}

/** Un script abandonné ne rend pas la main (boucle infinie) : on jette le document offscreen et son iframe. */
async function resetOffscreen() {
  await chrome.offscreen.closeDocument().catch(() => {});
  for (const runId of scriptRuns.keys()) scriptRuns.get(runId)?.kill?.("Script arrêté : il ne rendait plus la main après son interruption.");
}

/** MediaRecorder n'existe pas dans un service worker : l'encodage se fait dans un document offscreen. */
async function renderWebm(frames, maxWidth = WEBM_MAX_WIDTH, style = {}) {
  const { width, height } = outputSize(frames, maxWidth);
  await ensureOffscreen();
  const payload = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    payload.push({
      dataUrl: `data:image/jpeg;base64,${await blobToBase64(f.jpeg)}`,
      w: f.w, h: f.h, label: f.label, point: f.point,
      delayMs: frameDelay(frames, i, 100, 3000),
    });
  }
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "encode-webm", frames: payload, width, height, style });
  if (!res || res.error) throw new Error(`Encodage WebM impossible : ${res?.error ?? "pas de réponse"}`);
  return res.base64;
}
