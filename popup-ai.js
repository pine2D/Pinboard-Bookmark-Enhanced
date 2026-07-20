// ============================================================
// Pinboard Bookmark Enhanced - AI Summary & Tags
// ============================================================

// ===================== AI Progress Indicator (B3) =====================
const AI_STAGE_TIMERS = new Map();
const AI_STAGE_STARTED = new Map();
const AI_BUTTON_BASE_TEXT = new Map();

function pbpPopupAiAccount() {
  return pbpPinboardAccountFromToken(settings?.pinboardToken);
}

function pbpPopupAiAccountIsCurrent(account) {
  return !!account && pbpPopupAiAccount() === account;
}

function setAiProgress(buttonId, { provider, stage }) {
  const btn = $id(buttonId);
  if (!btn) return;
  if (!AI_BUTTON_BASE_TEXT.has(buttonId)) {
    // Capture original button text before first stage runs
    let baseText = "";
    for (const node of btn.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) baseText += node.textContent;
    }
    AI_BUTTON_BASE_TEXT.set(buttonId, baseText.trim());
  }
  let labelEl = btn.querySelector(".ai-progress-label");
  if (!labelEl) {
    labelEl = document.createElement("span");
    labelEl.className = "ai-progress-label";
    btn.appendChild(labelEl);
  }
  btn.dataset.stage = stage;
  const tpl = t(`aiStage_${stage}`) || "";
  labelEl.textContent = " · " + tpl.replace("{provider}", provider || "AI");
  labelEl.setAttribute("data-slow-hint", t("aiSlowHint") || "");

  const startedAt = AI_STAGE_STARTED.get(buttonId) || Date.now();
  AI_STAGE_STARTED.set(buttonId, startedAt);
  const prior = AI_STAGE_TIMERS.get(buttonId);
  if (prior) clearTimeout(prior);
  AI_STAGE_TIMERS.set(buttonId, setTimeout(() => {
    if (btn.classList.contains("loading")) btn.classList.add("slow");
  }, Math.max(0, 8000 - (Date.now() - startedAt))));
}

function clearAiProgress(buttonId) {
  const btn = $id(buttonId);
  if (!btn) return;
  btn.classList.remove("slow");
  delete btn.dataset.stage;
  btn.querySelector(".ai-progress-label")?.remove();
  const timer = AI_STAGE_TIMERS.get(buttonId);
  if (timer) { clearTimeout(timer); AI_STAGE_TIMERS.delete(buttonId); }
  AI_STAGE_STARTED.delete(buttonId);
  AI_BUTTON_BASE_TEXT.delete(buttonId);
}

// ---- Enrich page content via Jina Reader if configured ----
// Populate pageInfo.pageText on demand. Avoids Defuddle injection on popup boot — the
// content script for AI quality is only fetched when the user actually invokes AI.
async function ensurePageText() {
  if (pageInfo.pageText) return; // already populated (cache from earlier AI call this session)
  if (settings.aiContentSource === "jina") {
    // Throws only on host_permission (surface the grant flow); any other
    // failure leaves pageText empty and falls through to local Defuddle
    // below. The old code returned unconditionally here - its warn log
    // claimed "using local content" while nobody ever ran the local
    // extractor (audit A9).
    await enrichPageTextIfJina();
    if (pageInfo.pageText) return;
  }
  // Local source: lazy-inject Defuddle and pull full page text
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const info = await getPageInfoFromTab(tab.id, { withDefuddle: true, expectedUrl: pageInfo.url });
    if (info?.pageText) pageInfo.pageText = info.pageText;
  } catch (_) { /* tab gone / inject failed — pageText stays empty, caller will surface aiNoContent */ }
}

