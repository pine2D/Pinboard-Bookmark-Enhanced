# Pinboard Bookmark Enhanced

**English** | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

A Chrome extension that supercharges [Pinboard](https://pinboard.in) bookmarking with AI-powered tags, summaries, and a fully themeable interface.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## Features

- **Smart capture** — auto-fills title, URL, meta description, referrer, and selected text. AI receives the cleaned article body with ads, menus, and sidebars stripped out
- **AI tags & summaries** — bring your own key for 13 providers (OpenAI · Anthropic · Gemini · DeepSeek · Qwen · Kimi · Zhipu · Groq · Mistral · MiniMax · Cohere · OpenRouter · Ollama) or any OpenAI-compatible endpoint
- **Batch save** — capture every open tab in one go, with per-tab AI tagging and live progress
- **Already-saved detection** — toolbar icon flips when the current page is already in your bookmarks
- **Themes for `pinboard.in`** — 13 curated palettes (Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …) plus a custom-CSS overlay that syncs across devices
- **Offline queue** — drafts persist locally and sync when you reconnect
- **Page-to-Markdown** — convert the current page to clean Markdown — preview, copy to clipboard, or download as `.md`
- **9 languages**, configurable shortcuts, zero tracking

## Install

**[→ Install from Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — recommended

Or load unpacked from a release ZIP:
1. Download the latest [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Unzip
3. `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select the unzipped folder

After installing, click the toolbar icon → paste your [Pinboard API token](https://pinboard.in/settings/password) → save

## Privacy

No tracking, no analytics, no telemetry. All data lives on your device via `chrome.storage`. AI requests fire **only** when you click "AI tags" or "AI summary" and go directly to the provider you configured. Full policy: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## License

MIT — see [LICENSE](LICENSE).
