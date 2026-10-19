// Agent Browser Control, service worker : réglages de l'utilisateur.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Réglages choisis par l'utilisateur dans le panneau (hors de portée des agents)
// ---------------------------------------------------------------------------

/** browser_script est activé par défaut ; l'utilisateur peut le désactiver dans le panneau. */
async function scriptsEnabled() {
  const { scriptsEnabled: enabled = true } = await chrome.storage.local.get("scriptsEnabled");
  return enabled !== false;
}

/** Le démon s'en sert pour retirer les outils désactivés de la liste que voient les agents. */
async function sendSettings() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: "settings",
    settings: { scriptsEnabled: await scriptsEnabled() },
    extensionVersion: chrome.runtime.getManifest().version,
    codeStale, // bg/connection.js : le code qui tourne n'est plus celui du disque
  }));
}

chrome.storage.local.onChanged.addListener((changes) => {
  if ("scriptsEnabled" in changes) sendSettings();
});
