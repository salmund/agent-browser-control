/**
 * Relais des demandes vers un service local (Argos) : envoi avec un jeton par demande, réponse acceptée
 * une seule fois avec le bon jeton, « réglée ailleurs » signalée, rien d'envoyé sans relay.json.
 * Lancer avec : node test/relay.ts
 */
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelay } from "../server/relay.ts";

const received: Record<string, unknown>[] = [];
const argos = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    received.push({ ...JSON.parse(raw), header: req.headers["x-argos"] });
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
});
await new Promise<void>((r) => argos.listen(0, "127.0.0.1", r));
const port = (argos.address() as AddressInfo).port;

const dir = mkdtempSync(join(tmpdir(), "abc-relay-"));
try {
  const forwarded: unknown[][] = [];
  const relay = createRelay({
    configDir: dir,
    replyUrl: "http://127.0.0.1:7878/relay/decision",
    log: () => {},
    forward: async (...args) => (forwarded.push(args), true),
  });
  const demande = {
    id: "credential:1", kind: "credential", agent: "muse-code", text: "muse-code veut remplir un mot de passe",
    until: Date.now() + 60_000, choices: [{ id: "allow:abc", label: "Autoriser" }, { id: "deny", label: "Refuser" }],
  };

  await relay.request(demande);
  assert.strictEqual(received.length, 0, "sans relay.json : rien n'est envoyé");

  writeFileSync(join(dir, "relay.json"), JSON.stringify({
    url: `http://127.0.0.1:${port}/api/abc/demandes`, headers: { "X-Argos": "1" }, bureauUrl: "https://exemple.test/bureau",
  }));
  await relay.request(demande);
  await relay.request(demande);
  assert.strictEqual(received.length, 1, "une demande déjà relayée ne repart pas (reconnexion de l'extension)");
  const sent = received[0];
  assert.strictEqual(sent.event, "request");
  assert.strictEqual(sent.header, "1", "en-têtes de relay.json transmis");
  assert.strictEqual(sent.bureauUrl, "https://exemple.test/bureau");
  assert.match(String(sent.replyToken), /^[0-9a-f]{48}$/, "jeton propre à la demande");

  let out = await relay.decide({ id: "credential:1", token: "faux", decision: "deny" });
  assert.strictEqual(out.status, 403, "mauvais jeton refusé");
  out = await relay.decide({ id: "credential:1", token: sent.replyToken, decision: "allow:abc" });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(forwarded, [["credential:1", "allow:abc", undefined]], "décision transmise à l'extension");
  out = await relay.decide({ id: "credential:1", token: sent.replyToken, decision: "deny" });
  assert.strictEqual(out.status, 404, "jeton à usage unique");
  await relay.done("credential:1");
  assert.strictEqual(received.length, 1, "pas de « réglée ailleurs » après une décision venue du relais");

  await relay.request({ ...demande, id: "ask:ask_2", kind: "ask" });
  await relay.done("ask:ask_2");
  assert.deepStrictEqual(received.at(-1), { event: "done", id: "ask:ask_2", header: "1" }, "réglée dans le panneau : signalée");
  out = await relay.decide({ id: "ask:ask_2", token: received[1].replyToken, decision: "done" });
  assert.strictEqual(out.status, 404, "plus de réponse possible une fois réglée ailleurs");
  console.log("relay : OK (sans configuration, jeton par demande, usage unique, réglée ailleurs)");
} finally {
  argos.close();
  rmSync(dir, { recursive: true, force: true });
}
