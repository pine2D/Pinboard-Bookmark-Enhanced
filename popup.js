// ============================================================
// Pinboard Bookmark Enhanced - Popup (v2.3)
// ============================================================


// Override pinboardFetch to route through background service worker.
// This prevents Chrome's native credentials dialog when Pinboard returns 401.
// (function declarations on window are writable, so reassignment works)
pinboardFetch = function(url, options) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "pinboard_api_call", url, options: options || null })
      .then(resp => {
        if (!resp) { reject(new Error("no background response")); return; }
        if (resp.status === 401) {
          // Invalid token — redirect to login instead of letting Chrome show the auth dialog
          (async () => {
            try { await (await getSettingsStorage()).remove("pinboardToken"); } catch (_) {}
          })();
          showLogin();
          // Return a dummy resolved response so call sites don't also throw
          resolve({ ok: false, status: 401, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
          return;
        }
        resolve({
          ok: resp.ok,
          status: resp.status,
          json: () => { try { return Promise.resolve(JSON.parse(resp.text || "{}")); } catch { return Promise.resolve({}); } },
          text: () => Promise.resolve(resp.text || "")
        });
      })
      .catch(reject);
  });
};

let currentTags = [];
let allUserTags = [];
let allUserTagCounts = {};
let tagCaseMap = {};
let pageInfo = {};
let existingBookmark = null;
let acIndex = -1;
let settings = {};

// ===================== URL Clean Helpers (B4) =====================
// urlClean is loaded as part of SETTINGS_DEFAULTS — no separate storage hit needed.
// Also fixes a latent bug: the previous direct chrome.storage.sync.get bypassed the
// optSyncEnabled toggle, so users with sync disabled would have read defaults instead
// of their saved values (options.js writes via getSettingsStorage, which respects the toggle).
function _loadUrlCleanSettings() {
  return settings.urlClean || { enabled: true, onPopupOpen: true, onPaste: true, aggressiveMode: false, customParams: [], excludeParams: [] };
}

function _renderCleanHint({ removedCount, original }) {
  const hint = $id("url-clean-hint");
  if (!hint) return;
  while (hint.firstChild) hint.removeChild(hint.firstChild);
  if (removedCount <= 0) { hint.classList.add("hidden"); return; }
  hint.classList.remove("hidden");
  const label = document.createElement("span");
  label.textContent = t("urlCleanedN").replace("{n}", removedCount);
  const sep = document.createElement("span");
  sep.textContent = "·";
  const link = document.createElement("a");
  link.textContent = t("urlShowOriginal");
  link.addEventListener("click", (e) => {
    e.preventDefault();
    $id("url-input").value = original;
    hint.classList.add("hidden");
  });
  hint.appendChild(label); hint.appendChild(sep); hint.appendChild(link);
}

document.addEventListener("DOMContentLoaded", async () => {
  document.querySelectorAll(".btn-ic[data-ic]").forEach(s => { s.innerHTML = PBP_ICONS[s.dataset.ic] || ""; });
  initI18n();
  applyI18n();

  // B4: validate tab-data mirror against chrome.storage.session._currentTab
  // (set by SW on tab change). If mismatched (tabId or ts > 60s), clear prefill.
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const sess = await chrome.storage.session.get("_currentTab");
    const _currentTab = sess._currentTab;
    const mirrorFresh = _currentTab && _currentTab.ts && (Date.now() - _currentTab.ts < 60000);
    if (!mirrorFresh || !activeTab || _currentTab?.tabId !== activeTab.id) {
      const u = document.getElementById("url-input");
      const ti = document.getElementById("title-input");
      const banner = document.getElementById("existing-banner");
      if (u && !document.activeElement?.isSameNode(u)) u.value = "";
      if (ti && !document.activeElement?.isSameNode(ti)) ti.value = "";
      if (banner && banner.dataset.mirror === "1") {
        banner.classList.add("hidden");
        delete banner.dataset.mirror;
      }
    }
  } catch (_) {}

  settings = await (await getSettingsStorage()).get(SETTINGS_DEFAULTS);
  deobfuscateSettings(settings);

  // Apply theme: preset-based data-theme (if enabled), or fallback to generic .dark
  function applyTheme() {
    const prefersDark = settings.optTheme === "dark" ||
      (settings.optTheme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const key = settings.optPopupFollowTheme !== false ? (settings.themePresetKey || "") : "";
    if (ADAPTIVE_THEME_MAP[key]) {
      const [light, dark] = ADAPTIVE_THEME_MAP[key];
      document.documentElement.dataset.theme = prefersDark ? dark : light;
      document.documentElement.classList.remove("dark");
    } else if (key) {
      document.documentElement.dataset.theme = key;
      document.documentElement.classList.remove("dark");
    } else {
      delete document.documentElement.dataset.theme;
      document.documentElement.classList.toggle("dark", prefersDark);
    }
  }
  applyTheme();
  if (settings.optTheme === "auto") {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  }

  if (!settings.pinboardToken) showLogin();
  else showMain(settings.pinboardToken);

  $id("options-link").addEventListener("click", (e) => {
    e.preventDefault(); chrome.runtime.openOptionsPage();
  });
  $id("logout-link").addEventListener("click", async (e) => {
    e.preventDefault();
    if (!confirm(t("confirmLogout"))) return;
    await (await getSettingsStorage()).remove("pinboardToken");
    settings.pinboardToken = "";
    $id("main-section").classList.add("hidden");
    showLogin();
  });
});

