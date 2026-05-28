# Performance Audit Phase 4 — 运行时存储/批量 (Group D)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI cache 跳出 `chrome.storage.local` 的 5MB 上限和 read-modify-write 放大开销，迁到 IndexedDB；并给批量保存的 skip-existing 路径加大账户（>5000 bookmarks）回落保护。

**Architecture:** D1（AI cache 迁 IDB）是主体——新增 `ai-cache.js` 封装所有 IDB I/O（CRUD + TTL + LRU），`ai.js` 的 `getAICache` / `setAICache` 切换为薄壳调用新模块，所有 6 处 caller 签名不变；迁移路径在 SW 启动检测 `chrome.storage.local.ai_cache_*` → 搬运到 IDB → 7 天备份到 `_aiCacheMigrationBackup`；feature flag `_useIndexedDBCache` 默认开但保留旧路径代码 14 天观察期。D2 是 1-2 行补丁——`fetchExistingUrlSet` 在 `results === 1000` 时返回 sentinel，让 caller 回落到 per-tab `posts/get`。

**Tech Stack:** Vanilla JS / IndexedDB（原生 API，无依赖）/ chrome.storage.local（旧路径保留）/ Pinboard `posts/all` + `posts/get` API

**Spec reference:** `docs/superpowers/specs/2026-05-27-perf-audit-design.md` Section 3 Group D（D1 / D2）

**Baseline reference:** Phase 3 完成后基线 `perf-after-phase3.json`（commit `8055e60`）

---

## 前置分析（现状）

| 项 | 现状 | Spec 要求 | 工作量 |
|----|------|----------|--------|
| **D1** AI cache 迁 IDB | 6 处 caller 用 `chrome.storage.local` + 手写 index + LRU + cleanup alarm | 全部迁 IDB；保留 caller 签名 | **大**：新模块 + 替换 + 迁移 + feature flag |
| **D2** batch posts/all 替代 N×posts/get | `fetchExistingUrlSet` 已用 `posts/all?results=1000` + 30 min cache | 大账户（>5000 bookmarks）回落到 per-tab `posts/get` | **小**：sentinel return + caller 回落分支 |

---

## File Structure

| 文件 | 操作 | 责任 |
|------|------|------|
| `ai-cache.js` | **创建** | IDB 封装：openDB / get / set / delete / listAll + TTL + LRU |
| `ai.js` | 修改 | `getAICache` / `setAICache` 改薄壳调用 ai-cache.js；保留旧路径代码（gated on `_useIndexedDBCache=false`） |
| `background.js` | 修改 | SW 启动加迁移 + 删 `cleanupExpiredAICache` + 删 `ai-cache-cleanup` alarm |
| `popup.html` / `options.html` / `manifest.json` | 修改 | 加载 `ai-cache.js` 在 `ai.js` 之前 |
| `popup-batch.js` | 修改 | `fetchExistingUrlSet` 返回 sentinel；caller 回落 per-tab `posts/get` |
| `perf-after-phase4.json` | 创建 | Phase 4 完成后采样 |

---

## Pre-flight

### Task 0: 创建 perf/phase-4 分支

**Files:** none

- [ ] **Step 1: 确认 main 是 Phase 3 已合并状态**

```bash
git log --oneline -1 main
```

Expected: `8055e60 test(perf): capture phase 3 after-baseline; A2 shipped, A1/A3 deferred`

- [ ] **Step 2: 创建分支**

```bash
git checkout -b perf/phase-4 main
git branch --show-current
```

Expected: `perf/phase-4`

---

## Task 1: D1.a — 创建 `ai-cache.js` IDB 模块

**Files:**
- Create: `ai-cache.js`

**Spec mapping:** D1（R2 中 ROI）首件—— IDB 封装层。本任务只产出模块，不接入。

- [ ] **Step 1: 定义期望接口**

```
- 全局函数（非 module，与 ai.js / shared.js 一致风格）：
  - pbpAiCacheGet(key) → Promise<{result, ts} | null>
  - pbpAiCacheSet(key, result, ts) → Promise<void>，包含 LRU 截断（最多 200 条）
  - pbpAiCacheDelete(key) → Promise<void>
  - pbpAiCacheCleanExpired(ttlMs) → Promise<number>，删过期，返回删除数
  - pbpAiCacheAllKeys() → Promise<string[]>，用于迁移
- DB name: pbp-ai-cache, version 1, store: entries (keyPath: key)
- entry shape: {key: string, result: any, ts: number}
- 模块内部缓存 IDBDatabase 句柄；首次打开建 store + index "ts"
- 所有方法 swallow 错误（log + 返回 null/0/[]），不让 IDB 故障打断 caller
```

