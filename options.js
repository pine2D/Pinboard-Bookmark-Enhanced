document.addEventListener("DOMContentLoaded", async () => {
  await initI18n();
  applyI18n();
  // Fade in after i18n applied (prevents flash of untranslated/unstyled content)
  document.body.style.transition = "opacity 0.18s";
  document.body.style.opacity = "1";

  // ---- Tab switching ----
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $id(`panel-${btn.dataset.panel}`).classList.add("active");
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
        "opt-check-bookmark-status": true, "opt-auto-close": true, "offline-queue-enabled": true,
        "opt-show-search": false, "opt-show-recent": false, "opt-show-badge": false,
        "opt-show-ai-summary": true, "opt-show-ai-tags": true,
        "opt-show-quick-links": true, "opt-show-quick-row": true,
        "notify-quick-save": true, "notify-read-later": true, "notify-tab-set": true,
        "notify-batch-save": true, "notify-errors": true
      },
      skip: ["opt-pinboard-token", "opt-sync-enabled"] // never reset token or sync toggle
    },
    bookmarks: {
      fields: {
        "opt-private-default": false, "opt-private-incognito": true, "opt-readlater-default": false,
        "opt-auto-description": true, "opt-blockquote": true, "opt-include-referrer": false,
        "opt-respect-tag-case": true, "opt-show-suggest-tags": true, "opt-tag-presets": ""
      }
    },
    ai: {
      fields: {
        "opt-ai-provider": "gemini", "opt-ai-summary-lang": "auto", "opt-ai-cache-duration": "60",
        "opt-ai-auto-tags": false, "opt-ai-tag-separator": "-",
        "opt-custom-tag-prompt": "", "opt-custom-summary-prompt": "",
        "opt-gemini-model": "gemini-2.5-flash-lite", "opt-openai-model": "gpt-4.1-nano",
        "opt-openai-baseurl": "https://api.openai.com/v1", "opt-claude-model": "claude-haiku-4-5-20251001",
        "opt-deepseek-model": "deepseek-chat", "opt-qwen-model": "qwen-flash",
        "opt-minimax-model": "MiniMax-Text-01", "opt-openrouter-model": "meta-llama/llama-4-scout:free",
        "opt-groq-model": "meta-llama/llama-4-scout-17b-16e-instruct", "opt-mistral-model": "mistral-small-latest",
        "opt-cohere-model": "command-r-08-2024", "opt-siliconflow-model": "Qwen/Qwen3-8B",
        "opt-zhipu-model": "glm-4.7-flash", "opt-kimi-model": "kimi-k2.5",
        "opt-ollama-baseurl": "http://localhost:11434", "opt-ollama-model": "llama3",
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
    appearance: {
      fields: {
        "opt-theme": "auto", "opt-popup-follow-theme": true, "opt-custom-font": ""
      }
    }
  };

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
  document.querySelectorAll(".key-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = $id(btn.dataset.target);
      if (input) {
        const isPassword = input.type === "password";
        input.type = isPassword ? "text" : "password";
        btn.textContent = isPassword ? "🔒" : "👁";
      }
    });
  });

  // ---- All settings with defaults (from shared.js) ----
  const s = await (await getSettingsStorage()).get(SETTINGS_DEFAULTS);
  deobfuscateSettings(s);

  // ---- Schema v2 migration: split customCSS into themePresetKey + customOverlayCSS ----
  // Runs once per profile. Cleared sync.customCSS chunks; saves diff in local for 7-day undo.
  const OVERLAY_BYTE_LIMIT = 50 * 1024;
  const MIGRATION_BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  let migrationResult = null; // { savedBytes, banner } or null

  // Sweep expired migration backup (older than 7 days) — frees local storage
  {
    const stored = await chrome.storage.local.get({ _migrationBackup: null });
    if (stored._migrationBackup && stored._migrationBackup.ts) {
      if (Date.now() - stored._migrationBackup.ts > MIGRATION_BACKUP_TTL_MS) {
        await chrome.storage.local.remove("_migrationBackup");
      }
    }
  }

  {
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
        // 7-day undo backup
        await chrome.storage.local.set({
          _migrationBackup: { ts: Date.now(), oldCSS, oldKey: oldKeyForMigration }
        });
        await chrome.storage.sync.set({ _migrationV2: true });
        migrationResult = {
          savedBytes: oldCSS.length - newOverlay.length,
          banner: true
        };
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
    "opt-tag-presets": s.tagPresets
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
    "opt-popup-follow-theme": s.optPopupFollowTheme
  };
  for (const [id, val] of Object.entries(checkMap)) {
    const el = $id(id);
    if (el) el.checked = val;
  }

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

  // Render migration banner if migration just ran AND user hasn't dismissed.
  if (migrationResult && migrationResult.banner) {
    const dismissed = (await chrome.storage.local.get({ _migrationBannerDismissed: false }))._migrationBannerDismissed;
    if (!dismissed) renderMigrationBanner(migrationResult.savedBytes);
  }

  function renderMigrationBanner(savedBytes) {
    const host = $id("migration-banner");
    if (!host) return;
    host.style.display = "";
    while (host.firstChild) host.removeChild(host.firstChild);
    const title = document.createElement("strong");
    title.textContent = t("migrationBannerTitle") || "Theme storage upgraded to v2";
    const desc = document.createElement("p");
    const savedKB = (savedBytes / 1024).toFixed(1);
    const tmpl = t("migrationBannerDetails") || "Saved about {bytes} of sync space; preset CSS no longer counts against your Google sync quota.";
    desc.textContent = tmpl.replace("{bytes}", `${savedKB} KB`);
    const actions = document.createElement("div");
    actions.className = "migration-banner-actions";
    const undoBtn = document.createElement("button");
    undoBtn.className = "btn btn-sm";
    undoBtn.textContent = t("migrationUndoBtn") || "Undo";
    undoBtn.addEventListener("click", async () => {
      const backup = (await chrome.storage.local.get({ _migrationBackup: null }))._migrationBackup;
      if (!backup || (Date.now() - backup.ts) > 7 * 24 * 60 * 60 * 1000) {
        undoBtn.disabled = true;
        undoBtn.title = t("migrationUndoExpired") || "Undo window has expired";
        return;
      }
      showConfirmPopover(undoBtn, {
        msg: t("migrationUndoConfirm") || "Restore old format? This rewrites the CSS back to sync storage.",
        yesText: t("confirm") || "Confirm",
        noText: t("cancel") || "Cancel",
        onConfirm: async () => {
          try {
            await syncSetLarge("customCSS", backup.oldCSS);
            const setOld = {};
            if (backup.oldKey !== undefined) setOld.themePresetKey = backup.oldKey;
            await chrome.storage.sync.set(setOld);
            await chrome.storage.sync.remove(["customOverlayCSS", "_migrationV2", "optOverlayInLocal"]);
            // Remove all customOverlayCSS_N chunks too
            const meta = await chrome.storage.sync.get("customOverlayCSS");
            if (meta.customOverlayCSS && meta.customOverlayCSS._chunks) {
              const chunks = Array.from({ length: meta.customOverlayCSS._chunks }, (_, i) => `customOverlayCSS_${i}`);
              await chrome.storage.sync.remove(chunks);
            }
            await chrome.storage.local.remove(["customOverlayCSS_localFallback", "_migrationBackup"]);
            location.reload();
          } catch (e) {
            console.error("[migrationV2] undo failed", e);
          }
        }
      });
    });
    const dismissBtn = document.createElement("button");
    dismissBtn.className = "btn btn-sm";
    dismissBtn.textContent = t("migrationDismissBtn") || "Got it";
    dismissBtn.addEventListener("click", async () => {
      await chrome.storage.local.set({ _migrationBannerDismissed: true });
      host.style.display = "none";
    });
    actions.append(undoBtn, dismissBtn);
    host.append(title, desc, actions);
  }
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
      openaiModel: $id("opt-openai-model").value.trim() || "gpt-4.1-nano",
      openaiBaseUrl: $id("opt-openai-baseurl").value.trim() || "https://api.openai.com/v1",
      claudeApiKey: obfuscateKey($id("opt-claude-key").value.trim()),
      claudeModel: $id("opt-claude-model").value.trim() || "claude-haiku-4-5-20251001",
      deepseekApiKey: obfuscateKey($id("opt-deepseek-key").value.trim()),
      deepseekModel: $id("opt-deepseek-model").value.trim() || "deepseek-chat",
      qwenApiKey: obfuscateKey($id("opt-qwen-key").value.trim()),
      qwenModel: $id("opt-qwen-model").value.trim() || "qwen-flash",
      minimaxApiKey: obfuscateKey($id("opt-minimax-key").value.trim()),
      minimaxModel: $id("opt-minimax-model").value.trim() || "MiniMax-Text-01",
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
      kimiModel: $id("opt-kimi-model").value.trim() || "kimi-k2.5",
      ollamaBaseUrl: $id("opt-ollama-baseurl").value.trim() || "http://localhost:11434",
      ollamaModel: $id("opt-ollama-model").value.trim() || "llama3",
      customName: $id("opt-custom-name").value.trim() || "Custom",
      customBaseUrl: $id("opt-custom-baseurl").value.trim(),
      customApiKey: obfuscateKey($id("opt-custom-key").value.trim()),
      customModel: $id("opt-custom-model").value.trim(),
      // AI Behavior & Prompts
      optAiAutoTags: $id("opt-ai-auto-tags").checked,
      aiTagLang: $id("opt-ai-tag-lang").value,
      aiSummaryLang: $id("opt-ai-summary-lang").value,
      aiCacheDuration: Math.max(0, parseInt($id("opt-ai-cache-duration").value) || 60),
      aiTagSeparator: $id("opt-ai-tag-separator").value,
      aiContentSource: document.querySelector('input[name="ai-content-source"]:checked')?.value || "local",
      tagSyncMode: document.querySelector('input[name="tag-sync-mode"]:checked')?.value || "cached",
      jinaApiKey: obfuscateKey($id("opt-jina-key").value.trim()),
      customTagPrompt: $id("opt-custom-tag-prompt").value,
      customSummaryPrompt: $id("opt-custom-summary-prompt").value,
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
      tagPresets: $id("opt-tag-presets").value,
      themePresetKey: currentPresetKey
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

  function flashAutoSave() {
    const el = $id("auto-save-status");
    el.textContent = t("optAutoSaved");
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
  renderPresetPreview();

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
});
