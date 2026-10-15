// Project context for the local model, which has no tools and can't open files itself.
// Before a local plan, the bridge gathers relevant code on this machine and attaches it, in three ways:
//  1. Picked: the local model reads an outline of the project (files + their functions/classes) and chooses
//     the files that matter. It reasons about structure, so "login" can lead to auth/session.js.
//  2. Meaning: code chunks are embedded with a small embedding model and matched to the request by meaning,
//     so related code is found even when it shares no words with it.
//  3. Keywords: plain text search for words and identifiers from the request (and from the picker), as a backstop.
// Files you name in the message are always attached in full. Nothing here uses Claude.
import fs from "node:fs";
import path from "node:path";
import { HERE, loadConfig } from "./config.mjs";
import { OLLAMA_URL, DEFAULT_MODEL, cancelSignal } from "./lib.mjs";

export const EMBED_MODEL = process.env.OLLAMA_BRIDGE_EMBED_MODEL || loadConfig().embedModel || "nomic-embed-text";
const INDEX_DIR = path.join(HERE, "logs", "index");
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 200_000;
const MAX_CHUNKS = 4000;
const CHUNK_LINES = 40;
const CHUNK_STEP = 30;

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", "target", "vendor",
  "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", "coverage", ".cache", ".idea", ".vscode",
  "bin", "obj", ".gradle", ".dart_tool", "Pods", ".terraform",
]);
const TEXT_EXT = new Set(
  ("js mjs cjs jsx ts tsx vue svelte astro py rb go rs java kt kts scala cs fs vb cpp cc cxx c h hpp hh m mm swift dart " +
    "php pl lua r jl ex exs erl hs elm clj sh bash zsh ps1 psm1 cmd bat sql graphql gql proto html htm css scss sass less " +
    "json jsonc yaml yml toml ini cfg conf env xml md mdx rst txt gradle csproj sln tf hcl dockerfile makefile").split(" "),
);
const NO_EXT_NAMES = new Set(["dockerfile", "makefile", "rakefile", "gemfile", "procfile", "justfile"]);
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|poetry\.lock|composer\.lock|.*\.min\.(js|css)|.*\.map)$/i;

// ---------------------------------------------------------------- listing files

// Top-level .gitignore, simple patterns only (enough to skip build output and secrets; negations are ignored).
function gitignoreMatcher(dir) {
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(dir, ".gitignore"), "utf8").split(/\r?\n/);
  } catch {}
  const res = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((p) => {
      const anchored = p.startsWith("/");
      const body = p.replace(/^\//, "").replace(/\/$/, "");
      const re = body
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0000/g, ".*");
      return new RegExp(anchored ? `^${re}(/|$)` : `(^|/)${re}(/|$)`, process.platform === "win32" ? "i" : "");
    });
  return (rel) => res.some((re) => re.test(rel));
}

function isTextFile(name) {
  const lower = name.toLowerCase();
  if (NO_EXT_NAMES.has(lower)) return true;
  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  return TEXT_EXT.has(ext);
}

export function listFiles(dir) {
  const ignored = gitignoreMatcher(dir);
  const out = [];
  const walk = (abs, rel) => {
    if (out.length >= MAX_FILES) return;
    let entries = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || (e.name.startsWith(".") && e.name !== ".github") || ignored(r)) continue;
        walk(path.join(abs, e.name), r);
      } else if (e.isFile() && isTextFile(e.name) && !SKIP_FILES.test(r) && !ignored(r) && !/^\.env/i.test(e.name)) {
        let st;
        try {
          st = fs.statSync(path.join(abs, e.name));
        } catch {
          continue;
        }
        if (st.size > 0 && st.size <= MAX_FILE_BYTES) out.push({ rel: r, abs: path.join(abs, e.name), size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(path.resolve(dir), "");
  return out;
}

// ---------------------------------------------------------------- outline

const SYMBOL_RES = [
  /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)\n]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  /(?:^|\n)\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|\n)\s*(?:async\s+)?def\s+(\w+)/g,
  /(?:^|\n)func\s+(?:\([^)]*\)\s*)?(\w+)/g,
  /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/g,
  /(?:^|\n)\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+(\w+)/g,
  /(?:^|\n)\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?[\w<>\[\],? ]+\s+(\w+)\s*\(/g,
  /(?:^|\n)#{1,3}\s+(.{3,60})/g, // markdown headings
];

