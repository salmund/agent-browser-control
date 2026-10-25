/**
 * Les dossiers de l'utilisateur vus par le démon :
 * - Téléchargements : sous Linux, le dossier XDG (« Téléchargements » sur un système en français), celui où
 *   Chromium enregistre ; ~/Downloads ailleurs.
 * - les fichiers à envoyer dans une page : un Chromium en snap (ou en Flatpak) ne lit que le dossier personnel,
 *   hors dossiers cachés, et a son propre /tmp. Un fichier pris ailleurs (/srv, /tmp…) part en
 *   ERR_FILE_NOT_FOUND : on le copie d'abord dans Téléchargements/agent-browser-control/envois/.
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";

/** Dossier Téléchargements : XDG_DOWNLOAD_DIR (variable, puis user-dirs.dirs) sous Linux, ~/Downloads ailleurs. */
export function downloadsDir(home = homedir(), env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const fallback = join(home, "Downloads");
  if (platform !== "linux") return fallback;
  const expand = (v: string) => v.replace(/^(\$HOME|~)(?=\/|$)/, home).replace(/\/+$/, "");
  // « $HOME/ » seul veut dire « dossier désactivé » pour xdg-user-dirs : on garde alors ~/Downloads.
  const usable = (v: string | undefined) => (v && isAbsolute(expand(v)) && expand(v) !== home ? expand(v) : null);
  const fromEnv = usable(env.XDG_DOWNLOAD_DIR);
  if (fromEnv) return fromEnv;
  try {
    const file = join(env.XDG_CONFIG_HOME || join(home, ".config"), "user-dirs.dirs");
    const m = /^\s*XDG_DOWNLOAD_DIR\s*=\s*"([^"]+)"/m.exec(readFileSync(file, "utf8"));
    return usable(m?.[1]) ?? fallback;
  } catch {
    return fallback;
  }
}

export const DOWNLOADS_DIR = downloadsDir();
/** Ce que le démon écrit lui-même (captures, GIF, médias, HAR) : à côté des téléchargements de l'extension. */
export const ABC_DOWNLOADS_DIR = join(DOWNLOADS_DIR, "agent-browser-control");

/** Le navigateur risque-t-il de ne pas voir ce fichier ? (Linux : hors du dossier personnel, ou dans un dossier caché.) */
export function browserMayNotSee(real: string, home = homedir(), platform = process.platform): boolean {
  if (platform !== "linux") return false;
  const rel = relative(home, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return true;
  const first = rel.split(/[\\/]/)[0];
  return first.startsWith(".") || first === "snap";
}

const STAGE_MAX_AGE_MS = 24 * 3600_000;

function purgeStaged(root: string, now = Date.now()) {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const p = join(root, name);
      if (now - statSync(p).mtimeMs > STAGE_MAX_AGE_MS) rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Chemins à donner au navigateur : ceux qu'il ne verrait pas sont copiés dans `root/<id>/`, sous leur nom
 * d'origine (la page l'affiche) ; les autres passent tels quels. Les copies de plus de 24 h sont effacées au passage.
 */
export function stageForBrowser(
  paths: string[],
  root = join(ABC_DOWNLOADS_DIR, "envois"),
  home = homedir(),
  platform = process.platform,
): { paths: string[]; staged: number } {
  if (!paths.some((p) => browserMayNotSee(p, home, platform))) return { paths, staged: 0 };
  purgeStaged(root);
  const dir = join(root, `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`);
  const used = new Set<string>();
  let staged = 0;
  const out = paths.map((p) => {
    if (!browserMayNotSee(p, home, platform)) return p;
    // Deux fichiers de même nom : le second dans un sous-dossier, pour garder les deux noms intacts.
    let sub = dir;
    for (let i = 2; used.has(join(sub, basename(p))); i++) sub = join(dir, String(i));
    const target = join(sub, basename(p));
    mkdirSync(sub, { recursive: true, mode: 0o700 });
    copyFileSync(p, target);
    used.add(target);
    staged++;
    return target;
  });
  return { paths: out, staged };
}
