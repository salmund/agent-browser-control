/**
 * Tests du masquage des trames WebSocket (extension/ws-mask.js) : jetons et mots
 * de passe masqués (JSON, paires, URL), contenu ordinaire intact, idempotent.
 * Lancer avec : node test/ws-mask.ts
 */
// @ts-ignore : module JS partagé avec l'extension (pas de types).
import "../extension/ws-mask.js";
import assert from "node:assert";

const M = (globalThis as Record<string, unknown>).AbcWsMask as {
  maskPairs: (text: string) => string;
  maskBody: (body: unknown) => unknown;
  isSensitiveKey: (key: string) => boolean;
};
assert.ok(M, "ws-mask chargé");

// Cas réel vu en session : trame d'auth Discord avec jeton en clair.
const discord = JSON.stringify({ op: 2, d: { token: "mfa.ABC123xyz", properties: { os: "linux" } } });
const masked = M.maskBody(discord) as string;
assert.ok(!masked.includes("mfa.ABC123xyz"), "jeton effacé");
assert.ok(masked.includes('"os":"linux"') || masked.includes('"os": "linux"'), "le reste est intact");
assert.ok(masked.includes("masqué"), "marqueur visible");

// Imbriqué + JSON dans une chaîne + paires clé=valeur.
const nested = M.maskBody(JSON.stringify({ a: { password: "SECRET", n: 3 }, q: "x=1&session=SECRET" })) as string;
assert.ok(!nested.includes("SECRET") && nested.includes("3"), "imbriqué masqué, types gardés");
// URL de socket avec jeton en query.
assert.ok(!M.maskPairs("wss://gateway/site/?v=6&token=SECRET").includes("SECRET"), "query masquée");
assert.ok(M.maskPairs("wss://gateway/site/?v=6").includes("v=6"), "params sains gardés");
// Non-JSON, sans secret : inchangé. Binaire/null : traversent.
assert.strictEqual(M.maskBody("hello"), "hello");
assert.strictEqual(M.maskBody(null), null);
// Idempotent : remasquer ne change rien.
assert.strictEqual(M.maskBody(masked), masked);

// Noms courts (mot exact, pas en sous-chaîne) : pwd, pin, otp… ; « footprint » reste intact.
const short = M.maskBody(JSON.stringify({ pwd: "S1", userPin: 1234, otp_code: "S2", footprint: "gardé", pass: "S3" })) as string;
assert.ok(!/S1|S2|S3|1234/.test(short), "pwd, userPin, otp_code, pass masqués");
assert.ok(short.includes('"footprint":"gardé"'), "footprint non masqué (otp en sous-chaîne)");
assert.ok(M.isSensitiveKey("passcode") && M.isSensitiveKey("x-auth-token") && !M.isSensitiveKey("spinner"), "isSensitiveKey");

// Préfixes Socket.IO / Engine.IO : la trame reste valide et le jeton disparaît.
const sio = M.maskBody('42["login",{"user":"bob","password":"SECRET"}]') as string;
assert.ok(sio.startsWith('42["login"') && !sio.includes("SECRET") && sio.includes('"user":"bob"'), "Socket.IO 42[…]");
const sioNs = M.maskBody('42/chat,17["auth",{"token":"SECRET"}]') as string;
assert.ok(sioNs.startsWith("42/chat,17[") && !sioNs.includes("SECRET"), "Socket.IO avec espace de noms et ack");
const sioConnect = M.maskBody('40{"token":"SECRET"}') as string;
assert.ok(sioConnect.startsWith("40{") && !sioConnect.includes("SECRET"), "Socket.IO connexion avec auth");
const sioBin = M.maskBody('451-["up",{"_placeholder":true,"num":0,"apiKey":"SECRET"}]') as string;
assert.ok(sioBin.startsWith("451-[") && !sioBin.includes("SECRET"), "Socket.IO binaire 451-");
// SockJS : tableau de chaînes JSON.
const sockjs = M.maskBody('a["{\\"token\\":\\"SECRET\\",\\"n\\":1}"]') as string;
assert.ok(sockjs.startsWith("a[") && !sockjs.includes("SECRET"), "SockJS a[…]");
// SignalR : enregistrements séparés par \x1e.
const signalr = M.maskBody('{"protocol":"json"}\x1e{"type":1,"arguments":[{"accessToken":"SECRET"}]}\x1e') as string;
assert.ok(!signalr.includes("SECRET") && signalr.endsWith("\x1e") && signalr.includes('"protocol":"json"'), "SignalR \\x1e");

// Masquer AVANT de tronquer : une trame coupée au milieu reste masquée (repli regex).
const truncated = '{"op":2,"d":{"token":"mfa.SECRETSECRET","properties":{"os":"lin';
const cut = M.maskBody(truncated) as string;
assert.ok(!cut.includes("SECRETSECRET") && cut.includes('"op":2'), "JSON tronqué masqué par regex");
const cutInValue = M.maskBody('{"op":2,"d":{"password":"SECRETSEC') as string;
assert.ok(!cutInValue.includes("SECRETSEC"), "valeur tronquée en fin de trame masquée");
const cutNum = M.maskBody('{"pin":1234,"x":') as string;
assert.ok(!cutNum.includes("1234"), "valeur numérique sensible masquée dans un JSON invalide");
const escaped = M.maskBody('{"payload":"{\\"secret\\":\\"SECRET\\"}","cut') as string;
assert.ok(!escaped.includes('\\"SECRET'), "paire échappée masquée dans un JSON invalide");

// En-têtes ligne à ligne (STOMP) et JWT sous une clé anodine.
const stomp = M.maskBody("CONNECT\nlogin:guest\npasscode:SECRET\naccept-version:1.2\n\n\0") as string;
assert.ok(!stomp.includes("SECRET") && stomp.includes("login:guest") && stomp.includes("accept-version:1.2"), "STOMP passcode masqué");
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
assert.ok(!(M.maskBody(JSON.stringify({ d: jwt })) as string).includes(jwt), "JWT masqué même sous une clé anodine");
// Idempotence sur tous les chemins (paires encodées comprises).
for (const s of [sio, sioNs, sockjs, signalr, cut, stomp]) assert.strictEqual(M.maskBody(s), s, `idempotent : ${s.slice(0, 30)}`);
const pairs = M.maskPairs("wss://h/?token=SECRET&v=1");
assert.strictEqual(M.maskPairs(pairs), pairs, "maskPairs idempotent");

console.log("ws-mask : OK (jetons masqués, préfixes de protocole, trames tronquées, contenu sain intact)");
