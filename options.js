document.addEventListener("DOMContentLoaded", async () => {
  initI18n();
  applyI18n();

  // W3: Lazy-init scaffolding for the appearance panel.
  // Hoisted to the top of DOMContentLoaded so the tab-switch handler and the
  // saved-tab restore (both below) can safely reference _initAppearancePanel.
  // The actual render depends on currentPresetKey + PINBOARD_THEMES, which
  // aren't initialized until the settings load completes much further down.
  // Until that bootstrap finishes, we record a pending request and flush it
  // when _appearancePanelBootReady flips to true.
  let _appearanceInited = false;
  let _appearancePanelBootReady = false;
  let _appearancePendingInit = false;
  let _pinboardThemesPromise = null;
  function _loadPinboardThemes() {
    if (_pinboardThemesPromise) return _pinboardThemesPromise;
    _pinboardThemesPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "pinboard-themes.js";
      s.onload = () => resolve();
      s.onerror = () => {
        _pinboardThemesPromise = null; // allow retry on transient failure
        reject(new Error("Failed to load pinboard-themes.js"));
      };
      document.head.appendChild(s);
    });
    return _pinboardThemesPromise;
  }
  async function _initAppearancePanel() {
    if (_appearanceInited) return;
    if (!_appearancePanelBootReady) { _appearancePendingInit = true; return; }
    _appearanceInited = true;
    try {
      await _loadPinboardThemes();
    } catch (e) {
      console.warn("[options] pinboard-themes lazy load failed:", e.message);
      _appearanceInited = false; // allow retry on next switch
      return;
    }
    renderPresetPreview();
  }

  // ---- Tags panel lazy-init ----
  let _tagGovInited = false;
  function updateTagGovOverview(counts) {
    const overview = $id("tag-gov-overview");
    if (!counts || !overview) return;
    const tagCount = Object.keys(counts).length;
    const totalUses = Object.values(counts).reduce((a, b) => a + b, 0);
    overview.replaceChildren();
    const span = document.createElement("span");
    span.textContent = t("tagGovOverview", String(tagCount), String(totalUses));
    overview.appendChild(span);
  }
  async function _initTagGovPanel() {
    if (_tagGovInited) return;
    _tagGovInited = true;
    const counts = await loadTagCounts();
    const overview = $id("tag-gov-overview");
    if (counts && overview) {
      updateTagGovOverview(counts);
      const refreshBtn = document.createElement("button");
      refreshBtn.className = "btn btn-sm";
      refreshBtn.id = "tag-gov-refresh";
      refreshBtn.textContent = t("tagGovRefresh");
      refreshBtn.addEventListener("click", async () => {
        refreshBtn.disabled = true;
        await chrome.storage.local.remove("_tagGovAiGroups");
        const fresh = await loadTagCounts(true);
        if (fresh) {
          updateTagGovOverview(fresh);
          const btn = $id("tag-gov-refresh");
          if (btn && btn.parentNode) btn.parentNode.appendChild(btn);
        }
        await renderTagGov();
        await renderLowCountTags();
        refreshBtn.disabled = false;
      });
      overview.appendChild(refreshBtn);
    }
    await renderTagGov();
    await renderLowCountTags();
  }

  // ---- Tab switching ----
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $id(`panel-${btn.dataset.panel}`).classList.add("active");
      // W3: lazy-init expensive per-panel rendering on first view.
      if (btn.dataset.panel === "appearance") _initAppearancePanel();
      if (btn.dataset.panel === "tags") _initTagGovPanel();
    });
  });

  // Restore active tab after language switch
  const savedTab = sessionStorage.getItem("activeTab");
  if (savedTab) {
    sessionStorage.removeItem("activeTab");
    const btn = document.querySelector(`.tab-btn[data-panel="${savedTab}"]`);
    if (btn) btn.click();
  }

  // ---- Reset current tab to defaults ----
  const PANEL_DEFAULTS = {
    general: {
      fields: {
        "opt-lang": "auto",
        "notify-quick-save": true, "notify-read-later": true, "notify-tab-set": true,
        "notify-batch-save": true, "notify-errors": true
      },
      skip: ["opt-pinboard-token", "opt-sync-enabled"] // never reset token or sync toggle
    },
    popup: {
      fields: {
        "opt-check-bookmark-status": true, "opt-auto-close": true, "offline-queue-enabled": true,
        "opt-show-search": false, "opt-show-recent": false, "opt-show-badge": false,
        "opt-show-suggest-tags": true,
        "opt-show-ai-summary": true, "opt-show-ai-tags": true,
        "opt-show-quick-links": true, "opt-show-quick-row": true
      }
    },
    bookmarks: {
      fields: {
        "opt-private-default": false, "opt-private-incognito": true, "opt-readlater-default": false,
        "opt-auto-description": true, "opt-blockquote": true, "opt-include-referrer": false,
        "opt-respect-tag-case": true, "opt-tag-presets": "",
        "opt-bgsave-merge": true, "opt-bgsave-skip": false, "opt-bgsave-overwrite": false
      }
    },
    ai: {
      fields: {
        "opt-ai-provider": "gemini", "opt-ai-summary-lang": "auto", "opt-ai-cache-duration": "60",
        "opt-ai-auto-tags": false, "opt-ai-tag-separator": "-",
        "opt-custom-tag-prompt": "", "opt-custom-summary-prompt": "",
        "opt-gemini-model": "gemini-2.5-flash-lite", "opt-openai-model": "gpt-5.4-nano",
        "opt-openai-baseurl": "https://api.openai.com/v1", "opt-claude-model": "claude-haiku-4-5-20251001",
        "opt-deepseek-model": "deepseek-v4-flash", "opt-qwen-model": "qwen-flash",
        "opt-minimax-model": "MiniMax-M2", "opt-openrouter-model": "meta-llama/llama-4-scout:free",
        "opt-groq-model": "meta-llama/llama-4-scout-17b-16e-instruct", "opt-mistral-model": "mistral-small-latest",
        "opt-cohere-model": "command-r-08-2024", "opt-siliconflow-model": "Qwen/Qwen3-8B",
        "opt-zhipu-model": "glm-4.7-flash", "opt-kimi-model": "kimi-k2.6",
        "opt-ollama-baseurl": "http://localhost:11434", "opt-ollama-model": "llama3.2",
        "opt-custom-name": "Custom", "opt-custom-baseurl": "", "opt-custom-model": ""
      },
      skip: ["opt-gemini-key","opt-openai-key","opt-claude-key","opt-deepseek-key","opt-qwen-key","opt-minimax-key","opt-openrouter-key","opt-groq-key","opt-mistral-key","opt-cohere-key","opt-siliconflow-key","opt-zhipu-key","opt-kimi-key","opt-custom-key"]
    },
    quick: {
      fields: {
        "qs-auto-notes": true, "qs-blockquote": true, "qs-default-tags": "", "qs-ai-tags": false, "qs-ai-summary": false,
        "rl-auto-notes": true, "rl-blockquote": true, "rl-default-tags": "", "rl-ai-tags": false, "rl-ai-summary": false,
        "opt-batch-tag-enabled": true, "opt-batch-tag": "batch_saved",
        "batch-ai-tags": false, "batch-ai-summary": false, "batch-skip-existing": false
      }
    },
    markdown: {
      fields: {
        "opt-obsidian-enabled": false,
        "opt-md-frontmatter": true, "opt-md-image-policy": "keep", "opt-md-include-toc": false,
        "opt-obsidian-vault": "", "opt-obsidian-folder": ""
      }
    },
    archive: {
      fields: {
        "opt-wayback-enabled": false, "opt-wayback-batch": false,
        "opt-wayback-s3key": "", "opt-wayback-s3secret": ""
      },
      skip: ["opt-wayback-s3key", "opt-wayback-s3secret"]
    },
    appearance: {
      fields: {
        "opt-theme": "auto", "opt-popup-follow-theme": true, "opt-custom-font": ""
      }
    },
    tags: {
      fields: {},
      skip: []
    }
  };

  // Gray out the Obsidian vault/folder inputs when the master toggle is off.
  // Safe to call on any page/panel (guards on element existence); programmatic
  // .checked changes (load, reset) don't fire 'change', so call it explicitly.
  function syncObsidianEnabledState() {
    const en = $id("opt-obsidian-enabled");
    if (!en) return;
    const off = !en.checked;
    const v = $id("opt-obsidian-vault");
    const f = $id("opt-obsidian-folder");
    if (v) v.disabled = off;
    if (f) f.disabled = off;
  }

  $id("reset-panel-btn").addEventListener("click", function () {
    const resetBtn = this;
    const activeBtn = document.querySelector(".tab-btn.active");
    if (!activeBtn) return;
    const panel = activeBtn.dataset.panel;
    const def = PANEL_DEFAULTS[panel];
    if (!def) return;
    showConfirmPopover(resetBtn, {
      msg: t("resetConfirm", activeBtn.textContent) + (def.skip ? t("resetKeysKept") : ""),
      yesText: t("reset"),
      noText: t("cancel"),
      onConfirm: () => {
        for (const [id, val] of Object.entries(def.fields)) {
          const el = $id(id);
          if (!el) continue;
          if (el.type === "checkbox") el.checked = val;
          else el.value = val;
        }
        saveAll();
        syncObsidianEnabledState();
      },
    });
  });

  // ---- Accordion sections ----
  document.querySelectorAll(".accordion-header").forEach((header) => {
    header.addEventListener("click", () => {
      header.closest(".accordion-section").classList.toggle("open");
    });
  });

  // ---- API key show/hide toggle ----
  // SVG (not emoji) — emoji here triggered a 1-3s Segoe UI Emoji font-load stall
  // when the AI panel first rendered on Windows high-DPI. Set initial icon from JS
  // so the static HTML eye glyph never reaches layout.
  document.querySelectorAll(".key-toggle").forEach(btn => {
    btn.innerHTML = PBP_ICONS.eye;
    btn.addEventListener("click", () => {
      const input = $id(btn.dataset.target);
      if (input) {
        const isPassword = input.type === "password";
        input.type = isPassword ? "text" : "password";
        btn.innerHTML = isPassword ? PBP_ICONS.eyeOff : PBP_ICONS.eye;
      }
    });
  });

  // ---- All settings with defaults (from shared.js) ----
  const s = await (await getSettingsStorage()).get(SETTINGS_DEFAULTS);
  deobfuscateSettings(s);

  // ---- Schema v2 migration: split customCSS into themePresetKey + customOverlayCSS ----
  // Runs once per profile (guarded by _migrationV2), then stays dormant. Silently converts
  // un-migrated profiles so their old custom CSS keeps rendering; the one-time "upgraded"
  // banner + 7-day undo it used to show were removed once all undo windows had expired.
  const OVERLAY_BYTE_LIMIT = 50 * 1024;

  // The v2 theme-storage migration's one-time "upgraded" banner + 7-day undo were
  // removed (every undo window had long expired). Reclaim their now-dead local keys.
  chrome.storage.local.remove(["_migrationBackup", "_migrationBannerDismissed"]).catch(() => {});

  migrationV2: {
    const flags = await chrome.storage.sync.get({ _migrationV2: false });
    const oldCSSFromSync = await syncGetLarge("customCSS", "");
    let oldCSS = oldCSSFromSync;
    if (!oldCSS) {
      const localOldCSS = await chrome.storage.local.get({ customCSS: "" });
      if (localOldCSS.customCSS) oldCSS = localOldCSS.customCSS;
    }
    const oldKeyForMigration = s.themePresetKey || "";
    const hasOldData = !!oldCSS || !!oldKeyForMigration;
    if (!flags._migrationV2 && hasOldData) {
      try {
        // A2 Phase 3: migration uses PINBOARD_THEMES so we must load it now.
        // This is a one-time cost for un-migrated users; future opens skip this entire block.
        await _loadPinboardThemes();
      } catch (e) {
        console.error("[migrationV2] failed to load pinboard-themes.js", e);
        // Don't set _migrationV2 flag — will retry on next load
        break migrationV2;
      }
      // Resolve preset key: trust stored key, fall back to CSS-text reverse lookup
      let resolvedKey = oldKeyForMigration;
      if (!resolvedKey && oldCSS) {
        for (const [key, theme] of Object.entries(PINBOARD_THEMES)) {
          if (theme.css.trim() === oldCSS.trim()) { resolvedKey = key; break; }
        }
        // Adaptive parent fallback: catppuccin-latte → catppuccin
        if (resolvedKey) {
          for (const [parent, [light, dark]] of Object.entries(ADAPTIVE_THEME_MAP)) {
            if (resolvedKey === light || resolvedKey === dark) { resolvedKey = parent; break; }
          }
        }
      }
      // Decide overlay value (X1: equal to preset → empty; X2/X3: keep full)
      let newOverlay = "";
      if (oldCSS) {
        const preset = resolvedKey ? PINBOARD_THEMES[resolvedKey] : null;
        const presetCSS = preset ? preset.css : "";
        // Adaptive: also compare against light/dark variants
        const adaptiveVariants = ADAPTIVE_THEME_MAP[resolvedKey] || [];
        const allowed = [presetCSS, ...adaptiveVariants.map(k => PINBOARD_THEMES[k]?.css || "")];
        const matchesPreset = allowed.some(css => css && css.trim() === oldCSS.trim());
        newOverlay = matchesPreset ? "" : oldCSS;
      }
      try {
        // Cap overlay at 50KB; oversize → throw to skip migration (rare)
        if (newOverlay.length > OVERLAY_BYTE_LIMIT) {
          await chrome.storage.local.set({ customOverlayCSS_localFallback: newOverlay });
          await chrome.storage.sync.set({ optOverlayInLocal: true });
        } else {
          await syncSetLarge("customOverlayCSS", newOverlay);
          await chrome.storage.sync.set({ optOverlayInLocal: false });
        }
        // Persist resolved preset key in sync
        await chrome.storage.sync.set({ themePresetKey: resolvedKey || "" });
        // Cleanup old customCSS (sync chunks + local backup)
        const meta = await chrome.storage.sync.get("customCSS");
        if (meta.customCSS && meta.customCSS._chunks) {
          const oldChunks = Array.from({ length: meta.customCSS._chunks }, (_, i) => `customCSS_${i}`);
          await chrome.storage.sync.remove(["customCSS", ...oldChunks]);
        }
        await chrome.storage.local.remove("customCSS");
        await chrome.storage.sync.set({ _migrationV2: true });
        // Update s.* with new schema for the rest of the page init
        s.themePresetKey = resolvedKey || "";
        s.customOverlayCSS = newOverlay;
      } catch (e) {
        console.error("[migrationV2] failed", e);
        // Don't set _migrationV2 flag — will retry on next load
      }
    }
    // Always read overlay (post-migration or fresh install)
    if (s.customOverlayCSS === undefined) {
      const overlayFlags = await chrome.storage.sync.get({ optOverlayInLocal: false });
      if (overlayFlags.optOverlayInLocal) {
        const local = await chrome.storage.local.get({ customOverlayCSS_localFallback: "" });
        s.customOverlayCSS = local.customOverlayCSS_localFallback;
      } else {
        s.customOverlayCSS = await syncGetLarge("customOverlayCSS", "");
      }
    }
  }

  // ---- Fill text/password/select fields ----
  const fieldMap = {
    "opt-pinboard-token": s.pinboardToken,
    "opt-ai-provider": s.aiProvider,
    "opt-gemini-key": s.geminiApiKey, "opt-gemini-model": s.geminiModel,
    "opt-openai-key": s.openaiApiKey, "opt-openai-model": s.openaiModel, "opt-openai-baseurl": s.openaiBaseUrl,
    "opt-claude-key": s.claudeApiKey, "opt-claude-model": s.claudeModel,
    "opt-deepseek-key": s.deepseekApiKey, "opt-deepseek-model": s.deepseekModel,
    "opt-qwen-key": s.qwenApiKey, "opt-qwen-model": s.qwenModel,
    "opt-minimax-key": s.minimaxApiKey, "opt-minimax-model": s.minimaxModel,
    "opt-openrouter-key": s.openrouterApiKey, "opt-openrouter-model": s.openrouterModel,
    "opt-groq-key": s.groqApiKey, "opt-groq-model": s.groqModel,
    "opt-mistral-key": s.mistralApiKey, "opt-mistral-model": s.mistralModel,
    "opt-cohere-key": s.cohereApiKey, "opt-cohere-model": s.cohereModel,
    "opt-siliconflow-key": s.siliconflowApiKey, "opt-siliconflow-model": s.siliconflowModel,
    "opt-zhipu-key": s.zhipuApiKey, "opt-zhipu-model": s.zhipuModel,
    "opt-kimi-key": s.kimiApiKey, "opt-kimi-model": s.kimiModel,
    "opt-ollama-baseurl": s.ollamaBaseUrl, "opt-ollama-model": s.ollamaModel,
    "opt-custom-name": s.customName, "opt-custom-baseurl": s.customBaseUrl,
    "opt-custom-key": s.customApiKey, "opt-custom-model": s.customModel,
    "opt-ai-tag-lang": s.aiTagLang, "opt-ai-summary-lang": s.aiSummaryLang, "opt-ai-cache-duration": s.aiCacheDuration,
    "opt-custom-tag-prompt": s.customTagPrompt, "opt-custom-summary-prompt": s.customSummaryPrompt,
    "opt-batch-tag": s.optBatchTag, "opt-lang": s.optLang, "opt-theme": s.optTheme,
    "qs-default-tags": s.qsDefaultTags, "rl-default-tags": s.rlDefaultTags,
    "opt-custom-font": s.customFont, "opt-custom-css": s.customOverlayCSS,
    "opt-ai-tag-separator": s.aiTagSeparator,
    "opt-jina-key": s.jinaApiKey,
    "opt-tag-presets": s.tagPresets,
    "opt-wayback-s3key": s.waybackS3Key,
    "opt-wayback-s3secret": s.waybackS3Secret
  };
  for (const [id, val] of Object.entries(fieldMap)) {
    const el = $id(id);
    if (el) el.value = val;
  }

  // Show default prompts as placeholder so users see them when field is empty
  $id("opt-custom-tag-prompt").placeholder = DEFAULT_TAG_PROMPT;
  $id("opt-custom-summary-prompt").placeholder = DEFAULT_SUMMARY_PROMPT;

  // AI Content Source radio
  const srcRadio = document.querySelector(`input[name="ai-content-source"][value="${s.aiContentSource || 'local'}"]`);
  if (srcRadio) srcRadio.checked = true;

  // Tag Sync Mode radio
  const tsRadio = document.querySelector(`input[name="tag-sync-mode"][value="${s.tagSyncMode || 'cached'}"]`);
  if (tsRadio) tsRadio.checked = true;

  // Background Save Mode radio
  const bsRadio = document.querySelector(`input[name="bgsave-mode"][value="${s.bgSaveMode || 'merge'}"]`);
  if (bsRadio) bsRadio.checked = true;

  // Markdown export image policy select
  const mdImgSel = $id("opt-md-image-policy");
  if (mdImgSel) mdImgSel.value = s.mdExportImagePolicy || "keep";
  const obsVault = $id("opt-obsidian-vault");
  if (obsVault) obsVault.value = s.obsidianVault || "";
  const obsFolder = $id("opt-obsidian-folder");
  if (obsFolder) obsFolder.value = s.obsidianFolder || "";

  // ---- Fill checkbox fields ----
  const checkMap = {
    "opt-private-default": s.optPrivateDefault, "opt-private-incognito": s.optPrivateIncognito,
    "opt-readlater-default": s.optReadlaterDefault, "opt-auto-description": s.optAutoDescription,
    "opt-blockquote": s.optBlockquote, "opt-include-referrer": s.optIncludeReferrer,
    "opt-ai-auto-tags": s.optAiAutoTags,
    "qs-auto-notes": s.qsAutoNotes, "qs-blockquote": s.qsBlockquote,
    "qs-ai-tags": s.qsAiTags, "qs-ai-summary": s.qsAiSummary,
    "rl-auto-notes": s.rlAutoNotes, "rl-blockquote": s.rlBlockquote,
    "rl-ai-tags": s.rlAiTags, "rl-ai-summary": s.rlAiSummary,
    "opt-batch-tag-enabled": s.optBatchTagEnabled,
    "batch-ai-tags": s.batchAiTags, "batch-ai-summary": s.batchAiSummary,
    "batch-skip-existing": s.batchSkipExisting,
    "opt-show-recent": s.optShowRecent, "opt-show-search": s.optShowSearch,
    "notify-quick-save": s.notifyQuickSave,
    "notify-read-later": s.notifyReadLater,
    "notify-tab-set": s.notifyTabSet, "notify-batch-save": s.notifyBatchSave,
    "notify-errors": s.notifyErrors,
    "opt-respect-tag-case": s.optRespectTagCase,
    "offline-queue-enabled": s.offlineQueueEnabled,
    "opt-show-badge": s.optShowBadge,
    "opt-check-bookmark-status": s.optCheckBookmarkStatus,
    "opt-show-suggest-tags": s.optShowSuggestTags,
    "opt-show-ai-summary": s.optShowAiSummary,
    "opt-show-ai-tags": s.optShowAiTags,
    "opt-show-quick-links": s.optShowQuickLinks,
    "opt-show-quick-row": s.optShowQuickRow,
    "opt-auto-close": s.optAutoCloseAfterSave,
    "opt-popup-follow-theme": s.optPopupFollowTheme,
    "opt-md-frontmatter": s.mdExportFrontmatter,
    "opt-md-include-toc": s.mdExportIncludeToc,
    "opt-obsidian-enabled": s.obsidianEnabled,
    "opt-tag-sort-by-pop": s.tagSortByPopEnabled,
    "opt-wayback-enabled": s.waybackArchiveEnabled === true,
    "opt-wayback-batch": s.waybackArchiveBatch === true
  };
  for (const [id, val] of Object.entries(checkMap)) {
    const el = $id(id);
    if (el) el.checked = val;
  }
  syncObsidianEnabledState();

  // ---- Popup width (B9) ----
  const popupWidth = Number(s.popupWidth) || 550;
  const presetValues = [450, 550, 650];
  if (presetValues.includes(popupWidth)) {
    const radio = document.querySelector(`input[name="popup-width-preset"][value="${popupWidth}"]`);
    if (radio) radio.checked = true;
  } else {
    const radio = document.querySelector(`input[name="popup-width-preset"][value="custom"]`);
    if (radio) radio.checked = true;
  }
  const customInput = $id("opt-popup-width-custom");
  if (customInput) {
    customInput.value = popupWidth;
    const selectCustomRadio = () => {
      const customRadio = document.querySelector('input[name="popup-width-preset"][value="custom"]');
      if (customRadio && !customRadio.checked) customRadio.checked = true;
    };
    customInput.addEventListener("focus", selectCustomRadio);
    customInput.addEventListener("input", selectCustomRadio);
    // Clamp + writeback only on blur/Enter — never during input,
    // because auto-save would re-clamp partial values (e.g. "6" → 420).
    const clampAndCommit = () => {
      const raw = parseInt(customInput.value, 10);
      if (isNaN(raw)) return;
      customInput.value = Math.max(420, Math.min(720, raw));
    };
    customInput.addEventListener("blur", clampAndCommit);
    customInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); clampAndCommit(); customInput.blur(); }
    });
  }

  // ---- URL Clean settings (B4) ----
  const urlClean = s.urlClean || { enabled: true, onPopupOpen: true, onPaste: true, aggressiveMode: false, customParams: [], excludeParams: [] };
  $id("opt-urlclean-enabled").checked = !!urlClean.enabled;
  $id("opt-urlclean-on-open").checked = !!urlClean.onPopupOpen;
  $id("opt-urlclean-on-paste").checked = !!urlClean.onPaste;
  $id("opt-urlclean-aggressive").checked = !!urlClean.aggressiveMode;
  $id("opt-urlclean-custom").value = (urlClean.customParams || []).join("\n");
  $id("opt-urlclean-exclude").value = (urlClean.excludeParams || []).join("\n");

  // ---- Load sync toggle (stored in local, not in settings storage) ----
  const { optSyncEnabled } = await chrome.storage.local.get({ optSyncEnabled: false });
  const syncToggle = $id("opt-sync-enabled");
  if (syncToggle) syncToggle.checked = optSyncEnabled;

  // Sync toggle change: migrate settings then reload
  syncToggle?.addEventListener("change", async () => {
    const enabling = syncToggle.checked;
    const oldStorage = enabling ? chrome.storage.local : chrome.storage.sync;
    const newStorage = enabling ? chrome.storage.sync : chrome.storage.local;
    try {
      // 1. Migrate regular settings
      const data = await oldStorage.get(Object.keys(SETTINGS_DEFAULTS));
      await newStorage.set(data);
      // 2. Migrate customOverlayCSS (large value) — read from old, then switch pref, then write to new
      const customOverlayCSS = await syncGetLarge("customOverlayCSS", "");
      const savedThemes = await syncGetLarge("savedThemes", []);
      await chrome.storage.local.set({ optSyncEnabled: enabling });
      await syncSetLarge("customOverlayCSS", customOverlayCSS);
      await syncSetLarge("savedThemes", savedThemes);
    } catch (e) {
      // Migration failed — revert toggle and abort
      console.error("sync migration failed:", e);
      syncToggle.checked = !enabling;
      await chrome.storage.local.set({ optSyncEnabled: !enabling });
      const errEl = $id("opt-sync-error");
      if (errEl) {
        errEl.textContent = t("syncMigrationFailed") || "Sync migration failed. Please try again or reduce custom CSS size.";
        errEl.classList.remove("hidden");
        setTimeout(() => errEl.classList.add("hidden"), 8000);
      }
      return;
    }
    // Fade out and reload
    const activePanel = document.querySelector(".tab-btn.active")?.dataset.panel || "general";
    sessionStorage.setItem("activeTab", activePanel);
    document.body.style.transition = "opacity 0.18s";
    document.body.style.opacity = "0";
    setTimeout(() => location.reload(), 180);
  });

  // ---- Apply options page theme based on Pinboard theme preset ----
  function applyOptionsPageTheme(presetKey, themeMode) {
    const prefersDark = themeMode === "dark" ||
      (themeMode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (ADAPTIVE_THEME_MAP[presetKey]) {
      const [light, dark] = ADAPTIVE_THEME_MAP[presetKey];
      document.documentElement.dataset.theme = prefersDark ? dark : light;
    } else if (presetKey) {
      document.documentElement.dataset.theme = presetKey;
    } else if (prefersDark) {
      document.documentElement.dataset.theme = "flexoki-dark";
    } else {
      delete document.documentElement.dataset.theme;
    }
  }
  // Track active preset key — schema v2: themePresetKey is authoritative
  let currentPresetKey = s.themePresetKey || "";
  applyOptionsPageTheme(currentPresetKey, s.optTheme);

  // Language change: save immediately and reload to apply
  $id("opt-lang").addEventListener("change", async () => {
    const lang = $id("opt-lang").value;
    const activePanel = document.querySelector(".tab-btn.active")?.dataset.panel || "general";
    await (await getSettingsStorage()).set({ optLang: lang });
    sessionStorage.setItem("activeTab", activePanel);
    document.body.style.transition = "opacity 0.18s";
    document.body.style.opacity = "0";
    setTimeout(() => location.reload(), 180);
  });
  // Real-time switch when theme dropdown changes (affects options-page theme + preset preview)
  // Adaptive presets resolve to light/dark variant in pinboard-style.js content script;
  // options page only re-renders its own dataset.theme here.
  $id("opt-theme").addEventListener("change", () => {
    const mode = $id("opt-theme").value;
    applyOptionsPageTheme(currentPresetKey, mode);
    renderPresetPreview();
  });

  // ---- Provider field toggle ----
  const providers = ["gemini","openai","claude","deepseek","qwen","minimax","openrouter","groq","mistral","cohere","siliconflow","zhipu","kimi","ollama","custom"];
  function updateProviderFields() {
    const selected = $id("opt-ai-provider").value;
    providers.forEach(p => {
      const el = $id("fields-" + p);
      if (el) el.classList.toggle("hidden", p !== selected);
    });
  }
  updateProviderFields();
  $id("opt-ai-provider").addEventListener("change", updateProviderFields);

  // ---- Reset prompt buttons ----
  $id("reset-tag-prompt").addEventListener("click", () => {
    $id("opt-custom-tag-prompt").value = DEFAULT_TAG_PROMPT;
    saveAll();
  });
  $id("reset-summary-prompt").addEventListener("click", () => {
    $id("opt-custom-summary-prompt").value = DEFAULT_SUMMARY_PROMPT;
    saveAll();
  });

  // ---- Batch: revoke all-sites permission ----
  // Reflect current grant state on load
  (async () => {
    try {
      const has = await chrome.permissions.contains({ origins: ["*://*/*"] });
      const statusEl = $id("batch-perm-status");
      const btn = $id("batch-revoke-perm");
      if (!has) {
        if (statusEl) statusEl.textContent = t("batchPermNone");
        if (btn) btn.disabled = true;
      }
    } catch (_) {}
  })();

  $id("batch-revoke-perm")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const btn = e.currentTarget;
    const orig = btn.textContent;
    try {
      const revoked = await chrome.permissions.remove({ origins: ["*://*/*"] });
      if (revoked) {
        btn.textContent = t("batchRevokeSuccess");
        if ($id("batch-perm-status")) $id("batch-perm-status").textContent = t("batchPermRevoked");
        btn.disabled = true;
        setTimeout(() => { btn.textContent = orig; }, 2000);
      } else {
        if ($id("batch-perm-status")) $id("batch-perm-status").textContent = t("batchPermNone");
        btn.disabled = true;
        setTimeout(() => { btn.textContent = orig; }, 2000);
      }
    } catch (err) {
      console.error("revoke permission failed:", err);
      btn.textContent = t("batchRevokeFailed");
      setTimeout(() => { btn.textContent = orig; }, 2000);
    }
  });

  // ---- Wayback: check permission on load ----
  (async () => {
    try {
      const has = await chrome.permissions.contains({ origins: ["https://web.archive.org/*"] });
      const statusEl = $id("wayback-perm-status");
      if (!has && s.waybackArchiveEnabled) {
        if (statusEl) statusEl.textContent = t("waybackPermDenied");
      }
    } catch (_) {}
  })();

  // ---- Wayback: toggle permission on opt-wayback-enabled change ----
  $id("opt-wayback-enabled")?.addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    const statusEl = $id("wayback-perm-status");
    if (enabled) {
      try {
        const granted = await chrome.permissions.request({ origins: ["https://web.archive.org/*"] });
        if (!granted) {
          e.target.checked = false;
          // Programmatic .checked changes fire no 'change' event; re-dispatch so the
          // global auto-save persists the reverted (false) state via the normal path
          // (which picks the correct storage area). Re-entering this listener is safe:
          // it only acts when checked === true. Any transient true the debounced save
          // may have written mid-dialog is overwritten by this final false save.
          e.target.dispatchEvent(new Event("change", { bubbles: true }));
          if (statusEl) statusEl.textContent = t("waybackPermDenied");
          return;
        }
        if (statusEl) statusEl.textContent = "";
      } catch (err) {
        console.error("wayback permission request failed:", err);
        e.target.checked = false;
        // Same re-dispatch as the deny branch — ensures storage reflects false.
        e.target.dispatchEvent(new Event("change", { bubbles: true }));
        if (statusEl) statusEl.textContent = t("waybackPermDenied");
      }
    }
  });

  // ===================== Auto-save =====================
  // Collect all settings from the form and save to chrome.storage.sync
  async function saveAll() {
    const data = {
      // Bookmarks
      pinboardToken: obfuscateKey($id("opt-pinboard-token").value.trim()),
      optPrivateDefault: $id("opt-private-default").checked,
      optPrivateIncognito: $id("opt-private-incognito").checked,
      optReadlaterDefault: $id("opt-readlater-default").checked,
      optAutoDescription: $id("opt-auto-description").checked,
      optBlockquote: $id("opt-blockquote").checked,
      optIncludeReferrer: $id("opt-include-referrer").checked,
      optRespectTagCase: $id("opt-respect-tag-case").checked,
      bgSaveMode: document.querySelector('input[name="bgsave-mode"]:checked')?.value || "merge",
      offlineQueueEnabled: $id("offline-queue-enabled").checked,
      // Quick Actions
      qsAutoNotes: $id("qs-auto-notes").checked,
      qsBlockquote: $id("qs-blockquote").checked,
      qsDefaultTags: $id("qs-default-tags").value.trim(),
      qsAiTags: $id("qs-ai-tags").checked,
      qsAiSummary: $id("qs-ai-summary").checked,
      // Read Later
      rlAutoNotes: $id("rl-auto-notes").checked,
      rlBlockquote: $id("rl-blockquote").checked,
      rlDefaultTags: $id("rl-default-tags").value.trim(),
      rlAiTags: $id("rl-ai-tags").checked,
      rlAiSummary: $id("rl-ai-summary").checked,
      optBatchTagEnabled: $id("opt-batch-tag-enabled").checked,
      optBatchTag: $id("opt-batch-tag").value.trim() || "batch_saved",
      batchAiTags: $id("batch-ai-tags").checked,
      batchAiSummary: $id("batch-ai-summary").checked,
      batchSkipExisting: $id("batch-skip-existing").checked,
      // AI Provider & Keys
      aiProvider: $id("opt-ai-provider").value,
      geminiApiKey: obfuscateKey($id("opt-gemini-key").value.trim()),
      geminiModel: $id("opt-gemini-model").value.trim() || "gemini-2.5-flash-lite",
      openaiApiKey: obfuscateKey($id("opt-openai-key").value.trim()),
      openaiModel: $id("opt-openai-model").value.trim() || "gpt-5.4-nano",
      openaiBaseUrl: $id("opt-openai-baseurl").value.trim() || "https://api.openai.com/v1",
      claudeApiKey: obfuscateKey($id("opt-claude-key").value.trim()),
      claudeModel: $id("opt-claude-model").value.trim() || "claude-haiku-4-5-20251001",
      deepseekApiKey: obfuscateKey($id("opt-deepseek-key").value.trim()),
      deepseekModel: $id("opt-deepseek-model").value.trim() || "deepseek-v4-flash",
      qwenApiKey: obfuscateKey($id("opt-qwen-key").value.trim()),
      qwenModel: $id("opt-qwen-model").value.trim() || "qwen-flash",
      minimaxApiKey: obfuscateKey($id("opt-minimax-key").value.trim()),
      minimaxModel: $id("opt-minimax-model").value.trim() || "MiniMax-M2",
      openrouterApiKey: obfuscateKey($id("opt-openrouter-key").value.trim()),
      openrouterModel: $id("opt-openrouter-model").value.trim() || "meta-llama/llama-4-scout:free",
      groqApiKey: obfuscateKey($id("opt-groq-key").value.trim()),
      groqModel: $id("opt-groq-model").value.trim() || "meta-llama/llama-4-scout-17b-16e-instruct",
      mistralApiKey: obfuscateKey($id("opt-mistral-key").value.trim()),
      mistralModel: $id("opt-mistral-model").value.trim() || "mistral-small-latest",
      cohereApiKey: obfuscateKey($id("opt-cohere-key").value.trim()),
      cohereModel: $id("opt-cohere-model").value.trim() || "command-r-08-2024",
      siliconflowApiKey: obfuscateKey($id("opt-siliconflow-key").value.trim()),
      siliconflowModel: $id("opt-siliconflow-model").value.trim() || "Qwen/Qwen3-8B",
      zhipuApiKey: obfuscateKey($id("opt-zhipu-key").value.trim()),
      zhipuModel: $id("opt-zhipu-model").value.trim() || "glm-4.7-flash",
      kimiApiKey: obfuscateKey($id("opt-kimi-key").value.trim()),
      kimiModel: $id("opt-kimi-model").value.trim() || "kimi-k2.6",
      ollamaBaseUrl: $id("opt-ollama-baseurl").value.trim() || "http://localhost:11434",
      ollamaModel: $id("opt-ollama-model").value.trim() || "llama3.2",
      customName: $id("opt-custom-name").value.trim() || "Custom",
      customBaseUrl: $id("opt-custom-baseurl").value.trim(),
      customApiKey: obfuscateKey($id("opt-custom-key").value.trim()),
      customModel: $id("opt-custom-model").value.trim(),
      // AI Behavior & Prompts
      optAiAutoTags: $id("opt-ai-auto-tags").checked,
      aiTagLang: $id("opt-ai-tag-lang").value,
      aiSummaryLang: $id("opt-ai-summary-lang").value,
      aiCacheDuration: Math.min(10080, Math.max(0, parseInt($id("opt-ai-cache-duration").value) || 60)),
      aiTagSeparator: $id("opt-ai-tag-separator").value,
      aiContentSource: document.querySelector('input[name="ai-content-source"]:checked')?.value || "local",
      tagSyncMode: document.querySelector('input[name="tag-sync-mode"]:checked')?.value || "cached",
      jinaApiKey: obfuscateKey($id("opt-jina-key").value.trim()),
      customTagPrompt: $id("opt-custom-tag-prompt").value,
      customSummaryPrompt: $id("opt-custom-summary-prompt").value,
      mdExportFrontmatter: $id("opt-md-frontmatter").checked,
      mdExportImagePolicy: $id("opt-md-image-policy").value,
      mdExportIncludeToc: $id("opt-md-include-toc").checked,
      obsidianEnabled: $id("opt-obsidian-enabled").checked,
      obsidianVault: $id("opt-obsidian-vault").value.trim(),
      obsidianFolder: $id("opt-obsidian-folder").value.trim(),
      // Appearance
      optLang: $id("opt-lang").value,
      optTheme: $id("opt-theme").value,
      optShowSearch: $id("opt-show-search").checked,
      optShowRecent: $id("opt-show-recent").checked,
      optShowBadge: $id("opt-show-badge").checked,
      // Notifications
      notifyQuickSave: $id("notify-quick-save").checked,
      notifyReadLater: $id("notify-read-later").checked,
      notifyTabSet: $id("notify-tab-set").checked,
      notifyBatchSave: $id("notify-batch-save").checked,
      notifyErrors: $id("notify-errors").checked,
      // Custom Style (font here; overlay CSS saved separately via syncSetLarge below)
      customFont: $id("opt-custom-font").value.trim(),
      // New toggles
      optCheckBookmarkStatus: $id("opt-check-bookmark-status").checked,
      optShowSuggestTags: $id("opt-show-suggest-tags").checked,
      optShowAiSummary: $id("opt-show-ai-summary").checked,
      optShowAiTags: $id("opt-show-ai-tags").checked,
      optShowQuickLinks: $id("opt-show-quick-links").checked,
      optShowQuickRow: $id("opt-show-quick-row").checked,
      optAutoCloseAfterSave: $id("opt-auto-close").checked,
      optPopupFollowTheme: $id("opt-popup-follow-theme").checked,
      tagSortByPopEnabled: $id("opt-tag-sort-by-pop").checked,
      tagPresets: $id("opt-tag-presets").value,
      waybackArchiveEnabled: $id("opt-wayback-enabled").checked,
      waybackArchiveBatch: $id("opt-wayback-batch").checked,
      waybackS3Key: obfuscateKey($id("opt-wayback-s3key").value.trim()),
      waybackS3Secret: obfuscateKey($id("opt-wayback-s3secret").value.trim()),
      themePresetKey: currentPresetKey,
      urlClean: {
        enabled: $id("opt-urlclean-enabled").checked,
        onPopupOpen: $id("opt-urlclean-on-open").checked,
        onPaste: $id("opt-urlclean-on-paste").checked,
        aggressiveMode: $id("opt-urlclean-aggressive").checked,
        customParams: $id("opt-urlclean-custom").value.split("\n").map(s => s.trim()).filter(Boolean),
        excludeParams: $id("opt-urlclean-exclude").value.split("\n").map(s => s.trim()).filter(Boolean),
      },
      // ---- Popup width (B9) ----
      ...(() => {
        const selectedPreset = document.querySelector('input[name="popup-width-preset"]:checked')?.value;
        let popupWidthToSave = 550;
        if (selectedPreset === "custom") {
          const raw = parseInt($id("opt-popup-width-custom").value, 10);
          // Clamp the stored value but do NOT write back to the input — that
          // would clobber partial keystrokes during auto-save (e.g. typing "6"
          // for an eventual "600" would snap to 420). The blur/Enter handler
          // is responsible for cleaning up the displayed value.
          popupWidthToSave = Math.max(420, Math.min(720, isNaN(raw) ? 550 : raw));
        } else if (selectedPreset) {
          popupWidthToSave = parseInt(selectedPreset, 10);
        }
        return { popupWidth: popupWidthToSave };
      })()
    };
    await (await getSettingsStorage()).set(data);
    // Save customOverlayCSS with quota-aware fallback (sync → local on QUOTA_BYTES)
    await saveOverlayWithFallback($id("opt-custom-css").value);
    flashAutoSave();
  }

  // Quota-aware overlay save. On sync QUOTA_BYTES, write to local + flag,
  // so the content script and other devices know overlay isn't synced.
  async function saveOverlayWithFallback(value) {
    if (value.length > OVERLAY_BYTE_LIMIT) {
      // UI-side counter blocks before this; final guard
      console.warn("[overlay] exceeds 50KB cap, refusing save");
      return;
    }
    try {
      await syncSetLarge("customOverlayCSS", value);
      await chrome.storage.sync.set({ optOverlayInLocal: false });
      await chrome.storage.local.remove("customOverlayCSS_localFallback");
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (/QUOTA|quota/i.test(msg)) {
        await chrome.storage.local.set({ customOverlayCSS_localFallback: value });
        await chrome.storage.sync.set({ optOverlayInLocal: true });
        const status = $id("auto-save-status");
        if (status) {
          status.textContent = t("overlayQuotaFallback") || "CSS saved locally (sync quota full)";
          status.classList.add("saved");
          setTimeout(() => { status.textContent = t("optAutoSave"); status.classList.remove("saved"); }, 4000);
        }
      } else {
        throw e;
      }
    }
  }

  // Debounced auto-save: triggers 500ms after last change
  let saveTimer = null;
  function scheduleAutoSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveAll, 500);
  }

  // Listen on all form inputs for auto-save
  document.querySelectorAll('.panel input[type="checkbox"]').forEach(el => {
    el.addEventListener("change", scheduleAutoSave);
  });
  document.querySelectorAll('.panel input[type="text"], .panel input[type="password"], .panel input[type="number"], .panel textarea').forEach(el => {
    el.addEventListener("input", scheduleAutoSave);
  });
  document.querySelectorAll('.panel select').forEach(el => {
    el.addEventListener("change", scheduleAutoSave);
  });
  document.querySelectorAll('.panel input[type="radio"]').forEach(el => {
    el.addEventListener("change", scheduleAutoSave);
  });
  const obsEnabledEl = $id("opt-obsidian-enabled");
  if (obsEnabledEl) obsEnabledEl.addEventListener("change", syncObsidianEnabledState);

  function flashAutoSave() {
    const el = $id("auto-save-status");
    setStatusIcon(el, true, t("optAutoSaved"));
    el.classList.add("saved");
    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.textContent = t("optAutoSave");
      el.classList.remove("saved");
    }, 1500);
  }

  // ---- Export/Import: see options-backup.js ----
  // EXPORTABLE_KEYS whitelist excludes API keys + cache entries from backup.
  const EXPORTABLE_KEYS = Object.keys(SETTINGS_DEFAULTS).filter(k => !API_KEY_FIELDS.includes(k));
  setupBackup({ exportableKeys: EXPORTABLE_KEYS, saveOverlayWithFallback });
  setupApiTests();


  // ---- Theme preset buttons ----
  // Schema v2: preset selection only updates currentPresetKey;
  // textarea (overlay) is never touched. Active state mirrors the key.
  function updateThemePresetButtons() {
    document.querySelectorAll(".theme-preset-btn").forEach(btn => {
      const key = btn.dataset.theme || "";
      const isActive = key === currentPresetKey;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }
  updateThemePresetButtons();

  // Render a read-only preview of the selected preset's CSS (collapsible panel).
  function renderPresetPreview() {
    const previewEl = $id("preset-preview-content");
    const previewSection = $id("preset-preview-section");
    if (!previewEl || !previewSection) return;
    if (!currentPresetKey) {
      previewSection.style.display = "none";
      previewEl.textContent = "";
      return;
    }
    let themeKey = currentPresetKey;
    if (ADAPTIVE_THEME_MAP[themeKey]) {
      const mode = $id("opt-theme").value;
      const prefersDark = mode === "dark" || (mode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      const variantKey = ADAPTIVE_THEME_MAP[themeKey][prefersDark ? 1 : 0];
      if (PINBOARD_THEMES[variantKey]) themeKey = variantKey;
      // Fall back to parent (e.g., flexoki ships one CSS that toggles via .pbp-dark)
    }
    const theme = PINBOARD_THEMES[themeKey];
    previewSection.style.display = "";
    previewEl.textContent = theme ? theme.css : "";
  }

  // W3: appearance panel's render deps (currentPresetKey, PINBOARD_THEMES,
  // ADAPTIVE_THEME_MAP, $id targets) are now initialized — flip the boot-ready
  // flag, flush any queued init from earlier saved-tab clicks, then handle the
  // boot-active case. Dumping a full PINBOARD_THEMES entry (~50KB CSS) into the
  // preview textarea costs noticeable boot time, so we only render when the
  // appearance panel is actually viewed. Settings VALUE population for
  // appearance fields still happens unconditionally above, so saveAll() sees
  // correct values regardless of which panel was viewed.
  _appearancePanelBootReady = true;
  if (_appearancePendingInit) _initAppearancePanel();
  const _activePanelAtBoot = document.querySelector(".tab-btn.active")?.dataset?.panel;
  if (_activePanelAtBoot === "appearance") _initAppearancePanel();

  function applyPreset(key) {
    currentPresetKey = key || "";
    updateThemePresetButtons();
    updateSavedThemeButtons();
    updateSaveThemeBtnState();
    applyOptionsPageTheme(currentPresetKey, $id("opt-theme").value);
    renderPresetPreview();
    scheduleAutoSave();
  }

  document.querySelectorAll(".theme-preset-btn").forEach(btn => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.theme));
  });

  // Toggle "Save as theme" button disabled state based on whether there's
  // any non-whitespace CSS to save. Called from input handler, preset apply,
  // and on initial load.
  function updateSaveThemeBtnState() {
    const saveBtn = $id("save-custom-theme");
    if (!saveBtn) return;
    const css = $id("opt-custom-css").value;
    saveBtn.disabled = !css.trim();
  }

  // Update saved-theme/save-button state and byte counter when user edits overlay CSS.
  // Schema v2: textarea is the overlay; it does NOT determine the preset.
  $id("opt-custom-css").addEventListener("input", () => {
    updateSavedThemeButtons();
    updateSaveThemeBtnState();
    updateOverlayByteCounter();
  });

  // Byte counter: shows N B / 50 KB; warns at 80%, blocks save at 100%.
  function updateOverlayByteCounter() {
    const ta = $id("opt-custom-css");
    const counter = $id("overlay-byte-counter");
    if (!ta || !counter) return;
    const bytes = new Blob([ta.value]).size;
    const pct = bytes / OVERLAY_BYTE_LIMIT;
    counter.textContent = `${formatBytes(bytes)} / 50 KB`;
    counter.classList.toggle("warn", pct >= 0.8 && pct < 1);
    counter.classList.toggle("over", pct >= 1);
    ta.classList.toggle("over-limit", pct >= 1);
  }
  function formatBytes(b) {
    if (b < 1024) return `${b} B`;
    return `${(b / 1024).toFixed(1)} KB`;
  }
  updateOverlayByteCounter();

  // ---- Saved custom themes ----
  let savedThemes = []; // [{ name: "My Theme", css: "..." }, ...]

  async function loadSavedThemes() {
    savedThemes = await syncGetLarge("savedThemes", []);
    if (!Array.isArray(savedThemes)) savedThemes = [];
    // One-time migration from local
    if (!savedThemes.length) {
      const local = await chrome.storage.local.get({ savedThemes: [] });
      if (Array.isArray(local.savedThemes) && local.savedThemes.length) {
        savedThemes = local.savedThemes;
        await syncSetLarge("savedThemes", savedThemes);
        await chrome.storage.local.remove("savedThemes");
      }
    }
    renderSavedThemes();
  }

  async function persistSavedThemes() {
    await syncSetLarge("savedThemes", savedThemes);
  }

  function renderSavedThemes() {
    const container = $id("saved-themes-list");
    const section = $id("saved-themes-section");
    while (container.firstChild) container.removeChild(container.firstChild);
    section.style.display = savedThemes.length ? "" : "none";
    const currentCSS = $id("opt-custom-css").value;
    savedThemes.forEach((theme) => {
      const wrap = document.createElement("span");
      wrap.className = "saved-theme-wrap";
      const btn = document.createElement("button");
      btn.className = "btn btn-sm saved-theme-btn";
      btn.textContent = theme.name;
      btn.title = theme.name; // Full-name tooltip in case label gets truncated
      btn.setAttribute("aria-label", t("loadTheme", theme.name));
      const isActive = currentCSS.trim() === theme.css.trim();
      if (isActive) btn.classList.add("active");
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      btn.addEventListener("click", () => {
        $id("opt-custom-css").value = theme.css;
        updateThemePresetButtons();
        updateSavedThemeButtons();
        updateSaveThemeBtnState();
        // Custom saved themes do NOT affect options page styling — clear preset key
        currentPresetKey = "";
        applyOptionsPageTheme("", $id("opt-theme").value);
        scheduleAutoSave();
      });
      const del = document.createElement("button");
      del.className = "saved-theme-del";
      del.textContent = "\u00d7";
      del.title = t("deleteTheme");
      del.setAttribute("aria-label", t("deleteThemeNamed", theme.name));
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        showConfirmPopover(wrap, {
          msg: t("deleteThemeConfirm", theme.name),
          yesText: t("delete"),
          noText: t("cancel"),
          onConfirm: async () => {
            // Re-find by name in case the array mutated while popover was open.
            const current = savedThemes.findIndex(th => th.name === theme.name);
            if (current >= 0) {
              savedThemes.splice(current, 1);
              await persistSavedThemes();
              renderSavedThemes();
            }
          },
        });
      });
      wrap.append(btn, del);
      container.appendChild(wrap);
    });
  }

  function updateSavedThemeButtons() {
    const currentCSS = $id("opt-custom-css").value;
    document.querySelectorAll(".saved-theme-btn").forEach(btn => {
      const theme = savedThemes.find(t => t.name === btn.textContent);
      const isActive = !!(theme && currentCSS.trim() === theme.css.trim());
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  $id("save-custom-theme").addEventListener("click", () => {
    const css = $id("opt-custom-css").value.trim();
    if (!css) return;

    const wrap = document.querySelector(".save-theme-wrap");
    if (wrap.querySelector(".theme-name-popover")) return; // already open

    const pop = document.createElement("div");
    pop.className = "theme-name-popover";

    const lbl = document.createElement("label");
    lbl.textContent = t("themeName");

    const inp = document.createElement("input");
    inp.type = "text";
    inp.maxLength = 40;

    const overwriteMsg = document.createElement("p");
    overwriteMsg.className = "tnp-overwrite";
    overwriteMsg.style.display = "none";

    const actions = document.createElement("div");
    actions.className = "tnp-actions";

    const saveBtn = document.createElement("button");
    saveBtn.className = "tnp-save";
    saveBtn.textContent = t("themeNameSave");

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "tnp-cancel";
    cancelBtn.textContent = t("cancel");

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    pop.appendChild(lbl);
    pop.appendChild(inp);
    pop.appendChild(overwriteMsg);
    pop.appendChild(actions);
    wrap.appendChild(pop);

    inp.focus();

    function dismiss() {
      pop.remove();
      document.removeEventListener("keydown", onEscGlobal);
    }
    // Document-level ESC so focus doesn't have to be inside the input.
    function onEscGlobal(ev) { if (ev.key === "Escape") dismiss(); }
    document.addEventListener("keydown", onEscGlobal);

    pop.addEventListener("click", (e) => e.stopPropagation());
    cancelBtn.addEventListener("click", dismiss);

    saveBtn.addEventListener("click", async () => {
      const trimmedName = inp.value.trim();
      if (!trimmedName) { inp.focus(); return; }
      const existing = savedThemes.findIndex(th => th.name === trimmedName);
      if (existing >= 0 && overwriteMsg.style.display === "none") {
        overwriteMsg.textContent = t("themeOverwrite", trimmedName);
        overwriteMsg.style.display = "";
        saveBtn.textContent = t("themeNameOverwriteBtn");
        return;
      }
      if (existing >= 0) {
        savedThemes[existing].css = css;
      } else {
        savedThemes.push({ name: trimmedName, css });
      }
      await persistSavedThemes();
      renderSavedThemes();
      dismiss();
    });

    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveBtn.click();
    });

    // close on outside click
    function outsideClick() { dismiss(); document.removeEventListener("click", outsideClick); }
    setTimeout(() => document.addEventListener("click", outsideClick), 0);
  });

  await loadSavedThemes();
  updateSaveThemeBtnState();

  // ---- Chrome shortcuts link ----
  $id("open-shortcuts-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
  $id("open-shortcuts-link-rl")?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
  $id("open-shortcuts-link-md")?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
  // Show the ACTUAL bound key for the Markdown preview command (not a hardcoded guess).
  try {
    const cmds = await chrome.commands.getAll();
    const mdCmd = cmds.find((c) => c.name === "markdown_preview");
    const cur = $id("md-shortcut-current");
    if (cur) {
      if (mdCmd && mdCmd.shortcut) {
        cur.textContent = "";
        const kbd = document.createElement("kbd");
        kbd.textContent = mdCmd.shortcut;
        cur.appendChild(kbd);
      } else {
        cur.textContent = t("mdShortcutUnset");
      }
    }
  } catch (_) { /* commands API unavailable — leave the field blank */ }


  // B5: Write high-frequency UI fields mirror for next options open.
  // Never stores API keys or tokens — only boolean "loggedIn" and visible UI state.
  try {
    const mirror = {
      ts: Date.now(),
      loggedIn: !!(s.pinboardToken),
      aiProvider: s.aiProvider || "gemini",
      notify: {
        "notify-quick-save": s.notifyQuickSave !== false,
        "notify-read-later": s.notifyReadLater !== false,
        "notify-tab-set": s.notifyTabSet !== false,
        "notify-batch-save": s.notifyBatchSave !== false,
        "notify-errors": s.notifyErrors !== false,
      }
    };
    localStorage.setItem("pp-options-fields", JSON.stringify(mirror));
  } catch (_) {}

  // ---- Tag governance event listeners ----
  $id("tag-gov-reset-ignored")?.addEventListener("click", async (e) => {
    e.preventDefault();
    showConfirmPopover($id("tag-gov-reset-ignored"), {
      msg: t("tagGovResetIgnoredConfirm"),
      yesText: t("reset"),
      noText: t("cancel"),
      onConfirm: async () => {
        await chrome.storage.local.remove("_tagGovIgnored");
        await renderTagGov();
      }
    });
  });

  $id("tag-gov-delete-selected")?.addEventListener("click", async () => {
    const selected = Array.from(
      document.querySelectorAll(".tag-gov-lowcount-checkbox:checked")
    ).map(el => el.value);
    if (!selected.length) return;
    const btn = $id("tag-gov-delete-selected");
    const shown = selected.slice(0, 10).join(", ") + (selected.length > 10 ? ", +" + (selected.length - 10) + " more" : "");
    const msg = t("tagGovConfirmDelete", String(selected.length))
      + "\n" + shown;
    showConfirmPopover(btn, {
      msg,
      yesText: t("tagGovDeleteSelected"),
      noText: t("cancel"),
      onConfirm: async () => {
        if (btn) btn.disabled = true;
        if (!(await ensureTagSnapshot())) {
          if (btn) btn.disabled = false;
          return;
        }
        await runTagGovOps(selected.map(tag => ({ op: "delete", tag })));
        if (btn) btn.disabled = false;
      }
    });
  });

  $id("tag-gov-ai-btn")?.addEventListener("click", async () => {
    const btn = $id("tag-gov-ai-btn");
    const statusEl = $id("tag-gov-ai-status");

    if (!hasAIKey(s)) {
      if (statusEl) {
        setStatusIcon(statusEl, false, t("tagGovAiNoKey"));
        statusEl.style.color = "#c00";
        setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 5000);
      }
      return;
    }

    const origLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = t("tagGovAiRunning");
    if (statusEl) { statusEl.textContent = ""; statusEl.style.color = ""; }

    try {
      const counts = await loadTagCounts(false);
      if (!counts) throw new Error("Failed to load tag counts");

      const prompt = pbpTagGovBuildAiPrompt(counts, 1500);
      const raw = await getOrCreateInflight("taggov|" + s.aiProvider, () => callAI(s, prompt));

      const aiGroups = pbpTagGovParseAiResponse(raw, counts);

      await chrome.storage.local.set({ _tagGovAiGroups: { groups: aiGroups, ts: Date.now() } });
      await renderTagGov();

      if (statusEl && aiGroups.length === 0) {
        statusEl.textContent = t("tagGovAiNone");
      }
    } catch (err) {
      let msg = err.name === "AbortError" ? t("testTimeout") : err.message;
      if (err?.code === "model_not_found") {
        msg = t("aiErrorModelNotFound", s.aiProvider) + " " + t("aiErrorModelNotFoundHint");
      }
      if (statusEl) {
        setStatusIcon(statusEl, false, msg);
        statusEl.style.color = "#c00";
        setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 5000);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  });

  await renderWaybackLog();
});

