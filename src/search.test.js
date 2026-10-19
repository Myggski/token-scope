// Checks Spending's search: every word must match, name matches first, one typo forgiven, accents ignored.
const assert = require("assert");
const { searchConversations, highlights, oneEdit } = require("./search");

const items = [
  { title: "Fix quest journal bugs", details: "hydra · Oct 18 · Claude Sonnet 5.5" },
  { title: "Ladder Climb Reconciliation Plan", details: "p4 · Oct 15 · Claude Opus 5.5 · Cursor" },
  { title: "Explain the save system", details: "hydra · Oct 12 · GPT-5.5 · Codex · subagent Review quest rewards" },
  { title: "Café menu", details: "web · Oct 1 · OpenCode · Archived" },
];
const order = (q) => searchConversations(items, q).map((h) => h.index);

assert.deepStrictEqual(order(""), [0, 1, 2, 3], "nothing typed: everything, in order");
assert.deepStrictEqual(order("quest"), [0, 2], "name match first, then the smaller text (a subagent's name)");
assert.deepStrictEqual(order("hydra quest"), [0, 2], "every word has to match, anywhere");
assert.deepStrictEqual(order("ladder opus"), [1]);
assert.deepStrictEqual(order("cursor"), [1], "the tool");
assert.deepStrictEqual(order("archived"), [3]);
assert.deepStrictEqual(order("cafe"), [3], "accents don't matter");
assert.deepStrictEqual(order("QUEST JOURNAL"), [0], "capitals don't matter");
assert.deepStrictEqual(order("reconcilation"), [1], "one typo in a longer word");
assert.deepStrictEqual(order("jornal"), [0], "a missing letter");
assert.deepStrictEqual(order("svae"), [], "short words must be right (too many near misses otherwise)");
assert.deepStrictEqual(order("oct 15"), [1], "dates through the smaller text");
assert.deepStrictEqual(order("gpt-5.5"), [2]);
assert.deepStrictEqual(order("quest nothing"), [], "a word that matches nowhere: no match");
const exactFirst = searchConversations([{ title: "Recocile ladder", details: "" }, { title: "Reconcile ladder", details: "" }], "reconcile");
assert.deepStrictEqual(exactFirst.map((h) => h.index), [1, 0], "exact matches before near misses");

assert.ok(oneEdit("journal", "jornal") && oneEdit("save", "svae") && !oneEdit("save", "vase"));
assert.deepStrictEqual(highlights("Fix quest journal bugs", "journal quest"), [[4, 9], [10, 17]]);
assert.deepStrictEqual(highlights("Café menu", "cafe"), [[0, 4]], "positions in the text as written, accents included");
console.log("search tests passed");
