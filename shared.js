// ============================================================
// Pinboard Bookmark Enhanced - Shared Constants
// ============================================================

const ADAPTIVE_THEME_MAP = {
  flexoki: ["flexoki-light", "flexoki-dark"],
  solarized: ["solarized-light", "solarized-dark"],
  catppuccin: ["catppuccin-latte", "catppuccin-mocha"]
};

const TEXTAREA_MIN_HEIGHT = 54;
const TEXTAREA_MAX_HEIGHT = 300;
const TAG_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
// Inline SVG icons — replace emoji/color-glyphs that trigger a 1-3s Segoe UI Emoji
// font-load stall on Windows high-DPI Chrome (DirectWrite system-font enumeration,
// cached process-wide after first paint). currentColor = inherits theme text color.
const PBP_ICONS = {
  eye: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z"/><circle cx="8" cy="8" r="2"/></svg>',
  eyeOff: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z"/><circle cx="8" cy="8" r="2"/><path d="M2 2l12 12"/></svg>',
  robot: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="5" width="10" height="8" rx="2"/><circle cx="6" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="9" r="1" fill="currentColor" stroke="none"/><path d="M8 2v3M5.5 13v1M10.5 13v1"/></svg>',
  tabs: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="4" width="9" height="9" rx="1.5"/><path d="M5 4V2.5h9V11h-1.5"/></svg>',
  pin: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 1.5v6M8 14.5V10M4 7.5h8l-1.5 2.5h-5L4 7.5Z"/></svg>',
  doc: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 1.5h5l3 3v10H4Z"/><path d="M9 1.5v3h3"/></svg>',
  pencil: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3L11 2.5Z"/></svg>',
  check: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>',
  cross: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  warning: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 2 15 14H1Z"/><path d="M8 6.5v3.5" stroke-linecap="round"/><circle cx="8" cy="12" r="0.6" fill="currentColor" stroke="none"/></svg>',
  info: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.5v4" stroke-linecap="round"/><circle cx="8" cy="4.8" r="0.6" fill="currentColor" stroke="none"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.97M13.5 2.5V5h-2.5"/></svg>',
  download: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v7.5M4.5 6.5 8 10l3.5-3.5"/><path d="M3 13h10"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-1A1.5 1.5 0 0 1 1 9V2.5A1.5 1.5 0 0 1 2.5 1H9A1.5 1.5 0 0 1 10.5 2.5v1"/></svg>',
  obsidian: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>',
};

// Render "<check|cross icon> text" into a status element. The SVG uses currentColor so
// it inherits the element's success/error colour. Replaces literal ✓/✗ glyphs, which
// fall back to Segoe UI Emoji and stall ~1.6s on first paint (Windows hi-DPI). The label
// goes through a text node, so interpolated values (errors, results) can't inject HTML.
function setStatusIcon(el, ok, text) {
  if (!el) return;
  const ic = document.createElement("span");
  ic.className = "status-ic";
  ic.innerHTML = ok ? PBP_ICONS.check : PBP_ICONS.cross;
  el.replaceChildren(ic, document.createTextNode(" " + (text != null ? String(text) : "")));
}

// Set a button's content to "icon + label" without losing the SVG icon. Use this
// instead of `btn.textContent = label` on buttons that carry a .btn-ic SVG span,
// otherwise textContent wipes the icon. iconKey is a PBP_ICONS key; label is plain text.
function setBtnIcon(btn, iconKey, label) {
  if (!btn) return;
  const svg = PBP_ICONS[iconKey] || "";
  btn.innerHTML = '<span class="btn-ic">' + svg + '</span><span>' + "" + '</span>';
  // label set via textContent on the label span to avoid any HTML injection
  btn.lastElementChild.textContent = label != null ? String(label) : "";
}

const DEFAULT_TAG_PROMPT = `Suggest 5-10 bookmark tags for the following webpage. {{lang_instruction}} Tags should be lowercase, {{separator_instruction}}. Return ONLY a JSON array.

Title: {{title}}
URL: {{url}}
Content: {{content}}

Format: ["tag1","tag2"]`;

