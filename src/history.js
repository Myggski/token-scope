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
const { listAllLogs, logsFolders, parseLines, sumUsage, findPricedModel, usageCost } = require("./claudelogs");
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
function claudeTimeline(lines, models) {
  const requests = [], tools = [], pending = new Map(), seen = new Set();
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

async function readClaudeCode(models, since, { folder, checks = NO_CHECKS } = {}) {
  const logs = await listAllLogs(folder ? [folder] : logsFolders(), since);
  const out = [];
  let assistants = 0, withUsage = 0;
  for (const log of logs) {
    if (log.file.includes(`${path.sep}subagents${path.sep}`)) continue;
    const sessionFolder = log.file.replace(/\.jsonl$/, "") + path.sep;
    const helpers = logs.filter((l) => l.file.startsWith(sessionFolder));
    const key = [log.mtime, ...helpers.map((h) => h.mtime)].join(",") + `|${models.length}`;
    const hit = claudeCache.get(log.file);
    if (hit && hit.key === key) {
      assistants += hit.assistants;
      withUsage += hit.withUsage;
      if (hit.summary) out.push(hit.summary);
      continue;
    }
    const lines = parseLines(await fs.promises.readFile(log.file, "utf8").catch(() => ""));
    const helperLines = [];
    for (const h of helpers) helperLines.push(parseLines(await fs.promises.readFile(h.file, "utf8").catch(() => "")));
    // Format check: recent replies should carry token counts. Only the last ones count: a resumed
    // or copied conversation can start with older replies that never had them.
    const replies = lines.filter((l) => l.entry.type === "assistant").slice(-30);
    const counted = replies.filter((l) => l.entry.message && l.entry.message.usage && typeof l.entry.message.usage.output_tokens === "number").length;
    assistants += replies.length;
    withUsage += counted;

    const { byModel } = sumUsage([lines, ...helperLines], -Infinity, Infinity);
    let title = null, cwd = null, start = null, end = null, sessionId = null;
    const jobIds = new Set();
    for (const { entry, raw } of lines) {
      if (entry.type === "ai-title" && entry.aiTitle) title = entry.aiTitle;
      if (!cwd && entry.cwd) cwd = entry.cwd;
      if (!sessionId && entry.sessionId) sessionId = entry.sessionId;
      if (entry.timestamp) {
        const t = Date.parse(entry.timestamp);
        if (start === null || t < start) start = t;
        if (end === null || t > end) end = t;
      }
      if (raw.includes("job_id")) (raw.match(/job-[a-z0-9]{8,}/g) || []).forEach((id) => jobIds.add(id));
    }
    const priced = summarize(byModel, models);
    let helperCost = 0;
    for (const [name, u] of sumUsage(helperLines, -Infinity, Infinity).byModel) {
      const p = findPricedModel(models, name);
      if (p) helperCost += usageCost(p, u);
    }
    const summary = priced.models.length && start !== null ? {
      id: `claude-code:${sessionId || path.basename(log.file, ".jsonl")}`,
      tool: "claude-code", title: title || "Untitled conversation", project: cwd ? path.basename(cwd) : null,
      start, end, approximate: false, jobIds: [...jobIds], ...priced,
      insights: analyze({ ...claudeTimeline(lines, models), helperCost, total: priced.cost }),
    } : null;
    claudeCache.set(log.file, { key, summary, assistants: replies.length, withUsage: counted });
    if (summary) out.push(summary);
  }
  if (assistants >= 10 && withUsage / assistants < 0.5) {
    checks.mismatch("claude-code", "Its logs no longer have token counts where expected, so Claude Code costs are missing or too low.");
  }
  return out;
}

// ---------- Codex ----------

const codexLogs = require("./codexlogs");

function readCodex(models, since, options = {}) {
  return codexLogs.readCodex(models, since, { ...options, summarize, analyze });
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
    return { messages, sessions, marks: [], found: false };
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
        add(openCodeMessage(row, asJson(row.data) || row));
        if (typeof row.data === "string" && row.data.includes("job_id")) rawMarks.push([row.data, asJson(row.data), row]);
      }
    }
    for (const table of ["part", "session_part", "message_part"]) {
      for (const row of tableRows(db, table) || []) {
        if (typeof row.data === "string" && row.data.includes("job_id")) rawMarks.push([row.data, asJson(row.data), row]);
      }
    }
    for (const table of ["session_v2", "session"]) {
      for (const row of tableRows(db, table) || []) {
        const data = asJson(row.data) || {};
        const id = row.id || data.id;
        if (id && !sessions.has(id)) sessions.set(id, { title: row.title || data.title || null, cwd: row.directory || data.directory || (data.path && data.path.cwd) || null });
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
      add(openCodeMessage({}, asJson(fs.readFileSync(file, "utf8"))));
    } catch {}
  });
  walk(path.join(storage, "part"), 2, (file) => {
    try {
      if (fs.statSync(file).mtimeMs < since) return;
      const raw = fs.readFileSync(file, "utf8");
      if (raw.includes("job_id")) rawMarks.push([raw, asJson(raw), null]);
    } catch {}
  });
  walk(path.join(storage, "session"), 3, (file) => {
    const data = asJson(fs.readFileSync(file, "utf8"));
    if (data && data.id && !sessions.has(data.id)) sessions.set(data.id, { title: data.title || null, cwd: data.directory || null });
  });
  // Format checks: the message tables, and token counts on replies.
  if (databases.length && !knownTables && !jsonMessages) checks.mismatch("opencode", "Its database doesn't have the tables TokenScope reads, so OpenCode conversations are missing.");
  if (all.length >= 5 && share(all, (m) => m.hasTokens) < 0.5) checks.mismatch("opencode", "Its replies no longer have token counts where expected, so OpenCode costs are missing or too low.");
  const timeOf = (id) => (id && messages.has(id) ? messages.get(id).time : null);
  const marks = rawMarks.flatMap(([raw, data, row]) => jobMarksIn(raw, data, row, timeOf));
  return { messages, sessions, marks, found: true };
}

