// ============================================================
// Pinboard Bookmark Plus - Background Service Worker (v3.0)
// ============================================================

importScripts("shared.js", "ai.js");

// 图标路径
const ICONS_DEFAULT = {
  16: "icons/pin-default-16.png", 32: "icons/pin-default-32.png",
  48: "icons/pin-default-48.png", 128: "icons/pin-default-128.png"
};
const ICONS_BOOKMARKED = {
  16: "icons/pin-saved-16.png", 32: "icons/pin-saved-32.png",
  48: "icons/pin-saved-48.png", 128: "icons/pin-saved-128.png"
};

// URL 状态缓存
const statusCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// ---- Load settings with deobfuscation ----
async function loadSettings() {
  const s = await chrome.storage.sync.get({
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
    // Context menu settings
    ctxAutoNotes: true, ctxBlockquote: true, ctxDefaultTags: "",
    ctxAiTags: false, ctxAiSummary: false,
    // Quick save settings
    qsAutoNotes: true, qsBlockquote: true, qsDefaultTags: "",
    qsAiTags: false, qsAiSummary: false,
    // Notifications
    notifyContextMenu: true, notifyQuickSave: true,
    notifyTabSet: true, notifyBatchSave: true, notifyErrors: true
  });
  ["pinboardToken","geminiApiKey","openaiApiKey","claudeApiKey","deepseekApiKey","qwenApiKey","minimaxApiKey","openrouterApiKey","customApiKey"]
    .forEach(k => { if (s[k]) s[k] = deobfuscateKey(s[k]); });
  return s;
}

// ---- Show Chrome notification (with category filter) ----
async function showNotification(id, title, message, category) {
  try {
    const cats = await chrome.storage.sync.get({
      notifyContextMenu: true, notifyQuickSave: true,
      notifyTabSet: true, notifyBatchSave: true, notifyErrors: true
    });
    if (category === "contextMenu" && !cats.notifyContextMenu) return;
    if (category === "quickSave" && !cats.notifyQuickSave) return;
    if (category === "tabSet" && !cats.notifyTabSet) return;
    if (category === "batchSave" && !cats.notifyBatchSave) return;
    if (category === "error" && !cats.notifyErrors) return;
  } catch (_) {}
  chrome.notifications.create(id, {
    type: "basic", iconUrl: "icons/pin-default-48.png", title, message
  });
}

// ---- 设置图标 ----
async function setIcon(tabId, bookmarked) {
  try {
    await chrome.action.setIcon({ tabId, path: bookmarked ? ICONS_BOOKMARKED : ICONS_DEFAULT });
  } catch (_) {}
}

// ---- 检查 URL 是否已收藏 ----
async function checkBookmarked(url) {
  const cached = statusCache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.bookmarked;
  try {
    const s = await loadSettings();
    if (!s.pinboardToken) return false;
    const resp = await fetch(`https://api.pinboard.in/v1/posts/get?auth_token=${s.pinboardToken}&format=json&url=${encodeURIComponent(url)}`);
    const data = await resp.json();
    const bookmarked = data.posts && data.posts.length > 0;
    statusCache.set(url, { bookmarked, timestamp: Date.now() });
    return bookmarked;
  } catch (e) {
    console.error("checkBookmarked error:", e);
    return false;
  }
}

// ---- 标签页激活/更新时刷新图标 ----
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && tab.url.startsWith("http")) {
      setIcon(tabId, await checkBookmarked(tab.url));
    } else { setIcon(tabId, false); }
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && tab.url.startsWith("http")) {
    setIcon(tabId, await checkBookmarked(tab.url));
  }
});

// ---- 监听来自 popup 的消息 ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "bookmark_saved" && message.url) {
    statusCache.set(message.url, { bookmarked: true, timestamp: Date.now() });
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) setIcon(tab.id, true);
    }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "bookmark_deleted" && message.url) {
    statusCache.set(message.url, { bookmarked: false, timestamp: Date.now() });
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) setIcon(tab.id, false);
    }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "show_notification") {
    showNotification(message.id || "popup-notify", message.title || "Pinboard", message.message || "", message.category || "");
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === "saveTabSet" && message.tabsData) {
    handleSaveTabSet(message.tabsData);
    sendResponse({ status: "started" });
    return true;
  }
});

