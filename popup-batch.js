// ============================================================
// Pinboard Bookmark Enhanced - Tab Set, Batch Save & Tag Presets
// ============================================================

// ---- Tab Set & Batch Bookmark Save ----
function setupTabSet() {
  const btn = $id("save-tabset-btn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const origLabel = t("saveTabsBtn");
    setBtnIcon(btn, "tabs", t("batchSaving"));

    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const validTabs = tabs.filter(tab =>
        tab.url && (tab.url.startsWith("http://") || tab.url.startsWith("https://"))
      );

      if (validTabs.length === 0) {
        showStatus("status-msg", t("batchNoValidTabs"), "error");
        setBtnIcon(btn, "tabs", origLabel);
        btn.disabled = false;
        return;
      }

      const tabsData = validTabs.map(tab => ({
        title: tab.title || tab.url,
        url: tab.url
      }));

      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: "saveTabSet", tabsData: tabsData },
          (response) => {
            if (chrome.runtime.lastError) {
              console.error("sendMessage error:", chrome.runtime.lastError);
            }
            resolve(response);
          }
        );
      });

      setBtnIcon(btn, "tabs", t("batchSent"));
      setTimeout(() => {
        setBtnIcon(btn, "tabs", origLabel);
        btn.disabled = false;
      }, 2000);

    } catch (e) {
      console.error("Save tab set error:", e);
      showStatus("status-msg", t("batchFailed", e.message), "error");
      setBtnIcon(btn, "tabs", origLabel);
      btn.disabled = false;
    }
  });

  const batchBtn = $id("batch-bookmark-btn");
  if (!batchBtn) return;
  batchBtn.addEventListener("click", async () => {
    // Re-entry guard: a batch may already be running in the background (popup closed/reopened).
    try {
      const { batch_progress: bp } = await chrome.storage.local.get("batch_progress");
      if (batchIsRunning(bp, Date.now(), BATCH_STALE_TTL)) {
        showStatus("status-msg", t("batchRunningBg"), "success");
        renderBatchProgress(bp);
        return;
      }
    } catch (_) {}

    batchBtn.disabled = true;
    setBtnIcon(batchBtn, "pin", t("batchSaving"));
    try {
      const rawToken = await (await getSettingsStorage()).get("pinboardToken");
      const pinboardToken = deobfuscateKey(rawToken.pinboardToken);
      if (!pinboardToken) {
        showStatus("status-msg", t("batchNotLoggedIn"), "error");
        setBtnIcon(batchBtn, "pin", t("batchSaveBtn")); batchBtn.disabled = false;
        return;
      }
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const validTabs = tabs.filter(tab => tab.url && (tab.url.startsWith("http://") || tab.url.startsWith("https://")));
      if (!validTabs.length) {
        showStatus("status-msg", t("batchNoTabs"), "error");
        setBtnIcon(batchBtn, "pin", t("batchSaveBtn")); batchBtn.disabled = false;
        return;
      }

      const useAiTags = settings.batchAiTags && hasAIKey(settings);
      const useAiSummary = settings.batchAiSummary && hasAIKey(settings);
      // Host permission for non-active-tab extraction MUST be requested here (user gesture);
      // once granted it persists and the SW can use it for background-tab scripting.
      if (useAiTags || useAiSummary) {
        const hasPermission = await chrome.permissions.contains({ origins: ["*://*/*"] });
        if (!hasPermission) {
          const granted = await chrome.permissions.request({ origins: ["*://*/*"] });
          if (!granted) {
            showStatus("status-msg", t("batchPermDenied"), "error");
            setBtnIcon(batchBtn, "pin", t("batchSaveBtn")); batchBtn.disabled = false;
            return;
          }
        }
      }

      // Snapshot tabs and hand off to the SW; the loop now runs in the background.
      const snapshot = validTabs.map(tab => ({ id: tab.id, title: tab.title || tab.url, url: tab.url, incognito: !!tab.incognito }));
      const progress = $id("batch-progress");
      if (progress) progress.classList.remove("hidden");
      setBtnIcon(batchBtn, "pin", t("batchProgress", "0", String(snapshot.length), "0", "0"));
      const resp = await chrome.runtime.sendMessage({ action: "startBatchSave", tabs: snapshot }).catch(() => null);
      if (resp && resp.status === "busy") {
        showStatus("status-msg", t("batchRunningBg"), "success");
      }
      // From here, renderBatchProgress (wired via storage.onChanged) drives the UI.
    } catch (e) {
      showStatus("status-msg", t("batchFailed", e.message), "error");
      const progress = $id("batch-progress");
      if (progress) progress.classList.add("hidden");
      setBtnIcon(batchBtn, "pin", t("batchSaveBtn")); batchBtn.disabled = false;
    }
  });

  wireBatchProgress();
}

