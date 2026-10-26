# Agent Browser Control : spécification

> Un équivalent de Claude in Chrome, utilisable par **n'importe quel agent** (Claude Code, Muse Code, DeepCode…) via MCP.
> Outil personnel, pas destiné à être publié.

## 1. Objectif

Donner à tout agent compatible MCP la même expérience que Claude in Chrome : piloter **mon navigateur principal** (Comet, ou Chrome), avec mes sessions et cookies, de façon fine, grâce à une extension dédiée plutôt qu'un navigateur headless lancé à côté.

Principes :
- **Agnostique de l'agent** : aucune dépendance à un fournisseur de modèle. Tout passe par MCP.
- **Parité Claude in Chrome d'abord**, puis au-delà (DevTools complets via CDP).
- **Un agent actif à la fois** en usage normal ; plusieurs agents simultanés possibles (sous-agents d'un workflow : `label` sur `tabs_context` / `tabs_create`, un groupe « agent · label » chacun).
- **Simple et perso** : pas de système de permissions lourd, mais un bouton stop et une liste de sites interdits.

## 2. Architecture

```
 Agent (Claude Code, Muse Code, DeepCode…)
        │  MCP stdio                      │  MCP Streamable HTTP
        ▼                                 ▼
 abc-mcp (shim stdio) ──────────► abc-daemon (127.0.0.1:7878)
                         HTTP/WS      │  • serveur MCP HTTP (/mcp)
                                      │  • routage agent ↔ onglets
                                      │  • journal des actions
                                      ▼  WebSocket + jeton
                               Extension MV3 (Comet / Chrome)
                                  • service worker : exécute les commandes
                                  • chrome.debugger (CDP), tabs, tabGroups, scripting
                                  • script de page : snapshot, refs, surlignage
                                  • panneau latéral : agents en direct, journal, demandes, réglages, secrets
```

- **abc-daemon** : processus Node persistant. Point unique de connexion pour l'extension. Démarré automatiquement par `abc-mcp` s'il n'est pas déjà lancé.
- **abc-mcp** : petit exécutable stdio que les agents déclarent dans leur config MCP. Il relaie les appels vers le daemon et identifie l'agent (`--agent-name claude-code`).
- **Extension** : se connecte au daemon en WebSocket sur `/ext` (reconnexion automatique ; l'activité WebSocket maintient le service worker MV3 en vie). La première origine `chrome-extension://…` acceptée est épinglée dans `~/.agent-browser-control/extension-origin` (confiance au premier usage) ; toute autre origine est refusée (fermeture 4003, événement `extension_refused` au journal) ; `npm run unpin-extension` efface l'épinglage. Une reconnexion de la même origine remplace l'ancienne socket.

### 2.1 Routes et protocole du démon

Le démon n'accepte que l'en-tête `Host` `127.0.0.1:<port>` ou `localhost:<port>` (parade au DNS rebinding) et refuse toute requête portant un `Origin` web. Le jeton (`~/.agent-browser-control/token`, en `x-abc-token` ou `Authorization: Bearer`) est comparé en temps constant.

| Route | Jeton | Rôle |
|---|---|---|
| `GET /health` | non | état : version, extension connectée et sa version, appels en cours (`inflight`), ms depuis la fin du dernier appel (`idleMs`, 0 pendant un appel), code de l'extension périmé (`extensionStale` : Chrome exécute encore une version en cache des scripts du service worker, à relancer), debugger refusé au navigateur (`debuggerBlocked` : message de Chrome, ou null ; sites bloqués aux extensions depuis Chrome 155, gestes rejoués par événements de page ; remède : stratégie `ExtensionSettings` sans `runtime_blocked_hosts` pour l'extension, voir le README), arrêt en cours (`shuttingDown`), empreinte du catalogue des fonctions (`skillsVersion` : le shim renouvelle la liste d'outils quand elle change) |
| `POST /call` | oui | appel d'outil `{agent, tool, args, session?}` (utilisé par le shim stdio ; `session` : identifiant aléatoire du shim, pour que le catalogue et les rappels « une fois » valent par session et non par nom d'agent) |
| `POST /mcp?agent=<nom>` | oui | serveur MCP Streamable HTTP sans état : mêmes outils, même filtrage, même relais que le shim ; `GET` et `DELETE` répondent 405 |
| `GET /events` | oui | flux SSE : une ligne JSON par événement journalisé (données déjà expurgées) |
| `GET /skills` | oui | `{version, descriptions}` : descriptions d'outils calculées par le démon (celle de `skill` porte le catalogue des fonctions), lues par le shim pour sa liste d'outils |
| `POST /shutdown` | oui | arrêt propre : attend les appels en cours (10 s au plus) puis quitte |
| `POST /reload-extension` | oui | recharge l'extension |

Messages WebSocket du démon vers l'extension, en plus des appels `{id, agent, tool, args}` :
- `{"type":"hello","version":"<version du démon>"}` : premier message après acceptation ;
- `{"type":"cancel","id":<id>}` : l'appel `id` a dépassé son délai côté démon (l'agent a reçu une erreur) ; un résultat tardif portant un fichier (`_file`) est tout de même enregistré.

