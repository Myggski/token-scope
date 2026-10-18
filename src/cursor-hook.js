// TokenScope's Cursor hook. Cursor runs this at each step of a conversation and passes the step as
// JSON on stdin. It writes one small line with sizes and ids to TokenScope's history folder.
// It never stores content: no prompts, code, file contents, commands or replies, only how long
// they were. It must never get in Cursor's way, so every error is swallowed and it exits quickly.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const folder = process.argv[2];
let commandKind = () => "other";
try {
  ({ commandKind } = require("./insights"));
} catch {}

const size = (value) => (value === undefined || value === null ? 0 : typeof value === "string" ? value.length : JSON.stringify(value).length);

// Which Cursor account a step belongs to, as a scrambled code: the same account always gives the
// same 8 characters, and the email can't be read back from it. Not used yet; it's recorded so
// conversations from different accounts on one computer can be told apart later, if needed.
const account = (email) => (email ? crypto.createHash("sha256").update(`tokenscope:${String(email).trim().toLowerCase()}`).digest("hex").slice(0, 8) : null);

// The steps TokenScope asks Cursor for (see cursorhook.js). Anything else means Cursor renamed them.
const KNOWN = new Set(["sessionStart", "sessionEnd", "afterFileEdit", "postToolUse", "afterAgentResponse", "afterAgentThought", "subagentStart", "subagentStop", "preCompact", "afterMCPExecution", "afterShellExecution", "stop"]);

// Noted once per name and day, so a renamed step can't fill the log.
function unknownEvent(name, input) {
  try {
    const os = require("os");
    const seen = path.join(os.tmpdir(), `tokenscope-cursor-unknown-${new Date().toISOString().slice(0, 10)}-${String(name).replace(/[^\w-]/g, "_").slice(0, 40)}`);
    if (fs.existsSync(seen)) return;
    fs.writeFileSync(seen, "");
  } catch {}
  problem({ problem: `Cursor sent a step TokenScope doesn't know ("${name}")`, fields: Object.keys(input).slice(0, 30) });
}

// The TokenScope tools whose results mark where a job starts and ends.
const JOB_TOOLS = { estimate_plan: "estimate", continue_job: "continue_job", finish_job: "finish_job" };

function record(input) {
  const e = input.hook_event_name;
  const r = { t: Date.now(), e, c: input.conversation_id || input.session_id || null, gen: input.generation_id || null, model: input.model_id || input.model || null };
  const acct = account(input.user_email);
  if (acct) r.acct = acct;
  // The project folder's name (never the path), on every step: a chat continued from before
  // tracking was on has no sessionStart step to take it from.
  const root = Array.isArray(input.workspace_roots) && input.workspace_roots[0];
  if (root) r.project = String(root).split(/[\\/]+/).filter(Boolean).pop() || null;
  if (e === "postToolUse") {
    r.tool = input.tool_name;
    r.in = size(input.tool_input);
    r.out = size(input.tool_output);
    if (typeof input.duration === "number") r.ms = input.duration;
  } else if (e === "afterShellExecution") {
    r.kind = commandKind(input.command); // build, test or other: the command itself is not kept
    if (typeof input.duration === "number") r.ms = input.duration;
  } else if (e === "afterAgentResponse" || e === "afterAgentThought") {
    r.out = size(input.text);
  } else if (e === "subagentStart") {
    r.sub = input.subagent_id || null;
    r.subModel = input.subagent_model || null;
  } else if (e === "subagentStop") {
    r.steps = input.tool_call_count || 0;
    r.messages = input.message_count || 0;
  } else if (e === "preCompact") {
    r.ctx = input.context_tokens || null;
  } else if (e === "afterFileEdit") {
    // Only how much changed: the text added and the text replaced, counted in characters.
    // Cursor reports whole files on its edit tool, so this is the real size of an edit.
    const edits = Array.isArray(input.edits) ? input.edits : [];
    r.out = edits.reduce((n, x) => n + size(x && x.new_string), 0);
    r.del = edits.reduce((n, x) => n + size(x && x.old_string), 0);
    r.edits = edits.length;
  } else if (e === "sessionStart") {
    // The project is noted above, as on every step.
  } else if (e === "afterMCPExecution") {
    // Only TokenScope's own job tools are noted, to link this conversation to the job.
    const action = JOB_TOOLS[input.tool_name];
    if (!action || !/tokenscope/i.test(input.mcp_server_name || "")) return null;
    const text = typeof input.result_json === "string" ? input.result_json : JSON.stringify(input.result_json || "");
    let fromInput = null;
    try {
      fromInput = (typeof input.tool_input === "string" ? JSON.parse(input.tool_input) : input.tool_input || {}).job_id || null;
    } catch {}
    const match = text.match(/job-[a-z0-9]{8,}/);
    r.job = fromInput || (match && match[0]) || null;
    r.action = action;
    if (!r.job) return null;
  } else if (e !== "sessionEnd" && e !== "stop") {
    if (!KNOWN.has(e)) unknownEvent(e, input);
    return null;
  }
  return r;
}

