// Shared UI-theme derivation: pilot palette -> popup/options semantic colors,
// with contrast-aware tinting so status backgrounds clear WCAG AA by construction.
// Pure functions only (unit-tested). No I/O.

const COMMON_DERIVED_OUTPUT_ROLES = Object.freeze([
  "btn-fg",
  "danger-quiet-fg",
  "on-danger",
  "chip-bg",
  "chip-fg",
]);

// Authoring contract shared with validate-contracts.mjs. These roles are
// outputs of the final post-override contrast pass, not supported ui.* inputs:
// accepting them would make a pilot look configurable while silently replacing
// its value moments later. Popup has two additional paired outputs.
export const UI_DERIVED_OUTPUT_ROLES = Object.freeze({
  popup: Object.freeze([...COMMON_DERIVED_OUTPUT_ROLES, "preset-fg", "spinner-fg"]),
  options: COMMON_DERIVED_OUTPUT_ROLES,
  library: COMMON_DERIVED_OUTPUT_ROLES,
});

export function hexToRgb(h) {
  let s = String(h).replace(/^#/, "").trim();
  if (s.length === 3) s = s.split("").map(c => c + c).join("");
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex([r, g, b]) {
  const h = x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}
export function relLum(rgb) {
  const s = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * s(rgb[0]) + 0.7152 * s(rgb[1]) + 0.0722 * s(rgb[2]);
}
export function contrast(a, b) {
  const L = [relLum(a), relLum(b)].sort((x, y) => x - y);
  return (L[1] + 0.05) / (L[0] + 0.05);
}

// PERCEPTUAL color distance (CIEDE2000). Not interchangeable with cr() above:
// the WCAG ratio is a pure LUMINANCE relation and is blind to hue, so it rates
// gruvbox's green->pink link hover (#83a598 -> #d3869b) at 1.02:1, the same
// number it gives two colors that are literally identical. Anything asking
// "would a person SEE this change" — a rest state against its :hover — has to
// use deltaE2000; anything asking "is this text legible on that fill" stays on
// cr(). Reference: CIE 142-2001, kL=kC=kH=1, D65. Verified against Sharma's
// published CIEDE2000 test set (2005) -- including the four hue-discontinuity
// pairs at (50, 2.49, -0.001) vs (50, -2.49, 0.0009..0.0012), which is where a
// naive mean-hue branch goes wrong: 7.1792 / 7.1792 / 7.2195 / 7.2195, exact.
//
// rgbToLab moved down here alongside deltaE2000 (its only caller, not
// separately imported anywhere -- verified via `rg -n rgbToLab` before the
// move): deltaE2000 cannot work without it, and leaving it behind in
// contrast-audit.mjs while deltaE2000 imports it back would either dangle a
// stale re-export or create a circular import between the two modules for a
// helper nothing outside this pair ever needed.
const rgbToLab = (rgb) => {
  const s = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb.map((c) => s(c / 255));
  let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  let y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / 1.0;
  let z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  [x, y, z] = [f(x), f(y), f(z)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
export const deltaE2000 = (rgb1, rgb2) => {
  const [L1, a1, b1] = rgbToLab(rgb1), [L2, a2, b2] = rgbToLab(rgb2);
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hue = (bb, aa) => { if (bb === 0 && aa === 0) return 0; const h = Math.atan2(bb, aa) * deg; return h >= 0 ? h : h + 360; };
  const hp1 = hue(b1, ap1), hp2 = hue(b2, ap2);
  const dLp = L2 - L1, dCp = Cp2 - Cp1;
  let dhp = 0;
  if (Cp1 * Cp2 !== 0) { dhp = hp2 - hp1; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (Cp1 + Cp2) / 2;
  let hbp;
  if (Cp1 * Cp2 === 0) hbp = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) > 180) hbp = (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2;
  else hbp = (hp1 + hp2) / 2;
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
          + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * (30 * Math.exp(-(((hbp - 275) / 25) ** 2))) * rad)
           * (2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)));
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
};

export function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s, l];
}
export function hslToRgb([h, s, l]) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = t => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map(x => Math.round(x * 255));
}

// Mix two rgb colors by ratio t (0 = a, 1 = b).
export function mix(a, b, t) { return a.map((c, i) => c + (b[i] - c) * t); }

