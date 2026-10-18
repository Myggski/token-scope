// Saving job estimates and actual costs. Used by the app window and the MCP mode alike.
const { estimateJob, tokenCost, correction, validPlan } = require("./estimate");
const { newJobId } = require("./store");

const round = (value, digits = 4) => Number(value.toFixed(digits));

// One model's raw estimate as stored with a job, with per-phase likely costs when the plan has phases.
function storedEstimate(model, plan) {
  const e = estimateJob(model, plan);
  return { low: round(e.low), likely: round(e.likely), high: round(e.high), ...(e.phases ? { phases: e.phases.map((p) => round(p.likely)) } : {}) };
}

function cleanPhase(p) {
  return {
    ...(p.name ? { name: String(p.name).slice(0, 200) } : {}),
    steps: p.steps, startContext: p.startContext, contextPerStep: p.contextPerStep, outputPerStep: p.outputPerStep, rework: p.rework ?? 0.2,
    ...(p.cacheHit !== undefined && p.cacheHit !== null ? { cacheHit: p.cacheHit } : {}),
  };
}

// Saves raw estimates (before correction) so later corrections are computed from what was estimated.
// The first model is the one planned for the job.
function saveEstimate(store, { title, plan, models, source, client, note }) {
  if (!validPlan(plan)) throw new Error("The plan needs steps (1 or more) and token sizes of 0 or more, for every phase.");
  const estimates = {};
  for (const m of models) estimates[m.id] = storedEstimate(m, plan);
  const job = {
    id: newJobId(),
    title: String(title || "Untitled job").slice(0, 200),
    createdAt: new Date().toISOString(),
    source,
    ...(client ? { client: String(client).slice(0, 100) } : {}),
    plan: Array.isArray(plan.phases) ? { phases: plan.phases.map(cleanPhase) } : cleanPhase(plan),
    estimates,
    ...(note ? { note: String(note).slice(0, 2000) } : {}),
  };
  store.update((data) => data.jobs.push(job));
  return job;
}

// Records what a job really cost: either a dollar amount, or token counts priced at today's rates.
function recordActual(store, { jobId, title, model, costUsd, inputTokens, cachedTokens, outputTokens, source, note }) {
  let cost = costUsd;
  const tokens = inputTokens !== undefined || outputTokens !== undefined;
  if (cost === undefined || cost === null) {
    if (!tokens) throw new Error("Give either the cost in USD or the token counts.");
    if (!model.inPerM && model.inPerM !== 0) throw new Error("No price known for that model, so give the cost in USD instead.");
    cost = tokenCost(model, { input: inputTokens || 0, cached: cachedTokens || 0, output: outputTokens || 0 });
  }
  if (!(cost >= 0)) throw new Error("The cost must be 0 or more.");
  const actual = {
    modelId: model.id,
    costUsd: round(cost),
    ...(tokens ? { inputTokens: inputTokens || 0, cachedTokens: cachedTokens || 0, outputTokens: outputTokens || 0 } : {}),
    recordedAt: new Date().toISOString(),
    source,
  };
  return store.update((data) => {
    let job = jobId ? data.jobs.find((j) => j.id === jobId) : null;
    if (jobId && !job) throw new Error(`No job with id ${jobId}. Use list_jobs to see saved jobs.`);
    if (!job) {
      job = { id: newJobId(), title: String(title || "Untitled job").slice(0, 200), createdAt: actual.recordedAt, source, estimates: {} };
      data.jobs.push(job);
    }
    job.actual = actual;
    if (note) job.note = String(note).slice(0, 2000);
    return job;
  });
}

// Marks a job as done, so its cost stops at this point in the Claude Code session.
function finishJob(store, jobId) {
  return store.update((data) => {
    const job = data.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`No job with id ${jobId}. Use list_jobs to see saved jobs.`);
    job.endedAt = new Date().toISOString();
    return job;
  });
}

// Removes a job from the list (for example a duplicate, or one saved by mistake).
function deleteJob(store, jobId) {
  return store.update((data) => {
    const job = data.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`No job with id ${jobId}. Use list_jobs to see saved jobs.`);
    data.jobs = data.jobs.filter((j) => j.id !== jobId);
    return job;
  });
}

// Recent jobs that look like the same plan: the same or overlapping title, saved in the last day.
function similarJobs(jobs, title, now = Date.now()) {
  const key = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const words = (t) => new Set(key(t).split(" ").filter((w) => w.length > 2));
  const mine = key(title), myWords = words(title);
  return jobs.filter((j) => {
    if (now - Date.parse(j.createdAt) > 86400e3) return false;
    const theirs = key(j.title);
    if (!theirs || !mine) return false;
    if (theirs === mine || theirs.includes(mine) || mine.includes(theirs)) return true;
    const shared = [...words(j.title)].filter((w) => myWords.has(w)).length;
    return shared >= 2 && shared >= Math.min(myWords.size, words(j.title).size) * 0.6;
  });
}

// Picks up a job again, for example in a new session: its cost keeps counting from here.
function continueJob(store, jobId) {
  return store.update((data) => {
    const job = data.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`No job with id ${jobId}. Use list_jobs to see saved jobs.`);
    delete job.endedAt;
    return job;
  });
}

// Changes which models a job is compared on. models are in order: the first is the planned one.
// Estimates already there are kept as they were; new ones are priced at today's rates.
function setJobModels(store, jobId, models) {
  return store.update((data) => {
    const job = data.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`No job with id ${jobId}.`);
    if (!job.plan) throw new Error("This job has no plan, so it can't be priced on other models.");
    const before = job.estimates || {};
    job.estimates = {};
    for (const m of models) job.estimates[m.id] = before[m.id] || storedEstimate(m, job.plan);
    return job;
  });
}

// The model a job is planned to run on: the one it ran on, else the first one compared.
const plannedModel = (job) => (job.actual && job.actual.modelId) || Object.keys(job.estimates || {})[0] || null;

// One line per job for history views: what was estimated for the model used, and what it cost.
function describeJob(job) {
  const used = job.actual && job.actual.modelId;
  const estimate = used && job.estimates ? job.estimates[used] : null;
  return {
    id: job.id,
    title: job.title,
    created: job.createdAt,
    source: job.source,
    client: job.client || null,
    plan: job.plan || null,
    modelsEstimated: Object.keys(job.estimates || {}),
    plannedModel: plannedModel(job),
    estimateForModelUsed: estimate,
    ended: job.endedAt || null,
    actual: job.actual || null,
    actualVsLikely: estimate && job.actual && estimate.likely > 0 ? round(job.actual.costUsd / estimate.likely, 2) : null,
    note: job.note || null,
  };
}

module.exports = { saveEstimate, recordActual, finishJob, continueJob, deleteJob, similarJobs, setJobModels, plannedModel, storedEstimate, describeJob, correction };
