// Agent Browser Control, service worker : outil computer.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

async function computer(agent, args) {
  const { tabId } = args;
  const tab = await assertOwned(agent, tabId);
  if (Array.isArray(args.steps) && args.steps.length) return runSteps(agent, tab, args);
  const wantEffect = args.action !== "screenshot"; // une lecture ne change rien : pas de constat
  const since = Date.now();
  const before = wantEffect ? await inPage(tabId, "pageDigest").catch(() => null) : null;
  const res = await computerAction(agent, tab, args);
  if (wantEffect) await appendActionEffect(tabId, res, before, since);
  if (args.snapshot || args.then || args.diff) {
    return attachActionSnapshot(agent, tabId, args, res, since);
  }
  return res;
}

/**
 * Batch : plusieurs actions computer en un appel (une seule prise d'onglet), exécutées en
 * séquence avec digest numérique avant/après chaque étape (URL, titre, volume de texte,
 * interactifs). Arrêt à la première erreur, avec le récapitulatif des étapes déjà exécutées.
 * snapshot/then/diff de haut niveau s'appliquent à l'état FINAL. 'screenshot' interdit en étape
 * (images : faire une capture séparée).
 */
async function runSteps(agent, tab, args) {
  const { tabId, steps } = args;
  if (steps.length > 20) throw new Error("'steps' : 20 étapes au plus par appel.");
  const digestOf = () => inPage(tabId, "pageDigest").catch(() => null);
  const lines = [];
  let before = await digestOf();
  lines.push(`Digest initial : ${formatDigest(before)}.`);
  for (let i = 0; i < steps.length; i++) {
    const st = { tabId, ...(typeof args.human === "boolean" && { human: args.human }), ...steps[i] };
    const tag = st.action ?? "?";
    try {
      if (!st.action || typeof st.action !== "string") throw new Error(`Étape ${i + 1} : 'action' manquante.`);
      if (st.action === "screenshot") throw new Error(`Étape ${i + 1} : 'screenshot' interdit dans steps (faire une capture séparée).`);
      if (st.steps) throw new Error(`Étape ${i + 1} : steps imbriqués interdits.`);
      const r = await computerAction(agent, tab, st);
      const msg = r.content.map((c) => c.text ?? "").join(" ").replace(/\s+/g, " ").slice(0, 300);
      const after = await digestOf();
      lines.push(`Étape ${i + 1}/${steps.length} [${tag}${st.ref ? ` ${st.ref}` : ""}] : ${msg} Δ ${formatDelta(before, after)}`);
      before = after;
    } catch (e) {
      lines.push(`Étape ${i + 1}/${steps.length} [${tag}] ÉCHEC : ${e.message} (arrêt, ${i} étape(s) déjà exécutée(s))`);
      return fail(lines.join("\n"));
    }
  }
  const res = ok(text(lines.join("\n")));
  if (args.snapshot || args.then || args.diff) {
    return attachActionSnapshot(agent, tabId, args, res);
  }
  return res;
}

function formatDigest(d) {
  if (!d) return "digest indisponible";
  return `« ${pageLabel(d.title, 40)} », ${d.textLen} car., ~${d.interactive} interactifs`;
}

function formatDelta(a, b) {
  if (!a || !b) return "digest indisponible";
  const parts = [];
  if (a.url !== b.url) parts.push(`url → ${b.url.slice(0, 80)}`);
  if (a.title !== b.title) parts.push(`titre → « ${pageLabel(b.title, 40)} »`);
  const dt = b.textLen - a.textLen;
  if (dt) parts.push(`${dt > 0 ? "+" : ""}${dt} car.`);
  else if (a.textHash !== undefined && a.textHash !== b.textHash) parts.push("texte modifié (même longueur)");
  const df = (b.formLen || 0) - (a.formLen || 0);
  if (df) parts.push(`champs ${df > 0 ? "+" : ""}${df} car.`);
  const di = b.interactive - a.interactive;
  if (di) parts.push(`${di > 0 ? "+" : ""}${di} interactifs`);
  return parts.length ? parts.join(", ") : "inchangé";
}

/**
 * Effet constaté, gratuit : digest avant/après chaque action, sans tour LLM.
 * L'agent n'a plus à relire la page « pour voir si ça a marché » : navigation,
 * contenu apparu/disparu et interactifs sont constatés dans la réponse reçue.
 * Inopérant si la réponse n'a pas de partie texte (captures : pas de constat).
 */
/**
 * Ce que l'action a déclenché à côté de la page elle-même, depuis `since` : erreurs JavaScript,
 * requêtes en échec, boîte de dialogue, nouvel onglet ou popup, téléchargement. Sans ça, l'agent
 * voit « inchangé » et réessaie, alors que le site a répondu par une erreur 500 ou une popup.
 */
