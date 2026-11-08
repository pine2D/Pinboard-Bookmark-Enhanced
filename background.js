// ============================================================
// Pinboard Bookmark Enhanced - Background Service Worker (v4.0)
// ============================================================

importScripts(
  "i18n.js", "shared.js", "bookmark-services.js", "vocab-store.js", "vocab-gdrive.js", "notes-sync.js", "notes-gdrive.js",
  "ai-cache.js", "dict-archive.js", "dict-archive-gdrive.js", "ask-archive.js", "ask-archive-gdrive.js", "ai.js", "jina.js", "wayback.js"
);

// Load manual language setting (async, t() falls back to browser locale until ready)
initI18n();

// 图标路径
const ICONS_DEFAULT = {
  16: "icons/pin-default-16.png", 32: "icons/pin-default-32.png",
  48: "icons/pin-default-48.png", 128: "icons/pin-default-128.png"
};
const ICONS_BOOKMARKED = {
  16: "icons/pin-saved-16.png", 32: "icons/pin-saved-32.png",
  48: "icons/pin-saved-48.png", 128: "icons/pin-saved-128.png"
};
const ICONS_TOREAD = {
  16: "icons/pin-toread-16.png", 32: "icons/pin-toread-32.png",
  48: "icons/pin-toread-48.png", 128: "icons/pin-toread-128.png"
};
const ICON_PATHS = { default: ICONS_DEFAULT, saved: ICONS_BOOKMARKED, toread: ICONS_TOREAD };

// setIcon with a path: map makes Chrome RE-FETCH all 4 PNGs from disk on every
// call. Combined with tabs.onUpdated re-firing "complete" repeatedly (and the
// keepalive keeping the SW warm to service each one), this produced a sustained
// stream of pin-default-*.png requests that dragged page loads (the options page
// showed DOMContentLoaded ~2.4s). Decode each icon to ImageData ONCE at startup so
// setIcon never touches the network; setIcon falls back to path: until ready.
const _iconImageData = { default: null, saved: null };
async function _decodeIconSet(pathMap) {
  const out = {};
  for (const size of Object.keys(pathMap)) {
    const resp = await fetch(chrome.runtime.getURL(pathMap[size]));
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    out[size] = canvas.getContext("2d").getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
  }
  return out;
}
// Lazy: an MV3 "startup" is EVERY SW wake (alarms fire ~every 4 min), and a pure
// alarm wake never calls setIcon — decoding 12 PNGs up front on each wake was
// pure waste. First setIcon call kicks the decode; until it lands, setIcon's
// path: fallback covers the gap.
let _iconDecodeStarted = false;
function _ensureIconDecode() {
  if (_iconDecodeStarted) return;
  _iconDecodeStarted = true;
  (async () => {
    try {
      const [def, bm, tr] = await Promise.all([_decodeIconSet(ICONS_DEFAULT), _decodeIconSet(ICONS_BOOKMARKED), _decodeIconSet(ICONS_TOREAD)]);
      _iconImageData.default = def;
      _iconImageData.saved = bm;
      _iconImageData.toread = tr;
    } catch (_) { /* decode failed — setIcon keeps using the path: fallback */ }
  })();
}

// URL 状态缓存
const statusCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 500;
let _pinboardAuthEpoch = 0;

function pbpCaptureBookmarkAuth(settingsOrToken) {
  const settings = typeof settingsOrToken === "object" ? settingsOrToken : {pinboardToken:settingsOrToken};
  return {...pbpBookmarkConnection(settings), epoch:_pinboardAuthEpoch};
}

function pbpBookmarkAuthEpoch() {
  return _pinboardAuthEpoch;
}

function pbpBookmarkAuthIsCurrent(auth) {
  return !!auth?.account && auth.epoch === _pinboardAuthEpoch;
}

function pbpStatusCacheGet(url, auth) {
  if (!pbpBookmarkAuthIsCurrent(auth)) return null;
  const cached = statusCache.get(url);
  return cached?.account === auth.account ? cached : null;
}

// The cached posts a form may load, or null: within the TTL, and for a
// self-hosted service only with the state an update is checked against
// (pbpBookmarkVersion). An entry from before that, in memory or restored from
// the session copy, is read again instead of loading a form that could not
// be checked.
function pbpStatusCacheFormPosts(cached, auth) {
  if (!cached || !(Date.now() - cached.timestamp < CACHE_TTL) || !Array.isArray(cached.posts)) return null;
  const selfHosted = auth?.service === "karakeep" || auth?.service === "linkding";
  if (selfHosted && !cached.posts.every((post) => typeof post?.version === "string" && post.version.startsWith(PBP_BOOKMARK_VERSION_FORM + "["))) return null;
  return cached.posts;
}

// The key MUST be the exact URL whose posts/get produced `value` — never a
// raw tracking URL's payload under its cleaned key, nor the reverse. Pinboard
// stores a bookmark under one of the two spellings only, so the other key's
// honest answer is `posts: []`; serving one across the other reports a saved
// page as new and turns the next save into an `already exists` conflict. A
// caller that wants the cleaned spelling must QUERY the cleaned spelling
// (debouncedCheck does exactly that).
function pbpStatusCacheSet(url, auth, value) {
  if (!pbpBookmarkAuthIsCurrent(auth)) return false;
  statusCache.set(url, { ...value, account: auth.account });
  cleanupStatusCache();
  pbpStatusMirrorWrite(url, auth, statusCache.get(url));
  return true;
}
function pbpStatusCacheDelete(url, auth) {
  statusCache.delete(url);
  pbpStatusMirrorWrite(url, auth, null);
}

// linkding answers live in memory only until the worker is stopped (30s idle).
// A copy in storage.session, owned by the connection and capped, lets the next
// worker answer the toolbar and the popup without asking linkding again, which
// makes the server fetch the page once more. Kept for every linkding entry the
// memory cache holds, so the copy is never older than it; dropped whole on any
// connection change or logout (invalidateBookmarkAuthState), and per URL where
// the memory entry is deleted. storage.session never reaches disk.
const PBP_STATUS_MIRROR_KEY = "_linkdingStatus";
const PBP_STATUS_MIRROR_MAX = 20;
let _statusMirrorTail = Promise.resolve();
function pbpStatusMirrorQueue(work) {
  const run = _statusMirrorTail.then(work).catch((e) => console.warn("[bookmark-status] session copy failed:", e?.name, e?.message));
  _statusMirrorTail = run;
  return run;
}
function pbpStatusMirrorWrite(url, auth, value) {
  if (auth?.service !== "linkding") return;
  const epoch = auth.epoch;
  pbpStatusMirrorQueue(async () => {
    if (epoch !== _pinboardAuthEpoch) return;
    const row = (await chrome.storage.session.get(PBP_STATUS_MIRROR_KEY))?.[PBP_STATUS_MIRROR_KEY];
    const entries = row?.account === auth.account && row.entries && typeof row.entries === "object" ? { ...row.entries } : {};
    if (value) entries[url] = value; else delete entries[url];
    const kept = Object.entries(entries).sort((a, b) => (b[1]?.timestamp || 0) - (a[1]?.timestamp || 0)).slice(0, PBP_STATUS_MIRROR_MAX);
    if (epoch !== _pinboardAuthEpoch) return;
    await chrome.storage.session.set({ [PBP_STATUS_MIRROR_KEY]: { account: auth.account, entries: Object.fromEntries(kept) } });
  });
}
function pbpStatusMirrorClear() {
  return pbpStatusMirrorQueue(() => chrome.storage.session.remove(PBP_STATUS_MIRROR_KEY));
}
// Puts a fresh copied linkding entry back into the memory cache when this
// worker has none for the URL. Never asks the server; any failure is a miss.
async function pbpStatusCacheRestore(url, auth) {
  if (auth?.service !== "linkding" || !pbpBookmarkAuthIsCurrent(auth) || statusCache.has(url)) return;
  try {
    await _statusMirrorTail;
    const row = (await chrome.storage.session.get(PBP_STATUS_MIRROR_KEY))?.[PBP_STATUS_MIRROR_KEY];
    const entry = row?.account === auth.account ? row.entries?.[url] : null;
    if (!entry || entry.account !== auth.account || !Number.isFinite(entry.timestamp) || Date.now() - entry.timestamp >= CACHE_TTL) return;
    if (!pbpBookmarkAuthIsCurrent(auth) || statusCache.has(url)) return;
    statusCache.set(url, entry);
    cleanupStatusCache();
  } catch (e) {
    console.warn("[bookmark-status] session copy read failed:", e?.name, e?.message);
  }
}

function cleanupStatusCache() {
  if (statusCache.size <= MAX_CACHE_SIZE) return;
  const entries = [...statusCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
  const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE);
  toRemove.forEach(([key]) => statusCache.delete(key));
}

// ---- P2: Cached token + invalidation ----
let _cachedToken = null;

async function getCachedToken() {
  if (_cachedToken) return _cachedToken;
  const s = await loadSettings();
  _cachedToken = s.pinboardToken || null;
  return _cachedToken;
}

async function getCurrentBookmarkAuth() {
  while (true) {
    const epoch = _pinboardAuthEpoch;
    const connection = await pbpReadBookmarkConnection();
    if (epoch === _pinboardAuthEpoch) return {...connection, epoch};
  }
}

// Reading data and Drive have a stable identity, independent of bookmark keys.
let _personalLibraryEpoch = 0;
async function getCurrentLibraryAuth() {
  while (true) {
    const epoch = _personalLibraryEpoch;
    const account = await pbpPersonalLibraryAccount();
    if (epoch === _personalLibraryEpoch) return {account, epoch};
  }
}
function pbpLibraryAuthIsCurrent(auth) {
  return !!auth?.account && auth.epoch === _personalLibraryEpoch;
}

// ---- P3: Debounce + dedup for tab switch ----
// P2.7: Per-tab debounce bucket keeps unrelated tab events from cancelling the
// focused tab's refresh. Execution-time focus checks below discard background tabs.
// _pendingChecks handles network-layer dedup, so extra scheduling is cheap.
const _checkDebounceTimers = new Map(); // tabId -> timeoutId
function _scheduleTabCheck(tabId, fn, delay) {
  const prev = _checkDebounceTimers.get(tabId);
  if (prev) clearTimeout(prev);
  _checkDebounceTimers.set(tabId, setTimeout(() => {
    _checkDebounceTimers.delete(tabId);
    fn();
  }, delay));
}
const _pendingChecks = new Map(); // auth epoch + URL -> Promise

function invalidateBookmarkAuthState() {
  _pinboardAuthEpoch++;
  _cachedToken = null;
  try { Promise.resolve(chrome.storage.session.remove("_currentTab")).catch(() => {}); } catch (_) {}
  pbpResetBookmarkStatusView();
  chrome.action.setBadgeText({ text: "" });
  updateBadge().catch(() => {});
}

// Everything the toolbar shows about bookmark status, and the lookups behind
// it, without touching the auth epoch: a connection change does both, while a
// display setting (linkding's browsing checks) only needs this half, so saves
// already on their way keep the connection they were sent with.
function pbpResetBookmarkStatusView() {
  const epoch = _pinboardAuthEpoch;
  statusCache.clear();
  _pendingChecks.clear();
  _lastIconState.clear();
  _iconPageUrl.clear();
  _lastCheckedUrl.clear();
  pbpStatusMirrorClear();
  chrome.tabs.query({}).then((tabs) => {
    if (epoch !== _pinboardAuthEpoch) return;
    for (const tab of tabs) {
      if (typeof tab?.id === "number") setIcon(tab.id, "default");
      if (tab?.active && tab.url?.startsWith("http")) _scheduleCurrentTabRefresh(tab.id, tab.url);
    }
  }).catch(() => {});
}

let _authChangeTail = Promise.resolve();
function scheduleEffectiveAuthRefresh(changes, area) {
  if (!(pbpBookmarkSettingsChanged(changes) || changes.syncApiKeys || changes.optSyncEnabled)) return;
  invalidateBookmarkAuthState();
}

async function debouncedCheck(url) {
  if (!url || !url.startsWith("http")) {
    return;
  }
  // Check if bookmark status icon is enabled. optCheckBookmarkStatus is a plain
  // key in SETTINGS_DEFAULTS, so it is invalidated by the exact same path as every
  // other setting: storage.onChanged -> pbpSettingsKeysChanged -> invalidateSettingsCache
  // (verified — no key of SETTINGS_DEFAULTS escapes that check). So when
  // _settingsCache is already warm, take the value from it instead of issuing a
  // second, redundant storage.get: this callback's own next step
  // (_writeCurrentTabMirror -> getCurrentBookmarkAuth -> getCachedToken) calls
  // loadSettings() unconditionally a few lines down, so a warm cache here can
  // never skip a settings read that would otherwise not happen. A cold cache
  // keeps today's single-key get rather than forcing a full loadSettings() read
  // this early (deliberately not calling loadSettings() itself, so a read
  // failure stays fail-open through this same catch instead of throwing).
  // This is a different judgment than extractForPreview's jinaApiKey "Fresh
  // read — do NOT use loadSettings()" comment further down: that one guards an
  // API credential handed to an outbound request moments after the user pastes
  // it into options.js, where the async gap before onChanged's invalidation
  // lands is exactly the window that matters (same class of concern as this
  // file's Pinboard-token reread-before-dispatch rule). optCheckBookmarkStatus
  // is a UI toggle driven by navigation events, not a just-edited credential;
  // a stale read here at worst runs (or skips) one icon check that self-heals
  // on the very next navigation, with no security or externally-visible cost.
  // K0: `urlClean` rides that SAME read (warm cache, or the one cold single-key
  // get widened by one key) — the query URL below has to come from the same
  // settings snapshot as the on/off decision, and no extra round-trip is spent
  // to get it. A read failure leaves the shipped defaults in place, which is
  // also what popup.js's _loadUrlCleanSettings falls back to.
  // linkding: every check makes the server fetch the page (and log its
  // address), so a tab event asks it only with "Check pages while browsing"
  // (linkdingPreload, default off) on, whatever optCheckBookmarkStatus says.
  // Off, nothing is asked and the answer is "not known" (bookmarked null):
  // the caller keeps an icon only for the page it describes (a save just
  // marked it), so an in-page route change drops a "saved" left from the
  // page before. The popup still asks on open.
  // Pinboard and Karakeep follow optCheckBookmarkStatus as before. A read
  // failure keeps the defaults: checks on, linkding preload off.
  let urlCleanSettings = SETTINGS_DEFAULTS.urlClean;
  let checkStatus = true, linkdingPreload = false;
  try {
    const read = _settingsCache || await (await getSettingsStorage()).get({ optCheckBookmarkStatus: true, linkdingPreload: false, urlClean: SETTINGS_DEFAULTS.urlClean });
    checkStatus = read.optCheckBookmarkStatus !== false;
    linkdingPreload = read.linkdingPreload === true;
    if (read.urlClean) urlCleanSettings = read.urlClean;
  } catch (e) {
    // Storage unavailable — fall through to default behavior (check enabled)
    console.warn("[bookmark-status] settings read failed:", e?.message || e);
  }
  const auth = await getCurrentBookmarkAuth();
  if (auth.service === "linkding" && !linkdingPreload) return { bookmarked: null };
  if (auth.service !== "linkding" && !checkStatus) return;
  // K0: ask Pinboard about the URL the popup SAVES under, not the raw tab URL.
  // popup.js derives _bookmarkPrefetchUrl with exactly this condition, so a page
  // reached through a utm_*/fbclid link was stored under the cleaned URL while
  // this chain kept asking about the tracked one: posts/get answered `[]` and
  // the toolbar showed a saved page as unsaved, while the popup's prefetch key
  // could never match the key this chain wrote. Accepted consequence (user
  // decision 2026-09-18): a bookmark that genuinely lives under the raw tracked
  // URL now reads as not-bookmarked. Only the query URL, the dedup key and the
  // cache key move — tab identity (_lastCheckedUrl, _getFocusedActiveTab,
  // _writeCurrentTabMirror) keeps speaking in raw tab URLs.
  const target = pbpBookmarkLookupUrl(url, urlCleanSettings);
  // The caller needs `target` to read the cache entry back: it is the only key
  // this check wrote, so reading back by the raw tab URL would find nothing.
  // bookmarked is null when a self-hosted check failed: the caller keeps the
  // icon it already shows instead of reading the failure as "not saved".
  return { bookmarked: (await _dedupedBookmarkCheck(target, auth)).bookmarked, target };
}

// Network-layer dedup for the bookmark status check, shared by the toolbar-icon
// path above and the popup's cold lookup (the lookup_bookmark handler below).
// Dedup only within one auth epoch: an older request may still settle after a
// logout/account switch, but its cache write is rejected by the epoch guard.
// Deliberately separate from debouncedCheck, which returns early when
// optCheckBookmarkStatus is off — a user who hid the toolbar state still needs
// the popup to know whether the page is saved.
// Resolves {bookmarked, failure?} (see pbpCheckBookmarkStatus): both callers
// share one request, and a self-hosted failure's cause reaches the popup
// without a second request against the same server.
function _dedupedBookmarkCheck(url, capturedAuth = null) {
  const pendingKey = _pinboardAuthEpoch + "\n" + url;
  const inFlight = _pendingChecks.get(pendingKey);
  if (inFlight) return inFlight;
  const promise = pbpCheckBookmarkStatus(url, capturedAuth);
  _pendingChecks.set(pendingKey, promise);
  return promise.finally(() => {
    if (_pendingChecks.get(pendingKey) === promise) _pendingChecks.delete(pendingKey);
  });
}

// ---- Load settings with deobfuscation (module-level cache, invalidated on storage.onChanged) ----
let _settingsCache = null;
let _settingsCacheGeneration = 0;
let _settingsCachePending = null;
async function loadSettings() {
  while (true) {
    if (_settingsCache) return _settingsCache;
    const generation = _settingsCacheGeneration;
    if (!_settingsCachePending || _settingsCachePending.generation !== generation) {
      const promise = pbpReadSettingsWithSecrets(SETTINGS_DEFAULTS).then(deobfuscateSettings);
      _settingsCachePending = { generation, promise };
    }
    const pending = _settingsCachePending;
    try {
      const settings = await pending.promise;
      if (generation !== _settingsCacheGeneration) continue;
      _settingsCache = settings;
      return settings;
    } catch (error) {
      if (generation === _settingsCacheGeneration) throw error;
    } finally {
      if (_settingsCachePending === pending) _settingsCachePending = null;
    }
  }
}
function invalidateSettingsCache() {
  _settingsCacheGeneration++;
  _settingsCache = null;
}

// F7: Track recent saves for undo via notification button.
// MV3: this worker is killed after 30s idle, so the Map alone cannot own the undo
// state — the toast outlives the worker and the button would then silently no-op.
// storage.session is the source of truth (it lives exactly as long as the browser
// session that can still show the toast); the Map is only this generation's warm
// cache. Expiry runs off a named alarm, not setTimeout, for the same reason.
const _recentSaves = new Map(); // notificationId -> { url, account, expiresAt }
const PBP_UNDO_KEY = "_undoSaves";
const PBP_UNDO_TTL = 30000;
const PBP_UNDO_ALARM = "undo-expire";
// A little past the TTL so a sweep never lands on a record that is one tick short
// of expiring (Chrome clamps alarms under 30s anyway).
const PBP_UNDO_ALARM_DELAY_MIN = (PBP_UNDO_TTL + 5000) / 60000;

function pbpUndoSessionStore() {
  try { return chrome.storage?.session || null; } catch (_) { return null; }
}

async function pbpRememberUndo(notifId, record) {
  _recentSaves.set(notifId, record);
  const store = pbpUndoSessionStore();
  if (!store) return; // memory-only fallback: undo still works while this worker lives
  try {
    const map = (await store.get(PBP_UNDO_KEY))[PBP_UNDO_KEY] || {};
    const now = Date.now();
    for (const id of Object.keys(map)) { if (!(map[id]?.expiresAt > now)) delete map[id]; }
    map[notifId] = record;
    await store.set({ [PBP_UNDO_KEY]: map });
    chrome.alarms.create(PBP_UNDO_ALARM, { delayInMinutes: PBP_UNDO_ALARM_DELAY_MIN });
  } catch (e) {
    // No secrets in the record (non-secret account + the saved URL), but log the
    // platform failure: a lost record downgrades Undo to a dead button.
    console.warn("[undo] cannot persist undo record:", e?.name, e?.message);
  }
}

// Undo is single-use: drop the record from both tiers before the network call.
// Returns null when the record is unknown (lost with an earlier worker) or expired.
async function pbpTakeUndoRecord(notifId) {
  let record = _recentSaves.get(notifId) || null;
  _recentSaves.delete(notifId);
  const store = pbpUndoSessionStore();
  if (store) {
    try {
      const map = (await store.get(PBP_UNDO_KEY))[PBP_UNDO_KEY] || {};
      if (!record) record = map[notifId] || null;
      if (map[notifId]) { delete map[notifId]; await store.set({ [PBP_UNDO_KEY]: map }); }
    } catch (e) {
      console.warn("[undo] session lookup failed:", e?.name, e?.message);
    }
  }
  if (!record) return null;
  return (record.expiresAt && record.expiresAt <= Date.now()) ? null : record;
}

// chrome.notifications.clear() returns a promise — a sync try/catch never sees its
// rejection. Await it and leave a trace (the id carries no user data).
async function pbpClearNotification(notifId) {
  try { await chrome.notifications.clear(notifId); }
  catch (e) { console.warn("[undo] notification clear failed:", e?.name, e?.message); }
}

// Alarm-driven expiry: drop timed-out records and take their toasts down, so no
// notification center keeps an Undo button that can no longer do anything.
async function pbpSweepExpiredUndo() {
  const now = Date.now();
  for (const [id, record] of _recentSaves) { if (!(record?.expiresAt > now)) _recentSaves.delete(id); }
  const store = pbpUndoSessionStore();
  if (!store) return;
  const map = (await store.get(PBP_UNDO_KEY))[PBP_UNDO_KEY] || {};
  let changed = false;
  for (const [id, record] of Object.entries(map)) {
    if (record?.expiresAt > now) continue;
    delete map[id];
    changed = true;
    await pbpClearNotification(id);
  }
  if (changed) await store.set({ [PBP_UNDO_KEY]: map });
  // A save that landed between two sweeps is still pending: schedule one more pass.
  if (Object.keys(map).length) chrome.alarms.create(PBP_UNDO_ALARM, { delayInMinutes: PBP_UNDO_ALARM_DELAY_MIN });
}

async function pbpReadFreshBookmarkAuthForAccount(account) {
  while (true) {
    const epoch = pbpBookmarkAuthEpoch();
    const query = Object.fromEntries(PBP_BOOKMARK_SETTING_KEYS.map(key => [key, SETTINGS_DEFAULTS[key]]));
    const raw = await pbpReadSettingsWithSecrets(query);
    if (epoch !== pbpBookmarkAuthEpoch()) continue;
    const auth = {...pbpBookmarkConnection(raw), epoch};
    return auth.account && auth.account === account ? auth : null;
  }
}

// An automatic auth reset may arrive after another surface replaced the token.
// Take the draft lock before the secret lock, matching pbpRunPopupDraft, so
// in-flight draft writes finish before cleanup and cannot recreate it later.
async function pbpResetPinboardAuth(expectedToken) {
  if (typeof expectedToken !== "string" || !pbpPinboardAccountFromToken(expectedToken)) {
    return { ok: false, error: "account_changed" };
  }
  try {
    return await navigator.locks.request("pbp-popup-drafts", () => pbpWithSecretStorageLock(async () => {
      const state = await pbpReadSecretSyncStateUnlocked({ persistInferredState: false });
      const area = state.optSyncEnabled && state.syncApiKeys ? chrome.storage.sync : chrome.storage.local;
      const raw = await area.get({ pinboardToken: "" });
      if ((deobfuscateKey(raw.pinboardToken) || "") !== expectedToken) {
        return { ok: false, error: "account_changed" };
      }
      const owner = pbpPinboardAccountFromToken(expectedToken);
      const prefix = "pbp-popup-draft:" + encodeURIComponent(owner) + ":";
      const rows = await chrome.storage.session.get(null);
      const keys = Object.keys(rows).filter((key) => key.startsWith(prefix) && rows[key]?.owner === owner);
      if (keys.length) await chrome.storage.session.remove(keys);
      const mainArea = state.optSyncEnabled ? chrome.storage.sync : chrome.storage.local;
      if (!(await mainArea.get({personalLibraryAccount:""})).personalLibraryAccount) {
        await mainArea.set({personalLibraryAccount:owner});
      }
      await area.set({ pinboardToken: "" });
      invalidateBookmarkAuthState();
      return { ok: true };
    }));
  } catch (e) {
    console.warn("[pinboard-auth] conditional reset failed:", e && e.name, e && e.message);
    return { ok: false, error: "storage" };
  }
}
// Conditional auth reset end

// ---- Show Chrome notification (with category filter) ----
async function showNotification(id, title, message, category, undoInfo) {
  try {
    const cats = await (await getSettingsStorage()).get({
      notifyQuickSave: true, notifyReadLater: true,
      notifyTabSet: true, notifyBatchSave: true, notifyErrors: true
    });
    if (category === "quickSave" && !cats.notifyQuickSave) return;
    if (category === "readLater" && !cats.notifyReadLater) return;
    if (category === "tabSet" && !cats.notifyTabSet) return;
    if (category === "batchSave" && !cats.notifyBatchSave) return;
    if (category === "error" && !cats.notifyErrors) return;
  } catch (_) {
    // Storage failure: default to showing the notification (least surprising)
  }
  const notifId = id + "-" + Date.now();
  const opts = { type: "basic", iconUrl: "icons/app-48.png", title, message };
  if (undoInfo) {
    opts.buttons = [{ title: t("bgUndo") }];
    // Register before the toast exists, so the button can never be clicked ahead
    // of its record. Chrome/OS notification centers keep the toast visible
    // indefinitely, so the sweep clears it once the record expires.
    await pbpRememberUndo(notifId, {
      url: undoInfo.url, account: undoInfo.account, expiresAt: Date.now() + PBP_UNDO_TTL
    });
  }
  chrome.notifications.create(notifId, opts);
}

// F7: Handle undo button click on notifications. pbpRunNotificationUndo
// lives with the delete it shares (reader bookmark workflow below).
chrome.notifications.onButtonClicked.addListener((notifId, btnIndex) => {
  if (btnIndex !== 0) return;
  return pbpRunNotificationUndo(notifId).catch((e) => console.warn("[undo] failed:", e?.name, e?.message));
});

// ---- 设置图标 ----
// Use callback form (not promise) so chrome.runtime.lastError is consumed
// inside the callback — the only Chromium-guaranteed way to mark it handled.
// Reading lastError after `await` (promise form) is too late: the unchecked
// check fires in the same microtask the promise settles, before user code runs.
// Symptoms otherwise: "Unchecked runtime.lastError: No tab with id: X"
// with Context: Unknown and Stack: :0 (anonymous function).
const _lastIconState = new Map(); // tabId -> last state string set (dedup)
// tabId -> the page (URL without its #fragment) the toolbar icon describes, or
// null once an in-page route change has moved the tab off that page. Memory
// only, like _lastIconState: it decides whether a failed self-hosted check may
// keep the icon (only for the very page it describes). No entry: the worker
// has not set this tab's icon since it started, or a new document reset it.
const _iconPageUrl = new Map();
// pageUrl: the tab URL this state is for. Omitted (the auth-change reset to
// default) leaves no record, which a failed check reads as "keep".
function setIcon(tabId, state, pageUrl) {
  if (typeof tabId !== "number" || tabId < 0) return;
  if (typeof state === "boolean") state = state ? "saved" : "default"; // legacy guard
  if (typeof pageUrl === "string") _iconPageUrl.set(tabId, _urlWithoutFragment(pageUrl));
  else _iconPageUrl.delete(tabId);
  // Dedup: skip if this tab's icon is already in the desired state. A tab that
  // re-fires onUpdated "complete" repeatedly would otherwise re-set the same icon
  // over and over — this guard eliminates that storm regardless of trigger frequency.
  if (_lastIconState.get(tabId) === state) return;
  _lastIconState.set(tabId, state);
  _ensureIconDecode(); // lazy one-shot; path: fallback below covers until it lands
  try {
    const cached = _iconImageData[state];
    const details = cached
      ? { tabId, imageData: cached }                              // in-memory, zero network
      : { tabId, path: ICON_PATHS[state] || ICONS_DEFAULT };       // fallback until decoded
    chrome.action.setIcon(details, () => { void chrome.runtime.lastError; /* consume to mark handled */ });
  } catch (_) { /* synchronous throw on invalid args — ignore */ }
}

// ---- 检查 URL 是否已收藏 (uses cached token, direct fetch for latency) ----
// The boolean view (null for a failed self-hosted check, which callers read as
// "not known to be saved" without touching the icon).
async function checkBookmarked(url, capturedAuth = null) {
  return (await pbpCheckBookmarkStatus(url, capturedAuth)).bookmarked;
}
// Resolves {bookmarked, failure?}. Pinboard folds every failure into
// bookmarked:false (lookup_bookmark's second request is how a 401 reaches the
// popup). A self-hosted failure answers bookmarked:null plus its non-secret
// cause ({reason, httpStatus}), held only in this call's result: the toolbar
// keeps its last known state, and the popup names the cause at once instead
// of asking the server again (a linkding check makes it fetch the page, up to
// one timeout per request).
async function pbpCheckBookmarkStatus(url, capturedAuth = null) {
  const auth = capturedAuth || await getCurrentBookmarkAuth();
  if (!auth.token || !auth.account) return { bookmarked: false };
  if (capturedAuth && !pbpBookmarkAuthIsCurrent(auth)) return { bookmarked: false };
  await pbpStatusCacheRestore(url, auth);
  const cached = pbpStatusCacheGet(url, auth);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return { bookmarked: cached.bookmarked };
  try {
    if (pbpSelfHostedAuth(auth)) {
      const found = await fetchExistingBookmark(url, auth.token, auth);
      if (!found.lookupFailed) return { bookmarked: !!found.exists };
      console.warn("[bookmark-status] self-hosted check failed:", found.reason, found.httpStatus);
      return { bookmarked: null, failure: { reason: found.reason, ...(Number.isInteger(found.httpStatus) ? { httpStatus: found.httpStatus } : {}) } };
    }
    const resp = await pinboardFetch(`https://api.pinboard.in/v1/posts/get?auth_token=${auth.token}&format=json&url=${encodeURIComponent(url)}`);
    if (!resp.ok) return { bookmarked: false };
    const data = await resp.json();
    const posts = data.posts || [];
    const bookmarked = posts.length > 0;
    return { bookmarked: pbpStatusCacheSet(url, auth, { bookmarked, timestamp: Date.now(), posts }) ? bookmarked : false };
  } catch (e) {
    // "Failed to fetch" is expected on network loss or API downtime — only warn for unexpected errors
    if (e?.code !== "account_changed" && !(e instanceof TypeError && /failed to fetch/i.test(e.message))) {
      console.warn("checkBookmarked error:", e);
    }
    return { bookmarked: false };
  }
}

// ---- Badge: unread count ----
async function updateBadge() {
  const s = await loadSettings();
  const auth = await getCurrentBookmarkAuth();
  if (!s.optShowBadge || !auth.token || pbpSelfHostedAuth(auth)) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  try {
    const resp = await pinboardFetch(`https://api.pinboard.in/v1/posts/all?auth_token=${auth.token}&format=json&toread=yes&results=100&meta=no`);
    const data = await resp.json();
    if (!pbpBookmarkAuthIsCurrent(auth)) return;
    const count = Array.isArray(data) ? data.length : 0;
    chrome.action.setBadgeText({ text: count > 0 ? String(count > 99 ? "99+" : count) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#4477bb" });
  } catch (_) {
    // chrome.action API failure is non-fatal — badge is informational only
  }
}

// ---- Unified save pipeline + offline queue ----

const PBP_SAVE_MODES = new Set(["create", "update", "merge", "skip", "overwrite"]);

// Each self-hosted request re-reads the selected connection and exact host grant.
// Automatic paths never prompt for permissions.
function pbpBookmarkClient(auth, alignCreatedTags) {
  return pbpCreateBookmarkServiceClient({
    service:auth.service, baseUrl:auth.baseUrl, readLaterListId:auth.readLaterListId, sharingEnabled:auth.sharingEnabled,
    alignCreatedTags,
    readLaterListName:t("bookmarkReadLaterListName"),
    // Any answered request proves this connection passes its gateway again.
    onResponseOk:() => void pbpClearOfflineQueuePause(auth.account),
    beforeRequest:async () => {
      const current = await getCurrentBookmarkAuth();
      if (!pbpBookmarkAuthIsCurrent(auth) || current.account !== auth.account || current.service !== auth.service || !current.token) throw pbpBookmarkServiceError("account_changed");
      const origin = pbpEndpointOriginPattern(current.baseUrl);
      if (!origin || !await chrome.permissions.contains({origins:[origin]})) throw pbpBookmarkServiceError("permission");
      const fresh = await getCurrentBookmarkAuth();
      if (!pbpBookmarkAuthIsCurrent(auth) || fresh.account !== auth.account || fresh.service !== auth.service || !fresh.token) throw pbpBookmarkServiceError("account_changed");
      return fresh;
    },
    saveReadLaterList:async id => {
      if (!(await pbpReadFreshBookmarkAuthForAccount(auth.account))) throw pbpBookmarkServiceError("account_changed");
      const result = await persistSettings({karakeepReadLaterListId:id, karakeepReadLaterListOwner:auth.account});
      if (!result.ok) throw pbpBookmarkServiceError("storage");
    }
  });
}
// Connect-time check: validates the gateway before any request, then reads
// one profile endpoint. Header values are never logged.
async function pbpVerifyBookmarkConnection({service, baseUrl, token, gateway}) {
  try {
    if (!["karakeep","linkding"].includes(service) || typeof token !== "string" || !token.trim()) return {ok:false,error:"invalid_request"};
    const base = pbpBookmarkEndpoint(baseUrl);
    const origin = pbpEndpointOriginPattern(base);
    if (!origin) return {ok:false,error:"invalid_request"};
    // The settings page always sends the field (null for none); a missing one is a malformed request.
    const checked = pbpBookmarkGatewayNormalize(gateway);
    if (!checked.ok) return {ok:false,error:"invalid_request"};
    const headers = checked.gateway ? checked.gateway.headers : [];
    const client = pbpCreateBookmarkServiceClient({service, baseUrl:base, beforeRequest:async () => {
      if (!await chrome.permissions.contains({origins:[origin]})) throw pbpBookmarkServiceError("permission");
      return {token, headers};
    }});
    const identity = await client.verify();
    // Read-only: an existing Read Later list of ours, for the settings page to
    // bind. Its failure never fails the connection.
    let readLaterListId = "";
    if (service === "karakeep") {
      try { readLaterListId = await client.findReadLaterList(); }
      catch (error) {
        if (typeof error?.code === "string") console.warn("[bookmark-connect] list lookup failed:", error.code, error.status);
        else console.warn("[bookmark-connect] list lookup failed:", error?.name, error?.message);
      }
    }
    return {ok:true, identity, ...(service === "karakeep" ? {readLaterListId} : {})};
  } catch (error) {
    // Product codes are already classified; keep unclassified platform failures observable.
    if (typeof error?.code !== "string") console.warn("[bookmark-connect] failed:", error?.name, error?.message);
    return {ok:false,error:error?.code || "network",status:error?.status};
  }
}
async function pbpBookmarkPostsResponse(auth, url) {
  if (!pbpSelfHostedAuth(auth)) return pinboardFetch(`https://api.pinboard.in/v1/posts/get?auth_token=${auth.token}&format=json&url=${encodeURIComponent(url)}`);
  const {bookmark, metadata} = await pbpBookmarkClient(auth).check(url);
  return {ok:true, status:200, json:async () => ({posts:bookmark ? [pbpBookmarkAsPost(bookmark)] : [], metadata})};
}
async function pbpBookmarkDeleteResponse(auth, url) {
  if (!pbpSelfHostedAuth(auth)) return pinboardFetch(`https://api.pinboard.in/v1/posts/delete?auth_token=${auth.token}&url=${encodeURIComponent(url)}&format=json`);
  const client = pbpBookmarkClient(auth);
  const bookmark = await client.lookup(url);
  if (bookmark) await client.remove(bookmark);
  return {ok:true, status:200, json:async () => ({result_code:"done"})};
}
async function pbpBookmarkTagCounts(auth) {
  if (pbpSelfHostedAuth(auth)) return Object.fromEntries((await pbpBookmarkClient(auth).tags()).map(tag => [tag.name, tag.count]));
  const resp = await pinboardFetch(`https://api.pinboard.in/v1/tags/get?auth_token=${auth.token}&format=json`);
  if (!resp.ok) throw Object.assign(new Error("bookmark_tags"), {status:resp.status});
  return resp.json();
}
function pbpBookmarkFailure(error) {
  return pbpSaveFailure(error?.code === "auth" ? "not_logged_in" : error?.code || "network", {httpStatus:error?.status, tag:error?.tag, retryAfter:error?.retryAfter});
}
// A vocabulary cache is advisory. Never use another owner's or an old device
// snapshot to choose a spelling at dispatch time.
function pbpTagVocabIsFresh(entry, account) {
  return entry?.account === account && Number.isFinite(entry.timestamp)
    && Date.now() - entry.timestamp <= PBP_TAG_VOCAB_STALE_CEILING;
}
// cached_user_tags holds the whole tag library (tens of KB for a heavy
// Pinboard user). A quick save or a batch reads it once here: its counts
// anchor the AI tag prompts and its index is handed to every delivery of that
// run, which checks owner and age again before using it.
async function pbpLoadTagVocab(account) {
  let entry;
  try { entry = (await chrome.storage.local.get("cached_user_tags"))?.cached_user_tags; }
  catch (error) {
    console.warn("[bookmark-tags] vocabulary read failed:", error?.name, error?.message);
    return { account, timestamp: undefined, counts: null, index: null };
  }
  const owned = entry?.account === account && entry?.counts ? entry : null;
  if (!owned) console.warn("[bookmark-tags] vocabulary missing for current account");
  else if (!pbpTagVocabIsFresh(owned, account)) console.warn("[bookmark-tags] vocabulary stale");
  return { account, timestamp: owned?.timestamp, counts: owned?.counts || null,
    index: owned && pbpTagVocabIsFresh(owned, account) ? pbpTagVocabIndex(owned.counts) : null };
}
async function pbpReadTagVocab(account, loaded) {
  if (loaded?.index && pbpTagVocabIsFresh(loaded, account)) return loaded.index;
  try {
    const entry = (await chrome.storage.local.get("cached_user_tags"))?.cached_user_tags;
    if (entry?.account !== account || !entry?.counts) {
      console.warn("[bookmark-tags] vocabulary missing for current account");
      return null;
    }
    if (!pbpTagVocabIsFresh(entry, account)) {
      console.warn("[bookmark-tags] vocabulary stale");
      return null;
    }
    return pbpTagVocabIndex(entry.counts);
  } catch (error) {
    console.warn("[bookmark-tags] vocabulary read failed:", error?.name, error?.message);
    return null;
  }
}
// prefetched: a duplicate check this save already made (Batch in skip mode,
// or quick save and Batch for an over-long title), used instead of asking the
// server again.
// singleFile: the popup or quick save will run SingleFile on this page after
// a create, so linkding makes no HTML snapshot of its own.
// verify: {expectedVersion}, for an update from a form the user loaded (popup,
// reader editor): the bookmark as that form loaded it (pbpBookmarkVersion).
// The duplicate check below is the read it is compared with, so checking adds
// no request. Quick save, Batch and offline replay have no loaded form and
// pass none.
async function pbpDeliverSelfHosted(intent, auth, settings, tagVocab, prefetched, singleFile = false, verify) {
  // A create or an update always sends the intent's own title, so one the
  // service cannot store stops before any request. A merge, skip or overwrite
  // sends it only when the page is not saved yet (an existing bookmark keeps
  // the server's title), which only the check below can tell.
  const sendsOwnTitle = intent.mode === "create" || intent.mode === "update";
  const titleFailure = sendsOwnTitle ? pbpBookmarkTitleFailure(intent.title, auth.service) : null;
  if (titleFailure) return {result:titleFailure, persisted:null, retryable:false};
  try {
    const lookup = prefetched || await fetchExistingBookmark(intent.url, auth.token, auth);
    // lookupFailed: nothing was written, so an interactive save can stop here
    // instead of queueing (submitSaveIntent).
    if (lookup.lookupFailed) return {result:pbpSaveFailure(lookup.reason || "lookup", {httpStatus:lookup.httpStatus, retryAfter:lookup.retryAfter}), persisted:null, retryable:lookup.retryable, lookupFailed:true};
    if ((intent.mode === "create" && lookup.exists) || (intent.mode === "update" && !lookup.exists)) return {result:pbpSaveFailure("conflict"), persisted:null, retryable:false};
    // Changed elsewhere (another device, the service's web page, Karakeep's
    // own AI tags) since the form loaded it, or a form that cannot say what it
    // loaded: nothing is written (user decision 2026-11-02). latestPost is the
    // bookmark as this check found it, so the form shows it without another
    // request; unverified marks a form that had no loaded state to compare.
    if (verify && intent.mode === "update" && lookup.post?.version !== verify.expectedVersion) {
      return {result:{...pbpSaveFailure("changed_elsewhere"), ...(typeof verify.expectedVersion !== "string" ? {unverified:true} : {}),
        ...(lookup.post ? {latestPost:lookup.post} : {})}, persisted:null, retryable:false};
    }
    const plan = pbpResolveSavePlan(intent, lookup);
    if (plan.action === "failed") return {result:plan.result, persisted:null, retryable:false};
    if (plan.action === "skip") return {result:{status:"skipped"}, persisted:pbpSkippedPersisted(plan, lookup), retryable:false};
    // Only a new bookmark's title is the page's; an existing one keeps the
    // server's own (Karakeep's may be a crawled title it never re-sends).
    // Nothing has been written yet: the check above is the only request.
    const sentTitleFailure = lookup.exists ? null : pbpBookmarkTitleFailure(plan.fields.title, auth.service);
    if (sentTitleFailure) return {result:sentTitleFailure, persisted:null, retryable:false};
    const incomingTags = pbpBookmarkParseTags(intent.tags);
    const index = await pbpReadTagVocab(auth.account, tagVocab);
    const bookmarkNames = lookup.exists ? lookup.bookmark.tags : [];
    const respectCase = settings?.optRespectTagCase === true;
    const names = pbpAlignIncomingTags(incomingTags, bookmarkNames, index, respectCase, intent.mode === "merge" && lookup.exists);
    // Only a recorded visible user choice may change sharing; merge/replay
    // against an existing bookmark preserves its current server state.
    const fields = {...plan.fields, tags:names, sharedExplicit:intent.sharedExplicit === true && auth.sharingEnabled === true && (intent.mode === "update" || !lookup.exists)};
    const alignCreatedTags = auth.service === "karakeep" ? (tags, bookmark) =>
      pbpAlignIncomingTags(tags, bookmark.tags, index, respectCase, true) : undefined;
    const result = await pbpBookmarkClient(auth, alignCreatedTags).save(fields, lookup.bookmark,
      singleFile && auth.service === "linkding" ? { htmlSnapshot: false } : {});
    if (!pbpBookmarkAuthIsCurrent(auth)) return {result:pbpSaveFailure("account_changed"), persisted:null, retryable:false};
    if (result.status === "partial") {
      pbpStatusCacheDelete(intent.url, auth);
      // Past the bookmark step the note is on the server (a create posts it,
      // an update patches it before tags and Read Later), so summary
      // ownership treats it as written while the save still reports failure.
      return {result:{status:"failed", reason:"partial", failedStep:result.failedStep, httpStatus:result.httpStatus,
        // Only this cause has copy of its own; every other one stays unnamed.
        ...(result.failedStep === "read_later" && result.error === "read_later_list" ? {error:"read_later_list"} : {})}, persisted:null, retryable:false,
        ...(result.failedStep !== "bookmark" ? {notesDelivered:{notes:fields.notes, mutation:result.mutation}} : {})};
    }
    // linkding answers an update or a create with the whole bookmark as it now
    // stands, so a form can take this as what it has loaded. Karakeep changes
    // tags and Read Later after its answer: the form loads it again instead.
    const version = auth.service === "linkding" ? pbpBookmarkAsPost(result.bookmark).version : undefined;
    return {result:{status:"saved", mutation:result.mutation, ...(version !== undefined ? {version} : {})}, persisted:{...plan.fields, private:result.bookmark.private, toread:result.bookmark.toread}, retryable:false};
  } catch (error) {
    // linkding writes a new bookmark before its tags, so a tag the server
    // could not store may have left the bookmark behind without them.
    if (error?.code === "tag_too_long") pbpStatusCacheDelete(intent.url, auth);
    return {result:pbpBookmarkFailure(error), persisted:null, retryable:pbpBookmarkFailureRetryable(error?.code)};
  }
}
// A quick save or Batch page whose title the service cannot store: it is sent
// only if the page is not saved yet (a merge, skip or overwrite keeps the
// server's title), so the server is asked. {failure} for a page not saved, else
// {lookup} ({url, account, found}) for delivery to reuse, including a check
// that got no answer (delivery queues or stops on it as for any other check).
async function pbpCheckOverlongTitle(url, title, auth) {
  const failure = pbpBookmarkTitleFailure(title, auth.service);
  const found = await fetchExistingBookmark(url, auth.token, auth);
  if (failure && !found.exists && !found.lookupFailed) return { failure };
  return { lookup: { url, account: auth.account, found } };
}
const PBP_POPUP_SAVE_MODES = new Set(["create", "update", "merge"]);

// A skip writes nothing, but its fresh lookup still says which notes the
// bookmark holds; a replayed save's summary ownership hold is settled by them.
function pbpSkippedPersisted(plan, lookup) {
  const notes = lookup?.post?.extended;
  return typeof notes === "string" ? { ...plan.fields, notes } : plan.fields;
}

// tag: the tag a self-hosted server could not store (tag_too_long). The error
// copy names it, so it travels to the outlets but is never logged.
// retryAfter: a 429's Retry-After delay in ms (pbpRetryAfterDelay).
function pbpSaveFailure(reason, { detail, httpStatus, tag, retryAfter } = {}) {
  const result = { status: "failed", reason };
  if (detail) {
    result.detail = String(detail)
      .replace(/auth_token=[^&\s]+/gi, "auth_token=[redacted]")
      .slice(0, 160);
  }
  if (Number.isInteger(httpStatus)) result.httpStatus = httpStatus;
  if (typeof tag === "string" && tag) result.tag = tag;
  if (Number.isSafeInteger(retryAfter) && retryAfter > 0) result.retryAfter = retryAfter;
  return result;
}

function validateSaveIntent(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return pbpSaveFailure("invalid");
  if (!PBP_SAVE_MODES.has(intent.mode)) return pbpSaveFailure("invalid");
  if (typeof intent.url !== "string" || typeof intent.title !== "string"
      || typeof intent.notes !== "string" || typeof intent.tags !== "string"
      || typeof intent.private !== "boolean") return pbpSaveFailure("invalid");
  try {
    const parsed = new URL(intent.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return pbpSaveFailure("invalid");
  } catch (_) {
    return pbpSaveFailure("invalid");
  }
  if (intent.sharedExplicit !== undefined && typeof intent.sharedExplicit !== "boolean") return pbpSaveFailure("invalid");
  if (intent.summary !== undefined && typeof intent.summary !== "string") return pbpSaveFailure("invalid");
  if (intent.toread !== undefined && typeof intent.toread !== "boolean") return pbpSaveFailure("invalid");
  if (intent.archive !== undefined && typeof intent.archive !== "boolean") return pbpSaveFailure("invalid");
  if (intent.time !== undefined && (typeof intent.time !== "string" || !intent.time)) return pbpSaveFailure("invalid");
  if (intent.mode === "update" && !intent.time) return pbpSaveFailure("invalid");
  if (intent.mode === "create" && intent.time !== undefined) return pbpSaveFailure("invalid");
  return null;
}

// Delivery-time merge/skip decisions always use a fresh read. statusCache remains
// a presentation cache and is refreshed only after a successful lookup.
async function fetchExistingBookmark(url, token, auth = pbpCaptureBookmarkAuth(token)) {
  try {
    if (pbpSelfHostedAuth(auth)) {
      // metadata: what linkding read from the page (popup prefill when the
      // browser's own title and description are turned off); null otherwise.
      const {bookmark, metadata} = await pbpBookmarkClient(auth).check(url);
      const posts = bookmark ? [pbpBookmarkAsPost(bookmark)] : [];
      if (!pbpStatusCacheSet(url, auth, {bookmarked:!!bookmark, timestamp:Date.now(), posts, metadata})) throw pbpBookmarkServiceError("account_changed");
      return {exists:!!bookmark, lookupFailed:false, post:posts[0] || null, bookmark};
    }

    const resp = await pinboardFetch(`https://api.pinboard.in/v1/posts/get?auth_token=${token}&format=json&url=${encodeURIComponent(url)}`);
    if (!resp.ok) {
      const httpStatus = Number.isInteger(resp.status) ? resp.status : undefined;
      const reason = httpStatus === 401 || httpStatus === 403 ? "not_logged_in" : "http";
      const retryAfter = httpStatus === 429 ? pbpRetryAfterDelay(resp.headers?.get?.("Retry-After")) : undefined;
      return {
        exists: false,
        lookupFailed: true,
        reason,
        httpStatus,
        ...(retryAfter !== undefined ? { retryAfter } : {}),
        retryable: httpStatus === 429 || httpStatus >= 500,
      };
    }
    const data = await resp.json();
    if (!Array.isArray(data?.posts)) {
      return {
        exists: false,
        lookupFailed: true,
        reason: "lookup",
        retryable: true,
      };
    }
    const posts = data.posts;
    const exists = posts.length > 0;
    const post = exists ? posts[0] : null;
    pbpStatusCacheSet(url, auth, { bookmarked: exists, timestamp: Date.now(), posts });
    return {
      exists,
      lookupFailed: false,
      post,
    };
  } catch (error) {
    if (pbpSelfHostedAuth(auth)) return {exists:false, lookupFailed:true, reason:error?.code === "auth" ? "not_logged_in" : error?.code || "lookup", httpStatus:error?.status,
      ...(error?.retryAfter !== undefined ? {retryAfter:error.retryAfter} : {}), retryable:pbpBookmarkFailureRetryable(error?.code)};
    if (error?.code === "account_changed") {
      return { exists: false, lookupFailed: true, reason: "account_changed", retryable: false };
    }
    return {
      exists: false,
      lookupFailed: true,
      reason: "lookup",
      retryable: true,
    };
  }
}

async function pbpSendResolvedPlan(plan, settings) {
  const apiUrl = buildPostsAddUri({
    token: settings.pinboardToken,
    url: plan.fields.url,
    title: plan.fields.title,
    extended: plan.fields.notes,
    tags: plan.fields.tags,
    shared: plan.fields.private ? "no" : "yes",
    toread: plan.fields.toread ? "yes" : "no",
    dt: plan.fields.time,
    replace: plan.replace,
  });
  if (apiUrl.length > POSTS_ADD_URI_BUDGET) {
    return { result: pbpSaveFailure("too_long", { detail: String(apiUrl.length) }), persisted: null, retryable: false };
  }

  let resp;
  try {
    resp = await pinboardFetch(apiUrl);
  } catch (error) {
    if (error?.code === "account_changed") {
      return { result: pbpSaveFailure("account_changed"), persisted: null, retryable: false };
    }
    return { result: pbpSaveFailure("network"), persisted: null, retryable: true };
  }

  const httpStatus = Number.isInteger(resp.status) ? resp.status : undefined;
  if (httpStatus === 409 || httpStatus === 412) {
    return { result: pbpSaveFailure("conflict", { httpStatus }), persisted: null, retryable: false };
  }
  if (resp.ok === false) {
    if (httpStatus === 401 || httpStatus === 403) {
      return { result: pbpSaveFailure("not_logged_in", { httpStatus }), persisted: null, retryable: false };
    }
    if (httpStatus === 414) {
      return { result: pbpSaveFailure("too_long", { detail: String(apiUrl.length), httpStatus }), persisted: null, retryable: false };
    }
    return {
      result: pbpSaveFailure("http", { httpStatus, retryAfter: httpStatus === 429 ? pbpRetryAfterDelay(resp.headers?.get?.("Retry-After")) : undefined }),
      persisted: null,
      retryable: httpStatus === 429 || httpStatus >= 500,
    };
  }

  let data = null;
  try { data = await resp.json(); } catch (_) { /* classified below */ }
  const code = typeof data?.result_code === "string" ? data.result_code : "";
  if (code === "done") {
    return {
      result: { status: "saved", mutation: plan.mutation },
      persisted: { ...plan.fields },
      retryable: false,
    };
  }
  if (/already\s+exists/i.test(code)) {
    return { result: pbpSaveFailure("conflict", { httpStatus }), persisted: null, retryable: false };
  }
  // No result_code at all (a portal or maintenance page answering 200, an
  // empty body): there is no Pinboard message to show, so leave detail out and
  // let every outlet use its generic copy. Log only the status and type.
  if (!code) {
    let contentType = "";
    try { contentType = String(resp.headers?.get?.("content-type") || "").slice(0, 80); } catch (_) { /* header unreadable */ }
    console.warn("[save] Pinboard answered without a result_code:", httpStatus, contentType);
  }
  return {
    result: pbpSaveFailure("api", { detail: code || undefined, httpStatus }),
    persisted: null,
    retryable: false,
  };
}

// lookup: a fresh duplicate check the caller already made for intent.url under
// this connection (Batch in skip mode). It stands in for the first read only.
// verify: an interactive update's loaded state (pbpDeliverSelfHosted). Pinboard
// has no modification stamp to compare and keeps its behaviour.
async function deliverSaveIntent(intent, settings, auth = pbpCaptureBookmarkAuth(settings), { tagVocab, lookup: prefetched, singleFile = false, verify } = {}) {
  const invalid = validateSaveIntent(intent);
  if (invalid) return { result: invalid, persisted: null, retryable: false };
  if (pbpSelfHostedAuth(auth)) return pbpDeliverSelfHosted(intent, auth, settings, tagVocab, prefetched, singleFile, verify);
  if (!settings?.pinboardToken) {
    return { result: pbpSaveFailure("not_logged_in"), persisted: null, retryable: false };
  }

  let recoveredConflict = false;
  while (true) {
    if (!pbpBookmarkAuthIsCurrent(auth)) {
      return { result: pbpSaveFailure("account_changed"), persisted: null, retryable: false };
    }
    let lookup = null;
    // overwrite pre-reads too: it replaces the tag set only, so it needs the
    // server's description, note, privacy flag and original time to send back.
    if (intent.mode === "merge" || intent.mode === "skip" || intent.mode === "overwrite") {
      lookup = prefetched && !recoveredConflict ? prefetched : await fetchExistingBookmark(intent.url, settings.pinboardToken, auth);
    }
    if (!pbpBookmarkAuthIsCurrent(auth)) {
      return { result: pbpSaveFailure("account_changed"), persisted: null, retryable: false };
    }
    // Pinboard posts/get has a whitespace-delimited tags string, with literal
    // quotes. Align only against this fresh bookmark; delivery never mints or
    // fetches a vocabulary, and merge retains every preexisting exact twin.
    const alignedIntent = lookup?.exists && typeof lookup.post?.tags === "string"
      ? { ...intent, tags: pbpAlignIncomingTags(intent.tags.split(/\s+/).filter(Boolean),
          lookup.post.tags.split(/\s+/).filter(Boolean), null, false).join(" ") }
      : intent;
    const plan = pbpResolveSavePlan(alignedIntent, lookup);
    if (plan.action === "failed") {
      return { result: plan.result, persisted: null, retryable: !!plan.retryable || !!lookup?.retryable };
    }
    if (plan.action === "skip") {
      return { result: { status: "skipped" }, persisted: pbpSkippedPersisted(plan, lookup), retryable: false };
    }

    const delivered = await pbpSendResolvedPlan(plan, settings);
    if (delivered.result.reason === "not_logged_in") {
      const current = await pbpReadFreshBookmarkAuthForAccount(auth.account);
      if (!current || current.token !== settings.pinboardToken || !pbpBookmarkAuthIsCurrent(auth)) {
        return { result: pbpSaveFailure("account_changed"), persisted: null, retryable: false };
      }
    }
    // Lookup-backed modes can now lose a race between the read and the write
    // (replace=no answered with "already exists"); one fresh retry resolves it.
    if (delivered.result.reason !== "conflict"
        || recoveredConflict
        || (intent.mode !== "merge" && intent.mode !== "skip" && intent.mode !== "overwrite")) return delivered;
    recoveredConflict = true;
  }
}

// Serialize ALL offlineQueue writes through one promise chain so concurrent handlers
// (enqueue / process / retry / popup remove+clear messages) never lose updates.
const runOfflineQueueWrite = pbpCreateRecoveringTail();
function mutateOfflineQueue(action) {
  return runOfflineQueueWrite(async () => {
    const { offlineQueue = [] } = await chrome.storage.local.get("offlineQueue");
    const next = pbpOfflineQueueReduce(offlineQueue, action);
    await chrome.storage.local.set({ offlineQueue: next });
    await pbpReleaseDroppedSummaryHolds(offlineQueue, next);
    // A replay pause must not outlive its account's last queued item (clear,
    // remove or final acknowledgement), or a later network-queued save for
    // that account would be skipped. Already on this tail: direct storage
    // calls, never pbpClearOfflineQueuePause (it would wait on this tail).
    try {
      const stored = await chrome.storage.local.get(PBP_OFFLINE_QUEUE_PAUSE_KEY);
      if (stored?.[PBP_OFFLINE_QUEUE_PAUSE_KEY] !== undefined) {
        const pause = pbpOfflineQueuePauseShape(stored[PBP_OFFLINE_QUEUE_PAUSE_KEY]);
        if (!pause || !next.some((item) => item?.account === pause.account)) await chrome.storage.local.remove(PBP_OFFLINE_QUEUE_PAUSE_KEY);
      }
    } catch (e) {
      console.warn("offline queue pause cleanup failed:", e?.name, e?.message);
    }
    // A queue the next tick has work in needs the (conditional) keepalive
    // alarm alive to drive replay; records it holds (attention, a longer rate
    // limit) do not. The tick's own release check also drops other
    // connections' and paused records. typeof-guarded: source-slice test
    // pages run this without the alarm block in scope.
    if (typeof _ensureKeepaliveAlarmOnce === "function"
        && next.some((item) => !pbpOfflineQueueHeld(item, Date.now() + KEEPALIVE_PERIOD_MIN * 60000))) _ensureKeepaliveAlarmOnce();
    return next;
  });
}

function newOfflineQueueId() {
  return Date.now() + "-" + Math.random().toString(36).slice(2, 9);
}

async function readOfflineQueueWithIds() {
  return runOfflineQueueWrite(async () => {
    let { offlineQueue = [] } = await chrome.storage.local.get("offlineQueue");
    if (!Array.isArray(offlineQueue)) offlineQueue = [];
    const prefix = newOfflineQueueId();
    let changed = false;
    const next = offlineQueue.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      let migrated = item;
      if (!item.queueId) {
        migrated = { ...migrated, queueId: `${prefix}-${index}` };
        changed = true;
      }
      if (Object.prototype.hasOwnProperty.call(item, "token")) {
        const storedAccount = typeof item.account === "string" ? item.account : "";
        const account = storedAccount || pbpPinboardAccountFromToken(item.token);
        migrated = { ...migrated, ...(account ? { account } : {}) };
        delete migrated.token;
        changed = true;
      }
      return migrated;
    });
    if (changed) {
      await chrome.storage.local.set({ offlineQueue: next });
      offlineQueue = next;
    }
    return Array.isArray(offlineQueue) ? offlineQueue : [];
  });
}

async function enqueueOfflineSave(params) {
  const queueId = newOfflineQueueId();
  await mutateOfflineQueue({ kind: "enqueue", item: { ...params, queuedAt: Date.now(), queueId } });
  return queueId;
}

function normalizeOfflineSaveIntent(item, settings) {
  const hasStoredMode = Object.prototype.hasOwnProperty.call(item || {}, "mode");
  const legacyMode = settings?.bgSaveMode === "skip" || settings?.bgSaveMode === "overwrite"
    ? settings.bgSaveMode
    : "merge";
  return {
    mode: hasStoredMode ? item.mode : legacyMode,
    url: typeof item?.url === "string" ? item.url : "",
    title: typeof item?.title === "string" ? item.title : "",
    notes: typeof item?.notes === "string" ? item.notes : "",
    // Missing stays missing: the save then leaves the Description to linkding.
    ...(item?.summary !== undefined ? { summary: item.summary } : {}),
    ...(item?.sharedExplicit !== undefined ? { sharedExplicit: item.sharedExplicit } : {}),
    tags: typeof item?.tags === "string" ? item.tags : "",
    private: item?.private === true,
    toread: item?.toread === true || item?.toread === "yes",
    archive: typeof item?.archive === "boolean" ? item.archive : undefined,
    time: typeof item?.time === "string" && item.time ? item.time : undefined,
  };
}

// pinboardFetch serializes request starts, not the lookup-to-write transaction.
// This tail protects that complete transaction for both live saves and replay.
const runSaveDeliveryTransaction = pbpCreateRecoveringTail();

async function applySaveResultSideEffects(envelope, settings, {
  deferBadge = false,
  auth = pbpCaptureBookmarkAuth(settings),
} = {}) {
  const { result, persisted } = envelope || {};
  if (!persisted || (result?.status !== "saved" && result?.status !== "skipped")) return;

  try {
    const cachedPosts = result.status === "skipped" ? pbpStatusCacheGet(persisted.url, auth)?.posts : undefined;
    const cacheUpdated = pbpStatusCacheSet(persisted.url, auth, {
      bookmarked: true,
      timestamp: Date.now(),
      toreadHint: persisted.toread === true,           // display stub — posts only ever come from a real posts/get response
      ...(cachedPosts ? { posts: cachedPosts } : {}),
    });
    if (cacheUpdated) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (pbpBookmarkAuthIsCurrent(auth) && tab?.id && pbpSameBookmark(tab.url, persisted.url)) {
        setIcon(tab.id, iconStateFor(pbpStatusCacheGet(persisted.url, auth)), tab.url);
      }
    }
  } catch (_) { /* status/icon are best-effort */ }

  if (result.status !== "saved") return;
  if (!deferBadge) {
    try { Promise.resolve(updateBadge()).catch(() => {}); } catch (_) {}
  }
  try {
    Promise.resolve(pbpWaybackArchive(persisted.url, settings, {
      isPrivate: persisted.private === true,
      override: persisted.archive,
    })).catch(() => {});
  } catch (_) { /* accepted save is never requeued for a side-effect failure */ }
}

function queueRecordFromSaveIntent(intent, token, service) {
  return {
    account: pbpPinboardAccountFromToken(token),
    mode: intent.mode === "create" ? "merge" : intent.mode,
    url: intent.url,
    title: intent.title,
    notes: intent.notes,
    // Only a linkding Description is a queue field (Karakeep's summary is the
    // server's own text). An unknown one (undefined) adds no field; "" is a
    // known empty one.
    ...(service === "linkding" && intent.summary !== undefined ? { summary: intent.summary } : {}),
    ...(intent.sharedExplicit !== undefined ? { sharedExplicit: intent.sharedExplicit } : {}),
    tags: intent.tags,
    private: intent.private,
    toread: intent.toread,
    archive: intent.archive,
    time: intent.time,
  };
}

// ---- AI summary ownership (receipts and holds live in ai-cache.js) ----
// The popup can replace or remove an AI summary block in place only while a
// receipt says where it sits in the bookmark's notes. Every save path hands
// the worker that block's [start, end) range in the notes it submits
// (summaryRange: undefined = nothing to say, null = these notes hold no block
// the caller owns), and the worker records it only once those notes were
// delivered. A delivery that kept the server's notes (merge or overwrite of
// an existing bookmark, skip) leaves receipts alone: they still describe
// those notes, and the popup retires one as soon as its hash stops matching.
// linkding keeps summaries in Description, never in notes. Bookkeeping only:
// failures are logged and never change a save's outcome. typeof-guarded:
// source-slice test pages run this region without ai-cache.js.

// What the bookmark's notes hold once a delivery is done, as far as that
// delivery knows: the notes a save wrote or kept (also a Karakeep save that
// failed after its bookmark step), or the ones a skip's fresh lookup found.
// null when it does not know, and for linkding. `submitted`:
// these are the notes the caller submitted, not the server's own that a
// merge, overwrite or skip of an existing bookmark kept.
function pbpSummaryNotesAfterDelivery(intent, envelope, auth) {
  if (auth?.service === "linkding") return null;
  const status = envelope?.result?.status;
  const after = status === "saved" ? { notes: envelope.persisted?.notes, mutation: envelope.result.mutation }
    : status === "skipped" ? { notes: envelope.persisted?.notes, mutation: "kept" }
    : envelope?.notesDelivered;
  if (typeof after?.notes !== "string") return null;
  // Karakeep leaves an empty note out of a create, so a create merged into a
  // concurrent bookmark keeps that bookmark's note, which this save never saw.
  if (auth?.service === "karakeep" && after.mutation === "merged" && !after.notes) return null;
  const submitted = after.mutation !== "kept"
    && (intent.mode === "create" || intent.mode === "update" || after.mutation !== "updated");
  return { notes: after.notes, submitted };
}

// A live save records the caller's range only for notes it wrote as
// submitted. Server notes that merely equal them byte for byte may have been
// typed anywhere, so a merge, overwrite or skip that kept them changes nothing.
async function pbpRecordSummaryOwnership(intent, envelope, auth, range) {
  if (range === undefined || typeof pbpAiSaveSummaryOwnership !== "function") return;
  const after = pbpSummaryNotesAfterDelivery(intent, envelope, auth);
  if (!after?.submitted || after.notes !== intent.notes) return;
  try { await pbpAiSaveSummaryOwnership(auth.account, intent.url, after.notes, range); }
  catch (e) { console.warn("summary ownership receipt failed:", e?.name, e?.message); }
}

// A save queued offline has delivered nothing yet; it holds its range under
// its queue ID (never in the queue record) until a replay settles it.
async function pbpHoldSummaryOwnership(queueId, intent, auth, range) {
  if (!range || auth?.service === "linkding" || typeof pbpAiHoldSummaryOwnership !== "function") return;
  try { await pbpAiHoldSummaryOwnership(queueId, auth.account, intent.url, intent.notes, range); }
  catch (e) { console.warn("summary ownership hold failed:", e?.name, e?.message); }
}

// Replay: the hold is this save's own record of the notes it submitted, so it
// becomes the receipt whenever the bookmark now holds exactly those notes,
// whatever the mode: a first attempt that wrote them but lost its answer
// (timeout, dropped connection, 5xx after the write) leaves the replay to find
// and keep them. The claim checks the held owner, page, range and hash; any
// other saved or skipped outcome only consumes the hold. A failure that wrote
// nothing keeps it, as the queue keeps the record.
async function pbpSettleSummaryOwnershipHold(queueId, intent, envelope, auth) {
  if (typeof pbpAiClaimSummaryOwnership !== "function") return;
  const after = pbpSummaryNotesAfterDelivery(intent, envelope, auth);
  const status = envelope?.result?.status;
  if (!after && status !== "saved" && status !== "skipped") return;
  try {
    if (after) await pbpAiClaimSummaryOwnership(queueId, auth.account, intent.url, after.notes);
    else await pbpAiReleaseSummaryOwnership(queueId);
  } catch (e) {
    console.warn("summary ownership hold failed:", e?.name, e?.message);
  }
}

// Saves that leave the queue any other way (removed or cleared by the user,
// cancelled by a reader delete) drop their holds. Acknowledged replays were
// settled before their removal, so deleting their key again is a no-op.
async function pbpReleaseDroppedSummaryHolds(before, after) {
  if (!Array.isArray(before) || typeof pbpAiReleaseSummaryOwnership !== "function") return;
  const kept = new Set((Array.isArray(after) ? after : []).map((item) => item?.queueId));
  for (const item of before) {
    const queueId = item?.queueId;
    if (typeof queueId !== "string" || !queueId || kept.has(queueId)) continue;
    try { await pbpAiReleaseSummaryOwnership(queueId); }
    catch (e) { console.warn("summary ownership hold release failed:", e?.name, e?.message); }
  }
}

// interactive: a popup save; a reader save (readerAction) is one too. Their
// self-hosted duplicate check failing stops the save (pbpLookupStopFailure).
// lookup: {url, account, found} from a duplicate check the caller made before
// paying for AI (Batch in skip mode); used only for that URL and account.
// SingleFile for Chrome (the ID linkding's own extension sends to). It saves
// the tab that is current for it, and uploads the page to linkding itself if
// the user set that up there; this extension never handles the page file.
// Messaging another extension needs no permission.
const PBP_SINGLEFILE_EXTENSION_ID = "mpiodijhokgodhhofbcjdecpffjipkle";
// SingleFile may answer only once it has saved and uploaded the page, or not
// at all; linkding's own extension does not wait. A reply this late counts as
// delivered: the message reached a listener that kept it.
const PBP_SINGLEFILE_REPLY_MS = 1500;
// singleFileTab: {id, url} of the tab the save came from, its address as the
// tab showed it (before any tracking-parameter cleaning). It is still the page
// SingleFile would save while the focused window's active tab is that tab at
// that address (a #fragment aside). Compared raw, not as cleaned bookmark URLs:
// the save cleaned its URL with the user's own settings, so a cleaned address
// can differ from the tab's while the tab still shows the saved page.
function pbpSingleFileTabValid(singleFileTab) {
  return Number.isInteger(singleFileTab?.id) && typeof singleFileTab.url === "string" && !!singleFileTab.url;
}
async function pbpSingleFileTabCurrent(singleFileTab) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id === singleFileTab.id && typeof tab.url === "string"
      && tab.url.split("#")[0] === singleFileTab.url.split("#")[0];
  } catch (e) {
    console.warn("[singlefile] current tab read failed:", e?.name, e?.message);
    return false;
  }
}
// "sent", "skipped" (the saved page is no longer the focused window's active
// tab, so SingleFile would save another page) or "failed" (not installed, or
// it refused). Logs name the outcome only, never the address.
async function pbpRunSingleFile(singleFileTab) {
  if (!await pbpSingleFileTabCurrent(singleFileTab)) {
    console.warn("[singlefile] the saved page is no longer the current tab; not run");
    return "skipped";
  }
  let timer;
  try {
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve("late"), PBP_SINGLEFILE_REPLY_MS); });
    const answer = await Promise.race([chrome.runtime.sendMessage(PBP_SINGLEFILE_EXTENSION_ID, "save-page").then(() => "answered"), late]);
    if (answer === "late") console.warn("[singlefile] no answer yet; counted as delivered");
    return "sent";
  } catch (e) {
    // A listener that took the message without answering still received it.
    if (/message port closed before a response was received/i.test(String(e?.message || ""))) return "sent";
    console.warn("[singlefile] no response:", e?.name, e?.message);
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

// singleFileTab: {id, url} of the tab the popup or quick save saves from, only
// when the form holds that tab's page. With linkding's SingleFile switch on and
// that tab still showing the page, a create asks for no server snapshot and
// SingleFile then saves the tab (pbpRunSingleFile); every other save leaves it
// out. SingleFile runs after the save transaction, so a slow answer never holds
// the saves queued behind this one.
// verify: {expectedVersion} for an update made from a loaded form (popup, reader editor).
function submitSaveIntent(intent, { deferBadge = false, expectedAccount = "", readerAction = "", readerDraft = null, readerExpectBookmarked = false, summaryRange, tagVocab, interactive = false, lookup, singleFileTab, verify } = {}) {
  let singleFileRun = false;
  return runSaveDeliveryTransaction(async () => {
    let settings;
    try { settings = await loadSettings(); }
    catch (e) {
      console.warn("save intent failed:", e?.name, e?.message);
      return pbpSaveFailure("internal");
    }
    let deliveryAuth;
    try { deliveryAuth = await getCurrentBookmarkAuth(); }
    catch (e) {
      console.warn("save intent failed:", e?.name, e?.message);
      return pbpSaveFailure("internal");
    }
    const deliveryAccount = pbpBookmarkConnection(settings).account;
    if (!deliveryAuth.token) return pbpSaveFailure("not_logged_in");
    if (expectedAccount && deliveryAuth.account !== expectedAccount) {
      return pbpSaveFailure("account_changed");
    }
    if (deliveryAccount && deliveryAuth.account !== deliveryAccount) {
      return pbpSaveFailure("internal");
    }
    const deliverySettings = pbpBookmarkDeliverySettings(settings, deliveryAuth);

    // A caller's range describes the notes it submitted.
    let ownershipRange = summaryRange;
    let readerKept = null;
    // Reader edits/flag changes resolve server metadata inside this same
    // lookup-to-write transaction. The offline record remains a normal intent.
    if (readerAction) {
      const handedNotes = intent.notes;
      const prepared = await pbpPrepareReaderSaveIntent(intent, readerAction, readerDraft, deliverySettings, deliveryAuth, readerExpectBookmarked);
      if (prepared.result) return prepared.result;
      intent = prepared.intent;
      // The popup's handed range still describes a create, and a Save's skip,
      // which creates the bookmark when it is not there yet: either writes
      // exactly the handed notes or nothing. An update writes the server's
      // notes or the reader editor's, and a skip that found the bookmark
      // already in the requested state (kept) can only keep it. The range
      // cannot be followed through those, and a hold for it would later claim
      // text the worker never wrote.
      if (prepared.kept || (intent.mode !== "create" && intent.mode !== "skip") || intent.notes !== handedNotes) ownershipRange = undefined;
      if (prepared.kept) {
        const skip = pbpResolveSavePlan(intent, prepared.lookup);
        if (skip.action === "skip") readerKept = { result: { status: "skipped" }, persisted: pbpSkippedPersisted(skip, prepared.lookup), retryable: false };
      }
    }

    // The tab is checked before the create too: a page the user already left
    // keeps linkding's own snapshot instead of getting neither.
    let singleFile = !readerAction && pbpSingleFileTabValid(singleFileTab) && deliveryAuth.service === "linkding"
      && settings.linkdingSingleFile === true;
    if (singleFile && !await pbpSingleFileTabCurrent(singleFileTab)) {
      console.warn("[singlefile] the page is no longer the current tab; linkding keeps its own snapshot");
      singleFile = false;
    }
    // A reader action that found the bookmark already in its state (kept)
    // finishes on that lookup's skip: nothing is delivered or queued.
    let envelope = readerKept;
    if (!envelope) {
      const prefetched = !readerAction && lookup?.found && lookup.url === intent.url && lookup.account === deliveryAuth.account
        ? lookup.found : undefined;
      try { envelope = await deliverSaveIntent(intent, deliverySettings, deliveryAuth, { tagVocab, lookup: prefetched, singleFile, verify }); }
      catch (e) {
        console.warn("save intent failed:", e?.name, e?.message);
        return pbpSaveFailure("internal");
      }
    }

    if (envelope.result.status === "saved" || envelope.result.status === "skipped") {
      await pbpRecordSummaryOwnership(intent, envelope, deliveryAuth, ownershipRange);
      await applySaveResultSideEffects(envelope, deliverySettings, { deferBadge, auth: deliveryAuth });
      if (envelope.result.status !== "saved" || envelope.result.mutation !== "created") return envelope.result;
      // Only a new bookmark: an update, merge or skip already has its page.
      singleFileRun = singleFile;
      return { ...envelope.result, account: deliveryAuth.account };
    }
    // The user is looking at the form: a self-hosted duplicate check that got
    // no answer stops here, before anything is written or queued (user
    // decision 2026-11-02). Quick save and Batch keep their own handling.
    if ((interactive || readerAction) && envelope.lookupFailed && pbpSelfHostedAuth(deliveryAuth)) {
      return pbpLookupStopFailure(envelope.result);
    }
    // A Karakeep save that failed after its bookmark step wrote the note.
    if (envelope.notesDelivered) await pbpRecordSummaryOwnership(intent, envelope, deliveryAuth, ownershipRange);
    if (!envelope.retryable || !deliverySettings.offlineQueueEnabled) return envelope.result;
    // A reader flag-only update carries freshly read server metadata solely
    // to preserve it during this dispatch. Replaying that snapshot later
    // could overwrite another client's newer notes/privacy; require a retry
    // that re-reads the bookmark instead of queueing the resolved update.
    if ((readerAction === "read" || readerAction === "later") && intent.mode === "update") return envelope.result;

    try {
      const queueId = await enqueueOfflineSave({...queueRecordFromSaveIntent(intent, deliverySettings.pinboardToken, deliveryAuth.service), account:deliveryAuth.account});
      await pbpHoldSummaryOwnership(queueId, intent, deliveryAuth, ownershipRange);
      // cause lets the popup say why: Pinboard answered 429/5xx ("server")
      // or the request never got an HTTP answer ("network").
      const cause = Number.isInteger(envelope.result?.httpStatus) ? "server" : "network";
      return { status: "queued", queueId, cause };
    } catch (_) {
      return pbpSaveFailure("storage");
    }
  }).then(async (result) => (singleFileRun ? { ...result, singleFile: await pbpRunSingleFile(singleFileTab) } : result));
}

function sendOfflineItem(item) {
  return runSaveDeliveryTransaction(async () => {
    let settings;
    try { settings = await loadSettings(); }
    catch (e) {
      console.warn("save intent failed:", e?.name, e?.message);
      return { result: pbpSaveFailure("internal"), persisted: null, retryable: false, settings: {} };
    }
    let deliveryAuth;
    try { deliveryAuth = await getCurrentBookmarkAuth(); }
    catch (e) {
      console.warn("save intent failed:", e?.name, e?.message);
      return { result: pbpSaveFailure("internal"), persisted: null, retryable: false, settings };
    }
    const token = pbpSelfHostedAuth(deliveryAuth)
      ? (item.account === deliveryAuth.account ? deliveryAuth.token : "")
      : pbpResolveOfflineQueueToken(deliveryAuth.token, item);
    if (!token) {
      const reason = deliveryAuth.token ? "account_mismatch" : "not_logged_in";
      return { result: pbpSaveFailure(reason), persisted: null, retryable: false, settings };
    }
    const deliverySettings = pbpBookmarkDeliverySettings(settings, deliveryAuth);
    const intent = normalizeOfflineSaveIntent(item, settings);
    let envelope;
    try { envelope = await deliverSaveIntent(intent, deliverySettings, deliveryAuth); }
    catch (e) {
      console.warn("save intent failed:", e?.name, e?.message);
      envelope = { result: pbpSaveFailure("internal"), persisted: null, retryable: false };
    }
    await pbpSettleSummaryOwnershipHold(item.queueId, intent, envelope, deliveryAuth);
    return { ...envelope, mode: intent.mode, settings: deliverySettings, auth: deliveryAuth };
  });
}

// A popup save that was queued offline keeps its session draft until the
// popup sees a "saved" result, which it never does for a replay. Once the
// replay lands, drop the draft rows of that owner and address, but only a row
// that still holds what was queued: a newer edit of the same page survives,
// including one to the Description or a checkbox. The address is the form's
// (draft.url), which is the cleaned one the queue holds; the row's pageUrl is
// the tab's and may still carry tracking parameters. Keeping a row is the safe
// side. Draft key format and owner checks are pbpRunPopupDraft's; same lock order.
async function pbpClearReplayedPopupDraft(item) {
  const account = typeof item?.account === "string" ? item.account : "";
  const url = typeof item?.url === "string" ? item.url : "";
  if (!account || !url) return;
  const names = (text) => {
    try {
      return (pbpBookmarkAccountService(account) === "pinboard"
        ? String(text || "").split(/\s+/).filter(Boolean) : pbpBookmarkParseTags(text)).map((n) => n.toLowerCase()).sort();
    } catch (_) { return null; }
  };
  const holdsQueued = (draft) => {
    if (!draft || draft.url !== url || typeof draft.tagInput !== "string" || draft.tagInput.trim()) return false;
    const queued = names(item.tags);
    const drafted = Array.isArray(draft.tags) ? draft.tags.map((n) => String(n).toLowerCase()).sort() : null;
    const queuedToread = item.toread === true || item.toread === "yes";
    return !!queued && !!drafted && draft.title === (item.title || "") && draft.notes === (item.notes || "")
      && queued.join("\n") === drafted.join("\n")
      && (draft.summary === undefined || pbpBookmarkDescriptionText(draft.summary) === pbpBookmarkDescriptionText(item.summary))
      && draft.private === (item.private === true) && draft.toread === queuedToread
      && (draft.sharedExplicit === true) === (item.sharedExplicit === true)
      && (!draft.archiveTouched || draft.archive === item.archive);
  };
  try {
    await navigator.locks.request("pbp-popup-drafts", async () => {
      if ((await getCurrentBookmarkAuth()).account !== account) return;
      const prefix = "pbp-popup-draft:" + encodeURIComponent(account) + ":";
      const rows = await chrome.storage.session.get(null);
      if ((await getCurrentBookmarkAuth()).account !== account) return;
      const keys = Object.keys(rows).filter((key) => key.startsWith(prefix) && rows[key]?.owner === account
        && holdsQueued(rows[key]?.draft));
      if (keys.length) await chrome.storage.session.remove(keys);
    });
  } catch (e) {
    console.warn("[popup-draft] clearing a replayed draft failed:", e && e.name, e && e.message);
  }
}

// Connection-level replay pause. A gateway, a rejected token or a missing host
// grant that failed a queued item (PBP_BOOKMARK_STOP_CODES) will fail the rest
// of that connection's items too, so automatic replay skips
// the account until it reconnects, any request for it succeeds, or the user
// retries by hand. A separate non-secret local key: queue records keep only
// their listed fields. Runs on the queue's write tail; storage failures are
// logged and swallowed (the pause is advisory, the queue stays intact).
const PBP_OFFLINE_QUEUE_PAUSE_KEY = "offlineQueuePause";
function pbpOfflineQueuePauseShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { account, reason, ts } = value;
  if (typeof account !== "string" || !account || typeof reason !== "string" || !reason || !Number.isFinite(ts)) return null;
  return { account, reason, ts };
}
function pbpReadOfflineQueuePause() {
  return runOfflineQueueWrite(async () => {
    const stored = await chrome.storage.local.get(PBP_OFFLINE_QUEUE_PAUSE_KEY);
    return pbpOfflineQueuePauseShape(stored?.[PBP_OFFLINE_QUEUE_PAUSE_KEY]);
  }).catch((e) => {
    console.warn("offline queue pause read failed:", e?.name, e?.message);
    return null;
  });
}
function pbpSetOfflineQueuePause(account, reason) {
  return runOfflineQueueWrite(async () => {
    await chrome.storage.local.set({ [PBP_OFFLINE_QUEUE_PAUSE_KEY]: { account, reason, ts: Date.now() } });
  }).catch((e) => console.warn("offline queue pause write failed:", e?.name, e?.message));
}
// "" clears any pause; an account clears only its own. Reads first so the
// per-request success signal does not write (or fire onChanged) when idle.
function pbpClearOfflineQueuePause(account = "") {
  return runOfflineQueueWrite(async () => {
    const stored = await chrome.storage.local.get(PBP_OFFLINE_QUEUE_PAUSE_KEY);
    const current = stored?.[PBP_OFFLINE_QUEUE_PAUSE_KEY];
    if (current === undefined) return;
    const pause = pbpOfflineQueuePauseShape(current);
    if (account && pause && pause.account !== account) return;
    await chrome.storage.local.remove(PBP_OFFLINE_QUEUE_PAUSE_KEY);
  }).catch((e) => console.warn("offline queue pause clear failed:", e?.name, e?.message));
}
// A new self-hosted credential envelope (this device or synced in) is a reconnect.
function pbpOfflinePauseOnCredentialChange(changes) {
  if (!changes || !(changes.karakeepToken || changes.linkdingToken)) return Promise.resolve();
  return pbpClearOfflineQueuePause();
}

// Failures sendOfflineItem / deliverSaveIntent return before any request.
const PBP_OFFLINE_QUEUE_UNSENT_REASONS = new Set(["account_mismatch", "not_logged_in", "account_changed", "permission", "internal", "storage"]);

// manual: a user-initiated retry ignores the pause (and lifts it first); the
// automatic path skips paused accounts, starting from the stored pause, and
// records it holds (pbpOfflineQueueHeld: needing attention, or rate limited).
function drainOfflineQueueIds(queueIds, { manual = false, pausedAccount = "" } = {}) {
  const paused = new Set(pausedAccount ? [pausedAccount] : []);
  return pbpDrainOfflineQueue(queueIds, {
    getItem: (queueId) => runOfflineQueueWrite(async () => {
      const { offlineQueue = [] } = await chrome.storage.local.get("offlineQueue");
      return Array.isArray(offlineQueue)
        ? offlineQueue.find((item) => item?.queueId === queueId) || null
        : null;
    }),
    ...(manual ? {} : { skipItem: (item) => (typeof item.account === "string" && paused.has(item.account)) || pbpOfflineQueueHeld(item, Date.now()) }),
    // noteActivity: replay work is activity (same rationale as batch progress —
    // a long drain driven by the keepalive alarm must not idle-terminate
    // mid-run). typeof-guarded: source-slice test pages execute this function
    // without the keepalive block in scope.
    sendItem: async (item) => {
      if (manual && typeof item.account === "string" && item.account) await pbpClearOfflineQueuePause(item.account);
      if (typeof noteActivity === "function") noteActivity();
      return sendOfflineItem(item);
    },
    removeItem: (queueId) => mutateOfflineQueue({ kind: "remove", queueId }),
    onSuccess: async (item, delivered) => {
      await applySaveResultSideEffects(delivered, delivered.settings, { auth: delivered.auth });
      if (delivered?.result?.status === "saved") await pbpClearReplayedPopupDraft(item);
      if (typeof item.account === "string" && item.account) await pbpClearOfflineQueuePause(item.account);
    },
    onFailure: async (item, delivered) => {
      const reason = (delivered?.result || delivered)?.reason;
      // linkding on PostgreSQL stores a new bookmark before its tags, so a
      // skip whose create failed on an over-long tag may have left it behind
      // untagged; a later skip would find it and drop the item unreported.
      // From now on the item merges its tags into that bookmark instead and
      // keeps reporting the tag until it is shortened.
      if (reason === "tag_too_long" && delivered?.mode === "skip") {
        await mutateOfflineQueue({ kind: "skip_to_merge", queueId: item.queueId });
      }
      // A failure a second attempt meets again marks the record: automatic
      // replay leaves it until the user retries or removes it. Any other
      // failure drops a marker the record still carries. A record queued
      // before markers existed is simply replayed once and marked then.
      // An attempt that never reached the server (another connection's
      // record, no sign-in, no host grant, a local failure) has nothing new
      // to say about the record and leaves its marker as it was.
      const mark = pbpOfflineQueueFailureMark(delivered?.result || delivered);
      if (mark) await mutateOfflineQueue({ kind: "mark_failure", queueId: item.queueId, failure: mark });
      else if (item.failure !== undefined && !PBP_OFFLINE_QUEUE_UNSENT_REASONS.has(reason)) {
        await mutateOfflineQueue({ kind: "clear_failure", queueId: item.queueId });
      }
      // Pinboard items never pause: nothing on that path would lift it.
      const service = pbpBookmarkAccountService(item.account);
      const cause = pbpBookmarkStopCause(delivered?.result || delivered, service);
      if (!cause || (service !== "karakeep" && service !== "linkding")) return;
      paused.add(item.account);
      await pbpSetOfflineQueuePause(item.account, cause);
    },
  });
}

const runOfflineQueueConsumer = pbpCreateRecoveringTail();
let _offlineQueueDrain = null;
function processOfflineQueue() {
  if (_offlineQueueDrain) return _offlineQueueDrain;
  const operation = runOfflineQueueConsumer(async () => {
    const snapshot = await readOfflineQueueWithIds();
    if (!snapshot.length) return;
    const pause = await pbpReadOfflineQueuePause();
    await drainOfflineQueueIds(snapshot.map((item) => item?.queueId).filter(Boolean), { pausedAccount: pause?.account || "" });
  });
  const drain = operation.finally(() => {
    if (_offlineQueueDrain === drain) _offlineQueueDrain = null;
  });
  _offlineQueueDrain = drain;
  return drain;
}

function retryOfflineItem(queueId) {
  if (!queueId || typeof queueId !== "string") {
    return Promise.resolve({ ok: false, result: pbpSaveFailure("invalid") });
  }
  return runOfflineQueueConsumer(async () => {
    try {
      await readOfflineQueueWithIds();
      // The marker stays until the attempt's own outcome replaces or clears
      // it (onFailure above): a retry that sends nothing keeps the cause.
      const outcomes = await drainOfflineQueueIds([queueId], { manual: true });
      const outcome = outcomes[0];
      if (outcome) return { ok: outcome.acknowledged, result: outcome.result };
      // A manual drain has no skip rule, so no outcome means the record is no
      // longer queued: the automatic replay delivered it, or it was removed.
      // Not an error, and not proof of a save either; the popup refreshes.
      return { ok: false, result: { status: "gone", reason: "gone" } };
    } catch (_) {
      return { ok: false, result: pbpSaveFailure("storage") };
    }
  });
}

// summaryRange: the popup's AI summary block in intent.notes; null when its
// ownership check found none of its own; absent when it cannot tell, which
// leaves the page's receipt alone.
// expectedVersion: the bookmark as the popup's form loaded it, for an update
// (pbpBookmarkVersion); a missing one is never taken as a match.
function submitPopupSaveIntent(intent, expectedAccount, summaryRange, singleFileTab, expectedVersion) {
  if (!expectedAccount || typeof expectedAccount !== "string") {
    return Promise.resolve(pbpSaveFailure("account_changed"));
  }
  if (!intent || !PBP_POPUP_SAVE_MODES.has(intent.mode)) {
    return Promise.resolve(pbpSaveFailure("invalid"));
  }
  if (intent.mode === "update" && !intent.time) {
    return Promise.resolve(pbpSaveFailure("invalid"));
  }
  if (intent.mode === "create" && intent.time !== undefined) {
    return Promise.resolve(pbpSaveFailure("invalid"));
  }
  return submitSaveIntent(intent, { expectedAccount, summaryRange, interactive: true,
    ...(intent.mode === "update" ? { verify: { expectedVersion: pbpLoadedVersion(expectedVersion) } } : {}),
    ...(pbpSingleFileTabValid(singleFileTab) ? { singleFileTab } : {}) });
}

// ---- Reader bookmark workflow ----
// A loaded-state string (pbpBookmarkVersion) from a popup or reader message,
// or undefined. Here so the reader's own block has it; the popup uses it too.
function pbpLoadedVersion(value) {
  return typeof value === "string" && value.length <= 8192 ? value : undefined;
}
// Persisted preview slots survive SW restarts. Only the exact top-level reader
// document may consume its slot; source-tab liveness is deliberately irrelevant.
function pbpReaderDocumentUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "chrome-extension:" && u.host === chrome.runtime.id
      && u.pathname === "/md-preview.html" ? u : null;
  } catch (_) { return null; }
}

async function pbpReaderBookmarkContext(sender, account) {
  if (sender?.id !== chrome.runtime.id || sender.frameId !== 0
      || !Number.isInteger(sender.tab?.id) || !account) return null;
  const doc = pbpReaderDocumentUrl(sender.url);
  const key = doc?.searchParams.get("k");
  if (!key || !/^[a-zA-Z0-9_-]{1,100}$/.test(key)) return null;
  // sender.url/frameId/id are browser-authenticated at dispatch. Saving the
  // frozen slot never acts on a live tab, so closing/navigating the reader
  // immediately after clicking must not cancel an already-delivered intent.
  const storageKey = "md_preview_data_" + key;
  const stored = (await chrome.storage.local.get(storageKey))[storageKey];
  const auth = await pbpReadFreshBookmarkAuthForAccount(account);
  if (!stored || stored.account !== account || !auth?.token) return null;
  // bookmarkUrl: the address the handoff looked the bookmark up under (the
  // cleaned page address, pbpBookmarkLookupUrl). url stays the page's own:
  // highlights are keyed by it. A slot written before bookmarkUrl existed
  // keeps using url.
  const bookmarkUrl = stored.bookmarkUrl === undefined ? stored.url : stored.bookmarkUrl;
  try {
    if (!/^https?:$/.test(new URL(stored.url).protocol)) return null;
    if (typeof bookmarkUrl !== "string" || !/^https?:$/.test(new URL(bookmarkUrl).protocol)) return null;
  } catch (_) { return null; }
  return { ...stored, bookmarkUrl, account };
}

async function pbpPrepareReaderSaveIntent(intent, action, draft, settings, auth, expectBookmarked = false) {
  if (action === "save") return { intent: { ...intent, mode: "skip" } };
  // Pinboard's posts/add needs a title and the others would store an empty one;
  // the reader editor refuses it first, this is the worker's own check.
  if (action === "edit" && !String(draft?.title ?? "").trim()) return { result: pbpSaveFailure("invalid") };
  const lookup = await fetchExistingBookmark(intent.url, settings.pinboardToken, auth);
  if (!pbpBookmarkAuthIsCurrent(auth)) return { result: pbpSaveFailure("account_changed") };
  if (lookup.lookupFailed) {
    // Without server metadata a queued flag change cannot preserve both an
    // existing record and a new bookmark's privacy/defaults. Fail closed.
    // Pinboard's ordinary save (skip) can still enter the offline queue; a
    // self-hosted one stops on its own lookup in submitSaveIntent.
    const failure = pbpSaveFailure(lookup.reason || "lookup", Number.isInteger(lookup.httpStatus) ? { httpStatus: lookup.httpStatus } : undefined);
    return { result: pbpSelfHostedAuth(auth) ? pbpLookupStopFailure(failure) : failure };
  }
  if (action === "edit") {
    // Same entry rule as the popup for each service: self-hosted text uses the
    // quoted syntax, Pinboard splits on whitespace and keeps quotes literally.
    const selfHosted = pbpSelfHostedAuth(auth);
    let names;
    if (selfHosted) {
      try { names = pbpBookmarkParseTags(draft.tags); }
      catch (_) { return { result: pbpSaveFailure("invalid") }; }
    } else {
      names = String(draft.tags || "").split(/\s+/).filter(Boolean);
    }
    const bookmarkNames = selfHosted
      ? (Array.isArray(lookup.post?.tagNames) ? lookup.post.tagNames : [])
      : String(lookup.post?.tags || "").split(/\s+/).filter(Boolean);
    const index = await pbpReadTagVocab(auth.account);
    if (!pbpBookmarkAuthIsCurrent(auth)) return { result: pbpSaveFailure("account_changed") };
    const service = selfHosted ? auth.service : "pinboard";
    const tagContext = { bookmarkNames, index, service,
      separator: settings.aiTagSeparator, respectCase: settings.optRespectTagCase === true };
    draft = { ...draft, tags: pbpSerializeIntentTags(pbpCanonicalTagList(names, tagContext), service) };
  }
  if (!lookup.exists) {
    if (action === "read") return { result: pbpSaveFailure("lookup") };
    // The reader showed this bookmark and the user changed it (edit, Read
    // Later): deleted elsewhere since, it is not silently created again. The
    // reader says so; its next save, sent knowing the page is not bookmarked,
    // creates it. Pinboard keeps its existing behaviour.
    if (expectBookmarked && (action === "edit" || action === "later") && pbpSelfHostedAuth(auth)) {
      return { result: pbpSaveFailure("deleted_elsewhere") };
    }
    return { intent: { ...intent, mode: "create", ...(action === "edit" ? draft : {}), toread: action === "later" || (action === "edit" ? draft.toread : intent.toread) } };
  }
  const plan = pbpResolveSavePlan({ ...intent, mode: "overwrite", tags: lookup.post?.tags, private: false, toread: false }, lookup);
  if (plan.action !== "send") return { result: plan.result || pbpSaveFailure("lookup") };
  if (action !== "edit" && plan.fields.toread === (action === "later")) {
    // kept: the bookmark was just found in the requested state, so there is
    // nothing to deliver. submitSaveIntent finishes on this lookup as a
    // delivered skip would, without a second lookup or a queue record: a
    // queued skip replayed after the bookmark was deleted elsewhere would
    // rebuild it from the popup draft, against what the user asked for.
    return { intent: { ...intent, mode: "skip" }, kept: true, lookup };
  }
  // The stored Description (and Karakeep's own summary) was read, not edited.
  // An update leaves it alone without it, and a queued replay of this intent
  // would otherwise write that snapshot, as one line, over a Description
  // changed elsewhere since. Only the reader's own edit (draft) carries one.
  const { summary: _readSummary, ...kept } = plan.fields;
  return { intent: { ...kept, mode: "update", ...(action === "edit" ? draft : { toread: action === "later" }), time: plan.fields.time } };
}

function pbpReaderInitialIntent(context, settings, action) {
  const originalDraft = context.bookmarkDraft;
  const linkding = pbpBookmarkServiceId(settings) === "linkding";
  // The reader has no page description of its own: it keeps the popup draft's
  // Description, sends a known "" when auto-fill is off, and otherwise leaves
  // it out so linkding fills it in from the page.
  const summary = !linkding ? undefined
    : typeof originalDraft?.summary === "string" ? pbpBookmarkDescriptionText(originalDraft.summary)
      : settings.optAutoDescription === false ? "" : undefined;
  return {
    mode: "skip", url: context.bookmarkUrl,
    // A blank draft title (spaces, or a page without one) would be stored as an
    // empty title; fall back to the page title, then the address.
    title: typeof originalDraft?.title === "string" && originalDraft.title.trim() ? originalDraft.title
      : String(context.title ?? "").trim() || context.bookmarkUrl,
    notes: typeof originalDraft?.notes === "string" ? originalDraft.notes : typeof context.description === "string" ? context.description : "",
    ...(summary !== undefined ? { summary } : {}),
    tags: typeof originalDraft?.tags === "string" ? originalDraft.tags : Array.isArray(context.tags) ? pbpSerializeIntentTags(context.tags, pbpBookmarkServiceId(settings)) : "",
    // A linkding bookmark the reader creates starts unshared, whatever the
    // popup's Share box said (user decision 2026-11-01). Only a click on the
    // reader editor's own Share box records a sharing choice (md-bookmark.js).
    private: linkding ? true : typeof originalDraft?.private === "boolean" ? originalDraft.private : pbpServiceEffectivePrivate(settings, { incognito: context.sourceIncognito === true }),
    toread: action === "later" || (typeof originalDraft?.toread === "boolean" ? originalDraft.toread : settings.optReadlaterDefault === true),
  };
}

// Deletes the bookmark `url` of `account` after every save before it, and
// cancels that owner's earlier queued saves of the same address first. The
// reader, the popup and the notification's Undo all delete through this.
function pbpDeleteBookmarkInOrder(account, url) {
  // Wait for replay as well as live saves. Otherwise a queued snapshot that
  // was read before this deletion could recreate the bookmark afterwards.
  return runOfflineQueueConsumer(() => runSaveDeliveryTransaction(async () => {
    let failure = "storage";
    try {
      let auth = await pbpReadFreshBookmarkAuthForAccount(account);
      if (!auth) return pbpSaveFailure("account_changed");
      // This explicit delete supersedes earlier pending saves, including when
      // its response is lost or the owner switches during the request. Cancel
      // those saves while we still own the account, before any remote mutation.
      const cleared = await runOfflineQueueWrite(async () => {
        const { offlineQueue = [] } = await chrome.storage.local.get("offlineQueue");
        auth = await pbpReadFreshBookmarkAuthForAccount(account);
        if (!auth) return false;
        if (Array.isArray(offlineQueue)) {
          // Only this exact bookmark and owner. Other URLs and accounts are
          // untouched; legacy queue records may still carry a token binding.
          const next = offlineQueue.filter(item => item?.url !== url
            || (item.account || pbpPinboardAccountFromToken(item.token)) !== account);
          if (next.length !== offlineQueue.length) {
            await chrome.storage.local.set({ offlineQueue: next });
            await pbpReleaseDroppedSummaryHolds(offlineQueue, next);
          }
        }
        return true;
      });
      auth = await pbpReadFreshBookmarkAuthForAccount(account);
      if (!cleared || !auth) return pbpSaveFailure("account_changed");
      failure = "network";
      const resp = await pbpBookmarkDeleteResponse(auth, url);
      if (!resp.ok) return pbpSaveFailure(resp.status === 401 || resp.status === 403 ? "not_logged_in" : "http", { httpStatus: resp.status });
      const data = await resp.json();
      auth = await pbpReadFreshBookmarkAuthForAccount(account);
      if (!auth) return pbpSaveFailure("account_changed");
      const code = typeof data?.result_code === "string" ? data.result_code : "";
      // "item not found": the bookmark is already gone, the state asked for.
      if (code !== "done" && !/item\s+not\s+found/i.test(code)) return pbpSaveFailure("api", { detail: code });
      try {
        if (pbpStatusCacheSet(url, auth, { bookmarked: false, timestamp: Date.now(), posts: [] })) {
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (pbpBookmarkAuthIsCurrent(auth) && tab.id && pbpSameBookmark(tab.url, url)) setIcon(tab.id, "default", tab.url);
          }
        }
        await updateBadge();
      } catch (e) { console.warn("bookmark delete status failed:", e?.name, e?.message); }
      return await pbpReadFreshBookmarkAuthForAccount(account)
        ? { status: "deleted", account: account } : pbpSaveFailure("account_changed");
    } catch (e) {
      console.warn("bookmark delete failed:", e?.name, pbpSaveFailure(failure, { detail: e?.message }).detail);
      if (e?.code === "account_changed") return pbpSaveFailure("account_changed");
      // Self-hosted clients throw classified product errors; keep their code
      // (gateway, auth, remote) instead of folding everything into network.
      if (typeof e?.code === "string" && e.code) return pbpBookmarkFailure(e);
      // A Pinboard request that ran out of time (AbortSignal.timeout).
      if (failure === "network" && (e?.name === "TimeoutError" || e?.name === "AbortError")) return pbpSaveFailure("timeout");
      return pbpSaveFailure(failure);
    }
  }));
}

// Undo failure feedback: the bookmark is still saved, so the "saved" toast
// stays truthful and is left in place; what the click needs is to hear that
// the removal did not happen. Same showNotification error family (and the
// same notifyErrors gate) every other write path uses. A self-hosted cause
// takes its copy from the shared failure table; a Pinboard one keeps the
// server's own result_code when it sent one, else the key
// classifyPinboardError derives from the HTTP status or the error.
function pbpNotifyUndoFailed(cause) {
  const message = (typeof cause === "string" && cause) ? cause : t(classifyPinboardError(cause));
  showNotification("undo-error", t("bgUndoFailed"), message, "error");
}
function pbpNotifyUndoFailedResult(result, account) {
  // A local read or write stopped the Undo (cancelling a queued save of
  // this address, say) before any request: the network is not the cause.
  if (result?.reason === "storage" || result?.reason === "internal") return pbpNotifyUndoFailed(t("bgUndoFailedLocal"));
  const text = pbpBookmarkFailureText(result, pbpBookmarkAccountService(account), t);
  if (text) return pbpNotifyUndoFailed(text);
  if (result?.reason === "api" && result.detail) return pbpNotifyUndoFailed(result.detail);
  if (Number.isInteger(result?.httpStatus)) return pbpNotifyUndoFailed({ status: result.httpStatus });
  if (result?.reason === "timeout") return pbpNotifyUndoFailed({ name: "TimeoutError" });
  return pbpNotifyUndoFailed(new TypeError("network"));
}

// The notification's Undo deletes through the same ordered delete as the
// reader: after any delivery or replay in flight, with the owner's earlier
// queued saves of that address cancelled first, so none rebuilds it later.
// The record's owner must still be the current connection.
async function pbpRunNotificationUndo(notifId) {
  const info = await pbpTakeUndoRecord(notifId);
  if (!info) {
    // Expired, or lost with an earlier worker generation: the toast is still on
    // screen offering an Undo that cannot happen. Take it down so the click at
    // least removes the dead button instead of doing nothing at all.
    await pbpClearNotification(notifId);
    return;
  }
  const result = await pbpDeleteBookmarkInOrder(info.account, info.url);
  if (result?.status === "deleted") {
    // The "saved" toast is now false and its button is spent: replace it.
    await pbpClearNotification(notifId);
    showNotification("undo-done", t("bgUndone"), t("bgBookmarkRemoved"));
    return;
  }
  if (result?.reason === "account_changed") {
    // A different signed-in account is the deliberate isolation cancel: the
    // record belongs to an account this session may not act for. A cleared
    // token is a real failure the click deserves to hear about; 401 is the
    // shape classifyPinboardError maps to the auth copy.
    const current = await getCurrentBookmarkAuth().catch(() => null);
    if (!current?.token) pbpNotifyUndoFailed(401);
    return;
  }
  pbpNotifyUndoFailedResult(result, info.account);
}

// The popup's bookmark requests (bookmark_api) for the current connection.
async function pbpBookmarkApiRequest(message) {
  const auth = await getCurrentBookmarkAuth();
  if (!message.account || message.account !== auth.account || !auth.token) return {ok:false,status:0,error:"account_changed"};
  const client = pbpSelfHostedAuth(auth) ? pbpBookmarkClient(auth) : null;
  let data;
  if (message.action === "tags") data = await pbpBookmarkTagCounts(auth);
  else if (message.action === "lookup") data = await (await pbpBookmarkPostsResponse(auth, message.url)).json();
  else if (message.action === "recent" && client) data = {posts:(await client.recent(5)).map(pbpBookmarkAsPost)};
  else if (message.action === "delete") {
    if (!pbpBookmarkWebUrl(message.url)) return {ok:false,status:0,error:"invalid_request"};
    const result = await pbpDeleteBookmarkInOrder(auth.account, message.url);
    if (result.status !== "deleted") return {ok:false,status:result.httpStatus || 0,error:result.reason,
      ...(typeof result.detail === "string" && result.detail ? {detail:result.detail} : {})};
    data = {result_code:"done"};
  } else return {ok:false,status:0,error:"invalid_request"};
  const fresh = await getCurrentBookmarkAuth();
  if (!pbpBookmarkAuthIsCurrent(auth) || fresh.account !== auth.account) return {ok:false,status:0,error:"account_changed"};
  return {ok:true,status:200,data,account:auth.account};
}

// The reader's view of a found bookmark, from its posts/get-shaped post; null
// when it cannot be shown. tagNames: the bookmark's tags as names, which the
// reader's export metadata takes over after a save (self-hosted names may
// hold spaces). version: what the editor loaded, sent back with its edit.
function pbpReaderStateBookmark(context, post) {
  const plan = pbpResolveSavePlan({ mode: "overwrite", url: context.bookmarkUrl, tags: post?.tags }, { exists: true, post });
  if (plan.action !== "send") return null;
  const tagNames = Array.isArray(post?.tagNames) ? post.tagNames.slice()
    : String(post?.tags || "").split(/\s+/).filter(Boolean);
  return { ...plan.fields, tagNames, ...(typeof post?.version === "string" ? { version: post.version } : {}) };
}

async function pbpReaderBookmarkRequest(message, sender) {
  const context = await pbpReaderBookmarkContext(sender, message.account);
  if (!context) return pbpSaveFailure("account_changed");
  if (message.type === "mdReaderBookmarkDelete") return pbpDeleteBookmarkInOrder(context.account, context.bookmarkUrl);
  if (message.type === "mdReaderBookmarkState") {
    const auth = await pbpReadFreshBookmarkAuthForAccount(context.account);
    if (!auth) return pbpSaveFailure("account_changed");
    const lookup = await fetchExistingBookmark(context.bookmarkUrl, auth.token, auth);
    let result = { known: false, account: context.account };
    // A non-secret product code, so the reader can name why status is unknown.
    if (lookup.lookupFailed && typeof lookup.reason === "string") result.reason = lookup.reason;
    if (lookup.lookupFailed && Number.isInteger(lookup.httpStatus)) result.httpStatus = lookup.httpStatus;
    if (!lookup.lookupFailed && !lookup.exists) {
      result = { known: true, bookmarked: false, bookmark: pbpReaderInitialIntent(context, await loadSettings(), "save"), account: context.account };
    } else if (!lookup.lookupFailed) {
      const bookmark = pbpReaderStateBookmark(context, lookup.post);
      if (bookmark) result = { known: true, bookmarked: true, bookmark, account: context.account };
    }
    // Token rotation under the same owner does not invalidate display metadata.
    // Re-read the effective owner after every await before returning it to UI.
    return await pbpReadFreshBookmarkAuthForAccount(context.account) ? {...result, quotedTags:pbpSelfHostedAuth(auth), privacySupported:!["karakeep","linkding"].includes(auth.service), sharingSupported:auth.service === "linkding" && auth.sharingEnabled === true, descriptionSupported:auth.service === "linkding"} : pbpSaveFailure("account_changed");
  }
  const action = message.action;
  if (!["save", "later", "read", "edit"].includes(action)) return pbpSaveFailure("invalid");
  if (message.expectBookmarked !== undefined && typeof message.expectBookmarked !== "boolean") return pbpSaveFailure("invalid");
  let draft = null;
  if (action === "edit") {
    const input = message.draft;
    if (!input || typeof input.title !== "string" || typeof input.tags !== "string"
        || typeof input.notes !== "string" || typeof input.private !== "boolean" || typeof input.toread !== "boolean"
        || (input.summary !== undefined && typeof input.summary !== "string")
        || (input.sharedExplicit !== undefined && typeof input.sharedExplicit !== "boolean")
        || !input.title.trim()) return pbpSaveFailure("invalid");
    draft = { title: input.title, tags: input.tags, notes: input.notes, private: input.private, toread: input.toread,
      ...(input.sharedExplicit !== undefined ? { sharedExplicit: input.sharedExplicit } : {}),
      ...(input.summary !== undefined && (await pbpReadFreshBookmarkAuthForAccount(context.account))?.service === "linkding"
        ? { summary: pbpBookmarkDescriptionText(input.summary) } : {}) };
  }
  const settings = await loadSettings();
  const intent = pbpReaderInitialIntent(context, settings, action);
  // The popup's AI summary block in the notes it handed over, which the
  // initial intent carries (popup.js pbpPopupHandoffSummaryRange). Only the
  // frozen slot supplies it, never the reader's message.
  const handed = context.bookmarkDraft?.summaryRange;
  const summaryRange = typeof context.bookmarkDraft?.notes === "string"
    && Number.isInteger(handed?.start) && Number.isInteger(handed?.end)
    ? { start: handed.start, end: handed.end } : undefined;
  // Only an edit sends the editor's own text. Save keeps an existing bookmark
  // as it is, and Read Later changes the flag on the bookmark it reads now.
  const result = await submitSaveIntent(intent, { expectedAccount: context.account, readerAction: action, readerDraft: draft, readerExpectBookmarked: message.expectBookmarked === true, summaryRange,
    ...(action === "edit" ? { verify: { expectedVersion: pbpLoadedVersion(message.expectedVersion) } } : {}) });
  const current = await pbpReadFreshBookmarkAuthForAccount(context.account);
  if (!current) return pbpSaveFailure("account_changed");
  // Changed elsewhere: the reader takes the bookmark as the check found it.
  const { latestPost, ...answer } = result || {};
  const latest = result?.reason === "changed_elsewhere" && latestPost ? pbpReaderStateBookmark(context, latestPost) : null;
  return { ...answer, ...(latest ? { bookmark: latest } : {}), account: context.account };
}

async function pbpRouteReaderSaveCommand(command, tab) {
  if (!["quick_save", "read_later"].includes(command) || !pbpReaderDocumentUrl(tab?.url)) return false;
  try { await chrome.tabs.sendMessage(tab.id, { type: "PBP_READER_BOOKMARK_COMMAND", action: command === "read_later" ? "later" : "save" }); }
  catch (e) { console.warn("reader save command unavailable:", e?.name, e?.message); }
  return true;
}
// ---- End reader bookmark workflow ----

// ---- P1: Shared save function ----
async function saveFromBackground({ url, pageUrl, title, tab, settingsOverrides, toread, notifyId, notifyTitle, notifyCategory }) {
  const startAuth = await getCurrentBookmarkAuth();
  if (!startAuth.token) {
    // This notification fires before any network round-trip, so on a cold SW
    // the manual-language refresh kicked off by initI18n() at module top may
    // not have landed yet. The shortcut handler waits for it up front; this
    // branch also serves the other callers (popup, context menu) that do not.
    await pbpI18nReady();
    showNotification(notifyId + "-error", t("bgNotLoggedIn"), t("bgSetToken"), "error");
    return pbpSaveFailure("not_logged_in");
  }
  // Delivery re-checks the exact host grant before every request; without it
  // the save cannot land, so stop before reading the page or paying for AI.
  // A check only: an automatic path never requests a permission.
  if (pbpSelfHostedAuth(startAuth) && !await pbpBookmarkHostGranted(startAuth, notifyCategory)) {
    const result = { status: "failed", reason: "permission" };
    await pbpI18nReady();
    notifySaveFailure(notifyId, result, startAuth.service);
    return result;
  }
  // A title the service cannot store fails every attempt, but quick save
  // sends the page's title only when it creates the bookmark: a merge, skip
  // or overwrite into one already saved keeps the server's title. So an
  // over-long title is checked against the server first, before reading the
  // page or paying for AI; a new page stops here, and the answer is handed to
  // delivery so the server is asked once. A check that got no answer goes on
  // to be queued like an outage (decision 2026-11-02, 5a).
  let titleLookup;
  if (pbpBookmarkTitleFailure(title, startAuth.service)) {
    const checked = await pbpCheckOverlongTitle(url, title, startAuth);
    if (checked.failure) {
      await pbpI18nReady();
      notifySaveFailure(notifyId, checked.failure, startAuth.service);
      return checked.failure;
    }
    titleLookup = checked.lookup;
  }
  const loadedSettings = await loadSettings();
  const s = pbpBookmarkDeliverySettings({ ...loadedSettings, ...(settingsOverrides || {}) }, startAuth);
  const mode = s.bgSaveMode === "skip" || s.bgSaveMode === "overwrite" ? s.bgSaveMode : "merge";
  const isPrivate = pbpServiceEffectivePrivate(s, { incognito: tab?.incognito });

  // Extract page info if tab available
  let pageInfo = null;
  if (tab?.id) {
    try {
      pageInfo = (s._aiTags || s._aiSummary) && hasAIKey(s)
        ? await getPageInfoFromTab(tab.id, { withDefuddle: true, expectedUrl: pageUrl || url })
        : await getPageInfoFromTab(tab.id, { expectedUrl: pageUrl || url });
    } catch (_) { /* content script may not be injected yet — proceed with empty pageInfo */ }
  }

  // Build notes from page info
  let notes = "";
  if (pageInfo) {
    notes = buildAutoNotes(pageInfo, {
      autoDescription: s._autoNotes,
      blockquote: s._blockquote,
      service: startAuth.service,
      includeReferrer: false
    });
  }

  // Default tags
  let tags = [];
  if (s._defaultTags) {
    // Full-width comma too: default tags accept whitespace or commas.
    tags = s._defaultTags.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);
  }

  // AI features
  // SW extraction is ALWAYS local (getPageInfoFromTab + Defuddle) - it
  // never calls Jina. Cache under the namespace that matches the content
  // (audit A3): keying by the configured aiContentSource wrote local
  // results into the "jina" namespace, which the popup then served as
  // supposed Jina extractions.
  const aiCacheSource = "local";
  // Popup parity (audit A14): feed the tag prompts the same frequency-
  // sorted vocabulary the popup injects; without it quick-saved bookmarks
  // got tags with zero anchoring to the user's existing tag system.
  // No owned cache -> unanchored prompt, same as before.
  const tagVocab = await pbpLoadTagVocab(startAuth.account);
  const userTagsTop = tagVocab.counts ? pbpTagsByCount(tagVocab.counts) : [];
  const tagContext = {service:startAuth.service, separator:s.aiTagSeparator,
    bookmarkNames:[], index:tagVocab.index, respectCase:s.optRespectTagCase === true};
  const aiPromises = [];
  let aiHostPermissionMissing = false;
  let combinedCachedTags = null;
  let combinedCachedSummary = null;
  // Per-artifact resolution state (audit A8): null = still needed. A
  // combined reply may legally come back half-empty ({"summary":"ok",
  // "tags":[]}) - the produced half is applied, the EMPTY half falls
  // through to its own dedicated single call below instead of being
  // silently treated as a produced result.
  let aiTagsResolved = null;
  let summaryResolved = null;
  const linkding = startAuth.service === "linkding";
  let linkdingSummary = "";

  // Both tags AND summary requested -> one combined call (sends the body once).
  // Gated OFF when the user set a custom tag/summary prompt: the combined prompt uses
  // TAG_GUIDANCE (not their template), so customizers fall through to the separate calls
  // below, which honor customTagPrompt/customSummaryPrompt (Global Constraint).
  if (pageInfo?.pageText && hasAIKey(s) && s._aiTags && s._aiSummary
      && !s.customTagPrompt?.trim() && !s.customSummaryPrompt?.trim()) {
    try {
      const tCached = combinedCachedTags = await getAICache(url, "tags", s.aiCacheDuration, aiCacheSource, startAuth.account, s);
      const sCached = combinedCachedSummary = await getAICache(url, "summary", s.aiCacheDuration, aiCacheSource, startAuth.account, s);
      // A16: a cached half is reused as-is; the combined call only runs
      // when BOTH halves are missing (regenerating both overwrote the
      // cached one and paid for it again). Exactly one missing -> its
      // dedicated single job below fills it.
      if (tCached) aiTagsResolved = tCached;
      if (sCached) summaryResolved = sCached;
      if (aiTagsResolved === null && summaryResolved === null) {
        const resp = await callAI(s, buildCombinedPrompt(s, title, url, pageInfo.pageText, notes, pbpRelevantTagsFirst(userTagsTop, title, url)));
        const parsed = parseAICombined(resp, s.aiTagSeparator);
        // Cache each half only when it has content: a cached empty would
        // turn the malformed half into a sticky fake success (A8).
        if (parsed.tags.length) {
          aiTagsResolved = parsed.tags;
          await setAICache(url, "tags", parsed.tags, s.aiCacheDuration, aiCacheSource, startAuth.account, s);
        }
        if (parsed.summary) {
          summaryResolved = parsed.summary;
          await setAICache(url, "summary", parsed.summary, s.aiCacheDuration, aiCacheSource, startAuth.account, s);
        }
      }
    } catch (e) {
      if (e?.code === "host_permission") {
        aiHostPermissionMissing = true;
        if (combinedCachedTags) aiTagsResolved = combinedCachedTags;
        if (combinedCachedSummary) summaryResolved = combinedCachedSummary;
        console.warn(`${notifyCategory} AI skipped:`, e.message);
      } else {
        console.warn(`${notifyCategory} AI combined failed, falling back to separate calls:`, e.message);
      }
    }
  }

  if (!aiHostPermissionMissing && pageInfo?.pageText && hasAIKey(s)) {
    if (s._aiTags && aiTagsResolved === null) {
      aiPromises.push(
        (async () => {
          try {
            const cached = await getAICache(url, "tags", s.aiCacheDuration, aiCacheSource, startAuth.account, s);
            if (cached) return { type: "tags", result: cached };
            const prompt = buildTagPrompt(s, title, url, pageInfo.pageText, notes, pbpRelevantTagsFirst(userTagsTop, title, url));
            const resp = await callAI(s, prompt);
            const aiTags = refineTags(parseAITags(resp, s.aiTagSeparator), { cap: AI_TAG_CAP, separator: s.aiTagSeparator });
            await setAICache(url, "tags", aiTags, s.aiCacheDuration, aiCacheSource, startAuth.account, s);
            return { type: "tags", result: aiTags };
          } catch (e) {
            if (e?.code === "host_permission") aiHostPermissionMissing = true;
            console.warn(`${notifyCategory} AI tags failed:`, e.message);
            return null;
          }
        })()
      );
    }
    if (s._aiSummary && summaryResolved === null) {
      aiPromises.push(
        (async () => {
          try {
            const cached = await getAICache(url, "summary", s.aiCacheDuration, aiCacheSource, startAuth.account, s);
            if (cached) return { type: "summary", result: cached };
            const prompt = buildSummaryPrompt(s, title, url, pageInfo.pageText, notes);
            const summary = await callAI(s, prompt);
            await setAICache(url, "summary", summary, s.aiCacheDuration, aiCacheSource, startAuth.account, s);
            return { type: "summary", result: summary };
          } catch (e) {
            if (e?.code === "host_permission") aiHostPermissionMissing = true;
            console.warn(`${notifyCategory} AI summary failed:`, e.message);
            return null;
          }
        })()
      );
    }
  }

  // Appends the summary block and remembers where it sits, so the worker can
  // record ownership once these notes are delivered (the popup reclaims the
  // block from that receipt after the AI cache is gone). null: these notes
  // hold no block, which retires a stale receipt for the page once written.
  let summaryRange = null;
  const appendSummary = (summary) => {
    const wrapped = pbpFormatSummaryBlock(summary, startAuth.service);
    const start = notes ? notes.length + 2 : 0;
    notes = notes ? notes + "\n\n" + wrapped : wrapped;
    summaryRange = wrapped ? { start, end: start + wrapped.length } : null;
  };
  // Apply combined-path results, then whatever the single calls produced.
  if (aiTagsResolved) tags = [...tags, ...aiTagsResolved];
  if (summaryResolved) {
    if (linkding) linkdingSummary = summaryResolved;
    else appendSummary(summaryResolved);
  }
  const aiResults = await Promise.all(aiPromises);
  for (const r of aiResults) {
    if (!r) continue;
    if (r.type === "tags") tags = [...tags, ...r.result];
    if (r.type === "summary") {
      if (linkding) linkdingSummary = r.result;
      else appendSummary(r.result);
    }
  }
  // linkding Description: the AI summary, else the page's meta description
  // (possibly none) when the page was read. With the page description turned
  // off it is a known "", so linkding adds none either; a page that could not
  // be read (or is a PDF or other non-HTML document) leaves it out, and
  // linkding fills it in from the page itself.
  const description = !linkding ? undefined
    : pbpBookmarkDescriptionLine(linkdingSummary)
      || (!(s._autoNotes && s.optAutoDescription !== false) ? ""
        : pbpPageInfoReadable(pageInfo) ? pbpBookmarkDescriptionLine(pbpNotesDescription(pageInfo)) : undefined);

  const result = await submitSaveIntent({
    mode,
    url,
    title,
    notes,
    ...(description !== undefined ? { summary: description } : {}),
    tags: pbpSerializeIntentTags(pbpCanonicalTagList(tags, tagContext), startAuth.service),
    private: isPrivate,
    toread: toread === true ? true : undefined,
    archive: undefined,
  }, { expectedAccount: startAuth.account, summaryRange, tagVocab, lookup: titleLookup,
    ...(Number.isInteger(tab?.id) && typeof tab.url === "string" ? { singleFileTab: { id: tab.id, url: tab.url } } : {}) });

  if (result.status === "saved") {
    const undoInfo = result.mutation === "created" && result.account
      ? { url, account: result.account }
      : undefined;
    showNotification(
      notifyId + "-saved",
      notifyTitle,
      result.mutation === "merged" ? pbpBookmarkMergedText(startAuth.service, t)
        : t(aiHostPermissionMissing ? "bgTitleSavedAiSkipped" : "bgTitleSaved", title.substring(0, 60)),
      notifyCategory,
      undoInfo
    );
    processOfflineQueue().catch(() => {});
    return result;
  }
  if (result.status === "queued") {
    showNotification(notifyId + "-queued", t("bgQueuedOffline"), t("bgTitleQueued", title.substring(0, 60)), notifyCategory);
    return result;
  }
  if (result.status === "skipped") {
    showNotification(notifyId + "-skipped", t("bgSkippedTitle"), t("bgSkippedExists"), notifyCategory);
    return result;
  }
  notifySaveFailure(notifyId, result, startAuth.service, mode);
  return result;
}

// Pre-flight exact host grant check shared by quick save and Batch, run before
// any extraction or AI request. Fail-closed: a missing origin or a platform
// error counts as not granted (the error is logged). A check only: it never
// requests a permission. It sits here, inside the source slice the test
// harnesses take for saveFromBackground.
async function pbpBookmarkHostGranted(auth, logTag) {
  const origin = pbpEndpointOriginPattern(auth?.baseUrl);
  if (!origin) return false;
  try { return !!await chrome.permissions.contains({ origins: [origin] }); }
  catch (e) {
    console.warn(`${logTag} host permission check failed:`, e?.name, e?.message);
    return false;
  }
}

// Failure-reason -> showNotification mapping, shared by the background
// quick-save path above (saveFromBackground) and the popup save_intent
// router branch below (submitPopupSaveIntent has no popup document left to
// hand the result to once it fails). `service` comes from the caller's
// connection; unknown reasons never surface as raw codes. mode: the quick
// save's bgSaveMode.
function notifySaveFailure(notifyId, result, service, mode) {
  // Self-hosted causes first: their auth and gateway codes must not fall into
  // the Pinboard login copy below.
  let key = pbpBookmarkFailureKey(result, service);
  // linkding on PostgreSQL stored the page untagged before refusing the tag,
  // and the next skip-mode shortcut save would skip it: say where to add it.
  if (key === "bookmarkErrTagTooLong" && mode === "skip") key = "bgTagTooLongSkip";
  if (key) {
    // A connection that changed mid-save may have let the first write
    // through, so that title must not claim the save failed.
    const title = result?.reason === "account_changed" ? "bgSaveUnconfirmed" : "bgSaveFailed";
    showNotification(notifyId + "-error", t(title), t(key, ...pbpBookmarkFailureArgs(result)), "error");
  } else if (result.reason === "not_logged_in") {
    showNotification(notifyId + "-error", t("bgNotLoggedIn"), t("bgSetToken"), "error");
  } else if (result.reason === "too_long") {
    showNotification(
      notifyId + "-error",
      t("bgSaveFailed"),
      t("uriTooLong", result.detail || "?", String(POSTS_ADD_URI_BUDGET)),
      "error"
    );
  } else if (result.reason === "network" || result.reason === "lookup") {
    showNotification(notifyId + "-error", t("bgNetworkError"), result.detail || t("pinboardErrorOffline"), "error");
  } else if (result.reason === "account_changed") {
    showNotification(notifyId + "-error", t("bgNotLoggedIn"), t("pinboardErrorAuth"), "error");
  } else if (result.reason === "permission") {
    showNotification(notifyId + "-error", t("bgSaveFailed"), t("bookmarkPermissionDenied"), "error");
  } else if (result.reason === "partial") {
    showNotification(notifyId + "-error", t("bgSaveFailed"), t(pbpBookmarkPartialKey(result) || "bookmarkPartialSave"), "error");
  } else {
    // Only Pinboard's own API message and an HTTP status are user-readable;
    // any other reason is an internal code and gets the generic copy.
    const body = result.reason === "api" && result.detail ? result.detail
      : result.reason === "http" && Number.isInteger(result.httpStatus) ? "HTTP " + result.httpStatus
      : t("saveFailedGeneric");
    showNotification(notifyId + "-error", t("bgSaveFailed"), body, "error");
  }
}

// Helper: resolve prefix-specific settings to internal keys
function resolvePrefixSettings(s, prefix) {
  return {
    _autoNotes: s[prefix + "AutoNotes"],
    _blockquote: s[prefix + "Blockquote"],
    _defaultTags: s[prefix + "DefaultTags"],
    _aiTags: s[prefix + "AiTags"],
    _aiSummary: s[prefix + "AiSummary"]
  };
}

// B4: write current tab data to session storage for popup mirror prefill (Phase 1).
// No `posts` field: this used to read pbpStatusCacheGet(url, auth) and carry a
// cached posts array, but it was keyed by the RAW tab URL while K0 made every
// statusCache writer key off the CLEANED url, so on a tracked-param page this
// was always null anyway. popup.js's only reads of the mirror are tabId/ts
// (staleness/identity check) -- dropped instead of fixed, since nothing ever
// consumed it, and every tab event was paying an extra cache read for it.
async function _writeCurrentTabMirror(tabId, url, title) {
  if (!url || !url.startsWith("http")) {
    try { await chrome.storage.session.remove("_currentTab"); } catch (_) {}
    return;
  }
  const auth = await getCurrentBookmarkAuth();
  try {
    await chrome.storage.session.set({
      _currentTab: { tabId, url, title: title || "", account: auth.account, ts: Date.now() }
    });
    if (!pbpBookmarkAuthIsCurrent(auth)) await chrome.storage.session.remove("_currentTab");
  } catch (_) {}
}

async function _getFocusedActiveTab(expectedTabId, expectedUrl) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id !== expectedTabId) return null;
  if (typeof expectedUrl === "string" && tab.url !== expectedUrl) return null;
  if (!tab.url || (!tab.url.startsWith("http://") && !tab.url.startsWith("https://"))) return null;
  return tab;
}

// tabId -> last URL a status check was dispatched for. Read only by the
// same-document arm of tabs.onUpdated, to tell a real in-page route change from a
// pure #fragment jump; cleared on tab close and on any auth change (fail open).
const _lastCheckedUrl = new Map();
function _urlWithoutFragment(url) {
  if (typeof url !== "string") return "";
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

// A check that does not run (the tab is not the focused window's active tab)
// leaves the toolbar as it is. After an in-page route change that is still the
// earlier page's icon, and Chromium keeps it for the tab past a worker restart,
// while the record saying so lives only in this worker: a later failed check
// in a fresh worker would then keep the earlier page's "saved". So a tab whose
// icon describes another page drops back to the default icon right away. A
// focused active tab is left alone (its own check is scheduled and sets the
// state once, without a saved -> default -> saved flash).
async function _resetIconForAnotherPage(tabId) {
  if (!_iconPageUrl.has(tabId)) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url || (!tab.url.startsWith("http://") && !tab.url.startsWith("https://"))) return;
    if (_iconPageUrl.get(tabId) === _urlWithoutFragment(tab.url)) return;
    if (await _getFocusedActiveTab(tabId, tab.url)) return;
    setIcon(tabId, "default", tab.url);
  } catch (_) {
    // Tab closed between event and lookup: nothing left to reset.
  }
}

function _scheduleCurrentTabRefresh(tabId, expectedUrl) {
  if (typeof expectedUrl === "string") _lastCheckedUrl.set(tabId, expectedUrl);
  _scheduleTabCheck(tabId, async () => {
    try {
      const tab = await _getFocusedActiveTab(tabId, expectedUrl);
      if (!tab) { await _resetIconForAnotherPage(tabId); return; }
      // onActivated/onFocusChanged can arrive without an expected URL; record what
      // the check actually ran against so the fragment gate below has a baseline.
      _lastCheckedUrl.set(tabId, tab.url);

      noteActivity();
      const status = await debouncedCheck(tab.url);

      // The tab may have navigated or lost focus while the API request was in flight.
      const currentTab = await _getFocusedActiveTab(tab.id, tab.url);
      if (!currentTab) { await _resetIconForAnotherPage(tab.id); return; }
      if (status && typeof status.bookmarked === "boolean") {
        // checkBookmarked (via debouncedCheck) just wrote the cache entry; re-derive
        // the current auth to read it back atomically (same account/epoch). The key
        // is debouncedCheck's target (K0: the cleaned URL whenever urlClean applies),
        // never the raw tab URL — reading back a key nothing wrote returns null and
        // would reset a saved page's icon to "default".
        const auth = await getCurrentBookmarkAuth();
        setIcon(currentTab.id, iconStateFor(pbpStatusCacheGet(status.target, auth)), currentTab.url);
      } else if (status && status.bookmarked === null && _iconPageUrl.has(currentTab.id)
          && _iconPageUrl.get(currentTab.id) !== _urlWithoutFragment(currentTab.url)) {
        // A failed self-hosted check keeps the icon only for the page it
        // describes. After an in-page route change (SPA) the browser leaves the
        // previous page's icon up: "saved" there must not read as this page
        // saved, so it falls back to not-known-saved.
        setIcon(currentTab.id, "default", currentTab.url);
      }
      await _writeCurrentTabMirror(currentTab.id, currentTab.url, currentTab.title);
    } catch (_) {
      // Tab closed/replaced between event and query — expected race, skip
    }
  }, 150);
}

// ---- 标签页激活/更新时刷新图标 (P3: debounced + deduped) ----
chrome.tabs.onActivated.addListener(({ tabId }) => {
  _scheduleCurrentTabRefresh(tabId);
});

// `changeInfo.url` is the same-document (history.pushState) signal: SPA sites
// (YouTube, Twitter, Zhihu) never re-run loading->complete for an in-page route
// change, and Chromium only clears the tab-scoped action icon on cross-document
// navigation — so without this arm the icon stays stuck on the previous page's
// state. Accept either signal; the 150ms per-tab debounce, the _pendingChecks
// dedup and the 5-minute status cache keep the extra events off the network.
// That same signal also fires for a bare #fragment jump (footnote, table of
// contents), and Pinboard treats `page#note` as a DIFFERENT url than `page`:
// re-checking it returns posts:[] and would flip a saved article's icon to "not
// saved" on every anchor click, burning one 3.1s rate-limit slot each time.
// Bookmark identity ignores the fragment, so a fragment-only move keeps the state
// the page already has. A cross-document navigation carries a status transition;
// a bare url change is the same-document (pushState/fragment) case.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!(changeInfo.status === "complete" || changeInfo.url)) return;
  if (!tab.url || !tab.url.startsWith("http")) return;
  const sameDocument = !!changeInfo.url && changeInfo.status === undefined;
  if (sameDocument && _urlWithoutFragment(tab.url) === _urlWithoutFragment(_lastCheckedUrl.get(tabId))) return;
  // Chromium clears the tab-scoped action icon on a cross-document navigation
  // (the platform behaviour this listener already relies on), so the dedup entry
  // stops describing what the toolbar shows. Recomputing the SAME state after a
  // reload, or on a saved -> saved hop, would then short-circuit setIcon and
  // leave the default pin up. Same rule invalidateBookmarkAuthState follows:
  // when the truth behind the dedup moves, the dedup entry goes first.
  if (!sameDocument) _lastIconState.delete(tabId);
  // The icon's page record stays as it is: it names the page the icon was set
  // for, so on any other address it reads as "describes another page" and a
  // check that learns nothing (a failed self-hosted check, linkding with
  // browsing checks off) drops the icon to default. It is not dropped for what
  // looks like a new document: Chromium reports an in-page route change
  // (history.pushState) as status "loading" with the new url too, and keeps
  // the earlier page's icon then; after a real new document the icon is
  // already the default, so that reset changes nothing. An address change with
  // no record yet (a restarted worker) becomes "describes another page" in
  // either shape: the browser still shows the stopped worker's icon after a
  // pushState reported as "loading", and on a real new document the extra
  // default setIcon is a no-op. A bare "complete" (no url) adds nothing.
  if (changeInfo.url && !_iconPageUrl.has(tabId)) _iconPageUrl.set(tabId, null);
  _scheduleCurrentTabRefresh(tabId, tab.url);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ active: true, windowId }).then(([tab]) => {
    if (tab?.id) _scheduleCurrentTabRefresh(tab.id, tab.url);
  }).catch(() => {});
});

// P2.7: Clean up per-tab timer when tab closes to prevent Map leak on long sessions.
chrome.tabs.onRemoved.addListener((tabId) => {
  const timer = _checkDebounceTimers.get(tabId);
  if (timer) { clearTimeout(timer); _checkDebounceTimers.delete(tabId); }
  _lastIconState.delete(tabId); // prevent Map leak over long sessions
  _iconPageUrl.delete(tabId);
  _lastCheckedUrl.delete(tabId);
  pbpImgFixSweepRules(tabId);
});

// ---- Image-fix DNR session rules: SW is the sole owner (hotlink round) -----
// md-preview pages ask the SW to install a tab-scoped Referer rule around each
// image re-fetch (md-embed.js pbpImgFixWithReferer). The SW owns this end to
// end for two reasons Codex's reviews made concrete:
//   - Rule ids are EXTENSION-GLOBAL. A page-local counter had every preview tab
//     starting at the same id, so a second tab's remove+add voided the first
//     tab's live rule (confirm-review HIGH-1). Only a single serialized context
//     can hand out ids that are unique across tabs; allocation below runs on a
//     promise chain so two concurrent installs can never pick the same id.
//   - A session rule outlives the page that wanted it. `finally` in the page
//     cannot be the last word (tab closed/navigated/discarded mid-fetch), or a
//     stranded rule would keep rewriting Referer for whatever loads in that tab
//     id NEXT (acceptance HIGH-2). The sweeps below are the guarantee.
// The rule's tab scope comes from sender.tab -- never from the message -- so a
// page cannot request a rule aimed at another tab.
const PBP_IMGFIX_RULE_MIN = 786001;
const PBP_IMGFIX_RULE_MAX = 786999;

// ONE serialized domain for EVERY rule mutation -- install, remove, sweep.
// Serializing only allocation was not enough (confirm-review 2 BLOCKER/HIGH):
//   - install racing a leave-sweep: the sweep read an empty rule set, finished,
//     and THEN the install landed -- stranding a Referer rule on a tab that had
//     already navigated to a normal website, which is exactly the traffic
//     privacy.md promises never to touch;
//   - remove racing anything: its read-owner-then-delete pair was not atomic,
//     so a delayed remove could delete an id that had since been reallocated to
//     a different preview tab.
// Everything below therefore runs inside _imgFixQueue, and install additionally
// re-validates INSIDE the critical section that the tab is still showing the
// preview document it claimed -- a navigation that slipped in before the install
// ran means the rule must never be created at all.
let _imgFixQueue = Promise.resolve();
const _imgFixTabDoc = new Map();    // tabId -> owner preview URL without its #fragment
const _imgFixRuleOwner = new Map(); // ruleId -> owner preview URL (ABA guard on remove)

function _imgFixSerialize(fn) {
  const run = _imgFixQueue.then(fn);
  _imgFixQueue = run.then(() => {}, () => {}); // a failure must not poison the queue
  return run;
}

function _imgFixStripHash(u) {
  const s = String(u || "");
  const i = s.indexOf("#");
  return i === -1 ? s : s.slice(0, i);
}

function _imgFixIsPreviewUrl(u) {
  return typeof u === "string" && u.startsWith(chrome.runtime.getURL("md-preview.html"));
}

function _imgFixRuleIdsOf(rules, pred) {
  return rules
    .filter((r) => r.id >= PBP_IMGFIX_RULE_MIN && r.id <= PBP_IMGFIX_RULE_MAX)
    .filter(pred)
    .map((r) => r.id);
}

function _imgFixRuleTabs(r) {
  return (r.condition && Array.isArray(r.condition.tabIds)) ? r.condition.tabIds : [];
}

// Install: re-validate the tab AND the exact document, pick the lowest free id,
// add the rule -- all in one critical section, so no sweep can interleave.
// initiatorDomains is the STRUCTURAL guarantee (confirm-review 3 HIGH):
// requestDomains + xmlhttprequest + tabIds alone would also match a normal
// website's XHR to the same CDN if that site somehow occupied this tab id
// between the check and the rule taking effect. Pinning the initiator to this
// extension's own id makes a page-originated request unable to match the rule
// at all -- verified live: initiator=extension id -> rule applies (Referer set,
// 200); initiator=any site -> rule does not apply (403, referrerless). The
// navigation sweeps below remain as the resource-cleanup backstop.
function pbpImgFixInstallRule({ domains, origin, tabId, docUrl }) {
  return _imgFixSerialize(async () => {
    // Live re-check (NOT the sender snapshot): if the tab navigated while this
    // request queued, the asking page is gone and the rule must never exist.
    // _cbTabsGet resolves null (lastError consumed) when the tab is gone —
    // which lands in the same throw as "not a preview".
    const live = await _cbTabsGet(tabId);
    if (!live || !_imgFixIsPreviewUrl(live.url)) throw new Error("tab_not_preview");
    const owner = _imgFixStripHash(docUrl || live.url);
    // Same PREVIEW page is not enough -- it must be the same preview DOCUMENT
    // (?k=A vs ?k=B), and a navigation already committed to somewhere else
    // (pendingUrl) disqualifies it too.
    if (_imgFixStripHash(live.url) !== owner) throw new Error("tab_not_preview");
    if (live.pendingUrl && _imgFixStripHash(live.pendingUrl) !== owner) throw new Error("tab_navigating");
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const used = new Set(rules.map((r) => r.id));
    let id = 0;
    for (let i = PBP_IMGFIX_RULE_MIN; i <= PBP_IMGFIX_RULE_MAX; i++) {
      if (!used.has(i)) { id = i; break; }
    }
    if (!id) throw new Error("imgfix_rule_pool_exhausted");
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{
        id,
        priority: 1,
        condition: {
          requestDomains: domains,
          resourceTypes: ["xmlhttprequest"],
          tabIds: [tabId],
          initiatorDomains: [chrome.runtime.id], // only THIS extension's own requests
        },
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "referer", operation: "set", value: origin + "/" }],
        },
      }],
    });
    // Which preview DOCUMENT owns this tab's rules (a later same-document hash
    // change must not sweep) and which document owns each rule id (an ABA
    // guard: a late remove from a dying page must not delete a rule the NEXT
    // document in the same tab was given the recycled id for).
    _imgFixTabDoc.set(tabId, owner);
    _imgFixRuleOwner.set(id, owner);
    return id;
  });
}

// Owner-checked AND atomic: read + delete share one critical section. Ownership
// is (tab, document) -- the tab alone allowed the ABA above (confirm-review 3).
function pbpImgFixRemoveRules(ruleIds, tabId, docUrl) {
  return _imgFixSerialize(async () => {
    const doc = _imgFixStripHash(docUrl || "");
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const mine = _imgFixRuleIdsOf(rules, (r) => {
      if (!ruleIds.includes(r.id) || !_imgFixRuleTabs(r).includes(tabId)) return false;
      const owner = _imgFixRuleOwner.get(r.id);
      return !owner || !doc || owner === doc; // unknown owner (SW restarted) -> fall back to the tab check
    });
    if (mine.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: mine });
      mine.forEach((id) => _imgFixRuleOwner.delete(id));
    }
  });
}

// tabId given -> that tab's rules. No tabId (SW start) -> every rule whose tab
// is gone OR is no longer showing a preview page: a blanket range wipe would
// kill rules a live preview installed while the SW slept, but only checking
// "tab exists" would leave a rule stranded on a tab that has since navigated to
// a normal site (confirm-review 2).
// True once a FULL (no-tabId) sweep has completed successfully in this SW
// generation. The navigation listener's no-owner fast path is only sound when
// the startup sweep really ran: if its getSessionRules/tabs.query threw (the
// catch below swallows it), the owner map is empty and skipping would strand
// leftover rules with no leave-the-page cleanup (Codex review P2).
let _imgFixStartupSweepOk = false;
function pbpImgFixSweepRules(tabId) {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.getSessionRules) return Promise.resolve();
  return _imgFixSerialize(async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    let ids;
    if (tabId === undefined) {
      // K12: ask the browser to pre-filter by URL match pattern instead of
      // serializing every tab in every window to the SW just to throw most of
      // them away. Sandboxed measurement (2026-09-18, chrome-extension://
      // scheme, Chrome 147) confirmed this pattern is accepted and returns the
      // exact same tab set as tabs.query({}) filtered by _imgFixIsPreviewUrl
      // for ?k=-query, #fragment, a non-preview tab, and a Memory-Saver
      // discarded preview tab. tabs.filter(_imgFixIsPreviewUrl) below stays as
      // a fail-safe second check -- the match pattern's path glob and
      // _imgFixIsPreviewUrl's startsWith are not guaranteed identical in every
      // corner (the pattern also ignores the fragment, which is fine: the
      // fragment is stripped right after anyway).
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("md-preview.html") + "*" });
      const previewTabs = new Map(tabs.filter((t) => _imgFixIsPreviewUrl(t.url)).map((t) => [t.id, _imgFixStripHash(t.url)]));
      // Re-seed the document-owner map from the live tabs. Without this, the
      // first hash change after an SW restart would find an unknown owner and
      // sweep a fix that is running perfectly fine (confirm-review 3).
      previewTabs.forEach((doc, id) => { if (!_imgFixTabDoc.has(id)) _imgFixTabDoc.set(id, doc); });
      ids = _imgFixRuleIdsOf(rules, (r) => {
        const t = _imgFixRuleTabs(r);
        return t.length > 0 && t.every((id) => !previewTabs.has(id));
      });
    } else {
      ids = _imgFixRuleIdsOf(rules, (r) => _imgFixRuleTabs(r).includes(tabId));
      _imgFixTabDoc.delete(tabId);
    }
    if (ids.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
      ids.forEach((id) => _imgFixRuleOwner.delete(id));
    }
    if (tabId === undefined) _imgFixStartupSweepOk = true;
  }).catch(() => { /* best-effort: a sweep failure must never break tab handling */ });
}

// A preview tab navigating AWAY is the leak: the tab id stays the same, so a
// stranded rule would otherwise linger there. Same-DOCUMENT changes must NOT
// sweep (every TOC click is a hash change) -- compared against the owning
// document recorded at install time, so a real navigation to a different
// preview document (?k=A -> ?k=B) still sweeps. Unknown owner sweeps: losing a
// rule only makes a fix fail, keeping a wrong one is the problem. A same-URL
// RELOAD never fires changeInfo.url at all -- that case is handled by the
// preview page sweeping its own tab on load (imgFixResetTab below).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const owner = _imgFixTabDoc.get(tabId);
  // No owner = this tab holds no rule in this SW generation, so there is nothing
  // to sweep: the startup sweep below (queued at module evaluation, ahead of any
  // listener work on the same serial queue) already dropped rules for tabs that
  // are gone or no longer previews AND re-seeded owners for live previews.
  // Without this early return, EVERY navigation on EVERY ordinary tab (including
  // pure #anchor jumps and SPA pushState storms) paid a getSessionRules() IPC —
  // and each chrome.* call resets the SW's 30s idle timer, silently defeating
  // the "sleep after the keepalive window lapses" design. Guarded on the
  // startup sweep having actually succeeded: if it threw, the owner map is
  // untrustworthy and we fall back to sweep-on-every-navigation (correctness
  // over the optimization).
  if (!owner && _imgFixStartupSweepOk) return;
  if (_imgFixIsPreviewUrl(changeInfo.url) && _imgFixStripHash(changeInfo.url) === owner) return;
  pbpImgFixSweepRules(tabId);
});

pbpImgFixSweepRules(); // SW start: drop rules whose tab is gone or no longer a preview; re-seed owners

// Dynamic content-script hygiene: md-video.js registers the Bili player
// bridge with persistAcrossSessions:true, so revoking the origin in
// chrome://extensions left the REGISTRATION behind — if that origin were ever
// granted again (user widens site access, a future broader grant), the script
// would resurrect without fresh consent. Drop the registration the moment its
// origin grant goes away. Top-level synchronous registration per MV3 rules;
// the id is shared.js's PBP_BILI_BRIDGE_ID (md-video.js's BILI_BRIDGE_ID
// aliases the same constant -- isolated script contexts, one source of truth).
chrome.permissions.onRemoved.addListener((perms) => {
  const origins = (perms && perms.origins) || [];
  if (origins.some((o) => typeof o === "string" && o.includes("player.bilibili.com"))) {
    chrome.scripting.unregisterContentScripts({ ids: [PBP_BILI_BRIDGE_ID] }).catch(() => {});
  }
});

// ---- Activity-windowed keepalive ------------------------------------------
// Keep the SW (and thus the extension renderer process) warm for a short window
// after the user's last tab/popup activity, so clicking the toolbar icon during
// active browsing opens the popup instantly instead of paying a ~2s cold start.
// After the window lapses with no activity, ping stops and the SW sleeps normally
// (no 24/7 drain). It is the chrome.* API CALL — not setInterval — that resets the
// 30s idle timer (Chrome 110+). If a future Chrome stops honoring this, the SW just
// sleeps = current behavior (graceful, no error).
const KEEPALIVE_WINDOW_MS = 10 * 60 * 1000; // warm for ~10 min after last activity
const KEEPALIVE_PING_MS = 15 * 1000;        // < 30s idle timeout; 2x margin vs timer jitter
let _lastActivityTs = 0;
let _lastActivitySessionWrite = 0;
let _keepAliveTimer = null;

function ensureKeepAlive() {
  if (_keepAliveTimer) return; // already pinging
  if (Date.now() - _lastActivityTs >= KEEPALIVE_WINDOW_MS) return; // window lapsed
  _keepAliveTimer = setInterval(() => {
    if (Date.now() - _lastActivityTs >= KEEPALIVE_WINDOW_MS) {
      // Return BEFORE any chrome.* call, so this tick does NOT reset the idle
      // timer → the SW can go idle and terminate normally. Do NOT add a ping
      // above this guard, or the SW will never sleep.
      clearInterval(_keepAliveTimer);
      _keepAliveTimer = null;
      return;
    }
    // The API call (not setInterval itself) resets the SW idle timer; empty cb is fine in MV3.
    try { chrome.runtime.getPlatformInfo(() => {}); } catch (_) {}
  }, KEEPALIVE_PING_MS);
}

function noteActivity() {
  _lastActivityTs = Date.now();
  // Mirror to session storage (throttled) so a SW restart within the window can
  // resume keepalive even if the restarting event isn't itself a tab event.
  if (_lastActivityTs - _lastActivitySessionWrite > 30000) {
    _lastActivitySessionWrite = _lastActivityTs;
    try { chrome.storage.session.set({ _lastActivityTs }); } catch (_) {}
  }
  ensureKeepAlive();
  // Activity (re)opens the window — make sure the conditional keepalive alarm
  // exists again as the mid-window revival backstop (flag-throttled, so the
  // high-frequency tab-event path pays no alarms.get IPC).
  _ensureKeepaliveAlarmOnce();
}

// On (cold) SW startup, restore last activity and resume keepalive if still in window.
// Use Math.max(): a tab/popup event may cold-start the SW and run noteActivity()
// (setting a fresh in-memory ts) BEFORE this async restore resolves. Without max(),
// the stale session value (0 on a fresh session) would clobber the fresh ts, and the
// next ping tick would see ">= window" and kill the just-started window.
chrome.storage.session.get({ _lastActivityTs: 0 }).then(({ _lastActivityTs: ts }) => {
  _lastActivityTs = Math.max(_lastActivityTs, ts || 0);
  ensureKeepAlive();
}).catch(() => {});
// ---------------------------------------------------------------------------

// Keep service worker alive + periodic tasks. Same-name alarms.create() CANCELS
// and REPLACES the existing alarm, resetting its clock — and this top level runs
// on every SW wake. The keepalive alarm's own 4-min wake therefore kept resetting
// storage-warm's 5-min clock, so storage-warm NEVER fired. Create only when
// absent (same pattern as syncPrewarmTagsAlarm below).
function ensurePeriodicAlarm(name, periodInMinutes) {
  chrome.alarms.get(name).then((existing) => {
    if (!existing) chrome.alarms.create(name, { periodInMinutes });
  }).catch(() => {});
}

// The keepalive alarm is CONDITIONAL, not 24/7. It exists while any of these
// holds: (a) the activity window is open — the alarm is the revival backstop
// for the 15s ping if Chrome reclaims the SW mid-window (memory pressure);
// (b) the offline queue is non-empty — the alarm drives replay; (c) a batch
// is running — the alarm drives the interrupted-batch sweep. When all three
// are false the alarm's own handler clears it, so an idle browser stops
// waking this worker every 4 minutes. Ensure points: SW top level (self-heal
// on any wake), noteActivity, offline-queue writes, batch progress writes —
// a missed wire is repaired on the next SW wake of any kind.
let _keepaliveAlarmEnsured = false;
const KEEPALIVE_PERIOD_MIN = 4;
function _ensureKeepaliveAlarmOnce() {
  if (_keepaliveAlarmEnsured) return;
  _keepaliveAlarmEnsured = true;
  ensurePeriodicAlarm("keepalive", KEEPALIVE_PERIOD_MIN);
}
// (b) counts only queued records the next tick would send
// (pbpOfflineQueueAutoRetries); the current connection is read only when
// the window and the batch leave the answer open. Unknown connection:
// every connection's records count.
async function _keepaliveAlarmStillNeeded() {
  const [stored, sess] = await Promise.all([
    chrome.storage.local.get(["offlineQueue", "batch_progress", PBP_OFFLINE_QUEUE_PAUSE_KEY]),
    chrome.storage.session.get({ _lastActivityTs: 0 }).catch(() => ({ _lastActivityTs: 0 })),
  ]);
  const { offlineQueue = [], batch_progress } = stored;
  const lastTs = Math.max(_lastActivityTs, Number(sess._lastActivityTs) || 0);
  if ((Date.now() - lastTs) < KEEPALIVE_WINDOW_MS || !!(batch_progress && batch_progress.running)) return true;
  if (!Array.isArray(offlineQueue) || !offlineQueue.length) return false;
  const auth = await getCurrentBookmarkAuth().catch(() => null);
  const pause = pbpOfflineQueuePauseShape(stored[PBP_OFFLINE_QUEUE_PAUSE_KEY]);
  return pbpOfflineQueueAutoRetries(offlineQueue, {
    account: auth && typeof auth.account === "string" ? auth.account : null,
    pausedAccount: pause?.account || "",
    until: Date.now() + KEEPALIVE_PERIOD_MIN * 60000,
  });
}
async function _syncKeepaliveAlarm() {
  try {
    if (await _keepaliveAlarmStillNeeded()) _ensureKeepaliveAlarmOnce();
  } catch (_) {}
}
async function _maybeReleaseKeepaliveAlarm() {
  try {
    if (await _keepaliveAlarmStillNeeded()) return;
    // Drop the ensure flag BEFORE clearing, then re-check after: an event
    // landing between the needed-check and clear() (queue write, activity)
    // may have seen the old alarm still present and short-circuited its
    // ensure — without the re-check, the clear would strand that work until
    // the next SW wake (Codex review P2). The re-create path goes through
    // ensurePeriodicAlarm's get-then-create, so a lost race merely leaves
    // the alarm alive one extra cycle — the safe direction.
    _keepaliveAlarmEnsured = false;
    await chrome.alarms.clear("keepalive");
    if (await _keepaliveAlarmStillNeeded()) _ensureKeepaliveAlarmOnce();
  } catch (_) {}
}
// Badge refresh is its own longer-period alarm: it is a NETWORK poll
// (posts/all?toread=yes) and was riding the 4-min keepalive — 360 requests a
// day for badge-on users. 15 min is plenty for an unread count; direct badge
// updates on save/queue events still happen inline.
async function _syncBadgeAlarm() {
  try {
    const s = await loadSettings();
    // Only Pinboard has an unread-count poll; for the self-hosted services
    // updateBadge just clears the badge, so a 15-minute wake would do nothing.
    if (s.optShowBadge && pbpBookmarkServiceId(s) === "pinboard") {
      const existing = await chrome.alarms.get("badge-refresh");
      if (!existing) chrome.alarms.create("badge-refresh", { periodInMinutes: 15 });
    } else {
      await chrome.alarms.clear("badge-refresh");
    }
  } catch (_) {}
}
_syncKeepaliveAlarm();
_syncBadgeAlarm();
// Periodically re-prime SETTINGS_DEFAULTS so chrome.storage doesn't go cold between
// uses (Chrome evicts storage backend after inactivity, causing slow first-open).
ensurePeriodicAlarm("storage-warm", 5);

sweepSuggestCache().catch(() => {});

// One-shot legacy scrub (roadmap #24; retires shared.js's "two-release
// cleanup" TODO): keys-off migration used to strip only the token field,
// leaving a legacy plaintext webhook capability URL in chrome.storage.sync
// indefinitely after the user turned credential sync off. The local-fill
// logic has been shipping since v2.99 (2026-07-28) — far past the
// two-release window it was waiting for — so every active device holds its
// own local copy. Flag-gated one-shot; a failure retries on the next SW
// evaluation. Retire by 2026-12-31 (.claude/expiring-items.md).
async function pbpScrubLegacySyncWebhookUrls() {
  try {
    const { _webhookSyncScrubDone } = await chrome.storage.local.get("_webhookSyncScrubDone");
    if (_webhookSyncScrubDone) return;
    await pbpWithSecretStorageLock(async () => {
      // Re-read INSIDE the lock. keys-on means the sync copy is LIVE data
      // owned by credential sync — nothing to scrub (a later keys-off runs
      // pbpDisableSyncApiKeys' full strip anyway), just mark done.
      const flags = await pbpReadSecretSyncStateUnlocked({ includeGlobalWhenSyncOff: true });
      if (!flags.syncApiKeys) {
        const { exportTargets } = await chrome.storage.sync.get("exportTargets");
        if (pbpExportTargetsHaveSecrets(exportTargets)) {
          // Rescue before scrub: fill any secret slot local does not hold, so
          // this scrub can never destroy the account's last copy.
          const { exportTargets: localTargets } = await chrome.storage.local.get("exportTargets");
          const filled = pbpMergeExportTargetSecrets(localTargets, exportTargets, { fillWins: false });
          await chrome.storage.local.set({ exportTargets: filled });
          await chrome.storage.sync.set({ exportTargets: pbpStripExportTargetTokens(exportTargets) });
          console.info("[secrets-migration] legacy sync webhook capability URLs scrubbed");
        }
      }
      await chrome.storage.local.set({ _webhookSyncScrubDone: true });
    });
  } catch (e) {
    console.warn("legacy webhook sync scrub failed:", e?.name, e?.message);
  }
}
pbpScrubLegacySyncWebhookUrls();

// One-shot claim migration (roadmap #19, approved 2026-08-29): pre-existing
// highlight items carry no owner field — claim them for the CURRENT Pinboard
// account so the new per-account visibility rule has a defined baseline
// (mirrors the offline queue's legacy-token rewrite). Waits until an account
// exists: logged-out leaves items unclaimed (= visible to all) and re-checks
// cheaply on later SW evaluations. Each record's read-modify-write holds the
// same per-record Web Lock the reader's commit path uses ("pbp-hl:<key>"), so
// a concurrent highlight save cannot be clobbered. Retire by 2026-12-31
// (.claude/expiring-items.md, flag _hlOwnerClaimDone).
async function pbpClaimLegacyHighlightOwners() {
  try {
    const { _hlOwnerClaimDone } = await chrome.storage.local.get("_hlOwnerClaimDone");
    if (_hlOwnerClaimDone) return;
    const scope = await pbpVocabCurrentOwner();
    if (!scope || scope === "ownerless") return; // no account yet — retry on a later wake
    let keys;
    if (typeof chrome.storage.local.getKeys === "function") {
      keys = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith("pbp_hl_") && k !== "pbp_hl_last_color");
    } else {
      keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("pbp_hl_") && k !== "pbp_hl_last_color");
    }
    let claimed = 0;
    let aborted = false;
    for (const key of keys) {
      await navigator.locks.request("pbp-hl:" + key, async () => {
        // Per-write owner re-validation (Codex review; CLAUDE.md: async
        // write-backs re-check the owner EVERY time): an account switch
        // mid-walk must not keep claiming records for the departed account.
        // Abort without the done flag — the next wake retries cleanly.
        if ((await pbpVocabCurrentOwner()) !== scope) { aborted = true; return; }
        const d = await chrome.storage.local.get(key);
        const rec = d && d[key];
        if (!rec || typeof rec !== "object" || Array.isArray(rec) || !Array.isArray(rec.items)) return;
        let changed = false;
        const items = rec.items.map((it) => {
          if (it && typeof it === "object" && !Array.isArray(it) && typeof it.owner !== "string") {
            changed = true;
            return { ...it, owner: scope };
          }
          return it;
        });
        if (changed) { await chrome.storage.local.set({ [key]: { ...rec, items } }); claimed++; }
      });
      if (aborted) break;
    }
    if (aborted) {
      console.warn("[hl-owner] claim aborted: account changed mid-walk; will retry");
      return;
    }
    // Final gate before the flag for the same reason.
    if ((await pbpVocabCurrentOwner()) !== scope) return;
    await chrome.storage.local.set({ _hlOwnerClaimDone: true });
    if (claimed) console.info(`[hl-owner] claimed legacy highlight items on ${claimed} page record(s)`);
  } catch (e) {
    console.warn("highlight owner claim failed:", e?.name, e?.message);
  }
}
pbpClaimLegacyHighlightOwners();

// Conditional site-theme payload (roadmap #37, dynamic-registration variant):
// pinboard-themes.js is a 704KB generated constant that every pinboard.in
// navigation used to parse at document_start — to read ONE of its 13 css
// strings, and only when a preset is set at all (themePresetKey defaults to
// ""). It is now statically absent from the manifest and registered here only
// while a preset is active, so the DEFAULT configuration pays nothing.
// pinboard-style.js already typeof-guards PINBOARD_THEMES, and its consumers
// run in async storage callbacks, so relative execution order between the
// static and dynamic document_start scripts never matters. The full
// css-as-files split was deliberately NOT done: it would re-anchor five
// theme-factory gates (apply-tokens/diff-all/cascade-lint/handedit-audit/
// override-drift all parse pinboard-themes.js) for marginal further gain.
const PBP_SITE_THEME_SCRIPT_ID = "pbp-site-theme-css";
// Serialized (Codex final review): two overlapping syncs could commit the
// OLDER settings' registration state (classic check-then-act). The tail chain
// makes each run re-read settings after its predecessor finished, so the last
// completed run always reflects the latest value.
let _siteThemeSyncTail = Promise.resolve();
function pbpSyncSiteThemeScript() {
  const run = _siteThemeSyncTail.then(() => _pbpSyncSiteThemeScriptOnce());
  _siteThemeSyncTail = run.catch(() => {});
  return run;
}
async function _pbpSyncSiteThemeScriptOnce() {
  try {
    if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;
    const s = await loadSettings();
    const wantTheme = !!(s && s.themePresetKey);
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [PBP_SITE_THEME_SCRIPT_ID] }).catch(() => []);
    const has = !!(existing && existing.length);
    if (wantTheme && !has) {
      await chrome.scripting.registerContentScripts([{
        id: PBP_SITE_THEME_SCRIPT_ID,
        matches: ["https://pinboard.in/*", "https://*.pinboard.in/*"],
        js: ["pinboard-themes.js"],
        runAt: "document_start",
        world: "ISOLATED",
        persistAcrossSessions: true,
      }]);
    } else if (!wantTheme && has) {
      await chrome.scripting.unregisterContentScripts({ ids: [PBP_SITE_THEME_SCRIPT_ID] });
    }
  } catch (e) {
    console.warn("site-theme script sync failed:", e?.name, e?.message);
  }
}
pbpSyncSiteThemeScript();

// Trusted-only storage (roadmap #36): content scripts lose direct read access
// to local/sync — the same areas that hold the Pinboard token and every BYO
// API key. The pinboard.in scripts now fetch their handful of non-secret
// prefs through the get_site_prefs message (allowlisted in the router gate),
// so a content-script compromise no longer implies a credential read.
// session is TRUSTED_CONTEXTS by default already. Top-level, every SW eval —
// setAccessLevel is per-session state, so it must be re-asserted on wake.
const PBP_STORAGE_ACCESS_RETRY_ALARM = "storage-access-retry";
// Retry budget for that alarm. The count lives in storage.session, not in a
// module variable: every retry wakes a FRESH worker generation, so an in-memory
// counter restarts at zero each time and a permanently failing platform call
// (the API missing on this Chrome build, an enterprise policy refusal) re-arms
// the one-shot alarm every minute for as long as the browser runs — waking the
// worker and re-running the whole boot sequence with it. Session scope is the
// right lifetime: a browser restart may well be a new Chrome build, so the
// budget starts over then. Giving up is an acceptable end state — the
// pinboard.in content scripts read their prefs through get_site_prefs and no
// longer touch storage directly, so trusted-only is defense in depth here.
const PBP_STORAGE_ACCESS_RETRY_KEY = "_storageAccessRetries";
const PBP_STORAGE_ACCESS_MAX_RETRIES = 5;

async function pbpStorageAccessRetryCount() {
  try {
    const stored = await chrome.storage.session.get({ [PBP_STORAGE_ACCESS_RETRY_KEY]: 0 });
    return Number(stored?.[PBP_STORAGE_ACCESS_RETRY_KEY]) || 0;
  } catch (e) {
    // Unknown count: fail toward retrying (a session-storage failure is itself
    // the transient kind), but leave the trace MV3 requires.
    console.warn("[storage-access] retry counter read failed:", e?.name, e?.message);
    return 0;
  }
}

async function pbpRestrictStorageAccess() {
  let failed = false;
  for (const name of ["local", "sync"]) {
    try {
      await chrome.storage[name].setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    } catch (e) {
      failed = true;
      // Name/message only: storage errors carry no setting values or secrets.
      console.warn(`[storage-access] ${name} trusted-only failed:`, e?.name, e?.message);
    }
  }
  if (failed) {
    const attempt = await pbpStorageAccessRetryCount();
    if (attempt >= PBP_STORAGE_ACCESS_MAX_RETRIES) {
      console.warn(`[storage-access] trusted-only still unavailable after ${attempt} retries; not rescheduling`);
      return false;
    }
    try { await chrome.storage.session.set({ [PBP_STORAGE_ACCESS_RETRY_KEY]: attempt + 1 }); }
    catch (e) { console.warn("[storage-access] retry counter write failed:", e?.name, e?.message); }
    try {
      // One-shot and same-name: repeated failures replace rather than stack.
      // Exponential backoff (1, 2, 4, 8, 16 minutes) because a failure that
      // outlives the first minute is usually the permanent kind.
      await chrome.alarms.create(PBP_STORAGE_ACCESS_RETRY_ALARM, {
        delayInMinutes: Math.min(30, 2 ** attempt),
      });
    } catch (e) {
      console.warn("[storage-access] retry scheduling failed:", e?.name, e?.message);
    }
    return false;
  }
  try { await chrome.alarms.clear(PBP_STORAGE_ACCESS_RETRY_ALARM); }
  catch (e) { console.warn("[storage-access] retry cleanup failed:", e?.name, e?.message); }
  try {
    // Read-then-remove: success is the every-wake path, so it must not write.
    if (await pbpStorageAccessRetryCount() > 0) {
      await chrome.storage.session.remove(PBP_STORAGE_ACCESS_RETRY_KEY);
    }
  } catch (e) { console.warn("[storage-access] retry counter cleanup failed:", e?.name, e?.message); }
  return true;
}
// Re-assert trusted-only storage on every SW generation. A transient platform
// failure keeps at most one same-name one-shot retry scheduled; neither path
// keeps the worker awake or stacks alarms.
pbpRestrictStorageAccess().catch((e) => {
  console.warn("[storage-access] setup failed:", e?.name, e?.message);
});

// Security-first permission migration. Older Batch versions could leave the
// optional all-sites grant active. Removing it also clears matching exact
// optional grants in Chrome, so configurations stay untouched and each feature
// restores only its current origin on the next explicit action. A click racing
// this one-time cleanup may need one retry; every execution path rechecks access
// before network or cross-tab work, so the race fails closed.
const PBP_LEGACY_WILDCARD_CLEANUP_KEY = "_legacyWildcardCleanupV1";
async function pbpMigrateLegacyWildcardPermission() {
  const stored = await chrome.storage.local.get(PBP_LEGACY_WILDCARD_CLEANUP_KEY);
  if (stored[PBP_LEGACY_WILDCARD_CLEANUP_KEY] === true) return;
  const wildcard = "*://*/*";
  let active = await chrome.permissions.contains({ origins: [wildcard] });
  if (active) {
    await chrome.permissions.remove({ origins: [wildcard] });
    active = await chrome.permissions.contains({ origins: [wildcard] });
  }
  if (!active) {
    await chrome.storage.local.set({ [PBP_LEGACY_WILDCARD_CLEANUP_KEY]: true });
  }
}
pbpMigrateLegacyWildcardPermission().catch(() => {});

// Credential-routing maintenance (batch (4)): idempotent, best-effort,
// fire-and-forget at boot. It mirrors the last keys-on cloud snapshot locally
// and, while keys are off, migrates/scrubs any stale cloud secret. The existing
// storage-warm alarm retries either direction within 5 minutes.
pbpMigrateSecretsToLocal().catch(() => {});

const PBP_VOCAB_DRIVE_CONNECTED_KEY = "vocabDriveConnected";
const PBP_DRIVE_CONNECTION_ACCOUNT_KEY = "driveConnectionAccount";
const PBP_GOOGLE_API_ORIGIN = "https://www.googleapis.com/*";
const PBP_VOCAB_DRIVE_CAPABLE =
  pbpVocabDriveOAuthActive(chrome.runtime.getManifest());
// One queue runs every Drive round: vocabulary, notes, dictionary output and Ask history.
const queueDriveSync = pbpCreateRecoveringTail();
// One epoch for the whole Drive connection. It invalidates only jobs in this
// worker generation; the durable connected flag remains in local storage and
// is still reread at every asynchronous boundary.
let driveScopeEpoch = 0;
// Rounds are serial, so at most one dataset session is ever in flight. The
// slot names the dataset that is running and the Google account it bound;
// pbpRunDriveDataset sets it per dataset and empties it when that run ends.
const driveSession = { type: "", permissionId: "", identityVersion: 0, auth: null };
let driveIdentityVersion = 0;
let driveVerifiedPermissionId = "";
function pbpDriveSessionOpened(permissionId) {
  driveSession.permissionId = permissionId;
  if (driveSession.identityVersion !== driveIdentityVersion &&
      permissionId !== driveVerifiedPermissionId) driveScopeEpoch++;
}
// exemptInFlight: the caller is refreshing the identity of the session that
// just finished, which must not cancel itself.
function pbpObserveDriveIdentity(permissionId, exemptInFlight = false) {
  if (permissionId !== driveVerifiedPermissionId) {
    driveVerifiedPermissionId = permissionId; driveIdentityVersion++;
  }
  if (!exemptInFlight && driveSession.permissionId &&
      driveSession.permissionId !== permissionId) driveScopeEpoch++;
}
chrome.permissions.onRemoved?.addListener((removed) => {
  if (removed.permissions?.includes("identity") || removed.origins?.includes(PBP_GOOGLE_API_ORIGIN)) {
    driveScopeEpoch++;
    try { pbpVocabDriveForgetIdentity(); }
    catch (e) { console.warn("[drive-sync] identity cache reset failed:", e?.name, e?.message); }
  }
});

async function pbpVocabDriveIsConnected() {
  if (!PBP_VOCAB_DRIVE_CAPABLE) return false;
  const stored = await chrome.storage.local.get(PBP_VOCAB_DRIVE_CONNECTED_KEY);
  return stored[PBP_VOCAB_DRIVE_CONNECTED_KEY] === true;
}

// Connected means all datasets sync; there is no per-dataset switch.
async function pbpDriveEnabled() {
  if (!await pbpVocabDriveIsConnected()) return false;
  if (!await chrome.permissions.contains({
    permissions: ["identity"], origins: [PBP_GOOGLE_API_ORIGIN]
  })) return false;
  // Reread after the permission await: a Disconnect landing in between wins.
  return pbpVocabDriveIsConnected();
}

const vocabDriveClient = PBP_VOCAB_DRIVE_CAPABLE
  ? pbpCreateVocabDriveClient({ beforeRequest: pbpDriveEnabled }) : null;
const notesDriveClient = PBP_VOCAB_DRIVE_CAPABLE
  ? pbpCreateVocabDriveClient({ protocol: PBP_NOTES_DRIVE_PROTOCOL,
      beforeRequest: pbpDriveEnabled }) : null;
const dictArchiveDriveClient = PBP_VOCAB_DRIVE_CAPABLE
  ? pbpCreateVocabDriveClient({ protocol: PBP_DICT_ARCHIVE_DRIVE_PROTOCOL,
      beforeRequest: pbpDriveEnabled }) : null;
const askArchiveDriveClient = PBP_VOCAB_DRIVE_CAPABLE
  ? pbpCreateVocabDriveClient({ protocol: PBP_ASK_ARCHIVE_DRIVE_PROTOCOL,
      beforeRequest: pbpDriveEnabled }) : null;
// Used only by the explicit Connect action, which authorizes before any round.
const driveConnectClient = PBP_VOCAB_DRIVE_CAPABLE ? pbpCreateVocabDriveClient() : null;
async function pbpNotesDriveCurrentOwner({ requireDriveAccount = true, dataset = "notes" } = {}) {
  if (!await pbpDriveEnabled()) return "";
  const session = driveSession.type === dataset ? driveSession : null;
  const auth = await getCurrentLibraryAuth();
  if (!auth?.account || !pbpLibraryAuthIsCurrent(auth) ||
      (session?.auth && (!pbpLibraryAuthIsCurrent(session.auth) ||
        auth.account !== session.auth.account))) return "";
  if (requireDriveAccount && session?.permissionId) {
    const current = await (dataset === "ask" ? askArchiveDriveClient : dataset === "dictionary" ? dictArchiveDriveClient : notesDriveClient).about();
    if (!current.ok) {
      const error = new Error("Drive identity verification unavailable");
      error.code = current.error || "remote";
      error.retryable = current.retryable === true;
      throw error;
    }
    if (current.permissionId !== session.permissionId) return "";
  }
  if (!await pbpDriveEnabled() || !pbpLibraryAuthIsCurrent(auth)) return "";
  return pbpDictOwnerScope(auth.account);
}

// Shared connection-layer state, one record per Pinboard owner. Runners read
// and write it only through this store; a write lands only while the round
// that started it is still current for the same owner and epoch.
const PBP_DRIVE_CONN_STATE_PREFIX = "driveConnState:";
let driveRoundContext = null;
function pbpDriveNormalizeConnState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const count = (value) => Number.isInteger(value) && value >= 0 ? value : 0;
  const lastError = PBP_DRIVE_CONNECTION_ERRORS.has(state.lastError) ? state.lastError : null;
  return {
    lastError,
    authAttempts: count(state.authAttempts),
    retryAttempt: count(state.retryAttempt),
    retryAt: Number.isFinite(state.retryAt) ? state.retryAt : null,
    blocked: lastError !== null && state.blocked === true,
    updatedAt: Number.isFinite(state.updatedAt) ? state.updatedAt : 0
  };
}
// Throws when chrome.storage.local cannot be read: the status and the alarm
// reconciliation must tell "no record" from "unreadable".
async function pbpDriveReadConnState(ownerHash) {
  if (!/^[0-9a-f]{64}$/.test(ownerHash)) return null;
  const key = PBP_DRIVE_CONN_STATE_PREFIX + ownerHash;
  const stored = await chrome.storage.local.get(key);
  return pbpDriveNormalizeConnState(stored?.[key]);
}
const driveConnectionStore = {
  // Spec §10.4: a runner that cannot read the record runs as if there were
  // none -- one extra round of requests at worst -- instead of filing a
  // local_store block that only Sync now would clear.
  async get(ownerHash) {
    try {
      return await pbpDriveReadConnState(ownerHash);
    } catch (e) {
      console.warn("[drive-sync] connection state read failed:", e?.name, e?.message);
      return null;
    }
  },
  async put(ownerHash, state) {
    const context = driveRoundContext;
    if (!context || context.ownerHash !== ownerHash || context.epoch !== driveScopeEpoch) return false;
    const current = await getCurrentLibraryAuth().catch((e) => {
      console.warn("[drive-sync] connection state owner check failed:", e?.name, e?.message);
      return null;
    });
    if (!current?.account || current.account !== context.auth?.account ||
        !pbpLibraryAuthIsCurrent(context.auth) || !pbpLibraryAuthIsCurrent(current) ||
        context.epoch !== driveScopeEpoch || driveRoundContext !== context) return false;
    const key = PBP_DRIVE_CONN_STATE_PREFIX + ownerHash;
    try {
      if (state === null) {
        await chrome.storage.local.remove(key);
      } else {
        const normalized = pbpDriveNormalizeConnState(state);
        if (!normalized) return false;
        await chrome.storage.local.set({ [key]: { ...normalized, updatedAt: Date.now() } });
      }
      return true;
    } catch (e) {
      console.warn("[drive-sync] connection state write failed:", e?.name, e?.message);
      return false;
    }
  }
};

const notesDriveStore = PBP_VOCAB_DRIVE_CAPABLE
  ? pbpCreateNotesSyncStore({ getCurrentOwner: pbpNotesDriveCurrentOwner }) : null;
const dictArchiveDriveStore = PBP_VOCAB_DRIVE_CAPABLE
  ? pbpCreateDictArchiveStore({
      getCurrentOwner: options => pbpNotesDriveCurrentOwner({ ...options, dataset: "dictionary" }),
      getWriteGuard: () => {
        const epoch = driveScopeEpoch, auth = driveSession.auth;
        return () => driveScopeEpoch === epoch && (!auth || pbpLibraryAuthIsCurrent(auth));
      }
    }) : null;
const askArchiveDriveStore = PBP_VOCAB_DRIVE_CAPABLE
  ? pbpCreateAskArchiveStore({
      getCurrentOwner: options => pbpNotesDriveCurrentOwner({ ...options, dataset: "ask" }),
      getWriteGuard: () => {
        const epoch = driveScopeEpoch, auth = driveSession.auth;
        return () => driveScopeEpoch === epoch && (!auth || pbpLibraryAuthIsCurrent(auth));
      }
    }) : null;
const runVocabDriveSync = PBP_VOCAB_DRIVE_CAPABLE
  ? pbpCreateVocabDriveSyncRunner({
      client: vocabDriveClient,
      getCurrentLibraryAuth,
      libraryAuthIsCurrent: pbpLibraryAuthIsCurrent,
      isEnabled: pbpDriveEnabled,
      getScopeEpoch: () => driveScopeEpoch,
      onSession: pbpDriveSessionOpened,
      connection: driveConnectionStore,
      getCurrentPermissionId: async () => {
        return vocabDriveClient.about();
      }
    }) : null;
const runNotesDriveSync = PBP_VOCAB_DRIVE_CAPABLE
  ? pbpCreateNotesDriveSyncRunner({
      client: notesDriveClient, store: notesDriveStore,
      getCurrentLibraryAuth,
      libraryAuthIsCurrent: pbpLibraryAuthIsCurrent,
      isEnabled: pbpDriveEnabled,
      getScopeEpoch: () => driveScopeEpoch,
      onSession: pbpDriveSessionOpened,
      connection: driveConnectionStore,
      getCurrentPermissionId: async () => {
        return notesDriveClient.about();
      }
    }) : null;

const runDictArchiveDriveSync = PBP_VOCAB_DRIVE_CAPABLE
  ? pbpCreateDictArchiveDriveSyncRunner({
      client: dictArchiveDriveClient, store: dictArchiveDriveStore,
      getCurrentLibraryAuth, libraryAuthIsCurrent: pbpLibraryAuthIsCurrent,
      isEnabled: pbpDriveEnabled, getScopeEpoch: () => driveScopeEpoch,
      onSession: pbpDriveSessionOpened, connection: driveConnectionStore,
      getCurrentPermissionId: () => dictArchiveDriveClient.about()
    }) : null;

const runAskArchiveDriveSync = PBP_VOCAB_DRIVE_CAPABLE
  ? pbpCreateAskArchiveDriveSyncRunner({
      client: askArchiveDriveClient, store: askArchiveDriveStore,
      getCurrentLibraryAuth, libraryAuthIsCurrent: pbpLibraryAuthIsCurrent,
      isEnabled: pbpDriveEnabled, getScopeEpoch: () => driveScopeEpoch,
      onSession: pbpDriveSessionOpened, connection: driveConnectionStore,
      getCurrentPermissionId: () => askArchiveDriveClient.about()
    }) : null;

// One notification per round, on a false -> true edge only. showNotification
// suffixes its id with a timestamp, so the edge is the only dedupe there is.
async function pbpAnnounceDriveBlocked(before, after) {
  const rose = ["connection", "vocabulary", "notes", "dictionary", "ask"].some((name) =>
    before?.[name]?.known === true && before[name].blocked === false &&
    after?.[name]?.known === true && after[name].blocked === true);
  if (!rose) return false;
  await showNotification("drive-sync-blocked", t("extName"), t("vocabDriveBlockedNotice"), "error");
  return true;
}

function pbpBroadcastVocabSynced(owner, type = "vocabulary") {
  try {
    const pending = chrome.runtime.sendMessage({
      type: type === "ask" ? "PBP_ASK_ARCHIVE_SYNCED" : type === "notes" ? "PBP_NOTES_SYNCED" : type === "dictionary" ? "PBP_DICT_ARCHIVE_SYNCED" : "PBP_VOCAB_SYNCED", owner
    });
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch (_) {}
}

async function pbpRefreshDriveConnectionAccount(type, auth, confirmedState) {
  if (typeof confirmedState?.drivePermissionId !== "string" || !confirmedState.drivePermissionId) return { ok: true };
  const scopeEpoch = driveScopeEpoch;
  if (!await pbpDriveEnabled()) return { ok: false, error: "account_changed" };
  const verified = await (type === "ask" ? askArchiveDriveClient : type === "notes" ? notesDriveClient : type === "dictionary" ? dictArchiveDriveClient : vocabDriveClient).about();
  if (!verified.ok) return verified;
  if (verified.permissionId !== confirmedState.drivePermissionId) return { ok: false, error: "account_changed" };
  if (!await pbpDriveEnabled()) return { ok: false, error: "account_changed" };
  const currentAuth = await getCurrentLibraryAuth();
  if (!auth?.account || currentAuth?.account !== auth.account || !pbpLibraryAuthIsCurrent(auth) ||
      !pbpLibraryAuthIsCurrent(currentAuth) || driveScopeEpoch !== scopeEpoch) {
    return { ok: false, error: "account_changed" };
  }
  // The session that just finished is exempt; a Connect that observed a
  // different Google account meanwhile has already bumped the epoch above.
  pbpObserveDriveIdentity(verified.permissionId, true);
  try {
    await chrome.storage.local.set({ [PBP_DRIVE_CONNECTION_ACCOUNT_KEY]: {
      permissionId: verified.permissionId,
      emailAddress: verified.emailAddress || "", displayName: verified.displayName || ""
    } });
    return { ok: true };
  } catch (error) {
    console.warn("[drive-sync] connection identity write failed:", error?.name, error?.message);
    return { ok: false, error: "local_store" };
  }
}

// Preflight rows written before the shared connection record existed may
// still carry a connection-layer code; those belong to driveConnState now.
function pbpDriveDataLayerState(preflight) {
  if (!preflight || typeof preflight.lastError !== "string" ||
      PBP_DRIVE_CONNECTION_ERRORS.has(preflight.lastError)) return { blocked: false, retryAt: null };
  const blocked = preflight.blocked === true;
  return { blocked, retryAt: !blocked && Number.isFinite(preflight.retryAt) ? preflight.retryAt : null };
}
async function pbpDriveReadRoundState(ownerHash) {
  const reads = await Promise.allSettled([
    pbpDriveReadConnState(ownerHash),
    pbpVocabGetPreflightState(ownerHash),
    notesDriveStore.getPreflightState(ownerHash),
    dictArchiveDriveStore.getPreflightState(ownerHash),
    askArchiveDriveStore.getPreflightState(ownerHash)
  ]);
  const shape = (read, label, toState) => {
    if (read.status === "rejected") {
      console.warn("[drive-sync] round state unavailable:", label, read.reason?.name, read.reason?.message);
      return { known: false, blocked: false, retryAt: null };
    }
    return { known: true, ...toState(read.value) };
  };
  return {
    connection: shape(reads[0], "connection", (row) => ({
      blocked: row?.blocked === true,
      retryAt: row && row.blocked !== true && Number.isFinite(row.retryAt) ? row.retryAt : null
    })),
    vocabulary: shape(reads[1], "vocabulary", pbpDriveDataLayerState),
    notes: shape(reads[2], "notes", pbpDriveDataLayerState),
    dictionary: shape(reads[3], "dictionary", pbpDriveDataLayerState),
    ask: shape(reads[4], "ask", pbpDriveDataLayerState)
  };
}

async function pbpClearDriveAlarms() {
  await Promise.all([PBP_DRIVE_DIRTY_ALARM, PBP_DRIVE_PERIODIC_ALARM, PBP_DRIVE_RETRY_ALARM]
    .map((name) => chrome.alarms.clear(name)));
}

// A data-layer backoff that came due while a long round ran was never served:
// its runner saw it still pending. It is re-armed this far ahead -- the same
// 30 s as the dirty alarm, and Chrome's own floor for packed extensions.
const PBP_DRIVE_OVERDUE_RETRY_MS = 30 * 1000;

// Runners never touch alarms; every round ends here. A data-layer block never
// clears periodic or dirty, so one stuck dataset cannot starve the other.
async function pbpReconcileDriveAlarms() {
  if (!PBP_VOCAB_DRIVE_CAPABLE) return null;
  if (!await pbpDriveEnabled()) { await pbpClearDriveAlarms(); return null; }
  const auth = await getCurrentLibraryAuth().catch((e) => {
    console.warn("[drive-sync] alarm reconcile owner read failed:", e?.name, e?.message);
    return null;
  });
  const ownerHash = auth?.account && pbpLibraryAuthIsCurrent(auth)
    ? await pbpVocabOwnerHash(pbpDictOwnerScope(auth.account)).catch((e) => {
      console.warn("[drive-sync] alarm reconcile owner hash failed:", e?.name, e?.message);
      return "";
    }) : "";
  if (!ownerHash) {
    // No Pinboard owner yet: nothing is blocked or backing off, and the
    // periodic alarm is what picks the device up after sign-in.
    await pbpDriveEnsurePeriodic(chrome.alarms);
    return null;
  }
  const state = await pbpDriveReadRoundState(ownerHash);
  if (!await pbpDriveEnabled()) { await pbpClearDriveAlarms(); return null; }
  const rows = [state.connection, state.vocabulary, state.notes, state.dictionary, state.ask];
  const connectionBlocked = state.connection.known && state.connection.blocked;
  const datasetsBlocked = state.vocabulary.known && state.vocabulary.blocked &&
    state.notes.known && state.notes.blocked && state.dictionary.known && state.dictionary.blocked &&
    state.ask.known && state.ask.blocked;
  if (connectionBlocked || datasetsBlocked) await chrome.alarms.clear(PBP_DRIVE_PERIODIC_ALARM);
  else await pbpDriveEnsurePeriodic(chrome.alarms);
  const now = Date.now();
  // While the shared connection still backs off, every dataset waits for it,
  // so an overdue data-layer backoff adds nothing but a round that can only
  // wait again. An expired connection retryAt is left out: the next round's
  // openSession clears or renews it.
  const connectionWaiting = state.connection.known &&
    Number.isFinite(state.connection.retryAt) && state.connection.retryAt > now;
  const due = connectionBlocked ? [] : rows
    .filter((row) => row.known && !row.blocked && Number.isFinite(row.retryAt))
    .map((row) => row.retryAt > now ? row.retryAt
      : (row !== state.connection && !connectionWaiting ? now + PBP_DRIVE_OVERDUE_RETRY_MS : null))
    .filter(Number.isFinite);
  if (due.length) {
    const when = Math.min(...due);
    let keepExisting = false;
    if (!rows.every((row) => row.known)) {
      // An unreadable row may be what armed the existing alarm: only ever move
      // retry earlier, never past a backoff this read could not see.
      try {
        const existing = await chrome.alarms.get(PBP_DRIVE_RETRY_ALARM);
        keepExisting = Number.isFinite(existing?.scheduledTime) && existing.scheduledTime <= when;
      } catch (e) {
        console.warn("[drive-sync] retry alarm read failed:", e?.name, e?.message);
      }
    }
    if (!keepExisting) await chrome.alarms.create(PBP_DRIVE_RETRY_ALARM, { when });
  } else if (connectionBlocked || rows.every((row) => row.known)) {
    // An unreadable row might still hold a backoff: keep its alarm.
    await chrome.alarms.clear(PBP_DRIVE_RETRY_ALARM);
  }
  return { ownerHash, state };
}

async function pbpRunDriveDataset(type, auth, ownerScope, runOptions) {
  driveSession.type = type;
  driveSession.permissionId = "";
  driveSession.identityVersion = driveIdentityVersion;
  driveSession.auth = auth;
  try {
    let result;
    try {
      result = await (type === "ask" ? runAskArchiveDriveSync : type === "notes" ? runNotesDriveSync : type === "dictionary" ? runDictArchiveDriveSync : runVocabDriveSync)(runOptions);
    } catch (error) {
      console.warn("[drive-sync] dataset run failed:", type, error?.name, error?.message);
      result = null;
    }
    if (!result || typeof result !== "object") result = { ok: false, error: "unexpected", retryable: true };
    if (result.ok && result.changed && auth && pbpLibraryAuthIsCurrent(auth)) {
      pbpBroadcastVocabSynced(ownerScope, type);
    }
    if (result.ok && !result.status?.waitingForRetry) {
      let refreshed;
      try {
        refreshed = await pbpRefreshDriveConnectionAccount(type, auth, result.status);
      } catch (error) {
        // Same answer as a runner's own uncaught exception, so the round's
        // tail (alarm reconciliation, the notification) still runs.
        console.warn("[drive-sync] connection identity refresh failed:", type, error?.name, error?.message);
        refreshed = { ok: false, error: "unexpected", retryable: true };
      }
      if (!refreshed?.ok) result = { ...refreshed, changed: result.changed, status: result.status };
    }
    return result;
  } finally {
    driveSession.type = ""; driveSession.permissionId = ""; driveSession.auth = null;
  }
}

const PBP_DRIVE_CONTROL_ERRORS = new Set(["account_changed", "pinboard_auth", "not_connected"]);
// A later dataset opens no session after a shared connection failure or a
// cancelled/ownerless round.
function pbpDriveRoundSkip(vocabulary, roundEpoch) {
  if (driveScopeEpoch !== roundEpoch) {
    return { ok: false, error: "account_changed", retryable: false, skipped: true };
  }
  if (!vocabulary.ok && (PBP_DRIVE_CONNECTION_ERRORS.has(vocabulary.error) ||
      PBP_DRIVE_CONTROL_ERRORS.has(vocabulary.error))) {
    return { ok: false, error: vocabulary.error, retryable: vocabulary.retryable === true, skipped: true };
  }
  if (vocabulary.ok && vocabulary.status?.connectionWaiting === true) {
    return { ok: true, skipped: true, status: { waitingForRetry: true, connectionWaiting: true,
      retryAt: Number.isFinite(vocabulary.status.retryAt) ? vocabulary.status.retryAt : null } };
  }
  return null;
}
function pbpDriveRoundOutcome(results) {
  const rows = [results.vocabulary, results.notes, results.dictionary, results.ask].filter(Boolean);
  const failed = rows.find((row) => !row.ok && PBP_DRIVE_CONNECTION_ERRORS.has(row.error)) ||
    rows.find((row) => !row.ok && PBP_DRIVE_CONTROL_ERRORS.has(row.error)) ||
    rows.find((row) => !row.ok);
  if (failed) {
    return { ok: false, error: failed.error || "remote", retryable: failed.retryable === true, results };
  }
  if (rows.some((row) => row.status?.waitingForRetry === true)) {
    return { ok: false, error: "waiting_for_retry", waitingForRetry: true, results };
  }
  return { ok: true, results };
}

// Spec §10.5: with its preflight gone, a dataset's status falls back to its
// account row, so a notes half the forced round skips would keep showing the
// data-layer error the user just forced past. Only the error fields go; the
// cursor, bootstrap state and backoff count stay.
async function pbpDriveClearAccountRowErrors(ownerScope, ownerHash) {
  const stale = (row) => !!row && (row.lastError != null || row.retryAt != null);
  const cleared = (row) => ({ ...row, lastError: null, retryAt: null });
  // Each side is read and cleared on its own: one dataset's unreadable store
  // must not leave the other dataset's stale errors in place.
  const sides = await Promise.allSettled([
    (async () => {
      const rows = await pbpVocabListAccountStates(ownerHash);
      return Promise.all((rows || []).filter(stale).map((row) => pbpVocabPutAccountState(cleared(row))));
    })(),
    (async () => {
      const snapshot = await pbpNotesSyncSnapshot(ownerScope, ownerHash);
      return Promise.all((snapshot?.states || []).filter(stale)
        .map((row) => notesDriveStore.putAccountState(cleared(row))));
    })(),
    (async () => {
      const snapshot = await dictArchiveDriveStore.snapshot(ownerScope, ownerHash);
      return Promise.all((snapshot?.states || []).filter(stale)
        .map((row) => dictArchiveDriveStore.putAccountState(cleared(row))));
    })(),
    (async () => {
      const snapshot = await askArchiveDriveStore.snapshot(ownerScope, ownerHash);
      return Promise.all((snapshot?.states || []).filter(stale)
        .map((row) => askArchiveDriveStore.putAccountState(cleared(row))));
    })()
  ]);
  let complete = true;
  sides.forEach((side, index) => {
    if (side.status === "fulfilled" && side.value.every((value) => value === true)) return;
    complete = false;
    if (side.status === "rejected") {
      console.warn("[drive-sync] account row clear failed:", ["vocabulary", "notes", "dictionary", "ask"][index],
        side.reason?.name, side.reason?.message);
    }
  });
  return complete;
}

// Force lifts shared connection state, every data-layer block and account-row
// errors before any dataset runs, including datasets an earlier failure skips.
async function pbpDriveForceClear(auth, ownerHash, roundEpoch) {
  if (!pbpLibraryAuthIsCurrent(auth) || driveScopeEpoch !== roundEpoch) return;
  const cleared = await Promise.allSettled([
    driveConnectionStore.put(ownerHash, null),
    pbpVocabDeletePreflightState(ownerHash),
    notesDriveStore.deletePreflightState(ownerHash),
    dictArchiveDriveStore.deletePreflightState(ownerHash),
    askArchiveDriveStore.deletePreflightState(ownerHash),
    pbpDriveClearAccountRowErrors(pbpDictOwnerScope(auth.account), ownerHash)
  ]);
  cleared.forEach((row, index) => {
    if (row.status === "fulfilled" && row.value === true) return;
    console.warn("[drive-sync] force clear incomplete:", ["connection", "vocabulary", "notes", "dictionary", "ask", "account rows"][index],
      row.reason?.name, row.reason?.message);
  });
}

async function pbpQueueDriveRound(options = {}) {
  const interactive = options.interactive === true;
  const force = options.force === true;
  const manual = options.manual === true;
  if (!PBP_VOCAB_DRIVE_CAPABLE) return { ok: false, error: "unavailable", results: {} };
  return queueDriveSync(async () => {
    if (!await pbpDriveEnabled()) {
      const connected = await pbpVocabDriveIsConnected();
      return { ok: false, error: connected ? "permission" : "not_connected", results: {} };
    }
    const roundEpoch = driveScopeEpoch;
    const auth = await getCurrentLibraryAuth().catch((e) => {
      console.warn("[drive-sync] round owner read failed:", e?.name, e?.message);
      return null;
    });
    const ownerScope = auth?.account && pbpLibraryAuthIsCurrent(auth) ? pbpDictOwnerScope(auth.account) : "";
    const ownerHash = ownerScope ? await pbpVocabOwnerHash(ownerScope).catch((e) => {
      console.warn("[drive-sync] round owner hash failed:", e?.name, e?.message);
      return "";
    }) : "";
    const runOptions = { interactive, force };
    const results = {};
    let before = null;
    driveRoundContext = ownerHash ? { auth, ownerHash, epoch: roundEpoch } : null;
    try {
      if (force && ownerHash) await pbpDriveForceClear(auth, ownerHash, roundEpoch);
      if (ownerHash) before = await pbpDriveReadRoundState(ownerHash);
      if (options.dictionaryOnly !== true && options.askOnly !== true) {
        results.vocabulary = await pbpRunDriveDataset("vocabulary", auth, ownerScope, runOptions);
        results.notes = pbpDriveRoundSkip(results.vocabulary, roundEpoch) ||
          await pbpRunDriveDataset("notes", auth, ownerScope, runOptions);
      }
      if (options.askOnly !== true) {
        results.dictionary = (results.notes && pbpDriveRoundSkip(results.notes, roundEpoch)) ||
          await pbpRunDriveDataset("dictionary", auth, ownerScope, runOptions);
      }
      if (options.dictionaryOnly !== true) {
        results.ask = (results.dictionary && pbpDriveRoundSkip(results.dictionary, roundEpoch)) ||
          await pbpRunDriveDataset("ask", auth, ownerScope, runOptions);
      }
    } finally {
      driveRoundContext = null;
    }
    let observed = null;
    try { observed = await pbpReconcileDriveAlarms(); }
    catch (e) { console.warn("[drive-sync] alarm reconcile failed:", e?.name, e?.message); }
    // Manual Sync now and Connect report in the panel; only background rounds notify.
    if (!interactive && !manual && before && observed?.ownerHash === ownerHash &&
        await pbpDriveEnabled()) {
      try { await pbpAnnounceDriveBlocked(before, observed.state); }
      catch (e) { console.warn("[drive-sync] blocked notice failed:", e?.name, e?.message); }
    }
    const outcome = pbpDriveRoundOutcome(results);
    // Spec §10.3: a round the epoch cut short because this device was
    // disconnected meanwhile is not an error to paint -- the panel already
    // shows the disconnected state. Only a still-connected device hears
    // account_changed.
    if (!outcome.ok && driveScopeEpoch !== roundEpoch && !await pbpVocabDriveIsConnected()) {
      return { ok: false, error: "not_connected", retryable: false, results: outcome.results };
    }
    return outcome;
  });
}

async function pbpConnectDrive() {
  const auth = await getCurrentLibraryAuth();
  if (!auth?.account || !pbpLibraryAuthIsCurrent(auth)) return { ok: false, error: "pinboard_auth" };
  if (!await chrome.permissions.contains({ permissions: ["identity"], origins: [PBP_GOOGLE_API_ORIGIN] })) {
    // Spec §10.8: the grant this device needs is gone, so it is not connected
    // any more (the handler did this before A4 moved the flag in here).
    await chrome.storage.local.set({ [PBP_VOCAB_DRIVE_CONNECTED_KEY]: false });
    return { ok: false, error: "permission" };
  }
  // Re-authorizing after the grant itself failed (spec §3.5, §5.3, §10.6):
  // without this Chrome hands back the cached token it already refused and the
  // interactive prompt never appears. Only then -- clearAllCachedAuthTokens
  // also resets this extension's Identity API grant, so wiping on a first
  // Connect or during a network backoff would turn one failed interactive
  // attempt into "needs re-authorization". Both caches are local; no network.
  let ownerHash = "";
  try { ownerHash = await pbpVocabOwnerHash(pbpDictOwnerScope(auth.account)); }
  catch (error) { console.warn("[vocab-drive] connect: owner hash failed:", error?.name, error?.message); }
  const record = ownerHash ? await driveConnectionStore.get(ownerHash) : null;
  if ((record?.lastError === "auth" && record.blocked === true) || record?.lastError === "permission") {
    try { await chrome.identity.clearAllCachedAuthTokens(); }
    catch (error) {
      console.warn("[vocab-drive] connect: clearAllCachedAuthTokens failed:", error?.name, error?.message);
    }
    pbpVocabDriveForgetIdentity();
  }
  // Authorization runs outside queueDriveSync: an in-flight round must not hold
  // the Google prompt behind it, and a Connect to another account has to be able
  // to cancel that round (pbpObserveDriveIdentity below).
  const account = await driveConnectClient.connect();
  if (!account.ok) {
    // Only a refusal of the grant itself proves this device is no longer
    // authorized -- Cancel in the Google window included. A retryable mint
    // failure is a network or server condition: dropping the flag would turn
    // the retry alarm into a no-op. Round results never clear it (A4).
    if (account.retryable !== true && (account.error === "auth" || account.error === "permission")) {
      await chrome.storage.local.set({ [PBP_VOCAB_DRIVE_CONNECTED_KEY]: false });
    }
    return account;
  }
  const currentAuth = await getCurrentLibraryAuth();
  if (currentAuth?.account !== auth.account || !pbpLibraryAuthIsCurrent(auth) ||
      !pbpLibraryAuthIsCurrent(currentAuth)) return { ok: false, error: "account_changed" };
  pbpObserveDriveIdentity(account.permissionId);
  await chrome.storage.local.set({
    [PBP_VOCAB_DRIVE_CONNECTED_KEY]: true,
    [PBP_DRIVE_CONNECTION_ACCOUNT_KEY]: {
      permissionId: account.permissionId,
      emailAddress: account.emailAddress || "", displayName: account.displayName || ""
    }
  });
  // Ends the page's "waiting for Google" phase now; the response itself only
  // arrives after the whole round. Owner scope only, no account details.
  try {
    const pending = chrome.runtime.sendMessage({
      type: "PBP_DRIVE_CONNECT_AUTHORIZED", owner: pbpDictOwnerScope(auth.account)
    });
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch (error) {
    console.warn("[vocab-drive] connect: broadcast failed:", error?.name, error?.message);
  }
  // manual: the page shows this round's outcome, so no system notification.
  return pbpQueueDriveRound({ interactive: false, force: true, manual: true });
}

function pbpDriveSnapshotStatus(snapshot, preflight, currentPermissionId = "") {
  const rows = snapshot.states.slice().sort((a, b) => (b.lastSuccessAt || 0) - (a.lastSuccessAt || 0));
  // A2: describe the Google account this device is connected to; the newest
  // row is only the fallback for a legacy device without that record.
  const state = (currentPermissionId && rows.find((row) => row.drivePermissionId === currentPermissionId)) ||
    rows[0] || null;
  const pending = state ? snapshot.batches.filter((row) => row.drivePermissionId === state.drivePermissionId) : [];
  // Connection-layer codes belong to driveConnectionStore alone. A preflight or
  // account row still holding one is pre-migration history and reads as clean.
  const dataError = (code) => typeof code === "string" && code !== "" && !PBP_DRIVE_CONNECTION_ERRORS.has(code);
  let lastError = null, retryAt = null, blocked = false;
  if (dataError(preflight?.lastError)) {
    lastError = preflight.lastError;
    blocked = preflight.blocked === true;
    retryAt = !blocked && Number.isFinite(preflight.retryAt) ? preflight.retryAt : null;
  } else if (dataError(state?.lastError)) {
    lastError = state.lastError;
    retryAt = Number.isFinite(state.retryAt) ? state.retryAt : null;
  }
  return {
    status: {
      lastSuccessAt: Number.isFinite(state?.lastSuccessAt) ? state.lastSuccessAt : null,
      lastError, retryAt, blocked,
      // Frozen batches leave the outbox before upload, so both count.
      hasPending: snapshot.outbox.length > 0 || pending.length > 0,
      notices: snapshot.notices.length
    },
    account: typeof state?.drivePermissionId === "string" && state.drivePermissionId ? {
      drivePermissionId: state.drivePermissionId,
      emailAddress: typeof state.emailAddress === "string" ? state.emailAddress : "",
      displayName: typeof state.displayName === "string" ? state.displayName : "",
      lastSuccessAt: state.lastSuccessAt || 0
    } : null
  };
}
async function pbpGetVocabDriveStatus() {
  const [connected, auth, stored] = await Promise.all([
    pbpVocabDriveIsConnected(), getCurrentLibraryAuth(),
    chrome.storage.local.get({ [PBP_DRIVE_CONNECTION_ACCOUNT_KEY]: null })
  ]);
  const neutralDataset = () => ({ lastSuccessAt: null, lastError: null, retryAt: null,
    blocked: false, hasPending: false, notices: 0 });
  const neutralConnection = { lastError: null, retryAt: null, blocked: false };
  const base = { connected, owner: "", connection: neutralConnection, vocabulary: neutralDataset(),
    notes: neutralDataset(), dictionary: neutralDataset(), ask: neutralDataset(), noticeTerms: [], lastSuccessAt: null, hasPending: false };
  if (!auth?.account || !pbpLibraryAuthIsCurrent(auth)) return base;
  const ownerScope = pbpDictOwnerScope(auth.account);
  const ownerHash = await pbpVocabOwnerHash(ownerScope);
  const savedAccount = stored[PBP_DRIVE_CONNECTION_ACCOUNT_KEY];
  const currentAccount = connected && typeof savedAccount?.permissionId === "string" && savedAccount.permissionId
    ? savedAccount : null;
  const reads = await Promise.allSettled([
    pbpVocabSyncSnapshot(ownerScope, ownerHash), pbpVocabGetPreflightState(ownerHash),
    pbpNotesSyncSnapshot(ownerScope, ownerHash), notesDriveStore.getPreflightState(ownerHash),
    // The throwing read: an unreadable record must not look like "no error".
    pbpDriveReadConnState(ownerHash),
    dictArchiveDriveStore.snapshot(ownerScope, ownerHash), dictArchiveDriveStore.getPreflightState(ownerHash),
    askArchiveDriveStore.snapshot(ownerScope, ownerHash), askArchiveDriveStore.getPreflightState(ownerHash)
  ]);
  if (!pbpLibraryAuthIsCurrent(auth)) return base;
  const emptySnapshot = { states: [], outbox: [], batches: [], notices: [] };
  const connectionRead = reads[4];
  if (connectionRead.status === "rejected") {
    console.warn("[drive-sync] connection status unavailable:",
      connectionRead.reason?.name, connectionRead.reason?.message);
  }
  const dataset = (at, name) => {
    const snapshotRead = reads[at], preflightRead = reads[at + 1];
    const failed = [snapshotRead, preflightRead].filter((read) => read.status === "rejected");
    for (const read of failed) {
      console.warn("[drive-sync] dataset status unavailable:", name, read.reason?.name, read.reason?.message);
    }
    const snapshot = snapshotRead.status === "fulfilled" ? snapshotRead.value : emptySnapshot;
    const preflight = preflightRead.status === "fulfilled" ? preflightRead.value : null;
    const { status, account } = pbpDriveSnapshotStatus(snapshot, preflight, currentAccount?.permissionId || "");
    // Not connected: nothing will run, so nothing is shown as an error (§6.1).
    if (!connected) {
      return { status: { ...status, lastError: null, retryAt: null, blocked: false }, account: null, snapshot };
    }
    // A failed READ blocks nothing: no run stopped and no preflight was
    // written, so it must not borrow local_store/blocked (whose hint names a
    // button that cannot clear it). Only a readable data-layer preflight error
    // is still real; an account-row error or retryAt is unconfirmed history.
    // An unreadable connection record leaves the whole connection unknown.
    const preflightError = preflight != null && status.lastError !== null && status.lastError === preflight.lastError;
    if ((failed.length || connectionRead.status === "rejected") && !preflightError) {
      return { status: { ...status, lastError: "status_unavailable", blocked: false, retryAt: null }, account, snapshot };
    }
    return { status, account, snapshot };
  };
  const vocabulary = dataset(0, "vocabulary");
  const notes = dataset(2, "notes");
  const dictionary = dataset(5, "dictionary");
  const ask = dataset(7, "ask");
  const record = connected && connectionRead.status === "fulfilled" ? connectionRead.value : null;
  const connectionError = typeof record?.lastError === "string" && PBP_DRIVE_CONNECTION_ERRORS.has(record.lastError)
    ? record.lastError : null;
  const connection = connectionError ? {
    lastError: connectionError,
    retryAt: record.blocked !== true && Number.isFinite(record.retryAt) ? record.retryAt : null,
    blocked: record.blocked === true
  } : neutralConnection;
  const account = currentAccount
    ? { drivePermissionId: currentAccount.permissionId, emailAddress: currentAccount.emailAddress,
        displayName: currentAccount.displayName }
    : [vocabulary.account, notes.account, dictionary.account, ask.account].filter(Boolean)
        .sort((a, b) => (b.lastSuccessAt || 0) - (a.lastSuccessAt || 0))[0] || null;
  const times = [vocabulary.status.lastSuccessAt, notes.status.lastSuccessAt, dictionary.status.lastSuccessAt, ask.status.lastSuccessAt];
  return {
    connected, owner: auth.account,
    ...(account ? {
      drivePermissionId: account.drivePermissionId,
      emailAddress: typeof account.emailAddress === "string" ? account.emailAddress : "",
      displayName: typeof account.displayName === "string" ? account.displayName : ""
    } : {}),
    connection,
    vocabulary: vocabulary.status,
    notes: notes.status,
    dictionary: dictionary.status,
    ask: ask.status,
    // Only vocabulary notices name a term; a notes notice key is an article id.
    noticeTerms: vocabulary.snapshot.notices.slice(0, 20).map((row) => {
      const key = String(row.recordKey || ""); const separator = key.indexOf("|");
      return separator >= 0 ? key.slice(separator + 1) : key;
    }).filter(Boolean),
    // All datasets are synced as of this moment: the earliest time, or never.
    lastSuccessAt: times.every(Number.isFinite) ? Math.min(...times) : null,
    hasPending: vocabulary.status.hasPending || notes.status.hasPending || dictionary.status.hasPending || ask.status.hasPending
  };
}

async function pbpVocabDriveResponse(result) {
  // Per-dataset rows carry data-layer codes only; connection-layer and control
  // codes, and backoff, are reported once at the top (spec §6.2, A28).
  const dataErrors = new Set(["corrupt", "local_store", "entry_too_large", "remote", "unexpected"]);
  const response = result?.ok ? { ok: true } : { ok: false, error: result?.error || "remote" };
  const entries = result?.results && typeof result.results === "object" ? result.results : null;
  if (result?.waitingForRetry === true || result?.error === "waiting_for_retry" ||
      Object.values(entries || {}).some((value) => value?.status?.waitingForRetry === true)) {
    response.waitingForRetry = true;
  }
  if (entries) {
    response.results = {};
    for (const type of ["vocabulary", "notes", "dictionary", "ask"]) {
      const value = entries[type];
      if (!value) continue;
      response.results[type] = { ok: value.ok === true,
        ...(dataErrors.has(value.error) ? { error: value.error } : {}) };
    }
  }
  try { response.status = await pbpGetVocabDriveStatus(); }
  catch (error) { console.warn("[drive-sync] response status unavailable:", error?.name, error?.message); }
  return response;
}

// Floor between two cold-start syncs. This function runs at the top level, and
// an MV3 "startup" is EVERY SW wake (see the lazy icon-decode note at the top of
// this file) — with storage-warm waking an idle browser every 5 minutes, a
// connected device opened a Drive session (an about() round trip, plus another
// on a successful finish) that often, while the design cadence is the 15-minute
// drive-sync-periodic alarm. Alarm-driven runs carry the real schedule and pass
// no throttle, so a freshly dirtied word still syncs immediately. The stamp is
// persisted because the throttle has to survive the worker that set it. One
// stamp covers the whole round: both datasets run in it.
const PBP_VOCAB_BOOT_SYNC_KEY = "_vocabBootSyncTs";
const PBP_VOCAB_BOOT_SYNC_MIN_MS = 15 * 60 * 1000;

async function pbpBootDriveSync({ throttleMs = 0 } = {}) {
  if (!PBP_VOCAB_DRIVE_CAPABLE) return { ok: true };
  if (!await pbpVocabDriveIsConnected()) return { ok: true };
  const granted = await chrome.permissions.contains({
    permissions: ["identity"],
    origins: [PBP_GOOGLE_API_ORIGIN]
  });
  if (!granted) {
    await chrome.storage.local.set({ [PBP_VOCAB_DRIVE_CONNECTED_KEY]: false });
    await pbpClearDriveAlarms();
    return { ok: false, error: "permission" };
  }
  if (throttleMs > 0) {
    const now = Date.now();
    let last = 0;
    try {
      const stored = await chrome.storage.local.get({ [PBP_VOCAB_BOOT_SYNC_KEY]: 0 });
      last = Number(stored?.[PBP_VOCAB_BOOT_SYNC_KEY]) || 0;
    } catch (e) {
      console.warn("[drive-sync] boot throttle read failed:", e?.name, e?.message);
    }
    // Stamp BEFORE the run: a failed sync sets its own retryAt/backoff and the
    // round reconciles drive-sync-retry, so the wake path must not hammer it.
    if (now - last < throttleMs) return { ok: true, throttled: true };
    try { await chrome.storage.local.set({ [PBP_VOCAB_BOOT_SYNC_KEY]: now }); }
    catch (e) { console.warn("[drive-sync] boot throttle write failed:", e?.name, e?.message); }
  }
  return pbpQueueDriveRound({ interactive: false });
}

async function pbpDisconnectVocabDrive() {
  if (!PBP_VOCAB_DRIVE_CAPABLE) {
    return { ok: false, error: "unavailable" };
  }
  // Invalidate running jobs before any further await.
  driveScopeEpoch++;
  await chrome.storage.local.set({ [PBP_VOCAB_DRIVE_CONNECTED_KEY]: false });
  await chrome.storage.local.remove(PBP_DRIVE_CONNECTION_ACCOUNT_KEY);
  await pbpClearDriveAlarms();
  // Local and immediate (Chrome 87+, manifest minimum 123). The former silent
  // getAuthToken -> removeCachedAuthToken pair needed the OAuth endpoint and
  // hung while it was unreachable (spec §3.5). The namespace exists only while
  // the optional identity grant does, so this runs before permissions.remove;
  // a missing namespace throws TypeError and is logged, never fatal.
  try {
    await chrome.identity.clearAllCachedAuthTokens();
  } catch (error) {
    console.warn("[vocab-drive] disconnect: clearAllCachedAuthTokens failed:", error?.name, error?.message);
  }
  pbpVocabDriveForgetIdentity();
  let removed = false;
  try {
    removed = await chrome.permissions.remove({
      permissions: ["identity"],
      origins: [PBP_GOOGLE_API_ORIGIN]
    });
  } catch (e) {
    console.warn("[vocab-drive] disconnect: permissions.remove failed:", e?.name, e?.message);
  }
  // Chrome's origin removal is a pattern-set subtraction, not a URL-space one:
  // a wider already-granted pattern can make `removed` come back true while
  // access is still live, so `removed !== true` alone cannot see that case.
  // Recheck with the same remove->contains pairing already used above for the
  // legacy wildcard cleanup (pbpMigrateLegacyWildcardPermission).
  let residual = false;
  try {
    residual = await chrome.permissions.contains({
      permissions: ["identity"],
      origins: [PBP_GOOGLE_API_ORIGIN]
    });
  } catch (e) {
    console.warn("[vocab-drive] disconnect: permissions.contains recheck failed:", e?.name, e?.message);
  }
  if (removed !== true || residual === true) {
    console.warn("[vocab-drive] disconnect: permission removal incomplete", removed, residual);
  }
  await pbpClearDriveAlarms();
  // The disconnect is complete either way; a page without status rereads it.
  try {
    return { ok: true, status: await pbpGetVocabDriveStatus() };
  } catch (error) {
    console.warn("[vocab-drive] disconnect: status read failed:", error?.name, error?.message);
    return { ok: true };
  }
}

pbpBootDriveSync({ throttleMs: PBP_VOCAB_BOOT_SYNC_MIN_MS }).catch((e) => {
  console.warn("[drive-sync] cold-start sync failed:", e?.name, e?.message);
});

// One-shot migration (spec 2026-10-12 §2.2). The per-dataset scope switches are
// gone: connecting Google Drive now syncs vocabulary AND highlights/notes (user
// ruling A — a vocabulary-only device starts uploading this owner's notes after
// the upgrade, no confirmation step). This retires the two local scope keys, the
// notes-only boot throttle stamp and the six per-dataset alarm names, and scrubs
// the connection-layer codes (auth/permission/network/rate_limited/server) the
// old runners persisted into each dataset's preflight and account rows: those
// now live only in the shared driveConnState:<ownerHash> record, and a stale
// copy would surface a second, contradictory error line. Data-layer codes stay
// verbatim and nothing is carried over — the boot below re-probes the
// connection. Placed after the top-level boot call on purpose: outside the
// drive-scopes and boot test slices. Flag-gated; a refused or failed write
// leaves the flag unset and the next worker generation retries (every step is
// idempotent). Retire by 2027-01-15 (.claude/expiring-items.md).
const PBP_DRIVE_SCOPE_RETIRE_FLAG = "_driveScopeKeysRetiredDone";
const PBP_DRIVE_RETIRED_LOCAL_KEYS = Object.freeze(["driveSyncVocabulary", "driveSyncNotes", "_notesBootSyncTs"]);
function pbpDriveHasConnectionError(row) {
  return typeof row?.lastError === "string" && PBP_DRIVE_CONNECTION_ERRORS.has(row.lastError);
}
function pbpDriveScrubbedRow(row) {
  const next = { ...row, lastError: null, retryAttempt: 0, retryAt: null };
  if (Object.hasOwn(row, "blocked")) next.blocked = false;
  return next;
}
// true: every current-owner row is clean (or there is no owner to clean for).
// false: a write was refused or failed — the caller leaves the flag unset.
async function pbpScrubDriveConnectionRows() {
  const auth = await getCurrentLibraryAuth();
  // Signed out: nothing is owner-scoped yet. The flag still lands; a later run
  // for that owner ignores legacy connection codes in these rows (spec §3.3).
  if (!auth?.account) return true;
  // Signed in but the auth already moved on: fail closed and retry next wake.
  if (!pbpLibraryAuthIsCurrent(auth)) return false;
  const ownerScope = pbpDictOwnerScope(auth.account);
  const ownerHash = await pbpVocabOwnerHash(ownerScope);
  const sameOwner = async () => {
    const current = await getCurrentLibraryAuth();
    return current?.account === auth.account &&
      pbpLibraryAuthIsCurrent(auth) && pbpLibraryAuthIsCurrent(current);
  };
  // Both stores refuse an account row whose own key disagrees with its
  // drivePermissionId / ownerHash. The runner never reads such a row (it looks
  // rows up by that key), so leave it alone: patching it would fail on every
  // worker wake and the flag would never land.
  const canonicalAccountRow = (row) => row?.ownerHash === ownerHash &&
    typeof row.drivePermissionId === "string" &&
    row.key === "account:" + row.drivePermissionId + ":" + ownerHash;
  // Vocabulary: vocab-store.js is the only writer of the pbp-vocab IDB; its
  // sync-row writers are keyed by ownerHash, so the owner is re-checked here
  // before every write. A preflight with all four fields cleared is exactly
  // what a successful run leaves (the runner deletes it), so delete it.
  if (pbpDriveHasConnectionError(await pbpVocabGetPreflightState(ownerHash))) {
    if (!await sameOwner() || !await pbpVocabDeletePreflightState(ownerHash)) return false;
  }
  for (const row of await pbpVocabListAccountStates(ownerHash)) {
    if (!pbpDriveHasConnectionError(row) || !canonicalAccountRow(row)) continue;
    if (!await sameOwner() || !await pbpVocabPutAccountState(pbpDriveScrubbedRow(row))) return false;
  }
  // Notes: a dedicated store whose owner is "this Pinboard account, still
  // current". notesDriveStore cannot be used — its owner is "" whenever Drive is
  // not enabled, and a disconnected device must be scrubbed too. Every write
  // still passes the store's checkHash boundary; a refused owner throws
  // account_changed (stateFailure re-throws it) and aborts the whole scrub.
  const notesStore = pbpCreateNotesSyncStore({
    getCurrentOwner: async () => (await sameOwner() ? ownerScope : "")
  });
  if (pbpDriveHasConnectionError(await notesStore.getPreflightState(ownerHash)) &&
      !await notesStore.deletePreflightState(ownerHash)) return false;
  const accountPrefix = PBP_NOTES_SYNC_PREFIX + "account_";
  const keys = typeof chrome.storage.local.getKeys === "function"
    ? await chrome.storage.local.getKeys() : Object.keys(await chrome.storage.local.get(null));
  for (const key of keys) {
    if (!key.startsWith(accountPrefix)) continue;
    let id;
    // A key that does not decode was never written by stateKey(); not a row to scrub.
    try { id = decodeURIComponent(key.slice(accountPrefix.length)); } catch (_) { continue; }
    if (!id.endsWith(":" + ownerHash)) continue;
    const row = await notesStore.getAccountState(id.slice(0, -(ownerHash.length + 1)), ownerHash);
    if (!pbpDriveHasConnectionError(row) || !canonicalAccountRow(row)) continue;
    if (!await notesStore.putAccountState(pbpDriveScrubbedRow(row))) return false;
  }
  return true;
}
async function pbpRetireDriveScopeKeys() {
  try {
    const flag = await chrome.storage.local.get(PBP_DRIVE_SCOPE_RETIRE_FLAG);
    if (flag[PBP_DRIVE_SCOPE_RETIRE_FLAG] === true) return;
    await chrome.storage.local.remove([...PBP_DRIVE_RETIRED_LOCAL_KEYS]);
    await Promise.all(PBP_DRIVE_LEGACY_ALARMS.map((name) => chrome.alarms.clear(name)));
    // Behind any round the top-level boot already queued: patching an account
    // row read before that round committed a newer cursor would roll it back.
    if (await queueDriveSync(() => pbpScrubDriveConnectionRows()) !== true) {
      console.warn("[drive-sync] scope key retirement: row scrub incomplete; will retry");
      return;
    }
    await chrome.storage.local.set({ [PBP_DRIVE_SCOPE_RETIRE_FLAG]: true });
  } catch (e) {
    // Key names and error class only — no token, email or vocabulary content.
    console.warn("[drive-sync] scope key retirement failed:", e?.name, e?.message);
    return;
  }
  // Step 4 runs once, after the flag: a failing sync must not re-run the cleanup.
  // Not connected: no alarm, no network. Connected with the grant intact: arm the
  // new periodic and run one unthrottled whole round (vocabulary, then notes —
  // seedLegacy enrolls this owner's existing highlights; ownerless ones stay
  // local). Grant revoked: the boot itself flips vocabDriveConnected to false and
  // clears drive-sync-* without touching the network.
  try {
    if (!PBP_VOCAB_DRIVE_CAPABLE) return;
    const stored = await chrome.storage.local.get({ [PBP_VOCAB_DRIVE_CONNECTED_KEY]: false });
    if (stored[PBP_VOCAB_DRIVE_CONNECTED_KEY] !== true) return;
    if (await pbpDriveEnabled()) await pbpDriveEnsurePeriodic();
    await pbpBootDriveSync();
  } catch (e) {
    console.warn("[drive-sync] post-migration boot failed:", e?.name, e?.message);
  }
}
pbpRetireDriveScopeKeys();

const queuePrewarmAlarmSync = pbpCreateRecoveringTail();
function syncPrewarmTagsAlarm() {
  return queuePrewarmAlarmSync(async () => {
    const s = await loadSettings();
    const existing = await chrome.alarms.get("prewarm-tags");
    const shouldRun = s.tagSyncMode === "prewarmed" && !!pbpBookmarkConnection(s).account;
    if (shouldRun && !existing) {
      chrome.alarms.create("prewarm-tags", { periodInMinutes: 15, delayInMinutes: 0.5 });
      prewarmTagsNow().catch(() => {}); // populate now; don't wait ~30s for the first alarm
    } else if (!shouldRun && existing) {
      chrome.alarms.clear("prewarm-tags");
    }
  });
}

async function prewarmTagsNow() {
  const auth = await getCurrentBookmarkAuth();
  if (!auth.token) return;
  try {
    const data = await pbpBookmarkTagCounts(auth);
    if (!pbpBookmarkAuthIsCurrent(auth)) return;
    // Store only the count map + timestamp; the popup rebuilds the sorted tag list
    // from counts on read (deterministic), so storing the array too is dead weight.
    await chrome.storage.local.set({
      cached_user_tags: { account: auth.account, counts: data, timestamp: Date.now() }
    });
  } catch (e) {
    // Tag cache write failure: stale data hurts autocomplete UX, log it
    if (e?.code !== "account_changed") console.warn("[tag-cache] write failed:", e?.message || e);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PBP_STORAGE_ACCESS_RETRY_ALARM) {
    pbpRestrictStorageAccess().catch((e) => {
      console.warn("[storage-access] retry failed:", e?.name, e?.message);
    });
  }
  // Legacy vocab-sync-* / notes-sync-* names still route here until
  // pbpRetireDriveScopeKeys retires them, so a pre-upgrade alarm racing the
  // migration still runs one unthrottled round instead of being dropped.
  if (alarm.name === PBP_DRIVE_DIRTY_ALARM || alarm.name === PBP_DRIVE_PERIODIC_ALARM ||
      alarm.name === PBP_DRIVE_RETRY_ALARM || PBP_DRIVE_LEGACY_ALARMS.includes(alarm.name)) {
    pbpBootDriveSync().catch((e) => {
      console.warn("[drive-sync] alarm sync failed:", alarm.name, e?.name, e?.message);
    });
  }
  if (alarm.name === "keepalive") {
    processOfflineQueue().catch(() => {});
    pbpSweepInterruptedBatch().catch((e) => {
      console.warn("[batch] interrupted sweep failed:", e?.name, e?.message);
    });
    ensureKeepAlive(); // if SW was revived mid-window by the alarm, resume pinging
    // Self-release: when the activity window lapsed AND there is no queued or
    // running work left, clear this alarm so an idle browser stops waking the
    // worker every 4 minutes. Any later activity/queue/batch re-creates it.
    _maybeReleaseKeepaliveAlarm();
  }
  if (alarm.name === "badge-refresh") {
    updateBadge().catch(() => {});
  }
  if (alarm.name === PBP_UNDO_ALARM) {
    pbpSweepExpiredUndo().catch((e) => console.warn("[undo] expiry sweep failed:", e?.name, e?.message));
  }
  if (alarm.name === "prewarm-tags") {
    prewarmTagsNow().catch(() => {});
  }
  if (alarm.name === "storage-warm") {
    primeSettings().catch(() => {});
    pbpMigrateSecretsToLocal().catch(() => {});
  }
});

// React to settings change: toggle the prewarm alarm on/off (settings live in sync or local based on optSyncEnabled)
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" || area === "local") && pbpSettingsKeysChanged(changes)) {
    invalidateSettingsCache();
  }
  // Turning linkding's browsing checks on or off changes what the toolbar may
  // show: drop every state and copy, and let the active tab ask again (or not).
  if ((area === "sync" || area === "local") && changes.linkdingPreload) {
    pbpReadBookmarkConnection().then((connection) => {
      if (connection.service === "linkding") pbpResetBookmarkStatusView();
    }).catch((e) => console.warn("[bookmark-status] connection read failed:", e?.name, e?.message));
  }
  if (area === "sync" || area === "local") {
    scheduleEffectiveAuthRefresh(changes, area);
    pbpOfflinePauseOnCredentialChange(changes);
  }
  if ((area === "sync" || area === "local") && (changes.personalLibraryAccount || changes.optSyncEnabled)) {
    _personalLibraryEpoch++;
    driveScopeEpoch++;
  }
  if (area === "sync" && (changes.syncApiKeys || changes.exportTargets ||
      API_KEY_FIELDS.some((key) => !!changes[key]))) {
    // Mirror keys-on snapshots promptly on every participating online device;
    // the periodic storage-warm run remains the MV3 restart/offline fallback.
    pbpMigrateSecretsToLocal().catch(() => {});
  }
  if (area === "local" && changes.vocabDriveConnected &&
      changes.vocabDriveConnected.newValue !== true) {
    driveScopeEpoch++;
    pbpClearDriveAlarms().catch((e) => {
      console.warn("[drive-sync] alarm cleanup failed:", e?.name, e?.message);
    });
  }
  const routingChanged = !!(changes.optSyncEnabled || changes.syncApiKeys);
  if ((area === "sync" || area === "local") && (routingChanged || changes.tagSyncMode || pbpBookmarkSettingsChanged(changes))) {
    syncPrewarmTagsAlarm().catch(() => {});
  }
  // Conditional site-theme payload (roadmap #37): register/unregister the
  // 704KB themes constant as the preset comes and goes (routing changes can
  // flip the effective value too, so re-check on those as well).
  if ((area === "sync" || area === "local") && (changes.themePresetKey || routingChanged)) {
    pbpSyncSiteThemeScript();
  }
});
// Initial check
syncPrewarmTagsAlarm().catch(() => {});


// Recurring sweep of the per-URL suggest-tag cache (cached_suggest_*). The popup
// writes one key per visited URL with a 10-min read-TTL but never evicts them, so
// without this they accumulate unbounded in storage.local and slow reads. Gated to
// ~once / 6h to bound the get(null) scan; drops entries older than 1h (past the TTL).
const SUGGEST_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SUGGEST_STALE_MS = 60 * 60 * 1000;
// Recurring sweep of per-URL cache (cached_suggest_* and jina_md_*). Both write
// entries with a read-TTL but never evict them, so without this they accumulate
// unbounded in storage.local and slow reads. Gated to ~once / 6h to bound the
// get(null) scan. The two families expire on DIFFERENT clocks: cached_suggest_
// has a fixed 10-min read TTL (1h here is the generous side of it), while
// jina_md_ is read back through resolveCacheMs(aiCacheDuration) (jina.js) — a
// user-settable duration of up to 7 days. Sweeping those on a hardcoded hour
// silently voided the setting and re-billed the next preview to r.jina.ai, so
// resolve the same value the reader uses; 0 there means caching is off, which
// makes every stored entry unreachable and therefore sweepable.
async function sweepSuggestCache() {
  try {
    const now = Date.now();
    const { _suggestSweepTs = 0 } = await chrome.storage.local.get({ _suggestSweepTs: 0 });
    if (now - _suggestSweepTs < SUGGEST_SWEEP_INTERVAL_MS) return;
    let jinaStaleMs = resolveCacheMs(SETTINGS_DEFAULTS.aiCacheDuration);
    try {
      const raw = await pbpReadSettingsWithSecrets({ aiCacheDuration: SETTINGS_DEFAULTS.aiCacheDuration });
      jinaStaleMs = resolveCacheMs(raw.aiCacheDuration);
    } catch (e) {
      // MV3 rule: leave a trace instead of folding the failure away. No secrets
      // here — the read asks for one duration key.
      console.warn("[cache-sweep] cache duration read failed:", e?.name, e?.message);
    }
    const all = await chrome.storage.local.get(null);
    const stale = Object.keys(all).filter((k) => {
      if (k.startsWith("cached_suggest_")) return isStaleCacheEntry(all[k], now, SUGGEST_STALE_MS);
      if (k.startsWith("jina_md_")) return jinaStaleMs === 0 || isStaleCacheEntry(all[k], now, jinaStaleMs);
      return false;
    });
    if (stale.length) await chrome.storage.local.remove(stale);
    await chrome.storage.local.set({ _suggestSweepTs: now });
    if (stale.length) console.log(`[cache-sweep] evicted ${stale.length} stale entries (suggest + jina_md)`);
  } catch (_) {}
}

// Best-effort sweep of orphaned per-tab preview payloads (md_preview_data_<uuid>).
// Each preview tab owns a token key; storage.local.remove for it only runs on the
// render path, never on tab close/crash — so closed previews leak their key. Cross-
// references CURRENTLY-live preview tabs (incl. discarded Memory-Saver tabs, which
// stay in tabs.query with their ?k= intact) and drops the rest. The legacy no-token
// global key `md_preview_data` (no trailing underscore) is deliberately excluded by
// the prefix so a pre-update tab's fallback slot is never swept out from under it.
// Throttled to ~once / 30 min via a persisted timestamp (same pattern as
// sweepSuggestCache): "once per SW script evaluation" really meant once per SW
// WAKE (~every 4 min via alarms), and the full get(null) fallback deserializes
// the entire local area (jina_md_ page caches can reach MBs) — right when a
// popup cold-open may be hitting the same storage backend. Orphaned keys are
// harmless residue; letting them linger up to 30 min costs nothing.
const PREVIEW_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
async function pbpSweepPreviewOrphans() {
  try {
    const now = Date.now();
    const { _previewSweepTs = 0 } = await chrome.storage.local.get({ _previewSweepTs: 0 });
    if (now - _previewSweepTs < PREVIEW_SWEEP_INTERVAL_MS) return;
    const tabs = await chrome.tabs.query({});            // includes discarded tabs
    const base = chrome.runtime.getURL("md-preview.html");
    const live = new Set();
    for (const tb of tabs) {
      if (tb.url && tb.url.startsWith(base)) {
        const kk = new URL(tb.url).searchParams.get("k");
        if (kk) live.add("md_preview_data_" + kk);
      }
    }
    // Chrome ≥130 getKeys() lists keys without deserializing values; fall back
    // to get(null) below min-chrome 130. Candidates then get a targeted get()
    // just for their grace-window timestamps.
    let candidates;
    if (typeof chrome.storage.local.getKeys === "function") {
      const keys = await chrome.storage.local.getKeys();
      candidates = keys.filter((x) => x.startsWith("md_preview_data_") && !live.has(x));
    } else {
      const all = await chrome.storage.local.get(null);
      candidates = Object.keys(all).filter((x) => x.startsWith("md_preview_data_") && !live.has(x));
    }
    // Grace window: keep keys written in the last 60s even if their tab isn't in
    // tabs.query yet — closes the cold-start TOCTOU where popup set()s a token key
    // (waking the SW → this sweep) before its tabs.create() registers the ?k= tab.
    if (candidates.length) {
      const entries = await chrome.storage.local.get(candidates);
      const stale = candidates.filter((x) =>
        !(entries[x] && entries[x].ts && (now - entries[x].ts) < 60000));
      if (stale.length) await chrome.storage.local.remove(stale);
    }
    await chrome.storage.local.set({ _previewSweepTs: now });
  } catch (_) { /* best-effort: leaked keys just linger to the next sweep */ }
}
// Cold-start residue clean (fire-and-forget; internally throttled).
pbpSweepPreviewOrphans();

// Startup: process offline queue + update badge + prime settings (cheap no-op when already primed)
chrome.runtime.onStartup.addListener(() => {
  primeSettings().catch(() => {});
  pbpReconcileBookmarkService().catch(error => console.warn("[bookmark-service] startup reconcile failed:", error?.name, error?.message));
  processOfflineQueue().catch(() => {});
  updateBadge().catch(() => {});
});

// Install/update: prime SETTINGS_DEFAULTS so the first popup open is fast for users whose
// storage doesn't have every key yet (storage.get(missing-key) is measurably slower).
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install" || reason === "update") {
    primeSettings().catch(() => {});
    // Records the service this device used before the device key existed.
    pbpReconcileBookmarkService().catch(error => console.warn("[bookmark-service] install reconcile failed:", error?.name, error?.message));
    readOfflineQueueWithIds().catch(() => {});
  }
});

// The chosen bookmark service, or credentials for it, changed here or arrived
// from another device (Chrome Sync): follow it onto this device only once it
// is connected here (shared.js pbpReconcileBookmarkService).
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" || area === "local")
      && (pbpBookmarkSettingsChanged(changes) || changes.optSyncEnabled || changes.syncApiKeys)) {
    pbpReconcileBookmarkService(changes, area)
      .catch(error => console.warn("[bookmark-service] reconcile failed:", error?.name, error?.message));
  }
});

// ---- Popup AI calls, run by the worker (K44) -------------------------------
// Chrome destroys the popup document the instant the user clicks the page,
// switches tab or presses Esc — and it took every in-flight provider request
// with it. The tokens were already billed server-side, but the reply never
// reached setAICache, so the next open paid for the same answer again. Same
// ruling as the batch loop below ("so it survives popup close"): a call the
// user has already paid for belongs to the worker, not to a document that can
// vanish mid-flight.
//
// Only the last hop moves. The popup keeps extraction, prompt assembly, the
// combined/single decision and the cache coordinates (url / kind / source /
// account / settings fingerprint) — so audits A3/A4/A5 and its account gates
// stay exactly where they were proven. This function takes a finished prompt
// plus those coordinates, runs the call, parses it, and files the result. Two
// invariants had to travel with it and are re-stated at their sites below: the
// A8 half-empty rule, and tag case resolution.
//
// Deliberately NOT an extraction of the quick-save AI path above: that block
// writes four outer mutable flags (aiHostPermissionMissing / aiTagsResolved /
// summaryResolved / aiPromises), so "equivalent extraction" there would be a
// fake mechanical operation. This one is standalone and serves the popup
// message only; CLAUDE.md explicitly tolerates a little duplication between
// isolated script contexts, and that duplication is the insurance premium here.

// Structured clone drops the Error prototype and every non-enumerable field, so
// a failure crosses the bus as a plain object and the popup rebuilds an Error
// from it. Only the four fields the popup's error card consumes travel — never
// the stack, the prompt or the settings.
function pbpAiErrorEnvelope(err) {
  const envelope = { message: String((err && err.message) || "AI call failed") };
  if (err && typeof err.code === "string" && err.code) envelope.code = err.code;
  if (err && typeof err.status === "number") envelope.status = err.status;
  if (err && typeof err.paramHint === "string" && err.paramHint) envelope.paramHint = err.paramHint;
  // Only the two names the popup acts on (a timeout reads "signal timed out").
  if (err && (err.name === "TimeoutError" || err.name === "AbortError")) envelope.name = err.name;
  return envelope;
}

// Run one popup-originated AI call to completion inside the worker. Always
// resolves to the wire envelope and never rejects — everything after the shape
// check, storage reads and cache writes included, runs inside the one try, so
// the caller always has something to send. The cache write happens before the
// send either way, which is the whole point: the popup may already be gone.
async function pbpRunPopupAiCall(message) {
  const account = typeof message.account === "string" ? message.account : "";
  const url = typeof message.url === "string" ? message.url : "";
  const prompt = typeof message.prompt === "string" ? message.prompt : "";
  const inflightKey = typeof message.inflightKey === "string" ? message.inflightKey : "";
  const kind = (message.kind === "tags" || message.kind === "summary") ? message.kind : "";
  const mode = message.mode === "combined" ? "combined" : "single";
  // The namespace is the popup's decision (audit A3): ensurePageText knows which
  // extractor actually produced the body. The worker never re-derives it.
  const source = (typeof message.source === "string" && message.source) ? message.source : "local";
  if (!account || !url || !prompt || !inflightKey || !kind) {
    return { ok: false, error: { message: "malformed AI call", code: "invalid" } };
  }

  // One try around everything that awaits: the two auth reads, the settings
  // read, the call itself and both cache writes. A storage/IDB failure is then
  // a normal envelope with a trace, not a rejection the router has to guess at.
  try {
    // Account gate 1 (cross-cutting iron rule): re-read the live auth atomically
    // right before dispatch. A switch between the popup's click and this message
    // must not spend the new account's budget on the old account's page.
    const before = await getCurrentBookmarkAuth();
    if (before.account !== account) {
      return { ok: false, error: { message: "account changed", code: "account_changed" } };
    }

    // Credentials are read HERE, by the worker, right before dispatch — never
    // taken from the message. The popup holds deobfuscated keys already, but
    // putting them on the message bus buys nothing and risks everything.
    const s = { ...(await loadSettings()), ...pbpSanitizeAiOverrides(message.aiOverrides) };
    const cacheDuration = message.cacheDuration ?? s.aiCacheDuration;

    // A custom entry the popup picked may be gone here (deleted, or not synced
    // to this device yet). Refuse before the inflight registry so nothing is
    // dispatched or cached; the popup re-localizes the message.
    if (pbpAiResolveTarget(s).error === "provider_missing") {
      return { ok: false, error: { message: t("aiErrorProviderMissing"), code: "provider_missing" } };
    }

    // Same dedup shape and the same key string the popup builds, on the
    // worker's single Map: a second click — or a reopened popup — rides the
    // call already running instead of paying for it twice. The key is opaque
    // here by design; it carries the popup's account|fingerprint|type|url and
    // must not be recomputed from a settings snapshot the worker doesn't own.
    const produced = await getOrCreateInflight(inflightKey, async () => {
      const resp = await callAI(s, prompt);
      if (mode === "combined") {
        const parsed = parseAICombined(resp, s.aiTagSeparator);
        return { tags: parsed.tags, summary: parsed.summary };
      }
      if (kind === "tags") {
        const tags = refineTags(parseAITags(resp, s.aiTagSeparator), { cap: AI_TAG_CAP, separator: s.aiTagSeparator });
        return { tags, summary: "" };
      }
      return { tags: [], summary: typeof resp === "string" ? resp : "" };
    });

    // Account gate 2: the result belongs to whoever paid for it. A switch during
    // the call discards it rather than filing it under the new owner.
    const after = await getCurrentBookmarkAuth();
    if (after.account !== account) {
      return { ok: false, error: { message: "account changed", code: "account_changed" } };
    }

    // A8: cache — and hand back — only the half that has content. A cached empty
    // half turns a malformed reply into a sticky fake success; a null half is a
    // miss, which is exactly what the popup's own logic already falls through on.
    const tags = (produced && produced.tags && produced.tags.length) ? produced.tags : null;
    const summary = (produced && produced.summary) ? produced.summary : null;
    if (tags) await setAICache(url, "tags", tags, cacheDuration, source, account, s);
    if (summary) await setAICache(url, "summary", summary, cacheDuration, source, account, s);
    return { ok: true, tags, summary };
  } catch (e) {
    // CLAUDE.md: log the raw shape before folding it into a product code. The
    // classification itself is handleAIError's, inside callAI — not re-done here.
    // A cache-write failure lands here too and yields ok:false, which matches
    // what the popup already does today (its own setAICache is awaited inside
    // the same try as its render).
    console.warn("[pbp-ai] popup AI call failed:", e && e.name, e && e.code, e && e.message);
    return { ok: false, error: pbpAiErrorEnvelope(e) };
  }
}

// Popup draft writes outlive the popup that dispatched them. Only session
// storage is used; the lock orders rapid input/clear requests within the SW.
async function pbpRunPopupDraft(message) {
  const prefix = "pbp-popup-draft:";
  const ttl = 24 * 60 * 60 * 1000;
  const safeUrl = (s) => {
    try { const u = new URL(s); return typeof s === "string" && s.length <= 16384 && /^https?:$/.test(u.protocol) && !u.username && !u.password; }
    catch (_) { return false; }
  };
  // The draft fields some popup open actually changed. Only those are restored;
  // a row without the list predates it and restores the whole form.
  const changedKeys = ["url", "title", "notes", "summary", "summaryTouched", "sharedExplicit", "tags", "tagInput",
    "private", "toread", "archive", "archiveTouched"];
  const clean = (d) => {
    if (!d || typeof d.url !== "string" || d.url.length > 16384 || typeof d.title !== "string" || typeof d.notes !== "string"
        || typeof d.tagInput !== "string" || !Array.isArray(d.tags) || d.tags.length > 1000
        || !d.tags.every((s) => typeof s === "string")
        || !["private", "toread", "archive", "archiveTouched"].every((k) => typeof d[k] === "boolean")) return null;
    if ((d.summary !== undefined && typeof d.summary !== "string")
        || (d.summaryAi !== undefined && typeof d.summaryAi !== "string")
        || (d.summaryTouched !== undefined && typeof d.summaryTouched !== "boolean")
        || (d.sharedExplicit !== undefined && typeof d.sharedExplicit !== "boolean")
        || (d.urlSource !== undefined && d.urlSource !== "typed" && d.urlSource !== "recent")
        || (d.baseVersion !== undefined && (typeof d.baseVersion !== "string" || d.baseVersion.length > 8192))
        || (d.baseTags !== undefined && (!Array.isArray(d.baseTags) || d.baseTags.length > 1000 || !d.baseTags.every((s) => typeof s === "string")))
        || (d.changed !== undefined && (!Array.isArray(d.changed) || d.changed.length > 64
          || !d.changed.every((k) => changedKeys.includes(k))))) return null;
    const out = { url: d.url, title: d.title, notes: d.notes, tags: d.tags.slice(), tagInput: d.tagInput,
      private: d.private, toread: d.toread, archive: d.archive, archiveTouched: d.archiveTouched };
    if (d.summary !== undefined) out.summary = d.summary;
    // The Description's AI paragraph (popup.js _popupDraftSummaryAi): kept
    // only beside the Description it belongs to, and never an edit itself.
    if (d.summary !== undefined && d.summaryAi !== undefined) out.summaryAi = d.summaryAi;
    if (d.summaryTouched !== undefined) out.summaryTouched = d.summaryTouched;
    if (d.sharedExplicit !== undefined) out.sharedExplicit = d.sharedExplicit;
    if (d.changed !== undefined) out.changed = [...new Set(d.changed)].sort();
    // The self-hosted bookmark the edits were made on (popup.js
    // pbpPopupExpectedVersion); not an edit of its own.
    // How the draft's address differs from the opened page (popup.js
    // _popupDraftUrlSource); not an edit of its own.
    if (d.urlSource !== undefined) out.urlSource = d.urlSource;
    if (d.baseVersion !== undefined) out.baseVersion = d.baseVersion;
    // Its tag list, which the drafted tag changes are made on.
    if (d.baseTags !== undefined) out.baseTags = d.baseTags.slice();
    return JSON.stringify(out).length <= 65536 ? out : null;
  };
  // What a row holds of the user's (popup.js pbpPopupDraftEdits has the same shape).
  const edits = (d) => JSON.stringify(d?.changed ? [d.changed, d.changed.map((k) => d[k])] : d);
  if (!message.account || !["read", "write", "clear", "clearOwner"].includes(message.action)
      || (message.action !== "clearOwner" && !safeUrl(message.pageUrl))) return { ok: false, error: "invalid" };
  try {
    return await navigator.locks.request("pbp-popup-drafts", async () => {
      const current = async () => (await getCurrentBookmarkAuth()).account === message.account;
      if (!await current()) return { ok: false, error: "account_changed" };
      const ownerPrefix = prefix + encodeURIComponent(message.account) + ":";
      const key = ownerPrefix + (message.incognito === true ? "private:" : "normal:") + encodeURIComponent(message.pageUrl);
      const rows = await chrome.storage.session.get(null);
      // A storage await may straddle logout or an account switch.
      if (!await current()) return { ok: false, error: "account_changed" };
      const now = Date.now();
      const row = rows[key];
      const valid = (r) => r && typeof r.updatedAt === "number" && r.updatedAt <= now && now - r.updatedAt < ttl;
      if (message.action === "read") {
        const draft = valid(row) && row.owner === message.account && row.pageUrl === message.pageUrl
          && row.incognito === (message.incognito === true) ? clean(row.draft) : null;
        return { ok: true, account: message.account, draft };
      }
      if (message.action === "clearOwner") {
        await chrome.storage.session.remove(Object.keys(rows).filter((k) => k.startsWith(ownerPrefix)));
      } else if (message.action === "clear") {
        // Save completion clears only the snapshot actually submitted. A newer
        // edit, or pending tag text that was never submitted, must survive.
        // With a change list only the changed fields are the user's: the rest
        // of a stored row is the form as it was then, not what was submitted.
        if (message.expectedDraft) {
          const expected = clean(message.expectedDraft);
          if (!expected || expected.tagInput.trim() || edits(clean(row?.draft)) !== edits(expected)) return { ok: true, account: message.account };
        }
        await chrome.storage.session.remove(key);
      } else {
        let draft = clean(message.draft);
        if (!draft) return { ok: false, error: "invalid" };
        // While restore is pending, merge only the fields already edited.
        // The popup may close before reading the old row; its empty defaults
        // must not replace untouched values in that row.
        if (message.fields !== undefined) {
          if (!Array.isArray(message.fields) || !message.fields.length
              || !message.fields.every((k) => Object.hasOwn(draft, k))) return { ok: false, error: "invalid" };
          const previous = valid(row) && row.owner === message.account ? clean(row.draft) : null;
          // Both opens' changes count; a legacy row counts as all changed.
          // The address's provenance travels with the address: a typed edit
          // merged onto a recent draft must not keep "recent".
          if (previous) draft = clean({ ...previous, ...Object.fromEntries(message.fields.map((k) => [k, draft[k]])),
            ...(message.fields.includes("url") ? { urlSource: draft.urlSource } : {}),
            changed: previous.changed && draft.changed ? [...previous.changed, ...draft.changed] : undefined });
          if (!draft) return { ok: false, error: "invalid" };
        }
        // Only a change of the user's renews the 24-hour lifetime; the page or
        // the lookup refilling the other fields of a reopened form does not.
        const kept = draft.changed && valid(row) && row.owner === message.account && row.pageUrl === message.pageUrl
          && row.incognito === (message.incognito === true) && edits(clean(row.draft)) === edits(draft);
        await chrome.storage.session.set({ [key]: { owner: message.account, pageUrl: message.pageUrl,
          incognito: message.incognito === true, updatedAt: kept ? row.updatedAt : now, draft } });
        const others = Object.keys(rows).filter((k) => k.startsWith(prefix) && k !== key)
          .sort((a, b) => (rows[b]?.updatedAt || 0) - (rows[a]?.updatedAt || 0));
        const expired = others.filter((k, i) => !valid(rows[k]) || i >= 19);
        if (expired.length) await chrome.storage.session.remove(expired);
      }
      return { ok: true, account: message.account };
    });
  } catch (e) {
    console.warn("[popup-draft] session storage failed:", e && e.name, e && e.message);
    return { ok: false, error: "storage" };
  }
}
// Popup drafts end

// ---- 监听来自 popup 的消息 ----
// Named, not an inline arrow (roadmap #35): the router is the single entry
// for all four surfaces' messaging, and the project's source-slice test
// technique can only reach NAMED functions — as an anonymous callback these
// 21 branches were the largest untestable block in the extension. Behavior
// is unchanged; registration stays top-level synchronous per MV3 rules.
function handleRuntimeMessage(message, sender, sendResponse) {
  if (message?.type === "mdReaderBookmarkState" || message?.type === "mdReaderBookmarkSave" || message?.type === "mdReaderBookmarkDelete") {
    pbpReaderBookmarkRequest(message, sender).then(sendResponse).catch(e => {
      console.warn("reader bookmark request failed:", e?.name, e?.message);
      sendResponse(pbpSaveFailure("internal"));
    });
    return true;
  }
  if (!message || typeof message !== "object") { sendResponse({ error: "invalid" }); return true; }
  // Structural gate (defense in depth): accept only messages from this
  // extension's own PAGES. Today this is unreachable — no content script calls
  // runtime.sendMessage and the manifest has no externally_connectable — but
  // that safety is an environmental fact, not a guarantee: any future
  // postMessage→sendMessage bridge in a content script (bili-player-bridge
  // already listens for postMessage) would otherwise expose the privileged
  // handlers below (pinboard_api_call dispatches with the live token).
  // sender.url distinguishes the two: extension pages (popup, and options/
  // library/md-preview which DO run in tabs, so sender.tab can't be the test)
  // carry a chrome-extension://<own-id>/ URL; content scripts carry the web
  // page's URL. Fail closed when absent.
  if (!sender || sender.id !== chrome.runtime.id ||
      typeof sender.url !== "string" || !sender.url.startsWith(chrome.runtime.getURL(""))) {
    // One deliberate content-script window (roadmap #36): the pinboard.in
    // scripts read their prefs via message now that storage is trusted-only.
    // Same-extension sender + pinboard.in page + exactly this type; the
    // handler returns only non-secret display prefs by construction.
    if (sender && sender.id === chrome.runtime.id &&
        typeof sender.url === "string" && /^https:\/\/([a-z0-9-]+\.)?pinboard\.in\//.test(sender.url) &&
        message.type === "get_site_prefs") {
      (async () => {
        // K19: loadSettings() and the overlay-CSS read have no data
        // dependency on each other (the overlay reader's readMeta calls
        // getSettingsStorage() itself, not `s`), so run them concurrently —
        // the overlay Web Lock + storage.get calls stop sitting behind the
        // settings read in this cloak-blocked critical path. A rejection
        // from either side still rejects the combined promise and is caught
        // below exactly as it was when the two awaits were sequential.
        const [s, overlay] = await Promise.all([
          loadSettings(),
          pbpWithLargeStorageLock("customOverlayCSS", () =>
            pbpReadLargeWithFallbackUnlocked("customOverlayCSS", async () => {
              try {
                const st = await getSettingsStorage();
                return (await st.get("customOverlayCSS")).customOverlayCSS;
              } catch (_) { return ""; }
            }, "")),
        ]);
        sendResponse({
          customFont: String(s.customFont || ""),
          optTheme: String(s.optTheme || "auto"),
          themePresetKey: String(s.themePresetKey || ""),
          overlayCss: typeof overlay === "string" ? overlay : "",
          tagSortByPopEnabled: s.tagSortByPopEnabled !== false,
        });
      })().catch((e) => {
        console.warn("[site-prefs] read failed:", e?.name, e?.message);
        sendResponse(null);
      });
      return true;
    }
    sendResponse({ error: "forbidden" });
    return true;
  }
  noteActivity(); // using the popup keeps the SW warm for the next open

  if (message.type === "bookmark_connect") {
    if (new URL(sender.url).pathname !== "/options.html") { sendResponse({ok:false,error:"forbidden"}); return true; }
    pbpVerifyBookmarkConnection(message).then(sendResponse);
    return true;
  }
  if (message.type === "bookmark_api") {
    pbpBookmarkApiRequest(message).then(sendResponse).catch(error => {
      if (typeof error?.code !== "string") console.warn("[bookmark-api] failed:", error?.name, error?.message);
      sendResponse({ok:false,status:error?.status || 0,error:error?.code || "network"});
    });
    return true;
  }

  if (message.type === "PBP_RESET_PINBOARD_AUTH") {
    pbpResetPinboardAuth(message.expectedToken).then((result) => { try { sendResponse(result); } catch (_) {} });
    return true;
  }

  if (message.type === "PBP_VOCAB_DIRTY" || message.type === "PBP_NOTES_DIRTY" || message.type === "PBP_DICT_ARCHIVE_DIRTY" || message.type === "PBP_ASK_ARCHIVE_DIRTY") {
    if (!PBP_VOCAB_DRIVE_CAPABLE) {
      sendResponse({ ok: false, error: "unavailable" });
      return true;
    }
    // Any dataset dirties the one shared alarm; the round syncs every dataset.
    pbpDriveEnabled()
      .then((enabled) => enabled ? pbpDriveScheduleDirty(chrome.alarms) : false)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.warn("[drive-sync] dirty schedule failed:", e?.name, e?.message);
        sendResponse({ ok: false, error: "remote" });
      });
    return true;
  }

  if (message.type === "PBP_DICT_ARCHIVE_SYNC") {
    (async () => {
      const auth = await getCurrentLibraryAuth();
      if (!auth?.account && !message.owner) return { ok: true, connected: false };
      if (!auth?.account || !pbpLibraryAuthIsCurrent(auth) || pbpDictOwnerScope(auth.account) !== message.owner) {
        return { ok: false, code: "account_changed" };
      }
      if (!await pbpVocabDriveIsConnected()) return { ok: true, connected: false };
      const result = await pbpQueueDriveRound({ dictionaryOnly: true, manual: true });
      if (!pbpLibraryAuthIsCurrent(auth)) return { ok: false, code: "account_changed" };
      const dataset = result.results?.dictionary;
      return { ok: result.ok === true && dataset?.status?.bootstrapComplete === true,
        connected: true, code: result.ok && dataset?.status?.bootstrapComplete === true ? null : result.error || "unexpected" };
    })().then(sendResponse).catch(error => {
      console.warn("[dict-archive] lookup sync failed:", error?.name, error?.code);
      sendResponse({ ok: false, code: typeof error?.code === "string" ? error.code : "unexpected" });
    });
    return true;
  }

  if (message.type === "PBP_ASK_ARCHIVE_RESTORE") {
    (async () => {
      const auth = await getCurrentLibraryAuth();
      if (!auth?.account && (!message.owner || message.owner === "ownerless")) return { ok: true, connected: false };
      if (!auth?.account || !pbpLibraryAuthIsCurrent(auth) || pbpDictOwnerScope(auth.account) !== message.owner) {
        return { ok: false, code: "account_changed" };
      }
      if (!await pbpVocabDriveIsConnected()) return { ok: true, connected: false };
      const result = await pbpQueueDriveRound({ askOnly: true, manual: true });
      if (!pbpLibraryAuthIsCurrent(auth)) return { ok: false, code: "account_changed" };
      const dataset = result.results?.ask;
      return { ok: result.ok === true && dataset?.status?.bootstrapComplete === true,
        connected: true, code: result.ok && dataset?.status?.bootstrapComplete === true ? null : result.error || "unexpected" };
    })().then(sendResponse).catch(error => {
      console.warn("[ask-archive] history sync failed:", error?.name, error?.code);
      sendResponse({ ok: false, code: typeof error?.code === "string" ? error.code : "unexpected" });
    });
    return true;
  }

  if (message.type === "vocabDriveConnect") {
    if (!PBP_VOCAB_DRIVE_CAPABLE) {
      sendResponse({ ok: false, error: "unavailable" });
      return true;
    }
    // pbpConnectDrive owns the connected flag: only a non-retryable refusal of
    // the grant clears it, never a dataset failure in the forced round (A4).
    pbpConnectDrive()
      .then((result) => pbpVocabDriveResponse(result))
      .then(sendResponse)
      .catch((error) => {
        console.warn("[vocab-drive] connect failed:", error?.name, error?.message);
        sendResponse({ ok: false, error: "remote" });
      });
    return true;
  }

  if (message.type === "vocabDriveStatus") {
    if (!PBP_VOCAB_DRIVE_CAPABLE) {
      sendResponse({ ok: false, error: "unavailable" });
      return true;
    }
    pbpGetVocabDriveStatus()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => {
        console.warn("[drive-sync] status failed:", error?.name, error?.message);
        sendResponse({ ok: false, error: "remote" });
      });
    return true;
  }

  if (message.type === "vocabDriveClearNotices") {
    getCurrentLibraryAuth()
      .then(async (auth) => {
        if (!auth.account || !pbpLibraryAuthIsCurrent(auth)) {
          return { ok: false, error: "pinboard_auth" };
        }
        const owner = pbpDictOwnerScope(auth.account);
        const cleared = await Promise.all([pbpVocabClearNotices(owner), pbpNotesClearNotices(owner)]);
        if (!pbpLibraryAuthIsCurrent(auth)) return { ok: false, error: "account_changed" };
        return cleared.every(Boolean) ? { ok: true } : { ok: false, error: "local_store" };
      })
      .then((result) => pbpVocabDriveResponse(result))
      .then(sendResponse)
      .catch((error) => {
        console.warn("[drive-sync] clear notices failed:", error?.name, error?.message);
        sendResponse({ ok: false, error: "remote" });
      });
    return true;
  }

  if (message.type === "vocabDriveSyncNow") {
    if (!PBP_VOCAB_DRIVE_CAPABLE) {
      sendResponse({ ok: false, error: "unavailable" });
      return true;
    }
    pbpVocabDriveIsConnected()
      .then(async (connected) => {
        // Not an authorization problem: this device simply has not connected.
        if (!connected) return { ok: false, error: "not_connected" };
        // The round reconciles drive-sync-retry when it ends (§3.4); clearing
        // it first only keeps a stale retry from firing in the middle of it.
        if (message.force === true) await chrome.alarms.clear(PBP_DRIVE_RETRY_ALARM);
        // manual: the page shows this round's outcome, so no system notification.
        return pbpQueueDriveRound({
          interactive: false,
          force: message.force === true,
          manual: true
        });
      })
      .then((result) => pbpVocabDriveResponse(result))
      .then(sendResponse)
      .catch((error) => {
        console.warn("[drive-sync] sync now failed:", error?.name, error?.message);
        sendResponse({ ok: false, error: "remote" });
      });
    return true;
  }

  if (message.type === "vocabDriveDisconnect") {
    if (!PBP_VOCAB_DRIVE_CAPABLE) {
      sendResponse({ ok: false, error: "unavailable" });
      return true;
    }
    pbpDisconnectVocabDrive()
      .then(sendResponse)
      .catch((error) => {
        console.warn("[vocab-drive] disconnect failed:", error?.name, error?.message);
        sendResponse({ ok: false, error: "remote" });
      });
    return true;
  }

  if (message.type === "get_bookmark_data" && message.url) {
    getCurrentBookmarkAuth().then(async (auth) => {
      if (!message.account || message.account !== auth.account) {
        sendResponse({ posts: null, account: "" });
        return;
      }
      await pbpStatusCacheRestore(message.url, auth);
      const cached = pbpStatusCacheGet(message.url, auth);
      const fresh = pbpStatusCacheFormPosts(cached, auth);
      sendResponse({
        posts: fresh || null,
        // The page as linkding read it, when the check that filled this entry did.
        metadata: fresh ? cached.metadata ?? null : null,
        account: auth.account,
      });
    }).catch(() => sendResponse({ posts: null, account: "" }));
    return true;
  }

  // K1: the popup's COLD bookmark lookup, resolved inside the worker instead of
  // through the bare pinboard_api_call proxy. Three things follow from that:
  // the popup's request and the toolbar icon's own check for the same page
  // collapse into one posts/get via _pendingChecks (whichever arrives first
  // wins; the other awaits it) instead of racing for the same 3.1s rate-limit
  // slot; the answer lands in statusCache, which the proxy path never wrote, so
  // the next tab event and the next popup open are free; and the icon is
  // correct the moment the popup finishes.
  // NOT debouncedCheck: that one returns early when optCheckBookmarkStatus is
  // off, and a user who hid the toolbar state still needs the popup to know
  // whether this page is saved. _dedupedBookmarkCheck is the shared half.
  // The URL is the popup's verbatim (already-cleaned) lookup URL — the worker
  // must not re-derive it, or the key would stop matching the caller's query.
  // Shape: BOTH account guards and the "TTL hit without .posts -> one fresh posts/get" rule: the
  // save / quick-save / batch / skip / offline-queue call sites write status
  // entries carrying `bookmarked` and no posts, and the popup needs
  // description/extended/tags/shared/toread to fill its form.
  if (message.type === "lookup_bookmark" && message.url) {
    const url = message.url;
    const refuse = () => sendResponse({ ok: false, status: 0, error: "account_changed", posts: null, account: "" });
    (async () => {
      const auth = await getCurrentBookmarkAuth();
      if (!message.account || message.account !== auth.account) { refuse(); return; }
      if (!auth.token) { refuse(); return; }
      const freshPosts = () => pbpStatusCacheFormPosts(pbpStatusCacheGet(url, auth), auth);
      const freshMetadata = () => pbpStatusCacheGet(url, auth)?.metadata ?? null;
      await pbpStatusCacheRestore(url, auth);
      let posts = freshPosts();
      if (!posts) {
        const check = await _dedupedBookmarkCheck(url, auth);
        if (!pbpBookmarkAuthIsCurrent(auth)) { refuse(); return; }
        // A self-hosted check that already failed is answered with its cause:
        // asking the same server again only doubles the wait (linkding fetches
        // the page on every check). Same shape as the catch below.
        if (pbpSelfHostedAuth(auth) && check?.failure) {
          sendResponse({ ok: false, status: 0, error: check.failure.reason || "lookup", ...(Number.isInteger(check.failure.httpStatus) ? { httpStatus: check.failure.httpStatus } : {}), posts: null, account: "" });
          return;
        }
        posts = freshPosts();
      }
      if (!posts) {
        // Either the cache entry was posts-less, or the shared Pinboard check
        // failed (a failed self-hosted check was answered above) — one fresh
        // lookup settles both, and its result is what gets cached.
        // This is also the ONLY path that can surface a 401 to the caller:
        // checkBookmarked() (inside _dedupedBookmarkCheck) folds !resp.ok into
        // a plain `false`, so an expired token never reaches here as an error
        // above. It never fires for a genuinely unbookmarked page, though --
        // checkBookmarked() still writes `posts: []` on success, and `[]` is
        // truthy, so freshPosts() returns it and this second request is skipped.
        const resp = await (pbpSelfHostedAuth(auth) ? pbpBookmarkPostsResponse(auth, url) : pinboardFetch(`https://api.pinboard.in/v1/posts/get?auth_token=${auth.token}&format=json&url=${encodeURIComponent(url)}`));
        if (!resp.ok) {
          sendResponse({ ok: false, status: resp.status, error: resp.error || "", posts: null, account: auth.account });
          return;
        }
        const data = await resp.json();
        posts = data.posts || [];
        if (!pbpBookmarkAuthIsCurrent(auth)) { refuse(); return; }
        if (!pbpStatusCacheSet(url, auth, { bookmarked: posts.length > 0, timestamp: Date.now(), posts, metadata: data.metadata ?? null })) { refuse(); return; }
      }
      sendResponse({ ok: true, status: 200, posts, metadata: freshMetadata(), account: auth.account });
    })().catch((e) => {
      // Fold to the proxy's own failure shape (status 0 + reason) so the popup
      // names the cause the same way it does for every other proxied call.
      // The server's HTTP status rides apart: status stays 0 so a self-hosted
      // 401 never reaches the popup's Pinboard login reset, while the copy for
      // a refused request can still name it.
      console.warn("[lookup_bookmark] failed:", e && e.name, e && e.message);
      sendResponse({ ok: false, status: 0, error: e?.code || "Failed to fetch", ...(Number.isInteger(e?.status) ? { httpStatus: e.status } : {}), posts: null, account: "" });
    });
    return true;
  }

  if (message.type === "PBP_POPUP_DRAFT") {
    pbpRunPopupDraft(message).then((result) => { try { sendResponse(result); } catch (_) {} });
    return true;
  }

  if (message.type === "get_offline_queue") {
    // pbpReadOfflineQueuePause never rejects; a failed read reports no pause.
    // account: the current connection's non-secret owner ("" when there is
    // none), so the popup can tell its items from other connections'.
    Promise.all([readOfflineQueueWithIds(), pbpReadOfflineQueuePause(), getCurrentBookmarkAuth().catch(() => null)])
      .then(([queue, pause, auth]) => sendResponse({ ok: true, queue, pause: pause ? { account: pause.account, reason: pause.reason } : null,
        ...(auth ? { account: typeof auth.account === "string" ? auth.account : "" } : {}) }))
      .catch(() => sendResponse({ ok: false, queue: [] }));
    return true;
  }

  // K44: the popup hands the worker a finished prompt plus its cache
  // coordinates; the worker owns the paid call from here, so closing the popup
  // costs the render and nothing else. `return true` keeps the channel open and
  // this listener stays a plain (non-async) function — MV3 allows exactly one
  // of the two. pbpRunPopupAiCall never rejects; the rejection arm covers a
  // programming error only, and a sendResponse that throws is the expected
  // dead-port case this whole feature exists for (the cache write already ran).
  if (message.type === "PBP_AI_CALL") {
    pbpRunPopupAiCall(message).then(
      (envelope) => { try { sendResponse(envelope); } catch (_) { /* popup gone: result is cached, nothing to deliver it to */ } },
      (e) => {
        console.warn("[pbp-ai] popup AI call crashed:", e && e.name, e && e.message);
        try { sendResponse({ ok: false, error: pbpAiErrorEnvelope(e) }); } catch (_) {}
      }
    );
    return true;
  }

  if (message.type === "save_intent") {
    // The popup document that asked for this save is often long gone by the
    // time submitPopupSaveIntent resolves (posts/get + rate-limit wait +
    // posts/add routinely runs 3-7s; a click on the page or a tab switch
    // destroys the popup mid-flight). sendResponse to a closed port is a
    // silent no-op, so on a "failed" result we additionally check whether
    // any popup context still exists and, if not, surface the failure the
    // same way the background quick-save path already does (notifySaveFailure).
    // "queued"/"skipped"/"saved" never notify here: queued is covered by the
    // offline-queue row on next popup open, and the other two are not
    // failures. minimum_chrome_version is 123, so getContexts (Chrome 116+)
    // needs no feature-detection fallback.
    submitPopupSaveIntent(message.intent, message.account, message.summaryRange, message.singleFileTab, message.expectedVersion)
      .then(async (result) => {
        if (result.status === "saved" && message.popupDraft) {
          await pbpRunPopupDraft({ ...message.popupDraft, account: message.account, action: "clear" });
        }
        sendResponse(result);
        if (result.status !== "failed") return;
        const ctx = await chrome.runtime.getContexts({ contextTypes: ["POPUP"] }).catch(() => []);
        if (!ctx.length) notifySaveFailure("popup-save", result, pbpBookmarkAccountService(message.account));
      })
      // Programming-error path only: submitPopupSaveIntent itself never rejects
      // on a delivery failure (those resolve to a "failed" result and take the
      // notify branch above), so this arm is rare in practice but must not be
      // silent when it does fire.
      .catch((e) => {
        console.warn("save intent failed:", e?.name, e?.message);
        sendResponse(pbpSaveFailure("internal"));
      });
    return true;
  }

  if (message.type === "archive_url" && typeof message.url === "string") {
    // Acknowledge AFTER the archive attempt has run and its log entry is
    // written (pbpWaybackArchive resolves post-log and never throws), so the
    // caller can re-render its log on response instead of guessing with a
    // timer. This was the one branch of this listener with no sendResponse:
    // the port closed synchronously and the retry button looked dead for the
    // full 10-30s archive timeout.
    loadSettings()
      .then((s) => pbpWaybackArchive(message.url, s, { isPrivate: message.private === true, force: message.force === true }))
      .then(() => sendResponse({ done: true }))
      .catch((e) => {
        console.warn("[wayback] archive_url failed:", e?.name, e?.message);
        sendResponse({ done: false });
      });
    return true;
  }

  if (message.type === "bookmark_deleted" && message.url) {
    getCurrentBookmarkAuth().then(async (auth) => {
      if (!message.account || message.account !== auth.account) {
        sendResponse({ ok: false });
        return;
      }
      const updated = pbpStatusCacheSet(message.url, auth, { bookmarked: false, timestamp: Date.now() });
      if (updated) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (pbpBookmarkAuthIsCurrent(auth) && tab?.id && pbpSameBookmark(tab.url, message.url)) {
          setIcon(tab.id, "default", tab.url);
        }
      }
      sendResponse({ ok: updated });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.action === "saveTabSet" && message.tabsData) {
    handleSaveTabSet(message.tabsData);
    sendResponse({ status: "started" });
    return true;
  }

  if (message.action === "startBatchSave" && Array.isArray(message.tabs)) {
    if (_batchRunning) { sendResponse({ status: "busy" }); return true; }
    _batchRunning = true; // reserve synchronously before the first auth await
    getCurrentBookmarkAuth().then((auth) => {
      if (!message.account || auth.account !== message.account) {
        _batchRunning = false;
        sendResponse({ status: "account_changed" });
        return;
      }
      handleBatchSave(message.tabs, message.account, true).catch(() => {}); // fire-and-forget; keeps SW alive via in-flight fetches
      sendResponse({ status: "started", account: message.account });
    }).catch(() => {
      _batchRunning = false;
      sendResponse({ status: "account_changed" });
    });
    return true;
  }

  if (message.type === "pinboard_api_call") {
    // Proxy Pinboard fetch through service worker to avoid Chrome's native auth dialog on 401
    if (!pbpIsAllowedPinboardApiUrl(message.url)) {
      sendResponse({ ok: false, status: 0, text: "", error: "invalid_pinboard_api_url" });
      return true;
    }
    getCurrentBookmarkAuth().then(async (auth) => {
      const authorizedUrl = pbpAuthorizePinboardApiUrl(message.url, auth.token);
      if (!authorizedUrl) {
        sendResponse({ ok: false, status: 0, text: "", error: "account_changed" });
        return;
      }
      const immediate = message.immediate === true
        && new URL(authorizedUrl).pathname === "/v1/posts/suggest";
      // timeoutMs pass-through (roadmap #23): options' tag-governance calls
      // need 30s for posts/all-sized reads; clamp so a page can't park a
      // queue slot forever.
      const timeoutMs = Math.min(60000, Math.max(1000, Number(message.timeoutMs) || 15000));
      const res = immediate
        ? await pinboardFetchImmediate(authorizedUrl, { timeoutMs: 8000 })
        : await pinboardFetch(authorizedUrl, { timeoutMs });
        const text = await res.text();
        if (!pbpBookmarkAuthIsCurrent(auth)) {
          sendResponse({ ok: false, status: 0, text: "", error: "account_changed" });
          return;
        }
        sendResponse({ ok: res.ok, status: res.status, text });
      })
      .catch(err => sendResponse({ ok: false, status: 0, text: "", error: err.code || err.message }));
    return true;
  }

  if (message.type === "retry_offline_item" && typeof message.queueId === "string") {
    retryOfflineItem(message.queueId)
      .then(({ ok, result }) => sendResponse({ ok, result }))
      .catch((e) => {
        console.warn("save intent failed:", e?.name, e?.message);
        sendResponse({ ok: false, result: pbpSaveFailure("internal") });
      });
    return true;
  }

  if (message.type === "remove_offline_item" && typeof message.queueId === "string") {
    mutateOfflineQueue({ kind: "remove", queueId: message.queueId })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.warn("offline queue remove failed:", e?.name, e?.message);
        sendResponse({ ok: false });
      });
    return true;
  }

  if (message.type === "clear_offline_queue") {
    mutateOfflineQueue({ kind: "clear" })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.warn("offline queue clear failed:", e?.name, e?.message);
        sendResponse({ ok: false });
      });
    return true;
  }

  if (message.type === "test_pinboard_token" && message.token) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    // redirect:"error" — same invariant _executePinboardFetch enforces: the
    // auth_token rides the query string, so following a 3xx would replay the
    // plaintext token to whatever host the Location names. A 3xx now rejects
    // into the existing .catch and reports as a network failure.
    fetch(`https://api.pinboard.in/v1/user/api_token/?auth_token=${encodeURIComponent(message.token)}&format=json`, { signal: ctrl.signal, redirect: "error" })
      .then(res => { clearTimeout(timer); sendResponse({ ok: res.ok, status: res.status }); })
      .catch(err => { clearTimeout(timer); sendResponse({ ok: false, error: err.name === "AbortError" ? "timeout" : "network" }); });
    return true; // keep channel open for async response
  }

  // ---- Image-fix Referer rules (hotlink round). Tab scope comes from
  // sender.tab, never the message; the sender must be OUR preview page, so no
  // other surface (content script, another extension page) can drive this.
  // frameId === 0 (top-level document) on both handlers: a sub-frame that
  // happened to load md-preview.html would otherwise satisfy the URL prefix
  // check. The repo embeds no such frame today -- this is defense in depth.
  if (message.type === "imgFixInstallReferer") {
    const tabId = sender && sender.tab && sender.tab.id;
    const fromPreview = !!(sender && sender.frameId === 0 && _imgFixIsPreviewUrl(sender.url));
    const domains = Array.isArray(message.domains)
      ? message.domains.filter((d) => typeof d === "string" && d && !/[/:*?]/.test(d)) : [];
    let origin = "";
    try {
      const p = new URL(message.origin);
      if (p.protocol === "https:" || p.protocol === "http:") origin = p.origin;
    } catch (_) {}
    if (typeof tabId !== "number" || !fromPreview || !domains.length || !origin) {
      sendResponse({ ok: false, error: "bad_request" });
      return true;
    }
    pbpImgFixInstallRule({ domains, origin, tabId, docUrl: sender.url })
      .then((ruleId) => sendResponse({ ok: true, ruleId }))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || "install_failed" }));
    return true;
  }

  if (message.type === "imgFixRemoveReferer") {
    const tabId = sender && sender.tab && sender.tab.id;
    const fromPreview = !!(sender && sender.frameId === 0 && _imgFixIsPreviewUrl(sender.url));
    const ids = Array.isArray(message.ruleIds) ? message.ruleIds.filter((n) => typeof n === "number") : [];
    if (typeof tabId !== "number" || !fromPreview || !ids.length) { sendResponse({ ok: false }); return true; }
    pbpImgFixRemoveRules(ids, tabId, sender.url)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  // A freshly loaded preview clears its OWN tab's leftovers. Covers the one
  // navigation Chrome never reports as a URL change: a same-URL reload (F5 /
  // Memory-Saver restore), after which the old document's rules would otherwise
  // sit there until the tab closed (confirm-review 3).
  if (message.type === "imgFixResetTab") {
    const tabId = sender && sender.tab && sender.tab.id;
    const fromPreview = !!(sender && sender.frameId === 0 && _imgFixIsPreviewUrl(sender.url));
    if (typeof tabId !== "number" || !fromPreview) { sendResponse({ ok: false }); return true; }
    pbpImgFixSweepRules(tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "reextractMarkdown") {
    const { tabId, url, engine, k, sourceTabUrl } = message;
    const frame = message.frame === true; // embedded-frame pass, only after the reader's grant button
    // The origin the reader says the user granted: origin form only (no path),
    // https only; checked against the live grant below before any injection.
    // True origin-form check (Codex 2026-08-26): the URL parser rejects
    // wildcards / spaces, and `origin === input` rejects any path, query,
    // fragment, credentials or default-port noise a regex would let through.
    const frameOrigin = (() => {
      if (!frame || typeof message.frameOrigin !== "string") return "";
      try { const u = new URL(message.frameOrigin); return (u.protocol === "https:" && u.origin === message.frameOrigin) ? u.origin : ""; }
      catch (_) { return ""; }
    })();
    if (!url || (engine !== "local" && engine !== "jina")) {
      sendResponse({ ok: false, error: "bad_request" }); return true;
    }
    // Write back to the requesting tab's own token key so the reload reads the
    // fresh payload from the SAME slot it owns. No k = pre-update tab → fall
    // back to the legacy global key.
    const key = k ? "md_preview_data_" + k : "md_preview_data";
    (async () => {
      const stored = (await chrome.storage.local.get(key))[key];
      if (!stored || stored.url !== url || stored.tabId !== tabId) {
        sendResponse({ ok: false, error: "bad_request" });
        return;
      }
      // The storage slot is the preview's immutable ownership record. Message
      // fields are mutable and must never be allowed to replace account metadata.
      const owner = {
        account: typeof stored.account === "string" ? stored.account : "",
        tags: Array.isArray(stored.tags) ? stored.tags.slice() : [],
        description: typeof stored.description === "string" ? stored.description : "",
        sourceIncognito: stored.sourceIncognito === true,
        bookmarkDraft: stored.bookmarkDraft,
        bookmarkUrl: stored.bookmarkUrl,
      };
      // sourceTabUrl is IMMUTABLE tab identity (hotlink round): prefer the
      // slot's own record, else the message's, else the legacy url. It must
      // survive every payload rewrite below, or one Jina pass (whose d.url
      // overwrites `url`) would erase it and re-brick the local engine.
      const tabUrl = (typeof stored.sourceTabUrl === "string" && stored.sourceTabUrl)
        || (typeof sourceTabUrl === "string" && sourceTabUrl) || url;
      // Frame pass: the grant must exist for exactly the origin the reader
      // names (contains only -- the SW never requests), else the message is a
      // stale or forged request and gets the same host_permission answer the
      // reader already knows how to show.
      if (frame) {
        let held = false;
        if (frameOrigin) {
          try { held = await chrome.permissions.contains({ origins: [frameOrigin + "/*"] }); } catch (_) { held = false; }
        }
        if (!held) { sendResponse({ ok: false, error: "host_permission" }); return; }
      }
      // Refresh-then-extract (2026-10-19): the reader's images carried
      // time-limited CDN signatures that expired, and only a fresh copy of the
      // page carries fresh ones. Local engine, top frame only.
      if (message.reloadSource === true) {
        if (engine !== "local" || frame) { sendResponse({ ok: false, error: "bad_request" }); return; }
        const live = await _cbTabsGet(tabId);
        if (!live) { sendResponse({ ok: false, error: "tab_unavailable" }); return; }
        // Never reload a tab that has moved on to some other page: that would
        // throw away whatever the user is doing there.
        if (live.url !== tabUrl) { sendResponse({ ok: false, error: "tab_navigated" }); return; }
        // activeTab does not survive the reload (a navigation revokes it), so
        // the injection after it needs a standing grant for the page's exact
        // origin -- which the reader requested from the click. contains only:
        // the SW never prompts.
        let pageOrigin = "";
        try { const u = new URL(tabUrl); if (u.protocol === "https:") pageOrigin = u.origin; } catch (_) {}
        let held = false;
        if (pageOrigin) {
          try { held = await chrome.permissions.contains({ origins: [pageOrigin + "/*"] }); } catch (_) { held = false; }
        }
        if (!held) { sendResponse({ ok: false, error: "host_permission" }); return; }
        if (!await pbpReloadTabAndSettle(tabId)) { sendResponse({ ok: false, error: "tab_unavailable" }); return; }
      }
      const out = await extractForPreview({ tabId, url, engine, sourceTabUrl: tabUrl, frame, frameOrigin });
      if (out.error) {
        // frameOrigin (origin string only) lets the reader offer the one-click
        // grant for an article that lives in an embedded cross-origin frame.
        sendResponse(out.frameOrigin ? { ok: false, error: out.error, frameOrigin: out.frameOrigin } : { ok: false, error: out.error });
        return;
      }
      const latest = (await chrome.storage.local.get(key))[key];
      if (!latest || latest.url !== url || latest.tabId !== tabId
          || (typeof latest.account === "string" ? latest.account : "") !== owner.account) {
        sendResponse({ ok: false, error: "account_changed" });
        return;
      }
      await chrome.storage.local.set({
        [key]: {
          // baseUrl resolves relative links/images: for a frame pass it is the
          // FRAME's own URL (out.baseUrl), never the top page's (Codex 2026-08-26).
          ...out, baseUrl: out.baseUrl || out.url || url, tabId, sourceTabUrl: tabUrl,
          account: owner.account,
          tags: owner.tags,
          description: owner.description,
          sourceIncognito: owner.sourceIncognito,
          ...(owner.bookmarkDraft ? { bookmarkDraft: owner.bookmarkDraft } : {}),
          // A Jina pass rewrites url; the bookmark address stays the handoff's.
          ...(typeof owner.bookmarkUrl === "string" ? { bookmarkUrl: owner.bookmarkUrl } : {}),
          ts: Date.now() // sweep grace (see pbpSweepPreviewOrphans)
        }
      });
      sendResponse({ ok: true });
    })()
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
}
chrome.runtime.onMessage.addListener(handleRuntimeMessage);

// ===================== Batch Bookmark 保存（后台） =====================
// The batch loop moved out of popup-batch.js so it survives popup close.
// Progress is mirrored to storage.local.batch_progress for the popup to render;
// the completion notification fires here regardless of popup state.
let _batchRunning = false;

function _newBatchRunId() {
  return crypto.randomUUID();
}

// A cleanup from run A must never delete run B's newer snapshot/cancel marker.
// Chrome storage has no compare-and-delete primitive, but the SW has one live
// generation and _batchRunning serializes starts; the ownership re-read closes
// the only practical stale-finally path.
async function _removeBatchRecordIfOwned(key, runId) {
  try {
    const stored = await chrome.storage.local.get(key);
    if (stored[key]?.runId !== runId) return false;
    await chrome.storage.local.remove(key);
    return true;
  } catch (e) {
    console.warn(`[batch] ${key} cleanup failed:`, e?.name, e?.message);
    return false;
  }
}

// Returns whether the record actually landed: a caller that announces a terminal
// state (the interrupted sweep) must not tell the user a story storage refused to
// keep. In-loop callers ignore it — the progress UI degrades, the batch continues.
async function _writeBatchProgress(p) {
  // Ongoing batch work IS activity: without this, a long batch (100 tabs with
  // AI ≈ 13 min) outlives the 10-min keepalive window, and the next AI call
  // that goes ~30s without touching a chrome.* API lets the SW idle-terminate
  // mid-run. One call per processed item keeps the window open exactly as long
  // as real work is progressing — no 24/7 drain. typeof-guarded: source-slice
  // test pages execute this function without the keepalive block in scope.
  if (typeof noteActivity === "function") noteActivity();
  try {
    await chrome.storage.local.set({ batch_progress: { ...p, ts: Date.now() } });
    return true;
  } catch (e) {
    // MV3 rule: never swallow a platform failure silently. No secrets in this
    // record — counters plus the non-secret account.
    console.warn("[batch] progress write failed:", e?.name, e?.message);
    return false;
  }
}

// A batch that died with the SW (browser quit, extension reload, crash) leaves
// batch_progress stuck at running with no terminal record and no notification —
// the user never learns which tab it stopped on. Re-running is cheap (AI results
// come from the IDB cache, saves merge tags and keep the original time), so the
// only fix needed is to close the record out loud. Runs on the existing keepalive
// alarm: no new storage key, no new alarm.
async function pbpSweepInterruptedBatch() {
  if (_batchRunning) return; // this SW generation owns a live batch
  const { batch_progress: bp } = await chrome.storage.local.get("batch_progress");
  if (!bp || !bp.running || bp.done) return;
  if (batchIsRunning(bp, Date.now(), BATCH_STALE_TTL)) return; // heartbeat still fresh
  // Account isolation: the record is derived from the account that started the
  // batch, so a different signed-in account may neither close it out nor be told
  // about it. Leaving it untouched costs nothing — it is a single key that the
  // next batch (any account) overwrites wholesale, its stale ts already reads as
  // "not running" everywhere, and the owner's own session sweeps it on return.
  const auth = await getCurrentBookmarkAuth();
  if (bp.account && bp.account !== auth.account) return;
  // TOCTOU: the startBatchSave handler reserves _batchRunning synchronously and a
  // live batch rewrites batch_progress with a fresh ts, and both awaits above gave
  // a retry room to start. Re-check the flag AND confirm the record is still the
  // exact one that was read — writing the "interrupted" shape over a batch that is
  // actually running would report it as dead in the popup and in a notification.
  if (_batchRunning) return;
  const fresh = (await chrome.storage.local.get("batch_progress")).batch_progress;
  if (!fresh || !fresh.running || fresh.done || fresh.runId !== bp.runId || fresh.ts !== bp.ts) return;
  if (_batchRunning) return;
  // RESUME first (roadmap #34): when the interrupted worker left a valid job
  // snapshot for this account with unprocessed tabs, pick the batch back up at
  // its cursor instead of declaring it dead. Bounded to two revivals so a
  // batch that keeps dying (e.g. an item that crashes the worker) converges to
  // the interrupted terminal state instead of looping forever. Credentials are
  // NEVER in the snapshot — the resumed run re-reads them like any fresh one.
  try {
    const { batch_job: job } = await chrome.storage.local.get("batch_job");
    if (job && typeof bp.runId === "string" && bp.runId && job.runId === bp.runId &&
        job.account === bp.account && Array.isArray(job.tabs) &&
        Number(job.next) < job.tabs.length && Number(job.resumeCount || 0) < 2) {
      if (_batchRunning) return; // last-moment TOCTOU re-check before reserving
      _batchRunning = true;
      const resumeState = {
        runId: job.runId,
        startIndex: Number(job.next) || 0,
        counts: job.counts || {},
        resumeCount: Number(job.resumeCount || 0) + 1,
      };
      console.info(`[batch] resuming interrupted batch at ${resumeState.startIndex}/${job.tabs.length} (attempt ${resumeState.resumeCount})`);
      handleBatchSave(job.tabs, job.account, true, resumeState).catch((e) => {
        console.warn("[batch] resumed run failed:", e?.name, e?.message);
      });
      return;
    }
    if (job?.runId === bp.runId) await _removeBatchRecordIfOwned("batch_job", bp.runId);
  } catch (e) {
    // Resume is best-effort; the interrupted terminal state below still lands.
    console.warn("[batch] resume snapshot read failed:", e?.name, e?.message);
  }
  // The snapshot read/removal above yielded. Confirm identity again so a new
  // run that started in that window is neither overwritten nor announced dead.
  if (_batchRunning) return;
  const latest = (await chrome.storage.local.get("batch_progress")).batch_progress;
  if (!latest || latest.runId !== bp.runId || latest.ts !== bp.ts || !latest.running || latest.done) return;
  // Announce only what actually landed: a swallowed storage failure would leave the
  // record stuck at running while the user reads an "interrupted" toast, and every
  // later alarm tick would fire another one.
  if (!(await _writeBatchProgress({ ...bp, running: false, done: true, error: "interrupted" }))) return;
  // Failure title, not the success one: showNotification's category only gates
  // the on/off switch, and the icon is the same pin either way, so the title is
  // the notification's ONLY semantic label -- "Batch Saved!" over "interrupted
  // at 2 of 5" is a headline that contradicts its own body.
  showNotification("batch-error", t("bgSaveFailed"),
    t("batchInterrupted", String(bp.i || 0), String(bp.total || 0)), "error");
}

function handleBatchSave(tabs, expectedAccount = "", reserved = false, resumeState = null) {
  if (!reserved) {
    if (_batchRunning) return Promise.resolve();
    _batchRunning = true;
  }
  return _runBatchSave(tabs, expectedAccount, resumeState).finally(() => { _batchRunning = false; });
}

async function _runBatchSave(tabs, expectedAccount, resumeState = null) {
  const runId = resumeState?.runId || _newBatchRunId();
  const startAuth = await getCurrentBookmarkAuth();
  const account = expectedAccount || startAuth.account;
  if (!startAuth.token || !account || startAuth.account !== account) {
    // audit A13: the message handler already replied "started" before this
    // second credential read - a bare return left no terminal
    // batch_progress record and the popup sat disabled at 0% forever.
    // Write the same done-with-error shape the in-run catch produces -
    // but ONLY when an expectedAccount was explicitly handed over (the
    // popup start flow always passes one, so a poller exists): that
    // covers both a genuine account switch AND an external token clear
    // in this window (Codex r2 L6). Internal/legacy calls without an
    // expected account keep the established no-record contract.
    if (expectedAccount && account) {
      await _writeBatchProgress({
        running: false, done: true, error: "account_changed",
        runId, account, total: tabs.length, i: 0,
        saved: 0, queued: 0, failed: 0, aiFailed: 0, skipped: 0, tooLong: 0, tagTooLong: 0, partial: 0
      });
    }
    // A resumed run landing here means the account changed while the batch
    // was down — its snapshot can never be finished by anyone. Drop it.
    await _removeBatchRecordIfOwned("batch_job", runId);
    await _removeBatchRecordIfOwned("batch_cancel_requested", runId);
    _batchRunning = false;
    return;
  }
  const total = tabs.length;
  // Resumable job (roadmap #34): counts and the cursor either start fresh or
  // pick up where the interrupted worker generation left off.
  const rc = (resumeState && resumeState.counts) || {};
  let processed = Number(rc.processed) || 0;
  let saved = Number(rc.saved) || 0, queued = Number(rc.queued) || 0, failed = Number(rc.failed) || 0,
      aiFailed = Number(rc.aiFailed) || 0, skipped = Number(rc.skipped) || 0, tooLong = Number(rc.tooLong) || 0,
      tagTooLong = Number(rc.tagTooLong) || 0;
  // A Karakeep save that created the bookmark but not every later step: it is
  // on the server, so it is not a failure, and a rerun updates it in place.
  let partial = Number(rc.partial) || 0;
  // Some of those partials were the duplicate Read Later list; the summary names it once.
  let partialList = rc.partialList === true;
  // The first tag linkding could not store, as the summary names it. It rides
  // with the counts so a resumed run can still name it.
  let longTag = typeof rc.longTag === "string" ? rc.longTag : "";
  // Set when that failure was a skip-mode create: PostgreSQL linkding kept the
  // bookmark without tags, so a rerun in skip mode would pass it by.
  let longTagSkip = rc.longTagSkip === true;
  const startIndex = resumeState ? Math.max(0, Number(resumeState.startIndex) || 0) : 0;
  const resumeCount = Number(resumeState?.resumeCount) || 0;
  const base = () => ({ runId, resumeCount, account, total, i: processed, saved, queued, failed, aiFailed, skipped, tooLong, tagTooLong, partial, partialList, longTag, longTagSkip });
  // Persist the job snapshot BEFORE the first item: everything a resume needs
  // (public tab identity + cursor + counts), never a token. The per-item
  // checkpoint below rewrites cursor+counts; every terminal path removes it.
  const jobRecord = () => ({
    runId,
    account,
    tabs: tabs.map((tb) => ({ id: tb.id, url: tb.url, title: tb.title, incognito: !!tb.incognito })),
    next: processed,
    counts: { processed, saved, queued, failed, aiFailed, skipped, tooLong, tagTooLong, partial, partialList, longTag, longTagSkip },
    resumeCount,
    ts: Date.now(),
  });
  const clearJob = () => _removeBatchRecordIfOwned("batch_job", runId);
  const clearCancel = () => _removeBatchRecordIfOwned("batch_cancel_requested", runId);
  try { await chrome.storage.local.set({ batch_job: jobRecord() }); }
  catch (e) { console.warn("[batch] initial checkpoint failed:", e?.name, e?.message); }
  const requireAccount = async () => {
    const auth = await getCurrentBookmarkAuth();
    if (auth.account !== account) {
      const error = new Error("account_changed");
      error.code = "account_changed";
      throw error;
    }
    return auth;
  };
  // Cancel markers carry runId, so a fresh run ignores an old marker while a
  // resumed run still honors the exact persisted intent on its first item.
  await _writeBatchProgress({ running: true, done: false, error: null, ...base() });
  let runService = "";

  try {
    await requireAccount();
    const loadedSettings = await loadSettings();
    const currentAuth = await requireAccount();
    runService = currentAuth.service;
    const s = pbpBookmarkDeliverySettings(loadedSettings, currentAuth);
    if (!currentAuth.token) {
      await clearJob();
      await clearCancel();
      await _writeBatchProgress({ running: false, done: true, error: "not_logged_in", ...base() });
      showNotification("batch-error", t("bgSaveFailed"), t("bgNotLoggedIn"), "error");
      return;
    }
    // Same grant check as quick save: without it no tab can land, so the run
    // stops before any extraction or AI request. Never requests a permission.
    if (pbpSelfHostedAuth(currentAuth) && !await pbpBookmarkHostGranted(currentAuth, "[batch]")) {
      throw Object.assign(new Error("permission"), { code: "permission", result: { status: "failed", reason: "permission" } });
    }

    // One read for the whole run: the owned counts anchor the tag prompts
    // (audit A14, popup parity) and the index is reused by every tab's
    // canonicalization and delivery.
    const tagVocab = await pbpLoadTagVocab(account);
    const tagContext = {service:currentAuth.service, separator:s.aiTagSeparator,
      bookmarkNames:[], index:tagVocab.index, respectCase:s.optRespectTagCase === true};
    const baseTags = s.optBatchTagEnabled && s.optBatchTag
      ? pbpCanonicalTagList(s.optBatchTag.split(/[,，]+/), tagContext)
      : [];
    const useAiTags = s.batchAiTags && hasAIKey(s);
    const useAiSummary = s.batchAiSummary && hasAIKey(s);
    const linkding = currentAuth.service === "linkding";
    // Batch extraction is always local Defuddle - cache under the matching
    // namespace, never the configured aiContentSource (audit A3, same as
    // saveFromBackground).
    const aiCacheSource = "local";

    const userTagsTop = tagVocab.counts ? pbpTagsByCount(tagVocab.counts) : [];

    for (let i = startIndex; i < tabs.length; i++) {
      const tab = tabs[i];

      // Cooperative cancel (roadmap #32): the popup writes this flag; one
      // storage read per item is noise next to the 3.1s rate-limit spacing.
      // Already-saved items stay saved — the terminal record says how many.
      try {
        const { batch_cancel_requested } = await chrome.storage.local.get("batch_cancel_requested");
        if (batch_cancel_requested?.runId === runId && batch_cancel_requested?.account === account) {
          await clearCancel();
          await clearJob();
          await _writeBatchProgress({ running: false, done: true, error: "cancelled", ...base() });
          // Neutral title: "finished" over a "cancelled" body contradicts itself
          // (same reasoning as the interrupted branch above).
          showNotification("batch-cancelled", t("bgBatchCancelled"), t("batchCancelled", String(saved)), "info");
          return;
        }
      } catch (e) {
        // A failed read must not kill the save loop, but MV3 platform failures
        // cannot disappear without a trace. No payload/account is logged.
        console.warn("[batch] cancel check failed:", e?.name, e?.message);
      }

      try {
        // Re-read per item: the lookup client rejects an auth from before a
        // same-account settings write (epoch bump), which is not an account change.
        const itemAuth = await requireAccount();
        const mode = s.batchSkipExisting ? "skip" : "merge";
        // The bookmark's address is the cleaned page address, as the popup and
        // toolbar icon use; page reads keep the tab's own address.
        const bookmarkUrl = pbpBookmarkLookupUrl(tab.url, s.urlClean);
        const title = tab.title || tab.url;
        const titleTooLong = !!pbpBookmarkTitleFailure(title, currentAuth.service);
        // Skip mode asks first (user decision 2026-11-02): a page already saved
        // is skipped without reading it or paying for AI, and so is one whose
        // check met a cause every request meets (it stops the run below). The
        // answer goes to delivery, so the server is asked once per page; a
        // check that got no answer is queued there like an outage. A page
        // whose title the service cannot store is asked first in merge mode
        // too: only a new bookmark is sent that title (a merge keeps the
        // server's), so only a page not saved yet is counted too long.
        let lookup;
        if (mode === "skip" || titleTooLong) lookup = { url: bookmarkUrl, account, found: await fetchExistingBookmark(bookmarkUrl, itemAuth.token, itemAuth) };
        const settled = !!lookup && ((mode === "skip" && lookup.found.exists) || (lookup.found.lookupFailed && !lookup.found.retryable));
        // Counted before any page read, AI request or write.
        if (titleTooLong && !lookup.found.exists && !lookup.found.lookupFailed) { tooLong++; continue; }
        let tags = [...baseTags];
        let notes = "";
        let linkdingSummary = "";
        let pageInfo = null;

        if (!settled && (useAiTags || useAiSummary || (linkding && s.optAutoDescription !== false))) {
          try { pageInfo = await getPageInfoFromTab(tab.id, {
            withDefuddle: !!(useAiTags || useAiSummary), expectedUrl: tab.url
          }); }
          catch (e) { console.warn("batch: cannot extract page content for", tab.url, e.message); }
        }
        if (!settled && (useAiTags || useAiSummary)) {
          await requireAccount();
          if (pageInfo?.pageText) {
            // Per-artifact resolution (audit A8, mirrors the quick-save
            // path): a half-empty combined reply keeps its good half and
            // sends ONLY the empty half to a dedicated single call - the
            // old boolean gate treated any parsed reply as fully handled,
            // silently dropping the missing artifact without counting it.
            let aiTagsResolved = null;
            let summaryResolved = null;
            if (useAiTags && useAiSummary && !s.customTagPrompt?.trim() && !s.customSummaryPrompt?.trim()) {
              try {
                const tCached = await getAICache(bookmarkUrl, "tags", s.aiCacheDuration, aiCacheSource, account, s);
                const sCached = await getAICache(bookmarkUrl, "summary", s.aiCacheDuration, aiCacheSource, account, s);
                // A16: reuse a cached half; combined call only when both missing.
                if (tCached) aiTagsResolved = tCached;
                if (sCached) summaryResolved = sCached;
                if (aiTagsResolved === null && summaryResolved === null) {
                  const resp = await callAI(s, buildCombinedPrompt(s, tab.title || tab.url, bookmarkUrl, pageInfo.pageText, "", pbpRelevantTagsFirst(userTagsTop, tab.title || "", bookmarkUrl)));
                  const parsed = parseAICombined(resp, s.aiTagSeparator);
                  if (parsed.tags.length) {
                    aiTagsResolved = parsed.tags;
                    await setAICache(bookmarkUrl, "tags", aiTagsResolved, s.aiCacheDuration, aiCacheSource, account, s);
                  }
                  if (parsed.summary) {
                    summaryResolved = parsed.summary;
                    await setAICache(bookmarkUrl, "summary", parsed.summary, s.aiCacheDuration, aiCacheSource, account, s);
                  }
                }
              } catch (e) { console.warn("batch AI combined failed, falling back:", bookmarkUrl, e.message); }
            }
            {
              const aiJobs = [];
              if (useAiTags && aiTagsResolved === null) aiJobs.push((async () => {
                try {
                  const cached = await getAICache(bookmarkUrl, "tags", s.aiCacheDuration, aiCacheSource, account, s);
                  if (cached) return { type: "tags", result: cached };
                  const prompt = buildTagPrompt(s, tab.title || tab.url, bookmarkUrl, pageInfo.pageText, "", pbpRelevantTagsFirst(userTagsTop, tab.title || "", bookmarkUrl));
                  const resp = await callAI(s, prompt);
                  const rawTags = refineTags(parseAITags(resp, s.aiTagSeparator), { cap: AI_TAG_CAP, separator: s.aiTagSeparator });
                  await setAICache(bookmarkUrl, "tags", rawTags, s.aiCacheDuration, aiCacheSource, account, s);
                  return { type: "tags", result: rawTags };
                } catch (e) { console.warn("batch AI tags failed:", bookmarkUrl, e.message); aiFailed++; return null; }
              })());
              if (useAiSummary && summaryResolved === null) aiJobs.push((async () => {
                try {
                  const cached = await getAICache(bookmarkUrl, "summary", s.aiCacheDuration, aiCacheSource, account, s);
                  if (cached) return { type: "summary", result: cached };
                  const prompt = buildSummaryPrompt(s, tab.title || tab.url, bookmarkUrl, pageInfo.pageText, "");
                  const summary = await callAI(s, prompt);
                  await setAICache(bookmarkUrl, "summary", summary, s.aiCacheDuration, aiCacheSource, account, s);
                  return { type: "summary", result: summary };
                } catch (e) { console.warn("batch AI summary failed:", bookmarkUrl, e.message); aiFailed++; return null; }
              })());
              if (aiTagsResolved) tags = [...tags, ...aiTagsResolved];
              if (summaryResolved) {
                if (linkding) linkdingSummary = summaryResolved;
                else notes = pbpFormatSummaryBlock(summaryResolved, currentAuth.service);
              }
              const results = await Promise.all(aiJobs);
              for (const r of results) {
                if (!r) continue;
                if (r.type === "tags") tags = [...tags, ...r.result];
                if (r.type === "summary") {
                  if (linkding) linkdingSummary = r.result;
                  else notes = pbpFormatSummaryBlock(r.result, currentAuth.service);
                }
              }
            }
          } else {
            // audit A12: extraction failed or came back empty (tab closed,
            // navigation, injection failure) - the bookmark still saves
            // bare, but the REQUESTED artifacts were not produced. Count
            // them per artifact (the same unit the single-job catches
            // use) so the batch summary's AI-failed figure stays truthful
            // instead of reporting 0.
            aiFailed += (useAiTags ? 1 : 0) + (useAiSummary ? 1 : 0);
          }
        }

        const dedupedTags = pbpCanonicalTagList(tags, tagContext);
        const isPrivate = pbpServiceEffectivePrivate(s, { incognito: tab.incognito });
        // Same rule as quick save: a tab Batch could not read (no site
        // access without AI), or a PDF, leaves the Description to linkding.
        const description = !linkding ? undefined
          : pbpBookmarkDescriptionLine(linkdingSummary)
            || (s.optAutoDescription === false ? ""
              : pbpPageInfoReadable(pageInfo) ? pbpBookmarkDescriptionLine(pbpNotesDescription(pageInfo)) : undefined);
        await requireAccount();
        // Batch notes hold the summary block and nothing else (null: no block).
        const summaryRange = !linkding && notes ? { start: 0, end: notes.length } : null;
        const result = await submitSaveIntent({
          mode,
          url: bookmarkUrl,
          title,
          notes,
          ...(description !== undefined ? { summary: description } : {}),
          tags: pbpSerializeIntentTags(dedupedTags, currentAuth.service),
          private: isPrivate,
          toread: s.optReadlaterDefault ? true : undefined,
          archive: s.waybackArchiveBatch ? undefined : false,
        }, { deferBadge: true, expectedAccount: account, summaryRange, tagVocab, lookup });
        if (result.reason === "account_changed") {
          const error = new Error("account_changed");
          error.code = "account_changed";
          throw error;
        }
        // A gateway, a rejected token or a missing host grant answers every
        // tab the same way: stop before the next tab's AI request.
        const stopCause = pbpBookmarkStopCause(result, currentAuth.service);
        if (stopCause) throw Object.assign(new Error(stopCause), { code: stopCause, result });
        if (result.status === "saved") saved++;
        else if (result.status === "queued") queued++;
        else if (result.status === "skipped") skipped++;
        else if (result.reason === "too_long") tooLong++;
        else if (result.reason === "partial") { partial++; if (pbpBookmarkPartialKey(result)) partialList = true; }
        else if (result.reason === "tag_too_long") {
          tagTooLong++; longTag ||= pbpBookmarkFailureArgs(result)[0];
          if (mode === "skip") longTagSkip = true;
        }
        else failed++;
      } catch (e) {
        if (e?.code === "account_changed" || e?.result) throw e;
        failed++;
      } finally {
        processed = i + 1;
        await _writeBatchProgress({ running: true, done: false, error: null, ...base() });
        // Idempotent checkpoint: cursor + counts land after every item, so an
        // interrupted worker resumes at the next unprocessed tab instead of
        // reporting the whole run dead (roadmap #34).
        try { await chrome.storage.local.set({ batch_job: jobRecord() }); }
        catch (e) { console.warn("[batch] checkpoint failed:", e?.name, e?.message); }
      }
    }

    if (saved > 0 || partial > 0) await updateBadge().catch(() => {});

    await clearJob();
    await clearCancel();
    await _writeBatchProgress({ running: false, done: true, error: null, ...base() });
    const tagsSuffix = baseTags.length ? t("batchTaggedSuffix", baseTags.join(", ")) : "";
    const skippedMsg = skipped > 0 ? t("batchSkipped", String(skipped)) : "";
    const tooLongMsg = tooLong > 0 ? t("batchTooLong", String(tooLong)) : "";
    const partialMsg = partial > 0 ? t("batchPartial", String(partial)) + (partialList ? " · " + t(PBP_BOOKMARK_FAILURE_KEYS.read_later_list) : "") : "";
    const queuedMsg = queued > 0 ? ` · ${t("offlineQueued", String(queued))}` : "";
    // A sentence of its own after the summary: which tag, the limit, what to do.
    const tagTooLongMsg = tagTooLong > 0
      // Skip mode gets its own sentence: those pages were created untagged, so
      // "run Batch Save again" alone would skip them; it names the way out.
      ? t(longTagSkip ? "batchTagTooLongSkip" : "batchTagTooLong", String(tagTooLong), ...pbpBookmarkFailureArgs({ reason: "tag_too_long", tag: longTag }))
      : "";
    if (saved > 0 || queued > 0 || failed > 0 || tooLong > 0 || tagTooLong > 0 || partial > 0) {
      const message = t("batchDone", String(saved), String(failed)) + skippedMsg + tooLongMsg + partialMsg + queuedMsg + tagsSuffix + tagTooLongMsg;
      // A partly saved page landed on the server too (its bookmark exists).
      if (saved > 0 || partial > 0 || queued > 0) {
        const title = saved > 0 || partial > 0 ? t("bgBatchSaved") : t("bgQueuedOffline");
        showNotification("batch-saved", title, message, "batchSave");
      } else {
        // Nothing landed at all (every tab failed on its own; a revoked token
        // stops the run in the catch below instead). Batch is built to outlive the popup,
        // and the popup only replays a terminal record for BATCH_STALE_TTL, so
        // without this the whole run vanishes without a word. Report it in the
        // error family the other terminal batch failures use — never as a
        // "Saved 0 bookmarks" success. An all-SKIPPED run stays silent: nothing
        // failed there, the bookmarks were already saved.
        showNotification("batch-error", t("bgSaveFailed"), message, "error");
      }
    }
  } catch (e) {
    // A thrown error is a REAL terminal state (account switch, unexpected
    // failure) — never resumable. Drop the job so the sweep cannot revive it.
    await clearJob();
    await clearCancel();
    await _writeBatchProgress({ running: false, done: true, error: e.message, ...base() });
    // A stopping save failure gets the same notification a quick save would.
    if (e?.result) notifySaveFailure("batch", e.result, runService);
    else if (e?.code !== "account_changed") showNotification("batch-error", t("bgSaveFailed"), e.message, "error");
  } finally {
    _batchRunning = false;
  }
}

// ===================== Tab Set 保存 =====================
async function handleSaveTabSet(tabsData) {
  if (pbpBookmarkServiceId(await loadSettings()) !== "pinboard") {
    // Tab Sets are a pinboard.in web feature; say so instead of dropping the shortcut silently.
    showNotification("tabset-error", t("bgTabSetFailed"), t("bgTabSetPinboardOnly"), "error");
    return;
  }
  try {
    // Tab Set uses pinboard.in web API (cookie auth, not API token)
    const result = { browser: "chrome", windows: [tabsData.map(t => ({ title: t.title, url: t.url }))] };
    const formData = new FormData();
    formData.append("data", JSON.stringify(result));
    // Deadline (same 20s tier as md-export-send): the caller is fire-and-forget
    // and the popup re-enables its button on a 2s timer, so these notifications
    // are the user's only feedback — a hung socket would silence both of them
    // and keep the worker alive until Chrome's own network timeout. AbortError
    // lands in the catch below as an ordinary tabset-error.
    const resp = await fetch("https://pinboard.in/tabs/save/", {
      method: "POST", body: formData, credentials: "include",
      signal: AbortSignal.timeout(20000),
    });
    if (resp.ok) {
      // /tabs/save/ only STAGES the tabs — Pinboard requires the user to click
      // "Save" on /tabs/show/ to actually bookmark them. So we open that page and
      // the notification says "one more step", not "saved" (keys kept for compat).
      chrome.tabs.create({ url: "https://pinboard.in/tabs/show/" });
      showNotification("tabset-saved", t("bgTabSetSaved"), t("bgTabsSavedCount", String(tabsData.length)), "tabSet");
    } else {
      const hint = resp.status === 401 || resp.status === 403
        ? t("bgLoginRequired") : `HTTP ${resp.status}`;
      showNotification("tabset-error", t("bgTabSetFailed"), hint, "error");
    }
  } catch (e) {
    showNotification("tabset-error", t("bgTabSetFailed"), e.message, "error");
  }
}

// ---- Storage change listener ----
chrome.storage.onChanged.addListener((changes) => {
  if (changes.optShowBadge || changes.bookmarkService || changes[PBP_BOOKMARK_ACTIVE_KEY]) {
    // The event can come from an inactive storage area. Resolve the effective
    // setting instead of trusting this area's candidate value. A service
    // change matters too: the poll exists only for Pinboard.
    updateBadge().catch(() => {});
    _syncBadgeAlarm(); // create/clear the 15-min network poll to match
  }
});

// ---- Markdown preview via keyboard shortcut (no popup) ----
// Self-contained extractor injected into the active tab's ISOLATED world.
// Mirrors popup.js extractLocalMarkdown's inner func: per-site rule first,
// then Defuddle. Returns HTML only — md-preview.html runs Turndown itself.
function extractPageForMarkdown() {
  // Embedded-frame candidate (2026-08-25): app shells such as claude.ai
  // artifacts keep the whole article in one large cross-origin iframe, so
  // the top document has nothing to extract. Report the frame's ORIGIN only
  // (no path, no query) so the reader can offer a one-click, user-gesture
  // grant for exactly that origin and re-run extraction in every frame.
  // Sandboxed frames without allow-same-origin have an opaque origin no
  // grant can name, so they are not candidates. The src is page-controlled,
  // so the candidate is only ever a SUGGESTION the user confirms in Chrome's
  // own prompt (Codex 2026-08-26): srcdoc frames (src is decorative there),
  // hidden frames and off-screen frames are excluded, and the 40% is measured
  // on the frame's VISIBLE intersection with the viewport; the grant is then
  // bound to the frame's real origin by the Service Worker, never to this src.
  function dominantFrameOrigin() {
    try {
      const vw = Math.max(1, window.innerWidth), vh = Math.max(1, window.innerHeight);
      let best = null, bestArea = 0;
      for (const f of document.querySelectorAll("iframe")) {
        if (f.hasAttribute("srcdoc")) continue;
        let origin;
        try { origin = new URL(f.src, location.href).origin; } catch (_) { continue; }
        if (!/^https:\/\//.test(origin) || origin === location.origin) continue;
        const sb = f.getAttribute("sandbox");
        if (sb !== null && !/\ballow-same-origin\b/.test(sb)) continue;
        // Hidden by itself OR by any ancestor: opacity does not inherit, so a
        // frame under an opacity:0 wrapper still reports opacity 1 on its own
        // computed style (Codex 2026-08-26).
        let hidden = false;
        for (let n = f; n && !hidden; n = n.parentElement) {
          const cs = getComputedStyle(n);
          hidden = cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
        }
        if (hidden) continue;
        const r = f.getBoundingClientRect();
        const w = Math.min(r.right, vw) - Math.max(r.left, 0);
        const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
        const area = Math.max(0, w) * Math.max(0, h);
        if (area > bestArea) { bestArea = area; best = origin; }
      }
      return best && bestArea >= 0.4 * vw * vh ? best : "";
    } catch (_) { return ""; }
  }
  // "Nothing here" is judged on TEXT, not on the HTML string: Defuddle hands
  // back the main container even when all it holds is an <iframe> (claude.ai
  // artifact pages, device 2026-08-26), and a truthy-string gate let that empty
  // shell pass as an article, so the frame offer below never appeared.
  // Media-only articles (a comic, a gallery) stay content.
  function extractionLooksEmpty(html) {
    const s = String(html || "");
    if (/<(img|picture|video|audio|svg|canvas|object|embed|math)\b/i.test(s)) return false;
    return !/\S/.test(s.replace(/<[^>]*>/g, " ").replace(/&(nbsp|#160|#xa0);/gi, " "));
  }
  try {
    if (typeof applySiteRule === "function") {
      const hit = applySiteRule(document, location.href);
      if (hit && hit.error) return { error: hit.error };
      if (hit && hit.contentHtml) {
        // E1: normalize lazy-load img placeholders (data-src/srcset) on an
        // INERT-document div -- a div from the LIVE document fetches every
        // <img> it holds even while detached, and fixLazyImages promotes
        // data-src onto src first. Mirrors site-rules.js's inertDoc(), which
        // this serialized page function cannot reach (closure-free by
        // contract). pbpNormalizeLazyImages comes from site-rules.js, already
        // injected by extractForPreview before this function runs
        // (chrome.scripting.executeScript calls).
        const div = document.implementation.createHTMLDocument("").createElement("div");
        div.innerHTML = hit.contentHtml;
        if (typeof pbpNormalizeLazyImages === "function") pbpNormalizeLazyImages(div, location.href);
        if (typeof pbpUpgradeSrcsetImages === "function") pbpUpgradeSrcsetImages(div, location.href);
        return { contentHtml: div.innerHTML, title: hit.title || document.title, url: location.href, math: !!hit.math, forum: !!hit.forum };
      }
    }
  } catch (_) { /* fall through to Defuddle */ }
  if (typeof Defuddle === "undefined") return { error: "Defuddle not available" };
  const OriginalURL = window.URL;
  if (!window.__pp_urlShimInstalled) {
    const SafeURL = function (u, b) {
      try { return b !== undefined ? new OriginalURL(u, b) : new OriginalURL(u); }
      catch (_) { return new OriginalURL("about:blank"); }
    };
    SafeURL.prototype = OriginalURL.prototype;
    try { SafeURL.createObjectURL = OriginalURL.createObjectURL.bind(OriginalURL); } catch (_) {}
    try { SafeURL.revokeObjectURL = OriginalURL.revokeObjectURL.bind(OriginalURL); } catch (_) {}
    try { SafeURL.canParse = OriginalURL.canParse && OriginalURL.canParse.bind(OriginalURL); } catch (_) {}
    window.URL = SafeURL;
    window.__pp_urlShimInstalled = true;
  }
  try {
    const clone = document.cloneNode(true);
    // E1: normalize lazy-load img placeholders on the CLONE before Defuddle
    // parses it -- the live DOM is never touched.
    if (typeof pbpNormalizeLazyImages === "function") pbpNormalizeLazyImages(clone, location.href);
    if (typeof pbpUpgradeSrcsetImages === "function") pbpUpgradeSrcsetImages(clone, location.href);
    if (typeof pbpPreDefuddleNormalize === "function") pbpPreDefuddleNormalize(clone);
    const _origCE = console.error;
    console.error = (...a) => { if (!/^Defuddle(?::|$)/.test(String(a[0]))) _origCE.apply(console, a); };
    let result;
    try { result = new Defuddle(clone).parse(); } finally { console.error = _origCE; }
    if (!result?.content || extractionLooksEmpty(result.content)) return { error: "No content extracted", frameOrigin: dominantFrameOrigin() };
    // X4: mirrors popup.js's extractLocalMarkdown -- keep Defuddle's
    // author/published/site/image alongside content/title/url/math.
    return {
      contentHtml: result.content, title: result.title || document.title, url: location.href,
      math: !!document.querySelector("math") || (typeof pbpContentHasMath === "function" && pbpContentHasMath(result.content)),
      author: result.author || "", published: result.published || "", site: result.site || "", image: result.image || "",
      // Source page language for the reader's article lang (see popup.js twin).
      lang: result.language || document.documentElement.lang || ""
    };
  } catch (e) { return { error: e.message }; }
}

// Unified extraction service for the preview. Shared by the keyboard-shortcut
// opener and the in-preview engine toggle (reextractMarkdown). Returns the
// md_preview_data payload fields (minus tags/description/tabId, added by caller)
// or { error }. engine is "local" (Defuddle) or "jina".
// Reload the reader's source tab and wait for it to load again (the
// reextractMarkdown reloadSource path). true once the tab reports "complete"
// after passing through "loading"; false if the reload fails or the tab goes
// away. A page that never settles (long-polling, ad slots) still resolves true
// after the timeout: its DOM is there, and extractForPreview re-checks the
// tab's URL before injecting either way. The listeners are added and removed
// per call -- this is a wait inside one message, not an SW wake-up event.
function pbpReloadTabAndSettle(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let sawLoading = false;
    let done = false;
    let timer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(ok);
    };
    const onUpdated = (id, info) => {
      if (id !== tabId || !info) return;
      if (info.status === "loading") sawLoading = true;
      else if (info.status === "complete" && sawLoading) finish(true);
    };
    const onRemoved = (id) => { if (id === tabId) finish(false); };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    timer = setTimeout(() => finish(true), timeoutMs);
    try {
      chrome.tabs.reload(tabId, {}, () => {
        if (chrome.runtime.lastError) {
          console.warn("[pbp-preview] source reload failed:", chrome.runtime.lastError.message);
          finish(false);
        }
      });
    } catch (e) {
      console.warn("[pbp-preview] source reload threw:", e && e.name, e && e.message);
      finish(false);
    }
  });
}

async function extractForPreview({ tabId, url, engine, sourceTabUrl, frame, frameOrigin }) {
  if (engine === "jina") {
    // Fresh read — do NOT use loadSettings() (its _settingsCache can be stale
    // when the user edits settings while the SW is warm). getSettingsStorage()
    // returns RAW (obfuscated) settings, so deobfuscate the key exactly once.
    const raw = await pbpReadSettingsWithSecrets({
      jinaApiKey: SETTINGS_DEFAULTS.jinaApiKey,
      aiCacheDuration: SETTINGS_DEFAULTS.aiCacheDuration
    });
    const key = raw.jinaApiKey ? deobfuscateKey(raw.jinaApiKey) : "";
    const r = await fetchJinaMarkdown(url, { apiKey: key, cacheDuration: raw.aiCacheDuration });
    // Reasons the reader can name (md-preview.js pbpEngineErrText): Jina's
    // quota, a key it rejected, and its 30s deadline. A 401/403 only means
    // "your key" when one was sent; without a key it stays the generic line.
    if (r.error) {
      const code = r.error === "host_permission" ? "host_permission"
        : r.status === 429 ? "rate_limited"
        : (r.authFailed && key) ? "jina_auth"
        : r.timeout === true ? "timeout"
        : r.error;
      return { error: code };
    }
    if (!r.markdown || !r.markdown.trim()) return { error: "empty" };
    return {
      source: "jina", markdown: r.markdown, contentHtml: "",
      title: r.title || "", url: r.url || url,
      tokens: r.tokens || 0, hasApiKey: !!key, math: false,
      // X4: published is jina.js's best-effort field; author/site/image have no
      // Jina counterpart. site's hostname fallback happens at meta-build time in
      // buildMeta() (design spec 4.2), not here -- this layer only transports
      // what the engine actually gave us.
      published: r.published || ""
    };
  }
  // engine === "local" (Defuddle)
  if (!tabId) return { error: "tab_unavailable" };
  // Weak-handle guard: the stored tabId may now host a DIFFERENT page (user
  // navigated, or the id was reused). activeTab can persist across same-origin
  // navigation, so a successful inject could silently extract the wrong page.
  // Compared against sourceTabUrl when present (hotlink round): `url` can be
  // Jina's canonicalized d.url, which never equals the tab's literal URL --
  // without the split, one Jina pass bricked the switch back to the local
  // engine with a spurious tab_navigated (Codex review).
  // _cbTabsGet (ai.js, loaded via importScripts): callback form consumes
  // lastError inside the callback — the promise form leaks "Unchecked
  // runtime.lastError: No tab with id" when the tab closes mid-call, which is
  // exactly this path's high-frequency scenario (user closes the source tab
  // while switching engines / authorizing a frame).
  const live = await _cbTabsGet(tabId);
  if (!live) return { error: "tab_unavailable" };
  if (!live.url || live.url !== (sourceTabUrl || url)) return { error: "tab_navigated" };
  // Defuddle is required; injection failure (tab closed / CSP / no permission) → degrade.
  // `frame` (2026-08-25): the reader asked for the embedded-frame pass after the
  // user granted that frame's exact origin -- inject into every frame Chrome
  // lets us reach (frames without a host grant are silently skipped by the
  // platform) and take the first frame that yields an article, preferring
  // the candidate origin the top document reported. Never automatic: the top
  // frame alone is the default, and the grant itself only ever comes from the
  // reader's button (permissions.request needs that user gesture anyway).
  let target = { tabId };
  if (frame === true) {
    // Locate the frames that really ARE the granted origin first (a cheap
    // probe returns each reachable frame's own origin; frames we hold no
    // grant for are skipped by Chrome), then inject only into those. The
    // page-reported src decides nothing past the prompt (Codex 2026-08-26):
    // no matching frame, or no article in it, is "nothing here" -- never a
    // fallback to some other frame.
    if (!frameOrigin) return { error: "empty" };
    const probe = await _cbExecuteScript({ target: { tabId, allFrames: true }, func: () => location.origin });
    const frameIds = (Array.isArray(probe) ? probe : [])
      .filter((r) => r && r.frameId !== 0 && r.result === frameOrigin).map((r) => r.frameId);
    if (!frameIds.length) return { error: "empty" };
    target = { tabId, frameIds };
  }
  const injected = await _cbExecuteScript({ target, files: ["vendor/defuddle.js"] });
  if (!injected) return { error: "tab_unavailable" };
  // site-rules.js is OPTIONAL — ignore failure so a broken rule can't mask Defuddle.
  await _cbExecuteScript({ target, files: ["site-rules.js"] });
  const results = await _cbExecuteScript({ target, func: extractPageForMarkdown });
  const top = results && results[0] && results[0].result;
  let out = top;
  let frameBase = "";
  if (frame === true && Array.isArray(results)) {
    const sameOrigin = (u) => { try { return new URL(u).origin === frameOrigin; } catch (_) { return false; } };
    const pick = results.find((r) => r && r.result && r.result.contentHtml && sameOrigin(r.result.url));
    out = pick ? pick.result : null;
    if (pick) frameBase = pick.result.url; // relative links resolve against the FRAME, not the top page
  }
  if (!out || out.error || !out.contentHtml) {
    // Defuddle's own "nothing here" string is the same product state as a
    // missing result: report it as `empty` so the reader shows the no-content
    // copy (and the frame offer) instead of the generic failure text.
    const raw = out && out.error;
    const err = { error: (raw && raw !== "No content extracted") ? raw : "empty" };
    // Surface the candidate only on a plain "nothing here" -- a real error keeps its own text.
    if (top && typeof top.frameOrigin === "string" && top.frameOrigin && frame !== true) err.frameOrigin = top.frameOrigin;
    return err;
  }
  return {
    source: "local", markdown: "", contentHtml: out.contentHtml,
    title: out.title || "", url: url, // prefer caller url over extractor's
    baseUrl: frameBase || url,        // frame pass: the frame's own URL for relative links
    tokens: 0, hasApiKey: false, math: !!out.math, forum: !!out.forum,
    // X4: forward the four metadata fields extractPageForMarkdown's Defuddle
    // branch now keeps. The reextractMarkdown handler's `...out` spread
    // (background.js ~943-953) forwards these automatically into storage --
    // no separate edit needed there.
    author: out.author || "", published: out.published || "", site: out.site || "", image: out.image || "",
    lang: out.lang || ""
  };
}

async function openMarkdownPreviewFromShortcut() {
  pbpSweepPreviewOrphans(); // best-effort: clear closed-preview residue before adding one
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) { console.warn("[mdpv] active tab query failed:", e?.name, e?.message); /* fall through to the guard below */ }
  if (!tab?.id || !tab.url || !/^https?:\/\//.test(tab.url)) {
    // chrome://, file:// and friends are unsupported, not empty: say so
    // instead of sending the user to look for missing page content.
    const why = tab?.id && tab.url ? "bgMdPreviewUnsupported" : "bgMdPreviewNoContent";
    showNotification("mdpv-error", t("bgMdPreviewFailed"), t(why), "error");
    return;
  }
  // Open the preview INSTANTLY with a pending placeholder so the shortcut feels
  // responsive; the preview page drives extraction via reextractMarkdown (the same
  // path as the in-preview toggle). Follow the aiContentSource setting (fresh read).
  const [raw, auth] = await Promise.all([
    (await getSettingsStorage()).get({ aiContentSource: SETTINGS_DEFAULTS.aiContentSource, urlClean: SETTINGS_DEFAULTS.urlClean }),
    getCurrentBookmarkAuth().catch(() => ({ account: "" })),
  ]);
  const engine = raw.aiContentSource === "jina" ? "jina" : "local";
  // Per-open token key so two shortcut opens (or a shortcut + a popup Preview)
  // never share one storage slot and clobber each other before their tabs read.
  const k = crypto.randomUUID();
  try {
    await chrome.storage.local.set({
      ["md_preview_data_" + k]: {
        pending: true, engine, source: engine,
        tabId: tab.id, url: tab.url, baseUrl: tab.url, sourceTabUrl: tab.url, title: tab.title || "",
        // The address the toolbar icon asks about for this tab (K0): the
        // reader's bookmark bar looks up and saves under it, not under url.
        bookmarkUrl: pbpBookmarkLookupUrl(tab.url, raw.urlClean),
        sourceIncognito: tab.incognito === true,
        account: auth.account || "", tags: [], description: "", ts: Date.now() // sweep grace (see pbpSweepPreviewOrphans)
      }
    });
    // video=1 (non-sensitive) lets md-preview-theme-early.js resolve the
    // "open video pages in dark" default before first paint; the page itself
    // still decides video-mode from the payload (theme model 2026-08-25).
    const videoQ = (typeof pbpVideoDetect === "function" && pbpVideoDetect(tab.url)) ? "&video=1" : "";
    await chrome.tabs.create({ url: "md-preview.html?k=" + k + videoQ });
  } catch (e) {
    // storage.local.set can reject on quota; tabs.create can reject too. Surface
    // it instead of silently opening nothing (aligns with the read_later/quick_save
    // failure notifications in the onCommand listener below).
    const quota = /quota/i.test((e && e.message) || "");
    showNotification(
      "mdpv-error",
      t("bgMdPreviewFailed"),
      quota ? t("bgMdPreviewTooLarge") : ((e && e.message) || t("bgMdPreviewNoContent")),
      "error"
    );
  }
}

// Follow a language change: a running worker keeps the strings it loaded at
// start, so the settings page's language switch (optLang, or optSyncEnabled,
// which moves optLang between storage areas) has to reload them. i18n.js
// re-fetches on a repeat call; pbpI18nReady() follows the latest refresh.
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" || area === "local") && (changes.optLang || changes.optSyncEnabled)) {
    try {
      Promise.resolve(initI18n()).catch((e) => console.warn("[i18n] refresh failed:", e?.name, e?.message));
    } catch (e) { console.warn("[i18n] refresh failed:", e?.name, e?.message); }
  }
});

// ===================== Keyboard Shortcuts =====================
chrome.commands.onCommand.addListener(async (command) => {
  // Every branch below builds notification copy with t() after at most a
  // tabs.query, which on a cold worker can beat the manual-language refresh
  // started at module top. Wait for it once here. No branch needs the shortcut's
  // user gesture afterwards: none calls sidePanel.open, action.openPopup or
  // permissions.request (the reader route only answers; the grant button is
  // the reader's own).
  await pbpI18nReady();
  if (command === "markdown_preview") {
    await openMarkdownPreviewFromShortcut();
    return;
  }
  if (command === "save_tabset") {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const tabsData = tabs
        .filter(t => t.url && /^https?:/i.test(t.url))
        .map(t => ({ title: t.title || t.url, url: t.url }));
      if (!tabsData.length) {
        showNotification("tabset-error", t("bgTabSetFailed"), t("batchNoValidTabs"), "error");
        return;
      }
      await handleSaveTabSet(tabsData);
    } catch (e) {
      showNotification("tabset-error", t("bgTabSetFailed"), e.message, "error");
    }
    return;
  }
  const commandConfig = {
    read_later: { prefix: "rl", toread: true, notifyId: "rl", notifyTitle: () => t("bgReadLater"), notifyCategory: "readLater", errorTitle: () => t("bgReadLaterFailed") },
    quick_save: { prefix: "qs", toread: false, notifyId: "qs", notifyTitle: () => t("bgQuickSaved"), notifyCategory: "quickSave", errorTitle: () => t("bgQuickSaveFailed") },
  };
  const cfg = commandConfig[command];
  if (!cfg) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (await pbpRouteReaderSaveCommand(command, tab)) return;
    if (!tab?.url || !tab.url.startsWith("http")) {
      showNotification(`${cfg.notifyId}-error`, t("bgCannotSave"), t("bgCannotBookmark"), "error");
      return;
    }
    const s = await loadSettings();
    const overrides = resolvePrefixSettings(s, cfg.prefix);
    await saveFromBackground({
      // url is the bookmark's address (cleaned like the popup does); pageUrl
      // stays the tab's own address for page reads.
      url: pbpBookmarkLookupUrl(tab.url, s.urlClean), pageUrl: tab.url,
      title: tab.title || tab.url, tab,
      settingsOverrides: overrides,
      toread: cfg.toread,
      notifyId: cfg.notifyId,
      notifyTitle: cfg.notifyTitle(),
      notifyCategory: cfg.notifyCategory
    });
  } catch (e) {
    showNotification(`${cfg.notifyId}-error`, cfg.errorTitle(), e.message, "error");
  }
});
