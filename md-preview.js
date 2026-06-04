// ============================================================
// Markdown Preview Page
// ============================================================

(async function () {
  // Read preview data from storage
  const data = await chrome.storage.local.get("md_preview_data");
  const info = data.md_preview_data;
  if (!info) {
    document.getElementById("rendered-view").textContent = chrome.i18n.getMessage("mdPreviewEmpty") || "No preview data available. Please use the Markdown button in the popup first.";
    return;
  }
  // Clear temporary data
  await chrome.storage.local.remove("md_preview_data");

  const { contentHtml, title, url, tokens, source } = info;
  const baseUrl = info.baseUrl || url || "";
  // Canonical Markdown: Defuddle HTML -> Turndown; Jina already gives MD.
  // Single source of truth for Raw view, Copy MD, Download .md, and Rendered.
  const canonicalMarkdown = info.markdown || (contentHtml ? htmlToMarkdown(contentHtml, { baseUrl }) : "");
  function getMarkdown() { return canonicalMarkdown; }

  // Fill header
  document.getElementById("preview-title").textContent = title || "Untitled";
  const urlEl = document.getElementById("preview-url");
  urlEl.textContent = url || "";
  urlEl.href = url || "#";
  const tokenEl = document.getElementById("token-count");
  if (source === "jina" && tokens && info.hasApiKey) {
    tokenEl.textContent = `${tokens} tokens`;
  } else {
    tokenEl.style.display = "none";
  }
  const sourceEl = document.getElementById("source-badge");
  if (sourceEl) {
    sourceEl.textContent = source === "jina" ? "Jina Reader" : "Defuddle";
  }
  document.title = `${title || "Markdown"} — Preview`;

  // Single render path: canonical Markdown -> marked() -> DOMPurify -> innerHTML.
  // renderMarkdown() is now the lone sanitize point (XSS closed here).
  const renderedView = document.getElementById("rendered-view");
  let renderedHtml = renderMarkdown(canonicalMarkdown);
  // Lazy-load images / async decode (sanitizer keeps these attributes).
  renderedHtml = renderedHtml.replace(/<img(?=\s)/gi, '<img loading="lazy" decoding="async"');
  renderedView.innerHTML = renderedHtml;
  // Raw view populated lazily on first switch

  // View toggle
  const btnRaw = document.getElementById("btn-raw");
  const btnRendered = document.getElementById("btn-rendered");
  const rawView = document.getElementById("raw-view");

  btnRaw.addEventListener("click", () => {
    if (!rawView.textContent) rawView.textContent = getMarkdown();
    rawView.classList.remove("hidden");
    renderedView.classList.add("hidden");
    btnRaw.classList.add("active");
    btnRendered.classList.remove("active");
  });
  btnRendered.addEventListener("click", () => {
    renderedView.classList.remove("hidden");
    rawView.classList.add("hidden");
    btnRendered.classList.add("active");
    btnRaw.classList.remove("active");
  });

  // Copy buttons
  document.getElementById("btn-copy-md").addEventListener("click", async (e) => {
    await copyToClipboard(getMarkdown(), e.currentTarget);
  });
  document.getElementById("btn-copy-html").addEventListener("click", async (e) => {
    await copyToClipboard(renderedView.innerHTML, e.currentTarget); // nosec: reading back own generated HTML
  });

  // Download buttons
  const safeTitle = (title || "untitled").replace(/[^a-zA-Z0-9_\u4e00-\u9fff -]/g, "_").slice(0, 80);
  document.getElementById("btn-dl-md").addEventListener("click", () => {
    downloadFile(safeTitle + ".md", getMarkdown(), "text/markdown;charset=utf-8");
  });
  document.getElementById("btn-dl-html").addEventListener("click", () => {
    downloadFile(safeTitle + ".html", renderedView.innerHTML, "text/html;charset=utf-8");
  });
})();

// ---- Copy to clipboard with visual feedback ----
async function copyToClipboard(text, btn) {
  const label = btn.querySelector(".btn-label");
  const orig = label ? label.textContent : btn.textContent;
  const setLabel = (t) => { if (label) label.textContent = t; else btn.textContent = t; };
  try {
    await navigator.clipboard.writeText(text);
    setLabel("Copied!");
    btn.classList.add("copied");
    setTimeout(() => { setLabel(orig); btn.classList.remove("copied"); }, 1500);
  } catch (_) {
    setLabel("Failed");
    setTimeout(() => { setLabel(orig); }, 1500);
  }
}

// ---- Download file helper ----
function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// renderMarkdown + htmlToMarkdown now live in md-convert.js (single source of truth).
