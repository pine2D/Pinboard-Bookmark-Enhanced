#!/usr/bin/env node
// Splice composer-generated --pp-* theme blocks into popup.css's @generated region.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { composePopupThemes } from "../composers/popup-chrome.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");
const PILOTS = resolve(__dirname, "..", "pilots");
const START = "/* @generated:ui-themes start — do not edit; produced by composers/popup-chrome.mjs */";
const END = "/* @generated:ui-themes end */";

export function renderPopupCss() {
  const byPilot = {};
  for (const f of readdirSync(PILOTS).filter(f => f.endsWith(".tokens.json")))
    byPilot[f.replace(/\.tokens\.json$/, "")] = JSON.parse(readFileSync(resolve(PILOTS, f), "utf8"));
  return composePopupThemes(byPilot);
}

export function spliceRegion(css, body) {
  const s = css.indexOf(START), e = css.indexOf(END);
  if (s === -1 || e === -1 || e < s) throw new Error("popup.css: @generated:ui-themes markers not found");
  return css.slice(0, s) + START + "\n" + body + "\n" + END + css.slice(e + END.length);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes("--write");
  const cssPath = resolve(ROOT, "popup.css");
  const css = readFileSync(cssPath, "utf8");
  const next = spliceRegion(css, renderPopupCss());
  if (write) { writeFileSync(cssPath, next); console.log("apply-ui-themes: wrote popup.css"); }
  else console.log(next === css ? "apply-ui-themes: in sync" : "apply-ui-themes: DRIFT (run with --write)");
}
