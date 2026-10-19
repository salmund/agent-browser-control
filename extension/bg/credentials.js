// Agent Browser Control, service worker : secrets d'authentification.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Secrets d'authentification (outil credentials_fill)
// ---------------------------------------------------------------------------
// L'agent ne manipule que des références opaques (slot ids). Les valeurs en clair
// n'existent que chiffrées dans chrome.storage.local, déchiffrées en mémoire le temps
// du remplissage, et ne transitent jamais par MCP, le journal ou les résultats.

const CRED_STORE_KEY = "credSlots";
const CRED_DEK_KEY = "credDek";
const CRED_APPROVALS_KEY = "credApprovals";
const CRED_APPROVAL_MS = 75_000;
const HAR_MUTE_MS = 120_000;
const CRED_FORMAT = "abc-credentials-v1";

/** Silence HAR par onglet (epoch ms) : voir harPush. */
const harMutedUntil = new Map();

/** Clé de déchiffrement en mémoire (perdue au redémarrage du navigateur). */
let credDekB64 = null;

/** Demandes d'approbation en attente : id -> { resolve, timer }. */
const credPending = new Map();
let credApprovalId = 0;

function credSlotIdOk(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}

function credHostCovered(host, scope) {
  const h = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  const s = String(scope ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!h || !s) return false;
  return h === s || h.endsWith(`.${s}`);
}

async function credLoadStore() {
  const { [CRED_STORE_KEY]: store } = await chrome.storage.local.get(CRED_STORE_KEY);
  if (!store || store.format !== CRED_FORMAT) return null;
  return store;
}

async function credDek() {
  if (credDekB64) return credDekB64;
  const { [CRED_DEK_KEY]: saved } = await chrome.storage.session.get(CRED_DEK_KEY);
  if (saved) credDekB64 = saved;
  return credDekB64;
}

/** Mémorise la clé (venue du panneau, jamais la phrase secrète) pour la session navigateur. */
async function credUnlock(dekB64) {
  if (typeof dekB64 !== "string" || !dekB64) throw new Error("Clé manquante.");
  credDekB64 = dekB64;
  await chrome.storage.session.set({ [CRED_DEK_KEY]: dekB64 });
}

async function credLock() {
  credDekB64 = null;
  await chrome.storage.session.remove(CRED_DEK_KEY);
}

async function credDecryptSlot(slot, dekB64) {
  const raw = Uint8Array.from(atob(dekB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const iv = Uint8Array.from(atob(slot.iv), (c) => c.charCodeAt(0));
  const data = Uint8Array.from(atob(slot.data), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(plain);
}

async function credPublishApprovals(list) {
  await chrome.storage.session.set({ [CRED_APPROVALS_KEY]: list });
}

async function credPushApproval(entry) {
  const { [CRED_APPROVALS_KEY]: current = [] } = await chrome.storage.session.get(CRED_APPROVALS_KEY);
  await credPublishApprovals([...current, entry]);
}

async function credDropApproval(id) {
  const { [CRED_APPROVALS_KEY]: current = [] } = await chrome.storage.session.get(CRED_APPROVALS_KEY);
  await credPublishApprovals(current.filter((a) => a.id !== id));
}

/** Toute demande en attente est refusée (STOP, verrouillage, révocation). */
async function credDenyPending(reason) {
  for (const [id, p] of [...credPending]) {
    clearTimeout(p.timer);
    credPending.delete(id);
    await credDropApproval(id);
    p.resolve({ ok: false, error: reason });
  }
}

/** Attend la décision de l'utilisateur dans le panneau (approbation unique, jamais mémorisée ici). */
function credWaitDecision(entry) {
  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      credPending.delete(entry.id);
      await credDropApproval(entry.id);
      resolve({ ok: false, error: "Approbation expirée (75 s) : l'utilisateur n'a pas répondu dans le panneau latéral." });
    }, CRED_APPROVAL_MS);
    credPending.set(entry.id, { resolve, timer });
  });
}

/** Nom d'hôte d'une frame de l'onglet (champ dans une iframe), "" si inconnu. */
async function frameHostname(tabId, frameId) {
  const [res] = await chrome.scripting
    .executeScript({ target: { tabId, frameIds: [frameId] }, func: () => location.hostname })
    .catch(() => []);
  return String(res?.result ?? "").toLowerCase();
}

