/**
 * Rotation du journal et purge des sorties : le démon tourne pendant des mois,
 * actions.log et Téléchargements/agent-browser-control ne doivent pas grossir sans fin.
 */
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_GENERATIONS = 3;
export const OUTPUT_MAX_AGE_MS = 30 * 24 * 3600_000;

/**
 * Fait tourner un fichier journal : au-delà de maxBytes, `f` devient `f.1`
 * (l'ancien `f.1` devient `f.2`, etc.), la génération la plus vieille est
 * jetée. Renvoie true si une rotation a eu lieu.
 */
export function rotateFile(path: string, maxBytes = LOG_MAX_BYTES, generations = LOG_GENERATIONS): boolean {
  try {
    if (!existsSync(path) || statSync(path).size <= maxBytes) return false;
  } catch {
    return false;
  }
  try {
    const oldest = `${path}.${generations}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let g = generations - 1; g >= 1; g--) {
      const from = `${path}.${g}`;
      if (existsSync(from)) renameSync(from, `${path}.${g + 1}`);
    }
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false;
  }
}

const MAX_PURGE_PER_RUN = 500;

/**
 * Supprime les fichiers d'un dossier plus vieux que maxAgeMs (fichiers seuls,
 * jamais les sous-dossiers). Renvoie les noms supprimés. Jamais d'exception.
 */
export function purgeOlderThan(dir: string, maxAgeMs: number, now = Date.now()): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const deleted: string[] = [];
  for (const name of names) {
    if (deleted.length >= MAX_PURGE_PER_RUN) break;
    const path = `${dir}/${name}`;
    try {
      const st = statSync(path);
      if (!st.isFile() || now - st.mtimeMs <= maxAgeMs) continue;
      unlinkSync(path);
      deleted.push(name);
    } catch {}
  }
  return deleted;
}
