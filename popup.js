// ============================================================
// Pinboard Bookmark Plus - Popup (v2.1)
// ============================================================

let currentTags = [];
let allUserTags = [];
let pageInfo = {};
let existingBookmark = null;
let acIndex = -1;
let settings = {};

const DEFAULT_TAG_PROMPT = `Suggest 5-10 bookmark tags for the following webpage. Tags should be lowercase, use hyphens for multi-word. Return ONLY a JSON array.

Title: {{title}}
URL: {{url}}
Content: {{content}}

Format: ["tag1","tag2"]`;

const DEFAULT_SUMMARY_PROMPT = `Summarize the following webpage concisely in 2-4 sentences. Focus on key points. {{lang_instruction}}

Title: {{title}}
Content: {{content}}`;

document.addEventListener("DOMContentLoaded", async () => {
  settings = await chrome.storage.sync.get({
    pinboardToken: "",
    aiProvider: "gemini",
    geminiApiKey: "", geminiModel: "gemini-2.0-flash",
    openaiApiKey: "", openaiModel: "gpt-4o-mini", openaiBaseUrl: "https://api.openai.com/v1",
    claudeApiKey: "", claudeModel: "claude-sonnet-4-20250514",
    deepseekApiKey: "", deepseekModel: "deepseek-chat",
    qwenApiKey: "", qwenModel: "qwen-turbo",
    minimaxApiKey: "", minimaxModel: "MiniMax-Text-01",
    openrouterApiKey: "", openrouterModel: "google/gemini-2.0-flash-exp:free",
    ollamaBaseUrl: "http://localhost:11434", ollamaModel: "llama3",
    customApiKey: "", customModel: "", customBaseUrl: "", customName: "Custom",
    aiSummaryLang: "auto", aiCacheDuration: 60,
    customTagPrompt: "", customSummaryPrompt: "",
    optPrivateDefault: false, optPrivateIncognito: false, optReadlaterDefault: false,
    optBlockquote: true, optIncludeReferrer: true, optAiAutoTags: false
  });

  if (!settings.pinboardToken) showLogin();
  else showMain(settings.pinboardToken);

  document.getElementById("options-link").addEventListener("click", (e) => {
    e.preventDefault(); chrome.runtime.openOptionsPage();
  });
});

// ===================== Login =====================
function showLogin() {
  document.getElementById("login-section").classList.remove("hidden");
  document.getElementById("main-section").classList.add("hidden");
  document.getElementById("login-btn").addEventListener("click", async () => {
    const token = document.getElementById("token-input").value.trim();
    if (!token || !token.includes(":")) { showElement("login-error", "Invalid format. Use username:TOKEN"); return; }
    try {
      const res = await fetch(`https://api.pinboard.in/v1/user/api_token/?auth_token=${token}&format=json`);
      if (res.ok) { await chrome.storage.sync.set({ pinboardToken: token }); settings.pinboardToken = token; showMain(token); }
      else showElement("login-error", "Authentication failed.");
    } catch (e) { showElement("login-error", "Network error."); }
  });
}

// ===================== Page Info =====================
async function getPageInfoFromTab(tabId) {
  try {
    // 先获取 tab 信息，检查 URL 是否可注入
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";

    // 这些协议无法注入脚本，直接返回基本信息
    if (
      !url.startsWith("http://") &&
      !url.startsWith("https://") &&
      !url.startsWith("file://")
    ) {
      return {
        url: url,
        title: tab.title || "",
        selectedText: "",
        metaDescription: "",
        referrer: "",
        pageText: ""
      };
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const info = {
          url: location.href,
          title: document.title,
          selectedText: "",
          metaDescription: "",
          referrer: document.referrer || "",
          pageText: ""
        };
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const t = sel.toString().trim();
          if (t) info.selectedText = t;
        }
        const md =
          document.querySelector('meta[name="description"]') ||
          document.querySelector('meta[property="og:description"]');
        if (md) info.metaDescription = md.getAttribute("content") || "";
        info.pageText = (document.body ? document.body.innerText : "").substring(0, 8000);
        return info;
      }
    });
    if (results?.[0]?.result) return results[0].result;
  } catch (e) {
    console.warn("getPageInfoFromTab failed:", e.message);
  }
  return null;
}


