import { readFileSync } from "node:fs";
import {
  contrast,
  deltaE2000,
  fgToAA,
  fgToAAMulti,
  fillDistinct,
  fillSeparate,
  FILL_SEPARATE_MIN,
  finalizeUiControlRoles,
  hexToRgb,
  mix,
  primaryHoverFill,
  PRIMARY_HOVER_FG_MIX,
  relLum,
  resolveChipBg,
  resolveOpaqueBg,
  rgbToHex,
  TIER_DISTINCT_MIN_DE,
} from "../docs/theme-surface/composers/_ui-derive.mjs";
import { composeOptionsThemeMap } from "../docs/theme-surface/composers/options-chrome.mjs";
import { composePopupThemeMap, POPUP_THEME_MAP } from "../docs/theme-surface/composers/popup-chrome.mjs";
import { composeLibraryThemeMap, LIB_BATCH_BAND_MIX } from "../docs/theme-surface/composers/library-chrome.mjs";
// COMPONENT_PAIR_SPEC / DEFAULT_SURFACE_OPTIONAL_ROLE_REASONS /
// isOutputRoleForDefault (final fix wave, Ruling 29 F3): safe to import for
// these -- contrast-audit.mjs's whole static-CSS audit lives inside main(),
// guarded by isDirectRun(), so pulling these three in does not also run it.
import {
  COMPONENT_PAIR_SPEC,
  DEFAULT_SURFACE_OPTIONAL_ROLE_REASONS,
  isOutputRoleForDefault,
} from "../docs/theme-surface/tools/contrast-audit.mjs";

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
  "fg-muted": "#666666",
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
  "fg-muted": "#57606a",
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

// popup-shaped role names (bg2/btn-bd/input-bd), with a transparent tag-bg --
// the exact shape that used to opt into chipMode: "verbatim" (chip-bg
// preserved as the literal "transparent"). That escape hatch is gone (Task
// 4, taste-uplift-batch3, D9): popup now shares the SAME tinted derivation
// options/library already got from the "tagged" case above, so a
// transparent tag-bg must resolve to a real, distinct, AA-clear fill here
// too -- not the bare keyword.
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
});
check(popup["chip-bg"] !== "transparent",
  "popup chip background must be tinted, never the literal transparent tag-bg (D9, taste-uplift-batch3)");
check(ratio(popup["chip-fg"], popup["chip-bg"]) >= 4.5 &&
  ratio(popup["chip-fg"], popup["btn-hover"]) >= 4.5,
"popup chip foreground must clear AA against its own tinted fill and the hover fill");
check(deltaE2000(hexToRgb(popup["chip-bg"]), hexToRgb(popup["btn-bg"])) >= TIER_DISTINCT_MIN_DE,
  "popup chip fill must stay perceptually distinct from the button fill (same tier-distinctness floor as options/library)");

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

// --- fillSeparate: the DARK mirror (M5, batch2 final-fix wave) -- every
// case above is a light surface; a dark panel/bg with a light fg exercises
// the OTHER branch of fillSeparate's bgIsLight-equivalent direction check
// (it moves toward fg regardless of surface polarity, so on a dark surface
// that means LIGHTENING, not darkening). ---
{
  const darkFg = hexToRgb("#e5e5f0"), darkPanel = hexToRgb("#1c2128"), darkBg = hexToRgb("#161a20");
  const roundedD = (c) => hexToRgb(rgbToHex(c));
  // 1. clears EVERY host, measured on the hex-rounded value that actually ships
  const startFill = hexToRgb("#1c2128");                  // == darkPanel, contrast 1.00 -> must separate
  const outD = fillSeparate(startFill, [darkPanel, darkBg], darkFg);
  for (const host of [darkPanel, darkBg]) {
    check(contrast(roundedD(outD), host) >= FILL_SEPARATE_MIN,
      `dark-surface separated fill must clear ${FILL_SEPARATE_MIN} vs every host`);
  }
  // 2. identity when the pair already clears
  const farD = hexToRgb("#3a3a44");
  check(JSON.stringify(fillSeparate(farD, [darkPanel, darkBg], darkFg)) === JSON.stringify(farD),
    "already-separated dark-surface fill is returned untouched");
  // 3. it moves toward fg -- on a DARK surface with a LIGHT fg that means it
  // LIGHTENS, the mirror image of the light-surface case's "darkens, never
  // lightens" assertion above.
  check(relLum(roundedD(outD)) >= relLum(startFill),
    "on a dark surface the fill lightens toward fg, never darkens");
}

