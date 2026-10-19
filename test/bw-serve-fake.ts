/**
 * Faux `bw serve` pour test/bw-serve.ts : même protocole que le vrai (socket ou tube nommé passé en
 * `--hostname unix://…`, contrôle de l'hôte et de l'origine, enveloppe {success, data}), sur un coffre fictif.
 * Session acceptée : BW_SESSION = "cle-ok". FAKE_BW_SLOW_MS retarde le démarrage.
 */
import { createServer } from "node:http";

const hostArg = process.argv[process.argv.indexOf("--hostname") + 1] ?? "";
const address = hostArg.replace(/^unix:\/\//, "");
const unlocked = process.env.BW_SESSION === "cle-ok";
const vault = [
  {
    id: "it-1",
    name: "discord.com",
    notes: "note confidentielle",
    login: { username: "louis", password: "mdp-faux-secret-9", uris: [{ uri: "https://discord.com" }] },
  },
  { id: "it-2", name: "autre", login: { username: "x", password: "autre-secret", uris: [{ uri: "https://exemple.fr" }] } },
];
let syncs = 0;

const server = createServer((req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers.host !== "localhost:8087" || req.headers.origin !== undefined) return send(403, { success: false, message: "refusé" });
  const url = new URL(req.url ?? "/", "http://localhost:8087");
  if (url.pathname === "/status") {
    return send(200, { success: true, data: { object: "template", template: { status: unlocked ? "unlocked" : "locked", userEmail: "a@b.c", syncs } } });
  }
  if (!unlocked) return send(400, { success: false, message: "Vault is locked." });
  if (url.pathname === "/list/object/items") {
    const origin = url.searchParams.get("url");
    const search = url.searchParams.get("search");
    const data = origin ? vault.filter((it) => it.login.uris.some((u) => u.uri === origin)) : vault.filter((it) => search && it.name.includes(search));
    return send(200, { success: true, data: { object: "list", data } });
  }
  const m = /^\/object\/(username|password)\/(.+)$/.exec(url.pathname);
  if (m) {
    const it = vault.find((v) => v.id === decodeURIComponent(m[2]));
    if (!it) return send(404, { success: false, message: "Not found." });
    return send(200, { success: true, data: { object: "string", data: it.login[m[1] as "username" | "password"] } });
  }
  if (url.pathname === "/sync" && req.method === "POST") {
    syncs++;
    return send(200, { success: true, data: { object: "message", title: "Syncing complete." } });
  }
  send(404, { success: false, message: "Route inconnue." });
});

setTimeout(() => server.listen(address), Number(process.env.FAKE_BW_SLOW_MS ?? 0));
process.on("SIGTERM", () => process.exit(0));
