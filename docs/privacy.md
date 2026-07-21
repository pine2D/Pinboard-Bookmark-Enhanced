---
layout: default
title: Privacy Policy
---

# Privacy Policy: Pinboard Bookmark Enhanced

**Last updated:** 2026-07-16

## Summary

Pinboard Bookmark Enhanced is local-first and bring-your-own-key. It has no developer servers, no analytics, no tracking, and no telemetry; the developer never receives your data. The extension uses Pinboard for its core bookmark features and contacts other services only as described below. Bookmark-status checks and offline-save retries can run automatically; separately enabled features such as Wayback archiving, key-points skim, and scheduled WebDAV backup can also make automatic requests.

## Data storage

Extension settings, caches, and temporary state are stored locally by default. Bookmarking and the configured features described under **Network requests** can transmit the specific data needed for those features. You can optionally enable **settings sync** (off by default); ordinary settings (not saved bookmarks or page content) are then synced across your devices through Chrome's built-in account sync.

| Data | Default storage | Synced via Google Account |
|------|-----------------|--------------------------|
| Settings & preferences | `chrome.storage.local` | Only if you enable settings sync |
| Credentials and configured Webhook URLs (obfuscated) | `chrome.storage.local` | Only if you enable both settings sync and the separate API-key sync option |
| Custom CSS & themes | `chrome.storage.local` | Only if you enable settings sync; large synced values are chunked |
| AI result cache (account-scoped keys include the non-secret plaintext Pinboard username owner) | IndexedDB | No |
| Tag cache & tag-cleanup state (account-scoped records include the non-secret plaintext Pinboard username owner) | `chrome.storage.local` | No |
| Bookmark-status cache (account-scoped in memory) | Service Worker memory | No |
| Offline save queue (URL, title, notes, tags, save options, time, and a non-secret plaintext Pinboard username binding) | `chrome.storage.local` | No |
| Batch progress & Markdown preview data (account-scoped records include the non-secret plaintext Pinboard username owner) | `chrome.storage.local` | No |
| Reader highlights & notes | `chrome.storage.local` | No |
| Wayback archive log | `chrome.storage.local` | No |

Settings sync is implemented with Chrome's `chrome.storage.sync`. Whether ordinary settings sync is enabled remains a per-device choice. The separate API-key-sync preference is an account-wide marker, but credentials are read from or written to Chrome Sync only on devices where ordinary settings sync is also enabled. New users start with credential sync off. During upgrade, if the account-wide marker is missing but Chrome Sync already contains a non-empty credential/export-target token, or the old device-local credential-sync preference was on, the marker is initialized on to preserve that existing opt-in and avoid credential loss; otherwise it is initialized off. API keys, tokens, passwords, configured Webhook URLs, and other export-target credentials stay local unless both settings sync and this account-wide credential option are enabled. These values are obfuscated at rest (not cryptographically encrypted). The WebDAV server address and username are ordinary settings, stored and synced like other preferences; only the WebDAV password is treated as a credential. Public service requests use HTTPS; configured AI, Webhook, and WebDAV endpoints may use plain HTTP only for the literal loopback hosts listed under **Network requests**. The extension has no developer server; automatic requests are limited to the core and enabled behaviors documented below.

While credential sync is enabled, each participating device also retains its last observed cloud credential snapshot locally. If another device turns credential sync off and removes the cloud copy, that local snapshot remains available. A device that was offline during a credential change can retain only the older snapshot it last received.

New offline-queue records never store a Pinboard API token. They store the bookmark fields listed above plus the Pinboard username parsed from the token as a non-secret account binding. Legacy queued records are rewritten to that format and their stored token field is removed. Retry always requires the currently configured token for the same username; logout or an account switch leaves the item queued and sends no request with an old credential.

