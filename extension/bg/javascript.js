// Agent Browser Control, service worker : outil javascript.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// javascript
// ---------------------------------------------------------------------------

async function javascript(agent, { tabId, code }) {
  await assertOwned(agent, tabId);
  if (typeof code !== "string" || !code.trim()) throw new Error("'code' requis (expression JavaScript à évaluer).");
  // Un secret rempli par credentials_fill ne doit jamais revenir à l'agent : tant qu'un de ces champs est
  // dans la page avec sa valeur, pas de JavaScript arbitraire (qui pourrait le lire).
  if (await inPage(tabId, "hasLiveSecret").catch(() => false)) {
    throw new Error("Un champ rempli par credentials_fill contient encore son secret sur cette page : javascript est refusé tant qu'il est là. Soumettre le formulaire (ou naviguer) d'abord.");
  }
  const run = (expression) => cdp(tabId, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    userGesture: true,
    replMode: true,
  });
  let expression = code;
  let res = await run(expression);
  // Code refusé mais récupérable (const/let redéclarés, return de premier niveau) : on rejoue
  // une expression corrigée (voir js-eval.js). 2 essais max : le 2e couvre un code qui combine
  // les deux erreurs. Une erreur de syntaxe ne produit aucun effet de bord, rejouer est sans risque.
  for (let attempt = 0; attempt < 2; attempt++) {
    const desc = res.exceptionDetails?.exception?.description ?? res.exceptionDetails?.text ?? "";
    const retry = desc ? AbcJsEval.jsRetry(expression, desc) : null;
    if (!retry) break;
    expression = retry;
    res = await run(expression);
  }
  // En mode REPL, une promesse renvoyée par l'expression (ex. fonction async) n'est pas attendue.
  if (!res.exceptionDetails && res.result.subtype === "promise") {
    res = await cdp(tabId, "Runtime.awaitPromise", { promiseObjectId: res.result.objectId });
  }
  if (res.exceptionDetails) {
    const desc = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
    return fail(`Exception : ${desc}`);
  }
  // Un Element (ou une liste d'Elements) renvoyé par le script devient des refs
  // utilisables par les autres outils, au lieu d'une description inexploitable.
  const asRefs = await serializeNodesAsRefs(tabId, res.result).catch(() => null);
  if (asRefs) {
    await recordFrame(tabId, "javascript");
    return ok(text(untrusted(asRefs)));
  }
  let out = await serializeRemote(tabId, res.result);
  await recordFrame(tabId, "javascript");
  if (out.length > 50_000) {
    // Plus de mur à 50k : le complet part en fichier, l'agent reçoit l'aperçu + les comptes.
    const preview = `Résultat volumineux (${out.length} caractères), aperçu (3000 premiers) :\n` +
      `${out.slice(0, 3000)}\n…\nContenu complet dans le fichier : {path} (relire avec read_document)`;
    return attachBigFile(out, "javascript", "txt", untrusted(preview));
  }
  return ok(text(untrusted(out)));
}

/**
 * Nœud(s) DOM distant(s) vers refs : marque chaque Element depuis le monde principal
 * (attribut temporaire, le DOM est partagé avec le monde isolé), puis demande à page.js
 * de l'enregistrer comme ref. Renvoie null si la valeur n'est pas (que) des Elements.
 */
async function serializeNodesAsRefs(tabId, r) {
  if (r?.abcMarked) return nodeRefsText(tabId, r.abcMarked); // repli sans debugger : marqués dans la page (cdp-fallback.js)
  if (!r || !r.objectId) return null;
  const single = r.subtype === "node";
  const plural = r.subtype === "array" || ["NodeList", "HTMLCollection", "HTMLAllCollection"].includes(r.className);
  if (!single && !plural) return null;
  const { result } = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId: r.objectId,
    functionDeclaration: `function () {
      const els = (this instanceof Element) ? [this] : (typeof this.length === "number" ? [...this] : []);
      if (!els.length || !els.every((e) => e instanceof Element)) return null;
      const stamp = Date.now().toString(36);
      return { total: els.length, keys: els.slice(0, 20).map((e, i) => { const k = "abc" + stamp + "n" + i; e.setAttribute("data-abc-js", k); return k; }) };
    }`,
    returnByValue: true,
  });
  const marked = result?.value;
  // Pas que des Elements : on laisse serializeRemote répondre (et libérer l'objet).
  if (!marked) return null;
  try {
    return await nodeRefsText(tabId, marked);
  } finally {
    cdp(tabId, "Runtime.releaseObject", { objectId: r.objectId }).catch(() => {}); // objet consommé
  }
}

/** Elements marqués data-abc-js (clés) vers refs de page.js, puis ménage des marquages restants. */
async function nodeRefsText(tabId, marked) {
  try {
    const lines = [];
    for (const key of marked.keys) lines.push(`- ${await inPage(tabId, "refForKey", { key })}`);
    const head = marked.total === 1 ? "Élément renvoyé comme ref :" : `${marked.total} élément(s) renvoyé(s) comme refs :`;
    const tail = marked.total > marked.keys.length ? `\n(${marked.total - marked.keys.length} élément(s) au-delà de la limite de 20, non enregistrés)` : "";
    return `${head}\n${lines.join("\n")}${tail}`;
  } finally {
    // Ménage des marquages restants (élément retiré du DOM entre-temps…).
    evaluateCall(tabId, () => document.querySelectorAll("[data-abc-js]").forEach((e) => e.removeAttribute("data-abc-js"))).catch(() => {});
  }
}

/** Valeur lisible d'un objet distant : JSON si possible, sinon sa description (nœud DOM, fonction…). */
async function serializeRemote(tabId, r) {
  if (r.type === "undefined") return "undefined";
  if ("value" in r) return typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2);
  if (!r.objectId || r.subtype === "node" || r.type === "function") return r.description ?? `[${r.type}]`;
  try {
    const { result } = await cdp(tabId, "Runtime.callFunctionOn", {
      objectId: r.objectId,
      functionDeclaration: "function () { return this; }",
      returnByValue: true,
    });
    return JSON.stringify(result.value, null, 2) ?? r.description;
  } catch {
    return r.description ?? `[${r.type}]`; // non sérialisable (références circulaires…)
  } finally {
    cdp(tabId, "Runtime.releaseObject", { objectId: r.objectId }).catch(() => {});
  }
}