// ===================== Main =====================
async function showMain(token) {
  document.getElementById("login-section").classList.add("hidden");
  document.getElementById("main-section").classList.remove("hidden");
  document.getElementById("user-info").textContent = `Pinboard — ${token.split(":")[0]}`;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pageInfo = (await getPageInfoFromTab(tab.id)) || {
    url: tab.url || "", title: tab.title || "", selectedText: "", metaDescription: "", referrer: "", pageText: ""
  };

  document.getElementById("url-input").value = pageInfo.url;
  document.getElementById("title-input").value = pageInfo.title;

  let desc = "";
  if (pageInfo.selectedText) {
    desc = settings.optBlockquote ? `<blockquote>${pageInfo.selectedText}</blockquote>` : pageInfo.selectedText;
  } else if (pageInfo.metaDescription) { desc = pageInfo.metaDescription; }
  if (settings.optIncludeReferrer && pageInfo.referrer) { desc += (desc ? "\n\n" : "") + `via: ${pageInfo.referrer}`; }
  document.getElementById("description-input").value = desc;
  updateCharCount();

  if (settings.optPrivateDefault) document.getElementById("private-check").checked = true;
  if (settings.optPrivateIncognito && tab.incognito) document.getElementById("private-check").checked = true;
  if (settings.optReadlaterDefault) document.getElementById("readlater-check").checked = true;

  await checkExistingBookmark(token, pageInfo.url);
  fetchPinboardSuggestTags(token, pageInfo.url);
  fetchAllUserTags(token);
  setupTagsInput();
  setupSubmit(token);
  setupAIFeatures();
  setupDescriptionCounter();
  setupTabSet();
  document.querySelector(".tags-input-wrap").addEventListener("click", () => document.getElementById("tags-input").focus());
  if (settings.optAiAutoTags && hasAIKey()) document.getElementById("ai-tags-btn").click();
}

  

/// ===================== Tab Set 保存功能 =====================
function setupTabSet() {
  const btn = document.getElementById("save-tabset-btn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = "⏳ Saving...";

    try {
      // 获取当前窗口所有有效标签页
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const validTabs = tabs.filter(t =>
        t.url && (t.url.startsWith("http://") || t.url.startsWith("https://"))
      );

      if (validTabs.length === 0) {
        showStatus("status-msg", "No valid tabs to save", "error");
        btn.textContent = origText;
        btn.disabled = false;
        return;
      }

      const tabsData = validTabs.map(t => ({
        title: t.title || t.url,
        url: t.url
      }));

      // 发送消息给 background service worker 执行保存
      // background 不会因 popup 关闭而中断
      chrome.runtime.sendMessage(
        { action: "saveTabSet", tabsData: tabsData },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error("sendMessage error:", chrome.runtime.lastError);
          }
        }
      );

      // 立即显示成功（实际保存由 background 完成）
      btn.textContent = "✅ Sent!";
      setTimeout(() => {
        btn.textContent = origText;
        btn.disabled = false;
      }, 2000);

    } catch (e) {
      console.error("Save tab set error:", e);
      showStatus("status-msg", "Failed: " + e.message, "error");
      btn.textContent = origText;
      btn.disabled = false;
    }
  });
}

