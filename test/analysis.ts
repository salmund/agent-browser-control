/**
 * Tests unitaires de la couche d'analyse (sans navigateur) : masquage, exports, décodeurs.
 * Lancer avec : node test/analysis.ts
 */
import assert from "node:assert";
import {
  buildCurl,
  buildPython,
  decode,
  addSiteNote,
  deleteSiteCall,
  deleteSiteNote,
  deleteSiteRoute,
  deriveSiteCall,
  formFieldNames,
  formatMemorySuggestion,
  formatSiteBrief,
  getSiteCallsForHost,
  getSiteNotes,
  getSiteNotesForHost,
  getSiteRoutes,
  getSiteRoutesForHost,
  hostHasMemory,
  inferSchema,
  isSensitiveKey,
  loadSiteApi,
  maskValue,
  queryParamNames,
  safeHeaders,
  setSiteCall,
  setSiteRoute,
  shouldSuggestMemory,
  siteKeyCovers,
  type SiteEntry,
} from "../server/analysis.ts";

// Paramètres observés : noms uniquement, jamais les valeurs.
assert.deepStrictEqual(queryParamNames("https://exemple.fr/api/notes?q=secret&id=12"), ["q", "id"]);
assert.deepStrictEqual(queryParamNames("https://exemple.fr/sans-query"), []);

// Schémas : types uniquement.
assert.strictEqual(inferSchema({ a: 1, b: "x", c: [1, 2] }), '{"a": number, "b": string, "c": [number]}');
assert.strictEqual(inferSchema(null), "null");

// Secrets : détectés et masqués.
assert.ok(isSensitiveKey("Authorization") && isSensitiveKey("x-csrf-token") && isSensitiveKey("sessionid"));
assert.ok(!isSensitiveKey("Content-Type"));
assert.ok(maskValue("abc123").includes("6 car.") && !maskValue("abc123").includes("abc123"));

// Export curl : secrets masqués, URL intacte.
const curl = buildCurl({
  method: "POST",
  url: "https://exemple.fr/api/notes",
  headers: { Authorization: "Bearer SECRET", "Content-Type": "application/json" },
  body: '{"titre":"x"}',
});
assert.ok(curl.includes("curl -X POST"), "curl méthode");
assert.ok(!curl.includes("SECRET"), "curl sans secret");
assert.ok(curl.includes("<masqué>"), "curl marque le secret");
assert.ok(curl.includes("navigateur"), "curl note cookies/CSRF navigateur");

// Export python : idem.
const py = buildPython({ method: "GET", url: "https://exemple.fr/api/notes", headers: { Cookie: "s=SECRET" } });
assert.ok(py.includes("requests.get") && !py.includes("SECRET") && py.includes("<masqué>"));
assert.deepStrictEqual(safeHeaders({ Cookie: "a=b", Accept: "text/html" }), { Cookie: "<masqué>", Accept: "text/html" });

// Décodeurs.
const b64 = Buffer.from("bonjour le site").toString("base64");
assert.strictEqual(decode(b64).format, "base64");
assert.strictEqual(decode("a%20b").format, "urlencodé");
const form = decode("q=test&token=SECRET&lang=fr");
assert.strictEqual(form.format, "formulaire");
assert.ok(form.text.includes("q") && form.text.includes("token") && !form.text.includes("SECRET"));
const jwtPayload = { sub: "42", name: "Louis", password: "SECRET" };
const jwt =
  `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.` +
  `${Buffer.from(JSON.stringify(jwtPayload)).toString("base64url")}.faux`;
const dj = decode(jwt);
assert.strictEqual(dj.format, "jwt");
assert.ok(dj.text.includes("sub") && dj.text.includes("password"), "claims nommés");
assert.ok(!dj.text.includes("SECRET"), "valeurs sensibles masquées");
assert.strictEqual(decode('{"a":1}').format, "json");
assert.strictEqual(decode("   ").format, "vide");

