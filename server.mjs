#!/usr/bin/env node
// Minimal MCP stdio server (newline-delimited JSON-RPC) exposing a local Ollama model to Claude Code.
import readline from "node:readline";
import { chat, listModels, loadLog, saveLog, logPath, projectDir, DEFAULT_MODEL } from "./lib.mjs";

const TOOLS = [
  {
    name: "ask_local",
    description:
      `Send a message to the local LLM running in Ollama (default model: ${DEFAULT_MODEL}). ` +
      "Use it to offload simple, well-defined work (boilerplate, small functions, summaries, test drafts, " +
      "explanations, second opinions) to save Claude usage. The local model shares a per-project conversation " +
      "log with Claude and the human, so it remembers earlier exchanges. It cannot read files: paste in any code " +
      "it needs. Always review its output before using it.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The message or task for the local model, including any code it needs." },
        model: {
          type: "string",
          description:
            "Optional Ollama model to use instead of the default. Use \"deepseek-r1:14b\" for reasoning-heavy " +
            "questions, debugging logic or second opinions (slower, verbose); keep the default for quick code tasks.",
        },
        use_history: {
          type: "boolean",
          description: "Include the shared conversation history (default true). Set false for one-off tasks to keep it fast.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "local_history",
    description: "Read the shared conversation log with the local LLM for this project, including messages the human sent it directly.",
    inputSchema: {
      type: "object",
      properties: { last: { type: "number", description: "Only return the last N messages (default 20)." } },
    },
  },
  {
    name: "reset_local_history",
    description: "Clear the shared conversation log with the local LLM for this project.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_local_models",
    description: "List the models installed in Ollama.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name, args = {}) {
  switch (name) {
    case "ask_local": {
      const { reply, model } = await chat({
        from: "claude",
        prompt: args.prompt,
        model: args.model || undefined,
        useHistory: args.use_history !== false,
      });
      return `[${model}]\n${reply}`;
    }
    case "local_history": {
      const msgs = loadLog().messages.slice(-(args.last || 20));
      if (!msgs.length) return `No history yet for ${projectDir()}.`;
      return msgs.map((m) => `--- ${m.from}${m.model ? ` (${m.model})` : ""} @ ${m.ts}\n${m.content}`).join("\n\n");
    }
    case "reset_local_history": {
      saveLog({ project: projectDir(), messages: [] });
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
