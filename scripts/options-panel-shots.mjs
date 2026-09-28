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
// Stability hardening (fix round 1, controller ruling): the host's real
// device scale factor (150% here) let Chromium rasterize hairline borders at
// a fractional physical pixel (e.g. 0.667px), which the compositor can then
// round differently between two otherwise-identical runs -- the root cause
// of an intermittent single-row diff on one archive/terminal capture.
// `--force-device-scale-factor=1` (below, launch args) pins the physical
// pixel grid; in the reviewer's 36 extra runs this gave 0/56 mismatches
// under 4-way concurrency, while forcing software rendering (swiftshader /
// GPU raster off) made it WORSE (14/56, ±1 LSB corner noise) -- do not
// reach for swiftshader here. Each panel is additionally shot TWICE per
// (theme, panel) and compared byte-for-byte before either PNG is written
// (see shootStable(): a third, discarded WARM-UP capture precedes the two
// compared ones -- the very first screenshot after a DOM mutation reliably
// rasterizes with different AA than a repeat of the same settled frame,
// text-dense panels only, found while building this hardening); a same-run
// mismatch after warm-up means the render is still non-deterministic on
// this host and the script fails loudly (`UNSTABLE <panel> <theme>`, exit
// 3) instead of silently writing a coin-flip capture -- the gate must
// never depend on the caller happening to re-run it until it passes.
//
// A `--panels` subset is a diagnostic convenience, NOT a substitute
// baseline/candidate pair: every panel is shot into the SAME live page
// instance in sequence (one `ctx`/`page` for the whole run, see main()),
// and some per-panel state is cumulative across that sequence (disclosure
// open/closed persists per data-acc-key in localStorage, tag fixtures are
// seeded once up front, etc.) -- shooting a subset, or the same subset in a
// different order, can visit panels in a different relative sequence than a
// full run and is not guaranteed pixel-identical to the corresponding shots
// from a full `--panels`-less run. Only diff a full run against another
// full run (this is what the baseline/candidate pair always is).
//
// shots-meta.json (final review C-2): every run writes the settings that
// decide HOW pixels are rasterized -- the raster-relevant Chromium flags
// (RASTER_ARGS below, including the MSAA pin), the device scale factor, the
// viewport/locale frame and this script's git blob sha -- into its output
// directory. scripts/panel-pixel-diff.mjs refuses (exit 2) to compare two
// directories whose meta differ or when either lacks it: a directory shot
// before 07e97334 (default GPU raster, no meta) must be re-shot, never
// diffed against one shot after it (that reproduces the 8-panel false
// "outside" failures of fields-bplus Task 3).
//
// Usage:
//   node scripts/options-panel-shots.mjs <outDir> [--rects "<sel>,<sel>"] [--panels a,b] [--themes default,terminal]
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = fileURLToPath(import.meta.url);
const TIMEOUT_MS = 20_000;
const DEVICE_SCALE_FACTOR = 1;
const VIEWPORT = { width: 1280, height: 1000 };
const LOCALE = "zh-CN";
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

