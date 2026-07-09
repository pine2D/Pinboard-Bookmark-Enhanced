---
layout: default
title: Privacy Policy
---

# Privacy Policy — Pinboard Bookmark Enhanced

**Last updated:** 2026-07-09

## Summary

Pinboard Bookmark Enhanced is **local-first** and **bring-your-own-key**. It has **no developer servers, no analytics, no tracking, and no telemetry** — the developer never receives your data. The extension talks only to services **you** configure (your Pinboard account and the AI / archiving services you choose), and only when **you** trigger an action.

## Data Storage

By **default**, all data is stored **locally** on your device (`chrome.storage.local`) and never leaves it. You can optionally enable **settings sync** (off by default); when enabled, only your settings — not your saved bookmarks or page content — are synced across your devices through Chrome's built-in account sync.

| Data | Default storage | Synced via Google Account |
|------|-----------------|--------------------------|
| Settings & preferences | `chrome.storage.local` | Only if you enable settings sync |
| API keys & tokens (obfuscated) | `chrome.storage.local` | Only if you enable settings sync |
| Custom CSS & themes | `chrome.storage.local` (chunked) | Only if you enable settings sync |
| AI result cache | `chrome.storage.local` | No |
| Tag cache & tag-cleanup state | `chrome.storage.local` | No |
| Bookmark-status cache | `chrome.storage.local` | No |
| Offline save queue | `chrome.storage.local` | No |
| Markdown preview data | `chrome.storage.local` | No |
| Reader highlights & notes | `chrome.storage.local` | No |
| Wayback archive log | `chrome.storage.local` | No |

Settings sync is implemented with Chrome's `chrome.storage.sync`. The extension itself has no server and uploads nothing on its own. Stored credentials are obfuscated at rest (not cryptographically encrypted) and are sent over HTTPS only to their respective services to authenticate your own requests.

Manual settings backups are JSON files you explicitly export. If **Include highlights and notes in backups** is enabled, manual backups also include reader highlight data: page URLs, page titles, selected highlight text, note text, highlight colors, and timestamps. API keys, Pinboard tokens, WebDAV passwords, and export-target tokens are not included.

## Chrome Web Store Data Categories

The Chrome Web Store privacy form uses standardized data categories. To keep the store listing consistent with this policy, this extension discloses that it handles the following categories:

| Category | Why it applies |
|----------|----------------|
| Personally identifiable information | Your Pinboard API token includes your Pinboard username, and optional backup/export settings may include usernames you enter, such as a WebDAV username |
| Authentication information | The extension stores and uses credentials you provide, such as your Pinboard API token, AI provider keys, GitHub token, webhook authorization value, and WebDAV password |
| Web history | The extension reads page URLs and titles for bookmark status, popup prefill, batch save, Save Tab Set, offline queue, and bookmark/export metadata |
| Website content | The extension can extract page text, selected text, links, metadata, highlights, and notes for AI tags/summaries, Markdown preview, Translate, Ask-the-page, Explain-selection, exports, and optional backups |

The extension does **not** collect health information, financial/payment information, location, personal communications as a separate category, or user activity for analytics/tracking. It has no developer-operated analytics, telemetry, advertising, or profiling.

## Network Requests

The extension only makes network requests to services **you explicitly configure**, and — except for the bookmark-status check noted below — only when **you** trigger an action:

1. **Pinboard API** (`api.pinboard.in`) — to save, retrieve, and manage your bookmarks, authenticated with your Pinboard API token. The **tag-cleanup tool**, when you run it, downloads your full bookmark/tag list (`posts/all`, `tags/get`) and re-saves affected bookmarks to rename or merge tags — all to and from your own Pinboard account. The extension also checks whether the current page is already bookmarked as you navigate, sending the active tab's URL to the Pinboard API to set the toolbar icon state.

2. **Pinboard website** (`pinboard.in`) — (a) a content script applies your chosen theme CSS and tag-sort tweaks on pinboard.in pages; no data is extracted or transmitted. (b) **Save Tab Set** POSTs the open tabs' titles and URLs to `pinboard.in/tabs/save/` using your existing pinboard.in **login session cookie** (not the API token), then opens `pinboard.in/tabs/show/` for you to confirm.

3. **AI provider APIs** (only when you trigger AI tags, AI summary, Markdown preview, Translate, Ask-the-page, Explain/Translate-selection, the opt-in key-points skim, or batch-save with AI enabled) — the page title, URL, and extracted article text are sent to **the provider you chose** to generate the requested result. Tag/summary requests send roughly the first 8 KB of extracted text; Markdown preview, Translate, and Ask-the-page send more of the extracted content (sampled to a token budget). Supported providers: OpenAI, Anthropic, Google Gemini, DeepSeek, Qwen, MiniMax, OpenRouter, Groq, Mistral, Cohere, SiliconFlow, Zhipu, Moonshot, a **local Ollama** instance, or a **Custom OpenAI-compatible endpoint** (any base URL you enter). **No data is sent to any AI provider unless you explicitly trigger it.**

