// Checks the Comparison math: a person's time priced from their monthly cost, and the time with AI
// measured from the picked conversations.
const assert = require("assert");
const { timeWithAi, compare, UNIT_HOURS, MONTH_HOURS } = require("./comparison");

const h = 3600e3;
assert.strictEqual(timeWithAi([]), 0);
assert.strictEqual(timeWithAi([{ start: 0, end: 4 * h }]), 4);
assert.strictEqual(timeWithAi([{ start: 0, end: 2 * h }, { start: 5 * h, end: 6 * h }]), 3, "separate conversations add up");
assert.strictEqual(timeWithAi([{ start: 0, end: 3 * h }, { start: 1 * h, end: 4 * h }]), 4, "overlapping ones count once");
assert.strictEqual(timeWithAi([{ start: 0, end: 5 * h }, { start: 1 * h, end: 2 * h }]), 5, "one inside another");

// The example: 6,500 a month, an estimate of 2 weeks, conversations of 4 hours and $40.
const r = compare({ monthlyCost: 6500, estimateHours: 2 * UNIT_HOURS.weeks, measuredHours: 4, tokens: 40 });
const hourly = 6500 / MONTH_HOURS;
assert.strictEqual(MONTH_HOURS, 160);
assert.ok(Math.abs(r.estimate - hourly * 80) < 1e-9, "2 weeks = 80 hours = half a month");
assert.ok(Math.abs(r.estimate - 3250) < 1e-9);
assert.ok(Math.abs(r.conversations - (hourly * 4 + 40)) < 1e-9);
assert.ok(Math.abs(r.difference - (3250 - 162.5 - 40)) < 1e-9);
assert.strictEqual(r.hoursDifference, 76);

// The conversations can also come out higher: the difference is then negative.
assert.ok(compare({ monthlyCost: 1600, estimateHours: 1, measuredHours: 1, tokens: 5 }).difference < 0);
// Missing inputs: what can't be worked out is null.
assert.strictEqual(compare({ monthlyCost: null, estimateHours: 8, measuredHours: 1, tokens: 1 }).estimate, null);
assert.strictEqual(compare({ monthlyCost: 6500, estimateHours: null, measuredHours: 1, tokens: 1 }).difference, null);
assert.ok(compare({ monthlyCost: 6500, estimateHours: null, measuredHours: 1, tokens: 1 }).conversations > 0);

// Typing a time.
const { parseDuration, formatDuration } = require("./comparison");
assert.strictEqual(parseDuration("3w 4d 3h"), 3 * 40 + 4 * 8 + 3);
assert.strictEqual(parseDuration("2w4d"), 112);
assert.strictEqual(parseDuration("2 weeks 3 days"), 104);
assert.strictEqual(parseDuration("1,5d"), 12);
assert.strictEqual(parseDuration("90m"), 1.5);
assert.strictEqual(parseDuration("10"), 10, "a number on its own is hours");
assert.strictEqual(parseDuration(""), null);
assert.ok(Number.isNaN(parseDuration("soon")));
assert.strictEqual(formatDuration(155), "3 weeks 4 days 3 h");
assert.strictEqual(formatDuration(0.5), "30 min");
assert.strictEqual(formatDuration(1 / 60), "1 min");
assert.strictEqual(formatDuration(48), "1 week 1 day");

console.log("comparison tests passed");