function outline(text) {
  const names = new Set();
  for (const re of SYMBOL_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) && names.size < 80) {
      const n = m[1].trim();
      if (n.length > 1 && !/^(if|for|while|switch|return|new|catch)$/.test(n)) names.add(n);
    }
  }
  return [...names];
}

// ---------------------------------------------------------------- index (outline + embeddings), cached on disk

const memIndex = new Map();
const indexFile = (dir) => path.join(INDEX_DIR, `${path.resolve(dir).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(-120)}.json`);

function loadIndex(dir) {
  if (memIndex.has(dir)) return memIndex.get(dir);
  let idx = { files: {} };
  try {
    idx = JSON.parse(fs.readFileSync(indexFile(dir), "utf8"));
  } catch {}
  memIndex.set(dir, idx);
  return idx;
}

function saveIndex(dir, idx) {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  fs.writeFileSync(indexFile(dir), JSON.stringify(idx));
}

export const readText = (abs) => {
  try {
    const t = fs.readFileSync(abs, "utf8");
    return t.includes("\u0000") ? null : t;
  } catch {
    return null;
  }
};

async function embed(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, truncate: true }),
    signal: cancelSignal(120000),
  });
  if (!res.ok) throw new Error(`embed ${res.status}`);
  return (await res.json()).embeddings.map((v) => {
    // Normalise once so similarity is a plain dot product.
    const n = Math.hypot(...v) || 1;
    return v.map((x) => +(x / n).toFixed(5));
  });
}

let embedAvailable = null;
async function canEmbed() {
  if (embedAvailable !== null) return embedAvailable;
  try {
    await embed(["ok"]);
    embedAvailable = true;
  } catch {
    // Stopped from the UI: that says nothing about the model, so don't remember it.
    if (cancelSignal()?.aborted) return false;
    embedAvailable = false;
  }
  return embedAvailable;
}

// Bring the index up to date: only new or changed files are re-read and re-embedded.
export async function updateIndex(dir) {
  dir = path.resolve(dir);
  const files = listFiles(dir);
  const idx = loadIndex(dir);
  const live = new Set(files.map((f) => f.rel));
  let changed = false;
  for (const rel of Object.keys(idx.files)) if (!live.has(rel)) (delete idx.files[rel], (changed = true));

  const useEmbed = await canEmbed();
  const pending = []; // { rel, chunk }
  let chunkCount = Object.values(idx.files).reduce((n, f) => n + (f.chunks?.length || 0), 0);
  for (const f of files) {
    const cur = idx.files[f.rel];
    if (cur && cur.mtimeMs === f.mtimeMs && cur.size === f.size && (!useEmbed || cur.embedded)) continue;
    const text = readText(f.abs);
    if (text == null) continue;
    const lines = text.split("\n");
    const entry = { mtimeMs: f.mtimeMs, size: f.size, symbols: outline(text), lines: lines.length, chunks: [], embedded: false };
    if (useEmbed && chunkCount < MAX_CHUNKS) {
      for (let s = 0; s < lines.length; s += CHUNK_STEP) {
        const e = Math.min(lines.length, s + CHUNK_LINES);
        const body = lines.slice(s, e).join("\n");
        if (body.trim().length > 20) {
          const chunk = { start: s + 1, end: e, vec: null };
          entry.chunks.push(chunk);
          pending.push({ chunk, text: `${f.rel}\n${body}`.slice(0, 2000) });
          chunkCount++;
        }
        if (e === lines.length) break;
      }
      entry.embedded = true;
    }
    idx.files[f.rel] = entry;
    changed = true;
  }
  for (let i = 0; i < pending.length; i += 32) {
    const batch = pending.slice(i, i + 32);
    try {
      const vecs = await embed(batch.map((b) => b.text));
      batch.forEach((b, j) => (b.chunk.vec = vecs[j]));
    } catch {
      break; // embedding stopped working; keyword and picker search still run
    }
  }
  if (changed) saveIndex(dir, idx);
  return { idx, files, useEmbed };
}

