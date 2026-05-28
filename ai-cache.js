// ============================================================
// Pinboard Bookmark Enhanced - AI Cache (IndexedDB backend)
// ============================================================
// Replaces chrome.storage.local-based ai_cache_* keys. Removes 5MB
// quota limit and avoids read-modify-write storage write amplification
// from the prior index-based LRU. Same call surface as ai.js's
// getAICache/setAICache; ai.js wraps these and gates on a feature flag.

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

async function pbpAiCacheGet(key) {
  try {
    const db = await _pbpAiOpenDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(_PBP_AI_STORE, "readonly");
      const req = tx.objectStore(_PBP_AI_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_) {
    return null;
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
    // LRU enforcement: count entries; if > cap, delete oldest by ts
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

async function pbpAiCacheCleanExpired(ttlMs) {
  if (!ttlMs || ttlMs <= 0) return 0;
  const now = Date.now();
  try {
    const db = await _pbpAiOpenDB();
    return await new Promise((resolve) => {
      try {
        const tx = db.transaction(_PBP_AI_STORE, "readwrite");
        const store = tx.objectStore(_PBP_AI_STORE);
        const cursorReq = store.index("ts").openCursor(IDBKeyRange.upperBound(now - ttlMs));
        let deleted = 0;
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            cursor.delete();
            deleted++;
            cursor.continue();
          } else {
            resolve(deleted);
          }
        };
        cursorReq.onerror = () => resolve(deleted);
      } catch (_) { resolve(0); }
    });
  } catch (_) {
    return 0;
  }
}

async function pbpAiCacheAllKeys() {
  try {
    const db = await _pbpAiOpenDB();
    return await new Promise((resolve) => {
      try {
        const tx = db.transaction(_PBP_AI_STORE, "readonly");
        const req = tx.objectStore(_PBP_AI_STORE).getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (_) { resolve([]); }
    });
  } catch (_) {
    return [];
  }
}