- [ ] **Step 2: 写代码**

创建 `ai-cache.js`：

```javascript
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
```

- [ ] **Step 3: 语法 + commit**

```bash
node --check ai-cache.js
git add ai-cache.js
git commit -m "feat(perf): add ai-cache.js IndexedDB wrapper for AI cache backend"
```

Pre-commit hook 应静默通过。

---

## Task 2: D1.b — `ai.js` 切换薄壳调用 + feature flag

**Files:**
- Modify: `ai.js`（替换 `getAICache` / `setAICache` 实现；保留旧路径代码）
- Modify: `popup.html` / `options.html`（在 `ai.js` 之前加载 `ai-cache.js`）
- Modify: `manifest.json`（content_scripts 不动 — pinboard-style.js 不用 AI cache；SW background.js 通过 importScripts 加载）
- Modify: `background.js`（顶部 `importScripts` 加 `ai-cache.js`）

**Spec mapping:** D1（R2 中 ROI）— caller 不动，IDB 切入

- [ ] **Step 1: 在 4 个入口加载 ai-cache.js**

`popup.html`：找到 `<script defer src="ai.js"></script>`（约 line 154 区域），在它**之前**加：

```html
  <script defer src="ai-cache.js"></script>
```

`options.html`：找到 `<script defer src="ai.js">`（约 line 566 区域），在它**之前**加：

```html
<script defer src="ai-cache.js"></script>
```

`background.js`：找到 `importScripts("perf-mark.js");` `pbpMark("sw-t0");` `importScripts("i18n.js", "shared.js", "ai.js");`（Phase 0 Task 4 commit `1e4bfeb`）。在 ai.js 那个 importScripts 里加 ai-cache.js：

```javascript
importScripts("perf-mark.js");
pbpMark("sw-t0");
importScripts("i18n.js", "shared.js", "ai-cache.js", "ai.js");
pbpMark("sw-t1");
```

manifest.json `content_scripts` 不动（pinboard-style.js 不用 AI cache）。

- [ ] **Step 2: 改 `ai.js` 的 `getAICache` / `setAICache` 切换实现**

在 `ai.js` 中找到当前 `getAICache` / `setAICache`（约 line 306-341）。完全替换为：

```javascript
// ---- AI cache feature flag ----
// _useIndexedDBCache=true: route via IDB (default after Phase 4)
// _useIndexedDBCache=false: route via legacy chrome.storage.local (rollback)
// Module-level cache, invalidated on chrome.storage.onChanged
let _pbpUseIDBCache = null;
async function _pbpUseIDB() {
  if (_pbpUseIDBCache !== null) return _pbpUseIDBCache;
  try {
    const { _useIndexedDBCache = true } = await chrome.storage.local.get({ _useIndexedDBCache: true });
    _pbpUseIDBCache = !!_useIndexedDBCache;
  } catch (_) { _pbpUseIDBCache = true; }
  return _pbpUseIDBCache;
}

if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes._useIndexedDBCache) _pbpUseIDBCache = null;
  });
}

async function getAICache(url, type, cacheDuration, source) {
  const key = getCacheKey(url, type, source);
  const dur = (cacheDuration || 60) * 60 * 1000;
  if (dur === 0) return null;

  if (await _pbpUseIDB()) {
    // IDB path
    if (typeof pbpAiCacheGet !== "function") return null;
    const entry = await pbpAiCacheGet(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > dur) {
      pbpAiCacheDelete(key).catch(() => {});
      return null;
    }
    return entry.result;
  }

  // Legacy storage.local path (kept for 14-day observation window)
  const data = await chrome.storage.local.get(key);
  if (!data[key]) return null;
  const { result, timestamp } = data[key];
  if (Date.now() - timestamp > dur) {
    await chrome.storage.local.remove(key);
    _updateAICacheIndex((idx) => { delete idx[key]; return idx; });
    return null;
  }
  return result;
}

async function setAICache(url, type, result, cacheDuration, source) {
  if ((cacheDuration || 60) === 0) return;
  const key = getCacheKey(url, type, source);
  const timestamp = Date.now();

  if (await _pbpUseIDB()) {
    if (typeof pbpAiCacheSet !== "function") return;
    await pbpAiCacheSet(key, result, timestamp);
    return;
  }

  // Legacy storage.local path
  await chrome.storage.local.set({ [key]: { result, timestamp } });
  try {
    const { [AI_CACHE_INDEX_KEY]: idx = {} } = await chrome.storage.local.get(AI_CACHE_INDEX_KEY);
    idx[key] = timestamp;
    const entries = Object.entries(idx);
    if (entries.length > AI_CACHE_MAX_ENTRIES) {
      entries.sort((a, b) => a[1] - b[1]);
      const overflow = entries.length - AI_CACHE_MAX_ENTRIES;
      const evictKeys = entries.slice(0, overflow).map(([k]) => k);
      await chrome.storage.local.remove(evictKeys);
      evictKeys.forEach(k => delete idx[k]);
    }
    await chrome.storage.local.set({ [AI_CACHE_INDEX_KEY]: idx });
  } catch (_) {}
}
```

