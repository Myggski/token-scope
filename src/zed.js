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

// Every thread with its token totals. Threads Zed can't give totals for are left out.
async function loadZedThreads(folder = zedFolder()) {
  const file = zedDatabase(folder);
  if (!fs.existsSync(file)) return [];
  const SQLite = await sqlJs();
  const db = new SQLite.Database(fs.readFileSync(file)); // a copy in memory; Zed keeps writing to its own
  const threads = [];
  try {
    const result = db.exec("SELECT * FROM threads");
    if (!result.length) return [];
    const { columns, values } = result[0];
    for (const v of values) {
      const row = Object.fromEntries(columns.map((c, i) => [c, v[i]]));
      let raw;
      try {
        const bytes = Buffer.from(row.data || []);
        raw = (row.data_type === "zstd" ? unzstd(bytes) : bytes).toString("utf8");
      } catch {
        continue; // unreadable: skipped, like a record a tool is still writing
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        continue;
      }
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
  return threads.filter((t) => t.end && t.tokens.input + t.tokens.output + t.tokens.read + t.tokens.write > 0);
}

module.exports = { zedFolder, zedDatabase, zedFound, loadZedThreads };
