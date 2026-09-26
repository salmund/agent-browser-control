// Compare plusieurs villes à partir de l'encadré (infobox) de leur page Wikipédia.
const villes = ["Paris", "Lyon", "Marseille", "Toulouse", "Nantes"];
const lignes = [];
for (const ville of villes) {
  await nav(`https://fr.wikipedia.org/wiki/${ville}`);
  // String.raw : les \s des expressions régulières arrivent intacts dans la page.
  const infos = await js(String.raw`(() => {
    const champ = (libelle) => {
      const th = [...document.querySelectorAll(".infobox_v2 th, .infobox_v3 th")].find((t) => t.innerText.replace(/\s+/g, " ").trim().startsWith(libelle)); // <br> dans certains libellés
      return th?.nextElementSibling?.innerText.split("\n")[0].replace(/\s*\[\d+\]/g, "").trim() ?? null;
    };
    return { population: champ("Population municipale"), superficie: champ("Superficie"), altitude: champ("Altitude") };
  })()`);
  log(`${ville} : ${infos.population ?? "?"}`);
  lignes.push({ ville, ...infos });
}
return lignes;
