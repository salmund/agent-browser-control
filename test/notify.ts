/**
 * Test sans navigateur des notifications poussées (server/notify.ts) : seuls les événements qui concernent
 * l'agent passent, avec un message lisible ; les autres sont ignorés.
 *
 * Lancer avec : node test/notify.ts
 */
import assert from "node:assert";
import { noticeFor } from "../server/notify.ts";

const watch = noticeFor({ event: "watch_triggered", agent: "claude-code", id: "w1", tabId: 12, cond: "text contient « Envoyé »" }, "claude-code");
assert.ok(watch && watch.level === "info" && String(watch.data.message).includes("onglet 12"), "surveillance de l'agent poussée");
assert.strictEqual(noticeFor({ event: "watch_triggered", agent: "autre", id: "w2" }, "claude-code"), null, "surveillance d'un autre agent ignorée");

const paused = noticeFor({ event: "watch_paused", agent: "claude-code", id: "w1" }, "claude-code");
assert.ok(paused && paused.level === "warning", "pause signalée en avertissement");

assert.ok(noticeFor({ event: "extension_disconnected" }, "x")?.level === "warning", "déconnexion du navigateur : tous les agents");
assert.ok(noticeFor({ event: "extension_connected" }, "x")?.level === "info", "reconnexion signalée");
assert.strictEqual(noticeFor({ event: "settings" }, "x"), null, "événement banal ignoré");
assert.strictEqual(noticeFor({ tool: "computer" }, "x"), null, "ligne d'appel ignorée");

console.log("notify : OK");