async function enrichPageTextIfJina() {
  if (settings.aiContentSource !== "jina") return;
  if (!pageInfo?.url) return;
  try {
    const jinaKey = settings.jinaApiKey ? deobfuscateKey(settings.jinaApiKey) : "";
    const result = await fetchJinaMarkdown(pageInfo.url, {
      apiKey: jinaKey,
      cacheDuration: settings.aiCacheDuration
    });
    if (result.code === "host_permission") {
      const origins = _aiRequiredOriginPatterns(settings, [PBP_JINA_ORIGIN_PATTERN]);
      const hosts = origins
        .map(pattern => pattern.replace(/\/\*$/, "")).join(", ");
      const err = new Error(t("aiErrorHostPermission", hosts));
      err.code = "host_permission";
      err.permissionStage = "extracting";
      err.permissionOrigins = origins;
      throw err;
    }
    if (!result.error && result.markdown) {
      pageInfo.pageText = markdownToPlainText(result.markdown);
    }
  } catch (e) {
    if (e?.code === "host_permission") throw e;
    console.warn("Jina content enrichment failed, using local content:", e.message);
  }
}

const AI_SUMMARY_TAG = "[AI Summary]";
// Single source of truth: the regex literal lives in shared.js (_AI_BQ_REGEX_SHARED),
// which popup.html loads before popup-ai.js. Alias it here so the [AI Summary]
// blockquote pattern can never drift between the two files (F3).
const AI_BQ_REGEX = _AI_BQ_REGEX_SHARED;
// pbpShouldRestoreCachedSummary is defined in shared.js (pure helper, B4).

// ---- Setup AI feature listeners ----
// ---- AI Error Card ----
let _aiErrorLastOp = null; // "summary" | "tags"
let _aiErrorLastPermission = null;

// Fallback provider order: stable list, current provider gets skipped.
const AI_PROVIDER_ORDER = [
  "gemini", "openai", "claude", "deepseek", "qwen", "openrouter", "groq",
  "mistral", "cohere", "siliconflow", "zhipu", "kimi", "minimax", "ollama", "custom"
];
const AI_PROVIDER_LABEL = {
  gemini: "Gemini", openai: "OpenAI", claude: "Claude", deepseek: "DeepSeek",
  qwen: "Qwen", minimax: "MiniMax", openrouter: "OpenRouter", groq: "Groq",
  mistral: "Mistral", cohere: "Cohere", siliconflow: "SiliconFlow", zhipu: "Zhipu",
  kimi: "Kimi", ollama: "Ollama", custom: "Custom"
};

// Find first provider OTHER than `current` that has a usable key, by iterating
// AI_PROVIDER_ORDER. Returns null if no fallback is available.
function pickFallbackProvider(s) {
  const current = s.aiProvider || "gemini";
  for (const p of AI_PROVIDER_ORDER) {
    if (p === current) continue;
    if (hasAIKey({ ...s, aiProvider: p })) return p;
  }
  return null;
}

function showAIError(op, err) {
  _aiErrorLastOp = op;
  _aiErrorLastPermission = err?.code === "host_permission" ? {
    settings: { ...settings },
    stage: err.permissionStage,
    origins: [...(err.permissionOrigins || _aiRequiredOriginPatterns(settings))],
  } : null;
  const card = $id("ai-error-card");
  if (!card) return;
  const providerKey = (settings.aiProvider || "openai");
  const provLabel = AI_PROVIDER_LABEL[providerKey] || providerKey;
  $id("ai-error-title").textContent = t("aiErrorTitle", op === "tags" ? t("aiErrorOpTags") : t("aiErrorOpSummary"));
  const msgEl = $id("ai-error-message");

  const short = (err && err.message) ? err.message : String(err || t("aiUnknownError"));

  // Remove any previously inserted model-not-found hint element
  msgEl.parentElement.querySelector(".model-not-found-hint")?.remove();

  if (err?.code === "model_not_found") {
    msgEl.textContent = t("aiErrorModelNotFound", provLabel);
    const hintEl = document.createElement("div");
    hintEl.className = "model-not-found-hint";
    hintEl.textContent = t("aiErrorModelNotFoundHint");
    msgEl.parentElement.insertBefore(hintEl, msgEl.nextSibling);
  } else {
    msgEl.textContent = `[${provLabel}] ${short}`;
  }

  const detailsEl = $id("ai-error-details");
  detailsEl.textContent = (err && err.stack) ? err.stack : short;
  detailsEl.classList.add("hidden");
  $id("ai-error-details-toggle").textContent = t("aiErrorDetails");

  // Fallback button: show when another provider has a valid key
  const fallbackBtn = $id("ai-error-fallback");
  if (fallbackBtn) {
    const next = pickFallbackProvider(settings);
    if (next) {
      const nextLabel = AI_PROVIDER_LABEL[next] || next;
      fallbackBtn.textContent = t("aiErrorTryWith", nextLabel) || `Try with ${nextLabel}`;
      fallbackBtn.dataset.provider = next;
      fallbackBtn.classList.remove("hidden");
    } else {
      fallbackBtn.classList.add("hidden");
      delete fallbackBtn.dataset.provider;
    }
  }

  const retryBtn = $id("ai-error-retry");
  if (retryBtn) retryBtn.textContent = t(err?.code === "host_permission" ? "aiGrantRetry" : "aiErrorRetry");

  card.classList.remove("hidden");
}

