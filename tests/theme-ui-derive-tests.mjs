import { readFileSync } from "node:fs";
import {
  contrast,
  deltaE2000,
  deriveFieldRoles,
  FIELD_HOST_ROLES,
  FIELD_ROLES,
  fieldChevronUri,
  FRAMED_HOVER_FG_MIX,
  FIELD_TEXT_PLACEHOLDER_MIN,
  fgToAA,
  fgToAAMulti,
  fillDistinct,
  fillSeparate,
  FILL_SEPARATE_MIN,
  finalizeUiControlRoles,
  hexToRgb as hexToRgbLoose,
  hslToRgb,
  isHex,
  mix,
  primaryHoverFill,
  PRIMARY_HOVER_FG_MIX,
  relLum,
  resolveChipBg,
  resolveOpaqueBg,
  rgbToHex,
  rgbToHsl,
  TIER_DISTINCT_MIN_DE,
  UI_DERIVED_OUTPUT_ROLES,
} from "../docs/theme-surface/composers/_ui-derive.mjs";
import { composeOptionsThemeMap } from "../docs/theme-surface/composers/options-chrome.mjs";
import { composePopupThemeMap, POPUP_THEME_MAP } from "../docs/theme-surface/composers/popup-chrome.mjs";
import { composeLibraryThemeMap, LIB_BATCH_BAND_MIX } from "../docs/theme-surface/composers/library-chrome.mjs";
// COMPONENT_PAIR_SPEC / DEFAULT_SURFACE_OPTIONAL_ROLE_REASONS /
// isOutputRoleForDefault (final fix wave, Ruling 29 F3): safe to import for
// these -- contrast-audit.mjs's whole static-CSS audit lives inside main(),
// guarded by isDirectRun(), so pulling these three in does not also run it.
import {
  COMPONENT_PAIR_ROLES,
  COMPONENT_PAIR_SPEC,
  DEFAULT_SURFACE_OPTIONAL_ROLE_REASONS,
  FIELD_FRAME_HOST_MIN,
  FIELD_SEPARATION_HOSTS,
  isOutputRoleForDefault,
} from "../docs/theme-surface/tools/contrast-audit.mjs";

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
// hexToRgb() and ratio() refuse anything but #rgb / #rrggbb (stage 4 spec
// 2026-09-30 §2.4). The composer's own hexToRgb reads undefined,
// "transparent" or an 8-digit hex as some other colour without complaint,
// and a check against black passes on every light theme -- that is how the
// retired field-edge assertions would have kept passing on light themes
// with the role already gone. Every measurement in this file goes through
// these two, so a missing or misspelled role throws instead of measuring
// #000000.
const hexToRgb = (v) => {
  if (!isHex(v)) throw new Error(`theme-ui-derive-tests: not a #rgb / #rrggbb hex: ${JSON.stringify(v)}`);
  return hexToRgbLoose(v.trim());
};
const ratio = (fg, bg) => contrast(hexToRgb(fg), hexToRgb(bg));
for (const bad of [undefined, "", "transparent", "#33ff3340", "rgb(0, 0, 0)"]) {
  check((() => { try { ratio(bad, "#ffffff"); return false; } catch { return true; } })(),
    `ratio(${JSON.stringify(bad)}, "#ffffff") must throw, not measure it as #000000`);
}

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

// R13 minimality (follow-up 7c), shared by the unit fixtures and the
// pipeline walk. deriveFieldRoles' documented order is: (1) move the
// placeholder toward the fills "as far as >= 4.5:1 on BOTH fills allows",
// then (2) only if typed text is still within FIELD_TEXT_PLACEHOLDER_MIN,
// push field-fg away from the fills along HSL lightness (hue + saturation
// kept) in .005 steps "until it clears it". The category checks elsewhere
// only prove the END state (>= 1.4, >= 4.5); these prove neither step
// overshoots or stops short: (1) the shipped placeholder is on the mix path
// from the plain AA placeholder toward the fills' pole and the NEXT distinct
// point on that path fails 4.5:1 on a fill; (2) the shipped field-fg is on the
// fg lightness path and the point one step closer to fg is still under the
// floor. Returns what it proved, so callers can assert coverage.
// `inputs` = the map deriveFieldRoles read (fg, fg-hint); `out` = its roles.
function r13MinimalityFailures(id, inputs, out) {
  const bad = [];
  const fgRgb = hexToRgb(String(inputs.fg).trim());
  const fgHex = rgbToHex(fgRgb);
  const fills = [hexToRgb(out["field-bg"]), hexToRgb(out["field-bg-hover"])];
  const clears45 = (hex) => fills.every((f) => contrast(hexToRgb(hex), f) >= 4.5);
  const p0 = rgbToHex(fgToAAMulti(hexToRgb(String(inputs["fg-hint"]).trim()), fills, 4.5));
  if (contrast(fgRgb, hexToRgb(p0)) >= FIELD_TEXT_PLACEHOLDER_MIN) {
    return { bad, placeholderMoved: false, pushed: false }; // R13 branch not taken; the category checks pin "no move"
  }
  // (1) placeholder: on the path, and maximal.
  const pole = relLum(hexToRgb(p0)) < relLum(fills[0]) ? [255, 255, 255] : [0, 0, 0];
  const path = [p0];
  for (let i = 1; i <= 1000; i++) path.push(rgbToHex(mix(hexToRgb(p0), pole, i / 1000)));
  const at = path.lastIndexOf(out["field-placeholder"]);
  if (at < 0) bad.push(`${id}: field-placeholder ${out["field-placeholder"]} is not on the documented path from ${p0} toward ${rgbToHex(pole)}`);
  else {
    const next = path.slice(at + 1).find((c) => c !== out["field-placeholder"]);
    if (next && clears45(next)) bad.push(`${id}: the placeholder stopped early at ${out["field-placeholder"]} -- the next point ${next} still clears 4.5:1 on both fills, so field-fg is pushed further than the rule needs`);
  }
  // (2) field-fg: on the HSL lightness path from fg, and minimal.
  if (out["field-fg"] === fgHex) return { bad, placeholderMoved: out["field-placeholder"] !== p0, pushed: false };
  const [h, sat, l0] = rgbToHsl(fgRgb);
  const darker = relLum(hexToRgb(out["field-fg"])) < relLum(fgRgb);
  const steps = [fgHex];
  for (let l = l0, i = 0; i < 400; i++) {
    l = darker ? Math.max(0, l - 0.005) : Math.min(1, l + 0.005);
    steps.push(rgbToHex(hslToRgb([h, sat, l])));
    if (l <= 0 || l >= 1) break;
  }
  const k = steps.indexOf(out["field-fg"]);
  if (k < 1) bad.push(`${id}: field-fg ${out["field-fg"]} is not on fg ${fgHex}'s HSL lightness path (hue/saturation kept, .005 steps)`);
  else if (ratio(steps[k - 1], out["field-placeholder"]) >= FIELD_TEXT_PLACEHOLDER_MIN) {
    bad.push(`${id}: field-fg over-pushed to ${out["field-fg"]} -- one step less (${steps[k - 1]}) is already ${ratio(steps[k - 1], out["field-placeholder"]).toFixed(3)}:1 from the placeholder ${out["field-placeholder"]} (floor ${FIELD_TEXT_PLACEHOLDER_MIN})`);
  }
  return { bad, placeholderMoved: true, pushed: true };
}

