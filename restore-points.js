// ============================================================
// Restore points: local snapshots of the personal library.
//
// A restore point holds the current personal-library owner's vocabulary,
// highlights and notes, nothing else: no AI entry archive, no Ask history, no
// settings, no themes, never credentials (rules/backup.md). One is taken
// before a backup import is applied, before a batch delete or a delete by
// article in the library, and on the first start after an extension update.
// The newest PBP_RESTORE_POINT_KEEP per owner are kept, at most one of them
// from an update.
//
// They live in this database only: not in chrome.storage (highlights already
// share that quota and the extension has no unlimitedStorage), not in Chrome
// Sync, not in Drive, not in the manual JSON export. Uninstalling the
// extension deletes them, so they are an undo for the user's own actions, not
// a backup.
//
// The payload is a schema-v3 backup built by the manual export's own readers
// and serializer (pbpReadHighlightBackupSource, pbpBuildHighlightBackup,
// pbpVocabAll, pbpBuildBackupSnapshot with libraryOnly), so restoring one goes
// through the ordinary import preview and pbpApplyBackupPayload.
//
// Plain script, no dependencies of its own beyond shared.js and vocab-store.js
// at call time. Loaded by options.html, library.html and the service worker
// (importScripts); nothing here touches the DOM.
// ============================================================

const PBP_RESTORE_POINT_DB = "pbp-restore-points";
// v1 (the first build) kept metadata and payload in one record in "points".
// v2 moves the metadata into its own store, so listing never reads a
// payload; "points" keeps { id, owner, payload }.
const PBP_RESTORE_POINT_DB_VERSION = 2;
const PBP_RESTORE_POINT_STORE = "points";
const PBP_RESTORE_POINT_META_STORE = "meta";
const PBP_RESTORE_POINT_KEEP = 5;
// Restoring from a point takes none: it only adds back what is missing, so
// a point taken before it could not undo it (2026-11-10 ruling). Earlier
// builds stored "restore" points; _pbpRestorePointMeta lists them as
// "import", since they were applied through the import preview.
const PBP_RESTORE_POINT_REASONS = Object.freeze(["import", "delete", "update"]);
// The top-level keys a restore point payload may have.
const PBP_RESTORE_POINT_PAYLOAD_KEYS = Object.freeze(["_schemaVersion", "_backup", "_highlights", "_highlightsOwner", "_vocabulary"]);
// How long a user action waits for its restore point. A snapshot is one
// chrome.storage read of the highlight records plus one IndexedDB index read
// of the owner's words, then one write; on a library of a few thousand words
// that finishes well inside a second. Four seconds leaves room for a cold
// IndexedDB open in a busy browser, and is still short enough that a hung
// database does not leave a Delete click looking frozen. Past the bound the
// action goes ahead and a snapshot still reading is dropped unwritten: it
// could otherwise record a library the action had already half changed. One
// whose reads finished before the bound may still be committed after it; it
// holds the state from before the action.
const PBP_RESTORE_POINT_WAIT_MS = 4000;

function _pbpRestorePointUpgrade(request, oldVersion) {
  const db = request.result;
  const tx = request.transaction;
  const points = db.objectStoreNames.contains(PBP_RESTORE_POINT_STORE)
    ? tx.objectStore(PBP_RESTORE_POINT_STORE)
    : db.createObjectStore(PBP_RESTORE_POINT_STORE, { keyPath: "id" });
  if (db.objectStoreNames.contains(PBP_RESTORE_POINT_META_STORE)) return;
  const meta = db.createObjectStore(PBP_RESTORE_POINT_META_STORE, { keyPath: "id" });
  // Owner first: every read and the prune are per owner, and createdAt is an
  // ISO string, so index order within one owner is time order.
  meta.createIndex("ownerCreated", ["owner", "createdAt"], { unique: false });
  if (oldVersion < 1) return;
  // Points written by v1: copy each one's metadata out. The payload stays
  // where it is; read only needs id, owner and payload. A record without a
  // usable owner or time could never be listed, so it is deleted.
  if (points.indexNames.contains("ownerCreated")) points.deleteIndex("ownerCreated");
  points.openCursor().onsuccess = (event) => {
    const cursor = event.target.result;
    if (!cursor) return;
    const record = cursor.value;
    if (record && typeof record.owner === "string" && record.owner &&
        typeof record.createdAt === "string" && record.createdAt) {
      meta.put(_pbpRestorePointMeta(record));
    } else cursor.delete();
    cursor.continue();
  };
}