To prevent one Pinboard account from seeing another account's local state, account-derived records and caches carry the Pinboard username parsed from the token as a non-secret plaintext owner. This applies to the offline queue, tag caches and recent-tag state, Batch progress, tag-cleanup state, Markdown-preview handoffs, and other account-specific local state. Account-scoped AI cache keys (tags, summaries, translations, extracted translation glossaries, and remembered translation views) include that username owner in the IndexedDB key. These owner bindings do not contain the API token and do not create an additional network request.

Manual settings backups are JSON files you explicitly export. If **Include highlights and notes in backups** is enabled, manual backups also include reader highlight data: page URLs, page titles, selected highlight text, note text, highlight colors, and timestamps. API keys, Pinboard tokens, WebDAV passwords, Webhook URLs, and export-target tokens are not included.

## Chrome Web Store data categories

The Chrome Web Store privacy form uses standardized data categories. To keep the store listing consistent with this policy, this extension discloses that it handles the following categories:

| Category | Why it applies |
|----------|----------------|
| Personally identifiable information | Your Pinboard API token includes your Pinboard username; account-scoped local state and cache keys store that username owner in plaintext locally (without the token), including offline, tag, AI, Batch, tag-cleanup, and preview state; and optional backup/export settings may include usernames you enter, such as a WebDAV username |
| Authentication information | The extension stores and uses credentials you provide, such as your Pinboard API token, AI/Jina provider keys, Wayback S3 credentials, GitHub token, webhook authorization value or capability URL, and WebDAV password |
| Web history | The extension reads page URLs and titles for bookmark status, popup prefill, batch save, Save Tab Set, offline queue, and bookmark/export metadata |
| Website content | The extension can extract page text, selected text, links, metadata, highlights, and notes for AI tags/summaries, Markdown preview, Translate, Ask-the-page, Explain-selection, exports, and optional backups |

The extension does **not** collect health information, financial/payment information, location, personal communications as a separate category, or user activity for analytics/tracking. It has no developer-operated analytics, telemetry, advertising, or profiling.

## Network requests

The extension uses the required Pinboard hosts for its core bookmark features. Configured AI, Jina, Wayback, Gist, Webhook, and WebDAV destinations, together with selected Batch source origins, require an optional grant for the **exact current origin**. Permission prompts are initiated only from a direct user action; automatic and background feature paths only check an existing grant and skip or fail safely when it is absent. Remote images retained in Markdown preview are normal browser subresource requests and do not use an extension host-permission grant; they are disclosed separately below.

1. **Pinboard API** (`api.pinboard.in`): to save, retrieve, and manage your bookmarks, authenticated with your Pinboard API token. The **tag-cleanup tool**, when you run it, downloads your full bookmark/tag list (`posts/all`, `tags/get`) and re-saves affected bookmarks to rename or merge tags, all to and from your own Pinboard account. The extension also checks whether the current page is already bookmarked as you navigate, sending the active tab's URL to the Pinboard API to set the toolbar icon state.

2. **Pinboard website** (`pinboard.in`): (a) a content script applies your chosen theme CSS and tag-sort tweaks on pinboard.in pages; no data is extracted or transmitted. (b) **Save Tab Set** POSTs the open tabs' titles and URLs to `pinboard.in/tabs/save/` using your existing pinboard.in **login session cookie** (not the API token), then opens `pinboard.in/tabs/show/` for you to confirm.

3. **AI provider APIs**: the page title, URL, and extracted article text are sent to **the provider you chose** to generate AI tags, summaries, translations, Ask-the-page answers, selection explanations/translations, or batch-save results. Tag/summary requests send roughly the first 8 KB of extracted text. AI-tag requests can also include up to 50 existing Pinboard tag names so the provider can prefer reuse. If you put `{{description}}` in a custom tag or summary prompt, the current bookmark description or notes are included. Full-text Translate sends the translatable article across multiple batches; it is not reduced to one sampled context window. Translate does not create a summary, but when a summary for the same Pinboard account is already cached locally, that summary is included as context in each translation batch. Ask-the-page and the opt-in key-points skim select article context within their token budgets. If you enable AI for Quick Save, Read Later, or Batch Save, the corresponding save action can initiate the configured AI work. If you separately opt in to key-points skim, opening Markdown preview can generate it automatically on a cache miss. **Deep Analysis (AI)** in tag governance sends tag names (and, when truncated, the number of omitted lower-frequency tags), not bookmark page content or per-tag use counts. Supported providers: OpenAI, Anthropic, Google Gemini, DeepSeek, Qwen, MiniMax, OpenRouter, Groq, Mistral, Cohere, SiliconFlow, Zhipu, Moonshot, a **local Ollama** instance, or a **Custom OpenAI-compatible endpoint**. The first direct use requests only that provider's exact origin; later automatic use proceeds only while that exact grant remains active.

