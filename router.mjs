// Smart prompt routing: decide whether a prompt goes to the local model or to Claude Code.
// Clear-cut cases are decided by rules (instant); the rest by asking the fast local model to classify.
import fs from "node:fs";
import path from "node:path";
import { OLLAMA_URL, DEFAULT_MODEL, cancelSignal, loadLog, defaultSub } from "./lib.mjs";
import { loadConfig } from "./config.mjs";

const CLASSIFIER_PROMPT = `You route a user's request to one of two assistants. Reply with JSON only.

"local": a small local model (about 14B parameters) with NO access to the user's files, tools or the internet.
Good for: explaining a concept or error message, a small self-contained function or snippet, regex, SQL,
converting or reformatting text, short summaries, quick factual coding questions, boilerplate.

"claude": Claude Code, a strong coding agent that can read and edit the project's files and run commands.
Needed for: anything that requires looking at or changing files in the project, multi-step or multi-file work,
debugging real code, running tests or builds, reviewing a codebase, architecture or design decisions,
long or ambiguous requests, or anything where a wrong answer would be costly.

If unsure, choose "claude".

Format: {"route": "local" or "claude", "reason": "<at most 12 words>", "effort": "low" or "medium"}
Decide "route" first, on the rules above. "effort" only matters for "claude": "low" for a quick lookup, a short
explanation or a simple question about one file; "medium" for several steps, real debugging or careful reasoning.`;

// Words that almost always mean "work on my project".
const CLAUDE_HINTS = [
  /\b(refactor|migrate|implement|integrate)\b/i,
  /\b(this|my|our|the) (repo|repository|codebase|project|app|code ?base)\b/i,
  /\b(run|fix|make) (the )?(tests?|build|lint(er)?|ci)\b/i,
  /\b(across|in) (all|every|multiple) files\b/i,
  /\b(commit|pull request|\bpr\b|git (diff|log|history))\b/i,
  /\b(review|audit) (my|the|this) (code|changes|pr)\b/i,
  /\b(edit|update|change|modify|create|delete) (the |my )?(file|files|folder|directory)\b/i,
  /\b(carry out|apply|execute|follow|implement) (the|this|that|your) plan\b|\bmake (the|these|those) changes\b/i,
];

// "Go ahead", "do it", "yes": on its own the classifier sees a trivial message and keeps it local, which can't
// edit anything. Right after a plan it means "implement that plan", so it goes to Claude.
const GO_AHEAD = /^\W*(ok(ay)?|yes|yep|yeah|sure|great|good|perfect|sounds good|looks good|lgtm|please)?\W*(go ahead|go for it|do it|do that|proceed|continue|start|implement( it| this| that)?|apply( it| this| that)?|build( it)?|make (it|the changes)|yes|ok(ay)?|yep|sure|lgtm|sounds good|looks good)\b/i;

function followsPlan(prompt, dir, sub) {
  if (!dir || prompt.length > 300 || !GO_AHEAD.test(prompt)) return false;
  const last = loadLog(dir, sub).messages.findLast((m) => m.from !== "human");
  return last?.mode === "plan";
}

// A token that names a file or folder that exists in the project means Claude needs to look at it.
function mentionsProjectFile(prompt, dir) {
  const tokens = prompt.match(/[\w.\-\/\\]+\.[A-Za-z0-9]{1,8}\b|[\w.\-]+[\/\\][\w.\-\/\\]+/g) || [];
  for (const t of tokens.slice(0, 40)) {
    const clean = t.replace(/^[.\/\\]+(?=\w)/, "").replace(/[.,;:]+$/, "");
    if (!clean || clean.length > 200) continue;
    try {
      if (fs.existsSync(path.join(dir, clean))) return clean;
    } catch {}
  }
  return null;
}

// Names like app.js or src/utils.py. The local model can't open files, so asking about one needs Claude,
// even when it isn't in this folder. Code pasted in a fenced block is ignored.
const FILE_RE = /\b[\w\-\/\\.]*\w\.(m?[jt]sx?|cjs|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|php|swift|vue|svelte|html?|css|scss|json|ya?ml|toml|md|sql|sh|ps1|cmd|bat|ini|env|lock|xml|gradle|csproj|sln)\b/i;

// Smart never picks an effort above medium.
const clampEffort = (e) => (e === "low" ? "low" : "medium");