// Problems are written down instead of hidden, so TokenScope can show them under Track AI spending.
// Only what went wrong is noted (the event name, which fields were sent, sizes, the error), never content.
// The note goes next to the launcher (<data folder>\hooks), else to the temp folder, and to stderr,
// which Cursor shows in its hooks output.
function problem(details) {
  const line = JSON.stringify({ t: Date.now(), ...details }) + "\n";
  try {
    process.stderr.write(`TokenScope hook: ${line}`);
  } catch {}
  const os = require("os");
  const places = [folder && path.join(folder, "..", "..", "hooks"), os.tmpdir()].filter(Boolean);
  for (const dir of places) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "cursor-hook-problems.log");
      // Kept small: when it grows past 50 kB, it starts over.
      if (fs.existsSync(file) && fs.statSync(file).size > 50e3) fs.writeFileSync(file, "");
      fs.appendFileSync(file, line);
      return;
    } catch {}
  }
}

// Cursor's step as JSON. Leading byte-order marks and spaces are ignored.
const parse = (text) => JSON.parse(text.replace(/^\uFEFF/, "").trim());

// Cursor's input as text: UTF-8 normally, UTF-16 if it starts with a UTF-16 mark or is full of zero bytes.
let bytes = Buffer.alloc(0);
let raw = "";
const decode = (buf) => {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString("utf16le");
  if (buf.length > 1 && buf.filter((b) => b === 0).length > buf.length / 4) return buf.toString("utf16le");
  return buf.toString("utf8");
};
let done = false;
// Saves the step once it has all arrived: when Cursor closes the input, or as soon as the input
// is complete JSON (Cursor may keep the input open until the hook answers), or after 3 seconds.
function finish(reason) {
  if (done) return;
  done = true;
  let input = null;
  try {
    input = parse(raw);
  } catch (error) {
    problem({ problem: "couldn't read Cursor's step", reason, bytes: raw.length, startsWith: JSON.stringify(raw.slice(0, 1)), error: error.message });
  }
  if (input) {
    try {
      if (!folder) throw new Error("no records folder given");
      const r = record(input);
      if (r) {
        fs.mkdirSync(folder, { recursive: true });
        const day = new Date(r.t).toISOString().slice(0, 10);
        fs.appendFileSync(path.join(folder, `${day}.jsonl`), JSON.stringify(r) + "\n");
      } else if (!input.hook_event_name) {
        problem({ problem: "Cursor's step has no event name", fields: Object.keys(input).slice(0, 30) });
      }
    } catch (error) {
      problem({ problem: "couldn't save the record", event: input.hook_event_name || null, folder, error: error.message, code: error.code || null });
    }
  }
  process.stdout.write("{}\n");
  process.exit(0);
}
process.stdin.on("data", (chunk) => {
  bytes = Buffer.concat([bytes, chunk]);
  raw = decode(bytes);
  try {
    parse(raw);
    finish("complete");
  } catch {} // not all there yet
});
process.stdin.on("end", () => finish("end"));
process.stdin.on("error", (error) => {
  problem({ problem: "couldn't read Cursor's step", error: error.message });
  finish("error");
});
setTimeout(() => finish("timeout"), 3000); // never hang Cursor