// A plain opaque 3- or 6-digit hex color -- the only shape hexToRgb() parses
// correctly. Anything else (an 8-digit RRGGBBAA hex, the literal keyword
// "transparent", or any other CSS color syntax) must NOT be handed to
// hexToRgb() directly: parseInt("transparent", 16) is NaN, which the bitwise
// ops below silently coerce to 0 -- i.e. hexToRgb("transparent") returns
// [0,0,0] (black) with no error. An 8-digit hex is worse: hexToRgb() bit-shifts
// it as if it were 6-digit, reading the wrong bytes into r/g/b entirely.
const HEX6_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
export function isHex(s) { return typeof s === "string" && HEX6_RE.test(s.trim()); }

// Resolve a possibly-non-opaque fill to the solid RGB it actually composites
// to once painted over `fallbackBg` -- for AA math against colors a pilot
// may declare as non-solid (9 of 13 pilots' `tag-bg` is the literal
// "transparent"; no pilot's `tag-bg` currently uses an 8-digit alpha hex,
// but several pilots' OTHER palette slots do -- e.g. terminal's `border`/
// `selection-bg`, `#33ff3340` -- so the guard below handles that shape too
// rather than assuming every non-"transparent" value is a plain 6-digit
// hex). A plain hex passes through unchanged (already opaque, no
// compositing needed); an 8-digit RRGGBBAA hex is alpha-blended over
// `fallbackBg`; anything else (transparent, or any other keyword) is
// treated as fully transparent, so the resolved color is just `fallbackBg`.
const HEX8_RE = /^#([0-9a-f]{8})$/i;
export function resolveOpaqueBg(raw, fallbackBg) {
  if (isHex(raw)) return hexToRgb(raw);
  const m = typeof raw === "string" && raw.trim().match(HEX8_RE);
  if (!m) return fallbackBg;
  const n = parseInt(m[1], 16);
  const rgb = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255];
  const alpha = (n & 255) / 255;
  return mix(fallbackBg, rgb, alpha);
}

// chip-bg's palette source (`tag-bg`) is the literal "transparent" for 9 of
// 13 pilots. resolveOpaqueBg's own fallback for that shape is `fallbackBg`
// verbatim (mixing in 0% of a fully-transparent color) -- correct for its
// other callers (a border/spinner compositing onto whatever sits behind it),
// but wrong for chip-bg specifically: chip-bg IS the fill of a real pill
// (.vocab-group-chip / .tag-gov-chip-face), and a pill whose background
// exactly equals its own container is exactly as invisible as the literal
// `transparent` it would replace (vocab-group-inspect-report.md 2026-08-05
// Finding 2: dracula's .vocab-group-chip rendered with zero pill background,
// floating text only -- library-chrome.mjs/options-chrome.mjs's prior
// `map["chip-bg"] = palette["tag-bg"]` shipped the raw literal verbatim, so
// the bug wasn't even panel-colored invisibility, it was literally
// `background: transparent` in the shipped CSS). Synthesize the same
// 10%-accent-on-panel tint both composers' DEFAULT_LIGHT baseline already
// documents (its own "chip-bg" comment) for the untheme surface, instead of
// falling through to invisible-on-panel. Returns RGB (resolveOpaqueBg's own
// convention) so a caller can rgbToHex() it for emission and reuse the same
// RGB for a paired chip-fg contrast check without re-deriving it.
export function resolveChipBg(raw, accentRgb, panelRgb) {
  if (isHex(raw)) return hexToRgb(raw);
  const m = typeof raw === "string" && raw.trim().match(HEX8_RE);
  if (m) return resolveOpaqueBg(raw, panelRgb);
  return mix(panelRgb, accentRgb, 0.10);
}

// Adjust fg's LIGHTNESS (hue+sat preserved) against a FIXED bg until contrast >= min,
// verifying on hex-rounded values so the written CSS clears AA. Returns rgb.
export function fgToAA(fg, bg, min = 4.5) {
  const bgRound = hexToRgb(rgbToHex(bg));
  const bgIsLight = relLum(bgRound) > 0.18;
  const [h, s] = rgbToHsl(fg);
  let [, , l] = rgbToHsl(fg);
  let out = fg;
  for (let i = 0; i < 80; i++) {
    if (contrast(hexToRgb(rgbToHex(out)), bgRound) >= min) break;
    l = bgIsLight ? Math.max(0, l - 0.02) : Math.min(1, l + 0.02);
    out = hslToRgb([h, s, l]);
    if (l <= 0 || l >= 1) break;
  }
  return out;
}

