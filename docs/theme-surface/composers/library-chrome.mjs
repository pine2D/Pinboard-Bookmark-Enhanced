import { expandPalette } from "./_util.mjs";
import { mergeTokens } from "./compose-theme.mjs";
import { deriveUiColors, deriveUiRadius, regularizeUiRadius, fgToAA, fgToAAMulti, finalizeUiControlRoles, hexToRgb, rgbToHex, FIELD_HOST_ROLES, deriveRowStates, deriveNoteMarks, NOTE_MARK_ALPHA_LIGHT, NOTE_MARK_ALPHA_DARK } from "./_ui-derive.mjs";
import { POPUP_THEME_MAP } from "./popup-chrome.mjs";

// The six S2 fills a row's TEXT can sit on (spec 2026-10-03-library-redesign
// §6.4): every state except plain hover, whose text keeps --lib-fg /
// --lib-fg-muted (fg-muted is pushed against that fill below).
const ROW_HIGHLIGHT_FILLS = ["row-current-bg", "row-current-bg-hover", "row-band-bg", "row-band-bg-hover", "row-band-current-bg", "row-band-current-bg-hover"];

// Highlighter hues for the notes excerpts (spec 2026-10-03-library-redesign
// §6.4). Light = the five --lib-note-c1..5 dot colours (library.css hand
// :root), so a row's dot and its excerpt's mark read as the same colour; dark
// = the reader's dark highlighter set (md-preview.css --hl-1..5 dark half).
// Declared here, not imported from either file: isolated contexts may repeat a
// constant (CLAUDE.md), and the reader's palette must not move when the
// library's does. Only the ALPHA is derived (deriveNoteMarks).
export const LIB_NOTE_MARK_HUES_LIGHT = Object.freeze(["#facc15", "#4ade80", "#60a5fa", "#f87171", "#c084fc"]);
export const LIB_NOTE_MARK_HUES_DARK = Object.freeze(["#D9A441", "#5E9C69", "#5689B6", "#B86F8C", "#8B72AF"]);

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
  // were #ffffff, exactly --lib-panel (and the since-retired pane fill), so a frameless control
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
  // Field family (stage 4 Task 5). NOT hand-picked: deriveFieldRoles(folded
  // :root, null, FIELD_HOST_ROLES.lib) over library.css's hand :root -- panel
  // #ffffff, bg #f7f7f8, fg #1a1a2e, fg-hint #61686f, focus-bd #3e88e9, accent
  // #1a73e8 -- and input-bg above. tests/theme-ui-derive-tests.mjs re-derives
  // them from the shipped :root on every run.
  "field-bg": "#ececed",            // = input-bg: already 1.18:1 vs panel, 1.10:1 vs bg
  "field-border": "#ececed",        // = field-bg (frame collapsed into the fill)
  "field-bg-hover": "#e0e0e2",      // one step away from both hosts (toward fg), 1.12:1 vs field-bg
  "field-border-hover": "#e0e0e2",  // = field-bg-hover
  "field-bg-focus": "#ececed",      // = field-bg (focus never repaints the fill)
  "field-border-focus": "#3e88e9",  // = focus-bd, 3.01:1 on field-bg
  "field-placeholder": "#5c636a",   // fg-hint #61686f (4.29:1 on the hover fill) pushed to 4.62:1
  "field-fg": "#1a1a2e",            // = fg: already 2.80:1 from the placeholder
  // S2 row states (spec 2026-10-03-library-redesign §6.4, C55). NOT hand-
  // picked: deriveRowStates over library.css's hand :root (bg #f7f7f8, fg
  // #1a1a2e, accent #1a73e8), then the two text roles over the same :root
  // (fg-muted #5f6368). tests/theme-ui-derive-tests.mjs re-checks every one
  // against the folded shipped :root by category (floors + minimality), and
  // pins these nine as spec anchors.
  "row-bg-hover": "#ececee",              // fg 5%: 11 from bg (hover step >= 8)
  "row-current-bg": "#d1d1d6",            // fg 17%: 38 from bg, 27 from the hover fill (>= 25 from both)
  "row-current-bg-hover": "#c8c8ce",      // + fg 5% on current: 9
  "row-band-bg": "#dce7f6",               // accent 12%: 27 from bg
  "row-band-bg-hover": "#cfdff5",         // accent 18% (band + 6 points): 13 from the band
  "row-band-current-bg": "#c3ccdc",       // band + fg 13%: 27 from the band, 25 from its hover
  "row-band-current-bg-hover": "#bbc3d3", // + fg 5%: 8
  "row-current-fg-muted": "#505458",      // fg-muted #5f6368 pushed to 4.5 on current and current+hover
  "row-selected-fg": "#1a1a2e",           // = fg, already >= 4.5 on all six highlight fills (moved here from the hand :root, value unchanged)
  // Highlighter marks (spec 2026-10-03-library-redesign §6.4). NOT hand-
  // picked: deriveNoteMarks over library.css's hand :root (bg #f7f7f8, fg
  // #1a1a2e) with the light hues and targets -- no hue needs capping on the
  // default surface (13.41 / 12.87 / 11.45 / 10.85 / 11.32 :1).
  // tests/theme-ui-derive-tests.mjs re-checks them against the folded :root.
  "note-mark-c1": "#facc1573",
  "note-mark-c2": "#4ade8066",
  "note-mark-c3": "#60a5fa66",
  "note-mark-c4": "#f8717166",
  "note-mark-c5": "#c084fc66",
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
// without an override get --lib-focus-bd from finalizeUiControlRoles
// (focusBdToAA) -- which deriveFieldRoles then reads for field-border-focus --
// while --lib-focus-ring still falls through the cascade to library.css's
// :root computed default (same color-mix(--lib-accent) formula), the ONLY
// thing that makes it resolve for those themes at all.
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
  // fg/fg-muted must clear AA against bg and panel — deriveUiColors only
  // guarantees bg. 7 of 14 themes failed fg-muted vs panel (nord-night,
  // flexoki x2, solarized x2, catppuccin-latte, gruvbox-dark) and 2 also
  // failed fg vs panel (solarized x2) before this fix — verified via
  // contrast-audit.mjs. fg additionally keeps accent-soft (drop-hover) as a
  // host: that was the old "current row" fill; S2 retired it as a row fill,
  // but dropping the host now would move fg on several themes for no
  // reason. Retire it in its own change, with its own token diff.
  const dropHoverRgb = hexToRgb(ui["drop-hover"]);
  const fg = rgbToHex(fgToAAMulti(hexToRgb(ui.fg), [hexToRgb(ui.bg), hexToRgb(ui.bg2), dropHoverRgb]));
  const fgMuted = rgbToHex(fgToAAMulti(hexToRgb(ui["fg-muted"]), [hexToRgb(ui.bg), hexToRgb(ui.bg2)]));
  // Link text sits on both the page bg and the elevated panel/pane surface (the
  // same two-background constraint fg/fg-muted above already enforce) -- a plain
  // fgToAA(accent, oneBg) could clear AA on bg and still fail on panel.
  const link = rgbToHex(fgToAAMulti(hexToRgb(palette.accent), [hexToRgb(ui.bg), hexToRgb(ui.bg2)]));
  let map = {
    bg: ui.bg, panel: ui.bg2,
    fg, "fg-muted": fgMuted, "fg-hint": ui["fg-hint"],
    accent: ui.accent, link, save, danger, warn,
    border: ui.border,
    "input-bg": ui["input-bg"], "input-border": ui.border,
    "btn-bg": ui.bg2, "btn-hover": ui["drop-hover"],
    "code-bg": ui.bg2,
    ...(focus["focus-bd"] != null ? { "focus-bd": focus["focus-bd"] } : {}),
    ...(focus["focus-ring"] != null ? { "focus-ring": focus["focus-ring"] } : {}),
    ...deriveUiRadius(radius),
  };
  Object.assign(map, overrides ?? {});
  Object.assign(map, regularizeUiRadius(map));

  // The shared post-override pass keeps library's two-host soft-fill and
  // contrast contract aligned with options without duplicating its algorithm.
  map = finalizeUiControlRoles(map, palette, overrides, {
    // Field family (stage 4 Task 5): library value boxes sit on the panel
    // surfaces and on the page bg, so both are hosts. With [panel] alone the
    // two themes whose fill lies between them (catppuccin-mocha,
    // gruvbox-dark) would step their hover toward the page bg until it
    // dissolves there (1.002 / 1.003). library emits every map key, so no
    // whitelist to extend. No field-chevron: library has no native <select>
    // since the redesign (every select is a listbox.js .listbox-btn, whose
    // arrow is a .btn-ic SVG in field-placeholder), so the role had no reader.
    fieldRoles: true,
    fieldHostRoles: FIELD_HOST_ROLES.lib,
  });

  // S2 row states (spec 2026-10-03-library-redesign §3.8 / §6.4; COMPONENTS.md
  // §9.1 law 3, C55). After the finalizer, from the bg / fg / accent this block
  // actually ships: the finalizer moves fg on solarized x2, and a row fill
  // derived from the pre-gap-fill fg would sit a step off what is painted.
  const rows = deriveRowStates(hexToRgb(map.bg), hexToRgb(map.fg), hexToRgb(map.accent));
  for (const [role, rgb] of Object.entries(rows)) map[role] = rgbToHex(rgb);
  // fg-muted is painted on the plain hover fill too (row gloss / meta /
  // groups, toggle counts): add it as a host so a hovered row cannot drop its
  // secondary text under AA (github-light 4.47 -> #606871 4.82; the other 14
  // blocks are unchanged). A pilot fg-muted override is a TEXT input and wins
  // verbatim (NEW_THEME.md). btn-fg-muted was derived inside the finalizer
  // from the unpushed value and still clears its own two hosts -- left alone.
  if (overrides?.["fg-muted"] == null) {
    map["fg-muted"] = rgbToHex(fgToAAMulti(hexToRgb(map["fg-muted"]), [hexToRgb(map.bg), hexToRgb(map.panel), rows["row-bg-hover"]]));
  }
  // Title of the current row and every text on a selected row.
  map["row-selected-fg"] = rgbToHex(fgToAAMulti(hexToRgb(map.fg), ROW_HIGHLIGHT_FILLS.map((role) => rows[role])));
  // Secondary text (and the delete X) on the current, not-selected row:
  // fg-muted falls under 4.5 on the current fill on 12 of 15 blocks.
  map["row-current-fg-muted"] = rgbToHex(fgToAAMulti(hexToRgb(map["fg-muted"]), [rows["row-current-bg"], rows["row-current-bg-hover"]]));
  // Notes highlighter marks (spec 2026-10-03-library-redesign §5.4 / §6.4).
  // Last, from the bg and fg this block ships: the quote under a mark is plain
  // fg, so the alpha is capped until fg clears 4.5:1 on the composite.
  const markDark = mode === "dark";
  const marks = deriveNoteMarks(hexToRgb(map.bg), hexToRgb(map.fg),
    (markDark ? LIB_NOTE_MARK_HUES_DARK : LIB_NOTE_MARK_HUES_LIGHT).map((h) => hexToRgb(h)),
    markDark ? [0, 0, 0, 0, 0].map(() => NOTE_MARK_ALPHA_DARK) : NOTE_MARK_ALPHA_LIGHT);
  marks.forEach((hex, i) => { map[`note-mark-c${i + 1}`] = hex; });

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
