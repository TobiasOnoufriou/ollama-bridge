# ollama-bridge

Connects Claude Code to local models running in [Ollama](https://ollama.com), with a shared, per-project conversation log.

- **Bridge (MCP server):** gives Claude an `ask_local` tool so it can offload simple tasks to a local model. Claude, the local model and you (via `local-chat`) all share one conversation log per project folder.
- **`claude-local`:** runs Claude Code itself on a local model instead of Anthropic's API (offline, private, no cost; much slower and less capable).

No npm dependencies; needs Node 18+.

## Tools exposed to Claude

| Tool | What it does |
|---|---|
| `ask_local` | Send a prompt to the local model (optional `model`, `use_history`) |
| `local_history` | Read the shared log, including messages you sent via `local-chat` |
| `reset_local_history` | Clear the log for the current project |
| `list_local_models` | List installed Ollama models |

## Setup (Windows)

```powershell
ollama pull qwen2.5-coder:14b      # default bridge model, fast code tasks
ollama pull deepseek-r1:14b        # reasoning / second opinions
ollama pull qwen3.6                # for claude-local (needs real tool calling)
ollama create qwen3.6-cc -f models\qwen3.6-cc.Modelfile   # 64k-context variant

claude mcp add --scope user ollama-bridge -- node C:/path/to/ollama-bridge/server.mjs
```

Then add this folder to your user PATH to get `claude-local` and `local-chat` anywhere.

## Usage

```powershell
local-chat                       # chat with the default model in this folder's shared log
local-chat deepseek-r1:14b       # ...or a specific model
claude-local                     # Claude Code on qwen3.6-cc
claude-local -Model other-model -p "do something"
```

## Configuration (environment variables)

| Variable | Default | Used by |
|---|---|---|
| `OLLAMA_BRIDGE_MODEL` | `qwen2.5-coder:14b` | bridge, local-chat |
| `OLLAMA_BRIDGE_NUM_CTX` | `32768` | bridge |
| `OLLAMA_BRIDGE_MAX_CHARS` | `80000` | history sent per request |
| `OLLAMA_HOST_URL` | `http://localhost:11434` | bridge |
| `CLAUDE_LOCAL_MODEL` | `qwen3.6-cc` | claude-local |
| `CLAUDE_LOCAL_CTX` | `65536` | claude-local |

## Model notes

- `qwen2.5-coder` writes tool calls as plain text, so it can't run `claude-local`; fine for the bridge.
- `deepseek-r1:14b` ignores tools entirely; use it through the bridge only. Slower and verbose, good at reasoning.
- `qwen3.6` makes proper tool calls, but at 23 GB it partly runs on CPU with a 16 GB GPU.
