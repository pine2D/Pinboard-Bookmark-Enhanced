// ============================================================
// Pinboard Bookmark Enhanced — Export Targets registry (PURE)
// No DOM / chrome / fetch. Loaded by md-preview.html, options.html, tests.
// Depends only on md-convert.js globals (applyFrontmatter, buildObsidianUri,
// safeFilename), which load before this file everywhere it is used.
// ============================================================

// Safe ceiling for a custom-scheme URI. The OS/Chromium external-protocol
// length limit is undocumented; ~2000 is the practical cap, 1800 leaves slack.
const PBP_URI_BUDGET = 1800;

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
const _PBP_ICON_CAPACITIES =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z"/></svg>';

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
    settings: [],
    onboarding: "mdTargetLogseqOnboarding"
  },

  capacities: {
    id: "capacities",
    label: "Capacities",
    icon: _PBP_ICON_CAPACITIES,
    mechanism: "url-scheme",
    viaClipboard: false,
    frontmatter: "strip",
    buildUri(meta, rawBody, cfg) {
      meta = meta || {}; cfg = cfg || {};
      const enc = encodeURIComponent;
      const title = meta.title || "";
      // createNewObject now uses `name` (verified) — send both name and title.
      return "capacities://x-callback-url/createNewObject?name=" + enc(title) +
        "&title=" + enc(title) + "&type=" + enc(cfg.type || "Weblink") +
        (cfg.spaceId ? "&spaceId=" + enc(cfg.spaceId) : "") +
        "&content=" + enc(String(rawBody || "")) +
        "&x-source=" + enc("Pinboard Bookmark Enhanced");
    },
    settings: [
      { key: "spaceId", type: "text", label: "mdTargetCapacitiesSpaceId", required: true },
      { key: "type", type: "text", label: "mdTargetCapacitiesType", placeholder: "Weblink" }
    ],
    onboarding: "mdTargetCapacitiesOnboarding"
  }
};

// Display order for the menu + settings rendering.
function pbpExportTargetIds() { return ["obsidian", "logseq", "capacities"]; }