// Mirror of fgToAA for the case where the FOREGROUND is the fixed brand value and
// the FILL must give way. Adjusts bg's LIGHTNESS (hue+sat preserved) against a fixed
// fg until contrast >= min, verifying on hex-rounded values. Returns rgb.
//
// Used for button fills: a pilot's btn-fg is the theme's chosen "text on brand color"
// (usually its lightest base), and flipping it to the opposite pole to reach AA would
// read as a different theme. Darkening the fill by the minimum needed keeps the
// light-text-on-brand look while clearing AA. Identity when the pair already passes,
// so themes that are already compliant emit byte-for-byte unchanged.
export function bgToAA(bg, fg, min = 4.5) {
  const fgRound = hexToRgb(rgbToHex(fg));
  const fgIsLight = relLum(fgRound) > 0.18;
  const [h, s] = rgbToHsl(bg);
  let [, , l] = rgbToHsl(bg);
  let out = bg;
  for (let i = 0; i < 200; i++) {
    if (contrast(hexToRgb(rgbToHex(out)), fgRound) >= min) break;
    l = fgIsLight ? Math.max(0, l - 0.005) : Math.min(1, l + 0.005);
    out = hslToRgb([h, s, l]);
    if (l <= 0 || l >= 1) break;
  }
  return out;
}

// Derive an AA-passing status (fg,bg) pair: subtle tinted background keeping the
// theme's light/dark feel, with the foreground's LIGHTNESS adjusted (hue+sat kept)
// until contrast >= min. mode: "light"|"dark". Returns { fg:[r,g,b], bg:[r,g,b] }.
export function pairToAA(statusFg, themeBg, mode, min = 4.5) {
  const bg = mix(themeBg, statusFg, mode === "dark" ? 0.18 : 0.12);
  return { fg: fgToAA(statusFg, bg, min), bg };
}

// Push fg's lightness (hue+sat preserved) until it clears AA against EVERY
// background in `bgs`, not just one. Several UI roles are shared across more
// than one surface fill -- a button's text sits on both its resting bg and
// its :hover bg, library's row text sits on bg, panel AND the selected-row
// fill -- and a plain fgToAA(fg, oneBg) can't express a "clears all of these"
// constraint. Repeatedly fix whichever pair is worst until all pass. Same
// repeated-worst-case technique _util.mjs's on-accent derivation uses.
// (Moved here from library-chrome.mjs, its original sole consumer, so
// popup/options/library composers can share one implementation -- Task 5.)
export function fgToAAMulti(fg, bgs, min = 4.5) {
  let cur = fg;
  for (let i = 0; i < 8; i++) {
    let worst = null;
    for (const bg of bgs) {
      const c = contrast(cur, bg);
      if (!worst || c < worst.c) worst = { bg, c };
    }
    if (worst.c >= min) break;
    cur = fgToAA(cur, worst.bg, min);
  }
  return cur;
}

// Push a UI-chrome BORDER's LIGHTNESS (hue+sat preserved) until it clears
// WCAG 1.4.11's 3:1 non-text floor against the CALLER-CHOSEN bgs argument --
// every caller in this codebase passes [btn-bg, panel] (COMPONENTS.md's
// border-color row; gated by contrast-audit's COMPONENT_PAIR_SPEC "border"
// rows -- design-uplift Task 16, USER RULING: Task 7 measured all 13
// pilots' raw palette border at 1.0-1.73:1 against btn-bg across all 3 UI
// surfaces and deliberately left it ungated pending this derivation). This
// function makes NO guarantee against any OTHER surface a border-colored
// rule happens to sit on -- `bg` (the page background, not btn-bg/panel)
// and `input-bg` are real, un-derived exposures: post-derivation measured
// ratios there run 2.76-5.71:1 (up from a pre-derivation 1.0-2.06:1, zero
// regressions, but individual combos like modern-card border-vs-bg 2.81:1
// and dracula border-vs-input-bg 1.78:1 still sit under 3:1) -- see
// task-16-report.md's disclosure table for the full per-theme numbers.
// Widening this function's contract to cover those too is future work, not
// a claim this derivation call already makes. Same repeated-worst-case
// convergence as fgToAAMulti (this file) -- just at the UI-component
// threshold instead of body text's 4.5:1, and named separately because
// "does this edge read distinctly against its surroundings" is a different
// question from "is this text legible on its fill" even though the math is
// identical. Identity when the pair already clears 3:1, so an
// already-compliant theme emits byte-for-byte unchanged. `border` may be a
// non-opaque fill (terminal's is a translucent glow, an 8-digit alpha hex,
// `#33ff3340`) -- callers must resolve it to an opaque RGB first
// (resolveOpaqueBg), the same requirement fgToAA/fgToAAMulti already carry
// for any fg input.
export function borderToAA(border, bgs, min = 3) {
  return fgToAAMulti(border, bgs, min);
}

