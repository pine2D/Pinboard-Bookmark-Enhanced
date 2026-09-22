#!/usr/bin/env node
// scripts/ui-render-audit.mjs — the design-uplift render oracle. Loads the
// unpacked extension (source tree, not a release ZIP) into a real Chromium,
// seeds a minimal fixture (one Pinboard-shaped token, one vocab word + group,
// one highlight/note), then walks tests/render-audit-checklist.mjs's
// hand-written CHECKS × THEMES matrix against the ACTUAL rendered DOM:
// computed `color`, the real composited ancestor background (walking the
// live cascade, not reading CSS source), and real getBoundingClientRect()
// geometry. This is what makes it a different failure class than the static
// [static] gates (recipe-lint, css-region-audit, etc.): a component can pass
// every static token-wiring check and still render wrong once the browser's
// own cascade and layout are involved -- see COMPONENTS.md §7.1's two-door
// requirement ("两道门必须都在").
//
// USAGE
//   node scripts/ui-render-audit.mjs                      # gate: known-failures WARN, new violations FAIL
//   node scripts/ui-render-audit.mjs --update-known-failures  # (re)write the baseline
//   node scripts/ui-render-audit.mjs --sweep               # DISCOVERY mode (see below), not a gate
//   node scripts/ui-render-audit.mjs --write-spacing-baseline  # (re)freeze the spacingScale ratchet ledger
//   node scripts/ui-render-audit.mjs --shard=i/n           # run only theme slice i of n (verify.sh)
//   node scripts/ui-render-audit.mjs --json=<path>         # also dump the raw results array (equivalence checks)
//
// --shard=i/n splits the surface x theme matrix across n independent
// PROCESSES, which is how scripts/verify.sh runs this gate (this one script
// was ~80% of verify's wall clock: 440s of ~550s; 4 shards run it in 154s).
// It cannot be a pool of pages inside ONE browser: the theme is written into
// the extension's SW storage (setTheme), so a context holds exactly one
// theme at a time. Each
// shard therefore loads its own unpacked extension and -- by being main()
// again from the top -- replays the identical fixture seeding, which is what
// makes a shard's verdict on its own themes identical to the full run's.
// Shard 0 additionally runs the single --sweep pass that feeds families 4-11
// and the spacingScale ledger (one pass covers every theme: geometry tokens
// are theme invariants, .claude/rules/theme-factory.md). A shard reports its
// own slice against known-failures and exits with its own code, so verify
// fails when ANY shard fails; the only thing it cannot do is the advisory
// STALE reconciliation (its seenKeys is a slice) -- see report(). Without
// the flag this file behaves exactly as it did before the option existed.
//
// --sweep is a separate mode from the CHECKS/known-failures gate above: a
// generic DOM walk (not the hand-written CHECKS list) that hunts for three
// geometry defect CLASSES across every element on the page instead of the
// enumerated instances CHECKS covers -- textInset (text glued to a visible
// border), childContainment (a summary/disclosure's icon or ::after chevron
// painting outside its host's border-box), rowHeightEq (mismatched heights
// among sibling form controls in the same flex/grid row). It prints hits and
// exits 0 unconditionally -- it is a FINDER, not a pass/fail gate. Each real
// hit it turns up gets fixed and then locked in as a normal hand-written
// CHECKS entry (heightEqWith for rowHeightEq, the new textInset/
// childContainment expect keys for the other two) so the permanent gate
// above catches any regression -- the sweep itself is not meant to run in
// CI/verify.sh.
//
// PREREQUISITES (same as scripts/zip-install-smoke.mjs)
//   cd .qa-scan && npm install && npx playwright install chromium
//
// EXIT
//   0 → pass (all failures already in known-failures, or --update-known-failures ran)
//   1 → at least one NEW violation not covered by known-failures
//   2 → tooling/env error (no playwright, no display, seed failed, bad JSON, etc.)

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  CHECKS,
  THEMES,
  MEDIA_CHECKS,
  MEDIA_SCENARIOS,
  MEDIA_THEMES,
  evaluateMediaProbe,
} from "../tests/render-audit-checklist.mjs";
// Reused, not re-implemented, so this audit and contrast-audit.mjs's static
// CSS-source audit can never quietly disagree on what a passing ratio is.
import { cr, hexRgb, parseRgba, composite } from "../docs/theme-surface/tools/contrast-audit.mjs";
// The chip family is defined once, in the composer; spacingScale reads it from
// there (not from a hand-copied list) to know whose inset is component geometry.
import { CHIP_TARGETS } from "../docs/theme-surface/composers/ui-components.mjs";
// weakTextOnFill (family 13) gates library's two batch-selection bands
// alongside the four control fills; the band is a runtime color-mix(), not a
// token, so its expected RGB has to be computed from the same percentages
// library-chrome.mjs derives --lib-row-selected-fg against -- imported, never
// hand-typed 0.20/0.26 in this file (see WEAK_TEXT_CFG.library below).
import { LIB_BATCH_BAND_MIX } from "../docs/theme-surface/composers/library-chrome.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const KNOWN_FAILURES_PATH = resolve(ROOT, "tests", "render-audit-known-failures.json");
const TIMEOUT_MS = 15000;

const UPDATE = process.argv.includes("--update-known-failures");
const SWEEP = process.argv.includes("--sweep");
// spacingScale (family 11) keeps its own shrink-only ledger instead of using
// known-failures: its debt is a few hundred (surface, element, property, value)
// identities that retire one CSS rule at a time, the same shape as
// docs/theme-surface/tools/override-debt.mjs and scripts/ui-vocabulary-lint.mjs.
const SPACING_BASELINE_PATH = resolve(ROOT, "tests", "render-audit-spacing-baseline.json");
const WRITE_SPACING = process.argv.includes("--write-spacing-baseline");

// ---- --shard=i/n (see the USAGE block). Pure read: no --shard flag means
// SHARD is null and every branch below is the pre-sharding one. ----
function parseShard() {
  const arg = process.argv.find((a) => a === "--shard" || a.startsWith("--shard="));
  if (!arg) return null;
  const m = /^--shard=(\d+)\/(\d+)$/.exec(arg);
  if (!m) {
    console.error(`[render-audit] bad shard argument ${JSON.stringify(arg)} -- expected --shard=i/n with 0 <= i < n`);
    process.exit(2);
  }
  const i = Number(m[1]);
  const n = Number(m[2]);
  if (n < 1 || i >= n) {
    console.error(`[render-audit] bad shard ${i}/${n} -- expected 0 <= i < n and n >= 1`);
    process.exit(2);
  }
  return { i, n };
}
const SHARD = parseShard();
if (SHARD && (UPDATE || SWEEP || WRITE_SPACING)) {
  // Those three modes write (or print) a whole-matrix artifact; a slice of
  // the matrix would silently truncate the baseline / the ledger / the hit
  // list. Refuse instead of producing a plausible-looking partial file.
  console.error("[render-audit] --shard cannot be combined with --update-known-failures / --sweep / --write-spacing-baseline (they need the whole matrix in one process)");
  process.exit(2);
}
const SHARD_TAG = SHARD ? ` (shard ${SHARD.i}/${SHARD.n})` : "";
// Round-robin, not contiguous blocks, so the four MEDIA_THEMES (whose legs
// cost extra CDP probes) spread across shards instead of landing in one.
const SHARD_THEMES = SHARD ? THEMES.filter((_, idx) => idx % SHARD.n === SHARD.i) : THEMES;
const RUNS_SWEEP = !SHARD || SHARD.i === 0;

// --json=<path> dumps the raw `results` array (every OK/SKIP/FAIL row, not
// just the reported ones) next to the normal report. Added for the sharding
// equivalence proof -- report() console.logs and exits, so without it there
// is no way to assert "the union of the shards is item-for-item the full
// run". Read-only for the gate: the verdict and the exit code do not change.
const JSON_OUT = (() => {
  const arg = process.argv.find((a) => a.startsWith("--json="));
  const value = arg ? arg.slice("--json=".length) : "";
  if (arg && !value) {
    console.error("[render-audit] --json= needs a path (e.g. --json=/tmp/render-audit-full.json)");
    process.exit(2);
  }
  return value ? resolve(process.cwd(), value) : null;
})();

let chromium;
try {
  const req = createRequire(resolve(ROOT, ".qa-scan", "package.json"));
  ({ chromium } = req("playwright"));
} catch {
  console.error("[render-audit] playwright not found.");
  console.error("  Install:  cd .qa-scan && npm install && npx playwright install chromium");
  process.exit(2);
}

const SURFACE_PAGES = { library: "library.html", options: "options.html", popup: "popup.html" };
const MEDIA_THEME_SET = new Set(MEDIA_THEMES);

// ---- Fixture identity. Any Pinboard-token-shaped string works here -- it
// never leaves this machine and nothing validates it against the real API.
// obfuscateKey()'s algorithm (shared.js), reproduced inline since Node has no
// window.btoa: "obf:" + base64(utf8(raw)). ----
const SEED_TOKEN_ACCOUNT = "qa-render";
const SEED_TOKEN_RAW = `${SEED_TOKEN_ACCOUNT}:audit0000000000000000000000000000`;
const SEED_TOKEN_OBF = "obf:" + Buffer.from(SEED_TOKEN_RAW, "utf8").toString("base64");
const SEED_OWNER = "acct_" + encodeURIComponent(SEED_TOKEN_ACCOUNT);

// ---- Theme storage mapping. Hand-copied from shared.js's ADAPTIVE_THEME_MAP
// (verified at authoring time, not imported: shared.js is a plain script,
// not an ES module, and this keeps the mapping legible next to the THEMES
// list it serves). "" is not a real storage value -- it decodes to the
// (themePresetKey, optTheme) pair that PRODUCES the default-light state; the
// no-preset dark state is "flexoki-dark" on every surface (batch 2 D6). ----
const ADAPTIVE_VARIANTS = {
  flexoki: ["flexoki-light", "flexoki-dark"],
  solarized: ["solarized-light", "solarized-dark"],
  catppuccin: ["catppuccin-latte", "catppuccin-mocha"],
};
// Dark-preset ids among THEMES (colorSchemeMatchesTheme, Task 6). Hand-copied
// from composers/popup-chrome.mjs's POPUP_THEME_MAP { mode: "dark" } entries
// -- all three surfaces render the identical 14-id data-theme set (same
// census the checklist's own THEMES comment documents) -- NOT imported, same
// independence-from-the-composer-layer reasoning as ADAPTIVE_VARIANTS above.
const DARK_THEME_IDS = new Set([
  "nord-night", "terminal", "dracula", "flexoki-dark",
  "solarized-dark", "catppuccin-mocha", "gruvbox-dark", "rose-pine",
]);
function isDarkTheme(themeKey) { return DARK_THEME_IDS.has(themeKey); }

function themeToStorage(themeKey) {
  if (themeKey === "") return { themePresetKey: "", optTheme: "light" };
  for (const [umbrella, [light, dark]] of Object.entries(ADAPTIVE_VARIANTS)) {
    if (themeKey === light) return { themePresetKey: umbrella, optTheme: "light" };
    if (themeKey === dark) return { themePresetKey: umbrella, optTheme: "dark" };
  }
  return { themePresetKey: themeKey, optTheme: "light" }; // fixed preset, mode is a don't-care
}

// ---- Color/geometry math. compositeStack + resolveColor are the render
// oracle's own combinators (a live-DOM ancestor walk has no equivalent in
// contrast-audit.mjs, which reads hex literals out of CSS source) built ONLY
// from the five imported primitives -- no re-implementation of lum/cr. ----
function resolveColor(raw, bg) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("#")) return hexRgb(s);
  const parsed = parseRgba(s);
  return parsed ? composite(parsed.slice(0, 3), parsed[3], bg) : null;
}
function compositeStack(rawColors) {
  let base = [255, 255, 255]; // opaque canvas default; every page's <html> paints over this before it matters
  for (let i = rawColors.length - 1; i >= 0; i--) {
    const parsed = parseRgba(rawColors[i]);
    if (!parsed || parsed[3] <= 0) continue;
    base = composite(parsed.slice(0, 3), parsed[3], base);
  }
  return base;
}
// A CSS custom property value read via getComputedStyle (textContrastMulti's
// extraBgRaw) is a solid theme token, not a foreground painted over
// something -- every `--{ns}-btn-hover` in the shipped CSS is a plain hex
// literal (verified: grep -n -- '--lib-btn-hover:' library.css), so this
// only needs the two imported parsers, no compositing.
function parseSolidColor(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("#")) return hexRgb(s);
  const parsed = parseRgba(s);
  return parsed ? parsed.slice(0, 3) : null;
}
function round2(n) { return n == null ? n : Math.round(n * 100) / 100; }
function verdict(check, ok, actual, expected, note) { return { check, status: ok ? "OK" : "FAIL", actual, expected, note: note || null }; }
function skip(check, expected, note) { return { check, status: "SKIP", actual: null, expected, note }; }

// Runs INSIDE the page (Playwright serializes this function's source), so it
// must be self-contained -- no references to anything outside its own body.
// `compareSelector` (heightEqWith) and `extraBgVarName` (textContrastMulti,
// bgEqVar) are both optional -- one evaluate() round-trip covers whatever
// the check needs instead of a second page.evaluate call per check.
// `extraColorVarName` (colorEqVar, D6/D7 Task 5) is a SEPARATE slot, not
// reused from extraBgVarName: a single check (popup's `.stag`) legitimately
// needs both a background-role token (bgEqVar: "chip-bg") AND a DIFFERENT
// color-role token (colorEqVar: "chip-fg") at once -- sharing one slot
// between the two silently made colorEqVar compare against whichever token
// bgEqVar/textContrastMulti had already claimed (caught live: `.stag`'s
// colorEqVar read chip-BG's value while labelled chip-fg in the verdict).
function probeSelector({ selector, compareSelector, extraBgVarName, extraColorVarName, radiusVarName, childSelectors, focusTargetSelector }) {
  const el = document.querySelector(selector);
  if (!el) return { found: false };
  const cs = getComputedStyle(el);
  // ---- §8 fused-control probes (design-uplift 2026-08-05). Both are opt-in
  // via the extra args so every other check pays nothing for them.
  // `children` feeds fusedChildrenFlat (law 1 + law 3: passengers draw no box
  // of their own, and whatever divider they DO draw is one colour at one
  // width). `focusedSelf` feeds fusedFocusRing (law 2: the ring is the
  // shell's, so the focused passenger must render none of its own).
  let children = null;
  if (childSelectors && childSelectors.length) {
    children = childSelectors.map((sel) => {
      const c = el.querySelector(sel);
      if (!c) return { sel, found: false };
      const ccs = getComputedStyle(c);
      return {
        sel, found: true,
        // A segmented control's SELECTED cell legitimately paints a fill --
        // that is the selection, and §8 law 4 puts selection/hover/press
        // feedback in exactly this ghost-fill register. The resting-fill
        // clause below is about a passenger painting its own CHROME, so it
        // only applies to cells that are not currently selected.
        isSelected: c.getAttribute("aria-pressed") === "true"
          || c.getAttribute("aria-selected") === "true"
          || c.classList.contains("active"),
        borderWidths: [ccs.borderTopWidth, ccs.borderRightWidth, ccs.borderBottomWidth, ccs.borderLeftWidth].map((v) => parseFloat(v) || 0),
        borderStyles: [ccs.borderTopStyle, ccs.borderRightStyle, ccs.borderBottomStyle, ccs.borderLeftStyle],
        borderColors: [ccs.borderTopColor, ccs.borderRightColor, ccs.borderBottomColor, ccs.borderLeftColor],
        radii: [ccs.borderTopLeftRadius, ccs.borderTopRightRadius, ccs.borderBottomRightRadius, ccs.borderBottomLeftRadius].map((v) => parseFloat(v) || 0),
        background: ccs.backgroundColor,
        // Feeds edgeClickable (independent review F2, hit-area-debt): a
        // ::before hit-pad's computed width/height (what hitAreaMin reads)
        // proves the BOX got bigger, not that a real pointer event lands
        // there -- a fused shell's `overflow: hidden` clips exactly that
        // silently (F1's own root cause). Two points just past this cell's
        // own top edge (§1.5's pads on these two shells are vertical-only,
        // so that is the one direction with something to prove), offset
        // ±3px from centre so a seam-adjacent miscalculation would show up
        // as a hit on the WRONG cell rather than a coincidental hit on
        // either. `elementFromPoint` must resolve inside this cell (itself
        // or a descendant, e.g. its svg icon) at both points.
        edgeHit: (() => {
          const r = c.getBoundingClientRect();
          const cx = r.left + r.width / 2, y = r.top - 1;
          const pts = [[cx - 3, y], [cx + 3, y]];
          const results = pts.map(([x, py]) => {
            const hit = document.elementFromPoint(x, py);
            return { x: +x.toFixed(2), y: +py.toFixed(2), ok: !!hit && (hit === c || c.contains(hit)), hitPath: hit ? (hit.id ? "#" + hit.id : hit.className || hit.tagName) : null };
          });
          return { ok: results.every((p) => p.ok), points: results };
        })(),
      };
    });
  }
  let focusedSelf = null;
  if (focusTargetSelector) {
    const f = focusTargetSelector === ":scope" ? el : el.querySelector(focusTargetSelector);
    if (f) {
      const fcs = getComputedStyle(f);
      focusedSelf = {
        sel: focusTargetSelector,
        isActiveElement: document.activeElement === f,
        outlineStyle: fcs.outlineStyle,
        outlineWidth: parseFloat(fcs.outlineWidth) || 0,
        // Load-bearing: fusedFocusRing now allows a segment's own ring but
        // requires it to be INSET. Without this field that comparison reads
        // `undefined >= 0` === false and the check silently never fires.
        outlineOffset: parseFloat(fcs.outlineOffset) || 0,
        boxShadow: fcs.boxShadow,
      };
    } else {
      focusedSelf = { sel: focusTargetSelector, found: false };
    }
  }
  // ---- §8 law 6 state-stability snapshot (design-uplift round 5). The
  // runner takes this in BOTH the rest and the focused pass and diffs them:
  // a fused control may change border-COLOUR and gain a ring on focus, and
  // nothing else. No geometry may shift by even a subpixel (border-WIDTH
  // changes are the classic cause), no background may repaint, and the
  // trailing icon must not move -- those three together are what "the eye
  // jumped / the field went white / the segment stopped looking attached"
  // reduce to, measured instead of eyeballed.
  const stability = { self: null, children: [] };
  {
    const cs2 = getComputedStyle(el), r2 = el.getBoundingClientRect();
    const svg2 = el.querySelector("svg");
    const sr2 = svg2 && svg2.getBoundingClientRect();
    stability.self = {
      rect: [+r2.x.toFixed(2), +r2.y.toFixed(2), +r2.width.toFixed(2), +r2.height.toFixed(2)],
      bg: cs2.backgroundColor,
      borderWidths: [cs2.borderTopWidth, cs2.borderRightWidth, cs2.borderBottomWidth, cs2.borderLeftWidth].join(","),
      svgCenter: sr2 ? [+(sr2.x + sr2.width / 2).toFixed(2), +(sr2.y + sr2.height / 2).toFixed(2)] : null,
    };
    for (const sel of (childSelectors || [])) {
      const c = el.querySelector(sel);
      if (!c) { stability.children.push({ sel, found: false }); continue; }
      const ccs = getComputedStyle(c), cr = c.getBoundingClientRect();
      const csvg = c.querySelector("svg");
      const csr = csvg && csvg.getBoundingClientRect();
      stability.children.push({
        sel, found: true,
        rect: [+cr.x.toFixed(2), +cr.y.toFixed(2), +cr.width.toFixed(2), +cr.height.toFixed(2)],
        bg: ccs.backgroundColor,
        borderWidths: [ccs.borderTopWidth, ccs.borderRightWidth, ccs.borderBottomWidth, ccs.borderLeftWidth].join(","),
        svgCenter: csr ? [+(csr.x + csr.width / 2).toFixed(2), +(csr.y + csr.height / 2).toFixed(2)] : null,
      });
    }
  }
  const rect = el.getBoundingClientRect();
  const bgStack = [];
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    bgStack.push(getComputedStyle(node).backgroundColor);
  }
  const svgEl = el.querySelector("svg");
  let svg = null;
  if (svgEl) {
    const r = svgEl.getBoundingClientRect();
    svg = { color: getComputedStyle(svgEl).color, rect: { top: r.top, height: r.height } };
  }
  let compareRect = null;
  if (compareSelector) {
    const cmpEl = document.querySelector(compareSelector);
    if (cmpEl) { const r = cmpEl.getBoundingClientRect(); compareRect = { height: r.height }; }
  }
  let extraBgRaw = null;
  if (extraBgVarName) {
    extraBgRaw = getComputedStyle(document.documentElement).getPropertyValue(extraBgVarName).trim() || null;
  }
  let extraColorRaw = null;
  if (extraColorVarName) {
    extraColorRaw = getComputedStyle(document.documentElement).getPropertyValue(extraColorVarName).trim() || null;
  }
  // Effective hit-area box (COMPONENTS.md §1.5's ::before hit-area expansion
  // recipe, e.g. .row-del-x / #vocab-invert-selection): getBoundingClientRect()
  // on the host alone can't see it -- position:absolute pseudo-elements never
  // affect their own host's layout box, that's the whole point of the trick --
  // so hitAreaMin was blind to it (COMPONENTS.md §1.4 always said "含 ::before
  // 扩张", this oracle just hadn't implemented that half of its own contract).
  // Chromium's getComputedStyle(el, "::before") already resolves width/height
  // to their USED pixel values when `position:absolute` + inset offsets give
  // the box a definite size (verified live: an all-sides-inset, no-explicit-
  // size ::before reports e.g. width:"26px"/height:"24px", never the literal
  // keyword "auto") -- no need to hand-derive it from the containing block's
  // padding box ourselves, just parse what the browser already computed.
  // Falls back to the host's own rect when there's no ::before (content:
  // "none") or it isn't absolutely positioned.
  let effRect = { width: rect.width, height: rect.height };
  const beforeCs = getComputedStyle(el, "::before");
  if (beforeCs && beforeCs.content && beforeCs.content !== "none" && beforeCs.position === "absolute") {
    const bw = parseFloat(beforeCs.width), bh = parseFloat(beforeCs.height);
    if (Number.isFinite(bw) && Number.isFinite(bh)) {
      effRect = { width: Math.max(rect.width, bw), height: Math.max(rect.height, bh) };
    }
  }
  // widthLtParent needs the parent's CONTENT-box width, not its border-box
  // width: a stretched flex item (align-items:stretch, the exact bug this
  // check exists to catch) fills the container's content box, which sits
  // INSIDE both the container's padding and its border. Comparing against
  // border-box width let padding+border alone (e.g. .tag-gov-group-row's
  // 12px padding + 1px border per side = 26px combined) silently clear an
  // 8px margin that was meant to only tolerate normal text-width variance --
  // a stretched child would still measure well under border-box width and
  // the guard could never actually fire for its one real target.
  const parentEl = el.parentElement;
  let parentRect = null;
  if (parentEl) {
    const pcs = getComputedStyle(parentEl);
    const pRect = parentEl.getBoundingClientRect();
    const contentWidth = pRect.width
      - (parseFloat(pcs.paddingLeft) || 0) - (parseFloat(pcs.paddingRight) || 0)
      - (parseFloat(pcs.borderLeftWidth) || 0) - (parseFloat(pcs.borderRightWidth) || 0);
    parentRect = { width: contentWidth };
  }
  // ---- textInset (Task 14 -- options preset-preview summary's "text glued
  // to the border" bug): union bbox of the element's OWN direct text nodes
  // ONLY (not descendants -- a wrapper with its text in a child <span> is a
  // different, not-yet-covered shape), via a Range per text node so
  // multi-rect (wrapped) text still gets a correct overall bbox. Measured
  // against the nearest ELEMENT-OR-ANCESTOR that is actually a full 4-side
  // box border (findBorderBoxHost) -- the real bug's border lives on
  // `#preset-preview-section` (the <details>), one level above the
  // `<summary>` that holds the text, so a same-element-only rule would have
  // missed exactly the case this check exists for. Requires ALL FOUR sides
  // (not just one) so single-edge dividers like `.reset-tab-btn`'s
  // `border-top` alone don't get treated as a "box" with a phantom bottom
  // constraint. Stops at the first scrollable ancestor (`#preset-preview-
  // content`'s `overflow:auto` code panel is exactly this shape) -- content
  // that's expected to scroll past its own box isn't a text-inset bug.
  function findBorderBoxHost(start) {
    let cur = start;
    for (let depth = 0; depth < 5 && cur && cur !== document.documentElement; depth++) {
      const c = getComputedStyle(cur);
      if (c.overflowX === "auto" || c.overflowX === "scroll" || c.overflowY === "auto" || c.overflowY === "scroll") return null;
      // The classic single-line ellipsis idiom (white-space:nowrap +
      // text-overflow:ellipsis + overflow:hidden, e.g. .vocab-row-gloss)
      // deliberately lays out text WIDER than its own box and clips it --
      // that's a truncation boundary, not a text-inset bug, so stop here
      // too. Narrower than "any overflow:hidden" on purpose:
      // `#preset-preview-section` (the real bug's border host) ALSO has a
      // bare `overflow:hidden` of its own (clip-to-border-radius, not
      // truncation -- no nowrap/ellipsis alongside it), and a blanket
      // overflow:hidden stop would have walked straight past it and missed
      // the bug this check exists to catch.
      if (c.overflowX === "hidden" && c.whiteSpace === "nowrap" && c.textOverflow === "ellipsis") return null;
      const bw = { t: parseFloat(c.borderTopWidth) || 0, r: parseFloat(c.borderRightWidth) || 0, b: parseFloat(c.borderBottomWidth) || 0, l: parseFloat(c.borderLeftWidth) || 0 };
      if (Math.min(bw.t, bw.r, bw.b, bw.l) > 0) return { host: cur, bw };
      cur = cur.parentElement;
    }
    return null;
  }
  const directText = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
  let textInset = null;
  if (directText.length) {
    const borderHost = findBorderBoxHost(el);
    if (borderHost) {
      const range = document.createRange();
      let uL = Infinity, uT = Infinity, uR = -Infinity, uB = -Infinity;
      for (const tn of directText) {
        range.selectNodeContents(tn);
        for (const r of range.getClientRects()) {
          if (r.width === 0 && r.height === 0) continue;
          uL = Math.min(uL, r.left); uT = Math.min(uT, r.top);
          uR = Math.max(uR, r.right); uB = Math.max(uB, r.bottom);
        }
      }
      if (uL !== Infinity) {
        const hostRect = borderHost.host.getBoundingClientRect();
        const bw2 = borderHost.bw;
        textInset = {
          left: uL - (hostRect.left + bw2.l), right: (hostRect.right - bw2.r) - uR,
          top: uT - (hostRect.top + bw2.t), bottom: (hostRect.bottom - bw2.b) - uB,
        };
      }
    }
  }
  // ---- childContainment (Task 14 -- the preset-preview chevron poking past
  // its own border): every icon/pseudo-element child must stay inside the
  // host's border-box. svg has a real DOM node (getBoundingClientRect direct);
  // ::before/::after don't -- measurePseudo mirrors the pseudo's resolved
  // box-model properties onto a REAL sibling inserted in the same spot (with
  // the actual pseudo swapped out via a scoped `content: none !important`
  // override, so the two never double-count as two trailing flex items in
  // the same row), reads ITS rect, then removes it -- synchronous within this
  // one function call, no paint/flicker, no residue on the live DOM.
  function measurePseudo(pseudo) {
    const pcs = getComputedStyle(el, pseudo);
    if (!pcs || !pcs.content || pcs.content === "none") return null;
    const marker = "pbpSweepGhost" + Math.random().toString(36).slice(2);
    el.classList.add(marker);
    const styleEl = document.createElement("style");
    styleEl.textContent = `.${marker}${pseudo} { content: none !important; }`;
    document.head.appendChild(styleEl);
    const ghost = document.createElement("span");
    const props = ["position", "top", "right", "bottom", "left", "width", "height", "display",
      "marginTop", "marginRight", "marginBottom", "marginLeft",
      "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
      "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
      "boxSizing", "transform", "transformOrigin", "flexShrink", "flexGrow", "flexBasis", "alignSelf"];
    for (const p of props) { try { ghost.style[p] = pcs[p]; } catch (_) {} }
    if (pseudo === "::before") el.insertBefore(ghost, el.firstChild); else el.appendChild(ghost);
    const r = ghost.getBoundingClientRect();
    ghost.remove(); styleEl.remove(); el.classList.remove(marker);
    if (r.width === 0 && r.height === 0) return null;
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
  }
  const containmentChildren = [];
  if (svgEl) {
    const r = svgEl.getBoundingClientRect();
    containmentChildren.push({ kind: "svg", rect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom } });
  }
  const beforeRect = measurePseudo("::before");
  if (beforeRect) containmentChildren.push({ kind: "::before", rect: beforeRect });
  const afterRect = measurePseudo("::after");
  if (afterRect) containmentChildren.push({ kind: "::after", rect: afterRect });
  return {
    found: true,
    disabled: !!el.disabled,
    color: cs.color,
    // T5 fix round F6: `.stag.used` (popup.css) is a `text-decoration-line:
    // line-through` state, not just a colour swap -- captured unconditionally
    // (cheap, selector-independent) the same way fontSize/fontVariantNumeric
    // are above.
    textDecorationLine: cs.textDecorationLine,
    outlineColor: cs.outlineColor,
    outlineStyle: cs.outlineStyle,
    outlineWidth: parseFloat(cs.outlineWidth) || 0,
    outlineOffset: parseFloat(cs.outlineOffset) || 0,
    boxShadow: cs.boxShadow,
    borderColors: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor].join("|"),
    children,
    focusedSelf,
    stability,
    bgStack,
    rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    effRect,
    parentRect,
    svg,
    compareRect,
    extraBgRaw,
    extraColorRaw,
    textInset,
    containmentChildren,
    // Unconditional (cheap, selector-independent) -- colorSchemeMatchesTheme's
    // proxy for native-control (scrollbar/spinner) rendering mode, which has
    // no pixel-level probe of its own (Task 6).
    rootColorScheme: getComputedStyle(document.documentElement).colorScheme,
    paddingLeft: parseFloat(cs.paddingLeft) || 0,
    paddingRight: parseFloat(cs.paddingRight) || 0,
    paddingTop: parseFloat(cs.paddingTop) || 0,
    paddingBottom: parseFloat(cs.paddingBottom) || 0,
    borderRadius: parseFloat(cs.borderTopLeftRadius) || 0,
    // COMPONENTS.md §9 law 3 (inset selection band). Read from the element
    // that PAINTS the band, which is not always the row element itself --
    // library's vocabulary rows paint on .notes-card-top inside .vocab-card.
    marginLeft: parseFloat(cs.marginLeft) || 0,
    marginRight: parseFloat(cs.marginRight) || 0,
    marginTop: parseFloat(cs.marginTop) || 0,
    marginBottom: parseFloat(cs.marginBottom) || 0,
    backgroundColor: cs.backgroundColor,
    // The surface's own radius rung, for insetBand's ladder comparison. Read
    // off <html> the same way extraBgVarName is -- a theme's radius scale is
    // a per-theme value, so an absolute px floor here would override the very
    // ladder §9.2 law 1 exists to keep authoritative (gruvbox-dark's md rung
    // is genuinely 2px; that is its design, not a regression).
    radiusVarPx: radiusVarName ? (parseFloat(getComputedStyle(document.documentElement).getPropertyValue(radiusVarName)) || 0) : null,
    borderBottomColor: cs.borderBottomColor,
    borderBottomWidth: parseFloat(cs.borderBottomWidth) || 0,
    // heightPx / fontSizePx / fontVariantNumericContains (D6/D7, Task 5,
    // taste-uplift batch3): the chip family has no literal geometry/
    // typography assertion anywhere in this evaluator today -- every prior
    // chip entry (.vocab-group-chip, .tag-gov-chip-face) proves its rung
    // only indirectly via padVMin+padGteRadiusH. .stag-num's tabular-nums
    // and .stag's exact 18px chip-rung height have no such proxy, so these
    // two cheap, selector-independent fields are captured unconditionally
    // for every check to read.
    fontSize: parseFloat(cs.fontSize) || 0,
    fontVariantNumeric: cs.fontVariantNumeric,
  };
}

