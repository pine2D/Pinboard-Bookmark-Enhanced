// ============================================================
// Pinboard Bookmark Enhanced - md-preview user-text highlighting.
// Loaded ONLY by md-preview.html (after md-ask.js). This top section
// is PURE (no DOM / chrome.* / fetch) so tests/md-ai-tests.html can
// load the file on file://. Design: docs/superpowers/specs/
// 2026-07-03-md-preview-highlights-design.md section 3 (anchor +
// restore) and section 5 (H2 export). Later plan tasks append:
// storage (pbp_hl_<urlKey>), the floating bar, the edit card, and the
// CSS Highlight registry wiring (spec sections 1, 2, 4, 6).
// ============================================================

// ---- Anchor generation (spec 3): {quote, prefix, suffix} from a
// block's plain text and a [startOff, endOff) selection range.
// prefix/suffix are each clamped to <= 32 chars AND to the block's
// own bounds -- a selection near either edge naturally yields a
// shorter affix, never padding.
function pbpHlSelectorOf(blockText, startOff, endOff) {
  const text = typeof blockText === "string" ? blockText : "";
  const s = Math.max(0, Math.min(startOff, text.length));
  const e = Math.max(s, Math.min(endOff, text.length));
  return {
    quote: text.slice(s, e),
    prefix: text.slice(Math.max(0, s - 32), s),
    suffix: text.slice(e, Math.min(text.length, e + 32)),
  };
}

