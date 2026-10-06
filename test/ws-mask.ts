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

console.log("ws-mask : OK (jetons masqués, contenu sain intact)");
