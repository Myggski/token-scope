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

  // Best for the buck: grades each model 0-100 against the others shown, newness and price
  // counting equally. Price uses ratios (log), so $0.25 -> $0.50 counts like $5 -> $10.
  function gradeBangForBuck(list) {
    const pool = list.filter((m) => m.created);
    const logPrice = (m) => Math.log(m.blended || 1e-9);
    const dates = pool.map((m) => m.created), prices = pool.map(logPrice);
    const minDate = Math.min(...dates), dateRange = Math.max(...dates) - minDate || 1;
    const minPrice = Math.min(...prices), priceRange = Math.max(...prices) - minPrice || 1;
    for (const m of list) {
      m.buck = m.created ? 100 * (0.5 * (m.created - minDate) / dateRange + 0.5 * (1 - (logPrice(m) - minPrice) / priceRange)) : null;
    }
  }

  // sort: "buck", "cost" or "newest". Models without a release date go last in "buck".
  function sortRows(rows, sort) {
    const byPrice = (a, b) => a.blended - b.blended;
    if (sort === "cost") return rows.sort(byPrice);
    if (sort === "newest") return rows.sort((a, b) => (b.created || 0) - (a.created || 0));
    gradeBangForBuck(rows);
    return rows.sort((a, b) => (a.buck === null) - (b.buck === null) || (b.buck || 0) - (a.buck || 0) || byPrice(a, b));
  }

  Object.assign(exports, { parseOpenRouter, sortRows });
})(typeof module !== "undefined" ? module.exports : (window.Models = {}));
