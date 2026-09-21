import {
  contrast,
  deltaE2000,
  fillDistinct,
  fillSeparate,
  FILL_SEPARATE_MIN,
  finalizeUiControlRoles,
  hexToRgb,
  relLum,
  resolveOpaqueBg,
  rgbToHex,
  TIER_DISTINCT_MIN_DE,
} from "../docs/theme-surface/composers/_ui-derive.mjs";

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

if (failures.length) {
  console.error(failures.map((message) => `FAIL ${message}`).join("\n"));
  process.exit(1);
}

console.log("theme UI derivation tests ok");
