// Model defaults: config.json (per machine, written by install.mjs) layered over config.example.json.
// CLI for the launchers:  node config.mjs [key]   (no key prints the whole config as JSON)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_FILE = path.join(HERE, "config.json");
export const EXAMPLE_FILE = path.join(HERE, "config.example.json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// Name of the larger-context copy of the claude-local model that install.mjs creates, e.g. qwen3.6 -> qwen3.6-cc.
export function variantName(model) {
  return model.replace(/:latest$/, "").replace(/[:/]/g, "-") + "-cc";
}

export function loadConfig() {
  const cfg = { ...readJson(EXAMPLE_FILE), ...readJson(CONFIG_FILE) };
  cfg.claudeLocalVariant = variantName(cfg.claudeLocalModel);
  return cfg;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const key = process.argv[2];
  if (key && !(key in cfg)) {
    console.error(`Unknown config key: ${key}`);
    process.exit(1);
  }
  console.log(key ? String(cfg[key]) : JSON.stringify(cfg));
}
