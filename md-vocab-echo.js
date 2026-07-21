// ============================================================
// Pinboard Bookmark Enhanced - md-vocab-echo.js
// Vocab echo: dotted-underline saved vocabulary words in the reader via the
// CSS Custom Highlight API (zero DOM mutation), click opens the dictionary
// view. Pointer enhancement only -- the keyboard-reachable path stays
// "select text -> explain popover"; the underline is not presented as a
// full accessible control. Opt-in via dictEchoEnabled (default off).
// Pure helpers above PURE END load in tests/md-dict-tests.html via file://.
// ============================================================

const PBP_ECHO_TERM_LIMIT = 500; // matching keys cap (newest updatedAt first)
const PBP_ECHO_PER_TERM = 20;    // drawn ranges per term
const PBP_ECHO_TOTAL = 500;      // drawn ranges total

// Adjacent letter/number/combining-mark/underscore rejects a word-boundary
// match. \p{M} matters: a combining accent glued to the match edge means the
// visible word continues.
const PBP_ECHO_WORD_ADJ = /[\p{L}\p{N}\p{M}_]/u;
// Scripts written without spaces get plain substring matching instead.
const PBP_ECHO_SUBSTR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function pbpEchoNeedsBoundary(term) {
  return !PBP_ECHO_SUBSTR.test(String(term || ""));
}

// rows (already updatedAt-desc from pbpVocabAll) -> ordered match list.
// Term only -- echoing the lemma would show "unsaved" in the dict view and
// invite duplicate records (spec §1). Longest-first so overlap resolution
// in pbpEchoFindInText is "first claim wins".
function pbpEchoTermSet(rows, cap) {
  const limit = cap || PBP_ECHO_TERM_LIMIT;
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.term !== "string") continue;
    const display = r.term.normalize("NFC").trim();
    if (!display) continue;
    const bound = pbpEchoNeedsBoundary(display);
    // Only single LATIN letters are noise ("a", "I"); single chars of other
    // scripts (书 / 단 / я) are legitimate words -- boundary matching keeps
    // their precision (spec §2).
    if (/^\p{Script=Latin}$/u.test(display)) continue;
    let key = display.toLowerCase();
    // Case folding that changes length (Turkish İ) breaks index mapping --
    // degrade that term to exact-case matching instead of guessing offsets.
    if (key.length !== display.length) key = display;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, display, bound });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => b.key.length - a.key.length);
  return out;
}

// Code-point-safe index of the code point PRECEDING UTF-16 index i.
function _pbpEchoPrevCpIndex(text, i) {
  const c = text.charCodeAt(i - 1);
  return (c >= 0xdc00 && c <= 0xdfff && i >= 2) ? i - 2 : i - 1;
}

function pbpEchoBoundaryOk(text, start, end) {
  if (start > 0) {
    const cp = text.codePointAt(_pbpEchoPrevCpIndex(text, start));
    if (cp !== undefined && PBP_ECHO_WORD_ADJ.test(String.fromCodePoint(cp))) return false;
  }
  if (end < text.length) {
    const cp = text.codePointAt(end);
    if (cp !== undefined && PBP_ECHO_WORD_ADJ.test(String.fromCodePoint(cp))) return false;
  }
  return true;
}

// One text-node's data -> matches. Case-insensitive via a lowercased copy;
// when folding shifts indices (İ in the node) degrade to exact-case so the
// reported offsets always index the ORIGINAL string. Overlaps: terms arrive
// longest-first, first claim wins. perTermCaps (Map key->remaining budget)
// lives INSIDE the matcher: a term past its budget must not ghost-claim a
// region and block shorter terms from it (Codex plan-review MEDIUM 4).
function pbpEchoFindInText(text, terms, maxHits, perTermCaps) {
  const src = String(text || "");
  const folded = src.toLowerCase();
  const caseOk = folded.length === src.length;
  const hay = caseOk ? folded : src;
  const cap = maxHits == null ? Infinity : maxHits;
  const out = [];
  const taken = [];
  for (const t of terms) {
    if (out.length >= cap) break;
    const termCap = perTermCaps && perTermCaps.has(t.key) ? perTermCaps.get(t.key) : Infinity;
    if (termCap <= 0) continue;
    const needle = caseOk ? t.key : t.display;
    let termHits = 0;
    let from = 0;
    while (out.length < cap && termHits < termCap) {
      const i = hay.indexOf(needle, from);
      if (i === -1) break;
      const e = i + needle.length;
      from = i + 1;
      if (t.bound && !pbpEchoBoundaryOk(src, i, e)) continue;
      if (taken.some(([s, x]) => i < x && e > s)) continue;
      taken.push([i, e]);
      out.push({ start: i, end: e, key: t.key });
      termHits++;
      from = e;
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// ---- PURE END ----
