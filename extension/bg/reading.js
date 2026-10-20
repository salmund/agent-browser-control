// Agent Browser Control, service worker : lecture de page et formulaires.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

/**
 * Garde les `max` premières lignes porteuses de ref et compte le reste : une grosse page (boîte Gmail : 300 éléments)
 * ne noie plus le contexte quand l'agent veut seulement s'orienter. Sans `max`, rien n'est coupé.
 */
function capItems(tree, max) {
  const n = Math.floor(Number(max));
  if (!Number.isFinite(n) || n < 1) return tree;
  const lines = String(tree).split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/\[(?:f\d+:)?ref_\d+\]/.test(lines[i])) continue;
    if (++seen > n) {
      const rest = lines.slice(i).filter((l) => /\[(?:f\d+:)?ref_\d+\]/.test(l)).length;
      return `${lines.slice(0, i).join("\n")}\n[${rest} autre(s) élément(s) non listé(s) : maxItems=${n}. Cibler avec find ou target, ` +
        "restreindre avec viewport=true, ref (sous-arbre) ou filter='interactive', ou relire avec un maxItems plus grand.]";
    }
  }
  return tree;
}

async function readPage(agent, { tabId, filter, ref, viewport, diff, labels, include, maxItems }) {
  await assertOwned(agent, tabId);
  if (ref) {
    const target = parseRef(ref);
    const tree = await inPage(tabId, "readPage", { filter, ref: target.ref, viewport, diff, labels, include }, target.frameId);
    return ok(text(untrusted(capItems(prefixRefs(tree, target.frameId), maxItems))));
  }
  // Une seule passe dans toutes les frames : la page principale lit avec frame=false.
  const noticeP = overlayNotice(tabId); // indépendant de l'arbre : en parallèle (ne rejette jamais).
  const hintP = apiHint(tabId, "read_page"); // idem : ne rejette jamais.
  const frames = await inAllFrames(tabId, "readPage", { filter, viewport, diff, labels, include, frame: true });
  const main = frames.find((f) => f.frameId === 0)?.value ?? (await inPage(tabId, "readPage", { filter, viewport, diff, labels, include }));
  const parts = [main];
  for (const { frameId, value } of frames) {
    if (frameId === 0 || !value) continue;
    parts.push(`\n=== iframe ${frameId} (refs « f${frameId}:… ») ===\n${prefixRefs(value, frameId)}`);
  }
  let out = capItems(parts.join("\n"), maxItems);
  if (out.length > 80_000) out = `${out.slice(0, 80_000)}\n[Tronqué : cibler une ref ou utiliser viewport=true.]`;
  return ok(text((await noticeP) + (await hintP) + untrusted(out)));
}

async function find(agent, { tabId, query, limit = 20, scan = false }) {
  await assertOwned(agent, tabId);
  const noticeP = overlayNotice(tabId); // indépendant de la recherche : en parallèle (ne rejette jamais).
  const frames = await inAllFrames(tabId, "find", { query, limit, structured: true, scan });
  let total = 0;
  let masked = 0;
  let dropped = 0;
  const items = [];
  for (const { frameId, value } of frames) {
    if (!value) continue;
    total += value.total;
    masked += value.masked ?? 0;
    dropped += value.dropped ?? 0;
    const suffix = frameId ? `  (iframe ${frameId})` : "";
    items.push(...value.items.map((it) => ({ line: prefixRefs(it.line, frameId) + suffix, score: it.score })));
  }
  // Classement global par pertinence, toutes frames confondues.
  const shown = items.sort((a, b) => b.score - a.score).slice(0, limit).map((it) => it.line);
  const more = total > shown.length ? `\n(${total - shown.length} autres résultats non affichés)` : "";
  const maskedNote = masked ? `\n(${masked} élément(s) masqué(s) ignoré(s) : fixes hors écran, non cliquables)` : "";
  const droppedNote = dropped ? `\n(${dropped} match(s) partiel(s) écarté(s) : sous le plancher de pertinence)` : "";
  const result = shown.length
    ? `${total} résultat(s) pour ${JSON.stringify(query)} :\n${shown.join("\n")}${more}${maskedNote}${droppedNote}`
    : `Aucun élément trouvé pour ${JSON.stringify(query)}.${maskedNote}${droppedNote}${scan ? " (balayage des listes virtualisées effectué)" : " (scan: true balaye les listes virtualisées)"}`;
  return ok(text((await noticeP) + untrusted(result)));
}

