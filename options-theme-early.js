// Synchronous theme mirror + stable first-frame gate. chrome.storage remains
// authoritative and corrects the mirror asynchronously below.
const PBP_OPTIONS_ADAPTIVE_MAP = {
  flexoki: ["flexoki-light", "flexoki-dark"],
  solarized: ["solarized-light", "solarized-dark"],
  catppuccin: ["catppuccin-latte", "catppuccin-mocha"]
};

const _optionsRoot = document.documentElement;
setTimeout(() => {
  if (!_optionsRoot.dataset.optionsReady) _optionsRoot.dataset.optionsReady = "fallback";
}, 3000);

function pbpApplyOptionsEarlyTheme(mode, presetKey) {
  delete _optionsRoot.dataset.theme;
  const prefersDark = mode === "dark" ||
    (mode === "auto" && typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  if (Object.prototype.hasOwnProperty.call(PBP_OPTIONS_ADAPTIVE_MAP, presetKey)) {
    const [light, dark] = PBP_OPTIONS_ADAPTIVE_MAP[presetKey];
    _optionsRoot.dataset.theme = prefersDark ? dark : light;
  } else if (presetKey) {
    _optionsRoot.dataset.theme = presetKey;
  } else if (prefersDark) {
    _optionsRoot.dataset.theme = "flexoki-dark";
  }
}

function pbpStoreOptionsThemeMirror(mode, presetKey) {
  try {
    localStorage.setItem("pp-theme", mode || "auto");
    localStorage.setItem("pp-theme-preset", presetKey || "");
  } catch (_) {}
}

let _optionsMirrorMode = "auto";
let _optionsMirrorPreset = "";
try {
  _optionsMirrorMode = localStorage.getItem("pp-theme") || "auto";
  _optionsMirrorPreset = localStorage.getItem("pp-theme-preset") || "";
} catch (_) {}
pbpApplyOptionsEarlyTheme(_optionsMirrorMode, _optionsMirrorPreset);

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

// Async source-of-truth read — corrects and seeds the mirror for future opens.
if (typeof chrome !== "undefined" && chrome.storage?.local) {
  chrome.storage.local.get({ optSyncEnabled: false }).then(({ optSyncEnabled }) => {
    return (optSyncEnabled ? chrome.storage.sync : chrome.storage.local)
      .get({ optTheme: "auto", themePresetKey: "" });
  }).then(s => {
    const mode = s.optTheme || "auto";
    const presetKey = s.themePresetKey || "";
    pbpStoreOptionsThemeMirror(mode, presetKey);
    pbpApplyOptionsEarlyTheme(mode, presetKey);
  }).catch(() => { /* storage unavailable: localStorage mirror already applied */ });
}
