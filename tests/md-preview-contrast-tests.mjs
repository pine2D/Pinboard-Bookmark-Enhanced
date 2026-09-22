// md-preview-contrast-tests — a WCAG contrast gate over md-preview.css's
// `:root` light-dark() token palette.
//
// md-preview is the one surface OUTSIDE the theme factory (CLAUDE.md /
// .claude/rules/md-preview.md): no @generated regions, no per-preset
// blocks, a single `:root { --x: light-dark(light, dark); }` token set that
// every rule in the file references directly. Nothing in
// docs/theme-surface/tools/contrast-audit.mjs looks at this file (its own
// header says so), so until this test existed there was no static check on
// any md-preview color pair at all (taste-uplift batch3 T1, investigation
// docs/superpowers/plans/2026-09-22-batch3-inputs/C-reader-notes.md: "任何
// 门都不量 md-preview 颜色").
//
// Static, not rendered: this parses the CSS text (same approach as
// contrast-audit.mjs) rather than loading a browser, so it runs in plain
// node and reuses the exact WCAG relative-luminance formula every other
// contrast gate in this repo uses (tests/contrast-tests.html's own comment:
// "same formula as tools/contrast-audit.mjs").
//
// Token-level, not selector-level: every pair below is a (text token, fill
// token) contract -- e.g. "link vs btn-hover" is ONE number per mode
// regardless of which selector consumes it (.srch-regex[aria-pressed],
// .typo-seg-btn[aria-pressed], .pbv-*[aria-pressed], #ask-scope-near
// [aria-pressed], and after this task's CSS change six more). Citations in
// each PAIR entry name representative consumers as of this commit; line
// numbers drift with future edits the way every other "~:NNN" comment in
// this file does; the token names are the durable contract.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Reuse the factory's own gamma-space color-mix lerp rather than
// reimplementing it -- required by this task's spec ("evaluate color-mix
// as gamma-space lerp, same as the factory's mix()"). _ui-derive.mjs has
// zero imports of its own ("Pure functions only. No I/O.", its header), so
// pulling in this one function does not pull in any theme-factory state
// (pilots, composed themes, etc.) -- md-preview stays outside that system.
import { mix } from "../docs/theme-surface/composers/_ui-derive.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cssPath = resolve(root, "md-preview.css");
const css = readFileSync(cssPath, "utf8");

const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); };

// ---- CSS custom-property extraction (the :root block only) ----------------

const rootMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/);
if (!rootMatch) throw new Error("md-preview.css: no :root { ... } block found");
const rootBody = rootMatch[1];

// name -> raw declaration value (unparsed), e.g. "light-dark(#0f172a, #CECDC3)".
// A plain `--x: value;` regex is sufficient here: nothing in this file's
// :root declares a value containing a literal ";" inside a string or url()
// (verified by inspection -- the font-stack tokens are comma lists of
// quoted names, not semicolon-bearing values).
const TOKENS = new Map();
{
  const re = /--([\w-]+):\s*([^;]+);/g;
  let m;
  while ((m = re.exec(rootBody))) TOKENS.set(m[1], m[2].trim());
}
check(TOKENS.size > 20, `md-preview.css :root parsed suspiciously few custom properties (${TOKENS.size}) -- extraction regex likely broken`);

// D3 / batch3 T1 step B deletes --active-bg/--active-fg once every consumer
// is migrated to the btn-hover+link pressed vocabulary. Asserted HERE (not
// just via grep at edit time) so a future edit can't silently reintroduce
// the near-black/near-white invert this task removed: this assertion is
// EXPECTED red before the CSS change in this same commit and green after --
// unlike the numeric pairs below, it is not protected by the stop line
// (it is a structural absence check, not a pre-existing contrast number).
check(!TOKENS.has("active-bg"), "md-preview.css :root still declares --active-bg -- batch3 T1 removed its last consumer and deleted this token; do not reintroduce the toggle-btn.active inverted-fill vocabulary");
check(!TOKENS.has("active-fg"), "md-preview.css :root still declares --active-fg -- batch3 T1 removed its last consumer and deleted this token; do not reintroduce the toggle-btn.active inverted-fill vocabulary");

// ---- value resolution: light-dark() / var() / color-mix() / hex / rgba() --

