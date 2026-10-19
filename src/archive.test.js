// Checks the saved conversation summaries: kept after a tool deletes its records, for as long as
// "Keep history for" says, never a part of a conversation instead of the whole, never Cursor.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { withArchive, pruneArchive, clearArchive, readArchive } = require("./archive");

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ts-archive-"));
const DAY = 86400e3;
const now = Date.UTC(2026, 9, 18, 12);
const conv = (id, tool, startDaysAgo, cost, extra = {}) => ({
  id: `${tool}:${id}`, tool, title: `Conversation ${id}`, project: "game",
  start: now - startDaysAgo * DAY, end: now - startDaysAgo * DAY + 3600e3, cost,
  models: [{ model: "claude-sonnet-5-5", cost }], insights: { facts: {}, drivers: {} }, jobIds: [], approximate: false, ...extra,
});
const tracked = new Set(["claude-code", "codex", "cursor"]);
const since = now - 90 * DAY;
const ids = (list) => list.map((c) => c.id + (c.saved ? " (saved)" : "")).sort();

// First read: everything is live and gets saved, except Cursor (its records are TokenScope's own).
let list = withArchive(folder, [conv("a", "claude-code", 40, 1), conv("b", "codex", 5, 2), conv("c", "cursor", 2, 3)], { since, tracked, keepDays: 90, now });
assert.deepStrictEqual(ids(list), ["claude-code:a", "codex:b", "cursor:c"]);
assert.deepStrictEqual(Object.keys(readArchive(folder)).sort(), ["claude-code:a", "codex:b"]);
assert.ok(!JSON.stringify(readArchive(folder)).includes('"saved"'));

// Claude Code deleted its log: the conversation stays in History, marked as saved.
list = withArchive(folder, [conv("b", "codex", 5, 2)], { since, tracked, keepDays: 90, now });
assert.deepStrictEqual(ids(list), ["claude-code:a (saved)", "codex:b"]);
assert.strictEqual(list.find((c) => c.id === "claude-code:a").cost, 1);

// A conversation that went on is updated.
withArchive(folder, [conv("b", "codex", 5, 2.5)], { since, tracked, keepDays: 90, now });
assert.strictEqual(readArchive(folder)["codex:b"].cost, 2.5);

// A reader that only sees the end of a conversation doesn't replace the whole one.
list = withArchive(folder, [conv("b", "codex", 4, 0.4, { end: now - 5 * DAY + 3600e3 })], { since, tracked, keepDays: 90, now });
assert.strictEqual(readArchive(folder)["codex:b"].cost, 2.5);
assert.strictEqual(list.find((c) => c.id === "codex:b").cost, 2.5, "the fuller saved summary is shown");

// Tools switched off don't show, and only conversations since the asked time.
assert.deepStrictEqual(ids(withArchive(folder, [], { since, tracked: new Set(["codex"]), keepDays: 90, now })), ["codex:b (saved)"]);
assert.deepStrictEqual(ids(withArchive(folder, [], { since: now - 7 * DAY, tracked, keepDays: 90, now })), ["codex:b (saved)"]);

// Kept as long as "Keep history for" says: 30 days drops the 40-day-old one, forever keeps all.
withArchive(folder, [conv("old", "opencode", 500, 9)], { since: 0, tracked, keepDays: 0, now });
assert.ok(readArchive(folder)["opencode:old"], "forever keeps old ones");
assert.strictEqual(pruneArchive(folder, 365, now), 1);
assert.strictEqual(pruneArchive(folder, 30, now), 1);
assert.deepStrictEqual(Object.keys(readArchive(folder)), ["codex:b"]);

// A subagent saved as its own conversation (before 1.0.7), now counted inside its parent: not shown twice.
withArchive(folder, [conv("sub", "opencode", 3, 2)], { since: 0, tracked, keepDays: 0, now });
assert.ok(readArchive(folder)["opencode:sub"]);
const parent = { ...conv("main", "opencode", 3, 1), includes: ["opencode:sub"] };
assert.deepStrictEqual(ids(withArchive(folder, [parent], { since: 0, tracked, keepDays: 0, now })).filter((x) => x.includes("sub")), [], "the old copy isn't shown");
assert.ok(!readArchive(folder)["opencode:sub"], "and is removed");

// A fork saved by an older version (copies counted, no reply list) is replaced by the corrected live
// one, which starts later; a genuinely trimmed log still shows the fuller saved summary.
withArchive(folder, [conv("fork", "claude-code", 10, 9)], { since: 0, tracked, keepDays: 0, now });
const fixedFork = { ...conv("fork", "claude-code", 5, 3), replyIds: ["msg_3"] };
const shownFork = withArchive(folder, [fixedFork], { since: 0, tracked, keepDays: 0, now }).find((c) => c.id === "claude-code:fork");
assert.ok(!shownFork.saved && shownFork.cost === 3, "the corrected fork is shown and saved");
assert.strictEqual(readArchive(folder)["claude-code:fork"].cost, 3);
withArchive(folder, [{ ...conv("long", "claude-code", 10, 9), replyIds: ["a", "b", "c"] }], { since: 0, tracked, keepDays: 0, now });
const cut = withArchive(folder, [{ ...conv("long", "claude-code", 5, 3), replyIds: ["c"] }], { since: 0, tracked, keepDays: 0, now }).find((c) => c.id === "claude-code:long");
assert.ok(cut.saved && cut.cost === 9, "a trimmed log shows the fuller saved summary");

clearArchive(folder);
assert.deepStrictEqual(readArchive(folder), {});
fs.rmSync(folder, { recursive: true });
console.log("saved history tests passed");
