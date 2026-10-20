# ollama-bridge

Connects Claude Code to local models running in [Ollama](https://ollama.com), with a shared, per-project conversation log.

- **Bridge (MCP server):** gives Claude an `ask_local` tool so it can offload simple tasks to a local model. Claude, the local model and you (via `local-chat`) all share one conversation log per project folder.
- **`claude-local`:** runs Claude Code itself on a local model instead of Anthropic's API (offline, private, no cost; much slower and less capable).
- **Web UI (`ollama-bridge ui`):** see every project's shared conversation (Claude, you and the models, live), chat with any installed model, clear history, and check your setup.
- **Desktop app (`ollama-bridge desktop`):** the same web UI in its own window (Electron), optionally packaged as an installer. See [Desktop app](#desktop-app).
- **Projects:** add any folder as a project (terminal-style path box with Tab completion, the system folder picker, or your recent Claude Code folders), then open Claude Code, Claude Code on the local model, a terminal or the file manager in it with one click.

No npm dependencies; needs Node 18+. (The optional desktop app in `desktop/` is the one exception: it uses Electron.)

## Tools exposed to Claude

| Tool | What it does |
|---|---|
| `ask_local` | Send a prompt to the local model (optional `model`, `use_history`) |
| `local_task` | Hand a coding task to a local agent that reads and edits the project's files itself (see below) |
| `local_history` | Read the shared log, including messages you sent via `local-chat` |
| `reset_local_history` | Clear the log for the current project |
| `list_local_models` | List installed Ollama models |

### `local_task`: the local model edits files itself

`ask_local` can't see your files, so Claude has to paste code in and apply the answer itself, which saves little.
`local_task` runs a small agent loop on a local model (`agentModel`, default `qwen3.6`) with Ollama tool calling:
it can `list_files`, `grep`, `read_file` and change files with `edit_file` (exact find-and-replace) and
`write_file`. Claude sends only the task and file hints and gets back a short summary plus a diffstat, so the code
never passes through Claude's context; Claude can check the result with `git diff`.

- Paths are checked in code: only inside the project, never `.git`, `node_modules` or `.env*`. `list_files` and
  `grep` skip gitignored files too.
  There is no shell tool.
- At most `agentMaxSteps` tool rounds (default 30) and 15 minutes; old tool output is dropped as the
  conversation grows past `agentNumCtx`.
- Changed `.js`/`.mjs`/`.json`/`.py` files get a syntax check, reported with the diffstat.
- The task and the report go into the project's shared log.
- Try it from a terminal: `ollama-bridge task "rename foo to bar in src/util.js and its callers"`, or in the web UI
  with the **Agent** send target (<kbd>Alt</kbd>+<kbd>4</kbd>, or start a message with `@agent`). The UI shows each
  tool call live; **Stop** keeps the edits made so far and still logs the report.

Best for mechanical, well-scoped edits (renames, small functions, test drafts, doc updates). It is slow on a
model that doesn't fit in GPU memory, and it isn't for design decisions or changes across many files.

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
7. Asks to add a Stop hook to `~/.claude/settings.json` that suggests a new session when one gets expensive
   (see [When to start a new session](#when-to-start-a-new-session)).

Open a new terminal afterwards so the PATH change applies.

## Usage

Everything goes through one command:

```bash
ollama-bridge ui                 # web UI at http://127.0.0.1:4317 (opens your browser)
ollama-bridge desktop            # the web UI in its own app window (see Desktop app below)
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
ollama-bridge issues             # GitHub issues of this folder's repo
ollama-bridge issue 12           # new Claude Code window working on issue #12 (--local, --no-branch, --plan, ...)
ollama-bridge handoff            # free hand-off note (local model) for starting a new, cheaper Claude session
ollama-bridge reset              # clear this folder's shared log
ollama-bridge sessions           # this folder's sub-sessions (sessions add <name>, rename <id> <name>, remove <id>)
ollama-bridge --sub auth chat    # --sub <id> with any command: use that sub-session instead of the main log
ollama-bridge install            # re-run the installer
```

`claude-local` and `local-chat` still work as shortcuts for `ollama-bridge claude` and `ollama-bridge chat`.

The web UI only listens on `127.0.0.1`, refuses other hostnames and cross-site requests, and refreshes
every few seconds, so messages Claude sends with `ask_local` appear on their own. Use `--port N` to pick
another port or `--no-open` to skip opening the browser. `--no-current` leaves out the folder the UI was
started in as the "current" project (the desktop app uses it when started from a shortcut).

### Desktop app

`desktop/` wraps the web UI in an Electron window: its own taskbar/Dock icon, no browser tabs, and window size
and position remembered between runs. It starts the normal `node ollama-bridge.mjs ui` server as a child process
and stops it (and any Claude runs it started) when you close the window. Node 18+ still has to be on your PATH.

One-time setup (downloads Electron and electron-builder, about 470 MB):

```bash
cd desktop
npm install
```

Then `ollama-bridge desktop` (or `npm start` in `desktop/`) opens it. Started from a terminal, the folder you're in
is the current project, just like `ollama-bridge ui`.

To build an installer for your OS (Windows NSIS `.exe`, macOS `.dmg`, Linux AppImage) into `desktop/dist/`:

```bash
cd desktop
npm run dist
```

`npm run dist:dir` builds an unpacked app instead, which is quicker for testing. The app finds the bridge folder in
this order:

1. the `OLLAMA_BRIDGE_HOME` environment variable;
2. the checkout it was built from, if it still exists (recorded in `bridge-home.json` at build time), so on your own
   machine it shares this checkout's config, logs and MCP registration;
3. a copy of the bridge bundled into the package. On another machine, run `node install.mjs` in that copy (the
   app's `resources/bridge` folder) to set up config and the MCP server. Its logs live there too, so reinstalling
   or uninstalling the app clears them.

Links to other sites open in your normal browser. The build uses the default Electron icon and isn't code-signed,
so Windows SmartScreen and macOS Gatekeeper will warn the first time.

### Projects in the web UI

Click **+ Add** to add a folder. The box works like `cd` in a terminal: type a path (`~` works), press
<kbd>Tab</kbd> to complete folder names, <kbd>↑</kbd>/<kbd>↓</kbd> to pick from the list and <kbd>Enter</kbd> to add.
**Browse…** opens your system's folder picker, and folders you've used Claude Code in are suggested below.
The list is saved per machine in `projects.json` (not committed).

To delete a project, hover over it in the sidebar and click the trash icon (or use **Delete** in the project
header). This removes it from the list, including the folder you started the UI in, and optionally deletes its
shared conversation. The folder and its files on disk are never touched; add it again any time.

Each project has buttons to open, in that folder: **Claude** (Claude Code in a new terminal), **Claude (local)**
(the same on your local model), **Terminal** and **Folder**, plus **Issues** to start a session on a GitHub issue
(see [below](#start-a-session-from-a-github-issue)). Windows uses Windows Terminal when it's installed
(otherwise a PowerShell window), macOS uses Terminal.app, and Linux uses the first terminal it finds
(`x-terminal-emulator`, GNOME Terminal, Konsole, xfce4-terminal, kitty, Alacritty or xterm). On Linux, **Browse…**
needs `zenity` or `kdialog`; you can always type the path instead.

### Sub-sessions: several conversations in one project

A project starts with one conversation, **Main**. The tabs under the project header hold more: **+ New** starts
a separate conversation in the same folder (say "auth" and "docs"), with its own shared log and its own resumed
Claude session, so unrelated work doesn't share history or Claude context. Double-click a tab to rename it, and
use its ✕ to delete it. The page remembers which session you last had open in each project, and **Clear**
empties just the open one. The line under the tabs names the open session, marks it **New session** until its
first message, and then shows its message count and token use (Claude and local, plus Claude's cost).

The **Claude**, **Claude (local)** and **Start in Claude** buttons open their terminal tied to the open session
(they set `OLLAMA_BRIDGE_SESSION`), so `ask_local` and `local_history` from that Claude Code use the same
conversation. A Claude Code started any other way uses Main.

Main stays in `logs/<project>.json` as before; sub-sessions live in `logs/sessions/<project>/<id>.json`, where
the id is a slug of the name (`a-z`, `0-9`, `-`). Deleting a project with its history deletes its sub-sessions
too. On the command line, `ollama-bridge sessions` lists, adds, renames and removes them, and `--sub <id>`
before or after any command (`ask`, `chat`, `history`, `reset`, `open`, `issue`, `handoff`) works in that one.

### Start a session from a GitHub issue

**Issues** in a project's header (or <kbd>Alt</kbd>+<kbd>I</kbd>) lists the GitHub issues of the folder's repo, found
from its git remote (`origin` first). Switch between Open, Closed and All, and search with GitHub's syntax
(`label:bug login`). Pick an issue (click, or <kbd>↑</kbd>/<kbd>↓</kbd>), then:

- **Start in Claude:** opens Claude Code in a new terminal in the project, using the model, effort, fast mode and start
  mode from Settings, already working on the issue. The session is named after it (`#12 Fix login redirect`), so
  it's easy to find in `/resume`. <kbd>Enter</kbd> or a double-click does the same.
- **Claude (local):** the same, on your local model.
- **Plan locally:** the local model writes a step-by-step plan for the issue in this chat (free). Its **Implement with
  Claude** button then hands the plan to Claude.

With **New branch** ticked (the default), Claude first creates a branch such as `issue-12-fix-login-redirect`.
The issue's title, body and latest 30 comments are saved to `logs/issues/<owner>__<repo>/issue-12.md`. Claude
gets access to that one folder and a short first message pointing at the file. It's told the text came from GitHub,
so it treats it as a description of the task rather than as instructions. Long issues are cut at about 60k
characters.

From a terminal:

```bash
ollama-bridge issues                 # open issues of this folder's repo (--closed, --all, --search "label:bug")
ollama-bridge issue 12               # new Claude Code window working on #12, on a new branch
ollama-bridge issue 12 --local --plan --no-branch   # on the local model, in plan mode, on the current branch
```

Issues are read with the [GitHub CLI](https://cli.github.com) when it's installed and signed in (`gh auth login`),
which also covers private repos. Without it, GitHub's public API is used: public repos only, about 60 requests an
hour, or more with `GITHUB_TOKEN` set. Pull requests are left out.

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
   long go to Claude. Code pasted in a fenced block doesn't count as naming a file. A short go-ahead ("go ahead",
   "do it", "yes, implement it") right after a plan also goes to Claude, so untick **Plan** and reply to implement.
2. **Otherwise the local model classifies it** (about 0.3 s once loaded). Explanations, snippets, regex, SQL,
   conversions and short summaries stay local; anything needing files, several steps, debugging, design
   decisions or high accuracy goes to Claude. When unsure it picks Claude.
3. If Ollama isn't running, short questions stay local and everything else goes to Claude.

Each prompt shows where it went and why (for example *Smart → Claude · mentions ui-server.mjs in this project*).
When a message goes to Claude, Claude Code runs non-interactively (`claude -p`) in the project folder and its
reply is added to the same conversation. There's no one to approve edits, so the **Normal** start mode runs as
**Auto-accept edits**: Claude can read and change files (but not run shell commands; use **Auto mode** for that).
Tick **Plan** for a read-only plan, then untick it to have Claude implement. Claude Code's CLI must be
signed in once: run `claude` and type `/login`.

**What Claude is doing.** While Claude works, the pending reply shows its current step, e.g. *Claude Code is
working: editing lib.mjs (6 actions, 1 file changed)* (the CLI prints the same lines). When it's done, **Changed N
files** under the reply lists each file it edited or wrote, with lines added and removed. Local models see the same
list in the conversation history, so they know what was actually done. Only Claude's Edit and Write calls are
counted; files changed by a shell command (Auto mode) aren't listed.

**Smart effort.** When Settings → Effort is left on *Default*, Smart also picks an effort for Claude: **low** for
a quick lookup or a short question about one file, **medium** for anything else (fixing, debugging, several
steps). It never picks above medium; an effort you choose in Settings always wins.

**Smart model.** For every prompt that goes to Claude, the local model also rates how hard it is, and that picks
the Claude model when Settings → Claude model is left on *Default*:

| Difficulty | Examples | Model |
| --- | --- | --- |
| easy | a lookup, a short explanation, a question about one file, a typo or rename | Haiku |
| medium | a feature or bug fix in one or a few files, debugging with a clear error, tests | Sonnet |
| hard | design decisions, large refactors or migrations, subtle or vague bugs, tricky algorithms | Opus |

When torn it picks the harder one. If Ollama isn't running, low-effort prompts count as easy and the rest as
medium. A model you choose in Settings (or `--model` for `ask`) always wins. The prompt's chip shows the rating,
e.g. *Smart → Claude · hard → opus · needs work on the project itself*, and replies show what Smart picked, e.g.
*Claude Code (Smart: sonnet, low effort)*. Change the mapping with `smartModels` in `config.json` (any Claude
alias or model id, e.g. `{ "easy": "sonnet", "medium": "sonnet", "hard": "opus" }`), or set it to `{}` to turn
automatic model choice off. Switching models in the middle of a resumed chat session can't reuse the prompt cache
from the previous model, so that one turn costs a bit more.

#### How Claude runs from the chat stay cheap

- **One session per project.** The first run starts a Claude Code session and later runs resume it
  (`--resume`), so the system prompt and earlier turns come from Claude's prompt cache, and only shared
  messages Claude hasn't seen yet are sent. Clearing the conversation starts a new session.
- **Small toolset.** In Plan mode the run gets only Read, Grep and Glob, and in Normal / Auto-accept edits only
  those plus Edit and Write; both skip MCP servers and skills (`--tools ... --strict-mcp-config
  --disable-slash-commands`), cutting most of a fresh session's input. Auto mode keeps the full toolset. Plan
  and edit runs resume separate sessions, so a plan session's history doesn't keep Claude in plan mode.
- **Measured** (Haiku, a question about one file, then a follow-up): 106.6k input tokens and $0.045 before;
  43.2k tokens, mostly cache reads, and $0.011 after, about 75% less.
- The bridge's tool descriptions and its `~/.claude/CLAUDE.md` section, which load into every Claude Code
  session, are about 60% shorter, and `local_history` returns at most about 4,000 characters.

### When to start a new session

Claude re-reads a session's whole context on every message. Most of it comes from the prompt cache, but cache reads
are still billed per token, so a message in a 300k-token session costs several times more than the same message in
a fresh one. Past a threshold (100k tokens by default), the bridge suggests starting fresh:

- **In Claude Code** (desktop app or terminal): a Stop hook (`session-hint.mjs`, added by the installer if you say
  yes) checks the session after each reply and shows a line like *This session's context is 180k tokens, 2.7× what a
  fresh session here starts with (68k)... a new session cuts each message's input by about 62%*. The line goes to
  you only, so it costs no tokens. It appears once at 100k, then again every further 50k, and the check takes about
  0.1 s, even on multi-megabyte transcripts. It skips sessions running on a local model, which are free anyway.
- **In the web UI:** a banner above the conversation when the Claude session the chat resumes, or your latest Claude
  Code session in that folder, is past the threshold. **Start fresh** makes the next Claude message start a new
  session; the recent shared conversation is passed on as before, so nothing is lost. **✕** hides the banner until
  the session grows another 50k tokens.

The fresh-session size is measured from that session's own first message, so the savings figure fits your setup:
in the desktop app a new session here starts at about 68k tokens of system prompt and tools.

**Hand-off notes for free.** Asking Claude to summarise a long session costs one more full-context message. Instead,
run `ollama-bridge handoff` in the project folder, or click **Hand-off note** in the banner. It reads the latest
session's transcript on disk and boils it down in code (your requests, Claude's replies, files edited, commands run),
then your local model writes a short note: goal, what's done, decisions, and what's next. The branch and the
edited files are added in code, so the model can't drop or invent them. The note is copied to the clipboard and
saved in the shared conversation. Start a new session (`/clear`, or a new window) and paste it as your first
message. `--session <id>` picks an older session, and `--model` picks the local model. It takes about 20 seconds
with `qwen2.5-coder:14b`. Files changed through a shell command rather than Claude's edit tools aren't in the file list.

Only start fresh when you're moving on to something new. Mid-task, the context is usually worth what it costs.

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

- **Per-message overrides:** start a message with `@claude`, `@local`, `@smart`, `@agent`, `@reason` (the reasoning
  model), `@<model name>` (the start of the name is enough), and/or `/plan`, e.g. `@claude /plan add login`.
- **Drop text files** on the message box to paste them in as code blocks; Smart then keeps the question local
  because the model can see the file.
- **↑** in an empty message box brings back your last message.
- **Stop** (in place of Send while a reply is running) really stops it: Claude Code is killed and the local
  model stops generating, including mid-way through a step-by-step plan or an Implement + review. A stopped
  local reply isn't logged and your text goes back in the box; a stopped Claude run is logged as stopped, since
  it may already have edited files. Each session runs one request at a time, so a new message waits for the
  old one to finish stopping.
- **Hover a message** for **Copy**, **Ask Claude instead** / **Retry locally**, and **Second opinion** (the
  reasoning model checks the answer).
- **Keys:** <kbd>Ctrl</kbd>+<kbd>K</kbd> or <kbd>/</kbd> jump to the message box; <kbd>Alt</kbd>+<kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd>/<kbd>4</kbd>
  Local / Smart / Claude / Agent; <kbd>Alt</kbd>+<kbd>P</kbd> plan mode; <kbd>Alt</kbd>+<kbd>S</kbd> settings;
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
| `agentModel` | `qwen3.6` | `local_task` / `ollama-bridge task` (needs a model with tool calling) |
| `agentNumCtx` | `32768` | context size for `local_task` |
| `agentMaxSteps` | `30` | tool-call rounds per `local_task` |
| `ollamaUrl` | `http://localhost:11434` | everything |
| `embedModel` | `nomic-embed-text` | project-aware plans (search by meaning); the installer offers to download it |
| `newSessionHintTokens` | `100000` | context size at which a new session is suggested; `0` turns the hint off |
| `newSessionHintEvery` | `50000` | how much further a session grows before the hint shows again |
| `smartModels` | `{ "easy": "haiku", "medium": "sonnet", "hard": "opus" }` | Claude model Smart uses per difficulty; `{}` turns it off |

Environment variables override the config:

| Variable | Overrides |
|---|---|
| `OLLAMA_BRIDGE_MODEL` | `bridgeModel` |
| `OLLAMA_BRIDGE_REASONING_MODEL` | `reasoningModel` |
| `OLLAMA_BRIDGE_NUM_CTX` | `bridgeNumCtx` |
| `OLLAMA_BRIDGE_AGENT_MODEL` | `agentModel` |
| `OLLAMA_BRIDGE_AGENT_CTX` | `agentNumCtx` |
| `OLLAMA_BRIDGE_MAX_CHARS` | history sent per request (default `80000`) |
| `OLLAMA_BRIDGE_SESSION` | sub-session to use instead of the project's main conversation (set by `--sub` and by terminals opened from a session tab) |
| `OLLAMA_HOST_URL` | `ollamaUrl` |
| `CLAUDE_LOCAL_MODEL` | the model claude-local runs (default `qwen3.6-cc`) |
| `CLAUDE_LOCAL_CTX` | `claudeLocalCtx` |

## Model notes

- `qwen2.5-coder` writes tool calls as plain text, so it can't run `claude-local`; fine for the bridge.
- `deepseek-r1:14b` ignores tools entirely; use it through the bridge only. Slower and verbose, good at reasoning.
- `qwen3.6` makes proper tool calls, but at 23 GB it partly runs on CPU with a 16 GB GPU.
- On smaller machines the installer suggests `qwen2.5-coder:7b`/`3b`, `deepseek-r1:8b`/`1.5b` and `qwen3:8b`/`4b`
  for claude-local. The qwen3 suggestions haven't been tested with claude-local yet.