const DEFAULT_SUMMARY_PROMPT = `Summarize the following webpage concisely in 2-4 sentences. Focus on key points. {{lang_instruction}}

Title: {{title}}
Content: {{content}}`;

// Simple obfuscation for API keys stored in chrome.storage
// Not real encryption — prevents casual plaintext reading
function obfuscateKey(key) {
  if (!key) return "";
  try { return "obf:" + btoa(unescape(encodeURIComponent(key))); } catch (_) { return key; }
}
function deobfuscateKey(val) {
  if (!val) return "";
  // Loop-strip up to 4 layers to handle legacy double-wrapped keys
  // (pre-fix save path could re-obfuscate an already-obfuscated value).
  for (let i = 0; i < 4 && typeof val === "string" && val.startsWith("obf:"); i++) {
    try { val = decodeURIComponent(escape(atob(val.substring(4)))); } catch (_) { return val; }
  }
  return val;
}

const SETTINGS_DEFAULTS = {
  pinboardToken: "",
  aiProvider: "gemini",
  geminiApiKey: "", geminiModel: "gemini-2.5-flash-lite",
  openaiApiKey: "", openaiModel: "gpt-5.4-nano", openaiBaseUrl: "https://api.openai.com/v1",
  claudeApiKey: "", claudeModel: "claude-haiku-4-5-20251001",
  deepseekApiKey: "", deepseekModel: "deepseek-v4-flash",
  qwenApiKey: "", qwenModel: "qwen-flash",
  minimaxApiKey: "", minimaxModel: "MiniMax-M2",
  openrouterApiKey: "", openrouterModel: "meta-llama/llama-4-scout:free",
  groqApiKey: "", groqModel: "meta-llama/llama-4-scout-17b-16e-instruct",
  mistralApiKey: "", mistralModel: "mistral-small-latest",
  cohereApiKey: "", cohereModel: "command-r-08-2024",
  siliconflowApiKey: "", siliconflowModel: "Qwen/Qwen3-8B",
  zhipuApiKey: "", zhipuModel: "glm-4.7-flash",
  kimiApiKey: "", kimiModel: "kimi-k2.6",
  ollamaBaseUrl: "http://localhost:11434", ollamaModel: "llama3.2",
  customApiKey: "", customModel: "", customBaseUrl: "", customName: "Custom",
  aiTagLang: "en", aiSummaryLang: "auto", aiCacheDuration: 60,
  aiContentSource: "local", jinaApiKey: "",
  customTagPrompt: "", customSummaryPrompt: "",
  optPrivateDefault: false, optPrivateIncognito: true, optReadlaterDefault: false,
  optAutoDescription: true, optBlockquote: true, optIncludeReferrer: false,
  optAiAutoTags: false,
  qsAutoNotes: true, qsBlockquote: true, qsDefaultTags: "", qsAiTags: false, qsAiSummary: false,
  rlAutoNotes: true, rlBlockquote: true, rlDefaultTags: "", rlAiTags: false, rlAiSummary: false,
  optBatchTagEnabled: true, optBatchTag: "batch_saved",
  batchAiTags: false, batchAiSummary: false, batchSkipExisting: false,
  optLang: "auto",
  optShowRecent: false, optShowSearch: false, optTheme: "auto",
  notifyQuickSave: true, notifyReadLater: true,
  notifyTabSet: true, notifyBatchSave: true, notifyErrors: true,
  customFont: "",
  optRespectTagCase: true, aiTagSeparator: "-",
  offlineQueueEnabled: true, optShowBadge: false,
  tagSyncMode: "cached", // "fresh" | "cached" | "prewarmed"
  optCheckBookmarkStatus: true, optShowSuggestTags: true,
  optShowAiSummary: true, optShowAiTags: true,
  optShowQuickLinks: true, optShowQuickRow: true,
  tagPresets: "", optAutoCloseAfterSave: true,
  themePresetKey: "", optPopupFollowTheme: true,
  popupWidth: 550,
  mdExportFrontmatter: true, mdExportImagePolicy: "keep", mdExportIncludeToc: false,
  obsidianEnabled: false, obsidianVault: "", obsidianFolder: "",
  urlClean: { enabled: true, onPopupOpen: true, onPaste: true, aggressiveMode: false, customParams: [], excludeParams: [] }
};

