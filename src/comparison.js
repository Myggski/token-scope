// Comparison: a time estimate for a task next to what its conversations took and cost. Shared by the
// window and the tests.
// Time is priced from an estimated monthly cost of one person's work. A month of work is counted as
// 160 hours (4 weeks of 5 days of 8 hours), a day as 8 hours and a week as 40.
(function (exports) {
  const MONTH_HOURS = 160;
  const UNIT_HOURS = { hours: 1, days: 8, weeks: 40 };

  // How long the picked conversations took, from each one's first message to its last reply.
  // Conversations that ran at the same time count once.
  function timeWithAi(conversations) {
    const spans = conversations.filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end >= c.start).map((c) => [c.start, c.end]).sort((a, b) => a[0] - b[0]);
    let ms = 0, from = null, to = null;
    for (const [s, e] of spans) {
      if (to === null || s > to) {
        if (to !== null) ms += to - from;
        from = s;
        to = e;
      } else to = Math.max(to, e);
    }
    if (to !== null) ms += to - from;
    return ms / 3600e3; // hours
  }

  // monthlyCost: roughly what a month of one person's work costs (USD). estimateHours: the time
  // estimate. measuredHours: what the conversations took. tokens: what they cost. Any may be missing
  // (null): what can't be worked out is null.
  function compare({ monthlyCost, estimateHours, measuredHours, tokens }) {
    const hourly = monthlyCost > 0 ? monthlyCost / MONTH_HOURS : null;
    const estimate = hourly !== null && estimateHours > 0 ? hourly * estimateHours : null;
    const timeCost = hourly !== null && measuredHours >= 0 ? hourly * measuredHours : null;
    const conversations = timeCost !== null ? timeCost + (tokens || 0) : null;
    return {
      hourly,
      estimate,
      timeCost,
      conversations,
      difference: estimate !== null && conversations !== null ? estimate - conversations : null, // positive: the estimate is higher
      hoursDifference: estimateHours > 0 && measuredHours >= 0 ? estimateHours - measuredHours : null,
    };
  }

  // A time as typed: "3w 4d 3h", "2w", "1.5d", "90m", "2 weeks 3 days". A number without a unit
  // is hours. Returns hours, null for nothing typed, or NaN when it can't be read.
  const UNITS = [[/^(w|wk|wks|week|weeks)$/, 40], [/^(d|day|days)$/, 8], [/^(h|hr|hrs|hour|hours)$/, 1], [/^(m|min|mins|minute|minutes)$/, 1 / 60]];
  function parseDuration(text) {
    const t = String(text || "").trim().toLowerCase();
    if (!t) return null;
    let hours = 0, rest = t;
    const part = /^(\d+(?:[.,]\d+)?)\s*([a-z]*)\s*,?\s*/;
    while (rest) {
      const m = rest.match(part);
      if (!m) return NaN;
      const unit = m[2] ? UNITS.find(([re]) => re.test(m[2])) : [null, 1];
      if (!unit) return NaN;
      hours += Number(m[1].replace(",", ".")) * unit[1];
      rest = rest.slice(m[0].length);
    }
    return hours;
  }

  // Hours as weeks, days and hours (40 and 8 hours), written out so "m" can't be mistaken for months:
  // "2 weeks 3 days 4 h", "30 min".
  function formatDuration(hours) {
    if (!(hours > 0)) return "0 min";
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
    let left = Math.round(hours * 10) / 10;
    const out = [];
    for (const [size, one, many] of [[40, "week", "weeks"], [8, "day", "days"]]) {
      const n = Math.floor(left / size + 1e-9);
      if (n) out.push(`${n} ${n === 1 ? one : many}`);
      left = Math.round((left - n * size) * 10) / 10;
    }
    if (left) out.push(`${left} h`);
    return out.join(" ");
  }

  Object.assign(exports, { MONTH_HOURS, UNIT_HOURS, timeWithAi, compare, parseDuration, formatDuration });
})(typeof module !== "undefined" ? module.exports : (window.Comparison = {}));
