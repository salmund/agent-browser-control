// Vue Secrets : coffre intégré (credentials_fill) et coffre de l'utilisateur (Vaultwarden, Bitwarden).
// Les valeurs en clair n'existent que chiffrées dans chrome.storage.local. La phrase
// secrète ne sort jamais de ce panneau ; seule la clé dérivée (opaque) est transmise
// au service worker pour la session du navigateur. Les demandes d'approbation
// s'affichent dans la vue Activité (elles sont urgentes).

import { $, el, iconButton, send, toast } from "./dom.js";

const Crypto = globalThis.AbcSlotsCrypto;
const CRED_FORMAT = "abc-credentials-v1";
let credKey = null;
let credStore = null;
let bwSelected = null; // { itemId, itemName } choisi dans les résultats de recherche
let bwUnlocked = false;

const slotIdOk = (id) => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
const isExternal = (slot) => !!slot?.external && slot.external.provider === "bitwarden" && typeof slot.external.itemId === "string" && !!slot.external.itemId;
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function showError(id, message) {
  $(id).textContent = message ?? "";
  $(id).hidden = !message;
}

async function loadStore() {
  const { credSlots } = await chrome.storage.local.get("credSlots");
  credStore = credSlots?.format === CRED_FORMAT ? credSlots : null;
  return credStore;
}

// --- Coffre et liste des secrets -------------------------------------------------------------

function renderSlotRow(slot) {
  const li = el("li", "slot");
  const head = el("div", "slot-head");
  head.append(el("span", "slot-name", slot.label || slot.id), el("span", "slot-id", slot.id));
  head.append(iconButton("trash", `Supprimer le secret ${slot.id}`, () => revokeSlot(slot.id), "icon-button danger"));
  li.append(head);
  const where = (slot.hosts ?? []).join(", ");
  const source = isExternal(slot) ? `Bitwarden : ${slot.external.itemName ?? slot.external.itemId}` : slot.login ? `identifiant ${slot.login}` : "coffre intégré";
  li.append(el("p", "slot-meta", `${where || "aucun site"} (${source})`));
  const policy = el("select");
  policy.setAttribute("aria-label", `Utilisation du secret ${slot.id}`);
  for (const [value, label] of [["ask", "Me demander à chaque fois"], ["always", "Toujours autoriser"]]) {
    const opt = el("option", null, label);
    opt.value = value;
    policy.append(opt);
  }
  policy.value = slot.policy === "always" ? "always" : "ask";
  policy.addEventListener("change", () => setSlotPolicy(slot.id, policy.value));
  const wrap = el("div", "slot-policy");
  wrap.append(policy);
  li.append(wrap);
  return li;
}

function renderSecrets() {
  const locked = !credKey;
  const exists = !!credStore?.verifier;
  $("secrets-state").dataset.on = String(!locked);
  $("secrets-state").textContent = locked ? (exists ? "verrouillé" : "pas encore créé") : "déverrouillé";
  $("unlock-form").hidden = !locked;
  $("unlock-hint").hidden = !locked || exists;
  $("unlock-input").placeholder = exists ? "Phrase secrète du coffre" : "Choisir une phrase secrète";
  $("unlock-form").querySelector("button").textContent = exists ? "Déverrouiller" : "Créer le coffre";
  $("lock-button").hidden = locked;
  const slots = Object.values(credStore?.slots ?? {});
  $("slots-empty").hidden = slots.length > 0;
  $("slots").replaceChildren(...slots.map(renderSlotRow));
}

