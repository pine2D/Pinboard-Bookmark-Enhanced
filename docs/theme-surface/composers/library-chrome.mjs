import { expandPalette } from "./_util.mjs";
import { mergeTokens } from "./compose-theme.mjs";
import { deriveUiColors, deriveUiRadius, regularizeUiRadius, fgToAA, fgToAAMulti, finalizeUiControlRoles, mix, hexToRgb, rgbToHex } from "./_ui-derive.mjs";
import { POPUP_THEME_MAP } from "./popup-chrome.mjs";

// Accent-over-bg mixes library.css paints behind a row that is SELECTED for a
// batch action (rest, then :hover). Mirrors library.css's `--lib-band-mix` /
// `--lib-band-mix-hover` :root tokens (debt-sweep 2026-08-07 named those --
// before that, the same two numbers were separate unnamed literals at each of
// notes-hit's and vocab-card's two write sites) -- see the row-selected-fg
// comment below for why THIS copy can't just reference that CSS var(): this
// runs in Node at build time and needs the literal percentage to do
// arithmetic, not a browser-resolved custom property. Keep the two numbers in
// step by hand; the render oracle's bandDistinct entry is what catches a drift.
export const LIB_BATCH_BAND_MIX = [0.20, 0.26];

// Default-surface (no preset selected) component-layer baseline — Task 5,
// step ① of the composer color migration. Every value below is copied
// VERBATIM from the CSS literal it stands in for today (btn-fg measured via
// real Chromium rendering — see task-5-report.md), so adding these
// declarations changes nothing currently rendered (nothing consumes these
// 5 names yet — Task 8/9/12/13 do): a later task that swaps a hardcoded
// literal for var(--lib-*) finds the identical color already seeded here.
const DEFAULT_LIGHT = {
  "btn-fg": "#000000",          // measured: getComputedStyle(.btn).color on the unthemed default
                                 // page (library.css:119 declares no `color` — this is the browser's
                                 // ButtonText resolution, NOT a guess; see task-5-report.md).
  "btn-fg-muted": "#5f6368",    // weak-text-on-fill batch, D1: fgToAAMulti(--lib-fg-muted default
                                 // #5f6368 (library.css:23), [btn-bg, btn-hover] below) is IDENTITY
                                 // here -- the raw value already clears both (5.12:1 / 4.62:1), unlike
                                 // options/popup's defaults.
  "danger-quiet-fg": "#c5221f", // = --lib-danger default (library.css:26)
  "on-danger": "#ffffff",       // = .confirm-popover .confirm-yes color: var(--lib-panel, #fff)
                                 // default (library.css:207); already 5.80:1 on --lib-danger default,
                                 // clears AA unmodified.
  "on-accent": "#ffffff",       // library has no existing "text on filled accent" role -- new for
                                 // Task 4 (taste-uplift-batch2), `.btn.primary`'s text colour
                                 // (`.vocab-note-save`). fgToAAMulti(white, [accent-default #1a73e8,
                                 // its 88%-accent/12%-fg hover mix]) is identity on both hosts: white
                                 // already clears 4.51:1 / 5.30:1 (rest margin is thin, same
                                 // convention as on-danger's default above; the render audit caught a
                                 // THEMED library block fail this hover pair at only 4.27:1 before this
                                 // derivation went multi-host -- see _ui-derive.mjs).
  "chip-bg": "#e6f0fd",         // = the resolved literal of .vocab-group-chip's own current formula
                                 // (color-mix(--lib-accent 10%, transparent), library.css:1141-1145)
                                 // composited over --lib-panel default (#ffffff) — 10% of --lib-accent
                                 // default (#1a73e8) mixed in, then pushed 1% further toward accent by
                                 // fillDistinct(chip, [btn-bg], accent) (Task 2, taste-uplift-batch2):
                                 // the raw 10%-tint value (#e8f1fd) was only ΔE 5.6 from --lib-btn-bg
                                 // (#ececed, re-derived Task 1) -- not tellable apart from a resting
                                 // .btn -- and needs >=6. Re-derived value clears at ΔE 6.06, and still
                                 // 1.15:1 against --lib-panel (>= FILL_SEPARATE_MIN 1.10).
  "chip-fg": "#1a1a2e",         // = --lib-fg default (.vocab-group-chip's current `color`,
                                 // library.css:1145); fgToAA(fg, chip-bg) is identity at 14.82:1
                                 // (re-verified against the ΔE-pushed chip-bg above, was 14.97:1).
  // Soft Fill control fills (design-uplift 2026-08-05), moved off their
  // hand-written :root literals for the same reason options' pair was: both
  // were #ffffff, exactly --lib-panel/--lib-pane-bg, so a frameless control
  // in a detail pane had nothing left to see. fillSeparate(fill, [panel,
  // bg], fg) — 1.18:1 vs panel, 1.10:1 vs --lib-bg (re-derived 2026-09-21,
  // FILL_SEPARATE_MIN 1.06 -> 1.10; was #f0f0f1 for both roles).
  "btn-bg": "#ececed",
  "btn-border": "#ececed",      // = btn-bg (frame collapsed into the fill).
  "btn-hover": "#dee1e9",       // NOT a literal copy: the old #eef2f9 is 1.01:1 against the new rest
                                 // fill. fillSeparate(btn-hover, [btn-bg], fg) — 1.11:1.
                                 // (re-derived 2026-09-21 alongside btn-bg; was #e6e9f1).
  "input-bg": "#ececed",
  "input-border": "#ececed",    // = input-bg.
  "border": "#858596",          // NOT a literal copy: the hand-written :root's old #e2e2e6 was only
                                 // 1.29:1 against --lib-btn-bg/--lib-panel (both #fff by default)
                                 // (design-uplift Task 16, USER RULING -- border reads visibly heavier
                                 // now, the intended effect). Derived the same way the themed border
                                 // is: borderToAA(border, [btn-bg, panel]) — 3.07:1 / 3.63:1, clears
                                 // the 3:1 non-text floor (re-checked 2026-09-21 against the 1.10-separated
                                 // btn-bg above; #858596 still clears, unchanged). Re-derived 2026-08-05
                                 // (was #90909f) because Soft Fill darkened btn-bg out from under it —
                                 // contrast-audit's `border vs btn-bg` row caught the stale value at 2.76:1.
};

