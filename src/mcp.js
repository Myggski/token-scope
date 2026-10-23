// The MCP program's tools and protocol. Started by an AI tool through mcp-main.js.
// Talks JSON-RPC over stdin/stdout, one message per line. Everything stays on this computer.
const readline = require("readline");
const { sortRows } = require("./models");
const { estimateJob, cacheWhatIf, describePhase, applyCorrection, correction, validPlan, toolOfClient, DEFAULT_CACHE_HIT } = require("./estimate");
const { saveEstimate, recordActual, finishJob, continueJob, deleteJob, similarJobs, describeJob } = require("./jobs");
const { activeTime, breakMinutes } = require("./activity");

// How long something happened in a conversation, breaks longer than the app's setting left out.
function activeMinutes(c, breakAfter) {
  const { hours, approximate } = activeTime([c], breakAfter);
  return { minutes: Math.round(hours * 60), ...(approximate ? { minutes_from_start_to_end: true } : {}) };
}

const round = (value, digits = 4) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

const PLAN_FIELDS = {
  steps: { type: "number", description: "How many agent turns (tool calls and replies) the job should take if it goes to plan." },
  start_context_tokens: { type: "number", description: "Tokens in context before work starts: system prompt, instructions, files read up front. Roughly 4 characters or 0.75 words per token." },
  context_per_step_tokens: { type: "number", description: "Tokens added to context by each step's tool results: file reads, search hits, test output." },
  output_per_step_tokens: { type: "number", description: "Tokens the model writes per step: code, edits, explanations and reasoning." },
  rework_share: { type: "number", description: "Expected extra steps for fixes and retries, as a share of the planned steps. Default 0.2 (20%)." },
  cache_hit_rate: { type: "number", description: `Share (0-1) of re-sent context read from the provider's cache, the biggest single factor in the cost. Caches expire after 5-60 minutes without use. Guide: 0.97 for one unbroken session with no builds; 0.9 (the default) for normal work with builds, tests and short waits; 0.75 for long builds, reviews or waiting for the user; 0.6 for many short sessions or model switches. A phase's own value wins over the job-level one.` },
};

