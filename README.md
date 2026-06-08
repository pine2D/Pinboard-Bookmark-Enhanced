# Pinboard Bookmark Enhanced

**English** | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

A Chrome extension that supercharges [Pinboard](https://pinboard.in) bookmarking with AI-powered tags, summaries, and a fully themeable interface.

> **Note:** Requires a Pinboard.in account — [Pinboard](https://pinboard.in) (pinboard.in) is an independent, **PAID** bookmarking service. This extension is a third-party client that connects to your existing Pinboard account with your own Pinboard API token. It is not affiliated with, sponsored by, or endorsed by Pinboard. You must already have (or sign up for) a paid Pinboard.in account to use this extension.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## Features

- **Smart capture** — auto-fills the title, URL, meta description, referrer, and any selected text, and strips tracking parameters (`utm_*`, `gclid`, `fbclid`, …) from the saved URL on capture or paste, with an aggressive mode and custom keep/remove lists
- **AI tags & summaries** — bring your own key for 13 popular LLM providers, or any OpenAI-compatible endpoint; the AI reads the cleaned article body with ads, menus, and sidebars stripped out
- **Tag assistant** — autocomplete from your own tags, Pinboard's suggested tags, and one-tap tag presets
- **Quick save** — save the page (or as *read later*) straight from a keyboard shortcut, no popup needed; or batch-save every open tab with per-tab AI tagging and live progress, and bundle them into a Tab Set
- **Find & revisit** — search your bookmarks, jump to Unread / Network / Notes / Popular, and browse recent saves; the toolbar icon flips when the current page is already bookmarked
- **Offline queue** — drafts persist locally and sync when you reconnect
- **Themeable `pinboard.in`** — 13 curated palettes (Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …) plus a custom-CSS overlay that syncs across devices, with an adjustable popup width
- **Page-to-Markdown** — turn the current page into clean Markdown with a built-in preview (rendered/raw views, table of contents, and reading stats); copy or download as `.md` or styled `.html`, tune frontmatter, image handling, and TOC inclusion, or optionally send it straight to [Obsidian](https://obsidian.md); pick [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown) (local) or [Jina Reader](https://jina.ai/reader) (cloud)
- **9 languages** · configurable shortcuts · zero tracking

## Install

**[→ Install from Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — recommended

Or load unpacked from a release ZIP:
1. Download the latest [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Unzip
3. `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select the unzipped folder

After installing, click the toolbar icon → paste your [Pinboard API token](https://pinboard.in/settings/password) → save

## Privacy

No tracking, no analytics, no telemetry. All data is stored on your device via `chrome.storage`; if you turn on settings sync, your settings (not your saved bookmarks) sync across your devices via Chrome's account sync. AI requests fire **only** when you click "AI tags" or "AI summary" and go directly to the provider you configured. Full policy: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## License

MIT — see [LICENSE](LICENSE).
