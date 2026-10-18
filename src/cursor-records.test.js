// Checks reading the Cursor hook's records in the shapes Cursor 3.17 really sends (seen in a user's
// records, Oct 2026): every thinking step twice under two turn ids, a helper agent under a
// conversation id of its own, and compaction on a model with an effort level in its name.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readCursor, readCursorRecords, cursorJobActuals } = require("./history");

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ts-cursor-records-"));
const models = [
  { id: "anthropic/claude-sonnet-5.5", inPerM: 3, outPerM: 15, cachedPerM: 0.3, cacheWritePerM: 3.75 },
  { id: "google/gemini-3.7-flash", inPerM: 0.5, outPerM: 3, cachedPerM: 0.05, cacheWritePerM: null },
];
const T = Date.UTC(2026, 9, 18, 19, 0);
const main = "8bd1f1e1", helper = "fb197136", turn = "3e2c263d";
const rec = (s, e, extra = {}) => ({ t: T + s * 1000, e, c: main, gen: turn, model: "claude-sonnet-5-5", ...extra });
const records = [
  rec(0, "afterAgentThought", { gen: `${turn}-0-czmt`, out: 237 }),
  rec(0.1, "afterAgentThought", { out: 237 }), // the same thought again
  rec(1, "afterMCPExecution", { job: "job-aaaaaaaa11", action: "estimate" }),
  rec(2, "postToolUse", { tool: "Grep", in: 146, out: 29 }),
  rec(3, "afterAgentThought", { out: 258 }),
  rec(3.05, "afterAgentThought", { gen: `${turn}-1-108y`, out: 258 }),
  rec(4, "postToolUse", { tool: "Read", in: 95, out: 4000 }),
  rec(10, "subagentStart", { gen: main, sub: "toolu_1", subModel: "claude-sonnet-5-5" }),
  { t: T + 12000, e: "postToolUse", c: helper, gen: "eaab2d5a", model: "claude-sonnet-5-5", tool: "WebFetch", in: 37, out: 24901 },
  { t: T + 20000, e: "postToolUse", c: helper, gen: "eaab2d5a", model: "claude-sonnet-5-5", tool: "WebSearch", in: 110, out: 9990 },
  rec(30, "postToolUse", { tool: "Task", in: 433, out: 109 }),
  rec(31, "subagentStop", { gen: main, steps: 0, messages: 0 }),
  rec(40, "preCompact", { model: "gemini-3.7-flash-low", ctx: 120000 }),
  rec(50, "afterAgentResponse", { out: 1266 }),
  rec(51, "afterMCPExecution", { job: "job-aaaaaaaa11", action: "finish_job" }),
  rec(52, "stop"),
];
fs.writeFileSync(path.join(folder, "2026-10-18.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

const clean = readCursorRecords(folder, 0);
assert.strictEqual(clean.length, records.length - 2, "the second copy of each thought is dropped");
assert.ok(clean.every((r) => r.c === helper || r.gen === turn || r.gen === main), "turn id variants are reduced to the turn's id");

const list = readCursor(models, 0, { folder });
assert.strictEqual(list.length, 1, "the helper agent is part of the conversation that started it");
const [c] = list;
assert.ok(c.insights.facts.helperCost > 0, "with its cost as helper cost");
assert.strictEqual(c.end, T + 52000);
assert.ok(!c.unpriced, "gemini-3.7-flash-low is priced as Gemini 3.7 Flash");
const gemini = c.models.find((m) => m.model === "gemini-3.7-flash-low");
assert.strictEqual(gemini.requests, 1, "compaction is one request on Cursor's own model");
assert.strictEqual(gemini.modelId, "google/gemini-3.7-flash");

const job = { id: "job-aaaaaaaa11", createdAt: new Date(T).toISOString() };
const a = cursorJobActuals([job], models, folder, T + 3600e3)[job.id];
assert.ok(a && a.status === "done");
const withoutHelper = c.cost - c.insights.facts.helperCost;
assert.ok(a.costUsd > withoutHelper && a.costUsd <= c.cost + 1e-4, "the plan includes the helper it started");

fs.rmSync(folder, { recursive: true });
console.log("cursor record tests passed");