4. **Jina Reader** (`r.jina.ai`, optional): when you choose the Jina content source, the page URL is sent to Jina to fetch a cleaner reader-mode rendering for AI processing or Markdown export. If you configured a Jina API key, it is sent on a cache miss or refresh as a Bearer authorization value. Disabled by default. A cache hit stays local; a network cache miss requires an exact `https://r.jina.ai` grant.

5. **Wayback Machine** (`web.archive.org`, optional, opt-in): when you enable Wayback archiving, the URL of a page you save can be submitted automatically to the Internet Archive to create a public snapshot. If you configured Wayback S3 access credentials, the access key and secret are sent in the request's authorization header. It is off by default and requires an exact `https://web.archive.org` grant. Background saves only check that grant; if it is absent, the archive is not submitted and the permission-required outcome is logged locally.

6. **Obsidian** (local app, optional): the **Send to Obsidian** action hands the converted Markdown of the current page to your local Obsidian desktop app via the `obsidian://` protocol or the system clipboard. This stays on your device; nothing is sent over the network.

7. **GitHub Gist** (`api.github.com`, optional; inactive until you configure it): the **Send to Gist** action uploads the converted Markdown of the current page (including its metadata frontmatter) as a **secret gist** on your own GitHub account, authenticated with a personal access token you provide. The action requests only the exact `https://api.github.com` origin.

8. **Webhook** (a URL you configure, optional; inactive until you configure it): the **Send to Webhook** action POSTs a JSON payload to the endpoint you entered (e.g. Readwise), with an Authorization header value you provide. The payload contains the page's title, URL, save date, tags, and converted Markdown; when extended export metadata is enabled (default on), it also includes the page's author, original publish date, site name, cover-image URL, and word count. The action requests only that endpoint's exact origin. An unsafe endpoint is blocked rather than warned-and-sent.

9. **WebDAV** (a server URL you configure, optional; inactive until you configure it): the **Push now** action (and, if you enable it, an hourly or daily automatic push) uploads your non-secret settings as a JSON file to the WebDAV server you specify, authenticated with the username/password you provide (sent as HTTP Basic auth). If **Include highlights and notes in backups** is enabled, the WebDAV backup also includes page URLs, page titles, selected highlight text, note text, highlight colors, and timestamps. The payload never includes API keys, Pinboard tokens, WebDAV passwords, Webhook URLs, or export-target tokens. **Pull now** downloads that file and, only after you explicitly confirm an overwrite dialog showing when it was last pushed, applies it to your local settings. Direct actions request only that server's exact origin. Scheduled pushes never open a permission prompt; they record a local permission-required result and send nothing when the exact grant is absent. An unsafe server URL is blocked rather than warned-and-sent.

10. **Selected Batch Save sites** (local extraction access, not a data destination): when AI is enabled for Batch Save, Chrome asks for the exact origins of the selected HTTP/S tabs so the extension can extract their page text locally, together with the exact current AI-provider origin. The confirmation view lists every requested origin. The extension does not request the all-sites wildcard at runtime; extracted content is sent only to the selected AI provider as described above.

