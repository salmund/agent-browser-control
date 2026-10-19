/**
 * Téléchargement de vidéos / audios avec yt-dlp (et ffmpeg pour assembler ou convertir).
 * Les fichiers vont dans ~/Downloads/agent-browser-control/. Un téléchargement trop long pour un appel
 * continue en arrière-plan : l'agent suit son avancement avec action="status".
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const MEDIA_DIR = join(homedir(), "Downloads", "agent-browser-control");
const WAIT_MS = 240_000; // au-delà, le téléchargement continue en arrière-plan
const JOB_MAX_AGE_MS = 24 * 3600_000;

const ACTIONS = ["download", "info"] as const;
const MODES = ["video", "audio", "subtitles"] as const;
const AUDIO_FORMATS = ["mp3", "m4a", "opus", "wav"] as const;

export interface MediaRequest {
  url: string;
  action?: (typeof ACTIONS)[number];
  mode?: (typeof MODES)[number];
  quality?: number; // hauteur maximale de la vidéo (1080, 720, 480…)
  audioFormat?: (typeof AUDIO_FORMATS)[number];
  subtitles?: boolean;
  playlist?: boolean;
}

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/**
 * Valide la demande avant de lancer yt-dlp : URL http(s) seulement (jamais une option),
 * listes blanches pour action, mode et format audio, hauteur entière. Message d'erreur sinon.
 */
export function validateMediaRequest(raw: unknown): MediaRequest | string {
  if (!raw || typeof raw !== "object") return "download_media : demande invalide.";
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === "string" ? r.url.trim() : "";
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return "download_media : URL http(s) requise.";
  const action = r.action ?? "download";
  if (!isOneOf(ACTIONS, action)) return `download_media : action inconnue (${String(action)}).`;
  const mode = r.mode ?? "video";
  if (!isOneOf(MODES, mode)) return `download_media : mode inconnu (${String(mode)}) : video, audio ou subtitles.`;
  const audioFormat = r.audioFormat ?? "mp3";
  if (!isOneOf(AUDIO_FORMATS, audioFormat)) return `download_media : format audio inconnu (${String(audioFormat)}) : ${AUDIO_FORMATS.join(", ")}.`;
  let quality: number | undefined;
  if (r.quality !== undefined && r.quality !== null && r.quality !== "") {
    quality = Number(r.quality);
    if (!Number.isInteger(quality) || quality < 1 || quality > 10_000) return "download_media : quality = hauteur en pixels (entier, ex. 720).";
  }
  return { url, action, mode, audioFormat, quality, subtitles: r.subtitles === true, playlist: r.playlist === true };
}

/** Oublie les téléchargements terminés depuis plus de 24 h (le démon tourne des mois). */
export function purgeOldJobs(now = Date.now()): number {
  let removed = 0;
  for (const [id, job] of jobs) {
    if (job.done && now - (job.ended || job.started) > JOB_MAX_AGE_MS) {
      jobs.delete(id);
      removed++;
    }
  }
  return removed;
}

interface Job {
  id: string;
  url: string;
  started: number;
  done: boolean;
  files: string[];
  ids: string[]; // identifiants des vidéos : retrouver les sous-titres écrits à côté
  error: string;
  progress: string;
  ended: number;
}

const jobs = new Map<string, Job>();
let jobCounter = 0;

