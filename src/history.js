// History: what every AI conversation cost, from the tools' own records on this computer.
//   Claude Code: its session logs (exact). Read in place, nothing copied.
//   OpenCode:    its database or JSON storage (exact). Read in place, nothing copied.
//   Cursor:      keeps no usage records, so TokenScope's hook writes small records of step sizes
//                (never content). The cost is rebuilt from those, so it's approximate.
//   Codex:       its session logs (exact), see codexlogs.js. Read in place, nothing copied.
// Each reader reports format problems to `checks` (see checks.js).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cursorChats } = require("./cursordb");
const { loadZedThreads } = require("./zed");
const { byCost, listAllLogs, logsFolders, parseLines, sumUsage, findPricedModel, usageCost } = require("./claudelogs");
const { wslHomes } = require("./wsl");
const { DEFAULT_CACHE_HIT, estimateJob } = require("./estimate");
const { analyze, commandKind } = require("./insights");
const { share } = require("./checks");

const DAY = 86400e3;
const ZERO = () => ({ requests: 0, input: 0, cacheRead: 0, write5m: 0, write1h: 0, output: 0 });
const NO_CHECKS = { mismatch() {} };

// Price per model and totals for one conversation. byModel: Map of the tool's model name -> usage.
// ownCost: costs the tool recorded itself, used for models OpenRouter has no price for.
function summarize(byModel, models, ownCost = new Map()) {
  const rows = [];
  let cost = 0, unpriced = false, input = 0, fullPrice = 0;
  for (const [name, u] of byModel) {
    if (!u.requests && !u.input && !u.output && !u.cacheRead) continue;
    // u.model and u.factor: Codex keys usage by model and speed tier ("gpt-5.5 (fast)" costs 2x).
    const priced = findPricedModel(models, u.model || name);
    const c = priced ? usageCost(priced, u) * (u.factor || 1) : ownCost.has(name) ? ownCost.get(name) : null;
    if (c === null) unpriced = true;
    else cost += c;
    const totalIn = u.input + u.cacheRead + u.write5m + u.write1h;
    input += totalIn;
    fullPrice += u.input + u.write5m + u.write1h;
    rows.push({ model: name, modelId: priced ? priced.id : null, ...(u.tier ? { tier: u.tier } : {}), requests: u.requests, input: totalIn, cacheRead: u.cacheRead, cacheWrite: u.write5m + u.write1h, output: u.output, cost: c });
  }
  rows.sort((a, b) => (b.cost || 0) - (a.cost || 0));
  return { models: rows, cost, unpriced, fullPriceShare: input ? fullPrice / input : null };
}

// ---------- Claude Code ----------

// How many tokens a tool result adds. Text: about 4 characters per token. An image costs the
// model about 1,500 tokens however long its encoded form is.
function resultTokens(content) {
  if (typeof content === "string") return Math.round(content.length / 4);
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => sum + (part && part.type === "image" ? 1500 : Math.round(String((part && part.text) || "").length / 4)), 0);
}

// The conversation as a timeline of requests, pauses and tool runs (main conversation only).
function claudeTimeline(lines, models, skip = new Set()) {
  const requests = [], tools = [], pending = new Map(), seen = new Set(skip);
  let lastHuman = 0, cacheMinutes = 5;
  const toolKind = (name, input) => {
    if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return "edit";
    if (name === "Read") return "read";
    if (name === "Bash" || name === "PowerShell") return commandKind(input && input.command);
    return "other";
  };
  for (const { entry } of lines) {
    const t = entry.timestamp ? Date.parse(entry.timestamp) : null;
    if (t === null) continue;
    const content = entry.message && entry.message.content;
    if (entry.type === "user") {
      const blocks = Array.isArray(content) ? content : [];
      const results = blocks.filter((b) => b && b.type === "tool_result");
      if (results.length) {
        for (const b of results) {
          const p = pending.get(b.tool_use_id);
          if (!p) continue;
          pending.delete(b.tool_use_id);
          tools.push({ t, after: p.after, kind: p.kind, tool: p.name, file: p.file, ms: t - p.t, outTokens: resultTokens(b.content) });
        }
      } else if ((entry.origin && entry.origin.kind === "human") || typeof content === "string" || blocks.some((b) => b && b.type === "text")) {
        lastHuman = t;
      }
      continue;
    }
    if (entry.type !== "assistant" || !entry.message) continue;
    const m = entry.message;
    if (m.usage && !seen.has(m.id) && m.model !== "<synthetic>") {
      seen.add(m.id);
      const u = m.usage;
      const write1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
      if (write1h) cacheMinutes = 60;
      const priced = findPricedModel(models, m.model);
      const usage = { requests: 1, input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, write1h, write5m: Math.max(0, (u.cache_creation_input_tokens || 0) - write1h), output: u.output_tokens || 0 };
      const prev = requests[requests.length - 1];
      let pause = null;
      if (prev) {
        // What filled the gap since the last request: you writing, or a command running.
        const longestTool = tools.filter((x) => x.t > prev.t && x.t <= t).sort((a, b) => b.ms - a.ms)[0];
        if (lastHuman > prev.t) pause = { ms: lastHuman - prev.t, who: "you", kind: null };
        else if (longestTool) pause = { ms: longestTool.ms, who: "tool", kind: longestTool.kind };
        else pause = { ms: t - prev.t, who: "unknown", kind: null };
      }
      requests.push({
        t, model: priced, pause,
        context: usage.input + usage.cacheRead + usage.write5m + usage.write1h,
        fresh: usage.input + usage.write5m + usage.write1h, cached: usage.cacheRead, output: usage.output,
        cost: priced ? usageCost(priced, usage) : 0,
      });
    }
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b && b.type === "tool_use") {
        const input = b.input || {};
        pending.set(b.id, { t, name: b.name, kind: toolKind(b.name, input), file: input.file_path ? path.basename(input.file_path) : null, after: Math.max(0, requests.length - 1) });
      }
    }
  }
  return { requests, tools, cacheMinutes };
}

const claudeCache = new Map(); // file -> { key, summary, assistants, withUsage }, in memory only

// Reply ids in a session (main and helpers), for spotting copies across sessions: a resumed or
// forked Claude Code session can start with a copy of an earlier one's replies, same ids included.
const claudeReplyIds = (lineSets) => {
  const ids = new Set();
  for (const lines of lineSets) for (const { entry } of lines) {
    if (entry.type === "assistant" && entry.message && entry.message.usage && entry.message.model !== "<synthetic>") ids.add(entry.message.id || entry.requestId || entry.uuid);
  }
  return ids;
};

// savedOwners: reply id -> the conversation that counted it, from TokenScope's saved summaries
// (archive.js). When Claude Code has deleted that conversation's log (after 30 days by default), a
// fork or resumed copy still has the copied replies; this keeps them from being counted again.
async function readClaudeCode(models, since, { folder, checks = NO_CHECKS, savedOwners = new Map() } = {}) {
  const logs = await listAllLogs(folder ? [folder] : logsFolders(), since);
  let assistants = 0, withUsage = 0;
  // First every session's reply ids and start (cached per file), so a copied reply counts only in
  // the session it first appeared in, the one that started first.
  const sessions = [];
  for (const log of logs) {
    if (log.file.includes(`${path.sep}subagents${path.sep}`)) continue;
    const sessionFolder = log.file.replace(/\.jsonl$/, "") + path.sep;
    const helpers = logs.filter((l) => l.file.startsWith(sessionFolder));
    const key = [log.mtime, ...helpers.map((h) => h.mtime)].join(",") + `|${models.length}`;
    const read = async () => {
      const lines = parseLines(await fs.promises.readFile(log.file, "utf8").catch(() => ""));
      const helperLines = [];
      for (const h of helpers) helperLines.push(parseLines(await fs.promises.readFile(h.file, "utf8").catch(() => "")));
      return { lines, helperLines };
    };
    let hit = claudeCache.get(log.file);
    if (!hit || hit.key !== key) {
      const { lines, helperLines } = await read();
      // Format check: recent replies should carry token counts. Only the last ones count: a resumed
      // or copied conversation can start with older replies that never had them.
      const replies = lines.filter((l) => l.entry.type === "assistant").slice(-30);
      const counted = replies.filter((l) => l.entry.message && l.entry.message.usage && typeof l.entry.message.usage.output_tokens === "number").length;
      const firstT = lines.map((l) => Date.parse(l.entry.timestamp)).find(Number.isFinite);
      const sessionId = (lines.find((l) => l.entry.sessionId) || { entry: {} }).entry.sessionId;
      // Kept: the reply ids and the summary, not the log itself (they can be large and the app runs for hours).
      hit = { key, convId: `claude-code:${sessionId || path.basename(log.file, ".jsonl")}`, ids: claudeReplyIds([lines, ...helperLines]), first: firstT ?? Infinity, summary: summarizeClaude(log, lines, helperLines, models, new Set()), assistants: replies.length, withUsage: counted };
      claudeCache.set(log.file, hit);
    }
    assistants += hit.assistants;
    withUsage += hit.withUsage;
    sessions.push({ log, hit, read });
  }
  const owner = new Map(); // reply id -> the session that counts it
  // A copy carries the original's times, so a tie goes to the file created first (a resumed or forked one is made later).
  for (const x of [...sessions].sort((a, b) => a.hit.first - b.hit.first || a.log.born - b.log.born)) for (const id of x.hit.ids) if (!owner.has(id)) owner.set(id, x);
  const live = new Set(sessions.map((x) => x.hit.convId));
  // A reply a saved conversation counted, whose log is gone, is a copy in every live session.
  const savedElsewhere = (id, x) => {
    const saved = savedOwners.get(id);
    return saved !== undefined && saved !== x.hit.convId && !live.has(saved);
  };
  const out = [];
  for (const x of sessions) {
    const copied = new Set([...x.hit.ids].filter((id) => owner.get(id) !== x || savedElsewhere(id, x)));
    if (!copied.size) {
      if (x.hit.summary) out.push(x.hit.summary);
    } else {
      // Rare (a resumed or forked session): read again and leave the copies out. Not cached, as it depends on other sessions.
      const { lines, helperLines } = await x.read();
      const summary = summarizeClaude(x.log, lines, helperLines, models, copied);
      // Only a copy, nothing of its own: not listed (yet). Claude Code's logs don't say whether a copy
      // is a fork you made or one an older version made on resume, so it isn't shown at $0 like
      // OpenCode's and Codex's forks are. Present all the same (see archive.js copyOnly).
      out.push(summary || { id: x.hit.convId, tool: "claude-code", copyOnly: true });
    }
  }
  if (assistants >= 10 && withUsage / assistants < 0.5) {
    checks.mismatch("claude-code", "Its logs no longer have token counts where expected, so Claude Code costs are missing or too low.");
  }
  return out;
}

