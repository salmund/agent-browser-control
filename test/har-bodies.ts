/**
 * Tests de network_har action="bodies" (server/har.ts bodiesText) : derniers corps
 * par motif, schéma des JSON, secrets masqués, limite et absence.
 * Lancer avec : node test/har-bodies.ts
 */
import assert from "node:assert";
import { bodiesText, type HarEntry } from "../server/har.ts";

const entries: HarEntry[] = [
  {
    id: "a1", t: 1, method: "GET", status: 200, mimeType: "application/json",
    url: "https://discord.com/api/v9/channels/1/messages?limit=50",
    body: '{"messages":[{"id":"1","content":"salut"}],"token":"SECRET"}',
  },
  {
    id: "a2", t: 2, method: "GET", status: 200, mimeType: "application/javascript",
    url: "https://discord.com/assets/app.js", body: undefined,
  },
  {
    id: "a3", t: 3, method: "POST", status: 200, mimeType: "text/plain",
    url: "https://discord.com/api/v9/auth", body: "ok",
  },
  { id: "a4", t: 4, method: "GET", status: 200, url: "https://discord.com/api/v9/x", body: "x".repeat(5000) },
];

// Motif : seul le corps JSON correspondant, secret masqué, schéma présent.
const one = bodiesText(entries, "messages", 5);
assert.ok(one && one.includes("a1"), "requête correspondante");
assert.ok(one.includes("schéma :"), "résumé auto du JSON");
assert.ok(!one.includes("SECRET") && one.includes("salut"), "secret masqué, contenu gardé");
assert.ok(!one.includes("a2") && !one.includes("a3"), "sans corps ou hors motif exclus");

// Sans motif : tous les corps, dans la limite.
const all = bodiesText(entries, undefined, 10);
assert.ok(all && all.includes("a1") && all.includes("a3") && all.includes("a4"), "tous les corps");
assert.ok(all.includes("[…tronqué…]"), "grand corps tronqué");

// Limite : seuls les derniers. Absence : null.
const limited = bodiesText(entries, undefined, 1);
assert.ok(limited && limited.includes("a4") && !limited.includes("a1"), "limite = derniers");
assert.strictEqual(bodiesText(entries, "introuvable"), null);

console.log("har-bodies : OK (motif, schéma, masquage, limite)");
