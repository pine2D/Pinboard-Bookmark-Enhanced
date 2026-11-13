---
layout: default
title: Troubleshooting
---

# Troubleshooting: Bookmark Enhanced

**Last updated:** 2026-11-14

## 1. Exporting non-secret diagnostics first

Before changing settings or reporting a bug, open **Settings > Backup & Diagnostics > Support Diagnostics** and click **Copy diagnostics**. The copied JSON (`schemaVersion: 1`) records extension version, browser locale, enabled feature flags, granted optional permissions, storage byte counts, IndexedDB record counts, offline queue status, and recent connection health without including API keys, tokens, account names, URLs, or page content.

## 2. Bookmark service connection (Pinboard, Karakeep, linkding)

- **Pinboard (`username:HEXTOKEN`)**: Paste the full API token from [pinboard.in/settings/password](https://pinboard.in/settings/password) (including `username:` before the colon) and click **Test Connection**. A synced or imported Pinboard token does not become active on a new device until **Test Connection** or popup login verifies it locally.
- **Karakeep and linkding**: Self-hosted endpoints must use `https://`, except literal loopback addresses (`http://localhost`, `http://127.0.0.1`, `http://[::1]`). Plain HTTP on LAN IPs or public hosts is blocked to protect tokens. Clicking **Connect** prompts Chrome for host permission to that exact origin and runs a read-only check before switching your active service.
- **Selected vs. active service**: Chrome Sync and manual JSON backups carry your selected service, while each device keeps its own active service until the target service has both valid credentials and local host permission on that device.
- **Offline save queue paused or waiting**: Transient network errors and HTTP `429` responses retry automatically (honoring `Retry-After` up to 1 hour). Authentication failures (`401` or `403`), missing host permissions, or mismatched account bindings mark the queued item as needing attention in the popup so you can reconnect and retry manually without losing bookmark metadata.

## 3. AI tags, summaries, translation, Ask, and dictionary entries

- **Host permission missing**: Built-in cloud providers and custom endpoints require optional host permission on each device. Click **Test Connection** in **Settings > AI Service** (or trigger the action from a direct button click) to grant the provider's exact origin.
- **HTTP 401 or 403**: Re-check the API key for the currently selected provider, confirm account quota/billing on the provider dashboard, and verify region selection where applicable (such as Qwen Beijing vs. Singapore/International, or Volcengine Ark).
- **HTTP 404 or model errors**: Provider model IDs retire periodically. Check the model ID field in **Settings > AI Service** or test with the provider's current default model.
- **Local Ollama returns HTTP 403**: Ollama rejects browser extension `chrome-extension://` origins by default. Start Ollama with `OLLAMA_ORIGINS="chrome-extension://*"` in its environment, keep the endpoint on `http://localhost:11434` or `http://127.0.0.1:11434`, and re-test.
- **Custom OpenAI-compatible or Anthropic-compatible endpoints**: Enter the base URL (https, or loopback http) and pick the matching protocol format. Do not embed `user:pass@` credentials in the URL.

## 4. Google Drive personal library sync

- **Per-device connection**: Google Drive sync is off until you click **Connect Google Drive** in **Settings > Sync & Storage** (or the Library page) on each device. Connecting syncs four personal-library stores through Google Drive's hidden `appDataFolder`: vocabulary, article highlights and notes, complete AI dictionary entries with supplements, and saved Ask conversations.
- **OAuth or token errors on unpacked builds**: Chrome's `chrome.identity` Google OAuth client is bound to the Chrome Web Store extension ID. Unpacked checkouts without a matching OAuth client configuration cannot complete `getAuthToken`; install the Chrome Web Store build if you rely on Google Drive sync.
- **What Drive does not sync**: Extension settings, API keys, offline dictionary packs (`pbp-dict-packs`, `pbp-multidict`), AI response caches (`pbp-ai-cache`), and local restore points (`pbp-restore-points`) stay off Google Drive by design.

## 5. YouTube and bilibili subtitles and playback follow

- **First-time authorization**: Open the video in the reader and click **Enable captions & load video** inside the preview banner to grant exact-origin access (`https://www.youtube.com/*` or `https://api.bilibili.com/*` plus `https://player.bilibili.com/*`). Automatic background paths never prompt for permissions.
- **YouTube `LOGIN_REQUIRED` or empty captions**: YouTube frequently blocks cross-origin caption fetches from extension pages. Keep the video open in a regular `https://www.youtube.com` browser tab so the reader can read caption tracks from that same-origin tab context, or check the **Use YouTube login for caption fallback** toggle in Settings.
- **bilibili subtitles missing**: Many bilibili videos serve AI/CC subtitles only to signed-in accounts. Sign in to `bilibili.com` in Chrome and reload the reader; if you authorized bilibili before playback-follow existed, click **Enable playback follow** in the video toolbar to grant `player.bilibili.com`.

## 6. AnkiConnect and Eudic word export

- **AnkiConnect (`127.0.0.1`, default port `8765`)**: Make sure the Anki desktop app is running with add-on `2055492159` installed. Add your `chrome-extension://<extension-id>` origin (or `*` on local setups) to `webCorsOriginList` in the AnkiConnect add-on configuration and restart Anki, then click **Test** in **Settings > Reading & Vocabulary** to grant the exact `http://127.0.0.1:<port>/*` loopback permission and verify deck/note-type fields.
- **Eudic**: Generate a personal API token from Eudic (`my.eudic.net`), select a target wordbook in Settings, and click **Test** to grant host access.

## 7. Unpacked ZIP upgrades and data recovery

- **Upgrading an unpacked install safely**: Unzip the new release over the **same folder path** you originally loaded in `chrome://extensions/`, then click the reload icon on the extension card. Removing the extension or loading a new folder path assigns a new extension ID and isolates your previous IndexedDB and `chrome.storage.local` data.
- **Restoring personal library data**: Bookmark Enhanced automatically records a local restore point (`pbp-restore-points`, up to 5 per personal library) before backup imports, before batch/article deletions in the Library, and on the first startup after an extension version update. Open **Settings > Backup & Diagnostics** to inspect or restore a local restore point, or import a manual JSON backup file.

## Related documents

- [Data Formats and Storage Reference](./data-format.html)
- [Privacy Policy](./privacy.html)
- [Report an issue on GitHub](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/issues)
