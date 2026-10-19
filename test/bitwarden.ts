/**
 * Tests du pont Bitwarden (sans navigateur, sans CLI réel) : parsing des sorties `bw`,
 * expurgation des candidats de recherche, construction des appels (secrets en env,
 * jamais en argv) et non-fuite. Hermétique : tourne en CI sans Bitwarden installé.
 * Lancer avec : node test/bitwarden.ts
 */
import assert from "node:assert";
import {
  BW_ENV_APPDATA,
  BW_ENV_PASSWORD,
  BW_ENV_SESSION,
  BwError,
  BwNeedsCodeError,
  createBitwardenClient,
  isBwField,
  normalizeServerUrl,
  parseBwItems,
  parseBwStatus,
  parseServerConfig,
  probeServer,
  scrubBwError,
  type BwRunner,
} from "../server/bitwarden.ts";
import { leaksSecret } from "../server/credentials.ts";

// --- parseBwStatus -----------------------------------------------------------
// Forme réelle observée (`bw status` non connecté).
assert.deepStrictEqual(parseBwStatus('{"serverUrl":null,"lastSync":null,"status":"unauthenticated"}'), {
  state: "unauthenticated",
});
assert.deepStrictEqual(
  parseBwStatus('{"serverUrl":"https://vault.bitwarden.com","lastSync":"2026-10-11T00:00:00Z","userEmail":"louis@exemple.fr","userId":"x","status":"locked"}'),
  { state: "locked", email: "louis@exemple.fr", serverUrl: "https://vault.bitwarden.com" },
);
assert.strictEqual(parseBwStatus('{"status":"unlocked","userEmail":"a@b.c"}').state, "unlocked");
assert.strictEqual(parseBwStatus("pas du json").state, "unknown");
assert.strictEqual(parseBwStatus('{"status":"bizarre"}').state, "unknown");
assert.strictEqual(parseBwStatus("[]").state, "unknown");

// --- parseBwItems : expurgation ----------------------------------------------
const password = "mdp-super-secret-1";
const notes = "note confidentielle XYZ";
const custom = "champ-perso-42";
const vaultJson = JSON.stringify([
  {
    id: "item-1",
    name: "SSO Rouen",
    login: { username: "etu12345", password, uris: [{ uri: "https://sso.univ-rouen.fr" }, { uri: null }] },
    notes,
    fields: [{ name: "code", value: custom }],
  },
  { id: "item-2", name: "Sans login" },
  { name: "sans id, ignoré", login: { password: "xxx" } },
  "pas un objet",
]);
const cands = parseBwItems(vaultJson);
assert.strictEqual(cands.length, 2);
assert.deepStrictEqual(cands[0], {
  id: "item-1",
  name: "SSO Rouen",
  username: "etu12345",
  uris: ["https://sso.univ-rouen.fr"],
});
assert.deepStrictEqual(cands[1], { id: "item-2", name: "Sans login", uris: [] });
const candText = JSON.stringify(cands);
assert.deepStrictEqual(leaksSecret([candText], [password, notes, custom]), [], "candidats expurgés");
assert.throws(() => parseBwItems('{"pas":"un tableau"}'), BwError);
assert.throws(() => parseBwItems("pas du json"), SyntaxError);

// --- isBwField / scrubBwError -------------------------------------------------
assert.ok(isBwField("username") && isBwField("password"));
assert.ok(!isBwField("totp") && !isBwField("") && !isBwField(undefined));
assert.strictEqual(scrubBwError(new Error("Vault is locked.\ndeuxième ligne")), "Vault is locked.");
assert.ok(scrubBwError(new Error("x".repeat(500))).length <= 300);

// --- Client : appels CLI ------------------------------------------------------
// Faux runner : rejoue des sorties et enregistre args + env pour audit.
const calls: { args: string[]; env: Record<string, string> }[] = [];
let scripted: Array<{ stdout: string } | { fail: string }> = [];
const runner: BwRunner = async (_exe, args, env) => {
  calls.push({ args, env: { ...env } });
  const next = scripted.shift();
  if (!next || "fail" in next) throw new Error((next as { fail: string } | undefined)?.fail ?? "échec scripté");
  return { stdout: next.stdout, stderr: "" };
};
const client = createBitwardenClient("/faux/bw", runner);

// status
scripted = [{ stdout: '{"status":"locked","userEmail":"a@b.c"}' }];
assert.deepStrictEqual(await client.status(), { state: "locked", email: "a@b.c" });
assert.deepStrictEqual(calls.at(-1)!.args, ["status", "--nointeraction"]);