// ===================== Login =====================
function showLogin() {
  document.documentElement.dataset.section = "login";
  try { localStorage.removeItem("pp-logged-in"); } catch (_) {}
  $id("login-section").classList.remove("hidden");
  $id("main-section").classList.add("hidden");
  const qa = document.querySelector(".quick-actions");
  if (qa) qa.classList.add("hidden");
}
// Login listener — bound once outside showLogin() to avoid duplicate listeners
$id("login-btn").addEventListener("click", async () => {
  const token = $id("token-input").value.trim();
  if (!token || !token.includes(":")) { showElement("login-error", t("loginInvalidFormat")); return; }
  try {
    const res = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "test_pinboard_token", token }, (resp) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        resolve(resp);
      });
    });
    if (res.ok) { await (await getSettingsStorage()).set({ pinboardToken: obfuscateKey(token) }); settings.pinboardToken = token; showMain(token); }
    else showElement("login-error", t("loginFailed"));
  } catch (e) { showElement("login-error", t("networkError")); }
});

// ===================== Main =====================
async function showMain(token) {
  document.documentElement.dataset.section = "main";
  try { localStorage.setItem("pp-logged-in", "1"); } catch (_) {}
  $id("login-section").classList.add("hidden");
  $id("main-section").classList.remove("hidden");
  const qa = document.querySelector(".quick-actions");
  if (qa) qa.classList.remove("hidden");
  const username = token.split(":")[0];
  const userInfo = $id("user-info");
  userInfo.innerHTML = "";
  const pbLink = document.createElement("a");
  pbLink.href = "https://pinboard.in/";
  pbLink.target = "_blank";
  pbLink.textContent = "Pinboard";
  userInfo.appendChild(pbLink);
  userInfo.appendChild(document.createTextNode(` \u2014 ${username}`));
  const unreadLink = $id("unread-link");
  if (unreadLink) unreadLink.href = `https://pinboard.in/u:${encodeURIComponent(username)}/unread/`;

  if (!settings.optShowSearch) {
    const searchRow = document.querySelector(".search-row");
    if (searchRow) searchRow.classList.add("hidden");
  }
  if (settings.optShowAiSummary === false) {
    const aiSummaryBtn = $id("ai-summary-btn");
    if (aiSummaryBtn) aiSummaryBtn.classList.add("hidden");
    const aiSummaryHint = $id("ai-summary-hint");
    if (aiSummaryHint) aiSummaryHint.classList.add("hidden");
  }
  if (settings.optShowAiTags === false) {
    const aiTagsBox = $id("ai-suggest-tags");
    const aiTagsRow = aiTagsBox ? aiTagsBox.closest(".row") : null;
    if (aiTagsRow) aiTagsRow.classList.add("hidden");
  }
  if (settings.optShowQuickLinks === false) {
    const ql = document.querySelector(".quick-links");
    if (ql) ql.classList.add("hidden");
  }
  if (settings.optShowQuickRow === false) {
    const qr = document.querySelector(".quick-row");
    if (qr) qr.classList.add("hidden");
  }
  const searchInput = $id("search-input");
  if (searchInput) {
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && searchInput.value.trim()) {
        chrome.tabs.create({ url: `https://pinboard.in/search/u:${username}?query=${enc(searchInput.value.trim())}` });
      }
    });
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Fill URL/Title immediately from tab info so the form isn't visibly blank while the
  // (slow) content-script injection runs. Tracking-param strip + selectedText/meta arrive later.
  if (tab) {
    $id("url-input").value = tab.url || "";
    $id("title-input").value = tab.title || "";
  }
  // Kick off page-info extraction AND the bookmark cache lookup in parallel — both depend
  // only on `tab` (already obtained). Awaiting them sequentially wastes overlap potential.
  // Bookmark prefetch is keyed on tab.url (best-effort); if pageInfo later resolves to a
  // different URL, checkExistingBookmark falls back to a fresh fetch.
  const _pageInfoPromise = tab ? getPageInfoFromTab(tab.id) : Promise.resolve(null);
  const _bookmarkPrefetchUrl = tab?.url || "";
  const _bookmarkPrefetchPromise = _bookmarkPrefetchUrl
    ? chrome.runtime.sendMessage({ type: "get_bookmark_data", url: _bookmarkPrefetchUrl }).catch(() => null)
    : Promise.resolve(null);
  if (!tab) {
    pageInfo = { url: "", title: "", selectedText: "", metaDescription: "", referrer: "", pageText: "" };
  } else {
    pageInfo = (await _pageInfoPromise) || {
      url: tab.url || "", title: tab.title || "", selectedText: "", metaDescription: "", referrer: "", pageText: ""
    };
  }

  const _ucs = await _loadUrlCleanSettings();
  if (_ucs.enabled && _ucs.onPopupOpen && pageInfo.url) {
    const { cleaned, removedCount, original } = stripTrackingParams(pageInfo.url, _ucs);
    $id("url-input").value = cleaned;
    _renderCleanHint({ removedCount, original });
  } else {
    $id("url-input").value = pageInfo.url;
  }
  $id("title-input").value = pageInfo.title;

  // Check if URL is supported by Pinboard
  // Tab set & batch save work regardless of current page URL
  setupTabSet();

  const isUnsupportedUrl = !pageInfo.url || (!pageInfo.url.startsWith("http://") && !pageInfo.url.startsWith("https://"));
  if (isUnsupportedUrl) {
    $id("url-warning").classList.remove("hidden");
    $id("url-input").value = "";
    $id("title-input").value = "";
    $id("submit-btn").disabled = true;
    $id("submit-btn").title = t("urlCannotSave");
    $id("ai-summary-btn").classList.add("disabled-link");
    $id("ai-tags-btn").classList.add("disabled-link");
    return;
  }

  $id("url-input").addEventListener("input", () => {
    const val = $id("url-input").value.trim();
    const bad = !val || (!val.startsWith("http://") && !val.startsWith("https://"));
    $id("url-warning").classList.toggle("hidden", !bad);
    $id("submit-btn").disabled = bad;
    updateCharCount();
  });
  $id("title-input").addEventListener("input", updateCharCount);

  $id("url-input").addEventListener("paste", async (e) => {
    const settings = await _loadUrlCleanSettings();
    if (!settings.enabled || !settings.onPaste) return;
    const pasted = e.clipboardData?.getData("text") || "";
    if (!pasted) return;
    const { cleaned, removedCount, original } = stripTrackingParams(pasted, settings);
    if (removedCount > 0) {
      e.preventDefault();
      $id("url-input").value = cleaned;
      // dispatch input event so any input listeners pick up the change
      $id("url-input").dispatchEvent(new Event("input", { bubbles: true }));
      showFeedback({
        variant: "success",
        message: t("urlPasteCleanedN").replace("{n}", removedCount),
        actions: [{
          label: t("undo"),
          onClick: (card) => {
            $id("url-input").value = original;
            $id("url-input").dispatchEvent(new Event("input", { bubbles: true }));
            card.classList.add("dismissing");
            setTimeout(() => card.remove(), 120);
          }
        }],
        autoHide: 1800,
      });
    }
  });

  let desc = "";
  if (pageInfo.selectedText) {
    desc = settings.optBlockquote ? `<blockquote>${pageInfo.selectedText}</blockquote>` : pageInfo.selectedText;
  } else if (settings.optAutoDescription !== false && pageInfo.metaDescription) { desc = pageInfo.metaDescription; }
  if (settings.optIncludeReferrer && pageInfo.referrer) { desc += (desc ? "\n\n" : "") + `via: ${pageInfo.referrer}`; }
  $id("description-input").value = desc;
  updateCharCount();
  setTimeout(() => autoResizeTextarea($id("description-input")), 50);

  if (settings.optPrivateDefault) $id("private-check").checked = true;
  if (settings.optPrivateIncognito && tab.incognito) $id("private-check").checked = true;
  if (settings.optReadlaterDefault) $id("readlater-check").checked = true;

  // Setup UI features immediately — don't block on network requests
  setupTagsInput();
  setupSubmit(token);
  setupAIFeatures();
  setupDescriptionCounter();
  setupTagPresets();

