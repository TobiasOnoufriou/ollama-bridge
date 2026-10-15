// Implement a plan with Claude, then have the local model review what actually changed (evaluator-optimizer).
//   1. Snapshot the project's files, run Claude (Auto-accept edits), and work out exactly what changed.
//   2. Review, free and local: one question per plan step ("was this done?", shown only that file's diff), plus
//      code checks: syntax of changed files, new functions nothing calls, files changed that the plan didn't mention.
//   3. Only real problems (a step not done, a syntax error, a new function nothing calls) go back to Claude, once,
//      in the same session (mostly cache reads); then the code checks run again. One round, so cost stays bounded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_MODEL, loadLog, saveLog } from "./lib.mjs";
import { listFiles, readText, cut } from "./context.mjs";
import { ask } from "./planner.mjs";
import { runClaude } from "./claude-run.mjs";

const SNAPSHOT_CHARS = 40_000_000;
const DIFF_CHARS = 6000; // what one step's review sees

// ---------------------------------------------------------------- what changed

export function snapshot(dir) {
  const files = new Map();
  let total = 0;
  for (const f of listFiles(dir)) {
    const text = readText(f.abs);
    if (text == null || total + text.length > SNAPSHOT_CHARS) continue;
    files.set(f.rel, text);
    total += text.length;
  }
  return files;
}

export function changesSince(dir, before) {
  const after = snapshot(dir);
  const out = [];
  for (const [rel, text] of after) {
    if (!before.has(rel)) out.push({ rel, status: "added", before: "", after: text });
    else if (before.get(rel) !== text) out.push({ rel, status: "modified", before: before.get(rel), after: text });
  }
  for (const [rel, text] of before) if (!after.has(rel)) out.push({ rel, status: "deleted", before: text, after: "" });
  return { changes: out, after };
}

// Unified diff of one file, via `git diff --no-index` on temp copies (git is already needed for Claude Code).
let tmpRoot = null;
export function diffOf(change) {
  tmpRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), "ollama-bridge-review-"));
  const a = path.join(tmpRoot, "a.txt"), b = path.join(tmpRoot, "b.txt");
  fs.writeFileSync(a, change.before);
  fs.writeFileSync(b, change.after);
  const r = spawnSync("git", ["diff", "--no-index", "--no-color", "-U3", a, b], { encoding: "utf8" });
  const body = (r.stdout || "").split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).join("\n").trim();
  return `--- ${change.rel} (${change.status})\n${body || (change.status === "added" ? change.after.split("\n").map((l) => `+${l}`).join("\n") : "")}`;
}

// ---------------------------------------------------------------- code checks

const DECL = /^\+\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|def\s+(\w+)|class\s+([A-Za-z_$][\w$]*))/;

function newFunctions(diffs) {
  const names = new Set();
  for (const d of diffs) for (const l of d.split("\n")) {
    const m = l.match(DECL);
    const n = m && (m[1] || m[2] || m[3] || m[4]);
    if (n) names.add(n);
  }
  return [...names];
}

