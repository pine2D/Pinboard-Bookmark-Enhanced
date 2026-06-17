// ============================================================
// Pinboard Bookmark Enhanced - AI Summary & Tags
// ============================================================

// ===================== AI Progress Indicator (B3) =====================
const AI_STAGE_TIMERS = new Map();
const AI_STAGE_STARTED = new Map();
const AI_BUTTON_BASE_TEXT = new Map();

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
    await enrichPageTextIfJina();
    return;
  }
  // Local source: lazy-inject Defuddle and pull full page text
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const info = await getPageInfoFromTab(tab.id, { withDefuddle: true });
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
    if (!result.error && result.markdown) {
      pageInfo.pageText = markdownToPlainText(result.markdown);
    }
  } catch (e) {
    console.warn("Jina content enrichment failed, using local content:", e.message);
  }
}

const AI_SUMMARY_TAG = "[AI Summary]";
const AI_BQ_REGEX = /(\n\n)?\[AI Summary\]\n<blockquote>[\s\S]*?<\/blockquote>\s*$/;
// pbpShouldRestoreCachedSummary is defined in shared.js (pure helper, B4).

// ---- Setup AI feature listeners ----
// ---- AI Error Card ----
let _aiErrorLastOp = null; // "summary" | "tags"

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

  card.classList.remove("hidden");
}

function hideAIError() {
  const card = $id("ai-error-card");
  if (card) card.classList.add("hidden");
  _aiErrorLastOp = null;
}

function setupAIFeatures() {
  // Wire error card controls once
  $id("ai-error-dismiss")?.addEventListener("click", (e) => { e.preventDefault(); hideAIError(); });
  $id("ai-error-retry")?.addEventListener("click", () => {
    const op = _aiErrorLastOp;
    hideAIError();
    if (op === "tags") doAITags(true);
    else if (op === "summary") doAISummary(true);
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
  getAICache(pageInfo.url, "summary", settings.aiCacheDuration, settings.aiContentSource).then(cached => {
    if (cached && pbpShouldRestoreCachedSummary(existingBookmark, $id("description-input").value)) {
      upsertSummary(cached);
      showSummaryActions(true);
    }
  });

  $id("ai-tags-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    await doAITags(false);
  });
}

// ---- Insert or replace AI summary in description ----
function upsertSummary(summary) {
  const di = $id("description-input");
  const cur = di.value.trim();
  const wrapped = `${AI_SUMMARY_TAG}\n<blockquote>${escapeForExtended(summary)}</blockquote>`;

  if (AI_BQ_REGEX.test(cur)) {
    di.value = cur.replace(AI_BQ_REGEX, "\n\n" + wrapped).replace(/^\n\n/, "");
  } else {
    di.value = cur ? cur + "\n\n" + wrapped : wrapped;
  }
  updateCharCount();
  autoResizeTextarea(di);
}

// ---- Remove AI summary block from description ----
function removeSummary() {
  const di = $id("description-input");
  di.value = di.value.replace(AI_BQ_REGEX, "").trim();
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
    link.addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
    msg.appendChild(link);
    const rest = raw.slice(m.index + m[0].length);
    if (rest) msg.appendChild(document.createTextNode(rest));
  } else {
    msg.textContent = raw;
  }
  window._lastStatusFeedback = showFeedback({ variant: "error", messageNode: msg });
}

// ---- AI Summary core logic ----
async function doAISummary(forceRefresh) {
  const btn = $id("ai-summary-btn");
  if (!hasAIKey(settings)) { showSetKeyError(); return; }
  hideAIError();

  if (!forceRefresh) {
    const cached = await getAICache(pageInfo.url, "summary", settings.aiCacheDuration, settings.aiContentSource);
    if (cached) {
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
    if (!pageInfo.pageText) { showStatus("status-msg", t("aiNoContent"), "error"); return; }
    if (showProgressOnBtn) setAiProgress("ai-summary-btn", { provider: settings.aiProvider, stage: "calling" });
    const infKey = `${settings.aiProvider}|summary|${pageInfo.url}`;
    const summary = await getOrCreateInflight(infKey, () =>
      callAI(settings, buildSummaryPrompt(settings, $id("title-input").value, $id("url-input").value, pageInfo.pageText, $id("description-input").value))
    );
    if (showProgressOnBtn) setAiProgress("ai-summary-btn", { provider: settings.aiProvider, stage: "parsing" });
    await setAICache(pageInfo.url, "summary", summary, settings.aiCacheDuration, settings.aiContentSource);
    upsertSummary(summary);
    showSummaryActions(false);
    showStatus("status-msg", forceRefresh ? t("aiSummaryRegenerated") : t("aiSummaryGenerated"), "success");
  } catch (e) {
    showAIError("summary", e);
    if (forceRefresh) showSummaryActions(false);
  } finally {
    if (showProgressOnBtn) {
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
  hideAIError();

  if (!hasAIKey(settings)) { showSetKeyError(); return; }

  if (!forceRefresh) {
    const cached = await getAICache(pageInfo.url, "tags", settings.aiCacheDuration, settings.aiContentSource);
    if (cached) {
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
    if (!pageInfo.pageText) { showStatus("status-msg", t("aiNoContent"), "error"); return; }
    if (btn) setAiProgress("ai-tags-btn", { provider: settings.aiProvider, stage: "calling" });
    const infKey = `${settings.aiProvider}|tags|${pageInfo.url}`;
    const resp = await getOrCreateInflight(infKey, () =>
      callAI(settings, buildTagPrompt(settings, $id("title-input").value, $id("url-input").value, pageInfo.pageText, $id("description-input").value, allUserTags))
    );
    if (btn) setAiProgress("ai-tags-btn", { provider: settings.aiProvider, stage: "parsing" });
    const rawTags = parseAITags(resp, settings.aiTagSeparator);
    const tags = settings.optRespectTagCase
      ? rawTags.map(t => resolveTagCase(t, tagCaseMap))
      : rawTags;
    await setAICache(pageInfo.url, "tags", tags, settings.aiCacheDuration, settings.aiContentSource);
    renderAITags(tags, false);
    if (forceRefresh) {
      showStatus("status-msg", t("aiTagsRegenerated"), "success");
    }
  } catch (e) {
    container.textContent = "";
    container.classList.add("muted");
    showAIError("tags", e);
  } finally {
    if (btn) {
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
    return;
  }

  // Sort: matched tags (by count desc) first, unmatched keep original order
  const sorted = [...tags].sort((a, b) => {
    const ca = allUserTagCounts[a] || 0, cb = allUserTagCounts[b] || 0;
    if (ca && !cb) return -1;
    if (!ca && cb) return 1;
    return 0;
  });
  sorted.forEach((tag) => {
    const el = document.createElement("span");
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
    el.addEventListener("click", () => { addTag(tag); el.classList.add("used"); });
    container.appendChild(el);
  });

  const aa = document.createElement("span");
  aa.className = "add-all-link";
  aa.textContent = t("addAll");
  aa.addEventListener("click", () => {
    container.querySelectorAll(".stag:not(.used)").forEach((el) => { addTag(el.dataset.tag); el.classList.add("used"); });
    aa.innerHTML = PBP_ICONS.check; aa.style.pointerEvents = "none"; aa.style.color = "#080";
  });
  container.appendChild(aa);

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