// ---- Local Markdown extraction via Defuddle ----
// Uses _cbExecuteScript from ai.js to consume chrome.runtime.lastError via
// callback — promise form leaks "Unchecked runtime.lastError: No tab with id"
// when tab closes mid-injection (see ai.js:_cbExecuteScript for detail).
async function extractLocalMarkdown(tabId) {
  const injectRes = await _cbExecuteScript({ target: { tabId }, files: ["vendor/defuddle.js"] });
  if (!injectRes) return { error: "Cannot access this page" };
  try {
    const results = await _cbExecuteScript({
      target: { tabId },
      func: () => {
        if (typeof Defuddle === "undefined") return { error: "Defuddle not available" };
        // Patch window.URL in the ISOLATED world to prevent defuddle from
        // throwing "Failed to construct 'URL': Invalid URL" on relative/weird hrefs
        // (GitHub pages etc.). Defuddle is UMD and resolves `URL` at runtime, so this
        // interception works. Only affects isolated world; page's window.URL untouched.
        const OriginalURL = window.URL;
        if (!window.__pp_urlShimInstalled) {
          const SafeURL = function(u, b) {
            try { return b !== undefined ? new OriginalURL(u, b) : new OriginalURL(u); }
            catch (_) { return new OriginalURL("about:blank"); }
          };
          SafeURL.prototype = OriginalURL.prototype;
          try { SafeURL.createObjectURL = OriginalURL.createObjectURL.bind(OriginalURL); } catch (_) {}
          try { SafeURL.revokeObjectURL = OriginalURL.revokeObjectURL.bind(OriginalURL); } catch (_) {}
          try { SafeURL.canParse = OriginalURL.canParse && OriginalURL.canParse.bind(OriginalURL); } catch (_) {}
          window.URL = SafeURL;
          window.__pp_urlShimInstalled = true;
        }
        try {
          const clone = document.cloneNode(true);
          // Suppress Defuddle's internal console.error for malformed schema.org JSON on third-party pages
          const _origCE = console.error;
          console.error = (...a) => { if (!String(a[0]).startsWith("Defuddle:")) _origCE.apply(console, a); };
          let result;
          try { result = new Defuddle(clone).parse(); } finally { console.error = _origCE; }
          if (!result?.content) return { error: "No content extracted" };
          return { contentHtml: result.content, title: result.title || document.title, url: location.href };
        } catch (e) { return { error: e.message }; }
      }
    });
    if (results?.[0]?.result) return results[0].result;
    return { error: "Script execution failed" };
  } catch (e) { return { error: e.message }; }
}

// Lazy-load Turndown library on demand (saves ~27KB from popup startup)
let _turndownLoadPromise = null;
function ensureTurndown() {
  if (typeof TurndownService !== "undefined") return Promise.resolve();
  if (_turndownLoadPromise) return _turndownLoadPromise;
  _turndownLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/turndown.js";
    s.onload = () => resolve();
    s.onerror = () => { _turndownLoadPromise = null; reject(new Error("turndown load failed")); };
    document.head.appendChild(s);
  });
  return _turndownLoadPromise;
}

