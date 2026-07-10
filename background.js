// ============================================================
// Pinboard Bookmark Enhanced - Background Service Worker (v4.0)
// ============================================================

importScripts("i18n.js", "shared.js", "ai-cache.js", "ai.js", "jina.js", "wayback.js", "webdav.js");

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

// setIcon with a path: map makes Chrome RE-FETCH all 4 PNGs from disk on every
// call. Combined with tabs.onUpdated re-firing "complete" repeatedly (and the
// keepalive keeping the SW warm to service each one), this produced a sustained
// stream of pin-default-*.png requests that dragged page loads (the options page
// showed DOMContentLoaded ~2.4s). Decode each icon to ImageData ONCE at startup so
// setIcon never touches the network; setIcon falls back to path: until ready.
const _iconImageData = { default: null, bookmarked: null };
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
(async () => {
  try {
    const [def, bm] = await Promise.all([_decodeIconSet(ICONS_DEFAULT), _decodeIconSet(ICONS_BOOKMARKED)]);
    _iconImageData.default = def;
    _iconImageData.bookmarked = bm;
  } catch (_) { /* decode failed — setIcon keeps using the path: fallback */ }
})();

// URL 状态缓存
const statusCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

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
const _pendingChecks = new Map(); // url -> Promise

async function debouncedCheck(url) {
  if (!url || !url.startsWith("http")) {
    return;
  }
  // Check if bookmark status icon is enabled
  try {
    const { optCheckBookmarkStatus } = await (await getSettingsStorage()).get({ optCheckBookmarkStatus: true });
    if (!optCheckBookmarkStatus) return;
  } catch (e) {
    // Storage unavailable — fall through to default behavior (check enabled)
    console.warn("[bookmark-status] settings read failed:", e?.message || e);
  }
  // Dedup: if same URL is already being checked, reuse promise
  if (_pendingChecks.has(url)) {
    return _pendingChecks.get(url);
  }
  const promise = checkBookmarked(url);
  _pendingChecks.set(url, promise);
  try {
    return await promise;
  } finally {
    _pendingChecks.delete(url);
  }
}

// ---- Load settings with deobfuscation (module-level cache, invalidated on storage.onChanged) ----
let _settingsCache = null;
async function loadSettings() {
  if (_settingsCache) return _settingsCache;
  let s = await (await getSettingsStorage()).get(SETTINGS_DEFAULTS);
  s = await pbpApplySecretOverlay(s); // MUST run before deobfuscateSettings (see shared.js note)
  deobfuscateSettings(s);
  _settingsCache = s;
  return s;
}
function invalidateSettingsCache() { _settingsCache = null; }

// F7: Track recent saves for undo via notification button
const _recentSaves = new Map(); // notificationId -> { url, token }

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
  const opts = { type: "basic", iconUrl: "icons/pin-default-48.png", title, message };
  if (undoInfo) {
    opts.buttons = [{ title: t("bgUndo") }];
    _recentSaves.set(notifId, undoInfo);
    // Auto-expire undo after 30s
    setTimeout(() => _recentSaves.delete(notifId), 30000);
  }
  chrome.notifications.create(notifId, opts);
}

// F7: Handle undo button click on notifications
chrome.notifications.onButtonClicked.addListener(async (notifId, btnIndex) => {
  if (btnIndex !== 0) return;
  const info = _recentSaves.get(notifId);
  if (!info) return;
  _recentSaves.delete(notifId);
  try {
    const resp = await pinboardFetch(`https://api.pinboard.in/v1/posts/delete?auth_token=${info.token}&url=${encodeURIComponent(info.url)}&format=json`);
    const data = await resp.json();
    if (data.result_code === "done") {
      statusCache.set(info.url, { bookmarked: false, timestamp: Date.now() });
      showNotification("undo-done", t("bgUndone"), t("bgBookmarkRemoved"));
    }
  } catch (e) {
    // Undo path failure — user expects feedback, log so it's debuggable
    console.warn("[undo] bookmark removal failed:", e?.message || e);
  }
});

// ---- 设置图标 ----
// Use callback form (not promise) so chrome.runtime.lastError is consumed
// inside the callback — the only Chromium-guaranteed way to mark it handled.
// Reading lastError after `await` (promise form) is too late: the unchecked
// check fires in the same microtask the promise settles, before user code runs.
// Symptoms otherwise: "Unchecked runtime.lastError: No tab with id: X"
// with Context: Unknown and Stack: :0 (anonymous function).
const _lastIconState = new Map(); // tabId -> last bookmarked bool set (dedup)
function setIcon(tabId, bookmarked) {
  if (typeof tabId !== "number" || tabId < 0) return;
  // Dedup: skip if this tab's icon is already in the desired state. A tab that
  // re-fires onUpdated "complete" repeatedly would otherwise re-set the same icon
  // over and over — this guard eliminates that storm regardless of trigger frequency.
  if (_lastIconState.get(tabId) === bookmarked) return;
  _lastIconState.set(tabId, bookmarked);
  try {
    const cached = bookmarked ? _iconImageData.bookmarked : _iconImageData.default;
    const details = cached
      ? { tabId, imageData: cached }                                   // in-memory, zero network
      : { tabId, path: bookmarked ? ICONS_BOOKMARKED : ICONS_DEFAULT }; // fallback until decoded
    chrome.action.setIcon(details, () => { void chrome.runtime.lastError; /* consume to mark handled */ });
  } catch (_) { /* synchronous throw on invalid args — ignore */ }
}

// ---- 检查 URL 是否已收藏 (uses cached token, direct fetch for latency) ----
async function checkBookmarked(url) {
  const cached = statusCache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.bookmarked;
  try {
    const token = await getCachedToken();
    if (!token) return false;
    const resp = await pinboardFetch(`https://api.pinboard.in/v1/posts/get?auth_token=${token}&format=json&url=${encodeURIComponent(url)}`);
    if (!resp.ok) return false;
    const data = await resp.json();
    const posts = data.posts || [];
    const bookmarked = posts.length > 0;
    statusCache.set(url, { bookmarked, timestamp: Date.now(), posts });
    cleanupStatusCache();
    return bookmarked;
  } catch (e) {
    // "Failed to fetch" is expected on network loss or API downtime — only warn for unexpected errors
    if (!(e instanceof TypeError && /failed to fetch/i.test(e.message))) console.warn("checkBookmarked error:", e);
    return false;
  }
}

