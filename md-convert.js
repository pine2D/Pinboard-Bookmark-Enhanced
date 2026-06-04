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

// ---- Code highlighting stub (real implementation lands in Phase P3.2) ----
// No-op until highlight.js is vendored (P3). Declared here so md-convert.js's
// API surface (spec §4) is complete from P1 and md-preview.js can wire it
// safely. P3.2 locates this exact function and replaces its body.
function highlightCodeBlocks(root) {
  // no-op stub — replaced in Phase P3.2
}
