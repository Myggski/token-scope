// Checks the Codex reader with made-up logs in the format Codex writes (as of Codex CLI 0.14x):
// token counts, repeats, speed tiers, compactions, copied history in forks and subagents,
// plain and Zstandard logs, archived copies, job costs and the format check.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { readCodex } = require("./history");
const { findCodexActuals, listRollouts, parseRollout } = require("./codexlogs");
const { createChecks } = require("./checks");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ts-codex-"));
const models = [{ id: "openai/gpt-5.5", inPerM: 5, outPerM: 30, cachedPerM: 0.5, cacheWritePerM: null }];
const T = Date.UTC(2026, 9, 10, 9, 0);
const at = (minutes) => new Date(T + minutes * 60e3).toISOString();
const line = (minutes, type, payload) => JSON.stringify({ timestamp: at(minutes), type, payload });

// A writer that keeps the running totals Codex records next to each request.
function log() {
  const lines = [];
  let total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  return {
    lines,
    add: (minutes, type, payload) => lines.push(line(minutes, type, payload)),
    raw: (text) => lines.push(text),
    tokens(minutes, input, cached, output, reasoning = 0) {
      const last = { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output };
      total = Object.fromEntries(Object.keys(total).map((k) => [k, total[k] + last[k]]));
      lines.push(line(minutes, "event_msg", { type: "token_count", info: { last_token_usage: last, total_token_usage: { ...total }, model_context_window: 400000 }, rate_limits: {} }));
    },
    repeat(minutes) {
      // Codex sometimes records the same totals again (for example with a rate-limit update).
      lines.push(line(minutes, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }, total_token_usage: { ...total } } }));
    },
    text: () => lines.join("\n") + "\n",
  };
}

const home = path.join(tmp, "codex");
const day = path.join(home, "sessions", "2026", "10", "10");
fs.mkdirSync(day, { recursive: true });
fs.mkdirSync(path.join(home, "archived_sessions"), { recursive: true });

