// Notes view for the library page — migrated from options-notes.js.

// ---- Pure layer (no DOM/chrome/fetch) -- loadable standalone from
// tests/options-notes-tests.html. Signatures below are frozen (spec section 3).

// pbpEntryBytes lives in shared.js; typeof-guarded so this section stays
// loadable without shared.js in the test page. The fallback mirrors
// shared.js's own byte estimate exactly, so behavior is identical whether or
// not shared.js is also loaded.
function _pbpNotesEntryBytes(key, rec) {
  if (typeof pbpEntryBytes === "function") return pbpEntryBytes(key, rec);
  try { return key.length + JSON.stringify(rec).length; } catch (_) { return key.length; }
}

// Builds the summary row model for one pbp_hl_* storage entry, or null for
// a malformed record (spec 6.1: bad records are skipped, never thrown).
function pbpNotesRow(key, rec) {
  if (!rec || typeof rec !== "object" || !Array.isArray(rec.items)) return null;
  let noteCount = 0;
  let lastTs = 0;
  for (const it of rec.items) {
    if (it && typeof it === "object") {
      if (typeof it.note === "string" && it.note.trim()) noteCount++;
      if (typeof it.ts === "number" && it.ts > lastTs) lastTs = it.ts;
    }
  }
  return {
    key,
    url: typeof rec.url === "string" ? rec.url : "",
    title: typeof rec.title === "string" ? rec.title : "",
    hlCount: rec.items.length,
    noteCount,
    lastTs,
    bytes: _pbpNotesEntryBytes(key, rec),
  };
}

// Case-insensitive substring match across title/url/quote/note. Empty/blank
// query always matches (spec 3). Operates on the raw rec (not the row model)
// so it sees every item's quote/note directly.
function pbpNotesMatch(rec, q) {
  const query = (typeof q === "string" ? q : "").trim().toLowerCase();
  if (!query) return true;
  if (!rec || typeof rec !== "object") return false;
  const title = typeof rec.title === "string" ? rec.title : "";
  const url = typeof rec.url === "string" ? rec.url : "";
  if (title.toLowerCase().includes(query) || url.toLowerCase().includes(query)) return true;
  const items = Array.isArray(rec.items) ? rec.items : [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const quote = typeof it.quote === "string" ? it.quote : "";
    const note = typeof it.note === "string" ? it.note : "";
    if (quote.toLowerCase().includes(query) || note.toLowerCase().includes(query)) return true;
  }
  return false;
}

// Selection primitives, kept pure and in this layer so the standalone test
// page can exercise them without a DOM. Twins of library-vocab.js's
// pbpVocabSelectRange / pbpVocabSelectResults -- same semantics, string keys
// instead of word ids. Deliberately NOT shared through one helper: the two
// pages never co-load, and a shared module would have to be a fourth file
// loaded by both for two dozen lines.
function pbpNotesSelectRange(selected, keys, anchorKey, targetKey, want) {
  const next = new Set(selected || []);
  const list = Array.isArray(keys) ? keys : [];
  const start = list.indexOf(anchorKey), end = list.indexOf(targetKey);
  if (start < 0 || end < 0) {
    if (targetKey) want ? next.add(targetKey) : next.delete(targetKey);
    return next;
  }
  for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
    want ? next.add(list[i]) : next.delete(list[i]);
  }
  return next;
}

function pbpNotesSelectResults(selected, keys, mode) {
  const next = new Set(selected || []);
  for (const key of (Array.isArray(keys) ? keys : [])) {
    if (!key) continue;
    if (mode === "invert") { if (next.has(key)) next.delete(key); else next.add(key); }
    else next.add(key);
  }
  return next;
}

function pbpNotesEntryHasColor(rec, colorSet) {
  if (!colorSet || !colorSet.size) return true;
  if ([1, 2, 3, 4, 5].every((c) => colorSet.has(c))) return true;
  const items = rec && Array.isArray(rec.items) ? rec.items : [];
  return items.some((it) => {
    if (!it || typeof it !== "object") return false;
    const c = Number(it.color);
    return colorSet.has(c >= 1 && c <= 5 ? c : 1);
  });
}

// Notes count-row statistics over the owner's highlight hits (spec §3.5).
// `hits` are _pbpNotesHits() entries ({ row, ts, ... }); `now` injected.
function pbpNotesStats(hits, now) {
  const list = Array.isArray(hits) ? hits : [];
  const pages = new Set();
  let added7 = 0, added30 = 0, latestTs = 0;
  const d7 = now - 7 * 86400000, d30 = now - 30 * 86400000;
  for (const hit of list) {
    if (hit && hit.row && hit.row.key) pages.add(hit.row.key);
    const ts = Number(hit && hit.ts) || 0;
    if (ts >= d7) added7++;
    if (ts >= d30) added30++;
    if (ts > latestTs) latestTs = ts;
  }
  return { highlights: list.length, pages: pages.size, added7, added30, latestTs };
}

// ============================================================
// Render / interaction layer (DOM + chrome.storage). Invoked by the
// pbp-lib-view mount below on every "notes" view activation -- same
// no-guard, rescan-every-time pattern as renderStoragePanel() in options.js
// (a fresh chrome.storage.local.get(null) scan per activation; the data set
// is small enough that this is cheap).
//
// Master-detail (2026-08): the left pane lists ONE ROW PER HIGHLIGHT, the
// right pane reads the selected one. Storage is untouched -- it still holds
// one pbp_hl_<page> record with an items[] array -- so the flattening into
// per-highlight rows lives here, in the view, and the pure layer above keeps
// its frozen article-level signatures.
// ============================================================

const PBP_NOTES_COLORS = [1, 2, 3, 4, 5];
const PBP_NOTES_COLOR_KEYS = ["hlColorQuote", "hlColorDefinition", "hlColorExample", "hlColorDoubt", "hlColorTodo"];
let _notesAllRows = []; // [{ row, rec }], last full scan, sorted lastTs desc
// Set by _pbpNotesScan itself (not by its caller) at every successful return,
// true when that scan's owner filter dropped at least one item from some
// record -- never a count, never which record, just whether it happened. Kept
// in step with _notesAllRows: both are the last successful scan's picture,
// both stay stale (not reset to a wrong "nothing hidden") across a failed
// rescan, and both are reset together on an account switch below.
let _notesHiddenByOwner = false;
// Colour filter, additive (user ruling 10-03, spec §3.2): the empty set is
// "All". pbpNotesEntryHasColor already reads empty and full sets as "all".
let _notesActiveColors = new Set();
// Next set after a click on `color` (1-5, or "all"): All clears; a colour
// toggles in or out; emptying the set or filling all five is All again.
function pbpNotesToggleColor(active, color) {
  if (color === "all") return new Set();
  const next = new Set(active || []);
  if (next.has(color)) next.delete(color);
  else next.add(color);
  return PBP_NOTES_COLORS.every((c) => next.has(c)) ? new Set() : next;
}
// Render cap, the vocabulary list's contract (library-vocab.js's
// _vocabRenderLimit / PBP_VOCAB_RENDER_BATCH): the two lists on this page grow
// the same way. A heavy highlighter has hundreds of hits and every one of them
// is ~8 elements, two listeners, a toLocaleDateString and a <mark> split --
// paid in full on every keystroke in the filter box, for rows nobody scrolled
// to. Reset by whatever changes WHICH rows exist (filter, colour), preserved
// across a rescan so a background refresh never collapses what was expanded.
const PBP_NOTES_RENDER_BATCH = 100;
let _notesRenderLimit = PBP_NOTES_RENDER_BATCH;
// The highlight the detail pane is reading, as "<storage key>#<item id>".
// Same job _pbpVocabDetailWordId does for the vocabulary view: it outlives
// every rebuild, so a rescan can put the selection back where it was.
let _pbpNotesSelectedKey = null;
// The PAGE the detail last rendered (its pbp_hl_ storage key), which is not
// the same thing as the selection: a refresh (_pbpNotesRefreshPreservingState,
// fired by every pbp_hl_ write from an open reader) re-renders the same page,
// and jumping between excerpts of one page is reading on, not opening
// something new -- so only a change of PAGE resets the pane's scroll position
// (spec 2026-10-03-library-redesign §5.4); a change of highlight inside the
// page only nudges the new current excerpt into view. Twin of the `sameWord`
// guard in library-vocab.js's _pbpVocabRenderDetail.
let _notesRenderedPageKey = null;
// True once a scan has succeeded for the current account; the cover's
// statistics sentence stays empty until then (spec §4.11 / §5.7: no number
// before the first count), and an account switch sets it back.
let _notesScanDone = false;
// The HIGHLIGHT the detail last rendered. Inside one page a change of
// highlight -- from the list or from a jump button -- must bring the new
// current excerpt into view (spec §5.4), while a refresh of the same highlight
// must not move the pane at all; this key tells the two apart.
let _notesRenderedDetailKey = null;
// Batch selection (2026-08-06), same model as the vocabulary list: a Set of
// hit keys plus the anchor a Shift gesture spans from. Distinct from
// _pbpNotesSelectedKey above, which is "the one the detail pane is reading" --
// the two are independent, and a row can be either, both or neither.
let _notesSelected = new Set();
let _notesLastSelectedKey = null;
let _notesBatchBusy = false;
// Scan generation, twin of library-vocab.js's _vocabRenderGen. Every
// renderNotesPanel takes a new one and an account switch bumps it too, so a
// scan still in flight when the account changes lands stale and is dropped:
// without this, the previous account's rows (and, through
// _pbpNotesRefreshPreservingState, its open detail) came back after the
// switch had already cleared them.
let _notesRenderGen = 0;

// Account scoping (roadmap #19): memoized owner scope for the scan below. The
// library page is long-lived and the account can change under it, so the
// cache invalidates on any pinboardToken/optSyncEnabled/syncApiKeys change
// (either area — credential routing decides which one holds the token; a
// change that flips only syncApiKeys moves the live token between areas,
// shared.js:578, without ever touching pinboardToken). Rule mirrors
// md-highlight's pbpHlItemVisibleFor: ownerless items are visible to
// everyone, owned items only to their owner; resolve failure -> "" = only
// ownerless items show (fail-closed for owned ones).
let _notesOwnerCache = null; // null = unresolved; string = resolved scope ("" = ownerless)
async function _pbpNotesOwner() {
  if (_notesOwnerCache !== null) return _notesOwnerCache;
  let scope = "";
  try {
    const raw = typeof pbpVocabCurrentOwner === "function" ? await pbpVocabCurrentOwner() : "";
    scope = (raw && raw !== "ownerless") ? String(raw) : "";
  } catch (_) { scope = ""; }
  _notesOwnerCache = scope;
  return scope;
}
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" && area !== "sync") return;
    if (changes.pinboardToken || changes.optSyncEnabled || changes.syncApiKeys) {
      _notesOwnerCache = null;
      // Invalidate any scan already in flight for the account that just left
      // before clearing what it drew (see _notesRenderGen).
      _notesRenderGen++;
      // Fail-closed NOW, not at the next view activation: an account switch
      // carries no pbp_hl_ write, so without this the old account's notes
      // stay on screen indefinitely (Codex review P1; CLAUDE.md owner rule).
      // Harmless when the notes view is not the active one.
      if (typeof renderNotesPanel === "function") {
        // Drop what the previous account had on screen SYNCHRONOUSLY, then
        // re-scan. renderNotesPanel is async and can fail (a failed read
        // deliberately keeps the rendered list rather than painting an empty
        // state over it), so leaving the old rows up until it returns would
        // make "fail-closed" depend on the rescan succeeding.
        _notesAllRows = [];
        // Same reason: the last scan's "some items were hidden by owner"
        // verdict belongs to the account that just left. Clearing it here
        // (rather than leaving it true) is what keeps the synchronous
        // interim render below from showing the wrong-account explanation
        // for zero rows -- the rescan below recomputes it for real.
        _notesHiddenByOwner = false;
        // The rebuild below never touches #notes-detail, so on its own it
        // leaves the previous account's quote, note and delete button on
        // screen -- and that button targets the previous account's record.
        // Same gap, same fix, as library-vocab.js's account-switch path.
        _pbpNotesRenderDetail(null);
        _notesScanDone = false;
        _pbpNotesResetListScroll(); // spec §7.6: a new owner's list starts at the top
        _notesActiveColors = new Set();
        _pbpNotesRender(true);
        renderNotesPanel().catch(() => {});
      }
    }
  });
}

