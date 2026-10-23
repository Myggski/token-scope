// Active time: how long something actually happened in conversations, instead of from the first
// message to the last reply (a conversation you came back to days later would count as days).
// Shared by the readers (main process), the window and the MCP program.
//
// Readers record each conversation's activity as spans: every message, reply and tool run is a
// moment or a stretch of time, and those closer than BASE_GAP are joined. The short gaps kept
// there are what the break length (a setting) is applied to later, so it can change without
// reading the tools' logs again.
(function (exports) {
  const BASE_GAP = 2 * 60e3; // joined while reading; the break setting can't go below this
  const DEFAULT_BREAK_MINUTES = 20;
  const MIN_BREAK_MINUTES = 5;
  const MAX_BREAK_MINUTES = 240;

  // Moments (times) and stretches ([start, end]) into sorted spans, joined when gap ms or less apart.
  function joinSpans(list, gap) {
    const sorted = list.filter((s) => Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] >= s[0]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [s, e] of sorted) {
      const last = out[out.length - 1];
      if (last && s - last[1] <= gap) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    return out;
  }

  // A conversation's activity, as readers save it: moments and stretches joined at BASE_GAP.
  function activitySpans({ points = [], intervals = [] } = {}) {
    return joinSpans([...points.map((t) => [t, t]), ...intervals.map((x) => [x[0], x[1]])], BASE_GAP);
  }

  // A valid break length in minutes, or the default.
  function breakMinutes(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= MIN_BREAK_MINUTES && n <= MAX_BREAK_MINUTES ? n : DEFAULT_BREAK_MINUTES;
  }

  // Active hours of conversations together, gaps longer than the break left out. Conversations
  // that ran at the same time count once, and switching between them isn't a break. A conversation
  // without activity (Zed, or saved before 1.0.23) counts from its first message to its last reply,
  // so the result is approximate.
  function activeTime(conversations, minutes = DEFAULT_BREAK_MINUTES) {
    const gap = breakMinutes(minutes) * 60e3;
    const spans = [];
    let approximate = false;
    for (const c of conversations) {
      if (Array.isArray(c.activity) && c.activity.length) spans.push(...c.activity);
      else if (Number.isFinite(c.start) && Number.isFinite(c.end) && c.end >= c.start) {
        spans.push([c.start, c.end]);
        approximate = true;
      }
    }
    const ms = joinSpans(spans, gap).reduce((sum, [s, e]) => sum + (e - s), 0);
    return { hours: ms / 3600e3, approximate };
  }

  Object.assign(exports, { BASE_GAP, DEFAULT_BREAK_MINUTES, MIN_BREAK_MINUTES, MAX_BREAK_MINUTES, activitySpans, breakMinutes, activeTime });
})(typeof module !== "undefined" ? module.exports : (window.Activity = {}));
