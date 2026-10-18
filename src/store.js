// The user's own data: favorites, settings and job history, in one readable JSON file
// (%APPDATA%\TokenScope\tokenscope-data.json). The app and the MCP program both read and write it.
const fs = require("fs");
const path = require("path");

const EMPTY = () => ({ version: 1, favorites: [], settings: {}, jobs: [] });

function createStore(file) {
  let lastWritten = null;

  function read() {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return EMPTY();
    }
    try {
      const data = JSON.parse(text);
      return {
        ...EMPTY(),
        ...data,
        favorites: Array.isArray(data.favorites) ? data.favorites : [],
        settings: data.settings && typeof data.settings === "object" ? data.settings : {},
        jobs: Array.isArray(data.jobs) ? data.jobs : [],
      };
    } catch {
      // Keep a broken file (for example after a bad hand edit) instead of overwriting it.
      fs.copyFileSync(file, file.replace(/\.json$/, `.broken-${Date.now()}.json`));
      return EMPTY();
    }
  }

  function write(data) {
    const text = JSON.stringify(data, null, 2);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, text);
    // Replace in one step so the other process never reads a half-written file.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, file);
        break;
      } catch (error) {
        if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
        const until = Date.now() + 50;
        while (Date.now() < until); // brief wait while Windows releases the file
      }
    }
    lastWritten = text;
  }

  // Read fresh, change, write: the other process may have changed the file in between.
  function update(change) {
    const data = read();
    const result = change(data);
    write(data);
    return result;
  }

  // Calls back when someone else (the AI, or a hand edit) changes the file.
  function watch(onChange) {
    fs.watchFile(file, { interval: 1000 }, () => {
      let text = null;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {}
      if (text !== null && text !== lastWritten) {
        lastWritten = text;
        onChange();
      }
    });
  }

  return { file, read, update, watch };
}

const newJobId = () => "job-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// The data file in a folder. Versions before Oct 18, 2026 called it my-data.json: rename it once.
function dataFile(folder) {
  const file = path.join(folder, "tokenscope-data.json");
  const old = path.join(folder, "my-data.json");
  try {
    if (!fs.existsSync(file) && fs.existsSync(old)) fs.renameSync(old, file);
  } catch {}
  return file;
}

module.exports = { createStore, dataFile, newJobId };
