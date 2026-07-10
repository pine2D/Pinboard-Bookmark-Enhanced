---
layout: default
title: Privacy Policy
---

# Privacy Policy — Pinboard Bookmark Enhanced

**Last updated:** 2026-07-11

## Summary

Pinboard Bookmark Enhanced is **local-first** and **bring-your-own-key**. It has **no developer servers, no analytics, no tracking, and no telemetry** — the developer never receives your data. The extension uses Pinboard for its core bookmark features and contacts other services only for features and destinations you configure. Some opt-in features can run automatically after you enable them, as detailed below.

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

The extension uses the required Pinboard hosts for its core bookmark features. Every other network destination requires an optional grant for the **exact current origin**. Permission prompts are initiated only from a direct user action; automatic and background paths only check an existing grant and skip or fail safely when it is absent.

1. **Pinboard API** (`api.pinboard.in`) — to save, retrieve, and manage your bookmarks, authenticated with your Pinboard API token. The **tag-cleanup tool**, when you run it, downloads your full bookmark/tag list (`posts/all`, `tags/get`) and re-saves affected bookmarks to rename or merge tags — all to and from your own Pinboard account. The extension also checks whether the current page is already bookmarked as you navigate, sending the active tab's URL to the Pinboard API to set the toolbar icon state.

2. **Pinboard website** (`pinboard.in`) — (a) a content script applies your chosen theme CSS and tag-sort tweaks on pinboard.in pages; no data is extracted or transmitted. (b) **Save Tab Set** POSTs the open tabs' titles and URLs to `pinboard.in/tabs/save/` using your existing pinboard.in **login session cookie** (not the API token), then opens `pinboard.in/tabs/show/` for you to confirm.

3. **AI provider APIs** — the page title, URL, and extracted article text are sent to **the provider you chose** to generate AI tags, summaries, translations, Ask-the-page answers, selection explanations/translations, or batch-save results. Tag/summary requests send roughly the first 8 KB of extracted text; Translate, Ask-the-page, and the opt-in key-points skim can send more content, sampled to a token budget. If you enable AI for Quick Save, Read Later, or Batch Save, the corresponding save action can initiate the configured AI work. If you separately opt in to key-points skim, opening Markdown preview can generate it automatically on a cache miss. **Deep Analysis (AI)** in tag governance sends tag names and necessary use-count statistics to the selected provider, not bookmark page content. Supported providers: OpenAI, Anthropic, Google Gemini, DeepSeek, Qwen, MiniMax, OpenRouter, Groq, Mistral, Cohere, SiliconFlow, Zhipu, Moonshot, a **local Ollama** instance, or a **Custom OpenAI-compatible endpoint**. The first direct use requests only that provider's exact origin; later automatic use proceeds only while that exact grant remains active.

4. **Jina Reader** (`r.jina.ai`, optional) — when you choose the Jina content source, the page URL is sent to Jina to fetch a cleaner reader-mode rendering for AI processing or Markdown export. Disabled by default. A cache hit stays local; a network cache miss requires an exact `https://r.jina.ai` grant.

5. **Wayback Machine** (`web.archive.org`, optional, opt-in) — when you enable Wayback archiving, the URL of a page you save can be submitted automatically to the Internet Archive to create a public snapshot. It is off by default and requires an exact `https://web.archive.org` grant. Background saves only check that grant; if it is absent, the archive is not submitted and the permission-required outcome is logged locally.

6. **Obsidian** (local app, optional) — the **Send to Obsidian** action hands the converted Markdown of the current page to your local Obsidian desktop app via the `obsidian://` protocol or the system clipboard. This stays on your device; nothing is sent over the network.

7. **GitHub Gist** (`api.github.com`, optional — inactive until you configure it) — the **Send to Gist** action uploads the converted Markdown of the current page (including its metadata frontmatter) as a **secret gist** on your own GitHub account, authenticated with a personal access token you provide. The action requests only the exact `https://api.github.com` origin.

8. **Webhook** (a URL you configure, optional — inactive until you configure it) — the **Send to Webhook** action POSTs a JSON payload to the endpoint you entered (e.g. Readwise), with an Authorization header value you provide. The payload contains the page's title, URL, save date, tags, and converted Markdown; when extended export metadata is enabled (default on), it also includes the page's author, original publish date, site name, cover-image URL, and word count. The action requests only that endpoint's exact origin. An unsafe endpoint is blocked rather than warned-and-sent.

