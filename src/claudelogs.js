// Fills in what jobs really cost, from Claude Code's local session logs
// (~/.claude/projects/<project>/<session>.jsonl, subagents in <session>/subagents/).
// When the AI estimates a job, the tool result with the job id is written to that session's log.
// The job's cost is every model reply after that point, until the job is finished
// (finish_job) or another job starts in the same session. A job picked up again in another
// session (continue_job writes its id there too) counts in every session it appears in.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { estimateJob } = require("./estimate");
const { wslHomes } = require("./wsl");

const RUNNING_WINDOW = 15 * 60e3; // a session written to in the last 15 minutes counts as still running
const LOOK_BACK = 60 * 24 * 3600e3; // jobs older than 60 days are left alone

function logsFolder() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
}

// Claude Code's log folders: this computer's, plus Claude Code run inside WSL (see wsl.js).
function logsFolders() {
  return [logsFolder(), ...wslHomes().map((home) => path.join(home, ".claude", "projects"))];
}

// Logs from several folders at once.
async function listAllLogs(folders, since) {
  const found = [];
  for (const folder of folders) await listLogs(folder, since, 0, found);
  return found;
}

async function listLogs(folder, since, depth = 0, found = []) {
  let entries;
  try {
    entries = await fs.promises.readdir(folder, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory() && depth < 4) await listLogs(full, since, depth + 1, found);
    else if (entry.name.endsWith(".jsonl")) {
      try {
        const stat = await fs.promises.stat(full);
        if (stat.mtimeMs >= since) found.push({ file: full, mtime: stat.mtimeMs, born: stat.birthtimeMs || stat.mtimeMs });
      } catch {}
    }
  }
  return found;
}

// "anthropic/claude-opus-5.5" and "claude-opus-5-5" (or "claude-opus-5-5-20261001") match.
const modelKey = (name) => String(name).toLowerCase().replace(/^.*\//, "").replace(/[.:_]/g, "-").replace(/-\d{8}$/, "").replace(/-latest$/, "");

// Tools add settings to model names that aren't part of the model: Cursor writes
// "gemini-3.7-flash-low" or "claude-sonnet-5-5-thinking-high" for an effort level or thinking.
// Without an exact match, those endings are taken off one at a time.
const SETTING = /-(minimal|low|medium|high|xhigh|max|thinking|fast|nothink|reasoning)$/;

function findPricedModel(models, logModel) {
  let key = modelKey(logModel);
  for (;;) {
    const hit = models.find((m) => modelKey(m.id) === key);
    if (hit || !SETTING.test(key)) return hit || null;
    key = key.replace(SETTING, "");
  }
}

// A free variant's paid twin, for its name only: "deepseek-v4.1-flash-free" (OpenCode Zen) or
// "deepseek/deepseek-v4.1-flash:free" (OpenRouter) -> DeepSeek V4.1 Flash. Never for its price: a
// free model is priced by what the tool recorded. The ending alone doesn't make a model free, so
// callers use this only when the tool recorded $0 (see summarize in history.js).
function freeTwin(models, logModel) {
  const key = modelKey(logModel);
  return /-free$/.test(key) ? findPricedModel(models, key.replace(/-free$/, "")) : null;
}

// Price of one model's usage. Cache writes cost extra: 1.25x input for 5-minute caching (or the
// provider's listed cache-write price), 2x for 1-hour caching.
function usageCost(model, u) {
  const cachedPrice = model.cachedPerM ?? model.inPerM;
  const write5m = model.cacheWritePerM ?? model.inPerM * 1.25;
  return (u.input * model.inPerM + u.cacheRead * cachedPrice + u.write5m * write5m + u.write1h * model.inPerM * 2 + u.output * model.outPerM) / 1e6;
}

function parseLines(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    try {
      lines.push({ raw, entry: JSON.parse(raw) });
    } catch {}
  }
  return lines;
}

