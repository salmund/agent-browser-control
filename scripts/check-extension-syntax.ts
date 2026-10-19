/**
 * L'extension est en JS sans build : au moins vérifier que chaque fichier parse.
 * (Une erreur de syntaxe dans background.js a déjà coûté une session entière.)
 * Racine, service worker (bg/) et panneau (panel/, modules ES : node --check les reconnaît à leur syntaxe).
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = ["", "bg/", "panel/"].flatMap((dir) =>
  readdirSync(`extension/${dir}`).filter((f) => f.endsWith(".js")).map((f) => `${dir}${f}`),
);
for (const f of files) {
  execFileSync(process.execPath, ["--check", `extension/${f}`], { stdio: "inherit" });
}
console.log(`syntaxe extension : OK (${files.length} fichiers)`);
