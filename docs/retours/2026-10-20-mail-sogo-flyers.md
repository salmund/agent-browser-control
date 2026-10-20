# Retour d'usage : envoi d'un mail avec pièce jointe (Gmail puis Sogo), 20/10/2026

Tâche : envoyer à Neva le PDF des flyers avec des consignes d'impression.
Premier essai dans Gmail (abandonné à la demande de Louis), puis envoi par Sogo.
Coût réel : environ 35 appels d'outils d'ABC, dont une trentaine pour Sogo.
Coût visé : 3 ou 4 appels (ouvrir, rédiger et joindre, envoyer, vérifier).

## Ce qui a bien marché

- `file_upload` sur le bouton « Joindre » (Gmail comme Sogo) : la boîte native est interceptée, rien à faire.
- `form_input` sur la zone Source de CKEditor : HTML propre, listes et gras conservés.
- `handle_dialog` : le confirm de Gmail est signalé clairement, avec la marche à suivre.
- Les refus prudents (ref périmée) évitent de cliquer au mauvais endroit.

## Problèmes, par temps perdu

### 1. Éditeurs riches : `form_input` casse CKEditor 5 (le plus coûteux)

Observé : `form_input` d'un texte multiligne dans le corps Sogo (CKEditor 5) passe par
« insertText natif ». Résultat : `CKEditorError: view-renderer-filler-was-lost`, un paragraphe
vide en trop à chaque `\n\n`, puis l'éditeur instable (le bouton Source ne bascule plus,
`cannot-change-view-tree`). Il a fallu fermer le brouillon et tout recommencer.

À faire :
- Détecter l'éditeur (CKEditor 5 : `element.ckeditorInstance` ; TinyMCE, Quill, ProseMirror,
  Gmail) et passer par son API : `editor.setData(html)` pour CKEditor 5.
- Ajouter `format: "text" | "html" | "markdown"` à `form_input` : en texte, `\n\n` = nouveau
  paragraphe, `\n` = saut de ligne ; en markdown, listes et gras convertis.
- Si l'éditeur lève une erreur juste après la saisie, le dire franchement (« contenu peut-être
  incohérent ») et proposer le repli (mode Source, ou `setData`).

### 2. « Effet : inchangé » alors que la page a changé

Observé dans Sogo :
- Un clic a ouvert un message (URL `#!/Mail/0/inbox` vers `#!/Mail/0/INBOX/991`, titre
  « (115) » vers « (114) », message marqué comme lu) et ABC a répondu « Effet : inchangé ».
- Le clic sur un message du dossier Envoyés l'a affiché dans le volet de lecture : « inchangé ».

Conséquence : effet de bord non voulu (un message de Louis marqué comme lu, remis en non lu à la
main) et captures d'écran supplémentaires pour savoir ce qui s'était passé.

À faire : comparer aussi l'URL avec le fragment (`#...`), le titre (les compteurs de non lus y
sont souvent), et le contenu des volets principaux. Signaler en « Aussi : » les changements d'état
typiques des webmails (compteur de non lus qui bouge = un message a été lu).

### 3. `navigate` annonce un succès qui n'a pas eu lieu (SPA)

Observé : `navigate` vers `.../Mail/view#!/Mail/0/Drafts` répond « Navigation terminée » mais Sogo
(AngularJS) reste sur Envoyés. Seul le clic sur le dossier a marché.

À faire : après une navigation SPA, vérifier que la vue a changé (titre, contenu principal) et
sinon le dire, voire retomber seul sur le clic du lien correspondant.

### 4. Champs destinataires à puces et suggestions

Observé : saisie de l'adresse puis `Return` : aucune puce créée. Il a fallu une capture pour voir
la suggestion de l'annuaire, puis la cliquer (deux fois : Gmail et Sogo).

À faire : dans `form_input`, reconnaître les champs « chips » et les combobox à suggestions :
saisir, attendre la liste, choisir l'option qui correspond, vérifier que la puce existe et
renvoyer son libellé (« Neva Aygun <neva.aygun@univ-rouen.fr> »).

### 5. Mémoire du site non proposée à l'arrivée

