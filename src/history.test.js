// Checks the history readers with made-up data: OpenCode's storage generations, the Cursor recorder
// and replay, adding and removing the Cursor hook, and the format checks.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { readOpenCode, readCursor, cursorJobActuals } = require("./history");
const { createChecks, checkOpenRouter } = require("./checks");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ts-history-"));
const models = [
  { id: "anthropic/claude-sonnet-5.5", inPerM: 2, outPerM: 10, cachedPerM: 0.2, cacheWritePerM: 2.5 },
  { id: "openai/gpt-5.6", inPerM: 1, outPerM: 8, cachedPerM: 0.1, cacheWritePerM: null },
];
const T = Date.UTC(2026, 9, 1, 10, 0);

(async () => {
  // ---------- OpenCode ----------
  const oc = path.join(tmp, "opencode");
  fs.mkdirSync(oc);
  const SQL = await require("sql.js")({ locateFile: (f) => path.join(path.dirname(require.resolve("sql.js")), f) });
  const msg = (id, session, model, tokens, time, extra = {}) => JSON.stringify({ id, sessionID: session, role: "assistant", modelID: model, tokens, time: { created: time }, path: { cwd: "/work/game" }, ...extra });
  const tok = (input, output, read, write, reasoning = 0) => ({ input, output, reasoning, cache: { read, write } });
  const db = new SQL.Database();
  db.run("CREATE TABLE session (id TEXT, title TEXT, directory TEXT)");
  db.run("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
  db.run("INSERT INTO session VALUES ('s1', 'Fix the loot table', '/work/game')");
  db.run("INSERT INTO message VALUES (?, ?, ?)", ["m1", "s1", msg("m1", "s1", "claude-sonnet-5-5", tok(1e6, 1e5, 0, 0), T)]);
  db.run("INSERT INTO message VALUES (?, ?, ?)", ["u1", "s1", JSON.stringify({ id: "u1", sessionID: "s1", role: "user" })]);
  db.run("CREATE TABLE session_v2 (id TEXT, data TEXT)");
  db.run("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT)");
  db.run("INSERT INTO session_v2 VALUES ('s2', ?)", [JSON.stringify({ id: "s2", title: "New editor panel", directory: "/work/editor", time: { archived: T } })]);
  db.run("INSERT INTO session_message VALUES ('m1', 's1', 'assistant', 1, ?)", [msg("m1", "s1", "claude-sonnet-5-5", tok(1e6, 1e5, 0, 0), T)]); // 2.x copy of m1
  db.run("INSERT INTO session_message VALUES ('m2', 's2', 'assistant', 1, ?)", [JSON.stringify({ id: "m2", sessionID: "s2", role: "assistant", model: { id: "gpt-5.6", providerID: "openai" }, tokens: tok(0, 1e6, 1e6, 0, 1e6), time: { created: T + 60e3 } })]);
  // A fork of s1 (/fork): a new session that starts with copies of s1's replies (new ids, same time and
  // tokens), then one reply of its own. Only that one counts for the fork.
  db.run("INSERT INTO session_v2 VALUES ('s4', ?)", [JSON.stringify({ id: "s4", title: "Fix the loot table (fork #1)", directory: "/work/game", time: { created: T + 250e3 } })]);
  db.run("INSERT INTO session_message VALUES ('c1', 's4', 'assistant', 1, ?)", [msg("c1", "s4", "claude-sonnet-5-5", tok(1e6, 1e5, 0, 0), T)]);
  db.run("INSERT INTO session_message VALUES ('m6', 's4', 'assistant', 2, ?)", [msg("m6", "s4", "claude-sonnet-5-5", tok(2e5, 1e4, 0, 0), T + 300e3)]);
  // A subagent (@code-reviewer) the first conversation started: a session of its own with s1 as parent.
  db.run("INSERT INTO session_v2 VALUES ('s3', ?)", [JSON.stringify({ id: "s3", title: "Review changes (@code-reviewer subagent)", parentID: "s1", directory: "/work/game" })]);
  db.run("INSERT INTO session_message VALUES ('m5', 's3', 'assistant', 1, ?)", [msg("m5", "s3", "claude-sonnet-5-5", tok(1e5, 1e4, 0, 0), T + 200e3)]);
  fs.writeFileSync(path.join(oc, "opencode.db"), Buffer.from(db.export()));
  fs.mkdirSync(path.join(oc, "storage", "message", "s1"), { recursive: true });
  fs.writeFileSync(path.join(oc, "storage", "message", "s1", "m3.json"), msg("m3", "s1", "claude-sonnet-5-5", tok(0, 0, 1e6, 1e6), T + 120e3));
  fs.writeFileSync(path.join(oc, "storage", "message", "s1", "m4.json"), msg("m4", "s1", "my-local-model", tok(5e5, 5e5, 0, 0), T + 180e3, { cost: 0.42 }));

  let checks = createChecks();
  const oconv = await readOpenCode(models, 0, { folder: oc, checks });
  const s1 = oconv.find((c) => c.id === "opencode:s1"), s2 = oconv.find((c) => c.id === "opencode:s2");
  assert.strictEqual(oconv.length, 3, "three conversations: the fork is one of its own");
  const fork = oconv.find((c) => c.id === "opencode:s4");
  assert.ok(Math.abs(fork.cost - (2e5 * 2 + 1e4 * 10) / 1e6) < 1e-9, "the fork counts only its own reply, not the copy of the original's");
  assert.strictEqual(s1.title, "Fix the loot table");
  assert.strictEqual(s1.project, "game");
  assert.ok(s2.archived && !s1.archived, "archived in OpenCode");
  assert.strictEqual(Number(s1.cost.toFixed(4)), 3 + 2.7 + 0.42 + 0.3, "each message counted once; OpenCode's own cost for unpriced models; the subagent included");
  assert.deepStrictEqual(s1.helpers.map((h) => h.title), ["Review changes (@code-reviewer subagent)"], "the subagent is part of the conversation that started it");
  assert.ok(Math.abs(s1.helpers[0].cost - 0.3) < 1e-6, "with its own cost");
  assert.deepStrictEqual(s1.helpers[0].models.map((m) => m.model), ["claude-sonnet-5-5"], "and the model it ran on");
  assert.ok(Math.abs(s1.insights.facts.helperCost - 0.3) < 1e-6);
  assert.ok(!oconv.some((c) => c.id === "opencode:s3"), "not a conversation of its own");
  assert.strictEqual(Number(s2.cost.toFixed(4)), 16.1, "reasoning priced as output");
  assert.deepStrictEqual(checks.list(), [], "no warnings for the expected format");
  assert.ok(s1.insights && s1.insights.facts.steps === 3);

  // OpenCode changed its format: replies without token counts.
  const changed = path.join(tmp, "opencode-new");
  fs.mkdirSync(path.join(changed, "storage", "message", "s9"), { recursive: true });
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(changed, "storage", "message", "s9", `x${i}.json`), JSON.stringify({ id: `x${i}`, sessionID: "s9", role: "assistant", modelID: "claude-sonnet-5-5", usage: { in: 5 }, time: { created: T } }));
  checks = createChecks();
  await readOpenCode(models, 0, { folder: changed, checks });
  assert.match(checks.list()[0].message, /^OpenCode data mismatch, probably due to a OpenCode update/);

  // ---------- Cursor: the recorder script, then the replay ----------
  const records = path.join(tmp, "cursor-records");
  const hook = path.join(__dirname, "cursor-hook.js");
  const send = (event) => execFileSync(process.execPath, [hook, records], { input: JSON.stringify(event) }).toString();
  const base = { conversation_id: "conv1", model: "claude-sonnet-5-5", workspace_roots: ["/home/me/work/game"], user_email: "Someone@Example.com" };
  assert.strictEqual(send({ ...base, hook_event_name: "sessionStart", generation_id: "g1" }).trim(), "{}", "answers Cursor with {}");
  send({ ...base, hook_event_name: "afterMCPExecution", generation_id: "g1", mcp_server_name: "tokenscope", tool_name: "estimate_plan", tool_input: "{}", result_json: '{"job_id": "job-abcdefgh12"}' });
  send({ ...base, hook_event_name: "postToolUse", generation_id: "g1", tool_name: "read_file", tool_input: { path: "a.cpp" }, tool_output: "x".repeat(40000) });
  send({ ...base, hook_event_name: "afterShellExecution", generation_id: "g1", command: "secret-build.bat && npm run build", output: "lots", duration: 90000 });
  send({ ...base, hook_event_name: "afterAgentResponse", generation_id: "g1", text: "y".repeat(4000) });
  send({ ...base, hook_event_name: "afterMCPExecution", generation_id: "g1", mcp_server_name: "tokenscope", tool_name: "finish_job", tool_input: '{"job_id":"job-abcdefgh12"}', result_json: "{}" });
  send({ ...base, hook_event_name: "postToolUse", generation_id: "g2", tool_name: "read_file", tool_input: { path: "b.cpp" }, tool_output: "z".repeat(8000) });
  send({ ...base, hook_event_name: "beforeSubmitPrompt", prompt: "secret prompt text" }); // not recorded
  send({ hook_event_name: "afterMCPExecution", conversation_id: "conv1", mcp_server_name: "github", tool_name: "estimate_plan", result_json: "job-zzzzzzzz99" }); // not TokenScope
  const written = fs.readFileSync(path.join(records, fs.readdirSync(records)[0]), "utf8");
  assert.ok(!/xxxx|a\.cpp|secret|lots/.test(written), "no content is stored, only sizes and kinds");
  assert.strictEqual(written.trim().split("\n").length, 7, "seven recorded steps");
  assert.ok(written.includes('"kind":"build"') && written.includes('"project":"game"'));
  assert.ok(!/someone|example/i.test(written), "the account's email is never stored");
  const accts = new Set(written.trim().split("\n").map((l) => JSON.parse(l).acct));
  assert.ok(accts.size === 1 && /^[0-9a-f]{8}$/.test([...accts][0]), "the same scrambled account code on every step");
  send({ ...base, user_email: "someone@example.com ", hook_event_name: "stop" });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(records, fs.readdirSync(records)[0]), "utf8").trim().split("\n").pop()).acct, [...accts][0], "case and spaces don't change the code");

  checks = createChecks();
  const c = readCursor(models, 0, { folder: records, checks, cacheHit: 0.9 })[0];
  assert.ok(c.approximate && c.project === "game" && c.jobIds[0] === "job-abcdefgh12");
  assert.strictEqual(c.models[0].requests, 3, "two tool steps and one reply");
  assert.ok(c.models[0].cacheRead > 0 && c.cost > 0, "context grows and is partly cached");
  assert.strictEqual(c.insights.facts.toolUse.builds, 1, "the build is counted");

  const job = { id: "job-abcdefgh12", createdAt: new Date(Date.now() - 3600e3).toISOString(), estimates: {} };
  const actual = cursorJobActuals([job], models, records)[job.id];
  assert.ok(actual && actual.approximate && actual.status === "done");
  assert.ok(actual.costUsd > 0 && actual.costUsd < c.cost, "the job is part of the conversation");

  // Cursor changed its format: hook events without conversation ids.
  const odd = path.join(tmp, "cursor-odd");
  fs.mkdirSync(odd);
  fs.writeFileSync(path.join(odd, "2026-10-01.jsonl"), Array.from({ length: 12 }, (_, i) => JSON.stringify({ t: T + i, e: "postToolUse", c: null, in: 0, out: 0 })).join("\n"));
  checks = createChecks();
  readCursor(models, 0, { folder: odd, checks });
  assert.match(checks.list()[0].message, /^Cursor data mismatch/);

  // ---------- OpenRouter format check ----------
  checks = createChecks();
  checkOpenRouter({ data: [{ id: "a", pricing: { prompt: "0", completion: "0" }, created: 1, context_length: 1 }] }, checks);
  assert.deepStrictEqual(checks.list(), []);
  checkOpenRouter({ models_v2: [] }, checks);
  assert.match(checks.list()[0].message, /^OpenRouter data mismatch/);

  // ---------- Adding and removing the hook ----------
  process.env.HOME = path.join(tmp, "home");
  process.env.USERPROFILE = process.env.HOME;
  const ch = require("./cursorhook");
  fs.mkdirSync(path.join(process.env.HOME, ".cursor"), { recursive: true });
  const mine = { command: "./hooks/format.sh" };
  fs.writeFileSync(ch.hooksFile(), JSON.stringify({ version: 1, hooks: { afterFileEdit: [mine], postToolUse: [mine] } }));
  ch.installHook(path.join(tmp, "data"), { command: "/opt/TokenScope", script: "/x/cursor-hook.js", records });
  ch.installHook(path.join(tmp, "data"), { command: "/opt/TokenScope", script: "/x/cursor-hook.js", records });
  let hooks = JSON.parse(fs.readFileSync(ch.hooksFile(), "utf8")).hooks;
  assert.strictEqual(hooks.postToolUse.length, 2, "user's hook kept, TokenScope's added once");
  assert.ok(ch.hookInstalled());
  ch.removeHook();
  hooks = JSON.parse(fs.readFileSync(ch.hooksFile(), "utf8")).hooks;
  assert.deepStrictEqual(hooks, { afterFileEdit: [mine], postToolUse: [mine] }, "only TokenScope's hooks removed");
  fs.writeFileSync(ch.hooksFile(), "{ not json");
  assert.throws(() => ch.installHook(path.join(tmp, "data"), { command: "a", script: "b", records }), /isn't valid JSON/);
  assert.strictEqual(fs.readFileSync(ch.hooksFile(), "utf8"), "{ not json", "a broken hooks file is left alone");
  assert.ok(ch.lastRecord(records) > 0);
  assert.strictEqual(ch.pruneRecords(records, 0, true), 1);

  fs.rmSync(tmp, { recursive: true });
  console.log("history tests passed");
})().catch((e) => { console.error(e); process.exit(1); });