// Adds up model replies in [start, end), each reply once (one reply spans several log lines).
// skip: reply ids not to count here (copies of replies another session counts).
function sumUsage(lineSets, start, end, skip = null) {
  const seen = new Set(skip || []);
  const byModel = new Map();
  let last = 0;
  for (const lines of lineSets) {
    for (const { entry } of lines) {
      if (entry.type !== "assistant" || !entry.message || !entry.message.usage) continue;
      if (entry.message.model === "<synthetic>") continue; // made by Claude Code itself (errors, interruptions), not a model
      const time = Date.parse(entry.timestamp);
      if (!(time >= start && time < end)) continue;
      const id = entry.message.id || entry.requestId || entry.uuid;
      if (seen.has(id)) continue;
      seen.add(id);
      const u = entry.message.usage;
      const writes = u.cache_creation || {};
      const writeTotal = u.cache_creation_input_tokens || 0;
      const write1h = writes.ephemeral_1h_input_tokens || 0;
      const sum = byModel.get(entry.message.model) || { requests: 0, input: 0, cacheRead: 0, write5m: 0, write1h: 0, output: 0 };
      sum.requests += 1;
      sum.input += u.input_tokens || 0;
      sum.cacheRead += u.cache_read_input_tokens || 0;
      sum.write1h += write1h;
      sum.write5m += Math.max(0, writeTotal - write1h);
      sum.output += u.output_tokens || 0;
      byModel.set(entry.message.model, sum);
      last = Math.max(last, time);
    }
  }
  return { byModel, last };
}

// Works out the actual cost of every job that ran in Claude Code and isn't finished yet.
// Returns { [jobId]: { actual, addEstimate } } for the jobs that changed.
// Real cost by model, most expensive first, with models that show up more than once added together.
function byCost(list) {
  const sums = new Map();
  for (const m of list) {
    const s = sums.get(m.model);
    sums.set(m.model, { model: m.model, cost: s && s.cost === null ? null : m.cost === null ? null : Number(((s ? s.cost : 0) + m.cost).toFixed(4)) });
  }
  return [...sums.values()].sort((a, b) => (b.cost || 0) - (a.cost || 0));
}

