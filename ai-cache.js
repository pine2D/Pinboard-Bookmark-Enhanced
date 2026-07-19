// ============================================================
// Pinboard Bookmark Enhanced - AI Cache (IndexedDB backend)
// ============================================================
// Replaces chrome.storage.local-based ai_cache_* keys. Removes 5MB
// quota limit and avoids read-modify-write storage write amplification
// from the prior index-based LRU. Same call surface as ai.js's
// getAICache/setAICache; ai.js wraps these as the sole IDB-only AI-cache API.

const _PBP_AI_DB_NAME = "pbp-ai-cache";
const _PBP_AI_DB_VERSION = 1;
const _PBP_AI_STORE = "entries";
const _PBP_AI_CACHE_MAX_ENTRIES = 200;
let _pbpAiDbPromise = null;

function _pbpAiOpenDB() {
  if (_pbpAiDbPromise) return _pbpAiDbPromise;
  _pbpAiDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(_PBP_AI_DB_NAME, _PBP_AI_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(_PBP_AI_STORE)) {
        const store = db.createObjectStore(_PBP_AI_STORE, { keyPath: "key" });
        store.createIndex("ts", "ts", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  _pbpAiDbPromise.catch(() => { _pbpAiDbPromise = null; }); // allow retry
  return _pbpAiDbPromise;
}

// Read-touch throttle: bump ts on cache hits at most once per hour per
// entry. Eviction sorts by ts, but ts used to change only on writes -
// "LRU" was really write-recency, so read-hot entries that are never
// rewritten (an ask thread you reopen without asking again) were silently
// evicted by unrelated tr_/skim_ write bursts. No consumer displays
// entry.ts, so touching it is safe.
const _PBP_AI_TOUCH_MIN_AGE = 3600000;

// Fire-and-forget ts bump. Get-then-put inside ONE readwrite transaction:
// putting back the entry the caller already read would race a concurrent
// pbpAiCacheAppend from another tab (the same lost-update window that
// helper exists to close); re-reading inside the transaction keeps the
// freshest result and only refreshes ts.
function _pbpAiTouch(db, key) {
  try {
    const tx = db.transaction(_PBP_AI_STORE, "readwrite");
    const store = tx.objectStore(_PBP_AI_STORE);
    const req = store.get(key);
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        try { store.put({ key: cur.key, result: cur.result, ts: Date.now() }); } catch (_) {}
      }
    };
  } catch (_) {}
}

async function pbpAiCacheGet(key) {
  try {
    const db = await _pbpAiOpenDB();
    const entry = await new Promise((resolve) => {
      const tx = db.transaction(_PBP_AI_STORE, "readonly");
      const req = tx.objectStore(_PBP_AI_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (entry && typeof entry.ts === "number" && Date.now() - entry.ts > _PBP_AI_TOUCH_MIN_AGE) {
      _pbpAiTouch(db, key);
    }
    return entry;
  } catch (_) {
    return null;
  }
}

// LRU enforcement shared by pbpAiCacheSet/pbpAiCacheAppend: count entries;
// if over cap, delete oldest by ts. Runs in its own transaction(s) AFTER
// the write transaction resolves - an eviction race here is benign (see
// D2 checked_clean: worst case an extra recent entry is evicted, which
// just re-populates on next miss), unlike the get-then-put race
// pbpAiCacheAppend exists to close.
async function _pbpAiEvictOverflow(db) {
  const count = await new Promise((resolve) => {
    try {
      const tx = db.transaction(_PBP_AI_STORE, "readonly");
      const req = tx.objectStore(_PBP_AI_STORE).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    } catch (_) { resolve(0); }
  });
  if (count > _PBP_AI_CACHE_MAX_ENTRIES) {
    const overflow = count - _PBP_AI_CACHE_MAX_ENTRIES;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(_PBP_AI_STORE, "readwrite");
        const store = tx.objectStore(_PBP_AI_STORE);
        const cursorReq = store.index("ts").openCursor(); // ASC by ts (oldest first)
        let deleted = 0;
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && deleted < overflow) {
            cursor.delete();
            deleted++;
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => resolve();
      } catch (_) { resolve(); }
    });
  }
}

async function pbpAiCacheSet(key, result, ts) {
  try {
    const db = await _pbpAiOpenDB();
    await new Promise((resolve) => {
      const tx = db.transaction(_PBP_AI_STORE, "readwrite");
      const req = tx.objectStore(_PBP_AI_STORE).put({ key, result, ts });
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
    await _pbpAiEvictOverflow(db);
  } catch (_) {}
}

// Atomic get-then-transform-then-put, in ONE readwrite IDB transaction
// (D2-2). Unlike a separate pbpAiCacheGet()+pbpAiCacheSet() pair, this
// closes the lost-update race two tabs can hit on the same key (IndexedDB
// serializes readwrite transactions on the same store across ALL
// connections/tabs, so the get inside this transaction always sees the
// latest committed value). `transform(prevResult)` runs synchronously
// inside the transaction and returns the new `result` to store - it must
// not await or touch other stores. Used by md-ai-core.js's
// pbpAskHistAppend for ask history; degrades to a no-op on any failure
// (same swallow-all-errors contract as the rest of this file).
async function pbpAiCacheAppend(key, transform, ts) {
  try {
    const db = await _pbpAiOpenDB();
    await new Promise((resolve) => {
      const tx = db.transaction(_PBP_AI_STORE, "readwrite");
      const store = tx.objectStore(_PBP_AI_STORE);
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        let next;
        try {
          next = transform(getReq.result ? getReq.result.result : undefined);
        } catch (_) {
          resolve();
          return;
        }
        const putReq = store.put({ key, result: next, ts: ts == null ? Date.now() : ts });
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => resolve();
      };
      getReq.onerror = () => resolve();
    });
    await _pbpAiEvictOverflow(db);
  } catch (_) {}
}

async function pbpAiCacheDelete(key) {
  try {
    const db = await _pbpAiOpenDB();
    await new Promise((resolve) => {
      const tx = db.transaction(_PBP_AI_STORE, "readwrite");
      const req = tx.objectStore(_PBP_AI_STORE).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch (_) {}
}
