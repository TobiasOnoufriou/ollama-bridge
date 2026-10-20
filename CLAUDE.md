# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ollama-bridge connects Claude Code to local Ollama models: an MCP server (`ask_local` etc.), a CLI (`ollama-bridge`),
a local web UI, and `claude-local` (Claude Code pointed at Ollama). `README.md` is the user-facing manual and is
detailed; keep it in sync when behaviour, commands, settings or config keys change.

## Commands

Plain Node 18+ ES modules. No npm dependencies, no package.json, no build step, no test suite, no linter. The one
exception is the optional Electron app in `desktop/` (its own `package.json`; nothing in the root imports from it).

```bash
node ollama-bridge.mjs help              # every subcommand (ui, ask, chat, status, issues, handoff, ...)
node ollama-bridge.mjs ui --no-open      # web UI at http://127.0.0.1:4317 (--port N for another)
node ollama-bridge.mjs status            # checks Node/Ollama/Claude/config/MCP registration, with fixes
node config.mjs [key]                    # effective config (config.example.json + config.json) as JSON
node --check <file>.mjs                  # syntax check; the closest thing to a lint/test pass
```

Verify changes by running the affected command or UI flow against a running Ollama. Most features need Ollama up
and the configured models pulled.

**This checkout is usually the live install.** `install.mjs` registers `node <this folder>/server.mjs` as a
user-scope MCP server and `session-hint.mjs` as a global Stop hook, so a broken edit to either affects every
Claude Code session on the machine. MCP server changes only take effect in new Claude Code sessions.

## Architecture

Everything is a flat set of `.mjs` modules in the repo root; `HERE` (from `config.mjs`) is the repo folder and all
per-machine state lives under it, not in the user's projects:

- `config.json` (gitignored) layered over `config.example.json`; env vars override (see `lib.mjs` and README).
- `logs/<sanitised-project-path>.json`: the **shared conversation log** per project folder. Claude (via MCP),
  the user (`chat`/web UI) and local models all append to the same file. `lib.mjs` `chat()` re-reads the log
  just before saving because other processes may have written meanwhile; keep that pattern for any log writes.
- `logs/sessions/<key>/<id>.json`: named sub-sessions of a project (separate conversations, each with its own
  resumed Claude session in `log.claude`). Log functions take `(dir, sub)`; `sub` "" is the main log above and
  defaults to `OLLAMA_BRIDGE_SESSION` (`defaultSub()`), so the UI server must always pass it explicitly.
- `logs/index/` (embedding/outline cache for `context.mjs`), `logs/issues/` (issue text handed to Claude),
  `projects.json`, `models/*.Modelfile`, `fast-mode.settings.json`: all generated, all gitignored.

Entry points, all thin over shared modules:

- `server.mjs`: hand-rolled MCP stdio server (newline-delimited JSON-RPC). Its tool descriptions load into
  every Claude Code session, so keep them short; `local_history` output is capped for the same reason.
- `ollama-bridge.mjs`: CLI dispatcher; heavier modules (`ui-server`, `issues`, `handoff`) are lazy-imported.
  `chat.mjs`, `claude-local*`, `local-chat*` and the `.cmd`/bash wrappers are shortcuts into it or `config.mjs`.
- `desktop/main.mjs`: Electron shell that spawns `node ollama-bridge.mjs ui --no-open` and loads its URL. Electron
  doesn't support `prompt()`, so the page uses `askText()` instead; don't add `prompt()` calls back.
- `ui-server.mjs` + `ui/index.html`: `node:http` JSON API plus a single self-contained HTML page (no framework,
  no bundler). The server binds to 127.0.0.1, rejects other `Host`/`Origin` headers (DNS rebinding / CSRF) and
  only accepts `application/json` POSTs; preserve these guards when adding routes, and validate project paths
  with `projectParam()`.

Core pipeline modules:

- `lib.mjs`: Ollama `/api/chat` call, log load/save, history trimming to a char budget.
- `router.mjs`: Smart routing (local vs Claude): regex rules first, then the local model classifies via JSON.
- `claude-run.mjs`: runs `claude -p` in a project, resuming one session per project, with a reduced toolset
  (`--tools ... --strict-mcp-config --disable-slash-commands`) to keep token cost down. Prompts go via stdin,
  never through a shell; `launch.mjs` builds the CLI args (`claudeArgs`) and opens terminals per OS.
- `context.mjs`: gathers project code for tool-less local models (model-picked files from an outline,
  embedding search with `nomic-embed-text`, keyword search).
- `planner.mjs`: step-by-step local planning (scope → per-file → ripple → code checks → write-up). Every model
  call uses Ollama structured outputs (JSON schema) via `ask()`; steps are assembled in code so the model can't
  drop them.
- `review.mjs`: Implement-with-Claude then local review: snapshot, diff, per-step "was this done?" with a
  second confirming question, syntax/unused-function checks, at most one fix round back to Claude.
- `session-hint.mjs` (Stop hook + context sizing from `~/.claude/projects` transcripts), `handoff.mjs`
  (local-model hand-off note), `usage.mjs` (token stats), `issues.mjs` (`gh` or GitHub REST),
  `projects.mjs`, `status.mjs`, `install.mjs`.

## Conventions

- Cross-platform (Windows, macOS, Linux): branch on `process.platform`, use `path`, and keep `.cmd`/`.ps1`
  files CRLF and everything else LF (`.gitattributes`).
- Design rule throughout: small local models get one narrow question at a time over short text, with JSON-schema
  outputs, and anything checkable (file lists, branch names, function existence) is done in code, not by the model.
- Text from outside (GitHub issues, transcripts) is written to files and referenced, not interpolated into
  shell commands or treated as instructions.
- Commit messages: imperative summary line, then a wrapped body explaining why and what changed per file.
