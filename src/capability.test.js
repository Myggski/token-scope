// Checks reading Epoch AI's capability scores (eci_scores.csv, as published Oct 2026) and matching
// them to OpenRouter's models by name, with real names from both.
const assert = require("assert");
const { parseCsv, readEpoch, matchScores, checkMatches } = require("./capability");
const { createChecks } = require("./checks");
const { parseOpenRouter } = require("./models");

const head = "Model,Display name,eci,eci_ci_low,eci_ci_high,date,Organization,Country (of organization),Model accessibility,Accessibility group,model_versions";
const row = (name, eci, date = "2026-09-01", versions = "") => `"${name.toLowerCase().replace(/\s+/g, "-")}",${name.includes(",") ? `"${name}"` : name},${eci},${eci - 1},${eci + 1},${date},Lab,US,API,Closed,"${versions}"`;
const epochNames = [
  ["Claude Opus 5.5", 166.82], ["GPT-6 Astra", 166.41], ["GPT-6.1 Sol", 166.32], ["Gemini 4 Argon", 164.56], ["Claude Sonnet 5.5", 164.45],
  ["Claude Opus 5", 162.6], ["GPT-6 Sol", 162.55], ["Claude Fable 5", 162.13], ["GPT-5.6 Sol", 161.73], ["Claude Haiku 5.5", 158.98],
  ["GPT-5.5", 158.95], ["Claude Opus 4.8", 158.26], ["Kimi K3", 157.42], ["Gemini 3.7 Flash", 157.22], ["Gemini 3.8 Flash", 157.2],
  ["Qwen 3.8 Max", 156.88], ["Claude Sonnet 5", 156.36], ["GPT-5.6 Luna", 156.33], ["GPT-6 Luna", 156.31], ["Grok 4.6", 156.31],
  ["GLM-5.3", 155.91], ["DeepSeek V4.1 Flash", 155.57], ["DeepSeek V4 Pro 0813", 155.29], ["Qwen3.8 Max (0902)", 154.91],
  ["Muse Spark 1.2", 154.9], ["Gemini 3.5 Flash", 154.38], ["Grok 4.7", 154.37], ["Gemini 3.6 Flash", 154.24], ["GLM-5.3-Flash", 153.23],
  ["GLM-5.2", 151.86], ["DeepSeek-V4-Pro", 149.19], ["Mistral Large 4", 146.9], ["DeepSeek-V4-Flash", 146.05],
  ["Gemini 2.5 Pro (Mar 2025)", 144.12, "2025-03-25"], ["Gemini 2.5 Pro (Jun 2025)", 145.31, "2025-06-17"],
];
const csv = [head, ...epochNames.map(([n, e, d]) => row(n, e, d)), row("Odd, Model", 120, "2025-01-01", "odd-1, odd-2")].join("\r\n") + "\r\n";

// The CSV reader: quoted fields with commas.
const parsed = parseCsv(csv);
assert.strictEqual(parsed.rows.length, epochNames.length + 1);
assert.strictEqual(parsed.rows[parsed.rows.length - 1]["Display name"], "Odd, Model");

const scores = readEpoch(csv);
assert.strictEqual(scores.length, epochNames.length + 1);
assert.deepStrictEqual(scores[scores.length - 1].names, ["Odd, Model", "odd,-model", "odd-1", "odd-2"], "its name, id and versions");