4. **Jina Reader** (`r.jina.ai`, optional) — when you choose the Jina content source, the page URL is sent to Jina to fetch a cleaner reader-mode rendering for AI processing or Markdown export. Disabled by default.

5. **Wayback Machine** (`web.archive.org`, optional, opt-in) — when you enable Wayback archiving, the URL of a page you save is sent to the Internet Archive to create a public snapshot. Requires a one-time permission grant; off by default.

6. **Obsidian** (local app, optional) — the **Send to Obsidian** action hands the converted Markdown of the current page to your local Obsidian desktop app via the `obsidian://` protocol or the system clipboard. This stays on your device; nothing is sent over the network.

7. **GitHub Gist** (`api.github.com`, optional — inactive until you configure it) — the **Send to Gist** action uploads the converted Markdown of the current page (including its metadata frontmatter) as a **secret gist** on your own GitHub account, authenticated with a personal access token you provide. Requires a one-time permission grant for `api.github.com`.

8. **Webhook** (a URL you configure, optional — inactive until you configure it) — the **Send to Webhook** action POSTs a JSON payload to the endpoint you entered (e.g. Readwise), with an Authorization header value you provide. The payload contains the page's title, URL, save date, tags, and converted Markdown; when extended export metadata is enabled (default on), it also includes the page's author, original publish date, site name, cover-image URL, and word count. Requires a one-time permission grant for that origin. The extension warns if the endpoint is plain `http://`, since credentials and content would travel unencrypted.

9. **WebDAV** (a server URL you configure, optional — inactive until you configure it) — the **Push now** action (and, if you enable it, an hourly or daily automatic push) uploads your non-secret settings as a JSON file to the WebDAV server you specify, authenticated with the username/password you provide (sent as HTTP Basic auth). If **Include highlights and notes in backups** is enabled, the WebDAV backup also includes page URLs, page titles, selected highlight text, note text, highlight colors, and timestamps. The payload never includes API keys, Pinboard tokens, WebDAV passwords, or export-target tokens. **Pull now** downloads that file and, only after you explicitly confirm an overwrite dialog showing when it was last pushed, applies it to your local settings. Requires a one-time permission grant for that server's origin. The extension warns if the server URL is plain `http://`, since credentials would travel unencrypted.

All page content and URLs are transmitted **only to the destination you selected** for that action, and **never to the developer**.

## Permissions

| Permission | Purpose |
|------------|---------|
| `activeTab` | Read the current page's title, URL, and selected text for bookmarking and content extraction |
| `storage` | Store settings, obfuscated keys, and caches locally (synced only if you enable it) |
| `scripting` | Inject the Defuddle extractor (and optional per-site rules) into the active tab to pull clean article text — only on explicit action: AI tags/summary, Markdown preview / Translate / Ask / Explain, or batch-save with AI |
| `tabs` | Read tab URLs/titles for bookmark-status detection, batch save, and Save Tab Set |
| `notifications` | Show save confirmations and a 30-second Undo button |
| `alarms` | Keep the service worker warm, refresh caches, and (optionally) prewarm the Pinboard tag list |
| `host_permissions` | API calls to Pinboard and the 14 user-selectable AI/extraction endpoints (13 cloud providers + Jina) |
| `optional_host_permissions: *://*/*` | Requested at runtime to extract page text from non-active tabs during batch save, to reach a Custom AI endpoint or non-loopback Ollama URL you configure, to deliver **Send-to** exports to GitHub Gist (`api.github.com`) or a webhook URL you configure, and to push/pull your settings backup to a WebDAV server you configure |
| `optional_host_permissions: localhost / 127.0.0.1` | Reach a local Ollama instance you run on your own machine |
| `web.archive.org` (requested on demand) | Submit saved URLs to the Wayback Machine when you enable archiving |

## Third-Party Services

The extension communicates with third-party services **only at your direction**:
- **Pinboard** — your bookmark service, using your API token (and your login cookie for Save Tab Set)
- **AI providers** — only the provider you select and configure with your own API key (or a local Ollama / custom endpoint)
- **Jina Reader** — only if you select it as a content source
- **Wayback Machine** — only if you enable archiving
- **Obsidian** — your local desktop app, only via Send to Obsidian
- **GitHub** — only if you configure the Send-to-Gist target, using your own access token
- **Your webhook endpoint** — only if you configure one; you choose and control the destination
- **Your WebDAV server** — only if you configure one; you choose and control the destination for settings backups and, if enabled, highlights and notes backups

No data is shared with any other third party, and none is sent to the developer.

## Changes

If this privacy policy changes, the update will be included in the extension release notes and the **Last updated** date above will be revised.

## Contact

For questions about this privacy policy, open an issue at: <https://github.com/pine2D/Pinboard-Bookmark-Enhanced/issues>
