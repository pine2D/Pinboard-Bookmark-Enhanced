// ============================================================
// Pinboard Bookmark Enhanced - library-vocab.js
// Library page, Vocabulary view: the master list of the current Pinboard
// owner's pbp-vocab records (search / filter / sort / selection / batch
// bar), moved here from options-vocab.js. The row builder is the only
// adapted piece: rows no longer expand in place, they activate the detail
// pane on the right (_pbpVocabOnRowActivate). Everything Drive / export /
// dictionary-pack stays in options-vocab.js -- this file owns the list.
// ============================================================

// var, not let, for the two names this file shares with options-vocab.js:
// the two pages never co-load, but tests/options-vocab-tests.html loads BOTH
// files, and a second top-level `let` of the same name is a SyntaxError that
// kills the whole script. `var` redeclaration is harmless, and on that page
// the two halves sharing one generation counter is exactly what the Drive
// tests already assume.
var _vocabRenderGen = 0; // guards stale async renders (account switch mid-fetch)
var _vocabFlashTimer = 0; // guards two flashes racing to clear each other's text early
let _vocabRows = [];     // last render's rows for the current owner
let _vocabViewRows = []; // current filtered + sorted view (selection boundary)
let _vocabSelected = new Set();
// Deleted-card exit, decoupled from the data path: the mutation and reload
// fire immediately; only the reload's final DOM commit waits out this window
// (see _pbpVocabExitSettle call in _pbpVocabReloadAfterMutation), so the
// owner/gen guards keep their exact timing and ordering.
let _vocabExitHoldUntil = 0;
function _pbpVocabMarkExit(cards) {
  if (!document.documentElement.classList.contains("motion-ready")) return;
  if (typeof pbpPrefersReducedMotion === "function" && pbpPrefersReducedMotion()) return;
  let marked = false;
  for (const el of cards) {
    if (el && el.isConnected) { el.classList.add("card-exit"); marked = true; }
  }
  if (marked) _vocabExitHoldUntil = performance.now() + 220;
}
async function _pbpVocabExitSettle() {
  const wait = _vocabExitHoldUntil - performance.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
let _vocabLastSelectedId = null;
let _vocabRenderLimit = 100;
let _vocabBatchBusy = false;
let _vocabOwnerLabel = ""; // decoded non-secret Pinboard username for visible scope copy
// Raw owner scope of the last successfully committed render (renderVocabPanel
// or _pbpVocabReloadAfterMutation's success path). Read by _pbpVocabSoftReload
// (I3) to tell "the account under me actually changed" apart from "nothing
// changed, this is just a freshness re-fire" BEFORE any await -- the same
// fail-closed-first timing _pbpVocabClearVisibleState already uses.
let _vocabCurrentOwner = null;
const PBP_VOCAB_RENDER_BATCH = 100;
const _vocabCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

// Detail-pane activation hook, implemented below by _pbpVocabRenderDetail.
// `true` = this is a user activation, so narrow mode swaps to the detail pane
// (a plain refresh render must not, see _pbpVocabRenderDetail).
let _pbpVocabOnRowActivate = (w) => _pbpVocabRenderDetail(w, true);
// Id of the word currently shown in the detail pane (or null); read by the
// mutation-reload and generic-render paths to re-find and re-mark its row.
let _pbpVocabDetailWordId = null;

function pbpVocabSearchText(value) {
  return String(value || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/i\u0307/g, "i")
    .replace(/ß/g, "ss")
    .replace(/ς/g, "σ")
    .trim();
}

function pbpVocabFilterSort(rows, query, group, sortMode, status) {
  const needle = pbpVocabSearchText(query);
  const groupName = typeof pbpVocabNormalizeGroupName === "function"
    ? pbpVocabNormalizeGroupName(group) : String(group || "").trim();
  // Two states only ("known" and everything else): the store clamps writes
  // to new/known, and records predating the flag read as "new" here.
  const wantStatus = status === "known" || status === "new" ? status : "";
  const filtered = (Array.isArray(rows) ? rows : []).filter((row) => {
    const groups = typeof pbpVocabGroups === "function" ? pbpVocabGroups(row) : [];
    if (groupName && !groups.includes(groupName)) return false;
    if (wantStatus && (String((row && row.status) || "new") === "known" ? "known" : "new") !== wantStatus) return false;
    if (!needle) return true;
    const contexts = Array.isArray(row && row.contexts) ? row.contexts : [];
    const fields = [row && row.term, row && row.lemma, row && row.gloss, row && row.note,
      ...groups, ...contexts.flatMap((ctx) => [ctx && ctx.quote, ctx && ctx.articleTitle])];
    return fields.some((value) => pbpVocabSearchText(value).includes(needle));
  }).map((row, index) => ({ row, index }));

  const mode = ["oldest", "az", "za"].includes(sortMode) ? sortMode : "latest";
  filtered.sort((a, b) => {
    let cmp = 0;
    if (mode === "latest" || mode === "oldest") {
      cmp = (Number(a.row.updatedAt) || Number(a.row.createdAt) || 0)
        - (Number(b.row.updatedAt) || Number(b.row.createdAt) || 0);
      if (mode === "latest") cmp *= -1;
    } else {
      cmp = _vocabCollator.compare(String(a.row.term || a.row.lemma || ""), String(b.row.term || b.row.lemma || ""));
      if (mode === "za") cmp *= -1;
    }
    return cmp || a.index - b.index;
  });
  return filtered.map((item) => item.row);
}

// Read-only stats over the owner's full row set. `now` injected for testability.
function pbpVocabStats(rows, now) {
  const groups = new Set();
  const langs = new Set();
  let learning = 0, known = 0, added7 = 0, added30 = 0;
  let latestCreatedAt = 0;
  const d7 = now - 7 * 86400000, d30 = now - 30 * 86400000;
  for (const r of rows) {
    if (String(r.status || "new") === "known") known++; else learning++;
    for (const g of pbpVocabGroups(r)) groups.add(g);
    if (r.language && r.language !== "und") langs.add(r.language);
    if (r.createdAt >= d7) added7++;
    if (r.createdAt >= d30) added30++;
    const created = Number(r.createdAt) || 0;
    if (created > latestCreatedAt) latestCreatedAt = created;
  }
  return { total: rows.length, learning, known, groups: groups.size, languages: langs.size, added7, added30, latestCreatedAt };
}

function pbpVocabSelectResults(selected, rows, mode) {
  const next = new Set(selected || []);
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!row || !row.id) continue;
    if (mode === "invert") {
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
    } else {
      next.add(row.id);
    }
  }
  return next;
}

function pbpVocabSelectRange(selected, rows, anchorId, targetId, checked) {
  const next = new Set(selected || []);
  const ids = (Array.isArray(rows) ? rows : []).map((row) => row && row.id);
  const start = ids.indexOf(anchorId);
  const end = ids.indexOf(targetId);
  if (start < 0 || end < 0) {
    if (targetId) checked ? next.add(targetId) : next.delete(targetId);
    return next;
  }
  const lo = Math.min(start, end), hi = Math.max(start, end);
  for (let i = lo; i <= hi; i++) {
    if (!ids[i]) continue;
    checked ? next.add(ids[i]) : next.delete(ids[i]);
  }
  return next;
}

// One selection gesture, four entry points: Ctrl/Cmd+click, Ctrl/Cmd+Space,
// Shift+click, Shift+Space. `range` sets the whole anchor..target interval to
// what a plain toggle of THIS row would have produced -- which is what keeps
// "Shift over an already-selected block deselects it", the semantics the
// checkbox era got for free from the browser-toggled `checkbox.checked`.
// The anchor moves to the last operated row either way (unchanged rule).
function _pbpVocabRowSelect(w, range) {
  // A batch mutation is mid-flight and owns every row it is about to rewrite;
  // the checkbox era expressed this as `checkbox.disabled`, which went away
  // with the checkbox.
  if (_vocabBatchBusy) return;
  const want = !_vocabSelected.has(w.id);
  if (range && _vocabLastSelectedId) {
    _vocabSelected = pbpVocabSelectRange(_vocabSelected, _vocabViewRows,
      _vocabLastSelectedId, w.id, want);
  } else if (want) {
    _vocabSelected.add(w.id);
  } else {
    _vocabSelected.delete(w.id);
  }
  _vocabLastSelectedId = w.id;
  _pbpVocabSyncSelectionUi();
}

// Master-detail activation: hand the word to the detail pane and mark this row
// as the current one. Exactly one row carries aria-current, so clear the
// others first. Split out of the click handler because the same activation is
// now one of three things a click can mean (see the handler below).
function _pbpVocabActivateRow(w, card) {
  _pbpVocabOnRowActivate(w);
  document.querySelectorAll("#vocab-list .vocab-card[aria-current]").forEach((el) => el.removeAttribute("aria-current"));
  card.setAttribute("aria-current", "true");
  // Keep the list's single tab stop on the row the detail pane is showing:
  // that is what the narrow-mode Back button and every focus-restore path
  // already treat as "where the user was", so the two must not disagree.
  _pbpVocabSetRowTabStop(card.querySelector(".notes-card-head"));
}

// Roving tabindex for the row grid. #vocab-list declares role="grid" and each
// row carries two real buttons, so one render batch put 200 Tab stops between
// the search box and "Load more" -- and the arrow keys that role promises did
// nothing at all, which left the Ctrl/Shift+Space multi-select path above
// reachable only by tabbing row by row. One stop for the whole list instead,
// with the arrows doing the moving: the same recipe library.js uses for the
// page's tab strip and options.js for its sidebar. The selection chords are
// untouched -- navigation never activates or selects a row.
function _pbpVocabRowHeads() {
  const list = $id("vocab-list");
  return list ? [...list.querySelectorAll(".vocab-card .notes-card-head")] : [];
}

function _pbpVocabSetRowTabStop(head) {
  if (!head) return;
  for (const el of _pbpVocabRowHeads()) el.tabIndex = el === head ? 0 : -1;
}

// Re-derived after every render: rows are rebuilt wholesale on filter, sort
// and reload, and a stop pointing at a discarded node leaves the list with
// none at all. An append render (Load more) keeps the stop it already has --
// every row it added is fresh, hence tabIndex -1 from the builder.
function _pbpVocabSyncRowTabStops() {
  const heads = _pbpVocabRowHeads();
  if (!heads.length) return;
  const list = $id("vocab-list");
  const current = list && list.querySelector(".vocab-card[aria-current] .notes-card-head");
  _pbpVocabSetRowTabStop(heads.find((el) => el.tabIndex === 0) || current || heads[0]);
}

// No render-index parameter any more: its only job was the expandable body's
// DOM id, and the master-detail row has no body to address.
function _pbpVocabBuildRow(w) {
  const card = document.createElement("article");
  card.className = "notes-card vocab-card";
  // role=row + role=gridcell, not listitem (user ruling 2026-08-06: the
  // per-row checkbox is gone and selection is carried by the row's own fill).
  // `aria-selected` is only supported on grid/listbox descendants -- declared
  // on a `listitem` it is invalid ARIA that assistive tech drops silently, so
  // deleting the checkbox without moving the role would have deleted the
  // screen-reader path with it. `option` is out: it must be a leaf, and this
  // row carries two real buttons.
  card.setAttribute("role", "row");
  card.dataset.vocabId = w.id;
  const isSelected = _vocabSelected.has(w.id);
  card.setAttribute("aria-selected", isSelected ? "true" : "false");
  card.classList.toggle("selected", isSelected); // drives the row accent band

  const top = document.createElement("div");
  top.className = "notes-card-top";
  top.setAttribute("role", "gridcell");

  const head = document.createElement("button");
  head.type = "button";
  head.className = "notes-card-head";
  // K89: "/" (jump to the search box) rides along with the existing
  // multi-select chords -- it fires from anywhere in the list (see the
  // #vocab-list keydown below), not just this row, but this is the only
  // per-row control an assistive-tech user reading a row would query.
  head.setAttribute("aria-keyshortcuts", "Control+Space Shift+Space /");
  // Roving tabindex (see _pbpVocabSyncRowTabStops): every row builds OUT of
  // the tab order and exactly one is put back in per render.
  head.tabIndex = -1;

  const main = document.createElement("span");
  main.className = "notes-card-main";

  // Fixed two-line rhythm (spec §3.6): line 1 = term + language + known as
  // plain text, line 2 = gloss | groups. The gloss used to live in the
  // wrapping chip row, so a long AI gloss pushed the chips onto extra lines
  // and every card ended up a different height (real-device report).
  const headline = document.createElement("span");
  headline.className = "vocab-row-headline";
  const titleEl = document.createElement("span");
  titleEl.className = "notes-row-title";
  titleEl.textContent = w.term;
  headline.appendChild(titleEl);

  const meta = document.createElement("span");
  meta.className = "notes-row-meta";
  const languageLabel = pbpDictLanguageLabel(w.language, document.documentElement.lang);
  if (languageLabel) {
    const langChip = document.createElement("span");
    langChip.className = "notes-meta-chip";
    langChip.textContent = languageLabel;
    meta.appendChild(langChip);
  }
  if (String(w.status || "new") === "known") {
    const statusChip = document.createElement("span");
    statusChip.className = "notes-meta-chip vocab-status-chip";
    statusChip.textContent = t("vocabStatusKnown");
    meta.appendChild(statusChip);
  }
  headline.appendChild(meta);
  main.appendChild(headline);

  if (w.gloss) {
    const glossLine = document.createElement("span");
    glossLine.className = "vocab-row-gloss";
    glossLine.textContent = (w.gloss || "").split("\n")[0];
    main.appendChild(glossLine);
  }
  // Groups as plain text on line two's right end (spec §3.6); the " · "
  // between them is CSS (.vocab-row-groups > span + span::before).
  const groupNames = pbpVocabGroups(w);
  if (groupNames.length) {
    const groupsEl = document.createElement("span");
    groupsEl.className = "vocab-row-groups";
    for (const group of groupNames) {
      const part = document.createElement("span");
      part.textContent = group;
      groupsEl.appendChild(part);
    }
    main.appendChild(groupsEl);
  }

  head.appendChild(main);
  top.appendChild(head);

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn btn-sm notes-row-del row-del-x";
  // The row's second control, reached with ArrowRight rather than Tab: it is
  // opacity:0 until its row is hovered or it takes focus, so leaving it in the
  // tab order kept ~100 stops that land on something invisible (and it shares
  // this row's single gridcell, which is what makes Left/Right the right key
  // pair for it).
  delBtn.tabIndex = -1;
  // Icon-only: the full sentence ate a third of every row. The name lives in
  // title/aria-label; the confirm popover still anchors to the button.
  setBtnIcon(delBtn, "cross", "");
  delBtn.title = t("dictDeleteWord");
  delBtn.setAttribute("aria-label", t("dictDeleteWord"));
  delBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    _pbpVocabDeleteRow(w, delBtn);
  });
  top.appendChild(delBtn);
  card.appendChild(top);

  // Desktop list grammar: a plain click reads the row (activation), a
  // modified click selects it for the batch bar. The two are deliberately
  // separate verbs -- selecting must NOT move the detail pane, or building a
  // 20-row selection would re-render the right pane 20 times.
  head.addEventListener("click", (e) => {
    if (e.shiftKey) { _pbpVocabRowSelect(w, true); return; }
    if (e.ctrlKey || e.metaKey) { _pbpVocabRowSelect(w, false); return; }
    _pbpVocabActivateRow(w, card);
  });
  // Keyboard twins of those two modifiers, so multi-select never requires a
  // pointer. Space is the button's OWN activation key, so the modified forms
  // have to be caught on keydown and preventDefault'd -- otherwise the
  // browser also synthesises the plain click and the row would activate as
  // well as toggle. Announced through aria-keyshortcuts (below); the visible
  // hint rides on "Select all"'s title, the one always-present control in the
  // same region (a title on every row would tooltip the whole list).
  head.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "Spacebar") return;
    if (e.shiftKey) { e.preventDefault(); _pbpVocabRowSelect(w, true); }
    else if (e.ctrlKey || e.metaKey) { e.preventDefault(); _pbpVocabRowSelect(w, false); }
  });

  return card;
}