/**
 * Extraction complète d'une liste à chargement progressif en un appel (page principale).
 * Arrière-plan si l'onglet peint, premier plan sinon (sans paint : pas de scroll events,
 * l'extraction tournerait dans le vide). L'onglet de l'utilisateur est rendu après.
 */
async function scrollExtract(agent, { tabId, item, container, direction, extract, maxRounds, stableRounds, waitMs, limit, offset, loadMore }) {
  const tab = await assertOwned(agent, tabId);
  if (!item || typeof item !== "string") throw new Error("'item' requis : sélecteur CSS des lignes à extraire.");
  const run = () => inPage(tabId, "scrollExtract", { item, container, direction, extract, maxRounds, stableRounds, waitMs, limit, offset, loadMore });
  const probe = await inPage(tabId, "canPaint").catch(() => null);
  const foregrounded = !probe?.paints;
  const res = foregrounded ? await withForeground(tab, run) : await run();
  const head = `Liste extraite (${res.container}, ${res.direction}, ${res.rounds} tour(s)) : ${res.total} item(s) au total, ${res.count} renvoyé(s)` +
    (res.offset ? ` (à partir de ${res.offset})` : "") + "." +
    (res.loadMoreClicks ? ` (${res.loadMoreClicks} clic(s) « charger plus »)` : "") +
    (foregrounded ? " (passage au premier plan : onglet non peint)" : "") +
    (res.hasMore ? " Fin atteinte par maxRounds avec du nouveau : relancer avec maxRounds plus grand." : "") +
    (res.truncatedByLimit ? " Tronqué par limit/offset : relancer avec un autre offset pour la suite." : "");
  const lines = res.items.map((t) => `- ${String(t).split("\n").join(" ")}`);
  const body = `${head}\n${lines.join("\n")}`;
  if (body.length <= BIG_TEXT_CHARS) return ok(text(untrusted(body)));
  const full = JSON.stringify({ meta: { ...res, items: undefined }, items: res.items }, null, 2);
  const preview = `${head}\nAperçu (15 premiers) :\n${lines.slice(0, 15).join("\n")}\n…\nContenu complet (${res.count} items) dans le fichier : {path} (relire avec read_document)`;
  return attachBigFile(full, "scroll-extract", "json", untrusted(preview));
}

/** Extraction structurée sans scroll (page principale) : sélecteur + projection + filtre + pagination. */
async function querySelect(agent, { tabId, selector, extract, filter, limit, offset, countOnly }) {
  await assertOwned(agent, tabId);
  if (!selector || typeof selector !== "string") throw new Error("'selector' requis : sélecteur CSS.");
  const res = await inPage(tabId, "query", { selector, extract, filter, limit, offset, countOnly });
  const head = `Requête ${JSON.stringify(selector)} : ${res.total} correspondance(s)` +
    (countOnly ? "." : `, ${res.count} renvoyée(s)${res.offset ? ` (à partir de ${res.offset})` : ""}.`) +
    (res.truncatedByLimit ? " Tronqué par limit/offset : relancer avec un autre offset pour la suite." : "");
  if (countOnly) return ok(text(head));
  const lines = res.items.map((t) => `- ${String(t).split("\n").join(" ")}`);
  const body = `${head}\n${lines.join("\n")}`;
  if (body.length <= BIG_TEXT_CHARS) return ok(text(untrusted(body)));
  const full = JSON.stringify({ meta: { ...res, items: undefined }, items: res.items }, null, 2);
  const preview = `${head}\nAperçu (15 premiers) :\n${lines.slice(0, 15).join("\n")}\n…\nContenu complet (${res.count} items) dans le fichier : {path} (relire avec read_document)`;
  return attachBigFile(full, "query", "json", untrusted(preview));
}