// F8 / F8b (stage 4 spec 2026-09-30 §2.3): a framed value box whose fill is
// not separated from its hosts announces hover with its frame alone, so the
// hover frame has to be >= F8_MIN_RATIO and >= F8_MIN_DE from the rest frame
// and stronger on the fill it is painted on than the rest frame is on its
// own (both fills are the same pilot fill here); and the rest frame has to
// stand off every host by >= FIELD_FRAME_HOST_MIN (contrast-audit gates the
// same floor on the shipped CSS). Not a contrast-audit pair row: an unframed
// frame IS the fill, whose hover step is only 1.10 by design.
const F8_MIN_RATIO = 1.30;
const F8_MIN_DE = 6;
function f8Failures(id, out, hosts) {
  const bad = [];
  const rest = out["field-border"], hover = out["field-border-hover"];
  const r = ratio(hover, rest), de = deltaE2000(hexToRgb(hover), hexToRgb(rest));
  if (r < F8_MIN_RATIO) bad.push(`${id}: hover frame ${hover} is ${r.toFixed(3)}:1 from the rest frame ${rest} (F8 floor ${F8_MIN_RATIO})`);
  if (de < F8_MIN_DE) bad.push(`${id}: hover frame ${hover} is ΔE2000 ${de.toFixed(2)} from the rest frame ${rest} (F8 floor ${F8_MIN_DE})`);
  if (!(ratio(hover, out["field-bg-hover"]) > ratio(rest, out["field-bg"]))) {
    bad.push(`${id}: hover frame on the hover fill (${ratio(hover, out["field-bg-hover"]).toFixed(3)}) is not stronger than the rest frame on the rest fill (${ratio(rest, out["field-bg"]).toFixed(3)})`);
  }
  for (const h of hosts) {
    if (ratio(rest, h) < FIELD_FRAME_HOST_MIN) bad.push(`${id}: rest frame ${rest} is ${ratio(rest, h).toFixed(3)}:1 from host ${h} (F8b floor ${FIELD_FRAME_HOST_MIN})`);
  }
  return bad;
}

