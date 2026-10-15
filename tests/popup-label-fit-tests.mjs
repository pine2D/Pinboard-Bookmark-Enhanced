// popup-label-fit-tests — every popup form label fits its column in every
// UI locale.
//
// The popup's .label column is --pp-label-w wide (52px), widened per UI
// language by the html:lang(...) rules in popup.css. A label longer than
// the column does not wrap (one word) or wraps into a second line, and in
// both cases runs into the field beside it: ru "Рекомендации" sat on top
// of "популярные:" at 420px (impeccable critique 2026-10-15).
//
// What is measured comes from what the product consumes, not from a list
// kept here:
//   - the labels are popup.html's `.label` elements (data-i18n key, or the
//     literal text when there is none);
//   - the locales are the _locales/ directories, and each one's html lang
//     comes from i18n.js's own uiLangToBCP47();
//   - the column width is popup.css's computed --pp-label-w under that
//     lang, read through the real cascade in a browser.
//
// Text is set at 11px in the wider of Verdana (the widest face in the
// popup's stack; local Windows fonts) and DejaVu Sans (present on the CI
// runner, slightly wider than Verdana), so a pass here holds for the
// faces users actually get. CJK falls through to the fast CJK stack.

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let chromium;
try {
  const req = createRequire(resolve(ROOT, ".qa-scan", "package.json"));
  ({ chromium } = req("playwright"));
} catch {
  console.error("[popup-label-fit] playwright not found.");
  console.error("  Install:  cd .qa-scan && npm install && npx playwright install chromium");
  process.exit(2);
}

// ---- labels, from popup.html ------------------------------------------------
const html = readFileSync(resolve(ROOT, "popup.html"), "utf8");
const labels = [];
for (const m of html.matchAll(/<(label|span)\b([^>]*\bclass="label"[^>]*)>([^<]*)</g)) {
  const key = m[2].match(/\bdata-i18n="([^"]+)"/)?.[1] || null;
  labels.push({ key, literal: m[3].trim() });
}
if (labels.length < 6) throw new Error(`popup.html: expected the form .label set, found ${labels.length}`);

// ---- locale -> html lang, through i18n.js's own mapping ----------------------
function bcp47For(locale) {
  const ctx = {
    localStorage: { getItem: () => locale },
    chrome: { i18n: { getUILanguage: () => locale } },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "i18n.js"), "utf8"), ctx);
  return vm.runInContext("uiLangToBCP47()", ctx);
}

const locales = readdirSync(resolve(ROOT, "_locales"), { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();

const css = readFileSync(resolve(ROOT, "popup.css"), "utf8");
const GAUGES = ["Verdana", "DejaVu Sans"];
const CJK = `"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "WenQuanYi Micro Hei"`;

const fail = [];
let checked = 0;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const locale of locales) {
    const messages = JSON.parse(readFileSync(resolve(ROOT, "_locales", locale, "messages.json"), "utf8"));
    const lang = bcp47For(locale);
    const texts = labels.map(({ key, literal }) => {
      if (!key) return literal;
      const text = messages[key]?.message;
      if (!text) fail.push(`${locale}: popup.html .label key "${key}" has no message`);
      return text || literal;
    });
    const rows = texts.map((text) =>
      `<div class="row"><span class="label"><span class="probe"></span></span></div>`).join("");
    await page.setContent(
      `<!doctype html><html lang="${lang}"><head></head><body>${rows}</body></html>`,
    );
    await page.addStyleTag({ content: css });
    const result = await page.evaluate(({ texts, gauges, cjk }) => {
      const out = [];
      const labelsEls = [...document.querySelectorAll(".label")];
      labelsEls.forEach((label, i) => {
        const probe = label.querySelector(".probe");
        probe.textContent = texts[i];
        probe.style.whiteSpace = "nowrap";
        let widest = 0;
        for (const g of gauges) {
          probe.style.fontFamily = `"${g}", ${cjk}, sans-serif`;
          probe.style.fontSize = "11px";
          widest = Math.max(widest, probe.getBoundingClientRect().width);
        }
        out.push({ text: texts[i], need: widest, have: label.getBoundingClientRect().width,
          fontSize: getComputedStyle(label).fontSize });
      });
      return out;
    }, { texts, gauges: GAUGES, cjk: CJK });
    for (const r of result) {
      checked++;
      if (r.fontSize !== "11px") fail.push(`${locale}: .label font-size is ${r.fontSize}, this gauge assumes 11px`);
      if (r.need > r.have) {
        fail.push(`${locale} (lang=${lang}): "${r.text}" needs ${r.need.toFixed(1)}px, column is ${r.have}px`);
      }
    }
  }
} finally {
  await browser.close();
}

if (fail.length) {
  console.error(`[popup-label-fit] FAIL (${fail.length})`);
  for (const f of fail) console.error(`  - ${f}`);
  console.error("  Fix: widen that locale's html:lang(...) --pp-label-w in popup.css (or reword the label in every locale that shares it).");
  process.exit(1);
}
console.log(`[popup-label-fit] OK — ${checked} labels across ${locales.length} locales fit their column`);
