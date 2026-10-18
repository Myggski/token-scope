// Checks the Cursor hook in the ways Cursor might run it differently from a hand test: input that
// stays open, UTF-8 with a byte-order mark, UTF-16, renamed steps, and a folder it can't write to.
// Problems must end up in hooks/cursor-hook-problems.log instead of being hidden.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ts-hook-"));
const data = path.join(tmp, "TokenScope");
const records = path.join(data, "history", "cursor");
const problems = path.join(data, "hooks", "cursor-hook-problems.log");
const hook = path.join(__dirname, "cursor-hook.js");
const step = (extra = {}) => ({ hook_event_name: "afterAgentResponse", conversation_id: "c1", generation_id: "g1", model: "claude-sonnet-5-5", text: "hello", ...extra });

// Runs the hook like Cursor would. keepOpen: don't close its input (it must not wait for that).
function run(input, { keepOpen = false, folder = records } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [hook, folder], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code, out: out.trim(), err, ms: Date.now() - started }));
    child.stdin.write(input);
    if (!keepOpen) child.stdin.end();
  });
}
const saved = () => {
  try {
    return fs.readdirSync(records).flatMap((n) => fs.readFileSync(path.join(records, n), "utf8").trim().split("\n")).filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const lastProblem = () => JSON.parse(fs.readFileSync(problems, "utf8").trim().split("\n").pop());

(async () => {
  let r = await run(JSON.stringify(step()));
  assert.deepStrictEqual([r.code, r.out], [0, "{}"]);
  assert.strictEqual(saved().length, 1, "a normal step is saved");

  r = await run(JSON.stringify(step({ generation_id: "g2" })), { keepOpen: true });
  assert.strictEqual(r.out, "{}");
  assert.ok(r.ms < 2500, `doesn't wait for Cursor to close the input (took ${r.ms} ms)`);
  assert.strictEqual(saved().length, 2, "saved although the input stayed open");

  await run("﻿" + JSON.stringify(step({ generation_id: "g3" })));
  assert.strictEqual(saved().length, 3, "a UTF-8 byte-order mark is fine");

  await run(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(step({ generation_id: "g4" })), "utf16le")]));
  await run(Buffer.from(JSON.stringify(step({ generation_id: "g5" })), "utf16le"));
  assert.strictEqual(saved().length, 5, "UTF-16, with or without its mark, is fine");
  assert.ok(!fs.existsSync(problems), "no problems so far");

  r = await run("not json");
  assert.strictEqual(r.out, "{}", "still answers Cursor");
  assert.match(lastProblem().problem, /couldn't read Cursor's step/);
  assert.match(r.err, /TokenScope hook/, "and says so where Cursor shows hook output");

  const name = `renamedStep${Date.now()}`;
  await run(JSON.stringify(step({ hook_event_name: name })));
  assert.match(lastProblem().problem, new RegExp(name), "a step TokenScope doesn't know is noted");
  assert.ok(lastProblem().fields.includes("conversation_id"), "with the field names, not their content");
  assert.ok(!fs.readFileSync(problems, "utf8").includes("hello"), "never the content");
  const before = fs.readFileSync(problems, "utf8").split("\n").length;
  await run(JSON.stringify(step({ hook_event_name: name })));
  assert.strictEqual(fs.readFileSync(problems, "utf8").split("\n").length, before, "only once per name and day");

  await run(JSON.stringify(step({ hook_event_name: "postToolUse", tool_name: "read_file" })), { folder: problems }); // a file, not a folder
  assert.match(lastProblem().problem, /couldn't save the record/);

  fs.rmSync(tmp, { recursive: true });
  for (const n of fs.readdirSync(os.tmpdir())) if (n.includes(name)) fs.rmSync(path.join(os.tmpdir(), n), { force: true });
  console.log("cursor hook tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
