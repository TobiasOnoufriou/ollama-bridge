// Step-by-step planning for local models.
// A 14B model asked for a whole plan in one go drops steps (it once changed the data and the route but forgot the
// button on the page). Following the Minions paper's finding that small models do best on single-step questions
// over short text, the plan is built from small questions instead, then checked:
//   1. Scope       which files and functions are involved (from the project outline)
//   2. Per file    what changes in this one file (only that file is shown)
//   3. Ripple      every other place that uses what changes is found by search, and each is asked
//                  "does this need to change too?"
//   4. Checks      code checks (named functions exist, new functions are used, ripple places considered)
//                  plus a checklist pass (UI covered? wiring? edge cases? tests and docs?)
//   5. Write-up    the findings become the plan; anything the checks flagged is listed at the end
// Every call returns JSON forced to a schema (Ollama structured outputs), so replies can't be malformed.
import path from "node:path";
import { OLLAMA_URL, DEFAULT_MODEL, loadLog, saveLog, projectDir, defaultSub } from "./lib.mjs";
import { updateIndex, outlineText, pickFiles, definition, readText, cut } from "./context.mjs";

const FILE_CHARS = 12000; // what one per-file question sees
const MAX_SCOPE = 6;
const MAX_RIPPLE = 5;

export async function ask(model, system, user, schema, { numPredict = 700 } = {}) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model,
      stream: false,
      format: schema,
      think: false,
      options: { temperature: 0, num_predict: numPredict, num_ctx: 16384 },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let json = {};
  try {
    json = JSON.parse(data.message?.content || "{}");
  } catch {}
  return { json, usage: { in: data.prompt_eval_count || 0, out: data.eval_count || 0, ms: Math.round((data.total_duration || 0) / 1e6) } };
}

const str = { type: "string" };
const arr = (items) => ({ type: "array", items });
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties) });

const FILE_SCHEMA = obj({
  relevant: { type: "boolean" },
  changes: arr(obj({ what: str, where: str })),
  new_functions: arr(str),
  affects: arr(str),
});
const RIPPLE_SCHEMA = obj({ needs_change: { type: "boolean" }, what: str, where: str });
const CHECK_SCHEMA = obj({ answers: arr(obj({ question: str, ok: { type: "boolean" }, problem: str, fix: str })) });
const PLAN_SCHEMA = obj({ // goal, assumptions, risks, verify (steps are built in code)
  goal: str,
  assumptions: arr(str),
  steps: arr(obj({ file: str, change: str })),
  risks: arr(str),
  verify: arr(str),
});

// Judgement questions for the model. (Tests are checked in code instead: asked, the model invents test files.)
const CHECKLIST = [
  "Does the change affect something the user sees or does, and does the plan change the UI (page, button, form, CLI output) for it?",
  "Is every new function, route or field connected end to end: defined, exported/imported, and called from where it's needed?",
  "Are edge cases handled: the item doesn't exist, is already in that state, or the input is empty?",
];
// Files worth a ripple check: code and templates, not package manifests or docs.
const RIPPLE_FILE = /\.(m?[jt]sx?|cjs|vue|svelte|astro|py|rb|go|rs|java|kt|cs|php|swift|dart|html?|css|scss|sql)$/i;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$/i;

const codeIds = (s) => [...new Set((String(s).match(/[A-Za-z_$][\w$]{2,}/g) || []).filter((w) => /[a-z][A-Z]|_|\d|\$/.test(w) || /^[a-z]+$/.test(w)))];

// Lines in a file that use any of the identifiers, with a little surrounding code.
function usages(text, ids) {
  const lines = text.split("\n");
  const hits = [];
  lines.forEach((l, i) => {
    const found = ids.filter((id) => new RegExp(`\\b${id.replace(/\$/g, "\\$")}\\b`).test(l));
    if (found.length) hits.push({ line: i + 1, found });
  });
  if (!hits.length) return null;
  const shown = new Set();
  for (const h of hits.slice(0, 6)) for (let k = Math.max(0, h.line - 4); k < Math.min(lines.length, h.line + 3); k++) shown.add(k);
  let last = -2, out = "";
  for (const k of [...shown].sort((a, b) => a - b)) {
    if (k !== last + 1) out += `… line ${k + 1}:\n`;
    out += `${lines[k]}\n`;
    last = k;
  }
  return { count: hits.length, ids: [...new Set(hits.flatMap((h) => h.found))], excerpt: out };
}