// Map canonical UI colors to --lib-* names for the standalone library page
// (notes + vocabulary). Role set = the options roles plus master-detail
// additions (pane bg/divider, selected-row pair).
//
// `focus` mirrors how popup-chrome.mjs consumes tk.ui.popup.<mode>: no pilot
// carries a dedicated ui.library.<mode>.focus-bd/focus-ring override, so this
// reuses popup's (only 3 pilots declare one — terminal/paper-ink/solarized's
// glow-style box-shadow). Guarded with `!= null` and NOT unconditionally
// spread: deriveUiColors never computes focus-bd/focus-ring itself, so an
// unconditional `ui["focus-bd"]` here would literally emit
// `--lib-focus-bd: undefined;` for every one of the other 11 themes. Themes
// without an override fall through the cascade to library.css's :root
// computed default (same color-mix(--lib-accent) formula), which is the ONLY
// thing that makes --lib-focus-ring resolve for those themes at all.
// `mode` drives the native-control scheme (scrollbar, number spinner, etc.)
// for this theme's own block -- Task 6, library's FIRST color-scheme
// declaration (popup/options already had a hand-written one; library never
// did -- half the root cause of defect 1/4: library's own dark presets left
// native `.btn` text at UA ButtonText resolved against the wrong scheme).
function emitLib(ui, palette, overrides, radius, focus = {}, mode) {
  const save = rgbToHex(fgToAA(hexToRgb(palette.success), hexToRgb(palette.bg)));
  // Unlike options, no pilot carries ui.library overrides yet, so danger/warn
  // must be derived here or ui-token-coverage fails on themes without them.
  // Verified via `node -e` against expandPalette output: there is no `danger`
  // key — the danger-equivalent role is `destroy` (same source deriveUiColors
  // reads for its own `danger`). There is no warn-equivalent role at all in
  // any of the 13 pilots' palettes, so warn stays a fixed literal for every
  // theme until a pilot declares one.
  const danger = rgbToHex(fgToAA(hexToRgb(palette.destroy || "#d93025"), hexToRgb(ui.bg)));
  const warn = rgbToHex(fgToAA(hexToRgb("#b06000"), hexToRgb(ui.bg)));
  // fg/fg-muted must clear AA against bg, panel AND row-selected-bg (accent-soft) —
  // deriveUiColors only guarantees AA against bg. 7 of 14 themes failed fg-muted
  // vs panel (nord-night, flexoki x2, solarized x2, catppuccin-latte, gruvbox-dark)
  // and 2 also failed fg vs panel / row-selected-fg vs row-selected-bg (solarized
  // x2) before this fix — verified via contrast-audit.mjs.
  const rowSelectedBgRgb = hexToRgb(ui["drop-hover"]);
  const fg = rgbToHex(fgToAAMulti(hexToRgb(ui.fg), [hexToRgb(ui.bg), hexToRgb(ui.bg2), rowSelectedBgRgb]));
  const fgMuted = rgbToHex(fgToAAMulti(hexToRgb(ui["fg-muted"]), [hexToRgb(ui.bg), hexToRgb(ui.bg2)]));
  // Link text sits on both the page bg and the elevated panel/pane surface (the
  // same two-background constraint fg/fg-muted above already enforce) -- a plain
  // fgToAA(accent, oneBg) could clear AA on bg and still fail on panel.
  const link = rgbToHex(fgToAAMulti(hexToRgb(palette.accent), [hexToRgb(ui.bg), hexToRgb(ui.bg2)]));
  let map = {
    bg: ui.bg, panel: ui.bg2,
    fg, "fg-muted": fgMuted, "fg-hint": ui["fg-hint"],
    accent: ui.accent, link, save, danger, warn,
    border: ui.border, "border-section": ui.divider,
    "input-bg": ui["input-bg"], "input-border": ui.border,
    "btn-bg": ui.bg2, "btn-hover": ui["drop-hover"],
    "code-bg": ui.bg2,
    "pane-bg": ui.bg2,
    "pane-divider": ui.border,
    "row-selected-bg": ui["drop-hover"],
    // Not plain `fg` any more (2026-08-06 selection rebuild). --lib-row-selected-fg
    // is the label colour for BOTH row states now: "current" (--lib-row-selected-bg,
    // which `fg` above already derives against) and "selected for a batch action",
    // whose band is mixed at runtime from accent over bg. Those two live in
    // library.css's hand-written page layer, so the percentages are duplicated
    // here on purpose -- LIB_BATCH_BAND_MIX above and library.css's
    // `--lib-band-mix` / `--lib-band-mix-hover` :root tokens must stay in step.
    // Nothing lints that pairing statically; what catches a drift is the render
    // oracle's bandDistinct entry, which measures the label against the band the
    // browser actually painted (it is what found this cliff: solarized's
    // row-selected-fg had 4.71:1 of headroom at the old 10% mix and fell straight
    // through AA at the shipped mix).
    "row-selected-fg": rgbToHex(fgToAAMulti(hexToRgb(fg), [
      rowSelectedBgRgb,
      ...LIB_BATCH_BAND_MIX.map((t) => mix(hexToRgb(ui.bg), hexToRgb(ui.accent), t).map(Math.round)),
    ])),
    ...(focus["focus-bd"] != null ? { "focus-bd": focus["focus-bd"] } : {}),
    ...(focus["focus-ring"] != null ? { "focus-ring": focus["focus-ring"] } : {}),
    ...deriveUiRadius(radius),
  };
  Object.assign(map, overrides ?? {});
  Object.assign(map, regularizeUiRadius(map));

  // The shared post-override pass keeps library's two-host soft-fill and
  // contrast contract aligned with options without duplicating its algorithm.
  map = finalizeUiControlRoles(map, palette, overrides);

  // Returns the computed map alongside the rendered text (not just text) --
  // same shape as options-chrome.mjs's emitOpt, for the same reason: a
  // derivation test needs the real, final --lib-* map, not a hand-rebuilt
  // approximation of it (weak-text-on-fill batch, Task 1).
  return { map, text: [`  color-scheme: ${mode};`, ...Object.entries(map).map(([k, v]) => `  --lib-${k}: ${v};`)].join("\n") };
}

