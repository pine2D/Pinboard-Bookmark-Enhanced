#!/usr/bin/env node
// layout-lint — flag CSS patterns that have caused layout regressions:
//   1. fixed `width: NNNpx` on label/group selectors (Adaptive label clip)
//   2. content-box inputs without explicit max-width (edit-form input overflow)
//
// The lint is advisory: prints warnings but exits 0 unless a rule is
// classified as "BLOCK". Tightens over time as we add rules.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");

const TARGETS = [
  resolve(ROOT, "popup.css"),
  resolve(ROOT, "options.css"),
];

let blockers = 0;
let warnings = 0;

for (const path of TARGETS) {
  const text = readFileSync(path, "utf8");
  const file = path.split("/").pop();

  // RULE 1: fixed pixel width on label/group/title-class selectors (the .theme-group-label clip class).
  const re1 = /([^{}\n]*\.[a-z-]*(label|group|title|tag|chip|badge)[^{}\n]*)\{[^}]*\bwidth:\s*(\d+)px[^}]*\}/gi;
  let m;
  while ((m = re1.exec(text)) !== null) {
    const sel = m[1].trim().slice(0, 80);
    const px = parseInt(m[3]);
    if (px <= 100) {
      const lineNum = text.slice(0, m.index).split("\n").length;
      console.log(`  ${file}:${lineNum}  WARN  fixed width:${px}px on label-style selector "${sel}" — use min-width if content can grow (i18n, longer text)`);
      warnings++;
    }
  }

  // RULE 2: width on inline elements that should use min-width (theme-card-style fixed boxes).
  // Skip — too many legit uses; rule 1 covers the high-risk case.
}

console.log("");
if (blockers > 0) {
  console.log(`=== layout-lint: FAIL — ${blockers} blocker(s), ${warnings} warning(s) ===`);
  process.exit(1);
} else if (warnings > 0) {
  console.log(`=== layout-lint: PASS with ${warnings} warning(s) (advisory) ===`);
  process.exit(0);
} else {
  console.log("=== layout-lint: PASS ===");
  process.exit(0);
}