// ---- Tag case normalization helpers ----
// Build a map: normalized_tag → preferred_casing (by highest count)
function buildTagCaseMap(tagCounts) {
  const groups = {};
  for (const [tag, count] of Object.entries(tagCounts)) {
    const norm = normalizeTagKey(tag);
    if (!groups[norm]) groups[norm] = [];
    groups[norm].push({ tag, count: parseInt(count) || 0 });
  }
  const map = {};
  for (const [norm, variants] of Object.entries(groups)) {
    variants.sort((a, b) => b.count - a.count);
    map[norm] = variants[0].tag;
  }
  return map;
}

// Normalize tag for fuzzy matching: lowercase, strip separators
function normalizeTagKey(tag) {
  return tag.toLowerCase().replace(/[-_]/g, "");
}

// Resolve a tag to its preferred existing casing
function resolveTagCase(tag, caseMap) {
  const norm = normalizeTagKey(tag);
  return caseMap[norm] || tag;
}

// ---- Pinboard API rate limiter ----
// Ensures minimum 3.1s between Pinboard API calls
const _pinboardQueue = [];
let _pinboardLastCall = 0;
let _pinboardProcessing = false;

// Accepts options.timeoutMs (default 15000) to override abort timeout per call.
// Non-critical endpoints (e.g. suggest) should pass a shorter value to fail fast.
function pinboardFetch(url, options) {
  return new Promise((resolve, reject) => {
    _pinboardQueue.push({ url, options: options || {}, resolve, reject });
    _processPinboardQueue();
  });
}

// Fire immediately without joining the rate-limit queue.
// Use only for non-critical read-only GET endpoints (e.g. posts/suggest) that already
// handle 429 gracefully. Avoids the 3.1s+ rate-limit wait that the main queue imposes.
function pinboardFetchImmediate(url, options) {
  return new Promise((resolve, reject) => {
    _executePinboardFetch(url, options || {}, resolve, reject);
  });
}

async function _processPinboardQueue() {
  if (_pinboardProcessing || !_pinboardQueue.length) return;
  _pinboardProcessing = true;
  while (_pinboardQueue.length) {
    const { url, options, resolve, reject } = _pinboardQueue.shift();
    // Cross-context coordination: read shared timestamp from storage
    let lastCall = _pinboardLastCall;
    try {
      const stored = await chrome.storage.local.get("_pbRateLimitTs");
      if (stored._pbRateLimitTs > lastCall) lastCall = stored._pbRateLimitTs;
    } catch (_) {}
    const now = Date.now();
    const wait = Math.max(0, 3100 - (now - lastCall));
    // Reserve the time slot BEFORE waiting/fetching to prevent race conditions
    // between popup and background contexts reading stale timestamps
    const reservedTime = now + wait;
    _pinboardLastCall = reservedTime;
    try { await chrome.storage.local.set({ _pbRateLimitTs: reservedTime }); } catch (_) {}
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    // Fire without awaiting — rate limit is timing-based (gap between request starts),
    // not completion-based. Awaiting each fetch caused queue starvation: a slow/hung
    // request (e.g. suggest for a niche URL) would delay all subsequent queued requests
    // by its full timeout duration.
    _executePinboardFetch(url, options, resolve, reject);
  }
  _pinboardProcessing = false;
}

function _executePinboardFetch(url, options, resolve, reject) {
  const ctrl = new AbortController();
  const { timeoutMs = 15000, ...fetchOpts } = options;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  fetch(url, { ...fetchOpts, signal: ctrl.signal })
    .finally(() => clearTimeout(timer))
    .then(resolve, reject);
}