function _pbpRestorePointOpen() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PBP_RESTORE_POINT_DB, PBP_RESTORE_POINT_DB_VERSION);
    request.onupgradeneeded = (event) => _pbpRestorePointUpgrade(request, event.oldVersion);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try { db.close(); } catch (_) {
          // swallow-ok: the connection is already going away
        }
      };
      resolve(db);
    };
    request.onblocked = () => console.warn("[restore-points] open blocked by another connection");
    request.onerror = () => reject(request.error || new Error("restore_point_open"));
  });
}

// work(stores, done): stores maps each name in storeNames to its object store.
async function _pbpRestorePointTransaction(storeNames, mode, work) {
  const db = await _pbpRestorePointOpen();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error("restore_point_abort"));
      tx.onerror = () => { /* onabort follows and carries the error */ };
      const stores = {};
      storeNames.forEach((name) => { stores[name] = tx.objectStore(name); });
      work(stores, (value) => { result = value; });
    });
  } finally {
    db.close();
  }
}

function _pbpRestorePointOwnerRange(owner) {
  // Every createdAt is an ISO string, which sorts after "" and before U+FFFF.
  return IDBKeyRange.bound([owner, ""], [owner, "\uffff"]);
}

function _pbpRestorePointMeta(record) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    reason: PBP_RESTORE_POINT_REASONS.includes(record.reason) ? record.reason : "import",
    owner: record.owner,
    extensionVersion: record.extensionVersion,
    counts: { ...record.counts },
    digest: record.digest,
  };
}

// The live personal-library owner, in the canonical form backups label
// themselves with. Never initializes the identity: a snapshot must not be
// the thing that decides which library this device uses.
async function _pbpRestorePointOwner() {
  return pbpCanonicalBackupOwner(await pbpPersonalLibraryAccount({ initialize: false }));
}

// Key order is part of the input to the digest, so it is fixed here rather
// than inherited from whatever order storage handed the records back in.
function _pbpRestorePointCanonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(_pbpRestorePointCanonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ":" + _pbpRestorePointCanonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value === undefined ? null : value);
}

async function _pbpRestorePointDigest(payload) {
  const text = _pbpRestorePointCanonicalJson({ h: payload._highlights || null, v: payload._vocabulary || null });
  const bytes = new TextEncoder().encode(text);
  if (globalThis.crypto?.subtle?.digest) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return "sha256:" + Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  // Insecure contexts have no SubtleCrypto. The digest only tells "same as
  // the newest point" apart from "different", so a 32-bit FNV-1a over the
  // same canonical text is enough there.
  let hash = 0x811c9dc5;
  for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return "fnv1a:" + hash.toString(16).padStart(8, "0") + ":" + bytes.length;
}

function _pbpRestorePointCounts(payload) {
  const rows = Object.entries(payload._highlights || {})
    .filter(([key, value]) => key !== "pbp_hl_last_color" && value && Array.isArray(value.items));
  return {
    articles: rows.length,
    highlights: rows.reduce((count, [, value]) => count + value.items.length, 0),
    vocabulary: payload._vocabulary ? payload._vocabulary.records.length : 0,
  };
}

// The owner's data, read the way the manual export reads it. Returns null
// when both kinds are empty. pbp_hl_last_color is the reader's last-used
// colour, a preference rather than library data, so it stays out.
async function _pbpRestorePointReadPayload(owner) {
  const source = await pbpReadHighlightBackupSource();
  const built = pbpBuildHighlightBackup(source, pbpBackupOwnerScope(owner));
  if (built) delete built.pbp_hl_last_color;
  const highlights = built && Object.keys(built).length ? built : null;
  const records = await pbpVocabAll(pbpDictOwnerScope(owner));
  const vocabulary = records.length ? { owner, records } : null;
  if (!highlights && !vocabulary) return null;
  return pbpBuildBackupSnapshot({}, {
    libraryOnly: true,
    highlights,
    highlightsOwner: highlights ? owner : "",
    vocabulary,
  });
}