// The flags that decide how a frame is rasterized -- written verbatim into
// shots-meta.json so the pixel diff can refuse a mixed pair.
const RASTER_ARGS = [
  `--force-device-scale-factor=${DEVICE_SCALE_FACTOR}`,
  // Pin analytic anti-aliasing (fields-bplus Task 3, ruling R10/R11).
  // Measured 2026-09-28: at 4019b3a4 the default GPU raster drew 8 panels
  // (general, ai-behavior, archive, vocab x default/terminal) through
  // MSAA, while the same panels at the B+ HEAD are not (HEAD shots are
  // byte-identical with and without this flag; only the 4019b3a4 shots
  // change, by 5,765-14,768 px each). Same-version re-shoots were
  // byte-identical and element geometry was unchanged, yet 2,554-8,120 px
  // per panel differed OUTSIDE the changed value boxes (button corners,
  // switch-track ends, disclosure chevrons, icon edges): a CSS change
  // elsewhere on a layer can flip that layer's raster mode and move
  // anti-aliasing all over it. This script feeds a change detector
  // (scripts/panel-pixel-diff.mjs), not a fidelity check, so both sides
  // are rasterized the same way. Keep DSF 1 and the warm-up capture too.
  "--gpu-rasterization-msaa-sample-count=0",
];

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), "pbp-stage3c-shots-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(),
    headless: false, // MV3 extensions require headed
    locale: LOCALE,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    viewport: VIEWPORT,
    args: [
      `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, `--lang=${LOCALE}`,
      "--no-first-run", "--no-default-browser-check", "--disable-default-apps",
      "--disable-background-networking", "--disable-component-update", "--disable-sync",
      "--metrics-recording-only", "--no-pings",
      ...RASTER_ARGS,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    ],
  });
  return { ctx, profile };
}

// shots-meta.json: `compare` must match between the two directories the
// pixel diff is given; `info` is recorded for the report only (the before
// side is shot from another commit by design).
function writeMeta(dir, browserVersion) {
  let scriptBlob;
  try { scriptBlob = execFileSync("git", ["hash-object", SCRIPT], { encoding: "utf8" }).trim(); } catch (e) {
    throw new Error(`git hash-object failed -- cannot record the script blob in shots-meta.json: ${e.message}`);
  }
  let head = null;
  try { head = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { head = null; }
  const meta = {
    schema: 1,
    compare: { rasterArgs: RASTER_ARGS, deviceScaleFactor: DEVICE_SCALE_FACTOR, viewport: VIEWPORT, locale: LOCALE, scriptBlob },
    info: { head, browserVersion, takenAt: new Date().toISOString() },
  };
  writeFileSync(join(dir, "shots-meta.json"), JSON.stringify(meta, null, 1) + "\n");
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
    // Open every non-help disclosure, not just `.disclosure` -- the Send-to
    // builder's "how to set up" details (`.et-onboarding`) is a second kind
    // of non-help disclosure (options.js ~1913) and its `.hint` body must be
    // visible in the gate too. `.context-help` answers stay closed (an open
    // answer would inflate the section gap); `[hidden]` sections are inert.
    document.querySelectorAll(`#panel-${id} details:not(.context-help)`).forEach((d) => { d.open = true; });
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
  // Skip infinite animations (e.g. `.tab-btn.tab-busy::after`'s pulse) --
  // awaiting their `finished` promise never resolves -- and cap the wait so
  // a stray after-state can't hang the shoot forever.
  await page.evaluate(() => {
    const fin = document.getAnimations()
      .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
      .map((a) => a.finished.catch(() => {}));
    return Promise.race([Promise.all(fin), new Promise((r) => setTimeout(r, 5000))]);
  });
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

// Shoots the same panel twice in a row and returns the PNG buffer only if
// the two captures are byte-for-byte identical -- a same-run mismatch means
// the render is not yet settled/deterministic on this host (see the header
// comment) and must fail the whole gate rather than silently pick a winner.
// A throwaway WARM-UP capture comes first, discarded: the very first
// screenshot Playwright takes right after a DOM mutation (theme switch +
// reveal()) reliably rasterizes with different AA than a repeat capture of
// the identical, now-settled frame -- confirmed on #panel-general/terminal
// (dense CJK text, ~50,000/920,040 px differing, every run, until a warm-up
// shot is taken first) even with `--force-device-scale-factor=1` and zero
// running animations. Once warmed up, repeat captures were byte-identical
// across dozens of runs with no extra delay needed. Sparser panels (e.g.
// archive) never showed this without a warm-up either, so it costs nothing
// there; it is what makes the two REAL comparison shots below trustworthy
// on every panel, not just the sparse ones.
async function shootStable(page, panelSel) {
  const locator = page.locator(panelSel);
  await locator.screenshot({ animations: "disabled" }); // warm-up, discarded
  const a = await locator.screenshot({ animations: "disabled" });
  const b = await locator.screenshot({ animations: "disabled" });
  return Buffer.compare(a, b) === 0 ? a : null;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  mkdirSync(opt.dir, { recursive: true });
  const { ctx, profile } = await launch();
  let written = 0;
  let unstable = 0;
  try {
    const worker = await getWorker(ctx);
    const extId = new URL(worker.url()).hostname;
    writeMeta(opt.dir, ctx.browser()?.version() ?? null);
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
        const png = await shootStable(page, panelSel);
        if (!png) {
          console.error(`UNSTABLE ${panel} ${theme}`);
          unstable++;
          continue; // keep scanning so one run reports every unstable panel
        }
        writeFileSync(`${stem}.png`, png);
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
  if (unstable > 0) {
    console.error(`[shots] ${unstable} panel(s) failed the same-run stability check -- see UNSTABLE lines above`);
    process.exit(3);
  }
}

main().catch((e) => { console.error("[shots] fatal:", e.stack || e.message); process.exit(1); });
