#!/usr/bin/env node
// Pixel gate for stage 3c (spec 2026-09-27-ui-system-stage3c-design §5).
// Compares two scripts/options-panel-shots.mjs output directories file by
// file, exact per-pixel (pixelmatch threshold 0, anti-aliasing counted).
// Exit 0: every PNG pair identical outside the --allow boxes.
// Exit 1: any differing pixel outside them, a missing/extra PNG, or a size change.
// Exit 2: usage/tooling error (including an --allow selector the shots never recorded).
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
      if (JSON.stringify(x[p]) !== JSON.stringify(y[p])) lines.push(`STYLE ${k} ${p}: ${JSON.stringify(x[p])} -> ${JSON.stringify(y[p])}`);
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
        if (v1 !== v2) lines.push(`STATE ${sel} ${phase} ${p}: ${v1} -> ${v2}`);
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
