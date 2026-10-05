// Library page glue: view switching, hash routing, cross-page freshness.
// Hash precedence: explicit #vocab/#notes in the URL > last-view memory
// (localStorage) > default #vocab. The memory key is page-local UI state,
// never synced.
const PBP_LIB_VIEW_KEY = "pbp-lib-last-view";
const PBP_LIB_VIEWS = ["vocab", "notes"];

function pbpLibActiveView() {
  return $id("view-notes").hidden ? "vocab" : "notes";
}

function _pbpLibApplyView(view, pushHash) {
  const v = PBP_LIB_VIEWS.includes(view) ? view : "vocab";
  for (const name of PBP_LIB_VIEWS) {
    const active = name === v;
    $id("view-" + name).hidden = !active;
    const tab = $id("lib-tab-" + name);
    tab.setAttribute("aria-selected", String(active));
    tab.classList.toggle("active", active);
    tab.tabIndex = active ? 0 : -1;
  }
  // Narrow mode (<860px) shows the vocabulary list OR its detail pane, never
  // both. Arriving at the view is a request for the list. Only genuine
  // switches route through here -- the visibilitychange re-fire dispatches
  // pbp-lib-view directly -- so alt-tabbing back does not close an open
  // detail out from under a narrow reader.
  // (The notes view runs the same contract on its own body class -- the two
  // views never share one flag, so neither can strand the other's pane.)
  if (v === "vocab") document.body.classList.remove("lib-narrow-detail");
  if (v === "notes") document.body.classList.remove("lib-narrow-notes");
  try { localStorage.setItem(PBP_LIB_VIEW_KEY, v); } catch (_) {}
  if (pushHash) history.replaceState(null, "", "#" + v);
  document.dispatchEvent(new CustomEvent("pbp-lib-view", { detail: { view: v } }));
}

function _pbpLibInitialView() {
  const fromHash = (location.hash || "").replace(/^#/, "");
  if (PBP_LIB_VIEWS.includes(fromHash)) return fromHash;
  try {
    const remembered = localStorage.getItem(PBP_LIB_VIEW_KEY);
    if (PBP_LIB_VIEWS.includes(remembered)) return remembered;
  } catch (_) {}
  return "vocab";
}

// Enable decorative transitions (.confirm-popover enter/exit) only after the
// initial paint — same double-rAF gate as options.js/popup.js/md-preview.js,
// so this adds zero first-frame cost on the cold-start path.
// Only on the library page itself: tests/library-*-tests.html and
// tests/i18n-parity-tests.html load this file for its helpers, and a
// motion-ready <html> there would arm the 220ms card-exit hold that their
// task-count timing does not wait for.
if (typeof requestAnimationFrame === "function" && document.getElementById("lib-tab-vocab")) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.documentElement.classList.add("motion-ready");
  }));
}

// Scrollbar gutter width, measured (library redesign §2.4). The list regions
// bleed into the column gap by exactly their own scrollbar, so a row's fill
// ends where the index column ends. library.css styles the scrollbar at 10px,
// but a platform or zoom change can move it while the page is open, so it is
// re-measured on resize and whenever <html> is re-themed (data-theme /
// data-density -- another tab's theme switch rewrites both live).
function pbpLibMeasureScrollbar() {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden";
  document.body.appendChild(probe);
  const w = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  document.documentElement.style.setProperty("--lib-sb-w", w + "px");
  return w;
}