// site_api : JSON invalide => vide, jamais d'exception.
assert.deepStrictEqual(loadSiteApi(null), {});
assert.deepStrictEqual(loadSiteApi("pas du json"), {});

// Routes / deep links par site.
let api = loadSiteApi(JSON.stringify({ "kdp.amazon.com": { calls: [], routes: {} } }));
api = setSiteRoute(api, "kdp.amazon.com", "contact", "https://kdp.amazon.com/fr_FR/contact-us/email");
assert.strictEqual(getSiteRoutes(api["kdp.amazon.com"])["contact"], "https://kdp.amazon.com/fr_FR/contact-us/email");

// Rétrocompatibilité si un site stocke un tableau simple de SiteCall[]
let legacy: Record<string, SiteEntry> = { "kdp.amazon.com": [{ name: "notes", method: "GET", path: "/notes", updated: "2026-10-03" }] };
legacy = setSiteRoute(legacy, "kdp.amazon.com", "bookshelf", "https://kdp.amazon.com/fr_FR/bookshelf");
assert.strictEqual(getSiteRoutes(legacy["kdp.amazon.com"])["bookshelf"], "https://kdp.amazon.com/fr_FR/bookshelf");

// deriveSiteCall : méthode, chemin sans query, noms des params uniquement, jamais les valeurs.
const derived = deriveSiteCall(
  {
    method: "post",
    url: "https://api.example.com/v1/notes?lang=fr&token=SECRET",
    postData: '{"titre":"x","token":"SECRET"}',
    requestHeaders: { "Content-Type": "application/json" },
  },
  "créer note",
  "2026-10-05",
);
assert.ok(derived && derived.site === "api.example.com");
assert.strictEqual(derived.call.method, "POST");
assert.strictEqual(derived.call.path, "/v1/notes");
assert.deepStrictEqual(derived.call.params, ["lang", "token", "titre"]);
assert.strictEqual(derived.call.updated, "2026-10-05");
assert.ok(!JSON.stringify(derived).includes("SECRET"), "aucune valeur persistée");
// URL invalide => null, jamais d'exception. Nom par défaut = MÉTHODE chemin.
assert.strictEqual(deriveSiteCall({ url: "pas une url" }), null);
const unnamed = deriveSiteCall({ method: "GET", url: "https://example.com/a?b=1" });
assert.strictEqual(unnamed?.call.name, "GET /a");
assert.deepStrictEqual(unnamed?.call.params, ["b"]);
const noParams = deriveSiteCall({ method: "GET", url: "https://example.com/a" });
assert.strictEqual(noParams?.call.params, undefined);
// Champs de formulaire sans valeurs.
assert.deepStrictEqual(formFieldNames("a=1&b=&a=2"), ["a", "b"]);

// Suppressions : faux si absent, le site vide disparaît.
const api2 = {
  "example.com": {
    calls: [{ name: "x", method: "GET", path: "/", updated: "2026-10-05" }],
    routes: { home: "https://example.com/" },
  },
};
assert.strictEqual(deleteSiteCall(api2, "example.com", "inconnu").removed, false);
const delCall = deleteSiteCall(api2, "example.com", "x");
assert.strictEqual(delCall.removed, true);
assert.deepStrictEqual(delCall.api["example.com"], { calls: [], routes: { home: "https://example.com/" } });
const delRoute = deleteSiteRoute(delCall.api, "example.com", "home");
assert.strictEqual(delRoute.removed, true);
assert.deepStrictEqual(delRoute.api, {});
assert.strictEqual(deleteSiteRoute(api2, "absent.fr", "home").removed, false);

