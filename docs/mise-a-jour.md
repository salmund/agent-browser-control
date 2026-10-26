# Mettre à jour ABC, sur tous les appareils

Une seule commande, la même partout (Windows, Linux, macOS), depuis le dossier du dépôt :

```sh
npm run update                  # attend le calme (aucun appel à ABC depuis 90 s), puis met à jour
npm run update -- --maintenant  # n'attend que la fin des appels en cours
npm run update -- --auto        # pour un minuteur ou un webhook : appareil occupé = on repassera, pas une erreur
npm run update -- --force       # même déjà à jour, ou si cette version a déjà échoué ici
```

Ce qui est propre à un appareil (démon sous systemd, navigateur à relancer, service à ne pas interrompre,
notification) se décrit dans `~/.agent-browser-control/appareil.json`. Sans ce fichier, les réglages par
défaut conviennent à un ordinateur de bureau.

## Ce que fait une mise à jour

La mise à jour se fait en deux étapes, pour qu'une restructuration majeure passe sans intervention :

**Étape A**, par le code en place (connu pour marcher sur cet appareil) :

1. Verrou : une seule mise à jour à la fois.
2. `git fetch`, puis refus net si le dépôt local a divergé (commits locaux), ou si une modification locale
   porte sur un fichier que la mise à jour change. Les autres modifications locales (un développement en
   cours) sont gardées ; le verrou npm (`package-lock.json`), que npm réécrit à sa façon, est remis à la version
   du dépôt, sauf si `package.json` est modifié lui aussi (version montée sur place). Dépôt déjà à jour mais démon en service à une autre version (commit fait sur place,
   relance oubliée) : la suite se déroule quand même, sans rien tirer, pour relancer le code du dépôt.
