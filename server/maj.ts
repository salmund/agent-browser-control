/**
 * Mise à jour d'ABC, la même sur tous les appareils (docs/mise-a-jour.md). Le cœur, sans effet caché :
 * scripts/update.ts y branche le vrai git, npm et le démon ; test/maj.ts des faux et un dépôt temporaire.
 *
 * Deux étapes. A, l'ancien code (celui qui tourne) : verrou, calme, instantané des réglages, avance sur la
 * branche. B, le nouveau code (relancé depuis le disque après l'avance) : dépendances, migrations, relance du
 * démon et de l'extension, vérifications, intégrations. Si B échoue, A (connu pour marcher) revient en arrière.
 * Ainsi une restructuration sait migrer depuis l'ancienne version, et un nouveau code cassé ne bloque pas.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// --- Profil de l'appareil (~/.agent-browser-control/appareil.json) ----------------------------------------

/** Un service dont on attend la fin du travail (ex. un assistant qui s'appuie sur ABC) : occupé si le champ vaut un tableau non vide, un nombre > 0 ou true. */
export interface Occupation {
  url: string;
  champ: string;
}
export interface Integration {
  source: string; // chemin dans le dépôt
  cible: string; // chemin sur l'appareil (~ accepté) ; ignorée si son dossier n'existe pas (intégration absente)
}
export interface Profil {
  nom: string;
  branche: string;
  reposSecondes: number; // sans appel à ABC depuis ce délai (un agent réfléchit entre deux appels)
  attenteMaxMinutes: number;
  occupe: Occupation[];
  demon?: { arreter: string[]; demarrer: string[] }; // sinon : POST /shutdown, puis lancement détaché
  navigateur?: string[]; // dernier recours si l'extension ne revient pas (ex. relancer Chromium)
  extensionParNavigateur?: boolean; // recharger l'extension en relançant le navigateur (Chromium en snap : /reload-extension la coupe)
  notifier?: string[]; // reçoit titre, message, priorité (1 à 5) en arguments
  integrations: Integration[];
}

const SKILL_CLAUDE: Integration = {
  source: "integrations/claude-code/skills/agent-browser-control/SKILL.md",
  cible: "~/.claude/skills/agent-browser-control/SKILL.md",
};

export const PROFIL_DEFAUT: Profil = {
  nom: hostname(),
  branche: "main",
  reposSecondes: 90,
  attenteMaxMinutes: 10,
  occupe: [],
  integrations: [SKILL_CLAUDE],
};

export const deTilde = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);
const commande = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");

/** Profil lu et contrôlé ; un champ invalide est signalé et remplacé par sa valeur par défaut. */
export function lireProfil(configDir: string): { profil: Profil; erreurs: string[] } {
  const fichier = join(configDir, "appareil.json");
  const erreurs: string[] = [];
  if (!existsSync(fichier)) return { profil: { ...PROFIL_DEFAUT }, erreurs };
  let brut: Record<string, unknown>;
  try {
    brut = JSON.parse(readFileSync(fichier, "utf8"));
  } catch (err) {
    return { profil: { ...PROFIL_DEFAUT }, erreurs: [`appareil.json illisible (${err instanceof Error ? err.message : err}) : profil par défaut.`] };
  }
  const profil: Profil = { ...PROFIL_DEFAUT };
  const prendre = <K extends keyof Profil>(cle: K, ok: (v: unknown) => boolean, attendu: string) => {
    if (brut[cle] === undefined) return;
    if (ok(brut[cle])) profil[cle] = brut[cle] as Profil[K];
    else erreurs.push(`appareil.json : ${cle} doit être ${attendu}.`);
  };
  prendre("nom", (v) => typeof v === "string" && !!v.trim(), "un texte");
  prendre("branche", (v) => typeof v === "string" && /^[\w./-]+$/.test(v), "un nom de branche");
  prendre("reposSecondes", (v) => typeof v === "number" && v >= 0, "un nombre de secondes");
  prendre("attenteMaxMinutes", (v) => typeof v === "number" && v >= 0, "un nombre de minutes");
  prendre("occupe", (v) => Array.isArray(v) && v.every((o) => o && typeof o.url === "string" && typeof o.champ === "string"), "une liste de {url, champ}");
  prendre("demon", (v) => !!v && commande((v as Profil["demon"])!.arreter) && commande((v as Profil["demon"])!.demarrer), "{arreter: [commande], demarrer: [commande]}");
  prendre("navigateur", commande, "une commande (liste de mots)");
  prendre("extensionParNavigateur", (v) => typeof v === "boolean", "true ou false");
  prendre("notifier", commande, "une commande (liste de mots)");
  prendre("integrations", (v) => Array.isArray(v) && v.every((i) => i && typeof i.source === "string" && typeof i.cible === "string"), "une liste de {source, cible}");
  return { profil, erreurs };
}

