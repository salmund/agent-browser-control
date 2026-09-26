// Encodeur GIF89a minimal (palette fixe 256 couleurs, LZW), sans dépendance.
// Palette : cube 6×6×6 (216 couleurs) + rampe de 40 gris, adaptée aux captures d'interfaces.

const GIF_PALETTE = (() => {
  const p = new Uint8Array(256 * 3);
  let i = 0;
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) {
        p[i++] = r * 51;
        p[i++] = g * 51;
        p[i++] = b * 51;
      }
  for (let k = 0; k < 40; k++) {
    const v = Math.round((k * 255) / 39);
    p[i++] = v;
    p[i++] = v;
    p[i++] = v;
  }
  return p;
})();

function gifQuantize(rgba) {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    out[j] = max - min < 16
      ? 216 + Math.round(((r + g + b) / 3) * 39 / 255)
      : Math.round(r / 51) * 36 + Math.round(g / 51) * 6 + Math.round(b / 51);
  }
  return out;
}

function gifLzw(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let table = new Map();
  const out = [];
  let acc = 0, bits = 0;
  const emit = (code) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  };

  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const code = table.get(key);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    emit(prefix);
    if (nextCode === 4096) {
      emit(clearCode);
      table = new Map();
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
    } else {
      if (nextCode >= 1 << codeSize) codeSize++;
      table.set(key, nextCode++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoiCode);
  if (bits > 0) out.push(acc & 0xff);
  return out;
}

/**
 * @param {{ rgba: Uint8ClampedArray, delayMs: number }[]} frames  toutes de taille width×height
 * @returns {Uint8Array}
 */
function encodeGif(frames, width, height) {
  const bytes = [];
  const u16 = (v) => bytes.push(v & 0xff, (v >> 8) & 0xff);
  const str = (s) => { for (const c of s) bytes.push(c.charCodeAt(0)); };

  str("GIF89a");
  u16(width);
  u16(height);
  bytes.push(0xf7, 0, 0); // table de couleurs globale de 256 entrées
  for (const v of GIF_PALETTE) bytes.push(v);
  // Boucle infinie (extension NETSCAPE2.0)
  bytes.push(0x21, 0xff, 0x0b);
  str("NETSCAPE2.0");
  bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (const { rgba, delayMs } of frames) {
    bytes.push(0x21, 0xf9, 0x04, 0x00);
    u16(Math.round(delayMs / 10));
    bytes.push(0x00, 0x00);
    bytes.push(0x2c);
    u16(0);
    u16(0);
    u16(width);
    u16(height);
    bytes.push(0x00);
    bytes.push(8); // taille minimale des codes LZW
    const data = gifLzw(gifQuantize(rgba), 8);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      bytes.push(chunk.length, ...chunk);
    }
    bytes.push(0x00);
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}
