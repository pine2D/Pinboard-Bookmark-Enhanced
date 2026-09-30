import { expandPalette } from "./_util.mjs";
import { mergeTokens } from "./compose-theme.mjs";
import { deriveUiColors, deriveUiRadius, regularizeUiRadius, fgToAA, fgToAAMulti, finalizeUiControlRoles, hexToRgb, rgbToHex, resolveOpaqueBg, isCompositableBg, FIELD_HOST_ROLES, FIELD_ROLES } from "./_ui-derive.mjs";

// popup theme id -> { pilot, mode, useDarkMode? }
// 12 themes map 1:1; the flexoki pilot yields BOTH flexoki-light and flexoki-dark.
export const POPUP_THEME_MAP = [
  { id: "modern-card", pilot: "modern-card", mode: "light" },
  { id: "nord-night", pilot: "nord-night", mode: "dark" },
  { id: "terminal", pilot: "terminal", mode: "dark" },
  { id: "paper-ink", pilot: "paper-ink", mode: "light" },
  { id: "dracula", pilot: "dracula", mode: "dark" },
  { id: "flexoki-light", pilot: "flexoki", mode: "light" },
  { id: "flexoki-dark", pilot: "flexoki", mode: "dark", useDarkMode: true },
  { id: "solarized-light", pilot: "solarized-light", mode: "light" },
  { id: "solarized-dark", pilot: "solarized-dark", mode: "dark" },
  { id: "catppuccin-latte", pilot: "catppuccin-latte", mode: "light" },
  { id: "catppuccin-mocha", pilot: "catppuccin-mocha", mode: "dark" },
  { id: "gruvbox-dark", pilot: "gruvbox-dark", mode: "dark" },
  { id: "rose-pine", pilot: "rose-pine", mode: "dark" },
  { id: "github-light", pilot: "github-light", mode: "light" },
];

