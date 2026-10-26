/** @skill
{
  "name": "web.videos",
  "description": "Recherche de vidéos YouTube : titre, URL, chaîne, durée, vues, date et début de description (ensuite : transcript pour lire une vidéo).",
  "params": {
    "query": { "type": "string", "required": true, "description": "Requête." },
    "limit": { "type": "number", "default": 10, "description": "Vidéos au plus (30 max)." }
  },
  "returns": "{engine, query, results: [{title, url, channel, duration, views, published, description}]}"
}
*/
const limit = Math.min(Math.max(Math.round(args.limit), 1), 30);
// ytInitialData est posé par un script de la page dès son analyse : inutile d'attendre qu'elle se stabilise.
await open(`https://www.youtube.com/results?search_query=${encodeURIComponent(args.query)}`, { wait: "dom" });

// Données de la page (ytInitialData) plutôt que le DOM, rempli par lots. Collecte bornée dans la page (limit).
const EXTRACT = String.raw`((max) => {
  const data = window.ytInitialData;
  if (!data) return null;
  const found = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 45 || found.length >= max) return;
    if (o.videoRenderer) { found.push(o.videoRenderer); return; }
    for (const k in o) walk(o[k], depth + 1);
  };
  walk(data, 0);
  const txt = (x) => (x ? x.simpleText ?? (x.runs || []).map((r) => r.text).join("") : "") || "";
  return found.map((v) => ({
    title: txt(v.title),
    url: "https://www.youtube.com/watch?v=" + v.videoId,
    channel: txt(v.ownerText),
    duration: txt(v.lengthText),
    views: txt(v.viewCountText),
    published: txt(v.publishedTimeText),
    description: v.detailedMetadataSnippets && v.detailedMetadataSnippets[0] ? txt(v.detailedMetadataSnippets[0].snippetText).slice(0, 200) : "",
  }));
})(${limit})`;

let results = await js(EXTRACT);
for (let i = 0; i < 6 && !(results && results.length); i++) {
  await wait(0.5);
  results = await js(EXTRACT);
}
return { engine: "youtube", query: args.query, results: (results || []).slice(0, limit) };
