// Self-contained live Chromium render & residual-UI audit for the Mac OS 9
// Platinum theme (platinum-ui Gray default) across all 4 extension surfaces:
// popup.html, options.html, library.html, and md-preview.html (light & dark).
//
// Zero external repository dependencies; runs offline in headless Chromium.
// Set PBP_PLATINUM_SHOTS_DIR=/abs/dir (outside repo, e.g. under $PBP_QA_REPORT_DIR)
// to also capture 2x Retina QA screenshots of every surface and mode.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { isolatedFontconfigEnv } from "../scripts/ci-fonts-env.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FONTCONFIG_ISOLATION = isolatedFontconfigEnv("theme-platinum-render-tests");
const SHOTS_DIR = process.env.PBP_PLATINUM_SHOTS_DIR ? resolve(process.env.PBP_PLATINUM_SHOTS_DIR) : null;
if (SHOTS_DIR && (SHOTS_DIR === ROOT || SHOTS_DIR.startsWith(`${ROOT}/`))) {
  console.error(`[theme-platinum-render] PBP_PLATINUM_SHOTS_DIR must be outside the repository root: ${SHOTS_DIR}`);
  process.exit(2);
}

const requireFromQa = createRequire(resolve(ROOT, ".qa-scan", "package.json"));
const { chromium } = requireFromQa("playwright");
const espree = requireFromQa("espree");

function loadPbpIcons() {
  const ast = espree.parse(readFileSync(resolve(ROOT, "shared.js"), "utf8"), {
    ecmaVersion: "latest",
    sourceType: "script",
  });
  for (const node of ast.body) {
    if (node.type !== "VariableDeclaration") continue;
    for (const decl of node.declarations) {
      if (decl.id?.type === "Identifier" && decl.id.name === "PBP_ICONS" && decl.init?.type === "ObjectExpression") {
        const out = {};
        for (const prop of decl.init.properties) {
          if (prop.type !== "Property" || prop.computed) continue;
          const k = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value);
          if (prop.value.type === "Literal" && typeof prop.value.value === "string") {
            out[k] = prop.value.value;
          }
        }
        return out;
      }
    }
  }
  throw new Error("shared.js: const PBP_ICONS = {...} not found");
}

