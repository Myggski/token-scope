// Copies the MCP program the way the installed app does, then starts the copy and talks to it like
// an AI tool would. In 1.0.4 and 1.0.5 the copy missed a file (cursordb.js) and crashed on start
// ("MCP error -32000: Connection closed"), and it reported version 1.0.0, so it never measured costs.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { copyMcp } = require("./mcpcopy");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ts-mcpcopy-"));
const script = copyMcp(path.join(tmp, "mcp"));
const version = require("../package.json").version;

for (const file of fs.readdirSync(__dirname)) {
  if (file.endsWith(".js") && !file.endsWith(".test.js")) assert.ok(fs.existsSync(path.join(tmp, "mcp", "src", file)), `${file} is copied`);
}

const messages = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "opencode", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_jobs", arguments: {} } }, // loads every reader, Cursor's included
];

// Started from a folder outside the app, so nothing can be found from the app's own node_modules.
const data = path.join(tmp, "data");
const child = spawn(process.execPath, [script], { cwd: tmp, env: { ...process.env, HOME: tmp, USERPROFILE: tmp, APPDATA: tmp, TOKENSCOPE_DATA: data, NODE_PATH: "" } });
let out = "", err = "";
const replies = new Map();
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no answer in time. stderr: ${err}`)), 60000);
  child.stdout.on("data", (d) => {
    out += d;
    let i;
    while ((i = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id) replies.set(msg.id, msg);
      if (replies.size === 3) {
        clearTimeout(timer);
        resolve();
      }
    }
  });
  child.stderr.on("data", (d) => (err += d));
  child.on("exit", (code) => {
    clearTimeout(timer);
    if (replies.size < 3) reject(new Error(`the copied MCP program stopped (exit ${code}): ${err}`));
  });
});
for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");

done.then(() => {
  child.kill();
  assert.strictEqual(replies.get(1).result.serverInfo.version, version, "reports this version, not 1.0.0");
  assert.ok(replies.get(2).result.tools.some((t) => t.name === "estimate_plan"));
  assert.ok(!replies.get(3).error && !replies.get(3).result.isError, `list_jobs works: ${JSON.stringify(replies.get(3)).slice(0, 300)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("mcp copy tests passed");
}).catch((error) => {
  child.kill();
  console.error(error.message);
  process.exit(1);
});