// Ported verbatim from the pre-migration row builder; _pbpVocabRenderDetail
// below wires it into the detail pane.
// Note editor. The field, its concurrent-merge rule and the Drive privacy
// copy ("may include ... notes") all existed with no way to type into it.
// Save is explicit (mutation-at-confirm discipline, same as every other
// vocab edit); the button only appears once the text actually differs.
// Returns { wrap, save }: the field stays in the reading flow, the commit
// button belongs to the pane's closing action row (v2b, user-chosen). They
// are built together because the save button's whole existence is derived
// from the field's dirty state.
function _pbpVocabBuildNoteEditor(w) {
  // The owner this editor was rendered for (see _pbpVocabOwnerMoved).
  const renderOwner = _vocabCurrentOwner;
  const noteWrap = document.createElement("div");
  noteWrap.className = "vocab-note-edit";
  const noteInput = document.createElement("textarea");
  noteInput.className = "vocab-note-input";
  noteInput.rows = 2;
  noteInput.maxLength = 500;
  // The visible label is the section's "My note"; the placeholder says what
  // goes in and that leaving the box saves it (spec §4.6).
  noteInput.placeholder = t("libraryNotePlaceholder");
  noteInput.setAttribute("aria-label", t("librarySectionMyNote"));
  noteInput.value = w.note || "";
  // Announced, not labelled: the chord has no visible affordance of its own,
  // and the page already declares its shortcuts this way (the row head's
  // Control+Space / Shift+Space).
  noteInput.setAttribute("aria-keyshortcuts", "Control+Enter");
  const noteSave = document.createElement("button");
  noteSave.type = "button";
  noteSave.className = "btn btn-sm primary vocab-note-save";
  // icon + label, as confirmed on the mockup. `check` is the commit gesture
  // (the tick you get back), distinct from `checkCircle`, which this page
  // already spends on "mark as known".
  setBtnIcon(noteSave, "check", t("hlSave"));
  noteSave.hidden = true;
  noteInput.addEventListener("input", () => {
    noteSave.hidden = noteInput.value === (w.note || "");
  });
  // Keyboard commit. The field and its Save are deliberately far apart (v2b:
  // the button belongs to the pane's closing row), so the only keyboard route
  // to it ran Tab past the dictionary result, "Look up again" and the danger
  // "Delete word" -- a commit chord is the standing answer to that, and this
  // extension already binds the same one for its other explicit save
  // (popup.js's Ctrl/Cmd+Enter). Bound to the textarea, never the document:
  // this page has other panes with their own fields. Inert while nothing is
  // dirty (no redundant IDB write) or while a save is already running, and
  // the propagation stops here because the row handlers upstream read Ctrl as
  // a multi-select modifier.
  noteInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
    // Same IME guard the lookup box carries: Chrome fires an Enter keydown
    // with isComposing (keyCode 229 as the fallback signal) when a candidate
    // is confirmed, and that Enter belongs to the composition, not to us.
    if (e.isComposing || e.keyCode === 229) return;
    if (noteSave.hidden || noteSave.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    noteSave.click();
  });
  // Leaving the box saves (spec §4.6; the placeholder promises it). The same
  // gate as the chord: inert while nothing is dirty or a save is running. A
  // blur caused by pressing Save starts the save here; the click that follows
  // lands on a disabled button and does nothing. Read one microtask later:
  // Chrome also fires blur while a rebuild removes the focused box (a sibling
  // mutation, a soft reload), with isConnected still true at that moment --
  // that is a refresh, not the user leaving, and the rebuild keeps the draft.
  noteInput.addEventListener("blur", () => {
    queueMicrotask(() => {
      if (noteSave.hidden || noteSave.disabled || !noteInput.isConnected) return;
      noteSave.click();
    });
  });
  noteSave.addEventListener("click", async () => {
    if (noteSave.disabled) return;
    noteSave.disabled = true;
    const gen = ++_vocabRenderGen;
    let owner = null;
    const restoreSelection = _pbpVocabHoldSelection(gen);
    try {
      owner = await pbpVocabCurrentOwner();
      if (_pbpVocabOwnerMoved(owner, renderOwner, gen)) return;
      const ok = await pbpVocabSetNote(w.id, owner, noteInput.value);
      const refreshed = await _pbpVocabReloadAfterMutation(owner, gen);
      restoreSelection();
      if (gen !== _vocabRenderGen) return;
      if (!ok) {
        _pbpVocabFlashStatus(false, t("vocabBatchFailed"));
        // Pin the failure to the card it happened on -- the reload above
        // rebuilt the DOM, so find the successor by id.
        document.querySelectorAll("#vocab-list > .vocab-card").forEach((el) => {
          if (el.dataset.vocabId === w.id) el.classList.add("is-error");
        });
      }
      else if (!refreshed) _pbpVocabFlashStatus(false, t("vocabRefreshFailed"));
      else _pbpVocabFlashStatus(true, t("vocabNoteSaved"));
    } catch (_) {
      if (owner) { await _pbpVocabReloadAfterMutation(owner, gen); restoreSelection(); }
      if (gen === _vocabRenderGen) _pbpVocabFlashStatus(false, t("vocabBatchFailed"));
    } finally {
      noteSave.disabled = false;
    }
  });
  noteWrap.appendChild(noteInput);
  return { wrap: noteWrap, save: noteSave };
}

// The back button is static markup at the top of the pane now, wired once --
// it used to be rebuilt inside #vocab-detail on every render, which meant it
// existed only when the pane had CONTENT. Arriving in narrow mode with
// nothing selected (which the lookup door below does on purpose) was then a
// dead end with no way back to the list.
{
  const back = $id("vocab-detail-back");
  if (back) {
    // Icon + label live in the markup (data-ic / data-i18n), not in a
    // setBtnIcon call here: this runs at module load, where t() can only fall
    // back to the BROWSER locale -- applyI18n has not yet loaded the user's
    // chosen UI language. Everything static on this page takes its text the
    // same way for that reason.
    back.addEventListener("click", () => {
      // Read the row to return to BEFORE the pane closes: the class removal
      // below hides this whole pane at <=860px (library.css's
      // `body:not(.lib-narrow-detail) .vocab-detail-pane`), and Chrome resets
      // focus to <body> when the focused element's pane goes display:none --
      // with no skip link on this page, the way back is a full Tab walk past
      // the header, the search box, both filters and the batch controls.
      // Clearing the detail also drops the aria-current marker this reads.
      // The mirror image of _pbpVocabFocusNarrowBack, which already fixes the
      // same fall-through on the way INTO the detail.
      const row = document.querySelector("#vocab-list .vocab-card[aria-current] .notes-card-head");
      document.body.classList.remove("lib-narrow-detail");
      _pbpVocabRenderDetail(null);
      if (row && row.isConnected) {
        try { row.focus({ preventScroll: true }); } catch (_) { row.focus(); }
      } else {
        _pbpVocabFocusStable();
      }
    });
  }
}

// Exactly one row carries aria-current, and it must name whatever the detail
// pane is actually showing -- including "nothing", which is why this takes a
// null id instead of only ever moving the marker. Twin of library-notes.js's
// _pbpNotesMarkCurrentRow (same contract, this view's own row shape).
// _pbpVocabActivateRow keeps marking its own card directly: it already holds
// the element the click came from and needs no second lookup for it.
function _pbpVocabMarkCurrentRow(id) {
  document.querySelectorAll("#vocab-list .vocab-card[aria-current]")
    .forEach((el) => el.removeAttribute("aria-current"));
  if (!id) return;
  const el = document.querySelector(`#vocab-list .vocab-card[data-vocab-id="${CSS.escape(id)}"]`);
  if (el) el.setAttribute("aria-current", "true");
}

// One hang section (spec §4.3): a real h3 that names the section, and the
// section's body. On a wide detail the sheet's subgrid hangs the label in the
// 112px column; narrower, the same label sits above its content.
function _pbpVocabHangSection(cls, labelKey) {
  const sec = document.createElement("section");
  sec.className = "lib-hang-sec " + cls;
  const label = document.createElement("h3");
  label.className = "lib-hang-label";
  label.id = cls + "-label";
  label.textContent = t(labelKey);
  sec.setAttribute("aria-labelledby", label.id);
  const body = document.createElement("div");
  body.className = "lib-hang-body";
  sec.append(label, body);
  return { sec, body };
}

// "Edit groups" (spec §4.5, V5): a disclosure. Open: the group box and the
// removable chips appear under the manage row, the plain group text hides (a
// name never shows twice), the button takes the pressed fill, the caret goes
// to the box. Closed again by the button or by Esc in the box, focus back on
// the button. `moveFocus` false is the rebuild path (_pbpVocabReconcileDetail),
// which hands the editor back open without taking focus. Queried inside
// #vocab-detail, never through $id: every render replaces these nodes.
function _pbpVocabToggleGroupEditor(open, moveFocus = true) {
  const detail = $id("vocab-detail");
  if (!detail) return;
  const editor = detail.querySelector("#vocab-group-editor");
  const btn = detail.querySelector(".vocab-edit-groups");
  if (!editor || !btn) return;
  editor.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  const groupsText = detail.querySelector(".vocab-manage-groups");
  if (groupsText) groupsText.hidden = open;
  if (!moveFocus) return;
  const target = open ? editor.querySelector('.vocab-group-unit > input[type="text"]') : btn;
  if (target) {
    try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
  }
}

// Renders the master-detail right pane for the activated word (or clears it
// back to the empty state for null, e.g. after a delete). Reassigned onto
// _pbpVocabOnRowActivate above; also called directly by the reload-after-
// mutation and delete-linkage paths.
// `enterNarrow` is opt-in: only a user activation (row click, the saved-word
// hint under a lookup result) may swap narrow mode from the list to the detail. Refresh renders
// (mutation reload, view re-entry) keep whichever pane the user is on --
// otherwise every sibling mutation would yank a narrow reader into the
// detail, and library.js's view switch could never hand the list back.
function _pbpVocabRenderDetail(w, enterNarrow) {
  const empty = $id("vocab-detail-empty");
  const detail = $id("vocab-detail");
  // No-op where the detail pane doesn't exist -- library-vocab.js's row
  // builder (and thus this hook) also runs inside tests/options-vocab-tests.html,
  // which co-loads both vocab halves but only ever mounts options.html's
  // expandable-card markup (no #vocab-detail-*).
  if (!empty || !detail || !$id("vocab-detail-tail")) return;
  // Every exit from here rebuilds or empties #vocab-detail, so rescue the
  // status live region out of the closing row it may be parked in before the
  // subtree goes (see _pbpVocabStatusHost); the rebuilt row re-adopts it below.
  _pbpVocabStatusHost(false);
  // Only a CHANGE of the open entry resets the dictionary column (spec §4.8):
  // a refresh of the same word (_pbpVocabSoftReload, _pbpVocabReconcileDetail)
  // and a second activation of the word already shown keep the result and the
  // run still filling it -- #vocab-ref-result is static and nothing below
  // rebuilds it. Cover -> cover is no change either: a lookup typed on the
  // cover survives the signed-out page's refreshes.
  const nextId = w ? w.id : null;
  const changed = nextId !== _pbpVocabDetailWordId;
  _pbpVocabDetailWordId = nextId;
  if (changed) _pbpVocabResetRef(w || null);
  empty.hidden = !!w;
  detail.hidden = !w;
  if (!w) document.body.classList.remove("lib-narrow-detail");
  else if (enterNarrow) document.body.classList.add("lib-narrow-detail");
  if (!w) {
    detail.replaceChildren();
    $id("vocab-detail-tail").replaceChildren();
    // Without this the list keeps a "you are here" row pointing at a pane
    // that now says nothing.
    _pbpVocabMarkCurrentRow(null);
    return;
  }

  const frag = document.createDocumentFragment();
  const langCode = w.language && w.language !== "und" ? w.language : "";
  // Every write this detail can fire is checked against this owner.
  const renderOwner = _vocabCurrentOwner;

  // 1. Head (spec §4.4-§4.5): the word, its pronunciation line, the stored
  // gloss, the manage row and the (collapsed) group editor.
  const head = document.createElement("header");
  head.className = "vocab-detail-head";
  const term = document.createElement("h2");
  term.className = "vocab-detail-term lib-first-line";
  if (langCode) term.lang = langCode;
  term.textContent = w.term;
  head.appendChild(term);

  const pron = document.createElement("div");
  pron.className = "vocab-pron-row";
  if (w.ipa) {
    const ipa = document.createElement("span");
    ipa.className = "vocab-pron-ipa";
    ipa.textContent = w.ipa;
    pron.appendChild(ipa);
  }
  const langLabel = pbpDictLanguageLabel(w.language, document.documentElement.lang);
  if (langLabel) {
    const lang = document.createElement("span");
    lang.className = "vocab-pron-lang";
    lang.textContent = langLabel;
    pron.appendChild(lang);
  }
  const speak = document.createElement("button");
  speak.type = "button";
  speak.className = "btn btn-sm ghost vocab-detail-speak";
  setBtnIcon(speak, "speaker", "");
  speak.title = t("dictSpeak");
  speak.setAttribute("aria-label", t("dictSpeak"));
  speak.addEventListener("click", () => pbpDictSpeak(w.term, langCode));
  pron.appendChild(speak);
  head.appendChild(pron);

  if (w.gloss) {
    const gloss = document.createElement("p");
    gloss.className = "vocab-detail-gloss";
    gloss.textContent = w.gloss;
    head.appendChild(gloss);
  }

  const manage = document.createElement("div");
  manage.className = "vocab-manage-row";
  const known = String(w.status || "new") === "known";
  const statusBtn = document.createElement("button");
  statusBtn.type = "button";
  statusBtn.className = "btn btn-sm vocab-detail-status";
  setBtnIcon(statusBtn, "checkCircle", t(known ? "vocabMarkLearning" : "vocabMarkKnown"));
  statusBtn.addEventListener("click", () => _pbpVocabDetailMutate(w, (owner) =>
    pbpVocabBatchSetStatus([w.id], owner, known ? "new" : "known"), renderOwner));
  manage.appendChild(statusBtn);
  const currentGroups = pbpVocabGroups(w);
  if (currentGroups.length) {
    // Plain text, one span per name; the " · " between them is CSS.
    const groupsText = document.createElement("span");
    groupsText.className = "vocab-manage-groups";
    for (const group of currentGroups) {
      const name = document.createElement("span");
      name.textContent = group;
      groupsText.appendChild(name);
    }
    manage.appendChild(groupsText);
  }
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "btn btn-sm ghost vocab-edit-groups lib-hang-start";
  editBtn.setAttribute("aria-expanded", "false");
  editBtn.setAttribute("aria-controls", "vocab-group-editor");
  setBtnIcon(editBtn, "pencil", t("libraryEditGroups"));
  editBtn.addEventListener("click", () => _pbpVocabToggleGroupEditor(editBtn.getAttribute("aria-expanded") !== "true"));
  manage.appendChild(editBtn);
  head.appendChild(manage);

  // The group editor: same input + stepper unit as the batch row, scoped to
  // [w.id], plus a removable chip per current group (Finding 5) whose x is
  // always shown here (V5) -- a hover-only x is not findable while editing.
  const editor = document.createElement("div");
  editor.id = "vocab-group-editor";
  editor.className = "vocab-group-editor";
  editor.hidden = true;
  const groupUnit = document.createElement("span");
  groupUnit.className = "vocab-group-unit";
  const groupInput = document.createElement("input");
  groupInput.type = "text";
  groupInput.setAttribute("list", "vocab-group-list"); // shared datalist from the list pane
  groupInput.placeholder = t("vocabGroupNamePlaceholder");
  groupInput.setAttribute("aria-label", t("vocabGroupNamePlaceholder"));
  groupInput.autocomplete = "off";
  groupUnit.appendChild(groupInput);
  groupInput.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.isComposing) return;
    e.preventDefault();
    _pbpVocabToggleGroupEditor(false);
  });
  const addGroup = document.createElement("button");
  addGroup.type = "button";
  addGroup.className = "btn btn-sm vocab-group-step";
  setBtnIcon(addGroup, "plus", "");
  addGroup.title = t("vocabAddToGroup");
  addGroup.setAttribute("aria-label", t("vocabAddToGroup"));
  addGroup.addEventListener("click", () => {
    const name = pbpVocabNormalizeGroupName(groupInput.value);
    if (name) _pbpVocabDetailMutate(w, (owner) => pbpVocabBatchAddGroup([w.id], owner, name), renderOwner);
  });
  groupUnit.appendChild(addGroup);
  const removeGroup = document.createElement("button");
  removeGroup.type = "button";
  removeGroup.className = "btn btn-sm vocab-group-step";
  setBtnIcon(removeGroup, "minus", "");
  removeGroup.title = t("vocabRemoveFromGroup");
  removeGroup.setAttribute("aria-label", t("vocabRemoveFromGroup"));
  removeGroup.addEventListener("click", () => {
    const name = pbpVocabNormalizeGroupName(groupInput.value);
    if (name) _pbpVocabDetailMutate(w, (owner) => pbpVocabBatchRemoveGroup([w.id], owner, name), renderOwner);
  });
  groupUnit.appendChild(removeGroup);
  editor.appendChild(groupUnit);
  if (currentGroups.length) {
    const chipList = document.createElement("span");
    chipList.className = "vocab-detail-group-chips";
    for (const group of currentGroups) {
      const chip = document.createElement("span");
      chip.className = "notes-meta-chip vocab-group-chip removable";
      chip.textContent = group;
      const removeChip = document.createElement("button");
      removeChip.type = "button";
      removeChip.className = "chip-remove";
      setBtnIcon(removeChip, "cross", "");
      // The group name is user data, not translatable UI text: the existing
      // "Remove from group" label plus the name, no new locale key.
      removeChip.title = t("vocabRemoveFromGroup") + ": " + group;
      removeChip.setAttribute("aria-label", t("vocabRemoveFromGroup") + ": " + group);
      removeChip.addEventListener("click", (e) => {
        e.stopPropagation();
        _pbpVocabDetailMutate(w, (owner) => pbpVocabBatchRemoveGroup([w.id], owner, group), renderOwner);
      });
      chip.appendChild(removeChip);
      chipList.appendChild(chip);
    }
    editor.appendChild(chipList);
  }
  head.appendChild(editor);
  frag.appendChild(head);

  // 2. Context (spec §4.6): each saved sentence with the word in bold, then
  // its source link and "site · date". No section at all without one.
  const contexts = (Array.isArray(w.contexts) ? w.contexts : []).filter(Boolean);
  if (contexts.length) {
    const { sec, body } = _pbpVocabHangSection("vocab-sec-context", "librarySectionContext");
    for (const c of contexts) {
      const fig = document.createElement("figure");
      fig.className = "vocab-detail-context";
      const quote = document.createElement("blockquote");
      quote.className = "vocab-context-quote";
      _pbpVocabHighlightTerm(quote, c.quote || "", w.term);
      fig.appendChild(quote);
      const source = document.createElement("figcaption");
      source.className = "vocab-context-source";
      const safeHref = pbpDictSafeUrl(c.articleUrl);
      if (safeHref) {
        const link = document.createElement("a");
        link.className = "notes-row-open";
        link.href = safeHref;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        // Title text in its own span so the ellipsis has a box it owns and
        // the icon stays a flex sibling (2026-09-22 T2 fix round).
        const linkText = document.createElement("span");
        linkText.className = "notes-row-open-text";
        linkText.textContent = c.articleTitle || safeHref;
        link.appendChild(linkText);
        // Static PBP_ICONS constant (already aria-hidden), never page content.
        link.insertAdjacentHTML("beforeend", PBP_ICONS.extOpen.replace('<svg ', '<svg class="ext-icon" '));
        source.appendChild(link);
      }
      const meta = document.createElement("span");
      meta.className = "vocab-context-meta";
      let site = "";
      if (safeHref) {
        try { site = new URL(safeHref).hostname.replace(/^www\./, ""); } catch (_) {}
      }
      const day = typeof pbpLibFormatDay === "function" ? pbpLibFormatDay(c.createdAt) : "";
      for (const part of [site, day]) {
        if (!part) continue;
        const item = document.createElement("span");
        item.textContent = part;
        meta.appendChild(item);
      }
      if (meta.childElementCount) source.appendChild(meta);
      if (source.childElementCount) fig.appendChild(source);
      body.appendChild(fig);
    }
    frag.appendChild(sec);
  }

  // 3. My note (spec §4.6). Save lives in the tail (v2b); the field stays here.
  const noteEditor = _pbpVocabBuildNoteEditor(w);
  const { sec: noteSec, body: noteBody } = _pbpVocabHangSection("vocab-sec-note", "librarySectionMyNote");
  noteBody.appendChild(noteEditor.wrap);
  frag.appendChild(noteSec);

  // 4. The tail (spec §4.7): remove on the left, hung on the column's left
  // edge, then the status sentence (_pbpVocabStatusHost puts it before Save),
  // then Save at the right end. It renders into #vocab-detail-tail, after the
  // dictionary column, so the destructive action is the last stop of a Tab
  // walk. "Look up again" lives under the dictionary result.
  const footer = document.createElement("footer");
  footer.className = "vocab-detail-footer";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn btn-sm danger ghost vocab-detail-delete lib-hang-start";
  setBtnIcon(del, "trash", t("dictDeleteWord"));
  del.addEventListener("click", () => _pbpVocabDeleteRow(w, del));
  footer.appendChild(del);
  // Save stays in layout while hidden (visibility, see .vocab-note-save[hidden]
  // in library.css), so becoming dirty moves nothing in the row.
  footer.appendChild(noteEditor.save);

  detail.replaceChildren(frag);
  $id("vocab-detail-tail").replaceChildren(footer);
  // Same focus handoff the lookup door does, at the root every activation
  // passes through: a row click hides the list the head button lives in.
  if (enterNarrow) _pbpVocabFocusNarrowBack();
  // The scroll container is the PANE: replaceChildren keeps its scrollTop, so
  // a new entry would open where the last one was left. Only when the entry
  // CHANGED -- the refresh paths exist to keep the reader where they were,
  // and the focus({ preventScroll }) handoff assumes the viewport stays put.
  const pane = $id("vocab-detail-pane");
  if (pane && changed) pane.scrollTop = 0;
  // The closing row exists now; the status region takes its home before any
  // caller writes a sentence into it.
  _pbpVocabStatusHost(true);
}