/** Tableaux <table> de la page en Markdown (défaut) ou CSV : la structure que get_page_text perd. */
async function readTables(agent, { tabId, selector, format = "markdown", limit, maxRows }) {
  await assertOwned(agent, tabId);
  const res = await inPage(tabId, "tables", { selector, format, limit, maxRows });
  if (!res.count) return ok(text(`Aucun tableau${selector ? ` pour ${JSON.stringify(selector)}` : ""} sur la page.`));
  const label = format === "csv" ? "CSV" : "Markdown";
  const head = `${res.count} tableau(x) sur ${res.total} (format ${label}, première ligne = en-tête).`;
  const parts = res.tables.map((t) => `--- Tableau ${t.index + 1}${t.caption ? ` : ${t.caption}` : ""} (${t.rows} lignes × ${t.cols} col.) ---\n${t.text}`);
  const body = `${head}\n${parts.join("\n\n")}`;
  if (body.length <= BIG_TEXT_CHARS) return ok(text(untrusted(body)));
  const preview = `${head}\nAperçu (1er tableau, 15 lignes) :\n${res.tables[0].text.split("\n").slice(0, 15).join("\n")}\n…\nContenu complet dans le fichier : {path} (relire avec read_document)`;
  return attachBigFile(body, "tables", format === "csv" ? "csv" : "md", untrusted(preview));
}

/** Chemin JSON pointé (« a.b.0.c ») ; undefined si absent. */
function jsonPath(obj, path) {
  let cur = obj;
  for (const part of String(path).split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(part) ? cur[Number(part)] : cur[part];
  }
  return cur;
}

/**
 * Rejoue une pagination d'API observée dans le trafic de l'onglet : on retrouve le dernier appel
 * GET qui matche urlPattern, puis on suit le curseur (query) de page en page, dans la page
 * (même session, cookies inclus). Court-circuite le scroll quand les données viennent d'une API.
 * Gardes : GET uniquement, même origine que l'onglet, maxPages plafonné, 15 s par page.
 * v1 : curseur en query uniquement (cursor.in "query:param"), réponses JSON.
 */
