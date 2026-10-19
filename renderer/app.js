const { sortRows } = window.Models;
const { correction, cacheWhatIf } = window.Estimate;
const api = window.tokenscope;

const SORTS = ["buck", "cost", "newest"];
const SORT_NOTES = {
  buck: "Newer and cheaper models first. Newer isn't always better.",
  cost: "Lowest price first, counting 3 tokens read for every token written.",
  newest: "Most recently released first.",
};
const OTHERS = "Others";
const FAVORITES = "★ Favorites"; // a chip like the providers, matching the user's starred models
const MAX_PROVIDER_CHIPS = 8; // plus All, Favorites and Others, this fits one line in the default window
const VIEWS = ["models", "jobs", "history", "help"];
const PAGE = 20; // models shown at first, and added by each "Show more"
const PAGE_SMALL = 5; // rows shown at first in a Details list (subagents)

// Everything the user picks is saved in the data file (via the main process) and restored on the next launch.
const state = {
  models: [],
  providers: new Set(), // empty = all providers
  favorites: new Set(), // model ids
  jobs: [],
  connections: {}, // AI tools that have connected to TokenScope, by name, from the data file
  sort: "buck",
  tokensText: "1M",
  tokensMillions: 1,
  search: "",
  theme: "dark",
  view: "models",
  shown: PAGE, // how many models the list shows right now
  aiTool: null, // whose setup steps are open in Connect your AI tool; none at the start, not remembered
  openJobs: new Set(), // jobs whose Details are open, kept open when the list redraws
  history: null, // { conversations, keepDays, errors, warnings } from the last load
  sources: [], // the AI tools TokenScope can track, and whether they're on
  compareModels: null, // models a conversation is re-priced on in Spending; null = your favorites
  historyShown: PAGE,
  historySearch: "", // Spending's search (not remembered between launches)
  openConversations: new Set(),
  subagentsShown: new Map(), // conversation id -> how many subagent rows its Details show
  openSubagents: new Set(), // conversations whose subagent list is open
  warnings: { prices: [], history: [] }, // data format warnings, shown at the top
};

function save(key, value) {
  api.setSettings({ [key]: value }).catch(() => {}); // settings just won't be remembered
}

