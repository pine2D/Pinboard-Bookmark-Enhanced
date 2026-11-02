# Bookmark Enhanced

**English** | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

A Chrome extension for [Pinboard](https://pinboard.in), Karakeep and linkding: AI tags and summaries, a reader with translation and highlights, and 13 themes for pinboard.in.

> **Note:** Choose one bookmark service in Settings. Karakeep and linkding work without a Pinboard account. Pinboard is an independent **paid** service and requires your own account and API token. This third-party extension is not affiliated with, sponsored by, or endorsed by Pinboard.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Saving a page with AI tags and summary, in dark and light themes](docs/screenshots/readme/hero.webp)

[![30-second video tour: save it, read it, keep it](docs/screenshots/readme/promo-video.webp)](https://youtu.be/DMQS8LC09kU)

---

## Features

### Save
- **One click, everything filled in**: title, description, and selected text, with tracking parameters stripped from the URL
- **Hotkeys and Batch Save**: save without opening the popup, or bookmark every tab in the window at once
- **Works offline**: saves are queued locally and retried when you're back online
- **Drafts survive**: close the popup mid-edit and pick up where you left off

### Tag
- **AI tags & summary**: reads the article body without the ads, menus, and sidebars; bring your own key (17 providers, or any OpenAI- or Anthropic-compatible endpoint)
- **Autocomplete** from your own tags, Pinboard's suggestions, and one-tap presets
- **Tag cleanup**: merge near-duplicate tags and prune rarely used ones

### Read
- **Any page becomes a clean reader**: a Markdown view with table of contents, search, and footnote peek; math, diagrams, and tables render properly
- **GitHub Discussions (pilot)**: keeps the loaded main post, comments, reply structure, and which reply was accepted; shows how much was loaded
- **Manage bookmarks as you read**: save, edit, or delete the article’s bookmark without returning to the popup
- **Five-color highlights with notes**: they stay in place through translation and even later edits to the page
- **Translate the page or ask it questions**: full-page translation with a bilingual view; answers cite the source and jump straight to it
- **Keep questions and answers with their citations**: completed answers save automatically and sync through Google Drive. Browse conversations in the library, continue in the reader, or export them alone or with the article. Temporary conversations stay unsaved.
- **Look up words as you read**: see dictionary definitions and pronunciation; send saved words to Anki or Eudic in one click, or add offline Chinese-English and English-Chinese dictionaries. Choose the language for AI entry definitions independently of the interface, and filter saved words by language. Resize the lookup window by dragging its edges, or move it into the side panel while keeping the current results, selected definition, and generation progress. See a word in real sentences from texts on Wikisource, with author and source, without using AI.
- **Multilingual offline dictionaries**: look up words on this device with definitions and readings from Yomitan v3 ZIP files you import; dictionary packs are excluded from Drive sync and JSON backups. All offline dictionaries, including Chinese–English and English–Chinese, can be disabled without removing their data. Recognized structure keeps individual definitions separate from examples and word origins; other content remains readable as full entries. Reimport older packs to reprocess their structure without changing saved vocabulary or whether the dictionary is enabled.
- **AI dictionary entries**: generate definitions, pronunciation and examples in your native or chosen explanation language, then add usage points and word origins when you need them. Valid parts of an incomplete supplement remain available and are marked as partial. Full results sync through connected Google Drive; updates keep earlier versions. Dictionary results and AI content read in one column, with live generation progress and the definition you will save kept in view. Automatic basic-entry generation is optional.
- **Explain selected text in context**: use Explain to understand a word or passage in the current article; dictionary entries describe its general meanings and usage.
- **Your reading library**: find highlights, notes, saved words and conversations in one place, with dictionary lookup and batch vocabulary management. Save words straight from dictionary results, choose a definition, and link related word forms through an editable base form. Each word keeps its own notes and learning status.
- **Vocabulary exports**: choose a separate multilingual Anki note type to distinguish the same spelling in different languages. Complete TSV keeps notes, base forms and every context with its source; the original six-field formats remain available
- **Send or download**: [Obsidian](https://obsidian.md), Notion, NotebookLM, a GitHub Gist, or any webhook; `.md`, `.html`, or `.epub` for your e-reader
- **Watch while you read**: YouTube and bilibili videos sit beside a transcript that follows playback; AI tags and summaries can read the subtitles

![Reader with bilingual translation and highlights](docs/screenshots/readme/reader.webp)

![Ask the page and get cited answers](docs/screenshots/readme/ask.webp)

![Notes page: one article's highlights read as a single excerpt flow](docs/screenshots/readme/notes.webp)

![A saved word with its context and a dictionary column](docs/screenshots/readme/vocab.webp)

![YouTube preview with a transcript that follows playback](docs/screenshots/readme/video.webp)

### Make Pinboard yours
- **13 themes for pinboard.in** (Dracula · Nord · Catppuccin · Solarized · …) plus your own custom CSS
- **Auto-archive to the [Wayback Machine](https://web.archive.org)**: snapshot each page you save, so it stays readable after the original link dies
- **Backup and sync**: Chrome Sync for settings, your own Google Drive for vocabulary, highlights, notes, AI dictionary entries and conversations; JSON backups cover settings, vocabulary, highlights and notes
- **9 languages** · configurable shortcuts · local-first storage · zero tracking

![13 themes for pinboard.in](docs/screenshots/readme/themes.webp)

## Install

**[→ Install from Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** (recommended)

Or load unpacked from a release ZIP:
1. Download the latest [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Unzip
3. `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select the unzipped folder

The source checkout has a separate fixed development ID, so it can coexist with the Chrome Web Store version for testing. A release ZIP uses the Chrome Web Store ID, so those two versions cannot coexist in one Chrome profile. Chrome Sync can share settings after you enable settings sync on each device. Before replacing an older unpacked release, click **Export backup** in its settings; after loading the new release, use **Import backup**.

After installing, open **Settings → Account** and choose your bookmark service. For Karakeep or linkding, enter the site URL and API token, then click **Connect** and allow access to that server. Include any site subpath; HTTPS is required except on localhost. For Pinboard, paste your [API token](https://pinboard.in/settings/password) in the popup and log in.

Popup, reader, shortcut and batch saves use the selected service. Karakeep uses a dedicated private list for Read Later; marking an item as read removes it from the list without archiving it. linkding uses its unread flag. Pinboard suggestions, tag cleanup, unread counts, site search and Tab Sets remain Pinboard-only.

Vocabulary, highlights, notes, AI dictionary archives and Ask history share one personal library across all three services. Switching services or signing out does not switch the library. Upgrading preserves the current Pinboard library; other historical accounts are not merged. Bookmark caches, drafts and offline queues remain tied to their original connection. Connecting to linkding again after signing out counts as a new connection, so saves still waiting from the earlier one are not retried automatically.

## Privacy

No tracking, no analytics, no telemetry. For new users, settings and credentials stay on this device by default. Ordinary settings sync is enabled separately on each device. Credential sync is one Chrome-account-wide choice, but only devices with settings sync enabled participate; other devices continue using local credentials. New users start with credential sync off, while upgrades keep it on when non-empty credentials already exist in Chrome Sync to avoid data loss. When enabled, API keys, tokens, passwords, and export credentials are shared through Chrome Sync and are obfuscated, not encrypted. Saved bookmarks, page content, and the offline queue never enter Chrome Sync. AI requests come **only** from AI features you turn on or use, and go directly to the provider you configured. At install time, only Pinboard access is granted. Any other site the extension needs (an AI provider, an export or archive destination, a dictionary, Google Drive, video subtitles, or the sites in a Batch Save) is requested one exact site at a time, the first time you use that feature. Custom network endpoints must use HTTPS; HTTP is allowed only for `localhost`, `127.0.0.1`, and `[::1]`. Extension pages enforce a strict Content-Security-Policy (no remote code). Full policy: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

Google Drive connects separately on each device and syncs the personal library’s vocabulary, highlights, notes, complete AI dictionary entries with their supplements, and saved questions and answers with source excerpts. Drive copies are plaintext in the private appDataFolder and are not end-to-end encrypted. Optional word-origin evidence comes from Wiktionary. The extension checks the source text and sends short excerpts and relevant metadata to your chosen AI provider. Examples in usage points are AI-written. Original-text examples are searched on Wikisource and shown as found, without translation; they are never sent to AI. Earlier paid results are retained; a new version is generated only on request.

Update the extension on every device that syncs vocabulary. This version reads existing vocabulary data, but older versions cannot receive vocabulary changes written by this version.

## License

MIT. See [LICENSE](LICENSE).
