/**
 * Tests du mécanisme credentials_fill (sans navigateur) : chiffrement, périmètres,
 * politiques, et surtout non-fuite des secrets dans les sorties.
 * Lancer avec : node test/credentials.ts
 */
// @ts-ignore : module JS partagé avec l'extension (pas de types).
import "../extension/slots-crypto.js";
import assert from "node:assert";
import {
  activitySummary,
  auditLine,
  fillResult,
  hostCovered,
  isValidSlotId,
  leaksSecret,
  scopeAllows,
  scopeError,
  validateFills,
} from "../server/credentials.ts";

const C = globalThis.AbcSlotsCrypto;
assert.ok(C, "slots-crypto chargé");

// Chiffrement : aller-retour.
const salt = C.newSalt();
const key = await C.deriveKey("phrase de test", Uint8Array.from(Buffer.from(salt, "base64")));
const enc = await C.encryptWithKey(key, "s3cret-sso");
assert.strictEqual(await C.decryptWithKey(key, enc.iv, enc.data), "s3cret-sso");

// Vérifieur : bonne phrase OK, mauvaise phrase rejetée.
const verifier = await C.encryptWithKey(key, C.VERIFIER_TEXT);
assert.strictEqual(await C.decryptWithKey(key, verifier.iv, verifier.data), C.VERIFIER_TEXT);
const badKey = await C.deriveKey("mauvaise phrase", Uint8Array.from(Buffer.from(salt, "base64")));
await assert.rejects(C.decryptWithKey(badKey, verifier.iv, verifier.data), "mauvaise phrase rejetée");

// Falsification (IV modifié) rejetée.
const tampered = { ...enc, iv: enc.iv.slice(0, -2) + (enc.iv.endsWith("AA") ? "BB" : "AA") };
await assert.rejects(C.decryptWithKey(key, tampered.iv, tampered.data), "IV falsifié rejeté");

// Deux chiffrements du même secret diffèrent (IV aléatoire).
const enc2 = await C.encryptWithKey(key, "s3cret-sso");
assert.notStrictEqual(enc2.data, enc.data, "IV aléatoire");

// Export / réimport de la clé (transmission panneau -> service worker).
const exported = await C.exportRawKey(key);
assert.ok(typeof exported === "string" && exported.length > 0, "clé exportée");
const reimported = await C.importRawKey(exported);
assert.strictEqual(await C.decryptWithKey(reimported, enc.iv, enc.data), "s3cret-sso", "clé réimportée déchiffre");

// Extraction d'hôtes (saisie libre : URL complètes acceptées).
assert.deepStrictEqual(C.extractHosts("univ-rouen.fr"), { hosts: ["univ-rouen.fr"], ignored: [] });
assert.deepStrictEqual(
  C.extractHosts("https://sso.univ-rouen.fr/cas/login?id=1, UNIV-ROUEN.FR. sso.univ-rouen.fr:443"),
  { hosts: ["sso.univ-rouen.fr", "univ-rouen.fr"], ignored: [] },
  "URL complète, casse, point et port normalisés, doublons retirés",
);
assert.deepStrictEqual(
  C.extractHosts(".versitice.univ-rouen.fr/ univ-rouen.fr;pas un hôte"),
  { hosts: ["versitice.univ-rouen.fr", "univ-rouen.fr"], ignored: ["pas", "un", "hôte"] },
  "point initial et slash final tolérés, mots rejetés signalés",
);
assert.deepStrictEqual(C.extractHosts(""), { hosts: [], ignored: [] });

// Ids de slots.
assert.ok(isValidSlotId("sso-rouen") && isValidSlotId("a1"));
assert.ok(!isValidSlotId("") && !isValidSlotId("A MAJ") && !isValidSlotId("../x") && !isValidSlotId(undefined));

// Périmètres : suffixe exact, jamais de valeur.
assert.ok(hostCovered("sso.univ-rouen.fr", "univ-rouen.fr"));
assert.ok(hostCovered("univ-rouen.fr", "univ-rouen.fr"));
assert.ok(!hostCovered("evil-univ-rouen.fr", "univ-rouen.fr"), "pas de match partiel");
assert.ok(!hostCovered("", "univ-rouen.fr"));
const slot = { hosts: ["univ-rouen.fr"] };
assert.ok(scopeAllows("sso.univ-rouen.fr", slot));
assert.ok(!scopeAllows("banque.fr", slot));
assert.ok(scopeError("banque.fr", { id: "sso", hosts: ["univ-rouen.fr"] }).includes("hors périmètre"));

// Entrées.
assert.ok(validateFills([{ ref: "ref_1", slot: "sso" }]).ok);
assert.ok(!(validateFills([]) as { ok: boolean }).ok);
assert.ok(!(validateFills([{ ref: "", slot: "sso" }]) as { ok: boolean }).ok);
assert.ok(!(validateFills([{ ref: "ref_1", slot: "PAS VALIDE" }]) as { ok: boolean }).ok);

// Sorties : confirmations sans valeur, journal sans valeur.
const secret = "s3cret-sso";
const outputs = [
  fillResult("ref_1", "sso"),
  fillResult("ref_2", "sso"),
  activitySummary([{ ref: "ref_1", slot: "sso" }, { ref: "ref_2", slot: "sso" }], "ref_9"),
  JSON.stringify(auditLine("agent-test", [{ ref: "ref_1", slot: "sso" }])),
  scopeError("banque.fr", { id: "sso", hosts: ["x.fr"], policy: "ask", created: "" }),
];
assert.deepStrictEqual(leaksSecret(outputs, [secret]), [], "aucune sortie ne contient le secret");
assert.ok(outputs.join(" ").includes('"sso"'), "le slot reste identifiable");

console.log("credentials : OK (chiffrement, périmètres, politiques, non-fuite)");