// ---------------------------------------------------------------- retrieval

const STOP = new Set(
  ("the and for with that this from what when where which into have has should would could there their about make " +
    "using use add change update need want like just also then than them they your plan code file files function " +
    "please help write create implement fix does work works working").split(" "),
);

export function outlineText(idx, maxChars, perFile = 15) {
  const rows = Object.entries(idx.files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, f]) => `${rel}${f.symbols.length ? `: ${f.symbols.slice(0, perFile).join(", ")}` : ""}`);
  let out = "", omitted = 0;
  for (const r of rows) {
    if (out.length + r.length + 1 > maxChars) omitted++;
    else out += r + "\n";
  }
  return out + (omitted ? `(${omitted} more files not listed)\n` : "");
}

// The local model reads the outline and picks the files that matter, plus search terms to look for.
export async function pickFiles(request, outlineStr, model) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: cancelSignal(90000),
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      think: false,
      options: { temperature: 0, num_predict: 300, num_ctx: 16384 },
      messages: [
        {
          role: "system",
          content:
            "You help plan a change to a software project. From the project outline (each file with its main " +
            "functions and classes), pick the files someone must read to plan the request: where the behaviour " +
            "lives, what calls it, related config or tests. Think about what the request means, not just its words. " +
            'Reply with JSON only: {"files": [up to 6 paths exactly as listed], "functions": [up to 8 function or ' +
            "class names from the outline that the change touches or depends on], \"search\": [up to 8 identifiers " +
            "or terms likely to appear in the relevant code]}",
        },
        { role: "user", content: `Request:\n${request.slice(0, 3000)}\n\nProject outline:\n${outlineStr}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`picker ${res.status}`);
  const j = JSON.parse((await res.json()).message?.content || "{}");
  const list = (v) => (Array.isArray(v) ? v.map(String) : []);
  return { files: list(j.files), functions: list(j.functions), search: list(j.search) };
}

// The full definition of a function/class: from its declaration to where the block closes (max 120 lines).
export function definition(text, name) {
  const n = name.replace(/[^\w$]/g, "");
  if (!n) return null;
  const lines = text.split("\n");
  const decl = new RegExp(
    `(function\\s*\\*?\\s*${n}\\b|class\\s+${n}\\b|(const|let|var)\\s+${n}\\s*=|def\\s+${n}\\b|func\\s+(\\([^)]*\\)\\s*)?${n}\\b|fn\\s+${n}\\b|^\\s*(async\\s+)?${n}\\s*\\([^)]*\\)\\s*\\{)`,
  );
  const start = lines.findIndex((l) => decl.test(l));
  if (start === -1) return null;
  const indent = (l) => l.match(/^\s*/)[0].length;
  const base = indent(lines[start]);
  let end = Math.min(lines.length - 1, start + 119);
  for (let i = start + 1; i <= end; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (indent(l) <= base) {
      end = /^\s*[}\])]/.test(l) ? i : i - 1; // include a closing brace, stop before the next declaration
      break;
    }
  }
  return { start: start + 1, end: end + 1, body: lines.slice(start, end + 1).join("\n") };
}

// A large file that doesn't fit: its outline plus the chunks most similar to the request, in file order,
// instead of just the first few thousand characters.
// words: search terms; a chunk containing them ranks higher than meaning alone would put it.
function bestParts(rel, text, limit, scored, entry, words = []) {
  const lines = text.split("\n");
  const ranked = scored
    .filter((c) => c.rel === rel)
    .map((c) => {
      const body = lines.slice(c.start - 1, c.end).join("\n").toLowerCase();
      return { ...c, score: c.score + 0.08 * words.filter((w) => body.includes(w)).length };
    })
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return cut(text, limit);
  const header =
    `(Large file, ${lines.length} lines: showing the parts most relevant to the request. ` +
    `It defines: ${(entry?.symbols || []).slice(0, 20).join(", ")})\n`;
  const picked = [];
  let size = header.length;
  for (const c of ranked) {
    const len = lines.slice(c.start - 1, c.end).join("\n").length + 30;
    if (size + len > limit) continue;
    picked.push(c);
    size += len;
  }
  picked.sort((a, b) => a.start - b.start);
  return header + picked.map((c) => `… lines ${c.start}-${c.end}:\n${lines.slice(c.start - 1, c.end).join("\n")}`).join("\n");
}

export const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters cut)` : s);

