#!/usr/bin/env node
// Pixel-level oracle for Settings contextual-help alignment. DOM line boxes
// and Canvas text metrics are not accepted here: both can be correct while
// the rasterized CJK ink is visibly above or below the Lucide glyph. The one
// DOM input is the alphabetic copy's baseline, and it only decides which ink
// rows are descenders (see capturePair); every centre is still raster ink.

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromQa = createRequire(resolve(ROOT, ".qa-scan", "package.json"));
const { chromium } = requireFromQa("playwright");
const { PNG } = requireFromQa("pngjs");

const ROLES = Object.freeze(["section", "field", "choice", "group", "action"]);
const LOCALES = Object.freeze([
  { id: "zh-CN", messagesDir: "zh_CN" },
  { id: "en", messagesDir: "en" },
]);
const DPR_VALUES = Object.freeze([1, 1.25, 1.5, 2]);
// One CSS layout can land on opposite half-pixel edges under Verdana/YaHei
// and Liberation/WenQuanYi rasterization. Two physical pixels keep both font
// paths within 1 CSS px at DPR 2 while still rejecting the visible 3px drift
// this oracle was introduced to catch.
const MAX_CENTER_DELTA_PHYSICAL_PX = 2;
// How far the DOM baseline row may sit below the copy's ink bottom (the row
// after its last ink row) before the probe is treated as broken
// (capturePair). Measured 2026-09-29 over all 102 Latin probes, local fonts
// and ci-fonts.conf alike: never below it (baseline - ink bottom = -7..0);
// the rounding of baseline x DPR is the only reason for any slack.
const BASELINE_BELOW_INK_SLACK_PHYSICAL_PX = 2;
// PBP_HELP_RASTER_RANGES=1 prints the per-(locale, DPR, script, role) delta ranges on
// a passing run too -- the calibration view, across all four DPRs (the plain gate
// above already covers all four; this just also prints them): run it under the local
// fonts and under FONTCONFIG_FILE="$PWD/scripts/ci-fonts.conf" and pick offsets that
// keep BOTH within tolerance.
const PRINT_RANGES = process.env.PBP_HELP_RASTER_RANGES === "1";
const HELP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>';

// The CI emulation must not depend on the developer's OWN fontconfig.
// scripts/ci-fonts.conf includes the host's /etc/fonts/conf.d, and that
// directory's 50-user.conf pulls in $XDG_CONFIG_HOME/fontconfig/{conf.d,
// fonts.conf} (default ~/.config/fontconfig) -- a personal hintstyle,
// subpixel order or family preference there would silently change what the
// "CI" run rasterises (a global `<match target="font">` assign even
// overrides conf.d's per-font rules that CI keeps, e.g. 25-wqy-zenhei.conf's
// hintnone + rgba none for WenQuanYi). So, with FONTCONFIG_FILE set, the
// browser (and the fc-match parity probe) get XDG_CONFIG_HOME pointed at an
// empty temp dir. scripts/ui-render-audit.mjs carries the same helper (the
// two scripts are separate processes; a shared module for ~20 lines was not
// worth it). The two legacy per-user files 50-user.conf also reads,
// ~/.fonts.conf and ~/.fonts.conf.d, hang off $HOME and cannot be redirected
// that way, so their presence stops the run instead of being half-honoured.
// A pin of hintstyle/rgba after the include was rejected for the same
// per-font reason: it would clobber the WenQuanYi rule CI has. What is left
// host-dependent is the host conf.d itself and 51-local.conf's
// /etc/fonts/local.conf (the ci-fonts.conf header says so).
function isolatedFontconfigEnv() {
  if (!process.env.FONTCONFIG_FILE) return null;
  const legacy = [join(homedir(), ".fonts.conf"), join(homedir(), ".fonts.conf.d")].filter((p) => existsSync(p));
  if (legacy.length) {
    console.error(
      `[options-help-render-audit] FONTCONFIG_FILE is set but legacy per-user fontconfig exists (${legacy.join(", ")}). ` +
      `/etc/fonts/conf.d/50-user.conf reads it through $HOME, which this script cannot isolate the way it isolates ` +
      `$XDG_CONFIG_HOME/fontconfig, so the CI emulation would silently include your personal settings. ` +
      `Move it under ~/.config/fontconfig (isolated automatically) or out of the way, then rerun.`
    );
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), "pbp-ci-fonts-xdg-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { ...process.env, XDG_CONFIG_HOME: dir } };
}
const FONTCONFIG_ISOLATION = isolatedFontconfigEnv();

