// Local web UI for ollama-bridge: `ollama-bridge ui`. Listens on 127.0.0.1 only.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { HERE } from "./config.mjs";
import { chat, loadLog, saveLog } from "./lib.mjs";
import { checkStatus, modelsWithRoles, effectiveConfig } from "./status.mjs";
import { allProjects, addProject, removeProject, isKnownProject, claudeCodeProjects, completeDir } from "./projects.mjs";
import { pickFolder, launchIn, CLAUDE_MODELS, START_MODES, EFFORT_LEVELS } from "./launch.mjs";
import { routePrompt } from "./router.mjs";
import { runClaude } from "./claude-run.mjs";
import { usage } from "./usage.mjs";
import { projectContext } from "./context.mjs";

// How the smart router decided, stored on the prompt's log entry so the UI can show it.
function routeMeta(route) {
  if (!route || !["local", "claude"].includes(route.to)) return {};
  return { route: { to: route.to, reason: String(route.reason || "").slice(0, 160), by: String(route.by || "").slice(0, 20), ...(["low", "medium"].includes(route.effort) ? { effort: route.effort } : {}) } };
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

async function route(req, res, url) {
  const { pathname } = url;
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return send(res, 200, fs.readFileSync(INDEX, "utf8"), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/api/config") return send(res, 200, { ...effectiveConfig(), startDir });
  if (req.method === "GET" && pathname === "/api/projects") return send(res, 200, allProjects(startDir));
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
    return send(res, 200, loadLog(projectParam(url.searchParams.get("project"))));
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
      // Project-aware: gather relevant code on this machine so the local model works from real names.
      let context = null;
      if (body.projectContext === true) {
        try {
          context = await projectContext(dir, body.prompt, { model: body.model || undefined });
        } catch {}
      }
      const out = await chat({
        from: "human",
        prompt: body.prompt,
        model: body.model || undefined,
        useHistory: body.useHistory !== false,
        plan: body.plan === true,
        meta: routeMeta(body.route),
        context,
        dir,
      });
      return send(res, 200, { ...out, ms: Date.now() - started });
    }
    if (pathname === "/api/route") {
      if (!body.prompt?.trim()) return send(res, 400, { error: "Empty message" });
      return send(res, 200, await routePrompt(body.prompt, { dir: projectParam(body.project) }));
    }
    if (pathname === "/api/claude") {
      if (!body.prompt?.trim()) return send(res, 400, { error: "Empty message" });
      const out = await runClaude({
        dir: projectParam(body.project),
        prompt: body.prompt,
        model: body.model || "",
        mode: body.plan === true ? "plan" : body.mode || "",
        effort: body.effort || "",
        autoEffort: body.autoEffort || "",
        logText: typeof body.logText === "string" ? body.logText.slice(0, 300) : "",
        exclude: Array.isArray(body.exclude) ? body.exclude.slice(0, 20).map(String) : [],
        fast: body.fast === true,
        useHistory: body.useHistory !== false,
        meta: routeMeta(body.route),
      });
      return send(res, 200, out);
    }
    if (pathname === "/api/projects/add") return send(res, 200, { project: addProject(body.path) });
    if (pathname === "/api/projects/remove") {
      return send(res, 200, { project: removeProject(projectParam(body.project), { deleteHistory: !!body.deleteHistory }) });
    }
    if (pathname === "/api/pick-folder") return send(res, 200, { path: await pickFolder() });
    if (pathname === "/api/launch") {
      const dir = projectParam(body.project);
      // Only open terminals in folders that are on the project list.
      if (!isKnownProject(dir, startDir)) return send(res, 400, { error: "Add the folder as a project first" });
      await launchIn(dir, body.what, { model: body.model || "", mode: body.mode || "", effort: body.effort || "", fast: body.fast === true });
      return send(res, 200, { ok: true });
    }
    if (pathname === "/api/reset") {
      const dir = projectParam(body.project);
      saveLog({ project: dir, messages: [] }, dir);
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
      send(res, 500, { error: err.message });
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
