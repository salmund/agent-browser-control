/**
 * Relais des demandes qui attendent l'utilisateur (accord pour un secret, passage de main, coffre
 * verrouillé) vers un service de messagerie local : Argos (Telegram, interface web) sur Orion, où
 * personne ne regarde le panneau de l'extension.
 *
 * Configuration : `relay.json` dans le dossier de configuration (absent : aucun relais), par exemple
 *   {"url": "http://127.0.0.1:8096/api/abc/demandes", "headers": {"X-Argos": "1"},
 *    "bureauUrl": "https://orion.louisdumontier.fr/bureau"}
 *
 * Chaque demande part avec une URL de réponse et un jeton propre à elle (aléatoire, à usage unique) :
 * le service relayé n'a pas besoin du jeton du démon, et ne peut répondre qu'aux demandes qu'il a reçues.
 * Le mot de passe maître ne passe jamais par ici : le relais ne fait que trancher (autoriser, refuser).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenMatches } from "./security.ts";

export interface RelayConfig {
  url: string;
  headers?: Record<string, string>;
  bureauUrl?: string;
}

interface PendingRequest {
  token: string;
  until: number;
}

const MAX_PENDING = 50;
const DEFAULT_TTL_MS = 10 * 60_000;

export function loadRelayConfig(configDir: string): RelayConfig | null {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, "relay.json"), "utf8"));
    const url = new URL(String(raw?.url ?? ""));
    if (!/^https?:$/.test(url.protocol)) return null;
    const headers = Object.fromEntries(
      Object.entries(raw?.headers ?? {}).filter(([k, v]) => typeof v === "string" && /^[\w-]+$/.test(k)),
    ) as Record<string, string>;
    const bureauUrl = typeof raw?.bureauUrl === "string" && /^https?:\/\//.test(raw.bureauUrl) ? raw.bureauUrl : undefined;
    return { url: url.href, headers, ...(bureauUrl && { bureauUrl }) };
  } catch {
    return null;
  }
}

export interface RelayDeps {
  configDir: string;
  /** URL que le service relayé rappelle pour répondre (route du démon). */
  replyUrl: string;
  log: (entry: Record<string, unknown>) => void;
  /** Transmet la décision à l'extension ; vrai si la demande existait encore. */
  forward: (id: string, decision: string, note?: string) => Promise<boolean>;
}

export function createRelay(deps: RelayDeps) {
  const pending = new Map<string, PendingRequest>();

  const purge = () => {
    const now = Date.now();
    for (const [id, p] of pending) if (p.until < now) pending.delete(id);
  };

  async function post(config: RelayConfig, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...config.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  return {
    /** Nouvelle demande signalée par l'extension (la même peut revenir après une reconnexion : ignorée). */
    async request(msg: Record<string, unknown>): Promise<void> {
      const config = loadRelayConfig(deps.configDir);
      const id = typeof msg.id === "string" ? msg.id.slice(0, 80) : "";
      if (!config || !id || pending.has(id)) return;
      purge();
      if (pending.size >= MAX_PENDING) return;
      const until = typeof msg.until === "number" && msg.until > Date.now() ? msg.until : Date.now() + DEFAULT_TTL_MS;
      const token = randomBytes(24).toString("hex");
      pending.set(id, { token, until });
      const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
      const choices = Array.isArray(msg.choices)
        ? msg.choices.slice(0, 6).map((c) => ({ id: text(c?.id, 120), label: text(c?.label, 80) })).filter((c) => c.id && c.label)
        : [];
      try {
        await post(config, {
          event: "request", id, kind: text(msg.kind, 20), agent: text(msg.agent, 80),
          text: text(msg.text, 500), detail: text(msg.detail, 500), site: text(msg.site, 200),
          until: typeof msg.until === "number" ? msg.until : null, choices,
          replyUrl: deps.replyUrl, replyToken: token, ...(config.bureauUrl && { bureauUrl: config.bureauUrl }),
        });
        deps.log({ event: "relay", ok: true, id, kind: msg.kind });
      } catch (err) {
        pending.delete(id);
        deps.log({ event: "relay", ok: false, id, error: String((err as Error)?.message ?? err).slice(0, 200) });
      }
    },

    /** Demande réglée ailleurs (panneau, délai) ou après une décision : le service relayé met à jour son message. */
    async done(id: unknown): Promise<void> {
      if (typeof id !== "string" || !pending.delete(id)) return;
      const config = loadRelayConfig(deps.configDir);
      if (config) await post(config, { event: "done", id }).catch(() => {});
    },

    /** Réponse du service relayé (route HTTP du démon, sans le jeton du démon : celui de la demande). */
    async decide(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
      purge();
      const id = typeof body.id === "string" ? body.id : "";
      const p = pending.get(id);
      if (!p) return { status: 404, body: { ok: false, error: "Demande inconnue ou expirée." } };
      if (!tokenMatches(body.token, p.token)) {
        deps.log({ event: "relay_decision", ok: false, id, reason: "jeton" });
        return { status: 403, body: { ok: false, error: "Jeton invalide." } };
      }
      const decision = typeof body.decision === "string" ? body.decision.slice(0, 120) : "";
      if (!decision) return { status: 400, body: { ok: false, error: "Décision manquante." } };
      pending.delete(id);
      const note = typeof body.note === "string" ? body.note.slice(0, 2000) : undefined;
      const ok = await deps.forward(id, decision, note).catch(() => false);
      deps.log({ event: "relay_decision", ok, id, decision: decision.split(":")[0], note: note ? note.length : 0 });
      return ok ? { status: 200, body: { ok: true } } : { status: 404, body: { ok: false, error: "Demande déjà réglée ou extension non connectée." } };
    },
  };
}
