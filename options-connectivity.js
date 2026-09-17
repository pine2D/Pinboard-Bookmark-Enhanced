// ============================================================
// Options page — API connectivity tests (AI providers + Pinboard token).
// Exposes setupApiTests(); options.js calls it after DOMContentLoaded.
//
// Self-contained: depends only on globals (callAI, hasAIKey, t, $id, chrome).
// ============================================================

function pbpLiveAiSettingsSnapshot(provider) {
  function getOptVal(id, fallback) { return $id(id)?.value?.trim() || fallback || ""; }
  return {
    aiProvider: provider,
    geminiApiKey: getOptVal("opt-gemini-key"), geminiModel: getOptVal("opt-gemini-model", "gemini-3.5-flash-lite"),
    openaiApiKey: getOptVal("opt-openai-key"), openaiModel: getOptVal("opt-openai-model", "gpt-5.4-nano"), openaiBaseUrl: getOptVal("opt-openai-baseurl", "https://api.openai.com/v1"),
    claudeApiKey: getOptVal("opt-claude-key"), claudeModel: getOptVal("opt-claude-model", "claude-haiku-4-5"),
    deepseekApiKey: getOptVal("opt-deepseek-key"), deepseekModel: getOptVal("opt-deepseek-model", "deepseek-v4-flash"),
    qwenApiKey: getOptVal("opt-qwen-key"), qwenModel: getOptVal("opt-qwen-model", "qwen-flash"),
    minimaxApiKey: getOptVal("opt-minimax-key"), minimaxModel: getOptVal("opt-minimax-model", "MiniMax-M2"),
    openrouterApiKey: getOptVal("opt-openrouter-key"), openrouterModel: getOptVal("opt-openrouter-model", "openai/gpt-oss-20b"),
    ollamaBaseUrl: getOptVal("opt-ollama-baseurl", "http://localhost:11434"), ollamaModel: getOptVal("opt-ollama-model", "llama3.2"),
    groqApiKey: getOptVal("opt-groq-key"), groqModel: getOptVal("opt-groq-model", "openai/gpt-oss-20b"),
    mistralApiKey: getOptVal("opt-mistral-key"), mistralModel: getOptVal("opt-mistral-model", "mistral-small-latest"),
    cohereApiKey: getOptVal("opt-cohere-key"), cohereModel: getOptVal("opt-cohere-model", "command-r7b-12-2024"),
    siliconflowApiKey: getOptVal("opt-siliconflow-key"), siliconflowModel: getOptVal("opt-siliconflow-model", "Qwen/Qwen3-8B"),
    zhipuApiKey: getOptVal("opt-zhipu-key"), zhipuModel: getOptVal("opt-zhipu-model", "glm-4.7-flash"),
    kimiApiKey: getOptVal("opt-kimi-key"), kimiModel: getOptVal("opt-kimi-model", "kimi-k2.6"),
    customApiKey: getOptVal("opt-custom-key"), customModel: getOptVal("opt-custom-model"), customBaseUrl: getOptVal("opt-custom-baseurl"),
  };
}

