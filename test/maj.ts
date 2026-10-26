/**
 * Mise à jour d'ABC (server/maj.ts) : profil, calme, instantané, migrations, dépendances locales, journal des
 * versions, intégrations, verrou ; puis de vraies mises à jour dans des dépôts git temporaires (origine nue,
 * appareil cloné) avec un faux démon : réussite avec migration, échec et retour arrière, conflit refusé.
 *
 * Lancer avec : node test/maj.ts (sans démon ni navigateur)
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appliquerMigrations,
  dependancesLocalesManquantes,
  etapeA,
  etapeB,
  lireEtat,
  lireProfil,
  migrationsFaites,
  notesDeVersion,
  prendreInstantane,
  prendreVerrou,
  raisonDAttendre,
  restaurerInstantane,
  synchroniserIntegrations,
  PROFIL_DEFAUT,
  type OutilsA,
} from "../server/maj.ts";

const racine = mkdtempSync(join(tmpdir(), "abc-maj-"));
const ecrire = (p: string, contenu: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, contenu);
};

try {
  // --- Profil -----------------------------------------------------------------------------------------
  const conf = join(racine, "conf");
  mkdirSync(conf);
  assert.deepStrictEqual(lireProfil(conf).profil.branche, "main", "sans fichier : profil par défaut");
  ecrire(join(conf, "appareil.json"), JSON.stringify({ nom: "serveur", reposSecondes: 30, demon: { arreter: ["x"], demarrer: [] }, occupe: [{ url: "http://a", champ: "m.actifs" }] }));
  const lu = lireProfil(conf);
  assert.strictEqual(lu.profil.nom, "serveur");
  assert.strictEqual(lu.profil.reposSecondes, 30);
  assert.strictEqual(lu.profil.demon, undefined, "commande vide refusée");
  assert.ok(lu.erreurs.some((e) => /demon/.test(e)), "erreur dite");
  rmSync(join(conf, "appareil.json"));

  // --- Calme --------------------------------------------------------------------------------------------
  const p = { ...PROFIL_DEFAUT, occupe: [{ url: "http://assistant", champ: "moteur.actifs" }] };
  const json = (v: unknown) => async () => v;
  assert.match((await raisonDAttendre(p, { inflight: 2 }, json({}))) ?? "", /2 appel/);
  assert.match((await raisonDAttendre(p, { inflight: 0, idleMs: 5000 }, json({}))) ?? "", /il y a 5 s/);
  assert.strictEqual(await raisonDAttendre(p, { inflight: 0, idleMs: 5000 }, json({}), false), null, "--maintenant : le repos n'est pas exigé");
  assert.match((await raisonDAttendre(p, { inflight: 0, idleMs: 200_000 }, json({ moteur: { actifs: [{}] } }))) ?? "", /assistant/);
  assert.strictEqual(await raisonDAttendre(p, { inflight: 0, idleMs: 200_000 }, async () => { throw new Error("hors ligne"); }), null, "service injoignable : pas d'attente");

  // --- Instantané ---------------------------------------------------------------------------------------
  ecrire(join(conf, "site-api.json"), '{"a":1}');
  ecrire(join(conf, "skills", "x.y.js"), "return 1;");
  ecrire(join(conf, "actions.log"), "journal");
  const inst = join(conf, "maj", "instantane");
  assert.deepStrictEqual(prendreInstantane(conf, inst).sort(), ["site-api.json", join("skills", "x.y.js")].sort(), "réglages et fonctions, pas le journal");
  ecrire(join(conf, "site-api.json"), '{"a":2}');
  assert.strictEqual(restaurerInstantane(conf, inst), 2);
  assert.strictEqual(readFileSync(join(conf, "site-api.json"), "utf8"), '{"a":1}', "restauré");

  // --- Migrations ---------------------------------------------------------------------------------------
  const depotM = join(racine, "depot-m");
  const migration = (corps: string) => `import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nexport const description = "essai";\nexport function migrer(ctx) {\n${corps}\n}\n`;
  ecrire(join(depotM, "migrations", "0001-premiere.ts"), migration('writeFileSync(join(ctx.configDir, "m1.txt"), "1");'));
  ecrire(join(depotM, "migrations", "0002-seconde.ts"), migration('writeFileSync(join(ctx.configDir, "m2.txt"), "2");'));
  ecrire(join(depotM, "migrations", "README.md"), "pas une migration");
  const ctx = { configDir: conf, depot: depotM, plateforme: process.platform, log: () => {} };
  assert.deepStrictEqual(await appliquerMigrations(ctx), ["0001-premiere", "0002-seconde"], "dans l'ordre");
  assert.deepStrictEqual(await appliquerMigrations(ctx), [], "une seule fois");
  ecrire(join(depotM, "migrations", "0003-cassee.ts"), migration('throw new Error("boum");'));
  await assert.rejects(appliquerMigrations(ctx), /0003-cassee en échec : boum/);

  // --- Dépendances locales, journal des versions, intégrations, verrou -------------------------------------
  ecrire(join(depotM, "package.json"), JSON.stringify({ dependencies: { autocaptcha: "file:../absent", ws: "^8" } }));
  assert.match(dependancesLocalesManquantes(depotM).join(), /autocaptcha/);
  const journal = "# Journal\n\n## 0.10.0\n\n### Intégrations\n- Argos : ajouter x\n\n## 0.9.0\n\n### Intégrations\n- Muse : consignes\n\n## 0.8.0\n\n### Intégrations\n- ancien\n";
  assert.deepStrictEqual(notesDeVersion(journal, "0.8.0", "0.10.0"), { versions: ["0.10.0", "0.9.0"], integrations: ["Argos : ajouter x", "Muse : consignes"] });
  assert.deepStrictEqual(notesDeVersion(journal, "0.9.0", "0.9.0").versions, []);
  ecrire(join(depotM, "integrations", "S.md"), "neuf");
  ecrire(join(racine, "outil", "S.md"), "vieux");
  const integ = [{ source: "integrations/S.md", cible: join(racine, "outil", "S.md") }, { source: "integrations/S.md", cible: join(racine, "absent", "S.md") }];
  assert.deepStrictEqual(synchroniserIntegrations(depotM, integ), [join(racine, "outil", "S.md")], "copiée là où l'outil est installé, ignorée ailleurs");
  assert.strictEqual(readFileSync(join(racine, "outil", "S.md.avant-maj"), "utf8"), "vieux", "l'ancienne gardée");
  assert.deepStrictEqual(synchroniserIntegrations(depotM, integ), [], "déjà à jour");
  const liberer = prendreVerrou(conf);
  assert.ok(liberer && prendreVerrou(conf) === null, "un seul à la fois");
  liberer!();
  ecrire(join(conf, "maj", "verrou"), JSON.stringify({ pid: 999_999_999, le: Date.now() }));
  const repris = prendreVerrou(conf);
  assert.ok(repris, "verrou d'un processus mort repris");
  repris!();

  // --- Vraies mises à jour : origine nue, poste de développement, appareil ------------------------------
  const gitIn = (dir: string) => (a: string[]) => execFileSync("git", ["-c", "user.name=Essai", "-c", "user.email=essai@example.com", "-c", "core.autocrlf=false", ...a], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const origine = join(racine, "origine.git");
  const dev = join(racine, "dev");
  const appareil = join(racine, "appareil");
  const confA = join(racine, "conf-appareil");
  mkdirSync(confA);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origine]);
  execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", origine, dev], { stdio: "ignore" });
  const g = gitIn(dev);
  const version = (v: string, extra: Record<string, string> = {}) => {
    ecrire(join(dev, "package.json"), JSON.stringify({ name: "abc-essai", version: v }, null, 2));
    for (const [f, c] of Object.entries(extra)) ecrire(join(dev, f), c);
    g(["add", "-A"]);
    g(["commit", "-q", "-m", `version ${v}`]);
    g(["push", "-q", "origin", "HEAD:main"]);
  };
  version("1.0.0", { "CHANGELOG.md": "# Journal\n", "notes.txt": "a\n", "lib.txt": "v1\n" });
  execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", origine, appareil], { stdio: "ignore" });
  mkdirSync(join(appareil, "node_modules"));
  ecrire(join(confA, "site-api.json"), '{"routes":1}');
  ecrire(join(appareil, "notes.txt"), "a\nmodif locale\n"); // développement en cours, pas touché par les mises à jour

  const journalA: string[] = [];
  const notifs: string[] = [];
  let demon = "1.0.0";
  const faux = (gitA = gitIn(appareil)): OutilsA => ({
    git: gitA,
    npmCi: () => journalA.push("npm ci"),
    sante: async () => ({ version: demon, inflight: 0, idleMs: 600_000, extensionConnected: true, extensionVersion: demon, versionMismatch: false }),
    lireJson: async () => ({}),
    attendre: async () => {},
    arreterDemon: async () => void journalA.push("arrêt"),
    relancer: async (r) => {
      demon = JSON.parse(readFileSync(join(appareil, "package.json"), "utf8")).version;
      journalA.push(`relance ${demon}${r?.extension ? " + extension" : ""} (ancien code)`);
      return null;
    },
    etapeB: (avant, cible) =>
      etapeB(
        {
          git: gitA,
          npmCi: () => journalA.push("npm ci"),
          arreterDemon: async () => void journalA.push("arrêt"),
          relancer: async (r) => {
            demon = JSON.parse(readFileSync(join(appareil, "package.json"), "utf8")).version;
            journalA.push(`relance ${demon}${r?.extension ? " + extension" : ""}`);
            return null;
          },
          sante: async () => ({ version: demon }),
          outilsMcp: async () => ["search", "skill"],
          outilsAttendus: async () => ["search", "skill"],
          log: (m) => journalA.push(m),
        },
        { depot: appareil, configDir: confA, profil: PROFIL_DEFAUT, avant, cible },
      ).then(() => null, (err) => err.message),
    notifier: (t, m) => notifs.push(`${t}\n${m}`),
    log: (m) => journalA.push(m),
  });
  const optA = { depot: appareil, configDir: confA, profil: PROFIL_DEFAUT };

  // 1. Réussite : une migration, une note d'intégration ; la modification locale reste.
  version("1.1.0", {
    "migrations/0001-routes.ts": migration('writeFileSync(join(ctx.configDir, "site-api.json"), JSON.stringify({ routes: 2 }));'),
    "CHANGELOG.md": "# Journal\n\n## 1.1.0\n\n### Intégrations\n- Argos : autoriser les nouveaux outils\n",
    "lib.txt": "v1.1\n",
  });
  const r1 = await etapeA(faux(), optA);
  assert.strictEqual(r1.code, 0, `réussite : ${r1.message}\n${journalA.join("\n")}`);
  assert.strictEqual(gitIn(appareil)(["rev-parse", "HEAD"]), g(["rev-parse", "HEAD"]), "appareil avancé");
  assert.strictEqual(readFileSync(join(confA, "site-api.json"), "utf8"), '{"routes":2}', "migration appliquée");
  assert.match(readFileSync(join(appareil, "notes.txt"), "utf8"), /modif locale/, "modification locale gardée");
  assert.ok(journalA.includes("npm ci") && journalA.includes("arrêt"), "paquets changés : démon arrêté puis npm ci");
  assert.ok(journalA.includes("relance 1.1.0"), "extension inchangée : pas rechargée");
  assert.match(notifs.at(-1)!, /v1\.1\.0[\s\S]*Argos : autoriser les nouveaux outils/, "notification avec ce qui est à faire hors du dépôt");
  assert.strictEqual((await etapeA(faux(), optA)).message.startsWith("Déjà à jour"), true);

  // 2. Échec : une migration passe, la suivante modifie les réglages puis casse ; retour à 1.1.0 et aux réglages
  // d'avant, et la migration passée sera rejouée (elle n'est plus notée faite).
  version("1.2.0", {
    "migrations/0002-bonne.ts": migration('writeFileSync(join(ctx.configDir, "site-api.json"), JSON.stringify({ routes: 3 }));'),
    "migrations/0003-cassee.ts": migration('writeFileSync(join(ctx.configDir, "site-api.json"), "abîmé"); throw new Error("format inconnu");'),
    "lib.txt": "v1.2\n",
  });
  const avant12 = gitIn(appareil)(["rev-parse", "HEAD"]);
  const r2 = await etapeA(faux(), optA);
  assert.strictEqual(r2.code, 1, r2.message);
  assert.strictEqual(gitIn(appareil)(["rev-parse", "HEAD"]), avant12, "retour au commit d'avant");
  assert.strictEqual(readFileSync(join(confA, "site-api.json"), "utf8"), '{"routes":2}', "réglages restaurés");
  assert.deepStrictEqual(migrationsFaites(confA), ["0001-routes"], "migration passée de nouveau à faire");
  assert.strictEqual(readFileSync(join(appareil, "lib.txt"), "utf8"), "v1.1\n", "fichiers d'avant");
  assert.match(readFileSync(join(appareil, "notes.txt"), "utf8"), /modif locale/, "modification locale gardée au retour");
  assert.ok(journalA.some((l) => /format inconnu/.test(l)), "raison dite");
  assert.match(notifs.at(-1)!, /0003-cassee en échec : format inconnu[\s\S]*version précédente est revenue/, "raison dans la notification");
  assert.match(lireEtat(confA).derniere?.raison ?? "", /format inconnu/);
  assert.ok(journalA.includes("relance 1.1.0 (ancien code)"), "extension inchangée : pas rechargée au retour non plus");
  assert.strictEqual(demon, "1.1.0", "ancienne version relancée");
  assert.strictEqual(lireEtat(confA).echec, g(["rev-parse", "HEAD"]), "échec noté");
  assert.match(notifs.at(-1)!, /ratée/);
  assert.match((await etapeA(faux(), optA)).message, /déjà échoué/, "pas de nouvel essai de la même version");

  // 3. La version suivante répare ; une modification locale sur un fichier qu'elle change est refusée.
  rmSync(join(dev, "migrations", "0003-cassee.ts"));
  version("1.3.0", { "migrations/0003-reparee.ts": migration('writeFileSync(join(ctx.configDir, "m.txt"), "ok");'), "notes.txt": "a\nb\n", "extension/bg.js": "// v1.3\n" });
  const r3 = await etapeA(faux(), optA);
  assert.strictEqual(r3.code, 1);
  assert.match(r3.message, /notes\.txt/, "conflit nommé");
  gitIn(appareil)(["checkout", "--", "notes.txt"]);
  const r4 = await etapeA(faux(), optA);
  assert.strictEqual(r4.code, 0, `${r4.message}\n${journalA.slice(-6).join("\n")}`);
  assert.ok(existsSync(join(confA, "m.txt")) && String(demon) === "1.3.0", "version réparée en place");
  assert.deepStrictEqual(migrationsFaites(confA), ["0001-routes", "0002-bonne", "0003-reparee"], "migration passée rejouée");
  assert.strictEqual(readFileSync(join(confA, "site-api.json"), "utf8"), '{"routes":3}');
  assert.ok(journalA.includes("relance 1.3.0 + extension"), "extension changée : rechargée");

  console.log("maj : OK (profil, calme, instantané, migrations, dépendances locales, journal, intégrations, verrou, réussite, retour arrière, conflit)");
} finally {
  rmSync(racine, { recursive: true, force: true });
}
