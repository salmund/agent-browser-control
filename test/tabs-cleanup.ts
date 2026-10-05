/**
 * Tests de l'hygiène des onglets (extension/tab-hygiene.js) : durées lisibles
 * et sélection des onglets à fermer (protégés jamais fermés).
 * Lancer avec : node test/tabs-cleanup.ts
 */
// @ts-ignore : module JS partagé avec l'extension (pas de types).
import "../extension/tab-hygiene.js";
import assert from "node:assert";

const H = (globalThis as Record<string, unknown>).AbcTabHygiene as {
  formatDuration: (ms: number) => string;
  lastActivityMs: (tab: Record<string, unknown>, lastActionT?: unknown) => number | null;
  pickCleanupCandidates: (
    tabs: Record<string, unknown>[],
    opts?: Record<string, unknown>,
    now?: number,
  ) => { close: number[]; kept: { id: number; reason: string }[] };
};
assert.ok(H, "tab-hygiene chargé");

const NOW = 1_800_000_000_000;
const MIN = 60_000;

// Durées lisibles, en français.
assert.strictEqual(H.formatDuration(0), "moins d'une minute");
assert.strictEqual(H.formatDuration(30_000), "moins d'une minute");
assert.strictEqual(H.formatDuration(5 * MIN), "5 min");
assert.strictEqual(H.formatDuration(90 * MIN), "1 h 30");
assert.strictEqual(H.formatDuration(3 * 3_600_000), "3 h");
assert.strictEqual(H.formatDuration(26 * 3_600_000), "1 jour");
assert.strictEqual(H.formatDuration(3 * 86_400_000), "3 jours");

// Dernière activité : le plus récent des deux signaux, null sans signal.
assert.strictEqual(H.lastActivityMs({ lastAccessed: 100 }, 200), 200);
assert.strictEqual(H.lastActivityMs({ lastAccessed: 300 }, 200), 300);
assert.strictEqual(H.lastActivityMs({}, undefined), null);
assert.strictEqual(H.lastActivityMs({ lastAccessed: undefined }, 0), null);

// Sélection : seul l'onglet vraiment inactif est fermé.
const tabs = [
  { id: 1, lastAccessed: NOW - 3 * 3_600_000 }, // inactif depuis 3 h -> à fermer
  { id: 2, active: true, lastAccessed: NOW - 5 * 3_600_000 }, // actif -> gardé
  { id: 3, pinned: true, lastAccessed: NOW - 5 * 3_600_000 }, // épinglé -> gardé
  { id: 4, audible: true, lastAccessed: NOW - 5 * 3_600_000 }, // son -> gardé
  { id: 5, lastAccessed: NOW - 10 * MIN }, // récent -> gardé
  { id: 6, lastAccessed: NOW - 3 * 3_600_000, lastActionT: NOW - 5 * MIN }, // action agent récente -> gardé
  { id: 7 }, // sans signal -> gardé (échec fermé : on ne ferme jamais à l'aveugle)
];
const res = H.pickCleanupCandidates(tabs, { olderThanMs: 3_600_000 }, NOW);
assert.deepStrictEqual(res.close, [1]);
const keptReasons = Object.fromEntries(res.kept.map((k) => [k.id, k.reason]));
assert.strictEqual(keptReasons[2], "onglet actif");
assert.strictEqual(keptReasons[3], "épinglé");
assert.strictEqual(keptReasons[4], "son en cours");
assert.strictEqual(keptReasons[7], "activité inconnue");
assert.ok(keptReasons[5].startsWith("vu il y a"), "onglet récent motivé");
assert.ok(keptReasons[6].startsWith("vu il y a"), "action agent récente prise en compte");

// Protections désactivables explicitement (l'agent assume).
const forced = H.pickCleanupCandidates(
  [{ id: 2, active: true, lastAccessed: NOW - 5 * 3_600_000 }],
  { olderThanMs: 3_600_000, keepActive: false },
  NOW,
);
assert.deepStrictEqual(forced.close, [2]);

console.log("tabs-cleanup : OK (durées + sélection, protégés jamais fermés)");
