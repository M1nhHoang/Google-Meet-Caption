/* Read captions from the DOM and merge them into speaker turns.
   Meet rewrites a caption line while it is being spoken, so lines must be merged
   rather than appended on every sighting. */

/* var, not const: content scripts share one global scope, like sibling <script>
   tags. A second `const MC` would throw "Identifier MC has already been declared"
   and block every file listed after it. */
var MC = (window.__MC ||= {});

const norm = (s) =>
  s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

/* Merge two versions of the same sentence. Taken verbatim from idea.js v7. */
function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  const na = norm(a), nb = norm(b);
  if (nb.startsWith(na)) return b;   // the sentence is still growing
  if (na.includes(nb)) return a;     // Meet trimmed the start -> keep the full version
  for (let n = Math.min(a.length, b.length); n > 12; n--) {
    if (norm(a.slice(-n)) === norm(b.slice(0, n))) return a + b.slice(n);
  }
  return a.length >= b.length ? a : b;
}

/* After a page reload a few older caption lines are still on screen and will be read
   again. Check whether a line we just saw is an already-stored turn, so we overwrite it
   instead of adding a duplicate. */
function findExisting(turns, speaker, text) {
  const nt = norm(text);
  if (nt.length < 8) return null;
  const tail = turns.slice(-6);
  for (let i = tail.length - 1; i >= 0; i--) {
    const t = tail[i];
    if (t.speaker !== speaker) continue;
    const nx = norm(t.text);
    if (nx === nt || nx.startsWith(nt) || nt.startsWith(nx)) return t;
  }
  return null;
}

MC.captions = {
  merge,
  norm,

  /**
   * Scan the caption region once.
   * @returns {{added:number, region:boolean}}
   */
  sync(S) {
    const region = MC.sel.captionRegion();
    if (!region) return { added: 0, region: false };

    let added = 0;
    for (const { el, img, span, textEl } of MC.sel.captionItems(region)) {
      const speaker = (span.innerText || "").trim() || "Không rõ";
      const text = (textEl.innerText || "").replace(/\s+/g, " ").trim();
      if (!text) continue;

      let turn = S.seen.get(el);

      if (!turn) {
        turn = findExisting(S.turns, speaker, text);
        if (turn) S.seen.set(el, turn);
      }

      if (turn) {
        const merged = merge(turn.text, text);
        if (merged !== turn.text || turn.speaker !== speaker) {
          turn.text = merged;
          turn.speaker = speaker;
          S.dirty.add(turn.seq);
        }
        continue;
      }

      const ts = Date.now();
      turn = {
        seq: S.nextSeq++,
        speaker,
        text,
        ts,
        at: MC.contentAt(ts),
      };
      S.turns.push(turn);
      S.seen.set(el, turn);
      S.dirty.add(turn.seq);
      added++;
    }

    return { added, region: true };
  },
};
