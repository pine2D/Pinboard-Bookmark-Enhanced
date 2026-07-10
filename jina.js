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
    return { error: offline ? "network" : (e.message || "Jina API request failed"), fallback: true };
  }
}