保留 ai.js 中的 `getCacheKey` / `AI_CACHE_INDEX_KEY` / `AI_CACHE_MAX_ENTRIES` / `_updateAICacheIndex` 常量和函数（旧路径仍然用）。

- [ ] **Step 3: 验证**

```bash
node --check ai.js
grep -n "getAICache\|setAICache" popup.html options.html background.js
```

Expected: ai.js 语法 OK；4 个 HTML/SW 入口都通过 `<script>` 或 importScripts 加载 `ai-cache.js`。

- [ ] **Step 4: Commit**

```bash
git add popup.html options.html background.js ai.js
git commit -m "perf(ai-cache): route getAICache/setAICache through IndexedDB with rollback flag"
```

---

## Task 3: D1.c — 迁移 + 删 cleanup alarm + backup

**Files:**
- Modify: `background.js`（SW 启动加迁移逻辑 + 删除 `cleanupExpiredAICache` 函数 + 删除 alarm）

**Spec mapping:** D1 收尾 — 把旧 chrome.storage.local 数据搬到 IDB，删冗余 cleanup 路径

- [ ] **Step 1: 加迁移函数**

在 `background.js` 的 `cleanupExpiredAICache` 函数**之前**（约 line 500-503）插入：

```javascript
// D1 Phase 4: one-time migration of legacy ai_cache_* from chrome.storage.local to IDB
async function migrateAICacheToIDB() {
  try {
    const { _aiCacheMigrationV4 = false } = await chrome.storage.local.get({ _aiCacheMigrationV4: false });
    if (_aiCacheMigrationV4) return; // already done
    if (typeof pbpAiCacheSet !== "function") return; // ai-cache.js not loaded

    const all = await chrome.storage.local.get(null);
    const backup = {};
    let migrated = 0;
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith("ai_cache_") || k === "ai_cache_index") continue;
      if (!v || typeof v !== "object" || !v.timestamp) continue;
      backup[k] = v;
      await pbpAiCacheSet(k, v.result, v.timestamp);
      migrated++;
    }
    if (migrated > 0) {
      // 7-day backup for rollback
      await chrome.storage.local.set({
        _aiCacheMigrationBackup: { entries: backup, ts: Date.now() }
      });
    }
    await chrome.storage.local.set({ _aiCacheMigrationV4: true });
    console.log(`[ai-cache] migrated ${migrated} entries to IndexedDB`);
  } catch (e) {
    console.warn("[ai-cache] migration failed:", e.message);
  }
}

// Sweep expired migration backup (7 days)
async function sweepAICacheMigrationBackup() {
  try {
    const { _aiCacheMigrationBackup } = await chrome.storage.local.get("_aiCacheMigrationBackup");
    if (!_aiCacheMigrationBackup) return;
    const ageMs = Date.now() - (_aiCacheMigrationBackup.ts || 0);
    if (ageMs > 7 * 24 * 60 * 60 * 1000) {
      await chrome.storage.local.remove("_aiCacheMigrationBackup");
      console.log("[ai-cache] migration backup swept after 7 days");
    }
  } catch (_) {}
}
```

- [ ] **Step 2: 在 SW 启动调用迁移**

找到 SW 启动处的 alarm 创建块（约 line 482）。当前：

```javascript
// Keep service worker alive + periodic tasks
chrome.alarms.create("keepalive", { periodInMinutes: 4 });
chrome.alarms.create("ai-cache-cleanup", { periodInMinutes: 60 });
chrome.alarms.create("storage-warm", { periodInMinutes: 5 });
```