11. **Remote image hosts in Markdown preview**: sanitized Markdown can retain remote image URLs. When the preview renders those images, the browser requests them directly from the original site or image/CDN host without a separate extension host-permission prompt. Every retained image is forced to `referrerpolicy="no-referrer"`, so the referring article/preview URL is not sent in the `Referer` header. The image host still receives the requested image URL and ordinary connection/request metadata such as the user's IP address and browser headers; cookies are included only when permitted by Chrome's cookie and third-party-cookie policies.

12. **Embed (offline) image export in Markdown preview** (image hosts referenced by the exported document, optional): this is a separate mechanism from the ordinary `<img>` rendering described above. Choosing the **Embed (offline)** image policy for a Markdown/HTML/EPUB download makes the extension page itself fetch each remote image directly from its own host (`credentials: "omit"`) and convert it to a data URI (or, for EPUB, bundle it as a file inside the book) so the downloaded file renders offline. This only runs when you click Download with that policy selected, and requires a one-time optional host-permission grant for the exact image origins found in the document; declining leaves those images as ordinary remote links in the export instead of embedding them. Images that fail this plain fetch (typically hosts that reject requests without a `Referer` header) are retried once behind the temporary Referer rule described in item 13, within the same download-size budget. No image data passes through any intermediary.

13. **Fix images blocked by hotlink protection in Markdown preview** (image hosts, optional): some sites reject any image request that carries no `Referer` header, and an extension page can only send referrerless requests, so those images fail to load in the preview. When that happens, the preview shows a count and a **Fix** button. Clicking it asks for a one-time optional host-permission grant for the exact failed image origins, then re-fetches only those images (`credentials: "omit"`) while a temporary declarativeNetRequest **session** rule (scoped to those image domains, to the `fetch` request type, and to that one preview tab) sets the `Referer` header to the article page's **origin** (never the full article URL or its query). The rule is removed as soon as the fetch run finishes, and fixed images are displayed as inline data URIs for that page view only; nothing is written to storage. For image origins you have already granted, later previews re-apply this fix automatically; the automatic path only checks the existing grant (`permissions.contains`) and never prompts. Declining the permission leaves the images as broken placeholders.

14. **Free Dictionary API** (`freedictionaryapi.com`, optional): when you use the Dictionary lookup in Markdown preview and grant an exact `https://freedictionaryapi.com` origin, the selected word and its language code are sent to fetch Wiktionary-based definitions. The lookup is never contacted automatically or in the background.

For configured AI, Webhook, and WebDAV destinations, HTTPS is required. Plain HTTP is accepted only for the literal loopback hosts `localhost`, `127.0.0.1`, and `[::1]` (with an optional port). Public or LAN HTTP hosts, alternate loopback spellings, wildcard hosts, and URLs containing embedded credentials are blocked before any request. The configuration is retained so you can correct it; permission denial or revocation likewise preserves keys and settings.

Page content, URLs, credentials, and remote-image requests are transmitted only as described above, and never to the developer.

## Permissions

