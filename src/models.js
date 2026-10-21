// OpenRouter's model list, and the sorts. Shared by the app's main process, its window and the MCP program.
(function (exports) {
  // OpenRouter variants like ":free" or ":batch" duplicate a base model.
  const isVariant = (id) => id.includes(":") || id.startsWith("~");
  const perM = (value) => (value === undefined || value === null || value === "" ? null : Number(value) * 1e6);

  // "Anthropic: Claude Opus 5.5" -> provider "Anthropic", name "Claude Opus 5.5".
  function splitName(fullName, id) {
    const colon = fullName.indexOf(": ");
    if (colon > 0) return { provider: fullName.slice(0, colon), name: fullName.slice(colon + 2) };
    return { provider: id.split("/")[0], name: fullName };
  }

  // Accepts the live API response ({data: [...]}) or the bundled snapshot ({models: [...]}).
  // Prices are per million tokens. blended weighs 3 input tokens per output token.
  function parseOpenRouter(json) {
    const seen = new Set();
    const models = [];
    for (const m of json.data || json.models || []) {
      if (isVariant(m.id) || seen.has(m.id)) continue;
      const outputs = (m.architecture && m.architecture.output_modalities) || ["text"];
      if (!outputs.every((o) => o === "text")) continue;
      const p = m.pricing || { prompt: m.prompt, completion: m.completion, input_cache_read: m.cacheRead, input_cache_write: m.cacheWrite };
      const inPerM = perM(p.prompt), outPerM = perM(p.completion);
      // Negative prices mark routers with variable pricing; zero output price marks utility endpoints.
      if (!(inPerM >= 0) || !(outPerM > 0)) continue;
      seen.add(m.id);
      models.push({
        id: m.id,
        ...splitName(m.name || m.id, m.id),
        inPerM,
        outPerM,
        cachedPerM: perM(p.input_cache_read),
        cacheWritePerM: perM(p.input_cache_write),
        blended: (3 * inPerM + outPerM) / 4,
        created: m.created || null,
        context: m.context_length || m.context || null,
        retires: m.expiration_date || m.retires || null,
      });
    }
    return models;
  }

  // Best for the buck: grades each model with a Capability score (Epoch AI) 0-100 against the others
  // shown, its score and its price counting equally. Price uses ratios (log), so $0.25 -> $0.50
  // counts like $5 -> $10. Models without a score get no grade.
  function gradeBangForBuck(list) {
    const spread = (values) => {
      const min = Math.min(...values);
      return { min, range: Math.max(...values) - min || 1 };
    };
    const logPrice = (m) => Math.log(m.blended || 1e-9);
    const scored = list.filter((m) => m.capability);
    const cap = spread(scored.map((m) => m.capability.score)), price = spread(scored.map(logPrice));
    for (const m of list) {
      m.buck = m.capability ? 100 * (0.5 * (m.capability.score - cap.min) / cap.range + 0.5 * (1 - (logPrice(m) - price.min) / price.range)) : null;
    }
  }

  // sort: "buck", "cost", "newest" or "capable". In "buck" and "capable", models without a
  // Capability score come last, newest first.
  function sortRows(rows, sort) {
    const byPrice = (a, b) => a.blended - b.blended;
    const byDate = (a, b) => (b.created || 0) - (a.created || 0);
    const unscoredLast = (a, b) => !a.capability - !b.capability;
    if (sort === "cost") return rows.sort(byPrice);
    if (sort === "newest") return rows.sort(byDate);
    if (sort === "capable") {
      return rows.sort((a, b) => unscoredLast(a, b) || (a.capability ? b.capability.score - a.capability.score : byDate(a, b)) || byPrice(a, b));
    }
    gradeBangForBuck(rows);
    return rows.sort((a, b) => unscoredLast(a, b) || (a.capability ? b.buck - a.buck : byDate(a, b)) || byPrice(a, b));
  }

  Object.assign(exports, { parseOpenRouter, sortRows, gradeBangForBuck });
})(typeof module !== "undefined" ? module.exports : (window.Models = {}));
