/**
 * Lecture du texte affiché (OCR), pour les pages dessinées dans un <canvas> ou les images.
 * Sous Windows : le moteur OCR du système (server/ocr.ps1), local et sans dépendance.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface OcrLine {
  texte: string;
  x: number;
  y: number;
  largeur: number;
  hauteur: number;
}

const SCRIPT = fileURLToPath(new URL("./ocr.ps1", import.meta.url));

export async function runOcr(pngBase64: string, langue = ""): Promise<{ langue: string; lignes: OcrLine[] }> {
  if (process.platform !== "win32") {
    throw new Error("La lecture du texte à l'écran (OCR) n'est disponible que sous Windows pour l'instant.");
  }
  const dir = mkdtempSync(join(tmpdir(), "abc-ocr-"));
  const image = join(dir, "capture.png");
  writeFileSync(image, Buffer.from(pngBase64, "base64"));
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, image, ...(langue ? [langue] : [])],
        { encoding: "utf8", timeout: 30_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
        (err, out, errOut) => (err ? reject(new Error(errOut.trim() || err.message)) : resolve(out)),
      );
    });
    const data = JSON.parse(stdout.replace(/^﻿/, ""));
    return { langue: data.langue, lignes: Array.isArray(data.lignes) ? data.lignes : data.lignes ? [data.lignes] : [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
