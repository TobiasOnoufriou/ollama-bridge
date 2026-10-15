#!/usr/bin/env node
// Chat with the local model yourself, in the same per-project log Claude uses.
// Run from a project folder:  node C:\Users\space\tools\ollama-bridge\chat.mjs [model]
import readline from "node:readline/promises";
import { chat, loadLog, logPath, DEFAULT_MODEL } from "./lib.mjs";

const model = process.argv[2] || DEFAULT_MODEL;
const log = loadLog();
console.log(`Shared log: ${logPath()} (${log.messages.length} messages)`);
console.log(`Model: ${model}. Type /history to see recent messages, /exit to quit.\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const line = (await rl.question("you> ")).trim();
  if (!line) continue;
  if (line === "/exit") break;
  if (line === "/history") {
    for (const m of loadLog().messages.slice(-10)) console.log(`\n[${m.from}] ${m.content}`);
    console.log();
    continue;
  }
  try {
    const { reply } = await chat({ from: "human", prompt: line, model });
    console.log(`\n${model}> ${reply}\n`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
}
rl.close();