// ---- Pinboard posts/add URI builder ----
// Pinboard's CGI only reads query-string params (POST body is ignored, verified 2026-04-23),
// so every field must fit in the request URI. Measured 2026-06-02 (invalid-token probe): the
// server returns 414 once the full URI exceeds ~4100 bytes (flips between 4100 and 4110 — the
// cap is on the HTTP request line). CJK chars cost 9 bytes each once percent-encoded (3 UTF-8
// bytes → %XX%XX%XX), so notes fill the budget fast. 3900 sits ~200 bytes below the 414 cliff
// and allows ~3700 bytes of encoded fields. The earlier 2500 was over-conservative and rejected
// mixed-CJK notes that Pinboard's own web form accepts (the form POSTs to the site, bypassing
// the URI-bound API). Every save path (popup, batch, background) and the live char counter use
// buildPostsAddUri below, so the measured length equals what is actually sent.
const POSTS_ADD_URI_BUDGET = 3900;
function buildPostsAddUri({ token, url, title = "", extended = "", tags = "", shared, toread, replace = true }) {
  const enc = encodeURIComponent;
  let uri = `https://api.pinboard.in/v1/posts/add?auth_token=${token}&format=json`;
  uri += `&url=${enc(url || "")}`;
  uri += `&description=${enc(title)}`;
  uri += `&extended=${enc(extended)}`;
  uri += `&tags=${enc(tags)}`;
  if (shared !== undefined) uri += `&shared=${shared}`;
  if (toread !== undefined) uri += `&toread=${toread}`;
  if (replace) uri += `&replace=yes`;
  return uri;
}

// ---- Pinboard error classifier ----
// Returns an i18n key describing a Pinboard API failure.
// Input: HTTP Response, Error, or status number. Caller handles 401 (pinboardFetch redirects)
// and 500 (Pinboard's quirk for niche URLs → "no suggestions") BEFORE calling this.
function classifyPinboardError(input) {
  if (input && typeof input === "object" && "status" in input && !("name" in input)) {
    const s = input.status;
    if (s === 401 || s === 403) return "pinboardErrorAuth";
    if (s === 429) return "pinboardErrorRateLimit";
    if (s >= 500) return "pinboardErrorServer";
    return "pinboardErrorOffline";
  }
  if (typeof input === "number") {
    if (input === 401 || input === 403) return "pinboardErrorAuth";
    if (input === 429) return "pinboardErrorRateLimit";
    if (input >= 500) return "pinboardErrorServer";
    return "pinboardErrorOffline";
  }
  // Error instance (network failure, AbortError, etc.)
  const name = input?.name;
  if (name === "AbortError") return "pinboardErrorTimeout";
  if (input instanceof TypeError) return "pinboardErrorOffline";
  return "pinboardErrorOffline";
}

// ---- Settings storage selector (sync vs local based on user preference) ----
// The preference itself is always stored in chrome.storage.local (bootstrap location).
// R5: cached + invalidated on optSyncEnabled change. First call seeds from localStorage
// mirror if present (synchronous fast path), then storage.get confirms.
let _settingsStorageCache = null;

// Sync fast-path: hydrate from localStorage mirror if available.
// Caller still treats getSettingsStorage as async (signature preserved).
try {
  if (typeof localStorage !== "undefined") {
    const m = localStorage.getItem("pp-sync-enabled");
    if (m === "1") _settingsStorageCache = chrome.storage.sync;
    else if (m === "0") _settingsStorageCache = chrome.storage.local;
  }
} catch (_) {}

async function getSettingsStorage() {
  if (_settingsStorageCache) return _settingsStorageCache;
  try {
    const { optSyncEnabled } = await chrome.storage.local.get({ optSyncEnabled: false });
    _settingsStorageCache = optSyncEnabled ? chrome.storage.sync : chrome.storage.local;
    try { localStorage.setItem("pp-sync-enabled", optSyncEnabled ? "1" : "0"); } catch (_) {}
    return _settingsStorageCache;
  } catch (_) {
    return chrome.storage.local;
  }
}

// Invalidate cache + mirror when user toggles optSyncEnabled
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.optSyncEnabled) {
      _settingsStorageCache = null;
      try {
        const v = changes.optSyncEnabled.newValue;
        if (typeof v === "boolean") localStorage.setItem("pp-sync-enabled", v ? "1" : "0");
      } catch (_) {}
    }
  });
}

