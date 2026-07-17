// ============================================================
// Pinboard Bookmark Enhanced - Custom Style Injector
// Content script for pinboard.in pages (runs at document_start)
//
// Schema v2 (2026-05-01):
//   themePresetKey   → string, looks up CSS from PINBOARD_THEMES (loaded above)
//   customOverlayCSS → user's tweak CSS, appended after preset (CSS later wins)
//   customOverlayCSS_localFallback → this device's quota fallback
// ============================================================

// Adaptive theme map (mirrors shared.js — content scripts can't import it)
const PBP_ADAPTIVE_THEME_MAP = {
  flexoki: ["flexoki-light", "flexoki-dark"],
  solarized: ["solarized-light", "solarized-dark"],
  catppuccin: ["catppuccin-latte", "catppuccin-mocha"]
};

// Only cloak when prior evidence (origin-scoped, synchronous) says a theme is
// configured. Default/un-themed users get NO blank flash — there is nothing to
// fade in. localStorage is readable here (content script runs in pinboard.in
// origin); shared.js's chrome.storage mirror is async and unavailable that early.
let _pbpHasTheme = false;
try { _pbpHasTheme = localStorage.getItem("pbp_has_theme") === "1"; } catch (_) {}
let _pbpCloak = null;
if (_pbpHasTheme) {
  _pbpCloak = document.createElement("style");
  _pbpCloak.id = "pbp-cloak";
  _pbpCloak.textContent = "html { opacity: 0 !important; }";
  (document.head || document.documentElement).appendChild(_pbpCloak);
}

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
    const fallbackKey = `${key}_localFallback`;
    const fallback = await chrome.storage.local.get(fallbackKey);
    if (typeof fallback[fallbackKey] === "string") return fallback[fallbackKey];
    const meta = await chrome.storage.sync.get(key);
    const fallbackRecord = fallback[fallbackKey];
    if (fallbackRecord && fallbackRecord._pbpLargeFallback === 1 &&
        (!meta[key] || meta[key]._generation !== fallbackRecord._generation)) {
      return typeof fallbackRecord.value === "string" ? fallbackRecord.value : defaultValue;
    }
    if (typeof meta[key] === "string") return meta[key];
    const count = Number(meta[key] && meta[key]._chunks);
    const generation = meta[key] && meta[key]._generation;
    const matchingFallback = fallbackRecord && fallbackRecord._pbpLargeFallback === 1 &&
      typeof fallbackRecord.value === "string" ? fallbackRecord.value : null;
    if (!Number.isInteger(count) || count < 1 || count > 512 ||
        (generation !== undefined && (typeof generation !== "string" || !/^[a-z0-9]+$/i.test(generation)))) {
      return matchingFallback === null ? defaultValue : matchingFallback;
    }
    const prefix = generation ? `${key}_${generation}_` : `${key}_`;
    const chunkKeys = Array.from({ length: count }, (_, i) => `${prefix}${i}`);
    const chunks = await chrome.storage.sync.get(chunkKeys);
    if (chunkKeys.some((chunkKey) => typeof chunks[chunkKey] !== "string")) {
      return matchingFallback === null ? defaultValue : matchingFallback;
    }
    const joined = chunkKeys.map((chunkKey) => chunks[chunkKey]).join("");
    return joined || (matchingFallback === null ? defaultValue : matchingFallback);
  }

  function uncloak() {
    const el = document.getElementById("pbp-cloak");
    if (el) el.remove();
  }

  // Safety: always uncloak after 400ms even if something fails (was 800ms;
  // themed storage reads resolve well under this on warm SW)
  setTimeout(uncloak, 400);

  try {
    const storage = await getStorage();
    const data = await storage.get({
      customFont: "",
      optTheme: "auto",
      themePresetKey: "",
    });

    // The reader itself prefers this device's local quota fallback when present.
    const overlay = await readChunkedSync("customOverlayCSS", "");

    // Inject pbp-dark class based on extension theme setting
    const isDark = data.optTheme === "dark" ||
      (data.optTheme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("pbp-dark", isDark);

    // Resolve preset CSS from PINBOARD_THEMES (loaded above us as content script)
    let presetCss = "";
    if (data.themePresetKey && typeof PINBOARD_THEMES !== "undefined") {
      // Adaptive presets: prefer the explicit variant if it exists in
      // PINBOARD_THEMES (solarized-light, catppuccin-mocha, etc.), otherwise
      // fall back to the parent entry. Flexoki ships ONE css string that
      // toggles via the `html.pbp-dark` class, so its variant keys don't
      // exist as separate entries — using the parent is correct.
      let themeKey = data.themePresetKey;
      if (PBP_ADAPTIVE_THEME_MAP[themeKey]) {
        const variantKey = PBP_ADAPTIVE_THEME_MAP[themeKey][isDark ? 1 : 0];
        if (PINBOARD_THEMES[variantKey]) themeKey = variantKey;
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

    // Persist cheap synchronous evidence for NEXT cold load's cloak gate.
    const _pbpThemed = !!(data.themePresetKey || data.customFont || overlay);
    try { localStorage.setItem("pbp_has_theme", _pbpThemed ? "1" : "0"); } catch (_) {}

    if (combined) {
      const style = document.createElement("style");
      style.id = "pbp-injected";
      style.textContent = combined;
      (document.head || document.documentElement).appendChild(style);
    }
  } catch (_) {}

  uncloak();
})();
