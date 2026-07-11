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

  async function getQueue() {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "get_offline_queue" }, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp);
      });
    });
    if (response?.ok && Array.isArray(response.queue)) return response.queue;
    const { offlineQueue = [] } = await chrome.storage.local.get("offlineQueue");
    return offlineQueue;
  }
  // NOTE: no setQueue() here — the offline queue is mutated ONLY by the SW
  // (background.js mutateOfflineQueue, single-writer mutex, D1). The popup reads
  // via getQueue() and sends messages for retry/remove; it never writes directly.

  async function refreshBar() {
    const q = await getQueue();
    const bar = $id("offline-queue-bar");
    const text = $id("offline-queue-text");
    if (!bar || !text) return;
    if (!q.length) {
      bar.classList.add("hidden");
      hideList();
      return;
    }
    bar.classList.remove("hidden");
    text.textContent = t("offlineQueued", String(q.length));
    if (expanded) renderList(q);
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

  function renderList(queue) {
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
      title.textContent = item.title || item.url || "(untitled)";
      title.title = item.url || "";

      const meta = document.createElement("div");
      meta.className = "offline-queue-meta";
      let host = "";
      try { host = new URL(item.url).hostname.replace(/^www\./, ""); } catch (_) {}
      const account = pbpOfflineQueueAccount(item);
      meta.textContent = [account ? `@${account}` : "", host, relTime(item.queuedAt)].filter(Boolean).join(" · ");

      body.appendChild(title);
      body.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "offline-queue-actions";

      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "offline-queue-retry";
      retry.innerHTML = PBP_ICONS.refresh;
      retry.title = t("offlineRetry");
      retry.setAttribute("aria-label", t("offlineRetry"));
      retry.addEventListener("click", () => onRetry(item.queueId, retry));

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

  async function onRetry(queueId, btn) {
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      const ok = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "retry_offline_item", queueId }, (resp) => {
          resolve(!!(resp && resp.ok));
        });
      });
      if (!ok) {
        btn.disabled = false;
        btn.classList.remove("loading");
        btn.innerHTML = PBP_ICONS.refresh;
        btn.classList.add("offline-queue-failed");
        setTimeout(() => btn.classList.remove("offline-queue-failed"), 1200);
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
    const ok = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "remove_offline_item", queueId }, (resp) => {
        resolve(!!(resp && resp.ok));
      });
    });
    await refreshBar();
    return ok;
  }

  async function toggle(ev) {
    if (ev) ev.preventDefault();
    expanded = !expanded;
    if (!expanded) { hideList(); return; }
    const q = await getQueue();
    renderList(q);
  }

  function init() {
    const toggleEl = $id("offline-queue-toggle");
    if (toggleEl) toggleEl.addEventListener("click", toggle);
    // React to storage changes so the list updates after background auto-retries
    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.offlineQueue) refreshBar();
      });
    }
  }

  // Expose for popup.js
  window.PPOffline = { init, refresh: refreshBar };
})();