// Forks: the copy is dropped from the fork even when the fork is listed first and its copies carry
// the original's times. The session OpenCode created first keeps the reply.
{
  const { dropForkCopies } = require("./history");
  const tok = { input: 100, output: 10, read: 0, write: 0 };
  const messages = new Map([
    ["copy", { id: "copy", session: "fork", model: "m", time: 1000, tokens: tok }],
    ["own", { id: "own", session: "fork", model: "m", time: 5000, tokens: tok }],
    ["orig", { id: "orig", session: "main", model: "m", time: 1000, tokens: tok }],
    ["same-session-twice", { id: "same-session-twice", session: "main", model: "m", time: 1000, tokens: tok }],
  ]);
  dropForkCopies(messages, new Map([["main", { created: 900 }], ["fork", { created: 4000 }]]));
  assert.deepStrictEqual([...messages.keys()].sort(), ["orig", "own", "same-session-twice"], "the fork keeps only its own reply; the original keeps everything");
  // Newer OpenCode marks the fork: its copies count once even when their times were changed.
  const marked = new Map([
    ["o1", { id: "o1", session: "main", model: "m", time: 1000, tokens: tok }],
    ["o2", { id: "o2", session: "main", model: "m", time: 2000, tokens: { ...tok, output: 20 } }],
    ["k1", { id: "k1", session: "fork", model: "m", time: 9000, tokens: tok }],
    ["k2", { id: "k2", session: "fork", model: "m", time: 9001, tokens: { ...tok, output: 20 } }],
    ["k3", { id: "k3", session: "fork", model: "m", time: 9500, tokens: tok }], // its own, same size as o1 by chance
  ]);
  dropForkCopies(marked, new Map([["main", { created: 900 }], ["fork", { created: 8000, forkOf: "main" }]]));
  assert.deepStrictEqual([...marked.keys()].sort(), ["k3", "o1", "o2"], "each original reply matches one copy; the fork's own reply stays");
  // You go back to the original after forking: its new replies stay its own, and a fork reply that
  // happens to match one of them isn't taken for a copy (it didn't exist when the fork was made).
  const later = new Map([
    ["o1", { id: "o1", session: "main", model: "m", time: 1000, tokens: tok }],
    ["k1", { id: "k1", session: "fork", model: "m", time: 9000, tokens: tok }],
    ["o9", { id: "o9", session: "main", model: "m", time: 20000, tokens: { ...tok, output: 33 } }],
    ["k9", { id: "k9", session: "fork", model: "m", time: 15000, tokens: { ...tok, output: 33 } }],
  ]);
  dropForkCopies(later, new Map([["main", { created: 900 }], ["fork", { created: 8000, forkOf: "main" }]]));
  assert.deepStrictEqual([...later.keys()].sort(), ["k9", "o1", "o9"], "copy dropped; both sides' later work kept");
  console.log("fork copy tests passed");
}

