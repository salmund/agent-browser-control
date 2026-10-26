# Journal des versions

Ce qui change à chaque version. La rubrique « Intégrations » dit ce qui est à faire hors du dépôt (assistants
branchés sur ABC, consignes des agents, scripts d'un appareil) : `npm run update` la rappelle dans la notification de chaque
appareil qui franchit la version.

## 0.11.0

- Sessions ouvertes pendant une mise à jour : le shim stdio sert la liste d'outils du démon en service (`/skills`
  renvoie aussi les définitions) et prévient l'agent (`list_changed`) quand la version du démon change. Avant, une
  session démarrée avant la 0.9.0 ne voyait jamais `search`, `read_urls` ni `skill`, et pilotait pas à pas.
- Mise à jour : un poste de développement en avance sur l'origine (commits pas encore poussés) n'est plus refusé
  comme s'il avait divergé ; rien à tirer, et le démon en retard est relancé.

### Intégrations

- Sessions d'agents ouvertes avant cette version (Claude Code, Muse Code, DeepCode) : leur shim est l'ancien,
  qui garde sa liste ; les relancer une fois pour profiter des verbes et du suivi des mises à jour suivantes.

## 0.10.2

- Mise à jour : un dépôt déjà à jour dont le démon tourne encore sur une autre version (commit fait sur place,
  relance oubliée) n'est plus « déjà à jour » : le démon est relancé sur le code du dépôt, et l'extension rechargée
  si celle qui tourne n'est pas à la version du dépôt (même quand git ne voit rien changer dans `extension/`).
- Mise à jour : le verrou npm modifié sur place n'est plus remis à la version du dépôt quand `package.json` est
  modifié lui aussi (version montée sur un poste de développement).

## 0.10.1

- Mise à jour : quand l'extension change et que l'appareil la recharge en relançant son navigateur
  (`extensionParNavigateur`), elle est d'abord rechargée, puis le navigateur relancé. Relancé seul, le navigateur
  garde en cache le code du service worker tant que la version de l'extension ne change pas : un correctif de
  l'extension sans changement de version restait sans effet (et la mise à jour revenait en arrière).

## 0.10.0

- Mise à jour formalisée, la même sur tous les appareils (`docs/mise-a-jour.md`) : `npm run update` en deux
  étapes (le nouveau code se met en place lui-même, l'ancien revient en arrière s'il échoue), profil d'appareil
  (`~/.agent-browser-control/appareil.json`), migrations (`migrations/`), instantané des réglages, attente du
  calme, vérification de tous les outils servis, intégrations recopiées, journal des versions dans la
  notification.
- Fonctions apprises partageables entre appareils : seul compte le fichier `<nom>.js` d'une fonction, une copie
  de conflit de synchronisation (Syncthing) ne remplace donc jamais l'originale.

### Intégrations

- Appareil qui se met à jour seul par son propre script : réduire ce script à l'appel de
  `node scripts/update.ts --auto`, et décrire l'appareil dans `~/.agent-browser-control/appareil.json` (démon,
  navigateur, services à attendre, notification ; exemple dans `docs/mise-a-jour.md`). Ce passage-ci, vers 0.10.0, se
  fait encore par l'ancien script : c'est toujours le code en place qui commence la mise à jour.
- Plusieurs appareils : pour que ce qu'un agent apprend serve partout, synchroniser `~/.agent-browser-control/skills/`
  (en laissant `.anciennes` propre à chacun).
- Autres appareils : rien d'obligatoire (le profil par défaut convient à un ordinateur de bureau) ; pour la mise à
  jour automatique, un minuteur qui lance `npm run update -- --auto`.

## 0.9.0

- Penser en verbes : `search` (web, images, vidéos), `read_urls`, et les fonctions de `skill` (intégrées et
  apprises), servies avant la navigation ; apprendre par défaut (rappels au bon moment, l'API JSON d'abord) ;
  garde-fou des données privées ; `browser_script` avec `args`, `open`, `page`, `wait: "dom"`.

### Intégrations

- Assistant qui filtre les outils d'ABC (liste d'outils permis) : y ajouter `search`, `read_urls` et `skill`
  (actions `run`, `list`, `show`), et le dire dans les consignes de son agent.
- Muse Code, DeepCode, Claude Code : consignes « penser en verbes » et « apprendre par défaut ».
