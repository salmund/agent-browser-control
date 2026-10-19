/**
 * Masquage des secrets dans les trames WebSocket (pur : service worker + tests Node),
 * mêmes règles que le HAR persistant (server/har.ts), élargies : noms et structure gardés,
 * valeurs sensibles remplacées. Appliqué à la capture, AVANT toute troncature : le brut ne
 * persiste jamais, et une trame coupée au milieu d'un JSON reste masquée (repli par regex).
 * Gère les préfixes de protocole (Socket.IO / Engine.IO « 42[…] », SockJS « a[…] »,
 * séparateur SignalR \x1e) et les en-têtes ligne à ligne (STOMP « passcode:… »).
 */
// Portée privée : le service worker partage une portée globale entre ses scripts (importScripts).
(() => {
  const SENSITIVE = /(cookie|token|csrf|xsrf|authoriz|auth[-_]|password|passwd|passphrase|passcode|secret|api[-_]?key|private[-_]?key|access[-_]?key|session|sessid|jwt|signature|bearer|credential|pincode|pin[-_]code|card[-_]?number|cardnumber|iban)/i;
  // Noms courts ambigus en sous-chaîne (« otp » dans « footprint ») : comparés mot par mot.
  const SENSITIVE_WORDS = new Set([
    "pwd", "pass", "passwd", "passcode", "pin", "otp", "totp", "hotp", "mfa", "2fa", "cvv", "cvc", "csc",
    "ssn", "sid", "auth", "secret", "mdp", "sig", "nip",
  ]);
  const ALREADY_MASKED = /^<masqué, \d+ car\.>$/;
  const JWT = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;

  /** Nom de clé sensible : motif long (token, password…) ou mot court exact (pwd, pin, otp…). */
  function isSensitiveKey(key) {
    const k = String(key ?? "");
    if (SENSITIVE.test(k)) return true;
    const words = k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
    return words.some((w) => SENSITIVE_WORDS.has(w));
  }

  function maskValue(v) {
    const s = String(v);
    return ALREADY_MASKED.test(s) ? s : `<masqué, ${s.length} car.>`;
  }

  /** Jetons JWT reconnaissables où qu'ils soient (valeur d'une clé anodine, texte libre). */
  const maskJwt = (s) => String(s).replace(JWT, (t) => maskValue(t));

  /** Dans un texte (URL, paire clé=valeur…), masque les valeurs des clés sensibles. Idempotent. */
  function maskPairs(text) {
    const out = String(text).replace(/([?&;,\s]|^)([\w.\[\]-]+)=([^&#\s"';,]*)/g, (all, sep, key, value) => {
      if (!value || !isSensitiveKey(key)) return all;
      let plain = value;
      try {
        plain = decodeURIComponent(value);
      } catch {}
      if (ALREADY_MASKED.test(plain)) return all;
      return `${sep}${key}=${encodeURIComponent(maskValue(value))}`;
    });
    return maskJwt(out);
  }

  /** En-têtes « clé: valeur » ligne à ligne (STOMP, texte brut). */
  function maskLines(text) {
    return String(text).replace(/^([\w.-]{1,60})([ \t]*:[ \t]*)(.+)$/gm, (all, key, sep, value) =>
      isSensitiveKey(key) && !ALREADY_MASKED.test(value.trim()) ? `${key}${sep}${maskValue(value.trim())}` : all);
  }

  /**
   * Repli sans analyse JSON (trame tronquée, JSON invalide) : paires "clé": "valeur" (chaîne
   * éventuellement non terminée en fin de texte), "clé": nombre / booléen, et la même chose
   * échappée dans une chaîne (\"clé\":\"valeur\").
   */
  function maskJsonLike(text) {
    let s = String(text);
    s = s.replace(/"((?:[^"\\]|\\.){1,100})"(\s*:\s*)"((?:[^"\\]|\\.)*)("|$)/g, (all, key, sep, value, end) =>
      isSensitiveKey(key) && value && !ALREADY_MASKED.test(value) ? `"${key}"${sep}"${maskValue(value)}${end}` : all);
    s = s.replace(/"((?:[^"\\]|\\.){1,100})"(\s*:\s*)(-?\d[\d.eE+-]*|true|false)\b/g, (all, key, sep, value) =>
      isSensitiveKey(key) ? `"${key}"${sep}"${maskValue(value)}"` : all);
    s = s.replace(/\\"([^"\\]{1,100})\\"(\s*:\s*)\\"([^"\\]*)(\\"|$)/g, (all, key, sep, value, end) =>
      isSensitiveKey(key) && value && !ALREADY_MASKED.test(value) ? `\\"${key}\\"${sep}\\"${maskValue(value)}${end}` : all);
    return s;
  }

  function walk(o) {
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === "object") {
      return Object.fromEntries(
        Object.entries(o).map(([k, v]) => [k, isSensitiveKey(k) && v !== null && typeof v !== "object" ? maskValue(v) : walk(v)]),
      );
    }
    if (typeof o === "string") return maskText(o);
    return o;
  }

  /** Préfixe de protocole devant un JSON : Socket.IO « 42 », « 451- », « 42/ns,7 », SockJS « a ». */
  const PROTOCOL_PREFIX = /^(\d+-?(?:\/[^,\[{"]*,)?\d*|a)(?=[\[{])/;

  /** Texte quelconque : JSON (éventuellement préfixé), sinon repli regex + paires + en-têtes. */
  function maskText(text) {
    const s = String(text);
    if (s.includes("\x1e")) return s.split("\x1e").map((part) => (part ? maskText(part) : part)).join("\x1e");
    const m = PROTOCOL_PREFIX.exec(s);
    const prefix = m ? m[1] : "";
    const rest = s.slice(prefix.length);
    if (/^\s*[{[]/.test(rest)) {
      try {
        return prefix + JSON.stringify(walk(JSON.parse(rest)));
      } catch {}
    }
    return maskPairs(maskLines(maskJsonLike(s)));
  }

  /** Corps JSON, formulaire ou texte : valeurs sensibles masquées, reste intact. Idempotent. */
  function maskBody(body) {
    if (body === null || body === undefined) return body;
    if (typeof body !== "string") return body;
    return maskText(body);
  }

  globalThis.AbcWsMask = { maskPairs, maskBody, isSensitiveKey };
})();