// A fork with nothing of its own yet, listed at $0 so Spending has the same conversations as the
// tool. Everything in it is a copy, counted in the original (of: its title, when known). copyOnly:
// never saved, and an outdated saved summary of it is removed (see archive.js).
function forkRow({ id, tool, title, of, cwd, made, archived }) {
  return {
    id, tool, copyOnly: true, title: title || "Untitled conversation", fork: { of: of || null },
    project: cwd ? path.basename(cwd) : null, start: made, end: made, approximate: false, ...(archived ? { archived: true } : {}),
    jobIds: [], models: [], cost: 0, insights: null,
  };
}

// One Claude Code conversation. skip: reply ids counted in another session (a copy there).
function summarizeClaude(log, lines, helperLines, models, skip) {
  const { byModel } = sumUsage([lines, ...helperLines], -Infinity, Infinity, skip);
  let title = null, cwd = null, start = null, end = null, sessionId = null;
  const jobIds = new Set();
  for (const { entry, raw } of lines) {
    if (entry.type === "ai-title" && entry.aiTitle) title = entry.aiTitle;
    if (!cwd && entry.cwd) cwd = entry.cwd;
    if (!sessionId && entry.sessionId) sessionId = entry.sessionId;
    // A copied reply (and the copied history around it) has the original's time; it doesn't start this one.
    const copy = entry.type === "assistant" && entry.message && skip.has(entry.message.id || entry.requestId || entry.uuid);
    if (entry.timestamp && !copy) {
      const t = Date.parse(entry.timestamp);
      if (start === null || t < start) start = t;
      if (end === null || t > end) end = t;
    }
    if (raw.includes("job_id")) (raw.match(/job-[a-z0-9]{8,}/g) || []).forEach((id) => jobIds.add(id));
  }
  if (skip.size) {
    // Its own part starts at its first own reply, not at the copied history before it.
    const own = lines.filter((l) => l.entry.type === "assistant" && l.entry.message && l.entry.message.usage && !skip.has(l.entry.message.id || l.entry.requestId || l.entry.uuid)).map((l) => Date.parse(l.entry.timestamp)).filter(Number.isFinite);
    if (!own.length) return null; // only a copy: nothing of its own was paid for
    start = Math.min(...own);
  }
  const priced = summarize(byModel, models);
  let helperCost = 0;
  for (const [name, u] of sumUsage(helperLines, -Infinity, Infinity, skip).byModel) {
    const p = findPricedModel(models, name);
    if (p) helperCost += usageCost(p, u);
  }
  return priced.models.length && start !== null ? {
    id: `claude-code:${sessionId || path.basename(log.file, ".jsonl")}`,
    tool: "claude-code", title: title || "Untitled conversation", project: cwd ? path.basename(cwd) : null,
    start, end, approximate: false, jobIds: [...jobIds], ...priced,
    insights: analyze({ ...claudeTimeline(lines, models, skip), helperCost, total: priced.cost }),
    // Kept in the saved summary, so a copy of these replies elsewhere isn't counted again once this log is gone.
    replyIds: [...claudeReplyIds([lines, ...helperLines])].filter((id) => !skip.has(id)),
  } : null;
}

// ---------- Codex ----------

const codexLogs = require("./codexlogs");

function readCodex(models, since, options = {}) {
  return codexLogs.readCodex(models, since, { ...options, summarize, analyze, forkRow });
}

// ---------- OpenCode ----------

function openCodeFolder() {
  if (process.env.OPENCODE_DATA_DIR) return process.env.OPENCODE_DATA_DIR;
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "opencode");
}

function openCodeFound(folders = openCodeFolders()) {
  return [].concat(folders).some((folder) => {
    try {
      const names = fs.readdirSync(folder);
      return names.some((n) => /^opencode.*\.db$/.test(n)) || names.includes("storage");
    } catch {
      return false;
    }
  });
}

let SQL = null;
async function sqlJs() {
  if (!SQL) {
    const init = require("sql.js");
    const dist = path.dirname(require.resolve("sql.js"));
    SQL = await init({ locateFile: (file) => path.join(dist, file) });
  }
  return SQL;
}

