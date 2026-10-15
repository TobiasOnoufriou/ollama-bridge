#!/usr/bin/env node
// ollama-bridge: one command for everything.  Run `ollama-bridge help` for the list.
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { HERE } from "./config.mjs";
import { chat, loadLog, clearLog, logPath, projectDir, subId, defaultSub, listSessions, createSession, renameSession, deleteSession } from "./lib.mjs";
import { allProjects, addProject, removeProject, resolveUserPath } from "./projects.mjs";
import { launchIn, LAUNCH_TARGETS } from "./launch.mjs";
import { routePrompt } from "./router.mjs";
import { runClaude } from "./claude-run.mjs";
import { projectContext } from "./context.mjs";
import { planAndLog } from "./planner.mjs";
import { checkStatus, modelsWithRoles, effectiveConfig } from "./status.mjs";

const IS_WIN = process.platform === "win32";
const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c(1), dim = c(2), green = c(32), yellow = c(33), red = c(31), cyan = c(36);

// --sub <name> works with any command: it picks the project's sub-session, via the env var that lib.mjs and
// child processes (chat.mjs, claude-local) read.
const argv = process.argv.slice(2);
const subAt = argv.indexOf("--sub");
if (subAt !== -1) {
  try {
    process.env.OLLAMA_BRIDGE_SESSION = subId(argv[subAt + 1]);
  } catch (err) {
    console.error(red(err.message));
    process.exit(1);
  }
  argv.splice(subAt, 2);
}
const [cmd = "help", ...args] = argv;
const flag = (name) => args.includes(name);