3. Calme : aucun appel à ABC depuis `reposSecondes`, et les services de `occupe` au repos (un assistant qui
   s'appuie sur ABC ne doit pas perdre un tour). Au bout de `attenteMaxMinutes`, on abandonne et on repassera.
4. Instantané des réglages (`~/.agent-browser-control/*.json` et les fonctions apprises).
5. Avance sur la branche (`git merge --ff-only`).

**Étape B**, par le **nouveau** code, relancé depuis le disque : il sait donc migrer depuis l'ancienne version.

1. Dépendances locales (`file:..`) présentes sur l'appareil, sinon arrêt avec la marche à suivre.
2. `npm ci` si `package.json` ou `package-lock.json` ont changé (le démon est arrêté avant : sous Windows, un
   démon lancé verrouille les modules natifs).
3. Migrations du dossier `migrations/` pas encore faites sur cet appareil.
4. Relance du démon ; recharge de l'extension si son code a changé, ou si celle qui tourne n'est pas à la
   version du dépôt ; si elle ne revient pas, relance du navigateur (profil). Avec `extensionParNavigateur`,
   l'extension est rechargée puis le navigateur relancé : relancé seul, Chromium garde en cache le code du
   service worker tant que la version de l'extension ne change pas.
5. Vérifications : version du démon égale à celle du dépôt, extension connectée, à la même version et pas
   périmée (`extensionStale`), et **tous les outils** de `server/tools.ts` servis par le démon relancé.
6. Intégrations : les fichiers du dépôt lus par d'autres outils (le skill de Claude Code) sont recopiés là où
   ces outils sont installés, l'ancienne version gardée en `.avant-maj`.

**Si l'étape B échoue**, l'étape A revient en arrière : commit précédent (`git reset --keep`, qui garde les
modifications locales), dépendances réinstallées si elles avaient changé, réglages restaurés depuis
l'instantané, ancienne version relancée et vérifiée. L'échec est noté dans `~/.agent-browser-control/maj/etat.json` :
cette version n'est pas retentée avant la suivante (sauf `--force`).

**À la fin**, la notification de l'appareil reçoit les nouveautés et, tirée de `CHANGELOG.md`, la liste de ce
qui est à faire hors du dépôt pour les versions franchies.

**Les sessions d'agents déjà ouvertes** n'ont rien à faire : le shim stdio sert la liste d'outils du démon en
service (`/skills`), pas celle du code qu'il a chargé au démarrage, et prévient l'agent (`list_changed`) quand la
version du démon change. Un outil ajouté par la mise à jour est donc utilisable sans relancer la session (depuis
0.11.0 : un shim plus ancien garde sa liste jusqu'au redémarrage de sa session).

Un poste de développement en avance sur l'origine (commits pas encore poussés) n'est pas une divergence : rien à
tirer, et le démon est relancé s'il tourne sur une autre version que le dépôt.

## Le profil de l'appareil

`~/.agent-browser-control/appareil.json`, tous les champs facultatifs :

| Champ | Par défaut | Rôle |
|---|---|---|
| `nom` | nom de la machine | dans les messages et les notifications |
| `branche` | `main` | branche suivie |
| `reposSecondes` | `90` | calme exigé depuis le dernier appel à ABC |
| `attenteMaxMinutes` | `10` | au-delà, on abandonne (et on repassera) |
| `occupe` | aucun | services à ne pas interrompre : `{url, champ}`, occupé si le champ JSON vaut un tableau non vide, un nombre > 0 ou `true` |
| `demon` | `POST /shutdown` puis lancement détaché | `{arreter: [commande], demarrer: [commande]}`, par exemple pour systemd |
| `navigateur` | aucun | dernier recours si l'extension ne revient pas (relancer le navigateur) |
| `extensionParNavigateur` | `false` | recharger l'extension en relançant `navigateur` plutôt que par `/reload-extension` (sur Chromium en snap, la recharge coupe l'extension jusqu'au redémarrage du navigateur) |
| `notifier` | aucune | commande appelée avec titre, message et priorité (1 à 5) |
| `integrations` | le skill de Claude Code | `{source, cible}` : fichier du dépôt recopié ; ignoré si le dossier cible n'existe pas |

Une commande est une liste de mots (programme, puis ses arguments), lancée sans shell. Sous Windows, un script `.cmd`
ou `.bat` passe par cmd.exe, arguments mis entre guillemets : écrire son extension (`npm.cmd`, pas `npm`).

Exemple, un serveur sans écran : démon et Chromium (en snap) sous systemd, un assistant à ne pas interrompre
(`moteur.actifs` de son état JSON), une notification par un script :

```json
{
  "nom": "serveur",
  "occupe": [{ "url": "http://127.0.0.1:8096/api/etat", "champ": "moteur.actifs" }],
  "demon": {
    "arreter": ["systemctl", "--user", "stop", "abc-daemon"],
    "demarrer": ["systemctl", "--user", "start", "abc-daemon"]
  },
  "navigateur": ["systemctl", "--user", "restart", "abc-chromium"],
  "extensionParNavigateur": true,
  "notifier": ["/home/moi/bin/abc-notifier.sh"],
  "integrations": []
}
```

## Mise à jour automatique

N'importe quel déclencheur qui lance `npm run update -- --auto` dans le dépôt convient : un minuteur (systemd,
cron, planificateur de tâches Windows), et pour réagir à un push, le webhook GitHub du dépôt relayé par un sujet
secret de ntfy.sh auquel l'appareil reste abonné par une connexion sortante (aucun port ouvert). Par exemple,
sous systemd : un service écoute le sujet et lance le service de mise à jour, un minuteur repasse chaque heure, et le
script lancé ne fait que fixer le Node à utiliser puis lancer `node scripts/update.ts --auto`.

Pour éprouver une mise à jour sans toucher à un appareil en service, un banc isolé (autre port, autre dossier de
réglages, autre navigateur) suffit : la copie à éprouver y devient un dépôt git dont l'origine est un dépôt nu local,
et l'on y pousse des versions. Le plus parlant avant une restructuration : partir de la version en service sur
l'appareil et passer à la nouvelle par l'outil de l'ancienne, exactement comme le fera l'appareil.

## Restructurer sans casser les appareils

Règles pour toute modification d'ABC, par une personne ou par un agent :

1. **L'étape B peut tout changer, l'étape A doit rester simple.** `etapeA` (server/maj.ts) tourne dans
   l'ancienne version sur chaque appareil : ne la modifier qu'avec prudence, et sans rien supposer de la
   nouvelle version au-delà de ce contrat, à garder d'une version à l'autre : `node scripts/update.ts --etape-b
   <avant> <cible>` rend le code 0 si la nouvelle version est en place, sinon écrit sa raison dans
   `~/.agent-browser-control/maj/raison-etape-b.txt`.
2. **Tout changement dans `~/.agent-browser-control`** (fichier renommé, format changé, dossier déplacé) se fait
   par une migration `migrations/NNNN-nom.ts`, idempotente (voir `migrations/README.md`). Une migration publiée ne
   se modifie plus : on en ajoute une autre.
3. **Élargir, puis resserrer.** Un outil, un paramètre, une route ou un chemin que lit autre chose qu'ABC
   (un assistant, les consignes des agents, les scripts d'un appareil) garde son ancien nom à côté du nouveau pendant au moins
   une version, puis l'ancien disparaît dans une version suivante.
4. **Pas de nouvelle dépendance `file:..`** : un autre appareil ne l'a pas. La mise à jour détecte celles qui
   manquent et le dit, mais le mieux est de publier la dépendance ou de l'intégrer au dépôt.
5. **Chaque version** : la version partout où `test/version.ts` la vérifie, et une entrée dans `CHANGELOG.md`,
   avec une rubrique `### Intégrations` pour ce qui vit hors du dépôt (liste d'outils d'un assistant, consignes des
   agents, scripts d'un appareil). Chaque appareil la reçoit dans sa notification.
6. **Éprouver la mise à jour elle-même** : `node test/maj.ts` (dépôts git temporaires : réussite, retour
   arrière, conflit) ; pour une restructuration, un essai sur un appareil de test depuis la version précédente.

## Ajouter un appareil

1. Cloner le dépôt, `npm install`, installer l'extension (`install.ps1` ou `install.sh`).
2. Si l'appareil a des particularités, écrire son `appareil.json`.
3. Pour qu'il se tienne à jour seul : un minuteur ou l'écoute du webhook, qui lance `npm run update -- --auto`.
