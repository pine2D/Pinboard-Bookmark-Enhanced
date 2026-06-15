// ============================================================
// Markdown Preview Page
// ============================================================

// Render the styled empty state and hide the rail so the page reads as
// intentional (not a half-rendered document). textContent only — no innerHTML.
function renderEmptyState(message) {
  const view = document.getElementById("rendered-view");
  if (view) {
    const wrap = document.createElement("div");
    wrap.className = "empty-state";
    const p = document.createElement("p");
    p.textContent = message;
    wrap.appendChild(p);
    view.replaceChildren(wrap);
  }
  document.body.classList.add("md-empty");
}

function renderLoadingState(message, note) {
  const view = document.getElementById("rendered-view");
  if (view) {
    const wrap = document.createElement("div");
    wrap.className = "preview-loading";
    const sp = document.createElement("div");
    sp.className = "preview-spinner";
    sp.setAttribute("aria-hidden", "true");
    const p = document.createElement("p");
    p.textContent = message;
    wrap.appendChild(sp);
    wrap.appendChild(p);
    if (note) {
      const n = document.createElement("p");
      n.className = "note";
      n.textContent = note;
      wrap.appendChild(n);
    }
    view.replaceChildren(wrap);
    view.setAttribute("aria-busy", "true");
  }
  document.body.classList.add("md-empty");
}

// Map the active UI locale (manual-override mirror, else the browser UI language) to a
// BCP-47 tag for <html lang>, so the rail/UI chrome renders in the locale's font via :lang().
function uiLangToBCP47() {
  let l = null;
  try { l = (typeof localStorage !== "undefined") ? localStorage.getItem("pp-i18n-lang") : null; } catch (_) {}
  if (!l || l === "auto") {
    try { l = chrome.i18n.getUILanguage(); } catch (_) { l = "en"; }
  }
  l = (l || "en").replace(/_/g, "-").toLowerCase();
  if (l === "zh-hk" || l === "zh-tw" || l.startsWith("zh-hant")) return "zh-Hant";
  if (l === "zh-cn" || l === "zh-sg" || l === "zh" || l.startsWith("zh-hans")) return "zh-Hans";
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("ko")) return "ko";
  return l.split("-")[0]; // en / de / fr / pl / ru
}

// Heuristic detection of the ARTICLE's script from its text, so #rendered-view gets a
// lang attribute and :lang() picks the correct CJK font (a Simplified-only stack draws
// Traditional text with wrong glyph forms). Zero-dependency; samples the head of the text.
function detectArticleLang(text) {
  if (!text) return "";
  const s = text.slice(0, 4000);
  if (/[぀-ゟ゠-ヿ]/.test(s)) return "ja"; // Hiragana / Katakana
  if (/[가-힣]/.test(s)) return "ko";              // Hangul syllables
  if (/[一-鿿]/.test(s)) {                          // Han → Simplified vs Traditional
    const simp = (s.match(/[国对见图书龙东车马门话语说题际还买卖产权观难应当么这样实现单关闭过]/g) || []).length;
    const trad = (s.match(/[國對見圖書龍東車馬門話語說題際還買賣產權觀難應當麼這樣實現單關閉過]/g) || []).length;
    if (trad > simp) return "zh-Hant";
    if (simp > trad) return "zh-Hans";
    return ""; // ambiguous → default (TC-first) stack handles it
  }
  return ""; // Latin / Cyrillic → default stack's Latin head
}

// Lazy-load the vendored highlight.js (~122KB) on demand: only articles that actually
// contain code blocks pay its parse/compile cost, and never on the blocking first-paint
// path. Cached so concurrent callers share one load; degrades to no-highlight on error.
let _hljsPromise = null;
function ensureHljs() {
  if (typeof hljs !== "undefined") return Promise.resolve();
  if (_hljsPromise) return _hljsPromise;
  _hljsPromise = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "vendor/highlight.min.js";
    s.onload = () => resolve();
    s.onerror = () => resolve(); // degrade gracefully: page works without highlighting
    document.head.appendChild(s);
  });
  return _hljsPromise;
}

