# Jina Reader Integration Design

Date: 2026-04-10
Status: Approved

## Overview

Integrate Jina Reader API into Pinboard Bookmark Enhanced as a dual-purpose feature:
1. **Markdown Export** — Convert current page to Markdown, copy to clipboard, preview in dedicated page
2. **AI Content Enhancement** — Use Jina Reader as an optional higher-quality content source for AI tag/summary generation, with fallback to local extraction

## Approach: Gradual Enhancement (Option C)

Keep existing `getPageInfoFromTab()` intact. Jina Reader is an optional enrichment layer:
- Local extraction always runs first (guarantees baseline functionality)
- If user opts in to Jina as AI content source, Jina result replaces `pageInfo.pageText`
- Jina failure silently falls back to local content
- Markdown export and AI pipeline share the same Jina cache

## New Files

### `jina.js` — API Wrapper + Cache

Core functions:

```javascript
async function fetchJinaMarkdown(url, options = {})
// options: { apiKey, forceRefresh, cacheDuration }
// Uses JSON mode: Accept: application/json
// Returns: { markdown, title, url, tokens, fromCache, error, fallback }

function markdownToPlainText(markdown)
// Strips #, **, [](), ````, etc. Keeps structured text for AI consumption
```

API call details:
- Endpoint: `GET https://r.jina.ai/{targetUrl}`
- Header: `Accept: application/json` (returns `{ data: { title, content, url, usage } }`)
- Header: `Authorization: Bearer {apiKey}` (if configured, otherwise omitted for free tier)
- Response `data.content` is standard Markdown

Cache strategy:
- Key: `jina_md_{url}`
- TTL: reuses existing `aiCacheDuration` setting (default 60 min)
- Storage: `chrome.storage.local`
- Cleanup: reuses existing background.js alarm-based cache cleanup

Error handling:
- Network error / non-200 → return `{ error, fallback: true }`
- Callers check `fallback` flag to decide whether to use local content

### `jina-preview.html` + `jina-preview.js` + `jina-preview.css` — Preview Page

Opens as a new tab via `chrome.tabs.create({ url: 'jina-preview.html' })`.

Data transfer: Popup writes to `chrome.storage.local` key `jina_preview_data` → preview page reads and clears.

Layout:
```
┌──────────────────────────────────────────────┐
│  Title                                       │
│  URL                              tokens: N  │
├──────────────────────────────────────────────┤
│  [Raw] [Rendered]    [Copy MD] [Copy HTML]   │
├──────────────────────────────────────────────┤
│  (content area, full page scrollable)        │
└──────────────────────────────────────────────┘
```

Features:
- Raw view: `<pre>` with monospace font
- Rendered view: built-in Markdown→HTML converter (no external deps)
  - Supports: headings, bold/italic, links, images, code blocks, lists, blockquotes, tables
- Copy MD: raw Markdown to clipboard
- Copy HTML: rendered HTML to clipboard
- Light/dark follows `prefers-color-scheme`
- Does NOT reuse extension theme system (independent tool page)

## Modified Files

### `popup.html`

- Add `<script src="jina.js">` to script list
- Add button in `quick-row`:
  ```html
  <button id="jina-md-btn" class="qbtn">Markdown</button>
  ```

### `popup.js`

Markdown button handler:
1. Click → button shows "Converting..." (disabled)
2. Call `fetchJinaMarkdown(currentUrl, { apiKey, cacheDuration })`
3. Success → copy to clipboard, button shows "Copied! | View"
   - "View" click → write to storage + open jina-preview.html
4. Failure → button shows "Failed" (2s reset), tooltip with error
5. Non-http pages → button disabled with tooltip

### `ai.js`

Modified content pipeline:
```
getPageInfoFromTab() → pageInfo.pageText (always runs)
  ↓
if (settings.aiContentSource === 'jina')
  ↓
  fetchJinaMarkdown(url) → markdownToPlainText() → replace pageInfo.pageText
  ↓
  failure? → silent fallback, console.warn
  ↓
buildTagPrompt / buildSummaryPrompt (uses final pageText)
```

### `options.html` + `options.js`

New settings section after AI Provider:

```
── AI Content Source ────────────────────
  Content Source:  ○ Local (built-in extraction)
                   ○ Jina Reader (higher quality)

── Jina Reader ─────────────────────────
  API Key:         [jina_xxxx (optional)]
```

- Jina API Key is independent of Content Source choice
- Even with "Local" selected, Markdown export button in popup works

### `shared.js`

New defaults in `SETTINGS_DEFAULTS`:
```javascript
aiContentSource: 'local',   // 'local' | 'jina'
jinaApiKey: '',              // stored with obfuscateKey()
```

### `manifest.json`

- Add `https://r.jina.ai/*` to `host_permissions`

### `_locales/*/messages.json`

New keys:
- `jinaMarkdownBtn`, `jinaConverting`, `jinaCopied`, `jinaFailed`, `jinaViewBtn`
- `jinaApiKeyLabel`, `jinaApiKeyPlaceholder`
- `aiContentSourceLabel`, `aiContentSourceLocal`, `aiContentSourceJina`
- `jinaPreviewTitle`, `jinaPreviewRaw`, `jinaPreviewRendered`
- `jinaPreviewCopyMd`, `jinaPreviewCopyHtml`

## Architecture Diagram

```
                     Popup
                    ┌──────────────┐
                    │ [Markdown]   │──→ fetchJinaMarkdown() ──→ clipboard
                    │              │         │                    + preview page
                    │ [AI Tags]    │──→ ┐    │
                    │ [AI Summary] │──→ ┤    ▼
                    └──────────────┘    │  jina cache
                                       │  (chrome.storage.local)
                                       ▼
                              AI Content Pipeline
                              ┌───────────────────┐
                              │ getPageInfoFromTab │ (always)
                              │        ↓           │
                              │ aiContentSource?   │
                              │  local → use as-is │
                              │  jina  → enrich    │──→ fetchJinaMarkdown()
                              │        ↓           │    (cache hit = instant)
                              │ buildPrompt()      │
                              │ callAI()           │
                              └───────────────────┘
```

## Non-Goals

- No Jina search (`s.jina.ai`) integration
- No streaming mode (`text/event-stream`)
- No image captioning (`X-With-Generated-Alt`)
- No integration with batch save or keyboard shortcuts
- Preview page does not support extension themes
