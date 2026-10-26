/** @skill
{
  "name": "web.read",
  "description": "Lit plusieurs pages d'un coup, en parallèle dans des onglets de fond, avec la session de l'utilisateur : titre, URL finale et texte principal de chacune.",
  "params": {
    "urls": { "type": "array", "required": true, "description": "Adresses http(s), 10 au plus." },
    "maxChars": { "type": "number", "default": 6000, "description": "Texte gardé par page (40 000 max)." },
    "parallel": { "type": "number", "default": 4, "description": "Pages lues en même temps (6 max)." }
  },
  "returns": "[{url, title, chars, text} | {url, error}]"
}
*/
const urls = args.urls.map(String).filter((u) => /^https?:\/\//i.test(u)).slice(0, 10);
if (!urls.length) throw new Error("urls : adresses http(s) attendues.");
const max = Math.min(Math.max(Math.round(args.maxChars), 300), 40_000);
const out = new Array(urls.length);
let next = 0;

async function worker() {
  while (next < urls.length) {
    const i = next++;
    const url = urls[i];
    if (/\.pdf($|[?#])/i.test(url)) {
      out[i] = { url, error: "PDF : downloads (action download) puis read_document." };
      continue;
    }
    let id;
    try {
      id = await open(url, { use: false });
      const p = await page(id);
      const text = p.text.trim();
      // Mur anti-robot servi à la place de la page : le dire, plutôt que de rendre son texte comme une lecture.
      if (text.length < 1500 && /captcha|vérification de votre navigateur|verify you are human|just a moment|attention required|unusual traffic/i.test(`${p.title}\n${text}`)) {
        out[i] = { url: p.url || url, error: `page bloquée par une vérification anti-robot (« ${p.title.slice(0, 80)} ») : captcha_solve sur un onglet, ou une API du site (http())` };
        continue;
      }
      out[i] = { url: p.url || url, title: p.title, chars: text.length, text: text.length > max ? `${text.slice(0, max)} […]` : text };
    } catch (err) {
      out[i] = { url, error: String(err?.message ?? err).slice(0, 240) };
    } finally {
      if (id) await close(id);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(Math.max(Math.round(args.parallel), 1), 6, urls.length) }, worker));
return out;
