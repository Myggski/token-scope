// Checks reading real costs from Claude Code session logs, with made-up log files.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { findActuals, modelKey } = require("./claudelogs");

assert.strictEqual(modelKey("anthropic/claude-opus-5.5"), modelKey("claude-opus-5-5"));
assert.strictEqual(modelKey("anthropic/claude-3.5-sonnet"), modelKey("claude-3-5-sonnet-20241022"));

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ts-logs-"));
const project = path.join(folder, "-work-app");
fs.mkdirSync(path.join(project, "sess1", "subagents"), { recursive: true });

const t = (min) => new Date(Date.UTC(2026, 9, 1, 10, min)).toISOString();
const reply = (min, id, usage, model = "claude-haiku-5-5") =>
  JSON.stringify({ type: "assistant", timestamp: t(min), sessionId: "sess1", requestId: "r" + id, message: { id, model, usage } });
const toolResult = (min, text) => JSON.stringify({ type: "user", timestamp: t(min), sessionId: "sess1", message: { content: [{ type: "tool_result", content: text }] } });
const U = (input, read, write, output) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output });

fs.writeFileSync(path.join(project, "sess1.jsonl"), [
  reply(0, "m0", U(1e6, 0, 0, 0)), // before the job: not counted
  toolResult(1, '{"job_id": "job-a"}'),
  reply(2, "m1", U(1e6, 0, 0, 1e6)),
  reply(2, "m1", U(1e6, 0, 0, 1e6)), // same reply on a second line: counted once
  reply(3, "m2", U(0, 1e6, 1e6, 0)),
  toolResult(5, '{"job_id": "job-b"}'),
  reply(6, "m3", U(1e6, 0, 0, 0)), // belongs to job-b
  reply(7, "m4", U(1e6, 0, 0, 0), "some-unknown-model"),
].join("\n") + "\n");
fs.writeFileSync(path.join(project, "sess1", "subagents", "agent-1.jsonl"), reply(4, "s1", U(1e6, 0, 0, 0)) + "\n");

// $1 in, $0.10 cached, $5 out, cache write at the default 1.25x
const models = [{ id: "anthropic/claude-haiku-5.5", inPerM: 1, outPerM: 5, cachedPerM: 0.1, cacheWritePerM: null }];
const jobs = [
  { id: "job-a", createdAt: t(1), plan: { steps: 10, startContext: 1e4, contextPerStep: 1e3, outputPerStep: 500, rework: 0.2 }, estimates: {} },
  { id: "job-b", createdAt: t(5), estimates: {} },
  { id: "job-c", createdAt: t(8), estimates: {} }, // never ran in Claude Code
];

(async () => {
  const changes = await findActuals(jobs, models, { folder, now: Date.parse(t(60)) });
  const a = changes["job-a"].actual;
  // m1: 1M in ($1) + 1M out ($5); m2: 1M cached ($0.10) + 1M cache write ($1.25); subagent: 1M in ($1)
  assert.strictEqual(a.costUsd, 8.35, "job-a cost");
  assert.strictEqual(a.modelId, "anthropic/claude-haiku-5.5");
  assert.strictEqual(a.status, "done");
  assert.strictEqual(a.outputTokens, 1e6);
  assert.ok(changes["job-a"].addEstimate, "estimate added for the model that ran");
  const b = changes["job-b"].actual;
  assert.strictEqual(b.costUsd, 1, "job-b only counts its own replies");
  assert.deepStrictEqual(b.unpricedModels, ["some-unknown-model"]);
  assert.ok(!changes["job-c"], "a job not in any log is left alone");

  // Still running while the log was written in the last 15 minutes.
  fs.utimesSync(path.join(project, "sess1.jsonl"), new Date(), new Date());
  const running = await findActuals([jobs[1]], models, { folder, now: Date.now() + 60e3 });
  assert.strictEqual(running["job-b"].actual.status, "running");

  // finish_job stops the count.
  const ended = await findActuals([{ ...jobs[0], endedAt: new Date(Date.parse(t(2)) + 30e3).toISOString() }, jobs[1]], models, { folder, now: Date.parse(t(60)) });
  assert.strictEqual(ended["job-a"].actual.costUsd, 6, "only m1 before the finish");
  const wasRunning = { ...jobs[1], endedAt: new Date(Date.now() - 1000).toISOString(), actual: { source: "claude-code", status: "running", lastActivity: t(6) } };
  const final = await findActuals([wasRunning], models, { folder, now: Date.now() + 60e3 });
  assert.strictEqual(final["job-b"].actual.status, "done", "finishing a running job closes it");
  // A job picked up again in a second session counts there too, up to where another job starts.
  fs.writeFileSync(path.join(project, "sess2.jsonl"), [
    toolResult(20, '{"job_id": "job-a"}'), // continue_job
    reply(21, "n1", U(2e6, 0, 0, 0)),
    toolResult(22, '{"job_id": "job-c"}'),
    reply(23, "n2", U(5e6, 0, 0, 0)), // belongs to job-c
  ].join("\n") + "\n");
  const two = await findActuals(jobs, models, { folder, now: Date.parse(t(60)) + 3600e3 });
  assert.strictEqual(two["job-a"].actual.costUsd, 10.35, "8.35 from the first session + 2 from the second");
  assert.strictEqual(two["job-a"].actual.sessions, 2);
  assert.strictEqual(two["job-c"].actual.costUsd, 5, "job-c only its own part of session 2");
  fs.rmSync(folder, { recursive: true });
  console.log("claude log tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
