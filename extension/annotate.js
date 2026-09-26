// Dessin d'une image d'enregistrement avec ses annotations (point d'action, légende).
// Partagé entre le service worker (GIF) et le document offscreen (vidéo WebM).

/** Délai d'affichage d'une image : écart réel avec la suivante, borné. */
function frameDelay(frames, i, minMs, maxMs) {
  const next = frames[i + 1];
  return next ? Math.min(Math.max(next.t - frames[i].t, minMs), maxMs) : 2000;
}

/**
 * options.labels : légende de l'action en bas à gauche (défaut true).
 * options.border : bordure violette lumineuse, comme sur un onglet piloté par un agent (défaut false).
 */
function drawAnnotatedFrame(ctx, bitmap, frame, width, height, { labels = true, border = false } = {}) {
  const scale = width / frame.w;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (border) {
    // Halo intérieur en dégradé, puis trait net : le rendu de l'overlay de page.js.
    const glow = Math.max(6, Math.round(width / 70));
    for (let i = glow; i > 0; i--) {
      ctx.strokeStyle = `rgba(139, 92, 246, ${(0.5 * (1 - i / glow)).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(i, i, width - 2 * i, height - 2 * i);
    }
    ctx.strokeStyle = "rgba(139, 92, 246, 0.9)";
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, width - 4, height - 4);
  }
  if (frame.point) {
    ctx.strokeStyle = "rgb(139, 92, 246)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(frame.point.x * scale, frame.point.y * scale, 14, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (labels && frame.label) {
    const size = Math.max(12, Math.round(width / 57));
    ctx.font = `bold ${size}px sans-serif`;
    const label = frame.label.slice(0, 80);
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(0, 0, 0, .75)";
    ctx.fillRect(8, height - size * 2.3, tw + size * 1.2, size * 1.7);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, 8 + size * 0.6, height - size * 1.05);
  }
}
