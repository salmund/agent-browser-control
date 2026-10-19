// Agent Browser Control, service worker : navigation.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function normalizeUrl(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `https://${url}`;
}

function waitForLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Chargement trop long (page peut-être encore en cours)."));
    }, LOAD_TIMEOUT_MS);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

const READY_SETTLE_MAX_MS = 1500; // après DOMContentLoaded : attente max de la stabilisation du DOM

/**
 * Attend que la page soit utilisable, sans attendre la dernière image, publicité ou traceur :
 * DOMContentLoaded du nouveau document, puis DOM stable 300 ms (1,5 s au plus), ou chargement
 * complet s'il arrive avant. until: "load" garde l'ancien comportement (chargement complet).
 * targetUrl évite de prendre la fin de chargement d'about:blank (onglet neuf) pour celle de la cible.
 * assumeNavigated : la navigation a déjà commencé (après un clic), le prochain DOMContentLoaded compte.
 */
function waitForReady(tabId, { until = "ready", targetUrl, assumeNavigated = false } = {}) {
  if (until === "load") return waitForLoad(tabId);
  return new Promise((resolve, reject) => {
    let navigated = assumeNavigated;
    let contentLoaded = false;
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.debugger.onEvent.removeListener(onCdp);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Chargement trop long (page peut-être encore en cours).")), LOAD_TIMEOUT_MS);
    function onUpdated(id, info, tab) {
      if (id !== tabId || info.status !== "complete") return;
      if (targetUrl && targetUrl !== "about:blank" && tab?.url === "about:blank") return;
      finish();
    }
    function onCdp(source, method, params) {
      // Seulement la page principale (pas les iframes ni workers attachés, qui ont un sessionId).
      if (source.tabId !== tabId || source.sessionId) return;
      if (method === "Page.frameNavigated" && !params.frame?.parentId) {
        navigated = true;
      } else if (method === "Page.domContentEventFired" && navigated && !contentLoaded) {
        contentLoaded = true;
        waitDomSettle(tabId, 300, READY_SETTLE_MAX_MS).catch(() => {}).then(() => finish());
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.debugger.onEvent.addListener(onCdp);
  });
}

/** Détecte si l'URL correspond à une mire d'authentification, SSO, MFA ou défi bot. */
function isAuthChallenge(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    // Amazon & KDP
    if (host.includes("amazon.") && (path.includes("/ap/signin") || path.includes("/ap/mfa") || path.includes("/ap/challenge"))) return true;
    // Google Accounts
    if (host === "accounts.google.com" && (path.includes("/signin") || path.includes("/servicelogin") || path.includes("/v3/signin"))) return true;
    // Microsoft / Live / Office
    if ((host === "login.microsoftonline.com" || host === "login.live.com") && !path.endsWith("/logout")) return true;
    // GitHub
    if (host === "github.com" && (path.startsWith("/login") || path.startsWith("/session"))) return true;
    // Cloudflare Turnstile / Bot challenge
    if (path.includes("/cdn-cgi/challenge") || host.includes("challenges.cloudflare.com")) return true;
    // OAuth & SSO génériques
    if (path.includes("/oauth2/authorize") || path.includes("/oauth/authorize") || path.includes("/auth/realms/")) return true;
    return false;
  } catch {
    return false;
  }
}

async function getAttachedSnapshot(agent, tabId, { snapshot, then, diff, read } = {}) {
  const wantDiff = diff === true || then === "diff";
  const wantText = read === "text";
  const filter = read === "all" ? "all" : "interactive";
  if (wantText) {
    const textRes = await getPageText(agent, { tabId });
    return textRes?.content?.find((c) => c.type === "text")?.text ?? "";
  }
  const pageRes = await readPage(agent, { tabId, filter, diff: wantDiff });
  return pageRes?.content?.find((c) => c.type === "text")?.text ?? "";
}

/**
 * Exécuté dans la page (monde isolé : le site ne voit ni l'observateur ni la variable) : instant de la dernière
 * mutation qui change le contenu (nœuds ajoutés ou retirés, texte, éléments montrés ou cachés). Les classes et les
 * styles n'en sont pas : une animation (carrousel, compteur de pub) empêchait la page de paraître stable.
 * L'observateur reste posé pour la vie du document : un appel suivant sait déjà si la page bouge.
 * Même variable que watchDom de page.js (même monde isolé) : le premier qui la pose sert aux deux.
 */
function domQuietProbe() {
  if (!globalThis.__abcDomWatch) {
    const watch = (globalThis.__abcDomWatch = { last: Date.now() });
    try {
      new MutationObserver(() => (watch.last = Date.now())).observe(document.documentElement || document, {
        childList: true, subtree: true, characterData: true, attributeFilter: ["hidden", "open", "aria-hidden", "aria-busy"],
      });
    } catch {}
  }
  return globalThis.__abcDomWatch.last;
}

/**
 * Attend que le contenu de la page cesse de changer pendant settleMs (300 ms par défaut, maxMs au plus).
 * since : instant de l'action dont on attend la réaction ; le calme se compte à partir de là au plus tôt.
 */
async function waitDomSettle(tabId, settleMs = 300, maxMs = 2000, since = 0) {
  const start = Date.now();
  let failures = 0;
  while (Date.now() - start < maxMs) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: domQuietProbe }).catch(() => [null]);
    const last = res?.result;
    if (typeof last === "number") {
      failures = 0;
      if (Date.now() - Math.max(last, since) >= settleMs) return;
    } else if (++failures >= 5) {
      return; // page fermée aux scripts (page interne, PDF) : rien à observer
    }
    await sleep(50);
  }
}

