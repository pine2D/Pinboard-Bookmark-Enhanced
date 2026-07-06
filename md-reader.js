// ============================================================
// Pinboard Bookmark Enhanced - md-preview reading-UX small features:
// footnote popover (R3), in-doc search (R4), and the "?" keyboard-
// shortcuts help popover (spec sec.5). Loaded ONLY by md-preview.html,
// AFTER md-ask.js and md-highlight.js (md-preview.html script tags) --
// the DOM wiring section below calls _pbpAskFlash (md-ask.js) and
// pbpTrPeekPopPos (md-translate.js) directly, every such call typeof-
// guarded so load-order or a partial-load failure in either file
// degrades this file silently rather than throwing (md-highlight.js
// already calls _pbpAskFlash unguarded since it loads strictly after
// md-ask.js -- this file is deliberately more defensive per the batch
// plan). Design: docs/superpowers/specs/
// 2026-07-06-reading-experience-batch-design.md section 3 (R3
// footnotes), section 4 (R4 search), section 5 (keyboard help). These
// three small, independent reading-UX features share this ONE file
// (spec sec.8: these three reading-UX small pieces live together in one
// file, same family) rather than three files, mirroring the
// by-subsystem-not-by-feature file split
// md-ask.js/md-translate.js/md-highlight.js already use. This task
// creates the file with the footnote feature (pbpFnHrefParse +
// _pbpFnInit); later tasks append the search and keyboard-help
// features against the two section markers and the bootstrap block
// below -- do not rename or move them.
// ============================================================

// ---- pure section (no DOM/chrome/fetch; loadable standalone for file://
// tests) ----

// R3 (spec sec.3): parse a footnote-family href into {kind, id} or null.
// Defuddle normalizes every source site's footnote markup into two id-
// bearing shapes -- REF: <sup id="fnref:N"><a href="#fn:N">N</a></sup>,
// DEF backref: <a href="#fnref:N" class="footnote-backref"> (a footnote
// cited more than once appends "-2"/"-3"... to the backref id) -- but
// BOTH the sup's and the li's own id attributes are lost in this app's
// Turndown-then-marked round-trip (spec sec.0 R3: Turndown's default
// <sup>/<li> handling drops non-content attributes; DOMPurify's own
// id-strip hook in md-convert.js would strip them again even if
// Turndown kept them). Only the href VALUES survive (they're plain
// markdown link syntax) -- so this parser is the entire cross-reference
// mechanism: kind "ref" is a body citation link (#fn:N), kind "backref"
// is the return link inside a definition <li> (#fnref:N, occurrence
// suffix stripped since the REF side never carries it -- that
// per-occurrence id is exactly what's lost, so DEF->REF can only ever
// resolve to the base id (spec sec.3: jump to the first occurrence in
// the body, a documented, accepted limitation).
// Anything not matching either shape (including non-string input)
// returns null so a caller can leave native anchor behavior alone.
function pbpFnHrefParse(href) {
  const s = typeof href === "string" ? href : "";
  const backref = /^#fnref:(.+)$/.exec(s);
  if (backref) return { kind: "backref", id: backref[1].replace(/-\d+$/, "") };
  const ref = /^#fn:(.+)$/.exec(s);
  if (ref) return { kind: "ref", id: ref[1] };
  return null;
}

// ---- R4: in-document search match enumeration (pure, no DOM) ----
// Case-insensitive, non-overlapping consecutive occurrences of `query`
// inside `text`, capped at `cap` results. Offsets are into `text` as-is
// (toLowerCase() is length-preserving for the overwhelming common case;
// exotic Unicode casefolding that changes length is a known, accepted
// limitation -- same category of simplification the codebase already
// accepts elsewhere, e.g. pbpAiFuzzyFind's ASCII-oriented matching).
function pbpSearchEnumerate(text, query, cap) {
  const out = [];
  if (typeof text !== "string" || typeof query !== "string" || !query.length) return out;
  const limit = (typeof cap === "number" && cap > 0) ? cap : 0;
  if (limit <= 0) return out;
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  while (out.length < limit) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    out.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length;
  }
  return out;
}