// Longest common SUFFIX of a and b (scores how well the text
// immediately BEFORE a candidate occurrence matches the recorded
// prefix).
function _pbpHlCommonSuffixLen(a, b) {
  let i = a.length, j = b.length, n = 0;
  while (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { i--; j--; n++; }
  return n;
}

// Longest common PREFIX of a and b (scores how well the text
// immediately AFTER a candidate occurrence matches the recorded
// suffix).
function _pbpHlCommonPrefixLen(a, b) {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// ---- Restore-time relocation (spec 3): find item.quote in the
// CURRENT blockText. Zero occurrences -> null (caller degrades to a
// whole-block highlight). One occurrence -> that one. Multiple ->
// score every occurrence by how much of item.prefix/item.suffix it
// reproduces immediately outside the match, take the highest score;
// a tie keeps the FIRST occurrence (deterministic across reloads,
// no randomness).
function pbpHlLocate(blockText, item) {
  const text = typeof blockText === "string" ? blockText : "";
  const quote = item && typeof item.quote === "string" ? item.quote : "";
  if (!quote) return null;
  const prefix = (item && typeof item.prefix === "string") ? item.prefix : "";
  const suffix = (item && typeof item.suffix === "string") ? item.suffix : "";
  const hits = [];
  let idx = text.indexOf(quote);
  while (idx !== -1) {
    hits.push(idx);
    idx = text.indexOf(quote, idx + 1);
  }
  if (!hits.length) return null;
  if (hits.length === 1) return { start: hits[0], end: hits[0] + quote.length };
  let best = hits[0];
  let bestScore = -1;
  for (const start of hits) {
    const end = start + quote.length;
    const score = _pbpHlCommonSuffixLen(text.slice(0, start), prefix)
      + _pbpHlCommonPrefixLen(text.slice(end), suffix);
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  return { start: best, end: best + quote.length };
}

// ---- H2 export: aggregation section (spec 5). Tag slugs are FIXED
// English strings (a markdown interchange format, like frontmatter)
// -- i18n only touches UI labels, never these.
const PBP_HL_SLUGS = ["#hl-quote", "#hl-definition", "#hl-example", "#hl-doubt", "#hl-todo"];

// Blockquote a possibly-multi-line string: prefix every line with
// "> " (a bare "> " would print a trailing space, so an empty line
// gets just ">" instead -- both are valid CommonMark blockquote
// lines).
function _pbpHlQuoteLines(text) {
  return String(text).split("\n").map((line) => (line ? "> " + line : ">")).join("\n");
}

// items -> "## Highlights" section: one blockquote (+ optional note
// paragraph, via spec 5's blank quoted "> " line trick for a second
// paragraph) and a fixed-slug tag line per item. Empty/missing items
// -> "" (no heading at all) so Task 6's composeExport
// "no highlights -> byte-identical output" regression guard holds
// trivially.
function pbpHlComposeSection(items) {
  const list = Array.isArray(items) ? items.filter((it) => it && typeof it.quote === "string" && it.quote) : [];
  if (!list.length) return "";
  const groups = list.map((it) => {
    let block = _pbpHlQuoteLines(it.quote);
    if (it.note) block += "\n>\n" + _pbpHlQuoteLines(it.note);
    const slug = PBP_HL_SLUGS[(Number(it.color) | 0) - 1] || PBP_HL_SLUGS[0];
    return block + "\n\n" + slug;
  });
  return "## Highlights\n\n" + groups.join("\n\n");
}

// ---- Opportunistic inline marking (spec 5). "Protected" spans are
// fenced code blocks (```...```) and inline code spans (`...`) --
// matches inside either are never wrapped. ponytail: this is a
// substring/regex scan, not a real CommonMark tokenizer (no nested
// fence-length counting, no multi-line inline spans); good enough
// for "is this quote inside SOME code span" -- upgrade to
// md-convert's real parser only if that ceiling is ever hit in
// practice. Trap (Important-1): an UNCLOSED fence at EOF has no
// closing ``` for the first branch to find, so WITHOUT a dedicated
// branch the alternation falls through to the inline-code branch,
// which greedily swallows just the fence opener's first two
// backticks as an empty `` span -- leaving everything after the
// fence opener (to end of document) completely unprotected. Per
// CommonMark, an unclosed fence runs to end of document, so the
// middle branch below closes that gap; it MUST stay ordered AFTER
// the closed-fence branch so a real closer still wins when one
// exists (alternation tries branches left-to-right per start index).
function _pbpHlProtectedRanges(md) {
  const ranges = [];
  const re = /```[\s\S]*?```|```[\s\S]*$|`[^`\n]*`/g;
  let m;
  while ((m = re.exec(md))) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function _pbpHlInProtected(ranges, start, end) {
  return ranges.some(([a, b]) => start < b && end > a);
}

// md, items -> md with each item's quote wrapped in "==...==" IFF it
// matches verbatim exactly ONCE outside any protected span. Zero or
// multiple (ambiguous) matches -> that item is skipped (spec 5: the
// aggregation section is the always-complete record; this is
// best-effort on top, zero data loss either way). Overlapping wraps
// across items are resolved by keeping the earliest and dropping the
// rest -- also treated as "ambiguous".
function pbpHlInlineMark(md, items) {
  const text = typeof md === "string" ? md : "";
  const list = Array.isArray(items) ? items : [];
  if (!text || !list.length) return text;
  const protectedRanges = _pbpHlProtectedRanges(text);
  const wraps = [];
  for (const it of list) {
    if (!it || typeof it.quote !== "string" || !it.quote) continue;
    const quote = it.quote;
    let hit = null;
    let count = 0;
    let idx = text.indexOf(quote);
    while (idx !== -1) {
      const end = idx + quote.length;
      if (!_pbpHlInProtected(protectedRanges, idx, end)) {
        count++;
        hit = { start: idx, end };
      }
      idx = text.indexOf(quote, idx + 1);
    }
    if (count === 1) wraps.push(hit);
  }
  if (!wraps.length) return text;
  wraps.sort((a, b) => a.start - b.start);
  const kept = [];
  let lastEnd = -1;
  for (const w of wraps) {
    if (w.start >= lastEnd) {
      kept.push(w);
      lastEnd = w.end;
    }
  }
  let out = "";
  let pos = 0;
  for (const w of kept) {
    out += text.slice(pos, w.start) + "==" + text.slice(w.start, w.end) + "==";
    pos = w.end;
  }
  out += text.slice(pos);
  return out;
}

// ---- Notebook list model (spec 2.1, pure/testable): document order (n asc,
// ts asc within the same block) -> optional color filter -> excerpt
// truncation. Never touches Ranges/Highlights/DOM -- the DOM layer below
// (_pbpHlNotebookRender) maps this over live blockEl lookups separately.
const PBP_HL_EXCERPT_LEN = 60;

// First line of a possibly-multi-line string, truncated to
// PBP_HL_EXCERPT_LEN chars with a trailing ellipsis (U+2026, \u escape per
// the iron rule -- no literal non-ASCII in code) ONLY when it actually
// exceeds the limit; exactly at the limit stays bare (spec: truncate + ellipsis
// only past the 60-char cutoff, not at it).
function _pbpHlExcerpt(text) {
  const first = String(text).split("\n")[0];
  return first.length > PBP_HL_EXCERPT_LEN
    ? first.slice(0, PBP_HL_EXCERPT_LEN) + "\u2026"
    : first;
}

// items -> notebook rows, document order, optionally filtered by color.
// colorFilter: a Set of enabled colors (1..5), or null/undefined meaning
// "all colors" (spec 2.2 default all-on). noteExcerpt is null (not "")
// when the item's note is empty, so DOM callers can tell "no note line"
// from "an empty-string note line" with one falsy check.
function pbpHlNotebookModel(items, colorFilter) {
  const list = Array.isArray(items) ? items.filter((it) => it && typeof it.quote === "string") : [];
  const filtered = colorFilter
    ? list.filter((it) => colorFilter.has((it.color >= 1 && it.color <= 5) ? it.color : 1))
    : list.slice();
  filtered.sort((a, b) => {
    const dn = (Number(a.n) || 0) - (Number(b.n) || 0);
    return dn !== 0 ? dn : (Number(a.ts) || 0) - (Number(b.ts) || 0);
  });
  return filtered.map((it) => ({
    id: it.id,
    color: (it.color >= 1 && it.color <= 5) ? it.color : 1,
    excerpt: _pbpHlExcerpt(it.quote),
    noteExcerpt: it.note ? _pbpHlExcerpt(it.note) : null,
  }));
}

// ---- Save-answer-as-note text join (H4 spec 2.2, pure/testable): appended
// to an item's note by the DOM-layer pbpHlAttachNote below. A blank note (or
// one that is only whitespace) is replaced outright; a non-empty note gets
// the new answer appended after a blank line, so multiple saved answers read
// as separate paragraphs.
function pbpHlAppendNoteText(existing, answer) {
  const e = typeof existing === "string" ? existing : "";
  const a = typeof answer === "string" ? answer : "";
  return e.trim() ? e + "\n\n" + a : a;
}

// ============================================================
// DOM / UI layer. Lazily mounted: pbpHlInit runs on "pbp:rendered"
// (same pattern as pbpTrInit / pbpAskInit).
// ============================================================

// ---- Storage (storage.local only; highlights are permanent user data,
// never routed through ai-cache.js's LRU/TTL cache) ----
function _pbpHlKey(url) {
  return "pbp_hl_" + pbpAiHash(String(url || ""));
}

// Degrades to [] on any storage failure or when chrome.storage is absent
// (file:// tests) -- spec 6: a storage read failure silently disables
// highlighting for this page instead of crashing.
async function _pbpHlLoad(url) {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return [];
  try {
    const key = _pbpHlKey(url);
    const d = await chrome.storage.local.get(key);
    const rec = d && d[key];
    if (!rec || typeof rec !== "object" || !Array.isArray(rec.items)) return [];
    return rec.items;
  } catch (_) { return []; }
}

// Single-key read-modify-write: caller passes the FULL current items array.
// Deletes the key outright when items is empty (spec 2: deleting down to
// zero items removes the whole key, no empty-shell leftover). On write
// failure, toasts via btn if given, else the #copy-status live region;
// never throws.
async function _pbpHlSave(url, items, btn) {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return false;
  const key = _pbpHlKey(url);
  try {
    if (!items.length) { await chrome.storage.local.remove(key); return true; }
    await chrome.storage.local.set({ [key]: { v: 1, items } });
    return true;
  } catch (_) {
    _pbpHlToast(t("hlSaveFailed"), btn);
    return false;
  }
}

async function _pbpHlLastColorGet() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return 1;
  try {
    const d = await chrome.storage.local.get({ pbp_hl_last_color: 1 });
    const c = Number(d.pbp_hl_last_color);
    return (c >= 1 && c <= 5) ? c : 1;
  } catch (_) { return 1; }
}

async function _pbpHlLastColorSet(color) {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
  try { await chrome.storage.local.set({ pbp_hl_last_color: Number(color) || 1 }); } catch (_) {}
}

// Write-failure toast (spec 6: a save failure must toast, not fail silently
// -- reuse the existing feedback mechanism). When a button is available
// (bar color dot / note button), reuse
// flashButtonLabel (md-preview.js:989) exactly like send/X2 do. The
// keyboard-triggered creation path (H/1-5, no button in view) has no btn to
// flash, so it falls back to the SAME #copy-status aria-live node
// copyToClipboard's announce() already uses (md-preview.js:967) -- not a
// new mechanism, the page's one buttonless toast channel.
function _pbpHlToast(msg, btn) {
  if (btn && typeof flashButtonLabel === "function") { flashButtonLabel(btn, msg); return; }
  const el = document.getElementById("copy-status");
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 1500);
}

// ---- Init + restore ----
const PBP_HL_COLORS = [1, 2, 3, 4, 5];
let _pbpHlState = null; // { url, items, ranges: {id -> {color, range}}, degraded: {id -> true} }

async function pbpHlInit(detail) {
  const view = document.getElementById("rendered-view");
  if (!view || _pbpHlState) return;
  // D10 guard 2 (never unconditionally re-index): only take the first-index
  // path when there is BOTH no index yet AND no .pb-tr sentinel (meaning
  // translation never ran and never indexed either); otherwise, if the
  // index is still empty after that, bail without mounting rather than
  // touching pbpAiIndexBlocks a second time.
  if (!pbpAiBlocks().length) {
    if (!view.querySelector(".pb-tr")) pbpAiIndexBlocks(view);
    if (!pbpAiBlocks().length) return;
  }
  const url = String((detail && detail.url) || "");
  const items = await _pbpHlLoad(url);
  _pbpHlState = { url, items, ranges: Object.create(null), degraded: Object.create(null) };
  pbpHlRestore();
  // Restored-from-storage highlights must surface the rail entry on first
  // paint too -- storage.local.get fires no onChanged, so without this call
  // the rail stays hidden until the session's first mutation (create/delete).
  _pbpHlNotebookRender();
  _pbpHlBindInteractions(view); // Task 4
}

// Build (or rebuild) one item's Range: locate the quote in blockText, map
// the found offsets to a live Range via ask's _pbpAskRangeFromOffsets
// (md-ask.js:697); zero/no match degrades to the whole block (spec 3).
// blockText is passed in by the caller so normal restore (frozen
// pbpAiTextOf cache) and re-anchor (live blockEl.textContent) share this
// one code path with the correct text source for each (spec 3: anchor
// text and mapping text must always come from the same source).
function _pbpHlBuildRange(item, blockEl, blockText) {
  const loc = pbpHlLocate(blockText, item);
  let range = loc ? _pbpAskRangeFromOffsets(blockEl, loc.start, loc.end) : null;
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(blockEl);
    _pbpHlState.degraded[item.id] = true;
  } else {
    delete _pbpHlState.degraded[item.id];
  }
  return range;
}

// M1 hardening (spec sec.3): the locate-text source for a FULL pbpHlRestore
// rebuild pass. A block flagged dataset.pbHlWatched contains pre/math and
// may already have been rewritten by hljs/KaTeX (or may be rewritten
// shortly) -- either way its blockEl.textContent, not the frozen
// pbpAiTextOf(n) snapshot taken before any such rewrite, is the source of
// truth once the flag is set: relocating a quote against the frozen text
// while _pbpAskRangeFromOffsets maps the result onto the LIVE tree can
// mis-anchor or wrongly degrade. Mirrors _pbpHlReanchorBlock's own
// textContent discipline (line 418 in this file) so both rebuild paths
// agree on which text is authoritative for a watched block. Plain
// (non-watched) blocks are byte-for-byte unaffected: they still resolve to
// pbpAiTextOf, exactly as before this change.
function _pbpHlLocateTextFor(blockEl, n) {
  return blockEl.dataset.pbHlWatched ? (blockEl.textContent || "") : pbpAiTextOf(n);
}

// Idempotent full rebuild (spec 3): clears every pbp-hl-* Highlight and
// rebuilds all 5 from _pbpHlState.items. Safe to call more than once (a
// second call just re-clears + re-derives from the same items array).
function pbpHlRestore() {
  if (typeof Highlight !== "function" || typeof CSS === "undefined" || !("highlights" in CSS)) return;
  for (const c of PBP_HL_COLORS) CSS.highlights.delete("pbp-hl-" + c);
  if (!_pbpHlState) return;
  _pbpHlState.ranges = Object.create(null);
  _pbpHlState.degraded = Object.create(null);
  const byColor = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const item of _pbpHlState.items) {
    const blockEl = pbpAiBlockEl(item.n);
    if (!blockEl) continue; // block gone (content drift) -- item silently absent from this render, storage untouched
    const range = _pbpHlBuildRange(item, blockEl, _pbpHlLocateTextFor(blockEl, item.n));
    const col = (item.color >= 1 && item.color <= 5) ? item.color : 1;
    byColor[col].push(range);
    _pbpHlState.ranges[item.id] = { color: col, range };
    _pbpHlArmBlockObserver(blockEl, item.n);
  }
  for (const c of PBP_HL_COLORS) {
    if (byColor[c].length) CSS.highlights.set("pbp-hl-" + c, new Highlight(...byColor[c]));
  }
}

// hljs/KaTeX rewrite pre/math blocks' text nodes on their own rAF-deferred
// pass; a Range built against pre-rewrite text detaches silently (spec 3).
// One-shot per block: arm a MutationObserver, disconnect on its first
// firing, double-rAF then re-anchor ONLY that block's items (spec 3: rebuild
// just that block's Ranges locally, never a full-page rerun). dataset flag
// guards against re-arming an already-watched block on a later
// pbpHlRestore() call.
function _pbpHlNeedsWatch(blockEl) {
  return !!blockEl.querySelector("pre code, .katex, math");
}

function _pbpHlArmBlockObserver(blockEl, n) {
  if (!_pbpHlNeedsWatch(blockEl) || blockEl.dataset.pbHlWatched) return;
  blockEl.dataset.pbHlWatched = "1";
  const obs = new MutationObserver(() => {
    obs.disconnect();
    requestAnimationFrame(() => requestAnimationFrame(() => _pbpHlReanchorBlock(n)));
  });
  obs.observe(blockEl, { childList: true, subtree: true });
}

function _pbpHlReanchorBlock(n) {
  if (!_pbpHlState || typeof Highlight !== "function" || typeof CSS === "undefined" || !("highlights" in CSS)) return;
  const blockEl = pbpAiBlockEl(n);
  if (!blockEl) return;
  const liveText = blockEl.textContent || ""; // NOT pbpAiTextOf(n): that cache may be frozen pre-hljs/KaTeX (spec 3)
  for (const item of _pbpHlState.items) {
    if (item.n !== n) continue;
    const prev = _pbpHlState.ranges[item.id];
    if (prev) {
      const h = CSS.highlights.get("pbp-hl-" + prev.color);
      if (h) h.delete(prev.range);
    }
    const range = _pbpHlBuildRange(item, blockEl, liveText);
    const col = (item.color >= 1 && item.color <= 5) ? item.color : 1;
    let h = CSS.highlights.get("pbp-hl-" + col);
    if (!h) { h = new Highlight(); CSS.highlights.set("pbp-hl-" + col, h); }
    h.add(range);
    _pbpHlState.ranges[item.id] = { color: col, range };
  }
}

// Init hookup: top-level listener registration only (no other side effects;
// the tests page loads this file on file:// and never fires the event) --
// same idiom as md-ask.js:279-283 / md-translate.js:1650-1654.
if (typeof document !== "undefined") {
  document.addEventListener("pbp:rendered", (e) => {
    pbpHlInit((e && e.detail) || {}).catch(() => {});
  }, { once: true });
}

// ---- Range <-> block-text-offset seam (creation side; DOM layer, not the
// pure top section, since it takes live Range/Node arguments). No existing
// "Range -> offsets" helper exists anywhere in the repo (verified: only
// _pbpAskRangeFromOffsets, the opposite direction, exists in md-ask.js) --
// this is the first one, written once here and reused by both the mouseup
// and keyboard creation paths. ----

// A Range boundary's container can be a text node (offset = character
// index) or an element (offset = child index) -- e.g. triple-click / "select
// paragraph" boundaries land on the element. Normalize either shape to a
// concrete {node: TEXT_NODE, offset} pair so the walker below only ever
// compares against text nodes.
function _pbpHlNormalizeBoundary(container, offset) {
  if (container.nodeType === Node.TEXT_NODE) return { node: container, offset };
  const child = container.childNodes[offset];
  if (child) {
    if (child.nodeType === Node.TEXT_NODE) return { node: child, offset: 0 };
    const w = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
    const t = w.nextNode();
    if (t) return { node: t, offset: 0 };
  }
  // offset points past the last child (or nothing text-bearing under it):
  // fall back to the end of container's last text descendant.
  const w2 = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let last = null, n;
  while ((n = w2.nextNode())) last = n;
  return last ? { node: last, offset: last.nodeValue.length } : { node: container, offset: 0 };
}

// Map a live Range (already known to lie within blockEl) to blockEl's raw
// textContent [start, end) offsets -- the exact inverse of ask's
// _pbpAskRangeFromOffsets (md-ask.js:697), same TreeWalker-accumulation
// technique so the two stay symmetric.
function _pbpHlOffsetsFromRange(blockEl, range) {
  const startB = _pbpHlNormalizeBoundary(range.startContainer, range.startOffset);
  const endB = _pbpHlNormalizeBoundary(range.endContainer, range.endOffset);
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let pos = 0, start = null, end = null, node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (start === null && node === startB.node) start = pos + startB.offset;
    if (node === endB.node) end = pos + endB.offset;
    pos += len;
  }
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

// Clip an arbitrary selection Range to blockEl's bounds (native
// Range.compareBoundaryPoints -- no hand-rolled boundary math). Used both to
// test intersection depth and to produce the per-block segment actually
// highlighted; this naturally drops any portion of the selection that falls
// in a non-indexed sibling like .pb-tr (spec 3: a selection spanning
// translated text must anchor only to the original-text block), since
// .pb-tr elements are never part of blockRange to begin with.
function _pbpHlClipRangeToBlock(range, blockEl) {
  const r = range.cloneRange();
  const blockRange = document.createRange();
  blockRange.selectNodeContents(blockEl);
  if (r.compareBoundaryPoints(Range.START_TO_START, blockRange) < 0) {
    r.setStart(blockRange.startContainer, blockRange.startOffset);
  }
  if (r.compareBoundaryPoints(Range.END_TO_END, blockRange) > 0) {
    r.setEnd(blockRange.endContainer, blockRange.endOffset);
  }
  return r;
}

// Split a user selection Range into one clipped segment per intersecting
// indexed (data-pb) block, in document order. Blocks the selection never
// touches, and any portion outside every indexed block (e.g. inside a
// .pb-tr sibling), are simply absent from the result (spec 3).
function _pbpHlSelectionSegments(range) {
  const segments = [];
  for (const b of pbpAiBlocks()) {
    if (!range.intersectsNode(b.el)) continue;
    const seg = _pbpHlClipRangeToBlock(range, b.el);
    if (!seg || seg.collapsed) continue;
    segments.push({ n: b.n, el: b.el, range: seg });
  }
  return segments;
}

function _pbpHlNewId() {
  return "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- Floating creation bar (#pb-hl-bar). Native Popover API (mirrors
// md-ask.js's #explain-pop, md-ask.js:1338-1427/1557-1582): "top-layer +
// Esc + light-dismiss for free" -- no hand-rolled outside-click/Escape
// wiring needed. Positioned above the selection via pbpTrPeekPopPos (spec
// 4), horizontally clamped to the viewport the same way #explain-pop is. ----
let _pbpHlBarEl = null;
let _pbpHlBarRange = null;

function _pbpHlEnsureBar() {
  if (_pbpHlBarEl) return _pbpHlBarEl;
  const bar = document.createElement("div");
  bar.id = "pb-hl-bar";
  bar.setAttribute("popover", "auto");
  const names = [t("hlColorQuote"), t("hlColorDefinition"), t("hlColorExample"), t("hlColorDoubt"), t("hlColorTodo")];
  for (let c = 1; c <= 5; c++) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "pb-hl-dot pb-hl-dot-" + c;
    dot.dataset.color = String(c);
    dot.title = names[c - 1];
    dot.setAttribute("aria-label", names[c - 1]);
    // Keep the live text selection alive through the click (mousedown on
    // any element normally clears window.getSelection()).
    dot.addEventListener("mousedown", (e) => e.preventDefault());
    dot.addEventListener("click", () => _pbpHlCreateFromSelection(c, dot));
    bar.appendChild(dot);
  }
  const noteBtn = document.createElement("button");
  noteBtn.type = "button";
  noteBtn.className = "pb-hl-note-btn";
  noteBtn.title = t("hlNoteBtn");
  noteBtn.setAttribute("aria-label", t("hlNoteBtn"));
  noteBtn.innerHTML = (typeof PBP_ICONS === "object" && PBP_ICONS && PBP_ICONS.pencil) || "";
  noteBtn.addEventListener("mousedown", (e) => e.preventDefault());
  noteBtn.addEventListener("click", () => _pbpHlCreateWithNote(noteBtn));
  bar.appendChild(noteBtn);
  bar.addEventListener("toggle", (e) => { if (e.newState === "closed") _pbpHlBarRange = null; });
  document.body.appendChild(bar);
  _pbpHlBarEl = bar;
  return bar;
}

function _pbpHlShowBar(range) {
  const bar = _pbpHlEnsureBar();
  _pbpHlBarRange = range;
  try { bar.hidePopover(); } catch (_) {} // re-invoke while open: reset first (mirrors _pbpExplainOpenPop)
  bar.showPopover();
  const rect = range.getBoundingClientRect();
  const pos = pbpTrPeekPopPos(rect, bar.offsetHeight, window.innerHeight);
  const bw = bar.offsetWidth;
  const x = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - bw - 8));
  bar.style.left = x + "px";
  bar.style.top = pos.top + "px";
}