// All OpenCode folders together.
async function loadAllOpenCode(folders, since, checks) {
  const messages = new Map(), sessions = new Map(), marks = [];
  for (const folder of folders) {
    const part = await loadOpenCode(folder, since, checks);
    for (const [id, m] of part.messages) if (!messages.has(id)) messages.set(id, m);
    for (const [id, info] of part.sessions) if (!sessions.has(id)) sessions.set(id, info);
    marks.push(...part.marks);
  }
  return { messages, sessions, marks };
}

async function readOpenCode(models, since, { folder, checks = NO_CHECKS } = {}) {
  const { messages, sessions, marks } = await loadAllOpenCode(folder ? [folder] : openCodeFolders(), since, checks);
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
  const out = [];
  for (const [id, list] of bySession) {
    const byModel = new Map(), own = new Map();
    let start = Infinity, end = 0, cwd = null;
    for (const m of list) {
      const u = byModel.get(m.model) || ZERO();
      u.requests += 1;
      u.input += m.tokens.input;
      u.cacheRead += m.tokens.read;
      u.write5m += m.tokens.write;
      u.output += m.tokens.output;
      byModel.set(m.model, u);
      if (m.cost !== null) own.set(m.model, (own.get(m.model) || 0) + m.cost);
      start = Math.min(start, m.time);
      end = Math.max(end, m.time);
      cwd = cwd || m.cwd;
    }
    if (end < since) continue;
    const info = sessions.get(id) || {};
    const priced = summarize(byModel, models, own);
    if (!priced.models.length) continue;
    const ordered = [...list].sort((a, b) => a.time - b.time);
    const requests = ordered.map((m, i) => {
      const p = findPricedModel(models, m.model);
      const usage = { requests: 1, input: m.tokens.input, cacheRead: m.tokens.read, write5m: m.tokens.write, write1h: 0, output: m.tokens.output };
      return {
        t: m.time, model: p, pause: i ? { ms: m.time - ordered[i - 1].time, who: "unknown", kind: null } : null,
        context: m.tokens.input + m.tokens.read + m.tokens.write, fresh: m.tokens.input + m.tokens.write, cached: m.tokens.read,
        output: m.tokens.output, cost: p ? usageCost(p, usage) : m.cost || 0,
      };
    });
    out.push({
      id: `opencode:${id}`, tool: "opencode", title: info.title || "Untitled conversation",
      project: info.cwd || cwd ? path.basename(info.cwd || cwd) : null, start, end, approximate: false, jobIds: [...(jobsBySession.get(id) || [])], ...priced,
      insights: analyze({ requests, tools: [], cacheMinutes: 5, total: priced.cost }),
    });
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
  const { messages, marks } = await loadAllOpenCode(folder ? [folder] : openCodeFolders(), since);
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
      for (const m of list) {
        if (!(m.time >= start && m.time < end)) continue;
        const u = byModel.get(m.model) || ZERO();
        u.requests += 1;
        u.input += m.tokens.input;
        u.cacheRead += m.tokens.read;
        u.write5m += m.tokens.write;
        u.output += m.tokens.output;
        byModel.set(m.model, u);
        if (m.cost !== null) own.set(m.model, (own.get(m.model) || 0) + m.cost);
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
      lastActivity: new Date(last || first).toISOString(),
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

const CURSOR_BASE_CONTEXT = 12000; // assumed: Cursor's own instructions, rules and tool list
const CURSOR_PROMPT = 300; // assumed: the user's message at the start of each turn
const CURSOR_CACHE_MS = 5 * 60e3; // the cache expires after 5 quiet minutes
const tokensOf = (chars) => Math.round((chars || 0) / 4);

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
  return records.sort((a, b) => a.t - b.t);
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
// reply, and each step sends it all again. Calls back for each model request with its cost parts.
function replayCursor(records, onRequest) {
  let context = CURSOR_BASE_CONTEXT, sent = 0, generation = null, pendingThought = 0, lastRequest = null;
  for (const r of records) {
    if (r.gen && r.gen !== generation) {
      generation = r.gen;
      context += CURSOR_PROMPT;
    }
    if (r.e === "preCompact") {
      // Compacting is itself a request that reads everything and writes a summary. Cursor tells
      // the real context size here, which corrects the running estimate.
      const actual = r.ctx || context;
      const resent = Math.min(sent, actual);
      onRequest({ record: r, model: r.model || "unknown", resent, fresh: actual - resent, output: 2000, context: actual, expired: false });
      context = CURSOR_BASE_CONTEXT + 2000;
      sent = 0;
      continue;
    }
    if (r.e === "afterAgentThought") {
      pendingThought += tokensOf(r.out);
      continue;
    }
    if (r.e !== "postToolUse" && r.e !== "afterAgentResponse") continue;
    const output = (r.e === "postToolUse" ? tokensOf(r.in) + 30 : tokensOf(r.out)) + pendingThought;
    pendingThought = 0;
    // After 5 quiet minutes the cache is gone, and everything is re-read at full price.
    if (lastRequest !== null && r.t - lastRequest > CURSOR_CACHE_MS) sent = 0;
    lastRequest = r.t;
    const resent = Math.min(sent, context), fresh = context - resent;
    onRequest({ record: r, model: r.model || "unknown", resent, fresh, output, context, expired: resent === 0 && fresh > CURSOR_BASE_CONTEXT });
    sent = context;
    context += r.e === "postToolUse" ? tokensOf(r.in) + 30 + tokensOf(r.out) : tokensOf(r.out);
  }
}

// Replays, calling onRecord for every record before the requests it leads to, so job marks can
// switch attribution on and off at the right moment.
function replayInterleaved(records, onRecord, onRequest) {
  const collected = [];
  replayCursor(records, (part) => collected.push(part));
  let i = 0;
  for (const r of records) {
    onRecord(r);
    while (i < collected.length && collected[i].record === r) onRequest(collected[i++]);
  }
}

// Within the cache window most re-sent text is cached (cacheHit); after it expired, none is.
function cursorUsage(byModel, model, part, cacheHit) {
  const u = byModel.get(model) || ZERO();
  u.requests += 1;
  u.cacheRead += part.resent * cacheHit;
  u.write5m += part.fresh + part.resent * (1 - cacheHit);
  u.output += part.output;
  byModel.set(model, u);
}

function readCursor(models, since, { folder, checks = NO_CHECKS, cacheHit = DEFAULT_CACHE_HIT } = {}) {
  const all = readCursorRecords(folder, since);
  checkCursorRecords(all, checks);
  const byConversation = new Map();
  for (const r of all) {
    if (!r.c) continue;
    if (!byConversation.has(r.c)) byConversation.set(r.c, []);
    byConversation.get(r.c).push(r);
  }
  const out = [];
  for (const [id, records] of byConversation) {
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
      const usage = { requests: 1, input: 0, cacheRead: part.resent * cacheHit, write5m: part.fresh + part.resent * (1 - cacheHit), write1h: 0, output: part.output };
      requests.push({ t, model: p, pause, context: part.context, fresh: usage.write5m, cached: usage.cacheRead, output: part.output, cost: p ? usageCost(p, usage) : 0 });
    });
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
      id: `cursor:${id}`, tool: "cursor", title: (records.find((r) => r.title) || {}).title || "Cursor conversation",
      project: (records.find((r) => r.project) || {}).project || null,
      start: records[0].t, end: records[records.length - 1].t, approximate: true, jobIds, ...priced,
      insights: analyze({ requests, tools, cacheMinutes: 5, total: priced.cost }),
    });
  }
  return out;
}