const PBP_ICONS = loadPbpIcons();
const ORIGIN = "https://platinum-audit.local";
const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const RESIDUAL_AND_GEOMETRY_PROBE = () => {
  const parsePx = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  const parseRgb = (v) => {
    const m = String(v || "").match(/[\d.]+/g);
    return m && m.length >= 3 ? m.slice(0, 3).map(Number) : null;
  };

  const iconButtons = [];
  for (const el of document.querySelectorAll("button")) {
    if (el.classList.contains("chip-remove") || el.classList.contains("tag-remove")) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    // Effective hit box including ::before absolute expansion (only when pointer-events !== "none"),
    // scaled by el's own CSS zoom and clipped by any ancestor with non-visible overflow.
    const elZoomX = typeof el.currentCSSZoom === "number" && el.currentCSSZoom > 0
      ? el.currentCSSZoom
      : (el.offsetWidth > 0 ? rect.width / el.offsetWidth : 1);
    const elZoomY = typeof el.currentCSSZoom === "number" && el.currentCSSZoom > 0
      ? el.currentCSSZoom
      : (el.offsetHeight > 0 ? rect.height / el.offsetHeight : elZoomX);
    let hitL = rect.left, hitR = rect.right, hitT = rect.top, hitB = rect.bottom;
    const before = getComputedStyle(el, "::before");
    if (
      before &&
      before.content &&
      before.content !== "none" &&
      before.position === "absolute" &&
      before.pointerEvents !== "none"
    ) {
      const padL = rect.left + parsePx(cs.borderLeftWidth) * elZoomX;
      const padR = rect.right - parsePx(cs.borderRightWidth) * elZoomX;
      const padT = rect.top + parsePx(cs.borderTopWidth) * elZoomY;
      const padB = rect.bottom - parsePx(cs.borderBottomWidth) * elZoomY;
      const bW = parsePx(before.width) * elZoomX;
      const bH = parsePx(before.height) * elZoomY;
      const left = parsePx(before.left) * elZoomX, right = parsePx(before.right) * elZoomX;
      const top = parsePx(before.top) * elZoomY, bottom = parsePx(before.bottom) * elZoomY;
      const boxL = before.left !== "auto" ? padL + left : (before.right !== "auto" ? padR - right - bW : padL);
      const boxR = bW > 0 ? boxL + bW : (before.right !== "auto" ? padR - right : boxL);
      const boxT = before.top !== "auto" ? padT + top : (before.bottom !== "auto" ? padB - bottom - bH : padT);
      const boxB = bH > 0 ? boxT + bH : (before.bottom !== "auto" ? padB - bottom : boxT);
      hitL = Math.min(hitL, boxL);
      hitR = Math.max(hitR, boxR);
      hitT = Math.min(hitT, boxT);
      hitB = Math.max(hitB, boxB);
    }
    for (let anc = el; anc && anc !== document.documentElement; anc = anc.parentElement) {
      const acs = anc === el ? cs : getComputedStyle(anc);
      const ox = acs.overflowX, oy = acs.overflowY;
      const clipsX = ox === "hidden" || ox === "clip" || ox === "auto" || ox === "scroll";
      const clipsY = oy === "hidden" || oy === "clip" || oy === "auto" || oy === "scroll";
      if (!clipsX && !clipsY) continue;
      const ar = anc.getBoundingClientRect();
      const effZoomX = typeof anc.currentCSSZoom === "number" && anc.currentCSSZoom > 0
        ? anc.currentCSSZoom
        : (anc.offsetWidth > 0 ? ar.width / anc.offsetWidth : 1);
      const effZoomY = typeof anc.currentCSSZoom === "number" && anc.currentCSSZoom > 0
        ? anc.currentCSSZoom
        : (anc.offsetHeight > 0 ? ar.height / anc.offsetHeight : effZoomX);
      if (clipsX) {
        const cl = ar.left + parsePx(acs.borderLeftWidth) * effZoomX;
        const cr = anc.clientWidth > 0 ? cl + anc.clientWidth * effZoomX : ar.right - parsePx(acs.borderRightWidth) * effZoomX;
        hitL = Math.max(hitL, cl);
        hitR = Math.min(hitR, cr);
      }
      if (clipsY) {
        const ct = ar.top + parsePx(acs.borderTopWidth) * effZoomY;
        const cb = anc.clientHeight > 0 ? ct + anc.clientHeight * effZoomY : ar.bottom - parsePx(acs.borderBottomWidth) * effZoomY;
        hitT = Math.max(hitT, ct);
        hitB = Math.min(hitB, cb);
      }
    }
    const hitW = +Math.max(0, hitR - hitL).toFixed(2);
    const hitH = +Math.max(0, hitB - hitT).toFixed(2);

    // Pseudo-drawn 13x13 Mac OS 9 .tbox controls (.fc-dismiss, #ask-close, #rail-toggle)
    const isPseudoTbox = el.classList.contains("fc-dismiss") || el.id === "ask-close" || el.id === "rail-toggle";
    if (isPseudoTbox) {
      const tboxPseudo = getComputedStyle(el, el.id === "rail-toggle" ? "::before" : "::after");
      const hasTboxBox = Boolean(
        tboxPseudo &&
        tboxPseudo.content &&
        tboxPseudo.content !== "none" &&
        tboxPseudo.content !== "normal" &&
        tboxPseudo.display !== "none" &&
        tboxPseudo.visibility !== "hidden",
      );
      const pw = hasTboxBox ? parsePx(tboxPseudo.width) * elZoomX : 0;
      const ph = hasTboxBox ? parsePx(tboxPseudo.height) * elZoomY : 0;
      const padL = rect.left + parsePx(cs.borderLeftWidth) * elZoomX;
      const padR = rect.right - parsePx(cs.borderRightWidth) * elZoomX;
      const padT = rect.top + parsePx(cs.borderTopWidth) * elZoomY;
      const padB = rect.bottom - parsePx(cs.borderBottomWidth) * elZoomY;
      const cL = padL + parsePx(cs.paddingLeft) * elZoomX;
      const cR = padR - parsePx(cs.paddingRight) * elZoomX;
      const cT = padT + parsePx(cs.paddingTop) * elZoomY;
      const cB = padB - parsePx(cs.paddingBottom) * elZoomY;
      let pCx = cL + pw / 2;
      let pCy = cT + ph / 2;
      const alignAxis = (alignVal, lo, hi, sz) => {
        if (alignVal.includes("center")) return (lo + hi) / 2;
        if (alignVal.includes("end") || alignVal.includes("right") || alignVal.includes("bottom")) return hi - sz / 2;
        return lo + sz / 2;
      };
      if (tboxPseudo.position === "absolute") {
        const pL = tboxPseudo.left !== "auto" ? padL + parsePx(tboxPseudo.left) * elZoomX : (tboxPseudo.right !== "auto" ? padR - parsePx(tboxPseudo.right) * elZoomX - pw : padL);
        const pT = tboxPseudo.top !== "auto" ? padT + parsePx(tboxPseudo.top) * elZoomY : (tboxPseudo.bottom !== "auto" ? padB - parsePx(tboxPseudo.bottom) * elZoomY - ph : padT);
        pCx = pL + pw / 2;
        pCy = pT + ph / 2;
      } else if (cs.display.includes("grid")) {
        const jItem = cs.justifyItems && !["normal", "legacy", "stretch"].includes(cs.justifyItems) ? cs.justifyItems : cs.justifyContent;
        const aItem = cs.alignItems && !["normal", "stretch"].includes(cs.alignItems) ? cs.alignItems : cs.alignContent;
        pCx = alignAxis(jItem, cL, cR, pw);
        pCy = alignAxis(aItem, cT, cB, ph);
      } else if (cs.display.includes("flex")) {
        const isCol = cs.flexDirection.startsWith("column");
        pCx = alignAxis(isCol ? cs.alignItems : cs.justifyContent, cL, cR, pw);
        pCy = alignAxis(isCol ? cs.justifyContent : cs.alignItems, cT, cB, ph);
      }
      iconButtons.push({
        id: el.id || String(el.className || "").trim() || "tbox",
        btnW: +rect.width.toFixed(2),
        btnH: +rect.height.toFixed(2),
        hitW,
        hitH,
        svgW: +pw.toFixed(2),
        svgH: +ph.toFixed(2),
        dx: +(pCx - ((rect.left + rect.right) / 2)).toFixed(2),
        dy: +(pCy - ((rect.top + rect.bottom) / 2)).toFixed(2),
        isTbox: el.classList.contains("tbox"),
        segmented: false,
      });
      continue;
    }

    const svgs = [...el.querySelectorAll("svg")].filter((s) => {
      const scs = getComputedStyle(s);
      return scs.display !== "none" && scs.visibility !== "hidden" && s.getBoundingClientRect().width > 0;
    });
    let visibleText = "";
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let tn;
    while ((tn = tw.nextNode())) {
      const p = tn.parentElement;
      if (!p || p.closest("svg, .sr-only")) continue;
      if (getComputedStyle(p).display !== "none") visibleText += tn.textContent;
    }
    const hasCssCaret = [...el.querySelectorAll(".send-tri, .rail-sec-tri")].some((c) => {
      const ccs = getComputedStyle(c);
      return ccs.display !== "none" && c.getBoundingClientRect().width > 0;
    });
    const iconOnly = svgs.length === 1 && visibleText.trim() === "" && !hasCssCaret;
    if (!iconOnly) continue;

    const sRect = svgs[0].getBoundingClientRect();
    const dx = +(((sRect.left + sRect.right) / 2) - ((rect.left + rect.right) / 2)).toFixed(2);
    const dy = +(((sRect.top + sRect.bottom) / 2) - ((rect.top + rect.bottom) / 2)).toFixed(2);
    iconButtons.push({
      id: el.id || String(el.className || "").trim() || "button",
      btnW: +rect.width.toFixed(2),
      btnH: +rect.height.toFixed(2),
      hitW,
      hitH,
      svgW: +sRect.width.toFixed(2),
      svgH: +sRect.height.toFixed(2),
      dx,
      dy,
      isTbox: el.classList.contains("tbox"),
      segmented: Boolean(el.closest(".qbtn-split, .send-split, .pbv-copy-group, .view-toggle, .exp-scope, .xp-act-group, .vocab-group-unit, .md-strip, .export-fmt")),
    });
  }

  // Probe A: Residual circular / pill controls (border-radius >= 8px on non-radio controls)
  const pillLeaks = [];
  for (const el of document.querySelectorAll(
    'button, [role="button"], [role="switch"], input:not([type="radio"], [type="checkbox"]), select, .switch-ui, .pbv-play, .tag-item, .vocab-group-chip, .token-badge'
  )) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const maxR = Math.max(
      parsePx(cs.borderTopLeftRadius),
      parsePx(cs.borderTopRightRadius),
      parsePx(cs.borderBottomRightRadius),
      parsePx(cs.borderBottomLeftRadius),
    );
    if (maxR >= 8) {
      pillLeaks.push({ id: el.id || String(el.className || "").trim() || el.tagName.toLowerCase(), maxR: +maxR.toFixed(1) });
    }
  }

  // Probe A2: Visible checkboxes & .pick-box > .pick-mark must be 0px sharp squares
  const roundedCheckboxes = [];
  for (const el of document.querySelectorAll('.bottom-bar input[type="checkbox"], .reader-check > input[type="checkbox"], .pick-box > .pick-mark')) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const maxR = Math.max(
      parsePx(cs.borderTopLeftRadius),
      parsePx(cs.borderTopRightRadius),
      parsePx(cs.borderBottomRightRadius),
      parsePx(cs.borderBottomLeftRadius),
    );
    if (maxR > 0) {
      roundedCheckboxes.push({ id: el.id || String(el.className || "").trim(), maxR });
    }
  }

  // Probe B: Framed tables must have 0px corners, >=1px border, and >=6px horizontal cell padding
  const tableIssues = [];
  for (const tbl of document.querySelectorAll("table")) {
    const tcs = getComputedStyle(tbl);
    if (tcs.display === "none" || tcs.visibility === "hidden") continue;
    const tr = tbl.getBoundingClientRect();
    if (tr.width <= 0 || tr.height <= 0) continue;
    const cells = [...tbl.querySelectorAll("th, td")].filter((c) => {
      const ccs = getComputedStyle(c);
      return ccs.display !== "none" && ccs.visibility !== "hidden" && c.getBoundingClientRect().width > 0;
    });
    const framed = parsePx(tcs.borderTopWidth) > 0 || cells.some((c) => parsePx(getComputedStyle(c).borderBottomWidth) > 0);
    if (!framed) continue;
    if (parsePx(tcs.borderTopLeftRadius) > 0) {
      tableIssues.push(`table border-radius=${tcs.borderTopLeftRadius} (expected 0px)`);
    }
    if (cells.length > 0 && tbl.scrollWidth <= tbl.clientWidth + 1) {
      const maxCellRight = Math.max(...cells.map((c) => c.getBoundingClientRect().right));
      if (tr.right - maxCellRight > 2) {
        tableIssues.push(`table outer frame overhangs rightmost cell by ${(tr.right - maxCellRight).toFixed(1)}px`);
      }
    }
    for (const c of cells) {
      if (!(c.textContent || "").trim()) continue;
      const ccs = getComputedStyle(c);
      const pl = parsePx(ccs.paddingLeft);
      const pr = parsePx(ccs.paddingRight);
      if (pl < 6 || pr < 6) {
        tableIssues.push(`<${c.tagName.toLowerCase()}> "${c.textContent.trim().slice(0, 20)}" padding=${pl}px/${pr}px < 6px`);
      }
    }
  }

  // Probe C: Zero 3D <kbd> chrome or collisions inside interactive buttons / menuitems
  const kbdIssues = [];
  for (const el of document.querySelectorAll('button, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const br = el.getBoundingClientRect();
    if (br.width <= 0 || br.height <= 0) continue;
    for (const k of el.querySelectorAll("kbd")) {
      const kcs = getComputedStyle(k);
      if (kcs.display === "none" || kcs.visibility === "hidden") continue;
      const kr = k.getBoundingClientRect();
      if (kr.width <= 0 || kr.height <= 0) continue;
      if (parsePx(kcs.borderTopWidth) > 0 || (kcs.boxShadow && kcs.boxShadow !== "none")) {
        kbdIssues.push(`${el.id || el.className}: 3D <kbd> inside control`);
      }
      if (kr.right > br.right + 1 || kr.left < br.left - 1) {
        kbdIssues.push(`${el.id || el.className}: <kbd> overflows control`);
      }
    }
  }

  const bodyRgb = parseRgb(getComputedStyle(document.body).backgroundColor);
  const overflowX = Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth);
  return { iconButtons, pillLeaks, roundedCheckboxes, tableIssues, kbdIssues, bodyRgb, overflowX };
};

const fail = [];
let checks = 0;
const record = (ok, msg) => {
  checks++;
  if (!ok) fail.push(msg);
};

function validateCommonProbe(tag, probe) {
  record(probe.overflowX <= 1, `${tag}: horizontal overflow (+${probe.overflowX}px)`);
  record(
    Array.isArray(probe.bodyRgb) && probe.bodyRgb[0] === probe.bodyRgb[1] && probe.bodyRgb[1] === probe.bodyRgb[2],
    `${tag}: body background is not neutral R=G=B (${JSON.stringify(probe.bodyRgb)})`,
  );
  record(probe.pillLeaks.length === 0, `${tag}: residual pill/circle controls >=8px: ${JSON.stringify(probe.pillLeaks)}`);
  record(probe.roundedCheckboxes.length === 0, `${tag}: non-0px checkboxes: ${JSON.stringify(probe.roundedCheckboxes)}`);
  record(probe.tableIssues.length === 0, `${tag}: framed table geometry issues: ${JSON.stringify(probe.tableIssues)}`);
  record(probe.kbdIssues.length === 0, `${tag}: <kbd>-in-button issues: ${JSON.stringify(probe.kbdIssues)}`);
  record(probe.iconButtons.length > 0, `${tag}: expected at least 1 visible icon-only button`);
  for (const b of probe.iconButtons) {
    const minW = b.isTbox ? 18 : 24;
    const minH = b.isTbox ? 22 : 24;
    record(b.hitW >= minW && b.hitH >= minH, `${tag} [${b.id}]: effective hit box ${b.hitW}x${b.hitH}px < ${minW}x${minH}px`);
    record(Math.abs(b.dx) <= 0.6 && Math.abs(b.dy) <= 0.6, `${tag} [${b.id}]: icon off-center dx=${b.dx}px dy=${b.dy}px in ${b.btnW}x${b.btnH}`);
    record(b.svgW >= 8 && b.svgH >= 8 && Math.abs(b.svgW - b.svgH) <= 1.5, `${tag} [${b.id}]: deformed SVG ${b.svgW}x${b.svgH}`);
    if (!b.segmented) {
      record(Math.abs(b.btnW - b.btnH) <= 4, `${tag} [${b.id}]: standalone icon button non-square ${b.btnW}x${b.btnH}`);
    }
  }
}

