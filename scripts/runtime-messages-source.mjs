// Authoritative single source of truth for runtime messaging across the
// extension (chrome.runtime.sendMessage, chrome.tabs.sendMessage, and
// chrome.runtime.onMessage.addListener).
//
// Consumed by `scripts/sync-runtime-messages.mjs` (`--check` / `--write`) to:
//   1. Generate `@generated:runtime-messages` (`PBP_RUNTIME_MESSAGES`) in `shared.js`
//   2. Verify 1:1 AST parity between every sender, every listener, and this catalog
//   3. Enforce MV3 `onMessage` channel rules (`.claude/rules/mv3.md`: listeners must
//      never be `async`; async responders must `return true`; passive observers must
//      neither `return true` nor call `sendResponse`)
//   4. Block hand-written second copies of the message table

function freezeMessage(spec) {
  return Object.freeze({
    key: spec.wire,
    wire: spec.wire,
    discriminator: spec.discriminator || 'type',
    transport: spec.transport || 'runtime',
    responseMode: spec.responseMode,
    responder: spec.responder ?? null,
    observers: Object.freeze([...(spec.observers || [])].sort()),
    senders: Object.freeze([...spec.senders].sort()),
  });
}

export const RUNTIME_MESSAGES = Object.freeze([
  // ---- Reader bookmark bar <-> service worker ----
  freezeMessage({
    wire: 'mdReaderBookmarkState',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['md-bookmark.js'],
  }),
  freezeMessage({
    wire: 'mdReaderBookmarkSave',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['md-bookmark.js'],
  }),
  freezeMessage({
    wire: 'mdReaderBookmarkDelete',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['md-bookmark.js'],
  }),
  freezeMessage({
    wire: 'PBP_READER_BOOKMARK_COMMAND',
    transport: 'tabs',
    responseMode: 'sync',
    responder: 'md-bookmark.js',
    senders: ['background.js'],
  }),

  // ---- pinboard.in content scripts -> service worker ----
  freezeMessage({
    wire: 'get_site_prefs',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['pinboard-sort.js', 'pinboard-style.js'],
  }),

  // ---- Bookmark service connection, lookup, save & offline queue ----
  freezeMessage({
    wire: 'bookmark_connect',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['options.js'],
  }),
  freezeMessage({
    wire: 'bookmark_api',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['popup.js'],
  }),
  freezeMessage({
    wire: 'PBP_RESET_PINBOARD_AUTH',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['popup.js'],
  }),
  freezeMessage({
    wire: 'get_bookmark_data',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['popup.js'],
  }),
  freezeMessage({
    wire: 'lookup_bookmark',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['popup.js'],
  }),
  freezeMessage({
    wire: 'PBP_POPUP_DRAFT',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['options.js', 'popup.js'],
  }),
  freezeMessage({
    wire: 'get_offline_queue',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['popup-offline.js'],
  }),
  freezeMessage({
    wire: 'PBP_AI_CALL',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['popup-ai.js'],
  }),
  freezeMessage({
    wire: 'save_intent',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['popup.js'],
  }),
  freezeMessage({
    wire: 'archive_url',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['options.js'],
  }),
  freezeMessage({
    wire: 'bookmark_deleted',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['popup.js'],
  }),
  // Legacy batch wire shapes (`action` discriminator locked by background-lifecycle-tests.html).
  freezeMessage({
    wire: 'saveTabSet',
    discriminator: 'action',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['popup-batch.js'],
  }),
  freezeMessage({
    wire: 'startBatchSave',
    discriminator: 'action',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['popup-batch.js'],
  }),
  freezeMessage({
    wire: 'pinboard_api_call',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['options.js', 'popup.js'],
  }),
  freezeMessage({
    wire: 'retry_offline_item',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['popup-offline.js'],
  }),
  freezeMessage({
    wire: 'remove_offline_item',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['popup-offline.js'],
  }),
  freezeMessage({
    wire: 'clear_offline_queue',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['popup.js'],
  }),
  freezeMessage({
    wire: 'test_pinboard_token',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['options-connectivity.js', 'popup.js'],
  }),

  // ---- Reader preview extraction & hotlink image-fix DNR rules ----
  freezeMessage({
    wire: 'imgFixInstallReferer',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['md-embed.js'],
  }),
  freezeMessage({
    wire: 'imgFixRemoveReferer',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['md-embed.js'],
  }),
  freezeMessage({
    wire: 'imgFixResetTab',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['md-embed.js'],
  }),
  freezeMessage({
    wire: 'reextractMarkdown',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['md-preview.js'],
  }),

  // ---- Personal library & Google Drive sync ----
  freezeMessage({
    wire: 'PBP_VOCAB_DIRTY',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['vocab-store.js'],
  }),
  freezeMessage({
    wire: 'PBP_NOTES_DIRTY',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['notes-sync.js'],
  }),
  freezeMessage({
    wire: 'PBP_DICT_ARCHIVE_DIRTY',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['dict-archive.js'],
  }),
  freezeMessage({
    wire: 'PBP_ASK_ARCHIVE_DIRTY',
    responseMode: 'async',
    responder: 'background.js',
    observers: ['library-ask.js', 'md-ask.js'],
    senders: ['ask-archive.js'],
  }),
  freezeMessage({
    wire: 'PBP_DICT_ARCHIVE_SYNC',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['dict-entry.js'],
  }),
  freezeMessage({
    wire: 'PBP_ASK_ARCHIVE_RESTORE',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['library-ask.js', 'md-ask.js'],
  }),
  freezeMessage({
    wire: 'vocabDriveConnect',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['options-vocab.js'],
  }),
  freezeMessage({
    wire: 'vocabDriveStatus',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['library.js', 'md-ask.js', 'options-vocab.js'],
  }),
  freezeMessage({
    wire: 'vocabDriveClearNotices',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['options-vocab.js'],
  }),
  freezeMessage({
    wire: 'vocabDriveSyncNow',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['options-vocab.js'],
  }),
  freezeMessage({
    wire: 'vocabDriveDisconnect',
    responseMode: 'async',
    responder: 'background.js',
    senders: ['options-vocab.js'],
  }),

  // ---- One-way broadcasts (passive observers only; must never return true) ----
  freezeMessage({
    wire: 'PBP_VOCAB_SYNCED',
    responseMode: 'none',
    observers: ['library-vocab.js', 'library.js', 'md-vocab-echo.js'],
    senders: ['background.js', 'library-vocab.js'],
  }),
  freezeMessage({
    wire: 'PBP_NOTES_SYNCED',
    responseMode: 'none',
    observers: ['library.js'],
    senders: ['background.js'],
  }),
  freezeMessage({
    wire: 'PBP_DICT_ARCHIVE_SYNCED',
    responseMode: 'none',
    observers: ['library.js', 'md-dict.js'],
    senders: ['background.js'],
  }),
  freezeMessage({
    wire: 'PBP_ASK_ARCHIVE_SYNCED',
    responseMode: 'none',
    observers: ['library-ask.js', 'library.js', 'md-ask.js'],
    senders: ['background.js'],
  }),
  freezeMessage({
    wire: 'PBP_DRIVE_CONNECT_AUTHORIZED',
    responseMode: 'none',
    observers: ['options-vocab.js'],
    senders: ['background.js'],
  }),
]);

// Explicit allowlist for cross-extension runtime.sendMessage(extensionId, payload) calls.
export const EXTERNAL_RUNTIME_SENDERS = Object.freeze([
  Object.freeze({
    id: 'singlefile-save-page',
    file: 'background.js',
    extensionIdIdent: 'PBP_SINGLEFILE_EXTENSION_ID',
    payload: 'save-page',
  }),
]);