// ---- Badge: unread count ----
async function updateBadge() {
  const s = await loadSettings();
  if (!s.optShowBadge || !s.pinboardToken) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  try {
    const resp = await pinboardFetch(`https://api.pinboard.in/v1/posts/all?auth_token=${s.pinboardToken}&format=json&toread=yes&results=100&meta=no`);
    const data = await resp.json();
    const count = Array.isArray(data) ? data.length : 0;
    chrome.action.setBadgeText({ text: count > 0 ? String(count > 99 ? "99+" : count) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#4477bb" });
  } catch (_) {
    // chrome.action API failure is non-fatal — badge is informational only
  }
}

// ---- Unified save pipeline + offline queue ----

const PBP_SAVE_MODES = new Set(["create", "update", "merge", "skip", "overwrite"]);
const PBP_POPUP_SAVE_MODES = new Set(["create", "update", "merge"]);

function pbpSaveFailure(reason, { detail, httpStatus } = {}) {
  const result = { status: "failed", reason };
  if (detail) {
    result.detail = String(detail)
      .replace(/auth_token=[^&\s]+/gi, "auth_token=[redacted]")
      .slice(0, 160);
  }
  if (Number.isInteger(httpStatus)) result.httpStatus = httpStatus;
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
  if (intent.toread !== undefined && typeof intent.toread !== "boolean") return pbpSaveFailure("invalid");
  if (intent.archive !== undefined && typeof intent.archive !== "boolean") return pbpSaveFailure("invalid");
  if (intent.time !== undefined && (typeof intent.time !== "string" || !intent.time)) return pbpSaveFailure("invalid");
  if (intent.mode === "update" && !intent.time) return pbpSaveFailure("invalid");
  if (intent.mode === "create" && intent.time !== undefined) return pbpSaveFailure("invalid");
  return null;
}

// Delivery-time merge/skip decisions always use a fresh read. statusCache remains
// a presentation cache and is refreshed only after a successful lookup.
async function fetchExistingBookmark(url, token) {
  try {
    const resp = await pinboardFetch(`https://api.pinboard.in/v1/posts/get?auth_token=${token}&format=json&url=${encodeURIComponent(url)}`);
    if (!resp.ok) {
      const httpStatus = Number.isInteger(resp.status) ? resp.status : undefined;
      const reason = httpStatus === 401 || httpStatus === 403 ? "not_logged_in" : "http";
      return {
        exists: false,
        lookupFailed: true,
        reason,
        httpStatus,
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
    statusCache.set(url, { bookmarked: exists, timestamp: Date.now(), posts });
    cleanupStatusCache();
    return {
      exists,
      lookupFailed: false,
      post,
    };
  } catch (_) {
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
  } catch (_) {
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
      result: pbpSaveFailure("http", { httpStatus }),
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
  return {
    result: pbpSaveFailure("api", { detail: code || "invalid_response", httpStatus }),
    persisted: null,
    retryable: false,
  };
}

async function deliverSaveIntent(intent, settings) {
  const invalid = validateSaveIntent(intent);
  if (invalid) return { result: invalid, persisted: null, retryable: false };
  if (!settings?.pinboardToken) {
    return { result: pbpSaveFailure("not_logged_in"), persisted: null, retryable: false };
  }

  let recoveredConflict = false;
  while (true) {
    let lookup = null;
    if (intent.mode === "merge" || intent.mode === "skip") {
      lookup = await fetchExistingBookmark(intent.url, settings.pinboardToken);
    }
    const plan = pbpResolveSavePlan(intent, lookup);
    if (plan.action === "failed") {
      return { result: plan.result, persisted: null, retryable: !!plan.retryable || !!lookup?.retryable };
    }
    if (plan.action === "skip") {
      return { result: { status: "skipped" }, persisted: plan.fields, retryable: false };
    }

    const delivered = await pbpSendResolvedPlan(plan, settings);
    if (delivered.result.reason !== "conflict"
        || recoveredConflict
        || (intent.mode !== "merge" && intent.mode !== "skip")) return delivered;
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
    if (offlineQueue.some((item) => item && typeof item === "object" && !item.queueId)) {
      const next = pbpOfflineQueueReduce(offlineQueue, { kind: "ensure_ids", prefix: newOfflineQueueId() });
      await chrome.storage.local.set({ offlineQueue: next });
      ({ offlineQueue = [] } = await chrome.storage.local.get("offlineQueue"));
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

async function applySaveResultSideEffects(envelope, settings, { deferBadge = false } = {}) {
  const { result, persisted } = envelope || {};
  if (!persisted || (result?.status !== "saved" && result?.status !== "skipped")) return;

  try {
    const cachedPosts = result.status === "skipped" ? statusCache.get(persisted.url)?.posts : undefined;
    statusCache.set(persisted.url, {
      bookmarked: true,
      timestamp: Date.now(),
      ...(cachedPosts ? { posts: cachedPosts } : {}),
    });
    cleanupStatusCache();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && pbpSameBookmark(tab.url, persisted.url)) setIcon(tab.id, true);
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

function queueRecordFromSaveIntent(intent) {
  return {
    mode: intent.mode === "create" ? "merge" : intent.mode,
    url: intent.url,
    title: intent.title,
    notes: intent.notes,
    tags: intent.tags,
    private: intent.private,
    toread: intent.toread,
    archive: intent.archive,
    time: intent.time,
  };
}

function submitSaveIntent(intent, { deferBadge = false } = {}) {
  return runSaveDeliveryTransaction(async () => {
    let settings;
    try { settings = await loadSettings(); }
    catch (_) { return pbpSaveFailure("internal"); }

    let envelope;
    try { envelope = await deliverSaveIntent(intent, settings); }
    catch (_) { return pbpSaveFailure("internal"); }

    if (envelope.result.status === "saved" || envelope.result.status === "skipped") {
      await applySaveResultSideEffects(envelope, settings, { deferBadge });
      return envelope.result;
    }
    if (!envelope.retryable || !settings.offlineQueueEnabled) return envelope.result;

    try {
      const queueId = await enqueueOfflineSave(queueRecordFromSaveIntent(intent));
      return { status: "queued", queueId };
    } catch (_) {
      return pbpSaveFailure("storage");
    }
  });
}

function sendOfflineItem(item) {
  return runSaveDeliveryTransaction(async () => {
    let settings;
    try { settings = await loadSettings(); }
    catch (_) {
      return { result: pbpSaveFailure("internal"), persisted: null, retryable: false, settings: {} };
    }
    const token = pbpResolveOfflineQueueToken(settings.pinboardToken, item?.token);
    const deliverySettings = token === settings.pinboardToken ? settings : { ...settings, pinboardToken: token };
    const intent = normalizeOfflineSaveIntent(item, settings);
    let envelope;
    try { envelope = await deliverSaveIntent(intent, deliverySettings); }
    catch (_) { envelope = { result: pbpSaveFailure("internal"), persisted: null, retryable: false }; }
    return { ...envelope, settings: deliverySettings };
  });
}

function drainOfflineQueueIds(queueIds) {
  return pbpDrainOfflineQueue(queueIds, {
    getItem: (queueId) => runOfflineQueueWrite(async () => {
      const { offlineQueue = [] } = await chrome.storage.local.get("offlineQueue");
      return Array.isArray(offlineQueue)
        ? offlineQueue.find((item) => item?.queueId === queueId) || null
        : null;
    }),
    sendItem: (item) => sendOfflineItem(item),
    removeItem: (queueId) => mutateOfflineQueue({ kind: "remove", queueId }),
    onSuccess: (_item, delivered) => applySaveResultSideEffects(delivered, delivered.settings),
  });
}

const runOfflineQueueConsumer = pbpCreateRecoveringTail();
let _offlineQueueDrain = null;
function processOfflineQueue() {
  if (_offlineQueueDrain) return _offlineQueueDrain;
  const operation = runOfflineQueueConsumer(async () => {
    const snapshot = await readOfflineQueueWithIds();
    if (!snapshot.length) return;
    await drainOfflineQueueIds(snapshot.map((item) => item?.queueId).filter(Boolean));
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
      const outcomes = await drainOfflineQueueIds([queueId]);
      const outcome = outcomes[0];
      return outcome
        ? { ok: outcome.acknowledged, result: outcome.result }
        : { ok: false, result: pbpSaveFailure("invalid") };
    } catch (_) {
      return { ok: false, result: pbpSaveFailure("storage") };
    }
  });
}

function submitPopupSaveIntent(intent) {
  if (!intent || !PBP_POPUP_SAVE_MODES.has(intent.mode)) {
    return Promise.resolve(pbpSaveFailure("invalid"));
  }
  if (intent.mode === "update" && !intent.time) {
    return Promise.resolve(pbpSaveFailure("invalid"));
  }
  if (intent.mode === "create" && intent.time !== undefined) {
    return Promise.resolve(pbpSaveFailure("invalid"));
  }
  return submitSaveIntent(intent);
}

// ---- P1: Shared save function ----
async function saveFromBackground({ url, title, tab, settingsOverrides, toread, notifyId, notifyTitle, notifyCategory }) {
  const loadedSettings = await loadSettings();
  const s = { ...loadedSettings, ...(settingsOverrides || {}) };
  const mode = s.bgSaveMode === "skip" || s.bgSaveMode === "overwrite" ? s.bgSaveMode : "merge";
  const isPrivate = pbpEffectivePrivate(s, { incognito: tab?.incognito });

  if (!s.pinboardToken) {
    showNotification(notifyId + "-error", t("bgNotLoggedIn"), t("bgSetToken"), "error");
    return pbpSaveFailure("not_logged_in");
  }

  // Extract page info if tab available
  let pageInfo = null;
  if (tab?.id) {
    try {
      pageInfo = (s._aiTags || s._aiSummary) && hasAIKey(s)
        ? await getPageInfoFromTab(tab.id, { withDefuddle: true })
        : await getPageInfoFromTab(tab.id);
    } catch (_) { /* content script may not be injected yet — proceed with empty pageInfo */ }
  }

  // Build notes from page info
  let notes = "";
  if (pageInfo) {
    notes = buildAutoNotes(pageInfo, {
      autoDescription: s._autoNotes,
      blockquote: s._blockquote,
      includeReferrer: false
    });
  }

  // Default tags
  let tags = [];
  if (s._defaultTags) {
    tags = s._defaultTags.split(/[,\s]+/).map(t => t.trim()).filter(Boolean);
  }

  // AI features
  const aiPromises = [];
  let combinedHandled = false;
  let aiHostPermissionMissing = false;
  let combinedCachedTags = null;
  let combinedCachedSummary = null;

  // Both tags AND summary requested -> one combined call (sends the body once).
  // Gated OFF when the user set a custom tag/summary prompt: the combined prompt uses
  // TAG_GUIDANCE (not their template), so customizers fall through to the separate calls
  // below, which honor customTagPrompt/customSummaryPrompt (Global Constraint).
  if (pageInfo?.pageText && hasAIKey(s) && s._aiTags && s._aiSummary
      && !s.customTagPrompt?.trim() && !s.customSummaryPrompt?.trim()) {
    try {
      const tCached = combinedCachedTags = await getAICache(url, "tags", s.aiCacheDuration, s.aiContentSource);
      const sCached = combinedCachedSummary = await getAICache(url, "summary", s.aiCacheDuration, s.aiContentSource);
      let aiTags, summary;
      if (tCached && sCached) {
        aiTags = tCached; summary = sCached;
      } else {
        const resp = await callAI(s, buildCombinedPrompt(s, title, url, pageInfo.pageText, notes, []));
        const parsed = parseAICombined(resp, s.aiTagSeparator);
        aiTags = parsed.tags; summary = parsed.summary;
        await setAICache(url, "tags", aiTags, s.aiCacheDuration, s.aiContentSource);
        await setAICache(url, "summary", summary, s.aiCacheDuration, s.aiContentSource);
      }
      tags = [...tags, ...aiTags];
      if (summary) {
        const wrapped = `[AI Summary]\n<blockquote>${escapeForExtended(summary)}</blockquote>`;
        notes = notes ? notes + "\n\n" + wrapped : wrapped;
      }
      combinedHandled = true;
    } catch (e) {
      if (e?.code === "host_permission") {
        aiHostPermissionMissing = true;
        if (combinedCachedTags) tags = [...tags, ...combinedCachedTags];
        if (combinedCachedSummary) {
          const wrapped = `[AI Summary]\n<blockquote>${escapeForExtended(combinedCachedSummary)}</blockquote>`;
          notes = notes ? notes + "\n\n" + wrapped : wrapped;
        }
        console.warn(`${notifyCategory} AI skipped:`, e.message);
      } else {
        console.warn(`${notifyCategory} AI combined failed, falling back to separate calls:`, e.message);
      }
    }
  }

  if (!combinedHandled && !aiHostPermissionMissing && pageInfo?.pageText && hasAIKey(s)) {
    if (s._aiTags) {
      aiPromises.push(
        (async () => {
          try {
            const cached = await getAICache(url, "tags", s.aiCacheDuration, s.aiContentSource);
            if (cached) return { type: "tags", result: cached };
            const prompt = buildTagPrompt(s, title, url, pageInfo.pageText, notes, []);
            const resp = await callAI(s, prompt);
            const aiTags = refineTags(parseAITags(resp, s.aiTagSeparator), { cap: AI_TAG_CAP, separator: s.aiTagSeparator });
            await setAICache(url, "tags", aiTags, s.aiCacheDuration, s.aiContentSource);
            return { type: "tags", result: aiTags };
          } catch (e) {
            if (e?.code === "host_permission") aiHostPermissionMissing = true;
            console.warn(`${notifyCategory} AI tags failed:`, e.message);
            return null;
          }
        })()
      );
    }
    if (s._aiSummary) {
      aiPromises.push(
        (async () => {
          try {
            const cached = await getAICache(url, "summary", s.aiCacheDuration, s.aiContentSource);
            if (cached) return { type: "summary", result: cached };
            const prompt = buildSummaryPrompt(s, title, url, pageInfo.pageText, notes);
            const summary = await callAI(s, prompt);
            await setAICache(url, "summary", summary, s.aiCacheDuration, s.aiContentSource);
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

  // Wait for AI results (empty when combinedHandled)
  const aiResults = await Promise.all(aiPromises);
  for (const r of aiResults) {
    if (!r) continue;
    if (r.type === "tags") tags = [...tags, ...r.result];
    if (r.type === "summary") {
      const wrapped = `[AI Summary]\n<blockquote>${escapeForExtended(r.result)}</blockquote>`;
      notes = notes ? notes + "\n\n" + wrapped : wrapped;
    }
  }

  const result = await submitSaveIntent({
    mode,
    url,
    title,
    notes,
    tags: tags.join(" "),
    private: isPrivate,
    toread: toread === true ? true : undefined,
    archive: undefined,
  });

  if (result.status === "saved") {
    let undoInfo;
    if (result.mutation === "created") {
      try {
        const currentSettings = await loadSettings();
        if (currentSettings.pinboardToken) undoInfo = { url, token: currentSettings.pinboardToken };
      } catch (_) { /* saved result remains successful when Undo setup cannot read settings */ }
    }
    showNotification(
      notifyId + "-saved",
      notifyTitle,
      t(aiHostPermissionMissing ? "bgTitleSavedAiSkipped" : "bgTitleSaved", title.substring(0, 60)),
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
  if (result.reason === "not_logged_in") {
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
  } else {
    showNotification(notifyId + "-error", t("bgSaveFailed"), result.detail || result.reason || "Unknown error", "error");
  }
  return result;
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

// B4: write current tab data to session storage for popup mirror prefill (Phase 1)
async function _writeCurrentTabMirror(tabId, url, title) {
  if (!url || !url.startsWith("http")) {
    try { await chrome.storage.session.remove("_currentTab"); } catch (_) {}
    return;
  }
  const cached = statusCache.get(url);
  const posts = (cached && Date.now() - cached.timestamp < CACHE_TTL) ? (cached.posts || null) : null;
  try {
    await chrome.storage.session.set({
      _currentTab: { tabId, url, title: title || "", posts, ts: Date.now() }
    });
  } catch (_) {}
}

async function _getFocusedActiveTab(expectedTabId, expectedUrl) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id !== expectedTabId) return null;
  if (typeof expectedUrl === "string" && tab.url !== expectedUrl) return null;
  if (!tab.url || (!tab.url.startsWith("http://") && !tab.url.startsWith("https://"))) return null;
  return tab;
}

function _scheduleCurrentTabRefresh(tabId, expectedUrl) {
  _scheduleTabCheck(tabId, async () => {
    try {
      const tab = await _getFocusedActiveTab(tabId, expectedUrl);
      if (!tab) return;

      noteActivity();
      const bookmarked = await debouncedCheck(tab.url);

      // The tab may have navigated or lost focus while the API request was in flight.
      const currentTab = await _getFocusedActiveTab(tab.id, tab.url);
      if (!currentTab) return;
      if (typeof bookmarked === "boolean") setIcon(currentTab.id, bookmarked);
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && tab.url.startsWith("http")) {
    _scheduleCurrentTabRefresh(tabId, tab.url);
  }
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

// Keep service worker alive + periodic tasks
chrome.alarms.create("keepalive", { periodInMinutes: 4 });
// Periodically re-prime SETTINGS_DEFAULTS so chrome.storage doesn't go cold between
// uses (Chrome evicts storage backend after inactivity, causing slow first-open).
chrome.alarms.create("storage-warm", { periodInMinutes: 5 });

sweepAICacheMigrationBackup().catch(() => {});
sweepSuggestCache().catch(() => {});

// One-time migration: bgSaveNoClobber (boolean) -> bgSaveMode (tri-state).
// Raw array-key read (no defaults) so a genuinely-absent bgSaveMode is detectable.
async function migrateBgSaveMode() {
  try {
    const store = await getSettingsStorage();
    const raw = await store.get(["bgSaveMode", "bgSaveNoClobber"]);
    if (raw.bgSaveMode !== undefined) return; // already migrated or user-set
    const mode = (raw.bgSaveNoClobber === false) ? "overwrite" : "merge";
    await store.set({ bgSaveMode: mode });
  } catch (_) {}
}
// Keep the migration's promise: primeSettings callers await it first. Both are
// read-then-write over bgSaveMode, and onInstalled fires primeSettings almost
// immediately on update — if both reads completed before either write, prime's
// stale snapshot re-inserted the default "merge", permanently clobbering a legacy
// bgSaveNoClobber=false user's "overwrite" preference.
const _bgSaveModeMigration = migrateBgSaveMode();

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

// syncApiKeys cleanup (batch (4)): idempotent, best-effort, fire-and-forget at
// boot -- self-heals on the next boot/alarm tick if it fails partway (see
// pbpMigrateSecretsToLocal's own try/catch in shared.js). Also re-run on the
// existing storage-warm alarm below so a mid-session syncApiKeys-off toggle
// and any stray reintroduction of a secret into sync gets swept within 5 minutes.
pbpMigrateSecretsToLocal().catch(() => {});

async function syncPrewarmTagsAlarm() {
  const s = await loadSettings();
  const existing = await chrome.alarms.get("prewarm-tags");
  const shouldRun = s.tagSyncMode === "prewarmed" && !!s.pinboardToken;
  if (shouldRun && !existing) {
    chrome.alarms.create("prewarm-tags", { periodInMinutes: 15, delayInMinutes: 0.5 });
    prewarmTagsNow().catch(() => {}); // populate now; don't wait ~30s for the first alarm
  } else if (!shouldRun && existing) {
    chrome.alarms.clear("prewarm-tags");
  }
}

// React to webdav settings: create/clear the "webdav-push" alarm. Mirrors
// syncPrewarmTagsAlarm's gated create/clear above. chrome.alarms.create()
// silently replaces any existing alarm of the same name, so no explicit
// clear-then-recreate dance is needed when only the period changes.
async function syncWebdavPushAlarm() {
  const s = await loadSettings();
  const existing = await chrome.alarms.get("webdav-push");
  const shouldRun = !!s.webdavAutoPush && s.webdavAutoPush !== "off" && !!s.webdavUrl && !!s.webdavPass;
  const wantedPeriod = s.webdavAutoPush === "daily" ? 1440 : 60;
  if (shouldRun && (!existing || existing.periodInMinutes !== wantedPeriod)) {
    chrome.alarms.create("webdav-push", { periodInMinutes: wantedPeriod, delayInMinutes: wantedPeriod });
  } else if (!shouldRun && existing) {
    chrome.alarms.clear("webdav-push");
  }
}

async function prewarmTagsNow() {
  const s = await loadSettings();
  if (!s.pinboardToken) return;
  try {
    const resp = await pinboardFetch(`https://api.pinboard.in/v1/tags/get?auth_token=${s.pinboardToken}&format=json`);
    if (!resp.ok) return;
    const data = await resp.json();
    // Store only the count map + timestamp; the popup rebuilds the sorted tag list
    // from counts on read (deterministic), so storing the array too is dead weight.
    await chrome.storage.local.set({
      cached_user_tags: { counts: data, timestamp: Date.now() }
    });
  } catch (e) {
    // Tag cache write failure: stale data hurts autocomplete UX, log it
    console.warn("[tag-cache] write failed:", e?.message || e);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    processOfflineQueue().catch(() => {});
    updateBadge().catch(() => {});
    ensureKeepAlive(); // if SW was revived mid-window by the alarm, resume pinging
  }
  if (alarm.name === "prewarm-tags") {
    prewarmTagsNow().catch(() => {});
  }
  if (alarm.name === "storage-warm") {
    _bgSaveModeMigration.then(() => primeSettings()).catch(() => {});
    pbpMigrateSecretsToLocal().catch(() => {});
  }
  if (alarm.name === "webdav-push") {
    // pbpWebdavPush() only ever chrome.permissions.contains()-checks --
    // never request() -- so this never surfaces a permission prompt with
    // no user gesture behind it (spec invariant #3). Any failure (missing
    // permission, network, non-2xx) is recorded into webdavLastPush and
    // swallowed here; the next scheduled tick retries naturally.
    pbpWebdavPush().catch(() => {});
  }
});

// React to settings change: toggle the prewarm alarm on/off (settings live in sync or local based on optSyncEnabled)
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" || area === "local") && pbpSettingsKeysChanged(changes)) invalidateSettingsCache();
  if ((area === "sync" || area === "local") && (changes.tagSyncMode || changes.pinboardToken)) {
    syncPrewarmTagsAlarm().catch(() => {});
  }
  if ((area === "sync" || area === "local") && (changes.webdavAutoPush || changes.webdavUrl || changes.webdavPass)) {
    syncWebdavPushAlarm().catch(() => {});
  }
});
// Initial check
syncPrewarmTagsAlarm().catch(() => {});
syncWebdavPushAlarm().catch(() => {});

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


// Recurring sweep of the per-URL suggest-tag cache (cached_suggest_*). The popup
// writes one key per visited URL with a 10-min read-TTL but never evicts them, so
// without this they accumulate unbounded in storage.local and slow reads. Gated to
// ~once / 6h to bound the get(null) scan; drops entries older than 1h (past the TTL).
const SUGGEST_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SUGGEST_STALE_MS = 60 * 60 * 1000;
const JINA_STALE_MS = 60 * 60 * 1000; // 1 hour, same as suggest cache
// Recurring sweep of per-URL cache (cached_suggest_* and jina_md_*). Both write
// entries with a read-TTL but never evict them, so without this they accumulate
// unbounded in storage.local and slow reads. Gated to ~once / 6h to bound the
// get(null) scan; drops entries older than their 1h TTL.
async function sweepSuggestCache() {
  try {
    const now = Date.now();
    const { _suggestSweepTs = 0 } = await chrome.storage.local.get({ _suggestSweepTs: 0 });
    if (now - _suggestSweepTs < SUGGEST_SWEEP_INTERVAL_MS) return;
    const all = await chrome.storage.local.get(null);
    const stale = Object.keys(all).filter((k) => {
      if (k.startsWith("cached_suggest_")) return isStaleCacheEntry(all[k], now, SUGGEST_STALE_MS);
      if (k.startsWith("jina_md_")) return isStaleCacheEntry(all[k], now, JINA_STALE_MS);
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
// ponytail: get(null) enumerates ALL local keys — fine at current key counts;
// upgrade to chrome.storage.local.getKeys() (Chrome ≥130) if this turns hot.
async function pbpSweepPreviewOrphans() {
  try {
    const tabs = await chrome.tabs.query({});            // includes discarded tabs
    const base = chrome.runtime.getURL("md-preview.html");
    const live = new Set();
    for (const tb of tabs) {
      if (tb.url && tb.url.startsWith(base)) {
        const kk = new URL(tb.url).searchParams.get("k");
        if (kk) live.add("md_preview_data_" + kk);
      }
    }
    const all = await chrome.storage.local.get(null);
    // Grace window: keep keys written in the last 60s even if their tab isn't in
    // tabs.query yet — closes the cold-start TOCTOU where popup set()s a token key
    // (waking the SW → this sweep) before its tabs.create() registers the ?k= tab.
    const now = Date.now();
    const stale = Object.keys(all).filter((x) =>
      x.startsWith("md_preview_data_") && !live.has(x) &&
      !(all[x] && all[x].ts && (now - all[x].ts) < 60000));
    if (stale.length) await chrome.storage.local.remove(stale);
  } catch (_) { /* best-effort: leaked keys just linger to the next sweep */ }
}
// Cold-start residue clean: runs once per SW script evaluation (fire-and-forget).
pbpSweepPreviewOrphans();

// Startup: process offline queue + update badge + prime settings (cheap no-op when already primed)
chrome.runtime.onStartup.addListener(() => {
  _bgSaveModeMigration.then(() => primeSettings()).catch(() => {});
  processOfflineQueue().catch(() => {});
  updateBadge().catch(() => {});
});

// Install/update: prime SETTINGS_DEFAULTS so the first popup open is fast for users whose
// storage doesn't have every key yet (storage.get(missing-key) is measurably slower).
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install" || reason === "update") {
    _bgSaveModeMigration.then(() => primeSettings()).catch(() => {});
  }
});

// ---- 监听来自 popup 的消息 ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") { sendResponse({ error: "invalid" }); return true; }
  noteActivity(); // using the popup keeps the SW warm for the next open

  if (message.type === "get_bookmark_data" && message.url) {
    const cached = statusCache.get(message.url);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL && cached.posts) {
      sendResponse({ posts: cached.posts });
    } else {
      sendResponse({ posts: null });
    }
    return true;
  }

  if (message.type === "get_offline_queue") {
    readOfflineQueueWithIds()
      .then((queue) => sendResponse({ ok: true, queue }))
      .catch(() => sendResponse({ ok: false, queue: [] }));
    return true;
  }

  if (message.type === "save_intent") {
    submitPopupSaveIntent(message.intent)
      .then(sendResponse)
      .catch(() => sendResponse(pbpSaveFailure("internal")));
    return true;
  }

  if (message.type === "archive_url" && typeof message.url === "string") {
    loadSettings().then((s) => pbpWaybackArchive(message.url, s, { isPrivate: message.private === true, force: message.force === true })).catch(() => {});
    return;
  }

  if (message.type === "bookmark_deleted" && message.url) {
    statusCache.set(message.url, { bookmarked: false, timestamp: Date.now() });
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id && pbpSameBookmark(tab.url, message.url)) setIcon(tab.id, false);
    }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === "saveTabSet" && message.tabsData) {
    handleSaveTabSet(message.tabsData);
    sendResponse({ status: "started" });
    return true;
  }

  if (message.action === "startBatchSave" && Array.isArray(message.tabs)) {
    if (_batchRunning) { sendResponse({ status: "busy" }); return true; }
    handleBatchSave(message.tabs);   // fire-and-forget; keeps SW alive via in-flight fetches
    sendResponse({ status: "started" });
    return true;
  }

  if (message.type === "pinboard_api_call") {
    // Proxy Pinboard fetch through service worker to avoid Chrome's native auth dialog on 401
    if (!pbpIsAllowedPinboardApiUrl(message.url)) {
      sendResponse({ ok: false, status: 0, text: "", error: "invalid_pinboard_api_url" });
      return true;
    }
    pinboardFetch(message.url)
      .then(async res => {
        const text = await res.text();
        sendResponse({ ok: res.ok, status: res.status, text });
      })
      .catch(err => sendResponse({ ok: false, status: 0, text: "", error: err.message }));
    return true;
  }

  if (message.type === "retry_offline_item" && typeof message.queueId === "string") {
    retryOfflineItem(message.queueId)
      .then(({ ok, result }) => sendResponse({ ok, result }))
      .catch(() => sendResponse({ ok: false, result: pbpSaveFailure("internal") }));
    return true;
  }

  if (message.type === "remove_offline_item" && typeof message.queueId === "string") {
    mutateOfflineQueue({ kind: "remove", queueId: message.queueId })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "clear_offline_queue") {
    mutateOfflineQueue({ kind: "clear" })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "test_pinboard_token" && message.token) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    fetch(`https://api.pinboard.in/v1/user/api_token/?auth_token=${encodeURIComponent(message.token)}&format=json`, { signal: ctrl.signal })
      .then(res => { clearTimeout(timer); sendResponse({ ok: res.ok, status: res.status }); })
      .catch(err => { clearTimeout(timer); sendResponse({ ok: false, error: err.name === "AbortError" ? "timeout" : "network" }); });
    return true; // keep channel open for async response
  }

  if (message.type === "reextractMarkdown") {
    const { tabId, url, engine, tags, description, k } = message;
    if (!url || (engine !== "local" && engine !== "jina")) {
      sendResponse({ ok: false, error: "bad_request" }); return true;
    }
    // Write back to the requesting tab's own token key so the reload reads the
    // fresh payload from the SAME slot it owns. No k = pre-update tab → fall
    // back to the legacy global key.
    const key = k ? "md_preview_data_" + k : "md_preview_data";
    extractForPreview({ tabId, url, engine })
      .then(out => {
        if (out.error) { sendResponse({ ok: false, error: out.error }); return; }
        return chrome.storage.local.set({
          [key]: {
            ...out, baseUrl: out.url || url, tabId,
            tags: Array.isArray(tags) ? tags : [],
            description: typeof description === "string" ? description : "",
            ts: Date.now() // sweep grace (see pbpSweepPreviewOrphans)
          }
        }).then(() => sendResponse({ ok: true }));
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message.type === "mdPreviewBookmarkInfo" && message.url) {
    // Same checkBookmarked()/statusCache the toolbar icon uses (X2: badge = one
    // cache, one source of truth). checkBookmarked()'s TTL-hit branch can return
    // bookmarked:true from a cache entry that was populated WITHOUT .posts (see
    // save pipeline / quick-save / batch-save / skip-mode / offline-queue call
    // sites) — so the boolean alone isn't enough to read tags/shared/toread from.
    // Mirror get_bookmark_data's guard (background.js:845-846: require
    // cached.posts, not just cached.bookmarked) and force one fresh posts/get
    // lookup when .posts is missing, same shape as fetchExistingBookmark
    // (background.js:242). Any failure collapses to bookmarked:false.
    const url = message.url;
    checkBookmarked(url)
      .then(async (bookmarked) => {
        if (!bookmarked) { sendResponse({ bookmarked: false }); return; }
        let post = statusCache.get(url)?.posts?.[0];
        if (!post) {
          const token = await getCachedToken();
          if (!token) { sendResponse({ bookmarked: false }); return; }
          const resp = await pinboardFetch(`https://api.pinboard.in/v1/posts/get?auth_token=${token}&format=json&url=${encodeURIComponent(url)}`);
          const posts = resp.ok ? (await resp.json()).posts || [] : [];
          statusCache.set(url, { bookmarked: posts.length > 0, timestamp: Date.now(), posts });
          post = posts[0];
        }
        if (!post) { sendResponse({ bookmarked: false }); return; }
        sendResponse({ bookmarked: true, tags: post.tags || "", shared: post.shared, toread: post.toread });
      })
      .catch(() => sendResponse({ bookmarked: false }));
    return true;
  }
});

// ===================== Batch Bookmark 保存（后台） =====================
// The batch loop moved out of popup-batch.js so it survives popup close.
// Progress is mirrored to storage.local.batch_progress for the popup to render;
// the completion notification fires here regardless of popup state.
let _batchRunning = false;

async function _writeBatchProgress(p) {
  try { await chrome.storage.local.set({ batch_progress: { ...p, ts: Date.now() } }); }
  catch (_) { /* storage transient failure — progress UI degrades, batch continues */ }
}

async function handleBatchSave(tabs) {
  if (_batchRunning) return;            // one batch per SW lifetime (popup also guards)
  _batchRunning = true;
  const total = tabs.length;
  let saved = 0, queued = 0, failed = 0, aiFailed = 0, skipped = 0, tooLong = 0;
  const base = () => ({ total, i: 0, saved, queued, failed, aiFailed, skipped, tooLong });
  await _writeBatchProgress({ running: true, done: false, error: null, ...base() });

  try {
    const s = await loadSettings();
    if (!s.pinboardToken) {
      await _writeBatchProgress({ running: false, done: true, error: "not_logged_in", ...base() });
      showNotification("batch-error", t("bgBatchSaved"), t("bgNotLoggedIn"), "error");
      return;
    }

    const baseTags = s.optBatchTagEnabled && s.optBatchTag
      ? s.optBatchTag.split(/[,，]+/).map(x => x.trim().replace(/\s+/g, "-")).filter(Boolean)
      : [];
    const useAiTags = s.batchAiTags && hasAIKey(s);
    const useAiSummary = s.batchAiSummary && hasAIKey(s);

    // popup's global tagCaseMap is unreachable in the SW; rebuild from the cached
    // user-tag counts (popup-tags.js persists them under "cached_user_tags").
    let tagCaseMap = {};
    if (s.optRespectTagCase) {
      try {
        const cached = await chrome.storage.local.get("cached_user_tags");
        const counts = cached?.cached_user_tags?.counts;
        if (counts) tagCaseMap = buildTagCaseMap(counts);
      } catch (_) { /* no cache -> map stays empty, resolveTagCase returns tag as-is */ }
    }

    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      await _writeBatchProgress({ running: true, done: false, error: null, total, i, saved, queued, failed, aiFailed, skipped, tooLong });

      try {
        let tags = [...baseTags];
        let notes = "";

        if (useAiTags || useAiSummary) {
          let pageInfo = null;
          try { pageInfo = await getPageInfoFromTab(tab.id, { withDefuddle: true }); }
          catch (e) { console.warn("batch: cannot extract page content for", tab.url, e.message); }
          if (pageInfo?.pageText) {
            let combinedHandled = false;
            if (useAiTags && useAiSummary && !s.customTagPrompt?.trim() && !s.customSummaryPrompt?.trim()) {
              try {
                const tCached = await getAICache(tab.url, "tags", s.aiCacheDuration, s.aiContentSource);
                const sCached = await getAICache(tab.url, "summary", s.aiCacheDuration, s.aiContentSource);
                let aiTags, summary;
                if (tCached && sCached) { aiTags = tCached; summary = sCached; }
                else {
                  const resp = await callAI(s, buildCombinedPrompt(s, tab.title || tab.url, tab.url, pageInfo.pageText, "", []));
                  const parsed = parseAICombined(resp, s.aiTagSeparator);
                  aiTags = s.optRespectTagCase ? parsed.tags.map(tg => resolveTagCase(tg, tagCaseMap)) : parsed.tags;
                  summary = parsed.summary;
                  await setAICache(tab.url, "tags", aiTags, s.aiCacheDuration, s.aiContentSource);
                  await setAICache(tab.url, "summary", summary, s.aiCacheDuration, s.aiContentSource);
                }
                tags = [...tags, ...aiTags];
                if (summary) notes = `[AI Summary]\n<blockquote>${escapeForExtended(summary)}</blockquote>`;
                combinedHandled = true;
              } catch (e) { console.warn("batch AI combined failed, falling back:", tab.url, e.message); }
            }
            if (!combinedHandled) {
              const aiJobs = [];
              if (useAiTags) aiJobs.push((async () => {
                try {
                  const cached = await getAICache(tab.url, "tags", s.aiCacheDuration, s.aiContentSource);
                  if (cached) return { type: "tags", result: cached };
                  const prompt = buildTagPrompt(s, tab.title || tab.url, tab.url, pageInfo.pageText, "", []);
                  const resp = await callAI(s, prompt);
                  const rawTags = refineTags(parseAITags(resp, s.aiTagSeparator), { cap: AI_TAG_CAP, separator: s.aiTagSeparator });
                  const aiTags = s.optRespectTagCase ? rawTags.map(tg => resolveTagCase(tg, tagCaseMap)) : rawTags;
                  await setAICache(tab.url, "tags", aiTags, s.aiCacheDuration, s.aiContentSource);
                  return { type: "tags", result: aiTags };
                } catch (e) { console.warn("batch AI tags failed:", tab.url, e.message); aiFailed++; return null; }
              })());
              if (useAiSummary) aiJobs.push((async () => {
                try {
                  const cached = await getAICache(tab.url, "summary", s.aiCacheDuration, s.aiContentSource);
                  if (cached) return { type: "summary", result: cached };
                  const prompt = buildSummaryPrompt(s, tab.title || tab.url, tab.url, pageInfo.pageText, "");
                  const summary = await callAI(s, prompt);
                  await setAICache(tab.url, "summary", summary, s.aiCacheDuration, s.aiContentSource);
                  return { type: "summary", result: summary };
                } catch (e) { console.warn("batch AI summary failed:", tab.url, e.message); aiFailed++; return null; }
              })());
              const results = await Promise.all(aiJobs);
              for (const r of results) {
                if (!r) continue;
                if (r.type === "tags") tags = [...tags, ...r.result];
                if (r.type === "summary") notes = `[AI Summary]\n<blockquote>${escapeForExtended(r.result)}</blockquote>`;
              }
            }
          }
        }

        const dedupedTags = [...new Set(tags.map(tg => tg.toLowerCase()))].map(lower => tags.find(tg => tg.toLowerCase() === lower));
        const isPrivate = pbpEffectivePrivate(s, { incognito: tab.incognito });
        const result = await submitSaveIntent({
          mode: s.batchSkipExisting ? "skip" : "merge",
          url: tab.url,
          title: tab.title || tab.url,
          notes,
          tags: dedupedTags.join(" "),
          private: isPrivate,
          toread: s.optReadlaterDefault ? true : undefined,
          archive: s.waybackArchiveBatch ? undefined : false,
        }, { deferBadge: true });
        if (result.status === "saved") saved++;
        else if (result.status === "queued") queued++;
        else if (result.status === "skipped") skipped++;
        else if (result.reason === "too_long") tooLong++;
        else failed++;
      } catch (_) { failed++; }
    }

    if (saved > 0) await updateBadge().catch(() => {});

    await _writeBatchProgress({ running: false, done: true, error: null, total, i: total, saved, queued, failed, aiFailed, skipped, tooLong });
    const tagsSuffix = baseTags.length ? t("batchTaggedSuffix", baseTags.join(", ")) : "";
    const skippedMsg = skipped > 0 ? t("batchSkipped", String(skipped)) : "";
    const tooLongMsg = tooLong > 0 ? t("batchTooLong", String(tooLong)) : "";
    const queuedMsg = queued > 0 ? ` · ${t("offlineQueued", String(queued))}` : "";
    if (saved > 0 || queued > 0) {
      const title = saved > 0 ? t("bgBatchSaved") : t("bgQueuedOffline");
      const message = t("batchDone", String(saved), String(failed)) + skippedMsg + tooLongMsg + queuedMsg + tagsSuffix;
      showNotification("batch-saved", title, message, "batchSave");
    }
  } catch (e) {
    await _writeBatchProgress({ running: false, done: true, error: e.message, total, i: total, saved, queued, failed, aiFailed, skipped, tooLong });
    showNotification("batch-error", t("bgBatchSaved"), e.message, "error");
  } finally {
    _batchRunning = false;
  }
}

// ===================== Tab Set 保存 =====================
async function handleSaveTabSet(tabsData) {
  try {
    // Tab Set uses pinboard.in web API (cookie auth, not API token)
    const result = { browser: "chrome", windows: [tabsData.map(t => ({ title: t.title, url: t.url }))] };
    const formData = new FormData();
    formData.append("data", JSON.stringify(result));
    const resp = await fetch("https://pinboard.in/tabs/save/", { method: "POST", body: formData, credentials: "include" });
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
  if (changes.pinboardToken) _cachedToken = null;
  if (changes.optShowBadge) {
    if (changes.optShowBadge.newValue) updateBadge().catch(() => {});
    else chrome.action.setBadgeText({ text: "" });
  }
});

// ---- Markdown preview via keyboard shortcut (no popup) ----
// Self-contained extractor injected into the active tab's ISOLATED world.
// Mirrors popup.js extractLocalMarkdown's inner func: per-site rule first,
// then Defuddle. Returns HTML only — md-preview.html runs Turndown itself.
function extractPageForMarkdown() {
  try {
    if (typeof applySiteRule === "function") {
      const hit = applySiteRule(document, location.href);
      if (hit && hit.contentHtml) {
        // E1: normalize lazy-load img placeholders (data-src/srcset) on a
        // DETACHED div -- the live DOM is never touched; pbpNormalizeLazyImages
        // comes from site-rules.js, already injected by extractForPreview
        // before this function runs (chrome.scripting.executeScript calls).
        const div = document.createElement("div");
        div.innerHTML = hit.contentHtml;
        if (typeof pbpNormalizeLazyImages === "function") pbpNormalizeLazyImages(div, location.href);
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
    const _origCE = console.error;
    console.error = (...a) => { if (!String(a[0]).startsWith("Defuddle:")) _origCE.apply(console, a); };
    let result;
    try { result = new Defuddle(clone).parse(); } finally { console.error = _origCE; }
    if (!result?.content) return { error: "No content extracted" };
    // X4: mirrors popup.js's extractLocalMarkdown -- keep Defuddle's
    // author/published/site/image alongside content/title/url/math.
    return {
      contentHtml: result.content, title: result.title || document.title, url: location.href,
      math: !!document.querySelector("math"),
      author: result.author || "", published: result.published || "", site: result.site || "", image: result.image || ""
    };
  } catch (e) { return { error: e.message }; }
}

// Unified extraction service for the preview. Shared by the keyboard-shortcut
// opener and the in-preview engine toggle (reextractMarkdown). Returns the
// md_preview_data payload fields (minus tags/description/tabId, added by caller)
// or { error }. engine is "local" (Defuddle) or "jina".
async function extractForPreview({ tabId, url, engine }) {
  if (engine === "jina") {
    // Fresh read — do NOT use loadSettings() (its _settingsCache can be stale
    // when the user edits settings while the SW is warm). getSettingsStorage()
    // returns RAW (obfuscated) settings, so deobfuscate the key exactly once.
    let raw = await (await getSettingsStorage()).get({
      jinaApiKey: SETTINGS_DEFAULTS.jinaApiKey,
      aiCacheDuration: SETTINGS_DEFAULTS.aiCacheDuration
    });
    raw = await pbpApplySecretOverlay(raw);
    const key = raw.jinaApiKey ? deobfuscateKey(raw.jinaApiKey) : "";
    const r = await fetchJinaMarkdown(url, { apiKey: key, cacheDuration: raw.aiCacheDuration });
    if (r.error) return { error: r.error };
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
  try {
    const live = await chrome.tabs.get(tabId);
    if (!live || !live.url || live.url !== url) return { error: "tab_navigated" };
  } catch (_) { return { error: "tab_unavailable" }; }
  // Defuddle is required; injection failure (tab closed / CSP / no permission) → degrade.
  const injected = await chrome.scripting
    .executeScript({ target: { tabId }, files: ["vendor/defuddle.js"] }).catch(() => null);
  if (!injected) return { error: "tab_unavailable" };
  // site-rules.js is OPTIONAL — ignore failure so a broken rule can't mask Defuddle.
  await chrome.scripting.executeScript({ target: { tabId }, files: ["site-rules.js"] }).catch(() => {});
  const results = await chrome.scripting
    .executeScript({ target: { tabId }, func: extractPageForMarkdown }).catch(() => null);
  const out = results && results[0] && results[0].result;
  if (!out || out.error || !out.contentHtml) return { error: (out && out.error) || "empty" };
  return {
    source: "local", markdown: "", contentHtml: out.contentHtml,
    title: out.title || "", url: url, // prefer caller url over extractor's
    tokens: 0, hasApiKey: false, math: !!out.math, forum: !!out.forum,
    // X4: forward the four metadata fields extractPageForMarkdown's Defuddle
    // branch now keeps. The reextractMarkdown handler's `...out` spread
    // (background.js ~943-953) forwards these automatically into storage --
    // no separate edit needed there.
    author: out.author || "", published: out.published || "", site: out.site || "", image: out.image || ""
  };
}

async function openMarkdownPreviewFromShortcut() {
  pbpSweepPreviewOrphans(); // best-effort: clear closed-preview residue before adding one
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) { /* fall through to the guard below */ }
  if (!tab?.id || !tab.url || !tab.url.startsWith("http")) {
    showNotification("mdpv-error", t("bgMdPreviewFailed"), t("bgMdPreviewNoContent"), "error");
    return;
  }
  // Open the preview INSTANTLY with a pending placeholder so the shortcut feels
  // responsive; the preview page drives extraction via reextractMarkdown (the same
  // path as the in-preview toggle). Follow the aiContentSource setting (fresh read).
  const raw = await (await getSettingsStorage()).get({ aiContentSource: SETTINGS_DEFAULTS.aiContentSource });
  const engine = raw.aiContentSource === "jina" ? "jina" : "local";
  // Per-open token key so two shortcut opens (or a shortcut + a popup Preview)
  // never share one storage slot and clobber each other before their tabs read.
  const k = crypto.randomUUID();
  try {
    await chrome.storage.local.set({
      ["md_preview_data_" + k]: {
        pending: true, engine, source: engine,
        tabId: tab.id, url: tab.url, baseUrl: tab.url, title: tab.title || "",
        tags: [], description: "", ts: Date.now() // sweep grace (see pbpSweepPreviewOrphans)
      }
    });
    await chrome.tabs.create({ url: "md-preview.html?k=" + k });
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

// ===================== Keyboard Shortcuts =====================
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "markdown_preview") {
    await openMarkdownPreviewFromShortcut();
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
    if (!tab?.url || !tab.url.startsWith("http")) {
      showNotification(`${cfg.notifyId}-error`, t("bgCannotSave"), t("bgCannotBookmark"), "error");
      return;
    }
    const s = await loadSettings();
    const overrides = resolvePrefixSettings(s, cfg.prefix);
    await saveFromBackground({
      url: tab.url, title: tab.title || tab.url, tab,
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