// Convert HTML to Markdown for clipboard. Lazy-loads Turndown, then
// delegates to the shared global htmlToMarkdown() from md-convert.js.
async function htmlToMarkdownAsync(html, opts) {
  try { await ensureTurndown(); } catch (_) { return html; }
  return htmlToMarkdown(html, opts);
}

  // ---- Markdown export button ----
  const jinaMdBtn = $id("jina-md-btn");
  if (jinaMdBtn) {
    jinaMdBtn.title = settings.aiContentSource === "jina" ? t("jinaMarkdownTitleJina") : t("jinaMarkdownTitle");
    // Disable on non-http pages
    const currentUrl = $id("url-input")?.value || "";
    if (!currentUrl.startsWith("http://") && !currentUrl.startsWith("https://")) {
      jinaMdBtn.disabled = true;
      jinaMdBtn.title = "Only works on web pages";
    }
    jinaMdBtn.addEventListener("click", async () => {
      if (jinaMdBtn.disabled) return;
      const url = $id("url-input").value;
      if (!url) return;

      const origLabel = t("jinaMarkdownBtn");
      setBtnIcon(jinaMdBtn, "doc", t("jinaConverting"));
      jinaMdBtn.disabled = true;

      let result;
      if (settings.aiContentSource === "jina") {
        const jinaKey = settings.jinaApiKey ? deobfuscateKey(settings.jinaApiKey) : "";
        result = await fetchJinaMarkdown(url, { apiKey: jinaKey, cacheDuration: settings.aiCacheDuration });
        if (!result.error) result._hasApiKey = !!jinaKey;
      } else {
        result = await extractLocalMarkdown(tab.id);
        if (!result.error) result._hasApiKey = false;
      }

      if (result.error) {
        jinaMdBtn.innerHTML = PBP_ICONS.cross + " " + t("jinaFailed");
        jinaMdBtn.title = result.error;
        // Persistent, specific status — so the user can tell API-key vs other failures
        if (settings.aiContentSource === "jina" && result.authFailed) {
          showStatus("status-msg", t("jinaAuthFailed"), "error");
        } else {
          showStatus("status-msg", t("jinaFailedDetail", result.error), "error");
        }
        setTimeout(() => { setBtnIcon(jinaMdBtn, "doc", origLabel); jinaMdBtn.disabled = false; jinaMdBtn.title = ""; }, 2000);
        return;
      }

      // Convert to markdown (Jina already has it, Local needs Turndown)
      const markdown = result.markdown || await htmlToMarkdownAsync(result.contentHtml, { baseUrl: result.url || url });

      // Reveal the action strip; the user picks Copy / Preview / Download / Obsidian.
      // No auto-copy: clicking Markdown must not silently clobber the clipboard, nor be
      // aborted by a clipboard failure when the user only wanted preview/download/Obsidian.
      const copyMd = async (e) => {
        const btn = e.currentTarget;
        const lbl = btn.querySelector("span:last-child");
        if (btn._t) clearTimeout(btn._t);
        if (btn._orig == null) btn._orig = lbl ? lbl.textContent : "";
        try {
          await navigator.clipboard.writeText(markdown);
          if (lbl) lbl.textContent = t("jinaCopied");
          btn.classList.add("copied");
        } catch (_) {
          if (lbl) lbl.textContent = t("jinaFailed");
        }
        btn._t = setTimeout(() => { if (lbl) lbl.textContent = btn._orig; btn.classList.remove("copied"); btn._orig = null; }, 1500);
      };
      const openPreview = async () => {
        await chrome.storage.local.set({
          md_preview_data: {
            markdown: markdown || "",
            contentHtml: result.contentHtml || "",
            title: result.title || $id("title-input")?.value || "",
            url: result.url || url,
            baseUrl: result.url || url,
            tags: Array.isArray(currentTags) ? currentTags.slice() : [],
            tokens: result.tokens || 0,
            hasApiKey: !!result._hasApiKey,
            source: settings.aiContentSource || "local"
          }
        });
        chrome.tabs.create({ url: "md-preview.html" });
      };
      const downloadMd = () => {
        const meta = {
          title: result.title || $id("title-input")?.value || "",
          url: result.url || url,
          date: (() => { const d = new Date(); const p = (n) => (n < 10 ? "0" : "") + n; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); })(),
          tags: Array.isArray(currentTags) ? currentTags.slice() : [],
          source: settings.aiContentSource === "jina" ? "jina" : "defuddle"
        };
        const out = composeExport(markdown, meta, {
          frontmatter: settings.mdExportFrontmatter,
          imagePolicy: settings.mdExportImagePolicy,
          includeToc: settings.mdExportIncludeToc
        });
        downloadFile(safeFilename(meta.title) + ".md", out, "text/markdown;charset=utf-8");
      };
      const sendObsidian = async () => {
        const meta = {
          title: result.title || $id("title-input")?.value || "",
          url: result.url || url,
          date: (() => { const d = new Date(); const p = (n) => (n < 10 ? "0" : "") + n; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); })(),
          tags: Array.isArray(currentTags) ? currentTags.slice() : [],
          source: settings.aiContentSource === "jina" ? "jina" : "defuddle"
        };
        const out = composeExport(markdown, meta, {
          frontmatter: settings.mdExportFrontmatter,
          imagePolicy: settings.mdExportImagePolicy,
          includeToc: settings.mdExportIncludeToc
        });
        let usedClipboard = false;
        try { await navigator.clipboard.writeText(out); usedClipboard = true; } catch (_) {}
        const uri = buildObsidianUri({
          vault: settings.obsidianVault,
          folder: settings.obsidianFolder,
          name: safeFilename(meta.title),
          clipboard: usedClipboard,
          content: usedClipboard ? "" : out
        });
        window.open(uri, "_blank");
      };
      const strip = $id("md-actions-strip");
      if (strip) {
        strip.classList.remove("hidden");
        strip.scrollIntoView({ behavior: "smooth", block: "nearest" });
        const copyBtn = $id("md-strip-copy");
        const previewBtn = $id("md-strip-preview");
        const dlBtn = $id("md-strip-dl");
        // Assign (not addEventListener) so re-clicks don't stack handlers.
        if (copyBtn) copyBtn.onclick = copyMd;
        if (previewBtn) previewBtn.onclick = openPreview;
        if (dlBtn) dlBtn.onclick = downloadMd;
        const obsBtn = $id("md-strip-obsidian");
        const dlLabel = dlBtn?.querySelector("span:last-child");
        if (settings.obsidianEnabled) {
          if (obsBtn) { obsBtn.style.display = ""; obsBtn.onclick = sendObsidian; }
          if (dlLabel) dlLabel.textContent = ".md";
        } else if (obsBtn) {
          obsBtn.style.display = "none";
        }
      }

      // No "Copied" state on the main button now — revert as soon as the strip is shown.
      setBtnIcon(jinaMdBtn, "doc", origLabel);
      jinaMdBtn.disabled = false;
    });
  }

  // Fetch all user tags first (cache hit is instant, populates tagCaseMap for case resolution)
  fetchAllUserTags(token).then(() => {
    if (settings.optAiAutoTags && settings.optShowAiTags !== false && hasAIKey(settings)) $id("ai-tags-btn").click();
  });
  // Suggest tags — enqueue after user tags so tagCaseMap is ready
  if (settings.optShowSuggestTags) {
    $id("suggest-row").classList.remove("hidden");
    fetchPinboardSuggestTags(token, pageInfo.url);
  }
  // Bookmark check — non-blocking, updates UI when ready.
  // Pass the prefetched cache promise (started right after popup-form-ready) so the
  // service-worker round-trip overlaps with getPageInfoFromTab instead of running after it.
  checkExistingBookmark(token, pageInfo.url, {
    prefetchUrl: _bookmarkPrefetchUrl,
    prefetchPromise: _bookmarkPrefetchPromise,
  });
  // Recent bookmarks — lowest priority, enqueue last
  if (settings.optShowRecent) fetchRecentBookmarks(token);

  document.querySelector(".tags-input-wrap")?.addEventListener("click", () => $id("tags-input").focus());
  showOfflineQueueStatus();

  // Focus optimization: tags input for new bookmarks, description for existing
  setTimeout(() => {
    if (existingBookmark) $id("description-input").focus();
    else $id("tags-input").focus();
  }, 100);
}

