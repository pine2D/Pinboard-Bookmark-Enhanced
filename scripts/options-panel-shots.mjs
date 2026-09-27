#!/usr/bin/env node
// Options panel screenshots for the stage-3c visual-zero-change gate
// (spec 2026-09-27-ui-system-stage3c-design §5). Grown from stage 3b's
// scratchpad shoot.mjs: same real-extension recipe (headed Chromium from
// .qa-scan, --load-extension of THIS checkout, network blocked by
// --host-resolver-rules, fake Pinboard token), same zh-CN / DPR 1 / 1280x1000
// frame. Deliberate differences:
//   - all 13 panels (the marker retirement touches all 13, stage 3b shot 9);
//   - every non-help details.disclosure in the active panel is opened, and
//     tags gets two count-1 tags so #tag-gov-lowcount (which holds
//     #tag-gov-select-all) renders chips;
//   - before and after use the SAME density rule (the page's own
//     PBP_OPTIONS_DENSITY_MAP), so a pair differs only by code under test;
//   - per shot, .rects.json (boxes for --rects selectors, for --allow) and
//     .styles.json (computed-style signature of every panel element plus
//     rest/hover/focus probes on six controls) feed scripts/panel-pixel-diff.mjs.
// Dev-only: scripts/ is outside release.sh's packaging.
//
// Usage:
//   node scripts/options-panel-shots.mjs <outDir> [--rects "<sel>,<sel>"] [--panels a,b] [--themes default,terminal]
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 20_000;
const FAKE_TOKEN = "qa:0000000000000000000000000000000000000000";
const ALL_PANELS = ["general", "popup", "bookmarks", "quick", "ai", "ai-behavior", "reader", "vocab", "markdown", "tags", "archive", "appearance", "storage"];
const ALL_THEMES = ["default", "terminal"];
// Run-to-run volatile content. Empty at Task 0; any entry needs a one-line
// reason and is hidden with visibility:hidden (layout kept) in EVERY shot.
const VOLATILE_SELECTORS = [];
const STYLE_PROPS = ["display", "position", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left", "border-top-width", "border-top-color",
  "border-bottom-width", "border-bottom-color", "border-left-width", "border-top-left-radius", "min-height",
  "max-width", "font-size", "font-weight", "line-height", "color", "background-color", "column-gap", "row-gap",
  "transform", "opacity", "box-shadow"];
const STATE_PROBES = [
  { panel: "general", selector: "#opt-pinboard-token" },        // .key-wrap password field
  { panel: "general", selector: "#copy-diagnostics-btn" },      // .btn
  { panel: "popup", selector: "#opt-popup-width-custom" },      // number field inside a .pick row
  { panel: "vocab", selector: "#dict-anki-deck" },              // plain entry-block text field
  { panel: "markdown", selector: "#obsidian-vault" },           // Send-to (formerly .et-field) text field
  { panel: "appearance", selector: "#opt-custom-css" },         // textarea
];
const STATE_PROPS = ["border-top-color", "box-shadow", "outline-style", "outline-color", "background-color"];

function parseArgs(argv) {
  const out = { dir: null, rects: [], panels: ALL_PANELS, themes: ALL_THEMES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i] ?? "";
    if (a === "--rects") out.rects = val().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--panels") out.panels = val().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--themes") out.themes = val().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--")) { console.error(`[shots] unknown flag ${a}`); process.exit(2); }
    else out.dir = resolve(a);
  }
  if (!out.dir) { console.error('usage: node scripts/options-panel-shots.mjs <outDir> [--rects "<sel>,<sel>"] [--panels a,b] [--themes default,terminal]'); process.exit(2); }
  const badPanel = out.panels.find((p) => !ALL_PANELS.includes(p));
  const badTheme = out.themes.find((t) => !ALL_THEMES.includes(t));
  if (badPanel || badTheme) { console.error(`[shots] unknown panel/theme: ${badPanel || badTheme}`); process.exit(2); }
  return out;
}

let chromium;
try {
  ({ chromium } = createRequire(resolve(ROOT, ".qa-scan", "package.json"))("playwright"));
} catch (e) {
  console.error("[shots] playwright not found under .qa-scan:", e.message);
  process.exit(2);
}

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), "pbp-stage3c-shots-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(),
    headless: false, // MV3 extensions require headed
    locale: "zh-CN",
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 1000 },
    args: [
      `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, "--lang=zh-CN",
      "--no-first-run", "--no-default-browser-check", "--disable-default-apps",
      "--disable-background-networking", "--disable-component-update", "--disable-sync",
      "--metrics-recording-only", "--no-pings",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    ],
  });
  return { ctx, profile };
}

async function getWorker(ctx) {
  return ctx.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"))
    || ctx.waitForEvent("serviceworker", { predicate: (w) => w.url().startsWith("chrome-extension://"), timeout: TIMEOUT_MS });
}

async function seed(worker) {
  await worker.evaluate(async (token) => {
    if (typeof primeSettings === "function") await primeSettings();
    await chrome.storage.local.set({
      optSyncEnabled: false,
      syncApiKeys: false,
      pinboardToken: obfuscateKey(token),
      // Two similar groups (plural + separator pair) for #tag-gov-groups, and
      // two count-1 tags so #tag-gov-lowcount renders chips above Select all.
      cached_user_tags: {
        account: "qa",
        counts: { photo: 12, photos: 5, "machine-learning": 8, "machine_learning": 3, recipe: 6, quokka: 1, zeppelin: 1 },
        timestamp: Date.now(),
      },
    });
  }, FAKE_TOKEN);
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    const root = document.documentElement;
    if (t === "default") { delete root.dataset.theme; delete root.dataset.density; return; }
    if (typeof PBP_OPTIONS_DENSITY_MAP !== "object") throw new Error("PBP_OPTIONS_DENSITY_MAP not visible from the page");
    root.dataset.theme = t;
    const density = Object.prototype.hasOwnProperty.call(PBP_OPTIONS_DENSITY_MAP, t) ? PBP_OPTIONS_DENSITY_MAP[t] : "";
    if (density) root.dataset.density = density; else delete root.dataset.density;
  }, theme);
  await page.waitForTimeout(150);
}

async function reveal(page, panel) {
  await page.evaluate((id) => {
    document.querySelectorAll(`#panel-${id} details.disclosure`).forEach((d) => { d.open = true; });
  }, panel);
  if (panel === "storage") {
    await page.waitForFunction(() => (document.getElementById("storage-cats")?.children.length || 0) > 0, null, { timeout: TIMEOUT_MS });
  }
  if (panel === "tags") {
    await page.waitForFunction(() => (document.getElementById("tag-gov-groups")?.children.length || 0) > 0, null, { timeout: TIMEOUT_MS });
    await page.waitForFunction(() => (document.getElementById("tag-gov-lowcount-list")?.children.length || 0) > 0, null, { timeout: TIMEOUT_MS });
  }
  await page.evaluate((sels) => {
    sels.forEach((s) => document.querySelectorAll(s).forEach((el) => { el.style.visibility = "hidden"; }));
  }, VOLATILE_SELECTORS);
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
}

