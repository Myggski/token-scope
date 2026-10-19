// Checks reading Cursor's own chat names and sizes from its database (state.vscdb), in the shape
// Cursor 3.17 keeps them (seen in a user's database, Oct 2026), and that the sizes anchor the cost.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  console.log("cursor database tests skipped (this Node.js has no SQLite)");
  process.exit(0);
}
const { cursorChats } = require("./cursordb");
const { readCursor } = require("./history");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-cursordb-"));
const file = path.join(dir, "state.vscdb");
const db = new DatabaseSync(file);
db.exec(`CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT)`);
const chat = "3795c593-6cf4-454b-bdec-2e70609b7bbf";
const T = Date.UTC(2026, 9, 18, 20, 27);
const put = db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
db.prepare("INSERT INTO composerHeaders (composerId, lastUpdatedAt, isArchived) VALUES (?, ?, 1)").run(chat, T + 600e3);
put.run(`composerData:${chat}`, JSON.stringify({ composerId: chat, name: "Quest journal component bugs", contextTokensUsed: 157506, text: "never read" }));
const user = (id, req, size) => put.run(`bubbleId:${chat}:${id}`, JSON.stringify({ type: 1, bubbleId: id, requestId: req, text: "secret", ...(size ? { contextWindowStatusAtCreation: { tokensUsed: size, tokenLimit: 200000 } } : {}) }));
user("b1", "turn-1", null);
user("b2", "turn-2", 93497);
put.run(`bubbleId:${chat}:b3`, JSON.stringify({ type: 2, bubbleId: "b3", text: "reply" }));
put.run(`bubbleId:${chat}x:b9`, JSON.stringify({ type: 1, requestId: "other-chat", contextWindowStatusAtCreation: { tokensUsed: 5 } })); // a neighbouring key
db.close();

const info = cursorChats([chat, "unknown-chat"], { file });
assert.strictEqual(info.size, 1, "only chats Cursor has");
const q = info.get(chat);
assert.strictEqual(q.name, "Quest journal component bugs");
assert.strictEqual(q.end, 157506);
assert.strictEqual(q.archived, true, "archived in Cursor");
assert.deepStrictEqual([...q.turns], [["turn-2", 93497]], "sizes per message, nothing from other chats");
assert.ok(!JSON.stringify([...q.turns]).includes("secret"));
assert.strictEqual(cursorChats([chat], { file: path.join(dir, "missing.vscdb") }).size, 0, "no database: nothing");

// The sizes anchor the replay: turn 1 grows to what Cursor counted at turn 2.
const records = path.join(dir, "records");
fs.mkdirSync(records);
const rec = (s, e, gen, extra = {}) => ({ t: T + s * 1000, e, c: chat, gen, model: "claude-sonnet-5-5", ...extra });
fs.writeFileSync(path.join(records, "2026-10-18.jsonl"), [
  rec(0, "sessionStart", null),
  rec(20, "postToolUse", "turn-1", { tool: "Grep", in: 120, out: 40 }),
  rec(80, "afterAgentThought", "turn-1", { out: 400 }),
  rec(81, "postToolUse", "turn-1", { tool: "Grep", in: 140, out: 70 }),
  rec(81.5, "postToolUse", "turn-1", { tool: "Grep", in: 170, out: 90 }), // same batch: one request
  rec(90, "afterAgentResponse", "turn-1", { out: 800 }),
  rec(91, "stop", "turn-1"),
  rec(140, "afterAgentResponse", "turn-2", { out: 2000 }),
  rec(141, "stop", "turn-2"),
].map((r) => JSON.stringify(r)).join("\n") + "\n");
const models = [{ id: "anthropic/claude-sonnet-5.5", inPerM: 2, outPerM: 10, cachedPerM: 0.2, cacheWritePerM: 2.5 }];
const [named] = readCursor(models, 0, { folder: records, chats: (ids) => cursorChats(ids, { file }) });
const [plain] = readCursor(models, 0, { folder: records, chats: () => new Map() });
assert.strictEqual(named.title, "Quest journal component bugs");
assert.strictEqual(plain.title, "Cursor conversation");
assert.strictEqual(named.archived, true);
assert.strictEqual(named.models[0].requests, 4, "three requests in turn 1 (the batch counts once), one in turn 2");
assert.ok(named.cost > plain.cost * 1.5, "Cursor's real size makes the turn after it cost more");

fs.rmSync(dir, { recursive: true });
console.log("cursor database tests passed");