9. **WebDAV** (a server URL you configure, optional — inactive until you configure it) — the **Push now** action (and, if you enable it, an hourly or daily automatic push) uploads your non-secret settings as a JSON file to the WebDAV server you specify, authenticated with the username/password you provide (sent as HTTP Basic auth). If **Include highlights and notes in backups** is enabled, the WebDAV backup also includes page URLs, page titles, selected highlight text, note text, highlight colors, and timestamps. The payload never includes API keys, Pinboard tokens, WebDAV passwords, or export-target tokens. **Pull now** downloads that file and, only after you explicitly confirm an overwrite dialog showing when it was last pushed, applies it to your local settings. Direct actions request only that server's exact origin. Scheduled pushes never open a permission prompt; they record a local permission-required result and send nothing when the exact grant is absent. An unsafe server URL is blocked rather than warned-and-sent.

10. **Selected Batch Save sites** (local extraction access, not a data destination) — when AI is enabled for Batch Save, Chrome asks for the exact origins of the selected HTTP/S tabs so the extension can extract their page text locally, together with the exact current AI-provider origin. The confirmation view lists every requested origin. The extension does not request the all-sites wildcard at runtime; extracted content is sent only to the selected AI provider as described above.

For configured AI, Webhook, and WebDAV destinations, HTTPS is required. Plain HTTP is accepted only for the literal loopback hosts `localhost`, `127.0.0.1`, and `[::1]` (with an optional port). Public or LAN HTTP hosts, alternate loopback spellings, wildcard hosts, and URLs containing embedded credentials are blocked before any request. The configuration is retained so you can correct it; permission denial or revocation likewise preserves keys and settings.

All page content and URLs are transmitted **only to the corresponding configured destination described above**, and **never to the developer**.

## Permissions

| Permission | Purpose |
|------------|---------|
| `activeTab` | Read the current page's title, URL, and selected text for bookmarking and content extraction |
| `storage` | Store settings, obfuscated keys, and caches locally (synced only if you enable it) |
| `scripting` | Inject the Defuddle extractor (and optional per-site rules) into the active tab to pull clean article text — only on explicit action: AI tags/summary, Markdown preview / Translate / Ask / Explain, or batch-save with AI |
| `tabs` | Read tab URLs/titles for bookmark-status detection, batch save, and Save Tab Set |
| `notifications` | Show save confirmations and a 30-second Undo button |
| `alarms` | Keep the service worker warm, refresh caches, and (optionally) prewarm the Pinboard tag list |
| `host_permissions` | Required access only to `api.pinboard.in` and `pinboard.in` for core bookmark API and website features |
| `optional_host_permissions: *://*/*` (declaration ceiling) | Allows Chrome to offer exact runtime grants for arbitrary user-selected origins. The extension requests only the current AI/Jina/Wayback/Gist/Webhook/WebDAV origin, or the selected Batch tab origins; it never requests this wildcard itself |

Optional grants are requested from a direct user action and remain under Chrome's permission controls. Automatic paths use `permissions.contains` only and never prompt. On upgrade from a legacy version that may have retained an all-sites grant, the extension performs a one-time removal of that wildcard grant. This can also clear matching old exact grants, but configurations are preserved and the next direct use can restore only the exact origin needed.

## Third-Party Services

The extension communicates only with the following services for the corresponding configured feature:
- **Pinboard** — core bookmark API calls use your API token; Save Tab Set uses your existing Pinboard login cookie
- **AI providers** — the selected provider receives the inputs described above; tag governance sends tag names and necessary use-count statistics, and opt-in skim can run when Markdown preview opens
- **Jina Reader** — receives the page URL only when selected and a cached result is unavailable or refresh is requested
- **Wayback Machine** — receives saved page URLs automatically only while archiving is enabled and its exact grant remains active
- **Obsidian** — your local desktop app receives Markdown only through an explicit Send to Obsidian action via the local protocol or clipboard
- **GitHub** — receives Markdown only through an explicit Send to Gist action, authenticated with your own access token
- **Your webhook endpoint** — receives the documented JSON payload only through an explicit Send to Webhook action
- **Your WebDAV server** — receives non-secret settings and optional highlights/notes through direct or enabled scheduled pushes; pulls are applied only after your confirmation

Optional-service permission denial or revocation sends nothing to that destination and does not erase its configuration. Selected Batch sites are accessed only to extract the content requested for that batch; they do not receive data from the extension.

No data is shared with any other third party, and none is sent to the developer.

## Changes

If this privacy policy changes, the update will be included in the extension release notes and the **Last updated** date above will be revised.

## Contact

For questions about this privacy policy, open an issue at: <https://github.com/pine2D/Pinboard-Bookmark-Enhanced/issues>