// The owner rule for ONE stored item, in one place. The scan filters the
// rendered list with it and both delete paths decide what they may remove with
// it, so display and destruction can never drift apart -- an inverted second
// copy of this test is exactly how a page delete came to take other accounts'
// highlights with it. Mirrors md-highlight's pbpHlItemVisibleFor: ownerless
// items belong to everyone, owned items only to their owner.
function _pbpNotesItemVisible(it, owner) {
  const o = (it && typeof it.owner === "string") ? it.owner : "";
  return !o || o === owner;
}

// Scan result is `null` (not `[]`) when the storage read itself failed --
// renderNotesPanel has to tell that apart from "this account has nothing
// saved", which is the same picture with the opposite meaning.
async function _pbpNotesScan() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
    _notesHiddenByOwner = false;
    return [];
  }
  // Display-level only: both deletes operate through _pbpNotesItemVisible on a
  // fresh read, so foreign items are untouchable here by construction.
  const _notesOwner = await _pbpNotesOwner();
  const _itemVisible = (it) => _pbpNotesItemVisible(it, _notesOwner);
  let all;
  try {
    if (typeof chrome.storage.local.getKeys === "function") {
      // Chrome 130+: list keys without deserializing values, then fetch only
      // the pbp_hl_ records. get(null) deserialized the ENTIRE local area
      // (incl. MB-scale jina_md_ page caches) on every view activation AND
      // every alt-tab back to this tab (visibilitychange re-mounts the view).
      // min_chrome is 123, so the get(null) fallback below stays.
      const keys = (await chrome.storage.local.getKeys())
        .filter((k) => k.startsWith("pbp_hl_") && k !== "pbp_hl_last_color");
      all = keys.length ? await chrome.storage.local.get(keys) : {};
    } else {
      all = await chrome.storage.local.get(null);
    }
  } catch (e) {
    // Name/message only, never highlight or note content. _notesHiddenByOwner
    // is deliberately left untouched here, same as _notesAllRows: a failed
    // read keeps the last successful scan's verdict rather than resetting it
    // to a guess, and renderNotesPanel never reaches the render path that
    // would consult it on this branch anyway (it bails out on `null` first).
    console.warn("[notes] scan failed", e && e.name, e && e.message);
    return null;
  }
  const rows = [];
  // Only WHETHER this scan's owner filter dropped anything, never how much --
  // a count or a list of which pages would leak how many (or which) highlights
  // another account has on this shared profile.
  let hiddenByOwner = false;
  for (const key of Object.keys(all || {})) {
    if (!key.startsWith("pbp_hl_") || key === "pbp_hl_last_color") continue;
    let rec = all[key];
    // Owner filter on a COPY — never mutate the stored record shape.
    if (rec && Array.isArray(rec.items) && rec.items.some((it) => !_itemVisible(it))) {
      hiddenByOwner = true;
      rec = { ...rec, items: rec.items.filter(_itemVisible) };
      if (!rec.items.length) continue; // page fully foreign: no row at all
    }
    const row = pbpNotesRow(key, rec);
    if (row) rows.push({ row, rec });
  }
  rows.sort((a, b) => b.row.lastTs - a.row.lastTs);
  _notesHiddenByOwner = hiddenByOwner;
  return rows;
}

function _pbpNotesColorOf(it) {
  const c = Number(it && it.color);
  return c >= 1 && c <= 5 ? c : 1;
}

// Stable per-row identity: the page's storage key plus the highlight's own id.
// Everything that has to survive a rebuild (selection, aria-current, the
// refresh restore) matches on this string, never on DOM position.
function _pbpNotesHitKey(key, it, idx) {
  return key + "#" + (it && it.id != null ? String(it.id) : "i" + idx);
}

// The whole scan, flattened to one entry per highlight, newest first. Sorting
// by the highlight's own ts (not the page's last-active) is what makes the
// list read as "what did I mark recently" across pages.
function _pbpNotesHits() {
  const hits = [];
  for (const { row, rec } of _notesAllRows) {
    const items = Array.isArray(rec.items) ? rec.items : [];
    items.forEach((it, idx) => {
      if (!it || typeof it !== "object") return;
      hits.push({
        key: _pbpNotesHitKey(row.key, it, idx),
        row,
        rec,
        item: it,
        ts: typeof it.ts === "number" ? it.ts : row.lastTs,
      });
    });
  }
  hits.sort((a, b) => b.ts - a.ts);
  return hits;
}

// Per-highlight filtering that REUSES the frozen article-level predicates on a
// one-item view of the record: pbpNotesMatch's "page title/url matches, or any
// item does" and pbpNotesEntryHasColor's "any item is in the set" both collapse
// to exactly the per-highlight question when items is [this one]. No second
// copy of either rule, and a title match still surfaces the page's highlights.
// `all` lets one render reuse a flatten it already paid for (see
// _pbpNotesRender); omitted, it takes its own.
function _pbpNotesVisibleHits(all) {
  const filterInput = $id("notes-filter");
  const q = filterInput ? filterInput.value : "";
  return (all || _pbpNotesHits()).filter((hit) => {
    const one = { title: hit.row.title, url: hit.row.url, items: [hit.item] };
    return pbpNotesMatch(one, q) && pbpNotesEntryHasColor(one, _notesActiveColors);
  });
}

// Lookup over ALL hits, not just the visible ones: the detail pane's
// same-page section can hand back a highlight the current filter hides.
function _pbpNotesFindHit(key) {
  return key ? _pbpNotesHits().find((hit) => hit.key === key) || null : null;
}

// Every highlight of ONE page, unfiltered by the list's search box and colour
// toggles (the detail reads the page, the list is only how you got there),
// oldest first. Built from the stored item order so two highlights with the
// same ts keep the order they were saved in, and an item with no ts of its own
// borrows the page's last one -- the same fallback _pbpNotesHits uses, so the
// keys match the list rows exactly.
function _pbpNotesPageHits(rowKey) {
  const entry = _notesAllRows.find((e) => e.row.key === rowKey);
  if (!entry) return [];
  const items = Array.isArray(entry.rec.items) ? entry.rec.items : [];
  const hits = [];
  items.forEach((it, idx) => {
    if (!it || typeof it !== "object") return;
    hits.push({
      key: _pbpNotesHitKey(entry.row.key, it, idx),
      row: entry.row,
      rec: entry.rec,
      item: it,
      ts: typeof it.ts === "number" ? it.ts : entry.row.lastTs,
      idx,
    });
  });
  return hits.sort((a, b) => (a.ts - b.ts) || (a.idx - b.idx));
}

function _pbpNotesHostname(url) {
  try { return new URL(String(url || "")).hostname; } catch (_) { return ""; }
}

// Split `text` around case-insensitive matches of `query`; matches render in
// <mark>. Appends, so one host can carry quote + note. Twin of
// library-vocab.js's _pbpVocabHighlightTerm (same shape, different needle
// source) -- textContent-only construction, never innerHTML with stored text.
function _pbpNotesMarkText(host, text, query) {
  const value = text == null ? "" : String(text);
  const needle = (query || "").trim().toLowerCase();
  if (!needle) { host.appendChild(document.createTextNode(value)); return; }
  const lower = value.toLowerCase();
  // toLowerCase is not length-preserving (U+0130 folds to two code units) and
  // every offset below indexes `lower` while slicing `value` -- once the two
  // lengths part company the marks wrap text that never matched. Drop the
  // highlight rather than point at the wrong characters.
  if (lower.length !== value.length) { host.appendChild(document.createTextNode(value)); return; }
  let idx = 0, pos = lower.indexOf(needle);
  while (pos !== -1) {
    host.appendChild(document.createTextNode(value.slice(idx, pos)));
    const mark = document.createElement("mark");
    mark.textContent = value.slice(pos, pos + needle.length);
    host.appendChild(mark);
    idx = pos + needle.length;
    pos = lower.indexOf(needle, idx);
  }
  host.appendChild(document.createTextNode(value.slice(idx)));
}

function _pbpNotesFilterQuery() {
  const filterInput = $id("notes-filter");
  return filterInput ? filterInput.value : "";
}

// Compact left row (spec §3.7): colour dot, two clamped lines of highlight,
// the note on its own line after a pencil, then host · date. No inline delete -- the one
// destructive action lives in the detail pane, where its scope is spelled out.
function _pbpNotesBuildRow(hit) {
  const rowEl = document.createElement("div");
  rowEl.className = "notes-hit";
  // role=row + gridcell, matching the vocabulary list: rows are
  // multi-selectable and carry aria-selected, which ARIA only supports on
  // grid/listbox descendants.
  rowEl.setAttribute("role", "row");
  rowEl.dataset.notesKey = hit.key;
  const isSelected = _notesSelected.has(hit.key);
  rowEl.setAttribute("aria-selected", isSelected ? "true" : "false");
  rowEl.classList.toggle("selected", isSelected);

  // The gridcell wrapper is a real box, not display:contents: the row button
  // takes its radius via `border-radius: inherit`, and a wrapper that
  // inherits nothing would silently square off every row's corners.
  const cell = document.createElement("div");
  cell.className = "notes-hit-cell";
  cell.setAttribute("role", "gridcell");

  // The row content is a button so the list stays keyboard-reachable, same
  // shape the vocabulary list uses (card > head button).
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "notes-hit-btn";
  // K89: "/" (jump to the search filter) rides along with the existing
  // multi-select chords -- it fires from anywhere in the list (see the
  // #notes-list keydown below), not just this row, but this is the only
  // per-row control an assistive-tech user reading a row would query.
  btn.setAttribute("aria-keyshortcuts", "Control+Space Shift+Space /");
  // Roving tabindex (see _pbpNotesSyncRowTabStops): every row builds OUT of
  // the tab order, and exactly one is put back after the render.
  btn.tabIndex = -1;

  const color = _pbpNotesColorOf(hit.item);
  const dot = document.createElement("span");
  dot.className = "notes-hit-dot notes-c" + color;
  dot.setAttribute("aria-hidden", "true");
  btn.appendChild(dot);

  const body = document.createElement("span");
  body.className = "notes-hit-body";
  // The dot is decorative; the colour's meaning reaches the accessible name
  // as text (spec §3.7).
  const colorName = document.createElement("span");
  colorName.className = "sr-only";
  colorName.textContent = t(PBP_NOTES_COLOR_KEYS[color - 1]);
  body.appendChild(colorName);

  const q = _pbpNotesFilterQuery();
  const text = document.createElement("span");
  text.className = "notes-hit-text";
  _pbpNotesMarkText(text, typeof hit.item.quote === "string" ? hit.item.quote : "", q);
  body.appendChild(text);
  const note = typeof hit.item.note === "string" ? hit.item.note : "";
  if (note.trim()) {
    // Own line, after a pencil (spec §3.7). The separator stays as text for
    // the accessible name (and any copy of the row), visually hidden.
    const sep = document.createElement("span");
    sep.className = "sr-only";
    sep.textContent = " — ";
    body.appendChild(sep);
    const noteEl = document.createElement("span");
    noteEl.className = "notes-hit-note";
    // Static PBP_ICONS constant (already aria-hidden), never page content.
    noteEl.insertAdjacentHTML("afterbegin", PBP_ICONS.pencil);
    const noteText = document.createElement("span");
    _pbpNotesMarkText(noteText, note, q);
    noteEl.appendChild(noteText);
    body.appendChild(noteEl);
  }

  const meta = document.createElement("span");
  meta.className = "notes-hit-meta";
  const site = document.createElement("span");
  site.className = "notes-meta-chip";
  site.textContent = _pbpNotesHostname(hit.row.url) || t("notesUnknownPage");
  meta.appendChild(site);
  const dateText = pbpLibFormatDay(hit.ts);
  if (dateText) {
    const dateSpan = document.createElement("span");
    dateSpan.className = "notes-meta-chip";
    dateSpan.textContent = dateText;
    dateSpan.title = t("notesColLastActive");
    meta.appendChild(dateSpan);
  }
  body.appendChild(meta);

  btn.appendChild(body);
  // Same three verbs as the vocabulary list, deliberately one grammar across
  // both views: plain click reads the highlight, Ctrl/Cmd+click adds it to the
  // batch selection without moving the reading pane, Shift+click spans the
  // interval from the anchor (and clears it when the anchor gesture was a
  // clear). Space is the button's own activation key, so the modified keyboard
  // forms are caught on keydown and preventDefault'd.
  btn.addEventListener("click", (e) => {
    if (e.shiftKey) { _pbpNotesRowSelect(hit.key, true); return; }
    if (e.ctrlKey || e.metaKey) { _pbpNotesRowSelect(hit.key, false); return; }
    _pbpNotesSelectRow(hit.key);
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "Spacebar") return;
    if (e.shiftKey) { e.preventDefault(); _pbpNotesRowSelect(hit.key, true); }
    else if (e.ctrlKey || e.metaKey) { e.preventDefault(); _pbpNotesRowSelect(hit.key, false); }
  });
  cell.appendChild(btn);
  rowEl.appendChild(cell);
  return rowEl;
}