// ---- Tag Governance helpers (top-level so they survive the DOMContentLoaded closure) ----

const TAG_GOV_RETRY_WAIT_MS = 10000; // single backoff before retrying a 429 once (Pinboard rate limit)

// Shared token reader for tag-governance operations.
// Returns the deobfuscated Pinboard token, or "" if not set / on error.
async function getTagGovToken() {
  try {
    const s = await (await getSettingsStorage()).get(SETTINGS_DEFAULTS);
    return deobfuscateKey(s.pinboardToken) || "";
  } catch (e) {
    console.error("[tag-gov] getTagGovToken failed:", e);
    return "";
  }
}

// Once per options-page session: download a tags/get snapshot before any destructive op.
// Returns true if the snapshot was already downloaded this session or was just successfully
// downloaded. Returns false (and shows an error in #tag-gov-progress-text) on any failure.
let _tagGovSnapshotDownloaded = false;

async function ensureTagSnapshot() {
  if (_tagGovSnapshotDownloaded) return true;
  const progressText = $id("tag-gov-progress-text");
  const progress = $id("tag-gov-progress");
  try {
    const token = await getTagGovToken();
    if (!token) {
      if (progress) progress.classList.remove("hidden");
      if (progressText) progressText.textContent = t("tagGovSnapshotFailed");
      return false;
    }
    const resp = await pinboardFetch(
      `https://api.pinboard.in/v1/tags/get?auth_token=${encodeURIComponent(token)}&format=json`
    );
    if (!resp || !resp.ok) {
      if (progress) progress.classList.remove("hidden");
      if (progressText) progressText.textContent = t("tagGovSnapshotFailed");
      return false;
    }
    const counts = await resp.json();
    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    const yyyymmdd = pad(now.getFullYear(), 4) + pad(now.getMonth() + 1) + pad(now.getDate());
    const hhmm = pad(now.getHours()) + pad(now.getMinutes());
    const filename = `pinboard-tags-snapshot-${yyyymmdd}-${hhmm}.json`;
    const blob = new Blob(
      [JSON.stringify({ exportedAt: now.toISOString(), counts }, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    _tagGovSnapshotDownloaded = true;
    if (progress) progress.classList.remove("hidden");
    if (progressText) progressText.textContent = t("tagGovSnapshotSaved");
    return true;
  } catch (e) {
    console.error("[tag-gov] ensureTagSnapshot failed:", e);
    if (progress) progress.classList.remove("hidden");
    if (progressText) progressText.textContent = t("tagGovSnapshotFailed");
    return false;
  }
}

async function confirmMergeGroup(group, canonical, anchorEl) {
  if (!group || !group.members || group.members.length === 0) return;
  const plan = pbpTagGovBuildPlan(group.members, canonical);
  if (plan.length === 0) return;
  const renames = plan.filter(op => op.op === "rename");
  const summary = renames.map(op => op.old + " -> " + canonical).join(" | ");
  // Renames run as per-bookmark re-saves (tags/rename is broken server-side), so the
  // duration scales with bookmark count: one posts/all fetch per rename + one posts/add
  // per bookmark, each spaced 3.1s by the rate-limit queue.
  const canonLower = canonical.toLowerCase();
  const bookmarkCount = group.members.reduce((sum, m) =>
    (m && m.tag && m.tag.toLowerCase() !== canonLower) ? sum + (m.count || 0) : sum, 0);
  const estSec = Math.ceil((renames.length + bookmarkCount) * 3.2);
  const estStr = estSec < 90 ? estSec + "s" : Math.ceil(estSec / 60) + " min";
  const msg = t("tagGovConfirmMerge", String(renames.length), canonical)
    + (summary ? ": " + summary : "")
    + "\n" + t("tagGovMergeEstimate", estStr);
  const anchor = anchorEl;
  if (!anchor) return;
  showConfirmPopover(anchor, {
    msg,
    yesText: t("tagGovMerge"),
    noText: t("cancel"),
    onConfirm: async () => {
      if (!(await ensureTagSnapshot())) return;
      await runTagGovOps(plan);
    }
  });
}

// Pinboard's v1 tags/rename endpoint is broken server-side (verified 2026-06-11: HTTP 500
// with empty body for EVERY input, including two nonexistent tag names — it crashes before
// input validation; the documented v2 API is not deployed, all /v2/* paths return an
// Apache-level 403). tags/delete and posts/add still work, so renames are implemented as
// per-bookmark re-tagging: fetch every post carrying the old tag, then re-save each via
// posts/add replace=yes with the old tag substituted. The old tag disappears on its own
// once its use count reaches zero. Deliberately NO tags/delete afterwards: if any re-save
// was skipped or failed, deleting would strip the old tag with no new tag present (data loss).
// Each network call flows through the shared 3.1s pinboardFetch queue.
async function retagBookmarksViaResave(token, oldTag, newTag, onProgress) {
  const enc = encodeURIComponent;
  const listUrl = `https://api.pinboard.in/v1/posts/all?tag=${enc(oldTag)}&meta=no&format=json&auth_token=${enc(token)}`;
  let resp = await pinboardFetch(listUrl, { timeoutMs: 30000 });
  if (resp.status === 429) {
    await new Promise(r => setTimeout(r, TAG_GOV_RETRY_WAIT_MS));
    resp = await pinboardFetch(listUrl, { timeoutMs: 30000 });
    if (resp.status === 429) return { total: 0, saved: 0, failed: 0, skipped: 0, aborted: true };
  }
  if (!resp.ok) return { total: 0, saved: 0, failed: 1, skipped: 0, aborted: false };
  const posts = await resp.json();
  if (!Array.isArray(posts)) return { total: 0, saved: 0, failed: 1, skipped: 0, aborted: false };

  const oldLower = oldTag.toLowerCase();
  let saved = 0, failed = 0, skipped = 0;
  for (let i = 0; i < posts.length; i++) {
    if (onProgress) onProgress(i, posts.length);
    const post = posts[i];
    if (!post || !post.href) { failed++; continue; }
    const tags = (post.tags || "").split(/\s+/).filter(Boolean);
    // Pinboard tags are case-insensitive: match accordingly. Already clean -> count as done without a write.
    if (!tags.some(tg => tg.toLowerCase() === oldLower)) { saved++; continue; }
    const seen = new Set();
    const next = [];
    for (const tg of tags) {
      const replaced = tg.toLowerCase() === oldLower ? newTag : tg;
      const key = replaced.toLowerCase();
      if (!seen.has(key)) { seen.add(key); next.push(replaced); }
    }
    const uri = buildPostsAddUri({
      token,
      url: post.href,
      title: post.description || post.href,
      extended: post.extended || "",
      tags: next.join(" "),
      shared: post.shared,
      toread: post.toread,
      dt: post.time
    });
    // Never truncate a bookmark to fit the URI cap — skip it and surface the count instead.
    if (uri.length > POSTS_ADD_URI_BUDGET) { skipped++; continue; }
    try {
      let r = await pinboardFetch(uri);
      if (r.status === 429) {
        await new Promise(rs => setTimeout(rs, TAG_GOV_RETRY_WAIT_MS));
        r = await pinboardFetch(uri);
        if (r.status === 429) return { total: posts.length, saved, failed, skipped, aborted: true };
      }
      if (!r.ok) { failed++; continue; }
      const data = await r.json();
      if (data.result_code === "done") { saved++; } else { failed++; }
    } catch (e) {
      console.error("[tag-gov] retag re-save failed:", post.href, e);
      failed++;
    }
  }
  if (onProgress) onProgress(posts.length, posts.length);
  return { total: posts.length, saved, failed, skipped, aborted: false };
}

async function runTagGovOps(ops) {
  if (!ops || ops.length === 0) return { ok: 0, fail: 0, aborted: false };
  const token = await getTagGovToken();
  if (!token) {
    const pt = $id("tag-gov-progress-text");
    const pg = $id("tag-gov-progress");
    if (pg) pg.classList.remove("hidden");
    if (pt) pt.textContent = t("pinboardErrorAuth");
    return { ok: 0, fail: ops.length, aborted: false };
  }

  const progress = $id("tag-gov-progress");
  const fill = $id("tag-gov-progress-fill");
  const ptext = $id("tag-gov-progress-text");
  if (progress) progress.classList.remove("hidden");

  let ok = 0, fail = 0, aborted = false, skippedTotal = 0;
  const enc = encodeURIComponent;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const pct = Math.round(((i + 1) / ops.length) * 100);
    if (fill) fill.style.width = pct + "%";
    const opLine =
      (i + 1) + "/" + ops.length + " " +
      "<span class=\"status-ic ok\">" + PBP_ICONS.check + "</span>" + ok + " " +
      "<span class=\"status-ic bad\">" + PBP_ICONS.cross + "</span>" + fail;
    if (ptext) ptext.innerHTML = opLine;

    if (op.op === "rename") {
      // tags/rename is broken server-side -- re-tag each bookmark instead (see helper above).
      try {
        const res = await retagBookmarksViaResave(token, op.old, op.new, (done, total) => {
          if (ptext && total > 0) {
            ptext.innerHTML = opLine + " " + t("tagGovRetagProgress", String(done), String(total));
          }
        });
        if (res.aborted) {
          aborted = true;
          break;
        }
        skippedTotal += res.skipped;
        if (res.failed === 0 && res.skipped === 0) {
          ok++;
        } else {
          fail++;
        }
      } catch (e) {
        console.error("[tag-gov] op failed:", op, e);
        fail++;
      }
      continue;
    }

    if (op.op !== "delete") {
      fail++;
      continue;
    }
    const opUrl = `https://api.pinboard.in/v1/tags/delete?tag=${enc(op.tag)}&auth_token=${enc(token)}&format=json`;

    try {
      let resp = await pinboardFetch(opUrl);
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, TAG_GOV_RETRY_WAIT_MS));
        resp = await pinboardFetch(opUrl);
        if (resp.status === 429) {
          aborted = true;
          break;
        }
      }
      if (!resp.ok) {
        fail++;
        continue;
      }
      const data = await resp.json();
      if (data.result === "done") {
        ok++;
      } else {
        fail++;
      }
    } catch (e) {
      console.error("[tag-gov] op failed:", op, e);
      fail++;
    }
  }

  if (ptext) {
    if (aborted) {
      ptext.textContent = t("tagGovAborted429");
    } else {
      ptext.textContent = t("tagGovDoneSummary", String(ok), String(fail))
        + (skippedTotal > 0 ? " · " + t("tagGovSkippedSummary", String(skippedTotal)) : "");
    }
  }

  try { await chrome.storage.local.remove("cached_user_tags"); } catch (_) {}
  const fresh = await loadTagCounts(true);
  if (fresh) updateTagGovOverview(fresh);
  await renderTagGov();
  await renderLowCountTags();

  return { ok, fail, aborted };
}

