/**
 * Oublie l'extension épinglée par le démon (confiance au premier usage). À lancer après une
 * réinstallation de l'extension (nouvel identifiant) : la prochaine extension qui se connecte
 * est épinglée à sa place. Lancer avec : npm run unpin-extension
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { EXTENSION_ORIGIN_FILE } from "../server/common.ts";

if (!existsSync(EXTENSION_ORIGIN_FILE)) {
  console.log(`Aucune extension épinglée (${EXTENSION_ORIGIN_FILE} absent) : la prochaine connexion sera épinglée.`);
  process.exit(0);
}
const origin = readFileSync(EXTENSION_ORIGIN_FILE, "utf8").trim();
unlinkSync(EXTENSION_ORIGIN_FILE);
console.log(
  `Épinglage oublié (${origin || "origine vide"}). Recharger maintenant l'extension voulue (chrome://extensions) : ` +
    "elle sera épinglée à sa première connexion.",
);
