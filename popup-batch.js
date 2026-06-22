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
      const baseTags = settings.optBatchTagEnabled && settings.optBatchTag
        ? settings.optBatchTag.split(/[,，]+/).map(s => s.trim().replace(/\s+/g, "-")).filter(Boolean)
        : [];
      const useAiTags = settings.batchAiTags && hasAIKey(settings);
      const useAiSummary = settings.batchAiSummary && hasAIKey(settings);

      // Request host permission for content extraction (needed for non-active tabs)
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

      let saved = 0, failed = 0, skipped = 0, tooLong = 0;
      let existingUrls = new Set();
      const savedUrls = [];
      let existingPerTabFallback = false;
      if (settings.batchSkipExisting) {
        const result = await fetchExistingUrlSet(pinboardToken);
        if (result === null) {
          existingPerTabFallback = true; // > 5000 bookmarks; query per-tab inside loop
        } else {
          existingUrls = result;
        }
      }
      let aiFailed = 0;
      const progress = $id("batch-progress");
      const fill = $id("batch-progress-fill");
      const ptext = $id("batch-progress-text");
      if (progress) progress.classList.remove("hidden");
      const updateProgress = (i) => {
        const total = validTabs.length;
        const pct = Math.round((i / total) * 100);
        if (fill) fill.style.width = pct + "%";
        // saved/failed/aiFailed are integer counters → safe to interpolate into innerHTML.
        // Inline check/cross SVGs replace literal ✓/✗ (which pull Segoe UI Emoji on Windows).
        if (ptext) ptext.innerHTML = `${i}/${total}  <span class="status-ic ok">${PBP_ICONS.check}</span>${saved}  <span class="status-ic bad">${PBP_ICONS.cross}</span>${failed}${aiFailed ? `  AI<span class="status-ic bad">${PBP_ICONS.cross}</span>${aiFailed}` : ""}`;
        if (progress) progress.setAttribute("aria-valuenow", String(pct));
      };
      updateProgress(0);
      for (let i = 0; i < validTabs.length; i++) {
        const tab = validTabs[i];
        setBtnIcon(batchBtn, "pin", t("batchProgress", String(i + 1), String(validTabs.length), String(saved), String(failed)));
        updateProgress(i);
        if (settings.batchSkipExisting) {
          let isExisting = existingUrls.has(tab.url);
          if (existingPerTabFallback) {
            // Per-tab posts/get via SW message (uses statusCache in SW; 5-min TTL)
            try {
              const r = await chrome.runtime.sendMessage({ type: "get_bookmark_data", url: tab.url });
              if (r?.posts?.length > 0) isExisting = true;
            } catch (_) {}
          }
          if (isExisting) {
            skipped++;
            continue;
          }
        }
        try {
          let tags = [...baseTags];
          let notes = "";

          if (useAiTags || useAiSummary) {
            let tabPageInfo = null;
            try { tabPageInfo = await getPageInfoFromTab(tab.id, { withDefuddle: true }); } catch (e) { console.warn("batch: cannot extract page content for", tab.url, e.message); }
            if (tabPageInfo?.pageText) {
              const aiJobs = [];
              if (useAiTags) aiJobs.push((async () => {
                try {
                  const cached = await getAICache(tab.url, "tags", settings.aiCacheDuration, settings.aiContentSource);
                  if (cached) return { type: "tags", result: cached };
                  const prompt = buildTagPrompt(settings, tab.title || tab.url, tab.url, tabPageInfo.pageText, "", []);
                  const resp = await callAI(settings, prompt);
                  const rawTags = parseAITags(resp, settings.aiTagSeparator);
                  const aiTags = settings.optRespectTagCase
                    ? rawTags.map(tag => resolveTagCase(tag, tagCaseMap))
                    : rawTags;
                  await setAICache(tab.url, "tags", aiTags, settings.aiCacheDuration, settings.aiContentSource);
                  return { type: "tags", result: aiTags };
                } catch (e) { console.warn("batch AI tags failed:", tab.url, e.message); aiFailed++; return null; }
              })());
              if (useAiSummary) aiJobs.push((async () => {
                try {
                  const cached = await getAICache(tab.url, "summary", settings.aiCacheDuration, settings.aiContentSource);
                  if (cached) return { type: "summary", result: cached };
                  const prompt = buildSummaryPrompt(settings, tab.title || tab.url, tab.url, tabPageInfo.pageText, "");
                  const summary = await callAI(settings, prompt);
                  await setAICache(tab.url, "summary", summary, settings.aiCacheDuration, settings.aiContentSource);
                  return { type: "summary", result: summary };
                } catch (e) { console.warn("batch AI summary failed:", tab.url, e.message); aiFailed++; return null; }
              })());
              const results = await Promise.all(aiJobs);
              for (const r of results) {
                if (!r) continue;
                if (r.type === "tags") tags = [...tags, ...r.result];
                if (r.type === "summary") notes = `[AI Summary]\n<blockquote>${r.result}</blockquote>`;
              }
            }
          }

          const dedupedTags = [...new Set(tags.map(tag => tag.toLowerCase()))].map(lower => tags.find(tag => tag.toLowerCase() === lower));
          const isPrivate = pbpEffectivePrivate(settings, { incognito: tab.incognito });
          const apiUrl = buildPostsAddUri({
            token: pinboardToken,
            url: tab.url,
            title: tab.title || tab.url,
            extended: notes,
            tags: dedupedTags.join(" "),
            shared: isPrivate ? "no" : "yes",
            toread: settings.optReadlaterDefault ? "yes" : undefined,
          });
          if (apiUrl.length > POSTS_ADD_URI_BUDGET) {
            console.warn(`[batch] skipping oversize URI (${apiUrl.length}/${POSTS_ADD_URI_BUDGET}):`, tab.url);
            tooLong++;
            continue;
          }
          const data = await (await pinboardFetch(apiUrl)).json();
          if (data.result_code === "done") {
            saved++;
            savedUrls.push(tab.url);
            if (settings.waybackArchiveEnabled && settings.waybackArchiveBatch) {
              chrome.runtime.sendMessage({ type: "archive_url", url: tab.url, private: isPrivate }).catch(() => {});
            }
          } else failed++;
        } catch (_) { failed++; }
      }
      if (saved > 0) {
        // Cache only URLs that actually returned result_code==="done" (savedUrls),
        // NOT every non-pre-existing tab — failed/tooLong/thrown tabs must stay
        // re-savable on the next run, not get masked by the 30-min dedup cache.
        existingUrls = computeSavedUrlSet(existingUrls, savedUrls);
        try {
          await chrome.storage.local.set({
            cached_existing_urls: { urls: [...existingUrls], timestamp: Date.now() }
          });
        } catch (_) {}
        if (baseTags.length && typeof saveLastUsedTags === "function") saveLastUsedTags(baseTags);
      }
      const tagStr = baseTags.join(", ");
      const skipMsg = skipped > 0 ? t("batchSkipped", String(skipped)) : "";
      const tooLongMsg = tooLong > 0 ? t("batchTooLong", String(tooLong)) : "";
      const aiWarnMsg = aiFailed > 0 ? ` (AI failed: ${aiFailed})` : "";
      showStatus("status-msg", t("batchDone", String(saved), String(failed)) + skipMsg + tooLongMsg + aiWarnMsg, saved > 0 ? "success" : "error");
      if (saved > 0) {
        const tagsSuffix = tagStr ? t("batchTaggedSuffix", tagStr) : "";
        chrome.runtime.sendMessage({ type: "show_notification", id: "batch-saved-" + Date.now(), title: t("bgBatchSaved"), message: t("batchSavedNotify", String(saved), tagsSuffix), category: "batchSave" });
      }
      setBtnIcon(batchBtn, "pin", t("batchSavedCount", String(saved)));
      // Snap progress bar to 100% then fade out after 1.5s
      updateProgress(validTabs.length);
      setTimeout(() => {
        if (progress) progress.classList.add("hidden");
        setBtnIcon(batchBtn, "pin", t("batchSaveBtn")); batchBtn.disabled = false;
      }, 1500);
    } catch (e) {
      showStatus("status-msg", t("batchFailed", e.message), "error");
      const progress = $id("batch-progress");
      if (progress) progress.classList.add("hidden");
      setBtnIcon(batchBtn, "pin", t("batchSaveBtn")); batchBtn.disabled = false;
    }
  });
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