改成：

```javascript
// Keep service worker alive + periodic tasks
chrome.alarms.create("keepalive", { periodInMinutes: 4 });
chrome.alarms.create("storage-warm", { periodInMinutes: 5 });

// D1 Phase 4: trigger one-time AI cache migration + sweep expired backup
migrateAICacheToIDB().catch(() => {});
sweepAICacheMigrationBackup().catch(() => {});
```

删 `chrome.alarms.create("ai-cache-cleanup", { periodInMinutes: 60 });` 那一行。

- [ ] **Step 3: 删 `cleanupExpiredAICache` alarm handler**

找到 alarm `onAlarm` listener，删 `ai-cache-cleanup` 分支：

```javascript
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") { ... }
  // DELETE this block:
  if (alarm.name === "ai-cache-cleanup") {
    cleanupExpiredAICache().catch(() => {});
  }
  // ...
});
```

- [ ] **Step 4: 删 `cleanupExpiredAICache` 函数**

定位约 line 503 起的 `async function cleanupExpiredAICache() { ... }`（spec 0 提到约 35 行）。**整个函数删除**。

注意：legacy `getAICache` / `setAICache` 路径还引用 `_updateAICacheIndex` / `AI_CACHE_INDEX_KEY` / `AI_CACHE_MAX_ENTRIES`，这些保留在 ai.js 不动。

- [ ] **Step 5: 同步加 IDB 路径的 cleanup（不通过 alarm）**

替代方案：IDB 路径在 `pbpAiCacheGet` 内 lazy 删过期（已经 in pbpAiCacheGet 调用方）。无需独立 alarm。

但也可加一个低频清理：把 `chrome.alarms.create("ai-cache-cleanup-idb", { periodInMinutes: 360 })`（6 小时）+ 在 onAlarm 里调 `pbpAiCacheCleanExpired((aiCacheDuration || 60) * 60 * 1000)`。

**实施决策**：跳过 IDB alarm。Lazy 清理（pbpAiCacheGet 内的 TTL 检查 + IDB 内置 cursor delete）已足够，避免额外 alarm 复杂度。

- [ ] **Step 6: 验证 + commit**

```bash
node --check background.js
grep -n "cleanupExpiredAICache\|ai-cache-cleanup" background.js
```

Expected: 0 hits（函数和 alarm 都已删）。

```bash
git add background.js
git commit -m "perf(ai-cache): migrate legacy cache to IndexedDB on SW startup; drop cleanup alarm"
```

---

## Task 4: D2 — batch 大账户回落

**Files:**
- Modify: `popup-batch.js`（`fetchExistingUrlSet` 返回 sentinel + caller loop 内回落 per-tab `posts/get`）

**Spec mapping:** D2（R4 中 ROI）— 已有 posts/all，缺大账户保护

- [ ] **Step 1: 定义期望行为**

```
- fetchExistingUrlSet 在 posts/all 返回 1000 条时，认为账户 > 5000，返回 null（sentinel）
- caller (batch button handler) 检测到 null：每个 tab 在写入前单独调 chrome.runtime.sendMessage 查询缓存（沿用 popup 的 get_bookmark_data 路径）
- 默认 posts/all 路径仍走（< 5000 bookmarks 用户体验不变）
```

- [ ] **Step 2: 修改 `fetchExistingUrlSet`**

`popup-batch.js` 约 line 258-274：

