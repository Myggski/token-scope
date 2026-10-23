// Codex (CLI, IDE extension and the Codex app): what conversations and jobs really cost, from the
// session logs Codex keeps itself. Read in place, nothing copied.
//   ${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl   (newer builds: .jsonl.zst)
//   ${CODEX_HOME:-~/.codex}/archived_sessions/...                          (archived conversations)
// OpenAI doesn't document this format and it changes between releases. What's read:
//   session_meta    first line: id, cwd, start time. forked_from_id, or source.subagent.thread_spawn
//                   .parent_thread_id, when the log continues another one.
//   turn_context    the model in use from then on.
//   event_msg       token_count: info.last_token_usage (this request) and info.total_token_usage
//                   (running total). input_tokens includes cached_input_tokens, and output_tokens
//                   includes reasoning_output_tokens. Repeated events whose total didn't move are
//                   skipped. thread_settings_applied: the speed tier (fast costs 2x, flex 0.5x).
//                   user_message: you wrote something (for pauses and the title).
//   token_usage_record + compacted: a compaction's own request, counted once.
//   response_item   function_call / custom_tool_call / local_shell_call and their outputs: tool use.
// A forked or subagent log starts with a copy of its parent's history. That copy is skipped by
// matching it against the parent's requests, or, without the parent, as the burst of requests
// written within a second of each other at the start.
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const zlib = require("zlib");
const { Transform } = require("stream");
const { byCost, findPricedModel, usageCost } = require("./claudelogs");
const { estimateJob } = require("./estimate");
const { commandKind } = require("./insights");
const { wslHomes } = require("./wsl");
const { activitySpans } = require("./activity");

const RUNNING_WINDOW = 15 * 60e3; // a log written to in the last 15 minutes counts as still running
const LOOK_BACK = 60 * 24 * 3600e3; // jobs older than 60 days are left alone
const BURST_MS = 1000; // copied history is written all at once
const FALLBACK_MODEL = "gpt-5"; // the earliest logs don't name the model
const TIERS = { priority: 2, fast: 2, flex: 0.5, default: 1, standard: 1 };
const TIER_LABEL = { 2: "fast", 0.5: "flex" };

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// Codex's folders: this computer's, plus Codex run inside WSL (see wsl.js).
function codexHomes() {
  return [codexHome(), ...wslHomes().map((home) => path.join(home, ".codex"))];
}

function codexFound(homes = codexHomes()) {
  return [].concat(homes).some((home) => fs.existsSync(path.join(home, "sessions")) || fs.existsSync(path.join(home, "archived_sessions")));
}

// Every rollout file, once: a plain copy wins over a .zst one, sessions/ wins over archived_sessions/.
async function listRollouts(homes = codexHomes()) {
  const found = new Map(); // folder + file name without .zst -> { file, mtime, size, rank, home }
  let home;
  const walk = async (dir, depth, archived) => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) await walk(full, depth + 1, archived);
        continue;
      }
      if (!/\.jsonl(\.zst)?$/.test(entry.name)) continue;
      const key = `${home}|${entry.name.replace(/\.zst$/, "")}`;
      const rank = (archived ? 2 : 0) + (entry.name.endsWith(".zst") ? 1 : 0);
      const known = found.get(key);
      if (known && known.rank <= rank) continue;
      try {
        const stat = await fs.promises.stat(full);
        found.set(key, { file: full, mtime: stat.mtimeMs, size: stat.size, rank, home, archived });
      } catch {}
    }
  };
  for (home of [].concat(homes)) {
    await walk(path.join(home, "sessions"), 0, false);
    await walk(path.join(home, "archived_sessions"), 0, true);
  }
  return [...found.values()];
}