// ===================== Tab Set 保存 =====================
async function handleSaveTabSet(tabsData) {
  try {
    const result = { browser: "chrome", windows: [tabsData.map(t => ({ title: t.title, url: t.url }))] };
    const formData = new FormData();
    formData.append("data", JSON.stringify(result));
    const resp = await fetch("https://pinboard.in/tabs/save/", { method: "POST", body: formData, credentials: "include" });
    if (resp.ok) {
      chrome.tabs.create({ url: "https://pinboard.in/tabs/show/" });
      showNotification("tabset-saved", "Pinboard: Tab Set Saved!", `${tabsData.length} tabs saved.`, "tabSet");
    } else {
      const hint = resp.status === 401 || resp.status === 403
        ? "Please log in to pinboard.in in your browser first." : `HTTP ${resp.status}`;
      showNotification("tabset-error", "Pinboard: Tab Set Failed", hint, "error");
    }
  } catch (e) {
    showNotification("tabset-error", "Pinboard: Tab Set Failed", e.message, "error");
  }
}

// ===================== Context Menu =====================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-to-pinboard",
    title: "Save to Pinboard",
    contexts: ["page", "link"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || info.pageUrl;
  if (!url) return;

  try {
    const s = await loadSettings();
    if (!s.pinboardToken) {
      showNotification("pinboard-error", "Pinboard: Not logged in", "Set your API token in extension settings.", "error");
      return;
    }

    // Get title: for links use selection or link URL; for pages use tab title
    let title = info.linkUrl ? (info.selectionText || info.linkUrl) : (tab?.title || url);

    // Extract page info for AI and auto-notes (only if tab is available)
    let pageInfo = null;
    let notes = "";
    let tags = [];

    if (tab?.id) {
      try { pageInfo = await getPageInfoFromTab(tab.id); } catch (_) {}
    }

    // Build notes from page info
    if (pageInfo) {
      notes = buildAutoNotes(pageInfo, {
        autoDescription: s.ctxAutoNotes,
        blockquote: s.ctxBlockquote,
        includeReferrer: false
      });
    }

    // Default tags
    if (s.ctxDefaultTags) {
      tags = s.ctxDefaultTags.split(/[,\s]+/).map(t => t.trim()).filter(Boolean);
    }

    // AI features (run in parallel if both enabled)
    const aiPromises = [];
    if (pageInfo?.pageText && hasAIKey(s)) {
      if (s.ctxAiTags) {
        aiPromises.push(
          (async () => {
            try {
              const cached = await getAICache(url, "tags", s.aiCacheDuration);
              if (cached) return { type: "tags", result: cached };
              const prompt = buildTagPrompt(s, title, url, pageInfo.pageText, notes, []);
              const resp = await callAI(s, prompt);
              const aiTags = parseAITags(resp);
              await setAICache(url, "tags", aiTags, s.aiCacheDuration);
              return { type: "tags", result: aiTags };
            } catch (e) { console.warn("Context menu AI tags failed:", e.message); return null; }
          })()
        );
      }
      if (s.ctxAiSummary) {
        aiPromises.push(
          (async () => {
            try {
              const cached = await getAICache(url, "summary", s.aiCacheDuration);
              if (cached) return { type: "summary", result: cached };
              const prompt = buildSummaryPrompt(s, title, url, pageInfo.pageText, notes);
              const summary = await callAI(s, prompt);
              await setAICache(url, "summary", summary, s.aiCacheDuration);
              return { type: "summary", result: summary };
            } catch (e) { console.warn("Context menu AI summary failed:", e.message); return null; }
          })()
        );
      }
    }

    // Wait for AI results
    const aiResults = await Promise.all(aiPromises);
    for (const r of aiResults) {
      if (!r) continue;
      if (r.type === "tags") tags = [...tags, ...r.result];
      if (r.type === "summary") {
        const wrapped = `[AI Summary]\n<blockquote>${r.result}</blockquote>`;
        notes = notes ? notes + "\n\n" + wrapped : wrapped;
      }
    }

    // Save bookmark
    const apiUrl = `https://api.pinboard.in/v1/posts/add?auth_token=${s.pinboardToken}&format=json` +
      `&url=${encodeURIComponent(url)}&description=${encodeURIComponent(title)}` +
      `&extended=${encodeURIComponent(notes)}&tags=${encodeURIComponent(tags.join(" "))}&replace=yes`;
    const resp = await fetch(apiUrl);
    const data = await resp.json();

    if (data.result_code === "done") {
      statusCache.set(url, { bookmarked: true, timestamp: Date.now() });
      if (tab?.id) setIcon(tab.id, true);
      showNotification("pinboard-saved", "Pinboard: Saved!", `"${title.substring(0, 60)}" saved.`, "contextMenu");
    } else {
      showNotification("pinboard-error", "Pinboard: Save failed", data.result_code || "Unknown error", "error");
    }
  } catch (e) {
    showNotification("pinboard-error", "Pinboard: Network error", e.message, "error");
  }
});

