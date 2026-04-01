const DEFAULT_TAG_PROMPT = `Suggest 5-10 bookmark tags for the following webpage. Tags should be lowercase, use hyphens for multi-word. Return ONLY a JSON array.

Title: {{title}}
URL: {{url}}
Content: {{content}}

Format: ["tag1","tag2"]`;

const DEFAULT_SUMMARY_PROMPT = `Summarize the following webpage concisely in 2-4 sentences. Focus on key points. {{lang_instruction}}

Title: {{title}}
Content: {{content}}`;

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
    optPrivateDefault: false,
    optPrivateIncognito: false,
    optReadlaterDefault: false,
    optBlockquote: true,
    optIncludeReferrer: true,
    optAiAutoTags: false
  });

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
    "opt-custom-summary-prompt": s.customSummaryPrompt
  };

  for (const [id, val] of Object.entries(fieldMap)) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }

  // ---- Fill checkbox fields ----
  const checkMap = {
    "opt-private-default": s.optPrivateDefault,
    "opt-private-incognito": s.optPrivateIncognito,
    "opt-readlater-default": s.optReadlaterDefault,
    "opt-blockquote": s.optBlockquote,
    "opt-include-referrer": s.optIncludeReferrer,
    "opt-ai-auto-tags": s.optAiAutoTags
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

  // ---- Save: General ----
  document.getElementById("save-general").addEventListener("click", async () => {
    await chrome.storage.sync.set({
      optPrivateDefault: document.getElementById("opt-private-default").checked,
      optPrivateIncognito: document.getElementById("opt-private-incognito").checked,
      optReadlaterDefault: document.getElementById("opt-readlater-default").checked,
      optBlockquote: document.getElementById("opt-blockquote").checked,
      optIncludeReferrer: document.getElementById("opt-include-referrer").checked
    });
    flash("general-status");
  });

  // ---- Save: API Keys ----
  document.getElementById("save-api").addEventListener("click", async () => {
    await chrome.storage.sync.set({
      pinboardToken: document.getElementById("opt-pinboard-token").value.trim(),
      aiProvider: document.getElementById("opt-ai-provider").value,
      geminiApiKey: document.getElementById("opt-gemini-key").value.trim(),
      geminiModel: document.getElementById("opt-gemini-model").value.trim() || "gemini-2.0-flash",
      openaiApiKey: document.getElementById("opt-openai-key").value.trim(),
      openaiModel: document.getElementById("opt-openai-model").value.trim() || "gpt-4o-mini",
      openaiBaseUrl: document.getElementById("opt-openai-baseurl").value.trim() || "https://api.openai.com/v1",
      claudeApiKey: document.getElementById("opt-claude-key").value.trim(),
      claudeModel: document.getElementById("opt-claude-model").value.trim() || "claude-sonnet-4-20250514",
      deepseekApiKey: document.getElementById("opt-deepseek-key").value.trim(),
      deepseekModel: document.getElementById("opt-deepseek-model").value.trim() || "deepseek-chat",
      qwenApiKey: document.getElementById("opt-qwen-key").value.trim(),
      qwenModel: document.getElementById("opt-qwen-model").value.trim() || "qwen-turbo",
      minimaxApiKey: document.getElementById("opt-minimax-key").value.trim(),
      minimaxModel: document.getElementById("opt-minimax-model").value.trim() || "MiniMax-Text-01",
      openrouterApiKey: document.getElementById("opt-openrouter-key").value.trim(),
      openrouterModel: document.getElementById("opt-openrouter-model").value.trim() || "google/gemini-2.0-flash-exp:free",
      ollamaBaseUrl: document.getElementById("opt-ollama-baseurl").value.trim() || "http://localhost:11434",
      ollamaModel: document.getElementById("opt-ollama-model").value.trim() || "llama3",
      customName: document.getElementById("opt-custom-name").value.trim() || "Custom",
      customBaseUrl: document.getElementById("opt-custom-baseurl").value.trim(),
      customApiKey: document.getElementById("opt-custom-key").value.trim(),
      customModel: document.getElementById("opt-custom-model").value.trim()
    });
    flash("api-status");
  });

  // ---- Save: AI Settings ----
  document.getElementById("save-ai").addEventListener("click", async () => {
    await chrome.storage.sync.set({
      optAiAutoTags: document.getElementById("opt-ai-auto-tags").checked,
      aiSummaryLang: document.getElementById("opt-ai-summary-lang").value,
      aiCacheDuration: parseInt(document.getElementById("opt-ai-cache-duration").value) || 60
    });
    flash("ai-status");
  });

  // ---- Save: Prompts ----
  document.getElementById("save-prompts").addEventListener("click", async () => {
    await chrome.storage.sync.set({
      customTagPrompt: document.getElementById("opt-custom-tag-prompt").value,
      customSummaryPrompt: document.getElementById("opt-custom-summary-prompt").value
    });
    flash("prompts-status");
  });
});

function flash(id) {
  const el = document.getElementById(id);
  el.textContent = "✓ Saved";
  setTimeout(() => {
    el.textContent = "";
  }, 2000);
}