// Default-surface (no preset selected) component-layer baseline — Task 5,
// step ① of the composer color migration. Every value below is copied
// VERBATIM from the CSS literal it stands in for today, so adding these
// declarations changes nothing currently rendered (nothing consumes these
// 5 names yet — Task 8/9/12/13 do): a later task that swaps a hardcoded
// literal for var(--pp-*) finds the identical color already seeded here.
// Source-line table: task-5-report.md.
const DEFAULT_LIGHT = {
  "btn-fg": "#2a2d33",          // = --pp-fg default (popup.css:25). Popup has no unified .btn
                                 // today, so there is no ButtonText fallback to preserve; the
                                 // themed derivation's fgToAAMulti(fg, [bg2, drop-hover]) candidate
                                 // IS --pp-fg and is already AA-clear against both, so this mirrors
                                 // that formula's (identity) result rather than guessing.
  "btn-fg-muted": "#5d6269",    // weak-text-on-fill batch, D1: fgToAAMulti(--pp-fg-muted default
                                 // #62676e, [btn-bg, btn-hover] below) -- raw fg-muted clears btn-bg
                                 // (4.82:1) but not btn-hover (4.38:1), so this moves. #5d6269 ships
                                 // at 5.20:1 / 4.72:1.
  "chip-bg": "#e2eafa",         // = --pp-tag-bg default (popup.css:53)
  "chip-fg": "#33589f",         // = --pp-tag-fg default (popup.css:54)
  "ai-chip-fg": "#7b45c1",      // D8/D9, taste-uplift-batch3: this block has no emit path through
                                 // finalizeUiControlRoles (DEFAULT_LIGHT is a hand-authored literal
                                 // block, not run through the composer pipeline), so the value is
                                 // hand-carried from the SAME shared function ai-chip-fg's themed
                                 // derivation calls: fgToAAMulti(accent2 default #8b5cc9 [popup.css:43],
                                 // [chip-bg above, btn-hover below]) — 5.02:1 / 4.66:1, both clear AA
                                 // (raw accent2 measured only 3.97:1 / 4.38:1 against this surface's
                                 // btn-bg/bg2 pre-derivation, Step 0).
  "danger-quiet-fg": "#bd3d3d", // WAS a verbatim copy of --pp-danger default (#c24343); re-derived
                                 // 2026-08-05 because Soft Fill's btn-bg (#eff0f2) is a darker fill
                                 // than the #ffffff this text used to sit on, dropping it to 4.41:1.
                                 // fgToAAMulti(danger, [bg, bg2, btn-bg]) — 5.39 / 5.03 / 4.56:1.
                                 // Re-checked 2026-09-21 against the 1.10-separated btn-bg (#ebecee);
                                 // #bd3d3d unchanged, still clears (4.56:1, a thin margin over 4.5).
  "on-danger": "#ffffff",       // = .confirm-popover .confirm-yes `color` default light (popup.css:2048)
  "on-accent": "#ffffff",       // = --pp-on-accent default (popup.css:47) -- moved here design-uplift
                                 // Task 13 step 2, retiring the hand-written :root duplicate of the
                                 // exact same "default value when no preset is active" role this
                                 // block already exists for.
  "preset-fg": "#2d5cb9",       // NOT a literal copy: the default surface's .preset-btn read
                                 // var(--pp-link) (#3f6fd0) for text, which is only 4.27:1 on
                                 // --pp-preset-btn-bg (#eef2ff) and 3.63:1 on-hover
                                 // (--pp-preset-btn-hover-bg, #d5e0ff) -- both below AA, the same
                                 // never-audited-pair class as the themed preset-fg gap Task 13's
                                 // main pass fixed. Derived the same way: fgToAAMulti(link, [preset-
                                 // btn-bg, preset-btn-hover-bg]) — 5.62:1 / 4.77:1, both clear AA
                                 // (design-uplift Task 13 review round).
  "btn-bg": "#ebecee",          // NOT a literal copy (Soft Fill, design-uplift 2026-08-05): popup had no
                                 // button-fill role at all -- .qbtn/.submit-bar button painted --pp-bg on
                                 // the default surface and --pp-bg2 under every preset, i.e. the same
                                 // token that paints the .quick-actions strip they sit ON. With the
                                 // resting frame gone that is an invisible button. fillSeparate(bg2,
                                 // [bg, bg2], fg) -- 1.18:1 vs --pp-bg, 1.10:1 vs --pp-bg2 (re-derived
                                 // 2026-09-21, FILL_SEPARATE_MIN 1.06 -> 1.10; was #eff0f2).
  "btn-bd": "#ebecee",          // = btn-bg: the resting border collapses INTO the fill (border-width
                                 // kept, zero layout shift). terminal restores a real frame through its
                                 // pilot ui.popup override; nothing else does.
  "btn-hover": "#dbe2ef",       // NOT a literal copy: --pp-drop-hover (#e6eefb) is only 1.02:1 against
                                 // the new btn-bg above -- with rest no longer white, the old hover fill
                                 // stopped reading as a change at all. fillSeparate(drop-hover, [btn-bg],
                                 // fg) -- 1.10:1 vs rest, still the same accent-tinted family. (re-derived
                                 // 2026-09-21 alongside btn-bg; was #dee5f2).
  // input-bd: no longer emitted (stage 4 Task 6). popup's value boxes paint
  // --pp-field-border from FIELD_TARGETS.pp; the pilot key ui.popup.<mode>
  // ["input-bd"] stays the finalizer's framed-field signal (inputBorderRole).
  "border": "#78859c",          // NOT a literal copy: the hand-written :root's old #e8eaee was only
                                 // 1.12:1 against --pp-bg2 (design-uplift Task 16, USER RULING --
                                 // border reads visibly heavier now, the intended effect). Derived the
                                 // same way the themed border is:
                                 // borderToAA(border, [btn-bg, bg2]) — 3.15:1 / 3.48:1. Re-derived
                                 // 2026-09-21 (was #7e8aa0, which had dropped to 2.95:1 against the
                                 // 1.10-separated btn-bg above) for FILL_SEPARATE_MIN 1.06 -> 1.10;
                                 // before that, re-derived 2026-08-05 (was #848fa4 against a btn-bg
                                 // that was still bg2).
  // Field family (stage 4 Task 5). NOT hand-picked: deriveFieldRoles(folded
  // :root, null, FIELD_HOST_ROLES.pp) over popup.css's hand :root -- bg
  // #ffffff, input-bg #e9ecf0, fg #2a2d33, fg-hint #666b72, focus-bd #5686de,
  // accent #3b72d9. tests/theme-ui-derive-tests.mjs re-derives all eight, and
  // the two chip inks, from the shipped :root on every run.
  "field-bg": "#e9ecf0",            // = input-bg: already 1.19:1 vs bg
  "field-border": "#e9ecf0",        // = field-bg (frame collapsed into the fill)
  "field-bg-hover": "#dee1e6",      // one step away from bg (toward fg), 1.11:1 vs field-bg
  "field-border-hover": "#dee1e6",  // = field-bg-hover
  "field-bg-focus": "#e9ecf0",      // = field-bg (focus never repaints the fill)
  "field-border-focus": "#5686de",  // = focus-bd, 3.02:1 on field-bg
  "field-placeholder": "#5c6167",   // fg-hint #666b72 (4.10:1 on the hover fill) pushed to 4.77:1
  "field-fg": "#2a2d33",            // = fg: already 2.21:1 from the placeholder
  "tag-chip-fg": "#33589f",         // = tag-fg: 5.72:1 on tag-bg #e2eafa, 5.19:1 on tag-hover #d3e0f7
  "tag-chip-icon": "#62676e",       // = fg-muted: 4.72:1 / 4.28:1 on the same two chip fills (min 3)
};
// DEFAULT_DARK (the popup's `html.dark` component-layer tokens) is gone:
// since the theme model of 2026-08-25 (batch 2 D6) the popup's no-preset
// dark resolves to the flexoki-dark preset, so nothing sets the `dark` class
// and the block it emitted was dead. The preset's own html[data-theme]
// block carries every one of those roles, derived + audited like any theme.

