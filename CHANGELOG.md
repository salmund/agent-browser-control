# Journal des versions

Ce qui change à chaque version. La rubrique « Intégrations » dit ce qui est à faire hors du dépôt (assistants
branchés sur ABC, consignes des agents, scripts d'un appareil) : `npm run update` la rappelle dans la notification de chaque
appareil qui franchit la version.

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