const TOOLS = [
  {
    name: "list_models",
    description: "List AI models with current prices from OpenRouter (USD per 1M tokens), context window, release date, shutdown date, capability score (Epoch AI's Capabilities Index. It measures general ability, not coding in particular. Higher is more capable, and a few points is a big difference. It's null when Epoch AI hasn't scored the model) and whether the user starred it as a favorite. Use it to find model ids for the other tools.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Text to match in the model name, provider or id." },
        provider: { type: "string", description: "Only this provider, for example Anthropic." },
        favorites_only: { type: "boolean", description: "Only the user's favorites." },
        max_blended_price: { type: "number", description: "Highest blended price per 1M tokens (3 input : 1 output)." },
        min_context: { type: "number", description: "Smallest context window in tokens." },
        sort: { type: "string", enum: ["buck", "cost", "newest", "capable"], description: "buck = more capable and cheaper first, models without a capability score last, newest first (default), cost = cheapest first, newest = latest release first, capable = highest capability score first." },
        limit: { type: "number", description: "Most models to return. Default 20, max 200." },
      },
    },
  },
  {
    name: "estimate_plan",
    description: "Estimate what a planned agent job (for example a coding task) will cost, as a low / likely / high range in USD per model. Plan the job first, then call this ONCE for the whole plan with your best guess of its size. If the plan has phases (or parts done in separate sessions), pass them as phases in this one call, not one call per phase. Accounts for the agent re-sending its growing context every step and for cached input, and is adjusted by how far the user's past estimates were off. Saves the plan as one job unless save is false. Afterwards call finish_job with the returned job_id.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", description: "Short name for the whole job, for example 'Loot/XP simulator'." },
        ...PLAN_FIELDS,
        phases: {
          type: "array",
          description: "For a plan in phases: one entry per part, each run by its own agent (a separate session, a parallel agent or a subagent), priced with its own context. Use this instead of the top-level size fields. Leave it out for a simple plan.",
          items: { type: "object", required: ["name", "steps", "start_context_tokens", "context_per_step_tokens", "output_per_step_tokens"], properties: { name: { type: "string" }, ...PLAN_FIELDS } },
        },
        model_ids: { type: "array", items: { type: "string" }, description: "Models to compare, ids or names (for example 'claude-opus-5.5'). Put the model the job is planned to run on first. Use the models the user named. If they named none, leave this out to use their favorites; if they have no favorites, you must pass the model you are running on plus the one or two others realistic for this job." },
        save: { type: "boolean", description: "Save the estimate on the Plans tab in TokenScope. Default true." },
        note: { type: "string", description: "One or two sentences about the plan." },
      },
    },
  },
  {
    name: "record_actual",
    description: "Only for jobs whose real cost TokenScope can't measure itself: record what a job really cost, so future estimates learn from it. TokenScope measures jobs in Claude Code, Codex, OpenCode and Zed by itself, and in Cursor when the user switched on Cursor tracking; use finish_job for those. Give job_id from estimate_plan (or list_jobs); without it a new job is saved. Give cost_usd, or token counts to price at today's rates.",
    inputSchema: {
      type: "object",
      required: ["model_id"],
      properties: {
        job_id: { type: "string" },
        title: { type: "string", description: "Job name, used when there is no job_id." },
        model_id: { type: "string", description: "The model the job actually ran on." },
        cost_usd: { type: "number", description: "Total cost in USD, if known (for example from Claude Code's /cost)." },
        input_tokens: { type: "number", description: "All input tokens, including cached." },
        cached_tokens: { type: "number", description: "Of the input tokens, how many were read from cache." },
        output_tokens: { type: "number" },
        note: { type: "string", description: "What happened, for example 'needed two extra rounds of test fixes'." },
      },
    },
  },
  {
    name: "finish_job",
    description: "Call when a job estimated with estimate_plan is done. TokenScope then measures its real cost by itself: exactly in Claude Code, Codex and OpenCode, approximately in Cursor (when the user switched on Cursor tracking), from the estimate up to this call. In Zed it's the whole conversation's exact cost, as Zed keeps one total per conversation: suggest a new chat for each plan.",
    inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } },
  },
  {
    name: "delete_job",
    description: "Delete a saved job, for example a duplicate or one saved by mistake. Only when the user asks, or after they confirm. Find ids with list_jobs.",
    inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } },
  },
  {
    name: "continue_job",
    description: "Call at the start of a new session when you pick up a job estimated earlier (find it with list_jobs), so its cost in this session counts towards the same job. Also reopens a job that was finished.",
    inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } },
  },
  {
    name: "list_jobs",
    description: "The user's saved jobs, newest first: plan, estimates, actual cost and how actual compared with the estimate. Also returns the current correction factor.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "Default 20." } } },
  },
  {
    name: "get_history",
    description: "The user's AI conversations from TokenScope's Spending tab (Claude Code, Codex, OpenCode, Zed and Cursor, only the tools the user switched on; Zed conversations have totals only, without cost drivers or facts): what each cost, on which models, and facts about what happened in it. Use it when the user asks why their AI work cost what it did or what could be improved. TokenScope gives facts only; working out the reasons and suggestions is up to you. Facts per conversation: cost_drivers_usd (the work itself, cache expiries during the user's pauses, during commands, after switching model or agent mid-conversation, of unknown cause, and large tool outputs re-read by every later step), cache_expiries (when the provider's cache ran out and what it cost), compactions (how often the context was summarized to make room, after which the conversation starts over from the summary), large_outputs (big tool results and what re-reading them cost), tool_use counts (edits, reads, builds, tests), build_and_test_minutes, files_read_several_times, peak context size, cost of the first and second half, the user's longest pause, and helper agents' cost. minutes is the time something happened in a conversation, with gaps longer than the user's break setting (20 minutes by default) left out; minutes_from_start_to_end marks conversations where only the start and end are known. Look for patterns across conversations, attribute each to the user's habits, the AI's way of working or slow tools, estimate what changing it would save, and suggest concrete, reasonable changes.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How far back to look. Default 30." },
        conversation: { type: "string", description: "Only conversations whose title or project contains this text." },
        limit: { type: "number", description: "How many conversations to return, most expensive first. Default 10, max 50." },
      },
    },
  },
  {
    name: "set_favorite",
    description: "Star or unstar a model as one of the user's favorites. It shows in the TokenScope window right away. Only do this when the user asks.",
    inputSchema: { type: "object", required: ["model_id", "favorite"], properties: { model_id: { type: "string" }, favorite: { type: "boolean" } } },
  },
];

