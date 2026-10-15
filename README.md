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
ollama-bridge ask "explain this regex: ^\d{3}$"   # smart prompt: local model or Claude Code, then the answer
ollama-bridge ask --claude "why do the tests fail?"  # force a side (--local / --claude), --model, --plan
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
ollama-bridge open claude --model sonnet --plan   # pick the Claude model and start in plan mode
ollama-bridge open claude --model opus --effort high --fast   # effort level and fast mode
ollama-bridge chat --plan        # terminal chat in plan mode, step by step (type /plan to toggle; --quick for one pass)
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
The list is saved per machine in `projects.json` (not committed).

To delete a project, hover over it in the sidebar and click the trash icon (or use **Delete** in the project
header). This removes it from the list, including the folder you started the UI in, and optionally deletes its
shared conversation. The folder and its files on disk are never touched; add it again any time.

Each project has buttons to open, in that folder: **Claude** (Claude Code in a new terminal), **Claude (local)**
(the same on your local model), **Terminal** and **Folder**. Windows uses Windows Terminal when it's installed
(otherwise a PowerShell window), macOS uses Terminal.app, and Linux uses the first terminal it finds
(`x-terminal-emulator`, GNOME Terminal, Konsole, xfce4-terminal, kitty, Alacritty or xterm). On Linux, **Browse…**
needs `zenity` or `kdialog`; you can always type the path instead.

### Settings

A line under the buttons sums up what everything will use, for example
*Chat: Qwen 2.5 Coder 14B · Claude: Opus, high effort, fast · Claude (local): Qwen 3.6 (long context)*.
Click it, or **Settings**, to change it (choices are remembered in your browser). Models are shown with
readable names, what they're for and their size.

- **Local model:** the model that answers in the chat, and whether it gets the shared history.
- **Claude Code** (the **Claude** button, and Claude / Smart in the chat):
  - **Model:** Default, Fable, Opus, Sonnet or Haiku (aliases, so always the latest version).
  - **Effort:** Default, Low, Medium, High, Extra high or Max (`--effort`). Higher thinks longer.
  - **Fast mode:** up to 2.5× faster Opus at a higher price. Opus only (other models switch to Opus), and
    billed to usage credits rather than your plan's limits. Passed per session with `--settings`.
  - **Starts in:** Normal, **Plan mode** (research and propose a plan before changing anything),
    Auto-accept edits or Auto mode.
- **Claude Code on a local model** (the **Claude (local)** button): which Ollama model runs it. Only models
  that make real tool calls are selectable; `qwen2.5-coder` and `deepseek-r1` are shown greyed out.

### Smart prompt: local model or Claude?

Under the message box, choose where a message goes: **Local** (the model picked at the top), **Claude**
(Claude Code, using the Claude model and start mode from the project settings) or **Smart**, which decides:

1. **Rules first (instant).** Prompts that name a file (`app.js`, `src/utils.py`, ...), mention a file in the
   project, ask for project work (refactor, implement, run the tests, edit files, review my code...) or are very
   long go to Claude. Code pasted in a fenced block doesn't count as naming a file.
2. **Otherwise the local model classifies it** (about 0.3 s once loaded). Explanations, snippets, regex, SQL,
   conversions and short summaries stay local; anything needing files, several steps, debugging, design
   decisions or high accuracy goes to Claude. When unsure it picks Claude.
3. If Ollama isn't running, short questions stay local and everything else goes to Claude.

Each prompt shows where it went and why (for example *Smart → Claude · mentions ui-server.mjs in this project*).
When a message goes to Claude, Claude Code runs non-interactively (`claude -p`) in the project folder and its
reply is added to the same conversation. In the **Normal** start mode it can read but not change files (there's
no one to approve edits); choose **Auto-accept edits** if you want it to make changes. Claude Code's CLI must be
signed in once: run `claude` and type `/login`.

**Smart effort.** When Settings → Effort is left on *Default*, Smart also picks an effort for Claude: **low** for
a quick lookup or a short question about one file, **medium** for anything else (fixing, debugging, several
steps). It never picks above medium; an effort you choose in Settings always wins. Replies show it, e.g.
*Claude Code (low effort, auto)*.

#### How Claude runs from the chat stay cheap

