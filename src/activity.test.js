const assert = require("assert");
const { activitySpans, activeTime, breakMinutes, DEFAULT_BREAK_MINUTES } = require("./activity");

const MIN = 60e3, H = 3600e3, DAY = 24 * H;
const t0 = Date.UTC(2026, 9, 20, 8);

// Moments a minute apart become one span; a 10-minute gap stays a gap (joined later by the break length).
const spans = activitySpans({ points: [t0, t0 + MIN, t0 + 2 * MIN, t0 + 12 * MIN, t0 + 13 * MIN] });
assert.deepStrictEqual(spans, [[t0, t0 + 2 * MIN], [t0 + 12 * MIN, t0 + 13 * MIN]]);

// A tool run covers its whole time: a 30-minute build isn't a break.
const build = activitySpans({ points: [t0, t0 + 30 * MIN + 5000], intervals: [[t0 + 1000, t0 + 30 * MIN]] });
assert.deepStrictEqual(build, [[t0, t0 + 30 * MIN + 5000]]);

// A conversation you came back to two days later: two 30-minute sessions, not two days.
const resumed = { start: t0, end: t0 + 2 * DAY + 30 * MIN, activity: [[t0, t0 + 30 * MIN], [t0 + 2 * DAY, t0 + 2 * DAY + 30 * MIN]] };
assert.strictEqual(activeTime([resumed]).hours, 1);
assert.strictEqual(activeTime([resumed]).approximate, false);

// Gaps up to the break length count (reading a reply, writing the next prompt), longer ones don't.
const thinking = { activity: [[t0, t0 + 10 * MIN], [t0 + 25 * MIN, t0 + 35 * MIN]] };
assert.strictEqual(activeTime([thinking], 20).hours * 60, 35); // 15-minute gap counts
assert.strictEqual(activeTime([thinking], 10).hours * 60, 20); // with 10 it's a break

// Two conversations at the same time count once; switching between them isn't a break.
const a = { activity: [[t0, t0 + 30 * MIN]] }, b = { activity: [[t0 + 15 * MIN, t0 + 45 * MIN], [t0 + 55 * MIN, t0 + H]] };
assert.strictEqual(activeTime([a, b], 20).hours, 1);

// Without activity (Zed, or saved by an older version): first message to last reply, approximate.
const zed = { start: t0, end: t0 + 3 * H };
assert.deepStrictEqual(activeTime([zed]), { hours: 3, approximate: true });
assert.strictEqual(activeTime([a, zed]).approximate, true);

// The break length: invalid values fall back to the default.
assert.strictEqual(breakMinutes(30), 30);
for (const bad of [null, undefined, "", "x", 0, 2, 10000]) assert.strictEqual(breakMinutes(bad), DEFAULT_BREAK_MINUTES);
assert.strictEqual(DEFAULT_BREAK_MINUTES, 20);

assert.deepStrictEqual(activeTime([]), { hours: 0, approximate: false });

console.log("activity tests passed");