// ===================== Quick Save (keyboard shortcut) =====================
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "quick_save") return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !tab.url.startsWith("http")) {
      showNotification("qs-error", "Pinboard: Cannot save", "This page cannot be bookmarked.", "error");
      return;
    }

    const s = await loadSettings();
    if (!s.pinboardToken) {
      showNotification("qs-error", "Pinboard: Not logged in", "Set your API token in extension settings.", "error");
      return;
    }

    const url = tab.url;
    const title = tab.title || url;

    // Extract page info
    let pageInfo = null;
    try { pageInfo = await getPageInfoFromTab(tab.id); } catch (_) {}

    // Build notes
    let notes = "";
    if (pageInfo) {
      notes = buildAutoNotes(pageInfo, {
        autoDescription: s.qsAutoNotes,
        blockquote: s.qsBlockquote,
        includeReferrer: false
      });
    }

    // Default tags
    let tags = [];
    if (s.qsDefaultTags) {
      tags = s.qsDefaultTags.split(/[,\s]+/).map(t => t.trim()).filter(Boolean);
    }

    // AI features (parallel)
    const aiPromises = [];
    if (pageInfo?.pageText && hasAIKey(s)) {
      if (s.qsAiTags) {
        aiPromises.push(
          (async () => {
            try {
              const cached = await getAICache(url, "tags", s.aiCacheDuration);
              if (cached) return { type: "tags", result: cached };
              const prompt = buildTagPrompt(s, title, url, pageInfo.pageText, notes, []);
              const resp = await callAI(s, prompt);
              const aiTags = parseAITags(resp);
              await setAICache(url, "tags", aiTags, s.aiCacheDuration);
              return { type: "tags", result: aiTags };
            } catch (e) { console.warn("Quick save AI tags failed:", e.message); return null; }
          })()
        );
      }
      if (s.qsAiSummary) {
        aiPromises.push(
          (async () => {
            try {
              const cached = await getAICache(url, "summary", s.aiCacheDuration);
              if (cached) return { type: "summary", result: cached };
              const prompt = buildSummaryPrompt(s, title, url, pageInfo.pageText, notes);
              const summary = await callAI(s, prompt);
              await setAICache(url, "summary", summary, s.aiCacheDuration);
              return { type: "summary", result: summary };
            } catch (e) { console.warn("Quick save AI summary failed:", e.message); return null; }
          })()
        );
      }
    }

    const aiResults = await Promise.all(aiPromises);
    for (const r of aiResults) {
      if (!r) continue;
      if (r.type === "tags") tags = [...tags, ...r.result];
      if (r.type === "summary") {
        const wrapped = `[AI Summary]\n<blockquote>${r.result}</blockquote>`;
        notes = notes ? notes + "\n\n" + wrapped : wrapped;
      }
    }

    // Save bookmark
    const apiUrl = `https://api.pinboard.in/v1/posts/add?auth_token=${s.pinboardToken}&format=json` +
      `&url=${encodeURIComponent(url)}&description=${encodeURIComponent(title)}` +
      `&extended=${encodeURIComponent(notes)}&tags=${encodeURIComponent(tags.join(" "))}&replace=yes`;
    const resp = await fetch(apiUrl);
    const data = await resp.json();

    if (data.result_code === "done") {
      statusCache.set(url, { bookmarked: true, timestamp: Date.now() });
      setIcon(tab.id, true);
      showNotification("qs-saved", "Pinboard: Quick Saved!", `"${title.substring(0, 60)}" saved.`, "quickSave");
    } else {
      showNotification("qs-error", "Pinboard: Save failed", data.result_code || "Unknown error", "error");
    }
  } catch (e) {
    showNotification("qs-error", "Pinboard: Quick Save failed", e.message, "error");
  }
});
