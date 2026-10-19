/**
 * Tests unitaires de extension/devtools.js, chargé dans un contexte vm avec un faux `chrome` et
 * de faux utilitaires du service worker (cdp, assertOwned…) : ces modules ne prennent effet qu'au
 * redémarrage du service worker, ce banc les vérifie sans navigateur.
 * - interception : motifs Fetch.enable limités à l'hôte des règles, requête relâchée sur erreur ;
 * - cookies : valeurs HttpOnly et de session masquées sauf reveal: true ;
 * - émulation mobile : tactile, Client Hints cohérents, réinitialisation complète, état exposé ;
 * - WebSocket : masquage avant troncature.
 * Lancer avec : node test/devtools-unit.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const EXT = join(import.meta.dirname, "..", "extension");

type Listener = (...args: unknown[]) => unknown;
const events: Record<string, Listener[]> = { onEvent: [], onDetach: [], onRemoved: [] };
const cdpCalls: { tabId: number; method: string; params: unknown }[] = [];
const sentCommands: { method: string; args: Record<string, unknown> }[] = [];
let failFulfill = false;
let cookies: Record<string, unknown>[] = [];

const context: Record<string, unknown> = {
  console, URL, TextEncoder, TextDecoder, btoa, atob, structuredClone, setTimeout, clearTimeout,
  chrome: {
    debugger: {
      onEvent: { addListener: (fn: Listener) => events.onEvent.push(fn) },
      onDetach: { addListener: (fn: Listener) => events.onDetach.push(fn) },
      sendCommand: async (_target: unknown, method: string, args: Record<string, unknown>) => {
        sentCommands.push({ method, args });
        if (method === "Fetch.fulfillRequest" && failFulfill) throw new Error("en-têtes invalides");
        return {};
      },
    },
    tabs: { onRemoved: { addListener: (fn: Listener) => events.onRemoved.push(fn) } },
  },
  cdp: async (tabId: number, method: string, params: unknown) => {
    cdpCalls.push({ tabId, method, params });
    if (method === "Network.getCookies") return { cookies };
    return {};
  },
  assertOwned: async () => ({ url: "https://site.example/page" }),
  ensureAttached: async () => {},
  ok: (...content: unknown[]) => ({ content }),
  text: (t: string) => ({ type: "text", text: t }),
  untrusted: (t: string) => t,
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  evaluate: async (_tabId: number, expr: string) => (expr.includes("innerWidth") ? { w: 393, h: 852 } : "UA d'origine"),
};
context.globalThis = context;
vm.createContext(context);
for (const f of ["ws-mask.js", "devtools.js"]) vm.runInContext(readFileSync(join(EXT, f), "utf8"), context as vm.Context, { filename: f });
const run = <T>(code: string) => vm.runInContext(code, context as vm.Context) as T;
const textOf = (res: { content: { text: string }[] }) => res.content.map((c) => c.text).join("\n");
const callsOf = (method: string) => cdpCalls.filter((c) => c.method === method);
// Objets créés dans le contexte vm : autre prototype, comparés après copie JSON.
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// --- Interception ---
const pattern = (g: string) => run<string>(`interceptPatternFor(${JSON.stringify(g)})`);
assert.strictEqual(pattern("*api.example.com/users*"), "*api.example.com*", "hôte extrait");
assert.strictEqual(pattern("https://Example.COM/*"), "*example.com*", "schéma retiré, hôte en minuscules");
assert.strictEqual(pattern("*.cdn.example.org/*.js"), "*cdn.example.org*", "sous-domaines");
assert.strictEqual(pattern("*/api/*"), "*", "sans hôte : tout");
assert.strictEqual(pattern("*example*"), "*", "mot sans point : tout");

const networkIntercept = run<(a: unknown, b: unknown) => Promise<unknown>>("networkIntercept");
await networkIntercept("agent", { tabId: 1, action: "add", urlPattern: "*api.example.com/users*", effect: "mock", body: "{}" });
let enable = callsOf("Fetch.enable").at(-1)?.params as { patterns: { urlPattern: string; requestStage: string }[] };
assert.deepStrictEqual(plain(enable.patterns), [{ urlPattern: "*api.example.com*", requestStage: "Request" }], "Fetch.enable limité à l'hôte de la règle");
await networkIntercept("agent", { tabId: 1, action: "add", urlPattern: "*static.example.net/*.png", effect: "block" });
enable = callsOf("Fetch.enable").at(-1)?.params as typeof enable;
assert.deepStrictEqual(plain(enable.patterns.map((p) => p.urlPattern)), ["*api.example.com*", "*static.example.net*"], "un motif par hôte");
await networkIntercept("agent", { tabId: 1, action: "add", urlPattern: "*/track*", effect: "block" });
enable = callsOf("Fetch.enable").at(-1)?.params as typeof enable;
assert.deepStrictEqual(plain(enable.patterns.map((p) => p.urlPattern)), ["*"], "une règle sans hôte : tout suspendre");

