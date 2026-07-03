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
    const range = _pbpHlBuildRange(item, blockEl, pbpAiTextOf(item.n));
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