// Claude Code: a resumed or forked session can start with a copy of the earlier one's replies (same
// message ids). They count once, in the session that started first; the copy shows only its own part.
(async () => {
  const { readClaudeCode } = require("./history");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-cc-fork-"));
  fs.mkdirSync(path.join(dir, "game"));
  const at = (min) => new Date(Date.UTC(2026, 9, 19, 9, 0) + min * 60e3).toISOString();
  const reply = (id, min, input, output) => JSON.stringify({ type: "assistant", timestamp: at(min), sessionId: "x", cwd: "/work/game", message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: input, output_tokens: output } } });
  const user = (min) => JSON.stringify({ type: "user", timestamp: at(min), message: { content: "go" } });
  const write = (name, lines, session) => fs.writeFileSync(path.join(dir, "game", name), lines.map((l) => l.replace('"sessionId":"x"', `"sessionId":"${session}"`)).join("\n") + "\n");
  // The copy's file name sorts first ("0-…"), and it's written a moment after the original.
  write("a.jsonl", [user(0), reply("msg_1", 1, 1e6, 1e5), user(2), reply("msg_2", 3, 1e6, 1e5)], "a");
  await new Promise((r) => setTimeout(r, 50));
  write("0-b.jsonl", [user(0), reply("msg_1", 1, 1e6, 1e5), user(2), reply("msg_2", 3, 1e6, 1e5), user(60), reply("msg_3", 61, 2e5, 1e4)], "b");
  const models = [{ id: "anthropic/claude-sonnet-5.5", inPerM: 2, outPerM: 10, cachedPerM: 0.2, cacheWritePerM: 2.5 }];
  const list = await readClaudeCode(models, 0, { folder: dir });
  const a = list.find((c) => c.id === "claude-code:a"), b = list.find((c) => c.id === "claude-code:b");
  assert.ok(Math.abs(a.cost - 2 * (2 + 1)) < 1e-9, "the original keeps its cost");
  assert.ok(Math.abs(b.cost - (0.4 + 0.1)) < 1e-9, "the resumed one counts only its own reply");
  assert.strictEqual(b.start, Date.parse(at(61)), "and starts at its own first reply");
  // Only a copy, nothing new yet: not shown.
  write("c.jsonl", [user(0), reply("msg_1", 1, 1e6, 1e5)], "c");
  const onlyCopy = (await readClaudeCode(models, 0, { folder: dir })).find((c) => c.id === "claude-code:c");
  assert.ok(onlyCopy && onlyCopy.copyOnly && !onlyCopy.cost && !onlyCopy.fork, "present but with nothing of its own (not listed; see archive.js)");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("claude code fork tests passed");
})().catch((e) => { console.error(e); process.exit(1); });

