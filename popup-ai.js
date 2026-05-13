// ============================================================
// Pinboard Bookmark Enhanced - AI Summary & Tags
// ============================================================

// ---- Enrich page content via Jina Reader if configured ----
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
  msgEl.textContent = `[${provLabel}] ${short}`;
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

  // Auto-restore cached summary if description doesn't already contain one
  if (!AI_BQ_REGEX.test($id("description-input").value)) {
    getAICache(pageInfo.url, "summary", settings.aiCacheDuration, settings.aiContentSource).then(cached => {
      if (cached && !AI_BQ_REGEX.test($id("description-input").value)) {
        upsertSummary(cached);
        showSummaryActions(true);
      }
    });
  }

  $id("ai-tags-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    await doAITags(false);
  });
}

// ---- Insert or replace AI summary in description ----
function upsertSummary(summary) {
  const di = $id("description-input");
  const cur = di.value.trim();
  const wrapped = `${AI_SUMMARY_TAG}\n<blockquote>${summary}</blockquote>`;

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

// ---- AI Summary core logic ----
async function doAISummary(forceRefresh) {
  const btn = $id("ai-summary-btn");
  if (!hasAIKey(settings)) { showStatus("status-msg", t("aiSetKey"), "error"); return; }
  if (!pageInfo.pageText) { showStatus("status-msg", t("aiNoContent"), "error"); return; }
  hideAIError();

  if (!forceRefresh) {
    const cached = await getAICache(pageInfo.url, "summary", settings.aiCacheDuration, settings.aiContentSource);
    if (cached) {
      upsertSummary(cached);
      showSummaryActions(true);
      return;
    }
  }

  if (btn && !btn.classList.contains("hidden")) {
    btn.textContent = t("aiSummarizing");
    btn.classList.add("loading");
  }
  try {
    await enrichPageTextIfJina();
    const summary = await callAI(settings, buildSummaryPrompt(settings, $id("title-input").value, $id("url-input").value, pageInfo.pageText, $id("description-input").value));
    await setAICache(pageInfo.url, "summary", summary, settings.aiCacheDuration, settings.aiContentSource);
    upsertSummary(summary);
    showSummaryActions(false);
    showStatus("status-msg", forceRefresh ? t("aiSummaryRegenerated") : t("aiSummaryGenerated"), "success");
  } catch (e) {
    showAIError("summary", e);
    if (forceRefresh) showSummaryActions(false);
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
    btn.textContent = t("aiSummaryBtn");
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

  if (!hasAIKey(settings)) {
    container.textContent = "";
    const msg = document.createElement("span");
    msg.className = "muted";
    msg.textContent = t("aiSetKeyIn");
    const link = document.createElement("a");
    link.href = "#";
    link.className = "go-settings";
    link.textContent = t("settings");
    link.addEventListener("click", (ev) => { ev.preventDefault(); chrome.runtime.openOptionsPage(); });
    msg.appendChild(link);
    container.appendChild(msg);
    return;
  }

  if (!forceRefresh) {
    const cached = await getAICache(pageInfo.url, "tags", settings.aiCacheDuration, settings.aiContentSource);
    if (cached) {
      renderAITags(cached, true);
      return;
    }
  }

  if (btn) {
    btn.textContent = t("aiGenerating");
    btn.classList.add("loading");
  }

  try {
    await enrichPageTextIfJina();
    const resp = await callAI(settings, buildTagPrompt(settings, $id("title-input").value, $id("url-input").value, pageInfo.pageText, $id("description-input").value, allUserTags));
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
  }

  if (btn) {
    btn.textContent = t("aiGenerate");
    btn.classList.remove("loading");
  }
}

function renderAITags(tags, fromCache) {
  const container = $id("ai-suggest-tags");
  container.innerHTML = "";

  if (!tags.length) {
    container.textContent = t("aiNoTags");
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
    aa.textContent = "✓"; aa.style.pointerEvents = "none"; aa.style.color = "#080";
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