const asJson = (value) => {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

// One OpenCode assistant message, from any storage generation, in a common shape.
function openCodeMessage(row, data) {
  if (!data) return null;
  const role = data.role || row.role || row.type;
  if (role !== "assistant") return null;
  const t = data.tokens;
  const cache = (t && t.cache) || {};
  const model = (data.model && (data.model.id || data.model.modelID)) || data.modelID || row.model_id || null;
  const created = (data.time && (data.time.created || data.time.start)) || row.time_created || row.created_at || null;
  return {
    id: data.id || row.id,
    session: data.sessionID || data.session_id || row.session_id || row.sessionID || null,
    model: model || "unknown",
    time: typeof created === "number" ? created : Date.parse(created),
    cwd: (data.path && (data.path.cwd || data.path.root)) || null,
    hasTokens: !!t && typeof t === "object",
    tokens: { input: (t && t.input) || 0, output: ((t && t.output) || 0) + ((t && t.reasoning) || 0), read: cache.read || 0, write: cache.write || 0 },
    cost: typeof data.cost === "number" ? data.cost : null,
  };
}

// When you wrote, from a user message: why the cache expired (see openCodeTimeline). Only the time
// and session are kept, never the text.
function openCodeUser(row, data) {
  if (!data) return null;
  if ((data.role || row.role || row.type) !== "user") return null;
  const created = (data.time && (data.time.created || data.time.start)) || row.time_created || row.created_at || null;
  const t = typeof created === "number" ? created : Date.parse(created);
  const session = data.sessionID || data.session_id || row.session_id || row.sessionID || null;
  return session && Number.isFinite(t) ? { session, t } : null;
}

// A tool the AI ran, from a part: when it ran, what kind it was and how big its output was. Never the
// command or the output itself, only the kind (edit, read, build, test, other) and the file.
function openCodeTool(row, data) {
  if (!data || (data.type || row.type) !== "tool") return null;
  const state = data.state || {};
  const time = state.time || {};
  const start = Number(time.start), end = Number(time.end);
  const session = data.sessionID || data.session_id || row.session_id || row.sessionID || null;
  if (!session || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const input = state.input || {};
  const name = String(data.tool || "");
  const kind = /^(edit|write|patch|multiedit)$/i.test(name) ? "edit" : /^read$/i.test(name) ? "read"
    : /^(bash|shell|powershell)$/i.test(name) ? commandKind(input.command) : "other";
  const output = typeof state.output === "string" ? state.output.length : 0;
  return { id: data.id || row.id || `${session}|${start}|${name}`, session, start, t: end, ms: end - start, kind, tool: name, file: input.filePath || input.file_path || null, outTokens: Math.round(output / 4) };
}

// Why the cache expired before each reply: you writing, or a tool running, like Claude Code's timeline.
function openCodeTimeline(ordered, users, tools) {
  return ordered.map((m, i) => {
    if (!i) return null;
    const prev = ordered[i - 1].time, t = m.time;
    const lastHuman = users.reduce((last, u) => (u > prev && u <= t && u > last ? u : last), 0);
    const longest = tools.filter((x) => x.t > prev && x.t <= t).sort((a, b) => b.ms - a.ms)[0];
    if (lastHuman) return { ms: lastHuman - prev, who: "you", kind: null };
    if (longest) return { ms: longest.ms, who: "tool", kind: longest.kind };
    return { ms: t - prev, who: "unknown", kind: null };
  });
}

function tableRows(db, table) {
  try {
    const result = db.exec(`SELECT * FROM "${table}"`);
    if (!result.length) return [];
    const { columns, values } = result[0];
    return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
  } catch {
    return null; // no such table
  }
}

// OpenCode's folders: this computer's, plus OpenCode run inside WSL (see wsl.js).
function openCodeFolders() {
  return [openCodeFolder(), ...wslHomes().map((home) => path.join(home, ".local", "share", "opencode"))];
}

// Where a TokenScope job id shows up in OpenCode's records (the estimate_plan or continue_job
// result in a tool part), by session and time. Format-agnostic: any stored row or file that
// mentions a job id next to "job_id".
function jobMarksIn(raw, data, row, timeOf) {
  if (typeof raw !== "string" || !raw.includes("job_id")) return [];
  const ids = raw.match(/job-[a-z0-9]{8,}/g);
  if (!ids) return [];
  const d = data || {};
  const st = (d.state && d.state.time) || d.time || {};
  const session = d.sessionID || d.session_id || (row && (row.session_id || row.sessionID)) || null;
  const t = st.end || st.start || st.created || (row && (row.time_created || row.created_at)) || timeOf(d.messageID || d.message_id || (row && row.message_id));
  return session && t ? [...new Set(ids)].map((id) => ({ id, session, t: typeof t === "number" ? t : Date.parse(t) })) : [];
}

// Reads everything OpenCode keeps in one folder: replies with tokens, sessions, and job marks.
async function loadOpenCode(folder, since, checks = NO_CHECKS) {
  const messages = new Map(); // id -> message, so the same message stored twice counts once
  const sessions = new Map(); // id -> { title, cwd }
  const rawMarks = []; // [raw text, data, row] to look at once message times are known
  const users = [], tools = []; // when you wrote, and the tools the AI ran (see openCodeTimeline)
  const all = [];
  const add = (m) => {
    if (!m || !m.id) return;
    all.push(m);
    if (!messages.has(m.id)) messages.set(m.id, m); // whole conversations, filtered by their end later
  };
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return { messages, sessions, marks: [], users: [], tools: [], found: false };
  }
  // Databases: 2.x tables (session_v2, session_message) and the older ones (session, message, part).
  const databases = names.filter((n) => /^opencode.*\.db$/.test(n));
  let knownTables = 0;
  for (const name of databases) {
    const SQLite = await sqlJs();
    let db;
    try {
      db = new SQLite.Database(fs.readFileSync(path.join(folder, name)));
    } catch {
      checks.mismatch("opencode", `Its database ${name} couldn't be opened.`);
      continue;
    }
    for (const table of ["session_message", "message"]) {
      const rows = tableRows(db, table);
      if (rows === null) continue;
      knownTables++;
      for (const row of rows) {
        const data = asJson(row.data) || row;
        add(openCodeMessage(row, data));
        const user = openCodeUser(row, data);
        if (user) users.push(user);
        if (typeof row.data === "string" && row.data.includes("job_id")) rawMarks.push([row.data, asJson(row.data), row]);
      }
    }
    for (const table of ["part", "session_part", "message_part"]) {
      for (const row of tableRows(db, table) || []) {
        if (typeof row.data === "string" && row.data.includes("job_id")) rawMarks.push([row.data, asJson(row.data), row]);
        const tool = openCodeTool(row, asJson(row.data) || row);
        if (tool) tools.push(tool);
      }
    }
    for (const table of ["session_v2", "session"]) {
      for (const row of tableRows(db, table) || []) {
        const data = asJson(row.data) || {};
        const id = row.id || data.id;
        if (id && !sessions.has(id)) sessions.set(id, { title: row.title || data.title || null, cwd: row.directory || data.directory || (data.path && data.path.cwd) || null, archived: !!(row.time_archived || (data.time && data.time.archived)), parent: row.parent_id || row.parentID || data.parentID || data.parent_id || null, created: row.time_created || (data.time && data.time.created) || null, forkOf: row.fork_session_id || (data.fork && data.fork.sessionID) || null });
      }
    }
    db.close();
  }
  // JSON storage (1.1+): storage/message/<session>/<message>.json, storage/part/<message>/<part>.json
  // and storage/session/**/<session>.json
  const storage = path.join(folder, "storage");
  const walk = (dir, depth, visit) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) walk(full, depth - 1, visit);
      else if (e.name.endsWith(".json")) visit(full);
    }
  };
  let jsonMessages = 0;
  walk(path.join(storage, "message"), 2, (file) => {
    try {
      if (fs.statSync(file).mtimeMs < since) return;
      jsonMessages++;
      const data = asJson(fs.readFileSync(file, "utf8"));
      add(openCodeMessage({}, data));
      const user = openCodeUser({}, data);
      if (user) users.push(user);
    } catch {}
  });
  walk(path.join(storage, "part"), 2, (file) => {
    try {
      if (fs.statSync(file).mtimeMs < since) return;
      const raw = fs.readFileSync(file, "utf8");
      if (raw.includes("job_id")) rawMarks.push([raw, asJson(raw), null]);
      if (raw.includes('"tool"')) {
        const tool = openCodeTool({}, asJson(raw));
        if (tool) tools.push(tool);
      }
    } catch {}
  });
  walk(path.join(storage, "session"), 3, (file) => {
    const data = asJson(fs.readFileSync(file, "utf8"));
    if (data && data.id && !sessions.has(data.id)) sessions.set(data.id, { title: data.title || null, cwd: data.directory || null, archived: !!(data.time && data.time.archived), parent: data.parentID || data.parent_id || null, created: (data.time && data.time.created) || null });
  });
  // Format checks: the message tables, and token counts on replies.
  if (databases.length && !knownTables && !jsonMessages) checks.mismatch("opencode", "Its database doesn't have the tables TokenScope reads, so OpenCode conversations are missing.");
  if (all.length >= 5 && share(all, (m) => m.hasTokens) < 0.5) checks.mismatch("opencode", "Its replies no longer have token counts where expected, so OpenCode costs are missing or too low.");
  const timeOf = (id) => (id && messages.has(id) ? messages.get(id).time : null);
  const marks = rawMarks.flatMap(([raw, data, row]) => jobMarksIn(raw, data, row, timeOf));
  return { messages, sessions, marks, users, tools, found: true };
}

// All OpenCode folders together.
async function loadAllOpenCode(folders, since, checks) {
  const messages = new Map(), sessions = new Map(), marks = [];
  const users = new Map(), tools = new Map(); // per session: times you wrote; tools by id
  for (const folder of folders) {
    const part = await loadOpenCode(folder, since, checks);
    for (const [id, m] of part.messages) if (!messages.has(id)) messages.set(id, m);
    for (const [id, info] of part.sessions) if (!sessions.has(id)) sessions.set(id, info);
    marks.push(...part.marks);
    for (const u of part.users) {
      if (!users.has(u.session)) users.set(u.session, new Set());
      users.get(u.session).add(u.t);
    }
    for (const x of part.tools) if (!tools.has(x.id)) tools.set(x.id, x);
  }
  const all = [...messages.values()];
  const before = new Set(all.map((m) => m.session));
  dropForkCopies(messages, sessions);
  const after = new Set([...messages.values()].map((m) => m.session));
  const copyOnly = [...before].filter((id) => !after.has(id)); // forks with nothing of their own (yet)
  // Sessions that had copies left out: forks, also without OpenCode's fork link (older versions).
  const counts = (list) => list.reduce((m, x) => m.set(x.session, (m.get(x.session) || 0) + 1), new Map());
  const had = counts(all), kept = counts([...messages.values()]);
  const forks = new Set([...had].filter(([id, n]) => (kept.get(id) || 0) < n).map(([id]) => id));
  const toolsBySession = new Map();
  for (const x of tools.values()) {
    if (!toolsBySession.has(x.session)) toolsBySession.set(x.session, []);
    toolsBySession.get(x.session).push(x);
  }
  return { messages, sessions, marks, copyOnly, forks, users, tools: toolsBySession };
}