// ---- Existing URL Set Cache (for batch dedup) ----
async function fetchExistingUrlSet(token) {
  const cacheKey = "cached_existing_urls";
  try {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]) {
      const { urls, timestamp } = cached[cacheKey];
      if (Date.now() - timestamp < 30 * 60 * 1000) {
        return new Set(urls);
      }
    }
  } catch (_) {}
  try {
    const recentData = await (await pinboardFetch(`https://api.pinboard.in/v1/posts/all?auth_token=${token}&format=json&results=1000&meta=no`)).json();
    if (Array.isArray(recentData) && recentData.length >= 1000) {
      // D2 Phase 4: likely > 5000 bookmarks; skip-existing falls back to per-tab
      // posts/get inside the batch loop to avoid false-not-existing for older bookmarks.
      console.log("[batch] account likely > 5000 bookmarks, skip-existing falls back to per-tab posts/get");
      return null;
    }
    const urls = recentData.map(p => p.href);
    await chrome.storage.local.set({ [cacheKey]: { urls, timestamp: Date.now() } });
    return new Set(urls);
  } catch (_) {
    // Fetch / .json() failed transiently. Do NOT return an empty Set — that is
    // indistinguishable from a zero-bookmark account and would re-save every tab
    // with replace=yes, clobbering existing bookmarks. Signal per-tab fallback.
    return batchExistingResultOnError();
  }
}