// The original's log is gone (Claude Code deletes logs after 30 days), but TokenScope's saved summary
// of it remembers which replies it counted: a fork's copies of them still don't count again.
(async () => {
  const { readClaudeCode } = require("./history");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-cc-gone-"));
  fs.mkdirSync(path.join(dir, "game"));
  const at = (min) => new Date(Date.UTC(2026, 9, 19, 9, 0) + min * 60e3).toISOString();
  const reply = (id, min, sid) => JSON.stringify({ type: "assistant", timestamp: at(min), sessionId: sid, message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 1e6, output_tokens: 1e5 } } });
  fs.writeFileSync(path.join(dir, "game", "fork.jsonl"), [reply("msg_1", 1, "fork"), reply("msg_2", 3, "fork"), reply("msg_3", 90, "fork")].join("\n") + "\n");
  const models = [{ id: "anthropic/claude-sonnet-5.5", inPerM: 2, outPerM: 10, cachedPerM: 0.2, cacheWritePerM: 2.5 }];
  const alone = (await readClaudeCode(models, 0, { folder: dir }))[0];
  assert.ok(Math.abs(alone.cost - 9) < 1e-9, "without the saved summary, all three replies are the fork's");
  assert.deepStrictEqual(alone.replyIds.sort(), ["msg_1", "msg_2", "msg_3"], "the summary remembers which replies it counted");
  const savedOwners = new Map([["msg_1", "claude-code:original"], ["msg_2", "claude-code:original"]]);
  fs.utimesSync(path.join(dir, "game", "fork.jsonl"), new Date(), new Date()); // a new read, not the cached one
  const fork = (await readClaudeCode(models, 0, { folder: dir, savedOwners }))[0];
  assert.ok(Math.abs(fork.cost - 3) < 1e-9, "with it, the copies are left out: only the fork's own reply");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("claude code deleted-original tests passed");
})().catch((e) => { console.error(e); process.exit(1); });

