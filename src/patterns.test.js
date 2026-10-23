const assert = require("assert");
const { patterns } = require("./patterns");

const DAY = 86400e3, NOW = Date.UTC(2026, 9, 23, 12);
// A conversation that ended `daysAgo` days ago: cost, of which waiting cost and long-step cost, and compactions.
const conv = (daysAgo, { cost = 1, waiting = 0, commands = 0, switches = 0, long = 0, compactions = 0, tool = "claude-code" } = {}) => ({
  tool, start: NOW - daysAgo * DAY - 3600e3, end: NOW - daysAgo * DAY, cost,
  insights: { drivers: { pausesYou: waiting, pausesTools: commands, switches }, facts: { compactions, longStepsCostUsd: long } },
});
const many = (n, from, to, opts) => Array.from({ length: n }, (_, i) => conv(from + ((to - from) * i) / n, opts));

// New user: 25 days of history. The last 30 days, no comparison.
let p = patterns([...many(9, 0, 25, { waiting: 0.1, compactions: 2, long: 0.4 }), ...many(3, 1, 20, { waiting: 0.1, long: 0.4 })], NOW);
assert.strictEqual(p.stage, "new");
assert.strictEqual(p.before, null);
assert.strictEqual(p.now.conversations, 12);
assert.ok(Math.abs(p.now.cacheWhileWaiting - 0.1) < 1e-9);
assert.strictEqual(p.now.compactions, 1.5); // 9 conversations compacted twice, 3 never: 18 / 12
assert.ok(Math.abs(p.now.longConversations - 0.4) < 1e-9);

// Builds and switching: shares of what was paid.
p = patterns(many(10, 0, 20, { commands: 0.25, switches: 0.05 }), NOW);
assert.ok(Math.abs(p.now.cacheDuringCommands - 0.25) < 1e-9);
assert.ok(Math.abs(p.now.switching - 0.05) < 1e-9);

// Too few conversations: hidden.
assert.strictEqual(patterns(many(9, 0, 20), NOW), null);
assert.strictEqual(patterns([], NOW), null);

// 9 weeks of history: the last 4 weeks next to the 4 before.
p = patterns([...many(12, 0, 27, { waiting: 0.05 }), ...many(12, 29, 62, { waiting: 0.2 })], NOW);
assert.strictEqual(p.stage, "previous");
assert.ok(Math.abs(p.before.cacheWhileWaiting - 0.2) < 1e-9);
assert.ok(Math.abs(p.now.cacheWhileWaiting - 0.05) < 1e-9);

// 5 months: the last 4 weeks next to the 8 weeks before (your usual). Older ones don't count.
p = patterns([...many(10, 0, 27, { compactions: 1 }), ...many(30, 29, 83, { compactions: 3 }), ...many(10, 90, 150, { compactions: 9 })], NOW);
assert.strictEqual(p.stage, "usual");
assert.strictEqual(p.before.compactions, 3);
assert.strictEqual(p.before.conversations, 30);

// Long history but too little before the last 4 weeks to compare: shown without a comparison.
p = patterns([...many(12, 0, 27), conv(100)], NOW);
assert.strictEqual(p.stage, "new");
assert.strictEqual(p.before, null);

// Zed (totals only) and forks with nothing new aren't counted.
const zed = { tool: "zed", totalsOnly: true, start: NOW - DAY, end: NOW, cost: 5 };
assert.strictEqual(patterns([...many(9, 0, 20), zed, { ...conv(1), copyOnly: true }], NOW), null);

// Saved by an older version without the newer facts: left out of those habits only.
const old = { ...conv(2, { cost: 10, waiting: 5 }), insights: { drivers: { pausesYou: 5 }, facts: {} } };
p = patterns([...many(10, 0, 20, { long: 0.5, compactions: 1 }), old], NOW);
assert.strictEqual(p.now.compactions, 1);
assert.ok(Math.abs(p.now.longConversations - 0.5) < 1e-9);
assert.ok(Math.abs(p.now.cacheWhileWaiting - 5 / 20) < 1e-9);

// Nothing paid (free models only): the cost shares can't be worked out.
p = patterns(many(10, 0, 20, { cost: 0 }), NOW);
assert.strictEqual(p.now.cacheWhileWaiting, null);
assert.strictEqual(p.now.longConversations, null);
assert.strictEqual(p.now.compactions, 0); // known even though nothing was paid

console.log("patterns tests passed");
