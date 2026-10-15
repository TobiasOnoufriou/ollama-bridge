#!/usr/bin/env node
// One-command setup for ollama-bridge on Windows, macOS and Linux:  node install.mjs [--yes]
// Safe to re-run: every step checks what is already in place and only changes what is missing.
//   --yes   answer yes to every question (downloads, PATH and shell config edits)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { HERE, CONFIG_FILE, EXAMPLE_FILE, loadConfig } from "./config.mjs";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const YES = process.argv.includes("--yes") || process.argv.includes("-y");
const INTERACTIVE = process.stdin.isTTY && process.stdout.isTTY;
const HOME = os.homedir();
const MARK_START = "<!-- ollama-bridge:start -->";
const MARK_END = "<!-- ollama-bridge:end -->";

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1), green = c(32), yellow = c(33), red = c(31), cyan = c(36);
const step = (s) => console.log(`\n${bold(cyan(`== ${s}`))}`);
const ok = (s) => console.log(`  ${green("ok")}   ${s}`);
const warn = (s) => console.log(`  ${yellow("!!")}   ${s}`);
const info = (s) => console.log(`       ${s}`);

let rl;
async function ask(question, def = true) {
  if (YES) return true;
  if (!INTERACTIVE) {
    warn(`${question} -> skipped (not interactive; re-run in a terminal or with --yes)`);
    return false;
  }
  rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`  ${bold("??")}   ${question} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  return answer ? answer.startsWith("y") : def;
}

// Run a command; on Windows go through the shell so .cmd shims (npm-installed claude) resolve.
function run(cmd, args = [], { inherit = false } = {}) {
  const opts = { encoding: "utf8", stdio: inherit ? "inherit" : "pipe" };
  const r = IS_WIN
    ? spawnSync([cmd, ...args].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" "), {
        ...opts,
        shell: true,
      })
    : spawnSync(cmd, args, opts);
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim(), status: r.status };
}

const has = (cmd) => run(cmd, ["--version"]).ok;
const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;

// ---------------------------------------------------------------- 1. prerequisites
async function checkPrereqs() {
  step("Checking prerequisites");
  let missing = false;

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 18) ok(`Node ${process.versions.node}`);
  else {
    warn(`Node ${process.versions.node} is too old; ollama-bridge needs Node 18+.`);
    missing = true;
  }

  if (has("ollama")) ok(run("ollama", ["--version"]).out.split("\n").pop());
  else {
    warn("Ollama is not installed.");
    info(
      IS_WIN ? "Install it with: winget install Ollama.Ollama"
      : IS_MAC ? "Install it from https://ollama.com/download (or: brew install ollama)"
      : "Install it with: curl -fsSL https://ollama.com/install.sh | sh",
    );
    missing = true;
  }

  if (has("claude")) ok(`Claude Code ${run("claude", ["--version"]).out.split("\n")[0]}`);
  else {
    warn("The Claude Code CLI is not installed.");
    info(
      IS_WIN ? "Install it with: winget install Anthropic.ClaudeCode"
      : "Install it with: curl -fsSL https://claude.ai/install.sh | bash",
    );
    missing = true;
  }

  if (missing) {
    console.log(`\n${red("Install the missing pieces above, open a new terminal, then run node install.mjs again.")}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 2. hardware + config
function detectHardware() {
  const ramGB = os.totalmem() / 1024 ** 3;
  if (IS_MAC) {
    const mem = Number(run("sysctl", ["-n", "hw.memsize"]).out) || os.totalmem();
    const memGB = mem / 1024 ** 3;
    // Apple Silicon shares memory with the GPU (macOS lets it use roughly 2/3); Intel Macs run models on CPU.
    const appleSilicon = process.arch === "arm64";
    return {
      label: `${memGB.toFixed(0)} GB unified memory${appleSilicon ? " (Apple Silicon)" : " (Intel, CPU only)"}`,
      gpuGB: appleSilicon ? memGB * 0.67 : 0,
      totalGB: memGB,
    };
  }
  const smi = run("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
  const vramGB = smi.ok ? Math.max(...smi.out.split(/\r?\n/).map((l) => Number(l) || 0)) / 1024 : 0;
  return {
    label: `${smi.ok ? `${vramGB.toFixed(0)} GB NVIDIA VRAM` : "no NVIDIA GPU detected"}, ${ramGB.toFixed(0)} GB RAM`,
    gpuGB: vramGB,
    totalGB: vramGB + ramGB,
  };
}

// Models that fit the machine. The 14b models need ~9 GB on the GPU; qwen3.6 (23 GB) can spill into system RAM.
function suggestModels({ gpuGB, totalGB }) {
  const big = gpuGB >= 11, mid = gpuGB >= 6 || totalGB >= 16;
  return {
    bridgeModel: big ? "qwen2.5-coder:14b" : mid ? "qwen2.5-coder:7b" : "qwen2.5-coder:3b",
    reasoningModel: big ? "deepseek-r1:14b" : mid ? "deepseek-r1:8b" : "deepseek-r1:1.5b",
    ...(totalGB >= 40
      ? { claudeLocalModel: "qwen3.6", claudeLocalCtx: 65536 }
      : totalGB >= 16
        ? { claudeLocalModel: "qwen3:8b", claudeLocalCtx: 32768 }
        : { claudeLocalModel: "qwen3:4b", claudeLocalCtx: 16384 }),
  };
}

async function setupConfig() {
  step("Configuration");
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.copyFileSync(EXAMPLE_FILE, CONFIG_FILE);
    ok(`Created ${CONFIG_FILE} from config.example.json`);
  } else ok(`Using ${CONFIG_FILE}`);

  const hw = detectHardware();
  info(`Hardware: ${hw.label}`);
  const current = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const cfg = loadConfig();
  const suggested = suggestModels(hw);
  const changes = Object.entries(suggested).filter(([k, v]) => cfg[k] !== v && rank(k, v) < rank(k, cfg[k]));
  if (changes.length) {
    warn("This machine looks too small for some configured models. Suggested:");
    for (const [k, v] of changes) info(`${k}: ${cfg[k]} -> ${v}`);
    if (await ask("Switch config.json to the suggested models?")) {
      Object.assign(current, Object.fromEntries(changes));
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2) + "\n");
      ok("Updated config.json");
    }
  }
  const final = loadConfig();
  for (const k of ["bridgeModel", "reasoningModel", "claudeLocalModel", "claudeLocalCtx", "bridgeNumCtx"]) info(`${k}: ${final[k]}`);
  return final;
}

