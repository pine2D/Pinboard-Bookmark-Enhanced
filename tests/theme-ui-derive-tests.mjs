import { readFileSync } from "node:fs";
import {
  contrast,
  deltaE2000,
  fillDistinct,
  fillSeparate,
  FILL_SEPARATE_MIN,
  finalizeUiControlRoles,
  hexToRgb,
  mix,
  relLum,
  resolveOpaqueBg,
  rgbToHex,
  TIER_DISTINCT_MIN_DE,
} from "../docs/theme-surface/composers/_ui-derive.mjs";
import { composeOptionsThemeMap } from "../docs/theme-surface/composers/options-chrome.mjs";
import { POPUP_THEME_MAP } from "../docs/theme-surface/composers/popup-chrome.mjs";

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const ratio = (fg, bg) => contrast(hexToRgb(fg), hexToRgb(bg));

const palette = {
  "btn-fg": "#ffffff",
  "tag-bg": "transparent",
  "tag-fg": "#0055aa",
};
const base = {
  bg: "#ffffff",
  panel: "#ffffff",
  fg: "#111111",
  accent: "#0055aa",
  danger: "#bb2222",
  border: "#eeeeee",
  "btn-bg": "#ffffff",
  "btn-hover": "#ffffff",
  "input-bg": "#ffffff",
};
const before = structuredClone(base);
const finalized = finalizeUiControlRoles(base, palette);

check(JSON.stringify(base) === JSON.stringify(before),
  "finalizeUiControlRoles must not mutate the caller's map");
check(finalized["btn-bg"] !== base["btn-bg"] && finalized["input-bg"] !== base["input-bg"],
  "frameless controls must be separated from their host fills");
check(finalized["btn-border"] === finalized["btn-bg"] &&
  finalized["input-border"] === finalized["input-bg"],
"resting control borders must collapse into their final fills");
check(ratio(finalized["btn-fg"], finalized["btn-bg"]) >= 4.5 &&
  ratio(finalized["btn-fg"], finalized["btn-hover"]) >= 4.5,
"button foreground must clear AA on rest and hover fills");
check([finalized.bg, finalized.panel, finalized["btn-bg"]]
  .every((bg) => ratio(finalized["danger-quiet-fg"], bg) >= 4.5),
"quiet danger text must clear AA on every supported host");

// github-light's real ghost-danger hover fill: 8% #cf222e over 92% #f6f8fa,
// hand-composited and rounded to the emitted sRGB byte values. The resting
// hosts all pass with the raw danger red, while this tint drops it to 4.44:1.
const githubLike = finalizeUiControlRoles({
  bg: "#f6f8fa",
  panel: "#ffffff",
  fg: "#1f2328",
  accent: "#0969da",
  danger: "#cf222e",
  border: "#d0d7de",
  "btn-bg": "#f6f8fa",
  "btn-hover": "#ddf4ff",
  "input-bg": "#f6f8fa",
}, {
  "btn-fg": "#ffffff",
  "tag-bg": "transparent",
  "tag-fg": "#0550ae",
});
check(ratio(githubLike["danger-quiet-fg"], "#f3e7ea") >= 4.5 &&
  ratio(githubLike["danger-quiet-fg"], "#ece0e3") >= 4.5,
"quiet danger text must clear AA on settled 8% ghost and regular hover fills");
check(ratio(finalized["on-danger"], finalized.danger) >= 4.5,
  "solid danger foreground must clear AA");
check(finalized["chip-bg"] !== "transparent" &&
  ratio(finalized["chip-fg"], finalized["chip-bg"]) >= 4.5 &&
  ratio(finalized["chip-fg"], finalized["btn-hover"]) >= 4.5,
"tinted chip roles must stay visible and readable in rest and hover states");

const framed = finalizeUiControlRoles(base, palette, {
  "btn-border": "#123456",
  "input-border": "#654321",
});
check(framed["btn-bg"] === base["btn-bg"] && framed["input-bg"] === base["input-bg"],
  "explicit frames must preserve the caller's control fills");
check(framed["btn-border"] === "#123456" && framed["input-border"] === "#654321",
  "explicit frame colors must win unchanged");