// OpenRouter's models, as in TokenScope's bundled snapshot (Oct 17, 2026).
const models = parseOpenRouter(require("../data/openrouter-snapshot.json"));
const matched = matchScores(models, scores);
const score = (id) => (matched.get(id) || {}).score;
assert.strictEqual(score("anthropic/claude-haiku-5.5"), 158.98);
assert.strictEqual(score("anthropic/claude-sonnet-5.5"), 164.45);
assert.strictEqual(score("anthropic/claude-opus-5.5"), 166.82);
assert.strictEqual(score("openai/gpt-5.5"), 158.95);
assert.strictEqual(score("z-ai/glm-5.3-flash"), 153.23, "GLM 5.3 Flash = GLM-5.3-Flash");
assert.strictEqual(score("qwen/qwen3.8-max-0902"), 154.91, "the dated release, not Qwen 3.8 Max");
assert.strictEqual(score("deepseek/deepseek-v4-pro"), 149.19, "DeepSeek V4 Pro 0423 is the first V4 Pro, not the 0813 one");
assert.strictEqual(score("deepseek/deepseek-v4.1-flash-1017"), 155.57);
// Variants never get the score of the model they're based on.
for (const id of ["openai/gpt-6.1-sol-pro", "openai/gpt-6-sol-pro", "openai/gpt-6-luna-pro", "z-ai/glm-5.3-prime", "qwen/qwen3.8-max-prime", "z-ai/glm-5.3-flashx", "meta/muse-spark-open"]) {
  assert.strictEqual(matched.get(id), undefined, `${id} has no score of its own`);
}
assert.strictEqual(matched.size, 31, "31 of the 54 snapshot models, like counted by hand");
// The same name twice: the newest.
assert.strictEqual(matchScores([{ id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" }], scores).get("google/gemini-2.5-pro").score, 145.31);

// Format checks.
const warn = (fn) => {
  const checks = createChecks();
  fn(checks);
  return checks.list().map((c) => c.message).join(" ");
};
assert.strictEqual(warn((c) => readEpoch(csv, c)), "");
assert.match(warn((c) => readEpoch("Model,score\nx,1\n", c)), /^Epoch AI data mismatch.*stored differently/);
assert.match(warn((c) => readEpoch([head, ...Array.from({ length: 30 }, (_, i) => `m${i},M ${i},n/a,,,2026-01-01,,,,,`)].join("\n"), c)), /couldn't be read/);
assert.strictEqual(warn((c) => checkMatches(31, 277, 30, c)), "", "about as many matches as last time");
assert.match(warn((c) => checkMatches(9, 277, 31, c)), /renamed/, "far fewer than last time");
assert.match(warn((c) => checkMatches(3, 277, 0, c)), /renamed/, "almost none at all");
assert.strictEqual(warn((c) => checkMatches(5, 40, 0, c)), "", "a small file: no conclusions");

// Best for the buck: capable and cheap first, a weak model doesn't win on price alone, and models
// without a score come last, newest first. Prices and scores from a user's list (Oct 21, 2026).
{
  const { sortRows } = require("./models");
  const m = (name, inP, outP, score, created = 1) => ({ id: name, name, inPerM: inP, outPerM: outP, blended: (3 * inP + outP) / 4, created, capability: score == null ? null : { score } });
  const list = [
    m("GLM 5.3 Flash", 0.041, 0.12, 153), m("Claude Haiku 5.5", 0.1, 0.5, 159), m("gpt-oss-20b", 0.018, 0.09, 138), m("Qwen3.7 Flash", 0.03, 0.13, 144),
    m("GPT-6.1 Sol", 2, 10, 168), m("Claude Sonnet 5.5", 2, 10, 164), m("Claude Opus 5.5", 4, 20, 167), m("GPT-6 Astra", 10, 50, 166),
    m("New model", 0.01, 0.02, null, 3), m("Older new model", 0.01, 0.02, null, 2),
  ];
  const order = sortRows(list, "buck").map((x) => x.name);
  assert.strictEqual(order[0], "Claude Haiku 5.5");
  assert.ok(order.indexOf("GPT-6.1 Sol") < 3, "the best model is near the top at a fair price");
  assert.ok(order.indexOf("Claude Sonnet 5.5") < order.indexOf("gpt-oss-20b"), "a much weaker model doesn't beat Sonnet on price alone");
  assert.ok(order.indexOf("Claude Opus 5.5") < order.indexOf("Qwen3.7 Flash"));
  assert.deepStrictEqual(order.slice(-2), ["New model", "Older new model"], "no score: last, newest first");
}

console.log("capability tests passed");
