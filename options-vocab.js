// ============================================================
// Pinboard Bookmark Enhanced - options-vocab.js
// Vocabulary tab: renders md-dict.js's pbp-vocab IndexedDB store (words
// saved from the reader's dictionary view) with expand/delete/export.
// Replaces the old reader-rail panel (Codex feedback round 2) -- md-dict.js
// keeps only the pure store layer (pbpVocabAll/Get/SaveWord/Delete).
// Modeled on options-notes.js: lazy render on tab activation, same
// accordion row family, same confirm-popover delete idiom.
// ============================================================

let _vocabRenderGen = 0; // guards stale async renders (account switch mid-fetch)
let _vocabRows = [];     // last render's rows, kept for export

// Owner derivation: the ONLY correct path is the same atomic secret-aware
// read every other account-scoped consumer uses (pbpReadSettingsWithSecrets
// picks the right storage area and overlays the local secret when sync is
// routed) -- never split/decode opt-pinboard-token's raw form field value
// here. pbpPinboardAccountFromToken deobfuscates internally, so the raw
// (still-obfuscated) token read from storage is passed through as-is.
async function pbpVocabCurrentOwner() {
  const s = await pbpReadSettingsWithSecrets({ pinboardToken: SETTINGS_DEFAULTS.pinboardToken });
  return pbpDictOwnerScope(pbpPinboardAccountFromToken(s.pinboardToken));
}

function _pbpVocabBuildRow(w, index) {
  const card = document.createElement("article");
  card.className = "notes-card";

  const top = document.createElement("div");
  top.className = "notes-card-top";

  // Render-index-based id, not w.id -- non-ASCII terms squashed by a regex
  // collide (two CJK words both become "_"), duplicating ids and breaking
  // aria-controls. Index within the current render generation is always
  // structurally unique, no hashing needed.
  const bodyId = "vocab-body-" + _vocabRenderGen + "-" + index;
  const head = document.createElement("button");
  head.type = "button";
  head.className = "notes-card-head";
  head.setAttribute("aria-expanded", "false");
  head.setAttribute("aria-controls", bodyId);

  const chev = document.createElement("span");
  chev.className = "notes-card-chevron";
  chev.setAttribute("aria-hidden", "true");
  head.appendChild(chev);

  const main = document.createElement("span");
  main.className = "notes-card-main";

  const titleEl = document.createElement("span");
  titleEl.className = "notes-row-title";
  titleEl.textContent = w.term;
  main.appendChild(titleEl);

  const meta = document.createElement("span");
  meta.className = "notes-row-meta";
  const langChip = document.createElement("span");
  langChip.className = "notes-meta-chip";
  langChip.textContent = (w.language || "").toUpperCase();
  meta.appendChild(langChip);
  const glossChip = document.createElement("span");
  glossChip.className = "notes-meta-chip";
  glossChip.textContent = (w.gloss || "").split("\n")[0];
  meta.appendChild(glossChip);
  main.appendChild(meta);

  head.appendChild(main);
  top.appendChild(head);

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn btn-sm notes-row-del";
  delBtn.textContent = t("dictDeleteWord");
  delBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    _pbpVocabDeleteRow(w, delBtn);
  });
  top.appendChild(delBtn);
  card.appendChild(top);

  const body = document.createElement("div");
  body.id = bodyId;
  body.className = "notes-card-body";
  body.hidden = true;

  const itemsEl = document.createElement("div");
  itemsEl.className = "notes-items";
  const contexts = Array.isArray(w.contexts) ? w.contexts : [];
  for (const c of contexts) {
    if (!c) continue;
    const itemEl = document.createElement("div");
    itemEl.className = "notes-item";
    const textEl = document.createElement("div");
    textEl.className = "notes-item-text";
    const quoteEl = document.createElement("div");
    quoteEl.className = "notes-item-quote";
    quoteEl.textContent = c.quote || "";
    textEl.appendChild(quoteEl);
    const safeHref = pbpDictSafeUrl(c.articleUrl);
    if (safeHref) {
      const link = document.createElement("a");
      link.className = "notes-row-open";
      link.href = safeHref;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = c.articleTitle || safeHref;
      textEl.appendChild(link);
    }
    itemEl.appendChild(textEl);
    itemsEl.appendChild(itemEl);
  }
  if (w.note) {
    const noteEl = document.createElement("div");
    noteEl.className = "notes-item-note";
    noteEl.textContent = w.note;
    itemsEl.appendChild(noteEl);
  }
  body.appendChild(itemsEl);
  card.appendChild(body);

  head.addEventListener("click", () => {
    const open = body.hidden;
    body.hidden = !open;
    head.setAttribute("aria-expanded", open ? "true" : "false");
  });

  return card;
}

function _pbpVocabFlashStatus(ok, text) {
  const el = $id("vocab-status");
  if (!el) return;
  setStatusIcon(el, ok, text);
  setTimeout(() => { el.textContent = ""; }, 3000);
}

