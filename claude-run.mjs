// Run Claude Code non-interactively (`claude -p`) in a project folder and record the exchange in the shared log.
// The prompt goes in on stdin, so it never passes through a shell.
import path from "node:path";
import { spawn } from "node:child_process";
import { loadLog, saveLog, defaultSub, cancelSignal } from "./lib.mjs";
import { claudeArgs } from "./launch.mjs";

const IS_WIN = process.platform === "win32";
const CONTEXT_CHARS = 12000;
const TIMEOUT_MS = 15 * 60 * 1000;
// Runs from the chat have nobody to approve anything, so Claude only gets the tools it can actually use, and no
// MCP servers or skills: tool descriptions are most of a session's input and are re-read on every turn.
//  - Plan mode: read only.
//  - Normal / Auto-accept edits: read and edit (shell commands would be refused anyway). Normal can't ask before
//    edits here, and read-only Normal left you unable to implement after unticking Plan, so it runs as acceptEdits.
//  - Auto mode: the full toolset, since it can approve its own actions.
const LEAN = ["--strict-mcp-config", "--disable-slash-commands"];
const PROFILES = {
  read: ["--tools", "Read,Grep,Glob", ...LEAN],
  edit: ["--tools", "Read,Edit,Write,Grep,Glob", ...LEAN],
  full: [],
};
const AUTO_EFFORTS = new Set(["low", "medium"]); // Smart never picks more than medium

// Shared-conversation messages Claude hasn't seen yet in this session (all of them for a new session),
// so you, the local models and Claude stay in sync without resending the whole history every time.
// exclude: timestamps of messages already included in the prompt (e.g. the plan being implemented).
function sharedContext(messages, sessionId, exclude = []) {
  const lines = [];
  let total = 0;
  for (const m of messages.slice().reverse()) {
    if (sessionId && m.claudeSession === sessionId) continue; // Claude already has its own turns
    if (exclude.includes(m.ts)) continue;
    const who = m.from === "human" ? "User" : m.from === "claude" ? "Claude" : `Local model (${m.model || "local"})`;
    const line = `[${who}] ${m.content}`;
    if (total + line.length > CONTEXT_CHARS) break;
    total += line.length;
    lines.unshift(line);
  }
  if (!lines.length) return "";
  return (
    "\n\n<shared-context>\nNew messages in this project's shared conversation between the user, you and their " +
    "local models since you last replied (oldest first). Use them as background; answer the request above.\n" +
    lines.join("\n\n") +
    "\n</shared-context>"
  );
}

// Kill the run and anything it started (on Windows a shell-launched claude.cmd is a cmd.exe with claude under it).
function stop(child) {
  if (IS_WIN && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
  else child.kill();
}

// Lines of a Claude edit, minus the unchanged lines at either end of old_string/new_string.
function lineDelta(before = "", after = "") {
  const a = before ? before.split("\n") : [], b = after ? after.split("\n") : [];
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return { added: b.length - s - e, removed: a.length - s - e };
}

// Follows the stream-json events of a run: what Claude is doing right now (for progress) and which files its
// Edit/Write calls changed. Changes count only once the tool result comes back without an error (an edit can be
// refused or fail to match). Shell commands in Auto mode can change files too; those aren't seen here.
function tracker(dir, onProgress) {
  const pending = new Map(); // tool_use id -> { file, how, added, removed }
  const changes = new Map(); // relative path -> { file, how, added, removed }
  let actions = 0;
  const rel = (p) => {
    const r = path.relative(dir, path.resolve(dir, String(p || "")));
    return (r && !r.startsWith("..") && !path.isAbsolute(r) ? r : String(p || "")).split(path.sep).join("/");
  };
  const summary = () => `${actions} action${actions === 1 ? "" : "s"}${changes.size ? `, ${changes.size} file${changes.size === 1 ? "" : "s"} changed` : ""}`;
  const describe = (name, input = {}) => {
    const file = input.file_path || input.notebook_path;
    if (name === "Read") return `reading ${rel(file)}`;
    if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name)) return `${name === "Write" ? "writing" : "editing"} ${rel(file)}`;
    if (name === "Grep") return `searching for "${String(input.pattern || "").slice(0, 40)}"`;
    if (name === "Glob") return `looking for ${String(input.pattern || "").slice(0, 40)}`;
    if (name === "Bash") return "running a command";
    return `using ${name}`;
  };
  const onEvent = (ev) => {
    for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
      if (ev.type === "assistant" && block.type === "tool_use") {
        actions++;
        onProgress(`${describe(block.name, block.input)} (${summary()})`);
        const input = block.input || {};
        let delta = null;
        if (block.name === "Edit") delta = lineDelta(input.old_string, input.new_string);
        else if (block.name === "MultiEdit") {
          delta = (input.edits || []).reduce((t, e) => {
            const d = lineDelta(e.old_string, e.new_string);
            return { added: t.added + d.added, removed: t.removed + d.removed };
          }, { added: 0, removed: 0 });
        } else if (block.name === "Write") delta = lineDelta("", input.content);
        else if (block.name === "NotebookEdit") delta = { added: 0, removed: 0 };
        if (delta && (input.file_path || input.notebook_path)) {
          pending.set(block.id, { file: rel(input.file_path || input.notebook_path), how: block.name === "Write" ? "written" : "edited", ...delta });
        }
      }
      if (ev.type === "user" && block.type === "tool_result" && pending.has(block.tool_use_id)) {
        const c = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        if (block.is_error) continue;
        const had = changes.get(c.file);
        changes.set(c.file, had ? { ...had, added: had.added + c.added, removed: had.removed + c.removed } : c);
      }
    }
  };
  return { onEvent, changes: () => [...changes.values()] };
}

