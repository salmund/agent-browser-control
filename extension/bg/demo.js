// Agent Browser Control, service worker : mode démonstration.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

/** Enregistrements de démonstration : tabId -> { agent, startedAt, startUrl, navs }. */
const demoRecording = new Map();

chrome.tabs.onRemoved.addListener((tabId) => demoRecording.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const rec = demoRecording.get(tabId);
  if (rec && info.url) rec.navs.push(info.url);
});

/**
 * Mode démonstration : start enregistre le parcours montré (clics, saisies hors
 * mots de passe, sélections, navigations) ; stop renvoie les étapes, le code
 * browser_script rejouable et une note de playbook suggérée. Cadre principal
 * uniquement ; une navigation complète perd le détail intra-page (URLs gardées).
 */
async function demo(agent, { tabId, action = "start" }) {
  const tab = await assertOwned(agent, tabId);
  if (action === "start") {
    const existing = demoRecording.get(tabId);
    if (existing) throw new Error(`Enregistrement déjà en cours depuis ${Math.round((Date.now() - existing.startedAt) / 1000)} s (demo stop pour finir).`);
    const msg = await inPage(tabId, "startRecord");
    await bringToFront(tab);
    demoRecording.set(tabId, { agent, startedAt: Date.now(), startUrl: tab.url ?? "", navs: [] });
    return ok(text(`${msg}\nL'onglet est devant : montrez le parcours, puis demo stop.`));
  }
  if (action !== "stop") throw new Error(`action attendue : start, stop.`);
  const rec = demoRecording.get(tabId);
  if (!rec) throw new Error("Aucun enregistrement en cours pour cet onglet (demo start d'abord).");
  demoRecording.delete(tabId);
  let steps = [];
  let truncated = false;
  let lostDetail = false;
  try {
    const res = await inPage(tabId, "stopRecord");
    steps = res.steps ?? [];
    truncated = !!res.truncated;
  } catch {
    lostDetail = true; // navigation complète : nouveau document, enregistreur page perdu.
  }
  if (!steps.length && !rec.navs.length) {
    return ok(text("Rien enregistré (aucun clic, saisie ni navigation). Relancer demo start et montrer le parcours."));
  }
  // Chronologie : navigations intercalées aux étapes page (horodatées).
  const navs = rec.navs.filter((u, i) => i === 0 || u !== rec.navs[i - 1]);
  const lines = [`Démonstration (${steps.length} étape(s)${navs.length ? `, ${navs.length} navigation(s)` : ""}) :`];
  const code = ["// Démo rejouable : vérifier les sélecteurs et les À-COMPLÉTER avant usage."];
  let needsClic = false;
  const emitClickHelper = () => {
    if (needsClic) return;
    needsClic = true;
    code.push(`async function clic(recherche) { const r = await find(recherche); if (!r.matches.length) throw new Error("Introuvable : " + recherche); await click(r.matches[0].ref); }`);
  };
  let stepNo = 0;
  for (const s of steps) {
    stepNo++;
    if (s.kind === "click") {
      lines.push(`${stepNo}. Clic ${s.role}${s.name ? ` « ${s.name} »` : ""}${s.href ? ` (${s.href})` : ""}`);
      if (s.name) {
        emitClickHelper();
        code.push(`await clic(${JSON.stringify(s.name)});`);
      } else if (s.selector) {
        code.push(`await js("document.querySelector(" + ${JSON.stringify(s.selector)} + ").click()");`);
      }
    } else if (s.kind === "type") {
      if (s.masked) {
        lines.push(`${stepNo}. Saisie (mot de passe masqué, ${s.selector || "champ"})`);
        code.push(`await js("document.querySelector(" + ${JSON.stringify(s.selector || "")} + ").focus()");`, `await type("À-COMPLÉTER"); // mot de passe`);
      } else {
        lines.push(`${stepNo}. Saisie ${JSON.stringify((s.value ?? "").slice(0, 100))} (${s.selector || "champ"})`);
        code.push(`await js("document.querySelector(" + ${JSON.stringify(s.selector || "")} + ").focus()");`, `await type(${JSON.stringify(s.value ?? "")});`);
      }
    } else if (s.kind === "select") {
      lines.push(`${stepNo}. Sélection ${JSON.stringify(s.value)} (${s.selector || "liste"})`);
      code.push(`await js(String.raw\`{ const el = document.querySelector(${JSON.stringify(s.selector || "")}); el.value = ${JSON.stringify(s.value ?? "")}; el.dispatchEvent(new Event("change", { bubbles: true })); }\`);`);
    } else if (s.kind === "check") {
      lines.push(`${stepNo}. Case ${s.checked ? "cochée" : "décochée"} (${s.selector || "case"})`);
      code.push(`await js(String.raw\`{ const el = document.querySelector(${JSON.stringify(s.selector || "")}); el.click(); }\`);`);
    }
  }
  for (const u of navs) {
    stepNo++;
    lines.push(`${stepNo}. Navigation : ${u}`);
    code.push(`await nav(${JSON.stringify(u)});`);
  }
  if (truncated) lines.push("(Étapes tronquées à 200 : découper la démo.)");
  if (lostDetail) lines.push("(Navigation complète : détail intra-page perdu, URLs conservées.)");
  // Appels JSON croisés pendant la démo : pistes pour site_api.
  const apis = demoApis(tabId, rec.startedAt);
  if (apis.length) lines.push(`Appels JSON pendant la démo : ${apis.join(" · ")} (devtools action="har" op="bodies", site_api save_call).`);
  const host = (() => { try { return new URL(rec.startUrl).hostname; } catch { return ""; } })();
  lines.push(
    "",
    "Code browser_script :",
    "```js",
    ...code,
    "return \"demo-ok\";",
    "```",
    "",
    "Note de playbook suggérée :",
    `- Parcours enregistré (${new Date(rec.startedAt).toLocaleString("fr-FR")}) : ${rec.startUrl} (${steps.length} étapes${navs.length ? `, ${navs.length} navigations` : ""}).`,
    "- Rejouer : browser_script avec la macro (revoir sélecteurs et À-COMPLÉTER).",
    `Enregistrer : site_api save_macro { site: "${host || "…"}", name: "…", code: <ci-dessus> }.`,
  );
  return ok(text(untrusted(lines.join("\n"))));
}

/** Appels JSON (XHR/fetch) de l'onglet depuis `since`, groupés : pistes save_call. */
function demoApis(tabId, since) {
  const groups = new Map();
  for (const e of networkLogs.get(tabId)?.values() ?? []) {
    if ((e.t ?? 0) < since) continue;
    if (!["XHR", "Fetch"].includes(e.type) || !(e.status && e.status >= 200 && e.status < 300)) continue;
    let path = e.url;
    try {
      path = new URL(e.url).pathname;
    } catch {}
    const key = `${e.method} ${path}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} (${n})`);
}
