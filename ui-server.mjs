// Local web UI for ollama-bridge: `ollama-bridge ui`. Listens on 127.0.0.1 only.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { HERE } from "./config.mjs";
import { chat, loadLog, saveLog, clearLog, subId, listSessions, createSession, renameSession, deleteSession, withCancel } from "./lib.mjs";
import { checkStatus, modelsWithRoles, effectiveConfig } from "./status.mjs";
import { allProjects, addProject, removeProject, isKnownProject, claudeCodeProjects, completeDir } from "./projects.mjs";
import { pickFolder, launchIn, CLAUDE_MODELS, START_MODES, EFFORT_LEVELS } from "./launch.mjs";
import { routePrompt } from "./router.mjs";
import { runClaude } from "./claude-run.mjs";
import { usage } from "./usage.mjs";
import { projectContext } from "./context.mjs";
import { planAndLog } from "./planner.mjs";
import { implementAndReview } from "./review.mjs";
import { contextSize, transcriptFor, recentTranscripts, shouldHint, savings } from "./session-hint.mjs";
import { handoff, copyToClipboard } from "./handoff.mjs";
import { repoFor, listIssues, getIssue, issueMarkdown, issueBranch, issueSession } from "./issues.mjs";

// Live progress of step-by-step plans, by an id the page picks.
const progress = new Map();

// Stop button: running requests by an id the page picks (runId -> AbortController), and the sessions busy with a
// chat, Claude or implement run. The lock is held until the work has really stopped (Claude killed, Ollama fetch
// aborted), so a message sent straight after Stop can't run alongside the old one and race its log write or resume
// the same Claude session.
// A send can be several requests (route, then chat or Claude), and Stop can land between them, so a stopped runId
// is remembered for a minute and any later request with it starts already stopped.
const runs = new Map();
const busy = new Set();
const stoppedEarly = new Set();
function cancelRun(runId) {
  if (!runId) return false;
  if (!stoppedEarly.has(runId)) {
    stoppedEarly.add(runId);
    setTimeout(() => stoppedEarly.delete(runId), 60000).unref();
  }
  const ac = runs.get(runId);
  ac?.abort();
  return !!ac;
}
async function cancellable(runId, lockKey, fn) {
  const id = String(runId || "").slice(0, 64);
  if (stoppedEarly.has(id)) throw Object.assign(new Error("Stopped"), { stopped: true });
  if (lockKey && busy.has(lockKey)) throw Object.assign(new Error("Something is still running in this session; wait for it or stop it"), { status: 409 });
  const ac = new AbortController();
  if (id) runs.set(id, ac);
  if (lockKey) busy.add(lockKey);
  try {
    return await withCancel(ac.signal, fn);
  } catch (err) {
    throw ac.signal.aborted ? Object.assign(new Error("Stopped"), { stopped: true }) : err;
  } finally {
    if (runs.get(id) === ac) runs.delete(id);
    if (lockKey) busy.delete(lockKey);
  }
}

// How the smart router decided, stored on the prompt's log entry so the UI can show it.
function routeMeta(route) {
  if (!route || !["local", "claude"].includes(route.to)) return {};
  return { route: { to: route.to, reason: String(route.reason || "").slice(0, 160), by: String(route.by || "").slice(0, 20), ...(["low", "medium"].includes(route.effort) ? { effort: route.effort } : {}) } };
}

// Claude sessions in this project whose context has grown past the hint threshold, so the page can suggest a new one:
//  - "chat": the session the chat resumes for Claude runs (one per toolset).
//  - "terminal": the latest Claude Code session in the folder (desktop app or terminal), if active in the last day.
function sessionHints(dir, sub) {
  const hints = [];
  const log = loadLog(dir, sub);
  for (const saved of Object.values(log.claude || {})) {
    const size = contextSize(transcriptFor(saved.session, dir));
    if (shouldHint(size)) hints.push({ kind: "chat", tokens: size.tokens, baseline: size.baseline, ...savings(size) });
  }
  // Claude sessions resumed by any of the project's chats (main or sub-sessions) aren't "terminal" sessions.
  const chatSessions = new Set(listSessions(dir).flatMap((s) => Object.values(loadLog(dir, s.id).claude || {}).map((c) => c.session)));
  const latest = recentTranscripts(dir).find((f) => !chatSessions.has(path.basename(f, ".jsonl")));
  const size = latest && contextSize(latest);
  if (shouldHint(size) && Date.now() - Date.parse(size.ts) < 86400e3) {
    hints.push({ kind: "terminal", session: path.basename(latest, ".jsonl"), tokens: size.tokens, baseline: size.baseline, ...savings(size) });
  }
  return hints.sort((a, b) => b.tokens - a.tokens).slice(0, 2);
}

