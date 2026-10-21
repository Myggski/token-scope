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

console.log("capability tests passed");