// One gesture, four entry points. `range` sets the whole anchor..target
// interval to what a plain toggle of THIS row would have produced, which is
// what makes a second Shift pass over a selected block clear it.
function _pbpNotesRowSelect(key, range) {
  if (_notesBatchBusy) return;
  const want = !_notesSelected.has(key);
  if (range && _notesLastSelectedKey) {
    _notesSelected = pbpNotesSelectRange(_notesSelected,
      _pbpNotesVisibleHits().map((h) => h.key), _notesLastSelectedKey, key, want);
  } else if (want) {
    _notesSelected.add(key);
  } else {
    _notesSelected.delete(key);
  }
  _notesLastSelectedKey = key;
  _pbpNotesSyncSelectionUi();
}

function _pbpNotesClearSelection() {
  _notesSelected.clear();
  _notesLastSelectedKey = null;
}

// Keeps every visible row's band, its aria-selected and the batch bar in step
// with the selection set -- a range gesture and Select all both mutate rows
// that were never the click target. Prunes keys the current view no longer
// contains first, the same way _pbpVocabSyncSelectionUi does.
// `hits` is the CURRENT VISIBLE SET, not the rendered slice: selection spans
// everything the filter admits (the vocabulary list reads _vocabViewRows the
// same way), so the render cap must not shrink what Select all takes or what
// the pruning below keeps. The querySelectorAll only reaches rendered rows,
// which is correct -- the rest carry no band to sync.
function _pbpNotesSyncSelectionUi(hits) {
  const visible = new Set((hits || _pbpNotesVisibleHits()).map((h) => h.key));
  for (const key of [..._notesSelected]) if (!visible.has(key)) _notesSelected.delete(key);
  for (const el of document.querySelectorAll("#notes-list .notes-hit")) {
    const on = _notesSelected.has(el.dataset.notesKey);
    el.classList.toggle("selected", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
  }
  const count = _notesSelected.size;
  const countEl = $id("notes-selected-count");
  if (countEl) pbpLibFillCount(countEl, pbpLibSplitCount((...a) => t("vocabSelectedCount", ...a), [String(count)]), () => "b");
  // The batch row replaces the count row in place (spec §3.9); the status
  // region follows (see _pbpNotesStatusHost).
  const bar = $id("notes-batch-toolbar");
  if (bar) bar.classList.toggle("selecting", count > 0);
  const ctx = $id("notes-context-bar");
  if (ctx) ctx.hidden = count > 0;
  const status = $id("notes-status");
  const statusHost = status ? _pbpNotesStatusHost() : null;
  if (status && statusHost && status.parentNode !== statusHost) statusHost.appendChild(status);
  const batchAll = $id("notes-batch-select-all");
  if (batchAll) batchAll.disabled = _notesBatchBusy || visible.size === 0 || count >= visible.size;
  const allBtn = $id("notes-select-all");
  const invertBtn = $id("notes-invert-selection");
  const deleteBtn = $id("notes-batch-delete");
  if (allBtn) allBtn.disabled = _notesBatchBusy || visible.size === 0;
  if (invertBtn) invertBtn.disabled = _notesBatchBusy || visible.size === 0;
  if (deleteBtn) deleteBtn.disabled = _notesBatchBusy || !count;
}

function _pbpNotesRowEl(key) {
  if (!key) return null;
  for (const el of document.querySelectorAll("#notes-list .notes-hit")) {
    if (el.dataset.notesKey === key) return el;
  }
  return null;
}

// Exactly one row carries aria-current (the vocabulary list's rule), and the
// marker is re-derived from _pbpNotesSelectedKey after every rebuild.
function _pbpNotesMarkCurrentRow() {
  document.querySelectorAll("#notes-list .notes-hit[aria-current]")
    .forEach((el) => el.removeAttribute("aria-current"));
  const el = _pbpNotesRowEl(_pbpNotesSelectedKey);
  if (el) el.setAttribute("aria-current", "true");
}

// Roving tabindex for the row grid. #notes-list declares role="grid" and this
// list has no render cap at all, so a heavy highlighter's several hundred rows
// were several hundred Tab stops between the filter box and the batch bar --
// and the arrow keys that role promises did nothing, which left the
// Ctrl/Shift+Space selection chords reachable only by tabbing row by row. One
// stop for the whole list instead, with the arrows doing the moving. Twin of
// library-vocab.js's _pbpVocabRowHeads family, minus its Left/Right: a notes
// row carries exactly one button (the inline delete is deliberately absent).
function _pbpNotesRowButtons() {
  const list = $id("notes-list");
  return list ? [...list.querySelectorAll(".notes-hit .notes-hit-btn")] : [];
}

function _pbpNotesSetRowTabStop(btn) {
  if (!btn) return;
  for (const el of _pbpNotesRowButtons()) el.tabIndex = el === btn ? 0 : -1;
}

// Re-derived after every render: rows are rebuilt wholesale on filter, colour
// change and reload, and a stop pointing at a discarded node leaves the list
// with none at all. A stop that survived the rebuild wins, then the row the
// detail pane is reading, then the first row.
function _pbpNotesSyncRowTabStops() {
  const btns = _pbpNotesRowButtons();
  if (!btns.length) return;
  const list = $id("notes-list");
  const current = list && list.querySelector(".notes-hit[aria-current] .notes-hit-btn");
  _pbpNotesSetRowTabStop(btns.find((el) => el.tabIndex === 0) || current || btns[0]);
}

function _pbpNotesSelectRow(key) {
  const hit = _pbpNotesFindHit(key);
  if (!hit) return;
  _pbpNotesSelectedKey = key;
  _pbpNotesMarkCurrentRow();
  // Keep the list's single tab stop on the row the detail pane is showing:
  // that is what the narrow-mode Back button and every focus-restore path in
  // this file already treat as "where the user was", so the two must not
  // disagree.
  const rowEl = _pbpNotesRowEl(key);
  if (rowEl) _pbpNotesSetRowTabStop(rowEl.querySelector(".notes-hit-btn"));
  _pbpNotesRenderDetail(hit, true);
}

// Narrow (single-pane) mode. Mirrors library.css's 860px threshold -- the CSS
// is the source of truth; this is the same number, not a second layout rule.
// Local twin of library-vocab.js's _pbpVocabNarrowMode: the two views own
// separate body classes on purpose, so neither can strand the other's pane.
function _pbpNotesNarrowMode() {
  return typeof matchMedia === "function" && matchMedia("(max-width: 860px)").matches;
}

// Focus one element, reporting whether it actually took: focus() on a
// display:none element (the back button above 860px) is a silent no-op, and
// every caller here needs to fall through to its next candidate when that
// happens.
function _pbpNotesFocus(el) {
  if (!el) return false;
  try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
  return document.activeElement === el;
}

// Twin of library-vocab.js's _pbpVocabFocusNarrowBack, kept local rather than
// shared because it queries this view's own back button: entering the detail
// in narrow mode hides the list INCLUDING the row button focus came from, and
// Chrome then drops focus to <body> with no keyboard route back.
function _pbpNotesFocusNarrowBack(host) {
  if (!host || !_pbpNotesNarrowMode()) return;
  _pbpNotesFocus(host.querySelector(".notes-detail-back"));
}

function _pbpNotesBuildBackBtn() {
  const back = document.createElement("button");
  back.type = "button";
  back.className = "btn btn-sm ghost notes-detail-back";
  // Lucide arrow-left (user ruling 10-03): going back to the list is not a
  // close, and cross belongs to the delete / remove / close family.
  setBtnIcon(back, "arrowLeft", t("libraryBack"));
  back.addEventListener("click", () => {
    // Read the row to return to BEFORE the pane closes: _pbpNotesRenderDetail
    // (null) drops `lib-narrow-notes`, which at <=860px takes this whole pane
    // -- and with it the button focus is sitting on -- off screen, and it
    // also clears the aria-current marker this query reads. Chrome then
    // resets focus to <body>, and with no skip link on the page the way back
    // is a full Tab walk through the header and the toolbar. Mirror image of
    // _pbpNotesFocusNarrowBack, which fixes the same fall-through on the way
    // INTO the detail.
    const row = document.querySelector("#notes-list .notes-hit[aria-current] .notes-hit-btn");
    _pbpNotesRenderDetail(null);
    // _pbpNotesFocus reports a focus that did not take (a row the filter
    // hides, or one the rebuild dropped), so the filter box catches those.
    if (!_pbpNotesFocus(row)) _pbpNotesFocus($id("notes-filter"));
  });
  return back;
}

// The UI language as a BCP 47 tag, or "" -- uiLangToBCP47() ends in a split
// over an arbitrary stored tag and can throw on a malformed one.
function _pbpNotesUiLang() {
  try { return typeof uiLangToBCP47 === "function" ? String(uiLangToBCP47() || "") : ""; }
  catch (_) { return ""; }
}

// Page head (spec §5.3): the source title (the whole line is the link when the
// url is safe), then one muted meta line. The meta's page count only shows
// below C 1312, where the "this page" column is absent (CSS decides).
// Any Han / kana / Hangul character in a title makes its first line CJK for
// the pull-up rule (library.css .notes-detail-source.lib-cjk). Content, not
// lang: the highlight record has no page language (spec S5).
const PBP_NOTES_CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function _pbpNotesBuildHead(hit, count) {
  const head = document.createElement("header");
  head.className = "notes-detail-head";
  const title = document.createElement("h2");
  title.className = "notes-detail-source lib-first-line";
  const href = typeof pbpDictSafeUrl === "function" ? pbpDictSafeUrl(hit.row.url) : "";
  const label = hit.row.title || _pbpNotesHostname(hit.row.url) || t("notesUnknownPage");
  // The head is rebuilt on every render, so the mark follows the title shown.
  if (PBP_NOTES_CJK_RE.test(label)) title.classList.add("lib-cjk");
  if (href) {
    const link = document.createElement("a");
    link.className = "notes-detail-link";
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = label;
    // Static PBP_ICONS constant (already aria-hidden), never page content.
    link.insertAdjacentHTML("beforeend", PBP_ICONS.extOpen.replace('<svg ', '<svg class="ext-icon" '));
    title.appendChild(link);
  } else {
    title.textContent = label;
  }
  head.appendChild(title);
  if (!hit.row.url) {
    const hint = document.createElement("p");
    hint.className = "notes-unknown-hint";
    hint.textContent = t("notesUnknownHint");
    head.appendChild(hint);
  }
  const meta = document.createElement("p");
  meta.className = "notes-detail-meta";
  const items = [];
  const site = _pbpNotesHostname(hit.row.url);
  if (site) items.push(["notes-meta-site", site]);
  const pageDay = pbpLibFormatDay(hit.row.lastTs);
  if (pageDay) items.push(["notes-meta-day", pageDay]);
  items.push(["notes-meta-pagecount", t("libraryPageCount", String(count))]);
  if (hit.item.side === "tr" && hit.item.lang) items.push(["notes-meta-lang", String(hit.item.lang)]);
  for (const [cls, text] of items) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    meta.appendChild(span);
  }
  head.appendChild(meta);
  return head;
}