// The parity probe's own environment: the isolated one, minus the locale.
// fontconfig takes its default language from FC_LANG, else the LC_CTYPE
// locale (LC_ALL > LC_CTYPE > LANG), and "Microsoft YaHei" is a family the
// conf does not have, so fc-match falls back to the best font for THAT
// language: under zh_CN.UTF-8 (or FC_LANG=ja) a correctly loaded conf
// answers WenQuanYi Zen Hei, not DejaVu Sans, and the check below blamed an
// XML comment for it. Pinned to C.UTF-8 with every LC_* / LANGUAGE /
// FC_LANG dropped (measured: DejaVu Sans under the conf, msyh.ttc without
// it, whatever the parent locale). Only the probe: the browser keeps the
// inherited locale, and a zh_CN run rasterised the same 184 probes pixel
// for pixel (round-2 review).
function parityProbeEnv(env) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !/^(?:LC_\w+|LANGUAGE|FC_LANG)$/.test(k)));
  out.LANG = "C.UTF-8";
  return out;
}

// K107: scripts/ci-fonts.conf exists so a developer can make their machine's
// font resolution match CI's, but nothing ever asserted the file actually
// loaded -- and its own header names two silent failure modes: a relative
// FONTCONFIG_FILE is looked up under /etc/fonts and silently falls back to
// the default config, and an XML comment containing "--" fails to parse and
// is dropped just as quietly. Both leave fc-match resolving "Microsoft YaHei"
// to msyh.ttc instead of DejaVu Sans -- the conf's own prescribed sanity
// check, now the script's job instead of a human's. Only runs when a
// developer has opted in by setting FONTCONFIG_FILE; CI never sets it, so
// this is a no-op there.
function checkFontconfigParity() {
  const confPath = process.env.FONTCONFIG_FILE;
  if (!confPath) return;
  if (!isAbsolute(confPath)) {
    console.error(
      `[options-help-render-audit] FONTCONFIG_FILE="${confPath}" is not an absolute path. ` +
      `fontconfig looks up a relative name under /etc/fonts, fails to find it there, ` +
      `and silently falls back to the default config (see the header comment in ${confPath}). ` +
      `Use an absolute path, e.g. FONTCONFIG_FILE="$PWD/scripts/ci-fonts.conf".`
    );
    process.exit(2);
  }
  let resolved;
  try {
    resolved = execFileSync("fc-match", ["Microsoft YaHei"], { encoding: "utf8", env: parityProbeEnv(FONTCONFIG_ISOLATION?.env ?? process.env) }).trim();
  } catch (e) {
    console.warn(`[options-help-render-audit] fc-match unavailable (${e.code || e.message}) -- skipping the FONTCONFIG_FILE=${confPath} parity check (fontconfig is Linux-only).`);
    return;
  }
  if (!resolved.includes("DejaVu")) {
    console.error(
      `[options-help-render-audit] FONTCONFIG_FILE=${confPath} did not take effect: fc-match "Microsoft YaHei" ` +
      `resolved to "${resolved}", expected a DejaVu Sans match. This is one of the two silent failure ` +
      `modes ${confPath} documents (relative path already ruled out above; check the file for an ` +
      `XML comment containing "--", which fontconfig fails to parse and drops silently). ` +
      `Reproduce: env -u LC_ALL -u LC_CTYPE -u FC_LANG LANG=C.UTF-8 XDG_CONFIG_HOME="$(mktemp -d)" FONTCONFIG_FILE="${confPath}" fc-match "Microsoft YaHei"`
    );
    process.exit(2);
  }
}
checkFontconfigParity();