const tagged = finalizeUiControlRoles({
  ...base,
  "tag-bg": "#220000",
  "tag-fg": "#ffffff",
}, palette, {
  "tag-bg": "#220000",
  "tag-fg": "#ffffff",
});
check(tagged["chip-bg"] === "#220000" && tagged["chip-bg"] !== palette["tag-bg"],
  "tinted chip derivation must consume the final post-override tag background");
check(ratio(tagged["chip-fg"], tagged["chip-bg"]) >= 4.5,
  "tinted chip foreground must be re-derived from the final tag foreground");

const popupBase = {
  ...base,
  bg2: base.panel,
  "tag-bg": "transparent",
  "tag-fg": "#0055aa",
};
delete popupBase.panel;
const popup = finalizeUiControlRoles(popupBase, palette, {}, {
  panelRole: "bg2",
  buttonBorderRole: "btn-bd",
  inputBorderRole: "input-bd",
  chipMode: "verbatim",
});
check(popup["chip-bg"] === "transparent",
  "popup chip background must preserve the final tag background verbatim");
const popupChipBg = resolveOpaqueBg(popup["chip-bg"], hexToRgb(popup.bg2));
check(contrast(hexToRgb(popup["chip-fg"]), popupChipBg) >= 4.5 &&
  ratio(popup["chip-fg"], popup["btn-hover"]) >= 4.5,
"popup chip foreground must clear AA against the composited tag fill and hover fill");

// --- on-accent: OUTPUT role for options/library, INPUT role for popup
// (Task 4, taste-uplift-batch2 -- `.btn.primary`'s fill/text pair). Neither
// options nor library has ever declared this role, so (unlike on-danger,
// which every surface already had a literal for) there is no legacy value
// to preserve -- it is always derived, the same way on-danger is. ---
check(ratio(finalized["on-accent"], finalized.accent) >= 4.5,
  "options/library on-accent (no onAccentIsInput config) must be derived and clear AA against accent");

// A value already sitting in the map before this call (a stray key, or a
// pilot override validate-contracts should have blocked) must NOT survive
// for options/library: on-accent is an OUTPUT role there, unconditionally
// recomputed every call, never trusted as an input the way on-danger never
// is either.
const poisonedOnAccent = finalizeUiControlRoles({ ...base, "on-accent": "#000000" }, palette);
check(poisonedOnAccent["on-accent"] !== "#000000" && ratio(poisonedOnAccent["on-accent"], poisonedOnAccent.accent) >= 4.5,
  "options/library on-accent must be unconditionally recomputed, never left at a pre-existing value");

// popup: on-accent IS an input (its own composer always supplies one before
// calling here, and 5/13 pilots override it). A given value must survive
// untouched even when it fails AA -- popup's own composer is the one place
// allowed to choose a value the derivation would not have picked.
const popupGivenOnAccent = finalizeUiControlRoles({ ...base, "on-accent": "#000000" }, palette, {}, {
  onAccentIsInput: true,
});
check(popupGivenOnAccent["on-accent"] === "#000000",
  "popup (onAccentIsInput: true) must keep a caller-supplied on-accent unchanged, even off-AA");

// popup with NO on-accent supplied (the gap the brief's `== null` guard
// exists for) must still get a derived, AA-clearing value -- the config flag
// only stops an OVERWRITE of a given value, it does not disable the fallback.
const popupNoOnAccent = finalizeUiControlRoles(base, palette, {}, { onAccentIsInput: true });
check(popupNoOnAccent["on-accent"] != null && ratio(popupNoOnAccent["on-accent"], popupNoOnAccent.accent) >= 4.5,
  "popup (onAccentIsInput: true) must still derive on-accent when none was given");