async function replayPaginated(agent, { tabId, urlPattern, cursor, itemsPath, maxPages = 10, limit = 2000 }) {
  const tab = await assertOwned(agent, tabId);
  await ensureAttached(tabId);
  if (!urlPattern || typeof urlPattern !== "string") throw new Error("'urlPattern' requis : regex sur l'URL (ex. '/api/items').");
  const inParam = typeof cursor?.in === "string" && cursor.in.startsWith("query:") ? cursor.in.slice("query:".length) : null;
  if (!inParam) throw new Error("'cursor.in' requis, format \"query:<param>\" (v1 : curseur en query uniquement).");
  const outPath = typeof cursor?.out === "string" && cursor.out.startsWith("json:") ? cursor.out.slice("json:".length) : null;
  if (!outPath) throw new Error("'cursor.out' requis, format \"json:<chemin>\" (ex. \"json:next\").");
  const itemsP = typeof itemsPath === "string" && itemsPath.startsWith("json:") ? itemsPath.slice("json:".length) : null;
  if (!itemsP) throw new Error("'itemsPath' requis, format \"json:<chemin>\" (ex. \"json:items\").");
  const pagesCap = Math.max(1, Math.min(Number(maxPages) || 10, 50));
  const itemsCap = Math.max(1, Math.min(Number(limit) || 2000, 20000));

  const re = compileRegex(urlPattern);
  const all = [...(networkLogs.get(tabId)?.values() ?? [])];
  const matching = all.filter((r) => re.test(r.url));
  const seeds = matching.filter((r) => r.method === "GET" && r.status === 200);
  if (!seeds.length) {
    throw new Error(
      matching.length
        ? `Aucun appel GET 200 pour ${JSON.stringify(urlPattern)} (${matching.length} appel(s) matché(s), autres méthodes/statuts).`
        : `Aucun appel capturé pour ${JSON.stringify(urlPattern)} (${all.length} requête(s) au total). ` +
          "La capture commence à l'attachement : recharger la page ou refaire l'action qui appelle l'API, puis relancer.",
    );
  }
  const seed = seeds[seeds.length - 1];
  const tabOrigin = new URL(tab.url).origin;
  const template = new URL(seed.url);
  if (template.origin !== tabOrigin) throw new Error(`Refusé : ${template.origin} n'est pas l'origine de l'onglet (${tabOrigin}).`);

  const items = [];
  let pages = 0;
  let stoppedBy = "curseur épuisé";
  let nextCursor = "";
  let first = true; // page 1 = URL d'origine rejouée telle quelle, curseur ensuite
  while (pages < pagesCap && items.length < itemsCap) {
    const url = new URL(template.toString());
    if (!first) url.searchParams.set(inParam, nextCursor);
    first = false;
    const fetched = await inPage(tabId, "fetchJson", { url: url.toString() });
    if (!fetched.ok) throw new Error(`Page ${pages + 1} : HTTP ${fetched.status} sur ${url.pathname}${url.search}.`);
    let json;
    try {
      json = JSON.parse(fetched.body);
    } catch {
      throw new Error(`Page ${pages + 1} : réponse non JSON (${fetched.contentType || "sans content-type"}).`);
    }
    const pageItems = jsonPath(json, itemsP);
    if (!Array.isArray(pageItems)) throw new Error(`Page ${pages + 1} : itemsPath ${JSON.stringify(itemsP)} ne donne pas un tableau.`);
    for (const it of pageItems) {
      if (items.length >= itemsCap) break;
      items.push(it);
    }
    pages++;
    const next = jsonPath(json, outPath);
    if (next === null || next === undefined || next === "") break;
    nextCursor = String(next);
    if (items.length >= itemsCap) { stoppedBy = "plafond limit atteint"; break; }
  }
  if (pages >= pagesCap) stoppedBy = "plafond maxPages atteint";

  const head = `Pagination rejouée (${seed.method} ${template.pathname}) : ${pages} page(s), ${items.length} item(s) (${stoppedBy}).`;
  const lines = items.map((it) => `- ${typeof it === "string" ? it : JSON.stringify(it)}`.slice(0, 500));
  const body = `${head}\n${lines.join("\n")}`;
  if (body.length <= BIG_TEXT_CHARS) return ok(text(untrusted(body)));
  const full = JSON.stringify({ meta: { seed: `${seed.method} ${seed.url}`, pages, total: items.length, stoppedBy }, items }, null, 2);
  const preview = `${head}\nAperçu (15 premiers) :\n${lines.slice(0, 15).join("\n")}\n…\nContenu complet (${items.length} items) dans le fichier : {path} (relire avec read_document)`;
  return attachBigFile(full, "replay", "json", untrusted(preview));
}

/**
 * Soumet un formulaire par le clic d'un bouton désigné par sa ref : un seul vrai clic (CDP), comme
 * l'utilisateur. Le clic synthétique (el.click()) ne sert que si le bouton n'a pas pu être localisé :
 * les deux à la suite soumettaient deux fois (double commande, double message, double connexion).
 */
async function submitByRef(tab, submitRef) {
  const tabId = tab.id;
  // Bouton qui se prête au clic par événements : l'onglet de l'utilisateur reste devant (voir canGoSilent).
  const probe = { action: "left_click", ref: submitRef };
  if (await canGoSilent(tab, probe)) {
    const quiet = await silentGesture(tabId, "silentClick", submitRef);
    if (quiet.ok) {
      await sleepForFrame(tabId, 200);
      return `Soumis via clic silencieux sur ${submitRef} (onglet resté en arrière-plan).`;
    }
  }
  const point = await locateRef(tabId, submitRef).catch(() => null);
  if (point) {
    await showOverlay(tabId, point);
    await withForeground(tab, () => click(tabId, point, "left", 1, 0));
    await sleepForFrame(tabId, 200);
    return `Soumis via clic sur ${submitRef}.`;
  }
  const target = parseRef(submitRef);
  await inPage(tabId, "clickRef", target.ref, target.frameId);
  await sleepForFrame(tabId, 200);
  return `Soumis via clic sur ${submitRef} (clic programmatique : bouton non localisable à l'écran).`;
}