// --- Calme : rien ne s'interrompt pendant une mise à jour ------------------------------------------------

export interface Sante {
  version?: string;
  extensionConnected?: boolean;
  extensionVersion?: string | null;
  versionMismatch?: boolean;
  extensionStale?: boolean;
  inflight?: number;
  idleMs?: number;
}

const champ = (o: unknown, chemin: string) => chemin.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

/** Raison d'attendre, ou null si l'appareil est au calme. Un service injoignable ne retient pas la mise à jour. */
export async function raisonDAttendre(profil: Profil, sante: Sante | null, lireJson: (url: string) => Promise<unknown>, repos = true): Promise<string | null> {
  if (sante?.inflight) return `${sante.inflight} appel(s) à ABC en cours`;
  if (repos && sante && typeof sante.idleMs === "number" && sante.idleMs < profil.reposSecondes * 1000) {
    return `dernier appel à ABC il y a ${Math.round(sante.idleMs / 1000)} s (calme exigé : ${profil.reposSecondes} s)`;
  }
  for (const o of profil.occupe) {
    const v = champ(await lireJson(o.url).catch(() => null), o.champ);
    if ((Array.isArray(v) && v.length) || (typeof v === "number" && v > 0) || v === true) return `${o.url} : ${o.champ} occupé`;
  }
  return null;
}

// --- Instantané des réglages (avant migrations, restauré si la mise à jour échoue) ------------------------

const INSTANTANE_MAX_OCTETS = 5 * 1024 * 1024;
// La liste des migrations faites suit les réglages : restaurés, leurs migrations seront rejouées.
const MIGRATIONS_FAITES = join("maj", "migrations.json");

/** Copie les réglages (JSON du dossier, appareil.json, fonctions apprises) ; jamais les journaux ni les sorties. */
export function prendreInstantane(configDir: string, dest: string): string[] {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true, mode: 0o700 }); // des réglages portent des secrets (relais, coffre)
  const pris: string[] = [];
  const copier = (rel: string) => {
    const src = join(configDir, rel);
    if (statSync(src).size > INSTANTANE_MAX_OCTETS) return;
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    copyFileSync(src, join(dest, rel));
    pris.push(rel);
  };
  if (existsSync(configDir)) {
    for (const f of readdirSync(configDir)) if (f.endsWith(".json") && statSync(join(configDir, f)).isFile()) copier(f);
    const fonctions = join(configDir, "skills");
    if (existsSync(fonctions)) for (const f of readdirSync(fonctions)) if (f.endsWith(".js")) copier(join("skills", f));
  }
  const migrationsAvant = existsSync(join(configDir, MIGRATIONS_FAITES));
  if (migrationsAvant) copier(MIGRATIONS_FAITES);
  writeFileSync(join(dest, "liste.json"), JSON.stringify({ pris, absents: migrationsAvant ? [] : [MIGRATIONS_FAITES] }, null, 2));
  return pris;
}

export function restaurerInstantane(configDir: string, src: string): number {
  const { pris, absents }: { pris: string[]; absents: string[] } = JSON.parse(readFileSync(join(src, "liste.json"), "utf8"));
  for (const rel of pris) {
    mkdirSync(dirname(join(configDir, rel)), { recursive: true });
    copyFileSync(join(src, rel), join(configDir, rel));
  }
  for (const rel of absents) rmSync(join(configDir, rel), { force: true });
  return pris.length;
}