// Zstandard: Node's own decoder where there is one (Node 22.15+), else fzstd (plain JavaScript),
// which is what the app itself uses (Electron 33 runs Node 20).
function zstdStream({ forceJs = false } = {}) {
  if (zlib.createZstdDecompress && !forceJs) return zlib.createZstdDecompress();
  const { Decompress } = require("fzstd");
  let out;
  const decoder = new Decompress((chunk) => out.push(Buffer.from(chunk)));
  out = new Transform({
    transform(chunk, encoding, done) {
      try {
        decoder.push(new Uint8Array(chunk));
        done();
      } catch (error) {
        done(error);
      }
    },
    flush(done) {
      try {
        decoder.push(new Uint8Array(0), true);
        done();
      } catch (error) {
        done(error);
      }
    },
  });
  return out;
}

// The log line by line, without loading it all (logs can be hundreds of MB).
async function* rolloutLines(file, options) {
  let stream = fs.createReadStream(file);
  if (file.endsWith(".zst")) {
    const unpack = zstdStream(options);
    stream.on("error", (error) => unpack.destroy(error));
    stream = stream.pipe(unpack);
  }
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) if (line) yield line;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// One request's tokens in a common shape. input includes cached, as Codex records it.
function tokens(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = num(raw.input_tokens);
  const cached = Math.min(num(raw.cached_input_tokens), input);
  return {
    input, cached,
    write: Math.min(num(raw.cache_creation_tokens), input - cached),
    output: num(raw.output_tokens),
    reasoning: num(raw.reasoning_output_tokens),
  };
}
const minus = (a, b) => ({
  input: Math.max(0, a.input - (b ? b.input : 0)), cached: Math.max(0, a.cached - (b ? b.cached : 0)),
  write: Math.max(0, a.write - (b ? b.write : 0)), output: Math.max(0, a.output - (b ? b.output : 0)),
  reasoning: Math.max(0, a.reasoning - (b ? b.reasoning : 0)),
});
const same = (a, b) => !!a && !!b && a.input === b.input && a.cached === b.cached && a.write === b.write && a.output === b.output;
const empty = (u) => !u.input && !u.cached && !u.write && !u.output;
const modelOf = (o) => (o && typeof o === "object" && (o.model || o.model_name || (o.metadata && o.metadata.model))) || null;