// Node-side: turns one probe() result into one-or-more {check, status,
// actual, expected} verdicts, per the `expect` keys the CHECK declared.
// `theme` (added Task 6, colorSchemeMatchesTheme only) is the current
// THEMES-loop value -- unlike every other expect key, the "correct" value
// here legitimately depends on which theme is active, so it can't be a
// static literal in the checklist entry the way every other check's
// `expect` is (see the file-header note on why CHECKS entries don't
// normally carry a `theme` field: this key stays theme-INDEPENDENT in the
// checklist -- `colorSchemeMatchesTheme: true` -- and only the runner,
// which already owns the THEMES loop, computes what "matches" means).
function evaluateCheck(check, raw, theme) {
  if (!raw.found) return { setupError: `selector not found in DOM: ${check.selector}` };
  const bg = compositeStack(raw.bgStack);
  const out = [];
  const exp = check.expect;
  const disabledSkip = !!raw.disabled; // WCAG 1.4.3 exempts disabled controls -- contrast checks only
  // A collapsed/hidden ancestor (fixture forgot to reveal a panel, or a
  // future CSS change makes an element `display:none`) reports a
  // zero-size rect -- every geometry math below would then divide/compare
  // against 0 and could accidentally read as "passing". Every geometry
  // check below fails loudly on this instead (still recorded into
  // known-failures normally -- it is not a silent skip).
  const hostZero = raw.rect.width === 0 || raw.rect.height === 0;
  const zeroNote = "zero-size element (width or height is 0) -- not actually rendered/visible; fixture setup or a display:none regression";

  if ("textContrast" in exp) {
    if (disabledSkip) out.push(skip("textContrast", exp.textContrast, "disabled (WCAG 1.4.3 exempt)"));
    else {
      const fg = resolveColor(raw.color, bg);
      const ratio = fg ? cr(fg, bg) : 0;
      out.push(verdict("textContrast", ratio >= exp.textContrast, round2(ratio), exp.textContrast));
    }
  }
  if ("iconContrast" in exp) {
    if (disabledSkip) out.push(skip("iconContrast", exp.iconContrast, "disabled (WCAG 1.4.3 exempt)"));
    else if (!raw.svg) out.push(verdict("iconContrast", false, null, exp.iconContrast, "no <svg> descendant"));
    else {
      const fg = resolveColor(raw.svg.color, bg);
      const ratio = fg ? cr(fg, bg) : 0;
      out.push(verdict("iconContrast", ratio >= exp.iconContrast, round2(ratio), exp.iconContrast));
    }
  }
  if ("iconVCenter" in exp) {
    if (!raw.svg) out.push(verdict("iconVCenter", false, null, exp.iconVCenter, "no <svg> descendant"));
    else if (hostZero || raw.svg.rect.height === 0) out.push(verdict("iconVCenter", false, null, exp.iconVCenter, zeroNote));
    else {
      const hostCenter = raw.rect.top + raw.rect.height / 2;
      const svgCenter = raw.svg.rect.top + raw.svg.rect.height / 2;
      out.push(verdict("iconVCenter", Math.abs(hostCenter - svgCenter) <= exp.iconVCenter,
        round2(Math.abs(hostCenter - svgCenter)), exp.iconVCenter));
    }
  }
  if ("backgroundAlphaMax" in exp) {
    const parsed = parseRgba(raw.backgroundColor);
    const alpha = parsed?.[3];
    out.push(verdict(
      "backgroundAlphaMax",
      alpha != null && alpha <= exp.backgroundAlphaMax + 0.0001,
      alpha == null ? null : round2(alpha),
      exp.backgroundAlphaMax,
      alpha == null ? `unparseable computed background: ${raw.backgroundColor}` : undefined,
    ));
  }
  // A higher-specificity base rule (classically an #id selector) can leave a
  // state-driven class sitting inert in the DOM -- the class is there, the
  // cascade still paints the resting colour. Compares the SAME element's
  // composited background with and without `check.addClass` (see the
  // "classState" runner state) rather than asserting a literal colour, so
  // this works across all 16 themes without hand-copying a palette.
  if (exp.bgChangedFromRest === true) {
    if (!raw.restBgStack) out.push(verdict("bgChangedFromRest", false, null, null, "no rest baseline captured -- classState runner state required"));
    else {
      const restBg = compositeStack(raw.restBgStack);
      // .join(",") not `!==` (found chasing down independent review F2/F3,
      // 2026-08-08): compositeStack returns an RGB ARRAY, and `bg !== restBg`
      // compares two array REFERENCES -- always true, regardless of their
      // contents, since they're never the same object. This made the check
      // vacuously pass on every run, fixed code or broken: the F2/F3 settle-
      // timing hypothesis wasn't actually why the first version's RED test
      // looked clean, THIS was -- reverting E's id-specificity fix (which
      // should have failed this) still read 0 FAIL, and a debug trace showed
      // bg/restBg genuinely equal-by-value on the broken build while the
      // comparison still returned true. Same failure shape as comparing two
      // `new Date()` instances with `!==`.
      out.push(verdict("bgChangedFromRest", bg.join(",") !== restBg.join(","), bg, `!= ${restBg}`));
    }
  }
  if (exp.padGteRadiusH === true) {
    if (hostZero) out.push(verdict("padGteRadiusH", false, null, null, zeroNote));
    else {
      const effRadius = Math.min(raw.borderRadius, raw.rect.height / 2);
      const padH = Math.min(raw.paddingLeft, raw.paddingRight);
      out.push(verdict("padGteRadiusH", padH >= effRadius - 0.5, round2(padH), round2(effRadius)));
    }
  }
  if ("padVMin" in exp) {
    if (hostZero) out.push(verdict("padVMin", false, null, exp.padVMin, zeroNote));
    else {
      const padV = Math.min(raw.paddingTop, raw.paddingBottom);
      out.push(verdict("padVMin", padV >= exp.padVMin - 0.01, round2(padV), exp.padVMin));
    }
  }
  // COMPONENTS.md §9 law 3: a list's hover/selected band is INSET -- rounded
  // enough to read at 1x, and held clear of the container on ALL FOUR sides.
  //
  // The first version of this check asked only for `min(marginLeft,
  // marginRight) >= 4` and `borderRadius > 0`, and it passed on an
  // implementation the user rejected on sight (USER CHECKPOINT 2026-08-05):
  // the band was inset 4px inline and 0px block, so it ran flush into the
  // row's top and bottom edges -- "像没对齐" -- and its radius was
  // --lib-radius-sm, which is 2px on paper-ink/dracula/solarized and simply
  // does not read as a corner at 1x. Neither fact violated the old
  // assertion. So the assertion was under-specified, not skipped: both
  // missing halves are now spelled out, `blockInsetPx` and `radiusVar`.
  // `radiusVar` names a RUNG, not a px floor -- an absolute floor would have
  // failed gruvbox-dark, whose md rung is legitimately 2px, and overriding a
  // theme's own ladder is the exact thing §9.2 law 1 forbids.
  // `actual` stays the worst inline inset (the number a fix moves first);
  // the other two failures name themselves in the note.
  if ("insetBand" in exp) {
    const { minInsetPx: min, blockInsetPx = 0, radiusVar = null } = exp.insetBand;
    if (hostZero) out.push(verdict("insetBand", false, null, min, zeroNote));
    else {
      const inline = Math.min(raw.marginLeft, raw.marginRight);
      const block = Math.min(raw.marginTop, raw.marginBottom);
      const notes = [];
      if (block < blockInsetPx - 0.01) notes.push(`block inset ${round2(block)}px < ${blockInsetPx}px -- the band runs flush into the row's top/bottom edges`);
      if (radiusVar) {
        if (raw.radiusVarPx == null) notes.push(`--${radiusVar} did not resolve on <html>`);
        else if (Math.abs(raw.borderRadius - raw.radiusVarPx) > 0.5) notes.push(`border-radius ${round2(raw.borderRadius)}px is not this surface's ${radiusVar} rung (${raw.radiusVarPx}px)`);
      }
      out.push(verdict("insetBand", inline >= min - 0.01 && notes.length === 0, round2(inline), min,
        notes.length ? notes.join("; ") : undefined));
    }
  }
  // ---- bandDistinct: the row states a user has to tell apart at a glance
  // must actually LOOK different, on every theme. Written for the vocabulary
  // list's 2026-08-06 selection rebuild, where "selected" stopped being a
  // checkbox and became the row's own fill -- at which point "selected" and
  // "current" (the row the detail pane is reading) are two accent-tinted
  // fills a token change could quietly collapse into one.
  //
  // A pair passes if EITHER the composited fill differs by at least
  // `minDelta` per-channel-max, OR the two carry different markers
  // (box-shadow/outline). Both halves are needed: the fills are legitimately
  // close on some themes and it is the accent edge that separates them there,
  // while on others there is no edge at all and the fill is the whole signal.
  // Reported `actual` is the WORST pair, so a fix moves the number that is
  // actually failing.
  if ("bandDistinct" in exp) {
    const minDelta = exp.bandDistinct.minDelta;
    const samples = raw.bandSamples || [];
    const notes = [];
    let worst = null;
    if (samples.length < 2) notes.push("fewer than two states captured -- runOneCheck's rowStates driver failed");
    const minText = exp.bandDistinct.minTextContrast;
    if (minText) {
      for (const sm of samples) {
        if (!sm.found) continue;
        if (!sm.text) { notes.push(`"${sm.state}": textSelector matched nothing`); continue; }
        const tbg = compositeStack(sm.text.bgStack);
        const fg = resolveColor(sm.text.color, tbg);
        const ratio = fg ? cr(fg, tbg) : 0;
        if (ratio < minText) notes.push(`"${sm.state}": row text ${round2(ratio)}:1 < ${minText}:1 against its own band`);
      }
    }
    // Pairs the checklist names as FILL-ONLY: the marker escape hatch is
    // switched off for them, so the fill itself has to clear minDelta.
    // Without this the "OR a different marker" clause silently disarms the
    // check for exactly the pair whose fill was the thing being tuned --
    // independent review proved it by reverting the selected band from 18%
    // to 10% and watching the gate stay green, because `selected` carries a
    // ring that `rest` does not and the delta branch was therefore never
    // reached. Ask what the simplest missed counter-example looks like.
    const fillOnly = new Set((exp.bandDistinct.fillOnlyPairs || []).map((pair) => [...pair].sort().join("~")));
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) {
        const a = samples[i], b = samples[j];
        if (!a.found || !b.found) { notes.push(`state not rendered: ${a.found ? b.state : a.state}`); continue; }
        const abg = compositeStack(a.bgStack), bbg = compositeStack(b.bgStack);
        const delta = Math.max(Math.abs(abg[0] - bbg[0]), Math.abs(abg[1] - bbg[1]), Math.abs(abg[2] - bbg[2]));
        const fillMustCarry = fillOnly.has([a.state, b.state].sort().join("~"));
        const markerDiffers = !fillMustCarry && (a.boxShadow !== b.boxShadow || a.outline !== b.outline);
        if (worst === null || delta < worst) worst = delta;
        if (delta < minDelta && !markerDiffers) {
          notes.push(fillMustCarry
            ? `"${a.state}" and "${b.state}" must be told apart by FILL alone: delta ${round2(delta)} < ${minDelta} (this pair's marker is excluded on purpose -- the band is the whole signal)`
            : `"${a.state}" and "${b.state}" are indistinguishable: fill delta ${round2(delta)} < ${minDelta} and identical marker (box-shadow ${a.boxShadow})`);
        }
      }
    }
    out.push(verdict("bandDistinct", notes.length === 0, worst === null ? null : round2(worst), minDelta,
      notes.length ? notes.join("; ") : undefined));
  }
  // COMPONENTS.md §9 law 7: a tab is a label plus a selection edge, never a
  // button wearing a tab label. Selected = an accent underline of at least
  // `underlinePx`; unselected = no underline. BOTH branches additionally
  // assert "no shell", which is the half that actually regressed (the
  // pre-2026-08-05 tabs carried a fill, a border and a radius).
  if ("tabChrome" in exp) {
    const want = exp.tabChrome.activeUnderline;
    if (hostZero) out.push(verdict("tabChrome", false, null, want, zeroNote));
    else {
      const alpha = (c) => { const m = /rgba?\([^)]*?,\s*([0-9.]+)\s*\)/.exec(c || ""); return m ? parseFloat(m[1]) : (c && c !== "transparent" ? 1 : 0); };
      const underline = alpha(raw.borderBottomColor) > 0 ? raw.borderBottomWidth : 0;
      const notes = [];
      if (alpha(raw.backgroundColor) > 0) notes.push(`tab paints a fill (${raw.backgroundColor}) -- a tab has no shell`);
      if (raw.borderRadius > 0) notes.push(`tab has border-radius ${round2(raw.borderRadius)}px -- a tab has no shell`);
      const okUnderline = want ? underline >= (exp.tabChrome.underlinePx ?? 2) - 0.01 : underline === 0;
      if (!okUnderline) notes.push(want ? `selected tab underline is ${round2(underline)}px` : `unselected tab paints a ${round2(underline)}px underline`);
      out.push(verdict("tabChrome", notes.length === 0, round2(underline), want, notes.length ? notes.join("; ") : undefined));
    }
  }
  if ("heightEqWith" in exp) {
    const { selector: cmpSel, tolerancePx } = exp.heightEqWith;
    if (hostZero) out.push(verdict("heightEqWith", false, null, tolerancePx, zeroNote));
    else if (raw.compareRect == null) {
      out.push(verdict("heightEqWith", false, null, tolerancePx, `comparison selector not found: ${cmpSel}`));
    } else if (raw.compareRect.height === 0) {
      out.push(verdict("heightEqWith", false, null, tolerancePx, `comparison element is zero-size: ${cmpSel}`));
    } else {
      const diff = Math.abs(raw.rect.height - raw.compareRect.height);
      out.push(verdict("heightEqWith", diff <= tolerancePx, round2(diff), tolerancePx));
    }
  }
  // heightPx / fontSizePx / fontVariantNumericContains (D6/D7, Task 5,
  // taste-uplift batch3): literal geometry/typography assertions -- no
  // existing chip check needed one (.vocab-group-chip/.tag-gov-chip-face
  // only prove their rung indirectly via padVMin+padGteRadiusH below), but
  // COMPONENTS.md §5.1's "18px, no border" chip rung and .stag-num's
  // tabular-nums have no such proxy.
  if ("heightPx" in exp) {
    const { value, tolerancePx = 1 } = exp.heightPx;
    if (hostZero) out.push(verdict("heightPx", false, null, value, zeroNote));
    else out.push(verdict("heightPx", Math.abs(raw.rect.height - value) <= tolerancePx, round2(raw.rect.height), value));
  }
  // widthPx (T6, taste-uplift-batch3, D2): a content-kind field's measured
  // width must not EXCEED its max-width tier (COMPONENTS.md §6, the
  // composer's new per-kind ui-components.mjs rules) -- unlike heightPx
  // above (a literal target value, |diff| <= tolerance, since a chip's
  // height IS its geometry), this is a one-sided ceiling: `max-width` never
  // forces a field WIDER than its container, so the same field legitimately
  // renders narrower than `max` on a viewport too small for the cap to even
  // engage (D2's "still 100% on narrow viewports" requirement) -- FAILing
  // that would be asserting the wrong thing. No new probe slot needed: it
  // reads the SAME raw.rect.width heightPx's raw.rect.height sibling
  // already carries out of probeSelector, so there is no extraBgVarName/
  // extraColorVarName-shaped ambiguity for this key to guard against.
  if ("widthPx" in exp) {
    const { max, tolerancePx = 0.5 } = exp.widthPx;
    if (hostZero) out.push(verdict("widthPx", false, null, max, zeroNote));
    else out.push(verdict("widthPx", raw.rect.width <= max + tolerancePx, round2(raw.rect.width), max));
  }
  if ("fontSizePx" in exp) {
    const { value, tolerancePx = 0.5 } = exp.fontSizePx;
    out.push(verdict("fontSizePx", Math.abs(raw.fontSize - value) <= tolerancePx, round2(raw.fontSize), value));
  }
  if ("fontVariantNumericContains" in exp) {
    const want = exp.fontVariantNumericContains;
    const got = raw.fontVariantNumeric || "";
    out.push(verdict("fontVariantNumericContains", got.includes(want), got, want));
  }
  // textDecorationLineContains (T5 fix round F6): `.stag.used` (popup.css)
  // renders a struck-through label -- `text-decoration-line` computes as a
  // space-joined token list (e.g. "line-through" or, if it ever combined with
  // underline, "underline line-through"), so this is a substring/contains
  // check like fontVariantNumericContains above, not an equality check.
  if ("textDecorationLineContains" in exp) {
    const want = exp.textDecorationLineContains;
    const got = raw.textDecorationLine || "";
    out.push(verdict("textDecorationLineContains", got.includes(want), got, want));
  }
  // bgEqVar / colorEqVar (D6/D7, Task 5): a chip's fill/text isn't just "some
  // AA-passing pair" (textContrast already proves that) -- it must be THIS
  // theme's --{ns}-chip-bg / --{ns}-chip-fg / --{ns}-ai-chip-fg token,
  // verbatim, not a coincidentally-similar colour. Reuses parseSolidColor
  // (textContrastMulti's own primitive -- a CSS custom property is a solid
  // theme token, never a foreground painted over something, so no
  // compositing is needed) against the SAME element's own measured fill/
  // text. ±1 per channel tolerance is browser rounding headroom only -- both
  // sides are literal hex-derived rgb triples with no alpha compositing.
  // colorEqVar reads its OWN extraColorRaw slot, NOT extraBgRaw -- a single
  // check (popup's `.stag`) legitimately sets both bgEqVar AND colorEqVar at
  // once (two DIFFERENT tokens, chip-bg and chip-fg), and sharing one slot
  // between them silently made colorEqVar compare against whichever token
  // bgEqVar had already claimed (caught live before this was fixed: `.stag`
  // read chip-BG's hex while its verdict note claimed "chip-fg").
  function colorsEqual(a, b) { return !!a && !!b && a.every((c, i) => Math.abs(c - b[i]) <= 1); }
  if ("bgEqVar" in exp) {
    const want = parseSolidColor(raw.extraBgRaw);
    const got = parseSolidColor(raw.backgroundColor);
    const note = !want ? `--${exp.bgEqVar} token unresolved (raw=${JSON.stringify(raw.extraBgRaw)})` : undefined;
    out.push(verdict("bgEqVar", colorsEqual(want, got), raw.backgroundColor, `var(--...-${exp.bgEqVar})=${raw.extraBgRaw}`, note));
  }
  if ("colorEqVar" in exp) {
    const want = parseSolidColor(raw.extraColorRaw);
    const got = parseSolidColor(raw.color);
    const note = !want ? `--${exp.colorEqVar} token unresolved (raw=${JSON.stringify(raw.extraColorRaw)})` : undefined;
    out.push(verdict("colorEqVar", colorsEqual(want, got), raw.color, `var(--...-${exp.colorEqVar})=${raw.extraColorRaw}`, note));
  }
  if ("hitAreaMin" in exp) {
    if (hostZero) out.push(verdict("hitAreaMin", false, null, exp.hitAreaMin, zeroNote));
    else {
      // effRect (not raw.rect): includes the §1.5 ::before hit-area expansion
      // when present, see probeSelector's comment for the exact shape this
      // measures.
      const shortSide = Math.min(raw.effRect.width, raw.effRect.height);
      out.push(verdict("hitAreaMin", shortSide >= exp.hitAreaMin, round2(shortSide), exp.hitAreaMin));
    }
  }
  if (exp.widthLtParent === true) {
    // Flex-column stretch regression guard (COMPONENTS.md's chip family,
    // Appendix C10 fix round): a flex ITEM is always block-level regardless
    // of its own inline-flex/inline-block display value (CSS Display §2.7),
    // so a column-direction flex container's default `align-items: stretch`
    // silently fills the child to 100% width unless something (a real
    // `width` declaration -- not the child's display value) opts out.
    // Asserts the element reads as content-sized, not container-filling: a
    // >=8px margin from the parent's CONTENT-box width (raw.parentRect,
    // see probeSelector) clears normal text-content variance while still
    // catching a full stretch -- a stretched child's border-box width
    // equals exactly the parent's content-box width, so this margin has
    // nothing else eating into it (unlike comparing against border-box
    // width, where the parent's own padding+border could exceed 8px and
    // let a stretched child pass unnoticed).
    if (hostZero || !raw.parentRect || raw.parentRect.width === 0) {
      out.push(verdict("widthLtParent", false, null, null, hostZero ? zeroNote : "no parent element found"));
    } else {
      const ok = raw.rect.width <= raw.parentRect.width - 8;
      out.push(verdict("widthLtParent", ok, round2(raw.rect.width), round2(raw.parentRect.width)));
    }
  }
  if ("textInset" in exp) {
    // §7.6 textInset (Task 14 sweep -- generalized from the options
    // preset-preview summary bug: an ID-selector override zeroed its
    // horizontal padding, so the label text sat flush against the bordered
    // box's edge). `h`/`v` are px floors on the SMALLER of the two opposing
    // insets (left vs right, top vs bottom) so asymmetric padding can't hide
    // a real violation on one side.
    const { h, v } = exp.textInset;
    const label = `h>=${h},v>=${v}`;
    if (hostZero) out.push(verdict("textInset", false, null, label, zeroNote));
    else if (!raw.textInset) out.push(verdict("textInset", false, null, label, "no direct text node found on this element"));
    else {
      const minH = Math.min(raw.textInset.left, raw.textInset.right);
      const minV = Math.min(raw.textInset.top, raw.textInset.bottom);
      const ok = minH >= h - 0.5 && minV >= v - 0.5;
      out.push(verdict("textInset", ok, `h=${round2(minH)},v=${round2(minV)}`, label));
    }
  }
  if (exp.childContainment === true) {
    // §7.6 childContainment (Task 14 sweep -- the same bug's other half: the
    // zeroed padding left no room for the ::after chevron's rotated bbox,
    // which then painted past the border on the right). Every icon/pseudo
    // child (svg, ::before, ::after) must stay inside the host's border-box,
    // ±1px tolerance for subpixel rounding.
    const label = "⊆ host border-box (±1px)";
    if (hostZero) out.push(verdict("childContainment", false, null, label, zeroNote));
    else if (!raw.containmentChildren || !raw.containmentChildren.length) {
      out.push(verdict("childContainment", false, null, label, "no icon/pseudo child found (svg absent, ::before/::after both content:none)"));
    } else {
      const tol = 1;
      const hostRight = raw.rect.left + raw.rect.width, hostBottom = raw.rect.top + raw.rect.height;
      const bad = [];
      for (const c of raw.containmentChildren) {
        const over = {
          left: raw.rect.left - c.rect.left, right: c.rect.right - hostRight,
          top: raw.rect.top - c.rect.top, bottom: c.rect.bottom - hostBottom,
        };
        if (over.left > tol || over.right > tol || over.top > tol || over.bottom > tol) {
          bad.push(`${c.kind}:L${round2(over.left)}/R${round2(over.right)}/T${round2(over.top)}/B${round2(over.bottom)}`);
        }
      }
      out.push(verdict("childContainment", bad.length === 0, bad.length ? bad.join(";") : "contained", label));
    }
  }
  if ("textContrastMulti" in exp) {
    const { ratio, extraBgSelectorVar } = exp.textContrastMulti;
    if (disabledSkip) out.push(skip("textContrastMulti", ratio, "disabled (WCAG 1.4.3 exempt)"));
    else {
      const fg1 = resolveColor(raw.color, bg);
      const ratio1 = fg1 ? cr(fg1, bg) : 0;
      const extraBg = parseSolidColor(raw.extraBgRaw);
      if (!extraBg) {
        // Never silently drop the second background: WARN via the note,
        // and the verdict is only the single-background result.
        out.push(verdict("textContrastMulti", ratio1 >= ratio, round2(ratio1), ratio,
          `WARN: --${extraBgSelectorVar} token unresolved (raw=${JSON.stringify(raw.extraBgRaw)}) -- checked chip-bg only, NOT the second background`));
      } else {
        const fg2 = resolveColor(raw.color, extraBg);
        const ratio2 = fg2 ? cr(fg2, extraBg) : 0;
        const ok = ratio1 >= ratio && ratio2 >= ratio;
        out.push(verdict("textContrastMulti", ok, round2(Math.min(ratio1, ratio2)), ratio,
          `chip-bg=${round2(ratio1)}:1, ${extraBgSelectorVar}=${round2(ratio2)}:1`));
      }
    }
  }
  // beforeExists (design-uplift, preset-row redesign, 2026-08-04): asserts a
  // host's ::before pseudo-element actually renders (non-zero size), not
  // just that `content` is declared -- reuses the --sweep discovery mode's
  // own measurePseudo("::before") result (containmentChildren), which
  // already excludes a `content:""` rule that never got a real box (e.g. a
  // selector typo or a display:none ancestor). Preset row's swatch dot is
  // the first consumer: `.preset-btn::before` / `.theme-preset-btn::before`
  // have no other DOM signal a render oracle can key off of (pseudo-elements
  // aren't `document.querySelector`-able).
  if (exp.beforeExists === true) {
    const ok = raw.containmentChildren.some((c) => c.kind === "::before");
    out.push(verdict("beforeExists", ok, ok, true, ok ? null : "no rendered ::before pseudo-element (zero-size or content:none)"));
  }
  // outlineContrast (design-uplift, preset-row redesign, 2026-08-04): the
  // selection ring's outline-color vs the REAL composited background it
  // paints over. Deliberately NOT bg (bgStack composited through the host's
  // OWN background, i.e. compositeStack(raw.bgStack)) -- outline-offset:2px
  // (COMPONENTS.md's "ring 不贴内容" contract) puts the ring OUTSIDE the
  // host's border box, sitting on the PARENT's paint, not under the host's
  // own fill. bgStack[0] is the host's own backgroundColor (probeSelector
  // walks self -> parent -> ...), so slicing it off before compositing is
  // the one-line fix that makes this the parent-and-up stack instead.
  // WCAG 1.4.11 non-text 3:1 floor, same class as focusRingContrast
  // (COMPONENTS.md §3.3) -- scoped to the preset row's .active ring here,
  // not a blanket audit of every existing accent-colored outline in the
  // codebase (out of scope for this change; see preset-variants-report.md).
  if ("outlineContrast" in exp) {
    if (disabledSkip) out.push(skip("outlineContrast", exp.outlineContrast, "disabled (WCAG 1.4.3 exempt)"));
    else if (!raw.outlineStyle || raw.outlineStyle === "none") {
      out.push(verdict("outlineContrast", false, null, exp.outlineContrast, "no outline rendered (outline-style: none)"));
    } else {
      const parentBg = compositeStack(raw.bgStack.slice(1));
      const oc = resolveColor(raw.outlineColor, parentBg);
      const ratio = oc ? cr(oc, parentBg) : 0;
      out.push(verdict("outlineContrast", ratio >= exp.outlineContrast, round2(ratio), exp.outlineContrast));
    }
  }
  if (exp.colorSchemeMatchesTheme === true) {
    const expectedScheme = isDarkTheme(theme) ? "dark" : "light";
    const actual = raw.rootColorScheme || "";
    out.push(verdict("colorSchemeMatchesTheme", actual.includes(expectedScheme), actual, expectedScheme));
  }
  // ---- §8 fused-control laws (design-uplift 2026-08-05) ----
  // law 1 + law 3, measured on the passengers: a fused control's pieces draw
  // no box of their own (no radius, no fill, and at most the ONE border side
  // that acts as the divider), and every divider that is drawn agrees on
  // colour and width. The "at most one side" shape is what distinguishes a
  // divider from a box -- requiring a flat zero would outlaw the divider the
  // law explicitly permits.
  if (exp.fusedChildrenFlat) {
    const want = exp.fusedChildrenFlat.children || [];
    // COMPONENTS.md §9.2 law 2 exception (independent review F1, hit-area-
    // debt): law 1's "no independent radius" below has one documented carve-
    // out -- the FIRST and LAST cell of a shell whose corners touch the
    // shell's own rounded edge may round exactly those two OUTER corners
    // (TL+BL for the first cell, TR+BR for the last) to nest concentrically
    // inside it. Every other corner, on every cell, must still be exactly 0
    // -- this is opt-in per checklist entry (`concentricEnds: true`) so
    // every OTHER fused control (e.g. .notes-hit-btn) keeps the strict
    // all-zero rule with no change here.
    const concentricEnds = !!exp.fusedChildrenFlat.concentricEnds;
    const got = raw.children || [];
    const bad = [];
    const dividers = [];
    want.forEach((sel, idx) => {
      const c = got.find((x) => x.sel === sel);
      if (!c) { bad.push(`${sel}: not probed`); return; }
      if (!c.found) { bad.push(`${sel}: not found inside host`); return; }
      const sides = c.borderWidths
        .map((w, i) => ({ w, style: c.borderStyles[i], color: c.borderColors[i] }))
        .filter((s) => s.w > 0 && s.style !== "none");
      if (sides.length > 1) bad.push(`${sel}: ${sides.length} border sides (max 1 divider)`);
      // Radii index order matches probeSelector's [TL, TR, BR, BL].
      const allowedRadiusIdx = concentricEnds
        ? (idx === 0 ? [0, 3] : idx === want.length - 1 ? [1, 2] : [])
        : [];
      if (c.radii.some((r, i) => r > 0 && !allowedRadiusIdx.includes(i))) {
        bad.push(`${sel}: own border-radius ${c.radii.join("/")}`);
      }
      // alpha 0 == "transparent". A passenger that paints its own resting
      // fill is drawing chrome, which is the shell's job. Selected cells are
      // exempt (see isSelected in probeSelector): their fill IS the selection
      // state, not chrome.
      if (!c.isSelected) {
        const m = /rgba?\(([^)]+)\)/.exec(c.background || "");
        const alpha = m ? (parseFloat(m[1].split(",")[3]) || (m[1].split(",").length < 4 ? 1 : 0)) : 1;
        if (alpha > 0) bad.push(`${sel}: own resting background ${c.background}`);
      }
      for (const s of sides) dividers.push(`${s.w}px ${s.color}`);
    });
    const uniqueDividers = [...new Set(dividers)];
    if (uniqueDividers.length > 1) bad.push(`dividers disagree: ${uniqueDividers.join(" vs ")}`);
    out.push(verdict("fusedChildrenFlat", bad.length === 0, bad.length ? bad.join("; ") : `${want.length} flat, divider=${uniqueDividers[0] || "none"}`, true));
  }
  // edgeClickable (independent review F2, hit-area-debt): hitAreaMin's
  // family-4 sweep and this checklist's per-selector geometry both only
  // read the ::before pad's COMPUTED width/height -- proof the BOX grew,
  // not that a pointer event landed there. A fused shell's `overflow`
  // clips exactly that silently (F1's own root cause: reverting
  // `.vocab-sort-seg`/`.vocab-group-unit` to `overflow: hidden` leaves
  // hitAreaMin's computed-style number unchanged while real clicks 1-2px
  // past the border-box start missing). probeSelector already sampled two
  // points just past each named cell's own top edge (§1.5's pads on these
  // two shells are vertical-only) and recorded whether elementFromPoint
  // resolved inside that cell; this just asserts the wired-through result.
  if (exp.edgeClickable) {
    const want = exp.edgeClickable.children || [];
    const got = raw.children || [];
    const bad = [];
    for (const sel of want) {
      const c = got.find((x) => x.sel === sel);
      if (!c) { bad.push(`${sel}: not probed`); continue; }
      if (!c.found) { bad.push(`${sel}: not found inside host`); continue; }
      if (!c.edgeHit || !c.edgeHit.ok) {
        const missed = (c.edgeHit?.points || []).filter((p) => !p.ok)
          .map((p) => `(${p.x},${p.y})->${p.hitPath || "nothing"}`).join(", ");
        bad.push(`${sel}: edge point(s) missed the cell -- ${missed || "no edgeHit data"}`);
      }
    }
    out.push(verdict("edgeClickable", bad.length === 0, bad.length ? bad.join("; ") : `${want.length} cell(s), all edge points resolve inside`, true));
  }
  // law 2, measured on the shell while a passenger holds focus. Three things
  // have to hold at once, and the third is the one the user actually reported
  // twice: a ring drawn on an inner piece stops short of the unit and gets
  // painted over by its neighbour, so the ring MUST be the shell's own and
  // MUST grow outward from the shell's border box (outline-offset >= 0, or a
  // non-inset box-shadow) rather than inward.
  if (exp.fusedFocusRing === true) {
    const bad = [];
    const hasOutline = raw.outlineStyle && raw.outlineStyle !== "none" && raw.outlineWidth > 0;
    const hasShadow = raw.boxShadow && raw.boxShadow !== "none";
    if (!hasOutline && !hasShadow) bad.push("shell renders no focus indicator (:focus-within not firing?)");
    if (hasOutline && raw.outlineOffset < 0) bad.push(`shell outline-offset ${raw.outlineOffset}px pulls the ring inside its own box`);
    if (!hasOutline && hasShadow && /inset/.test(raw.boxShadow)) bad.push("shell ring is an INSET shadow (paints inside the border box)");
    // the shell must actually have CHANGED -- an unconditional border colour
    // would satisfy "has an indicator" while :focus-within did nothing.
    if (raw.focusBaseline) {
      const same = raw.focusBaseline.borderColors === raw.borderColors
        && raw.focusBaseline.boxShadow === raw.boxShadow
        && raw.focusBaseline.outlineStyle === raw.outlineStyle;
      if (same) bad.push("shell computed style identical focused vs unfocused (:focus-within has no effect)");
    } else {
      bad.push("no unfocused baseline captured (runner did not pre-probe)");
    }
    if (raw.focusedSelf && raw.focusedSelf.found === false) bad.push(`focus target ${raw.focusedSelf.sel} not found`);
    else if (raw.focusedSelf) {
      if (!raw.focusedSelf.isActiveElement) bad.push(`${raw.focusedSelf.sel} is not document.activeElement`);
      // The segment MAY carry the standard button ring to say which piece
      // holds focus (user ruling, round 6: an invented per-segment vocabulary
      // -- a fill, then an underline -- was rejected twice; the answer is the
      // language used everywhere else, not a new one). What it may not do is
      // let that ring grow OUTWARD, where it would cross the shell's chrome
      // and collide with the shell's own :focus-within ring. So the rule is
      // no longer "no outline" but "any outline must be inset".
      if (raw.focusedSelf.outlineStyle !== "none" && raw.focusedSelf.outlineWidth > 0
          && raw.focusedSelf.outlineOffset >= 0) {
        bad.push(`${raw.focusedSelf.sel} draws a ${raw.focusedSelf.outlineWidth}px outline at offset `
          + `${raw.focusedSelf.outlineOffset}px -- a segment's ring must be inset (negative offset) so it stays inside the unit`);
      }
      if (raw.focusedSelf.boxShadow && raw.focusedSelf.boxShadow !== "none") {
        bad.push(`${raw.focusedSelf.sel} paints its own box-shadow (${raw.focusedSelf.boxShadow}) -- `
          + `inset shadows on fractionally positioned segments leak sub-pixel hairlines, use an inset outline`);
      }
    }
    out.push(verdict("fusedFocusRing", bad.length === 0, bad.length ? bad.join("; ") : `shell ring ok (${hasOutline ? `outline ${raw.outlineWidth}px @${raw.outlineOffset}` : "box-shadow"})`, true));
  }
  // §8 law 6: rest <-> focus state stability. Three invariants, all measured
  // on the same elements in both passes:
  //   (1) zero displacement -- every rect (shell and each named segment)
  //       identical to the subpixel. border-WIDTH changes are the usual
  //       culprit, so widths are reported alongside to name the cause.
  //   (2) no repaint -- background-color unchanged on shell and segments.
  //   (3) the trailing icon does not move -- svg centre unchanged.
  if (exp.fusedStateStable === true) {
    const bad = [];
    const a = raw.stabilityBaseline, b = raw.stability;
    if (!a || !b) bad.push("no rest baseline captured (runner did not pre-probe)");
    else {
      const cmp = (label, x, y) => {
        if (!x || !y) return;
        if (JSON.stringify(x.rect) !== JSON.stringify(y.rect)) {
          bad.push(`${label} moved/resized ${JSON.stringify(x.rect)} -> ${JSON.stringify(y.rect)}`
            + (x.borderWidths !== y.borderWidths ? ` (border-width ${x.borderWidths} -> ${y.borderWidths})` : ""));
        } else if (x.borderWidths !== y.borderWidths) {
          bad.push(`${label} border-width ${x.borderWidths} -> ${y.borderWidths}`);
        }
        if (x.bg !== y.bg) bad.push(`${label} background ${x.bg} -> ${y.bg}`);
        if (JSON.stringify(x.svgCenter) !== JSON.stringify(y.svgCenter)) {
          bad.push(`${label} icon centre ${JSON.stringify(x.svgCenter)} -> ${JSON.stringify(y.svgCenter)}`);
        }
      };
      cmp("shell", a.self, b.self);
      for (const cb of b.children) {
        const ca = (a.children || []).find((x) => x.sel === cb.sel);
        if (!ca || !ca.found || !cb.found) { bad.push(`${cb.sel}: not probed in both passes`); continue; }
        cmp(cb.sel, ca, cb);
      }
    }
    out.push(verdict("fusedStateStable", bad.length === 0, bad.length ? bad.join("; ") : "rest == focus (rect, bg, icon)", true));
  }
  // §7.3 focus-ring conformance (2026-08-06: ONE language, three PLACEMENTS).
  // Measured on the focused element itself (state "focusWithin" with
  // focusTarget ":scope"), so what is checked is the shape the LIVE cascade
  // produced, not the shape some rule declares.
  //   bordered   the control's own frame is the core: outline suppressed,
  //              border-color moves to --{ns}-focus-bd, --{ns}-focus-ring glow
  //   borderless no frame to re-tint: 1px accent core growing outward + glow
  //   inset      list rows and fused cells: 2px core pulled INSIDE the box,
  //              no shadow (these elements' selected/current states already
  //              own box-shadow and a second one would replace it)
  //
  // DELIBERATELY SHAPE-AGNOSTIC about the glow. --{ns}-focus-ring is per-theme
  // IDENTITY, not a constant: terminal ships a 6px phosphor blur, paper-ink a
  // flat `0 0 0 1px`, solarized a translucent `0 0 0 2px`. Asserting any one
  // literal would either fail 13 themes or force them all to look alike. What
  // IS asserted is theme-invariant: a non-inset shadow exists, and it is
  // DIFFERENT from the same element's unfocused baseline -- which is what
  // proves the focus rule fired and that the value came from the token rather
  // than from some unrelated resting shadow.
  if (exp.focusRecipe) {
    const hasOutline = raw.outlineStyle && raw.outlineStyle !== "none" && raw.outlineWidth > 0;
    const hasShadow = raw.boxShadow && raw.boxShadow !== "none" && !/inset/.test(raw.boxShadow);
    const base = raw.focusBaseline;
    const shadowChanged = base ? base.boxShadow !== raw.boxShadow : false;
    const bad = [];
    if (!base) bad.push("no unfocused baseline captured (runner did not pre-probe)");
    if (exp.focusRecipe === "bordered") {
      if (hasOutline) bad.push(`draws a ${raw.outlineWidth}px outline (the bordered placement suppresses it — the frame IS the core)`);
      if (!hasShadow) bad.push("no --focus-ring glow");
      if (base && !shadowChanged) bad.push("box-shadow identical focused vs unfocused (focus rule never fired)");
      if (base && base.borderColors === raw.borderColors) {
        bad.push("border-color unchanged on focus — a themed rest rule is probably out-ranking the focus rule");
      }
    } else if (exp.focusRecipe === "borderless") {
      if (!hasOutline) bad.push("no outline core (the glow alone is not a legible indicator)");
      else if (raw.outlineOffset < 0) bad.push(`outline-offset ${raw.outlineOffset}px pulls the core inward (that is the inset placement)`);
      if (!hasShadow) bad.push("no --focus-ring glow (borderless is core + glow)");
      if (base && !shadowChanged) bad.push("box-shadow identical focused vs unfocused (focus rule never fired)");
    } else if (exp.focusRecipe === "inset") {
      if (!hasOutline) bad.push("no outline core");
      else if (raw.outlineWidth < 2) bad.push(`outline ${raw.outlineWidth}px < 2px`);
      else if (raw.outlineOffset >= 0) bad.push(`outline-offset ${raw.outlineOffset}px grows outward — an inset core must stay inside its own box`);
      if (hasShadow) bad.push(`paints a non-inset box-shadow (${raw.boxShadow}) — the inset placement is outline-only so it cannot collide with a row's selected-state shadow`);
    } else {
      bad.push(`unknown focusRecipe "${exp.focusRecipe}"`);
    }
    // When the probed element is NOT the focus target, the ring is being
    // carried on behalf of a passenger (§8 law 2: .notes-card-head defers its
    // ring to the whole row, because the head spans only the first of the
    // row's three grid columns). Then the passenger must draw nothing of its
    // own -- otherwise the result is the two-rings-at-once defect, which a
    // check that only looked at the carrier would happily pass.
    const passenger = raw.focusedSelf;
    if (passenger && passenger.found !== false && exp.focusRecipe !== undefined
        && passenger.sel !== ":scope") {
      if (passenger.outlineStyle !== "none" && passenger.outlineWidth > 0) {
        bad.push(`${passenger.sel} draws its own ${passenger.outlineWidth}px outline as well — the ring is carried by ${check.selector}, so the passenger must draw none`);
      }
      if (passenger.boxShadow && passenger.boxShadow !== "none") {
        bad.push(`${passenger.sel} paints its own box-shadow (${passenger.boxShadow}) alongside the carried ring`);
      }
    }
    out.push(verdict("focusRecipe", bad.length === 0, bad.length ? bad.join("; ")
      : `${exp.focusRecipe}: outline=${hasOutline ? raw.outlineWidth + "px@" + raw.outlineOffset : "none"} shadow=${hasShadow ? "changed" : "no"}`, exp.focusRecipe));
  }
  // §8 law 2, BUTTON flavour (2026-08-06). A fused unit that takes no text
  // entry draws NO shell ring: the focused cell's own inset ring is the whole
  // indicator. Both halves are asserted, because either one alone is the
  // defect the user reported -- a shell ring with no cell ring cannot say
  // WHICH cell has focus, and a shell ring PLUS a cell ring is the double
  // rectangle that got .vocab-sort-seg rejected.
  if (exp.fusedSegmentRing === true) {
    const bad = [];
    const base = raw.focusBaseline;
    if (!base) bad.push("no unfocused baseline captured (runner did not pre-probe)");
    else {
      const shellChanged = base.borderColors !== raw.borderColors
        || base.boxShadow !== raw.boxShadow || base.outlineStyle !== raw.outlineStyle;
      if (shellChanged) {
        bad.push(`shell reacted to focus (border ${base.borderColors} -> ${raw.borderColors}, `
          + `shadow ${base.boxShadow} -> ${raw.boxShadow}, outline ${base.outlineStyle} -> ${raw.outlineStyle}) `
          + "— a pure button group's indicator belongs on the focused cell only");
      }
    }
    const f = raw.focusedSelf;
    if (!f || f.found === false) bad.push(`focus target ${f ? f.sel : "(none)"} not found`);
    else {
      if (!f.isActiveElement) bad.push(`${f.sel} is not document.activeElement`);
      if (f.outlineStyle === "none" || !(f.outlineWidth > 0)) bad.push(`${f.sel} draws no ring of its own`);
      else if (f.outlineOffset >= 0) bad.push(`${f.sel} ring grows outward (offset ${f.outlineOffset}px) — it must stay inside the cell`);
      if (f.boxShadow && f.boxShadow !== "none") {
        bad.push(`${f.sel} paints its own box-shadow (${f.boxShadow}) — inset shadows leak sub-pixel hairlines on fractionally positioned cells`);
      }
    }
    out.push(verdict("fusedSegmentRing", bad.length === 0, bad.length ? bad.join("; ")
      : `cell ring only (${raw.focusedSelf?.outlineWidth}px @${raw.focusedSelf?.outlineOffset})`, true));
  }
  return { results: out };
}