$("unlock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("unlock-error", "");
  const pass = $("unlock-input").value;
  $("unlock-input").value = "";
  if (!pass) return;
  try {
    await loadStore();
    let key;
    if (!credStore?.verifier) {
      // Premier usage : la phrase choisie crée le coffre (jamais stockée). Les slots Bitwarden sont gardés.
      if (pass.length < 8) throw new Error("Phrase trop courte : 8 caractères au moins pour créer le coffre.");
      const salt = Crypto.newSalt();
      key = await Crypto.deriveKey(pass, b64ToBytes(salt));
      const verifier = await Crypto.encryptWithKey(key, Crypto.VERIFIER_TEXT);
      credStore = { format: CRED_FORMAT, salt, verifier, slots: credStore?.slots ?? {} };
      await chrome.storage.local.set({ credSlots: credStore });
    } else {
      key = await Crypto.deriveKey(pass, b64ToBytes(credStore.salt));
      const check = await Crypto.decryptWithKey(key, credStore.verifier.iv, credStore.verifier.data).catch(() => null);
      if (check !== Crypto.VERIFIER_TEXT) throw new Error("Phrase secrète incorrecte.");
    }
    credKey = key;
    const res = await send({ type: "credentials-unlock", dek: await Crypto.exportRawKey(key) });
    if (res && res.ok === false) throw new Error(res.error);
    renderSecrets();
  } catch (err) {
    credKey = null;
    showError("unlock-error", err?.message ?? String(err));
  }
});

$("lock-button").addEventListener("click", async () => {
  credKey = null;
  await send({ type: "credentials-lock" });
  renderSecrets();
});

async function revokeSlot(id) {
  const { credApprovals = [] } = await chrome.storage.session.get("credApprovals");
  for (const a of credApprovals.filter((x) => x.slotId === id)) await send({ type: "credential-decision", id: a.id, decision: "deny" });
  const store = (await loadStore()) ?? credStore;
  if (store?.slots[id]) {
    delete store.slots[id];
    await chrome.storage.local.set({ credSlots: store });
    credStore = store;
  }
  renderSecrets();
  toast(`Secret ${id} supprimé`);
}

async function setSlotPolicy(id, policy) {
  const store = (await loadStore()) ?? credStore;
  const slot = store?.slots[id];
  if (!slot) return;
  slot.policy = policy === "always" ? "always" : "ask";
  await chrome.storage.local.set({ credSlots: store });
  credStore = store;
  renderSecrets();
}

// --- Ajout d'un secret ------------------------------------------------------------------------

function renderHostsPreview() {
  const { hosts, ignored } = Crypto.extractHosts($("slot-hosts").value);
  $("slot-hosts-preview").replaceChildren(
    ...hosts.map((h) => el("span", "token", h)),
    ...ignored.map((bad) => el("span", "token ignored", bad)),
  );
}

function renderSlotSource() {
  const fromBw = $("slot-source").value === "bitwarden";
  $("slot-login-label").hidden = fromBw;
  $("slot-secret-label").hidden = fromBw;
  $("slot-bw-box").hidden = !fromBw;
}

$("slot-source").addEventListener("change", () => {
  bwSelected = null;
  $("slot-secret").value = "";
  $("slot-bw-results").replaceChildren();
  showError("slot-bw-error", "");
  renderSlotSource();
});

// Le nom technique se déduit du nom affiché tant qu'on ne l'a pas saisi soi-même.
let slotIdTouched = false;
$("slot-id").addEventListener("input", () => (slotIdTouched = $("slot-id").value.trim() !== ""));
$("slot-label").addEventListener("input", () => {
  if (slotIdTouched) return;
  $("slot-id").value = $("slot-label").value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
});

$("slot-hosts").addEventListener("input", renderHostsPreview);

$("slot-current-site").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const host = tab?.url?.startsWith("http") ? new URL(tab.url).hostname.toLowerCase() : "";
  if (!host) return toast("L'onglet affiché n'est pas une page web");
  const field = $("slot-hosts");
  const cur = field.value.trim();
  if (!Crypto.extractHosts(cur).hosts.includes(host)) field.value = cur ? `${cur} ${host}` : host;
  renderHostsPreview();
  field.focus();
});