// Returns { plan, sources, checks, usage, ms }. onProgress(text) reports each step.
export async function stepwisePlan({ dir = projectDir(), request, model = DEFAULT_MODEL, history = [], onProgress = () => {} }) {
  const started = Date.now();
  dir = path.resolve(dir);
  const total = { in: 0, out: 0, ms: 0 };
  const run = async (...a) => {
    const r = await ask(...a);
    total.in += r.usage.in;
    total.out += r.usage.out;
    total.ms += r.usage.ms;
    return r.json;
  };
  const recent = history.slice(-4).map((m) => `[${m.from}] ${cut(m.content, 600)}`).join("\n");
  const background = recent ? `\n\nRecent conversation, for background:\n${recent}` : "";

  // ---- 1. Scope
  onProgress("Reading the project outline");
  const { idx } = await updateIndex(dir);
  const rels = Object.keys(idx.files);
  if (!rels.length) throw new Error("No source files found in this project.");
  const lower = new Map(rels.map((r) => [r.toLowerCase(), r]));
  const resolve = (p) => lower.get(String(p).replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase());
  const scope = new Map(); // rel -> why
  for (const tok of request.match(/[\w.\-\/\\]+\.[A-Za-z0-9]{1,8}\b/g) || []) {
    const hit = resolve(tok) || rels.find((r) => r.toLowerCase().endsWith("/" + tok.toLowerCase()));
    if (hit) scope.set(hit, "you named it");
  }
  onProgress("Step 1: choosing the files involved");
  let picked = { files: [], functions: [], search: [] };
  try {
    picked = await pickFiles(request + background, outlineText(idx, 12000, 40), model);
  } catch {}
  for (const f of picked.files) {
    const hit = resolve(f);
    if (hit && !scope.has(hit) && scope.size < MAX_SCOPE) scope.set(hit, "picked from the project outline");
  }
  if (!scope.size) throw new Error("Couldn't work out which files this involves; name a file in your message.");

  // ---- 2. Per file: one question, one file
  const findings = []; // { file, why, changes, new_functions, affects }
  const sources = [];
  let n = 0;
  for (const [rel, why] of scope) {
    n++;
    onProgress(`Step 2: what changes in ${rel} (${n} of ${scope.size})`);
    const text = readText(path.join(dir, rel));
    if (!text) continue;
    let shown = text;
    if (text.length > FILE_CHARS) {
      // Large file: the picked functions in full, then as much of the file as fits.
      const defs = picked.functions.map((f) => definition(text, f)).filter(Boolean);
      shown = defs.map((d) => `… lines ${d.start}-${d.end}:\n${d.body}`).join("\n");
      shown = cut(`${shown}\n${text}`, FILE_CHARS);
    }
    sources.push({ path: rel, why });
    const j = await run(
      model,
      "You are planning one part of a code change. Look ONLY at the one file shown and answer about this file alone. " +
        "List each concrete change this file needs for the request (what, and where: the existing function, or " +
        "'new'), any new functions it should get, and the names of functions, fields, routes or CSS classes whose " +
        "behaviour the change affects (so other code that uses them can be checked). If the file needs no change, " +
        "say relevant=false. Use the exact names in the file.",
      `Request: ${request}${background}\n\nOther files in scope: ${[...scope.keys()].filter((r) => r !== rel).join(", ") || "none"}\n\nFile ${rel}:\n${shown}`,
      FILE_SCHEMA,
    );
    findings.push({ file: rel, why, ...j, changes: j.relevant === false ? [] : j.changes || [] });
  }

  // ---- 3. Ripple: find every other place that uses what changes, ask about each one
  const changed = findings.filter((f) => f.changes?.length);
  const ids = [
    ...new Set(
      changed.flatMap((f) => [...(f.affects || []), ...f.changes.map((c) => c.where), ...(f.new_functions || [])].flatMap(codeIds)),
    ),
  ]
    .filter((id) => id.length > 2 && !/^(new|the|and|function|file|none|true|false|null|return|const|this)$/i.test(id))
    .slice(0, 12);
  const rippleCandidates = [];
  for (const rel of rels) {
    // Files read in full in step 2 have been considered already; manifests and docs aren't code that breaks.
    if (scope.has(rel) || !RIPPLE_FILE.test(rel)) continue;
    const text = readText(path.join(dir, rel));
    if (!text) continue;
    const u = usages(text, ids);
    if (u) rippleCandidates.push({ rel, ...u });
  }
  rippleCandidates.sort((a, b) => b.count - a.count);
  const ripple = []; // { file, ids, needs_change, what, where }
  const summary = changed.map((f) => `${f.file}: ${f.changes.map((c) => `${c.what} (${c.where})`).join("; ")}`).join("\n");
  const newNames = changed.flatMap((f) => (f.new_functions || []).map((fn) => `${fn} (in ${f.file})`)).join(", ");
  n = 0;
  for (const c of rippleCandidates.slice(0, MAX_RIPPLE)) {
    n++;
    onProgress(`Step 3: does ${c.rel} need to change too? (${n} of ${Math.min(rippleCandidates.length, MAX_RIPPLE)})`);
    const j = await run(
      model,
      "A code change is planned. You are shown places in ONE other file that use names affected by it. Decide " +
        "whether this file must also change for the request to fully work (for example a page that must show a new " +
        "button, a route that must call a new function, a caller that must pass a new argument). If it does, 'what' " +
        "is one concrete sentence naming the new or changed code (e.g. 'Add a POST /tasks/:id/undo route that calls " +
        "undoTask'), and 'where' is the existing function or block it goes in. Answer about this file only.",
      `Request: ${request}\n\nPlanned changes:\n${summary || "(none yet)"}\n\nNew functions being added: ${newNames || "none"}\n\nNames affected: ${c.ids.join(", ")}\n\nUses in ${c.rel}:\n${c.excerpt}`,
      RIPPLE_SCHEMA,
      { numPredict: 300 },
    );
    ripple.push({ file: c.rel, ids: c.ids, ...j });
    if (!sources.some((s) => s.path === c.rel)) sources.push({ path: c.rel, why: `uses ${c.ids.slice(0, 3).join(", ")}` });
  }
  for (const r of ripple.filter((r) => r.needs_change)) {
    const f = findings.find((x) => x.file === r.file);
    // A vague answer ("server.js") still records that the file must change, with what it has to work with.
    const vague = !r.what || r.what.trim().length < 12 || r.what.trim() === r.file;
    const what = vague ? `Update to work with the change (it uses ${r.ids.slice(0, 4).join(", ")})` : r.what;
    const change = { what, where: r.where && r.where !== r.file && !/line \d+/.test(r.where) ? r.where : "?", fromRipple: true };
    if (f) f.changes = [...(f.changes || []), change];
    else findings.push({ file: r.file, why: "uses what changes", changes: [change], new_functions: [], affects: [] });
  }

  // ---- 4. Checks: in code first, then a checklist pass
  onProgress("Step 4: checking the plan");
  const checks = []; // { ok, text }
  const allChanges = findings.flatMap((f) => (f.changes || []).map((c) => ({ ...c, file: f.file })));
  // Existing functions named in the plan must exist where it says.
  const missing = [];
  for (const c of allChanges) {
    const name = String(c.where || "").replace(/\(.*$/, "").trim();
    if (!name || /^(new|\?|top|none|file|global)/i.test(name) || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    const text = readText(path.join(dir, c.file)) || "";
    if (!new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(text)) missing.push(`${name} in ${c.file}`);
  }
  checks.push(missing.length
    ? { ok: false, text: `Not found in the code, check these names: ${missing.join(", ")}` }
    : { ok: true, text: "Every existing function the plan names was found in its file" });
  // A new function should be used by a change in some other file (otherwise nothing calls it).
  const newFns = [...new Set(findings.flatMap((f) => f.new_functions || []).map((s) => s.replace(/\(.*$/, "").trim()).filter(Boolean))];
  const unused = newFns.filter((fn) => {
    const home = findings.filter((f) => (f.new_functions || []).some((x) => x.includes(fn))).map((f) => f.file);
    return !allChanges.some((c) => !home.includes(c.file) && `${c.what} ${c.where}`.includes(fn));
  });
  if (newFns.length) {
    checks.push(unused.length
      ? { ok: false, text: `New functions that no other step uses yet (should something call them?): ${unused.join(", ")}` }
      : { ok: true, text: `New functions are used by another step: ${newFns.join(", ")}` });
  }
  if (ripple.length) {
    checks.push({
      ok: true,
      text: `Checked ${ripple.length} other place${ripple.length === 1 ? "" : "s"} that use what changes: ` +
        ripple.map((r) => `${r.file} (${r.needs_change ? "needs a change, added" : "no change"})`).join(", "),
    });
  }
  if (rippleCandidates.length > MAX_RIPPLE) {
    checks.push({ ok: false, text: `${rippleCandidates.length - MAX_RIPPLE} more files use these names and weren't checked: ${rippleCandidates.slice(MAX_RIPPLE, MAX_RIPPLE + 5).map((c) => c.rel).join(", ")}` });
  }
  const draft = findings
    .filter((f) => f.changes?.length)
    .map((f) => `${f.file}:\n${f.changes.map((c) => `- ${c.what} (${c.where})`).join("\n")}`)
    .join("\n");
  const outlineShort = outlineText(idx, 4000);
  const cl = await run(
    model,
    "You review a planned code change against a checklist. For each question, answer ok=true if the plan already " +
      "covers it (or it doesn't apply), otherwise ok=false with the problem and a concrete fix naming real files " +
      "from the project outline.",
    `Request: ${request}\n\nPlanned changes:\n${draft || "(none)"}\n\nProject outline:\n${outlineShort}\n\nChecklist:\n${CHECKLIST.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
    CHECK_SCHEMA,
  );
  // Flag any file a suggestion names that doesn't exist, so an invented path can't pass as real.
  // Only real-looking file paths (a known extension, not a method call like task.find(...)) are checked.
  const FILE_EXT = /\.(m?[jt]sx?|cjs|py|rb|go|rs|java|kt|cs|php|swift|vue|svelte|html?|css|scss|json|ya?ml|toml|md|sql|sh)$/i;
  const markUnknownFiles = (s) =>
    s.replace(/`?([\w.\-\/]+)`?(?!\s*\()/g, (m, p) => (!FILE_EXT.test(p) || resolve(p) ? m : `${m} (not in this project)`));
  // Keep a check to one readable line: no code samples, at most about two sentences.
  const oneLine = (s) => {
    const t = String(s).replace(/```[\s\S]*?(```|$)/g, " ").replace(/\s+/g, " ").trim();
    return t.length > 260 ? `${t.slice(0, 257).replace(/\s\S*$/, "")}…` : t;
  };
  for (const a of cl.answers || []) {
    if (a.ok === false && a.problem) checks.push({ ok: false, text: markUnknownFiles(oneLine(`${a.problem}${a.fix ? ` Fix: ${a.fix}` : ""}`)) });
    else if (a.question) checks.push({ ok: true, text: `${a.question.replace(/\?.*$/, "?")} Covered.` });
  }

  // Tests, in code: do test files exist, and do any use what changes?
  const tests = rels.filter((r) => TEST_FILE.test(r));
  if (!tests.length) checks.push({ ok: true, text: "No test files in this project, so none to update" });
  else {
    const touched = tests.filter((t) => usages(readText(path.join(dir, t)) || "", ids));
    checks.push(touched.length
      ? { ok: false, text: `Tests that use what changes, update them too: ${touched.join(", ")}` }
      : { ok: true, text: `None of the ${tests.length} test files use what changes` });
  }

  // ---- 5. Write-up. The steps come straight from the findings, in code, so none can be dropped or invented;
  // the model only writes the goal, assumptions, risks and how to verify.
  onProgress("Step 5: writing the plan");
  const order = [...scope.keys(), ...findings.map((f) => f.file)];
  const steps = findings
    .slice()
    .sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file))
    .flatMap((f) =>
      (f.changes || []).map((c) => {
        const isNew = /^new\b/i.test(c.where || "");
        // Name the new function when the step doesn't ("Add a new function to undo a task" -> "(new: undoTask)").
        const named = (f.new_functions || []).find((fn) => !c.what.includes(fn));
        const spot = String(c.where || "").replace(/\s+(function|method)$/i, "");
        const where = isNew ? (named ? ` (new: \`${named}\`)` : " (new)") : spot && spot !== "?" ? ` (in \`${spot}\`)` : "";
        return `\`${f.file}\`: ${c.what}${where}`;
      }),
    );
  const p = await run(
    model,
    "You are given a request and the steps of a plan for it. Write the goal (one sentence), any assumptions or " +
      "open questions, risks, and how to verify it works. Don't contradict the steps or add new ones.",
    `Request: ${request}\n\nSteps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n") || "(none)"}`,
    PLAN_SCHEMA,
    { numPredict: 600 },
  );

  const md = [
    `**Goal:** ${p.goal || request}`,
    p.assumptions?.length ? `**Questions / assumptions**\n${p.assumptions.map((a) => `- ${a}`).join("\n")}` : "",
    `**Steps**\n${steps.length ? steps.map((s, i) => `${i + 1}. ${s}`).join("\n") : "No changes found; try naming the files involved."}`,
    p.risks?.length ? `**Risks**\n${p.risks.map((r) => `- ${r}`).join("\n")}` : "",
    p.verify?.length ? `**How to verify**\n${p.verify.map((v) => `- ${v}`).join("\n")}` : "",
    `**Checks**\n${checks.map((c) => `- ${c.ok ? "✓" : "⚠"} ${c.text}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");

  return { plan: md, sources, checks, usage: total, ms: Date.now() - started };
}

// Plan and record it in the shared log like any local reply (the code it read isn't stored, just the file list).
export async function planAndLog({ dir = projectDir(), sub = defaultSub(), prompt, model = DEFAULT_MODEL, useHistory = true, meta = {}, onProgress }) {
  const log = loadLog(dir, sub);
  const entry = { from: "human", content: prompt, ts: new Date().toISOString(), mode: "plan", ...meta };
  const r = await stepwisePlan({ dir, request: prompt, model, history: useHistory ? log.messages : [], onProgress });
  const fresh = loadLog(dir, sub);
  fresh.messages.push(
    { ...entry, context: r.sources },
    { from: "local", model, content: r.plan, ts: new Date().toISOString(), mode: "plan", stepwise: true, usage: r.usage },
  );
  saveLog(fresh, dir, sub);
  return { reply: r.plan, model, usage: r.usage, checks: r.checks };
}
