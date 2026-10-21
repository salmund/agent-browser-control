// Agent Browser Control, service worker : captures d'écran.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Capture d'écran
// ---------------------------------------------------------------------------

const CAPTURE_TIMEOUT_MS = 500; // capture en arrière-plan : au-delà, la page ne dessine pas (passage devant)
const CAPTURE_FRONT_TIMEOUT_MS = 10_000; // seconde chance, onglet devant
const CAPTURE_BG_FAIL_TTL_MS = 120_000; // un onglet qui ne se dessine pas en arrière-plan passe devant d'emblée

class CaptureTimeout extends Error {}

/** Onglets dont la dernière capture en arrière-plan a échoué : tabId -> horodatage. */
const captureBgFails = new Map();

/**
 * Page.captureScreenshot d'un onglet masqué répond d'habitude vite, mais reste parfois sans réponse
 * (aucune image dessinée) jusqu'au délai du démon (90 s). Délai court, puis l'onglet passe devant le
 * temps d'une seconde capture (withForeground), et l'utilisateur retrouve le sien. Un onglet qui a déjà
 * échoué en arrière-plan passe devant tout de suite pendant 2 min : plus de demi-seconde perdue à chaque capture.
 */
async function captureShot(tabId, { format = "png", quality } = {}) {
  const params = format === "jpeg" ? { format, quality: quality ?? 90 } : { format };
  const shoot = (ms) => {
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CaptureTimeout()), ms);
    });
    return Promise.race([cdp(tabId, "Page.captureScreenshot", params), late]).finally(() => clearTimeout(timer));
  };
  for (const [id, t] of captureBgFails) if (Date.now() - t > CAPTURE_BG_FAIL_TTL_MS) captureBgFails.delete(id);
  if (!captureBgFails.has(tabId)) {
    try {
      return await shoot(CAPTURE_TIMEOUT_MS);
    } catch (err) {
      if (!(err instanceof CaptureTimeout)) throw err;
      captureBgFails.set(tabId, Date.now());
    }
  }
  const tab = await chrome.tabs.get(tabId);
  try {
    return await withForeground(tab, () => shoot(CAPTURE_FRONT_TIMEOUT_MS));
  } catch (err) {
    if (!(err instanceof CaptureTimeout)) throw err;
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    const why = win?.state === "minimized" ? " : la fenêtre du navigateur est réduite, la restaurer" : "";
    throw new Error(`Capture impossible, la page ne se dessine pas${why}. Réessayer, ou lire la page en texte (read_page, get_page_text).`);
  }
}

/** Capture sans perte (OCR, enregistrement image par image). */
const capturePng = (tabId) => captureShot(tabId);

/** Capture le viewport, redimensionnée en pixels CSS (coordonnées image = coordonnées de clic). */
/**
 * Capture du viewport. Par défaut en pixels CSS (coordonnées image = coordonnées de clic).
 * scale (0,2 à 1) réduit l'image ; region [x0, y0, x1, y1] (pixels CSS) zoome sur une zone, à la résolution
 * réelle de l'écran : de quoi lire un petit texte sans envoyer une grande image.
 * Un zoom sur zone sort toujours en qualité JPEG maximale (inspection de détail) ; sinon 0,8.
 */