// A fork (/fork in OpenCode) starts a new session with a copy of the conversation so far. The copied
// replies keep their time and token counts, so they'd be counted twice: in the original and in the
// fork. A reply identical to one in another session (same time to the millisecond, model and token
// counts) is a copy: it's kept only in the session it first appeared in, the one that started first.
function dropForkCopies(messages, sessions = new Map()) {
  // A fork's copies carry the original's times, so the session made first is the one OpenCode created
  // first; without that, the one whose own replies start first (a fork has at least one of its own later).
  const firstReply = new Map(), lastReply = new Map();
  for (const m of messages.values()) {
    firstReply.set(m.session, Math.min(firstReply.get(m.session) ?? Infinity, m.time));
    lastReply.set(m.session, Math.max(lastReply.get(m.session) ?? 0, m.time));
  }
  const created = (id) => Number((sessions.get(id) || {}).created) || firstReply.get(id);
  const order = (a, b) => created(a) - created(b) || firstReply.get(a) - firstReply.get(b) || lastReply.get(a) - lastReply.get(b);
  // Sure: a session OpenCode marks as a fork of another (newer OpenCode). Its replies that match one
  // of the original's by model and token counts are copies, whatever their times say. Each original
  // reply matches one copy at most.
  const sig = (m) => `${m.model}|${m.tokens.input}|${m.tokens.output}|${m.tokens.read}|${m.tokens.write}`;
  const bySession = new Map();
  for (const m of messages.values()) {
    if (!bySession.has(m.session)) bySession.set(m.session, []);
    bySession.get(m.session).push(m);
  }
  for (const [id, info] of sessions) {
    if (!info || !info.forkOf || !bySession.has(id) || !bySession.has(info.forkOf)) continue;
    // Only replies the original had when the fork was made can have been copied; what you add to the
    // original later never matches the fork.
    const madeAt = Number(info.created) || Infinity;
    const originals = new Map();
    for (const m of bySession.get(info.forkOf)) if (m.time <= madeAt) originals.set(sig(m), (originals.get(sig(m)) || 0) + 1);
    for (const m of [...bySession.get(id)].sort((a, b) => a.time - b.time)) {
      const n = originals.get(sig(m));
      if (!n) continue;
      originals.set(sig(m), n - 1);
      messages.delete(m.id);
    }
  }
  // Otherwise: same time to the millisecond, model and token counts as a reply in another session.
  const firstSeen = new Map(); // signature -> the message kept
  const ordered = [...messages.values()].sort((a, b) => (a.session === b.session ? a.time - b.time : order(a.session, b.session)));
  for (const m of ordered) {
    const t = m.tokens;
    if (!m.time || !(t.input + t.output + t.read + t.write)) continue;
    const key = `${m.time}|${m.model}|${t.input}|${t.output}|${t.read}|${t.write}`;
    const kept = firstSeen.get(key);
    if (!kept) firstSeen.set(key, m);
    else if (kept.session !== m.session) messages.delete(m.id);
  }
}

// A subagent runs in a session of its own whose parent is the session that started it. Maps each
// such session to the top conversation it belongs to (following parents of parents).
function openCodeRoots(sessions) {
  const rootOf = new Map();
  for (const id of sessions.keys()) {
    let root = id, seen = new Set([id]);
    while (sessions.has(root) && sessions.get(root).parent && !seen.has(sessions.get(root).parent)) {
      root = sessions.get(root).parent;
      seen.add(root);
    }
    if (root !== id) rootOf.set(id, root);
  }
  return rootOf;
}

const addMessage = (byModel, own, m) => {
  const u = byModel.get(m.model) || ZERO();
  u.requests += 1;
  u.input += m.tokens.input;
  u.cacheRead += m.tokens.read;
  u.write5m += m.tokens.write;
  u.output += m.tokens.output;
  byModel.set(m.model, u);
  if (m.cost !== null) own.set(m.model, (own.get(m.model) || 0) + m.cost);
};

// A reply's fingerprint: what a fork's copy of it shares with it (see dropForkCopies).
const openCodePrint = (m) => `oc|${m.time}|${m.model}|${m.tokens.input}|${m.tokens.output}|${m.tokens.read}|${m.tokens.write}`;

// savedOwners: fingerprint -> the conversation that counted it, from TokenScope's saved summaries. If
// you deleted that conversation in OpenCode, a fork still has copies of its replies; they don't count again.
async function readOpenCode(models, since, { folder, checks = NO_CHECKS, savedOwners = new Map() } = {}) {
  const { messages, sessions, marks, copyOnly, forks, users, tools } = await loadAllOpenCode(folder ? [folder] : openCodeFolders(), since, checks);
  const jobsBySession = new Map();
  for (const mark of marks) {
    if (!jobsBySession.has(mark.session)) jobsBySession.set(mark.session, new Set());
    jobsBySession.get(mark.session).add(mark.id);
  }

  // Group into conversations.
  const bySession = new Map();
  for (const m of messages.values()) {
    if (!bySession.has(m.session)) bySession.set(m.session, []);
    bySession.get(m.session).push(m);
  }
  // Subagents' sessions are part of the conversation that started them (when that one is here).
  const rootOf = openCodeRoots(sessions);
  if (savedOwners.size) {
    const convOf = (session) => `opencode:${bySession.has(rootOf.get(session)) ? rootOf.get(session) : session}`;
    const live = new Set([...bySession.keys()].map(convOf));
    for (const [session, list] of bySession) {
      const mine = convOf(session);
      const kept = list.filter((m) => {
        const owner = savedOwners.get(openCodePrint(m));
        return !(owner && owner !== mine && !live.has(owner));
      });
      if (kept.length) {
        if (kept.length < list.length) forks.add(session); // its original was deleted in OpenCode
        bySession.set(session, kept);
      } else {
        bySession.delete(session);
        copyOnly.push(session);
      }
    }
  }
  const helpersOf = new Map();
  for (const id of bySession.keys()) {
    const root = rootOf.get(id);
    if (!root || !bySession.has(root)) continue;
    if (!helpersOf.has(root)) helpersOf.set(root, []);
    helpersOf.get(root).push(id);
  }
  const out = [];
  for (const [id, list] of bySession) {
    if (bySession.has(rootOf.get(id))) continue; // counted with the conversation that started it
    const byModel = new Map(), own = new Map();
    let start = Infinity, end = 0, cwd = null;
    for (const m of list) {
      addMessage(byModel, own, m);
      start = Math.min(start, m.time);
      end = Math.max(end, m.time);
      cwd = cwd || m.cwd;
    }
    let helperCost = 0;
    const helpers = helpersOf.get(id) || [];
    const helperList = []; // { title, cost } per subagent, for the conversation's Details
    const jobIds = new Set(jobsBySession.get(id) || []);
    for (const helper of helpers) {
      let cost = 0;
      const ran = new Map(); // the models it ran on, as the tool recorded them
      for (const m of bySession.get(helper)) {
        addMessage(byModel, own, m);
        const p = findPricedModel(models, m.model);
        ran.set(m.model, { model: m.model, modelId: p ? p.id : null });
        cost += p ? usageCost(p, { requests: 1, input: m.tokens.input, cacheRead: m.tokens.read, write5m: m.tokens.write, write1h: 0, output: m.tokens.output }) : m.cost || 0;
        end = Math.max(end, m.time);
      }
      helperCost += cost;
      helperList.push({ title: (sessions.get(helper) || {}).title || "Subagent", cost, models: [...ran.values()] });
      for (const job of jobsBySession.get(helper) || []) jobIds.add(job);
    }
    if (end < since) continue;
    const info = sessions.get(id) || {};
    const priced = summarize(byModel, models, own);
    if (!priced.models.length) continue;
    const ordered = [...list].sort((a, b) => a.time - b.time);
    // The tools this conversation ran after its first own reply (a fork's copied ones belong to the
    // original), each after the reply that asked for it.
    const ran = (tools.get(id) || []).filter((x) => x.start >= ordered[0].time).map((x) => {
      let after = 0;
      while (after + 1 < ordered.length && ordered[after + 1].time <= x.start) after++;
      return { ...x, after };
    });
    const pauses = openCodeTimeline(ordered, [...(users.get(id) || [])], ran);
    const requests = ordered.map((m, i) => {
      const p = findPricedModel(models, m.model);
      const usage = { requests: 1, input: m.tokens.input, cacheRead: m.tokens.read, write5m: m.tokens.write, write1h: 0, output: m.tokens.output };
      return {
        t: m.time, model: p, pause: pauses[i],
        context: m.tokens.input + m.tokens.read + m.tokens.write, fresh: m.tokens.input + m.tokens.write, cached: m.tokens.read,
        output: m.tokens.output, cost: p ? usageCost(p, usage) : m.cost || 0,
      };
    });
    out.push({
      id: `opencode:${id}`, tool: "opencode", title: info.title || "Untitled conversation",
      project: info.cwd || cwd ? path.basename(info.cwd || cwd) : null, start, end, approximate: false, ...(info.archived ? { archived: true } : {}), jobIds: [...jobIds], ...priced,
      // A fork: only its own replies count here; what it copied counts in the original.
      ...(info.forkOf || forks.has(id) ? { fork: { of: info.forkOf && sessions.get(info.forkOf) ? sessions.get(info.forkOf).title || "Untitled conversation" : null } } : {}),
      ...(helpers.length ? { helpers: helperList, includes: helpers.map((h) => `opencode:${h}`) } : {}),
      // Kept in the saved summary (see savedOwners above).
      replyIds: [...list, ...helpers.flatMap((h) => bySession.get(h))].map(openCodePrint),
      insights: analyze({ requests, tools: ran, cacheMinutes: 5, helperCost, total: priced.cost }),
    });
  }
  // Forks that still exist but have nothing of their own yet: everything in them is a copy, already
  // counted in the original. They're listed at $0, so Spending has the same conversations as OpenCode.
  // copyOnly also stops an outdated saved summary of them (copies counted, before 1.0.9) from being
  // shown in their place (see archive.js). A subagent's session isn't listed on its own.
  for (const id of new Set(copyOnly)) {
    if (rootOf.has(id) && bySession.has(rootOf.get(id))) continue;
    const info = sessions.get(id) || {};
    const made = Number(info.created) || 0;
    if (info.parent || made < since || !made) {
      out.push({ id: `opencode:${id}`, tool: "opencode", copyOnly: true });
      continue;
    }
    const original = info.forkOf && sessions.get(info.forkOf);
    out.push(forkRow({ id: `opencode:${id}`, tool: "opencode", title: info.title, of: original ? original.title || "Untitled conversation" : null, cwd: info.cwd, made, archived: info.archived }));
  }
  return out;
}

