// All synchronous reads from localStorage mirror — applied BEFORE first paint to prevent
// FOUC: section flash (main vs login), theme flash (light borders in dark mode), width jump.
// chrome.storage is the source of truth; this file's async tail writes the mirror so the
// NEXT popup open is fast.
const PBP_POPUP_ADAPTIVE_MAP = {
  flexoki: ["flexoki-light", "flexoki-dark"],
  solarized: ["solarized-light", "solarized-dark"],
  catppuccin: ["catppuccin-latte", "catppuccin-mocha"]
};

// Mirrors shared.js pbpBookmarkServiceId(): this file runs before shared.js.
const PBP_POPUP_BOOKMARK_SERVICES = ["pinboard", "karakeep", "linkding"];

(function applyFromLocalStorageMirror() {
  const root = document.documentElement;

  // Section visibility (main vs login)
  root.dataset.section = localStorage.getItem("pp-logged-in") === "1" ? "main" : "login";

  // Bookmark service: linkding's Description row widens the label column in
  // some languages (popup.css html[data-bookmark-service=...]). Set before
  // first paint so the fields never jump from wide to narrow.
  const service = localStorage.getItem("pp-bookmark-service");
  if (PBP_POPUP_BOOKMARK_SERVICES.includes(service)) root.dataset.bookmarkService = service;

  // Popup width
  const w = Number(localStorage.getItem("pp-popup-width")) || 550;
  root.style.setProperty("--pp-popup-width", Math.max(420, Math.min(720, w)) + "px");

  // Theme: dark class or data-theme based on stored mode + preset + system preference
  const mode = localStorage.getItem("pp-theme") || "auto";
  const preset = localStorage.getItem("pp-theme-preset") || "";
  const followTheme = localStorage.getItem("pp-theme-follow") !== "0"; // default true
  const prefersDark = mode === "dark" ||
    (mode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const key = followTheme ? preset : "";

  if (PBP_POPUP_ADAPTIVE_MAP[key]) {
    root.dataset.theme = prefersDark ? PBP_POPUP_ADAPTIVE_MAP[key][1] : PBP_POPUP_ADAPTIVE_MAP[key][0];
  } else if (key) {
    root.dataset.theme = key;
  } else if (prefersDark) {
    // No-preset dark resolves to the flexoki-dark preset, the same fallback
    // Options / Library (options-theme-early.js) and the reader's own dark
    // palette use -- one warm-neutral dark across all four surfaces (theme
    // model 2026-08-25, batch 2 D6). popup.css carries no html.dark layer
    // any more (retired with this switch).
    root.dataset.theme = "flexoki-dark";
  }
})();

// Shortcut hints (impeccable critique 2026-10-15): the four keyboard hints
// (Shift+Enter, Alt+1-9, Alt+P/R/A, Ctrl+Enter) stay up for the first ten
// popup opens so a new user can learn them; after that they show only while
// Alt is held (popup.js toggles .pp-kbd-show). Decided here, before first
// paint, so a returning user never sees them flash in and drop out. Counted
// on the bookmark form only -- the login screen shows none of them.
(function applyKbdHintLearning() {
  const PBP_KBD_LEARN_OPENS = 10;
  try {
    if (document.documentElement.dataset.section !== "main") return;
    const opens = Number(localStorage.getItem("pp-kbd-hint-opens")) || 0;
    if (opens >= PBP_KBD_LEARN_OPENS) return;
    localStorage.setItem("pp-kbd-hint-opens", String(opens + 1));
    document.documentElement.classList.add("pp-kbd-learn");
  } catch (_) { /* storage blocked: hints stay behind Alt */ }
})();

// B4: tab data prefill — populate only public URL/title fields.
//     synchronously from the last-known tab. popup.js will validate against
//     chrome.storage.session asynchronously and clear stale prefill if mismatched.
//     Account-specific bookmark state is always resolved by the background lookup.
(function applyTabMirror() {
  const _TAB_MIRROR_TTL_MS = 10 * 60 * 1000;
  try {
    const raw = localStorage.getItem("pp-last-tab");
    if (!raw) return;
    const m = JSON.parse(raw);
    if (!m || !m.ts || (Date.now() - m.ts) >= _TAB_MIRROR_TTL_MS || !m.url) return;
    document.addEventListener("DOMContentLoaded", () => {
      const u = document.getElementById("url-input");
      const ti = document.getElementById("title-input");
      if (u && !u.value) u.value = m.url;
      if (ti && !ti.value) ti.value = m.title || "";
    }, { once: true });
  } catch (_) {}
})();

// Async source-of-truth read — corrects mirror if stale, populates on first run.
// The optSyncEnabled hop below has its own localStorage mirror ("pp-sync-enabled",
// written by shared.js on every authoritative settings read/write -- see
// getSettingsStorage() and pbpReadSettingsWithSecrets()). A hit lets the two-hop
// chain collapse into one: the area for the theme-keys read is chosen straight
// from the mirror instead of waiting on a chrome.storage.local IPC round trip
// first. A miss (first run, cleared site data, private mode) falls back to the
// original two-hop chain unchanged.
let _optSyncMirror = null;
try { _optSyncMirror = localStorage.getItem("pp-sync-enabled"); } catch (_) {}
// The service this device uses is bookmarkServiceActive, always in local; the
// settings-area bookmarkService is only the chosen one (shared.js
// PBP_BOOKMARK_ACTIVE_KEY). Both ride on a local read the chain already makes,
// so no hop is added: the first hop of a mirror miss, or the one read of a
// sync-off device. A sync-on device with a mirror makes no local read here and
// leaves the attribute to the mirror and popup.js.
(_optSyncMirror === "1" || _optSyncMirror === "0"
  ? Promise.resolve({ optSyncEnabled: _optSyncMirror === "1" })
  : chrome.storage.local.get({ optSyncEnabled: false, bookmarkServiceActive: "" })
).then(({ optSyncEnabled, bookmarkServiceActive }) => {
  return (optSyncEnabled ? chrome.storage.sync : chrome.storage.local)
    .get({ optTheme: "auto", themePresetKey: "", optPopupFollowTheme: true, popupWidth: 550,
      ...(optSyncEnabled ? {} : { bookmarkService: "pinboard", bookmarkServiceActive: "" }) })
    .then(s => {
      const active = bookmarkServiceActive || s.bookmarkServiceActive;
      // A missing device key (an older release) falls back to the chosen
      // service, which that release used: readable here only from local.
      return { ...s, bookmarkService: PBP_POPUP_BOOKMARK_SERVICES.includes(active) ? active
        : optSyncEnabled ? undefined : s.bookmarkService };
    });
}).then(s => {
  // Update localStorage mirror for next popup boot
  try {
    localStorage.setItem("pp-theme", s.optTheme || "auto");
    localStorage.setItem("pp-theme-preset", s.themePresetKey || "");
    localStorage.setItem("pp-theme-follow", s.optPopupFollowTheme === false ? "0" : "1");
    localStorage.setItem("pp-popup-width", String(s.popupWidth || 550));
  } catch (_) {}
  if (s.bookmarkService !== undefined) pbpPopupApplyBookmarkService(s.bookmarkService);

  // Re-apply in case the mirror was stale. Compute the target first and write
  // ONLY on a real difference: the old delete-then-reset invalidated every
  // :root[data-theme=...] rule and forced a full-document style recalc even
  // when the mirror was already correct (the common case), right in the
  // cold-first-paint window.
  const root = document.documentElement;
  const prefersDark = s.optTheme === "dark" ||
    (s.optTheme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const key = s.optPopupFollowTheme !== false ? (s.themePresetKey || "") : "";

  let target = "";
  if (PBP_POPUP_ADAPTIVE_MAP[key]) {
    target = prefersDark ? PBP_POPUP_ADAPTIVE_MAP[key][1] : PBP_POPUP_ADAPTIVE_MAP[key][0];
  } else if (key) {
    target = key;
  } else if (prefersDark) {
    // No-preset dark resolves to the flexoki-dark preset, the same fallback
    // Options / Library (options-theme-early.js) and the reader's own dark
    // palette use -- one warm-neutral dark across all four surfaces (theme
    // model 2026-08-25, batch 2 D6). popup.css carries no html.dark layer
    // any more (retired with this switch).
    target = "flexoki-dark";
  }
  if (target) {
    if (root.dataset.theme !== target) root.dataset.theme = target;
  } else if ("theme" in root.dataset) {
    delete root.dataset.theme;
  }

  const w = Math.max(420, Math.min(720, Number(s.popupWidth) || 550));
  root.style.setProperty("--pp-popup-width", w + "px");
}).catch(() => { /* storage unavailable: localStorage mirror already applied */ });

// The bookmark service attribute and its mirror, from the service this device uses.
// popup.js calls it too, with the settings it renders the form from.
function pbpPopupApplyBookmarkService(value) {
  const service = PBP_POPUP_BOOKMARK_SERVICES.includes(value) ? value : "";
  const root = document.documentElement;
  if (service) {
    if (root.dataset.bookmarkService !== service) root.dataset.bookmarkService = service;
  } else if ("bookmarkService" in root.dataset) {
    delete root.dataset.bookmarkService;
  }
  try {
    if (service) localStorage.setItem("pp-bookmark-service", service);
    else localStorage.removeItem("pp-bookmark-service");
  } catch (_) {}
}