// --- fillDistinct: two control TIERS must be tellable apart (COMPONENTS.md §1.2 tonal / §5 selectable) ---
{
  check(TIER_DISTINCT_MIN_DE === 6, "the tier-distinctness floor is ΔE 6, contrast-audit's own STATE_DELTA_MIN_DE yardstick");
  check(PRIMARY_HOVER_FG_MIX === 0.12, "the .btn.primary:hover fg-mix fraction is 0.12 -- shared by ui-components.mjs's color-mix(...) and contrast-audit's on-accent-vs-primary-hover gate; a drift here would desync all three");
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

// --- fillDistinct's JOINT criterion (I2, batch2 final-fix wave): mixing
// toward the accent for tier-distinctness must not undo the panel separation
// fillSeparate just guaranteed a few lines earlier in finalizeUiControlRoles.
// INTEGRATION case (drives the real finalizeUiControlRoles, not the
// standalone helper alone): a pale-cyan accent close to a white panel is the
// breaking shape I2 found -- ΔE keeps climbing on chroma alone while
// luminance walks back toward the panel. Literal hex, not a read of any
// shipped pilot, so this pins the SHAPE of the defect independent of future
// pilot edits.
{
  const paletteJoint = { "btn-fg": "#ffffff", "tag-bg": "transparent", "tag-fg": "#775500" };
  const inputJoint = {
    bg: "#f7f7f7", panel: "#ffffff", fg: "#222222", "fg-muted": "#666666", accent: "#d8ffff", danger: "#bb2222",
    border: "#dddddd", "btn-bg": "#efefef", "btn-hover": "#efefef", "input-bg": "#efefef",
  };
  const outJoint = finalizeUiControlRoles(structuredClone(inputJoint), paletteJoint);
  const chipBg = hexToRgb(outJoint["chip-bg"]);
  const btnBg = hexToRgb(outJoint["btn-bg"]);
  const panelRgb = hexToRgb(outJoint.panel);
  const deOut = deltaE2000(chipBg, btnBg), crOut = contrast(chipBg, panelRgb);
  check(deOut >= TIER_DISTINCT_MIN_DE,
    `chip-bg (${outJoint["chip-bg"]}) must stay >= ΔE ${TIER_DISTINCT_MIN_DE} from btn-bg (${outJoint["btn-bg"]}), got ${deOut.toFixed(2)}`);
  check(crOut >= FILL_SEPARATE_MIN,
    `chip-bg (${outJoint["chip-bg"]}) must stay >= ${FILL_SEPARATE_MIN} vs panel (${outJoint.panel}) -- fillDistinct's accent mix must not undo fillSeparate's own guarantee, got ${crOut.toFixed(3)}`);
}

// --- fillDistinct's FALLBACK branch (no candidate in the primary ΔE>=6 +
// host-separation walk satisfies BOTH at once): the block above never
// exercises this path -- its #d8ffff accent happens to satisfy both
// constraints together, so it never falls through. That leaves the
// fallback's own "keep the candidate with the greatest ΔE among those that
// still clear every host" contract (_ui-derive.mjs's fillDistinct comment)
// completely uncovered: a regression that replaces the whole best-candidate
// walk with the bare escape hatch (`return mix(fill, toward, 0.6)`, no
// clearsHosts check at all) leaves this suite green. #fffbd8 (same palette
// otherwise) is the shape that forces the fallback: its accent's luminance
// sits close enough to the panel that no mix fraction keeps chip-bg tonally
// distinct from btn-bg (ΔE >= 6) while ALSO holding the panel separation
// floor.
{
  const paletteFb = { "btn-fg": "#ffffff", "tag-bg": "transparent", "tag-fg": "#775500" };
  const inputFb = {
    bg: "#f7f7f7", panel: "#ffffff", fg: "#222222", "fg-muted": "#666666", accent: "#fffbd8", danger: "#bb2222",
    border: "#dddddd", "btn-bg": "#efefef", "btn-hover": "#efefef", "input-bg": "#efefef",
  };
  const outFb = finalizeUiControlRoles(structuredClone(inputFb), paletteFb);
  const btnBgFb = hexToRgb(outFb["btn-bg"]);
  const panelFb = hexToRgb(outFb.panel);
  const chipBgFb = hexToRgb(outFb["chip-bg"]);

  // Independently reconstruct the UN-MIXED `fill` fillDistinct was actually
  // called with -- finalizeUiControlRoles's own chipTinted, built the exact
  // same way its call site builds it (fillSeparate(resolveChipBg(...),
  // [panel], fg)) -- NOT a second call to fillDistinct, the function under
  // test.
  const chipTintedFb = fillSeparate(
    resolveChipBg(paletteFb["tag-bg"], hexToRgb(outFb.accent), panelFb),
    [panelFb],
    hexToRgb(outFb.fg),
  );
  const deUnmixed = deltaE2000(hexToRgb(rgbToHex(chipTintedFb)), btnBgFb);
  const crChipBg = contrast(chipBgFb, panelFb);
  const deChipBg = deltaE2000(chipBgFb, btnBgFb);

  check(crChipBg >= FILL_SEPARATE_MIN,
    `fallback branch: chip-bg (${outFb["chip-bg"]}) must still clear FILL_SEPARATE_MIN (${FILL_SEPARATE_MIN}) vs panel (${outFb.panel}), got ${crChipBg.toFixed(3)} -- a regression to the bare mix(fill, toward, 0.6) escape can ship below the floor`);
  check(deChipBg >= deUnmixed,
    `fallback branch: chip-bg (${outFb["chip-bg"]}) must be at least as distinct from btn-bg (${outFb["btn-bg"]}) as the un-mixed input fill was (ΔE ${deUnmixed.toFixed(3)}), got ΔE ${deChipBg.toFixed(3)} -- pins "best host-clearing candidate", not "any"`);
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
// `.btn.primary`'s fill/text pair).
//
// What this loop actually guards: that the role EXISTS and clears 4.5 on
// both the resting accent and the hover-mix fill for every pilot options
// currently renders -- a coverage/regression guard against options
// drifting, not proof that the two-host formula is doing real work FOR
// OPTIONS. Verified separately (all 14 options pilots, both the naive
// single-host formula and the real two-host one): options never actually
// dips under 4.5 on either host either way, so this loop by itself could
// not have caught the real regression (library-only, see below) and is not
// claimed to. The DISCRIMINATING guard for that defect class is
// contrast-audit's "on-accent vs primary-hover" row (a BLOCKING token-level
// check, all 15 blocks x both options/library, next to the `chip-bg ΔE
// btn-bg` tier check) plus the render oracle's live library instance
// (`.vocab-note-save`) -- see task-4-report.md's "Fix round 1" for the
// RED/GREEN proof neither of those ran through this file. `primaryHoverFill`
// (imported above) is the same shared helper the real derivation and that
// contrast-audit row both call, so this loop's hover host can never quietly
// drift from what ships. Same composeOptionsThemeMap-walks-POPUP_THEME_MAP
// technique as the fg-hint/fg-muted loop above, for the same reason: this is
// the real composer pipeline, not a hand-rebuilt approximation of it.
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
    const hoverRgb = primaryHoverFill(hexToRgb(map.accent), hexToRgb(map.fg));
    const ch = contrast(hexToRgb(map["on-accent"]), hoverRgb);
    assertionCount++;
    check(ch >= 4.5,
      `options theme=${entry.id} pilot=${entry.pilot} mode=${entry.mode} on-accent=${map["on-accent"]} vs primary-hover-mix=${rgbToHex(hoverRgb)} = ${ch.toFixed(3)}, need 4.5`);
  }
  // Guard against the loop silently degenerating to zero iterations.
  check(assertionCount === POPUP_THEME_MAP.length * 2,
    `expected ${POPUP_THEME_MAP.length * 2} (rest + hover per theme) assertions, ran ${assertionCount}`);
}

