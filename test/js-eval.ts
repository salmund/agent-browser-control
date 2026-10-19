/**
 * Tests du rejouement du code `javascript` (extension/js-eval.js) : décisions de
 * repli + sémantique réelle (le code enveloppé s'exécute et le return devient sa valeur).
 * Lancer avec : node test/js-eval.ts
 */
// @ts-ignore : module JS partagé avec l'extension (pas de types).
import "../extension/js-eval.js";
import assert from "node:assert";

const J = (globalThis as Record<string, any>).AbcJsEval;
assert.ok(J, "js-eval chargé");

// const/let redéclarés -> isole dans un bloc (la complétion reste la dernière expression).
assert.strictEqual(
  J.jsRetry("const a = 1;", "SyntaxError: Identifier 'a' has already been declared"),
  "{\nconst a = 1;\n}",
);
// return de premier niveau (la panne vue en session : "Illegal return statement") -> fonction async.
const wrapped = J.jsRetry("return 42;", "SyntaxError: Illegal return statement");
assert.strictEqual(wrapped, "(async () => {\nreturn 42;\n})()");
// Erreur non récupérable -> pas de rejouement.
assert.strictEqual(J.jsRetry("foo()", "ReferenceError: foo is not defined"), null);
assert.strictEqual(J.jsRetry("1 +", "SyntaxError: Unexpected end of input"), null);

// Sémantique réelle : le code enveloppé s'exécute et le return devient sa valeur.
assert.strictEqual(await eval(wrapped), 42);
assert.strictEqual(
  await eval(J.jsRetry("const a = 1; return a + 1;", "SyntaxError: Illegal return statement")),
  2,
);
// Cas combiné (return + identifiant redéclaré) : d'abord la vraie panne dans un scope
// global persistant (comme la page), puis le repli qui passe.
import vm from "node:vm";
const ctx = vm.createContext({});
vm.runInContext("const probe = 1;", ctx);
assert.throws(() => vm.runInContext("const probe = 2;", ctx), /already been declared/);
const step1 = J.jsRetry("const probe = 2; return probe;", "SyntaxError: Illegal return statement");
assert.strictEqual(await vm.runInContext(step1, ctx), 2);

// Identifiant en clair : renvoyé tel quel, erreur claire s'il est absent.
assert.strictEqual(J.credentialLogin({ id: "sso-rouen", login: "etu12345" }), "etu12345");
assert.throws(() => J.credentialLogin({ id: "sso-rouen" }), /aucun identifiant enregistré/);
assert.throws(() => J.credentialLogin({ id: "sso-rouen", login: "" }), /aucun identifiant enregistré/);

console.log("js-eval : OK (rejouement return + redéclaration, identifiant en clair)");