// The FOCUS EDGE, pushed to clear WCAG 1.4.11's 3:1 non-text floor against
// every host fill a focusable control can wear (callers pass [btn-bg,
// input-bg]; the worst of them wins, same repeated-worst-case shape as
// fgToAAMulti/borderToAA).
//
// Why this needs a derivation at all (design-uplift follow-up 2026-08-06,
// independent review): §7.3's `bordered` placement makes the control's own
// 1px border the focus indicator's CORE, and Soft Fill (§9 law 1) collapsed
// that border into the fill at rest -- `btn-border == btn-bg`, 1.00:1. So
// this one token IS the entire compliance story for the whole .btn family,
// every field, and every fused shell. The shipped default was a flat
// `color-mix(accent 55%, input-focus-bg)`, which measured 1.58-2.40:1 on
// most surfaces (default light 1.89, html.dark 2.40, flexoki 2.10,
// solarized-light 1.58). The only three themes that passed -- terminal
// 13.93, paper-ink 9.63, solarized-dark 3.30 -- passed precisely because a
// pilot override bypassed that formula. §7.3 has required >=3:1 since it was
// written; nothing had ever enforced it.
//
// Starts AT the historical formula so a theme that already clears 3:1 emits
// byte-for-byte unchanged, then walks the mix toward pure accent, and only
// if pure accent still cannot reach the floor falls back to moving lightness
// (fgToAAMulti). Walking the mix first is what keeps the ring the theme's
// OWN accent hue rather than an arbitrarily lightened/darkened version of
// it -- the visible softness of this ring is supposed to come from its
// SHAPE (the --{ns}-focus-ring glow) and not from a washed-out core.
export function focusBdToAA(accent, seedBg, hosts, min = 3) {
  const round = c => hexToRgb(rgbToHex(c));
  const clears = c => hosts.every(h => contrast(round(c), round(h)) >= min);
  for (let i = 55; i <= 100; i++) {
    const c = mix(seedBg, accent, i / 100);
    if (clears(c)) return c;
  }
  return fgToAAMulti(accent, hosts, min);
}

// Soft Fill (design-uplift 2026-08-05, USER RULING): at rest a control is
// announced by its FILL, not by a frame -- the resting border-color collapses
// into the fill (border-width is kept, so zero layout shift). That only works
// if the fill is actually distinguishable from the surface the control sits
// on, and measured across the 14 theme blocks it frequently is NOT: options'
// btn-bg is byte-identical to its own panel in 6 of them, library's in ALL
// 14, input-bg in 5, and popup's bg2-as-button-fill in 7 against its own
// strip. Delete the border there and the control vanishes outright -- the
// finding softfill-delta-report.md §11.2 tabulated (github-light: panel,
// btn-bg AND input-bg all #ffffff).
//
// So: mix the surface's own fg into the fill until it clears `min` against
// EVERY host surface that control can sit on. Multi-host is not theoretical:
// library's .btn appears both on the page bg (toolbars) and inside a pane
// (panel), and separating from only one of the two can push the fill straight
// onto the other. Same repeated-worst-case shape as fgToAAMulti, just at a
// perceptibility floor instead of a legibility one.
//
// 1.10:1 is deliberately far below WCAG 1.4.11's 3:1 -- that clause governs a
// control's boundary against its background, a job the focus ring and the
// hover fill still do at full strength. This is the much weaker "the resting
// shape is perceivable at all" bar: on white, a 1-step-per-channel difference
// is ~1.005:1 (invisible), 1.10:1 is ~11 steps, which is where a flat fill
// starts reading as a distinct plane rather than as banding.
//
// Mixes into the FILL, not into the surface, so a theme whose fill already
// carries its own tint keeps that hue and only gains separation (mixing into
// the surface, the shape softfill-delta-report.md sketched for the runtime
// overlay, would have flattened every theme's fill onto one neutral). Where
// fill === surface the two are identical anyway. Identity when the pair
// already clears `min`, so an already-separated theme emits byte-for-byte
// unchanged.
//
// The separation floor. 1.06 until 2026-09-21; raised to 1.10 by user ruling
// after a rendered three-way comparison (1.06 / 1.10 / 1.15): 1.10 is where a
// resting fill reads as its own plane on light surfaces, while 1.15 starts to
// read as an old-style grey button AND pushes five "recessed well" input fields
// (darker than their hosts) far enough toward fg that they cross the hosts'
// luminance and come out as raised pills -- this function only ever mixes
// toward fg, so a well can only be separated further by flipping it.
export const FILL_SEPARATE_MIN = 1.10;