const $ = (id) => document.getElementById(id);
const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Plays a CSS animation again, even if the element already has it.
function replay(el, className) {
  if (!el) return;
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

// Table rows slide in one after another (only the first dozen wait, so long lists stay quick).
function animateRows(tbody, from = 0) {
  [...tbody.children].slice(from).forEach((row, i) => {
    row.style.animationDelay = `${Math.min(i, 12) * 18}ms`;
    replay(row, "row-in");
  });
}

// Accepts "500k", "1.5M" or a plain number of tokens. Returns millions, or null if invalid.
function parseTokens(text) {
  const match = String(text).trim().replace(/[ ,_]/g, "").match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  if (!match) return null;
  const unit = match[2].toLowerCase();
  return (Number(match[1]) * (unit === "k" ? 1e3 : unit === "m" ? 1e6 : 1)) / 1e6;
}

function money(value) {
  if (value === null || value === undefined) return "–";
  value = Number(value.toPrecision(6)); // drop float noise, e.g. 0.09999999 -> 0.1
  if (value >= 100) return "$" + Math.round(value).toLocaleString("en-US");
  // Small prices keep two significant digits: $0.05, $0.075.
  return "$" + (value > 0 && value < 0.1 ? Number(value.toPrecision(2)) : value.toFixed(2));
}

function formatTokens(tokens) {
  if (tokens >= 1e6) return `${Math.round(tokens / 1e5) / 10}M`;
  return tokens >= 1e3 ? `${Math.round(tokens / 1e3)}k` : String(Math.round(tokens));
}

const formatContext = (tokens) => (tokens ? `${formatTokens(tokens)} context` : null);

function formatReleased(created) {
  if (!created) return null;
  return "Released " + new Date(created * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

const formatDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const modelName = (id) => (state.models.find((m) => m.id === id) || { name: id }).name;

// ---------- Models table ----------

// Chips for the providers with the most models; the rest share one "Others" chip.
function chipProviders() {
  const counts = new Map();
  for (const m of state.models) counts.set(m.provider, (counts.get(m.provider) || 0) + 1);
  return new Set([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_PROVIDER_CHIPS).map(([p]) => p));
}

function matchesSearch(m) {
  const query = state.search.trim().toLowerCase();
  return !query || `${m.name} ${m.provider} ${m.id}`.toLowerCase().includes(query);
}

function renderProviders(top) {
  const names = [...top].sort();
  if (state.models.some((m) => !top.has(m.provider))) names.push(OTHERS);
  const text = (label) => (label === FAVORITES ? "Favorites" : escape(label)); // one icon per chip: the box
  const chip = (label, pressed, extra = "") =>
    `<button type="button" class="chip check ${extra}" data-provider="${escape(label)}" aria-pressed="${pressed}">${text(label)}</button>`;
  $("providers").innerHTML = chip("All", state.providers.size === 0, "all") + chip(FAVORITES, state.providers.has(FAVORITES)) +
    names.map((p) => chip(p, state.providers.has(p))).join("");
}

// OpenRouter's expiration date marks when a provider shuts the model down.
function retirementNote(retires) {
  if (!retires) return "";
  const date = new Date(retires);
  if (isNaN(date)) return `<span class="retiring">⚠ Shutting down: ${escape(retires)}</span>`;
  const text = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const verb = date < new Date() ? "Shut down" : "Shuts down";
  return `<span class="retiring">⚠ ${verb} ${text}</span>`;
}

function favoriteCell(m) {
  const on = state.favorites.has(m.id);
  const label = `${on ? "Remove" : "Add"} ${m.name} ${on ? "from" : "to"} favorites`;
  return `<td class="fav-col"><button type="button" class="fav" data-fav="${escape(m.id)}" aria-pressed="${on}" aria-label="${escape(label)}" title="${on ? "Remove from favorites" : "Add to favorites"}">${on ? "★" : "☆"}</button></td>`;
}

function modelCell(m) {
  const details = [m.provider, formatReleased(m.created), formatContext(m.context)].filter(Boolean).join(" · ");
  return `<td><span class="model-name">${escape(m.name)}</span><span class="provider">${escape(details)}</span>${retirementNote(m.retires)}</td>`;
}

function priceCell(m) {
  const cached = m.cachedPerM === null ? "" : `<span class="sub-value">cached ${money(m.cachedPerM)}</span>`;
  return `<td class="num">${money(m.inPerM)} / ${money(m.outPerM)}${cached}</td>`;
}

// The budget is split like the blended price: 3 input (read) tokens for every output (written) token.
function spendCell(m) {
  const read = 0.75 * state.tokensMillions * m.inPerM;
  const write = 0.25 * state.tokensMillions * m.outPerM;
  return `<td class="num">${money(read + write)}<span class="sub-value">${money(read)} read · ${money(write)} write</span></td>`;
}

// animate: "all" after a filter or sort change, a number to animate rows added by "Show more".
function renderModels({ animate } = {}) {
  const top = chipProviders();
  // A saved provider may no longer have its own chip; drop it so nothing gets hidden without a way to undo it.
  if (state.models.length) {
    const before = state.providers.size;
    for (const p of state.providers) if (p !== OTHERS && p !== FAVORITES && !top.has(p)) state.providers.delete(p);
    if (state.providers.size !== before) save("providers", [...state.providers]);
  }
  // Picked chips add up: a model shows if it matches any of them.
  const inChips = (m) =>
    state.providers.size === 0 ||
    state.providers.has(top.has(m.provider) ? m.provider : OTHERS) ||
    (state.providers.has(FAVORITES) && state.favorites.has(m.id));
  const rows = state.models.filter((m) => inChips(m) && matchesSearch(m));
  // Best for the buck treats newer as better, since most models lack a quality score.
  sortRows(rows, state.sort);
  renderProviders(top);

  const visible = rows.slice(0, state.shown);
  $("rows").innerHTML = visible.length
    ? visible.map((m, i) => `
      <tr>
        <td class="rank">${i + 1}</td>
        ${favoriteCell(m)}
        ${modelCell(m)}
        ${priceCell(m)}
        ${spendCell(m)}
      </tr>`).join("")
    : `<tr><td colspan="5" class="empty">${state.providers.has(FAVORITES) && state.favorites.size === 0
        ? "No favorites yet. Click All, then the ☆ next to a model to add it."
        : "No models match. Clear the search or pick other chips."}</td></tr>`;

  const filtered = rows.length < state.models.length ? ` (${state.models.length} in total)` : "";
  $("count").textContent = `Showing ${visible.length} of ${rows.length} models${filtered}.`;
  const more = Math.min(PAGE, rows.length - visible.length);
  $("showMore").hidden = more <= 0;
  $("showMore").textContent = `Show ${more} more`;
  if (animate === "all") animateRows($("rows"));
  else if (typeof animate === "number") animateRows($("rows"), animate);
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.sort === state.sort));
  $("sortNote").textContent = SORT_NOTES[state.sort];
}

// ---------- Jobs ----------

// The model a job is planned to run on: the one it ran on, else the first one compared.
const plannedModel = (job) => (job.actual && job.actual.modelId) || Object.keys(job.estimates || {})[0] || null;

// Estimates are saved as estimated, before the correction from past real costs (so later
// corrections are learned from them); the correction used when the plan was made is saved with it.
const fixOf = (job) => (job.correction > 0 ? job.correction : 1);

function estimateCell(job) {
  const id = plannedModel(job);
  const e = id && (job.estimates || {})[id];
  if (!e) return `<td class="num">–</td>`;
  const k = fixOf(job);
  return `<td class="num">${money(e.likely * k)}<span class="sub-value">${money(e.low * k)} – ${money(e.high * k)}</span></td>`;
}

function actualCell(job) {
  const a = job.actual;
  if (!a) {
    // Real costs are measured for Claude Code, Codex, OpenCode, Zed and (with tracking on) Cursor. Other tools only get estimates.
    const by = clientName(job.client);
    const measurable = !by || ["Claude Code", "Codex", "OpenCode", "Zed", "Cursor"].includes(by);
    return `<td class="num">–<span class="sub-value">${measurable ? "not measured yet" : `estimate only, ${escape(by)} isn't measured`}</span></td>`;
  }
  const estimate = job.estimates && job.estimates[a.modelId];
  const parts = [];
  if (a.status === "running") parts.push("so far");
  else if (estimate && estimate.likely > 0) parts.push(`${(a.costUsd / (estimate.likely * fixOf(job))).toFixed(1)}× estimate`);
  if (a.source === "ai") parts.push("reported by AI");
  else if (a.approximate) parts.push("approximate");
  else if (a.wholeChat) parts.push("whole chat");
  if (a.unpricedModels) parts.push("some models unpriced");
  // Zed keeps one total per conversation, so its plans cost the whole chat; the tooltip says why.
  const tip = a.wholeChat ? ` title="Zed saves one total per conversation, so this is the whole chat's cost, including any work before or after the plan. Start a new chat for each plan to keep it exact."` : "";
  // ≈ like in History: worked out, not counted exactly.
  return `<td class="num"${tip}>${a.approximate ? "≈ " : ""}${money(a.costUsd)}<span class="sub-value">${parts.join(" · ")}</span></td>`;
}

// The AI app that made a job, as people know it.
function clientName(client) {
  if (!client) return null;
  const known = [[/cursor/i, "Cursor"], [/claude[-_ ]?code/i, "Claude Code"], [/claude/i, "Claude Desktop"], [/codex/i, "Codex"], [/opencode/i, "OpenCode"], [/\bzed\b/i, "Zed"], [/chatgpt|openai/i, "ChatGPT"], [/vscode|visual studio code/i, "VS Code"]];
  const hit = known.find(([pattern]) => pattern.test(client));
  return hit ? hit[1] : client;
}

// The job's expected cache miss rate in percent, or null when its phases use different ones.
function expectedMissRate(job) {
  const phases = Array.isArray(job.plan.phases) ? job.plan.phases : [job.plan];
  const rates = new Set(phases.map((p) => Math.round((1 - (p.cacheHit ?? window.Estimate.DEFAULT_CACHE_HIT)) * 100)));
  return rates.size === 1 ? [...rates][0] : null;
}

// The panel under a job, across the whole table: phases on the left, costs and models on the right.
function jobPanel(job) {
  const estimates = job.estimates || {};
  const ids = Object.keys(estimates);
  const planned = plannedModel(job);
  const ran = job.actual && job.actual.modelId;
  const phases = job.plan ? (Array.isArray(job.plan.phases) ? job.plan.phases : [job.plan]) : [];
  const phaseCosts = planned && estimates[planned] && estimates[planned].phases;
  const missPct = (rate) => `${Math.round((1 - (rate ?? window.Estimate.DEFAULT_CACHE_HIT)) * 100)}%`;

  const phaseTable = phases.length ? `
    <div class="panel-block">
      <h4>${job.plan.phases ? "Phases" : "Size"}, on ${escape(modelName(planned))}</h4>
      <table class="mini">
        <thead><tr>${job.plan.phases ? "<th>Phase</th>" : ""}<th>AI actions</th><th>Cache misses</th><th class="num">Cost</th></tr></thead>
        <tbody>${phases.map((p, i) => `
          <tr>
            ${job.plan.phases ? `<td>${escape(p.name || `Phase ${i + 1}`)}</td>` : ""}
            <td>${p.steps} + ${Math.round((p.rework ?? 0.2) * 100)}% fixes</td>
            <td>${missPct(p.cacheHit)}</td>
            <td class="num">${money((phaseCosts ? phaseCosts[i] : estimates[planned] && estimates[planned].likely) * fixOf(job))}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <p class="panel-note">Based on your AI's guess of how many actions (reading files, editing, building) the task takes. The low end assumes no fixes, the high end 50% more actions. Budget for the high end. Models that make more mistakes usually need more actions.</p>
    </div>` : "";

  // Cache misses decide most of the cost. Show a few named situations next to this job's expected one,
  // in cost order. A situation within a few points of the expected one is left out, so no two boxes say the same.
  const prices = state.models.find((m) => m.id === planned);
  const whatIf = job.plan && prices ? cacheWhatIf(prices, job.plan) : null;
  const expected = estimates[planned] && estimates[planned].likely * fixOf(job);
  const expectedMiss = expectedMissRate(job);
  const SITUATIONS = [
    { name: "Smooth", hint: "one unbroken working session" },
    { name: "Long pauses", hint: "long builds, or the AI waiting for you" },
    { name: "Many restarts", hint: "lots of new chats or model switches" },
  ];
  let tiles = [];
  if (whatIf) {
    tiles = whatIf.map((w, i) => ({ ...SITUATIONS[i], miss: Math.round((1 - w.cacheHit) * 100), value: w.likely * fixOf(job) }))
      .filter((t) => expectedMiss === null || Math.abs(t.miss - expectedMiss) > 3);
    tiles.push({ name: "Expected", hint: "what the AI expects for this task", miss: expectedMiss, value: expected, current: true });
    tiles.sort((a, b) => a.value - b.value);
  }
  const misses = whatIf ? `
    <div class="panel-block">
      <h4>What cache misses could do to the cost</h4>
      <div class="tiles">${tiles.map((t) => `
        <div class="tile${t.current ? " current" : ""}" title="${escape(t.hint)}">
          <span class="tile-label">${escape(t.name)}</span>
          <span class="tile-value">${money(t.value)}</span>
          <span class="tile-hint">${t.miss === null ? "mixed per phase" : `${t.miss}% re-read at full price`}</span>
        </div>`).join("")}
      </div>
      <p class="panel-note">Your AI re-reads the whole conversation at every step. Re-reading recent text is cheap. After a few idle minutes, a long build, a model switch or a new chat, it costs full price again.</p>
    </div>` : "";

  const others = state.models.filter((m) => !estimates[m.id]);
  const favorites = others.filter((m) => state.favorites.has(m.id));
  const option = (m) => `<option value="${escape(m.id)}">${escape(m.name)} (${escape(m.provider)})</option>`;
  const byName = (a, b) => a.name.localeCompare(b.name);
  const models = `
    <div class="panel-block">
      <h4>Estimate on each model</h4>
      <ul class="model-rows">${ids.map((id) => `
        <li>
          <span class="model-label">${escape(modelName(id))}${id === planned ? ` <span class="badge">${ran ? "Ran on this" : "Planned"}</span>` : ""}</span>
          <span class="num">${money(estimates[id].likely * fixOf(job))}</span>
          <span class="row-buttons">
            ${id !== planned && !ran ? `<button class="soft-button" type="button" data-plan-model="${escape(id)}" data-job="${escape(job.id)}">Plan on this</button>` : ""}
            ${ids.length > 1 && id !== ran ? `<button class="quiet-danger" type="button" data-remove-model="${escape(id)}" data-job="${escape(job.id)}" aria-label="Remove ${escape(modelName(id))}">Remove</button>` : ""}
          </span>
        </li>`).join("")}
      </ul>
      ${job.plan && others.length ? `
      <form class="add-model" data-add-model="${escape(job.id)}">
        <label class="visually-hidden" for="add-${escape(job.id)}">Add a model to compare</label>
        <select id="add-${escape(job.id)}" name="model">
          <option value="">Add a model to compare…</option>
          ${favorites.length ? `<optgroup label="Favorites">${favorites.sort(byName).map(option).join("")}</optgroup>` : ""}
          <optgroup label="All models">${others.filter((m) => !state.favorites.has(m.id)).sort(byName).map(option).join("")}</optgroup>
        </select>
        <button class="soft-button" type="submit">Add</button>
      </form>` : ""}
    </div>`;



  // What the plan really cost, model by model (helpers and summarizing can run on other models).
  const a = job.actual;
  const split = a && Array.isArray(a.models) && a.models.length ? a.models : null;
  const real = split ? `
    <div class="panel-block">
      <h4>Real cost by model${a.approximate ? " (approximate)" : ""}</h4>
      <ul class="model-rows">${split.map((m) => `
        <li>
          <span class="model-label">${escape(modelName(m.model))}</span>
          <span class="num">${m.cost === null ? "No price" : money(m.cost)}</span>
        </li>`).join("")}
      </ul>
      ${a.approximate ? `<p class="panel-note">Worked out from what Cursor's hook reports, which leaves out some sizes, so it can be off by around 15%. Cursor's own usage page has the exact amount.</p>` : ""}
    </div>` : "";
  return `<div class="job-panel">${phaseTable}<div class="panel-side">${real}${misses}${models}</div></div>`;
}

function jobRow(job) {
  const a = job.actual;
  const planned = plannedModel(job);
  const where = a ? `ran on ${modelName(a.modelId)}` : planned ? `planned on ${modelName(planned)}` : null;
  const by = clientName(job.client);
  const details = [formatDate(job.createdAt), by ? `from ${by}` : null, where, job.note].filter(Boolean).join(" · ");
  const status = a && a.status === "running" ? `<span class="badge running">Running</span>` : "";
  const open = state.openJobs.has(job.id);
  const phases = job.plan && Array.isArray(job.plan.phases) ? `${job.plan.phases.length} phases · ` : "";
  const count = Object.keys(job.estimates || {}).length;
  const panelId = `panel-${job.id}`;
  return `
    <tr class="job-row${open ? " is-open" : ""}">
      <td class="wrap-text">
        <button class="row-toggle" type="button" data-toggle-job="${escape(job.id)}" aria-expanded="${open}" aria-controls="${panelId}"><span class="chevron" aria-hidden="true"></span><span class="model-name">${escape(job.title)}</span></button>${status}
        <span class="provider row-meta">${escape([details, `${phases}${count} model${count === 1 ? "" : "s"}`].filter(Boolean).join(" · "))}</span>
      </td>
      ${estimateCell(job)}
      ${actualCell(job)}
      <td class="row-actions"><button class="danger-button" type="button" data-delete="${escape(job.id)}" aria-label="Delete ${escape(job.title)}">Delete</button></td>
    </tr>
    <tr class="panel-row" id="${panelId}"${open ? "" : " hidden"}><td colspan="4">${open ? jobPanel(job) : ""}</td></tr>`;
}

function renderJobs() {
  const jobs = [...state.jobs].reverse();
  $("jobCount").textContent = jobs.length ? jobs.length : "";
  moveTabIndicator(); // the count changes the tab's width
  $("jobRows").innerHTML = jobs.length
    ? jobs.map(jobRow).join("")
    : emptyRow(4, Object.keys(state.connections).length
      ? "No plans yet. Ask your AI to estimate a task before it starts, and it shows up here."
      : "No plans yet. Connect TokenScope to the tool you use your AI in, then ask your AI to estimate a task before it starts.",
      Object.keys(state.connections).length ? null : { attr: "data-go-connect", label: "Connect your AI tool" });

  const measured = state.jobs.filter((j) => j.actual);
  const total = measured.reduce((sum, j) => sum + j.actual.costUsd, 0);
  const parts = [];
  if (jobs.length) parts.push(`${jobs.length} plan${jobs.length === 1 ? "" : "s"}${measured.length ? `, ${measured.some((j) => j.actual.approximate) ? "≈ " : ""}${money(total)} in real costs so far` : ""}.`);
  // Each tool's estimates are corrected from its own finished plans; others share one from exact costs.
  const { toolOf } = window.Estimate;
  const own = [...new Set(state.jobs.map(toolOf).filter(Boolean))].map((t) => ({ t, fix: correction(state.jobs, t) })).filter((x) => x.fix.tool);
  const shared = correction(state.jobs);
  const times = (f) => `${f.factor < 1 ? f.factor.toFixed(2) : f.factor.toFixed(1)}×`;
  if (own.length) parts.push(`New estimates are corrected to your real costs: ${own.map((x) => `${TOOL_NAMES[x.t] || x.t} ${times(x.fix)}`).join(", ")}${shared.applied && own.length < 4 ? `, other tools ${times(shared)}` : ""}.`);
  else if (shared.applied) parts.push(`Real costs have been ${times(shared)} the estimates on average, so new estimates are corrected to match.`);
  else parts.push("Estimates start adjusting to your real costs after 2 finished plans from the same tool.");
  $("jobsSummary").textContent = parts.join(" ");
  renderConnect(); // shows which tools are connected
}

async function reloadStore() {
  const data = await api.readStore();
  state.favorites = new Set(data.favorites);
  state.jobs = data.jobs;
  state.connections = data.connections || {};
  renderAll();
}

function renderAll() {
  renderModels();
  renderJobs();
}

function showView(view, { animate = false } = {}) {
  state.view = view;
  for (const v of VIEWS) {
    $(`view-${v}`).hidden = v !== view;
    $(`tab-${v}`).setAttribute("aria-selected", v === view);
    $(`tab-${v}`).tabIndex = v === view ? 0 : -1;
  }
  moveTabIndicator();
  if (animate) replay($(`view-${view}`), "view-in");
  if (view === "history") loadHistory();
}

// The line under the active tab slides to it.
function moveTabIndicator() {
  const tab = $(`tab-${state.view}`);
  const line = $("tabIndicator");
  line.style.width = `${tab.offsetWidth}px`;
  line.style.transform = `translateX(${tab.offsetLeft}px)`;
}

// ---------- Loading ----------

function showStatus(prices) {
  if (prices.source === "live") {
    $("status").textContent = "Prices are up to date from OpenRouter";
    return;
  }
  // Not live: say how old the prices are. The technical reason is in the tooltip.
  const from = prices.source === "cache" ? "saved" : "built-in";
  const date = prices.date ? ` from ${prices.date}` : "";
  $("status").innerHTML = `<span class="warn" title="${escape(prices.error || "")}">⚠ Couldn't reach OpenRouter. Showing ${from} prices${escape(date)}.</span>`;
}

let firstLoad = true;

async function loadData() {
  $("refresh").disabled = true;
  $("status").textContent = "Loading…";
  try {
    const data = await api.load();
    state.models = data.models;
    showStatus(data.prices);
    state.warnings.prices = data.prices.warnings || [];
    renderNotices();
    renderAll();
    if (firstLoad) animateRows($("rows"));
    firstLoad = false;
  } catch (error) {
    $("status").innerHTML = `<span class="warn" title="${escape(error.message)}">⚠ Couldn't load prices.</span>`;
  } finally {
    $("refresh").disabled = false;
  }
}

function setTokens(text) {
  const millions = parseTokens(text);
  $("tokens").setAttribute("aria-invalid", millions === null);
  $("tokensHint").textContent = millions === null ? "Couldn't read that. Try 250k or 1.5M" : "";
  $("tokensHint").classList.toggle("error", millions === null);
  if (millions === null) return;
  state.tokensMillions = millions;
  save("tokens", text);
  renderModels();
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $("theme").textContent = state.theme === "dark" ? "Light mode" : "Dark mode";
}

let connect = null; // where TokenScope runs on this computer, filled in by setUpConnect

// Setup per AI tool. agent: the tool can edit its own config when asked, so the prompt comes first.
// measured: TokenScope can read the tool's usage logs, so real costs fill in by themselves.
function aiTools(c) {
  const file = (...parts) => [c.home, ...parts].join(c.windows ? "\\" : "/");
  const env = c.env || {};
  const envText = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ");
  const hasEnv = Object.keys(env).length > 0;
  const mcpServers = JSON.stringify({ mcpServers: { tokenscope: { command: c.command, args: c.args, ...(hasEnv ? { env } : {}) } } }, null, 2);
  const toml = `[mcp_servers.tokenscope]\ncommand = '${c.command}'\nargs = [${c.args.map((a) => `'${a}'`).join(", ")}]` + (hasEnv ? `\nenv = { ${Object.entries(env).map(([k, v]) => `${k} = "${v}"`).join(", ")} }` : "");
  const opencode = JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { tokenscope: { type: "local", command: [c.command, ...c.args], ...(hasEnv ? { environment: env } : {}), enabled: true } } }, null, 2);
  // Zed: MCP servers go under "context_servers" in its settings.json.
  const zed = JSON.stringify({ context_servers: { tokenscope: { command: c.command, args: c.args, env } } }, null, 2);
  const zedSettings = c.windows ? file("AppData", "Roaming", "Zed", "settings.json") : file(".config", "zed", "settings.json");
  const quote = (s) => (/[\s"]/.test(s) ? `"${s}"` : s);
  const claudeAdd = `claude mcp add --scope user ${Object.entries(env).map(([k, v]) => `-e ${k}=${v} `).join("")}tokenscope -- ${[c.command, ...c.args].map(quote).join(" ")}`;
  const fields = `Name: tokenscope\nCommand: ${c.command}\nArguments: ${c.args.join(" ")}` + (hasEnv ? `\nEnvironment variable: ${envText}` : "");
  const merge = "If the file already has other servers, add the tokenscope entry next to them instead of replacing them.";
  return {
    "claude-code": {
      name: "Claude Code", agent: true, measured: true,
      use: { how: "Type this, followed by what you want done:", command: "/mcp__tokenscope__estimate" },
      steps: ["Run this in a terminal:"], snippet: claudeAdd,
      restart: "Restart Claude Code. A conversation that was already open doesn't get TokenScope, so start a new one.",
      hint: `In Claude Code, add the server by running:\n${claudeAdd}`,
    },
    cursor: {
      name: "Cursor", agent: true,
      use: { how: "In the Agent chat, type / and pick estimate (from tokenscope), then describe what you want done:", command: "/estimate" },
      steps: [`Open ${file(".cursor", "mcp.json")} (create it if it doesn't exist) and add this. ${merge}`], snippet: mcpServers,
      restart: "Check Cursor Settings → MCP: tokenscope should be listed and switched on. Then start a new chat, since an open one doesn't get TokenScope.",
      hint: `In Cursor, MCP servers go in ${file(".cursor", "mcp.json")}, in this format:\n${mcpServers}`,
    },
    "claude-desktop": {
      name: "Claude Desktop", agent: false,
      use: { how: "In the chat box, open the + menu, pick tokenscope and then Plan and estimate. Then describe what you want done." },
      steps: [`In Claude Desktop, open Settings → Developer → Edit Config, add this to the file and save. ${merge}`], snippet: mcpServers,
      restart: "Quit and reopen Claude Desktop.",
      hint: "In Claude Desktop, MCP servers are added under Settings → Developer → Edit Config, which opens claude_desktop_config.json.",
    },
    // ChatGPT (app and web) only connects to MCP servers on the internet, not to programs on this
    // computer (checked Oct 2026), so it isn't a choice. A line under the choices points to Codex.
    codex: {
      name: "Codex", agent: true, measured: true,
      steps: [`Add this to ${file(".codex", "config.toml")} (create it if it doesn't exist). The Codex app, the Codex extension in your editor and the Codex command line all use this file.`], snippet: toml,
      restart: "Start a new Codex session.",
      hint: `In Codex, MCP servers go in ${file(".codex", "config.toml")}, in this format:\n${toml}`,
    },
    opencode: {
      name: "OpenCode", agent: true, measured: true,
      steps: [`Add this to ${file(".config", "opencode", "opencode.json")}, or opencode.jsonc if that's the one you have (create opencode.json if neither exists). If it already has an "mcp" section, add the tokenscope entry inside it.`], snippet: opencode,
      restart: "Restart OpenCode and start a new conversation. A conversation that was already open doesn't get TokenScope, even when /mcp shows it connected.",
      hint: `In OpenCode, MCP servers go in ${file(".config", "opencode", "opencode.json")} (or opencode.jsonc, if that's the file that exists), in this format:\n${opencode}`,
    },
    zed: {
      name: "Zed", agent: true, measured: true,
      steps: [`Open Zed's settings (${zedSettings}, or in Zed: Settings → Open Settings File) and add this. If it already has a "context_servers" section, add the tokenscope entry inside it.`], snippet: zed,
      restart: "Check the Agent panel's settings in Zed: tokenscope should be listed under MCP servers and switched on. Then start a new thread, since an open one doesn't get TokenScope.",
      hint: `In Zed, MCP servers go under "context_servers" in ${zedSettings}, in this format:\n${zed}`,
    },
    other: {
      name: "Other", agent: true, other: true,
      steps: ["Any AI tool that supports MCP servers (VS Code, Windsurf, Gemini CLI and others) can use TokenScope. Add a local (stdio) MCP server with these settings." + (hasEnv ? " The environment variable matters: without it TokenScope opens as a window instead of talking to the AI." : "")],
      snippet: fields,
      restart: "Restart the tool if it asks, and start a new conversation.",
      hint: "",
    },
  };
}

// The prompt works with any AI: it has everything needed, plus where things go in this tool.
function setupPrompt(tool) {
  const c = connect;
  const target = tool.other ? "the AI tool you're running in" : tool.name;
  return `Please connect TokenScope to ${target}. TokenScope is a program on my computer that works as a local MCP server (stdio). It estimates what coding jobs cost and tracks what they really cost.

Server details:
- Name: tokenscope
- Command: ${c.command}
- Arguments: ${c.args.join(" ")}
${Object.keys(c.env || {}).length ? `- Environment variable: ${Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join(" ")} (required, without it TokenScope opens as a window instead of talking over stdio)\n` : ""}${tool.hint ? `\n${tool.hint}\n` : ""}
1. Add the server. If you can change your own settings or config files, do it yourself and keep anything already there. If you can't, give me exact step-by-step instructions for ${target}: which settings screen or file, and what to paste.

2. Tell me when it's done, and whether I need to restart anything.`;
}

function snippet(id, text, primary = false) {
  return `<div class="snippet"><pre id="${id}">${escape(text)}</pre><button class="button ${primary ? "" : "ghost"} copy" type="button" data-copy="${id}">Copy</button></div>`;
}

// Which tool a connection belongs to. Connections are saved under the name each AI tool gives itself.
const CONNECTION_TOOLS = [[/cursor/i, "cursor"], [/claude[-_ ]?code/i, "claude-code"], [/claude/i, "claude-desktop"], [/codex/i, "codex"], [/opencode/i, "opencode"], [/\bzed\b/i, "zed"]];
function connectedTools() {
  const seen = {};
  for (const [name, info] of Object.entries(state.connections)) {
    const key = (CONNECTION_TOOLS.find(([pattern]) => pattern.test(name)) || [null, "other"])[1];
    const t = Date.parse(info && info.lastSeen) || 0;
    if (!seen[key] || t > seen[key]) seen[key] = t;
  }
  return seen;
}

function lastUsed(t) {
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 86400e3);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

// One row per tool, like Tracking: is it connected, does it measure real costs, and a Set up
// button that opens just that tool's steps.
function renderConnect() {
  if (!connect) return;
  const tools = aiTools(connect);
  const seen = connectedTools();
  $("aiTools").innerHTML = Object.entries(tools).map(([key, t]) => {
    const open = state.aiTool === key;
    const status = seen[key] ? `Connected, last used ${lastUsed(seen[key])}.` : t.other ? "Any other tool that supports MCP servers, like VS Code or Windsurf." : "Not connected yet.";
    const costs = key === "zed" ? "Real costs are measured automatically, one total per conversation."
      : t.measured ? "Real costs are measured automatically."
      : key === "cursor" ? "Real costs are measured when Cursor is turned on under Track AI spending."
      : "Estimates only, no real costs.";
    return `
      <li class="tool-item${open ? " is-open" : ""}">
        <div class="tool-row">
          <div><strong>${seen[key] ? `<span class="ok" aria-hidden="true">✓</span> ` : ""}${escape(t.name)}</strong><span>${escape(status)} ${escape(costs)}</span></div>
          <button class="soft-button" type="button" data-ai-tool="${key}" aria-expanded="${open}" aria-controls="setup-${key}"><span class="chevron" aria-hidden="true"></span>Set up</button>
        </div>
        ${open ? setupSteps(key, t) : ""}
      </li>`;
  }).join("");
}

function setupSteps(key, t) {
  return `
    <div class="setup panel-in" id="setup-${key}">
      <ol class="steps">
        <li>${t.steps.map(escape).join(" ")}${snippet(`snippet-${key}`, t.snippet, true)}</li>
        <li>${escape(t.restart)}</li>
      </ol>
      <p class="hint">Stuck? <button class="link-button" type="button" data-copy-prompt="${key}">Copy a setup prompt</button> and paste it into ${t.other ? "your AI" : escape(t.name)}. ${t.agent ? "It does the setup for you." : "It walks you through the steps."}</p>
    </div>`;
}

async function setUpConnect() {
  try {
    connect = await api.aiLaunch();
    $("dataFolder").textContent = connect.dataFile.replace(/[\\/]tokenscope-data\.json$/, "");
    $("claudeLogs").textContent = connect.logsFolder;
    $("codexLogs").textContent = connect.codexFolder;
    renderConnect();
  } catch (error) {
    $("aiTools").innerHTML = `<li><span>Couldn't work out the setup: ${escape(error.message)}</span></li>`;
  }
}


// ---------- Data warnings ----------

// "X data mismatch, probably due to an update" warnings, shown above the tabs on every view.
function renderNotices() {
  const all = [...state.warnings.prices, ...state.warnings.history];
  $("notices").innerHTML = all.map((w) => `<p class="notice"><span aria-hidden="true">⚠</span> ${escape(w.message)}</p>`).join("");
}

// ---------- History and tracking ----------

const TOOL_NAMES = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", zed: "Zed", cursor: "Cursor" };
const costText = (cost, approximate) => `${approximate ? "≈ " : ""}${money(cost)}`;

// One switch row per AI tool. Used in Settings & help and on History before anything is on.
// A tool that needs something done by hand shows ⚠ with what to do.
function trackingRows(sources) {
  return sources.map((src) => `
      <li>
        <div>
          <strong>${escape(src.name)}</strong>
          <span>${escape(src.found ? src.note : "Not found on this computer.")}</span>
          ${src.todo ? `<span class="todo"><span aria-hidden="true">⚠</span> ${escape(src.todo.text)} <button class="link-button" type="button" data-open-help="${escape(src.todo.help)}">Read more</button></span>` : ""}
        </div>
        <button class="switch" type="button" role="switch" data-track="${escape(src.id)}" aria-checked="${src.enabled}" aria-label="Track ${escape(src.name)}"${src.found || src.enabled ? "" : " disabled"}></button>
      </li>`).join("");
}

function renderTracking() {
  $("trackingSources").innerHTML = trackingRows(state.sources);
}

async function loadSources() {
  try {
    state.sources = await api.historySources();
  } catch {
    state.sources = [];
  }
  renderTracking();
}

const anyTracking = () => state.sources.some((s) => s.enabled);

function formatWhen(ms) {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60e3);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// Who made a model, as the Models tab names them. Models OpenRouter doesn't list are recognized
// by name; anything else is "Other".
const MAKERS = [[/claude|opus|sonnet|haiku/i, "Anthropic"], [/gpt|codex|^o\d/i, "OpenAI"], [/gemini|gemma/i, "Google"], [/grok/i, "xAI"], [/deepseek/i, "DeepSeek"], [/qwen/i, "Qwen"], [/llama/i, "Meta"], [/mistral|codestral|devstral/i, "Mistral"], [/glm/i, "Z.ai"], [/kimi/i, "MoonshotAI"]];
function providerOf(m) {
  const listed = m.modelId && state.models.find((x) => x.id === m.modelId);
  if (listed && listed.provider) return listed.provider;
  const hit = MAKERS.find(([pattern]) => pattern.test(String(m.modelId || m.model).replace(/^.*\//, "")));
  return hit ? hit[1] : "Other";
}

// m.tier: Codex's fast or flex speed, which is priced differently.
const historyModelName = (m) => (m.modelId ? modelName(m.modelId) + (m.tier ? ` (${m.tier})` : "") : m.model);

// What a conversation's models can be searched by besides their names: the maker, the model id as
// the tool wrote it, and the name people know the maker's models by (GPT is "ChatGPT" to many).
const KNOWN_AS = { openai: "ChatGPT", google: "Gemini", xai: "Grok", anthropic: "Claude" };
function modelWords(c) {
  const out = new Set();
  for (const m of c.models) {
    const maker = providerOf(m);
    out.add(maker);
    if (KNOWN_AS[maker.toLowerCase()]) out.add(KNOWN_AS[maker.toLowerCase()]);
    for (const id of [m.model, m.modelId]) if (id) out.add(String(id));
  }
  return [...out];
}

// Totals for a few periods, from the conversations shown (after the search).
// While searching, each tile shows what the matching conversations cost, and in its small text
// what everything cost, so the overall total is never out of sight.
function historyTotals(list, all = list) {
  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const keep = state.history.keepDays;
  const periods = [
    { label: "Today", since: today.getTime() },
    { label: "Last 7 days", since: now - 7 * 86400e3 },
    { label: "Last 30 days", since: now - 30 * 86400e3 },
  ];
  if (keep === 0 || keep > 30) periods.push({ label: keep === 0 ? "All time" : keep === 365 ? "Last year" : `Last ${keep} days`, since: keep === 0 ? 0 : now - keep * 86400e3 });
  return periods.map((p) => {
    const inside = list.filter((c) => c.end >= p.since);
    const cost = inside.reduce((sum, c) => sum + c.cost, 0);
    let hint = `${inside.length} conversation${inside.length === 1 ? "" : "s"}`;
    if (list !== all) {
      const every = all.filter((c) => c.end >= p.since);
      hint = `${inside.length} of ${every.length} · ${costText(every.reduce((sum, c) => sum + c.cost, 0), every.some((c) => c.approximate))} in all`;
    }
    return `<div class="tile"><span class="tile-label">${escape(p.label)}</span><span class="tile-value">${costText(cost, inside.some((c) => c.approximate))}</span><span class="tile-hint">${hint}</span></div>`;
  }).join("");
}

// What the cost was made of, as one bar with named parts. Facts only: suggestions come from the AI.
function driversBar(c) {
  const d = c.insights.drivers;
  const parts = [
    { key: "work", label: "The work itself", value: d.work },
    { key: "you", label: "Cache expired while waiting for you", value: d.pausesYou },
    { key: "tools", label: "Cache expired during builds or commands", value: d.pausesTools },
    { key: "other", label: "Cache expired, cause unknown", value: d.otherMisses },
    { key: "outputs", label: "Large tool outputs re-read", value: d.bigOutputs },
  ].filter((p) => p.value >= 0.005);
  const total = parts.reduce((sum, p) => sum + p.value, 0) || 1;
  return `
    <div class="drivers" role="img" aria-label="${escape(parts.map((p) => `${p.label} ${money(p.value)}`).join(", "))}">
      ${parts.map((p) => `<span class="driver d-${p.key}" data-share="${((p.value / total) * 100).toFixed(2)}"></span>`).join("")}
    </div>
    <ul class="driver-legend">${parts.map((p) => `<li><span class="swatch d-${p.key}"></span>${escape(p.label)} <strong>${costText(p.value, c.approximate)}</strong> <span class="muted">${Math.round((p.value / total) * 100)}%</span></li>`).join("")}</ul>`;
}

// A few plain facts about the conversation.
function factsLine(c) {
  const f = c.insights.facts;
  const t = f.toolUse || {};
  const bits = [`${f.steps} steps`];
  if (t.edits || t.reads) bits.push(`${t.edits || 0} edits, ${t.reads || 0} file reads`);
  if (t.builds || t.tests) bits.push(`${t.builds || 0} builds and ${t.tests || 0} test runs${f.buildAndTestMinutes ? ` (${f.buildAndTestMinutes} min)` : ""}`);
  if (f.cacheExpiries && f.cacheExpiries.length) bits.push(`cache expired ${f.cacheExpiries.length}×`);
  if (f.peakContextTokens) bits.push(`grew to ${formatTokens(f.peakContextTokens)} tokens`);
  if (f.helperCost >= 0.01 && !(c.helpers && c.helpers.length)) bits.push(`helper agents ${costText(f.helperCost, c.approximate)}`); // named ones get their own list
  return bits.join(" · ");
}

// What a conversation's tokens would cost at another model's prices: the same fresh input, cache
// reads, cache writes and output. (Another model would also take a different number of steps.)
function repriceOn(c, target) {
  const cached = target.cachedPerM ?? target.inPerM;
  const write = target.cacheWritePerM ?? target.inPerM;
  return c.models.reduce((sum, m) => sum + (Math.max(0, m.input - m.cacheRead - m.cacheWrite) * target.inPerM + m.cacheRead * cached + m.cacheWrite * write + m.output * target.outPerM) / 1e6, 0);
}

function compareText(actual, other) {
  if (!actual || !other) return "";
  if (Math.abs(other - actual) / actual < 0.1) return "about the same";
  return other < actual ? `${(actual / other).toFixed(1)}× cheaper` : `${(other / actual).toFixed(1)}× more`;
}

// "On other models": the conversation re-priced on your favorites, or the models you picked here.
function otherModelsBlock(c) {
  const used = new Set(c.models.map((m) => m.modelId).filter(Boolean));
  const list = (state.compareModels || [...state.favorites]).filter((id) => !used.has(id)).map((id) => state.models.find((m) => m.id === id)).filter(Boolean);
  const whole = c.partOf ?? c.cost;
  const priced = !c.unpriced || c.partOf !== undefined ? whole : null;
  const peak = c.insights && c.insights.facts && c.insights.facts.peakContextTokens;
  const rows = list.map((m) => {
    const cost = repriceOn(c, m);
    const tooBig = peak && m.context && peak > m.context;
    return `
        <li>
          <span class="model-label">${escape(m.name)}${tooBig ? `<span class="sub-value">Its context is too small for this conversation (${formatTokens(peak)} tokens).</span>` : ""}</span>
          <span class="num">${costText(cost, c.approximate)}<span class="sub-value">${escape(priced ? compareText(priced, cost) : "")}</span></span>
          <span class="row-buttons"><button class="quiet-danger" type="button" data-compare-remove="${escape(m.id)}" aria-label="Remove ${escape(m.name)}">Remove</button></span>
        </li>`;
  }).join("");
  const shown = new Set(list.map((m) => m.id));
  const others = state.models.filter((m) => !shown.has(m.id) && !used.has(m.id));
  const option = (m) => `<option value="${escape(m.id)}">${escape(m.name)} (${escape(m.provider)})</option>`;
  const byName = (a, b) => a.name.localeCompare(b.name);
  const favorites = others.filter((m) => state.favorites.has(m.id)).sort(byName);
  return `
      <div class="panel-block">
        <h4>On other models</h4>
        ${rows ? `<ul class="model-rows compare-rows">${rows}</ul>` : `<p class="panel-note">Star models on the Models tab, or add one here, to see what this conversation would have cost on them.</p>`}
        <form class="add-model" data-compare-add>
          <label class="visually-hidden" for="compare-${escape(c.id)}">Add a model to compare</label>
          <select id="compare-${escape(c.id)}" name="model">
            <option value="">Add a model to compare…</option>
            ${favorites.length ? `<optgroup label="Favorites">${favorites.map(option).join("")}</optgroup>` : ""}
            <optgroup label="All models">${others.filter((m) => !state.favorites.has(m.id)).sort(byName).map(option).join("")}</optgroup>
          </select>
          <button class="soft-button" type="submit">Add</button>
        </form>
        <p class="panel-note">The same tokens at each model's prices${priced ? `, compared with the ${costText(whole, c.approximate)} it really cost` : ""}. Another model would also work differently and take a different number of steps, so treat this as a rough comparison. The models you add here are used for every conversation.</p>
      </div>`;
}

function conversationPanel(c) {
  const jobs = c.jobIds.map((id) => state.jobs.find((j) => j.id === id)).filter(Boolean);
  const why = c.insights ? `
      <div class="panel-block">
        <h4>What the cost was made of</h4>
        ${driversBar(c)}
        <p class="panel-note">${escape(factsLine(c))}.</p>
      </div>` : c.totalsOnly ? `
      <div class="panel-block">
        <h4>What the cost was made of</h4>
        <p class="panel-note">${escape(TOOL_NAMES[c.tool] || c.tool)} only saves a total for each conversation, so TokenScope can't show what drove the cost. The cost itself is exact.</p>
      </div>` : "";
  // Subagents this conversation started (OpenCode runs each in a session of its own). Their cost is
  // included above. Most expensive first, the same name ran again shown once with a count, and 5 at
  // a time, so a conversation with dozens of them stays readable.
  let subagents = "";
  if (c.helpers && c.helpers.length) {
    const groups = new Map();
    for (const h of c.helpers) {
      const g = groups.get(h.title) || { title: h.title, cost: 0, runs: 0 };
      g.cost += h.cost;
      g.runs += 1;
      groups.set(h.title, g);
    }
    const rows = [...groups.values()].sort((a, b) => b.cost - a.cost);
    const shown = Math.min(rows.length, state.subagentsShown.get(c.id) || PAGE_SMALL);
    const total = c.helpers.reduce((sum, h) => sum + h.cost, 0);
    const more = Math.min(PAGE_SMALL, rows.length - shown);
    // Closed by default, like Details: one line with the count and total, the list on a click.
    const open = state.openSubagents.has(c.id);
    const listId = `subs-${c.id.replace(/[^a-z0-9-]/gi, "_")}`;
    subagents = `
      <div class="panel-block expander${open ? " is-open" : ""}">
        <button class="expander-head" type="button" data-toggle-subagents="${escape(c.id)}" aria-expanded="${open}" aria-controls="${listId}">
          <span class="chevron" aria-hidden="true"></span><span class="expander-title">Subagents</span><span class="muted">${c.helpers.length} · included in the cost above</span><span class="expander-value">${costText(total, c.approximate)}</span>
        </button>
        ${open ? `<div class="expander-body" id="${listId}">
        <ul class="model-rows subagent-rows">${rows.slice(0, shown).map((g) => `
          <li><span class="model-label">${escape(g.title)}${g.runs > 1 ? ` <span class="muted">×${g.runs}</span>` : ""}</span><span class="num">${costText(g.cost, c.approximate)}</span></li>`).join("")}
        </ul>
        ${more > 0 ? `<div class="list-footer"><p class="count">Showing ${shown} of ${rows.length}.</p><button class="button ghost" type="button" data-more-subagents="${escape(c.id)}">Show ${more} more</button></div>` : ""}
        </div>` : ""}
      </div>`;
  }
  return `
    <div class="job-panel single">${why}
      <div class="panel-block">
        <h4>By model</h4>
        <table class="mini">
          <thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Input</th><th class="num">From cache</th><th class="num">Output</th><th class="num">Cost</th></tr></thead>
          <tbody>${c.models.map((m) => `
            <tr>
              <td>${escape(historyModelName(m))}</td>
              <td class="num">${c.totalsOnly ? "–" : m.requests}</td>
              <td class="num">${formatTokens(m.input)}</td>
              <td class="num">${m.input ? Math.round((m.cacheRead / m.input) * 100) : 0}%</td>
              <td class="num">${formatTokens(m.output)}</td>
              <td class="num">${m.cost === null ? "no price" : costText(m.cost, c.approximate)}</td>
            </tr>`).join("")}
          </tbody>
        </table>
        <p class="panel-note">${c.approximate ? "Approximate, worked out from the size of each Cursor step. Usually within about 15%. Cursor's own usage page has the exact amount." : c.saved ? `Exact, from ${escape(TOOL_NAMES[c.tool] || c.tool)}'s token counts. ${escape(TOOL_NAMES[c.tool] || c.tool)} no longer has this conversation, so this is TokenScope's saved summary, priced when it was saved.` : "Exact, from the tool's own token counts."}${c.unpriced ? " Some models have no price on OpenRouter, so they're not in the total." : ""}${jobs.length ? ` Plans in this conversation: ${escape(jobs.map((j) => j.title).join(", "))}.` : ""}</p>
      </div>${subagents}
      ${otherModelsBlock(c)}
    </div>`;
}

// Under a conversation's cost: its whole cost when only one maker's part is shown, and unpriced models.
function costNotes(c) {
  const notes = [];
  if (c.partOf !== undefined && c.partOf - c.cost >= 0.005) notes.push(`of ${costText(c.partOf, c.approximate)} in all`);
  if (c.unpriced) notes.push("plus unpriced models");
  return notes.length ? `<span class="sub-value">${notes.join(" · ")}</span>` : "";
}

// The smaller text under a conversation's name. Listed by when it was last active (a resumed
// conversation can run for days), so that's the date shown.
function conversationMeta(c) {
  const subagents = c.helpers && c.helpers.length ? `${c.helpers.length} subagent${c.helpers.length === 1 ? "" : "s"}` : null;
  return [c.project, `last active ${formatWhen(c.end)}`, formatDuration(c.end - c.start), c.models.map(historyModelName).join(", "), subagents].filter(Boolean).join(" · ");
}

// Text with the searched words marked, escaped.
function marked(text) {
  const q = state.historySearch.trim();
  if (!q) return escape(text);
  let out = "", at = 0;
  for (const [a, b] of window.ConversationSearch.highlights(text, q)) {
    out += escape(text.slice(at, a)) + `<mark>${escape(text.slice(a, b))}</mark>`;
    at = b;
  }
  return out + escape(text.slice(at));
}

function conversationRow(c) {
  const open = state.openConversations.has(c.id);
  const meta = conversationMeta(c);
  const panelId = `conv-${c.id.replace(/[^a-z0-9-]/gi, "_")}`;
  return `
    <tr class="job-row${open ? " is-open" : ""}">
      <td class="wrap-text">
        <button class="row-toggle" type="button" data-toggle-conv="${escape(c.id)}" aria-expanded="${open}" aria-controls="${panelId}"><span class="chevron" aria-hidden="true"></span><span class="model-name">${marked(c.title)}</span></button><span class="badge">${marked(TOOL_NAMES[c.tool] || c.tool)}</span>${c.archived ? `<span class="badge" title="Archived in ${escape(TOOL_NAMES[c.tool] || c.tool)}. Its cost still counts.">${marked("Archived")}</span>` : ""}
        <span class="provider row-meta">${marked(meta)}</span>
      </td>
      <td class="num">${costText(c.cost, c.approximate)}${costNotes(c)}</td>
    </tr>
    <tr class="panel-row" id="${panelId}"${open ? "" : " hidden"}><td colspan="2">${open ? conversationPanel(c) : ""}</td></tr>`;
}

// Shown in the table when there's nothing to list, like the Jobs table does.
function historyEmpty(row) {
  $("historyTotals").hidden = true;
  $("historyRows").innerHTML = row;
  $("historyCount").textContent = "";
  $("historyMore").hidden = true;
}

// An empty table says why, and when something needs setting up, a button takes you there.
// Plans and Spending use the same one.
function emptyRow(columns, text, action = null) {
  return `<tr><td colspan="${columns}" class="empty"><p>${escape(text)}</p>${action ? `<button class="button ghost" type="button" ${action.attr}>${escape(action.label)}</button>` : ""}</td></tr>`;
}

function renderHistory() {
  if (!anyTracking()) {
    return historyEmpty(emptyRow(2, "Nothing here yet. Turn on the AI tools you want to track, and their conversations show up here.", { attr: "data-go-tracking", label: "Track AI spending" }));
  }
  $("historyTotals").hidden = false;
  if (!state.history) {
    // While loading, the totals keep their space, so nothing moves when the conversations arrive.
    const keep = Number($("historyKeep").value);
    const tiles = 3 + (keep === 0 || keep > 30 ? 1 : 0);
    $("historyTotals").innerHTML = Array.from({ length: tiles }, () =>
      `<div class="tile placeholder" aria-hidden="true"><span class="tile-label">&nbsp;</span><span class="tile-value">&nbsp;</span><span class="tile-hint">&nbsp;</span></div>`).join("");
    $("historyRows").innerHTML = `<tr><td colspan="2" class="empty">Loading…</td></tr>`;
    return;
  }
  const all = state.history.conversations;
  let list = all;
  // Search: every conversation, not just the ones shown; name matches first (see search.js). The
  // totals follow it, so they say what the conversations you searched for cost.
  const query = state.historySearch.trim();
  if (query) {
    const items = list.map((c) => ({
      title: c.title,
      details: [conversationMeta(c), TOOL_NAMES[c.tool] || c.tool, ...modelWords(c), c.archived ? "archived" : "", formatDate(c.end), ...(c.helpers || []).map((h) => h.title)].join(" · "),
    }));
    list = window.ConversationSearch.searchConversations(items, query).map((h) => list[h.index]);
  }
  $("historyTotals").innerHTML = historyTotals(list, all);
  const visible = list.slice(0, state.historyShown);
  $("historyRows").innerHTML = visible.length ? visible.map(conversationRow).join("")
    : query ? emptyRow(2, `No conversations match "${query}".`, { attr: "data-clear-history-search", label: "Clear search" })
    : emptyRow(2, "Nothing here yet. Conversations show up here as you use your tracked AI tools.");
  $("historyCount").textContent = list.length ? `Showing ${visible.length} of ${list.length} ${query ? "matching " : ""}conversations.` : "";
  const more = Math.min(PAGE, list.length - visible.length);
  $("historyMore").hidden = more <= 0;
  $("historyMore").textContent = `Show ${more} more`;
  $("historyErrors").textContent = state.history.errors.length ? `Couldn't read: ${state.history.errors.join(". ")}` : "";
}

let historyLoading = false;
async function loadHistory() {
  if (!anyTracking()) {
    state.warnings.history = [];
    renderNotices();
    return renderHistory();
  }
  if (historyLoading) return;
  historyLoading = true;
  renderHistory();
  try {
    state.history = await api.historyList();
  } catch (error) {
    state.history = { conversations: [], keepDays: 90, errors: [error.message], warnings: [] };
  } finally {
    historyLoading = false;
  }
  state.warnings.history = state.history.warnings || [];
  renderNotices();
  renderHistory();
  loadSources(); // a ⚠ step may be done now (Cursor started recording)
}

async function setTracking(id, on) {
  if (!state.sources.some((s) => s.id === id)) return;
  if (id === "cursor" && on && !confirm("Add TokenScope's hook to Cursor? It records the size of each step, never your code, prompts or replies, so Spending can show what Cursor costs.")) return;
  try {
    state.sources = await api.setTracking(id, on);
  } catch (error) {
    alert("Couldn't change tracking: " + error.message);
    return;
  }
  if (id === "cursor" && !on && confirm("The Cursor hook is removed. Do you also want to delete what it recorded?")) await api.clearData("cursor");
  renderTracking();
  state.history = null;
  loadHistory();
}

// ---------- Events ----------

$("providers").addEventListener("click", (event) => {
  const provider = event.target.dataset.provider;
  if (!provider) return;
  if (provider === "All") state.providers.clear();
  else if (state.providers.has(provider)) state.providers.delete(provider);
  else state.providers.add(provider);
  save("providers", [...state.providers]);
  state.shown = PAGE;
  renderModels({ animate: "all" });
});

$("showMore").addEventListener("click", () => {
  const before = state.shown;
  state.shown += PAGE;
  renderModels({ animate: before });
});

$("rows").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-fav]");
  if (!button) return;
  const id = button.dataset.fav;
  const on = !state.favorites.has(id);
  if (on) state.favorites.add(id);
  else state.favorites.delete(id);
  api.setFavorite(id, on).catch(() => {});
  renderModels();
  // The table is redrawn, so put keyboard focus back on the same star.
  const again = [...document.querySelectorAll("[data-fav]")].find((b) => b.dataset.fav === id);
  if (again) {
    again.focus();
    if (on) replay(again, "pop");
  }
});

$("theme").addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  save("theme", state.theme);
  applyTheme();
});

