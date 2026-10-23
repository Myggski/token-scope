// What happened in a conversation, cost-wise: facts only, no advice. The app shows the cost
// breakdown; the AI reads the facts through MCP (get_history) and makes the suggestions.
// Works on a timeline every reader builds from its tool's records:
//   requests: [{ t, model (priced, or null), name (the model as the tool wrote it), agent (OpenCode),
//                context, fresh, cached, output, cost,
//                pause: { ms, who: "you" | "tool" | "unknown", kind: "build" | "test" | "other" | null } }]
//   tools:    [{ t, after (index of the request that asked for it), kind: "edit" | "read" | "build" | "test" | "other",
//                tool, file, ms, outTokens }]
//   cacheMinutes: how long the provider keeps the cache (5 at most providers, 60 in Claude Code)
// Everything is local arithmetic: nothing is sent anywhere.

const BUILD = /\b(msbuild|cmake\s+--build|make(\s|$)|ninja|gradlew?\s|mvn\s|cargo\s+build|dotnet\s+build|(npm|yarn|pnpm)\s+(run\s+)?build|tsc(\s|$)|webpack|vite\s+build|go\s+build|build\.(bat|sh|cmd)|unrealbuildtool|\bubt\b|runuat|xcodebuild|bazel\s+build|electron-builder|compile)/i;
const TEST = /\b((npm|yarn|pnpm)\s+(run\s+)?test|pytest|jest|vitest|cargo\s+test|dotnet\s+test|go\s+test|ctest|gradlew?\s+test|mvn\s+test|phpunit|rspec|mocha|\.test\.js)/i;

// What kind of command a shell call was. Only the kind is kept, never the command.
function commandKind(command) {
  const c = String(command || "");
  if (TEST.test(c)) return "test";
  if (BUILD.test(c)) return "build";
  return "other";
}

// A compaction: the context drops to under 75% of what it was, from at least 10k tokens.
const COMPACTED_FROM = 10000, COMPACTED_TO = 0.75;

// A step that reads more than this costs more for its size (Patterns' "Long conversations").
const LONG_STEP_TOKENS = 100000;

const perM = (tokens, price) => (tokens * price) / 1e6;
const round = (v, d = 4) => Number(v.toFixed(d));
const cachedPrice = (m) => (m ? m.cachedPerM ?? m.inPerM : 0);

// The extra cost of one token re-read at full price instead of from the cache.
function missPrice(model, cacheMinutes) {
  if (!model || model.cachedPerM === null || model.cachedPerM === undefined) return 0;
  const write = cacheMinutes >= 60 ? model.inPerM * 2 : model.cacheWritePerM ?? model.inPerM;
  return Math.max(0, write - model.cachedPerM);
}