// --- fillSeparate: the Soft Fill separation floor (COMPONENTS.md §9.1 law 2) ---
{
  check(FILL_SEPARATE_MIN === 1.10, "user ruling 2026-09-21: 1.10, not 1.06 and not 1.15");
  const fg = hexToRgb("#1a1a2e"), panel = hexToRgb("#ffffff"), bg = hexToRgb("#f0f2f5");
  const rounded = (c) => hexToRgb(rgbToHex(c));
  // 1. clears EVERY host, measured on the hex-rounded value that actually ships
  const out = fillSeparate(hexToRgb("#ffffff"), [panel, bg], fg);
  for (const host of [panel, bg]) {
    check(contrast(rounded(out), host) >= FILL_SEPARATE_MIN,
      `separated fill must clear ${FILL_SEPARATE_MIN} vs every host`);
  }
  // 2. identity when the pair already clears: an already-separated theme must emit byte-for-byte unchanged
  const far = hexToRgb("#c8c8d0");
  check(JSON.stringify(fillSeparate(far, [panel, bg], fg)) === JSON.stringify(far),
    "already-separated fill is returned untouched");
  // 3. it only ever moves toward fg (keeps the fill's own tint family)
  const tinted = hexToRgb("#eef3ff");
  const moved = fillSeparate(tinted, [panel, bg], fg);
  check(relLum(moved) <= relLum(tinted),
    "on a light surface the fill darkens toward fg, never lightens");
  // 4. the explicit-min form still works (callers may pin a different floor)
  check(contrast(rounded(fillSeparate(hexToRgb("#ffffff"), [panel], fg, 1.3)), panel) >= 1.3,
    "explicit min argument overrides the default floor");
}

// --- fillDistinct: two control TIERS must be tellable apart (COMPONENTS.md §1.2 tonal / §5 selectable) ---
{
  check(TIER_DISTINCT_MIN_DE === 6, "the tier-distinctness floor is ΔE 6, contrast-audit's own STATE_DELTA_MIN_DE yardstick");
  const accent = hexToRgb("#89b4fa");
  const same = hexToRgb("#45475a");                       // catppuccin-mocha: chip-bg === btn-bg, ΔE 0
  const out = fillDistinct(same, [same], accent);
  check(deltaE2000(hexToRgb(rgbToHex(out)), same) >= 6,
    "identical fills are pushed apart, measured on the rounded value");
  // moves TOWARD the accent (keeps the chip's hue identity), not toward fg
  check(deltaE2000(out, accent) < deltaE2000(same, accent),
    "distance to the accent shrinks");
  // identity when already distinct
  const blue = hexToRgb("#ddf4ff"), grey = hexToRgb("#f0f1f1");   // github-light, ΔE 8.5
  check(JSON.stringify(fillDistinct(blue, [grey], accent)) === JSON.stringify(blue),
    "already-distinct fill is returned untouched");
}

// --- fg-hint / fg-muted must clear AA on BOTH the page bg and the ELEVATED
// panel, on the rounded hex that ships, for EVERY pilot x mode options-
// chrome.mjs actually renders (Task 3, taste-uplift-batch2 tokens batch,
// 2026-09-21, fix round 1). contrast-audit's bg2/panel blind spot let
// flexoki-light's options fg-hint ship at 4.47:1 against --opt-panel: a
// pilot's ui.options.<mode>.fg-hint/fg-muted override is a plain literal the
// pilot author chose (input roles win by contract -- NEW_THEME.md -- so the
// derivation does not adjust them), and nothing had ever checked such an
// override against `panel` for options (or against ANYTHING for library's
// fg-hint). The gate closes the blind spot; this test asserts the CATEGORY
// ("no pilot's hint-tier override fails AA on options"), not one instance --
// it walks POPUP_THEME_MAP (the same pilot+mode enumeration
// composeOptionsThemes itself iterates, so it never invents a mode a pilot
// isn't actually rendered in) and builds each theme's real map via
// composeOptionsThemeMap, the exact composer pipeline. Library/popup have no
// equivalent exported per-theme map builder (only composeLibraryThemes /
// composePopupThemes, which return the joined multi-theme CSS text, not a
// map) -- not adding one just for this test, per scope. ---
{
  const pilotCache = new Map();
  const loadPilot = (slug) => {
    if (!pilotCache.has(slug)) {
      pilotCache.set(slug, JSON.parse(readFileSync(new URL(`../docs/theme-surface/pilots/${slug}.tokens.json`, import.meta.url), "utf8")));
    }
    return pilotCache.get(slug);
  };
  let assertionCount = 0;
  for (const entry of POPUP_THEME_MAP) {
    const tk = loadPilot(entry.pilot);
    const { map } = composeOptionsThemeMap(tk, entry.mode, entry.useDarkMode);
    for (const role of ["fg-hint", "fg-muted"]) {
      for (const hostRole of ["panel", "bg"]) {
        const c = ratio(map[role], map[hostRole]);
        assertionCount++;
        check(c >= 4.5,
          `options theme=${entry.id} pilot=${entry.pilot} mode=${entry.mode} ${role}=${map[role]} vs ${hostRole}=${map[hostRole]} = ${c.toFixed(3)}, need 4.5`);
      }
    }
  }
  // Guard against the loop silently degenerating to zero iterations (an
  // emptied POPUP_THEME_MAP would make every check() above vacuously true).
  check(assertionCount === POPUP_THEME_MAP.length * 4,
    `expected ${POPUP_THEME_MAP.length * 4} (theme x role x host) assertions, ran ${assertionCount}`);
}

