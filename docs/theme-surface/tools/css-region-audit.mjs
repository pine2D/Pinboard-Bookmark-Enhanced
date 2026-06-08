#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { SURFACES, expectedCss } from "./apply-ui-themes.mjs";
let fails = 0;
for (const s of SURFACES) {
  const css = readFileSync(s.cssPath, "utf8");
  if (expectedCss(s) === css) console.log(`css-region-audit: ${s.name} PASS`);
  else { console.log(`css-region-audit: ${s.name} FAIL — region drifted/hand-edited. Run: node docs/theme-surface/tools/apply-ui-themes.mjs --write`); fails++; }
}
process.exit(fails ? 1 : 0);
