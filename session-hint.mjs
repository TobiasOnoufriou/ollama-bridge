#!/usr/bin/env node
// When a Claude Code session's context gets large, hint that a new session would be cheaper.
//  - Every message re-reads the whole context (mostly from the prompt cache, but still billed per token), so a
//    session at 150k tokens costs several times more per message than a fresh one in the same project.
//  - As a Claude Code Stop hook (`node session-hint.mjs`, registered by install.mjs) it reads the session's
//    transcript after each reply and, when the context crosses a threshold, shows the user a one-line hint.
//    The hint goes to the user only (systemMessage), so it costs no tokens.
//  - The web UI uses contextSize() for the Claude session it resumes for the chat.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HERE, loadConfig } from "./config.mjs";

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const STATE_FILE = path.join(HERE, "logs", "session-hints.json");
const CHUNK = 256 * 1024; // the first and last usage records are near the ends of the file

export function hintSettings(cfg = loadConfig()) {
  return {
    at: Number(process.env.OLLAMA_BRIDGE_HINT_TOKENS ?? cfg.newSessionHintTokens ?? 100000),
    every: Number(cfg.newSessionHintEvery ?? 50000),
  };
}

const isAnthropic = (model) => /^claude|^(opus|sonnet|haiku|fable)\b/i.test(model || "");
export const fmtK = (n) => `${Math.round(n / 1000)}k`;

// Context of one API call = everything sent to the model: uncached input + cache reads + cache writes.
function usageRecords(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue; // a line cut in half by the chunk boundary
    }
    const m = j.message, u = m?.usage;
    if (j.type !== "assistant" || !u || j.isSidechain || !m.model || m.model === "<synthetic>") continue;
    out.push({
      tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      model: m.model,
      ts: j.timestamp,
      session: j.sessionId,
    });
  }
  return out;
}

function readSlice(fd, start, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  return buf.subarray(0, n).toString("utf8");
}

// { tokens, baseline, model, ts } for a transcript: the latest context and the one the session started with.
// Only reads the start and end of the file, so it stays fast on multi-megabyte transcripts. null if no usage yet.
const sizeCache = new Map(); // file -> { mtimeMs, size, result }
export function contextSize(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = sizeCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result;
  const fd = fs.openSync(file, "r");
  let first, last;
  try {
    first = usageRecords(readSlice(fd, 0, Math.min(CHUNK, stat.size)))[0];
    // Walk back from the end until a usage record turns up (a long tool result can push it back).
    for (let end = stat.size; end > 0 && !last; end -= CHUNK) {
      const start = Math.max(0, end - CHUNK - 4096); // overlap so a record split at the boundary is seen whole
      last = usageRecords(readSlice(fd, start, end - start)).at(-1);
    }
  } finally {
    fs.closeSync(fd);
  }
  const result = last ? { tokens: last.tokens, baseline: (first || last).tokens, model: last.model, ts: last.ts } : null;
  sizeCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, result });
  return result;
}

// Claude Code keeps transcripts in ~/.claude/projects/<folder with every non-alphanumeric as "-">/<session>.jsonl.
export function projectTranscriptDir(dir) {
  return path.join(PROJECTS_DIR, path.resolve(dir).replace(/[^a-zA-Z0-9]/g, "-"));
}

export function transcriptFor(sessionId, dir) {
  if (!/^[\w-]+$/.test(sessionId || "")) return null;
  const direct = path.join(projectTranscriptDir(dir), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const f = path.join(PROJECTS_DIR, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}

// Most recently written transcripts for a project folder, newest first.
export function recentTranscripts(dir) {
  const d = projectTranscriptDir(dir);
  try {
    return fs
      .readdirSync(d)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ file: path.join(d, f), mtimeMs: fs.statSync(path.join(d, f)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((x) => x.file);
  } catch {
    return [];
  }
}

// Is a new session worth suggesting? Only for Claude models (claude-local runs free) and past the threshold.
export function shouldHint(size, settings = hintSettings()) {
  return !!size && settings.at > 0 && isAnthropic(size.model) && size.tokens >= settings.at;
}

// How much cheaper each message would be in a fresh session, in the same terms Claude bills: input tokens.
export function savings(size) {
  const base = Math.min(size.baseline, size.tokens);
  return { ratio: size.tokens / Math.max(1, base), percent: Math.round((1 - base / size.tokens) * 100) };
}

export function hintText(size) {
  const { ratio, percent } = savings(size);
  return (
    `💡 This session's context is ${fmtK(size.tokens)} tokens, ${ratio.toFixed(1)}× what a fresh session here starts ` +
    `with (${fmtK(size.baseline)}). Every message re-reads all of it, so if you're moving on to something new, ` +
    `a new session cuts each message's input by about ${percent}%. For a free handoff note from your local model, ` +
    `run: ollama-bridge handoff`
  );
}

// Hint once per step (100k, 150k, 200k, ... by default) rather than after every reply.
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  const weekAgo = Date.now() - 7 * 86400e3;
  for (const [k, v] of Object.entries(state)) if ((v.at || 0) < weekAgo) delete state[k];
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

export function hookHint({ session_id, transcript_path }, settings = hintSettings()) {
  const size = contextSize(transcript_path);
  const state = loadState();
  const key = session_id || transcript_path;
  if (!shouldHint(size, settings)) {
    // Below the threshold again (e.g. after /compact): hint afresh if it grows back.
    if (state[key]) {
      delete state[key];
      saveState(state);
    }
    return null;
  }
  const stage = Math.floor((size.tokens - settings.at) / Math.max(1, settings.every || Infinity));
  if (state[key] && state[key].stage >= stage) return null;
  state[key] = { stage, at: Date.now() };
  saveState(state);
  return hintText(size);
}

// Stop hook entry point: never fail or block Claude Code, whatever happens here.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    try {
      const hint = hookHint(JSON.parse(input.replace(/^﻿/, ""))); // Windows PowerShell pipes add a BOM
      if (hint) process.stdout.write(JSON.stringify({ systemMessage: hint }));
    } catch {}
    process.exit(0);
  });
}