// OpenCode: the original was deleted in OpenCode, its saved summary remembers its replies' fingerprints,
// and the fork's copies of them don't count again.
(async () => {
  const { readOpenCode } = require("./history");
  const SQL = await require("sql.js")({ locateFile: (f) => path.join(path.dirname(require.resolve("sql.js")), f) });
  const oc = fs.mkdtempSync(path.join(os.tmpdir(), "ts-oc-gone-"));
  const T0 = Date.UTC(2026, 9, 19, 9, 0);
  const db = new SQL.Database();
  db.run("CREATE TABLE session (id TEXT, title TEXT, directory TEXT)");
  db.run("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
  db.run("INSERT INTO session VALUES ('fork', 'Loot (fork #1)', '/work/game')");
  const msg = (id, time, input) => JSON.stringify({ id, sessionID: "fork", role: "assistant", modelID: "claude-sonnet-5-5", tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: time } });
  db.run("INSERT INTO message VALUES ('c1', 'fork', ?)", [msg("c1", T0, 1e6)]); // copy of the deleted original's reply
  db.run("INSERT INTO message VALUES ('n1', 'fork', ?)", [msg("n1", T0 + 3600e3, 5e5)]); // the fork's own
  fs.writeFileSync(path.join(oc, "opencode.db"), Buffer.from(db.export()));
  const models = [{ id: "anthropic/claude-sonnet-5.5", inPerM: 2, outPerM: 10, cachedPerM: 0.2, cacheWritePerM: 2.5 }];
  const print = `oc|${T0}|claude-sonnet-5-5|1000000|0|0|0`;
  const [plain] = await readOpenCode(models, 0, { folder: oc });
  assert.ok(Math.abs(plain.cost - 3) < 1e-9 && plain.replyIds.includes(print), "without a saved summary both count, and the fingerprints are kept");
  const [fork] = await readOpenCode(models, 0, { folder: oc, savedOwners: new Map([[print, "opencode:original"]]) });
  assert.ok(Math.abs(fork.cost - 1) < 1e-9, "with it, only the fork's own reply counts");
  fs.rmSync(oc, { recursive: true, force: true });
  console.log("opencode deleted-original tests passed");
})().catch((e) => { console.error(e); process.exit(1); });

