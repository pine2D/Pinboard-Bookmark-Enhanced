---
layout: default
title: Data Formats
---

# Data Formats and Storage Reference

**Last updated:** 2026-11-14

Bookmark Enhanced stores your data locally in Chrome storage and IndexedDB, exports portable JSON backups (`_schemaVersion: 3`), and optionally syncs personal-library records as JSON batches in Google Drive's private `appDataFolder`. This page documents those on-disk and sync formats so you can inspect, audit, back up, or migrate your own data without reading source code.

## 1. Storage channels at a glance

| Channel | Scope | What lives there |
|---------|-------|------------------|
| `chrome.storage.local` | Per browser profile | Default settings, credentials (when credential sync is off), `optSyncEnabled`, `bookmarkServiceActive`, `pinboardTokenVerified`, `personalLibraryAccount`, article highlights and notes (`pbp_hl_<hash>`), offline save queue (`offlineQueue`), Drive sync cursors/state (`driveConnState:<ownerHash>`), dictionary negative/failure memos, reader handoff state |
| `chrome.storage.sync` | Chrome account (optional) | Ordinary settings from `SETTINGS_DEFAULTS` when `optSyncEnabled` is `true` (values exceeding `7800` UTF-8 bytes are split into chunk keys); credentials and export-target tokens only when `syncApiKeys` is also `true` |
| `chrome.storage.session` | In-memory browser session | Unsaved popup drafts (24-hour TTL, separated between normal and incognito windows) |
| IndexedDB (7 databases) | Per browser profile | Vocabulary, offline dictionary packs, Yomitan dictionaries, AI dictionary archive, Ask conversation archive, local restore points, AI response cache |
| Google Drive `appDataFolder` | Google account (optional, per device) | Convergent JSON batch files for vocabulary, highlights/notes, AI dictionary archive, and saved Ask history |
| Manual Backup JSON (`_schemaVersion: 3`) | User-downloaded plaintext `.json` | Settings, custom CSS/themes, and user-selected highlights/notes, vocabulary, and (opt-in) credentials |

## 2. IndexedDB databases

All seven databases live under the extension's `chrome-extension://<id>` origin:

1. **`pbp-vocab` (version 2)**:
   - `words` (`keyPath: "id"`, format `<owner>|<language>|<termLower>`; indexes `owner`, `updatedAt`): saved vocabulary entries including headword, language, lemma, definition, IPA, context sentences with source URL/title, user note, highlight link, and CRDT causal metadata (`vv`, `dot`, tombstones).
   - `sync` (`keyPath: "key"`): per-owner Google Drive outbox, frozen batch bodies, and remote cursor state.
2. **`pbp-dict-packs` (version 2)**:
   - `cedict` (auto-increment `id`; indexes `simp`, `trad`): imported CC-CEDICT Chinese entries.
   - `ecdict` (auto-increment `id`; index `key`): imported ECDICT English-to-Chinese entries.
   - `packs` (`keyPath: "id"`): import metadata, entry counts, tier selection, byte length, and CRC32 checksum.
3. **`pbp-multidict` (version 1)**:
   - `packs` (`keyPath: "id"`), `generations` (`keyPath: "id"`), and `terms` (`keyPath: ["generation", "row"]`; indexes `term`, `folded`, `reading`): imported Yomitan v3 dictionary metadata and term rows.
4. **`pbp-dict-archive` (version 1)**:
   - `records` (`keyPath: "key"`, format `<owner>|<recordKey>`; indexes `owner`, `lookup`, `parent`): immutable `entry` records (structured senses, pronunciation, examples, etymology, related forms, provider/model, timestamp) and `supplement` records (patterns, confusables, etymology, usage notes, verified citations).
   - `sync` (`keyPath: "key"`): per-owner Google Drive sync state for dictionary archive batches.
5. **`pbp-ask-archive` (version 1)**:
   - `records` (`keyPath: "key"`, format `<owner>|<recordKey>`; indexes `owner`, `session`, `url`): immutable `round` records (article URL/title, question, answer, verified quote citations, model, timestamp, revision chain) and `delete` tombstones.
   - `sync` (`keyPath: "key"`): per-owner Google Drive sync state for Ask history batches.
