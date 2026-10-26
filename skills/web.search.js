/** @skill
{
  "name": "web.search",
  "description": "Recherche web (Google, repli DuckDuckGo) : résultats titre, URL, extrait, plus l'aperçu IA de Google s'il y en a un ; read: N lit aussi le texte des N premières pages.",
  "params": {
    "query": { "type": "string", "required": true, "description": "Requête." },
    "limit": { "type": "number", "default": 8, "description": "Résultats au plus (20 max)." },
    "read": { "type": "number", "default": 0, "description": "Lire aussi les N premières pages (5 max)." },
    "maxChars": { "type": "number", "default": 6000, "description": "Texte gardé par page lue." },
    "site": { "type": "string", "description": "Limiter à un site (ex. has-sante.fr)." },
    "lang": { "type": "string", "default": "fr", "description": "Langue de l'interface et des résultats." },
    "engine": { "type": "string", "default": "google", "enum": ["google", "duckduckgo"] }
  },
  "returns": "{engine, query, overview, knowledge, results: [{title, url, snippet}], pages: [{url, title, text}]}"
}
*/
const query = args.site ? `${args.query} site:${args.site}` : args.query;
const limit = Math.min(Math.max(Math.round(args.limit), 1), 20);

// Résultats Google lus par la structure (titre h3 dans un lien), pas par des classes qui changent souvent.
const GOOGLE = String.raw`(() => {
  if (/\/sorry\//.test(location.pathname) || document.querySelector("form#captcha-form")) return { blocked: "captcha Google (trafic inhabituel)" };
  if (/^consent\./.test(location.hostname)) return { blocked: "page de consentement Google" };
  const results = [];
  const seen = new Set();
  for (const h3 of document.querySelectorAll("#rso h3, #search h3, #botstuff h3")) {
    const a = h3.closest("a[href]");
    if (!a) continue;
    let url = a.href;
    try {
      const u = new URL(url);
      if (/(^|\.)google\./.test(u.hostname) && u.pathname === "/url") url = u.searchParams.get("q") || u.searchParams.get("url") || url;
      const v = new URL(url);
      if (!/^https?:$/.test(v.protocol)) continue;
      if (/(^|\.)google\.[a-z.]+$/.test(v.hostname) && /^\/(search|imgres|webhp)/.test(v.pathname)) continue;
    } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    let box = a;
    while (box.parentElement && !box.parentElement.matches("#rso, #search, #botstuff") && box.parentElement.innerText.length < 1500) box = box.parentElement;
    const sn = box.querySelector(".VwiC3b, [data-sncf], [style*='line-clamp']");
    const snippet = (sn ? sn.innerText : box.innerText.replace(h3.innerText, "")).replace(/\s+/g, " ").trim().slice(0, 320);
    results.push({ title: h3.innerText.trim(), url, snippet });
  }
  // Aperçu IA : son conteneur varie selon le profil ; on part de son titre et on remonte jusqu'au bloc.
  let ov = document.querySelector("[data-attrid='SGEOverview']");
  const head = [...document.querySelectorAll("h1, h2, [role='heading']")].find((h) => /^(Aperçu IA|AI Overview)$/.test(h.innerText.trim()));
  if (!ov && head) {
    ov = head;
    while (ov.parentElement && ov.innerText.length < 400 && !ov.parentElement.matches("body, #rso, #search, #center_col, #rcnt")) ov = ov.parentElement;
  }
  const overview = ov ? ov.innerText.replace(/^(Aperçu IA|AI Overview)\s*/, "").replace(/\n\s*\+\d+\n/g, "\n").replace(/\n{2,}/g, "\n").trim() : "";
  const kp = document.querySelector("#rhs .kno-rdesc span, .kno-rdesc span, #rhs [data-attrid='description']");
  return { results, overview: overview.slice(0, 2500), knowledge: kp ? kp.innerText.trim().slice(0, 600) : "", aiHead: !!head };
})()`;

const DUCK = String.raw`(() => {
  const results = [];
  for (const r of document.querySelectorAll(".result")) {
    if (r.classList.contains("result--ad")) continue;
    const a = r.querySelector("a.result__a");
    if (!a) continue;
    let url = a.href;
    try { url = new URL(url).searchParams.get("uddg") || url; } catch {}
    results.push({ title: a.innerText.trim(), url, snippet: (r.querySelector(".result__snippet")?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 320) });
  }
  return { results, overview: "", knowledge: "" };
})()`;

// Google sert ses résultats dans le HTML : la page est ouverte sans attendre qu'elle se stabilise (l'aperçu IA la
// fait bouger), puis relue tant que les résultats ne sont pas là.
async function readGoogle() {
  let f = await js(GOOGLE);
  for (let i = 0; i < 10 && !f.blocked && !f.results.length; i++) {
    await wait(0.3);
    f = await js(GOOGLE);
  }
  return f;
}

let engine = args.engine;
let found = null;
if (engine === "google") {
  await open(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(args.lang)}&num=${Math.max(limit, 10)}`, { wait: "dom" });
  found = await readGoogle();
  // Profil sans session (navigation privée, machine neuve) : page de consentement, refusée comme partout.
  if (found.blocked && /consentement/.test(found.blocked)) {
    await call("computer", { tabId: tab(), action: "dismiss_consent" });
    await waitFor({ urlContains: "/search", timeout: 8 }).catch(() => {});
    found = await readGoogle();
  }
  // L'aperçu IA s'écrit en flux après les résultats : relu jusqu'à ce que sa longueur ne bouge plus (3 s au plus).
  for (let i = 0, prev = -1; i < 8 && found.aiHead && found.overview.length !== prev; i++) {
    prev = found.overview.length;
    await wait(0.4);
    found = await js(GOOGLE);
  }
  if (found.blocked || !found.results.length) {
    log(`Google : ${found.blocked ?? "aucun résultat lisible"}, repli sur DuckDuckGo.`);
    await close();
    engine = "duckduckgo";
  }
}
if (engine === "duckduckgo") {
  await open(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${args.lang === "fr" ? "fr-fr" : "wt-wt"}`);
  found = await js(DUCK);
}
const results = found.results.slice(0, limit);
const n = Math.min(Math.max(Math.round(args.read), 0), 5);
const pages = n && results.length
  ? await skill("web.read", { urls: results.slice(0, n).map((r) => r.url), maxChars: args.maxChars })
  : [];
return { engine, query, overview: found.overview || "", knowledge: found.knowledge || "", results, pages };