document.querySelectorAll(".seg button").forEach((button) =>
  button.addEventListener("click", () => {
    state.sort = button.dataset.sort;
    save("sort", state.sort);
    state.shown = PAGE;
    renderModels({ animate: "all" });
  })
);

$("search").addEventListener("input", (event) => {
  state.search = event.target.value;
  save("search", state.search);
  state.shown = PAGE;
  renderModels();
});

$("tokens").addEventListener("input", (event) => setTokens(event.target.value));
document.querySelectorAll(".preset").forEach((button) =>
  button.addEventListener("click", () => {
    $("tokens").value = button.dataset.tokens;
    setTokens(button.dataset.tokens);
  })
);

// Changing which models a job is priced on: the first one in the list is the planned one.
async function changeJobModels(jobId, change) {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return;
  const ids = change(Object.keys(job.estimates || {}));
  try {
    await api.setJobModels(jobId, ids);
    await reloadStore();
  } catch (error) {
    alert("Couldn't change the models: " + error.message);
  }
}

// Show or hide a job's details panel. The panel slides in, and focus stays on the button.
function toggleJob(id) {
  if (state.openJobs.has(id)) state.openJobs.delete(id);
  else state.openJobs.add(id);
  renderJobs();
  const button = document.querySelector(`[data-toggle-job="${CSS.escape(id)}"]`);
  if (button) button.focus();
  if (state.openJobs.has(id)) replay(document.getElementById(`panel-${id}`), "panel-in");
}

