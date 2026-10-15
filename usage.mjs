// Usage numbers for the web UI's Usage panel.
//  - Claude Code: every assistant message Claude Code recorded on this machine (~/.claude/projects/**/*.jsonl),
//    so it covers the desktop app, terminal sessions, `claude -p` runs and claude-local alike.
//  - ollama-bridge: local replies, hand-offs from Claude and smart-routing decisions from the shared logs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProjects, listSessions, loadLog } from "./lib.mjs";

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const RANGES = { "5h": 5 * 3600e3, today: null, "7d": 7 * 86400e3, "30d": 30 * 86400e3 };
const fileCache = new Map(); // file -> { mtimeMs, size, records }

function jsonlFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsonlFiles(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

// One record per assistant message that reported token usage.
function readRecords(file, stat) {
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.records;
  const records = [];
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {}
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const m = j.message;
    const u = m?.usage;
    if (j.type !== "assistant" || !u || !m.model || m.model === "<synthetic>") continue;
    records.push({
      id: m.id || j.uuid,
      ts: Date.parse(j.timestamp) || 0,
      model: m.model,
      in: u.input_tokens || 0,
      out: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      fast: u.speed === "fast",
      project: j.cwd || "",
      session: j.sessionId || "",
    });
  }
  fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, records });
  return records;
}

function since(range) {
  if (range === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return Date.now() - (RANGES[range] ?? RANGES["7d"]);
}

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const isAnthropic = (model) => /^claude|^(opus|sonnet|haiku|fable)\b/i.test(model);

function bump(map, key, rec) {
  const t = map.get(key) || { key, messages: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  t.messages++;
  t.in += rec.in;
  t.out += rec.out;
  t.cacheRead += rec.cacheRead || 0;
  t.cacheWrite += rec.cacheWrite || 0;
  map.set(key, t);
}

function summarise(records, from, withDays) {
  const total = { messages: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, fastMessages: 0 };
  const byModel = new Map(), byProject = new Map(), byDay = new Map(), sessions = new Set();
  for (const r of records) {
    total.messages++;
    total.in += r.in;
    total.out += r.out;
    total.cacheRead += r.cacheRead;
    total.cacheWrite += r.cacheWrite;
    if (r.fast) total.fastMessages++;
    sessions.add(r.session);
    bump(byModel, r.model, r);
    bump(byProject, r.project || "(unknown)", r);
    if (withDays) bump(byDay, dayKey(r.ts), r);
  }
  const top = (m, n) => [...m.values()].sort((a, b) => b.out + b.in - (a.out + a.in)).slice(0, n);
  let days = [];
  if (withDays) {
    // Every day in the range, including quiet ones, oldest first.
    for (let t = new Date(from).setHours(0, 0, 0, 0); t <= Date.now(); t += 86400e3) {
      const k = dayKey(t);
      days.push(byDay.get(k) || { key: k, messages: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
    }
  }
  return { ...total, sessions: sessions.size, byModel: top(byModel, 8), byProject: top(byProject, 6), byDay: days };
}

export function claudeCodeUsage(range = "7d") {
  const from = since(range);
  const seen = new Set();
  const claude = [], local = [];
  for (const file of jsonlFiles(PROJECTS_DIR)) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.mtimeMs < from) continue; // nothing new in this file since the range started
    for (const r of readRecords(file, stat)) {
      if (r.ts < from || seen.has(r.id)) continue; // streamed messages can be written more than once
      seen.add(r.id);
      (isAnthropic(r.model) ? claude : local).push(r);
    }
  }
  const withDays = range === "7d" || range === "30d";
  return { claude: summarise(claude, from, withDays), localViaClaudeCode: summarise(local, from, false) };
}

export function bridgeUsage(range = "7d") {
  const from = since(range);
  const out = { localReplies: 0, in: 0, out: 0, ms: 0, handedOff: 0, smartLocal: 0, smartClaude: 0, claudeRuns: 0, claudeCostUsd: 0, byModel: [] };
  const byModel = new Map();
  const logs = listProjects().flatMap((p) => listSessions(p.project).map((s) => loadLog(p.project, s.id).messages));
  for (const msgs of logs) {
    msgs.forEach((m, i) => {
      if ((Date.parse(m.ts) || 0) < from) return;
      if (m.from === "local") {
        out.localReplies++;
        out.in += m.usage?.in || 0;
        out.out += m.usage?.out || 0;
        out.ms += m.usage?.ms || 0;
        if (msgs[i - 1]?.from === "claude") out.handedOff++;
        bump(byModel, m.model || "local", { in: m.usage?.in || 0, out: m.usage?.out || 0 });
      } else if (m.from === "claude" && m.usage) {
        out.claudeRuns++;
        out.claudeCostUsd += m.usage.costUsd || 0;
      } else if (m.from === "human" && m.route && m.route.by !== "you") {
        if (m.route.to === "local") out.smartLocal++;
        else out.smartClaude++;
      }
    });
  }
  out.byModel = [...byModel.values()].sort((a, b) => b.messages - a.messages);
  return out;
}

export function usage(range = "7d") {
  if (!(range in RANGES)) range = "7d";
  return { range, generatedAt: new Date().toISOString(), ...claudeCodeUsage(range), bridge: bridgeUsage(range) };
}
