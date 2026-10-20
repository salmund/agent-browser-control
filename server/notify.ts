/**
 * Quels événements du journal du démon méritent d'être poussés à l'agent (notification MCP « logging »)
 * plutôt que sondés. Fonction pure : le shim stdio (server/mcp.ts) l'applique aux lignes de GET /events.
 * Les clients MCP qui ignorent les notifications de journal n'y perdent rien : l'état reste lisible par watch.
 */

export interface PushedNotice {
  level: "info" | "warning";
  data: Record<string, unknown>;
}

export function noticeFor(event: Record<string, unknown>, agent: string): PushedNotice | null {
  switch (event.event) {
    case "watch_triggered":
      if (event.agent !== agent) return null;
      return {
        level: "info",
        data: {
          kind: "watch_triggered",
          message: `Surveillance déclenchée sur l'onglet ${String(event.tabId ?? "?")} : ${String(event.cond ?? "").slice(0, 120)}`,
          watchId: event.id,
          tabId: event.tabId,
        },
      };
    case "watch_paused":
      if (event.agent !== agent) return null;
      return {
        level: "warning",
        data: { kind: "watch_paused", message: `Surveillance ${String(event.id ?? "")} mise en pause après des erreurs répétées.`, watchId: event.id },
      };
    case "extension_disconnected":
      return { level: "warning", data: { kind: "extension_disconnected", message: "Le navigateur n'est plus connecté à Agent Browser Control : les actions échoueront jusqu'à la reconnexion." } };
    case "extension_connected":
      return { level: "info", data: { kind: "extension_connected", message: "Le navigateur est de nouveau connecté à Agent Browser Control." } };
    default:
      return null;
  }
}