function byRules(prompt, dir, sub) {
  // Pasted code (a fenced block, and a "name.js:" label right above it, as the web UI adds for dropped files)
  // is already in the prompt, so it doesn't count as asking about a file.
  const outsideCode = prompt.replace(/(^|\n)[^\n`]*:[ \t]*\n```[\s\S]*?```/g, "\n").replace(/```[\s\S]*?```/g, "");
  const file = dir && mentionsProjectFile(outsideCode, dir);
  // A short question about one file is a lookup; anything longer gets medium effort.
  const heavy = /\b(fix|debug|bugs?|crash\w*|broken|fail\w*|error|optimi[sz]e|why (does|is|do))\b/i.test(prompt);
  const quick = prompt.length < 160 && !heavy && !CLAUDE_HINTS.some((re) => re.test(prompt)) ? "low" : "medium";
  if (file) return { route: "claude", effort: quick, reason: `mentions ${file} in this project` };
  if (followsPlan(prompt, dir, sub)) return { route: "claude", effort: "medium", reason: "goes ahead with the plan above" };
  // Capitalised framework names (Node.js, Vue.js, Next.js) aren't files.
  const named = [...outsideCode.matchAll(new RegExp(FILE_RE.source, "gi"))].map((m) => m[0]).find((n) => !/^[A-Z][a-z]+\.js$/.test(n));
  if (named) return { route: "claude", effort: quick, reason: `asks about ${named}, which the local model can't open` };
  if (prompt.length > 2500) return { route: "claude", effort: "medium", reason: "long, detailed request" };
  const hint = CLAUDE_HINTS.find((re) => re.test(prompt));
  if (hint) return { route: "claude", effort: "medium", reason: "needs work on the project itself" };
  return null;
}

async function byModel(prompt, model) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: cancelSignal(60000),
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      think: false,
      options: { temperature: 0, num_predict: 100 },
      messages: [
        { role: "system", content: CLASSIFIER_PROMPT },
        { role: "user", content: `Request to route:\n"""\n${prompt.slice(0, 4000)}\n"""` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const out = JSON.parse((await res.json()).message?.content || "{}");
  if (out.route !== "local" && out.route !== "claude") throw new Error("classifier gave no route");
  return {
    route: out.route,
    effort: clampEffort(out.effort),
    reason: String(out.reason || "").slice(0, 120) || (out.route === "local" ? "simple, self-contained" : "needs Claude"),
  };
}

const DIFFICULTY_PROMPT = `You rate how hard a coding request is for an AI coding agent. Reply with JSON only.

"easy": a quick lookup, a short explanation, a question about one file, a rename, a typo, a small obvious edit.
"medium": ordinary coding work: a feature or bug fix in one or a few files, debugging with a clear error message,
writing tests, a moderate refactor.
"hard": architecture or design decisions, large multi-file refactors or migrations, subtle bugs (concurrency,
security, performance, a vague symptom with no clear cause), tricky algorithms, or anything where a wrong answer
would be costly.

If torn between two, choose the harder one.`;

const DIFFICULTY_SCHEMA = {
  type: "object",
  properties: { difficulty: { type: "string", enum: ["easy", "medium", "hard"] } },
  required: ["difficulty"],
};

// Claude model per difficulty (config "smartModels"; empty or missing turns automatic model choice off).
function smartModels() {
  const m = loadConfig().smartModels;
  return m && typeof m === "object" ? m : {};
}

async function difficultyByModel(prompt, model) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: cancelSignal(60000),
    body: JSON.stringify({
      model,
      stream: false,
      format: DIFFICULTY_SCHEMA,
      think: false,
      options: { temperature: 0, num_predict: 30 },
      messages: [
        { role: "system", content: DIFFICULTY_PROMPT },
        { role: "user", content: `Request to rate:
"""
${prompt.slice(0, 4000)}
"""` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const d = JSON.parse((await res.json()).message?.content || "{}").difficulty;
  if (!["easy", "medium", "hard"].includes(d)) throw new Error("classifier gave no difficulty");
  return d;
}

// For prompts going to Claude: how hard it is, and the Claude model that difficulty maps to.
// Without the local model, the effort already picked stands in (low -> easy, otherwise medium).
async function withModel(r, prompt, model) {
  if (r.route !== "claude") return r;
  const models = smartModels();
  if (!Object.keys(models).length) return r;
  const difficulty = await difficultyByModel(prompt, model).catch(() => (r.effort === "low" ? "easy" : "medium"));
  const pick = typeof models[difficulty] === "string" ? models[difficulty] : "";
  return { ...r, difficulty, ...(pick ? { model: pick } : {}) };
}

// Returns { route: "local" | "claude", effort: "low" | "medium", reason, by: "rules" | "model" | "fallback" },
// plus for Claude { difficulty: "easy" | "medium" | "hard", model } when config "smartModels" maps difficulties.
export async function routePrompt(prompt, { dir, sub = defaultSub(), model = DEFAULT_MODEL } = {}) {
  const rule = byRules(prompt, dir, sub);
  if (rule) return withModel({ ...rule, by: "rules" }, prompt, model);
  let r;
  try {
    r = { ...(await byModel(prompt, model)), by: "model" };
  } catch {
    // Local model unavailable: short questions stay local, anything else goes to Claude.
    r = prompt.length < 400
      ? { route: "local", reason: "short question (classifier unavailable)", by: "fallback" }
      : { route: "claude", effort: "medium", reason: "classifier unavailable", by: "fallback" };
  }
  return withModel(r, prompt, model);
}