// ===================== Existing Bookmark =====================
async function checkExistingBookmark(token, url) {
  try {
    const data = await (await fetch(`https://api.pinboard.in/v1/posts/get?url=${enc(url)}&auth_token=${token}&format=json`)).json();
    if (data.posts?.length > 0) {
      existingBookmark = data.posts[0];
      document.getElementById("title-input").value = existingBookmark.description;
      document.getElementById("description-input").value = existingBookmark.extended;
      document.getElementById("private-check").checked = existingBookmark.shared === "no";
      document.getElementById("readlater-check").checked = existingBookmark.toread === "yes";
      if (existingBookmark.tags?.trim()) existingBookmark.tags.split(" ").forEach((t) => { if (t.trim()) addTag(t.trim()); });
      document.getElementById("submit-btn").textContent = "Update";
      document.getElementById("delete-btn").classList.remove("hidden");
      updateCharCount();
    }
  } catch (e) { console.error(e); }
}

// ===================== Suggest Tags =====================
async function fetchPinboardSuggestTags(token, url) {
  const container = document.getElementById("pinboard-suggest-tags");
  try {
    const data = await (await fetch(`https://api.pinboard.in/v1/posts/suggest?url=${enc(url)}&auth_token=${token}&format=json`)).json();
    container.innerHTML = "";
    const popular = data[0]?.popular || [];
    const recommended = data[1]?.recommended || [];
    if (!popular.length && !recommended.length) { container.innerHTML = '<span class="muted">no suggestions</span>'; return; }

    if (popular.length) {
      const g = document.createElement("div"); g.className = "suggest-group";
      let h = '<span class="group-label">popular:</span>';
      popular.forEach((t) => { h += `<span class="stag" data-tag="${esc(t)}">${esc(t)}</span> `; });
      g.innerHTML = h; container.appendChild(g);
    }
    if (recommended.length) {
      const g = document.createElement("div"); g.className = "suggest-group";
      let h = '<span class="group-label">recommended:</span>';
      recommended.forEach((t) => { h += `<span class="stag" data-tag="${esc(t)}">${esc(t)}</span> `; });
      h += '<span class="add-all-link" id="add-all-suggest">Add all</span>';
      g.innerHTML = h; container.appendChild(g);
    }
    container.querySelectorAll(".stag").forEach((el) => {
      el.addEventListener("click", () => { addTag(el.dataset.tag); el.classList.add("used"); });
    });
    document.getElementById("add-all-suggest")?.addEventListener("click", () => {
      container.querySelectorAll(".stag:not(.used)").forEach((el) => { addTag(el.dataset.tag); el.classList.add("used"); });
    });
  } catch (e) { container.innerHTML = '<span class="muted">failed to load</span>'; }
}

async function fetchAllUserTags(token) {
  try { allUserTags = Object.keys(await (await fetch(`https://api.pinboard.in/v1/tags/get?auth_token=${token}&format=json`)).json()).sort(); }
  catch (e) { console.error(e); }
}

