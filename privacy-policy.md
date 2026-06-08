# Privacy Policy — Pinboard Bookmark Enhanced

**Last updated:** 2026-06-08

## Data Collection

Pinboard Bookmark Enhanced does **not** collect, transmit, or store any personal data on external servers. The extension has no analytics, no tracking, and no telemetry.

## Data Storage

By **default**, all data is stored **locally** on your device (`chrome.storage.local`) and never leaves it. You can optionally enable **settings sync** (off by default); when enabled, only your settings — not your saved bookmarks or page content — are synced across your devices through Chrome's built-in account sync.

| Data | Default storage | Synced via Google Account |
|------|-----------------|--------------------------|
| Settings & preferences | `chrome.storage.local` | Only if you enable settings sync |
| API keys (obfuscated) | `chrome.storage.local` | Only if you enable settings sync |
| Custom CSS & themes | `chrome.storage.local` (chunked) | Only if you enable settings sync |
| AI result cache | `chrome.storage.local` | No |
| Tag cache | `chrome.storage.local` | No |

Settings sync is implemented with Chrome's `chrome.storage.sync`. The extension itself has no server and uploads nothing on its own.

## Network Requests

The extension only makes network requests to services **you explicitly configure**:

1. **Pinboard API** (`api.pinboard.in`) — to save, retrieve, and manage your bookmarks. Authenticated with your Pinboard API token.

2. **AI Provider APIs** (only when you click "AI tags" or "AI summary") — page title, URL, and a portion of page text are sent to your chosen AI provider to generate tags or summaries. Supported providers include OpenAI, Anthropic, Google Gemini, DeepSeek, Groq, Mistral, Cohere, SiliconFlow, Qwen, MiniMax, OpenRouter, Ollama, or a custom endpoint. **No data is sent to any AI provider unless you explicitly trigger it.**

3. **Pinboard website** (`pinboard.in`) — the content script injects custom CSS styles onto pinboard.in pages. No data is extracted or transmitted.

4. **Jina Reader** (`r.jina.ai`, optional) — when you choose the Jina content source, the page URL is sent to Jina to fetch a cleaner reader-mode rendering for AI processing or Markdown export. Disabled by default.

## Permissions

| Permission | Purpose |
|------------|---------|
| `activeTab` | Read current page info (title, URL, selected text) for bookmarking and Markdown extraction |
| `storage` | Store settings and caches locally |
| `scripting` | Inject the Defuddle library into the active tab to extract clean article text, for AI features and the Markdown preview/export |
| `tabs` | Access tab URLs for bookmark status and batch save |
| `notifications` | Show save confirmations for quick save / read later |
| `alarms` | Periodic cache cleanup and offline queue processing |
| `host_permissions` | API calls to Pinboard and configured AI providers |
| `optional_host_permissions: *://*/*` | Required by batch save to extract page text from arbitrary user-opened tabs; user grants per-session via Chrome's Just-in-Time prompt |

## Third-Party Services

The extension communicates with third-party services **only at your direction**:
- **Pinboard** — your bookmark service, using your API token
- **AI providers** — only the provider you select and configure with your own API key

No data is shared with any other third party.

## Changes

If this privacy policy changes, the update will be included in the extension release notes.

## Contact

For questions about this privacy policy, open an issue at: https://github.com/pine2D/Pinboard-Bookmark-Enhanced/issues
