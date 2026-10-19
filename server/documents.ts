/**
 * read_document : le texte d'un PDF, Word, PowerPoint, Excel ou fichier texte, page par page.
 * Les pages de PDF sans texte (scans) passent par l'OCR de Windows (server/pdf-ocr.ps1).
 * Par sécurité, seul le dossier Téléchargements est lisible : une page piégée ne doit pas pouvoir
 * pousser un agent à lire n'importe quel fichier de l'utilisateur.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { extractText, getDocumentProxy } from "unpdf";

const DOWNLOADS = join(homedir(), "Downloads");
const MAX_CHARS = 60_000;
const OCR_SCRIPT = fileURLToPath(new URL("./pdf-ocr.ps1", import.meta.url));

export interface DocumentRequest {
  path: string;
  pages?: string; // « 3 », « 2-5 », « 1,4,7 »
}

/** Chemin absolu, dans Téléchargements (liens et « .. » résolus), ou erreur. */
export function resolveDocumentPath(input: string): string {
  if (!input) throw new Error("'path' requis (chemin renvoyé par downloads, ou nom de fichier dans Téléchargements).");
  const candidates = isAbsolute(input) ? [input] : [join(DOWNLOADS, "agent-browser-control", input), join(DOWNLOADS, input)];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`Fichier introuvable : ${input}`);
  const real = realpathSync(resolve(found));
  const rel = relative(realpathSync(DOWNLOADS), real);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Par sécurité, read_document ne lit que le dossier Téléchargements (${DOWNLOADS}).`);
  }
  if (!statSync(real).isFile()) throw new Error(`${input} n'est pas un fichier.`);
  return real;
}

/** Pages demandées (« 3 », « 2-5 », « 1,4 »), bornées par le nombre total : « 1-999999999 » ne boucle pas. */
export function parsePages(spec: string | undefined, total: number): number[] {
  if (!spec) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const part of spec.split(",")) {
    const [a, b] = part.split("-").map((n) => parseInt(n.trim(), 10));
    if (!Number.isFinite(a)) continue;
    const last = Math.min(Number.isFinite(b) ? b : a, total);
    for (let p = Math.max(a, 1); p <= last; p++) pages.add(p);
  }
  return [...pages].sort((x, y) => x - y);
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

// --- PDF -------------------------------------------------------------------------------------

function ocrPdfPages(path: string, pages: number[]): Promise<Map<number, string>> {
  if (process.platform !== "win32" || !pages.length) return Promise.resolve(new Map());
  return new Promise((resolveOcr) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", OCR_SCRIPT, path, pages.join(",")],
      { encoding: "utf8", timeout: 20_000 + pages.length * 8_000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
      (err, out) => {
        if (err) return resolveOcr(new Map());
        try {
          const list = JSON.parse(out.replace(/^﻿/, "")) as { page: number; texte: string }[];
          resolveOcr(new Map(list.map((p) => [p.page, p.texte])));
        } catch {
          resolveOcr(new Map());
        }
      },
    );
  });
}

async function readPdf(path: string, spec?: string) {
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = parsePages(spec, totalPages);
  // Moins de 20 caractères : page scannée (une image) ; on la lit par OCR (30 pages au plus).
  const scanned = pages.filter((p) => (text[p - 1] ?? "").trim().length < 20).slice(0, 30);
  const ocr = await ocrPdfPages(path, scanned);
  return {
    kind: "PDF",
    total: totalPages,
    unit: "Page",
    pages: pages.map((p) => ({ n: p, text: ocr.has(p) ? `[texte lu par OCR]\n${ocr.get(p)}` : (text[p - 1] ?? "").trim() })),
    note: scanned.length ? `${scanned.length} page(s) scannée(s) lue(s) par OCR (lecture approximative).` : "",
  };
}

// --- Office (fichiers zip de XML) ---------------------------------------------------------------

