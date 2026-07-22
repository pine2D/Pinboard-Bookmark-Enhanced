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
let _vocabFlashTimer = 0; // guards two flashes racing to clear each other's text early

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
  // Two flashes in quick succession (e.g. export then Anki) must not race:
  // the earlier call's clear-timer would otherwise wipe the later message.
  clearTimeout(_vocabFlashTimer);
  _vocabFlashTimer = setTimeout(() => { el.textContent = ""; }, 3000);
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

  const eudicBtn = $id("vocab-eudic-btn");
  if (eudicBtn) {
    // Hidden when nothing is sendable: don't ask for permissions first and
    // reveal "no supported words" after.
    eudicBtn.hidden = typeof pbpEudicPartition !== "function"
      || pbpEudicPartition(rows).byLang.size === 0;
  }
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
  _pbpPackRefreshStatus();
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
  const btn = $id("vocab-export-btn");
  if (!btn || btn.disabled) return; // double-click guard, same as the Anki/Eudic buttons
  btn.disabled = true;
  try {
    // A just-edited setting may still sit in the options page's debounced
    // auto-save; flush it first, same ordering as the Anki/Eudic sends
    // (Codex final-review MEDIUM precedent), and abort if the flush fails.
    if (typeof window.pbpOptionsFlushAutoSave === "function") {
      let flushed = null;
      try { flushed = await window.pbpOptionsFlushAutoSave(); } catch (_) {}
      if (!flushed || !flushed.ok) { _pbpVocabFlashStatus(false, t("jinaFailed")); return; }
    }
    const owner = await pbpVocabCurrentOwner();
    const rows = await pbpVocabAll(owner);
    const ownerNow = await pbpVocabCurrentOwner();
    if (ownerNow !== owner) {
      _pbpVocabFlashStatus(false, t("jinaFailed"));
      return;
    }
    const tsv = pbpDictTsv(rows.map(_pbpVocabCanonicalRow));
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
  } finally {
    btn.disabled = false;
  }
}

// Send-to-Anki click chain. Ordering is the spec (anki spec rev2 §3):
// (1) FIRST await = chrome.permissions.request (user gesture; already-granted
// resolves true without UI), (2) requestPermission as the first AnkiConnect
// action, (3..n) owner derived AFTER the permission awaits and re-checked
// via ownerCheck before every later dispatch -- the permission dialogs can
// sit open long enough for an account switch (fail-closed invariant).
// Canonical row shared by the TSV export and the Anki send (spec: both
// derive from the SAME canonical shape; the Anki side escapes its own copy).
function _pbpVocabCanonicalRow(w) {
  return {
    term: w.term,
    reading: w.ipa || "",
    definition: (w.gloss || "").replace(/\s*\n\s*/g, " "),
    contexts: (Array.isArray(w.contexts) ? w.contexts : []).map((c) => c && c.quote).filter(Boolean),
    source: (w.contexts && w.contexts[0] && w.contexts[0].articleUrl) || "",
    license: [w.license, w.sourceUrl].filter(Boolean).join(" ")
  };
}

