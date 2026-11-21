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
    if (el.classList.contains("chip-remove") || el.classList.contains("tag-remove") || el.classList.contains("fc-dismiss")) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    let hitL = rect.left, hitR = rect.right, hitT = rect.top, hitB = rect.bottom;
    const before = getComputedStyle(el, "::before");
    if (before && before.content && before.content !== "none" && before.position === "absolute") {
      const padL = rect.left + parsePx(cs.borderLeftWidth);
      const padR = rect.right - parsePx(cs.borderRightWidth);
      const padT = rect.top + parsePx(cs.borderTopWidth);
      const padB = rect.bottom - parsePx(cs.borderBottomWidth);
      hitL = Math.min(hitL, padL + parsePx(before.left));
      hitR = Math.max(hitR, padR - parsePx(before.right));
      hitT = Math.min(hitT, padT + parsePx(before.top));
      hitB = Math.max(hitB, padB - parsePx(before.bottom));
    }
    const hitW = +(hitR - hitL).toFixed(2);
    const hitH = +(hitB - hitT).toFixed(2);

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
      segmented: Boolean(el.closest(".qbtn-split, .send-split, .pbv-copy-group, .view-toggle, .exp-scope, .vocab-group-unit, .md-strip, .export-fmt")),
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

  for (const mode of ["light", "dark"]) {
    const themeAttr = `platinum-${mode}`;
    const wantPressedBg = mode === "dark" ? "rgb(22, 22, 22)" : "rgb(102, 102, 102)";
    const wantSelBg = mode === "dark" ? "rgb(224, 224, 224)" : "rgb(51, 51, 51)";
    const wantPreBg = mode === "dark" ? "rgb(22, 22, 22)" : "rgb(245, 245, 245)";

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
    // Probe General panel first (has .key-toggle icon-only buttons, secret fields, switches)
    const optionsGeneralProbe = await page.evaluate(RESIDUAL_AND_GEOMETRY_PROBE);
    validateCommonProbe(`options-general/${mode}`, optionsGeneralProbe);
    // Then switch to Appearance panel (theme preset buttons, selects, switches) and capture screenshot
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
      return {
        currentHitBg: currentHit ? getComputedStyle(currentHit).backgroundColor : "",
        currentStampFg: currentStamp ? getComputedStyle(currentStamp).color : "",
        preBg: pre ? getComputedStyle(pre).backgroundColor : "",
      };
    }, { themeAttr, icons: PBP_ICONS });
    await page.evaluate(() => document.fonts.ready);
    const libraryProbe = await page.evaluate(RESIDUAL_AND_GEOMETRY_PROBE);
    validateCommonProbe(`library/${mode}`, libraryProbe);
    const wantSelMuted = mode === "dark" ? "rgb(56, 56, 56)" : "rgb(221, 221, 221)";
    record(
      libraryExtra.currentHitBg === wantSelBg &&
      libraryExtra.currentStampFg === wantSelMuted &&
      libraryExtra.preBg === wantPreBg,
      `library/${mode}: Gray active hit/stamp or sunken pre mismatch: ${JSON.stringify(libraryExtra)}`,
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
} finally {
  await browser.close();
}

if (fail.length) {
  console.error(`[theme-platinum-render] FAIL (${fail.length}/${checks})`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`[theme-platinum-render] OK — ${checks} Platinum geometry & residual-UI checks passed across 4 surfaces x 2 modes`);