function run(args: string[], onLine: (line: string) => void): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("yt-dlp", args, { windowsHide: true });
    let stderr = "";
    let buffer = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      lines.forEach(onLine);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (err) => resolve({ code: -1, stderr: `yt-dlp introuvable (${err.message}) : l'installer, par exemple winget install yt-dlp.` }));
    child.on("close", (code) => {
      if (buffer) onLine(buffer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

const lastError = (stderr: string) =>
  stderr.split(/\r?\n/).filter((l) => /ERROR/.test(l)).pop()?.replace(/^.*?ERROR:\s*/, "") || stderr.trim().split(/\r?\n/).pop() || "erreur inconnue";

const size = (bytes: number) => (bytes > 1_048_576 ? `${(bytes / 1_048_576).toFixed(1).replace(".", ",")} Mo` : `${Math.round(bytes / 1024)} Ko`);

const duration = (s?: number) => {
  if (!s) return "durée inconnue";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min ${String(sec).padStart(2, "0")} s`;
};

/** Titre, durée, qualités et sous-titres disponibles, sans rien télécharger. */
export async function mediaInfo(req: MediaRequest): Promise<string> {
  let json = "";
  // « -- » : l'URL ne peut jamais être lue comme une option de yt-dlp.
  const { code, stderr } = await run(["-J", "--no-warnings", req.playlist ? "--yes-playlist" : "--no-playlist", "--", req.url], (l) => (json += l));
  if (code !== 0) throw new Error(lastError(stderr));
  const info = JSON.parse(json);
  if (info._type === "playlist") {
    return `Playlist « ${info.title} » : ${info.entries?.length ?? "?"} éléments.\n` +
      (info.entries ?? []).slice(0, 20).map((e: { title: string; duration?: number }) => `- ${e.title} (${duration(e.duration)})`).join("\n");
  }
  const heights = [...new Set((info.formats ?? []).map((f: { height?: number }) => f.height).filter(Boolean))].sort((a, b) => (b as number) - (a as number));
  const subs = Object.keys(info.subtitles ?? {});
  const autoSubs = Object.keys(info.automatic_captions ?? {}).filter((l) => /^(fr|en)(-|$)/.test(l));
  return [
    `« ${info.title} »${info.uploader ? ` par ${info.uploader}` : ""} (${info.extractor_key ?? "site inconnu"})`,
    `Durée : ${duration(info.duration)}`,
    heights.length ? `Vidéo jusqu'à ${heights[0]}p (disponible : ${heights.slice(0, 8).join(", ")})` : "Audio seulement",
    `Sous-titres : ${subs.length ? subs.slice(0, 10).join(", ") : "aucun"}${autoSubs.length ? ` ; automatiques : ${autoSubs.slice(0, 6).join(", ")}` : ""}`,
  ].join("\n");
}

/** Lance le téléchargement ; rend la main à la fin, ou après 4 min en laissant le travail continuer. */
export async function mediaDownload(req: MediaRequest): Promise<string> {
  purgeOldJobs();
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
  const args = [
    req.playlist ? "--yes-playlist" : "--no-playlist",
    "--windows-filenames", "--no-mtime", "--newline", "--no-warnings",
    "-o", join(MEDIA_DIR, "%(title).150B [%(id)s].%(ext)s"),
    "--print", "after_move:filepath",
    "--progress-template", "download:[progression] %(progress._percent_str)s de %(progress._total_bytes_str)s",
  ];
  if (req.mode === "subtitles") {
    // Seulement les sous-titres : le plus rapide pour « lire » une vidéo.
    args.push("--skip-download");
  } else if (req.mode === "audio") {
    args.push("-f", "ba/b", "-x", "--audio-format", req.audioFormat ?? "mp3", "--audio-quality", "0");
  } else {
    const h = Number(req.quality);
    args.push("-f", h > 0 ? `bv*[height<=${h}]+ba/b[height<=${h}]` : "bv*+ba/b", "--merge-output-format", "mp4");
  }
  args.push("--print", "video:[identifiant] %(id)s");
  if (req.subtitles || req.mode === "subtitles") {
    // YouTube limite vite les sous-titres (HTTP 429) : des pauses entre les requêtes, des nouvelles tentatives,
    // et un refus sur une langue ne doit pas faire échouer tout le téléchargement.
    args.push("--write-subs", "--write-auto-subs", "--sub-langs", "fr,fr-FR,fr-orig,en,en-US,en-GB,en-orig", "--convert-subs", "srt",
      "--sleep-subtitles", "3", "--retries", "5", "--retry-sleep", "http:exp=2:30", "--ignore-errors");
  }
  args.push("--", req.url);

  const job: Job = { id: `media_${++jobCounter}`, url: req.url, started: Date.now(), done: false, files: [], ids: [], error: "", progress: "", ended: 0 };
  jobs.set(job.id, job);
  const finished = run(args, (line) => {
    if (line.startsWith("[progression]")) job.progress = line.replace("[progression]", "").trim();
    else if (line.startsWith("[identifiant]")) job.ids.push(line.replace("[identifiant]", "").trim());
    else if (line.trim() && existsSync(line.trim())) job.files.push(line.trim());
  }).then(({ code, stderr }) => {
    job.done = true;
    job.ended = Date.now();
    if (code !== 0) job.error = lastError(stderr);
  });

  await Promise.race([finished, new Promise((r) => setTimeout(r, WAIT_MS))]);
  return describe(job);
}

export function mediaStatus(jobId?: string): string {
  purgeOldJobs();
  if (jobId) {
    const job = jobs.get(jobId);
    if (!job) throw new Error(`Téléchargement ${jobId} inconnu (le démon a peut-être redémarré).`);
    return describe(job);
  }
  return jobs.size ? [...jobs.values()].map(describe).join("\n\n") : "Aucun téléchargement depuis le démarrage du démon.";
}

function describe(job: Job): string {
  if (!job.done) {
    const elapsed = Math.round((Date.now() - job.started) / 1000);
    return `Téléchargement ${job.id} en cours depuis ${elapsed} s${job.progress ? ` (${job.progress})` : ""} : ${job.url}\n` +
      `Il continue en arrière-plan ; suivre avec action="status", jobId="${job.id}".`;
  }
  const hint = /429|Too Many Requests/i.test(job.error)
    ? "\nYouTube limite les requêtes de sous-titres. Pour lire une vidéo ouverte dans un onglet : l'outil transcript, qui ne passe pas par yt-dlp."
    : "";
  const subtitles = readdirSync(MEDIA_DIR)
    .filter((n) => n.endsWith(".srt") && job.ids.some((id) => n.includes(`[${id}]`)))
    .map((n) => join(MEDIA_DIR, n));
  if (!job.files.length && !subtitles.length) return `Échec du téléchargement ${job.id} : ${job.error || "aucun fichier produit"}${hint}`;
  const files = [...job.files, ...subtitles].map((f) => {
    const bytes = existsSync(f) ? statSync(f).size : 0;
    return `- ${basename(f)} (${size(bytes)})\n  ${f}`;
  });
  return `Téléchargement ${job.id} terminé en ${Math.round(((job.ended || Date.now()) - job.started) / 1000)} s :\n${files.join("\n")}` +
    (job.error ? `\n(avec une erreur : ${job.error})${hint}` : "");
}