document.addEventListener("DOMContentLoaded", () => {
  if (!$id("lib-tab-vocab")) return;
  // Hydrate declarative icon slots (same contract as options.js/popup.js):
  // static PBP_ICONS constants only, never page content.
  document.querySelectorAll(".btn-ic[data-ic]").forEach(s => { s.innerHTML = PBP_ICONS[s.dataset.ic] || ""; });
  pbpLibMeasureScrollbar();
  window.addEventListener("resize", pbpLibMeasureScrollbar);
  new MutationObserver(pbpLibMeasureScrollbar).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-density"] });
  // Same contract as every other page (popup.js / options.js / md-preview.js):
  // i18n.js does not self-apply data-i18n attributes, so each page must call
  // both explicitly before relying on translated markup.
  initI18n();
  applyI18n();
  document.title = t("libraryTitle");
  // library-vocab.js writes the sort trigger's face words at its own parse
  // time -- before initI18n has loaded a manually chosen locale. Re-run it
  // here, where t() is final: it rewrites each option's data-face-label, the
  // accessible-name span and the trigger's title, then redraws listbox.js's
  // ghost trigger. (applyI18n's pbp:i18n-applied already reached its listener
  // in library-vocab.js; this explicit call keeps the ordering independent of
  // that listener.)
  if (typeof _pbpVocabSyncSortFace === "function") _pbpVocabSyncSortFace();
  // Roving tabindex (active tab 0, others -1, set by _pbpLibApplyView) needs
  // its arrow-key half too -- same pattern as options.js's activateTab
  // keydown handler, ArrowLeft/ArrowRight (this tab strip is horizontal, not
  // options' vertical sidebar) with wrap-around.
  PBP_LIB_VIEWS.forEach((name, i) => {
    const tab = $id("lib-tab-" + name);
    tab.addEventListener("click", () => _pbpLibApplyView(name, true));
    tab.addEventListener("keydown", (e) => {
      let n = -1;
      if (e.key === "ArrowRight") n = (i + 1) % PBP_LIB_VIEWS.length;
      else if (e.key === "ArrowLeft") n = (i - 1 + PBP_LIB_VIEWS.length) % PBP_LIB_VIEWS.length;
      else return;
      e.preventDefault();
      const target = PBP_LIB_VIEWS[n];
      _pbpLibApplyView(target, true);
      $id("lib-tab-" + target).focus();
    });
  });
  window.addEventListener("hashchange", () => {
    const v = (location.hash || "").replace(/^#/, "");
    if (PBP_LIB_VIEWS.includes(v) && v !== pbpLibActiveView()) _pbpLibApplyView(v, false);
  });
  // Words saved from the reader while this tab was hidden must show up on
  // return; view modules listen and re-read IndexedDB / storage.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      document.dispatchEvent(new CustomEvent("pbp-lib-view", { detail: { view: pbpLibActiveView() } }));
    }
  });
  pbpLibWireFilterPopover($id("vocab-filter-set"), $id("vocab-filter-narrow"), $id("vocab-list-pane"));
  pbpLibWireVocabHeaderFit($id("vocab-list-pane"));
  pbpLibWireNotesHeaderFit(document.querySelector(".notes-list-pane"));
  _pbpLibApplyView(_pbpLibInitialView(), true);
});

// ---- Shared render helpers (library redesign T4, spec §3.5 / §5.3) ----------
// library-vocab.js and library-notes.js call these at RENDER time only: this
// file loads after both, so a parse-time call from either would find nothing.

// Numbers inside localized sentences. t() gets one private-use sentinel per
// value (U+E000 + slot); the result is split on them and every value comes
// back as its own part. The translator keeps the word order -- nothing is
// concatenated, nothing goes through innerHTML -- and a locale that moves the
// number to the front or the end still gets it bolded.
const PBP_LIB_SENTINEL_BASE = 0xE000;
function pbpLibSplitCount(format, values) {
  const list = Array.isArray(values) ? values : [];
  const marks = list.map((_, i) => String.fromCharCode(PBP_LIB_SENTINEL_BASE + i));
  let text = "";
  try {
    text = String(format(...marks));
  } catch (err) {
    console.warn("[library] count format failed", err && err.name, err && err.message);
  }
  const parts = [];
  let literal = "";
  for (const ch of text) {
    const slot = ch.charCodeAt(0) - PBP_LIB_SENTINEL_BASE;
    if (ch.length === 1 && slot >= 0 && slot < list.length) {
      if (literal) { parts.push({ text: literal, index: -1 }); literal = ""; }
      parts.push({ text: String(list[slot]), index: slot });
    } else {
      literal += ch;
    }
  }
  if (literal) parts.push({ text: literal, index: -1 });
  return parts;
}

