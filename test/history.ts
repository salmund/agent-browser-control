/**
 * Tests de l'historique (extension/history.js) : mise en forme des visites et
 * exclusion des sites interdits (comptés, jamais listés).
 * Lancer avec : node test/history.ts
 */
// @ts-ignore : module JS partagé avec l'extension (pas de types).
import "../extension/tab-hygiene.js";
// @ts-ignore : module JS partagé avec l'extension (pas de types).
import "../extension/history.js";
import assert from "node:assert";

const H = (globalThis as Record<string, unknown>).AbcHistory as {
  hostOf: (url: string) => string;
  blockedHost: (host: string, blocklist: string[]) => string | null;
  shapeHistory: (
    items: Record<string, unknown>[],
    blocklist: string[],
    now?: number,
  ) => { lines: string[]; masked: number };
};
assert.ok(H, "history chargé");

const NOW = 1_800_000_000_000;

// Hôtes : insensibles à la casse, URL invalide => "".
assert.strictEqual(H.hostOf("https://WWW.Exemple.fr/page"), "www.exemple.fr");
assert.strictEqual(H.hostOf("pas une url"), "");

// Blocage : suffixe exact comme assertAllowed, jamais de sous-chaîne.
assert.strictEqual(H.blockedHost("banque.fr", ["banque.fr"]), "banque.fr");
assert.strictEqual(H.blockedHost("www.banque.fr", ["banque.fr"]), "banque.fr");
assert.strictEqual(H.blockedHost("pasbanque.fr", ["banque.fr"]), null);
assert.strictEqual(H.blockedHost("banque.fr.evil.com", ["banque.fr"]), null);
assert.strictEqual(H.blockedHost("", ["banque.fr"]), null);

// Mise en forme : titre, âge, compteur ; l'interdit est masqué mais compté.
const res = H.shapeHistory(
  [
    { title: "Tour Eiffel", url: "https://fr.wikipedia.org/wiki/Tour_Eiffel", lastVisitTime: NOW - 90 * 60_000, visitCount: 3 },
    { title: "Compte", url: "https://www.banque.fr/compte", lastVisitTime: NOW - 60_000, visitCount: 1 },
    { title: "", url: "https://example.com/", visitCount: 1 },
  ],
  ["banque.fr"],
  NOW,
);
assert.strictEqual(res.masked, 1);
assert.strictEqual(res.lines.length, 2);
assert.ok(res.lines[0].includes("Tour Eiffel"), "titre gardé");
assert.ok(res.lines[0].includes("1 h 30"), "âge en français");
assert.ok(res.lines[0].includes("3 visites"), "compteur gardé");
assert.ok(!res.lines.some((l) => l.includes("banque.fr")), "interdit jamais listé");
assert.ok(res.lines[1].includes("(sans titre)"), "titre manquant géré");

console.log("history : OK (mise en forme + sites interdits masqués)");