async function readDocx(path: string) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  // Tableaux : le texte d'une cellule sur une ligne, les cellules séparées par « | », une ligne par rangée.
  const body = xml
    .replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, (row) =>
      [...row.matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)]
        .map(([cell]) => cell.replace(/<\/w:p>/g, " ").replace(/<[^>]+>/g, "").trim())
        .join(" | ") + "\n")
    .replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n").replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "");
  const text = decodeXml(body).replace(/\n{3,}/g, "\n\n").trim();
  return { kind: "Word", total: 1, unit: "Document", pages: [{ n: 1, text }], note: "" };
}

async function readPptx(path: string, spec?: string) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/g)!.pop()) - Number(b.match(/\d+/g)!.pop()));
  const pages = parsePages(spec, slides.length);
  const out = [];
  for (const p of pages) {
    const xml = await zip.file(slides[p - 1])!.async("string");
    const text = decodeXml(xml.replace(/<\/a:p>/g, "\n").replace(/<[^>]+>/g, "")).replace(/\n{2,}/g, "\n").trim();
    out.push({ n: p, text });
  }
  return { kind: "PowerPoint", total: slides.length, unit: "Diapositive", pages: out, note: "" };
}

async function readXlsx(path: string, spec?: string) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const shared = [...((await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => decodeXml(m[1].replace(/<[^>]+>/g, "")));
  const workbook = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const names = [...workbook.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => decodeXml(m[1]));
  const sheets = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/g)!.pop()) - Number(b.match(/\d+/g)!.pop()));
  const pages = parsePages(spec, sheets.length);
  const out = [];
  for (const p of pages) {
    const xml = await zip.file(sheets[p - 1])!.async("string");
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
      [...row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
        .map(([, attrs, inner = ""]) => {
          const value = decodeXml((inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "").trim());
          return /t="s"/.test(attrs) ? shared[Number(value)] ?? "" : value;
        })
        .join(" ; "),
    );
    out.push({ n: p, text: `${names[p - 1] ?? `Feuille ${p}`}\n${rows.join("\n")}` });
  }
  return { kind: "Excel", total: sheets.length, unit: "Feuille", pages: out, note: "Cellules séparées par « ; »." };
}

// --- Point d'entrée ------------------------------------------------------------------------------

export async function readDocument({ path: input, pages }: DocumentRequest): Promise<string> {
  const path = resolveDocumentPath(input);
  const ext = extname(path).toLowerCase();
  let doc;
  if (ext === ".pdf") doc = await readPdf(path, pages);
  else if (ext === ".docx") doc = await readDocx(path);
  else if (ext === ".pptx") doc = await readPptx(path, pages);
  else if (ext === ".xlsx") doc = await readXlsx(path, pages);
  else if ([".txt", ".md", ".csv", ".json", ".srt", ".vtt", ".html", ".htm", ".xml", ".log"].includes(ext)) {
    let text = readFileSync(path, "utf8").replace(/^﻿/, "");
    if (ext.startsWith(".htm")) text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ");
    doc = { kind: ext.slice(1).toUpperCase(), total: 1, unit: "Fichier", pages: [{ n: 1, text: text.trim() }], note: "" };
  } else {
    throw new Error(`Format ${ext || "inconnu"} non pris en charge (PDF, DOCX, PPTX, XLSX, texte).`);
  }

  let out = "";
  let last = 0;
  for (const page of doc.pages) {
    const block = doc.total > 1 ? `\n--- ${doc.unit} ${page.n} ---\n${page.text || "(vide)"}\n` : `${page.text || "(vide)"}\n`;
    if (out.length + block.length > MAX_CHARS) break;
    out += block;
    last = page.n;
  }
  const remaining = doc.pages.filter((p) => p.n > last);
  const more = remaining.length
    ? `\n[Tronqué à ${MAX_CHARS} caractères : suite avec pages="${remaining[0].n}-${remaining.at(-1)!.n}".]`
    : "";
  const header = `${basename(path)} : ${doc.kind}${doc.total > 1 ? `, ${doc.total} ${doc.unit.toLowerCase()}s` : ""}.` +
    (doc.note ? ` ${doc.note}` : "");
  return `${header}\n${out.trim()}${more}`;
}