function splitTopLevel(s) {
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

function hexRgb(raw) {
  const s = raw.trim();
  if (!/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(s)) return null;
  let h = s.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbaColor(raw) {
  const m = raw.trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (!m) return null;
  const alpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
  return { rgb: [+m[1], +m[2], +m[3]], alpha };
}

// Resolves a raw CSS color expression to an opaque [r,g,b] for the given
// mode ("light" | "dark"). Handles the forms this file's :root actually
// uses (hex, light-dark(hex, hex)) plus var()-chains and color-mix() for
// robustness -- neither form currently appears inside :root (verified: no
// token declaration in this block contains "var(--" or "color-mix", grep
// checked at authoring time), so those two branches are exercised only by
// the self-checks below until/unless a future token uses them. Anything
// this cannot evaluate (gradients, non-srgb color-mix interpolation
// methods, alpha composited against an unstated backdrop) throws rather
// than silently guessing -- callers see that as a hard test failure with
// the unresolvable expression in the message, not a wrong ratio.
function resolveColor(raw, mode, seen = new Set()) {
  const s = raw.trim();

  const ld = s.match(/^light-dark\((.+)\)$/s);
  if (ld) {
    const [lightV, darkV] = splitTopLevel(ld[1]);
    return resolveColor(mode === "light" ? lightV : darkV, mode, seen);
  }

  const v = s.match(/^var\((.+)\)$/s);
  if (v) {
    const [nameRaw, ...fallbackParts] = splitTopLevel(v[1]);
    const name = nameRaw.trim().replace(/^--/, "");
    if (TOKENS.has(name)) {
      if (seen.has(name)) throw new Error(`circular var() reference through --${name}`);
      return resolveColor(TOKENS.get(name), mode, new Set(seen).add(name));
    }
    if (fallbackParts.length) return resolveColor(fallbackParts.join(","), mode, seen);
    throw new Error(`UNRESOLVABLE: var(--${name}) has no :root definition and no fallback`);
  }

  const cm = s.match(/^color-mix\(\s*in\s+srgb\s*,\s*(.+)\)$/is);
  if (cm) {
    const [aRaw, bRaw] = splitTopLevel(cm[1]);
    const pctOf = (part) => {
      const pm = part.match(/^(.*\S)\s+([\d.]+)%$/s);
      return pm ? { expr: pm[1].trim(), pct: parseFloat(pm[2]) } : { expr: part.trim(), pct: null };
    };
    const a = pctOf(aRaw), b = pctOf(bRaw);
    let pctA = a.pct;
    if (pctA === null && b.pct !== null) pctA = 100 - b.pct;
    if (pctA === null) pctA = 50;
    const colorA = resolveColor(a.expr, mode, seen);
    const colorB = resolveColor(b.expr, mode, seen);
    // mix(x, y, t) = x + (y - x) * t (gamma-space lerp, _ui-derive.mjs).
    // "pctA% of A" means t (the weight toward B) is (100 - pctA) / 100.
    return mix(colorA, colorB, (100 - pctA) / 100);
  }

  const hex = hexRgb(s);
  if (hex) return hex;

  const rgba = rgbaColor(s);
  if (rgba) {
    if (rgba.alpha >= 1) return rgba.rgb;
    // No stated backdrop for a translucent literal at this call site --
    // compositing over white is a documented, visible approximation, not a
    // silent guess pretending to be exact.
    return mix([255, 255, 255], rgba.rgb, rgba.alpha);
  }

  throw new Error(`UNRESOLVABLE color expression (cannot statically evaluate): "${s}"`);
}

function resolveToken(name, mode) {
  if (!TOKENS.has(name)) throw new Error(`no --${name} token in md-preview.css :root`);
  return resolveColor(TOKENS.get(name), mode);
}

// ---- WCAG 2.x relative luminance / contrast ratio --------------------------
// Same formula as docs/theme-surface/tools/contrast-audit.mjs's lum()/cr().

function lum(rgb) {
  const s = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * s(rgb[0] / 255) + 0.7152 * s(rgb[1] / 255) + 0.0722 * s(rgb[2] / 255);
}
function contrastRatio(rgbA, rgbB) {
  const L = [lum(rgbA), lum(rgbB)].sort((x, y) => x - y);
  return (L[1] + 0.05) / (L[0] + 0.05);
}

// ---- resolver self-checks (synthetic inputs, not md-preview data) ---------
// Exercises the var()-chain and color-mix() branches above, neither of
// which any current :root token hits (see resolveColor's comment).

{
  // var() chain: a synthetic --_self-b's dark branch points at --_self-a.
  // Registered into TOKENS (not a separate map) because resolveColor's
  // var() branch only ever looks names up in TOKENS -- then removed so the
  // real pair table below sees an unpolluted token set.
  TOKENS.set("_self-a", "#000000");
  TOKENS.set("_self-b", "light-dark(#ffffff, var(--_self-a))");
  let chainResult;
  try {
    chainResult = resolveColor("var(--_self-b)", "dark");
  } finally {
    TOKENS.delete("_self-a");
    TOKENS.delete("_self-b");
  }
  check(Array.isArray(chainResult) && chainResult.every((c, i) => c === [0, 0, 0][i]),
    `resolver self-check FAILED: var()-chain through light-dark() should resolve to [0,0,0], got ${JSON.stringify(chainResult)}`);

  // color-mix(): 50/50 of black and white must equal the factory's own
  // mix([0,0,0],[255,255,255],0.5) -- gamma-space lerp, so 127.5 not an
  // sRGB-perceptual midpoint.
  const mixResult = resolveColor("color-mix(in srgb, #000000 50%, #ffffff)", "light");
  const expected = mix([0, 0, 0], [255, 255, 255], 0.5);
  check(mixResult.every((c, i) => Math.abs(c - expected[i]) < 0.001),
    `resolver self-check FAILED: color-mix(in srgb, #000000 50%, #ffffff) should equal factory mix()'s ${JSON.stringify(expected)}, got ${JSON.stringify(mixResult)}`);

  // One-sided percentage: color-mix(in srgb, A 30%, B) must imply B gets 70%.
  const oneSided = resolveColor("color-mix(in srgb, #ffffff 30%, #000000)", "light");
  const expectedOneSided = mix([255, 255, 255], [0, 0, 0], 0.7);
  check(oneSided.every((c, i) => Math.abs(c - expectedOneSided[i]) < 0.001),
    `resolver self-check FAILED: one-sided color-mix() percentage math is wrong, got ${JSON.stringify(oneSided)} expected ${JSON.stringify(expectedOneSided)}`);
}

// ---- token-pair contract ----------------------------------------------------
// Each pair is a (text token, fill token) that some md-preview.css rule
// paints together. "min" is the WCAG AA normal-text floor (4.5:1) for
// every pair here -- none of the cited consumers are large text (>=18.66px
// bold / >=24px regular) by WCAG's definition, so no pair gets the 3:1
// large-text carve-out.

const PAIRS = [
  {
    id: "fg/bg",
    text: "fg", fill: "bg", min: 4.5,
    note: "body text on the page background -- body{color:var(--fg);background:var(--bg)} ~:203-206.",
  },
  {
    id: "fg-muted/bg",
    text: "fg-muted", fill: "bg", min: 4.5,
    note: "muted chrome text over the page background -- #rendered-view li::marker ~:851, .rail-ident a ~:1092.",
  },
  {
    id: "link/bg",
    text: "link", fill: "bg", min: 4.5,
    note: "prose links -- #rendered-view a { color: var(--link) } ~:683, inherits body's --bg backdrop.",
  },
  {
    id: "btn-fg/btn-bg",
    text: "btn-fg", fill: "btn-bg", min: 4.5,
    note: "REST state of every action/toggle button -- .action-btn,.toggle-btn ~:227, .xp-act ~:1912-1923, .srch-regex ~:3464-3477, .typo-seg-btn ~:3625-3636, .exp-img-row select ~:1237.",
  },
  {
    id: "btn-fg/btn-hover",
    text: "btn-fg", fill: "btn-hover", min: 4.5,
    note: "HOVER state of the same buttons (background swaps to --btn-hover, text stays --btn-fg from the rest rule) -- .action-btn:hover,.toggle-btn:hover ~:247, .srch-nav:hover ~:3459, .xp-act:hover ~:1928.",
  },
  {
    id: "fg/btn-hover",
    text: "fg", fill: "btn-hover", min: 4.5,
    note: "a second, pre-existing hover family that swaps text to --fg over --btn-hover -- .rail-sec-open:hover/:focus-visible ~:1454/1460, .pb-hl-note-btn:hover/:focus-visible ~:2589/2596, .ask-ic:hover ~:2914.",
  },
  {
    id: "link/btn-hover",
    text: "link", fill: "btn-hover", min: 4.5,
    // See the STOP-LINE note below this table: this pair is EXPECTED to
    // fail in dark mode, pre-existing this task.
    note: "the pressed-state vocabulary this task (D3) converges six more controls onto -- ALREADY used before this task by .srch-regex[aria-pressed] ~:3481, .typo-seg-btn[aria-pressed] ~:3638, .pbv-*[aria-pressed] ~:3851, #ask-scope-near[aria-pressed] ~:2217. After this task also: .toggle-btn.active ~:279, .src-seg.active/[aria-pressed] ~:314/317, .exp-tgl[aria-pressed] ~:1217, .xp-pin[aria-pressed] ~:1910, option:checked ~:1303, .xp-act[aria-pressed] ~:1934.",
  },
  {
    id: "on-danger/danger",
    text: "on-danger", fill: "danger", min: 4.5,
    note: "the confirm popover's solid destructive button -- .confirm-popover .confirm-yes ~:2457.",
  },
  {
    id: "fg-secondary/surface",
    text: "fg-secondary", fill: "surface", min: 4.5,
    note: "REST state of .src-seg (transparent, .source-badge parent bg=--surface ~:286) and .xp-pin (transparent, #explain-pop bg=--surface ~:1800) -- the same two five-family controls this task unifies the PRESSED state of.",
  },
  {
    id: "badge-fg/badge-bg",
    text: "badge-fg", fill: "badge-bg", min: 4.5,
    note: ".token-badge ~:355.",
  },
  {
    id: "code-fg/code-bg",
    text: "code-fg", fill: "code-bg", min: 4.5,
    note: "inline code -- #rendered-view code ~:711.",
  },
  {
    id: "bq-fg/bq-bg",
    text: "bq-fg", fill: "bq-bg", min: 4.5,
    note: "blockquotes -- #rendered-view blockquote ~:744.",
  },
];

// STOP LINE (task spec): "link vs btn-hover" is the ONE pair this task's
// own D3 change designates as the active/pressed-state contract -- it is
// simultaneously already relied on by four pre-existing selectors (listed
// above) and, per the M3-c comment at md-preview.css ~:2179-2186, ALREADY
// KNOWN to fail in dark mode (3.97:1, that comment's own measured number)
// for exactly this token pair -- M3-c fixed ONE consumer (.ask-chip:hover)
// by swapping to light-dark(var(--link), var(--link-hover)) in dark, but
// the other four pre-existing consumers this task's new six converge
// alongside (.srch-regex/.typo-seg-btn/.pbv-*/#ask-scope-near[aria-pressed])
// were never migrated to that swap and still fail. This task's brief is
// explicit that "link vs btn-hover" is exempted from the stop line ("an
// EXISTING pair, NOT the new active pair") -- unlike every other pair in
// this file, a dark-mode failure here does not mean tokens were touched
// silently or that the CSS change should have been withheld; it means the
// pre-existing defect is now VISIBLE through a real gate instead of
// undetected. See this test run's own report for the current numbers.
const STOP_LINE_EXEMPT = new Set(["link/btn-hover"]);

const MODES = ["light", "dark"];
console.log("md-preview.css :root contrast pairs (WCAG AA text floor 4.5:1)\n");
for (const pair of PAIRS) {
  for (const mode of MODES) {
    const textRgb = resolveToken(pair.text, mode);
    const fillRgb = resolveToken(pair.fill, mode);
    const ratio = contrastRatio(textRgb, fillRgb);
    const ok = ratio >= pair.min;
    const tag = ok ? "OK  " : (STOP_LINE_EXEMPT.has(pair.id) ? "RED*" : "FAIL");
    console.log(`${tag} ${pair.id.padEnd(20)} ${mode.padEnd(5)} ${ratio.toFixed(2)}:1  (>= ${pair.min}:1)`);
    if (!ok && !STOP_LINE_EXEMPT.has(pair.id)) {
      check(false, `${pair.id} (--${pair.text} vs --${pair.fill}) fails in ${mode} mode: ${ratio.toFixed(2)}:1 < ${pair.min}:1 -- ${pair.note}`);
    }
  }
}
console.log("\n(RED* rows are stop-line-exempt per this task's spec -- see the comment above; still printed, not silently hidden.)\n");
for (const pair of PAIRS) console.log(`  ${pair.id.padEnd(20)} -- ${pair.note}`);

if (fail.length) {
  console.error("\n" + fail.join("\n"));
  process.exit(1);
}
console.log("\nmd-preview contrast gate ok (link/btn-hover dark-mode gap is stop-line-exempt and pre-existing -- see report)");