// Counted nouns (T8g). chrome.i18n has no plural rules, so a counted noun ships
// as two keys -- <key> and its singular twin <key>One -- and the caller picks
// one by the real number BEFORE formatting: pbpLibSplitCount hands t()
// sentinels, never the value. A sentence with several counts takes each one as
// a phrase key ("12 highlights") instead of one sentence per combination; the
// sentinel passes through the nested t() untouched. Only en / de / fr word the
// twins differently (the other locales repeat the same text). French also puts
// zero in the singular ("0 surlignage"; CLDR fr: one = 0 and 1), en and de do
// not. Call sites spell both keys out: the dead-key guard in
// tests/ui-contract-tests.mjs looks for each key's literal.
function pbpLibCountKey(n, oneKey, otherKey) {
  const value = Number(n);
  const lang = String(_pbpLibLocale() || "").toLowerCase().split("-")[0];
  return value === 1 || (value === 0 && lang === "fr") ? oneKey : otherKey;
}

function pbpLibFillCount(host, parts, tagFor) {
  if (!host) return;
  const nodes = (Array.isArray(parts) ? parts : []).map((part) => {
    const tag = part.index >= 0 && typeof tagFor === "function" ? tagFor(part.index) : null;
    if (tag !== "b" && tag !== "span") return document.createTextNode(part.text);
    const el = document.createElement(tag);
    if (tag === "span") el.className = "lib-count-num";
    el.textContent = part.text;
    return el;
  });
  host.replaceChildren(...nodes);
}

// The count row's left segment (spec §3.5): compact items for the eye
// (aria-hidden), the full sentence -- account name included -- for the screen
// reader and the hover title. Only the FIRST item's first number is bold.
// The sentence node is rewritten only when it changes: #vocab-count /
// #notes-count are aria-live, and a rebuilt live region re-announces itself.
function pbpLibRenderCount(host, items, full) {
  if (!host) return;
  let list = host.querySelector(":scope > .lib-count-items");
  let sr = host.querySelector(":scope > .lib-count-full");
  if (!list || !sr) {
    list = document.createElement("span");
    list.className = "lib-count-items";
    list.setAttribute("aria-hidden", "true");
    sr = document.createElement("span");
    sr.className = "sr-only lib-count-full";
    host.replaceChildren(list, sr);
  }
  list.replaceChildren(...(Array.isArray(items) ? items : []).map((parts, i) => {
    const item = document.createElement("span");
    item.className = "lib-count-item";
    pbpLibFillCount(item, parts, (slot) => (i === 0 && slot === 0 ? "b" : null));
    return item;
  }));
  const sentence = full ? String(full) : "";
  if (sr.textContent !== sentence) sr.textContent = sentence;
  if (sentence) host.title = sentence;
  else host.removeAttribute("title");
}

