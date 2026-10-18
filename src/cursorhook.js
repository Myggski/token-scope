// Turning TokenScope's Cursor hook on and off, and cleaning up what it recorded.
// The hook is added to Cursor's own hooks file (~/.cursor/hooks.json) next to any hooks already
// there, and only TokenScope's entries are ever removed.
const fs = require("fs");
const os = require("os");
const path = require("path");

const MARKER = "tokenscope-cursor-hook";
const EVENTS = ["sessionStart", "sessionEnd", "afterFileEdit", "postToolUse", "afterAgentResponse", "afterAgentThought", "subagentStart", "subagentStop", "preCompact", "afterMCPExecution", "afterShellExecution", "stop"];

const cursorFolder = () => path.join(os.homedir(), ".cursor");
const hooksFile = () => path.join(cursorFolder(), "hooks.json");
const cursorFound = () => fs.existsSync(cursorFolder());

function readHooks() {
  if (!fs.existsSync(hooksFile())) return { version: 1, hooks: {} };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(hooksFile(), "utf8"));
  } catch {
    throw new Error(`Cursor's hooks file (${hooksFile()}) isn't valid JSON, so TokenScope won't change it. Fix or remove it first.`);
  }
  if (!data.hooks || typeof data.hooks !== "object") data.hooks = {};
  if (!data.version) data.version = 1;
  return data;
}

function writeHooks(data) {
  fs.mkdirSync(cursorFolder(), { recursive: true });
  fs.writeFileSync(hooksFile(), JSON.stringify(data, null, 2) + "\n");
}

// A small launcher script, so Cursor can start TokenScope's recorder with one command.
function writeLauncher(dataFolder, { command, script, records }) {
  const dir = path.join(dataFolder, "hooks");
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    const file = path.join(dir, `${MARKER}.cmd`);
    fs.writeFileSync(file, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${command}" "${script}" "${records}"\r\n`);
    return file;
  }
  const file = path.join(dir, `${MARKER}.sh`);
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${q(command)} ${q(script)} ${q(records)}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

const ours = (entry) => entry && typeof entry.command === "string" && entry.command.includes(MARKER);

function installHook(dataFolder, launch) {
  const data = readHooks(); // first, so a broken file stops everything before anything is written
  const launcher = writeLauncher(dataFolder, launch);
  const command = launcher.includes(" ") ? `"${launcher}"` : launcher;
  for (const event of EVENTS) {
    const list = Array.isArray(data.hooks[event]) ? data.hooks[event].filter((h) => !ours(h)) : [];
    list.push({ command, timeout: 5 });
    data.hooks[event] = list;
  }
  writeHooks(data);
  return { hooksFile: hooksFile(), launcher };
}

function removeHook() {
  if (!fs.existsSync(hooksFile())) return;
  const data = readHooks();
  for (const event of Object.keys(data.hooks)) {
    if (!Array.isArray(data.hooks[event])) continue;
    data.hooks[event] = data.hooks[event].filter((h) => !ours(h));
    if (!data.hooks[event].length) delete data.hooks[event];
  }
  writeHooks(data);
}

// Whether TokenScope's hook is on every step it records. A newer TokenScope can record more
// steps than an older one installed, and then adds them (see main.js).
function hookComplete() {
  try {
    const hooks = readHooks().hooks;
    return EVENTS.every((event) => Array.isArray(hooks[event]) && hooks[event].some(ours));
  } catch {
    return false;
  }
}

function hookInstalled() {
  try {
    return Object.values(readHooks().hooks).some((list) => Array.isArray(list) && list.some(ours));
  } catch {
    return false;
  }
}

// The hook's latest problem (see cursor-hook.js), or null. The hook writes them next to its launcher.
const problemsFile = (dataFolder) => path.join(dataFolder, "hooks", "cursor-hook-problems.log");
function lastProblem(dataFolder) {
  try {
    const lines = fs.readFileSync(problemsFile(dataFolder), "utf8").trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

// When the hook last wrote a record, or null if never.
function lastRecord(records) {
  try {
    const days = fs.readdirSync(records).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
    if (!days.length) return null;
    return fs.statSync(path.join(records, days[days.length - 1])).mtimeMs;
  } catch {
    return null;
  }
}

// Deletes recorded days older than keepDays (0 = keep everything), or all of them.
function pruneRecords(records, keepDays, all = false) {
  let names = [];
  try {
    names = fs.readdirSync(records);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - keepDays * 86400e3;
  let removed = 0;
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    if (all || (keepDays > 0 && Date.parse(name.slice(0, 10)) + 86400e3 < cutoff)) {
      fs.rmSync(path.join(records, name), { force: true });
      removed++;
    }
  }
  return removed;
}

module.exports = { installHook, removeHook, hookInstalled, hookComplete, cursorFound, hooksFile, lastRecord, lastProblem, problemsFile, pruneRecords, EVENTS, MARKER };