async function _pbpVocabSendAnki() {
  const btn = $id("vocab-anki-btn");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const orig = btn.textContent;
  try {
    btn.textContent = t("dictAnkiSending");
    const pattern = pbpEndpointOriginPattern(PBP_ANKI_ENDPOINT);
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [pattern] }); } catch (_) {}
    if (!granted) { _pbpVocabFlashStatus(false, t("dictAnkiUnreachable")); return; }
    // requestPermission FIRST (spec §3): the long human-approval wait happens
    // BEFORE owner derivation, so the owner snapshot below stays fresh.
    const perm = await pbpAnkiCall("requestPermission", {}, "", 120000);
    if (!perm.ok || !perm.result || perm.result.permission !== "granted"
        || Number(perm.result.version) < 6) {
      _pbpVocabFlashStatus(false, t("dictAnkiUnreachable"));
      return;
    }
    const keyRequired = perm.result.requireApiKey === true || perm.result.requireApikey === true;
    // A just-edited deck/key may still sit in the options page's 500ms
    // debounced auto-save; flush it so the read below sees what the user
    // sees, and abort if the save fails (Codex final-review MEDIUM).
    if (typeof window.pbpOptionsFlushAutoSave === "function") {
      let flushed = null;
      try { flushed = await window.pbpOptionsFlushAutoSave(); } catch (_) {}
      if (!flushed || !flushed.ok) { _pbpVocabFlashStatus(false, t("jinaFailed")); return; }
    }
    const raw = await pbpReadSettingsWithSecrets({
      dictAnkiDeck: SETTINGS_DEFAULTS.dictAnkiDeck,
      dictAnkiKey: SETTINGS_DEFAULTS.dictAnkiKey
    });
    const s = deobfuscateSettings(raw);
    if (keyRequired && !s.dictAnkiKey) { _pbpVocabFlashStatus(false, t("dictAnkiKeyRequired")); return; }
    const owner = await pbpVocabCurrentOwner();
    const rows = await pbpVocabAll(owner);
    if ((await pbpVocabCurrentOwner()) !== owner) { _pbpVocabFlashStatus(false, t("jinaFailed")); return; }
    if (!rows.length) { _pbpVocabFlashStatus(false, t("dictAnkiNothing")); return; }
    const canonical = rows.map(_pbpVocabCanonicalRow);
    const res = await pbpAnkiSendRows(canonical, {
      deck: s.dictAnkiDeck || "Pinboard Vocab",
      key: s.dictAnkiKey || "",
      ownerCheck: async () => (await pbpVocabCurrentOwner()) === owner
    });
    if (res.stage === "done") {
      _pbpVocabFlashStatus(res.failed === 0, t("dictAnkiResult", String(res.added), String(res.skipped), String(res.failed)));
    } else if (res.stage === "modelMismatch") {
      _pbpVocabFlashStatus(false, t("dictAnkiModelMismatch"));
    } else if (res.stage === "owner") {
      _pbpVocabFlashStatus(false, t("jinaFailed"));
    } else {
      // Pipeline stages (deck/model/precheck/add) carry AnkiConnect's own
      // error text; "unreachable" is only honest for the connection itself
      // (mirrors the Eudic 400-message precedent).
      _pbpVocabFlashStatus(false, res.error || t("dictAnkiUnreachable"));
    }
  } catch (_) {
    _pbpVocabFlashStatus(false, t("dictAnkiUnreachable"));
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

async function _pbpVocabSendEudic() {
  const btn = $id("vocab-eudic-btn");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const orig = btn.textContent;
  try {
    btn.textContent = t("dictEudicSending");
    const pattern = pbpEndpointOriginPattern(PBP_EUDIC_ENDPOINT);
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [pattern] }); } catch (_) {}
    if (!granted) { _pbpVocabFlashStatus(false, t("jinaFailed")); return; }
    if (typeof window.pbpOptionsFlushAutoSave === "function") {
      let flushed = null;
      try { flushed = await window.pbpOptionsFlushAutoSave(); } catch (_) {}
      if (!flushed || !flushed.ok) { _pbpVocabFlashStatus(false, t("jinaFailed")); return; }
    }
    const raw = await pbpReadSettingsWithSecrets({ dictEudicToken: SETTINGS_DEFAULTS.dictEudicToken });
    const s = deobfuscateSettings(raw);
    if (!s.dictEudicToken) { _pbpVocabFlashStatus(false, t("dictEudicTokenRequired")); return; }
    const owner = await pbpVocabCurrentOwner();
    const rows = await pbpVocabAll(owner);
    if ((await pbpVocabCurrentOwner()) !== owner) { _pbpVocabFlashStatus(false, t("jinaFailed")); return; }
    const res = await pbpEudicSendRows(rows, {
      token: s.dictEudicToken,
      ownerCheck: async () => (await pbpVocabCurrentOwner()) === owner
    });
    if (res.stage === "owner") {
      _pbpVocabFlashStatus(false, t("jinaFailed"));
    } else if (res.stage === "auth") {
      _pbpVocabFlashStatus(false, t("dictEudicTokenRequired"));
    } else if (res.rateLimited) {
      _pbpVocabFlashStatus(false, t("dictEudicRateLimited"));
    } else if (res.failed) {
      // Parameter errors surface the server's own message (spec §2).
      _pbpVocabFlashStatus(false, res.error || t("jinaFailed"));
    } else if (res.generic) {
      // ANY generic batch poisons the totals -- never show a partial count
      // as if it were the whole story.
      _pbpVocabFlashStatus(true, t("dictEudicGenericOk"));
    } else {
      _pbpVocabFlashStatus(true,
        t("dictEudicResult", String(res.added), String(res.skipped), String(res.unsupported)));
    }
  } catch (_) {
    _pbpVocabFlashStatus(false, t("jinaFailed"));
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

const _vocabAnkiBtn = $id("vocab-anki-btn");
if (_vocabAnkiBtn) _vocabAnkiBtn.addEventListener("click", _pbpVocabSendAnki);

const _vocabEudicBtn = $id("vocab-eudic-btn");
if (_vocabEudicBtn) _vocabEudicBtn.addEventListener("click", _pbpVocabSendEudic);

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

// ---- Offline dictionary pack (dict-pack.js primitives; CC-CEDICT) -------
async function _pbpPackRefreshStatus() {
  const el = $id("dict-pack-status");
  const del = $id("dict-pack-delete");
  if (!el) return;
  const meta = (typeof pbpPackMeta === "function") ? await pbpPackMeta() : null;
  if (meta && meta.state === "ready") {
    const d = new Date(meta.importedAt);
    el.textContent = t("dictPackStatus", String(meta.entries),
      d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"));
    if (del) del.hidden = false;
  } else {
    el.textContent = t("dictPackEmpty");
    if (del) del.hidden = true;
  }
}

function _pbpPackWire() {
  const open = $id("dict-pack-open");
  const imp = $id("dict-pack-import");
  const file = $id("dict-pack-file");
  const del = $id("dict-pack-delete");
  if (!open || !imp || !file) return;
  open.addEventListener("click", () => {
    try { chrome.tabs.create({ url: "https://www.mdbg.net/chinese/dictionary?page=cc-cedict" }); } catch (_) {}
  });
  imp.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    file.value = "";
    if (!f || imp.disabled) return;
    imp.disabled = true;
    const el = $id("dict-pack-status");
    let lastShown = 0;
    try {
      const res = await pbpPackImportFile(f, (n) => {
        // TIME-based throttle (~1s): aria-live must not machine-gun the
        // screen reader on a fast import; final state comes from refresh.
        const now = performance.now();
        if (el && now - lastShown >= 1000) { lastShown = now; el.textContent = t("dictPackImporting", String(n)); }
      });
      _pbpVocabFlashStatus(true, t("dictPackDone", String(res.entries)));
    } catch (_) {
      _pbpVocabFlashStatus(false, t("dictPackFailed"));
    } finally {
      imp.disabled = false;
      _pbpPackRefreshStatus();
    }
  });
  if (del) del.addEventListener("click", () => {
    showConfirmPopover(del, {
      msg: t("dictPackDeleteConfirm"),
      yesText: t("delete"),
      noText: t("cancel"),
      onConfirm: async () => {
        try { await pbpPackDelete(); } catch (_) {}
        _pbpPackRefreshStatus();
      }
    });
  });
  _pbpPackRefreshStatus();
}
_pbpPackWire();