// Setters et suppressions d'appels/routes préservent les notes (pas de perte croisée).
let keep: Record<string, SiteEntry> = {};
keep = addSiteNote(keep, "mixte.fr", "garder moi.").api;
keep = setSiteRoute(keep, "mixte.fr", "accueil", "https://mixte.fr/");
assert.deepStrictEqual(getSiteNotes(keep["mixte.fr"]), ["garder moi."]);
keep = setSiteCall(keep, "mixte.fr", { name: "a", method: "GET", path: "/", updated: "2026-10-11" });
assert.deepStrictEqual(getSiteNotes(keep["mixte.fr"]), ["garder moi."]);
const keepDelCall = deleteSiteCall(keep, "mixte.fr", "a");
assert.strictEqual(keepDelCall.removed, true);
assert.deepStrictEqual(getSiteNotes(keepDelCall.api["mixte.fr"]), ["garder moi."]);
const keepDelRoute = deleteSiteRoute(keepDelCall.api, "mixte.fr", "accueil");
assert.strictEqual(keepDelRoute.removed, true);
assert.deepStrictEqual(getSiteNotes(keepDelRoute.api["mixte.fr"]), ["garder moi."]);
assert.ok("mixte.fr" in keepDelRoute.api, "site avec notes seules survit");

// Playbook : ajout (doublon ignoré, 280 car. max, 12 lignes max), lecture, suppression.
assert.deepStrictEqual(getSiteNotes(undefined), []);
assert.deepStrictEqual(getSiteNotes([{ name: "x", method: "GET", path: "/", updated: "2026-10-05" }]), []);
let pb = addSiteNote({}, "discord.com", "Cliquer même origine, jamais navigate.");
assert.strictEqual(pb.added, true);
assert.deepStrictEqual(getSiteNotes(pb.api["discord.com"]), ["Cliquer même origine, jamais navigate."]);
assert.strictEqual(addSiteNote(pb.api, "discord.com", "Cliquer même origine, jamais navigate.").added, false);
assert.strictEqual(addSiteNote(pb.api, "discord.com", "   ").added, false);
pb = addSiteNote(pb.api, "discord.com", "x".repeat(500));
assert.strictEqual(getSiteNotes(pb.api["discord.com"])[1].length, 280);
let many: Record<string, SiteEntry> = {};
for (let i = 0; i < 14; i++) many = addSiteNote(many, "s.example", `note ${i}`).api;
assert.strictEqual(getSiteNotes(many["s.example"]).length, 12);
assert.strictEqual(getSiteNotes(many["s.example"])[0], "note 2");
assert.strictEqual(deleteSiteNote(many, "s.example", "absente").removed, false);
const delNote = deleteSiteNote(many, "s.example", "note 2");
assert.strictEqual(delNote.removed, true);
assert.ok(!getSiteNotes(delNote.api["s.example"]).includes("note 2"));

// Wildcard de domaine : la clé nue couvre ses sous-domaines (même règle suffixe que blocklist et slots).
assert.strictEqual(siteKeyCovers("www.pinterest.com", "pinterest.com"), true);
assert.strictEqual(siteKeyCovers("fr.pinterest.com", "pinterest.com"), true);
assert.strictEqual(siteKeyCovers("www.pinterest.com", "www.pinterest.com"), true);
assert.strictEqual(siteKeyCovers("pinterest.com", "www.pinterest.com"), false);
assert.strictEqual(siteKeyCovers("notpinterest.com", "pinterest.com"), false);
assert.strictEqual(siteKeyCovers("WWW.Pinterest.COM", "pinterest.com"), true);
assert.strictEqual(siteKeyCovers("", "pinterest.com"), false);
let wild: Record<string, SiteEntry> = {};
wild = addSiteNote(wild, "pinterest.com", "Un seul chargement par session.").api;
wild = addSiteNote(wild, "www.pinterest.com", "Ne pas recharger sur spinner.").api;
assert.deepStrictEqual(getSiteNotesForHost(wild, "www.pinterest.com"), [
  "Ne pas recharger sur spinner.",
  "Un seul chargement par session.",
]);
assert.deepStrictEqual(getSiteNotesForHost(wild, "fr.pinterest.com"), ["Un seul chargement par session."]);
assert.deepStrictEqual(getSiteNotesForHost(wild, "example.com"), []);
wild = addSiteNote(wild, "pinterest.com", "Ne pas recharger sur spinner.").api;
assert.deepStrictEqual(getSiteNotesForHost(wild, "www.pinterest.com"), [
  "Ne pas recharger sur spinner.",
  "Un seul chargement par session.",
]);