// Same anchored confirm popover as every other destructive micro-action
// (notes, theme delete, tab reset) -- never window.confirm. Owner is
// re-derived at action time, not reused from the render pass, so a delete
// confirmed after an account switch still checks against the CURRENT
// account (account-isolation invariant).
function _pbpVocabDeleteRow(w, anchor) {
  showConfirmPopover(anchor, {
    msg: t("dictDeleteConfirm", w.term),
    yesText: t("delete"),
    noText: t("cancel"),
    onConfirm: async () => {
      // Whole body in try/catch: showConfirmPopover only console.errors a
      // rejected onConfirm, so a thrown owner read (or anything else here)
      // would otherwise vanish with no user-visible feedback.
      try {
        const owner = await pbpVocabCurrentOwner();
        const ok = await pbpVocabDelete(w.id, owner);
        if (ok) {
          _vocabRows = _vocabRows.filter((r) => r.id !== w.id);
          _pbpVocabRenderList(_vocabRows);
        } else {
          _pbpVocabFlashStatus(false, t("dictDeleteFailed"));
        }
      } catch (_) {
        _pbpVocabFlashStatus(false, t("dictDeleteFailed"));
      }
    },
  });
}

function _pbpVocabRenderList(rows) {
  const list = $id("vocab-list");
  if (!list) return;
  const count = $id("vocab-count");
  if (count) count.textContent = rows.length ? String(rows.length) : "";
  const empty = $id("vocab-empty");
  if (empty) empty.hidden = !!rows.length;
  list.replaceChildren();
  rows.forEach((w, i) => list.appendChild(_pbpVocabBuildRow(w, i)));
}

// Called from options.js's activateTab -- the sole lazy-init line added
// there, same convention as renderNotesPanel/renderStoragePanel (rescans
// every activation, no "already inited" guard). _vocabRenderGen guards a
// slow fetch that's still in flight when the account changes again (or the
// user leaves and re-enters the tab) from clobbering a newer render.
async function renderVocabPanel() {
  if (!$id("vocab-list")) return;
  const gen = ++_vocabRenderGen;
  let rows;
  try {
    const owner = await pbpVocabCurrentOwner();
    rows = await pbpVocabAll(owner);
  } catch (_) {
    // Fail-closed: a rerender triggered by an account switch that then fails
    // to read must NOT leave the previous account's rows on screen (isolation
    // invariant) -- clear the list and say the read failed.
    if (gen === _vocabRenderGen) {
      _vocabRows = [];
      _pbpVocabRenderList([]);
      _pbpVocabFlashStatus(false, t("jinaFailed"));
    }
    return;
  }
  if (gen !== _vocabRenderGen) return;
  _vocabRows = rows;
  _pbpVocabRenderList(rows);
}

// Fail-closed on account switch: owner is re-derived AFTER the rows fetch
// resolves and compared against the owner the rows were fetched for. If they
// differ (token rotated, or sync/keys-routing toggled mid-fetch), the export
// aborts BEFORE the Blob is built -- never download the previous account's
// words under the new account's export click. The whole chain is wrapped so
// any rejection (owner read, IDB read) surfaces feedback instead of dying
// silently (this runs as a click handler; an unhandled rejection there is
// invisible to the user).
async function _pbpVocabExport() {
  try {
    const owner = await pbpVocabCurrentOwner();
    const rows = await pbpVocabAll(owner);
    const ownerNow = await pbpVocabCurrentOwner();
    if (ownerNow !== owner) {
      _pbpVocabFlashStatus(false, t("jinaFailed"));
      return;
    }
    const tsv = pbpDictTsv(rows.map((w) => ({
      term: w.term,
      reading: w.ipa || "",
      definition: (w.gloss || "").replace(/\s*\n\s*/g, " "),
      contexts: (Array.isArray(w.contexts) ? w.contexts : []).map((c) => c && c.quote).filter(Boolean),
      source: (w.contexts && w.contexts[0] && w.contexts[0].articleUrl) || "",
      license: [w.license, w.sourceUrl].filter(Boolean).join(" ")
    })));
    const blob = new Blob([tsv], { type: "text/tab-separated-values" });
    const a = document.createElement("a");
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    a.href = URL.createObjectURL(blob);
    a.download = "vocab-" + stamp + ".tsv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (_) {
    _pbpVocabFlashStatus(false, t("jinaFailed"));
  }
}

const _vocabExportBtn = $id("vocab-export-btn");
if (_vocabExportBtn) _vocabExportBtn.addEventListener("click", _pbpVocabExport);

// Account switch (token rotation, or the sync/keys-routing toggles that
// change which area holds the effective token) invalidates every row
// currently shown -- re-render only when the vocab tab is the one on
// screen; renderVocabPanel's generation counter absorbs a rerun that lands
// after the user has already navigated away and back again.
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area !== "sync" && area !== "local") ||
        !(changes.pinboardToken || changes.optSyncEnabled || changes.syncApiKeys)) return;
    const activeBtn = document.querySelector(".tab-btn.active");
    if (activeBtn && activeBtn.dataset.panel === "vocab") renderVocabPanel();
  });
}
