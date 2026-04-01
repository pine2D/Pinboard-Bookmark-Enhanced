// ============================================================
// Pinboard Bookmark Plus - Background Service Worker (v2.1)
// ============================================================

// 图标路径
const ICONS_DEFAULT = {
  16: "icons/pin-default-16.png",
  32: "icons/pin-default-32.png",
  48: "icons/pin-default-48.png",
  128: "icons/pin-default-128.png"
};
const ICONS_BOOKMARKED = {
  16: "icons/pin-saved-16.png",
  32: "icons/pin-saved-32.png",
  48: "icons/pin-saved-48.png",
  128: "icons/pin-saved-128.png"
};

// 缓存已查询过的 URL 状态
const statusCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

// ---- 设置图标（修复：防止 tab 已关闭导致报错） ----
async function setIcon(tabId, bookmarked) {
  try {
    await chrome.action.setIcon({
      tabId,
      path: bookmarked ? ICONS_BOOKMARKED : ICONS_DEFAULT
    });
  } catch (e) {
    // tab 可能已关闭，忽略
  }
}

// ---- 检查 URL 是否已收藏 ----
async function checkBookmarked(url) {
  const cached = statusCache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.bookmarked;

  try {
    const { pinboardToken } = await chrome.storage.sync.get("pinboardToken");
    if (!pinboardToken) return false;
    const apiUrl = `https://api.pinboard.in/v1/posts/get?auth_token=${pinboardToken}&format=json&url=${encodeURIComponent(url)}`;
    const resp = await fetch(apiUrl);
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
      const b = await checkBookmarked(tab.url);
      setIcon(tabId, b);
    } else {
      setIcon(tabId, false);
    }
  } catch (e) { /* ignore */ }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && tab.url.startsWith("http")) {
    const b = await checkBookmarked(tab.url);
    setIcon(tabId, b);
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

  // Tab Set 保存
  if (message.action === "saveTabSet" && message.tabsData) {
    handleSaveTabSet(message.tabsData);
    sendResponse({ status: "started" });
    return true;
  }
});

// ===================== Tab Set 保存（由 popup 触发） =====================

async function handleSaveTabSet(tabsData) {
  try {
    // 构造与 Pinboard 官方扩展一致的数据格式
    const result = {
      browser: "chrome",
      windows: [
        tabsData.map(t => ({ title: t.title, url: t.url }))
      ]
    };

    console.log("[TabSet] Submitting:", JSON.stringify(result));

    // 用 fetch 直接 POST（background service worker 共享 pinboard.in 的 cookie）
    const formData = new FormData();
    formData.append("data", JSON.stringify(result));

    const resp = await fetch("https://pinboard.in/tabs/save/", {
      method: "POST",
      body: formData,
      credentials: "include"  // 携带 cookie
    });

    if (resp.ok) {
      console.log("[TabSet] Saved successfully, tabs:", tabsData.length);
      // 打开 tab set 展示页
      chrome.tabs.create({ url: "https://pinboard.in/tabs/show/" });
    } else {
      console.error("[TabSet] Save failed, status:", resp.status);
    }

  } catch (e) {
    console.error("[TabSet] Save failed:", e);
  }
}