// --- ONE synthetic case that DOES discriminate the naive single-host
// formula from the real two-host one, since the loop above cannot (Task 4
// fix round 1, per-review). Literal colour constants copied out of the real
// regression's numbers (library/solarized-light: palette.btn-fg #fdf6e3,
// accent #268bd2, fg #54696f) -- not a read of that pilot file, so this stays
// independent of whatever a future edit to that pilot does; it exists to
// pin the SHAPE of the defect, not to duplicate coverage of that one pilot.
// The naive `fgToAA(btn-fg, accent)` clears rest (4.517:1) but fails hover
// (4.261:1 -- matches the render oracle's live 4.27:1 and contrast-audit's
// 4.26:1 finding, task-4-report.md); `fgToAAMulti` against both hosts (the
// real derivation) clears both. ---
{
  const btnFg = hexToRgb("#fdf6e3"), accentRgb = hexToRgb("#268bd2"), fgForHover = hexToRgb("#54696f");
  const hoverFill = primaryHoverFill(accentRgb, fgForHover);
  const naive = fgToAA(btnFg, accentRgb);
  check(contrast(naive, accentRgb) >= 4.5 && contrast(naive, hoverFill) < 4.5,
    "sanity: the naive single-host formula must actually fail on this synthetic case, or it has stopped discriminating anything");
  const fixed = fgToAAMulti(btnFg, [accentRgb, hoverFill]);
  check(contrast(fixed, accentRgb) >= 4.5 && contrast(fixed, hoverFill) >= 4.5,
    "the real two-host on-accent derivation must clear AA on BOTH the resting accent and the primary hover fill");
}

// --- Stale-`fgRgb` regression guard (task-7 fix round 1, per-review).
// finalizeUiControlRoles's `fg`-vs-control-fill gap-fill (task 7,
// taste-uplift-batch2) reassigns `map.fg` in place, but every role derived
// AFTER it (btn-hover, btn-fg, the tinted chip, and on-accent's hover mix
// below) reads a LOCAL `fgRgb` variable captured once at the top of the
// function -- if that local is never refreshed, those later roles are
// derived from the PRE-gap-fill fg instead of the fg that actually ships.
// The reviewer measured zero byte impact on today's 14 shipped themes (the
// 3 slots where the gap-fill fires happen to round to the same on-accent
// either way), so this is a synthetic literal-hex case built to actually
// discriminate, same technique as the naive-vs-real on-accent case just
// above: `fg` (#8a8a8a) is deliberately fine against `bg`/`panel` (white)
// but marginal against a deepened `btn-bg`/`input-bg` (#e0e0e0), so the
// gap-fill fires and moves it a long way (to #616161) -- large enough that
// feeding the STALE pre-gap-fill fg vs the REFRESHED shipped fg through
// on-accent's own hover-mix formula lands on opposite ends of the AA push
// (#000000 vs #ffffff), not just a rounding-level difference.
{
  const palette2 = { "btn-fg": "#ffffff", "tag-bg": "transparent", "tag-fg": "#0055aa" };
  const input = {
    bg: "#ffffff", panel: "#ffffff", fg: "#8a8a8a", "fg-muted": "#999999", accent: "#4477bb", danger: "#bb2222",
    border: "#eeeeee", "btn-bg": "#e0e0e0", "btn-hover": "#e0e0e0", "input-bg": "#e0e0e0",
  };
  const result = finalizeUiControlRoles(structuredClone(input), palette2);
  check(result.fg !== input.fg,
    "sanity: this synthetic fg must actually get moved by the gap-fill, or it has stopped discriminating anything");

  const accentRgb2 = hexToRgb(input.accent);
  const staleHover = primaryHoverFill(accentRgb2, hexToRgb(input.fg));
  const staleOnAccent = rgbToHex(fgToAAMulti(hexToRgb(palette2["btn-fg"]), [accentRgb2, staleHover]));
  const freshHover = primaryHoverFill(accentRgb2, hexToRgb(result.fg));
  const freshOnAccent = rgbToHex(fgToAAMulti(hexToRgb(palette2["btn-fg"]), [accentRgb2, freshHover]));
  check(staleOnAccent !== freshOnAccent,
    "sanity: the stale-fg and refreshed-fg formulas must actually diverge on this synthetic case, or it has stopped discriminating anything");

  check(result["on-accent"] === freshOnAccent,
    `on-accent must be derived from the fg that actually ships (${result.fg}), not the pre-gap-fill fg (${input.fg}) -- ` +
    `got ${result["on-accent"]}, expected ${freshOnAccent} (the stale formula would have produced ${staleOnAccent})`);
}