export function fillSeparate(fill, surfaces, fg, min = FILL_SEPARATE_MIN) {
  const round = c => hexToRgb(rgbToHex(c));
  const clears = c => surfaces.every(s => contrast(round(c), round(s)) >= min);
  if (clears(fill)) return fill;
  for (let i = 1; i <= 100; i++) {
    const out = mix(fill, fg, i * 0.005);
    if (clears(out)) return out;
  }
  return mix(fill, fg, 0.5);
}

// Two control TIERS that sit side by side (a tonal button next to a plain one, a
// checked selectable chip next to unchecked ones) have to be tellable apart by
// their FILL. That is a perceptual-distance question, not a luminance one: the
// default surface's chip (pale blue) and button (grey) are 1.01:1 in contrast
// but ΔE 6.1 and plainly different, while catppuccin-mocha shipped the two
// byte-identical. Same yardstick and floor as contrast-audit's rest-vs-hover
// gate (ΔE2000 >= 6).
export const TIER_DISTINCT_MIN_DE = 6;

// Mix `toward` (the theme's accent -- keeps the tier's hue identity; mixing fg
// in would just grey it) into `fill` until it is >= minDE from EVERY fill in
// `others`, verified on the hex-rounded value that ships. Identity when already
// distinct, so compliant themes emit byte-for-byte unchanged.
export function fillDistinct(fill, others, toward, minDE = TIER_DISTINCT_MIN_DE) {
  const round = c => hexToRgb(rgbToHex(c));
  const clears = c => others.every(o => deltaE2000(round(c), round(o)) >= minDE);
  if (clears(fill)) return fill;
  for (let i = 1; i <= 60; i++) {
    const out = mix(fill, toward, i * 0.01);
    if (clears(out)) return out;
  }
  return mix(fill, toward, 0.6);
}

