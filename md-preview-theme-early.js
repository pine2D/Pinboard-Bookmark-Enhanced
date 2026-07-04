// Anti-FOUC: applies optTheme (dark/light/auto) BEFORE first paint, mirroring
// popup-theme-early.js's localStorage-mirror technique. CSP for extension pages
// (script-src 'self') blocks inline scripts, so this must be its own file,
// loaded synchronously (no defer, see md-preview.html) right after the two hljs
// <link>s in <head> so they already exist in the DOM when this runs.
//
// The resolve()/apply() pair here is a deliberate, tiny duplicate of
// pbpResolveColorScheme/pbpApplyColorScheme in md-preview.js (spec section 2.3: the early
// script and the main switcher share the same apply-logic contract; a shared
// function between them is not required) -- this file must run standalone, before
// md-preview.js (deferred) has loaded, so it cannot call into it.
(function () {
  var LIGHT_LINK_ID = "hljs-light-link";
  var DARK_LINK_ID = "hljs-dark-link";
  var AUTO_LIGHT_MEDIA = "(prefers-color-scheme: light)";
  var AUTO_DARK_MEDIA = "(prefers-color-scheme: dark)";
  var MIRROR_KEY = "md-preview-theme";

  function resolve(mode) {
    if (mode === "dark") return { colorScheme: "dark", lightMedia: "not all", darkMedia: "all" };
    if (mode === "light") return { colorScheme: "light", lightMedia: "all", darkMedia: "not all" };
    return { colorScheme: "", lightMedia: AUTO_LIGHT_MEDIA, darkMedia: AUTO_DARK_MEDIA };
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

  // 1) Synchronous localStorage mirror -- instant, before first paint.
  try {
    apply(localStorage.getItem(MIRROR_KEY) || "auto");
  } catch (_) { /* localStorage unavailable (rare); CSS default (auto) already applies */ }

  // 2) Async source-of-truth read -- corrects the mirror if stale, seeds it on
  //    first run. Mirrors popup-theme-early.js's async tail exactly.
  if (typeof chrome === "undefined" || !chrome.storage) return;
  chrome.storage.local.get({ optSyncEnabled: false }).then(function (s) {
    return (s.optSyncEnabled ? chrome.storage.sync : chrome.storage.local).get({ optTheme: "auto" });
  }).then(function (s) {
    var mode = s.optTheme || "auto";
    try { localStorage.setItem(MIRROR_KEY, mode); } catch (_) {}
    apply(mode);
  }).catch(function () { /* storage unavailable: localStorage mirror already applied */ });
})();