// COMPONENTS.md's `{ns}` notation: the token-name prefix each surface's
// generated CSS variables use (--lib-*/--opt-*/--pp-*). Only textContrastMulti
// needs this (to turn a checklist-declared role like "btn-hover" into the
// actual custom-property name to read).
const NS_BY_SURFACE = { library: "lib", options: "opt", popup: "pp" };

// ---- state: "rowStates" (2026-08-06 selection rebuild) -------------------
// Reads ONE row's band four times, driving it through every state a user can
// put it in with the real gestures: nothing, Ctrl+click (selected), plain
// click (activates the detail -> selected AND current), Ctrl+click again
// (current only). aria-current is exclusive and the fixture seeds one word,
// so the states cannot coexist on screen -- but they do not need to: what
// has to be true is that a user can TELL THEM APART, which is a statement
// about four fills and four markers, not about four simultaneous rows.
//
// Everything here is a real product gesture, including the reload that gets
// back to "rest" (there is no un-activate control above 860px). The sequence
// ends on selected+current, byte-for-byte the state runLibraryTheme's own
// setup clicks produce, so every later check in the same theme pass sees the
// page it expects.
async function driveRowStates(page, extBase, theme, selector, textSelector) {
  const read = (sel, textSel, state) => page.evaluate(({ sel, textSel, state }) => {
    const stackOf = (node) => {
      const out = [];
      for (let n = node; n && n.nodeType === 1; n = n.parentElement) out.push(getComputedStyle(n).backgroundColor);
      return out;
    };
    const el = document.querySelector(sel);
    if (!el) return { state, found: false };
    const cs = getComputedStyle(el);
    // The row's text has to stay readable in EVERY state, not just the one
    // the page happens to load in -- a band fill that gets strong enough to
    // separate two states can just as easily eat its own label.
    const textEl = textSel ? el.querySelector(textSel) : null;
    return {
      state, found: true, bgStack: stackOf(el), boxShadow: cs.boxShadow,
      outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
      text: textEl ? { color: getComputedStyle(textEl).color, bgStack: stackOf(textEl) } : null,
    };
  }, { sel, textSel, state });

  // Both library lists share one selection grammar, so one driver serves both;
  // the view is read off the selector the same way runLibraryTheme reads it.
  const view = libraryView(selector);
  const rowSel = view === "notes" ? "#notes-list .notes-hit-btn" : "#vocab-list .vocab-card .notes-card-head";
  // The query carries the VIEW as well as the theme. Without it the notes pass
  // and the vocab pass differ only by fragment, and Chromium then treats the
  // second goto as a same-document navigation and never reloads -- so the
  // notes driver would inherit whatever aria-current the vocab pass (and the
  // setup clicks before it) had already put on a row, and read its very first
  // "rest" sample out of an already-current row. Same footgun runLibraryTheme
  // documents at its own goto.
  await page.goto(`${extBase}library.html?_ra=${encodeURIComponent(theme)}-band-${view}#${view}`, { waitUntil: "load", timeout: TIMEOUT_MS });
  await page.waitForSelector(rowSel, { timeout: TIMEOUT_MS });
  await page.waitForTimeout(300);
  const head = page.locator(rowSel).first();
  if (!(await head.count())) {
    throw new Error(`SETUP: no ${view} row to drive rowStates on (theme=${theme})`);
  }
  // Park the pointer in a dead corner before every read. A click leaves the
  // cursor sitting ON the row, so without this each sample is really that
  // state's HOVER variant -- and each state has a different hover formula, so
  // the whole comparison would be between four numbers none of which is the
  // state it claims to be. (Found the hard way: "current" measured 4.45:1
  // text contrast, which is the hover mix, while the token derivation that
  // actually guarantees 4.5:1 targets the resting fill.)
  const settle = async () => { await page.mouse.move(0, 0); await page.waitForTimeout(280); };
  await settle();
  const samples = [await read(selector, textSelector, "rest")];
  await head.click({ modifiers: ["Control"] }); await settle();
  samples.push(await read(selector, textSelector, "selected"));
  await head.click(); await settle();
  samples.push(await read(selector, textSelector, "selected+current"));
  await head.click({ modifiers: ["Control"] }); await settle();
  samples.push(await read(selector, textSelector, "current"));
  // Restore the state the rest of this theme's checks were set up in.
  await head.click({ modifiers: ["Control"] }); await page.waitForTimeout(300);
  return samples;
}


// ---- state: "paneFit" (2026-08-06 narrow-width overflow report) -----------
// Walks the viewport across the widths the entry names and class-scans EVERY
// element inside the named panes for one thing: did it escape the pane's
// content box. Deliberately a class scan rather than a list of selectors --
// the reported defect (`a.notes-row-open`, an inline <a> whose max-width /
// overflow / text-ellipsis are all inert per CSS 2.1 while its inherited
// white-space: nowrap is not) would have been caught by a hand-enumerated
// probe only if someone had already thought to enumerate it.
//
// What it does NOT assert: scrollWidth > clientWidth. That is the normal,
// correct state of every ellipsised single-line element, and reporting it
// buries the real finding under false positives (measured: 5 of them on the
// first run of this sweep, against 1 real).
const PANE_FIT_SCAN = ({ panes, tolerance }) => {
  const hits = [];
  const nameOf = (el) => {
    const cls = (el.className && typeof el.className === "string")
      ? "." + el.className.trim().split(/\s+/).join(".") : "";
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls;
  };
  for (const paneSel of panes) {
    const pane = document.querySelector(paneSel);
    if (!pane) { hits.push({ pane: paneSel, el: paneSel, kind: "paneMissing", over: 0 }); continue; }
    const pr = pane.getBoundingClientRect();
    const pcs = getComputedStyle(pane);
    const right = pr.right - (parseFloat(pcs.paddingRight) || 0) - (parseFloat(pcs.borderRightWidth) || 0);
    const left = pr.left + (parseFloat(pcs.paddingLeft) || 0) + (parseFloat(pcs.borderLeftWidth) || 0);
    if (pane.scrollWidth > pane.clientWidth + tolerance) {
      hits.push({ pane: paneSel, el: paneSel, kind: "paneScroll", over: +(pane.scrollWidth - pane.clientWidth).toFixed(2) });
    }
    for (const el of pane.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") continue;
      if (el.closest("[hidden]")) continue;
      // Screen-reader-only labels are parked off-canvas on purpose.
      if (el.classList.contains("sr-only") || el.closest(".sr-only")) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > right + tolerance) hits.push({ pane: paneSel, el: nameOf(el), kind: "pastRightEdge", over: +(r.right - right).toFixed(2) });
      else if (r.left < left - tolerance) hits.push({ pane: paneSel, el: nameOf(el), kind: "pastLeftEdge", over: +(left - r.left).toFixed(2) });
    }
  }
  return hits;
};

async function drivePaneFit(page, check) {
  const { widths, panes, tolerancePx = 1, resetNarrowDetail = false } = check.expect.paneFit;
  const restore = page.viewportSize();
  const found = [];
  try {
    // Opt-in (debt-sweep 2026-08-07): runLibraryTheme's needsDetailOpen click
    // is decided once per THEME across the whole vocabChecks batch, not per
    // check -- if anything else in that batch is a `-detail-` selector
    // (there always is), `body.lib-narrow-detail` is already set by the time
    // this check runs, whatever width this entry asks for. That class is
    // inert at the wide default viewport (both panes sit side by side
    // regardless), but becomes live the moment this resizes below 860px,
    // hiding `.vocab-list-pane` out from under a check that wanted to
    // measure ITS header rows -- not a real defect, a leftover click from an
    // unrelated check earlier in the same theme's batch. Entries that are
    // deliberately probing the single-pane DETAIL state (existing 900+
    // width entries testing both panes together) must NOT set this.
    if (resetNarrowDetail) await page.evaluate(() => document.body.classList.remove("lib-narrow-detail"));
    for (const width of widths) {
      await page.setViewportSize({ width, height: restore ? restore.height : 900 });
      await page.waitForTimeout(250);
      for (const hit of await page.evaluate(PANE_FIT_SCAN, { panes, tolerance: tolerancePx })) {
        found.push({ ...hit, width });
      }
    }
  } finally {
    if (restore) await page.setViewportSize(restore);
    await page.waitForTimeout(250);
  }
  return found;
}


// ---- state: "headerRowsFlush" (list header, round 2) ---------------------
// The header's whole point is that every row runs the full width of the list
// column -- the version this replaced lost its right edge whenever a row
// wrapped or a non-shrinking unit dropped. Measures, per row: the row's own
// width against the column's, and the gap between the row's right edge and
// its right-most visible child.
//
// Both halves are needed and neither implies the other. A row can be full
// width and still end 40px short of its last control (the old count row did
// exactly that: an empty status span with `margin-left: auto` ate the slack),
// and a row can hug its contents perfectly while being narrower than the
// column. `expected` is the tolerance in px.
const HEADER_ROWS_SCAN = ({ rows, columnSel }) => {
  const col = document.querySelector(columnSel);
  if (!col) return { error: `column not found: ${columnSel}` };
  const colW = col.getBoundingClientRect().width;
  const out = [];
  for (const sel of rows) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ sel, missing: true }); continue; }
    if (getComputedStyle(el).display === "none") { out.push({ sel, hidden: true }); continue; }
    const r = el.getBoundingClientRect();
    // Only children that actually OCCUPY the row count. A zero-width child
    // sitting at the right edge satisfies "something reaches the edge" while
    // showing nothing -- which is the exact pre-fix defect here: an empty
    // status span with `margin-left: auto` parked itself flush right and left
    // the real last control ("Select all") stranded 40px inboard. Measured:
    // this check passed that layout until zero-width children were excluded.
    // Out-of-flow children are skipped for the same reason (sr-only labels).
    const kids = [...el.children].filter((k) => {
      const cs = getComputedStyle(k);
      if (cs.display === "none" || cs.position === "absolute" || cs.position === "fixed") return false;
      const kr = k.getBoundingClientRect();
      return kr.width > 0.5 && kr.height > 0.5;
    });
    const right = kids.length ? Math.max(...kids.map((k) => k.getBoundingClientRect().right)) : r.right;
    out.push({ sel, widthGap: +(colW - r.width).toFixed(2), edgeGap: +(r.right - right).toFixed(2) });
  }
  return { colW: +colW.toFixed(2), rows: out };
};

async function driveHeaderRows(page, check) {
  const { rows, columnSel, widths, tolerancePx = 1, mayVanish = [] } = check.expect.headerRowsFlush;
  // Fail-closed (independent review F3, 2026-08-07). This used to `continue`
  // on ANY row whose computed display was none, which is a silent exemption
  // for the loudest possible defect: a header row that disappears entirely
  // would report zero violations. Only rows the checklist NAMES as legitimately
  // absent get the pass; #vocab-stats is the one -- it is `hidden` in the
  // markup until the first render has counts to put in it.
  const vanishOk = new Set(mayVanish);
  const restore = page.viewportSize();
  const bad = [];
  let worst = 0;
  try {
    for (const width of widths) {
      await page.setViewportSize({ width, height: restore ? restore.height : 900 });
      await page.waitForTimeout(250);
      const res = await page.evaluate(HEADER_ROWS_SCAN, { rows, columnSel });
      if (res.error) { bad.push(`${width}px: ${res.error}`); continue; }
      for (const row of res.rows) {
        if (row.missing) { bad.push(`${width}px: ${row.sel} not in the DOM`); continue; }
        if (row.hidden) {
          if (!vanishOk.has(row.sel)) bad.push(`${width}px: ${row.sel} renders display:none — the whole row is gone`);
          continue;
        }
        worst = Math.max(worst, Math.abs(row.widthGap), Math.abs(row.edgeGap));
        if (Math.abs(row.widthGap) > tolerancePx) bad.push(`${width}px: ${row.sel} is ${row.widthGap}px narrower than the column`);
        if (Math.abs(row.edgeGap) > tolerancePx) bad.push(`${width}px: ${row.sel} ends ${row.edgeGap}px short of its last control`);
      }
    }
  } finally {
    if (restore) await page.setViewportSize(restore);
    await page.waitForTimeout(250);
  }
  return { bad, worst: +worst.toFixed(2) };
}

// ---- state: "gapMin" (debt-sweep 2026-08-07) -------------------------------
// The narrow-screen lookup door's 12px clearance from the sort segment
// (library.css, ".vocab-filter-row > .vocab-lookup-narrow") had no assertion
// at all -- the comment above that rule spells out "8px row gap + 4px = a
// full 12px step clear of the sort segment, so [it] does not read as a third
// cell welded onto it," and nothing measured that the extra 4px margin
// actually survives. Simplest missed counter-example: delete the
// `margin-left` declaration and the gap silently collapses to the row's
// plain 8px flex gap -- welded-on, exactly what the comment says it must not
// look like.
const GAP_MIN_SCAN = ({ fromSel, toSel }) => {
  const a = document.querySelector(fromSel), b = document.querySelector(toSel);
  if (!a) return { error: `not found: ${fromSel}` };
  if (!b) return { error: `not found: ${toSel}` };
  // Symmetric (independent review F5, 2026-08-08): the first version only
  // checked `b`. A hidden `a` collapses to an all-zero rect too, and
  // `br.left - 0` reads as a large POSITIVE number -- a false PASS, not the
  // false FAIL a missing check usually produces. Simplest counter-example:
  // hide fromSel (`.vocab-sort-seg`) at this width and the old code read a
  // comfortably-over-12px gap instead of erroring.
  if (getComputedStyle(a).display === "none") return { error: `${fromSel} is display:none at this width` };
  if (getComputedStyle(b).display === "none") return { error: `${toSel} is display:none at this width` };
  const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
  return { gap: +(br.left - ar.right).toFixed(2) };
};
async function driveGapMin(page, check) {
  const { width, fromSel, toSel } = check.expect.gapMin;
  const restore = page.viewportSize();
  let result;
  try {
    // Same reset as drivePaneFit's resetNarrowDetail, unconditional here
    // since this function has exactly one caller and it always wants list
    // view: this checks a LIST-header gap, which only exists to measure
    // while `.vocab-list-pane` is the visible pane. Without it, a `-detail-`
    // check earlier in the same theme's shared vocabChecks batch (see
    // runLibraryTheme) leaves `body.lib-narrow-detail` set from an
    // unrelated click, which this check's <860px resize then activates,
    // hiding both probed elements and reading a false gap=0.
    await page.evaluate(() => document.body.classList.remove("lib-narrow-detail"));
    await page.setViewportSize({ width, height: restore ? restore.height : 900 });
    await page.waitForTimeout(250);
    result = await page.evaluate(GAP_MIN_SCAN, { fromSel, toSel });
  } finally {
    if (restore) await page.setViewportSize(restore);
    await page.waitForTimeout(250);
  }
  return result;
}

async function runOneCheck(page, theme, check, results, extBase) {
  if (check.state === "headerRowsFlush") {
    const { bad, worst } = await driveHeaderRows(page, check);
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("headerRowsFlush", bad.length === 0, worst, check.expect.headerRowsFlush.tolerancePx ?? 1,
        bad.length ? bad.slice(0, 4).join("; ") : undefined) });
    return;
  }
  if (check.state === "paneFit") {
    const hits = await drivePaneFit(page, check);
    const worst = hits.reduce((m, h) => Math.max(m, h.over), 0);
    const note = hits.length
      ? hits.slice(0, 4).map((h) => `${h.kind} +${h.over}px ${h.el} at ${h.width}px (pane ${h.pane})`).join("; ")
      : undefined;
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("paneFit", hits.length === 0, round2(worst), 0, note) });
    return;
  }
  if (check.state === "gapMin") {
    const min = check.expect.gapMin.min;
    const result = await driveGapMin(page, check);
    const ok = !result.error && result.gap >= min;
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("gapMin", ok, result.error ? null : result.gap, min, result.error) });
    return;
  }
  if (check.state === "rowStates") {
    if (!extBase) throw new Error(`rowStates check on ${check.selector} reached a runner that has no extBase`);
    const samples = await driveRowStates(page, extBase, theme, check.selector, check.expect.bandDistinct?.textSelector || null);
    const evald = evaluateCheck(check, { found: true, rect: { width: 1, height: 1 }, bgStack: [], bandSamples: samples }, theme);
    if (evald.setupError) {
      throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: ${evald.setupError}`);
    }
    for (const r of evald.results) results.push({ surface: check.surface, theme, selector: check.selector, state: check.state, ...r });
    return;
  }
  // ---- state: "focusWithin" (design-uplift §8) ----------------------------
  // Reads the shell TWICE -- once untouched, once while `check.focusTarget`
  // (a selector relative to the shell) holds focus -- so fusedFocusRing can
  // prove the :focus-within rule actually changed something rather than just
  // that some indicator happens to exist.
  //
  // Two Chromium behaviours this has to work around, both of which silently
  // produced "no ring" readings while debugging:
  //   - focus styling is transitioned (`transition: box-shadow 150ms`), and a
  //     computed read in the same task as .focus() returns the t=0
  //     interpolation of `none`, i.e. a transparent zero-size shadow. Hence
  //     the settle wait before the second read.
  //   - :focus-visible only matches a <button> when the last input modality
  //     was the keyboard. A script .focus() leaves the modality unset, so a
  //     stepper's own outline would measure absent no matter what the CSS
  //     said -- and this check's whole job is to assert that outline is
  //     absent. Pressing a real key first makes the assertion meaningful
  //     instead of vacuous.
  let focusBaseline = null;
  let stabilityBaseline = null;
  let restBgStack = null;
  if (check.state === "classState") {
    // A class-driven state override (debt-sweep 2026-08-07, first use:
    // #submit-btn.saved-success/.save-error). Reads the SAME element's
    // background twice -- once untouched, once with `check.addClass` applied
    // -- so bgChangedFromRest can prove the override actually repainted
    // something rather than that a class merely got added. This is what a
    // higher-specificity base rule (e.g. an #id selector) silently defeats:
    // the class lands in the DOM, the cascade still paints the old colour.
    if (!Array.isArray(check.addClass) || !check.addClass.length) {
      throw new Error(`classState check on ${check.selector} has no addClass`);
    }
    // `removeClass`/`clearDisabled` (both optional, debt-sweep 2026-08-07
    // fix round): mirror the REAL DOM mutation the state machine this
    // targets performs, not just the one class add. #submit-btn's own
    // setSubmitState() always does `classList.remove("loading",
    // "saved-success", "save-error")` + `disabled = false` before adding the
    // new state class -- skipping that here meant the "rest" baseline this
    // captures could be measuring whatever OTHER state (disabled, a
    // different .btn class) the element happened to be left in, not the
    // idle resting cascade the fix actually has to out-rank. Applied to
    // BOTH the baseline read and the target-state read, so they differ by
    // exactly one class the way the real state machine's transitions do.
    const mirror = async () => page.evaluate(({ selector, removeCls, clearDisabled }) => {
      const el = document.querySelector(selector);
      if (!el) return;
      if (removeCls && removeCls.length) el.classList.remove(...removeCls);
      if (clearDisabled) el.disabled = false;
    }, { selector: check.selector, removeCls: check.removeClass || null, clearDisabled: !!check.clearDisabled });
    await mirror();
    // Settle before reading the rest baseline (final review F1): mirror()
    // itself triggers `.btn`'s `transition: background var(--pp-motion-state)`
    // regression, and reading restBgStack in the same task as the mutation can
    // land mid-interpolation -- under 4 parallel shards this produced two
    // unreproducible bgChangedFromRest false reds (submit-btn, Task 15 and
    // Task 16). Same 260ms discipline as the target-state read below (:1566).
    await page.waitForTimeout(260);
    restBgStack = await page.evaluate(({ selector }) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const stack = [];
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) stack.push(getComputedStyle(node).backgroundColor);
      return stack;
    }, { selector: check.selector });
    await page.evaluate(({ selector, cls }) => {
      document.querySelector(selector)?.classList.add(...cls);
    }, { selector: check.selector, cls: check.addClass });
    // Same settle discipline as focusWithin below (:1405): `.btn`'s
    // `transition: background var(--pp-motion-state), ...` means a read
    // taken in the same task as classList.add() can land mid-interpolation
    // instead of at the transition's target value.
    await page.waitForTimeout(260);
  }
  if (check.state === "focusWithin") {
    if (!check.focusTarget) throw new Error(`focusWithin check on ${check.selector} has no focusTarget`);
    focusBaseline = await page.evaluate(({ selector }) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        borderColors: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor].join("|"),
        boxShadow: cs.boxShadow,
        outlineStyle: cs.outlineStyle,
      };
    }, { selector: check.selector });
    // The REST pass for fusedStateStable. Taken through the same probe the
    // focused pass uses, so the two snapshots are structurally identical and
    // a diff can only mean the CSS changed something -- not that two
    // different measurement paths disagree.
    if (check.expect.fusedStateStable === true) {
      const rest = await page.evaluate(probeSelector, {
        selector: check.selector, compareSelector: null, extraBgVarName: null, extraColorVarName: null, radiusVarName: null,
        childSelectors: check.expect.fusedStateStableChildren || null,
        focusTargetSelector: null,
      });
      stabilityBaseline = rest.stability || null;
    }
    await page.keyboard.press("Shift");
    const focused = await page.evaluate(({ selector, target }) => {
      const el = document.querySelector(selector);
      // ":scope" = focus the probed element itself, for controls that ARE the
      // focus target (§7.3 focusRecipe checks) rather than shells wrapping one
      // (§8 fusedFocusRing checks). el.querySelector(":scope") never matches,
      // so this needs the explicit branch.
      const t = el && (target === ":scope" ? el : el.querySelector(target));
      if (!t) return false;
      t.focus();
      return document.activeElement === t;
    }, { selector: check.selector, target: check.focusTarget });
    if (!focused) throw new Error(`SETUP: could not focus "${check.focusTarget}" inside ${check.selector} (theme=${theme})`);
    await page.waitForTimeout(260);
  } else if (check.state === "hover") {
    // Real mouse hover (not a class hack): Playwright dispatches actual
    // pointer events, so the live cascade's own `:hover` pseudo-class match
    // drives getComputedStyle exactly the way a real user's cursor would --
    // no need to fake it by toggling a class the CSS never checks for.
    await page.hover(check.selector);
    // Read the settled state, not the first interpolation frame. Buttons
    // transition background/color for --*-motion-state; an immediate read
    // can serialize the 0% frame as transparent oklab(), making a hover
    // assertion accidentally inspect the resting paint.
    await page.waitForTimeout(260);
  } else if (check.state !== "default" && check.state !== "classState") {
    throw new Error(`unsupported state "${check.state}" on ${check.selector} -- extend runOneCheck() before adding non-default states to the checklist`);
  }
  // bgEqVar (D6/D7, Task 5): reuses the SAME extraBgVarName slot
  // textContrastMulti already has -- both read a BACKGROUND-role token, and
  // no check sets both at once. colorEqVar gets its OWN extraColorVarName
  // slot (see probeSelector's header comment) -- a check (popup's `.stag`)
  // legitimately sets bgEqVar AND colorEqVar together, two DIFFERENT tokens.
  // T5 fix round F5: the "no check sets both at once" invariant above was
  // prose-only -- a check declaring BOTH textContrastMulti.extraBgSelectorVar
  // and bgEqVar would have the `||` below silently pick one and starve the
  // other of its own probe value. Enforced here instead of just documented.
  if (check.expect.textContrastMulti?.extraBgSelectorVar && check.expect.bgEqVar) {
    throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: ` +
      `check declares BOTH textContrastMulti.extraBgSelectorVar (${check.expect.textContrastMulti.extraBgSelectorVar}) ` +
      `and bgEqVar (${check.expect.bgEqVar}) -- they share the same extraBgVarName probe slot ` +
      `and only one would ever be read; split into two checklist entries instead.`);
  }
  const extraBgSelectorVar = check.expect.textContrastMulti?.extraBgSelectorVar
    || check.expect.bgEqVar;
  const extraColorSelectorVar = check.expect.colorEqVar;
  const raw = await page.evaluate(probeSelector, {
    selector: check.selector,
    compareSelector: check.expect.heightEqWith?.selector || null,
    extraBgVarName: extraBgSelectorVar ? `--${NS_BY_SURFACE[check.surface]}-${extraBgSelectorVar}` : null,
    extraColorVarName: extraColorSelectorVar ? `--${NS_BY_SURFACE[check.surface]}-${extraColorSelectorVar}` : null,
    radiusVarName: check.expect.insetBand?.radiusVar ? `--${NS_BY_SURFACE[check.surface]}-${check.expect.insetBand.radiusVar}` : null,
    childSelectors: check.expect.fusedChildrenFlat?.children || check.expect.fusedStateStableChildren || check.expect.edgeClickable?.children || null,
    focusTargetSelector: check.state === "focusWithin" ? check.focusTarget : null,
  });
  if (focusBaseline) raw.focusBaseline = focusBaseline;
  if (stabilityBaseline) raw.stabilityBaseline = stabilityBaseline;
  if (restBgStack) raw.restBgStack = restBgStack;
  if (check.state === "classState") {
    // Same discipline as the hover-pointer reset below: leaving the class on
    // would leak into the next check that reads this same element in its
    // "default" state.
    await page.evaluate(({ selector, cls }) => {
      document.querySelector(selector)?.classList.remove(...cls);
    }, { selector: check.selector, cls: check.addClass });
  }
  if (check.state === "focusWithin") {
    // Blur before the next check reads anything: a left-over :focus-within on
    // this shell would leak its focused border-colour into every later
    // default-state read on the same page, exactly the way a parked mouse
    // pointer leaks :hover (see the hover reset just below).
    await page.evaluate(() => document.activeElement?.blur());
    // Must outlast the SAME transition the focus read waits 260ms for. At the
    // old 120ms the next check's "unfocused baseline" was captured mid-fade:
    // measured `rgba(51,255,51,0.004) 0 0 0.04px` and interpolated oklab()
    // border colours, i.e. a shell that looked like it had reacted to focus
    // when it had merely not finished un-reacting. That reads as a real
    // difference to any assertion comparing rest against focus.
    await page.waitForTimeout(260);
  }
  if (check.state === "hover") {
    // Reset the pointer to a dead corner right after reading the hover
    // state back -- otherwise it stays parked on this check's element for
    // every subsequent "default"-state check in the same run (a :hover that
    // was never supposed to be active would silently leak into their
    // getComputedStyle reads until the next real hover/navigation moved it).
    await page.mouse.move(0, 0);
  }
  const evald = evaluateCheck(check, raw, theme);
  if (evald.setupError) {
    throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: ${evald.setupError}`);
  }
  for (const r of evald.results) {
    // focusWithin folds the focused passenger into the recorded state: the
    // same shell gets one entry per tab stop, and keyOf() is
    // surface|theme|selector|state|check -- without this they would all
    // collapse onto one known-failures key and shadow each other.
    const state = check.state === "focusWithin" ? `focusWithin[${check.focusTarget}]` : check.state;
    results.push({ surface: check.surface, theme, selector: check.selector, state, ...r });
  }
}