```javascript
async function fetchExistingUrlSet(token) {
  const cacheKey = "cached_existing_urls";
  try {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]) {
      const { urls, timestamp } = cached[cacheKey];
      if (Date.now() - timestamp < 30 * 60 * 1000) {
        return new Set(urls);
      }
    }
  } catch (_) {}
  try {
    const recentData = await (await pinboardFetch(`https://api.pinboard.in/v1/posts/all?auth_token=${token}&format=json&results=1000&meta=no`)).json();
    if (Array.isArray(recentData) && recentData.length >= 1000) {
      // D2: likely > 5000 bookmarks; bail to per-tab path to avoid false-not-existing
      console.log("[batch] account likely > 5000 bookmarks, skip-existing falls back to per-tab posts/get");
      return null;
    }
    const urls = recentData.map(p => p.href);
    await chrome.storage.local.set({ [cacheKey]: { urls, timestamp: Date.now() } });
    return new Set(urls);
  } catch (_) {
    return new Set();
  }
}
```

**Note**：阈值用 `>= 1000` 比 spec 的 ">5000" 更稳——任何接近 1000 上限的账户都可能有 1000+，无法分辨。

- [ ] **Step 3: 修改 caller 处理 null**

约 line 99-105：

```javascript
let saved = 0, failed = 0, skipped = 0, tooLong = 0;
let existingUrls = new Set();
let existingPerTabFallback = false;
if (settings.batchSkipExisting) {
  const result = await fetchExistingUrlSet(pinboardToken);
  if (result === null) {
    existingPerTabFallback = true; // > 5000 bookmarks; query per-tab
  } else {
    existingUrls = result;
  }
}
```

- [ ] **Step 4: 修改 for-loop 处理 per-tab fallback**

约 line 120-125 当前：

```javascript
if (settings.batchSkipExisting && existingUrls.has(tab.url)) {
  skipped++;
  continue;
}
```

改成：

```javascript
if (settings.batchSkipExisting) {
  let isExisting = existingUrls.has(tab.url);
  if (existingPerTabFallback) {
    // Per-tab posts/get via SW message
    try {
      const r = await chrome.runtime.sendMessage({ type: "get_bookmark_data", url: tab.url });
      if (r?.posts?.length > 0) isExisting = true;
    } catch (_) {}
  }
  if (isExisting) {
    skipped++;
    continue;
  }
}
```

- [ ] **Step 5: 验证 + commit**

```bash
node --check popup-batch.js
git add popup-batch.js
git commit -m "perf(batch): fall back to per-tab posts/get for >5000-bookmark accounts"
```

---

## Task 5: Validate — 重测 + 手测 + 更新 spec

**Files:**
- Create: `perf-after-phase4.json`
- Modify: `docs/superpowers/specs/2026-05-27-perf-audit-design.md`（追加附录 A.9）

- [ ] **Step 1: chrome-dbg 里重新加载扩展 + 唤醒 SW**

`chrome://extensions/` → "重新加载"。点扩展图标。

- [ ] **Step 2: 验证迁移已跑**

打开扩展 popup，F12 console：

```javascript
await chrome.storage.local.get(["_aiCacheMigrationV4", "_aiCacheMigrationBackup"])
```

Expected: `{_aiCacheMigrationV4: true, _aiCacheMigrationBackup: {entries:{...}, ts: ...}}`（若用户有过 AI cache）或 `{_aiCacheMigrationV4: true}`（若无 cache 数据）。

```javascript
// Open AI cache IDB to confirm entries:
const req = indexedDB.open("pbp-ai-cache");
req.onsuccess = () => {
  const tx = req.result.transaction("entries", "readonly");
  const cReq = tx.objectStore("entries").count();
  cReq.onsuccess = () => console.log("IDB AI cache entries:", cReq.result);
};
```

- [ ] **Step 3: 跑 perf-sample.mjs**

```bash
node scripts/perf-sample.mjs --ext-id aghcegglioapkbgjmbgkmkiiijccoiln \
  --only popup-warm,options-warm,pinboard-inject --runs 10 --out perf-after-phase4.json
```

Phase 4 的 AI cache 不在 perf-sample.mjs 的 measure 范围内（cache hit 是 AI 路径内的事件），所以这次采样主要确认**没有退化**。

- [ ] **Step 4: 手测 AI cache 路径**

在 popup 触发 AI summary 一次（写入 cache），再次触发同一 URL 的 AI summary（应当 cache hit）。在 console：

```javascript
// 启用 perf
await chrome.storage.local.set({ _perfEnabled: true, _perfSamples: [] });
// 然后手动操作 popup AI summary 两次
// flush
await chrome.storage.local.get("_perfSamples").then(r => console.log(r._perfSamples.filter(s => s.name.includes("ai"))));
```

观察 `ai-summary-e2e` 两次：第一次（fresh）应慢，第二次（cache hit）应快得多。Cache hit 时间应 < 50ms（IDB 路径预期 < 5ms + LLM call 时间为 0）。

- [ ] **Step 5: 验收 D2 — 手测（如方便）**

如账户有 5000+ bookmarks，跑一次批量保存（开 skip-existing）。Console 应看到 `[batch] account likely > 5000 bookmarks` 日志。如账户 < 1000，无法测此分支——可接受，回落代码有 console.log 标志。

- [ ] **Step 6: 验证 feature flag 回滚路径**

