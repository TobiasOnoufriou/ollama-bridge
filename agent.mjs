// local_task: a small tool-using agent on a local model. Claude hands over a well-scoped coding task; the local
// model lists, searches, reads and edits files in the project itself (Ollama tool calling), and Claude gets back
// only a short summary and a diffstat, so the code never passes through Claude's context.
// Every path is checked in code: inside the project, not in .git / node_modules / ignored folders, never .env.
// No shell access. Steps, time and tool output are capped, and old tool output is cut as the conversation grows.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { OLLAMA_URL, cancelSignal, projectDir, defaultSub, loadLog, saveLog } from "./lib.mjs";
import { listFiles, readText } from "./context.mjs";
import { diffOf, syntaxErrors } from "./review.mjs";

const config = loadConfig();
export const AGENT_MODEL = process.env.OLLAMA_BRIDGE_AGENT_MODEL || config.agentModel || config.claudeLocalModel;
const AGENT_CTX = Number(process.env.OLLAMA_BRIDGE_AGENT_CTX || config.agentNumCtx || 32768);
const MAX_STEPS = Number(config.agentMaxSteps || 30);
const TIME_LIMIT_MS = 15 * 60_000;
const READ_LINES = 400; // per read_file call
const RESULT_CHARS = 12_000; // per tool result
const HISTORY_CHARS = Math.floor(AGENT_CTX * 2.5); // ~4 chars/token, leaving room for the reply
const GREP_MATCHES = 60;

const SYSTEM = `You are a coding agent working directly in a project on the user's machine. Claude (another AI) gave you
a task. Do it yourself with the tools; nobody else will apply your changes.

How to work:
- Explore first: grep or list_files to find the code, then read_file the parts you need. Don't guess file contents.
- Read a file (at least the region) before editing it. Use edit_file for changes: old_string must match the file
  exactly, including indentation, and be unique (add surrounding lines if needed). write_file only for new files.
- Keep changes minimal and match the surrounding code style. Don't touch unrelated code or reformat.
- After editing, re-read the changed region if unsure it's right.
- When done (or stuck), stop calling tools and reply with a short plain-text summary: what you changed, in which
  files, and anything you couldn't do or aren't sure about. No code blocks in the summary.`;

const fn = (name, description, properties, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});
const str = (description) => ({ type: "string", description });
const TOOLS = [
  fn("list_files", "List project files (relative paths), optionally only under a folder or containing some text.", {
    folder: str("Folder to list, relative to the project root (default: whole project)"),
    contains: str("Only paths containing this text"),
  }),
  fn("grep", "Search project files with a regular expression. Returns path:line: text for each match.", {
    pattern: str("JavaScript regular expression"),
    folder: str("Limit to this folder"),
    ignore_case: { type: "boolean" },
  }, ["pattern"]),
  fn("read_file", `Read a file with line numbers, up to ${READ_LINES} lines per call.`, {
    path: str("File path relative to the project root"),
    start_line: { type: "number", description: "First line (1-based, default 1)" },
    end_line: { type: "number", description: "Last line" },
  }, ["path"]),
  fn("edit_file", "Replace an exact, unique piece of text in a file.", {
    path: str("File path relative to the project root"),
    old_string: str("Exact existing text, including indentation (no line numbers)"),
    new_string: str("Replacement text"),
    replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match" },
  }, ["path", "old_string", "new_string"]),
  fn("write_file", "Create a new file (or fully replace a small one) with the given content.", {
    path: str("File path relative to the project root"),
    content: str("Full file content"),
  }, ["path", "content"]),
];

const BLOCKED_DIRS = new Set([".git", "node_modules", ".hg", ".svn", ".venv", "venv", "__pycache__"]);

// Resolve a model-supplied path inside the project, or throw. Follows symlinks so a link can't point outside.
export function safePath(dir, rel) {
  if (typeof rel !== "string" || !rel.trim()) throw new Error("path is required");
  const abs = path.resolve(dir, rel.trim());
  const inside = (p) => {
    const r = path.relative(dir, p);
    return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
  };
  if (!inside(abs)) throw new Error(`${rel} is outside the project`);
  let real = abs;
  for (let p = abs; ; p = path.dirname(p)) {
    if (fs.existsSync(p)) {
      real = path.join(fs.realpathSync(p), path.relative(p, abs));
      break;
    }
    if (p === path.dirname(p)) break;
  }
  if (!inside(real)) throw new Error(`${rel} is outside the project`);
  const parts = path.relative(dir, abs).split(path.sep);
  if (parts.some((s) => BLOCKED_DIRS.has(s))) throw new Error(`${rel} is in a folder the agent can't touch`);
  if (/^\.env/i.test(parts.at(-1))) throw new Error(".env files are off limits");
  return abs;
}