// Real costs of jobs that ran in OpenCode: replies in the session after the job id first shows up
// there (estimate_plan or continue_job), until finish_job or another job shows up. Exact.
async function findOpenCodeActuals(jobs, models, { folder, now = Date.now() } = {}) {
  const open = jobs.filter((j) =>
    Date.parse(j.createdAt) > now - 60 * 86400e3 &&
    (!j.actual || j.actual.source === "ai" || j.actual.source === "cursor-hook" || (j.actual.source === "opencode" &&
      (j.actual.status === "running" || (!j.endedAt && now - Date.parse(j.actual.lastActivity) < 2 * 86400e3)))));
  if (!open.length) return {};
  const since = Math.min(...open.map((j) => Date.parse(j.createdAt))) - 60e3;
  const { messages, marks, sessions } = await loadAllOpenCode(folder ? [folder] : openCodeFolders(), since);
  const rootOf = openCodeRoots(sessions);
  const bySession = new Map();
  for (const m of messages.values()) {
    if (!bySession.has(m.session)) bySession.set(m.session, []);
    bySession.get(m.session).push(m);
  }
  const changes = {};
  for (const job of open) {
    const starts = new Map(); // session -> when the job first shows up there
    for (const mark of marks) if (mark.id === job.id && !(starts.get(mark.session) <= mark.t)) starts.set(mark.session, mark.t);
    if (!starts.size) continue;
    const byModel = new Map(), own = new Map();
    let last = 0, first = Infinity, sessionId = null, running = false;
    for (const [session, start] of starts) {
      let end = job.endedAt && Date.parse(job.endedAt) > start ? Date.parse(job.endedAt) : Infinity;
      for (const mark of marks) if (mark.session === session && mark.id !== job.id && mark.t > start) end = Math.min(end, mark.t);
      const list = bySession.get(session) || [];
      // Subagents this session started while the job ran count too.
      const helpers = [...bySession.keys()].filter((h) => rootOf.get(h) === session && !starts.has(h));
      for (const m of list.concat(...helpers.map((h) => bySession.get(h)))) {
        if (!(m.time >= start && m.time < end)) continue;
        addMessage(byModel, own, m);
        last = Math.max(last, m.time);
      }
      const latest = Math.max(0, ...list.map((m) => m.time));
      if (end === Infinity && !job.endedAt && now - latest < 15 * 60e3) running = true;
      if (start < first) {
        first = start;
        sessionId = session;
      }
    }
    const priced = summarize(byModel, models, own);
    if (!priced.models.length) continue;
    const main = [...priced.models].sort((a, b) => b.output - a.output)[0];
    const sum = (key) => priced.models.reduce((total, m) => total + m[key], 0);
    const actual = {
      modelId: main.modelId || main.model, costUsd: Number(priced.cost.toFixed(4)),
      inputTokens: sum("input"), cachedTokens: sum("cacheRead"), cacheWriteTokens: sum("cacheWrite"), outputTokens: sum("output"),
      source: "opencode", status: running ? "running" : "done", sessionId, sessions: starts.size,
      lastActivity: new Date(last || first).toISOString(), models: byCost(priced.models.map((m) => ({ model: m.modelId || m.model, cost: m.cost === null ? null : Number(m.cost.toFixed(4)) }))),
      ...(priced.unpriced ? { unpricedModels: priced.models.filter((m) => m.cost === null).map((m) => m.model) } : {}),
    };
    const mainPriced = models.find((m) => m.id === actual.modelId);
    const addEstimate = job.plan && mainPriced && !(job.estimates || {})[actual.modelId] ? estimateJob(mainPriced, job.plan) : null;
    const before = job.actual ? JSON.stringify({ ...job.actual, recordedAt: undefined }) : null;
    if (before !== JSON.stringify({ ...actual, recordedAt: undefined }) || addEstimate) {
      changes[job.id] = { actual: { ...actual, recordedAt: new Date(now).toISOString() }, addEstimate };
    }
  }
  return changes;
}

// Saves OpenCode jobs' real costs. A cost measured from Claude Code's or Codex's logs wins.
async function syncOpenCodeActuals(store, models, options) {
  const changes = await findOpenCodeActuals(store.read().jobs, models, options);
  if (!Object.keys(changes).length) return 0;
  let changed = 0;
  store.update((data) => {
    for (const job of data.jobs) {
      const change = changes[job.id];
      if (!change || (job.actual && (job.actual.source === "claude-code" || job.actual.source === "codex"))) continue;
      job.actual = change.actual;
      changed++;
      if (change.addEstimate) {
        const e = change.addEstimate;
        job.estimates = { ...(job.estimates || {}), [change.actual.modelId]: { low: Number(e.low.toFixed(4)), likely: Number(e.likely.toFixed(4)), high: Number(e.high.toFixed(4)), ...(e.phases ? { phases: e.phases.map((p) => Number(p.likely.toFixed(4))) } : {}), addedLater: true } };
      }
    }
  });
  return changed;
}

// ---------- Cursor (records written by TokenScope's hook) ----------

// How Cursor's costs are worked out from the hook's records. Measured against a user's billed
// tokens from Cursor's usage page (Cursor 3.17, Sonnet 5.5, Oct 2026), not guessed:
//   - a fresh chat's first request carried about 27k tokens of Cursor's own text (instructions, rules, tools)
//   - an edit is reported with the whole file (167k characters for a 300-character change); the
//     bill implies about 2,400 characters per edit
//   - summarizing ran on the chat's own model, reading about half the conversation, without cache
const CURSOR = {
  batchMs: 2000, // tool results this close together came from one request
  readTokens: 2000, // what a file read adds when Cursor's own sizes aren't available (the hook doesn't say)
  toolTokens: 300, // the least another tool's result adds (the hook passes shortened results)
  requestOutput: 0, // extra output per request the hook doesn't report: measured as none once replies are fully counted
  baseContext: 27000, // Cursor's own text at the start of every chat
  prompt: 300, // the user's message at the start of each turn
  cacheMs: 5 * 60e3, // the cache expires after 5 quiet minutes
  wholeFile: 20000, // an edit bigger than this (in characters) is Cursor reporting the whole file
  editChars: 2400, // what such an edit really is, on average
  compactShare: 0.5, // the share of the conversation a summary reads
  compactOutput: 2000, // tokens a summary writes
  cacheHit: 0.95, // share of re-sent text read from cache (fits the bill best; Cursor's total was 90.6% of all input)
};
const CURSOR_BASE_CONTEXT = CURSOR.baseContext;
const tokensOf = (chars) => Math.round((chars || 0) / 4);
const isEditTool = (name) => /write|edit|replace|patch|create/i.test(name || "") && !/read/i.test(name || "");

function readCursorRecords(folder, since) {
  let files = [];
  try {
    files = fs.readdirSync(folder).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
  } catch {
    return [];
  }
  const records = [];
  for (const name of files) {
    if (Date.parse(name.slice(0, 10)) + DAY < since) continue;
    for (const line of fs.readFileSync(path.join(folder, name), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r.t >= since) records.push(r);
      } catch {}
    }
  }
  return cleanCursorRecords(records.sort((a, b) => a.t - b.t));
}

// Cursor reports each thinking step twice: once with the turn's id ("3e2c…") and once with a
// variant of it ("3e2c…-0-czmt"). The variant is reduced to the turn's id, and the second copy of
// a thinking step (same turn, same size, within 2 seconds) is dropped. Otherwise thinking counts
// twice, and every switch between the two ids looks like you writing a new message.
const baseGeneration = (gen) => (typeof gen === "string" ? gen.replace(/-\d+-[a-z0-9]{4}$/i, "") : gen);
function cleanCursorRecords(records) {
  const seen = new Map(); // conversation | turn | size -> when last seen
  const out = [];
  for (const r of records) {
    const gen = baseGeneration(r.gen);
    const clean = gen === r.gen ? r : { ...r, gen };
    if (r.e === "afterAgentThought") {
      const key = `${r.c}|${gen}|${r.out}`;
      const last = seen.get(key);
      seen.set(key, r.t);
      if (last !== undefined && r.t - last <= 2000) continue;
    }
    out.push(clean);
  }
  return out;
}