// Dictionary reference column (library redesign T7, spec §4.8-§4.10). Reuses md-dict's
// pure query seams (_pbpDictSlotRun online chain + _pbpDictEcdictSide local
// pack) with NO AI leg: the lemma promise resolves empty immediately (ai.js
// is not loaded on this page). Participates in md-dict's staleness token so
// a second click or a word switch invalidates the previous run exactly like
// explain-pop does.
let _pbpVocabDictCtrl = null;

// Child controller per run, chained to the session-level `_pbpVocabDictCtrl`
// -- mirrors md-dict.js's pbpDictRun child/parent discipline (its own
// `_pbpDictChildCtrl` + `_pbpDictParentCleanup`, distinct names to avoid a
// SyntaxError double-`let` since both files co-load on this page). Without
// this, a language switch reused the single outer signal for every run:
// _pbpDictSlotRun only checks THAT signal for staleness, so a slow in-flight
// fetch for the OLD language (up to its 8s timeout) could still land in the
// shared onlineEl after the new language's result, silently showing content
// the dropdown no longer names. Module-level (not a per-call closure) so
// every caller of _pbpVocabDictRun below shares one child-run slot.
let _pbpVocabDictChildCtrl = null;
let _pbpVocabDictChildCleanup = null;

// Shared dictionary run core, extracted from _pbpVocabRelookup so free lookup
// (a later task) can reuse it verbatim. Reuses md-dict's pure query seams
// (_pbpDictSlotRun online chain + _pbpDictEcdictSide local pack) with NO AI
// leg: the lemma promise resolves empty immediately (ai.js is not loaded on
// this page). Participates in md-dict's staleness token so a second run or a
// word switch invalidates the previous one exactly like explain-pop does.
// `els` = { localEl, onlineEl } (the two stable slot children -- see the
// slot-invariant comment at each call site). `rerun` is the caller's "run
// this exact query again" callback (e.g. re-read a language <select> and
// call its own startRun); it only fires if this run is still the live one.
// `online: false` runs the local ECDICT block alone (open-to-look-up, T7).
// #vocab-ref-result is aria-busy while the live run fills it; only the run
// still live when its legs settle takes the flag down.
function _pbpVocabDictRun(term, lang, els, sentence, rerun, { online = true } = {}) {
  const { localEl, onlineEl } = els;
  if (_pbpVocabDictChildCtrl) _pbpVocabDictChildCtrl.abort();
  if (_pbpVocabDictChildCleanup) { _pbpVocabDictChildCleanup(); _pbpVocabDictChildCleanup = null; }
  const child = new AbortController();
  _pbpVocabDictChildCtrl = child;
  // Fix round 1 (Minor 5): capture the parent controller AT REGISTRATION
  // time, not the module var at cleanup time. _pbpVocabDictCtrl can be
  // reassigned to a NEW session controller between now and cleanup (free
  // lookup and a word-detail relookup each replace it) -- reading the
  // module var inside the cleanup closure would remove the listener from
  // whatever controller happens to be current THEN, leaking it on the one
  // it was actually added to.
  const parent = _pbpVocabDictCtrl;
  const onParentAbort = () => child.abort();
  if (parent.signal.aborted) child.abort();
  else {
    parent.signal.addEventListener("abort", onParentAbort, { once: true });
    _pbpVocabDictChildCleanup = () => { try { parent.signal.removeEventListener("abort", onParentAbort); } catch (_) {} };
  }
  const signal = child.signal;

  const cur = { term, lang, sentence };
  cur.rerun = () => { if (_pbpDictCurrent === cur) rerun(); };
  // Form-of pointer jump (md-dict's .xp-dict-lemma-link): its click handler
  // only fires when the LIVE run carries a rerunWith, so without this the
  // lemma read as a link, was a real button, and did nothing at all on this
  // page -- while the same control works in the reader. That link exists to
  // open exactly the dead end a user with no AI key hits on an inflected
  // form, so swallowing it here costs the feature its reason to exist.
  // Same liveness guard as `rerun`; the re-entry keeps this run's language,
  // slot pair and sentence and only swaps the query, the way md-dict's own
  // rerunWith does with `{ ...cap, text: next }`. It re-points `rerun` at the
  // base form too: the caller's callback re-runs the word this pane was
  // opened for, which is no longer the query on screen after the jump.
  cur.rerunWith = (base) => {
    const next = pbpDictNormalizeTerm(base);
    if (!next || _pbpDictCurrent !== cur) return;
    const again = () => _pbpVocabDictRun(next, lang, els, sentence, again);
    again();
  };
  _pbpDictCurrent = cur;
  const host = $id("vocab-ref-result");
  if (host && host.contains(onlineEl)) host.setAttribute("aria-busy", "true");
  const settled = () => {
    if (host && _pbpVocabDictChildCtrl === child && !child.signal.aborted) host.removeAttribute("aria-busy");
  };
  if (!online) {
    // Open-to-look-up after an offline-pack hit: the local block only. The
    // online chain does not start, so it neither renders nor sends anything;
    // "Look up again" runs the full chain.
    _pbpDictEcdictSide(localEl, term, lang, signal, cur).finally(settled);
    return;
  }
  _pbpDictSlotSkeleton(onlineEl);
  const local = _pbpDictEcdictSide(localEl, term, lang, signal, cur);
  const remote = _pbpDictSlotRun(onlineEl, term, lang, signal, Promise.resolve(""), cur.rerun, cur.sentence)
    .catch((err) => console.warn("library relookup failed:", err.name, err.message));
  Promise.allSettled([local, remote]).then(settled);
}

// Session-only memory of the language the cover lookup uses -- never
// persisted, and independent of any saved word's own language (spec §4.10).
let _vocabLookupLang = "en";
// The open word's id once the user looked it up by hand (the lookup button,
// an empty submit, Look up again). A language change re-runs the full chain
// only for a word looked up by hand; the open-to-look-up path never sets it.
let _pbpVocabRelookedWordId = null;
// The owner the column's content belongs to (spec §7.6). undefined until the
// first _pbpVocabSetAccountState, which therefore always renders the column.
let _pbpVocabRefOwner;

// Open-to-look-up (spec §4.8, user ruling 10-03). Opening a saved word looks
// it up on its own, local first: an installed offline dictionary (ECDICT for
// en, CC-CEDICT for zh), then the dict2_ result cache -- both zero network,
// and either one answering ends it. Only when neither has the word AND the
// freedictionaryapi grant already exists (permissions.contains -- this path
// never calls permissions.request) does it go online, and only after the word
// has stayed open for PBP_VOCAB_AUTO_ONLINE_DELAY_MS, so arrowing through the
// list never sends the words it passes. Without the grant the column shows
// the one button that asks. A word switch, the cover or an account change
// aborts the run, and nothing late is written: every write re-checks the
// run's signal, the open word and the owner. No AI leg, as before.
const PBP_VOCAB_AUTO_ONLINE_DELAY_MS = 250;
let _pbpVocabAutoTimer = 0;

// Zero-network: what the device already knows about this word. A pack that is
// importing, deleted or failing says nothing in the UI (rules/dict.md -- the
// local side is UI-silent) and the lookup falls through to the cache.
async function _pbpVocabLocalProbe(term, lang, signal) {
  const exact = pbpDictNormalizeTerm(term);
  if (!exact || !lang) return null;
  if (lang === "en" || lang === "zh") {
    try {
      const loaded = await _pbpDictLoadPack();
      if (signal.aborted) return null;
      if (loaded && lang === "en" && typeof pbpEcdictLookup === "function") {
        let local = await pbpEcdictLookup(exact);
        if (signal.aborted) return null;
        // Exact first ("e.g." is a headword); on a genuine miss, the cleaned form.
        if (local && local.state === "ready-miss") {
          const cleaned = pbpDictCleanCandidate(exact, lang);
          if (cleaned) {
            local = await pbpEcdictLookup(cleaned);
            if (signal.aborted) return null;
          }
        }
        if (local && local.state === "hit") {
          const norm = pbpEcdictEntryToNorm(local.rows, local.matched);
          if (norm.entries.length) return { source: "ecdict", norm, matched: local.matched };
        }
      }
      if (loaded && lang === "zh" && typeof pbpPackLookup === "function" && typeof pbpCedictLookupKeys === "function") {
        const local = await pbpPackLookup(pbpCedictLookupKeys(pbpDictCleanCandidate(exact, lang) || exact));
        if (signal.aborted) return null;
        if (local && local.state === "hit") {
          return { source: "cedict", norm: pbpCedictEntryToNorm(local.rows, local.matched), matched: local.matched };
        }
      }
    } catch (err) {
      console.warn("library auto lookup: local pack failed:", err.name, err.message);
    }
  }
  const cached = await _pbpDictCacheGet(lang, exact); // swallows its own errors (returns null)
  if (signal.aborted) return null;
  return cached ? { source: "cache", norm: cached, matched: exact } : null;
}