$("slot-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("slot-error", "");
  try {
    const fromBw = $("slot-source").value === "bitwarden";
    if (!fromBw && !credKey) throw new Error("Coffre verrouillé : déverrouillez-le plus haut, ou choisissez la source Bitwarden.");
    if (!fromBw && !(credKey instanceof CryptoKey)) {
      // Coffre ouvert dans une session précédente du panneau : la clé n'est que dans le service worker.
      credKey = null;
      renderSecrets();
      throw new Error("Pour chiffrer un nouveau secret, saisissez de nouveau la phrase du coffre (plus haut).");
    }
    const id = $("slot-id").value.trim().toLowerCase();
    const label = $("slot-label").value.trim() || id;
    const hosts = Crypto.extractHosts($("slot-hosts").value).hosts;
    if (!slotIdOk(id)) throw new Error("Nom technique invalide : minuscules, chiffres et tirets (ex. sso-rouen).");
    if (!hosts.length) throw new Error("Indiquez au moins un site autorisé (ex. univ-rouen.fr).");
    let store = await loadStore();
    if (!store) {
      if (!fromBw) throw new Error("Coffre introuvable : créez-le d'abord avec une phrase secrète.");
      store = { format: CRED_FORMAT, salt: "", verifier: null, slots: {} };
    }
    if (store.slots[id]) throw new Error(`Un secret « ${id} » existe déjà : supprimez-le d'abord pour le remplacer.`);
    const policy = $("slot-policy").value === "always" ? "always" : "ask";
    if (fromBw) {
      if (!bwSelected) throw new Error("Choisissez un élément Bitwarden (recherche ci-dessus).");
      store.slots[id] = {
        id, label, hosts, policy, created: new Date().toISOString(),
        external: { provider: "bitwarden", itemId: bwSelected.itemId, itemName: bwSelected.itemName },
      };
    } else {
      const login = $("slot-login").value.trim();
      const secret = $("slot-secret").value;
      $("slot-secret").value = "";
      if (!secret) throw new Error("Mot de passe vide.");
      const enc = await Crypto.encryptWithKey(credKey, secret);
      store.slots[id] = { id, label, login: login || undefined, hosts, policy, created: new Date().toISOString(), iv: enc.iv, data: enc.data };
    }
    await chrome.storage.local.set({ credSlots: store });
    credStore = store;
    for (const f of ["slot-id", "slot-label", "slot-hosts", "slot-login", "slot-bw-search"]) $(f).value = "";
    slotIdTouched = false;
    bwSelected = null;
    $("slot-bw-results").replaceChildren();
    renderHostsPreview();
    renderSecrets();
    $("add-slot").open = false;
    toast(`Secret ${id} enregistré`);
  } catch (err) {
    showError("slot-error", err?.message ?? String(err));
  }
});

// --- Coffre de l'utilisateur (Vaultwarden, Bitwarden) ------------------------------------------
// Le démon pilote le CLI `bw` dans un profil réservé à ABC. Le mot de passe maître transite seulement
// vers le démon (WebSocket local), sert une fois à `bw login` ou `bw unlock`, et la clé de session reste
// en mémoire du démon. L'adresse du serveur et l'e-mail (pas secrets) sont gardés pour la prochaine fois.

let bwServerChecked = ""; // dernière adresse vérifiée (bw-probe) avec succès

async function savedBwServer() {
  const { bwServer } = await chrome.storage.local.get("bwServer");
  return bwServer && typeof bwServer.serverUrl === "string" ? bwServer : null;
}

/** Libellé d'un serveur : « Vaultwarden 2025.6.0 », « Bitwarden ». */
function serverLabel(info) {
  return `${info?.kind === "vaultwarden" ? "Vaultwarden" : "Bitwarden"}${info?.version ? ` ${info.version}` : ""}`;
}

function hostLabel(url) {
  try {
    return new URL(url).host;
  } catch {
    return url ?? "";
  }
}

/**
 * Adresse probable du coffre, sans rien demander : onglets ouverts puis historique (titre « Vaultwarden Web »,
 * « Bitwarden Web vault », ou nom d'hôte passwords.*, vault.*). Le serveur officiel n'est proposé qu'en dernier.
 */