function sideEffects(tabId, since) {
  const parts = [];
  const quoted = [];
  // Les échecs de chargement (Log source « network ») sont déjà comptés parmi les requêtes en échec.
  const errors = (consoleLogs.get(tabId) ?? []).filter((m) => m.level === "error" && m.t >= since && m.kind !== "network");
  if (errors.length) {
    parts.push(`${errors.length} erreur(s) JavaScript`);
    quoted.push(`Erreur JS : ${errors[0].text.slice(0, 160)}`);
  }
  const failed = [...(networkLogs.get(tabId)?.values() ?? [])].filter((r) =>
    r.t >= since && ["XHR", "Fetch", "Document"].includes(r.type) && ((r.status ?? 0) >= 400 || (r.error && r.error !== "canceled")));
  if (failed.length) {
    const r = failed.at(-1);
    let path = r.url;
    try {
      path = new URL(r.url).pathname.replace(/[^\w/.\-:~%@]/g, "").slice(0, 80);
    } catch {}
    parts.push(`${failed.length} requête(s) en échec (dernière : ${r.method} ${path} → ${r.error ? r.error.slice(0, 40) : r.status})`);
  }
  if (dialogs.has(tabId)) parts.push(`boîte ${dialogs.get(tabId).type} ouverte (répondre avec handle_dialog)`);
  const opened = recentlyOpened.filter((o) => o.opener === tabId && o.t >= since);
  if (opened.length) parts.push(`${opened.length} onglet(s) ouvert(s) par la page : ${opened.map((o) => `tabId ${o.id}${o.popup ? " (fenêtre popup)" : ""}`).join(", ")}`);
  const dl = [...agentDownloads.entries()].filter(([, d]) => d.tabId === tabId && d.t >= since);
  if (dl.length) parts.push(`${dl.length} téléchargement(s) lancé(s) (downloads action="wait" pour l'attendre)`);
  if (!parts.length) return "";
  return `\nAussi : ${parts.join(" ; ")}.${quoted.length ? `\n${untrusted(quoted.join("\n"))}` : ""}`;
}

/** API de refus des gestionnaires de consentement courants, appelées dans le monde de la page. */
const CMP_REJECT_SOURCE = `(() => {
  const tries = [
    ["Didomi", () => window.Didomi?.setUserDisagreeToAll && (window.Didomi.setUserDisagreeToAll(), true)],
    ["OneTrust", () => window.OneTrust?.RejectAll && (window.OneTrust.RejectAll(), true)],
    ["Cookiebot", () => window.Cookiebot?.decline && (window.Cookiebot.decline(), true)],
    ["Usercentrics", () => window.UC_UI?.denyAllConsents && (window.UC_UI.denyAllConsents(), true)],
    ["tarteaucitron", () => window.tarteaucitron?.userInterface?.respondAll && (window.tarteaucitron.userInterface.respondAll(false), true)],
  ];
  for (const [name, fn] of tries) {
    try { if (fn()) return name; } catch {}
  }
  return null;
})()`;

/**
 * Ferme la bannière de cookies en refusant les cookies non essentiels : bouton de refus (page principale,
 * puis iframes de la bannière), sinon API du gestionnaire de consentement. Vérifie ensuite la disparition.
 */
async function dismissConsent(tabId) {
  let res = await inPage(tabId, "dismissConsent").catch((err) => ({ dismissed: false, error: err.message }));
  if (!res?.dismissed) {
    const frames = await inAllFrames(tabId, "dismissConsent").catch(() => []);
    const hit = frames.find((f) => f.frameId !== 0 && f.value?.dismissed);
    if (hit) res = { ...hit.value, frame: true };
  }
  if (!res?.dismissed) {
    const api = await evaluate(tabId, CMP_REJECT_SOURCE).catch(() => null);
    if (api) res = { dismissed: true, how: `API ${api}` };
  }
  await sleepForFrame(tabId, 400);
  const still = await inPage(tabId, "blockingOverlay").catch(() => null);
  await recordFrame(tabId, "dismiss_consent");
  if (res?.dismissed && !still?.consent) {
    return ok(text(`Bannière de cookies fermée en refusant les cookies non essentiels (${pageLabel(res.how, 80) || "bouton de refus"}${res.frame ? ", dans une iframe" : ""}).`));
  }
  if (res?.dismissed) {
    return ok(text(`Refus envoyé (${pageLabel(res.how, 80)}), mais une bannière recouvre encore la page : relire avec read_page (une seconde étape, comme « Confirmer mes choix », est peut-être nécessaire).`));
  }
  if (!still) return ok(text("Aucune bannière de cookies détectée sur la page."));
  return fail(`Bannière trouvée mais aucun bouton de refus reconnu${res?.error ? ` (${res.error})` : ""} : la traiter avec read_page puis computer left_click sur le bon bouton.`);
}