// Requête suspendue : erreur pendant l'application de la règle -> relâchée quand même.
const paused = (url: string) => run<(t: number, p: unknown) => Promise<void>>("handlePausedRequest")(1, { requestId: "r1", request: { url, method: "GET", headers: {} } });
failFulfill = true;
sentCommands.length = 0;
await paused("https://api.example.com/users/42");
assert.deepStrictEqual(plain(sentCommands.map((c) => c.method)), ["Fetch.fulfillRequest", "Fetch.continueRequest"], "requête relâchée après l'échec du mock");
failFulfill = false;
sentCommands.length = 0;
await paused("https://autre.example.com/x");
assert.deepStrictEqual(plain(sentCommands.map((c) => c.method)), ["Fetch.continueRequest"], "sans règle : relâchée");

// --- Cookies ---
cookies = [
  { name: "theme", value: "sombre", domain: "site.example", path: "/", session: true },
  { name: "sid", value: "SECRET-SESSION", domain: "site.example", path: "/", session: true },
  { name: "prefs", value: "SECRET-HTTPONLY", domain: "site.example", path: "/", session: true, httpOnly: true },
  { name: "XSRF-TOKEN", value: "SECRET-CSRF", domain: "site.example", path: "/", session: true },
];
const storage = run<(a: unknown, b: unknown) => Promise<{ content: { text: string }[] }>>("storage");
const masked = textOf(await storage("agent", { tabId: 1, type: "cookies", action: "get" }));
assert.ok(masked.includes("theme=sombre"), "cookie anodin visible");
assert.ok(!/SECRET/.test(masked), "valeurs de session, HttpOnly et jeton masquées");
assert.ok(masked.includes("sid=<masqué, 14 car.>"), "longueur indiquée");
assert.ok(/3 valeur\(s\) masquée\(s\)/.test(masked) && masked.includes("reveal: true"), "note de masquage");
const revealed = textOf(await storage("agent", { tabId: 1, type: "cookies", action: "get", reveal: true }));
assert.ok(revealed.includes("SECRET-SESSION") && revealed.includes("SECRET-HTTPONLY") && !revealed.includes("masquée"), "reveal: true montre tout");

// --- Émulation ---
const emulate = run<(a: unknown, b: unknown) => Promise<unknown>>("emulate");
const touchEnabled = run<(t: number) => boolean>("globalThis.AbcDevtools.touchEnabled");
cdpCalls.length = 0;
await emulate("agent", { tabId: 7, device: "pixel-8" });
assert.deepStrictEqual(plain(callsOf("Emulation.setTouchEmulationEnabled").at(-1)?.params), { enabled: true, maxTouchPoints: 5 }, "tactile activé");
assert.deepStrictEqual(plain(callsOf("Emulation.setEmitTouchEventsForMouse").at(-1)?.params), { enabled: false }, "pas d'émission tactile pour la souris (bloquerait les clics CDP)");
const ua = callsOf("Emulation.setUserAgentOverride").at(-1)?.params as { platform: string; userAgentMetadata: { platform: string; mobile: boolean; model: string } };
assert.strictEqual(ua.platform, "Linux armv8l", "navigator.platform Android");
assert.strictEqual(ua.userAgentMetadata.platform, "Android", "Client Hints : plateforme");
assert.ok(ua.userAgentMetadata.mobile && ua.userAgentMetadata.model === "Pixel 8", "Client Hints : mobile, modèle");
assert.strictEqual(touchEnabled(7), true, "état tactile exposé au service worker");

cdpCalls.length = 0;
await emulate("agent", { tabId: 8, device: "iphone-15" });
const uaIos = callsOf("Emulation.setUserAgentOverride").at(-1)?.params as Record<string, unknown>;
assert.strictEqual(uaIos.platform, "iPhone", "navigator.platform iPhone");
assert.ok(!("userAgentMetadata" in uaIos), "Safari : pas de Client Hints");

cdpCalls.length = 0;
await emulate("agent", { tabId: 7, reset: true });
assert.deepStrictEqual(plain(callsOf("Emulation.setUserAgentOverride").at(-1)?.params), { userAgent: "" }, "user-agent rendu au navigateur");
assert.deepStrictEqual(plain(callsOf("Emulation.setTouchEmulationEnabled").at(-1)?.params), { enabled: false }, "tactile coupé");
assert.deepStrictEqual(plain(callsOf("Emulation.setEmitTouchEventsForMouse").at(-1)?.params), { enabled: false }, "émission tactile coupée");
assert.strictEqual(touchEnabled(7), false, "état tactile effacé");
await emulate("agent", { tabId: 9, width: 800, height: 600 });
assert.strictEqual(touchEnabled(9), false, "appareil personnalisé non mobile : pas de tactile");
for (const fn of events.onDetach) fn({ tabId: 8 });
assert.strictEqual(touchEnabled(8), false, "détachement du débogueur : état effacé");

// --- WebSocket : masquer avant de tronquer ---
const frame = JSON.stringify({ pad: "x".repeat(3980), token: "SECRETVALUE-SECRETVALUE-SECRETVALUE" });
for (const fn of events.onEvent) fn({ tabId: 3 }, "Network.webSocketFrameReceived", { requestId: "ws1", response: { opcode: 1, payloadData: frame } });
const data = run<string>("wsLogs.get(3).frames[0].data");
assert.ok(data.length <= 4000, "trame tronquée à 4000 car.");
assert.ok(!data.includes("SECRETV"), "jeton masqué avant la coupure (aucun fragment en clair)");

console.log("devtools : OK (interception ciblée, cookies masqués, émulation mobile, WebSocket masqué avant troncature)");
