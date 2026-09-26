// Document offscreen : encode un enregistrement en vidéo WebM (MediaRecorder n'existe pas
// dans le service worker). Les images sont rejouées à leur rythme réel.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function encodeWebm({ frames, width, height }) {
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
    drawAnnotatedFrame(ctx, bitmap, frame, width, height);
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