// ===================== Tags Input =====================
function setupTagsInput() {
  const input = document.getElementById("tags-input");
  const dropdown = document.getElementById("tags-autocomplete");
  input.addEventListener("input", () => {
    const val = input.value.trim().toLowerCase(); acIndex = -1;
    if (!val) { dropdown.classList.add("hidden"); return; }
    const matches = allUserTags.filter((t) => 
      t.toLowerCase().includes(val) &&
      !currentTags.some((ct) => ct.toLowerCase() === t.toLowerCase())
    ).slice(0, 10);
    if (!matches.length) { dropdown.classList.add("hidden"); return; }
    dropdown.innerHTML = "";
    matches.forEach((tag) => {
      const item = document.createElement("div"); item.className = "ac-item"; item.textContent = tag;
      item.addEventListener("click", () => { addTag(tag); input.value = ""; dropdown.classList.add("hidden"); input.focus(); });
      dropdown.appendChild(item);
    });
    dropdown.classList.remove("hidden");
  });
  input.addEventListener("keydown", (e) => {
    const items = dropdown.querySelectorAll(".ac-item");
    if (e.key === "ArrowDown") { e.preventDefault(); acIndex = Math.min(acIndex + 1, items.length - 1); updateAc(items); }
    else if (e.key === "ArrowUp") { e.preventDefault(); acIndex = Math.max(acIndex - 1, 0); updateAc(items); }
    else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      if (acIndex >= 0 && items[acIndex]) {
        // 用户已用方向键选中了某项
        addTag(items[acIndex].textContent);
      } else if (items.length > 0 && !dropdown.classList.contains("hidden")) {
        // ✅ 新增：下拉列表可见且有匹配项 → 自动选第一个
        addTag(items[0].textContent);
      } else if (input.value.trim()) {
        // 没有匹配项，按原逻辑添加输入内容
        input.value.trim().split(/[\s,]+/).forEach((t) => { if (t) addTag(t); });
      }
      input.value = ""; dropdown.classList.add("hidden");
    } else if (e.key === " ") {
      const v = input.value.trim();
      if (v) { e.preventDefault(); addTag(v); input.value = ""; dropdown.classList.add("hidden"); }
    } else if (e.key === "Backspace" && !input.value && currentTags.length) { removeTag(currentTags[currentTags.length - 1]); }
    else if (e.key === "Escape") { dropdown.classList.add("hidden"); }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".tags-input-wrap") && !e.target.closest(".autocomplete-dropdown")) dropdown.classList.add("hidden");
  });
}
function updateAc(items) { items.forEach((el, i) => el.classList.toggle("selected", i === acIndex)); }
function addTag(tag) {
  tag = tag.trim().replace(/\s+/g, "-");
  if (!tag) return;
  // 大小写不敏感去重：如果已存在相同 tag（忽略大小写），则跳过
  if (currentTags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
  currentTags.push(tag);
  renderTags();
}
function removeTag(tag) {
  currentTags = currentTags.filter((t) => t.toLowerCase() !== tag.toLowerCase());
  renderTags();
}
function renderTags() {
  const d = document.getElementById("tags-display"); d.innerHTML = "";
  currentTags.forEach((tag) => {
    const el = document.createElement("span"); el.className = "tag-item";
    el.innerHTML = `${esc(tag)}<span class="tag-remove">&times;</span>`;
    el.querySelector(".tag-remove").addEventListener("click", () => removeTag(tag));
    d.appendChild(el);
  });
}

// ===================== Submit / Delete =====================
function setupSubmit(token) {
  document.getElementById("submit-btn").addEventListener("click", async () => {
    const btn = document.getElementById("submit-btn"); btn.disabled = true; const orig = btn.textContent; btn.textContent = "Saving...";
    const url = document.getElementById("url-input").value;
    const title = document.getElementById("title-input").value;
    if (!url || !title) { showStatus("status-msg", "URL and Title required", "error"); btn.disabled = false; btn.textContent = orig; return; }
    try {
      const apiUrl = `https://api.pinboard.in/v1/posts/add?auth_token=${token}&format=json&url=${enc(url)}&description=${enc(title)}&extended=${enc(document.getElementById("description-input").value)}&tags=${enc(currentTags.join(" "))}&shared=${document.getElementById("private-check").checked ? "no" : "yes"}&toread=${document.getElementById("readlater-check").checked ? "yes" : "no"}&replace=yes`;
      const data = await (await fetch(apiUrl)).json();
      if (data.result_code === "done") {
        showStatus("status-msg", "Bookmark saved.", "success");
        // 通知 background 更新图标
        chrome.runtime.sendMessage({ type: "bookmark_saved", url: url });
        setTimeout(() => window.close(), 1000);
      } else showStatus("status-msg", `Error: ${data.result_code}`, "error");
    } catch (e) { showStatus("status-msg", "Network error", "error"); }
    btn.disabled = false; btn.textContent = orig;
  });

  document.getElementById("delete-btn").addEventListener("click", async () => {
    if (!confirm("Delete this bookmark?")) return;
    const url = document.getElementById("url-input").value;
    try {
      const data = await (await fetch(`https://api.pinboard.in/v1/posts/delete?url=${enc(url)}&auth_token=${token}&format=json`)).json();
      if (data.result_code === "done" || data.result_code === "item not found") {
        showStatus("status-msg", "Deleted.", "success");
        // 通知 background 更新图标
        chrome.runtime.sendMessage({ type: "bookmark_deleted", url: url });
        setTimeout(() => window.close(), 800);
      } else showStatus("status-msg", `Error: ${data.result_code}`, "error");
    } catch (e) { showStatus("status-msg", "Network error", "error"); }
  });
}

// ===================== AI Cache =====================
function getCacheKey(url, type) { return `ai_cache_${type}_${url}`; }
async function getAICache(url, type) {
  const key = getCacheKey(url, type);
  const data = await chrome.storage.local.get(key);
  if (!data[key]) return null;
  const { result, timestamp } = data[key];
  const dur = (settings.aiCacheDuration || 60) * 60 * 1000;
  if (dur === 0) return null;
  if (Date.now() - timestamp > dur) { await chrome.storage.local.remove(key); return null; }
  return result;
}
async function setAICache(url, type, result) {
  if ((settings.aiCacheDuration || 60) === 0) return;
  await chrome.storage.local.set({ [getCacheKey(url, type)]: { result, timestamp: Date.now() } });
}

// ===================== Prompt Builder =====================
function buildTagPrompt() {
  const tmpl = settings.customTagPrompt?.trim() || DEFAULT_TAG_PROMPT;
  return tmpl
    .replace(/\{\{title\}\}/g, document.getElementById("title-input").value)
    .replace(/\{\{url\}\}/g, document.getElementById("url-input").value)
    .replace(/\{\{content\}\}/g, (pageInfo.pageText || "").substring(0, 3000))
    .replace(/\{\{description\}\}/g, document.getElementById("description-input").value);
}
function buildSummaryPrompt() {
  const tmpl = settings.customSummaryPrompt?.trim() || DEFAULT_SUMMARY_PROMPT;
  let langInst = "Write in the same language as the content.";
  const lang = settings.aiSummaryLang || "auto";
  if (lang === "zh") langInst = "Write in Chinese (简体中文).";
  else if (lang === "en") langInst = "Write in English.";
  else if (lang === "ja") langInst = "Write in Japanese.";
  else if (lang === "ko") langInst = "Write in Korean.";
  else if (lang !== "auto") langInst = `Write in ${lang}.`;
  return tmpl
    .replace(/\{\{title\}\}/g, document.getElementById("title-input").value)
    .replace(/\{\{url\}\}/g, document.getElementById("url-input").value)
    .replace(/\{\{content\}\}/g, (pageInfo.pageText || "").substring(0, 5000))
    .replace(/\{\{description\}\}/g, document.getElementById("description-input").value)
    .replace(/\{\{lang_instruction\}\}/g, langInst);
}

// ===================== AI Features =====================
function setupAIFeatures() {
  // ---- AI Summary ----
  document.getElementById("ai-summary-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    await doAISummary(false, false);
  });

  // ---- AI Tags ----
  document.getElementById("ai-tags-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    await doAITags(false);
  });
}