if (SHOTS_DIR) mkdirSync(SHOTS_DIR, { recursive: true });

const browser = await chromium.launch({
  env: FONTCONFIG_ISOLATION ? FONTCONFIG_ISOLATION.env : process.env,
});

try {
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const rel = url.pathname.replace(/^\/+/, "");
    if (rel.endsWith(".js")) {
      return route.fulfill({ status: 200, contentType: MIME_BY_EXT[".js"], body: "" });
    }
    const abs = resolve(ROOT, rel);
    if (!abs.startsWith(`${ROOT}/`) || !existsSync(abs)) {
      return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
    }
    const ext = extname(abs);
    return route.fulfill({
      status: 200,
      contentType: MIME_BY_EXT[ext] || "application/octet-stream",
      body: readFileSync(abs),
    });
  });

  const page = await context.newPage();

  const relLum = ([r, g, b]) => {
    const lin = (c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const rgbContrast = (aStr, bStr) => {
    const parse = (s) => (String(s || "").match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
    const l1 = relLum(parse(aStr)), l2 = relLum(parse(bStr));
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const measureRightCapClearance = async (locator, capPx, bevelPx) => {
    const png = await locator.screenshot();
    return page.evaluate(async ([b64, capCssPx, bevelCssPx]) => {
      const dpr = window.devicePixelRatio || 1;
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      const borderDev = Math.round(1 * dpr);
      const bevelDev = Math.round(bevelCssPx * dpr);
      const grooveWidthDev = Math.round(2 * dpr);
      const capStartX = img.width - borderDev - Math.round(capCssPx * dpr) + grooveWidthDev;
      const capEndX = img.width - borderDev - bevelDev;
      // Background reference sample at vertical midpoint inside left clearance
      const midY = Math.floor(img.height / 2);
      const bgIdx = (midY * img.width + capStartX + 1) * 4;
      const bgR = data[bgIdx], bgG = data[bgIdx + 1], bgB = data[bgIdx + 2];
      const isInk = (x, y) => {
        const idx = (y * img.width + x) * 4;
        return Math.abs(data[idx] - bgR) + Math.abs(data[idx + 1] - bgG) + Math.abs(data[idx + 2] - bgB) > 90;
      };
      let bestW = 0, bestLeft = 0, bestRight = 0;
      const y0 = Math.round(3 * dpr), y1 = img.height - Math.round(3 * dpr);
      for (let y = y0; y < y1; y++) {
        let minX = Infinity, maxX = -1;
        for (let x = capStartX; x < capEndX; x++) {
          if (isInk(x, y)) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
        if (maxX >= minX) {
          const w = maxX - minX + 1;
          if (w > bestW) {
            bestW = w;
            bestLeft = minX - capStartX;
            bestRight = capEndX - 1 - maxX;
          }
        }
      }
      return { leftClear: bestLeft, arrowW: bestW, rightClear: bestRight };
    }, [png.toString("base64"), capPx, bevelPx]);
  };

  // ---- 0. Negative-control self-test for RESIDUAL_AND_GEOMETRY_PROBE ----
  await page.setContent(`<!doctype html><html><head><style>
    body { margin: 20px; background: #ccc; }
    button { box-sizing: border-box; position: relative; width: 20px; height: 20px; padding: 0; border: 1px solid #262626; display: inline-grid; place-items: center; }
    button svg { width: 12px; height: 12px; }
    #neg-pe-none::before { content: ""; box-sizing: border-box; position: absolute; inset: -3px; pointer-events: none; }
    #clip-wrap { width: 20px; height: 20px; overflow: hidden; display: inline-block; }
    #neg-clipped::before { content: ""; box-sizing: border-box; position: absolute; inset: -3px; }
    #pos-centered::before { content: ""; box-sizing: border-box; position: absolute; left: calc(50% - 12px); top: calc(50% - 12px); width: 24px; height: 24px; }
    #zoom-down { zoom: 0.75; display: inline-block; }
    #neg-zoom75::before { content: ""; box-sizing: border-box; position: absolute; left: calc(50% - 12px); top: calc(50% - 12px); width: 24px; height: 24px; }
    #zoom-up { zoom: 1.12; display: inline-block; }
    #pos-zoom112::before { content: ""; box-sizing: border-box; position: absolute; left: calc(50% - 11px); top: calc(50% - 11px); width: 22px; height: 22px; }
    #ask-close { display: inline-flex; align-items: center; justify-content: flex-start; border: 0; }
    #ask-close::after { content: ""; box-sizing: border-box; display: block; width: 13px; height: 13px; background: #444; }
    #neg-tbox-none::after { content: none; width: 13px; height: 13px; }
    #neg-grid-end { width: 24px; height: 24px; display: inline-grid; align-items: center; justify-items: end; border: 0; }
    #neg-grid-end::after { content: ""; box-sizing: border-box; display: block; width: 13px; height: 13px; background: #444; }
    #neg-tbox-zoom::after { content: ""; box-sizing: border-box; display: block; width: 10px; height: 10px; background: #444; }
  </style></head><body>
    <button id="neg-pe-none"><svg viewBox="0 0 12 12"><rect width="12" height="12"/></svg></button>
    <div id="clip-wrap"><button id="neg-clipped"><svg viewBox="0 0 12 12"><rect width="12" height="12"/></svg></button></div>
    <button id="pos-centered"><svg viewBox="0 0 12 12"><rect width="12" height="12"/></svg></button>
    <div id="zoom-down"><button id="neg-zoom75"><svg viewBox="0 0 12 12"><rect width="12" height="12"/></svg></button><button id="neg-tbox-zoom" class="fc-dismiss"></button></div>
    <div id="zoom-up"><button id="pos-zoom112"><svg viewBox="0 0 12 12"><rect width="12" height="12"/></svg></button></div>
    <button id="ask-close"></button>
    <button id="neg-tbox-none" class="fc-dismiss"></button>
    <button id="neg-grid-end" class="fc-dismiss"></button>
  </body></html>`);
  const negSelfTest = await page.evaluate(RESIDUAL_AND_GEOMETRY_PROBE);
  const byId = new Map(negSelfTest.iconButtons.map((b) => [b.id, b]));
  record(
    byId.get("neg-pe-none")?.hitW === 20 &&
    byId.get("neg-clipped")?.hitW === 20 &&
    byId.get("pos-centered")?.hitW === 24 &&
    byId.get("pos-centered")?.hitH === 24 &&
    byId.get("neg-zoom75")?.hitW === 18 &&
    byId.get("pos-zoom112")?.hitW >= 24.5 &&
    Math.abs(byId.get("ask-close")?.dx ?? 0) >= 3 &&
    byId.get("neg-tbox-none")?.svgW === 0 &&
    Math.abs(byId.get("neg-grid-end")?.dx ?? 0) >= 4 &&
    byId.get("neg-tbox-zoom")?.svgW === 7.5,
    `probe negative-control self-test regressed: ${JSON.stringify(negSelfTest.iconButtons)}`,
  );

  for (const mode of ["light", "dark"]) {
    const themeAttr = `platinum-${mode}`;
    const wantPressedBg = mode === "dark" ? "rgb(22, 22, 22)" : "rgb(102, 102, 102)";
    const wantSelBg = mode === "dark" ? "rgb(224, 224, 224)" : "rgb(51, 51, 51)";
    const wantPreBg = mode === "dark" ? "rgb(22, 22, 22)" : "rgb(245, 245, 245)";
    const wantDisSurfaceBg = mode === "dark" ? "rgb(44, 44, 44)" : "rgb(204, 204, 204)";
    const wantDisFieldBg = mode === "dark" ? "rgb(59, 59, 59)" : "rgb(221, 221, 221)";
    const wantFocusHex = mode === "dark" ? [142, 192, 255] : [29, 68, 150];

    // ---- 1. Popup (460x680) ----
    await page.emulateMedia({ colorScheme: mode });
    await page.setViewportSize({ width: 460, height: 680 });
    await page.goto(`${ORIGIN}/popup.html`, { waitUntil: "load" });
    const popupExtra = await page.evaluate(({ themeAttr, icons }) => {
      document.documentElement.setAttribute("data-theme", themeAttr);
      document.querySelectorAll(".btn-ic[data-ic]").forEach((s) => { s.innerHTML = icons[s.dataset.ic] || ""; });
      document.getElementById("main-section").classList.remove("hidden");
      document.getElementById("user-info").textContent = "pine2d";
      document.getElementById("url-input").value = "https://pinboard.in/u:pine2d";
      document.getElementById("title-input").value = "Mac OS 9 Appearance Manager — Platinum UI";
      document.getElementById("description-input").value = "Zero-purple R=G=B metallic chassis with slate-blue links and 4-ridge scrollbars.";
      const tagsDisplay = document.getElementById("tags-display");
      tagsDisplay.innerHTML = `<span class="tag-item">design-system<button type="button" class="tag-remove" aria-label="Remove">${icons.cross}</button></span><span class="tag-item">macos9<button type="button" class="tag-remove" aria-label="Remove">${icons.cross}</button></span>`;
      for (const id of ["tags-copy-all", "tags-clear-all", "delete-btn", "md-actions-strip"]) {
        document.getElementById(id)?.classList.remove("hidden");
      }
      document.getElementById("ocr-import-btn")?.removeAttribute("hidden");
      const priv = document.getElementById("private-check");
      const rl = document.getElementById("readlater-check");
      const arch = document.getElementById("archive-check");
      priv.disabled = false; priv.checked = true;
      rl.disabled = false; rl.indeterminate = true;
      arch.disabled = false;
      const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
      return {
        privBg: getComputedStyle(priv).backgroundColor,
        rlBg: getComputedStyle(rl).backgroundColor,
        rlDash: Math.round((parseFloat(getComputedStyle(rl, "::after").borderTopWidth) || 0) * zoom),
      };
    }, { themeAttr, icons: PBP_ICONS });
    await page.evaluate(() => document.fonts.ready);
    const popupProbe = await page.evaluate(RESIDUAL_AND_GEOMETRY_PROBE);
    validateCommonProbe(`popup/${mode}`, popupProbe);
    record(
      popupExtra.privBg === wantPressedBg && popupExtra.rlBg === wantPressedBg && popupExtra.rlDash === 2,
      `popup/${mode}: checkbox checked/indeterminate state mismatch: ${JSON.stringify(popupExtra)}`,
    );
    if (SHOTS_DIR) await page.screenshot({ path: resolve(SHOTS_DIR, `popup-${mode}.png`) });

    // Verify Popup .fc-dismiss .tbox centering & real-color flat disabled checkbox/submit
    const popupDisAndTbox = await page.evaluate(() => {
      document.getElementById("ai-error-card")?.classList.remove("hidden");
      const arch = document.getElementById("archive-check");
      arch.checked = true;
      arch.disabled = true;
      const sub = document.getElementById("submit-btn");
      sub.disabled = true;
      const archCs = getComputedStyle(arch);
      const subCs = getComputedStyle(sub);
      return {
        archOp: archCs.opacity,
        archBg: archCs.backgroundColor,
        archMark: getComputedStyle(arch, "::after").borderBottomColor,
        archShadow: archCs.boxShadow,
        subOp: subCs.opacity,
        subBg: subCs.backgroundColor,
        subFg: subCs.color,
        subShadow: subCs.boxShadow,
      };
    });
    const popupTboxProbe = await page.evaluate(RESIDUAL_AND_GEOMETRY_PROBE);
    const fcDismissItem = popupTboxProbe.iconButtons.find((b) => b.id === "ai-error-dismiss" || b.id.includes("fc-dismiss"));
    record(
      Boolean(fcDismissItem) && fcDismissItem.hitW >= 24 && fcDismissItem.hitH >= 24 && Math.abs(fcDismissItem.dx) <= 0.6 && Math.abs(fcDismissItem.dy) <= 0.6,
      `popup/${mode}: .fc-dismiss .tbox geometry failed: ${JSON.stringify(fcDismissItem)}`,
    );
    record(
      popupDisAndTbox.archOp === "1" &&
      popupDisAndTbox.archBg === wantDisSurfaceBg &&
      popupDisAndTbox.archShadow === "none" &&
      rgbContrast(popupDisAndTbox.archMark, popupDisAndTbox.archBg) >= 4.5 &&
      popupDisAndTbox.subOp === "1" &&
      popupDisAndTbox.subBg === wantDisSurfaceBg &&
      popupDisAndTbox.subShadow === "none" &&
      rgbContrast(popupDisAndTbox.subFg, popupDisAndTbox.subBg) >= 4.5,
      `popup/${mode}: real-color flat disabled contract failed: ${JSON.stringify(popupDisAndTbox)}`,
    );

    // ---- 2. Options (1120x820 — General key-toggle + Appearance preset/select/switches) ----
    await page.setViewportSize({ width: 1120, height: 820 });
    await page.goto(`${ORIGIN}/options.html`, { waitUntil: "load" });
    await page.evaluate(({ themeAttr, icons }) => {
      document.documentElement.setAttribute("data-theme", themeAttr);
      document.documentElement.setAttribute("data-options-ready", "");
      document.querySelectorAll(".btn-ic[data-ic]").forEach((s) => { s.innerHTML = icons[s.dataset.ic] || ""; });
      document.querySelectorAll(".context-help-toggle .btn-ic").forEach((s) => { s.innerHTML = icons.help || ""; });
      document.querySelectorAll(".key-toggle").forEach((b) => { b.innerHTML = icons.eye || ""; });
    }, { themeAttr, icons: PBP_ICONS });
    await page.evaluate(() => document.fonts.ready);
    const optionsGeneralProbe = await page.evaluate(RESIDUAL_AND_GEOMETRY_PROBE);
    validateCommonProbe(`options-general/${mode}`, optionsGeneralProbe);
    const optionsExtra = await page.evaluate(() => {
      document.querySelectorAll(".tab-btn").forEach((b) => {
        const isApp = b.dataset.panel === "appearance";
        b.classList.toggle("active", isApp);
        b.setAttribute("aria-selected", String(isApp));
      });
      document.querySelectorAll(".panel").forEach((p) => {
        p.classList.toggle("active", p.id === "panel-appearance");
      });
      const ptPreset = document.querySelector('.theme-preset-btn[data-theme="platinum"]');
      if (ptPreset) {
        ptPreset.classList.add("active");
        ptPreset.setAttribute("aria-pressed", "true");
      }
      const panelBefore = getComputedStyle(document.querySelector(".panel.active"), "::before");
      const activeTab = document.querySelector(".tab-btn.active");
      return {
        pinstripeSize: panelBefore.backgroundSize,
        activeTabBg: activeTab ? getComputedStyle(activeTab).backgroundColor : "",
      };
    });
    const optionsAppProbe = await page.evaluate(RESIDUAL_AND_GEOMETRY_PROBE);
    record(
      optionsAppProbe.pillLeaks.length === 0 && optionsAppProbe.roundedCheckboxes.length === 0 && optionsAppProbe.overflowX <= 1,
      `options-appearance/${mode}: residual pill/overflow failure: ${JSON.stringify(optionsAppProbe)}`,
    );
    record(
      optionsExtra.pinstripeSize.includes("12px") && optionsExtra.activeTabBg === wantSelBg,
      `options/${mode}: pinstripe or Gray active tab mismatch: ${JSON.stringify(optionsExtra)}`,
    );
    if (SHOTS_DIR) await page.screenshot({ path: resolve(SHOTS_DIR, `options-${mode}.png`) });

    // Verify Options 4px-7px-4px (8/14/8 at 2x) arrow symmetry, multi-select guard, & real-color disabled contract
    const optControlsAudit = await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "pt-opt-audit";
      host.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:8px 0;";
      host.innerHTML = `
        <select id="pt-native-sel" style="width:140px"><option>Platinum Gray</option></select>
        <button type="button" id="pt-lb-btn" class="listbox-btn" style="width:140px"><span class="listbox-value">Platinum</span><span class="btn-ic"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></span></button>
        <label class="pick pick-box"><input type="checkbox" id="pt-pick-chk-dis" checked disabled><span class="pick-mark"></span><span class="pick-text">Disabled Checked</span></label>
        <label class="pick pick-box"><input type="checkbox" id="pt-pick-ind-dis" disabled><span class="pick-mark"></span><span class="pick-text">Disabled Indet</span></label>
        <button type="button" id="pt-btn-pressed-dis" class="btn" aria-pressed="true" aria-disabled="true">Pressed Dis</button>
        <button type="button" id="pt-lb-dis" class="listbox-btn" disabled style="width:120px"><span class="listbox-value">Dis LB</span><span class="btn-ic"></span></button>
        <select id="pt-sel-dis" disabled style="width:120px"><option>Dis Sel</option></select>
        <div class="fg"><input type="text" id="pt-inp-dis" value="Disabled" disabled></div>
        <select id="pt-multi-sel" multiple size="3"><option selected>Row 1</option><option>Row 2</option></select>
        <select id="pt-zero-sel" size="0"><option>Zero</option></select>
        <div id="pt-queued-row" class="tag-gov-row-queued">
          <label class="tag-gov-chip"><input type="radio" id="pt-tg-dis-chk" checked disabled><span class="tag-gov-chip-face"><span>tag-a</span></span></label>
          <label class="tag-gov-chip"><input type="radio" id="pt-tg-dis-unc" disabled><span class="tag-gov-chip-face"><span>tag-b</span></span></label>
        </div>
      `;
      document.querySelector(".panel.active").appendChild(host);
      document.getElementById("pt-pick-ind-dis").indeterminate = true;

      const chkMark = document.querySelector("#pt-pick-chk-dis ~ .pick-mark");
      const indMark = document.querySelector("#pt-pick-ind-dis ~ .pick-mark");
      const btnDis = document.getElementById("pt-btn-pressed-dis");
      const lbDis = document.getElementById("pt-lb-dis");
      const selDis = document.getElementById("pt-sel-dis");
      const inpDis = document.getElementById("pt-inp-dis");
      const multiSel = document.getElementById("pt-multi-sel");
      const zeroSel = document.getElementById("pt-zero-sel");
      const queuedRowCs = getComputedStyle(document.getElementById("pt-queued-row"));
      const tgChkFaceCs = getComputedStyle(document.querySelector("#pt-tg-dis-chk + .tag-gov-chip-face"));
      const tgUncFaceCs = getComputedStyle(document.querySelector("#pt-tg-dis-unc + .tag-gov-chip-face"));

      const chkCs = getComputedStyle(chkMark);
      const indCs = getComputedStyle(indMark);
      const btnCs = getComputedStyle(btnDis);
      const lbCs = getComputedStyle(lbDis);
      const selCs = getComputedStyle(selDis);
      const inpCs = getComputedStyle(inpDis);
      const multiCs = getComputedStyle(multiSel);
      const zeroCs = getComputedStyle(zeroSel);
      return {
        chkOp: chkCs.opacity, chkBg: chkCs.backgroundColor, chkFg: chkCs.color, chkShadow: chkCs.boxShadow,
        indOp: indCs.opacity, indBg: indCs.backgroundColor, indFg: indCs.color, indShadow: indCs.boxShadow,
        btnOp: btnCs.opacity, btnBg: btnCs.backgroundColor, btnFg: btnCs.color, btnShadow: btnCs.boxShadow,
        lbOp: lbCs.opacity, lbBg: lbCs.backgroundColor, lbFg: lbCs.color, lbShadow: lbCs.boxShadow,
        selOp: selCs.opacity, selBg: selCs.backgroundColor, selFg: selCs.color, selShadow: selCs.boxShadow,
        inpOp: inpCs.opacity, inpBg: inpCs.backgroundColor, inpFg: inpCs.color, inpShadow: inpCs.boxShadow,
        multiApp: multiCs.appearance, multiBgImg: multiCs.backgroundImage,
        zeroApp: zeroCs.appearance, zeroShadow: zeroCs.boxShadow,
        queuedOp: queuedRowCs.opacity,
        tgChkBg: tgChkFaceCs.backgroundColor, tgChkFg: tgChkFaceCs.color, tgChkShadow: tgChkFaceCs.boxShadow,
        tgUncBg: tgUncFaceCs.backgroundColor, tgUncFg: tgUncFaceCs.color, tgUncShadow: tgUncFaceCs.boxShadow,
      };
    });
    const nativeArrowSym = await measureRightCapClearance(page.locator("#pt-native-sel"), 19, 2);
    const listboxArrowSym = await measureRightCapClearance(page.locator("#pt-lb-btn"), 19, 2);
    await page.evaluate(() => document.getElementById("pt-opt-audit")?.remove());
    record(
      nativeArrowSym.leftClear === 8 && nativeArrowSym.arrowW === 14 && nativeArrowSym.rightClear === 8 &&
      listboxArrowSym.leftClear === 8 && listboxArrowSym.arrowW === 14 && listboxArrowSym.rightClear === 8,
      `options/${mode}: 2x DPR arrow cap symmetry expected 8/14/8, got native=${JSON.stringify(nativeArrowSym)} listbox=${JSON.stringify(listboxArrowSym)}`,
    );
    record(
      optControlsAudit.chkOp === "1" && optControlsAudit.chkBg === wantDisSurfaceBg && optControlsAudit.chkShadow === "none" &&
      rgbContrast(optControlsAudit.chkFg, optControlsAudit.chkBg) >= 4.5 &&
      optControlsAudit.indOp === "1" && optControlsAudit.indBg === wantDisSurfaceBg && optControlsAudit.indShadow === "none" &&
      rgbContrast(optControlsAudit.indFg, optControlsAudit.indBg) >= 4.5 &&
      optControlsAudit.btnOp === "1" && optControlsAudit.btnBg === wantDisSurfaceBg && optControlsAudit.btnShadow === "none" &&
      rgbContrast(optControlsAudit.btnFg, optControlsAudit.btnBg) >= 4.5 &&
      optControlsAudit.lbOp === "1" && optControlsAudit.lbBg === wantDisSurfaceBg && optControlsAudit.lbShadow === "none" &&
      optControlsAudit.selOp === "1" && optControlsAudit.selBg === wantDisSurfaceBg && optControlsAudit.selShadow === "none" &&
      optControlsAudit.inpOp === "1" && optControlsAudit.inpBg === wantDisFieldBg && optControlsAudit.inpShadow === "none" &&
      rgbContrast(optControlsAudit.inpFg, optControlsAudit.inpBg) >= 4.5 &&
      optControlsAudit.multiApp !== "base-select" && optControlsAudit.multiBgImg === "none" &&
      optControlsAudit.zeroApp === "base-select" && optControlsAudit.zeroShadow !== "none" &&
      optControlsAudit.queuedOp === "1" &&
      optControlsAudit.tgChkBg === wantDisSurfaceBg && optControlsAudit.tgChkShadow === "none" &&
      rgbContrast(optControlsAudit.tgChkFg, optControlsAudit.tgChkBg) >= 4.5 &&
      optControlsAudit.tgUncBg === wantDisSurfaceBg && optControlsAudit.tgUncShadow === "none" &&
      rgbContrast(optControlsAudit.tgUncFg, optControlsAudit.tgUncBg) >= 4.5,
      `options/${mode}: disabled contract or select boundary guard failed: ${JSON.stringify(optControlsAudit)}`,
    );

    // Narrow Options (600x820): #mobile-tab-select zero mousedown->open jump, <optgroup> AA, disabled <option> guard
    await page.setViewportSize({ width: 600, height: 820 });
    await page.evaluate(() => {
      const sel = document.getElementById("mobile-tab-select");
      const disOpt = document.createElement("option");
      disOpt.id = "pt-dis-opt";
      disOpt.disabled = true;
      disOpt.textContent = "Unavailable";
      sel.appendChild(disOpt);
    });
    const mobSelLoc = page.locator("#mobile-tab-select");
    await mobSelLoc.scrollIntoViewIfNeeded();
    const mobBox = await mobSelLoc.boundingBox();
    const mobClip = {
      x: Math.floor(mobBox.x),
      y: Math.floor(mobBox.y),
      width: Math.ceil(mobBox.width),
      height: Math.ceil(mobBox.height),
    };
    await page.mouse.move(mobBox.x + 24, mobBox.y + mobBox.height / 2);
    await page.mouse.down();
    const heldActivePng = await page.screenshot({ clip: mobClip });
    await page.mouse.up();
    if (!(await page.evaluate(() => document.getElementById("mobile-tab-select").matches(":open")))) {
      await mobSelLoc.click();
    }
    const releasedOpenPng = await page.screenshot({ clip: mobClip });
    const mobPickerAudit = await page.evaluate(() => {
      const sel = document.getElementById("mobile-tab-select");
      const og = sel.querySelector("optgroup");
      const disOpt = document.getElementById("pt-dis-opt");
      return {
        isOpen: sel.matches(":open"),
        pickerBg: getComputedStyle(sel, "::picker(select)").backgroundColor,
        ogFg: getComputedStyle(og).color,
        disOptBg: getComputedStyle(disOpt).backgroundColor,
        disOptFg: getComputedStyle(disOpt).color,
      };
    });
    await page.keyboard.press("Escape");
    record(
      mobPickerAudit.isOpen &&
      Buffer.compare(heldActivePng, releasedOpenPng) === 0 &&
      rgbContrast(mobPickerAudit.ogFg, mobPickerAudit.pickerBg) >= 4.5 &&
      mobPickerAudit.disOptBg === "rgba(0, 0, 0, 0)" &&
      rgbContrast(mobPickerAudit.disOptFg, mobPickerAudit.pickerBg) >= 4.5,
      `options-narrow/${mode}: #mobile-tab-select active->open continuity or optgroup/disabled option failed: ${JSON.stringify(mobPickerAudit)}`,
    );

    // ---- 3. Library (1200x820 — Ask view with framed table & code well + active row) ----
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto(`${ORIGIN}/library.html`, { waitUntil: "load" });
    const libraryExtra = await page.evaluate(({ themeAttr, icons }) => {
      document.documentElement.setAttribute("data-theme", themeAttr);
      document.documentElement.setAttribute("data-options-ready", "");
      document.querySelectorAll(".btn-ic[data-ic]").forEach((s) => { s.innerHTML = icons[s.dataset.ic] || ""; });
      document.getElementById("lib-tab-vocab")?.setAttribute("aria-selected", "false");
      document.getElementById("lib-tab-ask")?.setAttribute("aria-selected", "true");
      document.getElementById("view-vocab")?.setAttribute("hidden", "");
      const askView = document.getElementById("view-ask");
      askView?.removeAttribute("hidden");
      const list = document.getElementById("ask-library-list");
      if (list) {
        list.innerHTML = `
          <button type="button" class="ask-library-hit" aria-current="true">
            <span class="ask-library-question">Platinum UI Design System Backport</span>
            <span class="ask-library-stamp">2026-11-22 · 02:35</span>
          </button>
          <button type="button" class="ask-library-hit">
            <span class="ask-library-question">Mac OS 9 Appearance Manager Geometry</span>
            <span class="ask-library-stamp">2026-11-20 · 18:10</span>
          </button>`;
      }
      const pane = document.querySelector(".ask-library-pane");
      if (pane) {
        pane.innerHTML = `
          <div class="ask-library-answer">
            <h2>Platinum Gray Specification Summary</h2>
            <p>All neutral surfaces satisfy exact <code>R = G = B</code> lock with slate-blue links.</p>
            <pre><code>--pt-face: #dddddd;\n--pt-link: #1d4496;</code></pre>
            <table>
              <thead><tr><th>Component</th><th>Geometry</th><th>Palette</th></tr></thead>
              <tbody>
                <tr><td>Scrollbar</td><td>15px / 12px 4-ridge</td><td>Sunken track</td></tr>
                <tr><td>Checkbox</td><td>14x14px 0px square</td><td>Depressed charcoal</td></tr>
              </tbody>
            </table>
          </div>`;
      }
      const currentHit = document.querySelector(".ask-library-hit[aria-current]");
      const currentStamp = document.querySelector(".ask-library-hit[aria-current] .ask-library-stamp");
      const pre = document.querySelector(".ask-library-answer pre");
      const colorMenu = document.createElement("div");
      colorMenu.id = "pt-nc-menu";
      colorMenu.className = "notes-color-menu";
      colorMenu.setAttribute("popover", "manual");
      colorMenu.innerHTML = `
        <button type="button" id="pt-nc-chk" class="notes-color-choice" role="menuitemradio" aria-checked="true" aria-disabled="true"><span class="notes-hit-dot"></span><span>Yellow</span></button>
        <button type="button" id="pt-nc-unc" class="notes-color-choice" role="menuitemradio" aria-checked="false" aria-disabled="true"><span class="notes-hit-dot"></span><span>Green</span></button>`;
      document.body.appendChild(colorMenu);
      colorMenu.showPopover();
      const menuBg = getComputedStyle(colorMenu).backgroundColor;
      const ncChkCs = getComputedStyle(document.getElementById("pt-nc-chk"));
      const ncUncCs = getComputedStyle(document.getElementById("pt-nc-unc"));
      const ncAudit = {
        menuBg,
        chkOp: ncChkCs.opacity, chkBg: ncChkCs.backgroundColor, chkFg: ncChkCs.color,
        uncOp: ncUncCs.opacity, uncBg: ncUncCs.backgroundColor, uncFg: ncUncCs.color,
      };
      return {
        currentHitBg: currentHit ? getComputedStyle(currentHit).backgroundColor : "",
        currentStampFg: currentStamp ? getComputedStyle(currentStamp).color : "",
        preBg: pre ? getComputedStyle(pre).backgroundColor : "",
        ncAudit,
      };
    }, { themeAttr, icons: PBP_ICONS });
    await page.evaluate(() => document.fonts.ready);
    const ncChkUnfocusedPng = await page.locator("#pt-nc-chk").screenshot();
    await page.keyboard.press("Tab");
    await page.evaluate(() => document.getElementById("pt-nc-chk")?.focus());
    const ncChkFocusedPng = await page.locator("#pt-nc-chk").screenshot();
    await page.evaluate(() => document.getElementById("pt-nc-menu")?.remove());
    const libraryProbe = await page.evaluate(RESIDUAL_AND_GEOMETRY_PROBE);
    validateCommonProbe(`library/${mode}`, libraryProbe);
    const wantSelMuted = mode === "dark" ? "rgb(56, 56, 56)" : "rgb(221, 221, 221)";
    record(
      libraryExtra.currentHitBg === wantSelBg &&
      libraryExtra.currentStampFg === wantSelMuted &&
      libraryExtra.preBg === wantPreBg &&
      libraryExtra.ncAudit.chkOp === "1" && libraryExtra.ncAudit.chkBg === "rgba(0, 0, 0, 0)" &&
      rgbContrast(libraryExtra.ncAudit.chkFg, libraryExtra.ncAudit.menuBg) >= 4.5 &&
      libraryExtra.ncAudit.uncOp === "1" && libraryExtra.ncAudit.uncBg === "rgba(0, 0, 0, 0)" &&
      rgbContrast(libraryExtra.ncAudit.uncFg, libraryExtra.ncAudit.menuBg) >= 4.5 &&
      Buffer.compare(ncChkUnfocusedPng, ncChkFocusedPng) !== 0,
      `library/${mode}: Gray active hit/stamp, sunken pre, or disabled notes-color-choice focus/contrast failed: ${JSON.stringify(libraryExtra)}`,
    );
    if (SHOTS_DIR) await page.screenshot({ path: resolve(SHOTS_DIR, `library-${mode}.png`) });

    // ---- 4. Reader / md-preview (1280x860 — prose, framed table, sunken pre, .pbv-play) ----
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto(`${ORIGIN}/md-preview.html`, { waitUntil: "load" });
    const readerExtra = await page.evaluate(({ mode, icons }) => {
      document.documentElement.setAttribute("data-reader-theme", "platinum");
      document.documentElement.style.colorScheme = mode;
      document.getElementById("preview-title").textContent = "Mac OS 9 Platinum Reader";
      document.getElementById("preview-url").textContent = "pine2d.github.io/platinum-ui";
      document.getElementById("reading-stats").textContent = "3 min read";
      document.getElementById("token-count").textContent = "1.2k tok";
      document.getElementById("export-summary").textContent = "Article · Markdown";
      document.getElementById("send-primary-ic").innerHTML = icons.obsidian || "";
      document.getElementById("export-more").open = true;
      document.getElementById("article-title").textContent = "Platinum Appearance Manager Reference";
      document.getElementById("rendered-view").innerHTML = `
        <p>Authentic 1997–2001 Mac OS 9 Platinum desktop chrome with <a href="#spec">deep slate-blue links</a> and crisp <code>1px</code> etched borders.</p>
        <pre><code>html[data-reader-theme="platinum"] {\n  --selection: light-dark(#b8b8b8, #383838);\n}</code><button type="button" class="pb-copy-code" aria-label="Copy code">${icons.copy}<span class="btn-label">Copy</span></button></pre>
        <div class="pb-table-wrap">
          <table>
            <thead><tr><th>Surface</th><th>Scrollbar</th><th>Selection</th></tr></thead>
            <tbody>
              <tr><td>Popup</td><td>12px 4-ridge</td><td>#b8b8b8 / #383838</td></tr>
              <tr><td>Reader</td><td>15px 4-ridge</td><td>Monochrome Gray</td></tr>
            </tbody>
          </table>
        </div>
        <div class="pbv-poster" style="width:280px;height:148px;position:relative;display:flex;align-items:center;justify-content:center;background:#222222;border:1px solid #000;">
          <span class="pbv-play">${icons.play}</span>
        </div>`;
      const play = document.querySelector(".pbv-play");
      const pre = document.querySelector("#rendered-view pre");
      const copyBtn = document.querySelector(".pb-copy-code");
      const wrap = document.querySelector(".pb-table-wrap");
      const docBefore = getComputedStyle(document.querySelector(".doc-body"), "::before");
      const railBefore = getComputedStyle(document.querySelector(".rail"), "::before");
      return {
        playRadius: parseFloat(getComputedStyle(play).borderTopLeftRadius) || 0,
        playShadow: getComputedStyle(play).boxShadow,
        preBg: getComputedStyle(pre).backgroundColor,
        preRadius: parseFloat(getComputedStyle(pre).borderTopLeftRadius) || 0,
        copyOpacity: getComputedStyle(copyBtn).opacity,
        tableAnim: getComputedStyle(wrap).animationName,
        docPinstripe: docBefore.backgroundSize,
        railPinstripe: railBefore.backgroundSize,
      };
    }, { mode, icons: PBP_ICONS });
    await page.evaluate(() => document.fonts.ready);
    const readerProbe = await page.evaluate(RESIDUAL_AND_GEOMETRY_PROBE);
    validateCommonProbe(`md-preview/${mode}`, readerProbe);
    record(
      readerExtra.playRadius === 3 &&
      readerExtra.playShadow !== "none" &&
      readerExtra.preBg === wantPreBg &&
      readerExtra.preRadius === 0 &&
      readerExtra.copyOpacity === "1" &&
      readerExtra.tableAnim === "none" &&
      readerExtra.docPinstripe.includes("12px") &&
      readerExtra.railPinstripe.includes("12px"),
      `md-preview/${mode}: Reader prose/video/pinstripe invariant failed: ${JSON.stringify(readerExtra)}`,
    );
    if (SHOTS_DIR) {
      await page.screenshot({ path: resolve(SHOTS_DIR, `md-preview-${mode}.png`) });
    }

    // Reader interactive regressions:
    // (a) Segmented controls (.source-badge, .view-toggle, #ask-panel .reader-panel-tabs) :focus-visible ring never clips;
    // (b) #explain-pop 20x20 .xp-window-actions have 24x24 zero-overlap hit boxes & zero .xp-resize interception;
    // (c) #rendered-view .empty-state a.action-btn.es-quiet:active >= 4.5:1 & .pbp-img-fix-btn >=6px padding / no underline;
    // (d) Narrow Reader (800x850) #rail-toggle stays fixed on scroll, keeps .tbox centered under body.tr-busy, and centers in .rail-ident.
    await page.evaluate(({ icons }) => {
      document.getElementById("reader-source-details").open = true;
      let askPanel = document.getElementById("ask-panel");
      if (!askPanel) {
        askPanel = document.createElement("aside");
        askPanel.id = "ask-panel";
        document.body.appendChild(askPanel);
      }
      askPanel.hidden = false;
      askPanel.innerHTML = `
        <header class="panel-head">
          <div class="view-toggle reader-panel-tabs" role="tablist">
            <button type="button" id="reader-tab-ask" class="toggle-btn active" role="tab" aria-selected="true" aria-pressed="true">Ask</button>
            <button type="button" id="reader-tab-dict" class="toggle-btn" role="tab" aria-selected="false" aria-pressed="false">Dict</button>
          </div>
          <button type="button" id="ask-close" class="ask-ic" aria-label="Close">${icons.cross || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`}</button>
        </header>`;

      let pop = document.getElementById("explain-pop");
      if (!pop) {
        pop = document.createElement("div");
        pop.id = "explain-pop";
        document.body.appendChild(pop);
      }
      pop.setAttribute("popover", "manual");
      pop.dataset.action = "dict";
      pop.style.left = "320px";
      pop.style.top = "120px";
      pop.style.width = "420px";
      pop.innerHTML = `
        <div class="xp-head">
          <span class="xp-term">Platinum Appearance</span>
          <span class="xp-drag-zone"></span>
          <div class="xp-act-group" role="group">
            <button type="button" class="xp-act" data-action="explain" aria-label="Explain" aria-pressed="false">${icons.messageSquareText || icons.copy}</button>
            <button type="button" class="xp-act" data-action="translate" aria-label="Translate" aria-pressed="false">${icons.translate || icons.copy}</button>
            <button type="button" class="xp-act" data-action="dict" aria-label="Dictionary" aria-pressed="true">${icons.book || icons.copy}</button>
          </div>
          <div class="xp-window-actions">
            <button type="button" class="xp-resize-grip" id="pt-xp-grip" aria-label="Resize">${icons.moveDiagonal || icons.copy}</button>
            <button type="button" class="xp-dock" id="pt-xp-dock" aria-label="Dock">${icons.panelRightOpen || icons.copy}</button>
            <button type="button" class="xp-pin" id="pt-xp-pin" aria-label="Pin">${icons.play}</button>
            <button type="button" class="xp-close" id="pt-xp-close" aria-label="Close">${icons.cross || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`}</button>
          </div>
        </div>
        <div class="xp-body"><p>Dictionary body well.</p></div>
        <div class="xp-resize-hit">
          <span class="xp-resize" data-edge="n"></span>
          <span class="xp-resize" data-edge="e"></span>
          <span class="xp-resize" data-edge="s"></span>
          <span class="xp-resize" data-edge="w"></span>
          <span class="xp-resize" data-edge="nw"></span>
          <span class="xp-resize" data-edge="ne"></span>
          <span class="xp-resize" data-edge="sw"></span>
          <span class="xp-resize" data-edge="se"></span>
        </div>`;
      pop.showPopover();

      document.getElementById("rendered-view").innerHTML += `
        <div class="empty-state"><div class="row"><a href="#orig" id="pt-es-quiet-link" class="action-btn es-quiet">Open original</a></div></div>
        <div class="pbp-img-fix-ui"><span>Blocked</span><button type="button" id="pt-img-fix" class="pbp-img-fix-btn">Fix image</button></div>`;
    }, { icons: PBP_ICONS });

    // Trigger keyboard :focus-visible via Tab -> focus and count focus-color pixels around segmented buttons
    await page.keyboard.press("Tab");
    const countFocusPixels = async (selector) => {
      const loc = page.locator(selector);
      await loc.scrollIntoViewIfNeeded();
      await page.evaluate((sel) => document.querySelector(sel)?.focus({ preventScroll: true }), selector);
      const box = await loc.boundingBox();
      const clipPng = await page.screenshot({
        clip: { x: Math.max(0, Math.floor(box.x) - 5), y: Math.max(0, Math.floor(box.y) - 5), width: Math.ceil(box.width) + 10, height: Math.ceil(box.height) + 10 },
      });
      return page.evaluate(async ([b64, targetRgb]) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, img.width, img.height).data;
        let hits = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (Math.abs(d[i] - targetRgb[0]) <= 12 && Math.abs(d[i + 1] - targetRgb[1]) <= 12 && Math.abs(d[i + 2] - targetRgb[2]) <= 12) hits++;
        }
        return hits;
      }, [clipPng.toString("base64"), wantFocusHex]);
    };
    const segFocusSrc = await countFocusPixels('#source-badge .src-seg[data-engine="local"]');
    const segFocusRaw = await countFocusPixels("#btn-raw");
    const segFocusAsk = await countFocusPixels("#reader-tab-ask");
    record(
      segFocusSrc >= 100 && segFocusRaw >= 100 && segFocusAsk >= 100,
      `md-preview/${mode}: segmented :focus-visible ring clipped (pixels: src=${segFocusSrc}, raw=${segFocusRaw}, ask=${segFocusAsk})`,
    );

    // Check #explain-pop .xp-window-actions 20x20 boxes, 24x24 zero-overlap hit boxes, and elementFromPoint ownership
    const xpAudit = await page.evaluate(() => {
      const ids = ["pt-xp-grip", "pt-xp-dock", "pt-xp-pin", "pt-xp-close"];
      const btns = ids.map((id) => document.getElementById(id));
      const rects = btns.map((b) => b.getBoundingClientRect());
      const stolen = [];
      const hitBoxes = btns.map((b, idx) => {
        const r = rects[idx];
        const cx = (r.left + r.right) / 2;
        const cy = (r.top + r.bottom) / 2;
        const hit = { l: cx - 12, r: cx + 12, t: cy - 12, b: cy + 12 };
        const pts = [
          [r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1],
          [hit.l + 0.1, cy], [hit.r - 1, cy], [cx, hit.t + 0.1], [cx, hit.b - 1],
        ];
        for (const [px, py] of pts) {
          const topEl = document.elementFromPoint(px, py);
          if (!topEl || (topEl !== b && !b.contains(topEl))) {
            stolen.push(`${b.id}@(${px.toFixed(1)},${py.toFixed(1)})->${topEl?.className || topEl?.tagName || "null"}`);
          }
        }
        return hit;
      });
      let overlap = false;
      for (let i = 0; i < hitBoxes.length - 1; i++) {
        if (hitBoxes[i].r > hitBoxes[i + 1].l + 0.05) overlap = true;
      }
      const fixBtnCs = getComputedStyle(document.getElementById("pt-img-fix"));
      const hlWrap = document.createElement("ul");
      hlWrap.className = "hl-list";
      hlWrap.innerHTML = `<li class="hl-item"><button type="button" id="pt-hl-dis" class="hl-item-main" disabled><span class="hl-item-quote">Orphaned highlight</span></button></li>`;
      document.getElementById("rail").appendChild(hlWrap);
      const hlListBg = getComputedStyle(hlWrap).backgroundColor;
      const hlDisCs = getComputedStyle(document.getElementById("pt-hl-dis"));
      const hlDisOp = hlDisCs.opacity;
      const hlDisFg = hlDisCs.color;
      hlWrap.remove();
      const expSel = document.getElementById("exp-image-policy");
      expSel.setAttribute("multiple", "");
      expSel.setAttribute("size", "2");
      const expMultiApp = getComputedStyle(expSel).appearance;
      const expMultiShadow = getComputedStyle(expSel).boxShadow;
      expSel.setAttribute("size", "1");
      const expMultiS1App = getComputedStyle(expSel).appearance;
      const expMultiS1Shadow = getComputedStyle(expSel).boxShadow;
      expSel.removeAttribute("multiple");
      expSel.setAttribute("size", "02");
      const expLeadTwoApp = getComputedStyle(expSel).appearance;
      const expLeadTwoShadow = getComputedStyle(expSel).boxShadow;
      expSel.setAttribute("size", "0");
      const expZeroApp = getComputedStyle(expSel).appearance;
      expSel.removeAttribute("size");
      return {
        sizes: rects.map((r) => [Math.round(r.width), Math.round(r.height)]),
        overlap,
        stolen,
        fixPadL: parseFloat(fixBtnCs.paddingLeft) || 0,
        fixPadR: parseFloat(fixBtnCs.paddingRight) || 0,
        fixDeco: fixBtnCs.textDecorationLine,
        hlListBg,
        hlDisOp,
        hlDisFg,
        expMultiApp,
        expMultiShadow,
        expMultiS1App,
        expMultiS1Shadow,
        expLeadTwoApp,
        expLeadTwoShadow,
        expZeroApp,
      };
    });
    const readerInteractiveProbe = await page.evaluate(RESIDUAL_AND_GEOMETRY_PROBE);
    validateCommonProbe(`md-preview-interactive/${mode}`, readerInteractiveProbe);
    record(
      xpAudit.sizes.every(([w, h]) => w === 20 && h === 20) &&
      !xpAudit.overlap &&
      xpAudit.stolen.length === 0 &&
      xpAudit.fixPadL >= 6 && xpAudit.fixPadR >= 6 && xpAudit.fixDeco === "none" &&
      xpAudit.hlDisOp === "1" && rgbContrast(xpAudit.hlDisFg, xpAudit.hlListBg) >= 4.5 &&
      xpAudit.expMultiApp !== "base-select" && xpAudit.expMultiShadow !== "none" &&
      xpAudit.expMultiS1App !== "base-select" && xpAudit.expMultiS1Shadow !== "none" &&
      xpAudit.expLeadTwoApp !== "base-select" && xpAudit.expLeadTwoShadow !== "none" &&
      xpAudit.expZeroApp === "base-select",
      `md-preview/${mode}: #explain-pop 20x20/24x24, .pbp-img-fix-btn, .hl-item-main:disabled, or #exp-image-policy select guard failed: ${JSON.stringify(xpAudit)}`,
    );

    // Hold mousedown on #rendered-view .empty-state a.action-btn.es-quiet and verify depressed fill + >= 4.5:1 active contrast
    await page.evaluate(() => {
      document.getElementById("explain-pop")?.remove();
      document.getElementById("ask-panel")?.remove();
    });
    const esLinkLoc = page.locator("#pt-es-quiet-link");
    await esLinkLoc.scrollIntoViewIfNeeded();
    const esBox = await esLinkLoc.boundingBox();
    await page.mouse.move(esBox.x + esBox.width / 2, esBox.y + esBox.height / 2);
    await page.mouse.down();
    const esActiveColors = await page.evaluate(() => {
      const a = document.getElementById("pt-es-quiet-link");
      const cs = getComputedStyle(a);
      return { fg: cs.color, bg: cs.backgroundColor };
    });
    await page.mouse.up();
    record(
      esActiveColors.bg === wantPressedBg &&
      rgbContrast(esActiveColors.fg, esActiveColors.bg) >= 4.5,
      `md-preview/${mode}: a.action-btn.es-quiet:active expected bg=${wantPressedBg} & >=4.5:1, got ${JSON.stringify(esActiveColors)}`,
    );

    // Narrow Reader (800x850): #rail-toggle fixed on scroll, tr-busy indicator separation, & .rail-ident static mount
    await page.setViewportSize({ width: 800, height: 850 });
    const narrowRailAudit = await page.evaluate(() => {
      document.getElementById("rendered-view").style.minHeight = "2200px";
      window.scrollTo(0, 600);
      const rt = document.getElementById("rail-toggle");
      const closedRect = rt.getBoundingClientRect();
      document.body.classList.add("tr-busy");
      const busyBefore = getComputedStyle(rt, "::before");
      const busyAfter = getComputedStyle(rt, "::after");
      const busyBeforePos = busyBefore.position;
      const busyBeforeW = parseFloat(busyBefore.width) || 0;
      const busyAfterPos = busyAfter.position;
      const busyAfterRadius = parseFloat(busyAfter.borderTopLeftRadius) || 0;
      document.body.classList.remove("tr-busy");
      const ident = document.querySelector(".rail-ident");
      const origParent = rt.parentElement;
      const origNext = rt.nextSibling;
      document.body.classList.add("rail-open");
      ident.appendChild(rt);
      const openRect = rt.getBoundingClientRect();
      const openPos = getComputedStyle(rt).position;
      document.body.classList.remove("rail-open");
      origParent.insertBefore(rt, origNext);
      window.scrollTo(0, 0);
      return {
        closedLeft: Math.round(closedRect.left),
        closedTop: Math.round(closedRect.top),
        closedW: Math.round(closedRect.width),
        closedH: Math.round(closedRect.height),
        busyBeforePos,
        busyBeforeW,
        busyAfterPos,
        busyAfterRadius,
        openW: Math.round(openRect.width),
        openH: Math.round(openRect.height),
        openPos,
      };
    });
    record(
      narrowRailAudit.closedLeft === 12 &&
      narrowRailAudit.closedTop === 12 &&
      narrowRailAudit.closedW === 38 &&
      narrowRailAudit.closedH === 38 &&
      narrowRailAudit.busyBeforePos === "static" &&
      narrowRailAudit.busyBeforeW === 13 &&
      narrowRailAudit.busyAfterPos === "absolute" &&
      narrowRailAudit.busyAfterRadius === 0 &&
      narrowRailAudit.openW === 24 &&
      narrowRailAudit.openH === 24 &&
      narrowRailAudit.openPos === "static",
      `md-preview-narrow/${mode}: #rail-toggle scroll/tr-busy/.rail-ident failed: ${JSON.stringify(narrowRailAudit)}`,
    );

    if (SHOTS_DIR) {
      const siteThemes = vm.runInNewContext(`${readFileSync(resolve(ROOT, "pinboard-themes.js"), "utf8")}; PINBOARD_THEMES`);
      await page.setViewportSize({ width: 1120, height: 760 });
      await page.goto(`${ORIGIN}/tests/fixtures/pinboard-theme-pages.html`, { waitUntil: "load" });
      await page.evaluate((css) => {
        const st = document.createElement("style");
        st.textContent = css;
        document.head.append(st);
        const content = document.getElementById("content");
        content.innerHTML = `
          <div id="banner"><div id="pinboard_name"><a href="#home">Pinboard</a></div> · <a href="#recent">recent</a> · <a href="#popular">popular</a> · <a href="#notes">notes</a></div>
          <div id="sub_banner"><span><a href="#all" class="selected">all</a> · <a href="#unread">unread</a> · <a href="#private">private</a> · <a href="#starred">starred</a></span></div>
          <div id="main_column">
            <div id="bookmarks">
              <div class="bookmark"><div class="star"><span>✭</span></div><div class="display"><a class="bookmark_title" href="#1">Macintosh Human Interface Guidelines — Platinum Appearance</a><div class="description">Classic 1997–2001 bevel geometry, 12px 6-ridge pinstripes, and neutral R=G=B chassis.</div><a class="tag selected" href="#t1">design-system</a> <a class="tag" href="#t2">macos9</a> <a class="tag" href="#t3">ui</a></div></div>
              <div class="bookmark private"><div class="star"><span>✭</span></div><div class="display"><a class="bookmark_title" href="#2">Pinboard Bookmark Enhanced — Cross-Surface Theme Architecture</a><div class="description"><blockquote>Zero runtime dependencies; dual-track composer + Platinum chrome overlay.</blockquote></div><a class="tag" href="#t4">extension</a> <a class="tag" href="#t5">css</a></div></div>
            </div>
            <div class="bookmark"><div id="edit_bookmark_form"><p>Inline Edit Bookmark</p><form><input type="text" value="Platinum Gray Default" size="36"> <label><input type="checkbox" checked> private</label> <label><input type="checkbox" id="pb-indet"> to read</label> <input type="submit" value="save"> <input type="reset" value="cancel"></form></div></div>
          </div>
          <div id="right_bar"><div id="searchbox"><form><input type="text" id="search_query_field" value="platinum" size="24"><div class="search_button"><input type="submit" value="Search Mine"> <input type="submit" value="Search All"></div></form></div><div id="tag_cloud"><div id="tag_cloud_header"><p><a href="#c" class="tag_heading_selected">top tags</a> · <a href="#m">manage</a></p></div><a href="#t1" class="tag selected">design-system</a> <a href="#t2" class="tag">macos9</a> <a href="#t3" class="tag">typography</a></div></div>`;
        const ind = document.getElementById("pb-indet");
        if (ind) ind.indeterminate = true;
      }, siteThemes[themeAttr].css);
      await page.screenshot({ path: resolve(SHOTS_DIR, `pinboard-${mode}.png`) });
    }
  }

  // ---- 5. Fractional-DPR (1x, 1.25x, 1.5x, 1.75x, 2.25x) select arrow contour monotonicity ----
  const ptCssRaw = readFileSync(resolve(ROOT, "platinum-controls.css"), "utf8");
  for (const dpr of [1, 1.25, 1.5, 1.75, 2.25]) {
    const dprCtx = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 360, height: 140 } });
    const dprPage = await dprCtx.newPage();
    await dprPage.setContent(`<!doctype html><html data-theme="platinum-light"><head><style>${ptCssRaw}</style></head><body style="margin:13.3px;background:#ddd">
      <select id="dpr-sel" style="width:137.4px;height:26px"><option>Mac OS 9</option></select>
    </body></html>`);
    const contour = await dprPage.evaluate(async () => {
      const sel = document.getElementById("dpr-sel");
      return Boolean(sel);
    });
    const selPng = await dprPage.locator("#dpr-sel").screenshot();
    const arrowCheck = await dprPage.evaluate(async (b64) => {
      const d = window.devicePixelRatio || 1;
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, img.width, img.height).data;
      const x0 = img.width - Math.round(16 * d);
      const x1 = img.width - Math.round(4 * d);
      const y0 = Math.round(4 * d);
      const y1 = img.height - Math.round(4 * d);
      const widths = [];
      for (let y = y0; y < y1; y++) {
        let count = 0;
        for (let x = x0; x < x1; x++) {
          const i = (y * img.width + x) * 4;
          if (px[i] < 90 && px[i + 1] < 90 && px[i + 2] < 90) count++;
        }
        widths.push(count);
      }
      // Split non-zero bands (expect exactly 2 triangular bands: >=3 rows each, width span >=3px, monotonic within 1px)
      const validateArrowBands = (bList, dprScale) => {
        if (bList.length !== 2) return false;
        const minRows = Math.max(3, Math.floor(3 * dprScale));
        const minSpan = Math.max(3, Math.floor(4 * dprScale));
        const [up, down] = bList;
        if (up.length < minRows || down.length < minRows) return false;
        if (up[0] >= up[up.length - 1] || Math.max(...up) - Math.min(...up) < minSpan) return false;
        if (down[0] <= down[down.length - 1] || Math.max(...down) - Math.min(...down) < minSpan) return false;
        const upHooks = up.some((w, i) => i > 0 && w < up[i - 1] - 1);
        const downHooks = down.some((w, i) => i > 0 && w > down[i - 1] + 1);
        return !upHooks && !downHooks;
      };
      const bands = [];
      let cur = [];
      for (const w of widths) {
        if (w > 0) cur.push(w);
        else if (cur.length) { bands.push(cur); cur = []; }
      }
      if (cur.length) bands.push(cur);
      return { ok: validateArrowBands(bands, d) && !validateArrowBands([[7], [7]], 1), bands };
    }, selPng.toString("base64"));
    await dprCtx.close();
    record(arrowCheck.ok, `fractional-DPR (${dpr}x) select arrow contour failed: ${JSON.stringify(arrowCheck)}`);
  }
} finally {
  await browser.close();
}

if (fail.length) {
  console.error(`[theme-platinum-render] FAIL (${fail.length}/${checks})`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`[theme-platinum-render] OK — ${checks} Platinum geometry & residual-UI checks passed across 4 surfaces x 2 modes`);