// unlock : mot de passe en env, jamais en argv ; clé de session relue via status.
const master = "mot-de-passe-maitre-test";
const session = "SESSION_CLE_TEST";
scripted = [{ stdout: `${session}\n` }, { stdout: '{"status":"unlocked","userEmail":"a@b.c"}' }];
const unlocked = await client.unlock(master);
assert.strictEqual(unlocked.sessionKey, session);
assert.strictEqual(unlocked.status.state, "unlocked");
const unlockCall = calls[calls.length - 2];
assert.ok(unlockCall.args.includes("--passwordenv") && unlockCall.args.includes(BW_ENV_PASSWORD));
assert.strictEqual(unlockCall.env[BW_ENV_PASSWORD], master);
assert.ok(!unlockCall.args.join(" ").includes(master), "mot de passe jamais en argv");
const statusCall = calls.at(-1)!;
assert.strictEqual(statusCall.env[BW_ENV_SESSION], session);
assert.ok(!statusCall.args.join(" ").includes(session), "clé de session jamais en argv");
await assert.rejects(client.unlock(""), BwError);

// resolve : seul le champ demandé, valeur nettoyée du \n final.
scripted = [{ stdout: "s3cret!\n" }];
assert.strictEqual(await client.resolve(session, "item-1", "password"), "s3cret!");
assert.deepStrictEqual(calls.at(-1)!.args, ["get", "password", "item-1", "--raw", "--nointeraction"]);
assert.strictEqual(calls.at(-1)!.env[BW_ENV_SESSION], session);
await assert.rejects(client.resolve("", "item-1", "password"), BwError);
await assert.rejects(client.resolve(session, "  ", "password"), BwError);
await assert.rejects(client.resolve(session, "item-1", "totp" as "password"), BwError);

// search : candidats expurgés même quand le CLI renvoie tout.
scripted = [{ stdout: vaultJson }];
const found = await client.search(session, "rouen");
assert.strictEqual(found.length, 2);
assert.deepStrictEqual(leaksSecret([JSON.stringify(found)], [password, notes, custom]), []);
assert.deepStrictEqual(calls.at(-1)!.args, ["list", "items", "--search", "rouen", "--nointeraction"]);
await assert.rejects(client.search(session, "  "), BwError);
await assert.rejects(client.search("", "rouen"), BwError);

// lock / sync.
scripted = [{ stdout: "Your vault is now locked.\n" }];
await client.lock();
assert.deepStrictEqual(calls.at(-1)!.args, ["lock", "--nointeraction"]);
scripted = [{ stdout: "Syncing complete.\n" }];
await client.sync(session);
assert.strictEqual(calls.at(-1)!.env[BW_ENV_SESSION], session);
await assert.rejects(client.sync(""), BwError);

// Erreur CLI -> BwError nettoyée (une ligne).
scripted = [{ fail: "Invalid master password.\ndétail" }];
await assert.rejects(client.status(), /Invalid master password\./);

// --- Serveur (Vaultwarden, auto-hébergé) -----------------------------------------
assert.strictEqual(normalizeServerUrl("vault.exemple.fr"), "https://vault.exemple.fr");
assert.strictEqual(normalizeServerUrl(" https://vault.exemple.fr/#/vault "), "https://vault.exemple.fr");
assert.strictEqual(normalizeServerUrl("https://exemple.fr/vault/?x=1"), "https://exemple.fr/vault");
assert.strictEqual(normalizeServerUrl("http://localhost:8222/"), "http://localhost:8222");
assert.throws(() => normalizeServerUrl("http://exemple.fr"), BwError, "http:// refusé hors localhost");
assert.throws(() => normalizeServerUrl("https://moi:mdp@exemple.fr"), BwError, "pas d'identifiants dans l'adresse");
assert.throws(() => normalizeServerUrl(""), BwError);
assert.throws(() => normalizeServerUrl("ftp://exemple.fr"), BwError);

// /api/config réel de Vaultwarden (extrait) et du serveur officiel.
const vwConfig = '{"environment":{"vault":"https://vault.exemple.fr"},"object":"config","server":{"name":"Vaultwarden","url":"https://github.com/dani-garcia/vaultwarden"},"version":"2025.6.0"}';
assert.deepStrictEqual(parseServerConfig("https://p.exemple.fr", vwConfig), { serverUrl: "https://p.exemple.fr", kind: "vaultwarden", version: "2025.6.0" });
assert.strictEqual(parseServerConfig("https://vault.bitwarden.com", '{"object":"config","server":null,"version":"2026.9.0"}').kind, "bitwarden");
assert.throws(() => parseServerConfig("https://x.fr", "<html>"), BwError);
assert.throws(() => parseServerConfig("https://x.fr", '{"object":"profile"}'), BwError);

