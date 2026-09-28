#!/usr/bin/env node
// Pixel gate for stage 3c (spec 2026-09-27-ui-system-stage3c-design §5).
// Compares two scripts/options-panel-shots.mjs output directories file by
// file, exact per-pixel (pixelmatch threshold 0, anti-aliasing counted).
// Exit 0: every PNG pair identical outside the --allow boxes.
// Exit 1: any differing pixel outside them, a missing/extra PNG, or a size change.
// Exit 2: usage/tooling error (including an --allow selector the shots never
//         recorded), or the two directories were not shot the same way:
//         scripts/options-panel-shots.mjs writes shots-meta.json (raster flags
//         incl. the MSAA pin, device scale factor, viewport/locale, the shot
//         script's git blob sha) and its `compare` block must be identical on
//         both sides. A directory without shots-meta.json was shot before
//         the meta existed, so its raster mode is unknown (every set before
//         07e97334 used the default GPU raster): re-shoot it, never mix it
//         with a newer one -- a mixed pair is what produced fields-bplus
//         Task 3's 8 panels of false "outside" pixels.
// .styles.json differences (computed styles, rest/hover/focus probes) are
// ADVISORY: printed, counted, never change the exit code -- the implementer
// explains each one in the task report.
//
// Usage:
//   node scripts/panel-pixel-diff.mjs <beforeDir> <afterDir> [--allow "<panel|*>:<selector>[@self|@label|@row]"]... [--diff-dir <dir>]
// An allow box is the union of the selector's recorded boxes in BOTH shots
// (before and after), at the requested granularity (@self default; @label =
// closest <label>; @row = closest .fg-actions/.pref-row/help host).
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let PNG, pixelmatch;
try {
  const req = createRequire(resolve(ROOT, ".qa-scan", "package.json"));
  ({ PNG } = req("pngjs"));
  pixelmatch = req("pixelmatch");
} catch (e) {
  console.error("[panel-diff] pngjs/pixelmatch not found under .qa-scan:", e.message);
  process.exit(2);
}

function parseArgs(argv) {
  const pos = [];
  const allow = [];
  let diffDir = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allow") allow.push(argv[++i]);
    else if (a.startsWith("--allow=")) allow.push(a.slice("--allow=".length));
    else if (a === "--diff-dir") diffDir = argv[++i];
    else if (a.startsWith("--")) { console.error(`[panel-diff] unknown flag ${a}`); process.exit(2); }
    else pos.push(a);
  }
  if (pos.length !== 2) {
    console.error('usage: node scripts/panel-pixel-diff.mjs <beforeDir> <afterDir> [--allow "<panel|*>:<selector>[@self|@label|@row]"]... [--diff-dir <dir>]');
    process.exit(2);
  }
  const rules = allow.map((spec) => {
    const m = /^([a-z-]+|\*):(.+?)(?:@(self|label|row))?$/.exec(spec || "");
    if (!m) { console.error(`[panel-diff] bad --allow ${JSON.stringify(spec)}`); process.exit(2); }
    return { panel: m[1], selector: m[2], scope: m[3] || "self" };
  });
  const after = resolve(pos[1]);
  return { before: resolve(pos[0]), after, rules, diffDir: diffDir ? resolve(diffDir) : join(after, "diff") };
}

const { before, after, rules, diffDir } = parseArgs(process.argv.slice(2));