// ===================== Existing Bookmark =====================
// prefetch (optional): { prefetchUrl, prefetchPromise } — a get_bookmark_data lookup
// kicked off in parallel from showMain. Used only when prefetchUrl matches the url we
// actually need (else a stale prefetch would mislead). Misses fall back to a live fetch.
async function checkExistingBookmark(token, url, prefetch) {
  try {
    let data;
    try {
      let cached;
      if (prefetch && prefetch.prefetchUrl === url && prefetch.prefetchPromise) {
        cached = await prefetch.prefetchPromise;
      } else {
        cached = await chrome.runtime.sendMessage({ type: "get_bookmark_data", url });
      }
      if (cached?.posts) data = { posts: cached.posts };
    } catch (_) {}
    if (!data) {
      const resp = await pinboardFetch(`https://api.pinboard.in/v1/posts/get?url=${enc(url)}&auth_token=${token}&format=json`);
      if (resp.status === 401) return; // pinboardFetch already redirected to login
      if (resp.status === 0) return;   // network unreachable (offline / blocked / proxy) — the SW
                                       // proxy returns status 0 on a failed fetch. Skip the
                                       // existing-bookmark lookup silently; saving still works
                                       // (offline queue) and surfacing a red "HTTP 0" is just noise.
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.json();
    }
    if (data.posts?.length > 0) {
      existingBookmark = data.posts[0];
      $id("title-input").value = existingBookmark.description;
      $id("description-input").value = existingBookmark.extended;
      $id("private-check").checked = existingBookmark.shared === "no";
      $id("readlater-check").checked = existingBookmark.toread === "yes";
      currentTags = [];
      renderTags();
      if (existingBookmark.tags?.trim()) existingBookmark.tags.split(" ").filter(Boolean).forEach((t) => { if (t.trim()) addTag(t.trim()); });
      $id("submit-btn").textContent = t("update");
      $id("delete-btn").classList.remove("hidden");
      updateCharCount();
      setTimeout(() => autoResizeTextarea($id("description-input")), 50);
      const banner = $id("existing-banner");
      const timeStr = existingBookmark.time;
      if (banner) {
        let info = t("editingExisting");
        const parts = [];
        if (timeStr) {
          const d = new Date(timeStr);
          parts.push(t("savedOnDate", d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })));
        }
        const tagCount = existingBookmark.tags?.trim() ? existingBookmark.tags.trim().split(/\s+/).length : 0;
        if (tagCount > 0) parts.push(tagCount > 1 ? t("tagCountPlural", String(tagCount)) : t("tagCount", String(tagCount)));
        if (parts.length) info += " (" + parts.join(", ") + ")";
        banner.textContent = info;
        banner.classList.remove("hidden");
      }
    }
  } catch (e) { console.error("user info banner error:", e); }
  // B4: Write tab mirror for next popup boot.
  // Stores public-on-pinboard data (url/title/tags) only — no tokens or keys.
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.url) {
      const banner = document.getElementById("existing-banner");
      const mirror = {
        tabId: activeTab.id,
        url: $id("url-input").value || activeTab.url,
        title: $id("title-input").value || activeTab.title || "",
        bannerText: (banner && !banner.classList.contains("hidden")) ? (banner.textContent || "") : "",
        ts: Date.now()
      };
      localStorage.setItem("pp-last-tab", JSON.stringify(mirror));
    }
  } catch (_) {}
}