// One excerpt's label (spec §5.4): time, then the colour's dot and name; the
// day too when it is not the page's own day. Two spans for day and time so a
// label that does not fit the 96px hang column can stack them
// (_pbpNotesStackLabels). It carries the UI language for hyphens: auto, and
// takes programmatic focus when a same-page jump makes its excerpt current.
function _pbpNotesExcerptLabel(hit, pageTs) {
  const label = document.createElement("h3");
  label.className = "notes-excerpt-label";
  label.tabIndex = -1;
  label.dataset.notesKey = hit.key;
  const lang = _pbpNotesUiLang();
  if (lang) label.lang = lang;
  if (!pbpLibSameDay(hit.ts, pageTs)) {
    const dayText = pbpLibFormatDay(hit.ts);
    if (dayText) {
      const span = document.createElement("span");
      span.className = "notes-excerpt-date";
      span.textContent = dayText;
      label.appendChild(span);
    }
  }
  const timeText = pbpLibFormatTime(hit.ts);
  if (timeText) {
    const span = document.createElement("span");
    span.className = "notes-excerpt-time";
    span.textContent = timeText;
    label.appendChild(span);
  }
  const c = _pbpNotesColorOf(hit.item);
  const color = document.createElement("span");
  color.className = "notes-excerpt-color";
  const dot = document.createElement("span");
  dot.className = "notes-hit-dot notes-c" + c;
  dot.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "notes-excerpt-color-name";
  name.textContent = t(PBP_NOTES_COLOR_KEYS[c - 1]);
  color.append(dot, name);
  label.appendChild(color);
  return label;
}

// One highlight of the page (spec §5.4). The current one is a blockquote; the
// others are buttons that make themselves current. Every quote wears the
// half-height highlighter (.lib-mark) in its own colour; the filter query is
// still marked inside it. A translated-side quote carries its own language.
function _pbpNotesBuildExcerpt(h, index, isCurrent, pageTs, q) {
  const sec = document.createElement("section");
  sec.className = "notes-excerpt";
  sec.dataset.notesKey = h.key;
  if (isCurrent) sec.setAttribute("aria-current", "true");
  const label = _pbpNotesExcerptLabel(h, pageTs);
  label.id = "notes-excerpt-label-" + index;
  sec.setAttribute("aria-labelledby", label.id);
  sec.appendChild(label);
  const body = document.createElement("div");
  body.className = "notes-excerpt-body";
  const mark = document.createElement("span");
  mark.className = "lib-mark notes-c" + _pbpNotesColorOf(h.item);
  _pbpNotesMarkText(mark, typeof h.item.quote === "string" ? h.item.quote : "", q);
  const quoteLang = h.item.side === "tr" && h.item.lang ? String(h.item.lang) : "";
  if (isCurrent) {
    const quote = document.createElement("blockquote");
    quote.className = "notes-excerpt-quote";
    if (quoteLang) quote.lang = quoteLang;
    quote.appendChild(mark);
    body.appendChild(quote);
  } else {
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "notes-excerpt-jump";
    jump.dataset.notesKey = h.key;
    const quote = document.createElement("span");
    quote.className = "notes-excerpt-quote";
    if (quoteLang) quote.lang = quoteLang;
    quote.appendChild(mark);
    jump.appendChild(quote);
    jump.addEventListener("click", () => _pbpNotesJumpTo(h.key));
    body.appendChild(jump);
  }
  const note = typeof h.item.note === "string" ? h.item.note : "";
  if (note.trim()) {
    const p = document.createElement("p");
    p.className = "notes-excerpt-note";
    const ic = document.createElement("span");
    ic.className = "notes-note-ic";
    ic.innerHTML = PBP_ICONS.pencil;
    const text = document.createElement("span");
    text.className = "notes-excerpt-note-text";
    _pbpNotesMarkText(text, note, q);
    p.append(ic, text);
    body.appendChild(p);
  }
  sec.appendChild(body);
  return sec;
}

// The page delete. Scope is the PAGE's record -- the confirm popover names the
// page before anything is removed. notes-detail-delete stays the LAST class:
// the refresh finds a focused detail control again by its last class.
function _pbpNotesBuildDeleteBtn(row) {
  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn btn-sm danger ghost lib-hang-start notes-detail-delete";
  setBtnIcon(del, "trash", t("notesDeleteBtn"));
  del.addEventListener("click", () => _pbpNotesDelete(row, del));
  return del;
}

// "This page" column (spec §5.5), shown from C 1312. Its DOM sits AFTER the
// excerpts -- keyboard and screen-reader order reach the content before the
// destructive action (I12); CSS grid lines put it at the top right.
function _pbpNotesBuildSide(hit, pageHits, pageTs) {
  const side = document.createElement("aside");
  side.className = "notes-page-side";
  side.setAttribute("aria-labelledby", "notes-side-title");
  const title = document.createElement("h3");
  title.id = "notes-side-title";
  title.className = "lib-hang-label notes-side-title lib-first-line";
  title.textContent = t("libraryThisPage");
  side.appendChild(title);
  const href = typeof pbpDictSafeUrl === "function" ? pbpDictSafeUrl(hit.row.url) : "";
  if (href) {
    const open = document.createElement("a");
    open.className = "btn btn-sm notes-open-original";
    open.href = href;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    setBtnIcon(open, "extOpen", t("libraryOpenOriginal"));
    side.appendChild(open);
  }
  const n = pageHits.length;
  const noted = pageHits.filter((h) => typeof h.item.note === "string" && h.item.note.trim()).length;
  // A moment on the page's own day is its time; any other day carries the day.
  const stamp = (ts) => {
    const time = pbpLibFormatTime(ts);
    return pbpLibSameDay(ts, pageTs) ? time : [pbpLibFormatDay(ts), time].filter(Boolean).join(" ");
  };
  const facts = document.createElement("p");
  facts.className = "notes-side-facts";
  const count = document.createElement("span");
  // Each count picks its own singular or plural phrase (pbpLibCountKey).
  count.textContent = noted
    ? t("libraryPageFacts",
      t(pbpLibCountKey(n, "libraryCountHighlightsOne", "libraryCountHighlights"), String(n)),
      t(pbpLibCountKey(noted, "libraryCountNotedOne", "libraryCountNoted"), String(noted)))
    : t(pbpLibCountKey(n, "libraryStatsHighlightsOne", "libraryStatsHighlights"), String(n));
  facts.appendChild(count);
  // A record without any timestamp (never written by the reader, only by a
  // hand-edited backup) has no moment to state: the time line is left out
  // rather than written around an empty value.
  const first = stamp(pageHits[0].ts), last = stamp(pageHits[n - 1].ts);
  if (first && last) {
    const span = document.createElement("span");
    span.textContent = n > 1 ? t("libraryPageSpan", first, last) : t("libraryPageSavedAt", first);
    facts.appendChild(span);
  }
  side.appendChild(facts);
  side.appendChild(_pbpNotesBuildDeleteBtn(hit.row));
  return side;
}

// The cover's statistics sentence (spec §5.7). Empty before the first count;
// a read that fails before any success says so; a later failed read keeps the
// last good sentence (the list's own rule); zero highlights reuse the list's
// three-way empty wording, so owner-hidden highlights are not "none". The
// "pick a highlight" hint shows only beside real counts -- with nothing to
// pick it would point at an empty list (the vocabulary cover's rule, §4.11).
// Numbers are bolded by the sentinel split (library.js), never by markup.
function _pbpNotesRenderCover(failed, all) {
  const lead = $id("notes-cover-lead");
  if (!lead) return;
  const hint = $id("notes-detail-empty") ? $id("notes-detail-empty").querySelector(".lib-cover-hint") : null;
  const say = (text) => { lead.textContent = text; if (hint) hint.hidden = true; };
  if (!_notesScanDone) { say(failed ? _pbpNotesLoadFailedText() : ""); return; }
  if (failed) return;
  const hits = all || _pbpNotesHits();
  if (!hits.length) { say(_notesHiddenByOwner ? t("notesHiddenByOwner") : t("notesEmpty")); return; }
  if (hint) hint.hidden = false;
  const stats = pbpNotesStats(hits, Date.now());
  // Highlights with no time at all (only a hand-edited backup has them) have
  // no "latest" day: the sentence ends after the counts, not "on ." with nothing.
  const day = pbpLibFormatDay(stats.latestTs);
  // Both counts are phrases picked by their own number ("1 highlight from 4
  // pages"); the sentinels pass through the nested t() to be bolded.
  const counts = [String(stats.highlights), String(stats.pages)];
  const sentence = (total, pages, date) => {
    const args = [
      t(pbpLibCountKey(stats.highlights, "libraryCountHighlightsOne", "libraryCountHighlights"), total),
      t(pbpLibCountKey(stats.pages, "libraryCountPagesOne", "libraryCountPages"), pages),
    ];
    return day ? t("libraryNotesCoverLead", ...args, date) : t("libraryNotesCoverLeadNoDate", ...args);
  };
  const parts = pbpLibSplitCount(sentence, day ? [...counts, day] : counts);
  pbpLibFillCount(lead, parts, (index) => (index >= 0 && index < 2 ? "b" : null));
}

// A same-page jump (spec §5.4): the clicked highlight becomes current (list row
// included, when the list filter shows it). The render keeps the pane's scroll
// and brings the new current excerpt into view only as far as needed -- the
// same as a same-page pick from the list; what a jump adds is focus on the new
// label, so a keyboard user lands where the reading continues.
function _pbpNotesJumpTo(key) {
  _pbpNotesSelectRow(key);
  const detail = $id("notes-detail");
  const cur = detail && detail.querySelector(':scope > .notes-excerpt[aria-current="true"]');
  if (cur) _pbpNotesFocus(cur.querySelector(".notes-excerpt-label"));
}

// Hang labels (spec §5.4): in the hang column (C >= 1000, where the excerpt is
// a subgrid) a label gets 96px; one that does not fit on one line stacks day,
// time and colour on their own lines, flush right, still counted as ONE 16px
// line so the quote's row does not grow. If the stack then hangs past the
// excerpt's own bottom, the excerpt gets a min-height so the next one still
// starts 32px below the label's last line. Measured after every render and,
// coalesced to one frame, on resize and on a density / theme flip.
// The results are a class and a custom property (--notes-hang-min), never an
// inline layout value: library.css applies both only inside the C >= 1000
// tier, so whatever a narrower width meets before the next measurement --
// one frame after a resize, or for good when nothing re-measures -- is inert
// (T8f; ui-contract's measured-layout gate).
// Batched so the whole page costs two layouts, not one per excerpt: clear
// every label, read every fit, write every stack; then read every overhang
// (which needs the stacked layout) and write every min-height.
function _pbpNotesStackLabels(detail) {
  const host = detail || $id("notes-detail");
  if (!host || host.hidden) return;
  // Not rendered (the vocabulary view is on screen, so an ancestor is
  // display:none): every width below would read 0 and the verdicts would be
  // wrong. Keep the last ones; the detail's ResizeObserver re-measures when
  // the view comes back.
  if (!host.getClientRects().length) return;
  const rows = [];
  for (const ex of host.querySelectorAll(":scope > .notes-excerpt")) {
    const label = ex.querySelector(":scope > .notes-excerpt-label");
    if (!label) continue;
    label.classList.remove("is-stacked");
    ex.style.removeProperty("--notes-hang-min");
    rows.push({ ex, label });
  }
  const stacked = rows.filter(({ ex, label }) => {
    if (getComputedStyle(ex).display !== "grid") return false; // label above its quote: never stacks
    // The same comparison flex-wrap makes for the unmeasured label (parts +
    // gaps against the content box), on the same unrounded layout values --
    // clientWidth rounds, and any slack here would leave a label CSS has
    // already wrapped onto two lines (8px apart) unstacked.
    const cs = getComputedStyle(label);
    const room = label.getBoundingClientRect().width - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) -
      (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0);
    const parts = [...label.children];
    const gap = parseFloat(cs.columnGap) || 0;
    const need = parts.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0) + gap * Math.max(0, parts.length - 1);
    return need > room;
  });
  for (const { label } of stacked) label.classList.add("is-stacked");
  const heights = stacked.map(({ ex, label }) => {
    const inkBottom = Math.max(...[...label.children].flatMap((el) => [...el.getClientRects()].map((r) => r.bottom)));
    const exRect = ex.getBoundingClientRect();
    const overhang = inkBottom - exRect.bottom;
    return overhang > 0.5 ? Math.ceil(exRect.height + overhang) : 0;
  });
  stacked.forEach(({ ex }, i) => { if (heights[i]) ex.style.setProperty("--notes-hang-min", heights[i] + "px"); });
}

