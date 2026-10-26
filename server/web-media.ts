/**
 * Images trouvées par search (kind images) : le démon montre les miniatures au modèle et enregistre les images
 * en pleine taille. Les adresses viennent d'une page (données non fiables) : http(s) seulement, jamais une
 * adresse locale ou privée (ni le démon, ni le réseau local, ni le tailnet), taille et type bornés.
 */
import { lookup } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif", "image/svg+xml": ".svg" };

/** Adresse IP qu'un agent ne doit jamais faire joindre au démon (boucle, privée, lien local, CGNAT/Tailscale). */
export function privateIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

async function checkUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("adresse http(s) attendue");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".ts.net")) throw new Error("adresse locale refusée");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(privateIp)) throw new Error("adresse privée refusée");
  return u;
}

export interface FetchedImage {
  data: Buffer;
  mimeType: string;
}

/** Télécharge une image (redirections suivies et revérifiées), au plus maxBytes. */
export async function fetchImage(raw: string, opts: { referer?: string; maxBytes?: number; timeoutMs?: number } = {}): Promise<FetchedImage> {
  const max = opts.maxBytes ?? 15 * 1024 * 1024;
  let url = await checkUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": UA, accept: "image/avif,image/webp,image/*,*/*;q=0.8", ...(opts.referer ? { referer: opts.referer } : {}) },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await checkUrl(new URL(res.headers.get("location")!, url).href);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) throw new Error(`pas une image (${type || "type inconnu"})`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > max) throw new Error(`trop lourde (${Math.round(declared / 1024)} Ko)`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > max) throw new Error(`trop lourde (${Math.round(data.length / 1024)} Ko)`);
    return { data, mimeType: type };
  }
  throw new Error("trop de redirections");
}

const GOOGLE_REDIRECT = /^https:\/\/www\.google\.[a-z.]+\/(goto|url)\?/;

/**
 * Sans session, Google masque ses liens derrière /goto?url=<jeton> : une redirection 302 vers la vraie adresse,
 * lue sans la suivre (rien n'est chargé du site cible). En cas d'échec, le lien d'origine reste (il fonctionne).
 */
export async function resolveGoogleLink(url: string, timeoutMs = 4000): Promise<string> {
  if (!GOOGLE_REDIRECT.test(url)) return url;
  try {
    const res = await fetch(url, { redirect: "manual", headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
    const to = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && to && /^https?:\/\//.test(to)) return to;
  } catch {}
  return url;
}

/** Nom de fichier lisible tiré d'une requête : « processus ptérygoïde » → processus-pterygoide. */
export function slug(text: string, max = 60): string {
  const s = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/, "") || "image";
}

/** Enregistre une image dans le dossier d'ABC ; renvoie le chemin. */
export async function saveImageFile(dir: string, base: string, image: FetchedImage): Promise<string> {
  await mkdir(dir, { recursive: true });
  const ext = EXT[image.mimeType] ?? ".img";
  const file = join(dir, `${base}${ext}`);
  await writeFile(file, image.data);
  return file;
}
