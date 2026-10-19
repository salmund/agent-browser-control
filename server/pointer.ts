/**
 * Souris réelle (réglage « Souris réelle » du panneau) : le démon déplace le vrai pointeur de la machine.
 *
 * Par CDP, le pointeur d'un agent saute sur le centre exact de sa cible, sans trajet : les protections anti-robot
 * (Turnstile, reCAPTCHA, DataDome…) jugent aussi la souris et le repèrent. Ici, le geste passe par le serveur X
 * (xdotool) : la page reçoit des événements natifs, le long d'un trajet de main (arc, vitesse en cloche, léger
 * dépassement des cibles lointaines). Le pointeur n'est plus à l'utilisateur pendant ce temps : réservé à une
 * machine dont l'écran sert aux agents (Orion), jamais au PC de tous les jours. Linux et X11 seulement.
 *
 * L'extension garde la main sur le geste : elle choisit le point (refs, garde anti-clic-dans-le-vide), vérifie que
 * la page a vu le pointeur arriver au bon endroit, et revient au geste CDP si la souris réelle est indisponible.
 */
import { spawn } from "node:child_process";

export interface Point {
  x: number;
  y: number;
}

/** Un point du trajet, atteint `wait` ms après le précédent. */
export interface PathStep extends Point {
  wait: number;
}

type Rand = () => number;

const BUTTONS: Record<string, number> = { left: 1, middle: 2, right: 3 };
const WHEEL = { up: 4, down: 5, left: 6, right: 7 };
const KEYS = new Set(["ctrl", "alt", "shift", "super"]);
const MAX_COORD = 20_000;

const bezier = (a: Point, b: Point, c: Point, d: Point, t: number): Point => {
  const u = 1 - t;
  return {
    x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
    y: u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y,
  };
};

/** Un trait de main de `a` à `b` : un arc (jamais une droite), départ et arrivée lents, durée selon la loi de Fitts. */
function stroke(a: Point, b: Point, rand: Rand): PathStep[] {
  const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const duration = (140 + 95 * Math.log2(1 + d / 24)) * between(0.85, 1.2);
  const n = Math.max(4, Math.min(90, Math.round(duration / between(11, 15))));
  const nx = -(b.y - a.y) / d;
  const ny = (b.x - a.x) / d;
  const bow = d * between(0.03, 0.11) * (rand() < 0.5 ? -1 : 1);
  const along = (k: number, side: number): Point => ({
    x: a.x + (b.x - a.x) * k + nx * side,
    y: a.y + (b.y - a.y) * k + ny * side,
  });
  const c1 = along(between(0.2, 0.4), bow);
  const c2 = along(between(0.6, 0.85), bow * between(0.3, 0.9));
  const steps: PathStep[] = [];
  let last = { x: Math.round(a.x), y: Math.round(a.y) };
  let wait = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const s = 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5; // profil « minimum jerk » : vitesse en cloche
    const p = bezier(a, c1, c2, b, s);
    const jitter = i < n ? 0.6 : 0;
    const x = i < n ? Math.round(p.x + (rand() - 0.5) * 2 * jitter) : Math.round(b.x);
    const y = i < n ? Math.round(p.y + (rand() - 0.5) * 2 * jitter) : Math.round(b.y);
    wait += (duration / n) * between(0.75, 1.25);
    if (x === last.x && y === last.y && i < n) continue; // même pixel : le temps passe, pas d'événement
    steps.push({ x, y, wait: Math.max(1, Math.round(wait)) });
    last = { x, y };
    wait = 0;
  }
  return steps;
}

/**
 * Trajet de main de `from` à `to`. Une cible lointaine est un peu dépassée, puis rattrapée par un petit
 * mouvement de correction, comme le fait une main. Toujours au moins un mouvement, même sur place : la page
 * doit voir le pointeur arriver.
 */
