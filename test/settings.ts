/**
 * Réglages par défaut (sans navigateur) : browser_script est activé par défaut,
 * seul un `false` explicite de l'utilisateur le désactive.
 * Lancer avec : node test/settings.ts
 */
import assert from "node:assert";
import { disabledToolNames, normalizeSettings } from "../server/common.ts";

// Absence de réglage (nouvelle installation, fichier illisible, valeur corrompue) : activé.
assert.deepStrictEqual(normalizeSettings(undefined), { scriptsEnabled: true });
assert.deepStrictEqual(normalizeSettings(null), { scriptsEnabled: true });
assert.deepStrictEqual(normalizeSettings({}), { scriptsEnabled: true });
assert.deepStrictEqual(normalizeSettings("corrompu"), { scriptsEnabled: true });

// Choix explicite de l'utilisateur : respecté.
assert.deepStrictEqual(normalizeSettings({ scriptsEnabled: true }), { scriptsEnabled: true });
assert.deepStrictEqual(normalizeSettings({ scriptsEnabled: false }), { scriptsEnabled: false });

// Liste d'outils MCP : browser_script retiré seulement si explicitement désactivé.
assert.deepStrictEqual(disabledToolNames(undefined), []);
assert.deepStrictEqual(disabledToolNames({}), []);
assert.deepStrictEqual(disabledToolNames({ scriptsEnabled: true }), []);
assert.deepStrictEqual(disabledToolNames({ scriptsEnabled: false }), ["browser_script"]);

console.log("réglages par défaut : ok");