// Only ever suggest going smaller: a model the user picked that isn't in our ladder is left alone.
const LADDERS = {
  bridgeModel: ["qwen2.5-coder:3b", "qwen2.5-coder:7b", "qwen2.5-coder:14b"],
  reasoningModel: ["deepseek-r1:1.5b", "deepseek-r1:8b", "deepseek-r1:14b"],
  claudeLocalModel: ["qwen3:4b", "qwen3:8b", "qwen3.6"],
  claudeLocalCtx: [16384, 32768, 65536],
};
function rank(key, value) {
  const i = LADDERS[key].indexOf(value);
  return i === -1 ? -Infinity : i;
}

// ---------------------------------------------------------------- 3. models
async function ollamaUp(url) {
  try {
    return (await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

async function installedModels(url) {
  const data = await (await fetch(`${url}/api/tags`)).json();
  return new Set(data.models.map((m) => m.name));
}

const withTag = (m) => (m.includes(":") ? m : `${m}:latest`);

// Best-effort download size from the Ollama registry, so we can say how big a pull is.
async function downloadSize(model) {
  const [name, tag = "latest"] = model.split(":");
  const repo = name.includes("/") ? name : `library/${name}`;
  try {
    const res = await fetch(`https://registry.ollama.ai/v2/${repo}/manifests/${tag}`, {
      headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const m = await res.json();
    return m.layers.reduce((sum, l) => sum + l.size, 0);
  } catch {
    return null;
  }
}

async function setupModels(cfg) {
  step("Ollama models");
  if (!(await ollamaUp(cfg.ollamaUrl))) {
    warn(`Ollama isn't answering at ${cfg.ollamaUrl}. Start the Ollama app (or run 'ollama serve'), then re-run.`);
    return false;
  }
  let installed = await installedModels(cfg.ollamaUrl);
  const wanted = [...new Set([cfg.bridgeModel, cfg.reasoningModel, cfg.claudeLocalModel])];
  for (const model of wanted) {
    if (installed.has(withTag(model))) {
      ok(`${model} already installed`);
      continue;
    }
    const size = await downloadSize(model);
    if (!(await ask(`Download ${model}${size ? ` (${gb(size)})` : ""}?`))) continue;
    if (!run("ollama", ["pull", model], { inherit: true }).ok) warn(`ollama pull ${model} failed`);
  }

  installed = await installedModels(cfg.ollamaUrl);
  if (!installed.has(withTag(cfg.claudeLocalModel))) {
    warn(`${cfg.claudeLocalModel} isn't installed, so ${cfg.claudeLocalVariant} can't be created yet.`);
    return true;
  }
  const modelfile = path.join(HERE, "models", `${cfg.claudeLocalVariant}.Modelfile`);
  fs.mkdirSync(path.dirname(modelfile), { recursive: true });
  fs.writeFileSync(modelfile, `FROM ${cfg.claudeLocalModel}\nPARAMETER num_ctx ${cfg.claudeLocalCtx}\n`);
  const r = run("ollama", ["create", cfg.claudeLocalVariant, "-f", modelfile]);
  if (r.ok) ok(`Created ${cfg.claudeLocalVariant} (${cfg.claudeLocalModel} with ${cfg.claudeLocalCtx}-token context)`);
  else warn(`ollama create ${cfg.claudeLocalVariant} failed:\n${r.out}`);
  return true;
}

// ---------------------------------------------------------------- 4. MCP registration
function registerMcp() {
  step("Registering the bridge with Claude Code");
  const server = path.join(HERE, "server.mjs").replace(/\\/g, "/");
  if (run("claude", ["mcp", "get", "ollama-bridge"]).ok) {
    const r = run("claude", ["mcp", "remove", "ollama-bridge", "-s", "user"]);
    if (r.ok) info("Removed the existing ollama-bridge registration");
    else warn(`Couldn't remove the existing registration (it may be in another scope):\n${r.out}`);
  }
  const r = run("claude", ["mcp", "add", "--scope", "user", "ollama-bridge", "--", "node", server]);
  if (r.ok) ok(`ollama-bridge -> node ${server}`);
  else warn(`claude mcp add failed:\n${r.out}`);
}

// ---------------------------------------------------------------- 5. launchers on PATH
async function setupPathWindows() {
  const ps = (script) => run("powershell", ["-NoProfile", "-Command", script]);
  const userPath = ps("[Environment]::GetEnvironmentVariable('Path','User')").out;
  const norm = (p) => path.resolve(p).toLowerCase().replace(/\\+$/, "");
  if (userPath.split(";").filter(Boolean).some((p) => norm(p) === norm(HERE))) {
    ok(`${HERE} is already on your user PATH`);
    return;
  }
  if (!(await ask(`Add ${HERE} to your user PATH (for claude-local and local-chat)?`))) return;
  // Pass the folder through an env var so PowerShell quoting can't mangle it.
  process.env.OLLAMA_BRIDGE_DIR = HERE;
  const r = ps(
    "$p = [Environment]::GetEnvironmentVariable('Path','User'); " +
      "$n = if ($p) { $p.TrimEnd(';') + ';' + $env:OLLAMA_BRIDGE_DIR } else { $env:OLLAMA_BRIDGE_DIR }; " +
      "[Environment]::SetEnvironmentVariable('Path', $n, 'User')",
  );
  if (r.ok) ok("Added to user PATH (open a new terminal to pick it up)");
  else warn(`Couldn't update PATH:\n${r.out}`);
}

async function setupPathUnix() {
  const bin = path.join(HOME, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["claude-local", "local-chat"]) {
    const target = path.join(HERE, name);
    fs.chmodSync(target, 0o755);
    const link = path.join(bin, name);
    let current = null;
    try {
      current = fs.readlinkSync(link);
    } catch {}
    if (current === target) {
      ok(`${link} -> ${target}`);
      continue;
    }
    if (current !== null || fs.existsSync(link)) fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link);
    ok(`Linked ${link} -> ${target}`);
  }

  if ((process.env.PATH || "").split(":").some((p) => path.resolve(p) === bin)) {
    ok(`${bin} is on your PATH`);
    return;
  }
  const shell = path.basename(process.env.SHELL || (IS_MAC ? "zsh" : "bash"));
  const rc = path.join(HOME, shell === "zsh" ? ".zshrc" : shell === "fish" ? ".config/fish/config.fish" : ".bashrc");
  const line =
    shell === "fish" ? `fish_add_path $HOME/.local/bin  # ollama-bridge` : `export PATH="$HOME/.local/bin:$PATH"  # ollama-bridge`;
  const existing = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : "";
  if (existing.includes("# ollama-bridge")) {
    ok(`${rc} already adds ${bin} to PATH (open a new terminal to pick it up)`);
    return;
  }
  warn(`${bin} isn't on your PATH.`);
  if (!(await ask(`Append this line to ${rc}?\n         ${line}\n      `))) {
    info(`Add ${bin} to your PATH yourself to use claude-local and local-chat.`);
    return;
  }
  fs.mkdirSync(path.dirname(rc), { recursive: true });
  fs.appendFileSync(rc, `${existing && !existing.endsWith("\n") ? "\n" : ""}${line}\n`);
  ok(`Updated ${rc} (open a new terminal to pick it up)`);
}

async function setupPath() {
  step("Putting claude-local and local-chat on PATH");
  if (IS_WIN) await setupPathWindows();
  else await setupPathUnix();
}

// ---------------------------------------------------------------- 6. ~/.claude/CLAUDE.md
function claudeMdBlock(cfg) {
  return `${MARK_START}
## Local models (ollama-bridge)

The \`ollama-bridge\` MCP server gives you \`ask_local\`, which sends a prompt to a local model in Ollama.
- Offload simple, well-defined work to it to save usage: boilerplate, small self-contained functions,
  summaries, test drafts, explanations, renaming/reformatting. Paste in any code it needs (it can't read files),
  use \`use_history: false\` for one-off tasks, and always review its output before using it.
- For reasoning-heavy questions, debugging logic or a second opinion, call it with \`model: "${cfg.reasoningModel}"\`
  (slower and verbose). The default model (${cfg.bridgeModel}) is for quick code tasks.
- Keep anything needing judgement across the codebase, multi-file edits or tool use yourself.
- \`local_history\` shows the shared log, including messages the user sent the local model with \`local-chat\`.
${MARK_END}`;
}

function setupClaudeMd(cfg) {
  step("Updating ~/.claude/CLAUDE.md");
  const file = path.join(HOME, ".claude", "CLAUDE.md");
  const block = claudeMdBlock(cfg);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const start = existing.indexOf(MARK_START), end = existing.indexOf(MARK_END);
  let next;
  if (start !== -1 && end > start) next = existing.slice(0, start) + block + existing.slice(end + MARK_END.length);
  else next = existing + (existing && !existing.endsWith("\n") ? "\n\n" : existing ? "\n" : "") + block + "\n";
  if (next === existing) return ok(`${file} is up to date`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  ok(`${start !== -1 ? "Updated" : "Added"} the ollama-bridge section in ${file}`);
}

// ---------------------------------------------------------------- main
console.log(bold(`ollama-bridge installer (${process.platform}, ${HERE})`));
try {
  await checkPrereqs();
  const cfg = await setupConfig();
  await setupModels(cfg);
  registerMcp();
  await setupPath();
  setupClaudeMd(cfg);
  console.log(`\n${bold(green("Done."))} Open a new terminal, then try:`);
  info("claude            (the bridge's ask_local tool is available in every project)");
  info("local-chat        (chat with the local model in this folder's shared log)");
  info(`claude-local      (Claude Code itself on ${cfg.claudeLocalVariant})`);
} finally {
  rl?.close();
}