async function _pbpVocabAutoLookup(w) {
  const host = $id("vocab-ref-result");
  const sel = $id("vocab-lookup-lang");
  if (!w || !host || !sel) return "stale";
  // While this runs the column is empty -- never the previous word's result,
  // never the previous language's. aria-busy until it lands on an answer or
  // the button (_pbpVocabRenderRefIdle / _pbpVocabDictRun clear it).
  host.replaceChildren();
  delete host.dataset.sameWord;
  delete host.dataset.refTerm;
  delete host.dataset.refLang;
  host.dataset.refState = "word";
  const owner = _vocabCurrentOwner;
  // The cover and the signed-out page never look anything up on their own.
  if (!String(owner || "").startsWith("acct_")) { _pbpVocabRenderRefIdle("word"); return "idle"; }
  host.setAttribute("aria-busy", "true");
  if (_pbpVocabDictCtrl) _pbpVocabDictCtrl.abort();
  clearTimeout(_pbpVocabAutoTimer);
  const ctrl = new AbortController();
  _pbpVocabDictCtrl = ctrl;
  const signal = ctrl.signal;
  const wordId = w.id;
  // _vocabCurrentOwner is null while renderVocabPanel re-reads: it clears the
  // owner on its first line and puts one back only once the rows land, and an
  // account change aborts this run later still (the reconcile that closes the
  // word). Null is therefore not an answer either way. Before each step that
  // writes or goes online, ownerBack() waits the re-read out; every way out
  // of it either restores an owner or closes the word (aborting this run).
  // Then stale() compares strictly: the same account's re-read carries on,
  // anyone else -- or nobody -- ends the run without a request or a write.
  const ownerBack = () => new Promise((resolve) => {
    const tick = () => {
      if (signal.aborted || _vocabCurrentOwner !== null) resolve();
      else setTimeout(tick, 25);
    };
    tick();
  });
  const stale = () => signal.aborted || _pbpVocabDetailWordId !== wordId ||
    _vocabCurrentOwner !== owner;
  const lang = sel.value || (w.language && w.language !== "und" ? w.language : "") || _vocabLookupLang;
  const sentence = (w.contexts && w.contexts[0] && w.contexts[0].quote) || "";
  const begin = () => {
    const els = _pbpVocabRefSlot();
    host.dataset.refState = "word";
    host.dataset.sameWord = "";
    delete host.dataset.refTerm;
    delete host.dataset.refLang;
    const again = () => { if (!stale()) _pbpVocabDictRun(w.term, lang, els, sentence, again); };
    return { els, again };
  };
  let hit = null;
  try {
    hit = await _pbpVocabLocalProbe(w.term, lang, signal);
  } catch (err) {
    console.warn("library auto lookup: probe failed:", err.name, err.message);
  }
  await ownerBack();
  if (stale()) return "stale";
  if (hit) {
    // An ECDICT hit shows its block alone (online: false). A CC-CEDICT or a
    // cache hit goes through the normal chain, which answers it before the
    // grant check -- still zero network.
    const { els, again } = begin();
    _pbpVocabDictRun(w.term, lang, els, sentence, again, { online: hit.source !== "ecdict" });
    return hit.source === "cache" ? "cache" : "local";
  }
  let granted = false;
  try {
    // Read at the call site, never cached: a grant revoked in
    // chrome://extensions while the page is open has to be seen.
    const perms = typeof chrome !== "undefined" ? chrome.permissions : undefined;
    granted = !!perms && await perms.contains({ origins: [PBP_DICT_ORIGIN + "/*"] });
  } catch (err) {
    console.warn("library auto lookup: grant check failed:", err.name, err.message);
  }
  await ownerBack();
  if (stale()) return "stale";
  if (!granted) { _pbpVocabRenderRefIdle("word"); return "idle"; }
  const { els, again } = begin();
  _pbpDictSlotSkeleton(els.onlineEl);
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, PBP_VOCAB_AUTO_ONLINE_DELAY_MS);
    _pbpVocabAutoTimer = timer;
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  await ownerBack();
  if (stale()) return "stale";
  _pbpVocabDictRun(w.term, lang, els, sentence, again);
  return "online";
}

function _pbpVocabSyncLookupPlaceholder() {
  const input = $id("vocab-lookup-input");
  if (!input) return;
  const label = t(_pbpVocabDetailWordId ? "libraryLookupOther" : "libraryLookupPlaceholder");
  input.placeholder = label;
  input.setAttribute("aria-label", label);
}

// After a relookup the button the user pressed is gone with the old result;
// hand focus to the list box that decides the next one (spec §4.9), and keep
// the column on screen without a smooth scroll.
function _pbpVocabFocusLookupLang() {
  const target = $id("vocab-lookup-lang-btn") || $id("vocab-lookup-lang");
  if (target) {
    try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
  }
  const ref = $id("vocab-ref");
  if (ref) ref.scrollIntoView({ block: "nearest" });
}

// The slot pair md-dict writes into, plus the column's own foot. Slot
// invariant (rules/dict.md): two stable children, and nothing here ever
// replaceChildren()s the slot itself -- only #vocab-ref-result is replaced.
function _pbpVocabRefSlot() {
  const host = $id("vocab-ref-result");
  const wrap = document.createElement("div");
  wrap.className = "xp-dict";
  const slot = document.createElement("div");
  slot.className = "xp-dict-slot";
  const localEl = document.createElement("div");
  localEl.className = "xp-dict-local";
  const onlineEl = document.createElement("div");
  onlineEl.className = "xp-dict-online";
  slot.append(localEl, onlineEl);
  wrap.appendChild(slot);
  // "Look up again" gets its own line under md-dict's source line (spec §4.9,
  // V18): the source line is md-dict's node, and this file never inserts into
  // md-dict's nodes. `refresh` = re-run the same action (icon contract).
  const foot = document.createElement("div");
  foot.className = "vocab-ref-foot";
  const again = document.createElement("button");
  again.type = "button";
  again.className = "btn btn-sm ghost vocab-ref-relookup lib-hang-start";
  setBtnIcon(again, "refresh", t("libraryRelookup"));
  again.addEventListener("click", () => {
    if (host && host.dataset.refState === "other") {
      _pbpVocabLookupOther(host.dataset.refTerm || "", host.dataset.refLang || _vocabLookupLang);
    } else {
      const w = _vocabRows.find((row) => row.id === _pbpVocabDetailWordId);
      if (!w) return;
      _pbpVocabRelookup(w);
    }
    _pbpVocabFocusLookupLang();
  });
  foot.appendChild(again);
  if (host) host.replaceChildren(wrap, foot);
  return { localEl, onlineEl };
}

// The column at rest. "word": an opened word with nothing to show yet and no
// grant -- one button, zero network until it is clicked. "free": the cover
// and the signed-out page -- one line saying the box takes any word.
function _pbpVocabRenderRefIdle(mode) {
  const host = $id("vocab-ref-result");
  if (!host) return;
  host.removeAttribute("aria-busy");
  delete host.dataset.sameWord;
  delete host.dataset.refTerm;
  delete host.dataset.refLang;
  if (mode !== "word") {
    host.dataset.refState = "free";
    const line = document.createElement("p");
    line.className = "vocab-ref-free";
    line.textContent = t("libraryDictIdleFree");
    host.replaceChildren(line);
    return;
  }
  host.dataset.refState = "idle";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-sm ghost vocab-ref-idle";
  setBtnIcon(btn, "book", t("libraryDictIdle"));
  // A local busy flag, not `disabled`: disabling the focused button drops
  // focus to <body>, and a declined prompt would leave the keyboard user
  // nowhere. Declined, focus is simply still on this button.
  let busy = false;
  btn.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    const wordId = _pbpVocabDetailWordId;
    // The grant request is the first thing this click waits on: waiting on
    // anything before it would spend the user gesture Chrome requires
    // (md-dict's connect button follows the same rule). Read at the call site, never
    // cached: a grant revoked in chrome://extensions has to be seen.
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [PBP_DICT_ORIGIN + "/*"] });
    } catch (err) {
      console.warn("library dictionary grant failed:", err.name, err.message);
    }
    busy = false;
    if (!granted || _pbpVocabDetailWordId !== wordId) return;
    const w = _vocabRows.find((row) => row.id === wordId);
    if (!w) return;
    _pbpVocabRelookup(w);
    _pbpVocabFocusLookupLang();
  });
  host.replaceChildren(btn);
}

// A word change (or the cover, or an account change on the cover) starts the
// column clean: the run stops, the box empties, the manual mark drops, and
// the list box shows the open word's language (spec §4.10 -- an "und" word
// leaves it alone) or, on the cover, the session language. For a word,
// open-to-look-up takes over the column (T7c).
function _pbpVocabResetRef(w) {
  if (_pbpVocabDictCtrl) { _pbpVocabDictCtrl.abort(); _pbpVocabDictCtrl = null; }
  clearTimeout(_pbpVocabAutoTimer);
  _pbpVocabRelookedWordId = null;
  const input = $id("vocab-lookup-input");
  if (input) input.value = "";
  const sel = $id("vocab-lookup-lang");
  if (sel) {
    const code = w && w.language && w.language !== "und" ? w.language : "";
    if (!w) sel.value = _vocabLookupLang;
    else if (code && [...sel.options].some((o) => o.value === code)) sel.value = code;
    window.pbpListboxSync?.(sel);
  }
  _pbpVocabSyncLookupPlaceholder();
  if (w) _pbpVocabAutoLookup(w).catch((err) => console.warn("library auto lookup failed:", err.name, err.message));
  else _pbpVocabRenderRefIdle("free");
}

// The manual full chain for the open word: local pack + cache + online,
// exactly today's "Look up again". The list box decides the language.
function _pbpVocabRelookup(w) {
  const host = $id("vocab-ref-result");
  const sel = $id("vocab-lookup-lang");
  if (!w || !host || !sel) return;
  _pbpVocabRelookedWordId = w.id;
  if (_pbpVocabDictCtrl) _pbpVocabDictCtrl.abort();
  clearTimeout(_pbpVocabAutoTimer);
  _pbpVocabDictCtrl = new AbortController();
  const els = _pbpVocabRefSlot();
  host.dataset.refState = "word";
  host.dataset.sameWord = "";
  delete host.dataset.refTerm;
  delete host.dataset.refLang;
  const lang = sel.value || (w.language && w.language !== "und" ? w.language : "") || _vocabLookupLang;
  const sentence = (w.contexts && w.contexts[0] && w.contexts[0].quote) || "";
  const run = () => _pbpVocabDictRun(w.term, lang, els, sentence, run);
  run();
}

// Another word's result, in the column (spec §4.8 submit rules, V6): the main
// column, the open word and the current row stay. Its own head names the word
// (with Pronounce, kept from the old free-lookup view) and, when that word is
// saved, the "In your vocabulary · view" door.
function _pbpVocabLookupOther(term, lang) {
  const host = $id("vocab-ref-result");
  if (!host || !term) return;
  _pbpVocabRelookedWordId = null;
  if (_pbpVocabDictCtrl) _pbpVocabDictCtrl.abort();
  clearTimeout(_pbpVocabAutoTimer);
  _pbpVocabDictCtrl = new AbortController();
  const els = _pbpVocabRefSlot();
  host.dataset.refState = "other";
  host.dataset.refTerm = term;
  host.dataset.refLang = lang;
  delete host.dataset.sameWord;
  const head = document.createElement("div");
  head.className = "vocab-ref-head";
  const termEl = document.createElement("span");
  termEl.className = "vocab-ref-term";
  termEl.lang = lang;
  termEl.textContent = term;
  head.appendChild(termEl);
  const speak = document.createElement("button");
  speak.type = "button";
  speak.className = "btn btn-sm ghost vocab-ref-speak";
  setBtnIcon(speak, "speaker", "");
  speak.title = t("dictSpeak");
  speak.setAttribute("aria-label", t("dictSpeak"));
  speak.addEventListener("click", () => pbpDictSpeak(term, lang));
  head.appendChild(speak);
  const folded = pbpVocabSearchText(term);
  const saved = _vocabRows.find((r) => pbpVocabSearchText(r.term) === folded);
  if (saved) {
    const hint = document.createElement("button");
    hint.type = "button";
    hint.className = "btn btn-sm ghost vocab-lookup-saved";
    setBtnIcon(hint, "bookMarked", t("libraryLookupSaved"));
    hint.addEventListener("click", () => {
      // The hint outlives reloads while this result stays on screen: re-read
      // the CURRENT rows, and a vanished id is a no-op, never a ghost detail.
      const fresh = _vocabRows.find((r) => r.id === saved.id);
      if (!fresh) return;
      _pbpVocabRenderDetail(fresh, true);
      _pbpVocabMarkCurrentRow(fresh.id);
      const row = document.querySelector(`#vocab-list .vocab-card[data-vocab-id="${CSS.escape(fresh.id)}"]`);
      if (row) row.scrollIntoView({ block: "nearest" });
    });
    head.appendChild(hint);
  }
  host.prepend(head);
  // `lang`, not the list box: md-dict's rerun fires long after submit, and by
  // then the list box may name the language picked for the NEXT lookup.
  const run = () => _pbpVocabDictRun(term, lang, els, "", run);
  run();
}

// Submit (Enter or "Look up"). Empty = the open word by hand (spec §4.8);
// on the cover an empty submit sends nothing and only puts the caret back.
function _pbpVocabFreeLookup() {
  const input = $id("vocab-lookup-input");
  const sel = $id("vocab-lookup-lang");
  if (!input || !sel) return;
  const term = (input.value || "").trim();
  if (!term) {
    const w = _pbpVocabDetailWordId ? _vocabRows.find((row) => row.id === _pbpVocabDetailWordId) : null;
    if (w) _pbpVocabRelookup(w);
    else { try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); } }
    return;
  }
  _pbpVocabLookupOther(term, sel.value || _vocabLookupLang);
}

// spec §4.10: only the cover and "another word's result" write the session
// language. With a word open, a hand lookup re-runs the full chain in the new
// language; a word not looked up by hand re-runs open-to-look-up in the new
// language (local, cache, then online only with the grant).
function _pbpVocabLookupLangChanged() {
  const sel = $id("vocab-lookup-lang");
  const host = $id("vocab-ref-result");
  if (!sel) return;
  if (host && host.dataset.refState === "other") {
    _vocabLookupLang = sel.value;
    _pbpVocabLookupOther(host.dataset.refTerm || "", sel.value);
    return;
  }
  const w = _pbpVocabDetailWordId ? _vocabRows.find((row) => row.id === _pbpVocabDetailWordId) : null;
  if (!w) { _vocabLookupLang = sel.value; return; }
  if (_pbpVocabRelookedWordId === w.id) _pbpVocabRelookup(w);
  else _pbpVocabAutoLookup(w).catch((err) => console.warn("library auto lookup failed:", err.name, err.message));
}

// One-time wiring for the lookup row, from the guarded top-level section at
// the bottom of this file. Option labels use uiLangToBCP47(), not <html lang>:
// this runs before library.js's applyI18n sets the page language.
function _pbpVocabWireLookupBar() {
  const input = $id("vocab-lookup-input");
  const sel = $id("vocab-lookup-lang");
  const go = $id("vocab-lookup-go");
  if (!input || !sel || !go) return; // absent on pages/fixtures with no lookup row
  const locale = typeof uiLangToBCP47 === "function" ? uiLangToBCP47() : document.documentElement.lang;
  for (const code of PBP_DICT_LANGS) {
    if (code === "auto") continue; // a stored word carries a language; no Auto leg here
    const o = document.createElement("option");
    o.value = code;
    o.textContent = pbpDictLanguageLabel(code, locale) || code;
    sel.appendChild(o);
  }
  sel.value = _vocabLookupLang;
  sel.addEventListener("change", _pbpVocabLookupLangChanged);
  go.addEventListener("click", _pbpVocabFreeLookup);
  input.addEventListener("keydown", (e) => {
    // IME guard: the Enter that confirms a candidate belongs to the composition.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") _pbpVocabFreeLookup();
  });
}

// Narrow (single-pane) mode. Mirrors library.css's 860px threshold -- the CSS
// is the source of truth and the responsive sweep guards it; this is the same
// number, not a second layout rule. matchMedia rather than reading the list
// pane's computed display: this runs right after the class flip on a click
// path, and a computed-style read there forces a style recalc for an answer
// that only depends on the viewport.
function _pbpVocabNarrowMode() {
  return typeof matchMedia === "function" && matchMedia("(max-width: 860px)").matches;
}

// Entering the detail in narrow mode hides the whole list, INCLUDING whatever
// was focused to get here (a row's head button, the lookup box). Chrome then
// drops focus to <body>, so the next Tab restarts at the top of the page with
// no way back. Hand it to the one control that returns to the list.
function _pbpVocabFocusNarrowBack() {
  if (!_pbpVocabNarrowMode()) return;
  const back = $id("vocab-detail-back");
  if (!back) return;
  try { back.focus({ preventScroll: true }); } catch (_) { back.focus(); }
}