function findModel(models, query) {
  const q = String(query || "").trim().toLowerCase();
  const exact = models.find((m) => m.id.toLowerCase() === q) || models.find((m) => m.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  const hint = partial.slice(0, 8).map((m) => m.id).join(", ");
  throw new Error(partial.length ? `"${query}" matches several models: ${hint}. Use an exact id.` : `No model matches "${query}". Use list_models to find ids.`);
}

function describeModel(m, favorites) {
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    input_per_1m: round(m.inPerM),
    output_per_1m: round(m.outPerM),
    cached_input_per_1m: round(m.cachedPerM),
    blended_per_1m: round(m.blended),
    context_tokens: m.context,
    released: m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : null,
    // Epoch AI's Capabilities Index (CC BY 4.0): general ability, not coding-specific. null: no score.
    capability: m.capability ? Math.round(m.capability.score) : null,
    shuts_down: m.retires || null,
    favorite: favorites.has(m.id),
  };
}

// The models to price: the ones asked for, else the user's favorites. Never a guess: cheap models
// nobody would use for the job only make the estimate misleading.
function pickModels(models, ids, favorites) {
  if (ids && ids.length) {
    const picked = ids.map((id) => findModel(models, id));
    return picked.filter((m, i) => picked.findIndex((o) => o.id === m.id) === i);
  }
  const favs = models.filter((m) => favorites.has(m.id));
  if (favs.length) return favs;
  throw new Error("Which models should this be priced on? Pass model_ids: the model(s) the user named, or the model you are running on plus the one or two others realistic for this job. (The user can also star favorites in TokenScope to make them the default.)");
}

// A ready-made "plan, then estimate" command. Tools that support MCP prompts show it in their
// command menu (Claude Code: /mcp__tokenscope__estimate, Cursor: /estimate).
const PROMPTS = [
  {
    name: "estimate",
    title: "Plan and estimate",
    description: "Plan a coding task (or use the plan you already have) without changing anything, then estimate what it will cost on your favorite models with TokenScope.",
    arguments: [
      { name: "task", description: "What you want done. Leave empty to use the plan you already have, or to describe it afterwards.", required: false },
      { name: "models", description: "Models to compare, planned one first, for example: Opus 5.5, Sonnet 5.5. Leave empty to use your favorites.", required: false },
    ],
  },
];

function estimatePrompt(task, models) {
  const what = task && task.trim() ? `this task: ${task.trim()}` : "the task we're discussing (if there's no plan or task yet, ask me what it is first)";
  const which = models && models.trim()
    ? `Compare these models, with the first as the planned one: ${models.trim()}.`
    : "Compare the models I mention. If I mention none, leave model_ids out to use my TokenScope favorites. If TokenScope says I have none, use the model you're running on plus the one or two others realistic for this kind of work.";
  return `Plan ${what}

1. If we already have a plan in this conversation, or I pasted one, use that. Otherwise read what you need and write a short plan: the steps you'll take and the files involved. Don't change anything yet.
2. Call the TokenScope estimate_plan tool once for the whole plan, with a short title and your best guess of its size. If the plan has phases, pass them as phases in that one call. Set cache_hit_rate lower than the default for work with long pauses (like builds), model switches or many short sessions. ${which}
3. Show me the plan, then the estimate as a short table: each model with its likely cost and range (and per phase, if there are phases). Below it, list the assumptions TokenScope returns (steps, sizes and cache misses), and the likely cost with more cache misses. If TokenScope warns about a possible duplicate, ask me whether to delete the old job. Then wait for me to say go, and which model to use if I want to switch.
4. If the work continues in a new session later, call continue_job with the job id at the start of it. When all the work is done, call finish_job with the job id, so TokenScope can measure what it really cost.`;
}

