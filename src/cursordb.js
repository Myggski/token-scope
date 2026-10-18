// Reads what Cursor itself keeps about its chats in its local database (state.vscdb): each chat's
// name, and Cursor's own count of how big the conversation was when each message was sent and at
// the end. Read-only, and only for the chats TokenScope has hook records of. Nothing else is read:
// no messages, code or file contents. TokenScope uses the sizes to anchor its cost estimate.
//
// Needs Node's built-in SQLite (Electron 37+ / Node 22.13+). Without it, or without Cursor's
// database, it returns nothing and Cursor costs fall back to TokenScope's own estimate.
const fs = require("fs");
const os = require("os");
const path = require("path");

function databaseFile() {
  if (process.env.TOKENSCOPE_CURSOR_DB) return process.env.TOKENSCOPE_CURSOR_DB;
  const home = os.homedir();
  const user = process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor", "User")
    : process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Cursor", "User")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Cursor", "User");
  return path.join(user, "globalStorage", "state.vscdb");
}

let DatabaseSync = null;
function sqlite() {
  if (DatabaseSync !== null) return DatabaseSync;
  // Node prints a one-time "SQLite is experimental" warning; it isn't useful to anyone here.
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => (/SQLite/i.test(String(warning)) ? undefined : emit.call(process, warning, ...rest));
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    DatabaseSync = false;
  } finally {
    process.emitWarning = emit;
  }
  return DatabaseSync;
}

const parse = (v) => {
  try {
    return JSON.parse(typeof v === "string" ? v : Buffer.from(v).toString("utf8"));
  } catch {
    return null;
  }
};
// All keys that start with prefix, using the key index (LIKE would read the whole 2 GB table).
const range = (prefix) => [prefix, prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)];

// Cache per chat, kept while Cursor hasn't changed the chat.
const cache = new Map(); // id -> { updated, info }

// ids: conversation ids from the hook. Returns Map id -> { name, end, turns: Map(turn id -> size) }.
function cursorChats(ids, { file = databaseFile() } = {}) {
  const out = new Map();
  const Database = sqlite();
  if (!Database || !ids.length || !fs.existsSync(file)) return out;
  let db;
  try {
    db = new Database(file, { readOnly: true });
    const header = db.prepare("SELECT lastUpdatedAt FROM composerHeaders WHERE composerId = ?");
    const chat = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
    const messages = db.prepare("SELECT value FROM cursorDiskKV WHERE key >= ? AND key < ?");
    for (const id of ids) {
      let updated = null;
      try {
        const h = header.get(id);
        updated = h ? h.lastUpdatedAt : null;
      } catch {} // older Cursor: no headers table, so no caching
      const cached = cache.get(id);
      if (cached && updated !== null && cached.updated === updated) {
        if (cached.info) out.set(id, cached.info);
        continue;
      }
      const row = chat.get(`composerData:${id}`);
      const data = row && parse(row.value);
      let info = null;
      if (data) {
        const turns = new Map();
        for (const m of messages.all(...range(`bubbleId:${id}:`))) {
          const b = parse(m.value);
          const size = b && b.type === 1 && b.requestId && b.contextWindowStatusAtCreation && b.contextWindowStatusAtCreation.tokensUsed;
          if (size > 0) turns.set(b.requestId, size);
        }
        info = {
          name: typeof data.name === "string" && data.name.trim() ? data.name.trim().slice(0, 200) : null,
          end: data.contextTokensUsed > 0 ? data.contextTokensUsed : null,
          turns,
        };
        out.set(id, info);
      }
      cache.set(id, { updated, info });
    }
  } catch (error) {
    // Locked, a newer format, or not a database: Cursor costs fall back to the estimate.
    if (!cursorChats.warned) console.error("Reading Cursor's chat list failed:", error.message);
    cursorChats.warned = true;
  } finally {
    try {
      if (db) db.close();
    } catch {}
  }
  return out;
}

module.exports = { cursorChats, databaseFile };