// Returns { text, sources: [{ path, why, lines? }], ms }.
export async function projectContext(dir, request, { budget = 36000, model = DEFAULT_MODEL } = {}) {
  const started = Date.now();
  dir = path.resolve(dir);
  const { idx, useEmbed } = await updateIndex(dir);
  const rels = Object.keys(idx.files);
  if (!rels.length) return { text: "", sources: [], ms: Date.now() - started };
  const lowerMap = new Map(rels.map((r) => [r.toLowerCase(), r]));
  const byBase = new Map();
  for (const r of rels) {
    const b = r.split("/").pop().toLowerCase();
    if (!byBase.has(b)) byBase.set(b, r);
  }

  const chosen = new Map(); // rel -> why  (whole files)
  // 1. Files named in the request.
  for (const tok of request.match(/[\w.\-\/\\]+\.[A-Za-z0-9]{1,8}\b/g) || []) {
    const t = tok.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
    const hit = lowerMap.get(t) || byBase.get(t.split("/").pop());
    if (hit) chosen.set(hit, "you named it");
  }

  // 2. The local model picks files from the outline.
  const outlineStr = outlineText(idx, 12000, 40);
  let search = [], functions = [];
  try {
    const picked = await pickFiles(request, outlineStr, model);
    search = picked.search;
    functions = picked.functions;
    for (const p of picked.files) {
      const hit = lowerMap.get(p.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase());
      if (hit && !chosen.has(hit) && chosen.size < 8) chosen.set(hit, "picked from the project outline");
    }
  } catch {}

  // 3. Search by meaning.
  const snippets = []; // { rel, start, end, why, score }
  let scored = []; // every chunk with its similarity, also used to trim large chosen files
  if (useEmbed) {
    try {
      const [q] = await embed([`${request}\n${search.join(" ")}`.slice(0, 2000)]);
      for (const [rel, f] of Object.entries(idx.files)) {
        for (const c of f.chunks || []) {
          if (!c.vec) continue;
          let s = 0;
          for (let i = 0; i < q.length; i++) s += q[i] * c.vec[i];
          scored.push({ rel, start: c.start, end: c.end, score: s });
        }
      }
      // Docs read as "similar" to almost any request; rank them lower unless the request is about docs.
      const aboutDocs = /\b(readme|docs?|documentation|markdown)\b/i.test(request);
      for (const s of scored) if (!aboutDocs && /\.(md|mdx|rst|txt)$/i.test(s.rel)) s.score *= 0.85;
      scored.sort((a, b) => b.score - a.score);
      for (const s of scored.filter((s) => !chosen.has(s.rel)).slice(0, 8)) snippets.push({ ...s, why: "similar in meaning" });
    } catch {}
  }

  // 4. Keyword search: code-like names from the request (camelCase, snake_case, known symbols) and the picker's
  // search terms. Plain English words ("other", "able") match everywhere, so they're left to the steps above.
  const known = new Set(Object.values(idx.files).flatMap((f) => f.symbols.map((s) => s.toLowerCase())));
  const codeLike = (w) => /[a-z][A-Z]|_|\d|\$/.test(w) || known.has(w.toLowerCase());
  const words = [
    ...new Set(
      [...(request.match(/[A-Za-z_$][\w$]{2,}/g) || []).filter(codeLike), ...search.flatMap((s) => s.match(/[A-Za-z_$][\w$]{2,}/g) || [])]
        .map((w) => w.toLowerCase())
        .filter((w) => !STOP.has(w)),
    ),
  ].slice(0, 20);
  if (words.length) {
    const hits = [];
    for (const rel of rels) {
      if (chosen.has(rel)) continue;
      const text = readText(path.join(dir, rel));
      if (!text) continue;
      const lower = text.toLowerCase();
      const found = words.filter((w) => lower.includes(w));
      if (!found.length) continue;
      const lineNo = lower.slice(0, lower.indexOf(found[0])).split("\n").length;
      hits.push({ rel, score: found.length, start: Math.max(1, lineNo - 10), end: lineNo + 25, why: `mentions ${found.slice(0, 3).join(", ")}` });
    }
    hits.sort((a, b) => b.score - a.score);
    for (const h of hits.slice(0, 4)) if (!snippets.some((s) => s.rel === h.rel)) snippets.push(h);
  }

  // Full definitions of the functions the picker named, from the files whose outline lists them.
  const defs = [];
  for (const fn of functions.slice(0, 8)) {
    const name = fn.replace(/\(.*$/, "").split(/[.\s]/).pop().trim();
    const owners = rels
      .filter((r) => idx.files[r].symbols.includes(name))
      .sort((a, b) => (chosen.has(b) ? 1 : 0) - (chosen.has(a) ? 1 : 0));
    for (const rel of owners.slice(0, 2)) {
      const text = readText(path.join(dir, rel));
      const d = text && definition(text, name);
      if (d) {
        defs.push({ rel, name, ...d });
        break;
      }
    }
  }

  // Assemble within the budget: outline, files you named, function definitions, picked files, then snippets.
  const sources = [];
  const parts = [`<project path="${dir}">\nFiles and their main functions/classes:\n${outlineText(idx, 5000)}</project>`];
  let used = parts[0].length;
  const covered = []; // { rel, start, end } already shown, so snippets don't repeat them
  const addDefs = () => {
    for (const d of defs) {
      if (used + d.body.length + 120 > budget) continue;
      parts.push(`<snippet path="${d.rel}" lines="${d.start}-${d.end}" reason="definition of ${d.name}">\n${d.body}\n</snippet>`);
      used += d.body.length + 120;
      covered.push(d);
      sources.push({ path: d.rel, why: `definition of ${d.name}`, lines: `${d.start}-${d.end}` });
    }
  };
  const ordered = [...chosen].sort(([, a], [, b]) => (b === "you named it") - (a === "you named it"));
  let defsAdded = false;
  for (const [rel, why] of ordered) {
    if (!defsAdded && why !== "you named it") {
      addDefs();
      defsAdded = true;
    }
    const text = readText(path.join(dir, rel));
    if (!text) continue;
    const room = budget - used - 200;
    if (room < 1500) break;
    const limit = Math.min(why === "you named it" ? 14000 : 9000, room);
    const body = text.length <= limit ? text : bestParts(rel, text, limit, scored, idx.files[rel], words);
    parts.push(`<file path="${rel}" reason="${why}">\n${body}\n</file>`);
    used += body.length + 80;
    sources.push({ path: rel, why });
  }
  if (!defsAdded) addDefs();
  const seenRange = new Set();
  for (const s of snippets) {
    const key = `${s.rel}:${s.start}`;
    if (seenRange.has(key) || covered.some((c) => c.rel === s.rel && s.start >= c.start && s.end <= c.end)) continue;
    seenRange.add(key);
    const text = readText(path.join(dir, s.rel));
    if (!text) continue;
    const body = text.split("\n").slice(s.start - 1, s.end).join("\n");
    if (used + body.length + 120 > budget) continue;
    parts.push(`<snippet path="${s.rel}" lines="${s.start}-${s.end}" reason="${s.why}">\n${body}\n</snippet>`);
    used += body.length + 120;
    sources.push({ path: s.rel, why: s.why, lines: `${s.start}-${s.end}` });
  }

  const text =
    "Real code from the user's project, gathered for this request. Use these exact file and function names; " +
    "if something you need isn't shown, say which file you would need to see rather than guessing.\n\n" +
    parts.join("\n\n");
  return { text, sources, ms: Date.now() - started };
}