const html = readFileSync(resolve(ROOT, "options.html"), "utf8")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
  .replace(/<link\s+rel="stylesheet"\s+href="options\.css"\s*>/i,
    `<style>${readFileSync(resolve(ROOT, "options.css"), "utf8")}</style>`);

const AUDIT_CSS = `
  html, body { background: #fff !important; }
  .panel { display: none !important; }
  .panel[data-help-audit-panel] { display: block !important; }
  [data-help-audit-scope], [data-help-audit-scope] * {
    background: #fff !important;
    border-color: transparent !important;
    box-shadow: none !important;
    color: transparent !important;
    opacity: 1 !important;
    text-decoration: none !important;
    text-shadow: none !important;
  }
  [data-help-audit-scope] {
    position: fixed !important;
    inset: auto !important;
    top: 100px !important;
    left: 100px !important;
    width: 1200px !important;
    z-index: 2147483647 !important;
  }
  [data-help-audit-scope] [data-help-audit-copy] {
    color: #000 !important;
  }
  /* The blanket opacity reset above is for dimmed copy; a .switch row's native
     input is transparent by contract (it overlays the whole label as the hit
     area), and forcing it opaque paints a label-sized checkbox over the copy. */
  [data-help-audit-scope] .switch > input {
    opacity: 0 !important;
  }
  [data-help-audit-scope] [data-help-audit-icon],
  [data-help-audit-scope] [data-help-audit-icon] * {
    color: #000 !important;
    stroke: #000 !important;
  }
`;

function inkBounds(png, region, scaleX, scaleY) {
  const left = Math.max(0, Math.floor(region.left * scaleX) - 1);
  const right = Math.min(png.width - 1, Math.ceil(region.right * scaleX) + 1);
  const top = Math.max(0, Math.floor(region.top * scaleY) - 1);
  const bottom = Math.min(png.height - 1, Math.ceil(region.bottom * scaleY) + 1);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const offset = (y * png.width + x) * 4;
      const alpha = png.data[offset + 3];
      const luminance = 0.2126 * png.data[offset]
        + 0.7152 * png.data[offset + 1]
        + 0.0722 * png.data[offset + 2];
      if (alpha < 128 || luminance > 205) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return Number.isFinite(minY) ? { minX, minY, maxX, maxY } : null;
}

async function preparePage(page, locale) {
  const messages = JSON.parse(readFileSync(
    resolve(ROOT, "_locales", locale.messagesDir, "messages.json"),
    "utf8",
  ));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: AUDIT_CSS });
  await page.evaluate(({ icon, lang, localizedMessages }) => {
    document.documentElement.lang = lang;
    document.documentElement.setAttribute("data-options-ready", "");
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      const message = localizedMessages[node.dataset.i18n]?.message;
      if (typeof message === "string") node.textContent = message;
    });
    document.querySelectorAll(".context-help-toggle .btn-ic").forEach((slot) => {
      slot.innerHTML = icon;
    });
    document.querySelectorAll("details.context-help").forEach((details) => {
      // A .switch choice row carries its help INSIDE the label (Ruling 36):
      // there the label is the anchor and its parent the host.
      const inLabel = details.parentElement?.matches("label");
      const host = inLabel ? details.parentElement.parentElement : details.parentElement;
      const anchor = inLabel ? details.parentElement : details.previousElementSibling;
      const copyNode = host?.dataset.helpRole === "choice"
        ? (anchor?.querySelector("span[data-i18n]") || anchor)
        : host?.dataset.helpRole === "action"
          ? (anchor?.querySelector("button") || anchor)
          : anchor;
      if (!host || !copyNode) return;
      host.dataset.helpScript = /[\u3040-\u30ff\u3100-\u312f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u
        .test(copyNode.textContent || "") ? "cjk" : "alphabetic";
    });
    document.querySelectorAll("details.disclosure").forEach((section) => { section.open = true; });
  }, { icon: HELP_ICON, lang: locale.id, localizedMessages: messages });
  await page.evaluate(() => document.fonts.ready);
}