function createHandlers({ store, getModels, sync = async () => {}, client = () => null, history = null }) {
  const favoritesOf = () => new Set(store.read().favorites);

  return {
    async list_models(args) {
      const favorites = favoritesOf();
      const query = (args.search || "").toLowerCase();
      let rows = (await getModels()).filter((m) =>
        (!query || `${m.name} ${m.provider} ${m.id}`.toLowerCase().includes(query)) &&
        (!args.provider || m.provider.toLowerCase() === String(args.provider).toLowerCase()) &&
        (!args.favorites_only || favorites.has(m.id)) &&
        (args.max_blended_price === undefined || m.blended <= args.max_blended_price) &&
        (args.min_context === undefined || (m.context || 0) >= args.min_context));
      rows = sortRows(rows, ["buck", "cost", "newest", "capable"].includes(args.sort) ? args.sort : "buck");
      const limit = Math.min(200, Math.max(1, args.limit || 20));
      return { total_matching: rows.length, models: rows.slice(0, limit).map((m) => describeModel(m, favorites)) };
    },

    async estimate_plan(args) {
      const phase = (a) => ({
        ...(a.name ? { name: a.name } : {}),
        steps: a.steps,
        startContext: a.start_context_tokens,
        contextPerStep: a.context_per_step_tokens,
        outputPerStep: a.output_per_step_tokens,
        rework: a.rework_share ?? args.rework_share ?? 0.2,
        cacheHit: a.cache_hit_rate ?? args.cache_hit_rate ?? DEFAULT_CACHE_HIT,
      });
      const plan = Array.isArray(args.phases) && args.phases.length ? { phases: args.phases.map(phase) } : phase(args);
      if (!validPlan(plan)) throw new Error("Give the size of the job (steps 1 or more; token sizes and rework_share 0 or more), either at the top level or for every phase.");
      const picked = pickModels(await getModels(), args.model_ids, favoritesOf());
      await sync(); // so the correction includes the latest real costs
      const before = store.read().jobs;
      const tool = toolOfClient(client());
      const fix = correction(before, tool); // learned from this tool's own plans when it has 2 or more
      const duplicates = similarJobs(before, args.title);
      const job = args.save === false ? null : saveEstimate(store, { title: args.title, plan, models: picked, source: "ai", client: client(), note: args.note, correction: fix });
      // In the order given: the first model is the planned one.
      const estimates = picked.map((m, i) => {
        const raw = estimateJob(m, plan);
        const e = applyCorrection(raw, fix.factor);
        return {
          model_id: m.id,
          name: m.name,
          ...(i === 0 ? { planned: true } : {}),
          low_usd: round(e.low),
          likely_usd: round(e.likely),
          high_usd: round(e.high),
          likely_tokens: e.tokens,
          ...(raw.phases ? { phases: raw.phases.map((p) => ({ name: p.name, likely_usd: round(p.likely * fix.factor), low_usd: round(p.low * fix.factor), high_usd: round(p.high * fix.factor) })) } : {}),
          if_cache_misses_were: (cacheWhatIf(m, plan) || []).map((w, i) => ({ situation: ["smooth, one unbroken session", "long pauses (builds, waiting for the user)", "many restarts (new chats, model switches)"][i], cache_miss_rate: round(1 - w.cacheHit, 2), likely_usd: round(w.likely * fix.factor) })),
          ...(e.fitsContext ? {} : { warning: `Needs about ${e.peakContext} tokens of context by the end of a session; this model has ${m.context}. The agent would have to compact or restart, which changes the cost.` }),
        };
      });
      const phases = plan.phases || [plan];
      return {
        job_id: job ? job.id : null,
        ...(duplicates.length ? { possible_duplicate: {
          jobs: duplicates.map((d) => ({ job_id: d.id, title: d.title, created: d.createdAt })),
          note: "Recent jobs with a similar name exist. If this estimate replaces them, ask the user whether to delete the old ones with delete_job, so the job list doesn't count the same work twice.",
        } } : {}),
        assumptions: {
          summary: phases.map((p, i) => `${plan.phases ? `${p.name || `Phase ${i + 1}`}: ` : ""}${describePhase(p)}`),
          cache_note: "Cache misses decide most of the cost: re-sent context the provider no longer has cached is paid in full. See if_cache_misses_were per model for the likely cost when work is smooth (3% misses), has long pauses (25%) or many restarts (50%). When talking to the user, say 'cache misses' (the share of re-reading paid in full), not hit rates.",
          range_note: "likely = the planned steps plus the rework share. low = no rework and 20% smaller steps. high = 50% more steps than likely and 25% bigger steps, at the same cache hit rate (more cache misses are in if_cache_misses_were). Plan a budget with high; expect around likely.",
          model_note: "The same plan is priced on every model: only the token prices differ. A weaker model often needs more steps and fixes for the same job, which this doesn't include, so treat cheaper models' figures as a best case.",
          tokens_note: "likely_tokens: input = everything sent, including re-sent context; cached = re-sent context served from the cache (cheap); written = new context plus re-sent context the cache had lost, charged at the cache-write price, which can be more than normal input; output = what the model writes.",
          show_to_user: "Show these assumptions with the estimate, so whoever reads it can see what it rests on.",
        },
        correction: fix.applied
          ? fix.tool
            ? `Adjusted by ${round(fix.factor, 2)}x, from ${fix.jobs} finished jobs that ran in this same tool (each tool is corrected from its own jobs, as tools differ a lot in how many requests the same work takes).`
            : `Adjusted by ${round(fix.factor, 2)}x, from ${fix.jobs} past jobs with exact real costs (this tool doesn't have 2 finished jobs of its own yet).`
          : `Not adjusted yet: needs 2 finished jobs from this tool, or 2 with an exact real cost from any tool (has ${fix.jobs}).`,
        estimates,
        next: job ? `Show the user the likely cost and range per model. If the work continues in another session, call continue_job with job_id "${job.id}" there first. When all of it is done, call finish_job with that job_id. In Claude Code, Codex, OpenCode and Zed, and in Cursor with tracking on, the real cost is measured automatically. Elsewhere, use record_actual.` : null,
      };
    },

    async record_actual(args) {
      const model = findModel(await getModels(), args.model_id);
      const job = recordActual(store, {
        jobId: args.job_id, title: args.title, model, costUsd: args.cost_usd,
        inputTokens: args.input_tokens, cachedTokens: args.cached_tokens, outputTokens: args.output_tokens,
        source: "ai", note: args.note,
      });
      const fix = correction(store.read().jobs, toolOfClient(client()));
      return { job: describeJob(job), correction_now: fix.applied ? round(fix.factor, 2) : null, jobs_with_actuals: fix.jobs };
    },

    async finish_job(args) {
      finishJob(store, args.job_id);
      await sync();
      const job = store.read().jobs.find((j) => j.id === args.job_id);
      return {
        job: describeJob(job),
        measured: job.actual && job.actual.source === "claude-code"
          ? "Real cost measured from the Claude Code session log."
          : job.actual && job.actual.source === "codex" ? "Real cost measured from the Codex session log."
          : job.actual && job.actual.source === "opencode" ? "Real cost measured from OpenCode's records."
          : job.actual && job.actual.source === "cursor-hook" ? "Real cost measured approximately from TokenScope's Cursor records."
          : job.actual && job.actual.source === "zed" ? "Real cost measured exactly from Zed, for the whole conversation (Zed keeps one total per conversation)."
          : "TokenScope couldn't measure this job (it measures Claude Code, Codex, OpenCode and Zed, and Cursor when tracking is on). If you know the cost, record it with record_actual.",
      };
    },

    async delete_job(args) {
      const job = deleteJob(store, args.job_id);
      return { deleted: { job_id: job.id, title: job.title } };
    },

    async continue_job(args) {
      const job = continueJob(store, args.job_id);
      return { job: describeJob(job), next: `Work on "${job.title}" now counts towards this job. When it's all done, call finish_job with job_id "${job.id}".` };
    },

    async list_jobs(args) {
      await sync();
      const { jobs } = store.read();
      const fix = correction(jobs, toolOfClient(client()));
      return {
        correction_factor: fix.applied ? round(fix.factor, 2) : null,
        jobs_with_actuals: fix.jobs,
        jobs: [...jobs].reverse().slice(0, Math.max(1, args.limit || 20)).map(describeJob),
      };
    },

    async get_history(args) {
      if (!history) throw new Error("History isn't available here.");
      const tracked = Object.entries(store.read().tracking || {}).filter(([, on]) => on).map(([id]) => id);
      const breakAfter = breakMinutes(store.read().settings.breakMinutes);
      if (!tracked.length) {
        return { tracking: [], note: "No AI tools are tracked yet. The user can switch them on in TokenScope under Settings, Track AI spending. Nothing is recorded until they do." };
      }
      const days = Math.max(1, args.days || 30);
      const { conversations, warnings } = await history(days);
      let list = conversations;
      if (args.conversation) {
        const q = String(args.conversation).toLowerCase();
        list = list.filter((c) => `${c.title} ${c.project || ""}`.toLowerCase().includes(q));
      }
      const top = [...list].sort((a, b) => b.cost - a.cost).slice(0, Math.min(50, Math.max(1, args.limit || 10)));
      const r2 = (v) => round(v, 2);
      return {
        tracking: tracked,
        period_days: days,
        total_usd: r2(list.reduce((sum, c) => sum + c.cost, 0)),
        conversations_count: list.length,
        approximate: list.some((c) => c.approximate),
        ...(warnings.length ? { data_warnings: warnings.map((w) => w.message) } : {}),
        conversations: top.map((c) => {
          const f = c.insights ? c.insights.facts : {};
          return {
            title: c.title, tool: c.tool, project: c.project, started: new Date(c.start).toISOString(), ...activeMinutes(c, breakAfter),
            cost_usd: r2(c.cost), approximate: c.approximate, share_of_input_paid_full_price: c.fullPriceShare === null ? null : round(c.fullPriceShare, 3),
            models: c.models.map((m) => ({ model: m.modelId || m.model, ...(m.free ? { free_variant_of: m.nameId } : {}), requests: m.requests, input_tokens: Math.round(m.input), output_tokens: Math.round(m.output), cost_usd: m.cost === null ? null : r2(m.cost) })),
            cost_drivers_usd: c.insights ? { the_work: r2(c.insights.drivers.work), cache_expired_in_user_pauses: r2(c.insights.drivers.pausesYou), cache_expired_during_commands: r2(c.insights.drivers.pausesTools), cache_lost_switching_model_or_agent: r2(c.insights.drivers.switches || 0), cache_expired_other: r2(c.insights.drivers.otherMisses), large_outputs_reread: r2(c.insights.drivers.bigOutputs) } : null,
            facts: c.insights ? {
              steps: f.steps, cache_minutes: f.cacheMinutes, cache_expiries: f.cacheExpiries, compactions: f.compactions || 0, large_outputs_count: f.largeOutputsCount, large_outputs: f.largeOutputs,
              tool_use: f.toolUse, build_and_test_minutes: f.buildAndTestMinutes, files_read_several_times: f.filesReadSeveralTimes,
              peak_context_tokens: f.peakContextTokens, first_half_cost_usd: f.firstHalfCostUsd, second_half_cost_usd: f.secondHalfCostUsd,
              user_replies: f.userReplies, longest_user_pause_minutes: f.longestUserPauseMinutes, helper_agents_cost_usd: f.helperCost,
            } : null,
          };
        }),
        note: "Costs use today's pay-per-token prices; with a subscription they show what the work would have cost. 'approximate' (Cursor) costs are rebuilt from step sizes. OpenCode has no tool or pause details, only per-reply token counts. The facts are measurements, not conclusions: reason about them yourself before suggesting changes.",
      };
    },

    async set_favorite(args) {
      const model = findModel(await getModels(), args.model_id);
      store.update((data) => {
        const set = new Set(data.favorites);
        if (args.favorite) set.add(model.id);
        else set.delete(model.id);
        data.favorites = [...set];
      });
      return { model_id: model.id, favorite: !!args.favorite };
    },
  };
}