Côté extension : `hello` alimente la version du démon affichée dans le panneau ; `cancel` interrompt l'appel en cours (réponse immédiate, travail restant coupé à la prochaine commande CDP ou appel de page) ; une fermeture 4003 espace les reconnexions (60 s) et le panneau affiche « Connexion refusée » avec la marche à suivre ; `file_upload` interroge `upload-check` avant de charger un fichier (et applique sa propre liste de refus si le démon est ancien) ; un `browser_script` qui appelle `skill(nom, args)` obtient le code de la fonction et ses arguments normalisés par la RPC `skill-source`.

Délais par outil (`timeoutFor`, `server/common.ts`) : 90 s par défaut ; `wait_for` son `timeout` + 15 s ; `downloads` (download, wait) son `timeout` + 15 s, 295 s au plus ; export `gif_creator` 600 s ; `replay_paginated` 15 s par page + 15 s, 300 s au plus ; `browser_script` 295 s ; `search`, `read_urls` et `skill` 330 s (le moteur borne lui-même chaque fonction : 90 s par défaut, 150 s pour une recherche avec `read`, 280 s au plus) ; `ask_human` son délai + 15 s ; capture `computer` 30 s. Si l'extension se déconnecte pendant un appel, il échoue aussitôt (l'action a pu être exécutée).

Variables d'environnement : `ABC_PORT` (7878), `ABC_CONFIG_DIR` (`~/.agent-browser-control`, utile aux tests pour ne jamais toucher la vraie configuration).

