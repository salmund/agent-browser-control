// Cible par libellé : `target: "bouton Envoyer"` à la place d'une ref.
// Évite l'aller-retour find puis action : la recherche se fait ici, avec la même pertinence que l'outil find,
// et l'action part sur la meilleure ligne si elle est nettement devant. Ambiguïté : refus qui liste les
// candidats avec leur ref (jamais de choix au hasard : un « Envoyer » de trop est un message envoyé).

const REF_IN_LINE = /\[((?:f\d+:)?ref_\d+)\]/;

/** Marge de score au-dessus de laquelle la meilleure ligne est jugée sans ambiguïté. */
const TARGET_CLEAR_MARGIN = 0.35;

/**
 * Candidats de `query` dans l'onglet (toutes frames), triés par pertinence : [{ ref, line, score }].
 * Mêmes règles que l'outil find (insensible aux accents, plancher de pertinence, bonus aux interactifs).
 */
async function targetCandidates(tabId, query, limit = 6) {
  const frames = await inAllFrames(tabId, "find", { query, limit: 12, structured: true, scan: false });
  const items = [];
  for (const { frameId, value } of frames) {
    if (!value) continue;
    for (const it of value.items) {
      const line = prefixRefs(it.line, frameId);
      const ref = REF_IN_LINE.exec(line)?.[1];
      if (ref) items.push({ ref, line: line.trim().replace(/^- /, "").slice(0, 140), score: it.score });
    }
  }
  return items.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Remplit `holder[refKey]` à partir de `holder[targetKey]` quand la ref manque. Renvoie la note à joindre à
 * la réponse (« Cible « … » → ref_N (…) »), ou "" s'il n'y avait rien à résoudre.
 */
async function resolveTarget(tabId, holder, { refKey = "ref", targetKey = "target" } = {}) {
  const query = holder?.[targetKey];
  if (typeof query !== "string" || !query.trim() || holder[refKey]) return "";
  const found = await targetCandidates(tabId, query);
  if (!found.length) {
    throw new Error(`Cible ${JSON.stringify(query)} : aucun élément trouvé. Reformuler (texte visible, nom accessible) ou lire la page avec read_page.`);
  }
  const [best, second] = found;
  if (second && best.score - second.score < TARGET_CLEAR_MARGIN) {
    const list = found.slice(0, 4).map((c) => `- ${c.line}`).join("\n");
    throw new Error(
      `Cible ${JSON.stringify(query)} ambiguë (${found.length} candidats proches), rien n'a été fait :\n${untrusted(list)}\n` +
      "Préciser la cible (ajouter un mot du contexte) ou utiliser la ref voulue.",
    );
  }
  holder[refKey] = best.ref;
  delete holder[targetKey];
  return `Cible ${JSON.stringify(query)} → ${best.ref} (${pageLabel(best.line, 90)}).`;
}

/** Joint des notes (résolutions de cible) en tête de la réponse texte d'un outil. */
function withNotes(res, notes) {
  const lines = notes.filter(Boolean);
  if (!lines.length || !res?.content) return res;
  const first = res.content.find((c) => c.type === "text");
  if (first) first.text = `${lines.join("\n")}\n${first.text}`;
  return res;
}