// ---- AI Summary core logic (forceRefresh = bypass cache) ----
async function doAISummary(forceRefresh) {
  const btn = document.getElementById("ai-summary-btn");
  if (!hasAIKey()) { showStatus("status-msg", "Set AI API key in settings", "error"); return; }
  if (!pageInfo.pageText) { showStatus("status-msg", "No page content to summarize", "error"); return; }

  // Check cache (unless forcing refresh)
  if (!forceRefresh) {
    const cached = await getAICache(pageInfo.url, "summary");
    if (cached) {
      appendSummary(cached);
      showSummaryCacheHint();
      return;
    }
  }

  btn.textContent = "summarizing..."; btn.classList.add("loading");
  try {
    const summary = await callAI(buildSummaryPrompt());
    await setAICache(pageInfo.url, "summary", summary);
    appendSummary(summary);
    showStatus("status-msg", forceRefresh ? "Summary regenerated" : "Summary generated", "success");
  } catch (e) {
    showStatus("status-msg", `AI error: ${e.message}`, "error");
  }
  btn.textContent = "🤖 AI summary"; btn.classList.remove("loading");
}

function showSummaryCacheHint() {
  // Show hint next to the summary button
  const bar = document.getElementById("ai-summary-btn").parentElement;
  // Remove old hint if exists
  bar.querySelector(".cache-hint-wrap")?.remove();

  const wrap = document.createElement("span");
  wrap.className = "cache-hint-wrap";
  wrap.innerHTML = `<span class="cache-hint">cached</span><a href="#" class="regen-link">↻ regenerate</a>`;
  bar.appendChild(wrap);

  wrap.querySelector(".regen-link").addEventListener("click", async (e) => {
    e.preventDefault();
    const link = e.currentTarget;
    link.textContent = "regenerating...";
    link.classList.add("loading");
    await doAISummary(true);
    wrap.remove(); // Remove hint after regeneration
  });
}