6. **`pbp-restore-points` (version 2)**:
   - `points` (`keyPath: "id"`, format `rp_<ISO-timestamp>`) and `meta` (`keyPath: "id"`; index `ownerCreated: ["owner", "createdAt"]`): automatic pre-import, pre-delete, and post-update snapshots (`reason: "import" | "delete" | "update"`). Up to 5 restore points are retained per `owner` (with at most 1 `"update"` slot), never containing credentials.
7. **`pbp-ai-cache` (version 1)**:
   - `entries` (`keyPath: "key"`; index `ts`): LRU-bounded caches separated by prefix (`tr_*` 300, `vpunct_*` 300, `dict2_*` 500, `dictctx2_*` 500, `summary_owner_*` 20000, `summary_hold_*` 5000, general 200).

## 3. Article highlights and notes in `chrome.storage.local`

Each annotated URL is stored under `pbp_hl_<8-hex-fnv1a>` in `chrome.storage.local`:

```json
{
  "url": "https://example.com/article",
  "title": "Example Article",
  "owner": "personal:default",
  "updatedAt": 1762800000000,
  "items": [
    {
      "id": "hl_...",
      "quote": "selected passage",
      "note": "optional reader note",
      "color": 1,
      "ts": 1762800000000
    }
  ]
}
```

Companion local keys (`pbp_hl_last_color`, `pbp_notes_sync_*`, `pbpNotesSyncDeviceId`) track highlight color preference and Google Drive outbox/tombstone convergence state.

## 4. Manual JSON backup format (`_schemaVersion: 3`)

Exported from **Settings > Backup & Diagnostics**, a manual backup is a UTF-8 JSON object:

```json
{
  "_schemaVersion": 3,
  "_backup": {
    "createdAt": "2026-11-14T00:00:00.000Z",
    "extensionVersion": "3.0.3",
    "source": "manual",
    "includesSecrets": false
  },
  "aiProvider": "openai",
  "customOverlayCSS": "",
  "savedThemes": [],
  "exportTargets": {},
  "_highlights": {
    "pbp_hl_a1b2c3d4": { "url": "https://example.com/", "items": [] }
  },
  "_highlightsOwner": "personal:default",
  "_vocabulary": {
    "owner": "personal:default",
    "records": []
  }
}
```

Key rules of `_schemaVersion: 3`:

- **Fail-closed credentials**: `API_KEY_FIELDS` and secret export-target fields (`token`, `webhook.url`) are stripped on export unless you explicitly opt in (`includesSecrets: true`, which also marks the filename `with credentials`). On import, credentials are ignored again unless you explicitly check credential import in the preview dialog.
- **Device-local exclusions**: `personalLibraryAccount`, `bookmarkServiceActive`, `pinboardTokenVerified`, OAuth tokens, offline queues, caches, and dictionary packs are never exported into manual settings keys.
- **Restore points**: Snapshots in `pbp-restore-points` reuse the `_schemaVersion: 3` envelope with `"source": "restore-point"` and carry only `_schemaVersion`, `_backup`, `_highlights`, `_highlightsOwner`, and `_vocabulary`.

## 5. Google Drive `appDataFolder` batch files

When Google Drive sync is connected, the extension writes immutable JSON batch files into the application-private `appDataFolder` scope (`https://www.googleapis.com/auth/drive.appdata`). Each Drive file carries `appProperties` (`pbpKind`, `schema`, `owner` as SHA-256 hex of `personalLibraryAccount`, and `device` UUID) and a JSON body `{ schema, ownerHash, deviceId, createdAt, entries }`:

| Store | `pbpKind` | File prefix | Current `schema` (readable versions) |
|-------|-----------|-------------|--------------------------------------|
| Vocabulary | `vocab-batch` | `pbp-vocab-<id>.json` | `2` (`1`, `2`) |
| Highlights & notes | `notes-batch` | `pbp-notes-<id>.json` | `1` (`1`) |
| AI dictionary archive | `dict-entry-batch` | `pbp-dict-entry-<id>.json` | `4` (`1`, `2`, `3`, `4`) |
| Saved Ask history | `ask-history-batch` | `pbp-ask-history-<id>.json` | `1` (`1`) |

## Related documents

- [Troubleshooting](./troubleshooting.html)
- [Privacy Policy](./privacy.html)