Garde-fous côté démon : journal expurgé (saisies et corps réduits à leur longueur, en-têtes et query d'URL masqués, code tronqué à 2 Ko avec empreinte, rotation à 5 Mo) ; `file_upload` refuse avant l'extension les chemins relatifs ou absents, le dossier de configuration, `.ssh`, `.gnupg`, `.aws`, AppData, les profils de navigateur et les fichiers de secrets (`.har`, `.pem`, `.key`, `id_rsa*`, `id_ed25519*`, `.env*`) ; l'extension peut faire le même contrôle par la RPC `upload-check` ; la mémoire de site servie en tête de réponse est encadrée par `<site_memory note="…">` (écrite par un agent, non vérifiée) ; `download_media` n'accepte que des URL http(s) et des options en liste blanche.

## 3. Outils MCP

### 3.1 Parité Claude in Chrome (v0.1 → v0.2)

| Outil | Rôle |
|---|---|
| `tabs_context` | Liste les onglets du groupe de l'agent (id, titre, URL, inactivité) ; `label` : seulement ceux d'un sous-agent |
| `tabs_create` / `tabs_close` | Ouvre / ferme un onglet dans le groupe de l'agent ; `snapshot: true` renvoie l'arbre interactif au chargement ; `wait` : `ready` (défaut : DOMContentLoaded puis DOM stable 300 ms, 1,5 s au plus), `load`, ou `dom` (dès DOMContentLoaded, pour un code qui relit lui-même la page) |
| `tabs_cleanup` | Ferme les onglets inactifs (seuil `olderThanMinutes`, `dryRun` pour prévisualiser ; actif, épinglé, son et activité inconnue protégés) |
| `navigate` | URL, `back`, `forward`, `reload` ; `snapshot: true` renvoie l'arbre dès le chargement ; SPA même origine sans rechargement (clic routeur, sinon pushState ; `spa: false` force le complet) |
| `computer` | `screenshot` (avec `ref` : capture cadrée sur l'élément), `left_click`, `right_click`, `double_click`, `type`, `key`, `scroll`, `hover`, `drag`, `wait`, `dismiss_consent` (ferme la bannière de cookies en refusant les cookies non essentiels : bouton de refus, iframes de la CMP, sinon API Didomi, OneTrust, Cookiebot, Usercentrics, tarteaucitron ; mur de cookies sans refus, « accepter ou s'abonner », ou sans réglages où refuser : clic sur « Accepter », jamais sur un abonnement ni une connexion, et la réponse le dit), par coordonnées **ou** par `ref` ; `snapshot: true` ou `then: "diff"` pour enchaîner sans tour LLM ; effet constaté dans chaque réponse (digest avant/après, plus « Aussi : » erreurs JavaScript, requêtes en échec, boîte de dialogue, onglet ou popup ouvert, téléchargement) ; refs auto-réparées après re-render |
| `read_page` | Arbre d'accessibilité compact avec `ref` stables (`ref_12`) ; filtre `interactive` ; hint des appels JSON détectés en tête |
| `find` | Recherche d'éléments par texte / rôle / sélecteur (sans LLM) ; `scan` balaye les listes virtualisées |
| `get_page_text` | Texte principal de la page (type Readability) ; hint des appels JSON détectés en tête |
| `form_input` | Remplit un champ / select / checkbox / éditeur riche par `ref` ; saisie groupée (`fields`) et soumission (`submitRef`) en un appel ; stratégie annoncée, échec net vers `computer` si réfractaire |
| `javascript` | Évalue du JS dans la page (via CDP `Runtime.evaluate`) ; un Element (ou liste) renvoyé devient des `ref` |
| `devtools` | Les 12 outils DevTools rarement utilisés en un seul (`action` + `op`) : console, network, body, intercept, storage, perf, emulate, pdf, websocket, http, har (dont export-code curl/Python), resize. Anciens noms acceptés (compatibilité) |
| `file_upload` | Charge un fichier local dans un `<input type=file>` (CDP `DOM.setFileInputFiles`) ; sous Linux, un fichier hors du dossier personnel (ou dans un dossier caché) est d'abord copié dans `Téléchargements/agent-browser-control/envois/` (gardé 24 h), seul endroit que lit un Chromium en snap |
| `gif_creator` | Démarre / arrête / exporte un enregistrement GIF ou WebM des actions |
| `wait_for` | Attente par conditions (selector, text, settle, countStable, image, authSettled…) ; diagnostic d'échec (réseau, DOM, texte observés) |
| `handle_dialog` | Répond aux boîtes alert / confirm / prompt / beforeunload |

### 3.2 Au-delà (v0.3+)

| Outil | Rôle |
|---|---|
| `search` | Verbe : recherche en 1 appel. `kind: "web"` (Google lu par la structure, liens `/goto` résolus, aperçu IA, repli DuckDuckGo sur captcha ou page vide, consentement refusé sur un profil neuf ; `read: N` lit aussi les N premières pages), `"images"` (Google Images lu par `data-docid` et les données de la page, repli Bing Images : URL pleine taille, page, dimensions ; miniatures jointes en contenu image, `pick: [n°]` / `save: N` enregistrent dans `Téléchargements/agent-browser-control/`), `"videos"` (YouTube). Onglet de fond refermé à la fin |
| `read_urls` | Verbe : lit plusieurs pages (10 au plus, 4 en parallèle) en onglets de fond refermés ensuite ; PDF signalés sans ouvrir d'onglet |
| `skill` | Fonctions d'ABC : un parcours entier en 1 appel (`run`, `list`, `show`, `save`, `delete`). Intégrées dans `skills/` du dépôt (`web.*`, protégées), apprises dans `~/.agent-browser-control/skills/<site.verbe>.js` (en-tête `/** @skill {json} */` : description, `params` typés avec défauts et `enum`, `site`, `effects` read/write ; versions précédentes dans `skills/.anciennes/`) ; arguments normalisés et contrôlés avant exécution ; enregistrement refusé si le code, la description ou les valeurs par défaut contiennent une donnée privée en dur (e-mail, jeton JWT ou Bearer, clé d'API, mot de passe) ; entités HTML (`&gt;`, `&amp;`…) écrites par certains modèles décodées si le code ne compile qu'ainsi (aussi pour `browser_script`) ; `save` avec `test` essaie avant d'enregistrer (refus si échec ou valeur vide, jamais d'essai d'une fonction `write`) ; statistiques dans `skills-stats.json` (échecs de suite signalés au catalogue). Catalogue servi par `tabs_context` (une fois par agent et par 30 min), par la description de l'outil `skill`, et à l'arrivée sur un site couvert ; incitations : moteur de recherche ouvert à la main (vers `search`), 10 actions sur un site sans fonction (vers `skill save`, avec le parcours résumé et la question « qu'aurait-il fallu savoir pour le faire en 1 à 3 appels ? »), fermeture d'un long parcours (« Avant de répondre : … fige ce parcours », la route et la note n'étant que l'exception), `browser_script` réussi sur un site sans fonction (vers `skill save` du même code) ; `read_urls` signale une page remplacée par un mur anti-robot au lieu de la rendre comme lue |
| `downloads` / `read_document` | Télécharge avec la session, suit, liste ; lit PDF (OCR si scanné : Windows, ou Tesseract sous Linux), Word, PowerPoint, Excel, texte ; Téléchargements = dossier XDG sous Linux (`Téléchargements` en français) |
| `history_search` | Retrouve une page visitée (requête vide = récentes ; sites interdits exclus) |
| `site_api` | Mémoire par site (les parcours à refaire vont plutôt en fonctions, `skill save`) : routes + appels capturés du HAR + macros + notes, rejoués vite (list, save_call, save_route, note, delete, suggest_macros, save_macro) + brief servi en tête à l'arrivée (navigate, tabs_create, tabs_context) + suggestion de mémorisation à la fermeture d'un onglet riche |
| `scroll_extract` | Extrait tous les items d'une liste à chargement progressif en un appel (scroll + collecte + attente réactive par MutationObserver + déduplication ; `direction: up` pour les historiques, `left`/`right` pour l'horizontal avec bascule auto d'axe ; `loadMore` pour les listes à bouton ; repli scroll synthétique si la fenêtre est bridée ; gros volume en fichier) |
| `query` | Extraction structurée sans scroll : sélecteur CSS + projection + filtre + pagination (`countOnly` pour compter sans renvoyer) |
| `read_tables` | Tableaux `<table>` en Markdown ou CSV (colspan répété, rowspan descendu) |
| `replay_paginated` | Rejoue un appel API paginé capturé dans le HAR (GET même origine, curseur query-only) sans toucher au DOM |
| `read_screen_text` | OCR locale de l'écran avec positions (canvas, images, PDF) |
| `save_image` | Enregistre une image de la page (même protégée par session) |
| `transcript` | Texte minuté d'une vidéo YouTube (sans rien télécharger) |
| `download_media` | Vidéo / audio / sous-titres via yt-dlp (ce que l'utilisateur a le droit de conserver) |
| `browser_script` | Programmes JS chaînant les outils en un appel (bac à sable sans réseau, relais offscreen ; `args` ; aides `open`/`close`/`keep`/`page`/`http`/`skill`, les onglets ouverts par `open()` refermés à la fin d'un script réussi ; moteur des fonctions d'ABC, qui passent le réglage « scripts désactivés » quand elles sont intégrées) ; point de reprise après échec (`resume: {trace, from}`, rejoués sans ré-exécution) |
| `watch` | Surveillances persistantes du démon (texte, sélecteur, JS) : declare, list, check, cancel ; réarmement, pause auto après 5 erreurs |
| `demo` | L'utilisateur montre le parcours (clics, saisies hors mots de passe, navigations), l'agent reçoit étapes + code rejouable + note suggérée |
| `ask_human` | Passe la main dans le vrai onglet (captcha, 2FA, validation) : notification + panneau, retour avec effet constaté et note |
| `captcha_solve` | Résout le captcha de l'onglet (Turnstile, reCAPTCHA, hCaptcha : case, défis image via vision, jeton) ; échec explicite vers ask_human |

## 3.3 Secrets d'authentification (`credentials_fill`)

L'agent remplit identifiants et mots de passe **sans jamais les connaître** (connexions
planifiées sans intervention). Références opaques de bout en bout :

- **Coffre côté extension** : slots `{id, label, hosts, policy}` + charge chiffrée
  (PBKDF2 210 000 itérations → AES-GCM-256, `extension/slots-crypto.js`, WebCrypto pur).
  La phrase secrète est choisie dans le panneau latéral (section Secrets) : elle crée
  le coffre, n'est jamais stockée, seule la clé dérivée vit en mémoire / session.
- **Remplissage** : `credentials_fill(tabId, fills:[{ref, slot}], submitRef?)`.
  L'extension vérifie le périmètre du slot (suffixe d'hôte), déchiffre à l'usage,
  remplit via `fillSecret` (sans écho de valeur) et ne renvoie que des confirmations.
