#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { renderPopupCss, spliceRegion } from "./apply-ui-themes.mjs";
const __dirname = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(__dirname, "..", "..", "..", "popup.css");
const css = readFileSync(cssPath, "utf8");
const expected = spliceRegion(css, renderPopupCss());
if (expected === css) { console.log("css-region-audit: PASS (popup @generated region matches composer)"); process.exit(0); }
console.log("css-region-audit: FAIL — popup.css @generated region drifted or was hand-edited. Run: node docs/theme-surface/tools/apply-ui-themes.mjs --write");
process.exit(1);