function _pbpHlHideBar() {
  if (_pbpHlBarEl) { try { _pbpHlBarEl.hidePopover(); } catch (_) {} }
}

// ---- Creation ----
// Creates one item per block the range intersects (spec 3: cross-block
// selections). Stores quote/prefix/suffix via the pure pbpHlSelectorOf
// (Task 1), but registers the ALREADY-SELECTED Range directly for immediate
// paint -- no locate round-trip needed for the item that was just created
// from a live selection (spec 4: register the new Range immediately,
// without a full pbpHlRestore rerun).
async function _pbpHlCreateFromRange(range, color, btn) {
  if (!_pbpHlState) return [];
  const segments = _pbpHlSelectionSegments(range);
  const created = [];
  for (const seg of segments) {
    const offsets = _pbpHlOffsetsFromRange(seg.el, seg.range);
    if (!offsets) continue;
    // NOT pbpAiTextOf(seg.n): that cache may be frozen pre-hljs/KaTeX and can
    // diverge from the live DOM _pbpHlOffsetsFromRange just walked (same
    // same-source rule _pbpHlReanchorBlock already follows with
    // blockEl.textContent -- see its comment above).
    const blockText = seg.el.textContent || "";
    const sel = pbpHlSelectorOf(blockText, offsets.start, offsets.end);
    const item = {
      id: _pbpHlNewId(),
      n: seg.n,
      quote: sel.quote,
      prefix: sel.prefix,
      suffix: sel.suffix,
      color,
      note: "",
      ts: Date.now()
    };
    _pbpHlState.items.push(item);
    created.push(item);
    _pbpHlRegisterRange(item, seg.range.cloneRange());
    _pbpHlArmBlockObserver(seg.el, seg.n);
  }
  if (created.length) {
    await _pbpHlSave(_pbpHlState.url, _pbpHlState.items, btn);
    await _pbpHlLastColorSet(color);
    _pbpHlNotebookRender();
    // Spec 1.3 trigger 4: the FIRST highlight created this session
    // auto-expands the rail's hl section (session-visual only, via
    // expand(temp) -- never persisted, never overwrites the user's
    // stored collapse preference). A restore from storage (pbpHlInit)
    // does NOT set this flag, only an actual creation does.
    if (!_pbpHlAutoExpandedThisSession) {
      _pbpHlAutoExpandedThisSession = true;
      if (_pbpHlNbEls && _pbpHlNbEls.handle) _pbpHlNbEls.handle.expand(true);
    }
  }
  return created;
}

