// ============================================================
// Pinboard Bookmark Enhanced - Jina Reader API Integration
// ============================================================

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
        const dur = (cacheDuration || 60) * 60 * 1000;
        if (dur > 0 && Date.now() - timestamp <= dur) {
          return { ...result, fromCache: true };
        }
      }
    } catch (_) {}
  }

  // Build request headers
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, { headers }, 30000);
    if (!res.ok) {
      return { error: `Jina API returned ${res.status}`, fallback: true };
    }
    const json = await res.json();
    const d = json.data || {};
    const result = {
      markdown: d.content || "",
      title: d.title || "",
      url: d.url || url,
      tokens: d.usage?.tokens || json.meta?.usage?.tokens || 0
    };

    // Cache result
    if ((cacheDuration || 60) > 0) {
      try {
        await chrome.storage.local.set({ [cacheKey]: { result, timestamp: Date.now() } });
      } catch (_) {}
    }

    return { ...result, fromCache: false };
  } catch (e) {
    return { error: e.message || "Jina API request failed", fallback: true };
  }
}

// ---- Convert Markdown to plain text (for AI prompts) ----
function markdownToPlainText(markdown) {
  if (!markdown) return "";
  return markdown
    // Remove images
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Convert links to text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Remove headings markup
    .replace(/^#{1,6}\s+/gm, "")
    // Remove bold/italic
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    // Remove inline code
    .replace(/`([^`]+)`/g, "$1")
    // Remove code block fences
    .replace(/```[\s\S]*?```/g, "")
    // Remove blockquote markers
    .replace(/^>\s?/gm, "")
    // Remove horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // Remove HTML tags
    .replace(/<[^>]+>/g, "")
    // Collapse multiple newlines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