// Cursor runs a helper agent (subagentStart … subagentStop in a conversation) under a conversation
// id of its own. A conversation that falls entirely inside such a window belongs to that conversation.
// Returns a Map of helper conversation id -> the conversation that started it.
function cursorHelpers(byConversation) {
  const windows = [];
  for (const [id, records] of byConversation) {
    records.forEach((r, i) => {
      if (r.e !== "subagentStart") return;
      const stop = records.slice(i + 1).find((x) => x.e === "subagentStop");
      windows.push({ parent: id, start: r.t - 1000, end: stop ? stop.t + 5000 : r.t + 30 * 60e3 });
    });
  }
  const parentOf = new Map();
  for (const [id, records] of byConversation) {
    if (records.some((r) => r.e === "subagentStart")) continue; // starts helpers itself: a main conversation
    const first = records[0].t, last = records[records.length - 1].t;
    const w = windows.find((x) => x.parent !== id && first >= x.start && last <= x.end);
    if (w) parentOf.set(id, w.parent);
  }
  return parentOf;
}

// Format check on Cursor's own database (see cursordb.js): when it's there but no longer has the
// chats or sizes TokenScope expects, Cursor costs fall back to TokenScope's own estimate, and the
// warning says so. Only with a few recent chats, so a deleted chat or two doesn't trigger it.
function checkCursorChats(byConversation, info, checks) {
  const recent = [...byConversation.entries()].filter(([, records]) => records[records.length - 1].t > Date.now() - 3 * DAY && records.some((r) => r.gen));
  if (recent.length < 3) return;
  const fallback = "Cursor costs use TokenScope's own, less exact estimate until TokenScope is updated.";
  if (info.failed) return checks.mismatch("cursor", `Its chat database couldn't be read. ${fallback}`);
  if (!info.opened) return; // no database, or no SQLite here: the estimate is the normal path
  const found = recent.filter(([id]) => info.has(id));
  if (!found.length) return checks.mismatch("cursor", `Its chat database no longer lists chats where expected. ${fallback}`);
  if (!found.some(([id]) => info.get(id).end || info.get(id).turns.size)) checks.mismatch("cursor", `Its chat database no longer has chat sizes where expected. ${fallback}`);
}

// Format checks on the hook's records: Cursor sends the fields TokenScope expects.
function checkCursorRecords(records, checks) {
  if (records.length < 10) return;
  if (share(records, (r) => r.c) < 0.5) checks.mismatch("cursor", "Its hook events no longer carry a conversation id, so Cursor conversations can't be told apart.");
  const toolSteps = records.filter((r) => r.e === "postToolUse");
  if (toolSteps.length >= 10 && share(toolSteps, (r) => r.in > 0 || r.out > 0) < 0.2) checks.mismatch("cursor", "Its hook events no longer carry the tool input and output, so Cursor costs are too low.");
  if (share(records, (r) => r.model) < 0.5) checks.mismatch("cursor", "Its hook events no longer name the model, so Cursor costs can't be priced.");
}

// Replays one conversation's records step by step: the context grows with every tool result and
// reply, and each model request sends it all again. Calls back for each request with its cost parts.
// startContext: what the conversation already held when the records start (see startOffset).
// anchors: Cursor's own count of the conversation's size, from its local database (see
// cursorAnchors): { turns: Map(turn id -> size when that message was sent), end, endAt }. With
// them, each turn's growth is stretched to land on Cursor's size at the next turn.
// Requests: Cursor runs tool calls in batches. Tool results within batchMs of each other came
// from one request; a thought or reply after tool results starts a new one.
function replayCursor(records, onRequest, { startContext = CURSOR.baseContext, anchors = null } = {}) {
  // The changed text, from newer hooks. One that saw no edits (Cursor sending other fields than
  // expected) is ignored, so the edit falls back to the guess instead of counting as nothing.
  const edits = records.filter((r) => r.e === "afterFileEdit" && r.edits > 0 && (r.out || 0) + (r.del || 0) > 0);
  const used = new Set();
  // An edit's real size: the matching afterFileEdit step if there is one, else the reported
  // input, unless that's Cursor reporting the whole file.
  const editSize = (r) => {
    const match = edits.find((x) => !used.has(x) && x.c === r.c && Math.abs(x.t - r.t) < 10000);
    if (match) {
      used.add(match);
      return (match.out || 0) + (match.del || 0);
    }
    return r.in > CURSOR.wholeFile ? CURSOR.editChars : r.in;
  };
  // How much a step adds to the conversation. Cursor doesn't pass what a file read returned, so a
  // read counts as readTokens.
  const growth = (r) => {
    if (r.e === "afterAgentThought") return 0; // counted with the request's output
    if (r.e === "afterAgentResponse") return tokensOf(r.out);
    if (r.e !== "postToolUse") return 0;
    const input = isEditTool(r.tool) ? editSize(r) : r.in;
    const result = Math.max(tokensOf(r.out), /^read/i.test(r.tool || "") ? CURSOR.readTokens : CURSOR.toolTokens);
    return tokensOf(input) + 30 + result;
  };
  const steps = records.map((r) => ({ r, grow: growth(r) }));
  used.clear();

  // With anchors: stretch growth to what Cursor counted. A stretch runs from one known size to the
  // next: a turn's start, the size Cursor reports when it summarizes (and the restart after it),
  // and the chat's size at the end.
  const segmentOf = new Map(); // step -> stretch
  const stretches = [];
  if (anchors && anchors.turns && anchors.turns.size) {
    let current = null, gen = null;
    const open = (from) => (current = { from, to: undefined, raw: 0 }, stretches.push(current));
    steps.forEach((step, i) => {
      const r = step.r;
      if (r.gen && r.gen !== gen) {
        gen = r.gen;
        const at = anchors.turns.get(r.gen);
        if (current && current.to === undefined) current.to = at === undefined ? undefined : at - CURSOR.prompt;
        // The first turn of a chat TokenScope saw from its start grows from the starting size.
        open(at !== undefined ? at : stretches.length === 0 ? startContext : undefined);
      }
      if (r.e === "preCompact" && current) {
        current.to = r.ctx || undefined;
        open(CURSOR.baseContext + CURSOR.compactOutput);
        return;
      }
      if (current) {
        current.raw += step.grow;
        segmentOf.set(step, current);
      }
    });
    if (current && current.to === undefined) current.to = anchors.end;
    for (const x of stretches) {
      const target = x.from !== undefined && x.to !== undefined ? x.to - x.from : undefined;
      x.factor = target > 0 && x.raw > 0 ? Math.min(200, Math.max(0.1, target / x.raw)) : 1;
    }
  }

  let context = startContext, sent = 0, generation = null, pendingThought = 0, lastRequest = null, model = null;
  let batch = null, lastTool = 0; // batch: the request whose tool results are still coming in
  // A request is reported once it's complete: its output is added as its tool calls and reply come in.
  let unreported = null;
  const report = (request) => {
    if (unreported) onRequest(unreported);
    unreported = request;
  };
  const send = (r) => {
    // After 5 quiet minutes the cache is gone, and everything is re-read at full price.
    if (lastRequest !== null && r.t - lastRequest > CURSOR.cacheMs) sent = 0;
    lastRequest = r.t;
    model = r.model || model;
    const resent = Math.min(sent, context), fresh = context - resent;
    const request = { record: r, model: r.model || "unknown", resent, fresh, output: pendingThought + CURSOR.requestOutput, context, expired: resent === 0 && fresh > CURSOR.baseContext };
    pendingThought = 0;
    sent = context;
    report(request);
    return request;
  };
  for (const step of steps) {
    const { r, grow } = step;
    if (r.gen && r.gen !== generation) {
      generation = r.gen;
      const anchored = anchors && anchors.turns ? anchors.turns.get(r.gen) : undefined;
      context = anchored !== undefined ? anchored + CURSOR.prompt : context + CURSOR.prompt;
      batch = null;
    }
    if (r.e === "preCompact") {
      // Summarizing is a request of its own, on the chat's model, reading part of the
      // conversation without cache. Cursor tells the real size here, so the estimate restarts from it.
      const actual = r.ctx || context;
      report({ record: r, model: model || r.model || "unknown", resent: 0, fresh: Math.round(actual * CURSOR.compactShare), output: CURSOR.compactOutput, context: actual, expired: false, compaction: true });
      context = CURSOR.baseContext + CURSOR.compactOutput;
      sent = 0;
      batch = null;
      continue;
    }
    if (r.e === "afterAgentThought") {
      // Thinking comes first in the request it belongs to, so the next tool call or reply is a new request.
      pendingThought += tokensOf(r.out);
      batch = null;
      continue;
    }
    // A turn that ends on a thought: that thought was a request of its own (its reply isn't reported).
    if (r.e === "stop" && pendingThought) {
      send(r);
      batch = null;
      continue;
    }
    if (r.e !== "postToolUse" && r.e !== "afterAgentResponse") continue;
    const added = Math.round(grow * (segmentOf.has(step) ? segmentOf.get(step).factor : 1));
    if (r.e === "postToolUse") {
      // Tool results close together were asked for in one request.
      if (!batch || r.t - lastTool > CURSOR.batchMs) batch = send(r);
      // The call itself is written by the model: an edit's text, or a short call.
      batch.output += (isEditTool(r.tool) ? tokensOf(editSize(r)) : 0) + 30;
      lastTool = r.t;
    } else {
      send(r).output += tokensOf(r.out);
      batch = null;
    }
    context += added;
  }
  report(null);
  used.clear();
}

