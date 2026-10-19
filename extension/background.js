// Service worker Agent Browser Control.
// Se connecte au démon local et exécute les outils demandés par les agents.
// Le code est découpé par domaine dans bg/ : scripts classiques qui partagent la portée globale,
// chargés dans cet ordre (les définitions d'abord, la table des outils et la connexion à la fin).
// bg/connection.js tire de cette liste l'empreinte du code chargé (rechargement quand le disque a changé).

const SW_SCRIPTS = [
  "gif.js", "annotate.js", "devtools.js", "wait-diag.js", "js-eval.js", "tab-hygiene.js", "history.js", "ws-mask.js",
  "bg/base.js",
  "bg/stop.js",
  "bg/activity.js",
  "bg/blocklist.js",
  "bg/tabs.js",
  "bg/navigation.js",
  "bg/cdp.js",
  "bg/network.js",
  "bg/page-bridge.js",
  "bg/reading.js",
  "bg/capture.js",
  "bg/input.js",
  "bg/pointer.js",
  "bg/foreground.js",
  "bg/computer.js",
  "bg/javascript.js",
  "bg/recording.js",
  "bg/scripts.js",
  "bg/settings.js",
  "bg/wait.js",
  "bg/media.js",
  "bg/downloads.js",
  "bg/credentials.js",
  "bg/ask.js", "bg/messages.js", "bg/relay.js",
  "bg/demo.js",
  "bg/dispatch.js",
  "bg/connection.js",
];
importScripts(...SW_SCRIPTS);
