// Reader-owned save controls. No AI or source-tab access: the worker derives
// the frozen article and owner from this reader's persisted preview slot.
(function () {
  "use strict";
  let context = null;
  let generation = 0;
  let inflight = false;
  let deleting = false;
  let state = { known: false };
  let statusKey = "readerBookmarkChecking";
  let editorStatusKey = "";
  // Placeholder values for a failure key whose copy names something (the tag
  // linkding could not store); set together with that key.
  let failureArgs = [];
  let editor = null;
  let editorSource = null;
  let sharedExplicit = false;
  let sharingChoice = false;
  // The one-line Description the editor opened with. Apply sends it only when
  // the user changed it: an untouched line keeps a stored multi-line value as
  // it is, and an unknown one (shown empty) stays for linkding to fill in.
  let shownSummary = "";
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
        } else if (statusKey === "bookmarkErrTagTooLong") {
          el.removeAttribute("data-i18n");
          el.textContent = text(statusKey, ...failureArgs);
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
      } else if (editorStatusKey === "bookmarkErrTagTooLong") {
        id("editor-status").removeAttribute("data-i18n");
        id("editor-status").textContent = text(editorStatusKey, ...failureArgs);
      }
      id("editor-status").dataset.state = ["readerBookmarkDeleteFailed", "readerBookmarkTagsQuoteError", "titleTooLong", "submitUriTooLong", "bookmarkErrTagTooLong"].includes(editorStatusKey) ? "error" : "";
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

  async function request(message) {
    try { return await chrome.runtime.sendMessage({ ...message, account: context?.account || "" }); }
    catch (e) {
      console.warn("reader bookmark message failed:", e?.name, e?.message);
      return { status: "failed", reason: "network" };
    }
  }

  // Self-hosted failure key for a background result; "" keeps the default copy.
  function failureKey(result) {
    return typeof pbpBookmarkFailureKey === "function" && typeof pbpBookmarkAccountService === "function"
      ? pbpBookmarkFailureKey(result, pbpBookmarkAccountService(context?.account)) : "";
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

  async function edit() {
    if (inflight || !context?.account) return;
    inflight = true; paint(); const gen = generation;
    const known = await refresh(gen);
    if (gen !== generation) return;
    inflight = false; paint();
    if (!known) return;
    ensureEditor();
    editorStatusKey = ""; paint();
    const values = state.bookmark || context.bookmark?.draft || {};
    id("title").value = typeof values.title === "string" ? values.title : context.title || "";
    label(id("tags").closest("label").firstElementChild, state.quotedTags === true ? "readerBookmarkTagsQuoted" : "readerBookmarkTags");
    id("tags").value = typeof values.tags === "string" ? values.tags : pbpBookmarkFormatTags(context.bookmark?.tags || []);
    id("summary").closest("label").hidden = state.descriptionSupported !== true;
    id("summary").value = state.descriptionSupported === true && typeof values.summary === "string" ? pbpBookmarkDescriptionLine(values.summary) : "";
    shownSummary = id("summary").value;
    id("notes").value = typeof values.notes === "string" ? values.notes : context.bookmark?.notes || "";
    const privacyLabel = id("private").closest("label");
    privacyLabel.hidden = state.privacySupported === false && state.sharingSupported !== true;
    label(privacyLabel.lastElementChild, state.sharingSupported === true ? "bookmarkShare" : "readerBookmarkPrivate");
    id("private").checked = state.sharingSupported === true ? values.private === false : state.privacySupported === false || values.private === true; id("toread").checked = values.toread === true;
    // Only a click on this Share box records a sharing choice; the popup's
    // draft never shares a bookmark the reader creates.
    sharedExplicit = false;
    sharingChoice = id("private").checked;
    editorSource = document.activeElement;
    editor.showPopover(); id("title").focus();
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
      editorStatusKey = ""; statusKey = "readerBookmarkDeleted";
      closeEditor();
      document.dispatchEvent(new CustomEvent("pbp:bookmark-changed", { detail: { url: context.url, account: context.account } }));
    } else {
      const foreign = !!(result?.account && result.account !== context.account);
      editorStatusKey = foreign ? "readerBookmarkAccountChanged" : failureKey(result)
        || (result?.reason === "account_changed" || result?.reason === "not_logged_in" ? "readerBookmarkAccountChanged" : "readerBookmarkDeleteFailed");
      statusKey = editorStatusKey;
    }
    paint();
  }

  async function save(action, draft) {
    if (inflight || !context?.account) return;
    if (action === "edit" && draft) {
      if (state.quotedTags === true) {
        try { pbpBookmarkParseTags(draft.tags); }
        catch (_) { editorStatusKey = "readerBookmarkTagsQuoteError"; paint(); return; }
      }
      const service = pbpBookmarkAccountService(context.account);
      const limits = pbpBookmarkLimits(service);
      const titleOver = pbpBookmarkTitleTooLong(draft.title, service);
      if (titleOver || (limits.notesHard !== null && draft.notes.length > limits.notesHard)) {
        editorStatusKey = titleOver ? "titleTooLong" : "submitUriTooLong";
        paint();
        return;
      }
    }
    editorStatusKey = "";
    const gen = generation;
    inflight = true; showStatus("readerBookmarkSaving");
    const result = await request({ type: "mdReaderBookmarkSave", action, ...(draft ? { draft } : {}) });
    if (gen !== generation) return;
    if (result?.account && result.account !== context.account) {
      inflight = false; showStatus("readerBookmarkAccountChanged"); return;
    }
    if (result?.status === "saved" || result?.status === "skipped") {
      closeEditor();
      await refresh(gen);
      if (gen !== generation) return;
      statusKey = result.mutation === "merged" ? "saveMergedExisting"
        : result.status === "saved" ? "readerBookmarkUpdated" : "readerBookmarkSaved";
      document.dispatchEvent(new CustomEvent("pbp:bookmark-changed", { detail: { url: context.url, account: context.account } }));
    } else if (result?.status === "queued") {
      closeEditor(); statusKey = "readerBookmarkQueued";
    } else if (result?.reason === "partial") {
      await refresh(gen);
      if (gen !== generation) return;
      statusKey = "bookmarkPartialSave";
    } else if (result?.reason === "tag_too_long") {
      // linkding writes a new bookmark before its tags, so read it again. An
      // open editor stays open to shorten the tag the copy names.
      await refresh(gen);
      if (gen !== generation) return;
      failureArgs = typeof pbpBookmarkFailureArgs === "function" ? pbpBookmarkFailureArgs(result) : [];
      statusKey = failureKey(result) || "readerBookmarkFailed";
      if (action === "edit") editorStatusKey = statusKey;
    } else if (action === "edit" && state.quotedTags === true && result?.reason === "invalid") {
      editorStatusKey = "readerBookmarkTagsQuoteError";
      statusKey = "readerBookmarkFailed";
    } else statusKey = failureKey(result) || (result?.reason === "account_changed" || result?.reason === "not_logged_in" ? "readerBookmarkAccountChanged" : "readerBookmarkFailed");
    inflight = false; paint();
  }

  window.pbpReaderBookmarkAction = function (action) {
    if (action === "edit") return edit();
    if (action !== "save" && action !== "later") return;
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
    generation++; context = next; state = { known: false }; inflight = true; deleting = false; editorStatusKey = "";
    mount(); showStatus("readerBookmarkChecking"); const gen = generation;
    refresh(gen).finally(() => { if (gen === generation) { inflight = false; if (state.known) statusKey = ""; paint(); } });
  });
  document.addEventListener("pbp:bookmark-account-changed", event => {
    generation++; context = event.detail || null; state = { known: false }; inflight = true; deleting = false; editorStatusKey = "";
    closeEditor();
    if (editor) for (const input of editor.querySelectorAll("input, textarea")) { input.value = ""; input.checked = false; }
    if (!context?.account) { showStatus("readerBookmarkAccountChanged"); return; }
    showStatus("readerBookmarkChecking");
    const gen = generation;
    refresh(gen).finally(() => { if (gen === generation) { inflight = false; if (state.known) statusKey = ""; paint(); } });
  });
})();