export function humanPath(from: Point, to: Point, rand: Rand = Math.random): PathStep[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 1) return [{ x: Math.round(to.x) + 1, y: Math.round(to.y), wait: 9 }, { x: Math.round(to.x), y: Math.round(to.y), wait: 13 }];
  if (dist <= 320) return stroke(from, to, rand);
  const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
  const ux = (to.x - from.x) / dist;
  const uy = (to.y - from.y) / dist;
  const past = between(3, 9);
  const side = between(-3, 3);
  const aim = { x: to.x + ux * past - uy * side, y: to.y + uy * past + ux * side };
  const main = stroke(from, aim, rand);
  const fix = stroke(main.length ? main.at(-1)! : aim, to, rand);
  if (fix.length) fix[0].wait += Math.round(between(40, 90)); // la main marque un temps avant de corriger
  return [...main, ...fix];
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

/** Lignes de script xdotool d'un trajet (lues sur l'entrée standard par `xdotool -`). */
export function moveLines(steps: PathStep[]): string[] {
  return steps.flatMap((s) => [`sleep ${seconds(s.wait)}`, `mousemove ${s.x} ${s.y}`]);
}

/** Lignes d'un clic (simple, double, triple) au point courant, touches de modification tenues. */
export function pressLines(button: string, count: number, keys: string[], rand: Rand = Math.random): string[] {
  const between = (lo: number, hi: number) => Math.round(lo + (hi - lo) * rand());
  const b = BUTTONS[button];
  const lines = [...keys.map((k) => `keydown ${k}`), `sleep ${seconds(between(60, 160))}`];
  for (let i = 0; i < count; i++) {
    if (i) lines.push(`sleep ${seconds(between(70, 130))}`);
    lines.push(`mousedown ${b}`, `sleep ${seconds(between(50, 110))}`, `mouseup ${b}`);
  }
  return [...lines, ...[...keys].reverse().map((k) => `keyup ${k}`)];
}

/** Lignes de crans de molette au point courant. */
export function wheelLines(direction: keyof typeof WHEEL, notches: number, rand: Rand = Math.random): string[] {
  const between = (lo: number, hi: number) => Math.round(lo + (hi - lo) * rand());
  const lines = [`sleep ${seconds(between(50, 120))}`];
  for (let i = 0; i < notches; i++) {
    if (i) lines.push(`sleep ${seconds(between(35, 90))}`);
    lines.push(`click ${WHEEL[direction]}`);
  }
  return lines;
}

/** Lignes d'un glisser : bouton enfoncé au point courant, le tracé point par point (~7 px), relâché au bout. */
export function dragLines(points: Point[], keys: string[], rand: Rand = Math.random): string[] {
  const between = (lo: number, hi: number) => Math.round(lo + (hi - lo) * rand());
  const lines = [...keys.map((k) => `keydown ${k}`), `sleep ${seconds(between(70, 140))}`, "mousedown 1", `sleep ${seconds(between(60, 120))}`];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    const n = Math.max(2, Math.min(150, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 7)));
    for (let i = 1; i <= n; i++) {
      lines.push(`sleep ${seconds(between(8, 16))}`, `mousemove ${Math.round(a.x + ((b.x - a.x) * i) / n)} ${Math.round(a.y + ((b.y - a.y) * i) / n)}`);
    }
  }
  lines.push(`sleep ${seconds(between(30, 70))}`, "mouseup 1", ...[...keys].reverse().map((k) => `keyup ${k}`));
  return lines;
}

/** Durée totale des pauses d'un script, en ms : sert au délai d'exécution. */
const scriptMs = (lines: string[]) => lines.reduce((t, l) => t + (l.startsWith("sleep ") ? Number(l.slice(6)) * 1000 : 0), 0);

// ---------------------------------------------------------------------------
// Validation des demandes de l'extension
// ---------------------------------------------------------------------------

function coord(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < -MAX_COORD || n > MAX_COORD) throw new Error(`${name} : coordonnée invalide.`);
  return Math.round(n);
}

