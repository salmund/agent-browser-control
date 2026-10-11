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
                                  • content script : snapshot, refs, surlignage
                                  • side panel : activité en direct, bouton STOP
```

- **abc-daemon** : processus Node persistant. Point unique de connexion pour l'extension. Démarré automatiquement par `abc-mcp` s'il n'est pas déjà lancé.
- **abc-mcp** : petit exécutable stdio que les agents déclarent dans leur config MCP. Il relaie les appels vers le daemon et identifie l'agent (`--agent-name claude-code`).
- **Extension** : se connecte au daemon en WebSocket (reconnexion automatique ; l'activité WebSocket maintient le service worker MV3 en vie). Authentification par jeton partagé stocké dans `~/.agent-browser-control/token`.

## 3. Outils MCP

### 3.1 Parité Claude in Chrome (v0.1 → v0.2)

| Outil | Rôle |
|---|---|
| `tabs_context` | Liste les onglets du groupe de l'agent (id, titre, URL, inactivité) ; `label` : seulement ceux d'un sous-agent |
| `tabs_create` / `tabs_close` | Ouvre / ferme un onglet dans le groupe de l'agent ; `snapshot: true` renvoie l'arbre interactif au chargement |
| `tabs_cleanup` | Ferme les onglets inactifs (seuil `olderThanMinutes`, `dryRun` pour prévisualiser ; actif, épinglé, son et activité inconnue protégés) |
| `navigate` | URL, `back`, `forward`, `reload` ; `snapshot: true` renvoie l'arbre dès le chargement |
| `computer` | `screenshot`, `left_click`, `right_click`, `double_click`, `type`, `key`, `scroll`, `hover`, `drag`, `wait`, par coordonnées **ou** par `ref` ; `snapshot: true` ou `then: "diff"` pour enchaîner sans tour LLM |
| `read_page` | Arbre d'accessibilité compact avec `ref` stables (`ref_12`) ; filtre `interactive` |
| `find` | Recherche d'éléments par texte / rôle / sélecteur (sans LLM) ; `scan` balaye les listes virtualisées |
| `get_page_text` | Texte principal de la page (type Readability) |
| `form_input` | Remplit un champ / select / checkbox par `ref` ; saisie groupée (`fields`) et soumission (`submitRef`) en un appel |
| `javascript` | Évalue du JS dans la page (via CDP `Runtime.evaluate`) |
| `read_console_messages` | Logs console, filtre regex |
| `read_network_requests` | Requêtes réseau, filtre regex |
| `resize_window` | Redimensionne la fenêtre |
| `file_upload` | Charge un fichier local dans un `<input type=file>` (CDP `DOM.setFileInputFiles`) |
| `gif_record` | Démarre / arrête / exporte un enregistrement GIF des actions |

### 3.2 Au-delà (v0.3+)

| Outil | Rôle |
|---|---|
| `network_intercept` | Bloquer / modifier / mocker des requêtes (CDP `Fetch`) |
| `network_get_body` | Corps de réponse d'une requête |
| `storage` | Cookies, localStorage, sessionStorage (lecture / écriture) |
| `performance_trace` | Trace perf + métriques Web Vitals |
| `emulate` | Device, réseau lent, géoloc, dark mode |
| `pdf` | Export PDF de la page |
| `downloads` | Liste / récupère les téléchargements |
| `history_search` | Retrouve une page visitée (requête vide = récentes ; sites interdits exclus) |
| `site_api` | Mémoire par site : routes + appels capturés du HAR, rejoués vite (list, save_call, save_route, note, delete) + brief (routes, appels, notes) servi en tête à l'arrivée (navigate, tabs_create, tabs_context) + suggestion de mémorisation à la fermeture d'un onglet riche |
| `cdp_send` | Appel CDP brut (désactivé par défaut) |
| `scroll_extract` | Extrait tous les items d'une liste à chargement progressif en un appel (scroll + collecte + attente réactive par MutationObserver + déduplication ; `direction: up` pour les historiques, `left`/`right` pour l'horizontal avec bascule auto d'axe ; `loadMore` pour les listes à bouton ; repli scroll synthétique si la fenêtre est bridée ; gros volume en fichier) |
| `query` | Extraction structurée sans scroll : sélecteur CSS + projection + filtre + pagination (`countOnly` pour compter sans renvoyer) |
| `replay_paginated` | Rejoue un appel API paginé capturé dans le HAR (GET même origine, curseur query-only) sans toucher au DOM |

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
  STOP, verrouillage et révocation refusent les demandes en attente.
- **Non-fuite** : aucune valeur dans MCP, le journal (`redact()` + args sans valeur),
  les résultats ni le HAR (corps non enregistrés 120 s après un remplissage sur l'onglet ;
  valeurs `password` déjà masquées dans `read_page`). Tests : `test/credentials.ts`
  (aller-retour, mauvaise phrase, falsification, périmètres, non-fuite des sorties).
- **Limites honnêtes** : MFA interactif = présence humaine ; trousseau/navigateur
  verrouillé = échec propre avec alerte ; un attaquant local avec les droits de
  l'utilisateur et la phrase secrète peut tout lire (modèle de menace : fuites
  accidentelles via logs et artefacts, pas poste compromis).

## 4. Expérience utilisateur

- **Groupe d'onglets par agent** : nom + couleur (ex. « Claude Code » violet, « DeepCode » bleu). L'agent ne voit et ne touche que ses onglets, sauf s'il en adopte un explicitement.
- **Retour visuel** : bordure lumineuse sur l'onglet piloté, surlignage de l'élément ciblé avant clic.
- **Side panel** : agent connecté, flux des actions en direct, bouton **STOP** (coupe immédiatement toutes les commandes en cours et détache le debugger).
- **Sites interdits** : liste configurable (banques, gestionnaire de mots de passe…) ; toute navigation ou action y est refusée.
- **Contenu de page = données** : les textes renvoyés à l'agent sont encapsulés et marqués comme non fiables (protection prompt injection).

## 5. Stack technique

État v0.1 (volontairement sans étape de build) :
- `server/` : TypeScript exécuté nativement par Node 22.18+ ; `daemon.ts`, `mcp.ts` (shim stdio), `tools.ts`, `common.ts`. Dépendances : `@modelcontextprotocol/sdk`, `ws`.
- `extension/` : MV3 en JavaScript simple (`background.js`, `page.js`, popup).
- Journal : fichier JSONL `~/.agent-browser-control/actions.log`.

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
// Plus tard, en HTTP : http://127.0.0.1:7878/mcp?agent=deepcode
```