async function guessBwServers() {
  const seen = new Map(); // origine -> score
  const NOT_VAULT = /(^|\.)(github\.com|google\.[a-z.]+|bitwarden\.com|bitwarden\.eu|reddit\.com|youtube\.com|stackoverflow\.com|docker\.com)$/i;
  const consider = (url, title, weight) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (u.protocol !== "https:") return;
    const host = u.hostname;
    const official = /^vault\.bitwarden\.(com|eu)$/i.test(host);
    if (!official && NOT_VAULT.test(host)) return;
    let score = 0;
    if (/vaultwarden/i.test(title ?? "")) score += 6;
    else if (/bitwarden/i.test(title ?? "")) score += 3;
    if (/^(passwords?|vault|vw|bitwarden|bw|pass|mdp)\./i.test(host)) score += 3;
    if (official) score -= 2; // on préfère un serveur auto-hébergé s'il y en a un
    if (score <= 0) return;
    seen.set(u.origin, Math.max(seen.get(u.origin) ?? 0, score + weight));
  };
  for (const tab of await chrome.tabs.query({}).catch(() => [])) consider(tab.url, tab.title, 2);
  if (chrome.history?.search) {
    for (const text of ["vaultwarden", "bitwarden", "passwords."]) {
      const items = await chrome.history.search({ text, startTime: 0, maxResults: 40 }).catch(() => []);
      for (const it of items) consider(it.url, it.title, Math.min(2, Math.log10(1 + (it.visitCount ?? 0))));
    }
  }
  return [...seen].sort((a, b) => b[1] - a[1]).map(([origin]) => origin).slice(0, 4);
}

/** Vérifie l'adresse saisie (le démon interroge /api/config) et l'annonce sous le champ. */
async function checkBwServer() {
  const status = $("bw-server-status");
  const value = $("bw-server").value.trim();
  if (!value) {
    status.textContent = "";
    delete status.dataset.tone;
    return null;
  }
  status.textContent = "Vérification du serveur…";
  delete status.dataset.tone;
  const res = await send({ type: "bw-probe", serverUrl: value });
  if ($("bw-server").value.trim() !== value) return null; // saisie modifiée entre-temps
  if (!res?.ok) {
    bwServerChecked = "";
    status.dataset.tone = "bad";
    status.textContent = res?.error ?? "Serveur injoignable.";
    $("bw-open-web").hidden = true;
    return null;
  }
  const info = res.result;
  bwServerChecked = info.serverUrl;
  $("bw-server").value = info.serverUrl;
  status.dataset.tone = "ok";
  status.textContent = `${serverLabel(info)} joignable.`;
  $("bw-open-web").hidden = false;
  return info;
}

/** Formulaire de connexion prérempli : adresse déjà utilisée, sinon devinée (puis vérifiée), e-mail mémorisé. */
async function prefillBwLogin(st) {
  const saved = await savedBwServer();
  if (!$("bw-login-email").value && (saved?.email || st.email)) $("bw-login-email").value = saved?.email || st.email;
  if ($("bw-server").value.trim()) return;
  const known = saved?.serverUrl || st.serverUrl;
  if (known) {
    $("bw-server").value = known;
    await checkBwServer();
    return;
  }
  for (const origin of await guessBwServers()) {
    $("bw-server").value = origin;
    if (await checkBwServer()) {
      $("bw-server-status").textContent += " Adresse trouvée dans votre navigateur.";
      return;
    }
  }
  $("bw-server").value = "";
  $("bw-server-status").textContent = "Collez l'adresse de votre coffre (celle du coffre web), ou https://vault.bitwarden.com pour un compte Bitwarden.";
  delete $("bw-server-status").dataset.tone;
}