function hideAIError() {
  const card = $id("ai-error-card");
  if (card) card.classList.add("hidden");
  const retryBtn = $id("ai-error-retry");
  if (retryBtn) retryBtn.textContent = t("aiErrorRetry");
  _aiErrorLastOp = null;
  _aiErrorLastPermission = null;
}

function setupAIFeatures() {
  // Wire error card controls once
  $id("ai-error-dismiss")?.addEventListener("click", (e) => { e.preventDefault(); hideAIError(); });
  $id("ai-error-retry")?.addEventListener("click", async (event) => {
    const retryBtn = event.currentTarget;
    if (retryBtn.disabled) return;
    retryBtn.disabled = true;
    try {
      const op = _aiErrorLastOp;
      const recovery = _aiErrorLastPermission;
      if (!op) return;
      if (recovery) {
        const providerOrigin = _aiTargetOriginPattern(recovery.settings);
        const extraOrigins = recovery.origins.filter(origin => origin !== providerOrigin);
        const granted = await requestAIHostPermissions(recovery.settings, extraOrigins);
        if (!granted) return;
      }
      hideAIError();
      const originalProvider = settings.aiProvider;
      if (recovery) settings.aiProvider = recovery.settings.aiProvider;
      try {
        if (op === "tags") await doAITags(true);
        else if (op === "summary") await doAISummary(true);
      } finally {
        settings.aiProvider = originalProvider;
      }
    } finally {
      retryBtn.disabled = false;
    }
  });
  $id("ai-error-fallback")?.addEventListener("click", async (e) => {
    const next = e.currentTarget.dataset.provider;
    const op = _aiErrorLastOp;
    if (!next || !op) return;
    // One-shot override: swap provider, run op, restore. Don't persist —
    // user may want their default to remain (e.g., Gemini quota resets next day).
    const original = settings.aiProvider;
    settings.aiProvider = next;
    hideAIError();
    try {
      if (op === "tags") await doAITags(true);
      else if (op === "summary") await doAISummary(true);
    } finally {
      settings.aiProvider = original;
    }
  });
  $id("ai-error-details-toggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    const d = $id("ai-error-details");
    d.classList.toggle("hidden");
    e.target.textContent = d.classList.contains("hidden") ? t("aiErrorDetails") : t("aiErrorHideDetails");
  });

  $id("ai-summary-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    await doAISummary(false);
  });

  // Auto-restore cached summary only for fresh (non-bookmarked) pages whose
  // description doesn't already contain a summary. For existing bookmarks,
  // checkExistingBookmark (popup.js) restores the user's saved `extended` — we
  // must not race it (lost summary) or append on top (duplicate summary).
  const restoreAccount = pbpPopupAiAccount();
  getAICache(pageInfo.url, "summary", settings.aiCacheDuration, settings.aiContentSource, restoreAccount).then(cached => {
    if (cached && pbpPopupAiAccountIsCurrent(restoreAccount)
        && pbpShouldRestoreCachedSummary(existingBookmark, $id("description-input").value)) {
      upsertSummary(cached);
      showSummaryActions(true);
    }
  });

  $id("ai-tags-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    await doAITags(false);
  });
}

// All complete [AI Summary] blocks in a description, in order. Callers
// operate on the LAST one (the block this popup manages); earlier ones
// are legacy duplicates the user can clean up block-by-block.
function _aiSummaryBlockMatches(text) {
  return [...String(text || "").matchAll(new RegExp(AI_BQ_REGEX.source, "g"))];
}