const fakeFetch = (async (url: string) => {
  if (String(url).startsWith("https://p.exemple.fr/")) return new Response(vwConfig, { status: 200 });
  if (String(url).startsWith("https://404.exemple.fr/")) return new Response("non", { status: 404 });
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;
assert.strictEqual((await probeServer("p.exemple.fr/#/login", fakeFetch)).kind, "vaultwarden");
await assert.rejects(probeServer("404.exemple.fr", fakeFetch), /404/);
await assert.rejects(probeServer("absent.exemple.fr", fakeFetch), /injoignable/);

// Profil dédié : chaque appel porte le dossier de données d'ABC.
const vw = createBitwardenClient("/faux/bw", runner, { appDataDir: "/abc/bitwarden" });
scripted = [{ stdout: "Saved setting `config`." }];
await vw.configServer("vault.exemple.fr/");
assert.deepStrictEqual(calls.at(-1)!.args, ["config", "server", "https://vault.exemple.fr", "--nointeraction"]);
assert.strictEqual(calls.at(-1)!.env[BW_ENV_APPDATA], "/abc/bitwarden");

// status : ligne d'information avant le JSON (profil neuf).
assert.strictEqual(parseBwStatus('Could not find data file, "x"; creating it instead.\n{"serverUrl":"https://p.exemple.fr","status":"unauthenticated"}').serverUrl, "https://p.exemple.fr");

// login : mot de passe en env, code en argv, clé de session relue.
scripted = [{ stdout: `${session}\n` }, { stdout: '{"status":"unlocked","userEmail":"a@b.c","serverUrl":"https://p.exemple.fr"}' }];
const logged = await vw.login("a@b.c", master, "123 456");
assert.strictEqual(logged.sessionKey, session);
assert.strictEqual(logged.status.serverUrl, "https://p.exemple.fr");
const loginCall = calls[calls.length - 2];
assert.deepStrictEqual(loginCall.args.slice(0, 5), ["login", "a@b.c", "--raw", "--code", "123456"]);
assert.strictEqual(loginCall.env[BW_ENV_PASSWORD], master);
assert.ok(!loginCall.args.join(" ").includes(master), "mot de passe maître jamais en argv");

// Plusieurs méthodes en deux étapes : nouvel essai avec l'application d'authentification (méthode 0).
scripted = [{ fail: "Login failed. No provider selected." }, { stdout: `${session}\n` }, { stdout: '{"status":"unlocked"}' }];
await vw.login("a@b.c", master, "654321");
assert.ok(calls[calls.length - 2].args.includes("--method"), "réessai avec --method 0");

// Code exigé, identifiants faux : erreurs lisibles, typées.
scripted = [{ fail: "Code is required." }];
await assert.rejects(vw.login("a@b.c", master), BwNeedsCodeError);
scripted = [{ fail: "Username or password is incorrect. Try again" }];
await assert.rejects(vw.login("a@b.c", master), /incorrect/);
await assert.rejects(vw.login("pas-un-mail", master), BwError);
await assert.rejects(vw.login("a@b.c", ""), BwError);

// logout : « déjà déconnecté » n'est pas une erreur.
scripted = [{ fail: "You are not logged in." }];
await vw.logout();

// matchUrl : seule l'origine de la page part vers le CLI.
scripted = [{ stdout: vaultJson }];
const matched = await vw.matchUrl(session, "https://sso.univ-rouen.fr/cas/login?service=secret-token");
assert.strictEqual(matched.length, 2);
assert.deepStrictEqual(calls.at(-1)!.args, ["list", "items", "--url", "https://sso.univ-rouen.fr", "--nointeraction"]);
assert.deepStrictEqual(leaksSecret([JSON.stringify(matched)], [password, notes, custom]), []);
assert.deepStrictEqual(await vw.matchUrl(session, "chrome://settings"), [], "pages internes : rien");
await assert.rejects(vw.matchUrl("", "https://x.fr"), BwError);

// Aucun appel n'a fait transiter un secret en argv.
const argv = calls.map((c) => c.args.join(" ")).join("\n");
assert.deepStrictEqual(leaksSecret([argv], [master, session]), [], "secrets jamais en argv");

console.log("bitwarden : OK (parsing, expurgation, appels CLI, serveur Vaultwarden, connexion, non-fuite)");
