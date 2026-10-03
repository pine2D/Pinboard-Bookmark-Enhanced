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
  // library-vocab.js labels the sort segment at its own parse time -- before
  // initI18n has loaded the manually chosen locale, so those labels came out
  // in the browser UI language. Re-run it here, where t() is finally correct,
  // and it also restores the labels applyI18n just wrote from the static
  // (default-state) keys to the ones the live select value calls for.
  if (typeof _pbpVocabSyncSortSeg === "function") _pbpVocabSyncSortSeg();
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
// the wide form is plain CSS (@container lib-index); this only runs the
// popover form's open / close bookkeeping.
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
