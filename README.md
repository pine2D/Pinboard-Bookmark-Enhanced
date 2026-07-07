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
- **Quick & batch save** — save the page (or as *read later*) from a keyboard shortcut without opening the popup, or batch-save every open tab with per-tab AI tagging, live progress, and a Tab Set bundle; drafts queue offline and sync when you reconnect
- **AI tags & summaries** — bring your own key for 13 LLM providers or any OpenAI-compatible endpoint; the AI reads the cleaned article body with ads, menus, and sidebars stripped out
- **Tag tools** — autocomplete from your own tags, Pinboard's suggested tags, and one-tap presets, plus a governance panel that surfaces duplicate and low-count tags (heuristic + on-demand AI clustering) and merges them in throttled batches with live progress
- **Quick links & status** — one-tap to your Unread, Network, Notes, and Popular pages; the toolbar icon flips when the current page is already bookmarked
- **Page-to-Markdown** — turn the current page into clean Markdown with a built-in preview (rendered/raw views, table of contents, reading stats); copy or download as `.md` or styled `.html`, tune frontmatter (including author, publish date, site, cover image, and word count), image handling, and TOC, or send it straight to [Obsidian](https://obsidian.md), a GitHub Gist, or any webhook (Readwise-compatible). Site-aware extraction keeps Q&A and forum threads readable (Zhihu, Hacker News, Stack Overflow, …); pick [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown) (local) or [Jina Reader](https://jina.ai/reader) (cloud)
- **Ask & translate the page** — from that Markdown preview, ask questions and get streamed answers with verified citations that jump to the source, explain or translate any selected passage inline (and keep the answer as a note), or translate the whole page with a custom glossary, live token usage, and original / bilingual / translation views
- **Reader tools** — highlight in five colors with notes that survive re-renders and translation, browse highlights in a Notebook panel, search the article (`/`, optional regex — your notes match too), peek footnotes in place, pick up where you left off, go distraction-free with a focus mode, or add an opt-in AI key-points skim (off by default); press `?` for the full shortcut list
- **Auto-archive** — optionally push every save to the Internet Archive's [Wayback Machine](https://web.archive.org), with an archive log and retry, so your links outlive link-rot
- **Themeable `pinboard.in`** — 13 curated palettes (Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …) plus a custom-CSS overlay that syncs across devices, an adjustable popup width, and sort-by-popularity on tag pages
- **9 languages** · configurable shortcuts · local-first storage · zero tracking

## Install

**[→ Install from Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — recommended

Or load unpacked from a release ZIP:
1. Download the latest [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Unzip
3. `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select the unzipped folder

After installing, click the toolbar icon → paste your [Pinboard API token](https://pinboard.in/settings/password) → save

## Privacy

No tracking, no analytics, no telemetry. All data is stored on your device via `chrome.storage`; if you turn on settings sync, your settings (not your saved bookmarks) sync across your devices via Chrome's account sync. AI requests fire **only** when you explicitly trigger an AI action — AI tags/summary, page Q&A, translation, selection explain, or the opt-in key-points skim — and go directly to the provider you configured. Extension pages enforce a strict Content-Security-Policy (no remote code). Full policy: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## License

MIT — see [LICENSE](LICENSE).
