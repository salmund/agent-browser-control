import {
  FallbackVisionProvider,
  MuseExecVisionProvider,
  OpenAIVisionProvider,
  solveCaptcha,
} from "autocaptcha";
import type { SolveEvent, SolverDriver, VisionProvider } from "autocaptcha";
import type { CallResult, ToolContent } from "./common.ts";

/** Appel d'un outil implémenté par l'extension, depuis le démon. */
export type ExtensionCall = (tool: string, args: Record<string, unknown>) => Promise<CallResult>;

export interface CaptchaSolveOptions {
  provider?: string;
  model?: string;
  effort?: string;
}

function textsOf(result: CallResult): string[] {
  return result.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text);
}

function imageOf(result: CallResult): ToolContent | null {
  return result.content.find((b) => b.type === "image") ?? null;
}

function buildVision(opts: CaptchaSolveOptions): VisionProvider {
  const openai = (): VisionProvider => new OpenAIVisionProvider({ model: opts.model });
  const muse = (): VisionProvider => new MuseExecVisionProvider({ effort: opts.effort });
  if (opts.provider === "muse") return muse();
  if (opts.provider === "openai") return openai();
  return new FallbackVisionProvider([openai(), muse()]);
}

function formatEvent(e: SolveEvent): string {
  switch (e.type) {
    case "detection":
      return `détection : ${e.detection.kind} (${e.detection.confidence}) [${e.detection.signals.join(", ")}]`;
    case "click":
      return `clic ${e.n} : jeton=${e.token ? "oui" : "non"} défi=${e.challenge}`;
    case "round":
      return `ronde ${e.n} : défi=${e.state}`;
    case "frame":
      return `cadre défi : ${e.rect.w}x${e.rect.h} en (${e.rect.x},${e.rect.y})`;
    case "capture":
      return `capture : ${e.kilobytes} ko`;
    case "vision":
      return `vision : ${e.answer.action} ${JSON.stringify(e.answer.action === "drag" ? e.answer.drag : e.answer.points)}`;
    case "action":
      return e.text;
  }
}

/**
 * Outil local captcha_solve : résout le captcha de l'onglet via autoCaptcha
 * (solveCaptcha), en pilotant les outils d'extension existants. Un échec de
 * résolution reste une réponse normale (pas isError) : le texte renvoie vers
 * ask_human. Ne lève que sur panne (extension, vision, pilote).
 */
export async function captchaSolve(
  tabId: number,
  call: ExtensionCall,
  opts: CaptchaSolveOptions = {},
): Promise<CallResult> {
  const driver: SolverDriver = {
    js: async (code) => textsOf(await call("javascript", { tabId, code })).join("\n"),
    find: async (query) => textsOf(await call("find", { tabId, query })).join("\n"),
    clickRef: async (ref) => {
      await call("computer", { tabId, action: "left_click", ref });
    },
    clickAt: async (x, y) => {
      await call("computer", { tabId, action: "left_click", coordinate: [x, y] });
    },
    drag: async (from, to) => {
      await call("computer", {
        tabId,
        action: "left_click_drag",
        start_coordinate: [from.x, from.y],
        coordinate: [to.x, to.y],
      });
    },
    shotRegion: async (rect) => {
      const shot = await call("computer", {
        tabId,
        action: "screenshot",
        region: [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h],
      });
      const img = imageOf(shot);
      return img && img.type === "image" ? `data:${img.mimeType};base64,${img.data}` : null;
    },
  };
  const lines: string[] = [];
  const report = await solveCaptcha({
    driver,
    vision: buildVision(opts),
    events: (e) => {
      lines.push(formatEvent(e));
    },
  });
  const journal = lines.length ? `\n${lines.join("\n")}` : "";
  if (report.outcome === "solved") {
    return {
      content: [{
        type: "text",
        text: `Captcha résolu (${report.detection.kind}) : jeton présent (${report.widgets} widget(s)).${journal}`,
      }],
    };
  }
  return {
    content: [{
      type: "text",
      text: `Captcha NON résolu (${report.detection.kind}) : ${report.error}. ` +
        `Passe la main à l'utilisateur avec ask_human.${journal}`,
    }],
  };
}
