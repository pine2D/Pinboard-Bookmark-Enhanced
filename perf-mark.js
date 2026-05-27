// ============================================================
// Pinboard Bookmark Enhanced - Performance Measurement Primitive
// ============================================================
// Cross-context (popup / options / SW / content_script) timing collector.
// Zero-cost when chrome.storage.local._perfEnabled is false (default).
// Samples go to chrome.storage.local._perfSamples (capped 2000).

const _pbpBuf = [];
const _PBP_BUF_CAP = 200;
const _PBP_STORAGE_CAP = 2000;
let _pbpEnabled = null; // null = unknown, true/false = cached

async function _pbpEnsureEnabled() {
  if (_pbpEnabled !== null) return _pbpEnabled;
  try {
    const { _perfEnabled = false } = await chrome.storage.local.get({ _perfEnabled: false });
    _pbpEnabled = !!_perfEnabled;
  } catch (_) { _pbpEnabled = false; }
  return _pbpEnabled;
}

function pbpMark(name) {
  try { performance.mark(`pbp:${name}`); } catch (_) {}
}

function pbpMeasure(name, fromMark, toMark) {
  try {
    const m = performance.measure(`pbp:${name}`, `pbp:${fromMark}`, `pbp:${toMark}`);
    _pbpBuf.push({
      name,
      ms: Math.round(m.duration * 100) / 100,
      ts: Date.now(),
      ctx: typeof document !== "undefined"
        ? (document.location.pathname.split("/").pop() || "doc")
        : "sw"
    });
    if (_pbpBuf.length > _PBP_BUF_CAP) _pbpBuf.shift();
  } catch (_) {}
}

async function pbpFlush() {
  if (!_pbpBuf.length) return;
  if (!(await _pbpEnsureEnabled())) { _pbpBuf.length = 0; return; }
  try {
    const { _perfSamples = [] } = await chrome.storage.local.get({ _perfSamples: [] });
    const merged = _perfSamples.concat(_pbpBuf);
    const trimmed = merged.length > _PBP_STORAGE_CAP
      ? merged.slice(-_PBP_STORAGE_CAP)
      : merged;
    await chrome.storage.local.set({ _perfSamples: trimmed });
    _pbpBuf.length = 0;
  } catch (_) {}
}

// Browser-context auto-flush (popup/options/content_script)
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") pbpFlush();
  });
  window.addEventListener("pagehide", () => pbpFlush(), { once: true });
}

// Invalidate cached enable flag when toggled
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes._perfEnabled) _pbpEnabled = null;
  });
}

// Content-script T0: mark when perf-mark.js finishes loading on a non-extension page.
// This sidesteps modifying pinboard-themes.js (handedit-audit lint forbids non-composer
// lines there). perf-mark.js is listed first in manifest.content_scripts.js, so this
// mark fires immediately before pinboard-themes.js starts parsing.
if (typeof location !== "undefined" && location.protocol !== "chrome-extension:") {
  pbpMark("ct-t0");
}