- **Approbation** : politique par slot, `ask` (défaut, approbation unique dans le
  panneau, 75 s puis refus) ou `always` (sans demander, pour les runs planifiés).
  STOP, verrouillage et révocation refusent les demandes en attente. Réglage « Connexions automatiques »
  (vue Réglages, désactivé par défaut) : plus de carte d'accord pour aucun slot ni élément du coffre ; périmètre,
  iframe et sites interdits restent vérifiés ; plusieurs comptes pour un site : l'utilisateur choisit toujours.
- **Non-fuite** : aucune valeur dans MCP, le journal (`redact()` + args sans valeur),
  les résultats ni le HAR (corps non enregistrés 120 s après un remplissage sur l'onglet ;
  valeurs `password` déjà masquées dans `read_page`). Tests : `test/credentials.ts`
  (aller-retour, mauvaise phrase, falsification, périmètres, non-fuite des sorties).
- **Limites honnêtes** : MFA interactif = présence humaine ; trousseau/navigateur
  verrouillé = échec propre avec alerte ; un attaquant local avec les droits de
  l'utilisateur et la phrase secrète peut tout lire (modèle de menace : fuites
  accidentelles via logs et artefacts, pas poste compromis).

## 3.4 Pont Bitwarden (slots externes)

Les slots dits "externes" ne stockent aucune valeur, seulement une référence
(`external: {provider: "bitwarden", itemId, itemName?}`, sans `iv`/`data`).
Au remplissage, après les mêmes contrôles (périmètre, politique `ask`/`always`,
approbation panneau), l'extension demande la valeur au démon via le RPC
extension -> démon (`daemon-rpc` sur le WebSocket local : `bw-resolve`),
qui l'obtient du CLI `bw` (`bw get password|username <id> --raw`) et la renvoie.
`use: "login"` donne l'identifiant Bitwarden, sinon le mot de passe.