const HELP = `${bold("ollama-bridge")} - Claude Code + local Ollama models with a shared conversation

${bold("Usage:")} ollama-bridge <command> [options]

  ${cyan("ui")} [--port N] [--no-open]   Open the web UI (projects, shared conversations, chat, status)
  ${cyan("ask")} "<prompt>"              Smart prompt: routes to the local model or Claude Code, then answers
                              --local / --claude to force a side, --model, --effort, --fast, --plan
  ${cyan("task")} "<what to change>"     Local agent edits this folder's files itself (--model name)
  ${cyan("chat")} [model]                Chat with a local model in this folder's shared log
  ${cyan("claude")} [claude args]        Run Claude Code on the local model (same as claude-local)
  ${cyan("status")}                      Check that everything is installed and wired up
  ${cyan("models")}                      List installed models and the role each one plays
  ${cyan("history")} [N]                 Show the last N messages (default 20) of this folder's log
  ${cyan("projects")}                    List your projects (added folders and ones with a shared log)
  ${cyan("add")} [folder]                 Add a folder as a project (default: this folder)
  ${cyan("remove")} [folder]              Remove a project from the list (--delete-history to also clear it)
  ${cyan("open")} <what> [folder]         Open a new window in a project folder. <what> is one of:
                              claude (Claude Code), local (Claude Code on the local model),
                              terminal (a plain shell) or folder (the file manager)
                              --model <name>  Claude model (fable, opus, sonnet, haiku) or
                                              Ollama model for local
                              --plan          start in plan mode (or --mode acceptEdits|auto)
                              --effort <level> low, medium, high, xhigh or max
                              --fast          fast mode (Opus only, billed to usage credits)
  ${cyan("issues")} [folder]              List the GitHub issues of the folder's repo (--closed, --all, --search text)
  ${cyan("issue")} <number> [folder]      New Claude Code window working on that issue, on a new branch
                              --local for Claude Code on the local model, --no-branch to stay on this one,
                              and the same --model, --plan, --effort, --fast as open
  ${cyan("handoff")}                     Summarise this folder's latest Claude Code session with the local model,
                              for pasting into a new (cheaper) session. --session <id>, --model, --no-copy
  ${cyan("sessions")}                    List this folder's sub-sessions (separate conversations, each with its own
                              Claude session). ${cyan("sessions add")} <name>, ${cyan("sessions rename")} <id> <name>,
                              ${cyan("sessions remove")} <id>
  ${cyan("reset")} [--yes]               Clear this folder's shared log
  ${cyan("install")} [--yes]             Run the installer (safe to re-run)
  ${cyan("help")}                        Show this help

  --sub <id> before or after any command uses that sub-session instead of the main conversation
  (ask, chat, history, reset, open). Same as setting OLLAMA_BRIDGE_SESSION.
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

  case "ask": {
    const optArg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : "");
    const modelArg = optArg("--model");
    const prompt = args.filter((a, i) => !a.startsWith("--") && !["--model", "--effort"].includes(args[i - 1])).join(" ").trim();
    if (!prompt) {
      console.error(red('Usage: ollama-bridge ask "<prompt>" [--local | --claude] [--model name] [--plan]'));
      process.exit(1);
    }
    const plan = flag("--plan");
    const route = flag("--local") ? { to: "local", reason: "you chose local", by: "you" }
      : flag("--claude") ? { to: "claude", reason: "you chose Claude", by: "you" }
      : await routePrompt(prompt, { dir: projectDir() }).then((r) => ({ to: r.route, reason: r.reason, by: r.by, effort: r.effort }));
    console.log(dim(`-> ${route.to === "local" ? "local model" : "Claude Code"}: ${route.reason}${plan ? " (plan mode)" : ""}\n`));
    try {
      if (route.to === "local") {
        if (plan && !flag("--quick")) {
          const out = await planAndLog({ prompt, model: modelArg || undefined, meta: { route }, onProgress: (t) => console.log(dim(`  … ${t}`)) });
          console.log(`${bold(yellow(out.model))}\n${out.reply}`);
          break;
        }
        const context = plan ? await projectContext(projectDir(), prompt, { model: modelArg || undefined }).catch(() => null) : null;
        if (context?.sources.length) console.log(dim(`(read ${context.sources.length} parts of the project)`));
        const { reply, model } = await chat({ from: "human", prompt, model: modelArg || undefined, plan, meta: { route }, context });
        console.log(`${bold(yellow(model))}\n${reply}`);
      } else {
        const out = await runClaude({ dir: projectDir(), prompt, model: modelArg, mode: plan ? "plan" : "", effort: optArg("--effort"), autoEffort: route.effort, fast: flag("--fast"), meta: { route }, onProgress: (t) => console.log(dim(`  … ${t}`)) });
        console.log(`${bold(cyan(out.model))}${dim(` ${(out.ms / 1000).toFixed(0)}s`)}\n${out.reply}`);
        if (out.changes.length) console.log(dim(`\nChanged: ${out.changes.map((c) => `${c.file} (+${c.added} -${c.removed})`).join(", ")}`));
        if (out.isError) process.exit(1);
      }
    } catch (err) {
      console.error(red(err.message));
      process.exit(1);
    }
    break;
  }

  case "task": {
    const i = args.indexOf("--model");
    const task = args.filter((a, j) => !a.startsWith("--") && args[j - 1] !== "--model").join(" ").trim();
    if (!task) {
      console.error(red('Usage: ollama-bridge task "<what to change>" [--model name]'));
      process.exit(1);
    }
    const { runAgentAndLog } = await import("./agent.mjs");
    try {
      const out = await runAgentAndLog({ from: "human", task, model: i !== -1 ? args[i + 1] : undefined, onProgress: (t) => console.log(dim(`  … ${t}`)) });
      console.log(`\n${out.report}`);
      if (out.errors.length) process.exit(1);
    } catch (err) {
      console.error(red(err.message));
      process.exit(1);
    }
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
    if (!msgs.length) console.log(dim(`No shared history yet for ${projectDir()}${defaultSub() ? ` (session ${defaultSub()})` : ""}.`));
    else printMessages(msgs);
    break;
  }

  case "sessions": {
    // ollama-bridge sessions [add <name> | rename <id> <name> | remove <id>]
    const [action = "list", id, ...rest] = args;
    const dir = projectDir();
    try {
      if (action === "add") {
        const name = [id, ...rest].join(" ");
        const sub = createSession(dir, name);
        console.log(green(`Created session ${sub}.`) + dim(` Use it with: ollama-bridge --sub ${sub} chat`));
      } else if (action === "rename") {
        renameSession(dir, id, rest.join(" "));
        console.log(green(`Renamed ${id}.`));
      } else if (action === "remove" || action === "delete") {
        deleteSession(dir, id);
        console.log(green(`Deleted session ${id}.`));
      } else if (action === "list") {
        const current = defaultSub();
        for (const s of listSessions(dir)) {
          const when = s.updated ? `last ${new Date(s.updated).toLocaleString()}` : "no messages yet";
          const label = s.id ? `${s.id}${s.name !== s.id ? `  ${dim(s.name)}` : ""}` : "main";
          console.log(`  ${s.id === current ? green("*") : " "} ${label}\n      ${dim(`${s.messages} messages, ${when}`)}`);
        }
      } else {
        console.error(red("Usage: ollama-bridge sessions [add <name> | rename <id> <name> | remove <id>]"));
        process.exit(1);
      }
    } catch (err) {
      console.error(red(err.message));
      process.exit(1);
    }
    break;
  }

  case "projects": {
    for (const p of allProjects()) {
      const when = p.updated ? `last ${new Date(p.updated).toLocaleString()}` : "no messages yet";
      const tags = [p.current && "here", !p.exists && red("missing")].filter(Boolean).join(", ");
      console.log(`  ${p.project}${tags ? `  (${tags})` : ""}\n    ${dim(`${p.messages} messages, ${when}${p.sessions ? `, ${p.sessions} sub-session${p.sessions === 1 ? "" : "s"}` : ""}`)}`);
    }
    break;
  }

  case "add":
    try {
      console.log(green(`Added ${addProject(args[0] || ".")}`));
    } catch (err) {
      console.error(red(err.message));
      process.exit(1);
    }
    break;

  case "remove": {
    const deleteHistory = flag("--delete-history");
    const dir = removeProject(args.find((a) => !a.startsWith("--")) || ".", { deleteHistory });
    console.log(green(`Removed ${dir} from the list${deleteHistory ? " and deleted its history" : ""}`));
    break;
  }

  case "open": {
    // ollama-bridge open <what> [folder] [--model name] [--plan | --mode plan|acceptEdits|auto]
    const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : "");
    const positional = args.filter((a, i) => !a.startsWith("--") && !["--model", "--mode", "--effort"].includes(args[i - 1]));
    const [what, folder = "."] = positional;
    if (!(what in LAUNCH_TARGETS)) {
      console.error(red(`Usage: ollama-bridge open <${Object.keys(LAUNCH_TARGETS).join("|")}> [folder] [--model name] [--plan]`));
      process.exit(1);
    }
    try {
      const dir = resolveUserPath(folder);
      await launchIn(dir, what, { model: opt("--model"), mode: flag("--plan") ? "plan" : opt("--mode"), effort: opt("--effort"), fast: flag("--fast"), sub: defaultSub() });
      console.log(green(`Opened ${LAUNCH_TARGETS[what]} in ${dir}`));
    } catch (err) {
      console.error(red(err.message));
      process.exit(1);
    }
    break;
  }

  case "issues": {
    // ollama-bridge issues [folder] [--closed | --all] [--search text]
    const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : "");
    const folder = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--search") || ".";
    const { repoFor, listIssues } = await import("./issues.mjs");
    try {
      const repo = await repoFor(resolveUserPath(folder));
      const state = flag("--all") ? "all" : flag("--closed") ? "closed" : "open";
      const issues = await listIssues(repo, { state, search: opt("--search") });
      if (!issues.length) console.log(dim(`No ${state === "all" ? "" : `${state} `}issues in ${repo}.`));
      for (const i of issues) {
        const labels = i.labels.length ? ` ${dim(`[${i.labels.join(", ")}]`)}` : "";
        const closed = i.state === "closed" ? ` ${dim("(closed)")}` : "";
        console.log(`  ${cyan(`#${i.number}`.padStart(6))}  ${i.title}${labels}${closed}`);
      }
      if (issues.length) console.log(dim(`