function _pbpHlRegisterRange(item, range) {
  if (typeof Highlight !== "function" || typeof CSS === "undefined" || !("highlights" in CSS)) return;
  let h = CSS.highlights.get("pbp-hl-" + item.color);
  if (!h) { h = new Highlight(); CSS.highlights.set("pbp-hl-" + item.color, h); }
  h.add(range);
  _pbpHlState.ranges[item.id] = { color: item.color, range };
}

async function _pbpHlCreateFromSelection(color, btn) {
  const range = _pbpHlBarRange;
  _pbpHlHideBar();
  if (!range) return;
  await _pbpHlCreateFromRange(range, color, btn);
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
}

async function _pbpHlCreateWithNote(btn) {
  const range = _pbpHlBarRange;
  _pbpHlHideBar();
  if (!range) return;
  const color = await _pbpHlLastColorGet();
  const created = await _pbpHlCreateFromRange(range, color, btn);
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  if (created.length && typeof window._pbpHlOpenCard === "function") {
    window._pbpHlOpenCard(created[created.length - 1].id); // Task 5's card (window hook; no-op until Task 5 lands)
  }
}

// ---- Interaction binder: mouseup (show bar) + keydown (H/1-5 hotkeys) +
// scroll/selection-collapse hide. Esc + click-elsewhere dismiss are free
// via the popover's own light-dismiss (no listener needed for those). ----
function _pbpHlOnMouseUp(e) {
  const view = document.getElementById("rendered-view");
  if (!view || !view.contains(e.target)) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { _pbpHlHideBar(); return; }
  const range = sel.getRangeAt(0);
  const segments = _pbpHlSelectionSegments(range);
  if (!segments.length) { _pbpHlHideBar(); return; }
  _pbpHlShowBar(range);
}

