/**
 * Chiffrement des secrets (slots credentials_fill). JavaScript simple, sans dépendance :
 * utilisable dans le service worker MV3 (importScripts), le panneau latéral (<script>)
 * et Node 22+ (WebCrypto global) pour les tests.
 *
 * Format : PBKDF2(SHA-256, 210 000 itérations) -> AES-GCM-256. Sel au niveau du coffre,
 * IV aléatoire par secret. Tout est transporté en base64.
 */
const ITERATIONS = 210000;

const te = new TextEncoder();
const td = new TextDecoder();

function b64encode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

async function deriveKey(passphrase, saltBytes) {
  const base = await crypto.subtle.importKey("raw", te.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

async function encryptWithKey(key, plaintext) {
  const iv = randomBytes(12);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(plaintext));
  return { iv: b64encode(iv), data: b64encode(new Uint8Array(data)) };
}

async function decryptWithKey(key, ivB64, dataB64) {
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(ivB64) }, key, b64decode(dataB64));
  return td.decode(data);
}

async function exportRawKey(key) {
  return b64encode(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

async function importRawKey(b64) {
  return crypto.subtle.importKey("raw", b64decode(b64), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

/**
 * Extrait des hôtes depuis une saisie libre : accepte domaines, URL complètes,
 * hôtes avec port ou point initial. Renvoie { hosts, ignored }.
 * "https://sso.univ-rouen.fr/cas/login?id=1, univ-rouen.fr" ->
 * { hosts: ["sso.univ-rouen.fr", "univ-rouen.fr"], ignored: [] }.
 */
function extractHosts(input) {
  const hosts = [];
  const ignored = [];
  const seen = new Set();
  for (const raw of String(input ?? "").split(/[\s,;]+/)) {
    let t = raw.trim().toLowerCase();
    if (!t) continue;
    t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\.+/, "");
    t = t.split(/[/?#]/)[0].split("@").pop().split(":")[0].replace(/\.$/, "");
    if (/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+(?<!-)$/.test(t) && !seen.has(t)) {
      seen.add(t);
      hosts.push(t);
    } else if (!seen.has(t)) {
      ignored.push(raw.trim());
    }
  }
  return { hosts, ignored };
}

globalThis.AbcSlotsCrypto = {
  ITERATIONS,
  newSalt: () => b64encode(randomBytes(16)),
  deriveKey,
  encryptWithKey,
  decryptWithKey,
  /** Chaîne de vérification : prouve que la phrase secrète est bonne sans toucher aux slots. */
  VERIFIER_TEXT: "abc-credentials-v1-ok",
  exportRawKey,
  importRawKey,
  extractHosts,
};