// --- btn-fg-muted (weak-text-on-fill batch, Task 1, D1/D2): the muted-tier
// analog of btn-fg -- COMPONENTS.md §9.1 law 8 makes it the ONLY sanctioned
// token for secondary text on a control fill. Same fgToAAMulti([btn-bg,
// btn-hover]) shape, same two-host requirement, mirroring how the on-accent
// tests above cover options/library and popup identically (btn-fg-muted is
// an OUTPUT role on ALL THREE surfaces, unlike on-accent). ---

// (a) CATEGORY assertion: every pilot x mode POPUP_THEME_MAP actually
// renders, across all 3 surfaces, must clear AA on btn-fg-muted vs BOTH
// btn-bg and btn-hover. Walks the real pilot set (POPUP_THEME_MAP, the same
// enumeration composeOptionsThemes/composePopupThemes/composeLibraryThemes
// themselves iterate) through the real composer pipeline for each surface --
// composeOptionsThemeMap already existed for exactly this reason;
// composePopupThemeMap/composeLibraryThemeMap are new exports this task adds
// (weak-text-on-fill batch, Task 1) so popup/library get the same coverage
// options already had for on-accent/fg-hint/fg-muted above, instead of a
// hand-rebuilt approximation of their pipelines.
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
    const surfaceMaps = {
      options: composeOptionsThemeMap(tk, entry.mode, entry.useDarkMode).map,
      popup: composePopupThemeMap(tk, entry.mode, entry.useDarkMode),
      library: composeLibraryThemeMap(tk, entry.mode, entry.useDarkMode).map,
    };
    for (const [surface, map] of Object.entries(surfaceMaps)) {
      for (const hostRole of ["btn-bg", "btn-hover"]) {
        const c = ratio(map["btn-fg-muted"], map[hostRole]);
        assertionCount++;
        check(c >= 4.5,
          `${surface} theme=${entry.id} pilot=${entry.pilot} mode=${entry.mode} btn-fg-muted=${map["btn-fg-muted"]} vs ${hostRole}=${map[hostRole]} = ${c.toFixed(3)}, need 4.5`);
      }
    }
  }
  // Guard against the loop silently degenerating to zero iterations.
  check(assertionCount === POPUP_THEME_MAP.length * 3 * 2,
    `expected ${POPUP_THEME_MAP.length * 3 * 2} (theme x surface x host) assertions, ran ${assertionCount}`);
}

// (b) LITERAL-HEX check on one adversarial palette where the RAW fg-muted is
// well below 4.5 on btn-hover (2.04:1) -- independently computed expectation
// (#525252), not a second call of finalizeUiControlRoles/fgToAAMulti at
// assertion time: the value below was computed once, out of band, by running
// fgToAAMulti(hexToRgb("#8a8a8a"), [hexToRgb("#eeeeee"), hexToRgb("#c7c7c7")])
// and is pinned here as a literal, the same way the composer files' own
// "derived, not guessed" DEFAULT_LIGHT comments pin a golden hex rather than
// re-deriving it live. `overrides: { fg: true, "btn-border": ... }` freezes
// `fg`/`btn-bg` exactly at their input literals (bypassing the fg gap-fill
// and the btn-bg fillSeparate step, both irrelevant to this role) so the
// only unknown is whether the new derivation matches the pinned golden
// value; btn-hover already clears FILL_SEPARATE_MIN against btn-bg raw
// (1.46:1), so its own fillSeparate step is identity too -- both fills that
// matter here ship byte-identical to their inputs, verified below.
{
  const fgMuted = "#8a8a8a", btnBg = "#eeeeee", btnHover = "#c7c7c7";
  check(ratio(fgMuted, btnHover) < 4.5,
    "sanity: this adversarial fg-muted must actually fail AA on btn-hover pre-derivation, or it has stopped discriminating anything");
  const paletteHex = { "btn-fg": "#000000", "tag-bg": "transparent", "tag-fg": "#0055aa" };
  const inputHex = {
    bg: "#ffffff", panel: "#ffffff", fg: "#222222", "fg-muted": fgMuted,
    accent: "#0055aa", danger: "#bb2222", border: "#dddddd",
    "btn-bg": btnBg, "btn-hover": btnHover, "input-bg": "#ffffff",
  };
  const resultHex = finalizeUiControlRoles(structuredClone(inputHex), paletteHex, {
    fg: true, "btn-border": "#000000", "input-border": "#000000",
  });
  check(resultHex["btn-bg"] === btnBg && resultHex["btn-hover"] === btnHover,
    `sanity: the frozen overrides must keep btn-bg/btn-hover verbatim, got btn-bg=${resultHex["btn-bg"]} btn-hover=${resultHex["btn-hover"]}`);
  const expectedHex = "#525252";
  check(resultHex["btn-fg-muted"] === expectedHex,
    `btn-fg-muted must match the independently precomputed golden value for this adversarial palette -- got ${resultHex["btn-fg-muted"]}, expected ${expectedHex}`);
}