$("jobRows").addEventListener("submit", (event) => {
  const form = event.target.closest("[data-add-model]");
  if (!form) return;
  event.preventDefault();
  const id = form.model.value;
  if (id) changeJobModels(form.dataset.addModel, (ids) => [...ids, id]);
});

// A click anywhere on a plan's or conversation's row opens it, like its › button (other buttons,
// links, fields and selected text excepted).
function rowToggle(event, attr) {
  if (event.target.closest(`[${attr}]`)) return event.target.closest(`[${attr}]`);
  const row = event.target.closest("tr.job-row");
  if (!row || event.target.closest("button, a, input, select, label, .info") || String(window.getSelection())) return null;
  return row.querySelector(`[${attr}]`);
}

$("jobRows").addEventListener("click", async (event) => {
  const toggle = rowToggle(event, "data-toggle-job");
  if (toggle) return toggleJob(toggle.dataset.toggleJob);

  const plan = event.target.closest("[data-plan-model]");
  const drop = event.target.closest("[data-remove-model]");
  if (plan) return changeJobModels(plan.dataset.job, (ids) => [plan.dataset.planModel, ...ids.filter((id) => id !== plan.dataset.planModel)]);
  if (drop) return changeJobModels(drop.dataset.job, (ids) => ids.filter((id) => id !== drop.dataset.removeModel));
  const remove = event.target.closest("[data-delete]");
  if (!remove) return;
  const job = state.jobs.find((j) => j.id === remove.dataset.delete);
  if (job && confirm(`Delete "${job.title}" from your plans?`)) {
    await api.deleteJob(job.id);
    await reloadStore();
  }
});

