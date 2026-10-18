// Home folders inside WSL (Linux on Windows), so tools run there are found too: Claude Code,
// Codex and OpenCode keep their records in the Linux home folder, which Windows reaches as
// \\wsl.localhost\<distro>\home\<user>. Only WSL systems that are already running are read, so
// TokenScope never starts one. Conversations from one that's stopped stay in History through
// the saved summaries (archive.js).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

let cached = { at: 0, homes: [] };

// The names of the running WSL systems. wsl.exe answers in UTF-16.
function runningDistros(run = execFileSync) {
  try {
    const out = run("wsl.exe", ["--list", "--running", "--quiet"], { timeout: 3000, windowsHide: true });
    const text = Buffer.isBuffer(out) ? (out.includes(0) ? out.toString("utf16le") : out.toString("utf8")) : String(out);
    return text.replace(/^\uFEFF/, "").replace(/\0/g, "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // no WSL, or it didn't answer in time
  }
}

// Every user's home folder in the running WSL systems (and root's). Looked up at most once a minute.
function wslHomes({ platform = process.platform, run, root = "\\\\wsl.localhost", now = Date.now() } = {}) {
  if (platform !== "win32" && !run) return [];
  if (!run && now - cached.at < 60e3) return cached.homes;
  const homes = [];
  for (const distro of runningDistros(run)) {
    const base = path.join(root, distro);
    try {
      for (const user of fs.readdirSync(path.join(base, "home"), { withFileTypes: true })) {
        if (user.isDirectory()) homes.push(path.join(base, "home", user.name));
      }
    } catch {}
    if (fs.existsSync(path.join(base, "root"))) homes.push(path.join(base, "root"));
  }
  if (!run) cached = { at: now, homes };
  return homes;
}

module.exports = { wslHomes, runningDistros };