// Same 4-condition gate pattern as the existing V/a/e hotkeys (md-ask.js:56-69,
// md-translate.js keydown): explicit e.shiftKey exclusion (not just case-
// sensitive e.key checks) so Caps Lock without Shift ("H", shiftKey=false)
// still fires while Shift+h ("H", shiftKey=true) does not.
function _pbpHlOnKeyDown(e) {
  if (e.key !== "h" && e.key !== "H" && !/^[1-5]$/.test(e.key)) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const ae = document.activeElement;
  if (pbpTrIsTypingContext(ae && ae.tagName, !!(ae && ae.isContentEditable))) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const view = document.getElementById("rendered-view");
  if (!view || !view.contains(range.commonAncestorContainer)) return;
  const segments = _pbpHlSelectionSegments(range);
  if (!segments.length) return;
  e.preventDefault();
  const color = /^[1-5]$/.test(e.key) ? Number(e.key) : null;
  (async () => {
    const c = color || await _pbpHlLastColorGet();
    await _pbpHlCreateFromRange(range, c, null);
    sel.removeAllRanges();
    _pbpHlHideBar();
  })();
}

function _pbpHlBindInteractions(view) {
  view.addEventListener("mouseup", _pbpHlOnMouseUp);
  document.addEventListener("keydown", _pbpHlOnKeyDown);
  window.addEventListener("scroll", () => _pbpHlHideBar(), true);
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if ((!sel || sel.isCollapsed) && _pbpHlBarEl && _pbpHlBarEl.matches(":popover-open")) _pbpHlHideBar();
  });
}

// ---- Cross-file accessor (md-preview.js reads this into buildExportOpts() -- Task 6). ----
// Returns a COPY so a caller can't mutate the live store by reference.
function pbpHlCurrentItems() {
  return _pbpHlState ? _pbpHlState.items.slice() : [];
}

// ---- Click hit-detection -> edit card (spec sec.4 "点已有高亮 → 卡片") ----
document.addEventListener("pbp:rendered", () => {
  const view = document.getElementById("rendered-view");
  if (!view) return;
  view.addEventListener("click", _pbpHlOnClick);
}, { once: true });

function _pbpHlOnClick(e) {
  // A just-finished drag selection reaching here means mouseup already handed off to
  // the floating bar (Task 4) -- don't also open the edit card underneath it.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  if (typeof document.caretRangeFromPoint !== "function") return;
  if (!_pbpHlState) return;
  const caret = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (!caret) return;
  const node = caret.startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const blockEl = el && el.closest("[data-pb]");
  if (!blockEl) return;

  // Map the caret hit back to an item via the _pbpHlState.ranges[id] registry
  // (Range identity/boundary lookup) -- never via expandos stamped on Range
  // objects (Task 3 keeps no such expandos).
  let best = null; // {id, ts}
  for (const id in _pbpHlState.ranges) {
    const entry = _pbpHlState.ranges[id];
    const r = entry && entry.range;
    if (!r || !blockEl.contains(r.commonAncestorContainer)) continue;
    let hit;
    try { hit = r.isPointInRange(caret.startContainer, caret.startOffset); } catch (_) { hit = false; }
    if (!hit) continue;
    const item = _pbpHlState.items.find((it) => it.id === id);
    const ts = item ? Number(item.ts) || 0 : 0;
    if (!best || ts > best.ts) best = { id, ts };
  }
  if (!best) return;
  _pbpHlOpenCard(best.id);
}