// A new function counts as used if its name appears at least twice in the project (definition + a use).
function unusedFunctions(names, after) {
  return names.filter((n) => {
    const re = new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`, "g");
    let count = 0;
    for (const text of after.values()) count += (text.match(re) || []).length;
    return count < 2;
  });
}

let pythonOk = null;
export function syntaxErrors(dir, changes) {
  const errors = [];
  for (const c of changes.filter((c) => c.status !== "deleted")) {
    const abs = path.join(dir, c.rel);
    if (/\.(m?js|cjs)$/i.test(c.rel)) {
      const r = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8", cwd: dir });
      if (r.status !== 0) {
        // Node prints "<path>:<line>", the code, a caret, then "SyntaxError: ..."; keep the line number and the message.
        const err = r.stderr || "";
        const line = (err.match(/:(\d+)\r?\n/) || [])[1];
        const msg = (err.match(/^(\w*Error: .*)$/m) || [])[1] || err.split("\n").find((l) => l.trim()) || "syntax error";
        errors.push({ file: c.rel, error: `${line ? `line ${line}: ` : ""}${msg.trim()}`.slice(0, 300) });
      }
    } else if (/\.json$/i.test(c.rel)) {
      try {
        JSON.parse(c.after);
      } catch (e) {
        errors.push({ file: c.rel, error: e.message });
      }
    } else if (/\.py$/i.test(c.rel)) {
      if (pythonOk === null) pythonOk = spawnSync("python", ["--version"], { encoding: "utf8" }).status === 0;
      if (!pythonOk) continue;
      const r = spawnSync("python", ["-I", "-m", "py_compile", abs], { encoding: "utf8" });
      if (r.status !== 0) errors.push({ file: c.rel, error: (r.stderr || "").trim().split("\n").slice(-2).join(" ").slice(0, 300) });
    }
  }
  return errors;
}

// Steps from a plan message: "1. `src/store.js`: Add ..." (step-by-step plans) or plain numbered lines.
export function planSteps(plan) {
  const section = (plan.split(/\*\*Steps\*\*|#+\s*Steps|Steps:/i)[1] || plan).split(/\n\s*\*\*|\n#+\s/)[0];
  return section
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s+/.test(l))
    .map((l) => {
      const text = l.replace(/^\d+\.\s+/, "");
      const file = (text.match(/`([^`]+\.[A-Za-z0-9]{1,8})`/) || text.match(/([\w.\-\/]+\.[A-Za-z0-9]{1,8})\b/) || [])[1] || null;
      return { text, file };
    });
}

const STEP_SCHEMA = { type: "object", properties: { done: { type: "boolean" }, evidence: { type: "string" } }, required: ["done", "evidence"] };