/** Miroir de isExternalSlot (server/credentials.ts) : slot résolu hors du coffre. */
function credIsExternal(slot) {
  return !!slot?.external && slot.external.provider === "bitwarden" && typeof slot.external.itemId === "string" && !!slot.external.itemId;
}

// ---------------------------------------------------------------------------
// Coffre de l'utilisateur (Vaultwarden, Bitwarden) : rien à configurer côté agent
// ---------------------------------------------------------------------------
// « vaultwarden » (ou « bitwarden ») désigne l'identifiant de la page dans le coffre de l'utilisateur,
// choisi par les règles d'adresse du coffre ; « bw-<id> » un élément précis, listé par credentials_list.
// Coffre verrouillé : l'utilisateur est prévenu (panneau, notification) et l'outil reprend dès qu'il
// l'a déverrouillé. Chaque usage d'un de ces slots passe par son approbation, sauf s'il a choisi
// « Toujours sur ce site », qui enregistre un slot ordinaire.

const BW_AUTO_SLOTS = new Set(["vaultwarden", "bitwarden"]);
const BW_ITEM_SLOT = /^bw-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const BW_UNLOCK_KEY = "bwUnlockRequests";
const BW_UNLOCK_WAIT_MS = 120_000;

/** Agents qui attendent un déverrouillage : une seule saisie du mot de passe les relance tous. */
const bwUnlockWaiters = new Set();
let bwUnlockSeq = 0;
// Les attentes meurent avec le service worker : rien ne doit rester affiché dans le panneau.
chrome.storage.session.set({ [BW_UNLOCK_KEY]: [] }).catch(() => {});

function bwUnlockSettle(outcome) {
  for (const done of [...bwUnlockWaiters]) done(outcome);
}

/** Nom du coffre pour les messages : celui que l'utilisateur a configuré dans le panneau. */
async function bwVaultName() {
  const { bwServer } = await chrome.storage.local.get("bwServer");
  return bwServer?.kind === "vaultwarden" ? "Vaultwarden" : "Bitwarden";
}

/** Prévient l'utilisateur (panneau, notification) et attend qu'il ouvre son coffre (120 s au plus). */
async function bwWaitUnlock(ctx, reason) {
  const name = await bwVaultName();
  const id = `bwu-${++bwUnlockSeq}`;
  const entry = {
    id, agent: ctx.agent, host: ctx.host, vault: name, needsLogin: reason === "unauthenticated",
    t: Date.now(), until: Date.now() + BW_UNLOCK_WAIT_MS,
  };
  const { [BW_UNLOCK_KEY]: current = [] } = await chrome.storage.session.get(BW_UNLOCK_KEY);
  await chrome.storage.session.set({ [BW_UNLOCK_KEY]: [...current, entry] });
  notifyRequest(id, reason === "unauthenticated" ? `${name} à connecter` : `${name} verrouillé`,
    `${ctx.agent} a besoin d'un identifiant pour ${ctx.host}. ${reason === "unauthenticated" ? "Connectez" : "Déverrouillez"} votre coffre dans le panneau.`);
  if (ctx.windowId !== undefined) chrome.sidePanel.open({ windowId: ctx.windowId }).catch(() => {});
  try {
    return await new Promise((resolve) => {
      const done = (outcome) => {
        clearTimeout(timer);
        bwUnlockWaiters.delete(done);
        resolve(outcome);
      };
      const timer = setTimeout(() => done({
        ok: false,
        error: `${name} toujours ${reason === "unauthenticated" ? "non connecté" : "verrouillé"} après 120 s : l'utilisateur n'a pas répondu dans le panneau latéral.`,
      }), BW_UNLOCK_WAIT_MS);
      bwUnlockWaiters.add(done);
    });
  } finally {
    chrome.notifications.clear(id).catch(() => {});
    const { [BW_UNLOCK_KEY]: now = [] } = await chrome.storage.session.get(BW_UNLOCK_KEY);
    await chrome.storage.session.set({ [BW_UNLOCK_KEY]: now.filter((e) => e.id !== id) });
  }
}