document.addEventListener("click", (event) => {
  const sw = event.target.closest("[data-track]");
  if (sw && !sw.disabled) return setTracking(sw.dataset.track, sw.getAttribute("aria-checked") !== "true");
  // "Go to Tracking" in an empty History: the Tracking switches on Settings & help.
  if (event.target.closest("[data-go-tracking]")) {
    showView("help", { animate: true });
    $("trackingTitle").scrollIntoView({ behavior: "smooth", block: "start" });
    const first = document.querySelector("#trackingSources .switch:not([disabled])");
    if (first) first.focus({ preventScroll: true });
    return;
  }
  // "Connect your AI tool" on Jobs: the setup, at the top of Settings & help.
  if (event.target.closest("[data-go-connect]")) {
    showView("help", { animate: true });
    $("connect").scrollIntoView({ behavior: "smooth", block: "start" });
    const first = document.querySelector("[data-ai-tool]");
    if (first) first.focus({ preventScroll: true });
    return;
  }
  // "Read more" next to a ⚠ step: open that help section on Settings & help.
  const help = event.target.closest("[data-open-help]");
  if (help) {
    showView("help", { animate: state.view !== "help" });
    const box = document.getElementById(help.dataset.openHelp);
    if (box) {
      box.open = true;
      box.scrollIntoView({ behavior: "smooth", block: "start" });
      box.querySelector("summary").focus({ preventScroll: true });
    }
  }
});