async function inventory(page) {
  return page.evaluate(() => [...document.querySelectorAll("details.context-help")].map((details, index) => {
    const inLabel = details.parentElement?.matches("label");
    const host = inLabel ? details.parentElement.parentElement : details.parentElement;
    const anchor = inLabel ? details.parentElement : details.previousElementSibling;
    const inferredRole = host?.classList.contains("context-help-action-row") ? "action"
      : host?.classList.contains("context-help-section") ? "section"
      : anchor?.matches("label") && anchor.querySelector('input[type="checkbox"],input[type="radio"]') ? "choice"
      : anchor?.matches("label.bl") ? "field"
      : anchor?.matches(".bl,.context-help-anchor") ? "group"
      : null;
    return {
      index,
      key: details.querySelector(".context-help-body[data-i18n]")?.dataset.i18n || `help-${index}`,
      declaredRole: host?.dataset.helpRole || null,
      declaredScript: host?.dataset.helpScript || null,
      inferredRole,
    };
  }));
}

async function capturePair(page, item) {
  const prepared = await page.evaluate(({ index }) => {
    document.querySelectorAll("[data-help-audit-scope],[data-help-audit-copy],[data-help-audit-icon],[data-help-audit-panel]")
      .forEach((node) => {
        node.removeAttribute("data-help-audit-scope");
        node.removeAttribute("data-help-audit-copy");
        node.removeAttribute("data-help-audit-icon");
        node.removeAttribute("data-help-audit-panel");
      });
    const details = document.querySelectorAll("details.context-help")[index];
    const inLabel = details?.parentElement?.matches("label");
    const host = inLabel ? details.parentElement.parentElement : details?.parentElement;
    const anchor = inLabel ? details.parentElement : details?.previousElementSibling;
    if (!host || !anchor) return null;
    const panel = host.closest(".panel");
    panel?.setAttribute("data-help-audit-panel", "");
    for (let node = host; node && node !== panel; node = node.parentElement) {
      node.hidden = false;
      if (node.matches("details")) node.open = true;
      if (node.style.display === "none") node.style.removeProperty("display");
    }
    details.open = false;
    const role = host.dataset.helpRole;
    const copyNode = role === "choice" ? (anchor.querySelector("span[data-i18n]") || anchor)
      : role === "action" ? (anchor.querySelector("button") || anchor)
      : anchor;
    const iconNode = details.querySelector(":scope > summary.context-help-toggle svg");
    if (!copyNode || !iconNode) return null;
    host.setAttribute("data-help-audit-scope", "");
    copyNode.setAttribute("data-help-audit-copy", "");
    iconNode.setAttribute("data-help-audit-icon", "");
    return true;
  }, { index: item.index });
  if (!prepared) return { error: "not rendered" };
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
  const settled = await page.evaluate(() => {
    const host = document.querySelector("[data-help-audit-scope]");
    const copyNode = host?.querySelector("[data-help-audit-copy]");
    const iconNode = host?.querySelector("[data-help-audit-icon]");
    if (!host || !copyNode || !iconNode) return null;
    // Alphabetic copy: the first line's baseline, read from layout by a
    // zero-size inline-block (its bottom edge IS the baseline it sits on)
    // placed with the first text run. A <span> wraps probe + text so the pair
    // stays one inline run even when the text's parent is a flex container
    // (the action row's <button>), where a bare probe would become a flex item
    // of its own. The probe must not move anything: the copy, the icon and the
    // text run are re-measured with it in place, and any shift, a missing text
    // run or a baseline outside the copy box is a SETUP error, not a delta.
    let baseline = null;
    if (host.dataset.helpScript === "alphabetic") {
      const walker = document.createTreeWalker(copyNode, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
      });
      const text = walker.nextNode();
      if (!text) {
        baseline = { error: "no text run inside the copy node" };
      } else {
        const textRect = () => {
          const range = document.createRange();
          range.selectNodeContents(text);
          return range.getBoundingClientRect();
        };
        const snapshot = () => [copyNode.getBoundingClientRect(), iconNode.getBoundingClientRect(), textRect()]
          .flatMap((rect) => [rect.left, rect.top, rect.width, rect.height]);
        const before = snapshot();
        const wrap = document.createElement("span");
        const probe = document.createElement("span");
        probe.style.cssText = "display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline";
        text.before(wrap);
        wrap.append(probe, text);
        const probeRect = probe.getBoundingClientRect();
        const during = snapshot();
        wrap.before(text);
        wrap.remove();
        const copyBox = copyNode.getBoundingClientRect();
        const drift = Math.max(...before.map((value, index) => Math.abs(value - during[index])));
        if (drift > 0.01) {
          baseline = { error: `probe moved the layout by ${drift.toFixed(3)}px` };
        } else if (!Number.isFinite(probeRect.bottom) || probeRect.bottom <= copyBox.top || probeRect.bottom > copyBox.bottom) {
          baseline = { error: `baseline ${probeRect.bottom} outside the copy box ${copyBox.top}..${copyBox.bottom}` };
        } else {
          baseline = { y: probeRect.bottom - host.getBoundingClientRect().top };
        }
      }
    }
    const hostRect = host.getBoundingClientRect();
    const copyRect = copyNode.getBoundingClientRect();
    const iconRect = iconNode.getBoundingClientRect();
    return {
      baseline,
      host: { width: hostRect.width, height: hostRect.height },
      copy: {
        left: copyRect.left - hostRect.left,
        right: copyRect.right - hostRect.left,
        top: copyRect.top - hostRect.top,
        bottom: copyRect.bottom - hostRect.top,
      },
      icon: {
        left: iconRect.left - hostRect.left,
        right: iconRect.right - hostRect.left,
        top: iconRect.top - hostRect.top,
        bottom: iconRect.bottom - hostRect.top,
      },
    };
  });
  if (!settled || settled.host.width <= 0 || settled.host.height <= 0) return { error: "not rendered after settling" };
  const buffer = await page.locator("[data-help-audit-scope]").screenshot({ animations: "disabled" });
  const png = PNG.sync.read(buffer);
  const scaleX = png.width / settled.host.width;
  const scaleY = png.height / settled.host.height;
  const copyInk = inkBounds(png, settled.copy, scaleX, scaleY);
  const iconInk = inkBounds(png, settled.icon, scaleX, scaleY);
  if (!copyInk || !iconInk) return { error: `missing raster ink copy=${!!copyInk} icon=${!!iconInk}` };
  // Alphabetic copy is centred on its ink ABOVE the baseline: ink top down to
  // the baseline row, descender rows excluded. The full ink box made the same
  // icon placement read up to 4 device px apart between titles with and
  // without a descender ("Prompts" vs "Theme" at 16px/600, DPR 2 -- the whole
  // +-2 window), so the gate was judging the words, not the icon. CJK copy
  // has no descender band and keeps the full ink box.
  let copyBottom = copyInk.maxY + 1;
  let baselineRow = null;
  if (settled.baseline) {
    if (settled.baseline.error) return { error: `SETUP baseline probe: ${settled.baseline.error}` };
    baselineRow = Math.round(settled.baseline.y * scaleY);
    if (baselineRow <= copyInk.minY) {
      return { error: `SETUP baseline probe: baseline row ${baselineRow} is not below the ink top ${copyInk.minY}` };
    }
    // The other side of the cross-check: a baseline row BELOW the ink bottom
    // would make the min() below pick the ink bottom, i.e. silently fall back
    // to the old whole-ink-box centre this metric replaced. On every real
    // Latin string the baseline row equals the ink bottom (flat letters) or
    // sits above it (descenders, round letters' one faint overshoot row), so
    // anything past the slack means the probe measured the wrong line.
    if (baselineRow > copyBottom + BASELINE_BELOW_INK_SLACK_PHYSICAL_PX) {
      return { error: `SETUP baseline probe: baseline row ${baselineRow} is below the copy's ink bottom ${copyBottom} (+${BASELINE_BELOW_INK_SLACK_PHYSICAL_PX} device px slack) -- the Latin metric would silently fall back to the whole ink box` };
    }
    copyBottom = Math.min(copyBottom, baselineRow);
  }
  const copyCenter = (copyInk.minY + copyBottom) / 2;
  const iconCenter = (iconInk.minY + iconInk.maxY + 1) / 2;
  return {
    deltaPhysicalPx: iconCenter - copyCenter,
    rasterScale: Number(scaleY.toFixed(3)),
    copyInkY: `${copyInk.minY}-${copyInk.maxY}${baselineRow === null ? "" : ` baseline=${baselineRow}`}`,
    iconInkY: `${iconInk.minY}-${iconInk.maxY}`,
  };
}

