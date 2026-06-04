// ============================================================
// Pinboard Bookmark Enhanced - Markdown Conversion (shared)
// Single canonical-Markdown subsystem. Loaded by popup.html and
// md-preview.html as a global-function script (zero build).
//   - htmlToMarkdown / markdownToPlainText: pure-ish, no render libs
//   - slugify: GitHub-style heading slug (CJK-preserving)
//   - renderMarkdown: marked() -> DOMPurify.sanitize() (preview only)
// ============================================================

// ---- HTML -> Markdown via Turndown (popup uses lazy ensureTurndown) ----
// baseUrl is accepted now (used by P2 image absolutization); ignored here.
function htmlToMarkdown(html, opts) {
  if (typeof TurndownService === "undefined") return html;
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.addRule("preformattedCode", {
    filter: (n) => n.nodeName === "PRE",
    replacement: (content, node) => {
      const code = node.querySelector("code");
      let lang = "";
      if (code) {
        const cls = code.getAttribute("class") || "";
        const m = cls.match(/language-(\S+)/);
        lang = (m && m[1]) || code.getAttribute("data-lang") || code.getAttribute("data-language") || "";
      }
      if (!lang) lang = node.getAttribute("data-language") || "";
      const text = (code || node).textContent || "";
      return "\n\n```" + lang + "\n" + text.replace(/`/g, "\\`") + "\n```\n\n";
    }
  });
  td.addRule("table", {
    filter: "table",
    replacement: (content, node) => {
      const rows = Array.from(node.querySelectorAll("tr"));
      if (!rows.length) return content;
      // Convert each cell's INNER HTML to markdown so inline formatting
      // (inline code, links, bold/em) survives — plain textContent would
      // flatten e.g. `en` -> en and drop [text](url) links. Then collapse to a
      // single pipe-safe line (GFM table cells can't span multiple lines).
      const cellMd = (c) => {
        let md;
        try { md = td.turndown(c.innerHTML); } catch (_) { md = c.textContent || ""; }
        return md.replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
      };
      const out = [];
      rows.forEach((row, i) => {
        const cells = Array.from(row.querySelectorAll(":scope > th, :scope > td")).map(cellMd);
        out.push("| " + cells.join(" | ") + " |");
        if (i === 0) out.push("| " + cells.map(() => "---").join(" | ") + " |");
      });
      return "\n\n" + out.join("\n") + "\n\n";
    }
  });
  // GitHub alerts (> [!TIP] etc.): Defuddle normalizes them to Obsidian-style
  // callouts (<div data-callout="tip" class="callout"><div class="callout-title">…
  // </div><p>…</p></div>). Restore the `> [!TYPE]` blockquote so the export round-trips.
  td.addRule("calloutAlert", {
    filter: (n) => n.nodeName === "DIV" && (n.hasAttribute("data-callout") || (n.classList && n.classList.contains("callout"))),
    replacement: (content, node) => {
      const type = (node.getAttribute("data-callout") || "note").trim().toUpperCase();
      const clone = node.cloneNode(true);
      const titleEl = clone.querySelector(".callout-title");
      if (titleEl) titleEl.remove();
      let body;
      try { body = td.turndown(clone.innerHTML); } catch (_) { body = clone.textContent || ""; }
      body = body.replace(/^\n+/, "").replace(/\n+$/, "").trim();
      const quoted = body ? body.split("\n").map((l) => (l.length ? "> " + l : ">")).join("\n") : ">";
      return "\n\n> [!" + type + "]\n" + quoted + "\n\n";
    }
  });
  td.addRule("highlight", { filter: "mark", replacement: (c) => "==" + c + "==" });
  td.addRule("strikethrough", {
    filter: (n) => n.nodeName === "DEL" || n.nodeName === "S" || n.nodeName === "STRIKE",
    replacement: (c) => "~~" + c + "~~"
  });
  td.addRule("figure", {
    filter: "figure",
    replacement: (content, node) => {
      const img = node.querySelector("img");
      const caption = node.querySelector("figcaption");
      if (!img) return content;
      const alt = caption ? caption.textContent.trim() : (img.getAttribute("alt") || "");
      const src = img.getAttribute("src") || "";
      return "\n\n![" + alt + "](" + src + ")" + (caption ? "\n*" + caption.textContent.trim() + "*" : "") + "\n\n";
    }
  });
  td.addRule("listItem", {
    filter: "li",
    replacement: (content, node) => {
      content = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n    ");
      const parent = node.parentNode;
      let prefix = "- ";
      if (parent && parent.nodeName === "OL") {
        const start = parseInt(parent.getAttribute("start") || "1", 10);
        const index = Array.from(parent.children).indexOf(node);
        prefix = (start + index) + ". ";
      }
      const cb = node.querySelector("input[type=checkbox]");
      if (cb) {
        prefix += cb.checked ? "[x] " : "[ ] ";
        content = content.replace(/^\s*\[[ x]\]\s*/, "");
      }
      return prefix + content.trim() + "\n";
    }
  });
  return td.turndown(html);
}

// ---- Convert Markdown to plain text (for AI prompts) ----
// Moved verbatim from jina.js (behavior unchanged).
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

// ---- GitHub-style heading slug (CJK-preserving) ----
// lowercase -> strip everything except word chars / CJK / spaces / hyphens
// -> spaces to hyphens -> collapse repeats. Used by renderMarkdown headings + P2 buildToc.
function slugify(text) {
  return (text || "")
    .trim()
    .toLowerCase()
    // strip punctuation but keep latin word chars, digits, CJK, whitespace, hyphen
    .replace(/[^\w一-鿿぀-ヿ가-힯\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---- Markdown -> safe HTML (preview only; needs marked + DOMPurify) ----
let _markedConfigured = false;
function _configureMarked() {
  if (_markedConfigured || typeof marked === "undefined") return;
  const renderer = new marked.Renderer();
  // GitHub-style slug id on headings so the TOC anchors (P2/P3) resolve.
  renderer.heading = function (text, level, raw) {
    const id = slugify(typeof raw === "string" ? raw : text);
    return `<h${level} id="${id}">${text}</h${level}>\n`;
  };
  marked.use({ gfm: true, breaks: false, renderer });
  _markedConfigured = true;
}

let _purifyHooked = false;
function _ensurePurifyHook() {
  if (_purifyHooked || typeof DOMPurify === "undefined") return;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  _purifyHooked = true;
}

// The SINGLE sanitize point for the preview page. Replaces both the old
// hand-rolled renderMarkdown AND the raw contentHtml innerHTML injection.
function renderMarkdown(md) {
  if (!md) return "";
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    // Fail safe: never inject unsanitized markup. Escape and return as text.
    return String(md)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  _configureMarked();
  _ensurePurifyHook();
  const rawHtml = marked.parse(md);
  return DOMPurify.sanitize(rawHtml, {
    // Keep heading slug ids for TOC anchors; allow GFM task-list checkboxes.
    ADD_ATTR: ["id", "target", "rel"],
    ADD_TAGS: ["input"]
  });
}

// ── Code highlighting (preview page only; needs highlight.js global `hljs`) ──
// Called AFTER renderMarkdown's sanitized HTML is injected into the DOM.
// Targets ALL block code (`pre > code`): marked tags fenced blocks with a
// language as `class="language-xxx"`, but content from Defuddle->Turndown often
// loses the language (source used a non-standard class), so we also highlight
// untagged blocks via hljs auto-detection. Inline `<code>` is not matched.
// No-op (not a throw) when hljs is absent — popup never vendors highlight.js,
// and the pure string functions in this file must stay usable without it.
function highlightCodeBlocks(root) {
  if (!root || typeof hljs === "undefined") return;
  const blocks = root.querySelectorAll('pre > code');
  blocks.forEach((block) => {
    try {
      hljs.highlightElement(block);
    } catch (_) {
      // A single malformed block must not abort the rest of the page.
    }
  });
}

// ── Export transform ①: YAML frontmatter ──

// Escape a string for a YAML double-quoted scalar (quotes / colons / newlines).
function yamlString(s) {
  const str = s == null ? "" : String(s);
  const escaped = str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\n");
  return '"' + escaped + '"';
}

// meta: {title,url,date,tags,source,description?}
// opts.fields: ordered subset of [title,url,date,tags,source]; description always
// trails (only when present). Bare scalars for url/date/source; quoted for
// title/description; tags as an inline flow array.
function applyFrontmatter(md, meta, opts) {
  meta = meta || {};
  opts = opts || {};
  const fields = opts.fields || ["title", "url", "date", "tags", "source"];
  const lines = ["---"];
  for (const f of fields) {
    if (f === "title") lines.push("title: " + yamlString(meta.title || ""));
    else if (f === "url") lines.push("url: " + (meta.url || ""));
    else if (f === "date") lines.push("date: " + (meta.date || ""));
    else if (f === "tags") lines.push("tags: [" + (Array.isArray(meta.tags) ? meta.tags.join(", ") : "") + "]");
    else if (f === "source") lines.push("source: " + (meta.source || ""));
  }
  if (meta.description) lines.push("description: " + yamlString(meta.description));
  lines.push("---");
  return lines.join("\n") + "\n\n" + (md || "");
}

// ── Export transform ②: image policy ──
// policy: "keep" (absolutize relative src via new URL(src, baseUrl)) |
//         "alt"  (![alt](src) -> alt text; drop image when alt empty) |
//         "strip" (remove all images)
function applyImagePolicy(md, opts) {
  opts = opts || {};
  const policy = opts.policy || "keep";
  const baseUrl = opts.baseUrl || "";
  const IMG = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  if (policy === "strip") {
    return (md || "").replace(IMG, "");
  }
  if (policy === "alt") {
    return (md || "").replace(IMG, (_, alt) => (alt || ""));
  }
  // keep: absolutize relative src
  return (md || "").replace(IMG, (whole, alt, src) => {
    let abs = src;
    if (baseUrl && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//")) {
      try { abs = new URL(src, baseUrl).href; } catch (_) { return whole; }
    }
    return "![" + alt + "](" + abs + ")";
  });
}

// ── Export transform ③: table of contents ──
// Scans ATX headings in [minLevel,maxLevel], skipping fenced code blocks.
// Slugs reuse P1 slugify() (GitHub-style, CJK preserved). De-dupes slugs with -1, -2…
// Returns { tocMarkdown, headings:[{level,text,slug}] }.
function buildToc(md, opts) {
  opts = opts || {};
  const minLevel = opts.minLevel || 2;
  const maxLevel = opts.maxLevel || 4;
  const lines = (md || "").split("\n");
  const headings = [];
  const seen = Object.create(null);
  let inFence = false;
  for (const line of lines) {
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const level = m[1].length;
    if (level < minLevel || level > maxLevel) continue;
    const text = m[2].trim();
    let slug = slugify(text);
    if (seen[slug] != null) { seen[slug] += 1; slug = slug + "-" + seen[slug]; }
    else seen[slug] = 0;
    headings.push({ level, text, slug });
  }
  if (!headings.length) return { tocMarkdown: "", headings };
  const body = headings.map(h => {
    const indent = "  ".repeat(h.level - minLevel);
    return indent + "- [" + h.text + "](#" + h.slug + ")";
  }).join("\n");
  return { tocMarkdown: "## Contents\n" + body, headings };
}

// ── Export transform ④: reading stats ──
// CJK-aware: Latin counted by whitespace words, CJK by character.
// minutes = ceil(words/200 + cjkChars/350); 0 for empty input.
function readingStats(md) {
  const plain = markdownToPlainText(md || "");
  // CJK ranges: CJK Unified + Ext-A, Hiragana/Katakana, Hangul, full-width forms
  const cjkRe = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g;
  const cjkMatches = plain.match(cjkRe);
  const cjkChars = cjkMatches ? cjkMatches.length : 0;
  // Strip CJK before tokenizing Latin so CJK runs don't inflate word count
  const latinPart = plain.replace(cjkRe, " ").trim();
  const words = latinPart ? latinPart.split(/\s+/).filter(Boolean).length : 0;
  const minutes = (words === 0 && cjkChars === 0) ? 0 : Math.ceil(words / 200 + cjkChars / 350);
  return { words, cjkChars, minutes };
}

// ── Export orchestrator ──
// opts: { frontmatter:bool, imagePolicy:"keep"|"alt"|"strip", includeToc:bool }
// Order: imagePolicy → (TOC prepend) → (frontmatter prepend). baseUrl = meta.url.
function composeExport(canonicalMd, meta, opts) {
  meta = meta || {};
  opts = opts || {};
  let body = applyImagePolicy(canonicalMd || "", {
    policy: opts.imagePolicy || "keep",
    baseUrl: meta.url || ""
  });
  if (opts.includeToc) {
    const { tocMarkdown } = buildToc(body, { minLevel: 2, maxLevel: 4 });
    if (tocMarkdown) body = tocMarkdown + "\n\n" + body;
  }
  if (opts.frontmatter) {
    body = applyFrontmatter(body, meta, {});
  }
  return body;
}

// ── Shared download helpers (used by popup + preview) ──
// safeFilename: keep latin word chars, digits, CJK, space, hyphen; everything
// else -> "_"; cap at 80; empty -> "untitled". (Moved/unified from md-preview.js.)
function safeFilename(title) {
  const base = (title || "untitled").replace(/[^a-zA-Z0-9_一-鿿 -]/g, "_").slice(0, 80);
  return base || "untitled";
}

// downloadFile: Blob + transient <a download>. Click-time only (no boot cost).
function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Standalone styled HTML export (Download .html) ──
// Curated, print-friendly reader stylesheet for the exported document. Scoped to
// .export-doc so it never collides with hljs token rules. Light + dark.
const READER_CSS = `
:root{--x-fg:#1a202c;--x-mut:#5a6473;--x-bd:#e2e8f0;--x-bdl:#eef2f7;--x-link:#2563eb;--x-code-bg:#f1f5f9;--x-code-fg:#334155;--x-bq-bd:#2563eb;--x-bq-bg:#f0f9ff;--x-bq-fg:#1e3a5f;--x-stripe:#f8fafc;--x-surface:#fff;--x-bg:#fff}
@media (prefers-color-scheme:dark){:root{--x-fg:#e2e8f0;--x-mut:#94a3b8;--x-bd:#2d3748;--x-bdl:#252d3a;--x-link:#60a5fa;--x-code-bg:#1e293b;--x-code-fg:#cbd5e1;--x-bq-bd:#3b82f6;--x-bq-bg:#172554;--x-bq-fg:#bfdbfe;--x-stripe:#1e293b;--x-surface:#1e293b;--x-bg:#0f172a}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--x-bg)}
.export-doc{max-width:760px;margin:0 auto;padding:48px 24px 96px;color:var(--x-fg);line-height:1.75;font-size:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;-webkit-font-smoothing:antialiased}
.export-doc header{margin-bottom:32px;padding-bottom:16px;border-bottom:1px solid var(--x-bd)}
.export-doc .doc-title{margin:0 0 6px;font-size:2em;font-weight:700;line-height:1.25}
.export-doc .doc-meta{margin:0;color:var(--x-mut);font-size:.85em;word-break:break-word}
.export-doc .doc-meta a{color:var(--x-mut)}
.export-doc h1,.export-doc h2,.export-doc h3,.export-doc h4{font-weight:650;line-height:1.3;margin:1.6em 0 .5em}
.export-doc h1{font-size:1.9em}.export-doc h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid var(--x-bdl)}.export-doc h3{font-size:1.25em}.export-doc h4{font-size:1.05em;color:var(--x-mut)}
.export-doc p{margin:1em 0}
.export-doc a{color:var(--x-link);text-decoration:underline;text-underline-offset:2px}
.export-doc code{font-family:"SFMono-Regular","Cascadia Code",Consolas,"PingFang SC","Microsoft YaHei",monospace;background:var(--x-code-bg);color:var(--x-code-fg);padding:2px 7px;border-radius:4px;font-size:.875em}
.export-doc pre{background:var(--x-surface);border:1px solid var(--x-bd);padding:20px 24px;border-radius:8px;overflow-x:auto;margin:1.5em 0;line-height:1.55}
.export-doc pre code{background:none;padding:0;border-radius:0;font-size:13px}
.export-doc blockquote{border-left:3px solid var(--x-bq-bd);background:var(--x-bq-bg);color:var(--x-bq-fg);padding:12px 20px;margin:1.5em 0;border-radius:0 6px 6px 0}
.export-doc blockquote p{margin:.4em 0}
.export-doc img{max-width:100%;height:auto;border-radius:8px;margin:1.5em 0;border:1px solid var(--x-bd)}
.export-doc ul,.export-doc ol{margin:1em 0;padding-left:1.75em}
.export-doc li{margin:.35em 0}
.export-doc table{border-collapse:collapse;width:100%;margin:1.5em 0;font-size:.9375em;border:1px solid var(--x-bd);border-radius:8px;overflow:hidden}
.export-doc th,.export-doc td{padding:10px 16px;text-align:left;border-bottom:1px solid var(--x-bdl)}
.export-doc thead{background:var(--x-code-bg)}
.export-doc tbody tr:nth-child(even){background:var(--x-stripe)}
.export-doc hr{border:none;border-top:1px solid var(--x-bd);margin:2.5em 0}
@media print{html,body{background:#fff}.export-doc{max-width:100%;padding:0}}
`;

// HTML-escape for text contexts (title, header fields).
function _xmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// composeStyledHtml: canonical markdown -> a complete self-contained HTML doc.
// Honors imagePolicy + includeToc via composeExport; frontmatter is rendered as a
// VISIBLE header (never YAML). renderMarkdown + highlightCodeBlocks run on a
// detached node (needs a DOM — preview/test page, not the popup). The caller
// passes opts.hljsCss (fetched from the vendored theme) so this stays chrome-free.
// meta: {title,url,date,tags,source,description?}
// opts: { frontmatter, imagePolicy, includeToc, hljsCss }
function composeStyledHtml(canonicalMd, meta, opts) {
  meta = meta || {};
  opts = opts || {};
  const bodyMd = composeExport(canonicalMd || "", meta, {
    frontmatter: false,
    imagePolicy: opts.imagePolicy || "keep",
    includeToc: !!opts.includeToc
  });
  let article = renderMarkdown(bodyMd);
  if (typeof document !== "undefined" && typeof hljs !== "undefined") {
    const tmp = document.createElement("div");
    tmp.innerHTML = article;
    highlightCodeBlocks(tmp);
    article = tmp.innerHTML;
  }
  let header = "";
  if (opts.frontmatter) {
    const parts = [];
    if (meta.title) parts.push('<h1 class="doc-title">' + _xmlEscape(meta.title) + "</h1>");
    const sub = [];
    if (meta.url) {
      const safeUrl = /^https?:\/\//i.test(meta.url) ? meta.url : "";
      if (safeUrl) sub.push('<a href="' + _xmlEscape(safeUrl) + '" rel="noopener noreferrer">' + _xmlEscape(safeUrl) + "</a>");
      else sub.push("<span>" + _xmlEscape(meta.url) + "</span>");
    }
    if (meta.date) sub.push("<span>" + _xmlEscape(meta.date) + "</span>");
    if (Array.isArray(meta.tags) && meta.tags.length) sub.push("<span>" + meta.tags.map(_xmlEscape).join(", ") + "</span>");
    if (sub.length) parts.push('<p class="doc-meta">' + sub.join(" &middot; ") + "</p>");
    if (parts.length) header = '<header class="doc-header">' + parts.join("") + "</header>\n";
  }
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    "<title>" + _xmlEscape(meta.title || "Document") + "</title>\n<style>\n" +
    READER_CSS + (opts.hljsCss || "") + "\n</style>\n</head>\n<body>\n" +
    '<main class="export-doc">\n' + header + article + "\n</main>\n</body>\n</html>\n";
}