// Where the vocabulary status sentence lives. #vocab-status is markup inside
// .vocab-context-bar, which belongs to the LIST pane -- and below the two-pane
// threshold `body.lib-narrow-detail .vocab-list-pane` takes that whole pane off
// the page while a word is open. Every single-word action fires from the detail
// pane in exactly that state (note save, status toggle, group +/-, a group
// chip's x), so both "saved" and "save failed / account changed / refresh
// failed" landed in a display:none subtree: invisible, and silent to a screen
// reader, which ignores live regions that are not rendered. Move the one node
// into the detail's own closing row while the list is off the page and hand it
// back when the list returns -- the seam library-notes.js's _pbpNotesStatusHost
// already owns for the highlight view. Deliberately OUTSIDE
// _pbpVocabFlashStatus: that function is a byte-identical twin of
// options-vocab.js's copy (tests/ui-contract-tests.mjs pins it), and the
// options page has no detail pane to move anything into.
let _vocabStatusDetailReady = false;
function _pbpVocabStatusHost(detailReady) {
  // `undefined` = re-home only (the batch row opening or closing, T4b); the
  // detail's readiness is whatever the last render said it was.
  if (detailReady !== undefined) _vocabStatusDetailReady = !!detailReady;
  const el = $id("vocab-status");
  const bar = $id("vocab-context-bar");
  if (!el || !bar) return el || null;
  // spec §4.7, first match wins: a selection whose batch row is on screen ->
  // its slot (T4); a detail in its final shape -> the tail's footer, at ANY
  // width (a behaviour change: the two-pane layout used to keep it in the
  // count row), between the delete and Save; otherwise -> the count row,
  // before Select all. The batch row lives in the list pane, which narrow
  // detail takes off the page (display: none at <=860): "on screen" is read
  // from what is rendered, not from _pbpVocabNarrowMode, so a selection kept
  // across that switch never parks the live region in an invisible slot.
  // `detailReady` false is the caller about to replaceChildren() the detail
  // or the tail: park the node in the count row first, or it is removed with
  // that subtree and every later message is written into nothing ($id would
  // re-query and miss).
  const pane = $id("vocab-list-pane");
  const listGone = !pane || pane.getClientRects().length === 0;
  const batch = $id("vocab-batch-toolbar");
  const slot = !listGone && batch && batch.classList.contains("selecting") ? batch.querySelector(".lib-batch-status") : null;
  const footer = _vocabStatusDetailReady ? document.querySelector("#vocab-detail-tail .vocab-detail-footer") : null;
  const host = slot || footer || bar;
  if (host === footer) {
    const save = footer.querySelector(".vocab-note-save");
    if (el.parentNode !== footer || el.nextElementSibling !== save) footer.insertBefore(el, save);
  } else if (el.parentNode !== host) {
    if (host === bar) bar.insertBefore(el, bar.querySelector(":scope > .lib-cluster"));
    else host.appendChild(el);
  }
  return el;
}

// Split the quote around case-insensitive matches of the term; matches render
// in <mark>. textContent-only construction — no innerHTML with stored text.
function _pbpVocabHighlightTerm(host, quote, term) {
  const needle = (term || "").toLowerCase();
  if (!needle) { host.textContent = quote; return; }
  const lower = quote.toLowerCase();
  // Every offset below is computed on the folded copy and then used to slice
  // the ORIGINAL, which only works while the fold preserves length -- and
  // toLowerCase does not: U+0130 (Turkish dotted capital I) folds to two code
  // units, so from the first one onward the marks wrap text that never
  // matched. Nothing upstream normalizes these away, so drop the highlight
  // rather than point at the wrong characters; the quote itself still reads
  // in full.
  if (lower.length !== quote.length) { host.textContent = quote; return; }
  let idx = 0, pos = lower.indexOf(needle);
  while (pos !== -1) {
    host.appendChild(document.createTextNode(quote.slice(idx, pos)));
    const mark = document.createElement("mark");
    mark.textContent = quote.slice(pos, pos + needle.length);
    host.appendChild(mark);
    idx = pos + needle.length;
    pos = lower.indexOf(needle, idx);
  }
  host.appendChild(document.createTextNode(quote.slice(idx)));
}

// A detail-pane edit acts on ONE word; it is not a batch action, so the list
// selection it never touched must survive its reload. _pbpVocabReloadAfterMutation
// clears the selection unconditionally -- correct for the batch-bar callers,
// wrong for these. Snapshot before, hand it back after, and let
// _pbpVocabSyncSelectionUi prune whatever the fresh rows no longer contain
// (the same pruning _pbpVocabSoftReload leans on).
function _pbpVocabHoldSelection(gen) {
  const saved = new Set(_vocabSelected);
  const anchor = _vocabLastSelectedId;
  return () => {
    if (gen !== _vocabRenderGen || !saved.size) return;
    _vocabSelected = new Set(saved);
    _vocabLastSelectedId = anchor;
    _pbpVocabSyncSelectionUi();
  };
}

// The detail's writes (status, groups, note) act for the owner the detail was
// rendered for, never for whoever is signed in by the time the click's owner
// read returns (CLAUDE.md account isolation). On a mismatch nothing is
// written; this click took the render generation, so it re-renders the panel
// for the account that is signed in now. Returns whether to abandon.
function _pbpVocabOwnerMoved(owner, renderOwner, gen) {
  if (owner === renderOwner && String(owner || "").startsWith("acct_")) return false;
  console.warn("vocab detail write abandoned: the account changed under the open word");
  if (gen === _vocabRenderGen) renderVocabPanel();
  return true;
}

// Shared single-word mutation wrapper: owner + generation discipline identical
// to the batch actions (mutation at confirm, reload after, stale writes dropped).
// `renderOwner` is the owner the detail was rendered for: a click whose owner
// read comes back as someone else (the account moved under the open word)
// writes nothing and hands the page to the account-change render.
async function _pbpVocabDetailMutate(w, mutate, renderOwner) {
  const gen = ++_vocabRenderGen;
  let owner = null;
  const restoreSelection = _pbpVocabHoldSelection(gen);
  try {
    owner = await pbpVocabCurrentOwner();
    if (_pbpVocabOwnerMoved(owner, renderOwner, gen)) return;
    const ok = await mutate(owner);
    const refreshed = await _pbpVocabReloadAfterMutation(owner, gen);
    restoreSelection();
    if (gen !== _vocabRenderGen) return;
    if (!ok) _pbpVocabFlashStatus(false, t("vocabBatchFailed"));
    else if (!refreshed) _pbpVocabFlashStatus(false, t("vocabRefreshFailed"));
  } catch (err) {
    console.warn("vocab detail mutate failed:", err.name, err.message);
    if (owner) { await _pbpVocabReloadAfterMutation(owner, gen); restoreSelection(); }
    if (gen === _vocabRenderGen) _pbpVocabFlashStatus(false, t("vocabBatchFailed"));
  }
}

// Verbatim twin: options-vocab.js and library-vocab.js each carry this
// helper (the pages never co-load, and since the phase-A test split neither
// does the test suite -- tests/ui-contract-tests.mjs statically asserts the
// two definitions stay byte-identical, so an edit to one without the other
// fails that check instead of silently drifting).
function _pbpVocabFlashStatus(ok, text) {
  const el = $id("vocab-status");
  if (!el) return;
  delete el.dataset.vocabLoading;
  setStatusIcon(el, ok, text);
  // Two flashes in quick succession (e.g. export then Anki) must not race:
  // the earlier call's clear-timer would otherwise wipe the later message.
  clearTimeout(_vocabFlashTimer);
  _vocabFlashTimer = setTimeout(() => { el.textContent = ""; }, 3000);
}

function _pbpVocabSetLoading(loading) {
  const list = $id("vocab-list");
  if (list) list.setAttribute("aria-busy", loading ? "true" : "false");
  // The filter row's wide / narrow form is decided once the counts have
  // landed (library.js pbpLibVocabFilterNeed): every path that ends a load
  // renders its final counts in the same task, so the decision lands with
  // them -- and an empty word list still gets one.
  const toggles = $id("vocab-status-toggles");
  if (toggles) toggles.toggleAttribute("data-counts-ready", !loading);
  const status = $id("vocab-status");
  if (!status) return;
  if (loading) {
    clearTimeout(_vocabFlashTimer);
    status.classList.remove("ok", "bad");
    status.dataset.vocabLoading = "true";
    status.textContent = t("vocabLoading");
  } else if (status.dataset.vocabLoading === "true") {
    delete status.dataset.vocabLoading;
    status.textContent = "";
  }
}

// Returns whether focus actually LANDED, the twin of library-notes.js's
// _pbpNotesFocus: focus() on a disabled/hidden/inert field is a silent no-op,
// and a caller that follows up with select() would then be selecting text in a
// box the caret never reached. Every other caller here uses it for its side
// effect only and ignores the value.
function _pbpVocabFocusStable() {
  const search = $id("vocab-search");
  if (!search || search.disabled || search.closest("[hidden], [inert]")) return false;
  try { search.focus({ preventScroll: true }); } catch (_) { search.focus(); }
  return document.activeElement === search;
}

function pbpVocabSelectionSnapshotValid(ids, selected, rows) {
  const captured = Array.isArray(ids) ? ids : [];
  const selectedIds = selected instanceof Set ? selected : new Set(selected || []);
  const unique = new Set(captured);
  if (unique.size !== captured.length || unique.size !== selectedIds.size) return false;
  const visibleIds = new Set((Array.isArray(rows) ? rows : []).map((row) => row && row.id));
  return captured.every((id) => selectedIds.has(id) && visibleIds.has(id));
}

// Same anchored confirm popover as every other destructive micro-action
// (notes, theme delete, tab reset) -- never a blocking browser dialog. Owner is
// re-derived at action time, not reused from the render pass, so a delete
// confirmed after an account switch still checks against the CURRENT
// account (account-isolation invariant).
function _pbpVocabDeleteRow(w, anchor) {
  showConfirmPopover(anchor, {
    msg: t("dictDeleteConfirm", w.term),
    yesText: t("delete"),
    noText: t("cancel"),
    onConfirm: async () => {
      // Share renderVocabPanel's generation: every confirmed mutation gets
      // a UI-commit ticket immediately, so a later user action supersedes an
      // older reload even when the older IDB snapshot resolves last.
      const gen = ++_vocabRenderGen;
      let owner = null;
      // Whole body in try/catch: showConfirmPopover only console.errors a
      // rejected onConfirm, so a thrown owner read (or anything else here)
      // would otherwise vanish with no user-visible feedback.
      try {
        owner = await pbpVocabCurrentOwner();
        const ok = await pbpVocabDelete(w.id, owner);
        // Only a confirmed delete collapses the card -- a failed one would
        // fold and then pop back on the reconciling re-render.
        if (ok) _pbpVocabMarkExit([anchor.closest(".notes-card")]);
        // Re-read on failure too: an earlier overlapping mutation may have
        // committed already, and this latest action owns the final reconcile.
        const refreshed = await _pbpVocabReloadAfterMutation(owner, gen);
        if (gen !== _vocabRenderGen) return;
        // The confirm popover handed focus back to the delete button, which
        // the reload has just rebuilt away -- without this, focus lands on
        // <body>. Same landing spot every batch action already uses.
        _pbpVocabFocusStable();
        if (!ok) _pbpVocabFlashStatus(false, t("dictDeleteFailed"));
        else if (!refreshed) _pbpVocabFlashStatus(false, t("vocabRefreshFailed"));
      } catch (_) {
        if (owner) await _pbpVocabReloadAfterMutation(owner, gen);
        else if (gen === _vocabRenderGen) {
          _pbpVocabClearVisibleState();
          _pbpVocabSetLoading(false);
        }
        if (gen === _vocabRenderGen) {
          _pbpVocabFocusStable();
          _pbpVocabFlashStatus(false, t("dictDeleteFailed"));
        }
      }
    },
  });
}

function _pbpVocabClearSelection() {
  _vocabSelected.clear();
  _vocabLastSelectedId = null;
}

// "None of the selected words are in this group" is the one disable reason
// with nothing on screen behind it, and a disabled button is the worst place
// to keep it: it takes no Tab focus, so its title is unreachable by keyboard,
// and a touch screen has no hover to reveal one either. Give the reason a
// permanent, hideable home in the bar and point both controls it is about at
// it with aria-describedby -- a hidden description is ignored, so it only
// speaks while it is true. Built here rather than in the markup because t()
// is only correct after applyI18n has settled the chosen UI language (same
// timing note as _pbpVocabWireLookupBar); it reuses #vocab-remove-group's own
// string, so no new locale key. Reuses an element from the markup if one
// with this id is ever added there.
function _pbpVocabGroupHelpEl() {
  const existing = $id("vocab-remove-group-help");
  if (existing) return existing;
  const bar = $id("vocab-batch-toolbar");
  if (!bar || !$id("vocab-remove-group")) return null; // options.html has no batch bar
  const el = document.createElement("span");
  el.id = "vocab-remove-group-help";
  el.className = "vocab-group-help";
  el.textContent = t("vocabRemoveGroupNoMatch");
  el.hidden = true;
  // Last child, on its own wrapped line: inserting it next to the unit it
  // describes would push the action cluster onto a second row every time it
  // appeared, and the actions' order is the stable thing here.
  bar.appendChild(el);
  for (const host of [$id("vocab-group-input"), $id("vocab-remove-group")]) {
    if (host) host.setAttribute("aria-describedby", el.id);
  }
  return el;
}

