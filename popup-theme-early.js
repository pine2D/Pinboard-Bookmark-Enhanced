// Synchronous login-state hint via localStorage — sets html[data-section] BEFORE first paint
// so the correct top-level section (main vs login) is visible immediately, eliminating the
// flash where only quick-actions paints first. popup.js's showMain/showLogin maintains the
// localStorage mirror on login success / logout. Storage source of truth remains chrome.storage;
// this is just a fast-read mirror.
document.documentElement.dataset.section =
  localStorage.getItem("pp-logged-in") === "1" ? "main" : "login";

// Apply theme early to prevent FOUC (popup opens light → flashes to dark).
// Mirrors popup.js applyTheme(); shared.js not yet loaded — inline the map + selector.
const PBP_POPUP_ADAPTIVE_MAP = {
  flexoki: ["flexoki-light", "flexoki-dark"],
  solarized: ["solarized-light", "solarized-dark"],
  catppuccin: ["catppuccin-latte", "catppuccin-mocha"]
};

chrome.storage.local.get({ optSyncEnabled: false }).then(({ optSyncEnabled }) => {
  return (optSyncEnabled ? chrome.storage.sync : chrome.storage.local)
    .get({ optTheme: "auto", themePresetKey: "", optPopupFollowTheme: true, popupWidth: 520 });
}).then(s => {
  const prefersDark = s.optTheme === "dark" ||
    (s.optTheme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const key = s.optPopupFollowTheme !== false ? (s.themePresetKey || "") : "";

  if (PBP_POPUP_ADAPTIVE_MAP[key]) {
    const [light, dark] = PBP_POPUP_ADAPTIVE_MAP[key];
    document.documentElement.dataset.theme = prefersDark ? dark : light;
  } else if (key) {
    document.documentElement.dataset.theme = key;
  } else if (prefersDark) {
    document.documentElement.classList.add("dark");
  }

  const w = Math.max(420, Math.min(720, Number(s.popupWidth) || 520));
  document.documentElement.style.setProperty("--pp-popup-width", w + "px");
}).catch(() => { /* storage unavailable: leave default styling, popup.js will apply on full load */ });