const failures = [];
const samples = new Map();
let probes = 0;
const browser = await chromium.launch(FONTCONFIG_ISOLATION ? { env: FONTCONFIG_ISOLATION.env } : {});
try {
  for (const dpr of DPR_VALUES) {
    for (const locale of LOCALES) {
      const context = await browser.newContext({
        viewport: { width: 1600, height: 1000 },
        deviceScaleFactor: dpr,
      });
      const page = await context.newPage();
      await preparePage(page, locale);
      const items = await inventory(page);
      const missing = items.filter((item) => !ROLES.includes(item.declaredRole));
      if (missing.length) {
        failures.push(`${locale.id}@${dpr}: ${missing.length} host(s) lack a declared semantic role`);
      }
      const mismatched = items.filter((item) => item.declaredRole && item.declaredRole !== item.inferredRole);
      if (mismatched.length) {
        failures.push(`${locale.id}@${dpr}: role mismatch ${mismatched.slice(0, 4).map((item) => `${item.key}:${item.declaredRole}/${item.inferredRole}`).join(", ")}`);
      }
      const missingScript = items.filter((item) => !["cjk", "alphabetic"].includes(item.declaredScript));
      if (missingScript.length) {
        failures.push(`${locale.id}@${dpr}: ${missingScript.length} host(s) lack an actual-copy script family`);
      }
      const firstByRole = ROLES.map((role) => items.find((item) => (item.declaredRole || item.inferredRole) === role)).filter(Boolean);
      const selected = dpr === 1.5 || dpr === 2 ? items : firstByRole;
      for (const item of selected) {
        const role = item.declaredRole || item.inferredRole;
        if (!ROLES.includes(role)) continue;
        const result = await capturePair(page, item);
        probes += 1;
        if (result.error) {
          failures.push(`${locale.id}@${dpr} ${role}/${item.key}: ${result.error}`);
          continue;
        }
        const sampleKey = `${locale.id}@${dpr}/${item.declaredScript}/${role}`;
        if (!samples.has(sampleKey)) samples.set(sampleKey, []);
        samples.get(sampleKey).push(result.deltaPhysicalPx);
        const tolerance = dpr === 1.5 || dpr === 2 ? MAX_CENTER_DELTA_PHYSICAL_PX : 2;
        if (Math.abs(result.deltaPhysicalPx) > tolerance) {
          failures.push(`${locale.id}@${dpr} ${item.declaredScript}/${role}/${item.key}: raster center delta=${result.deltaPhysicalPx}px scale=${result.rasterScale} copy=${result.copyInkY} icon=${result.iconInkY}`);
        }
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`[options-help-render] FAIL ${failures.length} violation(s), ${probes} raster probes`);
  failures.slice(0, 40).forEach((failure) => console.error(`  ${failure}`));
  if (failures.length > 40) console.error(`  ... ${failures.length - 40} more`);
  [...samples.entries()].filter(([key]) => key.includes("@2/")).forEach(([key, values]) => {
    console.error(`  range ${key}: ${Math.min(...values)}..${Math.max(...values)}px (${values.length})`);
  });
  process.exit(1);
}
console.log(`[options-help-render] OK ${probes} raster probes across ${DPR_VALUES.length} DPRs, ${LOCALES.length} locales and ${ROLES.length} roles`);
if (PRINT_RANGES) {
  [...samples.entries()].sort().forEach(([key, values]) => {
    console.log(`  range ${key}: ${Math.min(...values)}..${Math.max(...values)}px (${values.length})`);
  });
}