const toPosix = (p) => p.split(path.sep).join("/");
const relOf = (dir, abs) => toPosix(path.relative(dir, abs));
const clip = (s, n = RESULT_CHARS) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters cut; narrow the request)` : s);

function makeTools(dir) {
  const originals = new Map(); // rel -> content before the agent first touched it ("" for new files)
  let fileList = null;
  const files = () => (fileList ??= listFiles(dir));
  const remember = (abs) => {
    const rel = relOf(dir, abs);
    if (!originals.has(rel)) originals.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null);
  };
  const underFolder = (folder) => {
    if (!folder) return () => true;
    const f = relOf(dir, safePath(dir, folder)).replace(/\/$/, "");
    return (rel) => f === "" || rel === f || rel.startsWith(`${f}/`);
  };

  const impl = {
    list_files({ folder, contains }) {
      const keep = underFolder(folder);
      const hits = files().map((f) => f.rel).filter((r) => keep(r) && (!contains || r.toLowerCase().includes(String(contains).toLowerCase())));
      if (!hits.length) return "No matching files.";
      return clip(hits.slice(0, 500).join("\n") + (hits.length > 500 ? `\n… ${hits.length - 500} more` : ""));
    },
    grep({ pattern, folder, ignore_case }) {
      let re;
      try {
        re = new RegExp(pattern, ignore_case ? "i" : "");
      } catch (e) {
        return `Invalid regular expression: ${e.message}`;
      }
      const keep = underFolder(folder);
      const out = [];
      for (const f of files()) {
        if (!keep(f.rel)) continue;
        const text = readText(f.abs);
        if (text == null) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && out.length < GREP_MATCHES; i++) {
          if (re.test(lines[i])) out.push(`${f.rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
        if (out.length >= GREP_MATCHES) {
          out.push(`… stopped at ${GREP_MATCHES} matches; narrow the pattern or folder`);
          break;
        }
      }
      return out.length ? clip(out.join("\n")) : "No matches.";
    },
    read_file({ path: p, start_line, end_line }) {
      const abs = safePath(dir, p);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `${p} does not exist.`;
      const text = readText(abs);
      if (text == null) return `${p} is not a text file.`;
      const lines = text.split("\n");
      const start = Math.max(1, Math.floor(Number(start_line) || 1));
      const end = Math.min(lines.length, Math.floor(Number(end_line) || start + READ_LINES - 1), start + READ_LINES - 1);
      const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
      const more = end < lines.length ? `\n(lines ${start}-${end} of ${lines.length}; read more with start_line=${end + 1})` : "";
      return clip(body + more);
    },
    edit_file({ path: p, old_string, new_string, replace_all }) {
      const abs = safePath(dir, p);
      if (!fs.existsSync(abs)) return `${p} does not exist. Use write_file to create it.`;
      if (!old_string) return "old_string is empty.";
      const text = fs.readFileSync(abs, "utf8");
      // Models often send LF when the file is CRLF; match either.
      const crlf = text.includes("\r\n");
      const norm = (s) => (crlf ? String(s).replace(/\r?\n/g, "\r\n") : String(s));
      const oldS = norm(old_string), newS = norm(new_string ?? "");
      const count = text.split(oldS).length - 1;
      if (count === 0) return `old_string not found in ${p}. Re-read the file and copy the text exactly (without line numbers).`;
      if (count > 1 && !replace_all) return `old_string appears ${count} times in ${p}. Include more surrounding lines to make it unique, or set replace_all.`;
      remember(abs);
      fs.writeFileSync(abs, replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS));
      return `Edited ${p} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? "s" : ""}).`;
    },
    write_file({ path: p, content }) {
      const abs = safePath(dir, p);
      remember(abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(content ?? ""));
      fileList = null;
      return `Wrote ${p} (${String(content ?? "").split("\n").length} lines).`;
    },
  };

  // What changed, from the originals the tools kept: [{ rel, status, before, after }].
  const changes = () => {
    const out = [];
    for (const [rel, before] of originals) {
      const abs = path.join(dir, rel);
      const after = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
      if (after === before) continue;
      out.push({ rel, status: before == null ? "added" : after == null ? "deleted" : "modified", before: before ?? "", after: after ?? "" });
    }
    return out;
  };
  return { impl, changes };
}

// Keep the conversation within the model's context: blank out the oldest tool results first.
function trimHistory(messages) {
  let total = messages.reduce((n, m) => n + (m.content?.length || 0) + JSON.stringify(m.tool_calls || "").length, 0);
  for (const m of messages) {
    if (total <= HISTORY_CHARS) break;
    if (m.role === "tool" && m.content.length > 200) {
      total -= m.content.length - 60;
      m.content = "(older tool output removed to save space; call the tool again if needed)";
    }
  }
}

async function ollamaChat(model, messages) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: cancelSignal(5 * 60_000),
    body: JSON.stringify({ model, messages, tools: TOOLS, stream: false, options: { num_ctx: AGENT_CTX, temperature: 0.2 } }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
  return res.json();
}