function analyze({ requests, tools = [], cacheMinutes = 5, helperCost = 0, total }) {
  total = total ?? requests.reduce((s, r) => s + (r.cost || 0), 0);
  const facts = { cacheMinutes, steps: requests.length, helperCost: round(helperCost) };
  const drivers = { pausesYou: 0, pausesTools: 0, otherMisses: 0, switches: 0, bigOutputs: 0 };
  if (!requests.length) return { facts, drivers: { ...drivers, work: total } };

  // Cache expiries: a request that paid full price for much more than what was new since the last one.
  // Not after a compaction: the conversation then starts over from a short summary the cache hasn't
  // seen, so a fresh start is expected, not an expiry. That shows as the context shrinking sharply.
  const expiries = [];
  const reRead = new Map(); // step index -> its extra cost from a cache expiry, counted under that cause
  let compactions = 0;
  for (let i = 1; i < requests.length; i++) {
    const r = requests[i], prev = requests[i - 1];
    if (prev.context >= COMPACTED_FROM && r.context < prev.context * COMPACTED_TO) {
      compactions++;
      continue;
    }
    const excess = r.fresh - Math.max(0, r.context - prev.context);
    if (excess < Math.max(3000, r.context * 0.25)) continue;
    // A different model, or in OpenCode another agent (its own instructions), starts a new cache, so
    // the step after a switch reads everything at full price whatever the pause was.
    const switched = (r.name && prev.name && r.name !== prev.name) || (r.agent && prev.agent && r.agent !== prev.agent);
    const who = switched ? "switch" : r.pause && r.pause.ms >= 60e3 ? r.pause.who : "unknown";
    const extra = perM(excess, missPrice(r.model, cacheMinutes));
    drivers[{ switch: "switches", you: "pausesYou", tool: "pausesTools" }[who] || "otherMisses"] += extra;
    reRead.set(i, extra);
    const during = who === "switch" ? (r.name !== prev.name ? "model switch" : "agent switch") : who === "you" ? "user's reply" : who === "tool" ? r.pause.kind || "command" : "unknown";
    expiries.push({ step: i + 1, pauseMinutes: r.pause ? round(r.pause.ms / 60e3, 1) : null, during, reReadTokens: Math.round(excess), extraCostUsd: round(extra) });
  }
  facts.cacheExpiries = expiries;
  facts.compactions = compactions;

  // Tool results stay in the conversation, so every later step re-reads them.
  const carry = (o) => requests.slice(o.after + 1).reduce((s, r) => s + perM(o.outTokens, cachedPrice(r.model)), 0);
  const big = tools.filter((o) => o.outTokens >= 8000).map((o) => ({ ...o, carry: carry(o) })).sort((a, b) => b.carry - a.carry);
  drivers.bigOutputs = big.reduce((s, o) => s + o.carry, 0);
  facts.largeOutputs = big.slice(0, 10).map((o) => ({ kind: o.kind, tool: o.tool, file: o.file || null, tokens: o.outTokens, reReadByLaterStepsUsd: round(o.carry) }));
  facts.largeOutputsCount = big.length;

  // Tool use counts and time spent waiting on commands.
  const count = (k) => tools.filter((o) => o.kind === k).length;
  facts.toolUse = { edits: count("edit"), reads: count("read"), builds: count("build"), tests: count("test"), other: count("other") };
  const slow = tools.filter((o) => (o.kind === "build" || o.kind === "test") && o.ms > 0);
  facts.buildAndTestMinutes = round(slow.reduce((s, o) => s + o.ms, 0) / 60e3, 1);
  const reads = new Map();
  for (const o of tools.filter((x) => x.kind === "read" && x.file)) reads.set(o.file, (reads.get(o.file) || 0) + 1);
  facts.filesReadSeveralTimes = [...reads].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([file, times]) => ({ file, times }));

  // How the conversation grew.
  const peak = Math.max(...requests.map((r) => r.context));
  const mid = Math.floor(requests.length / 2);
  facts.peakContextTokens = peak;
  // What was spent on steps that read over 100k tokens (Spending's Patterns, see patterns.js). A
  // full-price re-read on such a step is already counted under its cause (waiting, a build, a
  // switch), so it's left out here: every dollar counts in one habit at most.
  facts.longStepsCostUsd = round(requests.reduce((s, r, i) => (r.context > LONG_STEP_TOKENS ? s + Math.max(0, (r.cost || 0) - (reRead.get(i) || 0)) : s), 0));
  facts.firstHalfCostUsd = round(requests.slice(0, mid).reduce((s, r) => s + r.cost, 0));
  facts.secondHalfCostUsd = round(requests.slice(mid).reduce((s, r) => s + r.cost, 0));
  const userPauses = requests.filter((r) => r.pause && r.pause.who === "you").map((r) => r.pause.ms);
  facts.userReplies = userPauses.length;
  facts.longestUserPauseMinutes = userPauses.length ? round(Math.max(...userPauses) / 60e3, 1) : 0;

  // The parts can overlap a little (a big output can also be re-read after a pause), so they're
  // scaled down if together they'd come to more than the whole conversation.
  let explained = drivers.pausesYou + drivers.pausesTools + drivers.otherMisses + drivers.switches + drivers.bigOutputs;
  if (explained > total * 0.95 && explained > 0) {
    const scale = (total * 0.95) / explained;
    for (const key of Object.keys(drivers)) drivers[key] *= scale;
    explained = total * 0.95;
  }
  for (const key of Object.keys(drivers)) drivers[key] = round(drivers[key]);
  return { facts, drivers: { ...drivers, work: round(Math.max(0, total - explained)) } };
}

module.exports = { analyze, commandKind, LONG_STEP_TOKENS };