// stream-json: one JSON event per line; the last one, type "result", carries what --output-format json would.
// onEvent sees every event; non-JSON output (e.g. an error message) is kept as text.
async function runOnce(args, input, dir, env, onEvent = () => {}) {
  const signal = cancelSignal();
  if (signal?.aborted) return { code: null, out: "", err: "", json: null, stopped: true };
  const child = await spawnClaude(args, { cwd: path.resolve(dir), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "", err = "", buf = "", json = null;
  const line = (l) => {
    if (!l.trim()) return;
    let ev;
    try {
      ev = JSON.parse(l);
    } catch {
      out += `${l}\n`;
      return;
    }
    if (ev?.type === "result") json = ev;
    try {
      onEvent(ev);
    } catch {}
  };
  child.stdout.setEncoding("utf8"); // so a character split across chunks isn't mangled
  child.stdout.on("data", (d) => {
    const lines = (buf + d).split("\n");
    buf = lines.pop();
    lines.forEach(line);
  });
  child.stderr.on("data", (d) => (err += d));
  child.stdin.on("error", () => {}); // killed before reading its input
  child.stdin.end(input);
  const timer = setTimeout(() => stop(child), TIMEOUT_MS);
  const onStop = () => stop(child);
  signal?.addEventListener("abort", onStop, { once: true });
  const code = await new Promise((resolve) => child.once("close", resolve));
  line(buf);
  clearTimeout(timer);
  signal?.removeEventListener("abort", onStop);
  if (signal?.aborted) return { code, out, err, json: null, stopped: true };
  return { code, out, err, json };
}

function spawnClaude(args, opts) {
  // The winget/native install is claude.exe; an npm install is claude.cmd, which needs a shell on Windows.
  // Every arg here is a fixed flag or a validated model/mode, so the shell fallback is safe.
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, opts);
    child.once("spawn", () => resolve(child));
    child.once("error", (err) => {
      if (IS_WIN && err.code === "ENOENT") {
        const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
        const viaShell = spawn("claude", quoted, { ...opts, shell: true });
        viaShell.once("spawn", () => resolve(viaShell));
        viaShell.once("error", reject);
      } else reject(err);
    });
  });
}

