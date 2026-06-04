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
      const out = [];
      rows.forEach((row, i) => {
        const cells = Array.from(row.querySelectorAll("th, td"))
          .map(c => (c.textContent || "").trim().replace(/\|/g, "\\|").replace(/\n/g, " "));
        out.push("| " + cells.join(" | ") + " |");
        if (i === 0) out.push("| " + cells.map(() => "---").join(" | ") + " |");
      });
      return "\n\n" + out.join("\n") + "\n\n";
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
// marked emits fenced blocks as <pre><code class="language-xxx">…</code></pre>.
// No-op (not a throw) when hljs is absent — popup never vendors highlight.js,
// and the pure string functions in this file must stay usable without it.
function highlightCodeBlocks(root) {
  if (!root || typeof hljs === "undefined") return;
  const blocks = root.querySelectorAll('pre > code[class*="language-"]');
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
