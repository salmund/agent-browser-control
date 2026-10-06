/**
 * Masquage des secrets dans les trames WebSocket (pur : service worker + tests Node),
 * mêmes règles que le HAR persistant (server/har.ts) : noms et structure gardés,
 * valeurs sensibles remplacées. Appliqué à la capture : le brut ne persiste jamais.
 */
const SENSITIVE = /(cookie|token|csrf|xsrf|authoriz|auth[-_]|password|passwd|secret|api[-_]?key|session|sessid|jwt|signature)/i;
const ALREADY_MASKED = /^<masqué, \d+ car\.>$/;

function maskValue(v) {
  return `<masqué, ${String(v).length} car.>`;
}

/** Dans un texte (URL, paire clé=valeur…), masque les valeurs des clés sensibles. */
function maskPairs(text) {
  return String(text).replace(/([?&;,\s]|^)([\w.\[\]-]+)=([^&#\s"';,]*)/g, (all, sep, key, value) =>
    SENSITIVE.test(key) && value ? `${sep}${key}=${encodeURIComponent(maskValue(value))}` : all);
}

/** Corps JSON ou formulaire : valeurs sensibles masquées, reste intact. Idempotent. */
function maskBody(body) {
  if (body === null || body === undefined) return body;
  if (typeof body !== "string") return body;
  const walk = (o) => {
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === "object") {
      return Object.fromEntries(
        Object.entries(o).map(([k, v]) => [
          k,
          SENSITIVE.test(k) && v !== null && typeof v !== "object"
            ? typeof v === "string" && ALREADY_MASKED.test(v)
              ? v
              : maskValue(v)
            : walk(v),
        ]),
      );
    }
    if (typeof o === "string") {
      if (/^\s*[{[]/.test(o)) {
        try {
          return JSON.stringify(walk(JSON.parse(o)));
        } catch {}
      }
      return maskPairs(o);
    }
    return o;
  };
  try {
    return JSON.stringify(walk(JSON.parse(body)));
  } catch {}
  return maskPairs(body);
}

globalThis.AbcWsMask = { maskPairs, maskBody };