// ---- Insert or replace AI summary in description ----
// Replaces the LAST existing block IN PLACE (a user note typed after the
// block stays after it - the old append-at-end variant only recognized
// end-anchored blocks and duplicated the summary otherwise, audit A11).
function upsertSummary(summary) {
  const di = $id("description-input");
  const cur = di.value;
  const wrapped = `${AI_SUMMARY_TAG}\n<blockquote>${escapeForExtended(summary)}</blockquote>`;
  const matches = _aiSummaryBlockMatches(cur);
  if (matches.length) {
    const last = matches[matches.length - 1];
    const lead = last[1] || ""; // keep the captured \n\n separator if present
    di.value = (cur.slice(0, last.index) + lead + wrapped + cur.slice(last.index + last[0].length)).trim();
  } else {
    const base = cur.trim();
    di.value = base ? base + "\n\n" + wrapped : wrapped;
  }
  updateCharCount();
  autoResizeTextarea(di);
}

// ---- Remove AI summary block from description ----
// Removes only the LAST block; text before and after it is preserved.
function removeSummary() {
  const di = $id("description-input");
  const cur = di.value;
  const matches = _aiSummaryBlockMatches(cur);
  if (matches.length) {
    const last = matches[matches.length - 1];
    di.value = (cur.slice(0, last.index) + cur.slice(last.index + last[0].length)).trim();
  }
  updateCharCount();
  autoResizeTextarea(di);
}

// Unified "no AI key" prompt: one feedback card shared by AI summary and AI tags so
// both behave identically. The full standard sentence lives in the aiSetKey message,
// which marks the word linking to the options page with [[...]] — e.g.
// "Set AI API key in [[settings]]". Marking the word in place (rather than composing
// a prefix + the settings word) keeps the sentence grammatical in every locale: CJK/JA
// put the word mid-sentence and pl/ru decline it ("ustawieniach", "настройках"). The
// link label is the marked word itself, so the declension is preserved. Persistent
// (no autoHide): it's an actionable setup prompt, not a transient status.
function showSetKeyError() {
  if (window._lastStatusFeedback) window._lastStatusFeedback.dismiss();
  const raw = t("aiSetKey");
  const msg = document.createElement("span");
  const m = raw.match(/\[\[(.+?)\]\]/);
  if (m) {
    if (m.index > 0) msg.appendChild(document.createTextNode(raw.slice(0, m.index)));
    const link = document.createElement("a");
    link.href = "#";
    link.className = "go-settings";
    link.textContent = m[1];
    link.addEventListener("click", (e) => { e.preventDefault(); pbpOpenOptionsTab("ai"); });
    msg.appendChild(link);
    const rest = raw.slice(m.index + m[0].length);
    if (rest) msg.appendChild(document.createTextNode(rest));
  } else {
    msg.textContent = raw;
  }
  window._lastStatusFeedback = showFeedback({ variant: "error", messageNode: msg });
}

// Apply optional case-resolution to AI tags (mirrors the prior inline doAITags logic).
function finalizeAITags(rawTags) {
  return settings.optRespectTagCase ? rawTags.map(t => resolveTagCase(t, tagCaseMap)) : rawTags;
}