async function appendActionEffect(tabId, res, before, since = Date.now() - 2000) {
  const first = res.content.find((c) => c.type === "text");
  if (!first || first.type !== "text") return res;
  // Navigation partie avec le clic : attendre la page prête pour constater le bon état
  // (sinon le digest lit l'ancienne page). Sans navigation : une seule lecture, pas d'attente.
  await sleep(120); // laisse aussi aux transitions le temps de s'amorcer (menus, accordéons)
  try {
    const tabNow = await chrome.tabs.get(tabId).catch(() => null);
    if (tabNow && tabNow.status === "loading") {
      await waitForReady(tabId, { assumeNavigated: true }).catch(() => {});
    }
  } catch {}
  // Requêtes lancées par l'action et encore sans réponse : on leur laisse un instant (800 ms au plus),
  // pour signaler un échec (erreur 500 d'un « Ajouter au panier ») plutôt qu'un « inchangé » trompeur.
  const pending = () => [...(networkLogs.get(tabId)?.values() ?? [])]
    .some((r) => r.t >= since && ["XHR", "Fetch"].includes(r.type) && r.status == null && !r.error);
  for (let waited = 0; waited < 800 && pending(); waited += 100) await sleep(100);
  const after = await inPage(tabId, "pageDigest").catch(() => null);
  const delta = formatDelta(before, after);
  first.text += `\nEffet : ${delta}${delta.endsWith(".") ? "" : "."}${sideEffects(tabId, since)}`;
  return res;
}

/** human (réglage « Souris réelle » actif) : true impose le vrai pointeur pour ce geste, false l'écarte (pointer.js). */
async function computerAction(agent, tab, args) {
  if (typeof args.human === "boolean") pointerHumanArg.set(tab.id, args.human);
  try {
    return await computerGesture(agent, tab, args);
  } finally {
    pointerHumanArg.delete(tab.id);
  }
}

