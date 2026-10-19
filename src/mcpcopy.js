// Copies the MCP program out of the installed app into a folder that never moves (see main.js
// mcpScript). Every script in src/ is copied, tests left out, so a new file can never be
// forgotten: in 1.0.4 and 1.0.5 a hand-kept list missed cursordb.js and the MCP program crashed
// on start. mcpcopy.test.js starts the copied program to check this.
const fs = require("fs");
const path = require("path");

function copyMcp(target, appDir = path.join(__dirname, "..")) {
  const src = path.join(appDir, "src");
  fs.mkdirSync(path.join(target, "src"), { recursive: true });
  fs.mkdirSync(path.join(target, "data"), { recursive: true });
  for (const file of fs.readdirSync(src)) {
    if (!file.endsWith(".js") || file.endsWith(".test.js")) continue;
    fs.writeFileSync(path.join(target, "src", file), fs.readFileSync(path.join(src, file)));
  }
  fs.writeFileSync(path.join(target, "data", "openrouter-snapshot.json"), fs.readFileSync(path.join(appDir, "data", "openrouter-snapshot.json")));
  // package.json: the MCP program reports its version from it.
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "tokenscope-mcp", version: require(path.join(appDir, "package.json")).version, private: true }));
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

module.exports = { copyMcp };