function _pbpVocabSyncSelectionUi() {
  const validIds = new Set(_vocabViewRows.map((row) => row.id));
  for (const id of [..._vocabSelected]) if (!validIds.has(id)) _vocabSelected.delete(id);
  // Keep every visible row's band and aria-selected in step with the
  // selection set (shift-range and select-all mutate rows that were not the
  // click target). The two must move together: the fill is the sighted
  // user's only cue and aria-selected is everyone else's.
  document.querySelectorAll("#vocab-list > .vocab-card").forEach((el) => {
    const on = _vocabSelected.has(el.dataset.vocabId);
    el.classList.toggle("selected", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
  });
  const selectedCount = _vocabSelected.size;
  const selectedEl = $id("vocab-selected-count");
  if (selectedEl) pbpLibFillCount(selectedEl, pbpLibSplitCount((...a) => t("vocabSelectedCount", ...a), [String(selectedCount)]), () => "b");
  // The batch row replaces the count row in place (spec §3.9), and the status
  // live region follows whichever of the two is on screen (spec §4.7).
  const toolbar = $id("vocab-batch-toolbar");
  if (toolbar) toolbar.classList.toggle("selecting", selectedCount > 0);
  const ctxBar = $id("vocab-context-bar");
  if (ctxBar) ctxBar.hidden = selectedCount > 0;
  _pbpVocabStatusHost();
  const batchAll = $id("vocab-batch-select-all");
  if (batchAll) batchAll.disabled = _vocabBatchBusy || !_vocabViewRows.length || selectedCount >= _vocabViewRows.length;
  const allBtn = $id("vocab-select-all");
  const invertBtn = $id("vocab-invert-selection");
  if (allBtn) allBtn.disabled = _vocabBatchBusy || !_vocabViewRows.length;
  if (invertBtn) invertBtn.disabled = _vocabBatchBusy || !_vocabViewRows.length;
  const groupInput = $id("vocab-group-input");
  const addBtn = $id("vocab-add-group");
  const deleteBtn = $id("vocab-batch-delete");
  const group = groupInput && typeof pbpVocabNormalizeGroupName === "function"
    ? pbpVocabNormalizeGroupName(groupInput.value) : "";
  const removeBtn = $id("vocab-remove-group");
  if (groupInput) groupInput.disabled = _vocabBatchBusy;
  if (addBtn) addBtn.disabled = _vocabBatchBusy || !selectedCount || !group;
  // Remove additionally needs the typed group to actually be on something in the
  // selection. Enabling it symmetrically with add would let a click report "12
  // removed" while changing nothing.
  if (removeBtn) {
    const inGroup = group && selectedCount ? _pbpVocabSelectedInGroup(group) : 0;
    const noMatch = !!(group && selectedCount && !inGroup);
    removeBtn.disabled = _vocabBatchBusy || !selectedCount || !group || !inGroup;
    // "Selection and group don't overlap" is the one disable condition nothing
    // on screen explains; say it on hover. The fallback is the button's full
    // label -- it is icon-only now, so the title doubles as its tooltip name.
    // Never via #vocab-status, a live region the batch results keep rewriting.
    removeBtn.title = noMatch ? t("vocabRemoveGroupNoMatch") : t("vocabRemoveFromGroup");
    // The same sentence in text, for everyone the hover title never reaches
    // (see _pbpVocabGroupHelpEl).
    const help = _pbpVocabGroupHelpEl();
    if (help) help.hidden = !noMatch;
  }
  if (deleteBtn) deleteBtn.disabled = _vocabBatchBusy || !selectedCount;
  const knownBtn = $id("vocab-mark-known");
  const learningBtn = $id("vocab-mark-learning");
  if (knownBtn) knownBtn.disabled = _vocabBatchBusy || !selectedCount;
  if (learningBtn) learningBtn.disabled = _vocabBatchBusy || !selectedCount;
}

// How many currently-selected words carry `group`. Reads the rendered view rows,
// which are the same rows the selection was validated against.
function _pbpVocabSelectedInGroup(group) {
  if (!group) return 0;
  return _vocabViewRows.filter((row) => _vocabSelected.has(row.id) && pbpVocabGroups(row).includes(group)).length;
}

function _pbpVocabRefreshGroupOptions(preserveSelection) {
  const filter = $id("vocab-group-filter");
  const datalist = $id("vocab-group-list");
  const groups = [...new Set(_vocabRows.flatMap((row) => pbpVocabGroups(row)))]
    .sort((a, b) => _vocabCollator.compare(a, b));
  if (filter) {
    const previous = preserveSelection ? filter.value : "";
    filter.replaceChildren();
    const all = document.createElement("option");
    all.value = "";
    all.textContent = t("vocabAllGroups");
    filter.appendChild(all);
    for (const group of groups) {
      const option = document.createElement("option");
      option.value = group;
      option.textContent = group;
      filter.appendChild(option);
    }
    filter.value = groups.includes(previous) ? previous : "";
    // A programmatic .value write fires no change event; listbox.js's button
    // would keep naming a group this refresh just dropped. Optional call: the
    // test pages do not load listbox.js.
    window.pbpListboxSync?.(filter);
  }
  if (datalist) {
    datalist.replaceChildren(...groups.map((group) => {
      const option = document.createElement("option");
      option.value = group;
      return option;
    }));
  }
}

function _pbpVocabRenderList(append) {
  const list = $id("vocab-list");
  if (!list) return;
  const rows = _vocabViewRows;
  const empty = $id("vocab-empty");
  if (empty) {
    empty.textContent = t("dictVocabEmpty", _vocabOwnerLabel);
    empty.hidden = _vocabRows.length !== 0;
  }
  const noResults = $id("vocab-no-results");
  if (noResults) noResults.hidden = _vocabRows.length === 0 || rows.length !== 0;
  const target = Math.min(rows.length, _vocabRenderLimit);
  const start = append ? Math.min(list.children.length, target) : 0;
  if (!append) list.replaceChildren();
  const fragment = document.createDocumentFragment();
  rows.slice(start, target).forEach((w) => fragment.appendChild(_pbpVocabBuildRow(w)));
  list.appendChild(fragment);
  const more = $id("vocab-load-more");
  if (more) {
    const remaining = Math.max(0, rows.length - target);
    more.hidden = remaining === 0;
    more.textContent = t("vocabLoadMore", String(Math.min(PBP_VOCAB_RENDER_BATCH, remaining)));
  }
  _pbpVocabSyncSelectionUi();
  // Full rebuilds (append=false: search/filter/sort/reload) replace every
  // row, dropping the aria-current marker set by row activation even though
  // the detail pane still shows that word. Re-find it by id and re-mark it --
  // this covers search/filter/sort here; _pbpVocabReloadAfterMutation covers
  // its own reload the same way, since that path also re-renders the
  // detail pane's content (not just the marker).
  if (!append && _pbpVocabDetailWordId) _pbpVocabMarkCurrentRow(_pbpVocabDetailWordId);
  // After the marker, not before: the current row is the stop this prefers.
  _pbpVocabSyncRowTabStops();
  // Counts follow every full rebuild (search / filter / sort / reload /
  // soft reload); Load more appends rows and changes no count.
  if (!append) _pbpVocabRenderStats();
}

// The count row and the three status toggles (spec §3.2 / §3.5), from the full
// owner row set; only the first item reads the filtered view. Re-run by every
// full list rebuild (see _pbpVocabRenderList) and cleared with the rest of
// the list by _pbpVocabClearVisibleState.
function _pbpVocabRenderStats() {
  const count = $id("vocab-count");
  const toggles = ["vocab-stat-all", "vocab-stat-learning", "vocab-stat-known"].map((id) => $id(id)).filter(Boolean);
  _pbpVocabSyncFilterNarrow();
  if (!_vocabRows.length) {
    for (const el of toggles) el.hidden = true;
    pbpLibRenderCount(count, [], "");
    return;
  }
  const s = pbpVocabStats(_vocabRows, Date.now());
  const rows = _vocabViewRows;
  const filterValue = ($id("vocab-status-filter") || {}).value || "";
  const numbered = { "vocab-stat-learning": ["libraryStatsLearning", s.learning], "vocab-stat-known": ["libraryStatsKnown", s.known] };
  for (const el of toggles) {
    el.hidden = false;
    el.setAttribute("aria-pressed", String((el.dataset.status || "") === filterValue));
    const spec = numbered[el.id];
    if (!spec) { el.textContent = t("libraryFilterAll"); continue; }
    pbpLibFillCount(el, pbpLibSplitCount((...a) => t(spec[0], ...a), [String(spec[1])]), () => "span");
    for (const num of el.querySelectorAll(".lib-count-num")) num.classList.add("lib-toggle-count");
  }
  const words = rows.length !== s.total
    ? pbpLibSplitCount((...a) => t("libraryStatsWordsFiltered", ...a), [String(rows.length), String(s.total)])
    : pbpLibSplitCount((...a) => t("libraryStatsWords", ...a), [String(s.total)]);
  const items = [
    words,
    pbpLibSplitCount((...a) => t("libraryStatsGroups", ...a), [String(s.groups)]),
    pbpLibSplitCount((...a) => t("libraryStatsLanguages", ...a), [String(s.languages)]),
    pbpLibSplitCount((...a) => t("libraryStatsRecent7", ...a), [String(s.added7)]),
  ];
  const full = [
    t("vocabResultCount", String(rows.length), String(_vocabRows.length), _vocabOwnerLabel),
    t("libraryStatsRecent", String(s.added7), String(s.added30)),
  ].join(" \u00b7 ");
  pbpLibRenderCount(count, items, full);
}

function _pbpVocabApplyView(resetLimit) {
  if (resetLimit) _vocabRenderLimit = PBP_VOCAB_RENDER_BATCH;
  _vocabViewRows = pbpVocabFilterSort(_vocabRows,
    ($id("vocab-search") || {}).value || "",
    ($id("vocab-group-filter") || {}).value || "",
    ($id("vocab-sort") || {}).value || "latest",
    ($id("vocab-status-filter") || {}).value || "");
  _pbpVocabRenderList();
  _pbpVocabRenderCover();
}

// The cover (spec §4.11): a display title, one stats sentence, one hint. The
// sentence waits for the first count (no flash of zeroes), says so when the
// read failed, names the account when there are no words, and points at the
// Dictionary column when signed out. Numbers are bolded by the sentinel split
// (library.js), never by building markup.
function _pbpVocabRenderCover() {
  const cover = $id("vocab-detail-empty");
  if (!cover) return;
  const title = cover.querySelector(".lib-cover-title");
  const lead = cover.querySelector(".lib-cover-lead");
  const hint = cover.querySelector(".lib-cover-hint");
  if (title) title.textContent = t("libraryVocabCoverTitle");
  if (!lead || !hint) return;
  lead.replaceChildren();
  hint.hidden = true;
  const pane = $id("vocab-list-pane");
  if (pane && pane.classList.contains("vocab-signed-out")) { lead.textContent = t("libraryLookupSignedOutHint"); return; }
  if (cover.dataset.loadFailed === "true") { lead.textContent = t("vocabLoadFailed"); return; }
  if (!String(_vocabCurrentOwner || "").startsWith("acct_")) return;
  if (!_vocabRows.length) { lead.textContent = t("dictVocabEmpty", _vocabOwnerLabel); return; }
  hint.hidden = false;
  if (typeof pbpLibSplitCount !== "function" || typeof pbpLibFillCount !== "function") return;
  const s = pbpVocabStats(_vocabRows, Date.now());
  const day = typeof pbpLibFormatDay === "function" ? pbpLibFormatDay(s.latestCreatedAt) : "";
  // Rows that carry no creation time (older imports) have no "last added"
  // day: the sentence ends after the counts instead of "on ." with nothing.
  const counts = [String(s.total), String(s.learning), String(s.known), String(s.languages)];
  const parts = day
    ? pbpLibSplitCount((...a) => t("libraryVocabCoverLead", ...a), [...counts, day])
    : pbpLibSplitCount((...a) => t("libraryVocabCoverLeadNoDate", ...a), counts);
  pbpLibFillCount(lead, parts, (index) => (index >= 0 && index < 4 ? "b" : null));
}

function _pbpVocabCoverLoadFailed() {
  const cover = $id("vocab-detail-empty");
  if (cover) cover.dataset.loadFailed = "true";
  _pbpVocabRenderCover();
}

function _pbpVocabSetAccountState(owner) {
  const signedOut = !String(owner || "").startsWith("acct_");
  const pane = $id("vocab-list-pane");
  const empty = $id("vocab-no-account");
  if (pane) pane.classList.toggle("vocab-signed-out", signedOut);
  if (empty) empty.hidden = !signedOut;
  // spec §7.6: a different owner starts the page over. A word was open ->
  // every account-change path renders the cover first, which already reset
  // the column; on the cover nothing renders, so reset it here. The filters go
  // back to their defaults and the list returns to its top.
  if (owner !== _pbpVocabRefOwner) {
    _pbpVocabRefOwner = owner;
    if (_pbpVocabDetailWordId === null) _pbpVocabResetRef(null);
    const status = $id("vocab-status-filter");
    if (status) status.value = "";
    const group = $id("vocab-group-filter");
    if (group) { group.value = ""; window.pbpListboxSync?.(group); }
    _pbpVocabResetListScroll();
  }
  _pbpVocabRenderCover();
}

function _pbpVocabClearVisibleState() {
  _vocabRows = [];
  _vocabViewRows = [];
  _vocabOwnerLabel = "";
  _vocabCurrentOwner = null;
  const pane = $id("vocab-list-pane");
  if (pane) pane.classList.remove("vocab-signed-out");
  const noAccount = $id("vocab-no-account");
  if (noAccount) noAccount.hidden = true;
  _pbpVocabClearSelection();
  const list = $id("vocab-list");
  if (list) list.replaceChildren();
  _pbpVocabSetLoading(true);
  // (The batch bar is class-driven, not hidden-attribute driven; its
  // .selecting class clears via _pbpVocabSyncSelectionUi right below.)
  for (const id of ["vocab-empty", "vocab-no-results", "vocab-load-more"]) {
    const el = $id(id); if (el) el.hidden = true;
  }
  _pbpVocabRefreshGroupOptions(false);
  _pbpVocabRenderStats();
  _pbpVocabSyncSelectionUi();
  const cover = $id("vocab-detail-empty");
  if (cover) delete cover.dataset.loadFailed;
  _pbpVocabRenderCover();
}

// Which control in the REBUILT pane inherits the focus the rebuild is about
// to destroy, in preference order. Class-based, because every node in the pane
// is replaced: the status toggle keeps its slot in the manage row while its
// label flips, the group stepper's input is rebuilt with the draft
// name already carried into it, and Save is hidden again the moment the note
// it committed matches the store -- so the field it belongs to is the honest
// landing spot. A removed group chip has no counterpart at all; the input on
// its own row is the nearest thing the user was working in.
function _pbpVocabDetailFocusTargets(el) {
  if (!el) return [];
  if (el.classList.contains("vocab-note-save")) return [".vocab-note-save", ".vocab-note-input"];
  if (el.closest(".vocab-note-edit")) return [".vocab-note-input"];
  if (el.closest(".vocab-group-unit") || el.classList.contains("chip-remove")) return [".vocab-group-unit input", ".vocab-edit-groups"];
  if (el.classList.contains("vocab-edit-groups")) return [".vocab-edit-groups"];
  if (el.classList.contains("vocab-detail-delete")) return [".vocab-detail-delete"];
  if (el.classList.contains("vocab-detail-status")) return [".vocab-detail-status"];
  return [];
}

// Detail pane follows the data: re-render the shown word from the freshly
// read rows, or reset to the empty state when it is gone. Shared by the
// mutation reload and by renderVocabPanel -- a view re-entry that dropped
// this left the pane showing a word the list no longer has.
//
// Unsaved text survives the rebuild. A mutation on a SIBLING row (or another
// tab's write) rebuilds this pane too, and half-typed note / group-name text
// is the user's, not the store's. The save button's visibility is derived
// rather than snapshotted: "the text differs from the stored note" is
// precisely what it means, and deriving it stays honest after a note save
// (where the restored text now equals the stored one).
function _pbpVocabReconcileDetail() {
  if (!_pbpVocabDetailWordId) return;
  const detail = $id("vocab-detail");
  const tail = $id("vocab-detail-tail");
  if (!detail || !tail) return;
  // The rebuild replaces BOTH #vocab-detail and the tail (Save and the delete
  // live there now), so "in the pane" and "find the counterpart" span both.
  const inPane = (el) => !!el && (detail.contains(el) || tail.contains(el));
  const find = (sel) => detail.querySelector(sel) || tail.querySelector(sel);
  // Focus is user context too, and the one piece this reconcile used to drop.
  // The button the mutation was fired from is inside the subtree the rebuild
  // below replaces, so Chrome lands on <body> -- and below 860px the list is
  // off the page, which makes the way back a full Tab walk from the header.
  // Every list-side mutation in this file already restores focus (see
  // _pbpVocabFocusStable's callers); the detail pane's four were the gap.
  const wasFocused = document.activeElement;
  const focusTargets = inPane(wasFocused)
    ? _pbpVocabDetailFocusTargets(wasFocused) : [];
  const liveNote = detail.querySelector(".vocab-note-input");
  const liveGroup = detail.querySelector(".vocab-group-unit input");
  const draftNote = liveNote ? liveNote.value : null;
  const draftGroup = liveGroup ? liveGroup.value : "";
  // The group editor is the user's open tool, not store state: a mutation
  // fired from inside it (a chip's x, + / -) hands it back open.
  const editorOpen = !!detail.querySelector("#vocab-group-editor:not([hidden])");
  // The owner's FULL row set, not the filtered view: the detail pane is not
  // inside the filter's scope. With the list filtered to "learning", marking
  // the open word as known drops it out of _vocabViewRows, and reading the
  // word from there reset the pane the button was clicked in.
  const fresh = _vocabRows.find((row) => row.id === _pbpVocabDetailWordId);
  _pbpVocabRenderDetail(fresh || null);
  if (!fresh) return;
  // No-op when the fresh row is outside the current view (filtered out, or
  // past the load-more depth) -- the pane still reads it, the list just has
  // no row to mark.
  _pbpVocabMarkCurrentRow(fresh.id);
  if (editorOpen) _pbpVocabToggleGroupEditor(true, false);
  const note = detail.querySelector(".vocab-note-input");
  if (note && draftNote !== null && draftNote !== note.value) {
    note.value = draftNote;
    const save = tail.querySelector(".vocab-note-save");
    if (save) save.hidden = false;
  }
  const group = detail.querySelector(".vocab-group-unit input");
  if (group && draftGroup) group.value = draftGroup;
  // Only when the rebuild actually dropped it: these paths await an owner read
  // and a full IDB re-read, and the user may well have clicked into the note
  // box and started typing meanwhile -- taking that focus away would be worse
  // than the bug. A counterpart that exists but is hidden (Save, once the note
  // is committed) is no landing spot either, so
  // fall through to the next one and finally to the same two fallbacks the
  // list-side mutations use.
  if (!focusTargets.length) return;
  if (document.activeElement && document.activeElement !== document.body) return;
  const next = focusTargets.map(find).find((el) => el && !el.hidden && el.getClientRects().length);
  if (next) {
    try { next.focus({ preventScroll: true }); } catch (_) { next.focus(); }
  } else if (_pbpVocabNarrowMode()) {
    _pbpVocabFocusNarrowBack();
  } else {
    _pbpVocabFocusStable();
  }
}

// `broadcast` defaults to true because every other caller of this function IS a
// mutation. _pbpVocabSoftReload passes false: it re-reads on visibilitychange
// and view re-entry, where nothing changed under the user, and the service
// worker's twin (background.js pbpBroadcastVocabSynced) likewise only fires on
// `ok && changed`. Broadcasting there made every alt-tab back to this page run
// _echoRestart in every open reader -- _echoClearAll wipes the painted ranges
// and the idle rescan repaints them up to a second later, so the dotted
// underlines blink off and back on for a refresh that changed nothing.
async function _pbpVocabReloadAfterMutation(expectedOwner, requestedGen, broadcast = true) {
  const gen = Number.isInteger(requestedGen) ? requestedGen : ++_vocabRenderGen;
  if (gen !== _vocabRenderGen) return false;
  _pbpVocabSetLoading(true);
  try {
    const rows = await pbpVocabAll(expectedOwner);
    // Let a running card-exit fold finish before the rebuild (no-op unless a
    // delete just marked cards). Sits BEFORE the owner read and the gen/owner
    // guards: the owner must be re-read AFTER the last await, or an account
    // switch during the fold window would sail past a stale comparison.
    await _pbpVocabExitSettle();
    const ownerNow = await pbpVocabCurrentOwner();
    // A newer mutation, view activation or account-change render owns every
    // visible field now. The old snapshot may still be useful to its caller
    // as completion, but it must not write rows/loading/selection/status.
    if (gen !== _vocabRenderGen) return false;
    if (ownerNow !== expectedOwner) {
      _pbpVocabClearVisibleState();
      // I1: the list clear above leaves a stale word from the PREVIOUS owner
      // sitting in the detail pane -- at <860px that stale detail is the
      // only thing on screen, an owner-isolation breach.
      _pbpVocabRenderDetail(null);
      renderVocabPanel();
      return false;
    }
    _vocabRows = rows;
    // A read that lands clears an earlier failure's cover sentence (the
    // soft-reload failure path marks it; this path never runs the full clear).
    const cover = $id("vocab-detail-empty");
    if (cover) delete cover.dataset.loadFailed;
    _vocabOwnerLabel = pbpVocabOwnerLabel(expectedOwner);
    _vocabCurrentOwner = expectedOwner;
    _pbpVocabClearSelection();
    _pbpVocabRefreshGroupOptions(true);
    _pbpVocabSetLoading(false);
    // Keep the render depth: a mutation is not a reason to throw away the
    // pages a user loaded with "Load more" (the row cap still clamps to the
    // fresh row count). Non-append render, so _pbpVocabRenderList re-marks
    // aria-current across the whole restored depth.
    _pbpVocabApplyView(false);
    _pbpVocabReconcileDetail();
    // Vocabulary lives in IndexedDB, so there is no storage.onChanged for an
    // open reader to hear: a word deleted or marked known here would keep its
    // dotted underline in md-preview until that tab is reloaded. Same message
    // shape the service worker's Drive pull sends (background.js
    // pbpBroadcastVocabSynced) and md-vocab-echo.js already listens for --
    // it re-checks message.owner, and the sender never receives its own
    // message, so this page keeps refreshing through the reload above.
    if (broadcast) {
      try {
        const pending = chrome.runtime.sendMessage({ type: "PBP_VOCAB_SYNCED", owner: expectedOwner });
        if (pending && typeof pending.catch === "function") pending.catch(() => {});
      } catch (_) {}
    }
    return true;
  } catch (_) {
    if (gen !== _vocabRenderGen) return false;
    _pbpVocabClearVisibleState();
    _pbpVocabRenderDetail(null); // I1: the clear never touched the detail pane
    _pbpVocabSetLoading(false);
    return false;
  }
}

// Re-reads the whole list for the current Pinboard owner. Runs on every
// activation of the Vocabulary view (rescans every time, no "already inited"
// guard -- same convention renderNotesPanel uses). _vocabRenderGen guards a
// slow fetch that's still in flight when the account changes again (or the
// user leaves and re-enters the view) from clobbering a newer render.
async function renderVocabPanel() {
  if (!$id("vocab-list")) return;
  const gen = ++_vocabRenderGen;
  // Clear first, before any await: an account-change render must never leave
  // the previous owner's rows, selection, or derived group names visible.
  _pbpVocabClearVisibleState();
  let rows;
  let owner;
  try {
    owner = await pbpVocabCurrentOwner();
    if (!String(owner || "").startsWith("acct_")) {
      if (gen === _vocabRenderGen) {
        _pbpVocabRenderDetail(null);
        _pbpVocabSetAccountState(owner);
        _vocabCurrentOwner = owner;
        _pbpVocabSetLoading(false);
      }
      return;
    }
    rows = await pbpVocabAll(owner);
    if (await pbpVocabCurrentOwner() !== owner) {
      // Same owner-isolation reset as every other account-change path (I1):
      // the previous owner's word must not stay in the detail pane while the
      // re-read runs -- at <860px that pane is the whole screen.
      if (gen === _vocabRenderGen) {
        _pbpVocabRenderDetail(null);
        renderVocabPanel();
      }
      return;
    }
  } catch (_) {
    // Fail-closed: a rerender triggered by an account switch that then fails
    // to read must NOT leave the previous account's rows on screen (isolation
    // invariant) -- clear the list and say the read failed.
    if (gen === _vocabRenderGen) {
      _pbpVocabClearVisibleState();
      _pbpVocabRenderDetail(null); // I1: the clear never touched the detail pane
      _pbpVocabSetLoading(false);
      _pbpVocabFlashStatus(false, t("vocabLoadFailed"));
      _pbpVocabCoverLoadFailed();
    }
    return;
  }
  if (gen !== _vocabRenderGen) return;
  _vocabRows = rows;
  _vocabOwnerLabel = pbpVocabOwnerLabel(owner);
  _vocabCurrentOwner = owner;
  _pbpVocabSetAccountState(owner);
  _pbpVocabSetLoading(false);
  _pbpVocabRefreshGroupOptions(false);
  _pbpVocabApplyView(true);
  // Same reconcile the mutation reload does: re-entering the view (or any
  // other full re-read) must not leave a word in the detail pane that the
  // freshly read list no longer contains.
  _pbpVocabReconcileDetail();
}

// I3: a visibilitychange-triggered re-fire of pbp-lib-view on a vocab view
// that's ALREADY showing must not blow away in-progress selection or
// load-more depth just because the tab regained focus -- only a real account
// switch justifies the full clear. Called by the pbp-lib-view listener below
// when it recognizes the event as a freshness re-fire rather than a first-
// show/view-switch.
async function _pbpVocabSoftReload() {
  const gen = ++_vocabRenderGen;
  let owner;
  try {
    owner = await pbpVocabCurrentOwner();
  } catch (err) {
    console.warn("vocab soft reload owner read failed:", err.name, err.message);
    // Fail-closed, same shape as renderVocabPanel's own catch: an owner read
    // that throws here is exactly as untrustworthy as one that throws there,
    // so it gets the identical clear + detail-reset (I1) + flash treatment
    // rather than leaving a possibly-stale account's rows on screen.
    if (gen === _vocabRenderGen) {
      _pbpVocabClearVisibleState();
      _pbpVocabRenderDetail(null);
      _pbpVocabSetLoading(false);
      _pbpVocabFlashStatus(false, t("vocabLoadFailed"));
      _pbpVocabCoverLoadFailed();
    }
    return;
  }
  if (gen !== _vocabRenderGen) return;
  if (!String(owner || "").startsWith("acct_")) {
    _pbpVocabClearVisibleState();
    _pbpVocabRenderDetail(null);
    _pbpVocabSetAccountState(owner);
    _vocabCurrentOwner = owner;
    _pbpVocabSetLoading(false);
    return;
  }
  if (owner !== _vocabCurrentOwner) {
    // The account actually moved between the last commit and this re-fire --
    // this is exactly the account-switch case, so reuse its exact path
    // (full clear, including I1's detail reset) rather than a second,
    // subtly different one.
    _pbpVocabClearVisibleState();
    _pbpVocabRenderDetail(null);
    renderVocabPanel();
    return;
  }
  // _pbpVocabReloadAfterMutation unconditionally clears the selection --
  // correct for its usual callers, a mutation just happened, but nothing
  // changed under the user here. Snapshot and restore it around the call.
  // (Render depth needs no snapshot: the reload preserves _vocabRenderLimit.)
  const savedSelection = new Set(_vocabSelected);
  const savedAnchor = _vocabLastSelectedId;
  // broadcast:false -- see the parameter's comment. Nothing changed here.
  const reloaded = await _pbpVocabReloadAfterMutation(owner, gen, false);
  if (gen !== _vocabRenderGen) return;
  if (!reloaded) {
    // The read failed and the reload already cleared, fail-closed. Rendering
    // the now-empty list here would paint "no saved words yet" over a read
    // failure -- indistinguishable from actually losing every word. Say the
    // read failed instead and leave #vocab-empty hidden.
    _pbpVocabFlashStatus(false, t("vocabLoadFailed"));
    _pbpVocabCoverLoadFailed();
    return;
  }
  _vocabSelected = savedSelection;
  _vocabLastSelectedId = savedAnchor;
  // Rebuild to the restored depth. _pbpVocabBuildRow reads _vocabSelected at
  // build time, and the trailing _pbpVocabSyncSelectionUi() call inside
  // _pbpVocabRenderList prunes any restored id that no longer exists in the
  // fresh _vocabViewRows (e.g. deleted from another tab while this one was
  // hidden) -- the same machinery every other render pass already relies on,
  // just fed the pre-reload snapshot instead of an empty set.
  _pbpVocabRenderList();
}

function _pbpVocabSetBatchBusy(busy) {
  _vocabBatchBusy = !!busy;
  _pbpVocabSyncSelectionUi();
}

function _pbpVocabBatchDeleteSelected() {
  const button = $id("vocab-batch-delete");
  if (!button || button.disabled || _vocabBatchBusy || !_vocabSelected.size) return;
  const ids = [..._vocabSelected];
  showConfirmPopover(button, {
    msg: t("vocabBatchDeleteConfirm", String(ids.length)),
    yesText: t("delete"),
    noText: t("cancel"),
    onConfirm: async () => {
      if (_vocabBatchBusy) return;
      if (!pbpVocabSelectionSnapshotValid(ids, _vocabSelected, _vocabViewRows)) {
        _pbpVocabFlashStatus(false, t("vocabSelectionChanged"));
        _pbpVocabFocusStable();
        return;
      }
      _pbpVocabSetBatchBusy(true);
      const gen = ++_vocabRenderGen;
      let owner = null;
      try {
        owner = await pbpVocabCurrentOwner();
        const ok = await pbpVocabBatchDelete(ids, owner);
        if (ok) {
          // One simultaneous fold for the whole batch -- a per-card stagger
          // at 20 selections would blow far past the motion budget.
          const idSet = new Set(ids);
          _pbpVocabMarkExit([...document.querySelectorAll("#vocab-list > .notes-card")]
            .filter((el) => idSet.has(el.dataset.vocabId)));
        }
        const refreshed = await _pbpVocabReloadAfterMutation(owner, gen);
        if (gen !== _vocabRenderGen) return;
        _pbpVocabFocusStable();
        if (!ok) {
          _pbpVocabFlashStatus(false, t("vocabBatchFailed"));
          return;
        }
        if (!refreshed) {
          _pbpVocabFlashStatus(false, t("vocabRefreshFailed"));
          return;
        }
        _pbpVocabFlashStatus(true, t("vocabBatchDeleted", String(ids.length)));
      } catch (_) {
        if (owner) await _pbpVocabReloadAfterMutation(owner, gen);
        else if (gen === _vocabRenderGen) {
          _pbpVocabClearVisibleState();
          _pbpVocabSetLoading(false);
        }
        if (gen === _vocabRenderGen) {
          _pbpVocabFocusStable();
          _pbpVocabFlashStatus(false, t("vocabBatchFailed"));
        }
      } finally {
        _pbpVocabSetBatchBusy(false);
      }
    }
  });
}

// Add and remove share every line except the store call and the two words that
// differ in the report, so they share the function. `adding` also decides how
// the count is derived: adding touches the whole selection, removing only the
// part of it that actually carries the group -- and that count must be read
// BEFORE the mutation, since the reload afterwards no longer shows it.
async function _pbpVocabApplyGroupChange(adding) {
  const input = $id("vocab-group-input");
  const button = $id(adding ? "vocab-add-group" : "vocab-remove-group");
  if (!input || !button || button.disabled || _vocabBatchBusy || !_vocabSelected.size) return;
  const group = pbpVocabNormalizeGroupName(input.value);
  if (!group) { _pbpVocabFlashStatus(false, t("vocabGroupRequired")); return; }
  const ids = [..._vocabSelected];
  const affected = adding ? ids.length : _pbpVocabSelectedInGroup(group);
  _pbpVocabSetBatchBusy(true);
  const gen = ++_vocabRenderGen;
  let owner = null;
  try {
    owner = await pbpVocabCurrentOwner();
    const ok = adding
      ? await pbpVocabBatchAddGroup(ids, owner, group)
      : await pbpVocabBatchRemoveGroup(ids, owner, group);
    const refreshed = await _pbpVocabReloadAfterMutation(owner, gen);
    if (gen !== _vocabRenderGen) return;
    _pbpVocabFocusStable();
    if (!ok) {
      _pbpVocabFlashStatus(false, t("vocabBatchFailed"));
      return;
    }
    if (!refreshed) {
      _pbpVocabFlashStatus(false, t("vocabRefreshFailed"));
      return;
    }
    input.value = "";
    _pbpVocabFlashStatus(true, t(adding ? "vocabBatchGrouped" : "vocabBatchUngrouped", String(affected), group));
  } catch (_) {
    if (owner) await _pbpVocabReloadAfterMutation(owner, gen);
    else if (gen === _vocabRenderGen) {
      _pbpVocabClearVisibleState();
      _pbpVocabSetLoading(false);
    }
    if (gen === _vocabRenderGen) {
      _pbpVocabFocusStable();
      _pbpVocabFlashStatus(false, t("vocabBatchFailed"));
    }
  } finally {
    _pbpVocabSetBatchBusy(false);
  }
}

// Batch status flip, same generation/owner/refresh discipline as the group
// mutations. No input field to validate: the selection is the whole argument.
async function _pbpVocabApplyStatusChange(known) {
  const button = $id(known ? "vocab-mark-known" : "vocab-mark-learning");
  if (!button || button.disabled || _vocabBatchBusy || !_vocabSelected.size) return;
  const ids = [..._vocabSelected];
  _pbpVocabSetBatchBusy(true);
  const gen = ++_vocabRenderGen;
  let owner = null;
  try {
    owner = await pbpVocabCurrentOwner();
    const ok = await pbpVocabBatchSetStatus(ids, owner, known ? "known" : "new");
    const refreshed = await _pbpVocabReloadAfterMutation(owner, gen);
    if (gen !== _vocabRenderGen) return;
    _pbpVocabFocusStable();
    if (!ok) { _pbpVocabFlashStatus(false, t("vocabBatchFailed")); return; }
    if (!refreshed) { _pbpVocabFlashStatus(false, t("vocabRefreshFailed")); return; }
    _pbpVocabFlashStatus(true,
      t(known ? "vocabBatchKnownDone" : "vocabBatchLearningDone", String(ids.length)));
  } catch (_) {
    if (owner) await _pbpVocabReloadAfterMutation(owner, gen);
    else if (gen === _vocabRenderGen) {
      _pbpVocabClearVisibleState();
      _pbpVocabSetLoading(false);
    }
    if (gen === _vocabRenderGen) {
      _pbpVocabFocusStable();
      _pbpVocabFlashStatus(false, t("vocabBatchFailed"));
    }
  } finally {
    _pbpVocabSetBatchBusy(false);
  }
}

// Filters and sort start the list again from its first row (library redesign
// §2.5 #1): the list region is the scroll container now. Only the four user
// inputs below call this -- never _pbpVocabApplyView itself, which the
// reload path (_pbpVocabSoftReload, a reconcile from another tab) also calls
// and which must keep the user's place.
function _pbpVocabResetListScroll() {
  const region = document.querySelector(".vocab-list-region");
  if (region) region.scrollTop = 0;
}

const _vocabSearch = $id("vocab-search");
if (_vocabSearch) _vocabSearch.addEventListener("input", () => {
  _pbpVocabClearSelection();
  _pbpVocabApplyView(true);
  _pbpVocabResetListScroll();
});
for (const id of ["vocab-group-filter", "vocab-status-filter"]) {
  const control = $id(id);
  if (control) control.addEventListener("change", () => {
    _pbpVocabClearSelection();
    _pbpVocabApplyView(true);
    _pbpVocabResetListScroll();
  });
}
// The three status toggles proxy #vocab-status-filter: a click writes it and
// reuses the existing change pipeline. A second click on the pressed Learning
// / Known goes back to All; All's own target is "" so the same line serves it.
for (const chipId of ["vocab-stat-all", "vocab-stat-learning", "vocab-stat-known"]) {
  const chip = $id(chipId);
  if (chip) chip.addEventListener("click", () => {
    const filter = $id("vocab-status-filter");
    if (!filter) return;
    const target = chip.dataset.status;
    filter.value = filter.value === target ? "" : target;
    filter.dispatchEvent(new Event("change"));
  });
}
// The narrow-index Filter button names how many non-default filters are on
// (spec §3.4, §11 V10): group not "All groups" counts 1, status not "All"
// counts 1. Bold via data-filtered; the popover's own open state is written
// onto the button by library.js (pbpLibWireFilterPopover).
function _pbpVocabSyncFilterNarrow() {
  const btn = $id("vocab-filter-narrow");
  if (!btn) return;
  const active = (($id("vocab-group-filter") || {}).value ? 1 : 0) + (($id("vocab-status-filter") || {}).value ? 1 : 0);
  const label = btn.lastElementChild;
  if (label) label.textContent = active ? t("libraryFilterNarrowActive", String(active)) : t("libraryFilterNarrow");
  if (active) btn.dataset.filtered = "true";
  else delete btn.dataset.filtered;
}
// applyI18n rewrites the label span from its static data-i18n key on every
// language change; put the live reading back right after it.
document.addEventListener("pbp:i18n-applied", _pbpVocabSyncFilterNarrow);
// Free-lookup toolbar: one-time wiring alongside the status toggles above (see
// _pbpVocabWireLookupBar's own comment -- no per-render rebuild, so no
// "already wired" guard is needed here either).
_pbpVocabWireLookupBar();
// The column's idle copy and the box's placeholder are written by JS (they
// depend on state), so they follow a language switch the way applyI18n's
// data-i18n attributes do.
document.addEventListener("pbp:i18n-applied", () => {
  const host = $id("vocab-ref-result");
  if (host && host.dataset.refState === "free") _pbpVocabRenderRefIdle("free");
  else if (host && host.dataset.refState === "idle") _pbpVocabRenderRefIdle("word");
  _pbpVocabSyncLookupPlaceholder();
  _pbpVocabRenderCover();
});
// Narrow-screen door to the lookup row. Below 860px the detail pane is
// display:none until `lib-narrow-detail` is on the body, so the list needs
// one control that flips into the pane and puts the caret where the user was
// heading. Nothing is looked up here -- it opens the tool, it does not run it.
function _pbpVocabOpenLookupPane() {
  document.body.classList.add("lib-narrow-detail");
  // The lookup row is in the reference column, under the word on one
  // column: show the column first (instant, spec §2.5 row 3).
  const ref = $id("vocab-ref");
  if (ref) ref.scrollIntoView({ block: "start" });
  const input = $id("vocab-lookup-input");
  if (!input) return;
  try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); }
}
for (const id of ["vocab-lookup-narrow", "vocab-signed-out-lookup"]) {
  const button = $id(id);
  if (button) button.addEventListener("click", _pbpVocabOpenLookupPane);
}
// Sort only reorders the same visible set: keep the selection (desktop
// convention), reset the shift anchor -- a range from a pre-sort anchor
// would span an arbitrary interval in the new visual order.
const _vocabSortSelect = $id("vocab-sort");
if (_vocabSortSelect) _vocabSortSelect.addEventListener("change", () => {
  _vocabLastSelectedId = null;
  _pbpVocabApplyView(true);
  _pbpVocabResetListScroll();
  _pbpVocabSyncSortFace();
});
// Sort menu button (spec §3.3, user ruling 2026-10-03): #vocab-sort stays the
// hidden state carrier; listbox.js draws it as a ghost trigger
// (data-listbox-face="ghost"). The trigger shows a short dimension word and a
// direction arrow -- down always descending, up always ascending -- read from
// the selected option's data-face-label / data-face-icon. The full option text
// is in the popover and, after the label, in the accessible name
// (aria-labelledby="vocab-sort-label vocab-sort-face", WCAG 2.5.3) and the
// title. Runs at parse time (browser-language t()), again from library.js
// after applyI18n, where t() is final, and on every later pbp:i18n-applied
// (the async manual-language refresh re-applies option text; listbox.js's own
// re-sync, registered earlier, would otherwise redraw the stale face words).
const PBP_VOCAB_SORT_FACE_KEYS = Object.freeze({ latest: "librarySortTime", oldest: "librarySortTime", az: "librarySortAlpha", za: "librarySortAlpha" });
function _pbpVocabSyncSortFace() {
  const select = $id("vocab-sort");
  if (!select) return;
  for (const option of select.options) {
    const key = PBP_VOCAB_SORT_FACE_KEYS[option.value];
    if (key) option.dataset.faceLabel = t(key);
  }
  const current = select.selectedOptions[0] || null;
  const short = current ? current.dataset.faceLabel || "" : "";
  const full = current ? (current.textContent || "").trim() : "";
  const name = t("librarySortFaceAria", short, full);
  const face = $id("vocab-sort-face");
  if (face) face.textContent = name;
  // listbox.js builds #vocab-sort-btn at DOMContentLoaded and never touches
  // its title; absent at parse time and on the test pages.
  const trigger = $id("vocab-sort-btn");
  if (trigger) trigger.title = name;
  // A programmatic data-face-label write fires nothing; redraw the trigger.
  window.pbpListboxSync?.(select);
}
_pbpVocabSyncSortFace();
document.addEventListener("pbp:i18n-applied", _pbpVocabSyncSortFace);
// Select all, from either row. The count row hides the moment a selection
// exists, taking a focused "Select all" with it -- hand focus to the batch
// row's Clear, the control that undoes what was just done.
function _pbpVocabSelectAllVisible() {
  _vocabSelected = pbpVocabSelectResults(_vocabSelected, _vocabViewRows, "all");
  _vocabLastSelectedId = null;
  _pbpVocabSyncSelectionUi();
  const clear = $id("vocab-clear-selection");
  if (clear && _vocabSelected.size) { try { clear.focus({ preventScroll: true }); } catch (_) { clear.focus(); } }
}
const _vocabClearBtn = $id("vocab-clear-selection");
// The batch row (with the button just pressed) hides the moment the
// selection empties: hand focus to the count row's Select all, which comes
// back in its place, instead of letting it fall to <body>.
function _pbpVocabFocusCountRowSelectAll() {
  const allBtn = $id("vocab-select-all");
  if (allBtn) { try { allBtn.focus({ preventScroll: true }); } catch (_) { allBtn.focus(); } }
}
if (_vocabClearBtn) _vocabClearBtn.addEventListener("click", () => {
  _pbpVocabClearSelection();
  _pbpVocabSyncSelectionUi();
  _pbpVocabFocusCountRowSelectAll();
});
const _vocabSelectAll = $id("vocab-select-all");
if (_vocabSelectAll) _vocabSelectAll.addEventListener("click", _pbpVocabSelectAllVisible);
const _vocabBatchSelectAll = $id("vocab-batch-select-all");
if (_vocabBatchSelectAll) _vocabBatchSelectAll.addEventListener("click", _pbpVocabSelectAllVisible);
const _vocabInvert = $id("vocab-invert-selection");
if (_vocabInvert) _vocabInvert.addEventListener("click", () => {
  _vocabSelected = pbpVocabSelectResults(_vocabSelected, _vocabViewRows, "invert");
  _vocabLastSelectedId = null;
  _pbpVocabSyncSelectionUi();
  // Inverting "everything" empties the selection and hides this very button.
  if (!_vocabSelected.size) _pbpVocabFocusCountRowSelectAll();
});
const _vocabLoadMore = $id("vocab-load-more");
if (_vocabLoadMore) _vocabLoadMore.addEventListener("click", () => {
  const list = $id("vocab-list");
  const appendedAt = list ? list.children.length : 0;
  _vocabRenderLimit = Math.min(_vocabViewRows.length, _vocabRenderLimit + PBP_VOCAB_RENDER_BATCH);
  _pbpVocabRenderList(true);
  // The LAST click hides the button it came from (remaining hits zero), and
  // Chrome then drops focus on <body> -- with no skip link on this page the
  // way on is a full Tab walk from the header. Hand it to the first row this
  // click appended: that is where the user was heading, and the roving stop
  // has to move with it or the list would answer the next Tab from an older
  // row. preventScroll deliberately -- the viewport must stay where they were
  // reading. Nothing appended (a re-render raced this click) falls back to
  // the landing spot every other path in this file uses.
  if (!_vocabLoadMore.hidden) return;
  const appended = list && list.children[appendedAt];
  const head = appended ? appended.querySelector(".notes-card-head") : null;
  if (!head) { _pbpVocabFocusStable(); return; }
  _pbpVocabSetRowTabStop(head);
  try { head.focus({ preventScroll: true }); } catch (_) { head.focus(); }
});
// Grid navigation. Bound on the container, so it survives every row rebuild
// and stays scoped to the list: Home/End must not reach the toolbar's search
// fields, where they are the caret's own keys. ArrowUp/Down are
// preventDefault'd (they would otherwise scroll the page) but never activate
// -- opening a word stays a click or an unmodified Space, and the modified
// Space chords keep their own handler on the row head.
const _vocabListEl = $id("vocab-list");
if (_vocabListEl) _vocabListEl.addEventListener("keydown", (e) => {
  // K89: "/" jumps back to the search box, the twin of md-reader.js's "/"
  // search shortcut. Placed BEFORE the modifier gate below and only
  // excludes ctrl/meta/alt (not shift) -- on German QWERTZ / French AZERTY
  // "/" needs Shift, and on US layouts Shift+/ yields "?" so e.key already
  // disambiguates (same reasoning md-reader.js's "/" search shortcut uses).
  // No typing-context guard is needed: this listener only ever fires with
  // focus on a row inside #vocab-list, and the page's other text inputs
  // (search, group input, lookup input, the note textarea) all live outside
  // that container in the toolbar/detail pane, so their keydowns never
  // bubble here.
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const search = $id("vocab-search");
    // select() only when focus really landed -- library-notes.js's twin branch
    // reads `if (_pbpNotesFocus(filter)) filter.select()` for the same reason.
    if (search && _pbpVocabFocusStable()) search.select();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const card = e.target && typeof e.target.closest === "function" ? e.target.closest(".vocab-card") : null;
  if (!card) return;
  const heads = _pbpVocabRowHeads();
  const head = card.querySelector(".notes-card-head");
  const at = heads.indexOf(head);
  let next = null;
  if (e.key === "ArrowDown") next = heads[Math.min(at + 1, heads.length - 1)];
  else if (e.key === "ArrowUp") next = heads[Math.max(at - 1, 0)];
  else if (e.key === "Home") next = heads[0];
  else if (e.key === "End") next = heads[heads.length - 1];
  else if (e.key === "ArrowRight") next = card.querySelector(".row-del-x");
  else if (e.key === "ArrowLeft") next = head;
  else return;
  e.preventDefault();
  if (!next) return;
  // Left/Right move WITHIN one row (head and delete share its single
  // gridcell), so the row keeps the tab stop either way.
  _pbpVocabSetRowTabStop(next.classList.contains("notes-card-head") ? next : head);
  next.focus();
});
const _vocabGroupInput = $id("vocab-group-input");
if (_vocabGroupInput) _vocabGroupInput.addEventListener("input", _pbpVocabSyncSelectionUi);
const _vocabAddGroup = $id("vocab-add-group");
if (_vocabAddGroup) _vocabAddGroup.addEventListener("click", () => _pbpVocabApplyGroupChange(true));
const _vocabRemoveGroup = $id("vocab-remove-group");
if (_vocabRemoveGroup) _vocabRemoveGroup.addEventListener("click", () => _pbpVocabApplyGroupChange(false));
const _vocabBatchDelete = $id("vocab-batch-delete");
if (_vocabBatchDelete) _vocabBatchDelete.addEventListener("click", _pbpVocabBatchDeleteSelected);
const _vocabMarkKnown = $id("vocab-mark-known");
if (_vocabMarkKnown) _vocabMarkKnown.addEventListener("click", () => _pbpVocabApplyStatusChange(true));
const _vocabMarkLearning = $id("vocab-mark-learning");
if (_vocabMarkLearning) _vocabMarkLearning.addEventListener("click", () => _pbpVocabApplyStatusChange(false));