async function formInput(agent, args) {
  const { tabId, ref, value, fields, submitRef } = args;
  const tab = await assertOwned(agent, tabId);
  await bringToFront(tab);
  const items = Array.isArray(fields) && fields.length ? fields
    : (ref !== undefined || args.target ? [{ ref, target: args.target, value, format: args.format }] : []);
  if (!items.length && !submitRef && !args.submitTarget) throw new Error("Fournir 'fields' (liste de {ref, value}) ou 'ref' + 'value'.");
  const since = Date.now();
  const before = await inPage(tabId, "pageDigest").catch(() => null);

  const results = [];
  const notes = [];
  for (const item of items) {
    // Résolution champ par champ : la page a pu se recomposer après le champ précédent (suggestion choisie, puce créée…).
    if (!item.ref && item.target) notes.push(await resolveTarget(tabId, item));
    if (!item.ref) continue;
    const target = parseRef(item.ref);
    const format = item.format ?? args.format;
    // html calculé ici (une seule fois) : l'API de l'éditeur (monde principal) comme le repli insertHTML de la page l'utilisent.
    const html = format && format !== "text" ? richTextToHtml(item.value, format) : undefined;
    let raw = await inPage(tabId, "formInput", { ref: target.ref, value: item.value, format, html }, target.frameId);
    // Éditeur riche à API connue (CKEditor 5, Quill) : la page ne peut pas l'atteindre depuis son monde isolé.
    if (raw && typeof raw === "object" && raw.mainWorld) {
      const done = await fillRichEditorApi(tabId, raw.selector, html ?? richTextToHtml(item.value, "text"), !!String(item.value ?? "").trim());
      raw = done
        ? `${raw.ref} = ${JSON.stringify(String(item.value ?? ""))} (éditeur riche : ${done.kind}, ${done.len} car. lus).`
        : await inPage(tabId, "formInput", { ref: target.ref, value: item.value, format, html, noApi: true }, target.frameId);
    }
    const res = prefixRefs(raw, target.frameId)
      .replace(/^ref_(\d+)/, target.frameId ? `f${target.frameId}:ref_$1` : "ref_$1");
    results.push(res);
  }

  let submit = submitRef;
  if (!submit && args.submitTarget) {
    const holder = { target: args.submitTarget };
    notes.push(await resolveTarget(tabId, holder));
    submit = holder.ref;
  }
  const submitMsg = submit ? `\n${await submitByRef(tab, submit)}` : "";

  await showOverlay(tabId);
  const summaryRefs = items.map((i) => i.ref).join(", ");
  await recordFrame(tabId, `form_input ${summaryRefs}${submit ? ` -> ${submit}` : ""}`);
  const baseRes = ok(text(([...notes.filter(Boolean), results.join("\n") + submitMsg].join("\n")).trim()));
  await appendActionEffect(tabId, baseRes, before, since);
  if (args.snapshot || args.then || args.diff) {
    return attachActionSnapshot(agent, tabId, args, baseRes);
  }
  return baseRes;
}

async function getPageText(agent, { tabId, offset }) {
  await assertOwned(agent, tabId);
  const from = Number(offset);
  const textP = inPage(tabId, "pageText", Number.isFinite(from) && from > 0 ? { offset: from } : null);
  const noticeP = overlayNotice(tabId); // indépendant du texte : en parallèle (ne rejette jamais).
  const hintP = apiHint(tabId, "get_page_text"); // idem : ne rejette jamais.
  const { title, url, text: body } = await textP;
  const head = `${await noticeP}${await hintP}Page : ${pageLabel(title)}\nURL : ${url}\n\n${untrusted(body)}`;
  if (!(await hasBigCanvas(tabId))) return ok(text(head));
  // Toile de fond décorative (ex. Discord) sous un vrai contenu HTML : pas d’export ni d’OCR.
  // Quand le canvas porte le contenu (Docs, Figma, jeux), il n'est pas fixe : OCR conservé.
  if (body.trim().length >= 500 && (await bigCanvasFixed(tabId))) return ok(text(head));
  // Page dessinée dans un canvas : le texte n'est pas dans le HTML. On va le chercher là où il est.
  const exported = await adapterText(tabId, url);
  if (exported) {
    return ok(text(`${head}\n\nContenu du document, lu via l'export de ${exported.name} (texte exact, dernière version enregistrée) :\n` +
      untrusted(exported.text)));
  }
  return { content: [text(`${head}\n\nℹ La page est surtout dessinée dans un <canvas>, invisible dans le HTML.\n{ocr}`)], _ocr: await captureForOcr(tabId) };
}

