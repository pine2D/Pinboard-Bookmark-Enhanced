// ============================================================
// Pinboard Bookmark Enhanced - i18n Helper
// ============================================================

let _i18nMessages = null;
let _i18nReady = false;

/**
 * Synchronously populate _i18nMessages from localStorage mirror (if user
 * set manual language). Auto-mode users hit chrome.i18n.getMessage which
 * is already synchronous, so no mirror is needed for them. Then kicks off
 * an async refresh that updates the mirror and re-applies translations if
 * data changed.
 *
 * Signature is callable as both sync (returns undefined) and via `await`
 * (await on non-Promise resolves immediately) — preserves call sites in
 * popup.js / options.js / background.js that do `await initI18n();`.
 */
function initI18n() {
  if (_i18nReady) {
    _refreshI18nAsync().catch(() => {});
    return;
  }
  // Sync mirror apply
  try {
    const lang = localStorage.getItem("pp-i18n-lang");
    if (lang && lang !== "auto") {
      const msgs = localStorage.getItem("pp-i18n-msgs");
      if (msgs) {
        try { _i18nMessages = JSON.parse(msgs); } catch (_) {}
      }
    }
  } catch (_) {}
  _i18nReady = true;
  // Async refresh (fire-and-forget)
  _refreshI18nAsync().catch(() => {});
}

/**
 * Async refresh: read latest optLang from storage, fetch locale messages
 * if needed, update localStorage mirror + _i18nMessages, re-apply
 * translations if anything changed.
 */
async function _refreshI18nAsync() {
  try {
    const _storage = typeof getSettingsStorage === "function"
      ? await getSettingsStorage()
      : chrome.storage.local;
    const { optLang = "auto" } = await _storage.get({ optLang: "auto" });

    const prevLang = (typeof localStorage !== "undefined" ? localStorage.getItem("pp-i18n-lang") : null) || "auto";

    if (optLang === "auto") {
      try {
        localStorage.setItem("pp-i18n-lang", "auto");
        localStorage.removeItem("pp-i18n-msgs");
      } catch (_) {}
      const changed = _i18nMessages !== null;
      if (changed) {
        _i18nMessages = null;
        if (typeof applyI18n === "function") applyI18n();
      }
      return;
    }

    // Manual language: fetch locale messages
    const url = chrome.runtime.getURL(`_locales/${optLang}/messages.json`);
    const resp = await fetch(url);
    if (!resp.ok) return;
    const msgs = await resp.json();

    try {
      localStorage.setItem("pp-i18n-lang", optLang);
      localStorage.setItem("pp-i18n-msgs", JSON.stringify(msgs));
    } catch (_) {
      // localStorage may be full or unavailable (e.g. SW context); proceed without mirror
    }

    // Re-apply not only on a language switch but also when the fetched messages
    // DIFFER from what we applied at boot (the sync localStorage mirror can be stale
    // after any messages.json edit — new/changed keys would otherwise render via the
    // chrome.i18n default-locale fallback, e.g. English, until the next open).
    const changed = prevLang !== optLang || _i18nMessages === null
      || JSON.stringify(_i18nMessages) !== JSON.stringify(msgs);
    _i18nMessages = msgs;
    if (changed && typeof applyI18n === "function") applyI18n();
  } catch (e) {
    console.warn("[i18n] async refresh failed:", e?.message || e);
  }
}

/**
 * Resolve a message entry's placeholders with provided arguments.
 */
function _resolveMsg(entry, args) {
  let msg = entry.message;
  if (!msg) return "";
  if (entry.placeholders && args.length) {
    for (const [name, def] of Object.entries(entry.placeholders)) {
      const m = (def.content || "").match(/^\$(\d+)$/);
      if (m) {
        const idx = parseInt(m[1]) - 1;
        if (idx >= 0 && idx < args.length) {
          msg = msg.replace(new RegExp("\\$" + name + "\\$", "gi"), args[idx]);
        }
      }
    }
  }
  return msg;
}

/**
 * Shorthand for chrome.i18n.getMessage with placeholder support.
 * When a manual language is loaded (via mirror or async refresh), uses
 * that; otherwise falls back to chrome.i18n.getMessage (browser locale).
 * Usage: t("key") or t("key", "arg1", "arg2")
 */
function t(key, ...args) {
  if (_i18nMessages && _i18nMessages[key]) {
    return _resolveMsg(_i18nMessages[key], args) || key;
  }
  const msg = chrome.i18n.getMessage(key, args.length ? args : undefined);
  return msg || key;
}

/**
 * Apply translations to all elements with data-i18n attributes.
 * Supports:
 *   data-i18n="key"               → textContent
 *   data-i18n-placeholder="key"   → placeholder attribute
 *   data-i18n-title="key"         → title attribute
 *   data-i18n-aria="key"          → aria-label attribute
 *
 * Note: All translations are applied as plain text (textContent)
 * to prevent XSS. No innerHTML injection is used.
 */
function applyI18n(root) {
  root = root || document;

  // P1.5: Merged 4 separate querySelectorAll passes into 1 DOM walk.
  root.querySelectorAll("[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria]").forEach(el => {
    const k1 = el.getAttribute("data-i18n");
    if (k1) el.textContent = t(k1);
    const k2 = el.getAttribute("data-i18n-placeholder");
    if (k2) el.placeholder = t(k2);
    const k3 = el.getAttribute("data-i18n-title");
    if (k3) el.title = t(k3);
    const k4 = el.getAttribute("data-i18n-aria");
    if (k4) el.setAttribute("aria-label", t(k4));
  });
}
