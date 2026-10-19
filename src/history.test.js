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
  fs.writeFileSync(path.join(oc, "opencode.db"), Buffer.from(db.export()));
  fs.mkdirSync(path.join(oc, "storage", "message", "s1"), { recursive: true });
  fs.writeFileSync(path.join(oc, "storage", "message", "s1", "m3.json"), msg("m3", "s1", "claude-sonnet-5-5", tok(0, 0, 1e6, 1e6), T + 120e3));
  fs.writeFileSync(path.join(oc, "storage", "message", "s1", "m4.json"), msg("m4", "s1", "my-local-model", tok(5e5, 5e5, 0, 0), T + 180e3, { cost: 0.42 }));

  let checks = createChecks();
  const oconv = await readOpenCode(models, 0, { folder: oc, checks });
  const s1 = oconv.find((c) => c.id === "opencode:s1"), s2 = oconv.find((c) => c.id === "opencode:s2");
  assert.strictEqual(oconv.length, 2, "two conversations");
  assert.strictEqual(s1.title, "Fix the loot table");
  assert.strictEqual(s1.project, "game");
  assert.ok(s2.archived && !s1.archived, "archived in OpenCode");
  assert.strictEqual(Number(s1.cost.toFixed(4)), 3 + 2.7 + 0.42, "each message counted once; OpenCode's own cost for unpriced models");
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
