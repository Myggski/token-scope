const assert = require("assert");
const { tokenCost, planTokens, estimatePlan, correction } = require("./estimate");

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
const model = { id: "x", inPerM: 1, outPerM: 4, cachedPerM: 0.1, context: 100000 };

// $1/M input, $0.10/M cached, $4/M output
near(tokenCost(model, { input: 1e6, cached: 0, output: 0 }), 1, "plain input");
near(tokenCost(model, { input: 1e6, cached: 1e6, output: 0 }), 0.1, "cached input");
near(tokenCost({ ...model, cachedPerM: null }, { input: 1e6, cached: 1e6 }), 1, "no cache price means full price");

// 3 steps, 10k start, 2k + 1k growth: inputs 10k, 13k, 16k
const t = planTokens({ steps: 3, startContext: 10000, contextPerStep: 2000, outputPerStep: 1000 });
near(t.input, 39000, "input sums every step's context");
near(t.cached, 39000 - (10000 + 2 * 3000), "only new tokens are fresh");
near(t.output, 3000, "output per step");
near(t.peakContext, 17000, "peak context");

const plan = { steps: 20, startContext: 20000, contextPerStep: 3000, outputPerStep: 800, rework: 0.2 };
const e = estimatePlan(model, plan);
assert.ok(e.low < e.likely && e.likely < e.high, "range is ordered");
assert.ok(e.peakContext > 100000 && !e.fitsContext, "24 likely steps reach about 108k, over 100k");
assert.ok(estimatePlan(model, { ...plan, steps: 10 }).fitsContext, "a shorter plan fits");

assert.deepStrictEqual(correction([]), { factor: 1, jobs: 0, approximate: 0, applied: false });
const job = (likely, actual) => ({ estimates: { x: { likely } }, actual: { modelId: "x", costUsd: actual } });
near(correction([job(1, 2), job(1, 0.5)]).factor, 1, "2x over and 2x under cancel out");
near(correction([job(1, 2), job(2, 4)]).factor, 2, "consistent 2x");
assert.strictEqual(correction([job(1, 100), job(1, 100)]).factor, 10, "capped at 10x");
console.log("estimate tests passed");
assert.strictEqual(correction([job(1, 2), job(1, 2), { ...job(1, 0.01), actual: { modelId: "x", costUsd: 0.01, status: "running" } }]).factor, 2, "running jobs don't count");
console.log("running-job check passed");
// Approximate real costs (Cursor) are left out: one 20x-off Cursor measurement mustn't skew every estimate.
const approx = (likely, actual) => ({ estimates: { x: { likely } }, actual: { modelId: "x", costUsd: actual, approximate: true } });
const mixed = correction([job(1, 2), job(1, 2), approx(1, 20)]);
assert.strictEqual(mixed.factor, 2);
assert.strictEqual(mixed.approximate, 1, "and counted as left out");
assert.strictEqual(correction([approx(1, 2), approx(1, 2)]).applied, false, "approximate costs alone never adjust estimates");
console.log("approximate-cost check passed");

// Per tool: a tool's own finished plans decide its correction, approximate ones included.
const ran = (tool, likely, actual, extra = {}) => ({ estimates: { x: { likely } }, actual: { modelId: "x", costUsd: actual, source: tool, ...extra } });
const history = [ran("claude-code", 1, 2), ran("claude-code", 1, 2), ran("cursor-hook", 5.78, 0.73, { approximate: true }), ran("cursor-hook", 8.55, 0.70, { approximate: true })];
const cur = correction(history, "cursor");
near(cur.factor, Math.sqrt((0.73 / 5.78) * (0.70 / 8.55)), "Cursor learns from its own plans (about 0.1x)");
assert.strictEqual(cur.tool, "cursor");
near(correction(history, "claude-code").factor, 2, "Claude Code keeps its own");
near(correction(history, "codex").factor, 2, "a tool without 2 plans of its own gets the shared one from exact costs");
near(correction(history).factor, 2, "and so does an estimate from an unknown tool");
const { toolOf, toolOfClient } = require("./estimate");
assert.strictEqual(toolOfClient("cursor-vscode"), "cursor");
assert.strictEqual(toolOfClient("claude-ai"), null, "Claude Desktop isn't Claude Code");
assert.strictEqual(toolOf({ client: "codex-mcp-client" }), "codex", "a plan not measured yet: the tool that asked");
console.log("per-tool correction check passed");

// Cache pricing: the 3-step plan above has 16k new tokens and 23k re-sent.
const { agentCost, estimateJob, cacheWhatIf, describePhase, DEFAULT_CACHE_HIT } = require("./estimate");
const cm = { inPerM: 1, outPerM: 4, cachedPerM: 0.1, cacheWritePerM: 1.25 };
// 100% hits: 23k cached ($0.0023) + 16k written ($0.02) + 3k out ($0.012)
near(agentCost(cm, t, 1).cost, 0.0023 + 0.02 + 0.012, "all re-sent tokens from cache");
// 0% hits: everything written ($0.04875) + output
near(agentCost(cm, t, 0).cost, 39000 * 1.25 / 1e6 + 0.012, "no cache hits: all input written");
// No cache-write price listed: writing costs normal input
near(agentCost({ ...cm, cacheWritePerM: null }, t, 1).cost, 0.0023 + 0.016 + 0.012, "write at input price when none listed");
// A model without caching pays full input, whatever the hit rate
near(agentCost({ inPerM: 1, outPerM: 4, cachedPerM: null }, t, 0.97).cost, 0.039 + 0.012, "no caching");
assert.strictEqual(estimatePlan(cm, plan).cacheHit, DEFAULT_CACHE_HIT, "default hit rate is reported");
assert.strictEqual(estimatePlan(cm, { ...plan, cacheHit: 0.8 }).cacheHit, 0.8, "plan's own hit rate is used");
const w = cacheWhatIf(cm, plan);
assert.ok(w.length === 3 && w[0].likely < w[1].likely && w[1].likely < w[2].likely, "more cache misses cost more");
assert.strictEqual(cacheWhatIf({ inPerM: 1, outPerM: 4, cachedPerM: null }, plan), null, "no what-if without caching");
const two = { phases: [{ ...plan, cacheHit: 0.9 }, { ...plan, cacheHit: 0.5 }] };
near(estimateJob(cm, two).likely, estimatePlan(cm, { ...plan, cacheHit: 0.9 }).likely + estimatePlan(cm, { ...plan, cacheHit: 0.5 }).likely, "each phase keeps its own hit rate");
assert.strictEqual(estimateJob(cm, two).cacheHit, null, "mixed hit rates are reported as mixed");
assert.strictEqual(describePhase({ ...plan, cacheHit: 0.9 }), "20 steps + 20% rework, starts with 20k tokens, reads 3k and writes 800 per step, 10% cache misses");
console.log("cache tests passed");