// Returns { lines: [{ ok, text }], problems: [string], usage }.
export async function reviewChanges({ dir, plan, changes, after, model = DEFAULT_MODEL, onProgress = () => {} }) {
  const usage = { in: 0, out: 0, ms: 0 };
  const lines = [], problems = [];
  const diffs = new Map(changes.map((c) => [c.rel, diffOf(c)]));
  const steps = planSteps(plan);
  const byFile = (file) => (file ? changes.find((c) => c.rel === file || c.rel.endsWith(`/${file}`) || file.endsWith(c.rel)) : null);

  if (!changes.length) {
    return { lines: [{ ok: false, text: "No files changed" }], problems: ["No files were changed, so none of the plan was carried out."], usage };
  }

  // One question per step, shown only the diff of that step's file.
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    onProgress(`Reviewing step ${i + 1} of ${steps.length}`);
    const c = byFile(s.file);
    if (s.file && !c) {
      lines.push({ ok: false, text: `Step ${i + 1} not done: \`${s.file}\` wasn't changed (${cut(s.text, 120)})` });
      problems.push(`Step ${i + 1} wasn't done: ${s.text}`);
      continue;
    }
    const shown = c ? cut(diffs.get(c.rel), DIFF_CHARS) : cut([...diffs.values()].join("\n\n"), DIFF_CHARS);
    const r = await ask(
      model,
      "You check whether one step of a plan was carried out, using only the diff shown (lines starting with + were " +
        "added, - removed). done=true only if the diff clearly does what the step asks. evidence: one short sentence " +
        "naming the code that shows it, or what is missing.",
      `Step: ${s.text}\n\nDiff:\n${shown}`,
      STEP_SCHEMA,
      { numPredict: 200 },
    );
    usage.in += r.usage.in;
    usage.out += r.usage.out;
    usage.ms += r.usage.ms;
    let done = r.json.done !== false;
    let evidence = r.json.evidence || s.text;
    if (!done) {
      // Small models misread steps (it once wanted an Undo button on unfinished tasks too). Before calling it a
      // problem, ask differently: quote the added code that does the step. Only "nothing" counts as not done.
      onProgress(`Double-checking step ${i + 1}`);
      const q = await ask(
        model,
        "Find the added lines (starting with +) in the diff that carry out the step. Judge only what the step " +
          "literally says, not extra things it doesn't mention. found=false only if no added line does it at all.",
        `Step: ${s.text}\n\nDiff:\n${shown}`,
        { type: "object", properties: { found: { type: "boolean" }, line: { type: "string" } }, required: ["found", "line"] },
        { numPredict: 200 },
      );
      usage.in += q.usage.in;
      usage.out += q.usage.out;
      usage.ms += q.usage.ms;
      if (q.json.found === true && q.json.line) {
        done = true;
        const line = q.json.line.trim().replace(/\s+/g, " ");
        evidence = `found on a second check: ${line.length > 120 ? `${line.slice(0, 117)}…` : line}`;
      }
    }
    lines.push({ ok: done, text: `Step ${i + 1} ${done ? "done" : "not done"}: ${cut(evidence, 200)}` });
    if (!done) problems.push(`Step ${i + 1} looks incomplete: ${s.text}. Reviewer: ${r.json.evidence || "not found in the diff"}`);
  }

  onProgress("Running code checks");
  const errs = syntaxErrors(dir, changes);
  if (errs.length) for (const e of errs) {
    lines.push({ ok: false, text: `Syntax error in \`${e.file}\`: ${e.error}` });
    problems.push(`Syntax error in ${e.file}: ${e.error}`);
  } else lines.push({ ok: true, text: "Changed files pass a syntax check" });

  const added = newFunctions([...diffs.values()]);
  const unused = unusedFunctions(added, after);
  if (added.length) {
    if (unused.length) {
      lines.push({ ok: false, text: `New functions nothing calls yet: ${unused.join(", ")}` });
      problems.push(
        `These new functions are defined but nothing calls them: ${unused.join(", ")}. Connect each one where the ` +
          "plan needs it; if the plan doesn't need it, remove it.",
      );
    } else lines.push({ ok: true, text: `New functions are used: ${added.join(", ")}` });
  }

  const planned = new Set(steps.map((s) => byFile(s.file)?.rel).filter(Boolean));
  const extra = changes.filter((c) => !planned.has(c.rel)).map((c) => c.rel);
  if (steps.some((s) => s.file) && extra.length) lines.push({ ok: false, text: `Changed but not in the plan (check these are wanted): ${extra.join(", ")}` });
  lines.push({ ok: true, text: `${changes.length} file${changes.length === 1 ? "" : "s"} changed: ${changes.map((c) => `${c.rel}${c.status === "modified" ? "" : ` (${c.status})`}`).join(", ")}` });

  return { lines, problems, usage };
}

const reviewMarkdown = (title, lines) => `**${title}**\n${lines.map((l) => `- ${l.ok ? "✓" : "⚠"} ${l.text}`).join("\n")}`;

