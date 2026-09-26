/** Recharge l'extension à distance via le démon (après une modification de ses fichiers). */
import { BASE_URL, getToken } from "../server/common.ts";

const res = await fetch(`${BASE_URL}/reload-extension`, { method: "POST", headers: { "x-abc-token": getToken() } }).catch(() => null);
if (!res) {
  console.error("Démon injoignable : lancer un agent ou `npm run daemon`.");
  process.exit(1);
}
console.log(res.ok ? "Extension rechargée." : `Échec : ${res.status} ${await res.text()}`);