// ===================== Submit / Delete =====================
function setupSubmit(token) {
  let autoCloseTimer = null;

  // Submit state machine: idle -> loading -> success -> idle / loading -> error -> idle (user retry resets)
  const btn = $id("submit-btn");
  let submitOriginalText = btn.textContent;
  let submitErrorResetTimer = null;

  function setSubmitState(state, label) {
    btn.classList.remove("loading", "saved-success", "save-error");
    if (state === "loading") {
      btn.disabled = true;
      btn.classList.add("loading");
      btn.textContent = label || t("saving");
    } else if (state === "success") {
      btn.disabled = false;
      btn.classList.add("saved-success");
      btn.textContent = label || t("savedSuccess");
    } else if (state === "error") {
      btn.disabled = false;
      btn.classList.add("save-error");
      btn.textContent = label || t("saveRetry");
    } else { // idle
      btn.disabled = false;
      btn.textContent = submitOriginalText;
    }
  }

  $id("submit-btn").addEventListener("click", async () => {
    // Snapshot current label as "idle text" unless we're in a transient state
    if (!btn.classList.contains("saved-success") && !btn.classList.contains("save-error") && !btn.classList.contains("loading")) {
      submitOriginalText = btn.textContent;
    }
    clearTimeout(submitErrorResetTimer);
    setSubmitState("loading");

    const url = $id("url-input").value;
    const title = $id("title-input").value;
    if (!url || !title) {
      showStatus("status-msg", t("urlAndTitleRequired"), "error");
      setSubmitState("idle");
      return;
    }
    try {
      const apiUrl = buildPostsAddUri({
        token,
        url,
        title,
        extended: $id("description-input").value,
        tags: currentTags.join(" "),
        shared: $id("private-check").checked ? "no" : "yes",
        toread: $id("readlater-check").checked ? "yes" : "no",
      });
      if (apiUrl.length > POSTS_ADD_URI_BUDGET) {
        showStatus("status-msg", t("uriTooLong", String(apiUrl.length), String(POSTS_ADD_URI_BUDGET)), "error");
        setSubmitState("error");
        submitErrorResetTimer = setTimeout(() => { if (btn.classList.contains("save-error")) setSubmitState("idle"); }, 3000);
        return;
      }
      const resp = await pinboardFetch(apiUrl);
      if (!resp.ok) {
        let bodyText = "";
        try { bodyText = (await resp.text()).slice(0, 120); } catch (_) {}
        showStatus("status-msg", `HTTP ${resp.status}${bodyText ? ": " + bodyText : ""}`, "error");
        setSubmitState("error");
        submitErrorResetTimer = setTimeout(() => { if (btn.classList.contains("save-error")) setSubmitState("idle"); }, 3000);
        return;
      }
      const data = await resp.json();
      if (data.result_code === "done") {
        showStatus("status-msg", t("bookmarkSaved"), "success");
        setSubmitState("success");
        if (typeof saveLastUsedTags === "function") saveLastUsedTags(currentTags);
        chrome.runtime.sendMessage({ type: "bookmark_saved", url: url });
        // Persist "just-saved" state: upgrade banner to reflect current bookmark
        existingBookmark = {
          href: url,
          description: title,
          extended: $id("description-input").value,
          tags: currentTags.join(" "),
          shared: $id("private-check").checked ? "no" : "yes",
          toread: $id("readlater-check").checked ? "yes" : "no",
          time: new Date().toISOString(),
        };
        $id("submit-btn").textContent = t("update");
        $id("delete-btn").classList.remove("hidden");
        const bannerEl = $id("existing-banner");
        if (bannerEl) {
          const cancelEl = bannerEl.querySelector(".edit-cancel");
          let info = t("editingExisting");
          const parts = [t("offlineJustNow")];
          const tc = currentTags.length;
          if (tc > 0) parts.push(tc > 1 ? t("tagCountPlural", String(tc)) : t("tagCount", String(tc)));
          info += " (" + parts.join(", ") + ")";
          bannerEl.textContent = info;
          if (cancelEl) { bannerEl.appendChild(document.createTextNode(" ")); bannerEl.appendChild(cancelEl); }
          bannerEl.classList.remove("hidden");
          bannerEl.classList.add("just-saved");
          setTimeout(() => bannerEl.classList.remove("just-saved"), 2000);
        }
        if (settings.optAutoCloseAfterSave) {
          const bar = document.createElement("div");
          bar.className = "auto-close-bar";
          bar.setAttribute("aria-hidden", "true");
          document.body.appendChild(bar);
          autoCloseTimer = setTimeout(() => window.close(), 1800);
          document.addEventListener("mousedown", () => {
            clearTimeout(autoCloseTimer);
            autoCloseTimer = null;
            bar.remove();
          }, { once: true });
        }
        setTimeout(() => { if (btn.classList.contains("saved-success")) setSubmitState("idle"); }, 1200);
        return;
      }
      showStatus("status-msg", `Error: ${data.result_code}`, "error");
      setSubmitState("error");
    } catch (e) {
      showStatus("status-msg", t("networkError"), "error");
      setSubmitState("error");
    }
    // Auto-recover to idle so Ctrl+Enter keeps working after a visible error
    submitErrorResetTimer = setTimeout(() => {
      if (btn.classList.contains("save-error")) setSubmitState("idle");
    }, 3000);
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      const mainSection = $id("main-section");
      if (!mainSection.classList.contains("hidden")) {
        $id("submit-btn").click();
      }
    } else if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Enter") {
      const mainSection = $id("main-section");
      if (mainSection.classList.contains("hidden")) return;
      const aiBtn = $id("ai-summary-btn");
      const regen = document.querySelector('.regen-link[data-action="regenerate"]');
      if (aiBtn && !aiBtn.classList.contains("hidden") && !aiBtn.classList.contains("disabled-link")) {
        e.preventDefault();
        aiBtn.click();
      } else if (regen && !regen.classList.contains("loading")) {
        e.preventDefault();
        regen.click();
      }
    } else if (e.key === "Escape") {
      const delPop = document.querySelector(".del-confirm-popover");
      if (delPop) { delPop.remove(); return; }
      if (autoCloseTimer) { clearTimeout(autoCloseTimer); autoCloseTimer = null; document.querySelector(".auto-close-bar")?.remove(); return; }
      const tagsInput = $id("tags-input");
      if (tagsInput && document.activeElement === tagsInput) return;
      window.close();
    }
  });

  const hintSpan = document.createElement("span");
  hintSpan.className = "submit-hint";
  hintSpan.textContent = t("hintCtrlEnter");
  document.querySelector(".submit-bar")?.appendChild(hintSpan);

  $id("delete-btn").addEventListener("click", () => {
    const delBtn = $id("delete-btn");
    if (delBtn.querySelector(".del-confirm-popover")) return;

    const pop = document.createElement("div");
    pop.className = "del-confirm-popover";
    const msg = document.createElement("span");
    msg.textContent = t("confirmDelete");
    const yes = document.createElement("button");
    yes.className = "del-confirm-yes";
    yes.textContent = t("delete");
    const no = document.createElement("button");
    no.className = "del-confirm-no";
    no.textContent = t("cancel");
    pop.appendChild(msg); pop.appendChild(yes); pop.appendChild(no);
    delBtn.appendChild(pop);

    function dismiss() { pop.remove(); }
    pop.addEventListener("click", (e) => e.stopPropagation());
    no.addEventListener("click", dismiss);
    setTimeout(() => document.addEventListener("click", dismiss, { once: true }), 0);

    yes.addEventListener("click", async () => {
      dismiss();
      const delOrig = delBtn.textContent;
      delBtn.disabled = true; delBtn.classList.add("loading"); delBtn.textContent = t("deleting");
      const url = $id("url-input").value;
      try {
        const data = await (await pinboardFetch(`https://api.pinboard.in/v1/posts/delete?url=${enc(url)}&auth_token=${token}&format=json`)).json();
        if (data.result_code === "done" || data.result_code === "item not found") {
          showStatus("status-msg", t("deleted"), "success");
          chrome.runtime.sendMessage({ type: "bookmark_deleted", url: url });
          setTimeout(() => window.close(), 800);
        } else showStatus("status-msg", `Error: ${data.result_code}`, "error");
      } catch (e) { showStatus("status-msg", t("networkError"), "error"); }
      delBtn.disabled = false; delBtn.classList.remove("loading"); delBtn.textContent = delOrig;
    });
  });
}

