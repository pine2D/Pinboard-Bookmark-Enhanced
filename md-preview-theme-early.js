// Anti-FOUC: applies the reader's light/dark scheme BEFORE first paint,
// mirroring popup-theme-early.js's localStorage-mirror technique. CSP for
// extension pages (script-src 'self') blocks inline scripts, so this must be
// its own file, loaded synchronously (no defer, see md-preview.html) right
// after the two hljs <link>s in <head> so they already exist in the DOM when
// this runs.
//
// The resolve()/apply() pair here is a deliberate, tiny duplicate of
// pbpResolveColorScheme/pbpApplyColorScheme in md-preview.js, and
// resolveReader() of pbpResolveReaderScheme (spec section 2.3: the early
// script and the main switcher share the same apply-logic contract; a shared
// function between them is not required) -- this file must run standalone,
// before md-preview.js (deferred) has loaded, so it cannot call into it.
(function () {
  var LIGHT_LINK_ID = "hljs-light-link";
  var DARK_LINK_ID = "hljs-dark-link";
  var AUTO_LIGHT_MEDIA = "(prefers-color-scheme: light)";
  var AUTO_DARK_MEDIA = "(prefers-color-scheme: dark)";
  // optTheme mirrors: "pp-theme" is written by Options and the popup on
  // every save, so it is fresh after a settings change even when no reader
  // has been opened since (settings batch D2); this script's own key is the
  // fallback for a profile where neither page has run yet.
  var SHARED_THEME_KEY = "pp-theme";
  var SHARED_PRESET_KEY = "pp-theme-preset";
  var SHARED_FOLLOW_KEY = "pp-theme-follow";
  var MIRROR_KEY = "md-preview-theme";
  // Per-device reader override ("Aa" panel), written by md-preview.js.
  var SCHEME_KEY = "md-preview-scheme";
  // "Open video pages in dark" (mdVideoDarkScheme) mirror, written by
  // md-preview.js on its authoritative read and by Options on save.
  var VIDEO_KEY = "md-preview-video-dark";
  // Per-device reading column width (pbp_zen_width: 720 / 880 / 1080) mirror,
  // applied on :root before first paint so .doc-body never paints at 720px and
  // jumps wider once deferred md-preview.js finishes its async storage reads.
  var WIDTH_KEY = "md-preview-width";
  // The opener marks video pages in the URL (popup.js / background.js
  // append video=1) so the video default can be honoured before the payload
  // is read; md-preview.js still decides video-mode from the payload itself.
  var videoMode = /(?:^|[?&])video=1(?:&|$)/.test(location.search);

  function resolve(mode) {
    if (mode === "dark") return { colorScheme: "dark", lightMedia: "not all", darkMedia: "all" };
    if (mode === "light") return { colorScheme: "light", lightMedia: "all", darkMedia: "not all" };
    return { colorScheme: "", lightMedia: AUTO_LIGHT_MEDIA, darkMedia: AUTO_DARK_MEDIA };
  }

  // Twin of pbpResolveReaderScheme (md-preview.js): override > video default
  // (video pages only) > optTheme; unknown values normalise to auto / follow.
  function resolveReader(optTheme, override, videoDark) {
    if (override === "light" || override === "dark") return override;
    if (videoMode && videoDark) return "dark";
    return optTheme === "light" || optTheme === "dark" ? optTheme : "auto";
  }

  // Twin of pbpResolveReaderChrome (md-preview.js): Platinum is the only preset
  // that styles the reader as a windowed Mac OS 9 document reader while
  // "Extension pages follow the Pinboard theme preset" is enabled.
  function resolveChrome(presetKey, follow) {
    return follow !== false && presetKey === "platinum" ? "platinum" : "";
  }

  function applyWidth(rawWidth) {
    try {
      var root = document.documentElement;
      if (!root || !root.style || typeof root.style.setProperty !== "function") return;
      var w = Number(rawWidth);
      if (w === 880 || w === 1080) {
        root.style.setProperty("--pbp-width", w + "px");
      } else if (typeof root.style.removeProperty === "function") {
        root.style.removeProperty("--pbp-width");
      }
    } catch (_) { /* swallow-ok: pre-paint width mirror is best-effort */ }
  }

  function apply(mode, chromeTheme) {
    try {
      var r = resolve(mode);
      var root = document.documentElement;
      root.style.colorScheme = r.colorScheme;
      if (root.dataset) {
        if (chromeTheme) {
          if (root.dataset.readerTheme !== chromeTheme) root.dataset.readerTheme = chromeTheme;
        } else if ("readerTheme" in root.dataset) {
          delete root.dataset.readerTheme;
        }
      }
      var lightLink = document.getElementById(LIGHT_LINK_ID);
      var darkLink = document.getElementById(DARK_LINK_ID);
      if (lightLink) lightLink.media = r.lightMedia;
      if (darkLink) darkLink.media = r.darkMedia;
    } catch (_) { /* degrade: leave the system-following CSS default in place */ }
  }

  // 1) Synchronous localStorage mirrors -- instant, before first paint.
  try {
    apply(
      resolveReader(
        localStorage.getItem(SHARED_THEME_KEY) || localStorage.getItem(MIRROR_KEY) || "auto",
        localStorage.getItem(SCHEME_KEY) || "auto",
        localStorage.getItem(VIDEO_KEY) === "1"
      ),
      resolveChrome(
        localStorage.getItem(SHARED_PRESET_KEY) || "",
        localStorage.getItem(SHARED_FOLLOW_KEY) !== "0"
      )
    );
    applyWidth(localStorage.getItem(WIDTH_KEY));
  } catch (_) { /* localStorage unavailable (rare); CSS default (auto) already applies */ }

  // 2) Async source-of-truth read -- corrects the mirrors if stale, seeds them
  //    on first run. Mirrors popup-theme-early.js's async tail exactly, plus
  //    the same one-hop merge: "pp-sync-enabled" is the localStorage mirror
  //    shared.js writes on every authoritative settings read/write. Unlike
  //    popup's hop, this file's first read also needs pbp_color_scheme (a
  //    local-only, never-synced key), so the merge has two shapes:
  //      - mirror "0" (local): pbp_color_scheme and the theme keys are both
  //        local-only, so they fold into ONE chrome.storage.local.get call --
  //        a true single hop.
  //      - mirror "1" (sync): the theme keys live in a different area than
  //        pbp_color_scheme, so both reads fire CONCURRENTLY via Promise.all
  //        instead of the local.get({optSyncEnabled}) round trip gating the
  //        area read first -- one round trip's worth of latency instead of
  //        two in series.
  //    A mirror miss (first run, cleared site data) falls back to the
  //    original two-hop chain unchanged.
  if (typeof chrome === "undefined" || !chrome.storage) return;
  var override = "auto";
  var zenWidth = 720;
  var _optSyncMirror = null;
  try { _optSyncMirror = localStorage.getItem("pp-sync-enabled"); } catch (_) {}

  var _settingsDefaults = { optTheme: "auto", mdVideoDarkScheme: false, themePresetKey: "", optPopupFollowTheme: true };
  var _firstHop;
  if (_optSyncMirror === "0") {
    _firstHop = chrome.storage.local
      .get({ pbp_color_scheme: "auto", pbp_zen_width: 720, optTheme: "auto", mdVideoDarkScheme: false, themePresetKey: "", optPopupFollowTheme: true })
      .then(function (l) {
        override = l.pbp_color_scheme || "auto";
        zenWidth = (l.pbp_zen_width === 880 || l.pbp_zen_width === 1080) ? l.pbp_zen_width : 720;
        return l;
      });
  } else if (_optSyncMirror === "1") {
    _firstHop = Promise.all([
      chrome.storage.local.get({ pbp_color_scheme: "auto", pbp_zen_width: 720 }),
      chrome.storage.sync.get(_settingsDefaults)
    ]).then(function (pair) {
      override = pair[0].pbp_color_scheme || "auto";
      zenWidth = (pair[0].pbp_zen_width === 880 || pair[0].pbp_zen_width === 1080) ? pair[0].pbp_zen_width : 720;
      return pair[1];
    });
  } else {
    _firstHop = chrome.storage.local.get({ optSyncEnabled: false, pbp_color_scheme: "auto", pbp_zen_width: 720 }).then(function (l) {
      override = l.pbp_color_scheme || "auto";
      zenWidth = (l.pbp_zen_width === 880 || l.pbp_zen_width === 1080) ? l.pbp_zen_width : 720;
      return (l.optSyncEnabled ? chrome.storage.sync : chrome.storage.local).get(_settingsDefaults);
    });
  }

  _firstHop.then(function (s) {
    var mode = s.optTheme || "auto";
    var videoDark = s.mdVideoDarkScheme === true;
    var presetKey = s.themePresetKey || "";
    var follow = s.optPopupFollowTheme !== false;
    try {
      localStorage.setItem(MIRROR_KEY, mode);
      localStorage.setItem(SCHEME_KEY, override);
      localStorage.setItem(VIDEO_KEY, videoDark ? "1" : "0");
      localStorage.setItem(SHARED_PRESET_KEY, presetKey);
      localStorage.setItem(SHARED_FOLLOW_KEY, follow ? "1" : "0");
      localStorage.setItem(WIDTH_KEY, String(zenWidth));
    } catch (_) {}
    apply(resolveReader(mode, override, videoDark), resolveChrome(presetKey, follow));
    applyWidth(zenWidth);
  }).catch(function () { /* storage unavailable: localStorage mirrors already applied */ });
})();
