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
  }, { once: true });
}