// (c) DISCRIMINATION proof for (a)/(b) above -- NOT a permanent part of this
// suite. Verified manually during authorship by temporarily narrowing
// _ui-derive.mjs's `map["btn-fg-muted"] = rgbToHex(fgToAAMulti(hexToRgb(
// map["fg-muted"]), [btnBgRgb, btnHoverRgb]))` to derive against `[btnBgRgb]`
// only (dropping the btn-hover host): both the category loop above (a) and
// the literal-hex check (b) went RED, then the file was restored
// byte-for-byte and the suite went GREEN again -- see task-1-report.md for
// the captured RED output. Left as a comment, not code, because a
// self-mutating test would have to un-import/re-import the module under
// test at runtime, which this file's other tests do not do either.

// --- row-selected-fg vs the batch-selection bands (weak-text-on-fill batch,
// D6 follow-up / Ruling 17): library.css's .selected (batch) state paints
// .vocab-row-gloss/.notes-row-meta/.notes-hit-note/.notes-hit-meta with
// --lib-row-selected-fg, whose fill there is NOT --lib-row-selected-bg but
// an accent-over-bg color-mix at LIB_BATCH_BAND_MIX's two percentages
// (rest/hover). This is a category assertion computed INDEPENDENTLY of
// contrast-audit.mjs's own new rows -- same pilot x mode walk as the
// btn-fg-muted category test above, but the band mix and contrast are
// recomputed here from _ui-derive.mjs's own `mix`/`contrast`, not by
// importing or re-running the audit tool. ---
{
  const pilotCache2 = new Map();
  const loadPilot2 = (slug) => {
    if (!pilotCache2.has(slug)) {
      pilotCache2.set(slug, JSON.parse(readFileSync(new URL(`../docs/theme-surface/pilots/${slug}.tokens.json`, import.meta.url), "utf8")));
    }
    return pilotCache2.get(slug);
  };
  let bandAssertionCount = 0;
  for (const entry of POPUP_THEME_MAP) {
    const tk = loadPilot2(entry.pilot);
    const map = composeLibraryThemeMap(tk, entry.mode, entry.useDarkMode).map;
    const bgRgb = hexToRgb(map.bg);
    const accentRgb = hexToRgb(map.accent);
    const fgSelRgb = hexToRgb(map["row-selected-fg"]);
    for (const t of LIB_BATCH_BAND_MIX) {
      const bandRgb = mix(bgRgb, accentRgb, t).map(Math.round);
      const c = contrast(fgSelRgb, bandRgb);
      bandAssertionCount++;
      check(c >= 4.5,
        `library theme=${entry.id} pilot=${entry.pilot} mode=${entry.mode} row-selected-fg=${map["row-selected-fg"]} vs batch-band-${Math.round(t * 100)} (bg=${map.bg} accent=${map.accent}) = ${c.toFixed(3)}, need 4.5`);
    }
  }
  // Guard against the loop silently degenerating to zero iterations.
  check(bandAssertionCount === POPUP_THEME_MAP.length * LIB_BATCH_BAND_MIX.length,
    `expected ${POPUP_THEME_MAP.length * LIB_BATCH_BAND_MIX.length} (theme x band) assertions, ran ${bandAssertionCount}`);
}