// --- Migrations (migrations/NNNN-nom.ts dans le dépôt) --------------------------------------------------

export interface ContexteMigration {
  configDir: string;
  depot: string;
  plateforme: NodeJS.Platform;
  log: (msg: string) => void;
}
const MIGRATION_RE = /^\d{4}-[a-z0-9-]+\.ts$/;

export function migrationsFaites(configDir: string): string[] {
  try {
    return JSON.parse(readFileSync(join(configDir, "maj", "migrations.json"), "utf8")).faites.map((m: { id: string }) => m.id);
  } catch {
    return [];
  }
}

/** Applique dans l'ordre les migrations pas encore faites ; chacune est notée dès qu'elle a réussi. */
export async function appliquerMigrations(ctx: ContexteMigration): Promise<string[]> {
  const dir = join(ctx.depot, "migrations");
  if (!existsSync(dir)) return [];
  const faites = migrationsFaites(ctx.configDir);
  const appliquees: string[] = [];
  for (const fichier of readdirSync(dir).filter((f) => MIGRATION_RE.test(f)).sort()) {
    const id = fichier.slice(0, -3);
    if (faites.includes(id)) continue;
    const m = await import(pathToFileURL(join(dir, fichier)).href);
    if (typeof m.migrer !== "function") throw new Error(`migration ${id} : pas de fonction migrer(ctx) exportée`);
    ctx.log(`migration ${id}${m.description ? ` : ${m.description}` : ""}`);
    try {
      await m.migrer(ctx);
    } catch (err) {
      throw new Error(`migration ${id} en échec : ${err instanceof Error ? err.message : err}`);
    }
    faites.push(id);
    appliquees.push(id);
    mkdirSync(join(ctx.configDir, "maj"), { recursive: true });
    writeFileSync(join(ctx.configDir, "maj", "migrations.json"), JSON.stringify({ faites: faites.map((f) => ({ id: f })) }, null, 2));
  }
  return appliquees;
}

// --- Dépendances locales (file:..) : absentes sur un autre appareil, la cause d'échec la plus sournoise ----

export function dependancesLocalesManquantes(depot: string): string[] {
  const pkg = JSON.parse(readFileSync(join(depot, "package.json"), "utf8"));
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.optionalDependencies };
  return Object.entries(deps)
    .filter(([, spec]) => spec.startsWith("file:") && !existsSync(join(resolve(depot, spec.slice(5)), "package.json")))
    .map(([nom, spec]) => `${nom} (${spec} : ${resolve(depot, spec.slice(5))} introuvable)`);
}

// --- Journal des versions : ce qui est à faire hors du dépôt ---------------------------------------------