// mode drives the native-control scheme (scrollbar, number spinner, calendar
// picker etc.) for this theme's own block -- Task 6. Previously a separate
// hand-written selector list in popup.css grouped the 8 dark presets against
// a single `{ color-scheme: dark; }` rule (light presets got no explicit
// declaration and relied on the :root default below); now every block states
// its own scheme directly, one property per theme, no separate list to keep
// in sync when a new preset is added.
function emitPp(ui, mode) {
  const lines = [`  color-scheme: ${mode};`];
  const set = (k, val) => lines.push(`  --pp-${k}: ${val};`);
  for (const k of ["bg", "bg2", "fg", "fg-muted", "fg-hint", "link", "accent", "accent2",
    "border", "divider", "input-bg", "input-focus-bg", "tag-bg", "tag-fg", "tag-hover", "drop-hover",
    "chip-bg", "chip-fg", "ai-chip-fg", "btn-bg", "btn-bd", "btn-hover", "btn-fg", "btn-fg-muted",
    "banner-bg", "banner-bd", "banner-fg", "warn-bg", "warn-bd", "warn-fg",
    "ok-bg", "ok-bd", "ok-fg", "offline-bg", "offline-bd", "offline-fg",
    "danger", "danger-quiet-fg", "on-danger", "spinner-bg", "spinner-fg", "preset-bg", "preset-fg",
    "radius-sm", "radius-md", "radius-lg", "radius-tag", "focus-bd", "focus-ring", "on-accent",
    // Stage 4 Task 5: the field family and the chip inks. This list is a
    // whitelist -- a role the finalizer computes but this list omits is
    // silently not emitted, and ui-token-coverage cannot see that (it only
    // reports tokens that are consumed and undefined).
    // tests/theme-ui-derive-tests.mjs checks every block for every role.
    ...FIELD_ROLES, "tag-chip-fg", "tag-chip-icon"]) {
    if (ui[k] != null) set(k, ui[k]);
  }
  // info-* are aliases of banner-* (no separate derivation)
  set("info-bg", "var(--pp-banner-bg)");
  set("info-bd", "var(--pp-banner-bd)");
  set("info-fg", "var(--pp-banner-fg)");
  return lines.join("\n");
}