// AI summary: 用前置标签行来标识，Pinboard 上显示为自然的纯文本标题
const AI_SUMMARY_TAG = "[AI Summary]";
const AI_BQ_REGEX = /(\n\n)?\[AI Summary\]\n<blockquote>[\s\S]*?<\/blockquote>\s*$/;

// ---- Append summary (add to end of description) ----
function appendSummary(summary) {
  const di = document.getElementById("description-input");
  const cur = di.value.trim();
  const wrapped = `${AI_SUMMARY_TAG}\n<blockquote>${summary}</blockquote>`;

  // If there's already an AI summary block, replace it; otherwise append
  if (AI_BQ_REGEX.test(cur)) {
    di.value = cur.replace(AI_BQ_REGEX, "\n\n" + wrapped).replace(/^\n\n/, "");
  } else {
    di.value = cur ? cur + "\n\n" + wrapped : wrapped;
  }
  updateCharCount();
}

// ---- Replace only the AI-generated summary in description ----
function replaceSummary(summary) {
  const di = document.getElementById("description-input");
  const cur = di.value;
  const wrapped = `${AI_SUMMARY_TAG}\n<blockquote>${summary}</blockquote>`;

  if (AI_BQ_REGEX.test(cur)) {
    di.value = cur.replace(AI_BQ_REGEX, "\n\n" + wrapped).replace(/^\n\n/, "");
  } else {
    const trimmed = cur.trim();
    di.value = trimmed ? trimmed + "\n\n" + wrapped : wrapped;
  }
  updateCharCount();
}


// ---- AI Summary core logic (forceRefresh = bypass cache, replace = replace mode) ----
async function doAISummary(forceRefresh, replaceMode) {
  const btn = document.getElementById("ai-summary-btn");
  if (!hasAIKey()) { showStatus("status-msg", "Set AI API key in settings", "error"); return; }
  if (!pageInfo.pageText) { showStatus("status-msg", "No page content to summarize", "error"); return; }

  // Check cache (unless forcing refresh)
  if (!forceRefresh) {
    const cached = await getAICache(pageInfo.url, "summary");
    if (cached) {
      appendSummary(cached);
      showSummaryCacheHint();
      return;
    }
  }

  if (btn) {
    btn.textContent = "summarizing...";
    btn.classList.add("loading");
  }
  try {
    const summary = await callAI(buildSummaryPrompt());
    await setAICache(pageInfo.url, "summary", summary);

    if (replaceMode) {
      replaceSummary(summary);
    } else {
      appendSummary(summary);
    }

    const msg = replaceMode ? "Summary replaced" : (forceRefresh ? "Summary regenerated" : "Summary generated");
    showStatus("status-msg", msg, "success");
  } catch (e) {
    showStatus("status-msg", `AI error: ${e.message}`, "error");
  }
  if (btn) {
    btn.textContent = "🤖 AI summary";
    btn.classList.remove("loading");
  }
}