let _notesStackFrame = 0;
function _pbpNotesScheduleStack() {
  if (_notesStackFrame) return;
  _notesStackFrame = requestAnimationFrame(() => {
    _notesStackFrame = 0;
    _pbpNotesStackLabels();
  });
}

// Reading pane for one PAGE, opened at one of its highlights (spec 2026-10-03-
// library-redesign §5), or the cover for null (nothing selected, selection
// deleted, back button). `enterNarrow` is opt-in exactly as in
// library-vocab.js: only a user activation may swap narrow mode from the list
// to the detail, so a background refresh never yanks a narrow reader.
function _pbpNotesRenderDetail(hit, enterNarrow) {
  const empty = $id("notes-detail-empty");
  const detail = $id("notes-detail");
  if (!empty || !detail) return;
  empty.hidden = !!hit;
  detail.hidden = !hit;
  if (!hit) {
    _pbpNotesSelectedKey = null;
    _notesRenderedPageKey = null;
    _notesRenderedDetailKey = null;
    document.body.classList.remove("lib-narrow-notes");
    detail.replaceChildren();
    detail.style.removeProperty("--notes-rows");
    _pbpNotesMarkCurrentRow();
    return;
  }
  const samePage = hit.row.key === _notesRenderedPageKey;
  const sameHit = samePage && hit.key === _notesRenderedDetailKey;
  if (enterNarrow) document.body.classList.add("lib-narrow-notes");

  const q = _pbpNotesFilterQuery();
  const found = _pbpNotesPageHits(hit.row.key);
  const pageHits = found.some((h) => h.key === hit.key) ? found : [hit];
  const pageTs = hit.row.lastTs;
  const frag = document.createDocumentFragment();
  // 0. Back button (narrow mode only -- CSS decides, see .notes-detail-back)
  frag.appendChild(_pbpNotesBuildBackBtn());
  // 1. Page head: title, (hint,) meta
  frag.appendChild(_pbpNotesBuildHead(hit, pageHits.length));
  // 2. Every highlight of the page, oldest first; the opened one is current
  pageHits.forEach((h, i) => frag.appendChild(_pbpNotesBuildExcerpt(h, i, h.key === hit.key, pageTs, q)));
  // 3. "This page" column (C >= 1312; CSS places it, DOM keeps it last but one)
  frag.appendChild(_pbpNotesBuildSide(hit, pageHits, pageTs));
  // 4. Closing row (shown below C 1312): the page delete, hanging at the main column's start
  const footer = document.createElement("div");
  footer.className = "notes-detail-footer";
  footer.appendChild(_pbpNotesBuildDeleteBtn(hit.row));
  frag.appendChild(footer);

  // The column spans every row of the sheet: head + excerpts + footer.
  detail.style.setProperty("--notes-rows", String(pageHits.length + 2));
  detail.replaceChildren(frag);
  if (enterNarrow) _pbpNotesFocusNarrowBack(detail);
  // Labels first: a stacked label's min-height moves every excerpt below it,
  // and the scroll decisions below must see the final layout.
  _pbpNotesStackLabels(detail);
  // The scroll container is the PANE, not this div: replaceChildren is one
  // atomic mutation and keeps the previous scrollTop. Reset it only when the
  // PAGE changed. Another highlight of the same page -- picked in the list or
  // by a jump button -- keeps the reader's place and only nudges the new
  // current excerpt into view; a refresh of the same highlight moves nothing.
  const pane = $id("notes-detail-pane");
  if (pane && !samePage) pane.scrollTop = 0;
  else if (!sameHit) {
    const cur = detail.querySelector(':scope > .notes-excerpt[aria-current="true"]');
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }
  _notesRenderedPageKey = hit.row.key;
  _notesRenderedDetailKey = hit.key;
}

// Focus inside the detail, captured before a rebuild and put back after it
// (a refresh, a language switch). A control is found again by its last class
// -- the layout-only is-stacked never counts, it comes and goes with a
// measurement -- plus, for an excerpt control, its highlight key: every jump
// button shares one class, and "the first one" is the wrong excerpt (spec
// §5.1). null when focus is not in the detail.
function _pbpNotesDetailFocusSnapshot() {
  const active = document.activeElement;
  if (!active || !active.closest || !active.closest("#notes-detail")) return null;
  const classes = [...active.classList].filter((c) => c !== "is-stacked");
  if (!classes.length) return null;
  return { cls: classes[classes.length - 1], key: (active.dataset && active.dataset.notesKey) || null };
}

// The equivalent control in the rebuilt detail, else the back button -- which
// is the one control that always exists and, in narrow mode, the only way
// back to the list. Several matches are possible (two page deletes, only one
// displayed): _pbpNotesFocus reports a focus that did not take, so they are
// tried in order and a control the rebuild dropped falls through.
function _pbpNotesRestoreDetailFocus(snap) {
  if (!snap) return;
  const host = $id("notes-detail");
  if (!host || host.hidden) return;
  const sel = "." + CSS.escape(snap.cls) + (snap.key ? '[data-notes-key="' + CSS.escape(snap.key) + '"]' : "");
  if (![...host.querySelectorAll(sel)].some((el) => _pbpNotesFocus(el))) _pbpNotesFocus(host.querySelector(".notes-detail-back"));
}

// Same guard the two failure sentences above use: t() echoes an unknown key
// straight back to the screen, and this one lands in a live region.
const PBP_NOTES_RESULT_COUNT_KEY = "notesResultCount";
function _pbpNotesResultCountText(visible, total) {
  const msg = t(PBP_NOTES_RESULT_COUNT_KEY,
    t(pbpLibCountKey(visible, "notesResultShownOne", "notesResultShown"), String(visible)),
    t(pbpLibCountKey(total, "libraryCountHighlightsOne", "libraryCountHighlights"), String(total)));
  return msg === PBP_NOTES_RESULT_COUNT_KEY
    ? String(visible) + " shown · " + String(total) + " highlights"
    : msg;
}

// The count row (spec §3.5): "N highlights · N pages · +N in 7 days", the
// first item becoming "shown / total" while a filter or colour narrows the
// list. The full sentence keeps notesResultCount for the live region.
function _pbpNotesRenderToolbar(total, visible, allHits) {
  const count = $id("notes-count");
  if (!count) return;
  if (!total) { pbpLibRenderCount(count, [], ""); return; }
  const s = pbpNotesStats(allHits || _pbpNotesHits(), Date.now());
  // Singular or plural from the real number; "shown / total" reads with the
  // total's noun.
  const items = [
    visible !== total
      ? pbpLibSplitCount((...a) => t(pbpLibCountKey(total, "libraryStatsHighlightsFilteredOne", "libraryStatsHighlightsFiltered"), ...a), [String(visible), String(total)])
      : pbpLibSplitCount((...a) => t(pbpLibCountKey(total, "libraryStatsHighlightsOne", "libraryStatsHighlights"), ...a), [String(total)]),
    pbpLibSplitCount((...a) => t(pbpLibCountKey(s.pages, "libraryStatsPagesOne", "libraryStatsPages"), ...a), [String(s.pages)]),
    pbpLibSplitCount((...a) => t("libraryStatsRecent7", ...a), [String(s.added7)]),
  ];
  const full = [_pbpNotesResultCountText(visible, total), t("libraryStatsRecent", String(s.added7), String(s.added30))].join(" \u00b7 ");
  pbpLibRenderCount(count, items, full);
}

function _pbpNotesBuildColorFilters() {
  const wrap = $id("notes-color-filters");
  if (!wrap || wrap.dataset.ready) return;
  wrap.dataset.ready = "1";
  const all = document.createElement("button");
  all.type = "button";
  all.className = "lib-toggle sm";
  all.dataset.color = "all";
  all.setAttribute("aria-pressed", "true");
  all.textContent = t("libraryFilterAll");
  all.addEventListener("click", () => _pbpNotesApplyColor("all"));
  wrap.appendChild(all);
  PBP_NOTES_COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lib-toggle sm";
    b.dataset.color = String(c);
    b.setAttribute("aria-pressed", "false");
    // Named from birth (the colour alone); _pbpNotesSyncColorFilters adds the
    // count. An icon-only toggle must never exist without a name, not even
    // between this build and the first count.
    const name = t(PBP_NOTES_COLOR_KEYS[c - 1]);
    b.title = name;
    b.setAttribute("aria-label", name);
    const dot = document.createElement("span");
    dot.className = "notes-hit-dot notes-c" + c;
    dot.setAttribute("aria-hidden", "true");
    const num = document.createElement("span");
    num.className = "lib-toggle-count";
    b.append(dot, num);
    b.addEventListener("click", () => _pbpNotesApplyColor(c));
    wrap.appendChild(b);
  });
}

// A colour filter is a filter: it clears the batch selection, starts the list
// back at the first batch and at its top (spec §2.5 row 1).
function _pbpNotesApplyColor(color) {
  _notesActiveColors = pbpNotesToggleColor(_notesActiveColors, color);
  _pbpNotesClearSelection();
  _pbpNotesResetListScroll();
  _pbpNotesRender(true);
}

// Counts per colour over every hit of this account (not the filtered view),
// plus each toggle's pressed state; title = aria-label = "Quote, 3
// highlights" (spec §3.2, §11 V22).
function _pbpNotesSyncColorFilters(allHits) {
  const wrap = $id("notes-color-filters");
  if (!wrap) return;
  // `hidden` in the markup until there are counts to show (the vocabulary
  // status toggles' rule): no cold frame of six empty toggles.
  wrap.hidden = !(allHits && allHits.length);
  const counts = new Map(PBP_NOTES_COLORS.map((c) => [c, 0]));
  for (const hit of allHits || []) {
    const c = _pbpNotesColorOf(hit.item);
    counts.set(c, counts.get(c) + 1);
  }
  for (const b of wrap.querySelectorAll(".lib-toggle")) {
    if (b.dataset.color === "all") {
      b.textContent = t("libraryFilterAll");
      b.setAttribute("aria-pressed", String(_notesActiveColors.size === 0));
      continue;
    }
    const c = Number(b.dataset.color);
    const n = counts.get(c) || 0;
    const label = t(pbpLibCountKey(n, "libraryColorFilterAriaOne", "libraryColorFilterAria"), t(PBP_NOTES_COLOR_KEYS[c - 1]), String(n));
    b.title = label;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-pressed", String(_notesActiveColors.has(c)));
    const num = b.querySelector(".lib-toggle-count");
    if (num) num.textContent = String(n);
  }
}

// Filters change WHICH rows exist, so the list starts again from its first
// row (library redesign §2.5 #1). Only the two user inputs call this; a
// refresh keeps the user's place (_pbpNotesRefreshPreservingState).
function _pbpNotesResetListScroll() {
  const region = document.querySelector(".notes-list-region");
  if (region) region.scrollTop = 0;
}

// One flatten+sort per render. _pbpNotesHits() rebuilds and re-sorts every
// highlight of every page, and a render used to call it three times over: the
// caller's visible set, this list's total and the selection sync's own visible
// set -- all of it on every keystroke in the filter box, which is not debounced
// (the vocabulary list is not either; the render cap is what makes that
// affordable). Route renders through here so the three share one array.
function _pbpNotesRender(resetLimit) {
  if (resetLimit) _notesRenderLimit = PBP_NOTES_RENDER_BATCH;
  const all = _pbpNotesHits();
  _pbpNotesRenderList(_pbpNotesVisibleHits(all), all);
}

