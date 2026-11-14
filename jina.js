// ============================================================
// Pinboard Bookmark Enhanced - Jina Reader API Integration
// ============================================================

async function _ensureJinaHostPermission() {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) return;
  let has = false;
  try {
    if (chrome.permissions && chrome.permissions.contains) {
      has = (await chrome.permissions.contains({ origins: [PBP_JINA_ORIGIN_PATTERN] })) === true;
    }
  } catch (_) {}
  if (!has) {
    const err = new Error("Jina host permission required");
    err.code = "host_permission";
    throw err;
  }
}

// ---- Jina Reader API: fetch page as Markdown ----
async function fetchJinaMarkdown(url, options = {}) {
  const { apiKey, forceRefresh, cacheDuration } = options;
  const cacheKey = `jina_md_${url}`;

  // Check cache first
  if (!forceRefresh) {
    try {
      const data = await chrome.storage.local.get(cacheKey);
      if (data[cacheKey]) {
        const { result, timestamp } = data[cacheKey];
        const dur = resolveCacheMs(cacheDuration);
        if (dur > 0 && Date.now() - timestamp <= dur) {
          return { ...result, fromCache: true };
        }
      }
    } catch (_) {}
  }

  try {
    // Cache stays readable after a grant is revoked; only a network miss needs access.
    await _ensureJinaHostPermission();
    const headers = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, { headers }, 30000);
    if (!res.ok) {
      return {
        error: `Jina API returned ${res.status}`,
        status: res.status,
        authFailed: res.status === 401 || res.status === 403,
        fallback: true
      };
    }
    const json = await res.json();
    const d = json.data || {};
    const result = {
      markdown: d.content || "",
      title: d.title || "",
      url: d.url || url,
      tokens: d.usage?.tokens || json.meta?.usage?.tokens || 0,
      // X4: best-effort published date from Jina's upstream response. No
      // author/site/image counterpart -- Jina Reader doesn't expose them.
      // Entries cached before this field existed simply read back undefined
      // here -> "" downstream (degrade, no cache migration).
      published: d.publishedTime || ""
    };

    // Cache result
    if (resolveCacheMs(cacheDuration) > 0) {
      try {
        await chrome.storage.local.set({ [cacheKey]: { result, timestamp: Date.now() } });
      } catch (_) {}
    }

    return { ...result, fromCache: false };
  } catch (e) {
    if (e && e.code === "host_permission") {
      return { error: "host_permission", code: "host_permission", fallback: true };
    }
    // Chrome throws a bare TypeError("Failed to fetch") for network failures
    // (offline, DNS, connection refused) — distinct from the HTTP-status branch
    // above (a real response, just non-2xx). Collapse it to the "network" code,
    // the same sentinel md-preview.js's own sendMessage-failure catches already
    // use, so friendlyEngineErr can map it to a dedicated message instead of
    // every Jina failure falling into one generic bucket (D4-2).
    const offline = (e instanceof TypeError && /failed to fetch/i.test(e.message || "")) ||
      (typeof navigator !== "undefined" && navigator.onLine === false);
    // fetchWithTimeout's deadline rejects with TimeoutError (ai.js): flagged
    // separately so the reader can say "timed out" -- the error string itself
    // is unchanged for the popup callers that log it.
    return { error: offline ? "network" : (e.message || "Jina API request failed"), timeout: !!(e && e.name === "TimeoutError"), fallback: true };
  }
}

const PBP_DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";

async function _ensureDeepseekFetchHostPermission() {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) return;
  let has = false;
  try {
    if (chrome.permissions && chrome.permissions.contains) {
      has = (await chrome.permissions.contains({ origins: [PBP_DEEPSEEK_FETCH_ORIGIN_PATTERN] })) === true;
    }
  } catch (e) {
    console.warn("[deepseek-fetch] permission check failed:", e && e.name);
  }
  if (!has) {
    const err = new Error("DeepSeek Fetch host permission required");
    err.code = "host_permission";
    throw err;
  }
}

