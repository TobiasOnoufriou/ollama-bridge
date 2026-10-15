// Project list shared by the ollama-bridge command and web UI.
// A project is just a folder; its shared conversation lives in logs/ keyed by that folder's path.
// projects.json (per machine, not committed) remembers folders you added or removed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HERE } from "./config.mjs";
import { listProjects, logPath, sessionsDir, sessionCount } from "./lib.mjs";

const STORE = path.join(HERE, "projects.json");
const IS_WIN = process.platform === "win32";
// Compare paths the way the OS does: case-insensitive on Windows and macOS.
const key = (p) => (IS_WIN || process.platform === "darwin" ? path.resolve(p).toLowerCase() : path.resolve(p));
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE, "utf8"));
    return { added: s.added || [], hidden: s.hidden || [] };
  } catch {
    return { added: [], hidden: [] };
  }
}

function saveStore(store) {
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + "\n");
}

// Turn what someone typed ("~/code/app", "D:\\work", "./x") into an absolute path.
export function resolveUserPath(input, base = process.cwd()) {
  let p = String(input || "").trim().replace(/^["']|["']$/g, "");
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(base, p);
}

// Folders Claude Code has been used in (from ~/.claude.json), skipping the desktop app's temporary workspaces.
export function claudeCodeProjects() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    return Object.keys(j.projects || {})
      .map((p) => path.resolve(p))
      .filter((p) => !/[\\/]scratch-workspaces[\\/]/i.test(p) && isDir(p));
  } catch {
    return [];
  }
}

// Every project to show: added folders, folders with a shared log, and the current folder; minus deleted (hidden) ones.
export function allProjects(current = process.cwd()) {
  const store = loadStore();
  const hidden = new Set(store.hidden.map(key));
  const byKey = new Map();
  const put = (dir, extra = {}) => {
    const k = key(dir);
    const prev = byKey.get(k) || { project: path.resolve(dir), messages: 0, updated: null };
    byKey.set(k, { ...prev, ...extra });
  };
  for (const p of listProjects()) put(p.project, { messages: p.messages, updated: p.updated });
  for (const p of store.added) put(p, { added: true });
  if (current) put(current, { current: true });
  return [...byKey.entries()]
    .filter(([k]) => !hidden.has(k))
    .map(([, p]) => ({ added: false, current: false, ...p, sessions: sessionCount(p.project), exists: isDir(p.project) }))
    .sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || String(b.updated).localeCompare(String(a.updated)) || a.project.localeCompare(b.project));
}

export function addProject(input) {
  const dir = resolveUserPath(input);
  if (!isDir(dir)) throw new Error(`Not a folder: ${dir}`);
  const store = loadStore();
  store.hidden = store.hidden.filter((p) => key(p) !== key(dir));
  if (!store.added.some((p) => key(p) === key(dir))) store.added.push(dir);
  saveStore(store);
  return dir;
}

export function removeProject(input, { deleteHistory = false } = {}) {
  const dir = resolveUserPath(input);
  const store = loadStore();
  store.added = store.added.filter((p) => key(p) !== key(dir));
  if (!store.hidden.some((p) => key(p) === key(dir))) store.hidden.push(dir);
  saveStore(store);
  if (deleteHistory) {
    fs.rmSync(logPath(dir, ""), { force: true });
    fs.rmSync(sessionsDir(dir), { recursive: true, force: true });
  }
  return dir;
}

export function isKnownProject(dir, current) {
  return allProjects(current).some((p) => key(p.project) === key(dir));
}

// Terminal-style folder completion: "C:\Us" -> C:\Users\, "~/co" -> ~/code/ ... (folders only, max 50).
export function completeDir(input) {
  const raw = String(input || "");
  const expanded = resolveUserPath(raw || "~");
  const endsWithSep = /[\\/]$/.test(raw) || raw === "" || raw === "~";
  const parent = endsWithSep ? expanded : path.dirname(expanded);
  const prefix = endsWithSep ? "" : path.basename(expanded);
  let entries = [];
  try {
    entries = fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((d) => {
        if (!d.isDirectory() && !(d.isSymbolicLink() && isDir(path.join(parent, d.name)))) return false;
        if (d.name.startsWith(".") && !prefix.startsWith(".")) return false;
        if (IS_WIN && (d.name.startsWith("$") || d.name === "System Volume Information")) return false;
        return IS_WIN ? d.name.toLowerCase().startsWith(prefix.toLowerCase()) : d.name.startsWith(prefix);
      })
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 50);
  } catch {}
  return {
    parent,
    exists: isDir(expanded),
    resolved: expanded,
    matches: entries.map((name) => path.join(parent, name) + path.sep),
  };
}