// ---- R9 (spec 2): scroll-restore anchor picker ----
// Pure math only -- the caller (md-preview.js) does the live DOM measuring
// (getBoundingClientRect per block, view-aware via trOnlyScrollTarget) and
// hands the resulting {top, bottom} list in here. rects are VIEWPORT-
// relative (0 = current top of the viewport), the same convention
// getBoundingClientRect() itself uses -- exactly what md-preview.js's own
// pbpScrollMapBlocks "topmost visible block" scan already assumes for its
// `bottom > 0` test, copied here. Returns { n, frac } (n is 1-based,
// matching data-pb / data-pb-tr) or null when there is nothing to anchor to.
function pbpReaderPickScrollAnchor(rects) {
  if (!Array.isArray(rects) || !rects.length) return null;
  let idx = rects.findIndex((r) => r && r.bottom > 0);
  if (idx === -1) idx = rects.length - 1;
  const r = rects[idx];
  if (!r) return null;
  const h = r.bottom - r.top;
  const frac = h > 0 ? Math.min(Math.max(-r.top / h, 0), 1) : 0;
  return { n: idx + 1, frac };
}

// ---- DOM wiring ----

// View-mode-aware visibility check for R3 (spec sec.3, reusing R4's exact
// two-selector judgment, spec sec.0 R4): NEVER use offsetParent (it is
// also true for genuinely-visible-but-off-screen content under
// #rendered-view's content-visibility:auto rule, md-preview.css) -- only
// the two known hidden-state selectors count. A .pb-tr sibling is
// display:none unless the view is bilingual/tr-only; an original block
// carrying data-pb-tr-done is display:none in tr-only mode unless its
// per-block .pb-show-orig peek is active (md-translate.js
// _pbpTrPeekToggle).
function _pbpFnIsHidden(el) {
  const trHost = el.closest(".pb-tr");
  if (trHost) {
    const body = document.body;
    return !body.classList.contains("tr-bilingual") && !body.classList.contains("tr-only");
  }
  if (document.body.classList.contains("tr-only")) {
    const orig = el.closest("[data-pb-tr-done]");
    if (orig && !orig.classList.contains("pb-show-orig")) return true;
  }
  return false;
}