```javascript
await chrome.storage.local.set({ _useIndexedDBCache: false });
// 触发一次 AI summary 写入；应走 legacy chrome.storage.local 路径
await chrome.storage.local.get(null).then(r => console.log(Object.keys(r).filter(k => k.startsWith("ai_cache_"))));
// 应看到 ai_cache_* keys
await chrome.storage.local.set({ _useIndexedDBCache: true }); // 还原默认
```

- [ ] **Step 7: 更新 spec 附录 A.9**

在 `docs/superpowers/specs/2026-05-27-perf-audit-design.md` 附录 A.8 之后追加：

```markdown
### A.9 Phase 4 完成后基线（2026-XX-XX）

Phase 4 完成于 commits：
- D1: `<sha1>` (ai-cache.js IDB module) + `<sha2>` (ai.js shell) + `<sha3>` (migration)
- D2: `<sha4>` (batch large-account fallback)

#### 实施清单

- **D1** (R2 AI cache 迁 IDB)：✓ 三 commits 完成。Feature flag `_useIndexedDBCache` 默认 true；旧路径代码保留 14 天观察期
- **D2** (R4 batch skip-existing 大账户回落)：✓ commit `<sha4>`。posts/all 返回 ≥1000 条时 sentinel return，caller loop 内回落 per-tab posts/get

#### perf-sample 结果（确认无退化）

| measure | Phase 3 p50 | Phase 4 p50 | Δ |
|---------|------------|------------|----|
| ...（填入实测） | | | |

#### 手测 AI cache hit

第一次 AI summary 用时：<填入> ms
第二次（cache hit）：<填入> ms
hit 路径节省：~<填入> ms（IDB get + TTL check）

#### 14 天观察期后续动作

- [ ] 2026-XX-XX（14 天后）：确认无 IDB 路径 bug 上报后，删 ai.js 中 legacy chrome.storage.local 代码 + 移除 `_useIndexedDBCache` flag
- [ ] 2026-XX-XX（7 天后）：手动验证 `_aiCacheMigrationBackup` 已自动清理（由 sweepAICacheMigrationBackup）
```

- [ ] **Step 8: Commit**

```bash
git add perf-after-phase4.json
git add -f docs/superpowers/specs/2026-05-27-perf-audit-design.md
git commit -m "test(perf): capture phase 4 after-baseline; D1+D2 shipped"
```

---

## Self-Review

### 1. Spec coverage

| Spec Group D 项 | 覆盖任务 |
|---|---|
| D1 AI cache 迁 IDB | Tasks 1 + 2 + 3 |
| D1 feature flag | Task 2 Step 2 |
| D1 migration backup | Task 3 Step 1 |
| D1 sweep alarm | Task 3 Step 1 |
| D2 大账户回落 | Task 4 |

无 gap。

### 2. Placeholder scan

- 无 "TBD" / "TODO"
- Task 5 Step 7 模板里 `<sha1>` 等是 validate 阶段填入
- 无 "implement later"

### 3. Type consistency

- `pbpAiCacheGet` / `Set` / `Delete` / `CleanExpired` / `AllKeys` 命名跨任务一致
- `_pbpUseIDBCache` / `_useIndexedDBCache` 命名一致（module flag vs storage key）
- entry shape `{key, result, ts}` 跨 IDB 模块和 ai.js 一致

### 4. 任务依赖

Task 0 → Task 1 (创 IDB module，独立) → Task 2 (ai.js 切换，依赖 1) → Task 3 (迁移 + cleanup 删，依赖 2) → Task 4 (D2 batch，独立) → Task 5

可并行 1+4，但顺序简单清晰：1 → 2 → 3 → 4 → 5。

---

## Phase 4 完成的标志

- ✅ D1 三 commits 落地（IDB 模块 + ai.js 切换 + 迁移）
- ✅ D2 commit 落地
- ✅ 手测 AI cache hit < 50ms（IDB 路径快于 legacy storage 路径）
- ✅ 迁移自动跑（_aiCacheMigrationV4 flag 翻 true）
- ✅ feature flag 默认 true，但可回滚
- ✅ spec 附录 A.9 落地

## 总 Commit 数

5：3 (D1) + 1 (D2) + 1 (validate)。

## 后续

Phase 4 完成后 spec 全部实施完毕（除 A1/A3/W2/R1/R3/P5 等已标注 deferred 项）。可以进入 release v2.71 阶段。