$("historyKeep").addEventListener("change", async (event) => {
  const days = Number(event.target.value);
  if (days > 0 && !confirm(`Keep ${days === 365 ? "1 year" : `${days} days`} of spending history? Older history TokenScope has saved is deleted right away.`)) {
    event.target.value = String(state.history ? state.history.keepDays : 90);
    return;
  }
  await api.setHistoryKeep(days);
  state.history = null;
  if (state.view === "history") loadHistory();
});

// Search as you type, a moment after the last key, from the top of the list.
let historySearchTimer = null;
$("historySearch").addEventListener("input", (event) => {
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => {
    state.historySearch = event.target.value;
    state.historyShown = PAGE;
    if (state.history) renderHistory();
  }, 120);
});
$("historyRows").addEventListener("click", (event) => {
  if (!event.target.closest("[data-clear-history-search]")) return;
  $("historySearch").value = "";
  state.historySearch = "";
  state.historyShown = PAGE;
  renderHistory();
  $("historySearch").focus();
});

$("historyMore").addEventListener("click", () => {
  const before = $("historyRows").children.length;
  state.historyShown += PAGE;
  renderHistory();
  animateRows($("historyRows"), before);
});

// The models conversations are compared with, kept between launches.
function setCompareModels(ids) {
  state.compareModels = ids;
  save("compareModels", ids);
  renderHistory();
}

