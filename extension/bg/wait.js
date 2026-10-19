// Agent Browser Control, service worker : wait_for.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// wait_for : attendre une condition plutôt qu'un nombre de secondes
// ---------------------------------------------------------------------------

const inflight = new Map(); // tabId -> { ids: Set, last: instant de la dernière activité réseau }

function trackInflight(tabId, method, params) {
  let state = inflight.get(tabId);
  if (!state) inflight.set(tabId, (state = { ids: new Set(), last: Date.now() }));
  if (method === "Network.requestWillBeSent") state.ids.add(params.requestId);
  else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") state.ids.delete(params.requestId);
  else return;
  state.last = Date.now();
}
chrome.tabs.onRemoved.addListener((tabId) => inflight.delete(tabId));

async function waitFor(agent, args) {
  const { tabId, selector, text: expected, textGone, urlContains, networkIdle, domSettled, authSettled, image, scroll, countStable, settle } = args;
  const tab = await assertOwned(agent, tabId);
  await ensureAttached(tabId);
  const wantImage = image === true;
  const csSel = typeof countStable?.selector === "string" ? countStable.selector : null;
  if (!selector && !expected && !textGone && !urlContains && !networkIdle && !domSettled && !authSettled && !wantImage && !csSel && !settle) {
    throw new Error("Préciser au moins une condition : selector, text, textGone, urlContains, networkIdle, domSettled, settle, countStable, image ou authSettled (scroll seul n'est pas une condition : il accompagne les autres).");
  }
  const maxLimit = authSettled ? 300 : 60;
  const defaultLimit = authSettled ? 120 : 10;
  const limitMs = Math.min(Math.max(args.timeout ?? defaultLimit, 0.5), maxLimit) * 1000;
  const quietMs = networkIdle === true ? 500 : Number(networkIdle) || 0;
  const settleMs = domSettled === true ? 800 : Number(domSettled) || 0;
  // settle : le trio « page prête » (réseau calme + DOM stable + aucun indicateur de
  // chargement) en une condition. networkIdle/domSettled explicites gardent la main.
  const settleAll = settle === true ? 500 : Number(settle) || 0;
  const effQuietMs = quietMs || settleAll;
  const effSettleMs = settleMs || settleAll;
  const scrollCfg = scroll && typeof scroll === "object" ? {
    container: typeof scroll.container === "string" ? scroll.container : null,
    direction: scroll.direction === "up" ? "up" : "down",
    maxScrolls: Math.max(1, Math.min(Number(scroll.maxScrolls) || 30, 200)),
  } : null;
  const csStableMs = Math.max(200, Number(countStable?.stableMs) || 1500);
  const csMin = countStable?.minCount === undefined ? 1 : Math.max(0, Number(countStable.minCount) || 0);

  const run = async () => {
    const started = Date.now();
    let csCount = -1;
    let csSince = started;

  let initialUrl = "";
  try {
    const t = await chrome.tabs.get(tabId);
    initialUrl = t.url ?? "";
  } catch {}
  let enteredAuth = isAuthChallenge(initialUrl);
  if (authSettled && enteredAuth) {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  }

  const probe = `(() => {
    if (!window.__abcObserver) {
      window.__abcLastMutation = Date.now();
      try {
        window.__abcObserver = new MutationObserver(() => {
          window.__abcLastMutation = Date.now();
        });
        window.__abcObserver.observe(document.documentElement || document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      } catch {}
    }
    const sel = ${JSON.stringify(selector ?? null)};
    const el = sel ? document.querySelector(sel) : null;
    const visible = !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const body = document.body ? document.body.innerText : "";
    const textOk = ${JSON.stringify(expected ?? null)} === null || body.includes(${JSON.stringify(expected ?? "")});
    const goneOk = ${JSON.stringify(textGone ?? null)} === null || !body.includes(${JSON.stringify(textGone ?? "")});
    const scrollCfg = ${JSON.stringify(scrollCfg)};
    const countSel = ${JSON.stringify(csSel)};
    // Scroll d'attente : un cran par tour (200 ms) tant que la cible n'est pas là, borné (bout,
    // maxScrolls). La cible, c'est les conditions visibles (selector/text/textGone) : le scroll
    // sert à faire apparaître du contenu paresseux, pas à attendre le réseau ou une URL.
    let scrollInfo;
    if (scrollCfg) {
      window.__abcWaitScrolls = window.__abcWaitScrolls || 0;
      const sc = scrollCfg.container ? document.querySelector(scrollCfg.container) : document.scrollingElement;
      const atEnd = !sc ? true : (scrollCfg.direction === "up" ? sc.scrollTop <= 2 : sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2);
      const capped = window.__abcWaitScrolls >= scrollCfg.maxScrolls;
      const met = (!sel || visible) && textOk && goneOk;
      if (sc && !met && !atEnd && !capped) {
        const step = Math.max(200, sc.clientHeight || 600);
        sc.scrollTop += scrollCfg.direction === "up" ? -step : step;
        window.__abcWaitScrolls++;
      }
      scrollInfo = { done: window.__abcWaitScrolls, atEnd, capped, missing: !sc };
    }
    return {
      visible,
      text: textOk,
      gone: goneOk,
      url: location.href,
      scroll: scrollInfo,
      count: (() => { if (!countSel) return undefined; try { return document.querySelectorAll(countSel).length; } catch { return -1; } })(),
      images: (() => {
        const out = [];
        for (const el of document.querySelectorAll("img, canvas, svg")) {
          if (el.closest("#abc-overlay")) continue;
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          const r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 40) continue;
          if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
          let srcType = "svg";
          let src = "";
          if (el.tagName === "CANVAS") srcType = "canvas";
          else if (el.tagName === "IMG") {
            src = el.currentSrc || el.src || "";
            if (src.indexOf("blob:") === 0) srcType = "blob";
            else if (src.indexOf("data:") === 0) srcType = "data";
            else if (/^https?:/.test(src)) srcType = "http";
            else srcType = (!el.complete || !el.naturalWidth) ? "incomplète" : "http";
          }
          out.push({ tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), srcType, src: String(src).slice(0, 40) });
          if (out.length >= 12) break;
        }
        return out;
      })(),
      spinners: (() => {
        const out = [];
        const seen = {};
        const cands = document.querySelectorAll('[role="progressbar"], [role="status"], [aria-busy="true"], [class*="spinner" i], [class*="loading" i], [class*="loader" i]');
        for (const el of cands) {
          if (out.length >= 3) break;
          const r = el.getBoundingClientRect();
          if (!r.width && !r.height) continue;
          if (getComputedStyle(el).display === "none") continue;
          const t = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
          const key = t || el.tagName;
          if (seen[key]) continue;
          seen[key] = true;
          out.push(t || "(sans texte)");
        }
        return out;
      })(),
      textSample: body.slice(0, 300),
      bodyLen: body.length,
      lastMutation: window.__abcLastMutation || 0,
    };
  })()`;

  let last = {};
  let baseline = null; // premier état observé : le diagnostic dit ce qui a bougé depuis
  const scrollNote = (s) => s ? `, ${s.done} scroll(s)${s.atEnd ? " (bout atteint)" : ""}${s.capped ? " (plafond maxScrolls)" : ""}${s.missing ? " (conteneur introuvable)" : ""}` : "";
  while (true) {
    // Appel annulé (STOP, pause de l'agent, délai du démon) : l'attente s'arrête au lieu de tourner jusqu'au bout.
    if (isHalted(tabId)) throw new Error("Attente annulée.");
    try {
      last = (await cdp(tabId, "Runtime.evaluate", { expression: probe, returnByValue: true })).result?.value ?? {};
    } catch (err) {
      if (err instanceof DialogOpenError || paused || pausedTabs.has(tabId)) throw err;
      last = {}; // page en pleine navigation : on réessaie au tour suivant
    }
    if (!baseline && typeof last.bodyLen === "number") baseline = { bodyLen: last.bodyLen, url: last.url ?? "" };
    const currentUrl = last.url ?? "";
    if (isAuthChallenge(currentUrl)) {
      if (!enteredAuth) {
        enteredAuth = true;
        await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      }
    }
    const isAuth = isAuthChallenge(currentUrl);
    const authOk = !authSettled || (!isAuth && (!enteredAuth || (Date.now() - started >= 500)));

    const net = inflight.get(tabId) ?? { ids: new Set(), last: started };
    const timeSinceMutation = last.lastMutation ? (Date.now() - last.lastMutation) : (Date.now() - started);
    const domSettledOk = !effSettleMs || (Date.now() - started >= Math.min(effSettleMs, 300) && timeSinceMutation >= effSettleMs);
    // Réseau calme : au plus 2 requêtes en cours (connexions longues) et rien de neuf depuis quietMs.
    const netIdleOk = !effQuietMs || (net.ids.size <= 2 && Date.now() - net.last >= effQuietMs);
    if (last.count === -1) throw new Error(`Sélecteur countStable invalide : ${JSON.stringify(csSel)}.`);
    if (csSel && typeof last.count === "number" && last.count !== csCount) {
      csCount = last.count;
      csSince = Date.now();
    }

    const checks = {
      selector: !selector || !!last.visible,
      text: !expected || !!last.text,
      textGone: !textGone || !!last.gone,
      urlContains: !urlContains || currentUrl.includes(urlContains),
      networkIdle: quietMs ? netIdleOk : true,
      domSettled: settleMs ? domSettledOk : true,
      settle: !settleAll || (netIdleOk && domSettledOk && (last.spinners?.length ?? 0) === 0),
      authSettled: authOk,
      countStable: !csSel || (csCount >= csMin && Date.now() - csSince >= csStableMs),
    };
    const elapsed = ((Date.now() - started) / 1000).toFixed(1).replace(".", ",");
    if (Object.values(checks).every(Boolean)) {
      const details = [];
      if (settleAll) details.push(`page stabilisée (réseau calme, DOM stable depuis ${timeSinceMutation} ms, aucun chargement)`);
      else if (settleMs) details.push(`DOM stable depuis ${timeSinceMutation} ms`);
      if (authSettled && enteredAuth) details.push("connexion validée");
      if (csSel) details.push(`${csCount} élément(s) stable(s)`);
      if (scrollCfg && last.scroll) details.push(`${last.scroll.done} scroll(s)`);
      const extra = details.length ? ` (${details.join(", ")})` : "";
      return ok(text(`Condition remplie en ${elapsed} s.${extra}${last.url ? ` URL : ${last.url}` : ""}`));
    }
    if (Date.now() - started >= limitMs) {
      const pending = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ");
      // Échec utile : ce qui a été observé (pas seulement ce qui manque), pour décider
      // de la suite en un tour au lieu de relancer des lectures à l'aveugle.
      const netLag = Date.now() - net.last;
      const diag = [
        `Délai dépassé (${String(limitMs / 1000).replace(".", ",")} s), condition(s) non remplie(s) : ${pending}.${scrollNote(last.scroll)}`,
        `URL actuelle : ${last.url ?? "?"}${baseline && baseline.url && baseline.url !== last.url ? ` (a changé : ${baseline.url})` : ""}`,
        `Réseau : ${net.ids.size} requête(s) en cours, dernière activité il y a ${netLag} ms.`,
        `DOM : dernière mutation il y a ${timeSinceMutation} ms.`,
      ];
      // Ce qui vient de la page (échantillon de texte, libellés de chargement) reste balisé comme non fiable.
      const seen = [];
      if (typeof last.bodyLen === "number") {
        const delta = baseline ? last.bodyLen - baseline.bodyLen : 0;
        diag.push(`Texte : ${last.bodyLen} car.${baseline ? ` (${delta >= 0 ? "+" : ""}${delta} depuis le début)` : ""}`);
        if (last.textSample) seen.push(`Échantillon : ${JSON.stringify(last.textSample.slice(0, 200))}`);
      }
      if (last.spinners?.length) seen.push(`Chargements visibles : ${last.spinners.join(" ; ")}`);
      if (csSel) diag.push(`countStable : ${csCount} élément(s) pour ${JSON.stringify(csSel)} (min ${csMin}), inchangé(s) depuis ${Date.now() - csSince} ms.`);
      if (selector) diag.push(`Sélecteur ${JSON.stringify(selector)} : ${last.visible ? "trouvé mais non visible ?" : "absent du DOM"}.`);
      if (seen.length) diag.push(untrusted(seen.join("\n")));
      return fail(diag.join("\n"));
    }
    await sleep(200);
  }
  };
  // La sonde laisse un observateur et des compteurs dans la page : retirés à la fin de l'attente,
  // pour ne laisser aucune trace détectable (et pour qu'une attente suivante reparte de zéro).
  const cleanup = () => cdp(tabId, "Runtime.evaluate", {
    expression: `(() => { try { window.__abcObserver?.disconnect(); } catch {} try { delete window.__abcObserver; delete window.__abcLastMutation; delete window.__abcWaitScrolls; } catch {} return true; })()`,
    returnByValue: true,
  }).catch(() => {});
  try {
    // Scroll d'attente sur un onglet qui ne peint pas = scroll events qui ne partent pas :
    // on emprunte le premier plan le temps de l'attente (rendu après, comme les gestes souris).
    if (scrollCfg) {
      const paint = await inPage(tabId, "canPaint").catch(() => null);
      if (!paint?.paints) return await withForeground(tab, run);
    }
    return await run();
  } finally {
    await cleanup();
  }
}
