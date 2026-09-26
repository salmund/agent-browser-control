// Les articles du jour sur Hacker News, triés par score.
// Usage : browser_script { tabId, code: <ce fichier> }
await nav("https://news.ycombinator.com/");
const stories = await js(String.raw`[...document.querySelectorAll("tr.athing")].map((row) => {
  const title = row.querySelector(".titleline > a");
  const meta = row.nextElementSibling;
  const points = parseInt(meta?.querySelector(".score")?.textContent) || 0;
  const comments = parseInt([...(meta?.querySelectorAll("a") ?? [])].at(-1)?.textContent) || 0;
  return { title: title?.textContent, url: title?.href, points, comments };
})`);
log(`${stories.length} articles relevés`);
return stories.sort((a, b) => b.points - a.points).slice(0, 10);