async function findActuals(jobs, models, { folder, now = Date.now() } = {}) {
  // A job that went quiet may be picked up again, so keep checking for 2 days unless it was finished.
  const open = jobs.filter((j) =>
    Date.parse(j.createdAt) > now - LOOK_BACK &&
    // A cost the AI reported itself is replaced by the exact one from the log, if there is one.
    (!j.actual || j.actual.source !== "claude-code" || j.actual.status === "running" ||
      (!j.endedAt && now - Date.parse(j.actual.lastActivity) < 2 * 86400e3)));
  if (!open.length) return {};
  const since = Math.min(...open.map((j) => Date.parse(j.createdAt))) - 60e3;
  const logs = await listAllLogs(folder ? [folder] : logsFolders(), since);
  const texts = new Map();
  const read = async (file) => {
    if (!texts.has(file)) texts.set(file, await fs.promises.readFile(file, "utf8").catch(() => ""));
    return texts.get(file);
  };

  const changes = {};
  const otherIds = (job) => jobs.filter((j) => j.id !== job.id).map((j) => j.id);
  for (const job of open) {
    // Every session log with this job's id in it (subagents are added per session below).
    const homes = [];
    for (const log of logs) {
      if (log.mtime < Date.parse(job.createdAt) - 60e3 || log.file.includes(`${path.sep}subagents${path.sep}`)) continue;
      if ((await read(log.file)).includes(job.id)) homes.push(log);
    }
    if (!homes.length) continue;

    const lineSets = [];
    const windows = [];
    let first = null, sessionId = null, lastWrite = 0, stillOpen = false;
    for (const home of homes) {
      const lines = parseLines(await read(home.file));
      const startLine = lines.find((l) => l.raw.includes(job.id) && l.entry.timestamp);
      if (!startLine) continue;
      const start = Date.parse(startLine.entry.timestamp);
      // Ends at finish_job, or where another job shows up later in this session.
      let end = Infinity;
      const ended = job.endedAt ? Date.parse(job.endedAt) : null;
      if (ended && ended > start) end = ended;
      for (const id of otherIds(job)) {
        const line = lines.find((l) => l.raw.includes(id) && l.entry.timestamp && Date.parse(l.entry.timestamp) > start);
        if (line) end = Math.min(end, Date.parse(line.entry.timestamp));
      }
      const sessionFolder = home.file.replace(/\.jsonl$/, "") + path.sep;
      const subagents = logs.filter((l) => l.file.startsWith(sessionFolder));
      const sessionLines = [lines];
      for (const log of subagents) sessionLines.push(parseLines(await read(log.file)));
      lineSets.push(sessionLines);
      windows.push([start, end]);
      const written = Math.max(home.mtime, ...subagents.map((l) => l.mtime));
      lastWrite = Math.max(lastWrite, written);
      if (end === Infinity && !job.endedAt && now - written < RUNNING_WINDOW) stillOpen = true;
      if (first === null || start < first) {
        first = start;
        sessionId = startLine.entry.sessionId || path.basename(home.file, ".jsonl");
      }
    }
    if (!lineSets.length) continue;
    const byModel = new Map();
    let last = 0;
    lineSets.forEach((sessionLines, i) => {
      const part = sumUsage(sessionLines, windows[i][0], windows[i][1]);
      last = Math.max(last, part.last);
      for (const [model, u] of part.byModel) {
        const sum = byModel.get(model) || { requests: 0, input: 0, cacheRead: 0, write5m: 0, write1h: 0, output: 0 };
        for (const key of Object.keys(sum)) sum[key] += u[key];
        byModel.set(model, sum);
      }
    });
    const start = first;

    let cost = 0, input = 0, cacheRead = 0, cacheWrite = 0, output = 0, mainModel = null, mainOutput = -1;
    const unpriced = [], perModel = [];
    for (const [logModel, u] of byModel) {
      if (!u.input && !u.cacheRead && !u.output && !u.write5m && !u.write1h) continue;
      const priced = findPricedModel(models, logModel);
      if (priced) cost += usageCost(priced, u);
      else unpriced.push(logModel);
      perModel.push({ model: priced ? priced.id : logModel, cost: priced ? Number(usageCost(priced, u).toFixed(4)) : null });
      input += u.input + u.cacheRead + u.write5m + u.write1h;
      cacheRead += u.cacheRead;
      cacheWrite += u.write5m + u.write1h;
      output += u.output;
      if (u.output > mainOutput) {
        mainOutput = u.output;
        mainModel = priced ? priced.id : logModel;
      }
    }
    if (!mainModel) continue; // nothing ran yet

    const running = stillOpen;
    const actual = {
      modelId: mainModel,
      costUsd: Number(cost.toFixed(4)),
      inputTokens: input,
      cachedTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      outputTokens: output,
      source: "claude-code",
      status: running ? "running" : "done",
      sessionId,
      sessions: lineSets.length,
      lastActivity: new Date(last || start).toISOString(),
      models: byCost(perModel),
      ...(unpriced.length ? { unpricedModels: unpriced } : {}),
    };
    // So the job can count towards the correction factor even if this model wasn't compared.
    const mainPriced = models.find((m) => m.id === mainModel);
    const addEstimate = job.plan && mainPriced && !(job.estimates || {})[mainModel] ? estimateJob(mainPriced, job.plan) : null;
    const before = job.actual ? JSON.stringify({ ...job.actual, recordedAt: undefined }) : null;
    if (before !== JSON.stringify({ ...actual, recordedAt: undefined }) || addEstimate) {
      changes[job.id] = { actual: { ...actual, recordedAt: new Date(now).toISOString() }, addEstimate };
    }
  }
  return changes;
}

// Finds actual costs and saves them. Returns how many jobs changed.
async function syncActuals(store, models, options) {
  const { jobs } = store.read();
  const changes = await findActuals(jobs, models, options);
  const ids = Object.keys(changes);
  if (!ids.length) return 0;
  store.update((data) => {
    for (const job of data.jobs) {
      const change = changes[job.id];
      if (!change) continue;
      job.actual = change.actual;
      if (change.addEstimate) {
        const e = change.addEstimate;
        job.estimates = { ...(job.estimates || {}), [change.actual.modelId]: { low: Number(e.low.toFixed(4)), likely: Number(e.likely.toFixed(4)), high: Number(e.high.toFixed(4)), ...(e.phases ? { phases: e.phases.map((p) => Number(p.likely.toFixed(4))) } : {}), addedLater: true } };
      }
    }
  });
  return ids.length;
}

module.exports = { byCost, syncActuals, findActuals, modelKey, logsFolder, logsFolders, listLogs, listAllLogs, parseLines, sumUsage, findPricedModel, freeTwin, usageCost };
