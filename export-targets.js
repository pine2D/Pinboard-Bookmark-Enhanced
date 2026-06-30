// ============================================================
// Pinboard Bookmark Enhanced — Export Targets registry (PURE)
// No DOM / chrome / fetch. Loaded by md-preview.html, options.html, tests.
// Depends only on md-convert.js globals (applyFrontmatter, buildObsidianUri,
// safeFilename), which load before this file everywhere it is used.
// ============================================================

// Safe ceiling for a custom-scheme URI handed to the OS protocol launcher.
// HARD WALL = Windows: ShellExecute caps ~2048, and Chromium's external-protocol
// prompt SILENTLY no-ops its "Open" button above ~2046 chars (crbug 727909).
// macOS/Linux allow far more, but this single cross-platform constant stays
// Windows-safe. DO NOT raise above ~2000 — past the wall content is silently
// LOST (worse than the clipboard fallback). Long bodies go via clipboard /
// the HTTP token API, never a longer URL. encodeURIComponent inflates markdown
// ~1.6x (ASCII) / ~9x (CJK), so even 2000 holds only ~1200 ASCII / ~220 CJK raw chars.
const PBP_URI_BUDGET = 2000;

// Remove a single leading YAML frontmatter block ("---\n...\n---"). Idempotent;
// no-op when absent. (rawBody from getViewMarkdown() is already YAML-free; this
// guards callers that pass a frontmattered string.)
function pbpStripFrontmatter(md) {
  return String(md == null ? "" : md).replace(/^﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n\r?\n?)?/, "");
}

// meta {title,url,date,tags[]} -> Logseq first-block page properties (no YAML).
function pbpToLogseqProps(meta) {
  meta = meta || {};
  const lines = [];
  if (meta.title) lines.push("title:: " + meta.title);
  if (meta.url) lines.push("url:: " + meta.url);
  if (meta.date) lines.push("date:: " + meta.date);
  if (Array.isArray(meta.tags) && meta.tags.length) lines.push("tags:: " + meta.tags.join(", "));
  return lines.join("\n");
}

// Body for a .md FILE (download / long-content fallback) per the row's
// frontmatter policy. rawBody is expected YAML-free (getViewMarkdown()).
function pbpBuildFileBody(id, meta, rawBody) {
  const row = PBP_EXPORT_TARGETS[id];
  rawBody = String(rawBody == null ? "" : rawBody);
  const policy = row ? row.frontmatter : "strip";
  if (policy === "inline") return applyFrontmatter(rawBody, meta || {}, {}); // md-convert.js
  if (policy === "map") {
    const props = pbpToLogseqProps(meta);
    return props ? props + "\n\n" + rawBody : rawBody;
  }
  return rawBody; // "strip"
}

// Is the assembled URI too long to hand to the OS protocol launcher?
function pbpUriTooLong(uri) { return String(uri || "").length > PBP_URI_BUDGET; }

// Inline SVG icons (no emoji — font-fallback rule). 16px line icons.
const _PBP_ICON_OBSIDIAN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>';
const _PBP_ICON_LOGSEQ =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>';

const PBP_EXPORT_TARGETS = {
  obsidian: {
    id: "obsidian",
    label: "Obsidian",
    icon: _PBP_ICON_OBSIDIAN,
    mechanism: "url-scheme",
    viaClipboard: true,          // body goes via the system clipboard, not the URI
    frontmatter: "inline",       // Obsidian parses YAML natively
    buildUri(meta, rawBody, cfg) {
      cfg = cfg || {};
      return buildObsidianUri({  // md-convert.js global
        vault: cfg.vault, folder: cfg.folder,
        name: safeFilename((meta && meta.title) || "Untitled"),
        clipboard: true, content: ""
      });
    },
    settings: [
      { key: "vault", type: "text", label: "mdObsidianVault" },
      { key: "folder", type: "text", label: "mdObsidianFolder" }
    ],
    onboarding: ""
  },

  logseq: {
    id: "logseq",
    label: "Logseq",
    icon: _PBP_ICON_LOGSEQ,
    mechanism: "url-scheme",
    viaClipboard: false,         // content rides the URI (subject to length budget)
    frontmatter: "map",          // .md fallback uses key:: value props
    buildUri(meta, rawBody, cfg) {
      meta = meta || {};
      const enc = encodeURIComponent;
      let content = String(rawBody || "");
      if (Array.isArray(meta.tags) && meta.tags.length) {
        content += "\n" + meta.tags.map((t) => "#" + String(t).replace(/\s+/g, "-")).join(" ");
      }
      return "logseq://x-callback-url/quickCapture?title=" + enc(meta.title || "") +
        "&url=" + enc(meta.url || "") + "&content=" + enc(content) +
        "&page=TODAY&append=true";
    },
    // --- Logseq local HTTP API (used when cfg.token is set) ---
    origin: "http://127.0.0.1/*",
    pageTitle(meta) {
      meta = meta || {};
      let title = String(meta.title || "Untitled").replace(/[\/\\#%\[\]]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 100);
      return title || "Untitled";
    },
    // Logseq has no folders; group via a page `tags` property (notebook + article
    // tags). The HTTP API does NOT parse `key:: value` TEXT into properties — they
    // MUST ride createPage's structured 2nd arg (verified against the shipping
    // "Send To Logseq" extension: it extracts leading property lines client-side
    // and passes them as createPage(name, {tags:[...]}, ...)). A `tags::` text line
    // in an appended block is a no-op page-tag-wise — that was the Smoke7 bug.
    _logseqTags(meta, cfg) {
      const tags = [];
      if (cfg && cfg.notebook && String(cfg.notebook).trim()) tags.push(String(cfg.notebook).trim());
      if (meta && Array.isArray(meta.tags)) meta.tags.forEach((t) => { const s = String(t).trim(); if (s) tags.push(s); });
      return tags;
    },
    preRequest(meta, cfg, token) {
      const port = String((cfg && cfg.port) || "12315");
      const tags = this._logseqTags(meta, cfg);
      const props = tags.length ? { tags: tags } : {};   // structured page property
      return {
        url: "http://127.0.0.1:" + port + "/api",
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({
          method: "logseq.Editor.createPage",
          args: [this.pageTitle(meta), props, { createFirstBlock: false, journal: false, redirect: true }]
        })
      };
    },
    buildRequest(meta, body, cfg, token) {
      cfg = cfg || {}; meta = meta || {};
      const port = String(cfg.port || "12315");
      // Tags are set as page properties in preRequest's createPage; the body block
      // carries only a human-readable Source/date line + the article.
      const metaLine = [meta.url ? "Source: " + meta.url : "", meta.date || ""].filter(Boolean).join("  ·  ");
      const content = (metaLine ? metaLine + "\n\n" : "") + String(body || "");
      return {
        url: "http://127.0.0.1:" + port + "/api",
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ method: "logseq.Editor.appendBlockInPage", args: [this.pageTitle(meta), content] })
      };
    },
    precheckRequest(cfg, token) {
      const port = String((cfg && cfg.port) || "12315");
      return {
        url: "http://127.0.0.1:" + port + "/api",
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ method: "logseq.App.getUserConfigs" })
      };
    },
    settings: [
      { key: "token", type: "secret", label: "mdTargetLogseqToken" },
      { key: "notebook", type: "text", label: "mdTargetLogseqNotebook", placeholder: "Clippings" },
      { key: "port", type: "text", label: "mdTargetLogseqPort", placeholder: "12315" }
    ],
    onboarding: "mdTargetLogseqOnboarding"
  }
};

// Display order for the menu + settings rendering.
function pbpExportTargetIds() { return ["obsidian", "logseq"]; }