// Lazy-load KaTeX (JS + auto-render + CSS) only for math-bearing content (e.g. arXiv),
// so non-math previews never pay the ~270KB cost and currency "$" on other pages is
// never touched. CSS is injected here too so the lean first-paint isn't burdened.
let _katexPromise = null;
function ensureKatex() {
  if (typeof renderMathInElement !== "undefined") return Promise.resolve();
  if (_katexPromise) return _katexPromise;
  _katexPromise = new Promise((resolve) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "vendor/katex/katex.min.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "vendor/katex/katex.min.js";
    s.onload = () => {
      const a = document.createElement("script");
      a.src = "vendor/katex/auto-render.min.js";
      a.onload = () => resolve();
      a.onerror = () => resolve();
      document.head.appendChild(a);
    };
    s.onerror = () => resolve(); // degrade gracefully: math stays as $...$ source
    document.head.appendChild(s);
  });
  return _katexPromise;
}

(async function () {
  initI18n();
  applyI18n();
  document.documentElement.lang = uiLangToBCP47(); // UI-locale font for the rail/UI chrome
  // Read preview data from storage
  const data = await chrome.storage.local.get("md_preview_data");
  const info = data.md_preview_data;
  if (!info) {
    renderEmptyState(chrome.i18n.getMessage("mdPreviewEmpty") || "No preview data available. Please use the Markdown button in the popup first.");
    return;
  }
  // Clear temporary data — but KEEP a pending placeholder so a manual reload during
  // extraction re-drives it instead of hitting the empty state (the reextract success
  // path overwrites md_preview_data with the full payload, which that load then clears).
  if (!info.pending) {
    await chrome.storage.local.remove("md_preview_data");
  }

  const { contentHtml, title, url, tokens, source } = info;
  const srcTabId = info.tabId;
  const baseUrl = info.baseUrl || url || "";
  const tags = Array.isArray(info.tags) ? info.tags : [];
  const description = info.description || "";
  // Shortcut opens the preview INSTANTLY with a pending placeholder, then the
  // preview drives extraction via the reextract path (so the tab appears immediately
  // even when Jina needs a network round-trip). On success the SW has written the
  // full md_preview_data, so we reload into the normal render path.
  if (info.pending) {
    const titleEl0 = document.getElementById("preview-title");
    if (titleEl0) { titleEl0.textContent = title || t("mdPreviewUntitled"); titleEl0.title = title || ""; }
    document.title = (title || "Markdown") + " — Preview";
    renderLoadingState(
      t("mdEngineExtracting", engineLabel(info.engine)),
      info.engine === "jina" ? t("mdEngineExtractingNoteJina") : ""
    );
    let pr;
    try {
      pr = await chrome.runtime.sendMessage({
        type: "reextractMarkdown", tabId: srcTabId, url, engine: info.engine, tags: [], description: ""
      });
    } catch (_) { pr = { ok: false, error: "network" }; }
    if (pr && pr.ok) { location.reload(); return; }
    renderEmptyState(friendlyEngineErr(pr));
    return;
  }
  // Canonical Markdown: Defuddle HTML -> Turndown; Jina already gives MD.
  // Single source of truth for Raw view, Copy MD, Download .md, and Rendered.
  const canonicalMarkdown = info.markdown || (contentHtml ? htmlToMarkdown(contentHtml, { baseUrl }) : "");
  function getMarkdown() { return canonicalMarkdown; }
  if (!canonicalMarkdown.trim()) {
    renderEmptyState(chrome.i18n.getMessage("mdPreviewNoContent") || "No content was extracted from this page.");
    return;
  }

  // Export-options defaults from settings (per-export overridable via the header row).
  // Read from the SAME storage area options.js writes to: sync when the user enabled
  // sync, else local (the default). md-preview doesn't load shared.js, so resolve the
  // area inline rather than via getSettingsStorage. Reading chrome.storage.sync directly
  // would miss every customization for the default (sync-off) user — including the
  // obsidianEnabled gate, the vault/folder, and the frontmatter/image/TOC defaults.
  const { optSyncEnabled } = await chrome.storage.local.get({ optSyncEnabled: false });
  const settingsArea = optSyncEnabled ? chrome.storage.sync : chrome.storage.local;
  window.pbpSettingsArea = settingsArea;
  const exportSettings = await settingsArea.get({
    mdExportFrontmatter: true,
    mdExportImagePolicy: "keep",
    mdExportIncludeToc: false,
    obsidianEnabled: false,
    obsidianVault: "",
    obsidianFolder: ""
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
    // Export follows the translation view: md-translate.js sets
    // window.pbpViewMarkdown when the view is bilingual/translated-only;
    // it returns null (or is undefined) for the original view.
    const viewMd = (typeof window.pbpViewMarkdown === "function") ? window.pbpViewMarkdown() : null;
    return composeExport(viewMd || getMarkdown(), buildMeta(), buildExportOpts());
  }

  // Fill header
  const previewTitleEl = document.getElementById("preview-title");
  previewTitleEl.textContent = title || t("mdPreviewUntitled");
  previewTitleEl.title = title || t("mdPreviewUntitled");
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
  const engineStatusEl = document.getElementById("engine-status");
  const curEngine = source === "jina" ? "jina" : "local";
  let switching = false;

  function setEngineStatus(text, isError) {
    if (!engineStatusEl) return;
    engineStatusEl.textContent = text || "";
    engineStatusEl.classList.toggle("error", !!isError);
  }
  function engineLabel(e) { return e === "jina" ? "Jina Reader" : "Defuddle"; }
  function engineUnavailable(e) {
    if (e === "jina") return !/^https?:\/\//i.test(srcUrlForSwitch);
    return !srcTabId; // local needs the source tab
  }
  function friendlyEngineErr(r) {
    const code = r && r.error;
    if (code === "tab_unavailable" || code === "tab_navigated") return t("mdEngineTabGone");
    if (code === "empty") return t("mdPreviewNoContent");
    return t("mdEngineExtractFailed");
  }
  function applyAvailability() {
    if (!sourceEl) return;
    sourceEl.querySelectorAll(".src-seg").forEach((seg) => {
      const e = seg.getAttribute("data-engine");
      const active = e === curEngine;
      const unavail = engineUnavailable(e) && !active;
      seg.classList.toggle("active", active);
      seg.setAttribute("aria-pressed", active ? "true" : "false");
      seg.disabled = unavail;
      if (unavail) seg.setAttribute("aria-disabled", "true");
      else seg.removeAttribute("aria-disabled");
      if (!active && !unavail) seg.title = t("mdEngineSwitchTo", engineLabel(e));
      else if (unavail && e === "local") seg.title = t("mdEngineTabGone");
      else seg.removeAttribute("title");
    });
  }

  const srcUrlForSwitch = url || "";
  if (sourceEl) {
    applyAvailability();
    sourceEl.querySelectorAll(".src-seg").forEach((seg) => {
      seg.addEventListener("click", async () => {
        const e = seg.getAttribute("data-engine");
        if (switching || e === curEngine || seg.disabled) return;
        switching = true;
        sourceEl.setAttribute("aria-busy", "true");
        sourceEl.querySelectorAll(".src-seg").forEach((s) => { s.disabled = true; });
        seg.classList.add("loading");
        setEngineStatus(t("mdEngineExtracting", engineLabel(e)), false);
        let r;
        try {
          r = await chrome.runtime.sendMessage({
            type: "reextractMarkdown",
            tabId: srcTabId, url: srcUrlForSwitch, engine: e,
            tags, description
          });
        } catch (_) { r = { ok: false, error: "network" }; }
        if (r && r.ok) { location.reload(); return; }
        // failure: keep current content, restore the control
        switching = false;
        sourceEl.removeAttribute("aria-busy");
        seg.classList.remove("loading");
        applyAvailability();
        setEngineStatus(friendlyEngineErr(r), true);
        if (e === "local" && r && (r.error === "tab_unavailable" || r.error === "tab_navigated")) {
          const localSeg = sourceEl.querySelector('.src-seg[data-engine="local"]');
          if (localSeg) {
            localSeg.disabled = true;
            localSeg.setAttribute("aria-disabled", "true");
            localSeg.title = t("mdEngineTabGone");
          }
        }
      });
    });
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
  const _articleLang = detectArticleLang(canonicalMarkdown);
  if (_articleLang) renderedView.lang = _articleLang; // article-script font for the reading content
  // Syntax highlighting is OFF the critical first-paint path: the article paints
  // immediately, then — only if it actually contains code — highlight.js is lazy-loaded
  // and applied after paint (rAF). Avoids blocking the page on a 122KB compile + a
  // synchronous whole-document highlight pass (the cold-load spinner).
  if (renderedView.querySelector("pre > code")) {
    requestAnimationFrame(() => { ensureHljs().then(() => highlightCodeBlocks(renderedView)); });
  }
  // Math rendering — ONLY for LaTeX-bearing content (info.math, e.g. arXiv). Gating on
  // the flag (not just a "$") keeps KaTeX off every other page so currency like "$5"
  // is never mangled. Off the first-paint path (rAF), degrades to $...$ source on error.
  if (info.math && /\$/.test(renderedView.textContent)) {
    requestAnimationFrame(() => ensureKatex().then(() => {
      if (typeof renderMathInElement === "function") {
        try {
          renderMathInElement(renderedView, {
            delimiters: [{ left: "$$", right: "$$", display: true }, { left: "$", right: "$", display: false }],
            throwOnError: false
          });
        } catch (_) { /* leave $...$ source visible on failure */ }
      }
    }));
  }

  // ---- Build TOC sidebar from the canonical markdown ----
  const tocNav = document.getElementById("toc");
  const tocList = document.getElementById("toc-list");
  // Walk the already-rendered (and sanitized) headings so each TOC anchor
  // equals a real element id (buildToc's markdown-derived slugs can diverge from
  // marked's rendered ids for headings with inline links/images or duplicates).
  const headings = Array.from(renderedView.querySelectorAll("h2[id], h3[id], h4[id]"))
    .map((el) => ({ level: +el.tagName[1], text: el.textContent, slug: el.id }))
    .filter((h) => h.slug);

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
    setupScrollSpy(renderedView, tocList);
  }
  setupDrawer();

  // Notify the md-ai layer (md-ai-core / md-translate / md-ask) that the
  // article DOM is final. Fires even when the TOC is absent. detail.url is
  // the cache-key source for tr_/ask_/trview_ entries (md_preview_data is
  // already removed from storage at this point; the page holds the markdown
  // in closure and md-ai reads text via the DOM blocks).
  document.dispatchEvent(new CustomEvent("pbp:rendered", { detail: { url, title } }));

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
    btnRaw.setAttribute("aria-pressed", "true");
    btnRendered.setAttribute("aria-pressed", "false");
    document.body.classList.add("raw-active");
  });
  btnRendered.addEventListener("click", () => {
    renderedView.classList.remove("hidden");
    rawView.classList.add("hidden");
    btnRendered.classList.add("active");
    btnRaw.classList.remove("active");
    btnRendered.setAttribute("aria-pressed", "true");
    btnRaw.setAttribute("aria-pressed", "false");
    document.body.classList.remove("raw-active");
  });

  // Copy buttons
  document.getElementById("btn-copy-md").addEventListener("click", async (e) => {
    await copyToClipboard(buildExportMarkdown(), e.currentTarget);
  });
  document.getElementById("btn-copy-html").addEventListener("click", async (e) => {
    // Ensure code is highlighted before copying the HTML (highlight is deferred/lazy on load).
    if (renderedView.querySelector("pre > code:not(.hljs)")) {
      await ensureHljs();
      highlightCodeBlocks(renderedView);
    }
    await copyToClipboard(renderedView.innerHTML, e.currentTarget); // nosec: reading back own generated HTML
  });

  // Download buttons
  const safeTitle = safeFilename(title);
  document.getElementById("btn-dl-md").addEventListener("click", () => {
    downloadFile(safeTitle + ".md", buildExportMarkdown(), "text/markdown;charset=utf-8");
  });
  document.getElementById("btn-dl-html").addEventListener("click", async () => {
    if (renderedView.querySelector("pre > code")) await ensureHljs(); // so composeStyledHtml highlights the export
    const hljsCss = await loadHljsCss();
    const doc = composeStyledHtml(getMarkdown(), buildMeta(), { ...buildExportOpts(), hljsCss });
    downloadFile(safeTitle + ".html", doc, "text/html;charset=utf-8");
  });

  const obsBtn = document.getElementById("btn-obsidian");
  if (exportSettings.obsidianEnabled) {
    obsBtn.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const md = buildExportMarkdown();
      let usedClipboard = false;
      try { await navigator.clipboard.writeText(md); usedClipboard = true; } catch (_) {}
      const uri = buildObsidianUri({
        vault: exportSettings.obsidianVault,
        folder: exportSettings.obsidianFolder,
        name: safeTitle,
        clipboard: usedClipboard,
        content: usedClipboard ? "" : md
      });
      window.open(uri, "_blank");
      if (!sessionStorage.getItem("_obsidian_hint_shown")) {
        sessionStorage.setItem("_obsidian_hint_shown", "1");
        flashButtonLabel(btn, t("obsidianInstallHint"));
      } else {
        flashButtonLabel(btn, t("mdSentObsidian"));
      }
    });
  } else if (obsBtn) {
    obsBtn.style.display = "none";
  }
})();

