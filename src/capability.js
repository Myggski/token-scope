// Capability scores: Epoch AI's Capabilities Index (ECI), one number per model that combines many
// benchmarks. Epoch AI publishes it as a CSV file, free to use with credit (CC BY 4.0):
//   https://epoch.ai/data/eci_scores.csv   columns used: Model, Display name, eci, eci_ci_low,
//   eci_ci_high, date, model_versions
// Epoch AI names models its own way, so they're matched to OpenRouter's by name. Only exact matches
// (ignoring case, spaces and punctuation) count, so a "Pro" or "Mini" variant never gets the score
// of the model it's based on. Models without a match have no score.
const EPOCH_URL = "https://epoch.ai/data/eci_scores.csv";
const NO_CHECKS = { mismatch() {} };

// RFC 4180: fields may be quoted, with commas, quotes ("") and line breaks inside.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head = [], ...body] = rows.filter((r) => r.some((f) => f.trim()));
  const names = head.map((h) => h.trim().replace(/^﻿/, ""));
  return { columns: names, rows: body.map((r) => Object.fromEntries(names.map((n, i) => [n, (r[i] || "").trim()]))) };
}

// "Claude Haiku 5.5", "claude-haiku-5-5" and "Anthropic: Claude Haiku 5.5" all become "claudehaiku55".
const key = (text) => String(text || "").replace(/^[^:]*:\s+/, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
// Looser forms, tried only when the exact name doesn't match: without a trailing date
// ("DeepSeek V4 Pro 0423") or without a note in brackets ("Gemini 2.5 Pro (Jun 2025)").
const looseKeys = (text) => {
  const name = String(text || "").replace(/^[^:]*:\s+/, "");
  return [name.replace(/[\s-]+\d{4}$/, ""), name.replace(/\s*\([^)]*\)\s*/g, " ").trim()].map(key).filter((k) => k && k !== key(name));
};

// The scores in Epoch AI's file. Format checks: a changed file warns instead of quietly showing no scores.
function readEpoch(text, checks = NO_CHECKS) {
  const { columns, rows } = parseCsv(String(text || ""));
  if (!columns.includes("eci") || !(columns.includes("Display name") || columns.includes("Model"))) {
    checks.mismatch("epoch", "Its scores are stored differently now, so TokenScope can't show them.");
    return [];
  }
  const scores = rows.map((r) => ({
    name: r["Display name"] || r.Model,
    score: Number(r.eci),
    low: r.eci_ci_low === "" ? null : Number(r.eci_ci_low),
    high: r.eci_ci_high === "" ? null : Number(r.eci_ci_high),
    date: Date.parse(r.date) || 0,
    names: [r["Display name"], r.Model, ...String(r.model_versions || "").split(/[,;|]/)].map((s) => (s || "").trim()).filter(Boolean),
  })).filter((s) => s.name && Number.isFinite(s.score));
  if (rows.length >= 20 && scores.length < rows.length / 2) checks.mismatch("epoch", "Most of its scores couldn't be read, so many models are missing theirs.");
  return scores;
}

// Map model id -> { score, low, high, name } for the models that have one.
function matchScores(models, scores) {
  const exact = new Map(), loose = new Map();
  const put = (map, k, s) => {
    const had = map.get(k);
    if (k && (!had || s.date > had.date)) map.set(k, s); // the same name twice: the newest
  };
  for (const s of scores) {
    for (const n of s.names) put(exact, key(n), s);
    for (const n of s.names) for (const k of looseKeys(n)) put(loose, k, s);
  }
  const out = new Map();
  for (const m of models) {
    const names = [m.name, m.id.split("/").pop()];
    const hit = names.map((n) => exact.get(key(n))).find(Boolean)
      || [...names.map(key), ...names.flatMap(looseKeys)].map((k) => exact.get(k) || loose.get(k)).find(Boolean);
    if (hit) out.set(m.id, { score: hit.score, low: hit.low, high: hit.high, name: hit.name });
  }
  return out;
}

// Name check: if far fewer models match than last time, Epoch AI most likely renamed them.
function checkMatches(matched, scores, previous, checks = NO_CHECKS) {
  if ((previous >= 20 && matched < previous / 2) || (scores >= 100 && matched < 10)) {
    checks.mismatch("epoch", "Many models no longer match a score, probably because Epoch AI renamed them. Some scores are missing.");
  }
}

module.exports = { EPOCH_URL, parseCsv, readEpoch, matchScores, checkMatches, key };