function _isValidDeepseekFetchUrl(url) {
  if (typeof url !== "string" || !url || url.length > 8192) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (!u.hostname || u.username || u.password) return false;
    return true;
  } catch (_) {
    // swallow-ok: URL parser validates untrusted URL syntax
    return false;
  }
}

// ---- DeepSeek Fetch API: fetch page as Markdown ----
const _deepseekFetchInflight = new Map();

async function fetchDeepseekMarkdown(url, options = {}) {
  if (!_isValidDeepseekFetchUrl(url)) {
    return { error: "invalid_url", code: "invalid_url", fallback: true };
  }
  const { apiKey, forceRefresh, cacheDuration } = options;
  const cacheKey = `deepseek_md_${url}`;

  if (!forceRefresh) {
    try {
      const data = await chrome.storage.local.get(cacheKey);
      if (data[cacheKey]) {
        const { result, timestamp } = data[cacheKey];
        const dur = resolveCacheMs(cacheDuration);
        if (dur > 0 && Date.now() - timestamp <= dur) {
          return { ...result, fromCache: true };
        }
      }
    } catch (e) {
      console.warn("[deepseek-fetch] cache read failed:", e && e.name);
    }
  }

  const trimmedKey = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!trimmedKey) {
    return { error: "deepseek_key_missing", code: "deepseek_key_missing", authFailed: true, fallback: true };
  }

  const inflightKey = !forceRefresh ? `${cacheKey}\n${trimmedKey}\n${resolveCacheMs(cacheDuration)}` : "";
  if (inflightKey && _deepseekFetchInflight.has(inflightKey)) {
    const shared = await _deepseekFetchInflight.get(inflightKey);
    return { ...shared };
  }

  const runPromise = (async () => {
    try {
      await _ensureDeepseekFetchHostPermission();
      const res = await fetchWithTimeout(PBP_DEEPSEEK_FETCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${trimmedKey}`
        },
        body: JSON.stringify({ url })
      }, 30000);
      if (!res.ok) {
        return {
          error: `DeepSeek Fetch API returned ${res.status}`,
          status: res.status,
          authFailed: res.status === 401 || res.status === 403,
          fallback: true
        };
      }
      const json = typeof res.text === "function"
        ? JSON.parse((await res.text()).trimStart())
        : await res.json();
      if (json && json.error) {
        const errMsg = typeof json.error === "string" ? json.error : (json.error.message || "DeepSeek Fetch API error");
        return { error: errMsg, fallback: true };
      }
      const d = (json && typeof json.data === "object" && json.data) ? json.data : (json || {});
      const rawMarkdown = typeof d.content === "string" ? d.content : (typeof d.markdown === "string" ? d.markdown : "");
      const markdown = rawMarkdown.trim() ? rawMarkdown : "";
      const result = {
        markdown,
        title: typeof d.title === "string" ? d.title : "",
        url: (typeof d.url === "string" && d.url) ? d.url : url,
        tokens: 0,
        published: typeof d.publishedTime === "string" ? d.publishedTime : (typeof d.date === "string" ? d.date : "")
      };

      if (result.markdown.trim() && resolveCacheMs(cacheDuration) > 0) {
        try {
          await chrome.storage.local.set({ [cacheKey]: { result, timestamp: Date.now() } });
        } catch (e) {
          console.warn("[deepseek-fetch] cache write failed:", e && e.name);
        }
      }

      return { ...result, fromCache: false };
    } catch (e) {
      if (e && e.code === "host_permission") {
        return { error: "host_permission", code: "host_permission", fallback: true };
      }
      const offline = (e instanceof TypeError && /failed to fetch/i.test(e.message || "")) ||
        (typeof navigator !== "undefined" && navigator.onLine === false);
      return {
        error: offline ? "network" : (e.message || "DeepSeek Fetch API request failed"),
        timeout: !!(e && e.name === "TimeoutError"),
        fallback: true
      };
    }
  })();

  if (inflightKey) _deepseekFetchInflight.set(inflightKey, runPromise);
  try {
    const out = await runPromise;
    return { ...out };
  } finally {
    if (inflightKey) _deepseekFetchInflight.delete(inflightKey);
  }
}