// Compute ONE theme's real, final --lib-* color map (post-derivation,
// post-pilot-override, post-finalizer) from its raw pilot tokens JSON --
// hoisted out of composeLibraryThemes' per-entry loop below (weak-text-on-
// fill batch, Task 1, mirroring composeOptionsThemeMap -- options-chrome.mjs)
// so a derivation test can exercise the exact pipeline that ships a theme's
// CSS block for all 3 surfaces. No behavior change: composeLibraryThemes now
// calls this instead of inlining the same four lines.
export function composeLibraryThemeMap(tk, mode, useDarkMode = false) {
  const merged = useDarkMode && tk.modes?.dark ? mergeTokens(tk, tk.modes.dark) : tk;
  const palette = expandPalette(merged.palette);
  const ui = deriveUiColors(palette, mode);
  const focus = tk.ui?.popup?.[mode] ?? {};
  return emitLib(ui, palette, tk.ui?.library?.[mode], merged.radius, focus, mode);
}

// tokensByPilot: { [pilotSlug]: parsedTokensJson }
export function composeLibraryThemes(tokensByPilot) {
  const blocks = [];
  for (const entry of POPUP_THEME_MAP) {
    const tk = tokensByPilot[entry.pilot];
    if (!tk) throw new Error(`library-chrome: missing pilot ${entry.pilot} for ${entry.id}`);
    const { text } = composeLibraryThemeMap(tk, entry.mode, entry.useDarkMode);
    blocks.push(`html[data-theme="${entry.id}"] {\n${text}\n}`);
  }
  // Native-control scheme, default surface (no preset selected) -- Task 6.
  // library.html declares `<meta name="color-scheme" content="light dark">`
  // (shares options-theme-early.js's boot logic, which likewise falls back to
  // a themed preset rather than a bare dark default whenever the user
  // prefers dark with no preset picked), so this :root baseline only ever
  // applies on the light default surface -- "light" is the only value it
  // needs. Every dark preset states its own `color-scheme: dark` inside its
  // own html[data-theme] block above (see emitLib).
  const defaultBody = [`  color-scheme: light;`, ...Object.entries(DEFAULT_LIGHT).map(([k, v]) => `  --lib-${k}: ${v};`)].join("\n");
  blocks.push(`:root {\n${defaultBody}\n}`);
  return blocks.join("\n");
}
