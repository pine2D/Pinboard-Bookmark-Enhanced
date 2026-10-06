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
//   0 → pass (all failures already in known-failures and no SETUP row), or
//       --update-known-failures rewrote the ledger
//   1 → at least one NEW violation not covered by known-failures (wins over 2
//       when a run has both)
//   2 → tooling/env error (no playwright, no display, seed failed, bad JSON,
//       etc.), OR at least one per-row harness precondition failed: a SETUP
//       row (the real pointer's hover or rest state did not hold through the
//       read in any of holdPointerState's bounded attempts, each spoiled by
//       one of: :hover never reaching the element or never leaving it, a
//       pointer event the harness did not dispatch, or focus surviving the
//       blur; the row's kind and note say which, over all attempts), listed
//       under "=== SETUP" -- that row was not measured,
//       so it is neither a pass nor a product verdict. With any SETUP row,
//       --update-known-failures refuses to write and exits 2.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { isolatedFontconfigEnv, parityProbeEnv, parityReproduceCommand } from "./ci-fonts-env.mjs";

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
// Options density per theme, from the pilots (docs/theme-surface/tools/options-density.mjs).
import { readOptionsDensity } from "../docs/theme-surface/tools/options-density.mjs";
// Family 14's fill-separation floor (spec 2026-09-30-ui-fields-stage4-design
// §2.3 F1-F3) is the derivation's own constant, imported, never a hand-typed
// 1.10; its frame step measures perceptual distance with the same CIEDE2000
// the derivation uses. The popup / library value-box legs (stage 4 Task 6)
// read each surface's field hosts from the deriver too, never retyped here.
import { FILL_SEPARATE_MIN, deltaE2000, FIELD_HOST_ROLES } from "../docs/theme-surface/composers/_ui-derive.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OPTIONS_DENSITY = readOptionsDensity(ROOT);
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
// ---- Relocated rows (library redesign T8f, controller rulings on cost).
// The hangOrder rows are the most expensive rows of any theme (default also
// runs their window driver and settled coarse pass, fullThemes), and under
// round-robin they land on the default theme's shard 0 -- which also runs
// the single sweep pass -- and the terminal theme's shard 2: the two slowest
// shards, so the verify wall clock. Each relocated row names the shard it
// runs in, per shard count, from measured 4-shard timings (T8f fix rounds
// 3-4: with neither moved, shards 0-3 took 883 / 528 / 803 / 403 s; the
// default rows go to shard 3, the lightest, and the terminal rows to shard
// 1, the lightest once those moved). Fallback for a shard count with no
// entry: the last shard, n - 1 -- round-robin gives it the fewest themes
// (15 over n) and it never runs the sweep. Every row runs exactly once
// whatever n is: its theme's own shard skips it unless it is the target,
// the target shard runs it after its own themes, and a run without --shard
// (verify.sh's n = 1 path, any manual run) runs it in place as always. So
// verify.sh's min(4, cores) default and a PBP_RENDER_SHARDS override alike.
const RELOCATED_ROWS = Object.freeze([
  { surface: "library", state: "hangOrder", theme: "", targetByShards: { 4: 3 } },
  { surface: "library", state: "hangOrder", theme: "terminal", targetByShards: { 4: 1 } },
]);
const relocatedTarget = (row) => {
  if (!SHARD) return null;
  const t = row.targetByShards[SHARD.n] ?? SHARD.n - 1;
  return t >= 0 && t < SHARD.n ? t : SHARD.n - 1;
};
const relocatedRow = (check, theme) => RELOCATED_ROWS.find((r) => r.surface === check.surface && r.state === check.state && r.theme === theme) || null;

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

// ---- Library redesign fixture (spec 2026-10-03 §9.2, plan T2). The gates the
// redesign adds (G1-G7) need a library that looks like a real one: a list long
// enough to scroll, words with and without groups, CJK heads, a word with two
// contexts and a note, one page with several highlights and one with exactly
// one. renderAuditFixture / pbp_hl_render-audit-fixture stay the NEWEST word
// and highlight (seeded last / stamped latest), so every pre-existing entry
// that reads the first row of a list still reads the same element.
const LIB_SEED = Object.freeze({
  richTerm: "constraint",            // two contexts + a note, language "en", ipa "/kənˈstreɪnt/"
  cjkTerms: ["曖昧", "呼吸"],          // language "ja" / "zh"
  cjkLangs: ["ja", "zh"],            // cjkTerms' languages, pinned by the seed-shape check (G4 reads :lang)
  latinTerm: "constraint",           // G4 Latin head
  // G4 by glyph class (final review #10): a capital whose diacritic rises
  // above the em box, the case the pull-up's "never clip" promise names
  // (spec §6.5 #3). A de word in the vocabulary, an É-titled page in notes.
  diacriticTerm: "Übung",            // language "de", no group
  diacriticUrl: "https://example.com/reading/elan-vital",
  diacriticTitle: "Élan vital and the drift of attention",
  wordCount: 31,                     // >= 30 saved words, >= 10 without any group
  multiUrl: "https://example.com/reading/attention",   // >= 3 highlights, one carries a note
  multiTitle: "Attention is a scarce resource",
  soloUrl: "https://example.com/quiet-ui",             // exactly 1 highlight
  cjkTitle: "安静的界面",                               // soloUrl's page title (CJK G4 case)
});
// 27 plain Latin words; with richTerm, the two CJK terms and diacriticTerm
// that is LIB_SEED.wordCount. The first 17 join "Reading" (so a one-group filter still
// leaves a list that scrolls at 700px), the last 10 join no group.
const LIB_SEED_FILLER_TERMS = Object.freeze([
  "ambient", "brevity", "cadence", "candor", "clarity", "coherent", "diligent", "elision", "ephemeral",
  "fidelity", "friction", "gradient", "heuristic", "inertia", "lucid", "margin", "nuance",
  "opaque", "parsimony", "quiescent", "rhetoric", "salient", "tacit", "tenuous", "unwieldy", "verbose", "whimsy",
]);
// One-highlight filler pages. With the fixture, multiUrl's four and soloUrl's
// one this makes 22 highlights: enough for the notes list region to scroll at
// a 900px window in BOTH density tiers, which G1 and G6 need to be able to
// tell "the page did not scroll" from "there was nothing to scroll". (8 pages,
// 14 highlights, scrolled in the comfortable tier only: terminal's compact
// rows left the 2560x900 list region at 764/764, measured by G1, plan T3a.)
const LIB_SEED_NOTE_FILLER_PAGES = 16;

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
function probeSelector({ selector, compareSelector, extraBgVarName, extraColorVarName, extraBorderColorVarName, radiusVarName, childSelectors, focusTargetSelector }) {
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
    // `width` (F2, final fix wave, Ruling 29): widthLteWith reuses this same
    // slot heightEqWith already populates -- both are "compare THIS
    // element's geometry against another selector's" checks, so one probed
    // rect serves either axis instead of a second comparison mechanism.
    if (cmpEl) { const r = cmpEl.getBoundingClientRect(); compareRect = { height: r.height, width: r.width }; }
  }
  let extraBgRaw = null;
  if (extraBgVarName) {
    extraBgRaw = getComputedStyle(document.documentElement).getPropertyValue(extraBgVarName).trim() || null;
  }
  let extraColorRaw = null;
  if (extraColorVarName) {
    extraColorRaw = getComputedStyle(document.documentElement).getPropertyValue(extraColorVarName).trim() || null;
  }
  // extraBorderColorRaw (stage3b Task 1, mirrors extraBgRaw/extraColorRaw
  // exactly): borderColorEqVar needs its OWN slot for the same reason
  // colorEqVar got one, not bgEqVar's -- a border-color-role token
  // (`.pick-mark`'s resting --opt-border ring) is neither a background nor
  // a text-color read, and a future check that wanted borderColorEqVar
  // alongside bgEqVar/colorEqVar on the same element must not starve either.
  let extraBorderColorRaw = null;
  if (extraBorderColorVarName) {
    extraBorderColorRaw = getComputedStyle(document.documentElement).getPropertyValue(extraBorderColorVarName).trim() || null;
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
    // Same top|right|bottom|left quad for width and style (B+ field family
    // fix round 1): Chromium keeps a side's computed colour when that side is
    // not painted (width 0 / style none|hidden), so the colour quad alone
    // cannot tell a painted edge from an absent one.
    borderSideWidths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].join("|"),
    borderSideStyles: [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle].join("|"),
    children,
    focusedSelf,
    stability,
    bgStack,
    rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    // computedPosition / inViewport (library redesign T6): a float listbox's
    // popover is position: fixed in the top layer and must land inside the
    // viewport. Cheap and selector-independent, like rect above.
    position: cs.position,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    effRect,
    parentRect,
    svg,
    compareRect,
    extraBgRaw,
    extraColorRaw,
    extraBorderColorRaw,
    textInset,
    containmentChildren,
    // Unconditional (cheap, selector-independent) -- colorSchemeMatchesTheme's
    // proxy for native-control (scrollbar/spinner) rendering mode, which has
    // no pixel-level probe of its own (Task 6).
    rootColorScheme: getComputedStyle(document.documentElement).colorScheme,
    // density (Task 3, ui-system-stage0-design §4): same live-read pattern as
    // rootColorScheme above. A handful of stage-0 tokens (--opt-control-h /
    // --opt-row-min-h / --opt-text-body) redefine under
    // html[data-density="compact"], so a literal px spec that targets one of
    // them has to know which tier is live to pick the right number (see
    // resolvePxSpec in evaluateCheck below).
    density: document.documentElement.dataset.density === "compact" ? "compact" : "comfortable",
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
    // borderTopWidth / minHeight (Task 3, ui-system-stage0-design §4): the
    // stage-0 pref-row hairline lives on border-TOP (borderBottomWidth above
    // already serves the tab-underline check, a different element); minHeight
    // backs minHeightPx, which must read the CSS min-height PROPERTY itself,
    // not the rendered box height heightPx/hitRectMin already read off
    // raw.rect -- a pref-row label pinned by min-height can still grow past
    // the floor for a long/wrapped copy without failing that check.
    borderTopWidth: parseFloat(cs.borderTopWidth) || 0,
    minHeight: parseFloat(cs.minHeight) || 0,
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
    // The pointer / focus state this probe ran under, from this same task
    // (round 3, H): the checklist's `hover` state judges it inside
    // holdPointerState, so a pointer displaced between a separate check and
    // this read can no longer hand the assertions a rest paint.
    pointer: {
      hovered: el.matches(":hover"), focused: el.matches(":focus-within"),
      active: (() => {
        const n = document.activeElement;
        return n ? `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${[...(n.classList || [])].map((c) => `.${c}`).join("")}` : "null";
      })(),
      at: performance.now(),
    },
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
  // Density-tiered specs ({ comfortable, compact }): the tier is the theme's
  // pilot ui.density (options and library; popup and md-preview are single-tier). The
  // page's own html[data-density] must agree -- a disagreement is its own FAIL
  // row, not silently absorbed by reading the page.
  // Surfaces on the density rung (options since stage 0, library since the
  // 2026-10-03 redesign) -- one list, SWEEP_CFG.rung.density.surface, read at
  // call time (main() runs after the whole module has evaluated).
  const onDensitySurface = SWEEP_CFG.rung.density.surface.includes(check.surface);
  const densityTier = onDensitySurface ? OPTIONS_DENSITY.densityOf(theme) : "comfortable";
  const usesDensitySpec = Object.values(exp).some((s) => s && typeof s === "object" && "comfortable" in s && "compact" in s);
  if (usesDensitySpec && onDensitySurface && raw.density !== densityTier) {
    out.push(verdict("densityTier", false, raw.density, densityTier,
      "html[data-density] disagrees with the pilots' ui.density for this theme (PBP_OPTIONS_DENSITY_MAP drift, or a setup step re-derived the theme)"));
  }
  function resolvePxSpec(spec, defaultTolerancePx) {
    const tolerancePx = spec.tolerancePx ?? defaultTolerancePx;
    const value = "value" in spec ? spec.value : spec[densityTier];
    return { value, tolerancePx };
  }

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
  // `true` = both inline sides; "start" = the leading side only, for a chip
  // whose trailing end holds its own action (the removable group chip's x,
  // concentric with the end cap). The run is LTR, so start = left.
  if (exp.padGteRadiusH === true || exp.padGteRadiusH === "start") {
    if (hostZero) out.push(verdict("padGteRadiusH", false, null, null, zeroNote));
    else {
      const effRadius = Math.min(raw.borderRadius, raw.rect.height / 2);
      const padH = exp.padGteRadiusH === "start" ? raw.paddingLeft : Math.min(raw.paddingLeft, raw.paddingRight);
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
  // (S2, spec 2026-10-03-library-redesign §9.3). A pair passes on a fill gap
  // >= minDelta OR on a different marker (box-shadow / outline) -- except the
  // fillOnlyPairs, whose marker escape hatch is off, and the stepPairs (one
  // row's own hover step), which need >= minStep instead. Every named state
  // must have been captured (a misspelt or uncaptured name would otherwise
  // skip its pair in silence), every state's painted fill must equal its
  // derived token, and every textSelector must clear minTextContrast on its
  // own band in every state. Reported actual is the worst pair the fill
  // alone must carry (fillOnlyPairs and same-marker pairs), so OK implies
  // actual >= minDelta; ring-separated pairs are reported as markerPairMin.
  if ("bandDistinct" in exp) {
    const bd = exp.bandDistinct;
    const minDelta = bd.minDelta;
    const samples = raw.bandSamples || [];
    const notes = [];
    let worst = null;
    let worstMarked = null;
    if (samples.length < 2) notes.push("fewer than two states captured -- runOneCheck's rowStates driver failed");
    if ("textSelector" in bd) notes.push("bandDistinct.textSelector (one selector) is retired -- list every row text in textSelectors");
    const captured = new Set(samples.filter((s) => s.found).map((s) => s.state));
    for (const name of new Set([...(bd.fillOnlyPairs || []), ...(bd.stepPairs || [])].flat())) {
      if (!captured.has(name)) notes.push(`"${name}" is named by fillOnlyPairs / stepPairs but the driver did not capture it -- its pair would be skipped silently`);
    }
    const steps = new Set((bd.stepPairs || []).map((pair) => [...pair].sort().join("~")));
    if (steps.size && !(bd.minStep > 0)) notes.push("stepPairs needs a positive minStep");
    const minText = bd.minTextContrast;
    if (minText) {
      for (const sm of samples) {
        if (!sm.found) continue;
        for (const tx of sm.texts || []) {
          if (!tx.found) { notes.push(`"${sm.state}": textSelector ${tx.sel} matched nothing in the driven row`); continue; }
          const tbg = compositeStack(tx.bgStack);
          const fg = resolveColor(tx.color, tbg);
          const ratio = fg ? cr(fg, tbg) : 0;
          if (ratio < minText) notes.push(`"${sm.state}": ${tx.sel} ${round2(ratio)}:1 < ${minText}:1 against its own band`);
        }
      }
    }
    for (const sm of samples) {
      if (!sm.found || !sm.tokenRole) continue;
      const want = parseSolidColor(sm.tokenRaw);
      if (!want) { notes.push(`"${sm.state}": --lib-${sm.tokenRole} does not resolve (${JSON.stringify(sm.tokenRaw)})`); continue; }
      const got = compositeStack(sm.bgStack);
      const off = Math.max(Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]), Math.abs(got[2] - want[2]));
      if (off > 1) notes.push(`"${sm.state}": painted fill rgb(${got.map((c) => Math.round(c)).join(", ")}) is not --lib-${sm.tokenRole} ${sm.tokenRaw} (off by ${round2(off)}) -- the state rule stopped reading its derived token`);
    }
    // fillOnlyPairs: the marker escape hatch is switched off for these, so
    // the fill itself has to clear minDelta (independent review once reverted
    // the band from 18% to 10% and watched a marker-only pass stay green).
    const fillOnly = new Set((bd.fillOnlyPairs || []).map((pair) => [...pair].sort().join("~")));
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) {
        const a = samples[i], b = samples[j];
        if (!a.found || !b.found) { notes.push(`state not rendered: ${a.found ? b.state : a.state}`); continue; }
        const abg = compositeStack(a.bgStack), bbg = compositeStack(b.bgStack);
        const delta = Math.max(Math.abs(abg[0] - bbg[0]), Math.abs(abg[1] - bbg[1]), Math.abs(abg[2] - bbg[2]));
        const key = [a.state, b.state].sort().join("~");
        if (steps.has(key)) {
          if (delta < bd.minStep) notes.push(`hover step "${a.state}" -> "${b.state}" is ${round2(delta)} < ${bd.minStep}: the pointer passing over this row does not show`);
          continue;
        }
        const fillMustCarry = fillOnly.has(key);
        const markerDiffers = !fillMustCarry && (a.boxShadow !== b.boxShadow || a.outline !== b.outline);
        if (markerDiffers) { if (worstMarked === null || delta < worstMarked) worstMarked = delta; }
        else if (worst === null || delta < worst) worst = delta;
        if (delta < minDelta && !markerDiffers) {
          notes.push(fillMustCarry
            ? `"${a.state}" and "${b.state}" must be told apart by FILL alone: delta ${round2(delta)} < ${minDelta} (this pair's marker is excluded on purpose -- the band is the whole signal)`
            : `"${a.state}" and "${b.state}" are indistinguishable: fill delta ${round2(delta)} < ${minDelta} and identical marker (box-shadow ${a.boxShadow})`);
        }
      }
    }
    // Every pair separated by a marker would leave `actual` empty and the
    // fill unmeasured: an all-ring design is not S2, so say so.
    if (samples.length >= 2 && samples.every((s) => s.found) && worst === null) {
      notes.push("no pair is told apart by fill alone (every pair differs by marker) -- the fill gate measured nothing");
    }
    out.push({ ...verdict("bandDistinct", notes.length === 0, worst === null ? null : round2(worst), minDelta,
      notes.length ? notes.join("; ") : undefined), markerPairMin: worstMarked === null ? null : round2(worstMarked) });
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
  // hitRectMin (taste-uplift batch4 T1): a per-row minimum hit rect for a
  // NON-button target (hitAreaMin's sweep only scans buttons) -- the
  // `.switch` primitive's transparent native input. FAIL on a zero-size
  // rect or a missing/unparsable bound, never SKIP.
  if ("hitRectMin" in exp) {
    const { height, width } = exp.hitRectMin || {};
    const label = `h>=${height ?? "-"} w>=${width ?? "-"}`;
    if (typeof height !== "number" && typeof width !== "number") {
      out.push(verdict("hitRectMin", false, null, label, "hitRectMin needs a numeric height and/or width"));
    } else if (hostZero) out.push(verdict("hitRectMin", false, null, label, zeroNote));
    else {
      const notes = [];
      if (typeof height === "number" && !(raw.rect.height >= height - 0.01)) notes.push(`height ${round2(raw.rect.height)} < ${height}`);
      if (typeof width === "number" && !(raw.rect.width >= width - 0.01)) notes.push(`width ${round2(raw.rect.width)} < ${width}`);
      out.push(verdict("hitRectMin", notes.length === 0, `${round2(raw.rect.width)}x${round2(raw.rect.height)}`, label, notes.length ? notes.join("; ") : undefined));
    }
  }
  if ("heightPx" in exp) {
    const { value, tolerancePx } = resolvePxSpec(exp.heightPx, 1);
    if (hostZero) out.push(verdict("heightPx", false, null, value, zeroNote));
    else out.push(verdict("heightPx", Math.abs(raw.rect.height - value) <= tolerancePx, round2(raw.rect.height), value));
  }
  // minHeightPx (Task 3, ui-system-stage0-design §4): the CSS computed
  // min-height PROPERTY itself, not the rendered box height heightPx reads
  // off raw.rect above -- the stage-0 pref-row label is pinned by
  // min-height, so a wrapped (long) label can still grow past the floor
  // without failing this check the way a literal heightPx target would.
  if ("minHeightPx" in exp) {
    const { value, tolerancePx } = resolvePxSpec(exp.minHeightPx, 1);
    if (hostZero) out.push(verdict("minHeightPx", false, null, value, zeroNote));
    else out.push(verdict("minHeightPx", Math.abs(raw.minHeight - value) <= tolerancePx, round2(raw.minHeight), value));
  }
  // borderTopWidthPx (Task 3, ui-system-stage0-design §4): the stage-0
  // pref-row hairline -- a literal 1px border-top on `.pref-row + .pref-row`
  // siblings inside a non-radio .pref-group. Never a density token (options.
  // css keeps it a flat `1px`, not var(--opt-*)), so this always resolves
  // through resolvePxSpec's flat `value` path, same as heightPx above.
  if ("borderTopWidthPx" in exp) {
    const { value, tolerancePx } = resolvePxSpec(exp.borderTopWidthPx, 0.5);
    if (hostZero) out.push(verdict("borderTopWidthPx", false, null, value, zeroNote));
    else out.push(verdict("borderTopWidthPx", Math.abs(raw.borderTopWidth - value) <= tolerancePx, round2(raw.borderTopWidth), value));
  }
  // computedPosition / inViewport (library redesign T6, spec §9.2 last row):
  // the float listbox exists so the detail pane's overflow can no longer clip
  // its popover -- position: fixed in the top layer, placed by
  // pbpListboxPlace inside the viewport. An absolute popover, or one placed
  // off-screen, fails here.
  if ("computedPosition" in exp) {
    if (hostZero) out.push(verdict("computedPosition", false, null, exp.computedPosition, zeroNote));
    else out.push(verdict("computedPosition", raw.position === exp.computedPosition, raw.position, exp.computedPosition));
  }
  if ("inViewport" in exp) {
    const tol = exp.inViewport.tolerancePx ?? 0.5;
    const r = raw.rect, v = raw.viewport;
    const inside = r.left >= -tol && r.top >= -tol && r.left + r.width <= v.width + tol && r.top + r.height <= v.height + tol;
    if (hostZero) out.push(verdict("inViewport", false, null, "inside the viewport", zeroNote));
    else out.push(verdict("inViewport", inside, `${round2(r.left)},${round2(r.top)} ${round2(r.width)}x${round2(r.height)} in ${v.width}x${v.height}`, "inside the viewport"));
  }
  // paddingLeftPx (Task 3, ui-system-stage3a-design §3): the stage-0 indent
  // mechanism -- .pref-row-sub/.entry-block-sub read a fixed --opt-sp-7 (24px)
  // left padding, never a density token (options.css keeps the SAME indent
  // in both tiers), so this always resolves through resolvePxSpec's flat
  // `value` path, same as borderTopWidthPx above. Reads raw.paddingLeft,
  // already captured unconditionally by probeSelector for every check.
  if ("paddingLeftPx" in exp) {
    const { value, tolerancePx } = resolvePxSpec(exp.paddingLeftPx, 0.5);
    if (hostZero) out.push(verdict("paddingLeftPx", false, null, value, zeroNote));
    else out.push(verdict("paddingLeftPx", Math.abs(raw.paddingLeft - value) <= tolerancePx, round2(raw.paddingLeft), value));
  }
  // borderRadiusPx (fixwave stage2, R4 `.listbox-pop` OPEN row): a chromed
  // popover's corner radius must track the surface's OWN `--{ns}-radius-*`
  // rung live, not a literal px -- the 13 presets don't share one radius
  // scale (COMPONENTS.md §9), so a hardcoded target would false-fail on
  // every theme but the one it was measured against. Reuses insetBand's
  // radiusVarName/radiusVarPx probe slot (see the SETUP ERROR guard above
  // this function's call site) rather than adding a second one -- same
  // token, same live <html> read, just compared directly instead of as
  // part of an inset-band note.
  if ("borderRadiusPx" in exp) {
    const { radiusVar, tolerancePx = 0.5 } = exp.borderRadiusPx;
    if (hostZero) out.push(verdict("borderRadiusPx", false, null, null, zeroNote));
    else if (raw.radiusVarPx == null) out.push(verdict("borderRadiusPx", false, round2(raw.borderRadius), null, `--${radiusVar} did not resolve on <html>`));
    else out.push(verdict("borderRadiusPx", Math.abs(raw.borderRadius - raw.radiusVarPx) <= tolerancePx, round2(raw.borderRadius), round2(raw.radiusVarPx)));
  }
  // widthPx (T6, taste-uplift-batch3, D2, COMPONENTS.md §6.1): a content-kind
  // field's measured width against its tier -- unlike heightPx above (a
  // literal target value, |diff| <= tolerance, since a chip's height IS its
  // geometry), `max` is a one-sided ceiling: `max-width` never forces a
  // field WIDER than its container, so the same field legitimately renders
  // narrower than `max` on a viewport too small for the cap to even engage
  // (D2's "still 100% on narrow viewports" requirement) -- FAILing that
  // would be asserting the wrong thing. `min` (final fix wave, Ruling 29
  // F2) is the mirror-image floor: added for the select tier, which
  // batch-end review F2 moved off a fixed 240px ceiling onto `width:
  // max-content; min-width: 240px; max-width: 100%` (native sizing to the
  // longest option, never clips) -- a select that somehow rendered NARROWER
  // than its floor would be exactly as wrong as one that rendered past its
  // ceiling, so this is FAIL not SKIP, same discipline as `max`. Either
  // bound is optional; both may be given at once. No new probe slot needed
  // for either: both read the SAME raw.rect.width heightPx's raw.rect.height
  // sibling already carries out of probeSelector.
  if ("widthPx" in exp) {
    const { min, max, tolerancePx = 0.5 } = exp.widthPx;
    const label = min != null && max != null ? `${min}-${max}` : min != null ? `>=${min}` : `<=${max}`;
    if (hostZero) out.push(verdict("widthPx", false, null, label, zeroNote));
    else {
      const w = raw.rect.width;
      const notes = [];
      if (min != null && w < min - tolerancePx) notes.push(`< min ${min}`);
      if (max != null && w > max + tolerancePx) notes.push(`> max ${max}`);
      out.push(verdict("widthPx", notes.length === 0, round2(w), label, notes.length ? notes.join("; ") : undefined));
    }
  }
  // widthLteWith (F2, final fix wave, Ruling 29): the select tier's OTHER
  // half of "≥240 and ≤ the field column width" -- the column width is not
  // a literal (it depends on the panel/viewport), so it is read live off
  // another selector's own rendered width, the same "compare THIS element's
  // geometry against a second selector" shape heightEqWith already uses for
  // height (probeSelector's compareRect, widened above to carry width too).
  if ("widthLteWith" in exp) {
    const { selector: cmpSel, tolerancePx = 0.5 } = exp.widthLteWith;
    if (hostZero) out.push(verdict("widthLteWith", false, null, cmpSel, zeroNote));
    else if (raw.compareRect == null) {
      out.push(verdict("widthLteWith", false, null, cmpSel, `comparison selector not found: ${cmpSel}`));
    } else if (raw.compareRect.width === 0) {
      out.push(verdict("widthLteWith", false, null, cmpSel, `comparison element is zero-size: ${cmpSel}`));
    } else {
      const ok = raw.rect.width <= raw.compareRect.width + tolerancePx;
      out.push(verdict("widthLteWith", ok, round2(raw.rect.width), round2(raw.compareRect.width),
        ok ? undefined : `${round2(raw.rect.width)}px exceeds ${cmpSel}'s ${round2(raw.compareRect.width)}px`));
    }
  }
  if ("fontSizePx" in exp) {
    const { value, tolerancePx } = resolvePxSpec(exp.fontSizePx, 0.5);
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
  // borderColorEqVar (stage3b Task 1, mirrors bgEqVar/colorEqVar): a
  // `.pick-mark`'s resting ring must be THIS theme's --{ns}-border token,
  // verbatim -- not a coincidentally-similar grey. raw.borderColors is the 4
  // sides joined "top|right|bottom|left" (unconditional, existing probe
  // field); .pick-mark's border is uniform on all sides (composer's
  // `border: 1px solid var(--{ns}-border)`, one declaration, no per-side
  // override anywhere in the recipe or in options.css), so the first side
  // stands in for all four rather than adding a second raw shape just for
  // this one check. A value box's frame is pinned on all four sides by
  // borderSidesEqVar below (stage 4: the B+ bottom edge, and the
  // edgeColorEqVar that read it, are retired).
  const sideColors = (raw.borderColors || "").split("|");
  const sideWidths = (raw.borderSideWidths || "").split("|").map((w) => parseFloat(w));
  const sideStyles = (raw.borderSideStyles || "").split("|");
  // A side is PAINTED when its computed width is non-zero and its style is
  // not none/hidden (both of those compute width 0, but the colour survives
  // -- fix round 1). Non-zero, not ">= 1px": Chromium snaps a border to whole
  // device pixels, and this headed WSLg host (display scale 1.5, emulated
  // devicePixelRatio 1) computes a 1px border as 0.666667px; any painted
  // border keeps at least one device pixel, an unpainted one computes 0.
  const sidePainted = (i) => sideWidths[i] > 0 && !!sideStyles[i] && !/^(?:none|hidden)$/.test(sideStyles[i]);
  const sideDesc = (i) => `${sideColors[i]} ${sideWidths[i]}px ${sideStyles[i]}`;
  if ("borderColorEqVar" in exp) {
    const want = parseSolidColor(raw.extraBorderColorRaw);
    const note = !want ? `--${exp.borderColorEqVar} token unresolved (raw=${JSON.stringify(raw.extraBorderColorRaw)})` : undefined;
    out.push(verdict("borderColorEqVar", colorsEqual(want, parseSolidColor(sideColors[0])), sideColors[0],
      `var(--...-${exp.borderColorEqVar})=${raw.extraBorderColorRaw}`, note));
  }
  // borderSidesEqVar: ALL FOUR sides equal the token and are painted -- a
  // value box paints one frame colour all the way round in every state (stage
  // 4, spec 2026-09-30-ui-fields-stage4-design §2.1: no bottom edge; final
  // review G4: `border-top-width: 0` / `border-inline-style: none` keep the
  // computed colour while erasing the side, hence "painted"). Shares
  // borderColorEqVar's probe slot; a row may not set both.
  if ("borderSidesEqVar" in exp) {
    const want = parseSolidColor(raw.extraBorderColorRaw);
    const ok = !!want && sideColors.length === 4 && [0, 1, 2, 3].every((i) => colorsEqual(want, parseSolidColor(sideColors[i])) && sidePainted(i));
    const note = !want ? `--${exp.borderSidesEqVar} token unresolved (raw=${JSON.stringify(raw.extraBorderColorRaw)})` : undefined;
    out.push(verdict("borderSidesEqVar", ok, [0, 1, 2, 3].map(sideDesc).join("|"), `4 x painted var(--...-${exp.borderSidesEqVar})=${raw.extraBorderColorRaw}`, note));
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
  // the retired sort segment / `.vocab-group-unit` to `overflow: hidden` leaves
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
  // rectangle that got the retired sort segment (T6) rejected.
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

// The token each S2 row state must paint (spec 2026-10-03-library-redesign
// §6.4). `rest` is the page bg: the vocab row paints var(--lib-bg) itself, the
// notes row is transparent over a canvas that is --lib-bg -- both composite to
// the same colour.
const ROW_STATE_TOKENS = Object.freeze({
  rest: "bg", hover: "row-bg-hover", current: "row-current-bg", "current+hover": "row-current-bg-hover",
  selected: "row-band-bg", "selected+hover": "row-band-bg-hover",
  "selected+current": "row-band-current-bg", "selected+current+hover": "row-band-current-bg-hover",
});

// ---- state: "rowStates" (S2, spec 2026-10-03-library-redesign §9.3) -------
// Reads ONE row's band eight times with the real gestures: rest, Ctrl+click
// (selected), click (selected + current), Ctrl+click (current only -- the
// state that is neither rest nor a selection, so it is driven, not assumed),
// each read once with the pointer parked outside the row and once hovering
// the row. aria-current is exclusive, so the states are not on screen at once
// -- they do not need to be: the question is whether a user can tell them
// apart. The driven row is the first one that carries every textSelector
// (secondary text only exists on some rows).
//
// The driver owns the selection it makes. It snapshots the view's state
// before its own reload (which row is current, which rows are in the batch
// selection -- runLibraryTheme runs vocab checks with the batch row CLOSED
// since T4d and opens the notes batch row once for the whole notes pass) and
// puts exactly that back in a `finally`, so no later check in the same theme
// pass inherits a selection, a current row or a hovered row it did not ask
// for -- including after a failed read.
const rowStateSnapshot = (cardSel) => {
  const cards = [...document.querySelectorAll(cardSel)];
  return {
    current: cards.findIndex((c) => c.hasAttribute("aria-current")),
    selected: cards.flatMap((c, i) => (c.classList.contains("selected") ? [i] : [])),
  };
};
async function driveRowStates(page, extBase, theme, selector, textSelectors) {
  if (!Array.isArray(textSelectors) || !textSelectors.length) {
    throw new Error(`SETUP: rowStates ${selector} needs expect.bandDistinct.textSelectors (a non-empty array)`);
  }
  const view = libraryView(selector);
  const rowSel = view === "notes" ? "#notes-list .notes-hit-btn" : "#vocab-list .vocab-card .notes-card-head";
  const cardSel = view === "notes" ? "#notes-list .notes-hit" : "#vocab-list .vocab-card";
  const before = await page.evaluate(rowStateSnapshot, cardSel);
  // The query carries the VIEW as well as the theme: without it the notes
  // pass and the vocab pass differ only by fragment, Chromium treats the
  // second goto as same-document and never reloads, and the notes driver
  // would read its "rest" out of a row the vocab pass already made current.
  const load = async (tag) => {
    await page.goto(`${extBase}library.html?_ra=${encodeURIComponent(theme)}-${tag}-${view}#${view}`, { waitUntil: "load", timeout: TIMEOUT_MS });
    await page.waitForSelector(rowSel, { timeout: TIMEOUT_MS });
    await page.waitForTimeout(300);
  };
  // Put the snapshot back: reload only if a row is current that must not be
  // (there is no un-activate control above 860px), then a plain click for the
  // current row and a Ctrl+click for every row whose selection differs --
  // the two verbs never touch each other's state (library-vocab.js /
  // library-notes.js row click handlers).
  const restore = async () => {
    let now = await page.evaluate(rowStateSnapshot, cardSel);
    if (before.current < 0 && now.current >= 0) { await load("band-restore"); now = await page.evaluate(rowStateSnapshot, cardSel); }
    if (before.current >= 0 && now.current !== before.current) await page.locator(rowSel).nth(before.current).click();
    const was = new Set(before.selected), is = new Set(now.selected);
    for (const i of new Set([...was, ...is])) {
      if (was.has(i) !== is.has(i)) await page.locator(rowSel).nth(i).click({ modifiers: ["Control"] });
    }
    await page.mouse.move(0, 0);
    await page.evaluate(() => { const a = document.activeElement; if (a && a !== document.body && typeof a.blur === "function") a.blur(); });
    await settleAnimations(page);
    const after = await page.evaluate(rowStateSnapshot, cardSel);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(`SETUP: rowStates ${selector} could not restore the ${view} view (theme=${theme}): wanted ${JSON.stringify(before)}, left ${JSON.stringify(after)}`);
    }
  };
  await load("band");
  const samples = [];
  let failed = true;
  try {
    const pick = await page.evaluate(({ sel, rowSel, texts }) => {
      const probes = [...document.querySelectorAll(sel)];
      return { idx: probes.findIndex((el) => texts.every((t) => el.querySelector(t))), probes: probes.length, rows: document.querySelectorAll(rowSel).length };
    }, { sel: selector, rowSel, texts: textSelectors });
    if (pick.probes !== pick.rows) throw new Error(`SETUP: ${selector} (${pick.probes}) and ${rowSel} (${pick.rows}) no longer pair up one per row (theme=${theme})`);
    if (pick.idx < 0) {
      throw new Error(`SETUP: no ${selector} row carries every textSelector ${JSON.stringify(textSelectors)} (theme=${theme}) -- give one seeded ${view} row all of them (LIB_SEED in this file)`);
    }
    const head = page.locator(rowSel).nth(pick.idx);
    const read = (state) => page.evaluate(({ sel, idx, texts, state, tokenRole }) => {
      const stackOf = (node) => {
        const out = [];
        for (let n = node; n && n.nodeType === 1; n = n.parentElement) out.push(getComputedStyle(n).backgroundColor);
        return out;
      };
      const el = document.querySelectorAll(sel)[idx];
      if (!el) return { state, found: false };
      const cs = getComputedStyle(el);
      return {
        state, found: true, bgStack: stackOf(el), boxShadow: cs.boxShadow,
        // outline-color defaults to currentColor, and the notes row button
        // changes `color` between states: with no outline drawn, comparing
        // width/colour would invent a marker difference (facts-s2 R3-2).
        outline: cs.outlineStyle === "none" ? "none" : `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
        tokenRole, tokenRaw: getComputedStyle(document.documentElement).getPropertyValue(`--lib-${tokenRole}`).trim(),
        texts: texts.map((t) => {
          const n = el.querySelector(t);
          return n ? { sel: t, found: true, color: getComputedStyle(n).color, bgStack: stackOf(n) } : { sel: t, found: false };
        }),
        // The pointer state this fill was read under, from the SAME task as
        // the fill, for holdPointerState to judge (the probe is the element
        // whose :hover rule paints the band: .notes-card-top contains the
        // vocab head, the notes button is its own probe).
        hovered: el.matches(":hover"),
        focused: el.matches(":focus-within"),
        active: (() => {
          const n = document.activeElement;
          return n ? `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${[...(n.classList || [])].map((c) => `.${c}`).join("")}` : "null";
        })(),
        at: performance.now(),
      };
    }, { sel: selector, idx: pick.idx, texts: textSelectors, state, tokenRole: ROW_STATE_TOKENS[state] });
    // Every read, resting and hovered, goes through the shared pointer hold
    // (holdPointerState has the root cause): this audit is headed, and
    // Chromium dispatches TRUSTED pointer events at the host's OS cursor,
    // which under CI's xvfb sits inside the window. One landing between a
    // bare hover and the read moved the hover chain off the row, so the
    // "hover" read measured the resting fill or a fill fading back to it
    // (CI run 37403177853, both attempts: notes row, "hover" 1 off rest,
    // "selected+current+hover" 3 short of its step; reproduced locally under
    // xvfb with CPU contention, the witness log showing a mouseout at the
    // xvfb cursor 17 ms after the hover). The hold waits for a late :hover,
    // reads hovered / focus in the same task as the fill, retries a read a
    // foreign event spoiled, and parks the resting reads outside the row (a
    // click leaves the cursor ON the row, and each state's hover is a
    // different fill). Inside the read: a rest read first waits for :hover
    // to actually leave, then settleAnimations waits out the background-
    // color transition page-wide (verify.sh's parallel shards once read two
    // states mid-fade at exactly the same colour) -- a hover-off that lands
    // after the settle looked would otherwise be read mid-fade.
    const held = async (state, mode) => {
      const handle = await head.elementHandle({ timeout: TIMEOUT_MS });
      try {
        const hold = await holdPointerState(page, handle, async () => {
          if (mode === "rest") await handle.evaluate(awaitHoverState, { want: false, ms: HOVER_APPLY_MS });
          await settleAnimations(page);
          return read(state);
        }, mode);
        if (!hold.ok) {
          const err = new Error(`SETUP: rowStates ${selector} "${state}" (${mode}) did not hold (theme=${theme})`);
          err.rowStateHold = { state, mode, hold };
          throw err;
        }
        return hold.got;
      } finally {
        await handle.dispose();
      }
    };
    // Each gesture is checked against the attribute it is supposed to flip,
    // so a renamed handler cannot quietly hand the gate a mislabelled state.
    const expectRow = async (state, current, selected) => {
      const got = await page.evaluate(({ cardSel, idx }) => {
        const c = document.querySelectorAll(cardSel)[idx];
        return c ? { current: c.hasAttribute("aria-current"), selected: c.classList.contains("selected") } : null;
      }, { cardSel, idx: pick.idx });
      if (!got || got.current !== current || got.selected !== selected) {
        throw new Error(`SETUP: rowStates ${selector} expected "${state}" (current=${current}, selected=${selected}) but the row reads ${JSON.stringify(got)} (theme=${theme})`);
      }
    };
    await expectRow("rest", false, false);
    samples.push(await held("rest", "rest"), await held("hover", "hover"));
    await head.click({ modifiers: ["Control"] }); await settleAnimations(page); await expectRow("selected", false, true);
    samples.push(await held("selected", "rest"), await held("selected+hover", "hover"));
    await head.click(); await settleAnimations(page); await expectRow("selected+current", true, true);
    samples.push(await held("selected+current", "rest"), await held("selected+current+hover", "hover"));
    await head.click({ modifiers: ["Control"] }); await settleAnimations(page); await expectRow("current", true, false);
    samples.push(await held("current", "rest"), await held("current+hover", "hover"));
    failed = false;
  } finally {
    if (failed) {
      // The read already threw: restore best-effort, never mask that error.
      try { await restore(); } catch (err) { console.warn(`[render-audit] rowStates restore after failure: ${err.message}`); }
    } else {
      await restore();
    }
  }
  return samples;
}


// ---- library notes scenarios (T8e, spec 2026-10-03-library-redesign §9.2 G4 /
// G5 notes half). Opens one state the notes half measures, on the SEEDED data
// (LIB_SEED, T2): the cover (nothing selected), the CJK-titled single-
// highlight page, the É-titled single-highlight page ("notes-diacritic",
// final review #10), or the >= 3-highlight page opened at its SECOND-oldest
// highlight (excerpts above and below the current one). Selection goes through
// the page's own _pbpNotesSelectRow -- the path a row click takes -- and every
// miss is a SETUP error, never a quiet measurement of the wrong state. The
// pane is put back at its top, so a first line is where a reader first sees it.
async function libOpenNotesScenario(page, scenario) {
  if (!(await page.$("#view-notes:not([hidden])"))) await page.click("#lib-tab-notes");
  await page.waitForSelector("#notes-list .notes-hit", { timeout: TIMEOUT_MS });
  const res = await page.evaluate(({ scenario, seed }) => {
    const pane = document.getElementById("notes-detail-pane");
    if (scenario === "notes-cover") {
      _pbpNotesRenderDetail(null);
      if (pane) pane.scrollTop = 0;
      return { ok: !document.getElementById("notes-detail-empty").hidden, why: "the cover did not show" };
    }
    const url = { "notes-multi": seed.multiUrl, "notes-solo": seed.soloUrl, "notes-diacritic": seed.diacriticUrl }[scenario] || null;
    if (!url) return { ok: false, why: `unknown scenario ${scenario}` };
    const hits = _pbpNotesHits().filter((h) => h.row.url === url).sort((a, b) => a.ts - b.ts);
    if (scenario === "notes-multi" && hits.length < 3) return { ok: false, why: `${hits.length} highlight(s) on ${url}, need >= 3` };
    const wantTitle = { "notes-solo": seed.cjkTitle, "notes-diacritic": seed.diacriticTitle }[scenario];
    if (wantTitle && (hits.length !== 1 || hits[0].row.title !== wantTitle)) {
      return { ok: false, why: `${hits.length} highlight(s) on ${url} titled ${JSON.stringify(hits[0] && hits[0].row.title)}` };
    }
    const want = hits[scenario === "notes-multi" ? 1 : 0].key;
    _pbpNotesSelectRow(want);
    if (pane) pane.scrollTop = 0;
    const cur = document.querySelector('#notes-detail > .notes-excerpt[aria-current="true"]');
    return {
      ok: !document.getElementById("notes-detail").hidden && _pbpNotesSelectedKey === want && !!cur,
      why: `the detail did not open on ${want} (selected ${JSON.stringify(_pbpNotesSelectedKey)}, current excerpt ${!!cur})`,
    };
  }, { scenario, seed: LIB_SEED });
  if (!res.ok) throw new Error(`SETUP: notes scenario "${scenario}" -- ${res.why} (LIB_SEED / T2 seed)`);
  await settleAnimations(page);
}

// What the notes half changes on the shared page: the selected highlight and
// the narrow-view class _pbpNotesSelectRow sets (inert above 860px, but the
// rows after this one measure at whatever width they ask for).
async function libSnapshotNotes(page) {
  return page.evaluate(() => ({
    key: _pbpNotesSelectedKey,
    narrow: document.body.classList.contains("lib-narrow-notes"),
  }));
}
async function libRestoreNotesSelection(page, snap) {
  await page.evaluate((s) => {
    if (s.key && _pbpNotesFindHit(s.key)) _pbpNotesSelectRow(s.key);
    else _pbpNotesRenderDetail(null);
    document.body.classList.toggle("lib-narrow-notes", !!s.narrow);
  }, snap);
  await settleAnimations(page);
}

// G5 (notes half), in-page: the numbers spec §5.2-§5.6 and the 10-05 tiers fix
// for an open page. Widths are the boxes' own (the head fills the main
// column; the column's width is its box), positions are border boxes.
const NOTES_GEOMETRY_PROBE = () => {
  const pane = document.getElementById("notes-detail-pane");
  const d = document.getElementById("notes-detail");
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none" && !el.closest("[hidden]");
  const rect = (el) => el.getBoundingClientRect();
  const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
  const head = d && d.querySelector(":scope > .notes-detail-head");
  const side = d && d.querySelector(":scope > .notes-page-side");
  const exs = d ? [...d.querySelectorAll(":scope > .notes-excerpt")] : [];
  const cur = d && d.querySelector(':scope > .notes-excerpt[aria-current="true"] .notes-excerpt-quote');
  const other = d && d.querySelector(":scope > .notes-excerpt:not([aria-current]) .notes-excerpt-quote");
  const dels = d ? [...d.querySelectorAll(".notes-detail-delete")].filter(vis) : [];
  const pagecount = d && d.querySelector(".notes-meta-pagecount");
  const cs = pane && getComputedStyle(pane);
  const sideVisible = vis(side);
  return {
    ok: !!(pane && d && !d.hidden && head),
    // The width @container lib-detail resolves against (as hangOrder reads it).
    containerPx: pane ? r2(rect(pane).width - (pane.offsetWidth - pane.clientWidth) - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) : null,
    axis: pane ? r2(rect(pane).left + pane.clientLeft + parseFloat(cs.paddingLeft)) : null,
    headTop: head ? r2(rect(head).top) : null,
    headBottom: head ? r2(rect(head).bottom) : null,
    headLeft: head ? r2(rect(head).left) : null,
    headRight: head ? r2(rect(head).right) : null,
    headWidth: head ? r2(rect(head).width) : null,
    sideVisible,
    sideTop: sideVisible ? r2(rect(side).top) : null,
    sideLeft: sideVisible ? r2(rect(side).left) : null,
    sideWidth: sideVisible ? r2(rect(side).width) : null,
    sideBottom: sideVisible ? r2(rect(side).bottom) : null,
    firstExTop: exs.length ? r2(rect(exs[0]).top) : null,
    exCount: exs.length,
    currentPx: cur ? parseFloat(getComputedStyle(cur).fontSize) : null,
    otherPx: other ? parseFloat(getComputedStyle(other).fontSize) : null,
    visibleDeletes: dels.length,
    deleteInSide: dels.length === 1 && !!dels[0].closest(".notes-page-side"),
    pagecountVisible: vis(pagecount),
  };
};

// G5 (notes half). Runs in a scratch page of its own (same theme already in
// storage): it switches the UI language, which the shared page must not see,
// and it leaves nothing to put back. Each viewport names the tier it means by
// its container width C (`containerPx`, a SETUP when C lands outside -- the
// ranges keep every case >= 40px off a tier edge, so a case never sits on the
// boundary it is about): "single" (C < 1000), "hang" (1000 <= C < 1312: the
// labels hang left of the 800 excerpt column, no page column) and "side"
// (C >= 1312: the "this page" column beside the full 800 excerpt column,
// T8f "main column first"). Labels against their content are hangOrder's
// (T8f); this measures where the columns land and what the page shows.
async function driveNotesGeometry(page, extBase, theme, check) {
  const cfg = check.expect.libGeometry;
  const tol = cfg.tolerancePx ?? 1;
  const locales = cfg.locales || ["en"];
  const shots = process.env.RA_NOTES_SHOTS || "";
  if (shots) mkdirSync(shots, { recursive: true });
  const bad = [];
  let measured = 0;
  const first = cfg.viewports[0];
  const p = await libScratchPage(page, extBase, theme, "notes-geometry", "notes", { width: first.width, height: first.height });
  try {
    for (const locale of locales) {
      await setLibraryLocale(p, extBase, locale);
      for (const vp of cfg.viewports) {
        await p.setViewportSize({ width: vp.width, height: vp.height });
        await p.waitForTimeout(250);
        for (const scenario of cfg.scenarios) {
          await libOpenNotesScenario(p, scenario);
          const g = await p.evaluate(NOTES_GEOMETRY_PROBE);
          const at = `${locale} ${scenario}@${vp.width}`;
          if (!g.ok) throw new Error(`SETUP: libGeometry ${at}: the notes detail is not open`);
          if (!(g.containerPx >= vp.containerPx[0] && g.containerPx < vp.containerPx[1])) {
            throw new Error(`SETUP: libGeometry ${at}: the detail's container width is ${g.containerPx}, outside the case's ${vp.tier} range [${vp.containerPx.join(", ")})`);
          }
          measured++;
          const wantSide = vp.tier === "side";
          // Where the main column starts and how wide it is, by tier: the
          // hang column (112) only from 1000, the excerpt column never wider
          // than 800 nor narrower than what C leaves it.
          const hang = vp.tier === "single" ? 0 : cfg.hangPx;
          if (Math.abs(g.headLeft - g.axis - hang) > tol) bad.push(`${at}: the head starts ${(g.headLeft - g.axis).toFixed(1)} right of the axis, want ${hang}`);
          const mainWant = Math.min(cfg.excerptMaxPx, g.containerPx - hang);
          if (Math.abs(g.headWidth - mainWant) > tol) bad.push(`${at}: the main column is ${g.headWidth} wide at C ${g.containerPx}, want ${mainWant}`);
          if (g.sideVisible !== wantSide) bad.push(`${at}: .notes-page-side ${g.sideVisible ? "shown" : "hidden"} at C ${g.containerPx}, want ${wantSide ? "shown" : "hidden"}`);
          if (wantSide && g.sideVisible) {
            if (Math.abs(g.sideTop - g.headTop) > tol) bad.push(`${at}: column top ${g.sideTop} != head top ${g.headTop}`);
            if (Math.abs(g.sideLeft - g.headRight - cfg.sideGapPx) > tol) bad.push(`${at}: column left ${g.sideLeft} is ${(g.sideLeft - g.headRight).toFixed(1)} right of the main column (${g.headRight}), want ${cfg.sideGapPx}`);
            const sideWant = Math.min(cfg.sideMaxPx, Math.max(cfg.sideMinPx, g.containerPx - cfg.hangPx - cfg.excerptMaxPx - cfg.sideGapPx));
            if (Math.abs(g.sideWidth - sideWant) > tol) bad.push(`${at}: the column is ${g.sideWidth} wide at C ${g.containerPx}, want ${sideWant}`);
          }
          if (g.visibleDeletes !== 1 || g.deleteInSide !== wantSide) bad.push(`${at}: ${g.visibleDeletes} page delete(s) shown, in the column: ${g.deleteInSide}`);
          if (g.pagecountVisible === wantSide) bad.push(`${at}: the head meta's page count is ${g.pagecountVisible ? "shown" : "hidden"} with the column ${wantSide ? "present" : "absent"}`);
          if (g.currentPx !== cfg.currentPx) bad.push(`${at}: current excerpt ${g.currentPx}px, want ${cfg.currentPx}`);
          // Head to the first excerpt, on every page: a "this page" column
          // taller than the head and the excerpts beside it must not push the
          // first excerpt down (it spans their rows -- T8d review).
          if (Math.abs(g.firstExTop - g.headBottom - cfg.headToFirstExcerptPx) > tol) {
            bad.push(`${at}: head bottom to first excerpt ${(g.firstExTop - g.headBottom).toFixed(1)}, want ${cfg.headToFirstExcerptPx}${g.sideVisible ? ` (column ${g.sideTop}-${g.sideBottom})` : ""}`);
          }
          if (scenario === "notes-multi") {
            if (g.exCount < 3) bad.push(`${at}: ${g.exCount} excerpts, want >= 3`);
            if (g.otherPx !== cfg.otherPx) bad.push(`${at}: other excerpts ${g.otherPx}px, want ${cfg.otherPx}`);
          } else if (g.exCount !== 1) {
            bad.push(`${at}: ${g.exCount} excerpts on the single-highlight page`);
          }
          if (shots) await p.screenshot({ path: join(shots, `${scenario}--${theme || "default"}--${locale}--${vp.width}.png`) });
        }
      }
    }
  } finally {
    await closeLibScratch(page, p);
  }
  return { bad, measured };
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
const PANE_FIT_SCAN = ({ panes, tolerance, bleed = [] }) => {
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
    const paneRight = pr.right - (parseFloat(pcs.paddingRight) || 0) - (parseFloat(pcs.borderRightWidth) || 0);
    const paneLeft = pr.left + (parseFloat(pcs.paddingLeft) || 0) + (parseFloat(pcs.borderLeftWidth) || 0);
    // A list region bleeds past its pane by design (library redesign §2.4:
    // 4px at the start so row fills meet the search box, scrollbar gutter +
    // 4px into the gap at the end). Its own box is exempt and its overhang is
    // allowed in the pane's scrollWidth; everything INSIDE it is still checked,
    // against the region's own content box (the rows fill the region, so the
    // pane's edges would flag every row by the designed 4px). The allowance
    // is capped at what the design can produce -- the region's measured
    // scrollbar gutter + 4px (+ tolerance) -- so a runaway negative margin is
    // still a paneScroll rather than an overhang the gate quietly widens for.
    const bleeders = bleed.flatMap((sel) => [...pane.querySelectorAll(sel)]);
    const allowance = bleeders.reduce((max, el) => {
      const cap = (el.offsetWidth - el.clientWidth) + 4 + tolerance;
      return Math.max(max, Math.min(cap, Math.ceil(el.getBoundingClientRect().right - pr.right)));
    }, 0);
    if (pane.scrollWidth > pane.clientWidth + tolerance + allowance) {
      hits.push({ pane: paneSel, el: paneSel, kind: "paneScroll", over: +(pane.scrollWidth - pane.clientWidth).toFixed(2) });
    }
    const contentEdges = (box) => {
      const r = box.getBoundingClientRect();
      const cs = getComputedStyle(box);
      const l = r.left + box.clientLeft + (parseFloat(cs.paddingLeft) || 0);
      return { left: l, right: r.left + box.clientLeft + box.clientWidth - (parseFloat(cs.paddingRight) || 0) };
    };
    const bleedEdges = new Map(bleeders.map((b) => [b, contentEdges(b)]));
    for (const el of pane.querySelectorAll("*")) {
      if (bleeders.includes(el)) continue;
      const host = bleeders.find((b) => b.contains(el));
      const { left, right } = host ? bleedEdges.get(host) : { left: paneLeft, right: paneRight };
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") continue;
      if (el.closest("[hidden]")) continue;
      // Screen-reader-only labels are parked off-canvas on purpose.
      if (el.classList.contains("sr-only") || el.closest(".sr-only")) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // Optical hang (library .lib-hang-start / .lib-hang-end, spec §6.6): a
      // ghost button pulled out by exactly its own inline padding keeps its
      // CONTENT on the column edge -- only transparent padding crosses it.
      // Category rule (the G4b offset class), not a list of names.
      const mr = parseFloat(cs.marginRight) || 0, ml = parseFloat(cs.marginLeft) || 0;
      const hangR = mr < 0 && Math.abs(-mr - (parseFloat(cs.paddingRight) || 0)) <= 0.5 ? -mr : 0;
      const hangL = ml < 0 && Math.abs(-ml - (parseFloat(cs.paddingLeft) || 0)) <= 0.5 ? -ml : 0;
      if (r.right - hangR > right + tolerance) hits.push({ pane: paneSel, el: nameOf(el), kind: "pastRightEdge", over: +(r.right - hangR - right).toFixed(2) });
      else if (r.left + hangL < left - tolerance) hits.push({ pane: paneSel, el: nameOf(el), kind: "pastLeftEdge", over: +(left - r.left - hangL).toFixed(2) });
    }
  }
  return hits;
};

async function drivePaneFit(page, check) {
  const { widths, panes, tolerancePx = 1, resetNarrowDetail = false, bleed = [], vocabLookupOther = null, notesScenario = null } = check.expect.paneFit;
  const prevNotes = notesScenario ? await libSnapshotNotes(page) : null;
  // T7a: measure the dictionary column showing ANOTHER word's result (its
  // head row + slot), not the open word's idle button. The audit profile
  // never grants the dictionary origin, so the slot renders md-dict's connect
  // state -- zero network, same geometry host as a real result.
  const otherWordOn = vocabLookupOther
    ? await page.evaluate(() => document.body.classList.contains("lib-narrow-detail"))
    : null;
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
    // T8e: measure a named notes state (the multi-highlight page with its
    // "this page" column), not whichever highlight happened to be open. The
    // scenario opens it the way a row click does, which also makes the
    // detail the visible half of the narrow view at 420.
    if (notesScenario) await libOpenNotesScenario(page, notesScenario);
    if (vocabLookupOther) {
      await page.evaluate((term) => {
        document.body.classList.add("lib-narrow-detail"); // the pane must be the visible view at 420
        _pbpVocabLookupOther(term, "en");
      }, vocabLookupOther);
      await page.waitForSelector("#vocab-ref-result .vocab-ref-head", { timeout: TIMEOUT_MS });
      await settleAnimations(page);
    }
    for (const width of widths) {
      await page.setViewportSize({ width, height: restore ? restore.height : 900 });
      await page.waitForTimeout(250);
      for (const hit of await page.evaluate(PANE_FIT_SCAN, { panes, tolerance: tolerancePx, bleed })) {
        found.push({ ...hit, width });
      }
    }
  } finally {
    if (restore) await page.setViewportSize(restore);
    await page.waitForTimeout(250);
    if (vocabLookupOther) {
      await page.evaluate((wasNarrow) => {
        const w = _vocabRows.find((r) => r.id === _pbpVocabDetailWordId) || null;
        _pbpVocabResetRef(w);
        document.body.classList.toggle("lib-narrow-detail", wasNarrow);
      }, otherWordOn);
    }
    if (notesScenario) await libRestoreNotesSelection(page, prevNotes);
  }
  return found;
}

// ---- states "displayInkTop" / "detailNegMargin" / "libGeometry" (library
// redesign T7, spec §9.2 G4 / G4b / G5). Driven through the page's own render
// functions (the LIB_SEED words, T2) at fixed window sizes. Each driver notes
// which word the pane showed and puts it back, so the "-detail-" rows after it
// still read the word runLibraryTheme opened. `cases` entries are LIB_SEED
// terms or "cover"; T8 adds the notes half to the same drivers.
async function libSnapshotVocab(page) {
  return page.evaluate(() => ({
    id: typeof _pbpVocabDetailWordId === "undefined" ? null : _pbpVocabDetailWordId,
    narrow: document.body.classList.contains("lib-narrow-detail"),
  }));
}
async function libShowVocab(page, target) {
  const got = await page.evaluate((t) => {
    if (typeof _pbpVocabRenderDetail !== "function") return "no _pbpVocabRenderDetail";
    if (t === "cover") {
      _pbpVocabRenderDetail(null);
    } else {
      const w = (typeof _vocabRows === "undefined" ? [] : _vocabRows).find((row) => row.term === t);
      if (!w) return `no saved word ${JSON.stringify(t)}`;
      _pbpVocabRenderDetail(w);
      _pbpVocabMarkCurrentRow(w.id);
      // The case must be the word it names, in the language it was saved in:
      // a CJK case that lost its lang would measure the Latin letter-spacing
      // branch and still pass.
      const head = document.querySelector("#vocab-detail .vocab-detail-term");
      const want = w.language && w.language !== "und" ? w.language : "";
      if (!head || head.textContent !== t || head.lang !== want) {
        return `headword ${JSON.stringify(head && head.textContent)} lang ${JSON.stringify(head && head.lang)}, want ${JSON.stringify(t)} lang ${JSON.stringify(want)}`;
      }
    }
    const pane = document.getElementById("vocab-detail-pane");
    if (pane) pane.scrollTop = 0;
    return "ok";
  }, target);
  if (got !== "ok") throw new Error(`SETUP: libShowVocab(${JSON.stringify(target)}): ${got} -- LIB_SEED (T2) broken or library-vocab.js renamed`);
  // From T7c an opened word looks itself up (IndexedDB probes, then the grant
  // check -- never granted here); wait until the column has settled so a scan
  // does not race the idle button in. A timeout does not fail the run (the
  // checks below still measure whatever is there), but it is said out loud:
  // a silent full-TIMEOUT_MS wait per open would be an invisible slowdown.
  await page.waitForFunction(() => {
    const host = document.getElementById("vocab-ref-result");
    return !host || host.dataset.refState !== "word" || !!host.querySelector(".xp-dict-entry, .xp-dict-msg, .xp-dict-local-box");
  }, null, { timeout: TIMEOUT_MS }).catch((err) => {
    console.warn(`[render-audit] WARN libShowVocab(${JSON.stringify(target)}): the dictionary column never settled (${err && err.name}) -- open-to-look-up stuck in "word"?`);
  });
  await settleAnimations(page);
}
async function libRestoreVocab(page, snap) {
  await page.evaluate((s) => {
    const w = s.id ? (typeof _vocabRows === "undefined" ? [] : _vocabRows).find((row) => row.id === s.id) : null;
    _pbpVocabRenderDetail(w || null);
    if (w) _pbpVocabMarkCurrentRow(w.id);
    document.body.classList.toggle("lib-narrow-detail", !!s.narrow);
  }, snap).catch(() => {});
  await settleAnimations(page);
}

// G4: ink, not the content area. A zero-width inline-block probe before the
// first character gives the baseline; canvas measureText (same font fallback
// as the DOM) gives the first line's ink ascent. Range rects are the content
// area (ascent + descent), which a correct half-leading pull-up necessarily
// lifts above the scroll box -- they would fail the right layout and still
// not see a clipped glyph.
const INK_TOP_SCAN = ({ paneSel }) => {
  const pane = document.querySelector(paneSel);
  if (!pane) return { error: `no ${paneSel}` };
  const top = pane.getBoundingClientRect().top;
  const ctx = document.createElement("canvas").getContext("2d");
  const rows = [];
  for (const el of pane.querySelectorAll(".lib-first-line")) {
    if (!el.getClientRects().length) continue;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT,
      { acceptNode: (n) => (n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
    const text = walker.nextNode();
    if (!text) continue;
    const probe = document.createElement("span");
    probe.style.cssText = "display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline";
    text.parentNode.insertBefore(probe, text);
    const baseline = probe.getBoundingClientRect().bottom;
    probe.remove();
    const range = document.createRange();
    let first = "", lineTop = null;
    for (let i = 0; i < text.length; i++) {
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const r = range.getClientRects()[0];
      if (!r) continue;
      if (lineTop === null) lineTop = r.top;
      else if (r.top > lineTop + 1) break;
      first += text.nodeValue[i];
    }
    const cs = getComputedStyle(text.parentElement);
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const ascent = ctx.measureText(first.trim()).actualBoundingBoxAscent;
    const inkTop = baseline - ascent;
    rows.push({
      el: [...el.classList].join("."), text: first.trim().slice(0, 24),
      inkTop: Math.round(inkTop * 100) / 100, paneTop: Math.round(top * 100) / 100,
      over: Math.round((top - 0.5 - inkTop) * 100) / 100,
    });
  }
  return { rows };
};
// The screenshot cross-check: the first line's band, rendered as is and with
// the pane at overflow: visible (right padding + the gutter it loses, so
// nothing rewraps). Equal bytes = nothing was clipped. null = no first line.
async function libInkScreenshotSame(page, paneSel) {
  const clip = await page.evaluate((sel) => {
    const pane = document.querySelector(sel);
    const first = pane && [...pane.querySelectorAll(".lib-first-line")].find((el) => el.getClientRects().length);
    if (!first) return null;
    const p = pane.getBoundingClientRect(), r = first.getBoundingClientRect();
    const x = Math.max(0, Math.floor(r.left - 4)), y = Math.max(0, Math.floor(p.top - 24));
    return { x, y, width: Math.max(1, Math.ceil(Math.min(r.right, p.right) - x + 4)), height: Math.max(1, Math.ceil(r.bottom - y)) };
  }, paneSel);
  if (!clip) return null;
  const normal = await page.screenshot({ clip });
  await page.evaluate((sel) => {
    const pane = document.querySelector(sel);
    const cs = getComputedStyle(pane);
    const gutter = pane.offsetWidth - pane.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    window.__libInkRestore = { overflow: pane.style.overflow, paddingRight: pane.style.paddingRight };
    pane.style.overflow = "visible";
    pane.style.paddingRight = `calc(${cs.paddingRight} + ${gutter}px)`;
  }, paneSel);
  await page.waitForTimeout(50);
  const visible = await page.screenshot({ clip });
  await page.evaluate((sel) => {
    const pane = document.querySelector(sel);
    Object.assign(pane.style, window.__libInkRestore || {});
    delete window.__libInkRestore;
  }, paneSel);
  return normal.equals(visible);
}
// One G4 driver for both detail panes. `view` picks the pane and how a case
// is put on screen; `cases` are that view's scenario names (vocab: "cover" or
// a LIB_SEED term; notes: a seeded scenario, libOpenNotesScenario). One scan,
// one driver: T8e added the `notes` entry rather than a second pair.
// `coverPx` optionally pins the cover title's size per window width, read on
// the view's cover case.
const LIB_INK_VIEWS = {
  vocab: {
    paneSel: "#vocab-detail-pane", coverCase: "cover", coverSel: "#vocab-detail-empty .lib-cover-title",
    snapshot: libSnapshotVocab, show: libShowVocab, restore: libRestoreVocab,
  },
  // T8e: the notes detail. Cases are the seeded scenarios libOpenNotesScenario
  // opens ("notes-cover", "notes-solo", "notes-multi"); the snapshot is the
  // selected highlight's key and the narrow-view class, put back by
  // libRestoreNotesSelection.
  notes: {
    paneSel: "#notes-detail-pane", coverCase: "notes-cover", coverSel: "#notes-detail-empty .lib-cover-title",
    snapshot: libSnapshotNotes, show: libOpenNotesScenario, restore: libRestoreNotesSelection,
  },
};
// `locale` (final review #10/#5): measure under that UI language in a scratch
// page of its own -- the column titles ("词典", "这一页") are UI copy, and the
// shared page stays in English for every row after this one.
async function driveDisplayInkTop(shared, check, extBase, theme) {
  const { view = "vocab", sizes, cases, coverPx = null, locale = null } = check.expect.displayInkTop;
  const v = LIB_INK_VIEWS[view];
  if (!v) throw new Error(`SETUP: displayInkTop has no view ${JSON.stringify(view)} in LIB_INK_VIEWS`);
  const paneSel = check.expect.displayInkTop.paneSel || v.paneSel;
  let page = shared;
  if (locale) {
    const [w0, h0] = sizes[0];
    page = await libScratchPage(shared, extBase, theme, `g4-${locale}`, view, { width: w0, height: h0 });
    try { await setLibraryLocale(page, extBase, locale); } catch (err) { await closeLibScratch(shared, page); throw err; }
  }
  const restore = page.viewportSize();
  const snap = locale ? null : await v.snapshot(page);
  const bad = [];
  try {
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      for (const target of cases) {
        await v.show(page, target);
        const scan = await page.evaluate(INK_TOP_SCAN, { paneSel });
        if (scan.error) throw new Error(`SETUP: displayInkTop ${scan.error}`);
        if (!scan.rows.length) throw new Error(`SETUP: displayInkTop found no visible .lib-first-line in ${paneSel} for ${target} at ${width}px`);
        for (const r of scan.rows) {
          if (r.over > 0) bad.push(`${width}/${target}: ${r.el} "${r.text}" ink top ${r.inkTop} is above the scroll box top ${r.paneTop}`);
        }
        if (coverPx && coverPx[width] != null && target === v.coverCase) {
          const px = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el && el.getClientRects().length ? parseFloat(getComputedStyle(el).fontSize) : null;
          }, v.coverSel);
          if (px !== coverPx[width]) bad.push(`${width}/${target}: cover title ${px}px, spec §4.2 / §5.7 say ${coverPx[width]}px`);
        }
        if ((await libInkScreenshotSame(page, paneSel)) === false) {
          bad.push(`${width}/${target}: the first line paints differently once ${paneSel} stops clipping (overflow: visible)`);
        }
      }
    }
  } finally {
    if (locale) {
      await closeLibScratch(shared, page);
    } else {
      if (restore) await page.setViewportSize(restore);
      await page.waitForTimeout(250);
      await v.restore(page, snap);
    }
  }
  return bad;
}

// G4b: every negative margin inside a detail pane is one of two kinds, judged
// on computed values, never on a class list. (a) Cancelling: the side's
// margin is minus the same side's padding (a hung button, the highlighter's
// overhang, the pane's own -16 / 16). (b) Pull-up: margin-top on a
// .lib-first-line element, at most its half-leading. Visually hidden 1x1
// boxes (sr-only) move nothing and are skipped.
const NEG_MARGIN_SCAN = ({ paneSels }) => {
  const bad = new Set();
  let checked = 0;
  for (const sel of paneSels) {
    const pane = document.querySelector(sel);
    if (!pane || !pane.getClientRects().length) continue;
    for (const el of [pane, ...pane.querySelectorAll("*")]) {
      if (!el.getClientRects().length || el.closest("svg")) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.position === "absolute" && r.width <= 1 && r.height <= 1) continue;
      for (const side of ["Top", "Right", "Bottom", "Left"]) {
        const m = parseFloat(cs[`margin${side}`]);
        if (!(m < 0)) continue;
        checked++;
        const p = parseFloat(cs[`padding${side}`]);
        if (Math.abs(m + p) <= 0.5) continue;
        if (side === "Top" && el.classList.contains("lib-first-line")) {
          const fs = parseFloat(cs.fontSize), lh = parseFloat(cs.lineHeight);
          if (Number.isFinite(lh) && -m <= (lh - fs) / 2 + 0.5) continue;
        }
        bad.add(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${[...el.classList].join(".")} margin-${side.toLowerCase()} ${m}px (padding ${p}px, font ${cs.fontSize}/${cs.lineHeight})`);
      }
    }
  }
  return { checked, bad: [...bad] };
};
// `view` picks the pane's driver through LIB_INK_VIEWS, the same table G4
// uses: "vocab" (LIB_SEED words) or "notes" (the seeded scenarios; final
// review #12 -- the notes half of G4b, spec §9.2, never landed with T8e).
async function driveDetailNegMargin(page, check) {
  const { view = "vocab", sizes, cases, panes, openEditor = false } = check.expect.detailNegMargin;
  const v = LIB_INK_VIEWS[view];
  if (!v) throw new Error(`SETUP: detailNegMargin has no view ${JSON.stringify(view)} in LIB_INK_VIEWS`);
  const restore = page.viewportSize();
  const snap = await v.snapshot(page);
  const bad = [];
  let checked = 0;
  try {
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      for (const target of cases) {
        await v.show(page, target);
        if (openEditor && view === "vocab" && target !== "cover") {
          await page.evaluate(() => _pbpVocabToggleGroupEditor(true, false));
          await settleAnimations(page);
        }
        const scan = await page.evaluate(NEG_MARGIN_SCAN, { paneSels: panes });
        checked += scan.checked;
        for (const b of scan.bad) bad.push(`${width}/${target}: ${b}`);
      }
    }
  } finally {
    if (restore) await page.setViewportSize(restore);
    await page.waitForTimeout(250);
    await v.restore(page, snap);
  }
  // Anti-vacuity: the pane's own -16 and the hung buttons are always there.
  if (checked === 0) throw new Error("SETUP: detailNegMargin saw no negative margin at all -- the pane's -16 / 16 offset or the hung buttons are gone, or the scan never ran");
  return bad;
}

// G5, vocabulary half: the headword tier, where the dictionary column sits,
// the hang label's right edge, the tail's distance from the note box, and
// focus rings that stay inside the pane.
const LIB_GEOMETRY_VOCAB_SCAN = () => {
  const pane = document.getElementById("vocab-detail-pane");
  const main = document.getElementById("vocab-detail");
  const ref = document.getElementById("vocab-ref");
  const tail = document.getElementById("vocab-detail-tail");
  const term = main && main.querySelector(".vocab-detail-term");
  const note = main && main.querySelector(".vocab-note-input");
  if (!pane || !main || main.hidden || !ref || !tail || !term || !note) {
    return { error: "the rich LIB_SEED word is not open (head, note box, dictionary column or tail missing)" };
  }
  const cs = getComputedStyle(pane);
  const axis = pane.getBoundingClientRect().left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
  const m = main.getBoundingClientRect(), rf = ref.getBoundingClientRect();
  const out = {
    headPx: parseFloat(getComputedStyle(term).fontSize),
    // The main column's width, read off the head (it fills column 2).
    mainPx: Math.round(main.querySelector(".vocab-detail-head").getBoundingClientRect().width * 100) / 100,
    containerPx: Math.round((pane.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) * 100) / 100,
    refBeside: rf.left >= m.right - 0.5 && Math.abs(rf.top - m.top) <= 1,
    refBelow: rf.top >= m.bottom - 0.5,
    tailGap: Math.round((tail.getBoundingClientRect().top - note.getBoundingClientRect().bottom) * 100) / 100,
    labelRight: null,
  };
  const label = main.querySelector(".vocab-sec-context > .lib-hang-label");
  if (label) {
    const range = document.createRange();
    range.selectNodeContents(label);
    out.labelRight = Math.round((range.getBoundingClientRect().right - axis) * 100) / 100;
  }
  return out;
};
async function driveLibGeometry(page, check) {
  const { cases } = check.expect.libGeometry;
  const restore = page.viewportSize();
  const snap = await libSnapshotVocab(page);
  const bad = [];
  try {
    for (const c of cases) {
      const at = `${c.width}x${c.height}`;
      await page.setViewportSize({ width: c.width, height: c.height });
      await page.waitForTimeout(250);
      await libShowVocab(page, c.term);
      const g = await page.evaluate(LIB_GEOMETRY_VOCAB_SCAN);
      if (g.error) throw new Error(`SETUP: libGeometry ${at}: ${g.error}`);
      if (Math.abs(g.headPx - c.headPx) > 0.5) bad.push(`${at}: headword ${g.headPx}px, want ${c.headPx}`);
      // A case names the tier it means by its container width, not only its
      // window (diag-hang-order §4: G5's "1280" case had silently been in
      // the narrow tier): the measured C must fall inside the stated range.
      if (c.containerPx && !(g.containerPx >= c.containerPx[0] && g.containerPx < c.containerPx[1])) {
        throw new Error(`SETUP: libGeometry ${at}: the detail's container width is ${g.containerPx}, outside the case's tier [${c.containerPx.join(", ")})`);
      }
      if (c.mainPx != null && Math.abs(g.mainPx - c.mainPx) > 0.5) bad.push(`${at}: main column ${g.mainPx}px wide, want ${c.mainPx}`);
      if (c.ref === "beside" && !g.refBeside) bad.push(`${at}: #vocab-ref is not beside the main column on its first row`);
      if (c.ref === "below" && !g.refBelow) bad.push(`${at}: #vocab-ref is not below the main column`);
      if (c.labelRightFromAxis != null && (g.labelRight == null || Math.abs(g.labelRight - c.labelRightFromAxis) > 1)) {
        bad.push(`${at}: the context label ends ${g.labelRight}px right of the axis, want ${c.labelRightFromAxis}`);
      }
      if (c.tailGap != null && Math.abs(g.tailGap - c.tailGap) > 1) bad.push(`${at}: tail top - note box bottom = ${g.tailGap}, want ${c.tailGap}`);
      for (const sel of c.ringInside || []) {
        await page.keyboard.press("Shift"); // a keyboard modality, so .focus() matches :focus-visible
        const ring = await page.evaluate((s) => {
          const el = document.querySelector(s);
          const pane = document.getElementById("vocab-detail-pane");
          if (!el || !pane) return { error: `no ${s}` };
          el.focus();
          if (document.activeElement !== el) return { error: `${s} did not take focus` };
          const shadow = getComputedStyle(el).boxShadow;
          let extent = 0;
          for (const mm of shadow.matchAll(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+(-?[\d.]+)px)?/g)) {
            extent = Math.max(extent, Math.abs(parseFloat(mm[1])) + parseFloat(mm[3]) + parseFloat(mm[4] || "0"));
          }
          const r = el.getBoundingClientRect(), p = pane.getBoundingClientRect();
          return { outer: r.left - extent, paneLeft: p.left, visible: el.matches(":focus-visible"), shadow };
        }, sel);
        await page.evaluate(() => document.activeElement?.blur?.());
        if (ring.error) throw new Error(`SETUP: libGeometry ${at}: ${ring.error}`);
        if (!ring.visible) throw new Error(`SETUP: libGeometry ${at}: ${sel} took focus without :focus-visible (box-shadow ${ring.shadow})`);
        if (ring.outer < ring.paneLeft - 0.5) bad.push(`${at}: ${sel}'s focus ring reaches ${ring.outer.toFixed(1)}, left of the detail pane ${ring.paneLeft.toFixed(1)}`);
      }
    }
  } finally {
    if (restore) await page.setViewportSize(restore);
    await page.waitForTimeout(250);
    await libRestoreVocab(page, snap);
  }
  return bad;
}


// ---- state: "hangOrder" (library redesign T8f; diag-hang-order.md §6) -----
// Every hang label in a detail pane sits ABOVE its content, or LEFT of it with
// its first line on the content's first line -- never below, right of or over
// it, and never out of the pane. The 10-05 bug (an excerpt label stacked by a
// measurement that no longer held) lived one frame after a width change, or
// for good when only the index column moved; G4 / G5 / paneFit sampled fixed
// windows at rest and could not see it. So this samples by the CONTAINER
// width C: around every tier breakpoint at 1px steps (bp - 3 .. bp + 3), each
// point entered from 200px above and from 200px below, measured in the same
// task as the width change ("early") and again after the page's observers have
// run ("settled"), plus a coarse 8px pass. Two drivers move C: the index column
// (--lib-index-w at a fixed window: no resize event, the path the 10-05 report
// took) and the window itself. Pairs are read from the DOM (a label and the
// visible siblings after it), positions from text ink (Range rects), so a
// label's own padding never counts and a stacked label's later lines may hang.
//
// The in-page half: one batch of points per call, no round trip per point.
const HANG_ORDER_PAGE = async ({ paneSel, mainSel, exempt, points, base, driver, counter, minLabels = 0 }) => {
  const pane = document.querySelector(paneSel);
  if (!pane) return { error: `no ${paneSel}` };
  const html = document.documentElement;
  const round = (n) => Math.round(n * 100) / 100;
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].map((c) => `.${c}`).join("")} "${(el.textContent || "").trim().slice(0, 24)}"`;
  const textRects = (els) => {
    const out = [];
    for (const el of els) {
      const range = document.createRange();
      range.selectNodeContents(el);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) out.push(r);
    }
    return out;
  };
  const union = (rects) => rects.length ? {
    l: Math.min(...rects.map((r) => r.left)), t: Math.min(...rects.map((r) => r.top)),
    r: Math.max(...rects.map((r) => r.right)), b: Math.max(...rects.map((r) => r.bottom)),
  } : null;
  const contentWidth = () => {
    const cs = getComputedStyle(pane);
    // Border box minus borders + scrollbar gutter (offsetWidth - clientWidth)
    // minus padding: the inline size @container lib-detail resolves against.
    return pane.getBoundingClientRect().width - (pane.offsetWidth - pane.clientWidth) -
      parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  };
  // One scan: every visible label against the union of the visible siblings
  // after it. Returns the failures and the SETUP problems only.
  const scan = () => {
    const bad = [];
    const setup = [];
    const pr = pane.getBoundingClientRect();
    const paneLeft = pr.left + pane.clientLeft, paneRight = paneLeft + pane.clientWidth;
    const labels = [...pane.querySelectorAll(".lib-hang-label, .notes-excerpt-label")].filter(visible);
    const labelSet = new Set(labels);
    for (const label of labels) {
      const after = [];
      for (let s = label.nextElementSibling; s; s = s.nextElementSibling) if (visible(s)) after.push(s);
      if (!after.length) { setup.push(`${describe(label)} has no visible content after it`); continue; }
      const L = union(textRects([label]));
      if (!L) { setup.push(`${describe(label)} has no text ink`); continue; }
      const B = union(after.map((el) => el.getBoundingClientRect()));
      // b1: the content's first line -- the tallest text rect on its top row,
      // or its line-height when the content has no text of its own.
      const ink = textRects(after);
      const top = ink.length ? Math.min(...ink.map((r) => r.top)) : null;
      const b1 = ink.length ? Math.max(...ink.filter((r) => r.top < top + 1).map((r) => r.height))
        : (parseFloat(getComputedStyle(after[0]).lineHeight) || after[0].getBoundingClientRect().height);
      let rel;
      if (L.b <= B.t + 0.5) rel = "above";
      else if (L.r <= B.l + 0.5) rel = L.t >= B.t - b1 && L.t < B.t + b1 ? "left" : L.t >= B.t + b1 ? "below" : "misaligned";
      else {
        const ix = Math.max(0, Math.min(L.r, B.r) - Math.max(L.l, B.l));
        const iy = Math.max(0, Math.min(L.b, B.b) - Math.max(L.t, B.t));
        rel = ix * iy > 0.25 ? "overlap" : L.t >= B.b - 0.5 ? "below" : L.l >= B.r - 0.5 ? "right" : "overlap";
      }
      const name = `${describe(label)}${label.classList.contains("is-stacked") ? " [stacked]" : ""}`;
      if (rel !== "above" && rel !== "left") {
        bad.push({ rel, name, label: [round(L.l), round(L.t), round(L.r), round(L.b)], content: [round(B.l), round(B.t), round(B.r), round(B.b)] });
      }
      if (L.l < paneLeft - 0.5 || L.r > paneRight + 0.5) {
        bad.push({ rel: "outside", name, label: [round(L.l), round(L.t), round(L.r), round(L.b)], content: [round(paneLeft), 0, round(paneRight), 0] });
      }
    }
    // Completeness: every visible heading or *-label in the pane is either a
    // hang label measured above or a named exemption -- a new label class
    // must join one of the two, never slip past both.
    for (const el of pane.querySelectorAll('h2, h3, [class*="-label"]')) {
      if (labelSet.has(el) || !visible(el) || exempt.some((sel) => el.matches(sel))) continue;
      setup.push(`unpaired heading / label ${describe(el)} (pair it as a hang label or exempt it in HANG_ORDER_EXEMPT)`);
    }
    if (labels.length < minLabels) setup.push(`only ${labels.length} hang label(s) visible, the scenario declares at least ${minLabels} -- it rendered less than it names`);
    return { bad, setup, labels: labels.length };
  };
  // The main column's width (the word's head / the notes head fill it): read
  // with every scan, so the Node side can require it never shrinks as C grows.
  const mainWidth = () => {
    const el = [...pane.querySelectorAll(mainSel)].find(visible);
    return el ? round(el.getBoundingClientRect().width) : null;
  };
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))));
  if (driver === "probe") return { C: round(contentWidth()), main: mainWidth(), ...scan() };
  if (driver === "settle") { await settle(); return { C: round(contentWidth()), main: mainWidth(), ...scan() }; }
  if (driver === "counter") {
    // Anti-vacuity (diag §6.4): put a known-bad layout on screen and require
    // the scan to name it. "stacked-narrow" is the 10-05 defect itself -- the
    // stacked declarations on a label above its quote; "label-after" moves
    // the dictionary label into a grid row after its lookup row and result.
    const target = counter === "stacked-narrow"
      ? pane.querySelector(".notes-excerpt > .notes-excerpt-label")
      : pane.querySelector(".vocab-ref > .lib-hang-label");
    if (!target) return { error: `counter-example ${counter}: no target label` };
    const saved = target.getAttribute("style");
    target.style.cssText = counter === "stacked-narrow"
      ? "flex-direction: column; flex-wrap: nowrap; align-items: flex-end; height: var(--lib-lh-meta); white-space: normal"
      : "grid-row: 3; grid-column: 2";
    const r = scan();
    if (saved === null) target.removeAttribute("style"); else target.setAttribute("style", saved);
    return { C: round(contentWidth()), ...r, target: describe(target) };
  }
  const setC = (c) => html.style.setProperty("--lib-index-w", `${base.L0 + base.C0 - c}px`);
  const out = { measured: 0, problems: [], labels: 0, mono: [] };
  const record = (pt, phase) => {
    const C = contentWidth();
    const r = scan();
    out.mono.push([round(C), mainWidth()]);
    out.measured++;
    out.labels = Math.max(out.labels, r.labels);
    const drift = Math.abs(C - pt.c) > 0.5;
    if (r.bad.length || r.setup.length || drift) {
      out.problems.push({ c: pt.c, from: pt.from ?? null, phase, C: round(C), bad: r.bad, setup: r.setup, drift });
    }
  };
  for (const pt of points) {
    if (pt.from != null) { setC(pt.from); await settle(); }
    setC(pt.c);
    record(pt, "early");
    if (pt.earlyOnly) continue;
    await settle();
    record(pt, "settled");
  }
  return out;
};

// Headings that are not hang labels, with why. Matched in the page.
const HANG_ORDER_EXEMPT = Object.freeze([
  { selector: ".vocab-detail-term", why: "the word sheet's own title (h2): the head of the column, nothing hangs from it" },
  { selector: ".notes-detail-source", why: "the notes sheet's own title (h2): the head of the column" },
  { selector: ".lib-cover-title", why: "either cover's display title: the cover has no hang column" },
  { selector: ".xp-dict-rel-label", why: "md-dict's run-in label (\"Synonyms:\") inside the very line it names" },
]);

// Breakpoints per view: the @container lib-detail tiers that move a label.
const HANG_ORDER_BREAKPOINTS = Object.freeze({ vocab: [640, 1000, 1464], notes: [1000, 1312] });
const HANG_ORDER_LOCALES = Object.freeze(["en", "zh_CN", "de"]);

// Scenarios: each puts one state of the view's detail on screen (Node side).
// HANG_ORDER_MIN_LABELS is how many hang labels each one shows at the very
// least (at any width): a scan that sees fewer is a SETUP, never a pass over
// a scenario that rendered less than it names.
const HANG_ORDER_DAYS_KEY = "pbp_hl_render-audit-hang-days";
const HANG_ORDER_SCENARIOS = {
  vocab: {
    constraint: (p) => libShowVocab(p, "constraint"),
    "曖昧": (p) => libShowVocab(p, "曖昧"),
    cover: (p) => libShowVocab(p, "cover"),
    lookup: async (p) => {
      await libShowVocab(p, "constraint");
      await p.evaluate(() => _pbpVocabLookupOther("serendipity", "en"));
      await p.waitForSelector("#vocab-ref-result .vocab-ref-head", { timeout: TIMEOUT_MS });
      await settleAnimations(p);
    },
    editor: async (p) => {
      await libShowVocab(p, "constraint");
      await p.evaluate(() => _pbpVocabToggleGroupEditor(true, false));
      await settleAnimations(p);
    },
  },
  notes: {
    // The seeded several-highlight page, opened at its second highlight.
    multi: async (p) => {
      const got = await p.evaluate((url) => {
        const e = _notesAllRows.find((x) => x.row.url === url);
        if (!e) return `no notes row for ${url}`;
        const hits = _pbpNotesPageHits(e.row.key);
        if (hits.length < 3) return `${hits.length} highlights`;
        _pbpNotesRenderDetail(hits[1], false);
        return "ok";
      }, LIB_SEED.multiUrl);
      if (got !== "ok") throw new Error(`SETUP: hangOrder notes multi: ${got} -- LIB_SEED broken`);
      await settleAnimations(p);
    },
    // A page read over several days: its older labels carry the day too, so
    // they are wider than the hang column and stack. Built in this scratch
    // page only, through the page's own row model (pbpNotesRow), never written
    // to storage: the shared page and every other check keep LIB_SEED as is.
    days: async (p) => {
      const got = await p.evaluate((key) => {
        const now = Date.now(), minute = 60000, day = 86400000;
        const rec = { url: "https://example.com/reading/days", title: "A page read over several days", items: [
          { id: "d1", ts: now - 3 * day, quote: "An older highlight on another day carries its day in the label.", note: "", color: 4 },
          { id: "d2", ts: now - 2 * day, quote: "So does this one, which makes the label wider than the hang column.", note: "With a note.", color: 2 },
          { id: "d3", ts: now - 10 * minute, quote: "The newest one is the page's own day.", note: "", color: 1 },
        ] };
        _notesAllRows = _notesAllRows.filter((e) => e.row.key !== key);
        _notesAllRows.push({ row: pbpNotesRow(key, rec), rec });
        const hits = _pbpNotesPageHits(key);
        _pbpNotesRenderDetail(hits[1], false);
        return [...document.querySelectorAll("#notes-detail .notes-excerpt-date")].length;
      }, HANG_ORDER_DAYS_KEY);
      if (got < 2) throw new Error(`SETUP: hangOrder notes days: ${got} dated labels, want 2`);
      await settleAnimations(p);
    },
  },
};

const HANG_ORDER_MIN_LABELS = Object.freeze({
  // context, my note, Dictionary; the cover keeps only the Dictionary label
  vocab: { constraint: 3, "曖昧": 3, cover: 1, lookup: 3, editor: 3 },
  // one per excerpt (the "this page" title only from its tier on)
  notes: { days: 3, multi: 4 },
});
const HANG_ORDER_VIEWS = {
  vocab: { paneSel: "#vocab-detail-pane", tab: null,
    mainSel: "#vocab-detail:not([hidden]) > .vocab-detail-head, #vocab-detail-empty:not([hidden]) > .lib-cover-title" },
  notes: { paneSel: "#notes-detail-pane", tab: "#lib-tab-notes", mainSel: "#notes-detail:not([hidden]) > .notes-detail-head" },
};
// The product's container widths: a 861px window gives C ~ 395, a 2560px one
// 1873. The coarse pass stays inside them.
const HANG_ORDER_C_RANGE = Object.freeze([400, 1880]);

// The matrix is a cross, not a full product. The primary (first) scenario
// runs in every locale and both densities; every other scenario runs in en
// and the theme's own density (default comfortable, terminal compact). Each
// of those runs the 1px pass at every breakpoint (both directions, both
// phases) and the coarse early pass; the primary scenario in en and the
// theme's own density also runs the coarse settled pass and the window
// driver. A settled read costs two frames and the pages cannot share a frame
// clock (parallel scratch windows starved the oldest one ~10x on the
// software compositor, measured in T8f), so the full product -- 30
// vocabulary combinations x every pass -- would cost minutes per theme for
// combinations that differ only in label text. The two extra passes of the
// primary combination run on the checklist's fullThemes (default) alone;
// see driveHangOrder's first lines.
async function driveHangOrder(page, extBase, theme, check) {
  const { view, scenarios, indexWindows, coarseStep = 8, fine = 3, jump = 200, viewportRange = [861, 2560], fullThemes = [""] } = check.expect.hangOrder;
  // The window driver and the coarse settled pass run only on fullThemes
  // (default): every other theme keeps the index driver's 1px passes in both
  // directions and both phases, the coarse early pass, the main-column
  // monotonic rule, the counter-examples and the label minimums. Theme
  // changes only the density tier and the type metrics those already cover;
  // the two extra passes doubled the gate's cost in a 4-shard verify.
  const fullTheme = fullThemes.includes(theme);
  const v = HANG_ORDER_VIEWS[view];
  if (!v) throw new Error(`SETUP: hangOrder has no view ${JSON.stringify(view)}`);
  for (const name of scenarios) {
    if (!HANG_ORDER_SCENARIOS[view][name]) throw new Error(`SETUP: hangOrder has no ${view} scenario ${JSON.stringify(name)}`);
  }
  const bps = HANG_ORDER_BREAKPOINTS[view];
  const primary = scenarios[0];
  const seen = new Map(); // the first instance of each failure class
  const stats = { measured: 0, labels: 0, ms: 0 };
  const t0 = Date.now();
  const themeTag = theme || "default";
  const note = (key, line) => { if (!seen.has(key)) seen.set(key, line); };
  const noteBad = (b, at, phase, drv) => note(`${b.rel}|${b.name.replace(/"[^"]*"/, "")}|${phase}|${drv}`,
    `${at} ${phase}: ${b.name} is ${b.rel} its content (label ${b.label.join(",")} vs ${b.content.join(",")})`);
  const p = await libScratchPage(page, extBase, theme, `hang-${view}`, "vocab", { width: indexWindows[0], height: 900 });
  const run = async (args, tag) => {
    const res = await p.evaluate(HANG_ORDER_PAGE, { paneSel: v.paneSel, mainSel: v.mainSel, exempt: HANG_ORDER_EXEMPT.map((e) => e.selector), ...args });
    if (res.error) throw new Error(`SETUP: hangOrder ${tag}: ${res.error}`);
    return res;
  };
  const one = (res, at, phase, mono) => {
    stats.measured++;
    stats.labels = Math.max(stats.labels, res.labels);
    if (res.setup.length) throw new Error(`SETUP: hangOrder ${at} ${phase}: ${res.setup[0]}`);
    for (const b of res.bad) noteBad(b, at, phase, "window");
    mono.push([res.C, res.main]);
  };
  // "Main column first" as a class rule (T8f fix round 1): over every reading
  // of one combination, sorted by C, the main column's width never shrinks
  // as C grows -- a column that joins beside it must take only what it leaves.
  const checkMonotonic = (pairs, combo) => {
    const rows = pairs.filter(([, w]) => w != null).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (rows.length < 2) throw new Error(`SETUP: hangOrder ${combo}: ${rows.length} main column reading(s) -- ${v.mainSel} not on screen`);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][1] < rows[i - 1][1] - 0.5) {
        note(`mono|${view}`, `${combo}: the main column narrows from ${rows[i - 1][1]} at C=${rows[i - 1][0]} to ${rows[i][1]} at C=${rows[i][0]} as C grows`);
        return;
      }
    }
  };
  const setIndex = (px) => p.evaluate((w) => {
    if (w == null) document.documentElement.style.removeProperty("--lib-index-w");
    else document.documentElement.style.setProperty("--lib-index-w", `${w}px`);
  }, px);
  try {
    if (v.tab) {
      await p.click(v.tab);
      await p.waitForSelector("#notes-list .notes-hit", { timeout: TIMEOUT_MS });
      await settleAnimations(p);
    }
    // C(W) for the window driver. The pane's scrollbar gutter is stable, so C
    // does not depend on what the pane shows: bisected once per target, and
    // every W whose C lands in [bp - fine, bp + fine] is kept. C(W) is
    // piecewise (L is clamped below a 1800 window and P / G step at 1280 and
    // 1920), so the far windows are bisected for C = bp +- jump too rather
    // than taken as a fixed W offset.
    const cAt = async (w) => {
      await p.setViewportSize({ width: w, height: 900 });
      return (await run({ driver: "settle" }, `window@${w}`)).C;
    };
    const firstW = async (target) => {
      let lo = viewportRange[0], hi = viewportRange[1];
      if ((await cAt(hi)) < target) return hi;
      if ((await cAt(lo)) >= target) return lo;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if ((await cAt(mid)) >= target) hi = mid; else lo = mid;
      }
      return hi;
    };
    const windowPlan = [];
    for (const bp of fullTheme ? bps : []) {
      if ((await cAt(viewportRange[1])) < bp || (await cAt(viewportRange[0])) >= bp) continue;
      const hi = await firstW(bp);
      const ws = [];
      for (let w = hi - 8; w <= hi + 8; w++) {
        const c = await cAt(w);
        if (c >= bp - fine - 0.5 && c <= bp + fine + 0.5) ws.push({ w, c });
      }
      windowPlan.push({ bp, ws, from: [await firstW(bp + jump), await firstW(bp - jump)] });
    }
    if (fullTheme && windowPlan.length !== bps.length) {
      throw new Error(`SETUP: hangOrder ${view}: only ${windowPlan.map((x) => x.bp).join("/") || "none"} of the breakpoints ${bps.join("/")} lie between windows ${viewportRange.join(" and ")}`);
    }

    // Anti-vacuity (diag §6.4): both known-bad layouts must be named before
    // any sweep is trusted -- the primary scenario, in the density the theme
    // loaded with.
    {
      await p.setViewportSize({ width: indexWindows[0], height: 900 });
      await setIndex(400);
      await HANG_ORDER_SCENARIOS[view][primary](p);
      const C0 = (await run({ driver: "settle" }, "counter")).C;
      await setIndex(400 + C0 - (view === "notes" ? 800 : 1100));
      await run({ driver: "settle" }, "counter");
      const counter = view === "notes" ? "stacked-narrow" : "label-after";
      const want = view === "notes" ? "overlap" : "below";
      const res = await run({ driver: "counter", counter }, `counter ${counter}`);
      if (!res.bad.some((b) => b.rel === want)) {
        throw new Error(`SETUP: hangOrder's counter-example ${counter} at C=${res.C} (${res.target}) was not reported as ${want}: ${JSON.stringify(res.bad)}`);
      }
      // The same defect through the DRIVER (notes: the only view a JS
      // measurement styles): the 10-05 rule put back at the top level, the
      // labels stacked inside the hang tier (its edge + `jump`, a width within
      // the tier -- below the next, "this page" breakpoint, guarded here),
      // then one pixel below the hang tier's edge entered with no frame
      // between -- the index driver's early read must see the overlap before
      // the page re-measures. If it does not, "early" no longer precedes the
      // page's own measurement and every early read below would be a settled
      // one.
      if (view === "notes") {
        const [hangEdge, sideEdge] = HANG_ORDER_BREAKPOINTS.notes;
        if (!(hangEdge + jump < sideEdge)) {
          throw new Error(`SETUP: hangOrder's driver counter-example starts at C ${hangEdge + jump} (hang edge ${hangEdge} + jump ${jump}), not inside the hang tier [${hangEdge}, ${sideEdge})`);
        }
        await p.evaluate(() => {
          const style = document.createElement("style");
          style.id = "hang-order-counter";
          style.textContent = ".notes-excerpt-label.is-stacked { flex-direction: column; flex-wrap: nowrap; justify-content: flex-start; align-items: flex-end; row-gap: 0; height: var(--lib-lh-meta); white-space: normal; }";
          document.head.appendChild(style);
        });
        let caught;
        try {
          caught = await run({ driver: "index", base: { L0: 400, C0 }, points: [{ c: hangEdge - 1, from: hangEdge + jump, earlyOnly: true }] }, "counter driver");
        } finally {
          await p.evaluate(() => document.getElementById("hang-order-counter")?.remove());
        }
        if (!caught.problems.some((pb) => pb.phase === "early" && pb.bad.some((b) => b.rel === "overlap"))) {
          throw new Error(`SETUP: hangOrder's driver counter-example (the 10-05 rule at the top level, stacked inside the hang tier at C ${hangEdge + jump}, then C ${hangEdge - 1} just below its ${hangEdge} edge in one task) was not reported as overlap in the early read: ${JSON.stringify(caught.problems).slice(0, 400)}`);
        }
        await run({ driver: "settle" }, "counter driver");
      }
      await setIndex(null);
    }

    // The theme's own tier (options-theme-early.js wrote it before load):
    // default is comfortable, terminal compact.
    const ownDensity = await p.evaluate(() => (document.documentElement.getAttribute("data-density") === "compact" ? "compact" : "comfortable"));
    for (const density of ["comfortable", "compact"]) {
      await p.evaluate((d) => {
        if (d === "compact") document.documentElement.setAttribute("data-density", "compact");
        else document.documentElement.removeAttribute("data-density");
      }, density);
      for (const locale of HANG_ORDER_LOCALES) {
        await setLibraryLocale(p, extBase, locale);
        const own = density === ownDensity && locale === HANG_ORDER_LOCALES[0];
        for (const name of own ? scenarios : [primary]) {
          const show = HANG_ORDER_SCENARIOS[view][name];
          const full = fullTheme && own && name === primary;
          const combo = `${themeTag} ${density} ${locale} ${name}`;
          const minLabels = HANG_ORDER_MIN_LABELS[view][name] ?? 0;
          const mono = [];
          // Index driver: one in-page batch per window. Each breakpoint's
          // 1px pass runs in the first window that reaches bp +- (fine +
          // jump); the coarse pass runs in the last (widest) window, which
          // reaches the whole product range.
          const fined = new Set();
          await show(p); // once: a width change re-lays the same detail out, it never re-renders it
          for (const [wi, W] of indexWindows.entries()) {
            await p.setViewportSize({ width: W, height: 900 });
            await setIndex(400);
            const C0 = (await run({ driver: "settle" }, `index@${W} ${combo}`)).C;
            // The index stays within [200, W - 300] px.
            const cMax = C0 + 200, cMin = C0 + 400 - (W - 300);
            const points = [];
            for (const bp of bps) {
              if (fined.has(bp) || bp - fine - jump < cMin || bp + fine + jump > cMax) continue;
              fined.add(bp);
              for (const from of [bp + jump, bp - jump]) for (let c = bp - fine; c <= bp + fine; c++) points.push({ c, from });
            }
            if (wi === indexWindows.length - 1) {
              const lo = Math.max(cMin, HANG_ORDER_C_RANGE[0]), hi = Math.min(cMax, HANG_ORDER_C_RANGE[1]);
              for (let c = Math.floor(hi / coarseStep) * coarseStep; c >= lo; c -= coarseStep) points.push({ c, earlyOnly: !full });
            }
            const tag = `index@${W} ${combo}`;
            const res = await run({ driver: "index", base: { L0: 400, C0 }, points, minLabels }, tag);
            mono.push(...res.mono);
            stats.measured += res.measured;
            stats.labels = Math.max(stats.labels, res.labels);
            for (const pb of res.problems) {
              const at = `${tag} C=${pb.c}${pb.from != null ? ` (from ${pb.from})` : ""}`;
              if (pb.setup.length) throw new Error(`SETUP: hangOrder ${at} ${pb.phase}: ${pb.setup[0]}`);
              if (pb.drift) note(`drift|index@${W}`, `${at} ${pb.phase}: measured C=${pb.C}, the driver set ${pb.c}`);
              for (const b of pb.bad) noteBad(b, at, pb.phase, "index");
            }
            await setIndex(null);
          }
          const missed = bps.filter((bp) => !fined.has(bp));
          if (missed.length) throw new Error(`SETUP: hangOrder ${combo}: no index window reaches breakpoint ${missed.join("/")} +- ${fine + jump}`);
          if (!full) { checkMonotonic(mono, combo); continue; }
          // Window driver: each W near each breakpoint, entered from the
          // window whose C is 200 above and the one 200 below, once that one
          // settled. Its "early" read is the first evaluate after
          // setViewportSize returns -- a later task than the resize, so it
          // is not guaranteed to precede the page's re-measure (that
          // guarantee is the index driver's, and the driver counter-example
          // above holds it); this driver adds the resize-event path.
          for (const plan of windowPlan) {
            for (const fromW of plan.from) {
              for (const { w, c } of plan.ws) {
                await p.setViewportSize({ width: fromW, height: 900 });
                await run({ driver: "settle" }, `window@${fromW}`);
                await p.setViewportSize({ width: w, height: 900 });
                const at = `window@${w} ${combo} C=${c} (from window ${fromW})`;
                const early = await run({ driver: "probe", minLabels }, at);
                if (Math.abs(early.C - c) > 0.5) note("drift|window", `${at}: measured C=${early.C}`);
                one(early, at, "early", mono);
                one(await run({ driver: "settle", minLabels }, at), at, "settled", mono);
              }
            }
          }
          checkMonotonic(mono, combo);
        }
      }
    }
  } finally {
    await closeLibScratch(page, p);
  }
  stats.ms = Date.now() - t0;
  return { bad: [...seen.values()], stats };
}

// ---- Library layout states (library redesign 2026-10-03, plan T3) ---------
// Each runs in a FRESH page of the same context (same extension origin, same
// theme already written to storage) so its viewport, hash and scroll churn
// never leak into the shared page every other library check reads, and
// closes it again before returning.
async function openLibraryView(p, extBase, theme, view, tag) {
  await p.goto(`${extBase}library.html?_ra=${encodeURIComponent(`${tag}-${theme}`)}#${view}`, { waitUntil: "load", timeout: TIMEOUT_MS });
  const rowSel = view === "notes" ? "#notes-list .notes-hit-btn" : "#vocab-list .vocab-card .notes-card-head";
  await p.waitForSelector(rowSel, { timeout: TIMEOUT_MS }).catch(() => {});
  await p.waitForTimeout(300);
  if (!(await p.locator(rowSel).count())) {
    throw new Error(`SETUP: no "${rowSel}" in a fresh ${view} page (theme=${theme}) -- seed fixture broken or markup renamed`);
  }
  return rowSel;
}

// ---- state: "noPageScroll" (spec §9.2 G1) ----------------------------------
// Runs INSIDE the page. `overflowing` counts visible scroll containers whose
// content really is taller than they are: without one, "the page did not
// scroll" cannot be told from "there was nothing to scroll".
const NO_PAGE_SCROLL_SCAN = ({ tolerance }) => {
  const out = [];
  const doc = document.scrollingElement || document.documentElement;
  if (doc.scrollHeight > innerHeight + tolerance) out.push(`page scrollHeight ${doc.scrollHeight} > innerHeight ${innerHeight}`);
  if (doc.scrollWidth > innerWidth + tolerance) out.push(`page scrollWidth ${doc.scrollWidth} > innerWidth ${innerWidth}`);
  let overflowing = 0;
  const dims = [];
  for (const sel of [".vocab-list-region", "#vocab-detail-pane", ".notes-list-region", "#notes-detail-pane"]) {
    const el = document.querySelector(sel);
    if (!el || !el.getClientRects().length) continue; // other tab, or the hidden half of the narrow view
    dims.push(`${sel} ${el.scrollHeight}/${el.clientHeight}`);
    if (el.scrollWidth > el.clientWidth + tolerance) out.push(`${sel} scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
    if (el.scrollHeight > el.clientHeight + tolerance) overflowing++;
  }
  return { out, overflowing, dims };
};

async function driveNoPageScroll(page, check, extBase, theme) {
  const { widths, height = 900, tolerancePx = 1 } = check.expect.noPageScroll;
  const hits = [];
  const p = await page.context().newPage();
  try {
    for (const view of ["vocab", "notes"]) {
      for (const detailOpen of [false, true]) {
        await p.setViewportSize({ width: Math.max(...widths), height });
        const rowSel = await openLibraryView(p, extBase, theme, view, "g1");
        if (detailOpen) {
          // Opened at the widest width: an ordinary two-pane click. Below 860
          // the narrow body class is then set by hand -- the state a user gets
          // by clicking a row at that width.
          await p.locator(rowSel).first().click();
          await p.waitForTimeout(250);
          const open = await p.evaluate((v) => !document.getElementById(v === "notes" ? "notes-detail" : "vocab-detail").hidden, view);
          if (!open) throw new Error(`SETUP: clicking the first ${view} row did not open its detail (theme=${theme})`);
        }
        for (const width of widths) {
          await p.setViewportSize({ width, height });
          await p.evaluate(({ v, on }) => {
            document.body.classList.toggle(v === "notes" ? "lib-narrow-notes" : "lib-narrow-detail", on);
          }, { v: view, on: detailOpen && width <= 860 });
          await p.waitForTimeout(150);
          const { out, overflowing, dims } = await p.evaluate(NO_PAGE_SCROLL_SCAN, { tolerance: tolerancePx });
          const listShown = !(detailOpen && width <= 860);
          if (listShown && !overflowing) {
            throw new Error(`SETUP: no scroll container overflows at ${width}x${height} (${view}, detail ${detailOpen ? "open" : "closed"}, theme=${theme}; scrollHeight/clientHeight: ${dims.join(", ")}) -- the seed is too small for this probe`);
          }
          for (const line of out) hits.push(`${line} at ${width}x${height} (${view}, detail ${detailOpen ? "open" : "closed"})`);
        }
      }
    }
    // Narrow round trip (spec §2.6, §12 T3): list -> detail -> back keeps the
    // list where it was. The list pane is display:none while the detail is
    // up, and its region must come back at the same scrollTop.
    for (const view of ["vocab", "notes"]) {
      await p.setViewportSize({ width: 420, height });
      await openLibraryView(p, extBase, theme, view, "g1-back");
      const regionSel = view === "notes" ? ".notes-list-region" : ".vocab-list-region";
      const rowSel = view === "notes" ? ".notes-hit-btn" : ".vocab-card .notes-card-head";
      const backSel = view === "notes" ? "#notes-detail .notes-detail-back" : "#vocab-detail-back";
      const target = await p.evaluate(({ regionSel, rowSel }) => {
        const region = document.querySelector(regionSel);
        region.scrollTop = 120;
        const box = region.getBoundingClientRect();
        // The first row reaching past the region's middle, clicked at its own
        // centre. The raw centre pixel can land on the few px between a row's
        // fill and its card edge whenever the header height shifts the rows
        // (T4b: the three-row list header put it exactly on a card's top
        // inset) -- a coincidence of geometry, not a defect of the round trip.
        const mid = box.top + box.height / 2;
        const head = [...region.querySelectorAll(rowSel)].find((el) => {
          const r = el.getBoundingClientRect();
          return r.bottom > mid && r.top >= box.top && r.bottom <= box.bottom;
        });
        const hr = head ? head.getBoundingClientRect() : null;
        const x = hr ? hr.left + hr.width / 2 : box.left + box.width / 2;
        const y = hr ? hr.top + hr.height / 2 : mid;
        const under = document.elementFromPoint(x, y);
        return { top: region.scrollTop, x, y, onRow: !!(under && under.closest(rowSel)) };
      }, { regionSel, rowSel });
      if (target.top !== 120 || !target.onRow) {
        throw new Error(`SETUP: the 420px ${view} list could not be scrolled to 120 with a row under its centre (scrollTop ${target.top}, row ${target.onRow}, theme=${theme})`);
      }
      await p.mouse.click(target.x, target.y);
      await p.waitForTimeout(250);
      if (!(await p.locator(backSel).isVisible())) throw new Error(`SETUP: no visible ${backSel} after opening a ${view} row at 420px (theme=${theme})`);
      await p.click(backSel);
      await p.waitForTimeout(250);
      const after = await p.evaluate((sel) => document.querySelector(sel).scrollTop, regionSel);
      if (after !== 120) hits.push(`narrow ${view}: the list region is at scrollTop ${after} after list -> detail -> back (was 120)`);
    }
  } finally {
    await p.close().catch(() => {});
    await page.bringToFront().catch(() => {});
  }
  return hits;
}

// ---- state: "filterScrollReset" (spec §9.2 G6) ------------------------------
// Each user input from spec §2.5 #1 puts its list region back at the top.
// Every input gets a freshly loaded view, the region is parked at
// probeOffset first, and after the input the list must still be able to
// scroll at least that far -- otherwise a filter that merely SHORTENED the
// list would clamp scrollTop to 0 and pass for a reset. T4 drives the status
// and colour toggles in its own state (filterScrollResetToggles); T6 turns
// "group" into a real listbox pick and adds "sort".
const FILTER_SCROLL_INPUTS = {
  search: { view: "vocab", act: async (p) => { await p.fill("#vocab-search", "e"); return true; } },
  group: {
    view: "vocab",
    // A real pick through the enhanced listbox (library redesign T6), the
    // way a user changes the group; index 1 = the first real group, "Reading"
    // (T2 seeds 19 words into it, enough to keep the list scrolling). ctx
    // carries the theme and the rows array the nested-popover row
    // (filterSetSurvivesPick) lands in.
    act: async (p, ctx) => {
      await libPickListboxOption(p, ctx.rows, ctx.theme, "vocab-group-filter", 1);
      // Index 1 is picked blind; read the carrier back so a reordered or
      // renamed seed group fails as setup, never as a silent other filter.
      const picked = await p.$eval("#vocab-group-filter", (el) => el.value);
      if (picked !== "Reading") throw new Error(`SETUP: G6 picked option 1 of #vocab-group-filter and got ${JSON.stringify(picked)}, not "Reading" (theme=${ctx.theme}) -- seed groups changed`);
      return true;
    },
  },
  // The sort menu button (T6b): a real pick through its ghost listbox.
  // Index 2 = "az"; the view loads on the default "latest", so this is a
  // real value change. The trigger shows on the filter row at every index
  // width (never inside the Filter popover), so no nested-popover row.
  sort: {
    view: "vocab",
    act: async (p, ctx) => {
      await libPickListboxOption(p, ctx.rows, ctx.theme, "vocab-sort", 2, { nested: false });
      const picked = await p.$eval("#vocab-sort", (el) => el.value);
      if (picked !== "az") throw new Error(`SETUP: G6 picked option 2 of #vocab-sort and got ${JSON.stringify(picked)}, not "az" (theme=${ctx.theme})`);
      return true;
    },
  },
  // Every seeded highlight lives under example.com, and the notes filter
  // matches page URLs too: the list stays full length.
  notesFilter: { view: "notes", act: async (p) => { await p.fill("#notes-filter", "example"); return true; } },
};

async function driveFilterScrollReset(page, check, extBase, theme) {
  const { inputs, viewport = [1280, 700], probeOffset = 200 } = check.expect.filterScrollReset;
  const hits = [];
  const pickRows = [];
  const p = await page.context().newPage();
  try {
    await p.setViewportSize({ width: viewport[0], height: viewport[1] });
    for (const name of inputs) {
      const input = FILTER_SCROLL_INPUTS[name];
      if (!input) throw new Error(`SETUP ERROR [library|${theme}|${check.selector}|filterScrollReset]: unknown input "${name}"`);
      await openLibraryView(p, extBase, theme, input.view, `g6-${name}`);
      const regionSel = input.view === "notes" ? ".notes-list-region" : ".vocab-list-region";
      const before = await p.evaluate(({ sel, y }) => { const r = document.querySelector(sel); r.scrollTop = y; return r.scrollTop; }, { sel: regionSel, y: probeOffset });
      if (before !== probeOffset) throw new Error(`SETUP: ${regionSel} could not be scrolled to ${probeOffset} before "${name}" (got ${before}, theme=${theme}) -- the seeded list is too short for this probe`);
      if (!(await input.act(p, { theme, rows: pickRows }))) throw new Error(`SETUP: the "${name}" input could not be performed (theme=${theme})`);
      await p.waitForTimeout(200);
      const after = await p.evaluate((sel) => { const r = document.querySelector(sel); return { top: r.scrollTop, room: r.scrollHeight - r.clientHeight }; }, regionSel);
      if (after.room < probeOffset) throw new Error(`SETUP: after "${name}" the list scrolls only ${after.room}px, under the ${probeOffset}px probe -- a clamp would pass for a reset (theme=${theme})`);
      if (after.top !== 0) hits.push(`${name}: ${regionSel} scrollTop ${after.top} after the input (was ${before})`);
    }
  } finally {
    await p.close().catch(() => {});
    await page.bringToFront().catch(() => {});
  }
  hits.pickRows = pickRows;
  return hits;
}

// ---- state: "libAxis" (spec §9.2 G5 subset; plan Review Focus 1) ----------
// The page's three numbers, recomputed here from the spec's own table (never
// read back from the CSS that implements them): P = 48 / 32 / 24 at >=1920 /
// 1280-1919 / <=1279, L = clamp(360, 20vw, 520), G = 64 / 48 at >=1920 / below.
// Both filter fields (vocabulary search, notes filter) span [P, P + L], the detail axis sits at P + L + G, and the first
// row's fill spans exactly the index column [P, P + L] -- which only holds if
// --lib-sb-w equals the region's real scrollbar gutter. Runs in the page.
const LIB_AXIS_SCAN = (view) => {
  const px = (v) => parseFloat(v) || 0;
  const w = innerWidth;
  const P = w >= 1920 ? 48 : w >= 1280 ? 32 : 24;
  const L = Math.min(520, Math.max(360, w * 0.2));
  const G = w >= 1920 ? 64 : 48;
  const notes = view === "notes";
  const search = document.querySelector(notes ? "#notes-filter" : "#vocab-search");
  const pane = document.querySelector(notes ? "#notes-detail-pane" : "#vocab-detail-pane");
  const row = document.querySelector(notes ? "#notes-list .notes-hit-btn" : "#vocab-list .vocab-card .notes-card-top");
  const region = document.querySelector(notes ? ".notes-list-region" : ".vocab-list-region");
  if (!search || !pane || !row || !region) return { error: `missing ${[!search && "search", !pane && "pane", !row && "row", !region && "region"].filter(Boolean).join(", ")} in the ${view} view` };
  const s = search.getBoundingClientRect(), r = row.getBoundingClientRect(), pr = pane.getBoundingClientRect();
  const pcs = getComputedStyle(pane);
  return {
    dpr: devicePixelRatio, P, L, G,
    searchLeft: s.left, searchRight: s.right,
    rowLeft: r.left, rowRight: r.right,
    axis: pr.left + px(pcs.borderLeftWidth) + px(pcs.paddingLeft),
    gutter: region.offsetWidth - region.clientWidth,
    sbVar: getComputedStyle(document.documentElement).getPropertyValue("--lib-sb-w").trim(),
  };
};

async function driveLibAxis(page, check, extBase, theme) {
  const { sizes, tolerancePx = 1, scrollbarPx = 17 } = check.expect.libAxis;
  const hits = [];
  const ctx = page.context();
  const wide = sizes[sizes.length - 1];
  // A: the shipped 10px scrollbar at DPR 1. B: the user's real window --
  // DPR 1.5 -- with a wider scrollbar injected before load, so the FIRST
  // measurement has to pick it up. C / D: --lib-sb-w deliberately corrupted
  // after load, then the two re-measure triggers fired -- an <html>
  // re-theme (MutationObserver) and a resize -- each alone must restore it.
  const rounds = [
    { name: "dpr1", dpr: 1, sizes },
    { name: `dpr1.5+sb${scrollbarPx}`, dpr: 1.5, injectAtLoad: true, sizes },
    { name: "remeasure-on-rethemed-html", dpr: 1, corruptThen: "attribute", sizes: [wide] },
    { name: "remeasure-on-resize", dpr: 1, corruptThen: "resize", sizes: [wide] },
  ];
  const scrollbarCss = `::-webkit-scrollbar { width: ${scrollbarPx}px !important; }`;
  for (const round of rounds) {
    for (const [w, h] of round.sizes) {
      const p = await ctx.newPage();
      try {
        await p.setViewportSize({ width: w, height: h });
        if (round.dpr !== 1) {
          const cdp = await ctx.newCDPSession(p);
          await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: round.dpr, mobile: false });
        }
        if (round.injectAtLoad) {
          // Registered before any page script, so this DOMContentLoaded
          // listener runs ahead of library.js's -- the stylesheet is in place
          // when the first measurement happens.
          await p.addInitScript((css) => {
            document.addEventListener("DOMContentLoaded", () => {
              const style = document.createElement("style");
              style.textContent = css;
              document.head.appendChild(style);
            }, { once: true });
          }, scrollbarCss);
        }
        for (const view of ["vocab", "notes"]) {
          await openLibraryView(p, extBase, theme, view, `g5-${round.name}-${w}`);
          if (round.corruptThen) {
            await p.evaluate(() => document.documentElement.style.setProperty("--lib-sb-w", "0px"));
            if (round.corruptThen === "attribute") {
              await p.evaluate(() => {
                const html = document.documentElement;
                const prev = html.getAttribute("data-density");
                html.setAttribute("data-density", prev ?? "compact");
                if (prev === null) html.removeAttribute("data-density");
              });
            } else {
              await p.setViewportSize({ width: w + 1, height: h });
              await p.waitForTimeout(100);
              await p.setViewportSize({ width: w, height: h });
            }
            await p.waitForTimeout(150);
          }
          const m = await p.evaluate(LIB_AXIS_SCAN, view);
          if (m.error) throw new Error(`SETUP: libAxis ${m.error} (${round.name} ${w}x${h}, theme=${theme})`);
          if (Math.abs(m.dpr - round.dpr) > 0.01) throw new Error(`SETUP: libAxis devicePixelRatio is ${m.dpr}, wanted ${round.dpr} (theme=${theme})`);
          if (round.injectAtLoad && m.gutter !== scrollbarPx) throw new Error(`SETUP: the injected ${scrollbarPx}px scrollbar did not apply (region gutter ${m.gutter}px, theme=${theme})`);
          const where = `${round.name} ${w}x${h} ${view}`;
          const near = (a, b) => Math.abs(a - b) <= tolerancePx;
          const indexRight = m.P + m.L;
          if (!near(m.searchLeft, m.P)) hits.push(`${where}: search box left ${m.searchLeft.toFixed(2)} != P ${m.P}`);
          // Both filter fields span the index column: the notes one too, now
          // that T4c split its header into three rows (in T3 it was one of
          // three toolbar columns).
          if (!near(m.searchRight, indexRight)) hits.push(`${where}: ${view === "notes" ? "notes filter" : "search box"} right ${m.searchRight.toFixed(2)} != P + L ${indexRight.toFixed(2)}`);
          if (!near(m.axis, indexRight + m.G)) hits.push(`${where}: detail axis ${m.axis.toFixed(2)} != P + L + G ${(indexRight + m.G).toFixed(2)}`);
          if (!near(m.rowLeft, m.P) || !near(m.rowRight, indexRight)) {
            hits.push(`${where}: row fill ${m.rowLeft.toFixed(2)}-${m.rowRight.toFixed(2)} != index column ${m.P}-${indexRight.toFixed(2)} (--lib-sb-w ${m.sbVar || "unset"}, gutter ${m.gutter}px)`);
          }
        }
      } finally {
        await p.close().catch(() => {});
      }
    }
  }
  await page.bringToFront().catch(() => {});
  return hits;
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

async function driveHeaderRows(page, check, theme) {
  const { rows, columnSel, widths, tolerancePx = 1, mayVanish = [], exclusive = [], toggle } = check.expect.headerRowsFlush;
  // Fail-closed (independent review F3, 2026-08-07). This used to `continue`
  // on ANY row whose computed display was none, which is a silent exemption
  // for the loudest possible defect: a header row that disappears entirely
  // would report zero violations. Only rows the checklist NAMES as legitimately
  // absent get the pass. No row may vanish any more (#vocab-stats was retired
  // in the library redesign, T4b); the list stays here for rows that
  // genuinely ship hidden.
  const vanishOk = new Set(mayVanish);
  // Exclusive pairs [rest, open] (T4d review): two rows that take turns in
  // one slot -- the count row and the batch row that replaces it. BOTH get
  // measured: the whole width sweep runs once at rest (the first member must
  // render, the second must not) and once with `toggle` switched on (the
  // other way round). A hidden member is excused only in the phase where it
  // is supposed to be hidden, so neither row can drop out of the gate by
  // hiding behind its partner.
  const toggles = { vocabSelection: setVocabBatchOpen };
  if (exclusive.length && !toggles[toggle]) {
    throw new Error(`SETUP: headerRowsFlush exclusive pairs need a known toggle (got ${JSON.stringify(toggle)})`);
  }
  const phases = exclusive.length ? [false, true] : [null];
  const restore = page.viewportSize();
  const startedOpen = exclusive.length ? await page.evaluate(() => !!document.querySelector("#vocab-batch-toolbar.selecting")) : null;
  const bad = [];
  let worst = 0;
  try {
    for (const phase of phases) {
      const tag = phase === null ? "" : phase ? " [open]" : " [rest]";
      if (phase !== null) {
        if (restore) await page.setViewportSize(restore);
        await toggles[toggle](page, theme, phase);
      }
      const hiddenOk = new Set(exclusive.map(([a, b]) => (phase ? a : b)));
      for (const width of widths) {
        await page.setViewportSize({ width, height: restore ? restore.height : 900 });
        await page.waitForTimeout(250);
        const res = await page.evaluate(HEADER_ROWS_SCAN, { rows, columnSel });
        if (res.error) { bad.push(`${width}px${tag}: ${res.error}`); continue; }
        for (const row of res.rows) {
          if (row.missing) { bad.push(`${width}px${tag}: ${row.sel} not in the DOM`); continue; }
          if (row.hidden) {
            if (!vanishOk.has(row.sel) && !(phase !== null && hiddenOk.has(row.sel))) bad.push(`${width}px${tag}: ${row.sel} renders display:none — the whole row is gone`);
            continue;
          }
          if (phase !== null && hiddenOk.has(row.sel)) bad.push(`${width}px${tag}: ${row.sel} renders although its partner holds the slot in this state`);
          worst = Math.max(worst, Math.abs(row.widthGap), Math.abs(row.edgeGap));
          if (Math.abs(row.widthGap) > tolerancePx) bad.push(`${width}px${tag}: ${row.sel} is ${row.widthGap}px narrower than the column`);
          if (Math.abs(row.edgeGap) > tolerancePx) bad.push(`${width}px${tag}: ${row.sel} ends ${row.edgeGap}px short of its last control`);
        }
      }
    }
  } finally {
    if (restore) await page.setViewportSize(restore);
    await page.waitForTimeout(250);
    if (startedOpen !== null) await toggles[toggle](page, theme, startedOpen);
  }
  return { bad, worst: +worst.toFixed(2) };
}

// ---- state: "filterPopoverKeys" (library redesign T4b, spec §3.4 / §7.1) ---
// The narrow index's "Filter" popover on the trusted keyboard path: Space on
// the focused button opens it (aria-expanded true, pbpListboxPlace's fixed
// placement inside the viewport); Escape closes it, keeps focus on the
// button and leaves no inline placement behind -- a leftover `position:
// fixed` would wreck the wide form the next time the index crosses the
// threshold.
async function driveFilterPopoverKeys(page, theme, check) {
  const { set } = check.expect.filterPopoverKeys;
  const ready = await page.evaluate(({ btnSel, setSel }) => {
    const b = document.querySelector(btnSel), s = document.querySelector(setSel);
    if (!b || !s) return "missing";
    if (getComputedStyle(b).display === "none") return "wide form (button hidden)";
    b.focus();
    return document.activeElement === b ? "ok" : "unfocusable";
  }, { btnSel: check.selector, setSel: set });
  if (ready !== "ok") throw new Error(`SETUP ERROR [library|${theme}|${check.selector}|filterPopoverKeys]: ${ready} -- the library viewport must leave the index narrow`);
  const bad = [];
  await page.keyboard.press("Space");
  await settleAnimations(page);
  const opened = await page.evaluate(({ btnSel, setSel }) => {
    const b = document.querySelector(btnSel), s = document.querySelector(setSel);
    const r = s.getBoundingClientRect();
    return { open: s.matches(":popover-open"), expanded: b.getAttribute("aria-expanded"), position: getComputedStyle(s).position,
      inside: r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5 };
  }, { btnSel: check.selector, setSel: set });
  if (!opened.open) bad.push("Space on the Filter button did not open the popover");
  if (opened.expanded !== "true") bad.push(`aria-expanded is ${opened.expanded} while open`);
  if (opened.position !== "fixed") bad.push(`open popover is position:${opened.position}, not fixed`);
  if (!opened.inside) bad.push("open popover is not inside the viewport");
  // Library redesign T6: the group listbox now lives inside the open Filter
  // popover. Escape must close only the top layer: the listbox first (its
  // keydown handler preventDefault()s Escape, which also cancels the close
  // request), the Filter popover on the next Escape (below). A missing
  // button is a SETUP, like every other precondition here: skipping would
  // drop all three layer checks and still report the row OK (final review
  // #13).
  {
    const groupBtn = await page.evaluate((setSel) => {
      const b = document.getElementById("vocab-group-filter-btn");
      if (!b) return "missing";
      return document.querySelector(setSel)?.contains(b) ? "ok" : "not inside the Filter popover";
    }, set);
    if (groupBtn !== "ok") {
      throw new Error(`SETUP ERROR [library|${theme}|${check.selector}|filterPopoverKeys]: #vocab-group-filter-btn ${groupBtn} -- listbox.js id or the T6 filter-set markup changed`);
    }
    await page.focus("#vocab-group-filter-btn");
    await page.keyboard.press("Space");
    await settleAnimations(page);
    const listOpen = await page.$eval("#vocab-group-filter-list", (el) => el.getClientRects().length > 0);
    if (!listOpen) bad.push("Space on the group listbox inside the Filter popover did not open its list");
    await page.keyboard.press("Escape");
    await settleAnimations(page);
    const layer = await page.evaluate((setSel) => ({
      list: document.getElementById("vocab-group-filter-list").getClientRects().length > 0,
      set: document.querySelector(setSel).matches(":popover-open"),
      focus: document.activeElement?.id || "",
    }), set);
    if (layer.list) bad.push("first Escape left the group listbox open");
    if (!layer.set) bad.push("first Escape closed the Filter popover too (it must close only the listbox)");
    if (layer.focus !== "vocab-group-filter-btn") bad.push(`after the first Escape focus is on #${layer.focus}, not the group listbox button`);
  }
  await page.keyboard.press("Escape");
  await settleAnimations(page);
  const closed = await page.evaluate(({ btnSel, setSel }) => {
    const b = document.querySelector(btnSel), s = document.querySelector(setSel);
    return { open: s.matches(":popover-open"), expanded: b.getAttribute("aria-expanded"), focus: document.activeElement === b, style: s.getAttribute("style") || "" };
  }, { btnSel: check.selector, setSel: set });
  if (closed.open) bad.push("Escape did not close the popover");
  if (closed.expanded !== "false") bad.push(`aria-expanded is ${closed.expanded} after closing`);
  if (!closed.focus) bad.push("focus did not stay on the Filter button");
  if (/position|left|top|width/.test(closed.style)) bad.push(`closing left inline placement behind: ${closed.style}`);
  await page.evaluate(() => document.activeElement?.blur?.());
  return bad;
}

// ---- library index gates (redesign T4e, spec §9.2 G2 / G3 / G7, G6 toggles)
// All four use a scratch page in the same extension context: the theme is in
// storage, so it loads the same theme, and nothing they do (locale swaps,
// synthetic rows, viewport sizes, selections) reaches the shared page the
// CHECKS loop keeps reading. Only density changes geometry here, so their
// checklist entries carry `themes: ["", "terminal"]` (comfortable / compact)
// like the other T3 scratch-page gates.
const LIB_INDEX_LOCALES = Object.freeze(["en", "de", "fr", "pl", "ru", "zh_HK", "zh_CN", "zh_TW", "ja"]);
// The one locale -> BCP 47 table (T8e review): what uiLangToBCP47() (i18n.js)
// answers for each locale, which is also the tag the CJK :lang() rules read
// on <html>. setLibraryLocale writes both from it.
const LIB_LOCALE_BCP47 = Object.freeze({
  en: "en", de: "de", fr: "fr", pl: "pl", ru: "ru", ja: "ja", zh_CN: "zh-Hans", zh_HK: "zh-Hant", zh_TW: "zh-Hant",
});

async function libScratchPage(page, extBase, theme, tag, view, viewport) {
  const scratch = await page.context().newPage();
  try {
    await scratch.setViewportSize(viewport);
    await openLibraryView(scratch, extBase, theme, view, tag);
    await settleAnimations(scratch);
  } catch (err) {
    await scratch.close().catch(() => {});
    throw err;
  }
  return scratch;
}

async function closeLibScratch(page, scratch) {
  await scratch.close().catch(() => {});
  await page.bringToFront().catch(() => {});
}

// What a language change does on the real page, minus the storage trip (a
// localStorage write would reach the shared page -- same origin): swap
// i18n.js's table, re-apply data-i18n, re-render the visible view. applyI18n
// writes <html lang> from the stored language, so the tag that drives the
// CJK :lang() rules is written after it. uiLangToBCP47() reads the stored
// language too: it is overridden on this page's global (never through
// localStorage), so dates and option names follow the locale as well.
async function setLibraryLocale(p, extBase, locale) {
  const tag = LIB_LOCALE_BCP47[locale];
  if (!tag) throw new Error(`SETUP: setLibraryLocale(${locale}): no BCP 47 tag in LIB_LOCALE_BCP47`);
  const got = await p.evaluate(async ({ url, lang }) => {
    window.uiLangToBCP47 = () => lang;
    const msgs = await (await fetch(url)).json();
    _i18nMessages = msgs;
    applyI18n();
    document.documentElement.lang = lang;
    // The dictionary language options are named in the UI locale and the page
    // fills them once, at load: rebuild them with the page's own filler, or
    // every locale measures English names (T8f review). A missing filler is
    // a SETUP, never a quiet fall back to the English names it replaces.
    const langSel = document.getElementById("vocab-lookup-lang");
    if (!langSel) return "no #vocab-lookup-lang";
    if (typeof _pbpVocabFillLookupLangs !== "function") return "no _pbpVocabFillLookupLangs (library-vocab.js renamed it?)";
    _pbpVocabFillLookupLangs(langSel, lang);
    if (!document.getElementById("view-vocab").hidden) _pbpVocabApplyView(false);
    if (!document.getElementById("view-notes").hidden) _pbpNotesRender();
    return "ok";
  }, { url: `${extBase}_locales/${locale}/messages.json`, lang: tag });
  if (got !== "ok") throw new Error(`SETUP: setLibraryLocale(${locale}): ${got}`);
  await settleAnimations(p);
}

// G3: how many whole rows a 900px-tall window shows, and at what pitch.
async function driveVisibleRowCount(page, extBase, theme, check) {
  const { width, height, comfortable, compact } = check.expect.visibleRowCount;
  const scratch = await libScratchPage(page, extBase, theme, "g3", "vocab", { width, height });
  try {
    const m = await scratch.evaluate(() => {
      const region = document.querySelector(".vocab-list-region");
      const cards = [...document.querySelectorAll("#vocab-list > .vocab-card")];
      if (!region || cards.length < 3) return { error: `${cards.length} rendered rows -- LIB_SEED.wordCount did not reach the list` };
      return {
        pitch: cards[1].getBoundingClientRect().top - cards[0].getBoundingClientRect().top,
        visible: region.clientHeight,
        compact: document.documentElement.dataset.density === "compact",
      };
    });
    if (m.error) throw new Error(`SETUP ERROR [library|${theme}|${check.selector}|visibleRowCount]: ${m.error}`);
    const tier = m.compact ? compact : comfortable;
    const rows = Math.floor(m.visible / m.pitch);
    const range = `${tier.min}${tier.max != null ? `-${tier.max}` : "+"}`;
    const bad = [];
    if (Math.abs(m.pitch - tier.pitch) > 0.5) bad.push(`row pitch ${round2(m.pitch)}px, expected ${tier.pitch}px`);
    if (rows < tier.min || (tier.max != null && rows > tier.max)) bad.push(`${rows} rows in ${round2(m.visible)}px, expected ${range}`);
    return { ok: bad.length === 0, actual: `${rows} rows @ ${round2(m.pitch)}px (${m.compact ? "compact" : "comfortable"})`,
      expected: `${range} rows @ ${tier.pitch}px`, note: bad.join("; ") || undefined };
  } finally {
    await closeLibScratch(page, scratch);
  }
}

// G2: ArrowDown from the first row, `steps` times; after every press the
// focused row must lie wholly inside the list region.
async function driveFocusRowVisible(page, extBase, theme, check) {
  const { width, height, steps, passes } = check.expect.focusRowVisible;
  const scratch = await libScratchPage(page, extBase, theme, "g2", "vocab", { width, height });
  const bad = [];
  try {
    for (const pass of passes) {
      if (pass.locale) await setLibraryLocale(scratch, extBase, pass.locale);
      await scratch.evaluate((w) => {
        if (w) document.documentElement.style.setProperty("--lib-index-w", `${w}px`);
        else document.documentElement.style.removeProperty("--lib-index-w");
      }, pass.indexW || 0);
      await settleAnimations(scratch);
      const head = scratch.locator("#vocab-list .vocab-card .notes-card-head").first();
      if (pass.select) {
        await head.click({ modifiers: ["Control"] });
        await scratch.waitForSelector("#vocab-batch-toolbar.selecting", { timeout: TIMEOUT_MS });
        await scratch.mouse.move(0, 0);
        await settleAnimations(scratch);
      }
      const setup = await scratch.evaluate(() => {
        const r = document.querySelector(".vocab-list-region");
        r.scrollTop = 0;
        return { sh: r.scrollHeight, ch: r.clientHeight };
      });
      if (setup.sh <= setup.ch + 200) {
        throw new Error(`SETUP ERROR [library|${theme}|${check.selector}|focusRowVisible]: .vocab-list-region overflows by only ${setup.sh - setup.ch}px (${pass.name}) -- LIB_SEED must overflow it by >200px`);
      }
      await head.focus();
      for (let i = 1; i <= steps; i++) {
        await scratch.keyboard.press("ArrowDown");
        const v = await scratch.evaluate(() => {
          const el = document.activeElement;
          const row = el && el.closest ? el.closest("#vocab-list .notes-card-top") : null;
          const region = document.querySelector(".vocab-list-region");
          if (!row || !region) return null;
          const r = row.getBoundingClientRect(), g = region.getBoundingClientRect();
          return { above: g.top - r.top, below: r.bottom - g.bottom };
        });
        if (!v) { bad.push(`${pass.name}: focus left the list after ArrowDown #${i}`); break; }
        if (v.above > 0.5 || v.below > 0.5) {
          bad.push(`${pass.name}: row ${i + 1} is ${v.above > 0.5 ? `${round2(v.above)}px above` : `${round2(v.below)}px below`} the list region after ArrowDown #${i}`);
          break;
        }
      }
      if (pass.select) {
        await scratch.click("#vocab-clear-selection");
        await scratch.waitForFunction(() => !document.querySelector("#vocab-batch-toolbar.selecting"), null, { timeout: TIMEOUT_MS });
      }
    }
  } finally {
    await closeLibScratch(page, scratch);
  }
  return bad;
}

// One list header, in page. Four things per header row:
// - edge: every rendered descendant ends inside the index's content box;
// - group: inside every flex / grid box of the row, each in-flow child stays
//   inside that box and no two children's boxes intersect (user ruling
//   10-04: the edge check alone missed status toggles spilling out of their
//   set and under the sort control at a 440px German index);
// - count items: each wholly inside its fixed-height box or wholly below it
//   (that box clips on purpose, so it is exempt from the group check);
// - batch rows: with an empty status slot, vocabulary is exactly 2 x sm + 8;
//   notes is one sm row or, when it does not fit, two (2 x sm + 8).
// - text (final review #11): element boxes cannot see text that overflows its
//   own box -- a fixed-height button whose label wrapped onto two lines kept
//   its 28px rect while the text spilled out of it. Every rendered text node
//   is measured by its line boxes (Range.getClientRects): one line, or every
//   line inside the content box of the box that holds it (its nearest
//   non-inline ancestor); and no painted line reaches the list region.
// An optical hang (a negative margin of exactly the element's own padding,
// the G4b offset category) may cross its box by that much. It also reports
// which form each header shows and the pane's data-header-fit, for the
// driver's form-vs-measurement comparison.
const LIST_HEADER_FIT_SCAN = ({ view, extraRows = [] }) => {
  const vocab = view === "vocab";
  const pane = document.querySelector(vocab ? ".vocab-list-pane" : ".notes-list-pane");
  if (!pane) return { error: "list pane missing" };
  const pr = pane.getBoundingClientRect(), pcs = getComputedStyle(pane);
  const left = pr.left + (parseFloat(pcs.paddingLeft) || 0) + (parseFloat(pcs.borderLeftWidth) || 0);
  const right = pr.right - (parseFloat(pcs.paddingRight) || 0) - (parseFloat(pcs.borderRightWidth) || 0);
  const rows = (vocab
    ? ["#view-vocab .notes-toolbar", "#view-vocab .vocab-filter-row", "#vocab-context-bar", "#vocab-batch-toolbar"]
    : ["#view-notes .notes-toolbar", "#notes-color-filters", "#notes-context-bar", "#notes-batch-toolbar"]).concat(extraRows);
  const shown = (el) => { const cs = getComputedStyle(el); return cs.display !== "none" && cs.visibility !== "hidden"; };
  const nameOf = (el) => el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${String(el.getAttribute("class") || "").trim().split(/\s+/).join(".")}`;
  const hangOf = (cs) => {
    const one = (m, p) => (m < 0 && Math.abs(-m - p) <= 0.5 ? -m : 0);
    return { l: one(parseFloat(cs.marginLeft) || 0, parseFloat(cs.paddingLeft) || 0), r: one(parseFloat(cs.marginRight) || 0, parseFloat(cs.paddingRight) || 0) };
  };
  const skipped = (el) => el.closest(".sr-only") || (el.closest("svg") && el.tagName.toLowerCase() !== "svg");
  // Nothing a header row paints may reach the list region below it (T8e
  // review: a wrapped Select all sat on the first row while the count row
  // kept its one-line box). Measured on what is PAINTED: a box inside an
  // ancestor that clips (the count items' hidden second line) counts only
  // down to that ancestor's bottom.
  const region = document.querySelector(vocab ? ".vocab-list-region" : ".notes-list-region");
  const regionTop = region && region.getClientRects().length ? region.getBoundingClientRect().top : null;
  if (regionTop == null) return { error: `${vocab ? ".vocab-list-region" : ".notes-list-region"} is missing or not rendered` };
  const paintedBottom = (el, row, r) => {
    let bottom = r.bottom;
    for (let a = el.parentElement; a && row.contains(a); a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (acs.overflowY !== "visible" || acs.overflowX !== "visible") bottom = Math.min(bottom, a.getBoundingClientRect().bottom);
    }
    return bottom > r.top ? bottom : null;
  };
  const bad = [];
  let measured = 0;
  let textNodes = 0;
  // Clipping ancestors inside the row cap what a text line paints (the count
  // items' hidden second line is clipped on purpose, never painted).
  const clipOf = (node, row) => {
    let top = -Infinity, bottom = Infinity;
    for (let a = node.parentElement; a && row.contains(a); a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (acs.overflowY !== "visible" || acs.overflowX !== "visible") {
        const ar = a.getBoundingClientRect();
        top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom);
      }
    }
    return { top, bottom };
  };
  const textHost = (node) => {
    for (let a = node.parentElement; a; a = a.parentElement) {
      if (getComputedStyle(a).display !== "inline") return a;
    }
    return null;
  };
  const scanText = (sel, row) => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT,
      { acceptNode: (n) => (n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || skipped(parent)) continue;
      const pcs = getComputedStyle(parent);
      if (pcs.visibility === "hidden" || !parent.getClientRects().length) continue;
      range.selectNodeContents(node);
      const clip = clipOf(node, row);
      const lines = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5 && r.bottom > clip.top + 0.5 && r.top < clip.bottom - 0.5);
      if (!lines.length) continue;
      textNodes++;
      const tops = [];
      for (const r of lines) if (!tops.some((t) => Math.abs(t - r.top) <= 1)) tops.push(r.top);
      const host = textHost(node);
      const text = JSON.stringify(node.nodeValue.trim().slice(0, 32));
      if (tops.length > 1 && host) {
        const hr = host.getBoundingClientRect(), hcs = getComputedStyle(host);
        const cTop = hr.top + (parseFloat(hcs.borderTopWidth) || 0) + (parseFloat(hcs.paddingTop) || 0);
        const cBottom = hr.bottom - (parseFloat(hcs.borderBottomWidth) || 0) - (parseFloat(hcs.paddingBottom) || 0);
        const out = lines.filter((r) => r.top < cTop - 0.5 || r.bottom > cBottom + 0.5);
        if (out.length) {
          const worst = Math.max(...out.map((r) => Math.max(cTop - r.top, r.bottom - cBottom)));
          bad.push(`${sel} text ${text} wraps onto ${tops.length} lines and spills ${worst.toFixed(1)}px out of ${nameOf(host)}`);
        }
      }
      const painted = Math.max(...lines.map((r) => Math.min(r.bottom, clip.bottom)));
      if (painted > regionTop + 0.5) bad.push(`${sel} text ${text} paints ${(painted - regionTop).toFixed(1)}px into the list region below the header`);
    }
  };
  for (const sel of rows) {
    const row = document.querySelector(sel);
    if (!row || !shown(row)) continue;
    measured++;
    scanText(sel, row);
    for (const el of [row, ...row.querySelectorAll("*")]) {
      if (skipped(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const painted = paintedBottom(el, row, r);
      if (painted != null && painted > regionTop + 0.5) bad.push(`${sel} ${nameOf(el)} paints ${(painted - regionTop).toFixed(1)}px into the list region below the header`);
      const hang = hangOf(cs);
      if (r.right - hang.r > right + 0.5) bad.push(`${sel} ${nameOf(el)} ends ${(r.right - hang.r - right).toFixed(1)}px past the index`);
      if (r.left + hang.l < left - 0.5) bad.push(`${sel} ${nameOf(el)} starts ${(left - r.left - hang.l).toFixed(1)}px before the index`);
      // The group check: flex / grid boxes that do not clip.
      if (!/flex|grid/.test(cs.display) || cs.overflowX !== "visible" || cs.overflowY !== "visible") continue;
      const kids = [...el.children].filter((k) => {
        if (skipped(k)) return false;
        const kc = getComputedStyle(k);
        if (kc.display === "none" || kc.visibility === "hidden" || kc.position === "absolute" || kc.position === "fixed") return false;
        const kr = k.getBoundingClientRect();
        return kr.width > 0.5 && kr.height > 0.5;
      });
      for (const k of kids) {
        const kr = k.getBoundingClientRect(), kh = hangOf(getComputedStyle(k));
        if (kr.left + kh.l < r.left - 0.5 || kr.right - kh.r > r.right + 0.5) {
          bad.push(`${sel} ${nameOf(k)} spills ${Math.max(r.left - kr.left - kh.l, kr.right - kh.r - r.right).toFixed(1)}px out of its group ${nameOf(el)}`);
        }
      }
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
          const x = Math.min(a.right, b.right) - Math.max(a.left, b.left), y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (x > 0.5 && y > 0.5) bad.push(`${sel} ${nameOf(kids[i])} and ${nameOf(kids[j])} overlap by ${x.toFixed(1)} x ${y.toFixed(1)}px`);
        }
      }
    }
  }
  const items = document.querySelector(vocab ? "#vocab-count .lib-count-items" : "#notes-count .lib-count-items");
  if (items && shown(items) && items.getClientRects().length) {
    const box = items.getBoundingClientRect();
    for (const it of items.children) {
      const r = it.getBoundingClientRect();
      const inside = r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.right <= box.right + 0.5;
      if (!inside && r.top < box.bottom - 0.5) bad.push(`count item "${it.textContent}" is cut by its box`);
    }
  }
  const batch = document.querySelector(vocab ? "#vocab-batch-toolbar" : "#notes-batch-toolbar");
  if (batch && shown(batch)) {
    const busy = !!batch.querySelector(".lib-batch-status .save-status:not(:empty)") ||
      [...batch.querySelectorAll(".vocab-group-help")].some((h) => !h.hidden);
    const sm = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--lib-control-h")) - 4;
    const wants = vocab ? [2 * sm + 8] : [sm, 2 * sm + 8];
    const h = batch.getBoundingClientRect().height;
    if (!busy && !wants.some((w) => Math.abs(h - w) <= 1)) bad.push(`${batch.id} is ${h.toFixed(1)}px tall, expected ${wants.join(" or ")}px`);
  }
  // The form showing: vocabulary = narrow while the Filter button renders;
  // notes = narrow while the colour toggles' numbers are hidden.
  let form;
  if (vocab) {
    const btn = document.getElementById("vocab-filter-narrow");
    form = btn && getComputedStyle(btn).display !== "none" ? "narrow" : "wide";
  } else {
    const num = document.querySelector("#notes-color-filters .lib-toggle-count");
    form = num && getComputedStyle(num).display === "none" ? "narrow" : "wide";
  }
  return { bad, measured, textNodes, form, fit: pane.dataset.headerFit || null, room: right - left };
};

// What the wide forms need, measured here independently of library.js's own
// measurement (the oracle the form is checked against). Vocabulary: lay the
// popover's nodes out inline as the wide rule does, every shrinkable child
// with a px floor (the group filter's min-width) at that floor, on a
// min-content row, with the sort menu button (T6b) showing the widest face
// word any of its options can show -- the form must not change with the
// sort. Notes: the colour row at max-content with every number showing.
// Every inline style and face text is restored before returning.
const FILTER_ROW_NEED = () => {
  const row = document.querySelector("#view-vocab .vocab-filter-row");
  const set = document.getElementById("vocab-filter-set");
  const btn = document.getElementById("vocab-filter-narrow");
  const door = document.getElementById("vocab-lookup-narrow");
  if (!row || !set || !btn) return null;
  const saved = new Map();
  const keep = (el) => { if (el && !saved.has(el)) saved.set(el, el.getAttribute("style")); };
  [row, set, btn, door].forEach(keep);
  btn.style.display = "none";
  if (door) door.style.display = "none";
  Object.assign(set.style, { display: "flex", position: "static", inset: "auto", margin: "0", padding: "0", border: "0",
    background: "none", width: "auto", height: "auto", overflow: "visible", flex: "1 1 auto", minWidth: "0",
    alignItems: "center", gap: getComputedStyle(row).columnGap });
  for (const kid of set.children) {
    const cs = getComputedStyle(kid);
    const floor = parseFloat(cs.minWidth);
    if (cs.display === "none" || cs.position === "absolute" || !(parseFloat(cs.flexShrink) > 0) || !(floor > 0)) continue;
    keep(kid);
    Object.assign(kid.style, { flex: "none", width: `${floor}px` });
  }
  const faces = [];
  for (const trigger of row.querySelectorAll(".listbox-trigger")) {
    const select = trigger.parentElement?.previousElementSibling;
    const face = trigger.lastElementChild;
    if (!select || select.tagName !== "SELECT" || !face) continue;
    faces.push([face, face.textContent]);
    keep(face);
    const words = [...new Set([...select.options].map((o) => o.dataset.faceLabel || o.textContent.trim()))];
    face.replaceChildren(...words.map((w) => {
      const span = document.createElement("span");
      span.textContent = w;
      span.style.gridArea = "1 / 1";
      return span;
    }));
    face.style.display = "inline-grid";
  }
  row.style.width = "min-content";
  const need = row.getBoundingClientRect().width;
  for (const [face, text] of faces) face.textContent = text;
  for (const [el, style] of saved) {
    if (style == null) el.removeAttribute("style");
    else el.setAttribute("style", style);
  }
  return need;
};
const NOTES_ROW_NEED = () => {
  const row = document.getElementById("notes-color-filters");
  if (!row || row.hidden) return null;
  const nums = [...row.querySelectorAll(".lib-toggle-count")];
  const saved = [row, ...nums].map((el) => el.getAttribute("style"));
  nums.forEach((n) => { n.style.display = "inline"; });
  row.style.width = "max-content";
  const need = row.getBoundingClientRect().width;
  [row, ...nums].forEach((el, i) => {
    if (saved[i] == null) el.removeAttribute("style");
    else el.setAttribute("style", saved[i]);
  });
  return need;
};

// G7. Per view and locale, the index widths are the checklist's fixed ones
// plus the two either side of that locale's own need (when inside [min, max]),
// so both sides of every locale's switch point are walked. At each width, in
// browse and select state: the scan above, plus the form check -- the form
// showing (and data-header-fit) must be the one the measured need calls for
// (skipped within 1px of the need, where rounding owns the call).
async function driveListHeaderFit(page, extBase, theme, check) {
  const { width, height, indexWidths, count } = check.expect.listHeaderFit;
  const lo = Math.min(...indexWidths), hi = Math.max(...indexWidths);
  const bad = [];
  const needs = [];
  let need = { px: 0, locale: null };
  let notesNeedText = "";
  const scratch = await libScratchPage(page, extBase, theme, "g7", "vocab", { width, height });
  const setIndex = async (w) => {
    await scratch.evaluate((px) => document.documentElement.style.setProperty("--lib-index-w", `${px}px`), w);
    await settleAnimations(scratch);
  };
  const widthsAround = (n) => [...new Set([...indexWidths, Math.floor(n - 1), Math.ceil(n + 1)].filter((w) => w >= lo && w <= hi))].sort((a, b) => a - b);
  const pass = async (view, locale, n, select) => {
    for (const w of widthsAround(n)) {
      await setIndex(w);
      for (const selecting of [false, true]) {
        await select(selecting);
        await settleAnimations(scratch);
        const label = `${view} ${locale} index ${w}${selecting ? " selecting" : ""}`;
        const res = await scratch.evaluate(LIST_HEADER_FIT_SCAN, { view });
        if (res.error) throw new Error(`SETUP ERROR [library|${theme}|${check.selector}|listHeaderFit]: ${res.error}`);
        // Search, filter / colour row and one of count row / batch row: a
        // header that rendered fewer rows than that measured nothing.
        if (res.measured < 3) throw new Error(`SETUP ERROR [library|${theme}|${check.selector}|listHeaderFit]: only ${res.measured} header rows rendered (${label})`);
        for (const b of res.bad) bad.push(`${label}: ${b}`);
        const want = n <= res.room + 0.5 ? "wide" : "narrow";
        if (Math.abs(n - res.room) > 1 && (res.form !== want || res.fit !== want)) {
          bad.push(`${label}: shows the ${res.form} form (data-header-fit ${res.fit}) but needs ${round2(n)}px in ${round2(res.room)}px -> ${want}`);
        }
      }
    }
  };
  try {
    await scratch.evaluate((n) => {
      const langs = ["en", "de", "fr", "es", "it", "ja", "zh", "ru", "pl"];
      const now = Date.now();
      _vocabRows = Array.from({ length: n }, (_, i) => ({
        id: `g7-${i}`, term: `term${i}`, gloss: `gloss ${i}`, language: langs[i % langs.length],
        status: i % 2 ? "known" : "new", groups: [`G${i % 12}`], contexts: [], createdAt: now - i * 60000, updatedAt: now - i * 60000,
      }));
      _pbpVocabApplyView(true);
    }, count);
    const selectVocab = (on) => scratch.evaluate((v) => {
      _vocabSelected = v ? pbpVocabSelectResults(new Set(), _vocabViewRows, "all") : new Set();
      _vocabLastSelectedId = null;
      _pbpVocabSyncSelectionUi();
    }, on);
    // Standing counter-example for the text half (final review #11): a
    // fixed-height sm button squeezed narrower than its two-word label, the
    // shape "Zaznacz wszystko" had at a 360px Polish index. Its element box
    // never moves, so only the text scan can see it; if the scan stops
    // reporting it, the scan has gone blind and the row fails.
    {
      await setIndex(lo);
      await selectVocab(false);
      const planted = await scratch.evaluate(() => {
        const host = document.querySelector("#vocab-context-bar .lib-cluster");
        if (!host) return false;
        const b = document.createElement("button");
        b.type = "button";
        b.id = "g7-counter-example";
        b.className = "btn btn-sm ghost";
        b.style.cssText = "white-space: normal; width: 48px";
        b.textContent = "Zaznacz wszystko";
        host.prepend(b);
        return true;
      });
      if (!planted) throw new Error(`SETUP ERROR [library|${theme}|${check.selector}|listHeaderFit]: no #vocab-context-bar .lib-cluster to plant the counter-example in`);
      await settleAnimations(scratch);
      const res = await scratch.evaluate(LIST_HEADER_FIT_SCAN, { view: "vocab" });
      await scratch.evaluate(() => document.getElementById("g7-counter-example")?.remove());
      await settleAnimations(scratch);
      if (res.error) throw new Error(`SETUP ERROR [library|${theme}|${check.selector}|listHeaderFit]: ${res.error}`);
      if (!res.bad.some((b) => b.includes("wraps onto") && b.includes("#g7-counter-example"))) {
        bad.push(`the text scan missed its counter-example (a 48px sm button with a two-line label): ${res.bad.slice(0, 2).join("; ") || "no finding"}`);
      }
      if (!(res.textNodes > 0)) bad.push("the text scan measured no text node at all");
    }
    for (const locale of LIB_INDEX_LOCALES) {
      await setLibraryLocale(scratch, extBase, locale);
      const n = await scratch.evaluate(FILTER_ROW_NEED);
      if (n == null) throw new Error(`SETUP ERROR [library|${theme}|${check.selector}|listHeaderFit]: the filter row's nodes are missing`);
      needs.push(`${locale} ${round2(n)}`);
      if (n > need.px) need = { px: n, locale };
      // The sort menu button (T6b) has no sizer: its width is the selected
      // dimension's short word. Scan with each dimension showing (the need
      // above already counts the wider word, so the form check is the same
      // for both). The change event re-runs _pbpVocabSyncSortFace too.
      for (const sortValue of ["latest", "az"]) {
        await scratch.evaluate((v) => {
          const select = document.getElementById("vocab-sort");
          select.value = v;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }, sortValue);
        await settleAnimations(scratch);
        const face = await scratch.evaluate(() => document.getElementById("vocab-sort-btn")?.lastElementChild?.textContent ?? null);
        if (!face) throw new Error(`SETUP ERROR [library|${theme}|${check.selector}|listHeaderFit]: #vocab-sort-btn shows no face word (${locale} ${sortValue})`);
        await pass("vocab", `${locale} ${sortValue} "${face}"`, n, selectVocab);
      }
    }
    await scratch.evaluate(() => document.documentElement.style.removeProperty("--lib-index-w"));
    await scratch.click("#lib-tab-notes");
    await scratch.waitForSelector("#notes-list .notes-hit", { timeout: TIMEOUT_MS });
    await scratch.evaluate((n) => {
      const now = Date.now();
      const items = Array.from({ length: n }, (_, i) => ({ id: `g7n${i}`, n: i + 1, quote: `quote ${i}`, color: (i % 5) + 1, note: "", ts: now - i * 60000 }));
      _notesAllRows = [{ row: { key: "pbp_hl_g7", url: "https://example.com/g7", title: "G7", lastTs: now },
        rec: { v: 1, url: "https://example.com/g7", title: "G7", items } }];
      _pbpNotesRender(true);
    }, count);
    const selectNotes = (on) => scratch.evaluate((v) => {
      _notesSelected = v ? new Set(_pbpNotesVisibleHits().map((h) => h.key)) : new Set();
      _notesLastSelectedKey = null;
      _pbpNotesSyncSelectionUi();
    }, on);
    const notesNeeds = [];
    for (const locale of LIB_INDEX_LOCALES) {
      await setLibraryLocale(scratch, extBase, locale);
      const n = await scratch.evaluate(NOTES_ROW_NEED);
      if (n == null) throw new Error(`SETUP ERROR [library|${theme}|${check.selector}|listHeaderFit]: the notes colour row is missing or hidden`);
      notesNeeds.push(`${locale} ${round2(n)}`);
      await pass("notes", locale, n, selectNotes);
    }
    notesNeedText = notesNeeds.join(", ");
  } finally {
    await closeLibScratch(page, scratch);
  }
  return { bad, need, needs, notesNeedText };
}

// G6 for the two toggle families T3's filterScrollReset does not drive. Each
// clicks the PRESSED "All" (status) / "All" (colours): the list content stays
// the same, so a scrollTop of 0 afterwards proves the handler's reset, not a
// shorter list.
async function driveScrollResetToggles(page, extBase, theme, check) {
  const bad = [];
  const cases = [
    { view: "vocab", viewport: { width: 1280, height: 900 }, region: ".vocab-list-region", click: "#vocab-stat-all", popover: true },
    { view: "notes", viewport: { width: 1280, height: 360 }, region: ".notes-list-region", click: '#notes-color-filters .lib-toggle[data-color="all"]', popover: false },
  ];
  for (const c of cases) {
    const scratch = await libScratchPage(page, extBase, theme, `g6t-${c.view}`, c.view, c.viewport);
    try {
      if (c.popover) {
        const opened = await setFilterSetOpen(scratch, true);
        if (opened === "missing" || opened === "stuck") throw new Error(`SETUP ERROR [library|${theme}|${check.selector}|filterScrollResetToggles]: #vocab-filter-set ${opened}`);
        await settleAnimations(scratch);
      }
      const before = await scratch.evaluate((sel) => { const r = document.querySelector(sel); r.scrollTop = r.scrollHeight; return r.scrollTop; }, c.region);
      if (!(before > 0)) throw new Error(`SETUP ERROR [library|${theme}|${check.selector}|filterScrollResetToggles]: ${c.region} does not scroll at ${c.viewport.width}x${c.viewport.height} (LIB_SEED too small)`);
      await scratch.click(c.click);
      await settleAnimations(scratch);
      const after = await scratch.evaluate((sel) => document.querySelector(sel).scrollTop, c.region);
      if (after !== 0) bad.push(`${c.click}: ${c.region} scrollTop ${after} after the click (was ${before})`);
    } finally {
      await closeLibScratch(page, scratch);
    }
  }
  return bad;
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
  // hide fromSel (the retired sort segment, then) at this width and the old code read a
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

// settleAnimations (flake fix, 2026-09-23; generalised from the original
// switch-track-only settleSwitchTrack): ANY state write this runner makes
// with no real user gesture behind it -- seedChecked's `.checked = ...`
// property write, classState's classList.add/remove, driveRowStates' clicks
// re-painting a row's selection band, a scripted .focus()/.blur() -- lands
// its CSS transition on one of Chromium's OTHER 3-4 contending processes
// under scripts/verify.sh's up-to-4-parallel-shard run. A fixed wait (260ms,
// 280ms) is long enough on a lightly loaded single shard, but under shard
// contention the transition can still be interpolating past it, so the very
// next computed-style read lands mid-fade: a background that reads as
// "unchanged" because the frame sampled is still close to its start value, a
// contrast ratio caught mid-mix, or (bandDistinct) a delta of 0 because two
// rows' bands are both still animating toward, not yet at, their distinct
// targets. Repro: PBP_RENDER_SHARDS=1 passes deterministically; the 4-shard
// run flakes a handful of these, different rows/themes/surfaces each run.
// Waiting on the live Animation objects instead settles exactly when the
// transition itself reports done, independent of host load.
//
// F1 (stage-1 fix wave, 2026-09-23): the original shipped as a `scope`-
// scanned `target.getAnimations({ subtree: true })`, which undercounted --
// a hover can transition an ANCESTOR of the probed element, not just the
// element itself (options.css's `.tag-gov-group-row:hover` repaints the
// ROW's background via `--motion-state`; the hovered child never gets its
// own Animation object), so a subtree-only scan can resolve while that
// ancestor transition is still mid-fade. There is no `scope` any more --
// document.getAnimations() (page-wide, the platform API's only page-wide
// form) is the only way to catch those, and it also makes a missing/stale
// scope moot: every caller settles the same page, always.
//
// Page-wide brings in animations that are never going to finish on their
// own: popup.css's `.submit-bar button.loading::before` spinner and
// `.tag-skel` shimmer, options.css's `tabBusyPulse`, are all
// infinite-iteration, so their `.finished` promise never resolves -- waiting
// on them page-wide would hang every check that runs while a loading/busy
// indicator happens to be live anywhere on the page. `getComputedTiming()
// .endTime === Infinity` marks those (per the Web Animations spec, a
// finite-iteration animation always has a finite computed endTime) and they
// are filtered out before the Promise.all, not waited on; `playState ===
// "idle"` filters animations that exist as objects but never actually
// started (an idle infinite animation still reports endTime === Infinity,
// so both checks matter independently).
//
// The finite-only filter is the intended guard, but it is deliberately not
// trusted alone: a filter is exactly the kind of thing a future finding
// could show has a gap (an animation library that reports a misleading
// endTime, a timing edge case), and "the page hangs forever" is a far worse
// failure mode for an audit script than "one check waited 2s it didn't
// need." The Promise.race against a 2000ms timeout is that second,
// independent backstop -- it should never fire in practice, but if the
// filter above ever misses a still-running infinite animation, this is what
// turns a hang into a bounded 2s delay instead.
async function settleAnimations(page) {
  await page.evaluate(() => new Promise((resolve) => {
    const settle = () => {
      const anims = document.getAnimations().filter((a) => {
        if (a.playState === "idle") return false;
        const timing = a.effect?.getComputedTiming();
        return timing?.endTime !== Infinity;
      });
      const allFinished = Promise.all(anims.map((a) => a.finished.catch(() => {})));
      const timeout = new Promise((r) => { setTimeout(r, 2000); });
      Promise.race([allFinished, timeout]).then(resolve);
    };
    // The write that triggered this settle (property write, classList
    // mutation, scripted focus/blur, a dispatched click) has no user
    // gesture behind it, so the transition it triggers may not be
    // scheduled by style recalc in this same task yet. A double rAF lets
    // recalc run and Chromium actually start the Animation before
    // getAnimations() is asked to look for one; a single rAF still raced it
    // under shard contention during this fix's own verification.
    requestAnimationFrame(() => requestAnimationFrame(settle));
  }));
  // Belt-and-braces, not the settle mechanism itself: keeps this on the same
  // side of "definitely done" as a fixed wait, for any consumer that reads
  // state immediately after without its own probe delay.
  await page.waitForTimeout(50);
}

// The probeSelector arguments for one checklist row, with the guards that
// refuse a row declaring two expect keys that share one probe slot. Built
// at the probe itself, and inside the hover hold (round 3, H), whose read IS
// the probe so the pointer state and the paint come from one page task.
function probeArgsFor(check, theme) {
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
  // widthLteWith (F2, final fix wave, Ruling 29) shares heightEqWith's
  // compareSelector probe slot the same way bgEqVar shares textContrastMulti's
  // above -- guarded the same way, for the same reason: a check declaring
  // both would silently starve one of a comparison rect it asked for.
  if (check.expect.heightEqWith?.selector && check.expect.widthLteWith?.selector) {
    throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: ` +
      `check declares BOTH heightEqWith.selector (${check.expect.heightEqWith.selector}) ` +
      `and widthLteWith.selector (${check.expect.widthLteWith.selector}) -- they share the same ` +
      `compareSelector probe slot and only one would ever be read; split into two checklist entries instead.`);
  }
  // borderRadiusPx shares insetBand.radiusVar's radiusVarName/radiusVarPx
  // probe slot (added fixwave stage2) -- same guard shape as the two above.
  if (check.expect.insetBand?.radiusVar && check.expect.borderRadiusPx?.radiusVar) {
    throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: ` +
      `check declares BOTH insetBand.radiusVar (${check.expect.insetBand.radiusVar}) ` +
      `and borderRadiusPx.radiusVar (${check.expect.borderRadiusPx.radiusVar}) -- they share the same ` +
      `radiusVarName probe slot and only one would ever be read; split into two checklist entries instead.`);
  }
  const extraBgSelectorVar = check.expect.textContrastMulti?.extraBgSelectorVar
    || check.expect.bgEqVar;
  const extraColorSelectorVar = check.expect.colorEqVar;
  if (check.expect.borderColorEqVar && check.expect.borderSidesEqVar) {
    throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: ` +
      "check declares BOTH borderColorEqVar and borderSidesEqVar -- they share the extraBorderColorVarName probe slot; split into two checklist entries instead.");
  }
  const extraBorderColorSelectorVar = check.expect.borderColorEqVar || check.expect.borderSidesEqVar;
  const radiusVar = check.expect.insetBand?.radiusVar || check.expect.borderRadiusPx?.radiusVar;
  return {
    selector: check.selector,
    compareSelector: check.expect.heightEqWith?.selector || check.expect.widthLteWith?.selector || null,
    extraBgVarName: extraBgSelectorVar ? `--${NS_BY_SURFACE[check.surface]}-${extraBgSelectorVar}` : null,
    extraColorVarName: extraColorSelectorVar ? `--${NS_BY_SURFACE[check.surface]}-${extraColorSelectorVar}` : null,
    extraBorderColorVarName: extraBorderColorSelectorVar ? `--${NS_BY_SURFACE[check.surface]}-${extraBorderColorSelectorVar}` : null,
    radiusVarName: radiusVar ? `--${NS_BY_SURFACE[check.surface]}-${radiusVar}` : null,
    childSelectors: check.expect.fusedChildrenFlat?.children || check.expect.fusedStateStableChildren || check.expect.edgeClickable?.children || null,
    focusTargetSelector: check.state === "focusWithin" ? check.focusTarget : null,
  };
}

async function runOneCheck(page, theme, check, results, extBase) {
  // F1 (final fix wave, Ruling 29, batch-end review F1): this audit runs
  // HEADED (MV3 extensions require it -- the comment on the launch call
  // below). On a real display a genuine OS-level cursor can be resting
  // anywhere over the visible Chromium window at any moment, independent of
  // anything Playwright dispatched -- Chromium reacts to that real pointer
  // exactly like a synthetic one, so it can leave an element in `:hover`
  // that no check here ever asked for. Every state OTHER than "hover"
  // assumes the pointer is parked away from whatever it is about to read;
  // without an explicit park at the very top of this function (before the
  // early-return branches below, not just before the shared probe further
  // down), a stray real cursor sitting over an element from a PRIOR check or
  // family scan -- e.g. the seeded `.stag` chip -- can leave it hovered when
  // a later "default"-state check reads its computed style. Reproduced: the
  // batch-end review's `.stag|default|bgEqVar` FAIL read btn-hover's fill
  // instead of chip-bg's, because the physical cursor happened to be
  // resting on that exact screen pixel. "hover" is exempt here because it
  // is about to move the pointer onto its OWN target two branches down;
  // parking it first would be redundant work immediately undone -- the
  // existing post-hover park (below) already resets it once that state's
  // own read is done.
  if (check.state !== "hover") {
    await page.mouse.move(0, 0);
  }
  // Per-run hover diagnostics for this row (follow-up 6; round 2 moved them
  // out of `actual` into their own field so a ledger rewrite never churns on
  // an attempt count), set by the "hover" state below.
  let hoverHarness = null;
  // The hover state's probe result: read inside the pointer hold, reused by
  // the shared evaluation below instead of a second probe.
  let hoverRaw = null;
  // seedChecked (taste-uplift batch4 T1, render-audit-checklist.mjs header):
  // pin a checkbox-driven state by writing the input's `.checked` property
  // (no change event, so options.js's autosave never fires), settle past the
  // track's --motion-state transition, and restore the original value once
  // this check has read what it needs (see the restore after the probe).
  let seedRestore = null;
  // Every exit after the seed must run this, including the hover state's
  // early SETUP return (round 2, correctness/F3): a seeded `.checked` left in
  // the DOM would be read by every later row on this page.
  const restoreSeed = async () => {
    if (!seedRestore) return;
    await page.evaluate(({ input, checked }) => {
      const el = document.querySelector(input);
      if (el) el.checked = checked;
    }, seedRestore);
    await settleAnimations(page);
  };
  if (check.state === "checked" && check.seedChecked?.checked !== true) {
    throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: state "checked" requires seedChecked: { input, checked: true }`);
  }
  if (check.seedChecked) {
    const { input, checked } = check.seedChecked;
    // type: "radio" too (stage-3b Task 1, .pick) -- writing `.checked = true`
    // on a radio input is the SAME spec-defined DOM side effect as a real
    // user click for the rest of its native `name` group (every OTHER radio
    // sharing that name is automatically un-checked, no `change` event
    // needed either), so a `.pick-mark` checked-state seed needs nothing
    // beyond what this already does for a checkbox-backed `.switch-track`.
    const prev = await page.evaluate(({ input, checked }) => {
      const el = document.querySelector(input);
      if (!el || (el.type !== "checkbox" && el.type !== "radio")) return null;
      const was = el.checked;
      el.checked = checked;
      return was;
    }, { input, checked: !!checked });
    if (prev === null) throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: seedChecked input not found or not a checkbox/radio: ${input}`);
    seedRestore = { input, checked: prev };
    // The `.switch-track` transition this settles lives on the row wrapping
    // the checkbox, not the checkbox itself (switchRules,
    // docs/theme-surface/composers/ui-components.mjs) -- settleAnimations
    // waits page-wide (F1, stage-1 fix wave) so that no longer needs a
    // resolved row handle.
    await settleAnimations(page);
  }
  // T8e: the notes half of G5 (spec 2026-10-03-library-redesign §9.2). Ahead
  // of T7's branch on purpose: the vocabulary libGeometry driver does not
  // know `view: "notes"`. (G4's notes half needs no branch: T7b's
  // driveDisplayInkTop dispatches on view through LIB_INK_VIEWS.)
  if (check.state === "libGeometry" && check.expect.libGeometry?.view === "notes") {
    const { bad, measured } = await driveNotesGeometry(page, extBase, theme, check);
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("libGeometry", bad.length === 0 && measured > 0, bad.length, 0,
        bad.length ? bad.slice(0, 4).join("; ") : `${measured} notes states measured`) });
    return;
  }
  if (check.state === "headerRowsFlush") {
    const { bad, worst } = await driveHeaderRows(page, check, theme);
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("headerRowsFlush", bad.length === 0, worst, check.expect.headerRowsFlush.tolerancePx ?? 1,
        bad.length ? bad.slice(0, 4).join("; ") : undefined) });
    return;
  }
  if (check.state === "displayInkTop" || check.state === "detailNegMargin" || check.state === "libGeometry") {
    // Default and terminal only: the checklist rows carry T3's top-level
    // `themes: ["", "terminal"]`, which main() filters on before this runs
    // (spec §9.2, same matrix as G1).
    const drive = { displayInkTop: driveDisplayInkTop, detailNegMargin: driveDetailNegMargin, libGeometry: driveLibGeometry }[check.state];
    const bad = await drive(page, check, extBase, theme);
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict(check.state, bad.length === 0, bad.length, 0, bad.length ? bad.slice(0, 4).join("; ") : undefined) });
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
  if (check.state === "noPageScroll") {
    const hits = await driveNoPageScroll(page, check, extBase, theme);
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("noPageScroll", hits.length === 0, hits.length, 0, hits.length ? hits.slice(0, 4).join("; ") : undefined) });
    return;
  }
  if (check.state === "filterScrollReset") {
    const hits = await driveFilterScrollReset(page, check, extBase, theme);
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("filterScrollReset", hits.length === 0, hits.length, 0, hits.length ? hits.slice(0, 4).join("; ") : undefined) });
    for (const row of hits.pickRows || []) results.push(row);
    return;
  }
  if (check.state === "libAxis") {
    const hits = await driveLibAxis(page, check, extBase, theme);
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("libAxis", hits.length === 0, hits.length, 0, hits.length ? hits.slice(0, 4).join("; ") : undefined) });
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
  if (check.state === "visibleRowCount") {
    const r = await driveVisibleRowCount(page, extBase, theme, check);
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("visibleRowCount", r.ok, r.actual, r.expected, r.note) });
    return;
  }
  if (check.state === "focusRowVisible") {
    const bad = await driveFocusRowVisible(page, extBase, theme, check);
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("focusRowVisible", bad.length === 0, bad.length, 0, bad.length ? bad.slice(0, 4).join("; ") : undefined) });
    return;
  }
  if (check.state === "hangOrder") {
    const { bad, stats } = await driveHangOrder(page, extBase, theme, check);
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("hangOrder", bad.length === 0, bad.length, 0,
        [bad.length ? bad.slice(0, 6).join("; ") : null, `${stats.measured} measurements, up to ${stats.labels} labels, ${Math.round(stats.ms / 1000)}s`].filter(Boolean).join(" | ")) });
    return;
  }
  if (check.state === "listHeaderFit") {
    // `actual` carries the width the wide filter row needs at its widest
    // locale; the note lists every locale's, and the notes colour row's.
    const { bad, need, needs, notesNeedText } = await driveListHeaderFit(page, extBase, theme, check);
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("listHeaderFit", bad.length === 0, `wide filter row needs ${round2(need.px)}px (${need.locale})`,
        "every header child inside the index and its group, no overlaps; count items whole; vocabulary batch row 64/56, notes one or two sm rows; form = measured fit",
        [bad.length ? bad.slice(0, 4).join("; ") : null, `needs: ${needs.join(", ")}`, `notes colour row: ${notesNeedText}`].filter(Boolean).join(" | ")) });
    return;
  }
  if (check.state === "filterScrollResetToggles") {
    const bad = await driveScrollResetToggles(page, extBase, theme, check);
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("filterScrollResetToggles", bad.length === 0, bad.length, 0, bad.length ? bad.join("; ") : undefined) });
    return;
  }
  if (check.state === "filterPopoverKeys") {
    const bad = await driveFilterPopoverKeys(page, theme, check);
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("filterPopoverKeys", bad.length === 0, bad.length, 0, bad.length ? bad.join("; ") : undefined) });
    return;
  }
  if (check.state === "arrowDown") {
    // A TRUSTED ArrowDown on a native radio group (stage-3b final review N2):
    // the .pick recipe hides the radio with opacity 0 but must not break
    // native group navigation. Restored with a trusted ArrowUp (and a click
    // back if the group started elsewhere) so the DOM lands where it began --
    // but every trusted key also fires a real `change` event, which options.js
    // arms on a 500ms debounce (scheduleAutoSave). This row runs inside the
    // shared tab loop with no reload between rows, so a pending save (and its
    // "Saved" toast) would otherwise fire ~500ms later under whatever row is
    // measured next (final review S3). Flush it explicitly via the same
    // window.pbpOptionsFlushAutoSave() hook the listbox tests use, then verify
    // the flush actually landed the ORIGINAL value in storage rather than just
    // trusting the restore click.
    const expectChecked = check.expect.arrowDown.checked;
    const prior = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el || el.type !== "radio" || !el.name) return null;
      const checkedEl = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)].find((r) => r.checked);
      el.focus();
      return { focused: document.activeElement === el, was: checkedEl?.id || null, wasValue: checkedEl?.value ?? null };
    }, check.selector);
    if (!prior?.focused) throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: could not focus the radio`);
    await page.keyboard.press("ArrowDown");
    await settleAnimations(page);
    const got = await page.evaluate((sel) => document.querySelector(sel)?.checked === true, expectChecked);
    await page.keyboard.press("ArrowUp");
    await settleAnimations(page);
    await page.evaluate((was) => {
      if (was && !document.getElementById(was)?.checked) document.getElementById(was)?.click();
      document.activeElement?.blur();
    }, prior.was);
    await page.evaluate(() => window.pbpOptionsFlushAutoSave?.());
    await settleAnimations(page);
    if (prior.wasValue !== null) {
      // bgSaveMode is deliberately absent from storage until its own writer
      // sets it (shared.js's PRIME_EXCLUDED_KEYS) -- a flush whose collected
      // form value matches the already-persisted baseline can legitimately
      // leave the key unwritten (pbpSaveOptionsSnapshot only persists the
      // delta), so `undefined` here is not a restore failure, it is "still
      // the default merge". Every real consumer (background.js's tri-state
      // whitelists, options.js's own `|| 'merge'`) applies the same fallback.
      const persisted = await page.evaluate(async () => {
        const local = await chrome.storage.local.get(["bgSaveMode"]);
        if (local.bgSaveMode !== undefined) return local.bgSaveMode;
        const synced = await chrome.storage.sync.get(["bgSaveMode"]);
        return synced.bgSaveMode;
      });
      const effective = persisted ?? "merge";
      if (effective !== prior.wasValue) {
        throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: bgsave-mode restore did not persist -- chrome.storage effectively has ${JSON.stringify(effective)} (raw ${JSON.stringify(persisted)}), expected the pre-row value ${JSON.stringify(prior.wasValue)}`);
      }
    }
    results.push({ surface: check.surface, theme, selector: check.selector, state: check.state,
      ...verdict("arrowDown", got, got ? expectChecked : "(not checked)", expectChecked) });
    return;
  }
  if (check.state === "rowStates") {
    if (!extBase) throw new Error(`rowStates check on ${check.selector} reached a runner that has no extBase`);
    let samples;
    try {
      samples = await driveRowStates(page, extBase, theme, check.selector, check.expect.bandDistinct?.textSelectors);
    } catch (err) {
      if (!err.rowStateHold) throw err;
      // A pointer state that never held is a HARNESS condition, not a
      // product verdict (same SETUP row as family 14 and the `hover` state).
      const { state, mode, hold } = err.rowStateHold;
      results.push({
        surface: check.surface, theme, selector: check.selector, state: check.state,
        check: "bandDistinct", status: "SETUP", setup: hold.kind,
        actual: `"${state}": ${mode === "rest" ? "the rest state (pointer parked outside, focus elsewhere)" : ":hover with focus elsewhere"} did not hold through the read in ${hold.attempts} attempt(s) -- ${describeHoldTries(hold.tries, mode)}`,
        expected: "the real pointer's :hover reaches the driven row with focus elsewhere, and leaves it at rest, undisturbed through each of the eight reads (harness precondition for bandDistinct)",
        note: holdSetupNote(hold),
      });
      return;
    }
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
    // Task 16), and a fixed 260ms wait was not immune to the same race under
    // heavier shard contention (2026-09-23: submit-btn bgChangedFromRest
    // FAILs on flexoki-light/-dark, textContrast 1.47 on terminal, all
    // reading `.btn`'s background/text mid-fade). settleAnimations waits on
    // the transition's own finished promise instead of a guessed duration.
    await settleAnimations(page);
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
    // Same settle discipline as focusWithin below: `.btn`'s
    // `transition: background var(--pp-motion-state), ...` means a read
    // taken in the same task as classList.add() can land mid-interpolation
    // instead of at the transition's target value.
    await settleAnimations(page);
  }
  if (check.state === "focusWithin") {
    if (!check.focusTarget) throw new Error(`focusWithin check on ${check.selector} has no focusTarget`);
    // The unfocused baseline (focusRecipe's "did the focus rule fire",
    // fusedStateStable's REST pass) is read through the same rest pointer
    // hold family 14 uses (stage 4 Task 6, spec §5.1), on every surface: the
    // fused shells popup and library ship now carry a HOVER fill and frame,
    // and a baseline read while the host's OS pointer happens to sit on the
    // shell (the WSLg trusted-event mechanism at holdPointerState) would
    // record the hover paint -- which focus then excludes, so the diff reads
    // as a product FAIL. The hold parks the pointer outside the element,
    // blurs focus inside it, and only accepts a read the pointer did not
    // disturb; one that never holds is a `focusBaselineRest` SETUP row.
    // The REST pass for fusedStateStable is taken through the same probe
    // the focused pass uses, so the two snapshots are structurally identical
    // and a diff can only mean the CSS changed something.
    const baseHandle = await page.$(check.selector);
    if (!baseHandle) throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: focusWithin target not found`);
    const baseHold = await holdPointerState(page, baseHandle, async () => {
      const base = await page.evaluate(({ selector }) => {
        const el = document.querySelector(selector);
        const cs = getComputedStyle(el);
        const n = document.activeElement;
        return {
          borderColors: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor].join("|"),
          boxShadow: cs.boxShadow,
          outlineStyle: cs.outlineStyle,
          hovered: el.matches(":hover"),
          focused: el.matches(":focus-within"),
          active: n ? `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${[...(n.classList || [])].map((c) => `.${c}`).join("")}` : "null",
          at: performance.now(),
        };
      }, { selector: check.selector });
      if (check.expect.fusedStateStable !== true) return base;
      const rest = await page.evaluate(probeSelector, {
        selector: check.selector, compareSelector: null, extraBgVarName: null, extraColorVarName: null, radiusVarName: null,
        childSelectors: check.expect.fusedStateStableChildren || null,
        focusTargetSelector: null,
      });
      // Judged on BOTH reads: the pointer must be off the element in each,
      // and the foreign-event window runs up to the later one.
      return {
        ...base, stability: rest.stability || null,
        hovered: base.hovered || !!rest.pointer?.hovered,
        focused: base.focused || !!rest.pointer?.focused,
        at: rest.pointer?.at ?? base.at,
      };
    }, "rest");
    await baseHandle.dispose();
    if (!baseHold.ok) {
      await restoreSeed();
      results.push({
        surface: check.surface, theme, selector: check.selector, state: check.state,
        check: "focusBaselineRest", status: "SETUP", setup: baseHold.kind,
        actual: `the rest state (pointer parked outside, focus elsewhere) did not hold through the unfocused baseline read in ${baseHold.attempts} attempt(s) -- ${describeHoldTries(baseHold.tries, "rest")}`,
        expected: "the unfocused baseline of a focusWithin row is read with the real pointer parked outside the element and focus elsewhere, undisturbed (harness precondition for focusRecipe / fusedFocusRing / fusedStateStable)",
        note: holdSetupNote(baseHold),
      });
      return;
    }
    focusBaseline = { borderColors: baseHold.got.borderColors, boxShadow: baseHold.got.boxShadow, outlineStyle: baseHold.got.outlineStyle };
    stabilityBaseline = baseHold.got.stability ?? null;
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
    await settleAnimations(page);
  } else if (check.state === "hover") {
    // Real mouse hover (not a class hack): real pointer events, so the live
    // cascade's own `:hover` match drives getComputedStyle exactly the way a
    // real user's cursor would -- no need to fake it by toggling a class the
    // CSS never checks for. Through the same pointer hold as family 14
    // (round 3, H -- holdPointerState has the root cause): the hold's read IS
    // this row's probe, after the settle (buttons transition background /
    // color over --*-motion-state; an unsettled read can serialize the 0%
    // frame as transparent oklab()), so the pointer and focus state are
    // judged in the same page task as the paint the assertions below read.
    // A state that never holds is a SETUP row, not a verdict, and its
    // assertions are skipped.
    const handle = await page.$(check.selector);
    if (!handle) throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: hover target not found`);
    const hold = await holdPointerState(page, handle, async () => {
      await settleAnimations(page);
      const probed = await page.evaluate(probeSelector, probeArgsFor(check, theme));
      return { ...(probed.pointer || {}), probed };
    }, "hover");
    await handle.dispose();
    if (!hold.ok) {
      await page.mouse.move(0, 0);
      await restoreSeed();
      results.push({
        surface: check.surface, theme, selector: check.selector, state: check.state,
        check: hold.kind === "focusDuringHover" ? "hoverUnfocused" : "hoverApplied", status: "SETUP", setup: hold.kind,
        actual: `:hover with focus elsewhere did not hold through the read in ${hold.attempts} attempt(s) -- ${describeHoldTries(hold.tries, "hover")}`,
        expected: "the real pointer's :hover reaches the probed element with focus elsewhere, undisturbed through the read (harness precondition for this row's hover assertions)",
        note: holdSetupNote(hold),
      });
      return;
    }
    hoverRaw = hold.got.probed;
    const lastTry = hold.tries[hold.tries.length - 1];
    hoverHarness = `:hover=true, focus=false (activeElement ${lastTry.active}), attempt ${hold.attempts}${hold.attempts > 1 ? ` (${describeHoldTries(hold.tries.slice(0, -1), "hover")})` : ""}`;
  } else if (check.state === "open") {
    // "open" (Task 4, ui-system-stage2, Controller ruling C): a reusable
    // click-then-measure state for anything that stays hidden/zero-size
    // until revealed, driven via a REAL keyboard Space press on the focused
    // `open.click` target rather than a raw `.click()` -- this doubles as a
    // real-keyboard-path gate (the listbox's WAI-ARIA "select-only
    // combobox" contract, listbox.js's onKeydown " " branch) rather
    // than only exercising the mouse click listener the way `page.click()`
    // would. Script-focus + one real key is the same idiom focusWithin uses
    // above.
    if (!check.open?.click) throw new Error(`"open" state on ${check.selector} has no open.click target`);
    const { click: openTarget } = check.open;
    const focused = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      return document.activeElement === el;
    }, openTarget);
    if (!focused) throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: could not focus open.click target ${openTarget}`);
    await page.keyboard.press("Space");
    await settleAnimations(page);
    const opened = await page.evaluate((sel) => document.querySelector(sel)?.getAttribute("aria-expanded") === "true", openTarget);
    if (!opened) throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: pressing Space on ${openTarget} did not open it (aria-expanded stayed false)`);
  } else if (check.state !== "default" && check.state !== "classState" && check.state !== "checked") {
    throw new Error(`unsupported state "${check.state}" on ${check.selector} -- extend runOneCheck() before adding non-default states to the checklist`);
  }
  const raw = hoverRaw ?? await page.evaluate(probeSelector, probeArgsFor(check, theme));
  if (focusBaseline) raw.focusBaseline = focusBaseline;
  if (stabilityBaseline) raw.stabilityBaseline = stabilityBaseline;
  if (restBgStack) raw.restBgStack = restBgStack;
  await restoreSeed();
  if (check.state === "classState") {
    // Same discipline as the hover-pointer reset below: leaving the class on
    // would leak into the next check that reads this same element in its
    // "default" state.
    await page.evaluate(({ selector, cls }) => {
      document.querySelector(selector)?.classList.remove(...cls);
    }, { selector: check.selector, cls: check.addClass });
  }
  if (check.state === "open") {
    // Close it again (real Escape, the same key listbox.js's
    // onKeydown already handles) so a left-open popover does not leak into
    // whatever the NEXT check on this page reads -- same leave-no-state-
    // behind discipline as classState/focusWithin/hover around this block.
    await page.keyboard.press("Escape");
    await settleAnimations(page);
  }
  if (check.state === "focusWithin") {
    // Blur before the next check reads anything: a left-over :focus-within on
    // this shell would leak its focused border-colour into every later
    // default-state read on the same page, exactly the way a parked mouse
    // pointer leaks :hover (see the hover reset just below).
    await page.evaluate(() => document.activeElement?.blur());
    // Must settle past the SAME transition the focus read above waits on. At
    // a fixed 120ms the next check's "unfocused baseline" was captured
    // mid-fade: measured `rgba(51,255,51,0.004) 0 0 0.04px` and interpolated
    // oklab() border colours, i.e. a shell that looked like it had reacted
    // to focus when it had merely not finished un-reacting -- that reads as
    // a real difference to any assertion comparing rest against focus, and a
    // fixed wait (260ms afterwards) was still a guess about how long the
    // transition takes to finish under shard contention.
    await settleAnimations(page);
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
    // A hover-state row carries what the pointer/focus state was when it was
    // read (a harness miss is a SETUP row above, never a FAIL), so a flake
    // can be told apart -- in `harness`, not `actual`: the ledger writer
    // copies actual/expected/note verbatim, and an attempt count there would
    // churn every rewrite (round 2, correctness/F6).
    results.push({ surface: check.surface, theme, selector: check.selector, state, ...r, ...(hoverHarness ? { harness: hoverHarness } : {}) });
  }
}

// ---- library.html has two independent master-detail views behind one tab
// strip; a selector's prefix tells us which view to be on and whether a row
// needs clicking open first. Every "*-detail-*" selector lives in a detail
// pane that starts on its cover, and so does every "*-ref*" one: the
// dictionary column's result host only holds a word's state once a word is
// open (library redesign T7). ----
function libraryView(selector) { return selector.startsWith(".notes-") ? "notes" : "vocab"; }
function needsDetailOpen(selector) { return selector.includes("-detail-") || selector.includes("-ref"); }
// .vocab-batch-bar (library.css:986-1010, ".selecting") is height:0/hidden
// until a row is selected. Every id living in that bar needs the same
// precondition -- named explicitly rather than inferred from `expect`
// shape, since hitAreaMin/heightEqWith checks both land there and a third
// check type will land there again eventually.
const BATCH_BAR_SELECTORS = new Set([
  "#vocab-group-input", "#vocab-add-group", "#vocab-remove-group",
  "#vocab-invert-selection", "#vocab-mark-known", "#vocab-mark-learning",
  "#vocab-batch-delete", "#vocab-clear-selection",
  "#vocab-batch-select-all", "#vocab-batch-toolbar",
  // §8 fused-control entries probe the shell, not the ids inside it.
  "#vocab-batch-toolbar .vocab-group-unit",
]);
function needsBatchBarOpen(selector) { return BATCH_BAR_SELECTORS.has(selector); }
// Notes twin (T4d): .notes-batch-bar is display:none until a hit is
// Ctrl+clicked into the selection.
const NOTES_BATCH_BAR_SELECTORS = new Set([".notes-batch-bar"]);
function needsNotesBatchBarOpen(selector) { return NOTES_BATCH_BAR_SELECTORS.has(selector); }
// Open / close the vocabulary batch row with the user's own gestures:
// Ctrl+click a row head (the per-row checkbox went away 2026-08-06; the
// modified click is the only way in -- it leaves the reading pane alone),
// Clear to leave. Afterwards the pointer is parked and focus dropped, so the
// next check starts from a neutral page either way. Throws on a missing
// target, like every other setup opener here.
async function setVocabBatchOpen(page, theme, open) {
  const isOpen = () => page.evaluate(() => !!document.querySelector("#vocab-batch-toolbar.selecting"));
  if ((await isOpen()) === open) return;
  if (open) {
    const head = page.locator("#vocab-list .vocab-card .notes-card-head").first();
    if (!(await head.count())) {
      throw new Error(`SETUP: no "#vocab-list .vocab-card .notes-card-head" to reveal .vocab-batch-bar (theme=${theme}) -- seed fixture broken or markup renamed`);
    }
    await head.click({ modifiers: ["Control"] });
  } else {
    const clear = page.locator("#vocab-clear-selection");
    if (!(await clear.count())) {
      throw new Error(`SETUP: no "#vocab-clear-selection" to close .vocab-batch-bar (theme=${theme}) -- markup renamed`);
    }
    await clear.click();
  }
  await page.waitForFunction((want) => !!document.querySelector("#vocab-batch-toolbar.selecting") === want, open, { timeout: TIMEOUT_MS });
  await page.mouse.move(0, 0);
  await page.evaluate(() => { const a = document.activeElement; if (a && a !== document.body && typeof a.blur === "function") a.blur(); });
  await settleAnimations(page);
}
// .vocab-note-save (Task 4, taste-uplift-batch2 -- COMPONENTS.md §1.2 primary
// tier): the detail-open click above is not enough to reveal it. It starts
// `hidden` (visibility, not display -- library.css) until the note textarea's
// value diverges from the word's saved note, so the cheapest REAL reveal is
// typing into the field the same way a user would, letting the existing
// `input` listener flip `.hidden` itself -- not toggling the DOM property
// directly, which would exercise a path the actual UI never takes.
function needsNoteDirty(selector) { return selector.includes("vocab-note-save"); }
// The detail's group editor (library redesign T7, spec §4.5) starts collapsed:
// its fused group unit and the removable chips render only after "Edit
// groups". Re-asserted per row, like needsNoteDirty, because driveRowStates
// reloads the page partway through the batch.
function needsGroupEditorOpen(selector) {
  return /\.vocab-detail-pane \.vocab-group-(?:unit|step)|\.vocab-detail-group-chips|#vocab-detail \.vocab-group-unit|\.vocab-edit-groups\[aria-expanded="true"\]/.test(selector);
}
// Library redesign T4b: at the runner's 1280 viewport the index is 360 wide,
// so the group filter and the three status toggles live in the closed
// "Filter" popover (spec §3.4). Open it with showPopover() -- no pointer move,
// no focus move -- right before a check that reads one of them, and close it
// right after, so no other check ever measures under an open top-layer panel.
// `open`-state rows open it themselves through the real button.
// T6: the group filter is measured as its listbox button (the native select
// is the hidden carrier).
const FILTER_SET_SELECTORS = new Set(["#vocab-group-filter-btn", "#vocab-stat-all", "#vocab-stat-learning", "#vocab-stat-known"]);
function needsFilterSetOpen(check) {
  return FILTER_SET_SELECTORS.has(check.selector) && ["default", "hover", "focusWithin"].includes(check.state);
}
async function setFilterSetOpen(page, open) {
  return page.evaluate((want) => {
    const set = document.getElementById("vocab-filter-set");
    const btn = document.getElementById("vocab-filter-narrow");
    if (!set || !btn) return "missing";
    if (getComputedStyle(btn).display === "none") return "inline";
    const isOpen = set.matches(":popover-open");
    if (want && !isOpen) set.showPopover();
    if (!want && isOpen) set.hidePopover();
    return set.matches(":popover-open") === want ? "ok" : "stuck";
  }, open);
}

// ---- The Filter popover (spec §3.4, library redesign T4/T6). Whenever the
// index takes its narrow form (data-header-fit="narrow": the filter row's
// own content does not fit it on one line -- the runner's 1280 viewport with
// the seeded counts, and everything at or under 860px), the group listbox
// (and T4's status toggles) live in the closed #vocab-filter-set auto
// popover. A row that reads anything inside it opens it first, the way a
// user does (a real click on #vocab-filter-narrow), and closes it again so it
// never covers the next row's element. Returns whether it opened the popover
// (false in the wide form, where the element is inline and rendered).
async function libRevealFilterSet(page, selector) {
  const needs = await page.evaluate((sel) => {
    let el = null;
    try { el = document.querySelector(sel); } catch (_) { return false; } // a label-style selector ("x (narrow)") is no CSS
    const set = document.getElementById("vocab-filter-set");
    if (!el || !set || !set.contains(el)) return false;
    return !set.matches(":popover-open") && el.getClientRects().length === 0;
  }, selector);
  if (!needs) return false;
  await page.click("#vocab-filter-narrow");
  await page.waitForFunction(() => document.getElementById("vocab-filter-set")?.matches(":popover-open"), null, { timeout: TIMEOUT_MS });
  await settleAnimations(page);
  return true;
}
async function libHideFilterSet(page) {
  await page.evaluate(() => {
    const set = document.getElementById("vocab-filter-set");
    if (set && set.matches(":popover-open")) set.hidePopover();
  });
  await settleAnimations(page);
}
// Picks option `index` of an enhanced select the way a user does: real
// clicks on its button and on the option, revealing the Filter popover first
// when the select lives in it. That pick must not light-dismiss the Filter
// popover around the nested listbox (spec §14: the option is a DOM descendant
// of the auto popover) -- recorded as its own row, because the defect only
// shows with trusted pointer events, which no test page can send.
// `nested: false` is for a listbox that never lives in the Filter popover
// (the sort menu button, T6b): no reveal is expected and no row is recorded.
async function libPickListboxOption(page, results, theme, selectId, index, { nested = true } = {}) {
  const btnSel = `#${selectId}-btn`;
  const revealed = await libRevealFilterSet(page, btnSel);
  await page.click(btnSel);
  const opt = page.locator(`#${selectId}-list .listbox-opt`).nth(index);
  await opt.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  await opt.click();
  await settleAnimations(page);
  if (!nested) return;
  if (!revealed) {
    // Never a silent skip (T6a fix round 1): the nested-popover row only
    // means something when the pick happened inside the Filter popover. A
    // wide-form index (the button inline) cannot exercise it, so the row
    // reports that instead of vanishing.
    const fit = await page.evaluate(() => document.getElementById("vocab-list-pane")?.dataset.headerFit ?? null);
    results.push({ surface: "library", theme, selector: "#vocab-filter-set", state: "filterScrollReset",
      ...verdict("filterSetSurvivesPick", false, `not revealed (data-header-fit=${fit})`, "picked inside the open Filter popover",
        `${btnSel} was not inside a closed Filter popover, so the nested-popover pick was never made -- the probe viewport must leave the index narrow`) });
    return;
  }
  const stillOpen = await page.$eval("#vocab-filter-set", (el) => el.matches(":popover-open"));
  results.push({ surface: "library", theme, selector: "#vocab-filter-set", state: "filterScrollReset",
    ...verdict("filterSetSurvivesPick", stillOpen, stillOpen ? "open" : "light-dismissed", `open after picking ${btnSel}'s option ${index}`) });
  await libHideFilterSet(page);
}

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
    // Stage 4 Task 6: popup's value boxes paint the field fills now.
    prefix: "pp", textRoles: ["fg-hint", "fg-muted", "link"], fillRoles: ["btn-bg", "btn-hover", "input-bg", "chip-bg", "field-bg", "field-bg-hover", "field-bg-focus"],
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
  // Stage 4 (spec 2026-09-30-ui-fields-stage4-design §3.1): the options value
  // boxes' own fills join the scan -- field-bg / -hover / -focus are control
  // fills like input-bg, and COMPONENTS.md §9.1 law 8 keeps weak inks off them.
  options: {
    prefix: "opt", textRoles: ["fg-hint", "fg-muted", "link"], fillRoles: ["btn-bg", "btn-hover", "input-bg", "chip-bg", "field-bg", "field-bg-hover", "field-bg-focus"],
    safeHostRoles: ["bg", "panel", "pf-bg", "code-bg"],
    safeHostExcludeTextRoles: ["link"],
  },
  // library additionally gates its seven S2 row fills (spec 2026-10-03-
  // library-redesign §6.4 / §9.3), read LIVE as tokens like every other fill
  // -- since S2 the composer emits them (deriveRowStates), so there is no
  // runtime color-mix() left to re-derive here. library's fg-hint/fg-muted are
  // gated (auditLibraryThemes) only against bg/panel; link IS gated vs
  // bg/panel (auditLibraryThemes), so it stays eligible for the safe-host
  // exemption -- no exclusion list.
  // Stage 4 Task 7 (T7-f): library's value boxes paint the field fills now.
  library: {
    prefix: "lib", textRoles: ["fg-hint", "fg-muted", "link"],
    fillRoles: ["btn-bg", "btn-hover", "input-bg", "chip-bg", "field-bg", "field-bg-hover", "field-bg-focus",
      "row-bg-hover", "row-current-bg", "row-current-bg-hover", "row-band-bg", "row-band-bg-hover", "row-band-current-bg", "row-band-current-bg-hover"],
    safeHostRoles: ["bg", "panel"],
    // --lib-row-selected-fg / --lib-row-current-fg-muted are DERIVED
    // specifically for the row fills (library-chrome.mjs, fgToAAMulti over
    // the six highlight fills / the current pair): an element that reads one
    // of them is correctly painted regardless of which OTHER role's value it
    // happens to also equal (terminal collapses fg / accent / link /
    // row-selected-fg to #33ff33; paper-ink and terminal keep
    // row-current-fg-muted == fg-muted). Still ratio-gated in
    // recordWeakTextHits like every identity trigger.
    safeTextRoles: ["row-selected-fg", "row-current-fg-muted"],
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
    // (caught live: the retired sort segment's pressed-cell mix was
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
  // sanctioned tokens. library's --lib-row-selected-fg / --lib-row-current-fg-muted are
  // unconditional for the same reason (S2, derived against the row fills); `accent` is conditional on
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
  // F1 (final fix wave, Ruling 29): same "once before each family scan
  // pass" park runFamilySweep gives sweepProbe -- weakTextProbe is the
  // family-13 equivalent, one evaluate() round-trip over every matched
  // element on the page, with no pointer API of its own.
  await page.mouse.move(0, 0);
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

// ---- fieldHoverContrast (family 14; stage 3c final review B1, rebuilt for
// the B+ field family 2026-09-28 and again for stage 4 2026-09-30). spec
// docs/superpowers/specs/2026-09-30-ui-fields-stage4-design.md §2 / §5.1,
// COMPONENTS.md §6.1 / §9.1 law 9: a value box is announced by its FILL --
// there is no bottom edge -- so the sweep reads, with the real pointer
// parked (rest) and on the box (hover), after its own transitions finish:
// the box's composited fill, the backdrop behind it, and all four border
// sides. Verdicts, one OK/FAIL row per (theme, control):
//   every box   -- at rest and on hover all four sides are painted (width >
//                  0, style not none/hidden) and identical (colour, width,
//                  style): the render proof that no side is drawn apart;
//   fill step   -- every theme outside FIELD_UNSEPARATED_FRAMED: F1 rest
//                  fill vs backdrop, F2 hover fill vs rest fill, F3 hover
//                  fill vs backdrop, each >= FILL_SEPARATE_MIN (spec §2.3);
//   frame step  -- a FIELD_UNSEPARATED_FRAMED theme (a pilot frame whose
//                  fill does not separate from its hosts; deriveFieldRoles
//                  keeps that fill on hover): the box paints a frame
//                  distinct from its fill, the fill holds on hover, and the
//                  hover frame steps >= FIELD_FRAME_HOVER_MIN (contrast) and
//                  >= FIELD_FRAME_HOVER_MIN_DE (CIEDE2000) against the rest
//                  frame and reads stronger on the fill than the rest frame.
// The class is pinned by name, not re-derived from the measured ratios (spec
// §2.4): a palette that drifts across FILL_SEPARATE_MIN then FAILs one rule
// or the other instead of silently swapping which rule judges it.
// Population: every visible enabled text-entry control in the active panel
// (wider than the CSS :is() list on purpose, so a field that escapes the
// family is caught) plus the drawn listbox button.
const FIELD_HOVER_SEL = [
  "input:not([type])", 'input[type="text"]', 'input[type="password"]', 'input[type="number"]',
  'input[type="search"]', 'input[type="url"]', 'input[type="email"]', 'input[type="tel"]', "textarea", "button.listbox-btn",
].map((s) => `.panel.active ${s}`).join(", ");
// The kinds the family actually ships; every theme must reach at least one
// of each or the sweep is vacuous for that kind (SETUP ERROR). Family 9's
// value-box radius law requires the same kinds on options.
const FIELD_HOVER_REQUIRED_KINDS = ['input[type="text"]', 'input[type="password"]', 'input[type="number"]', "textarea", "button.listbox-btn"];
// Family 9 also requires the sidebar search box on options (stage 4 Task 4:
// it joined the value boxes at rest and on focus; it has no hover, so it is
// not one of family 14's kinds).
// Popup (stage 4 Task 6, T6-b): its six value boxes by name -- the sweep
// keys popup's value-box kinds by the SWEEP_CFG valueBoxes entry a box
// matches (radiusScale.valueBoxKindByEntry), since three of them are plain
// text inputs a tag/type kind could not tell apart.
// Library (stage 4 Task 7, T7-b): the kinds its sweep legs render -- the
// three search fields, the group filter's listbox button (family 9 meets it
// in the sweep's vocab-filter-set context), the note editor and the
// .vocab-group-unit shells (keyed by tag/type, or by class for the <span>
// shell).
const RADIUS_VALUE_BOX_REQUIRED = Object.freeze({
  options: Object.freeze([...FIELD_HOVER_REQUIRED_KINDS, 'input[type="search"]']),
  popup: Object.freeze(["#url-input", "#title-input", "#description-input", ".tags-input-wrap", "#token-input", "#search-input"]),
  library: Object.freeze(['input[type="search"]', "button.listbox-btn", "textarea", ".vocab-group-unit"]),
});
// Themes whose value boxes are framed and NOT separated from their hosts, per
// surface (spec 2026-09-30-ui-fields-stage4-design §2.2 / §2.4): the fill
// holds on hover and the frame carries it.
const FIELD_UNSEPARATED_FRAMED = Object.freeze({
  options: Object.freeze(["terminal", "rose-pine"]),
  // popup (stage 4 Task 6): terminal's pilot frame on a fill that sits 1.05:1
  // from --pp-bg. The popup leg re-measures the class from the tokens and
  // FAILs a theme whose measured class differs from this list.
  popup: Object.freeze(["terminal"]),
  // library (stage 4 Task 7): terminal's pilot frame on a fill that does not
  // separate from --lib-panel / --lib-bg; the hover frame is
  // mix(frame, fg, .30) = #228222.
  library: Object.freeze(["terminal"]),
});
// The frame-step floors for those themes (contrast ratio and CIEDE2000 of
// the hover frame against the rest frame, both composited over the fill):
// spec 2026-09-30-ui-fields-stage4-design §2.3 F8, the same floors
// tests/theme-ui-derive-tests.mjs holds the derivation to (F8_MIN_RATIO /
// F8_MIN_DE). deriveFieldRoles paints that hover frame as mix(frame, fg,
// FRAMED_HOVER_FG_MIX = .30): options terminal #1a4d1a -> #228222 (about
// 2.02:1, ΔE2000 18.0), rose-pine #403d52 -> #706d83 (about 2.09:1, ΔE2000
// 17.0). The B+ one-step fillSeparate frame (1.114 / 1.115, ΔE2000 2.74 /
// 2.33) fails both floors: a frame that alone announces hover has to be
// seen to move. Module-level so the popup / library value-box legs read the
// same two floors.
const FIELD_FRAME_HOVER_MIN = 1.30;
const FIELD_FRAME_HOVER_MIN_DE = 6;
const fieldHoverScanLog = [];

// Runs INSIDE the page (element handle evaluate) -- self-contained.
async function readFieldPaint(el) {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  el.getAnimations().forEach((a) => { try { a.finish(); } catch { /* infinite/idle: nothing to finish */ } });
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const chain = [];
  for (let n = el.parentElement; n; n = n.parentElement) chain.push(getComputedStyle(n).backgroundColor);
  const tag = el.tagName.toLowerCase();
  const kind = tag === "textarea" ? "textarea"
    : tag === "button" ? "button.listbox-btn"
    : (el.hasAttribute("type") ? `input[type="${el.getAttribute("type")}"]` : "input:not([type])");
  let path = el.id ? `#${el.id}` : null;
  if (!path) {
    const parts = [];
    for (let n = el; n && !n.classList?.contains("panel"); n = n.parentElement) parts.unshift(`${n.tagName.toLowerCase()}:${[...n.parentElement.children].indexOf(n) + 1}`);
    path = `${el.closest(".panel")?.id || "?"}>${parts.join(">")}`;
  }
  return {
    path, kind,
    visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
    disabled: !!el.disabled,
    own: cs.backgroundColor, chain,
    // All four sides (stage 4): colour, computed width and style, so the
    // verdict can prove every side is PAINTED and none is drawn apart. With
    // width 0 or style none/hidden Chromium still reports a side's colour
    // (fix round 1), so colour alone would pass a missing side. Painted =
    // width > 0: Chromium snaps a 1px border to whole device pixels
    // (0.666667px on a 1.5-scaled headed host).
    sides: ["Top", "Right", "Bottom", "Left"].map((side) => ({
      color: cs[`border${side}Color`], width: parseFloat(cs[`border${side}Width`]) || 0, style: cs[`border${side}Style`],
    })),
    // The pointer state this paint was read under, from the SAME task as
    // the paint (follow-up 6; round 3 holdPointerState judges it): a hover
    // read without :hover measures the REST paint, and "hover fill == rest
    // fill" then reads as a product FAIL. `focused` (round 2, gates/F5): the
    // family's hover rule is `:hover:not(:focus)`, so focus left on the
    // element (or inside it) gives the same signature with :hover=true;
    // `active` names whatever holds focus.
    hovered: el.matches(":hover"),
    focused: el.matches(":focus-within"),
    active: (() => {
      const n = document.activeElement;
      return n ? `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${[...(n.classList || [])].map((c) => `.${c}`).join("")}` : "null";
    })(),
    // When this task ran: a pointer event after it cannot have changed it.
    at: performance.now(),
  };
}

// ---- Pointer holds (round 3, H): the one real-pointer helper family 14 and
// the checklist's `hover` state share.
//
// ROOT CAUSE of the intermittent hover SETUP rows (verify run 1 of round 2:
// library|github-light|.notes-detail-delete|hover; most likely also the
// one-off "hover edge == rest edge" family-14 FAILs of follow-up 6, same
// signature, not re-traced): this audit is HEADED,
// and the host's pointer sits inside the Chromium windows. Not a person
// moving the mouse -- the pointer is stationary: on WSLg it is XWayland's
// last-known cursor position (measured with XQueryPointer: root (1218,969),
// inside all four shard windows, which WSLg stacks at the same spot; CSS
// (798,531) in each). CI runs headed under xvfb-run, whose pointer can sit
// inside the windows the same way (not measured there). Chromium's browser
// side dispatches TRUSTED mouse events at that OS position whenever it
// re-evaluates what is under the OS cursor -- reproduced in isolation on a
// scratch page (an emulated-viewport resize whose edge crosses the pointer,
// 1280 -> 700 -> 1280, then a CDP hover: mouseout/mouseover at (798,531)
// arrived +198..+634 ms later and took :hover off the hovered button; with
// 900 -> 1280 nothing came) -- and in the four-window verify run at further
// moments too. Those events move the renderer's hover chain to the OS
// pointer, undoing Playwright's CDP hover. Instrumented runs of
// the old harness (round 3: 6 x 4 parallel shards, 4606 hover reads) found
// :hover gone at 17 reads, every one with a trusted event at (798,531)
// between the hover and the read and no other cause; one row lost both of
// its attempts -- a SETUP row with the verify failure's exact signature
// (library|flexoki-dark|.vocab-detail-delete). The same event landing in the
// gap between the old separate :hover check and the probe read would have
// measured the REST paint with the hover "verified" (seen once: the check
// said true, the next read false).
//
// No harness setting keeps these events out (Input.setIgnoreInputEvents
// drops CDP input too; --window-position off-screen is moved back on-screen
// by the WSLg window manager), so the hold makes a read TRUSTWORTHY instead:
//   - every attempt blurs focus held inside the element (focus left by an
//     earlier row, or page script), and a retry first waits for the trusted
//     pointer log to go quiet (POINTER_QUIET_MS) so a burst can finish;
//   - hover: leave to a viewport corner outside the element when it already
//     reads :hover (a real crossing, never a no-op move onto itself), then
//     move to the element's centre at integer coordinates and poll :hover
//     frame by frame up to HOVER_APPLY_MS (normally 20-45 ms) -- a late
//     hover is waited for, not judged; rest: park at that outside corner;
//   - the caller's `read` measures and reports hovered / focused from the
//     SAME page task as the measurement, and the attempt counts only if the
//     wanted pointer state held there, focus was elsewhere, and the page saw
//     no trusted pointer event between the attempt's final move and that
//     read other than at the point it moved to (the witness log);
//   - up to HOLD_ATTEMPTS attempts (one once HOLD_FAIL_STREAK holds of that
//     mode in a row have failed). A state that never holds stays a SETUP row (the
//     caller's), never a WARN and never a verdict. Each failed attempt gets a
//     cause (holdAttemptCause): focusDuringHover (focus survived the blur),
//     pointerDisplaced (a pointer event the harness did not dispatch arrived
//     in the read window -- the witness lists them), hoverNotApplied /
//     hoverAtRest (no such event, yet :hover never came / never left --
//     elementFromPoint names what is under the point). The row's kind is
//     taken from ALL attempts, not the last one, by HOLD_KIND_PRECEDENCE, and
//     its note says on how many of the attempts that cause was seen
//     (holdSetupNote).
const HOLD_ATTEMPTS = 4;
const HOVER_APPLY_MS = 500;
const POINTER_QUIET_MS = 300;
// Fail fast once holds keep failing (a display that disturbs every hover, the
// all-miss control): after HOLD_FAIL_STREAK holds of one mode in a row never
// held, the next ones of that mode get a single attempt and no quiet wait
// until one holds again (per mode: family 14's rest holds keep succeeding
// between its failing hover holds and must not reset the hover streak).
// Their rows are SETUP rows all the same -- the run fails either way; this
// only keeps a broken environment from stretching a failing run by up to
// ~7 s per control (one full hold's bound: four attempts, three of them
// after a quiet wait of up to 4 x POINTER_QUIET_MS).
const HOLD_FAIL_STREAK = 3;
const holdFailStreak = { hover: 0, rest: 0 };
// Per-run tally for the coverage line: how many holds needed more than one
// attempt, and how many of those were a displaced pointer.
const pointerHoldLog = { holds: 0, retried: 0, displaced: 0, failed: 0 };

// Runs INSIDE the page (handle.evaluate(fn, quietMs)) -- self-contained.
// Installs the trusted-pointer witness once per document, blurs focus held
// inside the element, optionally waits for the pointer log to go quiet, and
// returns the attempt's mark, the points the node side moves to, and the
// hit / focus witnesses the SETUP text reports.
async function preparePointerAttempt(el, quietMs) {
  const name = (n) => (n ? `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${[...(n.classList || [])].map((c) => `.${c}`).join("")}` : "null");
  if (!window.__pbpPointerLog) {
    const log = [];
    for (const type of ["mousemove", "mouseover", "mouseout"]) {
      addEventListener(type, (e) => {
        if (!e.isTrusted) return;
        log.push([performance.now(), type, e.clientX, e.clientY]);
        if (log.length > 400) log.splice(0, 200);
      }, { capture: true, passive: true });
    }
    window.__pbpPointerLog = log;
  }
  let blurred = null;
  if (el.matches(":focus-within")) { blurred = name(document.activeElement); document.activeElement.blur(); }
  if (quietMs > 0) {
    const start = performance.now();
    for (;;) {
      const last = window.__pbpPointerLog.length ? window.__pbpPointerLog[window.__pbpPointerLog.length - 1][0] : 0;
      if (performance.now() - last >= quietMs || performance.now() - start >= 4 * quietMs) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  const r = el.getBoundingClientRect();
  const cx = Math.round(Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1));
  const cy = Math.round(Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1));
  const within = (n) => !!n && (n === el || el.contains(n));
  const outside = [[0, 0], [innerWidth - 1, 0], [0, innerHeight - 1], [innerWidth - 1, innerHeight - 1]]
    .find(([x, y]) => !(x >= r.left && x < r.right && y >= r.top && y < r.bottom) && !within(document.elementFromPoint(x, y))) || null;
  const hitNode = document.elementFromPoint(cx, cy);
  return {
    mark: performance.now(), center: [cx, cy], outside, hovered: el.matches(":hover"),
    hit: `${name(hitNode)} @(${cx},${cy})`, hitInside: within(hitNode), blurred,
    parkHit: outside ? `${name(document.elementFromPoint(outside[0], outside[1]))} @(${outside[0]},${outside[1]})` : null,
  };
}

// Runs INSIDE the page (handle.evaluate(fn, { want, ms })) -- self-contained.
// Two frames, then one check per frame (with a timer fallback so a page that
// is not producing frames cannot hang it) until el.matches(":hover") === want
// or `ms` ran out.
async function awaitHoverState(el, { want, ms }) {
  const frame = () => new Promise((r) => { const t = setTimeout(r, 50); requestAnimationFrame(() => { clearTimeout(t); r(); }); });
  const start = performance.now();
  await frame();
  for (;;) {
    await frame();
    if (el.matches(":hover") === want) return { ok: true, ms: Math.round(performance.now() - start) };
    if (performance.now() - start >= ms) return { ok: false, ms: Math.round(performance.now() - start) };
  }
}

// Runs INSIDE the page -- self-contained. The trusted pointer events that
// arrived after the harness's final move of this attempt (to `target`, the
// hover point or the park point) and before the read's own task (`until`),
// and are NOT at that point (+-1 CSS px: the renderer floors MouseEvent
// coordinates after its DIP conversion). Anything before that move -- the
// leave move, a post-scroll hover update at the old pointer position -- is
// overridden by it, and anything after the read cannot have changed it. The
// move shows up in the log as its first event at `target` after `since`;
// Chromium dispatches a mousemove for every CDP move, even onto one point.
function foreignPointerEvents({ since, target, until }) {
  const log = (window.__pbpPointerLog || []).filter(([t]) => t > since && (until == null || t <= until));
  const at = ([, , x, y]) => Math.abs(target[0] - x) <= 1 && Math.abs(target[1] - y) <= 1;
  const moved = log.findIndex(at);
  return log.slice(moved + 1).filter((e) => !at(e))
    .map(([t, type, x, y]) => `${type}@(${x},${y})+${Math.round(t - since)}ms`);
}

// mode "hover": the element must read :hover; "rest": it must not. `read()`
// is node-side and must return { hovered, focused, active, at, ... } measured
// in the same page task as whatever the caller will judge (`at` =
// performance.now() in that task). `skip(got)` (rest
// only) ends the hold early for a read the caller will not judge at all
// (hidden / disabled controls). Returns { got, ok, attempts, tries, kind }.
async function holdPointerState(page, handle, read, mode, skip = null) {
  const tries = [];
  let got = null;
  const maxAttempts = holdFailStreak[mode] >= HOLD_FAIL_STREAK ? 1 : HOLD_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (mode === "hover") await handle.scrollIntoViewIfNeeded({ timeout: TIMEOUT_MS });
    const prep = await handle.evaluate(preparePointerAttempt, attempt > 1 ? POINTER_QUIET_MS : 0);
    let applyMs = null;
    if (mode === "rest") {
      if (prep.outside) await page.mouse.move(prep.outside[0], prep.outside[1]);
    } else {
      if (prep.hovered && prep.outside) {
        await page.mouse.move(prep.outside[0], prep.outside[1]);
        await handle.evaluate(awaitHoverState, { want: false, ms: HOVER_APPLY_MS });
      }
      await page.mouse.move(prep.center[0], prep.center[1]);
      applyMs = (await handle.evaluate(awaitHoverState, { want: true, ms: HOVER_APPLY_MS })).ms;
    }
    got = await read();
    if (skip && skip(got)) return { got, ok: true, attempts: attempt, tries, kind: null };
    const foreign = await page.evaluate(foreignPointerEvents, { since: prep.mark, target: mode === "hover" ? prep.center : (prep.outside || prep.center), until: typeof got.at === "number" ? got.at : null });
    const t = { attempt, hovered: !!got.hovered, focused: !!got.focused, active: got.active || "?", hit: prep.hit, hitInside: prep.hitInside, parkHit: prep.parkHit, blurred: prep.blurred, foreign, applyMs, outside: prep.outside };
    tries.push(t);
    const held = (mode === "hover" ? t.hovered : !t.hovered) && !t.focused && !foreign.length && (mode === "hover" || !!prep.outside);
    t.cause = held ? null : holdAttemptCause(t, mode);
    if (held) {
      holdFailStreak[mode] = 0;
      pointerHoldLog.holds++;
      if (attempt > 1) { pointerHoldLog.retried++; if (tries.some((x) => x.foreign.length)) pointerHoldLog.displaced++; }
      return { got, ok: true, attempts: attempt, tries, kind: null };
    }
  }
  holdFailStreak[mode]++;
  pointerHoldLog.holds++; pointerHoldLog.failed++;
  const kind = HOLD_KIND_PRECEDENCE.find((k) => tries.some((t) => t.cause === k));
  return { got, ok: false, attempts: tries.length, tries, kind };
}

// Why one attempt did not hold, checked in this order: focus that survived
// the blur voids a :hover:not(:focus) read wherever the pointer was; then a
// pointer event the harness did not dispatch in the read window; otherwise
// the wanted state itself never came (hover) or never left (rest -- or there
// was no viewport corner outside the element to park at).
function holdAttemptCause(t, mode) {
  return t.focused ? "focusDuringHover" : t.foreign.length ? "pointerDisplaced" : mode === "hover" ? "hoverNotApplied" : "hoverAtRest";
}
// A failed hold's kind, from all of its attempts: the first cause in this
// list that any attempt had. pointerDisplaced comes last because a displaced
// attempt's read says nothing about the element (the retries exist to
// outlast exactly that), so it names the row only when it spoiled every
// attempt; a quiet attempt whose state still did not hold, or focus that
// survived the harness's own blur, is evidence about the page and names the
// row even if other attempts were displaced. The note says how many attempts
// had the named cause and what the others had (holdSetupNote), and the
// actual text tags every attempt with its own cause.
const HOLD_KIND_PRECEDENCE = ["focusDuringHover", "hoverNotApplied", "hoverAtRest", "pointerDisplaced"];

// One clause per attempt, for SETUP rows and the `harness` field. `mode`
// picks the elementFromPoint witness that matters: the hover point, or the
// park point a rest read left the pointer at.
function describeHoldTries(tries, mode) {
  return tries.map((t) => `attempt ${t.attempt}${t.cause ? ` [${t.cause}]` : ""}: :hover=${t.hovered} focus=${t.focused} (activeElement ${t.active})` +
    `${t.blurred ? `, blurred ${t.blurred} first` : ""}` +
    `${t.foreign.length ? `, pointer events the harness did not dispatch: ${t.foreign.slice(0, 4).join(" ")}` : ""}` +
    (mode === "rest"
      ? (t.parkHit ? `, elementFromPoint at the park point ${t.parkHit}` : ", no viewport corner outside the element to park at")
      : `, elementFromPoint at the hover point ${t.hit}${t.hitInside ? " (inside the element)" : " (NOT the element or inside it)"}${t.applyMs != null ? `, :hover wait ${t.applyMs}ms` : ""}`)).join("; ");
}
// The SETUP note per kind: what each case can mean, and which witness says
// so. `on` is holdSetupNote's count phrase ("on all 4 attempts", "on 1 of 4
// attempts (the others: 3 pointerDisplaced)"), so the note never claims more
// attempts than the row's per-attempt causes show.
const HOLD_SETUP_NOTES = {
  focusDuringHover: (on) => `unmeasured: ${on}, focus survived the harness's blur, so a :hover:not(:focus) paint cannot be read -- a harness focus leak, or page script re-focusing the element (see activeElement)`,
  pointerDisplaced: (on) => `unmeasured: ${on}, a trusted pointer event the harness did not dispatch moved the pointer before the read finished -- the host's OS pointer inside the headed window (see the listed events; round-3 root cause at holdPointerState)`,
  hoverNotApplied: (on) => `unmeasured: ${on}, :hover never reached the element with no foreign pointer event in the read window to explain it -- an overlay a user would hit too, or pointer-events on the element (see elementFromPoint)`,
  hoverAtRest: (on) => `unmeasured: ${on}, :hover stayed on the element with the pointer parked outside it (or there was no viewport corner outside it to park at) with no foreign pointer event in the read window to explain it -- the element (or an ancestor) sits under the park point, or the page kept a stale hover chain (see elementFromPoint)`,
};
function holdSetupNote(hold) {
  const n = hold.tries.length;
  const counts = new Map();
  for (const t of hold.tries) counts.set(t.cause, (counts.get(t.cause) || 0) + 1);
  const k = counts.get(hold.kind) || 0;
  const others = [...counts].filter(([cause]) => cause !== hold.kind).map(([cause, m]) => `${m} ${cause}`).join(", ");
  const on = k === n ? (n === 1 ? "on its only attempt" : n === 2 ? "on both attempts" : `on all ${n} attempts`) : `on ${k} of ${n} attempts (the others: ${others})`;
  return HOLD_SETUP_NOTES[hold.kind](on);
}

async function recordFieldHoverContrast(page, theme, results, context, kindsSeen, kindsUnmeasured) {
  const surface = "options";
  const liveTheme = await page.evaluate(() => document.documentElement.dataset.theme || null);
  const expected = expectedDatasetTheme(theme);
  if (liveTheme !== expected) {
    throw new Error(`SETUP: fieldHoverContrast options/${context} expected documentElement.dataset.theme=${JSON.stringify(expected)} (theme=${JSON.stringify(theme)}) but found ${JSON.stringify(liveTheme)} -- theme drifted before the family-14 scan`);
  }
  const parse = (raw, what, path) => {
    const p = parseRgba(String(raw || ""));
    if (!p) throw new Error(`SETUP: fieldHoverContrast ${path} (theme=${theme}) ${what} ${JSON.stringify(raw)} is not a parseable colour -- the contrast math would silently skip it`);
    return p;
  };
  const stackOf = (raws, path) => {
    let base = [255, 255, 255];
    for (let i = raws.length - 1; i >= 0; i--) {
      const p = parse(raws[i], "background", path);
      if (p[3] > 0) base = composite(p.slice(0, 3), p[3], base);
    }
    return base;
  };
  // What the box paints: its composited fill, the backdrop behind it, and
  // its frame (the top side -- oneFrame below proves the other three match)
  // composited over that fill.
  const paints = (paint) => {
    const fill = stackOf([paint.own, ...paint.chain], paint.path);
    const backdrop = stackOf(paint.chain, paint.path);
    const b = parse(paint.sides[0].color, "border-top-color", paint.path);
    return { fill, backdrop, frame: composite(b.slice(0, 3), b[3], fill) };
  };
  const sidePainted = (side) => side.width > 0 && !/^(?:none|hidden)$/.test(side.style || "none");
  const oneFrame = (paint) => paint.sides.every((side) => sidePainted(side) &&
    side.color === paint.sides[0].color && side.width === paint.sides[0].width && side.style === paint.sides[0].style);
  const sameRgb = (a, b) => a.every((c, i) => Math.abs(c - b[i]) <= 1);
  const sidesText = (paint) => paint.sides.map((side) => `${side.color} ${side.width}px ${side.style}`).join("|");
  const frameStepTheme = (FIELD_UNSEPARATED_FRAMED[surface] || []).includes(theme);
  // Only MEASURED rows (OK / FAIL) count as scanned and as a kind seen: a
  // SETUP row was reached but never measured, so counting it would let the
  // non-vacuity guard and the coverage line report a measurement that did
  // not happen (round 2, gates/F2). SETUP rows are tallied apart.
  let scanned = 0, unmeasured = 0;
  for (const h of await page.$$(FIELD_HOVER_SEL)) {
    // Rest, then hover, each through the shared pointer hold (round 3, H --
    // see holdPointerState for the root cause it answers). The rest hold
    // skips hidden / disabled controls outright: inert, no pointer state to
    // test (WCAG 1.4.11 exempts inactive components).
    const restHold = await holdPointerState(page, h, () => h.evaluate(readFieldPaint), "rest", (p) => !p.visible || p.disabled);
    const rest = restHold.got;
    if (!rest.visible || rest.disabled) continue;
    const hoverHold = restHold.ok ? await holdPointerState(page, h, () => h.evaluate(readFieldPaint), "hover") : null;
    await page.mouse.move(0, 0);
    const hover = hoverHold?.got ?? null;
    // A precondition that never held is a HARNESS condition, not a product
    // verdict: a SETUP row (report() fails the run with exit 2 and lists it
    // apart from product FAILs) naming the element and each attempt's
    // witnesses. Not a WARN: a WARN would pass the run with this control's
    // hover paint never measured -- the one outcome R16's fail-safe
    // reasoning ("a missed hover only ever produces a false FAIL, never a
    // false OK") rules out. After HOLD_ATTEMPTS bounded attempts it is not a
    // late hover any more: the kind (holdPointerState) says what held it off.
    const failed = !restHold.ok ? { hold: restHold, phase: "REST" } : !hoverHold.ok ? { hold: hoverHold, phase: "hover" } : null;
    if (failed) {
      const setup = {
        kind: failed.hold.kind,
        actual: `${failed.phase === "REST" ? "the rest state (pointer parked outside, focus elsewhere)" : ":hover with focus elsewhere"} did not hold through the read in ${failed.hold.attempts} attempt(s) -- ${describeHoldTries(failed.hold.tries, failed.phase === "REST" ? "rest" : "hover")}`,
        note: holdSetupNote(failed.hold),
      };
      unmeasured++;
      kindsUnmeasured[rest.kind] = kindsUnmeasured[rest.kind] || [];
      kindsUnmeasured[rest.kind].push(`${rest.path} [${setup.kind}] ${setup.actual}`);
      results.push({
        surface, theme, selector: rest.path, state: `hover|${context}`, check: "fieldHoverContrast",
        status: "SETUP", setup: setup.kind, actual: setup.actual,
        expected: "the real pointer's :hover reaches the probed element with focus elsewhere, and leaves it at rest, undisturbed through each read (harness precondition for the fieldHoverContrast verdict)",
        note: setup.note,
      });
      continue;
    }
    const r = paints(rest), v = paints(hover);
    const sidesOk = oneFrame(rest) && oneFrame(hover);
    const framed = !sameRgb(r.frame, r.fill);
    let ok, actual, expected;
    if (frameStepTheme) {
      const step = cr(v.frame, r.frame), stepDE = deltaE2000(v.frame, r.frame), onFillRest = cr(r.frame, r.fill), onFillHover = cr(v.frame, v.fill);
      ok = sidesOk && framed && sameRgb(v.fill, r.fill) && step >= FIELD_FRAME_HOVER_MIN && stepDE >= FIELD_FRAME_HOVER_MIN_DE && onFillHover > onFillRest;
      actual = `frame step ${round2(step)} / ΔE2000 ${round2(stepDE)} (hover frame vs rest frame), frame on fill ${round2(onFillRest)}->${round2(onFillHover)}, fill rgb(${r.fill})->rgb(${v.fill}); sides rest ${sidesText(rest)} -> hover ${sidesText(hover)}`;
      expected = `framed-unseparated class (FIELD_UNSEPARATED_FRAMED.${surface}): all four sides painted and one colour at rest and on hover, a frame distinct from the fill, the fill held on hover, the frame stepping >= ${FIELD_FRAME_HOVER_MIN} and ΔE2000 >= ${FIELD_FRAME_HOVER_MIN_DE} against the rest frame and reading stronger on the fill (spec 2026-09-30-ui-fields-stage4-design §2.2 / §2.3)`;
    } else {
      const f1 = cr(r.fill, r.backdrop), f2 = cr(v.fill, r.fill), f3 = cr(v.fill, v.backdrop);
      ok = sidesOk && f1 >= FILL_SEPARATE_MIN && f2 >= FILL_SEPARATE_MIN && f3 >= FILL_SEPARATE_MIN;
      actual = `F1 rest fill vs backdrop ${round2(f1)}, F2 hover vs rest fill ${round2(f2)}, F3 hover fill vs backdrop ${round2(f3)} (${framed ? "framed" : "unframed"}; fill rgb(${r.fill})->rgb(${v.fill}) on rgb(${r.backdrop})); sides rest ${sidesText(rest)} -> hover ${sidesText(hover)}`;
      expected = `fill-step class: all four sides painted and one colour at rest and on hover (no bottom edge), rest fill vs backdrop, hover fill vs rest fill and hover fill vs backdrop each >= ${FILL_SEPARATE_MIN} (FILL_SEPARATE_MIN; spec 2026-09-30-ui-fields-stage4-design §2.3 F1-F3)`;
    }
    scanned++;
    kindsSeen[rest.kind] = (kindsSeen[rest.kind] || 0) + 1;
    results.push({
      surface, theme, selector: rest.path, state: `hover|${context}`, check: "fieldHoverContrast",
      status: ok ? "OK" : "FAIL",
      actual,
      expected,
      note: null,
      // Per-run pointer/focus diagnostics, kept out of `actual` so a ledger
      // rewrite never churns on them (round 2, correctness/F6).
      harness: `:hover rest=${rest.hovered} hover=${hover.hovered}, focus rest=${rest.focused} hover=${hover.focused} (activeElement ${hover.active}), rest attempt ${restHold.attempts}, hover attempt ${hoverHold.attempts}${hoverHold.attempts > 1 ? ` (${describeHoldTries(hoverHold.tries.slice(0, -1), "hover")})` : ""}`,
    });
  }
  fieldHoverScanLog.push({ theme, context, scanned, unmeasured });
}

// ---- fieldHoverContrast (family 14), the popup / library value-box legs
// (stage 4 Task 6, spec 2026-09-30-ui-fields-stage4-design §2.1 / §2.3 /
// §5.2; ruling R7: ONE surface-parameterised leg; Task 7 added `library` to
// VALUE_BOX_LEGS and calls the same two functions). Each surface's value
// boxes -- a HAND-WRITTEN list, the render oracle never derives its
// population from the recipe it checks (tests/render-audit-checklist.mjs
// header) -- are read with the real pointer parked and hovered
// (holdPointerState). Per (theme, box):
//   - token identity: rest fill / all four sides = --<ns>-field-bg /
//     --<ns>-field-border, hover = --<ns>-field-bg-hover /
//     --<ns>-field-border-hover, every side painted (width > 0, style not
//     none/hidden) -- no bottom edge, no unpainted side;
//   - four equal corners = the surface's radiusVar (spec §1.4 item 3; the
//     one popup exception, .tags-input-wrap.ac-open, is never opened here);
//   - the hover step, by the class FIELD_UNSEPARATED_FRAMED[surface] pins by
//     name (spec §2.4, same discipline as the options leg): a box outside it
//     steps its FILL >= FILL_SEPARATE_MIN (F2); a framed box whose fill is
//     not separated from its hosts keeps its fill and steps its FRAME -- F8:
//     >= FIELD_FRAME_HOVER_MIN:1 and dE2000 >= FIELD_FRAME_HOVER_MIN_DE
//     against the rest frame, and stronger on the fill than the rest frame.
//   - the class itself (`fieldHoverClass`, one row per theme and fixture):
//     framed / separated are re-measured from the page's own tokens (hosts =
//     the deriver's FIELD_HOST_ROLES[ns]) and must EQUAL the pinned name
//     list, so a palette drifting across FILL_SEPARATE_MIN fails loudly
//     instead of silently swapping which rule judges it (or leaving the F8
//     branch with nothing to judge).
// A box that is missing, hidden or disabled is a SETUP ERROR, never a pass;
// a pointer state that never holds is a SETUP row.
const VALUE_BOX_LEGS = Object.freeze({
  popup: Object.freeze({
    ns: "pp",
    radiusVar: "--pp-radius-md",
    // [box, carrier]: `carrier` names the ancestor whose state drives the box
    // (the token field's .secret-field shell), so focus held there is seen.
    boxes: Object.freeze([
      ["#url-input", null], ["#title-input", null], ["#description-input", null],
      [".tags-input-wrap", null], ["#search-input", null], ["#token-input", ".secret-field"],
    ]),
    // Fixtures (spec §5.2): the main form needs #main-section without
    // .unsupported-url (popup.js sets it: the fixture's own tab is a
    // chrome-extension:// page) and .search-row unhidden (popup.js hides it
    // unless optShowSearch); the token field needs the logged-out page (the
    // seed is logged in), restored whatever happens.
    legs: Object.freeze([
      {
        context: "main",
        boxes: ["#url-input", "#title-input", "#description-input", ".tags-input-wrap", "#search-input"],
        async open(page, url, theme) {
          await page.goto(`${url}?_ra=fieldhover`, { waitUntil: "load", timeout: TIMEOUT_MS });
          await page.waitForTimeout(500);
          const shown = await page.evaluate(() => {
            const main = document.getElementById("main-section");
            const search = document.querySelector(".search-row");
            main?.classList.remove("hidden", "unsupported-url");
            search?.classList.remove("hidden");
            document.activeElement?.blur?.();
            return !!main && !!search;
          });
          if (!shown) throw new Error(`SETUP: fieldHoverContrast popup: popup.html is missing #main-section / .search-row (theme=${theme})`);
          await page.waitForTimeout(120);
          return null;
        },
      },
      {
        context: "login",
        boxes: ["#token-input"],
        async open(page, url, theme, sw) {
          await sw.evaluate(() => chrome.storage.local.set({ pinboardToken: "" }));
          const restore = () => sw.evaluate((tok) => chrome.storage.local.set({ pinboardToken: tok }), SEED_TOKEN_OBF);
          try {
            await page.goto(`${url}?_ra=fieldlogin`, { waitUntil: "load", timeout: TIMEOUT_MS });
            await page.waitForSelector("#login-section:not(.hidden)", { timeout: TIMEOUT_MS });
            await page.waitForTimeout(300);
          } catch (e) {
            await restore();
            throw e;
          }
          return restore;
        },
      },
    ]),
  }),
  // library (stage 4 Task 7, spec §5.2): the eight value boxes -- the three
  // search fields, the two listbox buttons (the group filter and, since
  // library redesign T7, the dictionary language), the two
  // .vocab-group-unit shells (the shell carries the look; its text input is
  // a transparent passenger) and the note editor. Named rather than class-scanned, like
  // popup's. The vocab leg navigates fresh instead of inheriting whatever the
  // CHECKS loop left open (a typed note, an open tab); the notes leg then
  // reuses that fresh page and only switches it to the notes tab. The vocab
  // leg also reads the dictionary language's listbox button FOCUSED (`focus`).
  library: Object.freeze({
    ns: "lib",
    radiusVar: "--lib-radius-md",
    boxes: Object.freeze([
      ["#vocab-search", null], ["#vocab-group-filter-btn", null], ["#vocab-lookup-input", null], ["#vocab-lookup-lang-btn", null],
      ["#vocab-detail .vocab-note-input", null],
      ["#vocab-batch-toolbar .vocab-group-unit", null], ["#vocab-detail .vocab-group-unit", null],
      ["#notes-filter", null],
    ]),
    legs: Object.freeze([
      {
        // Established here and fail-closed: the detail pane showing the
        // seeded word (a plain click activates the row), the batch bar open
        // (Control+click adds the row to the selection; library-vocab.js
        // keeps the two verbs apart) and NOT busy (#vocab-group-input is
        // disabled while a batch mutation runs -- an inactive control, whose
        // shell the hover recipe excludes, so it could never be measured).
        context: "vocab",
        boxes: ["#vocab-search", "#vocab-lookup-input", "#vocab-lookup-lang-btn",
          "#vocab-detail .vocab-note-input",
          "#vocab-batch-toolbar .vocab-group-unit", "#vocab-detail .vocab-group-unit"],
        focus: ["#vocab-lookup-lang-btn"],
        async open(page, url, theme) {
          await page.goto(`${url}?_ra=${encodeURIComponent(`fieldhover-${theme}`)}#vocab`, { waitUntil: "load", timeout: TIMEOUT_MS });
          await page.waitForSelector("#vocab-list .vocab-card", { timeout: TIMEOUT_MS });
          // The rich LIB_SEED word: the detail's value boxes include its note
          // and its group editor's unit.
          const head = page.locator("#vocab-list .vocab-card")
            .filter({ has: page.locator(".notes-row-title", { hasText: new RegExp(`^${LIB_SEED.richTerm}$`) }) })
            .locator(".notes-card-head").first();
          if (!(await head.count())) {
            throw new Error(`SETUP: fieldHoverContrast library: no vocabulary row titled ${JSON.stringify(LIB_SEED.richTerm)} (theme=${theme}) -- LIB_SEED broken or the row title class renamed`);
          }
          await head.click();
          await page.click("#vocab-detail .vocab-edit-groups");
          await page.waitForSelector("#vocab-detail #vocab-group-editor:not([hidden]) .vocab-group-unit", { timeout: TIMEOUT_MS });
          await head.click({ modifiers: ["Control"] });
          await page.waitForSelector("#vocab-batch-toolbar.selecting", { timeout: TIMEOUT_MS });
          if (await page.$eval("#vocab-group-input", (el) => el.disabled)) {
            throw new Error(`SETUP: fieldHoverContrast library: #vocab-group-input is disabled (a batch mutation is running) -- the leg must measure the batch-bar group unit enabled (theme=${theme})`);
          }
          await page.evaluate(() => document.activeElement?.blur?.());
          await page.mouse.move(0, 0);
          await settleAnimations(page);
          return null;
        },
      },
      {
        // Reuses the vocab leg's page (no navigation): switches it to the
        // notes tab.
        context: "notes",
        boxes: ["#notes-filter"],
        async open(page, url, theme) {
          await page.click("#lib-tab-notes");
          await page.waitForSelector("#notes-filter", { state: "visible", timeout: TIMEOUT_MS });
          await page.evaluate(() => document.activeElement?.blur?.());
          await page.mouse.move(0, 0);
          await settleAnimations(page);
          if (!(await page.$("#view-notes:not([hidden])"))) {
            throw new Error(`SETUP: fieldHoverContrast library: the notes view did not open (theme=${theme})`);
          }
          return null;
        },
      },
      {
        // Library redesign T4b / T6: the group filter's listbox button
        // (#vocab-group-filter-btn) sits in the "Filter" popover in the
        // narrow form (inline in the wide one). Its own leg on a fresh page,
        // so the open top-layer panel never covers the batch row's group unit
        // that the vocab leg hovers. The returned closer hides it again.
        context: "vocab-filter",
        boxes: ["#vocab-group-filter-btn"],
        async open(page, url, theme) {
          await page.goto(`${url}?_ra=${encodeURIComponent(`fieldfilter-${theme}`)}#vocab`, { waitUntil: "load", timeout: TIMEOUT_MS });
          await page.waitForSelector("#vocab-list .vocab-card", { timeout: TIMEOUT_MS });
          const opened = await setFilterSetOpen(page, true);
          if (opened === "missing" || opened === "stuck") {
            throw new Error(`SETUP: fieldHoverContrast library: could not open #vocab-filter-set (${opened}, theme=${theme})`);
          }
          await page.mouse.move(0, 0);
          await settleAnimations(page);
          if (!(await page.$eval("#vocab-group-filter-btn", (el) => el.getClientRects().length > 0))) {
            throw new Error(`SETUP: fieldHoverContrast library: #vocab-group-filter-btn is not rendered after opening the Filter popover (theme=${theme})`);
          }
          return async () => { await setFilterSetOpen(page, false); };
        },
      },
    ]),
  }),
});
// The focused reads each surface's legs MUST make (Task 7 fix round 2), held
// apart from the legs' own `focus` keys so that deleting a key cannot remove
// both the measurement and its coverage check: the run-level check below
// requires every entry here to be named by some leg's `focus` and measured on
// every theme it ran.
const VALUE_BOX_FOCUS_REQUIRED = Object.freeze({
  library: Object.freeze(["#vocab-lookup-lang-btn"]),
});
const valueBoxHoverLog = [];
// One colour parser for every read of this leg (Task 7 fix round 1): a hex
// token or a computed rgb()/rgba()/color(srgb ...) value -> [r, g, b] or
// [r, g, b, a]; null when it does not parse.
const readCssColour = (value) => {
  const s = String(value || "").trim();
  return s.startsWith("#") ? hexRgb(s) : parseRgba(s);
};

// Runs INSIDE the page (handle.evaluate(fn, carrierSel)) -- self-contained.
async function readValueBoxPaint(el, carrierSel) {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  el.getAnimations().forEach((a) => { try { a.finish(); } catch { /* idle */ } });
  const carrier = (carrierSel && el.closest(carrierSel)) || el;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const n = document.activeElement;
  return {
    visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
    disabled: !!el.disabled,
    own: cs.backgroundColor,
    sides: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
    widths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map((w) => parseFloat(w) || 0),
    styles: [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle],
    radii: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => parseFloat(v) || 0),
    hovered: el.matches(":hover"),
    focused: carrier.matches(":focus-within"),
    active: n ? `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${[...(n.classList || [])].map((c) => `.${c}`).join("")}` : "null",
    at: performance.now(),
  };
}

async function recordValueBoxes(page, surface, theme, results, context, boxes, log) {
  const cfg = VALUE_BOX_LEGS[surface];
  if (!cfg) throw new Error(`SETUP: fieldHoverContrast has no VALUE_BOX_LEGS entry for ${surface}`);
  const { ns } = cfg;
  const expected = expectedDatasetTheme(theme);
  const liveTheme = await page.evaluate(() => document.documentElement.dataset.theme || null);
  if (liveTheme !== expected) {
    throw new Error(`SETUP: fieldHoverContrast ${surface}/${context} expected documentElement.dataset.theme=${JSON.stringify(expected)} (theme=${JSON.stringify(theme)}) but found ${JSON.stringify(liveTheme)} -- theme drifted before the family-14 ${surface} leg`);
  }
  const hosts = FIELD_HOST_ROLES[ns];
  if (!Array.isArray(hosts) || !hosts.length) throw new Error(`SETUP: fieldHoverContrast ${surface}: FIELD_HOST_ROLES.${ns} is missing`);
  const raw = await page.evaluate(({ ns, names, radiusVar }) => {
    const cs = getComputedStyle(document.documentElement);
    return {
      ...Object.fromEntries(names.map((name) => [name, cs.getPropertyValue(`--${ns}-${name}`).trim()])),
      radius: cs.getPropertyValue(radiusVar).trim(),
    };
  }, { ns, names: ["field-bg", "field-border", "field-bg-hover", "field-border-hover", ...hosts], radiusVar: cfg.radiusVar });
  const solid = (value, what, where) => {
    const p = readCssColour(value);
    if (!p || (p.length === 4 && p[3] !== 1)) {
      throw new Error(`SETUP: fieldHoverContrast ${surface} ${where} (theme=${theme}) ${what} ${JSON.stringify(value)} is not an opaque parseable colour -- the step math would silently skip it`);
    }
    return p.slice(0, 3);
  };
  const tok = Object.fromEntries(Object.entries(raw).filter(([name]) => name !== "radius").map(([name, value]) => [name, solid(value, `--${ns}-${name}`, ":root")]));
  const radiusMd = parseFloat(raw.radius);
  if (!Number.isFinite(radiusMd)) throw new Error(`SETUP: fieldHoverContrast ${surface} (theme=${theme}) ${cfg.radiusVar} ${JSON.stringify(raw.radius)} is not a length`);
  const same = (a, b) => a.every((c, i) => Math.abs(c - b[i]) <= 1);
  // The class, measured from the tokens and pinned by name (see header).
  const framed = !same(tok["field-border"], tok["field-bg"]);
  const separated = hosts.every((host) => cr(tok["field-bg"], tok[host]) >= FILL_SEPARATE_MIN);
  const measuredFrameClass = framed && !separated;
  const frameCarriesHover = (FIELD_UNSEPARATED_FRAMED[surface] || []).includes(theme);
  results.push({
    surface, theme, selector: ":root", state: `hover|${context}`, check: "fieldHoverClass",
    status: measuredFrameClass === frameCarriesHover ? "OK" : "FAIL",
    actual: `${framed ? "framed" : "unframed"} (--${ns}-field-border ${raw["field-border"]} vs --${ns}-field-bg ${raw["field-bg"]}), fill ${separated ? "separated" : "NOT separated"} from ${hosts.map((host) => `--${ns}-${host} ${raw[host]} (${round2(cr(tok["field-bg"], tok[host]))}:1)`).join(", ")} -> ${measuredFrameClass ? "frame-step" : "fill-step"} class; FIELD_UNSEPARATED_FRAMED.${surface} ${frameCarriesHover ? "lists" : "does not list"} ${JSON.stringify(theme)}`,
    expected: `the class measured from the theme's tokens (framed and not separated >= FILL_SEPARATE_MIN ${FILL_SEPARATE_MIN} from FIELD_HOST_ROLES.${ns}) equals FIELD_UNSEPARATED_FRAMED.${surface} (spec 2026-09-30-ui-fields-stage4-design §2.4)`,
    note: null,
  });
  for (const [box, carrier] of boxes) {
    const h = await page.$(box);
    if (!h) throw new Error(`SETUP: fieldHoverContrast ${surface}/${context} found no ${box} (theme=${theme}) -- the fixture did not render it`);
    const read = () => h.evaluate(readValueBoxPaint, carrier);
    const restHold = await holdPointerState(page, h, read, "rest");
    const rest = restHold.got;
    if (!rest.visible || rest.disabled) {
      throw new Error(`SETUP: fieldHoverContrast ${surface}/${context} ${box} is ${rest.visible ? "disabled" : "not visible"} (theme=${theme}) -- the ${surface} leg must measure every value box`);
    }
    const hoverHold = restHold.ok ? await holdPointerState(page, h, read, "hover") : null;
    await page.mouse.move(0, 0);
    await h.dispose();
    const failed = !restHold.ok ? { hold: restHold, phase: "REST" } : !hoverHold.ok ? { hold: hoverHold, phase: "hover" } : null;
    if (failed) {
      log.unmeasured.push(box);
      results.push({
        surface, theme, selector: box, state: `hover|${context}`, check: "fieldHoverContrast",
        status: "SETUP", setup: failed.hold.kind,
        actual: `${failed.phase === "REST" ? "the rest state (pointer parked outside, focus elsewhere)" : ":hover with focus elsewhere"} did not hold through the read in ${failed.hold.attempts} attempt(s) -- ${describeHoldTries(failed.hold.tries, failed.phase === "REST" ? "rest" : "hover")}`,
        expected: "the real pointer's :hover reaches the probed box with focus elsewhere, and leaves it at rest, undisturbed through each read (harness precondition for the fieldHoverContrast verdict)",
        note: holdSetupNote(failed.hold),
      });
      continue;
    }
    const hover = hoverHold.got;
    const bad = [];
    const painted = (p, i) => p.widths[i] > 0 && !/^(?:none|hidden)$/.test(p.styles[i] || "none");
    // A BOX paint the harness cannot parse is a SETUP (it cannot read what
    // the page painted -- a colour format this leg does not know), exactly
    // like a token that does not parse (solid() above). A parsed paint that
    // is not opaque (a transparent note editor, a translucent frame) is the
    // product's FAIL -- it is not the field token: null here, and every use
    // below FAILs it.
    const opaque = (value) => {
      const p = readCssColour(value);
      if (!p) throw new Error(`SETUP: fieldHoverContrast ${surface}/${context} ${box} (theme=${theme}) painted ${JSON.stringify(value)}, which the harness cannot parse -- not a product verdict; teach readCssColour the format`);
      return p.length === 4 && p[3] !== 1 ? null : p.slice(0, 3);
    };
    const eqTok = (value, role) => { const c = opaque(value); return !!c && same(c, tok[role]); };
    for (const [p, fillRole, sideRole, name] of [[rest, "field-bg", "field-border", "rest"], [hover, "field-bg-hover", "field-border-hover", "hover"]]) {
      if (!eqTok(p.own, fillRole)) bad.push(`${name} fill ${p.own} != --${ns}-${fillRole} ${raw[fillRole]}`);
      const off = [0, 1, 2, 3].filter((i) => !painted(p, i) || !eqTok(p.sides[i], sideRole));
      if (off.length) bad.push(`${name} side(s) ${off.join(",")} not a painted --${ns}-${sideRole} ${raw[sideRole]} (${p.sides.join(" | ")}; widths ${p.widths.join("/")}; styles ${p.styles.join("/")})`);
    }
    if (!rest.radii.every((v) => Math.abs(v - radiusMd) <= 0.5)) bad.push(`corners ${rest.radii.join("/")}px, want four x ${cfg.radiusVar} ${radiusMd}px`);
    const fill0 = opaque(rest.own), fill1 = opaque(hover.own);
    let step;
    if (!fill0 || !fill1) {
      step = "fill not opaque";
      bad.push(`the ${!fill0 ? "rest" : "hover"} fill ${!fill0 ? rest.own : hover.own} is not an opaque colour -- no step to measure (a value box paints its field fill)`);
    } else if (frameCarriesHover && !(opaque(rest.sides[0]) && opaque(hover.sides[0]))) {
      step = "frame not opaque";
      bad.push(`the ${!opaque(rest.sides[0]) ? "rest" : "hover"} frame ${!opaque(rest.sides[0]) ? rest.sides[0] : hover.sides[0]} is not an opaque colour -- no frame step to measure`);
    } else if (frameCarriesHover) {
      const b0 = opaque(rest.sides[0]), b1 = opaque(hover.sides[0]);
      const r = cr(b0, b1), de = deltaE2000(b0, b1);
      step = `frame ${round2(r)}:1 dE2000 ${round2(de)} (framed, fill not separated)`;
      if (!(r >= FIELD_FRAME_HOVER_MIN && de >= FIELD_FRAME_HOVER_MIN_DE && same(fill0, fill1) && cr(b1, fill1) > cr(b0, fill0))) {
        bad.push(`frame step ${round2(r)}:1 / dE2000 ${round2(de)} / fill ${same(fill0, fill1) ? "held" : `moved rgb(${fill0})->rgb(${fill1})`} / on-fill ${round2(cr(b0, fill0))} -> ${round2(cr(b1, fill1))} -- F8 needs >= ${FIELD_FRAME_HOVER_MIN}:1, dE2000 >= ${FIELD_FRAME_HOVER_MIN_DE}, the fill held and a stronger frame on the fill`);
      }
    } else {
      const r = cr(fill0, fill1);
      step = `fill ${round2(r)}:1`;
      if (!(r >= FILL_SEPARATE_MIN)) bad.push(`fill step ${round2(r)}:1 < FILL_SEPARATE_MIN ${FILL_SEPARATE_MIN} (F2)`);
    }
    log.measured.push(box);
    results.push({
      surface, theme, selector: box, state: `hover|${context}`, check: "fieldHoverContrast",
      status: bad.length ? "FAIL" : "OK",
      actual: bad.length ? bad.join("; ") : `${step}; four painted sides and four ${radiusMd}px corners, rest and hover on their tokens`,
      expected: `fill-only value box (spec §2.1): rest / hover paint --${ns}-field-bg(-hover) with four painted --${ns}-field-border(-hover) sides and four ${cfg.radiusVar} corners; hover steps the fill >= FILL_SEPARATE_MIN, or -- FIELD_UNSEPARATED_FRAMED.${surface} -- holds the fill and steps the frame (F8: >= ${FIELD_FRAME_HOVER_MIN}:1, dE2000 >= ${FIELD_FRAME_HOVER_MIN_DE}, stronger on the fill)`,
      note: null,
      harness: `:hover rest=${rest.hovered} hover=${hover.hovered}, focus rest=${rest.focused} hover=${hover.focused} (activeElement ${hover.active}), rest attempt ${restHold.attempts}, hover attempt ${hoverHold.attempts}`,
    });
  }
}

// Runs INSIDE the page (handle.evaluate) -- self-contained. A focused box's
// paint and the focus state it was read under.
async function readValueBoxFocusPaint(el) {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  el.getAnimations().forEach((a) => { try { a.finish(); } catch { /* idle */ } });
  const cs = getComputedStyle(el);
  const n = document.activeElement;
  return {
    own: cs.backgroundColor,
    sides: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
    widths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map((w) => parseFloat(w) || 0),
    styles: [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle],
    boxShadow: cs.boxShadow,
    focusVisible: el.matches(":focus-visible"),
    hovered: el.matches(":hover"),
    active: n ? `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${[...(n.classList || [])].map((c) => `.${c}`).join("")}` : "null",
  };
}

// The FOCUS state of the boxes a leg names in `focus` (Task 7 fix round 1):
// keyboard-modality focus (a Shift press, then element.focus(), so
// :focus-visible matches as it does for a Tab), read with the pointer parked
// at the viewport corner. Verdict: fill = --<ns>-field-bg-focus, all four
// sides painted and = --<ns>-field-border-focus, the focus ring drawn
// (box-shadow not none). A focus that never becomes :focus-visible is a
// SETUP row, never a pass.
async function recordValueBoxFocus(page, surface, theme, results, context, boxes, log) {
  const { ns } = VALUE_BOX_LEGS[surface];
  const raw = await page.evaluate(({ ns }) => {
    const cs = getComputedStyle(document.documentElement);
    return { "field-bg-focus": cs.getPropertyValue(`--${ns}-field-bg-focus`).trim(), "field-border-focus": cs.getPropertyValue(`--${ns}-field-border-focus`).trim() };
  }, { ns });
  const tok = {};
  for (const [name, value] of Object.entries(raw)) {
    const p = readCssColour(value);
    if (!p || (p.length === 4 && p[3] !== 1)) throw new Error(`SETUP: fieldFocusPaint ${surface} :root (theme=${theme}) --${ns}-${name} ${JSON.stringify(value)} is not an opaque parseable colour`);
    tok[name] = p.slice(0, 3);
  }
  const same = (a, b) => a.every((c, i) => Math.abs(c - b[i]) <= 1);
  for (const box of boxes) {
    const h = await page.$(box);
    if (!h) throw new Error(`SETUP: fieldFocusPaint ${surface}/${context} found no ${box} (theme=${theme}) -- the fixture did not render it`);
    await page.mouse.move(0, 0);
    await page.keyboard.press("Shift");
    await h.focus();
    const p = await h.evaluate(readValueBoxFocusPaint);
    await h.evaluate((el) => el.blur());
    await h.dispose();
    if (!p.focusVisible) {
      log.focusUnmeasured.push(box);
      results.push({
        surface, theme, selector: box, state: `focus|${context}`, check: "fieldFocusPaint", status: "SETUP", setup: "focusNotVisible",
        actual: `keyboard-modality focus did not match :focus-visible (activeElement ${p.active})`,
        expected: "the box focused with :focus-visible (harness precondition for the fieldFocusPaint verdict)",
        note: null,
      });
      continue;
    }
    const colour = (value) => {
      const c = readCssColour(value);
      if (!c) throw new Error(`SETUP: fieldFocusPaint ${surface}/${context} ${box} (theme=${theme}) painted ${JSON.stringify(value)}, which the harness cannot parse`);
      return c.length === 4 && c[3] !== 1 ? null : c.slice(0, 3);
    };
    const bad = [];
    const fill = colour(p.own);
    if (!fill || !same(fill, tok["field-bg-focus"])) bad.push(`focus fill ${p.own} != --${ns}-field-bg-focus ${raw["field-bg-focus"]}`);
    const off = [0, 1, 2, 3].filter((i) => !(p.widths[i] > 0 && !/^(?:none|hidden)$/.test(p.styles[i] || "none")) || !colour(p.sides[i]) || !same(colour(p.sides[i]), tok["field-border-focus"]));
    if (off.length) bad.push(`focus side(s) ${off.join(",")} not a painted --${ns}-field-border-focus ${raw["field-border-focus"]} (${p.sides.join(" | ")}; widths ${p.widths.join("/")}; styles ${p.styles.join("/")})`);
    if (!p.boxShadow || p.boxShadow === "none") bad.push("no focus ring (box-shadow none)");
    log.focusMeasured.push(box);
    results.push({
      surface, theme, selector: box, state: `focus|${context}`, check: "fieldFocusPaint",
      status: bad.length ? "FAIL" : "OK",
      actual: bad.length ? bad.join("; ") : `fill and four painted sides on the focus tokens, ring ${p.boxShadow.slice(0, 48)}`,
      expected: `focused value box (spec §2.1): fill --${ns}-field-bg-focus, four painted --${ns}-field-border-focus sides, the --${ns}-focus-ring glow`,
      note: null,
      harness: `:focus-visible=${p.focusVisible} :hover=${p.hovered} (activeElement ${p.active})`,
    });
  }
}

async function recordValueBoxHover(page, surface, url, theme, results, sw) {
  const cfg = VALUE_BOX_LEGS[surface];
  if (!cfg) throw new Error(`SETUP: fieldHoverContrast has no VALUE_BOX_LEGS entry for ${surface}`);
  const log = { surface, theme, measured: [], unmeasured: [], focusMeasured: [], focusUnmeasured: [] };
  for (const leg of cfg.legs) {
    const boxes = leg.boxes.map((sel) => {
      const entry = cfg.boxes.find(([box]) => box === sel);
      if (!entry) throw new Error(`SETUP: VALUE_BOX_LEGS.${surface} leg ${leg.context} names ${sel}, which is not in its boxes list`);
      return entry;
    });
    const close = await leg.open(page, url, theme, sw);
    try {
      await recordValueBoxes(page, surface, theme, results, leg.context, boxes, log);
      if (leg.focus) {
        const stray = leg.focus.filter((sel) => !leg.boxes.includes(sel));
        if (stray.length) throw new Error(`SETUP: VALUE_BOX_LEGS.${surface} leg ${leg.context} reads focus on ${stray.join(" / ")}, which it does not measure`);
        await recordValueBoxFocus(page, surface, theme, results, leg.context, leg.focus, log);
      }
    } finally {
      if (close) await close();
    }
  }
  valueBoxHoverLog.push(log);
  const reached = new Set([...log.measured, ...log.unmeasured]);
  const missing = cfg.boxes.map(([box]) => box).filter((box) => !reached.has(box));
  if (missing.length) throw new Error(`SETUP: fieldHoverContrast ${surface} reached no ${missing.join(" / ")} (theme=${JSON.stringify(theme)}) -- the ${surface} leg would be vacuous for that box`);
}

async function runLibraryTheme(page, extBase, theme, checks, results) {
  if (checks.some((c) => c.tab)) throw new Error("SETUP ERROR [library]: checklist `tab:` is options-only");
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
  // opens either for some OTHER check's sake. (It covered the retired sort
  // segment's unpressed cell, D6/T4's real consumer, until T6.)
  await recordWeakTextHits(page, "library", theme, results, "vocab-rest");

  const vocabChecks = checks.filter((c) => libraryView(c.selector) === "vocab");
  const notesChecks = checks.filter((c) => libraryView(c.selector) === "notes");

  if (vocabChecks.length) {
    // Setup clicks throw rather than silently no-op on a missing target: a
    // future selector rename (Task 9/10 migration) or a broken seed must
    // make this whole run fail loudly (exit 2), not quietly leave every
    // downstream check reading a zero-size/never-opened element as "PASS".
    if (vocabChecks.some((c) => needsDetailOpen(c.selector))) {
      // The rich LIB_SEED word (groups, two contexts, a note): every detail
      // row needs one of those parts to exist, and the first row of the
      // "latest" sort is whichever word the seed wrote last.
      const head = page.locator("#vocab-list .vocab-card")
        .filter({ has: page.locator(".notes-row-title", { hasText: new RegExp(`^${LIB_SEED.richTerm}$`) }) })
        .locator(".notes-card-head").first();
      if (!(await head.count())) {
        throw new Error(`SETUP: no vocabulary row titled ${JSON.stringify(LIB_SEED.richTerm)} to open the detail pane (theme=${theme}) -- LIB_SEED broken or the row title class renamed`);
      }
      await head.click(); await page.waitForTimeout(250);
      await page.waitForFunction(() => {
        const host = document.getElementById("vocab-ref-result");
        return !host || host.dataset.refState !== "word" || !!host.querySelector(".xp-dict-entry, .xp-dict-msg, .xp-dict-local-box");
      }, null, { timeout: TIMEOUT_MS }).catch((err) => {
        console.warn(`[render-audit] WARN library/${theme || "default"}: the dictionary column never settled after opening ${JSON.stringify(LIB_SEED.richTerm)} (${err && err.name}) -- open-to-look-up stuck in "word"?`);
      });
    }
    for (const check of vocabChecks) {
      // The batch row, per check (T4d review): since it REPLACES the count row
      // (that row goes `hidden` while a selection exists), opening it once for
      // the whole view would run every other check against a header with no
      // count row -- headerRowsFlush and #vocab-select-all would then measure
      // nothing. So each check gets exactly the state it names: batch-row
      // checks run selected, everything else at rest. Idempotent, and it
      // re-asserts after driveRowStates' own reload just like needsNoteDirty.
      await setVocabBatchOpen(page, theme, needsBatchBarOpen(check.selector));
      // .vocab-note-save cannot use the same one-shot-at-the-top pattern as
      // needsDetailOpen/needsBatchBarOpen above: `state: "rowStates"`
      // (driveRowStates) does its OWN full `page.goto()` reload partway
      // through this loop and restores only the "current row" / "selected
      // for batch" flags it snapshots before that reload (which is why the
      // detail-open and batch-bar groups above survive it untouched) -- it
      // has no notion of "the note field was typed into" and silently drops
      // that JS-runtime-only state.
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
          // Typed without taking focus (T7b): the note box saves when it loses
          // focus, so a fill() would commit the probe to the seed the moment a
          // later row moved focus -- and the next dirtying fill of the same
          // text would then change nothing. Same `input` listener, no blur.
          await noteInput.evaluate((el) => {
            el.value = `${el.value} render-audit probe`;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          });
          await page.waitForSelector(".vocab-note-save:not([hidden])", { timeout: TIMEOUT_MS });
        }
      } else {
        // And undone for every other row: a dirty box that a later row
        // focuses and leaves would save the probe into the seed mid-run.
        await page.evaluate(() => {
          const el = document.querySelector("#vocab-detail .vocab-note-input");
          const probe = " render-audit probe";
          if (!el || !el.value.endsWith(probe)) return;
          el.value = el.value.slice(0, -probe.length);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
      if (needsGroupEditorOpen(check.selector)) {
        const open = await page.evaluate(() => !!document.querySelector("#vocab-detail #vocab-group-editor:not([hidden])"));
        if (!open) {
          const edit = page.locator("#vocab-detail .vocab-edit-groups").first();
          if (!(await edit.count())) {
            throw new Error(`SETUP: no "#vocab-detail .vocab-edit-groups" to open the group editor (theme=${theme}) -- the detail is not open or the markup was renamed`);
          }
          await edit.click();
          await page.waitForSelector("#vocab-detail #vocab-group-editor:not([hidden]) .vocab-group-unit", { timeout: TIMEOUT_MS });
          // Opening puts the caret in the group box; a default-state row must
          // not read the focus fill.
          await page.evaluate(() => document.activeElement?.blur?.());
          await page.mouse.move(0, 0);
          await settleAnimations(page);
        }
      }
      // The Filter popover, one wrapper for both openers (T4b / T6a): rows in
      // FILTER_SET_SELECTORS open it with showPopover() (no pointer or focus
      // move); any other row whose element -- or its height / width
      // comparison -- sits in the closed popover is revealed by a real click
      // (libRevealFilterSet). A row with its own `open` click is revealed
      // only when that click target sits in the popover (the group listbox
      // button): its element appears through that click, and when the click
      // target is #vocab-filter-narrow itself (T4b's open-state rows) a
      // reveal first would make its Space press close the popover again.
      // Opened once, closed once; nothing opens in the wide form.
      let filterSetOpened = false;
      if (needsFilterSetOpen(check)) {
        const opened = await setFilterSetOpen(page, true);
        if (opened === "missing" || opened === "stuck") {
          throw new Error(`SETUP: could not open #vocab-filter-set for ${check.selector}|${check.state} (theme=${theme}): ${opened}`);
        }
        filterSetOpened = opened === "ok";
        await settleAnimations(page);
      } else {
        const revealTargets = check.open?.click ? [check.open.click]
          : [check.selector, check.expect?.heightEqWith?.selector, check.expect?.widthLteWith?.selector];
        for (const sel of revealTargets) {
          if (sel && await libRevealFilterSet(page, sel)) { filterSetOpened = true; break; }
        }
      }
      await runOneCheck(page, theme, check, results, extBase);
      if (filterSetOpened) await libHideFilterSet(page);
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
    if (notesChecks.some((c) => needsNotesBatchBarOpen(c.selector))) {
      const hit = page.locator("#notes-list .notes-hit-btn").first();
      if (!(await hit.count())) {
        throw new Error(`SETUP: no "#notes-list .notes-hit-btn" to reveal .notes-batch-bar (theme=${theme}) -- seed fixture broken or markup renamed`);
      }
      await hit.click({ modifiers: ["Control"] });
      await page.waitForSelector("#notes-batch-toolbar.selecting", { timeout: TIMEOUT_MS });
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

  // ---- fieldHoverContrast (family 14), the library value-box leg (stage 4
  // Task 7, spec §5.2; R7: the same functions as popup's leg). Last on
  // purpose: its vocab leg reloads the page and opens a word with a selection
  // (the notes leg then reuses that page), which must not widen family 13's
  // vocab / notes scans above; the run-level valueBoxLegCoverage /
  // valueBoxFocusCoverage checks hold every theme to all eight boxes measured
  // and the dictionary language's listbox button read focused.
  await recordValueBoxHover(page, "library", `${extBase}library.html`, theme, results, null);
}

// The provider <select> is a listbox-enhanced value carrier (hidden;
// COMPONENTS.md §6.4 exception 2) -- drive it the way a user does: open the
// combobox button, click the option. The option click writes select.value
// and dispatches the same bubbling change event options.js's autosave
// listener is on, exactly like a real edit. Shared by both the aiProvider
// group's openai switch and its own gemini restore (Task 4 fix wave,
// Controller ruling C follow-up): one implementation, one place to fix if
// the listbox markup ever changes.
//
// `sw` (optional): pass the extension's service-worker handle when the
// caller is about to page.goto() afterward and needs the pick to actually be
// on disk first, not just reflected in this page's own DOM. options.js's
// autosave is debounced 500ms after the "change" event (scheduleAutoSave);
// the click's synchronous change-listener flips #fields-<value>'s `hidden`
// attribute immediately (which is all the `waitForSelector` below proves),
// but the chrome.storage.local write does not land until that timer fires --
// and a page.goto() shortly after tears down the page's JS (and its pending
// setTimeout) before the write happens if nothing waits for it. Caught
// empirically (this task's fix-round verification): a fixed page.waitForTimeout
// guess raced this under shard load and produced the exact same "provider
// still isn't gemini after reload" SETUP ERROR the switchChecks guard below
// was added to catch, so this polls the ACTUAL persisted value via the
// service worker instead of guessing a delay.
async function selectProviderViaListbox(page, value, sw) {
  await page.click("#opt-ai-provider-btn");
  await page.click(`#opt-ai-provider-list [role="option"][data-value="${value}"]`);
  await settleAnimations(page);
  await page.waitForSelector(`#fields-${value}`, { state: "visible", timeout: TIMEOUT_MS });
  if (!sw) return;
  const deadline = Date.now() + TIMEOUT_MS;
  let persisted;
  do {
    persisted = await sw.evaluate(async () => (await chrome.storage.local.get(["aiProvider"])).aiProvider);
    if (persisted === value) return;
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(`SETUP ERROR [options|.switch group]: aiProvider autosave never persisted ${JSON.stringify(value)} to chrome.storage.local (last seen ${JSON.stringify(persisted)}) -- a page.goto() right after this would read the stale value`);
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
  // Stage 4 Task 6 (spec §5.2): popup's value-box rows. #search-input sits in
  // .search-row, which popup.js hides unless optShowSearch; #token-input in
  // #login-section, which the logged-in seed keeps hidden. Same fixture
  // class as the #main-section unhide above: no rule under test reads either
  // `.hidden`, they only need a box to measure and to focus.
  if (surface === "popup" && checks.some((c) => c.selector === "#search-input" || c.selector === "#token-input")) {
    const legs = await page.evaluate(() => {
      const search = document.querySelector(".search-row");
      const login = document.getElementById("login-section");
      search?.classList.remove("hidden");
      login?.classList.remove("hidden");
      return !!search && !!login;
    });
    if (!legs) throw new Error(`SETUP: popup.html is missing .search-row / #login-section (theme=${theme})`);
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
  if (surface !== "options" && checks.some((c) => c.tab)) {
    throw new Error(`SETUP ERROR [${surface}]: checklist \`tab:\` is options-only`);
  }
  if (surface === "options") {
    // Rows that name their own tab (checklist `tab:` field, stage 3c) run in
    // the tab-resolving group below and nowhere else; every other group keeps
    // its selector-derived membership.
    const tabChecks = checks.filter((c) => c.tab);
    const untabbed = checks.filter((c) => !c.tab);
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
    const tagGovChecks = untabbed.filter((c) => c.selector.includes(".tag-gov-") || c.selector.includes("#tag-gov-"));
    // presetRowChecks (design-uplift, preset-row redesign, 2026-08-04):
    // .theme-preset-btn.active only exists once SOME preset is selected --
    // reuses the exact same "click flexoki on the appearance tab" step
    // presetPreviewChecks already needs (both groups just need any preset
    // active; there is nothing flexoki-specific about either check), so
    // it's folded into that same click rather than a second one.
    const presetRowChecks = untabbed.filter((c) => c.selector === ".theme-preset-btn.active");
    const presetPreviewChecks = untabbed.filter((c) => c.selector.startsWith("#preset-preview-section"));
    // .saved-theme-btn (debt-sweep 2026-08-07): same #panel-appearance tab as
    // the preset-row group above, so it reuses that group's #tab-appearance
    // click rather than a third one. Storage was seeded before goto() (see
    // runSimpleTheme's top), so the button already exists once the tab is
    // active -- no extra click of its own needed.
    const savedThemeChecks = untabbed.filter((c) => c.selector === ".saved-theme-btn");
    // .key-wrap lives in #panel-general. It is visible on a bare goto(), but
    // the tagGov and preset groups above BOTH click their way to another tab
    // first, so by the time otherChecks runs the general panel is
    // display:none and its controls cannot even take focus (a §8 focusWithin
    // check fails at setup, which is how this was found). Click back
    // explicitly rather than depending on group order.
    const keyWrapChecks = untabbed.filter((c) => c.selector === ".key-wrap");
    // T6 field-width checks (taste-uplift-batch3, D2). #opt-openai-baseurl
    // (.fg-url tier, retired in stage 3c) and #opt-openai-model (plain-text
    // tier, retired in stage 3c) both live in
    // #fields-openai (#panel-ai), which is `hidden` by default -- the
    // provider select defaults to gemini (options.js's updateProviderFields)
    // -- so both need the provider switched to openai before they exist at
    // all, not just a tab click. #opt-ai-cache-duration (number tier) lives
    // on the separate #panel-ai-behavior tab, reached with a plain click.
    // Both run in their OWN groups below (like keyWrapChecks above), not
    // folded into otherChecks. Widened (Task 4, ui-system-stage2, Controller
    // ruling C): the re-pinned #fields-openai .key-wrap row needs the SAME
    // "provider switched to openai" precondition as the two above.
    const aiProviderChecks = untabbed.filter((c) => c.selector === "#opt-openai-baseurl" || c.selector === "#opt-openai-model"
      || c.selector === "#fields-openai .key-wrap");
    const aiBehaviorChecks = untabbed.filter((c) => c.selector === "#opt-ai-cache-duration");
    // `.switch` rows (taste-uplift batch4 T1 reference instance + T2's one
    // row per DOM shape): the track rows (`#id ~ .switch-track`) and the
    // input hit-rect rows (`hitRectMin`). They live on several tabs, so the
    // group below resolves each row's own panel instead of hard-coding one.
    // The row-model pref-row entries (ui-system-stage0-design §4) used to be
    // swept in here by a marker-substring match; since stage 3c they name
    // their tab in the checklist (`tab:`) and run in the same loop through
    // `tabChecks` instead. #opt-popup-width-custom stays named below.
    // Widened again (Task 4, ui-system-stage2, Controller ruling C):
    // #test-gemini needs the SAME "resolve the owning tab, fresh page
    // reload first" treatment this group already gives every other tab-
    // scoped row -- it lives in #fields-gemini (#panel-ai), which the
    // EARLIER aiProviderChecks group (above, but its own execution block
    // runs before this one -- see below) hides by switching the provider to
    // openai through the listbox. That switch autosaves `aiProvider:
    // "openai"` into chrome.storage; a bare `page.goto()` does NOT reset
    // chrome.storage (only this run's own `mkdtempSync()` profile teardown
    // does, at the very end), so a fresh reload alone does NOT restore the
    // gemini default -- options.js's `updateProviderFields()` reads whatever
    // is already in storage at init. Regression (shards 0/1, this task):
    // this comment used to claim the reload itself restored gemini, which
    // was never true; the fix is that the aiProviderChecks execution block
    // now explicitly restores gemini (`selectProviderViaListbox(page,
    // "gemini", sw)`) right after its own checks run, so by the time this
    // group's goto() below fires, gemini is already the persisted default
    // again. That restore call passes `sw` for a second reason found DURING
    // this same fix's own verification: the autosave that persists the
    // click is debounced 500ms, so a restore-then-immediately-goto() without
    // waiting for the actual write can still lose the race under shard load
    // (the goto() tears down the page's pending setTimeout before it fires)
    // -- `selectProviderViaListbox` polls chrome.storage.local through the
    // service worker until the write is actually on disk, not just clicked.
    // The guard right after that goto() (`#fields-gemini` must be
    // visible) fails fast with a SETUP ERROR instead of a silent 15s
    // per-row timeout if some future group breaks this invariant again.
    // #opt-ai-provider-btn/#translate-target-lang-btn would already match
    // via their own hitRectMin (named explicitly here anyway, for a reader
    // who is not tracing that incidental overlap); the two `state: "open"`
    // popover rows resolve #panel-ai the same way every other row here does
    // (`.closest(".panel")` off their own selector) and skip this loop's own
    // visibility wait below (see that comment). Stage-3b Task 2: those two
    // rows' selectors are anchored to #opt-ai-provider's own IDs
    // (`#opt-ai-provider-btn + .listbox-pop`, `#opt-ai-provider-list
    // .listbox-opt`, tests/render-audit-checklist.mjs), not the bare
    // `.listbox-pop`/`.listbox-opt` classes a "first in DOM order" match
    // used to rely on -- #opt-lang (General tab, ahead of AI Providers in
    // options.html) became a second `data-listbox` consumer and would
    // otherwise have matched first, resolving #panel-general instead.
    // `.pick-mark` (stage-3b Task 1) widened this the same way `.switch-
    // track` is already generic here, not via a per-selector name like the
    // #opt-popup-width-custom/#test-gemini entries below: `#panel-bookmarks`
    // is `display:none` until #tab-bookmarks is clicked, same as every
    // other non-default tab, and otherChecks (the plain loop further down)
    // does NOT switch tabs -- it assumes whatever #tab-general leaves
    // active. A colour-only check (bgEqVar/borderColorEqVar) reads
    // getComputedStyle() fine either way (style still resolves under
    // display:none), so a bgEqVar-only row would have silently "passed"
    // against an invisible element with no layout box at all; only the
    // widthPx/heightPx checks on the SAME element actually caught this
    // (measured: 30 FAILs, all `actual=null` -- confirmed BEFORE this line
    // existed, by running the checklist's two new pick-mark entries without
    // it).
    const switchChecks = untabbed.filter((c) => (c.selector.includes(".switch-track") || c.selector.includes(".pick-mark")
      || c.expect?.hitRectMin
      || c.selector === "#opt-popup-width-custom"
      || c.selector === "#test-gemini" || c.selector === "#opt-ai-provider-btn"
      || c.selector === "#translate-target-lang-btn"
      // Stage-3b Task 2: substring match (not exact-string), same reasoning
      // as .switch-track/.pick-mark above -- the two `state: "open"` popover
      // rows now carry #opt-ai-provider-anchored selectors
      // (`#opt-ai-provider-btn + .listbox-pop`, `#opt-ai-provider-list
      // .listbox-opt`), not the bare class strings this used to `===` against.
      || c.selector.includes(".listbox-pop") || c.selector.includes(".listbox-opt")
      // Fix round 1 (review MINOR finding 2): Appearance's theme select
      // coverage row. Stage-3b Task 4 re-pinned the checklist row's own
      // selector from `#opt-theme` to `#opt-theme-btn` (listbox.js
      // hides the native select and builds the button in its place). The
      // vocab AnkiConnect key row that used to be sniffed here by a
      // `.key-wrap:has(` substring now names its tab in the checklist
      // (`tab: "vocab"`, stage 3c).
      || c.selector === "#opt-theme-btn"
      // Stage-3b Task 5 gate-closing rows: #opt-md-image-policy-btn (Markdown
      // tab, no disclosure) and #obsidian-route-btn/#obsidian-vault (same tab,
      // inside the closed "Obsidian" Send-to disclosure -- this loop's own
      // details-opener a few lines down reaches it the same way it already
      // reaches #dict-anki-key's disclosure) are all STATIC or built-at-load
      // elements (renderExportTargets() runs once, unconditionally, during
      // the initial settings load -- not lazily on tab activation), so they
      // exist in the DOM regardless of which tab is active and can use this
      // group's generic `.closest(".panel")` tab resolution exactly like
      // #opt-theme-btn/.key-wrap:has(...) above. #dict-anki-deck is the same
      // shape as #dict-anki-key one line up: a static entry-block field
      // inside the Vocabulary tab's closed "Export and integrations"
      // disclosure.
      || c.selector === "#opt-md-image-policy-btn" || c.selector === "#obsidian-route-btn"
      || c.selector === "#obsidian-vault" || c.selector === "#dict-anki-deck"));
    const otherChecks = untabbed.filter((c) => !tagGovChecks.includes(c) && !presetPreviewChecks.includes(c)
      && !presetRowChecks.includes(c) && !savedThemeChecks.includes(c) && !keyWrapChecks.includes(c)
      && !aiProviderChecks.includes(c) && !aiBehaviorChecks.includes(c) && !switchChecks.includes(c));
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
      // #preset-preview-section carries the `hidden` attribute (options.html;
      // stage-3b Task 4 moved it off `style="display:none"`, spec §3) until
      // options.js's renderPresetPreview() sees a non-empty currentPresetKey
      // -- click a site-theme preset button on the "appearance" tab (same
      // tab panel the summary lives on) to reveal it. This is a DIFFERENT
      // preset system from the THEMES loop this runner is already iterating
      // (that one is the extension UI's own popup/options/library chrome;
      // this is the pinboard.in SITE theme picker) -- but "Extension pages
      // follow the Pinboard theme preset" means clicking it ALSO re-derives
      // documentElement.dataset.theme (and its density, options-theme-
      // early.js's own PBP_OPTIONS_DENSITY_MAP[target]) onto "flexoki" as a
      // side effect (the exact drift weakTextOnFill's own restore, further
      // down, documents as "F1") -- restored below before any later group
      // measures the page. The same click also satisfies presetRowChecks:
      // it's what puts .active on a .theme-preset-btn in the first place.
      await page.click("#tab-appearance");
      await page.click(".theme-preset-btn[data-theme='flexoki']");
      await page.waitForSelector("#preset-preview-section:not([hidden])", { timeout: TIMEOUT_MS });
      for (const check of presetPreviewChecks) await runOneCheck(page, theme, check, results);
      for (const check of presetRowChecks) await runOneCheck(page, theme, check, results);
      if (savedThemeChecks.length) {
        await page.waitForSelector(".saved-theme-btn", { timeout: TIMEOUT_MS });
        for (const check of savedThemeChecks) await runOneCheck(page, theme, check, results);
      }
      // Restore documentElement.dataset.theme (and its density) in-page --
      // NOT a reload, which would cost every remaining group's own tab
      // click again for no benefit -- via the exact function the boot/
      // reload path calls, same technique and same `follow: true` (this
      // fixture's untouched "Extension pages follow the Pinboard theme
      // preset" default) as weakTextOnFill's own restore below. Every group
      // from here on (keyWrap/other/aiProvider/aiBehavior/switch+tab)
      // trusts the live page to already be on THIS theme -- so,
      // like weakTextOnFill's own `liveTheme` check and the `.switch` group's
      // `_swLanded` check further down, this reads BOTH attributes back and
      // fails setup loudly on a mismatch instead of letting a drifted page
      // silently reach the checks below with a comfortable/wrong-theme face
      // (fix round 1: the render-audit run this task's own densityTier check
      // caught had exactly this drift going undetected here).
      const { themePresetKey: _ptPresetKey, optTheme: _ptMode } = themeToStorage(theme);
      const _ptLanded = await page.evaluate(({ mode, presetKey }) => {
        if (typeof pbpApplyOptionsEarlyTheme !== "function") return null;
        pbpApplyOptionsEarlyTheme(mode, presetKey, true);
        return {
          theme: document.documentElement.dataset.theme || null,
          density: document.documentElement.dataset.density || null,
        };
      }, { mode: _ptMode, presetKey: _ptPresetKey });
      if (!_ptLanded) {
        throw new Error(`SETUP ERROR [options|${theme}|preset-preview group]: pbpApplyOptionsEarlyTheme is not defined on options.html -- cannot restore documentElement.dataset.theme after the preset-preview click`);
      }
      const _ptExpectedTheme = expectedDatasetTheme(theme);
      if (_ptLanded.theme !== _ptExpectedTheme) {
        throw new Error(`SETUP ERROR [options|${theme}|preset-preview group]: restore left documentElement.dataset.theme=${JSON.stringify(_ptLanded.theme)}, expected=${JSON.stringify(_ptExpectedTheme)} -- the theme re-apply did not take, so every group after this one would measure another theme's palette`);
      }
      const _ptExpectedDensity = OPTIONS_DENSITY.densityOf(theme) === "compact" ? "compact" : null;
      if (_ptLanded.density !== _ptExpectedDensity) {
        throw new Error(`SETUP ERROR [options|${theme}|preset-preview group]: restore left documentElement.dataset.density=${JSON.stringify(_ptLanded.density)}, expected=${JSON.stringify(_ptExpectedDensity)} -- the theme re-apply did not restore density, so every density-tiered check after this one would measure the wrong tier`);
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
      // Inert (final fix wave, Ruling 29 F9): options.js listens on every
      // form input for a 500ms-debounced autosave (:3337 "Listen on all
      // form inputs for auto-save") -- this selectOption's `change` event
      // schedules a write of `aiProvider: "openai"` into chrome.storage
      // that eventually lands, same as a real user's own edit would. It is
      // harmless here because the WHOLE profile it lands in is this run's
      // own ephemeral `mkdtempSync()` userDataDir (main(), further down),
      // torn down with `rmSync()` when the run ends -- no real account,
      // real settings, or cross-run state is ever touched.
      // Drive it the way a user does (selectProviderViaListbox): open the
      // combobox button, click the option.
      await selectProviderViaListbox(page, "openai");
      await page.waitForSelector("#fields-openai #opt-openai-baseurl", { state: "visible", timeout: TIMEOUT_MS });
      for (const check of aiProviderChecks) await runOneCheck(page, theme, check, results);
      // Restore the default (Task 4 fix wave, Controller ruling C follow-up):
      // this group's own selectOption above autosaves `aiProvider: "openai"`
      // into the SAME persistent Playwright profile every later group in this
      // theme's pass runs on. Nothing after this point re-navigates with a
      // fresh storage seed until the switchChecks/weakTextOnFill goto()s
      // further down, and page.goto() does NOT reset chrome.storage -- it is
      // only the extension's OWN JS (updateProviderFields(), read once at
      // options.js init) that decides #fields-gemini's `hidden` attribute
      // from whatever `aiProvider` is already in storage. Left unrestored,
      // the switchChecks group's #test-gemini row (which counts on the
      // gemini default to make #fields-gemini visible after its own reload)
      // waits the full TIMEOUT_MS for a selector that has genuinely become
      // unreachable and then dies -- this is what broke shards 0/1 when Task
      // 4 widened switchChecks to include #test-gemini without accounting
      // for this group running first and switching the provider away. Pass
      // `sw` here (not on the openai switch above): the switchChecks group a
      // few lines down does its OWN page.goto() shortly after this, so this
      // is the one call whose autosave genuinely needs to be on disk before
      // the next navigation, not just reflected in this page's live DOM.
      await selectProviderViaListbox(page, "gemini", sw);
    }
    if (aiBehaviorChecks.length) {
      await page.click("#tab-ai-behavior");
      await page.waitForSelector("#opt-ai-cache-duration", { state: "visible", timeout: TIMEOUT_MS });
      for (const check of aiBehaviorChecks) await runOneCheck(page, theme, check, results);
    }
    if (switchChecks.length || tabChecks.length) {
      // Fresh navigation with the theme re-applied first (taste-uplift batch4
      // Ruling 30, T1 review N1): the appearance group above clicks the
      // flexoki SITE preset, whose handler re-derives documentElement's
      // data-theme, so a switch row measured on the page it leaves behind
      // reads flexoki's palette for most themes. Same reset the
      // weakTextOnFill loop below does for itself. seedChecked is untouched:
      // runOneCheck still seeds and restores each row's input.
      const { themePresetKey: _swPresetKey, optTheme: _swMode } = themeToStorage(theme);
      await setTheme(sw, _swPresetKey, _swMode);
      await page.goto(url, { waitUntil: "load", timeout: TIMEOUT_MS });
      await page.waitForTimeout(500);
      // Guard the re-apply itself (batch4 fix round, I1): the switch rows'
      // bgEqVar resolves the token on the SAME page it measures, so a row
      // measured on the flexoki page the appearance group leaves behind still
      // passes -- recorded negative control: with the three re-apply lines
      // above removed, shard 1/4 landed on flexoki-light/-dark for all four of
      // its themes and still reported 120 OK. Only the page's own data-theme
      // can tell, so check it before any row runs.
      const _swLanded = await page.evaluate(() => document.documentElement.getAttribute("data-theme") || "");
      if (_swLanded !== theme) {
        throw new Error(`SETUP ERROR [options|${theme}|.switch group]: page is on data-theme=${JSON.stringify(_swLanded)} -- the theme re-apply did not take, so every switch row would measure another theme's palette`);
      }
      // Guard the provider default too (this task's fix, Task 4 regression):
      // #test-gemini (in switchChecks, above) needs #fields-gemini visible,
      // which needs `aiProvider` in chrome.storage to still be "gemini" --
      // the aiProviderChecks group earlier in this same theme pass restores
      // it explicitly, but a bare `page.goto()` does NOT reset storage on
      // its own (see the comment on switchChecks' definition above), so a
      // future group that switches the provider and forgets to restore it
      // would otherwise fail silently here: every switchChecks row up to
      // #test-gemini would pass, then #test-gemini's own visibility wait
      // would burn the full TIMEOUT_MS before dying. Read the `hidden`
      // attribute directly (not page.waitForSelector) so this doesn't
      // depend on #tab-ai being the active panel yet -- the next block's
      // per-check tab click handles that.
      const _swGeminiHidden = await page.$eval("#fields-gemini", (el) => el.hidden).catch(() => true);
      if (_swGeminiHidden) {
        throw new Error(`SETUP ERROR [options|${theme}|.switch group]: provider is not gemini after reload -- an earlier group left the provider persisted in chrome.storage`);
      }
      for (const check of [...switchChecks, ...tabChecks]) {
        // The row's own tab (every settings panel is display:none until its
        // tab is clicked) -- named by the checklist's `tab:` field, or
        // derived from the selector's owning .panel -- then any closed
        // non-help <details> around it (the vocabulary tab's dict-echo row
        // sits in a closed disclosure).
        const tabId = check.tab ? `tab-${check.tab}`
          : await page.$eval(check.selector, (el) => el.closest(".panel")?.id.replace(/^panel-/, "tab-") || null).catch(() => null);
        if (!tabId || !(await page.$(`#${tabId}`))) throw new Error(`SETUP ERROR [${check.surface}|${theme}|${check.selector}|${check.state}]: no owning tab (${check.tab ? `tab: "${check.tab}"` : ".closest(.panel)"})`);
        await page.click(`#${tabId}`);
        // JS-built rows (Storage's #storage-cats) exist only after the click.
        await page.waitForSelector(check.selector, { state: "attached", timeout: TIMEOUT_MS });
        await page.$eval(check.selector, (el) => {
          for (let d = el.closest("details"); d; d = d.parentElement?.closest("details")) {
            if (!d.open && !d.classList.contains("context-help")) d.querySelector(":scope > summary")?.click();
          }
        });
        // `state: "open"` rows (Task 4, ui-system-stage2, Controller ruling
        // C) target `.listbox-pop`/`.listbox-opt`, which are still `hidden`
        // at this point -- runOneCheck's OWN "open" handling reveals them
        // with a real keyboard Space press, so waiting for visibility HERE
        // would time out on every one of them before that press ever runs.
        if (check.state !== "open") {
          await page.waitForSelector(check.selector, { state: "visible", timeout: TIMEOUT_MS });
        }
        await runOneCheck(page, theme, check, results);
      }
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
    const fieldHoverKinds = {}; // measured (OK/FAIL) rows per kind
    const fieldHoverUnmeasured = {}; // SETUP rows per kind (reached, never measured)
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
      // fieldHoverContrast (family 14) rides the same clean navigation and
      // the same opened panel, BEFORE this tab's own legs below (the
      // appearance leg's preset click repaints dataset.theme).
      await recordFieldHoverContrast(page, theme, results, `panel:${tabId}`, fieldHoverKinds, fieldHoverUnmeasured);

      if (tabId === "tab-appearance") {
        // #preset-preview-section (F1's drift trigger, see above) + the
        // theme-name popover + a confirm popover all live on this one tab,
        // so they're opened in sequence rather than re-navigating per leg.
        const presetBtn = page.locator(".theme-preset-btn[data-theme='flexoki']").first();
        if (!(await presetBtn.count())) {
          throw new Error(`SETUP: no ".theme-preset-btn[data-theme='flexoki']" on ${tabId} (theme=${theme}) -- weakTextOnFill cannot reach #preset-preview-section`);
        }
        await presetBtn.click();
        await page.waitForSelector("#preset-preview-section:not([hidden])", { timeout: TIMEOUT_MS });
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
        // Wait for the cancelled popover to actually leave (options.js removes
        // it 150ms later under motion). Its removal shrinks the document, the
        // scrollTop the save click left is clamped back, and that scroll event
        // dismisses whatever confirm popover is open by then -- the one opened
        // just below. That was the 15s confirm-yes timeout, and the empty
        // scan when the timing went the other way (final review #17).
        await page.waitForSelector(".theme-name-popover", { state: "detached", timeout: TIMEOUT_MS });

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
        // Centre the row first and let that scroll land: hover() / click()
        // otherwise scroll it to the viewport edge, the popover then opens
        // partly outside the viewport, its own focus() scrolls the document
        // by those few px, and shared.js closes an open confirm on scroll
        // (final review #17; measured: 565 -> 559 the moment it opened).
        await delWrap.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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
    // Non-vacuity (family 14): a population selector that stops matching, a
    // panel that never opens or a fixture that hides every field would
    // otherwise pass as "0 FAIL". Every kind the value-box family ships must
    // have been MEASURED at least once on THIS theme -- a kind reached only
    // as SETUP rows counts as missing (round 2, gates/F2), and the error
    // quotes those rows so the cause is not lost with the run.
    const missingKinds = FIELD_HOVER_REQUIRED_KINDS.filter((k) => !fieldHoverKinds[k]);
    if (missingKinds.length) {
      const unmeasuredNote = missingKinds.filter((k) => fieldHoverUnmeasured[k]?.length)
        .map((k) => `${k}: ${fieldHoverUnmeasured[k].length} reached but unmeasured, e.g. ${fieldHoverUnmeasured[k][0]}`).join("; ");
      throw new Error(`SETUP: fieldHoverContrast measured no visible enabled ${missingKinds.join(" / ")} on any options panel (theme=${JSON.stringify(theme)}; measured kinds ${JSON.stringify(fieldHoverKinds)}${unmeasuredNote ? `; ${unmeasuredNote}` : ""}) -- the sweep would be vacuous for that kind`);
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
  // Centre it BEFORE the click and let the scroll land: a click that has to
  // scroll, or a popover opened against the viewport edge whose focus()
  // scrolls the document, fires a scroll after the confirm popover opens, and
  // shared.js closes an open confirm on scroll (final review #17, same race
  // as the options appearance leg).
  await page.locator("#logout-link").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.click("#logout-link");
  await page.waitForSelector(".confirm-popover .confirm-yes", { timeout: TIMEOUT_MS });
  await page.waitForTimeout(150);
  await recordWeakTextHits(page, "popup", theme, results, "confirm");
  if (confirmChecks.length) {
    for (const check of confirmChecks) await runOneCheck(page, theme, check, results);
  }
  // fieldHoverContrast (family 14), popup leg: its own fresh navigations
  // (the confirm popover above is left open on this page).
  await recordValueBoxHover(page, "popup", url, theme, results, sw);
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
  // The structural carriers an element shows (outline / box-shadow / a
  // border side >= 2px) whose colour actually stands off what is behind the
  // element (>= 1.5:1 against the composited backdrop): a border painted in
  // the backdrop's own colour is no line. Used to ask whether a selected
  // element's cue is its own -- an unselected sibling showing a line on the
  // same carrier means every element of the set carries it (final review
  // #6: forced colours paint a transparent resting edge in CanvasText).
  const rgbaOf = (value) => {
    const m = String(value || "").match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (c, base) => c.slice(0, 3).map((v, i) => v * c[3] + base[i] * (1 - c[3]));
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const backdropOf = (element) => {
    const stack = [];
    for (let node = element.parentElement; node && node.nodeType === 1; node = node.parentElement) stack.push(getComputedStyle(node).backgroundColor);
    let base = [255, 255, 255];
    for (let i = stack.length - 1; i >= 0; i--) { const c = rgbaOf(stack[i]); if (c && c[3] > 0) base = over(c, base); }
    return base;
  };
  const standsOff = (color, backdrop) => { const c = rgbaOf(color); return !!c && c[3] > 0 && ratio(over(c, backdrop), backdrop) >= 1.5; };
  const cueCarriers = (element, style) => {
    if (!element || !style) return [];
    const backdrop = backdropOf(element);
    const out = [];
    if (outlineVisible(style) && standsOff(style.outlineColor, backdrop)) out.push("outline");
    if (shadowVisible(style)) out.push("shadow");
    [0, 1, 2, 3].forEach((index) => {
      if (borderVisible(style, index, 2) && standsOff(style.borderColors[index], backdrop)) out.push(`border${index}`);
    });
    return out;
  };
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
      selected.carriers = cueCarriers(selectedElement, style);
    }
  }
  // An unselected sibling (final review #6): a cue every tab carries is no
  // selection cue -- forced colours paint a transparent resting edge in
  // CanvasText, so the selected tab's border alone proved nothing.
  let unselected = null;
  if (check.unselected) {
    const element = document.querySelector(check.unselected);
    unselected = describe(element);
    if (element) {
      const ariaCurrent = element.getAttribute("aria-current");
      unselected.selected = element.getAttribute("aria-selected") === "true"
        || element.getAttribute("aria-pressed") === "true"
        || (ariaCurrent != null && ariaCurrent !== "false")
        || element.classList.contains("active");
      unselected.carriers = cueCarriers(element, focusStyle(element));
    }
  }

  return {
    queryMatches: matchMedia(query).matches,
    text,
    control,
    focus,
    selected,
    unselected,
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
  probe.unselected = baseline.unselected;
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
      // The scenario switch restyles every colour at once and the tabs
      // transition theirs (0.15s): a probe inside that window reads an
      // in-between edge colour, which the selected / unselected comparison
      // below would take for a line (final review #6).
      await settleAnimations(page);
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
  // The sweep pass runs once, on the deterministic default theme runSweep's
  // options/library legs set up (setTheme(sw, "", "light")) -- a fixed tier,
  // not a per-theme lookup, is correct here.
  densityTier: OPTIONS_DENSITY.densityOf(""), // runSweep's options legs run on setTheme(sw, "", "light")
  // Families 6-9 (design-language gates, 2026-09-05). Geometry is a theme
  // invariant, so one light pass per surface covers every preset.
  // Prose in the reader is typography, not chrome: excluded wholesale.
  excludeWithin: ".doc-body",
  // 6. controlRung -- COMPONENTS.md §1.1 / §6.3: two control heights (md 26,
  //    sm 20 on popup / md-preview; the density rung on options and library)
  //    besides the 24px icon target (family 4 owns icon-only buttons).
  //    Exemptions are structural, each a family with its own rung, not a
  //    per-instance allowlist. See rung.density.
  rung: {
    values: [26, 20], tol: 1,
    // Density rung (COMPONENTS.md §1.1 comfortable/compact columns). Since
    // stage 3c every control on options is on it, and since the 2026-10-03
    // redesign every control on library (composer btnRules' lib branch +
    // the hand-written fields reading --lib-control-h). The sweep runs on
    // the default theme, so it measures the comfortable tier; per-theme
    // heightPx {comfortable, compact} CHECKS rows cover compact. `labelGap`
    // is family 5's label->control contract (.fg only exists on options).
    density: { surface: ["options", "library"], values: { comfortable: [32, 28], compact: [28, 24] }, labelGap: { comfortable: 8, compact: 4 } },
    // densityComponents (Task 4, ui-system-stage2, Controller ruling B):
    // `.listbox-btn` / `.listbox-opt` read `var(--opt-control-h)` directly
    // (options.css, unconditional -- wherever they render), so they
    // are density-tiered wherever they render (html[data-density] is a
    // page-wide attribute, options-theme-early.js). Matched by class
    // regardless of tag (button vs li).
    densityComponents: [".listbox-btn", ".listbox-opt"],
    exempt: [
      "textarea",                                   // multi-line by nature
      "[role='tab']", ".tab-btn", ".lib-tab",       // tab family: 32px on both surfaces
      "#options-search-input",                      // the settings sidebar search box: 32px, the sidebar column's rung shared with the tabs
      ".action-link", ".clear-all-link", ".reset-tab-btn",
      ".tr-link", ".xp-dict-more", ".xp-dict-lemma-link", ".pbp-img-fix-btn", ".pbv-time", // link-styled, no chrome (COMPONENTS.md §0); .pbv-time is the cue row's timestamp (24px hit floor)
      "summary", ".rail-sec-head", ".notes-hit-btn", ".notes-card-head", ".notes-card-top", ".notes-excerpt-jump", ".connection-health-row", ".hl-item-main", ".send-mi", ".pbv-poster", // row rung: whole-row clickables / section headers / status cards / menu rows / the video poster card
      ".theme-preset-btn", ".saved-theme-btn",       // borderless swatch pills (user-selected variant A, d57cdcf): the sm rung minus the collapsed frame
      ".tags-input-wrap > input", ".vocab-group-unit > input", ".source-badge > .src-seg", // fused-shell inners: the shell is measured instead
    ],
    // fused shells measured as the control they are (COMPONENTS.md §8)
    shells: ".tags-input-wrap, .source-badge, .vocab-group-unit",
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
      ".source-badge, .view-toggle, .vocab-group-unit, .tags-input-wrap, .send-split, .typo-seg, .vocab-status-toggles, .notes-color-filters", // fused shells / segmented strips
      ".header-icons, .xp-window-actions, .lib-cluster", // icon-button clusters: not button rows; clusterGap (family 12) holds them to 4px instead
      ".connection-health, .theme-presets-group, .kbd-help-chips, .rail-badges, .hl-filter-row", // status-card grid, swatch-pill / chip rows, the highlight legend (gap = two 6px hit pads)
      ".notes-card-top",                                                      // card head: title + chips, the remove X is absolutely positioned
      // Library word head (T7b): text lines that carry a button, not button
      // rows. The pronunciation line is "IPA · language" + Pronounce 4px
      // after it (spec §4.4); the manage row's 16px column gap is what the
      // Edit groups hang is computed from (16 - 10 = 6 from the group text,
      // spec §4.5). A word with no groups puts the status button and Edit
      // groups side by side 16px apart -- also spec §4.5's ruling, not a
      // stray gap. This exemption covers these two lines only: a button
      // group added to either one later goes in its own container, which
      // this rule then measures at 8.
      ".vocab-pron-row, .vocab-manage-row",
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
  //    or a pill. A fused shell's DESCENDANTS carry concentric (token -
  //    border) radii and are exempt; the shell itself is measured like any
  //    other box (stage 4, spec 2026-09-30-ui-fields-stage4-design §5.1).
  //    Non-uniform corners are skipped by this walk (left/right splits and
  //    single-corner cuts are fused-segment geometry). VALUE BOXES carry a
  //    positive law instead (spec §2.1): all four corners == the surface's
  //    md, by name (`valueBoxes`), with two named exceptions
  //    (`valueBoxExempt`): the theme-name popover input (sm on all four, a
  //    popover's compact field) and the popup tag shell while its suggestion
  //    list is open (.ac-open squares its two bottom corners to seat the
  //    list). runSweep fails SETUP when a surface in
  //    RADIUS_VALUE_BOX_REQUIRED misses a required kind.
  // 10. textFloor -- no visible text under 11px on any surface (popup and
  //     options carried 10px and 9px captions; 11px is every surface's hint size).
  textFloor: { min: 11, exempt: "sup, sub" },
  radiusScale: {
    prefix: { options: "--opt-radius-", popup: "--pp-radius-", library: "--lib-radius-", "md-preview": "--radius-" },
    names: ["sm", "md", "lg", "full", "tag"],
    tokens: { options: [3, 8, 10], popup: [3, 8, 10], library: [4, 8, 12], "md-preview": [4, 8, 12] },
    exemptWithin: ".source-badge, .view-toggle, .vocab-group-unit, .tags-input-wrap, .send-split",
    valueBoxes: {
      options: '.fg input[type="text"], .fg input[type="password"], .fg input[type="number"], .fg textarea, .fg select, .listbox-btn, .mobile-tab-picker select, .options-search input[type="search"]',
      popup: "#url-input, #title-input, #description-input, .tags-input-wrap, #token-input, #search-input",
      library: "#vocab-search, #notes-filter, #vocab-lookup-input, .listbox-btn, .vocab-group-unit, .vocab-note-input",
    },
    valueBoxExempt: '.theme-name-popover input[type="text"], .tags-input-wrap.ac-open',
    // Surfaces whose value-box KIND is the valueBoxes entry a box matches
    // (stage 4 Task 6): popup's url / title / search are all plain text
    // inputs, so a tag/type kind could not hold RADIUS_VALUE_BOX_REQUIRED
    // .popup's six boxes apart. The entries carry no top-level comma of their
    // own, so a plain split is exact here.
    valueBoxKindByEntry: { popup: true },
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
  //     `derivedOffsets`: leading-column alignment (reader note = dot 8 + gap
  //     6 + inset 4; reader section count = 24px button + gap; options sidebar
  //     group label = tab inset sp-5 + the tab's 2px indicator border; popup
  //     form footer = .row inset sp-5 + label column 52 + gap sp-4 = 72px,
  //     --pp-label-indent; library notes dot = (body line 20 - dot 10) / 2 = 5;
  //     library "My note" hang label = the note box's 10px inner inset (spec §4.3)) --
  //     computed from a sibling's width, so never a scale value by
  //     construction. `hairline`: 1px is border compensation.
  spacingScale: {
    prefix: { options: "--opt-sp-", popup: "--pp-sp-", library: "--lib-sp-", "md-preview": "--sp-" },
    // sp-0 = the library/reader hairline rung (2px); "8" (Task 3, ui-system-
    // stage0-design §2/§4) is --opt-sp-8: 32px, the stage-0 section gap;
    // library runs through "9" (sp-6..9 = 32/48/64/96, library redesign
    // 2026-10-03 spec §6.2). Probing a name a surface does not define is
    // harmless: the live-scale read below comes back NaN and is filtered out.
    // tests/ui-contract-tests.mjs pins names + tokens.library to library.css's
    // :root, so the fallback cannot drift from the live scale unnoticed.
    names: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
    tokens: { options: [2, 4, 6, 8, 12, 16, 24, 32], popup: [2, 4, 6, 8, 12, 16, 24], library: [2, 4, 8, 12, 16, 24, 32, 48, 64, 96], "md-preview": [2, 4, 8, 12, 16, 24] },
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
    derivedOffsets: [".hl-item-note", "#hl-rail-section .rail-sec-count", ".tab-group-label", ".form-body > .bottom-bar", ".form-body > .submit-bar", ".form-body > .status-msg", ".notes-hit-dot", ".vocab-sec-note > .lib-hang-label"],
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
  // flex/grid wrapper (e.g. .vocab-group-unit wrapping a field and its two
  // steppers; the retired sort segment was a span wrapping two buttons) so the
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
  //
  // label->control on options is an EXACT --opt-label-gap for the theme's
  // density tier (8 comfortable / 4 compact); .fg exists only on options, the
  // 3..6 range stays for any future non-options .fg consumer.
  {
    const isControl = (el) => el.matches("input, select, textarea, .key-wrap");
    const isAction = (el) => el.matches(".fg-actions, button, .btn");
    const stackedGap = (a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return rb.top < ra.bottom - 0.5 ? null : Math.round((rb.top - ra.bottom) * 100) / 100; // null = side by side
    };
    const push = (el, rel, gap) => hits.push({ kind: "fgRhythm", path: pathOf(el), rel, gap });
    const onDensitySurface = cfg.rung.density.surface.some((name) => location.pathname.endsWith(`/${name}.html`));
    const labelControlOffScale = (gap) => (onDensitySurface
      ? Math.abs(gap - cfg.rung.density.labelGap[cfg.densityTier]) > cfg.rung.tol
      : gap < cfg.rhythmLabelMin || gap > cfg.rhythmLabelMax);
    for (const fg of document.querySelectorAll(".fg")) {
      if (!visible(fg)) continue;
      const kids = Array.from(fg.children).filter(visible);
      for (let i = 1; i < kids.length; i++) {
        const a = kids[i - 1], b = kids[i];
        const gap = stackedGap(a, b);
        if (gap === null) continue;
        if (a.matches("label.bl, .bl") && isControl(b) && labelControlOffScale(gap)) push(b, "label-control", gap);
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
    const controls = [...document.querySelectorAll(`button, .btn, a.btn, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]), select, ${cfg.rung.shells}, ${cfg.rung.densityComponents.join(", ")}`)];
    const shellSel = cfg.rung.shells;
    for (const el of controls) {
      if (!visible(el) || excluded(el)) continue;
      if (cfg.rung.exempt.some((sel) => el.matches(sel))) continue;
      if (el.matches("button, .btn, a.btn") && !el.matches(shellSel) && !iconLabel(el)) continue; // icon-only (x counts as an icon): family 4
      if (!el.matches(shellSel) && el.closest(shellSel)) continue; // inner of a fused shell: the shell is measured
      const h = el.getBoundingClientRect().height;
      // Options and library (every control) and the density components
      // wherever they render sit on the comfortable/compact rung of the
      // theme's pilot density; popup/md-preview stay on 26/20.
      const isDensityComponent = cfg.rung.densityComponents.some((sel) => el.matches(sel));
      const onDensityRung = isDensityComponent || cfg.rung.density.surface.includes(surface);
      const allowedRungs = onDensityRung ? cfg.rung.density.values[cfg.densityTier] : cfg.rung.values;
      if (!allowedRungs.some((v) => Math.abs(h - v) <= cfg.rung.tol)) {
        hits.push({ kind: "controlRung", path: pathOf(el), height: Math.round(h * 100) / 100, detail: `${Math.round(h)}px`,
          expected: allowedRungs.map((v) => `${v}±${cfg.rung.tol}`).join(" | ") });
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
    const mdRadius = parseFloat(rootCs.getPropertyValue(`${cfg.radiusScale.prefix[surface] || "--radius-"}md`));
    const valueBoxSel = cfg.radiusScale.valueBoxes[surface] || null;
    for (const el of document.querySelectorAll("*")) {
      // Descendants only (`parentElement`): the fused shell itself is measured.
      if (!visible(el) || excluded(el) || el.parentElement?.closest(cfg.radiusScale.exemptWithin)) continue;
      if (el.closest("svg")) continue;
      const cs = getComputedStyle(el);
      const corners = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
      if (valueBoxSel && el.matches(valueBoxSel) && !el.matches(cfg.radiusScale.valueBoxExempt)) {
        // Liveness marker, not a hit: runSweep's add() counts it per surface
        // and kind, so a run proves the value-box law measured something (a
        // vacuous walk and a clean one would both read as 0 FAIL).
        const tag = el.tagName.toLowerCase();
        const kind = cfg.radiusScale.valueBoxKindByEntry?.[surface]
          ? valueBoxSel.split(",").map((entry) => entry.trim()).find((entry) => el.matches(entry))
          : tag === "input" ? `input[type="${el.type}"]` : tag === "button" ? "button.listbox-btn"
            : tag === "textarea" || tag === "select" ? tag : `.${el.classList[0]}`;
        hits.push({ kind: "radiusValueBoxMeasured", path: pathOf(el), detail: kind });
        if (!corners.every((c) => !/%$/.test(c) && Math.abs(parseFloat(c) - mdRadius) < 0.5)) {
          hits.push({ kind: "radiusValueBox", path: pathOf(el), radius: corners.join(" "), md: mdRadius, detail: corners.join(" ") });
        }
        continue;
      }
      const chromed = (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") || parseFloat(cs.borderTopWidth) > 0 || cs.outlineStyle !== "none";
      if (!chromed) continue;
      // Non-uniform corners: left/right or top/bottom splits and single-corner
      // cuts are fused-segment geometry and concentric calc(token - 1px)
      // values the scale cannot express -- skipped (the value boxes above are
      // the one shape held to four equal corners).
      if (!corners.every((c) => c === corners[0])) continue;
      const onScale = (r) => /%$/.test(r) || parseFloat(r) === 0 || parseFloat(r) >= 999 || radiusTokens.some((t) => Math.abs(parseFloat(r) - t) < 0.5);
      if (onScale(corners[0])) continue;
      hits.push({ kind: "radiusScale", path: pathOf(el), radius: corners[0], tokens: radiusTokens, detail: corners[0] });
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

// F1 (final fix wave, Ruling 29): "once before each family scan pass" --
// every `add(await page.evaluate(sweepProbe, SWEEP_CFG), ...)` call below
// reads getComputedStyle across every matched element on the current page in
// ONE evaluate() round-trip; sweepProbe itself runs entirely in-page and has
// no pointer API of its own to defend with. A real host cursor resting on
// any one of those elements when the pass starts taints just that element's
// hover-derived colours for the whole pass, the same failure mode
// runOneCheck's own per-check park (above) closes for checklist-driven
// checks. One park immediately before the evaluate() call, here rather than
// duplicated at each of the ~13 call sites, is what "once before each pass"
// means in practice.
async function runFamilySweep(page) {
  await page.mouse.move(0, 0);
  return page.evaluate(sweepProbe, SWEEP_CFG);
}

async function runSweep(page, sw, extBase) {
  const hits = [];
  // family 9 liveness (stage 4): sweepProbe reports every value box whose
  // four corners it measured as a `radiusValueBoxMeasured` marker; those are
  // counted per surface and kind here and never reach the hit list (they
  // are not failures).
  const valueBoxRadii = {};
  const add = (found, surface, context) => {
    for (const h of found) {
      if (h.kind === "radiusValueBoxMeasured") {
        const s = (valueBoxRadii[surface] ||= { measured: 0, paths: new Set(), kinds: {} });
        s.measured++;
        s.paths.add(h.path);
        s.kinds[h.detail] = (s.kinds[h.detail] || 0) + 1;
        continue;
      }
      hits.push({ surface, context, ...h });
    }
  };

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
      // #preset-preview-section carries the `hidden` attribute until a
      // site-theme preset is picked (options.js renderPresetPreview) --
      // click one so this disclosure (and its chevron/padding) actually
      // renders for the sweep, same reasoning as the vocab detail-pane/
      // batch-bar opens below.
      const presetBtn = page.locator(".theme-preset-btn[data-theme='flexoki']").first();
      if (await presetBtn.count()) { await presetBtn.click(); await page.waitForTimeout(150); }
    }
    add(await runFamilySweep(page), "options", tabId);
  }

  // ---- library: vocab (list, detail pane, batch bar) + notes (list, detail pane). ----
  await page.goto(`${extBase}library.html?_ra=sweep#vocab`, { waitUntil: "load", timeout: TIMEOUT_MS });
  await page.waitForSelector("#vocab-list .vocab-card", { timeout: TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(300);
  add(await runFamilySweep(page), "library", "vocab-list");
  // Library redesign T4b: the "Filter" popover is interaction-only UI
  // (ui-primitives.md: register how it opens or it is outside every family).
  if ((await setFilterSetOpen(page, true)) === "ok") {
    await settleAnimations(page);
    add(await runFamilySweep(page), "library", "vocab-filter-set");
    await setFilterSetOpen(page, false);
    await settleAnimations(page);
  }
  // The group listbox renders inside the closed Filter popover whenever the
  // index takes its narrow form (inline in the wide one): open the popover
  // once, the way a user does, then the listbox itself -- the one place its
  // option rows render (ui-primitives: interaction-only UI must be reachable
  // by the gates) -- and sweep that state. T4b's block right above already
  // swept the open Filter popover as "vocab-filter-set"; here only the open
  // listbox is new.
  const filterSetRevealed = await libRevealFilterSet(page, "#vocab-group-filter-btn");
  await page.click("#vocab-group-filter-btn");
  await page.waitForSelector("#vocab-group-filter-list .listbox-opt", { state: "visible", timeout: TIMEOUT_MS });
  add(await runFamilySweep(page), "library", "vocab-listbox-open");
  await page.keyboard.press("Escape");
  if (filterSetRevealed) await libHideFilterSet(page);
  const vocabHead = page.locator("#vocab-list .vocab-card .notes-card-head").first();
  if (await vocabHead.count()) {
    await vocabHead.click(); await page.waitForTimeout(250);
    add(await runFamilySweep(page), "library", "vocab-detail");
  }
  // Ctrl+click on the row head, not a checkbox click: the per-row checkbox was
  // removed 2026-08-06 and selection is now a modified click on the row itself.
  if (await vocabHead.count()) {
    await vocabHead.click({ modifiers: ["Control"] }); await page.waitForTimeout(350);
    add(await runFamilySweep(page), "library", "vocab-batch-bar");
  }
  await page.click("#lib-tab-notes");
  await page.waitForSelector("#notes-list .notes-hit", { timeout: TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(250);
  add(await runFamilySweep(page), "library", "notes-list");
  const notesHit = page.locator("#notes-list .notes-hit-btn").first();
  if (await notesHit.count()) {
    await notesHit.click(); await page.waitForTimeout(250);
    add(await runFamilySweep(page), "library", "notes-detail");
  }
  // Ctrl+click to open .notes-batch-bar.selecting (independent review F3):
  // the sweep used to only single-click a notes row, so .notes-batch-bar's
  // own buttons (including #notes-clear-selection, which shares vocab's
  // "cross" glyph and its 23px hit-area shortfall) were never rendered in
  // an on-screen, selected state and this debt was invisible to the gate.
  // Same modifier-click contract as the vocab list above.
  if (await notesHit.count()) {
    await notesHit.click({ modifiers: ["Control"] }); await page.waitForTimeout(350);
    add(await runFamilySweep(page), "library", "notes-batch-bar");
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
  add(await runFamilySweep(page), "md-preview", "reader");

  // Each interaction-only surface is opened through the page's own opener,
  // probed as its own context, then closed. A surface that fails to render
  // is printed, never skipped silently -- the gate's coverage is the point.
  for (const name of READER_SURFACES) {
    const ok = await page.evaluate(openReaderSurface, name).catch((e) => `threw: ${e.message}`);
    if (ok !== true) { console.warn(`[render-audit] reader surface NOT RENDERED: ${name} (${ok || "opener returned false"}) -- its controls were not measured`); continue; }
    await page.waitForTimeout(150);
    add(await runFamilySweep(page), "md-preview", name);
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
  else add(await runFamilySweep(page), "md-preview", "video");

  // ---- popup: default light + no-preset dark (since batch 2 D6 the latter
  // resolves to the flexoki-dark preset, same as options/library; kept as a
  // separate sweep context because the popup's dark layout deltas live in
  // its own hand-written rules). ----
  await setTheme(sw, "", "light");
  await page.goto(`${extBase}popup.html?_ra=sweeplight`, { waitUntil: "load", timeout: TIMEOUT_MS });
  await page.waitForTimeout(500);
  await page.evaluate(async () => { if (window.PPOffline) await window.PPOffline.refresh(); }).catch(() => {});
  await page.waitForSelector("#offline-queue-bar:not(.hidden)", { timeout: TIMEOUT_MS }).catch(() => {});
  add(await runFamilySweep(page), "popup", "light");
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
  add(await runFamilySweep(page), "popup", "states");

  // ---- popup, the bookmark FORM (stage 4 Task 6, T6-b). Every leg above
  // opens popup.html as its own chrome-extension:// tab, which popup.js
  // correctly treats as unsaveable: #main-section gets `.unsupported-url`,
  // whose CSS display:none's every form row, and .search-row stays hidden
  // unless optShowSearch. So until this leg the sweep had measured exactly
  // one popup value box (the logged-out token field) and the four-corner law
  // was vacuous for the other five. Same fixture class as the checklist's
  // "shown" block (runSimpleTheme): the rules under test never read either
  // class, the boxes only need a box to measure. RADIUS_VALUE_BOX_REQUIRED
  // .popup makes a leg that stops rendering one a SETUP ERROR.
  // Every family runs here. Stage 4 first scoped it to family 9's value-box
  // law because the first full sweep surfaced the label-column indent
  // (padding-left 72px on .bottom-bar / .submit-bar); that is now the derived
  // --pp-label-indent token and a spacingScale derivedOffset, and a full
  // sweep of the form reports nothing else (2026-10-02).
  await page.goto(`${extBase}popup.html?_ra=sweepform`, { waitUntil: "load", timeout: TIMEOUT_MS });
  await page.waitForTimeout(500);
  const formShown = await page.evaluate(() => {
    const main = document.getElementById("main-section");
    const search = document.querySelector(".search-row");
    main?.classList.remove("hidden", "unsupported-url");
    search?.classList.remove("hidden");
    return !!main && !!search;
  });
  if (!formShown) throw new Error("SETUP ERROR: popup form sweep leg: popup.html is missing #main-section / .search-row");
  await page.waitForTimeout(150);
  add(await runFamilySweep(page), "popup", "form");

  // ---- popup, hi-DPI width cap (2026-10-02). Chrome caps an action popup at
  // 800px; popup.css zooms the body at >=144dpi / >=192dpi, so the width the
  // popup asks for is setting x zoom. Over the cap the window is clamped and
  // its auto-size reserves a 10px horizontal-scrollbar strip under the
  // quick-actions (user report, 720px x 1.12 = 806px). Every other leg runs
  // at dpr=1, where neither zoom tier fires, so this was ungated. Measured,
  // not computed from the CSS: the widest setting the popup accepts (read
  // from popup-theme-early.js's clamp), rendered at each tier's dpr, must
  // come out <= 800px; a tier that does not zoom is a SETUP ERROR (the
  // emulation did not reach the media query and the check would be vacuous).
  {
    const earlySrc = readFileSync(resolve(ROOT, "popup-theme-early.js"), "utf8");
    const maxes = [...earlySrc.matchAll(/Math\.min\((\d+),/g)].map((m) => Number(m[1]));
    if (!maxes.length || new Set(maxes).size !== 1) throw new Error(`SETUP ERROR: popup hi-DPI cap: cannot read one popup width ceiling from popup-theme-early.js (found ${JSON.stringify(maxes)})`);
    const widest = maxes[0];
    const prior = await sw.evaluate(() => chrome.storage.local.get({ popupWidth: 550 }));
    await sw.evaluate((w) => chrome.storage.local.set({ popupWidth: w }), widest);
    // Its own page, closed afterwards: a device-metrics override cleared on
    // the shared page leaked dpr 1.5 into every later popup leg (the zoom
    // tier then fired there and controlRung measured 26 x 1.12 = 29.11px).
    const dpiPage = await page.context().newPage();
    const dpiSession = await page.context().newCDPSession(dpiPage);
    try {
      for (const dpr of [1.5, 2]) {
        await dpiSession.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: dpr, mobile: false });
        await dpiPage.goto(`${extBase}popup.html?_ra=sweepdpi${dpr}`, { waitUntil: "load", timeout: TIMEOUT_MS });
        await dpiPage.waitForTimeout(400);
        const m = await dpiPage.evaluate(() => ({
          dpr: window.devicePixelRatio,
          zoom: Number(getComputedStyle(document.body).zoom),
          setting: document.documentElement.style.getPropertyValue("--pp-popup-width"),
          width: document.body.getBoundingClientRect().width,
        }));
        if (!(m.zoom > 1)) throw new Error(`SETUP ERROR: popup hi-DPI cap: no zoom tier fired at dpr ${dpr} (measured ${JSON.stringify(m)}) -- the cap check would be vacuous`);
        if (m.setting !== `${widest}px`) throw new Error(`SETUP ERROR: popup hi-DPI cap: --pp-popup-width is ${m.setting}, expected the ${widest}px ceiling`);
        if (m.width > 800) hits.push({ surface: "popup", context: `dpr${dpr}`, kind: "popupWidthCap", path: "body", width: Math.round(m.width * 100) / 100, zoom: m.zoom, setting: widest });
      }
      console.log(`[render-audit] popup hi-DPI cap: ${widest}px measured at dpr 1.5 and 2 (zoomed body <= 800px)`);
    } finally {
      await dpiSession.detach().catch(() => {});
      await dpiPage.close().catch(() => {});
      await sw.evaluate((w) => chrome.storage.local.set({ popupWidth: w }), prior.popupWidth);
    }
  }

  await setTheme(sw, "", "dark");
  await page.goto(`${extBase}popup.html?_ra=sweepdark`, { waitUntil: "load", timeout: TIMEOUT_MS });
  await page.waitForTimeout(500);
  await page.evaluate(async () => { if (window.PPOffline) await window.PPOffline.refresh(); }).catch(() => {});
  await page.waitForSelector("#offline-queue-bar:not(.hidden)", { timeout: TIMEOUT_MS }).catch(() => {});
  add(await runFamilySweep(page), "popup", "dark");

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
  add(await runFamilySweep(page), "popup", "login");
  await sw.evaluate((tok) => chrome.storage.local.set({ pinboardToken: tok }), SEED_TOKEN_OBF);

  console.log("[radiusScale] value boxes measured (four corners == md): " + ["options", "library", "md-preview", "popup"]
    .map((s) => `${s}=${valueBoxRadii[s]?.measured || 0} (${valueBoxRadii[s]?.paths.size || 0} unique; ${JSON.stringify(valueBoxRadii[s]?.kinds || {})})`).join(" "));
  // Non-vacuity (family 9, stage 4), in the style of family 14's missingKinds
  // guard: every kind RADIUS_VALUE_BOX_REQUIRED lists for a surface must have
  // been measured at least once, or the value-box law went vacuous there (a
  // stale `valueBoxes` selector, a visibility change, a fixture that stopped
  // rendering the box).
  for (const [surface, kinds] of Object.entries(RADIUS_VALUE_BOX_REQUIRED)) {
    const missing = kinds.filter((k) => !valueBoxRadii[surface]?.kinds[k]);
    if (missing.length) {
      throw new Error(`SETUP ERROR: radiusScale (family 9) measured no visible ${missing.join(" / ")} value box on ${surface} (measured kinds ${JSON.stringify(valueBoxRadii[surface]?.kinds || {})}) -- the four-corners-equal-md law is vacuous there`);
    }
  }
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
    else if (h.kind === "radiusValueBox") console.log(`  radiusValueBox     [${h.surface}/${h.context}]  ${h.path}  radius=${h.radius}  md=${h.md}px`);
    else if (h.kind === "textFloor") console.log(`  textFloor          [${h.surface}/${h.context}]  ${h.path}  font-size=${h.fontSize}px`);
    else if (h.kind === "spacingScale") console.log(`  spacingScale       [${h.surface}/${h.context}]  ${h.path}  ${h.prop}=${h.value}px  scale=${h.scale.join("|")}`);
    else if (h.kind === "popupWidthCap") console.log(`  popupWidthCap      [${h.surface}/${h.context}]  body  width=${h.width}px  zoom=${h.zoom}  setting=${h.setting}px`);
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
  // SETUP = a harness precondition that did not hold for one row (follow-up
  // 6 / rounds 2-3: holdPointerState could not make the pointer's hover or
  // rest state, with focus elsewhere, hold through the read), so that row
  // was not measured. Listed apart from product FAILs,
  // never written to or matched against the known-failures ledger, and the
  // run exits 2 -- the same code as every other SETUP ERROR -- because an
  // unmeasured row must not pass silently.
  const setupRows = results.filter((r) => r.status === "SETUP");
  const printSetup = () => {
    if (!setupRows.length) return;
    console.log(`[render-audit] === SETUP -- ${setupRows.length} row(s) not measured (harness precondition failed; not a product verdict) ===`);
    for (const r of setupRows) console.log(`  SETUP [${r.setup || "?"}]  ${keyOf(r)}  actual=${r.actual}  expected=${r.expected}${r.note ? "  (" + r.note + ")" : ""}`);
  };
  // `harness` = per-run pointer/focus diagnostics of a measured hover row;
  // printed on FAIL/WARN lines and kept in --json, never in the ledger.
  const harnessOf = (r) => (r.harness ? `  [${r.harness}]` : "");

  if (UPDATE && setupRows.length) {
    printSetup();
    console.log("[render-audit] refusing to rewrite the known-failures ledger from a run with unmeasured rows");
    process.exit(2);
  }
  if (UPDATE) {
    const knownFailures = {};
    for (const r of fails) {
      // An explicit field list: `harness` (attempt counts, focus flags) is
      // per-run noise and stays out, so rewriting the same failures twice
      // gives the same file.
      knownFailures[keyOf(r)] = {
        surface: r.surface, theme: r.theme, selector: r.selector, state: r.state, check: r.check,
        actual: r.actual, expected: r.expected, note: r.note,
      };
    }
    writeFileSync(KNOWN_FAILURES_PATH, JSON.stringify(knownFailures, null, 2) + "\n");
    console.log(`[render-audit] ${okCount} OK, ${skipCount} SKIP, ${fails.length} FAIL`);
    if (skipCount) console.log(`[render-audit] SKIP = disabled controls exempted from contrast checks (WCAG 1.4.3), not a failure`);
    console.log(`[render-audit] wrote ${fails.length} known-failure(s) to ${KNOWN_FAILURES_PATH}`);
    for (const r of fails) console.log(`  FAIL  ${keyOf(r)}  actual=${r.actual}  expected=${r.expected}${r.note ? "  (" + r.note + ")" : ""}${harnessOf(r)}`);
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
  //
  // A key whose row came back SETUP this run was never measured, so its
  // absence from seenKeys says nothing (round 2, gates/F3): every known key
  // under a SETUP row's surface|theme|selector|state| prefix is held out of
  // STALE -- a checklist SETUP row renames its check (hoverApplied /
  // hoverUnfocused), so the prefix, not the full key, is what matches the
  // ledger's bgEqVar / borderSidesEqVar / ... entries for that row.
  const setupPrefixes = [...new Set(setupRows.map((r) => `${r.surface}|${r.theme}|${r.selector}|${r.state}|`))];
  const unmeasuredKnown = Object.keys(known).filter((k) => !seenKeys.has(k) && setupPrefixes.some((p) => k.startsWith(p)));
  const stale = SHARD ? [] : Object.keys(known).filter((k) => !seenKeys.has(k) && !unmeasuredKnown.includes(k));

  console.log(`[render-audit] ${okCount} OK, ${skipCount} SKIP, ${warnings.length} WARN (known), ${violations.length} FAIL (new), ${setupRows.length} SETUP (harness)${SHARD_TAG}`);
  if (skipCount) console.log(`[render-audit] SKIP = disabled controls exempted from contrast checks (WCAG 1.4.3), not a failure`);
  if (SHARD && Object.keys(known).length) {
    console.log(`[render-audit] stale known-failure reconciliation skipped${SHARD_TAG} -- rerun without --shard to find ledger entries that no longer reproduce`);
  }
  if (warnings.length) {
    console.log(`[render-audit] known failures still outstanding (see ${KNOWN_FAILURES_PATH}):`);
    for (const r of warnings) console.log(`  WARN  ${keyOf(r)}  actual=${r.actual}  expected=${r.expected}${harnessOf(r)}`);
  }
  if (!SHARD && unmeasuredKnown.length) {
    console.log(`[render-audit] ${unmeasuredKnown.length} known-failure key(s) not reconciled -- their rows came back SETUP (unmeasured), see === SETUP:`);
    for (const k of unmeasuredKnown) console.log(`  UNMEASURED  ${k}`);
  }
  if (stale.length) {
    console.log(`[render-audit] ${stale.length} known-failure key(s) no longer reproduce -- consider deleting from ${KNOWN_FAILURES_PATH}:`);
    for (const k of stale) console.log(`  STALE  ${k}`);
  }
  printSetup();
  if (violations.length) {
    console.log(`[render-audit] === FAIL -- ${violations.length} new violation(s) not covered by known-failures ===`);
    for (const r of violations) console.log(`  FAIL  ${keyOf(r)}  actual=${r.actual}  expected=${r.expected}${r.note ? "  (" + r.note + ")" : ""}${harnessOf(r)}`);
    process.exit(1);
  }
  if (setupRows.length) process.exit(2);
  console.log("[render-audit] === PASS ===");
  process.exit(0);
}

// The CI emulation must not depend on the developer's OWN fontconfig (round
// 2 extended this from the help audit to the geometry gate and the sweep --
// the run .claude/rules/ui-primitives.md asks for before a push): with
// FONTCONFIG_FILE set, Chromium and the fc-match parity probe run with
// XDG_CONFIG_HOME on an empty temp dir, removed on exit and on
// SIGINT/SIGTERM/SIGHUP, and the probe with its locale pinned.
// scripts/ci-fonts-env.mjs has the whole story; the help audit uses the same
// module.
const FONTCONFIG_ISOLATION = isolatedFontconfigEnv("render-audit");

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
    resolved = execFileSync("fc-match", ["Microsoft YaHei"], { encoding: "utf8", env: parityProbeEnv(FONTCONFIG_ISOLATION?.env ?? process.env) }).trim();
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
      `Reproduce: ${parityReproduceCommand(confPath)}`
    );
    process.exit(2);
  }
}

async function main() {
  checkFontconfigParity();
  if (SHARD) {
    const rowName = (r) => `${r.surface} ${r.state} (${r.theme || "default"})`;
    const movedIn = RELOCATED_ROWS.filter((r) => !SHARD_THEMES.includes(r.theme) && relocatedTarget(r) === SHARD.i);
    const movedOut = RELOCATED_ROWS.filter((r) => SHARD_THEMES.includes(r.theme) && relocatedTarget(r) !== SHARD.i);
    console.log(`[render-audit] shard ${SHARD.i}/${SHARD.n}: ${SHARD_THEMES.length}/${THEMES.length} theme(s) [${SHARD_THEMES.map((t) => t || "(default)").join(", ")}]${RUNS_SWEEP ? " + the single sweep pass (families 4-11 and the spacingScale ledger)" : ""}` +
      `${movedIn.length ? ` + relocated in: ${movedIn.map(rowName).join(", ")}` : ""}` +
      `${movedOut.length ? ` - relocated out: ${movedOut.map((r) => `${rowName(r)} -> shard ${relocatedTarget(r)}`).join(", ")}` : ""}`);
  }
  const userDataDir = mkdtempSync(join(tmpdir(), "pbp-render-audit-"));
  let ctx;
  try {
    // Unpacked source tree, not a ZIP (this audits the working tree, not a
    // release build) -- same recipe as scripts/zip-install-smoke.mjs:187-195.
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // MV3 extensions require headed (or 'new' headless on recent Chrome)
      // FONTCONFIG_FILE runs only: the per-user fontconfig isolation above.
      ...(FONTCONFIG_ISOLATION ? { env: FONTCONFIG_ISOLATION.env } : {}),
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

  // Library redesign fixture (plan T2), written BEFORE renderAuditFixture so
  // the fixture word stays the newest row of the latest-first list. Same
  // single writer as the fixture below: vocab-store.js's own public functions
  // inside the SW. pbpVocabSetNote is the store's note entrance --
  // pbpVocabSaveWord has no note field.
  const libSeedError = await sw.evaluate(async ({ owner, seed, fillers }) => {
    const save = async (w) => {
      const row = await pbpVocabSaveWord(owner, w);
      if (!row || !row.id) throw new Error(`pbpVocabSaveWord returned no id for ${w.term}`);
      return row;
    };
    try {
      const rich = await save({
        term: seed.richTerm, language: "en", ipa: "/kənˈstreɪnt/",
        gloss: "A limitation or restriction; something that limits what can be done.",
        context: { quote: "Every layout starts from a constraint, not from a blank page.", articleTitle: seed.multiTitle, articleUrl: seed.multiUrl },
      });
      // pbpVocabSaveWord merges ONE context per call: the second call adds the second.
      await save({
        term: seed.richTerm, language: "en",
        context: { quote: "The constraint is the medium: a page only has so much attention to spend.", articleTitle: seed.cjkTitle, articleUrl: seed.soloUrl },
      });
      if (!(await pbpVocabSetNote(rich.id, owner, "Not the same as restraint: a constraint is imposed, restraint is chosen."))) {
        throw new Error(`pbpVocabSetNote failed for ${seed.richTerm}`);
      }
      const ja = await save({
        term: seed.cjkTerms[0], language: "ja", gloss: "ambiguous; vague",
        context: { quote: "曖昧な言い方は、読み手の注意を奪う。", articleTitle: seed.cjkTitle, articleUrl: seed.soloUrl },
      });
      await save({ term: seed.cjkTerms[1], language: "zh", gloss: "to breathe; breathing room" });
      await save({ term: seed.diacriticTerm, language: "de", gloss: "exercise; practice" });
      const fill = [];
      for (const term of fillers) fill.push((await save({ term, language: "en", gloss: `Seeded filler definition for ${term}.` })).id);
      if (!(await pbpVocabBatchAddGroup([rich.id, ja.id, ...fill.slice(0, 17)], owner, "Reading"))) throw new Error("grouping Reading failed");
      if (!(await pbpVocabBatchAddGroup([rich.id, ...fill.slice(0, 5)], owner, "Review"))) throw new Error("grouping Review failed");
      // A strictly later clock for the fixture write that follows.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "";
    } catch (error) {
      return error && error.message ? error.message : String(error);
    }
  }, { owner: SEED_OWNER, seed: LIB_SEED, fillers: LIB_SEED_FILLER_TERMS });
  if (libSeedError) {
    console.error(`[render-audit] library seed failed: ${libSeedError}`);
    await ctx.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
    process.exit(2);
  }

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
  await sw.evaluate(({ seed, fillerPages }) => {
    const now = Date.now();
    const minute = 60000;
    const records = {
      "pbp_hl_render-audit-fixture": {
        url: "https://example.com/render-audit-fixture",
        title: "Render Audit Fixture Page",
        items: [{
          id: "h1",
          ts: now,
          quote: "This is the highlighted passage used by the render audit fixture.",
          note: "A short fixture note for the render audit.",
          color: 1,
        }],
      },
      // Library redesign (plan T2): one page with several highlights (one
      // with a note), one page with exactly one under a CJK title, and
      // one-highlight filler pages. Every stamp is older than the fixture's,
      // so the fixture stays the first row of the latest-first notes list.
      "pbp_hl_render-audit-multi": {
        url: seed.multiUrl,
        title: seed.multiTitle,
        items: [
          { id: "m1", ts: now - 40 * minute, quote: "Attention is the one resource every element on the page competes for.", note: "", color: 1 },
          { id: "m2", ts: now - 35 * minute, quote: "A border costs the reader a glance whether or not it carries meaning.", note: "The real price of a decorative frame.", color: 2 },
          { id: "m3", ts: now - 30 * minute, quote: "Quiet is not the absence of design; it is design that stopped asking for attention.", note: "", color: 3 },
          { id: "m4", ts: now - 25 * minute, quote: "The best index is the one you stop noticing while you read.", note: "", color: 5 },
        ],
      },
      "pbp_hl_render-audit-solo": {
        url: seed.soloUrl,
        title: seed.cjkTitle,
        items: [{ id: "s1", ts: now - 20 * minute, quote: "安静的界面不靠色块分区，靠留白、字号和对齐。", note: "", color: 4 }],
      },
      // G4's Latin-title case whose capital carries a diacritic (final
      // review #10): the title is pulled up, and É's accent is the ink that
      // rises above the em box.
      "pbp_hl_render-audit-diacritic": {
        url: seed.diacriticUrl,
        title: seed.diacriticTitle,
        items: [{ id: "d1", ts: now - 22 * minute, quote: "Attention drifts toward whatever moved last.", note: "", color: 2 }],
      },
    };
    for (let i = 1; i <= fillerPages; i++) {
      records[`pbp_hl_render-audit-filler-${i}`] = {
        url: `https://example.com/reading/filler-${i}`,
        title: `Reading list entry ${i}`,
        items: [{ id: `f${i}`, ts: now - (60 + i * 10) * minute, quote: `Filler highlight ${i}, seeded so the notes list is long enough to scroll.`, note: "", color: ((i - 1) % 5) + 1 }],
      };
    }
    return chrome.storage.local.set(records);
  }, { seed: LIB_SEED, fillerPages: LIB_SEED_NOTE_FILLER_PAGES });

  // Seed shape (plan T2). The library gates read these facts, and every
  // pre-existing entry reads the FIRST row of a list, so the fixture word and
  // the fixture highlight must stay the newest. Asserted on the stored data,
  // from the SW, before any page opens -- a broken seed is exit 2, never a
  // row of PASSes against the wrong element.
  const seedShape = await sw.evaluate(async ({ owner, seed }) => {
    const rows = await pbpVocabAll(owner);
    const fixture = rows.find((r) => r.term === "renderAuditFixture");
    const others = rows.filter((r) => r !== fixture);
    const rich = rows.find((r) => r.term === seed.richTerm);
    const store = await chrome.storage.local.get(null);
    const pages = Object.entries(store).filter(([key, rec]) => key.startsWith("pbp_hl_") && rec && Array.isArray(rec.items));
    const items = pages.flatMap(([, rec]) => rec.items);
    const hlFixture = store["pbp_hl_render-audit-fixture"];
    const newest = hlFixture && hlFixture.items[0];
    const multi = (pages.find(([, rec]) => rec.url === seed.multiUrl) || [])[1];
    const solo = (pages.find(([, rec]) => rec.url === seed.soloUrl) || [])[1];
    return {
      words: rows.length,
      ungrouped: rows.filter((r) => !pbpVocabGroups(r).length).length,
      fixtureWordNewest: !!fixture && others.every((r) => (Number(r.updatedAt) || 0) < (Number(fixture.updatedAt) || 0)),
      richShape: !!rich && rich.language === "en" && !!rich.ipa && rich.contexts.length === 2 && !!String(rich.note || "").trim(),
      cjkTerms: seed.cjkTerms.every((term, i) => rows.some((r) => r.term === term && r.language === seed.cjkLangs[i])),
      diacriticTerm: rows.some((r) => r.term === seed.diacriticTerm && r.language === "de"),
      diacriticPage: pages.some(([, rec]) => rec.url === seed.diacriticUrl && rec.title === seed.diacriticTitle && rec.items.length === 1),
      highlights: items.length,
      fixtureHighlightNewest: !!newest && items.every((it) => it === newest || it.ts < newest.ts),
      multiShape: !!multi && multi.title === seed.multiTitle && multi.items.length >= 3 && multi.items.some((it) => String(it.note || "").trim()),
      soloShape: !!solo && solo.items.length === 1 && solo.title === seed.cjkTitle,
    };
  }, { owner: SEED_OWNER, seed: LIB_SEED });
  const seedProblems = [
    seedShape.words === LIB_SEED.wordCount + 1 ? null : `words ${seedShape.words} (want ${LIB_SEED.wordCount + 1})`,
    seedShape.ungrouped >= 10 ? null : `ungrouped words ${seedShape.ungrouped} (want >= 10)`,
    seedShape.fixtureWordNewest ? null : "renderAuditFixture is not the newest word",
    seedShape.richShape ? null : `${LIB_SEED.richTerm} lacks two contexts / a note / an ipa`,
    seedShape.cjkTerms ? null : `missing a CJK term or its language (${LIB_SEED.cjkTerms.map((term, i) => `${term}:${LIB_SEED.cjkLangs[i]}`).join(", ")})`,
    seedShape.diacriticTerm ? null : `missing ${LIB_SEED.diacriticTerm} (de)`,
    seedShape.diacriticPage ? null : `${LIB_SEED.diacriticUrl} is not exactly one highlight titled ${LIB_SEED.diacriticTitle}`,
    seedShape.highlights >= 14 ? null : `highlights ${seedShape.highlights} (want >= 14)`,
    seedShape.fixtureHighlightNewest ? null : "the fixture highlight is not the newest",
    seedShape.multiShape ? null : `${LIB_SEED.multiUrl} is not titled ${LIB_SEED.multiTitle} or lacks >= 3 highlights with one note`,
    seedShape.soloShape ? null : `${LIB_SEED.soloUrl} is not exactly one highlight titled ${LIB_SEED.cjkTitle}`,
  ].filter(Boolean);
  if (seedProblems.length) {
    console.error(`[render-audit] library seed shape wrong: ${seedProblems.join("; ")}`);
    await ctx.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
    process.exit(2);
  }

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
        // `themes` (render-audit-checklist.mjs header) pins a layout entry to
        // the theme states whose geometry differs; everything else runs on all.
        // A relocated row runs only in its target shard (RELOCATED_ROWS above).
        const themeChecks = checks.filter((c) => {
          if (c.themes && !c.themes.includes(theme)) return false;
          const moved = SHARD && relocatedRow(c, theme);
          return !moved || relocatedTarget(moved) === SHARD.i;
        });
        if (surface === "library") await runLibraryTheme(page, extBase, theme, themeChecks, results);
        else await runSimpleTheme(page, `${extBase}${SURFACE_PAGES[surface]}`, theme, themeChecks, results, surface, sw);
        if (MEDIA_THEME_SET.has(theme)) {
          mediaProbeCount += await runMediaPreferenceChecks(page, mediaSession, surface, theme, results);
        }
      }
      // The relocated rows of OTHER shards' themes. They drive scratch pages
      // of their own (no shared-page state), so only the theme's storage is
      // set first; the shard's own theme loop has already finished with it.
      if (SHARD) {
        for (const theme of THEMES.filter((t) => !SHARD_THEMES.includes(t))) {
          const moved = checks.filter((c) => {
            const row = relocatedRow(c, theme);
            return row && relocatedTarget(row) === SHARD.i && (!c.themes || c.themes.includes(theme));
          });
          if (!moved.length) continue;
          const { themePresetKey, optTheme } = themeToStorage(theme);
          await setTheme(sw, themePresetKey, optTheme);
          for (const check of moved) await runOneCheck(page, theme, check, results, extBase);
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
      controlRung: (h) => ({ actual: h.height, expected: h.expected, note: "control height (COMPONENTS.md §1.1/§6.3; density rung on options and library); icon-only buttons are family 4" }),
      headerFace: (h) => ({ actual: h.face, expected: h.majority, note: "section heading face differs from the surface majority" }),
      actionRowGap: (h) => ({ actual: h.gap, expected: h.allowed.join("|"), note: "column-gap of a button row (px)" }),
      radiusScale: (h) => ({ actual: h.radius, expected: h.tokens.map((t) => t + "px").join("|"), note: "border-radius off the surface's token scale" }),
      radiusValueBox: (h) => ({ actual: h.radius, expected: `${h.md}px on all four corners`, note: "a value box's four corners must all equal the surface's --*-radius-md (spec 2026-09-30-ui-fields-stage4-design §2.1; named exceptions: the theme-name popover input, .tags-input-wrap.ac-open)" }),
      textFloor: (h) => ({ actual: h.fontSize, expected: ">=11", note: "visible text below the 11px floor" }),
      clusterGap: (h) => ({ actual: h.gap, expected: String(h.expected), note: "column-gap of an icon-button cluster (px): one rung on every surface" }),
      popupWidthCap: (h) => ({ actual: h.width, expected: "<=800", note: `zoomed popup body (setting ${h.setting}px x zoom ${h.zoom}) over Chrome's 800px popup cap: the clamped window reserves a 10px scrollbar strip` }),
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
  // fieldHoverContrast (family 14): same "scanned nothing vs 0 FAIL" line.
  {
    const total = fieldHoverScanLog.reduce((sum, entry) => sum + entry.scanned, 0);
    const unmeasured = fieldHoverScanLog.reduce((sum, entry) => sum + entry.unmeasured, 0);
    const themes = new Set(fieldHoverScanLog.filter((entry) => entry.scanned > 0).map((entry) => entry.theme)).size;
    console.log(`[render-audit] fieldHoverContrast: ${total} field hover probe(s) measured across ${themes} options theme(s) this run, ${unmeasured} unmeasured (SETUP)${SHARD_TAG}`);
  }
  // fieldHoverContrast (family 14), the popup / library value-box legs:
  // "measured nothing" vs "0 FAIL", per surface -- and a HARD check (spec
  // 2026-09-30-ui-fields-stage4-design §5.2: a leg that measures zero boxes
  // is a SETUP ERROR, never a pass): when a surface's checks ran this
  // process, every theme it ran must have measured every box its
  // VALUE_BOX_LEGS entry names. Anything short -- the per-theme call removed
  // or bypassed, a leg that returned early, boxes left unmeasured -- becomes
  // a SETUP row, so report() exits 2.
  for (const surface of Object.keys(VALUE_BOX_LEGS)) {
    const logs = valueBoxHoverLog.filter((entry) => entry.surface === surface);
    const measured = logs.reduce((sum, entry) => sum + entry.measured.length, 0);
    const unmeasured = logs.reduce((sum, entry) => sum + entry.unmeasured.length, 0);
    console.log(`[render-audit] fieldHoverContrast ${surface}: ${measured} value box(es) measured across ${logs.length} theme(s) this run, ${unmeasured} unmeasured (SETUP)${SHARD_TAG}`);
    if (!CHECKS.some((c) => c.surface === surface)) continue;
    const focusRequired = VALUE_BOX_FOCUS_REQUIRED[surface] || [];
    const focusDeclared = new Set(VALUE_BOX_LEGS[surface].legs.flatMap((leg) => leg.focus || []));
    const focusUnpinned = focusRequired.filter((sel) => !focusDeclared.has(sel));
    if (focusUnpinned.length) {
      results.push({
        surface, theme: "", selector: "(run)", state: "fieldFocusPaint", check: "valueBoxFocusPin",
        status: "SETUP", setup: "legVacuous",
        actual: `no VALUE_BOX_LEGS.${surface} leg names ${focusUnpinned.join(" / ")} in its \`focus\` list`,
        expected: `every VALUE_BOX_FOCUS_REQUIRED.${surface} box read focused by a leg`,
        note: "the focused read was removed from the leg -- restore its `focus` key",
      });
    }
    const focusBoxes = new Set([...focusRequired, ...focusDeclared]).size;
    const focusMeasured = logs.reduce((sum, entry) => sum + entry.focusMeasured.length, 0);
    if (focusBoxes) console.log(`[render-audit] fieldFocusPaint ${surface}: ${focusMeasured} focused value box(es) measured across ${logs.length} theme(s) this run${SHARD_TAG}`);
    if (focusMeasured < SHARD_THEMES.length * focusBoxes) {
      results.push({
        surface, theme: "", selector: "(run)", state: "fieldFocusPaint", check: "valueBoxFocusCoverage",
        status: "SETUP", setup: "legVacuous",
        actual: `${focusMeasured} focused value box(es) measured across ${logs.length} theme(s)`,
        expected: `${SHARD_THEMES.length * focusBoxes} = ${SHARD_THEMES.length} theme(s) run x ${focusBoxes} focus box(es) (VALUE_BOX_FOCUS_REQUIRED.${surface} + the legs' \`focus\` keys)`,
        note: `the family-14 ${surface} leg read fewer focused boxes than the run requires (see their own SETUP rows)`,
      });
    }
    const required = SHARD_THEMES.length * VALUE_BOX_LEGS[surface].boxes.length;
    if (measured < required) {
      results.push({
        surface, theme: "", selector: "(run)", state: "fieldHoverContrast", check: "valueBoxLegCoverage",
        status: "SETUP", setup: "legVacuous",
        actual: `${measured} value box(es) measured across ${logs.length} theme(s) (${unmeasured} reached but unmeasured)`,
        expected: `${required} = ${SHARD_THEMES.length} theme(s) run x ${VALUE_BOX_LEGS[surface].boxes.length} VALUE_BOX_LEGS.${surface} boxes (spec 2026-09-30-ui-fields-stage4-design §5.2)`,
        note: `the family-14 ${surface} value-box leg measured fewer boxes than the run requires -- recordValueBoxHover was not called for every theme, or boxes were left unmeasured (see their own SETUP rows)`,
      });
    }
  }
  // Pointer holds (round 3, H): how often a rest / hover read needed more
  // than one attempt, and why -- the recoveries the old single retry could
  // lose, so a desktop (or CI display) that starts disturbing the headed
  // window more shows up here before it turns into SETUP rows.
  console.log(`[render-audit] pointer holds: ${pointerHoldLog.holds} rest/hover read(s), ${pointerHoldLog.retried} held after a retry (${pointerHoldLog.displaced} of them after a pointer event the harness did not dispatch), ${pointerHoldLog.failed} never held (SETUP)${SHARD_TAG}`);
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