// Brief site (point 1) : routes + appels + notes fusionnés (hôte exact puis parents, l'exact gagne).
let brief: Record<string, SiteEntry> = {};
brief = setSiteRoute(brief, "example.com", "suivi", "https://example.com/suivi");
brief = setSiteRoute(brief, "www.example.com", "suivi", "https://www.example.com/suivi");
brief = setSiteCall(brief, "example.com", { name: "notes", method: "GET", path: "/notes", updated: "2026-10-11" });
brief = addSiteNote(brief, "example.com", "Cliquer même origine.").api;
assert.deepStrictEqual(getSiteRoutesForHost(brief, "www.example.com"), [
  { name: "suivi", url: "https://www.example.com/suivi" },
]);
assert.deepStrictEqual(getSiteRoutesForHost(brief, "fr.example.com"), [
  { name: "suivi", url: "https://example.com/suivi" },
]);
assert.deepStrictEqual(getSiteRoutesForHost(brief, "autre.fr"), []);
assert.deepStrictEqual(
  getSiteCallsForHost(brief, "www.example.com").map((c) => c.name),
  ["notes"],
);
assert.deepStrictEqual(getSiteCallsForHost(brief, "autre.fr"), []);
const txt = formatSiteBrief(brief, "www.example.com");
assert(txt, "brief présent");
assert.ok(txt.startsWith("Playbook www.example.com (1 route, 1 appel, 1 note) :"), "entête du brief");
assert.ok(txt.includes("« suivi »") && txt.includes("https://www.example.com/suivi"), "route citée");
assert.ok(txt.includes("GET /notes"), "appel cité");
assert.ok(txt.includes("Cliquer même origine."), "note citée");
assert.ok(txt.indexOf("« suivi »") < txt.indexOf("Cliquer même origine."), "routes avant notes");
assert.strictEqual(formatSiteBrief(brief, "autre.fr"), null, "pas de brief sans mémoire");
// Caps : totaux dans l'entête, corps borné.
let big: Record<string, SiteEntry> = {};
for (let i = 0; i < 5; i++) big = addSiteNote(big, "gros.fr", `note ${i}`).api;
const bigTxt = formatSiteBrief(big, "gros.fr") ?? "";
assert.ok(bigTxt.startsWith("Playbook gros.fr (5 notes) :"), "entête au pluriel sans partie vide");
assert.ok(bigTxt.includes("note 0") && !bigTxt.includes("note 4"), "3 premières notes seulement");
assert.strictEqual(hostHasMemory(brief, "www.example.com"), true);
assert.strictEqual(hostHasMemory(brief, "autre.fr"), false);
// Suggestion de mémorisation (point 2) : seuil, hôte requis, mémoire existante, déjà suggéré.
assert.strictEqual(
  shouldSuggestMemory({ actions: 8, host: "x.fr", hasMemory: false, alreadySuggested: false }),
  true,
);
assert.strictEqual(
  shouldSuggestMemory({ actions: 7, host: "x.fr", hasMemory: false, alreadySuggested: false }),
  false,
);
assert.strictEqual(
  shouldSuggestMemory({ actions: 20, host: "x.fr", hasMemory: true, alreadySuggested: false }),
  false,
);
assert.strictEqual(
  shouldSuggestMemory({ actions: 20, host: "x.fr", hasMemory: false, alreadySuggested: true }),
  false,
);
assert.strictEqual(
  shouldSuggestMemory({ actions: 20, host: "", hasMemory: false, alreadySuggested: false }),
  false,
);
const sug = formatMemorySuggestion("x.fr", 12);
assert.ok(sug.includes("x.fr") && sug.includes("12 actions"), "suggestion chiffrée");
assert.ok(sug.includes("save_route") && sug.includes("note"), "suggestion actionnable");

console.log("analysis : OK (masquage, exports, décodeurs, site_api, routes, dérivation, suppressions, playbook, brief, suggestion)");