// Final post-override pass shared by popup/options/library. It owns only the
// roles whose validity depends on several final control fills; surface-specific
// status roles and popup's preset/spinner pairs remain in their composers.
// Returns a new map so callers can safely retain their pre-finalization input.
export function finalizeUiControlRoles(inputMap, palette, overrides = {}, config = {}) {
  const {
    panelRole = "panel",
    buttonBorderRole = "btn-border",
    inputBorderRole = "input-border",
    chipMode = "tinted",
  } = config;
  if (chipMode !== "tinted" && chipMode !== "verbatim") {
    throw new Error(`finalizeUiControlRoles: unsupported chipMode ${JSON.stringify(chipMode)}`);
  }

  const map = { ...inputMap };
  const ovr = overrides ?? {};
  const fgRgb = hexToRgb(map.fg);
  const bgRgb = hexToRgb(map.bg);
  const panelRgb = hexToRgb(map[panelRole]);
  const hosts = [panelRgb, bgRgb];

  // fg-hint / fg-muted are supported pilot-override inputs (unlike the
  // COMMON_DERIVED_OUTPUT_ROLES locked above) -- deriveUiColors already
  // guarantees its OWN fgToAAMulti output clears bg/bg-surface/accent-soft,
  // but a pilot's `ui.<surface>.<mode>.fg-hint`/`fg-muted` literal is merged
  // into the map AFTER that guarantee runs and nothing re-validated it since.
  // That gap is exactly how flexoki-light's ui.options.light.fg-hint (a raw
  // "#6F6E69", chosen to equal palette.muted rather than the derivation's
  // muted-soft input) shipped at 4.47:1 against --opt-panel -- not a bug in
  // fgToAAMulti's convergence or rounding (both verified correct in
  // isolation), but an override bypassing the guarantee entirely (found
  // 2026-09-21 via the contrast-audit bg2/panel blind-spot fix). Re-run both
  // tiers through the same worst-case AA derivation on the FINAL, post-
  // override map: identity for every theme that already clears (the
  // un-overridden default already does, by construction), so this only ever
  // moves a value that was failing, and only toward MORE contrast (fgToAA
  // never relaxes lightness back toward bg once it has moved away).
  for (const role of ["fg-hint", "fg-muted"]) {
    if (map[role] != null) {
      map[role] = rgbToHex(fgToAAMulti(hexToRgb(map[role]), hosts));
    }
  }

  if (ovr[buttonBorderRole] == null) {
    map["btn-bg"] = rgbToHex(fillSeparate(hexToRgb(map["btn-bg"]), hosts, fgRgb));
  }
  map[buttonBorderRole] = ovr[buttonBorderRole] ?? map["btn-bg"];
  if (ovr[inputBorderRole] == null) {
    map["input-bg"] = rgbToHex(fillSeparate(hexToRgb(map["input-bg"]), hosts, fgRgb));
  }
  map[inputBorderRole] = ovr[inputBorderRole] ?? map["input-bg"];

  const btnBgRgb = hexToRgb(map["btn-bg"]);
  map["btn-hover"] = rgbToHex(fillSeparate(hexToRgb(map["btn-hover"]), [btnBgRgb], fgRgb));
  const btnHoverRgb = hexToRgb(map["btn-hover"]);
  if (map["focus-bd"] == null) {
    map["focus-bd"] = rgbToHex(focusBdToAA(
      hexToRgb(map.accent),
      hexToRgb(map["input-focus-bg"] ?? map["input-bg"]),
      [btnBgRgb, hexToRgb(map["input-bg"])],
    ));
  }

  const dangerRgb = hexToRgb(map.danger);
  // Quiet destructive text is also rendered on the settled 8% danger hover
  // fills emitted by ui-components.mjs. Auditing only the three resting
  // hosts is insufficient near AA: github-light clears on bg/btn-bg but
  // falls to 4.44:1 once the ghost hover tint is actually painted.
  const dangerGhostHoverRgb = mix(bgRgb, dangerRgb, 0.08);
  const dangerButtonHoverRgb = mix(btnBgRgb, dangerRgb, 0.08);
  map.border = rgbToHex(borderToAA(resolveOpaqueBg(map.border, btnBgRgb), [btnBgRgb, panelRgb]));
  map["btn-fg"] = rgbToHex(fgToAAMulti(fgRgb, [btnBgRgb, btnHoverRgb]));
  map["danger-quiet-fg"] = rgbToHex(fgToAAMulti(
    dangerRgb,
    [bgRgb, panelRgb, btnBgRgb, dangerGhostHoverRgb, dangerButtonHoverRgb],
  ));
  map["on-danger"] = rgbToHex(fgToAA(hexToRgb(palette["btn-fg"]), dangerRgb));

  if (chipMode === "verbatim") {
    map["chip-bg"] = map["tag-bg"];
    map["chip-fg"] = rgbToHex(fgToAAMulti(
      hexToRgb(map["tag-fg"]),
      [resolveOpaqueBg(map["tag-bg"], panelRgb), btnHoverRgb],
    ));
  } else {
    const tagBg = map["tag-bg"] ?? palette["tag-bg"];
    const tagFg = map["tag-fg"] ?? palette["tag-fg"];
    const chipTinted = fillSeparate(
      resolveChipBg(tagBg, hexToRgb(map.accent), panelRgb),
      [panelRgb],
      fgRgb,
    );
    // ...then apart from the resting control fill it sits beside (.btn.tonal
    // next to .btn; a checked chip next to unchecked ones resting on btn-bg).
    const chipBgRgb = fillDistinct(chipTinted, [btnBgRgb], hexToRgb(map.accent));
    map["chip-bg"] = rgbToHex(chipBgRgb);
    map["chip-fg"] = rgbToHex(fgToAAMulti(
      hexToRgb(tagFg),
      [chipBgRgb, btnHoverRgb],
    ));
  }
  return map;
}

