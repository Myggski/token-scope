// MCP mode as a plain background program, started by an AI tool with ELECTRON_RUN_AS_NODE=1:
//   TokenScope.exe <this file>   (or electron.exe <this file> when running from source)
// Running as plain Node, without a window, is what makes stdin/stdout work reliably on Windows.
// It uses the same data folder as the app window, so both see the same favorites and jobs.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseOpenRouter } = require("./models");
const { createStore, dataFile } = require("./store");
const { syncActuals } = require("./claudelogs");
const { syncCursorActuals, syncOpenCodeActuals, readClaudeCode, readCodex, readOpenCode, readCursor } = require("./history");
const { syncCodexActuals } = require("./codexlogs");
const { createChecks } = require("./checks");
const { withArchive } = require("./archive");
const { startMcp } = require("./mcp");

// stdout carries the MCP messages, so anything logged goes to stderr instead.
console.log = console.error;

// The same folder Electron uses for the app (%APPDATA%\TokenScope on Windows).
function dataFolder() {
  if (process.env.TOKENSCOPE_DATA) return process.env.TOKENSCOPE_DATA;
  const home = os.homedir();
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "TokenScope");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "TokenScope");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "TokenScope");
}

const folder = dataFolder();
fs.mkdirSync(folder, { recursive: true });
const store = createStore(dataFile(folder));
const cacheFile = path.join(folder, "openrouter-cache.json");
const snapshotFile = path.join(__dirname, "..", "data", "openrouter-snapshot.json");
const FRESH = 6 * 3600e3; // prices saved by the app within 6 hours are used as they are

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

async function fetchLive() {
  const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}`);
  const models = parseOpenRouter(await response.json());
  if (models.length < 20) throw new Error("OpenRouter returned too few models");
  const data = { models, fetched: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) };
  fs.writeFileSync(cacheFile, JSON.stringify(data));
  return data;
}

// Prices: the app's recent copy, else live, else an older copy, else the one shipped with the app.
async function loadPrices() {
  let age = Infinity;
  try {
    age = Date.now() - fs.statSync(cacheFile).mtimeMs;
  } catch {}
  const cached = readJson(cacheFile);
  if (cached && age < FRESH) return cached.models;
  try {
    return (await fetchLive()).models;
  } catch (error) {
    console.error("Live prices failed:", error.message);
    if (cached) return cached.models;
    const snapshot = readJson(snapshotFile);
    return snapshot ? parseOpenRouter(snapshot) : [];
  }
}

let models = [];
let loadedAt = 0;

async function getModels() {
  if (!models.length || Date.now() - loadedAt > 3600e3) {
    models = await loadPrices();
    loadedAt = Date.now();
  }
  return models;
}

const VERSION = (readJson(path.join(__dirname, "..", "package.json")) || {}).version || "1.0.0";
// Your AI tool keeps this program running across TokenScope updates. Once a newer TokenScope has
// opened, this older copy stops measuring costs, so its older way of reading can't overwrite
// the newer numbers. It still answers with what the newer one saved.
const newer = (a, b) => {
  const x = String(a || "0").split(".").map(Number), y = String(b || "0").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

startMcp({
  store,
  getModels,
  version: VERSION,
  sync: async () => {
    if (newer(store.read().appVersion, VERSION)) return;
    try {
      await syncActuals(store, await getModels());
    } catch (error) {
      console.error("Reading Claude Code logs failed:", error);
    }
    try {
      await syncCodexActuals(store, await getModels());
    } catch (error) {
      console.error("Reading Codex logs failed:", error);
    }
    try {
      await syncOpenCodeActuals(store, await getModels());
    } catch (error) {
      console.error("Reading OpenCode records failed:", error);
    }
    try {
      syncCursorActuals(store, await getModels(), path.join(folder, "history", "cursor"));
    } catch (error) {
      console.error("Reading Cursor records failed:", error);
    }
  },
  // History for get_history: only the tools the user switched on in TokenScope.
  history: async (days) => {
    const on = store.read().tracking || {};
    const since = Date.now() - days * 86400e3;
    const models = await getModels();
    const checks = createChecks();
    const conversations = [];
    const attempt = async (read) => {
      try {
        conversations.push(...(await read()));
      } catch (error) {
        console.error(error);
      }
    };
    if (on["claude-code"]) await attempt(() => readClaudeCode(models, since, { checks }));
    if (on.codex) await attempt(() => readCodex(models, since, { checks }));
    if (on.opencode) await attempt(() => readOpenCode(models, since, { checks }));
    if (on.cursor) await attempt(async () => readCursor(models, since, { folder: path.join(folder, "history", "cursor"), checks }));
    // Also saves summaries, and adds the ones whose records the tool has deleted (see archive.js).
    const kept = Number(store.read().settings.historyDays);
    const keepDays = Number.isFinite(kept) && kept >= 0 ? kept : 90;
    const tracked = new Set(Object.keys(on).filter((id) => on[id]));
    try {
      return { conversations: withArchive(folder, conversations, { since, tracked, keepDays }), warnings: checks.list() };
    } catch (error) {
      console.error("Saved history:", error.message);
      return { conversations, warnings: checks.list() };
    }
  },
  onClose: () => process.exit(0),
});