// ---- Background batch progress (driven by storage.local.batch_progress) ----
function renderBatchProgress(p) {
  if (!p) return;
  const batchBtn = $id("batch-bookmark-btn");
  const progress = $id("batch-progress");
  const fill = $id("batch-progress-fill");
  const ptext = $id("batch-progress-text");
  const total = p.total || 0;
  const cur = p.done ? total : (p.i || 0);
  const pct = total ? Math.round((cur / total) * 100) : 0;
  if (progress) { progress.classList.remove("hidden"); progress.setAttribute("aria-valuenow", String(pct)); }
  if (fill) fill.style.width = pct + "%";
  // saved/failed/aiFailed are integers -> safe to interpolate; SVG icons avoid emoji font fallback.
  if (ptext) ptext.innerHTML = `${cur}/${total}  <span class="status-ic ok">${PBP_ICONS.check}</span>${p.saved || 0}  <span class="status-ic bad">${PBP_ICONS.cross}</span>${p.failed || 0}${p.aiFailed ? `  AI<span class="status-ic bad">${PBP_ICONS.cross}</span>${p.aiFailed}` : ""}`;
  if (!batchBtn) return;
  if (p.done) {
    const skipMsg = p.skipped > 0 ? t("batchSkipped", String(p.skipped)) : "";
    const tooLongMsg = p.tooLong > 0 ? t("batchTooLong", String(p.tooLong)) : "";
    const aiWarnMsg = p.aiFailed > 0 ? ` (AI failed: ${p.aiFailed})` : "";
    if (p.error === "not_logged_in") showStatus("status-msg", t("batchNotLoggedIn"), "error");
    else if (p.error) showStatus("status-msg", t("batchFailed", p.error), "error");
    else showStatus("status-msg", t("batchDone", String(p.saved || 0), String(p.failed || 0)) + skipMsg + tooLongMsg + aiWarnMsg, (p.saved || 0) > 0 ? "success" : "error");
    setBtnIcon(batchBtn, "pin", t("batchSavedCount", String(p.saved || 0)));
    setTimeout(() => {
      if (progress) progress.classList.add("hidden");
      setBtnIcon(batchBtn, "pin", t("batchSaveBtn"));
      batchBtn.disabled = false;
    }, 1500);
  } else {
    batchBtn.disabled = true;
    setBtnIcon(batchBtn, "pin", t("batchProgress", String(cur), String(total), String(p.saved || 0), String(p.failed || 0)));
  }
}

function wireBatchProgress() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.batch_progress) renderBatchProgress(changes.batch_progress.newValue);
  });
  // Reopen restore: if a batch is mid-flight, show it immediately.
  chrome.storage.local.get("batch_progress").then(({ batch_progress: bp }) => {
    if (batchIsRunning(bp, Date.now(), BATCH_STALE_TTL)) renderBatchProgress(bp);
  }).catch(() => {});
}

// ---- Tag Presets ----
function setupTagPresets() {
  const raw = settings.tagPresets || "";
  if (!raw.trim()) return;
  const container = $id("tag-presets");
  const presetsRow = $id("presets-row");
  if (!container || !presetsRow) return;
  const presets = raw.split("\n").map(line => {
    const m = line.match(/^(.+?)[:：]\s*(.+)$/);
    if (!m) return null;
    return { name: m[1].trim(), tags: m[2].split(/[,，]+/).map(s => s.trim()).filter(Boolean) };
  }).filter(Boolean);
  if (!presets.length) return;
  presetsRow.classList.remove("hidden");
  presets.forEach(p => {
    const btn = document.createElement("span");
    btn.className = "preset-btn";
    btn.textContent = p.name;
    btn.title = p.tags.join(", ");
    btn.addEventListener("click", () => {
      p.tags.forEach(tag => addTag(tag));
      btn.classList.add("used");
    });
    container.appendChild(btn);
  });
}