| Permission | Purpose |
|------------|---------|
| `activeTab` | Read the current page's title, URL, and selected text for bookmarking and content extraction |
| `storage` | Store settings, obfuscated keys, queues, and caches; ordinary settings sync per enabled device, and credentials sync on participating devices only with the separate account-wide API-key sync option |
| `scripting` | Inject the Defuddle extractor (and optional per-site rules) into the active tab to pull clean article text, only on explicit action: AI tags/summary, Markdown preview / Translate / Ask / Explain, or batch-save with AI |
| `tabs` | Read tab URLs/titles for bookmark-status detection, batch save, and Save Tab Set |
| `notifications` | Show save confirmations and a 30-second Undo button |
| `alarms` | Keep the Service Worker warm, retry the offline save queue, refresh the unread badge, prime storage defaults, optionally prewarm Pinboard tags, and run enabled scheduled WebDAV pushes |
| `declarativeNetRequestWithHostAccess` | Set the `Referer` header (to the article page's origin) on the extension's **own** image re-fetches during the preview's Fix-images action and the Embed-export retry. Only effective for image origins you granted, only for requests from that preview tab, via a temporary session rule removed after each run; it grants no page access by itself and never touches other tabs' or sites' traffic |
| `host_permissions` | Required access only to `api.pinboard.in` and `pinboard.in` for core bookmark API and website features |
| `optional_host_permissions: *://*/*` (declaration ceiling) | Allows Chrome to offer exact runtime grants for arbitrary user-selected origins. The extension requests only the current AI/Jina/Wayback/Gist/Webhook/WebDAV origin, the selected Batch tab origins, the exact origins of the images referenced in a Markdown/HTML/EPUB export when you download it with the Embed (offline) image policy, the exact origins of the failed images when you click **Fix** on the preview's blocked-images notice, or the exact `https://freedictionaryapi.com` origin requested the first time you use the Dictionary lookup in Markdown preview (each a one-time prompt, can be declined; declining the Dictionary lookup leaves the reader on AI-only explanations); it never requests this wildcard itself |

Optional grants are requested from a direct user action and remain under Chrome's permission controls. Automatic feature paths that require an optional grant use `permissions.contains` only and never prompt. On upgrade from a legacy version that may have retained an all-sites grant, the extension performs a one-time removal of that wildcard grant. This can also clear matching old exact grants, but configurations are preserved and the next direct use can restore only the exact origin needed.

## Third-party services

The extension communicates with the following services or destinations for the corresponding behavior:
- **Chrome Sync / your Google Account**: receives ordinary settings from devices where settings sync is enabled; participating devices include credentials only when the separate account-wide API-key sync option is also enabled
- **Pinboard**: core bookmark API calls use your API token; Save Tab Set uses your existing Pinboard login cookie
- **AI providers**: the selected provider receives the inputs described above; tag governance sends tag names rather than bookmark content or per-tag use counts, and opt-in skim can run when Markdown preview opens
- **Jina Reader**: receives the page URL and, if configured, your Bearer API key when selected and a cached result is unavailable or refresh is requested
- **Wayback Machine**: receives saved page URLs and, if configured, Wayback S3 credentials automatically only while archiving is enabled and its exact grant remains active
- **Obsidian**: your local desktop app receives Markdown only through an explicit Send to Obsidian action via the local protocol or clipboard
- **GitHub**: receives Markdown only through an explicit Send to Gist action, authenticated with your own access token
- **Your webhook endpoint**: receives the documented JSON payload only through an explicit Send to Webhook action
- **Your WebDAV server**: receives non-secret settings and optional highlights/notes through direct or enabled scheduled pushes; pulls are applied only after your confirmation
- **Remote image hosts**: receive direct browser requests for images retained in Markdown preview, with `no-referrer` enforced as described above; if you use the preview's **Fix** action for hotlink-blocked images (or previously granted those origins), they additionally receive one extension re-fetch per image carrying the article page's origin as `Referer`
- **Embedded export image hosts**: receive a direct extension-page fetch for each image referenced in a Markdown/HTML/EPUB export only when you choose the Embed (offline) image policy and grant the one-time origin permission; images are embedded in the downloaded file (as data URIs, or as bundled files inside the EPUB) with no third-party relay
- **Free Dictionary API (freedictionaryapi.com)**: receives the word you look up and its language code when you use the Dictionary lookup and grant access; returns Wiktionary-based definitions licensed CC BY-SA 4.0

Optional-service permission denial or revocation sends nothing to that destination and does not erase its configuration. Selected Batch sites are accessed only to extract the content requested for that batch; they do not receive data from the extension.

Other than the services, configured destinations, Chrome Sync, and remote image hosts described above, the extension does not intentionally send data to third parties. No data is sent to the developer.

## Changes

If this privacy policy changes, the update will be included in the extension release notes and the **Last updated** date above will be revised.

## Contact

For questions about this privacy policy, open an issue at: <https://github.com/pine2D/Pinboard-Bookmark-Enhanced/issues>
