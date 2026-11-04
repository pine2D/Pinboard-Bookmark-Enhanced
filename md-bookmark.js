// Reader-owned save controls. No AI or source-tab access: the worker derives
// the frozen article and owner from this reader's persisted preview slot.
(function () {
  "use strict";
  let context = null;
  let generation = 0;
  let inflight = false;
  // A connection change that arrived while a request was in flight: look again once it ends.
  let recheckConnection = false;
  let deleting = false;
  let state = { known: false };
  let statusKey = "readerBookmarkChecking";
  let editorStatusKey = "";
  // Placeholder values for each failure key whose copy names something (the
  // tag linkding could not store, an HTTP status), stored per key: the rail
  // and the editor can show different keys at once, and each paints its own.
  const failureArgs = new Map();
  const argsFor = key => failureArgs.get(key) || [];
  // Keys whose copy takes failureArgs.
  const ARG_KEYS = ["bookmarkErrTagTooLong", "bookmarkErrRemote"];
  // Every self-hosted failure copy failureKey() has handed out paints the
  // editor status as an error.
  const failureKeys = new Set();
  const partialKeys = new Set(); // the self-hosted partial-save copies, also outcomes of a write
  const failureCopy = key => failureKeys.has(key);
  // Tags linkding could not store, with their copy's placeholders, until a
  // save stores them. A plain Save sends the popup draft's tags, which the
  // reader never shows, and a PostgreSQL create keeps the bookmark without
  // them: Save and Read Later reopen the editor on these tags instead of
  // reporting that tagless bookmark as saved. `stored` is what the server held
  // for the bookmark right after the failure ("" for none): tags stored there
  // since then, from the popup or linkding itself, retire the fix (edit()).
  let tagFix = null;
  let editor = null;
  let editorSource = null;
  let sharedExplicit = false;
  let sharingChoice = false;
  // The one-line Description the editor opened with. Apply sends it only when
  // the user changed it: an untouched line keeps a stored multi-line value as
  // it is, and an unknown one (shown empty) stays for linkding to fill in.
  let shownSummary = "";
  // The bookmark the open editor was filled from: {version, shown}. version
  // (pbpBookmarkVersion) goes with Apply, so an edit is not saved over changes
  // made elsewhere since (user decision 2026-11-02); shown is what each field
  // held then, so a field the user left alone can take the newer value.
  let editorBase = null;
  // After a stop: what the server holds now in the fields the user also
  // edited (pbpBookmarkServerFieldNote sentences), shown after the stop's copy.
  let changedThere = "";
  const buttons = [];
  const text = (key, ...args) => typeof t === "function" ? t(key, ...args) : key;
  const id = name => document.getElementById("reader-bookmark-" + name);

  function label(node, key) {
    node.textContent = text(key);
    node.setAttribute("data-i18n", key);
  }

  function iconLabel(node, key, icon) {
    node.title = text(key);
    node.setAttribute("aria-label", text(key));
    node.setAttribute("data-i18n-title", key);
    node.setAttribute("data-i18n-aria", key);
    if (node.dataset.icon !== icon) {
      node.innerHTML = typeof PBP_ICONS !== "undefined" ? PBP_ICONS[icon] || "" : "";
      node.dataset.icon = icon;
    }
  }

  function button(parent, name, key, action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "reader-bookmark-" + name;
    btn.className = "action-btn reader-bookmark-ic";
    iconLabel(btn, key, { save: "bookmarkPlus", later: "clock", edit: "pencil" }[action]);
    btn.addEventListener("click", () => window.pbpReaderBookmarkAction(action));
    parent.appendChild(btn);
    buttons.push({ btn, action });
    return btn;
  }

  function paint() {
    for (const { btn, action } of buttons) {
      btn.disabled = !context?.account;
      btn.setAttribute("aria-busy", String(inflight));
      if (action === "save") {
        const saved = Boolean(state.known && state.bookmarked);
        iconLabel(btn, saved ? (state.bookmark?.toread ? "readerBookmarkMarkRead" : "readerBookmarkSaved") : "readerBookmarkSave", saved ? "check" : "bookmarkPlus");
        btn.dataset.saved = String(saved);
        btn.setAttribute("aria-keyshortcuts", "s");
      } else if (action === "later") {
        iconLabel(btn, "readerBookmarkLater", "clock");
        btn.setAttribute("aria-pressed", String(state.known && state.bookmarked && state.bookmark?.toread === true));
        btn.setAttribute("aria-keyshortcuts", "l");
      } else if (action === "edit") btn.setAttribute("aria-keyshortcuts", "Shift+S");
    }
    for (const name of ["status", "footer-status"]) {
      const el = id(name);
      if (el) {
        label(el, statusKey); el.hidden = !statusKey;
        if (statusKey === "saveMergedExisting") {
          el.removeAttribute("data-i18n");
          el.textContent = pbpBookmarkMergedText(pbpBookmarkAccountService(context?.account), text);
        } else if (statusKey === "titleTooLong") {
          // The worker refuses a Save / Read Later whose title is over the
          // service's limit and sends the limit along; the copy needs it.
          el.removeAttribute("data-i18n");
          el.textContent = text("titleTooLong", String(argsFor(statusKey)[0] ?? pbpBookmarkLimits(pbpBookmarkAccountService(context?.account)).title));
        } else if (ARG_KEYS.includes(statusKey)) {
          el.removeAttribute("data-i18n");
          el.textContent = text(statusKey, ...argsFor(statusKey));
        }
      }
    }
    if (id("apply")) { id("apply").disabled = !context?.account || inflight; id("apply").setAttribute("aria-busy", String(inflight)); }
    if (id("delete")) {
      id("delete").hidden = !(state.known && state.bookmarked);
      id("delete").disabled = !context?.account || inflight;
      id("delete").setAttribute("aria-busy", String(deleting));
    }
    if (id("editor-status")) {
      label(id("editor-status"), editorStatusKey);
      id("editor-status").hidden = !editorStatusKey;
      if (editorStatusKey === "titleTooLong") {
        id("editor-status").removeAttribute("data-i18n");
        id("editor-status").textContent = text("titleTooLong", String(pbpBookmarkLimits(pbpBookmarkAccountService(context?.account)).title));
      } else if (ARG_KEYS.includes(editorStatusKey)) {
        id("editor-status").removeAttribute("data-i18n");
        id("editor-status").textContent = text(editorStatusKey, ...argsFor(editorStatusKey));
      } else if (editorStatusKey === "bookmarkChangedElsewhere" && changedThere) {
        id("editor-status").removeAttribute("data-i18n");
        id("editor-status").textContent = text(editorStatusKey) + " " + changedThere;
      }
      id("editor-status").dataset.state = ["readerBookmarkDeleteFailed", "readerBookmarkTagsQuoteError", "urlAndTitleRequired", "titleTooLong", "submitUriTooLong"].includes(editorStatusKey) || failureCopy(editorStatusKey) ? "error" : "";
    }
    if (editor) for (const input of editor.querySelectorAll("input, textarea")) input.disabled = deleting;
  }

  function showStatus(key) { statusKey = key; paint(); }

  function mount() {
    if (id("section")) return;
    const badges = document.querySelector("#rail > .rail-badges") || document.querySelector(".rail-badges");
    const article = document.getElementById("rendered-view");
    if (!badges || !article) return;
    const section = document.createElement("section");
    section.id = "reader-bookmark-section";
    section.className = "rail-section";
    const heading = document.createElement("div");
    heading.className = "rail-label";
    label(heading, "readerBookmarkSection");
    section.appendChild(heading);
    const row = document.createElement("div"); row.className = "row";
    button(row, "save", "readerBookmarkSave", "save");
    button(row, "later", "readerBookmarkLater", "later");
    button(row, "edit", "readerBookmarkEdit", "edit");
    section.appendChild(row);
    const status = document.createElement("div");
    status.id = "reader-bookmark-status";
    status.className = "msg-bar";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    section.appendChild(status);
    badges.insertAdjacentElement("afterend", section);
    const footer = document.createElement("footer");
    footer.id = "reader-bookmark-footer";
    footer.className = "rail-section";
    const footerRow = document.createElement("div"); footerRow.className = "row";
    button(footerRow, "footer-save", "readerBookmarkSave", "save");
    button(footerRow, "footer-later", "readerBookmarkLater", "later");
    button(footerRow, "footer-edit", "readerBookmarkEdit", "edit");
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.id = "reader-bookmark-footer-export";
    exportBtn.className = "action-btn reader-bookmark-ic";
    iconLabel(exportBtn, "readerBookmarkExport", "download");
    exportBtn.addEventListener("click", () => window.pbpReaderOpenExport?.());
    footerRow.appendChild(exportBtn);
    footer.appendChild(footerRow);
    const footerStatus = status.cloneNode(false);
    footerStatus.id = "reader-bookmark-footer-status";
    footer.appendChild(footerStatus);
    article.insertAdjacentElement("afterend", footer);
  }

  // pbp:bookmark-changed names the bookmark by its own address (the handoff's
  // bookmarkUrl; a slot from before it existed has only url) and owner. After
  // a save it also hands the bookmark as the server now holds it, which the
  // export metadata takes over (md-preview.js); a delete hands none.
  function changedDetail() {
    const detail = { url: context.bookmarkUrl || context.url, account: context.account };
    const saved = state.known && state.bookmarked ? state.bookmark : null;
    if (saved && typeof saved === "object") {
      detail.bookmark = {
        tags: Array.isArray(saved.tagNames) ? saved.tagNames.slice() : String(saved.tags || "").split(/\s+/).filter(Boolean),
        ...(typeof saved.notes === "string" ? { notes: saved.notes } : {}),
        ...(typeof saved.summary === "string" ? { summary: saved.summary } : {}),
      };
    }
    return detail;
  }

  async function request(message) {
    try { return await chrome.runtime.sendMessage({ ...message, account: context?.account || "" }); }
    catch (e) {
      console.warn("reader bookmark message failed:", e?.name, e?.message);
      return { status: "failed", reason: "network" };
    }
  }

  // Self-hosted failure key for a background result; "" keeps the default copy.
  // Also takes the copy's placeholders (a tag, an HTTP status) into failureArgs.
  function failureKey(result) {
    const key = typeof pbpBookmarkFailureKey === "function" && typeof pbpBookmarkAccountService === "function"
      ? pbpBookmarkFailureKey(result, pbpBookmarkAccountService(context?.account)) : "";
    if (key) {
      failureKeys.add(key);
      failureArgs.set(key, typeof pbpBookmarkFailureArgs === "function" ? pbpBookmarkFailureArgs(result) : []);
    }
    return key;
  }

  // The bar's one lookup of this address is also the rail badge's: md-preview.js
  // draws the badge from this event instead of asking the worker a second time
  // (linkding fetches the page on every check).
  function publishState() {
    const saved = state.known && state.bookmarked ? state.bookmark : null;
    const detail = { url: context.bookmarkUrl || context.url, account: context.account, bookmarked: !!saved };
    if (saved && typeof saved === "object") {
      detail.tagNames = Array.isArray(saved.tagNames) ? saved.tagNames.slice() : String(saved.tags || "").split(/\s+/).filter(Boolean);
      detail.shared = saved.private === true ? "no" : "yes";
    }
    document.dispatchEvent(new CustomEvent("pbp:bookmark-state", { detail }));
  }

  async function refresh(expectedGeneration) {
    const result = await request({ type: "mdReaderBookmarkState" });
    if (expectedGeneration !== generation || result?.account !== context?.account) {
      if (expectedGeneration === generation && result?.reason === "account_changed") showStatus("readerBookmarkAccountChanged");
      return false;
    }
    state = result?.known ? result : { known: false };
    if (!state.known) showStatus(failureKey({reason:result?.reason, httpStatus:result?.httpStatus}) || "readerBookmarkLookupFailed");
    else paint();
    publishState();
    return state.known;
  }

  function closeEditor() {
    if (typeof pbpDismissActiveConfirm === "function" && id("delete")) pbpDismissActiveConfirm(id("delete"));
    if (editor?.matches(":popover-open")) {
      const restore = editor.contains(document.activeElement) || document.activeElement === document.body;
      editor.hidePopover();
      if (restore && editorSource?.isConnected) editorSource.focus({ preventScroll: true });
    }
  }

  function ensureEditor() {
    if (editor) return;
    editor = document.createElement("div");
    editor.id = "reader-bookmark-editor";
    editor.className = "pop-panel";
    editor.setAttribute("popover", "auto");
    editor.setAttribute("role", "dialog");
    editor.setAttribute("aria-labelledby", "reader-bookmark-editor-title");
    const head = document.createElement("div"); head.className = "panel-head";
    const title = document.createElement("h2");
    title.id = "reader-bookmark-editor-title";
    label(title, "readerBookmarkEdit"); head.appendChild(title); editor.appendChild(head);
    const options = document.createElement("div");
    options.id = "reader-bookmark-options"; options.className = "row";
    for (const [name, key, type] of [["title", "readerBookmarkTitle", "text"], ["tags", "readerBookmarkTags", "text"], ["summary", "readerBookmarkDescription", "text"], ["notes", "readerBookmarkNotes", "textarea"], ["private", "readerBookmarkPrivate", "checkbox"], ["toread", "readerBookmarkLater", "checkbox"]]) {
      const field = document.createElement("label");
      const caption = document.createElement("span"); label(caption, key);
      const input = type === "textarea" ? document.createElement("textarea") : document.createElement("input");
      input.id = "reader-bookmark-" + name;
      if (type !== "textarea") input.type = type;
      if (name === "private") input.addEventListener("change", () => {
        if (state.sharingSupported !== true || input.disabled || input.closest("label").hidden) return;
        if (input.checked !== sharingChoice) sharedExplicit = true;
        sharingChoice = input.checked;
      });
      if (type === "checkbox") {
        field.className = "row";
        const mark = document.createElement("span"); mark.className = "reader-check";
        mark.innerHTML = typeof PBP_ICONS !== "undefined" ? PBP_ICONS.check : "";
        mark.prepend(input); field.append(mark, caption); options.appendChild(field);
      } else {
        field.append(caption, input); editor.appendChild(field);
      }
    }
    editor.appendChild(options);
    const status = document.createElement("div");
    status.id = "reader-bookmark-editor-status"; status.className = "msg-bar";
    status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.hidden = true;
    editor.appendChild(status);
    const row = document.createElement("div"); row.className = "row";
    row.id = "reader-bookmark-actions";
    const remove = document.createElement("button");
    remove.id = "reader-bookmark-delete"; remove.type = "button"; remove.className = "action-btn";
    label(remove, "readerBookmarkDelete"); remove.addEventListener("click", confirmDelete);
    row.appendChild(remove);
    const submit = document.createElement("div"); submit.className = "row";
    const apply = document.createElement("button");
    apply.id = "reader-bookmark-apply"; apply.type = "button"; apply.className = "action-btn";
    label(apply, "readerBookmarkApply");
    apply.addEventListener("click", () => save("edit", {
      title: id("title").value, tags: id("tags").value, notes: id("notes").value,
      ...(state.descriptionSupported === true && pbpBookmarkDescriptionLine(id("summary").value) !== shownSummary
        ? { summary: pbpBookmarkDescriptionLine(id("summary").value) } : {}),
      ...(state.sharingSupported === true ? { sharedExplicit } : {}),
      private: state.sharingSupported === true ? !id("private").checked : state.privacySupported === false || id("private").checked, toread: id("toread").checked,
    }));
    const cancel = document.createElement("button");
    cancel.id = "reader-bookmark-cancel"; cancel.type = "button"; cancel.className = "action-btn";
    label(cancel, "readerBookmarkCancel"); cancel.addEventListener("click", closeEditor);
    submit.append(apply, cancel); row.appendChild(submit); editor.appendChild(row); document.body.appendChild(editor);
    editor.addEventListener("toggle", event => {
      if (event.newState === "closed" && typeof pbpDismissActiveConfirm === "function") pbpDismissActiveConfirm(remove);
      if (event.newState === "closed" && editor.contains(document.activeElement) && editorSource?.isConnected) editorSource.focus({ preventScroll: true });
    });
  }

  // What each editor field shows for a bookmark's values.
  function editorFields(values) {
    return {
      title: typeof values.title === "string" ? values.title : context.title || "",
      tags: typeof values.tags === "string" ? values.tags : pbpBookmarkFormatTags(context.bookmark?.tags || []),
      summary: state.descriptionSupported === true && typeof values.summary === "string" ? pbpBookmarkDescriptionLine(values.summary) : "",
      notes: typeof values.notes === "string" ? values.notes : context.bookmark?.notes || "",
      private: state.sharingSupported === true ? values.private === false : state.privacySupported === false || values.private === true,
      toread: values.toread === true,
    };
  }

  // The tag line as names, the way Apply reads it (pbpPrepareReaderSaveIntent);
  // throws on an unclosed quote in a quoted tag line.
  function tagNames(line) {
    return state.quotedTags === true ? pbpBookmarkParseTags(line) : String(line || "").split(/\s+/).filter(Boolean);
  }
  function tagLine(names) {
    return state.quotedTags === true ? pbpBookmarkFormatTags(names) : names.join(" ");
  }

  // The bookmark changed elsewhere since the editor opened, or a partial save
  // wrote part of it: the fields the user left alone take its new values, the
  // ones they changed keep their text, their tag changes are made on its
  // tags (so a tag added there, by hand or by Karakeep's AI, stays), and Apply
  // now saves on top of this version. A text field changed on both sides
  // keeps the user's text and names the server's (changedThere).
  function rebaseEditor() {
    if (!editor || !state.known || !state.bookmarked) return;
    const shown = editorBase?.shown || {};
    const latest = editorFields(state.bookmark || {});
    const notes = [];
    for (const [name, key] of [["title", "readerBookmarkTitle"], ["summary", "readerBookmarkDescription"], ["notes", "readerBookmarkNotes"]]) {
      const mine = id(name).value;
      if (mine === shown[name]) id(name).value = latest[name];
      else if (mine !== latest[name] && shown[name] !== latest[name] && !(name === "summary" && state.descriptionSupported !== true)) {
        notes.push(pbpBookmarkServerFieldNote(text, text(key), latest[name]));
      }
    }
    for (const name of ["private", "toread"]) if (id(name).checked === shown[name]) id(name).checked = latest[name];
    if (!sharedExplicit) sharingChoice = id("private").checked;
    changedThere = notes.join(" ");
    shownSummary = latest.summary;
    if (id("tags").value === shown.tags) id("tags").value = latest.tags;
    else {
      let mine, merged;
      try {
        mine = tagNames(id("tags").value);
        merged = pbpRebaseLoadedTags(typeof shown.tags === "string" ? tagNames(shown.tags) : null, mine, tagNames(latest.tags));
      } catch (_) {
        // A tag line Apply cannot read yet: it stays as typed, and this
        // version is not taken as the base, so the Apply after the fix
        // stops once more and makes the tag change on the newest tags.
        return;
      }
      const key = names => names.map(pbpTagTwinKey).sort().join("\n");
      if (key(merged) !== key(mine)) id("tags").value = tagLine(merged);
    }
    editorBase = { version: state.bookmark?.version, shown: latest };
  }

  // The tags the server holds for this page's bookmark, "" for none or no bookmark.
  function storedTags() {
    return state.known && state.bookmarked && typeof state.bookmark?.tags === "string" ? state.bookmark.tags.trim() : "";
  }

  // The reader looks the address up again after a connection change. A change
  // while the bar is idle always looks again (the user changed settings after
  // seeing the result). A change that arrived while a request was in flight is
  // handled once that request has ended (success or not): only an error or a
  // pending check can come from the old settings, while a write result (saved,
  // merged, queued, partial, deleted) is the outcome of that request and stays
  // on screen; the delete result is final, so no second look.
  const WRITE_OUTCOME_KEYS = new Set(["readerBookmarkSaved", "readerBookmarkUpdated", "saveMergedExisting", "readerBookmarkQueued",
    "readerBookmarkDeleted", "readerBookmarkDeletedElsewhere", "bookmarkPartialSave", "bookmarkErrTagTooLong"]);
  function statusFromOldConnection() { return !WRITE_OUTCOME_KEYS.has(statusKey) && !partialKeys.has(statusKey); }
  function recheckIfPending(idleChange = false) {
    if (!recheckConnection || inflight || !context?.account) return;
    recheckConnection = false;
    if (!idleChange && !statusFromOldConnection()) return;
    inflight = true; showStatus("readerBookmarkChecking");
    const gen = generation;
    refresh(gen).finally(() => { if (gen === generation) { inflight = false; if (state.known) statusKey = ""; paint(); recheckIfPending(); } });
  }

  async function edit() {
    try { return await editImpl(); } finally { recheckIfPending(); }
  }

  async function editImpl() {
    if (inflight || !context?.account) return;
    inflight = true; paint(); const gen = generation;
    const known = await refresh(gen);
    if (gen !== generation) return;
    inflight = false; paint();
    if (!known) return;
    // Tags stored elsewhere since the failure fixed it there: open on those,
    // and stop naming the long tag in the rail and footer status.
    if (tagFix && storedTags() !== "" && storedTags() !== tagFix.stored) {
      tagFix = null;
      if (statusKey === "bookmarkErrTagTooLong") statusKey = "";
    }
    ensureEditor();
    editorStatusKey = ""; changedThere = ""; paint();
    const values = { ...(state.bookmark || context.bookmark?.draft || {}),
      ...(typeof tagFix?.tags === "string" ? { tags: tagFix.tags } : {}) };
    if (tagFix) { failureArgs.set("bookmarkErrTagTooLong", tagFix.args); editorStatusKey = "bookmarkErrTagTooLong"; paint(); }
    const fields = editorFields(values);
    label(id("tags").closest("label").firstElementChild, state.quotedTags === true ? "readerBookmarkTagsQuoted" : "readerBookmarkTags");
    id("summary").closest("label").hidden = state.descriptionSupported !== true;
    const privacyLabel = id("private").closest("label");
    privacyLabel.hidden = state.privacySupported === false && state.sharingSupported !== true;
    label(privacyLabel.lastElementChild, state.sharingSupported === true ? "bookmarkShare" : "readerBookmarkPrivate");
    for (const name of ["title", "tags", "summary", "notes"]) id(name).value = fields[name];
    for (const name of ["private", "toread"]) id(name).checked = fields[name];
    shownSummary = fields.summary;
    editorBase = { version: state.known && state.bookmarked ? state.bookmark?.version : undefined, shown: fields };
    // Only a click on this Share box records a sharing choice; the popup's
    // draft never shares a bookmark the reader creates.
    sharedExplicit = false;
    sharingChoice = id("private").checked;
    editorSource = document.activeElement;
    if (!editor.matches(":popover-open")) editor.showPopover();
    id(tagFix ? "tags" : "title").focus();
  }

  function confirmDelete() {
    if (inflight || !context?.account || !state.known || !state.bookmarked || !editor?.matches(":popover-open")) return;
    const gen = generation;
    showConfirmPopover(id("delete"), {
      container: editor,
      msg: text("readerBookmarkDeleteConfirm"), yesText: text("delete"), noText: text("readerBookmarkCancel"),
      subject: state.bookmark?.title || context.title || context.url,
      detail: text("readerBookmarkDeleteDetail"),
      onConfirm: () => {
        if (gen === generation && editor?.matches(":popover-open")) return deleteBookmark();
      },
    });
  }

  async function deleteBookmark() {
    try { return await deleteBookmarkImpl(); } finally { recheckIfPending(); }
  }

  async function deleteBookmarkImpl() {
    if (inflight || !context?.account || !state.known || !state.bookmarked) return;
    const gen = generation;
    inflight = true; deleting = true; editorStatusKey = "readerBookmarkDeleting";
    showStatus(editorStatusKey);
    const result = await request({ type: "mdReaderBookmarkDelete" });
    if (gen !== generation) return;
    inflight = false; deleting = false;
    if (result?.status === "deleted" && result.account === context.account) {
      // The successful delete is authoritative; a second lookup could fail
      // or return stale data and must not paint the removed bookmark as saved.
      state = { known: true, bookmarked: false, account: context.account };
      editorStatusKey = ""; statusKey = "readerBookmarkDeleted"; tagFix = null;
      closeEditor();
      publishState();
      document.dispatchEvent(new CustomEvent("pbp:bookmark-changed", { detail: changedDetail() }));
    } else {
      const foreign = !!(result?.account && result.account !== context.account);
      editorStatusKey = foreign ? "readerBookmarkAccountChanged" : failureKey(result)
        || (result?.reason === "account_changed" || result?.reason === "not_logged_in" ? "readerBookmarkAccountChanged" : "readerBookmarkDeleteFailed");
      statusKey = editorStatusKey;
    }
    paint();
  }

  async function save(action, draft) {
    try { return await saveImpl(action, draft); } finally { recheckIfPending(); }
  }

  async function saveImpl(action, draft) {
    if (inflight || !context?.account) return;
    if (action === "edit" && draft) {
      if (state.quotedTags === true) {
        try { pbpBookmarkParseTags(draft.tags); }
        catch (_) { editorStatusKey = "readerBookmarkTagsQuoteError"; paint(); return; }
      }
      const service = pbpBookmarkAccountService(context.account);
      const limits = pbpBookmarkLimits(service);
      if (!String(draft.title ?? "").trim()) { editorStatusKey = "urlAndTitleRequired"; paint(); return; }
      const titleOver = pbpBookmarkTitleTooLong(draft.title, service);
      if (titleOver || (limits.notesHard !== null && draft.notes.length > limits.notesHard)) {
        editorStatusKey = titleOver ? "titleTooLong" : "submitUriTooLong";
        paint();
        return;
      }
    }
    editorStatusKey = ""; changedThere = "";
    const gen = generation;
    // The tags a plain Save sends: the popup draft's, for a page not yet saved.
    const sentTags = action === "edit" ? draft?.tags
      : state.known && !state.bookmarked && typeof state.bookmark?.tags === "string" ? state.bookmark.tags : undefined;
    let reopen = false;
    // A result without a mutation (a Pinboard one) is told by the bar's state
    // before this save: a bookmark that was not there yet has been saved.
    const wasBookmarked = Boolean(state.known && state.bookmarked);
    inflight = true; showStatus("readerBookmarkSaving");
    // An edit or Read Later changes the bookmark the bar showed. If it has been
    // deleted elsewhere since, the worker stops instead of creating it again.
    const result = await request({ type: "mdReaderBookmarkSave", action, ...(draft ? { draft } : {}),
      ...(action === "edit" || action === "later" ? { expectBookmarked: wasBookmarked } : {}),
      ...(action === "edit" && typeof editorBase?.version === "string" ? { expectedVersion: editorBase.version } : {}) });
    if (gen !== generation) return;
    if (result?.account && result.account !== context.account) {
      inflight = false; showStatus("readerBookmarkAccountChanged"); return;
    }
    if (["saved", "skipped", "queued"].includes(result?.status)) tagFix = null;
    if (result?.status === "saved" || result?.status === "skipped") {
      closeEditor();
      await refresh(gen);
      if (gen !== generation) return;
      statusKey = result.mutation === "merged" ? "saveMergedExisting"
        : result.status === "skipped" || result.mutation === "created" ? "readerBookmarkSaved"
          : result.mutation === "updated" || wasBookmarked ? "readerBookmarkUpdated" : "readerBookmarkSaved";
      document.dispatchEvent(new CustomEvent("pbp:bookmark-changed", { detail: changedDetail() }));
    } else if (result?.status === "queued") {
      closeEditor(); statusKey = "readerBookmarkQueued";
    } else if (result?.reason === "deleted_elsewhere") {
      // Nothing was written. The bar now shows the page as not bookmarked, an
      // open editor keeps what the user typed, and only their next save, made
      // after reading this, bookmarks the page again.
      await refresh(gen);
      if (gen !== generation) return;
      statusKey = "readerBookmarkDeletedElsewhere";
      if (action === "edit") editorStatusKey = statusKey;
    } else if (result?.reason === "changed_elsewhere") {
      // Nothing was written. The worker's check found the bookmark as it is
      // now; the bar and the open editor take it, keeping the user's edits.
      if (result.bookmark && typeof result.bookmark === "object") {
        state = { ...state, known: true, bookmarked: true, bookmark: result.bookmark };
        publishState();
      } else {
        await refresh(gen);
        if (gen !== generation) return;
      }
      if (action === "edit") rebaseEditor();
      statusKey = "bookmarkChangedElsewhere";
      if (action === "edit") editorStatusKey = statusKey;
    } else if (result?.reason === "partial") {
      await refresh(gen);
      if (gen !== generation) return;
      // Part of the edit is on the server now: the open editor takes the
      // bookmark this save wrote as its base, so the retry is not stopped as
      // changed elsewhere by this save's own write.
      if (action === "edit") rebaseEditor();
      const named = typeof pbpBookmarkPartialKey === "function" ? pbpBookmarkPartialKey(result) : "";
      if (named) { failureKeys.add(named); partialKeys.add(named); }
      statusKey = named || "bookmarkPartialSave";
    } else if (result?.reason === "tag_too_long") {
      // linkding writes a new bookmark before its tags, so read it again. An
      // open editor stays open to shorten the tag the copy names; a plain
      // Save opens it on the tags it sent.
      await refresh(gen);
      if (gen !== generation) return;
      if (action === "edit") rebaseEditor();
      statusKey = failureKey(result) || "readerBookmarkFailed";
      if (statusKey === "bookmarkErrTagTooLong") {
        tagFix = { tags: sentTags, args: argsFor(statusKey), stored: storedTags() };
        reopen = action !== "edit";
      }
      if (action === "edit") editorStatusKey = statusKey;
    } else if (action === "edit" && state.quotedTags === true && result?.reason === "invalid") {
      editorStatusKey = "readerBookmarkTagsQuoteError";
      statusKey = "readerBookmarkFailed";
    } else statusKey = failureKey(result) || (result?.reason === "account_changed" || result?.reason === "not_logged_in" ? "readerBookmarkAccountChanged" : "readerBookmarkFailed");
    inflight = false; paint();
    if (reopen) return edit();
  }

  window.pbpReaderBookmarkAction = function (action) {
    if (action === "edit") return edit();
    if (action !== "save" && action !== "later") return;
    if (tagFix) {
      // An editor already open on those tags may hold the user's shortened
      // ones: a shortcut only puts the cursor back there, it does not refill it.
      if (editor?.matches(":popover-open")) { id("tags").focus(); return; }
      return edit();
    }
    return save(action === "save" && state.known && state.bookmarked && state.bookmark?.toread ? "read" : action);
  };

  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
        || event.ctrlKey || event.metaKey || event.altKey) return;
    const active = document.activeElement;
    if (active?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName || "")
        || document.querySelector(":popover-open, dialog[open], .modal.open")) return;
    const key = event.key.toLowerCase();
    const action = key === "s" ? (event.shiftKey ? "edit" : "save") : key === "l" && !event.shiftKey ? "later" : "";
    if (!action) return;
    event.preventDefault(); window.pbpReaderBookmarkAction(action);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "PBP_READER_BOOKMARK_COMMAND" || sender?.id !== chrome.runtime.id
        || sender.tab || !["save", "later"].includes(message.action)) return;
    if (sender.url && sender.url !== chrome.runtime.getURL("background.js")) return;
    window.pbpReaderBookmarkAction(message.action); sendResponse({ ok: true });
  });

  document.addEventListener("pbp:rendered", event => {
    const next = {...event.detail, account:event.detail?.bookmarkAccount ?? event.detail?.account};
    // A second render of the same article must not unlock an in-flight write.
    if (context?.url === next?.url && context?.account === next?.account) return;
    closeEditor();
    generation++; recheckConnection = false; context = next; state = { known: false }; inflight = true; deleting = false; editorStatusKey = ""; tagFix = null;
    mount();
    // No bookmark connection: nothing to look up. The buttons stay disabled and
    // the bar says where to connect (it is not an account switch).
    if (!context?.account) { inflight = false; showStatus("bgSetToken"); return; }
    showStatus("readerBookmarkChecking"); const gen = generation;
    refresh(gen).finally(() => { if (gen === generation) { inflight = false; if (state.known) statusKey = ""; paint(); recheckIfPending(); } });
  });
  // The same account with other connection settings (a new gateway, a rotated
  // token; a Connect that stores the same values fires nothing): look the
  // address up once more so an earlier error
  // does not outlive the fix. A request in flight finishes first, then this looks again
  // unless the bar then shows that request's write outcome.
  document.addEventListener("pbp:bookmark-connection-changed", event => {
    if (!context?.account || event.detail?.account !== context.account) return;
    recheckConnection = true;
    recheckIfPending(true);
  });
  document.addEventListener("pbp:bookmark-account-changed", event => {
    generation++; recheckConnection = false; context = event.detail || null; state = { known: false }; inflight = true; deleting = false; editorStatusKey = ""; tagFix = null;
    closeEditor();
    if (editor) for (const input of editor.querySelectorAll("input, textarea")) { input.value = ""; input.checked = false; }
    if (!context?.account) { inflight = false; showStatus("bgSetToken"); return; }
    showStatus("readerBookmarkChecking");
    const gen = generation;
    refresh(gen).finally(() => { if (gen === generation) { inflight = false; if (state.known) statusKey = ""; paint(); recheckIfPending(); } });
  });
})();
