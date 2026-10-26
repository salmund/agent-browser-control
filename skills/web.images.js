/** @skill
{
  "name": "web.images",
  "description": "Recherche d'images (Google Images, repli Bing Images) : pour chaque image, titre, URL de l'image en pleine taille, miniature, page d'origine et dimensions.",
  "params": {
    "query": { "type": "string", "required": true, "description": "Requête." },
    "limit": { "type": "number", "default": 12, "description": "Images au plus (50 max)." },
    "size": { "type": "string", "default": "any", "enum": ["any", "large", "medium", "wallpaper"] },
    "type": { "type": "string", "default": "any", "enum": ["any", "photo", "clipart", "line", "transparent"], "description": "line : dessins au trait, schémas." },
    "site": { "type": "string", "description": "Limiter à un site (ex. wikimedia.org)." },
    "lang": { "type": "string", "default": "fr", "description": "Langue de l'interface et des résultats." },
    "engine": { "type": "string", "default": "google", "enum": ["google", "bing"] }
  },
  "returns": "{engine, query, results: [{title, image, thumb, page, width, height, source}]}"
}
*/
const query = args.site ? `${args.query} site:${args.site}` : args.query;
const limit = Math.min(Math.max(Math.round(args.limit), 1), 50);

// Google : chaque vignette porte data-docid et data-lpage (page d'origine) ; les données de la page associent ce
// docid à [miniature, hauteur, largeur] puis [image pleine taille, hauteur, largeur]. Ni clic ni classe CSS.
const GOOGLE = String.raw`((max) => {
  if (/\/sorry\//.test(location.pathname) || document.querySelector("form#captcha-form")) return { blocked: "captcha Google (trafic inhabituel)" };
  if (/^consent\./.test(location.hostname)) return { blocked: "page de consentement Google" };
  const data = [...document.scripts].map((s) => s.textContent).join("\n");
  const dec = (s) => { try { return JSON.parse('"' + s + '"'); } catch { return s; } };
  const results = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("[data-docid][data-lpage]")) {
    if (results.length >= max) break;
    const id = el.getAttribute("data-docid");
    if (seen.has(id)) continue;
    seen.add(id);
    const at = data.indexOf('"' + id + '",["');
    if (at < 0) continue;
    const m = /^"[^"]+",\["([^"]+)",(\d+),(\d+)\],\["([^"]+)",(\d+),(\d+)\]/.exec(data.slice(at, at + 4000));
    if (!m) continue;
    const page = el.getAttribute("data-lpage");
    let source = "";
    try { source = new URL(page).hostname.replace(/^www\./, ""); } catch {}
    const lines = el.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
    results.push({ title: lines[0] || "", image: dec(m[4]), thumb: dec(m[1]), page, width: +m[6], height: +m[5], source });
  }
  return { results };
})(${limit})`;

// Bing : chaque vignette porte ses métadonnées en JSON dans l'attribut m (murl : image, turl : miniature, purl : page).
const BING = String.raw`((max) => {
  const results = [];
  for (const a of document.querySelectorAll("a.iusc")) {
    if (results.length >= max) break;
    let m;
    try { m = JSON.parse(a.getAttribute("m")); } catch { continue; }
    if (!m || !m.murl) continue;
    const card = a.closest("li, .iuscp, .imgpt");
    const info = card ? (card.querySelector(".img_info, .infnmpt") || {}).innerText || "" : "";
    const dim = /(\d+)\s*[×x]\s*(\d+)/.exec(info);
    let source = "";
    try { source = new URL(m.purl).hostname.replace(/^www\./, ""); } catch {}
    results.push({ title: (m.t || m.desc || "").trim(), image: m.murl, thumb: m.turl, page: m.purl, width: dim ? +dim[1] : null, height: dim ? +dim[2] : null, source });
  }
  return { results };
})(${limit})`;

// La collecte est bornée dans la page (limit) : une réponse trop longue serait tronquée, donc illisible.
async function extract(code) {
  const once = async () => {
    const r = await js(code);
    return r && Array.isArray(r.results) ? r : { results: [], blocked: r && r.blocked };
  };
  let found = await once();
  for (let i = 0; i < 6 && !found.blocked && !found.results.length; i++) {
    await wait(0.5);
    found = await once();
  }
  return found;
}

let engine = args.engine;
let found = null;
if (engine === "google") {
  const tbs = [];
  if (args.size !== "any") tbs.push(args.size === "medium" ? "isz:m" : "isz:l");
  if (args.type !== "any") tbs.push({ photo: "itp:photo", clipart: "itp:clipart", line: "itp:lineart", transparent: "ic:trans" }[args.type]);
  await open(`https://www.google.com/search?q=${encodeURIComponent(query)}&udm=2&hl=${encodeURIComponent(args.lang)}${tbs.length ? `&tbs=${encodeURIComponent(tbs.join(","))}` : ""}`, { wait: "dom" });
  found = await extract(GOOGLE);
  if (found.blocked && /consentement/.test(found.blocked)) {
    await call("computer", { tabId: tab(), action: "dismiss_consent" });
    await waitFor({ urlContains: "/search", timeout: 8 }).catch(() => {});
    found = await extract(GOOGLE);
  }
  if (found.blocked || !found.results.length) {
    log(`Google Images : ${found.blocked ?? "aucune image lisible"}, repli sur Bing.`);
    await close();
    engine = "bing";
  }
}
if (engine === "bing") {
  const filters = [];
  if (args.size !== "any") filters.push(`+filterui:imagesize-${args.size}`);
  if (args.type !== "any") filters.push(`+filterui:photo-${{ photo: "photo", clipart: "clipart", line: "linedrawing", transparent: "transparent" }[args.type]}`);
  const qft = filters.length ? `&qft=${encodeURIComponent(filters.join(""))}` : "";
  await open(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1${qft}`, { wait: "dom" });
  found = await extract(BING);
}
return { engine, query, results: found.results.slice(0, limit) };