async function loadTagCounts(forceFresh = false) {
  try {
    if (!forceFresh) {
      const cached = await chrome.storage.local.get({ cached_user_tags: null });
      if (cached.cached_user_tags) {
        const { counts, timestamp } = cached.cached_user_tags;
        if (Date.now() - timestamp < TAG_CACHE_TTL) {
          return counts || null;
        }
      }
    }
    const token = await getTagGovToken();
    if (!token) return null;
    const resp = await pinboardFetch(
      `https://api.pinboard.in/v1/tags/get?auth_token=${encodeURIComponent(token)}&format=json`
    );
    if (!resp || !resp.ok) return null;
    const counts = await resp.json();
    if (!counts || typeof counts !== "object") return null;
    await chrome.storage.local.set({
      cached_user_tags: { counts, timestamp: Date.now() }
    });
    return counts;
  } catch (e) {
    console.error("[tag-gov] loadTagCounts failed:", e);
    return null;
  }
}

async function renderTagGov() {
  const container = $id("tag-gov-groups");
  if (!container) return;

  container.replaceChildren();

  const stored = await chrome.storage.local.get({
    cached_user_tags: null,
    _tagGovIgnored: [],
    _tagGovAiGroups: { groups: [] }
  });
  const tagCounts = stored.cached_user_tags && stored.cached_user_tags.counts;

  if (!tagCounts) {
    const empty = document.createElement("div");
    empty.className = "fg";
    empty.textContent = t("tagGovNoGroups");
    container.appendChild(empty);
    return;
  }

  const ignoredList = stored._tagGovIgnored || [];
  const aiGroups = (stored._tagGovAiGroups && stored._tagGovAiGroups.groups) || [];

  let allGroups = pbpTagGovFindGroups(tagCounts);
  allGroups = allGroups.concat(aiGroups);
  allGroups = allGroups.filter(g => !ignoredList.includes(g.id));

  if (!allGroups.length) {
    const empty = document.createElement("div");
    empty.className = "fg";
    empty.textContent = t("tagGovNoGroups");
    container.appendChild(empty);
    return;
  }

  for (const group of allGroups) {
    const row = document.createElement("div");
    row.className = "tag-gov-group-row";

    const badge = document.createElement("span");
    badge.className = "tag-gov-kind-badge";
    const kindKey = group.kind === "plural" ? "tagGovKindPlural"
      : group.kind === "separator" ? "tagGovKindSeparator"
      : group.kind === "typo" ? "tagGovKindTypo"
      : "tagGovKindAi";
    badge.textContent = t(kindKey);
    row.appendChild(badge);

    const membersList = document.createElement("div");
    membersList.className = "tag-gov-members";
    for (const member of group.members) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "group-" + group.id;
      radio.value = member.tag;
      radio.defaultChecked = (member.tag === group.suggestedCanonical);
      label.appendChild(radio);
      const text = document.createElement("span");
      text.textContent = " " + member.tag + " (" + member.count + ")";
      label.appendChild(text);
      membersList.appendChild(label);
    }
    row.appendChild(membersList);

    if (group.kind === "ai" && group.reason) {
      const reason = document.createElement("small");
      reason.className = "tag-gov-reason";
      reason.textContent = group.reason;
      row.appendChild(reason);
    }

    const btnGroup = document.createElement("div");
    btnGroup.className = "tag-gov-actions";

    const mergeBtn = document.createElement("button");
    mergeBtn.className = "btn btn-sm";
    mergeBtn.textContent = t("tagGovMerge");
    mergeBtn.addEventListener("click", () => {
      const selected = row.querySelector("input[type=\"radio\"]:checked");
      const canonical = selected ? selected.value : group.suggestedCanonical;
      if (typeof confirmMergeGroup === "function") confirmMergeGroup(group, canonical, mergeBtn);
    });
    btnGroup.appendChild(mergeBtn);

    const ignoreBtn = document.createElement("button");
    ignoreBtn.className = "btn btn-sm";
    ignoreBtn.textContent = t("tagGovIgnore");
    ignoreBtn.addEventListener("click", async () => {
      const result2 = await chrome.storage.local.get({ _tagGovIgnored: [] });
      const list = result2._tagGovIgnored || [];
      if (!list.includes(group.id)) {
        list.push(group.id);
        await chrome.storage.local.set({ _tagGovIgnored: list });
        await renderTagGov();
      }
    });
    btnGroup.appendChild(ignoreBtn);

    row.appendChild(btnGroup);
    container.appendChild(row);
  }
}