function startMcp({ store, getModels, sync, history, version, input = process.stdin, output = process.stdout, onClose = () => {} }) {
  let clientName = null; // the AI app that connected (for example "cursor" or "claude-code"), saved with each job
  const handlers = createHandlers({ store, getModels, sync, history, client: () => clientName });
  const send = (message) => output.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

  async function handle(message) {
    const { id, method, params = {} } = message;
    if (id === undefined) return; // notifications, like notifications/initialized
    if (method === "initialize") {
      clientName = (params.clientInfo && params.clientInfo.name) || null;
      // Remembers which AI tools have connected, so the app can stop asking you to connect one.
      try {
        store.update((data) => {
          data.connections = { ...(data.connections || {}), [clientName || "unknown"]: { lastSeen: new Date().toISOString() } };
        });
      } catch (error) {
        console.error("Couldn't save the connection:", error.message);
      }
      return send({ id, result: {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "tokenscope", version },
        instructions: "TokenScope has current AI model prices and the user's own job history. In the app, estimated jobs are on the Plans tab and every conversation's cost is on the Spending tab; use those names when you talk to the user. When the user asks what a task will cost (or uses the estimate prompt), plan it first without changing anything (or use the plan you already have), then call estimate_plan ONCE for the whole plan and show the likely cost per model. A simple plan is sent as one size. A plan split into phases or separate agents (subagents, parallel agents, later sessions) is still one job: pass each part as a phase in that same call. Price it on the models the user names, planned one first; if they name none, their favorites are used. Whenever work on an estimated job starts in a new session or by a separate agent, call continue_job with its job id first. When all the work is done, call finish_job. In Claude Code, Codex, OpenCode and Zed the real cost is then measured automatically from their own records (subagents included; in Zed for the whole conversation), and estimates improve from it. Cache hits drive most of the cost: set cache_hit_rate lower than the default when the work has long pauses, model switches or many short sessions, and show the user the assumptions and the 'if cache misses were' numbers with the estimate (talk about cache misses, the share paid in full, not hit rates). When the user asks why their AI work cost what it did, or what could be improved, call get_history and reason about its facts yourself.",
      } });
    }
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") return send({ id, result: { tools: TOOLS } });
    if (method === "prompts/list") return send({ id, result: { prompts: PROMPTS } });
    if (method === "prompts/get") {
      if (params.name !== "estimate") return send({ id, error: { code: -32602, message: `Unknown prompt: ${params.name}` } });
      const text = estimatePrompt((params.arguments || {}).task, (params.arguments || {}).models);
      return send({ id, result: { description: PROMPTS[0].description, messages: [{ role: "user", content: { type: "text", text } }] } });
    }
    if (method === "tools/call") {
      const handler = handlers[params.name];
      if (!handler) return send({ id, error: { code: -32602, message: `Unknown tool: ${params.name}` } });
      try {
        const result = await handler(params.arguments || {});
        return send({ id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result } });
      } catch (error) {
        return send({ id, result: { content: [{ type: "text", text: error.message }], isError: true } });
      }
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  const lines = readline.createInterface({ input });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: "Parse error" } });
    }
    handle(message).catch((error) => send({ id: message.id ?? null, error: { code: -32603, message: error.message } }));
  });
  lines.on("close", onClose);
}

module.exports = { startMcp, createHandlers, TOOLS, PROMPTS, estimatePrompt };