// What a conversation already held when TokenScope's records start. A chat that began before
// tracking was switched on has no sessionStart step; if Cursor later summarized it, the real size it
// reported then shows how much was missing, and that's added from the start.
function startOffset(records) {
  if (records.some((r) => r.e === "sessionStart" && r.t <= records[0].t + 1000)) return CURSOR.baseContext;
  const first = records.find((r) => r.e === "preCompact" && r.ctx);
  if (!first) return CURSOR.baseContext;
  let before = CURSOR.baseContext;
  replayCursor(records.filter((r) => r.t < first.t), (p) => (before = p.context));
  return CURSOR.baseContext + Math.max(0, first.ctx - before);
}

// Replays, calling onRecord for every record before the requests it leads to, so job marks can
// switch attribution on and off at the right moment.
function replayInterleaved(records, onRecord, onRequest, anchors = null) {
  const collected = [];
  replayCursor(records, (part) => collected.push(part), { startContext: startOffset(records), anchors });
  let i = 0;
  for (const r of records) {
    onRecord(r);
    while (i < collected.length && collected[i].record === r) onRequest(collected[i++]);
  }
}

// Within the cache window most re-sent text is cached (cacheHit); after it expired, none is.
// One request's usage. Summarizing reads without the cache, so it's plain input; other requests
// write what's new to the cache, and read the rest from it (cacheHit of it, the rest is lost).
function cursorParts(part, cacheHit) {
  if (part.compaction) return { requests: 1, input: part.fresh, cacheRead: 0, write5m: 0, write1h: 0, output: part.output };
  return { requests: 1, input: 0, cacheRead: part.resent * cacheHit, write5m: part.fresh + part.resent * (1 - cacheHit), write1h: 0, output: part.output };
}

function cursorUsage(byModel, model, part, cacheHit) {
  const u = byModel.get(model) || ZERO();
  const p = cursorParts(part, cacheHit);
  for (const k of Object.keys(p)) u[k] += p[k];
  byModel.set(model, u);
}

// Cursor's own sizes for a conversation, as replayCursor's anchors (see cursordb.js).
const anchorsOf = (info) => (info && (info.turns.size || info.end) ? { turns: info.turns, end: info.end } : null);

function readCursor(models, since, { folder, checks = NO_CHECKS, cacheHit = CURSOR.cacheHit, chats = cursorChats } = {}) {
  const all = readCursorRecords(folder, since);
  checkCursorRecords(all, checks);
  const byConversation = new Map();
  for (const r of all) {
    if (!r.c) continue;
    if (!byConversation.has(r.c)) byConversation.set(r.c, []);
    byConversation.get(r.c).push(r);
  }
  const parentOf = cursorHelpers(byConversation);
  const info = chats([...byConversation.keys()]);
  checkCursorChats(byConversation, info, checks);
  const out = [];
  for (const [id, records] of byConversation) {
    if (parentOf.has(id)) continue; // a helper agent: counted with the conversation that started it
    const byModel = new Map();
    const requests = [];
    const genStart = new Map();
    for (const r of records) if (r.gen && !genStart.has(r.gen)) genStart.set(r.gen, r.t);
    replayCursor(records, (part) => {
      cursorUsage(byModel, part.model, part, cacheHit);
      const p = findPricedModel(models, part.model);
      const t = part.record.t, prev = requests[requests.length - 1];
      let pause = null;
      if (prev) {
        const started = part.record.gen && genStart.get(part.record.gen);
        const shell = records.filter((x) => x.e === "afterShellExecution" && x.t > prev.t && x.t <= t).sort((a, b) => (b.ms || 0) - (a.ms || 0))[0];
        if (started && started > prev.t) pause = { ms: started - prev.t, who: "you", kind: null };
        else if (shell) pause = { ms: shell.ms || t - prev.t, who: "tool", kind: shell.kind || "other" };
        else pause = { ms: t - prev.t, who: "unknown", kind: null };
      }
      const usage = cursorParts(part, cacheHit);
      requests.push({ t, model: p, pause, context: part.context, fresh: usage.input + usage.write5m, cached: usage.cacheRead, output: part.output, cost: p ? usageCost(p, usage) : 0 });
    }, { startContext: startOffset(records), anchors: anchorsOf(info.get(id)) });
    // Helper agents: their own context, replayed separately, added to this conversation's cost.
    let helperCost = 0, end = records[records.length - 1].t;
    const includes = [];
    for (const [child, parent] of parentOf) {
      if (parent !== id) continue;
      includes.push(`cursor:${child}`);
      const helper = byConversation.get(child);
      replayCursor(helper, (part) => {
        cursorUsage(byModel, part.model, part, cacheHit);
        const p = findPricedModel(models, part.model);
        if (p) helperCost += usageCost(p, cursorParts(part, cacheHit));
      }, { anchors: anchorsOf(info.get(child)) });
      end = Math.max(end, helper[helper.length - 1].t);
    }
    const priced = summarize(byModel, models);
    if (!priced.models.length) continue;
    const indexAt = (t) => Math.max(0, requests.findIndex((q) => q.t >= t));
    const tools = records.filter((r) => r.e === "postToolUse").map((r) => {
      const kind = /read|view|open/i.test(r.tool || "") ? "read" : /edit|write|replace|apply|create|delete/i.test(r.tool || "") ? "edit" : "other";
      return { t: r.t, after: indexAt(r.t), kind, tool: r.tool, file: null, ms: r.ms || 0, outTokens: tokensOf(r.out) };
    }).concat(records.filter((r) => r.e === "afterShellExecution" && (r.kind === "build" || r.kind === "test")).map((r) => ({
      t: r.t, after: indexAt(r.t), kind: r.kind, tool: "shell", file: null, ms: r.ms || 0, outTokens: 0,
    })));
    const jobIds = [...new Set(records.filter((r) => r.job).map((r) => r.job))];
    out.push({
      id: `cursor:${id}`, tool: "cursor", title: (info.get(id) || {}).name || (records.find((r) => r.title) || {}).title || "Cursor conversation",
      project: (records.find((r) => r.project) || {}).project || null,
      start: records[0].t, end, approximate: true, ...((info.get(id) || {}).archived ? { archived: true } : {}), ...(includes.length ? { includes } : {}), jobIds, ...priced,
      insights: analyze({ requests, tools, cacheMinutes: 5, helperCost, total: priced.cost }),
    });
  }
  return out;
}