// ---- library.html has two independent master-detail views behind one tab
// strip; a selector's prefix tells us which view to be on and whether a row
// needs clicking open first (every "*-detail-*" selector lives in a detail
// pane that starts empty). ----
function libraryView(selector) { return selector.startsWith(".notes-") ? "notes" : "vocab"; }
function needsDetailOpen(selector) { return selector.includes("-detail-"); }
// .vocab-batch-bar (library.css:986-1010, ".selecting") is height:0/hidden
// until a row is selected. Every id living in that bar needs the same
// precondition -- named explicitly rather than inferred from `expect`
// shape, since hitAreaMin/heightEqWith checks both land there and a third
// check type will land there again eventually.
const BATCH_BAR_SELECTORS = new Set([
  "#vocab-group-input", "#vocab-add-group", "#vocab-remove-group",
  "#vocab-invert-selection", "#vocab-mark-known", "#vocab-mark-learning",
  "#vocab-batch-delete", "#vocab-clear-selection",
  // §8 fused-control entries probe the shell, not the ids inside it.
  "#vocab-batch-toolbar .vocab-group-unit",
]);
function needsBatchBarOpen(selector) { return BATCH_BAR_SELECTORS.has(selector); }
// .vocab-note-save (Task 4, taste-uplift-batch2 -- COMPONENTS.md §1.2 primary
// tier): the detail-open click above is not enough to reveal it. It starts
// `hidden` (visibility, not display -- library.css) until the note textarea's
// value diverges from the word's saved note, so the cheapest REAL reveal is
// typing into the field the same way a user would, letting the existing
// `input` listener flip `.hidden` itself -- not toggling the DOM property
// directly, which would exercise a path the actual UI never takes.
function needsNoteDirty(selector) { return selector.includes("vocab-note-save"); }

// The 11 DOM ids for popup's hidden-by-default state legs (feedback
// card + its fallback action, URL warning + clean hint, presets/suggest
// rows, batch permission card + progress bar, markdown strip, offline queue
// list). Used verbatim by both runSweep's own hidden-states pass and family
// 13's (weakTextOnFill) popup leg opener below -- hoisted to a single
// source so the two lists can't silently drift apart again (confirmed
// byte-identical before this hoist).
const POPUP_HIDDEN_LEG_IDS = ["existing-banner", "url-warning", "url-clean-hint", "presets-row", "suggest-row", "ai-error-card", "ai-error-fallback", "batch-permission", "batch-progress", "md-actions-strip", "offline-queue-list"];

// ============================================================================
// weakTextOnFill (family 13, weak-text-on-fill batch, T5). COMPONENTS.md
// §9.1 law 8: --{ns}-fg-hint / --{ns}-fg-muted / --{ns}-link must never paint
// text that rests on a control fill (--{ns}-btn-bg / --{ns}-btn-hover /
// --{ns}-input-bg / --{ns}-chip-bg, or -- library only -- the batch-selection
// accent bands). Unlike families 4-12 (theme-invariant geometry, one sweep
// pass covers every preset), colour tokens are PER-THEME, so this runs once
// per (surface, theme) from INSIDE the CHECKS loop's already-open page
// (recordWeakTextHits' call sites in runSimpleTheme/runLibraryTheme below)
// instead of paying for a second whole-matrix navigation pass. Rest state
// only, incl. the popup/options/library hidden-state legs those two
// functions already drive open for other checks (plus the two this family
// needs for itself, `#md-actions-strip` and the Connection Status
// disclosure) -- hover is explicitly OUT of scope (tests/render-audit-
// checklist.mjs's family-13 entry says so; token-side hover coverage is
// contrast-audit's `btn-fg-muted vs btn-hover` / `fg vs btn-hover` rows).
//
// Every target colour is resolved LIVE off getComputedStyle(document.
// documentElement) -- never a CSS-source literal -- which is what lets this
// catch the cascade shape a static same-selector scan (tests/ui-contract-
// tests.mjs) structurally cannot see: `color` declared on one rule, the fill
// on an ANCESTOR rule (the real bug shape every consumer this batch fixed
// actually had -- .connection-health-state's own rule carries no
// `background`, its parent .connection-health-row's --opt-btn-bg is what the
// label actually sits on). The ancestor walk in weakTextProbe therefore
// starts AT the scanned element itself (some consumers, e.g. .md-strip-btn,
// paint their own background directly) and only then climbs parents,
// stopping at the first non-transparent background-color it finds -- that is
// "the fill", matched or not, exactly once.
// `safeHostRoles` (T5 implementer, added after the pre-batch discrimination
// run surfaced a real false-positive class -- see the T5 report): NEW_THEME.md's
// "TEXT input roles" section states fg-hint/fg-muted (and, for options,
// pf-bg/code-bg via T2's D5 gate) are INDEPENDENTLY guaranteed >=4.5:1
// against these page-level surfaces on every themed block (contrast-
// audit.mjs's auditCssThemes/auditLibraryThemes -- verified by reading those
// functions directly, not inferred). A render probe can only compare
// RESOLVED PIXEL VALUES, not which named custom property produced them --
// and Soft Fill's fillSeparate() only promises >=1.10:1 separation from the
// hosts it was actually TOLD about, so a control fill can coincidentally
// resolve to the EXACT same hex as an unrelated page surface it was never
// separated from (real example: popup's nord-night resolves --pp-btn-hover
// and --pp-bg2 to the byte-identical #3b4252 -- .header-bar's #user-info/
// .header-ic sit on --pp-bg2, not any control fill, but the walk cannot
// tell the two apart once they're equal). When the walked "nearest fill"
// ALSO equals one of these guaranteed-safe surfaces AND the painted ratio
// on THIS instance clears the same threshold a real hit would need (T5 fix
// wave, F4 -- exact equality below, no tolerance), this occurrence is
// provably readable regardless of which token name happens to produce that
// colour, so it is excluded here rather than reported as a family-13 hit.
// safeHostRoles / safeHostExcludeTextRoles (T5 fix wave, F4): a safe-host
// role is sound ONLY where a BLOCKING `fg-hint|fg-muted vs <host>` row
// actually exists in contrast-audit.mjs (auditCssThemes/auditLibraryThemes)
// -- popup bg :1284-1292, bg2 :1307-1308, drop-hover :1339-1341 (popup DOES
// declare --pp-drop-hover); options bg/panel same rows, pf-bg/code-bg
// :1329-1330 (D5, options only); options never declares --opt-drop-hover
// (`grab("drop-hover")` returns null for every options block, so that row
// never even prints) -- an inert entry, dropped here, not carried as dead
// weight. `link` has NO "link vs <host>" row at all on popup/options (no
// such check exists in auditCssThemes) -- only auditLibraryThemes checks
// "link vs bg"/"link vs panel" (:1427-1434) -- so the safe-host exemption
// must never cover `link` on popup/options regardless of the painted ratio:
// there is no page-level guarantee to fall back on, only the ratio actually
// measured, and F4's fix is to remove the ±3 tolerance that let it borrow
// one anyway (rose-pine input-bg #27243b "≈" drop-hover #26233a; catppuccin-
// latte btn-bg #dbdee6 "≈" drop-hover #dce0e8) -- library keeps `link`
// eligible since ITS bg/panel rows genuinely cover it.
const WEAK_TEXT_CFG = {
  popup: {
    prefix: "pp", textRoles: ["fg-hint", "fg-muted", "link"], fillRoles: ["btn-bg", "btn-hover", "input-bg", "chip-bg"],
    safeHostRoles: ["bg", "bg2", "drop-hover"],
    safeHostExcludeTextRoles: ["link"],
  },
  // NOTE (T5 implementer): the plan's D4 mentions an options "fg-dim" role --
  // verified against options.css: --opt-fg-dim was RETIRED before this batch
  // (taste-uplift batch2 Task 5 moved its two consumers to --opt-fg; the only
  // remaining trace is a comment explaining the retirement, `grep -c` for a
  // live `--opt-fg-dim:` definition is 0). COMPONENTS.md §9.1 law 8 itself
  // only names fg-hint/fg-muted/link, so this family checks exactly those
  // three on options too -- not a narrowing, the role doesn't exist to check.
  options: {
    prefix: "opt", textRoles: ["fg-hint", "fg-muted", "link"], fillRoles: ["btn-bg", "btn-hover", "input-bg", "chip-bg"],
    safeHostRoles: ["bg", "panel", "pf-bg", "code-bg"],
    safeHostExcludeTextRoles: ["link"],
  },
  // library additionally gates its two batch-selection bands (D6 follow-up /
  // Ruling 17): see the file-header import comment for why the percentages
  // come from LIB_BATCH_BAND_MIX instead of being retyped here. library's
  // fg-hint/fg-muted are gated (auditLibraryThemes) only against bg/panel --
  // no drop-hover-equivalent (row-selected-bg) row exists for those two
  // roles, only for row-selected-fg, a role outside this family's text set.
  // link IS gated vs bg/panel here (auditLibraryThemes :1427-1434), so it
  // stays eligible for the safe-host exemption -- no exclusion list.
  library: {
    prefix: "lib", textRoles: ["fg-hint", "fg-muted", "link"], fillRoles: ["btn-bg", "btn-hover", "input-bg", "chip-bg"],
    batchBandMix: LIB_BATCH_BAND_MIX, bgRole: "bg", accentRole: "accent",
    safeHostRoles: ["bg", "panel"],
    // --lib-row-selected-fg is DERIVED specifically to clear both batch bands
    // (D6 follow-up / Ruling 17, fgToAAMulti(fg, [row-selected-bg, band-20,
    // band-26])) -- an element that reads it (.notes-row-title/.vocab-row-
    // headline inherit it from .notes-card-head's `.selected` rule, verified
    // real on terminal, whose whole palette collapses fg/accent/link/row-
    // selected-fg to the same #33ff33) is correctly painted regardless of
    // which OTHER role's current value it happens to also equal.
    safeTextRoles: ["row-selected-fg"],
  },
};