// --- on-accent vs accent (rest) AND vs the settled `.btn.primary:hover`
// fill >= 4.5, EVERY options theme (Task 4, taste-uplift-batch2 --
// `.btn.primary`'s fill/text pair). The hover half is a real regression
// guard, not belt-and-suspenders: the render audit caught library
// solarized-light at 4.52:1 resting but only 4.27:1 once
// `color-mix(in srgb, accent 88%, fg)` (ui-components.mjs's hover recipe)
// pulled the fill toward fg -- fixed by deriving on-accent with
// fgToAAMulti against both hosts (same technique danger-quiet-fg already
// uses against its own settled hover fills). Same composeOptionsThemeMap-
// walks-POPUP_THEME_MAP technique as the fg-hint/fg-muted loop above, for
// the same reason: this is the real composer pipeline, not a hand-rebuilt
// approximation of it. Library has no exported per-theme map builder either
// (same documented gap above), so library's rest-vs-accent coverage lives in
// contrast-audit's COMPONENT_PAIR_SPEC ["on-accent", "accent", 4.5] row
// instead of here, and library's hover-mix coverage lives in the render
// audit's hand-written `.vocab-note-save` hover checklist entry (see
// docs/theme-surface/tools/contrast-audit.mjs and task-4-report.md). ---
{
  const pilotCache = new Map();
  const loadPilot = (slug) => {
    if (!pilotCache.has(slug)) {
      pilotCache.set(slug, JSON.parse(readFileSync(new URL(`../docs/theme-surface/pilots/${slug}.tokens.json`, import.meta.url), "utf8")));
    }
    return pilotCache.get(slug);
  };
  let assertionCount = 0;
  for (const entry of POPUP_THEME_MAP) {
    const tk = loadPilot(entry.pilot);
    const { map } = composeOptionsThemeMap(tk, entry.mode, entry.useDarkMode);
    const c = ratio(map["on-accent"], map.accent);
    assertionCount++;
    check(c >= 4.5,
      `options theme=${entry.id} pilot=${entry.pilot} mode=${entry.mode} on-accent=${map["on-accent"]} vs accent=${map.accent} = ${c.toFixed(3)}, need 4.5`);
    const hoverRgb = mix(hexToRgb(map.accent), hexToRgb(map.fg), 0.12);
    const ch = contrast(hexToRgb(map["on-accent"]), hoverRgb);
    assertionCount++;
    check(ch >= 4.5,
      `options theme=${entry.id} pilot=${entry.pilot} mode=${entry.mode} on-accent=${map["on-accent"]} vs primary-hover-mix=${rgbToHex(hoverRgb)} = ${ch.toFixed(3)}, need 4.5`);
  }
  // Guard against the loop silently degenerating to zero iterations.
  check(assertionCount === POPUP_THEME_MAP.length * 2,
    `expected ${POPUP_THEME_MAP.length * 2} (rest + hover per theme) assertions, ran ${assertionCount}`);
}

if (failures.length) {
  console.error(failures.map((message) => `FAIL ${message}`).join("\n"));
  process.exit(1);
}

console.log("theme UI derivation tests ok");
