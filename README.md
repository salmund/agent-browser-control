# Agent Browser Control

Équivalent de Claude in Chrome pour **n'importe quel agent MCP** (Claude Code, Muse Code, DeepCode…).
Voir [SPEC.md](SPEC.md) pour la conception complète.

## Installation

1. **Dépendances** (Node 22.18+ requis, les `.ts` sont exécutés nativement) :
   ```sh
   npm install
   ```
2. **Extension** : dans Comet / Chrome, ouvrir `chrome://extensions`, activer le **mode développeur**,
   cliquer **Charger l'extension non empaquetée** et choisir le dossier `extension/`.
   Le badge « off » sur l'icône disparaît quand le démon est joignable.
3. **Agents** : n'importe quel agent compatible MCP (stdio). La même config sert partout :
   ```json
   {
     "mcpServers": {
       "agent-browser-control": {
         "command": "node",
         "args": ["/chemin/vers/agent-browser-control/server/mcp.ts"]
       }
     }
   }
   ```
   Le nom de l'agent (titre de son groupe d'onglets) est détecté automatiquement depuis le client MCP.
   Pour le forcer : ajouter `"--agent-name", "mon-agent"` aux `args`.

   Exemple avec Claude Code : `claude mcp add agent-browser-control -s user -- node "/chemin/vers/agent-browser-control/server/mcp.ts"`

Le démon (`127.0.0.1:7878`) est lancé automatiquement par le premier agent qui se connecte.
On peut aussi le lancer à la main : `npm run daemon`.

## Fonctionnement

```
Agent ──MCP stdio──► server/mcp.ts ──HTTP + jeton──► server/daemon.ts ◄──WebSocket── extension/
```

- Chaque agent a son **groupe d'onglets** (nom + couleur) et ne peut agir que dans ses onglets.
- Jeton et journal des actions : `~/.agent-browser-control/` (`token`, `actions.log`).
- Le démon refuse toute requête HTTP portant un en-tête `Origin` (pages web) et n'accepte en
  WebSocket que les origines `chrome-extension://`.

## Outils (v0.5)

| Outil | Rôle |
|---|---|
| `tabs_context`, `tabs_create`, `tabs_close` | Onglets du groupe de l'agent ; `incognito` pour la navigation privée (groupe « agent (privé) », extension à autoriser en navigation privée) |
| `navigate` | URL, `back`, `forward`, `reload` |
| `computer` | screenshot, clics (simple/double/triple/droit), left_click_drag, hover, type, key, scroll, scroll_to, wait |
| `read_page`, `find` | Arbre d'accessibilité avec refs, iframes comprises (`f7:ref_3`) ; `viewport` (partie visible), `diff` (changements seulement) ; recherche par texte ou `css:` |
| `wait_for` | Attendre un élément, un texte (présent ou disparu), une URL ou un réseau calme |
| `handle_dialog` | Répondre à une boîte alert / confirm / prompt qui bloque la page |
| `form_input` | Remplir un champ, select, checkbox par ref |
| `get_page_text`, `javascript` | Texte de la page ; évaluation JS |
| `read_console_messages`, `read_network_requests` | Console et réseau (capturés via CDP) |
| `save_image` | Enregistrer une image de la page (générée, illustration, canvas, svg) sur le disque |
| `file_upload` | Fichiers locaux vers `<input type=file>`, ou via le bouton qui ouvre le sélecteur (boîte de dialogue interceptée) |
| `resize_window` | Taille de la fenêtre |
| `gif_creator` | Enregistrement en GIF ou en vidéo WebM (Téléchargements/agent-browser-control/) |
| `network_intercept` | Bloquer, simuler (mock), modifier les en-têtes ou retarder des requêtes |
| `network_get_body` | Corps d'une réponse réseau |
| `read_websocket_messages` | Connexions WebSocket et leurs messages, y compris ceux des workers et iframes |
| `http_request` | Requête HTTP faite par l'extension (hors CSP/CORS de la page, sans cookies) |
| `storage` | Cookies, localStorage, sessionStorage (lecture / écriture) |
| `performance_metrics` | Web Vitals, poids de la page, mémoire, layout |
| `emulate` | Appareil mobile, réseau lent / hors ligne, CPU, thème, géolocalisation |
| `pdf` | Export PDF de la page |
| `browser_script` | Programme JS qui enchaîne des actions d'un seul tenant (boucles, audits), exécuté dans une sandbox sans réseau. **Désactivé par défaut** : à activer dans le panneau |

## Panneau latéral

Clic sur l'icône de l'extension : état de la connexion, **STOP** (coupe immédiatement tous les
agents et détache le debugger ; « Réarmer » pour réactiver), agents (un clic amène à leur groupe d'onglets), journal en direct filtrable par agent,
**scripts d'agent** (interrupteur de `browser_script`, désactivé par défaut) et **sites interdits** aux agents.
Ces réglages ne sont modifiables que depuis le panneau, jamais par un agent.

## Développement

```sh
npm run typecheck          # vérification TypeScript du serveur
npm run reload-extension   # recharge l'extension après modification de ses fichiers
node test/call.ts <outil> '<json>'   # appeler un outil comme un agent (images dans test/out/)
node test/smoke.ts  # test de bout en bout sans navigateur (fausse extension)
```

Exemple de script : `test/scripts/colle.js` (audit d'une colle Moodle, 32 actions en ~12 s) :

```sh
python -c "import json; print(json.dumps({'tabId': <id>, 'code': open('test/scripts/colle.js', encoding='utf-8').read()}))" > args.json
node test/call.ts browser_script "$(cat args.json)"
```