// Each project (and each of its sub-sessions) keeps one Claude Code session per toolset in its log, and later runs
// resume it: the system prompt and earlier turns then come from Claude's prompt cache instead of being sent fresh.
// autoEffort: Smart's suggestion ("low" or "medium"), used only when no effort is set.
// Returns { reply, model, ms, costUsd, usage, isError, changes }; changes ([{ file, how, added, removed }]) is also
// stored on the reply's log entry.
// logText: what the log shows for the prompt (e.g. a short label instead of a pasted plan).
// sub: the sub-session ("" = main).
// onProgress(text): what Claude is doing right now, e.g. "editing lib.mjs (4 actions, 1 file changed)".
export async function runClaude({ dir, sub = defaultSub(), prompt, model = "", mode: startMode = "", effort = "", autoEffort = "", fast = false, useHistory = true, meta = {}, logText = "", exclude = [], onProgress = () => {} }) {
  const usedEffort = effort || (AUTO_EFFORTS.has(autoEffort) ? autoEffort : "");
  const mode = startMode || "acceptEdits";
  const profile = mode === "plan" ? "read" : mode === "acceptEdits" ? "edit" : "full";
  // claudeArgs validates model, mode and effort. stream-json in print mode needs --verbose.
  const base = ["-p", "--output-format", "stream-json", "--verbose", ...claudeArgs({ model, mode, effort: usedEffort, fast }), ...PROFILES[profile]];
  const track = tracker(path.resolve(dir), onProgress);

  const started = Date.now();
  const entry = { from: "human", content: logText || prompt, ts: new Date().toISOString(), ...(mode === "plan" ? { mode: "plan" } : {}), ...meta };
  // Drop Ollama overrides in case this was started from claude-local, so this really talks to Claude.
  const env = { ...process.env };
  if (/localhost|127\.0\.0\.1/.test(env.ANTHROPIC_BASE_URL || "")) {
    for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_MAX_CONTEXT_TOKENS"]) {
      delete env[k];
    }
  }

  const log = loadLog(dir, sub);
  const saved = useHistory ? log.claude?.[profile] : null;
  const context = (session, upTo) => (useHistory ? sharedContext(log.messages.slice(session ? upTo : 0), session, exclude) : "");
  let r = await runOnce(saved ? [...base, "--resume", saved.session] : base, prompt + context(saved?.session, saved?.upTo), dir, env, track.onEvent);
  // The saved session can be gone (deleted, other machine, expired): start a new one with the full context.
  // Only for that error: a broader match (e.g. a usage-limit message) would pay for the whole prompt twice.
  if (saved && (r.code !== 0 || r.json?.is_error) && /no conversation found|session[^.\n]{0,60}not found/i.test(`${r.err} ${r.out} ${r.json?.result || ""}`)) {
    r = await runOnce(base, prompt + context(null, 0), dir, env, track.onEvent);
  }
  const { code, out, err, json } = r;
  const changes = track.changes().slice(0, 50);

  let reply, isError = code !== 0, costUsd = null, usage = null;
  try {
    const j = json ?? JSON.parse(out);
    reply = j.result ?? "";
    isError = isError || !!j.is_error;
    costUsd = j.total_cost_usd ?? null;
    const u = j.usage || {};
    usage = {
      in: u.input_tokens || 0,
      out: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      ms: j.duration_ms || 0,
      turns: j.num_turns || 0,
      ...(costUsd != null ? { costUsd } : {}),
    };
  } catch {
    reply = out.trim() || err.trim() || `Claude Code exited with code ${code}`;
  }
  if (!reply) reply = err.trim() || "(no reply)";
  // Stopped from the UI: kept in the log because Claude may already have edited files.
  if (r.stopped) {
    isError = true;
    reply = "Stopped before finishing. Any edits Claude made up to that point are still in the files.";
  }
  if (/not logged in|please run \/login/i.test(reply)) {
    isError = true;
    reply = "The Claude Code CLI isn't signed in on this machine. Open a terminal, run `claude`, type `/login` " +
      "and sign in, then send this again.";
  }
  const ms = Date.now() - started;
  const details = [model, usedEffort && `${usedEffort} effort${effort ? "" : ", auto"}`, fast && "fast"].filter(Boolean);
  const label = `Claude Code${details.length ? ` (${details.join(", ")})` : ""}`;
  const session = json?.session_id || null;
  const tag = session ? { claudeSession: session } : {};
  // A resumed session reports its running total cost; keep just this run's share.
  const sessionCost = costUsd;
  if (usage && costUsd != null && saved?.session === session && saved?.costTotal != null) {
    costUsd = Math.max(0, costUsd - saved.costTotal);
    usage.costUsd = costUsd;
  }
  // Re-read before saving: other writers may have added messages while Claude was working.
  const fresh = loadLog(dir, sub);
  fresh.messages.push({ ...entry, ...tag }, {
    from: "claude",
    model: label,
    content: reply,
    ts: new Date().toISOString(),
    ...tag,
    ...(usage ? { usage } : {}),
    ...(changes.length ? { changes } : {}),
    ...(mode === "plan" ? { mode: "plan" } : {}),
    ...(isError ? { error: true } : {}),
  });
  if (session && !isError && useHistory) {
    fresh.claude = { ...fresh.claude, [profile]: { session, upTo: fresh.messages.length, ...(sessionCost != null ? { costTotal: sessionCost } : {}) } };
  }
  saveLog(fresh, dir, sub);
  return { reply, model: label, ms, costUsd, usage, isError, changes, ...(r.stopped ? { stopped: true } : {}) };
}