- **One session per project.** The first run starts a Claude Code session and later runs resume it
  (`--resume`), so the system prompt and earlier turns come from Claude's prompt cache, and only shared
  messages Claude hasn't seen yet are sent. Clearing the conversation starts a new session.
- **Read-only toolset.** In Normal and Plan mode the run gets only Read, Grep and Glob and skips MCP servers and
  skills (`--tools Read,Grep,Glob --strict-mcp-config --disable-slash-commands`), cutting most of a fresh
  session's input. Auto-accept edits and Auto mode keep the full toolset.
- **Measured** (Haiku, a question about one file, then a follow-up): 106.6k input tokens and $0.045 before;
  43.2k tokens, mostly cache reads, and $0.011 after, about 75% less.
- The bridge's tool descriptions and its `~/.claude/CLAUDE.md` section, which load into every Claude Code
  session, are about 60% shorter, and `local_history` returns at most about 4,000 characters.

### Usage

**Usage** in the sidebar (or <kbd>Alt</kbd>+<kbd>U</kbd>) shows, for the last 5 hours, today, 7 or 30 days:

- **Claude Code, every session on this PC** (desktop app, terminals, `claude -p` runs and the ones started
  here), read from Claude Code's own session records in `~/.claude/projects`: output and input tokens,
  tokens read from the prompt cache, replies and sessions, fast-mode replies, a per-day chart, and
  breakdowns by model and by project. Plan limits and reset times aren't stored locally; run `/usage` in
  Claude Code for those.
- **Local models:** replies in this app, tasks Claude handed off with `ask_local`, how often Smart kept a
  prompt local, tokens processed on your GPU, and replies per local model.

Hover any reply to see its tokens in → out, time, and (for Claude runs) the cost Claude Code reported.

### Shortcuts and tricks

Press <kbd>?</kbd> (or click **Shortcuts & tricks** under the message box) for the full list.

- **Per-message overrides:** start a message with `@claude`, `@local`, `@smart`, `@reason` (the reasoning
  model), `@<model name>` (the start of the name is enough), and/or `/plan`, e.g. `@claude /plan add login`.
- **Drop text files** on the message box to paste them in as code blocks; Smart then keeps the question local
  because the model can see the file.
- **↑** in an empty message box brings back your last message.
- **Hover a message** for **Copy**, **Ask Claude instead** / **Retry locally**, and **Second opinion** (the
  reasoning model checks the answer).
- **Keys:** <kbd>Ctrl</kbd>+<kbd>K</kbd> or <kbd>/</kbd> jump to the message box; <kbd>Alt</kbd>+<kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd>
  Local / Smart / Claude; <kbd>Alt</kbd>+<kbd>P</kbd> plan mode; <kbd>Alt</kbd>+<kbd>S</kbd> settings;
  <kbd>Alt</kbd>+<kbd>U</kbd> usage; <kbd>Alt</kbd>+<kbd>N</kbd> add a project.

### Plan mode for the local models

Tick **Plan** next to Send (or use `ollama-bridge chat --plan` / `/plan`) and the model replies with a plan
instead of doing the task: goal, questions and assumptions, numbered steps naming files and functions, risks,
and how to verify. Plan messages get a **Plan** badge. Claude can ask for one too: `ask_local` takes
`plan: true`, which pairs well with `deepseek-r1:14b` for a second opinion on an approach.

#### Project-aware plans

The local model has no tools, so on its own it would guess file and function names. Before a local plan, the
bridge gathers relevant code on your machine and attaches it (Settings → Local model → **Project files**: for
plans, for every message, or off). It combines three methods, so it doesn't rely on your words matching the code:

1. **The model picks.** It reads an outline of the project (every file with its functions and classes) and
   names the files and functions the change involves; the bridge attaches those files and the full definitions
   of those functions. This is reasoning about structure, so "undo a todo I ticked off" finds `finishTask` in
   `src/store.js`.
2. **Search by meaning.** Code is split into chunks and embedded with `nomic-embed-text`; chunks closest in
   meaning to the request are attached, even with no shared words. Large files show their most relevant parts.
3. **Keyword search** on code-like names and the picker's search terms, as a backstop.

Files you name are always attached in full, and dropped files still work. It skips `node_modules`, build output,
binaries, `.env` files and anything in `.gitignore`. The index is cached per project in `logs/index/` and only
changed files are re-read. It takes about 2 seconds and uses no Claude tokens; only the list of files used is
kept in the conversation (shown under your message as *Read N parts of the project*).