// Load more, the vocabulary list's control in the notes list's region: same
// .btn.btn-sm family, the same .vocab-load-more geometry and the same locale
// key (its wording never mentions words, so nothing here is borrowed copy).
// Built in JS rather than in library.html for one reason: the rule that beats
// the .btn `display` for a hidden control is scoped to #view-vocab, so this
// button LEAVES the DOM when there is nothing left to load instead of relying
// on an `hidden` attribute that would not reach this view.
function _pbpNotesSyncLoadMore(remaining) {
  const list = $id("notes-list");
  const existing = $id("notes-load-more");
  if (!list || remaining <= 0) {
    if (existing) existing.remove();
    return;
  }
  const more = existing || document.createElement("button");
  if (!existing) {
    more.type = "button";
    more.id = "notes-load-more";
    more.className = "btn btn-sm ghost vocab-load-more";
    more.addEventListener("click", _pbpNotesLoadMore);
  }
  const next = Math.min(PBP_NOTES_RENDER_BATCH, remaining);
  more.textContent = t(pbpLibCountKey(next, "vocabLoadMoreOne", "vocabLoadMore"), String(next));
  // Sibling of the list, never a child: #notes-list is role="grid" and takes
  // rows only (same placement #notes-empty already has).
  if (more.previousElementSibling !== list) list.after(more);
}

function _pbpNotesLoadMore() {
  const list = $id("notes-list");
  const appendedAt = list ? list.children.length : 0;
  const all = _pbpNotesHits();
  const hits = _pbpNotesVisibleHits(all);
  _notesRenderLimit = Math.min(hits.length, _notesRenderLimit + PBP_NOTES_RENDER_BATCH);
  _pbpNotesRenderList(hits, all, true);
  // The LAST click removes the button it came from, and Chrome then drops
  // focus on <body> -- with no skip link on this page the way on is a full Tab
  // walk from the header. Hand it to the first row this click appended, and
  // move the roving stop with it or the list would answer the next Tab from an
  // older row. Twin of the vocabulary list's own load-more handover.
  if ($id("notes-load-more")) return;
  const appended = list && list.children[appendedAt];
  const btn = appended ? appended.querySelector(".notes-hit-btn") : null;
  // Nothing appended (a re-render raced this click): the filter box is the
  // landing spot every other path in this file falls back to.
  if (!btn) { _pbpNotesFocus($id("notes-filter")); return; }
  _pbpNotesSetRowTabStop(btn);
  _pbpNotesFocus(btn);
}

// `allHits` is the unfiltered flatten this render already paid for; `append`
// grows the rendered slice in place (a full rebuild would empty the scroll
// container and snap the reader back to the top of the list).
function _pbpNotesRenderList(hits, allHits, append) {
  const list = $id("notes-list");
  if (!list) return;
  const all = allHits || _pbpNotesHits();
  const total = all.length;
  _pbpNotesRenderToolbar(total, hits.length, all);
  _pbpNotesRenderCover(false, all);
  _pbpNotesSyncColorFilters(all);
  if (!append) list.replaceChildren();
  // The empty state is a SIBLING of the list, never a child: #notes-list is
  // role="grid", whose only valid children are rows (same placement the
  // vocabulary view uses for #vocab-empty / #vocab-no-results).
  const empty = $id("notes-empty");
  if (empty) {
    empty.hidden = hits.length > 0;
    // Three states, not two: a filter narrowed a non-empty list to nothing
    // (notesFilterEmpty), this account genuinely has never highlighted
    // anything (notesEmpty), or the last successful scan found highlights
    // but the owner filter hid every one of them (notesHiddenByOwner) --
    // that third case is NOT "you have no highlights", and saying so points
    // the reader at the reader instead of at the account switcher. Hangs off
    // `total === 0`, same guard as the sentence below, so it can only fire on
    // a scan that actually completed (a failed read never reaches this
    // render at all -- renderNotesPanel bails out on `null` first).
    if (!hits.length) {
      empty.textContent = total
        ? t("notesFilterEmpty")
        : (_notesHiddenByOwner ? t("notesHiddenByOwner") : t("notesEmpty"));
    }
  }
  // Storage scope, only when there is nothing at all to show: with a filter
  // active the user plainly has highlights, and the sentence would be noise.
  // Also suppressed when every highlight is merely hidden by the owner
  // filter -- "export a backup to move them" is exactly the wrong advice
  // when the data is sitting right there under a different account.
  const scopeNote = $id("notes-scope-note");
  if (scopeNote) scopeNote.hidden = !!total || hits.length > 0 || _notesHiddenByOwner;
  if (!hits.length) { _pbpNotesSyncLoadMore(0); _pbpNotesSyncSelectionUi(hits); return; }
  const target = Math.min(hits.length, _notesRenderLimit);
  const start = append ? Math.min(list.children.length, target) : 0;
  const frag = document.createDocumentFragment();
  for (let i = start; i < target; i++) frag.appendChild(_pbpNotesBuildRow(hits[i]));
  list.appendChild(frag);
  _pbpNotesSyncLoadMore(hits.length - target);
  // A rebuild drops the marker even though the detail pane still reads that
  // highlight -- re-derive it from the surviving selection key.
  _pbpNotesMarkCurrentRow();
  // Same for the batch selection: rows are rebuilt from _notesSelected, and
  // this prunes whatever the fresh view no longer contains.
  _pbpNotesSyncSelectionUi(hits);
  _pbpNotesSyncRowTabStops();
}

// Where the status sentence lives. Two things make this a lookup rather than
// a constant selector:
//
// 1. The class is not unique to this view. #view-vocab opens with a
//    `<div class="notes-toolbar vocab-filter-toolbar">` of its own, EARLIER in
//    document order, so an unscoped `document.querySelector(".notes-toolbar")`
//    parked every notes message inside the vocabulary search row -- invisible
//    while Notes is up (the whole view is `hidden`), unannounced (a live
//    region in a display:none subtree says nothing), and then surfacing as a
//    stale sentence next to #vocab-search on the way back.
// 2. Below the two-pane threshold this view shows the list OR the detail, and
//    the hidden half is `display: none` (`body.lib-narrow-notes
//    .notes-list-pane`). The count row is the right home whenever it is on
//    the page -- it is also the ONLY home for batch failures, since clearing
//    the selection collapses the batch bar to height 0 and takes the button
//    that was pressed with it -- but when the list pane is gone the detail's
//    own action row is what the user is looking at.
function _pbpNotesStatusHost() {
  const view = $id("view-notes");
  if (!view) return null;
  // Tier 1 (spec §4.7): a selection is up and the batch row is on the page.
  const batch = $id("notes-batch-toolbar");
  if (batch && batch.classList.contains("selecting") && batch.offsetParent) {
    const slot = batch.querySelector(".lib-batch-status");
    if (slot) return slot;
  }
  const bar = $id("notes-context-bar");
  // offsetParent is null exactly for a display:none subtree here (nothing in
  // this view is position:fixed).
  if (bar && bar.offsetParent) return bar;
  // Last tier (spec §5.1): beside the ONE page delete that is displayed --
  // the "this page" column from C 1312, the footer below that.
  const shownDelete = [...view.querySelectorAll("#notes-detail .notes-detail-delete")].find((b) => b.offsetParent !== null);
  if (shownDelete) return shownDelete.parentElement;
  return view.querySelector(".notes-detail-footer") || bar;
}

// Delete failures used to be colour only: a red edge on the row, or on the
// button, with no words. Colour alone cannot say what failed or what to do
// next, and it says nothing at all to a screen reader. This is the live
// region that carries the sentence -- created once, empty, next to the list's
// other counters, so it is already in the accessibility tree when text lands
// in it (.save-status:empty collapses it the rest of the time). Reuses an
// element from the markup if one with this id is ever added there.
function _pbpNotesStatusEl() {
  const host = _pbpNotesStatusHost();
  if (!host) return null;
  const existing = $id("notes-status");
  // Move the same node rather than build a second one: one id, one live
  // region. Callers reposition it while CLEARING (before the await that may
  // fail), never in the tick the sentence is written, so the region is always
  // settled in the accessibility tree by the time text lands in it.
  if (existing) {
    if (existing.parentNode !== host) host.appendChild(existing);
    return existing;
  }
  const el = document.createElement("span");
  el.id = "notes-status";
  el.className = "save-status notes-main-status";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  host.appendChild(el);
  return el;
}

// `notesDeleteFailed` now ships in all nine locales, so t() answers with real
// copy. The English fallback stays as a guard, not a placeholder: t() echoes
// an UNKNOWN key straight back to the screen, so if a locale file ever loses
// this entry the user would read the key name instead of a sentence.
const PBP_NOTES_DELETE_FAILED_KEY = "notesDeleteFailed";

// True only while the read-failure sentence is the thing currently in the live
// region. renderNotesPanel retires its OWN sentence on the next successful
// read and must retire nothing else: the batch delete writes its failure text
// after re-rendering, and the 250ms pbp_hl_ debounce re-scans behind it.
let _notesLoadFailed = false;

function _pbpNotesSetStatus(text) {
  const el = _pbpNotesStatusEl();
  if (!el) return;
  // The flag follows the DOM: this write replaces whatever the region held,
  // so whoever wrote it now owns the sentence.
  _notesLoadFailed = false;
  if (!text) { el.classList.remove("ok", "bad"); el.textContent = ""; return; }
  setStatusIcon(el, false, text);
}

function _pbpNotesDeleteFailedText() {
  const msg = t(PBP_NOTES_DELETE_FAILED_KEY);
  return msg === PBP_NOTES_DELETE_FAILED_KEY ? "Couldn't delete these highlights. Try again." : msg;
}

// Same guard, same reason, for the read side: t() echoes an unknown key
// straight back to the screen.
const PBP_NOTES_LOAD_FAILED_KEY = "notesLoadFailed";
function _pbpNotesLoadFailedText() {
  const msg = t(PBP_NOTES_LOAD_FAILED_KEY);
  return msg === PBP_NOTES_LOAD_FAILED_KEY ? "Couldn't read your saved highlights. Try again." : msg;
}

// This page is not the only writer of a pbp_hl_<page> record: the reader
// (md-highlight.js) rewrites the same key from its own tab, options-backup.js
// rewrites it on backup restore, and chrome.storage has no compare-and-swap --
// get and set are two independent trips. Re-reading immediately before the
// rewrite (below) narrows the lost-update window but cannot close it: both
// contexts can read the same base and the later set wins. Web Locks are
// origin-scoped, so library.html, every reader tab and the MV3 worker queue
// on one name. That name is the contract with md-highlight.js's
// _pbpHlLockName and options-backup.js's pbpBackupHighlightLockName --
// "pbp-hl:" + the storage key, per record so one page's delete never blocks
// another's. A fourth producer exists too: background.js's
// pbpClaimLegacyHighlightOwners() one-shot legacy-owner migration writes the
// same "pbp-hl:" + key inline; it is scheduled to retire by 2026-12-31
// (CLAUDE.md 临时事项) and must match until then. The helper is deliberately
// duplicated rather than hoisted into shared.js: these are isolated script
// contexts and the shared thing is the string, not the function.
const PBP_NOTES_RECORD_LOCK_PREFIX = "pbp-hl:";
function _pbpNotesRecordLockName(key) { return PBP_NOTES_RECORD_LOCK_PREFIX + key; }

let _pbpNotesLockWarned = false;
function _pbpNotesWithRecordLock(key, work) {
  const locks = typeof navigator !== "undefined" && navigator.locks;
  if (locks && typeof locks.request === "function") return locks.request(_pbpNotesRecordLockName(key), work);
  if (!_pbpNotesLockWarned) {
    _pbpNotesLockWarned = true;
    console.warn("[notes] Web Locks unavailable: highlight deletes are not serialised against the reader");
  }
  return Promise.resolve().then(work);
}

