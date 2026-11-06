# Bookmark Enhanced

**English** | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

A Chrome extension for [Pinboard](https://pinboard.in), [Karakeep](https://karakeep.app) and [linkding](https://linkding.link): AI tags and summaries, a reader with translation and highlights, and 13 themes for pinboard.in.

> **Note:** Choose one bookmark service in Settings. Karakeep and linkding work without a Pinboard account. Pinboard is an independent **paid** service and requires your own account and API token. This third-party extension is not affiliated with, sponsored by, or endorsed by Pinboard.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Saving a page with AI tags and summary, in dark and light themes](docs/screenshots/readme/hero.webp)

[![1-minute video tour: save it, read it, keep it](docs/screenshots/readme/promo-video.webp)](https://youtu.be/YWvA_Vux0CI)

---

## Features

### Save
- **Save to the service you choose**: Pinboard, Karakeep or linkding, with the title, description and selected text filled in.
- **AI tags and summaries**: suggested from the article itself, using your own API key.
- **Save while offline**: saves wait and go through once you are back online.

### Read
- **A clean reader for any page**: no ads or sidebars, with highlights and notes.
- **Read in two languages**: translate the whole page and keep the original beside it.
- **Ask the page**: answers cite the article, and one click takes you to the quoted sentence.
- **Look up words as you read**: see definitions and pronunciation without leaving the page, and send saved words to Anki.
- **Watch while you read**: YouTube and bilibili videos play beside a transcript that follows along.

![Reader with bilingual translation and highlights](docs/screenshots/readme/reader.webp)

![Ask the page and get cited answers](docs/screenshots/readme/ask.webp)

![YouTube preview with a transcript that follows playback](docs/screenshots/readme/video.webp)

### Keep
- **One library for everything you kept**: highlights, notes, saved words and past questions, synced through your own Google Drive.
- **Send or download**: send to [Obsidian](https://obsidian.md), Notion and more, or download as `.md`, `.html` or `.epub`.

![Notes page: one article's highlights read as a single excerpt flow](docs/screenshots/readme/notes.webp)

![A saved word with its context and a dictionary column](docs/screenshots/readme/vocab.webp)

### Make Pinboard yours
- **13 themes for pinboard.in**: light and dark looks for the site, plus your own CSS.
- **Tidy your tags**: merge near-duplicates and prune the ones you rarely use.
- **Auto-archive to the [Wayback Machine](https://web.archive.org)**: pages you save stay readable after the original link dies.

![13 themes for pinboard.in](docs/screenshots/readme/themes.webp)

## Install

**[→ Install from Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** (recommended)

Or load unpacked from a release ZIP:
1. Download the latest [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Unzip
3. `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select the unzipped folder

Then open **Settings → Account** and connect your bookmark service: an [API token](https://pinboard.in/settings/password) for Pinboard, or your server address and API token for Karakeep (0.31 or later) or linkding.

## Privacy

The extension does not track you or collect usage data. Settings and keys stay on this device unless you turn on sync; synced keys are obfuscated, not encrypted. AI requests go only to the provider you set up, and only when you use an AI feature. For any site other than Pinboard, the extension asks for access the first time you use a feature that needs it. Google Drive copies are stored in the extension's private app folder and are not end-to-end encrypted. Full policy: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## License

MIT. See [LICENSE](LICENSE).