// Fetch one AI artifact ("summary" | "tags") for the current page (cache-miss path only).
// If the OTHER artifact is also missing, issue ONE combined call and cache the other
// half so its later click is an instant, zero-extra-body-token cache hit. forceRefresh
// (regenerate) always does a single dedicated call. Combined failure -> single fallback.
async function fetchAIArtifacts(kind, forceRefresh, account) {
  const url = pageInfo.url;
  const provider = settings.aiProvider;
  const otherKind = kind === "summary" ? "tags" : "summary";
  const combinedKey = `${account}|${provider}|combined|${url}`;
  if (!pbpPopupAiAccountIsCurrent(account)) return null;

  const callSingle = () => {
    if (kind === "summary") {
      return getOrCreateInflight(`${account}|${provider}|summary|${url}`, () =>
        callAI(settings, buildSummaryPrompt(settings, $id("title-input").value, $id("url-input").value, pageInfo.pageText, $id("description-input").value)));
    }
    return getOrCreateInflight(`${account}|${provider}|tags|${url}`, async () => {
      const resp = await callAI(settings, buildTagPrompt(settings, $id("title-input").value, $id("url-input").value, pageInfo.pageText, $id("description-input").value, allUserTags));
      return finalizeAITags(refineTags(parseAITags(resp, settings.aiTagSeparator), { cap: AI_TAG_CAP, separator: settings.aiTagSeparator }));
    });
  };

  if (forceRefresh) return callSingle();

  // Custom-prompt users keep their own templates -> never use the combined prompt
  // (it uses TAG_GUIDANCE, not customTagPrompt/customSummaryPrompt). Global Constraint.
  if (settings.customTagPrompt?.trim() || settings.customSummaryPrompt?.trim()) return callSingle();

  // Ride an in-flight combined call if one is already running. If that call
  // rejects (combined parse failure), fall through to this call's own
  // cache/single path instead of surfacing the other click's error.
  if (_inflightAI.has(combinedKey)) {
    try {
      const both = await _inflightAI.get(combinedKey);
      if (!pbpPopupAiAccountIsCurrent(account)) return null;
      if (both) return kind === "tags" ? finalizeAITags(both.tags) : both.summary;
    } catch (_) { /* combined in-flight failed; fall through */ }
  }

  // If the other half is already cached, only the requested half is missing.
  const otherCached = await getAICache(url, otherKind, settings.aiCacheDuration, settings.aiContentSource, account);
  if (!pbpPopupAiAccountIsCurrent(account)) return null;
  if (otherCached != null) return callSingle();

  // Opportunistic combined call.
  let both = null;
  try {
    both = await getOrCreateInflight(combinedKey, async () => {
      const resp = await callAI(settings, buildCombinedPrompt(settings, $id("title-input").value, $id("url-input").value, pageInfo.pageText, $id("description-input").value, allUserTags));
      return parseAICombined(resp, settings.aiTagSeparator);
    });
  } catch (e) {
    both = null;
  }
  if (!pbpPopupAiAccountIsCurrent(account)) return null;
  if (!both) return callSingle();

  // Cache the OTHER half so its later click is instant + free.
  if (otherKind === "tags") {
    if (pbpPopupAiAccountIsCurrent(account)) {
      await setAICache(url, "tags", finalizeAITags(both.tags), settings.aiCacheDuration, settings.aiContentSource, account);
    }
  } else {
    if (pbpPopupAiAccountIsCurrent(account)) {
      await setAICache(url, "summary", both.summary, settings.aiCacheDuration, settings.aiContentSource, account);
    }
  }
  return pbpPopupAiAccountIsCurrent(account)
    ? (kind === "tags" ? finalizeAITags(both.tags) : both.summary)
    : null;
}

// ---- AI Summary core logic ----
async function doAISummary(forceRefresh) {
  const btn = $id("ai-summary-btn");
  const account = pbpPopupAiAccount();
  if (!account) return;
  if (!hasAIKey(settings)) { showSetKeyError(); return; }
  hideAIError();

  if (!forceRefresh) {
    const cached = await getAICache(pageInfo.url, "summary", settings.aiCacheDuration, settings.aiContentSource, account);
    if (cached && pbpPopupAiAccountIsCurrent(account)) {
      upsertSummary(cached);
      showSummaryActions(true);
      return;
    }
  }

  const showProgressOnBtn = btn && !btn.classList.contains("hidden");
  if (showProgressOnBtn) {
    btn.classList.add("loading");
  }
  try {
    if (showProgressOnBtn) setAiProgress("ai-summary-btn", { provider: settings.aiProvider, stage: "extracting" });
    await ensurePageText();
    if (!pbpPopupAiAccountIsCurrent(account)) return;
    if (!pageInfo.pageText) { showStatus("status-msg", t("aiNoContent"), "error"); return; }
    if (showProgressOnBtn) setAiProgress("ai-summary-btn", { provider: settings.aiProvider, stage: "calling" });
    const summary = await fetchAIArtifacts("summary", forceRefresh, account);
    if (!pbpPopupAiAccountIsCurrent(account)) return;
    if (showProgressOnBtn) setAiProgress("ai-summary-btn", { provider: settings.aiProvider, stage: "parsing" });
    await setAICache(pageInfo.url, "summary", summary, settings.aiCacheDuration, settings.aiContentSource, account);
    if (!pbpPopupAiAccountIsCurrent(account)) return;
    upsertSummary(summary);
    showSummaryActions(false);
    showStatus("status-msg", forceRefresh ? t("aiSummaryRegenerated") : t("aiSummaryGenerated"), "success");
  } catch (e) {
    if (!pbpPopupAiAccountIsCurrent(account)) return;
    if (e?.code === "host_permission" && !e.permissionOrigins) {
      e.permissionStage = "calling";
      e.permissionOrigins = _aiRequiredOriginPatterns(settings);
    }
    showAIError("summary", e);
    if (forceRefresh) showSummaryActions(false);
  } finally {
    if (showProgressOnBtn && pbpPopupAiAccountIsCurrent(account)) {
      clearAiProgress("ai-summary-btn");
      btn.classList.remove("loading");
    }
  }
}

