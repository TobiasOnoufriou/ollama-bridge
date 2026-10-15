#!/usr/bin/env node
// Chat with the local model yourself, in the same per-project log Claude uses.
// Run from a project folder:  local-chat [model]   (or: node /path/to/ollama-bridge/chat.mjs [model])
import readline from "node:readline/promises";
import { chat, loadLog, logPath, projectDir, DEFAULT_MODEL } from "./lib.mjs";
import { projectContext } from "./context.mjs";

const model = process.argv.slice(2).find((a) => !a.startsWith("--")) || DEFAULT_MODEL;
const log = loadLog();
console.log(`Shared log: ${logPath()} (${log.messages.length} messages)`);
console.log(`Model: ${model}. Type /plan to toggle plan mode, /history to see recent messages, /exit to quit.\n`);
let plan = process.argv.includes("--plan");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const line = (await rl.question(plan ? "you (plan)> " : "you> ")).trim();
  if (!line) continue;
  if (line === "/exit") break;
  if (line === "/plan") {
    plan = !plan;
    console.log(plan ? "Plan mode on: replies are step-by-step plans, not implementations.\n" : "Plan mode off.\n");
    continue;
  }
  if (line === "/history") {
    for (const m of loadLog().messages.slice(-10)) console.log(`\n[${m.from}] ${m.content}`);
    console.log();
    continue;
  }
  try {
    // Plans get relevant project code attached, so the model uses real file and function names.
    let context = null;
    if (plan) {
      context = await projectContext(projectDir(), line, { model }).catch(() => null);
      if (context?.sources.length) console.log(`(read ${context.sources.length} parts of the project: ${[...new Set(context.sources.map((s) => s.path))].slice(0, 6).join(", ")})`);
    }
    const { reply } = await chat({ from: "human", prompt: line, model, plan, context });
    console.log(`\n${model}> ${reply}\n`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
}
rl.close();