- **Serveur persistant** (`server/bw-serve.ts`, `test/bw-serve.ts`) : chaque lancement du CLI coûte 3 à 4 s
  (démarrage de Node, déchiffrement du coffre). Tant que le démon détient une session, il garde un `bw serve`
  (lancé à l'ouverture du coffre, préchauffé, arrêté au verrouillage et à l'arrêt du démon) : état, correspondance,
  recherche, valeurs et synchro passent par lui en quelques millisecondes. Son API n'ayant pas d'authentification,
  il n'écoute jamais sur un port TCP : socket unix dans `bw-serve/` (0700) sous Linux et macOS, tube nommé aléatoire
  sous Windows ; protection d'origine de `bw` active, session par l'environnement. Toute panne (démarrage, transport,
  réponse illisible) fait passer l'appel par le CLI, et le serveur est relancé (5 s, 30 s, puis 2 min) ; une erreur
  du coffre (verrouillé, élément introuvable) est rendue comme par le CLI. `ABC_BW_SERVE=0` revient au CLI seul.

- **Session** : le mot de passe maître est saisi dans le panneau, sert une fois
  à `bw unlock` et est abandonné ; la clé de session vit en mémoire du démon
  uniquement (`bw lock` à la demande). `bw login` reste manuel, une fois par poste.
  Réglage « Garder Vaultwarden déverrouillé » (vue Réglages, désactivé par défaut) : la clé de session est aussi
  écrite dans `bitwarden-session` (DPAPI du compte Windows ; ailleurs fichier 0600) et relue au démarrage du
  démon ; « Verrouiller » ou la désactivation du réglage l'effacent (`server/bw-keep.ts`, `test/bw-keep.ts`).
- **Relais des demandes** (`server/relay.ts`, `extension/bg/relay.js`, `test/relay.ts`) : si `relay.json` existe,
  chaque demande en attente (`credApprovals`, `askRequests`, `bwUnlockRequests`) part en POST vers le service
  configuré, avec une `replyUrl` (`POST /relay/decision`, hors jeton du démon) et un jeton aléatoire propre à la
  demande, à usage unique. La décision repart vers l'extension (`relay-decision`) et suit le même chemin qu'un clic
  du panneau ; le déverrouillage du coffre ne peut qu'être refusé par ce biais.