// ---- Save-answer-as-note bridge (H4 spec 2.2): explain/translate answers
// land on a highlight's note through this single entry point. target =
// { itemId } (card entry point, used by Task 3) or { range } (live-selection
// entry point, a frozen cloneRange() snapshot from md-ask.js's
// pbpExplainInvoke). The range path hit-tests the SAME isPointInRange
// primitive _pbpHlOnClick uses just above against every registered Range in
// _pbpHlState.ranges, tie -> newest item.ts. A miss creates a new highlight
// through the one creation path (_pbpHlCreateFromRange, last-used color) and
// the note lands on the LAST item that call created (mirrors
// _pbpHlCreateWithNote's own "open the last created item" choice). Persists
// via _pbpHlSave + _pbpHlNotebookRender only (spec invariant 2). Returns
// false (after a hlSaveFailed toast) when creation fails so the caller's
// button can re-enable itself; _pbpHlSave toasts its own failures.
async function pbpHlAttachNote(target, answerText) {
  if (!_pbpHlState) return false;
  const answer = typeof answerText === "string" ? answerText : "";
  let item = null;

  if (target && target.itemId) {
    item = _pbpHlState.items.find((it) => it.id === target.itemId) || null;
    if (!item) return false;
  } else if (target && target.range) {
    const range = target.range;
    let best = null; // { ts, item }
    for (const id in _pbpHlState.ranges) {
      const entry = _pbpHlState.ranges[id];
      const r = entry && entry.range;
      if (!r) continue;
      let hit;
      try { hit = r.isPointInRange(range.startContainer, range.startOffset); } catch (_) { hit = false; }
      if (!hit) continue;
      const it = _pbpHlState.items.find((x) => x.id === id);
      const ts = it ? Number(it.ts) || 0 : 0;
      if (!best || ts > best.ts) best = { ts, item: it };
    }
    if (best && best.item) {
      item = best.item;
    } else {
      const color = await _pbpHlLastColorGet();
      // ponytail: _pbpHlCreateFromRange already does its own _pbpHlSave +
      // _pbpHlNotebookRender internally before returning, with the new item's
      // note still "". The append below then triggers a SECOND save + render
      // with the real note. That is one extra storage.local write and a
      // one-frame Notebook flash for this miss-branch only -- harmless, not
      // worth a bespoke non-persisting creation path (would violate the
      // single-creation-path invariant).
      const created = await _pbpHlCreateFromRange(range, color, null);
      if (!created.length) {
        _pbpHlToast(t("hlSaveFailed"));
        return false;
      }
      item = created[created.length - 1];
    }
  } else {
    return false;
  }

  item.note = pbpHlAppendNoteText(item.note, answer);
  const ok = await _pbpHlSave(_pbpHlState.url, _pbpHlState.items, null);
  if (!ok) return false;
  _pbpHlNotebookRender();
  if (_pbpHlCard && _pbpHlCardItemId === item.id) {
    const noteEl = _pbpHlCard.querySelector(".hl-card-note");
    if (noteEl) noteEl.value = item.note;
  }
  return true;
}
window.pbpHlAttachNote = pbpHlAttachNote; // explicit window attach: makes the md-ask.js "Save as note" contract self-documenting.

// ---- Edit card (spec sec.4). Native popover="auto": Esc + light-dismiss for free,
// same mechanism as md-ask.js's #explain-pop (md-ask.js:1341-1424). ----
const PBP_HL_COLOR_KEYS = ["hlColorQuote", "hlColorDefinition", "hlColorExample", "hlColorDoubt", "hlColorTodo"]; // index 0..4 = color 1..5, fixed order (spec sec.5 slugs)
let _pbpHlCard = null;
let _pbpHlCardItemId = null;

function _pbpHlEnsureCard() {
  if (_pbpHlCard) return _pbpHlCard;
  const card = document.createElement("div");
  card.id = "pb-hl-card";
  card.setAttribute("popover", "auto");

  const quote = document.createElement("blockquote");
  quote.className = "hl-card-quote";
  card.appendChild(quote);

  const degraded = document.createElement("div");
  degraded.className = "hl-card-degraded";
  degraded.hidden = true;
  card.appendChild(degraded);

  const dots = document.createElement("div");
  dots.className = "hl-card-colors";
  dots.setAttribute("role", "group");
  for (let color = 1; color <= 5; color++) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "hl-card-dot hl-card-dot-" + color;
    dot.dataset.color = String(color);
    dot.addEventListener("click", () => _pbpHlSwitchColor(color));
    dots.appendChild(dot);
  }
  card.appendChild(dots);

  const note = document.createElement("textarea");
  note.className = "hl-card-note";
  note.rows = 3;
  note.addEventListener("blur", _pbpHlCommitNote);
  card.appendChild(note);

  const foot = document.createElement("div");
  foot.className = "hl-card-foot";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "hl-card-save";
  save.addEventListener("click", _pbpHlCommitNote);
  foot.appendChild(save);
  const del = document.createElement("button");
  del.type = "button";
  del.className = "hl-card-delete";
  del.addEventListener("click", _pbpHlDeleteCurrent);
  foot.appendChild(del);
  card.appendChild(foot);

  card.addEventListener("toggle", (e) => {
    if (e.newState === "closed") _pbpHlCardItemId = null;
  });
  document.body.appendChild(card);
  _pbpHlCard = card;
  return card;
}

// Re-applies i18n text to the card's static labels. Called on every open (cheap; the
// card is a singleton so this can't be a first-paint cost).
function _pbpHlApplyCardI18n(card) {
  card.querySelectorAll(".hl-card-dot").forEach((dot) => {
    const label = t(PBP_HL_COLOR_KEYS[Number(dot.dataset.color) - 1]);
    dot.title = label;
    dot.setAttribute("aria-label", label);
  });
  card.querySelector(".hl-card-note").placeholder = t("hlNotePlaceholder");
  card.querySelector(".hl-card-save").textContent = t("hlSave");
  card.querySelector(".hl-card-delete").textContent = t("hlDelete");
}