In a test on this repo, five requests worded to share no words with the code found the key code in four; the
fifth attached the right files but not the one function the test checked for. It's much better than guessing,
not perfect: check the file list, and drop in anything missing.

#### Step-by-step plans (the default)

A 14B model asked for a whole plan in one go drops steps: in testing it changed the data and the route but forgot
the button on the page. The [Minions](https://arxiv.org/abs/2502.15964) paper found the same, that small models
struggle with multi-step instructions and long contexts but do well on single-step questions over short text. So
plans are built from small questions (`planner.mjs`), each answered as JSON forced to a schema:

1. **Scope:** which files and functions are involved, from the project outline.
2. **Per file:** what changes in this one file (only that file is shown).
3. **Ripple:** the bridge searches for every other place that uses what changes and asks, for each one,
   "does this need to change too?". This is what finds the missing button or route.
4. **Checks**, in code: every function the plan names exists in its file; every new function is used by a change
   elsewhere; places that use what changes were considered; test files that use it are listed. Then a checklist
   pass: is the UI covered, is everything wired end to end, are edge cases handled. Suggestions naming files that
   don't exist are marked *(not in this project)*.
5. **Write-up:** the steps come straight from the findings in code, so none can be dropped or invented; the model
   only writes the goal, assumptions, risks and how to verify. The checks are listed at the end (✓ / ⚠).

The page shows each step as it runs. Plans take about 15 seconds on the sample project, and longer on bigger ones.
Settings → Local model → **Plans** switches to the old one-pass plan (`--quick` in the terminal). `ask_local` with
`plan: true` uses step-by-step too, so Claude can ask your local model for a checked plan.

On the sample task app: "undo a ticked-off todo" and "rename a task" each gave a complete plan (store function,
page button or field, server route). "Show how many tasks are left" found the right places, but one step was
muddled; the checks flagged it (an unused new function, missing wiring) rather than letting it pass.

#### Implement with Claude

Plan replies have an **Implement with Claude** button. It sends the plan to Claude Code in that project with
**Auto-accept edits** (it edits files without asking; you confirm once per project) at your Settings effort, or
medium. Claude checks names against the real code and fixes gaps in the plan; in testing it added a UI button
the local plan had missed. The plan goes in the prompt once (it isn't sent again as shared context) and the
log shows just *Implement the plan above*.

Edit runs get only Read, Edit, Write, Grep and Glob, with no MCP servers or skills; shell commands would be
refused from the chat anyway. Implementing a small three-file change on Haiku took 38k input tokens, 8 turns and
$0.034, against 323k tokens, 17 turns and $0.081 with the full toolset. Auto mode keeps the full toolset.

#### Review after Implement

After Claude implements a plan, the local model checks its work for free (an *evaluator-optimizer* loop, from
Anthropic's [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)):

1. The bridge snapshots the project before Claude runs and works out exactly what changed (`review.mjs`).
2. **One question per plan step:** "was this done?", shown only the diff of that step's file. A "not done"
   verdict gets a second, differently worded question ("quote the added line that does it") and only counts if
   both agree, which stops the small model's misreadings from becoming problems.
3. **Code checks:** changed JS/JSON (and Python, if installed) files pass a syntax check; new functions are called
   somewhere; files changed that the plan didn't mention are listed.
4. **Real problems only** (a step not done, a syntax error, a new function nothing calls) go back to Claude in
   **one** short follow-up, in the same session, so it's mostly cache reads. Claude may answer that a finding is a
   false alarm instead of changing code. The code checks then run again; there's no second round, so cost stays
   bounded.

The review and re-check appear in the conversation with a **Review** badge. Settings → Claude Code → **After
Implement** chooses: review, then fix once (default) / review only / no review.

In testing on the sample app, the review caught a skipped step, a syntax error, an unused function and an unplanned
file in a deliberately flawed change (11 s, free). In a real run (Haiku): implement $0.040, local review ~2 s; an
early version raised a false alarm that cost one $0.005 fix turn (Claude correctly declined to change anything),
which the second check now clears while still catching a step that was really skipped.

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
| `embedModel` | `nomic-embed-text` | project-aware plans (search by meaning); the installer offers to download it |

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