/** Attend la réaction de la page (navigation ou stabilisation DOM) et joint le snapshot au résultat. */
async function attachActionSnapshot(agent, tabId, args, res, since = Date.now()) {
  if (!res || res.isError) return res;
  let navigated = false;
  try {
    // La navigation met quelques ms à démarrer après l'action : tester, attendre un peu, retester.
    let loading = (await chrome.tabs.get(tabId))?.status === "loading";
    if (!loading) {
      await sleep(50);
      loading = (await chrome.tabs.get(tabId))?.status === "loading";
    }
    if (loading) {
      await waitForReady(tabId, { assumeNavigated: true }).catch(() => {});
      navigated = true;
    }
  } catch {}
  if (!navigated) {
    await waitDomSettle(tabId, 300, 2000, since).catch(() => sleep(150));
  }
  const snap = await getAttachedSnapshot(agent, tabId, args);
  if (!snap) return res;
  const original = res.content?.find((c) => c.type === "text")?.text ?? "";
  return ok(text(`${original}\n\n${snap}`));
}

async function navigate(agent, { tabId, url, snapshot = false, read, wait, spa }) {
  // Un onglet planté se répare en y naviguant (url: "reload" ou une adresse) : c'est le conseil de l'erreur.
  await assertOwned(agent, tabId, { allowCrashed: true });
  if (!url) throw new Error("url manquante.");
  const special = ["back", "forward", "reload"].includes(url);
  // Chemin relatif (« /wiki/Myocarde », « ?page=2 », « #notes ») : read_page affiche des href compacts.
  if (!special && /^[/?#.]/.test(url) && !url.startsWith("//")) {
    const tab = await chrome.tabs.get(tabId);
    url = new URL(url, tab.url).href;
  }
  if (!special) await assertAllowed(normalizeUrl(url));
  await ensureAttached(tabId).catch(() => {});
  let note = "";
  // Même origine + routeur détecté (ou spa: true) : naviguer sans recharger (clic sur le
  // lien, sinon pushState). Échec ou inapplicable : repli sur la navigation complète.
  const viaSpa = !special && spa !== false && !crashedTabs.has(tabId)
    ? await navigateSpa(tabId, normalizeUrl(url), { force: spa === true }).catch(() => null)
    : null;
  if (!viaSpa) {
    const loaded = waitForReady(tabId, { until: wait });
    if (url === "back") await chrome.tabs.goBack(tabId);
    else if (url === "forward") await chrome.tabs.goForward(tabId);
    else if (url === "reload") await chrome.tabs.reload(tabId);
    else await chrome.tabs.update(tabId, { url: normalizeUrl(url) });
    await raceDialog(tabId, loaded).catch((err) => {
      if (err instanceof DialogOpenError) throw err;
      note = `\n(${err.message})`;
    });
  }
  const tab = await chrome.tabs.get(tabId);
  await recordFrame(tabId, `navigate ${tab.url}`);
  if (isAuthChallenge(tab.url)) {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    const w = await chrome.windows.get(tab.windowId).catch(() => null);
    if (w && !w.focused) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    note += `\n⚠ Authentification requise : la page demande une connexion (${tab.url}). L'onglet a été mis au premier plan pour que l'utilisateur puisse s'identifier. Tu peux appeler wait_for(tabId, { authSettled: true }) pour attendre sa validation sans fermer l'onglet.`;
  }
  let baseMsg = `Navigation terminée${viaSpa ? ` (${viaSpa})` : ""} : ${pageLabel(tab.title)} · ${tab.url}${note}`;
  if (snapshot || read) {
    const snap = await getAttachedSnapshot(agent, tabId, { snapshot, read });
    return ok(text(snap ? `${baseMsg}\n\n${snap}` : `${await overlayNotice(tabId)}${baseMsg}`));
  }
  return ok(text(`${await overlayNotice(tabId)}${baseMsg}`));
}

/**
 * Navigation SPA (même origine, routeur History API) : clic sur le lien correspondant,
 * sinon pushState + popstate, sans recharger la page (sessions, gateway et état intacts).
 * Renvoie la note du chemin pris, ou null si inapplicable (le navigateur recharge alors).
 */
async function navigateSpa(tabId, targetUrl, { force = false } = {}) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  let target, cur;
  try {
    target = new URL(targetUrl);
    cur = new URL(tab?.url ?? "");
  } catch {
    return null;
  }
  if (!/^https?:$/.test(target.protocol) || target.origin !== cur.origin) return null;
  // Même URL : l'agent veut recharger (page cassée, contenu périmé), sauf s'il impose la voie SPA.
  if (target.href === cur.href) return force ? "déjà sur cette URL" : null;
  if (!force) {
    const probe = await cdp(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const d = document;
        if (d.querySelector("[ng-version]")) return "angular";
        if (window.__NEXT_DATA__ || d.getElementById("__next")) return "next";
        if (window.__NUXT__ || d.getElementById("__nuxt") || d.querySelector("[data-v-app]")) return "vue";
        if (window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || d.querySelector("[data-reactroot]")) return "react";
        // React 18 et plus (createRoot) : plus de data-reactroot, mais une clé __reactContainer$… sur la racine.
        const roots = [d.getElementById("root"), d.getElementById("app"), ...d.querySelectorAll("body > div")].slice(0, 12);
        if (roots.some((el) => el && Object.keys(el).some((k) => k.startsWith("__reactContainer$") || k === "_reactRootContainer"))) return "react";
        if (d.querySelector("[data-sveltekit-preload-data]")) return "svelte";
        return null;
      })()`,
      returnByValue: true,
    }).catch(() => null);
    if (!probe?.result?.value) return null;
  }
  const path = target.pathname + target.search + target.hash;
  const t0 = Date.now();
  const clicked = await inPage(tabId, "spaLinkClick", { path }).catch(() => null);
  if (clicked?.clicked && (await waitUrl(tabId, target.href, 2000))) {
    await waitDomSettle(tabId, 300, 2500, t0).catch(() => {});
    return `navigation SPA (clic sur le lien « ${pageLabel(clicked.clicked, 80)} »)`;
  }
  // Repli pushState : seuls les routeurs qui écoutent popstate suivent (Next.js, entre autres, l'ignore et
  // laisserait l'ancienne page sous la nouvelle adresse). Le contenu doit donc avoir changé, sinon navigation complète.
  const before = await inPage(tabId, "pageDigest").catch(() => null);
  const t1 = Date.now();
  await cdp(tabId, "Runtime.evaluate", {
    expression: `history.pushState({}, "", ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent("popstate")); "ok"`,
  }).catch(() => null);
  if (await waitUrl(tabId, target.href, 2000)) {
    await waitDomSettle(tabId, 300, 2500, t1).catch(() => {});
    const after = await inPage(tabId, "pageDigest").catch(() => null);
    const same = (a, b) => a && b && a.title === b.title && a.textLen === b.textLen && a.interactive === b.interactive;
    if (before && after && !same(before, after)) return "navigation SPA (pushState)";
    // Rien n'a suivi : on retire l'entrée ajoutée, pour que la navigation complète charge bien la cible
    // (vers l'adresse affichée, un #fragment ne ferait que défiler) et que « retour » ne tombe pas dessus.
    await cdp(tabId, "Runtime.evaluate", { expression: "history.back()" }).catch(() => null);
    await waitUrl(tabId, cur.href, 1000);
  }
  return null;
}

/** Attend que l'URL de l'onglet vaille `href` (navigation SPA vérifiée, pas supposée). */
async function waitUrl(tabId, href, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const cur = await cdp(tabId, "Runtime.evaluate", { expression: "location.href", returnByValue: true })
      .then((r) => r.result?.value)
      .catch(() => "");
    if (cur === href) return true;
    await sleep(100);
  }
  return false;
}