- **Hygiène CLI** (`server/bitwarden.ts`) : execFile sans shell, secrets en env
  (`BW_SESSION`, `ABC_BW_PASSWORD` + `--passwordenv`), jamais en argv ; recherche
  expurgée (id, nom, identifiant, urls ; mots de passe et notes jetés côté démon).
- **Non-fuite** : comme le coffre intégré, aucune valeur en MCP, journal ou HAR
  (même silence HAR de 120 s). Référence testée : `test/bitwarden.ts`.

## 4. Expérience utilisateur

- **Groupe d'onglets par agent** : nom + couleur (ex. « Claude Code » violet, « DeepCode » bleu). L'agent ne voit et ne touche que ses onglets. Un onglet ouvert par une action de l'un d'eux (lien `target=_blank` cliqué par l'agent, pendant l'appel ou dans les 8 s qui suivent) entre dans son groupe ; un onglet que l'utilisateur ouvre depuis un onglet d'agent (Ctrl+T, clic) lui revient, retiré du groupe si Chrome l'y avait mis ; une fenêtre popup (connexion OAuth, paiement), qui ne peut pas être groupée, lui est rattachée et apparaît dans `tabs_context`. Les onglets d'agent ne sont jamais déchargés par Chrome pour libérer de la mémoire ; un onglet dont le rendu a planté est signalé comme tel (recharger avec `navigate`).
- **L'utilisateur garde son onglet** : les agents travaillent en arrière-plan ; un geste souris fait passer l'onglet devant le temps du geste, puis rend la main. Un onglet ouvert devant par une action d'agent rend aussitôt la place à l'onglet de l'utilisateur.
- **Retour visuel** : surlignage de l'élément ciblé avant clic (réglage « Montrer les gestes »).
- **Panneau latéral**, en trois vues (l'ordre des lignes d'agents reste stable une fois affiché, pour ne pas cliquer sur la mauvaise) :
  - *Activité* : demandes en attente (passage de main `ask_human`, approbation de secret, avec compte à rebours) ; agents en direct, une ligne par agent et par sous-agent (dernière action en mots simples, durée, actions : écrire, afficher ses onglets, pause, fermer ses onglets après confirmation) ; agents qui ont fini regroupés sous une ligne repliable ; journal filtrable (agent, échecs), chaque ligne dépliable (outil, paramètres, site, durée, erreur, « Afficher l'onglet », « Copier »).
  - *Réglages* : premier plan, scripts, gestes, souris réelle, sites interdits, raccourcis, version et diagnostic copiable.
  - *Souris réelle* (désactivée par défaut, pour une machine dont l'écran sert aux agents) : clics, survols, défilements et glisser passent par le vrai pointeur, que le démon déplace (Linux X11, `xdotool`, `server/pointer.ts`) le long d'un trajet de main ; l'extension (`bg/pointer.js`) convertit le point de la page en pixels d'écran, vérifie par les `mousemove` reçus (monde isolé, toutes frames) que le pointeur est arrivé au bon endroit, corrige au besoin, et revient au geste CDP si la souris réelle est indisponible (note dans la réponse). Elle ne sert que sur les pages qui le justifient (`pointerReason`) : script ou widget anti-robot (Turnstile et défi Cloudflare, hCaptcha, reCAPTCHA, Arkose, DataDome, PerimeterX, GeeTest), champ de mot de passe visible, ou hôte où une protection a été vue depuis moins de 30 min ; sonde en monde isolé, gardée 3 s par onglet et adresse. `computer` `human: true` l'impose pour un geste, `false` l'écarte ; la raison du choix va au journal du démon (`event: "pointer"`, `why`).
  - *Secrets* : coffre intégré et Bitwarden / Vaultwarden.
- **Arrêt d'urgence** : bouton **Tout arrêter**, raccourci `Alt+Shift+S` (reprise `Alt+Shift+R`), ou « Annuler » sur la barre « … débogue ce navigateur ». Les appels en cours répondent aussitôt à l'agent et leur travail restant s'arrête (commandes CDP et appels de page refusés, debugger détaché).
- **Pause d'un agent** : depuis sa ligne ; ses appels en cours sont coupés, les suivants refusés avec un message clair ; la pause d'un agent couvre ses sous-agents.
- **Messages aux agents** : depuis sa ligne, l'utilisateur écrit à un agent ou à un sous-agent ; le message est remis en tête de la réponse de son prochain appel d'outil (hors balise non fiable, présenté comme venant de l'utilisateur), une seule fois ; le panneau affiche « En attente » (avec « Retirer ») puis « Lu à HH:MM ». Un agent en pause le lit avec le refus de sa prochaine action. Un appel fait par un script (`browser_script`) ne consomme pas le message : il arrive avec la réponse du script.
- **Badge de l'icône** : `stop` (arrêté), `off` (démon absent) ou le nombre de demandes qui attendent l'utilisateur ; notification système pour chaque demande (clic : ouvre le panneau).
- **Sites interdits** : liste configurable (banques, gestionnaire de mots de passe…) ; toute navigation ou action y est refusée, et un onglet d'agent qui y arrive par redirection ou par un lien est vidé aussitôt.
- **Pages de l'extension réservées** : un agent ne peut ni ouvrir ni piloter les pages d'ABC (panneau, secrets) ; les messages qui commandent le service worker ne sont acceptés que depuis une page de l'extension hors onglet (le panneau), jamais depuis un script injecté.
- **Contenu de page = données** : les textes renvoyés à l'agent sont encapsulés dans `<page_content>` et marqués comme non fiables (protection prompt injection) ; une page qui écrit elle-même la balise fermante ne peut pas en sortir (neutralisée). Titres et libellés cités hors balise sont réduits à une ligne sans chevrons.

### 4.1 Contrat panneau ↔ service worker

Le panneau lit `chrome.storage.session` (`connected`, `connError`, `paused`, `pausedAgents`, `activity`, `groups`, `askRequests`, `credApprovals`, `agentMessages`, `daemonVersion`) et `chrome.storage.local` (`knownAgents`, réglages). Il écrit par `chrome.runtime.sendMessage` : `stop`, `resume`, `reconnect`, `agent-pause {agent, paused}`, `agent-message {to, text}`, `agent-message-cancel {id}`, `activity-clear`, `diagnostic`, `ask-decision`, `credential-decision`, `credentials-*`, `bw-*`. Une entrée du journal : `{id, t, agent, color, tool, action?, target?, host?, tabId?, steps?, summary, status, ms?, error?}` ; `target` ne contient jamais de texte saisi ni de valeur de champ. Le journal (200 entrées) survit au réveil du service worker ; les écritures sont regroupées (120 ms).

## 5. Stack technique

État v0.8 (volontairement sans étape de build) :
- `server/` : TypeScript exécuté nativement par Node 22.18+ ; `daemon.ts`, `mcp.ts` (shim stdio), `mcp-server.ts` (serveur MCP commun au shim et à `/mcp`), `tools.ts`, `common.ts`, `security.ts` (expurgation, contrôles d'accès, `file_upload`), `har.ts`, `analysis.ts`, `watch.ts`, `housekeeping.ts`, `skills.ts` (registre des fonctions), `verbs.ts` (moteur de `search`, `read_urls`, `skill`), `web-media.ts` (images téléchargées par le démon : http(s) seulement, adresses privées, locales et du tailnet refusées après résolution DNS, redirections revérifiées, 15 Mo au plus). `skills/` : fonctions intégrées (`web.search`, `web.read`, `web.images`, `web.videos`). Dépendances : `@modelcontextprotocol/sdk`, `ws`, `jszip`, `unpdf`.
- `extension/` : MV3 en JavaScript simple, sans build. `background.js` charge par `importScripts` les scripts classiques de `bg/` (un domaine par fichier, portée globale partagée : `base`, `stop`, `activity`, `blocklist`, `tabs`, `navigation`, `cdp`, `network`, `page-bridge`, `reading`, `capture`, `input`, `foreground`, `computer`, `javascript`, `recording`, `scripts`, `settings`, `wait`, `media`, `downloads`, `credentials`, `ask`, `messages`, `demo`, `dispatch`, `connection`) ; `page.js` (script de page), `devtools.js`, sandbox et offscreen. Le panneau : `sidepanel.html` + `sidepanel.css` + modules ES `panel/` (`main`, `activity`, `settings`, `secrets`, `labels`, `dom`). `test/extension-load.ts` charge le service worker avec un faux `chrome` pour attraper les erreurs de chargement ; `test/sidepanel-preview.html` (servi par `node test/preview-server.ts`) affiche le panneau avec des données fictives.
- Journal : fichier JSONL `~/.agent-browser-control/actions.log`. Mémoire site : `site-api.json`. Fonctions apprises : `skills/` et `skills-stats.json`. Surveillances : `watches.json`.
- Versions unifiées (`test/version.ts` garde-fou) : package.json, manifest, démon, shim, créateur HAR. `npm run update` : la même mise à jour sur tous les appareils (`docs/mise-a-jour.md`, `server/maj.ts`), en deux étapes (l'ancien code attend le calme, prend un instantané des réglages et avance ; le nouveau code installe les dépendances, applique les migrations de `migrations/`, relance démon et extension et vérifie version et outils servis ; retour arrière par l'ancien code en cas d'échec), profil d'appareil `~/.agent-browser-control/appareil.json`, journal des versions `CHANGELOG.md`. Un shim qui trouve un démon d'une autre version que celle installée le redémarre s'il est inactif. Installeurs `install.ps1` / `install.sh`.

Cible ultérieure : extension migrée sous **WXT** en TypeScript quand elle grossira (side panel, Firefox), journal SQLite si besoin de requêtes.

## 6. Configuration côté agents

```jsonc
// Claude Code / Muse Code / DeepCode (stdio)
{
  "mcpServers": {
    "agent-browser-control": {
      "command": "node",
      "args": ["<dossier>/server/mcp.ts", "--agent-name", "deepcode"]
    }
  }
}

// En HTTP (Streamable HTTP), sans processus intermédiaire ; le démon doit déjà tourner
{
  "mcpServers": {
    "agent-browser-control": {
      "type": "http",
      "url": "http://127.0.0.1:7878/mcp?agent=deepcode",
      "headers": { "Authorization": "Bearer <contenu de ~/.agent-browser-control/token>" }
    }
  }
}
```

En HTTP, le nom d'agent vient de `?agent=` (ou de l'en-tête `x-abc-agent`) ; le serveur est sans état, donc sans notification `list_changed` : la liste d'outils est relue à chaque `tools/list`.

## 7. Feuille de route

> État : v0.1 à v0.3 écrites. v0.1 et v0.2 testées dans Comet (Wikipédia, Gemini, YouTube). Export WebM ajouté (les IA ne lisent que la 1re image d'un GIF). WebSocket (workers/iframes inclus via Target.setAutoAttach) et http_request ajoutés, testés sur Polymarket. v0.4 : browser_script (iframe sandbox, CSP sans réseau, relais via le document offscreen). v0.5 : wait_for, iframes (y compris d'une autre origine), boîtes de dialogue, lectures viewport / diff. v0.6 : saisie groupée atomique (form_input fields + submitRef), stabilisation DOM (wait_for domSettled), détection automatique d'authentification (navigate + wait_for authSettled), et routage direct / deep links (site-api.json). v0.7 : leurre de visibilité arrière-plan, DevTools unifié, export-code HAR, tableaux, navigate SPA, macros apprises, découverte passive des API, reprise des scripts, éditeurs riches, versions unifiées + update, ask_human, surveillances, démo, file de premier plan multi-agents. v0.8 : panneau refondu (vues Activité / Réglages / Secrets, agents en direct, journal lisible), pause et messages par agent, arrêt d'urgence réel (appels coupés, raccourci clavier), service worker découpé par domaine, popups adoptées, effets secondaires dans chaque réponse, refus des cookies, démon durci (épinglage, délais par outil et annulation, /mcp HTTP, /events), lectures plus sûres et plus compactes.

1. **v0.1 : Faisabilité** : daemon + shim + extension ; `tabs_context`, `tabs_create`, `navigate`, `computer` (screenshot/click/type/key/scroll), `read_page`. Test dans **Comet**.
2. **v0.2 : Parité Claude in Chrome** : reste du §3.1, groupes d'onglets par agent, side panel + STOP.
3. **v0.3 : DevTools** : §3.2 sauf `cdp_send`.
4. **v0.4 : Confort** : GIF, journal consultable, sites interdits, macros / raccourcis.
5. **Plus tard** : `cdp_send`, port Firefox, rejeu de scénarios.

## 8. Risques connus

- **Comet** : risque levé, puisque Claude in Chrome (qui repose sur `chrome.debugger`) y fonctionne déjà.
- Le bandeau « … débogue ce navigateur » s'affiche quand le debugger est attaché : inévitable.
- Service worker MV3 : peut être suspendu ; la connexion WebSocket active et la reconnexion automatique doivent le gérer.