// Dates and times (spec §5.3, §11 V7). uiLangToBCP47() can hand Intl a
// malformed stored tag, which throws -- fall back to the browser default
// rather than losing the date.
function _pbpLibLocale() {
  try { return typeof uiLangToBCP47 === "function" ? uiLangToBCP47() : undefined; } catch (_) { return undefined; }
}
function _pbpLibDateString(date, method, opts) {
  try {
    return date[method](_pbpLibLocale(), opts);
  } catch (_) {
    try {
      return date[method](undefined, opts);
    } catch (err) {
      console.warn("[library] date format failed", err && err.name, err && err.message);
      return "";
    }
  }
}
function pbpLibFormatDay(ts, now = Date.now()) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const date = new Date(n);
  const sameYear = date.getFullYear() === new Date(Number(now)).getFullYear();
  return _pbpLibDateString(date, "toLocaleDateString",
    sameYear ? { month: "long", day: "numeric" } : { year: "numeric", month: "long", day: "numeric" });
}
function pbpLibFormatTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  return _pbpLibDateString(new Date(n), "toLocaleTimeString", { hour: "2-digit", minute: "2-digit" });
}
function pbpLibSameDay(a, b) {
  const x = new Date(Number(a));
  const y = new Date(Number(b));
  if (Number.isNaN(x.getTime()) || Number.isNaN(y.getTime())) return false;
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

// "Filter" popover on the narrow index (spec §3.4). One DOM for both forms:
// which form shows is the index's data-header-fit (pbpLibWireVocabHeaderFit
// below, read by CSS); this only runs the popover form's open / close
// bookkeeping.
function pbpLibWireFilterPopover(set, button, indexEl) {
  if (!set || !button || set.dataset.wired) return;
  set.dataset.wired = "1";
  set.addEventListener("toggle", (e) => {
    if (e.newState === "open") {
      button.setAttribute("aria-expanded", "true");
      if (typeof window.pbpListboxPlace === "function") window.pbpListboxPlace(set, button);
      return;
    }
    button.setAttribute("aria-expanded", "false");
    // pbpListboxPlace writes inline fixed placement (right / bottom "auto"
    // included); left behind, it would pin the WIDE form to the viewport the
    // next time the index widens.
    for (const prop of ["position", "left", "top", "right", "bottom", "min-width", "max-width", "--listbox-room"]) set.style.removeProperty(prop);
    if (!set.getAttribute("style")) set.removeAttribute("style");
    set.removeAttribute("data-flip");
    // A list box opened inside (T6) closes with its panel.
    for (const open of set.querySelectorAll('[aria-expanded="true"]')) {
      open.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    }
  });
  if (indexEl && typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (!set.matches(":popover-open")) return;
      if (getComputedStyle(button).display !== "none") return;
      try {
        set.hidePopover();
      } catch (err) {
        console.warn("[library] filter popover close failed", err && err.name, err && err.message);
      }
    }).observe(indexEl);
  }
}

// ---- Header fit (spec appendix, user ruling 10-04) --------------------------
// A list-header row with a wide and a narrow form switches by its own content,
// not by a fixed width: wide when the wide form's content fits the index on
// one line, narrow when it does not. The vocabulary filter row folds into the
// Filter popover; the notes colour row drops its numbers (dots only, the
// count stays in each toggle's title / accessible name). The verdict is
// written to the list pane as data-header-fit="wide|narrow" and CSS does the
// rest.
//
// No flapping: `need` is the wide form's intrinsic width, measured on a
// hidden copy of the row laid out in that form, so it is the same number
// whichever form is showing; `room` is the pane's content box, which neither
// form changes. Re-measured when the pane resizes, when the row's content
// changes (counts, labels -- a language change rewrites them), when <html>
// changes language or density, and after applyI18n.
function pbpLibHeaderFitForm(need, room) {
  return Number.isFinite(need) && Number.isFinite(room) && need <= room + 0.5 ? "wide" : "narrow";
}

// Fractional, like the need it is compared with (clientWidth rounds).
function pbpLibContentWidth(el) {
  const cs = getComputedStyle(el);
  const px = (v) => parseFloat(v) || 0;
  return el.getBoundingClientRect().width - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth);
}

// The width `row` needs laid out on one line at max-content, measured on a
// copy placed next to it (same ancestors, so the same rules match). The copy
// has no ids, no popover wiring, is inert and invisible, and is gone before
// this returns -- one synchronous layout, never painted. `prepare(copy,
// counterpart)` reshapes the copy into the form being measured;
// counterpart(original) finds an original descendant's copy.
function pbpLibMeasureCopyWidth(row, prepare) {
  const copy = row.cloneNode(true);
  const counterpart = (orig) => {
    const path = [];
    for (let n = orig; n && n !== row; n = n.parentElement) path.unshift([...n.parentElement.children].indexOf(n));
    let c = copy;
    for (const i of path) c = c && c.children[i];
    return c || null;
  };
  // Never two elements with one id, not even for this one layout (no rule
  // in the measured rows is keyed on an id).
  for (const el of [copy, ...copy.querySelectorAll("[id], [popover], [popovertarget], [for]")]) {
    for (const attr of ["id", "popover", "popovertarget", "for"]) el.removeAttribute(attr);
  }
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  Object.assign(copy.style, { position: "absolute", visibility: "hidden", left: "0", top: "0",
    width: "max-content", maxWidth: "none", flexWrap: "nowrap", pointerEvents: "none" });
  row.after(copy);
  try {
    if (prepare) prepare(copy, counterpart);
    return copy.getBoundingClientRect().width;
  } finally {
    copy.remove();
  }
}