// ---- Show regenerate + remove actions after summary is inserted ----
function showSummaryActions(fromCache) {
  const btn = $id("ai-summary-btn");
  const bar = btn.parentElement;
  btn.classList.add("hidden");
  $id("ai-summary-hint")?.classList.add("hidden");
  bar.querySelector(".cache-hint-wrap")?.remove();

  const wrap = document.createElement("span");
  wrap.className = "cache-hint-wrap";

  if (fromCache) {
    const hint = document.createElement("span");
    hint.className = "cache-hint";
    hint.textContent = t("aiCached");
    wrap.appendChild(hint);
  }

  function createActionLink(text, action) {
    const link = document.createElement("a");
    link.href = "#";
    link.className = "regen-link";
    link.dataset.action = action;
    link.textContent = text;
    return link;
  }

  const regenLink = createActionLink(t("aiRegenerate"), "regenerate");
  regenLink.title = t("aiSummaryBtnTitle");
  const removeLink = createActionLink(t("aiRemove"), "remove");
  wrap.appendChild(regenLink);
  wrap.appendChild(removeLink);
  bar.appendChild(wrap);

  removeLink.addEventListener("click", (e) => {
    e.preventDefault();
    removeSummary();
    wrap.remove();
    setBtnIcon(btn, "robot", t("aiSummaryBtn"));
    btn.classList.remove("hidden", "loading");
    const hint = $id("ai-summary-hint");
    if (hint && settings.optShowAiSummary !== false) hint.classList.remove("hidden");
    showStatus("status-msg", t("aiSummaryRemoved"), "success");
  });

  regenLink.addEventListener("click", async (e) => {
    e.preventDefault();
    wrap.querySelectorAll(".regen-link").forEach(l => l.classList.add("loading"));
    regenLink.textContent = t("aiRegenerating");
    await doAISummary(true);
  });
}

// ---- AI Tags core logic ----
async function doAITags(forceRefresh) {
  const btn = $id("ai-tags-btn");
  const container = $id("ai-suggest-tags");
  const account = pbpPopupAiAccount();
  if (!account) return;
  hideAIError();

  if (!hasAIKey(settings)) { showSetKeyError(); return; }

  if (!forceRefresh) {
    const cached = await getAICache(pageInfo.url, "tags", settings.aiCacheDuration, settings.aiContentSource, account);
    if (cached && pbpPopupAiAccountIsCurrent(account)) {
      renderAITags(cached, true);
      return;
    }
  }

  // doAITags uses bare `if (btn)` — ai-tags-btn is never hidden in normal flow,
  // unlike ai-summary-btn (which hides via showSummaryActions). If that ever changes,
  // mirror the showProgressOnBtn pattern from doAISummary.
  if (btn) {
    btn.classList.add("loading");
  }

  try {
    if (btn) setAiProgress("ai-tags-btn", { provider: settings.aiProvider, stage: "extracting" });
    await ensurePageText();
    if (!pbpPopupAiAccountIsCurrent(account)) return;
    if (!pageInfo.pageText) { showStatus("status-msg", t("aiNoContent"), "error"); return; }
    if (btn) setAiProgress("ai-tags-btn", { provider: settings.aiProvider, stage: "calling" });
    const tags = await fetchAIArtifacts("tags", forceRefresh, account);
    if (!pbpPopupAiAccountIsCurrent(account)) return;
    if (btn) setAiProgress("ai-tags-btn", { provider: settings.aiProvider, stage: "parsing" });
    await setAICache(pageInfo.url, "tags", tags, settings.aiCacheDuration, settings.aiContentSource, account);
    if (!pbpPopupAiAccountIsCurrent(account)) return;
    renderAITags(tags, false);
    if (forceRefresh) {
      showStatus("status-msg", t("aiTagsRegenerated"), "success");
    }
  } catch (e) {
    if (!pbpPopupAiAccountIsCurrent(account)) return;
    if (e?.code === "host_permission" && !e.permissionOrigins) {
      e.permissionStage = "calling";
      e.permissionOrigins = _aiRequiredOriginPatterns(settings);
    }
    container.textContent = "";
    container.classList.add("muted");
    pbpAssignAltNumBadges(); // AI chips gone: re-slot so suggest-row digits/hint stay truthful
    showAIError("tags", e);
  } finally {
    if (btn && pbpPopupAiAccountIsCurrent(account)) {
      clearAiProgress("ai-tags-btn");
      btn.classList.remove("loading");
    }
  }
}

