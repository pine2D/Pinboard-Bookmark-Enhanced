document.addEventListener("DOMContentLoaded", async () => {
  // ---- Tab switching ----
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`panel-${btn.dataset.panel}`).classList.add("active");
    });
  });

  // ---- Load all settings ----
  const s = await chrome.storage.sync.get({
    pinboardToken: "",
    aiProvider: "gemini",
    geminiApiKey: "",
    geminiModel: "gemini-2.0-flash",
    openaiApiKey: "",
    openaiModel: "gpt-4o-mini",
    openaiBaseUrl: "https://api.openai.com/v1",
    claudeApiKey: "",
    claudeModel: "claude-sonnet-4-20250514",
    deepseekApiKey: "",
    deepseekModel: "deepseek-chat",
    qwenApiKey: "",
    qwenModel: "qwen-turbo",
    minimaxApiKey: "",
    minimaxModel: "MiniMax-Text-01",
    openrouterApiKey: "",
    openrouterModel: "google/gemini-2.0-flash-exp:free",
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "llama3",
    customApiKey: "",
    customModel: "",
    customBaseUrl: "",
    customName: "Custom",
    aiSummaryLang: "auto",
    aiCacheDuration: 60,
    customTagPrompt: "",
    customSummaryPrompt: "",
    // Bookmarks tab
    optPrivateDefault: false,
    optPrivateIncognito: false,
    optReadlaterDefault: false,
    optAutoDescription: true,
    optBlockquote: true,
    optIncludeReferrer: true,
    // AI tab
    optAiAutoTags: false,
    // Quick Actions - Context Menu
    ctxAutoNotes: true,
    ctxBlockquote: true,
    ctxDefaultTags: "",
    ctxAiTags: false,
    ctxAiSummary: false,
    // Quick Actions - Quick Save
    qsAutoNotes: true,
    qsBlockquote: true,
    qsDefaultTags: "",
    qsAiTags: false,
    qsAiSummary: false,
    // Quick Actions - Batch Save
    optBatchTagEnabled: true,
    optBatchTag: "batch_saved",
    // Appearance
    optShowRecent: true,
    optShowSearch: true,
    optTheme: "auto",
    // Notifications
    notifyContextMenu: true,
    notifyQuickSave: true,
    notifyTabSet: true,
    notifyBatchSave: true,
    notifyErrors: true
  });

  // Deobfuscate API keys for display
  const keyFields = ["pinboardToken","geminiApiKey","openaiApiKey","claudeApiKey","deepseekApiKey","qwenApiKey","minimaxApiKey","openrouterApiKey","customApiKey"];
  keyFields.forEach(k => { if (s[k]) s[k] = deobfuscateKey(s[k]); });

  // ---- Fill text/password/select fields ----
  const fieldMap = {
    "opt-pinboard-token": s.pinboardToken,
    "opt-ai-provider": s.aiProvider,
    "opt-gemini-key": s.geminiApiKey,
    "opt-gemini-model": s.geminiModel,
    "opt-openai-key": s.openaiApiKey,
    "opt-openai-model": s.openaiModel,
    "opt-openai-baseurl": s.openaiBaseUrl,
    "opt-claude-key": s.claudeApiKey,
    "opt-claude-model": s.claudeModel,
    "opt-deepseek-key": s.deepseekApiKey,
    "opt-deepseek-model": s.deepseekModel,
    "opt-qwen-key": s.qwenApiKey,
    "opt-qwen-model": s.qwenModel,
    "opt-minimax-key": s.minimaxApiKey,
    "opt-minimax-model": s.minimaxModel,
    "opt-openrouter-key": s.openrouterApiKey,
    "opt-openrouter-model": s.openrouterModel,
    "opt-ollama-baseurl": s.ollamaBaseUrl,
    "opt-ollama-model": s.ollamaModel,
    "opt-custom-name": s.customName,
    "opt-custom-baseurl": s.customBaseUrl,
    "opt-custom-key": s.customApiKey,
    "opt-custom-model": s.customModel,
    "opt-ai-summary-lang": s.aiSummaryLang,
    "opt-ai-cache-duration": s.aiCacheDuration,
    "opt-custom-tag-prompt": s.customTagPrompt,
    "opt-custom-summary-prompt": s.customSummaryPrompt,
    "opt-batch-tag": s.optBatchTag,
    "opt-theme": s.optTheme,
    "ctx-default-tags": s.ctxDefaultTags,
    "qs-default-tags": s.qsDefaultTags
  };

  for (const [id, val] of Object.entries(fieldMap)) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }

  // ---- Fill checkbox fields ----
  const checkMap = {
    // Bookmarks tab
    "opt-private-default": s.optPrivateDefault,
    "opt-private-incognito": s.optPrivateIncognito,
    "opt-readlater-default": s.optReadlaterDefault,
    "opt-auto-description": s.optAutoDescription,
    "opt-blockquote": s.optBlockquote,
    "opt-include-referrer": s.optIncludeReferrer,
    // AI tab
    "opt-ai-auto-tags": s.optAiAutoTags,
    // Quick Actions - Context Menu
    "ctx-auto-notes": s.ctxAutoNotes,
    "ctx-blockquote": s.ctxBlockquote,
    "ctx-ai-tags": s.ctxAiTags,
    "ctx-ai-summary": s.ctxAiSummary,
    // Quick Actions - Quick Save
    "qs-auto-notes": s.qsAutoNotes,
    "qs-blockquote": s.qsBlockquote,
    "qs-ai-tags": s.qsAiTags,
    "qs-ai-summary": s.qsAiSummary,
    // Quick Actions - Batch Save
    "opt-batch-tag-enabled": s.optBatchTagEnabled,
    // Appearance
    "opt-show-recent": s.optShowRecent,
    "opt-show-search": s.optShowSearch,
    // Notifications
    "notify-context-menu": s.notifyContextMenu,
    "notify-quick-save": s.notifyQuickSave,
    "notify-tab-set": s.notifyTabSet,
    "notify-batch-save": s.notifyBatchSave,
    "notify-errors": s.notifyErrors
  };

  for (const [id, val] of Object.entries(checkMap)) {
    const el = document.getElementById(id);
    if (el) el.checked = val;
  }

  // ---- Provider field toggle ----
  const providers = ["gemini", "openai", "claude", "deepseek", "qwen", "minimax", "openrouter", "ollama", "custom"];

  function updateProviderFields() {
    const selected = document.getElementById("opt-ai-provider").value;
    providers.forEach((p) => {
      const el = document.getElementById("fields-" + p);
      if (el) {
        if (p === selected) {
          el.classList.remove("hidden");
        } else {
          el.classList.add("hidden");
        }
      }
    });
  }

  updateProviderFields();
  document.getElementById("opt-ai-provider").addEventListener("change", updateProviderFields);

  // ---- Reset prompt buttons ----
  document.getElementById("reset-tag-prompt").addEventListener("click", () => {
    document.getElementById("opt-custom-tag-prompt").value = DEFAULT_TAG_PROMPT;
  });

  document.getElementById("reset-summary-prompt").addEventListener("click", () => {
    document.getElementById("opt-custom-summary-prompt").value = DEFAULT_SUMMARY_PROMPT;
  });

  // ---- Save: Bookmarks ----
  document.getElementById("save-bookmarks").addEventListener("click", async () => {
    await chrome.storage.sync.set({
      optPrivateDefault: document.getElementById("opt-private-default").checked,
      optPrivateIncognito: document.getElementById("opt-private-incognito").checked,
      optReadlaterDefault: document.getElementById("opt-readlater-default").checked,
      optAutoDescription: document.getElementById("opt-auto-description").checked,
      optBlockquote: document.getElementById("opt-blockquote").checked,
      optIncludeReferrer: document.getElementById("opt-include-referrer").checked
    });
    flash("bookmarks-status");
  });

  // ---- Save: Quick Actions ----
  document.getElementById("save-quick").addEventListener("click", async () => {
    await chrome.storage.sync.set({
      ctxAutoNotes: document.getElementById("ctx-auto-notes").checked,
      ctxBlockquote: document.getElementById("ctx-blockquote").checked,
      ctxDefaultTags: document.getElementById("ctx-default-tags").value.trim(),
      ctxAiTags: document.getElementById("ctx-ai-tags").checked,
      ctxAiSummary: document.getElementById("ctx-ai-summary").checked,
      qsAutoNotes: document.getElementById("qs-auto-notes").checked,
      qsBlockquote: document.getElementById("qs-blockquote").checked,
      qsDefaultTags: document.getElementById("qs-default-tags").value.trim(),
      qsAiTags: document.getElementById("qs-ai-tags").checked,
      qsAiSummary: document.getElementById("qs-ai-summary").checked,
      optBatchTagEnabled: document.getElementById("opt-batch-tag-enabled").checked,
      optBatchTag: document.getElementById("opt-batch-tag").value.trim() || "batch_saved"
    });
    flash("quick-status");
  });

  // ---- Save: Provider & Keys ----
  document.getElementById("save-provider").addEventListener("click", async () => {
    await chrome.storage.sync.set({
      pinboardToken: obfuscateKey(document.getElementById("opt-pinboard-token").value.trim()),
      aiProvider: document.getElementById("opt-ai-provider").value,
      geminiApiKey: obfuscateKey(document.getElementById("opt-gemini-key").value.trim()),
      geminiModel: document.getElementById("opt-gemini-model").value.trim() || "gemini-2.0-flash",
      openaiApiKey: obfuscateKey(document.getElementById("opt-openai-key").value.trim()),
      openaiModel: document.getElementById("opt-openai-model").value.trim() || "gpt-4o-mini",
      openaiBaseUrl: document.getElementById("opt-openai-baseurl").value.trim() || "https://api.openai.com/v1",
      claudeApiKey: obfuscateKey(document.getElementById("opt-claude-key").value.trim()),
      claudeModel: document.getElementById("opt-claude-model").value.trim() || "claude-sonnet-4-20250514",
      deepseekApiKey: obfuscateKey(document.getElementById("opt-deepseek-key").value.trim()),
      deepseekModel: document.getElementById("opt-deepseek-model").value.trim() || "deepseek-chat",
      qwenApiKey: obfuscateKey(document.getElementById("opt-qwen-key").value.trim()),
      qwenModel: document.getElementById("opt-qwen-model").value.trim() || "qwen-turbo",
      minimaxApiKey: obfuscateKey(document.getElementById("opt-minimax-key").value.trim()),
      minimaxModel: document.getElementById("opt-minimax-model").value.trim() || "MiniMax-Text-01",
      openrouterApiKey: obfuscateKey(document.getElementById("opt-openrouter-key").value.trim()),
      openrouterModel: document.getElementById("opt-openrouter-model").value.trim() || "google/gemini-2.0-flash-exp:free",
      ollamaBaseUrl: document.getElementById("opt-ollama-baseurl").value.trim() || "http://localhost:11434",
      ollamaModel: document.getElementById("opt-ollama-model").value.trim() || "llama3",
      customName: document.getElementById("opt-custom-name").value.trim() || "Custom",
      customBaseUrl: document.getElementById("opt-custom-baseurl").value.trim(),
      customApiKey: obfuscateKey(document.getElementById("opt-custom-key").value.trim()),
      customModel: document.getElementById("opt-custom-model").value.trim()
    });
    flash("provider-status");
  });

  // ---- Save: AI Settings & Prompts ----
  document.getElementById("save-ai").addEventListener("click", async () => {
    await chrome.storage.sync.set({
      optAiAutoTags: document.getElementById("opt-ai-auto-tags").checked,
      aiSummaryLang: document.getElementById("opt-ai-summary-lang").value,
      aiCacheDuration: parseInt(document.getElementById("opt-ai-cache-duration").value) || 60,
      customTagPrompt: document.getElementById("opt-custom-tag-prompt").value,
      customSummaryPrompt: document.getElementById("opt-custom-summary-prompt").value
    });
    flash("ai-status");
  });

  // ---- Save: Appearance & Notifications ----
  document.getElementById("save-appearance").addEventListener("click", async () => {
    await chrome.storage.sync.set({
      optTheme: document.getElementById("opt-theme").value,
      optShowSearch: document.getElementById("opt-show-search").checked,
      optShowRecent: document.getElementById("opt-show-recent").checked,
      notifyContextMenu: document.getElementById("notify-context-menu").checked,
      notifyQuickSave: document.getElementById("notify-quick-save").checked,
      notifyTabSet: document.getElementById("notify-tab-set").checked,
      notifyBatchSave: document.getElementById("notify-batch-save").checked,
      notifyErrors: document.getElementById("notify-errors").checked
    });
    flash("appearance-status");
  });

  // ---- Export Settings ----
  document.getElementById("export-settings").addEventListener("click", async () => {
    const raw = await chrome.storage.sync.get(null);
    // Strip sensitive keys (API keys and tokens)
    const sensitiveKeys = ["pinboardToken","geminiApiKey","openaiApiKey","claudeApiKey","deepseekApiKey","qwenApiKey","minimaxApiKey","openrouterApiKey","customApiKey"];
    const exportData = Object.fromEntries(
      Object.entries(raw).filter(([k]) => !sensitiveKeys.includes(k))
    );
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "pinboard-settings.json"; a.click();
    URL.revokeObjectURL(url);
  });

  // ---- Import Settings ----
  document.getElementById("import-settings-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      // Only import non-sensitive keys
      const sensitiveKeys = ["pinboardToken","geminiApiKey","openaiApiKey","claudeApiKey","deepseekApiKey","qwenApiKey","minimaxApiKey","openrouterApiKey","customApiKey"];
      const safeData = Object.fromEntries(
        Object.entries(data).filter(([k]) => !sensitiveKeys.includes(k))
      );
      await chrome.storage.sync.set(safeData);
      const status = document.getElementById("import-status");
      status.textContent = "✓ Imported — reload to see changes";
      setTimeout(() => { status.textContent = ""; }, 3000);
    } catch (err) {
      const status = document.getElementById("import-status");
      status.textContent = "✗ Invalid file";
      status.style.color = "#c00";
      setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 3000);
    }
    e.target.value = "";
  });

  // ---- API Connectivity Tests ----
  async function testAIProvider(provider) {
    const statusEl = document.getElementById(`test-${provider}-status`);
    if (!statusEl) return;
    statusEl.textContent = "Testing...";
    statusEl.style.color = "#888";

    // Build a minimal settings object from current form values
    const currentSettings = {
      aiProvider: provider,
      geminiApiKey: document.getElementById("opt-gemini-key")?.value?.trim() || "",
      geminiModel: document.getElementById("opt-gemini-model")?.value?.trim() || "gemini-2.0-flash",
      openaiApiKey: document.getElementById("opt-openai-key")?.value?.trim() || "",
      openaiModel: document.getElementById("opt-openai-model")?.value?.trim() || "gpt-4o-mini",
      openaiBaseUrl: document.getElementById("opt-openai-baseurl")?.value?.trim() || "https://api.openai.com/v1",
      claudeApiKey: document.getElementById("opt-claude-key")?.value?.trim() || "",
      claudeModel: document.getElementById("opt-claude-model")?.value?.trim() || "claude-sonnet-4-20250514",
      deepseekApiKey: document.getElementById("opt-deepseek-key")?.value?.trim() || "",
      deepseekModel: document.getElementById("opt-deepseek-model")?.value?.trim() || "deepseek-chat",
      qwenApiKey: document.getElementById("opt-qwen-key")?.value?.trim() || "",
      qwenModel: document.getElementById("opt-qwen-model")?.value?.trim() || "qwen-turbo",
      minimaxApiKey: document.getElementById("opt-minimax-key")?.value?.trim() || "",
      minimaxModel: document.getElementById("opt-minimax-model")?.value?.trim() || "MiniMax-Text-01",
      openrouterApiKey: document.getElementById("opt-openrouter-key")?.value?.trim() || "",
      openrouterModel: document.getElementById("opt-openrouter-model")?.value?.trim() || "google/gemini-2.0-flash-exp:free",
      ollamaBaseUrl: document.getElementById("opt-ollama-baseurl")?.value?.trim() || "http://localhost:11434",
      ollamaModel: document.getElementById("opt-ollama-model")?.value?.trim() || "llama3",
      customApiKey: document.getElementById("opt-custom-key")?.value?.trim() || "",
      customModel: document.getElementById("opt-custom-model")?.value?.trim() || "",
      customBaseUrl: document.getElementById("opt-custom-baseurl")?.value?.trim() || "",
    };

    try {
      const testPrompt = "Reply with just the word: OK";
      let result = "";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);

      async function doFetch(url, options) {
        return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
      }

      if (provider === "gemini") {
        if (!currentSettings.geminiApiKey) throw new Error("No API key");
        const res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${currentSettings.geminiModel}:generateContent?key=${currentSettings.geminiApiKey}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: testPrompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 10 } })
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `HTTP ${res.status}`); }
        result = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "OK";
      } else if (provider === "claude") {
        if (!currentSettings.claudeApiKey) throw new Error("No API key");
        const res = await doFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": currentSettings.claudeApiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model: currentSettings.claudeModel, max_tokens: 10, messages: [{ role: "user", content: testPrompt }] })
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `HTTP ${res.status}`); }
        result = (await res.json()).content?.[0]?.text?.trim() || "OK";
      } else if (provider === "ollama") {
        const base = (currentSettings.ollamaBaseUrl || "http://localhost:11434").replace(/\/+$/, "");
        const res = await doFetch(`${base}/api/chat`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: currentSettings.ollamaModel, messages: [{ role: "user", content: testPrompt }], stream: false })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        result = (await res.json()).message?.content?.trim() || "OK";
      } else {
        // OpenAI-compatible: openai, deepseek, qwen, minimax, openrouter, custom
        const baseUrlMap = {
          openai: currentSettings.openaiBaseUrl || "https://api.openai.com/v1",
          deepseek: "https://api.deepseek.com/v1",
          qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          minimax: "https://api.minimax.chat/v1",
          openrouter: "https://openrouter.ai/api/v1",
          custom: currentSettings.customBaseUrl
        };
        const apiKeyMap = {
          openai: currentSettings.openaiApiKey,
          deepseek: currentSettings.deepseekApiKey,
          qwen: currentSettings.qwenApiKey,
          minimax: currentSettings.minimaxApiKey,
          openrouter: currentSettings.openrouterApiKey,
          custom: currentSettings.customApiKey
        };
        const modelMap = {
          openai: currentSettings.openaiModel,
          deepseek: currentSettings.deepseekModel,
          qwen: currentSettings.qwenModel,
          minimax: currentSettings.minimaxModel,
          openrouter: currentSettings.openrouterModel,
          custom: currentSettings.customModel
        };
        const baseUrl = baseUrlMap[provider];
        const apiKey = apiKeyMap[provider];
        const model = modelMap[provider];
        if (!baseUrl) throw new Error("No base URL configured");
        if (!apiKey && provider !== "custom") throw new Error("No API key");
        const headers = { "Content-Type": "application/json" };
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        const res = await doFetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST", headers,
          body: JSON.stringify({ model, messages: [{ role: "user", content: testPrompt }], temperature: 0, max_tokens: 10 })
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `HTTP ${res.status}`); }
        result = (await res.json()).choices?.[0]?.message?.content?.trim() || "OK";
      }

      statusEl.textContent = `✓ Connected (${result.substring(0, 20)})`;
      statusEl.style.color = "#080";
      setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 4000);
    } catch (err) {
      const msg = err.name === "AbortError" ? "Timeout (15s)" : err.message;
      statusEl.textContent = `✗ ${msg}`;
      statusEl.style.color = "#c00";
      setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 5000);
    }
  }

  const testBtns = ["gemini","openai","claude","deepseek","qwen","minimax","openrouter","ollama","custom"];
  testBtns.forEach(p => {
    document.getElementById(`test-${p}`)?.addEventListener("click", () => testAIProvider(p));
  });

  // ---- Chrome shortcuts link ----
  document.getElementById("open-shortcuts-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
});

function flash(id) {
  const el = document.getElementById(id);
  el.textContent = "✓ Saved";
  setTimeout(() => {
    el.textContent = "";
  }, 2000);
}
