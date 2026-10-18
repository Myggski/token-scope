// Cost estimates for a token budget or a planned agent job.
// Shared by the app's main process (Node), its window and the MCP mode.
(function (exports) {
  // What a job's tokens cost on one model. Input includes the cached part.
  function tokenCost(model, { input = 0, cached = 0, output = 0 }) {
    const cachedPrice = model.cachedPerM === null || model.cachedPerM === undefined ? model.inPerM : model.cachedPerM;
    return ((input - cached) * model.inPerM + cached * cachedPrice + output * model.outPerM) / 1e6;
  }

  // Share of re-sent context assumed to be read from the cache. Within one busy session it's
  // usually 95-99%. Long pauses (the cache expires), model switches, the agent compacting its
  // context and new sessions all lower it.
  // 0.9: most coding jobs have builds, tests or waits for the user that let the cache expire
  // (after 5 minutes at many providers, an hour in Claude Code). One unbroken session can reach 99%.
  const DEFAULT_CACHE_HIT = 0.9;

  // An agent re-sends the whole conversation on every step, so input grows with each step.
  // Each step adds what tools returned (file reads, test output) and what the model wrote.
  // fresh: tokens sent for the first time. resent: tokens sent before (the cache can cover these).
  function planTokens({ steps, startContext, contextPerStep, outputPerStep }) {
    const n = Math.max(1, Math.round(steps));
    const growth = contextPerStep + outputPerStep;
    const input = n * startContext + (growth * n * (n - 1)) / 2;
    const fresh = startContext + (n - 1) * growth;
    return { steps: n, input, fresh, resent: input - fresh, cached: input - fresh, output: n * outputPerStep, peakContext: startContext + (n - 1) * growth + outputPerStep };
  }

  // What an agent job's tokens cost. With caching: re-sent tokens that hit the cache cost the cached
  // price. New tokens, and re-sent ones that miss, are written to the cache, which costs the
  // provider's cache-write price (more than normal input at some providers, like Anthropic).
  // Models without a cached price pay the normal input price for everything.
  function agentCost(model, t, cacheHit) {
    if (model.cachedPerM === null || model.cachedPerM === undefined) {
      return { cost: (t.input * model.inPerM + t.output * model.outPerM) / 1e6, cached: 0, written: 0 };
    }
    const cached = t.resent * cacheHit;
    const written = t.fresh + t.resent * (1 - cacheHit);
    const writePrice = model.cacheWritePerM ?? model.inPerM;
    return { cost: (cached * model.cachedPerM + written * writePrice + t.output * model.outPerM) / 1e6, cached, written };
  }

  // Plans slip, so every estimate is a range. Likely adds the expected rework;
  // high assumes 50% more steps than that and bigger steps; low assumes things go smoothly.
  const SCENARIOS = {
    low: { stepFactor: (rework) => 1, sizeFactor: 0.8 },
    likely: { stepFactor: (rework) => 1 + rework, sizeFactor: 1 },
    high: { stepFactor: (rework) => (1 + rework) * 1.5, sizeFactor: 1.25 },
  };

  function scenarioTokens(plan, name) {
    const s = SCENARIOS[name];
    const rework = plan.rework ?? 0.2;
    return planTokens({
      steps: plan.steps * s.stepFactor(rework),
      startContext: plan.startContext,
      contextPerStep: plan.contextPerStep * s.sizeFactor,
      outputPerStep: plan.outputPerStep * s.sizeFactor,
    });
  }

  const cacheHitOf = (plan, override) => override ?? plan.cacheHit ?? DEFAULT_CACHE_HIT;

  // Raw estimate for one model (before correcting with past jobs). cacheHit overrides the plan's.
  function estimatePlan(model, plan, cacheHit) {
    const hit = cacheHitOf(plan, cacheHit);
    const result = {};
    for (const name of Object.keys(SCENARIOS)) result[name] = agentCost(model, scenarioTokens(plan, name), hit).cost;
    const likely = scenarioTokens(plan, "likely");
    const split = agentCost(model, likely, hit);
    result.cacheHit = hit;
    result.tokens = { input: Math.round(likely.input), cached: Math.round(split.cached), written: Math.round(split.written), output: Math.round(likely.output) };
    result.peakContext = Math.round(likely.peakContext);
    result.fitsContext = !model.context || likely.peakContext <= model.context;
    return result;
  }

  // Learns how far off estimates have been: actual cost / likely estimate for the model used,
  // over past jobs that have both. Geometric mean, so 2x over and 2x under cancel out.
  function correction(jobs) {
    const ratios = [];
    for (const job of jobs || []) {
      const a = job.actual, e = a && job.estimates && job.estimates[a.modelId];
      // A job still running hasn't reached its full cost yet.
      if (a && e && a.status !== "running" && e.likely > 0 && a.costUsd > 0) ratios.push(a.costUsd / e.likely);
    }
    if (ratios.length < 2) return { factor: 1, jobs: ratios.length, applied: false };
    const factor = Math.exp(ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length);
    return { factor: Math.min(5, Math.max(0.2, factor)), jobs: ratios.length, applied: true };
  }

  function applyCorrection(estimate, factor) {
    return { ...estimate, low: estimate.low * factor, likely: estimate.likely * factor, high: estimate.high * factor };
  }

  function validPhase(plan) {
    const ok = (v, min = 0) => typeof v === "number" && isFinite(v) && v >= min;
    const hit = plan && plan.cacheHit;
    return !!plan && ok(plan.steps, 1) && ok(plan.startContext) && ok(plan.contextPerStep) && ok(plan.outputPerStep) && ok(plan.rework ?? 0) &&
      (hit === undefined || hit === null || (ok(hit) && hit <= 1));
  }

  // A plan is either one phase, or { phases: [...] } where each phase is its own agent session.
  function validPlan(plan) {
    if (plan && Array.isArray(plan.phases)) return plan.phases.length > 0 && plan.phases.every(validPhase);
    return validPhase(plan);
  }

  // Estimate for a whole job: a single plan, or the sum of its phases.
  // cacheHit, when given, replaces every phase's own setting (for "what if" numbers).
  function estimateJob(model, plan, cacheHit) {
    if (!plan || !Array.isArray(plan.phases)) return estimatePlan(model, plan, cacheHit);
    const parts = plan.phases.map((phase) => estimatePlan(model, phase, cacheHit));
    const sum = (key) => parts.reduce((total, p) => total + p[key], 0);
    const tokens = (key) => parts.reduce((total, p) => total + p.tokens[key], 0);
    return {
      low: sum("low"), likely: sum("likely"), high: sum("high"),
      cacheHit: parts.every((p) => p.cacheHit === parts[0].cacheHit) ? parts[0].cacheHit : null,
      tokens: { input: tokens("input"), cached: tokens("cached"), written: tokens("written"), output: tokens("output") },
      peakContext: Math.max(...parts.map((p) => p.peakContext)),
      fitsContext: parts.every((p) => p.fitsContext),
      phases: parts.map((p, i) => ({ name: plan.phases[i].name || `Phase ${i + 1}`, low: p.low, likely: p.likely, high: p.high })),
    };
  }

  // The likely cost if caching works less well than assumed: one number per cache hit rate.
  // Three named situations, as cache hit rates: smooth work (3% misses), long pauses (25%), many restarts (50%).
  const WHAT_IF_RATES = [0.97, 0.75, 0.5];
  function cacheWhatIf(model, plan, rates = WHAT_IF_RATES) {
    if (model.cachedPerM === null || model.cachedPerM === undefined) return null; // no caching, nothing changes
    return rates.map((rate) => ({ cacheHit: rate, likely: estimateJob(model, plan, rate).likely }));
  }

  // The plan's sizes in plain words, so people can see what an estimate rests on.
  function describePhase(p) {
    const k = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n)));
    return `${p.steps} steps + ${Math.round((p.rework ?? 0.2) * 100)}% rework, starts with ${k(p.startContext)} tokens, reads ${k(p.contextPerStep)} and writes ${k(p.outputPerStep)} per step, ${Math.round((1 - cacheHitOf(p)) * 100)}% cache misses`;
  }

  Object.assign(exports, { DEFAULT_CACHE_HIT, tokenCost, planTokens, agentCost, estimatePlan, estimateJob, cacheWhatIf, describePhase, correction, applyCorrection, validPlan });
})(typeof module !== "undefined" ? module.exports : (window.Estimate = {}));
