import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const tabId = {
  type: "number",
  description: "Id de l'onglet ciblé (obtenu via tabs_context ou tabs_create).",
} as const;

const label = {
  type: "string",
  description:
    "Sous-agent : nom court (« recherche-2 », « prix »). À donner quand plusieurs agents travaillent en parallèle " +
    "avec la même connexion (sous-agents d'un workflow) : chacun a alors son groupe « agent · label », sa pastille " +
    "et son fil dans le journal. Sans label, on travaille dans le groupe de l'agent.",
} as const;

/** Outils exposés aux agents. L'extension implémente chacun d'eux sous le même nom. */
export const TOOLS: Tool[] = [
  {
    name: "tabs_context",
    description:
      "Liste les onglets du groupe de l'agent (id, titre, URL). À appeler en début de session. " +
      "Si le groupe est vide, créer un onglet avec tabs_create. " +
      "Sans label, liste aussi ceux des sous-agents (avec leur label entre crochets) ; avec label, seulement les siens. " +
      "Chaque onglet indique son inactivité (inactif depuis X, épinglé, son en cours) ; tabs_cleanup ferme les inactifs.",
    inputSchema: { type: "object", properties: { label } },
  },
  {
    name: "tabs_create",
    description:
      "Ouvre un nouvel onglet dans le groupe de l'agent (ou de son sous-agent, avec label) et renvoie son id. " +
      "Ne travailler que sur les onglets qu'on a soi-même créés.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL à ouvrir (défaut : about:blank)." },
        incognito: {
          type: "boolean",
          description: "Ouvrir en navigation privée (sans cookies ni session de l'utilisateur), dans un groupe « agent (privé) ».",
        },
        label,
      },
    },
  },
  {
    name: "tabs_close",
    description: "Ferme un onglet du groupe de l'agent.",
    inputSchema: { type: "object", properties: { tabId }, required: ["tabId"] },
  },
  {
    name: "tabs_cleanup",
    description:
      "Ferme les onglets inactifs du groupe de l'agent (ou d'un sous-agent, avec label). Protégés par défaut : " +
      "onglet actif, épinglé, avec du son, ou d'activité inconnue (on ne ferme jamais à l'aveugle). " +
      "dryRun: true ne ferme rien, liste seulement ce qui serait fermé. " +
      "Consulter tabs_context (âge de chaque onglet) pour choisir olderThanMinutes.",
    inputSchema: {
      type: "object",
      properties: {
        label,
        olderThanMinutes: {
          type: "number",
          description: "Inactivité minimale en minutes pour fermer (défaut 60).",
        },
        keepActive: { type: "boolean", description: "Garder l'onglet actif (défaut true)." },
        keepPinned: { type: "boolean", description: "Garder les onglets épinglés (défaut true)." },
        keepAudible: { type: "boolean", description: "Garder les onglets avec du son (défaut true)." },
        dryRun: {
          type: "boolean",
          description: "True : ne rien fermer, lister seulement ce qui serait fermé.",
        },
      },
    },
  },
  {
    name: "history_search",
    description:
      "Retrouve une page déjà visitée (titre, URL, âge, visites) au lieu de rouvrir un doublon : " +
      "requête vide = pages récentes. Les sites interdits sont exclus (comptés, pas listés).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Texte cherché (titre / URL). Vide : les pages récentes.",
        },
        limit: { type: "number", description: "Résultats au plus (défaut 20, max 50)." },
        days: { type: "number", description: "Fenêtre en jours (défaut 30, max 365)." },
      },
    },
  },
  {
    name: "navigate",
    description:
      "Navigue vers une URL, ou 'back' / 'forward' / 'reload'. Attend la fin du chargement. " +
      "Dans une SPA (Discord…) : naviguer par clic (find + ref) quand la cible est même origine, pas par URL — " +
      "navigate recharge tout le client (auth, gateway) quand un clic ne fait qu'un appel XHR.",
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
        path: {
          type: "array",
          items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          description:
            "Pour 'left_click_drag' : tracé [[x, y], …] parcouru d'un seul geste, bouton maintenu (dessin, courbe, " +
            "signature). Remplace start_coordinate / coordinate.",
        },
        ref: {
          type: "string",
          description: "Référence d'élément issue de read_page / find (ex. 'ref_12', ou 'f7:ref_3' dans une iframe).",
        },
        text: {
          type: "string",
          description:
            "Pour 'type' : texte à saisir, même long (plus sûr que copier-coller : le presse-papiers est partagé avec " +
            "l'utilisateur). Pour 'key' : touche(s) séparées par des espaces, " +
            "combinaisons avec '+' (ex. 'Enter', 'ctrl+a Backspace').",
        },
        modifiers: { type: "string", description: "Modificateurs pour les clics, ex. 'ctrl', 'shift+alt'." },
        scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
        scroll_amount: { type: "number", description: "Nombre de crans de molette (défaut 3)." },
        duration: { type: "number", description: "Pour 'wait' : durée en secondes (max 30)." },
        scale: {
          type: "number",
          description: "Pour 'screenshot' : réduit l'image (0,2 à 1). Une capture coûte cher : 0,5 suffit souvent pour voir la mise en page.",
        },
        region: {
          type: "array", items: { type: "number" }, minItems: 4, maxItems: 4,
          description: "Pour 'screenshot' : [x0, y0, x1, y1] en pixels CSS, zoom net sur une zone (lire un petit texte, vérifier un détail).",
        },
        refs: {
          type: "boolean",
          description: "Pour 'screenshot' : numérote les éléments interactifs (pastilles violettes = refs cliquables, légende fournie ; main frame, 30 au plus).",
        },
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
      "leurs refs. Préfixer par 'css:' pour un sélecteur CSS (ex. 'css:button.primary'). " +
      "scan: true balaye les conteneurs défilants (listes virtualisées : les lignes hors écran n'existent pas " +
      "dans le DOM) avant de conclure ; plus lent, positions restaurées.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        query: { type: "string", description: "Mots-clés (ex. 'bouton connexion') ou 'css:<sélecteur>'." },
        limit: { type: "number", description: "Nombre maximal de résultats (défaut 20)." },
        scan: { type: "boolean", description: "True : balayer les listes virtualisées (plus lent)." },
      },
      required: ["tabId", "query"],
    },
  },
  {
    name: "form_input",
    description:
      "Définit directement la valeur d'un champ par ref : texte, select (valeur ou libellé de l'option), " +
      "checkbox / radio (true / false). Permet aussi la saisie groupée via 'fields' (liste de {ref, value}) " +
      "avec validation optionnelle par un clic sur 'submitRef' en un seul appel (ex. formulaire complet + validation).",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        ref: { type: "string", description: "Champ unique à renseigner (si fields n'est pas utilisé)." },
        value: { type: ["string", "number", "boolean"], description: "Valeur pour le champ unique." },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string" },
              value: { type: ["string", "number", "boolean"] },
            },
            required: ["ref", "value"],
          },
          description: "Liste de champs à renseigner d'un coup (ex. [{ref: 'ref_1', value: 'mon sujet'}, {ref: 'ref_2', value: 'mon message'}]).",
        },
        submitRef: {
          type: "string",
          description: "Ref du bouton de validation / soumission à cliquer automatiquement après avoir rempli les champs.",
        },
      },
      required: ["tabId"],
    },
  },
  {
    name: "credentials_fill",
    description:
      "Remplit des champs d'authentification SANS connaître leurs valeurs : l'utilisateur a déposé ses secrets " +
      "dans le coffre de l'extension (panneau latéral, section Secrets), et tu ne manipules que des références " +
      "opaques (slot ids). La valeur ne transite jamais par MCP et n'est jamais recopiée dans le résultat. " +
      "Chaque slot est limité à ses sites ; sauf slot « toujours autoriser », l'utilisateur approuve chaque " +
      "utilisation dans le panneau (75 s, sinon refus). Ne jamais demander ni saisir un mot de passe " +
      "directement : si aucun slot ne convient, demander à l'utilisateur en quoi remplir, pas la valeur.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        fills: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string", description: "Champ à remplir (ref issue de read_page / find)." },
              slot: { type: "string", description: "Identifiant du secret (slot), ex. « sso-rouen »." },
              use: { type: "string", enum: ["login"], description: "Si « login », remplit l'identifiant en clair du slot ; sinon remplit le secret (aveugle)." },
            },
            required: ["ref", "slot"],
          },
          description: "Champs à remplir (ex. [{ref: 'ref_3', slot: 'sso-user'}, {ref: 'ref_4', slot: 'sso-pass'}]).",
        },
        submitRef: {
          type: "string",
          description: "Ref du bouton de connexion à cliquer après remplissage.",
        },
      },
      required: ["tabId", "fills"],
    },
  },
  {
    name: "credentials_list",
    description:
      "Liste les slots du coffre (métadonnées uniquement : identifiant, nom, sites autorisés, politique). " +
      "Jamais de valeurs : fonctionne même coffre verrouillé. À appeler avant credentials_fill pour trouver " +
      "seul le bon slot, sans demander à l'utilisateur.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
      },
      required: [],
    },
  },
  {
    name: "get_page_text",
    description:
      "Renvoie le texte visible de la page (titre, URL, contenu principal). Si la page est dessinée dans un <canvas> " +
      "(Google Docs, Sheets, Slides, éditeurs…), va chercher le texte ailleurs : export de l'application quand il existe " +
      "(texte exact), sinon lecture de l'écran par OCR.",
    inputSchema: { type: "object", properties: { tabId }, required: ["tabId"] },
  },
  {
    name: "javascript",
    description:
      "Évalue une expression JavaScript dans la page et renvoie le résultat sérialisé. " +
      "Les promesses sont attendues. Utiliser 'return' n'est pas nécessaire : la dernière expression est renvoyée. " +
      "Un 'return' de premier niveau est accepté (le code est alors exécuté dans une fonction async).",
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
    name: "site_api",
    description:
      "Mémoire par site pour aller vite sans redécouvrir : 'list' montre les routes directes et les appels " +
      "enregistrés (noms, méthode, chemin, params — jamais de secrets) ; 'save_call' mémorise une requête du HAR " +
      "(tabId + requestId de network_har list, nom optionnel ; réenregistrer sous le même nom met à jour quand " +
      "le site change) ; 'save_route' mémorise un deep link (nom + URL sans jeton) ; 'delete' (site, nom, kind) " +
      "retire un appel, une route ou une note périmée. 'note' ajoute une ligne au playbook du site " +
      "(comment il se comporte ; servi automatiquement à l'arrivée : navigate, tabs_context). " +
      "Prochaine visite : list, puis navigate vers une route ou " +
      "http_request pour rejouer un appel, au lieu de tout redécouvrir en cliquant.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "save_call", "save_route", "note", "delete"],
          description: "Défaut : list.",
        },
        tabId,
        requestId: { type: "string", description: "save_call : l'id de la requête (colonne id de network_har list)." },
        saved: { type: "string", description: "save_call : enregistrement gardé au lieu de l'onglet (nom de network_har saved)." },
        name: { type: "string", description: "save_call/save_route/delete : nom mémorisé (défaut save_call : MÉTHODE chemin)." },
        url: { type: "string", description: "save_route : deep link à mémoriser (sans jeton ni session)." },
        site: { type: "string", description: "save_route/delete : site (défaut : hôte de l'URL ou de la requête)." },
        kind: { type: "string", enum: ["call", "route", "note"], description: "delete : appel, route ou note (défaut call)." },
        text: { type: "string", description: "note : ligne du playbook (1 à 3 par visite ; site dérivé de l'onglet sans 'site')." },
      },
    },
  },
  {
    name: "network_har",
    description:
      "Enregistrement réseau persistant des onglets de l'agent (HAR) : chaque requête, avec ses en-têtes et le " +
      "corps des réponses de données (XHR, fetch, document ; 2 Mo max), est écrite sur disque par le démon. Il survit " +
      "au rechargement de l'extension et à la navigation : étudier un parcours de plusieurs pages après coup, " +
      "retrouver un corps disparu, re-dériver un client quand un site change. Une fois le bon appel identifié, " +
      "site_api save_call le mémorise (méthode, chemin, params) pour rejouer vite la prochaine fois. " +
      "action : 'status' (défaut), 'list' (urlPattern, limit), 'body' (requestId), 'bodies' (derniers corps par " +
      "motif, résumés : la lecture des SPA dont le DOM ne montre rien), 'export' (fichier HAR 1.2 " +
      "dans Téléchargements, secrets masqués ; " +
      "secrets: true seulement si l'utilisateur le demande), 'keep' (garder après la fermeture de l'onglet, label), " +
      "'clear' (avec saved : supprime un enregistrement gardé), 'saved' (enregistrements gardés, à relire avec le " +
      "paramètre saved). Supprimé à la fermeture de " +
      "l'onglet sauf keep. network_get_body et read_network_requests s'en servent déjà seuls après un rechargement.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        action: { type: "string", enum: ["status", "list", "body", "bodies", "export", "keep", "clear", "saved"] },
        requestId: { type: "string", description: "body : l'id de la requête (colonne id de list)." },
        urlPattern: { type: "string", description: "list : expression régulière sur l'URL." },
        limit: { type: "number", description: "list : nombre maximum de requêtes (défaut 100, les plus récentes)." },
        name: { type: "string", description: "export : nom du fichier .har." },
        secrets: { type: "boolean", description: "export : garder cookies et jetons en clair (défaut false)." },
        keep: { type: "boolean", description: "keep : true pour garder à la fermeture (défaut), false pour annuler." },
        label: { type: "string", description: "keep : nom lisible de l'enregistrement gardé." },
        saved: { type: "string", description: "list, body, export : lire un enregistrement gardé (nom donné par action='saved')." },
      },
      required: ["tabId"],
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
      "Connexions WebSocket de l'onglet et leurs messages (flux temps réel : prix, chat, notifications ; " +
      "jetons et secrets masqués comme dans le HAR). " +
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
      "un texte présent (text) ou disparu (textGone, ex. 'Chargement…'), une URL (urlContains), le réseau calme " +
      "(networkIdle: true = 500 ms sans requête, ou un nombre de ms), le DOM stabilisé " +
      "(domSettled: true = 800 ms sans mutation DOM, ou un nombre de ms pour attendre la fin d'un streaming ou d'une transition ; " +
      "sans effet sur les applis temps réel aux mutations permanentes : préférer text / selector / networkIdle), " +
      "ou la fin d'une authentification (authSettled: true attend la validation d'une connexion / redirection hors login). " +
      "Conditions combinables ; timeout en secondes (défaut 10, max 60, jusqu'à 300 pour authSettled).",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        selector: { type: "string" },
        text: { type: "string" },
        textGone: { type: "string" },
        urlContains: { type: "string" },
        networkIdle: { type: ["boolean", "number"] },
        domSettled: {
          type: ["boolean", "number"],
          description: "Attendre que le DOM soit stable (aucune mutation) pendant N ms (défaut 800 si true). Idéal pour streaming d'IA ou formulaires dynamiques.",
        },
        authSettled: {
          type: "boolean",
          description: "Attendre que l'utilisateur ait fini de se connecter (redirection hors page de login / SSO / captcha).",
        },
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
  {
    name: "read_screen_text",
    description:
      "Lit le texte affiché à l'écran par reconnaissance de caractères (OCR locale, Windows), avec le centre de chaque " +
      "ligne en pixels CSS pour pouvoir cliquer dessus. Pour les pages dessinées dans un <canvas> (logiciels de dessin, " +
      "Figma, jeux, visionneuses PDF), les images, tout ce que read_page ne voit pas. region [x0, y0, x1, y1] pour une zone. " +
      "Lecture approximative ; bien moins coûteux qu'une capture d'écran pour un modèle.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "[x0, y0, x1, y1] en pixels CSS." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "download_media",
    description:
      "Télécharge la vidéo ou l'audio d'une page (YouTube, Vimeo, SoundCloud, podcasts, sites de cours… : tout ce que " +
      "gère yt-dlp) dans Téléchargements/agent-browser-control/. url, ou tabId pour la page de l'onglet. " +
      "action='info' d'abord pour voir titre, durée, qualités et sous-titres sans rien télécharger. " +
      "mode='audio' pour l'audio seul (mp3 par défaut). subtitles=true récupère aussi les sous-titres en .srt. " +
      "Pour lire, résumer ou prendre des notes sur une vidéo YouTube, ne rien télécharger : utiliser transcript. Au-delà de 4 minutes, le téléchargement continue en " +
      "arrière-plan : action='status' avec le jobId pour le suivre. Ne télécharger que ce que l'utilisateur a le " +
      "droit de conserver (ses contenus, licences libres, cours auxquels il a accès) et dans le respect des sites.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        tabId,
        action: { type: "string", enum: ["download", "info", "status"], description: "Défaut download." },
        mode: {
          type: "string",
          enum: ["video", "audio", "subtitles"],
          description: "Défaut video. 'subtitles' : seulement les sous-titres (.srt), sans télécharger la vidéo.",
        },
        quality: { type: "number", description: "Vidéo : hauteur maximale (1080, 720, 480…). Défaut : la meilleure." },
        audioFormat: { type: "string", enum: ["mp3", "m4a", "opus", "wav"], description: "Audio : défaut mp3." },
        subtitles: { type: "boolean", description: "Récupérer aussi les sous-titres (fr, en) en .srt." },
        playlist: { type: "boolean", description: "Toute la playlist si l'URL en désigne une (défaut false)." },
        jobId: { type: "string", description: "status : le téléchargement à suivre (sans jobId : tous)." },
      },
    },
  },
  {
    name: "transcript",
    description:
      "Le texte d'une vidéo YouTube ouverte dans l'onglet (sous-titres, sinon sous-titres automatiques), en paragraphes " +
      "d'environ 30 s repérés par leur minutage [m:ss]. Rien n'est téléchargé : c'est l'outil pour lire, résumer ou " +
      "prendre des notes sur une vidéo. Lu dans la page comme le fait le lecteur, donc sans les refus (HTTP 429) " +
      "de download_media. Par défaut dans la langue parlée ; lang pour une autre piste, translate pour une traduction " +
      "automatique par YouTube. start / end pour un passage (« 12:30 »).",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        lang: { type: "string", description: "Piste de sous-titres (fr, en…). Défaut : la langue parlée dans la vidéo." },
        translate: { type: "string", description: "Traduire les sous-titres dans cette langue (fr…)." },
        start: { type: "string", description: "Début du passage : « 754 », « 12:34 » ou « 1:02:03 »." },
        end: { type: "string", description: "Fin du passage, même format." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "downloads",
    description:
      "Fichiers téléchargés depuis les pages. action='download' : télécharge un fichier (url, ou ref d'un lien avec " +
      "tabId) avec la session de l'utilisateur (PDF d'un cours réservé aux inscrits…) et attend la fin. action='wait' : " +
      "après un clic qui déclenche un téléchargement, attend qu'il soit terminé. action='list' : les téléchargements " +
      "de l'agent. Renvoie le chemin du fichier, à passer à read_document.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["download", "wait", "list"] },
        tabId,
        url: { type: "string" },
        ref: { type: "string", description: "Lien (ou élément qui en contient un) issu de read_page / find." },
        filename: {
          type: "string",
          description: "download : nom souhaité (certains navigateurs l'ignorent : se fier au chemin renvoyé).",
        },
        timeout: { type: "number", description: "Secondes d'attente (défaut 60, max 280)." },
      },
      required: ["action"],
    },
  },
  {
    name: "read_document",
    description:
      "Texte d'un document du dossier Téléchargements : PDF (pages scannées lues par OCR), Word (.docx), " +
      "PowerPoint (.pptx), Excel (.xlsx), fichiers texte (.txt, .md, .csv, .srt, .html…). path : le chemin renvoyé par " +
      "downloads (ou un nom de fichier). pages : « 3 », « 2-5 », « 1,4 » pour une partie (défaut : tout, 60 000 " +
      "caractères au plus, la suite est indiquée).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        pages: { type: "string" },
      },
      required: ["path"],
    },
  },
];