// Single entry point for both the click-hit-detection path (Step 2) and Task 4's
// note-button ("用上次色创建 + 直接打开卡片聚焦 textarea" -- spec sec.4). Re-derives
// position/rect from the item's id every time, so it never depends on the caller
// already having a live Range in hand.
function _pbpHlOpenCard(id) {
  if (!_pbpHlState) return;
  const item = _pbpHlState.items.find((it) => it.id === id);
  if (!item) return;
  const blockEl = pbpAiBlockEl(item.n);
  if (!blockEl) return;

  const degraded = !!_pbpHlState.degraded[item.id];
  let rect = blockEl.getBoundingClientRect();
  if (!degraded) {
    const entry = _pbpHlState.ranges[id];
    if (entry && entry.range) rect = entry.range.getBoundingClientRect();
  }

  const card = _pbpHlEnsureCard();
  _pbpHlApplyCardI18n(card);
  _pbpHlCardItemId = id;
  card.querySelector(".hl-card-quote").textContent = item.quote || ""; // textContent only (spec sec.6)
  card.querySelectorAll(".hl-card-dot").forEach((dot) => {
    const active = Number(dot.dataset.color) === Number(item.color);
    dot.classList.toggle("active", active);
    dot.setAttribute("aria-pressed", String(active));
  });
  const degradedEl = card.querySelector(".hl-card-degraded");
  degradedEl.hidden = !degraded;
  degradedEl.textContent = degraded ? t("hlDegraded") : "";
  const noteEl = card.querySelector(".hl-card-note");
  noteEl.value = item.note || ""; // textContent-equivalent for a form control's value

  if (!card.matches(":popover-open")) card.showPopover();
  // Position AFTER showPopover so offsetHeight is real (measure-then-place
  // two-step, same as the ask subsystem's #explain-pop pattern).
  card.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - card.offsetWidth - 8)) + "px";
  const pos = pbpTrPeekPopPos(rect, card.offsetHeight, window.innerHeight);
  card.style.top = pos.top + "px";
  noteEl.focus();
  noteEl.setSelectionRange(noteEl.value.length, noteEl.value.length); // caret at end, no accidental select-all
}

window._pbpHlOpenCard = _pbpHlOpenCard; // explicit window attach: makes the "Task 4 calls it directly" contract self-documenting.

// Color switch: mutate + persist + full rebuild (pbpHlRestore is idempotent -- spec
// sec.3 -- so re-running it is the simplest correct way to move this item's Range from
// its old pbp-hl-N Highlight to the new one; no manual .delete()/.add() bookkeeping).
function _pbpHlSwitchColor(color) {
  if (!_pbpHlState) return;
  const item = _pbpHlState.items.find((it) => it.id === _pbpHlCardItemId);
  if (!item) return;
  if (item.color === color) return;
  item.color = color;
  _pbpHlSave(_pbpHlState.url, _pbpHlState.items, _pbpHlCard.querySelector(".hl-card-dot-" + color)).then(() => {
    if (typeof pbpHlRestore === "function") pbpHlRestore();
    _pbpHlNotebookRender(); // list dot color + color-filter membership can both change
    // Guard: only reopen/reposition the card onto this item if it's still the one displayed --
    // the user may have closed this card and opened a different highlight's card while the
    // save was in flight (same bug class as the run-start-pill guards in 57642a2).
    if (_pbpHlCardItemId === item.id) _pbpHlOpenCard(item.id); // re-render the card's active dot + re-measure position
  });
}

let _pbpHlNoteDirty = false;
document.addEventListener("input", (e) => {
  if (e.target && e.target.classList && e.target.classList.contains("hl-card-note")) _pbpHlNoteDirty = true;
});

// Blur AND explicit Save button both route here (spec: "note textarea(失焦或保存钮落存储)").
function _pbpHlCommitNote() {
  if (!_pbpHlNoteDirty || !_pbpHlCardItemId || !_pbpHlState) return;
  const item = _pbpHlState.items.find((it) => it.id === _pbpHlCardItemId);
  if (!item || !_pbpHlCard) return;
  item.note = _pbpHlCard.querySelector(".hl-card-note").value;
  _pbpHlNoteDirty = false;
  // no pbpHlRestore -- notes never touch the Range/Highlight, but the
  // list's note-excerpt line does need to reflect the edit.
  _pbpHlSave(_pbpHlState.url, _pbpHlState.items, _pbpHlCard.querySelector(".hl-card-save")).then(() => _pbpHlNotebookRender());
}

// Shared delete core (spec 2.1: the list's x button and the card's delete
// button MUST be the same code path). State cleanup (splice + persist +
// re-derive Ranges + re-render the notebook) runs unconditionally; only
// the UI action of hiding the CARD is guarded, because the user may have
// opened a DIFFERENT highlight's card while this delete's save was in
// flight, and that card must stay open (same bug class as the
// run-start-pill guards in 57642a2).
function _pbpHlDeleteItem(id, btn) {
  if (!_pbpHlState) return;
  const idx = _pbpHlState.items.findIndex((it) => it.id === id);
  if (idx === -1) return;
  _pbpHlState.items.splice(idx, 1);
  return _pbpHlSave(_pbpHlState.url, _pbpHlState.items, btn).then(() => {
    if (typeof pbpHlRestore === "function") pbpHlRestore();
    _pbpHlNotebookRender();
    if (_pbpHlCard && _pbpHlCardItemId === id) _pbpHlCard.hidePopover();
  });
}

function _pbpHlDeleteCurrent() {
  if (!_pbpHlState || !_pbpHlCardItemId) return;
  _pbpHlDeleteItem(_pbpHlCardItemId, _pbpHlCard.querySelector(".hl-card-delete"));
}

// ---- Notebook list: collapsible "Highlights (N)" section (spec 2). N is
// ALWAYS the total item count, never the color-filtered count (spec 2.2:
// the badge must not read as "how many are showing"). Rebuilds on every
// mutation path (create/switch-color/commit-note/delete, all above) plus
// chrome.storage.onChanged below (cross-window fallback). Renamed from the
// old count-only _pbpHlUpdateRailCount; verified (grep, see plan) that its
// only 3 call sites are init/delete/onChanged, all in this file -- renamed
// directly below rather than keeping a now-pointless alias.
let _pbpHlColorFilter = new Set(PBP_HL_COLORS); // session-only, default all-on (spec 2.2 -- never persisted)
let _pbpHlNbEls = null; // {sec, list, filterBtns, emptyHint, copyBtn, handle} -- built once
let _pbpHlAutoExpandedThisSession = false; // spec 1.3 trigger 4 guard

function _pbpHlNotebookRender() {
  const rail = document.getElementById("rail");
  if (!rail) return;
  if (!_pbpHlNbEls) _pbpHlNbEls = _pbpHlBuildNotebookDom(rail);
  const items = _pbpHlState ? _pbpHlState.items : [];
  _pbpHlNbEls.sec.hidden = items.length === 0; // 0 total -> whole section hidden (unchanged from before)
  // Header count badge is TOTAL and always live. pbpRailCollapsible (Task 1)
  // reads opts.count ONCE at build to seed the .rail-sec-count span; keeping
  // it in sync on every mutation is this render's job (spec 2.3: render =
  // count + list), mirroring md-translate.js writing #tr-section
  // .rail-sec-progress by selector rather than relying on the engine to re-poll.
  const countEl = _pbpHlNbEls.sec.querySelector(".rail-sec-count");
  if (countEl) countEl.textContent = "(" + items.length + ")";
  _pbpHlNbEls.filterBtns.forEach((b) => {
    const on = _pbpHlColorFilter.has(Number(b.dataset.color));
    b.setAttribute("aria-pressed", String(on));
    b.classList.toggle("off", !on);
  });
  const model = pbpHlNotebookModel(items, _pbpHlColorFilter);
  _pbpHlNbEls.list.replaceChildren(...model.map(_pbpHlBuildItemEl));
  _pbpHlNbEls.emptyHint.hidden = !(items.length > 0 && model.length === 0);
}