/**
 * Éditeurs et applis qui dessinent leur contenu dans un <canvas> (Google Docs, Figma, tableurs, jeux…) :
 * ni read_page ni get_page_text n'en voient le texte. L'agent doit le savoir pour ne pas conclure à une page vide.
 */
async function hasBigCanvas(tabId) {
  return evaluate(tabId, `[...document.querySelectorAll("canvas")].some((c) => {
    const r = c.getBoundingClientRect();
    return r.width * r.height > innerWidth * innerHeight * 0.25;
  })`).catch(() => false);
}
/**
 * Tous les grands canvas sont-ils des toiles de fond (position:fixed, ex. fond
 * animé, canvas Discord) plutôt que le support du contenu (Docs, Figma, jeux) ?
 * Un canvas fixe passe devant le contenu statique au hit-test : le test de
 * positionnement remplace un hit-test qui ne distingue rien. Doute -> OCR.
 */
async function bigCanvasFixed(tabId) {
  return evaluate(tabId, `[...document.querySelectorAll("canvas")].filter((c) => {
    const r = c.getBoundingClientRect();
    return r.width * r.height > innerWidth * innerHeight * 0.25;
  }).every((c) => getComputedStyle(c).position === "fixed")`).catch(() => false);
}

/**
 * Fichiers qu'un agent ne doit jamais pouvoir envoyer à un site : clés et jetons, profils de navigateur
 * (cookies, mots de passe), configuration d'ABC. Le démon applique la même règle de son côté ; celle-ci
 * protège aussi d'un démon ancien.
 */
const UPLOAD_DENY = [
  /[\\/]\.(ssh|gnupg|aws|azure|kube|docker)([\\/]|$)/i,
  /[\\/]\.config[\\/](gcloud|gh|agent-browser-control)([\\/]|$)/i,
  /[\\/]\.agent-browser-control([\\/]|$)/i,
  /[\\/](\.env(\.[\w-]+)?|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials)$/i,
  /[\\/](id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^\\/]+\.(pem|key|p12|pfx|kdbx))$/i,
  /[\\/](Login Data|Cookies|Web Data|Local State|Network Persistent State)( For Account)?(-journal)?$/i,
  /[\\/](Bitwarden|1Password|KeePass(XC)?)([\\/]|$)/i,
  /^\/etc\/(shadow|sudoers)/,
];

function assertUploadablePath(p) {
  if (typeof p !== "string" || !p.trim()) throw new Error("Chemin de fichier vide.");
  if (!/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(p)) throw new Error(`Chemin non absolu : ${JSON.stringify(p)}.`);
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) throw new Error(`Chemin avec « .. » refusé : ${JSON.stringify(p)}.`);
  if (UPLOAD_DENY.some((re) => re.test(p))) throw new Error(`Fichier sensible (clé, jeton, profil de navigateur) : envoi refusé (${JSON.stringify(p)}).`);
}

/**
 * Après un envoi de fichier : attend que les requêtes d'écriture lancées (POST, PUT, PATCH) aient une réponse
 * (8 s au plus, jamais « réseau calme » : Gmail garde des connexions longues ouvertes), puis dit si le nom du
 * fichier est visible dans la page (puce de pièce jointe) et si une requête a échoué.
 */
async function uploadSettled(tabId, since, paths) {
  const writing = () => [...(networkLogs.get(tabId)?.values() ?? [])]
    .filter((r) => r.t >= since && ["POST", "PUT", "PATCH"].includes(r.method) && ["XHR", "Fetch", "Other"].includes(r.type));
  await sleep(250);
  await settle(tabId, { since, network: "writes", maxMs: 8000, stepMs: 150 });
  const names = paths.map((p) => String(p).split(/[\\/]/).pop());
  const seen = await evaluate(tabId, `(() => { const t = document.body ? document.body.innerText : ""; return ${JSON.stringify(names)}.map((n) => t.includes(n)); })()`).catch(() => null);
  const failed = writing().filter((r) => (r.status ?? 0) >= 400 || (r.error && r.error !== "canceled"));
  const parts = [];
  if (Array.isArray(seen)) {
    const missing = names.filter((_, i) => !seen[i]);
    parts.push(missing.length ? `nom absent de la page pour : ${missing.join(", ")} (envoi peut-être encore en cours ou affiché autrement : relire)` : "nom(s) visible(s) dans la page");
  }
  if (failed.length) parts.push(`${failed.length} requête(s) d'envoi en échec (dernière : ${failed.at(-1).method} → ${failed.at(-1).error ? String(failed.at(-1).error).slice(0, 40) : failed.at(-1).status})`);
  return parts.length ? ` Vérifié : ${parts.join(" ; ")}.` : "";
}