// Mount. library.js dispatches this on the initial view, on every view
// switch, and when the tab becomes visible again -- words saved from the
// reader while this tab was hidden have to show up on return.
// _vocabViewShown (I3) distinguishes a real first-show/view-switch (library.js's
// click/hashchange/initial dispatch sites, which always go through
// _pbpLibApplyView and toggle the view DOM) from a pure freshness re-fire on
// an already-rendered vocab view (library.js's visibilitychange listener, the
// ONLY dispatch site that does not go through _pbpLibApplyView). The event
// itself carries no such flag, so this is inferred from our own state.
let _vocabViewShown = false;
document.addEventListener("pbp-lib-view", (e) => {
  if (e.detail.view !== "vocab") { _vocabViewShown = false; return; }
  if (_vocabViewShown) { _pbpVocabSoftReload(); return; }
  _vocabViewShown = true;
  renderVocabPanel();
});

// Account switch (token rotation, or the sync/keys-routing toggles that
// change which area holds the effective token) invalidates every row
// currently shown -- clear first, then re-read for the new owner.
// renderVocabPanel's generation counter absorbs a rerun that lands after the
// user has already switched views. Unconditional, unlike the options page's
// active-tab check: this view keeps its rows in the DOM while Notes is on
// screen, so a hidden stale list is exactly what must not survive.
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" && area !== "local") return;
    const relevant = [changes.pinboardToken, changes.optSyncEnabled, changes.syncApiKeys].filter(Boolean);
    // An identical rewrite (settings saved with the same token, a toggle set
    // to the value it already had) names no new account. Tearing the whole
    // view down for it would drop selection, render depth and the open
    // detail for nothing.
    if (!relevant.length || relevant.every((change) => change.oldValue === change.newValue)) return;
    _pbpVocabClearVisibleState();
    // I1: same owner-isolation gap as _pbpVocabReloadAfterMutation's
    // ownerNow-mismatch branch above -- the list clear never touched the
    // detail pane, so the previous owner's word stayed on screen.
    _pbpVocabRenderDetail(null);
    renderVocabPanel();
  });
}
