// ============================================================
// popup-offline.js — Offline queue visibility / per-item actions
// Relies on globals: t() from i18n.js
// ============================================================

(function () {
  let expanded = false;
  // Focus noted before a control disables itself (a disabled button gives up
  // focus on its own), for the redraw that follows to hand back.
  let heldFocus = null;

  function relTime(ts) {
    if (!ts) return "";
    const diff = Math.max(0, Date.now() - ts);
    const s = Math.floor(diff / 1000);
    if (s < 60) return t("offlineJustNow");
    const m = Math.floor(s / 60);
    if (m < 60) return t("offlineMinAgo", String(m));
    const h = Math.floor(m / 60);
    if (h < 24) return t("offlineHourAgo", String(h));
    const d = Math.floor(h / 24);
    return t("offlineDayAgo", String(d));
  }

  // { queue, pause, account }: pause is the worker's connection-level replay
  // pause ({account, reason}) or null; account is the current connection's
  // owner ("" for none), or null when the worker did not answer.
  async function getQueueState() {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "get_offline_queue" }, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp);
      });
    });
    if (response?.ok && Array.isArray(response.queue)) {
      return { queue: response.queue, pause: response.pause || null, account: typeof response.account === "string" ? response.account : null };
    }
    const { offlineQueue = [], offlineQueuePause = null } = await chrome.storage.local.get(["offlineQueue", "offlineQueuePause"]);
    return { queue: Array.isArray(offlineQueue) ? offlineQueue : [], pause: offlineQueuePause, account: null };
  }

  // An item queued under a connection other than the current one stays in
  // the queue and is never replayed for this one (fail-closed); it is only
  // counted and labelled apart. Unknown current connection: nothing is.
  function fromOtherConnection(item, current) {
    return typeof current === "string" && pbpOfflineQueueAccount(item) !== current;
  }
  // Pinboard rows keep "@username"; a self-hosted row names its service and
  // host when it is not the current connection's.
  function sourceLabel(item, current) {
    const owner = pbpOfflineQueueAccount(item);
    if (pbpBookmarkAccountService(owner) === "pinboard") return pbpOfflineQueueSourceLabel(owner);
    return typeof current === "string" && owner === current ? "" : pbpOfflineQueueSourceLabel(owner);
  }

  // The pause only matters while that connection still has queued items.
  function pauseText(queue, pause) {
    if (!pause || typeof pause.account !== "string" || !pause.account || typeof pause.reason !== "string") return "";
    if (!queue.some((item) => item?.account === pause.account)) return "";
    // Every cause pbpBookmarkStopCause records has a row in the shared table.
    const text = pbpBookmarkFailureText({ reason: pause.reason }, pbpBookmarkAccountService(pause.account), t);
    return text ? t("offlineQueuePaused", text) : "";
  }
  // NOTE: no setQueue() here — the offline queue is mutated ONLY by the SW
  // (background.js mutateOfflineQueue, single-writer mutex, D1). The popup reads
  // via getQueue() and sends messages for retry/remove; it never writes directly.

  // Focus that sat inside the bar or its list before a redraw, as something a
  // redraw can find again: the control kind, its row id and its row position.
  function captureFocus(bar) {
    const list = $id("offline-queue-list");
    const el = document.activeElement;
    if (!el || el === document.body || typeof el.closest !== "function") return null;
    if (!bar.contains(el) && !(list && list.contains(el))) return null;
    const row = el.closest(".offline-queue-item");
    const kind = ["offline-queue-retry", "offline-queue-remove"].find((name) => el.classList.contains(name)) || el.id || "";
    const rows = list ? [...list.querySelectorAll(".offline-queue-item")] : [];
    return { el, kind, queueId: row ? row.dataset.queueId : "", index: row ? rows.indexOf(row) : -1 };
  }

  function canFocus(el) {
    return !!el && !el.disabled && el.isConnected && el.getClientRects().length > 0;
  }

  // The redraw removed or hid the focused control: hand focus to the nearest
  // control that is still there. A control that survived keeps its focus.
  function restoreFocus(saved) {
    if (!saved || canFocus(saved.el)) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== saved.el && canFocus(active)) return;
    const list = $id("offline-queue-list");
    const rows = list ? [...list.querySelectorAll(".offline-queue-item")] : [];
    const inRow = (row) => row && saved.kind ? row.querySelector("." + saved.kind) : null;
    const sameRow = rows.find((row) => row.dataset.queueId === saved.queueId);
    const nearby = rows.length && saved.index >= 0 ? rows[Math.min(saved.index, rows.length - 1)] : null;
    const candidates = [
      saved.queueId && inRow(sameRow),
      inRow(nearby),
      $id("offline-queue-toggle"),
      $id("url-input"),
      $id("submit-btn"),
    ];
    const target = candidates.find((el) => el && canFocus(el));
    if (target) target.focus({ preventScroll: true });
  }

  async function refreshBar() {
    const { queue: q, pause, account: current } = await getQueueState();
    const bar = $id("offline-queue-bar");
    const text = $id("offline-queue-text");
    if (!bar || !text) return;
    const savedFocus = captureFocus(bar) || heldFocus;
    heldFocus = null;
    if (!q.length) {
      bar.classList.add("hidden");
      hideList();
      restoreFocus(savedFocus);
      return;
    }
    bar.classList.remove("hidden");
    const paused = pauseText(q, pause);
    const other = q.filter((item) => fromOtherConnection(item, current)).length;
    const attention = q.filter((item) => !fromOtherConnection(item, current) && pbpOfflineQueueNeedsAttention(item)).length;
    const parts = [];
    if (q.length > other + attention) parts.push(t("offlineQueued", String(q.length - other - attention)));
    if (attention) parts.push(t(attention === 1 ? "offlineQueueNeedsAttentionOne" : "offlineQueueNeedsAttention", String(attention)));
    if (other) parts.push(t("offlineQueueOtherConnection", String(other)));
    if (paused) parts.push(paused);
    text.textContent = parts.join(" · ");
    if (expanded) renderList(q, current);
    restoreFocus(savedFocus);
  }

  function hideList() {
    expanded = false;
    const list = $id("offline-queue-list");
    const toggle = $id("offline-queue-toggle");
    if (list) { list.classList.add("hidden"); clearChildren(list); }
    // chevron is a CSS triangle rotated via [aria-expanded] — no ▸/▾ glyph (Segoe UI Emoji stall)
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function renderList(queue, current) {
    const list = $id("offline-queue-list");
    const toggle = $id("offline-queue-toggle");
    if (!list) return;
    list.classList.remove("hidden");
    if (toggle) toggle.setAttribute("aria-expanded", "true");
    clearChildren(list);
    if (!queue.length) {
      const empty = document.createElement("div");
      empty.className = "offline-queue-empty";
      empty.textContent = t("offlineQueueEmpty");
      list.appendChild(empty);
      return;
    }
    queue.forEach((item) => {
      const row = document.createElement("div");
      row.className = "offline-queue-item";
      row.dataset.queueId = item.queueId || "";

      const body = document.createElement("div");
      body.className = "offline-queue-body";

      const title = document.createElement("div");
      title.className = "offline-queue-title";
      title.textContent = item.title || item.url || t("offlineQueueUntitled");
      title.title = item.url || "";

      const meta = document.createElement("div");
      meta.className = "offline-queue-meta";
      let host = "";
      try { host = new URL(item.url).hostname.replace(/^www\./, ""); } catch (_) {}
      meta.textContent = [sourceLabel(item, current), host, relTime(item.queuedAt)].filter(Boolean).join(" · ");

      body.appendChild(title);
      body.appendChild(meta);
      // A record replay stopped on: why, and what the user can do about it.
      // Two lines, not one sentence: the cause comes from the save path's
      // copy, and not every such message ends with its language's full stop.
      if (pbpOfflineQueueNeedsAttention(item)) {
        const reason = document.createElement("div");
        reason.className = "error-text";
        const cause = document.createElement("div");
        cause.textContent = attentionReason(item);
        const hint = document.createElement("div");
        hint.textContent = t("offlineQueueAttentionHint");
        reason.append(cause, hint);
        body.appendChild(reason);
      }

      const actions = document.createElement("div");
      actions.className = "actions";

      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "offline-queue-retry";
      retry.innerHTML = PBP_ICONS.refresh;
      retry.title = t("offlineRetry");
      retry.setAttribute("aria-label", t("offlineRetry"));
      retry.addEventListener("click", () => onRetry(item.queueId, retry, pbpBookmarkAccountService(item.account)));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "offline-queue-remove";
      remove.innerHTML = PBP_ICONS.cross;
      remove.title = t("offlineRemove");
      remove.setAttribute("aria-label", t("offlineRemove"));
      remove.addEventListener("click", () => {
        showConfirmPopover(remove, {
          msg: t("offlineRemoveConfirm"),
          yesText: t("delete"),
          noText: t("cancel"),
          onConfirm: () => onRemove(item.queueId),
        });
      });

      actions.appendChild(retry);
      actions.appendChild(remove);

      row.appendChild(body);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  // background.js answers { ok, result } where result is a pbpSaveFailure envelope
  // (sendOfflineItem / retryOfflineItem). Collapsing it to a boolean left the red
  // pulse as the only feedback, and two of those reasons are permanent dead ends:
  // replay is fail-closed, so an item queued under another connection (the row's
  // meta names it) can never succeed however often it is clicked.
  // Same reason -> message table the save path uses in popup.js.
  function retryFailureMessage(result, service) {
    const reason = result && typeof result === "object" ? result.reason : "";
    const partialKey = pbpBookmarkPartialKey(result);
    if (partialKey) return t(partialKey);
    const failureText = pbpBookmarkFailureText(result, service, t);
    if (failureText) return failureText;
    if (reason === "account_mismatch") return t("offlineRetryWrongAccount");
    if (reason === "not_logged_in") return t("batchNotLoggedIn");
    if (reason === "account_changed") return t("offlineRetryAccountChanged");
    // A queued record keeps no URI length (only its marker), so its copy
    // leaves the number out rather than print a guess.
    if (reason === "too_long") {
      return result.detail ? t("uriTooLong", String(result.detail), String(POSTS_ADD_URI_BUDGET)) : t("submitUriTooLong");
    }
    if (reason === "http" && pbpOfflineQueueAttentionFailure(result)) return t("pinboardErrRejected", String(result.httpStatus));
    if (reason === "http" && result.httpStatus) {
      // Same split as the save path in popup.js: a server fault or rate limit
      // gets its own copy, any other status is named inside the API error.
      const status = result.httpStatus;
      return status === 429 || status >= 500
        ? t(classifyPinboardError(status))
        : t("pinboardApiError", `HTTP ${status}`);
    }
    if (reason === "api" && result.detail) return t("pinboardApiError", String(result.detail));
    // Only reason "network" (and an answerless send -- a service worker that
    // never replied) may claim the network. The pipeline also produces invalid,
    // storage, internal and conflict, and each of those sends a reader who is
    // told "network error" to test a connection that works: a full
    // storage.local is emptied from Settings, not from the router.
    if (reason && reason !== "network") return t("offlineRetryFailed");
    return t("networkError");
  }

  // The cause a record was marked with, in the copy the save path uses. The
  // marker holds only its code (and HTTP status); the over-long tag and the
  // title limit are read back from the record and the service.
  function attentionReason(item) {
    const failure = item.failure;
    if (failure.code === "invalid" || failure.code === "invalid_request") return t("offlineQueueRecordInvalid");
    const service = pbpBookmarkAccountService(pbpOfflineQueueAccount(item));
    const result = { reason: failure.code, ...(Number.isInteger(failure.status) ? { httpStatus: failure.status } : {}) };
    if (failure.code === "tag_too_long") {
      try { result.tag = pbpLinkdingOverlongTag(pbpBookmarkParseTags(item.tags)); } catch (_) { /* unparsable tags: the copy shows "?" */ }
    }
    if (failure.code === "too_long" && service !== "pinboard") result.limit = pbpBookmarkLimits(service).title;
    return retryFailureMessage(result, service);
  }

  // One queued item, sent now. Resolves to background's { ok, result } or
  // null when the worker never answered. Shared by the row button and the
  // "queued" card under Save (popup.js).
  function retryItem(queueId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "retry_offline_item", queueId }, (r) => {
        if (chrome.runtime.lastError) {
          console.warn("offline retry message failed:", chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(r || null);
      });
    });
  }

  // While a retry is in flight, a click or focus outside the bar and its list
  // is the user moving on: the held focus must not be pulled back afterwards.
  // Calls onLeave once and returns the function that stops listening.
  function watchFocusLeave(onLeave) {
    const inQueue = (node) => {
      const bar = $id("offline-queue-bar");
      const list = $id("offline-queue-list");
      return !!node && ((bar && bar.contains(node)) || (list && list.contains(node)));
    };
    const handler = (ev) => { if (!inQueue(ev.target)) { stop(); onLeave(); } };
    const stop = () => {
      document.removeEventListener("pointerdown", handler, true);
      document.removeEventListener("focusin", handler, true);
    };
    document.addEventListener("pointerdown", handler, true);
    document.addEventListener("focusin", handler, true);
    return stop;
  }

  async function onRetry(queueId, btn, service) {
    let hadFocus = document.activeElement === btn;
    let stopWatch = null;
    if (hadFocus) {
      const held = captureFocus($id("offline-queue-bar") || btn);
      heldFocus = held;
      stopWatch = watchFocusLeave(() => {
        hadFocus = false;
        if (heldFocus === held) heldFocus = null;
      });
    }
    try { await sendRetry(queueId, btn, service, () => hadFocus); } finally { if (stopWatch) stopWatch(); }
  }

  async function sendRetry(queueId, btn, service, focusHeld) {
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      const resp = await retryItem(queueId);
      if (resp && resp.result && resp.result.reason === "gone") {
        // Delivered by the automatic replay (or removed) since the list was drawn.
        await refreshBar();
        return;
      }
      if (!resp || !resp.ok) {
        heldFocus = null;
        btn.disabled = false;
        if (focusHeld()) btn.focus({ preventScroll: true });
        btn.classList.remove("loading");
        btn.innerHTML = PBP_ICONS.refresh;
        btn.classList.add("offline-queue-failed");
        setTimeout(() => btn.classList.remove("offline-queue-failed"), 1200);
        // The pulse acknowledges the click in place; the reason goes to the
        // popup's error card, the same surface batch and save failures use.
        showStatus("status-msg", retryFailureMessage(resp && resp.result, service), "error", { remedy: true });
        return;
      }
      // Success — background has removed this item; refresh list
      await refreshBar();
    } catch (_) {
      heldFocus = null;
      btn.disabled = false;
      if (focusHeld()) btn.focus({ preventScroll: true });
      btn.classList.remove("loading");
      btn.innerHTML = PBP_ICONS.refresh;
    }
  }

  async function onRemove(queueId) {
    // Promise form rejects on transport failure (context invalidated / no receiver / port closed)
    // so this try/catch absorbs it; Chrome may still print a console-only unchecked-lastError line.
    // resp.ok === false separately covers a handler-internal failure (background.js's
    // mutateOfflineQueue().catch(() => sendResponse({ ok: false }))).
    let ok = false;
    try {
      const resp = await chrome.runtime.sendMessage({ type: "remove_offline_item", queueId });
      ok = !!(resp && resp.ok);
    } catch (e) {
      console.warn("offline remove message failed:", e && e.message);
    }
    await refreshBar();
    return ok;
  }

  async function toggle(ev) {
    if (ev) ev.preventDefault();
    expanded = !expanded;
    if (!expanded) { hideList(); return; }
    const { queue, account } = await getQueueState();
    renderList(queue, account);
  }

  function init() {
    const toggleEl = $id("offline-queue-toggle");
    if (toggleEl) toggleEl.addEventListener("click", toggle);
    // React to storage changes so the list updates after background auto-retries
    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && (changes.offlineQueue || changes.offlineQueuePause)) refreshBar();
      });
    }
  }

  // Expose for popup.js
  window.PPOffline = { init, refresh: refreshBar, retry: retryItem, retryFailureMessage };
})();