// The vocabulary filter row's wide form: the Filter button and the
// single-pane lookup door out, the .vocab-filter-set laid out inline (the
// popover's nodes in a row, gap = the row's), and any shrinkable child with a
// px floor (the group filter's min-width) at that floor -- the wide form lets
// it shrink there. NaN until library-vocab.js marks the counts as landed
// (data-counts-ready on .vocab-status-toggles, set once the list has loaded,
// cleared while it reloads): the form is not decided on a row that is about
// to grow. Landed with no words at all, the toggles stay hidden and the row
// is measured without them -- a decided form either way.
// Two listbox details (T6b): a listbox's popover never takes row width (it
// is a top-layer panel; in the copy it would lose [popover] and lay out in
// flow), so the copies drop every .listbox-pop. And a ghost trigger (the
// sort menu button) is measured with the widest face word any of its options
// can show -- its options' words stacked in one grid cell -- so picking
// another sort never folds or unfolds the row under the user.
function pbpLibVocabFilterNeed(row) {
  const set = row && row.querySelector(".vocab-filter-set");
  if (!set) return NaN;
  const toggles = row.querySelector(".vocab-status-toggles");
  if (toggles && !toggles.hasAttribute("data-counts-ready")) return NaN;
  const gap = getComputedStyle(row).columnGap;
  return pbpLibMeasureCopyWidth(row, (copy, counterpart) => {
    // Resolve every copy before removing any: counterpart() walks child
    // indices, which a removal shifts.
    const doomed = [...row.querySelectorAll(":scope > [popovertarget], :scope > .vocab-lookup-narrow, .listbox-pop")].map(counterpart);
    for (const trigger of row.querySelectorAll(".listbox-trigger")) {
      const select = trigger.parentElement && trigger.parentElement.previousElementSibling;
      const copyTrigger = counterpart(trigger);
      const stack = copyTrigger && copyTrigger.lastElementChild;
      if (!select || select.tagName !== "SELECT" || !stack) continue;
      const words = new Set([...select.options].map((o) => o.dataset.faceLabel || (o.textContent || "").trim()));
      stack.replaceChildren(...[...words].map((word) => {
        const span = document.createElement("span");
        span.textContent = word;
        span.style.gridArea = "1 / 1";
        return span;
      }));
      stack.style.display = "inline-grid";
    }
    for (const c of doomed) if (c) c.remove();
    const cset = copy.querySelector(".vocab-filter-set");
    Object.assign(cset.style, { display: "flex", position: "static", inset: "auto", margin: "0", padding: "0", border: "0",
      width: "auto", height: "auto", overflow: "visible", flex: "none", minWidth: "0", alignItems: "center", gap });
    for (const kid of cset.children) {
      const cs = getComputedStyle(kid);
      const floor = parseFloat(cs.minWidth);
      if (cs.display === "none" || cs.position === "absolute" || !(parseFloat(cs.flexShrink) > 0) || !(floor > 0)) continue;
      Object.assign(kid.style, { flex: "none", width: `${floor}px` });
    }
  });
}

// The notes colour row's wide form: every toggle with its number showing.
function pbpLibNotesColorNeed(row) {
  if (!row || row.hidden) return NaN;
  return pbpLibMeasureCopyWidth(row, (copy) => {
    for (const num of copy.querySelectorAll(".lib-toggle-count")) num.style.display = "inline";
  });
}

// Wires one pane: decides now, then again on every trigger above. `opts`:
// narrowMedia -- a media query under which the form is always narrow (the
// <=860px single-pane layout); onChange(form) -- after the attribute flips.
// Returns the update function (also run by the triggers).
// What the measurement depends on inside the row, as one string: its text
// plus, per element, exactly the attributes the row observer below watches.
function pbpLibRowState(row) {
  let out = row.textContent;
  for (const el of row.querySelectorAll("*")) {
    out += `\u0001${el.hidden ? "h" : ""}${el.getAttribute("aria-pressed") || ""}:${el.getAttribute("class") || ""}${el.hasAttribute("data-counts-ready") ? ":r" : ""}`;
  }
  return out;
}

