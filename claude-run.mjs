// Run Claude Code non-interactively (`claude -p`) in a project folder and record the exchange in the shared log.
// The prompt goes in on stdin, so it never passes through a shell.
import path from "node:path";
import { spawn } from "node:child_process";
import { loadLog, appendMessages } from "./lib.mjs";
import { claudeArgs } from "./launch.mjs";

const IS_WIN = process.platform === "win32";
const CONTEXT_CHARS = 12000;
const TIMEOUT_MS = 15 * 60 * 1000;

// Recent shared conversation, so Claude knows what you and the local models already discussed.
function sharedContext(dir) {
  const lines = [];
  let total = 0;
  for (const m of loadLog(dir).messages.slice().reverse()) {
    const who = m.from === "human" ? "User" : m.from === "claude" ? "Claude" : `Local model (${m.model || "local"})`;
    const line = `[${who}] ${m.content}`;
    if (total + line.length > CONTEXT_CHARS) break;
    total += line.length;
    lines.unshift(line);
  }
  if (!lines.length) return "";
  return (
    "\n\n<shared-context>\nRecent messages from this project's shared conversation between the user, you and their " +
    "local models (oldest first). Use them as background; answer the request above.\n" +
    lines.join("\n\n") +
    "\n</shared-context>"
  );
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

// Returns { reply, model, ms, costUsd, isError }.
export async function runClaude({ dir, prompt, model = "", mode = "", effort = "", fast = false, useHistory = true, meta = {} }) {
  // claudeArgs validates model, mode and effort.
  const args = ["-p", "--output-format", "json", ...claudeArgs({ model, mode, effort, fast })];
  const fullPrompt = prompt + (useHistory ? sharedContext(dir) : "");

  const started = Date.now();
  const entry = { from: "human", content: prompt, ts: new Date().toISOString(), ...(mode === "plan" ? { mode: "plan" } : {}), ...meta };
  // Drop Ollama overrides in case this was started from claude-local, so this really talks to Claude.
  const env = { ...process.env };
  if (/localhost|127\.0\.0\.1/.test(env.ANTHROPIC_BASE_URL || "")) {
    for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_MAX_CONTEXT_TOKENS"]) {
      delete env[k];
    }
  }
  const child = await spawnClaude(args, { cwd: path.resolve(dir), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.stdin.end(fullPrompt);
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
  const code = await new Promise((resolve) => child.once("close", resolve));
  clearTimeout(timer);

  let reply, isError = code !== 0, costUsd = null;
  try {
    const j = JSON.parse(out);
    reply = j.result ?? "";
    isError = isError || !!j.is_error;
    costUsd = j.total_cost_usd ?? null;
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
  const details = [model, effort && `${effort} effort`, fast && "fast"].filter(Boolean);
  const label = `Claude Code${details.length ? ` (${details.join(", ")})` : ""}`;
  appendMessages(dir, entry, {
    from: "claude",
    model: label,
    content: reply,
    ts: new Date().toISOString(),
    ...(mode === "plan" ? { mode: "plan" } : {}),
    ...(isError ? { error: true } : {}),
  });
  return { reply, model: label, ms, costUsd, isError };
}