// ---- Show cache hint with regenerate + replace buttons ----
function showSummaryCacheHint() {
  const bar = document.getElementById("ai-summary-btn").parentElement;
  // Remove old hint if exists
  bar.querySelector(".cache-hint-wrap")?.remove();

  const wrap = document.createElement("span");
  wrap.className = "cache-hint-wrap";
  wrap.innerHTML = [
    '<span class="cache-hint">cached</span>',
    '<a href="#" class="regen-link" data-mode="append">↻ regenerate</a>',
    '<a href="#" class="regen-link" data-mode="replace">↻ regenerate &amp; replace</a>'
  ].join("");
  bar.appendChild(wrap);

  wrap.querySelectorAll(".regen-link").forEach((link) => {
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      const mode = e.currentTarget.dataset.mode;
      const isReplace = mode === "replace";

      // Disable all links in this hint
      wrap.querySelectorAll(".regen-link").forEach((l) => {
        l.classList.add("loading");
      });
      e.currentTarget.textContent = isReplace ? "replacing..." : "regenerating...";

      await doAISummary(true, isReplace);
      wrap.remove();
    });
  });
}

// ---- AI Tags core logic (forceRefresh = bypass cache) ----
async function doAITags(forceRefresh) {
  const btn = document.getElementById("ai-tags-btn");
  const container = document.getElementById("ai-suggest-tags");

  if (!hasAIKey()) {
    container.innerHTML = '<span class="muted">set AI key in <a href="#" class="go-settings">settings</a></span>';
    container.querySelector(".go-settings")?.addEventListener("click", (ev) => { ev.preventDefault(); chrome.runtime.openOptionsPage(); });
    return;
  }

  // Check cache (unless forcing refresh)
  if (!forceRefresh) {
    const cached = await getAICache(pageInfo.url, "tags");
    if (cached) {
      renderAITags(cached, true); // true = from cache
      return;
    }
  }

  // Only update button text if the button exists
  if (btn) {
    btn.textContent = "generating...";
    btn.classList.add("loading");
  }

  try {
    const resp = await callAI(buildTagPrompt());
    let tags = [];
    try {
      const m = resp.match(/\[[\s\S]*?\]/);
      if (m) tags = JSON.parse(m[0]);
    } catch (_) {
      tags = resp.split(/[,\n]/).map((t) => t.replace(/["[\]`]/g, "").trim()).filter(Boolean);
    }
    tags = tags.map((t) => t.toLowerCase().replace(/\s+/g, "-"));
    await setAICache(pageInfo.url, "tags", tags);
    renderAITags(tags, false); // false = freshly generated
    if (forceRefresh) {
      showStatus("status-msg", "Tags regenerated", "success");
    }
  } catch (e) {
    container.innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }

  // Restore button text if the button still exists
  if (btn) {
    btn.textContent = "generate";
    btn.classList.remove("loading");
  }
}


function renderAITags(tags, fromCache) {
  const container = document.getElementById("ai-suggest-tags");
  container.innerHTML = "";

  if (!tags.length) {
    container.innerHTML = '<span class="muted">no tags generated</span>';
    return;
  }

  // Tag items
  tags.forEach((tag) => {
    const el = document.createElement("span");
    el.className = "stag ai";
    el.textContent = tag;
    el.dataset.tag = tag;
    el.addEventListener("click", () => { addTag(tag); el.classList.add("used"); });
    container.appendChild(el);
  });

  // "Add all" link
  const aa = document.createElement("span");
  aa.className = "add-all-link";
  aa.textContent = "Add all";
  aa.addEventListener("click", () => {
    container.querySelectorAll(".stag:not(.used)").forEach((el) => { addTag(el.dataset.tag); el.classList.add("used"); });
  });
  container.appendChild(aa);

  // Cache hint + regenerate button (only when loaded from cache)
  if (fromCache) {
    const hintWrap = document.createElement("span");
    hintWrap.className = "cache-hint-wrap";
    hintWrap.style.display = "inline-block";
    hintWrap.style.marginLeft = "8px";
    hintWrap.innerHTML = `<span class="cache-hint">cached</span><a href="#" class="regen-link">↻ regenerate</a>`;
    container.appendChild(hintWrap);

    hintWrap.querySelector(".regen-link").addEventListener("click", async (e) => {
      e.preventDefault();
      const link = e.currentTarget;
      link.textContent = "regenerating...";
      link.classList.add("loading");
      await doAITags(true);
    });
  }
}

// ===================== Multi-provider AI =====================
function hasAIKey() {
  const p = settings.aiProvider || "gemini";
  if (p === "ollama") return true;
  const keyMap = { gemini: "geminiApiKey", openai: "openaiApiKey", claude: "claudeApiKey", deepseek: "deepseekApiKey", qwen: "qwenApiKey", minimax: "minimaxApiKey", openrouter: "openrouterApiKey", custom: "customApiKey" };
  return !!settings[keyMap[p]];
}

async function callAI(prompt) {
  const p = settings.aiProvider || "gemini";
  switch (p) {
    case "gemini": return callGemini(prompt);
    case "claude": return callClaude(prompt);
    case "openai": return callOpenAICompat(settings.openaiBaseUrl || "https://api.openai.com/v1", settings.openaiApiKey, settings.openaiModel || "gpt-4o-mini", prompt);
    case "deepseek": return callOpenAICompat("https://api.deepseek.com/v1", settings.deepseekApiKey, settings.deepseekModel || "deepseek-chat", prompt);
    case "qwen": return callOpenAICompat("https://dashscope.aliyuncs.com/compatible-mode/v1", settings.qwenApiKey, settings.qwenModel || "qwen-turbo", prompt);
    case "minimax": return callOpenAICompat("https://api.minimax.chat/v1", settings.minimaxApiKey, settings.minimaxModel || "MiniMax-Text-01", prompt);
    case "openrouter": return callOpenAICompat("https://openrouter.ai/api/v1", settings.openrouterApiKey, settings.openrouterModel || "google/gemini-2.0-flash-exp:free", prompt);
    case "ollama": return callOllama(prompt);
    case "custom": return callOpenAICompat(settings.customBaseUrl, settings.customApiKey, settings.customModel, prompt);
    default: throw new Error("Unknown provider: " + p);
  }
}

async function callGemini(prompt) {
  const model = settings.geminiModel || "gemini-2.0-flash";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.geminiApiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1024 } })
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `Gemini failed (${res.status})`); }
  return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": settings.claudeApiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: settings.claudeModel || "claude-sonnet-4-20250514", max_tokens: 1024, messages: [{ role: "user", content: prompt }] })
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `Claude failed (${res.status})`); }
  return (await res.json()).content?.[0]?.text?.trim() || "";
}

async function callOpenAICompat(baseUrl, apiKey, model, prompt) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST", headers,
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, max_tokens: 1024 })
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `API failed (${res.status})`); }
  return (await res.json()).choices?.[0]?.message?.content?.trim() || "";
}

async function callOllama(prompt) {
  const base = settings.ollamaBaseUrl || "http://localhost:11434";
  const res = await fetch(`${base.replace(/\/+$/, "")}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: settings.ollamaModel || "llama3", messages: [{ role: "user", content: prompt }], stream: false })
  });
  if (!res.ok) throw new Error(`Ollama failed (${res.status})`);
  return (await res.json()).message?.content?.trim() || "";
}

// ===================== Helpers =====================
function setupDescriptionCounter() { document.getElementById("description-input").addEventListener("input", updateCharCount); }
function updateCharCount() { document.getElementById("desc-char-count").textContent = document.getElementById("description-input").value.length; }
function showElement(id, text) { const el = document.getElementById(id); el.textContent = text; el.classList.remove("hidden"); }
function showStatus(id, text, type) { const el = document.getElementById(id); el.textContent = text; el.className = `status-msg ${type}`; el.classList.remove("hidden"); }
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function enc(s) { return encodeURIComponent(s); }