// ===================== Edit From Recent =====================
async function loadBookmarkForEdit(url, token) {
  // Reset current form state
  existingBookmark = null;
  currentTags = [];
  renderTags();
  $id("url-input").value = url;
  $id("title-input").value = "";
  $id("description-input").value = "";
  $id("private-check").checked = false;
  $id("readlater-check").checked = false;
  $id("submit-btn").textContent = t("submit");
  $id("delete-btn").classList.add("hidden");
  // Mark edit mode so banner shows cancel affordance
  document.body.dataset.editMode = "1";
  // Reuse existing-bookmark path which will populate the form from posts/get
  await checkExistingBookmark(token, url);
  // Append cancel affordance to banner using safe DOM APIs (no innerHTML)
  const banner = $id("existing-banner");
  if (banner && !banner.querySelector(".edit-cancel")) {
    const cancel = document.createElement("span");
    cancel.className = "edit-cancel";
    cancel.textContent = "×";
    cancel.title = t("editCancelTitle");
    cancel.setAttribute("role", "button");
    cancel.setAttribute("tabindex", "0");
    cancel.addEventListener("click", exitEditMode);
    cancel.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); exitEditMode(); } });
    banner.appendChild(document.createTextNode(" "));
    banner.appendChild(cancel);
  }
  // Scroll form into view
  $id("title-input")?.focus();
  $id("title-input")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function exitEditMode() {
  delete document.body.dataset.editMode;
  // Simplest reliable restore: reload popup so current-tab logic runs again
  window.location.reload();
}