// Minimal escaping for embedding an href-derived id inside a quoted
// attribute-selector string (only '"' and '\' can break out of the
// quotes). CSS.escape() is the wrong tool here: it escapes for an
// IDENTIFIER context (colons, leading digits, ...), not a quoted-string
// context, and would corrupt an otherwise-exact id.
function _pbpFnEscAttr(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

// Ref -> def (spec sec.3): exact href cross-query, never a prefix match
// (N=1 would wrongly match N=10). Bilingual view can have TWO candidate
// <li>s (the original footnotes list plus its .pb-tr translated
// sibling, spec sec.0 R3) -- prefer the first VISIBLE one; if none are
// visible, fall back to the first one found rather than silently doing
// nothing.
function _pbpFnFindDef(id) {
  const sel = 'a[href="#fnref:' + _pbpFnEscAttr(id) + '"]';
  let cands;
  try { cands = document.querySelectorAll(sel); } catch (_) { return null; }
  let first = null;
  for (const a of cands) {
    const li = a.closest("li");
    if (!li) continue;
    if (!first) first = li;
    if (!_pbpFnIsHidden(li)) return li;
  }
  return first;
}

// Backref -> body ref (spec sec.3): same exact-href / prefer-visible
// pattern, symmetric with _pbpFnFindDef.
function _pbpFnFindRef(id) {
  const sel = 'a[href="#fn:' + _pbpFnEscAttr(id) + '"]';
  let cands;
  try { cands = document.querySelectorAll(sel); } catch (_) { return null; }
  let first = null;
  for (const a of cands) {
    if (!first) first = a;
    if (!_pbpFnIsHidden(a)) return a;
  }
  return first;
}

let _pbpFnPop = null;
let _pbpFnCurrentLi = null;

// Re-applied on every open (cheap; the popover is a page-lifetime
// singleton) -- same belt-and-suspenders idiom as _pbpHlApplyCardI18n
// (md-highlight.js).
function _pbpFnApplyPopI18n(pop) {
  pop.setAttribute("aria-label", t("fnPopLabel"));
  const label = pop.querySelector(".fn-pop-jump-label");
  if (label) label.textContent = t("fnPopJump");
}

// Lazily builds the singleton #fn-pop popover (spec sec.3): a scrollable
// clone of the resolved definition <li> plus a "jump to footnote"
// button. Native popover="auto" -- Esc + light-dismiss for free, same as
// #pb-hl-card/#explain-pop.
function _pbpFnEnsurePop() {
  if (_pbpFnPop) return _pbpFnPop;
  const pop = document.createElement("div");
  pop.id = "fn-pop";
  pop.setAttribute("popover", "auto");

  const body = document.createElement("div");
  body.className = "fn-pop-body";
  pop.appendChild(body);

  const foot = document.createElement("div");
  foot.className = "fn-pop-foot";
  const jumpBtn = document.createElement("button");
  jumpBtn.type = "button";
  jumpBtn.className = "fn-pop-jump";
  jumpBtn.innerHTML = (typeof PBP_ICONS === "object" && PBP_ICONS && PBP_ICONS.arrowDown) || "";
  const jumpLabel = document.createElement("span");
  jumpLabel.className = "fn-pop-jump-label";
  jumpBtn.appendChild(jumpLabel);
  jumpBtn.addEventListener("click", () => {
    if (!_pbpFnCurrentLi) return;
    try { pop.hidePopover(); } catch (_) {}
    _pbpFnCurrentLi.scrollIntoView({ block: "center", behavior: "smooth" });
    const range = document.createRange();
    range.selectNode(_pbpFnCurrentLi);
    if (typeof _pbpAskFlash === "function") _pbpAskFlash(range, _pbpFnCurrentLi);
  });
  foot.appendChild(jumpBtn);
  pop.appendChild(foot);

  document.body.appendChild(pop);
  _pbpFnPop = pop;
  return pop;
}

// Opens (or repositions, if already open) the singleton popover for a
// resolved definition <li>, anchored to the clicked ref/backref
// element's current rect. anchorEl is only used for positioning;
// content always comes from li, never from anchorEl (spec sec.3).
function _pbpFnOpenPop(li, anchorEl) {
  const pop = _pbpFnEnsurePop();
  _pbpFnApplyPopI18n(pop);
  const body = pop.querySelector(".fn-pop-body");
  const clone = li.cloneNode(true);
  // Strip backref ("return to citation") links from the clone -- they
  // carry no id/class after the Turndown round-trip (spec sec.0 R3), so
  // href-shape is the only way to find them, same as the click parser
  // above.
  clone.querySelectorAll('a[href^="#fnref:"]').forEach((a) => a.remove());
  body.replaceChildren(clone);
  _pbpFnCurrentLi = li;

  // Mutual exclusion: any other open popover must close first (same
  // explicit-hide convention _pbpHlOpenCard/_pbpExplainOpenPop already
  // use).
  document.querySelectorAll(":popover-open").forEach((el) => {
    if (el !== pop) { try { el.hidePopover(); } catch (_) {} }
  });

  const rect = anchorEl.getBoundingClientRect();
  if (!pop.matches(":popover-open")) pop.showPopover();
  // Measure-then-place two-step, same as _pbpHlOpenCard.
  pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  const pos = (typeof pbpTrPeekPopPos === "function")
    ? pbpTrPeekPopPos(rect, pop.offsetHeight, window.innerHeight)
    : { top: rect.bottom + 8 };
  pop.style.top = pos.top + "px";
}

function _pbpFnOnRefClick(a, id) {
  const li = _pbpFnFindDef(id);
  if (!li) return; // no definition found -- silent no-op, same as today's dead link (spec sec.3)
  _pbpFnOpenPop(li, a);
}

function _pbpFnOnBackrefClick(id) {
  const a = _pbpFnFindRef(id);
  if (!a) return; // silent no-op, symmetric with the ref direction
  a.scrollIntoView({ block: "center", behavior: "smooth" });
  const range = document.createRange();
  range.selectNode(a);
  if (typeof _pbpAskFlash === "function") _pbpAskFlash(range, a);
}

// Delegated #rendered-view click handler (spec sec.3): intercepts
// footnote ref/backref anchors by href SHAPE, not by id (Defuddle's ids
// never survive the Turndown round-trip) -- pbpFnHrefParse is the
// single source of truth for what counts as a footnote link. A native
// <a> is already focusable and Enter already fires a "click" event, so
// this one listener covers keyboard activation for free.
function _pbpFnOnClick(e) {
  const a = e.target.closest("a[href]");
  if (!a) return;
  const parsed = pbpFnHrefParse(a.getAttribute("href") || "");
  if (!parsed) return; // not a footnote link -- leave native behavior alone
  e.preventDefault();
  if (parsed.kind === "ref") _pbpFnOnRefClick(a, parsed.id);
  else _pbpFnOnBackrefClick(parsed.id);
}

// Idempotent: binds the delegated listener once per #rendered-view
// element (a dataset flag guards a second call, mirroring pbpHlInit's
// own _pbpHlState-presence guard).
function _pbpFnInit() {
  const view = document.getElementById("rendered-view");
  if (!view || view.dataset.pbpFnBound) return;
  view.dataset.pbpFnBound = "1";
  view.addEventListener("click", _pbpFnOnClick);
}

// ---- R4: in-document search ("/" hotkey, #search-pop) ----
// Bare "/" opens a floating top-center search bar scoped to the RENDERED
// view only (raw view keeps native Ctrl+F, spec sec.4). Candidates are
// #rendered-view's direct children, filtered by the two known view-mode
// hidden-selectors (never offsetParent -- content-visibility:auto makes
// off-screen-but-visible content report offsetParent===null too, see
// recon R4 risk 3). Matches paint via two CSS Custom Highlight names with
// EXPLICIT .priority (search=1, current=2) so overlap with user
// highlights (pbp-hl-*, default priority 0) and the jump flash
// (pbp-flash, priority 3 as of this task's one-line md-ask.js touch) is a
// defined contract, not the previous implicit Map-insertion-order
// tie-break. Per the CSS Custom Highlight spec only ONE background wins
// per overlapping text run (no compositing) -- the priority order above
// is the best achievable "both stay discernible" outcome: the
// NON-overlapping portion of each highlight keeps its own color, only
// the exact overlap switches to the higher-priority tint.
const PBP_SEARCH_PREV_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/></svg>';
const PBP_SEARCH_NEXT_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';

let _pbpSearchInited = false;
let _pbpSearchPopEl = null;
let _pbpSearchState = { query: "", matches: [], ranges: [], idx: -1 };
let _pbpSearchInputTimer = null;
let _pbpSearchMo = null;
let _pbpSearchMoTimer = null;

// Candidate containers: #rendered-view's DIRECT children only (matches
// spec sec.4 -- cross-top-level-block matches are out of scope), filtered
// by the two known view-mode hidden-selectors (md-preview.css): a .pb-tr
// sibling is hidden unless a translation view is active; an original
// block carrying data-pb-tr-done is hidden in tr-only mode unless peeked
// open via .pb-show-orig.
function _pbpSearchVisibleCandidates(view) {
  const bilingual = document.body.classList.contains("tr-bilingual");
  const trOnly = document.body.classList.contains("tr-only");
  const out = [];
  for (const el of view.children) {
    if (el.classList.contains("pb-tr")) {
      if (!bilingual && !trOnly) continue;
    } else if (trOnly && el.hasAttribute("data-pb-tr-done") && !el.classList.contains("pb-show-orig")) {
      continue;
    }
    out.push(el);
  }
  return out;
}

// Gate matches md-ask.js's _pbpAskFlash precedent verbatim (typeof Highlight
// === "function" && typeof CSS !== "undefined" && "highlights" in CSS) --
// kept identical across every CSS Custom Highlight call site in this
// feature family so the call sites can't drift apart.
function _pbpSearchPaintAll() {
  if (typeof Highlight !== "function" || typeof CSS === "undefined" || !("highlights" in CSS)) return;
  const valid = _pbpSearchState.ranges.filter((r) => !!r);
  if (!valid.length) { CSS.highlights.delete("pbp-search"); return; }
  const h = new Highlight(...valid);
  h.priority = 1; // spec sec.4: explicit contract, below current (2) and flash (3)
  CSS.highlights.set("pbp-search", h);
}

function _pbpSearchPaintCurrent(jump) {
  const st = _pbpSearchState;
  if (typeof Highlight === "function" && typeof CSS !== "undefined" && "highlights" in CSS) {
    const r = st.idx >= 0 ? st.ranges[st.idx] : null;
    if (r) {
      const h = new Highlight(r);
      h.priority = 2;
      CSS.highlights.set("pbp-search-current", h);
    } else {
      CSS.highlights.delete("pbp-search-current");
    }
  }
  if (jump && st.idx >= 0) {
    const m = st.matches[st.idx];
    if (m && m.el && typeof m.el.scrollIntoView === "function") {
      m.el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

function _pbpSearchUpdateCounter() {
  const pop = _pbpSearchPopEl;
  if (!pop) return;
  const counter = pop.querySelector("#search-count");
  if (!counter) return;
  const st = _pbpSearchState;
  const total = st.matches.length >= 500 ? "500+" : String(st.matches.length);
  const cur = st.matches.length ? String(st.idx + 1) : "0";
  counter.textContent = cur + " / " + total;
  // Pairs with the aria-busy set in _pbpSearchOnInput / _pbpSearchArmObserver
  // -- this is the ONLY place that clears it, so every debounced rescan
  // settles into exactly one AT announcement of the FINAL count.
  counter.removeAttribute("aria-busy");
}

// Re-run the whole scan against the CURRENT DOM. Called on input
// (debounced in _pbpSearchOnInput) and on rescan triggers (view-mode
// toggle / target-language change, observed via _pbpSearchArmObserver).
function _pbpSearchRun(query) {
  const st = _pbpSearchState;
  st.query = query;
  st.matches = [];
  st.ranges = [];
  const CAP = 500;
  const view = document.getElementById("rendered-view");
  if (query && view) {
    const cands = _pbpSearchVisibleCandidates(view);
    scan:
    for (const el of cands) {
      const hits = pbpSearchEnumerate(el.textContent, query, CAP - st.matches.length);
      for (const h of hits) {
        st.matches.push({ el: el, start: h.start, end: h.end });
        if (st.matches.length >= CAP) break scan;
      }
    }
    for (const m of st.matches) {
      st.ranges.push(typeof _pbpAskRangeFromOffsets === "function" ? _pbpAskRangeFromOffsets(m.el, m.start, m.end) : null);
    }
  }
  st.idx = st.matches.length ? 0 : -1;
  _pbpSearchPaintAll();
  _pbpSearchPaintCurrent(true);
  _pbpSearchUpdateCounter();
}

function _pbpSearchStep(dir) {
  const st = _pbpSearchState;
  if (!st.matches.length) return;
  st.idx = (st.idx + dir + st.matches.length) % st.matches.length;
  _pbpSearchPaintCurrent(true);
  _pbpSearchUpdateCounter();
}

function _pbpSearchOnInput(e) {
  clearTimeout(_pbpSearchInputTimer);
  const val = e.target.value;
  // aria-busy set here, cleared in _pbpSearchUpdateCounter once the
  // debounced _pbpSearchRun below settles.
  if (_pbpSearchPopEl) {
    const counter = _pbpSearchPopEl.querySelector("#search-count");
    if (counter) counter.setAttribute("aria-busy", "true");
  }
  _pbpSearchInputTimer = setTimeout(() => _pbpSearchRun(val), 150);
}

// Rescan trigger (spec sec.4: "view change / lang change"): a single
// MutationObserver on #rendered-view (attributes+childList+subtree+
// characterData) covers BOTH without touching md-translate.js. Debounced
// 300ms past the last mutation; no-ops while the popover is closed.
function _pbpSearchArmObserver() {
  _pbpSearchDisarmObserver();
  const view = document.getElementById("rendered-view");
  if (!view) return;
  _pbpSearchMo = new MutationObserver(() => {
    // Condition checked BEFORE scheduling so aria-busy below is only ever
    // set when a rescan is actually going to run.
    if (!(_pbpSearchPopEl && _pbpSearchPopEl.matches(":popover-open") && _pbpSearchState.query)) return;
    clearTimeout(_pbpSearchMoTimer);
    const counter = _pbpSearchPopEl.querySelector("#search-count");
    if (counter) counter.setAttribute("aria-busy", "true");
    _pbpSearchMoTimer = setTimeout(() => {
      _pbpSearchRun(_pbpSearchState.query);
    }, 300);
  });
  _pbpSearchMo.observe(view, { childList: true, subtree: true, attributes: true, characterData: true });
}

function _pbpSearchDisarmObserver() {
  clearTimeout(_pbpSearchMoTimer);
  if (_pbpSearchMo) { _pbpSearchMo.disconnect(); _pbpSearchMo = null; }
}

// Full state teardown: both highlight names cleared, observer stopped,
// in-memory match list reset. Runs on EVERY dismissal path (Esc,
// click-outside, explicit hidePopover) via the popover's own "toggle"
// event registered once in _pbpSearchEnsurePop.
function _pbpSearchTeardown() {
  if (typeof Highlight === "function" && typeof CSS !== "undefined" && "highlights" in CSS) {
    CSS.highlights.delete("pbp-search");
    CSS.highlights.delete("pbp-search-current");
  }
  _pbpSearchDisarmObserver();
  _pbpSearchState = { query: "", matches: [], ranges: [], idx: -1 };
}

function _pbpSearchEnsurePop() {
  if (_pbpSearchPopEl) return _pbpSearchPopEl;
  const pop = document.createElement("div");
  pop.id = "search-pop";
  pop.setAttribute("popover", "auto"); // top-layer + Esc + light-dismiss for free

  const input = document.createElement("input");
  input.type = "text";
  input.id = "search-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = t("srchPlaceholder");
  input.setAttribute("aria-label", t("srchInputAria"));
  input.addEventListener("input", _pbpSearchOnInput);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // Flush a pending 150ms debounce: comparing the live input value
    // against the last-RUN query catches "Enter pressed before
    // _pbpSearchRun fired yet" without introspecting the timer.
    if (input.value !== _pbpSearchState.query) {
      clearTimeout(_pbpSearchInputTimer);
      _pbpSearchRun(input.value);
      return; // _pbpSearchRun already lands on match 1; don't also step past it
    }
    _pbpSearchStep(e.shiftKey ? -1 : 1);
  });
  pop.appendChild(input);

  // aria-live=polite counter, paired with aria-busy around each debounced
  // rescan (same pairing md-ask.js uses for its streaming .ask-a).
  const count = document.createElement("span");
  count.id = "search-count";
  count.className = "srch-count";
  count.setAttribute("aria-live", "polite");
  count.textContent = "0 / 0";
  pop.appendChild(count);

  const prev = document.createElement("button");
  prev.type = "button";
  prev.id = "search-prev";
  prev.className = "srch-nav";
  prev.innerHTML = PBP_SEARCH_PREV_SVG;
  prev.setAttribute("aria-label", t("srchPrevAria"));
  prev.title = t("srchPrevAria");
  prev.addEventListener("click", () => _pbpSearchStep(-1));
  pop.appendChild(prev);

  const next = document.createElement("button");
  next.type = "button";
  next.id = "search-next";
  next.className = "srch-nav";
  next.innerHTML = PBP_SEARCH_NEXT_SVG;
  next.setAttribute("aria-label", t("srchNextAria"));
  next.title = t("srchNextAria");
  next.addEventListener("click", () => _pbpSearchStep(1));
  pop.appendChild(next);

  pop.addEventListener("toggle", (e) => {
    if (e.newState === "closed") _pbpSearchTeardown();
  });
  document.body.appendChild(pop);
  _pbpSearchPopEl = pop;
  return pop;
}

// Mutual exclusion with the other popover families (spec sec.6.1) --
// "#fn-pop" is Task 3's footnote popover; a plain getElementById is used
// since it degrades to a safe no-op (null) whether or not that feature
// happened to mount.
function _pbpSearchOpen() {
  const pop = _pbpSearchEnsurePop();
  ["explain-pop", "pb-hl-card", "pb-hl-bar", "fn-pop"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.matches && el.matches(":popover-open")) { try { el.hidePopover(); } catch (_) {} }
  });
  _pbpSearchTeardown();
  const input = pop.querySelector("#search-input");
  input.value = "";
  _pbpSearchUpdateCounter();
  if (!pop.matches(":popover-open")) pop.showPopover();
  input.focus();
  _pbpSearchArmObserver();
}