async function refreshBw() {
  const pill = $("bw-state");
  showError("bw-error", "");
  $("bw-unlock-form").hidden = true;
  $("bw-open").hidden = true;
  $("bw-login-form").hidden = true;
  $("bw-account").hidden = true;
  const set = (on, text) => {
    pill.dataset.on = String(on);
    pill.textContent = text;
    bwUnlocked = on;
  };
  const res = await send({ type: "bw-status" });
  if (!res?.ok) {
    set(false, "injoignable");
    showError("bw-error", res?.error === "Démon non connecté." ? "Le démon n'est pas connecté : le coffre sera disponible dès qu'un agent se connecte." : res?.error ?? "Coffre injoignable.");
    return;
  }
  const st = res.result ?? {};
  const saved = await savedBwServer();
  // L'explication sert à la mise en route ; une fois le coffre connecté, elle n'encombre plus.
  $("bw-intro").hidden = st.state === "locked" || st.state === "unlocked";
  if (st.serverUrl || saved) {
    $("bw-title").textContent = (saved?.kind ?? (/bitwarden\.(com|eu)/.test(st.serverUrl ?? "") ? "bitwarden" : "vaultwarden")) === "vaultwarden" ? "Vaultwarden" : "Bitwarden";
  }
  if (!st.cli) {
    set(false, "CLI absent");
    showError("bw-error", "Il manque le CLI Bitwarden (gratuit, sert aussi pour Vaultwarden). Dans un terminal : winget install --id Bitwarden.CLI, puis revenez ici.");
    return;
  }
  const account = () => {
    $("bw-account-text").textContent = [hostLabel(st.serverUrl ?? saved?.serverUrl), st.email].filter(Boolean).join(" · ");
    $("bw-account").hidden = false;
  };
  if (st.state === "unlocked") {
    set(true, "déverrouillé");
    $("bw-open").hidden = false;
    account();
  } else if (st.state === "locked") {
    set(false, "verrouillé");
    $("bw-unlock-form").hidden = false;
    account();
  } else if (st.state === "unauthenticated") {
    set(false, "à connecter");
    $("bw-login-form").hidden = false;
    await prefillBwLogin(st);
  } else {
    set(false, "inconnu");
  }
}

$("bw-server").addEventListener("change", checkBwServer);
$("bw-open-web").addEventListener("click", () => {
  if (bwServerChecked) chrome.tabs.create({ url: bwServerChecked });
});

$("bw-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("bw-error", "");
  const email = $("bw-login-email").value.trim();
  const password = $("bw-login-password").value;
  const code = $("bw-login-code").value.trim();
  if (!$("bw-server").value.trim()) return $("bw-server").focus();
  if (!email) return $("bw-login-email").focus();
  if (!password) return $("bw-login-password").focus();
  const submit = $("bw-login-submit");
  submit.disabled = true;
  submit.textContent = "Connexion…";
  try {
    const configured = await send({ type: "bw-configure", serverUrl: $("bw-server").value.trim() });
    if (!configured?.ok) {
      showError("bw-error", configured?.error ?? "Serveur refusé.");
      return $("bw-server").focus();
    }
    const info = configured.result;
    const res = await send({ type: "bw-login", email, password, code });
    if (!res?.ok) {
      if (res?.reason === "needs-code") {
        $("bw-code-label").hidden = false;
        $("bw-login-code").value = "";
        $("bw-login-code").focus();
      } else if (/incorrect/i.test(res?.error ?? "")) {
        $("bw-login-password").select();
      }
      return showError("bw-error", res?.error ?? "Connexion impossible.");
    }
    await chrome.storage.local.set({ bwServer: { serverUrl: info.serverUrl, kind: info.kind, ...(info.version && { version: info.version }), email } });
    $("bw-login-password").value = "";
    $("bw-login-code").value = "";
    $("bw-code-label").hidden = true;
    toast(`${serverLabel(info).split(" ")[0]} connecté`);
    await refreshBw();
  } finally {
    submit.disabled = false;
    submit.textContent = "Connecter mon coffre";
  }
});

