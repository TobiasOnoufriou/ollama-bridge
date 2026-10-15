// Open things for a project folder: the native folder picker, and new terminal windows running
// Claude Code, claude-local or a plain shell in that folder (like the Claude desktop app's project picker).
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { HERE } from "./config.mjs";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const hasCmd = (cmd) =>
  IS_WIN
    ? spawnSync("where", [cmd], { stdio: "ignore" }).status === 0
    : spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function detached(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, ...opts });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function capture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out: out.trim() }));
  });
}

// Native "choose a folder" dialog. Resolves to the chosen path, or null if cancelled.
export async function pickFolder() {
  if (IS_WIN) {
    const r = await capture("powershell", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "pick-folder.ps1")]);
    return r.out || null;
  }
  if (IS_MAC) {
    const r = await capture("osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose a project folder")']);
    return r.code === 0 && r.out ? r.out.replace(/\/$/, "") : null;
  }
  if (hasCmd("zenity")) {
    const r = await capture("zenity", ["--file-selection", "--directory", "--title=Choose a project folder"]);
    return r.code === 0 && r.out ? r.out : null;
  }
  if (hasCmd("kdialog")) {
    const r = await capture("kdialog", ["--getexistingdirectory", process.env.HOME || "/"]);
    return r.code === 0 && r.out ? r.out : null;
  }
  throw new Error("No folder dialog available (install zenity or kdialog), so type the path instead.");
}

export const LAUNCH_TARGETS = {
  claude: "Claude Code",
  local: "Claude Code on the local model",
  terminal: "a terminal",
  folder: "the file manager",
};

// Claude Code model aliases (always the latest of each) and the modes it can start in.
export const CLAUDE_MODELS = { "": "Default", fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
export const START_MODES = {
  "": "Normal (ask before edits)",
  plan: "Plan mode (research and plan, no edits)",
  acceptEdits: "Auto-accept edits",
  auto: "Auto mode",
};
export const EFFORT_LEVELS = { "": "Default", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
// Model names go straight into a shell command, so only allow characters model ids actually use.
const MODEL_RE = /^[A-Za-z0-9._:\/\-\[\]]{1,100}$/;
// Fast mode has no CLI flag; it's a per-session setting. A file avoids quoting JSON through PowerShell.
const FAST_SETTINGS = path.join(HERE, "fast-mode.settings.json");

// Claude Code arguments for the chosen options; opts: { model, mode, effort, fast, session }.
// session = { prompt, name, addDir } starts it on a task (see issues.mjs): first message, display name, extra folder.
// local = Claude Code running on an Ollama model, where effort and fast mode don't apply.
export function claudeArgs({ model = "", mode = "", effort = "", fast = false, session = null } = {}, { local = false } = {}) {
  if (model && !MODEL_RE.test(model)) throw new Error(`Invalid model name: ${model}`);
  if (mode && !(mode in START_MODES)) throw new Error(`Unknown start mode: ${mode}`);
  if (effort && !(effort in EFFORT_LEVELS)) throw new Error(`Unknown effort level: ${effort}`);
  const args = [...(model ? [local ? "-Model" : "--model", model] : []), ...(mode ? ["--permission-mode", mode] : [])];
  if (!local) {
    if (effort) args.push("--effort", effort);
    if (fast) {
      if (!fs.existsSync(FAST_SETTINGS)) fs.writeFileSync(FAST_SETTINGS, JSON.stringify({ fastMode: true }) + "\n");
      args.push("--settings", FAST_SETTINGS);
    }
  }
  if (session) {
    // These go through a shell command line; refuse anything that a quote or line break could break out of.
    for (const v of [session.prompt, session.name, session.addDir]) {
      if (v && /["`$\r\n]/.test(v)) throw new Error("Session text can't contain quotes, $ or line breaks");
    }
    if (session.addDir) args.push("--add-dir", session.addDir);
    if (session.name) args.push("--name", session.name);
    if (session.prompt) args.push(session.prompt);
  }
  return args;
}

// Join args into a shell command line, quoting any arg that isn't plain (the settings path can have spaces).
function shellJoin(args) {
  return args.map((a) => (/^[\w.:\/\-\[\]]+$/.test(a) ? a : IS_WIN ? `'${a.replace(/'/g, "''")}'` : shQuote(a))).join(" ");
}

// Shell command to run in the new terminal for each target (null = just a shell).
export function commandFor(what, opts) {
  if (what === "claude") return `claude ${shellJoin(claudeArgs(opts))}`.trim();
  if (what === "local") {
    const bridge = IS_WIN ? `& '${path.join(HERE, "ollama-bridge.cmd").replace(/'/g, "''")}'` : shQuote(path.join(HERE, "ollama-bridge"));
    return `${bridge} claude ${shellJoin(claudeArgs(opts, { local: true }))}`.trim();
  }
  return null;
}

// opts: { model, mode, effort, fast, session } for the claude and local targets; model is a Claude alias/id or an Ollama model name.
export async function launchIn(dir, what, opts = {}) {
  if (!(what in LAUNCH_TARGETS)) throw new Error(`Unknown launch target: ${what}`);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Folder not found: ${dir}`);
  const name = path.basename(dir) || dir;

  if (what === "folder") {
    if (IS_WIN) return detached("explorer", [dir]);
    return detached(IS_MAC ? "open" : "xdg-open", [dir]);
  }
  const cmd = commandFor(what, opts);

  if (IS_WIN) {
    const ps = ["powershell", "-NoExit", ...(cmd ? ["-Command", cmd] : [])];
    // Windows Terminal if installed (new tab titled after the project), otherwise a classic console window.
    if (hasCmd("wt")) return detached("wt", ["-w", "new", "-d", dir, "--title", `${name} - ${LAUNCH_TARGETS[what]}`, ...ps]);
    return detached(ps[0], ps.slice(1), { cwd: dir });
  }

  if (IS_MAC) {
    const script = [
      "on run argv",
      'tell application "Terminal"',
      "activate",
      'do script "cd " & quoted form of (item 1 of argv) & (item 2 of argv)',
      "end tell",
      "end run",
    ];
    return detached("osascript", [...script.flatMap((l) => ["-e", l]), dir, cmd ? ` && ${cmd}` : ""]);
  }

  // Linux: first terminal emulator we can find; keep the shell open after the command exits.
  const shell = ["bash", "-lc", cmd ? `${cmd}; exec bash` : "exec bash"];
  for (const [term, args] of [
    ["x-terminal-emulator", ["-e", ...shell]],
    ["gnome-terminal", ["--", ...shell]],
    ["konsole", ["--workdir", dir, "-e", ...shell]],
    ["xfce4-terminal", ["--working-directory", dir, "-x", ...shell]],
    ["kitty", ["--directory", dir, ...shell]],
    ["alacritty", ["--working-directory", dir, "-e", ...shell]],
    ["xterm", ["-e", ...shell]],
  ]) {
    if (hasCmd(term)) return detached(term, args, { cwd: dir });
  }
  throw new Error("No terminal emulator found. Open a terminal in the folder yourself.");
}
