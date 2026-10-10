# CWS privacy-tab copy (paste-ready)

> Canonical archive of the Chrome Web Store developer-dashboard privacy tab.
> Update this file whenever the dashboard text changes, and re-check it against
> docs/privacy.md whenever a release adds a data exit or permission.
> Last synced: 2026-08-29 (provider count lowered to 13 after the GitHub Models
> service retirement and provider removal in v2.107.6; everything else
> unchanged and still aligned with docs/privacy.md).

## Single purpose description (994/1000)

Save, enrich, read, and export Pinboard bookmarks. The extension captures the page you choose, optionally extracts readable article content, generates AI tags, summaries, translations, or Ask-the-page answers with the provider you select, then saves or exports the result to destinations you configure.

Workflow: toolbar or shortcut -> review the current page -> optional AI, reader, or export -> save to Pinboard.

Related features: AI tags/summaries, translation, Ask/Explain, key-points skim; Batch Save, offline queue, optional Wayback archiving; word lookup and vocabulary with optional Google Drive sync; YouTube/bilibili subtitles in the reader; Send to Obsidian, Notion, NotebookLM, GitHub Gist, or a webhook; JSON backups; tag autocomplete and cleanup; pinboard.in themes.

Data: local-first. No developer servers, no analytics, no telemetry, no sale of data. Page URLs and content go only to Pinboard or to a service you configured, for an action you take or a feature you turned on.

## activeTab justification (unchanged, accurate)

Read the active tab's URL and title to pre-fill the bookmark form when you open the popup, and to scope content extraction to the tab you are acting on.

## storage justification (tail sentence replaced)

Persist settings, credentials, and local caches needed for the bookmark workflow: Pinboard token, AI provider keys, export-target tokens, preferences, custom CSS/themes, bookmark-status cache, tag cache/tag-cleanup state, AI result cache, offline queue, unsaved popup drafts, reader handoff data, highlights/notes and their Google Drive sync state, and the Wayback log. Stored in chrome.storage.local by default; selected non-content settings sync via chrome.storage.sync only if you enable settings sync, and obfuscated credentials join only with the separate account-wide credential-sync option. Nothing is sent to any developer server.

## scripting justification (965/1000)

Inject the bundled Defuddle extractor (and optional per-site extraction rules) into the page to pull clean article text/HTML. This runs only on explicit user action: clicking AI tags or AI summary, quick-saving or batch-saving with AI enabled, or opening the reader (button or Alt+Shift+M, including the engine toggle, Translate, Ask, and Explain inside it). It never runs on popup open or passively. Batch Save with AI first asks you to approve the exact origins of the selected tabs, listed in the prompt, so those non-active tabs can be read; the extension never requests an all-sites grant at runtime. Three more uses each sit behind an exact-origin grant you approve: reading YouTube subtitles through an open www.youtube.com tab of the same video; a small script in player.bilibili.com frames so the transcript follows playback; and, when an article lives inside one large embedded frame, rerunning the extractor in that frame after you click Grant and retry.

## tabs justification (unchanged, accurate)

Enumerate open tabs for batch save, and read tab titles/URLs for "save tab set" (which POSTs them to pinboard.in/tabs/save/ using your existing pinboard.in login cookie, then opens tabs/show for you to confirm). Also read the active tab's URL/title on tab switch or navigation to update the toolbar icon (bookmarked state) and pre-fill the popup.

## notifications justification (unchanged, accurate)

Show success/failure/queued feedback after save operations (quick-save, read-later, batch, tab-set, offline retry) and provide a 30-second Undo button that deletes the just-saved bookmark via the Pinboard API.

## alarms justification (418/1000)

Run recurring background tasks: keep the service worker warm during active use, re-prime the settings cache, expire the bookmark-status cache, retry the offline save queue, refresh the unread badge, optionally prewarm the Pinboard tag list, and schedule Google Drive sync after it is connected. Alarms themselves send nothing; tasks that contact Pinboard or Google Drive do so only while their configuration allows it.

## Host permission justification (899/1000)

Static hosts: api.pinboard.in and pinboard.in, for saving/fetching/managing bookmarks, pinboard.in themes and tag sorting, and cookie-based Save Tab Set. Every other host is optional and requested at runtime as one exact origin, from a direct user action: your AI provider (13 cloud providers, a custom OpenAI-compatible endpoint, or Ollama), Jina Reader, web.archive.org for opt-in archiving, GitHub Gist, Notion, or webhook export, the tabs in a Batch Save, Free Dictionary, Eudic, AnkiConnect on 127.0.0.1, Google Drive, YouTube and bilibili subtitles, an embedded article frame, and image origins for Embed (offline) downloads or hotlink-blocked images. HTTP is allowed only for localhost, 127.0.0.1, and [::1]. The https://*/* ceiling only lets Chrome offer these exact-origin prompts; the extension never requests it. Page content goes only to the service you selected, never to the developer.

## declarativeNetRequestWithHostAccess justification (481/1000; field will appear on next submit)

Set the Referer header (to the article page's origin only) on the extension's own image re-fetches during two user actions in Markdown preview: the Fix button for hotlink-blocked images, and the Embed (offline) export retry. Implemented as a temporary session rule scoped to the granted image origins, the fetch request type, and that single preview tab; the rule is removed when the run finishes. It grants no page access by itself and never touches other tabs' or sites' traffic.

## identity justification (937/1000)

Obtain an OAuth access token for optional Google Drive sync, and nothing else. This is an optional permission: nothing requests it until you click Connect Google Drive in settings, and every other feature works without it. The only scope is drive.appdata, which reaches the extension's own hidden application-data folder and cannot read, list, or modify any other file in your Drive. It stores the current Pinboard account's vocabulary batches, plus highlights and notes if you turn those on, so your devices converge on the same data, and makes one Drive about.get call so settings can show which account is connected. identity never signs you in to this extension, never identifies you to the developer, and is not used for analytics or advertising. Background syncs only check that the permission is granted and never open an OAuth prompt. Disconnect this device removes the cached token and this permission and keeps your local data.

## Remote code

No, I am not using remote code.

## Data usage checkboxes (matches docs/privacy.md "Chrome Web Store data categories")

Checked: Personally identifiable information / Authentication information / Web history / Website content.
Unchecked: Health / Financial and payment / Personal communications / Location / User activity.
All three certification boxes: checked.

## Privacy policy URL

https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html