// ===================== Recent Bookmarks =====================
async function fetchRecentBookmarks(token) {
  const container = $id("recent-bookmarks");
  if (!container) return;
  try {
    const resp = await pinboardFetch(`https://api.pinboard.in/v1/posts/recent?auth_token=${token}&format=json&count=5`);
    if (resp.status === 401) return; // pinboardFetch already redirected to login
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const posts = data.posts || [];
    if (!posts.length) {
      injectEmptyState(container, "bookmark", t("emptyRecentBookmarks"));
      container.classList.remove("hidden");
      return;
    }
    container.classList.remove("hidden");
    const label = document.createElement("div");
    label.className = "recent-bm-label";
    label.textContent = t("recentLabel");
    container.appendChild(label);
    posts.forEach(p => {
      if (!/^https?:\/\//i.test(p.href)) return;
      const row = document.createElement("div");
      row.className = "recent-bm-row";
      const a = document.createElement("a");
      a.href = p.href;
      a.target = "_blank";
      a.className = "recent-bm-item";
      a.title = p.description;
      const titleText = (p.description || p.href).substring(0, 50);
      try { const host = new URL(p.href).hostname.replace(/^www\./, ""); a.innerHTML = esc(titleText) + ` <span class="recent-bm-domain">${esc(host)}</span>`; }
      catch (_) { a.textContent = titleText; }
      row.appendChild(a);
      const edit = document.createElement("span");
      edit.className = "recent-bm-edit";
      edit.innerHTML = PBP_ICONS.pencil;
      edit.title = t("recentEditTitle");
      edit.addEventListener("click", async (e) => {
        e.preventDefault();
        await loadBookmarkForEdit(p.href, token);
      });
      row.appendChild(edit);
      const del = document.createElement("span");
      del.className = "recent-bm-del";
      del.innerHTML = PBP_ICONS.cross;
      del.title = t("recentDeleteTitle");
      del.addEventListener("click", async () => {
        if (!confirm(t("confirmDelete"))) return;
        try {
          const data = await (await pinboardFetch(`https://api.pinboard.in/v1/posts/delete?url=${enc(p.href)}&auth_token=${token}&format=json`)).json();
          if (data.result_code === "done" || data.result_code === "item not found") {
            row.remove();
            chrome.runtime.sendMessage({ type: "bookmark_deleted", url: p.href });
          }
        } catch (_) {}
      });
      row.appendChild(del);
      container.appendChild(row);
    });
  } catch (e) { console.error("recent bookmarks error:", e); container.classList.remove("hidden"); container.innerHTML = `<div class="recent-bm-label">${esc(t("recentLabel"))}</div><span class="muted">${esc(t("recentFailed", e.message || String(e)))}</span>`; }
}

// ===================== Offline Queue Status =====================
async function showOfflineQueueStatus() {
  const bar = $id("offline-queue-bar");
  if (!bar) return;
  // Delegate list rendering + per-item actions to popup-offline.js
  if (window.PPOffline) {
    window.PPOffline.init();
    await window.PPOffline.refresh();
  }
  $id("offline-queue-clear")?.addEventListener("click", (e) => {
    e.preventDefault();
    const anchor = e.currentTarget;
    showConfirmPopover(anchor, {
      msg: t("offlineClearConfirm"),
      yesText: t("clear"),
      noText: t("cancel"),
      onConfirm: async () => {
        await chrome.storage.local.set({ offlineQueue: [] });
        bar.classList.add("hidden");
      },
    });
  });
}

// ===================== Helpers =====================
function setupDescriptionCounter() {
  const textarea = $id("description-input");
  textarea.addEventListener("input", () => { updateCharCount(); autoResizeTextarea(textarea); });
  setTimeout(() => autoResizeTextarea(textarea), 50);
}
// P1.4: Batch layout read/write into rAF — avoids sync reflow on every keystroke.
// Coalesces rapid successive calls (e.g. input event flood) into one frame.
let _autoResizeRaf = 0;
function autoResizeTextarea(el) {
  if (!el) return;
  if (_autoResizeRaf) cancelAnimationFrame(_autoResizeRaf);
  _autoResizeRaf = requestAnimationFrame(() => {
    _autoResizeRaf = 0;
    el.style.height = "auto";
    el.style.height = Math.min(Math.max(el.scrollHeight, TEXTAREA_MIN_HEIGHT), TEXTAREA_MAX_HEIGHT) + "px";
  });
}
function updateCharCount() {
  const len = $id("description-input").value.length;
  const uriLen = buildPostsAddUri({
    token: settings.pinboardToken || "user:0000000000000000000000000000000000000000",
    url: $id("url-input").value,
    title: $id("title-input").value,
    extended: $id("description-input").value,
    tags: currentTags.join(" "),
    shared: $id("private-check").checked ? "no" : "yes",
    toread: $id("readlater-check").checked ? "yes" : "no",
  }).length;
  const el = $id("desc-char-count");
  el.textContent = `${len} chars · ${uriLen}/${POSTS_ADD_URI_BUDGET} B`;
  const over = uriLen > POSTS_ADD_URI_BUDGET || len > 65000;
  const near = uriLen > POSTS_ADD_URI_BUDGET * 0.8 || len > 60000;
  el.style.color = over ? "#c00" : near ? "#e80" : "";
  el.classList.toggle("over-limit", over);

  // Gate submit on over-limit (without overriding unsupported-url disable path)
  const url = $id("url-input").value.trim();
  const urlBad = !url || (!url.startsWith("http://") && !url.startsWith("https://"));
  const sub = $id("submit-btn");
  sub.disabled = urlBad || over;
  sub.title = over ? t("submitUriTooLong") : urlBad ? t("urlCannotSave") : "";
}
function showElement(id, text) { const el = $id(id); el.textContent = text; el.classList.remove("hidden"); }
function showStatus(id, msg, kind) {
  if (kind === "error") {
    if (window._lastStatusFeedback) window._lastStatusFeedback.dismiss();
    window._lastStatusFeedback = showFeedback({
      variant: "error",
      message: msg,
      autoHide: 4000,
    });
    return;
  }
  const el = $id(id);
  if (!el) return;
  el.textContent = msg;
  el.className = "status-msg " + (kind || "");
  el.classList.remove("hidden");
}
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function enc(s) { return encodeURIComponent(s); }

// Alt+1~9 to add suggest/AI tags by index
document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const n = parseInt(e.key);
  if (n < 1 || n > 9 || isNaN(n)) return;
  const allStags = [...document.querySelectorAll("#pinboard-suggest-tags .stag:not(.used), #ai-suggest-tags .stag:not(.used)")];
  if (n <= allStags.length) {
    e.preventDefault();
    const el = allStags[n - 1];
    addTag(el.dataset.tag);
    el.classList.add("used");
  }
});