async function renderLowCountTags() {
  const listContainer = $id("tag-gov-lowcount-list");
  if (!listContainer) return;
  listContainer.replaceChildren();

  const cached = await chrome.storage.local.get({ cached_user_tags: null });
  const counts = cached.cached_user_tags && cached.cached_user_tags.counts;
  if (!counts) return;

  const lowCount = pbpTagGovLowCountTags(counts, 1);
  if (!lowCount.length) {
    const empty = document.createElement("div");
    empty.textContent = t("tagGovNoLowCount");
    listContainer.appendChild(empty);
    return;
  }

  const table = document.createElement("div");
  table.className = "tag-gov-lowcount-table";
  for (const item of lowCount) {
    const row = document.createElement("div");
    row.className = "tag-gov-lowcount-row";
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "tag-gov-lowcount-checkbox";
    checkbox.value = item.tag;
    label.appendChild(checkbox);
    const text = document.createElement("span");
    text.textContent = " " + item.tag + " (" + item.count + ")";
    label.appendChild(text);
    row.appendChild(label);
    table.appendChild(row);
  }
  listContainer.appendChild(table);

  const summary = $id("tag-gov-lowcount")?.querySelector("summary");
  if (summary) summary.textContent = t("tagGovLowCountTitle") + " (" + lowCount.length + ")";

  const selectAll = $id("tag-gov-select-all");
  if (selectAll) {
    selectAll.checked = false;
    selectAll.onchange = () => {
      listContainer.querySelectorAll(".tag-gov-lowcount-checkbox")
        .forEach(cb => { cb.checked = selectAll.checked; });
    };
  }
}

