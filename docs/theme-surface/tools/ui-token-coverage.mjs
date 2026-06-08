#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(__dirname, "..", "..", "..", "popup.css"), "utf8");
const START = "/* @generated:ui-themes start", END = "@generated:ui-themes end */";
const s = css.indexOf(START), e = css.indexOf(END);
const region = css.slice(s, e + END.length);
const outside = css.slice(0, s) + css.slice(e + END.length);
const used = new Set();
for (const m of outside.matchAll(/var\(\s*(--pp-[a-z0-9-]+)\s*(\)|,)/g)) { if (m[2] === ")") used.add(m[1]); }
const baseDefs = new Set([...outside.matchAll(/(--pp-[a-z0-9-]+)\s*:/g)].map(m => m[1]));
const blocks = region.split(/html\[data-theme="[^"]+"\]\s*\{/).slice(1);
let fails = 0;
for (const v of used) {
  if (baseDefs.has(v)) continue;
  const missing = blocks.filter(b => !new RegExp(v.replace(/-/g, "\\-") + "\\s*:").test(b)).length;
  if (missing > 0) { console.log(`  x ${v} undefined in ${missing} theme block(s) and not in base`); fails++; }
}
console.log(fails ? `FAIL ${fails}` : "PASS ui-token-coverage");
process.exit(fails ? 1 : 0);
