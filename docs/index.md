---
layout: default
title: Pinboard Bookmark Enhanced
---

# Pinboard Bookmark Enhanced

A Chrome extension for [Pinboard](https://pinboard.in) with AI tags and summaries, a reader with translation and highlights, and 13 themes for pinboard.in.

## Reading and translation

- Save the article to Pinboard or edit its bookmark directly in the reader.
- Choose the definition language for AI entries independently of the interface or the word’s language, and filter saved vocabulary by language. Original dictionary definitions retain their own language.
- Import Yomitan v3 ZIP dictionaries for offline definitions and readings on this device. Dictionary packs are excluded from Drive sync and JSON backups.
- Generate basic AI definitions and examples, then request word origins, related words and usage supplements separately. Keep valid parts of incomplete supplements and complete the missing content on request. Reuse saved results across devices with Google Drive. Choose the dictionary or AI as the initial lookup view; automatic generation is optional.
- Use Explain for a word or passage in the current article. Dictionary lookup provides general meanings and usage; AI entries do not include article context or imported dictionary text.
- Save a word directly from its dictionary result and choose the definition to keep. Link related forms through an editable base form; notes and learning status remain separate for each word.
- In Vocabulary settings, choose the optional multilingual Anki format to keep same-spelled words from different languages separate. It creates a separate note type, leaves existing cards untouched, and skips existing notes on repeated sends. Complete TSV includes notes, base forms and every context with its source; the original six-field formats remain available. Use JSON backup to restore vocabulary in the extension.
- Completed Ask answers and their cited source excerpts are saved automatically and sync through Google Drive. Browse conversations in the library, continue in the reader, or export them alone or with the article. Temporary conversations are not saved.
- The reader translates the extracted article text rather than the live page, so headings, lists, tables, code blocks, and math keep their structure in both the bilingual and translated views.
- Translation runs between your browser and the AI provider you configured with your own key. The extension operates no translation snapshot or sharing service, so a translated page cannot appear on a public URL unless you export it yourself.

## Sync and backup

- Chrome Sync can share settings between devices where you enable it. Credential sync is a separate opt-in.
- Manual schema v3 JSON backups contain settings and can optionally include reader highlights, notes, and vocabulary from the current Pinboard account, plus API keys and tokens if you tick that box.
- Google Drive syncs the current Pinboard account's vocabulary, highlights, notes, complete AI dictionary entries with their supplements, and saved Ask conversations. Connect it on each device under General → Data Sync while signed in to Chrome; disconnecting a device stops syncing there and keeps your data.
- Update the extension on every device that syncs vocabulary. This version reads existing vocabulary data, but older versions cannot receive vocabulary changes written by this version.

## Video pages

- On YouTube and bilibili video pages the reader loads the video beside its subtitles and treats the transcript as the article. Subtitle access is asked for once per site, from a button in the reader; before that click, the only request is for YouTube's video thumbnail.
- `yt-embed.html` on this site is the relay page the reader frames to load YouTube's player: Chrome sends no Referer from extension pages, so the player refuses to load there directly. The relay passes play and seek commands between the reader and the player, answers only the reader page that first messaged it, and stores nothing.

## Documents

- [Privacy Policy](./privacy.html)

## Source

- [GitHub repository](https://github.com/pine2D/Pinboard-Bookmark-Enhanced)
- [Report an issue](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/issues)
- [Latest release](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