async function computerGesture(agent, tab, args) {
  const { tabId, action } = args;
  if (!action) throw new Error("Préciser 'action' ou 'steps'.");
  if (action !== "wait") await bringToFront(tab);
  const modifiers = modifierMask(args.modifiers);

  let res;
  switch (action) {
    case "screenshot":
      if (args.ref && !args.region) return screenshot(tabId, { ...args, region: await refRegion(tabId, args.ref) });
      return screenshot(tabId, args);

    case "dismiss_consent":
      return dismissConsent(tabId);

    case "left_click":
    case "right_click":
    case "double_click":
    case "triple_click": {
      const point = await targetPoint(tabId, args);
      await assertHit(tabId, args.ref, point);
      await showOverlay(tabId, point);
      const button = action === "right_click" ? "right" : "left";
      const count = { double_click: 2, triple_click: 3 }[action] ?? 1;
      await click(tabId, point, button, count, modifiers, args.ref);
      await sleepForFrame(tabId, 150);
      await recordFrame(tabId, action, point);
      res = ok(text(`${action} en (${point.x}, ${point.y}).${healNote(point)}${pointerNote(tabId)}`));
      break;
    }

    case "left_click_drag": {
      let points;
      if (Array.isArray(args.path)) {
        points = args.path.map((p) => ({ x: Number(p[0]), y: Number(p[1]) }));
        if (points.length < 2 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
          throw new Error("'path' doit être une liste d'au moins deux points [x, y].");
        }
      } else {
        if (!Array.isArray(args.start_coordinate)) throw new Error("'start_coordinate' [x, y] (ou 'path') requis.");
        points = [{ x: args.start_coordinate[0], y: args.start_coordinate[1] }, await targetPoint(tabId, args)];
      }
      const [from, to] = [points[0], points.at(-1)];
      await showOverlay(tabId, from);
      await inPage(tabId, "gestureStart").catch(() => {});
      await drag(tabId, points, modifiers);
      const received = await inPage(tabId, "gestureEnd").catch(() => []);
      await showOverlay(tabId, to);
      await recordFrame(tabId, action, to);
      const via = points.length > 2 ? ` en passant par ${points.length - 2} point(s)` : "";
      const stray = strayPointerEvents(received, points);
      const warning = stray
        ? `\n⚠ Geste probablement perturbé : la page a reçu ${stray} position(s) de pointeur loin du tracé, sans doute ` +
          "la souris de l'utilisateur. Vérifier le résultat (capture) et recommencer quand il ne la touche plus."
        : "";
      res = ok(text(`Glisser de (${from.x}, ${from.y}) à (${to.x}, ${to.y})${via}.${warning}${pointerNote(tabId)}`));
      break;
    }

    case "hover": {
      const point = await targetPoint(tabId, args);
      await assertHit(tabId, args.ref, point);
      await showOverlay(tabId, point);
      if (!(await pointerGesture(tabId, { action: "move", point, ref: args.ref }))) {
        await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, modifiers });
      }
      // Après restitution de l'onglet (le mouseleave qui suit ferme les menus), on rejoue
      // le survol par événements : les menus JS restent ouverts en arrière-plan.
      const seq = (hoverSeq.get(tabId) ?? 0) + 1;
      hoverSeq.set(tabId, seq);
      setTimeout(() => {
        if (hoverSeq.get(tabId) === seq) inPage(tabId, "hoverEvents", { x: point.x, y: point.y }).catch(() => null);
      }, FRONT_HOLD_MS + 400);
      await recordFrame(tabId, action, point);
      res = ok(text(`Survol en (${point.x}, ${point.y}).${healNote(point)}${pointerNote(tabId)}`));
      break;
    }

    case "type": {
      if (typeof args.text !== "string") throw new Error("'text' manquant.");
      let heal = "";
      if (args.ref || args.coordinate) {
        const point = await targetPoint(tabId, args);
        heal = healNote(point);
        await assertHit(tabId, args.ref, point);
        await showOverlay(tabId, point);
        await click(tabId, point, "left", 1, 0, args.ref);
      } else {
        await showOverlay(tabId);
      }
      // Sans champ de saisie actif, le texte part vers la page : les applis le prennent pour des raccourcis.
      const focus = await evaluate(tabId, `(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "aucun";
        if (el.tagName === "IFRAME") return "iframe";
        return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? "champ" : el.tagName.toLowerCase();
      })()`).catch(() => "inconnu");
      await cdp(tabId, "Input.insertText", { text: args.text });
      await recordFrame(tabId, "type");
      const warning = ["champ", "iframe", "inconnu"].includes(focus)
        ? ""
        : `\n⚠ Aucun champ de saisie n'avait le focus (élément actif : ${focus}) : le texte est parti vers la page, ` +
          "où il a pu déclencher des raccourcis clavier. Cliquer d'abord dans le champ (ref), puis vérifier.";
      res = ok(text(`Texte saisi (${args.text.length} caractères).${heal}${warning}`));
      break;
    }

    case "key": {
      if (!args.text) throw new Error("'text' manquant (ex. 'Enter', 'ctrl+a').");
      await showOverlay(tabId);
      await pressKeys(tabId, args.text);
      await sleepForFrame(tabId, 100);
      await recordFrame(tabId, `key ${args.text}`);
      res = ok(text(`Touches envoyées : ${args.text}`));
      break;
    }

    case "scroll": {
      const point =
        args.ref || args.coordinate
          ? await targetPoint(tabId, args)
          : await evaluate(tabId, "({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) })");
      await showOverlay(tabId);
      const amount = (args.scroll_amount ?? 3) * 100;
      const dir = args.scroll_direction ?? "down";
      const deltaX = dir === "left" ? -amount : dir === "right" ? amount : 0;
      const deltaY = dir === "up" ? -amount : dir === "down" ? amount : 0;
      if (!(await pointerGesture(tabId, { action: "wheel", point, deltaX, deltaY }))) {
        await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY, modifiers });
      }
      await sleepForFrame(tabId, 300);
      await recordFrame(tabId, `scroll ${dir}`);
      res = ok(text(`Défilement ${dir} de ${amount}px en (${point.x}, ${point.y}).${healNote(point)}${pointerNote(tabId)}`));
      break;
    }

    case "scroll_to": {
      if (!args.ref) throw new Error("'ref' requis.");
      const point = await locateRef(tabId, args.ref);
      await showOverlay(tabId, point);
      await recordFrame(tabId, `scroll_to ${args.ref}`);
      res = ok(text(`${args.ref} amené à l'écran, centre en (${point.x}, ${point.y}).${healNote(point)}`));
      break;
    }

    case "wait": {
      const seconds = Math.min(Math.max(args.duration ?? 1, 0), 30);
      if (recordings.has(tabId)) await recordingWait(tabId, seconds);
      else await sleep(seconds * 1000);
      return ok(text(`Attente de ${seconds}s terminée.`));
    }

    default:
      throw new Error(`Action inconnue : ${action}`);
  }

  return res;
}
