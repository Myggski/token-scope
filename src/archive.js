// Saved summaries of conversations, so History keeps them after a tool deletes its own records
// (Claude Code deletes its logs after 30 days by default).
// One file, history/conversations.json in TokenScope's data folder: { version, conversations: { id: summary } }.
// A summary is what History shows: title, project, times, cost per model and what the cost was
// made of. Never the conversation itself. Kept as long as "Keep history for" says.
// Cursor isn't saved here: its records are TokenScope's own already (history/cursor).
const fs = require("fs");
const path = require("path");

const DAY = 86400e3;
const SAVED_TOOLS = new Set(["claude-code", "codex", "opencode"]);

const archiveFile = (folder) => path.join(folder, "history", "conversations.json");

function readArchive(folder) {
  try {
    const data = JSON.parse(fs.readFileSync(archiveFile(folder), "utf8"));
    return data && data.conversations && typeof data.conversations === "object" ? data.conversations : {};
  } catch {
    return {};
  }
}

// Replaced in one step, so the app and the MCP program never read a half-written file.
function writeArchive(folder, conversations) {
  const file = archiveFile(folder);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, conversations }));
  fs.renameSync(temp, file);
}

const cutoff = (keepDays, now) => (keepDays > 0 ? now - keepDays * DAY : -Infinity);

// Saves what was just read and adds saved conversations whose records are gone. Returns the full
// list for the tracked tools since `since`, each marked `saved: true` when it came from the archive.
//   live: conversations the readers found now. tracked: tool ids switched on. keepDays: 0 = forever.
function withArchive(folder, live, { since, tracked, keepDays, now = Date.now() }) {
  const saved = readArchive(folder);
  let changed = false;
  // A subagent's or helper's session that's now counted inside the conversation that started it
  // (c.includes) was saved as a conversation of its own by an older version: drop that copy, or
  // it would show up again and count twice.
  for (const c of live) {
    for (const id of c.includes || []) {
      if (saved[id]) {
        delete saved[id];
        changed = true;
      }
    }
  }
  for (const c of live) {
    if (!SAVED_TOOLS.has(c.tool)) continue;
    const old = saved[c.id];
    // A reader that sees only the end of a conversation (its first records are gone) doesn't
    // replace the fuller summary.
    if (old && c.start > old.start + 1000) continue;
    const summary = { ...c, savedAt: now };
    delete summary.saved;
    if (!old || JSON.stringify({ ...old, savedAt: 0 }) !== JSON.stringify({ ...summary, savedAt: 0 })) {
      saved[c.id] = summary;
      changed = true;
    }
  }
  const limit = cutoff(keepDays, now);
  for (const [id, c] of Object.entries(saved)) {
    if (c.end < limit) {
      delete saved[id];
      changed = true;
    }
  }
  if (changed) writeArchive(folder, saved);

  const liveIds = new Set(live.map((c) => c.id));
  const kept = Object.values(saved).filter((c) => !liveIds.has(c.id) && tracked.has(c.tool) && c.end >= since).map((c) => ({ ...c, saved: true }));
  // A live conversation that's only the end of a saved one shows the saved, fuller summary.
  const shown = live.map((c) => (saved[c.id] && c.start > saved[c.id].start + 1000 ? { ...saved[c.id], saved: true } : c));
  return [...shown, ...kept];
}

// "Keep history for" changed: deletes saved summaries older than that. Returns how many.
function pruneArchive(folder, keepDays, now = Date.now()) {
  const saved = readArchive(folder);
  const limit = cutoff(keepDays, now);
  let removed = 0;
  for (const [id, c] of Object.entries(saved)) {
    if (c.end < limit) {
      delete saved[id];
      removed++;
    }
  }
  if (removed) writeArchive(folder, saved);
  return removed;
}

function clearArchive(folder) {
  fs.rmSync(archiveFile(folder), { force: true });
}

module.exports = { withArchive, pruneArchive, clearArchive, readArchive, archiveFile };