// The three fills a popup tag chip is painted on (see tag-chip-fg below):
// tag-bg over the resting tags shell, tag-bg over the hovered shell, and
// tag-hover over the hovered shell. resolveOpaqueBg: a `transparent` tag-bg
// (8/14 blocks) IS the shell, an opaque one ignores it, an #rrggbbaa one is
// composited over it. Any other spelling (rgba(), var(), a named colour...)
// would ALSO read as the shell -- a guessed backdrop the chip inks would then
// be derived against -- so it throws, naming the role and the value, and
// sync-all aborts (contrast-audit's tagChipInkRows refuses the same set).
function tagChipBackdrops(map) {
  for (const [role, allowTransparent] of [["tag-bg", true], ["tag-hover", false]]) {
    if (!isCompositableBg(map[role], { allowTransparent })) {
      throw new Error(`popup-chrome: tag chip backdrop ${role}=${JSON.stringify(map[role])} is not #rgb / #rrggbb / #rrggbbaa${allowTransparent ? " or transparent" : ""} -- resolveOpaqueBg would read it as the tags shell`);
    }
  }
  const shellRest = hexToRgb(map["field-bg"]);
  const shellHover = hexToRgb(map["field-bg-hover"]);
  return [
    resolveOpaqueBg(map["tag-bg"], shellRest),
    resolveOpaqueBg(map["tag-bg"], shellHover),
    resolveOpaqueBg(map["tag-hover"], shellHover),
  ];
}