function pbpLibWireHeaderFit(pane, row, measureNeed, opts = {}) {
  if (!pane || !row || typeof measureNeed !== "function") return null;
  if (pane._pbpHeaderFit) return pane._pbpHeaderFit;
  const { narrowMedia = "", onChange = null } = opts;
  const html = document.documentElement;
  // Hot path: a vocabulary re-render (every keystroke in the undebounced
  // search box) rewrites the count text, which fires the row observer. The
  // measurement only runs when something it depends on changed -- the row's
  // state (pbpLibRowState: text, hidden / pressed / class, counts-ready),
  // <html> language / theme / density, or the room -- and otherwise only
  // re-asserts the last verdict.
  let lastSig = null, lastForm = null;
  const apply = (form) => {
    if (!form || pane.dataset.headerFit === form) return;
    pane.dataset.headerFit = form;
    if (onChange) onChange(form);
  };
  const update = (roomHint) => {
    try {
      if (narrowMedia && window.matchMedia(narrowMedia).matches) {
        lastSig = null;
        apply("narrow");
        return pane.dataset.headerFit || null;
      }
      // The room first: read while layout is still the page's own, before
      // the measuring copy dirties it.
      const room = Number.isFinite(roomHint) ? roomHint : pbpLibContentWidth(pane);
      const sig = `${pbpLibRowState(row)}\u0000${html.lang}\u0000${html.dataset.theme || ""}\u0000${html.dataset.density || ""}\u0000${room.toFixed(2)}`;
      if (sig === lastSig) {
        apply(lastForm);
        return pane.dataset.headerFit || null;
      }
      const need = measureNeed(row);
      if (Number.isFinite(need)) {
        lastSig = sig;
        lastForm = pbpLibHeaderFitForm(need, room);
        apply(lastForm);
      }
    } catch (err) {
      console.warn("[library] header fit measure failed", err && err.name, err && err.message);
    }
    return pane.dataset.headerFit || null;
  };
  // Every trigger lands here: one language change fires the <html> observer,
  // the row observer and pbp:i18n-applied in the same task -- they share one
  // microtask and one measurement. A resize hands over the observer's own
  // content-box width, so that path reads no layout at all.
  let queued = false, pendingRoom;
  const schedule = (roomHint) => {
    if (Number.isFinite(roomHint)) pendingRoom = roomHint;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const r = pendingRoom;
      pendingRoom = undefined;
      update(r);
    });
  };
  pane._pbpHeaderFit = update;
  if (typeof ResizeObserver === "function") {
    new ResizeObserver((entries) => {
      const box = entries[entries.length - 1];
      schedule(box && box.contentRect ? box.contentRect.width : undefined);
    }).observe(pane);
  }
  if (typeof MutationObserver === "function") {
    new MutationObserver(() => schedule()).observe(row, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["hidden", "aria-pressed", "class", "data-counts-ready"] });
    new MutationObserver(() => schedule()).observe(html, { attributes: true, attributeFilter: ["lang", "data-theme", "data-density"] });
  }
  document.addEventListener("pbp:i18n-applied", () => schedule());
  update();
  return update;
}

function pbpLibWireVocabHeaderFit(pane) {
  const row = pane && pane.querySelector(".vocab-filter-row");
  const set = row && row.querySelector(".vocab-filter-set");
  return pbpLibWireHeaderFit(pane, row, pbpLibVocabFilterNeed, {
    narrowMedia: "(max-width: 860px)",
    // Widened past the need while the popover is open: its nodes go back
    // inline, so the panel closes (its toggle handler clears the placement).
    onChange: (form) => {
      if (form !== "wide" || !set || !set.matches(":popover-open")) return;
      try {
        set.hidePopover();
      } catch (err) {
        console.warn("[library] filter popover close failed", err && err.name, err && err.message);
      }
    },
  });
}

function pbpLibWireNotesHeaderFit(pane) {
  return pbpLibWireHeaderFit(pane, pane && pane.querySelector(".notes-color-filters"), pbpLibNotesColorNeed);
}
