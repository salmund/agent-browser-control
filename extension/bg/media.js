// Agent Browser Control, service worker : images, OCR, médias et transcriptions.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// save_image : enregistrer une image de la page sur le disque
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp",
};

async function saveImage(agent, { tabId, ref, filename, show = false }) {
  await assertOwned(agent, tabId);
  const target = ref ? parseRef(ref) : { frameId: 0, ref: undefined };
  const img = await inPage(tabId, "imageData", { ref: target.ref }, target.frameId);

  let { base64, mime } = img;
  if (img.kind === "url") {
    // Image publique d'un autre domaine : l'extension la télécharge elle-même, sans cookies.
    await assertAllowed(img.url);
    const res = await fetch(img.url, { credentials: "omit", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Téléchargement de l'image refusé (HTTP ${res.status}).`);
    const blob = await res.blob();
    mime = blob.type || res.headers.get("content-type") || "";
    base64 = await blobToBase64(blob);
  }
  mime = mime.split(";")[0].trim();
  if (!mime.startsWith("image/")) throw new Error(`Ce n'est pas une image (${mime || "type inconnu"}).`);

  const ext = IMAGE_EXTENSIONS[mime] ?? mime.slice(6).replace(/\W/g, "");
  const fromAlt = img.alt.replace(/,?\s*généré par IA/i, "").trim().slice(0, 60);
  const stem = (filename || fromAlt || `image-${new Date().toISOString().replace(/[:.]/g, "-")}`).replace(/\.\w{2,5}$/, "");
  const bytes = Math.round((base64.length * 3) / 4);
  const size = bytes > 1_048_576 ? `${(bytes / 1_048_576).toFixed(1).replace(".", ",")} Mo` : `${Math.round(bytes / 1024)} Ko`;

  const content = [text(`Image enregistrée (${img.w}×${img.h}, ${size}, ${mime}) : {path}`)];
  // show : l'agent voit aussi l'image (pour vérifier ce qu'il a enregistré) ; pas pour le SVG, que les modèles ne lisent pas.
  if (show && mime !== "image/svg+xml" && bytes < 4_000_000) content.push({ type: "image", data: base64, mimeType: mime });
  await recordFrame(tabId, `save_image ${ref ?? "(plus grande image)"}`);
  return { content, _file: { name: `${stem}.${ext}`, base64 } };
}

// ---------------------------------------------------------------------------
// Lire le texte d'une page dessinée dans un canvas : export de l'application, sinon OCR
// ---------------------------------------------------------------------------

/**
 * Adaptateurs : des applis qui dessinent leur contenu mais savent l'exporter. On demande l'export depuis la
 * page (même origine, avec la session de l'utilisateur) : texte exact, en une requête, sans capture.
 */
const ADAPTERS = [
  { name: "Google Docs", match: /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]+)/, path: (m) => `/document/d/${m[1]}/export?format=txt` },
  {
    name: "Google Sheets",
    match: /^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)/,
    path: (m, url) => `/spreadsheets/d/${m[1]}/export?format=csv&gid=${/gid=(\d+)/.exec(url)?.[1] ?? 0}`,
  },
  { name: "Google Slides", match: /^https:\/\/docs\.google\.com\/presentation\/(?:u\/\d+\/)?d\/([\w-]+)/, path: (m) => `/presentation/d/${m[1]}/export/txt` },
];

async function adapterText(tabId, url) {
  for (const adapter of ADAPTERS) {
    const m = adapter.match.exec(url ?? "");
    if (!m) continue;
    const path = adapter.path(m, url);
    const res = await cdp(tabId, "Runtime.evaluate", {
      expression: `fetch(${JSON.stringify(path)}, { credentials: "include" }).then((r) => r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status)))`,
      awaitPromise: true,
      returnByValue: true,
    }).catch(() => null);
    let body = res && !res.exceptionDetails ? res.result?.value : null;
    if (typeof body !== "string") {
      // Export redirigé vers un autre domaine (bloqué en CORS depuis la page) : l'extension le télécharge elle-même.
      const direct = await fetch(new URL(path, url), { credentials: "include" }).catch(() => null);
      body = direct?.ok ? await direct.text() : null;
    }
    if (typeof body !== "string") return null;
    body = body.replace(/^﻿/, "").trim();
    return { name: adapter.name, text: body.length > 50_000 ? `${body.slice(0, 50_000)}\n[Tronqué]` : body || "(document vide)" };
  }
  return null;
}

/**
 * Capture pour l'OCR : au moins 2 pixels d'image par pixel CSS (la reconnaissance est bien meilleure sur un
 * texte plus grand). pxToCss et offset permettent au démon de rendre des positions cliquables.
 */