// Same anchored confirm popover as every other destructive micro-action
// (theme delete, tab reset, offline-queue remove) — never window.confirm.
// showConfirmPopover lives in shared.js, which the standalone test page does
// not load; that is fine because the tests exercise only the pure layer and
// never invoke this handler.
function _pbpNotesDelete(row, anchor) {
  const label = row.title || row.url || t("notesUnknownPage");
  // The account whose rows this popover was opened over. The popover is a
  // body child dismissed only by Escape / an outside pointerdown / scroll / an
  // answer, so an account switch (another tab, or another device through sync)
  // leaves it on screen while _notesOwnerCache is invalidated underneath it --
  // and the delete below resolves the owner again when it is answered.
  const ownerAtOpen = _notesOwnerCache;
  showConfirmPopover(anchor, {
    msg: t("notesDeleteConfirm", label),
    yesText: t("delete"),
    noText: t("cancel"),
    onConfirm: async () => {
      // Where the selected row sat, so focus can land on its successor once
      // the list is rebuilt (the confirm popover restored focus to the delete
      // button, which the rebuild removes -- otherwise focus falls to <body>).
      const position = Math.max(0, _pbpNotesVisibleHits().findIndex((h) => h.key === _pbpNotesSelectedKey));
      // A retry starts clean: the previous attempt's marks and sentence must
      // not read as if they described this one.
      _pbpNotesSetStatus("");
      if (anchor) anchor.classList.remove("is-error");
      const priorErr = _pbpNotesRowEl(_pbpNotesSelectedKey);
      if (priorErr) priorErr.classList.remove("is-error");
      try {
        // Read AND rewrite inside the record's lock, byte-for-byte the batch
        // delete's shape below, and for the same two reasons. The lock stops
        // a reader tab from committing between this get and this set (its own
        // set would otherwise re-create the record the user just deleted).
        // The filter is what makes "this page's highlights" mean THIS
        // account's: one pbp_hl_ record holds every account's items for that
        // page, the list and the confirm sentence both counted only the ones
        // _pbpNotesItemVisible admits, and highlights have no tombstone and no
        // undo -- so the key itself goes only once nothing is left.
        const owner = await _pbpNotesOwner();
        if (owner !== ownerAtOpen) {
          // The account changed while the confirm was open, so this filter
          // would now match the NEW account's items on that page -- items the
          // sentence the user read never counted. Same guard, same wording, as
          // the batch delete's snapshot mismatch below: nothing was deleted.
          // (`null` at open = the owner was never resolved, so a match cannot
          // be proven either; fail closed.)
          _pbpNotesSetStatus(t("vocabSelectionChanged"));
          return;
        }
        await _pbpNotesWithRecordLock(row.key, async () => {
          const fresh = (await chrome.storage.local.get(row.key))[row.key];
          // Gone already (deleted elsewhere while the confirm was open):
          // nothing to remove, and re-creating it would be worse.
          if (!fresh) return;
          const items = Array.isArray(fresh.items) ? fresh.items : [];
          const keep = items.filter((it) => !_pbpNotesItemVisible(it, owner));
          if (keep.length === items.length) return;
          if (keep.length) await chrome.storage.local.set({ [row.key]: { ...fresh, items: keep } });
          else await chrome.storage.local.remove(row.key);
        });
      } catch (e) {
        // A swallowed failure looked identical to success (popover closed,
        // row still there, zero feedback). Pin it to the row it happened on
        // and leave a trace -- name/message only, never note content.
        console.warn("[notes] delete failed", e && e.name, e && e.message);
        const rowEl = _pbpNotesRowEl(_pbpNotesSelectedKey);
        // The row can be filtered out (or scrolled away) while its detail is
        // open, and a signal nobody can see is no signal -- fall back to the
        // button the user actually pressed.
        if (rowEl) rowEl.classList.add("is-error");
        else if (anchor) anchor.classList.add("is-error");
        // ...and colour is not a message: say what happened, in the live
        // region, in words. Nothing was removed and nothing was rebuilt, so
        // the record is intact and the confirm popover's focus restore has
        // already put the caret back on the Delete button -- pressing it
        // again is the retry.
        _pbpNotesSetStatus(_pbpNotesDeleteFailedText());
        return;
      }
      _notesAllRows = _notesAllRows.filter((e) => e.row.key !== row.key);
      // The detail was reading one of the highlights that just went away.
      if (_pbpNotesSelectedKey && _pbpNotesSelectedKey.startsWith(row.key + "#")) _pbpNotesRenderDetail(null);
      // Render depth survives a delete: a mutation is not a filter change, and
      // collapsing the list back to the first batch under the user is not what
      // pressing Delete asked for.
      _pbpNotesRender();
      _pbpNotesFocusAfterDelete(position);
    },
  });
}

// Batch delete over the SELECTED HIGHLIGHTS, which is not the same scope as
// the detail pane's delete (that one removes the whole page record, and says
// so). Storage still holds one pbp_hl_<page> entry with an items[] array, so
// removing highlights means rewriting that array and dropping the key only
// once nothing is left -- byte-for-byte the shape the reader's own
// per-highlight delete writes (_pbpHlSave in md-highlight.js).
//
// The set is re-derived from _notesSelected INSIDE onConfirm and compared
// against the snapshot taken when the popover opened: a background refresh
// (highlights are written by the reader in another tab) can move the list
// while the confirm is on screen, and deleting a different set than the one
// the message counted is the failure mode worth a guard.
function _pbpNotesBatchDelete() {
  const button = $id("notes-batch-delete");
  if (!button || button.disabled || _notesBatchBusy || !_notesSelected.size) return;
  const snapshot = [..._notesSelected];
  showConfirmPopover(button, {
    msg: t(pbpLibCountKey(snapshot.length, "notesBatchDeleteConfirmOne", "notesBatchDeleteConfirm"), String(snapshot.length)),
    yesText: t("delete"),
    noText: t("cancel"),
    onConfirm: async () => {
      if (_notesBatchBusy) return;
      // A retry starts clean, same rule as the single-row delete: the previous
      // attempt's mark and sentence must not read as if they described this
      // one. Clearing here also settles the live region into the DOM before
      // the awaits below, so anything written later is an update to a region
      // the screen reader is already watching.
      button.classList.remove("is-error");
      _pbpNotesSetStatus("");
      const now = _notesSelected;
      if (now.size !== snapshot.length || !snapshot.every((k) => now.has(k))) {
        // Nothing was deleted, and the confirm counted a set that no longer
        // exists. A red edge cannot say that; borrow the sentence the
        // vocabulary list already ships for this exact guard (view-neutral
        // wording, already in all nine locales).
        button.classList.add("is-error");
        _pbpNotesSetStatus(t("vocabSelectionChanged"));
        return;
      }
      _notesBatchBusy = true;
      _pbpNotesSyncSelectionUi();
      const drop = new Set(snapshot);
      let failed = 0;
      try {
        for (const { row } of _notesAllRows) {
          // Pages this batch does not touch cost nothing: hit keys are
          // `${row.key}#${id}`, so the selection already says which records
          // will change. Reading (and locking) every other record just to
          // filter it unchanged is work taken for nothing -- and a lock held
          // for nothing is a reader tab blocked for nothing.
          const prefix = row.key + "#";
          if (!snapshot.some((k) => k.startsWith(prefix))) continue;
          try {
            // Read AND rewrite inside the record's lock. The re-read alone
            // (the scan snapshot `rec` can be seconds old by the time a
            // confirm is answered, and the reader writes these records from
            // another tab) only narrows the lost-update window; the lock is
            // what stops the reader from committing between this get and this
            // set. Per record, inside the loop, on purpose: one page's write
            // must neither be based on a read taken before another page's
            // write nor hold another page's lock while it happens.
            await _pbpNotesWithRecordLock(row.key, async () => {
              const fresh = (await chrome.storage.local.get(row.key))[row.key];
              // Gone already (deleted elsewhere while the confirm was open):
              // nothing to remove, and re-creating it would be worse.
              if (!fresh) return;
              const items = Array.isArray(fresh.items) ? fresh.items : [];
              // ponytail: _pbpNotesHitKey falls back to the array index for
              // legacy items with no `id`, so on such a record a concurrent
              // insertion could shift which item a key names. Every item the
              // reader writes carries an id; upgrade path is an id backfill in
              // md-highlight.js, not more logic here.
              const keep = items.filter((it, idx) => !drop.has(_pbpNotesHitKey(row.key, it, idx)));
              if (keep.length === items.length) return;
              if (keep.length) await chrome.storage.local.set({ [row.key]: { ...fresh, items: keep } });
              else await chrome.storage.local.remove(row.key);
            });
          } catch (e) {
            // Name/message only, never highlight or note content.
            console.warn("[notes] batch delete failed", e && e.name, e && e.message);
            failed++;
          }
        }
      } finally {
        _notesBatchBusy = false;
      }
      _pbpNotesClearSelection();
      // The detail may have been reading one of the highlights just removed.
      const stillThere = _pbpNotesSelectedKey && drop.has(_pbpNotesSelectedKey);
      await renderNotesPanel();
      if (stillThere || !_pbpNotesFindHit(_pbpNotesSelectedKey)) _pbpNotesRenderDetail(null);
      // A swallowed failure looks exactly like success (popover closed, rows
      // still there, no feedback). The mark still goes on the button that was
      // pressed, but it cannot be the only signal: _pbpNotesClearSelection()
      // above just dropped `.selecting` from the batch row, which is then
      // display:none -- that button is off the screen by the time this runs. The sentence in the list toolbar's live region is
      // what the user, and the screen reader, actually get.
      if (failed) {
        button.classList.add("is-error");
        _pbpNotesSetStatus(_pbpNotesDeleteFailedText());
      }
      _pbpNotesFocusAfterDelete(0);
    },
  });
}

// Nearest surviving row, else the filter input -- the vocabulary list's
// _pbpVocabFocusStable with one extra step, because notes rows are the only
// thing between the toolbar and the bottom of the pane.
function _pbpNotesFocusAfterDelete(position) {
  const list = $id("notes-list");
  const rows = list ? [...list.querySelectorAll(".notes-hit-btn")] : [];
  const target = rows.length ? rows[Math.min(position, rows.length - 1)] : $id("notes-filter");
  if (!target || target.closest("[hidden], [inert]")) return;
  _pbpNotesFocus(target);
}

// Called from the pbp-lib-view mount below on every "notes" view activation.
// Re-scans storage every activation (no "already inited" guard), matching
// renderStoragePanel()'s convention.
// Resolves true when this call's scan is still the latest one, false when a
// newer scan or an account switch superseded it while it was reading (its
// result is then dropped -- see _notesRenderGen).
async function renderNotesPanel() {
  const list = $id("notes-list");
  if (!list) return false;
  const gen = ++_notesRenderGen;
  _pbpNotesBuildColorFilters();
  // The scan is a real storage round trip (getKeys + get over every pbp_hl_
  // record), and until it lands this grid is empty -- indistinguishable from
  // "this account has nothing saved" to anything reading the accessibility
  // tree. #vocab-list has reported aria-busy through its own load since
  // _pbpVocabSetLoading shipped; this is the same contract on its twin.
  // Cleared in `finally`: an account switch re-enters this function through
  // the onChanged path, and a busy grid left behind by a failed read would
  // never say it had stopped loading.
  list.setAttribute("aria-busy", "true");
  let rows;
  try {
    rows = await _pbpNotesScan();
  } finally {
    // A superseded scan leaves the busy flag to the scan that replaced it.
    if (gen === _notesRenderGen) list.setAttribute("aria-busy", "false");
  }
  if (gen !== _notesRenderGen) return false;
  if (!rows) {
    // The read failed (null, not an empty array). Rendering the empty result
    // here would write "select text on a preview page to highlight it" over a
    // storage error -- pixel-identical to having lost every highlight, with
    // nothing to retry. Say the read failed instead and leave whatever was
    // already on screen alone; the next activation, visibilitychange or
    // pbp_hl_ write re-scans. Same call the vocabulary list makes for the
    // same situation, through this view's own live region.
    _pbpNotesSetStatus(_pbpNotesLoadFailedText());
    _notesLoadFailed = true;
    _pbpNotesRenderCover(true);
    return true;
  }
  // The read worked. Nothing else ever clears that sentence, so without this
  // one transient failure leaves "couldn't read your saved highlights" sitting
  // over a fully rendered list for the rest of the page's life, and the screen
  // reader is never told the failure is over. Only ours -- see _notesLoadFailed.
  if (_notesLoadFailed) _pbpNotesSetStatus("");
  _notesScanDone = true;
  _notesAllRows = rows;
  // No limit reset: a rescan is a refresh, not a filter change, and the 250ms
  // pbp_hl_ debounce fires one behind every write the reader makes in another
  // tab -- collapsing an expanded list under the user each time.
  _pbpNotesRender();
  return true;
}

