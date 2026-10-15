# ollama-bridge

Connects Claude Code to local models running in [Ollama](https://ollama.com), with a shared, per-project conversation log.

- **Bridge (MCP server):** gives Claude an `ask_local` tool so it can offload simple tasks to a local model. Claude, the local model and you (via `local-chat`) all share one conversation log per project folder.
- **`claude-local`:** runs Claude Code itself on a local model instead of Anthropic's API (offline, private, no cost; much slower and less capable).
- **Web UI (`ollama-bridge ui`):** see every project's shared conversation (Claude, you and the models, live), chat with any installed model, clear history, and check your setup.
- **Projects:** add any folder as a project (terminal-style path box with Tab completion, the system folder picker, or your recent Claude Code folders), then open Claude Code, Claude Code on the local model, a terminal or the file manager in it with one click.

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
ollama-bridge projects           # your projects (added folders and ones with a shared log)
ollama-bridge add ~/code/my-app  # add a folder as a project (default: this folder)
ollama-bridge remove             # remove this folder from the list (--delete-history to clear it too)
ollama-bridge open claude        # new terminal window running Claude Code in this folder
ollama-bridge open local ~/code/my-app   # ...Claude Code on the local model, in another folder
ollama-bridge open terminal      # ...or just a shell; `open folder` opens the file manager
ollama-bridge reset              # clear this folder's shared log
ollama-bridge install            # re-run the installer
```

`claude-local` and `local-chat` still work as shortcuts for `ollama-bridge claude` and `ollama-bridge chat`.

The web UI only listens on `127.0.0.1`, refuses other hostnames and cross-site requests, and refreshes
every few seconds, so messages Claude sends with `ask_local` appear on their own. Use `--port N` to pick
another port or `--no-open` to skip opening the browser.

### Projects in the web UI

Click **+ Add** to add a folder. The box works like `cd` in a terminal: type a path (`~` works), press
<kbd>Tab</kbd> to complete folder names, <kbd>↑</kbd>/<kbd>↓</kbd> to pick from the list and <kbd>Enter</kbd> to add.
**Browse…** opens your system's folder picker, and folders you've used Claude Code in are suggested below.
The list is saved per machine in `projects.json` (not committed). Removing a project only hides it; the folder
is never touched, and its conversation is kept unless you choose to delete it.

Each project has buttons to open, in that folder: **Claude** (Claude Code in a new terminal), **Claude (local)**
(the same on your local model), **Terminal** and **Folder**. Windows uses Windows Terminal when it's installed
(otherwise a PowerShell window), macOS uses Terminal.app, and Linux uses the first terminal it finds
(`x-terminal-emulator`, GNOME Terminal, Konsole, xfce4-terminal, kitty, Alacritty or xterm). On Linux, **Browse…**
needs `zenity` or `kdialog`; you can always type the path instead.

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