## 7. Feuille de route

> État : v0.1 à v0.3 écrites. v0.1–v0.2 testées dans Comet (Wikipédia, Gemini, YouTube). Export WebM ajouté (les IA ne lisent que la 1re image d'un GIF). WebSocket (workers/iframes inclus via Target.setAutoAttach) et http_request ajoutés, testés sur Polymarket. v0.4 : browser_script (iframe sandbox, CSP sans réseau, relais via le document offscreen). v0.5 : wait_for, iframes (y compris d'une autre origine), boîtes de dialogue, lectures viewport / diff. v0.6 : saisie groupée atomique (form_input fields + submitRef), stabilisation DOM (wait_for domSettled), détection automatique d'authentification (navigate + wait_for authSettled), et routage direct / deep links (site-api.json).

1. **v0.1 : Faisabilité** : daemon + shim + extension ; `tabs_context`, `tabs_create`, `navigate`, `computer` (screenshot/click/type/key/scroll), `read_page`. Test dans **Comet**.
2. **v0.2 : Parité Claude in Chrome** : reste du §3.1, groupes d'onglets par agent, side panel + STOP.
3. **v0.3 : DevTools** : §3.2 sauf `cdp_send`.
4. **v0.4 : Confort** : GIF, journal consultable, sites interdits, macros / raccourcis.
5. **Plus tard** : `cdp_send`, port Firefox, rejeu de scénarios.

## 8. Risques connus

- **Comet** : risque levé, puisque Claude in Chrome (qui repose sur `chrome.debugger`) y fonctionne déjà.
- Le bandeau « … débogue ce navigateur » s'affiche quand le debugger est attaché : inévitable.
- Service worker MV3 : peut être suspendu ; la connexion WebSocket active et la reconnexion automatique doivent le gérer.