async function captureViewport(tabId, { scale = 1, region } = {}) {
  await inPage(tabId, "hideOverlay").catch(() => {});
  await refreshDeviceOverride(tabId); // onglet émulé passé devant puis rendu : sans cela, capture en mosaïque
  // JPEG directement (pas d'encodage PNG puis de décodage) ; transmis tel quel s'il est déjà à la bonne taille.
  const [{ w, h }, shot] = await Promise.all([
    evaluateCall(tabId, () => ({ w: innerWidth, h: innerHeight })),
    captureShot(tabId, { format: "jpeg", quality: region ? 100 : 85 }),
  ]);
  const blob = await (await fetch(`data:image/jpeg;base64,${shot.data}`)).blob();
  const bitmap = await createImageBitmap(blob);
  const dpr = bitmap.width / w;
  let src = [0, 0, w, h];
  let outW = Math.round(w * scale);
  let outH = Math.round(h * scale);
  if (region) {
    const [x0, y0, x1, y1] = region.map(Number);
    if (!(x1 > x0 && y1 > y0)) throw new Error("region attendue : [x0, y0, x1, y1] avec x1 > x0 et y1 > y0.");
    src = [Math.max(0, x0), Math.max(0, y0), Math.min(w, x1), Math.min(h, y1)];
    const zoom = Math.min(dpr * 2, 1600 / (src[2] - src[0]));
    outW = Math.round((src[2] - src[0]) * zoom);
    outH = Math.round((src[3] - src[1]) * zoom);
  }
  if (!region && bitmap.width === outW && bitmap.height === outH) {
    bitmap.close();
    return { jpeg: blob, w, h, outW, outH, src };
  }
  const canvas = new OffscreenCanvas(outW, outH);
  canvas.getContext("2d").drawImage(bitmap, src[0] * dpr, src[1] * dpr, (src[2] - src[0]) * dpr, (src[3] - src[1]) * dpr, 0, 0, outW, outH);
  bitmap.close();
  // Zoom sur zone = inspection de détail (design, petit texte) : qualité JPEG maximale.
  // Vue d'ensemble : 0,8 pour contenir le coût (comportement inchangé).
  const quality = region ? 1 : 0.8;
  return { jpeg: await canvas.convertToBlob({ type: "image/jpeg", quality }), w, h, outW, outH, src };
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Gros résultat textuel (>40 000 car.) : le complet part en fichier (le démon l'écrit dans
 * Téléchargements et remplace {path}), l'agent reçoit l'aperçu + les comptes. Le plafond 50k
 * reste un garde-fou, plus un mur : scroll_extract, query et javascript s'en servent.
 */
const BIG_TEXT_CHARS = 40_000;
async function attachBigFile(fullText, stem, ext, preview) {
  const base64 = await blobToBase64(new Blob([fullText], { type: "application/json;charset=utf-8" }));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return { content: [text(preview)], _file: { name: `${stem}-${stamp}.${ext}`, base64 } };
}

/** Légende des pastilles : numéro = ref cliquable, avec libellé court. */
function refLegend(marks, wanted) {
  if (!marks.length) return wanted ? "\nAucun élément à numéroter sur cette vue." : "";
  return `\nPastilles : ${marks.map((m) => `${m.n}=${m.ref}`).join(", ")}.\n` +
    marks.map((m) => `${m.n} (${m.ref}) : ${m.label}`).join("\n");
}

/** Zone de capture cadrée sur l'élément d'une ref (avec une marge), en pixels CSS du viewport. */
async function refRegion(tabId, ref) {
  const p = await locateRef(tabId, ref);
  const w = Number(p.w) || 320;
  const h = Number(p.h) || 200;
  const [vw, vh] = (await evaluate(tabId, "[innerWidth, innerHeight]").catch(() => null)) ?? [1280, 800];
  const pad = 12;
  const x0 = Math.max(0, Math.round(p.x - w / 2 - pad));
  const y0 = Math.max(0, Math.round(p.y - h / 2 - pad));
  const x1 = Math.min(vw, Math.round(p.x + w / 2 + pad));
  const y1 = Math.min(vh, Math.round(p.y + h / 2 + pad));
  if (x1 - x0 < 8 || y1 - y0 < 8) throw new Error(`Élément ${ref} trop petit ou hors écran pour une capture.`);
  return [x0, y0, x1, y1];
}

async function screenshot(tabId, { scale, region, refs = false } = {}) {
  const s = Math.min(Math.max(Number(scale) || 1, 0.2), 1);
  let marks = [];
  if (refs && !region) {
    marks = await inPage(tabId, "refMarks", { limit: 30 }).catch(() => []);
    if (marks.length) await inPage(tabId, "showRefMarks", { marks }).catch(() => {});
  }
  const hideMarks = () => (marks.length ? inPage(tabId, "hideRefMarks").catch(() => {}) : Promise.resolve());
  const { jpeg, w, h, outW, outH, src } = await captureViewport(tabId, { scale: s, region }).finally(hideMarks);
  let note = `Capture ${w}x${h} (pixels CSS du viewport).`;
  if (region) {
    note = `Zoom sur la zone (${src[0]}, ${src[1]}) → (${src[2]}, ${src[3]}), image ${outW}x${outH}. ` +
      `Pour cliquer : x = ${src[0]} + x_image × ${((src[2] - src[0]) / outW).toFixed(3)}, y = ${src[1]} + y_image × ${((src[3] - src[1]) / outH).toFixed(3)}.`;
  } else if (s < 1) {
    note = `Capture réduite à ${Math.round(s * 100)} % (${outW}x${outH}) d'un viewport de ${w}x${h} : pour cliquer, diviser les coordonnées de l'image par ${s}.`;
  }
  return ok(
    { type: "image", data: await blobToBase64(jpeg), mimeType: "image/jpeg" },
    text(`${await overlayNotice(tabId)}${note}${refLegend(marks, refs)}`),
  );
}
