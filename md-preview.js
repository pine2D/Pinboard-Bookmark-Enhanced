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
  const tags = Array.isArray(info.tags) ? info.tags : [];
  const description = info.description || "";
  // Canonical Markdown: Defuddle HTML -> Turndown; Jina already gives MD.
  // Single source of truth for Raw view, Copy MD, Download .md, and Rendered.
  const canonicalMarkdown = info.markdown || (contentHtml ? htmlToMarkdown(contentHtml, { baseUrl }) : "");
  function getMarkdown() { return canonicalMarkdown; }

  // Export-options defaults from settings (per-export overridable via the header row).
  const exportSettings = await chrome.storage.sync.get({
    mdExportFrontmatter: true,
    mdExportImagePolicy: "keep",
    mdExportIncludeToc: false
  });
  const expFrontmatter = document.getElementById("exp-frontmatter");
  const expImagePolicy = document.getElementById("exp-image-policy");
  const expIncludeToc = document.getElementById("exp-include-toc");
  if (expFrontmatter) expFrontmatter.checked = !!exportSettings.mdExportFrontmatter;
  if (expImagePolicy) expImagePolicy.value = exportSettings.mdExportImagePolicy || "keep";
  if (expIncludeToc) expIncludeToc.checked = !!exportSettings.mdExportIncludeToc;

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function todayIso() {
    const d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function buildExportMarkdown() {
    const meta = {
      title: title || "",
      url: url || "",
      date: todayIso(),
      tags,
      source: source === "jina" ? "jina" : "defuddle"
    };
    if (description) meta.description = description;
    return composeExport(getMarkdown(), meta, {
      frontmatter: expFrontmatter ? expFrontmatter.checked : !!exportSettings.mdExportFrontmatter,
      imagePolicy: expImagePolicy ? expImagePolicy.value : (exportSettings.mdExportImagePolicy || "keep"),
      includeToc: expIncludeToc ? expIncludeToc.checked : !!exportSettings.mdExportIncludeToc
    });
  }

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

  // Reading stats (header) — computed from canonical Markdown
  const statsEl = document.getElementById("reading-stats");
  if (statsEl) {
    const stats = readingStats(getMarkdown());
    const wordLabel = stats.cjkChars > 0
      ? `${stats.words.toLocaleString()} words · ${stats.cjkChars.toLocaleString()} CJK`
      : `${stats.words.toLocaleString()} words`;
    statsEl.textContent = `${wordLabel} · ~${stats.minutes} min`;
  }

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
    await copyToClipboard(buildExportMarkdown(), e.currentTarget);
  });
  document.getElementById("btn-copy-html").addEventListener("click", async (e) => {
    await copyToClipboard(renderedView.innerHTML, e.currentTarget); // nosec: reading back own generated HTML
  });

  // Download buttons
  const safeTitle = (title || "untitled").replace(/[^a-zA-Z0-9_\u4e00-\u9fff -]/g, "_").slice(0, 80);
  document.getElementById("btn-dl-md").addEventListener("click", () => {
    downloadFile(safeTitle + ".md", buildExportMarkdown(), "text/markdown;charset=utf-8");
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