function setupApiTests() {

  function recordHealth(id, ok, code) {
    if (typeof pbpRecordConnectionHealth !== "function") return;
    pbpRecordConnectionHealth(id, ok, code).catch((e) => {
      console.warn("[connection-health] record failed:", e?.name, e?.message);
    });
  }

  // State lives in classes only. An inline `style.color` outranks every themed
  // rule, so the old hardcoded #888/#080/#c00 stayed put on the dark presets --
  // #c00 measured 1.71:1 on Nord Night. .save-status.pending/.ok/.bad carry the
  // themed tokens instead; setStatusIcon() owns .ok/.bad, these own .pending
  // and .warn.
  function setStatusPending(statusEl, text) {
    if (!statusEl) return;
    statusEl.classList.remove("ok", "bad", "warn");
    statusEl.classList.add("pending");
    statusEl.textContent = text;
  }
  function setStatusResult(statusEl, ok, text) {
    if (!statusEl) return;
    statusEl.classList.remove("pending", "warn");
    setStatusIcon(statusEl, ok, text);
  }
  // A third tier beside the two setStatusIcon knows: the target itself answered,
  // but a setting that depends on it did not (K96 -- the Reader's per-provider
  // model override). .ok would put a green tick over the word "failed"; .bad
  // would paint "this API key is broken" over a provider that just replied.
  // Reuses the --opt-warn role the export targets' .et-test-status.warn already
  // carries, so no new colour enters the surface.
  function setStatusWarn(statusEl, text) {
    if (!statusEl) return;
    statusEl.classList.remove("pending", "ok", "bad");
    statusEl.classList.add("warn");
    const ic = document.createElement("span");
    ic.className = "status-ic warn";
    ic.innerHTML = PBP_ICONS.warning;
    statusEl.replaceChildren(ic, document.createTextNode(" " + (text != null ? String(text) : "")));
  }

  // Only a SUCCESSFUL result is wiped by a timer. A failure is the one line the
  // user has to read and usually copy -- the provider's own error body, the
  // model_not_found hint, the rejected origin -- so it stays on screen until the
  // next run for that target overwrites it (every run opens with
  // cancelStatusClear + setStatusPending, so failures replace, never pile up).
  // Held anonymously, a pending clear fires in the middle of the NEXT run for
  // the same target and erases a real result off screen; keyed by target, each
  // run cancels its predecessor's clear before scheduling its own.
  const _testClearTimers = new Map();
  function cancelStatusClear(key) {
    clearTimeout(_testClearTimers.get(key));
    _testClearTimers.delete(key);
  }
  function scheduleStatusClear(key, statusEl, ms) {
    cancelStatusClear(key);
    _testClearTimers.set(key, setTimeout(() => {
      _testClearTimers.delete(key);
      statusEl.textContent = "";
      statusEl.classList.remove("ok", "bad", "pending", "warn");
    }, ms));
  }

  async function testAIProvider(provider) {
    const statusEl = $id(`test-${provider}-status`);
    if (!statusEl) return;
    // The call underneath is an unbounded network request. Without this the
    // button stayed live throughout, so a second click started a concurrent run
    // against the same status element. Mirrors the Pinboard token test below.
    const btn = $id(`test-${provider}`);
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    cancelStatusClear(provider);
    try {
      setStatusPending(statusEl, t("testTesting"));

      const cs = pbpLiveAiSettingsSnapshot(provider);

      if (!hasAIKey(cs)) {
        setStatusResult(statusEl, false, t("testNoApiKey"));
        recordHealth(`ai:${provider}`, false, "missing_key");
        return;
      }

      // Test is a direct user gesture: request only this provider's exact origin before
      // calling it. Automatic/background paths stay contains-only and never prompt.
      let originPattern = null;
      let granted = false;
      try {
        originPattern = _aiTargetOriginPattern(cs);
        granted = await requestAIHostPermissions(cs);
      } catch (err) {
        console.warn("[connectivity] AI permission request failed:", err?.name, err?.message);
        setStatusResult(statusEl, false, err?.message || t("networkError"));
        recordHealth(`ai:${provider}`, false, "permission_error");
        return;
      }
      if (!granted) {
        setStatusResult(statusEl, false, t("aiErrorHostPermission", originPattern.replace(/\/\*$/, "")));
        recordHealth(`ai:${provider}`, false, "permission_denied");
        return;
      }

      try {
        const result = await callAI(cs, "Reply with just the word: OK");

        // Second leg (K96): the Reader's per-provider model override. The call
        // above used the provider's CONFIGURED model -- the one popup tags and
        // summaries, background quick-save, Batch and tag governance actually
        // send -- so it stays the subject of the green light and its request
        // shape is untouched. The override is an extra request with nothing but
        // opts.model changed; callAI's four branches all honour opts.model
        // (md-video.js does the same), so this needs no new machinery.
        //
        // Read off the VISIBLE field, not storage: pbpLiveAiSettingsSnapshot
        // above enumerates 15 providers' key/model/baseUrl and carries no
        // previewAiModel* key at all, while options.js's updateProviderFields ->
        // syncPreviewModelToProvider keeps #opt-preview-ai-model holding exactly
        // the SELECTED provider's entry (and writes that visible value back to
        // previewAiModelByProvider on submit). Hence the guard: the other
        // fourteen Test buttons must not borrow a model their provider was
        // never asked to serve.
        const ov = $id("opt-ai-provider")?.value === provider
          ? ($id("opt-preview-ai-model")?.value || "").trim()
          : "";
        if (ov) {
          try {
            await callAI(cs, "Reply with just the word: OK", { model: ov });
          } catch (ovErr) {
            console.warn("[connectivity] reader model override failed:", ovErr?.name, ovErr?.message);
            const ovTimedOut = ovErr?.name === "AbortError" || ovErr?.name === "TimeoutError";
            // ok:true on purpose. The provider answered a moment ago, so filing
            // this as a provider failure would render "this API key is broken"
            // over a mistyped or retired reader model; the overview reads
            // override_bad as its own warning row instead.
            setStatusWarn(statusEl, t("testOverrideFailed", ov,
              ovTimedOut ? t("testTimeout") : (ovErr?.message || "")));
            recordHealth(`ai:${provider}`, true, "override_bad");
            return;
          }
          setStatusResult(statusEl, true, t("testOkWithOverride", (result || "OK").substring(0, 20), ov));
          recordHealth(`ai:${provider}`, true, "connected");
          scheduleStatusClear(provider, statusEl, 4000);
          return;
        }

        setStatusResult(statusEl, true, t("testConnected", (result || "OK").substring(0, 20)));
        recordHealth(`ai:${provider}`, true, "connected");
        scheduleStatusClear(provider, statusEl, 4000);
      } catch (err) {
        // Two names, one meaning: the request deadline is an AbortSignal.timeout
        // (TimeoutError) while a caller-driven cancel is AbortError — same pairing
        // as pbpClassifyPinboardError and wayback.js.
        const timedOut = err?.name === "AbortError" || err?.name === "TimeoutError";
        let msg = timedOut ? t("testTimeout") : err.message;
        if (err?.code === "model_not_found") {
          const mnf = pbpAiModelNotFoundText(cs.aiProvider);
          msg = mnf.msg + " " + mnf.hint;
        }
        setStatusResult(statusEl, false, msg);
        recordHealth(`ai:${provider}`, false,
          timedOut ? "timeout" : (err?.code === "model_not_found" ? "model_not_found" : "failed"));
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  ["gemini","openai","claude","deepseek","qwen","minimax","openrouter","groq","mistral","cohere","siliconflow","zhipu","kimi","ollama","custom"].forEach(p => {
    $id(`test-${p}`)?.addEventListener("click", () => testAIProvider(p));
  });

  // ---- Pinboard token: real-time format validation (shared.js rule) ----
  const tokenInput = $id("opt-pinboard-token");
  const tokenWarn = $id("token-format-warn");
  function validateTokenField() {
    const val = tokenInput.value.trim();
    tokenWarn.classList.toggle("visible", pbpIsValidTokenFormat(val) === false);
  }
  tokenInput?.addEventListener("input", validateTokenField);
  tokenInput?.addEventListener("blur", validateTokenField);
  validateTokenField();

  // ---- Test Pinboard API token (via background to avoid native auth dialog) ----
  $id("test-pinboard-token")?.addEventListener("click", async () => {
    const btn = $id("test-pinboard-token");
    const statusEl = $id("test-pinboard-status");
    const token = tokenInput.value.trim();
    if (pbpIsValidTokenFormat(token) !== true) {
      setStatusResult(statusEl, false, t("loginInvalidFormat"));
      recordHealth("pinboard", false, "invalid_token");
      // This path returns above the cancelStatusClear below, so a clear armed by
      // a preceding successful run has to be dropped here or it wipes this line.
      cancelStatusClear("pinboard");
      return;
    }
    btn.disabled = true;
    cancelStatusClear("pinboard");
    setStatusPending(statusEl, t("testTesting"));
    try {
      const resp = await chrome.runtime.sendMessage({ type: "test_pinboard_token", token });
      if (resp?.ok) {
        setStatusResult(statusEl, true, t("testConnected", token.split(":")[0]));
        recordHealth("pinboard", true, "connected");
        scheduleStatusClear("pinboard", statusEl, 5000);
      } else if (resp?.error === "timeout") {
        setStatusResult(statusEl, false, t("testTimeout"));
        recordHealth("pinboard", false, "timeout");
      } else if (resp?.error === "network") {
        setStatusResult(statusEl, false, t("networkError"));
        recordHealth("pinboard", false, "network");
      } else {
        // Same call as popup.js's login submit: a 429/5xx status must not
        // read (or log) as "your token is wrong" (K155).
        const key = pbpPinboardTestErrorKey(resp);
        setStatusResult(statusEl, false, t(key));
        recordHealth("pinboard", false,
          key === "pinboardErrorRateLimit" ? "rate_limit" : key === "pinboardErrorServer" ? "server" : "auth");
      }
    } catch (e) {
      console.warn("[connectivity] Pinboard test failed:", e?.name, e?.message);
      setStatusResult(statusEl, false, t("networkError"));
      recordHealth("pinboard", false, "network");
    } finally {
      btn.disabled = false;
    }
  });
}
