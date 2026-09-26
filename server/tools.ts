import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const tabId = {
  type: "number",
  description: "Id de l'onglet ciblé (obtenu via tabs_context ou tabs_create).",
} as const;

/** Outils exposés aux agents. L'extension implémente chacun d'eux sous le même nom. */
export const TOOLS: Tool[] = [
  {
    name: "tabs_context",
    description:
      "Liste les onglets du groupe de l'agent (id, titre, URL). À appeler en début de session. " +
      "Si le groupe est vide, créer un onglet avec tabs_create.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tabs_create",
    description: "Ouvre un nouvel onglet dans le groupe de l'agent et renvoie son id.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL à ouvrir (défaut : about:blank)." },
        incognito: {
          type: "boolean",
          description: "Ouvrir en navigation privée (sans cookies ni session de l'utilisateur), dans un groupe « agent (privé) ».",
        },
      },
    },
  },
  {
    name: "tabs_close",
    description: "Ferme un onglet du groupe de l'agent.",
    inputSchema: { type: "object", properties: { tabId }, required: ["tabId"] },
  },
  {
    name: "navigate",
    description: "Navigue vers une URL, ou 'back' / 'forward' / 'reload'. Attend la fin du chargement.",
    inputSchema: {
      type: "object",
      properties: { tabId, url: { type: "string", description: "URL, 'back', 'forward' ou 'reload'." } },
      required: ["tabId", "url"],
    },
  },
  {
    name: "computer",
    description:
      "Interagit avec la page comme un utilisateur. Les coordonnées sont en pixels CSS du viewport, " +
      "identiques à celles de la capture 'screenshot'. Un élément peut aussi être ciblé par 'ref' (issu de read_page / find).\n" +
      "Actions : screenshot, left_click, right_click, double_click, triple_click, left_click_drag " +
      "(de start_coordinate vers coordinate), hover, type, key, scroll, scroll_to (ref), wait.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        action: {
          type: "string",
          enum: [
            "screenshot", "left_click", "right_click", "double_click", "triple_click", "left_click_drag",
            "hover", "type", "key", "scroll", "scroll_to", "wait",
          ],
        },
        coordinate: {
          type: "array", items: { type: "number" }, minItems: 2, maxItems: 2,
          description: "[x, y] en pixels CSS du viewport.",
        },
        start_coordinate: {
          type: "array", items: { type: "number" }, minItems: 2, maxItems: 2,
          description: "Pour 'left_click_drag' : point de départ [x, y].",
        },
        ref: {
          type: "string",
          description: "Référence d'élément issue de read_page / find (ex. 'ref_12', ou 'f7:ref_3' dans une iframe).",
        },
        text: {
          type: "string",
          description:
            "Pour 'type' : texte à saisir. Pour 'key' : touche(s) séparées par des espaces, " +
            "combinaisons avec '+' (ex. 'Enter', 'ctrl+a Backspace').",
        },
        modifiers: { type: "string", description: "Modificateurs pour les clics, ex. 'ctrl', 'shift+alt'." },
        scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
        scroll_amount: { type: "number", description: "Nombre de crans de molette (défaut 3)." },
        duration: { type: "number", description: "Pour 'wait' : durée en secondes (max 30)." },
      },
      required: ["tabId", "action"],
    },
  },
  {
    name: "read_page",
    description:
      "Renvoie l'arbre d'accessibilité de la page sous forme compacte, avec une 'ref' par élément " +
      "utilisable par computer. filter='interactive' ne garde que les éléments cliquables / éditables. " +
      "Le contenu des iframes suit, avec des refs préfixées ('f7:ref_3'). Pour économiser : viewport=true " +
      "(seulement la partie visible), diff=true (seulement ce qui a changé depuis la lecture précédente).",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        filter: { type: "string", enum: ["all", "interactive"], description: "Défaut : all." },
        ref: { type: "string", description: "Limiter l'arbre au sous-arbre de cet élément." },
        viewport: { type: "boolean", description: "Seulement les éléments visibles à l'écran." },
        diff: { type: "boolean", description: "Seulement les lignes ajoutées (+) ou retirées (-) depuis la dernière lecture avec les mêmes options." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "find",
    description:
      "Cherche des éléments de la page par texte (nom accessible, libellé, placeholder, valeur…) et renvoie " +
      "leurs refs. Préfixer par 'css:' pour un sélecteur CSS (ex. 'css:button.primary').",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        query: { type: "string", description: "Mots-clés (ex. 'bouton connexion') ou 'css:<sélecteur>'." },
        limit: { type: "number", description: "Nombre maximal de résultats (défaut 20)." },
      },
      required: ["tabId", "query"],
    },
  },
  {
    name: "form_input",
    description:
      "Définit directement la valeur d'un champ par ref : texte, select (valeur ou libellé de l'option), " +
      "checkbox / radio (true / false). Plus fiable que la saisie clavier pour les formulaires.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        ref: { type: "string" },
        value: { type: ["string", "number", "boolean"] },
      },
      required: ["tabId", "ref", "value"],
    },
  },
  {
    name: "get_page_text",
    description: "Renvoie le texte visible de la page (titre, URL, contenu principal).",
    inputSchema: { type: "object", properties: { tabId }, required: ["tabId"] },
  },
  {
    name: "javascript",
    description:
      "Évalue une expression JavaScript dans la page et renvoie le résultat sérialisé. " +
      "Les promesses sont attendues. Utiliser 'return' n'est pas nécessaire : la dernière expression est renvoyée.",
    inputSchema: {
      type: "object",
      properties: { tabId, code: { type: "string" } },
      required: ["tabId", "code"],
    },
  },
  {
    name: "read_console_messages",
    description:
      "Messages console de l'onglet (logs, avertissements, erreurs, exceptions non capturées). " +
      "La capture démarre quand l'agent commence à piloter l'onglet ; recharger la page pour tout capturer.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        pattern: { type: "string", description: "Filtre regex (insensible à la casse) sur le texte." },
        onlyErrors: { type: "boolean" },
        limit: { type: "number", description: "Nombre maximal de messages (défaut 100, les plus récents)." },
        clear: { type: "boolean", description: "Vider le tampon après lecture." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "read_network_requests",
    description: "Requêtes réseau de l'onglet (id, méthode, statut, type, URL). Le corps d'une réponse se lit avec network_get_body.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        urlPattern: { type: "string", description: "Filtre regex sur l'URL." },
        limit: { type: "number", description: "Nombre maximal de requêtes (défaut 100, les plus récentes)." },
        clear: { type: "boolean", description: "Vider le tampon après lecture." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "file_upload",
    description:
      "Charge des fichiers locaux. 'ref' peut viser un <input type=file>, ou le bouton / élément de menu " +
      "qui ouvre le sélecteur de fichiers (la boîte de dialogue native est interceptée, rien ne s'affiche).",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        ref: { type: "string" },
        paths: { type: "array", items: { type: "string" }, description: "Chemins absolus des fichiers." },
      },
      required: ["tabId", "ref", "paths"],
    },
  },
  {
    name: "resize_window",
    description: "Redimensionne la fenêtre contenant l'onglet (utile pour tester le responsive).",
    inputSchema: {
      type: "object",
      properties: { tabId, width: { type: "number" }, height: { type: "number" } },
      required: ["tabId", "width", "height"],
    },
  },
  {
    name: "gif_creator",
    description:
      "Enregistre un onglet en GIF animé ou en vidéo WebM. start_recording, puis agir normalement " +
      "(chaque action ajoute une image ; computer action='wait' capture une image par seconde, pour filmer " +
      "une vidéo ou une animation), stop_recording, puis export (fichier dans Téléchargements/agent-browser-control/). " +
      "Choisir format='webm' pour un fichier destiné à une IA : la plupart ne lisent que la première image d'un GIF, " +
      "mais analysent une vidéo en entier. L'export WebM prend environ la durée de l'enregistrement.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        action: { type: "string", enum: ["start_recording", "stop_recording", "export", "clear"] },
        format: { type: "string", enum: ["gif", "webm"], description: "Pour 'export' (défaut gif)." },
        quality: {
          type: "string",
          enum: ["haute", "standard"],
          description: "GIF : 'haute' (défaut, palette adaptée + tramage, pour un GIF à montrer) ou 'standard' (plus léger et rapide).",
        },
        maxWidth: { type: "number", description: "Largeur maximale en pixels (défaut 800 pour un GIF, 1280 en WebM ; max 1600)." },
        labels: { type: "boolean", description: "Légende de chaque action en bas à gauche (défaut true ; false pour une présentation)." },
        border: { type: "boolean", description: "Dessiner la bordure violette d'onglet piloté (défaut false ; true pour une démo)." },
        filename: { type: "string", description: "Pour 'export' : nom du fichier (optionnel)." },
      },
      required: ["tabId", "action"],
    },
  },
  {
    name: "network_intercept",
    description:
      "Intercepte les requêtes de l'onglet selon des règles : bloquer, simuler une réponse (mock), modifier " +
      "les en-têtes envoyés ou retarder. action='add' crée une règle (urlPattern en glob, ex. '*/api/users*'), " +
      "'list' les affiche avec leur nombre d'interceptions, 'remove' (ruleId) en supprime une, 'clear' les supprime toutes.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        action: { type: "string", enum: ["add", "list", "remove", "clear"] },
        urlPattern: { type: "string", description: "Glob sur l'URL complète, '*' = n'importe quoi." },
        method: { type: "string", description: "Limiter à une méthode HTTP (GET, POST…)." },
        effect: { type: "string", enum: ["block", "mock", "modify_headers", "delay"] },
        status: { type: "number", description: "mock : code HTTP (défaut 200)." },
        body: { description: "mock : corps de la réponse (texte, ou objet JSON)." },
        contentType: { type: "string", description: "mock : Content-Type (défaut application/json)." },
        headers: {
          type: "object",
          description: "mock : en-têtes de réponse ajoutés. modify_headers : en-têtes de requête à définir (null pour supprimer).",
        },
        delayMs: { type: "number", description: "delay : durée en ms (défaut 2000)." },
        ruleId: { type: "string", description: "remove : id de la règle (ex. 'rule_1')." },
      },
      required: ["tabId", "action"],
    },
  },
  {
    name: "network_get_body",
    description: "Renvoie le corps de la réponse d'une requête (id obtenu via read_network_requests). JSON indenté, binaire non affiché.",
    inputSchema: {
      type: "object",
      properties: { tabId, requestId: { type: "string" } },
      required: ["tabId", "requestId"],
    },
  },
  {
    name: "storage",
    description:
      "Lit ou modifie les cookies, le localStorage ou le sessionStorage du site ouvert dans l'onglet. " +
      "Attention : 'clear' sur les cookies déconnecte en général l'utilisateur du site.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        type: { type: "string", enum: ["cookies", "localStorage", "sessionStorage"] },
        action: { type: "string", enum: ["get", "set", "delete", "clear"] },
        name: { type: "string", description: "Nom du cookie ou clé. Pour 'get', omettre pour tout lister." },
        value: { type: "string" },
        domain: { type: "string", description: "Cookies : domaine (défaut : celui de la page)." },
        path: { type: "string" },
        secure: { type: "boolean" },
        httpOnly: { type: "boolean" },
        sameSite: { type: "string", enum: ["Strict", "Lax", "None"] },
        expires: { type: "number", description: "Cookies : expiration en secondes depuis l'epoch (omis = cookie de session)." },
      },
      required: ["tabId", "type", "action"],
    },
  },
  {
    name: "performance_metrics",
    description:
      "Mesure la performance de la page : Web Vitals (LCP, CLS, INP, FCP, TTFB) avec appréciation, temps de chargement, " +
      "poids par type de ressource, mémoire JS, nœuds DOM, temps de layout et de script.",
    inputSchema: { type: "object", properties: { tabId }, required: ["tabId"] },
  },
  {
    name: "emulate",
    description:
      "Émule un appareil (iphone-15, pixel-8, ipad, ou width/height), un réseau (offline, slow-3g, fast-3g, 4g, none), " +
      "un ralentissement CPU, un thème clair/sombre ou une position GPS. Plusieurs réglages combinables en un appel ; " +
      "reset=true annule tout. Les captures et les coordonnées suivent le viewport émulé.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        device: { type: "string", enum: ["iphone-15", "pixel-8", "ipad", "custom"] },
        width: { type: "number" },
        height: { type: "number" },
        mobile: { type: "boolean", description: "Pour un appareil personnalisé." },
        network: { type: "string", enum: ["offline", "slow-3g", "fast-3g", "4g", "none"] },
        cpuThrottling: { type: "number", description: "Facteur de ralentissement CPU (1 = normal, 4 = mobile moyen)." },
        colorScheme: { type: "string", enum: ["dark", "light", "none"] },
        geolocation: {
          type: "object",
          properties: { latitude: { type: "number" }, longitude: { type: "number" }, accuracy: { type: "number" } },
          required: ["latitude", "longitude"],
        },
        reset: { type: "boolean" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "pdf",
    description: "Exporte la page en PDF (fichier dans Téléchargements/agent-browser-control/).",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        filename: { type: "string" },
        landscape: { type: "boolean" },
        printBackground: { type: "boolean", description: "Inclure les arrière-plans (défaut true)." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "read_websocket_messages",
    description:
      "Connexions WebSocket de l'onglet et leurs messages (flux temps réel : prix, chat, notifications). " +
      "La capture commence quand l'agent prend l'onglet en main ; recharger la page pour voir les sockets ouverts au chargement.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        urlPattern: { type: "string", description: "Filtre regex sur l'URL du socket." },
        pattern: { type: "string", description: "Filtre regex sur le contenu des messages." },
        direction: { type: "string", enum: ["all", "received", "sent"] },
        limit: { type: "number", description: "Nombre maximal de messages (défaut 50, les plus récents)." },
        clear: { type: "boolean", description: "Vider le tampon après lecture." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "http_request",
    description:
      "Requête HTTP faite par l'extension, hors de toute page : pas de restriction CSP ni CORS. " +
      "Pour interroger une API publique qu'une page ne peut pas appeler. Envoyée sans cookies (pas au nom de l'utilisateur). " +
      "Réponse : statut, en-têtes principaux, corps (JSON indenté, tronqué à 50 000 caractères).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", description: "Défaut GET." },
        headers: { type: "object", description: "En-têtes de requête." },
        body: { description: "Corps : texte, ou objet envoyé en JSON." },
        timeoutMs: { type: "number", description: "Délai maximal (défaut 30 000, max 60 000)." },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_script",
    description:
      "(Disponible seulement si l'utilisateur l'a activé dans le panneau de l'extension.) " +
      "Exécute un programme JavaScript (async) qui enchaîne des actions dans le navigateur d'un seul tenant, " +
      "sans aller-retour avec le modèle : idéal pour les boucles et les vérifications en série (parcourir 20 pages, " +
      "relever un tableau sur chacune…). Le code tourne dans un bac à sable sans réseau ni API du navigateur : " +
      "il n'agit qu'à travers ces fonctions (toutes async sauf use/tab/log) :\n" +
      "- nav(url) : navigue l'onglet courant (ou 'back', 'forward', 'reload')\n" +
      "- text() : texte de la page · read(filter='interactive') : arbre avec refs · find(requête)\n" +
      "- click(ref ou [x, y]) · type(texte, ref?) · key('Enter') · fill(ref, valeur)\n" +
      "- js(code) : évalue du JS dans la page et renvoie la valeur (objets JSON compris ; 50 000 caractères max : " +
      "filtrer et résumer dans la page plutôt que tout renvoyer)\n" +
      "- shot() : joint une capture au résultat (5 max) · wait(secondes)\n" +
      "- waitFor({ selector | text | textGone | urlContains | networkIdle, timeout }) : attend une condition\n" +
      "- saveImage(ref?, nom?) : enregistre une image (la plus grande visible si pas de ref)\n" +
      "- dialog(accept, promptText?) : répond à une boîte alert / confirm / prompt\n" +
      "- use(tabId) : change d'onglet courant · tab() : onglet courant\n" +
      "- call(outil, args) : n'importe quel autre outil, renvoie { text, images, isError } sans lever d'erreur\n" +
      "- log(...) : ajoute une ligne au journal renvoyé\n" +
      "Les fonctions lèvent une erreur si l'outil échoue (utiliser try/catch). Passer le code de js() avec " +
      "String.raw`…` pour que les \\b, \\s, \\d des expressions régulières arrivent intacts dans la page. " +
      "La valeur renvoyée par `return` " +
      "(sérialisable en JSON) et le journal forment le résultat. Exemple :\n" +
      "const res = []; for (const id of [11, 12]) { await nav(`https://site/item/${id}`); " +
      "res.push(await js(`document.querySelector('h1').textContent`)); } return res;",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Corps d'une fonction async (peut utiliser await et return)." },
        tabId: { type: "number", description: "Onglet courant au départ (optionnel si le script appelle use())." },
        timeoutMs: { type: "number", description: "Durée maximale (défaut 120 000, max 280 000)." },
      },
      required: ["code"],
    },
  },
  {
    name: "wait_for",
    description:
      "Attend qu'une condition soit remplie plutôt qu'un nombre fixe de secondes : un élément visible (selector CSS), " +
      "un texte présent (text) ou disparu (textGone, ex. 'Chargement…'), une URL (urlContains), ou le réseau calme " +
      "(networkIdle: true = 500 ms sans requête, ou un nombre de ms). Conditions combinables ; timeout en secondes " +
      "(défaut 10, max 60). À utiliser après un envoi, un upload ou une navigation, avant l'action suivante.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        selector: { type: "string" },
        text: { type: "string" },
        textGone: { type: "string" },
        urlContains: { type: "string" },
        networkIdle: { type: ["boolean", "number"] },
        timeout: { type: "number" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "handle_dialog",
    description:
      "Répond à une boîte de dialogue JavaScript (alert, confirm, prompt, « quitter la page ? ») qui bloque l'onglet. " +
      "Les autres outils signalent quand une boîte est ouverte. accept=false pour Annuler ; promptText pour un prompt.",
    inputSchema: {
      type: "object",
      properties: { tabId, accept: { type: "boolean" }, promptText: { type: "string" } },
      required: ["tabId"],
    },
  },
  {
    name: "save_image",
    description:
      "Enregistre une image de la page sur le disque (Téléchargements/agent-browser-control/) : image générée " +
      "(Gemini…), illustration, schéma, graphique <canvas>, <svg>. Sans ref, prend la plus grande image visible à " +
      "l'écran. Fonctionne aussi pour les images réservées aux utilisateurs connectés (Moodle…). " +
      "show=true pour voir l'image enregistrée et vérifier que c'est la bonne.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        ref: { type: "string", description: "Image (ou élément qui en contient une), issue de read_page / find." },
        filename: { type: "string", description: "Nom du fichier sans extension (défaut : texte alternatif de l'image)." },
        show: { type: "boolean", description: "Renvoyer aussi l'image à l'agent (défaut false)." },
      },
      required: ["tabId"],
    },
  },
];