// ---- Copy to clipboard with visual feedback ----
async function copyToClipboard(text, btn) {
  const label = btn.querySelector(".btn-label");
  const setLabel = (s) => { if (label) label.textContent = s; else btn.textContent = s; };
  // Persist the original label ONCE so a re-click within the revert window can't
  // capture "Copied!" as the "original" and freeze the button on success text.
  if (btn._copyOrig == null) btn._copyOrig = label ? label.textContent : btn.textContent;
  const announce = (msg) => { const el = document.getElementById("copy-status"); if (el) el.textContent = msg; };
  clearTimeout(btn._copyTimer);
  try {
    await navigator.clipboard.writeText(text);
    setLabel(t("jinaCopied"));
    btn.classList.add("copied");
    announce(t("jinaCopied"));
  } catch (_) {
    setLabel(t("mdPreviewFailed"));
    announce(t("mdPreviewFailed"));
  }
  btn._copyTimer = setTimeout(() => {
    setLabel(btn._copyOrig);
    btn.classList.remove("copied");
    btn._copyOrig = null;
    announce("");
  }, 1500);
}

// One-shot button feedback: swap the .btn-label to msg + .copied for 1.5s, then
// revert; also announce to the #copy-status live region for screen readers. Uses
// the same re-entry guard as copyToClipboard (persist orig once, clear pending timer).
function flashButtonLabel(btn, msg) {
  const label = btn.querySelector(".btn-label");
  const setLabel = (s) => { if (label) label.textContent = s; else btn.textContent = s; };
  if (btn._copyOrig == null) btn._copyOrig = label ? label.textContent : btn.textContent;
  const el = document.getElementById("copy-status");
  if (el) el.textContent = msg;
  setLabel(msg);
  btn.classList.add("copied");
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    setLabel(btn._copyOrig);
    btn.classList.remove("copied");
    btn._copyOrig = null;
    if (el) el.textContent = "";
  }, 1500);
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

