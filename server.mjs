#!/usr/bin/env node
// Minimal MCP stdio server (newline-delimited JSON-RPC) exposing a local Ollama model to Claude Code.
import readline from "node:readline";
import { chat, listModels, loadLog, clearLog, logPath, projectDir, DEFAULT_MODEL, REASONING_MODEL } from "./lib.mjs";
import { planAndLog } from "./planner.mjs";
import { runAgentAndLog, AGENT_MODEL } from "./agent.mjs";

// These descriptions load into every Claude Code session on the machine, so keep them short.
const TOOLS = [
  {
    name: "ask_local",
    description:
      `Offload simple, self-contained work (snippets, summaries, test drafts, explanations) to a local model ` +
      `(${DEFAULT_MODEL}) to save usage. It can't read files: paste what it needs. Review its output.`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        model: { type: "string", description: `Other Ollama model; "${REASONING_MODEL}" for reasoning or a second opinion.` },
        use_history: { type: "boolean", description: "Send the shared project log (default true); false for one-offs." },
        plan: { type: "boolean", description: "Reply with a step-by-step plan instead of doing the task." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "local_task",
    description:
      `Hand a well-scoped, mechanical coding task to a local agent (${AGENT_MODEL}) that searches, reads and edits ` +
      `files in this project itself. Describe the task and name files; don't paste code. Returns a summary and ` +
      `diffstat; check with git diff. Slow; not for judgement-heavy or cross-cutting work.`,
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What to change and what done looks like." },
        files: { type: "array", items: { type: "string" }, description: "Paths likely involved." },
        model: { type: "string" },
        max_steps: { type: "number", description: "Tool-call rounds (default 30)." },
      },
      required: ["task"],
    },
  },
  {
    name: "local_history",
    description: "Recent messages in this project's shared log with the local model, including the user's own.",
    inputSchema: { type: "object", properties: { last: { type: "number", description: "Messages to return (default 10)." } } },
  },
  { name: "reset_local_history", description: "Clear this project's shared log.", inputSchema: { type: "object", properties: {} } },
  { name: "list_local_models", description: "List installed Ollama models.", inputSchema: { type: "object", properties: {} } },
];

// local_history output lands in Claude's context: keep it bounded.
const HISTORY_MSG_CHARS = 800;
const HISTORY_TOTAL_CHARS = 4000;
function historyText(messages) {
  const parts = [];
  let total = 0;
  for (const m of messages.slice().reverse()) {
    const body = m.content.length > HISTORY_MSG_CHARS
      ? `${m.content.slice(0, HISTORY_MSG_CHARS)}… (${m.content.length - HISTORY_MSG_CHARS} more chars cut)`
      : m.content;
    const part = `--- ${m.from}${m.model ? ` (${m.model})` : ""} @ ${m.ts}\n${body}`;
    if (total + part.length > HISTORY_TOTAL_CHARS && parts.length) {
      parts.unshift(`(${messages.length - parts.length} older messages not shown)`);
      break;
    }
    total += part.length;
    parts.unshift(part);
  }
  return parts.join("\n\n");
}

async function callTool(name, args = {}) {
  switch (name) {
    case "ask_local": {
      if (args.plan === true) {
        // Plans go through the step-by-step planner, which reads this project's code itself.
        const { reply, model } = await planAndLog({
          prompt: args.prompt,
          model: args.model || undefined,
          useHistory: args.use_history !== false,
        });
        return `[${model}, step-by-step plan]\n${reply}`;
      }
      const { reply, model } = await chat({
        from: "claude",
        prompt: args.prompt,
        model: args.model || undefined,
        useHistory: args.use_history !== false,
        plan: args.plan === true,
      });
      return `[${model}]\n${reply}`;
    }
    case "local_task": {
      if (!String(args.task || "").trim()) throw new Error("task is required");
      const { report } = await runAgentAndLog({
        task: String(args.task || ""),
        files: Array.isArray(args.files) ? args.files.map(String) : [],
        model: args.model || undefined,
        maxSteps: Number(args.max_steps) || undefined,
      });
      return report;
    }
    case "local_history": {
      const msgs = loadLog().messages.slice(-Math.min(Math.max(1, Number(args.last) || 10), 50));
      if (!msgs.length) return `No history yet for ${projectDir()}.`;
      return historyText(msgs);
    }
    case "reset_local_history": {
      clearLog();
      return `Cleared ${logPath()}.`;
    }
    case "list_local_models":
      return (await listModels()).join("\n");
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    let result;
    if (method === "initialize") {
      result = {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ollama-bridge", version: "1.0.0" },
      };
    } else if (method === "tools/list") {
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      try {
        const text = await callTool(params.name, params.arguments);
        result = { content: [{ type: "text", text }] };
      } catch (err) {
        result = { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    } else if (method === "ping") {
      result = {};
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    send({ jsonrpc: "2.0", id, result });
  } catch (err) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message } });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg);
});
