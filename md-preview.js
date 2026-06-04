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
  // Shared export metadata + per-export option resolution (used by Copy/Download MD and Download .html).
  function buildMeta() {
    const meta = {
      title: title || "",
      url: url || "",
      date: todayIso(),
      tags,
      source: source === "jina" ? "jina" : "defuddle"
    };
    if (description) meta.description = description;
    return meta;
  }
  function buildExportOpts() {
    return {
      frontmatter: expFrontmatter ? expFrontmatter.checked : !!exportSettings.mdExportFrontmatter,
      imagePolicy: expImagePolicy ? expImagePolicy.value : (exportSettings.mdExportImagePolicy || "keep"),
      includeToc: expIncludeToc ? expIncludeToc.checked : !!exportSettings.mdExportIncludeToc
    };
  }
  function buildExportMarkdown() {
    return composeExport(getMarkdown(), buildMeta(), buildExportOpts());
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
  highlightCodeBlocks(renderedView);

  // ---- Build TOC sidebar from the canonical markdown ----
  const tocNav = document.getElementById("toc");
  const tocList = document.getElementById("toc-list");
  const { headings } = buildToc(canonicalMarkdown, { minLevel: 2, maxLevel: 4 });

  if (headings && headings.length) {
    const frag = document.createDocumentFragment();
    headings.forEach((h) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#" + h.slug;
      a.textContent = h.text;
      a.dataset.level = String(h.level);
      a.dataset.slug = h.slug;
      li.appendChild(a);
      frag.appendChild(li);
    });
    tocList.appendChild(frag);
    tocNav.hidden = false;
    // Keep the fixed rail clear of the sticky toolbar, whose height varies
    // (title length, export-options row wrapping). Measure it instead of a
    // hardcoded top. (Inert in the responsive top-collapse mode, where the
    // rail is position:static.)
    const toolbarEl = document.getElementById("toolbar");
    const positionToc = () => { if (toolbarEl) tocNav.style.top = (toolbarEl.offsetHeight + 16) + "px"; };
    positionToc();
    window.addEventListener("resize", positionToc);
    setupTocToggle(tocNav);
    setupScrollSpy(renderedView, tocList);
  }

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
  const safeTitle = safeFilename(title);
  document.getElementById("btn-dl-md").addEventListener("click", () => {
    downloadFile(safeTitle + ".md", buildExportMarkdown(), "text/markdown;charset=utf-8");
  });
  document.getElementById("btn-dl-html").addEventListener("click", async () => {
    const hljsCss = await loadHljsCss();
    const doc = composeStyledHtml(getMarkdown(), buildMeta(), { ...buildExportOpts(), hljsCss });
    downloadFile(safeTitle + ".html", doc, "text/html;charset=utf-8");
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

// renderMarkdown + htmlToMarkdown + safeFilename + downloadFile now live in md-convert.js (single source of truth).

// Inline the vendored hljs theme so the standalone .html highlights offline.
// Light always; dark under a media query. Best-effort: "" if fetch/chrome absent.
async function loadHljsCss() {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.getURL) return "";
  try {
    const light = await (await fetch(chrome.runtime.getURL("vendor/hljs-github.min.css"))).text();
    let dark = "";
    try { dark = await (await fetch(chrome.runtime.getURL("vendor/hljs-github-dark.min.css"))).text(); } catch (_) {}
    return light + (dark ? "\n@media (prefers-color-scheme:dark){\n" + dark + "\n}\n" : "");
  } catch (_) { return ""; }
}

// ---- TOC collapse toggle (only visible/relevant in narrow top-mode) ----
function setupTocToggle(tocNav) {
  const btn = document.getElementById("toc-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const collapsed = tocNav.dataset.collapsed === "true";
    tocNav.dataset.collapsed = collapsed ? "false" : "true";
    btn.setAttribute("aria-expanded", collapsed ? "true" : "false");
  });
}

// ---- Scroll-spy: highlight the TOC entry for the heading nearest the top ----
function setupScrollSpy(renderedView, tocList) {
  const links = Array.from(tocList.querySelectorAll("a"));
  if (!links.length) return;

  // Clearance below the sticky toolbar (variable height) — reused by the
  // observer's top margin and the "scrolled past" fallback threshold.
  const tb = document.getElementById("toolbar");
  const topClear = (tb ? tb.offsetHeight : 96) + 8;

  // Map slug -> link for O(1) activation.
  const linkBySlug = new Map(links.map((a) => [a.dataset.slug, a]));

  // Resolve each link's target heading element by id (slug === heading id).
  const targets = links
    .map((a) => renderedView.querySelector("#" + cssEscape(a.dataset.slug)))
    .filter(Boolean);
  if (!targets.length) return;

  let activeSlug = null;
  const setActive = (slug) => {
    if (slug === activeSlug) return;
    if (activeSlug && linkBySlug.has(activeSlug)) linkBySlug.get(activeSlug).classList.remove("active");
    const a = linkBySlug.get(slug);
    if (a) {
      a.classList.add("active");
      activeSlug = slug;
    }
  };

  // Track which headings are currently intersecting; the topmost wins.
  const visible = new Set();
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const id = entry.target.id;
      if (entry.isIntersecting) visible.add(id);
      else visible.delete(id);
    });
    // Pick the visible heading closest to the top of the doc order.
    let topId = null;
    for (const t of targets) {
      if (visible.has(t.id)) { topId = t.id; break; }
    }
    // If nothing is intersecting (scrolled past all into a long section),
    // keep the last heading above the viewport active.
    if (!topId) {
      for (let i = targets.length - 1; i >= 0; i--) {
        if (targets[i].getBoundingClientRect().top < topClear + 12) { topId = targets[i].id; break; }
      }
    }
    if (topId) setActive(topId);
  }, {
    // top margin clears the (measured) sticky toolbar; -70% bottom keeps the
    // "current" heading active until the next one nears the top.
    rootMargin: "-" + topClear + "px 0px -70% 0px",
    threshold: 0,
  });
  targets.forEach((t) => observer.observe(t));
}

// CSS.escape fallback for slugs used in querySelector("#"+id).
function cssEscape(s) {
  if (window.CSS && typeof CSS.escape === "function") return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9\-_ -￿]/g, (c) => "\\" + c);
}