// ---- Rail drawer (narrow viewports) ----
// Off-canvas modal-style drawer: move focus in on open, trap Tab while open,
// restore focus to the opener on close. Only engaged <1000px (toggle is
// display:none above, so setOpen(true) never fires at wide widths).
function setupDrawer() {
  const toggle = document.getElementById("rail-toggle");
  const scrim = document.getElementById("rail-scrim");
  const rail = document.getElementById("rail");
  if (!toggle || !scrim || !rail) return;
  let lastFocus = null;
  const focusables = () => Array.from(
    rail.querySelectorAll('button, a[href], input, select, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => el.offsetParent !== null);
  const isOpen = () => document.body.classList.contains("rail-open");
  const setOpen = (open) => {
    document.body.classList.toggle("rail-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    scrim.hidden = !open;
    if (open) {
      lastFocus = document.activeElement;
      rail.setAttribute("role", "dialog");
      rail.setAttribute("aria-modal", "true");
      (document.getElementById("btn-rendered") || rail).focus();
    } else {
      rail.removeAttribute("role");
      rail.removeAttribute("aria-modal");
      if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
      else toggle.focus();
    }
  };
  toggle.addEventListener("click", () => setOpen(!isOpen()));
  scrim.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => {
    if (!isOpen()) return;
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "Tab") {
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}

// ---- Scroll-spy: highlight the TOC entry for the heading nearest the top ----
function setupScrollSpy(renderedView, tocList) {
  const links = Array.from(tocList.querySelectorAll("a"));
  if (!links.length) return;

  // No sticky toolbar overlays the content now (rail is beside it); a small
  // top clearance keeps the heading at the very top from flickering.
  const topClear = 16;

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
