// Patterns: five habits that affect what AI work costs, from the conversations' own facts (see
// insights.js). Facts, not grades. Shared by the window and the tests.
//
// How much history decides what's compared:
//   under 8 weeks:        the last 30 days, no comparison ("new")
//   8 weeks to 12 weeks:  the last 4 weeks next to the 4 before ("previous")
//   12 weeks or more:     the last 4 weeks next to your usual, the 8 weeks before ("usual")
// 12 weeks fit in the 90 days Spending keeps by default.
// Each period needs about 10 conversations: with fewer, Patterns is hidden (or isn't compared).
(function (exports) {
  const DAY = 86400e3;
  const MIN_CONVERSATIONS = 10;

  // Conversations with per-step facts: not Zed (totals only), not forks with nothing of their own.
  const counted = (c) => c && !c.copyOnly && !c.totalsOnly && c.insights && c.insights.facts && c.insights.drivers;

  // The three habits for some conversations. null where it can't be worked out (nothing paid, or
  // only conversations saved by an older version without that fact).
  function habits(list) {
    const paid = list.reduce((s, c) => s + (c.cost || 0), 0);
    const share = (part, of) => (of > 0 ? part / of : null);
    const withCompactions = list.filter((c) => typeof c.insights.facts.compactions === "number");
    const withSwitches = list.filter((c) => typeof c.insights.drivers.switches === "number"); // 1.0.24 and later
    const withLong = list.filter((c) => typeof c.insights.facts.longStepsCostUsd === "number");
    return {
      conversations: list.length,
      cacheWhileWaiting: share(list.reduce((s, c) => s + (c.insights.drivers.pausesYou || 0), 0), paid),
      cacheDuringCommands: share(list.reduce((s, c) => s + (c.insights.drivers.pausesTools || 0), 0), paid),
      switching: share(withSwitches.reduce((s, c) => s + c.insights.drivers.switches, 0), withSwitches.reduce((s, c) => s + (c.cost || 0), 0)),
      // On average, how many times a conversation was compacted.
      compactions: withCompactions.length ? withCompactions.reduce((s, c) => s + c.insights.facts.compactions, 0) / withCompactions.length : null,
      longConversations: share(withLong.reduce((s, c) => s + c.insights.facts.longStepsCostUsd, 0), withLong.reduce((s, c) => s + (c.cost || 0), 0)),
    };
  }

  // { stage, now: habits, before: habits | null, periods: { now: [from, to], before: [from, to] | null } }
  // or null when there's too little to show.
  function patterns(conversations, now = Date.now()) {
    const list = conversations.filter(counted);
    if (!list.length) return null;
    const first = Math.min(...list.map((c) => c.start).filter(Number.isFinite));
    const span = now - first;
    const inside = (from, to) => list.filter((c) => c.end >= from && c.end < to);
    const recent = inside(now - 28 * DAY, now + 1);
    let stage = span >= 84 * DAY ? "usual" : span >= 56 * DAY ? "previous" : "new";
    let before = null;
    if (stage !== "new") {
      const earlier = stage === "usual" ? inside(now - 84 * DAY, now - 28 * DAY) : inside(now - 56 * DAY, now - 28 * DAY);
      if (earlier.length >= MIN_CONVERSATIONS && recent.length >= MIN_CONVERSATIONS) before = habits(earlier);
      else stage = "new";
    }
    const current = stage === "new" ? inside(now - 30 * DAY, now + 1) : recent;
    if (current.length < MIN_CONVERSATIONS) return null;
    const periods = {
      now: [now - (stage === "new" ? 30 : 28) * DAY, now],
      before: stage === "usual" ? [now - 84 * DAY, now - 28 * DAY] : stage === "previous" ? [now - 56 * DAY, now - 28 * DAY] : null,
    };
    return { stage, now: habits(current), before, periods };
  }

  Object.assign(exports, { MIN_CONVERSATIONS, patterns, habits });
})(typeof module !== "undefined" ? module.exports : (window.Patterns = {}));
