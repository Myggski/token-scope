// Searching Spending's conversations. Shared by the window and the tests.
// Every word you type has to match somewhere (any order). Capitals and accents don't matter, and one
// typo in a word of 5 letters or more is forgiven. Conversations whose name has all the words come
// first, then those that match through the smaller text (project, tool, models, date, subagents).
(function (exports) {
  const fold = (text) => String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const words = (text) => fold(text).split(/[^a-z0-9.$#@+-]+/).filter(Boolean);

  // At most one letter added, removed, changed or two swapped (Damerau, limited to 1).
  function oneEdit(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) {
      if (a.slice(i + 1) === b.slice(i + 1)) return true; // one changed
      return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // two swapped
    }
    const [long, short] = a.length > b.length ? [a, b] : [b, a];
    return long.slice(i + 1) === short.slice(i); // one added or removed
  }

  // How a typed word matches a text: 3 a word starts with it, 2 it's inside, 1 a near miss, 0 no.
  function wordMatch(term, text, textWords) {
    if (!term) return 3;
    if (textWords.some((w) => w.startsWith(term))) return 3;
    if (text.includes(term)) return 2;
    if (term.length >= 5 && textWords.some((w) => oneEdit(term, w) || (w.length > term.length && oneEdit(term, w.slice(0, term.length))))) return 1;
    return 0;
  }

  // items: { title, details } per conversation (details: the smaller text). Returns the matching
  // indexes, name matches first, each group in the order given (newest first in Spending), with
  // which typed words matched the name (for highlighting).
  function searchConversations(items, query) {
    const terms = words(query);
    if (!terms.length) return items.map((_, index) => ({ index, group: 0 }));
    const hits = [];
    items.forEach((item, index) => {
      const title = fold(item.title), titleWords = words(item.title);
      const details = fold(item.details), detailWords = words(item.details);
      let inTitle = 0, exact = true;
      for (const term of terms) {
        const t = wordMatch(term, title, titleWords);
        if (t) {
          inTitle++;
          if (t === 1) exact = false;
          continue;
        }
        const d = wordMatch(term, details, detailWords);
        if (!d) return; // every word has to match somewhere
        if (d === 1) exact = false;
      }
      // 0: all words in the name, 1: some in the smaller text, then near misses after exact ones.
      const group = (inTitle === terms.length ? 0 : 2) + (exact ? 0 : 1);
      hits.push({ index, group });
    });
    return hits.sort((a, b) => a.group - b.group || a.index - b.index);
  }

  // Where the typed words appear in a text, for <mark>: [start, end) ranges in the text as written,
  // merged. Folding can change lengths (é -> e), so positions are mapped back character by character.
  function highlights(text, query) {
    const source = String(text || "");
    let folded = "";
    const origin = []; // folded position -> position in source
    for (let i = 0; i < source.length; i++) {
      const f = fold(source[i]);
      for (let k = 0; k < f.length; k++) origin.push(i);
      folded += f;
    }
    origin.push(source.length);
    const ranges = [];
    for (const term of words(query)) {
      let from = 0, at;
      while (term && (at = folded.indexOf(term, from)) !== -1) {
        ranges.push([origin[at], origin[at + term.length - 1] + 1]);
        from = at + term.length;
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push(r);
    }
    return merged;
  }

  Object.assign(exports, { searchConversations, highlights, fold, oneEdit });
})(typeof module !== "undefined" ? module.exports : (window.ConversationSearch = {}));
