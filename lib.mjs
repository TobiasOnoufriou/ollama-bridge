// Shared helpers for the Ollama bridge: per-project conversation log + Ollama chat call.
import fs from "node:fs";
import path from "node:path";
import { HERE, loadConfig } from "./config.mjs";

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

export function logPath(dir = projectDir()) {
  const key = dir.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(-120) || "root";
  return path.join(HERE, "logs", `${key}.json`);
}

export function loadLog(dir = projectDir()) {
  try {
    return JSON.parse(fs.readFileSync(logPath(dir), "utf8"));
  } catch {
    return { project: dir, messages: [] };
  }
}

export function saveLog(log, dir = projectDir()) {
  const file = logPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(log, null, 2));
}

// Append entries to a project's log, re-reading it first so concurrent writers don't drop messages.
export function appendMessages(dir, ...entries) {
  const log = loadLog(dir);
  log.messages.push(...entries);
  saveLog(log, dir);
}

// Convert the shared log into Ollama chat messages, newest last, trimmed to the char budget.
function toOllamaMessages(entries) {
  const out = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const content = e.from === "local" ? e.content : `[${e.from === "claude" ? "Claude" : "Human"}] ${e.content}`;
    total += content.length;
    if (total > MAX_HISTORY_CHARS && out.length > 0) break;
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
export async function chat({ from, prompt, model = DEFAULT_MODEL, system, useHistory = true, plan = false, meta = {}, dir = projectDir() }) {
  const log = loadLog(dir);
  const entry = { from, content: prompt, ts: new Date().toISOString(), ...(plan ? { mode: "plan" } : {}), ...meta };
  const history = useHistory ? [...log.messages, entry] : [entry];

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      options: { num_ctx: NUM_CTX },
      messages: [{ role: "system", content: (system || SYSTEM_PROMPT) + (plan ? PLAN_PROMPT : "") }, ...toOllamaMessages(history)],
    }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Thinking models may inline their reasoning; keep only the answer.
  const reply = (data.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  // Re-read before saving: Claude, local-chat and the web UI may all have written while the model was thinking.
  const fresh = loadLog(dir);
  fresh.messages.push(entry, { from: "local", model, content: reply, ts: new Date().toISOString(), ...(plan ? { mode: "plan" } : {}) });
  saveLog(fresh, dir);
  return { reply, model };
}

export async function listModels() {
  const res = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const data = await res.json();
  return data.models.map((m) => `${m.name}  (${(m.size / 1e9).toFixed(1)} GB)`);
}