// --- popup chip family: chip-bg tinted + ai-chip-fg (Task 4, taste-uplift-
// batch3, D8/D9). CATEGORY assertion walking the real pilot registry through
// the real composer pipeline (composePopupThemeMap, same POPUP_THEME_MAP
// enumeration technique as every loop above), not a hand-rebuilt
// approximation. Per pilot x mode: (1) chip-bg must be a real hex, never the
// literal "transparent" the old chipMode: "verbatim" path shipped on 8/13
// pilots; (2) chip-bg must stay >= TIER_DISTINCT_MIN_DE from btn-bg (the
// tonal/selectable tier-distinctness floor options/library's own joint-
// criterion tests above already pin, now proven for popup too); (3) chip-bg
// must clear FILL_SEPARATE_MIN against its own panel (bg2); (4) chip-fg must
// clear AA against chip-bg; (5)+(6) the new ai-chip-fg must clear AA against
// BOTH chip-bg (rest) and btn-hover (the pressable-chip hover swap chip-fg's
// own second COMPONENT_PAIR_SPEC row already covers) -- 6 assertions per
// theme (14 pilots x mode).
{
  const pilotCache3 = new Map();
  const loadPilot3 = (slug) => {
    if (!pilotCache3.has(slug)) {
      pilotCache3.set(slug, JSON.parse(readFileSync(new URL(`../docs/theme-surface/pilots/${slug}.tokens.json`, import.meta.url), "utf8")));
    }
    return pilotCache3.get(slug);
  };
  let chipAssertionCount = 0;
  for (const entry of POPUP_THEME_MAP) {
    const tk = loadPilot3(entry.pilot);
    const map = composePopupThemeMap(tk, entry.mode, entry.useDarkMode);
    const chipBgRgb = hexToRgb(map["chip-bg"]);
    const btnBgRgb = hexToRgb(map["btn-bg"]);
    const panelRgb = hexToRgb(map.bg2);

    check(map["chip-bg"] !== "transparent" && /^#[0-9a-f]{6}$/i.test(map["chip-bg"]),
      `popup theme=${entry.id} pilot=${entry.pilot} mode=${entry.mode} chip-bg=${map["chip-bg"]} must be a real hex, never the literal transparent`);
    chipAssertionCount++;

    const de = deltaE2000(chipBgRgb, btnBgRgb);
    check(de >= TIER_DISTINCT_MIN_DE,
      `popup theme=${entry.id} pilot=${entry.pilot} mode=${entry.mode} chip-bg (${map["chip-bg"]}) vs btn-bg (${map["btn-bg"]}) ΔE=${de.toFixed(2)}, need >= ${TIER_DISTINCT_MIN_DE}`);
    chipAssertionCount++;

    const crPanel = contrast(chipBgRgb, panelRgb);
    check(crPanel >= FILL_SEPARATE_MIN,
      `popup theme=${entry.id} pilot=${entry.pilot} mode=${entry.mode} chip-bg (${map["chip-bg"]}) vs panel/bg2 (${map.bg2}) = ${crPanel.toFixed(3)}, need >= ${FILL_SEPARATE_MIN}`);
    chipAssertionCount++;

    const cChipFg = ratio(map["chip-fg"], map["chip-bg"]);
    check(cChipFg >= 4.5,
      `popup theme=${entry.id} pilot=${entry.pilot} mode=${entry.mode} chip-fg=${map["chip-fg"]} vs chip-bg=${map["chip-bg"]} = ${cChipFg.toFixed(3)}, need 4.5`);
    chipAssertionCount++;

    for (const hostRole of ["chip-bg", "btn-hover"]) {
      const c = ratio(map["ai-chip-fg"], map[hostRole]);
      check(c >= 4.5,
        `popup theme=${entry.id} pilot=${entry.pilot} mode=${entry.mode} ai-chip-fg=${map["ai-chip-fg"]} vs ${hostRole}=${map[hostRole]} = ${c.toFixed(3)}, need 4.5`);
      chipAssertionCount++;
    }
  }
  // Guard against the loop silently degenerating to zero iterations. 4 single
  // assertions per theme (hex-shape, ΔE, panel-contrast, chip-fg) + 2 more
  // (ai-chip-fg x [chip-bg, btn-hover]) = 6 per theme.
  check(chipAssertionCount === POPUP_THEME_MAP.length * 6,
    `expected ${POPUP_THEME_MAP.length * 6} assertions, ran ${chipAssertionCount}`);
}

// --- ai-chip-fg LITERAL-HEX check on one adversarial palette where the RAW
// accent2 is well below AA on a light chip (2.14:1 vs chip-bg, 1.89:1 vs
// btn-hover) -- independently computed expectation (#714bba), not a second
// call of fgToAAMulti (the function under test) at assertion time: the value
// below was computed once, out of band, by running fgToAAMulti(hexToRgb(
// "#b19cd9"), [hexToRgb("#eef0f5"), hexToRgb("#dfe3ec")]) and is pinned here
// as a literal, same technique as the btn-fg-muted literal-hex check above.
// This exercises the EXACT shape popup-chrome.mjs's ai-chip-fg derivation
// calls (fgToAAMulti(accent2, [chip-bg, btn-hover])) directly on adversarial
// literals, rather than threading a synthetic full pilot through
// composePopupThemeMap (which needs a much larger, easy-to-typo palette
// object just to reach expandPalette/deriveUiColors without crashing) --
// the category loop above already proves the real composer wiring end to
// end on all 14 real pilots; this pins the FORMULA'S shape independent of
// any pilot file. ---
{
  const accent2Adv = hexToRgb("#b19cd9"), chipBgAdv = hexToRgb("#eef0f5"), btnHoverAdv = hexToRgb("#dfe3ec");
  check(contrast(accent2Adv, chipBgAdv) < 4.5 && contrast(accent2Adv, btnHoverAdv) < 4.5,
    "sanity: this adversarial accent2 must actually fail AA on both hosts pre-derivation, or it has stopped discriminating anything");
  const aiChipFgAdv = rgbToHex(fgToAAMulti(accent2Adv, [chipBgAdv, btnHoverAdv]));
  const expectedAiChipFg = "#714bba";
  check(aiChipFgAdv === expectedAiChipFg,
    `ai-chip-fg must match the independently precomputed golden value for this adversarial palette -- got ${aiChipFgAdv}, expected ${expectedAiChipFg}`);
}