const morceaux = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
export function compareVersions(a: string, b: string): number {
  const [x, y] = [morceaux(a), morceaux(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** Versions franchies (avant, apres] et lignes de leurs rubriques « ### Intégrations ». */
export function notesDeVersion(changelog: string, avant: string, apres: string): { versions: string[]; integrations: string[] } {
  const versions: string[] = [];
  const integrations: string[] = [];
  let dedans = false;
  let rubrique = "";
  for (const ligne of changelog.split(/\r?\n/)) {
    const v = /^## \[?(\d+\.\d+\.\d+)\]?/.exec(ligne);
    if (v) {
      dedans = compareVersions(v[1], avant) > 0 && compareVersions(v[1], apres) <= 0;
      if (dedans) versions.push(v[1]);
      rubrique = "";
      continue;
    }
    const r = /^### (.+)/.exec(ligne);
    if (r) rubrique = r[1].trim().toLowerCase();
    else if (dedans && rubrique === "intégrations" && /^\s*[-*] /.test(ligne)) integrations.push(ligne.replace(/^\s*[-*] /, "").trim());
  }
  return { versions, integrations };
}

// --- Intégrations : fichiers du dépôt recopiés là où un autre outil les lit ---------------------------------

export function synchroniserIntegrations(depot: string, integrations: Integration[]): string[] {
  const faites: string[] = [];
  for (const i of integrations) {
    const src = join(depot, i.source);
    const cible = deTilde(i.cible);
    if (!existsSync(src) || !existsSync(dirname(cible))) continue; // intégration absente de cet appareil
    const neuf = readFileSync(src);
    if (existsSync(cible) && readFileSync(cible).equals(neuf)) continue;
    if (existsSync(cible)) copyFileSync(cible, `${cible}.avant-maj`);
    writeFileSync(cible, neuf);
    faites.push(cible);
  }
  return faites;
}

// --- État et verrou -------------------------------------------------------------------------------------

export interface Etat {
  derniere?: { de: string; vers: string; le: string; ok: boolean; raison?: string };
  echec?: string; // cible ratée : pas retentée avant la suivante (sauf --force)
}
const fichierEtat = (configDir: string) => join(configDir, "maj", "etat.json");

export function lireEtat(configDir: string): Etat {
  try {
    return JSON.parse(readFileSync(fichierEtat(configDir), "utf8"));
  } catch {
    return {};
  }
}
export function ecrireEtat(configDir: string, etat: Etat): void {
  mkdirSync(join(configDir, "maj"), { recursive: true });
  writeFileSync(fichierEtat(configDir), JSON.stringify(etat, null, 2));
}

/** Verrou exclusif ; un verrou laissé par un processus mort (ou vieux de plus d'une heure) est repris. */
export function prendreVerrou(configDir: string): (() => void) | null {
  const fichier = join(configDir, "maj", "verrou");
  mkdirSync(dirname(fichier), { recursive: true });
  for (let essai = 0; essai < 2; essai++) {
    try {
      writeFileSync(fichier, JSON.stringify({ pid: process.pid, le: Date.now() }), { flag: "wx" });
      return () => rmSync(fichier, { force: true });
    } catch {
      let vivant = false;
      try {
        const { pid, le } = JSON.parse(readFileSync(fichier, "utf8"));
        process.kill(pid, 0);
        vivant = Date.now() - le < 3_600_000;
      } catch {}
      if (vivant) return null;
      rmSync(fichier, { force: true });
    }
  }
  return null;
}

// --- Étape A : l'ancien code récupère la nouvelle version -------------------------------------------------

export interface OutilsA {
  git: (args: string[]) => string; // sortie, ou exception si git échoue
  npmCi: () => void;
  sante: () => Promise<Sante | null>;
  lireJson: (url: string) => Promise<unknown>;
  attendre: (ms: number) => Promise<void>;
  etapeB: (avant: string, cible: string) => Promise<string | null>; // le nouveau code, relancé depuis le disque ; null si réussie, sinon la raison
  arreterDemon: () => Promise<void>;
  relancer: (o?: { extension: boolean }) => Promise<string | null>; // démon + extension ; null si tout est revenu
  notifier: (titre: string, message: string, priorite: number) => void;
  log: (msg: string) => void;
}
export interface OptionsA {
  depot: string;
  configDir: string;
  profil: Profil;
  force?: boolean; // même à jour, ou cible déjà ratée
  auto?: boolean; // lancé par un minuteur : un appareil occupé n'est pas une erreur, on repassera
  maintenant?: boolean; // à la main : seulement attendre la fin des appels en cours
}

const PAQUETS = ["package.json", "package-lock.json"];

export async function etapeA(o: OutilsA, opt: OptionsA): Promise<{ code: number; message: string }> {
  const fin = (code: number, message: string) => {
    o.log(message);
    return { code, message };
  };
  const liberer = prendreVerrou(opt.configDir);
  if (!liberer) return fin(opt.auto ? 0 : 1, "Une mise à jour est déjà en cours sur cet appareil.");
  try {
    const { branche } = opt.profil;
    o.git(["fetch", "-q", "origin", branche]);
    const avant = o.git(["rev-parse", "HEAD"]);
    const cible = o.git(["rev-parse", `origin/${branche}`]);
    if (avant === cible && !opt.force) return fin(0, `Déjà à jour (${avant.slice(0, 7)}).`);
    const etat = lireEtat(opt.configDir);
    if (etat.echec === cible && !opt.force) return fin(0, `${cible.slice(0, 7)} a déjà échoué ici : pas de nouvel essai avant la version suivante (--force pour insister).`);

    try {
      o.git(["merge-base", "--is-ancestor", "HEAD", cible]);
    } catch {
      return fin(1, `Le dépôt local a divergé de origin/${branche} (commits locaux) : rien fait. Les pousser ou les écarter d'abord.`);
    }
    // npm réécrit le verrou à sa façon : la version du dépôt fait foi.
    if (o.git(["status", "--porcelain", "--", "package-lock.json"])) o.git(["checkout", "-q", "--", "package-lock.json"]);
    // Des modifications locales (un développement en cours) sont gardées, sauf si la mise à jour touche les mêmes fichiers.
    const locales = o.git(["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean);
    const touches = new Set(o.git(["diff", "--name-only", avant, cible]).split("\n").filter(Boolean));
    const conflits = locales.filter((f) => touches.has(f));
    if (conflits.length) return fin(1, `Modifications locales sur des fichiers que la mise à jour change : ${conflits.join(", ")}. Les commiter ou les mettre de côté.`);

    for (let t0 = Date.now(), dit = 0; ; ) {
      const raison = await raisonDAttendre(opt.profil, await o.sante(), o.lireJson, !opt.maintenant);
      if (!raison) break;
      if (Date.now() - t0 > (opt.maintenant ? 60_000 : opt.profil.attenteMaxMinutes * 60_000)) {
        return fin(opt.auto ? 0 : 1, `Appareil occupé (${raison}) : mise à jour ${opt.auto ? "au prochain passage" : "remise à plus tard (--maintenant pour n'attendre que les appels en cours)"}.`);
      }
      if (Date.now() - dit > 60_000) {
        o.log(`J'attends : ${raison}…`);
        dit = Date.now();
      }
      await o.attendre(10_000);
    }

    const instantane = join(opt.configDir, "maj", "instantane");
    o.log(`Instantané des réglages : ${prendreInstantane(opt.configDir, instantane).length} fichier(s).`);
    o.git(["merge", "-q", "--ff-only", cible]);
    o.log(`Avancé de ${avant.slice(0, 7)} à ${cible.slice(0, 7)} ; suite par le nouveau code.`);

    const raisonB = await o.etapeB(avant, cible).catch((err) => `étape B : ${err instanceof Error ? err.message : err}`);
    if (raisonB === null) {
      ecrireEtat(opt.configDir, { derniere: { de: avant, vers: cible, le: new Date().toISOString(), ok: true } });
      const version = (await o.sante())?.version ?? "?";
      const nouveautes = o.git(["log", "-n", "10", "--format=- %s", `${avant}..${cible}`]);
      const notes = notesAvantApres(o, opt.depot, avant);
      const aFaire = notes.integrations.length ? `\n\nÀ faire hors du dépôt :\n${notes.integrations.map((l) => `- ${l}`).join("\n")}` : "";
      o.notifier(`ABC mis à jour sur ${opt.profil.nom} (v${version})`, `${nouveautes}${aFaire}`, aFaire ? 3 : 2);
      return fin(0, `ABC mis à jour : ${avant.slice(0, 7)} -> ${cible.slice(0, 7)} (v${version}).${aFaire}`);
    }

    // Échec de l'étape B : retour à la version d'avant, par l'ancien code. --keep garde les modifications locales.
    o.log(`La nouvelle version n'a pas pris (${raisonB}) : retour à la précédente.`);
    let apres: string | null;
    try {
      o.git(["reset", "-q", "--keep", avant]);
      if (o.git(["diff", "--name-only", avant, cible, "--", ...PAQUETS])) {
        await o.arreterDemon().catch(() => {}); // sous Windows, un démon lancé verrouille les modules natifs
        o.npmCi();
      }
      o.log(`Réglages restaurés : ${restaurerInstantane(opt.configDir, instantane)} fichier(s).`);
      apres = await o.relancer({ extension: !!o.git(["diff", "--name-only", avant, cible, "--", "extension"]) });
    } catch (err) {
      apres = `retour arrière incomplet : ${err instanceof Error ? err.message : err}`;
    }
    const raison = apres ? `${raisonB} ; et la version précédente ne repart pas : ${apres}` : raisonB;
    ecrireEtat(opt.configDir, { echec: cible, derniere: { de: avant, vers: cible, le: new Date().toISOString(), ok: false, raison } });
    o.notifier(
      `ABC : mise à jour ratée sur ${opt.profil.nom}, ${apres ? "À RÉPARER" : "retour à la version précédente"}`,
      `${cible.slice(0, 7)} n'a pas pris : ${raisonB}.\n${apres ? `La version précédente ne repart pas non plus : ${apres}.` : "La version précédente est revenue."}`,
      apres ? 5 : 4,
    );
    return fin(1, `Mise à jour vers ${cible.slice(0, 7)} ratée ; ${apres ? `ATTENTION, la version précédente ne repart pas non plus : ${apres}` : "version précédente revenue"}.`);
  } finally {
    liberer();
  }
}

function notesAvantApres(o: OutilsA, depot: string, avant: string): { versions: string[]; integrations: string[] } {
  try {
    const vAvant = JSON.parse(o.git(["show", `${avant}:package.json`])).version as string;
    const vApres = JSON.parse(readFileSync(join(depot, "package.json"), "utf8")).version as string;
    const journal = join(depot, "CHANGELOG.md");
    return existsSync(journal) ? notesDeVersion(readFileSync(journal, "utf8"), vAvant, vApres) : { versions: [], integrations: [] };
  } catch {
    return { versions: [], integrations: [] };
  }
}

// --- Étape B : le nouveau code met la nouvelle version en place --------------------------------------------

export interface OutilsB {
  git: (args: string[]) => string;
  npmCi: () => void;
  arreterDemon: () => Promise<void>;
  relancer: (o?: { extension: boolean }) => Promise<string | null>; // extension: false, la garder telle quelle
  sante: () => Promise<Sante | null>;
  outilsMcp: () => Promise<string[]>; // noms des outils servis par le démon relancé
  outilsAttendus: () => Promise<string[]>;
  log: (msg: string) => void;
}

export async function etapeB(o: OutilsB, opt: { depot: string; configDir: string; profil: Profil; avant: string; cible: string }): Promise<void> {
  const manquantes = dependancesLocalesManquantes(opt.depot);
  if (manquantes.length) throw new Error(`dépendance(s) locale(s) absente(s) de cet appareil : ${manquantes.join(" ; ")}. La copier à côté du dépôt, ou la publier.`);
  const paquets = !!o.git(["diff", "--name-only", opt.avant, opt.cible, "--", ...PAQUETS]) || !existsSync(join(opt.depot, "node_modules"));
  if (paquets) {
    o.log("Dépendances changées : démon arrêté, npm ci.");
    await o.arreterDemon(); // sous Windows, un démon lancé verrouille les modules natifs
    o.npmCi();
  }
  const faites = await appliquerMigrations({ configDir: opt.configDir, depot: opt.depot, plateforme: process.platform, log: o.log });
  if (faites.length) o.log(`${faites.length} migration(s) appliquée(s).`);
  // L'extension n'est rechargée que si son code a changé : sur certains navigateurs (Chromium en snap), une recharge
  // la coupe jusqu'au redémarrage du navigateur. La vérification qui suit attrape tout code resté périmé.
  const raison = await o.relancer({ extension: !!o.git(["diff", "--name-only", opt.avant, opt.cible, "--", "extension"]) });
  if (raison) throw new Error(raison);
  const version = JSON.parse(readFileSync(join(opt.depot, "package.json"), "utf8")).version;
  const sante = await o.sante();
  if (sante?.version !== version) throw new Error(`le démon répond en ${sante?.version ?? "?"}, le dépôt est en ${version}`);
  const servis = new Set(await o.outilsMcp());
  const absents = (await o.outilsAttendus()).filter((n) => !servis.has(n));
  if (absents.length) throw new Error(`outils absents du démon relancé : ${absents.join(", ")}`);
  for (const f of synchroniserIntegrations(opt.depot, opt.profil.integrations)) o.log(`Intégration à jour : ${f}`);
  o.log(`Version ${version} en place : démon, extension et ${servis.size} outils vérifiés.`);
}

