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
  var MIRROR_KEY = "md-preview-theme";
  // Per-device reader override ("Aa" panel), written by md-preview.js.
  var SCHEME_KEY = "md-preview-scheme";
  // "Open video pages in dark" (mdVideoDarkScheme) mirror, written by
  // md-preview.js on its authoritative read and by Options on save.
  var VIDEO_KEY = "md-preview-video-dark";
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

  function apply(mode) {
    try {
      var r = resolve(mode);
      document.documentElement.style.colorScheme = r.colorScheme;
      var lightLink = document.getElementById(LIGHT_LINK_ID);
      var darkLink = document.getElementById(DARK_LINK_ID);
      if (lightLink) lightLink.media = r.lightMedia;
      if (darkLink) darkLink.media = r.darkMedia;
    } catch (_) { /* degrade: leave the system-following CSS default in place */ }
  }

  // 1) Synchronous localStorage mirrors -- instant, before first paint.
  try {
    apply(resolveReader(
      localStorage.getItem(SHARED_THEME_KEY) || localStorage.getItem(MIRROR_KEY) || "auto",
      localStorage.getItem(SCHEME_KEY) || "auto",
      localStorage.getItem(VIDEO_KEY) === "1"
    ));
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
  var _optSyncMirror = null;
  try { _optSyncMirror = localStorage.getItem("pp-sync-enabled"); } catch (_) {}

  var _firstHop;
  if (_optSyncMirror === "0") {
    _firstHop = chrome.storage.local
      .get({ pbp_color_scheme: "auto", optTheme: "auto", mdVideoDarkScheme: false })
      .then(function (l) {
        override = l.pbp_color_scheme || "auto";
        return l;
      });
  } else if (_optSyncMirror === "1") {
    _firstHop = Promise.all([
      chrome.storage.local.get({ pbp_color_scheme: "auto" }),
      chrome.storage.sync.get({ optTheme: "auto", mdVideoDarkScheme: false })
    ]).then(function (pair) {
      override = pair[0].pbp_color_scheme || "auto";
      return pair[1];
    });
  } else {
    _firstHop = chrome.storage.local.get({ optSyncEnabled: false, pbp_color_scheme: "auto" }).then(function (l) {
      override = l.pbp_color_scheme || "auto";
      return (l.optSyncEnabled ? chrome.storage.sync : chrome.storage.local).get({ optTheme: "auto", mdVideoDarkScheme: false });
    });
  }

  _firstHop.then(function (s) {
    var mode = s.optTheme || "auto";
    var videoDark = s.mdVideoDarkScheme === true;
    try {
      localStorage.setItem(MIRROR_KEY, mode);
      localStorage.setItem(SCHEME_KEY, override);
      localStorage.setItem(VIDEO_KEY, videoDark ? "1" : "0");
    } catch (_) {}
    apply(resolveReader(mode, override, videoDark));
  }).catch(function () { /* storage unavailable: localStorage mirrors already applied */ });
})();
