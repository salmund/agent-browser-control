/**
 * Test sans navigateur des profils de site intégrés (server/site-profiles.ts) : correspondance par hôte et
 * par suffixe de domaine, insensibilité au www et à la casse, rien pour un site inconnu.
 *
 * Lancer avec : node test/site-profiles.ts
 */
import assert from "node:assert";
import { BUILTIN_PROFILES, formatProfileBrief, profilesFor } from "../server/site-profiles.ts";

assert.strictEqual(profilesFor("sogo.univ-rouen.fr").length, 1, "hôte exact");
assert.strictEqual(profilesFor("MAIL.google.com").length, 1, "casse ignorée");
assert.strictEqual(profilesFor("docs.google.com")[0].name.startsWith("Google Docs"), true, "profil par hôte précis, pas par domaine parent");
assert.strictEqual(profilesFor("example.com").length, 0, "site inconnu : rien");
assert.strictEqual(profilesFor("notvercel.com").length, 0, "suffixe sur une frontière de domaine seulement");
assert.strictEqual(profilesFor("app.vercel.com").length, 1, "sous-domaine couvert");

const brief = formatProfileBrief("sogo.univ-rouen.fr");
assert.ok(brief && brief.startsWith("Profil ABC SOGo") && brief.includes("CKEditor 5") && brief.includes("form_input"), "contenu servi");
assert.strictEqual(formatProfileBrief("example.com"), null);

for (const p of BUILTIN_PROFILES) {
  assert.ok(p.lines.length >= 1 && p.lines.length <= 5, `${p.name} : court (1 à 5 lignes)`);
  for (const l of p.lines) assert.ok(!/[—–]/.test(l), `${p.name} : pas de tiret cadratin`);
}

console.log("site-profiles : OK");
