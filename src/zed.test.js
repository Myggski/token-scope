// Checks reading Zed's agent threads (threads/threads.db) in the shape Zed writes them (crates/agent/src/db.rs,
// Oct 2026): a row per thread with the thread as zstd-compressed JSON, holding the exact token totals.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { readZed, findZedActuals } = require("./history");
const { loadZedThreads } = require("./zed");

if (typeof zlib.zstdCompressSync !== "function") {
  console.log("zed tests skipped (this Node.js can't write zstd)");
  process.exit(0);
}

const models = [
  { id: "anthropic/claude-sonnet-5.5", inPerM: 2, outPerM: 10, cachedPerM: 0.2, cacheWritePerM: 2.5 },
  { id: "anthropic/claude-haiku-5.5", inPerM: 1, outPerM: 5, cachedPerM: 0.1, cacheWritePerM: 1.25 },
];
const T = Date.UTC(2026, 9, 19, 9, 0);
const iso = (min) => new Date(T + min * 60e3).toISOString();

(async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ts-zed-"));
  fs.mkdirSync(path.join(folder, "threads"));
  const SQL = await require("sql.js")({ locateFile: (f) => path.join(path.dirname(require.resolve("sql.js")), f) });
  const db = new SQL.Database();
  db.run(`CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL,
    parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT)`);
  const thread = (id, { title, parent = null, start, end, usage, model = "claude-sonnet-5-5", extra = {}, json = false }) => {
    const data = JSON.stringify({ title, messages: [{ text: "secret" }], updated_at: iso(end), cumulative_token_usage: usage, request_token_usage: {}, model: { provider: "anthropic", model }, ...extra });
    db.run("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, title, iso(end), json ? "json" : "zstd",
      json ? Buffer.from(data) : zlib.zstdCompressSync(Buffer.from(data)), parent, "C:\\work\\game", "0", iso(start)]);
  };
  // A conversation that made a plan (its id in a tool result), and a subagent it started.
  thread("t1", { title: "Fix the inventory", start: 0, end: 40, usage: { input_tokens: 1000, output_tokens: 20000, cache_creation_input_tokens: 100000, cache_read_input_tokens: 2000000 },
    extra: { messages: [{ tool_result: JSON.stringify({ job_id: "job-zedzedzed01" }) }] } });
  thread("t2", { title: "Review (@reviewer)", parent: "t1", start: 10, end: 12, usage: { input_tokens: 500, output_tokens: 1000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 50000 }, model: "claude-haiku-5-5" });
  // An older thread saved as plain JSON, with per-request usage instead of a total.
  db.run("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["t3", "Old thread", iso(-600), "json",
    Buffer.from(JSON.stringify({ title: "Old thread", messages: [], request_token_usage: [{ input_tokens: 100, output_tokens: 100 }, { input_tokens: 200, output_tokens: 50 }], model: { provider: "anthropic", model: "claude-sonnet-5-5" } })), null, null, null, null]);
  // A thread with no tokens yet (just opened): left out.
  thread("t4", { title: "Empty", start: 50, end: 50, usage: {} });
  fs.writeFileSync(path.join(folder, "threads", "threads.db"), Buffer.from(db.export()));

  const threads = await loadZedThreads(folder);
  assert.deepStrictEqual(threads.map((t) => t.id).sort(), ["t1", "t2", "t3"]);
  assert.ok(!JSON.stringify(threads).includes("secret"), "no message content kept");

  const list = await readZed(models, 0, { folder });
  assert.strictEqual(list.length, 2, "the subagent is part of the conversation that started it");
  const main = list.find((c) => c.id === "zed:t1");
  const sonnet = (1000 * 2 + 20000 * 10 + 100000 * 2.5 + 2000000 * 0.2) / 1e6;
  const haiku = (500 * 1 + 1000 * 5 + 10000 * 1.25 + 50000 * 0.1) / 1e6;
  assert.ok(Math.abs(main.cost - (sonnet + haiku)) < 1e-9, "exact, from Zed's own totals, subagent included");
  assert.deepStrictEqual(main.helpers.map((h) => h.title), ["Review (@reviewer)"]);
  assert.ok(Math.abs(main.helpers[0].cost - haiku) < 1e-9);
  assert.deepStrictEqual(main.helpers[0].models.map((m) => m.modelId), ["anthropic/claude-haiku-5.5"], "the model the subagent ran on");
  assert.deepStrictEqual(main.includes, ["zed:t2"]);
  assert.strictEqual(main.project, "game");
  assert.strictEqual(main.totalsOnly, true, "Spending says there's no breakdown");
  assert.strictEqual(main.insights, null);
  assert.deepStrictEqual(main.jobIds, ["job-zedzedzed01"]);
  assert.strictEqual(main.start, T);
  const old = list.find((c) => c.id === "zed:t3");
  assert.ok(Math.abs(old.cost - (300 * 2 + 150 * 10) / 1e6) < 1e-12, "older threads: per-request usage added up");
  assert.deepStrictEqual((await readZed(models, T, { folder })).map((c) => c.id), ["zed:t1"], "only conversations active since");

  // The plan made in t1 costs the whole chat (Zed keeps one total), exactly.
  const job = { id: "job-zedzedzed01", createdAt: iso(5), client: "zed", endedAt: iso(39), plan: { steps: 10, startContext: 1000, contextPerStep: 1000, outputPerStep: 100 }, estimates: {} };
  const change = (await findZedActuals([job], models, { folder, now: T + 3600e3 }))[job.id];
  assert.ok(change && Math.abs(change.actual.costUsd - Number((sonnet + haiku).toFixed(4))) < 1e-9);
  assert.strictEqual(change.actual.wholeChat, true);
  assert.strictEqual(change.actual.source, "zed");
  assert.strictEqual(change.actual.status, "done");
  assert.deepStrictEqual(await findZedActuals([{ ...job, id: "job-elsewhere01" }], models, { folder, now: T + 3600e3 }), {}, "plans made elsewhere aren't touched");
  assert.deepStrictEqual(await readZed(models, 0, { folder: path.join(folder, "missing") }), [], "no Zed: nothing");

  // Format checks: a changed database shows a warning instead of quietly missing costs.
  const { createChecks } = require("./checks");
  const warn = async (setup) => {
    const f = fs.mkdtempSync(path.join(os.tmpdir(), "ts-zed-check-"));
    fs.mkdirSync(path.join(f, "threads"));
    const d = new SQL.Database();
    setup(d);
    fs.writeFileSync(path.join(f, "threads", "threads.db"), Buffer.from(d.export()));
    const checks = createChecks();
    await readZed(models, 0, { folder: f, checks });
    fs.rmSync(f, { recursive: true, force: true });
    return checks.list().map((c) => c.message).join(" ");
  };
  assert.strictEqual(await warn(() => {}), "", "an empty database (Zed not used yet) is fine");
  assert.match(await warn((d) => d.run("CREATE TABLE conversations (id TEXT)")), /Zed data mismatch.*table/);
  assert.match(await warn((d) => d.run("CREATE TABLE threads (id TEXT, payload BLOB)")), /stored differently/);
  assert.match(await warn((d) => {
    d.run("CREATE TABLE threads (id TEXT, summary TEXT, updated_at TEXT, data_type TEXT, data BLOB)");
    for (const id of ["a", "b", "c"]) d.run("INSERT INTO threads VALUES (?, 'x', ?, 'zstd', ?)", [id, iso(0), Buffer.from("not zstd")]);
  }), /couldn't be read/);
  assert.match(await warn((d) => {
    d.run("CREATE TABLE threads (id TEXT, summary TEXT, updated_at TEXT, data_type TEXT, data BLOB)");
    for (const id of ["a", "b", "c"]) d.run("INSERT INTO threads VALUES (?, 'x', ?, 'json', ?)", [id, iso(0), Buffer.from(JSON.stringify({ messages: [1, 2, 3], tokens_used: 5 }))]);
  }), /no longer have token counts/);

  fs.rmSync(folder, { recursive: true, force: true });
  console.log("zed tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
