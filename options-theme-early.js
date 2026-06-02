// ---- Mirror prefill: high-frequency UI fields ----
// Synchronously apply cached field values from localStorage so the form
// doesn't visibly jump from empty → populated. Async path below still
// fires and corrects via storage.get. Mirror TTL 7 days; stale data
// falls back to async path.
const _OPTIONS_MIRROR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
try {
  const raw = localStorage.getItem("pp-options-fields");
  if (raw) {
    const m = JSON.parse(raw);
    if (m && m.ts && (Date.now() - m.ts) < _OPTIONS_MIRROR_TTL_MS) {
      // Logged-in marker (controls panel visibility CSS)
      if (typeof m.loggedIn === "boolean") {
        document.documentElement.dataset.loggedIn = m.loggedIn ? "1" : "0";
      }
      // AI provider + notify checkboxes need DOM — apply on DOMContentLoaded
      document.addEventListener("DOMContentLoaded", () => {
        if (m.aiProvider) {
          const sel = document.getElementById("opt-ai-provider");
          if (sel) {
            const opt = sel.querySelector(`option[value="${m.aiProvider}"]`);
            if (opt) sel.value = m.aiProvider;
          }
        }
        if (m.notify && typeof m.notify === "object") {
          for (const [id, checked] of Object.entries(m.notify)) {
            const el = document.getElementById(id);
            if (el && el.type === "checkbox") el.checked = !!checked;
          }
        }
      }, { once: true });
    }
  }
} catch (_) {}

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