// --- ai-chip-fg MUTANT proof for the category loop above -- NOT a permanent
// part of this suite. Verified manually during authorship by temporarily
// narrowing popup-chrome.mjs's `ui["ai-chip-fg"] = rgbToHex(fgToAAMulti(
// hexToRgb(ui["accent2"]), [hexToRgb(ui["chip-bg"]), hexToRgb(ui["btn-hover"])]))`
// to derive against `[hexToRgb(ui["chip-bg"])]` only (dropping the btn-hover
// host): the category loop's `vs btn-hover` assertions went RED on 2/14
// pilots (the two closest to the 4.5 margin once only one host is
// satisfied) --
//   FAIL popup theme=flexoki-dark pilot=flexoki mode=dark ai-chip-fg=#9e93d1 vs btn-hover=#363532 = 4.408, need 4.5
//   FAIL popup theme=github-light pilot=github-light mode=light ai-chip-fg=#7c47dd vs btn-hover=#d0e5f0 = 4.247, need 4.5
// -- then the file was restored byte-for-byte (verified via md5sum before/
// after) and the suite went GREEN again. Left as a comment, not code, same
// reason (c) above documents for btn-fg-muted: a self-mutating test would
// have to un-import/re-import the module under test at runtime, which this
// file's other tests do not do either.

// --- ai-chip-fg DEFAULT-SURFACE literal check (Ruling 25, 2026-09-23,
// taste-uplift-batch3 ledger). popup-chrome.mjs's DEFAULT_LIGHT is a
// hand-authored literal block (not run through composePopupThemeMap's
// finalizeUiControlRoles pipeline -- see that file's own comment on
// DEFAULT_LIGHT), so nothing before this test independently verified its
// `ai-chip-fg` entry actually equals what the SAME formula the themed-block
// derivation uses would produce from the default surface's own hosts. Reads
// the real SHIPPED popup.css (not a re-imported copy of DEFAULT_LIGHT, which
// isn't exported) so this stays honest if a future edit changes any of the
// three inputs: --pp-accent2 (hand-maintained top-of-file :root) and
// --pp-chip-bg/--pp-btn-hover (the generated default :root block, the last
// `:root { ... }` before the `@generated:ui-themes end` sentinel -- same
// block auditComponentPairsDefault's `foldSelectorBlocks(text, ":root")`
// reads in contrast-audit.mjs).
{
  const popupCssPath = new URL("../popup.css", import.meta.url);
  const popupCssText = readFileSync(popupCssPath, "utf8");
  const genEndIdx = popupCssText.indexOf("@generated:ui-themes end");
  check(genEndIdx !== -1, "popup.css must still carry the @generated:ui-themes end sentinel");
  const beforeEnd = popupCssText.slice(0, genEndIdx);
  const lastRootStart = beforeEnd.lastIndexOf(":root {");
  check(lastRootStart !== -1, "popup.css must have a :root block before @generated:ui-themes end");
  const defaultBlock = beforeEnd.slice(lastRootStart, genEndIdx);
  const grabHex = (source, name) => {
    const m = source.match(new RegExp(`--pp-${name}:\\s*(#[0-9a-fA-F]{6})`));
    return m ? m[1] : null;
  };
  const accent2Hex = grabHex(popupCssText, "accent2");
  const chipBgHex = grabHex(defaultBlock, "chip-bg");
  const btnHoverHex = grabHex(defaultBlock, "btn-hover");
  const aiChipFgHex = grabHex(defaultBlock, "ai-chip-fg");
  check(accent2Hex && chipBgHex && btnHoverHex && aiChipFgHex,
    `popup.css must declare --pp-accent2 (${accent2Hex}), and the default block must declare --pp-chip-bg (${chipBgHex}), --pp-btn-hover (${btnHoverHex}), and --pp-ai-chip-fg (${aiChipFgHex})`);
  if (accent2Hex && chipBgHex && btnHoverHex && aiChipFgHex) {
    const expected = rgbToHex(fgToAAMulti(hexToRgb(accent2Hex), [hexToRgb(chipBgHex), hexToRgb(btnHoverHex)]));
    check(aiChipFgHex.toLowerCase() === expected.toLowerCase(),
      `popup.css's default-surface --pp-ai-chip-fg (${aiChipFgHex}) must equal fgToAAMulti(accent2=${accent2Hex}, [chip-bg=${chipBgHex}, btn-hover=${btnHoverHex}]) = ${expected}, the same formula the themed-block derivation uses (popup-chrome.mjs)`);
  }
}