const stat = (c) => {
  let added = 0, removed = 0;
  for (const l of diffOf(c).split("\n").slice(1)) {
    if (l.startsWith("+") && !l.startsWith("+++")) added++;
    else if (l.startsWith("-") && !l.startsWith("---")) removed++;
  }
  return { file: c.rel, status: c.status, how: c.status === "added" ? "created" : c.status === "deleted" ? "deleted" : "edited", added, removed };
};

// Run a task. Returns { summary, model, steps, ms, stopped, changes: [{ file, status, added, removed }], errors, usage }.
export async function runAgent({ dir = projectDir(), task, files = [], model = AGENT_MODEL, maxSteps = MAX_STEPS, onProgress = () => {} }) {
  dir = path.resolve(dir);
  const { impl, changes } = makeTools(dir);
  const hint = files.length ? `\n\nFiles likely involved: ${files.join(", ")}` : "";
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Project root: ${path.basename(dir)}\n\nTask:\n${task}${hint}` },
  ];
  const started = Date.now();
  const usage = { in: 0, out: 0 };
  const seen = new Map();
  let summary = "", stopped = "", steps = 0;

  while (true) {
    if (steps >= maxSteps) { stopped = `hit the ${maxSteps}-step limit`; break; }
    if (Date.now() - started > TIME_LIMIT_MS) { stopped = "hit the time limit"; break; }
    trimHistory(messages);
    let data;
    try {
      data = await ollamaChat(model, messages);
    } catch (err) {
      // Stop button: keep what was done so far (edits are already on disk) and report it.
      if (cancelSignal()?.aborted) { stopped = "you stopped it"; break; }
      throw err;
    }
    usage.in += data.prompt_eval_count || 0;
    usage.out += data.eval_count || 0;
    const msg = data.message || {};
    const calls = msg.tool_calls || [];
    const text = (msg.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    // Keep the model's own turn (without its thinking) so it sees what it asked for.
    messages.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      summary = text;
      break;
    }
    steps++;
    for (const call of calls) {
      if (cancelSignal()?.aborted) { stopped = "you stopped it"; break; }
      const name = call.function?.name;
      let args = call.function?.arguments || {};
      if (typeof args === "string") try { args = JSON.parse(args); } catch { args = {}; }
      const key = `${name} ${JSON.stringify(args)}`;
      seen.set(key, (seen.get(key) || 0) + 1);
      let result;
      try {
        if (!impl[name]) result = `Unknown tool ${name}. Tools: ${Object.keys(impl).join(", ")}.`;
        else if (seen.get(key) > 2 && !/^(read_file|list_files|grep)$/.test(name)) result = "You already made this exact call. Do something different or finish with a summary.";
        else result = impl[name](args);
      } catch (e) {
        result = `Error: ${e.message}`;
      }
      if (seen.get(key) > 3) stopped = "kept repeating the same call";
      onProgress(`${name} ${args.path || args.pattern || args.folder || ""}`.trim());
      messages.push({ role: "tool", content: String(result), tool_name: name });
    }
    if (stopped) break;
  }

  const changed = changes();
  const errors = syntaxErrors(dir, changed);
  return { summary, model, steps, ms: Date.now() - started, stopped, changes: changed.map(stat), errors, usage };
}

export function reportText(r) {
  const lines = [`[${r.model}, local agent: ${r.steps} step${r.steps === 1 ? "" : "s"}, ${Math.round(r.ms / 1000)}s${r.stopped ? `, stopped early: ${r.stopped}` : ""}]`];
  lines.push(r.summary || "(no summary given)");
  if (r.changes.length) {
    lines.push("", "Files changed:");
    for (const c of r.changes) lines.push(`  ${c.status === "added" ? "A" : c.status === "deleted" ? "D" : "M"} ${c.file}  +${c.added} -${c.removed}`);
  } else lines.push("", "No files changed.");
  if (r.errors.length) lines.push("", "Syntax errors:", ...r.errors.map((e) => `  ${e.file}: ${e.error}`));
  if (r.changes.length) lines.push("", "Review with git diff before relying on it.");
  return lines.join("\n");
}

// Run a task and record it in the project's shared log (re-read before saving: others may have written meanwhile).
export async function runAgentAndLog({ dir = projectDir(), sub = defaultSub(), from = "claude", task, files = [], model, maxSteps, onProgress }) {
  if (!String(task || "").trim()) throw new Error("task is required");
  const entry = { from, content: `[local task] ${task}`, ts: new Date().toISOString(), mode: "task" };
  const r = await runAgent({ dir, task, files, model: model || AGENT_MODEL, maxSteps, onProgress });
  const report = reportText(r);
  const log = loadLog(dir, sub);
  log.messages.push(entry, {
    from: "local",
    model: r.model,
    content: report,
    ts: new Date().toISOString(),
    mode: "task",
    usage: { in: r.usage.in, out: r.usage.out, ms: r.ms },
    ...(r.changes.length ? { changes: r.changes.map(({ file, how, added, removed }) => ({ file, how, added, removed })) } : {}),
  });
  saveLog(log, dir, sub);
  return { ...r, report };
}
