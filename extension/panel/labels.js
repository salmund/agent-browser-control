// Ce que fait un agent, en mots de tous les jours. Le nom technique de l'outil
// reste visible dans le détail d'une ligne du journal.

const COMPUTER = {
  screenshot: "Capture l'écran",
  left_click: "Clique",
  right_click: "Fait un clic droit",
  double_click: "Double-clique",
  triple_click: "Triple-clique",
  left_click_drag: "Fait glisser",
  hover: "Survole",
  type: "Saisit du texte",
  key: "Appuie sur",
  scroll: "Fait défiler",
  scroll_to: "Fait défiler jusqu'à",
  wait: "Patiente",
  dismiss_consent: "Refuse les cookies",
};

const DEVTOOLS = {
  console: "Lit la console",
  network: "Lit le réseau",
  body: "Lit une réponse réseau",
  intercept: "Intercepte le réseau",
  storage: "Lit le stockage du site",
  perf: "Mesure les performances",
  emulate: "Émule un appareil",
  pdf: "Exporte la page en PDF",
  websocket: "Lit les WebSocket",
  http: "Envoie une requête HTTP",
  har: "Consulte l'enregistrement réseau",
  resize: "Redimensionne la fenêtre",
};

const TOOLS = {
  tabs_context: "Liste ses onglets",
  tabs_create: "Ouvre un onglet",
  tabs_close: "Ferme un onglet",
  tabs_cleanup: "Range ses onglets",
  history_search: "Cherche dans l'historique",
  site_api: "Consulte la mémoire du site",
  navigate: "Va sur",
  read_page: "Lit la structure de la page",
  find: "Cherche",
  scroll_extract: "Extrait une liste",
  query: "Extrait des éléments",
  read_tables: "Lit les tableaux",
  replay_paginated: "Rejoue une API paginée",
  form_input: "Remplit un formulaire",
  credentials_fill: "Remplit un identifiant",
  credentials_list: "Liste les secrets utilisables",
  get_page_text: "Lit le texte de la page",
  javascript: "Exécute du JavaScript",
  read_console_messages: "Lit la console",
  read_network_requests: "Lit le réseau",
  file_upload: "Envoie un fichier",
  resize_window: "Redimensionne la fenêtre",
  gif_creator: "Enregistre l'écran",
  network_intercept: "Intercepte le réseau",
  network_get_body: "Lit une réponse réseau",
  network_har: "Consulte l'enregistrement réseau",
  storage: "Lit le stockage du site",
  performance_metrics: "Mesure les performances",
  emulate: "Émule un appareil",
  pdf: "Exporte la page en PDF",
  read_websocket_messages: "Lit les WebSocket",
  browser_script: "Lance un script",
  wait_for: "Attend",
  save_image: "Enregistre une image",
  read_screen_text: "Lit l'écran (OCR)",
  download_media: "Télécharge un média",
  transcript: "Lit la transcription",
  downloads: "Gère les téléchargements",
  handle_dialog: "Répond à une boîte de dialogue",
  http_request: "Envoie une requête HTTP",
  ask_human: "Vous passe la main",
  demo: "Enregistre votre démonstration",
  watch: "Surveille une page",
  observe: "Repère les actions possibles",
  batch: "Enchaîne plusieurs outils",
  tab_snapshot: "Photographie l'onglet",
};

const NAVIGATE = { back: "Revient en arrière", forward: "Avance d'une page", reload: "Recharge la page" };

const SPECIAL_PAGES = { "chrome-extension:": "une page d'extension", "chrome:": "une page du navigateur", "file:": "un fichier local", "about:": "une page vide" };

/** Nom de domaine lisible d'une URL (sans www.), un libellé pour les pages internes, ou la chaîne telle quelle. */
export function hostOf(url) {
  try {
    const u = new URL(url);
    if (SPECIAL_PAGES[u.protocol]) return SPECIAL_PAGES[u.protocol];
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url ?? "";
  }
}

/**
 * Phrase courte pour une entrée du journal : { verb, target }.
 * `target` est ce sur quoi porte l'action (domaine, élément, recherche), ou "".
 */
export function describe(entry) {
  const { tool, action, target = "" } = entry;
  if (tool === "navigate") {
    if (NAVIGATE[target]) return { verb: NAVIGATE[target], target: "" };
    return { verb: TOOLS.navigate, target: hostOf(target) || target };
  }
  if (tool === "computer") {
    if (entry.steps) return { verb: `Enchaîne ${entry.steps} action${entry.steps > 1 ? "s" : ""}`, target: "" };
    return { verb: COMPUTER[action] ?? "Agit sur la page", target };
  }
  if (tool === "devtools") return { verb: DEVTOOLS[action] ?? "Ouvre les DevTools", target };
  if (tool === "gif_creator") {
    const verb = { start: "Démarre l'enregistrement", stop: "Arrête l'enregistrement", export: "Exporte l'enregistrement" }[action];
    return { verb: verb ?? TOOLS.gif_creator, target: "" };
  }
  if (tool === "tabs_create" && target) return { verb: TOOLS.tabs_create, target: hostOf(target) };
  if (tool === "browser_script" && target) return { verb: "Lance la fonction", target };
  return { verb: TOOLS[tool] ?? tool.replace(/_/g, " "), target };
}

/** Durée courte : « 78 ms », « 1,1 s », « 2 min 05 ». */
export function duration(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")}`;
}

/** « à l'instant », « il y a 3 min », « il y a 2 h ». */
export function ago(t, now = Date.now()) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  return `il y a ${Math.round(m / 60)} h`;
}