// Same-raster guard (final review C-2): compare the two shots-meta.json
// `compare` blocks before looking at a single pixel.
function metaOf(dir, label) {
  const p = join(dir, "shots-meta.json");
  if (!existsSync(p)) {
    console.error(`[panel-diff] ${label} directory ${dir} has no shots-meta.json -- it was shot before the raster settings were recorded, so how its pixels were rasterized is unknown (every set before 07e97334 used the default GPU raster). Re-shoot it with the current scripts/options-panel-shots.mjs; never diff it against a set that carries meta.`);
    process.exit(2);
  }
  try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) {
    console.error(`[panel-diff] ${label} shots-meta.json is unreadable (${e.message}) -- re-shoot ${dir}.`);
    process.exit(2);
  }
}
{
  const mb = metaOf(before, "before"), ma = metaOf(after, "after");
  const keys = [...new Set([...Object.keys(mb.compare || {}), ...Object.keys(ma.compare || {})])].sort();
  const differ = keys.filter((k) => JSON.stringify(mb.compare?.[k]) !== JSON.stringify(ma.compare?.[k]));
  if (mb.schema !== ma.schema || !mb.compare || !ma.compare || differ.length) {
    console.error(`[panel-diff] before and after were not shot the same way -- re-shoot both with the same scripts/options-panel-shots.mjs. Differs: ${mb.schema !== ma.schema ? "schema " : ""}${differ.map((k) => `${k} (${JSON.stringify(mb.compare?.[k])} vs ${JSON.stringify(ma.compare?.[k])})`).join("; ") || "compare block missing"}`);
    process.exit(2);
  }
  console.log(`[panel-diff] shots-meta match: ${keys.map((k) => `${k}=${JSON.stringify(mb.compare[k])}`).join(" ")} (before head ${mb.info?.head?.slice(0, 8) ?? "?"}, after head ${ma.info?.head?.slice(0, 8) ?? "?"})`);
}
function pngsIn(dir, label) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    console.error(`[panel-diff] cannot read ${label} directory ${dir}: ${e.message}`);
    process.exit(2);
  }
  return new Set(entries.filter((f) => /^p-.+-dpr1-zh\.png$/.test(f)));
}
const panelOf = (f) => /^p-(.+)-(default|terminal)-dpr1-zh\.png$/.exec(f)?.[1] || null;
const sidecar = (dir, f, ext) => {
  const p = join(dir, f.replace(/\.png$/, ext));
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

// Colour serialization is not canonical across the two sides: the same
// computed colour of a color-mix()-derived border can read back as `rgb(...)`
// in one run and `oklab(...)` / `color(srgb ...)` in the other (a transition
// that interpolated in oklab and landed on its end value, or a mix that was
// resolved at a different point), which used to surface as advisory lines
// whose two sides are the same paint. Every colour function in a value is
// rewritten to one canonical `rgba(r,g,b,a)` with 8-bit channels AND 8-bit
// alpha before comparing -- in place, so compound values (box-shadow, the
// `|`-joined ::before/::after signature) normalize their colour tokens and
// keep everything else verbatim. Unrecognized colour syntaxes (lab(), lch(),
// named colours, ...) are left as-is and still compare textually. The
// ORIGINAL strings are what the advisory prints; only the comparison uses
// the canonical form.
const COLOR_FN_RE = /\b(rgba?|color|oklab|oklch)\(([^()]*)\)/gi;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const to8 = (v) => Math.round(clamp01(v) * 255);
const srgbEncode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
function parseNum(tok, pctScale) {
  if (tok === "none") return 0;
  if (tok.endsWith("%")) return (parseFloat(tok) / 100) * pctScale;
  const n = parseFloat(tok);
  return Number.isFinite(n) ? n : NaN;
}
function oklabToSrgb(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map(srgbEncode);
}
// Returns [r,g,b,a] in 0..255 or null when the function/arguments are not
// one of the handled forms.
function colorFnToRgba8(fn, args) {
  const f = fn.toLowerCase();
  const [chan, alphaPart] = args.split("/").map((x) => x && x.trim());
  const parts = chan.split(/[\s,]+/).filter(Boolean);
  let alpha = 1;
  if (alphaPart !== undefined) alpha = parseNum(alphaPart, 1);
  let rgb01;
  if (f === "rgb" || f === "rgba") {
    if (parts.length === 4 && alphaPart === undefined) alpha = parseNum(parts.pop(), 1);
    if (parts.length !== 3) return null;
    rgb01 = parts.map((t) => parseNum(t, 255) / 255);
  } else if (f === "color") {
    if (parts[0]?.toLowerCase() !== "srgb" || parts.length !== 4) return null;
    rgb01 = parts.slice(1).map((t) => parseNum(t, 1));
  } else if (f === "oklab") {
    if (parts.length !== 3) return null;
    rgb01 = oklabToSrgb(parseNum(parts[0], 1), parseNum(parts[1], 0.4), parseNum(parts[2], 0.4));
  } else if (f === "oklch") {
    if (parts.length !== 3) return null;
    const L = parseNum(parts[0], 1), C = parseNum(parts[1], 0.4), H = (parseFloat(parts[2]) * Math.PI) / 180;
    rgb01 = oklabToSrgb(L, C * Math.cos(H || 0), C * Math.sin(H || 0));
  } else return null;
  if ([...rgb01, alpha].some((v) => !Number.isFinite(v))) return null;
  return [...rgb01.map(to8), to8(alpha)];
}
function canonColors(v) {
  if (typeof v !== "string") return v;
  return v.replace(COLOR_FN_RE, (whole, fn, args) => {
    const t = colorFnToRgba8(fn, args);
    return t ? `rgba(${t.join(",")})` : whole;
  });
}
const sameValue = (x, y) => JSON.stringify(canonColors(x)) === JSON.stringify(canonColors(y));

function compareStyles(f, a, b) {
  const lines = [];
  // A missing sidecar is itself advisory-worthy: it means this shot has no
  // state/style evidence at all, which must be visible, not silently 0.
  if (!a || !b) {
    lines.push(`NO STYLES SIDECAR: ${!a ? "before" : "after"} side missing ${f.replace(/\.png$/, ".styles.json")}`);
    lines.forEach((l) => console.log(`  [advisory] ${f}: ${l}`));
    return lines.length;
  }
  for (const k of new Set([...Object.keys(a.elements), ...Object.keys(b.elements)])) {
    const x = a.elements[k];
    const y = b.elements[k];
    if (!x || !y) { lines.push(`STYLE ${x ? "-" : "+"} ${k}`); continue; }
    for (const p of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (!sameValue(x[p], y[p])) lines.push(`STYLE ${k} ${p}: ${JSON.stringify(x[p])} -> ${JSON.stringify(y[p])}`);
    }
  }
  // Iterate the UNION of both sides' probed selectors, and treat an absent
  // key the same as an explicit {missing:true} -- otherwise a probe that
  // exists only on one side (e.g. it went from missing to present, or vice
  // versa) compares against `undefined` sub-objects and silently yields 0.
  for (const sel of new Set([...Object.keys(a.states || {}), ...Object.keys(b.states || {})])) {
    const stA = a.states?.[sel];
    const stB = b.states?.[sel];
    const missingA = !stA || stA.missing === true;
    const missingB = !stB || stB.missing === true;
    if (missingA !== missingB) { lines.push(`STATE ${sel} missing: ${missingA} -> ${missingB}`); continue; }
    if (missingA && missingB) continue;
    for (const phase of ["rest", "hover", "focus"]) {
      for (const p of new Set([...Object.keys(stA[phase] || {}), ...Object.keys(stB[phase] || {})])) {
        const v1 = stA[phase]?.[p];
        const v2 = stB[phase]?.[p];
        if (!sameValue(v1, v2)) lines.push(`STATE ${sel} ${phase} ${p}: ${v1} -> ${v2}`);
      }
    }
  }
  lines.slice(0, 40).forEach((l) => console.log(`  [advisory] ${f}: ${l}`));
  if (lines.length > 40) console.log(`  [advisory] ${f}: ... ${lines.length - 40} more`);
  return lines.length;
}

const A = pngsIn(before, "before");
const B = pngsIn(after, "after");
if (A.size === 0) {
  console.error(`[panel-diff] no p-*-dpr1-zh.png in beforeDir ${before} -- nothing to compare`);
  process.exit(2);
}
let failing = 0;
let advisories = 0;
for (const f of [...A].filter((x) => !B.has(x))) { console.log(`[panel-diff] FAIL missing in after: ${f}`); failing++; }
for (const f of [...B].filter((x) => !A.has(x))) { console.log(`[panel-diff] FAIL extra in after: ${f}`); failing++; }
for (const f of [...A].filter((x) => B.has(x)).sort()) {
  const a = PNG.sync.read(readFileSync(join(before, f)));
  const b = PNG.sync.read(readFileSync(join(after, f)));
  if (a.width !== b.width || a.height !== b.height) {
    console.log(`[panel-diff] FAIL ${f}  size ${a.width}x${a.height} -> ${b.width}x${b.height}`);
    failing++;
    continue;
  }
  const panel = panelOf(f);
  const boxes = [];
  for (const rule of rules.filter((r) => r.panel === "*" || r.panel === panel)) {
    for (const src of [sidecar(before, f, ".rects.json"), sidecar(after, f, ".rects.json")]) {
      const recs = src?.rects?.[rule.selector];
      if (!recs) { console.error(`[panel-diff] ${f}: no rects recorded for "${rule.selector}" -- re-shoot with --rects "${rule.selector}"`); process.exit(2); }
      for (const r of recs) if (r[rule.scope]) boxes.push(r[rule.scope]);
    }
  }
  const mask = new PNG({ width: a.width, height: a.height });
  const total = pixelmatch(a.data, b.data, mask.data, a.width, a.height, { threshold: 0, includeAA: true, diffMask: true });
  let outside = 0;
  if (total) {
    for (let y = 0; y < a.height; y++) {
      for (let x = 0; x < a.width; x++) {
        if (mask.data[(y * a.width + x) * 4 + 3] === 0) continue;
        const inBox = boxes.some((bx) => x >= Math.floor(bx.x) && x < Math.ceil(bx.x + bx.w) && y >= Math.floor(bx.y) && y < Math.ceil(bx.y + bx.h));
        if (!inBox) outside++;
      }
    }
    mkdirSync(diffDir, { recursive: true });
    const vis = new PNG({ width: a.width, height: a.height });
    pixelmatch(a.data, b.data, vis.data, a.width, a.height, { threshold: 0, includeAA: true });
    writeFileSync(join(diffDir, f), PNG.sync.write(vis));
  }
  if (outside) failing++;
  console.log(`[panel-diff] ${outside ? "FAIL" : "OK  "} ${f}  diff=${total} allowed=${total - outside} outside=${outside}`);
  advisories += compareStyles(f, sidecar(before, f, ".styles.json"), sidecar(after, f, ".styles.json"));
}
console.log(`[panel-diff] ${A.size} pair(s), ${failing} failing, ${advisories} advisory style/state difference(s)`);
process.exit(failing ? 1 : 0);
