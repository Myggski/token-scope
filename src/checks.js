// Notices when data from a source doesn't look the way TokenScope expects, usually because the
// tool or service changed its format in an update. Readers report what they found; the app
// shows a warning instead of silently showing missing or wrong numbers.
const NAMES = { openrouter: "OpenRouter", "claude-code": "Claude Code", opencode: "OpenCode", cursor: "Cursor", codex: "Codex", zed: "Zed" };

function createChecks() {
  const problems = new Map(); // source -> message
  return {
    // A format problem: the data was there, but not in the shape expected.
    mismatch(source, detail) {
      if (!problems.has(source)) problems.set(source, `${NAMES[source] || source} data mismatch, probably due to a ${NAMES[source] || source} update. ${detail}`);
    },
    list: () => [...problems].map(([source, message]) => ({ source, message })),
  };
}

// Share of items that pass a test; used to tell "a few odd entries" from "the format changed".
const share = (items, test) => (items.length ? items.filter(test).length / items.length : 1);

// OpenRouter's model list: the fields TokenScope reads.
function checkOpenRouter(json, checks) {
  const list = json && (json.data || json.models);
  if (!Array.isArray(list)) return checks.mismatch("openrouter", "The model list wasn't where expected, so prices can't be read. The app is using its last saved prices.");
  const priced = share(list, (m) => m && typeof m.id === "string" && m.pricing && m.pricing.prompt !== undefined && m.pricing.completion !== undefined);
  if (priced < 0.9) return checks.mismatch("openrouter", `Only ${Math.round(priced * 100)}% of models have prices where expected, so some are missing.`);
  const dated = share(list, (m) => typeof m.created === "number" && typeof m.context_length === "number");
  if (dated < 0.8) checks.mismatch("openrouter", "Release dates or context windows are missing for many models, so Newest and Best for the buck may be off.");
}

module.exports = { createChecks, checkOpenRouter, share };