/** Appel au coffre ; s'il est verrouillé (ou pas connecté) et qu'un agent attend, on demande à l'utilisateur puis on réessaie. */
async function bwCall(op, params, ctx) {
  try {
    return await daemonRpc(op, params);
  } catch (err) {
    if (!ctx || (err?.reason !== "locked" && err?.reason !== "unauthenticated")) throw err;
    const outcome = await bwWaitUnlock(ctx, err.reason);
    if (!outcome.ok) throw new Error(outcome.error);
    return daemonRpc(op, params);
  }
}

/** Éléments du coffre associés à cette adresse (expurgés : id, nom, identifiant, adresses). Cache 60 s. */
const bwMatchCache = new Map(); // origine -> { items, t }
function bwForgetMatches() {
  bwMatchCache.clear();
}
async function bwMatches(url, ctx) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return [];
  }
  const hit = bwMatchCache.get(origin);
  if (hit && Date.now() - hit.t < 60_000) return hit.items;
  const res = await bwCall("bw-match", { url: origin }, ctx);
  const items = Array.isArray(res?.items) ? res.items : [];
  if (items.length) bwMatchCache.set(origin, { items, t: Date.now() }); // vide : peut-être ajouté depuis
  return items;
}

/**
 * Valeur d'un slot externe : résolue à l'usage par le démon (CLI Bitwarden),
 * jamais stockée ni renvoyée. `use: "login"` donne l'identifiant, sinon le secret.
 */
async function credResolveExternal(slot, useLogin, ctx) {
  const field = useLogin ? "username" : "password";
  const res = await bwCall("bw-resolve", { itemId: slot.external.itemId, field }, ctx);
  if (typeof res?.value !== "string" || !res.value) {
    throw new Error(`Slot "${slot.id}" : l'élément « ${slot.external.itemName ?? slot.external.itemId} » n'a pas de ${useLogin ? "identifiant" : "mot de passe"}.`);
  }
  return res.value;
}