// Compute ONE theme's real, final --pp-* color map (post-derivation,
// post-pilot-override, post-finalizer) from its raw pilot tokens JSON --
// hoisted out of composePopupThemes' per-entry loop below (weak-text-on-fill
// batch, Task 1, mirroring composeOptionsThemeMap's own extraction --
// options-chrome.mjs) so a derivation test can exercise the exact pipeline
// that ships a theme's CSS block for all 3 surfaces, instead of hand-
// rebuilding an approximation that could silently drift from the real one.
// No behavior change: composePopupThemes now calls this instead of inlining
// the same body.
export function composePopupThemeMap(tk, mode, useDarkMode = false) {
  const merged = useDarkMode && tk.modes?.dark ? mergeTokens(tk, tk.modes.dark) : tk;
  const palette = expandPalette(merged.palette);
  // Pilot-level ui overrides (tokens.json `ui.popup.<mode>`) win over derivation:
  // theme-specific refinements the palette derivation cannot express.
  const derived = deriveUiColors(palette, mode);
  // on-accent is emitted EXPLICITLY for every theme (default: the theme bg,
  // the long-standing submit-button text derivation). It must not fall back
  // through var() to :root's light-surface white: custom properties inherit,
  // so a var(--pp-on-accent, ...) fallback in a shared rule is dead code —
  // the exact mistake that turned every themed submit button white (2026-07).
  // Radius is DERIVED now, not override-only. Before this, --pp-radius-* was
  // emitted solely where a pilot restated it, so 9 of the 13 themes silently
  // fell back to :root's generic 3/8/10 while their site CSS used the pilot's
  // own scale. regularizeUiRadius runs last so an override cannot reintroduce
  // an inversion (paper-ink shipped lg:3px under md:4px).
  let ui = {
    ...derived, "on-accent": derived.bg,
    ...deriveUiRadius(merged.radius),
    ...(tk.ui?.popup?.[mode] ?? {}),
  };
  Object.assign(ui, regularizeUiRadius(ui));
  const ppO = tk.ui?.popup?.[mode] ?? {};
  // Popup shares the control finalizer but names its panel and frame roles
  // differently. Its chip fill is tinted the same way options/library's is
  // (Task 4, taste-uplift-batch3, D9) -- the chipMode: "verbatim" escape
  // hatch this composer used to pass (chip-bg = the raw tag-bg literal,
  // including the bare "transparent" 8/13 pilots declare) is gone; see
  // _ui-derive.mjs's finalizeUiControlRoles for the single tinted path all
  // 3 surfaces now share.
  ui["btn-bg"] ??= ui.bg2;
  ui["btn-hover"] ??= ui["drop-hover"];
  ui = finalizeUiControlRoles(ui, palette, ppO, {
    panelRole: "bg2",
    buttonBorderRole: "btn-bd",
    inputBorderRole: "input-bd",
    // on-accent stays popup's own INPUT role (already set unconditionally
    // above via `"on-accent": derived.bg`, then possibly overridden by
    // ppO) -- this only says "don't clobber it", never "always derive"
    // (Task 4, taste-uplift-batch2).
    onAccentIsInput: true,
    // Field family (stage 4 Task 5): every popup value box sits on --pp-bg
    // (popup.css: `body` and `html[data-theme]` both paint `background:
    // var(--pp-bg)`), never on bg2 -- the panelRole above names the strip
    // the buttons sit on, not the fields' host. The framed signal is the pilot's own ui.popup.<mode>.input-bd
    // (terminal only, `var(--pp-border)`).
    fieldRoles: true,
    fieldHostRoles: FIELD_HOST_ROLES.pp,
  });
  // ai-chip-fg (Task 4, taste-uplift-batch3, D8): popup-only OUTPUT role
  // (UI_DERIVED_OUTPUT_ROLES.popup, _ui-derive.mjs) for AI-suggested text
  // painted on a chip fill (.stag.ai). --pp-accent2 is a raw, ungated
  // palette value (link-visited) shared with .action-link/.regen-link and
  // carries no AA guarantee of its own -- Step 0 measured it as low as
  // 3.18:1 against --pp-btn-bg on several pilots. Same fgToAAMulti(seed,
  // [chip-bg, btn-hover]) shape chip-fg gets just above (pressable chip's
  // hover-fill swap), seeded from accent2 instead of tag-fg so the AI
  // purple hue survives while text stays legible on both fills. MUST run
  // AFTER finalizeUiControlRoles above: it reads ui["chip-bg"], the final
  // fillDistinct()-tinted value, not the pre-tint tag-bg -- deriving
  // against the wrong (pre-tint) fill would drift from what actually ships,
  // the same ordering discipline chip-fg itself already follows inside the
  // finalizer.
  ui["ai-chip-fg"] = rgbToHex(fgToAAMulti(
    hexToRgb(ui["accent2"]),
    [hexToRgb(ui["chip-bg"]), hexToRgb(ui["btn-hover"])],
  ));
  // tag-chip-fg / tag-chip-icon (stage 4 Task 5, spec §2.2 / F9): the text
  // and the remove-x ink of a .tag-item inside the tags shell, measured on
  // all three backdrops tagChipBackdrops() lists. Seeds stay tag-fg /
  // fg-muted (TEXT inputs, taken verbatim) and move only where they miss
  // 4.5:1 / 3:1 on one of those backdrops: 6/14 themes move the text
  // (nord-night, solarized x2 on the shell; flexoki-dark, catppuccin x2 on
  // their own tag-hover), only catppuccin-mocha moves the icon (2.999 on
  // tag-hover). MUST run after finalizeUiControlRoles: the backdrops read
  // the final field-bg / field-bg-hover.
  const tagChipBases = tagChipBackdrops(ui);
  ui["tag-chip-fg"] = rgbToHex(fgToAAMulti(hexToRgb(ui["tag-fg"]), tagChipBases, 4.5));
  ui["tag-chip-icon"] = rgbToHex(fgToAAMulti(hexToRgb(ui["fg-muted"]), tagChipBases, 3));
  // preset-bd RETIRED (design-uplift, preset-row Variant A, 2026-08-04):
  // `.preset-btn` is borderless now (COMPONENTS.md Appendix C30), so no
  // rule anywhere reads --pp-preset-bd -- removed from emitPp's key list
  // above rather than left as a defined-but-unconsumed token (the prior
  // state this comment used to document: Task 16's border-weight
  // back-and-forth, unified light-side per USER CHECKPOINT, superseded by
  // the full redesign that removed the border entirely). deriveUiColors
  // (_ui-derive.mjs) still computes ui["preset-bd"] internally -- shared
  // by options/library-chrome.mjs too, not worth a bespoke per-surface
  // return shape just to omit one field nobody reads once popup's own
  // emission list drops it.
  // preset-fg (design-uplift Task 13, USER RULING): deriveUiColors emits it
  // as a raw palette copy (hx("accent")), with no AA guarantee against its
  // own preset-bg -- contrast-audit's orphan guard caught 6/14 themes at
  // 3.0-4.3:1 (modern-card/flexoki-dark/solarized-light/solarized-dark/
  // catppuccin-latte/gruvbox-dark), the exact same "unaudited paired token"
  // class Task 5/7 already fixed for btn-fg/chip-fg. preset-bg is always a
  // plain hex (never "transparent" like tag-bg can be, verified across all
  // 13 pilots), so no resolveOpaqueBg needed. drop-hover is included
  // because .preset-btn:hover swaps its fill to --pp-drop-hover while
  // keeping the same text color (popup.css's generic html[data-theme]
  // .preset-btn:hover rule) -- today preset-bg and drop-hover are the same
  // source value (both hx("accent-soft")) so this is currently a single
  // effective constraint, but fgToAAMulti keeps the derivation correct if a
  // future pilot ui.popup override ever splits them apart.
  const presetBgRgb = hexToRgb(ui["preset-bg"]);
  ui["preset-fg"] = rgbToHex(fgToAAMulti(hexToRgb(ui["preset-fg"]), [presetBgRgb, hexToRgb(ui["btn-hover"])]));
  // spinner-fg (design-uplift Task 13, USER RULING): same raw-copy gap as
  // preset-fg above, but the loading-spinner ring is a non-text UI
  // indicator (WCAG 1.4.11's 3:1 floor, not the 4.5:1 text minimum) --
  // 3/14 blocks measured below 3:1 (flexoki-dark 2.71, solarized-light
  // 2.32, solarized-dark 2.63). spinner-bg is USUALLY a plain hex (border
  // role) but terminal's is an 8-digit alpha hex (#33ff3340, a translucent
  // glow) -- resolveOpaqueBg composites it against bg2 first (same
  // treatment chip-bg's derivation already gives tag-bg's "transparent"
  // case above), since hexToRgb() alone would silently misparse an 8-digit
  // value as a 6-digit one.
  ui["spinner-fg"] = rgbToHex(fgToAA(hexToRgb(ui["spinner-fg"]), resolveOpaqueBg(ui["spinner-bg"], hexToRgb(ui["btn-bg"])), 3));
  return ui;
}

// tokensByPilot: { [pilotSlug]: parsedTokensJson }
export function composePopupThemes(tokensByPilot) {
  const blocks = [];
  for (const entry of POPUP_THEME_MAP) {
    const tk = tokensByPilot[entry.pilot];
    if (!tk) throw new Error(`popup-chrome: missing pilot ${entry.pilot} for ${entry.id}`);
    const ui = composePopupThemeMap(tk, entry.mode, entry.useDarkMode);
    blocks.push(`html[data-theme="${entry.id}"] {\n${emitPp(ui, entry.mode)}\n}`);
  }
  // Default surface = the light baseline only: the popup's no-preset dark is
  // the flexoki-dark preset block above (theme model 2026-08-25, batch 2 D6),
  // the same fallback options-theme-early.js uses for Options / Library.
  const emitDefault = (obj, scheme) => [`  color-scheme: ${scheme};`, ...Object.entries(obj).map(([k, v]) => `  --pp-${k}: ${v};`)].join("\n");
  blocks.push(`:root {\n${emitDefault(DEFAULT_LIGHT, "light")}\n}`);
  return blocks.join("\n");
}
