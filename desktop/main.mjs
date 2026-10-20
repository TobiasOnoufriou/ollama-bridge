// ollama-bridge desktop app: the web UI in its own window.
// Starts `node ollama-bridge.mjs ui --no-open` as a child process (real Node, so the server behaves exactly as it
// does from the CLI), loads its 127.0.0.1 URL, and stops the server when the app quits.
import { app, BrowserWindow, dialog, nativeTheme, session, shell } from "electron";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4317;
const STATE_FILE = path.join(app.getPath("userData"), "window.json");

let win = null;
let server = null;
let quitting = false;

// The bridge folder whose server (and logs/config) the app uses: OLLAMA_BRIDGE_HOME, else the checkout this app
// sits in (dev) or was built from (packaged, same machine), else the copy bundled into the package.
function bridgeHome() {
  const ok = (dir) => dir && fs.existsSync(path.join(dir, "ollama-bridge.mjs"));
  if (ok(process.env.OLLAMA_BRIDGE_HOME)) return path.resolve(process.env.OLLAMA_BRIDGE_HOME);
  if (!app.isPackaged) return path.join(HERE, "..");
  try {
    const { home } = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, "bridge-home.json"), "utf8"));
    if (ok(home)) return home;
  } catch {}
  return path.join(process.resourcesPath, "bridge");
}

// A folder passed on the command line (`ollama-bridge desktop` passes its cwd) becomes the current project.
function projectArg() {
  const rest = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-"));
  return rest.map((a) => path.resolve(a)).find((a) => {
    try { return fs.statSync(a).isDirectory() && a !== path.resolve(HERE); } catch { return false; }
  }) || null;
}

// Apps started from the Dock/Finder don't get the shell's PATH, so node and claude from Homebrew would be missing.
function childEnv() {
  const env = { ...process.env };
  if (process.platform === "darwin") {
    const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin")];
    env.PATH = [...new Set([...(env.PATH || "").split(":"), ...extra].filter(Boolean))].join(":");
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function startServer(home, project) {
  return new Promise((resolve, reject) => {
    const args = [path.join(home, "ollama-bridge.mjs"), "ui", "--no-open", "--port", String(PORT)];
    if (!project) args.push("--no-current");
    const child = spawn("node", args, {
      cwd: project || os.homedir(), env: childEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let started = false;
    const onData = (chunk) => {
      out = (out + chunk).slice(-8000);
      const m = !started && out.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) {
        started = true;
        resolve({ child, url: m[1] });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      reject(err.code === "ENOENT" ? new Error("Node.js 18 or newer wasn't found on your PATH. Install it from https://nodejs.org and start the app again.") : err);
    });
    child.on("exit", (code) => {
      if (!started) return reject(new Error(`The ollama-bridge server stopped before it started (exit code ${code}).\n\n${out.trim()}`));
      if (!quitting) {
        dialog.showErrorBox("ollama-bridge", `The ollama-bridge server stopped (exit code ${code}).\n\n${out.trim().slice(-2000)}`);
        app.quit();
      }
    });
  });
}

// Also stops what the server started (claude -p runs) on Windows, where kill() only ends the one process.
function stopServer() {
  if (!server || server.child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.child.pid), "/T", "/F"], { windowsHide: true });
  else server.child.kill();
}

function loadBounds() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
}

function createWindow(url) {
  const { x, y, width = 1280, height = 860, maximized } = loadBounds();
  win = new BrowserWindow({
    x, y, width, height, minWidth: 720, minHeight: 480,
    title: "ollama-bridge",
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#161615" : "#f6f6f3",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  if (maximized) win.maximize();
  const origin = new URL(url).origin;
  const openOutside = (target) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
  };
  // The window only ever shows the bridge UI; links elsewhere open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openOutside(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, target) => {
    if (new URL(target).origin !== origin) {
      e.preventDefault();
      openOutside(target);
    }
  });
  win.once("ready-to-show", () => win.show());
  win.on("close", saveBounds);
  win.on("closed", () => { win = null; });
  win.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    // Only the clipboard (the page's copy buttons); no camera, notifications, etc.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "clipboard-sanitized-write"));
    try {
      server = await startServer(bridgeHome(), projectArg());
    } catch (err) {
      dialog.showErrorBox("ollama-bridge", err.message);
      return app.quit();
    }
    createWindow(server.url);
  });

  app.on("activate", () => {
    if (!win && server) createWindow(server.url);
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => { quitting = true; });
  app.on("will-quit", stopServer);
}