// The whole loop. opts: Claude options (model, effort, fast); reviewMode: "fix" (review, fix once) | "review" | "off".
// sub: the sub-session the plan is in; Claude's runs and the review are logged there.
export async function implementAndReview({ dir, sub = "", planMessage, opts = {}, reviewMode = "fix", reviewModel = DEFAULT_MODEL, onProgress = () => {} }) {
  dir = path.resolve(dir);
  const plan = planMessage.content;
  const before = reviewMode === "off" ? null : snapshot(dir);

  onProgress("Claude Code is implementing the plan");
  const impl = await runClaude({
    dir,
    sub,
    prompt:
      "Carry out this plan, written by a local model from excerpts of this project. Check file and function names " +
      "against the real code first; where the plan is wrong or incomplete, follow the code and say what you changed. " +
      `Finish with a short summary of the edits.\n\n<plan>\n${plan}\n</plan>`,
    logText: `Implement the plan above${planMessage.model ? ` (from ${planMessage.model})` : ""}`,
    mode: "acceptEdits",
    model: opts.model || "",
    effort: opts.effort || "medium",
    fast: opts.fast === true,
    meta: { route: { to: "claude", reason: "implementing the local plan", by: "you" } },
    exclude: [planMessage.ts],
    onProgress: (t) => onProgress(`Claude Code is implementing the plan: ${t}`),
  });
  if (reviewMode === "off" || impl.isError) return { impl };

  const { changes, after } = changesSince(dir, before);
  const review = await reviewChanges({ dir, plan, changes, after, model: reviewModel, onProgress });
  const total = { ...review.usage };
  let fix = null, recheck = null;

  const verdict = review.problems.length ? `${review.problems.length} problem${review.problems.length === 1 ? "" : "s"} found` : "everything checks out";
  const reviewTs = postLocal(dir, sub, reviewModel, `${reviewMarkdown(`Review of Claude's changes: ${verdict}`, review.lines)}${
    review.problems.length && reviewMode === "fix" ? "\n\nSending these to Claude to fix (one round)." : ""}`, total);

  if (review.problems.length && reviewMode === "fix") {
    onProgress(`Claude Code is fixing ${review.problems.length} problem${review.problems.length === 1 ? "" : "s"}`);
    fix = await runClaude({
      dir,
      sub,
      prompt:
        "A review of the changes you just made for the plan found these problems. Fix only these, then reply with " +
        `a one-line summary per fix. If one is a false alarm, say why instead of changing code.\n\n${review.problems.map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
      logText: `Fix the ${review.problems.length} problem${review.problems.length === 1 ? "" : "s"} the review found`,
      mode: "acceptEdits",
      model: opts.model || "",
      effort: opts.effort || "medium",
      fast: opts.fast === true,
      meta: { route: { to: "claude", reason: "fixing review findings", by: "you" } },
      exclude: [reviewTs], // the problems are already in the prompt
      onProgress: (t) => onProgress(`Claude Code is fixing: ${t}`),
    });
    // Re-check in code only (no second fix round): syntax, unused functions, and steps whose file still didn't change.
    onProgress("Re-checking after the fix");
    const again = changesSince(dir, before);
    const diffs = again.changes.map(diffOf);
    const lines = [];
    // Did the fix round change anything? If not, Claude judged the findings to be false alarms.
    const touched = [...again.after].filter(([rel, text]) => after.get(rel) !== text).map(([rel]) => rel);
    fix.changedFiles = touched;
    lines.push(touched.length
      ? { ok: true, text: `Claude's fix changed: ${touched.join(", ")}` }
      : { ok: true, text: "Claude's fix changed no files (it judged the findings to be false alarms; see its reply)" });
    const errs = syntaxErrors(dir, again.changes);
    lines.push(errs.length ? { ok: false, text: `Still a syntax error: ${errs.map((e) => e.file).join(", ")}` } : { ok: true, text: "Changed files pass a syntax check" });
    const unused = unusedFunctions(newFunctions(diffs), again.after);
    lines.push(unused.length ? { ok: false, text: `Still nothing calls: ${unused.join(", ")}` } : { ok: true, text: "No new functions left unused" });
    const missing = planSteps(plan).filter((s) => s.file && !again.changes.some((c) => c.rel === s.file || c.rel.endsWith(`/${s.file}`)));
    lines.push(missing.length ? { ok: false, text: `Planned files still unchanged: ${missing.map((s) => s.file).join(", ")}` } : { ok: true, text: "Every planned file was changed" });
    recheck = lines;
    postLocal(dir, sub, reviewModel, reviewMarkdown("Re-check after Claude's fix", lines), { in: 0, out: 0, ms: 0 });
  }
  return { impl, review, fix, recheck };
}

// Returns the message timestamp.
function postLocal(dir, sub, model, content, usage) {
  const log = loadLog(dir, sub);
  const ts = new Date().toISOString();
  log.messages.push({ from: "local", model, content, ts, mode: "review", usage });
  saveLog(log, dir, sub);
  return ts;
}