// One-time DOM build: filter row + list + empty-filter hint + copy footer,
// then installs the collapsible header via pbpRailCollapsible (Task 1,
// md-preview.js). Same insertion point as before (immediately before #toc, or
// appended to #rail if #toc is absent).
function _pbpHlBuildNotebookDom(rail) {
  const sec = document.createElement("div");
  sec.className = "rail-section";
  sec.id = "hl-rail-section";
  sec.hidden = true;

  const filterRow = document.createElement("div");
  filterRow.className = "hl-filter-row";
  filterRow.setAttribute("role", "group");
  filterRow.setAttribute("aria-label", t("hlFilterGroupAria"));
  const filterBtns = PBP_HL_COLORS.map((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hl-filter-dot hl-filter-dot-" + c;
    b.dataset.color = String(c);
    const label = t(PBP_HL_COLOR_KEYS[c - 1]);
    b.title = label;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-pressed", "true");
    b.addEventListener("click", () => {
      if (_pbpHlColorFilter.has(c)) _pbpHlColorFilter.delete(c); else _pbpHlColorFilter.add(c);
      _pbpHlNotebookRender();
    });
    filterRow.appendChild(b);
    return b;
  });
  sec.appendChild(filterRow);

  const list = document.createElement("ul");
  list.className = "hl-list";
  list.id = "hl-list";
  sec.appendChild(list);

  const emptyHint = document.createElement("p");
  emptyHint.className = "hl-filter-empty";
  emptyHint.textContent = t("hlFilterEmpty");
  emptyHint.hidden = true;
  sec.appendChild(emptyHint);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.id = "hl-rail-copy";
  copyBtn.className = "action-btn hl-rail-btn";
  const lab = document.createElement("span");
  lab.className = "btn-label";
  lab.textContent = t("hlCopyMd");
  copyBtn.appendChild(lab);
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pbpHlComposeSection(_pbpHlState ? _pbpHlState.items : []));
      flashButtonLabel(copyBtn, t("hlCopied"));
    } catch (_) {
      flashButtonLabel(copyBtn, t("mdPreviewFailed"));
    }
  });
  sec.appendChild(copyBtn);

  const toc = document.getElementById("toc");
  if (toc) toc.insertAdjacentElement("beforebegin", sec);
  else rail.appendChild(sec);

  const handle = (typeof pbpRailCollapsible === "function")
    ? pbpRailCollapsible(sec, "hl", {
        label: t("hlSectionTitle"),
        count: () => "(" + (_pbpHlState ? _pbpHlState.items.length : 0) + ")",
        defaultCollapsed: false,
      })
    : null; // degrade: no collapsible header (file:// test harness has no #rail at all, never reaches here)

  return { sec, list, filterBtns, emptyHint, copyBtn, handle };
}

// One <li> per notebook entry (spec 2.1). textContent/title only for all
// user text -- zero innerHTML for user data, same rule as the edit card.
function _pbpHlBuildItemEl(m) {
  const full = _pbpHlState.items.find((it) => it.id === m.id);
  const blockEl = full ? pbpAiBlockEl(full.n) : null;
  // tr-only escape hatch mirrors md-translate.js's own visibility rule
  // (body.tr-only + [data-pb-tr-done] hides the original unless .pb-show-orig
  // is toggled on -- md-preview.css:1045). Dim, don't disable: spec 2.3
  // wants a silent no-op at click time (checked again in _pbpHlNotebookJump),
  // not a permanently-disabled control, since this view state can change
  // within the same page load.
  const dimmed = !!blockEl && document.body.classList.contains("tr-only")
    && blockEl.hasAttribute("data-pb-tr-done") && !blockEl.classList.contains("pb-show-orig");

  const li = document.createElement("li");
  li.className = "hl-item" + (dimmed ? " hl-item-dim" : "");

  const main = document.createElement("button");
  main.type = "button";
  main.className = "hl-item-main";
  const dot = document.createElement("span");
  dot.className = "hl-item-dot hl-item-dot-" + m.color;
  dot.setAttribute("aria-hidden", "true");
  main.appendChild(dot);
  const q = document.createElement("span");
  q.className = "hl-item-quote";
  q.textContent = m.excerpt;
  main.appendChild(q);
  main.title = full ? full.quote : m.excerpt;
  if (!blockEl) {
    main.disabled = true; // block gone (content drift): permanent for this render, native disabled is correct here
  } else {
    main.addEventListener("click", () => _pbpHlNotebookJump(full));
  }
  li.appendChild(main);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "hl-item-del";
  const delLabel = t("hlDelete"); // reuse the existing card-delete label, per spec 2.1
  del.title = delLabel;
  del.setAttribute("aria-label", delLabel);
  del.innerHTML = (typeof PBP_ICONS === "object" && PBP_ICONS && PBP_ICONS.cross) || "";
  del.addEventListener("click", () => _pbpHlDeleteItem(m.id, del));
  li.appendChild(del);

  if (m.noteExcerpt) {
    const note = document.createElement("div");
    note.className = "hl-item-note";
    note.textContent = m.noteExcerpt;
    li.appendChild(note);
  }
  return li;
}

// Item click: scroll + flash the source block, reusing ask's citation-jump
// flash verbatim (md-ask.js:730 _pbpAskFlash) -- no independent/third flash
// mechanism (spec 2.1). Re-checks tr-only visibility at click time (not just
// at last render) so a stale dim-class never causes an incorrect jump.
function _pbpHlNotebookJump(item) {
  const blockEl = pbpAiBlockEl(item.n);
  if (!blockEl) return;
  if (document.body.classList.contains("tr-only") && blockEl.hasAttribute("data-pb-tr-done") && !blockEl.classList.contains("pb-show-orig")) return; // spec 2.3: silent no-op
  blockEl.scrollIntoView({ block: "center", behavior: "smooth" });
  const entry = _pbpHlState.ranges[item.id];
  const range = (entry && entry.range) || (() => { const r = document.createRange(); r.selectNode(blockEl); return r; })();
  _pbpAskFlash(range, blockEl);
}

// Reactive trigger: fires on ANY write to this page's pbp_hl_<urlKey> key, regardless of
// which code path performed it. _pbpHlState.items is always current by the time any write
// lands (every mutator updates it in place BEFORE persisting), so this never reloads from
// the change record (storage doesn't carry the transient `degraded` flag).
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !_pbpHlState) return;
    if (!(_pbpHlKey(_pbpHlState.url) in changes)) return;
    _pbpHlNotebookRender();
  });
}
