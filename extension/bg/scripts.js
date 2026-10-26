// Agent Browser Control, service worker : browser_script.
// Script classique chargé par background.js (importScripts) : portée globale partagée.

// ---------------------------------------------------------------------------
// browser_script : un programme de l'agent, exécuté d'un seul tenant dans la sandbox
// ---------------------------------------------------------------------------

const SCRIPT_DEFAULT_MS = 120_000;
const SCRIPT_MAX_MS = 280_000; // sous le délai HTTP du shim MCP (300 s)
const scriptRuns = new Map(); // runId -> { agent, actor, kill }
const scriptTraces = new Map(); // runId -> trace des appels (reprise après échec, 5 dernières)
let scriptCounter = 0;

async function browserScript(agent, { code, tabId, timeoutMs, resume, args, label, skill, builtin }) {
  // Fonctions intégrées d'ABC (search, read_urls) : code livré avec ABC, pas écrit par un agent. Le démon retire
  // skill et builtin des appels directs d'un agent : seul lui peut les poser.
  if (!(builtin === true && skill) && !(await scriptsEnabled())) {
    return fail(
      "browser_script est désactivé par l'utilisateur (panneau de l'extension). Ne pas réessayer : " +
      "agir pas à pas avec les autres outils, ou lui demander de l'activer s'il le souhaite.",
    );
  }
  if (typeof code !== "string" || !code.trim()) throw new Error("'code' requis.");
  if (tabId !== undefined) await assertOwned(agent, tabId);
  // Reprise : les appels déjà réussis rejouent la trace gardée (pas de double effet).
  let replay = null;
  if (resume) {
    const from = Math.max(0, Number(resume.from) || 0);
    const trace = scriptTraces.get(resume.trace)?.trace;
    if (!trace) throw new Error(`Trace ${JSON.stringify(resume.trace)} expirée ou inconnue (extension rechargée, trace trop ancienne) : relancer sans resume.`);
    if (from < 1 || from > trace.length + 1) throw new Error(`'from' doit être le premier appel à exécuter (1 à ${trace.length + 1}, trace : ${resume.trace}).`);
    replay = { trace, from: from - 1 };
  }
  await ensureOffscreen();
  // Id imprévisible : la trace de reprise en dérive, et un script ne peut pas deviner celui d'un autre.
  const runId = `script_${++scriptCounter}_${crypto.randomUUID().slice(0, 8)}`;
  const limit = Math.min(Math.max(timeoutMs ?? SCRIPT_DEFAULT_MS, 1000), SCRIPT_MAX_MS);
  const actor = tabId !== undefined ? await actorOf(agent, "browser_script", { tabId }).catch(() => agent) : agent;
  let kill;
  const killed = new Promise((resolve) => (kill = (error) => resolve({ error, logs: [], images: [], calls: null })));
  scriptRuns.set(runId, { agent, actor, kill });
  const started = Date.now();
  let timer;
  try {
    const scriptArgs = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const tag = typeof label === "string" && label.trim() ? label.trim().slice(0, 40) : undefined;
    const done = chrome.runtime.sendMessage({ target: "offscreen", type: "run-script", runId, code, tabId, replay, args: scriptArgs, label: tag });
    const timeout = new Promise((resolve) => {
      timer = setTimeout(async () => {
        chrome.runtime.sendMessage({ target: "offscreen", type: "abort-script", runId }).catch(() => {});
        // Le script avorté renvoie sa trace (5 s max) : la reprise reste possible après un timeout.
        const late = await Promise.race([done.catch(() => null), sleep(5000).then(() => null)]).catch(() => null);
        if (late && Array.isArray(late.trace) && late.trace.length) {
          resolve({ ...late, error: `Délai dépassé (${limit / 1000} s) : script interrompu.` });
        } else {
          // Aucune réponse 5 s après l'interruption : le script boucle sans rendre la main.
          if (!late) resetOffscreen().catch(() => {});
          resolve({ error: `Délai dépassé (${limit / 1000} s) : script interrompu.`, logs: [], images: [], calls: null });
        }
      }, limit);
    });
    const res = (await Promise.race([done, timeout, killed])) ?? { error: "Le document des scripts s'est fermé pendant l'exécution.", logs: [], images: [], calls: null };
    const seconds = ((Date.now() - started) / 1000).toFixed(1).replace(".", ",");
    const replayed = replay ? replay.from : 0;
    const lines = [`Script ${res.error ? "en échec" : "terminé"} en ${seconds} s${res.calls != null ? `, ${res.calls} appel(s) d'outils` : ""}${replayed ? ` (${replayed} rejoué(s))` : ""}.`];
    if (res.logs?.length) lines.push("", "Journal (log) :", ...res.logs);
    if (res.error) {
      lines.push("", `Erreur : ${res.error}`);
      // Point de reprise : la trace reste côté extension (lourde), l'agent ne reçoit que l'id.
      // Échec d'un appel (must) : on rejoue depuis cet appel ; échec côté script : depuis la suite.
      const failedTool = typeof res.failedToolCall === "number" && res.failedToolCall >= 1 ? res.failedToolCall : null;
      const doneCalls = typeof res.failedAt === "number" ? res.failedAt : 0;
      const from = failedTool ?? doneCalls + 1;
      if (Array.isArray(res.trace) && from >= 1 && from <= res.trace.length + 1) {
        scriptTraces.set(runId, { trace: res.trace, at: Date.now() });
        while (scriptTraces.size > 5) scriptTraces.delete(scriptTraces.keys().next().value);
        lines.push("", failedTool
          ? `Échec à l'appel d'outil n°${failedTool} (${res.trace[failedTool - 1]?.tool ?? "?"}) sur ${res.trace.length} enregistré(s).`
          : `Échec côté script après ${doneCalls} appel(s) d'outil(s) enregistré(s).`);
        if (!res.traceComplete) lines.push("Trace incomplète (plus de 200 appels) : reprise impossible, découper le script.");
        else {
          if (res.trace.some((t) => t.truncated)) lines.push("Attention : certains résultats rejoués sont tronqués (20 000 car.).");
          lines.push(`Reprise : renvoyer le code (corrigé, mêmes premiers appels) avec resume: { trace: "${runId}", from: ${from} }.`);
        }
      }
    } else lines.push("", "Valeur renvoyée :", res.value === null ? "(aucune)" : JSON.stringify(res.value, null, 2));
    if (res.error && Array.isArray(res.openTabs) && res.openTabs.length) {
      lines.push("", `Onglet(s) ouvert(s) par open() laissé(s) pour inspection : ${res.openTabs.map((id) => `tabId ${id}`).join(", ")}.`);
    }
    let body = lines.join("\n");
    if (body.length > 60_000) body = `${body.slice(0, 60_000)}\n[Tronqué]`;
    const out = [text(untrusted(body)), ...(res.images ?? [])];
    // Fonction d'ABC (skill, search, read_urls) : le démon met lui-même en forme la valeur brute.
    const raw = skill ? { _script: { value: res.value ?? null, error: res.error ?? null, logs: res.logs ?? [], calls: res.calls, ms: Date.now() - started, body } } : {};
    return res.error ? { content: out, isError: true, ...raw } : { content: out, ...raw };
  } finally {
    clearTimeout(timer);
    scriptRuns.delete(runId);
  }
}