(async () => {
  // ---------- The main conversation ----------
  const parent = log();
  parent.add(0, "session_meta", { id: "parent-1", timestamp: at(0), cwd: "/work/game", originator: "codex_cli_rs", cli_version: "0.144.0" });
  parent.add(0, "turn_context", { cwd: "/work/game", model: "gpt-5.5" });
  parent.add(0, "event_msg", { type: "user_message", message: "Speed up the loot table\nmore details" });
  parent.add(0.1, "event_msg", { type: "token_count", info: null, rate_limits: {} }); // rate limits only
  parent.tokens(1, 10000, 0, 1000, 400); // $0.08
  parent.add(1.1, "response_item", { type: "function_call", name: "mcp__tokenscope__estimate_plan", arguments: "{}", call_id: "c1" });
  parent.add(1.2, "response_item", { type: "function_call_output", call_id: "c1", output: '{"job_id":"job-aaaaaaaa11"}' });
  parent.add(1.3, "response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "npm run build"] }), call_id: "c2" });
  parent.add(4.3, "response_item", { type: "function_call_output", call_id: "c2", output: "x".repeat(40000) });
  parent.add(4.4, "response_item", { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch", call_id: "c3" });
  parent.add(4.5, "response_item", { type: "custom_tool_call_output", call_id: "c3", output: "Done" });
  parent.add(4.6, "response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "sed -n 1,200p src/loot.cpp" }), call_id: "c4" });
  parent.add(4.7, "response_item", { type: "function_call_output", call_id: "c4", output: "..." });
  parent.add(4.8, "response_item", { type: "message", role: "assistant", content: [] });
  parent.tokens(5, 20000, 15000, 2000); // $0.0925
  parent.repeat(5.1); // skipped: the totals didn't move
  parent.add(6, "event_msg", { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } });
  parent.tokens(7, 30000, 25000, 1000); // $0.0675 x2 = $0.135
  // A remote compaction: only its own record, counted. 40000 in, 500 out, fast: $0.43
  parent.add(20, "token_usage_record", { response_id: "resp-remote", usage: { input_tokens: 40000, output_tokens: 500 } });
  parent.add(20, "compacted", { compaction_response_id: "resp-remote" });
  // A local compaction: the record, a token_count with the same request, then the marker. Counted once: $0.056
  parent.add(30, "token_usage_record", { response_id: "resp-local", usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 100 } });
  parent.tokens(30, 5000, 0, 100);
  parent.add(30, "compacted", { compaction_response_id: "resp-local" });
  // A record without a marker isn't a finished compaction, so it isn't counted.
  parent.add(31, "token_usage_record", { response_id: "resp-lost", usage: { input_tokens: 99999, output_tokens: 99999 } });
  const parentFile = path.join(day, "rollout-2026-10-10T09-00-00-parent-1.jsonl");
  fs.writeFileSync(parentFile, parent.text());
  // The same log also compressed, and archived: both ignored.
  fs.writeFileSync(parentFile + ".zst", zlib.zstdCompressSync(Buffer.from(parent.text())));
  fs.writeFileSync(path.join(home, "archived_sessions", path.basename(parentFile)), parent.text());

  // ---------- A fork of it: starts with a copy of the parent's first three requests ----------
  const fork = log();
  fork.add(10, "session_meta", { id: "fork-1", forked_from_id: "parent-1", timestamp: at(10), cwd: "/work/game" });
  fork.add(10, "session_meta", { id: "parent-1", timestamp: at(0), cwd: "/work/game" }); // copied
  fork.add(10, "turn_context", { model: "gpt-5.5" });
  fork.tokens(10, 10000, 0, 1000, 400);
  fork.tokens(10, 20000, 15000, 2000);
  fork.tokens(10, 30000, 25000, 1000);
  fork.add(10, "response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "npm run build"] }), call_id: "c2" });
  fork.add(10, "response_item", { type: "function_call_output", call_id: "c2", output: "copied" });
  fork.add(11, "event_msg", { type: "user_message", message: "Try another way" });
  fork.tokens(12, 50000, 40000, 1000); // its own: $0.10
  fs.writeFileSync(path.join(day, "rollout-2026-10-10T09-10-00-fork-1.jsonl"), fork.text());

  // ---------- A fork whose parent log is gone: the copied burst is skipped ----------
  const orphan = log();
  orphan.add(40, "session_meta", { id: "orphan-1", forked_from_id: "deleted-1", timestamp: at(40), cwd: "/work/tools" });
  orphan.add(40, "turn_context", { model: "gpt-5.5" });
  orphan.tokens(40, 8000, 0, 800);
  orphan.tokens(40, 9000, 8000, 900);
  orphan.tokens(41, 1000, 0, 100); // its own: $0.008
  fs.writeFileSync(path.join(day, "rollout-2026-10-10T09-40-00-orphan-1.jsonl"), orphan.text());

  // ---------- A subagent the main conversation started: added to it ----------
  const helper = log();
  helper.add(2, "session_meta", { id: "helper-1", timestamp: at(2), source: { subagent: { thread_spawn: { parent_thread_id: "parent-1", depth: 1 } } } });
  helper.add(2, "turn_context", { model: "gpt-5.5" });
  helper.tokens(2, 10000, 0, 1000, 400); // copied from the parent
  helper.add(2.5, "event_msg", { type: "task_started" });
  helper.tokens(3, 2000, 0, 200); // its own: $0.016
  fs.writeFileSync(path.join(day, "rollout-2026-10-10T09-02-00-helper-1.jsonl"), helper.text());

  // ---------- A compressed log (newer Codex builds), read with the plain-JavaScript decoder ----------
  const packed = log();
  packed.add(50, "session_meta", { id: "packed-1", timestamp: at(50), cwd: "/work/web" });
  packed.add(50, "turn_context", { model: "gpt-5.5" });
  packed.tokens(51, 1000, 0, 0); // $0.005
  fs.writeFileSync(path.join(day, "rollout-2026-10-10T09-50-00-packed-1.jsonl.zst"), zlib.zstdCompressSync(Buffer.from(packed.text())));

  const files = await listRollouts(home);
  assert.strictEqual(files.length, 5, "plain copy wins over .zst, sessions/ over archived_sessions/");
  assert.ok(files.every((f) => !f.file.includes("archived")));

  const checks = createChecks();
  const list = await readCodex(models, 0, { home, checks, zstd: { forceJs: true } });
  const byId = Object.fromEntries(list.map((c) => [c.id, c]));
  assert.deepStrictEqual(Object.keys(byId).sort(), ["codex:fork-1", "codex:orphan-1", "codex:packed-1", "codex:parent-1"], "the subagent is part of its parent");
  const money = (v) => Number(v.toFixed(4));

  const p = byId["codex:parent-1"];
  assert.strictEqual(p.title, "Speed up the loot table", "first line of the first message");
  assert.strictEqual(p.project, "game");
  assert.strictEqual(money(p.cost), money(0.08 + 0.0925 + 0.135 + 0.43 + 0.056 + 0.016), "requests, fast tier x2, compactions once, subagent added");
  assert.deepStrictEqual(p.models.map((m) => [m.model, m.tier || null, m.requests]).sort(), [["gpt-5.5 (fast)", "fast", 3], ["gpt-5.5", null, 3]]);
  assert.strictEqual(p.models[0].modelId, "openai/gpt-5.5");
  assert.deepStrictEqual(p.jobIds, ["job-aaaaaaaa11"]);
  assert.strictEqual(p.insights.facts.helperCost, 0.016);
  assert.deepStrictEqual(p.insights.facts.toolUse, { edits: 1, reads: 1, builds: 1, tests: 0, other: 1 }, "estimate_plan is other, apply_patch an edit, sed a read, npm run build a build");
  assert.strictEqual(p.insights.facts.largeOutputsCount, 1, "the 10k-token build output");
  assert.strictEqual(p.insights.facts.buildAndTestMinutes, 3);

  assert.strictEqual(money(byId["codex:fork-1"].cost), 0.1, "the copied history isn't counted again");
  assert.strictEqual(byId["codex:fork-1"].insights.facts.toolUse.builds, 0, "nor its copied tool calls");
  assert.strictEqual(money(byId["codex:orphan-1"].cost), 0.008, "without the parent, the copied burst is skipped");
  assert.strictEqual(money(byId["codex:packed-1"].cost), 0.005, ".jsonl.zst read");
  assert.deepStrictEqual(checks.list(), [], "no warnings for the expected format");

  // Node's own decoder gives the same.
  const native = await parseRollout(path.join(day, "rollout-2026-10-10T09-50-00-packed-1.jsonl.zst"));
  assert.strictEqual(native.events.length, 1);

  // A speed tier set in config.toml applies to logs that don't say, and session_index.jsonl names conversations.
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "gpt-5.5"\nservice_tier = "flex"\n[profiles.fast]\nservice_tier = "priority"\n');
  fs.writeFileSync(path.join(home, "session_index.jsonl"), JSON.stringify({ id: "packed-1", thread_name: "Landing page", updated_at: at(51) }) + "\n");
  const again = await readCodex(models, 0, { home, zstd: { forceJs: true } });
  const packedAgain = again.find((c) => c.id === "codex:packed-1");
  assert.strictEqual(money(packedAgain.cost), 0.0025, "flex costs half");
  assert.strictEqual(packedAgain.title, "Landing page");
  fs.rmSync(path.join(home, "config.toml"));

  // Only conversations since the given time.
  assert.deepStrictEqual((await readCodex(models, Date.parse(at(45)), { home })).map((c) => c.id), ["codex:packed-1"]);

  // ---------- Real job costs ----------
  const job = { id: "job-aaaaaaaa11", createdAt: at(0), endedAt: at(10), plan: null, estimates: {} };
  const changes = await findCodexActuals([job], models, { home, now: T + 3600e3 });
  const a = changes[job.id].actual;
  assert.strictEqual(a.source, "codex");
  assert.strictEqual(a.costUsd, money(0.0925 + 0.135 + 0.016), "from the job id until finish_job, its subagent included");
  assert.strictEqual(a.status, "done");
  assert.strictEqual(a.modelId, "openai/gpt-5.5");
  assert.strictEqual(a.sessionId, "parent-1");
  // A job with an exact Claude Code cost is left alone; an AI-reported one is replaced.
  assert.deepStrictEqual(await findCodexActuals([{ ...job, actual: { source: "claude-code", status: "done", lastActivity: at(5) } }], models, { home, now: T + 4 * 86400e3 }), {});
  assert.ok((await findCodexActuals([{ ...job, actual: { source: "ai", costUsd: 1 } }], models, { home, now: T + 3600e3 }))[job.id]);

  // ---------- Codex changed its format ----------
  const odd = path.join(tmp, "codex-odd", "sessions");
  fs.mkdirSync(odd, { recursive: true });
  const changedLog = [line(0, "session_meta", { id: "odd" })];
  for (let i = 0; i < 12; i++) changedLog.push(line(i, "event_msg", { type: "token_count", info: { usage_v2: { in: 5 } } }));
  fs.writeFileSync(path.join(odd, "rollout-odd.jsonl"), changedLog.join("\n"));
  const oddChecks = createChecks();
  await readCodex(models, 0, { home: path.dirname(odd), checks: oddChecks });
  assert.match(oddChecks.list()[0].message, /^Codex data mismatch, probably due to a Codex update/);

  // A broken .zst file doesn't stop the others from being read.
  fs.writeFileSync(path.join(day, "rollout-broken.jsonl.zst"), "not zstd");
  assert.strictEqual((await readCodex(models, 0, { home, zstd: { forceJs: true } })).length, 4);

  fs.rmSync(tmp, { recursive: true });
  console.log("codex log tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
