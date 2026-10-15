#!/usr/bin/env node
// ollama-bridge: one command for everything.  Run `ollama-bridge help` for the list.
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { HERE } from "./config.mjs";
import { loadLog, saveLog, logPath, projectDir, listProjects } from "./lib.mjs";
import { checkStatus, modelsWithRoles, effectiveConfig } from "./status.mjs";

const IS_WIN = process.platform === "win32";
const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c(1), dim = c(2), green = c(32), yellow = c(33), red = c(31), cyan = c(36);

const [cmd = "help", ...args] = process.argv.slice(2);
const flag = (name) => args.includes(name);

const HELP = `${bold("ollama-bridge")} - Claude Code + local Ollama models with a shared conversation

${bold("Usage:")} ollama-bridge <command> [options]

  ${cyan("ui")} [--port N] [--no-open]   Open the web UI (projects, shared conversations, chat, status)
  ${cyan("chat")} [model]                Chat with a local model in this folder's shared log
  ${cyan("claude")} [claude args]        Run Claude Code on the local model (same as claude-local)
  ${cyan("status")}                      Check that everything is installed and wired up
  ${cyan("models")}                      List installed models and the role each one plays
  ${cyan("history")} [N]                 Show the last N messages (default 20) of this folder's log
  ${cyan("projects")}                    List every project that has a shared log
  ${cyan("reset")} [--yes]               Clear this folder's shared log
  ${cyan("install")} [--yes]             Run the installer (safe to re-run)
  ${cyan("help")}                        Show this help
`;

function run(file, fileArgs) {
  const r = spawnSync(file, fileArgs, { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

function printMessages(msgs) {
  for (const m of msgs) {
    const who = m.from === "claude" ? cyan("Claude") : m.from === "human" ? green("You") : yellow(m.model || "local");
    console.log(`${bold(who)} ${dim(new Date(m.ts).toLocaleString())}\n${m.content}\n`);
  }
}

switch (cmd) {
  case "ui": {
    const { startUi } = await import("./ui-server.mjs");
    const i = args.indexOf("--port");
    await startUi({ port: i !== -1 ? Number(args[i + 1]) : undefined, open: !flag("--no-open") });
    break;
  }

  case "chat":
    run(process.execPath, [path.join(HERE, "chat.mjs"), ...args]);
    break;

  case "claude":
    if (IS_WIN) run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "claude-local.ps1"), ...args]);
    else run(path.join(HERE, "claude-local"), args);
    break;

  case "status":
  case "doctor": {
    const { checks, allOk } = await checkStatus();
    for (const ch of checks) {
      console.log(`  ${ch.ok ? green("ok") : red("!!")}  ${ch.label.padEnd(28)} ${dim(ch.detail)}`);
      if (!ch.ok) console.log(`      ${yellow("fix:")} ${ch.fix}`);
    }
    console.log(allOk ? `\n${green("Everything looks good.")}` : `\n${yellow("Some checks failed; see the fixes above.")}`);
    process.exit(allOk ? 0 : 1);
  }

  case "models": {
    try {
      for (const m of await modelsWithRoles()) {
        console.log(`  ${m.name.padEnd(30)} ${dim(`${m.sizeGB} GB`.padStart(8))}  ${m.role ? cyan(m.role) : ""}`);
      }
    } catch {
      console.error(red(`Ollama isn't answering at ${effectiveConfig().ollamaUrl}. Start it and try again.`));
      process.exit(1);
    }
    break;
  }

  case "history": {
    const msgs = loadLog().messages.slice(-(Number(args[0]) || 20));
    if (!msgs.length) console.log(dim(`No shared history yet for ${projectDir()}.`));
    else printMessages(msgs);
    break;
  }

  case "projects": {
    const projects = listProjects();
    if (!projects.length) console.log(dim("No shared logs yet."));
    for (const p of projects) {
      const when = p.updated ? new Date(p.updated).toLocaleString() : "never";
      console.log(`  ${p.project}\n    ${dim(`${p.messages} messages, last ${when}`)}`);
    }
    break;
  }

  case "reset": {
    const n = loadLog().messages.length;
    if (!n) {
      console.log(dim(`Nothing to clear for ${projectDir()}.`));
      break;
    }
    if (!flag("--yes") && !flag("-y")) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const a = (await rl.question(`Clear ${n} messages for ${projectDir()}? [y/N] `)).trim().toLowerCase();
      rl.close();
      if (!a.startsWith("y")) break;
    }
    saveLog({ project: projectDir(), messages: [] });
    console.log(green(`Cleared ${logPath()}`));
    break;
  }

  case "install":
    run(process.execPath, [path.join(HERE, "install.mjs"), ...args]);
    break;

  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;

  default:
    console.error(red(`Unknown command: ${cmd}\n`));
    console.log(HELP);
    process.exit(1);
}