Sogo est la boîte de Louis, utilisée souvent. Une macro « écrire un mail » (destinataires, objet,
corps HTML, pièces jointes, envoi, vérification dans Envoyés) aurait fait tout le travail en un
appel. Je n'ai pas pensé à appeler `site_api list` (ma faute), mais ABC pourrait l'éviter :
- `tabs_create` / `navigate` affichent d'office une ligne « Mémoire du site : 3 macros (…) ».
- Fournir des macros prêtes pour les webmails courants (Sogo, Gmail, Outlook), ou un outil
  `mail_compose` qui s'appuie dessus.

### 6. Pièce jointe : pas de signal de fin d'envoi, `networkIdle` inutilisable sur Gmail

Observé : après `file_upload`, `wait_for` (texte + `networkIdle`) a expiré au bout de 30 s :
Gmail n'est jamais calme (connexions longues). Le texte attendu était pourtant là.

À faire :
- `file_upload` attend lui-même la fin du chargement (barre de progression disparue, puce du
  fichier présente) et le dit (« planche-a4-sans-prix.pdf joint, 1,4 Mo »).
- `networkIdle` ignore les connexions longues connues (long polling, flux) ; le diagnostic
  pourrait dire « ce site n'est jamais calme : préférer text ou selector ».
- Remonter les messages de la page juste après l'action (Gmail a affiché « Échec du chargement de
  l'image que vous avez sélectionnée », sans rapport mais à signaler).

### 7. Boutons flottants « speed dial » et libellés en double

Observé : dans Sogo, le bouton rond « Écrire un nouveau message » n'ouvre qu'un petit menu, qui
contient un second bouton portant le même libellé. Premier clic : « inchangé » ; il a fallu
`find`, puis cliquer le second.

À faire : quand un clic révèle de nouveaux boutons, les lister dans l'effet ; dans `find`,
distinguer les homonymes (position, « dans le menu ouvert par ref_X »).

### 8. Ref périmée : refus au lieu d'une relocalisation sûre

Observé : le bouton « send » a changé de ref après l'ajout de la pièce jointe ; clic refusé, il a
fallu refaire `find`.

À faire : si un seul élément a le même rôle et le même nom dans le même conteneur (la fenêtre de
rédaction), le reprendre seul et le signaler, au lieu de refuser.

### 9. Réponses trop longues

- À l'ouverture d'une fenêtre modale, le `diff` liste 90 éléments du fond « retirés » (masqués
  par la modale). Une ligne suffirait : « 90 éléments masqués par une fenêtre modale ».
- `tabs_create` sur la boîte Gmail renvoie 302 éléments alors qu'il fallait seulement le compte
  connecté et le bouton « Nouveau message » : prévoir une lecture résumée par défaut sur les
  grosses pages (compte, actions principales, listes résumées).
- La bannière « Données JSON détectées » revient à chaque appel : une fois par onglet suffit.

### 10. Outils différés

`handle_dialog` n'était pas chargé : un aller-retour de plus au moment où la page était bloquée.
Le skill pourrait conseiller de charger d'emblée `handle_dialog` avec le jeu de base dès qu'on
touche à un webmail ou à un formulaire.

## Erreurs de mon côté (pas d'ABC)

- Clic par coordonnées tirées d'une capture réduite au lieu d'une ref : c'est ce qui a ouvert le
  message par erreur.
- Pas de `site_api list` à l'arrivée sur Sogo.
- Gmail choisi d'abord, alors que le contexte de Louis désigne Sogo comme sa boîte universitaire.

## Priorités proposées

1. Éditeurs riches par leur API, avec `format` (point 1).
2. Détection d'effet fiable : fragment d'URL, titre, volets (points 2 et 3).
3. Champs à puces et suggestions dans `form_input` (point 4).
4. Mémoire du site affichée d'office, macros de webmail (point 5).
5. `file_upload` qui attend la fin du chargement (point 6).
6. Réponses plus courtes (point 9).

## Suivi : ce qui a été fait (20/10/2026)

Test : `test/e2e-webmail-compose.ts` (fausse page de webmail) et `test/rich-editor.ts`.