$("historyRows").addEventListener("submit", (event) => {
  const form = event.target.closest("[data-compare-add]");
  if (!form) return;
  event.preventDefault();
  const id = form.model.value;
  if (id) setCompareModels([...new Set([...(state.compareModels || [...state.favorites]), id])]);
});

$("historyRows").addEventListener("click", (event) => {
  const drop = event.target.closest("[data-compare-remove]");
  if (drop) return setCompareModels((state.compareModels || [...state.favorites]).filter((id) => id !== drop.dataset.compareRemove));
  const subToggle = event.target.closest("[data-toggle-subagents]");
  if (subToggle) {
    const id = subToggle.dataset.toggleSubagents;
    if (state.openSubagents.has(id)) state.openSubagents.delete(id);
    else state.openSubagents.add(id);
    renderHistory();
    const again = [...document.querySelectorAll("[data-toggle-subagents]")].find((b) => b.dataset.toggleSubagents === id);
    if (again) again.focus();
    return;
  }
  const moreSubagents = event.target.closest("[data-more-subagents]");
  if (moreSubagents) {
    const id = moreSubagents.dataset.moreSubagents;
    state.subagentsShown.set(id, (state.subagentsShown.get(id) || PAGE_SMALL) + PAGE_SMALL);
    return renderHistory();
  }
  const t = rowToggle(event, "data-toggle-conv");
  if (!t) return;
  const id = t.dataset.toggleConv;
  if (state.openConversations.has(id)) state.openConversations.delete(id);
  else state.openConversations.add(id);
  renderHistory();
  const again = [...document.querySelectorAll("[data-toggle-conv]")].find((b) => b.dataset.toggleConv === id);
  if (again) again.focus();
  if (state.openConversations.has(id)) replay(again && again.closest("tr").nextElementSibling, "panel-in");
});