// Approximate real costs of jobs that ran in Cursor: requests after the job's estimate (or
// continue_job) in its conversation, until finish_job or another job starts there.
function cursorJobActuals(jobs, models, folder, now = Date.now(), cacheHit = DEFAULT_CACHE_HIT) {
  const open = jobs.filter((j) => !j.actual || j.actual.source === "ai" || (j.actual.source === "cursor-hook" && j.actual.status === "running"));
  if (!open.length) return {};
  const since = Math.min(...open.map((j) => Date.parse(j.createdAt))) - 60e3;
  const records = readCursorRecords(folder, since);
  const changes = {};
  for (const job of open) {
    const conversations = new Set(records.filter((r) => r.job === job.id).map((r) => r.c));
    if (!conversations.size) continue;
    const byModel = new Map();
    let last = 0;
    const finished = records.some((r) => r.job === job.id && r.action === "finish_job");
    for (const conv of conversations) {
      let active = false;
      replayInterleaved(records.filter((r) => r.c === conv), (r) => {
        if (r.job) active = r.job === job.id && r.action !== "finish_job";
      }, (part) => {
        if (!active) return;
        cursorUsage(byModel, part.model, part, cacheHit);
        last = Math.max(last, part.record.t);
      });
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

module.exports = { readClaudeCode, readCodex, readOpenCode, findOpenCodeActuals, syncOpenCodeActuals, openCodeFolder, openCodeFolders, openCodeFound, readCursor, readCursorRecords, cursorJobActuals, syncCursorActuals, replayCursor, summarize };