// ---- Prime SETTINGS_DEFAULTS into storage (one-time fix for popup boot lag) ----
// chrome.storage.{local,sync}.get({ k: default }) is measurably slower when k is missing
// vs when k exists explicitly. For users who never customized most settings, this slows
// popup boot enough to surface the main-section flash. Calling primeSettings() on install/
// update/startup writes only the missing keys (existing values are preserved).
async function primeSettings() {
  try {
    const storage = await getSettingsStorage();
    const keys = Object.keys(SETTINGS_DEFAULTS);
    const existing = await storage.get(keys); // array form: returns only keys that are set
    const missing = {};
    for (const k of keys) {
      if (!(k in existing)) missing[k] = SETTINGS_DEFAULTS[k];
    }
    if (Object.keys(missing).length > 0) {
      await storage.set(missing);
    }
  } catch (_) { /* best-effort */ }
}

// ---- Chunked sync storage for large values ----
// chrome.storage.sync has 8KB per-key limit; split large strings into chunks
// When sync is disabled, local storage is used directly (5MB limit, no chunking needed)
const SYNC_CHUNK_SIZE = 7000; // bytes, leave margin under 8KB (QUOTA_BYTES_PER_ITEM)

async function syncSetLarge(key, value) {
  const storage = await getSettingsStorage();
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (storage === chrome.storage.local) {
    // Local storage: no chunking needed
    if (!str) { await chrome.storage.local.remove(key); return; }
    await chrome.storage.local.set({ [key]: str });
    return;
  }
  // Sync storage: use chunking (8KB per-key limit)
  // Sweep ALL existing chunks for this key — both the count recorded in meta
  // and any orphans left over from earlier writes (defensive against quota
  // failures or interrupted writes that left stray ${key}_N entries).
  const all = await chrome.storage.sync.get(null);
  const orphanKeys = Object.keys(all).filter(k => new RegExp(`^${key}_\\d+$`).test(k));
  if (orphanKeys.length) await chrome.storage.sync.remove(orphanKeys);
  if (!str) { await chrome.storage.sync.remove(key); return; }
  const chunks = [];
  for (let i = 0; i < str.length; i += SYNC_CHUNK_SIZE) {
    chunks.push(str.substring(i, i + SYNC_CHUNK_SIZE));
  }
  const data = { [key]: { _chunks: chunks.length } };
  chunks.forEach((chunk, i) => { data[`${key}_${i}`] = chunk; });
  try {
    await chrome.storage.sync.set(data);
  } catch (e) {
    // Quota exceeded — fall back to local storage
    console.warn("sync storage quota exceeded, falling back to local:", e.message);
    await chrome.storage.local.set({ [key]: str });
    throw e; // re-throw so callers know sync failed
  }
}

async function syncGetLarge(key, defaultValue) {
  const storage = await getSettingsStorage();
  if (storage === chrome.storage.local) {
    const data = await chrome.storage.local.get({ [key]: defaultValue });
    return data[key];
  }
  // Sync storage: read chunked value
  const meta = await chrome.storage.sync.get(key);
  if (!meta[key] || !meta[key]._chunks) return defaultValue;
  const chunkKeys = Array.from({ length: meta[key]._chunks }, (_, i) => `${key}_${i}`);
  const chunks = await chrome.storage.sync.get(chunkKeys);
  let str = "";
  for (const k of chunkKeys) str += (chunks[k] || "");
  if (!str) return defaultValue;
  if (typeof defaultValue === "string") return str;
  try { return JSON.parse(str); } catch (_) { return defaultValue; }
}

const API_KEY_FIELDS = ["pinboardToken","geminiApiKey","openaiApiKey","claudeApiKey","deepseekApiKey","qwenApiKey","minimaxApiKey","openrouterApiKey","groqApiKey","mistralApiKey","cohereApiKey","siliconflowApiKey","zhipuApiKey","kimiApiKey","customApiKey","jinaApiKey"];