function keysOf(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((k) => !KEYS.has(String(k)))) throw new Error("keys : ctrl, alt, shift ou super.");
  return [...new Set(v.map(String))];
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

export interface PointerOptions {
  /** Écran X à piloter (défaut : ABC_POINTER_DISPLAY, puis DISPLAY, puis :0). */
  display?: string;
  log?: (entry: Record<string, unknown>) => void;
}

export function createPointer(opts: PointerOptions = {}) {
  const display = opts.display ?? process.env.ABC_POINTER_DISPLAY ?? process.env.DISPLAY ?? ":0";
  let queue: Promise<unknown> = Promise.resolve(); // un seul pointeur : un geste à la fois

  function xdotool(lines: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("xdotool", ["-"], { env: { ...process.env, DISPLAY: display }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), scriptMs(lines) + 5000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new Error(e.code === "ENOENT" ? "xdotool absent (sudo apt install xdotool)." : e.message));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(err.trim().split("\n")[0] || `xdotool : code ${code}.`));
      });
      child.stdin.end(lines.join("\n") + "\n");
    });
  }

  async function location(): Promise<Point> {
    const out = await xdotool(["getmouselocation --shell"]);
    const x = Number(/X=(\d+)/.exec(out)?.[1]);
    const y = Number(/Y=(\d+)/.exec(out)?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Position du pointeur illisible.");
    return { x, y };
  }

  async function status(): Promise<{ ok: boolean; why?: string }> {
    if (process.platform !== "linux") return { ok: false, why: "la souris réelle ne fonctionne que sous Linux (X11)." };
    try {
      await location();
      return { ok: true };
    } catch (err) {
      return { ok: false, why: `écran ${display} injoignable : ${(err as Error).message}` };
    }
  }

  async function perform(p: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (p.action) {
      case "status":
        return status();
      case "move": {
        const to = { x: coord(p.x, "x"), y: coord(p.y, "y") };
        const from = await location();
        await xdotool(moveLines(humanPath(from, to)));
        return { from, to };
      }
      case "press": {
        const button = String(p.button ?? "left");
        if (!(button in BUTTONS)) throw new Error("button : left, middle ou right.");
        const count = Math.max(1, Math.min(3, Math.round(Number(p.count ?? 1)) || 1));
        await xdotool(pressLines(button, count, keysOf(p.keys)));
        return { button, count };
      }
      case "wheel": {
        const direction = String(p.direction ?? "down");
        if (!(direction in WHEEL)) throw new Error("direction : up, down, left ou right.");
        const notches = Math.max(1, Math.min(50, Math.round(Number(p.notches ?? 3)) || 1));
        await xdotool(wheelLines(direction as keyof typeof WHEEL, notches));
        return { direction, notches };
      }
      case "drag": {
        if (!Array.isArray(p.points) || p.points.length < 2 || p.points.length > 2000) throw new Error("points : de 2 à 2000 points [x, y].");
        const points = p.points.map((q: unknown, i: number) => {
          const [x, y] = Array.isArray(q) ? q : [];
          return { x: coord(x, `points[${i}]`), y: coord(y, `points[${i}]`) };
        });
        await xdotool(dragLines(points, keysOf(p.keys)));
        return { points: points.length };
      }
      default:
        throw new Error(`action inconnue : ${String(p.action ?? "(vide)")}.`);
    }
  }

  return {
    status,
    /** Exécute une demande de l'extension ; les gestes passent un par un. */
    run(params: Record<string, unknown>): Promise<Record<string, unknown>> {
      const job = queue.then(() => perform(params));
      queue = job.catch(() => {});
      job.then(
        () => params.action !== "status" && opts.log?.({ event: "pointer", action: params.action, ok: true }),
        (err) => opts.log?.({ event: "pointer", action: params.action, ok: false, error: String(err?.message ?? err) }),
      );
      return job;
    },
  };
}