// ---- Wayback Log Viewer ----
// Map a raw wayback outcome detail to an i18n explanation key, or null for unknown.
function waybackErrorKey(detail) {
  const d = String(detail || "").toLowerCase();
  if (!d) return null;
  if (d.includes("401") || d.includes("unauthorized")) return "archiveErrAuth";
  if (d.includes("failed to fetch") || d.includes("network")) return "archiveErrNetwork";
  if (d.includes("too-many-daily-captures")) return "archiveErrDailyLimit";
  if (d.includes("blocked")) return "archiveErrBlocked";
  if (d.includes("no-access") || d.includes("403")) return "archiveErrNoAccess";
  if (d.includes("not-found") || d.includes("404")) return "archiveErrNotFound";
  if (/http-5\d\d/.test(d) || d.includes("internal-server-error") || d.includes("service-unavailable") || d.includes("gateway") || d.includes("celery") || d.includes("job-failed") || d.includes("no-browsers")) return "archiveErrServer";
  return null;
}

async function renderWaybackLog() {
  const container = $id("wayback-log");
  if (!container) return;

  container.replaceChildren();

  let log = [];
  try {
    const data = await chrome.storage.local.get({ _waybackLog: [] });
    log = Array.isArray(data._waybackLog) ? data._waybackLog : [];
  } catch (_) {
    log = [];
  }

  if (!log.length) {
    const empty = document.createElement("div");
    empty.className = "wayback-log-empty";
    empty.textContent = t("archiveLogEmpty");
    container.appendChild(empty);
    return;
  }

  const reversed = [...log].reverse();

  function buildRow(entry) {
    const row = document.createElement("div");
    row.className = "wayback-log-row";

    const urlEl = document.createElement("a");
    urlEl.className = "wayback-log-url";
    let urlText = "";
    try { urlText = entry.url || ""; } catch (_) { urlText = ""; }
    urlEl.title = urlText;
    if (urlText) {
      urlEl.href = "https://web.archive.org/web/*/" + urlText;
      urlEl.target = "_blank";
      urlEl.rel = "noopener";
    }
    const urlTextSpan = document.createElement("span");
    urlTextSpan.className = "wayback-log-url-text";
    urlTextSpan.textContent = urlText;
    urlEl.appendChild(urlTextSpan);
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "ext-icon");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M5 1h6v6M11 1L6 6M9 7v3H2V3h3");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.3");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    urlEl.appendChild(svg);

    const timeEl = document.createElement("span");
    timeEl.className = "wayback-log-time";
    timeEl.textContent = _waybackRelTime(entry.ts);

    const outcomeEl = document.createElement("span");
    outcomeEl.className = "wayback-log-outcome";
    const outcome = (typeof entry.outcome === "string") ? entry.outcome : "";
    let outcomeText;
    let showRetry = false;
    if (outcome === "requested") {
      outcomeText = t("archiveOutcomeRequested");
    } else if (outcome.startsWith("job:")) {
      outcomeText = t("archiveOutcomeRequested");
      outcomeEl.title = outcome;
    } else if (outcome === "skipped") {
      outcomeText = t("archiveOutcomeSkipped");
    } else if (outcome === "rate-limited") {
      outcomeText = t("archiveOutcomeRateLimited");
      outcomeEl.title = t("archiveErrRateLimited");
      showRetry = true;
    } else if (outcome === "timeout") {
      outcomeText = t("archiveOutcomeTimeout");
      outcomeEl.title = t("archiveErrTimeoutHint");
      showRetry = true;
    } else if (outcome.startsWith("error")) {
      const detail = outcome.startsWith("error:") ? outcome.slice(6) : "";
      const errKey = waybackErrorKey(detail);
      outcomeText = errKey
        ? t("archiveOutcomeError") + " · " + t(errKey)
        : (detail ? t("archiveOutcomeError") + " · " + detail.slice(0, 48) : t("archiveOutcomeError"));
      outcomeEl.title = outcome;
      showRetry = true;
    } else {
      outcomeText = outcome;
    }
    outcomeEl.textContent = outcomeText;

    row.appendChild(urlEl);
    row.appendChild(timeEl);
    row.appendChild(outcomeEl);

    if (showRetry && entry.url) {
      const btn = document.createElement("button");
      btn.className = "wayback-log-retry";
      btn.title = t("archiveRetry");
      btn.setAttribute("aria-label", t("archiveRetry"));
      btn.innerHTML = PBP_ICONS.refresh;
      btn.addEventListener("click", () => {
        btn.disabled = true;
        try { chrome.runtime.sendMessage({ type: "archive_url", url: entry.url, force: true }).catch(() => {}); } catch (_) {}
        setTimeout(() => { renderWaybackLog(); }, 2500);
      });
      row.appendChild(btn);
    }

    return row;
  }

  const visible = reversed.slice(0, 10);
  const rest = reversed.slice(10);

  for (const entry of visible) {
    container.appendChild(buildRow(entry));
  }

  if (rest.length > 0) {
    const details = document.createElement("details");
    details.className = "wayback-log-more";
    const summary = document.createElement("summary");
    summary.textContent = t("archiveLogMore", String(rest.length));
    details.appendChild(summary);
    for (const entry of rest) {
      details.appendChild(buildRow(entry));
    }
    container.appendChild(details);
  }
}

function _waybackRelTime(ts) {
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