/** Nom technique libre pour un slot créé depuis un élément du coffre (« Toujours sur ce site »). */
function credFreeSlotId(store, name) {
  const base = String(name ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "identifiant";
  const root = /^[a-z0-9]/.test(base) ? base : `id-${base}`;
  let id = root;
  for (let n = 2; store.slots[id]; n++) id = `${root}-${n}`;
  return id;
}

/** « Toujours sur ce site » : l'élément du coffre devient un slot ordinaire, autorisé sans demander sur ce site. */
async function credRememberItem(item, host) {
  const store = (await credLoadStore()) ?? { format: CRED_FORMAT, salt: "", verifier: null, slots: {} };
  const existing = Object.values(store.slots).find((s) => credIsExternal(s) && s.external.itemId === item.id);
  if (existing) {
    if (!existing.hosts.some((h) => credHostCovered(host, h))) existing.hosts.push(host);
    existing.policy = "always";
  } else {
    const id = credFreeSlotId(store, item.name);
    store.slots[id] = {
      id, label: item.name ?? id, hosts: [host], policy: "always", created: new Date().toISOString(),
      external: { provider: "bitwarden", itemId: item.id, itemName: item.name ?? item.id },
    };
  }
  await chrome.storage.local.set({ [CRED_STORE_KEY]: store });
}

/**
 * Liste les slots du coffre (métadonnées uniquement : id, nom, sites, politique).
 * Jamais de valeurs : fonctionne même coffre verrouillé. Avec tabId, ne renvoie
 * que les slots autorisés pour le site de l'onglet, plus les éléments du coffre de
 * l'utilisateur associés à la page (s'il est déverrouillé ; sans rien lui demander).
 */
async function credentialsList(agent, { tabId } = {}) {
  const store = await credLoadStore();
  let tab = null;
  let tabHost = "";
  if (tabId !== undefined) {
    tab = await assertOwned(agent, tabId);
    try {
      tabHost = new URL(tab.url).hostname.toLowerCase();
    } catch {
      tabHost = "";
    }
  }
  const slots = Object.values(store?.slots ?? {}).map((s) => ({ id: s.id, label: s.label ?? s.id, login: s.login, hosts: s.hosts ?? [], policy: s.policy, external: credIsExternal(s) ? s.external : null }));
  const list = tabHost ? slots.filter((s) => s.hosts.some((h) => credHostCovered(tabHost, h))) : slots;
  const policyFr = (s) => (s.policy === "always" ? "toujours autoriser" : "demander à chaque fois");
  const lines = list.map((s) => s.external
    ? `- ${s.id} (« ${s.label} », coffre : « ${s.external.itemName ?? s.external.itemId} », ${policyFr(s)}, sites : ${s.hosts.join(", ")})`
    : `- ${s.id} (« ${s.label} », identifiant : ${s.login ? `"${s.login}"` : "non renseigné"}, ${policyFr(s)}, sites : ${s.hosts.join(", ")})`);

  // Coffre de l'utilisateur : ses éléments pour la page, sans demander de déverrouillage (une liste n'est pas une action).
  const vault = await daemonRpc("bw-status").catch(() => null);
  if (vault?.cli && vault.state && vault.state !== "unknown") {
    const name = await bwVaultName();
    if (tabHost && vault.state === "unlocked") {
      const known = new Set(list.filter((s) => s.external).map((s) => s.external.itemId));
      const items = (await bwMatches(tab.url).catch(() => [])).filter((it) => !known.has(it.id));
      for (const it of items.slice(0, 10)) {
        lines.push(`- bw-${it.id} (« ${it.name} », ${name}${it.username ? `, identifiant : "${it.username}"` : ""}, demander à chaque fois, associé à ${tabHost})`);
      }
    }
    const state = vault.state === "unlocked" ? "" : vault.state === "locked" ? ` ; ${name} est verrouillé : l'utilisateur sera invité à le déverrouiller` : ` ; ${name} n'est pas encore connecté : l'utilisateur sera invité à le connecter`;
    lines.push(`- vaultwarden (l'identifiant de cette page dans le coffre ${name} de l'utilisateur, choisi automatiquement ; approbation dans le panneau${state})`);
  }
  if (!lines.length) {
    return ok(text(tabHost ? `Aucun slot autorisé pour ${tabHost}.` : "Aucun secret : l'utilisateur peut connecter son coffre (Vaultwarden, Bitwarden) ou créer un slot dans le panneau latéral (onglet Secrets)."));
  }
  return ok(text(lines.join("\n")));
}

async function credentialsFill(agent, { tabId, fills, submitRef }) {
  if (!Array.isArray(fills) || !fills.length) throw new Error("Fournir 'fills' (liste de {ref, slot}).");
  for (const f of fills) {
    if (!f?.ref) throw new Error("Chaque remplissage exige 'ref'.");
    if (!credSlotIdOk(f?.slot)) throw new Error(`Slot invalide : ${JSON.stringify(f?.slot)}.`);
    if (f?.use !== undefined && f.use !== "login") throw new Error(`Paramètre 'use' invalide : ${JSON.stringify(f?.use)} (seule valeur acceptée : "login", pour remplir l'identifiant en clair ; sans 'use', remplit le secret).`);
  }
  const tab = await assertOwned(agent, tabId);
  const tabHost = (() => {
    try {
      return new URL(tab.url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  const store = await credLoadStore();
  const virtual = (slotId) => BW_AUTO_SLOTS.has(slotId) || BW_ITEM_SLOT.test(slotId);
  if (!store && !fills.every((f) => virtual(f.slot))) {
    throw new Error("Aucun coffre de secrets : l'utilisateur doit d'abord créer un slot dans le panneau latéral (onglet Secrets), ou utiliser le slot \"vaultwarden\" (son coffre Vaultwarden ou Bitwarden).");
  }
  // La clé du coffre intégré n'est exigée que pour les slots manuels : les slots
  // externes (Bitwarden) se résolvent sans elle.
  let dek = null;
  async function needDek() {
    if (!dek) dek = await credDek();
    if (!dek) throw new Error("Coffre verrouillé : l'utilisateur doit le déverrouiller dans le panneau latéral (section Secrets).");
    return dek;
  }
  const ctx = { agent, host: tabHost || "cette page", windowId: tab.windowId };
  const vaultName = await bwVaultName();

  /**
   * Slot d'un remplissage : enregistré, ou élément du coffre de l'utilisateur. Le même slot sert aux champs
   * suivants de l'appel (identifiant puis mot de passe : une seule recherche, une seule approbation).
   */
  const resolved = new Map(); // id du slot demandé -> slot
  async function slotFor(slotId) {
    if (resolved.has(slotId)) return resolved.get(slotId);
    let slot;
    if (BW_AUTO_SLOTS.has(slotId)) {
      // Un slot enregistré pour ce site et relié au coffre passe d'abord (il porte la politique choisie).
      const saved = Object.values(store?.slots ?? {}).filter((s) => credIsExternal(s) && s.hosts.some((h) => credHostCovered(tabHost, h)));
      if (saved.length === 1) slot = saved[0];
      else {
        const items = await bwMatches(tab.url, ctx);
        if (!items.length) {
          throw new Error(`Aucun identifiant pour ${tabHost} dans le coffre ${vaultName} de l'utilisateur. Lui demander d'en ajouter un (avec l'adresse du site), ou de se connecter lui-même (ask_human).`);
        }
        slot = {
          id: slotId, label: items.length === 1 ? items[0].name : `${items.length} comptes ${vaultName}`, hosts: [tabHost], policy: "ask",
          external: { provider: "bitwarden", itemId: items.length === 1 ? items[0].id : "", itemName: items[0].name },
          candidates: items.length > 1 ? items.slice(0, 8) : null, fromVault: true,
        };
      }
    } else if (BW_ITEM_SLOT.test(slotId)) {
      const itemId = BW_ITEM_SLOT.exec(slotId)[1];
      // Périmètre : l'élément doit être associé à la page dans le coffre, sinon n'importe quel mot de passe
      // pourrait être rempli sur n'importe quel site.
      const item = (await bwMatches(tab.url, ctx)).find((it) => it.id === itemId);
      if (!item) throw new Error(`Slot "${slotId}" : cet élément du coffre n'est pas associé à ${tabHost}. Remplissage refusé (credentials_list donne les éléments de la page).`);
      slot = { id: slotId, label: item.name, hosts: [tabHost], policy: "ask", external: { provider: "bitwarden", itemId: item.id, itemName: item.name }, candidates: null, fromVault: true };
    } else {
      slot = store?.slots[slotId];
      if (!slot) throw new Error(`Slot inconnu ou révoqué : "${slotId}".`);
    }
    resolved.set(slotId, slot);
    return slot;
  }

  const results = [];
  const approved = new Set(); // slots déjà approuvés pendant cet appel
  // Réglage « Connexions automatiques » du panneau (l'utilisateur seul peut le changer) : pas de carte
  // d'accord, mais périmètre, iframe et sites interdits restent vérifiés. Plusieurs comptes : il choisit.
  const { autoLogin = false } = await chrome.storage.local.get("autoLogin");
  await bringToFront(tab);
  // Silence HAR dès maintenant : un site qui vérifie à la frappe, ou un login AJAX très rapide, enverrait
  // le secret avant la fin de l'outil. Les corps envoyés pendant ce délai ne sont pas enregistrés.
  harMutedUntil.set(tabId, Date.now() + HAR_MUTE_MS);
  for (const item of fills) {
    const slot = await slotFor(item.slot);
    if (!slot.hosts.some((h) => credHostCovered(tabHost, h))) {
      throw new Error(`Slot "${item.slot}" : site ${tabHost || "(inconnu)"} hors périmètre (${slot.hosts.map((h) => `"${h}"`).join(", ")}). Remplissage refusé.`);
    }
    const target = parseRef(item.ref);
    // Le champ peut être dans une iframe d'un autre site (publicité, widget) : c'est la frame qui doit
    // être couverte par le slot, pas seulement l'onglet. page.js revérifie de son côté au remplissage.
    const frameHost = target.frameId ? await frameHostname(tabId, target.frameId) : tabHost;
    let frameOk = slot.hosts.some((h) => credHostCovered(frameHost, h));
    if (!frameOk && slot.fromVault && frameHost) {
      // Élément du coffre : la frame est acceptée si le coffre associe aussi l'élément à son adresse.
      const inFrame = await bwMatches(`https://${frameHost}`, ctx).catch(() => []);
      frameOk = inFrame.some((it) => it.id === slot.external.itemId || slot.candidates?.some((c) => c.id === it.id));
    }
    if (!frameOk) {
      throw new Error(`Slot "${item.slot}" : le champ ${item.ref} est dans une iframe de ${frameHost || "(origine inconnue)"}, hors périmètre (${slot.hosts.map((h) => `"${h}"`).join(", ")}). Remplissage refusé.`);
    }
    if (slot.policy !== "always" && !(autoLogin === true && !slot.candidates) && !approved.has(item.slot)) {
      const entry = {
        id: ++credApprovalId, agent, slotId: item.slot, label: slot.label ?? item.slot,
        tabHost, ...(frameHost !== tabHost && { frameHost }), use: item.use === "login" ? "login" : "secret",
        // Plusieurs champs (identifiant, mot de passe) : une seule approbation pour l'appel.
        fields: fills.filter((f) => f.slot === item.slot).length,
        ...(slot.fromVault && { vault: vaultName }),
        ...(slot.candidates && { candidates: slot.candidates.map((c) => ({ id: c.id, name: c.name, username: c.username ?? "" })) }),
        canRemember: true,
        t: Date.now(), until: Date.now() + CRED_APPROVAL_MS,
      };
      await credPushApproval(entry);
      notifyRequest(`cred-${entry.id}`, "Secret demandé", `${agent} veut remplir « ${entry.label} » sur ${frameHost || tabHost}. Autoriser ou refuser dans le panneau.`);
      const decision = await credWaitDecision(entry);
      chrome.notifications.clear(`cred-${entry.id}`).catch(() => {});
      if (!decision.ok) throw new Error(decision.error);
      if (slot.candidates) {
        const chosen = slot.candidates.find((c) => c.id === decision.itemId);
        if (!chosen) throw new Error("Aucun élément du coffre choisi dans le panneau : remplissage annulé.");
        slot.external = { provider: "bitwarden", itemId: chosen.id, itemName: chosen.name };
        slot.label = chosen.name;
        slot.candidates = null;
      }
      if (decision.remember) {
        if (slot.fromVault) await credRememberItem({ id: slot.external.itemId, name: slot.external.itemName }, tabHost).catch(() => {});
        else if (store?.slots[slot.id]) {
          store.slots[slot.id].policy = "always";
          await chrome.storage.local.set({ [CRED_STORE_KEY]: store }).catch(() => {});
        }
      }
      approved.add(item.slot);
    }
    // Secret : valeur obtenue à l'usage, jamais stockée ni renvoyée (les chaînes JS sont
    // immuables : on évite toute copie superflue et on ne la journalise nulle part).
    const external = credIsExternal(slot);
    if (slot.external && !external) throw new Error(`Slot "${item.slot}" : référence externe invalide (fournisseur inconnu).`);
    const value = external
      ? await credResolveExternal(slot, item.use === "login", ctx)
      : item.use === "login"
        ? AbcJsEval.credentialLogin(slot)
        : await credDecryptSlot(slot, await needDek());
    const hosts = slot.fromVault ? [frameHost || tabHost] : slot.hosts.map((h) => String(h).toLowerCase());
    await inPage(tabId, "fillSecret", { ref: target.ref, value, hosts, use: item.use === "login" ? "login" : undefined }, target.frameId);
    results.push(`${item.ref} rempli (slot "${item.slot}"${slot.fromVault ? `, élément « ${slot.label} »` : ""}).`);
  }

  const submitMsg = submitRef ? `\n${await submitByRef(tab, submitRef)}` : "";
  // Le délai de silence repart de la soumission : c'est elle qui envoie le formulaire.
  harMutedUntil.set(tabId, Date.now() + HAR_MUTE_MS);
  await showOverlay(tabId);
  await recordFrame(tabId, `credentials_fill ${fills.map((f) => f.ref).join(", ")} [${[...new Set(fills.map((f) => f.slot))].join(", ")}]${submitRef ? ` -> ${submitRef}` : ""}`);
  return ok(text((results.join("\n") + submitMsg).trim()));
}
