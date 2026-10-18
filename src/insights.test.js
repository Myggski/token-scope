// Checks the cost facts with made-up timelines.
const assert = require("assert");
const { analyze, commandKind } = require("./insights");

assert.strictEqual(commandKind("npm run build"), "build");
assert.strictEqual(commandKind('"C:/UE/Engine/Build/BatchFiles/Build.bat" Game Win64'), "build");
assert.strictEqual(commandKind("dotnet test"), "test");
assert.strictEqual(commandKind("git status"), "other");

const model = { inPerM: 3, outPerM: 15, cachedPerM: 0.3, cacheWritePerM: 3.75 };
const min = 60e3;
// A steady conversation: context grows 2k per step, everything re-sent comes from the cache.
function steady(n, start = 20000) {
  return Array.from({ length: n }, (_, i) => {
    const context = start + i * 2000;
    return { t: i * min, model, context, fresh: i ? 2000 : context, cached: i ? context - 2000 : 0, output: 300, cost: 0.01, pause: i ? { ms: min, who: "unknown", kind: null } : null };
  });
}

let a = analyze({ requests: steady(10) });
assert.deepStrictEqual(a.facts.cacheExpiries, []);
assert.strictEqual(a.facts.steps, 10);
assert.ok(!("findings" in a), "facts only, no advice");

// You came back after 20 minutes and everything was re-read at full price.
let r = steady(10);
r[5] = { ...r[5], fresh: r[5].context, cached: 0, pause: { ms: 20 * min, who: "you", kind: null } };
a = analyze({ requests: r, cacheMinutes: 5, total: 1 });
assert.strictEqual(a.facts.cacheExpiries.length, 1);
assert.strictEqual(a.facts.cacheExpiries[0].during, "user's reply");
assert.strictEqual(a.facts.cacheExpiries[0].pauseMinutes, 20);
assert.ok(Math.abs(a.drivers.pausesYou - 28000 * 3.45 / 1e6) < 1e-4, "extra cost of the expired cache");
assert.strictEqual(a.facts.longestUserPauseMinutes, 20);

// A 10-minute build let the cache expire.
r = steady(10);
r[3] = { ...r[3], fresh: r[3].context, cached: 0, pause: { ms: 10 * min, who: "tool", kind: "build" } };
a = analyze({ requests: r, tools: [{ t: 2 * min, after: 2, kind: "build", ms: 10 * min, outTokens: 500 }], total: 1 });
assert.strictEqual(a.facts.cacheExpiries[0].during, "build");
assert.ok(a.drivers.pausesTools > 0);
assert.strictEqual(a.facts.buildAndTestMinutes, 10);

// A 40k-token build log early on is re-read by every later step.
a = analyze({ requests: steady(20), tools: [{ t: min, after: 1, kind: "build", outTokens: 40000 }], total: 5 });
assert.strictEqual(a.facts.largeOutputsCount, 1);
assert.ok(Math.abs(a.drivers.bigOutputs - 18 * 40000 * 0.3 / 1e6) < 1e-4);

// The same file read three times.
a = analyze({ requests: steady(10), tools: [0, 1, 2].map((i) => ({ t: i, after: i, kind: "read", file: "Loot.cpp", outTokens: 100 })) });
assert.deepStrictEqual(a.facts.filesReadSeveralTimes, [{ file: "Loot.cpp", times: 3 }]);

// The breakdown never adds up to more than the conversation.
a = analyze({ requests: steady(30), tools: [{ t: 0, after: 0, kind: "read", outTokens: 900000 }], total: 0.3 });
assert.ok(Object.values(a.drivers).reduce((s, v) => s + v, 0) <= 0.3 + 1e-3);
console.log("insights tests passed");
