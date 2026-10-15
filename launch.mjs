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
// Model names go straight into a shell command, so only allow characters model ids actually use.
const MODEL_RE = /^[A-Za-z0-9._:\/\-\[\]]{1,100}$/;

function claudeFlags({ model, mode }, modelFlag) {
  if (model && !MODEL_RE.test(model)) throw new Error(`Invalid model name: ${model}`);
  if (mode && !(mode in START_MODES)) throw new Error(`Unknown start mode: ${mode}`);
  return [...(model ? [modelFlag, model] : []), ...(mode ? ["--permission-mode", mode] : [])].join(" ");
}

// Shell command to run in the new terminal for each target (null = just a shell).
export function commandFor(what, opts) {
  if (what === "claude") return `claude ${claudeFlags(opts, "--model")}`.trim();
  if (what === "local") {
    const bridge = IS_WIN ? `& '${path.join(HERE, "ollama-bridge.cmd").replace(/'/g, "''")}'` : shQuote(path.join(HERE, "ollama-bridge"));
    return `${bridge} claude ${claudeFlags(opts, "-Model")}`.trim();
  }
  return null;
}

// opts: { model, mode } for the claude and local targets; model is a Claude alias/id or an Ollama model name.
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