${repo}. Start a session on one with: ollama-bridge issue <number>`));
    } catch (err) {
      console.error(red(err.message));
      process.exit(1);
    }
    break;
  }

  case "issue": {
    // ollama-bridge issue <number> [folder] [--local] [--no-branch] [--model name] [--plan | --mode m] [--effort e] [--fast]
    const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : "");
    const positional = args.filter((a, i) => !a.startsWith("--") && !["--model", "--mode", "--effort"].includes(args[i - 1]));
    const [number, folder = "."] = positional;
    if (!/^#?d+$/.test(number || "")) {
      console.error(red("Usage: ollama-bridge issue <number> [folder] [--local] [--no-branch] [--model name] [--plan]"));
      process.exit(1);
    }
    const { issueSession } = await import("./issues.mjs");
    try {
      const dir = resolveUserPath(folder);
      const what = flag("--local") ? "local" : "claude";
      const out = await issueSession(dir, number.replace("#", ""), { branch: !flag("--no-branch") });
      await launchIn(dir, what, { model: opt("--model"), mode: flag("--plan") ? "plan" : opt("--mode"), effort: opt("--effort"), fast: flag("--fast"), session: out.session, sub: defaultSub() });
      console.log(green(`Opened ${LAUNCH_TARGETS[what]} on ${out.repo}#${out.issue.number}: ${out.issue.title}`));
      console.log(dim(`Issue text: ${out.file}${out.branch ? `
It will work on branch ${out.branch}` : ""}`));
    } catch (err) {
      console.error(red(err.message));
      process.exit(1);
    }
    break;
  }

  case "handoff": {
    // ollama-bridge handoff [--session id] [--model name] [--no-copy]
    const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : "");
    const { handoff, copyToClipboard, describeSize } = await import("./handoff.mjs");
    try {
      console.log(dim("Reading the latest Claude Code session in this folder and summarising it locally…"));
      const out = await handoff({ dir: projectDir(), session: opt("--session"), model: opt("--model") || undefined });
      console.log(dim(`Session ${path.basename(out.file, ".jsonl")} (${describeSize(out.size)}), note by ${out.model}:\n`));
      console.log(out.note);
      const copied = !flag("--no-copy") && copyToClipboard(out.note);
      console.log(`\n${green(copied ? "Copied to the clipboard." : "Copy the note above.")} Start a new session (${cyan("/clear")} in Claude Code, ` +
        `or a new window) and paste it as your first message.`);
    } catch (err) {
      console.error(red(err.message));
      process.exit(1);
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
    clearLog();
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