// OpenCode: a fork with nothing of its own yet is listed at $0, like OpenCode lists it.
(async () => {
  const { readOpenCode } = require("./history");
  const SQL = await require("sql.js")({ locateFile: (f) => path.join(path.dirname(require.resolve("sql.js")), f) });
  const oc = fs.mkdtempSync(path.join(os.tmpdir(), "ts-oc-zero-"));
  const T0 = Date.UTC(2026, 9, 19, 9, 0);
  const db = new SQL.Database();
  db.run("CREATE TABLE session (id TEXT, title TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, fork_session_id TEXT)");
  db.run("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
  db.run("INSERT INTO session VALUES ('main', 'Ladder plan', '/work/game', NULL, ?, NULL)", [T0 - 60e3]);
  db.run("INSERT INTO session VALUES ('fork', 'Ladder plan (fork #1)', '/work/game', NULL, ?, 'main')", [T0 + 600e3]);
  const msg = (id, session, time) => JSON.stringify({ id, sessionID: session, role: "assistant", modelID: "claude-sonnet-5-5", tokens: { input: 1e6, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: time } });
  db.run("INSERT INTO message VALUES ('m1', 'main', ?)", [msg("m1", "main", T0)]);
  db.run("INSERT INTO message VALUES ('c1', 'fork', ?)", [msg("c1", "fork", T0)]); // the fork's copy of m1
  // A fork from an older OpenCode (no fork link), with a reply of its own.
  db.run("INSERT INTO session VALUES ('old', 'Ladder plan (fork #2)', '/work/game', NULL, ?, NULL)", [T0 + 900e3]);
  db.run("INSERT INTO message VALUES ('c2', 'old', ?)", [msg("c2", "old", T0)]);
  db.run("INSERT INTO message VALUES ('n2', 'old', ?)", [msg("n2", "old", T0 + 1000e3)]);
  fs.writeFileSync(path.join(oc, "opencode.db"), Buffer.from(db.export()));
  const models = [{ id: "anthropic/claude-sonnet-5.5", inPerM: 2, outPerM: 10, cachedPerM: 0.2, cacheWritePerM: 2.5 }];
  const list = await readOpenCode(models, 0, { folder: oc });
  const main = list.find((c) => c.id === "opencode:main"), fork = list.find((c) => c.id === "opencode:fork");
  assert.ok(Math.abs(main.cost - 2) < 1e-9, "the original keeps its cost");
  assert.strictEqual(fork.cost, 0, "the fork is listed at $0");
  assert.strictEqual(fork.title, "Ladder plan (fork #1)");
  assert.deepStrictEqual(fork.fork, { of: "Ladder plan" });
  assert.strictEqual(fork.start, T0 + 600e3, "dated when it was forked");
  assert.ok(fork.copyOnly, "and never saved (see archive.js)");
  assert.ok(!main.fork, "the original isn't a fork");
  const old = list.find((c) => c.id === "opencode:old");
  assert.ok(Math.abs(old.cost - 2) < 1e-9 && !old.copyOnly, "a fork with work of its own counts only that");
  assert.deepStrictEqual(old.fork, { of: null }, "and is marked as a fork, also without OpenCode's fork link");
  assert.ok(!(await readOpenCode(models, T0 + 3600e3, { folder: oc })).some((c) => c.id === "opencode:fork" && c.title), "not listed when forked before the period shown");
  fs.rmSync(oc, { recursive: true, force: true });
  console.log("opencode $0 fork tests passed");
})().catch((e) => { console.error(e); process.exit(1); });

// OpenCode: a subagent is priced on the model it ran on, not the main conversation's.
(async () => {
  const { readOpenCode } = require("./history");
  const SQL = await require("sql.js")({ locateFile: (f) => path.join(path.dirname(require.resolve("sql.js")), f) });
  const oc = fs.mkdtempSync(path.join(os.tmpdir(), "ts-oc-submodel-"));
  const T0 = Date.UTC(2026, 9, 20, 9, 0);
  const db = new SQL.Database();
  db.run("CREATE TABLE session (id TEXT, title TEXT, directory TEXT, parent_id TEXT)");
  db.run("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
  db.run("INSERT INTO session VALUES ('q', 'Quest desync', '/work/game', NULL)");
  db.run("INSERT INTO session VALUES ('s', 'Find code (@searcher subagent)', '/work/game', 'q')");
  const msg = (id, session, model, time) => JSON.stringify({ id, sessionID: session, role: "assistant", modelID: model, tokens: { input: 1e6, output: 1e5, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: time } });
  db.run("INSERT INTO message VALUES ('m1', 'q', ?)", [msg("m1", "q", "claude-sonnet-5-5", T0)]);
  db.run("INSERT INTO message VALUES ('h1', 's', ?)", [msg("h1", "s", "claude-haiku-5-5", T0 + 1000)]);
  fs.writeFileSync(path.join(oc, "opencode.db"), Buffer.from(db.export()));
  const models = [
    { id: "anthropic/claude-sonnet-5.5", inPerM: 2, outPerM: 10, cachedPerM: 0.2, cacheWritePerM: 2.5 },
    { id: "anthropic/claude-haiku-5.5", inPerM: 0.1, outPerM: 0.5, cachedPerM: 0.01, cacheWritePerM: 0.125 },
  ];
  const [q] = await readOpenCode(models, 0, { folder: oc });
  const sonnet = 1 * 2 + 0.1 * 10, haiku = 1 * 0.1 + 0.1 * 0.5;
  assert.ok(Math.abs(q.helpers[0].cost - haiku) < 1e-9, "the subagent at Haiku's prices");
  assert.ok(Math.abs(q.cost - (sonnet + haiku)) < 1e-9, "the conversation: the main part at Sonnet's, the subagent at Haiku's");
  assert.deepStrictEqual(q.models.map((m) => [m.modelId, m.requests]).sort(), [["anthropic/claude-haiku-5.5", 1], ["anthropic/claude-sonnet-5.5", 1]]);
  fs.rmSync(oc, { recursive: true, force: true });
  console.log("opencode subagent model tests passed");
})().catch((e) => { console.error(e); process.exit(1); });

// OpenCode: why the cache expired, from when you wrote and which tools ran (like Claude Code).
(async () => {
  const { readOpenCode } = require("./history");
  const SQL = await require("sql.js")({ locateFile: (f) => path.join(path.dirname(require.resolve("sql.js")), f) });
  const oc = fs.mkdtempSync(path.join(os.tmpdir(), "ts-oc-why-"));
  const T0 = Date.UTC(2026, 9, 22, 9, 0), min = 60e3;
  const db = new SQL.Database();
  db.run("CREATE TABLE session (id TEXT, title TEXT, directory TEXT)");
  db.run("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
  db.run("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT)");
  db.run("INSERT INTO session VALUES ('s', 'Quest desync', '/work/game')");
  const reply = (id, t, input) => db.run("INSERT INTO message VALUES (?, 's', ?)", [id, JSON.stringify({ id, sessionID: "s", role: "assistant", modelID: "claude-sonnet-5-5", tokens: { input, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: t } })]);
  const user = (id, t) => db.run("INSERT INTO message VALUES (?, 's', ?)", [id, JSON.stringify({ id, sessionID: "s", role: "user", time: { created: t } })]);
  const tool = (id, msg, tool, input, start, end, output = "ok") => db.run("INSERT INTO part VALUES (?, ?, 's', ?)", [id, msg, JSON.stringify({ id, sessionID: "s", messageID: msg, type: "tool", tool, state: { status: "completed", input, output, time: { start, end } } })]);
  user("u1", T0 - min);
  reply("r1", T0, 50000);
  tool("p1", "r1", "bash", { command: "npm run build" }, T0 + 10e3, T0 + 10 * min, "x".repeat(40000)); // a 10 min build, big output
  reply("r2", T0 + 10 * min + 1e3, 52000); // the cache expired during the build
  user("u2", T0 + 30 * min);
  reply("r3", T0 + 31 * min, 54000); // ... while waiting for you
  reply("r4", T0 + 50 * min, 56000); // ... for no visible reason
  fs.writeFileSync(path.join(oc, "opencode.db"), Buffer.from(db.export()));
  const models = [{ id: "anthropic/claude-sonnet-5.5", inPerM: 2, outPerM: 10, cachedPerM: 0.2, cacheWritePerM: 2.5 }];
  const [c] = await readOpenCode(models, 0, { folder: oc });
  const d = c.insights.drivers;
  assert.ok(d.pausesTools > 0, "a build running");
  assert.ok(d.pausesYou > 0, "waiting for you");
  assert.ok(d.otherMisses > 0, "and unknown only when nothing explains it");
  assert.deepStrictEqual(c.insights.facts.cacheExpiries.map((e) => e.during), ["build", "user's reply", "unknown"]);
  assert.deepStrictEqual(c.insights.facts.toolUse, { edits: 0, reads: 0, builds: 1, tests: 0, other: 0 });
  assert.ok(d.bigOutputs > 0 && c.insights.facts.largeOutputs[0].tokens === 10000, "a large tool output re-read by later replies");
  assert.ok(!JSON.stringify(c).includes("npm run build"), "the command itself isn't kept");
  fs.rmSync(oc, { recursive: true, force: true });
  console.log("opencode cache expiry cause tests passed");
})().catch((e) => { console.error(e); process.exit(1); });

// Several forks: two forks of one original, a fork of a fork, and the original continued afterwards.
// Every reply counts once, where it happened. With and without OpenCode's fork link.
{
  const { dropForkCopies } = require("./history");
  const r = (id, session, time, out) => [id, { id, session, model: "m", time, tokens: { input: 100, output: out, read: 0, write: 0 } }];
  const build = () => new Map([
    r("o1", "main", 1000, 1), r("o2", "main", 2000, 2), r("o3", "main", 30000, 3), // o3: back in the original later
    r("a1", "forkA", 1000, 1), r("a2", "forkA", 2000, 2), r("a3", "forkA", 11000, 4), // forkA made at 10000
    r("b1", "forkB", 1000, 1), r("b2", "forkB", 2000, 2), r("b3", "forkB", 21000, 5), // forkB made at 20000
    r("c1", "forkC", 1000, 1), r("c2", "forkC", 2000, 2), r("c3", "forkC", 11000, 4), r("c4", "forkC", 26000, 6), // fork of forkA at 25000
  ]);
  const own = ["c4", "o1", "o2", "o3", "a3", "b3"].sort();
  const plain = build();
  dropForkCopies(plain, new Map([["main", { created: 900 }], ["forkA", { created: 10000 }], ["forkB", { created: 20000 }], ["forkC", { created: 25000 }]]));
  assert.deepStrictEqual([...plain.keys()].sort(), own, "copies by time and tokens");
  const linked = build();
  dropForkCopies(linked, new Map([["main", { created: 900 }], ["forkA", { created: 10000, forkOf: "main" }], ["forkB", { created: 20000, forkOf: "main" }], ["forkC", { created: 25000, forkOf: "forkA" }]]));
  assert.deepStrictEqual([...linked.keys()].sort(), own, "and by OpenCode's fork link");
  console.log("several forks tests passed");
}

// Claude Code: the same with reply ids, in four session files.
(async () => {
  const { readClaudeCode } = require("./history");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-cc-forks-"));
  fs.mkdirSync(path.join(dir, "p"));
  const at = (min) => new Date(Date.UTC(2026, 9, 19, 9, 0) + min * 60e3).toISOString();
  const reply = (id, min, sid) => JSON.stringify({ type: "assistant", timestamp: at(min), sessionId: sid, message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 1e6, output_tokens: 0 } } });
  const write = async (name, lines) => {
    fs.writeFileSync(path.join(dir, "p", `${name}.jsonl`), lines.join("\n") + "\n");
    await new Promise((res) => setTimeout(res, 30)); // created one after the other
  };
  await write("main", [reply("m1", 1, "main"), reply("m2", 2, "main"), reply("m9", 90, "main")]);
  await write("forkA", [reply("m1", 1, "forkA"), reply("m2", 2, "forkA"), reply("a1", 20, "forkA")]);
  await write("forkB", [reply("m1", 1, "forkB"), reply("m2", 2, "forkB"), reply("b1", 40, "forkB")]);
  await write("forkC", [reply("m1", 1, "forkC"), reply("m2", 2, "forkC"), reply("a1", 20, "forkC"), reply("c1", 60, "forkC")]);
  const models = [{ id: "anthropic/claude-sonnet-5.5", inPerM: 2, outPerM: 10, cachedPerM: 0.2, cacheWritePerM: 2.5 }];
  const cost = Object.fromEntries((await readClaudeCode(models, 0, { folder: dir })).map((c) => [c.id.replace("claude-code:", ""), Math.round(c.cost)]));
  assert.deepStrictEqual(cost, { main: 6, forkA: 2, forkB: 2, forkC: 2 }, "each reply counted once: 3 in main, 1 in each fork");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("claude code several forks tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
