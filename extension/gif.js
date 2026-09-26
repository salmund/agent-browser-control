// Encodeur GIF89a sans dépendance (LZW), deux qualités :
// - standard : palette fixe (cube 6×6×6 + 40 gris), rapide, suffisante pour une IA qui lit l'image ;
// - haute : palette de 256 couleurs calculée sur l'enregistrement (median cut) + tramage
//   Floyd-Steinberg, pour des GIF à montrer (dégradés, photos, couleurs d'interface fidèles).

const FIXED_PALETTE = (() => {
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

function quantizeFixed(rgba) {
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

// --- Palette adaptative (median cut) ----------------------------------------------------

/** Palette de 256 couleurs représentative d'un échantillon de pixels pris dans toutes les images. */
function buildPalette(frames) {
  const target = 60_000;
  const total = frames.reduce((n, f) => n + f.rgba.length / 4, 0);
  const step = Math.max(1, Math.floor(total / target));
  const samples = [];
  for (const { rgba } of frames) {
    for (let i = 0; i < rgba.length; i += 4 * step) samples.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  }

  let boxes = [samples];
  while (boxes.length < 256) {
    // On coupe la boîte la plus « étalée » (amplitude × population) au niveau de sa médiane.
    let best = -1, bestScore = 0, bestAxis = 0;
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      for (let axis = 0; axis < 3; axis++) {
        let lo = 255, hi = 0;
        for (const p of box) {
          if (p[axis] < lo) lo = p[axis];
          if (p[axis] > hi) hi = p[axis];
        }
        const score = (hi - lo) * Math.sqrt(box.length);
        if (score > bestScore) {
          bestScore = score;
          best = index;
          bestAxis = axis;
        }
      }
    });
    if (best < 0 || bestScore === 0) break;
    const box = boxes[best].sort((a, b) => a[bestAxis] - b[bestAxis]);
    const mid = box.length >> 1;
    boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
  }

  const palette = new Uint8Array(256 * 3);
  boxes.forEach((box, i) => {
    let r = 0, g = 0, b = 0;
    for (const p of box) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    palette[i * 3] = Math.round(r / box.length);
    palette[i * 3 + 1] = Math.round(g / box.length);
    palette[i * 3 + 2] = Math.round(b / box.length);
  });
  return { palette, size: boxes.length };
}

/** Plus proche couleur de la palette, avec un cache par couleur réduite à 5 bits par canal. */
function makeNearest(palette, size) {
  const cache = new Int16Array(32768).fill(-1);
  return (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const cached = cache[key];
    if (cached >= 0) return cached;
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < size; i++) {
      const dr = r - palette[i * 3], dg = g - palette[i * 3 + 1], db = b - palette[i * 3 + 2];
      const dist = dr * dr * 2 + dg * dg * 4 + db * db * 3; // pondération proche de la perception
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    cache[key] = best;
    return best;
  };
}

/** Tramage Floyd-Steinberg : l'erreur de chaque pixel est répartie sur ses voisins. */
function quantizeDithered(rgba, width, height, palette, nearest) {
  const out = new Uint8Array(width * height);
  const err = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const r = Math.max(0, Math.min(255, rgba[i * 4] + err[i * 3]));
      const g = Math.max(0, Math.min(255, rgba[i * 4 + 1] + err[i * 3 + 1]));
      const b = Math.max(0, Math.min(255, rgba[i * 4 + 2] + err[i * 3 + 2]));
      const idx = nearest(r | 0, g | 0, b | 0);
      out[i] = idx;
      const er = r - palette[idx * 3], eg = g - palette[idx * 3 + 1], eb = b - palette[idx * 3 + 2];
      const spread = (dx, dy, k) => {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny >= height) return;
        const j = (ny * width + nx) * 3;
        err[j] += er * k;
        err[j + 1] += eg * k;
        err[j + 2] += eb * k;
      };
      spread(1, 0, 7 / 16);
      spread(-1, 1, 3 / 16);
      spread(0, 1, 5 / 16);
      spread(1, 1, 1 / 16);
    }
  }
  return out;
}

// --- Compression LZW ------------------------------------------------------------------

function gifLzw(indices, minCodeSize, write) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let table = new Map();
  const block = new Uint8Array(255);
  let blockLen = 0;
  let acc = 0, bits = 0;
  const pushByte = (byte) => {
    block[blockLen++] = byte;
    if (blockLen === 255) {
      write(255);
      write(block);
      blockLen = 0;
    }
  };
  const emit = (code) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      pushByte(acc & 0xff);
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
  if (bits > 0) pushByte(acc & 0xff);
  if (blockLen) {
    write(blockLen);
    write(block.subarray(0, blockLen));
  }
  write(0);
}

/** Tampon d'octets extensible (bien plus rapide qu'un tableau JavaScript pour quelques Mo). */
function makeWriter() {
  let buf = new Uint8Array(1 << 20);
  let len = 0;
  const write = (data) => {
    const n = typeof data === "number" ? 1 : data.length;
    if (len + n > buf.length) {
      const bigger = new Uint8Array(Math.max(buf.length * 2, len + n));
      bigger.set(buf.subarray(0, len));
      buf = bigger;
    }
    if (typeof data === "number") buf[len++] = data;
    else {
      buf.set(data, len);
      len += n;
    }
  };
  return { write, result: () => buf.slice(0, len) };
}

/**
 * @param {{ rgba: Uint8ClampedArray, delayMs: number }[]} frames  toutes de taille width×height
 * @param {{ quality?: "standard" | "haute" }} options
 * @returns {Uint8Array}
 */
function encodeGif(frames, width, height, { quality = "haute" } = {}) {
  const { write, result } = makeWriter();
  const u16 = (v) => write(new Uint8Array([v & 0xff, (v >> 8) & 0xff]));
  const str = (s) => write(new TextEncoder().encode(s));

  let palette = FIXED_PALETTE;
  let quantize = quantizeFixed;
  if (quality === "haute") {
    const built = buildPalette(frames);
    palette = built.palette;
    const nearest = makeNearest(built.palette, built.size);
    quantize = (rgba) => quantizeDithered(rgba, width, height, built.palette, nearest);
  }

  str("GIF89a");
  u16(width);
  u16(height);
  write(new Uint8Array([0xf7, 0, 0])); // table de couleurs globale de 256 entrées
  write(palette);
  // Boucle infinie (extension NETSCAPE2.0)
  write(new Uint8Array([0x21, 0xff, 0x0b]));
  str("NETSCAPE2.0");
  write(new Uint8Array([0x03, 0x01, 0x00, 0x00, 0x00]));

  for (const { rgba, delayMs } of frames) {
    write(new Uint8Array([0x21, 0xf9, 0x04, 0x00]));
    u16(Math.round(delayMs / 10));
    write(new Uint8Array([0x00, 0x00, 0x2c]));
    u16(0);
    u16(0);
    u16(width);
    u16(height);
    write(new Uint8Array([0x00, 8])); // pas de table locale ; taille minimale des codes LZW
    gifLzw(quantize(rgba), 8, write);
  }
  write(0x3b);
  return result();
}
