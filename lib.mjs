// Shared helpers for the Ollama bridge: per-project conversation log + Ollama chat call.
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { HERE, loadConfig } from "./config.mjs";

// Stop button: the UI server runs each chat/Claude request inside withCancel(), and every Ollama fetch and Claude
// run picks the signal up here, so it needn't be passed through the planner, context and review code.
const cancelStore = new AsyncLocalStorage();
export const withCancel = (signal, fn) => cancelStore.run(signal, fn);
// The current request's signal, combined with a timeout if given (no AbortSignal.any before Node 20).
export function cancelSignal(timeoutMs) {
  const stop = cancelStore.getStore();
  const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : null;
  if (!stop || !timeout) return stop || timeout || undefined;
  const ac = new AbortController();
  for (const s of [stop, timeout]) {
    if (s.aborted) ac.abort(s.reason);
    else s.addEventListener("abort", () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

// Environment variables override config.json.
const config = loadConfig();
export const OLLAMA_URL = process.env.OLLAMA_HOST_URL || config.ollamaUrl;
export const DEFAULT_MODEL = process.env.OLLAMA_BRIDGE_MODEL || config.bridgeModel;
export const REASONING_MODEL = process.env.OLLAMA_BRIDGE_REASONING_MODEL || config.reasoningModel;
export const NUM_CTX = Number(process.env.OLLAMA_BRIDGE_NUM_CTX || config.bridgeNumCtx);
// Rough budget for history sent to the model (~4 chars per token, leave room for the reply).
const MAX_HISTORY_CHARS = Number(process.env.OLLAMA_BRIDGE_MAX_CHARS || 80000);

const SYSTEM_PROMPT = `You are a local AI assistant running on the user's machine through Ollama.
You collaborate with Claude (an AI coding agent) and the human user. You all share this one conversation log.
Messages starting with [Claude] come from Claude; messages starting with [Human] come from the human.
Claude often hands you smaller, well-defined tasks (writing a function, summarising text, drafting tests, explaining code).
Answer directly and concisely. When asked for code, return complete, working code in fenced blocks.`;

// Plan mode: think the task through and return a plan instead of doing it, like Claude Code's plan mode.
const PLAN_PROMPT = `

You are in plan mode: don't write the implementation, and don't mention plan mode. Reply with a plan using these headings:
1. **Goal**: one or two sentences on what done looks like.
2. **Questions / assumptions**: anything unclear, and what you'll assume if nobody answers.
3. **Steps**: a numbered list. For each step name the files, functions or commands involved and what changes.
4. **Risks**: what could break or is easy to get wrong.
5. **How to verify**: tests or checks that prove it works.
Keep it concise. Short code snippets only where a signature or data shape needs pinning down.`;

export function projectDir() {
  return path.resolve(process.env.OLLAMA_BRIDGE_PROJECT || process.cwd());
}

// Sub-sessions: a project can hold several separate conversations, each with its own log and its own resumed
// Claude session. "sub" is the sub-session id; "" (or "main") is the project's original log.
const SUB_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export function subId(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v || v === "main") return "";
  if (!SUB_RE.test(v)) throw new Error(`Invalid session name: ${value} (use a-z, 0-9 and -, up to 40 characters)`);
  return v;
}

// The sub-session from OLLAMA_BRIDGE_SESSION (set by --sub and by terminals opened for a sub-session).
export function defaultSub() {
  return subId(process.env.OLLAMA_BRIDGE_SESSION);
}

const logKey = (dir) => dir.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(-120) || "root";

// Folder of a project's sub-session logs. listProjects() only reads the top level of logs/, so these never show up as projects.
export function sessionsDir(dir = projectDir()) {
  return path.join(HERE, "logs", "sessions", logKey(dir));
}

export function logPath(dir = projectDir(), sub = defaultSub()) {
  sub = subId(sub);
  return sub ? path.join(sessionsDir(dir), `${sub}.json`) : path.join(HERE, "logs", `${logKey(dir)}.json`);
}

export function loadLog(dir = projectDir(), sub = defaultSub()) {
  try {
    return JSON.parse(fs.readFileSync(logPath(dir, sub), "utf8"));
  } catch {
    return { project: dir, messages: [] };
  }
}

export function saveLog(log, dir = projectDir(), sub = defaultSub()) {
  const file = logPath(dir, sub);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(log, null, 2));
}

// Empty a conversation, keeping a sub-session's name.
export function clearLog(dir = projectDir(), sub = defaultSub()) {
  const { name, created } = loadLog(dir, sub);
  saveLog({ project: dir, ...(name ? { name, created } : {}), messages: [] }, dir, sub);
}

// Token totals from a log's replies: { local: { replies, in, out }, claude: { replies, in, out, cost } }.
// Claude's input counts cache reads/writes too, as that's what each resumed message re-reads.
export function sessionUsage(messages) {
  const u = { local: { replies: 0, in: 0, out: 0 }, claude: { replies: 0, in: 0, out: 0, cost: 0 } };
  for (const m of messages) {
    const t = m.from === "local" ? u.local : m.from === "claude" ? u.claude : null;
    if (!t || !m.usage) continue;
    t.replies++;
    t.in += (m.usage.in || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
    t.out += m.usage.out || 0;
    if (t === u.claude) u.claude.cost += m.usage.costUsd || 0;
  }
  return u;
}

// Main plus every named sub-session: [{ id, name, messages, updated, created, usage }], main first, then oldest first.
export function listSessions(dir = projectDir()) {
  const main = loadLog(dir, "");
  const out = [{ id: "", name: "Main", messages: main.messages.length, updated: main.messages.at(-1)?.ts || null, created: "", usage: sessionUsage(main.messages) }];
  let files = [];
  try {
    files = fs.readdirSync(sessionsDir(dir)).filter((f) => f.endsWith(".json") && SUB_RE.test(f.slice(0, -5)));
  } catch {}
  const named = files.map((f) => {
    const id = f.slice(0, -5);
    const log = loadLog(dir, id);
    return { id, name: log.name || id, messages: log.messages.length, updated: log.messages.at(-1)?.ts || null, created: log.created || "", usage: sessionUsage(log.messages) };
  });
  named.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
  return [...out, ...named];
}

export function sessionCount(dir) {
  try {
    return fs.readdirSync(sessionsDir(dir)).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

const cleanName = (name) => String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

// New sub-session named `name`; its id is a slug of the name, made unique. Returns the id.
export function createSession(dir, name) {
  name = cleanName(name);
  if (!name) throw new Error("Give the session a name");
  let base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/-+$/, "");
  if (!base || base === "main") base = "session";
  let id = base;
  for (let n = 2; fs.existsSync(logPath(dir, id)); n++) id = `${base}-${n}`;
  saveLog({ project: dir, name, created: new Date().toISOString(), messages: [] }, dir, id);
  return id;
}

export function renameSession(dir, sub, name) {
  sub = subId(sub);
  name = cleanName(name);
  if (!sub) throw new Error("The main conversation can't be renamed");
  if (!name) throw new Error("Give the session a name");
  if (!fs.existsSync(logPath(dir, sub))) throw new Error(`No session called ${sub}`);
  const log = loadLog(dir, sub);
  log.name = name;
  saveLog(log, dir, sub);
}

export function deleteSession(dir, sub) {
  sub = subId(sub);
  if (!sub) throw new Error("The main conversation can't be deleted; clear it instead");
  fs.rmSync(logPath(dir, sub), { force: true });
}


// Convert the shared log into Ollama chat messages, newest last, trimmed to the char budget.
function toOllamaMessages(entries, maxChars = MAX_HISTORY_CHARS) {
  const out = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    // Claude's replies carry the files it changed, so local models know what was actually done.
    const changed = e.changes?.length ? `\n(Files changed: ${e.changes.map((c) => `${c.file} +${c.added} -${c.removed}`).join(", ")})` : "";
    const content = e.from === "local" ? e.content : `[${e.from === "claude" ? "Claude" : "Human"}] ${e.content}${changed}`;
    total += content.length;
    if (total > maxChars && out.length > 0) break;
    out.unshift({ role: e.from === "local" ? "assistant" : "user", content });
  }
  return out;
}

// Every project that has a shared log, most recently active first.
export function listProjects() {
  const logs = path.join(HERE, "logs");
  if (!fs.existsSync(logs)) return [];
  return fs
    .readdirSync(logs)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const log = JSON.parse(fs.readFileSync(path.join(logs, f), "utf8"));
        const last = log.messages.at(-1);
        return { project: log.project, messages: log.messages.length, updated: last?.ts || null };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

// meta: extra fields stored on the prompt's log entry (e.g. how the smart router chose this model).
// context: { text, sources } from context.mjs. The project code goes to the model with this prompt only; the log
// keeps just the list of files used, so the shared conversation (and what Claude is later sent) stays small.
export async function chat({ from, prompt, model = DEFAULT_MODEL, system, useHistory = true, plan = false, meta = {}, context = null, dir = projectDir(), sub = defaultSub() }) {
  const log = loadLog(dir, sub);
  const entry = {
    from,
    content: prompt,
    ts: new Date().toISOString(),
    ...(plan ? { mode: "plan" } : {}),
    ...(context?.sources?.length ? { context: context.sources } : {}),
    ...meta,
  };
  const history = useHistory ? [...log.messages, entry] : [entry];
  // Leave room in the model's context window for the attached code.
  const messages = toOllamaMessages(history, context?.text ? Math.min(MAX_HISTORY_CHARS, 24000) : MAX_HISTORY_CHARS);
  if (context?.text) messages[messages.length - 1].content = `${context.text}\n\n${messages[messages.length - 1].content}`;

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: cancelSignal(),
    body: JSON.stringify({
      model,
      stream: false,
      options: { num_ctx: Math.max(NUM_CTX, context?.text ? 32768 : 0) },
      messages: [{ role: "system", content: (system || SYSTEM_PROMPT) + (plan ? PLAN_PROMPT : "") }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Thinking models may inline their reasoning; keep only the answer.
  const reply = (data.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  // Re-read before saving: Claude, local-chat and the web UI may all have written while the model was thinking.
  // Token counts and time from Ollama, for the usage panel (total_duration is in nanoseconds).
  const usage = { in: data.prompt_eval_count || 0, out: data.eval_count || 0, ms: Math.round((data.total_duration || 0) / 1e6) };
  const fresh = loadLog(dir, sub);
  fresh.messages.push(entry, { from: "local", model, content: reply, ts: new Date().toISOString(), usage, ...(plan ? { mode: "plan" } : {}) });
  saveLog(fresh, dir, sub);
  return { reply, model, usage };
}

export async function listModels() {
  const res = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const data = await res.json();
  return data.models.map((m) => `${m.name}  (${(m.size / 1e9).toFixed(1)} GB)`);
}
