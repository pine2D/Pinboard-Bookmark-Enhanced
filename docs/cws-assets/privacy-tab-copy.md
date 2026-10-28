# CWS privacy-tab copy (paste-ready)

> Local copy for the Chrome Web Store developer-dashboard privacy tab.
> Re-check it against docs/privacy.md whenever a release adds a data exit or permission.
> Updating this file does not change the live dashboard.
> Last synced: 2026-08-29 (provider count lowered to 13 after the GitHub Models
> service retirement and provider removal in v2.107.6).
> Pending review and paste (2026-10-28): Bookmark Enhanced now supports Pinboard,
> Karakeep and linkding as primary bookmark services, with one shared personal library.
> The copy below includes the new bookmark destinations and all four Drive datasets.
> Review and paste the changed fields at the next submission, then update Last synced.
> The existing extension ID and privacy-policy URL remain unchanged.
> Pending review and paste (2026-10-29): built-in provider count raised to 17 (Ollama
> included) with the Bailian rename to Alibaba Cloud Model Studio, Volcengine Ark /
> BytePlus ModelArk, OpenCode Zen and Command Code; custom AI endpoints are now a list
> of OpenAI- or Anthropic-compatible entries. No field below names providers or counts
> them, so this changes nothing to paste beyond the bookmark-service fields above.

## Single purpose description (909/1000)

Save, enrich, read, and export bookmarked pages. Choose Pinboard, Karakeep or linkding for bookmarks; the latter two need no Pinboard account. Open the popup or use a shortcut to review the current page, optionally use AI or the reader, then save to the selected service.

Related features include AI tags and summaries, translation and questions about the page, batch saves, an offline queue, optional archiving, video subtitles, and export to configured destinations. Vocabulary, highlights, notes, AI dictionary entries and saved conversations share one personal library, with optional Google Drive sync. Pinboard-specific features include tag cleanup, Tab Sets and site themes.

Data is local-first. No developer servers, analytics, telemetry or sale of data. Page URLs and content go only to the selected bookmark service or another configured destination for an action you take or a feature you turn on.

## activeTab justification (unchanged, accurate)

Read the active tab's URL and title to pre-fill the bookmark form when you open the popup, and to scope content extraction to the tab you are acting on.

## storage justification (752/1000)

Persist settings, credentials and state for saving and reading: bookmark-service tokens, AI and export credentials, preferences, themes, bookmark and tag caches, tag-cleanup state, AI results, pending saves, popup drafts, reader handoffs, highlights and notes, and the archive log. Reading data and its sync state also use IndexedDB. Vocabulary, highlights, notes, AI dictionary archives and Ask history share one personal library across bookmark services. Chrome storage is local by default. Ordinary settings use chrome.storage.sync only if settings sync is enabled on this device; obfuscated credentials join only with the separate credential-sync option. Page content and pending saves never enter Chrome Sync. Nothing is sent to developer servers.

## scripting justification (965/1000)

Inject the bundled Defuddle extractor (and optional per-site extraction rules) into the page to pull clean article text/HTML. This runs only on explicit user action: clicking AI tags or AI summary, quick-saving or batch-saving with AI enabled, or opening the reader (button or Alt+Shift+M, including the engine toggle, Translate, Ask, and Explain inside it). It never runs on popup open or passively. Batch Save with AI first asks you to approve the exact origins of the selected tabs, listed in the prompt, so those non-active tabs can be read; the extension never requests an all-sites grant at runtime. Three more uses each sit behind an exact-origin grant you approve: reading YouTube subtitles through an open www.youtube.com tab of the same video; a small script in player.bilibili.com frames so the transcript follows playback; and, when an article lives inside one large embedded frame, rerunning the extractor in that frame after you click Grant and retry.

## tabs justification (unchanged, accurate)

Enumerate open tabs for batch save, and read tab titles/URLs for "save tab set" (which POSTs them to pinboard.in/tabs/save/ using your existing pinboard.in login cookie, then opens tabs/show for you to confirm). Also read the active tab's URL/title on tab switch or navigation to update the toolbar icon (bookmarked state) and pre-fill the popup.

## notifications justification (259/1000)

Show success, failure or queued feedback after quick saves, Read Later, Batch Save, Pinboard Tab Sets and offline retries. A 30-second Undo action deletes a just-saved bookmark through its original bookmark service only while that connection is still current.

## alarms justification (356/1000)

Schedule background work: re-prime settings, expire bookmark-status caches, retry pending saves, refresh the Pinboard unread badge, optionally prewarm tags, and run Google Drive sync after connection. Alarms themselves send nothing. Tasks contact the selected bookmark service or Google Drive only while the required connection and permission remain valid.

## Host permission justification (894/1000)

Static hosts api.pinboard.in and pinboard.in support Pinboard bookmarks, site themes, tag sorting and cookie-based Tab Sets. Other hosts are optional, requested from a direct user action for one exact origin: the configured Karakeep or linkding server, AI providers, Jina Reader, Wayback archiving, export destinations, selected Batch Save tabs, dictionaries and language evidence, Eudic, AnkiConnect, Google Drive, video subtitles and playback, embedded article frames, or image downloads and hotlink fixes. Karakeep and linkding work without a Pinboard account. Custom endpoints require HTTPS; HTTP is allowed only for localhost, 127.0.0.1 and [::1]. The https://*/* ceiling lets Chrome offer these exact-origin prompts; the extension never requests the wildcard. Automatic paths only check existing grants. URLs and content go to the selected service for its feature, never to the developer.

## declarativeNetRequestWithHostAccess justification (481/1000; field will appear on next submit)

Set the Referer header (to the article page's origin only) on the extension's own image re-fetches during two user actions in Markdown preview: the Fix button for hotlink-blocked images, and the Embed (offline) export retry. Implemented as a temporary session rule scoped to the granted image origins, the fetch request type, and that single preview tab; the rule is removed when the run finishes. It grants no page access by itself and never touches other tabs' or sites' traffic.

## identity justification (840/1000)

Obtain OAuth access tokens only for optional Google Drive sync. This permission is requested when you click Connect Google Drive; other features work without it. The sole scope, drive.appdata, reaches the extension's hidden app-data folder and cannot read, list or modify other Drive files. It syncs one personal library across bookmark services: vocabulary, highlights and notes, complete AI dictionary entries with supplements, and saved Ask conversations with cited excerpts. A Drive about.get call shows the connected account in settings. identity does not sign you in to this extension or identify you to the developer, and is not used for analytics or advertising. Background sync only checks the existing permission and never opens an OAuth prompt. Disconnect this device removes the cached token and permission and keeps local data.

## Remote code

No, I am not using remote code.

## Data usage checkboxes (matches docs/privacy.md "Chrome Web Store data categories")

Checked: Personally identifiable information / Authentication information / Web history / Website content.
Unchecked: Health / Financial and payment / Personal communications / Location / User activity.
All three certification boxes: checked.

## Privacy policy URL

https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html
