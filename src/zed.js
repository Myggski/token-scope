// Zed's own AI agent keeps every conversation ("thread") in a small database on this computer:
//   Windows  %LOCALAPPDATA%\Zed\threads\threads.db
//   macOS    ~/Library/Application Support/Zed/threads/threads.db
//   Linux    ~/.local/share/zed/threads/threads.db
// One row per thread: id, parent_id (a subagent's parent), folder_paths, summary (the title),
// created_at and updated_at, and the thread itself as zstd-compressed JSON. That JSON has the exact
// token totals the provider reported (cumulative_token_usage: input, output, cache writes and cache
// reads) and the model, but no per-request times. So costs are exact, but per conversation only:
// no breakdown of what drove them, and a plan made in a Zed chat costs the whole chat.
// Seen in Zed's source code (crates/agent/src/db.rs, Oct 2026). Read-only.
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

function zedFolder() {
  if (process.env.TOKENSCOPE_ZED_DATA) return process.env.TOKENSCOPE_ZED_DATA;
  const home = os.homedir();
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Zed");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Zed");
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "zed");
}
const zedDatabase = (folder = zedFolder()) => path.join(folder, "threads", "threads.db");
const zedFound = (folder) => fs.existsSync(zedDatabase(folder));

let SQL = null;
async function sqlJs() {
  if (!SQL) {
    const dist = path.dirname(require.resolve("sql.js"));
    SQL = await require("sql.js")({ locateFile: (file) => path.join(dist, file) });
  }
  return SQL;
}

// zstd: Node's own decoder where there is one (Node 22.15+), else fzstd (plain JavaScript).
function unzstd(buffer) {
  if (typeof zlib.zstdDecompressSync === "function") return zlib.zstdDecompressSync(buffer);
  return Buffer.from(require("fzstd").decompress(new Uint8Array(buffer)));
}

const time = (text) => {
  const t = Date.parse(text || "");
  return Number.isFinite(t) ? t : null;
};

// Format checks: Zed's database is internal and can change in any Zed update. If it no longer looks
// the way TokenScope expects, a warning is shown instead of missing or wrong costs (see checks.js).
const NO_CHECKS = { mismatch() {} };
const COLUMNS = ["id", "updated_at", "data_type", "data"];

// Every thread with its token totals. Threads Zed can't give totals for are left out.
async function loadZedThreads(folder = zedFolder(), checks = NO_CHECKS) {
  const file = zedDatabase(folder);
  if (!fs.existsSync(file)) return [];
  const SQLite = await sqlJs();
  let db;
  try {
    db = new SQLite.Database(fs.readFileSync(file)); // a copy in memory; Zed keeps writing to its own
  } catch {
    checks.mismatch("zed", "Its conversation database couldn't be opened, so Zed conversations are missing.");
    return [];
  }
  const threads = [];
  let unreadable = 0, withoutUsage = 0, rows = 0;
  try {
    // No tables at all: Zed's agent hasn't saved anything yet. Fine, not a changed format.
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table'");
    if (!tables.length || !tables[0].values.length) return [];
    let result;
    try {
      result = db.exec("SELECT * FROM threads");
    } catch {
      checks.mismatch("zed", "Its conversation database no longer has the table TokenScope reads, so Zed conversations are missing.");
      return [];
    }
    // The columns, from the table itself (an empty table returns no rows to read them from).
    const info = db.exec("PRAGMA table_info(threads)");
    const names = info.length ? info[0].values.map((v) => v[1]) : [];
    if (!COLUMNS.every((c) => names.includes(c))) {
      checks.mismatch("zed", "Its conversations are stored differently now, so Zed conversations are missing.");
      return [];
    }
    if (!result.length) return [];
    const { columns, values } = result[0];
    for (const v of values) {
      rows++;
      const row = Object.fromEntries(columns.map((c, i) => [c, v[i]]));
      let raw, data;
      try {
        const bytes = Buffer.from(row.data || []);
        raw = (row.data_type === "zstd" ? unzstd(bytes) : bytes).toString("utf8");
        data = JSON.parse(raw);
      } catch {
        unreadable++; // skipped; many of these means the format changed
        continue;
      }
      // A thread with replies but no token counts in either known place.
      const replies = Array.isArray(data.messages) && data.messages.length > 1;
      if (replies && !data.cumulative_token_usage && !data.request_token_usage) withoutUsage++;
      // Newer threads keep a running total; older ones a list per request.
      let usage = data.cumulative_token_usage;
      if (!usage && Array.isArray(data.request_token_usage)) {
        usage = data.request_token_usage.reduce((sum, u) => {
          for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) sum[k] = (sum[k] || 0) + ((u && u[k]) || 0);
          return sum;
        }, {});
      }
      const tokens = {
        input: (usage && usage.input_tokens) || 0,
        output: (usage && usage.output_tokens) || 0,
        write: (usage && usage.cache_creation_input_tokens) || 0,
        read: (usage && usage.cache_read_input_tokens) || 0,
      };
      const model = data.model && typeof data.model === "object" ? data.model.model : typeof data.model === "string" ? data.model : null;
      const updated = time(row.updated_at) || time(data.updated_at);
      const folders = typeof row.folder_paths === "string" ? row.folder_paths.split(/\r?\n/).filter(Boolean) : [];
      threads.push({
        id: String(row.id),
        parent: row.parent_id ? String(row.parent_id) : null,
        title: (row.summary || data.title || "").trim() || null,
        project: folders.length ? folders[0].replace(/[\\/]+$/, "").split(/[\\/]/).pop() || null : null, // Windows or Unix paths
        start: time(row.created_at) || updated,
        end: updated,
        model,
        provider: data.model && data.model.provider ? data.model.provider : null,
        tokens,
        // TokenScope plans this thread made or continued: their ids show up next to "job_id" in tool results.
        jobs: raw.includes("job_id") ? [...new Set(raw.match(/job-[a-z0-9]{8,}/g) || [])] : [],
      });
    }
  } finally {
    db.close();
  }
  if (rows >= 3 && unreadable / rows > 0.5) checks.mismatch("zed", "Most of its conversations couldn't be read, so Zed conversations are missing.");
  else if (rows >= 3 && withoutUsage / rows > 0.5) checks.mismatch("zed", "Its conversations no longer have token counts where expected, so Zed costs are missing or too low.");
  return threads.filter((t) => t.end && t.tokens.input + t.tokens.output + t.tokens.read + t.tokens.write > 0);
}

module.exports = { zedFolder, zedDatabase, zedFound, loadZedThreads };
