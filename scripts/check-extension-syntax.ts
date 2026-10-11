/**
 * L'extension est en JS sans build : au moins vérifier que chaque fichier parse.
 * (Une erreur de syntaxe dans background.js a déjà coûté une session entière.)
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = readdirSync("extension").filter((f) => f.endsWith(".js"));
for (const f of files) {
  execFileSync(process.execPath, ["--check", `extension/${f}`], { stdio: "inherit" });
}
console.log(`syntaxe extension : OK (${files.length} fichiers)`);