function renderAITags(tags, fromCache) {
  const container = $id("ai-suggest-tags");
  container.innerHTML = "";

  if (!tags.length) {
    injectEmptyState(container, "spark", t("emptyAiTagsHint"));
    container.classList.add("muted");
    pbpAssignAltNumBadges();
    return;
  }

  // Render in the model's specificity order (most defining first); do NOT reorder
  // owned tags to the front — that would bury a new defining tag like "ai_token_relay".
  // Real <button>s like the suggest row's chips (popup-tags.js): AI chips share
  // the .stag Alt+N pipeline, and syncSuggestTagStates sets .disabled, which
  // only carries native semantics (focusability, AT state) on a button.
  tags.forEach((tag) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "stag ai";
    el.dataset.tag = tag;
    el.appendChild(document.createTextNode(tag));
    const count = allUserTagCounts[tag];
    if (count) {
      const cs = document.createElement("span");
      cs.className = "ac-count";
      cs.textContent = ` (${count})`;
      el.appendChild(cs);
    }
    el.addEventListener("click", () => { addTag(tag); el.classList.add("used"); el.disabled = true; });
    container.appendChild(el);
  });

  const aa = document.createElement("button");
  aa.type = "button";
  aa.className = "add-all-link";
  aa.textContent = t("addAll");
  aa.setAttribute("aria-label", t("addAll"));
  aa.addEventListener("click", () => {
    container.querySelectorAll(".stag:not(.used)").forEach((el) => { addTag(el.dataset.tag); el.classList.add("used"); });
    aa.innerHTML = PBP_ICONS.check; aa.disabled = true; aa.style.color = "#080";
  });
  container.appendChild(aa);
  pbpAssignAltNumBadges();

  if (fromCache) {
    const cachedTagSet = new Set(tags.map(t => t.toLowerCase()));
    const hintWrap = document.createElement("span");
    hintWrap.className = "cache-hint-wrap";
    hintWrap.style.display = "inline-block";
    hintWrap.style.marginLeft = "8px";

    const cachedSpan = document.createElement("span");
    cachedSpan.className = "cache-hint";
    cachedSpan.textContent = t("aiCached");
    hintWrap.appendChild(cachedSpan);

    ["append", "replace"].forEach(mode => {
      const link = document.createElement("a");
      link.href = "#";
      link.className = "regen-link";
      link.dataset.mode = mode;
      link.textContent = mode === "append" ? t("aiRegenerate") : t("aiReplace");
      link.addEventListener("click", async (e) => {
        e.preventDefault();
        hintWrap.querySelectorAll(".regen-link").forEach((l) => l.classList.add("loading"));
        link.textContent = mode === "replace" ? t("aiReplacing") : t("aiRegenerating");
        if (mode === "replace") {
          currentTags = currentTags.filter(t => !cachedTagSet.has(t.toLowerCase()));
          renderTags();
        }
        await doAITags(true);
      });
      hintWrap.appendChild(link);
    });

    container.appendChild(hintWrap);
  }
}