// --- resolveOpaqueBg direct coverage (Ruling 25, 2026-09-23). Every prior
// use of this exported function was indirect (through contrast-audit.mjs's
// own CLI run, or through resolveChipBg/finalizeUiControlRoles's internal
// calls) -- nothing in this suite imported and called it directly, so a
// regression in its own three branches (opaque hex passthrough, 8-digit
// alpha-hex compositing, anything-else falls through to the fallback) could
// only ever be caught as a downstream contrast-number shift, not attributed
// to this function. Three branches, one assertion each. ---
{
  // (1) A plain opaque hex is returned unchanged -- no compositing needed.
  const opaque = resolveOpaqueBg("#33589f", [1, 2, 3]);
  check(opaque[0] === 0x33 && opaque[1] === 0x58 && opaque[2] === 0x9f,
    `resolveOpaqueBg must pass an opaque hex through unchanged -- got [${opaque}]`);

  // (2) An 8-digit RRGGBBAA hex is alpha-blended over the fallback -- uses
  // terminal's real pilot value (#33ff3340, its border/selection-bg) so this
  // is not a synthetic shape nothing in the codebase actually emits.
  const fallback = [10, 10, 10];
  const composited = resolveOpaqueBg("#33ff3340", fallback);
  const expectedComposite = mix(fallback, hexToRgb("#33ff33"), 0x40 / 255);
  check(composited.every((c, i) => Math.abs(c - expectedComposite[i]) < 1e-9),
    `resolveOpaqueBg must alpha-composite an 8-digit hex over the fallback -- got [${composited}], expected [${expectedComposite}]`);

  // (3) Anything else (the literal keyword "transparent", or any other
  // non-hex value) is treated as fully transparent: the fallback verbatim.
  const fellThrough = resolveOpaqueBg("transparent", [200, 150, 100]);
  check(fellThrough[0] === 200 && fellThrough[1] === 150 && fellThrough[2] === 100,
    `resolveOpaqueBg must fall through to the fallback verbatim for a non-hex value -- got [${fellThrough}]`);
}

// --- DEFAULT_SURFACE_OPTIONAL_ROLE_REASONS cross-check (final fix wave,
// Ruling 29 F3). contrast-audit.mjs's comment above that object has, since
// Ruling 25, promised that this file cross-checks it against
// COMPONENT_PAIR_SPEC -- until now that promise was prose only: nothing
// actually ran the comparison, so a role could fall through BOTH
// isOutputRoleForDefault() (not a UI_DERIVED_OUTPUT_ROLES member) and this
// object (no reason entry) and the default-block audit would silently SKIP
// it forever, exactly the class of gap Ruling 25 closed for the strict
// path. themedOnly rows are excluded: contrast-audit.mjs's own
// auditComponentPairs skips them entirely for the non-strict (default)
// path (`if (themedOnly && !strict) continue;`, :565) because their
// default-surface counterpart is a differently-named token -- they never
// reach isOutputRoleForDefault()/this object's territory at all, so
// requiring either here would be checking a promise contrast-audit.mjs
// itself never makes.
{
  const NS_LIST = ["pp", "opt", "lib"];
  const roleKeys = new Set(); // `${ns}|${role}`
  for (const [fgRole, bgRole, , onlyNs, themedOnly] of COMPONENT_PAIR_SPEC) {
    if (themedOnly) continue;
    for (const ns of (onlyNs || NS_LIST)) {
      roleKeys.add(`${ns}|${fgRole}`);
      roleKeys.add(`${ns}|${bgRole}`);
    }
  }
  const isCovered = (ns, role, reasons) =>
    isOutputRoleForDefault(ns, role) || Object.prototype.hasOwnProperty.call(reasons, role);
  for (const key of roleKeys) {
    const [ns, role] = key.split("|");
    check(isCovered(ns, role, DEFAULT_SURFACE_OPTIONAL_ROLE_REASONS),
      `DEFAULT_SURFACE_OPTIONAL_ROLE_REASONS cross-check: role "${role}" (ns=${ns}) is a ` +
      `COMPONENT_PAIR_SPEC member that applies to a default (:root) block, but is neither a ` +
      `UI_DERIVED_OUTPUT_ROLES member (isOutputRoleForDefault) nor listed in ` +
      `DEFAULT_SURFACE_OPTIONAL_ROLE_REASONS -- contrast-audit.mjs's default-block audit will ` +
      `silently SKIP it forever (Ruling 25's own failure mode, for a role this file never re-checked).`);
  }

  // Negative control: the assertion above must be capable of failing. Drop
  // ONE real reason ("bg", chosen because it is not also a
  // UI_DERIVED_OUTPUT_ROLES member on any surface) from a shallow copy and
  // confirm the SAME coverage predicate the loop above uses now reads false
  // for it -- proves this is not a vacuous check that would pass no matter
  // what DEFAULT_SURFACE_OPTIONAL_ROLE_REASONS contained.
  const reasonsMissingBg = { ...DEFAULT_SURFACE_OPTIONAL_ROLE_REASONS };
  delete reasonsMissingBg.bg;
  check(roleKeys.has("opt|bg"),
    "negative control setup: \"opt|bg\" must be a role this cross-check actually visits, or the control below proves nothing");
  check(isCovered("opt", "bg", reasonsMissingBg) === false,
    "negative control: removing DEFAULT_SURFACE_OPTIONAL_ROLE_REASONS.bg must make the coverage " +
    "predicate return false for opt/bg (proves the cross-check above is not vacuous)");
}

if (failures.length) {
  console.error(failures.map((message) => `FAIL ${message}`).join("\n"));
  process.exit(1);
}

console.log("theme UI derivation tests ok");
