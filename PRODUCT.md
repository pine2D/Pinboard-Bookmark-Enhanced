# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Chrome Extension, Manifest V3. Four extension surfaces — popup, options, library, md-preview reader — plus injected themes and tag sorting on pinboard.in.)

## Users

Two primary audiences, weighted equally:

- **Frequent bookmark users.** People who save and organize pages in Pinboard, Karakeep, or linkding every day, often bringing their own AI key for tags and summaries. They are impatient with waiting (AI latency, cold opens) and notice small UI defects such as 1px gaps, contrast slips, or double borders.
- **Foreign-language readers and learners.** People who use the built-in reader to read articles and videos in another language: full-page translation, Ask-the-page, word lookup, highlights and notes, and a vocabulary book they review and send to Anki or Eudic.

Many users belong to both groups. Saving is the entry point, and reading, highlighting, and vocabulary are core jobs, not side features.

## Product Purpose

A Chrome extension for Pinboard, Karakeep, and linkding that turns a bookmark into a complete loop: save the page (with AI tags and a summary) → read it cleanly → translate it, ask it questions, highlight it, collect words from it → keep and export the results. Success means a user saves in one click without waiting, and a saved page becomes something they actually read and learn from instead of a dead link.

## Positioning

- **Bookmark, read, and learn.** Save → read → highlight/vocabulary → export runs as one connected flow. Users choose their bookmark service and keep one personal library across all three services.
- **Bring your own key, local-first, zero tracking.** AI calls happen only for AI features the user turns on or uses, and go straight to the provider they configured. At install, only Pinboard access is granted; every other site is requested one exact origin at a time, on first use. Bookmarks go to the selected service. Reading data stays on the device or syncs to the user's own Google Drive appDataFolder when connected; AI and export actions send only their required data to the configured destination. No analytics or telemetry.
- **Fast.** No cold-open stall and no needless waiting. Zero runtime dependencies, no build step, and strict first-paint performance rules are part of the product promise, not just an implementation detail.

## Operating Context

- Choose Pinboard, Karakeep, or linkding as the primary bookmark service. Karakeep and linkding require the user's server URL and API token, with no Pinboard account. Pinboard requires a paid account and the user's own API token. The extension is not affiliated with, sponsored by, or endorsed by Pinboard; keep this conditional paid-service disclosure visible wherever the product is described.
- Distributed on the Chrome Web Store (ID `pnjndmjhljjbdlbejeenkepdalokfooh`) and as release ZIPs on GitHub.
- Popup, options, and library are short-lived, single-render surfaces opened many times a day. The reader is a long-session reading surface.
- Main usage environment: high-DPI / 4K Windows with cold starts. This is the reference for font and first-paint behavior.
- Connected tools: AI providers (17, plus OpenAI-compatible endpoints), Obsidian, Notion, NotebookLM, GitHub Gist, webhooks, Wayback Machine, Free Dictionary, offline CC-CEDICT and user-supplied ECDICT, AnkiConnect, Eudic, Google Drive, YouTube and bilibili subtitles.

## Capabilities and Constraints

- Capabilities: one-click save with stripped tracking params, hotkeys, Batch Save, offline queue, drafts; AI tags and summaries; tag autocomplete and tag cleanup; Markdown reader with TOC, search, footnotes, math, Mermaid and tables; five-color highlights with notes; full-page bilingual translation; Ask-the-page with citations; opt-in key-point skim; dictionary lookup and vocabulary book; notes and vocabulary page (library); export to `.md` / `.html` / `.epub`; video pages with a transcript that follows playback; 13 themes for pinboard.in plus custom CSS; Wayback auto-archive; JSON backup, Chrome Sync for settings, Google Drive for the personal library's vocabulary, highlights, notes, complete AI dictionary entries and supplements, and saved Ask conversations.
- Technical constraints: vanilla JavaScript, no framework, no build step, zero runtime dependencies; MV3 CSP (no remote code, no remote fonts); service-worker lifecycle rules; theme surfaces generated from the theme factory (`docs/theme-surface/`), never hand-edited.
- Terminology: credentials take the form developers in each language actually write, one form per locale (2026-10-16 ruling). zh-CN / zh-TW / zh-HK keep the English "API Key" and "API Token"; en writes "API key" / "API token" in running text and title case on field labels; de "API-Schlüssel" / "API-Token", fr "clé API" / "jeton API", ja "API キー" / "API トークン", pl "klucz API" / "token API", ru "API-ключ" / "API-токен". "Batch Save" (批量保存), "tab set" (标签页集) follow the 2026-10-10 copy ruling.
- Bookmark connection isolation: caches, drafts, and pending saves carry a non-secret connection identity and are checked at every read, write-back, and UI commit. Switching services does not send an earlier connection's pending work to the new service.
- Shared personal library: vocabulary, highlights, notes, dictionary archives, and Ask history retain one identity across bookmark services and sign-outs. Upgrades preserve the current library without merging other historical accounts.
- Service-specific behavior: Karakeep Read Later uses an owned private manual list, separate from archiving; linkding uses its unread flag. Pinboard suggestions, tag cleanup, unread counts, site search, Tab Sets, and site themes remain Pinboard-specific.

## Brand Commitments

- Name: Bookmark Enhanced; zh-CN: 书签增强, zh-TW: 書籤強化, zh-HK: 書籤增強. Author: pine2D. License: MIT.
- Renaming changes display copy only. Keep the existing GitHub repository and Pages URLs, extension IDs and OAuth clients, storage keys, default Anki deck, and Karakeep Read Later list marker stable so upgrades keep existing data and integrations.
- Icons: Lucide v0.525.0 paths only (24 box, stroke 2), with the Obsidian brand diamond as the single exception. No literal emoji or dingbat characters in UI.
- Voice: concise, plain, identity-first feature descriptions with strong verbs, not lists of operations. Each of the nine locales is rewritten for its readers, not machine-translated.
- Chrome Web Store copy must not list brands, formats, or URLs as keyword strings (rejected for keyword spam on 2026-10-10).

## Evidence on Hand

- README feature screenshots: `docs/screenshots/readme/` (hero, reader, ask, notes, vocab, video, themes).
- Chrome Web Store promo images and screenshots: `docs/cws-assets/`.
- 1-minute video tour: https://youtu.be/YWvA_Vux0CI
- Privacy policy: `docs/privacy.md` (published on GitHub Pages).
- None of the following exists, so future work must not invent it: testimonials, user counts, ratings, reviews, press coverage, benchmarks.

## Product Principles

1. **Never make the user wait.** Cold open, saving, and every frequent action give instant feedback. Performance is a feature.
2. **The user owns their data and their keys.** Request nothing by default; ask for one exact permission at the moment a feature needs it, and keep data local or in the user's own storage.
3. **One loop, not a pile of features.** Save, read, and learn should feel like one product. New capabilities have to fit that flow.
4. **Every language is first-class.** All nine locales get equal quality, and long German, French, or Russian strings and CJK text never break a layout.
5. **Details are the brand.** Precise alignment, contrast, and state feedback are how quality shows, because the users notice.

## Accessibility & Inclusion

- WCAG AA contrast on every theme and surface. The theme factory already enforces an AA gate.
- Full keyboard reach on every surface; icon-only buttons carry a `title`, an `aria-label`, and a hit area of at least 24px.
- Nine locales with equal quality: en, zh_CN, zh_TW, zh_HK, de, fr, ja, pl, ru. RTL content is supported in the reader.
- Fast CJK font stacks and no emoji-font fallback, so high-DPI Windows cold starts never stall.
