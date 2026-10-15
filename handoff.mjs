// Hand-off note for starting a new Claude Code session, written by the local model for free.
// A long session gets more expensive with every message (each one re-reads the whole context). Asking Claude to
// summarise it costs one more full-context turn; this reads the session transcript on disk instead, boils it down
// in code (your requests, Claude's replies, files changed, commands run) and has the local model write the note.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { OLLAMA_URL, DEFAULT_MODEL, loadLog, saveLog, defaultSub } from "./lib.mjs";
import { recentTranscripts, transcriptFor, contextSize, fmtK } from "./session-hint.mjs";

const DIGEST_CHARS = 40000; // ~10k tokens, leaves room in a 32k context for the instructions and the reply
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const clean = (s) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

function textOf(content) {
  if (typeof content === "string") return content;
  return (content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

// Reduce a transcript to what matters for picking up the work: the conversation and what was changed or run.
export function digest(file, dir) {
  const lines = [], files = new Set();
  let branch = "";
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      continue;
    }
    if ((j.type !== "user" && j.type !== "assistant") || j.isSidechain || j.isMeta) continue;
    if (j.gitBranch) branch = j.gitBranch;
    const content = j.message?.content;
    if (j.type === "user") {
      const t = clean(textOf(content));
      // Skip tool results and Claude Code's own wrappers (slash-command output, interrupts and the like).
      if (t && !t.startsWith("<") && !t.startsWith("[Request interrupted")) lines.push(`User: ${clip(t, 1500)}`);
      continue;
    }
    for (const p of Array.isArray(content) ? content : []) {
      if (p.type === "text" && p.text.trim()) lines.push(`Claude: ${clip(clean(p.text), 800)}`);
      else if (p.type === "tool_use" && EDIT_TOOLS.has(p.name)) {
        const f = p.input?.file_path || p.input?.notebook_path;
        if (f) {
          const rel = path.relative(dir, f) || f;
          files.add(rel.startsWith("..") ? f : rel);
          lines.push(`(Claude ${p.name === "Write" ? "wrote" : "edited"} ${rel})`);
        }
      } else if (p.type === "tool_use" && SHELL_TOOLS.has(p.name)) {
        lines.push(`(Claude ran: ${clip(p.input?.description || p.input?.command || "", 140)})`);
      }
    }
  }
  // Keep the first request (it usually states the goal) and as much of the end as fits.
  const firstAt = lines.findIndex((l) => l.startsWith("User: "));
  const first = lines[firstAt] || "";
  const tail = [];
  let total = first.length;
  for (let i = lines.length - 1; i > firstAt; i--) {
    if (total + lines[i].length > DIGEST_CHARS) {
      tail.unshift("(… earlier part of the session left out …)");
      break;
    }
    total += lines[i].length;
    tail.unshift(lines[i]);
  }
  return { text: [first, ...tail].filter(Boolean).join("\n"), files: [...files], branch };
}

const PROMPT = `Below is a condensed transcript of a Claude Code session. The user is starting a NEW session to continue
the work, and this note will be its first message, so the new session knows only what you write.

Write the note in this shape, at most 250 words, no preamble:
**Goal:** one or two sentences.
**Done so far:** short bullets, naming files and functions.
**Decisions and constraints:** bullets of what was decided or must be kept (skip if none).
**Next:** the open work or the user's latest request, as bullets.

Only state what the transcript shows. Don't list every file (a list is added for you).`;

// { note, file, tokens } for the most recent session in dir (or the given session id).
// sub: the bridge sub-session whose log gets the note (session is the Claude Code session to summarise).
export async function handoff({ dir, session = "", sub = defaultSub(), model = DEFAULT_MODEL } = {}) {
  const file = session ? transcriptFor(session, dir) : recentTranscripts(dir)[0];
  if (!file) throw new Error(`No Claude Code session found for ${dir}${session ? ` with id ${session}` : ""}.`);
  const d = digest(file, dir);
  if (!d.text) throw new Error("That session has no conversation to summarise yet.");

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      options: { num_ctx: 32768, temperature: 0.2 },
      messages: [{ role: "user", content: `${PROMPT}\n\n<transcript>\n${d.text}\n</transcript>` }],
    }),
  }).catch(() => {
    throw new Error(`Ollama isn't answering at ${OLLAMA_URL}. Start it and try again.`);
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const summary = (data.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  // Facts that come straight from the transcript are added in code, so the model can't drop or invent them.
  const facts = [
    d.branch && d.branch !== "HEAD" ? `**Branch:** ${d.branch}` : "",
    d.files.length ? `**Files changed:** ${d.files.join(", ")}` : "",
  ].filter(Boolean);
  const note = `Continuing from a previous session (hand-off note):\n\n${summary}\n\n${facts.join("\n")}`.trim();

  // Keep it in the project's shared log too, so it shows in the web UI and local_history.
  const log = loadLog(dir, sub);
  const ts = new Date().toISOString();
  log.messages.push(
    { from: "human", content: `Hand-off note for a new Claude Code session (from ${path.basename(file, ".jsonl")})`, ts, mode: "handoff" },
    { from: "local", model, content: note, ts, mode: "handoff", usage: { in: data.prompt_eval_count || 0, out: data.eval_count || 0, ms: Math.round((data.total_duration || 0) / 1e6) } },
  );
  saveLog(log, dir, sub);
  return { note, file, size: contextSize(file), model };
}

export function copyToClipboard(text) {
  // clip.exe mangles non-ASCII text, so Windows goes through PowerShell reading stdin as UTF-8.
  const [cmd, args] =
    process.platform === "win32"
      ? ["powershell", ["-NoProfile", "-Command", "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"]]
    : process.platform === "darwin" ? ["pbcopy", []]
    : process.env.WAYLAND_DISPLAY ? ["wl-copy", []]
    : ["xclip", ["-selection", "clipboard"]];
  const r = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
  return r.status === 0;
}

export const describeSize = (size) => (size ? `${fmtK(size.tokens)} tokens of context` : "no usage recorded");