const DEFAULT_PORT = 4317;
const INDEX = path.join(HERE, "ui", "index.html");
const startDir = path.resolve(process.cwd());

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (d) => {
      data += d;
      if (data.length > 2e6) reject(new Error("Request too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function projectParam(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("project must be an absolute path");
  return path.resolve(value);
}

// Sub-session id ("" = main); subId() only accepts [a-z0-9-], so it can't reach outside logs/sessions/.
function subParam(value) {
  if (value != null && typeof value !== "string") throw new Error("sub must be a string");
  return subId(value);
}

async function route(req, res, url) {
  const { pathname } = url;
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return send(res, 200, fs.readFileSync(INDEX, "utf8"), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/api/config") return send(res, 200, { ...effectiveConfig(), startDir });
  if (req.method === "GET" && pathname === "/api/projects") return send(res, 200, allProjects(startDir));
  if (req.method === "GET" && pathname === "/api/progress") {
    return send(res, 200, progress.get(String(url.searchParams.get("id") || "")) || {});
  }
  if (req.method === "GET" && pathname === "/api/usage") return send(res, 200, usage(url.searchParams.get("range") || "7d"));
  if (req.method === "GET" && pathname === "/api/launch-options") {
    return send(res, 200, { claudeModels: CLAUDE_MODELS, startModes: START_MODES, effortLevels: EFFORT_LEVELS });
  }
  if (req.method === "GET" && pathname === "/api/complete") return send(res, 200, completeDir(url.searchParams.get("path")));
  if (req.method === "GET" && pathname === "/api/suggestions") {
    const listed = new Set(allProjects(startDir).map((p) => p.project.toLowerCase()));
    return send(res, 200, claudeCodeProjects().filter((p) => !listed.has(p.toLowerCase())));
  }
  if (req.method === "GET" && pathname === "/api/history") {
    const dir = projectParam(url.searchParams.get("project"));
    const sub = subParam(url.searchParams.get("sub"));
    return send(res, 200, { ...loadLog(dir, sub), sessionHints: sessionHints(dir, sub) });
  }
  if (req.method === "GET" && pathname === "/api/sessions") {
    return send(res, 200, listSessions(projectParam(url.searchParams.get("project"))));
  }
  // GitHub issues of the project's repo, for starting a session on one.
  if (req.method === "GET" && pathname === "/api/issues") {
    const repo = await repoFor(projectParam(url.searchParams.get("project")));
    const issues = await listIssues(repo, { state: url.searchParams.get("state") || "open", search: url.searchParams.get("q") || "" });
    return send(res, 200, { repo, issues: issues.map((i) => ({ ...i, branch: issueBranch(i) })) });
  }
  // One issue as Markdown, trimmed to what a local model's context can take, for planning it locally.
  if (req.method === "GET" && pathname === "/api/issues/view") {
    const repo = await repoFor(projectParam(url.searchParams.get("project")));
    const issue = await getIssue(repo, url.searchParams.get("number"));
    const md = issueMarkdown(repo, issue);
    return send(res, 200, { repo, number: issue.number, title: issue.title, markdown: md.length > 12000 ? `${md.slice(0, 12000)}\n\n[... cut; the full issue is at ${issue.url}]` : md });
  }
  if (req.method === "GET" && pathname === "/api/models") return send(res, 200, await modelsWithRoles());
  if (req.method === "GET" && pathname === "/api/status") return send(res, 200, await checkStatus());

  if (req.method === "POST") {
    // Only same-origin JSON: a browser won't send cross-site application/json without a preflight we never answer.
    if (!String(req.headers["content-type"]).startsWith("application/json")) return send(res, 415, { error: "JSON only" });
    const body = await readBody(req);
    if (pathname === "/api/chat") {
      if (!body.prompt?.trim()) return send(res, 400, { error: "Empty message" });
      const started = Date.now();
      const dir = projectParam(body.project);
      const sub = subParam(body.sub);
      const out = await cancellable(body.runId, `${dir}|${sub}`, async () => {
        // Step-by-step plans: many small questions plus checks (planner.mjs), with progress the page can poll.
        if (body.plan === true && body.stepwise === true) {
          const id = String(body.progressId || "").slice(0, 64);
          try {
            return await planAndLog({
              dir,
              sub,
              prompt: body.prompt,
              model: body.model || undefined,
              useHistory: body.useHistory !== false,
              meta: routeMeta(body.route),
              onProgress: (text) => id && progress.set(id, { text, at: Date.now() }),
            });
          } finally {
            progress.delete(id);
          }
        }
        // Project-aware: gather relevant code on this machine so the local model works from real names.
        let context = null;
        if (body.projectContext === true) {
          try {
            context = await projectContext(dir, body.prompt, { model: body.model || undefined });
          } catch {}
        }
        return chat({
          from: "human",
          prompt: body.prompt,
          model: body.model || undefined,
          useHistory: body.useHistory !== false,
          plan: body.plan === true,
          meta: routeMeta(body.route),
          context,
          dir,
          sub,
        });
      });
      return send(res, 200, { ...out, ms: Date.now() - started });
    }
    // Implement a local plan with Claude, then review (and fix once) per Settings; progress via /api/progress.
    if (pathname === "/api/implement") {
      const dir = projectParam(body.project);
      const sub = subParam(body.sub);
      const planMessage = loadLog(dir, sub).messages.find((m) => m.ts === body.planTs && m.from === "local");
      if (!planMessage) return send(res, 404, { error: "Plan not found in this conversation" });
      const id = String(body.progressId || "").slice(0, 64);
      const reviewMode = ["fix", "review", "off"].includes(body.reviewMode) ? body.reviewMode : "fix";
      try {
        const out = await cancellable(body.runId, `${dir}|${sub}`, () => implementAndReview({
          dir,
          sub,
          planMessage,
          opts: { model: body.model || "", effort: body.effort || "", fast: body.fast === true },
          reviewMode,
          onProgress: (text) => id && progress.set(id, { text, at: Date.now() }),
        }));
        return send(res, 200, {
          stopped: !!(out.impl?.stopped || out.fix?.stopped),
          isError: !!out.impl?.isError,
          problems: out.review?.problems.length ?? null,
          fixed: !!out.fix,
          fixChanged: out.fix ? (out.fix.changedFiles || []).length : null,
          recheckOk: out.recheck ? out.recheck.every((l) => l.ok) : null,
        });
      } finally {
        progress.delete(id);
      }
    }
    if (pathname === "/api/route") {
      if (!body.prompt?.trim()) return send(res, 400, { error: "Empty message" });
      // No lock: routing writes nothing, and the chat or Claude request that follows takes it.
      return send(res, 200, await cancellable(body.runId, "", () => routePrompt(body.prompt, { dir: projectParam(body.project), sub: subParam(body.sub) })));
    }
    if (pathname === "/api/claude") {
      if (!body.prompt?.trim()) return send(res, 400, { error: "Empty message" });
      const dir = projectParam(body.project);
      const sub = subParam(body.sub);
      const out = await cancellable(body.runId, `${dir}|${sub}`, () => runClaude({
        dir,
        sub,
        prompt: body.prompt,
        model: body.model || "",
        // The Plan box is the chat's only plan switch: a "Starts in: Plan mode" setting (meant for new terminal
        // sessions) would otherwise keep every chat run planning with the box unticked.
        mode: body.plan === true ? "plan" : body.mode === "plan" ? "" : body.mode || "",
        effort: body.effort || "",
        autoEffort: body.autoEffort || "",
        logText: typeof body.logText === "string" ? body.logText.slice(0, 300) : "",
        exclude: Array.isArray(body.exclude) ? body.exclude.slice(0, 20).map(String) : [],
        fast: body.fast === true,
        useHistory: body.useHistory !== false,
        meta: routeMeta(body.route),
      }));
      return send(res, 200, out);
    }
    // Stop a running request. Fine to call when it has already finished.
    if (pathname === "/api/cancel") {
      return send(res, 200, { running: cancelRun(String(body.runId || "").slice(0, 64)) });
    }
    if (pathname === "/api/projects/add") return send(res, 200, { project: addProject(body.path) });
    if (pathname === "/api/projects/remove") {
      return send(res, 200, { project: removeProject(projectParam(body.project), { deleteHistory: !!body.deleteHistory }) });
    }
    // Sub-sessions: separate conversations (each with its own Claude session) in one project.
    if (pathname === "/api/sessions/new") {
      return send(res, 200, { sub: createSession(projectParam(body.project), body.name) });
    }
    if (pathname === "/api/sessions/rename") {
      renameSession(projectParam(body.project), subParam(body.sub), body.name);
      return send(res, 200, { ok: true });
    }
    if (pathname === "/api/sessions/delete") {
      deleteSession(projectParam(body.project), subParam(body.sub));
      return send(res, 200, { ok: true });
    }
    if (pathname === "/api/pick-folder") return send(res, 200, { path: await pickFolder() });
    if (pathname === "/api/launch") {
      const dir = projectParam(body.project);
      // Only open terminals in folders that are on the project list.
      if (!isKnownProject(dir, startDir)) return send(res, 400, { error: "Add the folder as a project first" });
      await launchIn(dir, body.what, { model: body.model || "", mode: body.mode || "", effort: body.effort || "", fast: body.fast === true, sub: subParam(body.sub) });
      return send(res, 200, { ok: true });
    }
    // New Claude Code session (Claude, or Claude on the local model) in a terminal, briefed on a GitHub issue.
    if (pathname === "/api/issues/start") {
      const dir = projectParam(body.project);
      if (!isKnownProject(dir, startDir)) return send(res, 400, { error: "Add the folder as a project first" });
      if (!["claude", "local"].includes(body.what)) return send(res, 400, { error: "Start Claude or Claude (local)" });
      const out = await issueSession(dir, body.number, { branch: body.branch !== false });
      await launchIn(dir, body.what, { model: body.model || "", mode: body.mode || "", effort: body.effort || "", fast: body.fast === true, session: out.session, sub: subParam(body.sub) });
      return send(res, 200, { repo: out.repo, number: out.issue.number, title: out.issue.title, branch: out.branch });
    }
    // Forget the chat's Claude sessions: the next Claude run starts fresh, with recent shared messages as background.
    if (pathname === "/api/claude/fresh") {
      const dir = projectParam(body.project);
      const sub = subParam(body.sub);
      const log = loadLog(dir, sub);
      delete log.claude;
      saveLog(log, dir, sub);
      return send(res, 200, { ok: true });
    }
    if (pathname === "/api/handoff") {
      const dir = projectParam(body.project);
      const out = await handoff({ dir, session: String(body.session || ""), sub: subParam(body.sub), model: body.model || undefined });
      // Copied here rather than in the page: the summary takes longer than a browser allows a clipboard write after a click.
      return send(res, 200, { note: out.note, model: out.model, copied: copyToClipboard(out.note) });
    }
    if (pathname === "/api/reset") {
      clearLog(projectParam(body.project), subParam(body.sub));
      return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { error: "Not found" });
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {}
}

function listen(server, port, tries = 10) {
  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE" && tries > 1) resolve(listen(server, port + 1, tries - 1));
      else reject(err);
    });
    server.listen(port, "127.0.0.1", () => resolve(port));
  });
}

export async function startUi({ port = DEFAULT_PORT, open = true } = {}) {
  let actualPort;
  const server = http.createServer(async (req, res) => {
    // Reject other hostnames (DNS rebinding) and cross-site POSTs.
    const allowed = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    if (!allowed.includes(req.headers.host)) return send(res, 403, { error: "Forbidden host" });
    const origin = req.headers.origin;
    if (origin && !allowed.some((h) => origin === `http://${h}`)) return send(res, 403, { error: "Forbidden origin" });
    try {
      await route(req, res, new URL(req.url, `http://${req.headers.host}`));
    } catch (err) {
      send(res, err.status || 500, { error: err.message, ...(err.stopped ? { stopped: true } : {}) });
    }
  });
  // Claude Code and slow local models can take minutes; don't let Node cut requests off at 5.
  server.requestTimeout = 0;
  actualPort = await listen(server, port);
  const url = `http://127.0.0.1:${actualPort}`;
  console.log(`ollama-bridge UI running at ${url}  (Ctrl+C to stop)`);
  console.log(`Current project: ${startDir}`);
  if (open) openBrowser(url);
  return { server, url };
}