function deobfuscateSettings(s) {
  API_KEY_FIELDS.forEach(k => { if (s[k]) s[k] = deobfuscateKey(s[k]); });
  return s;
}

// ---- DOM cache helper (P1.6) ----
// Popup/options DOM is static — elements never removed, only toggled via classList.
// Memoize getElementById to avoid repeated DOM tree walks on hot paths.
// null results are NOT cached (lets later queries succeed if element is added).
const _domRefs = {};
function $id(id) {
  const cached = _domRefs[id];
  if (cached) return cached;
  const el = document.getElementById(id);
  if (el) _domRefs[id] = el;
  return el;
}

// Render an inline .confirm-popover anchored inside `anchor`.
// Caller supplies pre-translated strings via { msg, yesText, noText }.
// Popover self-dismisses on Escape / Cancel / Confirm; de-dupes if already open.
function showConfirmPopover(anchor, opts) {
  if (!anchor || anchor.querySelector(".confirm-popover")) return;
  const { msg, yesText, noText, onConfirm, onCancel } = opts || {};
  const pop = document.createElement("div");
  pop.className = "confirm-popover";
  const m = document.createElement("span");
  m.className = "confirm-msg";
  m.textContent = msg || "";
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "confirm-yes";
  yes.textContent = yesText || "OK";
  const no = document.createElement("button");
  no.type = "button";
  no.className = "confirm-no";
  no.textContent = noText || "Cancel";
  pop.append(m, yes, no);
  anchor.appendChild(pop);

  function dismiss() {
    pop.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(ev) {
    if (ev.key === "Escape") { dismiss(); if (onCancel) onCancel(); }
  }
  pop.addEventListener("click", (e) => e.stopPropagation());
  no.addEventListener("click", () => { dismiss(); if (onCancel) onCancel(); });
  yes.addEventListener("click", () => { dismiss(); if (onConfirm) onConfirm(); });
  document.addEventListener("keydown", onKey);
  no.focus();
}

// ===================== Feedback Card (B2) =====================
function showFeedback({ variant = "info", title = "", message = "", messageNode = null, actions = [], details = "", autoHide = 0, target } = {}) {
  const card = document.createElement("div");
  card.className = "feedback-card";
  card.dataset.variant = variant;
  card.setAttribute("role", variant === "error" || variant === "warning" ? "alert" : "status");
  card.setAttribute("aria-live", "polite");

  const icon = document.createElement("span");
  icon.className = "fc-icon";
  // All variants use inline SVG — literal ⚠ / ✓ / ℹ glyphs fall back to Segoe UI Emoji
  // on Windows and stall ~1.6s on first paint. currentColor inherits the variant colour.
  icon.innerHTML = (variant === "error" || variant === "warning") ? PBP_ICONS.warning
    : variant === "success" ? PBP_ICONS.check
    : PBP_ICONS.info;
  card.appendChild(icon);

  const body = document.createElement("div");
  body.className = "fc-body";
  if (title) {
    const t = document.createElement("div");
    t.className = "fc-title"; t.textContent = title;
    body.appendChild(t);
  }
  if (messageNode) {
    const m = document.createElement("div");
    m.className = "fc-message";
    m.appendChild(messageNode);
    body.appendChild(m);
  } else if (message) {
    const m = document.createElement("div");
    m.className = "fc-message"; m.textContent = message;
    body.appendChild(m);
  }
  if (actions.length) {
    const actRow = document.createElement("div");
    actRow.className = "fc-actions";
    actions.forEach(({ label, onClick, secondary }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = secondary ? "fc-btn-secondary" : "fc-btn";
      btn.textContent = label;
      btn.addEventListener("click", () => onClick?.(card));
      actRow.appendChild(btn);
    });
    body.appendChild(actRow);
  }
  if (details) {
    const pre = document.createElement("pre");
    pre.className = "fc-details";
    pre.textContent = details;
    body.appendChild(pre);
  }
  card.appendChild(body);

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "fc-dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "×";
  let dismissed = false;
  const remove = () => {
    if (dismissed) return;
    dismissed = true;
    card.classList.add("dismissing");
    setTimeout(() => card.remove(), 120);
  };
  dismiss.addEventListener("click", remove);
  card.appendChild(dismiss);

  const mount = target || document.querySelector(".bottom-bar")?.parentElement || document.body;
  const beforeNode = target ? null : document.querySelector(".bottom-bar");
  if (beforeNode && beforeNode.parentElement === mount) {
    mount.insertBefore(card, beforeNode);
  } else {
    mount.appendChild(card);
  }

  if (autoHide > 0) setTimeout(remove, autoHide);

  return { dismiss: remove, element: card };
}

// ===================== URL Tracking Param Stripping (B4) =====================
const TRACKING_PARAMS_TIER1 = [
  "utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id",
  "gclid","gclsrc","dclid","gbraid","wbraid","fbclid","msclkid","yclid","ysclid","_openstat",
  "mc_cid","mc_eid","mkt_tok",
  "_hsenc","_hsmi","__hstc","__hssc","__hsfp","hsCtaTracking",
  "vero_id","vero_conv","oly_anon_id","oly_enc_id",
  "mtm_campaign","mtm_source","mtm_medium","mtm_keyword","mtm_content","mtm_cid",
  "pk_campaign","pk_source","pk_medium","pk_keyword",
  "__s","wickedid","rb_clickid","s_cid","twclid",
  "ml_subscriber","ml_subscriber_hash",
  "action_object_map","action_type_map","action_ref_map",
  "cjevent","cjdata","ir_campaignid","ir_adid","ir_partnerid",
];

const TRACKING_PARAMS_TIER2 = [
  "_ga","_gl","_branch_match_id","_branch_referrer","mc_tc","ICID","__twitter_impression",
  "at_campaign","at_medium","at_custom1","at_custom2","at_custom3","at_custom4",
  "hmb_campaign","hmb_source","hmb_medium","spm","_trkparms","_trksid",
];

const TRACKING_PARAMS_TIER3 = [
  "si","igshid","igsh","ref","ref_src","ref_url","source","feature",
];

const HOST_TRACKING_RULES = {
  "amazon": ["pd_rd_w","pd_rd_wg","pd_rd_r","pd_rd_p","pd_rd_i","pf_rd_p","pf_rd_r","pf_rd_s","pf_rd_t","pf_rd_i","pf_rd_m","_encoding","ref_","psc","qid","sr","srs","__mk_de_DE","__mk_en_US","spIA","smid","crid","keywords","sprefix"],
  "youtube.com": ["feature","kw","pp","si"],
  "youtu.be": ["feature","kw","pp","si"],
  "google":   ["ved","ei","gs_lp","gs_lcrp","gs_lcp","gs_ssp","gws_rd","sxsrf","sourceid","rlz","aqs","uact","oq","usg","sca_esv","sca_upv","iflsig","bih","biw","dpr"],
  "x.com":    ["s","t","cn","ref_src","ref_url","twclid"],
  "twitter.com": ["s","t","cn","ref_src","ref_url","twclid"],
  "linkedin.com": ["trk","trackingId","refId","lipi","midToken","midSig","eBP","lgCta","recommendedFlavor"],
  "facebook.com": ["__tn__","__xts__","__cft__","eid","comment_tracking","dti","app","ls_ref","action_history"],
  "bing.com": ["cvid","qs","qp","sk","sp","sc","form","pq"],
  "aliexpress": ["ws_ab_test","algo_expid","algo_pvid","btsid","scm","scm_id","scm-url","aff_trace_key","aff_platform","aff_request_id","spm"],
  "tiktok.com": ["_d","_t","_r","is_copy_url","is_from_webapp","sender_device","share_app_id","share_link_id","u_code","preview_pb"],
  "reddit.com": ["share_id","correlation_id","rdt","$deep_link","_branch_match_id","ref_campaign","ref_source"],
};

const OAUTH_PATH_RE = /\/(oauth|auth|callback|sso|saml|openid|signin-callback|login\/callback)/i;
const OAUTH_TOKEN_KEYS = new Set(["access_token","id_token","refresh_token","oauth_token","oauth_verifier"]);

function _matchHostRule(hostname) {
  const lower = hostname.toLowerCase();
  for (const key of Object.keys(HOST_TRACKING_RULES)) {
    if (lower === key || lower.endsWith("." + key) || lower.startsWith(key + ".") || lower.includes("." + key + ".")) {
      return HOST_TRACKING_RULES[key];
    }
  }
  return null;
}

function _isOAuthCallback(u) {
  if (OAUTH_PATH_RE.test(u.pathname)) return true;
  const params = u.searchParams;
  // Known false-negative: URLs like ?code=SAVE20&state=CA (promo + US state)
  // will skip cleaning. Accepted trade-off — protecting OAuth callbacks
  // is higher value than ensuring 100% cleanup on edge-case shopping URLs.
  if (params.has("code") && (params.has("state") || params.has("session_state"))) return true;
  for (const key of params.keys()) if (OAUTH_TOKEN_KEYS.has(key)) return true;
  if (u.hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return true;
  return false;
}

function stripTrackingParams(urlStr, settings = {}) {
  const {
    enabled = true,
    aggressiveMode = false,
    customParams = [],
    excludeParams = [],
  } = settings;
  const original = urlStr;
  if (!enabled) return { cleaned: urlStr, removedCount: 0, original };

  let u;
  try { u = new URL(urlStr); }
  catch { return { cleaned: urlStr, removedCount: 0, original }; }

  if (_isOAuthCallback(u)) return { cleaned: urlStr, removedCount: 0, original };

  const exclude = new Set(excludeParams.map(s => s.trim()).filter(Boolean));
  const toStrip = new Set([
    ...TRACKING_PARAMS_TIER1,
    ...TRACKING_PARAMS_TIER2,
    ...(aggressiveMode ? TRACKING_PARAMS_TIER3 : []),
    ...customParams.map(s => s.trim()).filter(Boolean),
  ]);
  const hostRule = _matchHostRule(u.hostname);
  if (hostRule) hostRule.forEach(p => toStrip.add(p));

  // Special-case Amazon `tag` preservation unless aggressive
  const hostLower = u.hostname.toLowerCase();
  const isAmazon = /(^|\.)amazon\./.test(hostLower);
  if (isAmazon && !aggressiveMode) exclude.add("tag");

  let removed = 0;
  for (const k of [...u.searchParams.keys()]) {
    if (exclude.has(k)) continue;
    let shouldStrip = toStrip.has(k);
    if (!shouldStrip && hostRule) {
      for (const rule of hostRule) {
        if (rule.endsWith("_") && k.startsWith(rule)) { shouldStrip = true; break; }
      }
    }
    if (shouldStrip) {
      u.searchParams.delete(k);
      removed++;
    }
  }

  let result = u.toString();
  if (u.search === "" && result.includes("?")) {
    result = result.replace(/\?(?=#|$)/, "");
  }

  return { cleaned: result, removedCount: removed, original };
}

// ===================== Empty State Illustrations (B8) =====================
const EMPTY_STATE_SVG = {
  bookmark: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`,
  tag: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
  spark: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"/><path d="M12 16v6"/><path d="M4.93 4.93l4.24 4.24"/><path d="M14.83 14.83l4.24 4.24"/><path d="M2 12h6"/><path d="M16 12h6"/><path d="M4.93 19.07l4.24-4.24"/><path d="M14.83 9.17l4.24-4.24"/></svg>`,
};

function _parseSvg(svgString) {
  const doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
  return doc.documentElement;
}

function injectEmptyState(container, svgKey, messageText) {
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  const wrap = document.createElement("div");
  wrap.className = "empty-state";
  const svgNode = _parseSvg(EMPTY_STATE_SVG[svgKey] || EMPTY_STATE_SVG.bookmark);
  wrap.appendChild(svgNode);
  const msg = document.createElement("div");
  msg.textContent = messageText;
  wrap.appendChild(msg);
  container.appendChild(wrap);
}