// Same 4-condition gate as the existing e/V/H/1-5 hotkeys
// (pbpTrIsTypingContext, md-translate.js), plus one search-specific 5th
// gate: raw view is a plain <pre>, not a rendered document -- "/" is a
// no-op there so native Ctrl+F keeps working on raw text untouched.
function _pbpSearchOnKeyDown(e) {
  if (e.key !== "/") return;
  // Don't gate on shiftKey: on some layouts (German QWERTZ, French AZERTY)
  // "/" requires Shift, and on US layouts Shift+/ yields "?" so e.key
  // already disambiguates -- same reasoning as the "?" help hotkey.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const ae = document.activeElement;
  if (pbpTrIsTypingContext(ae && ae.tagName, !!(ae && ae.isContentEditable))) return;
  if (document.body.classList.contains("raw-active")) return;
  e.preventDefault();
  _pbpSearchOpen();
}

function _pbpSearchInit() {
  if (_pbpSearchInited) return;
  _pbpSearchInited = true;
  document.addEventListener("keydown", _pbpSearchOnKeyDown);
}

// ---- bootstrap: ONE shared "pbp:rendered" listener for every
// md-reader.js feature (spec sec.8: R3 footnotes / R4 search / "?"
// keyboard help all live in this one file). Later tasks extend this
// SAME block by adding one more try-wrapped init call each -- never
// register a second "pbp:rendered" listener here. Each call is
// independently try/catched so one feature's init failure can never
// block a sibling feature's init. Same once-listener idiom as
// md-highlight.js / md-ask.js / md-translate.js; the test harness loads
// this file on file:// and never dispatches "pbp:rendered", so this
// registration is inert there. ----
if (typeof document !== "undefined") {
  document.addEventListener("pbp:rendered", () => {
    try { _pbpFnInit(); } catch (_) {}
    try { _pbpSearchInit(); } catch (_) {}
  }, { once: true });
}
