// Apply theme early to prevent flash (MV3 requires external script, no inline)
// shared.js not yet loaded here — inline storage selector
chrome.storage.local.get({ optSyncEnabled: false }).then(({ optSyncEnabled }) => {
  return (optSyncEnabled ? chrome.storage.sync : chrome.storage.local)
    .get({ optTheme: "auto", themePresetKey: "" });
}).then(s => {
  const prefersDark = s.optTheme === "dark" ||
    (s.optTheme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  if (s.themePresetKey === "flexoki") {
    // Flexoki Adaptive: pick light or dark based on user preference
    document.documentElement.dataset.theme = prefersDark ? "flexoki-dark" : "flexoki-light";
  } else if (s.themePresetKey) {
    document.documentElement.dataset.theme = s.themePresetKey;
  } else if (prefersDark) {
    // No preset selected — fall back to Flexoki Dark for dark mode preference
    document.documentElement.dataset.theme = "flexoki-dark";
  }
});
