// Run Claude Code non-interactively (`claude -p`) in a project folder and record the exchange in the shared log.
// The prompt goes in on stdin, so it never passes through a shell.
import path from "node:path";
import { spawn } from "node:child_process";
import { loadLog, saveLog } from "./lib.mjs";
import { claudeArgs } from "./launch.mjs";

const IS_WIN = process.platform === "win32";
const CONTEXT_CHARS = 12000;
const TIMEOUT_MS = 15 * 60 * 1000;
// In Normal and Plan mode Claude can only read files from here (nobody is there to approve edits), so give it just
// the read tools and skip MCP servers and skills: their descriptions are most of a fresh session's input tokens.
const SLIM_ARGS = ["--tools", "Read,Grep,Glob", "--strict-mcp-config", "--disable-slash-commands"];
const AUTO_EFFORTS = new Set(["low", "medium"]); // Smart never picks more than medium

// Shared-conversation messages Claude hasn't seen yet in this session (all of them for a new session),
// so you, the local models and Claude stay in sync without resending the whole history every time.
function sharedContext(messages, sessionId) {
  const lines = [];
  let total = 0;
  for (const m of messages.slice().reverse()) {
    if (sessionId && m.claudeSession === sessionId) continue; // Claude already has its own turns
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

async function runOnce(args, input, dir, env) {
  const child = await spawnClaude(args, { cwd: path.resolve(dir), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
  const code = await new Promise((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  let json = null;
  try {
    json = JSON.parse(out);
  } catch {}
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

// Each project keeps one Claude Code session per toolset ("read" or "full") in its log, and later runs resume it:
// the system prompt and earlier turns then come from Claude's prompt cache instead of being sent fresh.
// autoEffort: Smart's suggestion ("low" or "medium"), used only when no effort is set.
// Returns { reply, model, ms, costUsd, usage, isError }.
export async function runClaude({ dir, prompt, model = "", mode = "", effort = "", autoEffort = "", fast = false, useHistory = true, meta = {} }) {
  const usedEffort = effort || (AUTO_EFFORTS.has(autoEffort) ? autoEffort : "");
  const slim = mode === "" || mode === "plan";
  const profile = slim ? "read" : "full";
  // claudeArgs validates model, mode and effort.
  const base = ["-p", "--output-format", "json", ...claudeArgs({ model, mode, effort: usedEffort, fast }), ...(slim ? SLIM_ARGS : [])];

  const started = Date.now();
  const entry = { from: "human", content: prompt, ts: new Date().toISOString(), ...(mode === "plan" ? { mode: "plan" } : {}), ...meta };
  // Drop Ollama overrides in case this was started from claude-local, so this really talks to Claude.
  const env = { ...process.env };
  if (/localhost|127\.0\.0\.1/.test(env.ANTHROPIC_BASE_URL || "")) {
    for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_MAX_CONTEXT_TOKENS"]) {
      delete env[k];
    }
  }

  const log = loadLog(dir);
  const saved = useHistory ? log.claude?.[profile] : null;
  const context = (session, upTo) => (useHistory ? sharedContext(log.messages.slice(session ? upTo : 0), session) : "");
  let r = await runOnce(saved ? [...base, "--resume", saved.session] : base, prompt + context(saved?.session, saved?.upTo), dir, env);
  // The saved session can be gone (deleted, other machine, expired): start a new one with the full context.
  if (saved && (r.code !== 0 || r.json?.is_error) && /no conversation|not found|session/i.test(`${r.err} ${r.json?.result || ""}`)) {
    r = await runOnce(base, prompt + context(null, 0), dir, env);
  }
  const { code, out, err, json } = r;

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
  const fresh = loadLog(dir);
  fresh.messages.push({ ...entry, ...tag }, {
    from: "claude",
    model: label,
    content: reply,
    ts: new Date().toISOString(),
    ...tag,
    ...(usage ? { usage } : {}),
    ...(mode === "plan" ? { mode: "plan" } : {}),
    ...(isError ? { error: true } : {}),
  });
  if (session && !isError && useHistory) {
    fresh.claude = { ...fresh.claude, [profile]: { session, upTo: fresh.messages.length, ...(sessionCost != null ? { costTotal: sessionCost } : {}) } };
  }
  saveLog(fresh, dir);
  return { reply, model: label, ms, costUsd, usage, isError };
}