// Approximate real costs of jobs that ran in Cursor: requests after the job's estimate (or
// continue_job) in its conversation, until finish_job or another job starts there.
function cursorJobActuals(jobs, models, folder, now = Date.now(), cacheHit = CURSOR.cacheHit, keep = 30, chats = cursorChats) {
  // Finished plans are measured again while their records are kept, so a better reading of
  // Cursor's records (a newer TokenScope) also corrects plans that ran before it.
  const open = jobs.filter((j) => !j.actual || j.actual.source === "ai" ||
    (j.actual.source === "cursor-hook" && (j.actual.status === "running" || Date.parse(j.createdAt) > now - keep * DAY)));
  if (!open.length) return {};
  const since = Math.min(...open.map((j) => Date.parse(j.createdAt))) - 60e3;
  const records = readCursorRecords(folder, since);
  const grouped = new Map();
  for (const r of records) {
    if (!r.c) continue;
    if (!grouped.has(r.c)) grouped.set(r.c, []);
    grouped.get(r.c).push(r);
  }
  const parentOf = cursorHelpers(grouped);
  const info = chats([...grouped.keys()]);
  const changes = {};
  for (const job of open) {
    const conversations = new Set(records.filter((r) => r.job === job.id).map((r) => r.c));
    if (!conversations.size) continue;
    const byModel = new Map();
    let last = 0;
    // Finished: the hook saw finish_job, or TokenScope saved the finish itself. Cursor writes its
    // record only after the tool has answered, so right at finish_job only TokenScope's time exists.
    const endedAt = job.endedAt ? Date.parse(job.endedAt) : Infinity;
    const finished = Number.isFinite(endedAt) || records.some((r) => r.job === job.id && r.action === "finish_job");
    for (const conv of conversations) {
      let active = false, from = null;
      const spans = []; // when the job was running in this conversation
      replayInterleaved(grouped.get(conv) || [], (r) => {
        if (!r.job) return;
        const now = r.job === job.id && r.action !== "finish_job";
        if (now && !active) from = r.t;
        if (!now && active) spans.push([from, r.t]);
        active = now;
      }, (part) => {
        if (!active || part.record.t >= endedAt) return;
        cursorUsage(byModel, part.model, part, cacheHit);
        last = Math.max(last, part.record.t);
      }, anchorsOf(info.get(conv)));
      if (active) spans.push([from, endedAt]);
      // Helper agents this conversation started while the job was running count too.
      for (const [child, parent] of parentOf) {
        if (parent !== conv) continue;
        replayCursor(grouped.get(child), (part) => {
          if (!spans.some(([a, b]) => part.record.t >= a && part.record.t < b)) return;
          cursorUsage(byModel, part.model, part, cacheHit);
          last = Math.max(last, part.record.t);
        }, { anchors: anchorsOf(info.get(child)) });
      }
    }
    const priced = summarize(byModel, models);
    if (!priced.models.length) continue;
    const main = priced.models[0];
    changes[job.id] = {
      modelId: main.modelId || main.model,
      costUsd: Number(priced.cost.toFixed(4)),
      inputTokens: Math.round(priced.models.reduce((s, m) => s + m.input, 0)),
      outputTokens: Math.round(priced.models.reduce((s, m) => s + m.output, 0)),
      source: "cursor-hook",
      approximate: true,
      status: !finished && now - last < 15 * 60e3 ? "running" : "done",
      lastActivity: new Date(last).toISOString(),
      models: byCost(priced.models.map((m) => ({ model: m.modelId || m.model, cost: m.cost === null ? null : Number(m.cost.toFixed(4)) }))),
      recordedAt: new Date(now).toISOString(),
      ...(priced.unpriced ? { unpricedModels: priced.models.filter((m) => m.cost === null).map((m) => m.model) } : {}),
    };
  }
  return changes;
}

// Saves Cursor jobs' approximate real costs. A cost measured exactly elsewhere (Claude Code, Codex) wins.
function syncCursorActuals(store, models, folder) {
  const changes = cursorJobActuals(store.read().jobs, models, folder);
  if (!Object.keys(changes).length) return 0;
  let changed = 0;
  store.update((data) => {
    for (const job of data.jobs) {
      const actual = changes[job.id];
      if (!actual || (job.actual && ["claude-code", "codex", "opencode"].includes(job.actual.source))) continue;
      if (job.actual && JSON.stringify({ ...job.actual, recordedAt: 0 }) === JSON.stringify({ ...actual, recordedAt: 0 })) continue;
      job.actual = actual;
      changed++;
    }
  });
  return changed;
}

// ---------- Zed (its own agent's threads database, see zed.js) ----------

// Zed keeps one exact total per conversation, so a conversation has its cost, models and subagents,
// but no breakdown of what drove the cost (totalsOnly).
function zedGroups(threads) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const rootOf = (t) => {
    let root = t, seen = new Set([t.id]);
    while (root.parent && byId.has(root.parent) && !seen.has(root.parent)) {
      root = byId.get(root.parent);
      seen.add(root.id);
    }
    return root;
  };
  const groups = new Map(); // root id -> { root, helpers }
  for (const t of threads) {
    const root = rootOf(t);
    if (!groups.has(root.id)) groups.set(root.id, { root, helpers: [] });
    if (root !== t) groups.get(root.id).helpers.push(t);
  }
  return [...groups.values()];
}

const zedUsage = (t) => ({ requests: 0, input: t.tokens.input, cacheRead: t.tokens.read, write5m: t.tokens.write, write1h: 0, output: t.tokens.output });
function zedCost(models, group) {
  const byModel = new Map();
  let helperCost = 0;
  const helpers = [];
  for (const t of [group.root, ...group.helpers]) {
    const name = t.model || "unknown";
    const u = byModel.get(name) || ZERO();
    const add = zedUsage(t);
    for (const k of Object.keys(add)) u[k] += add[k];
    byModel.set(name, u);
    if (t !== group.root) {
      const p = findPricedModel(models, name);
      const cost = p ? usageCost(p, add) : 0;
      helperCost += cost;
      helpers.push({ title: t.title || "Subagent", cost, models: [{ model: name, modelId: p ? p.id : null }] });
    }
  }
  return { priced: summarize(byModel, models), helperCost, helpers };
}

async function readZed(models, since, { folder, checks = NO_CHECKS } = {}) {
  const out = [];
  for (const group of zedGroups(await loadZedThreads(folder, checks))) {
    const all = [group.root, ...group.helpers];
    const end = Math.max(...all.map((t) => t.end));
    if (end < since) continue;
    const { priced, helpers } = zedCost(models, group);
    if (!priced.models.length) continue;
    out.push({
      id: `zed:${group.root.id}`, tool: "zed", title: group.root.title || "Untitled conversation",
      project: group.root.project, start: Math.min(...all.map((t) => t.start || t.end)), end, approximate: false, totalsOnly: true,
      jobIds: [...new Set(all.flatMap((t) => t.jobs))], ...priced,
      ...(helpers.length ? { helpers, includes: group.helpers.map((h) => `zed:${h.id}`) } : {}),
      insights: null, // no per-request times, so nothing to break the cost down by
    });
  }
  return out;
}

// Real costs of plans made in Zed: the whole conversation the plan was made in (Zed keeps one total
// per conversation), so wholeChat is set and the app says so. Exact otherwise.
async function findZedActuals(jobs, models, { folder, now = Date.now() } = {}) {
  const open = jobs.filter((j) => Date.parse(j.createdAt) > now - 60 * 86400e3 &&
    (!j.actual || j.actual.source === "ai" || (j.actual.source === "zed" && (j.actual.status === "running" || !j.endedAt))));
  if (!open.length) return {};
  const groups = zedGroups(await loadZedThreads(folder));
  const changes = {};
  for (const job of open) {
    const group = groups.find((g) => [g.root, ...g.helpers].some((t) => t.jobs.includes(job.id)));
    if (!group) continue;
    const { priced } = zedCost(models, group);
    if (!priced.models.length) continue;
    const main = [...priced.models].sort((a, b) => b.output - a.output)[0];
    const sum = (key) => priced.models.reduce((total, m) => total + m[key], 0);
    const last = Math.max(group.root.end, ...group.helpers.map((t) => t.end));
    const actual = {
      modelId: main.modelId || main.model, costUsd: Number(priced.cost.toFixed(4)),
      inputTokens: sum("input"), cachedTokens: sum("cacheRead"), cacheWriteTokens: sum("cacheWrite"), outputTokens: sum("output"),
      source: "zed", wholeChat: true, status: !job.endedAt && now - last < 15 * 60e3 ? "running" : "done",
      sessionId: group.root.id, lastActivity: new Date(last).toISOString(),
      models: byCost(priced.models.map((m) => ({ model: m.modelId || m.model, cost: m.cost === null ? null : Number(m.cost.toFixed(4)) }))),
      ...(priced.unpriced ? { unpricedModels: priced.models.filter((m) => m.cost === null).map((m) => m.model) } : {}),
    };
    const mainPriced = models.find((m) => m.id === actual.modelId);
    const addEstimate = job.plan && mainPriced && !(job.estimates || {})[actual.modelId] ? estimateJob(mainPriced, job.plan) : null;
    const before = job.actual ? JSON.stringify({ ...job.actual, recordedAt: undefined }) : null;
    if (before !== JSON.stringify({ ...actual, recordedAt: undefined }) || addEstimate) {
      changes[job.id] = { actual: { ...actual, recordedAt: new Date(now).toISOString() }, addEstimate };
    }
  }
  return changes;
}

async function syncZedActuals(store, models, options) {
  const changes = await findZedActuals(store.read().jobs, models, options);
  if (!Object.keys(changes).length) return 0;
  let changed = 0;
  store.update((data) => {
    for (const job of data.jobs) {
      const change = changes[job.id];
      if (!change || (job.actual && ["claude-code", "codex", "opencode"].includes(job.actual.source))) continue;
      job.actual = change.actual;
      changed++;
      if (change.addEstimate) {
        const e = change.addEstimate;
        job.estimates = { ...(job.estimates || {}), [change.actual.modelId]: { low: Number(e.low.toFixed(4)), likely: Number(e.likely.toFixed(4)), high: Number(e.high.toFixed(4)), ...(e.phases ? { phases: e.phases.map((p) => Number(p.likely.toFixed(4))) } : {}), addedLater: true } };
      }
    }
  });
  return changed;
}

module.exports = { dropForkCopies, readZed, findZedActuals, syncZedActuals, CURSOR, startOffset, cursorParts, readClaudeCode, readCodex, readOpenCode, findOpenCodeActuals, syncOpenCodeActuals, openCodeFolder, openCodeFolders, openCodeFound, readCursor, readCursorRecords, cursorJobActuals, syncCursorActuals, replayCursor, summarize };