function parseJson(text) {
  if (typeof text !== "string") return text && typeof text === "object" ? text : null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The shell command of a tool call, if it was one. Codex has called its shell tool shell,
// shell_command, exec_command and local_shell over time.
function shellCommand(name, args) {
  if (!/shell|exec/i.test(name || "")) return null;
  const a = parseJson(args) || {};
  const c = a.command ?? a.cmd ?? (a.action && a.action.command);
  if (Array.isArray(c)) return c[c.length - 1] && /^(bash|sh|zsh|pwsh|powershell|cmd)(\.exe)?$/i.test(path.basename(String(c[0]))) ? String(c[c.length - 1]) : c.join(" ");
  return typeof c === "string" ? c : null;
}

// What kind of tool use it was. Codex reads files with shell commands and edits them with apply_patch.
function toolKind(name, command) {
  if (/apply_patch|edit|write/i.test(name || "") || /^\s*apply_patch\b/.test(command || "")) return { kind: "edit", file: null };
  if (command !== null) {
    const read = /^\s*(cat|type|head|tail|nl|less|more|get-content|sed\s+-n\s+\S+)\s+(?:-\S+\s+)*["']?([^\s"'|;&]+)/i.exec(command);
    if (read) return { kind: "read", file: path.basename(read[2]) };
    return { kind: commandKind(command), file: null };
  }
  return { kind: /read|view|open/i.test(name || "") ? "read" : "other", file: null };
}

const outputTokens = (output) => Math.round((typeof output === "string" ? output : JSON.stringify(output ?? "")).length / 4);

// The default speed tier in Codex's config.toml (top level only), used when a log doesn't say.
function configTier(home) {
  try {
    const text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break;
      const m = /^\s*service_tier\s*=\s*["']([a-z]+)["']/i.exec(line);
      if (m) return TIERS[m[1].toLowerCase()] ?? 1;
    }
  } catch {}
  return 1;
}

// Conversation names Codex keeps in session_index.jsonl (newer builds), by session id.
function threadNames(home) {
  const names = new Map();
  try {
    for (const line of fs.readFileSync(path.join(home, "session_index.jsonl"), "utf8").split("\n")) {
      const e = parseJson(line);
      if (e && e.id && e.thread_name) names.set(e.id, e.thread_name);
    }
  } catch {}
  return names;
}

// Reads one rollout into what TokenScope needs. Nothing of the content is kept except the first
// line you wrote (as the title, if Codex hasn't named the conversation) and file names that were read.
async function parseRollout(file, options = {}) {
  const r = {
    file, sessionId: null, parentId: null, subagent: false, cwd: null, start: null, end: null, title: null,
    events: [], tools: [], userTimes: [], jobMarks: new Map(),
    stats: { tokenEvents: 0, withUsage: 0, replies: 0 },
  };
  let model = null, tier = null, previous = null, index = 0;
  const pendingTools = new Map(), records = [], markers = new Map();
  for await (const raw of rolloutLines(file, options)) {
    index++;
    const entry = parseJson(raw);
    if (!entry || typeof entry !== "object") continue;
    const t = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(t)) {
      if (r.start === null || t < r.start) r.start = t;
      if (r.end === null || t > r.end) r.end = t;
      if (raw.includes("job_id")) for (const id of raw.match(/job-[a-z0-9]{8,}/g) || []) if (!r.jobMarks.has(id)) r.jobMarks.set(id, t);
    }
    const p = entry.payload && typeof entry.payload === "object" ? entry.payload : {};
    switch (entry.type) {
      case "session_meta": {
        if (r.sessionId) break; // a copied parent's session_meta further down
        r.sessionId = p.id || null;
        r.cwd = p.cwd || null;
        const spawn = p.source && p.source.subagent && p.source.subagent.thread_spawn;
        r.parentId = p.forked_from_id || (spawn && spawn.parent_thread_id) || null;
        r.subagent = !!(p.source && p.source.subagent);
        if (p.timestamp && !Number.isFinite(t)) r.start = Date.parse(p.timestamp);
        if (Number.isFinite(t)) r.forkedAt = t;
        break;
      }
      case "turn_context":
        model = modelOf(p) || model;
        break;
      case "token_usage_record": {
        const u = tokens(p.usage);
        if (u && p.response_id) records.push({ index, t, responseId: p.response_id, u, model: modelOf(p) || model, tier });
        break;
      }
      case "compacted":
        if (p.compaction_response_id) markers.set(p.compaction_response_id, index);
        break;
      case "event_msg":
        if (p.type === "token_count") {
          r.stats.tokenEvents++;
          const info = p.info;
          if (!info) break; // rate-limit updates only
          const last = tokens(info.last_token_usage), total = tokens(info.total_token_usage);
          if (last || total) r.stats.withUsage++;
          const advanced = !total || !same(total, previous);
          const u = last && advanced ? last : total ? minus(total, previous) : null;
          if (total) previous = total;
          if (!u || empty(u) || !Number.isFinite(t)) break;
          r.events.push({ index, t, u, model: modelOf(info) || model, tier });
        } else if (p.type === "thread_settings_applied" && p.thread_settings && "service_tier" in p.thread_settings) {
          tier = TIERS[String(p.thread_settings.service_tier).toLowerCase()] ?? null;
        } else if (p.type === "user_message" && Number.isFinite(t)) {
          r.userTimes.push(t);
          if (!r.title && typeof p.message === "string" && p.message.trim()) r.title = p.message.trim().split(/\r?\n/)[0].slice(0, 80);
        }
        break;
      case "response_item":
        if (p.type === "message" && p.role === "assistant") r.stats.replies++;
        else if (/^(function_call|custom_tool_call|local_shell_call)$/.test(p.type) && Number.isFinite(t)) {
          const command = p.type === "local_shell_call" ? shellCommand("local_shell", p) : shellCommand(p.name, p.arguments ?? p.input);
          const { kind, file: read } = toolKind(p.name || "shell", command);
          pendingTools.set(p.call_id || p.id, { t, tool: p.name || "shell", kind, file: read });
        } else if (/_output$/.test(p.type || "")) {
          const call = pendingTools.get(p.call_id);
          if (!call) break;
          pendingTools.delete(p.call_id);
          r.tools.push({ ...call, ms: Number.isFinite(t) ? t - call.t : 0, outTokens: outputTokens(p.output) });
        }
        break;
    }
  }
  // Compactions: counted when the marker matches, unless a token_count between the two already
  // recorded the same request (local compactions do, remote ones don't).
  for (const rec of records) {
    const mark = markers.get(rec.responseId);
    if (mark === undefined) continue;
    const [a, b] = [Math.min(rec.index, mark), Math.max(rec.index, mark)];
    if (r.events.some((e) => e.index > a && e.index < b && same(e.u, rec.u))) continue;
    if (Number.isFinite(rec.t)) r.events.push({ index: rec.index, t: rec.t, u: rec.u, model: rec.model, tier: rec.tier, responseId: rec.responseId });
  }
  r.events.sort((x, y) => x.index - y.index);
  return r;
}

// Marks the requests a forked or subagent log copied from its parent.
function markReplayed(child, parent) {
  if (!child.parentId) return;
  const own = child.events.filter((e) => !e.responseId);
  let skipped = 0;
  if (parent) {
    const prefix = parent.events.filter((e) => !e.responseId && (child.forkedAt === undefined || e.t <= child.forkedAt));
    while (skipped < own.length && skipped < prefix.length && same(own[skipped].u, prefix[skipped].u)) skipped++;
  }
  if (!skipped && own.length >= 2 && own[1].t - own[0].t <= BURST_MS) {
    skipped = 1;
    while (skipped < own.length && own[skipped].t - own[skipped - 1].t <= BURST_MS) skipped++;
  }
  for (let i = 0; i < skipped; i++) own[i].replayed = true;
  // Copied compactions: the parent already has the same response id.
  if (parent) {
    const ids = new Set(parent.events.filter((e) => e.responseId).map((e) => e.responseId));
    for (const e of child.events) if (e.responseId && ids.has(e.responseId)) e.replayed = true;
  }
  const copyEnd = skipped ? own[skipped - 1].t : child.forkedAt ?? -Infinity;
  child.tools = child.tools.filter((x) => x.t > copyEnd);
  child.userTimes = child.userTimes.filter((x) => x > copyEnd);
}

const cache = new Map(); // file -> { key, rollout }, in memory only

// All rollouts, parsed (cached by size and time), with copied history marked.
async function loadRollouts(homes = codexHomes(), options = {}) {
  const files = await listRollouts(homes);
  const tiers = new Map(); // home -> the speed tier its config.toml sets, for logs that don't say
  const tierOf = (home) => (tiers.has(home) ? tiers.get(home) : tiers.set(home, configTier(home)).get(home));
  const rollouts = [];
  for (const f of files) {
    const key = `${f.mtime}|${f.size}`;
    let hit = cache.get(f.file);
    if (!hit || hit.key !== key) {
      let rollout;
      try {
        rollout = await parseRollout(f.file, options);
      } catch (error) {
        rollout = { file: f.file, failed: error.message, events: [], tools: [], userTimes: [], jobMarks: new Map(), stats: { tokenEvents: 0, withUsage: 0, replies: 0 } };
      }
      hit = { key, rollout };
      cache.set(f.file, hit);
    }
    // Copies of the requests, since which ones are copied history depends on which parents are present.
    const r = hit.rollout;
    rollouts.push({ ...r, mtime: f.mtime, home: f.home, archived: !!f.archived, events: r.events.map((e) => ({ ...e, tier: e.tier ?? tierOf(f.home), replayed: false })) });
  }
  const byId = new Map(rollouts.filter((r) => r.sessionId).map((r) => [r.sessionId, r]));
  for (const r of rollouts) markReplayed(r, r.parentId && r.parentId !== r.sessionId ? byId.get(r.parentId) : null);
  // The same compaction copied into several logs counts once.
  const seen = new Set();
  for (const r of [...rollouts].sort((a, b) => (a.start || 0) - (b.start || 0))) {
    for (const e of r.events) {
      if (!e.responseId || e.replayed) continue;
      if (seen.has(e.responseId)) e.replayed = true;
      else seen.add(e.responseId);
    }
  }
  return { rollouts, byId };
}

const ZERO = () => ({ requests: 0, input: 0, cacheRead: 0, write5m: 0, write1h: 0, output: 0 });

// TokenScope's usage shape. The part of input that wasn't cached is billed at the input price
// (OpenAI has no extra charge for writing to the cache).
const asUsage = (u) => ({ requests: 1, input: u.input - u.cached - u.write, cacheRead: u.cached, write5m: u.write, write1h: 0, output: u.output });

// Adds a request to byModel, keyed by model and speed tier (they're priced differently).
function addRequest(byModel, e, defaultTier) {
  const model = e.model || FALLBACK_MODEL;
  const factor = e.tier ?? defaultTier;
  const name = TIER_LABEL[factor] ? `${model} (${TIER_LABEL[factor]})` : model;
  const sum = byModel.get(name) || { ...ZERO(), model, factor, tier: TIER_LABEL[factor] || null };
  const u = asUsage(e.u);
  for (const k of Object.keys(u)) sum[k] += u[k];
  byModel.set(name, sum);
}

const counted = (r, from = -Infinity, to = Infinity) => r.events.filter((e) => !e.replayed && e.t >= from && e.t < to);

function requestCost(models, e, defaultTier) {
  const priced = findPricedModel(models, e.model || FALLBACK_MODEL);
  return { priced, cost: priced ? usageCost(priced, asUsage(e.u)) * (e.tier ?? defaultTier) : 0 };
}

// The conversation as a timeline for insights.js: requests, pauses and tool runs.
function timeline(r, models, defaultTier) {
  const events = counted(r);
  const requests = [];
  for (const e of events) {
    const { priced, cost } = requestCost(models, e, defaultTier);
    const prev = requests[requests.length - 1];
    let pause = null;
    if (prev) {
      const you = r.userTimes.filter((x) => x > prev.t && x <= e.t).pop();
      const longest = r.tools.filter((x) => x.t > prev.t && x.t <= e.t).sort((a, b) => b.ms - a.ms)[0];
      if (you) pause = { ms: you - prev.t, who: "you", kind: null };
      else if (longest) pause = { ms: longest.ms, who: "tool", kind: longest.kind };
      else pause = { ms: e.t - prev.t, who: "unknown", kind: null };
    }
    requests.push({ t: e.t, model: priced, name: e.model, pause, context: e.u.input, fresh: e.u.input - e.u.cached, cached: e.u.cached, output: e.u.output, cost });
  }
  const after = (t) => Math.max(0, requests.filter((q) => q.t <= t).length - 1);
  const tools = r.tools.map((x) => ({ t: x.t, after: after(x.t), kind: x.kind, tool: x.tool, file: x.file, ms: x.ms, outTokens: x.outTokens }));
  return { requests, tools };
}

// Format check: recent token events should carry token counts, and logs with replies should have
// token events at all.
function checkFormat(rollouts, checks) {
  let events = 0, withUsage = 0, replyLogs = 0, silentLogs = 0;
  for (const r of rollouts) {
    events += r.stats.tokenEvents;
    withUsage += r.stats.withUsage;
    if (r.stats.replies >= 3) {
      replyLogs++;
      if (!r.stats.tokenEvents) silentLogs++;
    }
  }
  if (events >= 10 && withUsage / events < 0.2) checks.mismatch("codex", "Its logs no longer have token counts where expected, so Codex costs are missing or too low.");
  else if (replyLogs >= 3 && silentLogs / replyLogs > 0.5) checks.mismatch("codex", "Its logs no longer record token use, so Codex costs are missing.");
  if (rollouts.length >= 3 && rollouts.filter((r) => r.failed).length / rollouts.length > 0.5) checks.mismatch("codex", "Most of its logs couldn't be read, so Codex conversations are missing.");
}

// When something happened in a conversation and its subagents (see activity.js): its own requests,
// your messages and each tool from its call to its output. A fork's copied history is left out.
function codexActivity(logs) {
  return activitySpans({
    points: logs.flatMap((r) => [...counted(r).map((e) => e.t), ...r.userTimes]),
    intervals: logs.flatMap((r) => r.tools.filter((x) => x.ms > 0).map((x) => [x.t, x.t + x.ms])),
  });
}

// History: one entry per conversation. A subagent's log is added to the conversation that started it.
async function readCodex(models, since, { home = codexHomes(), checks = { mismatch() {} }, summarize, analyze, zstd, forkRow } = {}) {
  const { rollouts, byId } = await loadRollouts(home, zstd);
  const recent = rollouts.filter((r) => r.mtime >= since);
  checkFormat(recent, checks);
  const defaultTier = 1; // each request already has its tier, from its log or its config.toml
  const names = new Map([].concat(home).flatMap((h) => [...threadNames(h)]));
  const helpersOf = new Map();
  for (const r of rollouts) {
    if (r.subagent && r.parentId && byId.has(r.parentId)) {
      if (!helpersOf.has(r.parentId)) helpersOf.set(r.parentId, []);
      helpersOf.get(r.parentId).push(r);
    }
  }
  const out = [];
  for (const r of recent) {
    if (r.subagent && r.parentId && byId.has(r.parentId)) continue; // counted with its parent
    const helpers = helpersOf.get(r.sessionId) || [];
    const byModel = new Map();
    // Whole conversations, so a saved summary is never a part of one (see archive.js).
    for (const e of counted(r)) addRequest(byModel, e, defaultTier);
    let helperCost = 0;
    for (const h of helpers) {
      for (const e of counted(h)) {
        addRequest(byModel, e, defaultTier);
        helperCost += requestCost(models, e, defaultTier).cost;
      }
    }
    const priced = summarize(byModel, models);
    // A fork with nothing of its own yet (all its requests are copies): listed at $0, like Codex lists it.
    if (!priced.models.length && r.parentId && !r.subagent && r.start !== null && r.start >= since && r.events.some((e) => e.replayed)) {
      const parent = byId.get(r.parentId);
      out.push(forkRow({
        id: `codex:${r.sessionId || path.basename(r.file).replace(/\.jsonl(\.zst)?$/, "")}`, tool: "codex",
        title: names.get(r.sessionId) || r.title, of: parent ? names.get(parent.sessionId) || parent.title || "Untitled conversation" : null,
        cwd: r.cwd, made: r.start, archived: r.archived,
      }));
      continue;
    }
    if (!priced.models.length || r.start === null) continue;
    const end = Math.max(r.end || r.start, ...helpers.map((h) => h.end || 0));
    if (end < since) continue;
    out.push({
      id: `codex:${r.sessionId || path.basename(r.file).replace(/\.jsonl(\.zst)?$/, "")}`,
      tool: "codex", title: names.get(r.sessionId) || r.title || "Untitled conversation",
      project: r.cwd ? path.basename(r.cwd) : null, start: r.start, end, approximate: false, ...(r.archived ? { archived: true } : {}),
      jobIds: [...r.jobMarks.keys()], ...priced,
      // A fork: only its own requests count here; what it copied counts in the original.
      ...(r.parentId && !r.subagent ? { fork: { of: byId.get(r.parentId) ? names.get(r.parentId) || byId.get(r.parentId).title || "Untitled conversation" : null } } : {}),
      activity: codexActivity([r, ...helpers]),
      insights: analyze({ ...timeline(r, models, defaultTier), cacheMinutes: 5, helperCost, total: priced.cost }),
    });
  }
  return out;
}

// Real costs of jobs that ran in Codex: requests after the job id first shows up in a conversation
// (estimate_plan or continue_job), until finish_job or another job shows up there. Subagents included.
async function findCodexActuals(jobs, models, { home = codexHomes(), now = Date.now(), zstd } = {}) {
  const open = jobs.filter((j) =>
    Date.parse(j.createdAt) > now - LOOK_BACK &&
    (!j.actual || j.actual.source === "ai" || j.actual.source === "cursor-hook" || (j.actual.source === "codex" &&
      (j.actual.status === "running" || (!j.endedAt && now - Date.parse(j.actual.lastActivity) < 2 * 86400e3)))));
  if (!open.length) return {};
  const { rollouts } = await loadRollouts(home, zstd);
  const defaultTier = 1; // each request already has its tier
  const changes = {};
  for (const job of open) {
    const homes = rollouts.filter((r) => r.jobMarks.has(job.id) && !(r.subagent && r.parentId && rollouts.some((p) => p.sessionId === r.parentId && p.jobMarks.has(job.id))));
    if (!homes.length) continue;
    const byModel = new Map();
    let last = 0, first = Infinity, sessionId = null, running = false;
    for (const r of homes) {
      const start = r.jobMarks.get(job.id);
      let end = job.endedAt && Date.parse(job.endedAt) > start ? Date.parse(job.endedAt) : Infinity;
      for (const [id, t] of r.jobMarks) if (id !== job.id && t > start) end = Math.min(end, t);
      const helpers = rollouts.filter((h) => h.subagent && h.parentId === r.sessionId);
      for (const part of [r, ...helpers]) {
        for (const e of counted(part, start, end)) {
          addRequest(byModel, e, defaultTier);
          last = Math.max(last, e.t);
        }
      }
      const written = Math.max(r.mtime, ...helpers.map((h) => h.mtime));
      if (end === Infinity && !job.endedAt && now - written < RUNNING_WINDOW) running = true;
      if (start < first) {
        first = start;
        sessionId = r.sessionId;
      }
    }
    let cost = 0, input = 0, cached = 0, written = 0, output = 0, mainModel = null, mainOutput = -1;
    const unpriced = [], perModel = [];
    for (const [name, u] of byModel) {
      const priced = findPricedModel(models, u.model);
      if (priced) cost += usageCost(priced, u) * u.factor;
      else unpriced.push(name);
      perModel.push({ model: priced ? priced.id : u.model, cost: priced ? Number((usageCost(priced, u) * u.factor).toFixed(4)) : null });
      input += u.input + u.cacheRead + u.write5m;
      cached += u.cacheRead;
      written += u.write5m;
      output += u.output;
      if (u.output > mainOutput) {
        mainOutput = u.output;
        mainModel = priced ? priced.id : u.model;
      }
    }
    if (!mainModel) continue; // nothing ran yet
    const actual = {
      modelId: mainModel, costUsd: Number(cost.toFixed(4)), inputTokens: input, cachedTokens: cached, cacheWriteTokens: written,
      outputTokens: output, source: "codex", status: running ? "running" : "done", sessionId, sessions: homes.length,
      lastActivity: new Date(last || first).toISOString(), models: byCost(perModel),
      ...(unpriced.length ? { unpricedModels: unpriced } : {}),
    };
    const mainPriced = models.find((m) => m.id === mainModel);
    const addEstimate = job.plan && mainPriced && !(job.estimates || {})[mainModel] ? estimateJob(mainPriced, job.plan) : null;
    const before = job.actual ? JSON.stringify({ ...job.actual, recordedAt: undefined }) : null;
    if (before !== JSON.stringify({ ...actual, recordedAt: undefined }) || addEstimate) {
      changes[job.id] = { actual: { ...actual, recordedAt: new Date(now).toISOString() }, addEstimate };
    }
  }
  return changes;
}

// Saves Codex jobs' real costs. A cost measured from Claude Code's logs wins (a job runs in one tool).
async function syncCodexActuals(store, models, options) {
  const changes = await findCodexActuals(store.read().jobs, models, options);
  const ids = Object.keys(changes);
  if (!ids.length) return 0;
  let changed = 0;
  store.update((data) => {
    for (const job of data.jobs) {
      const change = changes[job.id];
      if (!change || (job.actual && job.actual.source === "claude-code")) continue;
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

module.exports = { codexHome, codexHomes, codexFound, listRollouts, parseRollout, loadRollouts, readCodex, findCodexActuals, syncCodexActuals };