// Site radius scale -> extension UI radius scale.
//
// The site composers take the pilot's values literally (_base.mjs). Several
// pilots are non-monotonic there -- gruvbox md:0 below sm:2px, dracula and
// catppuccin-mocha with lg below md -- which is defensible on a bookmark list
// but reads as a bug on a settings form, where it puts a card that is rounder
// than the panel holding it. So the UI scale enforces sm <= md <= lg by RAISING
// only: the theme's intent survives, the inversion does not.
//
// Applied to the merged value, so a pilot `ui.*` override can still choose any
// scale it likes but cannot reintroduce an inversion.
export function regularizeUiRadius(r) {
  const px = (v, dflt) => { const n = parseFloat(v); return Number.isFinite(n) ? n : dflt; };
  const sm = px(r["radius-sm"], 0);
  const md = Math.max(sm, px(r["radius-md"], sm));
  const lg = Math.max(md, px(r["radius-lg"], md));
  return { "radius-sm": `${sm}px`, "radius-md": `${md}px`, "radius-lg": `${lg}px` };
}

// `radius` is the mode-merged pilot scale (compose-theme.mjs merges modes.dark
// over the base). Same md/lg fallback chain as _base.mjs so the two surfaces
// agree on what a pilot that omits a step means.
export function deriveUiRadius(radius) {
  const r = radius || {};
  return regularizeUiRadius({
    "radius-sm": r.sm ?? "0",
    "radius-md": r.md ?? r.sm ?? "0",
    "radius-lg": r.lg ?? r.md ?? r.sm ?? "0",
  });
}

// Map an expanded pilot palette to the canonical UI semantic colors.
// `mode` is the theme's light/dark intent. Palette values are hex strings.
export function deriveUiColors(p, mode) {
  const hx = k => p[k];
  const rgb = k => hexToRgb(p[k]);
  const bg = rgb("bg");
  const warn = pairToAA(rgb("destroy"), bg, mode);
  const ok = pairToAA(rgb("success"), bg, mode);
  const banner = pairToAA(rgb("accent"), bg, mode);
  const offline = pairToAA(rgb("private-accent"), bg, mode);
  const bd = (pr) => rgbToHex(mix(pr.bg, pr.fg, 0.5));
  const inputFocus = mode === "dark"
    ? rgbToHex(hslToRgb((() => { const [h, s, l] = rgbToHsl(rgb("input-bg")); return [h, s, Math.min(1, l + 0.06)]; })()))
    : hx("bg");
  return {
    bg: hx("bg"), bg2: hx("bg-surface"), fg: hx("fg"),
    // Both text tiers land on bg AND on the elevated bg2 surface (popup's
    // autocomplete footer / offline empty state, options' panels), so they
    // are derived against both (2026-08-26, Codex: flexoki-dark's fg-hint
    // cleared bg at 4.67:1 but sat at 4.05:1 on bg2 once the popup's
    // hand-tuned html.dark layer was retired).
    // ...and on the accent-tinted hover/selected row fill (drop-hover =
    // accent-soft): the autocomplete's selected candidate keeps its hint-tier
    // count on that fill (terminal read 3.5:1 there, Codex 2026-08-26).
    "fg-muted": rgbToHex(fgToAAMulti(rgb("muted"), [bg, rgb("bg-surface"), rgb("accent-soft")])),
    "fg-hint": rgbToHex(fgToAAMulti(rgb("muted-soft"), [bg, rgb("bg-surface"), rgb("accent-soft")])),
    border: hx("border"), divider: hx("border-soft"),
    accent: hx("accent"), accent2: hx("link-visited"), link: hx("accent"),
    "tag-bg": hx("tag-bg"), "tag-fg": hx("tag-fg"), "tag-hover": hx("row-hover"),
    "drop-hover": hx("accent-soft"),
    "input-bg": hx("input-bg"), "input-focus-bg": inputFocus,
    "warn-fg": rgbToHex(warn.fg), "warn-bg": rgbToHex(warn.bg), "warn-bd": bd(warn),
    "ok-fg": rgbToHex(ok.fg), "ok-bg": rgbToHex(ok.bg), "ok-bd": bd(ok),
    "banner-fg": rgbToHex(banner.fg), "banner-bg": rgbToHex(banner.bg), "banner-bd": bd(banner),
    "offline-fg": rgbToHex(offline.fg), "offline-bg": rgbToHex(offline.bg), "offline-bd": bd(offline),
    danger: hx("destroy"),
    "spinner-bg": hx("border"), "spinner-fg": hx("accent"),
    "preset-bg": hx("accent-soft"), "preset-bd": hx("border"), "preset-fg": hx("accent"),
  };
}
