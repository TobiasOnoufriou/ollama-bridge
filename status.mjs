// Health checks and model info shared by the ollama-bridge command and the web UI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HERE, CONFIG_FILE, loadConfig } from "./config.mjs";

const IS_WIN = process.platform === "win32";
const norm = (p) => {
  const r = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return IS_WIN ? r.toLowerCase() : r;
};
const withTag = (m) => (m.includes(":") ? m : `${m}:latest`);

export function effectiveConfig() {
  const cfg = loadConfig();
  return {
    ...cfg,
    ollamaUrl: process.env.OLLAMA_HOST_URL || cfg.ollamaUrl,
    bridgeModel: process.env.OLLAMA_BRIDGE_MODEL || cfg.bridgeModel,
    reasoningModel: process.env.OLLAMA_BRIDGE_REASONING_MODEL || cfg.reasoningModel,
    claudeLocalVariant: process.env.CLAUDE_LOCAL_MODEL || cfg.claudeLocalVariant,
  };
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Installed models, tagged with the role each plays in this setup.
export async function modelsWithRoles(cfg = effectiveConfig()) {
  const data = await getJson(`${cfg.ollamaUrl}/api/tags`);
  const roles = {
    [withTag(cfg.bridgeModel)]: "default",
    [withTag(cfg.reasoningModel)]: "reasoning",
    [withTag(cfg.claudeLocalVariant)]: "claude-local",
  };
  const models = await Promise.all(
    data.models.map(async (m) => {
      // Ollama reports what each model supports; claude-local needs real tool calling.
      let caps = [];
      try {
        const res = await fetch(`${cfg.ollamaUrl}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: m.name }),
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) caps = (await res.json()).capabilities || [];
      } catch {}
      return {
        name: m.name,
        sizeGB: +(m.size / 1e9).toFixed(1),
        role: roles[m.name] || null,
        tools: caps.includes("tools"),
        // Tested: these advertise tools but write tool calls as text or ignore them, so Claude Code can't use them.
        toolsUnreliable: /^(qwen2\.5-coder|deepseek-r1)[:-]/.test(m.name),
      };
    }),
  );
  return models.sort((a, b) => (b.role ? 1 : 0) - (a.role ? 1 : 0) || a.name.localeCompare(b.name));
}

function claudeVersion() {
  const r = IS_WIN
    ? spawnSync("claude --version", { encoding: "utf8", shell: true })
    : spawnSync("claude", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : null;
}

function mcpRegistration() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    return j.mcpServers?.["ollama-bridge"] || null;
  } catch {
    return null;
  }
}

function onPath() {
  if (IS_WIN) return (process.env.PATH || "").split(";").filter(Boolean).some((p) => norm(p) === norm(HERE));
  return fs.existsSync(path.join(os.homedir(), ".local", "bin", "ollama-bridge"));
}

// Each check: { label, ok, detail, fix? }. Never throws.
export async function checkStatus() {
  const cfg = effectiveConfig();
  const checks = [];
  const add = (label, ok, detail, fix) => checks.push({ label, ok, detail, ...(ok ? {} : { fix }) });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add("Node.js", nodeMajor >= 18, `v${process.versions.node}`, "Install Node 18 or newer from https://nodejs.org");

  let installed = null;
  try {
    const { version } = await getJson(`${cfg.ollamaUrl}/api/version`);
    add("Ollama", true, `v${version} at ${cfg.ollamaUrl}`);
    installed = new Set((await getJson(`${cfg.ollamaUrl}/api/tags`)).models.map((m) => m.name));
  } catch {
    add("Ollama", false, `not answering at ${cfg.ollamaUrl}`, "Start the Ollama app, or run: ollama serve");
  }

  const cv = claudeVersion();
  add("Claude Code CLI", !!cv, cv || "not found", IS_WIN ? "winget install Anthropic.ClaudeCode" : "curl -fsSL https://claude.ai/install.sh | bash");

  for (const [role, model, fix] of [
    ["Default model", cfg.bridgeModel, `ollama pull ${cfg.bridgeModel}`],
    ["Reasoning model", cfg.reasoningModel, `ollama pull ${cfg.reasoningModel}`],
    ["claude-local model", cfg.claudeLocalVariant, "ollama-bridge install"],
  ]) {
    if (!installed) add(role, false, `${model} (can't check, Ollama is down)`, "Start Ollama first");
    else add(role, installed.has(withTag(model)), installed.has(withTag(model)) ? `${model} installed` : `${model} missing`, fix);
  }

  const reg = mcpRegistration();
  const expected = norm(path.join(HERE, "server.mjs"));
  const regOk = !!reg && (reg.args || []).some((a) => norm(a) === expected);
  add(
    "Registered with Claude Code",
    regOk,
    regOk ? "ollama-bridge (user scope)" : reg ? `points elsewhere: ${(reg.args || []).join(" ")}` : "not registered",
    "ollama-bridge install",
  );

  add("Commands on PATH", onPath(), onPath() ? "ollama-bridge, claude-local, local-chat" : "not on PATH", "ollama-bridge install (then open a new terminal)");

  return { checks, allOk: checks.every((c) => c.ok), config: cfg, here: HERE, configFile: CONFIG_FILE };
}
