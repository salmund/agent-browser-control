// Vérifie tous les liens de la page ouverte et liste ceux qui ne répondent pas.
// Les requêtes partent de l'extension (devtools http) : pas de limite CORS, pas de cookies.
const MAX = 60;
// On trie dans la page et on ne renvoie que ce qu'il faut : js() renvoie au plus 50 000 caractères.
const { total, liens } = await js(String.raw`(() => {
  const tous = [...new Set([...document.querySelectorAll("a[href^='http']")].map((a) => a.href.split("#")[0]))];
  return { total: tous.length, liens: tous.slice(0, ${MAX}) };
})()`);
log(`${total} liens sur la page, ${liens.length} vérifiés`);
const casses = [];
for (const url of liens) {
  const res = await call("devtools", { action: "http", url, method: "HEAD", timeoutMs: 10000 });
  const statut = res.text.match(/→ (\d{3})/)?.[1];
  if (res.isError || !statut || Number(statut) >= 400) casses.push({ url, statut: statut ?? "sans réponse" });
}
return { verifies: liens.length, casses };
