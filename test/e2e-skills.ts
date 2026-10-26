/**
 * Test end-to-end des fonctions d'ABC : catalogue servi par tabs_context, search (web, images, vidéos),
 * read_urls, et le cycle d'une fonction apprise (save avec essai, run, skill() dans un script, show, delete),
 * plus les nouveautés de browser_script (args, open, page, fermeture des onglets ouverts).
 * Sites réels (Google ou DuckDuckGo, Google Images ou Bing, YouTube, example.com) : réseau requis.
 *
 * Lancer avec : node test/e2e-skills.ts (extension + démon actifs)
 */
import assert from "node:assert";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../server/common.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e-skills-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/mcp.ts"] }));

type Res = { isError?: true; content: { type: string; text?: string; data?: string; mimeType?: string }[] };
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as unknown as Res;
const textOf = (res: Res, expectOk = true): string => {
  const t = res.content.map((b) => b.text ?? "").join("\n");
  if (expectOk) assert.strictEqual(res.isError, undefined, `outil sans erreur : ${t.slice(0, 600)}`);
  return t;
};
const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = Date.now();
  const out = await fn();
  console.log(`   ${label} : ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return out;
};
const NAME = "e2e-exemple.titre";
let savedImage = "";

try {
  console.log("=== Fonctions d'ABC ===");

  console.log("\n1. Les outils et le catalogue sont là avant toute navigation...");
  const { tools } = await client.listTools();
  for (const n of ["search", "read_urls", "skill"]) assert.ok(tools.some((t) => t.name === n), `outil ${n}`);
  assert.ok(tools.find((t) => t.name === "skill")!.description!.includes("web.search"), "catalogue dans la description");
  const ctx = textOf(await call("tabs_context"));
  assert.ok(/Fonctions ABC/.test(ctx) && /web\.images\(query/.test(ctx), "catalogue servi par tabs_context");

  console.log("\n2. search web : résultats en 1 appel, onglet refermé...");
  const tabsBefore = textOf(await call("tabs_context"));
  const web = await timed("search web", async () => textOf(await call("search", { query: "processus ptérygoïde", limit: 5 })));
  console.log(web.slice(0, 900));
  assert.ok(/Recherche (Google|DuckDuckGo) « processus ptérygoïde » : réussie/.test(web), "en-tête");
  assert.ok(/^1\. .+\n {3}https?:\/\//m.test(web), "au moins un résultat avec URL");
  assert.ok(!/google\.[a-z.]+\/(goto|url)\?/.test(web), "liens Google masqués (/goto) résolus vers la vraie adresse");
  assert.strictEqual(textOf(await call("tabs_context")).match(/tabId \d+/g)?.length ?? 0, tabsBefore.match(/tabId \d+/g)?.length ?? 0, "onglet de la recherche refermé");

  console.log("\n3. search web + read : chercher et lire en 1 appel...");
  const withRead = await timed("search web read 2", async () => textOf(await call("search", { query: "Wikipédia os sphénoïde", limit: 4, read: 2, maxChars: 1500 })));
  assert.ok(/Pages lues \(2\)/.test(withRead), "deux pages lues");
  assert.ok(/── 1\. .+ \(\d+ car\.\)/.test(withRead), "texte de la première page");

  console.log("\n4. search images : miniatures jointes, pick enregistre en pleine taille...");
  const images = (await timed("search images", () => call("search", { query: "processus ptérygoïde anatomie", kind: "images", limit: 8, show: 3, pick: [1] })));
  const imgText = textOf(images);
  console.log(imgText.slice(0, 700));
  assert.ok(/image\(s\)\./.test(imgText) && /image : https?:\/\//.test(imgText), "URL des images");
  const thumbs = images.content.filter((c) => c.type === "image");
  assert.ok(thumbs.length >= 1, `miniatures jointes (${thumbs.length})`);
  const saved = /1 → (.+\.(jpg|png|webp|gif|avif|svg|img))/.exec(imgText);
  if (saved) {
    savedImage = saved[1];
    assert.ok(existsSync(savedImage), `image enregistrée : ${savedImage}`);
  }
  else console.log("   (image 1 non enregistrée : hôte qui refuse le téléchargement direct, toléré)");

  console.log("\n5. search videos...");
  const videos = await timed("search videos", async () => textOf(await call("search", { query: "fosse ptérygo-palatine anatomie", kind: "videos", limit: 3 })));
  assert.ok(/youtube\.com\/watch\?v=/.test(videos), "URL YouTube");

  console.log("\n6. read_urls : plusieurs pages en parallèle...");
  const read = await timed("read_urls", async () => textOf(await call("read_urls", { urls: ["https://example.com", "https://example.org"], maxChars: 500 })));
  assert.ok((read.match(/Example Domain/g) ?? []).length >= 2, "deux pages lues");

  console.log("\n6 bis. Long parcours sur un site sans fonction : rappel avec le parcours et la question « 1 à 3 appels »...");
  const orgTab = Number(/tabId (\d+)/.exec(textOf(await call("tabs_create", { url: "https://example.org/" })))?.[1]);
  for (let i = 0; i < 8; i++) await call("find", { tabId: orgTab, query: "More information" });
  const retro = textOf(await call("get_page_text", { tabId: orgTab }));
  await call("tabs_close", { tabId: orgTab });
  assert.ok(/1 à 3 appels/.test(retro) && /find ×8/.test(retro), `rappel rétrospectif : ${retro.slice(-500)}`);

  console.log("\n7. browser_script : args, open, page ; l'onglet ouvert est refermé...");
  const script = textOf(await call("browser_script", {
    code: 'const id = await open(args.url); const p = await page(id); return { titre: p.title, longueur: p.text.length, id };',
    args: { url: "https://example.com" },
  }));
  assert.ok(/"titre": "Example Domain"/.test(script), "page() lit la page ouverte par open()");
  const scriptTab = Number(/"id": (\d+)/.exec(script)?.[1]);
  assert.ok(!new RegExp(`tabId ${scriptTab}\\b`).test(textOf(await call("tabs_context"))), "onglet de open() fermé à la fin");

  console.log("\n7 bis. Un script réussi sur un site sans fonction : proposé à l'enregistrement tel quel...");
  const fresh = textOf(await call("browser_script", {
    code: '// Page d\'exemple lue par un script.\nconst id = await open("https://example.net/");\nconst p = await page(id);\nreturn { titre: p.title, longueur: p.text.length };',
  }));
  assert.ok(/Ce script a réussi sur example\.net/.test(fresh) && /enregistre-le tel quel/.test(fresh), `rappel après script : ${fresh.slice(-400)}`);

  console.log("\n8. Fonction apprise : save refusée si l'essai échoue...");
  const code = 'await open("https://example.com"); const t = await js("document.title"); return { titre: t, suffixe: args.suffixe };';
  const badTry = await call("skill", { action: "save", name: NAME, description: "Titre de example.com, pour les tests e2e.", params: { suffixe: { type: "string", default: "!" } }, code: code.replace("document.title", "document.querySelector('#absent').textContent"), site: "example.com", test: {} });
  assert.ok(badTry.isError && /NON enregistrée/.test(textOf(badTry, false)), "essai en échec : rien d'enregistré");

  console.log("\n9. save avec essai réussi, puis run, puis skill() dans un script...");
  const ok = textOf(await call("skill", { action: "save", name: NAME, description: "Titre de example.com, pour les tests e2e.", params: { suffixe: { type: "string", default: "!" } }, code, site: "example.com", test: { suffixe: "?" } }));
  assert.ok(/Fonction (enregistrée|mise à jour)/.test(ok) && /Essai réussi/.test(ok), ok);
  const ran = await timed("skill run", async () => textOf(await call("skill", { action: "run", name: NAME, args: { suffixe: "#" } })));
  assert.ok(/"titre": "Example Domain"/.test(ran) && /"suffixe": "#"/.test(ran), "run");
  const nested = textOf(await call("browser_script", { code: `const r = await skill("${NAME}", { suffixe: "imbriqué" }); return r.titre + r.suffixe;` }));
  assert.ok(/Example Domainimbriqué/.test(nested), "skill() dans un script");
  const badArgs = await call("skill", { action: "run", name: NAME, args: { inconnu: 1 } });
  assert.ok(badArgs.isError && /inconnu/.test(textOf(badArgs, false)), "argument inconnu refusé avant exécution");

  console.log("\n10. Le site la rappelle à l'arrivée ; show ; delete...");
  const tab = Number(/tabId (\d+)/.exec(textOf(await call("tabs_create", { url: "https://example.com" })))?.[1]);
  const arrive = textOf(await call("navigate", { tabId: tab, url: "https://example.com/" }));
  assert.ok(arrive.includes(`${NAME}(suffixe?)`), "fonction servie à l'arrivée sur le site");
  await call("tabs_close", { tabId: tab });
  assert.ok(/Code :/.test(textOf(await call("skill", { action: "show", name: NAME }))), "show");
  assert.ok(/retirée/.test(textOf(await call("skill", { action: "delete", name: NAME }))), "delete");
  assert.ok(!textOf(await call("skill", { action: "list" })).includes(NAME), "plus au catalogue");

  console.log("\n✅ Fonctions d'ABC : OK");
} finally {
  await call("skill", { action: "delete", name: NAME }).catch(() => {});
  await client.close();
  // Traces du test : l'image enregistrée et les versions archivées de la fonction de test.
  if (savedImage) rmSync(savedImage, { force: true });
  const archives = join(CONFIG_DIR, "skills", ".anciennes");
  if (existsSync(archives)) for (const f of readdirSync(archives)) if (f.startsWith(`${NAME}.`)) rmSync(join(archives, f), { force: true });
}