function snapshotStyles({ panelSel, props }) {
  const panel = document.querySelector(panelSel);
  const base = panel.getBoundingClientRect();
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== panel; n = n.parentElement) parts.unshift(`${n.tagName.toLowerCase()}:${[...n.parentElement.children].indexOf(n) + 1}`);
    return parts.join(">") || ":panel";
  };
  const out = {};
  for (const el of [panel, ...panel.querySelectorAll("*")]) {
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    const r = el.getBoundingClientRect();
    const sig = { rect: [r.left - base.left, r.top - base.top, r.width, r.height].map((v) => Math.round(v * 100) / 100) };
    for (const p of props) sig[p] = cs.getPropertyValue(p);
    for (const pseudo of ["::before", "::after"]) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content && ps.content !== "none" && ps.content !== "normal") {
        sig[pseudo] = ["content", "width", "height", "transform", "opacity", "border-top-color", "background-color"].map((p) => ps.getPropertyValue(p)).join("|");
      }
    }
    out[pathOf(el)] = sig;
  }
  return out;
}

function snapshotRects({ panelSel, sels }) {
  const panel = document.querySelector(panelSel);
  const base = panel.getBoundingClientRect();
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
  };
  const out = {};
  for (const sel of sels) {
    out[sel] = [...panel.querySelectorAll(sel)].map((el) => ({
      self: box(el),
      label: box(el.closest("label")),
      row: box(el.closest(".fg-actions, .pref-row, .context-help-host, .context-help-action-row")),
    }));
  }
  return out;
}

async function probeStates(page, panel) {
  const states = {};
  for (const probe of STATE_PROBES.filter((p) => p.panel === panel)) {
    if (!(await page.$(probe.selector))) { states[probe.selector] = { missing: true }; continue; }
    const read = () => page.$eval(probe.selector, (el, props) => {
      const cs = getComputedStyle(el);
      return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
    }, STATE_PROPS);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    const rest = await read();
    await page.hover(probe.selector);
    await page.waitForTimeout(250);
    const hover = await read();
    await page.mouse.move(0, 0);
    await page.focus(probe.selector);
    await page.waitForTimeout(250);
    const focus = await read();
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(250);
    states[probe.selector] = { rest, hover, focus };
  }
  return states;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  mkdirSync(opt.dir, { recursive: true });
  const { ctx, profile } = await launch();
  let written = 0;
  try {
    const worker = await getWorker(ctx);
    const extId = new URL(worker.url()).hostname;
    await seed(worker);
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`, { waitUntil: "load", timeout: TIMEOUT_MS });
    await page.waitForSelector("html[data-options-ready]", { timeout: TIMEOUT_MS });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    for (const theme of opt.themes) {
      await setTheme(page, theme);
      for (const panel of opt.panels) {
        await page.click(`#tab-${panel}`);
        await page.waitForSelector(`#panel-${panel}.active`, { timeout: TIMEOUT_MS });
        await page.waitForTimeout(100);
        await reveal(page, panel);
        const stem = join(opt.dir, `p-${panel}-${theme}-dpr1-zh`);
        const panelSel = `#panel-${panel}`;
        await page.locator(panelSel).screenshot({ path: `${stem}.png`, animations: "disabled" });
        const rects = await page.evaluate(snapshotRects, { panelSel, sels: opt.rects });
        writeFileSync(`${stem}.rects.json`, JSON.stringify({ panel, theme, rects }, null, 1) + "\n");
        const elements = await page.evaluate(snapshotStyles, { panelSel, props: STYLE_PROPS });
        const states = await probeStates(page, panel);
        writeFileSync(`${stem}.styles.json`, JSON.stringify({ panel, theme, elements, states }) + "\n");
        written++;
        console.log(`[shots] ${stem}.png`);
      }
    }
  } finally {
    await ctx.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
  console.log(`[shots] done: ${written} panel shot(s) in ${opt.dir}`);
}

main().catch((e) => { console.error("[shots] fatal:", e.stack || e.message); process.exit(1); });