| Point | Fait | Où |
| --- | --- | --- |
| 1. Éditeurs riches | `form_input` pose le contenu par l'API de CKEditor 5 (`setData`) et de Quill ; nouveau paramètre `format` (`text`, `html`, `markdown`) ; repli `insertHTML` pour les autres éditeurs | `bg/rich-editor.js`, `bg/reading.js`, `page.js` |
| 2. « Effet : inchangé » à tort | si le premier constat est « inchangé » et sans effet de bord, resondage du digest (700 ms au plus) ; la réponse dit « constaté après N ms » | `bg/computer.js` |
| 3. `navigate` sur un #fragment | si seul le fragment change et que la page ne bouge pas, clic sur le lien correspondant ; sinon avertissement explicite au lieu de « Navigation terminée » | `bg/navigation.js` |
| 4. Champs à puces | `form_input` choisit l'unique suggestion qui contient l'adresse saisie, ou envoie Entrée s'il n'y a pas de liste ; le retour dit « puce créée » | `page.js` |
| 6. `file_upload` | attend la fin des requêtes d'envoi (8 s au plus), dit si le nom du fichier est visible et signale un échec (code HTTP) | `bg/reading.js` |
| 8. Refs périmées | le refus (ou « introuvable ») liste les éléments actuels de même nom avec leur ref neuve | `page.js` |
| 9. Réponses longues | `diff` plafonné à 25 lignes par catégorie avec décompte du reste ; « Données JSON détectées » une seule fois par jeu de routes et par onglet | `page.js`, `bg/page-bridge.js` |

Pas fait : point 5 (mémoire de site affichée d'office, macros de webmail), point 7 (boutons « speed
dial », libellés en double), point 9 (lecture résumée par défaut des grosses pages), point 10
(chargement des outils différés, côté client MCP).

## Suivi 2 : les huit pistes (20/10/2026)

| Piste | État | Où |
| --- | --- | --- |
| 1. Cible par libellé | Fait. `target` (computer, form_input, file_upload) et `submitTarget` ; ambiguïté refusée avec les candidats et leur ref | `bg/target.js`, `bg/dispatch.js` |
| 1b. Enchaîner | Fait. `steps` accepte `fill`, `navigate`, `upload`, avec `target` par étape (résolu au moment de l'étape) | `bg/computer.js` |
| 2. Profils de site | Fait. Profils livrés (SOGo, Gmail, Docs, Vercel) servis une fois par agent et par hôte toutes les 30 min, hors `<site_memory>` (de confiance). La boucle « parcours réussi vers macro » existait déjà (`site_api suggest_macros`) | `server/site-profiles.ts`, `server/daemon.ts` |
| 3. Attente commune | Fait. `settle()` (réseau, DOM, condition) remplace les boucles propres à la détection d'effet, `file_upload` et `navigate` | `bg/settle.js` |
| 4. Réponses adaptées | Fait en partie. `read_page maxItems` ; instantanés joints bornés à 120. Pas de lecture résumée automatique des grosses pages sans paramètre | `bg/reading.js`, `bg/navigation.js` |
| 5. Plus d'éditeurs | Fait pour Tiptap et Lexical, testés sur des simulations, pas sur les vrais éditeurs. ProseMirror brut, Slate et Google Docs non couverts | `bg/rich-editor.js` |
| 6. Routage multi-navigateurs | Non fait : demande un orchestrateur au-dessus d'ABC (choix entre le Chromium du PC et celui d'Orion) | |
| 7. Rapport d'usage | Fait. `node scripts/usage-report.ts --since 24h` | `server/usage-report.ts` |
| 8. Notifications | Fait côté ABC : le shim stdio pousse en notifications MCP « logging » les surveillances déclenchées et les déconnexions du navigateur. Dépend du client MCP, qui peut les ignorer ; non vérifié avec Claude Code | `server/notify.ts`, `server/mcp.ts` |

Tests : `test/e2e-target-steps.ts`, `test/e2e-webmail-compose.ts`, `test/rich-editor.ts`, `test/usage-report.ts`,
`test/notify.ts`, `test/site-profiles.ts`.
