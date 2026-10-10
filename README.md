# Pinboard Bookmark Enhanced

**English** | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

A Chrome extension for [Pinboard](https://pinboard.in): AI tags and summaries, a built-in reader with translation and highlights, and 13 themes for the site itself.

> **Note:** This extension requires a Pinboard.in account. [Pinboard](https://pinboard.in) is an independent, **PAID** bookmarking service. This extension is a third-party client that connects to your existing Pinboard account with your own Pinboard API token. It is not affiliated with, sponsored by, or endorsed by Pinboard. You must already have (or sign up for) a paid Pinboard.in account to use this extension.

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
- **AI tags & summary**: reads the article body without the ads, menus, and sidebars; bring your own key (14 providers, or any OpenAI-compatible endpoint)
- **Autocomplete** from your own tags, Pinboard's suggestions, and one-tap presets
- **Tag cleanup**: merge near-duplicate tags and prune rarely used ones

### Read
- **Any page becomes a clean reader**: a Markdown view with table of contents, search, and footnote peek; math, diagrams, and tables render properly
- **Five-color highlights with notes**: they stay in place through translation and even later edits to the page
- **Translate the page or ask it questions**: full-page translation with a bilingual view; answers cite the source and jump straight to it
- **Look up words as you read**: definitions open on the sense that fits your sentence; send saved words to Anki or Eudic in one click, or add offline Chinese-English and English-Chinese dictionaries
- **A full page for notes and vocabulary**: saved words and highlights in one place, with dictionary lookup and batch management
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
- **Backup and sync**: Chrome Sync for settings, your own Google Drive for vocabulary and highlights, and a JSON file that backs up all of it
- **9 languages** · configurable shortcuts · local-first storage · zero tracking

![13 themes for pinboard.in](docs/screenshots/readme/themes.webp)

## Install

**[→ Install from Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** (recommended)

Or load unpacked from a release ZIP:
1. Download the latest [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Unzip
3. `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select the unzipped folder

The source checkout has a separate fixed development ID, so it can coexist with the Chrome Web Store version for testing. A release ZIP uses the Chrome Web Store ID, so those two versions cannot coexist in one Chrome profile. Chrome Sync can share settings after you enable settings sync on each device. Before replacing an older unpacked release, click **Export backup** in its settings; after loading the new release, use **Import backup**.

After installing, click the toolbar icon → paste your [Pinboard API token](https://pinboard.in/settings/password) → **Log in**

## Privacy

No tracking, no analytics, no telemetry. For new users, settings and credentials stay on this device by default. Ordinary settings sync is enabled separately on each device. Credential sync is one Chrome-account-wide choice, but only devices with settings sync enabled participate; other devices continue using local credentials. New users start with credential sync off, while upgrades keep it on when non-empty credentials already exist in Chrome Sync to avoid data loss. When enabled, API keys, tokens, passwords, and export credentials are shared through Chrome Sync and are obfuscated, not encrypted. Saved bookmarks, page content, and the offline queue never enter Chrome Sync. AI requests come **only** from AI features you turn on or use, and go directly to the provider you configured. At install time, only Pinboard access is granted. Any other site the extension needs (an AI provider, an export or archive destination, a dictionary, Google Drive, video subtitles, or the sites in a Batch Save) is requested one exact site at a time, the first time you use that feature. Custom network endpoints must use HTTPS; HTTP is allowed only for `localhost`, `127.0.0.1`, and `[::1]`. Extension pages enforce a strict Content-Security-Policy (no remote code). Full policy: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

Google Drive connects separately on each device and syncs selected data for the current Pinboard account: vocabulary is selected by default after connection, while highlights and notes require a separate opt-in. These choices stay on the device; Drive copies are plaintext in the private appDataFolder and are not end-to-end encrypted.

## License

MIT. See [LICENSE](LICENSE).