function _pbpRestorePointId(createdAt) {
  const random = globalThis.crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return "rp-" + createdAt + "-" + random;
}

// Insert, de-duplicate, replace the update point and prune in one
// transaction over both stores, so two pages taking a point at the same
// moment cannot leave six behind, two identical ones, or two update points.
// Only metadata is read here.
function _pbpRestorePointCommit(record) {
  const meta = _pbpRestorePointMeta(record);
  return _pbpRestorePointTransaction(
    [PBP_RESTORE_POINT_META_STORE, PBP_RESTORE_POINT_STORE], "readwrite", (stores, done) => {
      const metaStore = stores[PBP_RESTORE_POINT_META_STORE];
      const pointStore = stores[PBP_RESTORE_POINT_STORE];
      const request = metaStore.index("ownerCreated").getAll(_pbpRestorePointOwnerRange(record.owner));
      request.onsuccess = () => {
        const existing = request.result || [];
        const newest = existing[existing.length - 1];
        if (newest && newest.digest === record.digest) {
          // Same content as the newest point: keep that one. If it is the
          // update point and this is a user action, it now stands for the
          // action, so the next update point must not replace it. It also
          // takes the action's time: the user looks for "the one from before
          // today's delete". It is the newest either way, so order holds.
          if (newest.reason === "update" && record.reason !== "update") {
            const relabelled = { ...newest, reason: record.reason, createdAt: record.createdAt };
            metaStore.put(relabelled);
            done(_pbpRestorePointMeta(relabelled));
          } else done(_pbpRestorePointMeta(newest));
          return;
        }
        // One update point per owner: a reload of an unpacked extension is an
        // "update" too, and a run of them must not push out the points the
        // user's own actions took.
        const replaced = record.reason === "update" ? existing.filter((row) => row.reason === "update") : [];
        const kept = existing.filter((row) => !replaced.includes(row));
        const surplus = Math.max(0, kept.length + 1 - PBP_RESTORE_POINT_KEEP);
        metaStore.add(meta);
        pointStore.add({ id: record.id, owner: record.owner, payload: record.payload });
        [...replaced, ...kept.slice(0, surplus)].forEach((row) => {
          metaStore.delete(row.id);
          pointStore.delete(row.id);
        });
        done(_pbpRestorePointMeta(meta));
      };
    });
}

// The checks the manual export and the import run (shared.js
// pbpPreflightBackupLibrary), plus the restore point's own limits: library
// sections only, no credentials. Throws on failure.
function _pbpRestorePointPreflight(payload) {
  const extra = Object.keys(payload).filter((key) => !PBP_RESTORE_POINT_PAYLOAD_KEYS.includes(key));
  if (extra.length) throw pbpBackupValueError(extra[0]);
  if (pbpCountBackupSecrets(payload) !== 0) throw pbpBackupValueError("_backup.includesSecrets");
  const prepared = pbpPreflightBackupLibrary(payload);
  if (prepared.schemaVersion !== 3 || prepared.metadata?.source !== "restore-point") {
    throw pbpBackupValueError("_backup");
  }
}

async function _pbpRestorePointCreate(reason, options) {
  if (!PBP_RESTORE_POINT_REASONS.includes(reason)) throw new TypeError("restore_point_reason");
  const owner = await _pbpRestorePointOwner();
  if (!owner) return null;
  const payload = await _pbpRestorePointReadPayload(owner);
  if (!payload) return null;
  // The reads took real round trips. If the library was switched meanwhile,
  // the data may belong to either owner, so nothing is written.
  if (await _pbpRestorePointOwner() !== owner) return null;
  if (typeof options?.shouldWrite === "function" && !options.shouldWrite()) return null;
  _pbpRestorePointPreflight(payload);
  const createdAt = payload._backup.createdAt;
  return _pbpRestorePointCommit({
    id: _pbpRestorePointId(createdAt),
    createdAt,
    reason,
    owner,
    extensionVersion: payload._backup.extensionVersion,
    counts: _pbpRestorePointCounts(payload),
    digest: await _pbpRestorePointDigest(payload),
    payload,
  });
}