$("bw-unlock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("bw-error", "");
  const pass = $("bw-unlock-input").value;
  $("bw-unlock-input").value = "";
  if (!pass) return;
  const res = await send({ type: "bw-unlock", password: pass });
  if (!res?.ok) return showError("bw-error", /invalid master password/i.test(res?.error ?? "") ? "Mot de passe maître incorrect." : res?.error ?? "Déverrouillage impossible.");
  await refreshBw();
});

$("bw-lock-button").addEventListener("click", async () => {
  await send({ type: "bw-lock" });
  await refreshBw();
});

$("bw-logout-button").addEventListener("click", async () => {
  showError("bw-error", "");
  const res = await send({ type: "bw-logout" });
  if (!res?.ok) return showError("bw-error", res?.error ?? "Déconnexion impossible.");
  toast("Coffre déconnecté");
  await refreshBw();
});

$("bw-sync-button").addEventListener("click", async () => {
  showError("bw-error", "");
  const res = await send({ type: "bw-sync" });
  if (!res?.ok) return showError("bw-error", res?.error ?? "Synchronisation impossible.");
  toast("Coffre synchronisé");
  await refreshBw();
});

// Coffre ouvert depuis une carte de la vue Activité (agent en attente) : l'état affiché ici suit.
chrome.storage.session.onChanged.addListener((changes) => {
  if (started && changes.bwUnlockRequests) refreshBw();
});

async function runBwSearch() {
  showError("slot-bw-error", "");
  $("slot-bw-results").replaceChildren();
  bwSelected = null;
  if (!bwUnlocked) return showError("slot-bw-error", "Connectez ou déverrouillez d'abord votre coffre (plus haut).");
  const res = await send({ type: "bw-search", query: $("slot-bw-search").value });
  if (!res?.ok) return showError("slot-bw-error", res?.error ?? "Recherche impossible.");
  const items = res.result?.items ?? [];
  if (!items.length) return showError("slot-bw-error", "Aucun élément trouvé. Vérifiez la recherche, ou synchronisez le coffre.");
  $("slot-bw-results").replaceChildren(...items.slice(0, 20).map((it) => {
    const li = el("li");
    const b = el("button");
    b.type = "button";
    b.setAttribute("aria-pressed", "false");
    b.append(document.createTextNode(it.name ?? it.id));
    if (it.username) b.append(document.createTextNode(" "), el("span", "bw-user", it.username));
    b.addEventListener("click", () => {
      bwSelected = { itemId: it.id, itemName: it.name ?? it.id };
      for (const other of $("slot-bw-results").querySelectorAll("button")) other.setAttribute("aria-pressed", String(other === b));
      if (!$("slot-label").value.trim()) $("slot-label").value = it.name ?? "";
      $("slot-label").dispatchEvent(new Event("input"));
      const uri = (Array.isArray(it.uris) ? it.uris : []).find(Boolean);
      if (!$("slot-hosts").value.trim() && uri) {
        try {
          $("slot-hosts").value = new URL(uri).hostname;
        } catch { /* URI relative : saisie manuelle */ }
        renderHostsPreview();
      }
    });
    li.append(b);
    return li;
  }));
}

$("slot-bw-go").addEventListener("click", runBwSearch);
$("slot-bw-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runBwSearch();
  }
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.credSlots) loadStore().then(renderSecrets);
});

/** Premier affichage de la vue : état du coffre, puis Bitwarden (qui interroge le démon). */
let started = false;
export async function startSecrets() {
  if (started) return refreshBw();
  started = true;
  const store = await loadStore();
  if (!store) $("slot-source").value = "bitwarden"; // sans coffre intégré, Bitwarden d'abord
  renderSlotSource();
  renderSecrets();
  await refreshBw();
}

// Le service worker garde la clé de session : si le coffre est déjà ouvert, le panneau le sait.
export async function syncVaultState() {
  const res = await send({ type: "credentials-state" });
  if (res?.ok && res.result?.unlocked && !credKey) {
    credKey = "session"; // marqueur : la clé vit dans le service worker, le panneau ne la détient pas
  }
  await loadStore();
  renderSecrets();
}