async function fileUpload(agent, { tabId, ref, paths }) {
  await bringToFront(await assertOwned(agent, tabId));
  const since = Date.now();
  if (!ref) throw new Error("'ref' manquant.");
  if (!Array.isArray(paths) || !paths.length) throw new Error("'paths' doit être une liste de chemins absolus.");
  paths.forEach(assertUploadablePath);
  // Le démon vérifie aussi (chemins réels, liens symboliques résolus) : il a le dernier mot quand il répond.
  const checked = await daemonRpc("upload-check", { paths }).catch((err) => {
    if (/inconnu|unknown|non connecté/i.test(String(err?.message))) return null; // démon ancien ou absent : contrôle local seul
    throw err;
  });
  if (Array.isArray(checked?.paths) && checked.paths.length === paths.length) paths = checked.paths;
  // Dans une iframe, on passe par le sélecteur de fichiers (le marquage ci-dessous vise la page principale).
  if (parseRef(ref).frameId || !(await inPage(tabId, "isFileInput", ref))) return uploadViaFileChooser(tabId, ref, paths, since);
  const selector = await inPage(tabId, "markRef", ref);
  const { result } = await cdp(tabId, "Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
  if (!result?.objectId) throw new Error(`Élément ${ref} introuvable.`);
  try {
    await cdp(tabId, "DOM.setFileInputFiles", { files: paths, objectId: result.objectId });
  } finally {
    await cdp(tabId, "Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})?.removeAttribute("data-abc-target")`,
    }).catch(() => {});
  }
  await recordFrame(tabId, `file_upload ${ref}`);
  return ok(text(`${paths.length} fichier(s) chargé(s) dans ${ref}.${await uploadSettled(tabId, since, paths)}`));
}

function waitForCdpEvent(tabId, eventName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.debugger.onEvent.removeListener(listener);
      reject(new Error(`${eventName} non reçu après ${timeoutMs / 1000}s.`));
    }, timeoutMs);
    function listener(source, method, params) {
      if (source.tabId !== tabId || method !== eventName) return;
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(listener);
      resolve(params);
    }
    chrome.debugger.onEvent.addListener(listener);
  });
}

/**
 * Cas des sites qui créent l'<input type=file> au clic (Gemini, Gmail…) : on intercepte
 * la boîte de dialogue native et on y injecte directement les fichiers.
 */
async function uploadViaFileChooser(tabId, ref, paths, since = Date.now()) {
  await cdp(tabId, "Page.enable");
  await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
  try {
    const opened = waitForCdpEvent(tabId, "Page.fileChooserOpened", 5000);
    const point = await locateRef(tabId, ref);
    await showOverlay(tabId, point);
    await withForeground(await chrome.tabs.get(tabId), () => click(tabId, point, "left", 1, 0));
    const { backendNodeId, mode } = await opened.catch(() => {
      throw new Error(`Le clic sur ${ref} n'a pas ouvert de sélecteur de fichiers. Cibler le bouton ou l'élément de menu qui l'ouvre.`);
    });
    const files = mode === "selectSingle" ? paths.slice(0, 1) : paths;
    await cdp(tabId, "DOM.setFileInputFiles", { files, backendNodeId });
    await recordFrame(tabId, `file_upload ${ref}`);
    const note = files.length < paths.length ? " (sélection simple : seul le premier a été gardé)" : "";
    return ok(text(`${files.length} fichier(s) chargé(s) via le sélecteur ouvert par ${ref}${note}.${await uploadSettled(tabId, since, files)}`));
  } finally {
    await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
  }
}