// Runs INSIDE the page (Playwright serializes this function's source, same
// self-containment constraint as probeSelector/sweepProbe above -- no
// references to anything outside its own body).
function weakTextProbe(cfg) {
  const hits = [];
  let scanned = 0;

  // Task spec identity: "parent > element (tag.classes or #id)" -- matches
  // family 11 spacingScale's identOf (scripts/ui-render-audit.mjs's
  // sweepProbe), no sibling index (a reordered sibling shouldn't mint a new
  // identity). `.qbtn`'s label span has neither id nor class, so it falls
  // through to a bare tag name -- the PARENT half of the identity is what
  // makes that still legible (e.g. "#save-tabset-btn > span"), which the
  // earlier same-element-only pathOf could not express.
  function identOf(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + el.id;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).join(".") : "";
    return el.tagName.toLowerCase() + (cls ? "." + cls : "");
  }
  function pathOf(el) {
    return `${identOf(el.parentElement)} > ${identOf(el)}`;
  }
  function visible(el) {
    if (!(el instanceof Element)) return false;
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } else {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  // Exempt ONLY :disabled -- by the `disabled` PROPERTY (attribute-backed,
  // but read as the live IDL attribute so it reflects the actual disabled
  // state), not by matching ":disabled" in a selector string, and walked up
  // the ancestor chain so text inside a disabled control (not just the
  // control itself) is exempt too (COMPONENTS.md §9.1 law 8's sole exemption,
  // WCAG 1.4.3).
  function isDisabled(el) {
    for (let node = el; node; node = node.parentElement) {
      if (node.disabled === true) return true;
    }
    return false;
  }
  function parseColor(raw) {
    const s = String(raw || "").trim();
    if (!s || s === "transparent" || s === "none") return null;
    let m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s);
    if (m) {
      let hex = m[1];
      if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
      const n = parseInt(hex, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      const parts = m[1].split(",").map((p) => parseFloat(p));
      if (parts.length >= 3) {
        const alpha = parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : 1;
        if (alpha <= 0.001) return null; // fully transparent -- not a real text/fill paint
        return [parts[0], parts[1], parts[2]];
      }
    }
    // getComputedStyle serializes a color-mix() result (every `--row-bg`
    // this batch's batch-selection band and `[aria-pressed="true"]`'s own
    // fill both use) as `color(srgb r g b [/ a])` with 0..1 FRACTIONAL
    // channels, not `rgb(...)` -- verified live (Playwright: `background:
    // color-mix(in srgb, #89b4fa 12%, #37394b)` computes to
    // "color(srgb 0.254275 0.281412 0.376471)"). Without this branch
    // parseColor returned null for any color-mix() background, and the walk
    // silently skipped past it to whatever plain-hex ancestor came next --
    // misattributing a mixed fill's role to an unrelated shell one level up
    // (caught live: #vocab-sort-time's own [aria-pressed="true"] mix was
    // skipped this way, reporting its shell's plain --lib-btn-bg instead).
    m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/i.exec(s);
    if (m) {
      const alpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
      if (!Number.isFinite(alpha) || alpha <= 0.001) return null;
      return [parseFloat(m[1]) * 255, parseFloat(m[2]) * 255, parseFloat(m[3]) * 255];
    }
    return null;
  }
  function closeEnough(a, b, tol) {
    return !!a && !!b && Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
  }
  // Small tolerance for color-mix()/serialization rounding drift (the batch
  // bands below in particular), not a real colour difference -- three RGB
  // levels is far under the ~12-level step FILL_SEPARATE_MIN 1.10 relies on
  // being visible (COMPONENTS.md §9.1 law 2), so this can't paper over an
  // actual distinct colour.
  const TOL = 3;
  // First-match-wins used to report only whichever role happened to sit
  // first in cfg.textRoles/cfg.fillRoles, mislabeling a FAIL when more than
  // one role's live value collapses onto the scanned colour (e.g. a theme
  // where fg-hint and input-bg resolve identical) -- `actual=` would then
  // name a token the failing rule never even used. Collect EVERY matching
  // role instead, same filter+map shape identityRoles already uses below,
  // joined with "|" so textRole/fillRole stay single string values for the
  // dedup key and the report line. Callers that test membership against a
  // config list (safeHostExcludeTextRoles below) must split on "|" first --
  // a plain `===`/`.has()` on the joined string would silently stop
  // matching once more than one role is present.
  function matchRole(rgb, targets) {
    if (!rgb) return null;
    const matches = targets.filter((t) => closeEnough(rgb, t.rgb, TOL)).map((t) => t.role);
    return matches.length ? matches.join("|") : null;
  }

  const rootCs = getComputedStyle(document.documentElement);
  const readToken = (role) => parseColor(rootCs.getPropertyValue(`--${cfg.prefix}-${role}`));
  const textTargets = cfg.textRoles.map((role) => ({ role, rgb: readToken(role) })).filter((t) => t.rgb);
  const fillTargets = cfg.fillRoles.map((role) => ({ role, rgb: readToken(role) })).filter((t) => t.rgb);
  if (cfg.batchBandMix && cfg.batchBandMix.length) {
    const bg = readToken(cfg.bgRole || "bg");
    const accent = readToken(cfg.accentRole || "accent");
    if (bg && accent) {
      // Linear blend in sRGB channel space -- matches CSS's
      // `color-mix(in srgb, accent T%, bg)` (library.css's --row-bg), which
      // is exactly what library-chrome.mjs's own `mix(a, b, t)` computes at
      // build time for the same two bands (see the file-header import
      // comment). `t` values come from cfg.batchBandMix, i.e. from the
      // imported LIB_BATCH_BAND_MIX -- never a literal here.
      for (const t of cfg.batchBandMix) {
        const mixed = [0, 1, 2].map((i) => Math.round(bg[i] + (accent[i] - bg[i]) * t));
        fillTargets.push({ role: `batch-band-${Math.round(t * 100)}`, rgb: mixed });
      }
    }
  }
  // Page-level surfaces fg-hint/fg-muted (and, for options, pf-bg/code-bg)
  // are ALREADY guaranteed AA against on every themed block (contrast-
  // audit.mjs's auditCssThemes/auditLibraryThemes -- see WEAK_TEXT_CFG's
  // comment above). A coincidental colour collision between one of these and
  // a control fill (verified real: popup nord-night's --pp-bg2 ===
  // --pp-btn-hover, byte-identical) is a TRIGGER, not an automatic exemption
  // (T5 fix wave, F4): it still has to clear the SAME painted-ratio gate as
  // every other exemption class below, and the match itself is now exact
  // equality, not the ±3 tolerance that used to let an unrelated fill
  // (rose-pine input-bg, catppuccin-latte btn-bg) borrow a nearby safe
  // host's guarantee it never had.
  const safeHostTargets = (cfg.safeHostRoles || []).map((role) => ({ role, rgb: readToken(role) })).filter((t) => t.rgb);
  const safeHostExcludeTextRoles = new Set(cfg.safeHostExcludeTextRoles || []);
  // Text-side counterpart to safeHostTargets: a role NOT in cfg.textRoles
  // whose current value the scanned colour might coincidentally equal, and
  // which is independently guaranteed safe wherever it is actually used.
  // `btn-fg`/`btn-fg-muted` are UNIVERSAL and UNCONDITIONAL on all three
  // surfaces: they are the two tokens COMPONENTS.md §9.1 law 8's D1/D2 name
  // as the primary/muted text on a control fill, and their own derivation
  // (fgToAAMulti(fg[-muted], [btn-bg, btn-hover])) starts FROM fg/fg-muted
  // and stays IDENTITY to it whenever the raw value already clears both
  // fills -- so a CORRECTLY migrated consumer (post-T1-T4:
  // .qbtn, .md-strip-btn, .connection-health-state, the sort-seg cell) can
  // still read back as "fg-muted"/"fg-hint" on many themes purely because
  // the sanctioned replacement never had to move. Caught live: an earlier
  // version of this family without this exemption FAILED the CURRENT
  // (post-batch) tree on exactly these four already-fixed consumers, on
  // every theme where btn-fg-muted collapsed onto fg-muted/fg-hint (T1's own
  // report: 2/45 blocks; this run found more collapses than that static
  // count once options'/library's per-block identity was checked live) --
  // the fix is real, the false alarm was this family not yet knowing its own
  // sanctioned tokens. library's --lib-row-selected-fg is unconditional for
  // the same reason (D6 follow-up / Ruling 17); `accent` is conditional on
  // isSelectionIndicator below -- `link`'s own derivation (fgToAAMulti(accent,
  // [bg, bg2])) starts FROM accent and stays IDENTITY to it whenever accent
  // already clears AA, so a GENUINE `--{ns}-link` consumer (e.g.
  // .md-strip-btn, a real law-8-restricted usage) can equal accent's value
  // too -- unconditionally exempting on that alone would hide real
  // link-on-fill violations (caught live: an earlier unconditional version
  // of this exemption dropped .md-strip-btn's true positive count on 9/13
  // popup themes). Scoping the accent exemption to elements carrying a
  // selection-state marker targets the one shape that's actually accent, not
  // link: library's pressed sort-seg cell (`[aria-pressed="true"]`, a
  // REVIEWED, accepted design -- T4's ledger: "pressed cell = accent, ...
  // no STOP").
  //
  // T5 fix wave (F2/F3): identity and marker matches used to `return` here
  // unconditionally -- "the colour equals a sanctioned token's CURRENT
  // value" is not the same claim as "the colour is READABLE on THIS fill",
  // because btn-fg-muted/btn-fg/row-selected-fg are only ever derived
  // against their OWN host list (btn-bg/btn-hover; the two batch bands),
  // never against input-bg/chip-bg -- a genuine fg-muted/fg-hint/link
  // consumer painted on input-bg can coincidentally equal btn-fg-muted's
  // value on one theme (a "collapse", T1's own report) while failing AA
  // against THAT fill on another (dracula: identity hid a real 3.79:1 hit;
  // flexoki-dark: the marker case hid a real 3.44:1 hit). Both are now
  // TRIGGERS collected below and gated by the painted ratio in
  // recordWeakTextHits (Node side, reusing contrast-audit.mjs's own `cr` --
  // this in-page function stays self-contained per Playwright's
  // page.evaluate serialization constraint, so it hands back colorRgb/
  // fillRgb rather than computing the ratio itself).
  //
  // `fg` (T5 review F6, T3 review's Ruling-16-adjacent note, COMPONENTS.md
  // §9.1 law 8's "合法 token 补记"): `contrast-audit`'s `fg vs btn-bg` / `fg
  // vs input-bg` / `fg vs btn-hover` rows already gate it to 4.5:1 on three
  // of the four fills (not chip-bg, which has no such row) -- without it
  // here, a raw `--{ns}-fg` consumer that happens to collapse onto
  // fg-hint/fg-muted/link's value (terminal: "whole palette collapses fg/
  // accent/link/row-selected-fg to the same #33ff33") would be reported
  // unconditionally, with no ratio gate to rescue it even when the measured
  // pair is genuinely safe -- today only that coincidence (fg landing on a
  // fill it isn't independently gated against never actually failing on the
  // shipped palettes) keeps it quiet.
  const safeTextTargets = ["fg", "btn-fg", "btn-fg-muted", ...(cfg.safeTextRoles || [])]
    .map((role) => ({ role, rgb: readToken(role) })).filter((t) => t.rgb);
  const accentRgb = readToken("accent");
  function isSelectionIndicator(el) {
    return el.getAttribute("aria-pressed") === "true"
      || el.getAttribute("aria-selected") === "true"
      || el.getAttribute("aria-current") != null
      || el.classList.contains("active")
      || el.classList.contains("selected");
  }
  function exactEqual(a, b) {
    return !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  }

  // Tokens didn't resolve at all (a broken theme block, or a page that never
  // set data-theme) -- nothing to compare against; report zero-scanned
  // rather than silently "passing" every element on this page.
  if (!textTargets.length || !fillTargets.length) return { hits, scanned };

  const iconLabel = (el) => el.textContent.replace(/\u00D7/g, "").trim();
  const seen = new Set();

  // T5 fix wave: every exemption class below (identity, selection-marker,
  // safe-host) is now a TRIGGER, not an automatic drop -- it only survives
  // as a non-hit once recordWeakTextHits (Node side) confirms the REAL
  // painted ratio between colorRgb and fillRgb clears the same threshold a
  // real violation would need. `textRole` gates entry: if the scanned
  // colour isn't independently one of fg-hint/fg-muted/link, none of this
  // family's business no matter what else it happens to equal (a genuinely
  // accent-only or btn-fg-only element was never a law-8 candidate).
  function probe(el, label) {
    if (!visible(el) || isDisabled(el)) return;
    scanned++;
    const colorRgb = parseColor(getComputedStyle(el).color);
    const textRole = matchRole(colorRgb, textTargets);
    if (!textRole) return;
    let fillRole = null;
    let fillRgb = null;
    for (let node = el; node; node = node.parentElement) {
      const rgb = parseColor(getComputedStyle(node).backgroundColor);
      if (!rgb) continue;
      fillRgb = rgb;
      fillRole = matchRole(rgb, fillTargets); // nearest non-transparent bg, matched or not -- stop here either way
      break;
    }
    // Not resting on one of the four control fills (or a batch band) at
    // all -- out of this family's scope regardless of any exemption class.
    if (!fillRole) return;

    // Every matching identity role (F6: "print all matching role names on
    // collapse" -- first-match-wins used to mislabel when more than one
    // sanctioned token collapsed onto the same value).
    const identityRoles = safeTextTargets.filter((t) => closeEnough(colorRgb, t.rgb, TOL)).map((t) => t.role);
    const isMarker = !!(accentRgb && isSelectionIndicator(el) && closeEnough(colorRgb, accentRgb, TOL));
    // F4: exact equality only (no +/-3 tolerance -- that was the mechanism
    // that let an unrelated fill borrow a nearby safe host's guarantee),
    // and `link` is categorically excluded on surfaces with no "link vs
    // <host>" row (safeHostExcludeTextRoles, popup/options). textRole
    // may now be a "|"-joined multi-role match, so this membership test
    // splits it and excludes if ANY matched role is on the exclude list --
    // a plain `.has(textRole)` would miss "link" once it's joined with
    // another role (e.g. "fg-hint|link").
    const safeHostRole = textRole.split("|").some((r) => safeHostExcludeTextRoles.has(r))
      ? null
      : (safeHostTargets.find((t) => exactEqual(fillRgb, t.rgb))?.role || null);

    const exemptedBy = [];
    for (const role of identityRoles) exemptedBy.push(`identity:${role}`);
    if (isMarker) exemptedBy.push("marker:accent");
    if (safeHostRole) exemptedBy.push(`safe-host:${safeHostRole}`);

    const path = pathOf(el);
    const key = `${label}|${path}|${textRole}|${fillRole}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ path, label, textRole, fillRole, colorRgb, fillRgb, exemptedBy: exemptedBy.length ? exemptedBy : null });
  }

  // Direct (own, non-descendant) text nodes -- same convention as sweepProbe's
  // textInset/textFloor families: a wrapper whose text lives in a nested
  // child is scanned when THAT child is visited, not double-counted here.
  for (const el of document.querySelectorAll("body *")) {
    const hasDirectText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (hasDirectText) probe(el, "text");
  }
  // Icon-only affordances (task spec: "include those too and label them") --
  // an SVG icon has no colour of its own, it inherits `color` via
  // stroke="currentColor" (PBP_ICONS, shared.js), so the HOST's computed
  // `color` is exactly what a text check would read, just with no text node
  // to hang it off. Skips anything with its own label text -- the direct-text
  // scan above already covers that shape.
  for (const el of document.querySelectorAll("button, [role='button'], .btn, a.btn")) {
    if (iconLabel(el).length > 0) continue;
    if (!el.querySelector("svg")) continue;
    probe(el, "icon");
  }

  return { hits, scanned };
}

// Node-side accumulator, purely for the run's own visibility requirement
// (task spec: "report count of scanned elements per surface so a future '0
// FAIL' can be distinguished from 'scanned nothing'") -- printed once in
// main() next to the media-preferences summary line.
const weakTextScanLog = [];

// "" (default light) renders with NO data-theme attribute at all (see
// themeToStorage's comment and the early-theme scripts it mirrors:
// options-theme-early.js `delete _optionsRoot.dataset.theme`, popup-
// theme-early.js's no branch taken at all on a fresh navigation) -- every
// other THEMES entry is its own literal value.
function expectedDatasetTheme(theme) { return theme || null; }

async function recordWeakTextHits(page, surface, theme, results, context) {
  const cfg = WEAK_TEXT_CFG[surface];
  if (!cfg) return;
  // F1 (T5 review, CRITICAL): assert the page is actually showing the theme
  // this iteration thinks it's scanning before paying for the scan at all.
  // A click earlier in the SAME loaded page can silently repaint
  // documentElement.dataset.theme to something else -- the concrete bug:
  // options' appearance-tab preset-preview button (`.theme-preset-btn[data-
  // theme='flexoki']`) is nominally picking a pinboard.in SITE theme, but
  // its click handler (options.js applyPreset -> applyOptionsPageTheme) is
  // the SAME function "Extension pages follow the Pinboard theme preset"
  // drives, so it ALSO re-derives the options page's own chrome theme as a
  // side effect -- only 3/15 theme slices were measuring a real palette
  // before this assertion existed, the rest were measuring flexoki-light/
  // dark no matter what `theme` said. Throwing SETUP here, not silently
  // mis-scanning, is the same discipline every other setup step in this
  // file uses (needsDetailOpen/needsBatchBarOpen's throws above).
  const liveTheme = await page.evaluate(() => document.documentElement.dataset.theme || null);
  const expected = expectedDatasetTheme(theme);
  if (liveTheme !== expected) {
    throw new Error(`SETUP: weakTextOnFill ${surface}/${context} expected documentElement.dataset.theme=${JSON.stringify(expected)} (theme=${JSON.stringify(theme)}) but found ${JSON.stringify(liveTheme)} -- theme drifted before the family-13 scan; re-apply themeToStorage(theme) and reload/re-sync before scanning`);
  }
  const { hits, scanned } = await page.evaluate(weakTextProbe, cfg);
  weakTextScanLog.push({ surface, theme, context, scanned });
  for (const h of hits) {
    // F2/F3/F4 (T5 review): the painted ratio is a PRECONDITION for every
    // exemption class weakTextProbe flagged (identity / selection-marker /
    // safe-host) -- reusing THIS runner's own `cr` (imported from contrast-
    // audit.mjs at module scope) so the two audits can never disagree on
    // what "clears" means. Text needs 4.5:1 (WCAG 1.4.3); an icon-only
    // affordance needs 3:1 (1.4.11 floor), matching the one real hit the T5
    // review's ratio-guarded run found on the current (post-batch) tree:
    // library nord-night's pressed sort-seg cell at 3.67 -- passes at the
    // icon floor, correctly NOT exempted by identity/muted/marker alone.
    const threshold = h.label === "icon" ? 3.0 : 4.5;
    const ratio = h.colorRgb && h.fillRgb ? cr(h.colorRgb, h.fillRgb) : 0;
    if (h.exemptedBy && ratio >= threshold) continue; // provably safe on THIS painted pair -- drop, not reported
    results.push({
      surface, theme,
      selector: h.path,
      state: `${context}|${h.label}`,
      check: "weakTextOnFill",
      status: "FAIL",
      actual: `${h.textRole} on ${h.fillRole} (painted ${round2(ratio)}:1, needs ${threshold}:1)`,
      expected: "no fg-hint/fg-muted/link on btn-bg/btn-hover/input-bg/chip-bg (or the batch bands, library only) -- COMPONENTS.md §9.1 law 8",
      // F6: keep the annotation when an exemption class fired but failed the
      // ratio gate -- this is what makes "a trigger existed but didn't save
      // it" visible in the report instead of looking like a plain miss.
      note: h.exemptedBy ? `[was-exempt-by ${h.exemptedBy.join(", ")}]` : null,
    });
  }
}

async function runLibraryTheme(page, extBase, theme, checks, results) {
  // Explicit #vocab hash (not bare navigation): _pbpLibInitialView() prefers
  // an explicit hash over the localStorage "last view" memory, so this can't
  // be dragged into "notes" by a previous theme iteration's tab click.
  //
  // The `_ra` query param is load-bearing, not decoration: a previous theme
  // iteration's #notes tab click does `history.replaceState(null, "", "#notes")`
  // (library.js's _pbpLibApplyView), which does NOT reload the document. If
  // this goto's URL then differs from the current one ONLY by fragment
  // (#notes -> #vocab, same path+query), Chromium treats it as a
  // same-document navigation and skips the reload entirely -- theme storage
  // written by setTheme() right before this call would silently never be
  // picked up, and every iteration after the first would keep testing
  // whatever theme happened to be active on the very first real load. A
  // per-theme query string forces a real cross-document navigation every
  // time (verified: page.goto to the byte-identical URL DOES force a reload
  // in this Chromium; only the fragment-only case does not).
  await page.goto(`${extBase}library.html?_ra=${encodeURIComponent(theme)}#vocab`, { waitUntil: "load", timeout: TIMEOUT_MS });
  await page.waitForSelector("#vocab-list .vocab-card", { timeout: TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(300);

  // ---- weakTextOnFill (family 13, T5): the vocab list's true rest state --
  // no detail pane open, no row selected -- captured BEFORE anything below
  // opens either for some OTHER check's sake. Covers .vocab-sort-seg's
  // unpressed cell (D6/T4's real consumer).
  await recordWeakTextHits(page, "library", theme, results, "vocab-rest");

  const vocabChecks = checks.filter((c) => libraryView(c.selector) === "vocab");
  const notesChecks = checks.filter((c) => libraryView(c.selector) === "notes");

  if (vocabChecks.length) {
    // Setup clicks throw rather than silently no-op on a missing target: a
    // future selector rename (Task 9/10 migration) or a broken seed must
    // make this whole run fail loudly (exit 2), not quietly leave every
    // downstream check reading a zero-size/never-opened element as "PASS".
    if (vocabChecks.some((c) => needsDetailOpen(c.selector))) {
      const head = page.locator("#vocab-list .vocab-card .notes-card-head").first();
      if (!(await head.count())) {
        throw new Error(`SETUP: no "#vocab-list .vocab-card .notes-card-head" to open the vocab detail pane (theme=${theme}) -- seed fixture broken or markup renamed`);
      }
      await head.click(); await page.waitForTimeout(250);
    }
    if (vocabChecks.some((c) => needsBatchBarOpen(c.selector))) {
      // Ctrl+click the row head. The per-row checkbox was removed 2026-08-06
      // (user ruling: the row's own fill IS the selected state), so the
      // modified click that replaced it is the only way to open the batch
      // bar. Same row the detail-open click above uses, exactly as the
      // checkbox click did -- the seeded fixture has one word.
      const head = page.locator("#vocab-list .vocab-card .notes-card-head").first();
      if (!(await head.count())) {
        throw new Error(`SETUP: no "#vocab-list .vocab-card .notes-card-head" to reveal .vocab-batch-bar (theme=${theme}) -- seed fixture broken or markup renamed`);
      }
      await head.click({ modifiers: ["Control"] });
      await page.waitForTimeout(350);
    }
    for (const check of vocabChecks) {
      // .vocab-note-save cannot use the same one-shot-at-the-top pattern as
      // needsDetailOpen/needsBatchBarOpen above: `state: "rowStates"`
      // (driveRowStates) does its OWN full `page.goto()` reload partway
      // through this loop and restores only the "current row" / "selected
      // for batch" flags it knows about (its own click sequence happens to
      // reconstruct both, which is why the detail-open and batch-bar groups
      // above survive it untouched) -- it has no notion of "the note field
      // was typed into" and silently drops that JS-runtime-only state.
      // Re-assert idempotently right before every check that needs it
      // instead of trusting a group-wide setup to survive a reload it
      // doesn't know is coming.
      if (needsNoteDirty(check.selector)) {
        const dirty = await page.evaluate(() => document.querySelector(".vocab-note-save")?.hidden === false);
        if (!dirty) {
          const noteInput = page.locator(".vocab-note-input").first();
          if (!(await noteInput.count())) {
            throw new Error(`SETUP: no ".vocab-note-input" to dirty .vocab-note-save (theme=${theme}) -- seed fixture broken or markup renamed`);
          }
          await noteInput.fill("render-audit probe");
          await page.waitForSelector(".vocab-note-save:not([hidden])", { timeout: TIMEOUT_MS });
        }
      }
      await runOneCheck(page, theme, check, results, extBase);
    }
  }

  // ---- weakTextOnFill (family 13, T5): the batch-selected band (D6
  // follow-up / Ruling 17). Forces the same `.selected` state
  // needsBatchBarOpen() opens above for other checks, but UNCONDITIONALLY --
  // this family's own coverage of .vocab-row-gloss/.notes-row-meta must not
  // depend on some other CHECKS entry happening to need the same state.
  if (!(await page.$(".vocab-card.selected"))) {
    const head = page.locator("#vocab-list .vocab-card .notes-card-head").first();
    // F5(b), T5 review: this opener used to be fail-OPEN (`if (await head.
    // count())`) -- a missing head silently skipped the click and the scan
    // below ran against the UNSELECTED band, reporting a false "0 FAIL"
    // instead of failing loudly the way every sibling opener in this file
    // does (needsDetailOpen/needsBatchBarOpen above throw on the same miss).
    if (!(await head.count())) {
      throw new Error(`SETUP: no "#vocab-list .vocab-card .notes-card-head" to open the batch-selected band for weakTextOnFill (theme=${theme}) -- seed fixture broken or markup renamed`);
    }
    await head.click({ modifiers: ["Control"] }); await page.waitForTimeout(300);
  }
  await recordWeakTextHits(page, "library", theme, results, "vocab-batch");

  if (notesChecks.length) {
    await page.click("#lib-tab-notes");
    await page.waitForSelector("#notes-list .notes-hit", { timeout: TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(250);
    if (notesChecks.some((c) => needsDetailOpen(c.selector))) {
      const hit = page.locator("#notes-list .notes-hit-btn").first();
      if (!(await hit.count())) {
        throw new Error(`SETUP: no "#notes-list .notes-hit-btn" to open the notes detail pane (theme=${theme}) -- seed fixture broken or markup renamed`);
      }
      await hit.click(); await page.waitForTimeout(250);
    }
    for (const check of notesChecks) await runOneCheck(page, theme, check, results, extBase);
  } else {
    // weakTextOnFill still needs the notes tab even on a theme slice whose
    // CHECKS happen to carry no notes-scoped entry -- this family's coverage
    // must not depend on notesChecks staying non-empty.
    await page.click("#lib-tab-notes");
    await page.waitForSelector("#notes-list .notes-hit", { timeout: TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(250);
  }

  // ---- weakTextOnFill (family 13, T5): the notes batch-selected band.
  if (!(await page.$(".notes-hit.selected"))) {
    const hit = page.locator("#notes-list .notes-hit-btn").first();
    // F5(b), T5 review: same fail-closed fix as the vocab band opener above.
    if (!(await hit.count())) {
      throw new Error(`SETUP: no "#notes-list .notes-hit-btn" to open the notes batch-selected band for weakTextOnFill (theme=${theme}) -- seed fixture broken or markup renamed`);
    }
    await hit.click({ modifiers: ["Control"] }); await page.waitForTimeout(300);
  }
  await recordWeakTextHits(page, "library", theme, results, "notes-batch");
}

async function runSimpleTheme(page, url, theme, checks, results, surface, sw) {
  // .saved-theme-btn only renders once storage has at least one entry
  // (options.js renderSavedThemes(), read once at init via syncGetLarge) --
  // seed it BEFORE the navigation below, the same way pinboardToken is
  // seeded elsewhere in this file. Idempotent across the per-theme loop that
  // calls this function repeatedly, so no cleanup is needed. Unconditional
  // for options (not just when a CHECKS entry needs it): family 13's own
  // per-panel activation loop below also needs a saved theme to exist --
  // its confirm-popover leg opens via `.saved-theme-del`.
  if (surface === "options") {
    await sw.evaluate(() => chrome.storage.local.set({ savedThemes: [{ name: "weakTextOnFill probe", css: "body{}" }] }));
  }
  await page.goto(url, { waitUntil: "load", timeout: TIMEOUT_MS });
  await page.waitForTimeout(500); // settles the theme-early async storage.get correction
  if (surface === "popup" && checks.some((c) => c.selector === "#offline-queue-clear")) {
    // Was NOT actually a storage-write race (debt-sweep 2026-08-07 root
    // cause): showOfflineQueueStatus() used to sit after popup.js's
    // unsupported-URL early `return`, so it never ran AT ALL when the
    // popup's own tab isn't a plain http(s) page -- which every direct
    // navigation to popup.html is, harness included. Fixed in popup.js by
    // moving the call earlier.
    //
    // No manual `window.PPOffline.refresh()` call here any more
    // (independent review F4, 2026-08-08): a fixture-side re-trigger of the
    // exact function the fix makes automatic would silently mask a
    // regression of that fix -- popup.js could regress back to skipping
    // showOfflineQueueStatus() and this block would still force the bar
    // visible, and every check below would keep reading PASS. This wait is
    // now pure observation: if the automatic on-load path is doing its job,
    // #offline-queue-bar loses `.hidden` well within the timeout (measured:
    // well under 500ms) with no help from here. If it doesn't, this throws
    // instead of the checks below silently reading a hidden/zero-size
    // element as passing.
    await page.waitForSelector("#offline-queue-bar:not(.hidden)", { timeout: TIMEOUT_MS });
  }
  // popup's main UI (and the markdown strip inside it) ship `class="hidden"`
  // and are un-hidden by popup.js only after it resolves the active tab's
  // bookmark state -- something a plain fixture page cannot produce. Dropping
  // the class is fixture setup of exactly the same kind as library's
  // needsDetailOpen/needsBatchBarOpen clicks: none of the rules under test
  // (focus placement, themed twins) reads `.hidden`, they just need the
  // element to have a box and be focusable. Without this, popup was the one
  // surface with ZERO live focus coverage -- and it is the surface whose
  // hand-written themed override layer made five bordered sites need
  // per-theme focus twins in the first place (COMPONENTS.md C45).
  //
  // The submit bar needs three more pieces of the same kind of setup, all of
  // them consequences of the fixture page being its own chrome-extension://
  // URL, which popup.js correctly treats as unsaveable: it puts
  // `.unsupported-url` on #main-section (whose CSS display:none's every
  // .form-body child except the warning, submit bar included), it DISABLES
  // Save, and the Delete button ships `.hidden` until a bookmark is found.
  // None of those is a state worth auditing -- a display:none control has no
  // box to measure and cannot be focused, and a :disabled one is exempt from
  // contrast (WCAG 1.4.3, the runner SKIPs it) -- so leaving them as-is
  // would have turned every submit-bar assertion into a silent SKIP dressed
  // up as coverage.
  if (surface === "popup" && checks.some((c) => c.state === "focusWithin"
      || c.selector === "#submit-btn" || c.selector === ".del-btn")) {
    const shown = await page.evaluate(() => {
      const main = document.getElementById("main-section");
      const strip = document.getElementById("md-actions-strip");
      main?.classList.remove("hidden", "unsupported-url");
      strip?.classList.remove("hidden");
      const del = document.getElementById("delete-btn");
      const submit = document.getElementById("submit-btn");
      del?.classList.remove("hidden");
      if (submit) submit.disabled = false;
      return !!main && !!strip && !!del && !!submit;
    });
    if (!shown) throw new Error(`SETUP: popup.html is missing #main-section / #md-actions-strip / #delete-btn / #submit-btn (theme=${theme})`);
    await page.waitForTimeout(120);
  }
  // popup's suggest/AI tag chips (D6/D7, Task 5, taste-uplift batch3).
  // Opened UNCONDITIONALLY (same discipline as the confirm popover below --
  // must not depend on `checks` happening to carry a `.stag`-scoped entry
  // for this particular theme slice) so family 13's rest/hidden-legs scans
  // further down see real chips too, not just this file's own .stag
  // checklist rows.
  //
  // fetchPinboardSuggestTags (popup-tags.js) is never reached through
  // popup.js's normal boot on THIS fixture: popup.js's async form-init
  // returns EARLY on `isUnsupportedUrl` (pageInfo.url not starting with
  // http(s)://), which is exactly what every direct chrome-extension://
  // navigation to popup.html produces as its "current tab" URL -- so the
  // suggest fetch this harness needs never fires through that path at all
  // (confirmed by reading popup.js; the investigation this task inherited
  // documented the resulting symptom: #suggest-row opens with only its
  // static .tag-skel loading placeholders, never real chips). Calling the
  // (top-level, un-closured) function directly with a real http(s) URL
  // sidesteps that early return without touching popup.js's own gating
  // logic or faking a second "active tab".
  if (surface === "popup") {
    const suggestReady = await page.evaluate(async (token) => {
      if (typeof fetchPinboardSuggestTags !== "function") return false;
      await fetchPinboardSuggestTags(token, "https://example.com/render-audit-fixture");
      return true;
    }, SEED_TOKEN_RAW);
    if (!suggestReady) {
      throw new Error(`SETUP: fetchPinboardSuggestTags is not defined on popup.html (theme=${theme}) -- the .stag suggest-row fixture cannot render`);
    }
    await page.waitForSelector("#pinboard-suggest-tags .stag", { timeout: TIMEOUT_MS });
    // AI row: renderAITags is the same top-level, un-closured render step a
    // real or cached AI response ultimately calls (popup-ai.js has no
    // network-free "read the cache" entry point that ALSO does the DOM
    // diffing on its own) -- this drives that render step directly with a
    // fixture tag, the render-side equivalent of a cache hit, without
    // fabricating an AI provider HTTP response.
    await page.evaluate(() => {
      if (typeof renderAITags === "function") renderAITags(["renderAuditAiFixtureTag"], true);
    });
    await page.waitForSelector("#ai-suggest-tags .stag.ai", { timeout: TIMEOUT_MS });
    // .stag.used: a direct class+disabled toggle, NOT the real click handler
    // (popup-tags.js's buildSuggestGroup click listener) -- deliberately.
    // The real handler's first line is addTag(), which populates
    // #tags-display with a REAL .tag-item for the very first time this
    // harness ever renders one (every other popup fixture leaves that list
    // empty): confirmed live (scratch diagnostic, not committed) that this
    // newly gives family 13 (weakTextOnFill) its first-ever look at
    // .tag-item/.tag-remove, and they FAIL it -- a pre-existing, unrelated
    // law-8 violation in a completely different component this task does
    // not touch. Reproducing exactly what the click handler leaves behind
    // on the CHIP itself (`.used` + `.disabled`) without invoking addTag()
    // proves the same CSS state this task's checklist rows and family 13
    // actually care about, without dragging an out-of-scope component into
    // this run's coverage. `.last()`, NOT `.first()`: this file's own
    // `.stag` checklist rows below query the bare `.stag` selector (first
    // DOM match = the popular group's first chip, "reading") expecting a
    // REST-state chip -- marking that one `.used` instead would make every
    // one of those rows measure the used state.
    await page.evaluate(() => {
      // querySelectorAll + array index, not a :last-of-type/:last-child
      // pseudo-class: .add-all-link is ALSO a <button> and IS each
      // suggest-group's actual last button child, so either pseudo-class
      // would match nothing (a compound selector needs both halves true on
      // the SAME element).
      const chips = document.querySelectorAll("#pinboard-suggest-tags .stag");
      const el = chips[chips.length - 1];
      if (el) { el.classList.add("used"); el.disabled = true; }
    });
    // .stag's `transition: background ..., color ...` (--pp-motion-state,
    // 150ms) means an immediate read right after the class add can still
    // catch the interpolated frame (verified live, scratch diagnostic: the
    // "used" chip's background read as chip-bg, not transparent, without
    // this wait) -- same settle discipline runOneCheck's own hover/focus
    // states already use elsewhere in this file.
    await page.waitForTimeout(200);
    // #suggest-row ships `class="row hidden"` (popup.html) until popup.js's
    // own showMain() unhides it -- unreachable here for the same early-
    // return reason as above, so it needs the same manual unhide the other
    // POPUP_HIDDEN_LEG_IDS legs get, but early: this file's own .stag
    // checklist rows run in the shared CHECKS loop right below, well before
    // that later pass.
    //
    // Defensively re-disabling #submit-btn=false here too: an EARLIER
    // version of this block called the real click handler (addTag() ->
    // renderTags() -> updateCharCount(), popup-tags.js/popup.js), which
    // unconditionally recomputes `sub.disabled = urlBad || over ||
    // !_pageInfoReady` -- and `_pageInfoReady` is a script-scope `let`,
    // forever false on this fixture (the isUnsupportedUrl early return this
    // whole block exists to route around sits BEFORE the only line that
    // ever sets it true), so that recompute always re-disabled the button
    // regardless of the URL (confirmed live, scratch diagnostic, not
    // committed -- setting #url-input's value did NOT help either;
    // `!_pageInfoReady` alone was enough). The .used marking above no
    // longer calls addTag() (see its own comment), so nothing in this
    // block's current form is known to trip updateCharCount() any more --
    // this stays as cheap, idempotent insurance rather than a proven-needed
    // fix, since the "shown" block already proved #submit-btn is otherwise
    // a legitimate, visible, enabled target for the existing focusWithin
    // checks on it.
    await page.evaluate(() => {
      document.getElementById("suggest-row")?.classList.remove("hidden");
      const submit = document.getElementById("submit-btn");
      if (submit) submit.disabled = false;
    });
  }
  // popup's confirm popover only exists after a destructive action is
  // clicked. #logout-link is the cheapest opener that reaches the SHARED
  // showConfirmPopover() path (the same helper every other popup confirm
  // uses), and confirming is not automatic -- the probe reads the popover
  // and the run ends without ever pressing Yes. Without this, the solid
  // danger tier had zero live coverage on popup: it is emitted into the
  // generated region, but the only thing that could catch a hand-written
  // themed override re-outranking it is a per-theme render of the real
  // thing (COMPONENTS.md §7.1's two-door rule -- the static half lives in
  // tests/ui-contract-tests.mjs).
  //
  // Opened LAST, in its own group immediately before its own checks, rather
  // than here in shared setup: the popover light-dismisses on focusout
  // (showConfirmPopover in shared.js), so the §8 focusWithin probes that come
  // earlier in the popup checklist -- .qbtn, .md-strip-btn -- move focus onto
  // a real element outside it and close it exactly the way a user tabbing
  // away would. Same per-group setup discipline the options branch below
  // spells out: a setup step must run next to the checks that need it, not
  // once at the top for a loop that runs much later.
  const confirmChecks = surface === "popup"
    ? checks.filter((c) => c.selector.startsWith(".confirm-popover"))
    : [];
  if (surface === "options") {
    // Two tab-scoped groups, each needs ITS OWN tab active when its checks
    // actually run -- NOT two independent "switch tab" steps that both fire
    // before one shared loop at the end (a real regression this file's own
    // Task 14 edit briefly introduced: clicking #tab-appearance for the
    // preset-preview group after already clicking #tab-tags for the
    // tag-gov group left options on the WRONG tab by the time
    // .tag-gov-chip-face's checks ran in that shared loop, reporting it as
    // zero-size across all 16 themes). Each group's checks now run
    // immediately after its own setup click, before the next group touches
    // the tab strip.
    // `#tag-gov-selected-count` is an ID selector with no ".tag-gov-" class
    // substring -- widened alongside it (Ruling 8) so an ID-based tag-gov
    // check is still bucketed onto the "tags" tab instead of falling through
    // to otherChecks, which by the time it runs has #tab-general active.
    const tagGovChecks = checks.filter((c) => c.selector.includes(".tag-gov-") || c.selector.includes("#tag-gov-"));
    // presetRowChecks (design-uplift, preset-row redesign, 2026-08-04):
    // .theme-preset-btn.active only exists once SOME preset is selected --
    // reuses the exact same "click flexoki on the appearance tab" step
    // presetPreviewChecks already needs (both groups just need any preset
    // active; there is nothing flexoki-specific about either check), so
    // it's folded into that same click rather than a second one.
    const presetRowChecks = checks.filter((c) => c.selector === ".theme-preset-btn.active");
    const presetPreviewChecks = checks.filter((c) => c.selector.startsWith("#preset-preview-section"));
    // .saved-theme-btn (debt-sweep 2026-08-07): same #panel-appearance tab as
    // the preset-row group above, so it reuses that group's #tab-appearance
    // click rather than a third one. Storage was seeded before goto() (see
    // runSimpleTheme's top), so the button already exists once the tab is
    // active -- no extra click of its own needed.
    const savedThemeChecks = checks.filter((c) => c.selector === ".saved-theme-btn");
    // .key-wrap lives in #panel-general. It is visible on a bare goto(), but
    // the tagGov and preset groups above BOTH click their way to another tab
    // first, so by the time otherChecks runs the general panel is
    // display:none and its controls cannot even take focus (a §8 focusWithin
    // check fails at setup, which is how this was found). Click back
    // explicitly rather than depending on group order.
    const keyWrapChecks = checks.filter((c) => c.selector === ".key-wrap");
    // T6 field-width checks (taste-uplift-batch3, D2). #opt-openai-baseurl
    // (.fg-url tier) and #opt-openai-model (plain-text tier) both live in
    // #fields-openai (#panel-ai), which is `hidden` by default -- the
    // provider select defaults to gemini (options.js's updateProviderFields)
    // -- so both need the provider switched to openai before they exist at
    // all, not just a tab click. #opt-ai-cache-duration (number tier) lives
    // on the separate #panel-ai-behavior tab, reached with a plain click.
    // Both run in their OWN groups below (like keyWrapChecks above), not
    // folded into otherChecks.
    const aiProviderChecks = checks.filter((c) => c.selector === "#opt-openai-baseurl" || c.selector === "#opt-openai-model");
    const aiBehaviorChecks = checks.filter((c) => c.selector === "#opt-ai-cache-duration");
    const otherChecks = checks.filter((c) => !tagGovChecks.includes(c) && !presetPreviewChecks.includes(c)
      && !presetRowChecks.includes(c) && !savedThemeChecks.includes(c) && !keyWrapChecks.includes(c)
      && !aiProviderChecks.includes(c) && !aiBehaviorChecks.includes(c));
    if (tagGovChecks.length) {
      // .tag-gov-chip-face lives on the "tags" tab (#panel-tags), not
      // #panel-general (the default active one on a bare goto()) -- its
      // panel is `display:none` until #tab-tags is clicked, which is what
      // renderTagGov()'s init actually hangs off of.
      await page.click("#tab-tags");
      await page.waitForSelector(".tag-gov-chip-face", { timeout: TIMEOUT_MS });
      // #tag-gov-lowcount-list's checkbox chips render into a closed
      // <details id="tag-gov-lowcount">: `renderLowCountTags()` populates it
      // regardless of `open`, but a closed <details> computes display:none on
      // its body, so every geometry/contrast check on those chips would
      // measure a zero-size, invisible box (Ruling 8) without this. Click the
      // summary rather than set `.open` directly so this exercises the same
      // path a reader's click does.
      await page.click("#tag-gov-lowcount > summary");
      await page.waitForSelector("#tag-gov-lowcount-list .tag-gov-chip-face", { state: "visible", timeout: TIMEOUT_MS });
      for (const check of tagGovChecks) await runOneCheck(page, theme, check, results);
    }
    if (presetPreviewChecks.length || presetRowChecks.length || savedThemeChecks.length) {
      // #preset-preview-section is `style="display:none"` (options.html)
      // until options.js's renderPresetPreview() sees a non-empty
      // currentPresetKey -- click a site-theme preset button on the
      // "appearance" tab (same tab panel the summary lives on) to reveal
      // it. This is a DIFFERENT preset system from the THEMES loop this
      // runner is already iterating (that one is the extension UI's own
      // popup/options/library chrome; this is the pinboard.in SITE theme
      // picker) -- picking "flexoki" here is unrelated to and doesn't
      // fight with whichever THEMES entry is currently active. The same
      // click also satisfies presetRowChecks: it's what puts .active on a
      // .theme-preset-btn in the first place.
      await page.click("#tab-appearance");
      await page.click(".theme-preset-btn[data-theme='flexoki']");
      await page.waitForSelector("#preset-preview-section:not([style*='display: none'])", { timeout: TIMEOUT_MS });
      for (const check of presetPreviewChecks) await runOneCheck(page, theme, check, results);
      for (const check of presetRowChecks) await runOneCheck(page, theme, check, results);
      if (savedThemeChecks.length) {
        await page.waitForSelector(".saved-theme-btn", { timeout: TIMEOUT_MS });
        for (const check of savedThemeChecks) await runOneCheck(page, theme, check, results);
      }
    }
    if (keyWrapChecks.length) {
      await page.click("#tab-general");
      await page.waitForSelector(".key-wrap input", { state: "visible", timeout: TIMEOUT_MS });
      for (const check of keyWrapChecks) await runOneCheck(page, theme, check, results);
    }
    for (const check of otherChecks) await runOneCheck(page, theme, check, results);

    // T6 field-width groups (taste-uplift-batch3, D2). Run AFTER otherChecks
    // (not interleaved with the tagGov/presetPreview/keyWrap dance above,
    // same reasoning presetPreviewChecks/savedThemeChecks already share one
    // click) -- nothing later in this options branch depends on which tab is
    // left active, since the weakTextOnFill loop right below does its own
    // fresh page.goto() before touching anything.
    if (aiProviderChecks.length) {
      await page.click("#tab-ai");
      await page.selectOption("#opt-ai-provider", "openai");
      await page.waitForSelector("#fields-openai:not([hidden])", { timeout: TIMEOUT_MS });
      await page.waitForSelector("#fields-openai #opt-openai-baseurl", { state: "visible", timeout: TIMEOUT_MS });
      for (const check of aiProviderChecks) await runOneCheck(page, theme, check, results);
    }
    if (aiBehaviorChecks.length) {
      await page.click("#tab-ai-behavior");
      await page.waitForSelector("#opt-ai-cache-duration", { state: "visible", timeout: TIMEOUT_MS });
      for (const check of aiBehaviorChecks) await runOneCheck(page, theme, check, results);
    }

    // ---- weakTextOnFill (family 13, T5 fix wave F1+F5a): options' own
    // activation loop, run AFTER the CHECKS groups above finish (their own
    // per-group tab/click choreography is untouched). Two problems this
    // replaces: (F1) the appearance-tab CHECKS group above clicks
    // `.theme-preset-btn[data-theme='flexoki']` to reveal #preset-preview-
    // section for OTHER checks -- that click's handler (options.js
    // applyPreset -> applyOptionsPageTheme) is the SAME function "Extension
    // pages follow the Pinboard theme preset" drives, so it ALSO re-derives
    // documentElement.dataset.theme as a side effect, leaving only the
    // themes whose own preset happened to be flexoki measuring a real
    // palette (T5 review: 3/15). (F5a) `.panel{display:none}` (options.
    // css:336) meant 12 of the 13 tab panels, and every popover, were never
    // opened for this family's OWN sake -- it only ever scanned whichever
    // panel the CHECKS groups above happened to leave active. Re-applying
    // storage + a fresh navigation here (not a reload later, which would
    // re-close every panel/popover this loop opens) guarantees a clean
    // dataset.theme before ANY of this loop's own clicks run, independent
    // of whatever the CHECKS groups above left the page in.
    const { themePresetKey: _wtPresetKey, optTheme: _wtMode } = themeToStorage(theme);
    await setTheme(sw, _wtPresetKey, _wtMode);
    await page.goto(url, { waitUntil: "load", timeout: TIMEOUT_MS });
    await page.waitForTimeout(500);

    const panelIds = await page.$$eval(".tab-btn", (els) => els.map((e) => e.id));
    if (!panelIds.length) {
      throw new Error(`SETUP: no ".tab-btn" elements on options.html (theme=${theme}) -- weakTextOnFill cannot reach any panel`);
    }
    for (const tabId of panelIds) {
      await page.click(`#${tabId}`);
      await page.waitForTimeout(150);
      // Open every non-help disclosure in the now-active panel -- same
      // opener runSweep uses (~:3321) so a border/chevron-adjacent weak-text
      // bug inside a closed <details> (e.g. the vocabulary/tag-gov/Send-to
      // sections) is reached the same way the geometry families already
      // reach it. Contextual help stays closed (not the rest state).
      await page.evaluate(() => { document.querySelectorAll(".panel.active details:not(.context-help)").forEach((d) => { d.open = true; }); });
      await page.waitForTimeout(100);
      await recordWeakTextHits(page, "options", theme, results, `panel:${tabId}`);

      if (tabId === "tab-appearance") {
        // #preset-preview-section (F1's drift trigger, see above) + the
        // theme-name popover + a confirm popover all live on this one tab,
        // so they're opened in sequence rather than re-navigating per leg.
        const presetBtn = page.locator(".theme-preset-btn[data-theme='flexoki']").first();
        if (!(await presetBtn.count())) {
          throw new Error(`SETUP: no ".theme-preset-btn[data-theme='flexoki']" on ${tabId} (theme=${theme}) -- weakTextOnFill cannot reach #preset-preview-section`);
        }
        await presetBtn.click();
        await page.waitForSelector("#preset-preview-section:not([style*='display: none'])", { timeout: TIMEOUT_MS });
        // Restore documentElement.dataset.theme in-page (NOT a reload,
        // which would re-close #preset-preview-section this click just
        // opened) via the exact function the boot/reload path calls, so
        // the result is byte-identical to what a real reload would
        // produce. `follow: true` matches this fixture's untouched
        // "Extension pages follow the Pinboard theme preset" default.
        const restored = await page.evaluate(({ mode, presetKey }) => {
          if (typeof pbpApplyOptionsEarlyTheme !== "function") return false;
          pbpApplyOptionsEarlyTheme(mode, presetKey, true);
          return true;
        }, { mode: _wtMode, presetKey: _wtPresetKey });
        if (!restored) {
          throw new Error(`SETUP: pbpApplyOptionsEarlyTheme is not defined on options.html (theme=${theme}) -- cannot restore documentElement.dataset.theme after the preset-preview click`);
        }
        await page.waitForTimeout(50);
        await recordWeakTextHits(page, "options", theme, results, "panel:tab-appearance:preset-preview");

        // theme-name popover (`#save-custom-theme` -> `.theme-name-popover`).
        await page.fill("#opt-custom-css", "body{}");
        await page.click("#save-custom-theme");
        await page.waitForSelector(".theme-name-popover", { timeout: TIMEOUT_MS });
        await recordWeakTextHits(page, "options", theme, results, "panel:tab-appearance:theme-name-popover");
        await page.evaluate(() => document.querySelector(".theme-name-popover .tnp-cancel")?.click());

        // confirm popover (`.saved-theme-del` -> the shared showConfirmPopover()
        // path -- savedThemes was seeded at the top of this function).
        // `.saved-theme-del` is opacity:0/visibility:hidden at rest (options.css
        // .saved-theme-wrap:hover/:focus-within reveals it, a hover-only delete
        // affordance) -- a bare .click() fails Playwright's actionability check
        // ("element is not visible"), so the wrap is hovered first, the same
        // way a real pointer user would reveal it before clicking.
        const delWrap = page.locator(".saved-theme-wrap").first();
        if (!(await delWrap.count())) {
          throw new Error(`SETUP: no ".saved-theme-wrap" on ${tabId} (theme=${theme}) -- weakTextOnFill cannot reach the options confirm popover`);
        }
        await delWrap.hover();
        const delBtn = page.locator(".saved-theme-del").first();
        if (!(await delBtn.count())) {
          throw new Error(`SETUP: no ".saved-theme-del" on ${tabId} (theme=${theme}) -- weakTextOnFill cannot reach the options confirm popover`);
        }
        await delBtn.click();
        await page.waitForSelector(".confirm-popover .confirm-yes", { timeout: TIMEOUT_MS });
        await page.waitForTimeout(150);
        await recordWeakTextHits(page, "options", theme, results, "panel:tab-appearance:confirm-popover");
        await page.evaluate(() => document.querySelector(".confirm-popover .confirm-no")?.click());
      }

      if (tabId === "tab-general") {
        // Account tab's Connection Status disclosure. It is a plain closed
        // `<details>` (options.html) -- renderConnectionOverview() populates
        // it regardless of `open`, but a closed disclosure computes
        // display:none on its body, so the generic details-opener above
        // (which only opens `details:not(.context-help)`) DOES reach it --
        // this extra click/wait/scan exists because the panel-level scan
        // above already ran BEFORE this leg's own content settled.
        await page.click("#connection-overview-title");
        await page.waitForSelector("#connection-health .connection-health-row", { timeout: TIMEOUT_MS }).catch(() => {});
        await recordWeakTextHits(page, "options", theme, results, "panel:tab-general:connection-overview");
      }
    }
    return;
  }
  const confirmSet = new Set(confirmChecks);
  for (const check of checks) {
    if (confirmSet.has(check)) continue;
    await runOneCheck(page, theme, check, results);
  }
  // ---- weakTextOnFill (family 13, T5): popup's rest state. `.qbtn` needs no
  // extra setup (it ships visible in the default form); `.md-strip-btn`'s
  // `#md-actions-strip` ships `class="hidden"` until popup.js resolves the
  // active tab's Markdown affordance, which this chrome-extension:// fixture
  // page cannot do -- unhidden by hand, the same kind of fixture setup as the
  // other `.hidden` removals earlier in this function. Runs BEFORE the
  // confirm-popover open below so it can't be affected by that popover's
  // focusout-dismiss behaviour.
  await page.evaluate(() => { document.getElementById("md-actions-strip")?.classList.remove("hidden"); });
  await recordWeakTextHits(page, "popup", theme, results, "rest");

  // ---- weakTextOnFill (family 13, T5 fix wave F5a): the 11 hidden-by-
  // default popup states runSweep already knows how to reveal
  // (POPUP_HIDDEN_LEG_IDS, shared with runSweep so the two lists can't
  // drift), reused here rather than re-invented -- modelled on that same
  // class-toggle list since none of these 11 legs are mutually exclusive and
  // the sweep already established that a simultaneous unhide is a faithful
  // rendering of each one's own recipe (they carry their own button recipes
  // -- .fc-btn, .md-strip-btn, .offline-queue-item > .actions button -- that
  // the default popup never renders, and this family had zero coverage of
  // any of them before this fix). The extra toggle click renders the
  // offline-queue ROWS themselves (no class toggle can conjure them --
  // popup-offline.js only builds them inside renderList(), same reasoning
  // as runSweep's own comment on this exact click).
  await page.evaluate((ids) => {
    for (const id of ids) {
      document.getElementById(id)?.classList.remove("hidden");
    }
    const fb = document.getElementById("ai-error-fallback");
    if (fb && !fb.textContent.trim()) fb.textContent = "Use fallback";
  }, POPUP_HIDDEN_LEG_IDS);
  await page.evaluate(() => document.getElementById("offline-queue-toggle")?.click());
  await page.waitForSelector(".offline-queue-item, .offline-queue-empty", { timeout: TIMEOUT_MS }).catch(() => {});
  // Behavioural fix, not a throw -- the other 10 legs are static popup.html
  // markup that's always present just CSS-hidden, but the queue ROWS are
  // genuinely absent whenever the fixture's offline-queue seed data is
  // missing, the same condition runSweep already warns about (below in this
  // file). Mirrors runSweep's own console.warn for the identical check so a
  // missing leg is visible in the log instead of silently scanning an empty
  // list.
  if (!(await page.$(".offline-queue-item"))) {
    console.warn("[render-audit] weakTextOnFill popup hidden-legs: no .offline-queue-item rendered -- the offline queue seed is missing, .offline-queue-item's fill/text pair is NOT being scanned");
  }
  await page.waitForTimeout(150);
  await recordWeakTextHits(page, "popup", theme, results, "hidden-legs");

  // ---- weakTextOnFill (family 13, T5 fix wave F5a): the confirm popover.
  // Opened UNCONDITIONALLY -- this family's own coverage must not depend on
  // `checks` happening to carry a `.confirm-popover`-scoped CHECKS entry for
  // this particular theme slice. Before this fix, family 13 never scanned
  // this state on popup at all (only options' "rest" existed as a scan
  // point, and even that ran before its own confirm popover ever opened).
  await page.evaluate(() => { document.getElementById("main-section")?.classList.remove("hidden"); });
  await page.click("#logout-link");
  await page.waitForSelector(".confirm-popover .confirm-yes", { timeout: TIMEOUT_MS });
  await page.waitForTimeout(150);
  await recordWeakTextHits(page, "popup", theme, results, "confirm");
  if (confirmChecks.length) {
    for (const check of confirmChecks) await runOneCheck(page, theme, check, results);
  }
}

// Runs inside the page. It reports used values and structural state only;
// the Node side owns contrast math so it reuses this audit's existing WCAG
// primitives instead of introducing a second colour implementation.
const MEDIA_DOM_PROBE = ({ check, query, focusBaseline }) => {
  const visibleColor = (value) => {
    const color = String(value || "").trim().toLowerCase();
    if (!color || color === "transparent") return false;
    return !/^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color);
  };
  const describe = (element) => {
    if (!element) return { found: false, visible: false };
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      found: true,
      visible: rect.width > 0 && rect.height > 0
        && style.display !== "none" && style.visibility !== "hidden"
        && Number.parseFloat(style.opacity || "1") > 0,
    };
  };
  const focusStyle = (element) => {
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
      outlineOffset: Number.parseFloat(style.outlineOffset) || 0,
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
      borderStyles: [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle],
      borderWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
        .map((value) => Number.parseFloat(value) || 0),
      borderColors: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
    };
  };
  // Chromium's forced-colors emulation can resolve an authored 1px outline
  // to 0.666667 CSS px. The invariant here is structural presence, not a
  // thickness rung: any positive used width is a real non-colour carrier.
  const outlineVisible = (style) => !!style && style.outlineWidth > 0
    && style.outlineStyle !== "none" && visibleColor(style.outlineColor);
  const shadowVisible = (style) => !!style && style.boxShadow !== "none"
    && visibleColor(style.boxShadow);
  const borderVisible = (style, index, minimum = 1) => !!style
    && style.borderWidths[index] >= minimum && style.borderStyles[index] !== "none"
    && visibleColor(style.borderColors[index]);
  const focusCue = (before, after) => {
    if (!after) return false;
    const outlineAppeared = outlineVisible(after) && (!outlineVisible(before)
      || before.outlineWidth !== after.outlineWidth
      || before.outlineStyle !== after.outlineStyle
      || before.outlineOffset !== after.outlineOffset);
    const shadowAppeared = shadowVisible(after) && (!shadowVisible(before) || before.boxShadow !== after.boxShadow);
    const borderAppeared = [0, 1, 2, 3].some((index) => borderVisible(after, index)
      && (!borderVisible(before, index)
        || before.borderWidths[index] !== after.borderWidths[index]
        || before.borderStyles[index] !== after.borderStyles[index]));
    return outlineAppeared || shadowAppeared || borderAppeared;
  };

  const textElement = document.querySelector(check.text);
  const text = describe(textElement);
  if (textElement) {
    text.color = getComputedStyle(textElement).color;
    text.bgStack = [];
    for (let node = textElement; node && node.nodeType === 1; node = node.parentElement) {
      text.bgStack.push(getComputedStyle(node).backgroundColor);
    }
  }

  const controlElement = document.querySelector(check.control);
  const control = describe(controlElement);

  const focusElement = document.querySelector(check.focus);
  const focus = describe(focusElement);
  const focusedStyle = focusStyle(focusElement);
  focus.active = !!focusElement && document.activeElement === focusElement;
  focus.cue = focusCue(focusBaseline, focusedStyle);
  focus.style = focusedStyle;

  let selected = null;
  if (check.selected) {
    const selectedElement = document.querySelector(check.selected);
    selected = describe(selectedElement);
    if (selectedElement) {
      const style = focusStyle(selectedElement);
      const ariaCurrent = selectedElement.getAttribute("aria-current");
      selected.selected = selectedElement.getAttribute("aria-selected") === "true"
        || selectedElement.getAttribute("aria-pressed") === "true"
        || (ariaCurrent != null && ariaCurrent !== "false")
        || selectedElement.classList.contains("active")
        || selectedElement.matches(":checked");
      selected.cue = outlineVisible(style) || shadowVisible(style)
        || [0, 1, 2, 3].some((index) => borderVisible(style, index, 2));
    }
  }

  return {
    queryMatches: matchMedia(query).matches,
    text,
    control,
    focus,
    selected,
  };
};

async function prepareMediaSurface(page, surface, theme) {
  if (surface === "popup") {
    const ready = await page.evaluate(() => {
      const main = document.getElementById("main-section");
      const submit = document.getElementById("submit-btn");
      main?.classList.remove("hidden", "unsupported-url");
      if (submit) submit.disabled = false;
      return !!main && !!submit;
    });
    if (!ready) throw new Error(`MEDIA SETUP: popup controls missing (theme=${theme})`);
  } else if (surface === "options") {
    await page.click("#tab-general");
  } else if (surface === "library") {
    await page.click("#lib-tab-vocab");
    await page.waitForSelector("#vocab-list .notes-card-head", { state: "visible", timeout: TIMEOUT_MS });
    await page.evaluate(() => document.body.classList.remove("lib-narrow-detail"));
  }
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(260);
}

async function captureMediaProbe(page, scenario, check) {
  const baseline = await page.evaluate(MEDIA_DOM_PROBE, {
    check,
    query: scenario.query,
    focusBaseline: null,
  });
  await page.keyboard.press("Shift");
  const focused = await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) return false;
    element.focus();
    return document.activeElement === element;
  }, check.focus);
  if (!focused) throw new Error(`MEDIA SETUP: could not focus ${check.focus}`);
  await page.waitForTimeout(260);

  const probe = await page.evaluate(MEDIA_DOM_PROBE, {
    check,
    query: scenario.query,
    focusBaseline: baseline.focus?.style || null,
  });
  // Keep selection independent from the focus ring: otherwise the selected
  // cue could pass only because the selected tab also happened to be focused.
  probe.selected = baseline.selected;
  if (probe.text?.found) {
    const background = compositeStack(probe.text.bgStack || []);
    const foreground = resolveColor(probe.text.color, background);
    probe.text.contrast = foreground ? round2(cr(foreground, background)) : null;
  }
  return probe;
}

async function runMediaPreferenceChecks(page, cdp, surface, theme, results) {
  const check = MEDIA_CHECKS.find((entry) => entry.surface === surface);
  if (!check) throw new Error(`MEDIA SETUP: no hand-written check for ${surface}`);
  await prepareMediaSurface(page, surface, theme);

  let probes = 0;
  for (const scenario of MEDIA_SCENARIOS) {
    await cdp.send("Emulation.setEmulatedMedia", { features: scenario.features });
    try {
      await page.waitForTimeout(120);
      const probe = await captureMediaProbe(page, scenario, check);
      const selectorByCheck = {
        mediaQuery: scenario.query,
        textVisible: check.text,
        textContrast: check.text,
        controlVisible: check.control,
        focusCue: check.focus,
        selectedCue: check.selected,
      };
      for (const verdict of evaluateMediaProbe(probe, check)) {
        results.push({
          surface,
          theme,
          selector: selectorByCheck[verdict.check] || check.control,
          state: `media:${scenario.id}`,
          ...verdict,
        });
      }
      probes += 1;
    } finally {
      await cdp.send("Emulation.setEmulatedMedia", { features: [] });
      await page.evaluate(() => document.activeElement?.blur());
      await page.waitForTimeout(260);
    }
  }
  return probes;
}

function setTheme(sw, presetKey, mode) {
  return sw.evaluate(async ({ p, m }) => {
    await chrome.storage.local.set({ themePresetKey: p, optTheme: m });
  }, { p: presetKey, m: mode });
}

// ============================================================================
// --sweep: generic DOM-wide discovery, NOT the CHECKS/known-failures gate
// above. See the file-header comment for why this exists and why it is not
// wired into the pass/fail path. `cfg` thresholds mirror the textInset/
// heightEqWith `expect` shapes above (kept as literal numbers here, not
// imported from a CHECKS entry -- there IS no CHECKS entry until a hit gets
// fixed and turned into one).
// ============================================================================
const SWEEP_CFG = {
  // textInsetV by the host's rung (2026-09-06): the sm rung (2 + 14 + 2 + 2 = 20)
  // leaves an 11px face 1.67px of glyph inset by construction, so it is held
  // to 1.5; md (26) and every other host keep the 2px law. Glyph boxes are font
  // metrics and vary by platform, which is why textInset stays a discovery
  // family rather than a gate.
  textInsetH: 4, textInsetV: { sm: 1.5, md: 2, other: 2 }, rowTolerance: 1, rhythmLabelMin: 3, rhythmLabelMax: 6, rhythmActionMin: 4,
  // Families 6-9 (design-language gates, 2026-09-05). Geometry is a theme
  // invariant, so one light pass per surface covers every preset.
  // Prose in the reader is typography, not chrome: excluded wholesale.
  excludeWithin: ".doc-body",
  // 6. controlRung -- COMPONENTS.md §1.1 / §6.3: two control heights (md 26,
  //    sm 20) besides the 24px icon target (family 4 owns icon-only buttons).
  //    Exemptions are structural, each a family with its own rung, not a
  //    per-instance allowlist:
  rung: {
    values: [26, 20], tol: 1,
    exempt: [
      "textarea",                                   // multi-line by nature
      "[role='tab']", ".tab-btn", ".lib-tab",       // tab family: 32px on both surfaces
      "#options-search-input",                      // the settings sidebar search box: 32px, the sidebar column's rung shared with the tabs
      ".action-link", ".clear-all-link", ".reset-tab-btn",
      ".tr-link", ".xp-dict-more", ".xp-dict-lemma-link", ".pbp-img-fix-btn", ".pbv-time", // link-styled, no chrome (COMPONENTS.md §0); .pbv-time is the cue row's timestamp (24px hit floor)
      "summary", ".rail-sec-head", ".notes-hit-btn", ".notes-card-head", ".notes-card-top", ".notes-sib", ".connection-health-row", ".hl-item-main", ".send-mi", ".pbv-poster", // row rung: whole-row clickables / section headers / status cards / menu rows / the video poster card
      ".theme-preset-btn", ".saved-theme-btn",       // borderless swatch pills (user-selected variant A, d57cdcf): the sm rung minus the collapsed frame
      ".tags-input-wrap > input", ".vocab-group-unit > input", ".source-badge > .src-seg", // fused-shell inners: the shell is measured instead
    ],
    // fused shells measured as the control they are (COMPONENTS.md §8)
    shells: ".tags-input-wrap, .source-badge, .vocab-group-unit, .vocab-sort-seg",
  },
  // 7. headerFace -- one computed face (size/weight/colour/transform/tracking)
  //    per surface for its section-heading set; anything off the majority is a hit.
  headerSets: {
    options: "h2.section-title, .disclosure > summary",
    "md-preview": ".rail-label, .rail-sec-head",
  },
  // 8. actionRowGap -- a flex/grid row holding buttons must use one of the
  //    surface's allowed column gaps (space-between rows and fused/tab shells exempt).
  actionRowGap: {
    // One value on every surface (2026-09-05): popup rows were 4/6, the
    // reader's 4/6/8, the library lookup bar 4 -- all moved to the 8px rung.
    allowed: { options: [8], library: [8], popup: [8], "md-preview": [8] },
    exempt: [
      ".tabs, .lib-tabs",                                                     // tab strips
      ".vocab-sort-seg, .source-badge, .view-toggle, .vocab-group-unit, .tags-input-wrap, .send-split, .typo-seg", // fused shells / segmented strips
      ".header-icons, .xp-window-actions, .lib-cluster", // icon-button clusters: not button rows; clusterGap (family 12) holds them to 4px instead
      ".connection-health, .theme-presets-group, .kbd-help-chips, .rail-badges, .hl-filter-row", // status-card grid, swatch-pill / chip rows, the highlight legend (gap = two 6px hit pads)
      ".notes-card-top",                                                      // card head: title + chips, the remove X is absolutely positioned
    ].join(", "),
  },
  // 12. clusterGap -- the icon-button cluster rung: 4px on every surface. The
  //     three clusters actionRowGap exempts are the same shape under three
  //     names (library .lib-cluster, popup .header-icons, reader
  //     .xp-window-actions); popup's sat at 2px until 2026-09-06 -- the drift a
  //     shared name would have caught, so the gate holds the shape instead.
  clusterGap: { selectors: { library: ".lib-cluster", popup: ".header-icons", "md-preview": ".xp-window-actions" }, expected: 4 },
  // 9. radiusScale -- every chromed box's uniform border-radius must be one of
  //    the surface's radius TOKENS as currently resolved on <html> (they are
  //    theme-variant: 15 presets restyle --opt-radius-md, so the probe reads
  //    the live values; `tokens` below is only the fallback when none resolve)
  //    or a pill; fused-shell descendants carry concentric (token - border)
  //    radii and are exempt.
  // 10. textFloor -- no visible text under 11px on any surface (popup and
  //     options carried 10px and 9px captions; 11px is every surface's hint size).
  textFloor: { min: 11, exempt: "sup, sub" },
  radiusScale: {
    prefix: { options: "--opt-radius-", popup: "--pp-radius-", library: "--lib-radius-", "md-preview": "--radius-" },
    names: ["sm", "md", "lg", "full", "tag"],
    tokens: { options: [3, 8, 10], popup: [3, 8, 10], library: [4, 8, 12], "md-preview": [4, 8, 12] },
    exemptWithin: ".vocab-sort-seg, .source-badge, .view-toggle, .vocab-group-unit, .tags-input-wrap, .send-split",
  },
  // 11. spacingScale -- every computed margin / padding / gap on a chromed
  //     surface is a value of that surface's spacing scale, read live from
  //     <html> (--opt-sp-N / --pp-sp-N / --lib-sp-N / --sp-N; `tokens` is the
  //     fallback). Keyword (auto / normal), percentage and negative values are
  //     not rhythm and are skipped; 0 is always allowed. Gated through a
  //     shrink-only ledger (tests/render-audit-spacing-baseline.json) rather
  //     than known-failures: the debt is large and retires one rule at a time.
  //     The scale governs RHYTHM -- placement (margins) of everything and the
  //     insets (padding / gap) of layout boxes: bars, panels, popovers, rows,
  //     lists. A control's or chip's own inset is component geometry, not
  //     rhythm: the composer writes .btn-sm as 2px/8px and chips as padV 2 by
  //     contract (COMPONENTS.md §1.1 / §5.1, recipes write px), a select keeps
  //     26px for its chevron, a key field 32px for its eye button -- values
  //     that never migrate and are already gated by controlRung / hitAreaMin /
  //     the chip laws. So `componentInset` -- form controls, .btn, kbd, the
  //     composer's CHIP_TARGETS, the reader's hand-rolled chips/badges, plus
  //     any inline-level chromed box -- is checked for margins only. The
  //     inline-level heuristic alone is NOT enough: a chip that is a flex item
  //     is blockified (computed display "flex", not "inline-flex"), which is
  //     exactly where most chips live (.notes-row-meta, .tag-gov-group-row).
  //     `shells` (element itself, not subtree): page-level insets that are
  //     layout dimensions (rail width, content column, scrollbar gutter math).
  //     `derivedOffsets`: leading-column alignment (options indent = checkbox
  //     16 + gap 4; reader note = dot 8 + gap 6 + inset 4; reader section count
  //     = 24px button + gap; options sidebar group label = tab inset sp-5 + the
  //     tab's 2px indicator border) -- computed from a sibling's width, so never
  //     a scale value by construction. `hairline`: 1px is border compensation.
  spacingScale: {
    prefix: { options: "--opt-sp-", popup: "--pp-sp-", library: "--lib-sp-", "md-preview": "--sp-" },
    names: ["0", "1", "2", "3", "4", "5", "6", "7"], // sp-0 = the library/reader hairline rung (2px)
    tokens: { options: [2, 4, 6, 8, 12, 16, 24], popup: [2, 4, 6, 8, 12, 16, 24], library: [2, 4, 8, 12, 16, 24], "md-preview": [2, 4, 8, 12, 16, 24] },
    tol: 0.5,
    hairline: 1, // <= 1px is a border/optical compensation, not a rhythm value
    margins: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
    insets: ["padding-top", "padding-right", "padding-bottom", "padding-left", "row-gap", "column-gap"],
    componentInset: [
      "button", ".btn", "input", "select", "textarea", "[role='button']", "kbd", "summary",
      ...CHIP_TARGETS.map((t) => t.selector),
      ".token-badge", ".bookmark-badge", ".kbd-help-chip", ".hl-item-lang", ".ask-chip", // reader chips/badges (md-preview is not composed)
    ].join(", "),
    shells: ["html", "body", "main", ".rail", ".empty-state", ".preview-loading"],
    derivedOffsets: [".fg-indent", ".hl-item-note", "#hl-rail-section .rail-sec-count", ".tab-group-label"],
  },
};

// Runs INSIDE the page (Playwright serializes this function's source, same
// constraint as probeSelector -- self-contained, no outer references).
function sweepProbe(cfg) {
  const hits = [];
  function pathOf(el) {
    if (el.id) return "#" + el.id;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).join(".") : "";
    let base = el.tagName.toLowerCase() + (cls ? "." + cls : "");
    const parent = el.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((s) => s.tagName === el.tagName);
      if (same.length > 1) base += `[${same.indexOf(el)}]`;
    }
    return base;
  }
  function visible(el) {
    // el.checkVisibility(), not a hand-rolled display/visibility read: a
    // CLOSED <details>'s non-summary content is hidden via an internal
    // content-visibility mechanism in modern Chromium, not display:none --
    // computed display/visibility both read as normal on it, yet it isn't
    // painted, and (verified live) its getBoundingClientRect() reports a
    // "remembered" box independent of its actually-collapsed <details>
    // ancestor's real box -- exactly the kind of geometry mismatch that
    // produced nonsense textInset/rowHeightEq hits (a closed .vocab-
    // disclosure's #dict-pack-status measuring 56px below its own collapsed
    // parent) before this switched to the platform's own visibility check.
    if (!(el instanceof Element)) return false;
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } else {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  // A button's LABEL text for the icon-only test. x (U+00D7) is the one literal
  // glyph CLAUDE.md sanctions in place of an SVG (the four dismiss sites), so a
  // button whose only text is x is a close icon and is measured as one: the
  // 24px hit floor applies, the text rungs do not.
  const iconLabel = (el) => el.textContent.replace(/\u00D7/g, "").trim();

  // ---- 1. textInset: any element with a direct (own, non-descendant)
  // non-whitespace text node, measured against the nearest element-or-
  // ancestor that is a full 4-side box border (findBorderBoxHost -- see
  // probeSelector's copy of this function in this same file for the full
  // rationale: the real bug's border lives one level above the text, on
  // `#preset-preview-section`, not on the `<summary>` holding the text;
  // ALL FOUR sides required so single-edge dividers like `.reset-tab-btn`'s
  // `border-top` don't count; stops at the first scrollable ancestor since
  // overflowing scrollable content isn't a text-inset bug). ----
  function findBorderBoxHost(start) {
    let cur = start;
    for (let depth = 0; depth < 5 && cur && cur !== document.documentElement; depth++) {
      const c = getComputedStyle(cur);
      if (c.overflowX === "auto" || c.overflowX === "scroll" || c.overflowY === "auto" || c.overflowY === "scroll") return null;
      // The classic single-line ellipsis idiom (white-space:nowrap +
      // text-overflow:ellipsis + overflow:hidden, e.g. .vocab-row-gloss)
      // deliberately lays out text WIDER than its own box and clips it --
      // that's a truncation boundary, not a text-inset bug, so stop here
      // too. Narrower than "any overflow:hidden" on purpose:
      // `#preset-preview-section` (the real bug's border host) ALSO has a
      // bare `overflow:hidden` of its own (clip-to-border-radius, not
      // truncation -- no nowrap/ellipsis alongside it), and a blanket
      // overflow:hidden stop would have walked straight past it and missed
      // the bug this check exists to catch.
      if (c.overflowX === "hidden" && c.whiteSpace === "nowrap" && c.textOverflow === "ellipsis") return null;
      const bw = { t: parseFloat(c.borderTopWidth) || 0, r: parseFloat(c.borderRightWidth) || 0, b: parseFloat(c.borderBottomWidth) || 0, l: parseFloat(c.borderLeftWidth) || 0 };
      if (Math.min(bw.t, bw.r, bw.b, bw.l) > 0) return { host: cur, bw };
      cur = cur.parentElement;
    }
    return null;
  }
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    // sr-only / off-screen text is not painted: nothing to inset
    const er = el.getBoundingClientRect();
    if (er.width <= 1 || er.height <= 1 || er.right <= 0 || er.bottom <= 0 || er.left >= innerWidth || er.top >= innerHeight) continue;
    const directText = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!directText.length) continue;
    const borderHost = findBorderBoxHost(el);
    if (!borderHost) continue;
    const range = document.createRange();
    let uL = Infinity, uT = Infinity, uR = -Infinity, uB = -Infinity;
    for (const tn of directText) {
      range.selectNodeContents(tn);
      for (const r of range.getClientRects()) {
        if (r.width === 0 && r.height === 0) continue;
        uL = Math.min(uL, r.left); uT = Math.min(uT, r.top);
        uR = Math.max(uR, r.right); uB = Math.max(uB, r.bottom);
      }
    }
    if (uL === Infinity) continue;
    const hostRect = borderHost.host.getBoundingClientRect();
    const bw = borderHost.bw;
    const minH = Math.min(uL - (hostRect.left + bw.l), (hostRect.right - bw.r) - uR);
    const minV = Math.min(uT - (hostRect.top + bw.t), (hostRect.bottom - bw.b) - uB);
    const hostH = hostRect.height;
    const rung = Math.abs(hostH - 20) <= 1 ? "sm" : Math.abs(hostH - 26) <= 1 ? "md" : "other";
    const vFloor = typeof cfg.textInsetV === "object" ? cfg.textInsetV[rung] : cfg.textInsetV;
    if (minH < cfg.textInsetH - 0.5 || minV < vFloor - 0.5) {
      hits.push({ kind: "textInset", path: pathOf(el), minH: Math.round(minH * 100) / 100, minV: Math.round(minV * 100) / 100, rung });
    }
  }

  // ---- 2. childContainment: <summary> icon/pseudo children must stay
  // inside the host border-box. Scoped to <summary> (not every button) --
  // buttons legitimately use ::before to EXPAND their hit area past their
  // own visual box on purpose (COMPONENTS.md §1.5), which would make this
  // check fire on every one of them; disclosures don't use that pattern. ----
  for (const host of document.querySelectorAll("summary")) {
    if (!visible(host)) continue;
    const hostRect = host.getBoundingClientRect();
    const children = [];
    const svgEl = host.querySelector("svg");
    if (svgEl) { const r = svgEl.getBoundingClientRect(); children.push({ kind: "svg", rect: r }); }
    for (const pseudo of ["::before", "::after"]) {
      const pcs = getComputedStyle(host, pseudo);
      if (!pcs || !pcs.content || pcs.content === "none") continue;
      const marker = "pbpSweepGhost" + Math.random().toString(36).slice(2);
      host.classList.add(marker);
      const styleEl = document.createElement("style");
      styleEl.textContent = `.${marker}${pseudo} { content: none !important; }`;
      document.head.appendChild(styleEl);
      const ghost = document.createElement("span");
      const props = ["position", "top", "right", "bottom", "left", "width", "height", "display",
        "marginTop", "marginRight", "marginBottom", "marginLeft",
        "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
        "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
        "boxSizing", "transform", "transformOrigin", "flexShrink", "flexGrow", "flexBasis", "alignSelf"];
      for (const p of props) { try { ghost.style[p] = pcs[p]; } catch (_) {} }
      if (pseudo === "::before") host.insertBefore(ghost, host.firstChild); else host.appendChild(ghost);
      const r = ghost.getBoundingClientRect();
      ghost.remove(); styleEl.remove(); host.classList.remove(marker);
      if (r.width || r.height) children.push({ kind: pseudo, rect: r });
    }
    const tol = 1;
    for (const c of children) {
      const over = {
        left: hostRect.left - c.rect.left, right: c.rect.right - hostRect.right,
        top: hostRect.top - c.rect.top, bottom: c.rect.bottom - hostRect.bottom,
      };
      if (over.left > tol || over.right > tol || over.top > tol || over.bottom > tol) {
        hits.push({ kind: "childContainment", path: pathOf(host), childKind: c.kind,
          overflow: { left: Math.round(over.left * 100) / 100, right: Math.round(over.right * 100) / 100, top: Math.round(over.top * 100) / 100, bottom: Math.round(over.bottom * 100) / 100 } });
      }
    }
  }

  // ---- 3. rowHeightEq: pairwise height compare among interactive controls
  // (input/select/button/textarea) collected from a flex/grid container's
  // direct children, flattening ONE level into a child that is itself a
  // flex/grid wrapper (e.g. .vocab-sort-seg, a span wrapping two buttons, or
  // .vocab-group-unit wrapping a field and its two steppers) so the
  // comparison reaches controls that aren't literal DOM siblings but ARE the
  // same visual row. ----
  // input[type=radio/checkbox/range/color/file] are native OS-sized toggle
  // atoms, not the text-field-shaped controls COMPONENTS.md's §6.3 rowRungEq
  // means by "input" (its own worked examples are all input[type=text]).
  // Comparing one against a .btn-sm's 20px pill height (verified: a 13px
  // radio vs a 20px button, diff=7-7.8px) produced Task 14 sweep false
  // positives at two different sites (options tab-popup's popup-width
  // custom row, tab-tags's #tag-gov-groups merge row) that both trace back
  // to this same over-broad tag-name-only match.
  const NON_FIELD_INPUT_TYPES = new Set(["radio", "checkbox", "range", "color", "file", "hidden", "submit", "reset", "image", "button"]);
  function isControl(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.tagName === "SELECT" || el.tagName === "BUTTON" || el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return !NON_FIELD_INPUT_TYPES.has((el.getAttribute("type") || "text").toLowerCase());
    return false;
  }
  // A ROW container: a flex box laid out along the row axis, or a grid. A
  // column flex box stacks rows (the reader's #rail: source badge, view
  // toggle, bottom icon row) -- its children are not one visual row, and
  // flattening through it compared an 18px fused inner with 26px buttons
  // three rows away (12 phantom hits, 2026-09-06).
  function isFlexOrGrid(cs) {
    if (cs.display === "flex" || cs.display === "inline-flex") return !/^column/.test(cs.flexDirection);
    return cs.display === "grid" || cs.display === "inline-grid";
  }
  function collectControls(el, depth) {
    if (depth > 3 || !visible(el)) return [];
    // Same two rules controlRung applies (2026-09-06): a fused shell
    // (.vocab-group-unit, .source-badge, ...) is ONE control -- its borderless
    // inners are 18px by construction while a standalone sm control is 20px
    // with its 1px frame (19.33px at DPR 1.5), so comparing them produced 25
    // phantom 1.33px pairs; and a control controlRung exempts (textarea,
    // whole-row buttons, tabs, link-styled buttons) is not on a rung to
    // compare against.
    if (el.matches(cfg.rung.shells)) return [el];
    if (isControl(el)) return cfg.rung.exempt.some((sel) => el.matches(sel)) ? [] : [el];
    if (isFlexOrGrid(getComputedStyle(el))) {
      let out = [];
      for (const child of el.children) out = out.concat(collectControls(child, depth + 1));
      return out;
    }
    return [];
  }
  const seenPairs = new Set();
  for (const container of document.querySelectorAll("body *")) {
    if (!visible(container) || !isFlexOrGrid(getComputedStyle(container))) continue;
    let controls = [];
    for (const child of container.children) controls = controls.concat(collectControls(child, 0));
    if (controls.length < 2) continue;
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i], b = controls[j];
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        if (ra.height === 0 || rb.height === 0) continue;
        const diff = Math.abs(ra.height - rb.height);
        if (diff > cfg.rowTolerance) {
          const key = [pathOf(a), pathOf(b)].sort().join("~");
          if (seenPairs.has(key)) continue;
          seenPairs.add(key);
          hits.push({ kind: "rowHeightEq", containerPath: pathOf(container), a: pathOf(a), b: pathOf(b), diff: Math.round(diff * 100) / 100 });
        }
      }
    }
  }

  // ---- 4. hitAreaMin (design-uplift final-fix I2 -- generalized from the
  // two hand-enumerated §1.4 CHECKS entries this replaces): every icon-only
  // <button> -- no direct non-whitespace text node, the same USER RULING
  // scope the hand-enumerated entries already used -- needs an effective
  // hit area >=24px on its short side. "Effective" includes the §1.5
  // ::before hit-area expansion (probeSelector's copy of this same
  // Chromium-resolves-used-px-values trick has the full rationale); a host
  // with no ::before, or one that isn't position:absolute, just falls back
  // to its own border-box rect. Unlike families 1-3 above, this one's hits
  // are wired into the pass/fail gate (see runSweep's caller in main()),
  // not left as --sweep-only discovery -- geometry/spacing in this codebase
  // is a hand-maintained, theme-INVARIANT layer (CLAUDE.md: --pp-sp-*/
  // --opt-sp-*/--lib-sp-* "是主题不变量...不进 composer"), so one pass here
  // already covers every data-theme preset; no per-theme repeat needed.
  //
  // Selector widened from "button" to "button, [role='button']" (popup
  // button-family campaign, 2026-08-07). The old scope was anchored on the
  // TAG NAME, so an icon-only control built as `<span role="button"
  // tabindex="0">` -- which is a button to every assistive technology and to
  // the user's finger -- was structurally invisible to this gate no matter
  // how small it got. That is the "断言问得太窄等于没门" shape: the simplest
  // counter-example the old scan missed is popup's `.recent-bm-del` (13px
  // cross glyph in 0 2px padding). Surveyed before widening: the only
  // role="button" sites in shipped code are popup.js's three spans
  // (.edit-cancel, .recent-bm-edit, .recent-bm-del) and md-translate.js's
  // (not an audited surface); options.css/library.css have zero, so this
  // cannot manufacture new failures on the other two surfaces.
  for (const el of document.querySelectorAll("button, [role='button']")) {
    if (!visible(el)) continue;
    // Full textContent, not just direct child text nodes: setBtnIcon's standard
    // shape is <span class="btn-ic">{svg}</span><span>{label}</span> -- the label
    // lives on a *nested* text node one level down, so the old direct-children-only
    // scan never saw it and misclassified every icon+label button as icon-only.
    // Safe against the icon side because this repo's SVG icon set carries no
    // <text> nodes (see PBP_ICONS comment in shared.js), so .btn-ic never
    // contributes stray text; no aria-hidden-scoped exclusion is needed here.
    const hasOwnText = iconLabel(el).length > 0;
    if (hasOwnText) continue; // has its own label text -- not the icon-only shape this rule scopes to
    const rect = el.getBoundingClientRect();
    let effRect = { width: rect.width, height: rect.height };
    const beforeCs = getComputedStyle(el, "::before");
    if (beforeCs && beforeCs.content && beforeCs.content !== "none" && beforeCs.position === "absolute") {
      const bw = parseFloat(beforeCs.width), bh = parseFloat(beforeCs.height);
      if (Number.isFinite(bw) && Number.isFinite(bh)) effRect = { width: Math.max(rect.width, bw), height: Math.max(rect.height, bh) };
    }
    const shortSide = Math.min(effRect.width, effRect.height);
    if (shortSide < 24) {
      hits.push({ kind: "hitAreaMin", path: pathOf(el), shortSide: Math.round(shortSide * 100) / 100 });
    }
  }

  // ---- 5. fgRhythm (options spacing retrospective, 2026-09-05): the vertical
  // relationships INSIDE a form group, measured on the painted page. Two of
  // the four (label -> control 4px; control/hint -> action row >= 4px) had no
  // CSS owner and no gate: the same "Test connection" row shipped as an
  // inline-styled div (6px), a bare button after the group (12px) and a
  // wrapper with no margin (0px -- the AnkiConnect/Eudic report), and every
  // help-bearing field carried a 12.67px label gap against 4px elsewhere
  // because the 24px help target sized its grid row. Gated like family 4
  // (one pass, theme-invariant geometry). Scoped to the .fg family, which
  // only options has, so it is a no-op on popup/library.
  {
    const isControl = (el) => el.matches("input, select, textarea, .key-wrap");
    const isAction = (el) => el.matches(".fg-actions, button, .btn");
    const stackedGap = (a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return rb.top < ra.bottom - 0.5 ? null : Math.round((rb.top - ra.bottom) * 100) / 100; // null = side by side
    };
    const push = (el, rel, gap) => hits.push({ kind: "fgRhythm", path: pathOf(el), rel, gap });
    for (const fg of document.querySelectorAll(".fg")) {
      if (!visible(fg)) continue;
      const kids = Array.from(fg.children).filter(visible);
      for (let i = 1; i < kids.length; i++) {
        const a = kids[i - 1], b = kids[i];
        const gap = stackedGap(a, b);
        if (gap === null) continue;
        if (a.matches("label.bl, .bl") && isControl(b) && (gap < cfg.rhythmLabelMin || gap > cfg.rhythmLabelMax)) push(b, "label-control", gap);
        if (isAction(b) && !isAction(a) && gap < cfg.rhythmActionMin) push(b, "action", gap);
      }
    }
    // Sibling placement (a .fg-actions after a .fg or another block) still owes
    // the same minimum to whatever precedes it.
    for (const row of document.querySelectorAll(".fg-actions")) {
      if (!visible(row) || row.parentElement?.matches(".fg")) continue;
      let prev = row.previousElementSibling;
      while (prev && !visible(prev)) prev = prev.previousElementSibling;
      if (!prev) continue;
      const gap = stackedGap(prev, row);
      if (gap !== null && gap < cfg.rhythmActionMin) push(row, "action", gap);
    }
  }

  // ---- 6-9. design-language class scans (2026-09-05). Same philosophy as
  // families 4/5: assert the law over every element of a class, never an
  // enumerated instance, so a new control / heading / button row / chromed
  // box is covered the moment it exists. Surface comes from the page URL so
  // per-surface scales (gap sets, radius tokens) resolve inside the page.
  {
    const surface = (location.pathname.match(/\/(popup|options|library|md-preview)\.html$/) || [])[1] || "unknown";
    const excluded = (el) => cfg.excludeWithin && el.closest(cfg.excludeWithin);
    const controls = [...document.querySelectorAll(`button, .btn, a.btn, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]), select, ${cfg.rung.shells}`)];
    const shellSel = cfg.rung.shells;
    for (const el of controls) {
      if (!visible(el) || excluded(el)) continue;
      if (cfg.rung.exempt.some((sel) => el.matches(sel))) continue;
      if (el.matches("button, .btn, a.btn") && !el.matches(shellSel) && !iconLabel(el)) continue; // icon-only (x counts as an icon): family 4
      if (!el.matches(shellSel) && el.closest(shellSel)) continue; // inner of a fused shell: the shell is measured
      const h = el.getBoundingClientRect().height;
      if (!cfg.rung.values.some((v) => Math.abs(h - v) <= cfg.rung.tol)) {
        hits.push({ kind: "controlRung", path: pathOf(el), height: Math.round(h * 100) / 100, detail: `${Math.round(h)}px` });
      }
    }
    const headerSel = cfg.headerSets[surface];
    if (headerSel) {
      const faces = new Map();
      const items = [...document.querySelectorAll(headerSel)].filter((el) => visible(el) && !excluded(el));
      for (const el of items) {
        const cs = getComputedStyle(el);
        const face = `${cs.fontSize}/${cs.fontWeight}/${cs.color}/${cs.textTransform}/${cs.letterSpacing}`;
        faces.set(face, (faces.get(face) || []).concat(el));
      }
      if (faces.size > 1) {
        const [majority] = [...faces.entries()].sort((a, b) => b[1].length - a[1].length)[0];
        for (const [face, els] of faces) if (face !== majority) for (const el of els) hits.push({ kind: "headerFace", path: pathOf(el), face, majority, detail: face });
      }
    }
    const allowedGaps = cfg.actionRowGap.allowed[surface] || [];
    for (const el of document.querySelectorAll("*")) {
      if (!visible(el) || excluded(el) || el.matches(cfg.actionRowGap.exempt) || el.closest(cfg.actionRowGap.exempt)) continue;
      const cs = getComputedStyle(el);
      if (!/flex|grid/.test(cs.display) || cs.justifyContent === "space-between") continue;
      const kids = Array.from(el.children).filter(visible);
      if (kids.length < 2 || !kids.some((k) => k.matches("button, .btn, a.btn"))) continue;
      const gap = cs.columnGap === "normal" ? 0 : Math.round(parseFloat(cs.columnGap));
      if (!allowedGaps.includes(gap)) hits.push({ kind: "actionRowGap", path: pathOf(el), gap, allowed: allowedGaps, detail: `${gap}px` });
    }
    const clusterSel = cfg.clusterGap && cfg.clusterGap.selectors[surface];
    if (clusterSel) {
      for (const el of document.querySelectorAll(clusterSel)) {
        if (!visible(el) || excluded(el)) continue;
        const cs = getComputedStyle(el);
        const gap = cs.columnGap === "normal" ? 0 : Math.round(parseFloat(cs.columnGap) * 100) / 100;
        if (Math.abs(gap - cfg.clusterGap.expected) > 0.5) hits.push({ kind: "clusterGap", path: pathOf(el), gap, expected: cfg.clusterGap.expected, detail: `${gap}px` });
      }
    }
    const rootCs = getComputedStyle(document.documentElement);
    const liveTokens = (cfg.radiusScale.names || []).map((n) => parseFloat(rootCs.getPropertyValue(`${cfg.radiusScale.prefix[surface] || "--radius-"}${n}`))).filter((v) => Number.isFinite(v));
    for (const el of document.querySelectorAll("*")) {
      if (!visible(el) || excluded(el) || el.closest("svg") || el.matches(cfg.textFloor.exempt)) continue;
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < cfg.textFloor.min - 0.01) hits.push({ kind: "textFloor", path: pathOf(el), fontSize: Math.round(fs * 100) / 100, detail: `${fs}px` });
    }
    const radiusTokens = liveTokens.length ? liveTokens : (cfg.radiusScale.tokens[surface] || []);
    for (const el of document.querySelectorAll("*")) {
      if (!visible(el) || excluded(el) || el.closest(cfg.radiusScale.exemptWithin)) continue;
      if (el.closest("svg")) continue;
      const cs = getComputedStyle(el);
      const chromed = (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") || parseFloat(cs.borderTopWidth) > 0 || cs.outlineStyle !== "none";
      if (!chromed) continue;
      const corners = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
      if (corners.some((c) => c !== corners[0]) || corners[0] === "0px") continue;
      const r = corners[0];
      if (/%$/.test(r)) continue;                       // 50% dots
      const px = parseFloat(r);
      if (px >= 999 || radiusTokens.some((t) => Math.abs(px - t) < 0.5)) continue;
      hits.push({ kind: "radiusScale", path: pathOf(el), radius: r, tokens: radiusTokens, detail: r });
    }
    // ---- 11. spacingScale. Typed OM (computedStyleMap) gives the COMPUTED
    // value, which still distinguishes `auto` / `normal` keywords and
    // percentages from lengths; getComputedStyle would hand back the used
    // px for `margin: 0 auto` and make every centred block a hit. Identity
    // for the ledger is `parent > element` by tag/classes or #id, without the
    // sibling index pathOf() adds, so a reordered sibling doesn't mint a new
    // debt entry and every instance of one rule collapses onto one line.
    const sc = cfg.spacingScale;
    if (sc && sc.prefix[surface]) {
      const liveScale = sc.names.map((n) => parseFloat(rootCs.getPropertyValue(`${sc.prefix[surface]}${n}`))).filter((v) => Number.isFinite(v));
      const scale = liveScale.length ? liveScale : (sc.tokens[surface] || []);
      const onScale = (v) => v <= sc.hairline || scale.some((t) => Math.abs(v - t) <= sc.tol);
      const identOf = (el) => {
        if (!el || el === document) return "";
        if (el.id) return "#" + el.id;
        const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).join(".") : "";
        return el.tagName.toLowerCase() + (cls ? "." + cls : "");
      };
      const seen = new Set();
      const isChromed = (cs) => (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") || parseFloat(cs.borderTopWidth) > 0;
      for (const el of document.querySelectorAll("*")) {
        if (!visible(el) || excluded(el) || el.closest("svg")) continue;
        if (sc.shells.some((sel) => el.matches(sel)) || sc.derivedOffsets.some((sel) => el.matches(sel))) continue;
        const cs = getComputedStyle(el);
        const laidOut = /flex|grid/.test(cs.display);
        // component geometry (own inset of a control / chip / badge): margins only
        const component = el.matches(sc.componentInset) || (/^inline/.test(cs.display) && isChromed(cs));
        const props = component ? sc.margins : sc.margins.concat(sc.insets);
        const map = typeof el.computedStyleMap === "function" ? el.computedStyleMap() : null;
        for (const prop of props) {
          if (/gap$/.test(prop) && !laidOut) continue;
          let v = null;
          if (map) {
            const cv = map.get(prop);
            if (!cv || !(cv instanceof CSSUnitValue) || cv.unit !== "px") continue; // keyword, percentage, unresolved calc
            v = cv.value;
          } else {
            const raw = cs.getPropertyValue(prop);
            if (!/px$/.test(raw)) continue;
            v = parseFloat(raw);
          }
          if (!Number.isFinite(v) || v < 0 || onScale(v)) continue;
          const value = Math.round(v * 100) / 100;
          const ident = `${identOf(el.parentElement)} > ${identOf(el)}`;
          const key = `${ident}|${prop}|${value}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ kind: "spacingScale", path: ident, prop, value, scale, detail: `${prop}=${value}px` });
        }
      }
    }
  }

  return hits;
}

// ---- spacingScale ledger (shrink-only ratchet). Identity = surface + `parent >
// element` path + property + computed px value; `scale` is recorded for the
// reader, not compared. `--write-spacing-baseline` is the only writer.
function spacingKey(h) { return `${h.surface}|${h.path}|${h.prop}|${h.value}`; }

function readSpacingBaseline() {
  if (!existsSync(SPACING_BASELINE_PATH)) return new Map();
  let data;
  try { data = JSON.parse(readFileSync(SPACING_BASELINE_PATH, "utf8")); } catch (e) {
    console.error(`[render-audit] failed to parse ${SPACING_BASELINE_PATH}: ${e.message}`);
    process.exit(2);
  }
  if (data.version !== 1 || !Array.isArray(data.entries)) {
    console.error(`[render-audit] ${SPACING_BASELINE_PATH}: unsupported baseline shape`);
    process.exit(2);
  }
  const map = new Map();
  for (const e of data.entries) {
    if (typeof e.surface !== "string" || typeof e.path !== "string" || typeof e.prop !== "string" || typeof e.value !== "number") {
      console.error(`[render-audit] ${SPACING_BASELINE_PATH}: malformed entry ${JSON.stringify(e)}`);
      process.exit(2);
    }
    map.set(spacingKey(e), e);
  }
  return map;
}

function uniqueSpacingHits(sweepHits) {
  const byKey = new Map();
  for (const h of sweepHits) if (h.kind === "spacingScale" && !byKey.has(spacingKey(h))) byKey.set(spacingKey(h), h);
  return [...byKey.values()].sort((a, b) => spacingKey(a).localeCompare(spacingKey(b)));
}

function writeSpacingBaseline(sweepHits) {
  const entries = uniqueSpacingHits(sweepHits).map((h) => ({ surface: h.surface, path: h.path, prop: h.prop, value: h.value, scale: h.scale }));
  const perSurface = {};
  for (const e of entries) perSurface[e.surface] = (perSurface[e.surface] || 0) + 1;
  writeFileSync(SPACING_BASELINE_PATH, JSON.stringify({
    version: 1,
    identity: "surface + `parent > element` (tag.classes or #id, no sibling index) + property + computed px value that is off that surface's live --*-sp-N scale (spacingScale, ui-render-audit family 11). Shrink-only: delete entries as rules migrate to the scale; regenerate deliberately with --write-spacing-baseline. `scale` is informational.",
    entries,
  }, null, 2) + "\n");
  console.log(`[render-audit] spacingScale: wrote ${entries.length} off-scale identit(ies) to ${SPACING_BASELINE_PATH} (${Object.entries(perSurface).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`);
}

// Returns the hits not covered by the ledger; prints the ledger reconciliation.
function reconcileSpacing(sweepHits) {
  const baseline = readSpacingBaseline();
  const unique = uniqueSpacingHits(sweepHits);
  const fresh = unique.filter((h) => !baseline.has(spacingKey(h)));
  const seen = new Set(unique.map(spacingKey));
  const stale = [...baseline.keys()].filter((k) => !seen.has(k));
  console.log(`[render-audit] spacingScale: ${unique.length} off-scale identit(ies), ${unique.length - fresh.length} held by ${SPACING_BASELINE_PATH.replace(ROOT + "/", "")}, ${fresh.length} new, ${stale.length} stale`);
  if (stale.length) {
    console.log(`[render-audit] spacingScale ledger entries that no longer reproduce -- delete them (the ledger only shrinks):`);
    for (const k of stale) console.log(`  STALE  ${k}`);
  }
  return fresh;
}

// The reader's interaction-only surfaces and how the sweep opens them. Page-
// side functions (serialized by Playwright): they may use the reader's own
// globals but nothing from this file. `open` returns true when the surface is
// on screen. The explain popover is opened once and probed twice (explain, then
// the dictionary view), so "explain-pop" leaves it open and "explain-dict"
// closes it. The answered-state footer actions are unhidden by hand: they
// appear once a reply lands, and the sweep measures geometry, not the flow.
const READER_SURFACES = ["explain-pop", "explain-dict", "ask-panel", "search-pop", "kbd-help-pop", "typo-pop", "pb-hl-card", "send-menu", "confirm-popover"];
async function openReaderSurface(name) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shown = (el) => !!(el && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getBoundingClientRect().width > 0);
  switch (name) {
    case "explain-pop": {
      const p = document.querySelector("#rendered-view p");
      if (!p || !p.firstChild || typeof pbpExplainInvoke !== "function") return false;
      const r = document.createRange(); r.setStart(p.firstChild, 4); r.setEnd(p.firstChild, 9);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      pbpExplainInvoke("explain"); await wait(700);
      const pop = document.getElementById("explain-pop");
      if (!shown(pop)) return false;
      pop.querySelectorAll(".xp-foot button").forEach((b) => { b.hidden = false; });
      return true;
    }
    case "explain-dict": {
      const pop = document.getElementById("explain-pop");
      const act = pop && pop.querySelector('.xp-act[data-action="dict"]');
      if (!act) return false;
      act.click(); await wait(700);
      return shown(pop) && shown(pop.querySelector(".xp-dict-head"));
    }
    case "ask-panel": {
      const btn = document.getElementById("ask-open");
      if (btn) btn.click(); else if (typeof _pbpExplainOpenAsk === "function") _pbpExplainOpenAsk("quick"); else return false;
      await wait(500);
      return shown(document.getElementById("ask-panel"));
    }
    case "search-pop": { if (typeof _pbpSearchOpen !== "function") return false; _pbpSearchOpen(); await wait(300); return shown(document.getElementById("search-pop")); }
    case "kbd-help-pop": { if (typeof _pbpKbdHelpOpen !== "function") return false; _pbpKbdHelpOpen(); await wait(300); return shown(document.getElementById("kbd-help-pop")); }
    case "typo-pop": { const b = document.getElementById("rail-typo-btn"); if (!b) return false; b.click(); await wait(300); return shown(document.getElementById("typo-pop")); }
    case "pb-hl-card": { if (typeof _pbpHlOpenCard !== "function") return false; _pbpHlOpenCard("h1"); await wait(500); return shown(document.getElementById("pb-hl-card")); }
    case "send-menu": {
      // the export section starts collapsed; a menu inside a collapsed section measures 0x0
      const sec = document.getElementById("export-section");
      if (sec && sec.classList.contains("rail-collapsed")) { sec.querySelector(".rail-sec-head")?.click(); await wait(400); }
      const c = document.getElementById("send-caret");
      if (!c) return "no #send-caret";
      if (c.hidden) return "caret hidden: no enabled Send-to target resolved from the seeded settings";
      c.click(); await wait(400);
      return shown(document.getElementById("send-menu")) || "menu not visible after the caret click";
    }
    case "confirm-popover": {
      if (typeof showConfirmPopover !== "function") return false;
      showConfirmPopover(document.getElementById("rail-zen-btn") || document.body.firstElementChild, { msg: "Delete this highlight?", yesText: "Delete", noText: "Cancel" });
      await wait(300);
      return shown(document.querySelector(".confirm-popover"));
    }
  }
  return false;
}
function closeReaderSurface(name) {
  const hide = (el) => { try { if (el && el.matches(":popover-open")) el.hidePopover(); } catch (_) {} };
  switch (name) {
    case "explain-pop": return; // stays open for explain-dict
    case "explain-dict": { const pop = document.getElementById("explain-pop"); if (pop && typeof _pbpExplainClose === "function") _pbpExplainClose(pop); return; }
    case "ask-panel": { const btn = document.getElementById("ask-open"); const panel = document.getElementById("ask-panel"); if (btn && panel && !panel.hidden) btn.click(); return; }
    case "send-menu": { const c = document.getElementById("send-caret"); const m = document.getElementById("send-menu"); if (c && m && !m.hidden) c.click(); return; }
    case "confirm-popover": { document.querySelector(".confirm-popover .confirm-no")?.click(); return; }
    default: hide(document.getElementById(name));
  }
}

async function runSweep(page, sw, extBase) {
  const hits = [];
  const add = (found, surface, context) => { for (const h of found) hits.push({ surface, context, ...h }); };

  // Deterministic baseline for the options/library legs below (no per-theme
  // loop there, unlike popup's explicit light/dark setTheme calls further
  // down) -- family 4 (hitAreaMin) is gated in the caller and needs a
  // reproducible theme label, not whatever preset a prior caller happened
  // to leave storage on.
  await setTheme(sw, "", "light");

  // ---- options: every tab panel (each is display:none until clicked, so a
  // border/chevron bug on a panel-scoped element only surfaces once its tab
  // is active -- exactly how the user found the preset-preview bug). ----
  await page.goto(`${extBase}options.html`, { waitUntil: "load", timeout: TIMEOUT_MS });
  await page.waitForTimeout(500);
  // Playwright's page.$$eval (DOM query + in-page callback), not JS eval() --
  // no string-to-code execution, same API runOneCheck already relies on via
  // page.evaluate elsewhere in this file.
  const tabIds = await page.$$eval(".tab-btn", (els) => els.map((e) => e.id));
  for (const tabId of tabIds) {
    await page.click(`#${tabId}`);
    await page.waitForTimeout(150);
    // Open every non-help disclosure (details.disclosure: vocab sections,
    // tag-gov low-count, Send-to cards) so their contents are measured too: the
    // AnkiConnect/Eudic rows that started the fgRhythm family live inside a
    // closed vocabulary disclosure. Contextual
    // help stays closed -- the default state is the one the rhythm rules
    // describe.
    await page.evaluate(() => { document.querySelectorAll(".panel.active details:not(.context-help)").forEach((d) => { d.open = true; }); });
    await page.waitForTimeout(100);
    if (tabId === "tab-appearance") {
      // #preset-preview-section is `style="display:none"` until a site-theme
      // preset is picked (options.js renderPresetPreview) -- click one so
      // this disclosure (and its chevron/padding) actually renders for the
      // sweep, same reasoning as the vocab detail-pane/batch-bar opens below.
      const presetBtn = page.locator(".theme-preset-btn[data-theme='flexoki']").first();
      if (await presetBtn.count()) { await presetBtn.click(); await page.waitForTimeout(150); }
    }
    add(await page.evaluate(sweepProbe, SWEEP_CFG), "options", tabId);
  }

  // ---- library: vocab (list, detail pane, batch bar) + notes (list, detail pane). ----
  await page.goto(`${extBase}library.html?_ra=sweep#vocab`, { waitUntil: "load", timeout: TIMEOUT_MS });
  await page.waitForSelector("#vocab-list .vocab-card", { timeout: TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(300);
  add(await page.evaluate(sweepProbe, SWEEP_CFG), "library", "vocab-list");
  const vocabHead = page.locator("#vocab-list .vocab-card .notes-card-head").first();
  if (await vocabHead.count()) {
    await vocabHead.click(); await page.waitForTimeout(250);
    add(await page.evaluate(sweepProbe, SWEEP_CFG), "library", "vocab-detail");
  }
  // Ctrl+click on the row head, not a checkbox click: the per-row checkbox was
  // removed 2026-08-06 and selection is now a modified click on the row itself.
  if (await vocabHead.count()) {
    await vocabHead.click({ modifiers: ["Control"] }); await page.waitForTimeout(350);
    add(await page.evaluate(sweepProbe, SWEEP_CFG), "library", "vocab-batch-bar");
  }
  await page.click("#lib-tab-notes");
  await page.waitForSelector("#notes-list .notes-hit", { timeout: TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(250);
  add(await page.evaluate(sweepProbe, SWEEP_CFG), "library", "notes-list");
  const notesHit = page.locator("#notes-list .notes-hit-btn").first();
  if (await notesHit.count()) {
    await notesHit.click(); await page.waitForTimeout(250);
    add(await page.evaluate(sweepProbe, SWEEP_CFG), "library", "notes-detail");
  }
  // Ctrl+click to open .notes-batch-bar.selecting (independent review F3):
  // the sweep used to only single-click a notes row, so .notes-batch-bar's
  // own buttons (including #notes-clear-selection, which shares vocab's
  // "cross" glyph and its 23px hit-area shortfall) were never rendered in
  // an on-screen, selected state and this debt was invisible to the gate.
  // Same modifier-click contract as the vocab list above.
  if (await notesHit.count()) {
    await notesHit.click({ modifiers: ["Control"] }); await page.waitForTimeout(350);
    add(await page.evaluate(sweepProbe, SWEEP_CFG), "library", "notes-batch-bar");
  }

  // ---- md-preview: the reader's chrome, static AND interaction-only. The
  // payload key is one-shot (md-preview consumes it on load), so it is seeded
  // right before each navigation; prose is excluded by cfg.excludeWithin so
  // the families measure chrome, not typography. AI-dependent chrome (the
  // ask / translate / skim sections, the explain popover's actions) renders
  // only when a provider and key exist -- seeded here; nothing is sent until
  // a control is clicked, and the sweep clicks none of those. Highlights live
  // under a hash of the URL that only the page can compute, so the record is
  // seeded after a first load and the page reloaded (the fixed-key record
  // seeded in main() feeds library.html, whose Notes view enumerates every
  // pbp_hl_* key; the reader never matched it). Before 2026-09-06 the
  // highlight section, its card and every popover were never rendered here:
  // a 17px delete button and 36px footer buttons lived there unmeasured. ----
  const readerUrl = "https://example.com/render-audit-fixture";
  const readerPayload = (k, url = readerUrl) => ({ [`md_preview_data_${k}`]: {
    markdown: "# Render audit fixture\n\nA paragraph with a [link](https://example.com/) and the quick brown fox.\n\n## Section\n\n- item one\n- item two\n\n`code` and **bold**.\n",
    contentHtml: "", title: "Render Audit Fixture", url, baseUrl: url,
    tags: ["qa"], tokens: 0, hasApiKey: true, source: "local", math: false, forum: false, ts: Date.now(),
  } });
  await sw.evaluate((o) => chrome.storage.local.set(o), {
    ...readerPayload("render-audit-sweep"),
    aiProvider: "openai", openaiApiKey: "sk-render-audit-fixture", previewSkimEnabled: true,
    // two Send-to targets: the split button's menu lists only the non-primary ones, so one target renders an empty menu
    exportTargets: { obsidian: { enabled: true, vault: "Render QA", folder: "" }, webhook: { enabled: true, url: "https://example.com/hook" } },
  });
  await page.goto(`${extBase}md-preview.html?k=render-audit-sweep`, { waitUntil: "load", timeout: TIMEOUT_MS });
  await page.waitForTimeout(900);
  const hlKey = await page.evaluate((u) => (typeof _pbpHlKey === "function" ? _pbpHlKey(u) : null), readerUrl);
  if (hlKey) {
    await sw.evaluate((o) => chrome.storage.local.set(o), { ...readerPayload("render-audit-sweep2"), [hlKey]: {
      url: readerUrl, title: "Render Audit Fixture Page",
      items: [{ id: "h1", ts: Date.now(), quote: "quick brown fox", note: "A short fixture note for the render audit.", color: 1 }],
    } });
    await page.goto(`${extBase}md-preview.html?k=render-audit-sweep2`, { waitUntil: "load", timeout: TIMEOUT_MS });
    await page.waitForTimeout(900);
  } else console.warn("[render-audit] reader: _pbpHlKey is not a function; the highlight section stays unseeded");
  add(await page.evaluate(sweepProbe, SWEEP_CFG), "md-preview", "reader");

  // Each interaction-only surface is opened through the page's own opener,
  // probed as its own context, then closed. A surface that fails to render
  // is printed, never skipped silently -- the gate's coverage is the point.
  for (const name of READER_SURFACES) {
    const ok = await page.evaluate(openReaderSurface, name).catch((e) => `threw: ${e.message}`);
    if (ok !== true) { console.warn(`[render-audit] reader surface NOT RENDERED: ${name} (${ok || "opener returned false"}) -- its controls were not measured`); continue; }
    await page.waitForTimeout(150);
    add(await page.evaluate(sweepProbe, SWEEP_CFG), "md-preview", name);
    await page.evaluate(closeReaderSurface, name).catch(() => {});
  }

  // ---- video workbench. A YouTube payload renders only the poster card: the
  // bar, the view toggle and the cue list appear after a user-gesture origin
  // grant plus live caption traffic, which no sweep can produce. md-video.js's
  // prepareVideoSession honours window.pbpVideoFixture (tracks / segments in
  // the module's own normalized shapes, the ones tests/md-video-tests.html
  // builds) and skips the grant and the fetch; the poster click then mounts
  // the real workbench offline. Before 2026-09-06 these controls were never
  // measured (their 28 -> 26px move had CSS arithmetic as its only evidence).
  const videoUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  await sw.evaluate((o) => chrome.storage.local.set(o), readerPayload("render-audit-video", videoUrl));
  await page.goto(`${extBase}md-preview.html?k=render-audit-video`, { waitUntil: "load", timeout: TIMEOUT_MS });
  await page.waitForTimeout(900);
  const videoOk = await page.evaluate(async (url) => {
    window.pbpVideoFixture = {
      tracks: [{ baseUrl: "https://x/en.xml", lang: "en", label: "English", asr: false }, { baseUrl: "https://x/zh.xml", lang: "zh-Hans", label: "Chinese (Simplified)", asr: false }],
      track: { baseUrl: "https://x/en.xml", lang: "en", label: "English", asr: false },
      segments: [{ from: 0, to: 2.4, content: "Render audit fixture, first cue." }, { from: 2.4, to: 5.1, content: "Second cue of the fixture transcript." }, { from: 5.1, to: 9, content: "Third cue, long enough to wrap inside the study column at a narrow width." }],
      meta: { title: "Render Audit Video", url, trackLabel: "English" },
    };
    const poster = document.querySelector(".pbv-poster");
    if (!poster) return "no .pbv-poster";
    poster.click();
    await new Promise((r) => setTimeout(r, 1500));
    const bar = document.querySelector(".pbv-bar"), rows = document.querySelectorAll(".pbv-row");
    if (!bar || !bar.checkVisibility()) return "no visible .pbv-bar after the poster click";
    if (!rows.length) return ".pbv-bar rendered but no .pbv-row cues";
    return true;
  }, videoUrl).catch((e) => `threw: ${e.message}`);
  if (videoOk !== true) console.warn(`[render-audit] reader surface NOT RENDERED: video workbench (${videoOk}) -- its controls were not measured`);
  else add(await page.evaluate(sweepProbe, SWEEP_CFG), "md-preview", "video");

  // ---- popup: default light + no-preset dark (since batch 2 D6 the latter
  // resolves to the flexoki-dark preset, same as options/library; kept as a
  // separate sweep context because the popup's dark layout deltas live in
  // its own hand-written rules). ----
  await setTheme(sw, "", "light");
  await page.goto(`${extBase}popup.html?_ra=sweeplight`, { waitUntil: "load", timeout: TIMEOUT_MS });
  await page.waitForTimeout(500);
  await page.evaluate(async () => { if (window.PPOffline) await window.PPOffline.refresh(); }).catch(() => {});
  await page.waitForSelector("#offline-queue-bar:not(.hidden)", { timeout: TIMEOUT_MS }).catch(() => {});
  add(await page.evaluate(sweepProbe, SWEEP_CFG), "popup", "light");
  // Hidden-by-default states -- feedback card (with its fallback action),
  // URL warning and clean hint, presets and suggest rows, batch permission
  // card and progress bar, markdown strip, expanded offline queue -- shown
  // by class rather than by driving the flows that show them: the families
  // gate geometry, and these blocks carry their own button recipes (.fc-btn,
  // .md-strip-btn, .offline-queue-item > .actions button) that the default
  // popup never renders.
  await page.evaluate((ids) => {
    for (const id of ids) {
      document.getElementById(id)?.classList.remove("hidden");
    }
    const fb = document.getElementById("ai-error-fallback");
    if (fb && !fb.textContent.trim()) fb.textContent = "Use fallback";
  }, POPUP_HIDDEN_LEG_IDS);
  // ...except the queue ROWS, which no class toggle can conjure: popup-offline.js
  // builds .offline-queue-item (and its two icon-only action buttons) only inside
  // renderList(), which runs on the toggle's click -- `expanded` starts false. The
  // unhide above therefore measured an EMPTY list for as long as this leg existed,
  // while its own comment claimed .offline-queue-item > .actions button as covered
  // (they shipped 17px tall against the 24px floor, 2026-09-18 audit M4). Driving
  // the toggle is the only way to render them, so this one block is driven, not
  // unhidden.
  await page.evaluate(() => document.getElementById("offline-queue-toggle")?.click());
  // Wait for either outcome of renderList(): rows, or the empty placeholder.
  // A bare .offline-queue-item wait would burn the full timeout and then
  // measure an empty list in silence if the seeded queue record ever went
  // missing -- exactly the blind spot this leg exists to close.
  await page.waitForSelector(".offline-queue-item, .offline-queue-empty", { timeout: TIMEOUT_MS }).catch(() => {});
  if (!(await page.$(".offline-queue-item"))) {
    console.warn("[render-audit] popup states: no .offline-queue-item rendered -- the offline queue seed is missing, .offline-queue-item > .actions button is NOT being measured");
  }
  await page.waitForTimeout(150);
  add(await page.evaluate(sweepProbe, SWEEP_CFG), "popup", "states");

  await setTheme(sw, "", "dark");
  await page.goto(`${extBase}popup.html?_ra=sweepdark`, { waitUntil: "load", timeout: TIMEOUT_MS });
  await page.waitForTimeout(500);
  await page.evaluate(async () => { if (window.PPOffline) await window.PPOffline.refresh(); }).catch(() => {});
  await page.waitForSelector("#offline-queue-bar:not(.hidden)", { timeout: TIMEOUT_MS }).catch(() => {});
  add(await page.evaluate(sweepProbe, SWEEP_CFG), "popup", "dark");

  // ---- popup, LOGGED OUT (popup button-family campaign, 2026-08-07). The
  // two passes above seed a token, so popup.js's `if (!settings.pinboardToken)
  // showLogin(); else showMain(...)` always took the showMain branch and
  // #login-section stayed `.hidden` for the whole audit's life -- every
  // control in .login-body was NEVER MEASURED, which is a different thing
  // from "measured and passing" (its .key-toggle renders 22px, under the
  // 24px floor, and nothing caught it). Clearing the token is the whole
  // setup; restore it immediately afterwards so this stays the last popup
  // leg regardless of who calls runSweep.
  await sw.evaluate(() => chrome.storage.local.set({ pinboardToken: "" }));
  await setTheme(sw, "", "light");
  await page.goto(`${extBase}popup.html?_ra=sweeplogin`, { waitUntil: "load", timeout: TIMEOUT_MS });
  await page.waitForSelector("#login-section:not(.hidden)", { timeout: TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(300);
  add(await page.evaluate(sweepProbe, SWEEP_CFG), "popup", "login");
  await sw.evaluate((tok) => chrome.storage.local.set({ pinboardToken: tok }), SEED_TOKEN_OBF);

  return hits;
}

function reportSweep(hits) {
  const dedup = new Map();
  for (const h of hits) {
    const key = h.kind === "rowHeightEq" ? `${h.surface}|rowHeightEq|${[h.a, h.b].sort().join("~")}`
      : `${h.surface}|${h.kind}|${h.path}${h.childKind ? "|" + h.childKind : ""}${h.rel ? "|" + h.rel : ""}${h.detail ? "|" + h.detail : ""}`;
    if (!dedup.has(key)) dedup.set(key, h);
  }
  const unique = [...dedup.values()];
  console.log(`[render-audit --sweep] ${hits.length} raw hit(s) across all contexts, ${unique.length} unique (deduped by surface+kind+element)`);
  for (const h of unique) {
    if (h.kind === "textInset") console.log(`  textInset          [${h.surface}/${h.context}]  ${h.path}  minH=${h.minH}px minV=${h.minV}px  rung=${h.rung}`);
    else if (h.kind === "childContainment") console.log(`  childContainment   [${h.surface}/${h.context}]  host=${h.path}  child=${h.childKind}  overflow=${JSON.stringify(h.overflow)}`);
    else if (h.kind === "rowHeightEq") console.log(`  rowHeightEq        [${h.surface}/${h.context}]  container=${h.containerPath}  ${h.a} vs ${h.b}  diff=${h.diff}px`);
    else if (h.kind === "hitAreaMin") console.log(`  hitAreaMin         [${h.surface}/${h.context}]  ${h.path}  shortSide=${h.shortSide}px`);
    else if (h.kind === "fgRhythm") console.log(`  fgRhythm           [${h.surface}/${h.context}]  ${h.path}  ${h.rel} gap=${h.gap}px`);
    else if (h.kind === "controlRung") console.log(`  controlRung        [${h.surface}/${h.context}]  ${h.path}  height=${h.height}px`);
    else if (h.kind === "headerFace") console.log(`  headerFace         [${h.surface}/${h.context}]  ${h.path}  face=${h.face}  majority=${h.majority}`);
    else if (h.kind === "actionRowGap") console.log(`  actionRowGap       [${h.surface}/${h.context}]  ${h.path}  gap=${h.gap}px  allowed=${h.allowed.join("|")}`);
    else if (h.kind === "radiusScale") console.log(`  radiusScale        [${h.surface}/${h.context}]  ${h.path}  radius=${h.radius}  tokens=${h.tokens.join("|")}`);
    else if (h.kind === "textFloor") console.log(`  textFloor          [${h.surface}/${h.context}]  ${h.path}  font-size=${h.fontSize}px`);
    else if (h.kind === "spacingScale") console.log(`  spacingScale       [${h.surface}/${h.context}]  ${h.path}  ${h.prop}=${h.value}px  scale=${h.scale.join("|")}`);
    else if (h.kind === "clusterGap") console.log(`  clusterGap         [${h.surface}/${h.context}]  ${h.path}  gap=${h.gap}px  expected=${h.expected}px`);
  }
  console.log(unique.length ? "[render-audit --sweep] === hits found -- fix, then lock in as CHECKS entries ===" : "[render-audit --sweep] === clean ===");
  process.exit(0);
}

function keyOf(r) { return `${r.surface}|${r.theme}|${r.selector}|${r.state}|${r.check}`; }

function report(results) {
  const fails = results.filter((r) => r.status === "FAIL");
  const okCount = results.filter((r) => r.status === "OK").length;
  const skipCount = results.filter((r) => r.status === "SKIP").length;

  if (UPDATE) {
    const knownFailures = {};
    for (const r of fails) {
      knownFailures[keyOf(r)] = {
        surface: r.surface, theme: r.theme, selector: r.selector, state: r.state, check: r.check,
        actual: r.actual, expected: r.expected, note: r.note,
      };
    }
    writeFileSync(KNOWN_FAILURES_PATH, JSON.stringify(knownFailures, null, 2) + "\n");
    console.log(`[render-audit] ${okCount} OK, ${skipCount} SKIP, ${fails.length} FAIL`);
    if (skipCount) console.log(`[render-audit] SKIP = disabled controls exempted from contrast checks (WCAG 1.4.3), not a failure`);
    console.log(`[render-audit] wrote ${fails.length} known-failure(s) to ${KNOWN_FAILURES_PATH}`);
    for (const r of fails) console.log(`  FAIL  ${keyOf(r)}  actual=${r.actual}  expected=${r.expected}${r.note ? "  (" + r.note + ")" : ""}`);
    process.exit(0);
  }

  let known = {};
  if (existsSync(KNOWN_FAILURES_PATH)) {
    try { known = JSON.parse(readFileSync(KNOWN_FAILURES_PATH, "utf8")); } catch (e) {
      console.error(`[render-audit] failed to parse ${KNOWN_FAILURES_PATH}: ${e.message}`);
      process.exit(2);
    }
  }

  const violations = [];
  const warnings = [];
  for (const r of fails) {
    if (Object.prototype.hasOwnProperty.call(known, keyOf(r))) warnings.push(r);
    else violations.push(r);
  }
  const seenKeys = new Set(fails.map(keyOf));
  // A shard ran a SLICE of THEMES, so its seenKeys cannot answer "which
  // known-failure keys no longer reproduce" -- every key belonging to another
  // shard's theme would be reported STALE. That reconciliation is advisory
  // (a console.log, never an exit code), so a shard declines to guess rather
  // than the whole gate growing a cross-process seenKeys merge protocol; a
  // full run (no --shard: verify.sh's single-shard path and every manual
  // invocation) still does it exactly as before.
  const stale = SHARD ? [] : Object.keys(known).filter((k) => !seenKeys.has(k));

  console.log(`[render-audit] ${okCount} OK, ${skipCount} SKIP, ${warnings.length} WARN (known), ${violations.length} FAIL (new)${SHARD_TAG}`);
  if (skipCount) console.log(`[render-audit] SKIP = disabled controls exempted from contrast checks (WCAG 1.4.3), not a failure`);
  if (SHARD && Object.keys(known).length) {
    console.log(`[render-audit] stale known-failure reconciliation skipped${SHARD_TAG} -- rerun without --shard to find ledger entries that no longer reproduce`);
  }
  if (warnings.length) {
    console.log(`[render-audit] known failures still outstanding (see ${KNOWN_FAILURES_PATH}):`);
    for (const r of warnings) console.log(`  WARN  ${keyOf(r)}  actual=${r.actual}  expected=${r.expected}`);
  }
  if (stale.length) {
    console.log(`[render-audit] ${stale.length} known-failure key(s) no longer reproduce -- consider deleting from ${KNOWN_FAILURES_PATH}:`);
    for (const k of stale) console.log(`  STALE  ${k}`);
  }
  if (violations.length) {
    console.log(`[render-audit] === FAIL -- ${violations.length} new violation(s) not covered by known-failures ===`);
    for (const r of violations) console.log(`  FAIL  ${keyOf(r)}  actual=${r.actual}  expected=${r.expected}${r.note ? "  (" + r.note + ")" : ""}`);
    process.exit(1);
  }
  console.log("[render-audit] === PASS ===");
  process.exit(0);
}

// K107: scripts/ci-fonts.conf exists so a developer can make their machine's
// font resolution match CI's (CJK on WenQuanYi, no Windows/macOS fonts), but
// nothing in the codebase ever asserted the file actually loaded -- and the
// conf's own header names two silent failure modes: a relative
// FONTCONFIG_FILE is looked up under /etc/fonts, fails, and falls back to the
// default config; an XML comment containing "--" fails to parse and is
// dropped just as quietly. Both leave fc-match resolving "Microsoft YaHei" to
// msyh.ttc instead of DejaVu Sans -- which is exactly the sanity check the
// conf's comment header prescribes as a manual step. This makes it the
// script's job, not a human's. Only runs when a developer has opted in by
// setting FONTCONFIG_FILE; CI never sets it, so this is a no-op there and the
// gate's rendering path is byte-for-byte unchanged.
function checkFontconfigParity() {
  const confPath = process.env.FONTCONFIG_FILE;
  if (!confPath) return;
  if (!isAbsolute(confPath)) {
    console.error(
      `[render-audit] FONTCONFIG_FILE="${confPath}" is not an absolute path. ` +
      `fontconfig looks up a relative name under /etc/fonts, fails to find it there, ` +
      `and silently falls back to the default config (see the header comment in ${confPath}). ` +
      `Use an absolute path, e.g. FONTCONFIG_FILE="$PWD/scripts/ci-fonts.conf".`
    );
    process.exit(2);
  }
  let resolved;
  try {
    resolved = execFileSync("fc-match", ["Microsoft YaHei"], { encoding: "utf8" }).trim();
  } catch (e) {
    console.warn(`[render-audit] fc-match unavailable (${e.code || e.message}) -- skipping the FONTCONFIG_FILE=${confPath} parity check (fontconfig is Linux-only).`);
    return;
  }
  if (!resolved.includes("DejaVu")) {
    console.error(
      `[render-audit] FONTCONFIG_FILE=${confPath} did not take effect: fc-match "Microsoft YaHei" ` +
      `resolved to "${resolved}", expected a DejaVu Sans match. This is one of the two silent failure ` +
      `modes ${confPath} documents (relative path already ruled out above; check the file for an ` +
      `XML comment containing "--", which fontconfig fails to parse and drops silently). ` +
      `Reproduce: FONTCONFIG_FILE="${confPath}" fc-match "Microsoft YaHei"`
    );
    process.exit(2);
  }
}

async function main() {
  checkFontconfigParity();
  if (SHARD) {
    console.log(`[render-audit] shard ${SHARD.i}/${SHARD.n}: ${SHARD_THEMES.length}/${THEMES.length} theme(s) [${SHARD_THEMES.map((t) => t || "(default)").join(", ")}]${RUNS_SWEEP ? " + the single sweep pass (families 4-11 and the spacingScale ledger)" : ""}`);
  }
  const userDataDir = mkdtempSync(join(tmpdir(), "pbp-render-audit-"));
  let ctx;
  try {
    // Unpacked source tree, not a ZIP (this audits the working tree, not a
    // release build) -- same recipe as scripts/zip-install-smoke.mjs:187-195.
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // MV3 extensions require headed (or 'new' headless on recent Chrome)
      args: [
        `--disable-extensions-except=${ROOT}`,
        `--load-extension=${ROOT}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-default-apps",
      ],
    });
  } catch (e) {
    console.error(`[render-audit] Chromium launch failed: ${e.message}`);
    console.error("  If running headless on a server, try installing X virtual framebuffer:");
    console.error("    sudo apt install xvfb && xvfb-run -a node scripts/ui-render-audit.mjs");
    rmSync(userDataDir, { recursive: true, force: true });
    process.exit(2);
  }

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: TIMEOUT_MS }).catch(() => null);
  if (!sw) {
    console.error("[render-audit] no service worker registered within 15s");
    await ctx.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
    process.exit(2);
  }
  const extId = new URL(sw.url()).hostname;
  const extBase = `chrome-extension://${extId}/`;

  // ---- Seed fixture data. All three writes go through the SW, which
  // already importScripts()'s vocab-store.js (background.js) -- same origin,
  // same IndexedDB as any extension page. Calling its own public functions
  // (pbpVocabSaveWord / pbpVocabBatchAddGroup) instead of touching the
  // "words" object store directly keeps the single-writer invariant intact
  // (CLAUDE.md: "vocab-store.js 是 pbp-vocab 的唯一写入口"). ----
  await sw.evaluate((tok) => chrome.storage.local.set({ pinboardToken: tok }), SEED_TOKEN_OBF);

  const seeded = await sw.evaluate(async (owner) => {
    const w = await pbpVocabSaveWord(owner, {
      term: "renderAuditFixture",
      language: "en",
      gloss: "Fixture word seeded by scripts/ui-render-audit.mjs so the vocabulary detail pane has something to render.",
      // `context` (singular): pbpVocabSaveWord merges ONE per call, and a
      // `contexts` array is silently dropped. Load-bearing for the paneFit
      // entries -- the source link (a.notes-row-open) only exists when a word
      // has a context with a safe URL, and an unbreakable title is what makes
      // "does anything escape the pane" a question with a real answer instead
      // of a vacuous pass. (First version of this seed used the plural form
      // and the entries passed against a detail pane that had no link in it.)
      context: {
        quote: "A context sentence long enough to wrap inside the reading column and still leave the source link on a line of its own.",
        articleTitle: "An Extremely Long Source Article Title That Has No Business Fitting Inside A Narrow Detail Pane At All",
        articleUrl: "https://example.com/an/extremely/long/path/segment/that/does/not/break/anywhere",
      },
    });
    if (!w || !w.id) return false;
    await pbpVocabBatchAddGroup([w.id], owner, "Render QA");
    return true;
  }, SEED_OWNER);
  if (!seeded) {
    console.error("[render-audit] vocab seed failed (pbpVocabSaveWord returned no id)");
    await ctx.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
    process.exit(2);
  }

  // Tag governance reads a LOCAL cache (options.js's renderTagGov ->
  // chrome.storage.local.cached_user_tags), never a live tags/get fetch on
  // render -- so a plural pair here reaches .tag-gov-chip-face with no
  // network mocking needed. book/books is tag-gov.js's own simplest
  // heuristic case (_pluralizeCandidates: base + "s", base.length >= 3).
  // misc/wip (count <= 1) seed #tag-gov-lowcount-list's checkbox chips --
  // pbpTagGovLowCountTags's own threshold -- so its disclosure has something
  // to open (Ruling 8: neither count in the plural pair qualifies, so before
  // this the list always rendered its empty state and the checkbox-chip
  // family never appeared in a DOM render-audit or --sweep scans). Both stay
  // clear of every OTHER heuristic: too short for the typo pass's length>=5
  // gate, and their normalized forms don't collide with book/books or each
  // other, so they can't accidentally form a second plural/separator/typo
  // group and change what the plain-groups checks below expect.
  await sw.evaluate((account) => chrome.storage.local.set({
    cached_user_tags: { account, counts: { book: 5, books: 3, misc: 1, wip: 0 }, timestamp: Date.now() },
  }), SEED_TOKEN_ACCOUNT);

  // Highlight record for library.html's Notes view, which enumerates every
  // pbp_hl_* key -- so this fixed key is fine for it, and the notes list,
  // detail pane and batch bar legs depend on it (removing it broke their
  // SETUP, 2026-09-06). The READER looks a record up by pbpAiHash(url), a key
  // only the page can compute, so the sweep's reader leg seeds a second
  // record under that computed key before it opens the highlight section.
  await sw.evaluate(() => chrome.storage.local.set({
    "pbp_hl_render-audit-fixture": {
      url: "https://example.com/render-audit-fixture",
      title: "Render Audit Fixture Page",
      items: [{
        id: "h1",
        ts: Date.now(),
        quote: "This is the highlighted passage used by the render audit fixture.",
        note: "A short fixture note for the render audit.",
        color: 1,
      }],
    },
  }));

  // One offline-queue record so popup's #offline-queue-bar (and its
  // #offline-queue-clear icon-only button) has something to render --
  // CLAUDE.md's offlineQueue shape: save mode, url/title/tags/note,
  // private/toread/archive flags, bookmark time, queue id/time, and the
  // non-secret Pinboard username it's bound to (no token).
  await sw.evaluate((owner) => chrome.storage.local.set({
    offlineQueue: [{
      queueId: "render-audit-1", queuedAt: Date.now(),
      url: "https://example.com/render-audit-fixture", title: "Render Audit Offline Fixture",
      account: owner, mode: "save", tags: "", note: "", private: false, toread: false, archive: false,
    }],
  }), SEED_TOKEN_ACCOUNT);

  const page = await ctx.newPage();

  // popup's suggest-row (D6/D7, taste-uplift batch3 Task 5): fetchPinboardSuggestTags
  // (popup-tags.js) fetches this endpoint DIRECTLY from the popup page (not
  // proxied through the SW like the AI calls qa-drive.mjs mocks), and its
  // chrome.storage.local cache key is keyed on the popup's own "current tab"
  // URL -- which, navigated directly to popup.html?_ra=<theme> the way this
  // harness does, changes every theme iteration, so there is no stable
  // storage key to pre-seed the way cached_user_tags is seeded below. Routing
  // the request itself sidesteps that entirely and survives every
  // page.goto() on this page for the rest of the run (both the checklist
  // loop and --sweep, which also opens popup.html). Same fixture shape as
  // qa-drive.mjs's PINBOARD_API entry for "/v1/posts/suggest" (qa-drive.mjs:178).
  //
  // MUST be ctx.route(), not page.route() -- verified live (scratch diagnostic,
  // not committed): an extension page's fetch() to a cross-origin host is
  // NOT caught by page-level interception at all (0 hits, the request fell
  // through to the real network and got a real 401 from the real Pinboard
  // API using this fixture's fake token), while context-level interception
  // catches it every time. Same shape as qa-drive.mjs's own comment on this
  // exact surface ("the popup's Pinboard requests go through the SW proxy;
  // in this environment, context.route has been observed to intercept SW
  // requests too" -- an observed behaviour, not a documented Playwright
  // guarantee, for extension-page/SW requests alike).
  await ctx.route(/\/v1\/posts\/suggest/, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([{ popular: ["reading", "systems"] }, { recommended: ["qa", "设计", "longform"] }]),
  }));

  if (SWEEP || WRITE_SPACING) {
    let hits = [];
    try {
      hits = await runSweep(page, sw, extBase);
    } finally {
      await page.close().catch(() => {});
      await ctx.close().catch(() => {});
      rmSync(userDataDir, { recursive: true, force: true });
    }
    if (WRITE_SPACING) writeSpacingBaseline(hits);
    if (SWEEP) reportSweep(hits);
    return;
  }

  const results = [];
  const mediaSession = await ctx.newCDPSession(page);
  let mediaProbeCount = 0;
  try {
    for (const surface of Object.keys(SURFACE_PAGES)) {
      const checks = CHECKS.filter((c) => c.surface === surface);
      if (!checks.length) continue;
      for (const theme of SHARD_THEMES) {
        // No bare-dark state on any surface: no-preset+dark resolves to
        // data-theme="flexoki-dark" on popup, options and library alike (batch
        // 2 D6), so the "flexoki-dark" THEMES entry covers it everywhere.
        const { themePresetKey, optTheme } = themeToStorage(theme);
        await setTheme(sw, themePresetKey, optTheme);
        if (surface === "library") await runLibraryTheme(page, extBase, theme, checks, results);
        else await runSimpleTheme(page, `${extBase}${SURFACE_PAGES[surface]}`, theme, checks, results, surface, sw);
        if (MEDIA_THEME_SET.has(theme)) {
          mediaProbeCount += await runMediaPreferenceChecks(page, mediaSession, surface, theme, results);
        }
      }
    }

    // ---- hitAreaMin class-scan (design-uplift final-fix I2). Reuses the
    // same whole-page sweep the --sweep discovery mode runs (options tabs +
    // preset-preview open, library vocab-list/detail/batch-bar + notes-
    // list/detail, popup light+dark) but, unlike that mode's other 3
    // families, folds every hit into `results` as a normal FAIL so it goes
    // through the same known-failures reconciliation as the hand-enumerated
    // checks above -- see sweepProbe's family-4 comment for why one pass
    // (not one per THEMES entry) is sufficient coverage.
    //
    // That single pass is exactly why sharding hands it to shard 0 alone
    // (RUNS_SWEEP): families 4-11 are theme-invariant geometry, so running
    // them once is full coverage, while running them in every shard would
    // pay the sweep N times and report each hit N times. The other shards
    // get an empty hit list, so all six family loops below are no-ops there.
    const sweepHits = RUNS_SWEEP ? await runSweep(page, sw, extBase) : [];
    const hitAreaHits = sweepHits.filter((h) => h.kind === "hitAreaMin");
    for (const h of hitAreaHits) {
      results.push({
        surface: h.surface,
        theme: h.surface === "popup" && h.context === "dark" ? "flexoki-dark" : "", // popup's dark sweep context renders the flexoki-dark fallback (batch 2 D6)
        selector: h.path,
        state: h.context,
        check: "hitAreaMin",
        status: "FAIL",
        actual: h.shortSide,
        expected: 24,
        note: null,
      });
    }
    // ---- fgRhythm class-scan (family 5): same gating shape as hitAreaMin.
    for (const h of sweepHits.filter((x) => x.kind === "fgRhythm")) {
      results.push({
        surface: h.surface,
        theme: "",
        selector: h.path,
        state: `${h.context}|${h.rel}`,
        check: "fgRhythm",
        status: "FAIL",
        actual: h.gap,
        expected: h.rel === "label-control" ? "3..6" : ">=4",
        note: h.rel === "label-control" ? "label.bl -> control gap (px)" : "gap above an action row (px)",
      });
    }
    // ---- families 6-9 (design-language class scans): same gating shape.
    const FAMILY = {
      controlRung: (h) => ({ actual: h.height, expected: "26±1 | 20±1", note: "control height (COMPONENTS.md §1.1/§6.3); icon-only buttons are family 4" }),
      headerFace: (h) => ({ actual: h.face, expected: h.majority, note: "section heading face differs from the surface majority" }),
      actionRowGap: (h) => ({ actual: h.gap, expected: h.allowed.join("|"), note: "column-gap of a button row (px)" }),
      radiusScale: (h) => ({ actual: h.radius, expected: h.tokens.map((t) => t + "px").join("|"), note: "border-radius off the surface's token scale" }),
      textFloor: (h) => ({ actual: h.fontSize, expected: ">=11", note: "visible text below the 11px floor" }),
      clusterGap: (h) => ({ actual: h.gap, expected: String(h.expected), note: "column-gap of an icon-button cluster (px): one rung on every surface" }),
    };
    for (const h of sweepHits) {
      const f = FAMILY[h.kind];
      if (!f) continue;
      const { actual, expected, note } = f(h);
      results.push({ surface: h.surface, theme: "", selector: h.path, state: h.context, check: h.kind, status: "FAIL", actual, expected, note });
    }
    // ---- family 11 spacingScale: ratchet against its own ledger; only hits
    // the ledger does not hold become FAIL rows (then known-failures applies
    // as for every other check). Guarded (not just fed an empty array) so a
    // shard that did not sweep never reconciles the ledger against nothing
    // and calls every entry in it stale.
    if (RUNS_SWEEP) {
      for (const h of reconcileSpacing(sweepHits)) {
        results.push({
          surface: h.surface, theme: "", selector: h.path, state: h.prop, check: "spacingScale", status: "FAIL",
          actual: `${h.value}px`, expected: h.scale.map((t) => t + "px").join("|"),
          note: "margin/padding/gap off the surface's live --*-sp-N scale; move the rule onto a token or (deliberately) add it to tests/render-audit-spacing-baseline.json",
        });
      }
    }
  } finally {
    await mediaSession.detach().catch(() => {});
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
  }

  // Denominator is what THIS process ran: MEDIA_THEMES for a full run (all
  // four are THEMES entries), a shard's slice of them under --shard.
  const mediaThemes = SHARD_THEMES.filter((t) => MEDIA_THEME_SET.has(t)).length;
  console.log(`[render-audit] media preferences: ${mediaProbeCount} probes across ${mediaThemes} themes x ${MEDIA_CHECKS.length} surfaces x ${MEDIA_SCENARIOS.length} scenarios${SHARD_TAG}`);
  // weakTextOnFill (family 13): per-surface scanned counts so a future "0
  // FAIL" can be told apart from "scanned nothing" (task spec) -- this
  // process's own slice only, same denominator discipline as mediaThemes
  // above.
  if (weakTextScanLog.length) {
    const bySurface = {};
    for (const entry of weakTextScanLog) bySurface[entry.surface] = (bySurface[entry.surface] || 0) + entry.scanned;
    const total = weakTextScanLog.reduce((sum, entry) => sum + entry.scanned, 0);
    console.log(`[render-audit] weakTextOnFill: ${total} element probe(s) this run${SHARD_TAG} (` +
      Object.entries(bySurface).map(([surface, count]) => `${surface}=${count}`).join(", ") + ")");
    // T5 fix wave (F5a): per-(surface,context) breakdown, summed across every
    // theme this process ran -- distinguishes "this specific panel/leg was
    // opened and scanned on every theme" from "0 FAIL" at a coarser grain
    // than the per-surface line above, which could hide a panel/leg that was
    // silently never reached (a shape the F5 review finding named
    // explicitly: 12 of 13 options panels used to never appear here at all).
    const byContext = {};
    for (const entry of weakTextScanLog) {
      const key = `${entry.surface}/${entry.context}`;
      byContext[key] = byContext[key] || { scanned: 0, themes: 0 };
      byContext[key].scanned += entry.scanned;
      byContext[key].themes += 1;
    }
    console.log(`[render-audit] weakTextOnFill per (surface, panel/leg) -- scanned total across ${SHARD_THEMES.length} theme(s) this process ran, and the (surface, theme) count that reached it:`);
    for (const [key, v] of Object.entries(byContext).sort()) {
      console.log(`  ${key}: scanned=${v.scanned} themes=${v.themes}`);
    }
  } else {
    console.log(`[render-audit] weakTextOnFill: 0 element probes this run${SHARD_TAG} -- no (surface, theme) pair reached recordWeakTextHits`);
  }
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(results, null, 2) + "\n");
    console.log(`[render-audit] wrote ${results.length} result row(s) to ${JSON_OUT}`);
  }
  report(results);
}

main().catch((e) => {
  console.error(`[render-audit] fatal: ${e.stack || e.message}`);
  process.exit(2);
});
