// ============================================================
// popup-offline.js — Offline queue visibility / per-item actions
// Relies on globals: t() from i18n.js
// ============================================================

(function () {
  let expanded = false;

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

  async function refreshBar() {
    const { queue: q, pause, account: current } = await getQueueState();
    const bar = $id("offline-queue-bar");
    const text = $id("offline-queue-text");
    if (!bar || !text) return;
    if (!q.length) {
      bar.classList.add("hidden");
      hideList();
      return;
    }
    bar.classList.remove("hidden");
    const paused = pauseText(q, pause);
    const other = q.filter((item) => fromOtherConnection(item, current)).length;
    const parts = [];
    if (q.length > other) parts.push(t("offlineQueued", String(q.length - other)));
    if (other) parts.push(t("offlineQueueOtherConnection", String(other)));
    if (paused) parts.push(paused);
    text.textContent = parts.join(" · ");
    if (expanded) renderList(q, current);
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
    const failureText = pbpBookmarkFailureText(result, service, t);
    if (failureText) return failureText;
    if (reason === "account_mismatch") return t("offlineRetryWrongAccount");
    if (reason === "not_logged_in") return t("batchNotLoggedIn");
    if (reason === "account_changed") return t("offlineRetryAccountChanged");
    if (reason === "too_long") return t("uriTooLong", String(result.detail || ""), String(POSTS_ADD_URI_BUDGET));
    if (reason === "http" && result.httpStatus) return `HTTP ${result.httpStatus}`;
    if (reason === "api" && result.detail) return t("pinboardApiError", String(result.detail));
    // Only reason "network" (and an answerless send -- a service worker that
    // never replied) may claim the network. The pipeline also produces invalid,
    // storage, internal and conflict, and each of those sends a reader who is
    // told "network error" to test a connection that works: a full
    // storage.local is emptied from Settings, not from the router.
    if (reason && reason !== "network") return t("offlineRetryFailed");
    return t("networkError");
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

  async function onRetry(queueId, btn, service) {
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      const resp = await retryItem(queueId);
      if (!resp || !resp.ok) {
        btn.disabled = false;
        btn.classList.remove("loading");
        btn.innerHTML = PBP_ICONS.refresh;
        btn.classList.add("offline-queue-failed");
        setTimeout(() => btn.classList.remove("offline-queue-failed"), 1200);
        // The pulse acknowledges the click in place; the reason goes to the
        // popup's error card, the same surface batch and save failures use.
        showStatus("status-msg", retryFailureMessage(resp && resp.result, service), "error");
        return;
      }
      // Success — background has removed this item; refresh list
      await refreshBar();
    } catch (_) {
      btn.disabled = false;
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
