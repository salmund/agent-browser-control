# Agent Browser Control — Spécification

> Un équivalent de Claude in Chrome, utilisable par **n'importe quel agent** (Claude Code, Muse Code, DeepCode…) via MCP.
> Outil personnel, pas destiné à être publié.

## 1. Objectif

Donner à tout agent compatible MCP la même expérience que Claude in Chrome : piloter **mon navigateur principal** (Comet, ou Chrome), avec mes sessions et cookies, de façon fine, grâce à une extension dédiée plutôt qu'un navigateur headless lancé à côté.

Principes :
- **Agnostique de l'agent** : aucune dépendance à un fournisseur de modèle. Tout passe par MCP.
- **Parité Claude in Chrome d'abord**, puis au-delà (DevTools complets via CDP).
- **Un agent actif à la fois** en usage normal ; plusieurs agents simultanés possibles, mais pas une priorité.
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
| `tabs_context` | Liste les onglets du groupe de l'agent (id, titre, URL) |
| `tabs_create` / `tabs_close` | Ouvre / ferme un onglet dans le groupe de l'agent |
| `navigate` | URL, `back`, `forward`, `reload` |
| `computer` | `screenshot`, `left_click`, `right_click`, `double_click`, `type`, `key`, `scroll`, `hover`, `drag`, `wait` — par coordonnées **ou** par `ref` |
| `read_page` | Arbre d'accessibilité compact avec `ref` stables (`ref_12`) ; filtre `interactive` |
| `find` | Recherche d'éléments par texte / rôle / sélecteur (sans LLM) |
| `get_page_text` | Texte principal de la page (type Readability) |
| `form_input` | Remplit un champ / select / checkbox par `ref` |
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
| `cdp_send` | Appel CDP brut (désactivé par défaut) |

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

> État : v0.1 à v0.3 écrites. v0.1–v0.2 testées dans Comet (Wikipédia, Gemini, YouTube). Export WebM ajouté (les IA ne lisent que la 1re image d'un GIF). WebSocket (workers/iframes inclus via Target.setAutoAttach) et http_request ajoutés, testés sur Polymarket. v0.4 : browser_script (iframe sandbox, CSP sans réseau, relais via le document offscreen).

1. **v0.1 — Faisabilité** : daemon + shim + extension ; `tabs_context`, `tabs_create`, `navigate`, `computer` (screenshot/click/type/key/scroll), `read_page`. Test dans **Comet**.
2. **v0.2 — Parité Claude in Chrome** : reste du §3.1, groupes d'onglets par agent, side panel + STOP.
3. **v0.3 — DevTools** : §3.2 sauf `cdp_send`.
4. **v0.4 — Confort** : GIF, journal consultable, sites interdits, macros / raccourcis.
5. **Plus tard** : `cdp_send`, port Firefox, rejeu de scénarios.

## 8. Risques connus

- **Comet** : risque levé — Claude in Chrome (qui repose sur `chrome.debugger`) y fonctionne déjà.
- Le bandeau « … débogue ce navigateur » s'affiche quand le debugger est attaché : inévitable.
- Service worker MV3 : peut être suspendu ; la connexion WebSocket active et la reconnexion automatique doivent le gérer.
