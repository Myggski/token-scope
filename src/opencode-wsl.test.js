// Checks real job costs from OpenCode's records (database and JSON storage), and finding the
// home folders inside WSL.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { findOpenCodeActuals, readOpenCode } = require("./history");
const { wslHomes, runningDistros } = require("./wsl");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ts-oc-wsl-"));
const models = [{ id: "openai/gpt-5.5", inPerM: 5, outPerM: 30, cachedPerM: 0.5, cacheWritePerM: null }];
const T = Date.UTC(2026, 9, 10, 9, 0);
const min = (m) => T + m * 60e3;

(async () => {
  // ---------- OpenCode: database with message and part tables (1.x) ----------
  const oc = path.join(tmp, "opencode");
  fs.mkdirSync(oc);
  const SQL = await require("sql.js")({ locateFile: (f) => path.join(path.dirname(require.resolve("sql.js")), f) });
  const db = new SQL.Database();
  db.run("CREATE TABLE session (id TEXT, title TEXT, directory TEXT)");
  db.run("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
  db.run("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT)");
  db.run("INSERT INTO session VALUES ('ses1', 'Loot table', '/work/game')");
  const reply = (id, minute, input, output) => db.run("INSERT INTO message VALUES (?, 'ses1', ?)", [id, JSON.stringify({ id, sessionID: "ses1", role: "assistant", modelID: "gpt-5.5", providerID: "openai", tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: min(minute) } })]);
  reply("m1", 1, 10000, 1000); // before the job: $0.08
  reply("m2", 3, 20000, 1000); // the job: $0.13
  reply("m3", 5, 30000, 1000); // the job: $0.18
  reply("m4", 9, 40000, 1000); // after another job started
  // The estimate_plan result, as an OpenCode tool part (time in state.time).
  db.run("INSERT INTO part VALUES ('p1', 'm1', 'ses1', ?)", [JSON.stringify({ id: "p1", messageID: "m1", sessionID: "ses1", type: "tool", tool: "tokenscope_estimate_plan", state: { status: "completed", output: '{"job_id": "job-aaaaaaaa11"}', time: { start: min(2), end: min(2) } } })]);
  db.run("INSERT INTO part VALUES ('p2', 'm3', 'ses1', ?)", [JSON.stringify({ id: "p2", messageID: "m3", sessionID: "ses1", type: "tool", tool: "tokenscope_estimate_plan", state: { status: "completed", output: '{"job_id": "job-bbbbbbbb22"}', time: { start: min(8), end: min(8) } } })]);
  fs.writeFileSync(path.join(oc, "opencode.db"), Buffer.from(db.export()));

  const job = { id: "job-aaaaaaaa11", createdAt: new Date(min(2)).toISOString(), estimates: {} };
  let a = (await findOpenCodeActuals([job], models, { folder: oc, now: min(120) }))[job.id].actual;
  assert.strictEqual(a.source, "opencode");
  assert.strictEqual(a.costUsd, 0.31, "from the job id until another job starts in the session");
  assert.strictEqual(a.status, "done");
  assert.strictEqual(a.modelId, "openai/gpt-5.5");
  assert.strictEqual(a.sessionId, "ses1");
  // finish_job ends it earlier.
  a = (await findOpenCodeActuals([{ ...job, endedAt: new Date(min(4)).toISOString() }], models, { folder: oc, now: min(120) }))[job.id].actual;
  assert.strictEqual(a.costUsd, 0.13);
  // Still going: no end yet and recent replies.
  a = (await findOpenCodeActuals([{ ...job, id: "job-bbbbbbbb22" }], models, { folder: oc, now: min(10) }))["job-bbbbbbbb22"].actual;
  assert.strictEqual(a.status, "running");
  // A cost measured exactly elsewhere isn't looked at again.
  assert.deepStrictEqual(await findOpenCodeActuals([{ ...job, actual: { source: "claude-code", status: "done" } }], models, { folder: oc, now: min(120) }), {});
  // History lists the jobs in the conversation.
  const [conv] = await readOpenCode(models, 0, { folder: oc });
  assert.deepStrictEqual(conv.jobIds.sort(), ["job-aaaaaaaa11", "job-bbbbbbbb22"]);

  // ---------- OpenCode: JSON storage (part files, time from the message) ----------
  const js = path.join(tmp, "opencode-json");
  fs.mkdirSync(path.join(js, "storage", "message", "ses2"), { recursive: true });
  fs.mkdirSync(path.join(js, "storage", "part", "n1"), { recursive: true });
  const msg = (id, minute, input) => fs.writeFileSync(path.join(js, "storage", "message", "ses2", `${id}.json`), JSON.stringify({ id, sessionID: "ses2", role: "assistant", modelID: "gpt-5.5", tokens: { input, output: 0, cache: { read: 0, write: 0 } }, time: { created: min(minute) } }));
  msg("n1", 1, 1000);
  msg("n2", 2, 2000); // $0.01
  fs.writeFileSync(path.join(js, "storage", "part", "n1", "q1.json"), JSON.stringify({ id: "q1", messageID: "n1", sessionID: "ses2", type: "tool", state: { output: "job_id: job-cccccccc33" } }));
  a = (await findOpenCodeActuals([{ id: "job-cccccccc33", createdAt: new Date(min(1)).toISOString() }], models, { folder: js, now: min(120) }))["job-cccccccc33"].actual;
  assert.strictEqual(a.costUsd, 0.015, "starts at the message the part belongs to");

  // ---------- WSL ----------
  const utf16 = Buffer.from("﻿Ubuntu\r\nDebian\r\n", "utf16le");
  assert.deepStrictEqual(runningDistros(() => utf16), ["Ubuntu", "Debian"], "wsl.exe answers in UTF-16");
  assert.deepStrictEqual(runningDistros(() => { throw new Error("no wsl"); }), []);
  const root = path.join(tmp, "wsl");
  fs.mkdirSync(path.join(root, "Ubuntu", "home", "tomas", ".claude", "projects"), { recursive: true });
  fs.mkdirSync(path.join(root, "Ubuntu", "root"), { recursive: true });
  fs.mkdirSync(path.join(root, "Debian", "home"), { recursive: true });
  const homes = wslHomes({ run: () => utf16, root });
  assert.deepStrictEqual(homes.map((h) => path.relative(root, h)).sort(), [path.join("Ubuntu", "home", "tomas"), path.join("Ubuntu", "root")]);
  assert.deepStrictEqual(wslHomes({ platform: "linux" }), [], "only looked for on Windows");

  fs.rmSync(tmp, { recursive: true });
  console.log("opencode job and wsl tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