async function captureForOcr(tabId, region) {
  await inPage(tabId, "hideOverlay").catch(() => {});
  const [{ w, h }, shot] = await Promise.all([
    evaluate(tabId, "({ w: innerWidth, h: innerHeight })"),
    capturePng(tabId),
  ]);
  const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${shot.data}`)).blob());
  const dpr = bitmap.width / w;
  const [x0, y0, x1, y1] = region ? region.map(Number) : [0, 0, w, h];
  const src = [Math.max(0, x0), Math.max(0, y0), Math.min(w, x1), Math.min(h, y1)];
  if (!(src[2] > src[0] && src[3] > src[1])) throw new Error("region attendue : [x0, y0, x1, y1] dans le viewport.");
  const factor = Math.min(Math.max(2, dpr), 9000 / Math.max(src[2] - src[0], src[3] - src[1]));
  const canvas = new OffscreenCanvas(Math.round((src[2] - src[0]) * factor), Math.round((src[3] - src[1]) * factor));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, src[0] * dpr, src[1] * dpr, (src[2] - src[0]) * dpr, (src[3] - src[1]) * dpr, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const png = await canvas.convertToBlob({ type: "image/png" });
  return { base64: await blobToBase64(png), pxToCss: 1 / factor, offset: [src[0], src[1]] };
}

/** read_screen_text : le texte affiché à l'écran (ou dans une zone), lu par OCR, avec sa position. */
async function readScreenText(agent, { tabId, region }) {
  await assertOwned(agent, tabId);
  await ensureAttached(tabId);
  return { content: [text(`${await overlayNotice(tabId)}{ocr}`)], _ocr: await captureForOcr(tabId, region) };
}

// ---------------------------------------------------------------------------
// download_media : l'extension vérifie l'URL, le démon lance yt-dlp
// ---------------------------------------------------------------------------

async function downloadMedia(agent, args) {
  let url = args.url;
  if (typeof args.tabId === "number") {
    const tab = await assertOwned(agent, args.tabId);
    url ??= tab.url;
  }
  if (!url) throw new Error("Préciser 'url', ou 'tabId' pour la page ouverte dans l'onglet.");
  if (!/^https?:\/\//i.test(url)) throw new Error("URL http(s) attendue.");
  await assertAllowed(url);
  const { action = "download", mode, quality, audioFormat, subtitles, playlist } = args;
  if (!["download", "info"].includes(action)) throw new Error("action attendue : download, info ou status.");
  return {
    content: [text(`${action === "info" ? "Informations" : "Téléchargement"} : ${url}`)],
    _media: { url, action, mode, quality, audioFormat, subtitles, playlist },
  };
}

// ---------------------------------------------------------------------------
// transcript : le texte d'une vidéo, lu dans la page comme le fait le lecteur
// ---------------------------------------------------------------------------

/**
 * YouTube refuse souvent les sous-titres demandés hors du lecteur (HTTP 429 pour yt-dlp, réponse vide sans
 * jeton). On réutilise donc la requête signée du lecteur de l'onglet : on allume les sous-titres si besoin,
 * on relève l'URL qu'il a appelée, on la rejoue pour la langue voulue, puis on remet le lecteur comme avant.
 */
const YOUTUBE_TRANSCRIPT = String.raw`async ({ lang, translate }) => {
  // Onglet tout juste ouvert : le lecteur arrive après la page.
  let player, response;
  for (let i = 0; i < 50 && !response?.videoDetails; i++) {
    player = document.querySelector("#movie_player");
    response = player?.getPlayerResponse?.();
    if (!response?.videoDetails) await new Promise((r) => setTimeout(r, 200));
  }
  if (!response) return { error: "Lecteur YouTube introuvable : ouvrir la page de la vidéo (youtube.com/watch?v=…)." };
  const videoId = response.videoDetails?.videoId;
  const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) return { error: "Cette vidéo n'a pas de sous-titres, même automatiques." };
  const base = (code) => code.split("-")[0];
  const spoken = tracks.find((t) => t.kind === "asr")?.languageCode;
  const wanted = lang ? [lang] : [spoken, "fr", "en"].filter(Boolean);
  const pick = wanted.map((l) => tracks.find((t) => t.languageCode === l && t.kind !== "asr") ?? tracks.find((t) => t.languageCode === l)
    ?? tracks.find((t) => base(t.languageCode) === base(l))).find(Boolean) ?? tracks[0];
  if (lang && base(pick.languageCode) !== base(lang) && !translate) {
    return { error: "Pas de sous-titres en " + lang + ". Disponibles : " + tracks.map((t) => t.languageCode + (t.kind === "asr" ? " (auto)" : "")).join(", ") + ". Ou translate: \"" + lang + "\"." };
  }
  const signed = () => performance.getEntriesByType("resource").map((e) => e.name)
    .filter((u) => u.includes("/api/timedtext") && u.includes("pot=") && u.includes("v=" + videoId)).pop();
  let url = signed();
  if (!url) {
    const wasOn = player.isSubtitlesOn?.();
    const before = player.getOption?.("captions", "track") ?? {};
    performance.setResourceTimingBufferSize?.(2000);
    player.loadModule?.("captions");
    player.setOption?.("captions", "track", { languageCode: pick.languageCode });
    for (let i = 0; i < 40 && !url; i++) { await new Promise((r) => setTimeout(r, 200)); url = signed(); }
    // Remettre le lecteur comme l'utilisateur l'avait laissé : même piste, sous-titres affichés ou non.
    if (before.languageCode) player.setOption?.("captions", "track", before);
    await new Promise((r) => setTimeout(r, 100));
    if (player.isSubtitlesOn?.() !== wasOn) player.toggleSubtitles?.();
    if (!url) return { error: "Le lecteur n'a pas chargé les sous-titres (publicité en cours, vidéo pas encore lancée ?). Réessayer dans quelques secondes." };
  }
  const u = new URL(url);
  u.searchParams.set("lang", pick.languageCode);
  u.searchParams.set("fmt", "json3");
  if (pick.kind) u.searchParams.set("kind", pick.kind); else u.searchParams.delete("kind");
  if (translate && base(translate) !== base(pick.languageCode)) u.searchParams.set("tlang", translate); else u.searchParams.delete("tlang");
  const r = await fetch(u);
  const body = await r.text();
  if (!r.ok || !body) return { error: "YouTube a refusé les sous-titres (HTTP " + r.status + ")." };
  const segments = (JSON.parse(body).events ?? []).filter((e) => e.segs)
    .map((e) => ({ t: Math.floor((e.tStartMs ?? 0) / 1000), text: e.segs.map((s) => s.utf8).join("").replace(/\s+/g, " ").trim() }))
    .filter((s) => s.text);
  return {
    title: response.videoDetails?.title, author: response.videoDetails?.author, seconds: Number(response.videoDetails?.lengthSeconds),
    language: pick.languageCode + (pick.kind === "asr" ? " (automatiques)" : "") + (u.searchParams.get("tlang") ? " traduits en " + translate : ""),
    segments,
  };
}`;

const clock = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/** « 754 », « 12:34 » ou « 1:02:03 » : secondes. */
const seconds = (v) => (v === undefined || v === "" ? undefined : String(v).split(":").reduce((acc, n) => acc * 60 + Number(n), 0));

async function transcript(agent, { tabId, lang, translate, start: startAt, end: endAt }) {
  const tab = await assertOwned(agent, tabId);
  if (!/^https:\/\/(www\.|m\.)?youtube\.com\//.test(tab.url ?? "")) {
    throw new Error("transcript lit les vidéos YouTube ouvertes dans l'onglet. Pour un autre site : download_media avec mode='subtitles'.");
  }
  await ensureAttached(tabId);
  const res = await cdp(tabId, "Runtime.evaluate", {
    expression: `(${YOUTUBE_TRANSCRIPT})(${JSON.stringify({ lang, translate })})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) throw new Error(`Lecture de la transcription impossible : ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
  const data = res.result?.value;
  if (!data || data.error) return fail(data?.error ?? "Transcription introuvable.");
  // Paragraphes d'environ 30 s, repérés par leur minutage : lisible, et on peut y renvoyer.
  const start = seconds(startAt) || 0;
  const end = seconds(endAt) ?? Infinity;
  const paragraphs = [];
  for (const seg of data.segments.filter((s) => s.t >= start && s.t <= end)) {
    const last = paragraphs.at(-1);
    if (last && seg.t - last.t < 30) last.text += ` ${seg.text}`;
    else paragraphs.push({ t: seg.t, text: seg.text });
  }
  let body = paragraphs.map((p) => `[${clock(p.t)}] ${p.text}`).join("\n");
  if (body.length > 60_000) {
    const cut = body.lastIndexOf("\n[", 60_000);
    const next = /^\[([\d:]+)\]/.exec(body.slice(cut + 1))?.[1];
    body = `${body.slice(0, cut)}\n[Tronqué : suite avec start=${next}.]`;
  }
  const header = `« ${data.title} »${data.author ? ` par ${data.author}` : ""}, ${clock(data.seconds || 0)}. Sous-titres : ${data.language}.`;
  return ok(text(`${header}\n${untrusted(body || "(rien dans cet intervalle)")}`));
}