// Select all, from either row; focus goes to the batch row's Clear because
// the count row (and its Select all) hides the moment a selection exists.
function _pbpNotesSelectAllVisible() {
  _notesSelected = pbpNotesSelectResults(_notesSelected, _pbpNotesVisibleHits().map((h) => h.key), "all");
  _notesLastSelectedKey = null;
  _pbpNotesSyncSelectionUi();
  const clear = $id("notes-clear-selection");
  if (clear && _notesSelected.size) _pbpNotesFocus(clear);
}

// The filter input is static markup (never recreated), so bind its listener
// once at script-load time rather than re-binding inside renderNotesPanel on
// every tab activation (same one-time-bind convention options.js uses for
// storage-clear-btn). Guarded on `$id` existing: this whole file is also
// loaded standalone by tests/options-notes-tests.html, which exercises only
// the pure layer above and never loads shared.js -- without this guard the
// bootstrap would throw ReferenceError: $id is not defined and fail that
// test's page-error check even though every assertion still passes (dry-run
// confirmed this exact failure mode before the guard was added, and confirmed
// 0 page errors after).
if (typeof $id === "function") {
  const _notesFilterInput = $id("notes-filter");
  if (_notesFilterInput) {
    _notesFilterInput.addEventListener("input", () => {
      // Filters change WHICH rows exist, so they clear the selection -- the
      // same rule the vocabulary list has shipped since 2026-08-01. (Sorting
      // would keep it; this view has no sort.)
      _pbpNotesClearSelection();
      _pbpNotesBuildColorFilters();
      _pbpNotesRender(true);
      _pbpNotesResetListScroll();
    });
  }
  const _notesSelectAll = $id("notes-select-all");
  if (_notesSelectAll) _notesSelectAll.addEventListener("click", _pbpNotesSelectAllVisible);
  const _notesBatchSelectAll = $id("notes-batch-select-all");
  if (_notesBatchSelectAll) _notesBatchSelectAll.addEventListener("click", _pbpNotesSelectAllVisible);
  const _notesInvert = $id("notes-invert-selection");
  if (_notesInvert) _notesInvert.addEventListener("click", () => {
    _notesSelected = pbpNotesSelectResults(_notesSelected, _pbpNotesVisibleHits().map((h) => h.key), "invert");
    _notesLastSelectedKey = null;
    _pbpNotesSyncSelectionUi();
    // Inverting "everything" empties the selection and hides this very
    // button with the batch row: same landing as Clear below.
    if (!_notesSelected.size) _pbpNotesFocus($id("notes-select-all"));
  });
  const _notesClear = $id("notes-clear-selection");
  if (_notesClear) _notesClear.addEventListener("click", () => {
    _pbpNotesClearSelection();
    _pbpNotesSyncSelectionUi();
    // The bar (with the button that was just clicked) has hidden itself: hand
    // focus to the nearest persistent selection control, not to <body>.
    const allBtn = $id("notes-select-all");
    if (allBtn) _pbpNotesFocus(allBtn);
  });
  const _notesBatchDeleteBtn = $id("notes-batch-delete");
  if (_notesBatchDeleteBtn) _notesBatchDeleteBtn.addEventListener("click", _pbpNotesBatchDelete);
  // Grid navigation. Bound on the container, so it survives every row rebuild
  // and stays scoped to the list: Home/End must not reach the toolbar's filter
  // field, where they are the caret's own keys. ArrowUp/Down are
  // preventDefault'd (they would otherwise scroll the page) but never activate
  // -- opening a highlight stays a click or an unmodified Space, and the
  // modified Space chords keep their own handler on the row button.
  const _notesListEl = $id("notes-list");
  if (_notesListEl) _notesListEl.addEventListener("keydown", (e) => {
    // K89: "/" jumps back to the search filter, the twin of md-reader.js's
    // "/" search shortcut. Placed BEFORE the modifier gate below and only
    // excludes ctrl/meta/alt (not shift) -- on German QWERTZ / French
    // AZERTY "/" needs Shift, and on US layouts Shift+/ yields "?" so
    // e.key already disambiguates (same reasoning md-reader.js's "/" search
    // shortcut uses). No typing-context guard is needed: this listener only
    // ever fires with focus on a row inside #notes-list, and the page's
    // filter field lives outside that container in the toolbar, so its
    // keydowns never bubble here.
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const filter = $id("notes-filter");
      if (_pbpNotesFocus(filter)) filter.select();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const row = e.target && typeof e.target.closest === "function" ? e.target.closest(".notes-hit") : null;
    if (!row) return;
    const btns = _pbpNotesRowButtons();
    const at = btns.indexOf(row.querySelector(".notes-hit-btn"));
    let next = null;
    if (e.key === "ArrowDown") next = btns[Math.min(at + 1, btns.length - 1)];
    else if (e.key === "ArrowUp") next = btns[Math.max(at - 1, 0)];
    else if (e.key === "Home") next = btns[0];
    else if (e.key === "End") next = btns[btns.length - 1];
    else return;
    e.preventDefault();
    if (!next) return;
    _pbpNotesSetRowTabStop(next);
    next.focus();
  });
  // Hang labels are measured against the live layout, so anything that moves
  // the detail's container width or the label metrics re-measures them:
  // window resizes (the index column is clamp()ed to the viewport) and a
  // density / theme flip from another tab (options-theme-early.js rewrites
  // html[data-density] / [data-theme] in place). One frame, coalesced.
  window.addEventListener("resize", _pbpNotesScheduleStack);
  if (typeof MutationObserver === "function") {
    new MutationObserver(_pbpNotesScheduleStack).observe(document.documentElement,
      { attributes: true, attributeFilter: ["data-density", "data-theme"] });
  }
  // The detail's own width also moves with no window resize: the list pane
  // shown or hidden in narrow mode, a view switch (display:none and back),
  // the index column settling its width. Only a change of WIDTH re-measures:
  // the measurement itself writes min-heights, and answering those would be a
  // loop. Same one-frame coalescing as the two triggers above.
  const notesDetail = $id("notes-detail");
  if (notesDetail && typeof ResizeObserver === "function") {
    let lastWidth = -1;
    new ResizeObserver((entries) => {
      const width = entries[entries.length - 1].contentRect.width;
      if (width === lastWidth) return;
      lastWidth = width;
      if (width > 0) _pbpNotesScheduleStack();
    }).observe(notesDetail);
  }
  // A language switch rewrites colour names and the page count, which are
  // built from t() at render time: re-render the open detail (same highlight,
  // so the pane keeps its scroll and keyboard focus is put back where it
  // was); the render ends with a fresh measurement.
  document.addEventListener("pbp:i18n-applied", () => {
    _pbpNotesRenderCover(false);
    // The count row is JS-written as well: without this a cold load whose
    // stored language differs from the localStorage mirror kept it in the
    // mirror's language. Before the first scan there is nothing to count.
    // The colour toggles' title / aria-label ("Quote, 3 highlights") are
    // written the same way.
    if (_notesScanDone) {
      const all = _pbpNotesHits();
      const visible = _pbpNotesVisibleHits(all);
      _pbpNotesRenderToolbar(all.length, visible.length, all);
      _pbpNotesSyncColorFilters(all);
      // "Load N more" is written by the render path only; same remaining
      // count that render computed, so this only re-words it.
      _pbpNotesSyncLoadMore(visible.length - Math.min(visible.length, _notesRenderLimit));
    }
    const hit = _pbpNotesFindHit(_pbpNotesSelectedKey);
    if (!hit) return;
    const focus = _pbpNotesDetailFocusSnapshot();
    _pbpNotesRenderDetail(hit);
    _pbpNotesRestoreDetailFocus(focus);
  });
}

// Re-scan and re-render without throwing away what the user was reading.
// Every activation re-reads storage and rebuilds every row, so the selected
// highlight (and the scroll position that put it on screen) would otherwise
// be lost on a plain alt-tab back to this page. No `enterNarrow` on the
// re-render: a refresh must never swap a narrow reader's pane.
async function _pbpNotesRefreshPreservingState() {
  const selected = _pbpNotesSelectedKey;
  // The list region is this view's scroll container (library redesign §2.5
  // #2); the rebuild below replaces every row, so its offset is the place to
  // keep. The page itself never scrolls.
  const region = document.querySelector(".notes-list-region");
  const listScroll = region ? region.scrollTop : 0;
  // Keyboard focus lives on a row button or on a control inside the detail,
  // and the rebuild replaces both -- every delete triggers this refresh 250ms
  // later through its own storage write, so without this the focus
  // _pbpNotesFocusAfterDelete just placed falls to <body> a quarter second
  // later (measured on the real page). In narrow mode that is a dead end: the
  // list is display:none, so there is nothing left to Tab to. Snapshot the row
  // by key, and the detail control through _pbpNotesDetailFocusSnapshot (its
  // last class plus, for an excerpt control, its highlight key -- every jump
  // button shares one class; checked below for data-notes-key).
  const active = document.activeElement;
  const focusedRow = active && active.closest ? active.closest("#notes-list .notes-hit") : null;
  const focusedKey = focusedRow ? focusedRow.dataset.notesKey : null;
  const detailFocus = focusedRow ? null : _pbpNotesDetailFocusSnapshot();
  // Superseded (an account switch, or a newer refresh, landed while this
  // scan was reading): `selected` and the focus snapshot belong to a picture
  // that is gone, and restoring them would reopen the previous account's
  // detail over the new account's list. The scan that won owns the screen.
  if (!(await renderNotesPanel())) return;
  const hit = _pbpNotesFindHit(selected);
  if (hit) {
    _pbpNotesSelectedKey = selected;
    _pbpNotesMarkCurrentRow();
    _pbpNotesRenderDetail(hit);
  } else {
    _pbpNotesRenderDetail(null);
  }
  const refocus = focusedKey && _pbpNotesRowEl(focusedKey);
  if (refocus) _pbpNotesFocus(refocus.querySelector(".notes-hit-btn"));
  else _pbpNotesRestoreDetailFocus(detailFocus);
  if (region && listScroll) region.scrollTop = listScroll;
}

// Library page mount: render on first show and on every re-show/visibility
// return (the event carries the target view).
document.addEventListener("pbp-lib-view", (e) => {
  if (e.detail.view !== "notes") return;
  _pbpNotesRefreshPreservingState();
});

// Highlights and notes are written by the reader in another tab. This page
// keeps its rendered list while the vocabulary view is on screen, so a write
// that lands now is only picked up on the next activation -- refresh the
// visible list immediately instead. Hidden is already covered: activation
// and visibilitychange both re-scan.
//
// Trailing-debounced: highlighting a passage writes the whole pbp_hl_ record
// per stroke, and each refresh is a full storage scan plus a full rebuild of
// every card. Expansion and scroll survive it either way -- both are captured
// inside _pbpNotesRefreshPreservingState when the timer fires, off the live
// DOM that nothing has rebuilt in the meantime. Visibility is re-checked
// there too: the user may have left for the vocabulary view mid-burst, and
// that view's own activation will re-scan on the way back.
let _notesHlRefreshTimer = 0;
if (typeof $id === "function" && typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!Object.keys(changes).some((key) => key.startsWith("pbp_hl_") && key !== "pbp_hl_last_color")) return;
    clearTimeout(_notesHlRefreshTimer);
    _notesHlRefreshTimer = setTimeout(() => {
      const view = $id("view-notes");
      if (!view || view.hidden) return;
      _pbpNotesRefreshPreservingState();
    }, 250);
  });
}