// Takes a restore point of the current owner's library. Resolves to the
// point's metadata (the existing newest point when nothing changed since it),
// or null when there was nothing to keep or the point could not be taken.
// Never rejects: the user's action goes ahead either way.
async function pbpRestorePointCreate(reason, options = {}) {
  try {
    return await _pbpRestorePointCreate(reason, options);
  } catch (error) {
    // Name and message only: never words, note text or the account name.
    console.warn("[restore-points] create failed:", error?.name, error?.message);
    return null;
  }
}

// pbpRestorePointCreate with the wait bound user actions use.
function pbpRestorePointCreateBounded(reason, waitMs = PBP_RESTORE_POINT_WAIT_MS) {
  let expired = false;
  let timer = null;
  const bound = new Promise((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      console.warn("[restore-points] create failed:", "TimeoutError", "no answer within " + waitMs + "ms");
      resolve(null);
    }, waitMs);
  });
  const work = pbpRestorePointCreate(reason, { shouldWrite: () => !expired })
    .finally(() => clearTimeout(timer));
  return Promise.race([work, bound]);
}

// The owner's points, newest first. Reads the metadata store only; payloads
// are never loaded for the list.
async function pbpRestorePointList(owner) {
  const scope = pbpCanonicalBackupOwner(owner);
  if (!scope) return [];
  const rows = await _pbpRestorePointTransaction([PBP_RESTORE_POINT_META_STORE], "readonly", (stores, done) => {
    const request = stores[PBP_RESTORE_POINT_META_STORE].index("ownerCreated").getAll(_pbpRestorePointOwnerRange(scope));
    request.onsuccess = () => done(request.result || []);
  });
  return rows.map(_pbpRestorePointMeta).reverse();
}

// One point's payload, only for the owner it belongs to; null otherwise.
async function pbpRestorePointRead(id, owner) {
  const scope = pbpCanonicalBackupOwner(owner);
  if (!scope || typeof id !== "string" || !id) return null;
  const record = await _pbpRestorePointTransaction([PBP_RESTORE_POINT_STORE], "readonly", (stores, done) => {
    const request = stores[PBP_RESTORE_POINT_STORE].get(id);
    request.onsuccess = () => done(request.result || null);
  });
  return record && record.owner === scope ? record.payload : null;
}

// Deletes every point of this owner, from both stores in one transaction.
// Other owners' points stay. Resolves to the number deleted.
async function pbpRestorePointClear(owner) {
  const scope = pbpCanonicalBackupOwner(owner);
  if (!scope) return 0;
  return _pbpRestorePointTransaction(
    [PBP_RESTORE_POINT_META_STORE, PBP_RESTORE_POINT_STORE], "readwrite", (stores, done) => {
      const request = stores[PBP_RESTORE_POINT_META_STORE].index("ownerCreated").getAllKeys(_pbpRestorePointOwnerRange(scope));
      request.onsuccess = () => {
        const ids = request.result || [];
        ids.forEach((id) => {
          stores[PBP_RESTORE_POINT_META_STORE].delete(id);
          stores[PBP_RESTORE_POINT_STORE].delete(id);
        });
        done(ids.length);
      };
    });
}

// What restoring this payload would add back for the owner now: highlights
// and words that are missing, by the same rules the restore uses
// (pbpAddMissingHighlightBackupRecord; a word is missing when this owner has
// no word with its id). For the preview line only.
async function pbpRestorePointMissingCounts(payload, owner) {
  const canonical = pbpCanonicalBackupOwner(owner);
  const scope = pbpBackupOwnerScope(canonical);
  if (!scope) return null;
  let highlights = 0;
  const incoming = pbpScopeHighlightBackupImport(pbpCleanHighlightBackup(payload?._highlights), scope);
  const keys = Object.keys(incoming).filter((key) => key !== "pbp_hl_last_color");
  const stored = keys.length ? await chrome.storage.local.get(keys) : {};
  for (const key of keys) {
    const merged = pbpAddMissingHighlightBackupRecord(stored[key], incoming[key], scope);
    if (merged) highlights += merged.items.length - (Array.isArray(stored[key]?.items) ? stored[key].items.length : 0);
  }
  let vocabulary = 0;
  const records = payload?._vocabulary?.records || [];
  if (records.length) {
    const present = new Set((await pbpVocabAll(pbpDictOwnerScope(canonical))).map((word) => word.id));
    vocabulary = records.filter((record) => !present.has(record.id)).length;
  }
  return { highlights, vocabulary };
}
