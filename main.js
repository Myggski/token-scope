const { app, BrowserWindow, ipcMain, shell, net, clipboard } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseOpenRouter } = require("./src/models");
const { createStore, dataFile } = require("./src/store");
const { syncActuals, logsFolder, logsFolders } = require("./src/claudelogs");
const { setJobModels } = require("./src/jobs");
const { readClaudeCode, readCodex, readOpenCode, openCodeFound, readCursor, syncCursorActuals, syncOpenCodeActuals } = require("./src/history");
const { codexHome, codexFound, syncCodexActuals } = require("./src/codexlogs");
const { installHook, removeHook, hookInstalled, cursorFound, lastRecord, pruneRecords } = require("./src/cursorhook");
const { createChecks, checkOpenRouter } = require("./src/checks");
const { withArchive, pruneArchive, clearArchive } = require("./src/archive");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const userFile = (name) => path.join(app.getPath("userData"), name);
const cursorRecords = () => userFile(path.join("history", "cursor"));
// AI tools start the MCP program as a plain background program (see mcpLaunch). `--mcp` is the
// older way of starting it, still accepted: it hands over to the background program.
const MCP_MODE = process.argv.includes("--mcp");
const MCP_FILES = ["mcp-main.js", "mcp.js", "models.js", "estimate.js", "store.js", "jobs.js", "claudelogs.js", "history.js", "insights.js", "checks.js", "cursor-hook.js", "codexlogs.js", "archive.js", "wsl.js"];
let store; // created once the app knows its data folder

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Prices: live from OpenRouter, else the last saved copy, else the copy shipped with the app.
// net.fetch goes through Chromium's network stack, so it uses Windows' proxy settings and
// certificates like a browser would (needed on many work networks).
async function loadPrices() {
  const checks = createChecks();
  const result = (data, source, error) => ({ models: data.models, prices: { source, error, date: data.fetched, warnings: checks.list() } });
  try {
    const response = await net.fetch(OPENROUTER_URL, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}`);
    const json = await response.json();
    checkOpenRouter(json, checks); // warns when the format looks changed
    const models = parseOpenRouter(json);
    if (models.length < 20) throw new Error("OpenRouter returned too few models");
    const data = { models, fetched: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) };
    fs.writeFileSync(userFile("openrouter-cache.json"), JSON.stringify(data));
    return result(data, "live");
  } catch (error) {
    const cached = readJson(userFile("openrouter-cache.json"));
    if (cached) return result(cached, "cache", error.message);
    const snapshot = readJson(path.join(__dirname, "data", "openrouter-snapshot.json"));
    return result({ models: snapshot ? parseOpenRouter(snapshot) : [], fetched: snapshot && snapshot.fetched }, "snapshot", error.message);
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1080,
    height: 900,
    title: "TokenScope",
    icon: path.join(__dirname, "build", "icon.png"),
    autoHideMenuBar: true,
    backgroundColor: "#232323", // matches the dark theme, so startup doesn't flash white
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  window.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Links open in the normal browser, not inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  return window;
}

let currentModels = [];

async function loadModels() {
  const data = await loadPrices();
  currentModels = data.models;
  return data;
}

// Where the MCP program lives. From source it runs in place. An installed app keeps its files inside
// a package (and the portable .exe unpacks to a new temp folder each time), so they're copied
// to the data folder, which never moves.
function mcpScript() {
  if (!app.isPackaged) return path.join(__dirname, "src", "mcp-main.js");
  const target = path.join(app.getPath("userData"), "mcp");
  fs.mkdirSync(path.join(target, "src"), { recursive: true });
  fs.mkdirSync(path.join(target, "data"), { recursive: true });
  for (const file of MCP_FILES) fs.writeFileSync(path.join(target, "src", file), fs.readFileSync(path.join(__dirname, "src", file)));
  fs.writeFileSync(path.join(target, "data", "openrouter-snapshot.json"), fs.readFileSync(path.join(__dirname, "data", "openrouter-snapshot.json")));
  // sql.js reads OpenCode's database; copy the two files it needs next to the scripts.
  const sqlFrom = path.dirname(require.resolve("sql.js"));
  const sqlTo = path.join(target, "node_modules", "sql.js", "dist");
  fs.mkdirSync(sqlTo, { recursive: true });
  for (const file of ["sql-wasm.js", "sql-wasm.wasm"]) fs.writeFileSync(path.join(sqlTo, file), fs.readFileSync(path.join(sqlFrom, file)));
  fs.writeFileSync(path.join(target, "node_modules", "sql.js", "package.json"), JSON.stringify({ name: "sql.js", main: "dist/sql-wasm.js" }));
  // fzstd unpacks Codex's compressed logs; one file.
  const zstdTo = path.join(target, "node_modules", "fzstd", "lib");
  fs.mkdirSync(zstdTo, { recursive: true });
  fs.writeFileSync(path.join(zstdTo, "index.js"), fs.readFileSync(require.resolve("fzstd")));
  fs.writeFileSync(path.join(target, "node_modules", "fzstd", "package.json"), JSON.stringify({ name: "fzstd", main: "lib/index.js" }));
  return path.join(target, "src", "mcp-main.js");
}

// What Cursor's hook runs: this app's executable as plain Node, with the recorder script.
function cursorHookLaunch() {
  mcpScript(); // makes sure the copied scripts exist, for the installed app
  const script = app.isPackaged ? path.join(app.getPath("userData"), "mcp", "src", "cursor-hook.js") : path.join(__dirname, "src", "cursor-hook.js");
  return { command: mcpLaunch().command, script, records: cursorRecords() };
}

// ---------- History and tracking ----------

// note(on, todo, recording): the line under each tool, depending on its state.
const SOURCES = [
  { id: "claude-code", name: "Claude Code", found: () => logsFolders().some((folder) => fs.existsSync(folder)),
    note: (on) => on ? "On. TokenScope reads Claude Code's existing usage records." : "TokenScope reads Claude Code's existing usage records. No extra setup needed." },
  { id: "codex", name: "Codex", found: () => codexFound(),
    note: (on) => on ? "On. TokenScope reads Codex's existing usage records, from the app, the editor extension and the command line." : "TokenScope reads Codex's existing usage records, from the app, the editor extension and the command line. No extra setup needed." },
  { id: "opencode", name: "OpenCode", found: () => openCodeFound(),
    note: (on) => on ? "On. TokenScope reads OpenCode's existing usage records." : "TokenScope reads OpenCode's existing usage records. No extra setup needed." },
  { id: "cursor", name: "Cursor", found: () => cursorFound(),
    note: (on, todo, recording) => !on ? "Cursor doesn't save usage records that TokenScope can read directly. Turn this on to add a small hook to Cursor that records usage as you work, even when TokenScope is closed. It records usage details, never your code, prompts, commands or AI replies. No restart needed. Costs are approximate, not exact amounts."
      : todo ? "On, but TokenScope's hook is missing from Cursor's settings."
      : recording ? "On and recording, also while TokenScope is closed. Costs are approximate."
      : "On. Your next Cursor conversation shows up in Spending." },
];

const tracking = () => store.read().tracking || {};
const keepDays = () => {
  const days = Number(store.read().settings.historyDays);
  return Number.isFinite(days) && days >= 0 ? days : 90;
};

// What a source still needs from the user before it works, if anything.
function manualStep(id, on) {
  if (!on) return null;
  if (id === "cursor") {
    if (!hookInstalled()) return { text: "Turn Cursor off and on again here to add it back.", help: "help-history" };

  }
  return null;
}

function sourcesStatus() {
  const on = tracking();
  return SOURCES.map((s) => {
    const todo = manualStep(s.id, on[s.id]);
    // Cursor counts as recording once the hook has written something since it was switched on.
    const last = s.id === "cursor" ? lastRecord(cursorRecords()) : null;
    const recording = !!(last && on[s.id] && last >= (on[s.id].since || 0));
    return { id: s.id, name: s.name, found: s.found(), enabled: !!on[s.id], note: s.note(!!on[s.id], todo, recording), todo };
  });
}

async function setTracking(id, enabled) {
  if (!SOURCES.some((s) => s.id === id)) throw new Error(`Unknown source: ${id}`);
  if (id === "cursor") {
    if (enabled) installHook(app.getPath("userData"), cursorHookLaunch());
    else removeHook();
  }
  store.update((data) => {
    data.tracking = { ...(data.tracking || {}), [id]: enabled ? { since: Date.now() } : false };
  });
  return sourcesStatus();
}

// Every tracked conversation within `days` (default: the kept period), newest first, plus any
// format problems found while reading.
async function historyList(days = keepDays()) {
  const on = tracking();
  const since = days > 0 ? Date.now() - days * 86400e3 : 0;
  const checks = createChecks();
  const all = [];
  const errors = [];
  const attempt = async (id, read) => {
    if (!on[id]) return;
    try {
      all.push(...(await read()));
    } catch (error) {
      errors.push(`${SOURCES.find((s) => s.id === id).name}: ${error.message}`);
    }
  };
  await attempt("claude-code", () => readClaudeCode(currentModels, since, { checks }));
  await attempt("codex", () => readCodex(currentModels, since, { checks }));
  await attempt("opencode", () => readOpenCode(currentModels, since, { checks }));
  await attempt("cursor", async () => readCursor(currentModels, since, { folder: cursorRecords(), checks }));
  // Saves summaries and adds the ones whose records the tool has deleted since (see archive.js).
  const tracked = new Set(Object.keys(on).filter((id) => on[id]));
  let list = all;
  try {
    list = withArchive(app.getPath("userData"), all, { since, tracked, keepDays: keepDays() });
  } catch (error) {
    errors.push(`Saved history: ${error.message}`);
  }
  list.sort((a, b) => b.end - a.end);
  return { conversations: list, keepDays: days, errors, warnings: checks.list() };
}

// How an AI tool should start TokenScope's MCP program: this app's own executable, run as plain
// Node (ELECTRON_RUN_AS_NODE=1) so it reads and writes stdin/stdout like any command-line tool.
// Running from source (npm start), Node itself is installed anyway, so plain `node` is used.
function mcpLaunch() {
  if (!app.isPackaged) return { command: "node", args: [mcpScript()], env: {} };
  const command = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  return { command, args: [mcpScript()], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

function startWindowApp() {
  ipcMain.handle("data:load", loadModels);
  ipcMain.handle("store:read", () => store.read());
  ipcMain.handle("settings:set", (event, changes) => store.update((data) => Object.assign(data.settings, changes)));
  ipcMain.handle("favorite:set", (event, id, on) => store.update((data) => {
    const set = new Set(data.favorites);
    if (on) set.add(id);
    else set.delete(id);
    data.favorites = [...set];
  }));
  ipcMain.handle("job:setModels", (event, jobId, modelIds) => {
    const models = modelIds.map((id) => {
      const model = currentModels.find((m) => m.id === id);
      if (!model) throw new Error(`Unknown model: ${id}`);
      return model;
    });
    return setJobModels(store, jobId, models);
  });
  ipcMain.handle("job:delete", (event, id) => store.update((data) => { data.jobs = data.jobs.filter((j) => j.id !== id); }));
  ipcMain.handle("ai:launch", () => ({ ...mcpLaunch(), dataFile: store.file, logsFolder: logsFolder(), codexFolder: path.join(codexHome(), "sessions"), home: os.homedir(), windows: process.platform === "win32" }));
  // Clearing saved data from Settings & help. prices: the saved price copy and the browser cache.
  ipcMain.handle("data:clear", async (event, kind) => {
    const removePrices = async () => {
      fs.rmSync(userFile("openrouter-cache.json"), { force: true });
      await window.webContents.session.clearCache();
    };
    if (kind === "prices") return removePrices();
    if (kind === "settings") return store.update((data) => { data.settings = {}; });
    if (kind === "favorites") return store.update((data) => { data.favorites = []; });
    if (kind === "jobs") return store.update((data) => { data.jobs = []; });
    if (kind === "cursor") return pruneRecords(cursorRecords(), 0, true);
    if (kind === "history") {
      clearArchive(app.getPath("userData"));
      return pruneRecords(cursorRecords(), 0, true);
    }
    if (kind === "all") {
      // Also turns tracking off, removes the Cursor hook and deletes what it recorded.
      try {
        removeHook();
      } catch {}
      pruneRecords(cursorRecords(), 0, true);
      clearArchive(app.getPath("userData"));
      store.update((data) => { data.settings = {}; data.favorites = []; data.jobs = []; data.tracking = {}; });
      return removePrices();
    }
    throw new Error(`Unknown kind: ${kind}`);
  });
  ipcMain.handle("history:sources", () => sourcesStatus());
  ipcMain.handle("history:setTracking", (event, id, enabled) => setTracking(id, enabled));
  ipcMain.handle("history:list", () => historyList());
  ipcMain.handle("history:setKeep", (event, days) => {
    store.update((data) => { data.settings.historyDays = days; });
    pruneArchive(app.getPath("userData"), days);
    return pruneRecords(cursorRecords(), days);
  });
  ipcMain.handle("data:openFolder", () => shell.openPath(app.getPath("userData")));
  ipcMain.handle("clipboard:write", (event, text) => clipboard.writeText(String(text)));

  const window = createWindow();
  const changed = () => !window.isDestroyed() && window.webContents.send("store:changed");
  // Changes from the AI (or a hand edit of the data file) show up in the window.
  store.watch(changed);
  // Real costs of jobs come from Claude Code's and Codex's session logs and the Cursor records; checked every 30 seconds while the window is open.
  const sync = async () => {
    if (!currentModels.length) return;
    try {
      if (await syncActuals(store, currentModels)) changed();
    } catch (error) {
      console.error("Reading Claude Code logs failed:", error);
    }
    try {
      if (await syncCodexActuals(store, currentModels)) changed();
    } catch (error) {
      console.error("Reading Codex logs failed:", error);
    }
    try {
      if (await syncOpenCodeActuals(store, currentModels)) changed();
    } catch (error) {
      console.error("Reading OpenCode records failed:", error);
    }
    try {
      if (syncCursorActuals(store, currentModels, cursorRecords())) changed();
    } catch (error) {
      console.error("Reading Cursor records failed:", error);
    }
  };
  // Cursor records older than the kept period are deleted on start.
  pruneRecords(cursorRecords(), keepDays());
  ipcMain.handle("jobs:sync", sync);
  setInterval(sync, 30e3);
}

// Older setups start `TokenScope.exe --mcp`. Hand over to the background program, which gets
// the AI tool's stdin/stdout directly, and exit when it does.
function startMcpMode() {
  const child = spawn(process.execPath, [mcpScript()], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit", windowsHide: true });
  child.on("exit", (code) => app.exit(code ?? 0));
  child.on("error", (error) => {
    console.error("Couldn't start the MCP program:", error);
    app.exit(1);
  });
}

if (MCP_MODE) {
  app.disableHardwareAcceleration();
  // Keep browser storage apart from a TokenScope window that may be open at the same time.
  app.setPath("sessionData", path.join(app.getPath("userData"), "mcp-session"));
}

app.whenReady().then(() => {
  if (MCP_MODE) return startMcpMode();
  store = createStore(dataFile(app.getPath("userData")));
  // A test build hid History before a date ("historyFrom"); that's gone, so History shows it all again.
  if (store.read().historyFrom) store.update((data) => { delete data.historyFrom; });
  startWindowApp();
});

app.on("window-all-closed", () => {
  if (!MCP_MODE) app.quit();
});
