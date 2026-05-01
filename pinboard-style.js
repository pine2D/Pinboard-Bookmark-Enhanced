// ============================================================
// Pinboard Bookmark Enhanced - Custom Style Injector
// Content script for pinboard.in pages (runs at document_start)
//
// Schema v2 (2026-05-01):
//   themePresetKey   → string, looks up CSS from PINBOARD_THEMES (loaded above)
//   customOverlayCSS → user's tweak CSS, appended after preset (CSS later wins)
//   optOverlayInLocal → flag: overlay exceeded sync quota, lives in local
// ============================================================

// Adaptive theme map (mirrors shared.js — content scripts can't import it)
const PBP_ADAPTIVE_THEME_MAP = {
  flexoki: ["flexoki-light", "flexoki-dark"],
  solarized: ["solarized-light", "solarized-dark"],
  catppuccin: ["catppuccin-latte", "catppuccin-mocha"]
};

// Immediately hide page to prevent FOUC while loading custom theme
const _pbpCloak = document.createElement("style");
_pbpCloak.id = "pbp-cloak";
_pbpCloak.textContent = "html { opacity: 0 !important; }";
(document.head || document.documentElement).appendChild(_pbpCloak);

(async () => {
  // Inline storage selector (shared.js not available in content scripts)
  async function getStorage() {
    const { optSyncEnabled } = await chrome.storage.local.get({ optSyncEnabled: false });
    return optSyncEnabled ? chrome.storage.sync : chrome.storage.local;
  }

  // Read large value — chunked from sync, direct from local
  async function readChunkedSync(key, defaultValue) {
    const storage = await getStorage();
    if (storage === chrome.storage.local) {
      const data = await chrome.storage.local.get({ [key]: defaultValue });
      return data[key];
    }
    const meta = await chrome.storage.sync.get(key);
    if (!meta[key] || !meta[key]._chunks) return defaultValue;
    const chunkKeys = Array.from({ length: meta[key]._chunks }, (_, i) => `${key}_${i}`);
    const chunks = await chrome.storage.sync.get(chunkKeys);
    let str = "";
    for (const k of chunkKeys) str += (chunks[k] || "");
    return str || defaultValue;
  }

  function uncloak() {
    const el = document.getElementById("pbp-cloak");
    if (el) el.remove();
  }

  // Safety: always uncloak after 800ms even if something fails
  setTimeout(uncloak, 800);

  try {
    const storage = await getStorage();
    const data = await storage.get({
      customFont: "",
      optTheme: "auto",
      themePresetKey: "",
    });

    // Overlay may live in sync (chunked) or local fallback (when sync quota hit)
    const { optOverlayInLocal } = await chrome.storage.sync.get({ optOverlayInLocal: false });
    let overlay = "";
    if (optOverlayInLocal) {
      const local = await chrome.storage.local.get({ customOverlayCSS_localFallback: "" });
      overlay = local.customOverlayCSS_localFallback;
    } else {
      overlay = await readChunkedSync("customOverlayCSS", "");
    }

    // Inject pbp-dark class based on extension theme setting
    const isDark = data.optTheme === "dark" ||
      (data.optTheme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("pbp-dark", isDark);

    // Resolve preset CSS from PINBOARD_THEMES (loaded above us as content script)
    let presetCss = "";
    if (data.themePresetKey && typeof PINBOARD_THEMES !== "undefined") {
      // Adaptive themes resolve to light/dark variant based on current mode
      let themeKey = data.themePresetKey;
      if (PBP_ADAPTIVE_THEME_MAP[themeKey]) {
        themeKey = PBP_ADAPTIVE_THEME_MAP[themeKey][isDark ? 1 : 0];
      }
      if (PINBOARD_THEMES[themeKey]) presetCss = PINBOARD_THEMES[themeKey].css || "";
    }

    let combined = "";
    if (data.customFont) {
      combined += `body, .bookmark_title, .bookmark_description, .tag { font-family: ${data.customFont} !important; }\n`;
    }
    if (presetCss) {
      combined += `/* === preset: ${data.themePresetKey} === */\n${presetCss}\n`;
    }
    if (overlay) {
      combined += `/* === user overlay === */\n${overlay}\n`;
    }

    if (combined) {
      const style = document.createElement("style");
      style.id = "pbp-injected";
      style.textContent = combined;
      (document.head || document.documentElement).appendChild(style);
    }
  } catch (_) {}

  uncloak();
})();
