# ollama-bridge

Connects Claude Code to local models running in [Ollama](https://ollama.com), with a shared, per-project conversation log.

- **Bridge (MCP server):** gives Claude an `ask_local` tool so it can offload simple tasks to a local model. Claude, the local model and you (via `local-chat`) all share one conversation log per project folder.
- **`claude-local`:** runs Claude Code itself on a local model instead of Anthropic's API (offline, private, no cost; much slower and less capable).
- **Web UI (`ollama-bridge ui`):** see every project's shared conversation (Claude, you and the models, live), chat with any installed model, clear history, and check your setup.

No npm dependencies; needs Node 18+.

## Tools exposed to Claude

| Tool | What it does |
|---|---|
| `ask_local` | Send a prompt to the local model (optional `model`, `use_history`) |
| `local_history` | Read the shared log, including messages you sent via `local-chat` |
| `reset_local_history` | Clear the log for the current project |
| `list_local_models` | List installed Ollama models |

## Setup (Windows, macOS, Linux)

Install [Node 18+](https://nodejs.org), [Ollama](https://ollama.com/download) and the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/setup), then:

```bash
git clone https://github.com/TobiasOnoufriou/ollama-bridge.git
cd ollama-bridge
node install.mjs
```

The installer is safe to re-run (add `--yes` to answer yes to every question). It:

1. Checks Node, Ollama and Claude Code are installed and says how to install anything missing.
2. Creates `config.json` from `config.example.json` and, if the GPU/RAM looks too small, offers smaller models.
3. `ollama pull`s the configured models (asking before each download) and creates the larger-context
   claude-local variant (e.g. `qwen3.6-cc`) from a generated `models/*.Modelfile`.
4. Registers the bridge: `claude mcp add --scope user ollama-bridge -- node <this folder>/server.mjs`.
5. Puts `claude-local` and `local-chat` on PATH: this folder on your user PATH (Windows), or symlinks in
   `~/.local/bin` (macOS/Linux), asking before editing your shell rc file.
6. Adds a marked section to `~/.claude/CLAUDE.md` telling Claude when to offload work via `ask_local`.

Open a new terminal afterwards so the PATH change applies.

## Usage

Everything goes through one command:

```bash
ollama-bridge ui                 # web UI at http://127.0.0.1:4317 (opens your browser)
ollama-bridge chat               # chat in the terminal, in this folder's shared log
ollama-bridge chat deepseek-r1:14b
ollama-bridge claude             # Claude Code on the local model (qwen3.6-cc by default)
ollama-bridge status             # check everything is installed and wired up, with fixes
ollama-bridge models             # installed models and their roles (default / reasoning / claude-local)
ollama-bridge history 10         # last 10 messages of this folder's shared log
ollama-bridge projects           # every project with a shared log
ollama-bridge reset              # clear this folder's shared log
ollama-bridge install            # re-run the installer
```

`claude-local` and `local-chat` still work as shortcuts for `ollama-bridge claude` and `ollama-bridge chat`.

The web UI only listens on `127.0.0.1`, refuses other hostnames and cross-site requests, and refreshes
every few seconds, so messages Claude sends with `ask_local` appear on their own. Use `--port N` to pick
another port or `--no-open` to skip opening the browser.

## Configuration

Edit `config.json` (per machine, not committed) and re-run `node install.mjs` to pull and create any new models.

| Key | Default | Used by |
|---|---|---|
| `bridgeModel` | `qwen2.5-coder:14b` | bridge, local-chat |
| `bridgeNumCtx` | `32768` | bridge |
| `reasoningModel` | `deepseek-r1:14b` | suggested to Claude for reasoning-heavy questions |
| `claudeLocalModel` | `qwen3.6` | claude-local runs the `<model>-cc` variant built from it |
| `claudeLocalCtx` | `65536` | context size of that variant |
| `ollamaUrl` | `http://localhost:11434` | everything |

Environment variables override the config:

| Variable | Overrides |
|---|---|
| `OLLAMA_BRIDGE_MODEL` | `bridgeModel` |
| `OLLAMA_BRIDGE_REASONING_MODEL` | `reasoningModel` |
| `OLLAMA_BRIDGE_NUM_CTX` | `bridgeNumCtx` |
| `OLLAMA_BRIDGE_MAX_CHARS` | history sent per request (default `80000`) |
| `OLLAMA_HOST_URL` | `ollamaUrl` |
| `CLAUDE_LOCAL_MODEL` | the model claude-local runs (default `qwen3.6-cc`) |
| `CLAUDE_LOCAL_CTX` | `claudeLocalCtx` |

## Model notes

- `qwen2.5-coder` writes tool calls as plain text, so it can't run `claude-local`; fine for the bridge.
- `deepseek-r1:14b` ignores tools entirely; use it through the bridge only. Slower and verbose, good at reasoning.
- `qwen3.6` makes proper tool calls, but at 23 GB it partly runs on CPU with a 16 GB GPU.
- On smaller machines the installer suggests `qwen2.5-coder:7b`/`3b`, `deepseek-r1:8b`/`1.5b` and `qwen3:8b`/`4b`
  for claude-local. The qwen3 suggestions haven't been tested with claude-local yet.
