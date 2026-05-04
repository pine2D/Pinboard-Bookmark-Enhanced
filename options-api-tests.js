// ============================================================
// Options page — API connectivity tests (AI providers + Pinboard token).
// Exposes setupApiTests(); options.js calls it after DOMContentLoaded.
//
// Self-contained: depends only on globals (callAI, hasAIKey, t, $id, chrome).
// ============================================================

function setupApiTests() {
  function getOptVal(id, fallback) { return $id(id)?.value?.trim() || fallback || ""; }

  async function testAIProvider(provider) {
    const statusEl = $id(`test-${provider}-status`);
    if (!statusEl) return;
    statusEl.textContent = t("testTesting");
    statusEl.style.color = "#888";

    const cs = {
      aiProvider: provider,
      geminiApiKey: getOptVal("opt-gemini-key"), geminiModel: getOptVal("opt-gemini-model", "gemini-2.5-flash-lite"),
      openaiApiKey: getOptVal("opt-openai-key"), openaiModel: getOptVal("opt-openai-model", "gpt-4.1-nano"), openaiBaseUrl: getOptVal("opt-openai-baseurl", "https://api.openai.com/v1"),
      claudeApiKey: getOptVal("opt-claude-key"), claudeModel: getOptVal("opt-claude-model", "claude-haiku-4-5-20251001"),
      deepseekApiKey: getOptVal("opt-deepseek-key"), deepseekModel: getOptVal("opt-deepseek-model", "deepseek-chat"),
      qwenApiKey: getOptVal("opt-qwen-key"), qwenModel: getOptVal("opt-qwen-model", "qwen-flash"),
      minimaxApiKey: getOptVal("opt-minimax-key"), minimaxModel: getOptVal("opt-minimax-model", "MiniMax-Text-01"),
      openrouterApiKey: getOptVal("opt-openrouter-key"), openrouterModel: getOptVal("opt-openrouter-model", "meta-llama/llama-4-scout:free"),
      ollamaBaseUrl: getOptVal("opt-ollama-baseurl", "http://localhost:11434"), ollamaModel: getOptVal("opt-ollama-model", "llama3"),
      groqApiKey: getOptVal("opt-groq-key"), groqModel: getOptVal("opt-groq-model", "meta-llama/llama-4-scout-17b-16e-instruct"),
      mistralApiKey: getOptVal("opt-mistral-key"), mistralModel: getOptVal("opt-mistral-model", "mistral-small-latest"),
      cohereApiKey: getOptVal("opt-cohere-key"), cohereModel: getOptVal("opt-cohere-model", "command-r-08-2024"),
      siliconflowApiKey: getOptVal("opt-siliconflow-key"), siliconflowModel: getOptVal("opt-siliconflow-model", "Qwen/Qwen3-8B"),
      zhipuApiKey: getOptVal("opt-zhipu-key"), zhipuModel: getOptVal("opt-zhipu-model", "glm-4.7-flash"),
      kimiApiKey: getOptVal("opt-kimi-key"), kimiModel: getOptVal("opt-kimi-model", "kimi-k2.5"),
      customApiKey: getOptVal("opt-custom-key"), customModel: getOptVal("opt-custom-model"), customBaseUrl: getOptVal("opt-custom-baseurl"),
    };

    try {
      if (!hasAIKey(cs)) throw new Error(t("testNoApiKey"));
      const result = await callAI(cs, "Reply with just the word: OK");

      statusEl.textContent = t("testConnected", (result || "OK").substring(0, 20));
      statusEl.style.color = "#080";
      setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 4000);
    } catch (err) {
      const msg = err.name === "AbortError" ? t("testTimeout") : err.message;
      statusEl.textContent = `✗ ${msg}`;
      statusEl.style.color = "#c00";
      setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 5000);
    }
  }

  ["gemini","openai","claude","deepseek","qwen","minimax","openrouter","groq","mistral","cohere","siliconflow","zhipu","kimi","ollama","custom"].forEach(p => {
    $id(`test-${p}`)?.addEventListener("click", () => testAIProvider(p));
  });

  // ---- Pinboard token: real-time format validation ----
  function isValidTokenFormat(token) {
    // Format: username:TOKEN — both parts non-empty, no spaces, token ≥ 8 chars
    if (!token) return null;
    const idx = token.indexOf(":");
    if (idx < 1) return false;
    const user = token.slice(0, idx);
    const key = token.slice(idx + 1);
    return user.length > 0 && key.length >= 8 && !/\s/.test(token);
  }

  const tokenInput = $id("opt-pinboard-token");
  const tokenWarn = $id("token-format-warn");
  function validateTokenField() {
    const val = tokenInput.value.trim();
    const valid = isValidTokenFormat(val);
    tokenWarn.classList.toggle("visible", valid === false);
  }
  tokenInput?.addEventListener("input", validateTokenField);
  tokenInput?.addEventListener("blur", validateTokenField);
  validateTokenField();

  // ---- Test Pinboard API token (via background to avoid native auth dialog) ----
  $id("test-pinboard-token")?.addEventListener("click", async () => {
    const btn = $id("test-pinboard-token");
    const statusEl = $id("test-pinboard-status");
    const token = tokenInput.value.trim();
    if (isValidTokenFormat(token) === false || !token) {
      statusEl.textContent = `✗ ${t("loginInvalidFormat")}`;
      statusEl.style.color = "#c00";
      setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 4000);
      return;
    }
    btn.disabled = true;
    statusEl.textContent = t("testTesting");
    statusEl.style.color = "";
    try {
      const resp = await chrome.runtime.sendMessage({ type: "test_pinboard_token", token });
      if (resp?.ok) {
        statusEl.textContent = t("testConnected", token.split(":")[0]);
        statusEl.style.color = "#080";
      } else if (resp?.error === "timeout") {
        statusEl.textContent = `✗ ${t("testTimeout")}`;
        statusEl.style.color = "#c00";
      } else if (resp?.error === "network") {
        statusEl.textContent = `✗ ${t("networkError")}`;
        statusEl.style.color = "#c00";
      } else {
        statusEl.textContent = `✗ ${t("loginFailed")}`;
        statusEl.style.color = "#c00";
      }
    } catch (_) {
      statusEl.textContent = `✗ ${t("networkError")}`;
      statusEl.style.color = "#c00";
    } finally {
      btn.disabled = false;
      setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 5000);
    }
  });
}