// While History is open, new conversations show up by themselves.
setInterval(() => state.view === "history" && loadHistory(), 60e3);


// Tabs: click, or arrow keys when a tab has focus.
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.dataset.view === state.view) return;
    showView(tab.dataset.view, { animate: true });
    if (state.view === "jobs") api.syncJobs().catch(() => {});
  });
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const next = VIEWS[(VIEWS.indexOf(state.view) + (event.key === "ArrowRight" ? 1 : VIEWS.length - 1)) % VIEWS.length];
    showView(next, { animate: true });
    $(`tab-${next}`).focus();
  });
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  await api.copy($(button.dataset.copy).textContent);
  snackbar("Copied.");
});

// Set up opens one tool's steps at a time; pressing it again closes them.
function pickAiTool(key) {
  state.aiTool = state.aiTool === key ? null : key;
  renderConnect();
  const button = document.querySelector(`[data-ai-tool="${key}"]`);
  if (button) button.focus();
}

// Snackbar (Material): a short message at the bottom, over the page, so nothing moves. Several
// stack. Each goes away after a few seconds. The ✓ says it worked without relying on color.
function snackbar(text) {
  const bar = document.createElement("div");
  bar.className = "snackbar";
  bar.innerHTML = `<span class="snackbar-icon" aria-hidden="true">✓</span><span>${escape(text)}</span>`;
  $("snackbars").append(bar);
  setTimeout(() => {
    bar.classList.add("leaving");
    setTimeout(() => bar.remove(), 250);
  }, 4000);
}

// Which version this is, at the bottom of Settings & help, and whether a newer one is waiting.
function showVersion(ready) {
  api.appVersion().then((v) => {
    $("appVersion").textContent = `TokenScope ${v}${ready ? ` · ${ready} is ready to install` : ""}`;
  }).catch(() => {});
}
showVersion(null);

// A new version is downloaded: ask, with a choice, until answered. Later installs it on close.
function updateReady(version) {
  if (version) showVersion(version);
  if (!version || document.querySelector(".snackbar.update")) return;
  const bar = document.createElement("div");
  bar.className = "snackbar update";
  bar.innerHTML = `<span>TokenScope ${escape(version)} is ready to install.</span>
    <button type="button" class="snackbar-action" data-update="later">Later</button>
    <button type="button" class="snackbar-action" data-update="now">Restart now</button>`;
  bar.addEventListener("click", (event) => {
    const choice = event.target.closest("[data-update]");
    if (!choice) return;
    if (choice.dataset.update === "now") {
      choice.disabled = true;
      api.installUpdate();
      return;
    }
    bar.classList.add("leaving");
    setTimeout(() => bar.remove(), 250);
    snackbar("It installs the next time you close TokenScope.");
  });
  $("snackbars").append(bar);
}
api.onUpdateReady(updateReady);
api.updateStatus().then(updateReady).catch(() => {});

// The cost breakdown bars get their widths here: the page's security rules don't allow sizes
// written into the HTML itself.
new MutationObserver(() => {
  for (const bar of document.querySelectorAll(".driver[data-share]")) {
    bar.style.width = `${bar.dataset.share}%`;
    delete bar.dataset.share;
  }
}).observe(document.body, { childList: true, subtree: true });

$("aiTools").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-ai-tool]");
  if (button) return pickAiTool(button.dataset.aiTool);
  const prompt = event.target.closest("[data-copy-prompt]");
  if (prompt) {
    await api.copy(setupPrompt(aiTools(connect)[prompt.dataset.copyPrompt]));
    snackbar("Setup prompt copied. Paste it into your AI.");
  }
});


// Tooltips: screen readers get the same text, and Esc closes them (WCAG 1.4.13).
document.querySelectorAll(".info").forEach((el) => {
  el.setAttribute("aria-label", el.dataset.tip);
  const reset = () => el.classList.remove("dismissed");
  el.addEventListener("mouseleave", reset);
  el.addEventListener("blur", reset);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") document.querySelectorAll(".info").forEach((el) => el.classList.add("dismissed"));
});

$("refresh").addEventListener("click", loadData);
$("openData").addEventListener("click", () => api.openDataFolder());

// Clearing saved data. Each asks first, then the window shows what's left, on the same tab.
const CLEAR_QUESTIONS = {
  prices: "Clear the saved prices and get fresh ones from OpenRouter?",
  settings: "Reset filters, sort, token budget, search and theme? Favorites and plans stay.",
  favorites: "Remove all your favorites?",
  jobs: "Delete all plans, with their estimates and real costs? This can't be undone.",
  history: "Delete the history TokenScope saved? Cursor conversations, and older ones Claude Code, Codex, OpenCode or Zed no longer keep themselves, disappear from Spending. This can't be undone.",
  all: "Delete everything and start over as if TokenScope was just installed? This removes plans, favorites, settings, saved prices and saved history, and switches tracking off. This can't be undone.",
};
const CLEAR_DONE = {
  prices: "Price cache cleared. Fresh prices loaded.",
  settings: "Settings reset.",
  favorites: "Favorites cleared.",
  history: "Saved spending history deleted.",
  jobs: "All plans deleted.",
  all: "Everything deleted. TokenScope is back to how it was when installed.",
};
document.querySelectorAll("[data-clear]").forEach((button) =>
  button.addEventListener("click", async () => {
    const kind = button.dataset.clear;
    if (!confirm(CLEAR_QUESTIONS[kind])) return;
    try {
      await api.clearData(kind);
      // Updated in place, so you stay where you are.
      applyStore(await api.readStore());
      if (kind === "prices" || kind === "all") await loadData();
      snackbar(CLEAR_DONE[kind]);
    } catch (error) {
      alert("Couldn't do that: " + error.message);
    }
  })
);
window.addEventListener("resize", moveTabIndicator);

// Changes made by the AI (or by hand in the data file) show up here: favorites and jobs.
api.onStoreChanged(() => reloadStore().catch(() => {}));

// Puts the saved data and settings into the window. Used at start and after clearing data,
// which happens in place: the window stays on the tab you're on.
function applyStore(data) {
  const s = data.settings;
  state.favorites = new Set(data.favorites);
  state.jobs = data.jobs;
  state.connections = data.connections || {};
  state.providers = new Set(Array.isArray(s.providers) ? s.providers : []);
  state.compareModels = Array.isArray(s.compareModels) ? s.compareModels : null;
  state.sort = SORTS.includes(s.sort) ? s.sort : "buck";
  state.tokensText = typeof s.tokens === "string" ? s.tokens : "1M";
  state.tokensMillions = parseTokens(state.tokensText) ?? 1;
  state.search = typeof s.search === "string" ? s.search : "";
  state.theme = s.theme === "light" ? "light" : "dark";
  $("search").value = state.search;
  $("tokens").value = state.tokensText;
  applyTheme();
  $("historyKeep").value = String(s.historyDays !== undefined && Number.isFinite(Number(s.historyDays)) ? s.historyDays : 90);
  // Sources, then a quiet history read for data warnings, even before History is opened.
  state.history = null;
  loadSources().then(() => (anyTracking() ? loadHistory() : renderHistory()));
  renderConnect();
  renderAll();
}

async function start() {
  let data = { favorites: [], settings: {}, jobs: [] };
  try {
    data = await api.readStore();
  } catch {}
  state.view = "models"; // always start on Models
  showView(state.view);
  applyStore(data);
  // Place the tab line first, then let it slide from then on.
  requestAnimationFrame(() => $("tabIndicator").classList.add("ready"));
  setUpConnect();
  await loadData();
}

start();