// --- Soft Fill field family: deriveFieldRoles unit cases (stage 4 spec
// docs/superpowers/specs/2026-09-30-ui-fields-stage4-design.md §2). ---
{
  const throwsNaming = (fn, roles) => {
    try { fn(); } catch (e) { return roles.every((r) => String(e?.message ?? e).includes(r)); }
    return false;
  };
  check(!Object.keys(finalizeUiControlRoles(base, palette)).some((k) => k.startsWith("field-")),
    "finalizeUiControlRoles with the default config (fieldRoles unset) must not emit any field-* role, field-chevron included -- the composer-level popup/library walk below checks that those surfaces really call it that way");
  check(FIELD_ROLES.length === 8 && !FIELD_ROLES.some((r) => /^field-(edge|chevron)/.test(r)),
    `FIELD_ROLES must be the eight colour roles of the fill-only value box -- no retired field-edge role, and not the field-chevron url() (got ${JSON.stringify(FIELD_ROLES)})`);
  // The shared `base` fixture has no fg-hint / pf-bg: add both, so the smoke
  // check below proves eight REAL values, not placeholders read off
  // hexToRgb(undefined) (which silently parses as #000000).
  const fieldBase = { ...base, "fg-hint": "#666666", "pf-bg": "#f9f9f6" };
  const withFields = finalizeUiControlRoles(fieldBase, palette, {}, { fieldRoles: true });
  check(FIELD_ROLES.every((r) => /^#[0-9a-f]{6}$/.test(withFields[r] ?? "")) && !("field-chevron" in withFields),
    "fieldRoles: true must emit all eight field-* roles as 6-digit hex, and no field-chevron unless fieldChevron is also set");
  check(throwsNaming(() => finalizeUiControlRoles(base, palette, {}, { fieldRoles: true }), ["fg-hint"]),
    "fieldRoles: true over a map without fg-hint must throw naming the missing role, not derive the placeholder from #000000");
  const withChevron = finalizeUiControlRoles(fieldBase, palette, {}, { fieldRoles: true, fieldChevron: true });
  check(withChevron["field-chevron"] === fieldChevronUri(withChevron["field-placeholder"]),
    "fieldChevron: true must emit field-chevron = fieldChevronUri(field-placeholder)");
  check(throwsNaming(() => finalizeUiControlRoles(fieldBase, palette, {}, { fieldChevron: true }), ["fieldChevron", "fieldRoles"]),
    "fieldChevron without fieldRoles must throw (the chevron strokes field-placeholder)");
  // fieldHostRoles reaches the deriver: fieldBase's pf-bg (#f9f9f6) sits
  // close enough to the fill to steer the default [panel, pf-bg] output, and
  // a [panel]-only host list ignores pf-bg whatever its value.
  const pick = (o) => JSON.stringify(FIELD_ROLES.map((r) => o[r]));
  const onPanel = finalizeUiControlRoles(fieldBase, palette, {}, { fieldRoles: true, fieldHostRoles: ["panel"] });
  const onPanelBlackPf = finalizeUiControlRoles({ ...fieldBase, "pf-bg": "#000000" }, palette, {}, { fieldRoles: true, fieldHostRoles: ["panel"] });
  check(pick(withFields) !== pick(onPanel) && pick(onPanel) === pick(onPanelBlackPf),
    "finalizeUiControlRoles must hand fieldHostRoles to deriveFieldRoles (pf-bg steers the default hosts and is ignored by [panel])");
  // fieldChevronUri: today's chevron geometry, a %23 stroke, never a ";" or a bare "#".
  const chev = fieldChevronUri("#abc");
  check(/^url\("data:image\/svg\+xml,%3Csvg /.test(chev) && chev.endsWith('%3C/svg%3E")') &&
    chev.includes("viewBox='0 0 12 12'") && chev.includes("d='M3 4.5 6 7.5 9 4.5'") && chev.includes("stroke-width='1.5'") &&
    chev.includes("stroke-linecap='round'") && chev.includes("stroke-linejoin='round'") &&
    chev.includes("stroke='%23aabbcc'") && !chev.includes(";") && !chev.includes("#"),
    `fieldChevronUri must keep the chevron geometry, stroke %23rrggbb and contain no ";" or "#" (got ${chev})`);
  // The two attributes that make the URI PAINT as a stroked chevron (stage 4
  // Task 4, from the Task 3 review): an image-context SVG without the SVG
  // namespace renders nothing at all, and the open path without fill='none'
  // fills as a solid black wedge. Pinned on the literal output -- the
  // shipped-block checks below compare the generator with itself and cannot
  // see a format regression. (Task 4's chevron probe showed the pixels.)
  check(chev.includes("%3Csvg xmlns='http://www.w3.org/2000/svg' ") && chev.includes(" fill='none' "),
    `fieldChevronUri must declare xmlns='http://www.w3.org/2000/svg' on the <svg> and fill='none' on the path (got ${chev})`);
  for (const bad of [undefined, "transparent", "#33ff3340", "var(--opt-fg)"]) {
    check(throwsNaming(() => fieldChevronUri(bad), ["fieldChevronUri"]), `fieldChevronUri(${JSON.stringify(bad)}) must throw`);
  }

  const light = { fg: "#333333", "fg-hint": "#666666", panel: "#ffffff", "pf-bg": "#f9f9f6", "input-bg": "#ffffff",
    border: "#858585", "focus-bd": "#5d88c2", accent: "#4477bb" };
  const { "fg-hint": _droppedHint, ...lightNoHint } = light;
  check(throwsNaming(() => deriveFieldRoles(lightNoHint), ["fg-hint"]),
    "deriveFieldRoles without fg-hint must throw and name fg-hint");
  const REQUIRED = ["fg", "fg-hint", "input-bg", "focus-bd", "accent", ...FIELD_HOST_ROLES.opt];
  check(throwsNaming(() => deriveFieldRoles({}), REQUIRED),
    `deriveFieldRoles over an empty map must throw listing every missing required input, the default hosts included (${REQUIRED.join(", ")})`);
  // hostRoles [bg] (popup's hosts): the missing-role list after the colon,
  // read as whole role names -- a substring test for "bg" would pass on
  // "input-bg" alone, which is always in the list.
  const ppMissing = (() => { try { deriveFieldRoles({}, null, FIELD_HOST_ROLES.pp); return ""; } catch (e) { return String(e?.message ?? e); } })();
  const ppRoles = ppMissing.includes(": ") ? ppMissing.slice(ppMissing.lastIndexOf(": ") + 2).split(", ") : [];
  check(JSON.stringify(ppRoles) === JSON.stringify(["fg", "fg-hint", "input-bg", "focus-bd", "accent", "bg"]) &&
    ppRoles.includes("bg") && !ppRoles.includes("panel") && !ppRoles.includes("pf-bg"),
    `deriveFieldRoles with hostRoles [bg] must require exactly fg, fg-hint, input-bg, focus-bd, accent, bg -- bg as a role of its own, neither panel nor pf-bg (got: ${ppMissing})`);
  for (const bad of [[], "panel", [""], null]) {
    check(throwsNaming(() => deriveFieldRoles(light, null, bad), ["hostRoles"]),
      `deriveFieldRoles must reject hostRoles ${JSON.stringify(bad)} by name`);
  }
  // `border` is not an input any more: it only fed the retired bottom edge.
  const { border: _droppedBorder, ...lightNoBorder } = light;
  check(JSON.stringify(deriveFieldRoles(lightNoBorder)) === JSON.stringify(deriveFieldRoles(light)),
    "deriveFieldRoles must not read border any more (dropping it must change nothing)");
  check(throwsNaming(() => deriveFieldRoles(lightNoBorder, "var(--opt-border)"), ["border"]),
    "a var(--opt-border) frame still needs border in the map, and must throw naming it");
  // pf-bg fallback. The fixture has to be one where the host actually steers
  // an output, or the check is vacuous: on a light fixture a #000000 host
  // (what hexToRgb(undefined) silently yields once the fallback is gone)
  // constrains nothing, so "no pf-bg" and "pf-bg = panel" agree either way.
  // Here the fill is framed and dark: a black pf-bg host leaves the rest fill
  // only 1.08:1 from it (unseparated -> no hover fill step), while against the
  // panel it sits at 1.28:1 (separated -> the hover fill deepens).
  const pfFx = { fg: "#e0e0e0", "fg-hint": "#a0a0a0", panel: "#262626", "input-bg": "#0d0d0d", border: "#5a5a5a",
    "focus-bd": "#7aa2f7", accent: "#7aa2f7" };
  const pfFrame = "#444444";
  // Hosts are explicit (FIELD_HOST_ROLES): pf-bg has no silent fallback any
  // more, and a missing host throws like any other required input.
  const pfAsPanel = JSON.stringify(deriveFieldRoles({ ...pfFx, "pf-bg": pfFx.panel }, pfFrame));
  check(JSON.stringify(deriveFieldRoles({ ...pfFx, "pf-bg": "#000000" }, pfFrame)) !== pfAsPanel,
    "host precondition: a #000000 pf-bg host must change this fixture's output, or the checks below prove nothing");
  check(throwsNaming(() => deriveFieldRoles(pfFx, pfFrame), ["pf-bg"]),
    "deriveFieldRoles with the default options hosts and no pf-bg must throw naming pf-bg (not fall back, not read hexToRgb(undefined) = #000000)");
  check(JSON.stringify(deriveFieldRoles(pfFx, pfFrame, ["panel"])) === pfAsPanel,
    "one host must derive exactly what that host listed twice derives -- hostRoles alone decides the hosts");
  check(throwsNaming(() => deriveFieldRoles({ ...pfFx, "pf-bg": "transparent" }, pfFrame), ["pf-bg", "transparent"]),
    "a non-hex host must throw naming the role and its value");

  const f = deriveFieldRoles(light);
  const hosts = [light.panel, light["pf-bg"]];
  check(hosts.every((h) => ratio(f["field-bg"], h) >= FILL_SEPARATE_MIN),
    "an unframed field fill must separate from the panel AND the provider-card pf-bg");
  check(f["field-border"] === f["field-bg"] && f["field-border-hover"] === f["field-bg-hover"],
    "an unframed frame collapses into its fill at rest and on hover (§9.1 law 1)");
  check(f["field-bg-focus"] === f["field-bg"], "focus must not repaint the fill (fusedStateStable depends on it)");
  check(ratio(f["field-bg-hover"], f["field-bg"]) >= FILL_SEPARATE_MIN, "the hover fill is one separated step deeper");
  check(Object.keys(f).sort().join() === [...FIELD_ROLES].sort().join(),
    `deriveFieldRoles must return exactly FIELD_ROLES -- no retired field-edge role (got ${Object.keys(f).join(", ")})`);
  check([f["field-bg"], f["field-bg-hover"]].every((h) => ratio(f["field-placeholder"], h) >= 4.5),
    "the placeholder ink clears 4.5:1 on the rest and hover fills");
  check(ratio(f["field-border-focus"], f["field-bg"]) >= 3, "the focus border clears 3:1 on the fill");

  // terminal's shape: framed, fill == panel (unseparated) -> no hover fill step.
  const term = { ...light, fg: "#33ff33", "fg-hint": "#21b621", panel: "#111111", "pf-bg": "#111111",
    "input-bg": "#111111", border: "#267326", "focus-bd": "#33ff33", accent: "#33ff33" };
  const t = deriveFieldRoles(term, "#33ff3340");
  check(t["field-bg"] === "#111111" && t["field-bg-hover"] === "#111111",
    "an unseparated framed fill keeps its pilot value and takes no hover fill step (the frame carries hover)");
  check(t["field-border"] === "#1a4d1a", "a translucent pilot frame is composited over the field fill (#33ff3340 on #111111)");
  check(t["field-border-hover"] === rgbToHex(mix(hexToRgb(t["field-border"]), hexToRgb(term.fg), FRAMED_HOVER_FG_MIX)) &&
    t["field-border-hover"] === "#228222",
    `an unseparated framed box's hover frame must be mix(frame, fg, FRAMED_HOVER_FG_MIX) = #228222 (got ${t["field-border-hover"]})`);
  f8Failures("terminal fixture", t, [term.panel, term["pf-bg"]]).forEach((b) => check(false, b));
  // dracula's shape: framed, but the fill already clears FILL_SEPARATE_MIN
  // from both hosts -> the fill steps on hover, and the frame keeps its one
  // fillSeparate step (FRAMED_HOVER_FG_MIX does not apply).
  const sepFramed = { fg: "#f8f8f2", "fg-hint": "#8995ba", panel: "#21222c", "pf-bg": "#21222c", "input-bg": "#44475a",
    "focus-bd": "#6ba0b4", accent: "#8be9fd" };
  const sf = deriveFieldRoles(sepFramed, "#6272a4");
  check(sf["field-bg"] === "#44475a" && sf["field-bg-hover"] !== sf["field-bg"] && ratio(sf["field-bg-hover"], sf["field-bg"]) >= FILL_SEPARATE_MIN,
    `a separated framed fill keeps its pilot value at rest and steps on hover (got ${sf["field-bg"]} -> ${sf["field-bg-hover"]})`);
  check(sf["field-border-hover"] === rgbToHex(fillSeparate(hexToRgb("#6272a4"), [hexToRgb("#6272a4")], hexToRgb(sepFramed.fg))) &&
    sf["field-border-hover"] === "#6a79a8",
    `a separated framed box's hover frame keeps the one fillSeparate step (#6a79a8), not the FRAMED_HOVER_FG_MIX mix (got ${sf["field-border-hover"]})`);

  const byRef = deriveFieldRoles(light, "var(--opt-border)");
  check(byRef["field-border"] === "#858585", "a var(--opt-<role>) frame must resolve through the map, not collapse to the fill");
  // A frame the deriver cannot resolve must throw, never collapse silently into
  // the fill (resolveOpaqueBg reads anything unparseable as transparent).
  // input-border is not a required input, so the required-input check cannot
  // pre-empt the missing-var-target throw here.
  check(!("input-border" in light) && throwsNaming(() => deriveFieldRoles(light, "var(--opt-input-border)"), ["input-border"]),
    "a var(--opt-<role>) frame whose role is absent from the map must throw and name the role");
  // "rebeccapurple", not "red": "red" is a substring of "required", so a
  // missing-input throw would have satisfied throwsNaming vacuously.
  for (const bad of ["rgba(0,0,0,.5)", "var(--opt-border, #ccc)", "rebeccapurple"]) {
    check(throwsNaming(() => deriveFieldRoles(light, bad), [bad]),
      `an unparseable framed value (${bad}) must throw with the value in the message, not collapse into the fill`);
  }

  // Required inputs must be a hex the deriver reads correctly (final fix
  // wave, alignment F1): hexToRgb parses any other spelling as #000000.
  check(throwsNaming(() => deriveFieldRoles({ ...light, "input-bg": "rgb(234, 234, 234)" }), ["input-bg", "rgb(234, 234, 234)"]),
    "a non-hex required input (input-bg: rgb()) must throw naming the role and its value, not derive the fill from #000000");
  check(throwsNaming(() => deriveFieldRoles({ ...light, fg: "#333333cc" }), ["fg", "#333333cc"]),
    "an 8-digit ink (fg) must throw -- hexToRgb reads an 8-digit hex's bytes wrongly; only a framed border is composited");
  check(!(() => { try { deriveFieldRoles(light, "#85858580"); return false; } catch { return true; } })(),
    "an 8-digit framed border stays valid (it is composited over the fill by resolveOpaqueBg)");
  check(JSON.stringify(deriveFieldRoles({ ...light, "input-bg": " #ffffff ", fg: " #333333 " })) === JSON.stringify(deriveFieldRoles(light)),
    "surrounding whitespace on a required input is trimmed before parsing (hexToRgb strips '#' before trimming: ' #ffffff ' would read as #000000)");
  // Frame value with surrounding spaces: trimmed before resolveOpaqueBg, so it
  // resolves exactly like the unspaced value (it used to pass the frame check
  // and come out #000000) ...
  const spacedFrame = deriveFieldRoles(light, " #6272a4 ");
  check(spacedFrame["field-border"] === "#6272a4" && JSON.stringify(spacedFrame) === JSON.stringify(deriveFieldRoles(light, "#6272a4")),
    `a framed border with surrounding spaces must resolve like the unspaced value (got field-border ${spacedFrame["field-border"]})`);
  // ... and a spaced value that is not a hex still throws, naming it.
  check(throwsNaming(() => deriveFieldRoles(light, " rebeccapurple "), [" rebeccapurple "]),
    "a framed border with surrounding spaces that is not a hex must throw with the value in the message");

  // R12: the hover fill steps AWAY from its hosts. A recessed well (a fill
  // DARKER than its panel on a dark theme, gruvbox-dark's shape) must darken
  // on hover; mixing toward its light fg would walk it back into the panel.
  const well = { fg: "#ebdbb2", "fg-hint": "#a89984", panel: "#3c3836", "pf-bg": "#3c3836", "input-bg": "#302f2e",
    border: "#9f958f", "focus-bd": "#7e9e92", accent: "#83a598" };
  const w = deriveFieldRoles(well);
  const wellHosts = [well.panel, well["pf-bg"]];
  check(ratio(w["field-bg"], well.panel) >= FILL_SEPARATE_MIN && relLum(hexToRgb(w["field-bg"])) < relLum(hexToRgb(well.panel)),
    "recessed-well fixture precondition: the rest fill is separated and darker than its host");
  check(relLum(hexToRgb(w["field-bg-hover"])) < relLum(hexToRgb(w["field-bg"])),
    `a recessed well must DARKEN on hover (away from its lighter host), got ${w["field-bg"]} -> ${w["field-bg-hover"]}`);
  check(ratio(w["field-bg-hover"], w["field-bg"]) >= FILL_SEPARATE_MIN &&
    wellHosts.every((h) => ratio(w["field-bg-hover"], h) >= FILL_SEPARATE_MIN && ratio(w["field-bg-hover"], h) >= ratio(w["field-bg"], h)),
    "a well's hover fill separates from the rest fill and from every host, and no less than the rest fill does");
  check(w["field-border-hover"] === w["field-bg-hover"], "an unframed well's frame follows its hover fill");
  // The mirror: a dark theme whose field is RAISED above its panel lightens
  // (toward its light fg, the pre-R12 behaviour, byte-identical there).
  const raised = { ...well, "input-bg": "#4a4644" };
  const rz = deriveFieldRoles(raised);
  check(relLum(hexToRgb(rz["field-bg"])) > relLum(hexToRgb(raised.panel)) &&
    relLum(hexToRgb(rz["field-bg-hover"])) > relLum(hexToRgb(rz["field-bg"])) &&
    rz["field-bg-hover"] === rgbToHex(fillSeparate(hexToRgb(rz["field-bg"]), [hexToRgb(rz["field-bg"])], hexToRgb(raised.fg))),
    "a raised dark field lightens on hover, exactly as the pre-R12 toward-fg step");

  // R13: typed text must be tellable apart from the placeholder.
  // (a) fg already clears the floor -> field-fg is fg and the placeholder is
  //     the untouched fgToAAMulti(fg-hint) result (the default :root's shape).
  check(f["field-fg"] === "#333333" && ratio(f["field-fg"], f["field-placeholder"]) >= FIELD_TEXT_PLACEHOLDER_MIN &&
    f["field-placeholder"] === rgbToHex(fgToAAMulti(hexToRgb(light["fg-hint"]), [hexToRgb(f["field-bg"]), hexToRgb(f["field-bg-hover"])], 4.5)),
    "where fg already clears FIELD_TEXT_PLACEHOLDER_MIN, field-fg = fg and the placeholder is not moved");
  // (b) a placeholder with head-room above 4.5:1 moves toward the fills far
  //     enough on its own -- typed text keeps fg.
  const roomy = deriveFieldRoles({ ...light, "fg-hint": "#444444" });
  check(ratio("#333333", "#444444") < FIELD_TEXT_PLACEHOLDER_MIN && roomy["field-fg"] === "#333333" &&
    ratio(roomy["field-fg"], roomy["field-placeholder"]) >= FIELD_TEXT_PLACEHOLDER_MIN &&
    relLum(hexToRgb(roomy["field-placeholder"])) > relLum(hexToRgb("#444444")) &&
    [roomy["field-bg"], roomy["field-bg-hover"]].every((h) => ratio(roomy["field-placeholder"], h) >= 4.5),
    `a placeholder with room above 4.5:1 must lighten toward the (light) fills until typed text (fg) is >= ${FIELD_TEXT_PLACEHOLDER_MIN}:1 from it, staying >= 4.5:1 on both fills (got ${roomy["field-placeholder"]}, field-fg ${roomy["field-fg"]})`);
  // (c) solarized-light's shape: the placeholder already sits at 4.5:1 on the
  //     hover fill and cannot move, so typed text darkens (away from the
  //     light fills) until it clears the floor.
  const lowC = { fg: "#4a5c61", "fg-hint": "#5b686a", panel: "#eee8d5", "pf-bg": "#eee8d5", "input-bg": "#e1decf",
    border: "#88774b", "focus-bd": "#4784ad", accent: "#1e6ca4" };
  const lc = deriveFieldRoles(lowC);
  check(ratio(lc["field-fg"], lc["field-placeholder"]) >= FIELD_TEXT_PLACEHOLDER_MIN &&
    relLum(hexToRgb(lc["field-fg"])) < relLum(hexToRgb(lowC.fg)) &&
    [lc["field-bg"], lc["field-bg-hover"]].every((h) => ratio(lc["field-placeholder"], h) >= 4.5 && ratio(lc["field-fg"], h) >= 4.5),
    `low-contrast fixture: field-fg must darken away from the light fills until >= ${FIELD_TEXT_PLACEHOLDER_MIN}:1 from the placeholder (got ${lc["field-fg"]} vs ${lc["field-placeholder"]})`);
  // (d) the dark mirror: typed text LIGHTENS away from dark fills.
  const lowD = { fg: "#aeb9b9", "fg-hint": "#8e9e9f", panel: "#073642", "pf-bg": "#073642", "input-bg": "#163d46",
    border: "#1191ad", "focus-bd": "#268bd2", accent: "#268bd2" };
  const ld = deriveFieldRoles(lowD);
  check(ratio(ld["field-fg"], ld["field-placeholder"]) >= FIELD_TEXT_PLACEHOLDER_MIN && relLum(hexToRgb(ld["field-fg"])) > relLum(hexToRgb(lowD.fg)),
    `low-contrast dark fixture: field-fg must lighten away from the dark fills (got ${ld["field-fg"]})`);

  // R13 minimality on the unit fixtures (follow-up 7c): the light and dark
  // push cases really push, the roomy one only moves the placeholder.
  {
    const lcMin = r13MinimalityFailures("lowC", lowC, lc);
    const ldMin = r13MinimalityFailures("lowD", lowD, ld);
    const roomyMin = r13MinimalityFailures("roomy", { ...light, "fg-hint": "#444444" }, roomy);
    [lcMin, ldMin, roomyMin].forEach((m) => m.bad.forEach((b) => check(false, b)));
    check(lcMin.pushed && ldMin.pushed && !roomyMin.pushed && roomyMin.placeholderMoved,
      `R13 minimality fixtures no longer exercise both steps (lowC pushed=${lcMin.pushed}, lowD pushed=${ldMin.pushed}, roomy pushed=${roomyMin.pushed} / placeholder moved=${roomyMin.placeholderMoved})`);
  }

  // A fill lying BETWEEN its two hosts' luminances (follow-up 7b). Stepping
  // away from BOTH is impossible there -- WCAG contrast is monotone in
  // luminance, so any step raises the separation from one host and lowers it
  // from the other. The documented rule (deriveFieldRoles' header): step away
  // from the NEARER host (lower contrast), toward fg when fg lies on that
  // side, else toward that side's pole; the step still clears
  // FILL_SEPARATE_MIN against the rest fill and against BOTH hosts. All four
  // shapes: dark/light theme x nearer host lighter/darker, which covers both
  // targets in both directions. `target` is the hand-labelled expectation;
  // the fgs are tinted so a fg target and a pole target land on different
  // bytes (with a grey fg both reach the same hex and the check is blind).
  {
    const bx = { "fg-hint": "#9a9a9a", border: "#8a8a8a", "focus-bd": "#7aa2f7", accent: "#7aa2f7" };
    const BETWEEN = [
      { id: "dark, nearer host darker", fx: { ...bx, fg: "#a0c0e0", panel: "#4a4a4a", "pf-bg": "#1a1a1a", "input-bg": "#333333" }, target: "fg" },
      { id: "dark, nearer host lighter", fx: { ...bx, fg: "#a0c0e0", panel: "#505050", "pf-bg": "#1a1a1a", "input-bg": "#3d3d3d" }, target: "#000000" },
      { id: "light, nearer host darker", fx: { ...bx, fg: "#204060", "fg-hint": "#666666", panel: "#ffffff", "pf-bg": "#c8c8c8", "input-bg": "#dadada" }, target: "#ffffff" },
      { id: "light, nearer host lighter", fx: { ...bx, fg: "#204060", "fg-hint": "#666666", panel: "#f8f8f8", "pf-bg": "#b0b0b0", "input-bg": "#d4d4d4" }, target: "fg" },
    ];
    for (const { id, fx, target } of BETWEEN) {
      const out = deriveFieldRoles(fx);
      const rest = out["field-bg"], hover = out["field-bg-hover"];
      const lum = (x) => relLum(hexToRgb(x));
      const [near, far] = [fx.panel, fx["pf-bg"]].sort((a, b) => ratio(rest, a) - ratio(rest, b));
      check((lum(rest) - lum(fx.panel)) * (lum(rest) - lum(fx["pf-bg"])) < 0 &&
        [fx.panel, fx["pf-bg"]].every((hh) => ratio(rest, hh) >= FILL_SEPARATE_MIN) && ratio(rest, near) < ratio(rest, far),
        `between-hosts fixture (${id}) precondition: the rest fill ${rest} must sit strictly between its hosts, separated from both, with one strictly nearer`);
      check(ratio(hover, near) > ratio(rest, near) && ratio(hover, far) < ratio(rest, far),
        `between-hosts (${id}): the hover step must move AWAY from the nearer host ${near} (and so, unavoidably, toward ${far}) -- rest ${rest} -> hover ${hover}: near ${ratio(rest, near).toFixed(3)} -> ${ratio(hover, near).toFixed(3)}, far ${ratio(rest, far).toFixed(3)} -> ${ratio(hover, far).toFixed(3)}`);
      check(ratio(hover, rest) >= FILL_SEPARATE_MIN && [near, far].every((hh) => ratio(hover, hh) >= FILL_SEPARATE_MIN),
        `between-hosts (${id}): the hover fill ${hover} must clear FILL_SEPARATE_MIN against the rest fill and against BOTH hosts`);
      const t = target === "fg" ? hexToRgb(fx.fg) : hexToRgb(target);
      check(hover === rgbToHex(fillSeparate(hexToRgb(rest), [hexToRgb(rest), hexToRgb(fx.panel), hexToRgb(fx["pf-bg"])], t)),
        `between-hosts (${id}): the hover step must mix toward ${target === "fg" ? `fg ${fx.fg}` : target} (fg when it lies on the side away from the nearer host, else that side's pole) -- got ${hover}`);
    }
  }

  const weakFocus = deriveFieldRoles({ ...light, "focus-bd": "#c8d6ea" });
  check(weakFocus["field-border-focus"] !== "#c8d6ea" && ratio(weakFocus["field-border-focus"], weakFocus["field-bg"]) >= 3,
    "a focus-bd under 3:1 on the field fill must be re-derived with focusBdToAA");
}

// --- Soft Fill field family over the real composer pipeline, every options
// theme. Category assertions (not per-theme literals): the same invariants
// contrast-audit gates on the shipped CSS, run against composeOptionsThemeMap
// so a deriver change is caught before sync-all writes it. ---
{
  const hex6 = (v) => rgbToHex(hexToRgb(String(v).trim()));
  const lum = (v) => relLum(hexToRgb(v));
  // Class membership (stage 4 spec §2.4): which blocks take the framed-
  // unseparated branch (fill frozen, frame carries hover), the framed-but-
  // separated branch, and the between-two-hosts branch (floors only, no
  // direction). Each class is decided by measured ratios, so one drifting
  // theme could change class silently -- the equality guards after the walk
  // pin every member.
  const classes = { unseparatedFramed: [], separatedFramed: [], between: [], searchFramedUnseparated: [] };
  // Category assertions shared by the 14 themed maps and the default :root.
  // `framed` = the pilot declares ui.options.<mode>.input-border (§9.5).
  const fieldCategory = (id, map, framed) => {
    check(FIELD_ROLES.every((r) => /^#[0-9a-f]{6}$/.test(map[r] ?? "")), `${id}: options map lacks a field-* role`);
    check(!Object.keys(map).some((k) => /^field-edge/.test(k)), `${id}: options map still carries a retired field-edge role`);
    check(isHex(map["field-placeholder"]) && map["field-chevron"] === fieldChevronUri(map["field-placeholder"]),
      `${id}: field-chevron is not fieldChevronUri(field-placeholder ${map["field-placeholder"]}) -- got ${map["field-chevron"]}`);
    const hosts = FIELD_HOST_ROLES.opt.map((r) => map[r]);
    check(map["field-bg-focus"] === map["field-bg"], `${id}: focus repaints the fill`);
    // The sidebar search box (stage 4 Task 4; contrast-audit's
    // auditSidebarSearchSeparation gates the shipped CSS the same way) sits
    // on --opt-bg, not on a field host. Its class is read against that one
    // host: framed with the fill under FILL_SEPARATE_MIN from bg -> the rest
    // frame carries the boundary (F8b); otherwise the fill does (F1).
    if (framed && ratio(map["field-bg"], map.bg) < FILL_SEPARATE_MIN) {
      classes.searchFramedUnseparated.push(`opt:${id}`);
      check(ratio(map["field-border"], map.bg) >= FIELD_FRAME_HOST_MIN,
        `${id}: the sidebar search box's frame ${map["field-border"]} is ${ratio(map["field-border"], map.bg).toFixed(3)}:1 from --opt-bg ${map.bg} (F8b floor ${FIELD_FRAME_HOST_MIN})`);
    } else {
      check(ratio(map["field-bg"], map.bg) >= FILL_SEPARATE_MIN,
        `${id}: the sidebar search box's fill ${map["field-bg"]} is ${ratio(map["field-bg"], map.bg).toFixed(3)}:1 from --opt-bg ${map.bg} (F1 floor FILL_SEPARATE_MIN ${FILL_SEPARATE_MIN})`);
    }
    // contrast-audit classifies a block as framed by field-border != field-bg;
    // that has to agree with the pilot actually declaring a frame.
    check(framed === (map["field-border"] !== map["field-bg"]),
      `${id}: the pilot ${framed ? "declares" : "declares no"} input-border, but field-border ${map["field-border"]} ${framed ? "equals" : "differs from"} field-bg ${map["field-bg"]}`);
    const unseparated = hosts.some((h) => ratio(map["field-bg"], h) < FILL_SEPARATE_MIN);
    // F1: an unframed fill always separates from every host.
    check(framed || !unseparated,
      `${id}: unframed fill ${map["field-bg"]} is under FILL_SEPARATE_MIN from a host (${hosts.map((h) => ratio(map["field-bg"], h).toFixed(3)).join(" / ")})`);
    if (!framed) {
      check(map["field-border"] === map["field-bg"] && map["field-border-hover"] === map["field-bg-hover"],
        `${id}: an unframed frame must collapse into its fill at rest and on hover (§9.1 law 1)`);
    }
    check((framed && unseparated) === (map["field-bg-hover"] === map["field-bg"]),
      `${id}: framed-and-unseparated (${framed && unseparated}) must hold exactly when field-bg-hover == field-bg (${map["field-bg-hover"]} vs ${map["field-bg"]})`);
    if (framed && unseparated) {
      classes.unseparatedFramed.push(`opt:${id}`);
      // F8 / F8b: the frame alone carries hover.
      check(map["field-border-hover"] === rgbToHex(mix(hexToRgb(map["field-border"]), hexToRgb(hex6(map.fg)), FRAMED_HOVER_FG_MIX)),
        `${id}: an unseparated framed box's hover frame ${map["field-border-hover"]} is not mix(frame ${map["field-border"]}, fg ${map.fg}, FRAMED_HOVER_FG_MIX)`);
      f8Failures(id, map, hosts).forEach((b) => check(false, b));
    } else {
      if (framed) {
        classes.separatedFramed.push(`opt:${id}`);
        const frame = hexToRgb(map["field-border"]);
        check(map["field-border-hover"] === rgbToHex(fillSeparate(frame, [frame], hexToRgb(hex6(map.fg)))),
          `${id}: a separated framed box's hover frame ${map["field-border-hover"]} is not the one fillSeparate step from ${map["field-border"]}`);
      }
      // F2 / F3, and R12's direction: the hover fill steps away from every
      // host -- except for a fill lying between two hosts, which can only
      // move away from the nearer one (floors only there).
      const between = hosts.some((h) => lum(h) > lum(map["field-bg"])) && hosts.some((h) => lum(h) < lum(map["field-bg"]));
      if (between) classes.between.push(`opt:${id}`);
      check(ratio(map["field-bg-hover"], map["field-bg"]) >= FILL_SEPARATE_MIN,
        `${id}: the hover fill ${map["field-bg-hover"]} is under FILL_SEPARATE_MIN from the rest fill ${map["field-bg"]}`);
      for (const h of hosts) {
        check(ratio(map["field-bg-hover"], h) >= FILL_SEPARATE_MIN && (between || ratio(map["field-bg-hover"], h) >= ratio(map["field-bg"], h)),
          `${id}: the hover fill ${map["field-bg-hover"]} steps toward host ${h} (${ratio(map["field-bg-hover"], h).toFixed(3)} vs rest ${ratio(map["field-bg"], h).toFixed(3)}; floor ${FILL_SEPARATE_MIN})`);
      }
    }
    // R13: typed text vs placeholder.
    check(ratio(map["field-fg"], map["field-placeholder"]) >= FIELD_TEXT_PLACEHOLDER_MIN,
      `${id}: field-fg ${map["field-fg"]} is ${ratio(map["field-fg"], map["field-placeholder"]).toFixed(3)}:1 from the placeholder ${map["field-placeholder"]} (floor ${FIELD_TEXT_PLACEHOLDER_MIN})`);
    check(ratio(hex6(map.fg), map["field-placeholder"]) < FIELD_TEXT_PLACEHOLDER_MIN || map["field-fg"] === hex6(map.fg),
      `${id}: fg ${map.fg} already clears the floor against the placeholder, so field-fg must be fg (got ${map["field-fg"]})`);
    // ...and the placeholder only moves when it has to: where fg already
    // clears the floor against the plain AA placeholder, that is what ships.
    const p0 = rgbToHex(fgToAAMulti(hexToRgb(map["fg-hint"].trim()), [hexToRgb(map["field-bg"]), hexToRgb(map["field-bg-hover"])], 4.5));
    check(ratio(hex6(map.fg), p0) < FIELD_TEXT_PLACEHOLDER_MIN || (map["field-placeholder"] === p0 && map["field-fg"] === hex6(map.fg)),
      `${id}: fg ${map.fg} already clears the floor against the AA placeholder ${p0}, so neither ink may move (got placeholder ${map["field-placeholder"]}, field-fg ${map["field-fg"]})`);
    check([map["field-bg"], map["field-bg-hover"]].every((h) => ratio(map["field-fg"], h) >= 4.5),
      `${id}: field-fg ${map["field-fg"]} under 4.5:1 on a field fill`);
    check([map["field-bg"], map["field-bg-hover"]].every((h) => ratio(map["field-placeholder"], h) >= 4.5),
      `${id}: field-placeholder ${map["field-placeholder"]} under 4.5:1 on a field fill`);
    // R13 minimality (follow-up 7c): neither step of the R13 move overshoots.
    const min = r13MinimalityFailures(id, map, map);
    min.bad.forEach((b) => check(false, b));
    if (min.pushed) r13Pushed.push(id);
  };
  const r13Pushed = [];
  let walked = 0;
  for (const entry of POPUP_THEME_MAP) {
    const tk = JSON.parse(readFileSync(new URL(`../docs/theme-surface/pilots/${entry.pilot}.tokens.json`, import.meta.url), "utf8"));
    const { map } = composeOptionsThemeMap(tk, entry.mode, entry.useDarkMode);
    walked++;
    fieldCategory(entry.id, map, tk.ui?.options?.[entry.mode]?.["input-border"] != null);
  }
  check(walked === POPUP_THEME_MAP.length && walked === 14, `field-family pipeline walk visited ${walked} themes, expected 14`);
  // The 15th block: the default :root (never framed), folded from the shipped
  // CSS the same way the re-derivation block below reads it.
  const rootCss = readFileSync(new URL("../options.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rootDict = {};
  for (const m of rootCss.matchAll(/(?:^|\n):root\s*\{([^}]*)\}/g)) {
    for (const d of m[1].matchAll(/--opt-([a-z0-9-]+)\s*:\s*([^;]+);/g)) rootDict[d[1]] = d[2].trim();
  }
  check(FIELD_ROLES.every((r) => r in rootDict) && "field-chevron" in rootDict,
    "field-family pipeline walk: the folded default :root lacks a field-* role or field-chevron");
  fieldCategory(":root", rootDict, false);
  // The shipped themes must exercise the field-fg push, or the minimality
  // check above ran on nothing but the unit fixtures.
  check(r13Pushed.length >= 1, `R13 minimality: no shipped options theme pushes field-fg away from fg (pushed: ${JSON.stringify(r13Pushed)}) -- the pipeline half of the check is vacuous`);
  // §2.4 class guards: equality, not "at least", so a theme cannot drift into
  // or out of a floor-exempt branch without this failing.
  const members = (a) => [...a].sort().join(", ");
  check(members(classes.unseparatedFramed) === "opt:rose-pine, opt:terminal",
    `framed-and-unseparated blocks (fill frozen on hover, frame carries it) must be exactly {opt:rose-pine, opt:terminal}, got {${members(classes.unseparatedFramed)}}`);
  check(members(classes.separatedFramed) === "opt:dracula, opt:nord-night",
    `framed-but-separated blocks must be exactly {opt:dracula, opt:nord-night}, got {${members(classes.separatedFramed)}}`);
  check(members(classes.between) === "",
    `no options block may have a fill between its two hosts (floors-only branch), got {${members(classes.between)}}`);
  check(members(classes.searchFramedUnseparated) === "opt:terminal",
    `sidebar search boxes whose frame carries the boundary on --opt-bg (framed, fill under FILL_SEPARATE_MIN from bg) must be exactly {opt:terminal}, got {${members(classes.searchFramedUnseparated)}}`);
  // The shipped themes must actually exercise both R12 branches, or the
  // category checks above prove nothing about the direction rule.
  const WELLS = ["gruvbox-dark", "catppuccin-mocha"];
  let darkened = 0;
  for (const entry of POPUP_THEME_MAP.filter((e) => WELLS.includes(e.id))) {
    const tk = JSON.parse(readFileSync(new URL(`../docs/theme-surface/pilots/${entry.pilot}.tokens.json`, import.meta.url), "utf8"));
    const { map } = composeOptionsThemeMap(tk, entry.mode, entry.useDarkMode);
    if (relLum(hexToRgb(map["field-bg"])) < relLum(hexToRgb(map.panel)) && relLum(hexToRgb(map["field-bg-hover"])) < relLum(hexToRgb(map["field-bg"]))) darkened++;
  }
  check(darkened === WELLS.length, `recessed wells (${WELLS.join(", ")}) must be darker than their panel and darken on hover -- ${darkened}/${WELLS.length}`);
}

// --- Host tables and orphan keying (stage 4 spec §2.4 / §5.1).
// contrast-audit lists the field hosts per CSS prefix itself (never through
// ROLE_ALIAS); every surface that derives field roles must have an entry,
// and it must be the deriver's own FIELD_HOST_ROLES -- otherwise the
// fill-vs-host floors are audited against the wrong surface, or not at all. ---
{
  const SURFACE_OF = { pp: "popup", opt: "options", lib: "library" };
  for (const [ns, surface] of Object.entries(SURFACE_OF)) {
    const derives = UI_DERIVED_OUTPUT_ROLES[surface].includes("field-bg");
    const audited = Object.prototype.hasOwnProperty.call(FIELD_SEPARATION_HOSTS, ns);
    check(derives === audited,
      `${ns}: ${derives ? "derives field roles but contrast-audit's FIELD_SEPARATION_HOSTS has no entry, so its fill-vs-host floors go unaudited" : "has a FIELD_SEPARATION_HOSTS entry but derives no field roles"}`);
    if (audited) {
      check(JSON.stringify(FIELD_SEPARATION_HOSTS[ns]) === JSON.stringify(FIELD_HOST_ROLES[ns]),
        `${ns}: contrast-audit's FIELD_SEPARATION_HOSTS ${JSON.stringify(FIELD_SEPARATION_HOSTS[ns])} differs from _ui-derive.mjs's FIELD_HOST_ROLES ${JSON.stringify(FIELD_HOST_ROLES[ns])}`);
    }
  }
  // The orphan guard's coverage set is keyed by surface: a pp-only row covers
  // pp:<role> and nothing on the other two surfaces.
  check(COMPONENT_PAIR_ROLES.has("pp:ai-chip-fg") && !COMPONENT_PAIR_ROLES.has("opt:ai-chip-fg") &&
    !COMPONENT_PAIR_ROLES.has("lib:ai-chip-fg") && !COMPONENT_PAIR_ROLES.has("ai-chip-fg"),
    "contrast-audit's COMPONENT_PAIR_ROLES must be keyed `${ns}:${role}` over each row's onlyNs (a popup-only row must not cover options/library)");
}

// --- The field family is options-only: popup and library must not grow it.
// Checked at the composer level (the maps each surface actually emits, for
// every theme) and in the shipped CSS, so turning fieldRoles on in
// popup-chrome.mjs / library-chrome.mjs fails here even while every other
// gate stays green. ---
{
  let walked = 0;
  for (const entry of POPUP_THEME_MAP) {
    const tk = JSON.parse(readFileSync(new URL(`../docs/theme-surface/pilots/${entry.pilot}.tokens.json`, import.meta.url), "utf8"));
    const popupMap = composePopupThemeMap(tk, entry.mode, entry.useDarkMode);
    const libraryMap = composeLibraryThemeMap(tk, entry.mode, entry.useDarkMode).map;
    walked++;
    check(Object.keys(popupMap).length > 0 && !Object.keys(popupMap).some((k) => k.startsWith("field-")),
      `${entry.id}: the popup map carries field-* roles (the B+ field family is options-only)`);
    check(Object.keys(libraryMap).length > 0 && !Object.keys(libraryMap).some((k) => k.startsWith("field-")),
      `${entry.id}: the library map carries field-* roles (the B+ field family is options-only)`);
  }
  check(walked === 14, `options-only field-family walk visited ${walked} themes, expected 14`);
  const popupCss = readFileSync(new URL("../popup.css", import.meta.url), "utf8");
  const libraryCss = readFileSync(new URL("../library.css", import.meta.url), "utf8");
  check(popupCss.includes("--pp-") && !popupCss.includes("--pp-field-"), "popup.css declares or consumes --pp-field-* (the B+ field family is options-only)");
  check(libraryCss.includes("--lib-") && !libraryCss.includes("--lib-field-"), "library.css declares or consumes --lib-field-* (the B+ field family is options-only)");
}

// --- The default :root literals (options-chrome.mjs DEFAULT_LIGHT) are the
// deriver's output over the folded shipped :root blocks, not hand picks. ---
{
  const css = readFileSync(new URL("../options.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const dict = {};
  for (const m of css.matchAll(/(?:^|\n):root\s*\{([^}]*)\}/g)) {
    for (const d of m[1].matchAll(/--opt-([a-z0-9-]+)\s*:\s*([^;]+);/g)) dict[d[1]] = d[2].trim();
  }
  const want = deriveFieldRoles(dict);
  for (const role of FIELD_ROLES) {
    check(dict[role] === want[role],
      `default :root --opt-${role}=${dict[role]} is not deriveFieldRoles(folded :root)=${want[role]} -- DEFAULT_LIGHT drifted from its hand :root inputs (fg / fg-hint / pf-bg / focus-bd / accent), or FRAMED_HOVER_FG_MIX / the deriver changed -- re-run sync-all and update DEFAULT_LIGHT and ANCHORS`);
  }
  check(dict["field-chevron"] === fieldChevronUri(want["field-placeholder"]),
    `default :root --opt-field-chevron is not fieldChevronUri(${want["field-placeholder"]}) -- DEFAULT_LIGHT's field-chevron drifted from its field-placeholder`);
}

// --- Anchors: 6 blocks x 8 roles read back from the SHIPPED generated region
// (not from the deriver), +-1 per channel -- a drift anywhere between
// deriveFieldRoles and options.css (wiring, emit, a hand edit) fails here.
// The fill / border columns are the research values the user approved (the
// B+ comparison page https://claude.ai/artifact/EBpjZuxTmXQLjcvzqskvsX); the
// others are the derivation, pinned so it cannot move silently. Stage 4
// (spec 2026-09-30 §2.2): the two field-edge columns are gone with the
// roles; terminal's and rose-pine's hover frames are mix(frame, fg,
// FRAMED_HOVER_FG_MIX) (#1b551b -> #228222, #474459 -> #706d83; rose-pine
// joins the table to pin it); nord-night, a framed but separated block,
// keeps its fillSeparate hover frame #535d70. Every block's field-chevron is
// checked below against its own field-placeholder. ---
{
  const css = readFileSync(new URL("../options.css", import.meta.url), "utf8");
  const region = css.slice(css.indexOf("/* @generated:ui-themes start"), css.indexOf("/* @generated:ui-themes end */"));
  const blockOf = (selector) => {
    const at = region.indexOf(`${selector} {`);
    return at < 0 ? null : region.slice(at, region.indexOf("}", at));
  };
  const near = (a, b) => isHex(a) && hexToRgb(a).every((c, i) => Math.abs(c - hexToRgb(b)[i]) <= 1);
  const ANCHORS = {
    ":root": ["#eaeaea", "#eaeaea", "#dfdfdf", "#dfdfdf", "#eaeaea", "#5d88c2", "#616161", "#333333"],
    'html[data-theme="terminal"]': ["#111111", "#1a4d1a", "#111111", "#228222", "#111111", "#33ff33", "#21b621", "#33ff33"],
    'html[data-theme="paper-ink"]': ["#e6e5e3", "#e6e5e3", "#dbdad8", "#dbdad8", "#e6e5e3", "#1a3a5c", "#5c5c5c", "#2c2c2c"],
    'html[data-theme="nord-night"]': ["#434c5e", "#4c566a", "#4a5364", "#535d70", "#434c5e", "#75a0b0", "#c0c6d2", "#e5e9f0"],
    'html[data-theme="gruvbox-dark"]': ["#302f2e", "#302f2e", "#292828", "#292828", "#302f2e", "#7e9e92", "#aca093", "#ebdbb2"],
    'html[data-theme="rose-pine"]': ["#26233a", "#403d52", "#26233a", "#706d83", "#26233a", "#7d6c99", "#8e8ba3", "#e0def4"],
  };
  let compared = 0;
  for (const [selector, values] of Object.entries(ANCHORS)) {
    const body = blockOf(selector);
    check(!!body, `anchor block ${selector} not found in options.css @generated:ui-themes`);
    FIELD_ROLES.forEach((role, i) => {
      const got = (body?.match(new RegExp(`--opt-${role}:\\s*([^;]+);`)) || [])[1]?.trim();
      compared++;
      check(near(got, values[i]), `${selector} --opt-${role}=${got} drifted from the anchor ${values[i]} (+-1/channel) -- a wiring/emit/hand-edit drift, or FRAMED_HOVER_FG_MIX / the deriver changed -- re-run sync-all and update DEFAULT_LIGHT and ANCHORS`);
    });
  }
  check(compared === 48, `field anchor block made ${compared} comparisons, expected 48 (6 blocks x 8 roles)`);
  // field-chevron, every shipped block: its stroke is that block's own
  // field-placeholder (spec §2.2), in the ";"-free data-URI form.
  let chevrons = 0;
  for (const m of region.matchAll(/(?:^|\n)(html\[data-theme="[^"]+"\]|:root) \{([^}]*)\}/g)) {
    const decl = (role) => (m[2].match(new RegExp(`--opt-${role}:\\s*([^;]+);`)) || [])[1]?.trim();
    const placeholder = decl("field-placeholder");
    chevrons++;
    check(isHex(placeholder) && decl("field-chevron") === fieldChevronUri(placeholder),
      `${m[1]} --opt-field-chevron ${decl("field-chevron")} is not fieldChevronUri(its --opt-field-placeholder ${placeholder})`);
  }
  check(chevrons === 15, `field-chevron check visited ${chevrons} options blocks, expected 15 (14 themes + :root)`);
}

if (failures.length) {
  console.error(failures.map((message) => `FAIL ${message}`).join("\n"));
  process.exit(1);
}

console.log("theme UI derivation tests ok");
