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

// Body for a .md FILE (download / long-content fallback) per the row's
// frontmatter policy. rawBody is expected YAML-free (getViewMarkdown()).
function pbpBuildFileBody(id, meta, rawBody) {
  const row = PBP_EXPORT_TARGETS[id];
  rawBody = String(rawBody == null ? "" : rawBody);
  const policy = row ? row.frontmatter : "strip";
  if (policy === "inline") return applyFrontmatter(rawBody, meta || {}, {}); // md-convert.js
  return rawBody; // "strip"
}

// Is the assembled URI too long to hand to the OS protocol launcher?
function pbpUriTooLong(uri) { return String(uri || "").length > PBP_URI_BUDGET; }

// Inline SVG icons (no emoji — font-fallback rule). 16px line icons.
const _PBP_ICON_OBSIDIAN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>';

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
  }
};

// Display order for the menu + settings rendering.
function pbpExportTargetIds() { return ["obsidian"]; }
