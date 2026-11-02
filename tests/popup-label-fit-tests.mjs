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
//     literal text when there is none); a label inside
//     #linkding-description-row is shown only for linkding (popup.js hides
//     that row for every other service), so it is measured only there;
//   - the locales are the _locales/ directories, and each one's html lang
//     comes from i18n.js's own uiLangToBCP47();
//   - the column width is popup.css's computed --pp-label-w under that
//     lang and bookmark service (html[data-bookmark-service], set before
//     first paint by popup-theme-early.js), read through the real cascade in
//     a browser.
//
// A column is also never wider than the labels that service shows need
// (rounded up to an even px, never below the base 52px): a width added for
// linkding's Description row must not narrow every field for Pinboard and
// Karakeep. Pinboard, Karakeep and a popup with no service mirror yet share
// one geometry.
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

const html = readFileSync(resolve(ROOT, "popup.html"), "utf8");

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

// The service axis: "" is a popup with no mirror yet (first run).
const SERVICES = ["", "pinboard", "karakeep", "linkding"];
const LINKDING_ROW = "linkding-description-row";

const fail = [];
let checked = 0;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();

  // ---- labels, from popup.html, parsed by the browser (no script runs) -----
  const labels = await page.evaluate(({ html, row }) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (!doc.getElementById(row)) return null;
    return [...doc.querySelectorAll(".label")].map((el) => ({
      key: el.getAttribute("data-i18n"),
      literal: el.textContent.trim(),
      linkdingOnly: !!el.closest(`#${row}`),
    }));
  }, { html, row: LINKDING_ROW });
  if (!labels) throw new Error(`popup.html: #${LINKDING_ROW} not found`);
  if (labels.length < 6) throw new Error(`popup.html: expected the form .label set, found ${labels.length}`);
  if (!labels.some((l) => l.linkdingOnly)) throw new Error(`popup.html: no .label inside #${LINKDING_ROW}`);

  // The base column, through the cascade: --pp-label-w on an <html> no
  // per-language or per-service rule matches. Every narrower set keeps it.
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addStyleTag({ content: css });
  const BASE_LABEL_W = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pp-label-w")));
  if (!(BASE_LABEL_W > 0)) throw new Error("popup.css: no base --pp-label-w");

  for (const locale of locales) {
    const messages = JSON.parse(readFileSync(resolve(ROOT, "_locales", locale, "messages.json"), "utf8"));
    const lang = bcp47For(locale);
    const texts = labels.map(({ key, literal }) => {
      if (!key) return literal;
      const text = messages[key]?.message;
      if (!text) fail.push(`${locale}: popup.html .label key "${key}" has no message`);
      return text || literal;
    });
    const columns = {};
    for (const service of SERVICES) {
      const shown = labels.map((l, i) => ({ ...l, text: texts[i] }))
        .filter((l) => !l.linkdingOnly || service === "linkding");
      const rows = shown.map(() =>
        `<div class="row"><span class="label"><span class="probe"></span></span></div>`).join("");
      const attr = service ? ` data-bookmark-service="${service}"` : "";
      await page.setContent(
        `<!doctype html><html lang="${lang}"${attr}><head></head><body>${rows}</body></html>`,
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
        return { out };
      }, { texts: shown.map((l) => l.text), gauges: GAUGES, cjk: CJK });
      const tag = `${locale} (lang=${lang}, service=${service || "none"})`;
      let widest = 0;
      for (const r of result.out) {
        checked++;
        widest = Math.max(widest, r.need);
        if (r.fontSize !== "11px") fail.push(`${tag}: .label font-size is ${r.fontSize}, this gauge assumes 11px`);
        if (r.need > r.have) {
          fail.push(`${tag}: "${r.text}" needs ${r.need.toFixed(1)}px, column is ${r.have}px`);
        }
      }
      const have = result.out[0].have;
      const enough = Math.max(BASE_LABEL_W, Math.ceil(widest / 2) * 2);
      if (have > enough) {
        fail.push(`${tag}: column is ${have}px but its widest shown label needs only ${widest.toFixed(1)}px (${enough}px column)`);
      }
      columns[service || "none"] = have;
    }
    for (const service of ["pinboard", "karakeep"]) {
      if (columns[service] !== columns.none) {
        fail.push(`${locale} (lang=${lang}): ${service} column is ${columns[service]}px, a popup with no service is ${columns.none}px`);
      }
    }
  }

  // ---- the service attribute is on <html> before first paint ---------------
  // popup-theme-early.js is a parser-blocking <head> script: what it sets
  // synchronously is in place for the first frame. The page below loads it
  // the same way popup.html does and records the attribute in the very next
  // script, before <body> exists. chrome.storage never answers there, so the
  // value can only have come from the localStorage mirror.
  const early = readFileSync(resolve(ROOT, "popup-theme-early.js"), "utf8");
  const ORIGIN = "https://popup-label-fit.test";
  const pendingStorage = `window.chrome = { storage: {
    local: { get: () => new Promise(() => {}) },
    sync: { get: () => new Promise(() => {}) } } };`;
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/popup-theme-early.js") {
      return route.fulfill({ contentType: "text/javascript", body: early });
    }
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><head>
      <script>${pendingStorage}</script>
      <script src="/popup-theme-early.js"></script>
      <script>window.__firstFrame = document.documentElement.getAttribute("data-bookmark-service");
        window.__bodyAtFirstFrame = !!document.body;</script>
      </head><body></body></html>` });
  });
  await page.goto(`${ORIGIN}/blank`);
  for (const service of ["pinboard", "karakeep", "linkding", null]) {
    await page.evaluate((v) => {
      localStorage.clear();
      if (v !== null) localStorage.setItem("pp-bookmark-service", v);
    }, service);
    await page.goto(`${ORIGIN}/popup?${service}`);
    const got = await page.evaluate(() => ({ attr: window.__firstFrame, body: window.__bodyAtFirstFrame }));
    checked++;
    if (got.body) fail.push("first-frame probe ran after <body> was parsed; it no longer measures first paint");
    const want = service; // no mirror yet: no attribute, the base geometry
    if (got.attr !== want) {
      fail.push(`first frame with mirror ${JSON.stringify(service)}: html[data-bookmark-service] is ${JSON.stringify(got.attr)}, want ${JSON.stringify(want)}`);
    }
  }
  // An unknown mirror value never reaches the attribute.
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("pp-bookmark-service", "linkding\" x"); });
  await page.goto(`${ORIGIN}/popup?bogus`);
  checked++;
  if ((await page.evaluate(() => window.__firstFrame)) !== null) fail.push("first frame: an unknown mirror value was copied to html[data-bookmark-service]");

  // The async tail corrects a stale mirror from chrome.storage and rewrites it.
  await page.unroute(`${ORIGIN}/**`);
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/popup-theme-early.js") {
      return route.fulfill({ contentType: "text/javascript", body: early });
    }
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><head>
      <script>window.chrome = { storage: {
        local: { get: (d) => Promise.resolve({ ...d, optSyncEnabled: false, bookmarkService: window.__stored }) },
        sync: { get: (d) => Promise.resolve({ ...d, bookmarkService: window.__stored }) } } };
        window.__stored = new URL(location.href).searchParams.get("stored");</script>
      <script src="/popup-theme-early.js"></script>
      </head><body></body></html>` });
  });
  for (const [mirror, stored] of [["pinboard", "linkding"], ["linkding", "karakeep"], ["linkding", "pinboard"]]) {
    await page.goto(`${ORIGIN}/blank`);
    await page.evaluate((v) => { localStorage.clear(); localStorage.setItem("pp-bookmark-service", v); }, mirror);
    await page.goto(`${ORIGIN}/popup?stored=${stored}`);
    checked++;
    try {
      await page.waitForFunction((want) => document.documentElement.getAttribute("data-bookmark-service") === want
        && localStorage.getItem("pp-bookmark-service") === want, stored, { timeout: 5000 });
    } catch {
      const got = await page.evaluate(() => [document.documentElement.getAttribute("data-bookmark-service"), localStorage.getItem("pp-bookmark-service")]);
      fail.push(`stale mirror ${mirror}, stored ${stored}: attribute/mirror became ${JSON.stringify(got)}`);
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
