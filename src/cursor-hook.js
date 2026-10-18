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

// The TokenScope tools whose results mark where a job starts and ends.
const JOB_TOOLS = { estimate_plan: "estimate", continue_job: "continue_job", finish_job: "finish_job" };

function record(input) {
  const e = input.hook_event_name;
  const r = { t: Date.now(), e, c: input.conversation_id || input.session_id || null, gen: input.generation_id || null, model: input.model_id || input.model || null };
  const acct = account(input.user_email);
  if (acct) r.acct = acct;
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
  } else if (e === "sessionStart") {
    const root = (input.workspace_roots || [])[0];
    if (root) r.project = path.basename(root); // the folder name only
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
    return null;
  }
  return r;
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  try {
    const r = folder && record(JSON.parse(raw));
    if (r) {
      fs.mkdirSync(folder, { recursive: true });
      const day = new Date(r.t).toISOString().slice(0, 10);
      fs.appendFileSync(path.join(folder, `${day}.jsonl`), JSON.stringify(r) + "\n");
    }
  } catch {}
  process.stdout.write("{}\n");
  process.exit(0);
});
setTimeout(() => process.exit(0), 3000); // never hang Cursor
