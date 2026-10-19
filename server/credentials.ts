/**
 * Secrets d'authentification (outil credentials_fill) : fonctions pures.
 *
 * Principe : l'agent ne manipule que des références opaques (slot ids). Les valeurs
 * en clair n'existent que dans l'extension (chiffrées au repos, déchiffrées en mémoire
 * le temps du remplissage) et ne transitent jamais par MCP, le journal ou les résultats.
 * Règle d'or : aucun secret en clair dans les paramètres, les retours ou les logs.
 */
import { maskValue } from "./analysis.ts";

export const CREDENTIALS_FORMAT = "abc-credentials-v1";
export const PBKDF2_ITERATIONS = 210_000;
export const APPROVAL_TIMEOUT_MS = 75_000;
export const HAR_MUTE_MS = 120_000;

export type SlotPolicy = "ask" | "always";

export interface SlotMeta {
  id: string;
  label: string;
  /** Hôtes autorisés (suffixe : "univ-rouen.fr" couvre sso.univ-rouen.fr). */
  hosts: string[];
  policy: SlotPolicy;
  created: string;
  lastUsed?: string;
}

/** Référence vers un secret hébergé hors du coffre intégré (aucune valeur stockée). */
export interface ExternalSlotRef {
  provider: "bitwarden";
  /** Id d'item Bitwarden (UUID). */
  itemId: string;
  /** Nom d'affichage capturé à la création (rappel, non utilisé pour résoudre). */
  itemName?: string;
}

export interface SlotRecord extends SlotMeta {
  /** Charge chiffrée (AES-GCM) : jamais de secret en clair ici. Absente pour les slots externes. */
  iv?: string;
  data?: string;
  /** Présent pour les slots externes (Bitwarden) : résolu au remplissage, jamais stocké. */
  external?: ExternalSlotRef;
}

/** Un slot externe n'a pas besoin de la clé du coffre intégré pour être rempli. */
export function isExternalSlot(slot: Pick<SlotRecord, "external">): boolean {
  return slot.external?.provider === "bitwarden" && typeof slot.external.itemId === "string" && !!slot.external.itemId;
}

export function slotNeedsVaultKey(slot: Pick<SlotRecord, "external">): boolean {
  return !isExternalSlot(slot);
}

export interface SlotStore {
  format: string;
  salt: string;
  verifier: { iv: string; data: string };
  slots: Record<string, SlotRecord>;
}

export function emptyStore(salt: string, verifier: { iv: string; data: string }): SlotStore {
  return { format: CREDENTIALS_FORMAT, salt, verifier, slots: {} };
}

export function isValidSlotId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** "sso.univ-rouen.fr" est couvert par "univ-rouen.fr" (ou identique). */
export function hostCovered(host: string, scope: string): boolean {
  const h = normalizeHost(host);
  const s = normalizeHost(scope);
  if (!h || !s) return false;
  return h === s || h.endsWith(`.${s}`);
}

export function scopeAllows(host: string, slot: Pick<SlotMeta, "hosts">): boolean {
  return slot.hosts.some((s) => hostCovered(host, s));
}

/** Refus explicite, sans jamais citer de valeur. */
export function scopeError(host: string, slot: SlotMeta): string {
  return (
    `Slot "${slot.id}" : site ${host} hors périmètre ` +
    `(${slot.hosts.map((h) => `"${h}"`).join(", ")}). Remplissage refusé.`
  );
}

export interface FillRequest {
  ref: string;
  slot: string;
}

export function validateFills(fills: unknown): { ok: true; fills: FillRequest[] } | { ok: false; error: string } {
  if (!Array.isArray(fills) || !fills.length) return { ok: false, error: "Fournir 'fills' (liste de {ref, slot})." };
  for (const f of fills) {
    if (typeof f?.ref !== "string" || !f.ref) return { ok: false, error: "Chaque remplissage exige 'ref'." };
    if (!isValidSlotId(f?.slot)) return { ok: false, error: `Slot invalide : ${JSON.stringify(f?.slot)}.` };
  }
  return { ok: true, fills: fills as FillRequest[] };
}

/** Ligne de journal et résumé d'activité : ids et métadonnées uniquement, jamais de valeur. */
export function auditLine(agent: string, fills: FillRequest[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent,
    tool: "credentials_fill",
    slots: [...new Set(fills.map((f) => f.slot))],
    champs: fills.length,
    ...extra,
  };
}

/** Résultat renvoyé à l'agent : confirmation par ref, aucune valeur recopiée. */
export function fillResult(ref: string, slotId: string): string {
  return `${ref} rempli (slot "${slotId}").`;
}

/**
 * Garde-fou de non-fuite : vérifie qu'aucune sortie (résultat, résumé, journal)
 * ne contient une valeur sensible connue. À utiliser dans les tests.
 */
export function leaksSecret(outputs: string[], secrets: string[]): string[] {
  return secrets.filter((s) => s && outputs.some((o) => o.includes(s)));
}

/** Résumé d'activité pour le panneau (aucune valeur, même masquée c'est inutile ici). */
export function activitySummary(fills: FillRequest[], submitRef?: string): string {
  const slots = [...new Set(fills.map((f) => f.slot))].map((s) => `"${s}"`).join(", ");
  return `credentials_fill ${fills.map((f) => f.ref).join(", ")} [${slots}]${submitRef ? ` -> ${submitRef}` : ""}`;
}

export { maskValue };
