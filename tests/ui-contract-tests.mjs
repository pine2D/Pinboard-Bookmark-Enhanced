import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { parseStyleRules, parseDeclarations, declarationValueMap, splitSelectorList, closeOfBracket, cmpSpecificity, selectorSpecificity } from "../docs/theme-surface/tools/css-syntax.mjs";
import { readOptionsDensity } from "../docs/theme-surface/tools/options-density.mjs";
import { contrast, hexToRgb, FILL_SEPARATE_MIN, FIELD_ROLES, UI_DERIVED_OUTPUT_ROLES } from "../docs/theme-surface/composers/_ui-derive.mjs";
import { FIELD_TARGETS } from "../docs/theme-surface/composers/ui-components.mjs";
import * as uiDerive from "../docs/theme-surface/composers/_ui-derive.mjs";
import { composeOptionsThemeMap } from "../docs/theme-surface/composers/options-chrome.mjs";
import { composePopupThemeMap, POPUP_THEME_MAP } from "../docs/theme-surface/composers/popup-chrome.mjs";
import { composeLibraryThemeMap } from "../docs/theme-surface/composers/library-chrome.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); };
const extensionIdFromKey = (key) => {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((char) => String.fromCharCode(97 + Number.parseInt(char, 16))).join("");
};

// Cuts every "@generated:<name> start ... @generated:<name> end" region out
// of a *-chrome theme CSS file -- ui-themes AND ui-components, both of which
// popup/options/library each carry -- not just the first "ui-themes start"
// marker. The prior library-only bare-hex scan split on that single marker,
// which happened to also exclude the ui-components block (it sits before
// ui-themes) but never excluded anything *after* ui-themes -- and
// popup.css/options.css both carry ~300 hand-written lines after
// "@generated:ui-themes end" that a single split silently never scans.
// Composer output is exempt by construction (render-audit and the
// theme-factory lints already gate it), so only the surrounding hand-written
// CSS this returns should ever reach a hardcoded-color count.
function stripGeneratedRegions(css) {
  const lines = css.split("\n");
  const kept = [];
  let skipping = null;
  for (const line of lines) {
    const marker = line.match(/@generated:([\w-]+)\s+(start|end)/);
    if (marker) {
      if (marker[2] === "start") { skipping = marker[1]; continue; }
      if (marker[2] === "end" && skipping === marker[1]) { skipping = null; continue; }
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

// Removes every var(...) call, including a fallback that itself contains a
// parenthesized function (rgba(), color-mix()...). A naive
// `/var\([^()]*\)/g` innermost-out replace loop cannot see past those nested
// parens -- e.g. `var(--opt-danger-bg, rgba(220,80,80,0.08))` never matches
// `[^()]*` because the fallback's own "(" breaks the class -- so it silently
// left an already-tokenized declaration's rgba() fallback in the scan.
function stripVarCalls(text) {
  let out = "", i = 0;
  while (i < text.length) {
    if (text.startsWith("var(", i)) {
      let depth = 1, j = i + 4;
      while (j < text.length && depth > 0) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
        j++;
      }
      i = j; // skip the whole var(...) span, nested parens and all
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

// Neither scan below is a real CSS parser -- both are regex/brace-walk text
// scans, same tradeoff Task 8 made for its own text-scanning checks. A hex
// or rgba() sitting inside a quoted string (`content: "#fff"`) or a url()
// would still be counted; nothing in the current hand-maintained regions
// does that (verified by grep), so it's a known, currently-inert blind
// spot rather than a live false positive.
//
// Both functions drop comments *before* stripVarCalls on purpose: a
// half-written comment containing "var(" with no matching ")" would
// otherwise send stripVarCalls's paren-depth walk to the end of the file,
// silently eating real code after it.

// Counts bare hex color literals in the hand-maintained region of a *-chrome
// theme CSS file (popup.css / options.css / library.css). A bare hex outside
// a var() fallback means a rule hardcoded a color instead of consuming a
// token, so it silently ignores every theme (the exact options.css migration
// regression this is meant to catch). Shared by the popup/options ratchet
// gate and library's zero-tolerance gate below.
function countBareHex(css) {
  let hand = stripGeneratedRegions(css);
  hand = hand.replace(/^\s*--[\w-]+\s*:[^;]*;/gm, "");   // drop custom-prop definitions (:root literals are the exempt source of truth)
  hand = hand.replace(/\/\*[\s\S]*?\*\//g, "");           // drop comments
  hand = stripVarCalls(hand);                             // drop var() incl. nested fallbacks
  // color-mix() may deliberately blend a token against a literal #000/#fff
  // (popup's darken-on-hover pattern) instead of a missing token -- strip
  // only that operand, not the whole color-mix(), before counting.
  hand = hand.replace(/color-mix\([^)]*\)/g, (m) => m.replace(/#(?:000|fff)\b/gi, ""));
  return (hand.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length;
}

// Counts bare rgba()/rgb() color literals used as the value of a
// background/background-color/color/border-*-color declaration in the
// hand-maintained region. A raw rgba() there is the same debt as a bare hex
// -- a hardcoded color instead of a --pp-*/--opt-*/--lib-* token -- but a
// hex-only regex can never see it (library.css:497's
// `background: rgba(220, 80, 80, 0.08); /* no --lib-danger-bg token */` is
// exactly this blind spot). box-shadow/text-shadow/outline etc. are excluded
// on purpose: shadow rgba() is an existing, intentional convention in this
// codebase (CLAUDE.md), not a missed token.
function countQualifyingRgba(css) {
  let hand = stripGeneratedRegions(css).replace(/\/\*[\s\S]*?\*\//g, "");
  hand = stripVarCalls(hand); // a var()-wrapped rgba() fallback is already token-routed, same treatment as hex
  // The four border-*-color longhands belong here alongside the shorthand
  // border-color -- omitting them was a controller checklist typo, not an
  // intentional scope cut (popup.css:1106's
  // `border-bottom-color: rgba(255,255,255,0.06)` is the case that exposed it).
  // The border/border-top/-right/-bottom/-left SHORTHANDS (width+style+color
  // in one declaration) belong here too, same reasoning: a value scan for
  // `rgba(`/`rgb(` doesn't care whether the property is a longhand or a
  // shorthand, and popup.css:958/:986's `border-bottom: 1px solid
  // rgba(0,0,0,0.05)` / `border: 1px solid rgba(0,0,0,0.12)` were a live
  // blind spot the ratchet never saw (design-uplift Task 13 review round).
  const targets = new Set([
    "background", "background-color", "color", "border-color",
    "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
    "border", "border-top", "border-right", "border-bottom", "border-left",
  ]);
  let depth = 0, chunk = "", count = 0;
  // Brace walk (same shape as the --opt-* token-coverage scan above): only
  // text between "{"/";" boundaries *while inside a rule body* (depth > 0)
  // is a candidate declaration -- this is what keeps a selector like
  // `.tab-btn:hover:not(.active) {` from ever being misread as a property.
  const consider = (text) => {
    if (depth === 0) return;
    const colon = text.indexOf(":");
    if (colon === -1) return;
    const prop = text.slice(0, colon).trim().toLowerCase();
    if (!targets.has(prop)) return;
    const hits = text.slice(colon + 1).match(/\brgba?\(/g);
    if (hits) count += hits.length;
  };
  for (const ch of hand) {
    if (ch === "{") { depth++; chunk = ""; }
    else if (ch === "}") { consider(chunk); depth = Math.max(0, depth - 1); chunk = ""; }
    else if (ch === ";") { consider(chunk); chunk = ""; }
    else chunk += ch;
  }
  return count;
}

const popupHtml = read("popup.html");
const manifest = JSON.parse(read("manifest.json"));
const backgroundJs = read("background.js");
const optionsHtml = read("options.html");
const releaseSh = read("scripts/release.sh");
const zipInstallSmoke = read("scripts/zip-install-smoke.mjs");
const privacyMd = read("docs/privacy.md");
check(!optionsHtml.includes('Requires "Access all websites" permission'), "options Batch hint still advertises the retired all-sites request");
check(optionsHtml.includes('data-i18n="secBackupRestore">Backup &amp; Restore</h2>'),
  "options.html: backup section fallback still advertises sync");
const mdHtml = read("md-preview.html");
const mdPreviewJs = read("md-preview.js");
const mdExportSendJs = read("md-export-send.js");
const sharedJs = read("shared.js");
const jinaJs = read("jina.js");
const mdAiCoreJs = read("md-ai-core.js");
const mdAskJs = read("md-ask.js");
const mdHighlightJs = read("md-highlight.js");
const mdSkimJs = read("md-skim.js");
const mdTranslateJs = read("md-translate.js");
const mdReaderJsSource = read("md-reader.js");
const mdCss = read("md-preview.css");
const popupJs = read("popup.js");
const popupAiJs = read("popup-ai.js");
const popupBatchJs = read("popup-batch.js");
const popupCss = read("popup.css");
const optionsConnectivityJs = read("options-connectivity.js");
const aiJs = read("ai.js");
const optionsCss = read("options.css");
const optionsJs = read("options.js");
const optionsBackupJs = read("options-backup.js");
const optionsVocabJs = read("options-vocab.js");
const libraryVocabJs = read("library-vocab.js");
const libraryHtml = read("library.html");
const libraryCss = read("library.css");
const vocabGdriveJs = read("vocab-gdrive.js");
const mdDictJs = read("md-dict.js");
const vocabStore = read("vocab-store.js");
const mdDict = read("md-dict.js");
const optionsThemeEarlyJs = read("options-theme-early.js");
const popupThemeEarlyJs = read("popup-theme-early.js");
const mdPreviewThemeEarlyJs = read("md-preview-theme-early.js");
const popupTagsJs = read("popup-tags.js");

// Stage-0 density tokens (spec 2026-09-23-ui-system-stage0-design §2): the
// comfortable tier lives on :root, compact overrides a fixed subset under
// html[data-density="compact"]. Consumed by every options panel (the row
// model, stage 3c) — this guards the tokens/hook it reads by exact name.
check(/--opt-sp-8:\s*32px;/.test(optionsCss) &&
  /--opt-control-h:\s*32px;/.test(optionsCss) &&
  /--opt-row-min-h:\s*44px;/.test(optionsCss) &&
  /--opt-label-gap:\s*var\(--opt-sp-4\);/.test(optionsCss),
  "options.css does not define the stage-0 density tokens on :root");
check(/html\[data-density="compact"\]\s*\{[^}]*--opt-control-h:\s*28px;[^}]*--opt-label-gap:\s*var\(--opt-sp-2\);[^}]*\}/s.test(optionsCss),
  "options.css compact density overrides are not scoped under html[data-density=\"compact\"]");
// Stage-0 button rung + sub-panel rhythm (spec 2026-09-24-ui-system-stage2-design
// §2, task 1): the panel padding token has both density tiers, and the composer
// emits the density-height button rung consumed by every options panel.
check(/--opt-panel-pad:\s*var\(--opt-sp-6\)/.test(optionsCss) &&
  /html\[data-density="compact"\]\s*\{[^}]*--opt-panel-pad:\s*var\(--opt-sp-5\)/s.test(optionsCss),
  "options.css defines --opt-panel-pad in both tiers");
check(/(?:^|\n)\.btn:not\(\.context-help-toggle\)\s*\{[^}]*height:\s*var\(--opt-control-h\)/.test(optionsCss),
  "generated ui-components emits the options density button rung");
// Library density tier + geometry tokens (spec 2026-10-03-library-redesign-
// design §2.3 / §6.2, plan T1). Same two-tier shape as the options block
// above: comfortable on the hand-written :root, compact under
// html[data-density="compact"] (options-theme-early.js writes that attribute
// on library.html too). Read through css-syntax's declaration maps, so a
// comment or a same-named declaration on another selector cannot satisfy it.
const libHandCss = stripGeneratedRegions(libraryCss);
const libHandRoot = declarationValueMap(libHandCss, ":root");
{
  const libCompact = declarationValueMap(libHandCss, 'html[data-density="compact"]');
  const LIB_DENSITY = [
    ["--lib-control-h", "32px", "28px"],
    ["--lib-control-pad-x", "12px", "10px"],
    ["--lib-control-pad-x-sm", "10px", "8px"],
    ["--lib-text-body", "14px", "13px"],
    ["--lib-lh-body", "20px", "18px"],
    ["--lib-text-secondary", "13px", "12px"],
    ["--lib-lh-secondary", "18px", "16px"],
    ["--lib-text-meta", "12px", null],
    ["--lib-lh-meta", "16px", null],
    ["--lib-text-row-title", "15px", "14px"],
    ["--lib-lh-row-title", "20px", "18px"],
    ["--lib-row-pad-y", "var(--lib-sp-2)", "var(--lib-sp-1)"],
    ["--lib-row-pad-x", "var(--lib-sp-3)", "var(--lib-sp-2)"],
  ];
  for (const [name, comfortable, compact] of LIB_DENSITY) {
    check(libHandRoot.get(name) === comfortable,
      `library.css :root must define ${name}: ${comfortable} (comfortable tier, spec §6.2); got ${libHandRoot.get(name) ?? "nothing"}`);
    check(compact === null ? !libCompact.has(name) : libCompact.get(name) === compact,
      compact === null
        ? `library.css html[data-density="compact"] must not override ${name} (one value in both tiers, spec §6.2)`
        : `library.css html[data-density="compact"] must set ${name}: ${compact}; got ${libCompact.get(name) ?? "nothing"}`);
  }

  // Spacing scale 2..96 (ten rungs). The runner's spacingScale fallback is
  // used only when no live --lib-sp-N resolves, so a stale fallback is
  // invisible until the day it matters: pin it to the real :root values,
  // and pin `names` to probe every rung :root defines.
  const scale = [...libHandRoot]
    .map(([property, value]) => [/^--lib-sp-(\d+)$/.exec(property), /^(\d+)px$/.exec(value)])
    .filter(([name, px]) => name && px)
    .map(([name, px]) => [Number(name[1]), Number(px[1])])
    .sort((a, b) => a[0] - b[0]);
  check(JSON.stringify(scale.map(([, px]) => px)) === JSON.stringify([2, 4, 8, 12, 16, 24, 32, 48, 64, 96]) &&
    scale.every(([n], i) => n === i),
  `library.css :root must define --lib-sp-0..9 = 2/4/8/12/16/24/32/48/64/96 (spec §6.2); got ${JSON.stringify(scale)}`);
  const runnerSrc = read("scripts/ui-render-audit.mjs");
  const spAt = runnerSrc.indexOf("  spacingScale: {");
  const spBlock = spAt >= 0 ? runnerSrc.slice(spAt, runnerSrc.indexOf("componentInset:", spAt)) : "";
  const namesSrc = /\n\s*names:\s*(\[[^\]]*\])/.exec(spBlock);
  const tokensSrc = /\n\s*tokens:\s*\{[^}]*\}/.exec(spBlock);
  const libFallbackSrc = tokensSrc && /\blibrary:\s*(\[[^\]]*\])/.exec(tokensSrc[0]);
  const spNames = namesSrc ? JSON.parse(namesSrc[1]) : [];
  const libFallback = libFallbackSrc ? JSON.parse(libFallbackSrc[1]) : null;
  check(scale.length > 0 && scale.every(([n]) => spNames.includes(String(n))),
    `scripts/ui-render-audit.mjs spacingScale.names must probe every --lib-sp-N on :root (through sp-9); got ${JSON.stringify(spNames)}`);
  check(JSON.stringify(libFallback) === JSON.stringify(scale.map(([, px]) => px)),
    `scripts/ui-render-audit.mjs spacingScale.tokens.library fallback must equal library.css's --lib-sp-* values; got ${JSON.stringify(libFallback)}`);

  // Layout widths are theme invariants (spec §2.3 / §6.2): defined only on the
  // hand-written :root (P and G switch by viewport through @media-scoped
  // :root blocks), never in a generated block or on any other selector.
  const WIDTH_TOKENS = ["--lib-hang-w", "--lib-main-max", "--lib-ref-min", "--lib-ref-max", "--lib-excerpt-max", "--lib-side-min", "--lib-side-max"];
  const definers = (css, name) => parseStyleRules(css).filter((rule) => parseDeclarations(rule.body).some((d) => d.property === name));
  for (const name of ["--lib-page-pad", "--lib-index-w", "--lib-gap", ...WIDTH_TOKENS]) {
    const hand = definers(libHandCss, name);
    const all = definers(libraryCss, name);
    check(hand.length > 0 && hand.length === all.length && hand.every((rule) => rule.selectors.length === 1 && rule.selectors[0] === ":root"),
      `${name} must be defined only on library.css's hand-written :root (a theme invariant, spec §6.2); found ${all.length} definition(s), ${hand.length} hand-written`);
    if (WIDTH_TOKENS.includes(name) || name === "--lib-index-w") {
      check(hand.length === 1 && hand[0].context.length === 0, `${name} has one value at every width: exactly one top-level :root definition`);
    }
  }
  const WIDTHS = { "--lib-hang-w": "112px", "--lib-main-max": "840px", "--lib-ref-min": "360px", "--lib-ref-max": "720px",
    "--lib-excerpt-max": "800px", "--lib-side-min": "280px", "--lib-side-max": "420px", "--lib-index-w": "clamp(360px, 20vw, 520px)" };
  for (const [name, value] of Object.entries(WIDTHS)) {
    check(libHandRoot.get(name) === value, `library.css :root ${name} must be ${value} (spec §2.3 / §6.2); got ${libHandRoot.get(name) ?? "nothing"}`);
  }
  const at1280 = declarationValueMap(libHandCss, ":root", { context: ["@media (min-width: 1280px)"] });
  const at1920 = declarationValueMap(libHandCss, ":root", { context: ["@media (min-width: 1920px)"] });
  check(libHandRoot.get("--lib-page-pad") === "var(--lib-sp-5)" && at1280.get("--lib-page-pad") === "var(--lib-sp-6)" &&
    at1920.get("--lib-page-pad") === "var(--lib-sp-7)",
  "--lib-page-pad (P) must be 24 below 1280, 32 from 1280, 48 from 1920 (spec §2.3)");
  check(libHandRoot.get("--lib-gap") === "var(--lib-sp-7)" && !at1280.has("--lib-gap") && at1920.get("--lib-gap") === "var(--lib-sp-8)",
    "--lib-gap (G) must be 48 below 1920 and 64 from 1920 (spec §2.3)");
}
// The composer's lib branch of btnRules (ui-components.mjs, plan T1b): the
// button rung reads the density tokens, and carries box-sizing because
// library has no global `*` rule -- its two <a class="btn btn-sm"> links are
// content-box under the UA and would render 2px taller without it. The
// group unit's text entry is the sm rung minus the shell's 1px border.
{
  const genStart = libraryCss.indexOf("/* @generated:ui-components start (library) */");
  const genEnd = libraryCss.indexOf("/* @generated:ui-components end (library) */");
  check(genStart >= 0 && genEnd > genStart, "library.css: cannot find the @generated:ui-components (library) region");
  const libGen = libraryCss.slice(genStart, genEnd);
  const LIB_RUNG = {
    ".btn": { "box-sizing": "border-box", height: "var(--lib-control-h)", padding: "0 var(--lib-control-pad-x)",
      "font-size": "var(--lib-text-body)", "line-height": "calc(var(--lib-control-h) - 2px)" },
    ".btn-sm": { "box-sizing": "border-box", height: "calc(var(--lib-control-h) - 4px)", padding: "0 var(--lib-control-pad-x-sm)",
      "font-size": "calc(var(--lib-text-body) - 1px)", "line-height": "calc(var(--lib-control-h) - 6px)" },
    '.vocab-group-unit input[type="text"]': { height: "calc(var(--lib-control-h) - 6px)", padding: "0 var(--lib-control-pad-x-sm)",
      "font-size": "calc(var(--lib-text-body) - 1px)", "line-height": "calc(var(--lib-control-h) - 6px)" },
  };
  for (const [selector, want] of Object.entries(LIB_RUNG)) {
    const got = declarationValueMap(libGen, selector);
    for (const [property, value] of Object.entries(want)) {
      check(got.get(property) === value,
        `generated ui-components (library) must resolve ${selector} { ${property}: ${value} } (lib density rung, spec §6.2); got ${got.get(property) ?? "nothing"}`);
    }
    check(!declarationValueMap(libHandCss, selector).has("height"),
      `library.css hand layer must not set a height on bare ${selector}: the rung lives in the composer's lib branch (a same-specificity hand rule wins by source order)`);
  }
}
{
  // Registry-driven, not enumerated: options-theme-early.js's
  // PBP_OPTIONS_DENSITY_MAP must name exactly the DATA-THEME TARGETS that
  // trace back to a pilot with ui.density === "compact" (COMPONENTS.md
  // §11) -- no more, no less. Fixwave F5: a pilot slug and a density-map
  // key live in different spaces. The density map's keys are runtime
  // `data-theme` targets (`flexoki-light`/`flexoki-dark`), while a pilot
  // is named by its file slug (`flexoki`) -- an UMBRELLA slug (a key of
  // PBP_OPTIONS_ADAPTIVE_MAP) never appears as a `data-theme` value itself;
  // pbpApplyOptionsEarlyTheme resolves it to one of its two expanded
  // targets before ever touching the density map. Comparing the map's keys
  // directly against pilot slugs (the pre-fixwave version of this check)
  // was only coincidentally correct while every compact pilot happened to
  // be non-umbrella (terminal, gruvbox-dark): an umbrella pilot declaring
  // compact needs BOTH its light and dark targets in the map, and a check
  // expecting the bare slug instead would reject the only implementation
  // that actually works at runtime -- or, worse, pass a map that added the
  // inert bare slug instead of the two real targets.
  // readOptionsDensity throws (a SETUP failure, not a check() row) if the
  // adaptive map or any pilot's ui.density cannot be trusted -- fix round 1,
  // task-2-review: letting that propagate here beats degrading to an empty
  // table and silently passing the two checks below on nothing.
  const density = readOptionsDensity(root);
  const compactFromPilots = density.compactTargets;

  const mapSrc = optionsThemeEarlyJs.match(/PBP_OPTIONS_DENSITY_MAP\s*=\s*Object\.freeze\((\{[^}]*\})\)/);
  const densityMap = mapSrc ? runInNewContext("(" + mapSrc[1] + ")", {}) : {};
  const compactFromMap = Object.entries(densityMap).filter(([, v]) => v === "compact").map(([k]) => k).sort();
  check(compactFromPilots.length > 0 && JSON.stringify(compactFromPilots) === JSON.stringify(compactFromMap),
    "options-theme-early.js density map does not equal the pilots' ui.density=\"compact\" set, expanded through PBP_OPTIONS_ADAPTIVE_MAP (both directions)");

  // Second assertion (fixwave F5): every KEY of the density map must be a
  // reachable data-theme target -- either a non-umbrella pilot slug, or one
  // of an umbrella pilot's two expanded targets. A key naming neither (a
  // typo, a retired preset, a bare umbrella slug that was never expanded)
  // would sit in the map inert: pbpApplyOptionsEarlyTheme's resolved
  // `target` never equals it, so PBP_OPTIONS_DENSITY_MAP's lookup never
  // matches and the density silently never applies.
  const unreachable = Object.keys(densityMap).filter((key) => !density.reachableTargets.has(key));
  check(unreachable.length === 0,
    `options-theme-early.js density map has keys that are not reachable data-theme targets: ${unreachable.join(", ")}`);
}

check(/<form[^>]*id="login-form"[^>]*class="login-body"/.test(popupHtml) &&
  /id="login-btn"[^>]*type="submit"[^>]*class="btn/.test(popupHtml) &&
  /id="login-error"[^>]*role="alert"[^>]*aria-live="assertive"/.test(popupHtml) &&
  popupJs.includes('$id("login-form").addEventListener("submit"'),
  "popup login is not a semantic submit form with an announced inline error");

// CSP form-action 'none' relies on both extension-page <form> submit
// handlers actually calling preventDefault() as their first statement —
// otherwise a real submit would try to navigate and CSP would silently
// swallow it instead of the JS handler running as designed.
check(/\$id\("login-form"\)\.addEventListener\("submit",\s*async\s*\(event\)\s*=>\s*\{\s*event\.preventDefault\(\);/.test(popupJs),
  "popup.js: #login-form submit handler no longer preventDefaults first — form-action 'none' would break login");
check(/#ask-form"\)\.addEventListener\("submit",\s*\(e\)\s*=>\s*\{\s*e\.preventDefault\(\);/.test(mdAskJs),
  "md-ask.js: #ask-form submit handler no longer preventDefaults first — form-action 'none' would break Ask");

check(mdPreviewJs.includes('renderEmptyState(t("mdPreviewEmpty"), "mdPreviewClose")') &&
  /function renderEmptyState\(message, actionKey\)/.test(mdPreviewJs) &&
  mdPreviewJs.includes("window.close()"),
  "md-preview empty payload state does not offer a localized close action");

{
  const searchStart = optionsJs.indexOf("function setupOptionsSearch");
  const searchEnd = optionsJs.indexOf("async function pbpBuildSanitizedDiagnostics", searchStart);
  const searchSetup = searchStart >= 0 && searchEnd > searchStart ? optionsJs.slice(searchStart, searchEnd) : "";
  check(/id="options-search-input"/.test(optionsHtml) &&
    !/id="options-search-input"[^>]*aria-expanded=/.test(optionsHtml) &&
    !/setAttribute\("aria-expanded"/.test(searchSetup),
    "options searchbox uses aria-expanded without a combobox/listbox contract");
}

check(/\.connection-health\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/.test(optionsCss),
  "connection overview does not use the balanced three-column desktop grid");

// Shared by the three weak-text-on-fill offender scans below (options/popup/
// library) and the T3 review's own scratch reproduction (Ruling 16). The
// ORIGINAL exemption was a bare `/:disabled\b/.test(selector)` substring
// test, which is foolable two ways a real selector in this codebase already
// uses dozens of times (`.btn:hover:not(:disabled)` etc., verified: `grep -c
// ':not(:disabled)' popup.css options.css library.css` is non-zero in all
// three):
//   - `.x:not(:disabled)` matches an ENABLED element -- the opposite of the
//     WCAG 1.4.3 exemption this is supposed to recognize -- but the
//     substring ":disabled" is still textually present inside the `:not()`
//     argument, so the old test wrongly exempted it.
//   - `.x:disabled ~ .y` describes TWO elements: `.x` (disabled) and `.y`
//     (the one this rule's declarations actually paint, and which is NOT
//     itself disabled). The old test still matched the substring anywhere in
//     the selector and wrongly exempted a rule that paints an enabled
//     element.
// Fixed to match scripts/ui-render-audit.mjs's own weakTextOnFill family
// (T5): exempt only when `:disabled` is a pseudo-class on the selector's
// FINAL compound (the segment after the last top-level combinator, which is
// the element the rule's declarations actually paint) and not inside a
// `:not(...)`/`:is(...)`/`:where(...)` argument.
function selectorEndsWithDisabled(selector) {
  // Drop every parenthesized argument (its parens included) before
  // compound-splitting -- ':not(:disabled)' becomes ':not', which no longer
  // contains the literal ':disabled' pseudo-class.
  let depth = 0, stripped = "";
  for (const ch of selector) {
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) stripped += ch;
  }
  // Split on the LAST top-level combinator (descendant space, or '>' / '+' /
  // '~') to isolate the FINAL compound -- an earlier ':disabled' (an
  // ancestor or previous sibling, e.g. '.x:disabled ~ .y') describes a
  // DIFFERENT element than the one this rule paints.
  const combinator = stripped.match(/(.*[\s>+~])([^\s>+~]+)\s*$/);
  const finalCompound = combinator ? combinator[2] : stripped;
  // F7 (T5 fix wave): `\b` is a WORD-boundary assertion, and '-' is not a
  // word character, so the transition from 'd' to '-' in ':disabled-thing'
  // already satisfies `\b` right after "disabled" -- `/:disabled\b/` wrongly
  // matched a LONGER identifier that merely starts with "disabled", not the
  // real pseudo-class. Require the match to be the end of the compound, or
  // immediately followed by '::' (a chained pseudo-element still targets the
  // disabled element, e.g. ':disabled::before').
  return /:disabled($|::)/.test(finalCompound);
}

// F7 (T5 fix wave): a CSS rule's selector LIST is comma-separated
// (`rule.selectors`), and every selector in that list shares the SAME
// declaration block -- `#submit-btn:disabled, .t5-listhole { color: ...;
// background: ...; }` paints BOTH, one of them disabled and one not. The
// three checks below used to test the exemption with `rule.selectors.some(
// ...)`, which exempts the WHOLE RULE (every co-listed selector, including
// the enabled ones) the moment ANY ONE selector in the list ends with
// `:disabled` -- an enabled `.t5-listhole` riding along in the same rule as
// `#submit-btn:disabled` was silently exempted too. Fixed to filter
// per-selector: only the selectors that themselves end with `:disabled` are
// dropped, and if any non-exempt selector remains, the whole rule's
// declarations are still checked against it.
function nonExemptSelectors(rule) {
  return rule.selectors.filter((s) => !selectorEndsWithDisabled(s));
}

// The options control fills law 8 keeps weak text off, as one pattern for the
// three static options scans below (the two discrimination blocks and the
// real check): the four btn / input / chip fills, plus -- stage 4, spec
// 2026-09-30-ui-fields-stage4-design §3.1 -- the value boxes' own field-bg /
// -hover / -focus (render family 13's options fill set gained the same three).
const OPT_CONTROL_FILL_RE = /--opt-(?:btn-bg|btn-hover|input-bg|chip-bg|field-bg(?:-hover|-focus)?)\b/;

// A colour literal inside a url() of a value box's own rule (stage 4 spec
// 2026-09-30 §2.2 / §5.1): `%23<hex>` / `#<hex>` / rgb() / hsl() in a data URI
// paints the same colour on every theme and sails past countBareHex (it looks
// for a bare "#"). Module-level so each surface's block can run it with its
// own value-box predicate (options's Stage 4 Task 4 block; popup / library
// follow). Keep both ABOVE their first caller: URL_COLOUR_RE is a const, and
// calling the function before this line has run throws a TDZ ReferenceError.
const URL_COLOUR_RE = /%23[0-9a-f]{3,8}(?![0-9a-z])|#[0-9a-f]{3,8}(?![0-9a-z])|\b(?:rgba?|hsla?)\(/i;
function valueBoxUrlColourOffenders(css, isBox) {
  return parseStyleRules(css).flatMap((r) => {
    const boxes = r.selectors.filter(isBox);
    if (!boxes.length) return [];
    return parseDeclarations(r.body).filter((d) => /url\(/i.test(d.value) && URL_COLOUR_RE.test(d.value))
      .map((d) => `${boxes.join(", ")} { ${d.property}: ${d.value.slice(0, 72)}... }`);
  });
}

// The stage 4 value-box SHAPE scan (spec 2026-09-30-ui-fields-stage4-design
// §2.1 / §5.1; COMPONENTS.md §6.1): no hand rule draws a value box apart from
// its one frame colour and one radius -- no bottom-side border property
// (physical or logical; shorthand, colour, width or style), no value naming a
// --<ns>-field-edge* token, no multi-value border-color / border-block-color
// whose bottom differs from its top, no multi-value border-radius and no
// per-corner radius longhand. Module level since Task 6 so each surface's
// block runs it with its own value-box predicate (`isBox`, per selector):
// options since Task 2, popup since Task 6, library since Task 7. `exempt(
// sels, decl)` lets a surface name its one sanctioned exception (popup: the
// open tags shell's two square bottom corners; library: the group unit's text
// passenger's concentric left corners). Keep the const ABOVE its first
// caller (TDZ; the popup block runs long before the options one).
function valueTokens(value) {
  const out = [];
  let cur = "", depth = 0;
  for (const ch of value.replace(/!important\s*$/i, "").trim()) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const RADIUS_CORNER_RE = /^border-(?:(?:top|bottom)-(?:left|right)|(?:start|end)-(?:start|end))-radius$/;
function valueBoxShapeOffenders(css, isBox, { ns = "opt", exempt = null } = {}) {
  const edgeRe = new RegExp(`--${ns}-field-edge`);
  const out = [];
  for (const r of parseStyleRules(css)) {
    const sels = r.selectors.filter(isBox);
    if (!sels.length) continue;
    for (const d of parseDeclarations(r.body)) {
      if (exempt && exempt(sels, d)) continue;
      const ts = valueTokens(d.value);
      const splitBottom = (d.property === "border-color" && ts.length >= 3 && ts[2] !== ts[0]) ||
        (d.property === "border-block-color" && ts.length >= 2 && ts[1] !== ts[0]);
      const splitRadius = (d.property === "border-radius" && ts.length > 1) || RADIUS_CORNER_RE.test(d.property);
      if (/^border-(?:bottom|block-end)(?:-(?:color|width|style))?$/.test(d.property) || edgeRe.test(d.value) || splitBottom || splitRadius) {
        out.push(`${sels.join(", ")} { ${d.property}: ${d.value} }`);
      }
    }
  }
  return out;
}

// Windows High Contrast contexts (stage 4 Task 4 fix round 1). A rule inside
// `@media (forced-colors: active)` paints system colours by design, so the
// value-box scans exempt it and the forced-colours focus gate counts its
// outline as coverage. `@media (forced-colors: none)` is the OPPOSITE --
// ordinary rendering (options.css has one such block) -- so a bare
// /forced-colors/ test, which matched both, exempted normal-mode rules and
// credited normal-mode outlines as High Contrast coverage.
const FORCED_ACTIVE_RE = /forced-colors\s*:\s*active/;
const FORCED_NONE_RE = /forced-colors\s*:\s*none/;
const inForcedColors = (rule) => rule.context.some((c) => FORCED_ACTIVE_RE.test(c));

// ---- Ruling 16 (T3 review) + F7 (T5 fix wave): three adversarial selector
// shapes, reproduced as scratch CSS (not the real popup/options/library
// source), pairing a weak-text colour with a control fill on the SAME rule,
// run through the exact same exempt-then-pair pipeline the three real checks
// below use. All three must be CAUGHT as offenders (not silently exempted),
// and the negative control (a GENUINE `:disabled` selector) must NOT be --
// proving the fix end-to-end, not just asserting selectorEndsWithDisabled's
// return value in isolation.
{
  const scratch = ".x:not(:disabled) { color: var(--opt-fg-hint); background: var(--opt-btn-bg); }\n"
    + ".x:disabled ~ .y { color: var(--opt-fg-hint); background: var(--opt-btn-bg); }\n"
    // F7: a selector LIST where one entry is a genuine `:disabled` selector
    // and the other is not -- `rule.selectors.some(...)` used to exempt the
    // WHOLE rule (both co-listed selectors) the moment #submit-btn:disabled
    // matched, silently waving the enabled .t5-listhole through too.
    + "#submit-btn:disabled, .t5-listhole { color: var(--opt-fg-hint); background: var(--opt-btn-bg); }\n"
    // F7: `\b` after ":disabled" wrongly matched a LONGER identifier that
    // merely starts with "disabled" -- not a real pseudo-class, but a
    // realistic adversarial shape (a hypothetical custom pseudo/attribute
    // token) this scan must not treat as the WCAG 1.4.3 exemption.
    + ".t5-longer-token:disabled-thing { color: var(--opt-fg-hint); background: var(--opt-btn-bg); }\n";
  const rules = parseStyleRules(scratch);
  const caught = [];
  const exempted = [];
  for (const rule of rules) {
    const liveSelectors = nonExemptSelectors(rule); // the real (fixed) exemption path
    for (const s of rule.selectors) if (!liveSelectors.includes(s)) exempted.push(s);
    if (!liveSelectors.length) continue;
    const decls = parseDeclarations(rule.body);
    const colorDecl = decls.find((d) => d.property === "color");
    const bgDecl = decls.find((d) => d.property === "background" || d.property === "background-color");
    if (!colorDecl || !bgDecl) continue;
    if (/--opt-(fg-hint|fg-muted|link)\b/.test(colorDecl.value) && OPT_CONTROL_FILL_RE.test(bgDecl.value)) {
      caught.push(...liveSelectors);
    }
  }
  const expectCaught = [".x:not(:disabled)", ".x:disabled ~ .y", ".t5-listhole", ".t5-longer-token:disabled-thing"];
  check(expectCaught.every((s) => caught.includes(s)) && caught.length === expectCaught.length,
    "ui-contract-tests.mjs: the tightened :disabled exemption still lets " +
    expectCaught.filter((s) => !caught.includes(s)).join(", ") +
    " through as a false exemption, or over-catches -- caught=[" + caught.join(", ") + "]");
  check(exempted.length === 1 && exempted.includes("#submit-btn:disabled"),
    "ui-contract-tests.mjs: the genuine :disabled selector #submit-btn:disabled was not exempted (or something else wrongly was) -- exempted=[" + exempted.join(", ") + "]");
}

// ---- Q3 (T5 fix wave, discrimination): the static pair regex used to be
// `btn-bg|btn-hover` only -- law 8 names FOUR control fills
// (btn-bg/btn-hover/input-bg/chip-bg), so a rule pairing a weak-text colour
// with `--opt-input-bg` or `--opt-chip-bg` on the SAME selector was
// structurally invisible to this static scan even though it is exactly the
// shape law 8 forbids. Proven end-to-end (not just regex-in-isolation) with
// scratch CSS run through the exact same pipeline the three real checks use.
{
  const scratch = ".t5-input { color: var(--opt-fg-muted); background: var(--opt-input-bg); }\n"
    + ".t5-chip { color: var(--opt-fg-hint); background: var(--opt-chip-bg); }\n"
    // stage 4: a value box's own fill is a control fill too
    + ".t5-field { color: var(--opt-fg-muted); background-color: var(--opt-field-bg-hover); }\n"
    + ".t5-safe { color: var(--opt-fg); background: var(--opt-input-bg); }\n"; // fg is not a weak-text role -- must NOT be caught
  const rules = parseStyleRules(scratch);
  const caught = [];
  for (const rule of rules) {
    const liveSelectors = nonExemptSelectors(rule);
    if (!liveSelectors.length) continue;
    const decls = parseDeclarations(rule.body);
    const colorDecl = decls.find((d) => d.property === "color");
    const bgDecl = decls.find((d) => d.property === "background" || d.property === "background-color");
    if (!colorDecl || !bgDecl) continue;
    if (/--opt-(fg-hint|fg-muted|link)\b/.test(colorDecl.value) && OPT_CONTROL_FILL_RE.test(bgDecl.value)) {
      caught.push(...liveSelectors);
    }
  }
  check(caught.length === 3 && caught.includes(".t5-input") && caught.includes(".t5-chip") && caught.includes(".t5-field") && !caught.includes(".t5-safe"),
    "ui-contract-tests.mjs: the Q3-widened pair regex does not catch a weak-text-on-input-bg/chip-bg/field-bg pairing (or over-catches .t5-safe's fg-on-input-bg, which law 8 permits) -- caught=[" + caught.join(", ") + "]");
}

// ---- weak-text-on-fill (T2, COMPONENTS.md §9.1 law 8): --opt-fg-hint /
// --opt-fg-muted must never paint text that rests on a control fill
// (--opt-btn-bg / --opt-btn-hover); the only sanctioned token for secondary
// text on those fills is --opt-btn-fg-muted. Parsed with the theme-factory's
// own CSS-syntax scanner (not a text-grep regex) over the HAND-WRITTEN region
// only, so a comment or string literal that happens to mention one of these
// token names can't be counted as coverage the way a plain grep could
// (COMPONENTS.md's own "text grep 覆盖判定被注释击穿" lesson).
//
// STATED BLIND SPOTS (honestly, not just in a comment nobody reads): this is
// a STATIC source scan, not a render probe.
//   - It cannot see the CASCADE. A higher-specificity `html[data-theme] ...`
//     rule restating `color` on the SAME selector can silently win at
//     runtime and this check has no way to know which declaration actually
//     paints -- that is scripts/ui-render-audit.mjs's `weakTextOnFill`
//     family's job (T5), not this one's.
//   - It cannot see INHERITANCE across rules. A selector with no `background`
//     of its own that happens to sit inside a btn-bg/btn-hover ancestor at
//     runtime (the real shape every consumer this task fixed actually has --
//     .connection-health-state's fill comes from its PARENT
//     .connection-health-row, not its own rule) is invisible to a same-rule
//     pairing check. Check 2 below only catches the narrower case of a
//     single rule declaring BOTH `color` and `background` on the same
//     selector -- a real, if narrower, regression shape worth guarding
//     against even though it is not the shape any of this task's real bugs
//     took.
{
  const hand = stripGeneratedRegions(optionsCss);
  const rules = parseStyleRules(hand);

  const stateRule = rules.find((r) => r.context.length === 0 && r.selectors.includes(".connection-health-state"));
  const stateUsesBtnFgMuted = !!stateRule && parseDeclarations(stateRule.body)
    .some((d) => d.property === "color" && d.value.includes("--opt-btn-fg-muted"));
  check(stateUsesBtnFgMuted,
    "options.css: .connection-health-state's base rule no longer reads --opt-btn-fg-muted for its (rest + hover) text color");

  const offenders = [];
  for (const rule of rules) {
    // :disabled is the one documented WCAG 1.4.3 exemption (plan §0 /
    // COMPONENTS.md's #submit-btn:disabled note) -- excluded PER SELECTOR
    // via nonExemptSelectors (Ruling 16 + F7: the old `rule.selectors.some
    // (...)` exempted the WHOLE rule, including any enabled selector
    // co-listed with a genuine `:disabled` one), which options.css has no
    // live consumer of today (verified: `grep -c 'fg-hint\|fg-muted'
    // options.css` around any `:disabled` selector is 0) but is kept here
    // for parity with the popup/library checks below and to stay correct if
    // one is added.
    const liveSelectors = nonExemptSelectors(rule);
    if (!liveSelectors.length) continue;
    const decls = parseDeclarations(rule.body);
    const colorDecl = decls.find((d) => d.property === "color");
    const bgDecl = decls.find((d) => d.property === "background" || d.property === "background-color");
    if (!colorDecl || !bgDecl) continue;
    // Q3 (T5 fix wave): widened from btn-bg/btn-hover to law 8's full
    // four-fill set (input-bg, chip-bg added) -- the discrimination run
    // confirmed cross-rule offenders on all three surfaces, and this static
    // pair scan's own fill list was narrower than the fills it claims to
    // guard (COMPONENTS.md §9.1 law 8 / §10.3 weakTextOnFill).
    if (/--opt-(fg-hint|fg-muted)\b/.test(colorDecl.value) && OPT_CONTROL_FILL_RE.test(bgDecl.value)) {
      offenders.push(...liveSelectors);
    }
  }
  check(offenders.length === 0,
    "options.css: a hand-written rule pairs --opt-fg-hint/--opt-fg-muted directly with --opt-btn-bg/--opt-btn-hover on the SAME selector -- weak text on a control fill (COMPONENTS.md §9.1 law 8); offenders: " + offenders.join(", "));
}

// ---- weak-text-on-fill (T3, COMPONENTS.md §9.1 law 8, D3(b)): --pp-fg-hint /
// --pp-fg-muted / --pp-link must never paint text that rests on a control
// fill (--pp-btn-bg / --pp-btn-hover). The only sanctioned tokens for text on
// those fills are --pp-btn-fg-muted (secondary) and --pp-btn-fg (primary /
// hover-deepened) -- .qbtn and .md-strip-btn are buttons, not links, so D3(b)
// drops --pp-link from both rather than deriving a third `btn-link` role.
// Same theme-factory CSS-syntax scanner as the T2 options check above (not a
// text-grep regex) over the HAND-WRITTEN region only.
//
// STATED BLIND SPOTS (same shape as the T2 options check above): this is a
// STATIC source scan, not a render probe.
//   - It cannot see the CASCADE. A higher-specificity `html[data-theme] ...`
//     rule restating `color` on the SAME selector can silently win at
//     runtime -- that is scripts/ui-render-audit.mjs's `weakTextOnFill`
//     family's job (T5), not this one's.
//   - It cannot see INHERITANCE across rules. A selector with no `background`
//     of its own is invisible to a same-rule pairing check. Check 2 below
//     only catches a single rule declaring BOTH `color` and `background` on
//     the same selector.
// No render-audit-checklist.mjs CHECKS row is added for this task: T5's
// `weakTextOnFill` family (scripts/ui-render-audit.mjs) is a class-scan, not
// a hand-enumerated selector list, so a `.qbtn` render-probe row would never
// exist as its own checklist entry -- the family's own header comment there
// documents its scope instead.
{
  const hand = stripGeneratedRegions(popupCss);
  const rules = parseStyleRules(hand);

  const qbtnRule = rules.find((r) => r.context.length === 0 && r.selectors.includes(".qbtn"));
  const qbtnUsesBtnFgMuted = !!qbtnRule && parseDeclarations(qbtnRule.body)
    .some((d) => d.property === "color" && d.value.includes("--pp-btn-fg-muted"));
  check(qbtnUsesBtnFgMuted,
    "popup.css: .qbtn's base rule no longer reads --pp-btn-fg-muted for its resting text color");

  const offendersPp = [];
  for (const rule of rules) {
    // :disabled is the one documented WCAG 1.4.3 exemption (plan §0 /
    // COMPONENTS.md's #submit-btn:disabled note) -- excluded PER SELECTOR
    // via nonExemptSelectors (Ruling 16: a bare `:disabled\b` substring test
    // wrongly exempted `:not(:disabled)` and `:disabled ~ .y`, matching
    // scripts/ui-render-audit.mjs's weakTextOnFill family's own exemption
    // rule, which walks the live `disabled` IDL property instead; F7: the
    // per-RULE `rule.selectors.some(...)` shape also wrongly exempted any
    // enabled selector co-listed with a genuine `:disabled` one).
    const liveSelectors = nonExemptSelectors(rule);
    if (!liveSelectors.length) continue;
    const decls = parseDeclarations(rule.body);
    const colorDecl = decls.find((d) => d.property === "color");
    const bgDecl = decls.find((d) => d.property === "background" || d.property === "background-color");
    if (!colorDecl || !bgDecl) continue;
    // Q3 (T5 fix wave): widened to law 8's full four-fill set (input-bg,
    // chip-bg added) -- see the options check above for the rationale.
    // Stage 4 Task 6: the field fills joined law 8's set -- popup's value
    // boxes paint --pp-field-bg(-hover|-focus) now, not --pp-input-bg.
    if (/--pp-(fg-hint|fg-muted|link)\b/.test(colorDecl.value) && /--pp-(btn-bg|btn-hover|input-bg|chip-bg|field-bg(?:-hover|-focus)?)\b/.test(bgDecl.value)) {
      offendersPp.push(...liveSelectors);
    }
  }
  check(offendersPp.length === 0,
    "popup.css: a hand-written rule pairs --pp-fg-hint/--pp-fg-muted/--pp-link directly with a control fill (--pp-btn-bg/-hover, --pp-input-bg, --pp-chip-bg, --pp-field-bg/-hover/-focus) on the SAME selector -- weak text on a control fill (COMPONENTS.md §9.1 law 8); offenders: " + offendersPp.join(", "));
}

// ---- weak-text-on-fill (T4, COMPONENTS.md §9.1 law 8, D6): --lib-fg-hint /
// --lib-fg-muted / --lib-link must never paint text that rests on a control
// fill (--lib-btn-bg / --lib-btn-hover). .vocab-sort-seg > .vocab-sort-btn's
// unpressed rest state is this batch's one real consumer -- its `background`
// is `transparent`, so the fill it actually sits on is the shell's own
// --lib-btn-bg, and the raw --lib-fg-muted it used to read is not AA-derived
// against that (or --lib-btn-hover, which its own :hover/:active rules paint
// after T4's fix). Same theme-factory CSS-syntax scanner as the T2/T3 checks
// above (not a text-grep regex) over the HAND-WRITTEN region only.
//
// STATED BLIND SPOTS (same shape as the T2/T3 checks above): this is a
// STATIC source scan, not a render probe.
//   - It cannot see the CASCADE. A higher-specificity rule restating `color`
//     on the SAME selector (library.css has none for .vocab-sort-btn today,
//     verified -- `grep -c 'html\[data-theme\][^{]*vocab-sort' library.css`
//     is 0) can silently win at runtime -- that is
//     scripts/ui-render-audit.mjs's `weakTextOnFill` family's job (T5), not
//     this one's.
//   - It cannot see INHERITANCE across rules. A selector with no `background`
//     of its own is invisible to a same-rule pairing check -- exactly
//     .vocab-sort-btn's OWN shape (background: transparent, resting on its
//     ancestor .vocab-sort-seg's fill), which is why this check pins the
//     specific selector by name (Check 1) rather than relying on the generic
//     same-rule pairing scan (Check 2) to catch it. Check 2 only catches a
//     single rule declaring BOTH `color` and `background` on the same
//     selector -- the four D6 batch-selection-band consumers
//     (.vocab-row-gloss / .notes-row-meta / .notes-hit-note /
//     .notes-hit-meta) are a THIRD blind spot this static scan cannot see at
//     all: their fill is a runtime color-mix() composed from a CSS custom
//     property the row sets, not a `background`/`background-color` literal
//     on their own rule or any ancestor's -- and D6 itself did not ship this
//     task (see this commit's message / task-4-report.md: `fg` failed the
//     26% band on 2/15 blocks, so the plan's own stop line applied).
// No render-audit-checklist.mjs CHECKS row is added for this task, same
// reasoning as the T3 popup check above: T5's `weakTextOnFill` family is a
// class-scan (including .vocab-sort-seg's unpressed cell AND the four D6
// batch-band consumers this static scan's third blind spot names above),
// not a hand-enumerated selector list.
{
  const hand = stripGeneratedRegions(libraryCss);
  const rules = parseStyleRules(hand);

  const sortBtnRule = rules.find((r) => r.context.length === 0 && r.selectors.includes(".vocab-sort-seg > .vocab-sort-btn"));
  const sortBtnUsesBtnFgMuted = !!sortBtnRule && parseDeclarations(sortBtnRule.body)
    .some((d) => d.property === "color" && d.value.includes("--lib-btn-fg-muted"));
  check(sortBtnUsesBtnFgMuted,
    "library.css: .vocab-sort-seg > .vocab-sort-btn's base rule no longer reads --lib-btn-fg-muted for its resting text color");

  const offendersLib = [];
  for (const rule of rules) {
    // :disabled is the one documented WCAG 1.4.3 exemption (plan §0 /
    // COMPONENTS.md's #submit-btn:disabled note) -- excluded PER SELECTOR
    // via nonExemptSelectors (Ruling 16 + F7), matching scripts/ui-render-
    // audit.mjs's weakTextOnFill family's own exemption rule. library.css
    // has no disabled-state consumer of these tokens today; the exclusion is
    // kept for parity with the T2/T3 checks and to stay correct if one is
    // added later.
    const liveSelectors = nonExemptSelectors(rule);
    if (!liveSelectors.length) continue;
    const decls = parseDeclarations(rule.body);
    const colorDecl = decls.find((d) => d.property === "color");
    const bgDecl = decls.find((d) => d.property === "background" || d.property === "background-color");
    if (!colorDecl || !bgDecl) continue;
    // Q3 (T5 fix wave): widened to law 8's full four-fill set (input-bg,
    // chip-bg added) -- see the options check above for the rationale. Stage 4
    // (Task 7, T7-f): the value boxes' own fills (field-bg / -hover / -focus)
    // joined it, as on options and popup.
    if (/--lib-(fg-hint|fg-muted|link)\b/.test(colorDecl.value) && /--lib-(btn-bg|btn-hover|input-bg|chip-bg|field-bg(?:-hover|-focus)?)\b/.test(bgDecl.value)) {
      offendersLib.push(...liveSelectors);
    }
  }
  check(offendersLib.length === 0,
    "library.css: a hand-written rule pairs --lib-fg-hint/--lib-fg-muted/--lib-link directly with a control fill (--lib-btn-bg/-hover, --lib-input-bg, --lib-chip-bg, --lib-field-bg/-hover/-focus) on the SAME selector -- weak text on a control fill (COMPONENTS.md §9.1 law 8); offenders: " + offendersLib.join(", "));
}

// ---- weak-text-on-fill (D6 follow-up / Ruling 17): the batch-selected
// (.selected) state's four text consumers named in the T4 comment above as
// its THIRD blind spot -- .vocab-row-gloss / .notes-row-meta /
// .notes-hit-note / .notes-hit-meta -- must read --lib-row-selected-fg
// while sitting on the batch-selection accent band (a runtime color-mix()
// set via a custom property on an ancestor, invisible to Check 1/2's
// same-rule `background` scan above). D6 itself stopped short of this
// (plan's own stop line: `fg` failed the 26% band on 2/15 blocks); Ruling
// 17 ships it with the EXISTING --lib-row-selected-fg role instead, already
// derived against both bands by construction (library-chrome.mjs's
// LIB_BATCH_BAND_MIX; see contrast-audit.mjs's "row-selected-fg vs
// batch-band-*" rows and tests/theme-ui-derive-tests.mjs's independent
// category assertion for the derivation-side guarantee). This check is the
// CSS-consumer-side guard: it does not re-derive contrast, only that the
// four selectors' `.selected`-scoped rule actually reads the role. The
// plain [aria-current] rules are untouched (fg-muted already clears AA
// against --lib-row-selected-bg) and are deliberately NOT asserted here. ----
{
  const hand = stripGeneratedRegions(libraryCss);
  const rules = parseStyleRules(hand);
  const usesRowSelectedFg = (selector) => {
    const rule = rules.find((r) => r.context.length === 0 && r.selectors.includes(selector));
    return !!rule && parseDeclarations(rule.body)
      .some((d) => d.property === "color" && d.value.includes("--lib-row-selected-fg"));
  };
  const batchSelectedConsumers = [
    ".vocab-card.selected .vocab-row-gloss",
    ".vocab-card.selected .notes-row-meta",
    ".notes-hit.selected .notes-hit-note",
    ".notes-hit.selected .notes-hit-meta",
  ];
  const missing = batchSelectedConsumers.filter((s) => !usesRowSelectedFg(s));
  check(missing.length === 0,
    "library.css: the batch-selected (.selected) state for .vocab-row-gloss/.notes-row-meta/.notes-hit-note/.notes-hit-meta no longer reads --lib-row-selected-fg -- weak text on the batch-selection accent band (COMPONENTS.md §9.1 law 8, D6 follow-up / Ruling 17); missing: " + missing.join(", "));
}

// ---- D4 (batch3 T2): the notes/vocab source links read body fg at rest,
// not the page link color -- a link-blue title over-signalled "this is the
// important thing" when its only job is attribution. --lib-fg vs bg/panel is
// already AA-gated for every library theme (contrast-audit.mjs's "* vs bg"
// / "* vs panel" rows for the default text tier), so this swap needs no new
// contrast gate -- only that the selector's own `color` declaration still
// reads the role. Same shape as the row-selected-fg check above; the
// negative lookahead keeps --lib-fg-hint/--lib-fg-muted from false-matching
// as a substring of --lib-fg. ----------------------------------------------
{
  const hand = stripGeneratedRegions(libraryCss);
  const rules = parseStyleRules(hand);
  const usesLibFg = (selector) => {
    const rule = rules.find((r) => r.context.length === 0 && r.selectors.includes(selector));
    return !!rule && parseDeclarations(rule.body)
      .some((d) => d.property === "color" && /--lib-fg(?![\w-])/.test(d.value));
  };
  const sourceLinkSelectors = [".notes-detail-source", ".notes-row-open"];
  const missing = sourceLinkSelectors.filter((s) => !usesLibFg(s));
  check(missing.length === 0,
    "library.css: .notes-detail-source/.notes-row-open no longer read --lib-fg for their resting text color (D4: source links read as body text with hover-only underline, not the page link color) -- missing: " + missing.join(", "));
}

check(/id="vocab-no-account"[^>]*role="region"[^>]*aria-labelledby="vocab-no-account-title"/.test(libraryHtml) &&
  /id="vocab-signed-out-lookup"[^>]*data-i18n="libraryLookupOpen"/.test(libraryHtml),
  "signed-out Vocabulary state lacks a named region or localized narrow lookup route");

{
  // Bounded by the next declaration rather than by the export handler, which
  // has moved down the file before and would silently widen this slice.
  const renderPreview = optionsBackupJs.slice(
    optionsBackupJs.indexOf("const renderPreview ="),
    optionsBackupJs.indexOf("const renderResult =", optionsBackupJs.indexOf("const renderPreview =")),
  );
  check(renderPreview.includes("pbpLargeFallbackFieldLabel(key)") &&
    !renderPreview.includes('customTagPrompt: "labelTagPrompt"') &&
    !renderPreview.includes('savedThemes: "labelSavedThemes"'),
    "options-backup.js: fallback field labels drifted from the shared mapping");
  check(renderPreview.includes('checkbox.checked = key === "secrets" ? false :'),
    "options-backup.js: the credential import section no longer defaults to unchecked");
}

// Writing usable secrets to disk is gated on a stop-and-read step; an ordinary
// export must stay one click.
check(/checked !== true\) \{ runExport\(\); return; \}/.test(optionsBackupJs) &&
  optionsBackupJs.includes('showConfirmPopover($id("export-settings")') &&
  optionsBackupJs.includes('msg: t("backupSecretsExportConfirm")'),
  "options-backup.js: the credential export lost its plaintext-risk confirmation");

check(!existsSync(resolve(root, "webdav.js")), "webdav.js still exists");
check(!optionsHtml.includes('id="opt-webdav') &&
  !optionsHtml.includes('src="webdav.js"'), "options.html still exposes WebDAV");
check(!optionsJs.toLowerCase().includes("webdav"), "options.js still owns WebDAV behavior");
check(!optionsCss.toLowerCase().includes("webdav"), "options.css still ships WebDAV styles");
check(manifest.permissions.includes("alarms"), "shared alarms permission was removed");
check(manifest.optional_host_permissions.join(",") ===
  "https://*/*,http://localhost/*,http://127.0.0.1/*,http://[::1]/*",
  "shared optional-host declaration changed");
check(extensionIdFromKey(manifest.key || "") === "feoognahlmfmbllpmgailahcnjppiegb",
  "manifest.json: source build no longer has the verified development extension ID");
check(manifest.content_security_policy?.extension_pages ===
    "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
  "manifest.json: extension_pages CSP changed — update this assertion AND run node scripts/zip-install-smoke.mjs");
check(manifest.optional_permissions?.includes("identity") &&
  manifest.oauth2?.client_id ===
    "1002273768498-c6d7mdsd58dfoth1khb21uocmq8kveg5.apps.googleusercontent.com" &&
  manifest.oauth2?.scopes?.join(",") === "https://www.googleapis.com/auth/drive.appdata",
  "manifest.json: development Drive OAuth capability is incomplete or over-broad");
check(releaseSh.includes("DEV_EXTENSION_ID = 'feoognahlmfmbllpmgailahcnjppiegb'") &&
  releaseSh.includes("DEV_OAUTH_CLIENT_ID = '1002273768498-c6d7mdsd58dfoth1khb21uocmq8kveg5.apps.googleusercontent.com'") &&
  releaseSh.includes("RELEASE_OAUTH_CLIENT_ID = '1002273768498-uh3bdcaqsrl1rt7dlnrfducebdeg6h63.apps.googleusercontent.com'") &&
  releaseSh.includes("manifest['key'] = RELEASE_EXTENSION_KEY") &&
  releaseSh.includes("manifest['oauth2']['client_id'] = RELEASE_OAUTH_CLIENT_ID"),
  "scripts/release.sh: source identity validation or production OAuth replacement is missing");
check(zipInstallSmoke.includes("const EXPECTED_EXTENSION_ID = 'pnjndmjhljjbdlbejeenkepdalokfooh';") &&
  zipInstallSmoke.includes("const EXPECTED_OAUTH_CLIENT_ID = '1002273768498-uh3bdcaqsrl1rt7dlnrfducebdeg6h63.apps.googleusercontent.com';") &&
  zipInstallSmoke.includes("'vocab-store.js'") &&
  zipInstallSmoke.includes("'vocab-gdrive.js'") &&
  zipInstallSmoke.includes("hasDriveOAuthCapability(packagedManifest)") &&
  zipInstallSmoke.includes("simulatedActiveDriveManifest") &&
  zipInstallSmoke.includes("OAuth-inactive manifest exposed Google Drive actions") &&
  zipInstallSmoke.includes("OAuth-active manifest did not expose Connect Google Drive"),
  "zip-install-smoke.mjs: release ID, vocabulary runtime, or both Drive OAuth UI states are not verified");
{
  const storage = privacyMd.slice(
    privacyMd.indexOf("## Data storage"),
    privacyMd.indexOf("## Chrome Web Store data categories")
  );
  const rows = storage.split("\n").filter((line) => line.startsWith("|"));
  const local = rows.find((line) => line.includes("Vocabulary sync runtime/account state"));
  const pending = rows.find((line) => line.includes("Pending vocabulary upload data"));
  const remote = rows.find((line) => line.includes("Convergence metadata sent to Google Drive"));
  check(local && pending && remote &&
    !/(version vector|dot|deletion marker|outbox|pending batch)/i.test(local) &&
    ["record key", "version vector", "dot", "deletion marker"].every((field) =>
      remote.toLowerCase().includes(field)) &&
    !/\|\s*No\s*\|\s*$/.test(remote),
  "privacy.md: local Drive state is conflated with uploaded convergence metadata");

  const driveRequest = privacyMd.slice(
    privacyMd.indexOf("16. **Google Drive API**"),
    privacyMd.indexOf("\n\nFor configured AI", privacyMd.indexOf("16. **Google Drive API**"))
  ).toLowerCase();
  const driveThirdParty = privacyMd.slice(
    privacyMd.indexOf("- **Google Drive**"),
    privacyMd.indexOf("\n-", privacyMd.indexOf("- **Google Drive**") + 1)
  ).toLowerCase();
  check(["record keys", "version vectors", "dots", "deletion markers"].every((field) =>
    driveRequest.includes(field) && driveThirdParty.includes(field)),
  "privacy.md: Google Drive request or third-party disclosure omits convergence fields");
}
check(!backgroundJs.includes('"webdav.js"'), "background.js still imports webdav.js");
check(backgroundJs.includes('"vocab-store.js"') && backgroundJs.includes('"vocab-gdrive.js"') &&
  backgroundJs.indexOf('"vocab-store.js"') < backgroundJs.indexOf('"vocab-gdrive.js"'),
  "background.js does not load the vocabulary sync dependencies in order");
check(vocabGdriveJs.includes("function pbpCreateVocabDriveSyncRunner("),
  "vocab-gdrive.js is missing the serialized sync runner");


{
  const readyAt = mdPreviewJs.indexOf("const pbpDeferredScriptsReady");
  const renderedAt = mdPreviewJs.indexOf('document.dispatchEvent(new CustomEvent("pbp:rendered"');
  const awaitAt = mdPreviewJs.lastIndexOf("await pbpDeferredScriptsReady", renderedAt);
  const readyGate = mdPreviewJs.slice(readyAt, readyAt + 400);
  check(readyAt >= 0 && awaitAt > readyAt && renderedAt > awaitAt &&
    readyGate.includes('document.readyState === "complete"') &&
    readyGate.includes("DOMContentLoaded"),
    "md-preview.js: pbp:rendered can fire before later defer scripts register their listeners");
}
{
  const targetLink = mdTranslateJs.slice(
    mdTranslateJs.indexOf('tgtLink.className = "tr-link"'),
    mdTranslateJs.indexOf("// Cost transparency")
  );
  check(targetLink.includes('pbpOpenOptionsTab("reader")') && !targetLink.includes("openOptionsPage("),
    "md-translate.js: target-language link does not open the Reader settings tab");
}

// K156: the reader's only general settings entry point -- a static
// icon-only gear button in the rail (rail-ident/view-toggle neighbourhood,
// deliberately NOT the #rail-bottom-row tray, whose four cells are all
// in-page reading-experience toggles).
{
  const btnStart = mdHtml.indexOf('id="rail-settings-btn"');
  const tagStart = btnStart >= 0 ? mdHtml.lastIndexOf("<button", btnStart) : -1;
  const tagEnd = tagStart >= 0 ? mdHtml.indexOf("</button>", tagStart) : -1;
  const btn = tagStart >= 0 && tagEnd > tagStart ? mdHtml.slice(tagStart, tagEnd) : "";
  check(!!btn && btn.includes('title="settings"') && btn.includes('data-i18n-title="settings"') &&
    btn.includes('aria-label="settings"') && btn.includes('data-i18n-aria="settings"') && btn.includes("<svg"),
    "md-preview.html: #rail-settings-btn is missing title/aria-label/icon (or dropped the shared \"settings\" i18n key)");
  check(/function pbpRailSettingsBtnInit\(\)[\s\S]{0,300}getElementById\("rail-settings-btn"\)[\s\S]{0,120}addEventListener\("click", \(\) => pbpOpenOptionsTab\("reader"\)\)/.test(mdPreviewJs),
    "md-preview.js: #rail-settings-btn's click handler does not open the Reader settings tab");
  check(/let _pbpRailSettingsInited = false;\s*\nfunction pbpRailSettingsBtnInit\(\) \{\s*\n\s*if \(_pbpRailSettingsInited\) return;/.test(mdPreviewJs),
    "md-preview.js: pbpRailSettingsBtnInit lost its idempotency guard (rail-bottom-row family precedent)");
}

for (const id of ["vocab-search", "vocab-group-filter", "vocab-sort", "vocab-select-all",
  "vocab-invert-selection", "vocab-batch-toolbar", "vocab-group-input", "vocab-add-group",
  "vocab-batch-delete", "vocab-no-results", "vocab-load-more", "vocab-list",
  "vocab-sort-time", "vocab-sort-alpha"]) {
  check(libraryHtml.includes(`id="${id}"`), `library.html: scalable vocabulary control #${id} is missing`);
}
// options.html no longer renders the word list (retired for the library
// page, Task 9) -- what has to hold here is that the settings tab still
// opens with the entry link, ahead of the collapsed secondary settings.
check((optionsHtml.match(/<details class="disclosure" data-acc-key="vocab-/g) || []).length === 5 &&
  optionsHtml.indexOf('id="vocab-open-library"') < optionsHtml.indexOf('id="dict-anki-deck"'),
  "options.html: the library entry link is not first or secondary settings are not collapsed");
const disclosureKeys = [...optionsHtml.matchAll(
  /<details class="disclosure"(?: id="[^"]+")? data-acc-key="([^"]+)"/g
)].map((match) => match[1]);
check(disclosureKeys.join(",") ===
  "connection-overview,vocab-reading,vocab-google-drive,vocab-learning,vocab-ecdict-pack,vocab-dictionary-pack",
  "options.html: settings disclosures lack stable pp-acc keys");
check(optionsJs.includes('querySelectorAll("details[data-acc-key]")') &&
  /addEventListener\("toggle",[\s\S]{0,500}pbpAccSet\(det\.dataset\.accKey, det\.open\)/.test(optionsJs),
  "options.js: native details state is not restored and persisted through pp-acc");
check(/vocab:\s*\{[\s\S]{0,260}"dict-echo-enabled": true/.test(optionsJs) &&
  !/<details class="vocab-card"[^>]*data-acc-key=/.test(optionsHtml),
  "options: vocab reset is not on or per-word cards were made persistent");
check(libraryVocabJs.includes("PBP_VOCAB_RENDER_BATCH = 100") &&
  libraryVocabJs.includes("pbpVocabFilterSort") && libraryVocabJs.includes("pbpVocabSelectRange") &&
  libraryVocabJs.includes('showConfirmPopover(button') && !libraryVocabJs.includes("window.confirm"),
  "library-vocab.js: scalable render/selection or safe batch-delete confirmation contract is missing");
check(libraryVocabJs.includes('.normalize("NFC")') && libraryVocabJs.includes('.toLowerCase()') &&
  libraryVocabJs.includes('.replace(/i\\u0307/g, "i")') &&
  libraryVocabJs.includes('.replace(/ß/g, "ss")') && libraryVocabJs.includes('.replace(/ς/g, "σ")') &&
  !libraryVocabJs.includes("toLocaleLowerCase") && !libraryVocabJs.includes("\\p{M}"),
  "library-vocab.js: vocabulary search does not use the narrow locale-independent case-fold contract");
check(libraryVocabJs.includes("pbpVocabSelectionSnapshotValid(ids, _vocabSelected, _vocabViewRows)") &&
  libraryVocabJs.includes('t("vocabSelectionChanged")') &&
  libraryVocabJs.includes('search.focus({ preventScroll: true })'),
  "library-vocab.js: stale destructive confirmations or post-action focus are not guarded");
check(libraryVocabJs.includes('t("vocabRefreshFailed")') &&
  libraryVocabJs.includes("const refreshed = await _pbpVocabReloadAfterMutation(owner, gen)") &&
  libraryVocabJs.includes("if (gen !== _vocabRenderGen) return;") &&
  libraryVocabJs.includes("_pbpVocabRenderList(true)"),
  "library-vocab.js: committed mutations, refresh failures, or incremental rendering are conflated");
check(["vocab-search", "vocab-group-filter", "vocab-sort", "vocab-group-input", "vocab-list"].every((id) =>
  new RegExp(`id="${id}"[^>]*aria-label=`).test(libraryHtml)) &&
  /class="lib-cluster" role="group" data-i18n-aria="vocabSelectionActions" aria-label=/.test(libraryHtml) &&
  /id="vocab-batch-toolbar"[^>]*role="group"[^>]*aria-label=/.test(libraryHtml) &&
  /id="vocab-selected-count"[^>]*aria-live="polite"/.test(libraryHtml),
  "library.html: production vocabulary controls lost accessible names, groups, or live selection status");
// Master-detail rows: a row reports its own selected state and marks itself
// as the one the detail pane is showing. It must NOT claim to expand -- there
// is no body under it any more, so an aria-expanded here would be a lie.
// The selection half moved off a per-row checkbox onto the row itself
// (2026-08-06 user ruling), which is why this asserts aria-selected rather
// than a checkbox label: `aria-selected` is the ONLY thing a screen reader
// has left, and it is only supported on grid/listbox descendants -- hence the
// role trio, checked here because a row built with the right attribute inside
// the wrong container announces nothing at all.
check(libraryVocabJs.includes('card.setAttribute("aria-selected", isSelected ? "true" : "false")') &&
  libraryVocabJs.includes('card.setAttribute("role", "row")') &&
  libraryVocabJs.includes('top.setAttribute("role", "gridcell")') &&
  /id="vocab-list"[^>]*role="grid"[^>]*aria-multiselectable="true"/.test(libraryHtml) &&
  libraryVocabJs.includes('card.setAttribute("aria-current", "true")') &&
  libraryVocabJs.includes("_pbpVocabOnRowActivate(w)") &&
  !libraryVocabJs.includes("aria-expanded"),
  "library-vocab.js/library.html: vocabulary rows lost the grid/aria-selected selection path or master-detail activation state");
// The keyboard half of that ruling. Ctrl/Shift+click has no keyboard twin
// unless something intercepts Space BEFORE the button's own activation, so
// the preventDefault is the contract, not decoration -- without it the row
// would both select and open, and a keyboard user could never build a
// multi-row selection at all.
check(/head\.addEventListener\("keydown"[\s\S]{0,400}e\.preventDefault\(\)[\s\S]{0,120}_pbpVocabRowSelect\(w, true\)/.test(libraryVocabJs) &&
  /_pbpVocabRowSelect\(w, false\)/.test(libraryVocabJs) &&
  libraryVocabJs.includes('head.setAttribute("aria-keyshortcuts", "Control+Space Shift+Space /")'),
  "library-vocab.js: the keyboard multi-select path (Ctrl+Space toggle / Shift+Space range, announced via aria-keyshortcuts) is gone");
// K89: "/" must be tested BEFORE the existing ctrl/meta/alt/shift gate (not
// gating shiftKey itself) in both list keydown handlers, or German
// QWERTZ/French AZERTY users -- who need Shift to type "/" -- could never
// trigger it. A ".test(...)" against a $id-scoped snippet, not a bare
// substring include, so the ordering (branch first, gate second) is what
// this actually pins, not just the branch's presence somewhere in the file.
{
  const vocabListKeydown = libraryVocabJs.slice(libraryVocabJs.indexOf('$id("vocab-list");\nif (_vocabListEl)'),
    libraryVocabJs.indexOf("const card = e.target"));
  check(/if \(e\.key === "\/" && !e\.ctrlKey && !e\.metaKey && !e\.altKey\) \{[\s\S]{0,300}\$id\("vocab-search"\)/.test(vocabListKeydown) &&
    vocabListKeydown.indexOf('e.key === "/"') < vocabListKeydown.indexOf("e.ctrlKey || e.metaKey || e.altKey || e.shiftKey"),
    "library-vocab.js: #vocab-list's \"/\" search-focus branch is missing or no longer precedes the ctrl/meta/alt/shift gate (breaks it on Shift-requiring keyboard layouts)");
  // finding 7: this is the whole-file source, not a keydown-only slice --
  // notesKeydownSlice below is the actual keydown slice, and the
  // aria-keyshortcuts check further down also reads directly off the
  // whole-file source.
  const libraryNotesSrc = read("library-notes.js");
  const notesKeydownSlice = libraryNotesSrc.slice(libraryNotesSrc.indexOf('$id("notes-list");\n  if (_notesListEl)'),
    libraryNotesSrc.indexOf("const row = e.target"));
  check(/if \(e\.key === "\/" && !e\.ctrlKey && !e\.metaKey && !e\.altKey\) \{[\s\S]{0,300}\$id\("notes-filter"\)/.test(notesKeydownSlice) &&
    notesKeydownSlice.indexOf('e.key === "/"') < notesKeydownSlice.indexOf("e.ctrlKey || e.metaKey || e.altKey || e.shiftKey"),
    "library-notes.js: #notes-list's \"/\" search-focus branch is missing or no longer precedes the ctrl/meta/alt/shift gate (breaks it on Shift-requiring keyboard layouts)");
  check(libraryNotesSrc.includes('btn.setAttribute("aria-keyshortcuts", "Control+Space Shift+Space /")'),
    "library-notes.js: the row button lost its \"/\" aria-keyshortcuts announcement");
}
check(vocabStore.includes('const _PBP_VOCAB_DB_VERSION = 2'),
  "vocabulary database is upgraded through the dedicated store");
check(!mdDict.includes('indexedDB.open(_PBP_VOCAB_DB_NAME'),
  "md-dict no longer owns vocabulary persistence");
check(vocabStore.includes("function _pbpVocabLocalMutation") && vocabStore.includes("tx.abort()") &&
  vocabStore.includes("tx.oncomplete") && vocabStore.includes("pbpVocabBatchAddGroup"),
  "vocab-store.js: vocabulary batch mutations are not one owner-checked atomic transaction");
// The batch tools live in a sticky bar inside .vocab-list-region since the
// floating-bar redesign (2026-08): the wrapper is the sticky containing
// block, so the bar can never float over the sections below the list, and
// the browse state reserves zero geometry above the cards. The word list
// (and this contract) moved wholesale to the library page in Task 9 --
// options.css/options.html no longer carry the .vocab-list-region family.
// 2026-08-06: the notes list grew the same bar, so the recipe is a shared
// selector list rather than a second copy -- the contract asserts BOTH names
// reach it, and that both regions exist as sticky containing blocks.
check(libraryCss.includes(".vocab-filter-toolbar") &&
  /\.vocab-list-region,\s*\n\.notes-list-region \{[^}]*\bposition: relative;/.test(libraryCss) &&
  /\.vocab-batch-bar,\s*\n\.notes-batch-bar\s*\{[\s\S]{0,500}position:\s*sticky[\s\S]{0,500}z-index:\s*var\(--lib-z-sticky\)/.test(libraryCss) &&
  libraryCss.includes(".vocab-card .notes-card-top"),
  "library.css: the sticky batch bar contract is missing, or the notes bar stopped sharing the vocabulary bar's recipe");
// The batch bar must stay a DIRECT child of its region: an intermediate
// wrapper becomes the sticky containing block and caps the float range at the
// bar's own height. Cheap to assert, and impossible to see in a screenshot
// until someone scrolls a long list.
for (const [region, bar] of [["vocab-list-region", "vocab-batch-toolbar"], ["notes-list-region", "notes-batch-toolbar"]]) {
  const start = libraryHtml.indexOf(`class="${region}"`);
  const slice = start < 0 ? "" : libraryHtml.slice(start, libraryHtml.indexOf(`id="${bar}"`, start));
  check(start >= 0 && (slice.match(/<div/g) || []).length === (slice.match(/<\/div>/g) || []).length + 1,
    `library.html: #${bar} is no longer a direct child of .${region} (sticky containing block would move)`);
}
check(libraryHtml.indexOf('class="vocab-list-region"') > 0 &&
  libraryHtml.indexOf('class="vocab-list-region"') < libraryHtml.indexOf('id="vocab-list"') &&
  libraryHtml.indexOf('id="vocab-load-more"') < libraryHtml.indexOf('id="vocab-batch-toolbar"') &&
  /<div class="vocab-batch-bar" id="vocab-batch-toolbar"/.test(libraryHtml),
  "library.html: batch bar is not a sticky-region child after the load-more control");
check(/#view-vocab\s+\.vocab-load-more\[hidden\][\s\S]{0,80}display:\s*none/.test(libraryCss),
  "library.css: vocabulary hidden controls can be redisplayed by component display rules");
check(libraryVocabJs.includes('t("vocabLoading")') &&
  libraryVocabJs.includes('list.setAttribute("aria-busy", loading ? "true" : "false")'),
  "library-vocab.js: vocabulary loading is not visible or aria-busy is not closed consistently");
{
  // The two pages never co-load, and since the phase-A test split (2026-08)
  // neither does any test page -- nothing browser-side would notice the two
  // copies drifting apart (a second `function` declaration of the same name
  // just shadows the first; it is not a SyntaxError). This is the only
  // remaining guard for the "verbatim twin" comment both files carry.
  const flashStatusPattern = /function _pbpVocabFlashStatus\(ok, text\) \{[\s\S]*?\n\}/;
  const optionsFlash = (optionsVocabJs.match(flashStatusPattern) || [""])[0];
  const libraryFlash = (libraryVocabJs.match(flashStatusPattern) || [""])[0];
  check(optionsFlash.length > 0 && optionsFlash === libraryFlash,
    "options-vocab.js/library-vocab.js: _pbpVocabFlashStatus twin definitions drifted");
}
check(sharedJs.includes("async function pbpVocabCurrentOwner()") &&
  sharedJs.includes("function pbpVocabOwnerLabel(owner)") &&
  libraryVocabJs.includes("pbpVocabCurrentOwner(") && optionsVocabJs.includes("pbpVocabCurrentOwner(") &&
  libraryVocabJs.includes('t("vocabResultCount", String(rows.length), String(_vocabRows.length), _vocabOwnerLabel)') &&
  libraryVocabJs.includes('empty.textContent = t("dictVocabEmpty", _vocabOwnerLabel)') &&
  !libraryVocabJs.includes('t("jinaFailed")') && !optionsVocabJs.includes('t("jinaFailed")'),
  "vocabulary account scope is absent or action errors still reuse Jina copy");
// The library migration deleted the "vocabulary view controls leak into
// settings auto-save" check outright (library.html's data-no-autosave
// attributes are now inert -- library.js has no auto-save sweep at all for
// them to guard against). That left options.js's OWN half of the old
// contract -- the sweep still has to exclude [data-no-autosave] on every
// field family it walks, or a future options.html field that opts out would
// silently start auto-saving anyway -- with no coverage. Re-assert just that
// half, scoped to options.js only.
check(optionsJs.includes('input[type="checkbox"]:not([data-no-autosave])') &&
  optionsJs.includes('input[type="text"]:not([data-no-autosave])') &&
  optionsJs.includes('select:not([data-no-autosave])'),
  "options.js: the autosave sweep dropped its [data-no-autosave] exclusion on the checkbox/text/select field families");
check(/data-i18n="dictExportTsv"/.test(optionsHtml) && /data-i18n="dictAnkiSend"/.test(optionsHtml) &&
  /data-i18n="dictEudicSend"/.test(optionsHtml) && /data-i18n="dictEudicSupportedHint"/.test(optionsHtml) &&
  /data-i18n="dictPackImportHint"/.test(optionsHtml) &&
  /id="dict-pack-file"[^>]*accept="[^"]*\.txt[^"]*\.txt\.gz[^"]*\.zip/.test(optionsHtml),
  "options.html: full-scope actions, Eudic support, or pack import formats are not explicit");
check(!read("anki-connect.js").includes("PBP_ANKI_ENDPOINT"),
  "anki-connect.js: unused PBP_ANKI_ENDPOINT remains");
{
  const libraryJs = read("library.js");
  const libraryNotesJs = read("library-notes.js");
  // The sort segment is labelled by _pbpVocabSyncSortSeg at library-vocab.js
  // parse time -- before initI18n loads a manually chosen locale, so those
  // labels come out in the BROWSER's language. The static keys give applyI18n
  // something to translate; the re-run afterwards puts the live select value's
  // label back on top of it.
  check(/id="vocab-sort-time"[^>]*data-i18n-title="vocabSortOldest"[^>]*data-i18n-aria="vocabSortOldest"/.test(libraryHtml) &&
    /id="vocab-sort-alpha"[^>]*data-i18n-title="vocabSortAz"[^>]*data-i18n-aria="vocabSortAz"/.test(libraryHtml) &&
    /applyI18n\(\);[\s\S]{0,600}_pbpVocabSyncSortSeg\(\)/.test(libraryJs),
    "library: the sort segment is not translated by applyI18n or not re-synced after it");
  // Narrow mode: only a genuine view switch hands the list back. The
  // visibilitychange re-fire dispatches pbp-lib-view WITHOUT going through
  // _pbpLibApplyView, which is exactly what keeps an open detail alive.
  check(/function _pbpLibApplyView[\s\S]{0,900}classList\.remove\("lib-narrow-detail"\)/.test(libraryJs) &&
    // The re-fire dispatches pbp-lib-view straight, never through
    // _pbpLibApplyView -- that split is the whole mechanism. The window is
    // sized to the listener body, so routing it through the view applier
    // (or padding the listener until it reaches one) trips this.
    !/addEventListener\("visibilitychange"[\s\S]{0,160}_pbpLibApplyView/.test(libraryJs) &&
    /addEventListener\("visibilitychange"[\s\S]{0,160}dispatchEvent\(new CustomEvent\("pbp-lib-view"/.test(libraryJs) &&
    libraryVocabJs.includes('else if (enterNarrow) document.body.classList.add("lib-narrow-detail")') &&
    // Entering narrow mode hides whatever was focused to get there, so the
    // handoff belongs at the render root every activation passes through --
    // not at one call site.
    /detail\.replaceChildren\(frag\);[\s\S]{0,400}if \(enterNarrow\) _pbpVocabFocusNarrowBack\(\)/.test(libraryVocabJs) &&
    /function _pbpVocabFocusNarrowBack[\s\S]{0,400}focus\(\{ preventScroll: true \}\)/.test(libraryVocabJs),
    "library: narrow mode is entered by refresh renders, left by a visibility re-fire, or strands focus on <body>");
  // Notes rebuild everything on every activation; the SELECTED highlight and
  // the scroll position that put it on screen are the user's place in the
  // page (master-detail rewrite: this was card expansion before).
  // Sliced to the function's own body (up to its column-0 closing brace)
  // rather than matched through a character window: this one carries enough
  // comment to make any distance bound a tripwire for editing the comment.
  const notesRefresh = (libraryNotesJs.split("async function _pbpNotesRefreshPreservingState")[1] || "").split("\n}\n")[0];
  check(libraryNotesJs.includes("rowEl.dataset.notesKey = hit.key") &&
    ["_pbpNotesMarkCurrentRow()", "_pbpNotesFocus("].every((s) => notesRefresh.includes(s)) &&
    // The list region is the scroll container now (library redesign §2.5
    // #2): its offset is read before the rebuild, written back after it, and
    // the page itself is never scrolled.
    notesRefresh.indexOf("const listScroll = region ? region.scrollTop : 0;") >= 0 &&
    notesRefresh.indexOf("await renderNotesPanel();") > notesRefresh.indexOf("const listScroll = region ? region.scrollTop : 0;") &&
    notesRefresh.indexOf("region.scrollTop = listScroll") > notesRefresh.indexOf("await renderNotesPanel();") &&
    !/window\.scroll(?:To|Y)/.test(notesRefresh) &&
    /pbp-lib-view[\s\S]{0,120}_pbpNotesRefreshPreservingState\(\)/.test(libraryNotesJs) &&
    // Debounced: a single highlight drag rewrites the whole record per
    // stroke, and each refresh is a full scan plus a full rebuild.
    /startsWith\("pbp_hl_"\)[\s\S]{0,400}setTimeout\([\s\S]{0,300}_pbpNotesRefreshPreservingState\(\)[\s\S]{0,40}\}, 250\)/.test(libraryNotesJs) &&
    // The confirm popover restores focus to the delete button the rebuild
    // removes, so the deleted card's neighbour has to claim it.
    libraryNotesJs.includes("_pbpNotesFocusAfterDelete(position)") &&
    /function _pbpNotesFocusAfterDelete[\s\S]{0,500}\$id\("notes-filter"\)/.test(libraryNotesJs) &&
    // Narrow mode, same three-part contract the vocabulary view above is held
    // to -- on its OWN body class, and with the focus handoff at the render
    // root every activation passes through.
    libraryNotesJs.includes('if (enterNarrow) document.body.classList.add("lib-narrow-notes")') &&
    // The window buys adjacency and nothing else: the handoff has to stay at
    // this render root rather than migrate to a call site. Notes puts it on the
    // very next line (the pane scrollTop reset #86 added follows it), so the
    // budget matches the vocabulary twin above -- which needs the room for the
    // comment standing between its own two anchors -- rather than being sized
    // to this exit, where a tighter bound would only turn an edit to that
    // comment into a red gate.
    /detail\.replaceChildren\(frag\);[\s\S]{0,400}if \(enterNarrow\) _pbpNotesFocusNarrowBack\(detail\)/.test(libraryNotesJs) &&
    // preventScroll lives in the one focus primitive every notes path calls
    // (row refocus, post-delete neighbour, narrow back, detail restore).
    /function _pbpNotesFocus\(el\)[\s\S]{0,300}focus\(\{ preventScroll: true \}\)/.test(libraryNotesJs) &&
    /function _pbpNotesFocusNarrowBack[\s\S]{0,300}_pbpNotesFocus\(host\.querySelector\("\.notes-detail-back"\)\)/.test(libraryNotesJs) &&
    /function _pbpLibApplyView[\s\S]{0,1100}classList\.remove\("lib-narrow-notes"\)/.test(libraryJs),
    "library-notes.js: a re-render loses the selected highlight/scroll/focus, narrow mode strands focus, or reader writes are not picked up while visible");
  // One tab per extension page, not one per click.
  check(sharedJs.includes("async function pbpOpenExtensionTab(page, hash)") &&
    /pbpOpenOptionsTab[\s\S]{0,200}pbpOpenExtensionTab\("options\.html"/.test(sharedJs) &&
    ["popup.js", "md-ask.js", "md-highlight.js", "options-vocab.js"].every((file) =>
      read(file).includes('pbpOpenExtensionTab("library.html"')) &&
    !/tabs\.create\(\{\s*url:\s*chrome\.runtime\.getURL\("library\.html/.test(popupJs),
    "library entry points still stack a duplicate tab per click");
}
check(sharedJs.includes('const state = ok ? "ok" : "bad"') &&
  sharedJs.includes('el.classList.toggle("bad", !ok)') && sharedJs.includes('ic.className = "status-ic " + state'),
  "shared.js: setStatusIcon does not apply matching ok/bad host and icon states");
{
  const removedOptionsHints = [
    "apiKeySecurityHint", "backupHint", "optBgSaveModeHint", "qsHint", "shortcutsManual",
    "rlHint", "batchHint", "hintClaudeModel", "hintZhipuModel", "hintKimiModel",
    "mdExportExtendedMetaHint", "secSendDestinationsHint", "optTagSortByPopHint",
    "customStyleHint", "customFontHint", "themePresetsHint", "kbdHelpVideoNote",
    "previewAiSectionHint", "previewAiEnabledHint", "previewAiModelHint",
    "optVideoDarkSchemeHint", "optVideoPauseOnLookupHint",
  ];
  check(removedOptionsHints.every((key) => !optionsHtml.includes(`data-i18n="${key}"`)),
    "options.html: redundant helper copy returned after the settings-density reduction");
  const requiredDisclosures = [
    "syncApiKeysHint", "backupPlaintextDisclosure", "backupIncludeSecretsHint", "batchAiHint",
    "skimEnableHint", "optVideoUseLoginHint", "vocabDriveScope", "vocabDriveDisclosure",
    "ecdictFormatNote", "tagGovIrreversibleWarn", "tagGovBundlesWarn", "optWaybackHint",
    "optWaybackBatchHint", "optWaybackS3Hint", "storageIntro", "diagnosticsHint",
  ];
  check(requiredDisclosures.every((key) => optionsHtml.includes(`data-i18n="${key}"`)),
    "options.html: settings-density reduction removed a security, privacy, cost, or irreversible-action disclosure");
  // The import preview counts what the file HOLDS; this line is the only place
  // that says what restoring DOES to what is already on this device. It is a
  // plain .hint between the counts and the warning slot -- a fact about the
  // operation, not an alarm, so it must not borrow hint-warn.
  {
    const semantics = optionsHtml.match(
      /<p class="([^"]*)" id="backup-preview-semantics" data-i18n="backupPreviewSemantics">/);
    const previewAt = optionsHtml.indexOf('id="backup-import-preview"');
    const countsEnd = optionsHtml.indexOf("</dl>", previewAt);
    const semanticsAt = optionsHtml.indexOf('id="backup-preview-semantics"');
    const warningAt = optionsHtml.indexOf('id="backup-preview-warning"');
    check(!!semantics && /(^|\s)hint(\s|$)/.test(semantics[1]) && !semantics[1].includes("hint-warn") &&
      countsEnd > previewAt && semanticsAt > countsEnd && semanticsAt < warningAt,
      "options.html: the import preview no longer states which sections a restore replaces, as a plain hint between the counts and the warning slot");
  }
  const readerPanel = optionsHtml.slice(
    optionsHtml.indexOf('id="panel-reader"'), optionsHtml.indexOf('id="panel-vocab"'));
  check(readerPanel.includes('id="open-shortcuts-link-md"') &&
    !readerPanel.includes('class="kbd-help-list"') && !readerPanel.includes('data-i18n="kbdHelpIntro"'),
    "options.html: Reader still duplicates its in-page shortcut help or lost the Chrome shortcut entry point");
  check(!/\.kbd-help-(list|row|chips|subtitle)/.test(optionsCss),
    "options.css: removed Reader shortcut list left dead layout rules behind");

  const contextualHelpKeys = [
    "optSyncHint", "syncApiKeysHint", "backupPlaintextDisclosure",
    "backupIncludeHighlightsHint",
    "backupIncludeVocabularyHint", "optPopupWidthHelp", "tagSyncHint",
    "tagPresetsHint", "batchTagsHint", "batchAiHint", "hintOpenAIBaseUrl",
    "hintOllamaModel", "hintCustomBaseUrl", "hintCustomKey",
    "freeTierTitle", "freeTierResourcesPrefix", "openrouterTagline", "jinaFreeTierHint",
    "aiContentSourceLocalHint", "aiContentSourceJinaHint", "optAiUseTranscriptHint",
    "aiCacheHint", "promptsHint", "tagPromptHint", "summaryPromptHint",
    "translateGlossaryHint", "skimEnableHint", "optVideoLangPrefHint", "optVideoUseLoginHint",
    "dictEchoHint", "dictEudicSupportedHint", "mdExportImagePolicyHint", "optWaybackHint", "optWaybackBatchHint",
    "optWaybackS3Hint", "archiveLogNote",
    "optThemeHint", "popupFollowHint", "customCSSOverlayHelp", "saveAsThemeHint",
    "storageIntro", "diagnosticsHint",
  ];
  const isInsideContextHelp = (key) => {
    const marker = optionsHtml.indexOf(`data-i18n="${key}"`);
    if (marker < 0) return false;
    const open = optionsHtml.lastIndexOf('<details class="context-help', marker);
    const close = optionsHtml.lastIndexOf("</details>", marker);
    return open > close;
  };
  check(contextualHelpKeys.every(isInsideContextHelp),
    "options.html: routine explanatory copy is still permanently expanded instead of using contextual help");
  const contextHelpCount = [...optionsHtml.matchAll(/<details class="context-help(?:\s|\")/g)].length;
  const contextHelpSummaries = [...optionsHtml.matchAll(
    /<summary class="btn btn-sm ghost context-help-toggle"[^>]*data-i18n-title="contextHelpTitle"[^>]*data-i18n-aria="contextHelpTitle"[^>]*>[\s\S]*?<span class="btn-ic" data-ic="help"><\/span>[\s\S]*?<\/summary>/g
  )].length;
  check(contextHelpCount >= 25 && contextHelpSummaries === contextHelpCount,
    "options.html: contextual-help toggles are missing the shared ghost/help-icon/accessibility contract");
  const contextHelpHosts = [...optionsHtml.matchAll(
    /<div\s+class="[^"]*(?:context-help-host|context-help-action-row)[^"]*"[^>]*>/g
  )].map((match) => match[0]);
  const contextHelpRoles = new Set(["section", "field", "choice", "group", "action"]);
  check(contextHelpHosts.length === contextHelpCount && contextHelpHosts.every((tag) => {
    const roles = [...tag.matchAll(/data-help-role="([^"]+)"/g)].map((match) => match[1]);
    return roles.length === 1 && contextHelpRoles.has(roles[0]);
  }) && [...contextHelpRoles].every((role) => contextHelpHosts.some((tag) => tag.includes(`data-help-role="${role}"`))),
  "options.html: contextual-help hosts no longer have one complete semantic-role registry");
  check(/html\.motion-ready details\.motion-toggle::details-content[\s\S]{0,240}var\(--motion-collapse\) var\(--ease-in-out\)/.test(optionsCss) &&
    !/\.context-help[^{]*\{[^}]*transition\s*:/.test(optionsCss),
    "options.css: contextual help no longer reuses the native-details accordion motion");
  // Hosts with copy anchor the toggle to the copy baseline (font ascent/descent
  // splits differ between the Windows and CI font stacks; a centred constant fits
  // only one of them); the choice label exposes its text baseline through the
  // copy span opting into baseline alignment; the action row's wrapper and toggle
  // share the button-text baseline while the row container itself stays centred.
  check(["section", "field", "group", "choice"].every((role) =>
    new RegExp(`\\.context-help-host\\[data-help-role="${role}"\\][^{]*\\{[^}]*align-items:\\s*baseline`).test(optionsCss) &&
    new RegExp(`\\.context-help-host\\[data-help-role="${role}"\\] > \\.context-help > summary\\.context-help-toggle[^{]*\\{[^}]*align-self:\\s*baseline`).test(optionsCss)) &&
    /\.context-help-host\[data-help-role="choice"\] > label > span[^{]*\{[^}]*align-self:\s*baseline/.test(optionsCss) &&
    !/\[data-help-role="action"\][^{]*\{[^}]*align-items:\s*baseline/.test(optionsCss) &&
    /(?:^|\n)\.context-help-action-row\[data-help-role="action"\] > \.save-theme-wrap,\s*\.context-help-action-row\[data-help-role="action"\] > \.context-help > summary\.context-help-toggle \{ align-self: baseline; \}/.test(optionsCss),
    "options.css: contextual help lost its anchoring split (copy roles on the text baseline via the label span, the action row's wrapper and toggle on the button-text baseline, its container centred)");
  check(/const det = summary && summary\.closest\("details"\);[\s\S]{0,500}details\.context-help\[open\]/.test(optionsJs),
    "options.js: contextual help lost the native-details motion gate or one-open-per-panel behavior");
  check(/const det = e\.target\.matches\?\.\("details\[data-acc-key\]"\) \? e\.target : null/.test(optionsJs) &&
    !/const det = e\.target\.closest\?\.\("details\[data-acc-key\]"\)/.test(optionsJs),
    "options.js: nested contextual help can overwrite its parent accordion persistence state");
  const directWarnings = ["backupIncludeSecretsHint", "tagGovIrreversibleWarn", "tagGovBundlesWarn"];
  check(directWarnings.every((key) => !isInsideContextHelp(key)),
    "options.html: a conditional or irreversible-action warning was hidden behind contextual help");

  // Field help expands between the label and its control. Putting <details>
  // after a tall textarea/input makes the question icon and its answer appear
  // in different visual regions even though both are inside the same host.
  const helpBeforeControl = {
    tagPresetsHint: "opt-tag-presets", batchTagsHint: "opt-batch-tag",
    hintOpenAIBaseUrl: "opt-openai-baseurl", hintOllamaModel: "opt-ollama-model",
    hintCustomBaseUrl: "opt-custom-baseurl", hintCustomKey: "opt-custom-key",
    aiCacheHint: "opt-ai-cache-duration", tagPromptHint: "opt-custom-tag-prompt",
    summaryPromptHint: "opt-custom-summary-prompt", translateGlossaryHint: "opt-translate-glossary",
    optVideoLangPrefHint: "opt-md-video-lang", dictEudicSupportedHint: "dict-eudic-token",
    mdExportImagePolicyHint: "opt-md-image-policy", customCSSOverlayHelp: "opt-custom-css",
  };
  check(Object.entries(helpBeforeControl).every(([key, id]) => {
    const help = optionsHtml.indexOf(`data-i18n="${key}"`);
    const control = optionsHtml.indexOf(`id="${id}"`);
    return help >= 0 && control >= 0 && help < control;
  }), "options.html: field contextual help expands after its control instead of directly below the label");

  const themeTitle = optionsHtml.indexOf('id="sec-theme"');
  const themeSelect = optionsHtml.indexOf('id="opt-theme"', themeTitle);
  const themeHelp = optionsHtml.lastIndexOf('<details class="context-help"', themeSelect);
  check(themeTitle >= 0 && themeHelp > themeTitle && themeHelp < themeSelect,
    "options.html: theme help is anchored over the select chevron instead of beside the section title");

  check(/id="batch-legacy-permission"[^>]*hidden/.test(optionsHtml) &&
    /batchLegacy = \$id\("batch-legacy-permission"\)[\s\S]{0,300}batchLegacy\.hidden = !has/.test(optionsJs),
    "options: the legacy all-sites maintenance block still occupies space when no broad grant exists");
  const waybackHost = optionsHtml.indexOf('class="fg entry-block wayback-log-host"');
  const waybackHeading = optionsHtml.indexOf('class="wayback-log-heading"', waybackHost);
  const waybackHelp = optionsHtml.indexOf('class="context-help-host wayback-log-help"', waybackHeading);
  const waybackTitle = optionsHtml.indexOf('data-i18n="archiveLogTitle"', waybackHelp);
  const waybackNote = optionsHtml.indexOf('data-i18n="archiveLogNote"', waybackTitle);
  const waybackClear = optionsHtml.indexOf('id="wayback-log-clear"', waybackNote);
  const waybackLog = optionsHtml.indexOf('id="wayback-log"', waybackClear);
  check(waybackHost >= 0 && waybackHeading > waybackHost && waybackHelp > waybackHeading &&
    waybackTitle > waybackHelp && waybackNote > waybackTitle && waybackClear > waybackNote &&
    waybackLog > waybackClear && /\.wayback-log-help \{ flex: 1; min-width: 0; \}/.test(optionsCss),
    "options.html: Wayback Clear still burns a standalone action row");
}

{
  for (const [file, css] of [["popup.css", popupCss], ["options.css", optionsCss],
    ["library.css", libraryCss], ["md-preview.css", mdCss]]) {
    const popoverRule = css.match(/\.confirm-popover\s*\{([\s\S]*?)\}/)?.[1] || "";
    const messageRule = css.match(/\.confirm-popover \.confirm-msg\s*\{([\s\S]*?)\}/)?.[1] || "";
    check(/box-sizing:\s*border-box/.test(popoverRule) && /flex-wrap:\s*wrap/.test(popoverRule) &&
      !/white-space:\s*nowrap/.test(popoverRule) && /min-width:\s*0/.test(messageRule) &&
      /overflow-wrap:\s*anywhere/.test(messageRule),
    `${file}: confirm popover can overflow a narrow content surface`);
  }
  check(/window\.addEventListener\("resize",\s*schedulePosition\)/.test(sharedJs) &&
    /window\.removeEventListener\("resize",\s*schedulePosition\)/.test(sharedJs) &&
    /new ResizeObserver\(schedulePosition\)/.test(sharedJs) &&
    /visualViewport\?\.addEventListener\("resize",\s*schedulePosition\)/.test(sharedJs) &&
    !/window\.addEventListener\("resize",\s*dismiss\)/.test(sharedJs),
  "shared.js: confirm positioning does not track viewport and content-surface resizes");
}
{
  const ankiTest = optionsHtml.indexOf('id="vocab-anki-test-btn"');
  const ankiStatus = optionsHtml.indexOf('id="vocab-anki-test-status"', ankiTest);
  const eudicTest = optionsHtml.indexOf('id="vocab-eudic-test-btn"');
  const eudicStatus = optionsHtml.indexOf('id="vocab-eudic-test-status"', eudicTest);
  const vocabToolbar = optionsHtml.indexOf('class="vocab-toolbar"', eudicStatus);
  const toolbarStatus = optionsHtml.indexOf('id="vocab-status"', vocabToolbar);
  check(ankiTest >= 0 && ankiStatus > ankiTest && ankiStatus < eudicTest &&
    eudicTest >= 0 && eudicStatus > eudicTest && eudicStatus < vocabToolbar &&
    vocabToolbar >= 0 && toolbarStatus > vocabToolbar,
    "options.html: vocabulary connection tests or export actions lost their local status slot");
  // The flex row's gap owns button -> status spacing everywhere (.fg-actions,
  // .vocab-toolbar, .vocab-drive-actions); a margin on the status itself would
  // double it in every row and need a per-row reset (five of those were
  // deleted in the 2026-09 rhythm retrospective).
  check(!/\.save-status\s*\{[^}]*margin-left/.test(optionsCss) && !/\.save-status\s*\{\s*margin-left:\s*0/.test(optionsCss),
    "options.css: .save-status carries its own horizontal margin again; the row gap owns button->status spacing");
  check(!optionsVocabJs.includes('_pbpVocabConnectionResult(id, ok, text, code) {\n  _pbpVocabFlashStatus(ok, text);'),
    "options-vocab.js: connection tests still route feedback through the vocabulary toolbar status");
  for (const [buttonId, statusId] of [
    ["vocab-drive-sync", "vocab-drive-action-status"],
    ["ecdict-pack-import", "ecdict-pack-action-status"],
    ["dict-pack-import", "dict-pack-action-status"],
  ]) {
    const button = optionsHtml.indexOf(`id="${buttonId}"`);
    const status = optionsHtml.indexOf(`id="${statusId}"`, button);
    check(button >= 0 && status > button,
      `options.html: #${buttonId} lost its nearby #${statusId} feedback slot`);
  }
  check(optionsVocabJs.includes('_pbpVocabFlashLocalStatus("vocab-drive-action-status"') &&
    optionsVocabJs.includes('_pbpVocabFlashLocalStatus("dict-pack-action-status"') &&
    optionsVocabJs.includes('_pbpVocabFlashLocalStatus("ecdict-pack-action-status"'),
    "options-vocab.js: Drive or dictionary-pack outcomes still escape their own card");
  check(/class="vocab-drive-notice-row"[\s\S]{0,240}id="vocab-drive-notices"[\s\S]{0,240}class="btn btn-sm ghost vocab-drive-notice-dismiss"[^>]*id="vocab-drive-clear-notices"[\s\S]{0,240}<span class="btn-ic" data-ic="cross"><\/span>/.test(optionsHtml),
    "options.html: Drive conflict notices still use a detached full-width clear action");

  const packSection = optionsHtml.indexOf('data-i18n="dictPackSection"');
  const packHint = optionsHtml.indexOf('data-i18n="dictPackHint"', packSection);
  const packStatus = optionsHtml.indexOf('id="dict-pack-status"', packSection);
  // The "does not support English word lookup" clause is GONE on purpose: the
  // ECDICT pack provides exactly that, so pinning it here would pin a lie. What
  // still has to hold is that this hint describes CC-CEDICT's own direction.
  check(packSection >= 0 && packHint > packSection && packStatus > packHint &&
    optionsHtml.includes("Simplified or Traditional Chinese terms") &&
    !optionsHtml.includes("does not support English word lookup"),
  "options.html: CC-CEDICT capability hint is missing, misplaced, or still denies English lookup");

  // The ECDICT block states the opposite direction, offers no download route,
  // and reuses the same control families as the pack above it.
  const eSection = optionsHtml.indexOf('data-i18n="ecdictSection"');
  const eHint = optionsHtml.indexOf('data-i18n="ecdictHint"', eSection);
  const eNote = optionsHtml.indexOf('data-i18n="ecdictFormatNote"', eSection);
  const eStatus = optionsHtml.indexOf('id="ecdict-pack-status"', eSection);
  check(eSection >= 0 && eHint > eSection && eNote > eHint && eStatus > eNote,
    "options.html: ECDICT section, hint, provenance note and status are missing or out of order");
  check(!/id="ecdict-pack-open"/.test(optionsHtml) &&
    !/ecdict[\s\S]{0,400}mdbg\.net|ecdict[\s\S]{0,400}github\.com/i.test(optionsHtml),
    "options.html: the ECDICT block offers a download route, which its licence position forbids");
  check(/id="ecdict-pack-status" role="status" aria-live="polite"/.test(optionsHtml) &&
    /id="ecdict-pack-import"[^>]*class="btn btn-sm"|class="btn btn-sm"[^>]*id="ecdict-pack-import"/.test(optionsHtml) &&
    optionsHtml.includes('accept=".csv,.txt,.gz,.zip"'),
    "options.html: ECDICT controls left the shared status/button/file-input families");
  // One rung, the widest, chosen once in code. A picker was declined (it would
  // need a "re-import to change it" caveat, since the rung is baked into the
  // stored rows), so the constant is the only place it can drift.
  check(/pbpEcdictImportFile\(f, \{ rung: "R3"/.test(optionsVocabJs),
    "options-vocab.js: the ECDICT import no longer requests the widest rung");
  check(!/id="ecdict-(rung|tier|level)"/.test(optionsHtml) && !/ecdictRung/.test(optionsHtml),
    "options.html: a rung picker appeared, which the shipped design has no copy or re-import story for");
}

// Corner radius is a per-theme token now: the pilot's radius scale is derived
// into --pp-radius-* / --opt-radius-* for all 13 themes (composers/_ui-derive.mjs).
// A literal px value opts that control out of every theme at once -- which is
// how the settings page ended up with buttons at 0, inputs at 0, search at 3px
// and selects at a hardcoded 7px copied over from md-preview. Only 0 and 50%
// (a circle, not a corner) are literals with no theme meaning.
{
  const offenders = [];
  for (const file of ["popup.css", "options.css"]) {
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of src.matchAll(/border-radius:\s*([^;}]+)/g)) {
      const value = m[1].trim();
      // Split on top-level whitespace, keeping var(...) groups intact.
      const parts = value.match(/var\([^)]*\)|[^\s]+/g) || [];
      const bad = parts.filter((p) => !/^var\(--(?:pp|opt)-radius-/.test(p) && p !== "0" && p !== "50%");
      if (bad.length) offenders.push(`${file}: border-radius: ${value}`);
    }
  }
  check(offenders.length === 0,
    `hardcoded corner radius bypasses the per-theme radius scale: ${offenders.join(" | ")}`);

  // The :root blocks are the no-preset generic -- the only state left where the
  // two surfaces could disagree, since all 13 themes derive their own scale.
  const scale = (file, prefix) => {
    const src = read(file);
    const root = src.slice(src.indexOf(":root {"));
    return ["sm", "md", "lg", "full"]
      .map((k) => (root.slice(0, root.indexOf("\n}")).match(new RegExp(`--${prefix}-radius-${k}:\\s*([^;]+);`)) || [])[1])
      .join("/");
  };
  const popupScale = scale("popup.css", "pp"), optionsScale = scale("options.css", "opt");
  check(popupScale === optionsScale && /^\d/.test(popupScale),
    `popup and options disagree on the default radius scale: ${popupScale} vs ${optionsScale}`);
}

// Theme tokens that are NOT declared on :root only exist once a data-theme is
// set. options-theme-early.js leaves data-theme unset for the no-preset LIGHT
// state -- the default a new user sees -- so `var(--opt-input-border)` with no
// fallback makes the whole declaration invalid there. Shipped that way, the
// vocabulary toolbar's controls had no border at all in the default theme, and
// nothing caught it: cascade-lint probes the 13 presets, which is the one state
// where these tokens DO resolve.
{
  const optionsCss = read("options.css");
  const src = optionsCss.replace(/\/\*[\s\S]*?\*\//g, "");
  // Fold EVERY top-level `:root { ... }` block, not just the first: Task 5
  // added a second one (generated, at the end of @generated:ui-themes) that
  // supplies the default-state value for a handful of newly-derived tokens
  // (--opt-btn-fg among them) alongside the original hand-written block up
  // top. Same "browser-applied" folding contrast-audit.mjs already does for
  // this exact two-:root-blocks shape (task-7-report.md) -- a single-block
  // scan here would flag those tokens as "invisible" even though the second
  // block makes them resolve just fine (same specificity, later source wins
  // is irrelevant to *whether* it resolves, only to *which value* wins).
  const declaredOnRoot = new Set();
  for (const rootMatch of src.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const m of rootMatch[1].matchAll(/(--opt-[a-z0-9-]+)\s*:/g)) declaredOnRoot.add(m[1]);
  }
  // Brace walk rather than a line scan: single-line rules, multi-line selector
  // lists and the @supports/@media wrappers all have to resolve to the right
  // governing selector, and a line-based version silently mis-attributed a
  // dozen themed rules to an unthemed one.
  const stack = [];
  let chunk = "", offenders = [];
  const themed = () => stack.some((s) => s.includes("html[data-theme"));
  const scan = (text) => {
    if (!stack.length || themed()) return;
    for (const m of text.matchAll(/var\((--opt-[a-z0-9-]+)\s*\)/g)) {
      if (!declaredOnRoot.has(m[1])) offenders.push(`${stack[stack.length - 1].slice(0, 60)} -> ${m[1]}`);
    }
  };
  for (const ch of src) {
    if (ch === "{") { stack.push(chunk.trim()); chunk = ""; }
    else if (ch === "}") { scan(chunk); stack.pop(); chunk = ""; }
    else if (ch === ";") { scan(chunk); chunk = ""; }
    else chunk += ch;
  }
  check(offenders.length === 0,
    `options.css: theme-only token used with no fallback outside html[data-theme] (invisible in the default light state): ${offenders.join(", ")}`);
}

check(!mdTranslateJs.includes("lastViewMode") &&
  /function pbpTrNextMode\(mode\)/.test(mdTranslateJs) &&
  /_pbpTrSetMode\(st, pbpTrNextMode\(st\.mode\), true\)/.test(mdTranslateJs),
  "md-translate.js: v does not implement the strict three-state cycle");
check(mdTranslateJs.includes("pbpTrSingleKeyAllowed(") && mdAskJs.includes("pbpTrSingleKeyAllowed(") &&
  mdHighlightJs.includes("pbpTrSingleKeyAllowed("),
  "md-preview single-key shortcuts do not share the modifier/typing/raw-view gate");
{
  const explainShortcut = mdAskJs.slice(mdAskJs.indexOf("function _pbpExplainOnShortcut"),
    mdAskJs.indexOf("function pbpExplainInit"));
  const explainInit = mdAskJs.slice(mdAskJs.indexOf("function pbpExplainInit"),
    mdAskJs.indexOf('document.addEventListener("pbp:rendered"', mdAskJs.indexOf("function pbpExplainInit")));
  check(mdTranslateJs.includes("_pbpTrTrigger(st)") &&
    // ZH-1b: a completed CURRENT translation stays inert (no re-entry, no
    // tokens), while a stale/mixed one may re-arm as an explicit retranslate
    // -- the guard chain is running -> done -> !staleVerdict.
    /if \(st\.running\) return;[\s\S]{0,160}if \(st\.status === "done"\) \{[\s\S]{0,500}if \(!st\.staleVerdict\) return;/.test(mdTranslateJs) &&
    explainShortcut.includes('_pbpExplainTrigger === "off"') &&
    explainShortcut.includes('pbpExplainInvoke(key === "d" ? "dict" : "explain")') &&
    explainInit.indexOf('if (_pbpExplainTrigger === "off") return') >= 0 &&
    explainInit.indexOf('if (_pbpExplainTrigger === "off") return') < explainInit.indexOf('document.addEventListener("keydown", _pbpExplainOnShortcut)'),
    "t/d shortcuts bypass the shared translation/selection action chains");
}
check(/\{ chips: \["t"\], key: "kbdHelpTranslate" \}/.test(mdReaderJsSource) &&
  /\{ chips: \["d"\], key: "kbdHelpDictionary" \}/.test(mdReaderJsSource) &&
  /\{ chips: \["v"\], key: "kbdHelpToggleView" \}/.test(mdReaderJsSource) &&
  /\{ chips: \["h", "1-5"\], key: "kbdHelpHighlight" \}/.test(mdReaderJsSource) &&
  !optionsHtml.includes('class="kbd-help-list"') &&
  !optionsHtml.includes("<kbd>V</kbd>") && !optionsHtml.includes("<kbd>H</kbd>"),
  "reader keyboard help lost t/d/v/h or the removed Settings duplicate returned");
check(/btn\.setAttribute\("aria-keyshortcuts", "t"\)/.test(mdTranslateJs) &&
  /wrap\.setAttribute\("aria-keyshortcuts", "v"\)/.test(mdTranslateJs) &&
  /b\.setAttribute\("aria-pressed", "false"\)/.test(mdTranslateJs) &&
  /b\.setAttribute\("aria-pressed", active \? "true" : "false"\)/.test(mdTranslateJs) &&
  mdTranslateJs.includes('t(key) + " (v)"'),
  "translation controls lack lowercase shortcut metadata or production toggle state");
// K87: three more rail-bottom/Ask buttons declare their bare-letter shortcut
// the same way t/v do above. "?" is deliberately the literal character, not
// "Shift+Slash" -- _pbpKbdHelpOnKeyDown judges e.key !== "?", and that key
// NAME (not a US-layout modifier combo) is what stays accurate on
// QWERTZ/AZERTY. The zen button is optional per spec; when present it must
// carry the one-line reachability comment explaining why a non-toggling
// click handler is still safe to pair with a keyshortcut.
check(mdAskJs.includes('btn.setAttribute("aria-keyshortcuts", "a")'),
  "md-ask.js: #ask-open lost its \"a\" aria-keyshortcuts");
check(mdReaderJsSource.includes('btn.setAttribute("aria-keyshortcuts", "?")'),
  "md-reader.js: #rail-kbd-help-btn lost its \"?\" aria-keyshortcuts");
if (mdReaderJsSource.includes('btn.setAttribute("aria-keyshortcuts", "z")')) {
  check(/reachable while non-zen, where enter and toggle are the same action/.test(mdReaderJsSource),
    "md-reader.js: #rail-zen-btn declares \"z\" aria-keyshortcuts without the reachability comment explaining why a non-toggling click handler is safe");
}
check(mdReaderJsSource.includes('#rail-kbd-help-btn button both open this popover') &&
  !mdReaderJsSource.includes("options static section all point at the same popover"),
  "md-reader.js: the keyboard-help comment still claims a non-existent options.html entry point");
check(mdTranslateJs.includes('scrollIntoView({ block: "start", behavior: "instant" })') &&
  mdTranslateJs.includes("document.startViewTransition") &&
  // The predicate moved into shared.js; what matters is that it still gates the
  // View Transition, so assert the gate rather than the spelling.
  /const reduceMotion = pbpPrefersReducedMotion\(\);/.test(mdTranslateJs) &&
  /!reduceMotion && typeof document\.startViewTransition === "function"/.test(mdTranslateJs) &&
  mdCss.includes("view-transition-name: pbp-tr-article") &&
  /::view-transition-group\(root\),[\s\S]{0,100}::view-transition-group\(pbp-tr-article\) \{ animation: none; \}/.test(mdCss) &&
  mdCss.includes("animation-name: pbp-tr-fade-out") && mdCss.includes("animation-name: pbp-tr-fade-in") &&
  mdCss.includes("140ms"),
  "translation view switching lacks instant anchor restore or reduced-motion-safe article transition");
{
  const settle = mdTranslateJs.slice(mdTranslateJs.indexOf("function _pbpTrSettleViewAnchor"),
    mdTranslateJs.indexOf("function _pbpTrApplyMode"));
  check(settle.includes('behavior: "instant"') && !settle.includes(".focus("),
    "translation view anchor restore animates scroll or steals keyboard focus");
}
{
  const focus = mdTranslateJs.slice(mdTranslateJs.indexOf("function _pbpTrCaptureFocusHandoff"),
    mdTranslateJs.indexOf("function _pbpTrCaptureViewAnchor"));
  const applyMode = mdTranslateJs.slice(mdTranslateJs.indexOf("function _pbpTrApplyMode"),
    mdTranslateJs.indexOf("function _pbpTrSetMode"));
  check(focus.includes('mode !== "original" && mode !== "translated"') &&
    focus.includes("document.activeElement !== handoff.active") &&
    focus.includes("target.focus({ preventScroll: true })") &&
    applyMode.indexOf("_pbpTrApplyFocusHandoff(focusHandoff)") < applyMode.indexOf("_pbpTrSettleViewAnchor(anchor, mode)"),
  "translation view switching can hide focus or let focus scroll override anchor restoration");
}
check(/orig\.dataset\.pbTrDone = "1";[\s\S]{0,380}_pbpTrSyncToc\(st, "translated"\)/.test(mdTranslateJs),
  "md-translate.js: progressively filled translated headings do not update the live TOC");
{
  // Same intent as before item #39: the target language code must reach all
  // three length-ratio gates. The manual-retry gate no longer reads
  // st.target.code inline -- #39 pinned it at initiation instead (D8 snapshot
  // discipline), so the chain is now three links and all three are asserted:
  //   md-translate.js:2390  const lang = st.target.code;            (snapshot in _pbpTrRetryBlock)
  //   md-translate.js:2407  _pbpTrTranslateBlock(st, w, ctrl.signal, lang, langName)
  //   md-translate.js:2316  lang = st.target.code                   (default keeps 3-arg callers honest)
  //   md-translate.js:2358  pbpTrLengthRatioOk(sendText, got, lang) (the gate itself)
  // Anything that drops the code from the retry path breaks one of these.
  const retryBlock = mdTranslateJs.slice(mdTranslateJs.indexOf("async function _pbpTrRetryBlock"),
    mdTranslateJs.indexOf("function _pbpTrSyncRetryAll"));
  check(mdTranslateJs.includes('const targetCode = plan.targetCode || ""') &&
    mdTranslateJs.includes("pbpTrLengthRatioOk(seg.text, item.text, targetCode)") &&
    mdTranslateJs.includes("pbpTrLengthRatioOk(seg.text, text, targetCode)") &&
    mdTranslateJs.includes("lang = st.target.code, langName = st.target.name") &&
    retryBlock.includes("const lang = st.target.code;") &&
    retryBlock.includes("_pbpTrTranslateBlock(st, w, ctrl.signal, lang, langName)") &&
    mdTranslateJs.includes("pbpTrLengthRatioOk(sendText, got, lang)") &&
    /pbpTrRunQueue\(\{[\s\S]{0,140}targetCode:\s*st\.target\.code/.test(mdTranslateJs),
    "md-translate.js: target language code does not reach batch, downgrade and manual retry quality gates");
}
{
  const waybackLog = optionsJs.slice(optionsJs.indexOf("function renderWaybackLog"),
    optionsJs.indexOf("function loadWaybackLog"));
  const permissionBranch = waybackLog.slice(waybackLog.indexOf('outcome === "permDenied"'),
    waybackLog.indexOf('outcome === "rate-limited"'));
  check(waybackLog.includes("wayback-perm-help") &&
    waybackLog.includes("PBP_ICONS.warning") &&
    waybackLog.includes('pbpScrollIntoView(target, { block: "center", behavior: "smooth" })') &&
    waybackLog.includes('focus({ preventScroll: true })') &&
    !permissionBranch.includes("outcomeEl.title"),
    "options.js: archive permission recovery remains hover-only or cannot reach the controlling setting");
}
// Both disclosure paths must exist, and the hover half must stay behind a
// fine-pointer gate: it inserts a full-width grid row inside a scrolling log,
// and on touch :hover latches after a tap and wedges the tip open.
// COMPONENTS.md §7.3 focus-ring recipes, for the two converged sites the
// render oracle cannot reach: .theme-name-popover only exists after the
// disabled #save-custom-theme is enabled and clicked, and popup's
// .regen-link is created by popup-ai.js only after an AI response. Both are
// static text contracts here rather than render entries whose setup would be
// longer than the rule they guard. Every other §7.3 site is gated live in
// tests/render-audit-checklist.mjs via `focusRecipe`.
check(/\.theme-name-popover input\[type="text"\]:focus \{[^}]*border-color: var\(--opt-field-border-focus\)/.test(optionsCss) &&
  /\.theme-name-popover input\[type="text"\]:focus-visible \{ box-shadow: var\(--opt-focus-ring\); \}/.test(optionsCss) &&
  !/theme-name-popover input\[type="text"\]:focus-visible \{ box-shadow: 0 0 0 2px/.test(optionsCss),
  "options.css: the theme-name popover input is back on a bespoke focus ring instead of --opt-field-border-focus/--opt-focus-ring (§7.3 + B+ field family)");
// The two `borderless` sites (§7.3, 2026-08-06 unification): a 1px accent
// core PLUS the surface's --{ns}-focus-ring glow. Both halves are asserted
// separately, and the glow specifically has to be the TOKEN: its shape is
// per-theme identity (terminal's 6px phosphor blur, paper-ink's flat
// `0 0 0 1px`, solarized's translucent 2px), so an inlined shadow here would
// flatten 13 presets into one look while still "having a focus ring".
// The tnp pair are `borderless` rather than `bordered` on purpose -- tnp-save
// is a solid accent button whose 1px edge is its tier, not neutral chrome.
const BORDERLESS_FOCUS = (ns) =>
  new RegExp(`outline: 1px solid var\\(--${ns}-accent\\); outline-offset: 2px; box-shadow: var\\(--${ns}-focus-ring\\);`);
check(/\.theme-name-popover \.tnp-save:focus-visible,\s*\n\s*\.theme-name-popover \.tnp-cancel:focus-visible \{ [^}]*\}/.test(optionsCss) &&
  BORDERLESS_FOCUS("opt").test(
    optionsCss.slice(optionsCss.indexOf(".theme-name-popover .tnp-save:focus-visible"),
      optionsCss.indexOf(".theme-name-popover .tnp-save:focus-visible") + 260)),
  "options.css: the theme-name popover's Save/Cancel lost the §7.3 borderless focus recipe (1px accent core + var(--opt-focus-ring) glow)");
check(/\.regen-link:focus-visible \{ [^}]*\}/.test(popupCss) &&
  BORDERLESS_FOCUS("pp").test(popupCss.slice(popupCss.indexOf(".regen-link:focus-visible"),
    popupCss.indexOf(".regen-link:focus-visible") + 200)),
  "popup.css: .regen-link lost the §7.3 borderless focus recipe (1px accent core + var(--pp-focus-ring) glow)");
// §7.3 unification, file-wide, WHITELIST form: every hand-written
// :focus-visible rule that draws a focus indicator must match one of the
// three placements exactly. This replaced a blacklist ("no `outline: 2px
// solid var(--ns-accent)` growing outward") that the 2026-08-06 independent
// review defeated five different ways with the same visual regression --
// omit outline-offset, swap declaration order, spell it in longhands, draw
// the ring as a literal box-shadow, or delete the 1px core and keep only the
// glow. All five are the same defect and a string blacklist can only ever
// name the spellings someone already thought of (CLAUDE.md, "断言问得太窄
// 等于没门" -- ask what the simplest missed counter-example looks like).
//
// So: parse declarations instead of matching text. Comments are stripped,
// longhands folded into the shorthand, order irrelevant, and any box-shadow
// that is not literally the theme's own --{ns}-focus-ring token counts as a
// hand-drawn ring.
const FOCUS_SHAPE_EXEMPT = {
  // Selection marks, not focus indicators: no :focus-visible, and the render
  // oracle gates the ring's contrast separately via outlineContrast.
  ring: [/\.theme-preset-btn\.active/, /\.saved-theme-btn\.active/],
  // §7.3's one sanctioned bare `outline: none`: a passenger that hands its
  // indicator to the container drawing the ring on its behalf (§8 law 2).
  // Listed explicitly so "defers to container" stays a deliberate, reviewed
  // choice rather than the escape hatch every un-styled control falls into.
  defer: [
    /^\.notes-card-head:focus-visible$/,
    // The fused text input inside .vocab-group-unit: the shell draws the ring
    // for it (§8 law 2, field flavour), so the passenger must draw nothing --
    // including not falling through to Chromium's default ring.
    /^\.vocab-group-unit > input\[type="text"\]:focus, \.vocab-group-unit > input\[type="text"\]:focus-visible$/,
  ],
};
function parseFocusShape(body) {
  const d = {};
  for (const decl of body.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    d[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
  }
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const COLOR = /var\([^)]*\)|#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|color-mix\([^)]*\)|\bHighlight\b/i;
  let width = null, style = null, color = null;
  if (d.outline !== undefined) {
    const v = d.outline.trim();
    if (v === "none") { style = "none"; width = 0; }
    else {
      const w = /(-?\d*\.?\d+)px/.exec(v); if (w) width = parseFloat(w[1]);
      const s = /\b(solid|dashed|dotted|double|none)\b/.exec(v); if (s) style = s[1];
      const c = COLOR.exec(v); if (c) color = c[0];
    }
  }
  // Longhands win over the shorthand when both appear (later-wins is already
  // handled: `d` keeps the last declaration of each property).
  if (d["outline-width"] !== undefined) width = num(d["outline-width"]);
  if (d["outline-style"] !== undefined) style = d["outline-style"];
  if (d["outline-color"] !== undefined) color = d["outline-color"];
  return {
    width, style, color,
    offset: d["outline-offset"] !== undefined ? num(d["outline-offset"]) : null,
    offsetDeclared: d["outline-offset"] !== undefined,
    outlineTouched: ["outline", "outline-width", "outline-style", "outline-color"].some(k => d[k] !== undefined),
    shadow: d["box-shadow"],
    borderColor: d["border-color"],
  };
}
function forcedColorsBodyRanges(css) {
  const ranges = [];
  for (const m of css.matchAll(/@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{/g)) {
    const open = css.indexOf("{", m.index);
    let depth = 1;
    for (let i = open + 1; i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}" && --depth === 0) {
        ranges.push([open + 1, i]);
        break;
      }
    }
  }
  return ranges;
}
// ---- B+ value-box selector model (fix round 1; shared by §7.3's field core
// and the Task 2 value-box scans below). A selector is judged by its SUBJECT
// compound -- the text after the last top-level combinator -- and every
// :is()/:where() argument inside that compound is judged on its own. An
// exclusion ([type="checkbox"], <option>, a pseudo-element) therefore counts
// only when it is the subject's OWN condition: `.fg input:not([type=
// "checkbox"])` is still a text box, and `.fg :is(input[type="checkbox"],
// textarea)` still reaches the textarea. Value boxes addressed by id count
// too: the ids come from the text-entry controls options.html ships, plus
// each data-listbox select's runtime `<id>-btn` button (listbox.js).
// Search inputs count too (stage 4, spec 2026-09-30-ui-fields-stage4-design
// §3.1): the sidebar search box joined the field family -- rest and focus;
// it has no hover by design -- so every value-box scan below reads it.
const TEXT_ENTRY_TYPES = new Set(["text", "password", "number", "search", "url", "email", "tel"]);
// closeOfBracket / cmpSpecificity / selectorSpecificity are imported from
// css-syntax.mjs, the one Selectors-4 engine shared with cascade-lint (stage 4
// T0); only the subject model below is local to this file.
function subjectOf(sel) {
  let start = 0;
  for (let i = 0; i < sel.length; i += 1) {
    const ch = sel[i];
    if (ch === "(" || ch === "[") { i = closeOfBracket(sel, i); continue; }
    if (ch === " " || ch === ">" || ch === "+" || ch === "~") start = i + 1;
  }
  return sel.slice(start).trim();
}
function subjectAlternatives(compound) {
  for (let i = 0; i < compound.length; i += 1) {
    if (compound[i] === "[") { i = closeOfBracket(compound, i); continue; }
    const fn = compound.startsWith(":is(", i) ? 4 : compound.startsWith(":where(", i) ? 7 : 0;
    if (fn) {
      const close = closeOfBracket(compound, i + fn - 1);
      const head = compound.slice(0, i), tail = compound.slice(close + 1);
      return splitSelectorList(compound.slice(i + fn, close))
        .flatMap((arg) => subjectAlternatives(head + subjectOf(arg) + tail));
    }
    if (compound[i] === "(") i = closeOfBracket(compound, i); // :not(...) & co. stay intact
  }
  return [compound];
}
function classifyCompound(compound) {
  let own = "";
  for (let i = 0; i < compound.length; i += 1) {
    if (compound[i] === "(") { i = closeOfBracket(compound, i); continue; } // drop :not(...) etc. arguments
    if (compound[i] === "[") { const close = closeOfBracket(compound, i); own += compound.slice(i, close + 1); i = close; continue; }
    own += compound[i];
  }
  const bare = own.replace(/\[[^\]]*\]/g, "");
  return {
    tag: ((/^([a-zA-Z][\w-]*)/.exec(own) || [])[1] || "").toLowerCase() || null,
    type: ((/\[\s*type\s*=\s*["']?([\w-]+)["']?\s*(?:[iIsS]\s*)?\]/.exec(own) || [])[1] || "").toLowerCase() || null,
    ids: [...bare.matchAll(/#([\w-]+)/g)].map((m) => m[1]),
    classes: [...bare.matchAll(/\.([\w-]+)/g)].map((m) => m[1]),
    pseudoElement: /::|:(?:before|after|first-line|first-letter)\b/.test(bare),
  };
}
const OPTIONS_VALUE_BOX_IDS = (() => {
  const ids = new Set(), selectIds = new Set();
  for (const m of optionsHtml.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase(), attrs = m[2];
    const id = (/\bid="([^"]+)"/.exec(attrs) || [])[1];
    if (!id) continue;
    if (tag === "input" && !TEXT_ENTRY_TYPES.has(((/\btype="([^"]+)"/.exec(attrs) || [])[1] || "text").toLowerCase())) continue;
    ids.add(id);
    if (tag === "select") {
      selectIds.add(id);
      if (/\sdata-listbox\b/.test(attrs)) ids.add(`${id}-btn`);
    }
  }
  return { ids, selectIds };
})();
check(OPTIONS_VALUE_BOX_IDS.ids.has("dict-anki-deck") && OPTIONS_VALUE_BOX_IDS.ids.has("opt-custom-css") && OPTIONS_VALUE_BOX_IDS.ids.has("opt-lang-btn") &&
  OPTIONS_VALUE_BOX_IDS.selectIds.has("mobile-tab-select") && OPTIONS_VALUE_BOX_IDS.ids.has("options-search-input") && OPTIONS_VALUE_BOX_IDS.ids.size > 60,
  "ui-contract-tests.mjs: the options.html value-box id harvest drifted (expected text/password/number/search inputs, textareas, selects and their -btn listbox buttons) -- got " + OPTIONS_VALUE_BOX_IDS.ids.size + " ids");
// ---- Stage 4 Task 7: library's value boxes (spec 2026-09-30-ui-fields-stage4-
// design §1.2 / §3.3). Static ones are harvested from library.html: every
// text-entry input (TEXT_ENTRY_TYPES, search included), textarea and select
// that carries an id and is not one of the `hidden` state carriers
// (#vocab-status-filter / #vocab-sort are driven by chip / segment proxies and
// never render). Runtime ones are the elements library-vocab.js builds -- the
// note editor (.vocab-note-input), the relookup language select
// (.xp-dict-lang) and the detail pane's group-unit text input -- harvested
// from every createElement("input" | "select" | "textarea") site of the
// library scripts and pinned below, so a new runtime value box fails here
// instead of silently escaping the class-level scans. The fused shell
// .vocab-group-unit is its unit's value box (COMPONENTS.md §8 law 1); its
// children are passengers.
const LIBRARY_VALUE_BOX = (() => {
  const ids = new Set();
  for (const m of libraryHtml.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase(), attrs = m[2];
    const id = (/\bid="([^"]+)"/.exec(attrs) || [])[1];
    if (!id || /\shidden(?=[\s/]|$)/.test(attrs)) continue;
    if (tag === "input" && !TEXT_ENTRY_TYPES.has(((/\btype="([^"]+)"/.exec(attrs) || [])[1] || "text").toLowerCase())) continue;
    ids.add(id);
  }
  const built = [];
  for (const file of ["library-vocab.js", "library-notes.js", "library.js"]) {
    for (const m of read(file).matchAll(/const (\w+) = document\.createElement\("(input|select|textarea)"\);([\s\S]{0,400})/g)) {
      const [, v, tag, after] = m;
      const cls = (new RegExp(`\\b${v}\\.className = "([^"]+)"`).exec(after) || [])[1];
      const type = (new RegExp(`\\b${v}\\.type = "([^"]+)"`).exec(after) || [])[1];
      built.push(`${file}:${tag}${type ? `[type="${type}"]` : ""}${cls ? `.${cls}` : ""}`);
    }
  }
  // The fused shell is named by class: it is a <span>, invisible to a tag harvest.
  const shells = new Set(["vocab-group-unit"]);
  const classOf = (b) => (/\.([\w-]+)$/.exec(b) || [])[1];
  return {
    ids, built: built.sort(), shells,
    classes: new Set([...shells, ...built.map(classOf).filter(Boolean)]),
    selectClasses: new Set(built.filter((b) => /:select\./.test(b)).map(classOf)),
  };
})();
check(JSON.stringify([...LIBRARY_VALUE_BOX.ids].sort()) === JSON.stringify(["notes-filter", "vocab-group-filter", "vocab-group-input", "vocab-lookup-input", "vocab-lookup-lang", "vocab-search"]),
  `ui-contract-tests.mjs: the library.html value-box id harvest drifted -- got ${JSON.stringify([...LIBRARY_VALUE_BOX.ids].sort())}. ` +
  "A new value box must join composers/ui-components.mjs FIELD_TARGETS.lib and scripts/ui-render-audit.mjs's VALUE_BOX_LEGS.library in the same commit; then update this list.");
check(JSON.stringify(LIBRARY_VALUE_BOX.built) === JSON.stringify(['library-vocab.js:input[type="text"]', "library-vocab.js:select.xp-dict-lang", "library-vocab.js:textarea.vocab-note-input"]) &&
  /groupUnit\.className = "vocab-group-unit";[\s\S]{0,400}groupUnit\.appendChild\(groupInput\);/.test(libraryVocabJs),
  `ui-contract-tests.mjs: the runtime library value-box harvest drifted -- got ${JSON.stringify(LIBRARY_VALUE_BOX.built)} ` +
  "(expected the note editor textarea, the relookup language select and the detail pane's group-unit text input). " +
  "A new runtime value box must join FIELD_TARGETS.lib and VALUE_BOX_LEGS.library; then update this list.");
function isValueBoxCompound(compound) {
  const c = classifyCompound(compound);
  if (c.pseudoElement || c.tag === "option") return false;
  if (c.ids.some((id) => OPTIONS_VALUE_BOX_IDS.ids.has(id)) || c.classes.includes("listbox-btn")) return true;
  if (c.ids.some((id) => LIBRARY_VALUE_BOX.ids.has(id)) || c.classes.some((cl) => LIBRARY_VALUE_BOX.classes.has(cl))) return true;
  if (c.tag === "textarea" || c.tag === "select") return true;
  return c.tag === "input" && (c.type === null || TEXT_ENTRY_TYPES.has(c.type));
}
function isValueBoxSelector(sel) { return subjectAlternatives(subjectOf(sel)).some(isValueBoxCompound); }
// The placeholder pseudo-element OF a value box (follow-up 7a): the subject
// compound minus its ::placeholder (or the legacy ::-webkit-input-placeholder)
// must itself be a value box. Since stage 4 the search box is in too
// (TEXT_ENTRY_TYPES above); its placeholder consumer is also pinned by name
// in the Task 1 block (G1).
const PLACEHOLDER_PSEUDO_RE = /::(?:-webkit-input-)?placeholder\b/;
function isValueBoxPlaceholderSelector(sel) {
  return subjectAlternatives(subjectOf(sel)).some((compound) =>
    PLACEHOLDER_PSEUDO_RE.test(compound) && isValueBoxCompound(compound.replace(PLACEHOLDER_PSEUDO_RE, "")));
}
function isNativeSelectSelector(sel) {
  return subjectAlternatives(subjectOf(sel)).some((compound) => {
    const c = classifyCompound(compound);
    return !c.pseudoElement && (c.tag === "select" || c.ids.some((id) => OPTIONS_VALUE_BOX_IDS.selectIds.has(id)));
  });
}
// §7.3's --opt-field-border-focus core belongs to value boxes and to the
// key-wrap eye that sits on a value box's fill -- nothing else (GI-5). Every
// selector of the rule's list must qualify. Stricter than isValueBoxCompound
// on one point (final fix wave, T2 minor): a TYPELESS `input` subject does
// not qualify here -- `.pick > input:focus-visible` / `.switch > input` style
// overlays are radio/checkbox inputs whose type lives in the HTML, not the
// selector -- so the field core needs an explicit text-like [type], an
// options.html value-box id, .listbox-btn, a textarea or a select.
function isTypedValueBoxCompound(compound) {
  if (!isValueBoxCompound(compound)) return false;
  const c = classifyCompound(compound);
  return !(c.tag === "input" && c.type === null && !c.ids.some((id) => OPTIONS_VALUE_BOX_IDS.ids.has(id)));
}
function acceptsFieldFocusCore(selectorText) {
  const list = splitSelectorList(selectorText);
  return list.length > 0 && list.every((sel) => subjectAlternatives(subjectOf(sel)).some(isTypedValueBoxCompound) ||
    subjectAlternatives(subjectOf(sel)).some((compound) => { const c = classifyCompound(compound); return !c.pseudoElement && c.classes.includes("key-toggle"); }));
}
// The model itself must discriminate, or every scan built on it is blind.
check(isValueBoxSelector('.fg input:not([type="checkbox"])') && isValueBoxSelector('.fg :is(input[type="checkbox"], textarea)') &&
  isValueBoxSelector("#dict-anki-deck") && isValueBoxSelector("#opt-lang-btn:hover") && isValueBoxSelector('.entry-block input[type="text"]') &&
  !isValueBoxSelector('.fg input[type="checkbox"]') && !isValueBoxSelector(".fg select::picker(select)") && !isValueBoxSelector(".fg option") &&
  !isValueBoxSelector(".listbox-btn .btn-ic") && isValueBoxSelector('.options-search input[type="search"]') &&
  acceptsFieldFocusCore('.options-search input[type="search"]:focus-visible') &&
  cmpSpecificity(selectorSpecificity('.fg input[type="text"]:hover:not(:focus, :disabled)'), [0, 4, 1]) === 0 &&
  !isValueBoxSelector("input:hover:not(:disabled) + .tag-gov-chip-face") && !isValueBoxSelector(".fg input::placeholder") &&
  isNativeSelectSelector(".mobile-tab-picker select:hover:not(:focus)") && isNativeSelectSelector("#mobile-tab-select") && !isNativeSelectSelector(".listbox-btn") &&
  acceptsFieldFocusCore(".key-toggle:focus-visible") && !acceptsFieldFocusCore(".btn:focus-visible") &&
  !acceptsFieldFocusCore(".listbox-btn:focus-visible, .btn:focus-visible") &&
  !acceptsFieldFocusCore(".pick > input:focus-visible") && !acceptsFieldFocusCore(".switch > input:focus-visible") &&
  acceptsFieldFocusCore('.fg input[type="text"]:focus') && acceptsFieldFocusCore("#dict-anki-deck:focus") &&
  acceptsFieldFocusCore(".fg textarea:focus") && isValueBoxSelector(".pick > input:focus-visible") &&
  cmpSpecificity(selectorSpecificity('html[data-theme] .theme-name-popover input[type="text"]'), [0, 3, 2]) === 0 &&
  cmpSpecificity(selectorSpecificity('.fg :is(input[type="text"], textarea):hover:not(:focus)'), [0, 4, 1]) === 0 &&
  cmpSpecificity(selectorSpecificity(".fg input:hover:not(:focus)"), [0, 3, 1]) === 0 &&
  cmpSpecificity(selectorSpecificity("#opt-custom-css.over-limit"), [1, 1, 0]) === 0 &&
  cmpSpecificity(selectorSpecificity(".x:where(.a .b) p::before"), [0, 1, 2]) === 0,
  "ui-contract-tests.mjs: the B+ value-box selector model (subject compound / :is() arguments / ids / specificity) no longer discriminates");
// The scan is a function (P12, B+ field family 2026-09-28) so its widening
// below can be run against synthetic CSS, not only the shipped files.
function focusShapeOffenders(css, ns) {
  const hand = stripGeneratedRegions(css).replace(/\/\*[\s\S]*?\*\//g, "");
  const forcedColorsRanges = forcedColorsBodyRanges(hand);
  const rules = [];
  for (const m of hand.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({
      selector: m[1].trim().replace(/\s+/g, " "),
      body: m[2],
      forcedColors: forcedColorsRanges.some(([start, end]) => m.index >= start && m.index < end),
    });
  }
  // Partners -- the `:focus` rule that carries a glow-only rule's core --
  // are looked up in the WHOLE file, generated regions included (stage 4
  // Task 6, spec §5.1): popup's value-box cores live in FIELD_TARGETS.pp's
  // generated focus rules, and a partner map that could not see them would
  // reject every popup glow. Only hand rules are CHECKED; bodies of equal
  // selector lists merge.
  const bySelector = new Map();
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, " ");
    bySelector.set(sel, `${bySelector.get(sel) ?? ""};${m[2]}`);
  }
  // Stage 4 (spec §5.1, Task 7 T7-d): a value box's focus border now lives in
  // @generated:ui-components (composers/ui-components.mjs FIELD_TARGETS) and
  // the hand rule keeps only the glow / outline suppression. So a hand rule is
  // judged on the generated declarations of the SAME selector text merged
  // under its own (hand wins, as in the cascade: it comes later) -- library's
  // .xp-dict-lang suppresses its outline on the very selector whose generated
  // rule paints the core -- and a glow-only rule's :focus partner is looked up
  // in both regions (bySelector above already reads the whole file).
  const generatedBySelector = new Map();
  for (const region of css.matchAll(/\/\*\s*@generated:([\w-]+) start[\s\S]*?\*\/([\s\S]*?)\/\*\s*@generated:\1 end[\s\S]*?\*\//g)) {
    for (const m of region[2].replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().replace(/\s+/g, " ");
      generatedBySelector.set(sel, `${generatedBySelector.get(sel) ?? ""};${m[2]}`);
    }
  }
  const RING = `var(--${ns}-focus-ring)`, BD = `var(--${ns}-focus-bd)`, ACCENT = `var(--${ns}-accent)`;
  // Stage 4 end state (Tasks 6/7): every surface's value boxes carry their own
  // derived focus border, var(--<ns>-field-border-focus) (= focus-bd wherever
  // that clears 3:1 on the field fill; re-derived where it does not -- options
  // flexoki-light). Accepted as a `bordered` / glow-partner core, and as the
  // eye's `inset` core, only on VALUE-BOX selectors (fix round 1, GI-5) and
  // only in its OWN namespace: another namespace's literal is still a leak.
  const FIELD_CORE = `var(--${ns}-field-border-focus)`;
  const coresFor = (selector) => (acceptsFieldFocusCore(selector) ? [BD, FIELD_CORE] : [BD]);
  const coreReFor = (cores) => new RegExp(`border-color:\\s*(?:${cores.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`);
  const bad = [];
  for (const { selector, body, forcedColors } of rules) {
    // A forced-colours focus adaptation keyed on a fused shell's
    // :focus-within (popup's tags shell / token field, stage 4 R5) is judged
    // by the forced-colours branch below like a :focus-visible one.
    if (!/:focus-visible/.test(selector) && !(forcedColors && /:focus-within\b/.test(selector))) continue;
    if (FOCUS_SHAPE_EXEMPT.ring.some(re => re.test(selector))) continue;
    const BORDERED_CORES = coresFor(selector), INSET_CORES = BORDERED_CORES, coreRe = coreReFor(BORDERED_CORES);
    const s = parseFocusShape(`${generatedBySelector.get(selector) ?? ""};${body}`);
    const drawsOutline = s.style && s.style !== "none" && s.width > 0;
    const suppressesOutline = s.outlineTouched && (s.style === "none" || s.width === 0);
    const fail = (why) => bad.push(`${selector} — ${why}`);
    if (forcedColors) {
      // In forced-colours mode author shadows are suppressed and authored
      // colours are remapped. Keep the normal §7.3 recipe in the base rule,
      // then restore one structural edge with a system colour here. This is
      // deliberately context-gated: the same spelling outside this media
      // query is still rejected by the three-placement whitelist below.
      if (!drawsOutline) fail("forced-colors focus adaptation must draw a system-colour outline");
      else if (s.width !== 1) fail(`forced-colors outline must be 1px, got ${s.width}px`);
      else if (s.style !== "solid") fail(`forced-colors outline must be solid, got ${s.style}`);
      else if (!/^Highlight$/i.test(s.color || "")) fail(`forced-colors outline must use Highlight, got ${s.color}`);
      else if (!s.offsetDeclared || s.offset < 0) fail(`forced-colors outline must declare a non-negative offset, got ${s.offset}`);
      else if (s.shadow !== undefined && s.shadow !== "none") fail(`forced-colors adaptation must not draw an authored shadow, got ${s.shadow}`);
      continue;
    }
    if (drawsOutline) {
      // Placement is decided by the SIGN of the offset, so an omitted offset
      // is not a cosmetic slip: it silently becomes 0 and turns `inset` into
      // an outward ring.
      if (!s.offsetDeclared) { fail("draws an outline with no outline-offset (0 by default flips inset into an outward ring)"); continue; }
      if (s.offset >= 0) {
        if (s.width !== 1) fail(`borderless core must be 1px, got ${s.width}px`);
        else if (s.color !== ACCENT) fail(`borderless core must be ${ACCENT}, got ${s.color}`);
        else if (s.shadow !== RING) fail(`borderless needs the ${RING} glow, got ${s.shadow === undefined ? "no box-shadow" : s.shadow}`);
      } else {
        if (!(s.width >= 2)) fail(`inset core must be >=2px, got ${s.width}px`);
        else if (!INSET_CORES.includes(s.color)) fail(`inset core must be ${INSET_CORES.join(" or ")}, got ${s.color}`);
        else if (s.shadow !== "none") fail(`inset must suppress box-shadow (the .btn family's glow leaks across a fused seam and stacks on the core), got ${s.shadow === undefined ? "no box-shadow declaration" : s.shadow}`);
      }
    } else if (suppressesOutline) {
      if (BORDERED_CORES.includes(s.borderColor) && s.shadow === RING) continue;             // bordered
      if (!s.borderColor && s.shadow === undefined
          && FOCUS_SHAPE_EXEMPT.defer.some(re => re.test(selector))) continue; // §8 law 2 passenger
      fail(`suppresses the outline without the bordered pair (border-color: ${BORDERED_CORES.join(" or ")} + box-shadow: ${RING}); got border-color=${s.borderColor} shadow=${s.shadow}`);
    } else if (s.shadow !== undefined && s.shadow !== "none") {
      // No outline of its own. Legal only as the glow half of `bordered`,
      // whose core lives on the matching :focus rule -- and only as the TOKEN,
      // never a literal (a literal here is the box-shadow spelling of a hard
      // ring, which is what defeated the previous blacklist).
      if (s.shadow !== RING) { fail(`box-shadow focus ring must be ${RING}, got ${s.shadow}`); continue; }
      if (BORDERED_CORES.includes(s.borderColor)) continue;                                   // themed bordered twin
      const partnerSel = selector.replaceAll(":focus-visible", ":focus");
      const partner = [generatedBySelector.get(partnerSel), bySelector.get(partnerSel)].filter(Boolean).join(";") || undefined;
      if (!partner || !coreRe.test(partner)) {
        fail(`glow with no core — needs either border-color: ${BORDERED_CORES.join(" or ")} here, or the matching :focus rule to set it`);
      }
    }
  }
  return bad;
}
for (const [file, css, ns] of [["popup.css", popupCss, "pp"], ["options.css", optionsCss, "opt"], ["library.css", libraryCss, "lib"]]) {
  const bad = focusShapeOffenders(css, ns);
  check(bad.length === 0,
    `${file}: hand-written focus rule(s) do not match any §7.3 placement (bordered / borderless / inset):\n    ${bad.join("\n    ")}`);
}
// P12 discrimination for the field-core widening, on synthetic CSS (value-box
// selectors throughout, so a rejection below is about the CORE, not the
// selector). Stage 4 end state: every surface accepts ITS OWN derived focus
// border, var(--<ns>-field-border-focus), as a bordered core (on the rule
// itself or on the :focus partner of a glow-only rule) and as an inset core
// (the eye). A foreign namespace's literal is still a leak (fix round 1
// T2-Q1: a popup/library rule borrowing the options token, and the reverse),
// a non-focus core (--opt-border) plus the ring is still rejected, and so is
// the field core on a non-value-box selector (fix round 1 GI-5: .btn).
// Stage 4 Task 7 (T7-d): the same-selector merge -- a hand rule that only
// suppresses the outline and adds the glow passes on the core its OWN
// selector's generated rule paints, and fails once that generated rule is gone.
{
  const focusCss = (ns, core) => `.fg input[type="text"]:focus-visible { outline: none; border-color: ${core}; box-shadow: var(--${ns}-focus-ring); }
.theme-name-popover input[type="text"]:focus { outline: none; border-color: ${core}; }
.theme-name-popover input[type="text"]:focus-visible { box-shadow: var(--${ns}-focus-ring); }
.key-toggle:focus-visible { outline: 2px solid ${core}; outline-offset: -2px; box-shadow: none; }
`;
  const WANT = ['.fg input[type="text"]:focus-visible', '.theme-name-popover input[type="text"]:focus-visible', ".key-toggle:focus-visible"];
  const allRejected = (bad) => bad.length === 3 && WANT.every((sel, i) => bad[i].startsWith(sel + " "));
  for (const ns of ["opt", "pp", "lib"]) {
    const ownBad = focusShapeOffenders(focusCss(ns, `var(--${ns}-field-border-focus)`), ns);
    check(ownBad.length === 0,
      `ui-contract-tests.mjs: §7.3 no longer accepts var(--${ns}-field-border-focus) as the ${ns} bordered / glow-partner / inset core on value boxes: ` + ownBad.join(" | "));
    for (const foreign of ["opt", "pp", "lib"].filter((other) => other !== ns)) {
      const leakBad = focusShapeOffenders(focusCss(ns, `var(--${foreign}-field-border-focus)`), ns);
      check(allRejected(leakBad),
        `ui-contract-tests.mjs: §7.3 accepts the ${foreign} field core var(--${foreign}-field-border-focus) in the ${ns} namespace (expected all three value-box rules rejected) -- got [${leakBad.join(" | ")}]`);
    }
  }
  const generatedCore = (core) => `/* @generated:ui-components start (library) */
.xp-dict-lang:focus-visible:not(:disabled) { background-color: var(--lib-field-bg-focus); border-color: ${core}; }
.vocab-note-input:focus:not(:disabled) { background-color: var(--lib-field-bg-focus); border-color: ${core}; }
/* @generated:ui-components end (library) */
.xp-dict-lang:focus-visible:not(:disabled) { outline: none; box-shadow: var(--lib-focus-ring); }
.vocab-note-input:focus-visible:not(:disabled) { box-shadow: var(--lib-focus-ring); }
`;
  const mergedOwn = focusShapeOffenders(generatedCore("var(--lib-field-border-focus)"), "lib");
  const mergedForeign = focusShapeOffenders(generatedCore("var(--opt-field-border-focus)"), "lib");
  const mergedNone = focusShapeOffenders(generatedCore("var(--lib-field-border)").replace(/border-color: var\(--lib-field-border\); /g, ""), "lib");
  check(mergedOwn.length === 0 && mergedForeign.length === 2 && mergedNone.length === 2,
    "ui-contract-tests.mjs: §7.3's same-selector generated merge no longer discriminates (a hand outline-suppressor / glow must pass on its own or its :focus partner's GENERATED lib field core, and fail on a foreign or missing one) -- got " +
    JSON.stringify({ own: mergedOwn, foreign: mergedForeign, none: mergedNone }));
  const frameBad = focusShapeOffenders(focusCss("opt", "var(--opt-border)"), "opt");
  check(allRejected(frameBad),
    "ui-contract-tests.mjs: §7.3 accepts a non-focus core (--opt-border + ring) on options value boxes -- got [" + frameBad.join(" | ") + "]");
  const btnBad = focusShapeOffenders(`.btn:focus-visible { outline: none; border-color: var(--opt-field-border-focus); box-shadow: var(--opt-focus-ring); }
.tab-btn:focus { outline: none; border-color: var(--opt-field-border-focus); }
.tab-btn:focus-visible { box-shadow: var(--opt-focus-ring); }
.pick-mark:focus-visible { outline: 2px solid var(--opt-field-border-focus); outline-offset: -2px; box-shadow: none; }
`, "opt");
  check(btnBad.length === 3 && [".btn:focus-visible ", ".tab-btn:focus-visible ", ".pick-mark:focus-visible "].every((sel, i) => btnBad[i].startsWith(sel)),
    "ui-contract-tests.mjs: §7.3 accepts var(--opt-field-border-focus) on a non-value-box selector (GI-5: the field core is for value boxes and the key-wrap eye only) -- got [" + btnBad.join(" | ") + "]");
}
// The two same-specificity deletions this sweep made must stay deleted --
// both were measured, not eyeballed (CLAUDE.md's two-way cascade rule).
// .lib-tab had TWO (0,2,0) :focus-visible rules; the later one won `outline`
// while the earlier kept supplying `box-shadow`, shipping a hard rectangle
// with a glow behind it. .vocab-sort-seg's shell ring fired on mouse-down
// (`:focus-within` has no keyboard gate) and stacked outside the cell ring.
// Flat window-filling page (library redesign spec 2026-10-03 §2.3-§2.4; the
// 2026-08-06 fixed 1164px canvas is overturned, §0.2): one index column and
// one detail column on the page itself, two scroll containers per tab and
// nothing else that scrolls. What the source can show is pinned here, one
// assertion per load-bearing piece; the render oracle's noPageScroll / libAxis
// states measure the composed result.
{
  const hand = stripGeneratedRegions(libraryCss);
  const live = hand.replace(/\/\*[\s\S]*?\*\//g, "");
  const decl = (selector) => declarationValueMap(hand, selector);
  check(!/--lib-canvas-max|--lib-header-h/.test(live),
    "library.css: --lib-canvas-max / --lib-header-h are back — the page fills the window (there is no canvas to centre in) and nothing is offset by a measured header height any more (it had drifted 1.7px from the real header)");
  const header = decl(".lib-header");
  check(header.get("flex") === "none" && header.get("padding") === "var(--lib-sp-4) var(--lib-page-pad) var(--lib-sp-5)" &&
    !header.has("position") && !header.has("background") && !header.has("border-bottom"),
    `library.css: .lib-header must be a flat flex: none row padded var(--lib-sp-4) var(--lib-page-pad) var(--lib-sp-5) — no sticky, no fill, no rule; got ${JSON.stringify(Object.fromEntries(header))}`);
  const html = decl("html"), body = decl("body");
  check(html.get("height") === "100%" && body.get("height") === "100%" && body.get("display") === "flex" && body.get("flex-direction") === "column",
    "library.css: the body flex chain is gone (html, body { height: 100% } + body { display: flex; flex-direction: column }) — without a definite height the two scroll containers grow with their content and the page scrolls instead");
  for (const sel of [".lib-main", ".lib-view"]) {
    const m = decl(sel);
    check(m.get("flex") === "1 1 auto" && m.get("min-height") === "0" && m.get("display") === "flex" && m.get("flex-direction") === "column",
      `library.css: ${sel} must hand the window height down (flex: 1 1 auto; min-height: 0; a column flex box)`);
  }
  check(decl(".lib-view[hidden]").get("display") === "none",
    "library.css: .lib-view[hidden] lost display: none — .lib-view's own display: flex outranks the UA [hidden] rule and both tabs render at once");
  for (const bench of [".vocab-workbench", ".notes-workbench"]) {
    const m = decl(bench);
    check(m.get("grid-template-columns") === "var(--lib-index-w) minmax(0, 1fr)" && m.get("column-gap") === "var(--lib-gap)" &&
      m.get("padding-inline-start") === "var(--lib-page-pad)" && m.get("min-height") === "0" && !m.has("align-items") && !m.has("justify-content"),
      `library.css: ${bench} lost the index + detail grid (var(--lib-index-w) minmax(0, 1fr), column-gap var(--lib-gap), start gutter var(--lib-page-pad), stretched and never centred) — got ${JSON.stringify(Object.fromEntries(m))}`);
  }
  for (const region of [".vocab-list-region", ".notes-list-region"]) {
    const m = decl(region);
    check(m.get("overflow-y") === "auto" && m.get("scrollbar-gutter") === "stable" && m.get("min-height") === "0" &&
      /var\(--lib-sb-w, /.test(m.get("margin-inline") || ""),
      `library.css: ${region} must be the list's own scroll container (overflow-y auto, scrollbar-gutter stable, min-height 0) and bleed into the gap by the measured scrollbar (--lib-sb-w)`);
  }
  for (const pane of [".vocab-detail-pane", ".notes-detail-pane"]) {
    const m = decl(pane);
    const drawn = ["background", "border", "border-radius", "box-shadow", "max-height", "top", "position", "justify-content"].filter((p) => m.has(p));
    check(m.get("overflow-y") === "auto" && m.get("container-type") === "inline-size" && m.get("container-name") === "lib-detail" && drawn.length === 0,
      `library.css: ${pane} must be its own scroll container and the lib-detail size container — never sticky, centred or a drawn panel; stray: ${drawn.join(", ") || "none"}`);
  }
  check(![...decl(".lib-section").keys()].some((p) => p.startsWith("border")),
    "library.css: .lib-section draws a rule again — sections on the flat page are divided by space and type, never by a line (user ruling 2026-10-03)");
  // The reading measure belongs to the detail column, not to each child: a
  // child that carries its own cap re-creates the left-hugging prose the pane
  // column replaced.
  const paneChildCaps = (libraryCss.match(/\.(notes-detail-quote|notes-detail-note|vocab-detail-gloss|vocab-detail-context|vocab-note-edit)\b[^{}]*\{[^}]*max-width:\s*6[68]ch/g) || []);
  check(paneChildCaps.length === 0,
    `library.css: per-child reading-measure caps are back inside the detail panes — the detail column already sets the measure: ${paneChildCaps.join(" | ")}`);
  // Prose that keeps its own newlines (`white-space: pre-wrap`) sits in a
  // detail column that shrinks rather than widens, so an unbreakable run — a
  // data URI, a hash, a long identifier lifted out of a code block — paints
  // straight past the pane unless the rule also names a break policy. Asked as
  // a CATEGORY ("every pre-wrap/pre-line rule in the hand layer"), not as the
  // selectors that carry it today.
  const unbrokenProse = [...live.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => /white-space:\s*pre-(wrap|line)/.test(body) && !/overflow-wrap:\s*anywhere/.test(body))
    .map(([, sel]) => sel.trim().split("\n").pop().trim());
  check(unbrokenProse.length === 0,
    `library.css: a pre-wrap prose rule declares no break policy — inside the detail column an unbreakable run overflows the pane instead of wrapping: ${unbrokenProse.join(" | ")}`);
  // The five colour-filter dots are real <button>s (library-notes.js), the one
  // interactive family on this page that used to fall through to the UA focus
  // ring. The ring must also be legible in the OFF state, and `outline` paints
  // at its own element's opacity, so the "filtered out" dimming belongs on the
  // swatch inside the button, never on the button itself. (T4 replaces these
  // dots with .lib-toggle and rewrites both checks.)
  check(/\.notes-filter-dot:focus-visible \{/.test(libraryCss),
    "library.css: .notes-filter-dot has no :focus-visible rule — the colour dots fall back to the UA default ring while every neighbouring family declares a themed one");
  check(!/\.notes-filter-dot\[aria-pressed="false"\]\s*\{[^}]*opacity/.test(libraryCss) &&
    /\.notes-filter-dot\[aria-pressed="false"\] \.note-dot \{[^}]*opacity/.test(libraryCss),
    "library.css: the colour dot's off-state opacity is back on the BUTTON — a focus ring paints at its own element's opacity (border and box-shadow alike), so it would render at a third strength on exactly the dots a keyboard user is about to re-enable");
  // Both panes end the same way: one closing row, destructive action pushed
  // to its right end. (The footers' class names move off .lib-section in T7 /
  // T8, which rewrite the two className halves of this check.)
  check(/\.vocab-detail-footer > \.vocab-detail-delete,\s*\n\.notes-detail-footer > \.notes-detail-delete \{ margin-left: auto; \}/.test(libraryCss) &&
    /footer\.className = "lib-section vocab-detail-footer"/.test(libraryVocabJs) &&
    /footer\.className = "lib-section notes-detail-footer"/.test(read("library-notes.js")),
    "library.css/library-{vocab,notes}.js: the detail panes' shared closing action row is gone or asymmetric");
}
// Flat canvas (library redesign 2026-10-03, user ruling: "不要用色块分隔，
// 强行制造视觉束缚分区"): the page skeleton paints nothing of its own -- no
// fill but the page's, no line, no shadow, no outline outside a keyboard
// focus. Sections are divided by type, space, column alignment, hanging
// labels and section heads. The class list is read from the registry key the
// gate consumes, so a skeleton class registered later is covered the moment
// it is registered (T4 / T7 / T8 append theirs). Interactive primitives
// (.lib-toggle, .lib-mark, row fills) and the list-box family are not
// skeleton and are not listed.
{
  const registry = JSON.parse(read("docs/theme-surface/ui-vocabulary.json"));
  const structures = registry.surfaces?.library?.canvasStructures;
  const T3_SKELETON = ["lib-header", "vocab-workbench", "notes-workbench", "vocab-list-region", "notes-list-region", "vocab-detail-pane", "notes-detail-pane", "lib-section", "lib-block"];
  check(Array.isArray(structures) && T3_SKELETON.every((c) => structures.includes(c)),
    `ui-vocabulary.json: library.canvasStructures must list the page skeleton (at least ${T3_SKELETON.join(", ")}) — got ${JSON.stringify(structures)}`);
  const skeleton = new Set(Array.isArray(structures) ? structures : []);
  const BACKGROUND_OK = new Set(["var(--lib-bg)", "transparent", "none"]);
  const offenders = [];
  let subjects = 0;
  for (const rule of parseStyleRules(stripGeneratedRegions(libraryCss))) {
    const declarations = parseDeclarations(rule.body);
    for (const selector of rule.selectors) {
      const isSkeleton = subjectAlternatives(subjectOf(selector)).some((compound) => {
        const { classes, ids } = classifyCompound(compound);
        return classes.some((c) => skeleton.has(c)) || ids.some((id) => skeleton.has(id));
      });
      if (!isSkeleton) continue;
      subjects += 1;
      const focus = /:focus-visible/.test(selector);
      for (const { property, value } of declarations) {
        const paints =
          (/^background(-color)?$/.test(property) && !BACKGROUND_OK.has(value)) ||
          (property === "background-image" && value !== "none") ||
          (/^border(-|$)/.test(property) && !/^(0|none)$/.test(value)) ||
          (property === "box-shadow" && value !== "none") ||
          (/^outline(-|$)/.test(property) && !focus && !/^(0|none)$/.test(value));
        if (paints) offenders.push(`${selector} { ${property}: ${value} }${rule.context.length ? ` in ${rule.context.join(" > ")}` : ""}`);
      }
    }
  }
  check(subjects >= 10,
    `ui-contract-tests.mjs: the flat-canvas gate matched only ${subjects} hand-written skeleton selector(s) — the subject model or the registry key broke, and an empty scan passes anything`);
  check(offenders.length === 0,
    `library.css: the page skeleton paints a surface, a line or a shadow (flat canvas, user ruling 2026-10-03 — divide with type, space, column alignment, hanging labels and section heads instead): ${offenders.join(" | ")}`);
}
// Narrow back button (library redesign §2.6, user ruling 10-03): a ghost sm
// button with Lucide v0.525.0 arrow-left in both views. `cross` belongs to the
// delete / remove / close family, and "back to the list" is not a close.
{
  const backAt = libraryHtml.indexOf('id="vocab-detail-back"');
  const backTag = backAt < 0 ? "" : libraryHtml.slice(libraryHtml.lastIndexOf("<button", backAt), libraryHtml.indexOf("</button>", backAt));
  const notesSrc = read("library-notes.js");
  check(sharedJs.includes(`arrowLeft: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>'`) &&
    backTag.includes('class="btn btn-sm ghost vocab-detail-back"') && backTag.includes('data-ic="arrowLeft"') &&
    notesSrc.includes('back.className = "btn btn-sm ghost notes-detail-back";') &&
    notesSrc.includes('setBtnIcon(back, "arrowLeft", t("libraryBack"));'),
    "shared.js/library.html/library-notes.js: the narrow back button is not a ghost Lucide arrow-left (v0.525.0, 14px) in both views");
}
// Scrollbar gutter (library redesign §2.4, Review Focus 1): measured into
// --lib-sb-w at load AND again whenever it can change while the page is open
// -- a window resize / page zoom, and the two <html> attributes another tab's
// theme switch rewrites. Behaviour is measured by the render oracle's libAxis
// state; this pins the wiring it depends on.
{
  const libraryJsSrc = read("library.js");
  const measure = (libraryJsSrc.split("function pbpLibMeasureScrollbar() {")[1] || "").split("\n}\n")[0];
  check(/probe\.offsetWidth - probe\.clientWidth/.test(measure) &&
    /document\.documentElement\.style\.setProperty\("--lib-sb-w", w \+ "px"\)/.test(measure) &&
    libraryJsSrc.includes('window.addEventListener("resize", pbpLibMeasureScrollbar);') &&
    libraryJsSrc.includes('new MutationObserver(pbpLibMeasureScrollbar).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-density"] });'),
    "library.js: pbpLibMeasureScrollbar is gone, does not write --lib-sb-w, or is not re-run on resize and on html[data-theme|data-density] changes");
}
// List header, round 2 (2026-08-07). Four bare rows that each run the full
// width of the list column; the geometry itself is measured live by the render
// oracle's headerRowsFlush entry. What is asserted here is the wiring the
// oracle cannot see.
{
  // The status filter keeps its <select> -- hidden, as a state carrier, the
  // same shape #vocab-sort has used since the sort segment landed. Every
  // handler and every test still writes a value and dispatches `change`; if
  // the chips ever mutated their own state directly instead, filtering and
  // the URL of that state would fork.
  check(/id="vocab-status-filter"[^>]*\shidden/.test(libraryHtml),
    "library.html: #vocab-status-filter lost its `hidden` attribute — the status chips replaced it in the UI, it may not come back as a second visible control");
  check(/const target = chip\.dataset\.status;\s*\n\s*filter\.value = filter\.value === target \? "" : target;\s*\n\s*filter\.dispatchEvent\(new Event\("change"\)\);/.test(libraryVocabJs),
    "library-vocab.js: the status chips stopped writing #vocab-status-filter + dispatching change — they must drive the existing filter pipeline, not a parallel one");
  // Chips are controls, so they wear the button fill; and pressed is
  // byte-identical to the sort segment's pressed cell, which sits in the same
  // row and means the same thing. --lib-row-selected-bg is explicitly out: it
  // is byte-identical to --lib-panel on dracula (measured), i.e. invisible.
  // Hand-written layer only: the generated region carries its own
  // `.vocab-stat-chip` (the shared chip recipe), and matching that one instead
  // would test the thing this override exists to beat.
  // WHAT THIS PIN DOES AND DOES NOT GUARD (independent review F2, 2026-08-07):
  // it reads CSS SOURCE, so it can only see that the declaration EXISTS --
  // never that it WINS. Until 2026-08-07 the override was unqualified and beat
  // the generated rule on source order alone, which this pin is structurally
  // blind to: move the generated region below the hand-written block and every
  // assertion here still passes while the chips render grey-on-grey. The
  // `.vocab-filter-row > ` prefix is now required by the regexes for exactly
  // that reason -- it is the (0,2,0)-vs-(0,1,0) qualifier that makes winning a
  // property of the selector instead of a property of the file's layout, and
  // requiring it here is the closest a text gate can get to "this takes
  // effect". The render oracle's rowStates entries are what actually measure
  // the composed result.
  const chipHand = stripGeneratedRegions(libraryCss);
  const chipRule = /\.vocab-filter-row > \.vocab-stat-chip \{([^}]*)\}/.exec(chipHand);
  const chipOn = /\.vocab-filter-row > \.vocab-stat-chip\[aria-pressed="true"\] \{([^}]*)\}/.exec(chipHand);
  const segOn = /\.vocab-sort-seg > \.vocab-sort-btn\[aria-pressed="true"\] \{([^}]*)\}/.exec(chipHand);
  const mix = (body) => (/background:\s*(color-mix\([^;]*\))/.exec(body || "") || [])[1];
  check(!!chipRule && /background:\s*var\(--lib-btn-bg\)/.test(chipRule[1]) && /color:\s*var\(--lib-btn-fg\)/.test(chipRule[1]),
    "library.css: the status chips fell back to the chip family's label fill, or `.vocab-filter-row > ` was dropped from the override (without it the rule ties the generated recipe and wins only on source order) — in a row of controls they are controls and take the button fill");
  check(!!chipOn && !!segOn && mix(chipOn[1]) === mix(segOn[1]) &&
    !/row-selected-bg/.test(chipOn[1]) && !/inset/.test(chipOn[1]),
    "library.css: the chip's selected fill drifted from the sort segment's pressed cell (or went back to --lib-row-selected-bg / an inset ring) — two controls in one row that both mean \"this filter is on\" must not invent two looks");
  // An empty status span still carried its 8px margin and stole 16px off the
  // right edge of the count row, which is the row that has to end flush.
  check(/\.save-status:empty \{ display: none; \}/.test(libraryCss),
    "library.css: .save-status:empty no longer collapses — an empty status span takes its margin with it and the count row stops ending flush");
  // The count text takes the slack so Select all lands on the right edge.
  // Without it the slack went to the status span's `margin-left: auto`, which
  // right-aligned an EMPTY span and left Select all mid-row.
  check(/\.vocab-ctx-text \{[^}]*flex: 1 1 auto/.test(libraryCss),
    "library.css: .vocab-ctx-text stopped taking the count row's slack — Select all drifts back to the middle of the line");
}
// Lookup row moved into the detail panel (2026-08-07, L1). It filters nothing,
// and its result renders in #vocab-detail -- a control belongs where its
// output appears, and beside the search box it read as a second search box.
{
  const paneStart = libraryHtml.indexOf('id="vocab-detail-pane"');
  const paneEnd = libraryHtml.indexOf("</aside>", paneStart);
  const pane = paneStart < 0 ? "" : libraryHtml.slice(paneStart, paneEnd);
  check(pane.includes('id="vocab-lookup-bar"') && pane.includes('id="vocab-detail-back"'),
    "library.html: the lookup row and/or the back button left the detail pane — the lookup row must live where its result renders, and the back button must exist in EVERY pane state (empty included)");
  // De-islanded. These declarations sat on an ID selector, which is why the
  // mockup's class-level override was silently outranked twice; the fix is
  // that they are gone from the ID rule, not fought from a class.
  const bar = /#vocab-lookup-bar \{([^}]*)\}/.exec(libraryCss);
  check(!!bar && !/background:/.test(bar[1]) && !/border-radius:/.test(bar[1]) &&
    !/\bborder:/.test(bar[1]) && !/padding:\s/.test(bar[1]),
    "library.css: #vocab-lookup-bar grew its island back (background / border / radius / padding) — on the panel that is a box inside a box, and its right edge misses the reading column by its own padding and border");
  // The pane is a grid whose default justify-items is stretch, so a direct
  // child button spans the whole 66ch reading column without this.
  check(/\.vocab-detail-back \{[^}]*justify-self: start/.test(libraryCss),
    "library.css: .vocab-detail-back lost `justify-self: start` — as a direct grid child of the pane it stretches across the entire reading column");
  // The narrow door: list-side entry, gated to the single-pane range, and it
  // opens the tool rather than running it.
  check(/@media \(max-width: 860px\) \{[\s\S]*?\.vocab-filter-row > \.vocab-lookup-narrow \{ display: inline-flex; \}[\s\S]*?\n\}/.test(libraryCss) &&
    /\.vocab-filter-row > \.vocab-lookup-narrow \{ display: none;/.test(libraryCss),
    "library.css: the narrow lookup door is not media-gated to the single-pane range (it is the door to a pane that is only hidden down there)");
  check(/function _pbpVocabOpenLookupPane\(\) \{\s*\n\s*document\.body\.classList\.add\("lib-narrow-detail"\);[\s\S]{0,220}?input\.focus\(/.test(libraryVocabJs) &&
    /\["vocab-lookup-narrow", "vocab-signed-out-lookup"\][\s\S]{0,160}?addEventListener\("click", _pbpVocabOpenLookupPane\)/.test(libraryVocabJs),
    "library-vocab.js: a narrow lookup door stopped opening the pane and focusing the lookup box");
  check(/id="vocab-lookup-narrow"[^>]*data-i18n-title=/.test(libraryHtml) &&
    /id="vocab-lookup-narrow"[^>]*aria-label=/.test(libraryHtml) &&
    /id="vocab-lookup-narrow"[^>]*title=/.test(libraryHtml),
    "library.html: the icon-only narrow lookup door lost its title/aria-label (icon-only buttons carry both, always)");
  // The empty-state copy must not name a direction: below 860px the page is
  // one column and there is no "left". BOTH views, not just the vocab one --
  // the notes view has its own single-pane fallback (body.lib-narrow-notes)
  // and its own empty-state string, which stayed wrong for a day because this
  // pin named one key instead of the class of strings it was defending
  // (independent review F3, 2026-08-07).
  const enMsgs = JSON.parse(read("_locales/en/messages.json"));
  for (const key of ["libraryDetailEmpty", "libraryNotesDetailEmpty"]) {
    check(!/\bleft\b/i.test(enMsgs[key].message),
      `_locales/en: ${key} points at a direction again — in the single-pane layout there is nothing to the left of anything`);
  }
}
// Note editor (2026-08-06): the save button must stay IN LAYOUT while hidden.
// `display: none` is what made the textarea jump narrower on the first
// keystroke; `visibility: hidden` keeps the box, and still drops the button
// from the tab order and the a11y tree so library-vocab.js's
// `noteSave.hidden = true` keeps its exact meaning and needs no change.
// Asserted statically because the render oracle has no display/visibility
// vocabulary, and the defect is precisely a display value.
{
  const rule = /\.vocab-note-save\[hidden\]\s*\{([^}]*)\}/.exec(libraryCss);
  check(!!rule && /visibility:\s*hidden/.test(rule[1]) && !/display:\s*none/.test(rule[1]),
    "library.css: .vocab-note-save[hidden] is back on display:none (or lost visibility:hidden) — revealing the save button then reflows the note row and the textarea jumps under the cursor");
  // .btn's author-origin `display: inline-flex` already outranks the UA
  // `[hidden] { display: none }` rule, so this rule must NOT be nested under
  // html.motion-ready: before that class lands the button would be fully
  // visible rather than merely un-animated.
  check(!/html\.motion-ready\s+\.vocab-note-save\[hidden\]/.test(libraryCss),
    "library.css: the .vocab-note-save[hidden] rule is gated on html.motion-ready — the button renders fully visible until that class is added");
  // The HAND-WRITTEN rule, by exact selector: since stage 4 the generated
  // field recipe also emits a `.vocab-note-input {` rule (colours only), and a
  // first-match regex over the whole file would read that one instead.
  const input = declarationValueMap(stripGeneratedRegions(libraryCss), ".vocab-note-input");
  check(input.get("field-sizing") === "content" && input.has("min-height") && input.has("max-height") && input.get("resize") === "vertical",
    "library.css: .vocab-note-input lost auto-grow (field-sizing: content) or one of its bounds — without the max-height a 500-char note pushes the rest of the detail pane off-screen");
  // v2b (USER RULING 2026-08-06): Save is a commit control, so it lives with
  // the other commit controls at the right end of the pane's closing row --
  // not hanging off the textarea's trailing edge. Asserted on the JS because
  // that is where the placement is decided; the zero-shift half is already
  // guaranteed by the visibility rule above (the box never leaves layout).
  check(/footer\.appendChild\(noteEditor\.save\)/.test(libraryVocabJs) &&
    /\.vocab-detail-footer > \.vocab-note-save \{/.test(libraryCss),
    "library-vocab.js/library.css: the note Save button left the detail pane's closing row");
}
// Comments stripped first, same as the class-level gate above: BOTH of these
// name a selector that the surrounding prose also has every reason to
// mention, and a scan over raw source cannot tell a rule from an explanation
// of why that rule is gone. This is the same failure mode CLAUDE.md records
// for contrast-audit's orphan guard, where a comment quoting "info-fg" made
// the guard believe the token was already handled.
{
  const libRules = libraryCss.replace(/\/\*[\s\S]*?\*\//g, "");
  check((libRules.match(/\.lib-tab:focus-visible/g) || []).length === 1,
    "library.css: .lib-tab has more than one :focus-visible rule again — the later same-specificity one silently wins `outline` while the earlier still supplies `box-shadow`");
  check(!/\.vocab-sort-seg:focus-within/.test(libRules),
    "library.css: the .vocab-sort-seg shell focus ring is back — it lights on plain mouse-down and double-rings on Tab (the cell's own inset ring is the indicator)");
}
// ---- Stage 4 Task 6 (spec 2026-09-30-ui-fields-stage4-design §2.1 / §3.2 /
// §5.1): popup's value boxes are one fill-only field family. Colour comes
// ONLY from the FIELD_TARGETS.pp registry (composers/ui-components.mjs ->
// @generated:ui-components); the hand-written region keeps geometry, the
// focus ring and `outline: none`. Everything below reads the registry the
// composer actually consumes and popup.html's real DOM -- no hand list of
// selectors or ids (CLAUDE.md, 测试与夹具). This replaces the regex pins that
// used to name each popup focus rule and its html[data-theme] twin (both
// gone: the base rules moved into the generated region and the twins were
// deleted in the same commit).
//
// popup.html as a tree: tag, content attributes (exactly as written -- no
// defaults: an <input> without `type` has no type attribute, and
// `[type="text"]` does not match it, just as in the browser), class list,
// parent, and its element children in document order (`children`, which the
// sibling combinators read). popup.html has no inline <script> / <style> body
// (CSP), so a tag scan is exact here. The synthetic root (every top-level
// node's `parent`) carries what the static markup names anywhere -- every
// class (`staticClasses`), attribute name (`staticAttrs`) and id
// (`staticIds`) -- which scanScopeOf hands to selectorReaches so
// nodeMatchesCompound can tell a runtime state (.ac-open, toggled by
// popup-tags.js; html[data-section], set by popup-theme-early.js; neither in
// the markup) from a static one the node simply lacks.
function htmlNodes(html) {
  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
  const root = { tag: "#root", attrs: {}, classes: [], parent: null, children: [], staticClasses: new Set(), staticAttrs: new Set(), staticIds: new Set() };
  const nodes = [];
  let cur = root;
  for (const m of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const tag = m[2].toLowerCase();
    if (m[1]) {
      for (let n = cur; n !== root; n = n.parent) if (n.tag === tag) { cur = n.parent; break; }
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    const node = { tag, attrs, classes: (attrs.class || "").split(/\s+/).filter(Boolean), parent: cur, children: [] };
    for (const cls of node.classes) root.staticClasses.add(cls);
    for (const name of Object.keys(attrs)) root.staticAttrs.add(name);
    if (attrs.id) root.staticIds.add(attrs.id);
    cur.children.push(node);
    nodes.push(node);
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) cur = node;
  }
  return nodes;
}
// The scan-mode scope of a tree (what its static markup names), for
// selectorReaches' third argument; without one, matching is strict.
function scanScopeOf(nodes) {
  let root = nodes[0];
  while (root?.parent) root = root.parent;
  return root?.staticClasses ? { classes: root.staticClasses, attrs: root.staticAttrs, ids: root.staticIds } : null;
}
// One attribute selector's text between the brackets -> { name, op, value,
// flag }. Selectors Level 4 attribute matching in full: presence, `=`, `~=`,
// `|=`, `^=`, `$=`, `*=`, and the ` i` / ` s` case flags. Anything else (a
// namespace prefix, an unknown operator) THROWS: a matcher that silently
// dropped a condition it could not read would widen the selector and call
// covered what the browser does not paint.
function parseAttributeSelector(inner) {
  const m = /^\s*([A-Za-z_][\w-]*)\s*(?:([~|^$*]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"'\]]+))\s*(?:([iIsS])\s*)?)?$/.exec(inner);
  if (!m) throw new TypeError(`ui-contract-tests.mjs: unsupported attribute selector [${inner}] (the structural matcher refuses to drop a condition it cannot read)`);
  const raw = m[3] ?? m[4] ?? m[5];
  return {
    name: m[1].toLowerCase(),
    op: m[2] ?? null,
    value: raw === undefined ? null : raw.replace(/\\(.)/g, "$1"),
    flag: m[6] ? m[6].toLowerCase() : null,
  };
}
// HTML attributes whose VALUES match ASCII case-insensitively under a plain
// attribute selector in an HTML document (HTML Living Standard, "case-
// sensitivity of selectors"); an explicit ` s` / ` i` flag overrides.
const HTML_CASE_INSENSITIVE_ATTRS = new Set(["accept", "accept-charset", "align", "alink", "axis", "bgcolor", "charset", "checked", "clear", "codetype", "color", "compact", "declare", "defer", "dir", "direction", "disabled", "enctype", "face", "frame", "hreflang", "http-equiv", "lang", "language", "link", "media", "method", "multiple", "nohref", "noresize", "noshade", "nowrap", "readonly", "rel", "rev", "rules", "scope", "scrolling", "selected", "shape", "target", "text", "type", "valign", "valuetype", "vlink"]);
function attributeMatches(have, a) {
  if (have === undefined) return false;
  if (a.op === null) return true;
  const ci = a.flag ? a.flag === "i" : HTML_CASE_INSENSITIVE_ATTRS.has(a.name);
  const h = ci ? have.toLowerCase() : have, v = ci ? a.value.toLowerCase() : a.value;
  switch (a.op) {
    case "=": return h === v;
    case "~=": return v !== "" && !/\s/.test(v) && h.split(/\s+/).includes(v);
    case "|=": return h === v || h.startsWith(`${v}-`);
    case "^=": return v !== "" && h.startsWith(v);
    case "$=": return v !== "" && h.endsWith(v);
    case "*=": return v !== "" && h.includes(v);
    default: throw new TypeError(`ui-contract-tests.mjs: unsupported attribute operator ${a.op}`);
  }
}
// One compound's structural conditions (tag, #id, .class, attribute
// selectors); pseudo-classes and their arguments (:hover, :where(), :not(),
// ...) are dropped -- the question is which ELEMENT a rule can reach, not in
// which state. A pseudo-element is reported so callers can tell a
// ::placeholder rule from a rule on the box itself.
function structuralCompound(text) {
  let own = "", pseudoElement = null;
  const attrs = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "[") { const j = closeOfBracket(text, i); attrs.push(parseAttributeSelector(text.slice(i + 1, j))); i = j; continue; }
    if (text[i] === ":") {
      let j = i + 1;
      const element = text[j] === ":";
      if (element) j += 1;
      const start = j;
      while (j < text.length && /[\w-]/.test(text[j])) j += 1;
      if (element) pseudoElement = text.slice(start, j).toLowerCase();
      if (text[j] === "(") j = closeOfBracket(text, j) + 1;
      i = j - 1;
      continue;
    }
    own += text[i];
  }
  return {
    tag: ((/^([a-zA-Z][\w-]*)/.exec(own) || [])[1] || "").toLowerCase() || null,
    ids: [...own.matchAll(/#([\w-]+)/g)].map((m) => m[1]),
    classes: [...own.matchAll(/\.([\w-]+)/g)].map((m) => m[1]),
    attrs,
    pseudoElement,
  };
}
// Complex selector -> compounds, each with the combinator BEFORE it (null on
// the first). `themed` reports a leading html[data-theme...] compound (the
// preset layer's prefix) for messages only: it is matched like any other
// compound -- a runtime attribute in scan mode, unmatched in strict mode.
function structuralParts(sel) {
  const parts = [];
  let buf = "", pending = null;
  const flush = () => { if (buf) { parts.push({ c: structuralCompound(buf), comb: pending }); buf = ""; } };
  for (let i = 0; i < sel.length; i += 1) {
    const ch = sel[i];
    if (ch === "(" || ch === "[") { const j = closeOfBracket(sel, i); buf += sel.slice(i, j + 1); i = j; continue; }
    if (ch === " ") { if (buf) { flush(); pending = " "; } continue; }
    if (ch === ">" || ch === "+" || ch === "~") { flush(); pending = ch; continue; }
    buf += ch;
  }
  flush();
  if (parts.length) parts[0] = { ...parts[0], comb: null };
  const themed = parts.length > 0 && parts[0].c.tag === "html" && parts[0].c.attrs.some((a) => a.name === "data-theme");
  return { parts, themed };
}
// Attributes a script sets by design: ARIA states and properties, data-*
// and the HTML boolean states. Their VALUE in the static markup says nothing
// about the value at run time (popup.html ships aria-busy="true" on the
// suggestion area and popup-tags.js flips it; library.html ships
// #vocab-detail hidden).
const RUNTIME_STATE_ATTR = /^(?:aria-[\w-]+|data-[\w-]+|hidden|disabled|open|inert|checked|selected|readonly)$/;
// Tag and ids are exact, attribute selectors follow Selectors 4 against the
// node's CONTENT attributes only (attributeMatches; no implied defaults, so
// `input[type="text"]` never reaches an untyped <input>). Without a scope
// (null) that is all: strict mode, the one the coverage count runs on --
// only what the static markup proves.
// Scan mode (a scanScopeOf scope; every hand-rule scan) asks what the
// BROWSER can reach, so runtime state counts:
//   - a class the node lacks fails the match when the static markup names it
//     somewhere; one it never names is a RUNTIME state class (.ac-open,
//     .dragging) that script may put on this very node, so it is allowed --
//     except on the SUBJECT, which must still be anchored by something the
//     node really carries (a `.tag-item` rule, a runtime-only class, would
//     otherwise reach every box);
//   - an attribute condition on a compound OTHER than the subject is
//     satisfiable when the static markup never carries that attribute name
//     (html[data-section] / :root[data-theme], set by popup-theme-early.js)
//     or when it is a RUNTIME_STATE_ATTR (whatever value the markup ships).
//     The subject's own attributes stay exact ([type="text"] must still tell
//     a text box from a checkbox).
function nodeMatchesCompound(node, c, scope = null, subject = false) {
  if (c.tag && node.tag !== c.tag) return false;
  if (c.ids.some((id) => node.attrs.id !== id)) return false;
  let anchored = !!c.tag || c.ids.length > 0 || c.attrs.length > 0;
  for (const cls of c.classes) {
    if (node.classes.includes(cls)) anchored = true;
    else if (!scope || scope.classes.has(cls)) return false;
  }
  if (subject && scope && c.classes.length && !anchored) return false;
  return c.attrs.every((a) => attributeMatches(node.attrs[a.name], a) ||
    (!!scope && !subject && (!scope.attrs.has(a.name) || RUNTIME_STATE_ATTR.test(a.name))));
}
// Could a compound in a sibling position be an element a script inserts
// (popup-tags.js puts the .tag-item chips into .tags-input-wrap)? Yes unless
// it names something only the static markup has: an id the markup carries,
// a class the markup names, an attribute name the markup carries that is not
// a runtime state. A bare tag, a runtime class or attribute proves nothing.
function mayBeInserted(c, scope) {
  return !c.ids.some((id) => scope.ids.has(id)) && !c.classes.some((cls) => scope.classes.has(cls)) &&
    c.attrs.every((a) => !scope.attrs.has(a.name) || RUNTIME_STATE_ATTR.test(a.name));
}
// Does `sel` reach `node`? Strict mode (no scope) keeps the pre-final-wave
// answer for the sibling combinators: `+` / `~` reach nothing -- a coverage
// claim through a sibling the static markup may not keep proves nothing.
// Scan mode models them in document order (node.parent.children): `+` the
// immediately preceding element sibling, `~` any preceding one -- and, fail-
// closed, also a sibling a script may insert (mayBeInserted), or ANY sibling
// when the node itself is a runtime box whose place is unknown (`unplaced`,
// library's grafted boxes). Such a virtual sibling shares the node's parent,
// so the compounds left of it still resolve against the real tree.
function selectorReaches(sel, node, scope = null) {
  const { parts } = structuralParts(sel);
  if (!parts.length) return false;
  if (!scope && parts.some((p) => p.comb === "+" || p.comb === "~")) return false;
  const inTree = (n) => !!n?.parent; // the synthetic root is no element
  const from = (n, i) => nodeMatchesCompound(n, parts[i].c, scope, i === parts.length - 1) && leftOf(n, i);
  // Compound i is matched by n (a virtual sibling: { parent, virtual: true });
  // do the compounds before it resolve?
  const leftOf = (n, i) => {
    if (i === 0) return true;
    const comb = parts[i].comb;
    if (comb === ">") return inTree(n.parent) && from(n.parent, i - 1);
    if (comb === " ") {
      for (let p = n.parent; inTree(p); p = p.parent) if (from(p, i - 1)) return true;
      return false;
    }
    if (!n.virtual && !n.unplaced && n.parent?.children) {
      const siblings = n.parent.children, at = siblings.indexOf(n);
      const before = comb === "+" ? siblings.slice(Math.max(0, at - 1), Math.max(0, at)) : siblings.slice(0, Math.max(0, at));
      if (before.some((p) => from(p, i - 1))) return true;
    }
    return !!n.parent && (n.virtual || n.unplaced || mayBeInserted(parts[i - 1].c, scope)) && leftOf({ parent: n.parent, virtual: true }, i - 1);
  };
  return from(node, parts.length - 1);
}
// A selector with every pseudo-class removed, whitespace normalized: the
// structural "which box" part the same-box check compares across states.
function structuralText(sel) {
  let out = "";
  for (let i = 0; i < sel.length; i += 1) {
    if (sel[i] === "[") { const j = closeOfBracket(sel, i); out += sel.slice(i, j + 1); i = j; continue; }
    if (sel[i] === ":") {
      let j = i + 1;
      if (sel[j] === ":") j += 1;
      while (j < sel.length && /[\w-]/.test(sel[j])) j += 1;
      if (sel[j] === "(") j = closeOfBracket(sel, j) + 1;
      i = j - 1;
      continue;
    }
    out += sel[i];
  }
  return out.replace(/\s*>\s*/g, " > ").replace(/\s+/g, " ").trim();
}
const selectorListOf = (text) => (text ? splitSelectorList(text) : []);
// Coverage of an html tree by one surface's FIELD_TARGETS entries: every
// text-entry control (a textarea, or an <input> whose type -- absent means
// text -- is a text-entry type) must be reached by exactly one entry, either
// as that entry's box (rest) or as the passenger of a shell some ancestor of
// it is the box of. Matching is strict (selectorReaches without runtime
// classes): the registry's own selectors name static structure. Library
// (Task 7) runs the same function over library.html plus its grafted
// runtime boxes.
function valueBoxCoverage(nodes, targets) {
  const entries = nodes.filter((n) => n.tag === "textarea" || (n.tag === "input" && TEXT_ENTRY_TYPES.has((n.attrs.type || "text").toLowerCase())));
  const restHits = (node) => targets.filter((t) => selectorListOf(t.rest).some((sel) => selectorReaches(sel, node)));
  const passengerHits = (node) => targets.filter((t) => selectorListOf(t.passenger).some((sel) => selectorReaches(sel, node)));
  const boxes = new Set(), passengers = new Set(), uncovered = [];
  for (const node of entries) {
    const asBox = restHits(node), asPassenger = passengerHits(node);
    const label = `#${node.attrs.id || "?"}`;
    if (asBox.length === 1 && asPassenger.length === 0) boxes.add(node);
    else if (asBox.length === 0 && asPassenger.length === 1) {
      let host = null;
      for (let p = node.parent; p?.parent && !host; p = p.parent) if (restHits(p).includes(asPassenger[0])) host = p;
      if (host) { passengers.add(node); boxes.add(host); }
      else uncovered.push(`${label}: passenger of ${asPassenger[0].id}, but no ancestor is that entry's box`);
    } else uncovered.push(`${label}: rest of [${asBox.map((t) => t.id).join(", ")}], passenger of [${asPassenger.map((t) => t.id).join(", ")}]`);
  }
  const dead = targets.filter((t) => !nodes.some((n) => restHits(n).includes(t)));
  return { entries: entries.length, boxes, passengers, uncovered, dead };
}
// The state grammar of one FIELD_TARGETS box (R1 / T6-g, every surface): the
// focus selector carries exactly ONE focus trigger -- `:focus`,
// `:focus-visible`, `:focus-within` or a `:has(...)` whose argument holds
// one of those (library's group unit: `:has(> input[type="text"]:focus)`) --
// on some compound (the box itself, or the shell that carries the box's
// state: popup's .secret-field); the hover selector carries `:hover` on
// that same compound and a `:not(...)` whose argument list contains that
// exact trigger (text-equal after whitespace normalisation -- `:focus` does
// not excuse `:focus-visible`), and excludes the disabled state with
// `:disabled` in a `:not(...)` on that compound or on the subject, or with
// `:has(... :disabled)` there (the group unit's `:has(> input:disabled)`).
// `:not()` / `:hover` count at the compound's top level or inside a
// `:where()` / `:is()` of it (the exclusions live in :where() by R1).
// Bracket-aware throughout (closeOfBracket); no text `includes`.
function compoundTexts(sel) {
  const out = [];
  let cur = "";
  for (let i = 0; i < sel.length; i += 1) {
    const ch = sel[i];
    if (ch === "(" || ch === "[") { const j = closeOfBracket(sel, i); cur += sel.slice(i, j + 1); i = j; continue; }
    if (ch === " " || ch === ">" || ch === "+" || ch === "~") { if (cur) out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
// Pseudo-class tokens of one compound: [{ name, arg (text inside the
// parentheses, or null), text }], top level only.
function pseudoClassTokens(compound) {
  const out = [];
  for (let i = 0; i < compound.length; i += 1) {
    if (compound[i] === "[") { i = closeOfBracket(compound, i); continue; }
    if (compound[i] !== ":") continue;
    if (compound[i + 1] === ":") { i += 1; continue; } // pseudo-element: not a state
    let j = i + 1;
    while (j < compound.length && /[\w-]/.test(compound[j])) j += 1;
    const name = compound.slice(i + 1, j).toLowerCase();
    let arg = null;
    if (compound[j] === "(") { const close = closeOfBracket(compound, j); arg = compound.slice(j + 1, close); j = close + 1; }
    out.push({ name, arg, text: compound.slice(i, j) });
    i = j - 1;
  }
  return out;
}
// The compound's state tokens with :where() / :is() arguments flattened in
// (each argument read as a compound of its own).
function stateTokens(compound) {
  return pseudoClassTokens(compound).flatMap((t) => ((t.name === "where" || t.name === "is") && t.arg !== null
    ? splitSelectorList(t.arg).flatMap((a) => (compoundTexts(a).length === 1 ? stateTokens(a) : []))
    : [t]));
}
const normSel = (text) => text.replace(/\s*([>+~])\s*/g, " $1 ").replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
const FOCUS_TRIGGER_RE = /:focus(?:-visible|-within)?(?![\w-])/;
function focusTriggerOf(focusSel) {
  const found = [];
  compoundTexts(focusSel).forEach((compound, index) => {
    for (const t of stateTokens(compound)) {
      if (["focus", "focus-visible", "focus-within"].includes(t.name) && t.arg === null) found.push({ index, text: t.text });
      else if (t.name === "has" && t.arg !== null && FOCUS_TRIGGER_RE.test(t.arg)) found.push({ index, text: normSel(t.text) });
    }
  });
  return found.length === 1 ? found[0] : { index: -1, text: null, found: found.map((f) => f.text) };
}
// A `:has(... :disabled)` :not() argument (normalised text): the busy-state
// exclusion of a SHELL, whose own :disabled never matches (a <span> or <div>
// is not a form control) -- the disabled one is the control inside it.
function hasDisabledArgument(a) {
  const [t] = pseudoClassTokens(a);
  if (!t || t.name !== "has" || t.arg === null || t.text !== a) return false;
  const inner = compoundTexts(t.arg);
  return stateTokens(inner[inner.length - 1] ?? "").some((x) => x.name === "disabled" && x.arg === null);
}
// Every :not() argument of a selector, on any compound (top level or inside
// :where() / :is()), whitespace-normalised.
const notArgumentsOf = (sel) => compoundTexts(sel).flatMap((c) => stateTokens(c))
  .filter((t) => t.name === "not" && t.arg !== null).flatMap((t) => splitSelectorList(t.arg).map(normSel));
// Problems with one (rest, hover, focus) box, [] when it is sound.
function fieldLadderProblems(rest, hover, focus) {
  const problems = [];
  if (!rest || !hover || !focus) return ["rest / hover / focus are not parallel"];
  const [sr, sh, sf] = [rest, hover, focus].map(selectorSpecificity);
  if (!(cmpSpecificity(sr, sh) < 0 && cmpSpecificity(sh, sf) < 0)) problems.push(`specificity must climb rest < hover < focus -- got ${sr.join(",")} / ${sh.join(",")} / ${sf.join(",")}`);
  if (!(structuralText(hover) === structuralText(rest) && structuralText(focus) === structuralText(rest))) {
    problems.push(`hover / focus must name the same box as rest (\`${structuralText(hover)}\` / \`${structuralText(focus)}\` vs \`${structuralText(rest)}\`)`);
    return problems;
  }
  const trigger = focusTriggerOf(focus);
  if (trigger.index < 0) {
    problems.push(`the focus selector must carry exactly one focus trigger (:focus / :focus-visible / :focus-within / :has(...:focus...)) -- found ${JSON.stringify(trigger.found)}`);
    return problems;
  }
  const H = compoundTexts(hover);
  const on = stateTokens(H[trigger.index] ?? "");
  const subject = stateTokens(H[H.length - 1] ?? "");
  const notArgs = (tokens) => tokens.filter((t) => t.name === "not" && t.arg !== null).flatMap((t) => splitSelectorList(t.arg).map(normSel));
  if (!on.some((t) => t.name === "hover" && t.arg === null)) problems.push(`the hover selector must carry :hover on the compound that holds the focus trigger (\`${H[trigger.index] ?? ""}\`)`);
  if (!notArgs(on).includes(trigger.text)) problems.push(`the hover selector must exclude the exact focus trigger \`${trigger.text}\` with :not(...) on that compound -- got :not() arguments ${JSON.stringify(notArgs(on))}`);
  const disabledArg = (a) => a === ":disabled" || hasDisabledArgument(a);
  if (![...notArgs(on), ...notArgs(subject)].some(disabledArg)) problems.push("the hover selector must exclude the disabled state (:not(:disabled), or :not(:has(> input:disabled)) on a shell) on that compound or the subject");
  return problems;
}
// The hand ring of a registry entry (rule 4 below) and its forced-colours
// outline (rule 10) sit on the entry's own focus selectors: :focus becomes
// :focus-visible for the :focus-triggered boxes (a text field matches both on
// any focus), the :focus-within shells keep theirs.
const fieldRingSelectors = (t) => selectorListOf(t.focus).map((sel) => sel.replace(/:focus(?=:not\(:disabled\))/g, ":focus-visible"));

// ---- Stage 4 shared value-box gates (Task 7 fix round 1). Each gate below
// used to be written out once per surface; one implementation now, called
// from the options / popup / library blocks with that surface's own
// registry, box model and discriminating cases (the precedent is
// valueBoxShapeOffenders / valueBoxUrlColourOffenders and the ladder gate).
//
// (a) The generated half of FIELD_TARGETS[ns]: every role of every entry
//     emitted with exactly the declarations the binding contract names
//     (spec §4). Returns one message per wrong selector; `checked` counts the
//     selectors read.
const FIELD_TARGET_EMITS = Object.freeze({
  rest: [["background-color", "field-bg"], ["border-color", "field-border"], ["color", "field-fg"]],
  hover: [["background-color", "field-bg-hover"], ["border-color", "field-border-hover"]],
  focus: [["background-color", "field-bg-focus"], ["border-color", "field-border-focus"]],
  placeholder: [["color", "field-placeholder"]],
  passenger: [["color", "field-fg"]],
  chevron: [["background-image", "field-chevron"]],
});
function fieldTargetEmissionProblems(ns, targets, genCss, file) {
  const problems = [];
  let checked = 0;
  for (const t of targets) {
    for (const [key, want] of Object.entries(FIELD_TARGET_EMITS)) {
      for (const sel of selectorListOf(t[key])) {
        checked += 1;
        const got = declarationValueMap(genCss, sel);
        const wrong = want.filter(([prop, role]) => got.get(prop) !== `var(--${ns}-${role})`);
        if (wrong.length) {
          problems.push(`${file}: the generated FIELD_TARGETS.${ns} ${t.id}.${key} rule for \`${sel}\` does not paint ${wrong.map(([pr, r]) => `${pr}: var(--${ns}-${r})`).join(", ")} (got ${JSON.stringify(Object.fromEntries(got))}) -- run node docs/theme-surface/tools/sync-all.mjs`);
        }
      }
    }
  }
  return { problems, checked };
}
// (b) The hand half keeps each box's ring (§7.3 `bordered`: the core is the
//     generated focus border, the glow is hand-written) on the entry's own
//     ring selectors (fieldRingSelectors), so ring and frame cannot fire in
//     different states. Returns { missing: [{ id, sels }], checked }.
function fieldRingMissing(ns, targets, handCss) {
  const missing = [];
  let checked = 0;
  for (const t of targets) {
    const sels = fieldRingSelectors(t);
    checked += sels.length;
    const off = sels.filter((sel) => declarationValueMap(handCss, sel).get("box-shadow") !== `var(--${ns}-focus-ring)`);
    if (off.length) missing.push({ id: t.id, sels: off });
  }
  return { missing, checked };
}
// (c) Forced colours (spec §6 item 10, ruling R5): the outlines that restore
//     a value box's focus edge under @media (forced-colors: active), and the
//     outline suppressors that out-rank one of them on the same box.
//     `targetsOf(sel)` maps a selector to what it reaches -- tree nodes on
//     popup / library, value-box kinds on options -- and two selectors meet
//     when they share a target. `outlineSelector` narrows which selectors of
//     an outline rule count (options: :focus-visible only); `requireOffset`
//     demands a declared non-negative outline-offset (popup / library).
//     A suppressor is any outline-removing rule outside `forced-colors: none`
//     that can apply WHILE the outline does (suppressorExcludedBy decides,
//     per outline): a :focus rule, and also a :hover rule (the pointer can
//     rest on a box the keyboard focuses -- spec §2.1, plan review focus 2)
//     or a stateless one. It out-ranks an outline the way the cascade does:
//     !important over a normal declaration outright; otherwise (both or
//     neither important) strictly higher specificity, or equal and later in
//     the file.
//     `required` = [{ label, sel } | { label, target }]: an outline must exist
//     on that exact selector / reach that target. Returns { outlines,
//     missing, outranked }.
const OUTLINE_OFF = Object.freeze({ outline: /^(?:none|0(?:px)?)$/i, "outline-style": /^none$/i, "outline-width": /^0(?:px)?$/ });
// Per compound (subject last): the :not() arguments written on it and its
// positive state pseudo-classes, read at its top level and inside a
// SINGLE-argument :where() / :is() only -- a multi-argument one is an OR, so
// no exclusion is credited from it (the ladder gate's stateTokens flattens
// both; this reader must not).
function compoundStates(sel) {
  return compoundTexts(sel).map((compound) => {
    const nots = [], states = [];
    const walk = (c) => {
      for (const t of pseudoClassTokens(c)) {
        if (t.name === "not" && t.arg !== null) nots.push(...splitSelectorList(t.arg).map(normSel));
        else if ((t.name === "where" || t.name === "is") && t.arg !== null) {
          const args = splitSelectorList(t.arg);
          if (args.length === 1 && compoundTexts(args[0]).length === 1) walk(args[0]);
        } else if (t.arg === null) states.push(t.name);
      }
    };
    walk(compound);
    return { nots, states, attrs: structuralCompound(compound).attrs };
  });
}
// Does the suppressor selector `supSel` provably NOT apply while the outline
// `outlineSel` does? Both reach the same box (the caller pairs them on a
// shared target), so their SUBJECT compounds name the same element. A
// compound left of the subject names an ANCESTOR of the box exactly when the
// combinator right after it is a descendant or child one (final fix wave).
// Read right to left, every element the selector names is the box, an
// ancestor of it, or a preceding sibling of one of those: a ` ` / `>` step
// goes up to an ancestor of the element on its right, and an ancestor of any
// of those contains the box; a `+` / `~` step goes to a preceding sibling,
// which contains nothing of the element beside it. So
// `.row:not(:focus-within) > .label + .field > textarea` names the .row that
// holds the field, while `.fg label:not(:focus-within) ~ textarea` names a
// label beside the textarea, which never contains its focus. Task 7 fix
// round 2: an exclusion only counts for the state the outline actually
// depends on, on the element that holds it -- read from the outline's own
// focus trigger (focusTriggerOf):
//   - trigger :focus / :focus-visible on the outline's subject: the box
//     itself holds focus, so on the suppressor's subject :not(:focus),
//     :not(:focus-within) and (for a :focus-visible trigger)
//     :not(:focus-visible) exclude it;
//   - trigger :focus-within / :has(...) on the outline's subject (a shell --
//     .tags-input-wrap, .vocab-group-unit -- that never takes focus itself):
//     only :not(:focus-within) or the very same :not(:has(...)) on the
//     subject excludes it; :not(:focus) / :not(:focus-visible) there exclude
//     nothing;
//   - a trigger on an ANCESTOR of the outline's subject (popup's
//     .secret-field:focus-within > input): the box may not hold focus at all
//     (the eye can), so nothing on the subject excludes it;
//   - on an ancestor compound of the suppressor only :not(:focus-within)
//     excludes (every ancestor of the box contains the focused element; none
//     of them is focused itself, so :not(:focus) / :not(:focus-visible) there
//     exclude nothing); on a sibling compound nothing does;
//   - a subject that is :disabled / [disabled] never co-applies (a disabled
//     control cannot take focus; a shell never matches :disabled at all).
// Anything else can apply while the outline does: focus rules, hover rules
// (the pointer can rest on a keyboard-focused box), stateless rules.
function suppressorExcludedBy(supSel, outlineSel) {
  const sup = compoundStates(supSel);
  const subject = sup[sup.length - 1];
  if (!subject) return false;
  if (subject.states.includes("disabled") || subject.attrs.some((a) => a.name === "disabled")) return true;
  const combs = structuralParts(supSel).parts.map((p) => p.comb);
  if (combs.length !== sup.length) throw new TypeError(`ui-contract-tests.mjs: suppressorExcludedBy could not align the compounds of \`${supSel}\` with their combinators`);
  if (sup.slice(0, -1).some((c, k) => (combs[k + 1] === " " || combs[k + 1] === ">") && c.nots.includes(":focus-within"))) return true;
  const trigger = focusTriggerOf(outlineSel);
  if (trigger.index < 0 || trigger.index !== compoundTexts(outlineSel).length - 1) return false;
  const excluding = new Set([":focus-within"]);
  if (trigger.text === ":focus" || trigger.text === ":focus-visible") {
    excluding.add(":focus");
    if (trigger.text === ":focus-visible") excluding.add(":focus-visible");
  } else if (trigger.text.startsWith(":has(")) excluding.add(trigger.text);
  return subject.nots.some((a) => excluding.has(a));
}
function forcedOutlineReport(text, { targetsOf, required, outlineSelector = () => true, requireOffset = true }) {
  const rules = parseStyleRules(text);
  const outlines = [];
  for (const r of rules.filter(inForcedColors)) {
    const decls = parseDeclarations(r.body);
    const outline = decls.find((d) => d.property === "outline" && /^1px solid Highlight$/i.test(d.value.trim()));
    if (!outline) continue;
    if (requireOffset) {
      const offset = decls.find((d) => d.property === "outline-offset");
      if (!offset || !(parseFloat(offset.value) >= 0)) continue;
    }
    for (const sel of r.selectors.filter(outlineSelector)) {
      outlines.push({ sel, targets: new Set(targetsOf(sel)), spec: selectorSpecificity(sel), order: r.sourceOrder, important: outline.important });
    }
  }
  const missing = required.filter((q) => !outlines.some((o) => ("sel" in q ? o.sel === q.sel : o.targets.has(q.target)))).map((q) => q.label);
  const outranked = [];
  for (const r of rules.filter((x) => !x.context.some((c) => FORCED_NONE_RE.test(c)))) {
    const off = parseDeclarations(r.body).filter((d) => Object.hasOwn(OUTLINE_OFF, d.property) && OUTLINE_OFF[d.property].test(d.value.trim()));
    if (!off.length) continue;
    const important = off.some((d) => d.important);
    for (const sel of r.selectors) {
      const targets = targetsOf(sel);
      if (!targets.length) continue;
      for (const f of outlines) {
        if (!targets.some((t) => f.targets.has(t)) || suppressorExcludedBy(sel, f.sel)) continue;
        if (f.important && !important) continue;
        const c = cmpSpecificity(selectorSpecificity(sel), f.spec);
        if ((important && !f.important) || c > 0 || (c === 0 && r.sourceOrder > f.order)) outranked.push(`${sel} (line ${r.lineNum}) over ${f.sel}`);
      }
    }
  }
  return { outlines, missing, outranked };
}
// (d) F10 (spec §2.2 / §2.3): a small button's ghost chip inside a value box
//     must stay a visible plane (>= FILL_SEPARATE_MIN, imported from the
//     deriver) against the fill the box ACTUALLY paints beneath it, on every
//     block -- the 14 generated html[data-theme] blocks over the default
//     (the column-0 :root blocks, hand then generated, in file order).
//     `states` = [{ name, chip, fill, pct }]: the chip's `background` value
//     (must be color-mix(in srgb, var(--<ns>-field-fg) <pct>, var(--<ns>-*)))
//     and the box's fill value in that state (a single var(--<ns>-*)); the
//     chip must mix over exactly that fill. color-mix(in srgb, A p%, B) is a
//     per-channel linear sRGB mix quantised to 8 bits at paint, so each
//     channel is Math.round(A*p + B*(1-p)). Returns { failures, measured,
//     lowest, ratios, blocks }; the caller pins the expected measured count.
function fieldThemeBlocks(css, ns) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const region = css.slice(css.indexOf("/* @generated:ui-themes start"), css.indexOf("/* @generated:ui-themes end */")).replace(/\/\*[\s\S]*?\*\//g, "");
  const varRe = new RegExp(`(--${ns}-[a-z0-9-]+)\\s*:\\s*([^;]+);`, "g");
  const readVars = (body, into) => { for (const d of body.matchAll(varRe)) into[d[1]] = d[2].trim(); return into; };
  const rootVars = {};
  for (const m of noComments.matchAll(/(?:^|\n):root\s*\{([^}]*)\}/g)) readVars(m[1], rootVars);
  const blocks = [[":root", rootVars]];
  for (const m of region.matchAll(/html\[data-theme="([a-z0-9-]+)"\]\s*\{([^}]*)\}/g)) blocks.push([m[1], readVars(m[2], { ...rootVars })]);
  return blocks;
}
function chipOverFillAcrossBlocks(css, ns, states, { file, what }) {
  const failures = [];
  const MIX_RE = new RegExp(`^color-mix\\(\\s*in srgb\\s*,\\s*var\\((--${ns}-[a-z0-9-]+)\\)\\s+(\\d+(?:\\.\\d+)?)%\\s*,\\s*var\\((--${ns}-[a-z0-9-]+)\\)\\s*\\)$`);
  const VAR_RE = new RegExp(`^var\\((--${ns}-[a-z0-9-]+)\\)$`);
  const parsed = [];
  for (const s of states) {
    const m = MIX_RE.exec((s.chip ?? "").trim()), f = VAR_RE.exec((s.fill ?? "").trim());
    if (!m || !f) {
      failures.push(`${file}: ${s.name}: ${what} (${JSON.stringify(s.chip)}) must be color-mix(in srgb, var(--${ns}-*) N%, var(--${ns}-*)) and the fill beneath it (${JSON.stringify(s.fill)}) a single var(--${ns}-*) -- anything else and this gate cannot compute it`);
      continue;
    }
    const st = { name: s.name, ink: m[1], pct: Number(m[2]) / 100, base: m[3], fillVar: f[1] };
    if (st.base !== st.fillVar) failures.push(`${file}: ${s.name}: ${what} mixes over ${st.base} but the box paints ${st.fillVar} in that state`);
    if (st.ink !== `--${ns}-field-fg` || st.pct !== s.pct) failures.push(`${file}: ${s.name}: ${what} must mix --${ns}-field-fg at ${Math.round(s.pct * 100)}% (spec 2026-09-30 §2.2) -- got ${st.ink} at ${Math.round(st.pct * 100)}%`);
    parsed.push(st);
  }
  const blocks = fieldThemeBlocks(css, ns);
  if (blocks.length !== 15) failures.push(`${file}: the ${what} gate found ${blocks.length} theme blocks, expected 15 (14 themes + :root)`);
  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  let measured = 0;
  const lowest = { r: Infinity, where: "" };
  const ratios = [];
  for (const [id, vars] of blocks) {
    for (const s of parsed) {
      const ink = vars[s.ink], base = vars[s.base], fill = vars[s.fillVar];
      if (![ink, base, fill].every((v) => HEX.test(v ?? ""))) {
        failures.push(`${file} ${id}: ${s.ink}=${ink} / ${s.base}=${base} / ${s.fillVar}=${fill} is not a #rgb / #rrggbb hex -- the ${what} gate cannot compute it`);
        continue;
      }
      const a = hexToRgb(ink), b = hexToRgb(base), under = hexToRgb(fill);
      const chip = a.map((c, i) => Math.round(c * s.pct + b[i] * (1 - s.pct)));
      const r = contrast(chip, under);
      measured += 1;
      ratios.push(`${id}|${s.name}|${r.toFixed(6)}`);
      if (r < lowest.r) Object.assign(lowest, { r, where: `${id} ${s.name}` });
      if (!(r >= FILL_SEPARATE_MIN)) {
        failures.push(`${file} ${id}: ${s.name}: ${what} is ${r.toFixed(3)}:1 against the fill beneath it (${s.fillVar} ${fill}; chip = ${Math.round(s.pct * 100)}% ${s.ink} over ${s.base}) -- floor FILL_SEPARATE_MIN ${FILL_SEPARATE_MIN}`);
      }
    }
  }
  return { failures, measured, lowest, ratios, blocks: blocks.length };
}
// PBP_GATE_DUMP=1: one summary line per shared gate and surface, so a change
// to a helper can be diffed before / after (Task 7 fix round 1 evidence).
const gateDump = (line) => { if (process.env.PBP_GATE_DUMP === "1") console.log(line); };
const ratioHash = (xs) => createHash("sha256").update(xs.join("\n")).digest("hex").slice(0, 16);

// 1. The registry itself, EVERY surface's entries (stage 4 R1 / T6-g; Task 7
//    filled FIELD_TARGETS.lib and this loop covers it unchanged):
//    well-formed, parallel, and a strict specificity ladder rest < hover <
//    focus for EVERY box (spec §2.1: focus must win over hover by
//    specificity, never by source order -- the pointer can sit on a box the
//    keyboard focuses).
check(Object.keys(FIELD_TARGETS).sort().join(",") === "lib,pp" && Object.values(FIELD_TARGETS).every(Array.isArray),
  `ui-components.mjs: FIELD_TARGETS must be { pp: [...], lib: [...] } (options keeps its .fg recipe) -- got ${JSON.stringify(Object.keys(FIELD_TARGETS))}`);
for (const [ns, targets] of Object.entries(FIELD_TARGETS)) {
  check(new Set(targets.map((t) => t.id)).size === targets.length, `ui-components.mjs: FIELD_TARGETS.${ns} has duplicate ids`);
  for (const t of targets) {
    check(Object.keys(t).sort().join(",") === "chevron,focus,hover,id,passenger,placeholder,rest",
      `ui-components.mjs: FIELD_TARGETS.${ns} ${t.id} must carry exactly { id, rest, hover, focus, placeholder, passenger, chevron }`);
    const R = selectorListOf(t.rest), H = selectorListOf(t.hover), F = selectorListOf(t.focus);
    check(R.length > 0 && R.length === H.length && H.length === F.length,
      `ui-components.mjs: FIELD_TARGETS.${ns} ${t.id}: rest / hover / focus must be parallel non-empty lists (got ${R.length} / ${H.length} / ${F.length})`);
    R.forEach((rest, i) => {
      const hover = H[i] ?? "", focus = F[i] ?? "";
      const problems = fieldLadderProblems(rest, hover, focus);
      check(problems.length === 0,
        `ui-components.mjs: FIELD_TARGETS.${ns} ${t.id} box ${i} (\`${rest}\` / \`${hover}\` / \`${focus}\`): ${problems.join("; ")} (spec §2.1, ruling R1)`);
    });
    for (const sel of selectorListOf(t.placeholder)) {
      check(structuralCompound(subjectOf(sel)).pseudoElement === "placeholder",
        `ui-components.mjs: FIELD_TARGETS.${ns} ${t.id} placeholder selector \`${sel}\` does not end in ::placeholder`);
    }
  }
}
// The ladder grammar must discriminate -- on popup's shapes AND on the two
// library shapes Task 7 registered (spec §2.1: .xp-dict-lang keeps
// :focus-visible; the group unit's trigger is `:has(> input[type="text"]
// :focus)` and a disabled input takes no hover) -- FIELD_TARGETS.lib uses
// exactly the two passing shapes below. [rest, hover, focus, must pass]
{
  const LADDER_CASES = [
    // popup shapes
    [".tags-input-wrap", ".tags-input-wrap:hover:where(:not(:focus-within, :disabled))", ".tags-input-wrap:focus-within:not(:disabled)", true],
    ['.login-body .secret-field > input[type="password"]', '.login-body .secret-field:hover:where(:not(:focus-within)) > input[type="password"]:where(:not(:disabled))', '.login-body .secret-field:focus-within > input[type="password"]:not(:disabled)', true],
    // an .xp-dict-lang-like entry
    [".xp-dict-lang", ".xp-dict-lang:hover:where(:not(:focus-visible, :disabled))", ".xp-dict-lang:focus-visible:not(:disabled)", true],
    [".xp-dict-lang", ".xp-dict-lang:hover:where(:not(:focus, :disabled))", ".xp-dict-lang:focus-visible:not(:disabled)", false],
    [".xp-dict-lang", ".xp-dict-lang:hover:where(:not(:focus-visible))", ".xp-dict-lang:focus-visible:not(:disabled)", false],
    [".xp-dict-lang", ".xp-dict-lang:where(:hover:not(:focus-visible):not(:disabled))", ".xp-dict-lang:focus-visible", false],
    // the old `includes` prefix trap: :focus-visible does not excuse :focus
    ['.field > input[type="text"]', '.field > input[type="text"]:hover:where(:not(:focus-visible, :disabled))', '.field > input[type="text"]:focus:not(:disabled)', false],
    // a group-unit-like entry
    [".vocab-group-unit", '.vocab-group-unit:hover:where(:not(:has(> input[type="text"]:focus), :has(> input:disabled)))', '.vocab-group-unit:has(> input[type="text"]:focus):not(:disabled)', true],
    [".vocab-group-unit", '.vocab-group-unit:hover:where(:not(:has(> input:focus), :has(> input:disabled)))', '.vocab-group-unit:has(> input[type="text"]:focus):not(:disabled)', false],
    [".vocab-group-unit", '.vocab-group-unit:hover:where(:not(:has(> input[type="text"]:focus)))', '.vocab-group-unit:has(> input[type="text"]:focus):not(:disabled)', false],
    [".vocab-group-unit", '.vocab-group-unit:where(:hover:not(:has(> input[type="text"]:focus)):not(:has(> input:disabled)))', '.vocab-group-unit:has(> input[type="text"]:focus)', false],
    [".vocab-group-unit", '.vocab-group-unit:hover:where(:not(:has(> input[type="text"]:focus), :has(> input:disabled)))', ".vocab-group-unit:not(:disabled):not(.x)", false],
    // generic: equal specificity, a tie at focus, :hover on the wrong compound
    [".x", ".x:where(:hover:not(:focus, :disabled))", ".x:focus", false],
    [".x", ".x:hover:not(:focus, :disabled)", ".x:focus", false],
    [".s > input", ".s:where(:not(:focus-within)) > input:hover:where(:not(:disabled))", ".s:focus-within > input:not(:disabled)", false],
  ];
  const misjudged = LADDER_CASES.filter(([rest, hover, focus, want]) => (fieldLadderProblems(rest, hover, focus).length === 0) !== want);
  check(misjudged.length === 0,
    "ui-contract-tests.mjs: the FIELD_TARGETS ladder grammar (fieldLadderProblems) no longer discriminates -- misjudged: " + misjudged.map(([rest, hover, focus, want]) => `${want ? "false fail" : "missed"}: ${rest} / ${hover} / ${focus} -> ${JSON.stringify(fieldLadderProblems(rest, hover, focus))}`).join(" | "));
}
{
  const POPUP_NODES = htmlNodes(popupHtml);
  const PP_SCOPE = scanScopeOf(POPUP_NODES);
  const reaches = (sel, node) => selectorReaches(sel, node, PP_SCOPE);
  const PP = FIELD_TARGETS.pp;
  // The tree and the matcher must discriminate, or everything below is blind.
  const byId = (id) => POPUP_NODES.find((n) => n.attrs.id === id);
  const shell = POPUP_NODES.find((n) => n.classes.includes("tags-input-wrap"));
  check(!!byId("token-input") && !!byId("tags-input") && !!byId("description-input") && !!shell && !!PP_SCOPE && PP_SCOPE.classes.has("secret-field") && !PP_SCOPE.classes.has("ac-open") &&
    reaches('.login-body .secret-field > input[type="password"]', byId("token-input")) &&
    !reaches('.login-body .secret-field > input[type="text"]', byId("token-input")) &&
    reaches('.field > input[type="text"]', byId("title-input")) &&
    !reaches('.field > input[type="text"]', byId("tags-input")) &&
    reaches(".tags-input-wrap input", byId("tags-input")) &&
    reaches('html[data-theme] .field > textarea', byId("description-input")) &&
    structuralParts('html[data-theme="terminal"] .field > textarea').themed &&
    !reaches(".field + .field > textarea", byId("description-input")) &&
    // runtime state classes: allowed next to a real anchor, never alone on
    // the subject; a static class the node lacks still fails
    reaches(".tags-input-wrap.ac-open", shell) && !selectorReaches(".tags-input-wrap.ac-open", shell) &&
    !reaches(".tag-item", shell) && !reaches(".tags-input-wrap.hidden", shell) &&
    reaches('.is-busy .field > input[type="text"]', byId("title-input")) &&
    // content attributes only: an untyped <input> is NOT [type="text"]
    (() => {
      const [field, untyped] = htmlNodes('<div class="field"><input id="u" data-x="a b-c" lang="en-US" data-k="A" href="https://ex.com/a.png" hidden></div>');
      const r = (sel) => selectorReaches(sel, untyped);
      const throwsOn = (sel) => { try { r(sel); return false; } catch { return true; } };
      return !!field && !r('.field > input[type="text"]') && r(".field > input") && r("input[hidden]") && !r("input[type]") &&
        r('[data-x~="a"]') && r('[data-x~="b-c"]') && !r('[data-x~="b"]') && !r('[data-x~=""]') &&
        r('[lang|="en"]') && !r('[lang|="e"]') && r('[href^="https"]') && !r('[href^=""]') && r('[href$=".png"]') && !r('[href$=".jpg"]') &&
        r('[href*="ex.com"]') && !r('[href*="xyz"]') && r("[data-k=A]") && !r('[data-k="a"]') && r('[data-k="a" i]') &&
        r('[id="U" i]') && !r('[id="U"]') &&
        throwsOn("[ns|data-x]") && throwsOn('[data-x!="a"]') && throwsOn("[*|data-x]") && throwsOn('[data-x="a" q]');
    })() &&
    // an HTML case-insensitive attribute (type) matches either case unless `s` says otherwise
    (() => {
      const [inp] = htmlNodes('<input type="TEXT" id="t">');
      return selectorReaches('input[type="text"]', inp) && !selectorReaches('input[type="text" s]', inp);
    })() &&
    structuralText('.login-body .secret-field:hover:where(:not(:focus-within)) > input[type="text"]:where(:not(:disabled))') === '.login-body .secret-field > input[type="text"]',
    "ui-contract-tests.mjs: the popup.html tree / structural selector matcher no longer discriminates (the popup value-box model below would be blind)");
  // Scan mode vs strict mode (stage 4 final fix wave): a hand rule reaches a
  // box when the BROWSER can apply it -- runtime attributes on a compound
  // other than the subject (html[data-section] from popup-theme-early.js,
  // :root[data-theme], an aria-* / data-* state) and the sibling combinators
  // `+` / `~` (document order, plus elements a script inserts) included --
  // while strict mode, which the coverage count runs on, still reaches only
  // what the static markup proves. [selector, node id, scan reaches, strict reaches]
  const PP_SCAN_CASES = [
    ['html[data-section="login"] .secret-field > input[type="password"]', "token-input", true, false],
    ["html[data-theme] .field > textarea", "description-input", true, false],
    [':root[data-theme="nord-night"] .field > textarea', "description-input", true, false],
    // aria-busy IS in popup.html (#pinboard-suggest-tags), but it is a state
    // scripts toggle: satisfiable on any ancestor
    ['[aria-busy="true"] .field > textarea', "description-input", true, false],
    ['.row > .label + .field > input[type="text"]', "title-input", true, false],
    [".label ~ .field > textarea", "description-input", true, false],
    ['#tags-display + input[type="text"]', "tags-input", true, false],
    // a runtime-inserted sibling (popup-tags.js adds the chips)
    ['.tag-item ~ input[type="text"]', "tags-input", true, false],
    ['span + input[type="text"]', "tags-input", true, false],
    // must NOT reach: a structural attribute the markup carries stays exact,
    // the subject's attributes stay exact, and a static sibling the markup
    // proves absent stays absent
    ['[role="combobox"] .field > textarea', "description-input", false, false],
    [".field > textarea[data-never]", "description-input", false, false],
    [".field + .field > textarea", "description-input", false, false],
    ["#url-input ~ textarea", "description-input", false, false],
    ['.label + .field > input[type="text"]', "tags-input", false, false],
    ['#tags-autocomplete + input[type="text"]', "tags-input", false, false],
    ['html[data-section="login"] .secret-field > input[type="text"]', "token-input", false, false],
  ];
  const ppScanMisjudged = PP_SCAN_CASES.filter(([sel, id, scan, strict]) => reaches(sel, byId(id)) !== scan || selectorReaches(sel, byId(id)) !== strict);
  check(ppScanMisjudged.length === 0,
    "ui-contract-tests.mjs: the popup scan-mode matcher (runtime attributes off the subject, sibling combinators) or its strict coverage mode no longer discriminates -- misjudged: " +
    ppScanMisjudged.map(([sel, id, scan, strict]) => `${sel} on #${id}: scan ${reaches(sel, byId(id))} (want ${scan}), strict ${selectorReaches(sel, byId(id))} (want ${strict})`).join(" | "));

  for (const t of PP) {
    check(t.chevron === null, `ui-components.mjs: FIELD_TARGETS.pp ${t.id} has a chevron -- popup has no select, and pp emits no --pp-field-chevron (spec §2.2)`);
  }

  // 2. Coverage against popup.html (valueBoxCoverage above): every
  //    text-entry control is painted by exactly ONE registry entry -- as the
  //    box itself, or as the passenger of a shell that is -- and every entry
  //    reaches something.
  const cov = valueBoxCoverage(POPUP_NODES, PP);
  const { boxes: PP_BOX_NODES, passengers: PP_PASSENGER_NODES } = cov;
  check(cov.entries >= 6 && PP_BOX_NODES.size >= 6 && cov.uncovered.length === 0,
    `popup.html / FIELD_TARGETS.pp: every text-entry control must be painted by exactly one registry entry (as its box or as a shell's passenger) -- ${cov.entries} controls, ${PP_BOX_NODES.size} boxes; ${cov.uncovered.join(" | ") || "none uncovered"}`);
  check(cov.dead.length === 0, `ui-components.mjs: FIELD_TARGETS.pp entries whose rest selector reaches nothing in popup.html: ${cov.dead.map((t) => t.id).join(", ")}`);
  // The coverage model must discriminate: an untyped <input> in .field is a
  // text-entry control the typed `.field > input[type="text"]` does NOT
  // paint (it would render as a UA box), so it must come out uncovered.
  {
    const probe = valueBoxCoverage(htmlNodes('<div class="field"><input id="untyped"></div><div class="field"><input type="text" id="typed"></div><div class="tags-input-wrap"><input type="text" id="core"></div>'), PP);
    check(probe.entries === 3 && probe.uncovered.length === 1 && probe.uncovered[0].startsWith("#untyped:") && probe.passengers.size === 1,
      "ui-contract-tests.mjs: the popup coverage model no longer discriminates (an untyped <input> inside .field must be uncovered; a typed one and a shell passenger covered) -- got " + JSON.stringify(probe.uncovered));
    // The coverage count stays strict (final fix wave): an entry that reaches
    // a box only through a runtime attribute or a sibling combinator -- both
    // of which the scans below DO follow -- proves nothing about what the
    // shipped registry paints, so it covers nothing and reads as dead, and the
    // shipped registry's count is the one pinned in the gate dump.
    const scanOnly = [
      { id: "probe-runtime-attr", rest: 'html[data-section="main"] .field > textarea', passenger: null },
      { id: "probe-sibling", rest: '.row > .label + .field > input[type="text"]', passenger: null },
      { id: "probe-state-attr", rest: '[aria-busy="true"] .login-body .secret-field > input[type="password"]', passenger: null },
    ];
    const strictProbe = valueBoxCoverage(POPUP_NODES, scanOnly);
    check(strictProbe.boxes.size === 0 && strictProbe.dead.length === scanOnly.length &&
      scanOnly.every((t) => POPUP_NODES.some((n) => reaches(t.rest, n))),
      `ui-contract-tests.mjs: the popup coverage count must stay strict -- entries reaching a box only through a runtime attribute or a sibling combinator (which scan mode follows) must cover nothing; got ${strictProbe.boxes.size} box(es), dead ${JSON.stringify(strictProbe.dead.map((t) => t.id))}`);
  }
  gateDump(`[gate] coverage popup entries=${cov.entries} boxes=${PP_BOX_NODES.size} passengers=${PP_PASSENGER_NODES.size} uncovered=${cov.uncovered.length} dead=${cov.dead.length}`);
  // The two predicates every scan below uses: a rule on a box / a passenger
  // (pseudo-element subjects excluded -- ::placeholder has its own branch).
  const onNodes = (sel, nodes) => !structuralCompound(subjectOf(sel)).pseudoElement && [...nodes].some((n) => reaches(sel, n));
  const isPpBoxSelector = (sel) => onNodes(sel, PP_BOX_NODES);
  const isPpBoxOrPassengerSelector = (sel) => [...PP_BOX_NODES, ...PP_PASSENGER_NODES].some((n) => reaches(sel, n));

  // 3. The generated half: sync-all wrote every registry field with exactly
  //    the declarations the binding contract names (spec §4).
  const genStart = popupCss.indexOf("/* @generated:ui-components start (popup) */");
  const genEnd = popupCss.indexOf("/* @generated:ui-components end (popup) */");
  check(genStart >= 0 && genEnd > genStart, "popup.css: @generated:ui-components (popup) markers not found");
  const ppGen = popupCss.slice(genStart, genEnd);
  const ppEmission = fieldTargetEmissionProblems("pp", PP, ppGen, "popup.css");
  for (const problem of ppEmission.problems) check(false, problem);
  gateDump(`[gate] emission popup selectors=${ppEmission.checked} problems=${JSON.stringify(ppEmission.problems.map((m) => /`([^`]+)`/.exec(m)?.[1]))}`);

  // 4. The hand half keeps each box's ring (§7.3 `bordered`: the core is the
  //    generated focus border, the glow is here) on the entry's own focus
  //    selector (fieldRingSelectors), so ring and frame cannot fire in
  //    different states.
  const ppNoComments = popupCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const ppHand = stripGeneratedRegions(popupCss).replace(/\/\*[\s\S]*?\*\//g, "");
  const ppRing = fieldRingMissing("pp", PP, ppHand);
  for (const { id, sels } of ppRing.missing) {
    check(false, `popup.css: FIELD_TARGETS.pp ${id} has no hand-written ring (box-shadow: var(--pp-focus-ring)) on ${sels.map((sel) => `\`${sel}\``).join(", ")}`);
  }
  gateDump(`[gate] ring popup selectors=${ppRing.checked} missing=${JSON.stringify(ppRing.missing.flatMap((m) => m.sels))}`);

  // 5. The hand-written region paints no colour on a value box, a shell or
  //    a passenger (the generated region sits BEFORE it, so any such
  //    declaration would win a specificity tie by source order -- or out-rank
  //    it outright, as the ten html[data-theme] twins did). A passenger may be
  //    transparent and frameless and paint typed text var(--pp-field-fg); a
  //    placeholder is the registry's alone; no rule may unpaint a box side
  //    (border-width 0 / border-style none|hidden) or re-point a --pp-field-*
  //    role. Forced-colors (active) blocks are exempt: system colours by
  //    design; `forced-colors: none` is ordinary rendering and is scanned.
  const COLOUR_PROP = /^(?:color|-webkit-text-fill-color|background(?:-color)?|border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-color)?)$/;
  const WIDTH_OR_STYLE = /^border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?-(width|style)$/;
  const popupValueBoxOffenders = (css) => {
    const out = [];
    for (const rule of parseStyleRules(css)) {
      for (const d of parseDeclarations(rule.body)) {
        if (d.property.startsWith("--pp-field-")) out.push(`${rule.selectorText} { ${d.property}: ${d.value} } -- re-points a --pp-field-* role (the generated ui-themes blocks own them)`);
      }
      if (inForcedColors(rule)) continue;
      const decls = parseDeclarations(rule.body);
      for (const sel of rule.selectors) {
        const subject = structuralCompound(subjectOf(sel));
        if (subject.pseudoElement && subject.pseudoElement !== "placeholder") continue;
        const onBox = [...PP_BOX_NODES].some((n) => reaches(sel, n));
        const onPassenger = [...PP_PASSENGER_NODES].some((n) => reaches(sel, n));
        if (!onBox && !onPassenger) continue;
        const { themed } = structuralParts(sel);
        for (const d of decls) {
          const v = d.value.trim();
          if (subject.pseudoElement === "placeholder") {
            out.push(`${sel} { ${d.property}: ${v} } -- a hand rule restyles a value box's placeholder (FIELD_TARGETS.pp owns it)`);
            continue;
          }
          if (onPassenger && !onBox) {
            if (/^background(?:-color)?$/.test(d.property) && /^transparent$/i.test(v)) continue;
            if (d.property === "border" && /^(?:none|0)$/i.test(v)) continue;
            if (d.property === "color" && v === "var(--pp-field-fg)") continue;
            if (COLOUR_PROP.test(d.property)) out.push(`${sel} { ${d.property}: ${v} } -- a passenger may only be transparent and frameless, with typed text var(--pp-field-fg)`);
            continue;
          }
          if (COLOUR_PROP.test(d.property)) {
            out.push(`${sel} { ${d.property}: ${v} } -- ${themed ? "an html[data-theme] twin paints" : "a hand-written rule paints"} a popup value box (every colour is FIELD_TARGETS.pp's)`);
            continue;
          }
          const part = WIDTH_OR_STYLE.exec(d.property)?.[1];
          const tokens = v.split(/\s+/);
          if ((part === "width" && tokens.some((x) => /^0(?:\.0*)?(?:px|em|rem|%)?$/i.test(x))) || (part === "style" && tokens.some((x) => /^(?:none|hidden)$/i.test(x)))) {
            out.push(`${sel} { ${d.property}: ${v} } -- unpaints a side of a popup value box (Soft Fill keeps all four, spec §2.1)`);
          }
        }
      }
    }
    return out;
  };
  const ppBad = popupValueBoxOffenders(ppHand);
  check(ppBad.length === 0, "popup.css: the hand-written region paints a popup value box / shell / passenger (spec §3.2 -- colour comes only from FIELD_TARGETS.pp): " + ppBad.join(" | "));
  const PP_BOX_CASES = [
    ['.field > input[type="text"], .field > textarea { background: var(--pp-input-bg); color: var(--pp-fg); }', true],
    ["html[data-theme] .search-field { color: var(--pp-fg); }", true],
    ['html[data-theme] .field > input[type="text"]:focus { border-color: var(--pp-focus-bd); }', true],
    [".tags-input-wrap { border: 1px solid var(--pp-input-bd); }", true],
    ["#token-input:focus { border-color: var(--pp-focus-bd); }", true],
    [".login-body input { border-width: 1px 1px 0; }", true],
    [".search-field { border-style: solid hidden solid solid; }", true],
    [".tags-input-wrap input { color: var(--pp-fg); }", true],
    ["#tags-input { background: var(--pp-bg); }", true],
    [".search-field::placeholder { color: var(--pp-fg-hint); }", true],
    ['.field > input[type="text"]::placeholder { opacity: .5; }', true],
    ["#title-input { --pp-field-bg: #fff; }", true],
    // a runtime state class on a real box, and `forced-colors: none` (the
    // ordinary rendering, not a High Contrast exemption)
    [".tags-input-wrap.ac-open { border-color: var(--pp-focus-bd); }", true],
    ["@media (forced-colors: none) { .search-field { background: var(--pp-bg); } }", true],
    [".tags-input-wrap input { border: 1px solid var(--pp-border); }", true],
    // final fix wave: a sibling combinator and a runtime attribute off the
    // subject both reach a box in the browser (scan mode follows them)
    ['.row > .label + .field > input[type="text"] { background-color: var(--pp-bg2); }', true],
    ['html[data-section="main"] .field > textarea { background-color: var(--pp-bg2); border-bottom-color: red; }', true],
    [':root[data-theme="nord-night"] .search-field { color: var(--pp-fg); }', true],
    ['[aria-busy="true"] .login-body .secret-field > input[type="password"] { background: var(--pp-bg); }', true],
    ['.tag-item ~ input[type="text"] { color: var(--pp-fg); }', true],
    // must stay clean
    [".field + .field > textarea { background-color: var(--pp-bg2); }", false],
    [".tags-input-wrap input { border: none !important; outline: none; background: transparent; }", false],
    [".search-field { width: 100%; border-width: 1px; border-style: solid; border-radius: var(--pp-radius-md); }", false],
    [".tags-input-wrap:focus-within:not(:disabled) { box-shadow: var(--pp-focus-ring); }", false],
    [".tags-input-wrap.ac-open { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }", false],
    ['html[data-theme="terminal"] .field > textarea { font-family: monospace; }', false],
    [".tag-item { background: var(--pp-tag-bg); color: var(--pp-tag-chip-fg); }", false],
    [".login-body .key-toggle { background: none; border: 0; color: var(--pp-field-placeholder); }", false],
    ["@media (forced-colors: active) { .search-field:focus-visible { outline: 1px solid Highlight; border-color: Highlight; } }", false],
    [".ac-item { color: var(--pp-fg); }", false],
  ];
  const ppMisjudged = PP_BOX_CASES.filter(([css, want]) => (popupValueBoxOffenders(css).length > 0) !== want);
  check(ppMisjudged.length === 0,
    "ui-contract-tests.mjs: the popup value-box scan no longer discriminates -- misjudged: " + ppMisjudged.map(([css, want]) => `${want ? "missed" : "false hit"}: ${css}`).join(" | "));

  // 5b. Shape (stage 4 T6-b; the module-level valueBoxShapeOffenders options
  //     runs too): no hand rule draws a popup value box apart from its one
  //     frame colour and one radius -- no bottom-side border property, no
  //     split border-color, no multi-value border-radius or per-corner radius
  //     longhand. The one named exception (spec §2.1): the tags shell squares
  //     its two bottom corners to 0 while its suggestion list is open
  //     (.tags-input-wrap.ac-open), by selector, property and value.
  const PP_SHAPE_EXEMPT = [{ selector: ".tags-input-wrap.ac-open", properties: ["border-bottom-left-radius", "border-bottom-right-radius"], value: "0" }];
  const ppShapeExempt = (sels, d) => PP_SHAPE_EXEMPT.some((e) => sels.every((sel) => sel === e.selector) && e.properties.includes(d.property) && d.value.trim() === e.value);
  const ppShapeOffenders = (css) => valueBoxShapeOffenders(css, isPpBoxSelector, { ns: "pp", exempt: ppShapeExempt });
  const ppShapeBad = ppShapeOffenders(ppHand);
  check(ppShapeBad.length === 0,
    "popup.css: a hand-written value-box rule draws a bottom edge or splits the radius (stage 4: one frame colour on all four sides, one md radius on all four corners; only .tags-input-wrap.ac-open's two bottom corners are exempt): " + ppShapeBad.join(" | "));
  const PP_SHAPE_CASES = [
    [".tags-input-wrap.ac-open { border-bottom-left-radius: 4px; }", true],
    [".tags-input-wrap.ac-open { border-bottom-color: var(--pp-field-border-focus); }", true],
    [".tags-input-wrap { border-bottom-left-radius: 0; }", true],
    [".search-field { border-radius: var(--pp-radius-md) var(--pp-radius-md) 0 0; }", true],
    [".field > textarea { border-bottom: 1px solid var(--pp-field-border); }", true],
    ["#token-input { border-top-left-radius: 0; }", true],
    ['.field > input[type="text"] { border-color: var(--pp-field-border) var(--pp-field-border) var(--pp-field-border-focus); }', true],
    // final fix wave: a runtime attribute off the subject, a sibling combinator
    ['html[data-section="main"] .field > textarea { background-color: var(--pp-bg2); border-bottom-color: red; }', true],
    ['.row > .label + .field > input[type="text"] { border-bottom-color: red; }', true],
    ['html[data-section="login"] .secret-field > input[type="password"] { border-top-left-radius: 0; }', true],
    // must stay clean
    [".field + .field > textarea { border-bottom-color: red; }", false],
    [".tags-input-wrap.ac-open { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }", false],
    [".search-field { border-radius: var(--pp-radius-md); }", false],
    [".tags-input-wrap input { border: none !important; border-radius: 0 var(--pp-radius-sm) 0 0; }", false],
    [".tag-item { border-radius: var(--pp-radius-tag) var(--pp-radius-tag) 0 0; }", false],
    [".autocomplete-dropdown { border-radius: 0 0 var(--pp-radius-md) var(--pp-radius-md); border-top: 0; }", false],
  ];
  const ppShapeMisjudged = PP_SHAPE_CASES.filter(([css, want]) => (ppShapeOffenders(css).length > 0) !== want);
  check(ppShapeMisjudged.length === 0,
    "ui-contract-tests.mjs: the popup value-box shape scan no longer discriminates -- misjudged: " + ppShapeMisjudged.map(([css, want]) => `${want ? "missed" : "false hit"}: ${css}`).join(" | "));

  // 6. A colour literal inside a url() of a value-box / shell / passenger rule
  //    (%23<hex>, #<hex>, rgb(), hsl() -- stage 4 T6-d, Task 4's module-level
  //    valueBoxUrlColourOffenders): the bare hex scan cannot see it (spec
  //    §5.1), and popup has no chevron to excuse one. Whole file, generated
  //    regions included; pseudo-elements count (anything drawn on the box).
  const ppUrlOffenders = (css) => valueBoxUrlColourOffenders(css, isPpBoxOrPassengerSelector);
  check(ppUrlOffenders(ppNoComments).length === 0, "popup.css: a value-box rule carries a colour literal inside url() -- " + ppUrlOffenders(ppNoComments).join(" | "));
  check(ppUrlOffenders('.search-field { background-image: url("data:image/svg+xml,%3Csvg stroke=%22%23888%22/%3E"); }').length === 1 &&
    ppUrlOffenders(".tags-input-wrap > input[type=\"text\"] { background: url(\"data:image/svg+xml,%3Csvg stroke='#888'%3E%3C/svg%3E\") no-repeat; }").length === 1 &&
    // final fix wave: a runtime attribute off the subject, a sibling combinator
    ppUrlOffenders('html[data-section="main"] .field > textarea { background-image: url("data:image/svg+xml,%3Csvg stroke=%22%23888%22/%3E"); }').length === 1 &&
    ppUrlOffenders('.row > .label + .field > input[type="text"] { background-image: url("data:image/svg+xml,%3Csvg stroke=%22%23888%22/%3E"); }').length === 1 &&
    ppUrlOffenders('.stag { background-image: url("data:image/svg+xml,%3Csvg stroke=%22%23888%22/%3E"); }').length === 0 &&
    ppUrlOffenders(".search-field { background-image: var(--pp-field-bg); }").length === 0,
    "ui-contract-tests.mjs: the popup url() colour scan no longer discriminates");

  // 7. The eye paints the field's secondary ink at rest and its typed-text
  //    ink on hover, and its inset ring's core is the field's own focus
  //    border (spec §6 item 6; options' P7) -- on every surface, no twin.
  const eyeInk = parseStyleRules(ppHand).filter((r) => !inForcedColors(r) &&
    r.selectors.some((sel) => { const s = structuralCompound(subjectOf(sel)); return !s.pseudoElement && s.classes.includes("key-toggle"); }))
    .flatMap((r) => parseDeclarations(r.body).filter((d) => d.property === "color").map((d) => ({ r, d })));
  const eyeWrong = eyeInk.filter(({ r, d }) => {
    const hover = r.selectors.every((sel) => /:hover\b/.test(subjectOf(sel)));
    return /^html\[data-theme/.test(r.selectorText) || d.value.trim() !== (hover ? "var(--pp-field-fg)" : "var(--pp-field-placeholder)");
  });
  check(eyeInk.length >= 2 && eyeWrong.length === 0,
    "popup.css: the eye's ink must be var(--pp-field-placeholder) at rest and var(--pp-field-fg) on hover, with no html[data-theme] twin -- " + (eyeWrong.map(({ r, d }) => `${r.selectorText} { color: ${d.value} }`).join(" | ") || `found ${eyeInk.length} eye colour rule(s)`));
  check(declarationValueMap(ppHand, ".login-body .secret-field .key-toggle:focus-visible").get("outline") === "2px solid var(--pp-field-border-focus)",
    "popup.css: the eye's inset focus ring must use --pp-field-border-focus (it sits on the field fill; options' P7)");

  // 8. Chips and the suggestion list (spec §2.2 / §3.2).
  check(declarationValueMap(ppHand, ".tag-item").get("color") === "var(--pp-tag-chip-fg)" &&
    declarationValueMap(ppHand, ".tag-remove").get("color") === "var(--pp-tag-chip-icon)",
    "popup.css: .tag-item text must be var(--pp-tag-chip-fg) and .tag-remove's resting ink var(--pp-tag-chip-icon) (derived against the shell's rest / hover fills and --pp-tag-hover)");
  // The hover ink is derived too (2026-10-02): raw --pp-danger fell under 3:1
  // on a hovered chip in dracula / flexoki-dark / catppuccin-mocha. Every
  // hand-written rule that colours .tag-remove on hover must use the derived
  // role, so a themed override cannot quietly put danger back.
  {
    const hoverInks = parseStyleRules(ppHand)
      .filter((r) => r.selectors.some((sel) => /\.tag-remove:hover\b/.test(sel)))
      .map((r) => [r.selectorText, parseDeclarations(r.body).find((d) => d.property === "color")?.value])
      .filter(([, v]) => v !== undefined);
    check(hoverInks.length >= 1 && hoverInks.every(([, v]) => v === "var(--pp-tag-chip-icon-hover)"),
      `popup.css: .tag-remove:hover must be coloured var(--pp-tag-chip-icon-hover) (>=3:1 on every chip backdrop), got ${JSON.stringify(hoverInks)}`);
  }
  check(declarationValueMap(ppHand, ".autocomplete-dropdown").get("border") === "1px solid var(--pp-field-border-focus)",
    "popup.css: the autocomplete list's frame must be var(--pp-field-border-focus) -- the same token the focused tags shell paints");

  // 9. Retired on popup: the input-bd custom property (no consumer since
  //    stage 4; the pilot key stays the composer's framed-field signal), the
  //    fg-soft literal the eye used to read, and any :has() (spec §2.1).
  check(!/--pp-input-bd\b/.test(ppNoComments), "popup.css: --pp-input-bd is back -- the value boxes paint --pp-field-border (popup-chrome.mjs no longer emits the role)");
  check(!/--pp-fg-soft\b/.test(ppNoComments), "popup.css: --pp-fg-soft is back -- the eye's ink is --pp-field-placeholder");
  check(!/:has\(/.test(ppNoComments), "popup.css: a :has() selector -- popup adds none (spec §2.1; the tags list toggles .ac-open by class to keep :has() off the keystroke path)");

  // 10. Forced colours (spec §6 item 10, ruling R5): the UA drops the
  //     box-shadow ring and remaps the focus frame, so every popup value box
  //     draws `outline: 1px solid Highlight` (a non-negative offset) inside
  //     @media (forced-colors: active) on each of its entry's ring selectors
  //     (fieldRingSelectors -- the shells keep :focus-within), and no
  //     outline-suppressing rule that can apply while the box holds focus --
  //     a focus, hover or stateless rule (suppressorExcludedBy) -- out-ranks it on
  //     the same popup.html box (the shared forcedOutlineReport).
  //     §7.3's forced-colors branch above holds the outline's own shape.
  const ppForcedReport = (text) => forcedOutlineReport(text, {
    targetsOf: (sel) => [...PP_BOX_NODES].filter((n) => reaches(sel, n)),
    required: PP.flatMap((t) => fieldRingSelectors(t).map((sel) => ({ label: `${t.id}: ${sel}`, sel }))),
  });
  const ppForced = ppForcedReport(ppNoComments);
  check(ppForced.missing.length === 0,
    "popup.css: a popup value box has no forced-colors focus outline (1px solid Highlight, non-negative offset, on its registry entry's ring selector) -- spec 2026-09-30 §6 item 10 / R5: " + ppForced.missing.join(" | "));
  check(ppForced.outranked.length === 0,
    "popup.css: an outline-suppressing rule that can apply while the box holds focus out-ranks the forced-colors value-box outline, so High Contrast shows no focus: " + ppForced.outranked.join(" | "));
  const PP_FORCED_CASES = [
    // appended to the shipped file: [rule, must be caught]
    ['html[data-theme] .field > input[type="text"]:focus { outline: none !important; }', true],
    [".tags-input-wrap:focus-within:not(:disabled):not(.x) { outline: none; }", true],
    ["#token-input:focus-visible:not(:disabled):not(.a):not(.b):not(.c) { outline-style: none; }", true],
    ["@media (forced-colors: active) { #search-input:focus { outline: 0; } }", true],
    // Task 7 fix round 1: a hover rule applies while the pointer rests on a
    // keyboard-focused box, a stateless one always -- both can erase the
    // only Highlight edge
    [".field > textarea:hover { outline: none !important; }", true],
    [".field > textarea { outline: none !important; }", true],
    ["#search-input { outline-style: none; }", true],
    // Task 7 fix round 2: a :not(<trigger>) excludes nothing on a shell (it
    // never takes focus itself) or on an ancestor (it contains the focused
    // box, it is not focused)
    [".tags-input-wrap:not(:focus-visible) { outline: none !important; }", true],
    [".tags-input-wrap:not(:focus) { outline: none !important; }", true],
    [".field:not(:focus) > textarea:focus { outline: none !important; }", true],
    // the token field's outline hangs on the SHELL's :focus-within: the eye
    // can hold focus while the input shows the outline, so :not(:focus) on
    // the input excludes nothing either
    ['.login-body .secret-field > input[type="password"]:not(:focus) { outline: none !important; }', true],
    // final fix wave: a sibling combinator and a runtime attribute off the
    // subject reach the box in the browser; a :not(:focus-within) on a
    // SIBLING compound (the label beside the field) excludes nothing -- only
    // an ancestor of the box contains its focus
    ['.row > .label + .field > input[type="text"] { outline: none !important; }', true],
    ['html[data-section="login"] .secret-field > input[type="password"] { outline: none !important; }', true],
    [':root[data-theme] .tags-input-wrap:focus-within { outline: none !important; }', true],
    ['.row > .label:not(:focus-within) + .field > textarea:focus { outline: none !important; }', true],
    ['.label:not(:focus-within) ~ .field > input[type="text"]:focus { outline: none !important; }', true],
    // must stay clean
    // an ancestor linked to the rest by a sibling step further down is still
    // an ancestor (.row contains the .label AND the .field beside it)
    [".row:not(:focus-within) > .label + .field > textarea:focus { outline: none !important; }", false],
    [".field + .field > textarea:focus { outline: none !important; }", false],
    ["@media (forced-colors: none) { .search-field:focus { outline: none !important; } }", false],
    [".tags-input-wrap input:focus { outline: none !important; }", false],
    [".search-field:focus { outline: none; }", false],
    [".search-field { outline: none; }", false],
    [".field > textarea:not(:focus) { outline: none !important; }", false],
    [".field > textarea:disabled { outline: none !important; }", false],
    [".field:not(:focus-within) > textarea { outline: none !important; }", false],
    [".tags-input-wrap:not(:focus-within) { outline: none !important; }", false],
    ['.login-body .secret-field:not(:focus-within) > input[type="password"] { outline: none !important; }', false],
  ];
  const ppForcedMisjudged = PP_FORCED_CASES.filter(([rule, want]) => (ppForcedReport(`${ppNoComments}\n${rule}`).outranked.length > ppForced.outranked.length) !== want);
  const ppForcedNone = ppForcedReport(ppNoComments.replace(/forced-colors\s*:\s*active/g, "forced-colors: none"));
  check(ppForcedMisjudged.length === 0 && ppForcedNone.missing.length === PP.flatMap(fieldRingSelectors).length,
    "ui-contract-tests.mjs: the popup forced-colors value-box focus scan no longer discriminates -- misjudged: " + ppForcedMisjudged.map(([rule, want]) => `${want ? "missed" : "false hit"}: ${rule}`).join(" | ") +
    ` (with every forced-colors block flipped to none, ${ppForcedNone.missing.length}/${PP.flatMap(fieldRingSelectors).length} ring selectors reported missing)`);
  gateDump(`[gate] forced popup missing=${JSON.stringify(ppForced.missing)} outranked=${JSON.stringify(ppForced.outranked)} none-missing=${ppForcedNone.missing.length}`);
  for (const [rule] of PP_FORCED_CASES) gateDump(`[gate] forced popup case ${ppForcedReport(`${ppNoComments}\n${rule}`).outranked.length > ppForced.outranked.length ? "CAUGHT" : "clean "} ${rule}`);
}

check(/\.wayback-log-row:focus-within\s+\.wayback-perm-tip/.test(optionsCss) &&
  /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.wayback-log-row:hover\s+\.wayback-perm-tip/.test(optionsCss) &&
  optionsCss.includes("background: var(--opt-panel)") &&
  optionsCss.includes("color: var(--opt-fg)"),
  "options.css: archive permission guidance lacks themed focus disclosure, or its hover half escaped the fine-pointer gate");
// options' .confirm-yes clause was dropped from this list (Task 10,
// COMPONENTS.md §4.2/C14b): the generated ui-components region now emits
// ".confirm-popover .confirm-yes"/":hover" with no theme gate and no
// fallback at all (var(--opt-danger)/var(--opt-on-danger) directly), and
// recipe-lint's solidDangerScope/dangerPaired [static] checks pin
// dangerRules() to emitting exactly one self-paired .confirm-yes rule -- so
// the CURRENT source has no hardcoded default left for a themed override to
// out-rank. That is not the same as "can never regress": recipe-lint only
// looks at ui-components.mjs's own recipe source/output, and
// css-region-audit only diffs the generated region against it -- neither
// one scans the HAND-WRITTEN area of options.css for someone re-adding a
// literal `html[data-theme] .confirm-popover .confirm-yes { background:
// #c00 }` override by hand later (a new selector there is legal content as
// far as both gates are concerned). Low risk, not zero risk -- and that
// residual risk is what the class-level `.confirm-yes` paint gate at the
// bottom of this file now closes, for all three surfaces at once.
//
// popup's .confirm-yes clause left this list for the same reason options'
// did (campaign C3a): the solid tier is emitted for pp too now, and the
// themed warn-family override it used to pin here is deleted. The surviving
// .confirm-no clause moved from --pp-warn-bg to --pp-btn-hover in the same
// commit -- what this line guards is "a per-theme token, not a literal",
// and the popover is a neutral card now rather than a warning-coloured one.
check(popupCss.includes("html[data-theme] .confirm-popover .confirm-no:hover { background: var(--pp-btn-hover)") &&
  optionsCss.includes("html[data-theme] .theme-name-popover .tnp-save:hover { background: var(--opt-fg)"),
  "custom themed popovers can fall back to hardcoded hover backgrounds with unreadable foregrounds");
{
  const failed = mdTranslateJs.slice(mdTranslateJs.indexOf("function _pbpTrMarkFailed"),
    mdTranslateJs.indexOf("function _pbpTrMarkPartial"));
  const partial = mdTranslateJs.slice(mdTranslateJs.indexOf("function _pbpTrMarkPartial"),
    mdTranslateJs.indexOf("function _pbpTrClearPendingFailures"));
  check(failed.includes("btn.dataset.tip") && partial.includes("btn.dataset.tip") &&
    failed.includes('btn.setAttribute("aria-label"') && partial.includes('btn.setAttribute("aria-label"') &&
    !failed.includes("btn.title") && !partial.includes("btn.title") &&
    mdCss.includes(".pb-tr-err::after") && mdCss.includes("content: attr(data-tip)"),
    "translation failure reasons still depend on native title tooltips or lack a themed hover/focus surface");
}
{
  const upsert = popupAiJs.slice(popupAiJs.indexOf("function upsertSummary"),
    popupAiJs.indexOf("// ---- Remove AI summary"));
  const setupAi = popupAiJs.slice(popupAiJs.indexOf("function setupAIFeatures"),
    popupAiJs.indexOf("function _aiSummaryBlockMatches"));
  check(!popupAiJs.includes('const AI_SUMMARY_TAG = "[AI Summary]"') &&
    !upsert.includes("AI_SUMMARY_TAG") &&
    popupAiJs.includes("function pbpAiTrackSummaryRange") &&
    popupAiJs.includes("function pbpAiRemoveSummaryRange") &&
    setupAi.includes("pbpAiTrackSummaryRange") &&
    setupAi.includes("_aiResetSummaryActions()") &&
    setupAi.includes('t("aiSummaryMerged")') &&
    sharedJs.includes("const _AI_BQ_REGEX_SHARED") &&
    sharedJs.includes("legacy"),
    "popup AI summary ownership still writes a marker, lacks fail-closed range tracking, or dropped legacy recognition");
}

{
  // optionsTabs used to stop at the FIRST nested </div> -- inside .tabs
  // that's the close of .tab-group-label (158 chars, 0 .tab-btn), so
  // !optionsTabs.includes('id="reset-panel-btn"') was vacuously true no
  // matter what optionsHtml contained. Walk div depth to the real matching
  // close instead (HTML comments blanked first so a `<!-- <div> -->` aside
  // can't perturb the count) -- the balanced extent is 2816 chars / 13
  // .tab-btn today, with reset-panel-btn sitting just outside it.
  const tabsStart = optionsHtml.indexOf('<div class="tabs"');
  const commentless = optionsHtml.replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length));
  const divRe = /<div\b|<\/div>/g;
  divRe.lastIndex = tabsStart;
  let depth = 0, tabsEnd = -1, dm;
  while ((dm = divRe.exec(commentless))) {
    depth += dm[0] === "</div>" ? -1 : 1;
    if (depth === 0) { tabsEnd = dm.index + dm[0].length; break; }
  }
  const optionsTabs = tabsEnd === -1 ? "" : optionsHtml.slice(tabsStart, tabsEnd);
  const tabBtnCount = (optionsTabs.match(/class="tab-btn/g) || []).length;
  check(tabBtnCount >= 13,
    `options.html: balanced .tabs extent only has ${tabBtnCount} .tab-btn (expected >= 13) -- the extent may be truncated again`);
  check(!optionsTabs.includes('id="reset-panel-btn"') && /id="mobile-tab-select"/.test(optionsHtml),
    "options.html: reset action remains inside tablist or mobile category select is missing");
}
check(/mobileTabSelect\.value = btn\.dataset\.panel/.test(optionsJs) &&
  /mobileTabSelect\?\.addEventListener\("change"/.test(optionsJs),
  "options.js: desktop tabs and mobile category select can drift");

// K114 (a11y self-certifying fixture retirement, 2026-09): the options
// tablist's ARIA shape and roving-tabindex + arrow-key contract, and the
// popup Recent-row edit/delete controls' accessible-name contract, used to
// be pinned only by hand-built fixtures in tests/a11y-tests.html that never
// loaded this source (G1 there had already drifted from shipped popup.js --
// popup.js ships native <button>s, the fixture built a role=button span --
// and stayed green regardless). These check the shipped source text
// directly; tests/a11y-tests.html keeps the behavioural shape snapshots for
// what can't be checked statically (G2/G3/G4), now honestly labelled as such.
check(/<div class="tabs" role="tablist" aria-orientation="vertical">/.test(optionsHtml),
  "options.html: .tabs lost role=tablist or aria-orientation=vertical");
{
  const tabBtnTags = [...optionsHtml.matchAll(/<button class="tab-btn[^>]*>/g)].map((m) => m[0]);
  check(tabBtnTags.length > 0, "options.html: found no .tab-btn buttons");
  const offenders = tabBtnTags.filter((tag) => {
    const controls = (tag.match(/aria-controls="([^"]+)"/) || [])[1];
    return !/role="tab"/.test(tag) || !controls || !optionsHtml.includes(`id="${controls}"`);
  });
  check(offenders.length === 0,
    "options.html: a .tab-btn lost role=tab or points aria-controls at a panel id that doesn't exist -> " + offenders.join(", "));
}
check(/btn\.tabIndex = btn\.classList\.contains\("active"\) \? 0 : -1;/.test(optionsJs),
  "options.js: tab button roving-tabindex init is missing (btn.tabIndex = ...active ? 0 : -1)");
{
  const kdStart = optionsJs.indexOf('_tabBtns.forEach((btn, i) => {');
  const kdEnd = kdStart < 0 ? -1 : optionsJs.indexOf("mobileTabSelect?.addEventListener", kdStart);
  const kdBody = kdStart < 0 || kdEnd < 0 ? "" : optionsJs.slice(kdStart, kdEnd);
  check(/e\.key === "ArrowDown"/.test(kdBody) && /e\.key === "ArrowUp"/.test(kdBody) &&
    /activateTab\(_tabBtns\[n\]\)/.test(kdBody) && /_tabBtns\[n\]\.focus\(\)/.test(kdBody),
    "options.js: tab keydown handler lost the ArrowDown/ArrowUp roving-focus branches");
}
{
  // Native <button> needs no role/tabindex/keydown of its own -- the
  // contract that matters post-fix is the accessible name (title +
  // aria-label pair), not the ARIA-widget shape the retired fixture pinned.
  const editIdx = popupJs.indexOf('const edit = document.createElement("button");');
  const delIdx = popupJs.indexOf('const del = document.createElement("button");');
  check(editIdx >= 0 && delIdx >= 0,
    "popup.js: recent-row edit/delete controls are no longer built as <button> elements");
  const editSlice = editIdx >= 0 && delIdx > editIdx ? popupJs.slice(editIdx, delIdx) : "";
  const delEnd = delIdx >= 0 ? popupJs.indexOf("showConfirmPopover(del,", delIdx) : -1;
  const delSlice = delIdx >= 0 && delEnd > delIdx ? popupJs.slice(delIdx, delEnd) : "";
  check(/edit\.title = /.test(editSlice) && /edit\.setAttribute\("aria-label", /.test(editSlice),
    "popup.js: recent-row edit button lost its title/aria-label pair");
  check(/del\.title = /.test(delSlice) && /del\.setAttribute\("aria-label", /.test(delSlice),
    "popup.js: recent-row delete button lost its title/aria-label pair");
}

// K72 (2026-09, opt-wave C): the popup save form's two keyboard affordances.
// 甲 -- Alt+P/R/A must reach the checkboxes through .click(), because that is
// the only path that runs their change listeners (_archiveUserTouched, and the
// web.archive.org host request that needs this keydown's user activation); a
// `.checked = !checked` refactor would look identical on screen and silently
// break both. 乙 -- the chip groups are one Tab stop each, held by the
// CONTAINER: pinning the stop to a chip would drop the whole group out of the
// keyboard order the moment the user adopts that chip (the #88 root cause).
for (const [id, keys] of [["private-check", "Alt+P"], ["readlater-check", "Alt+R"], ["archive-check", "Alt+A"]]) {
  const tag = (popupHtml.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`)) || [])[0] || "";
  check(tag.includes(`aria-keyshortcuts="${keys}"`),
    `popup.html: #${id} no longer announces ${keys} via aria-keyshortcuts`);
}
check(/const PBP_ALT_CHECKBOX_CODES = \{ KeyP: "private-check", KeyR: "readlater-check", KeyA: "archive-check" \};/.test(popupJs) &&
  /PBP_ALT_CHECKBOX_LETTERS\[String\(e\.key\)\.toLowerCase\(\)\]/.test(popupJs),
  "popup.js: the Alt+P/R/A table lost its e.code or its e.key half -- one of macOS (composed Alt+letter) or AZERTY/Dvorak (physical key) loses the shortcut");
{
  // Bounded to THIS handler, not sliced to EOF: an unrelated `box.checked =`
  // added anywhere later in popup.js would otherwise trip a K72-labelled
  // assertion and send the next reader hunting in the wrong place.
  const altStart = popupJs.indexOf("const PBP_ALT_CHECKBOX_CODES =");
  const altEnd = altStart < 0 ? -1 : popupJs.indexOf("\n});", altStart);
  check(altStart >= 0 && altEnd > altStart,
    "popup.js: the Alt hotkey keydown handler no longer ends in a recognizable `});` -- the K72 甲 gates below are slicing nothing");
  const altBody = altStart >= 0 && altEnd > altStart ? popupJs.slice(altStart, altEnd + 3) : "";
  check(/\bbox\.click\(\);/.test(altBody) && !/\bbox\.checked\s*=/.test(altBody),
    "popup.js: the Alt+P/R/A handler stopped routing through box.click() -- the checkboxes' own change listeners would no longer run");
  check(/mainSection\.classList\.contains\("hidden"\)/.test(altBody) && /mainSection\.classList\.contains\("unsupported-url"\)/.test(altBody),
    "popup.js: the Alt+P/R/A handler lost a visibility gate -- it would toggle checkboxes the user cannot see");
}
{
  const rovStart = popupTagsJs.indexOf("function syncSuggestTagStates() {");
  const rovEnd = popupTagsJs.indexOf("// Alt+1..9 slot assignment", rovStart);
  const rov = rovStart >= 0 && rovEnd > rovStart ? popupTagsJs.slice(rovStart, rovEnd) : "";
  check(rov.includes("pbpSyncRovingToolbars();"),
    "popup-tags.js: syncSuggestTagStates no longer drives the roving-toolbar maintenance -- a chip rebuild would leave chips in the tab sequence");
  check(/c\.addEventListener\("(?:focusin|focusout|keydown)"/.test(rov) &&
    !/document\.addEventListener\(\s*"(?:focusin|focusout|keydown)"/.test(rov),
    "popup-tags.js: a roving listener moved onto document -- it would race the #tags-input ArrowUp/Down autocomplete handler");
  check(/c\.setAttribute\("role", "toolbar"\)/.test(rov) && !/"listbox"/.test(rov),
    "popup-tags.js: the chip groups must be role=toolbar; listbox belongs to #tags-autocomplete (#tags-input aria-controls it)");
  check(/c\.removeAttribute\("tabindex"\)/.test(rov),
    "popup-tags.js: a chip group with no chips would keep a dead tab stop");
  check(/el\.tabIndex = -1;/.test(rov),
    "popup-tags.js: chips/Add all are no longer pushed out of the tab sequence");
}
// K72 fix round 1: the cache-hit AI render appends two .regen-link anchors
// INSIDE the already-role=toolbar #ai-suggest-tags, after the chips. Two ways
// that silently re-adds tab stops, so both are pinned: the ring's selector has
// to name .regen-link, and renderAITags' single pbpAssignAltNumBadges() call
// has to run AFTER the fromCache branch has appended them.
check(/const PBP_ROVING_EXTRA_ITEMS = "\.add-all-link, \.regen-link";/.test(popupTagsJs),
  "popup-tags.js: the roving ring's non-chip members no longer include .regen-link -- the cached-AI state goes back to three tab stops for one group");
{
  const renderStart = popupAiJs.indexOf("function renderAITags(tags, fromCache) {");
  const cacheBranch = renderStart < 0 ? -1 : popupAiJs.indexOf("  if (fromCache) {", renderStart);
  // indexOf FROM cacheBranch, not lastIndexOf over the whole file (F6, final
  // review): a whole-file lastIndexOf only happens to land on the call this
  // gate wants because it is today's LAST of three -- any later function that
  // adds a fourth call anywhere below this one would keep winning that race
  // and the gate would stop failing even if the call inside the cache branch
  // were deleted. Anchoring to cacheBranch makes it find the first (and only
  // needed) call at or after the branch, however many more appear later.
  const slotInCacheBranch = renderStart < 0 ? -1 : popupAiJs.indexOf("pbpAssignAltNumBadges();", cacheBranch);
  check(renderStart >= 0 && cacheBranch > renderStart && slotInCacheBranch > cacheBranch,
    "popup-ai.js: renderAITags re-slots Alt+N / the roving toolbar BEFORE its fromCache branch appends the regen links -- they would keep their native tabindex");
}
check(/^\s*syncSuggestTagStates\(\);/m.test(popupTagsJs.slice(popupTagsJs.indexOf("function pbpAssignAltNumBadges()"))),
  "popup-tags.js: pbpAssignAltNumBadges no longer opens with syncSuggestTagStates() -- the second rebuild single point would stop re-applying the roving state");
for (const id of ["tag-presets", "ai-suggest-tags", "pinboard-suggest-tags"]) {
  const tag = (popupHtml.match(new RegExp(`<div id="${id}"[^>]*>`)) || [])[0] || "";
  check(/data-i18n-aria="/.test(tag),
    `popup.html: #${id} lost its localized accessible name -- role=toolbar with no name announces as an unlabelled group`);
}

check(/result && typeof result\.catch === "function"\) result\.catch\(reportConfirmError\)/.test(sharedJs),
  "shared.js: asynchronous confirm failures can become unhandled rejections");
// Leading-edge alignment: the popover is routinely far wider than its anchor, so
// aligning trailing edges walks it left over the sidebar nav instead. The flip
// bound is the nearest .panel's right edge (falling back to the viewport) --
// on wide windows the settings card ends far left of the viewport, and a
// row-trailing anchor used to jut the popover past the card border.
check(/let left = anchorRect\.left/.test(sharedJs) &&
  /if \(left \+ popRect\.width > rightBound\) left = anchorRect\.right - popRect\.width/.test(sharedJs),
  "shared.js: the confirm popover went back to trailing-edge alignment (it then covers whatever sits left of the anchor)");
check(/anchor\.closest\("\.panel"\)/.test(sharedJs),
  "shared.js: the confirm popover lost its panel right-edge clamp (wide windows let it jut past the card border)");
check(/<input type="password" id="token-input"/.test(popupHtml) && /data-target="token-input"/.test(popupHtml),
  "popup.html: Pinboard token is not masked with a reveal control");
check(/<input type="password" id="opt-pinboard-token"/.test(optionsHtml) && /data-target="opt-pinboard-token"/.test(optionsHtml),
  "options.html: Pinboard token is not masked with a reveal control");
check(/<button[^>]+id="import-settings"/.test(optionsHtml) && /id="import-status"[^>]+role="status"/.test(optionsHtml),
  "options.html: settings import is not a keyboard button with live status");
// Section titles are real <h2>s (outline-navigable); the select borrows the
// heading as its accessible name via aria-labelledby (settings batch E).
for (const [id, label, heading] of [["opt-lang", "secLanguage", "sec-language"], ["opt-ai-provider", "secAiProvider", "sec-ai-provider"], ["opt-theme", "secTheme", "sec-theme"]]) {
  check(new RegExp(`<h2[^>]+id="${heading}"[^>]+data-i18n="${label}"`).test(optionsHtml) &&
    new RegExp(`<select id="${id}"[^>]+aria-labelledby="${heading}"`).test(optionsHtml),
    `options.html: ${id} lacks its section heading as accessible name`);
}

// Reset-map coverage gate (settings batch A1): every persisted control inside
// a #panel-* must be listed in that panel's PANEL_DEFAULTS entry -- fields
// (by id, radios included), nested groups, radios (by group name) or skip --
// otherwise "Reset this tab" silently leaves it untouched while the confirm
// dialog promises a full reset. The allowlist names controls excluded on
// purpose; extend it with a reason, never to make the gate pass.
{
  const RESET_ALLOWLIST = {
    general: [
      "opt-sync-api-keys",                // credential routing toggle: a reset must never move secrets
      // opt-backup-include-vocabulary is NOT here: 84432e3 made it a real
      // persisted setting (backupIncludeVocabulary), so PANEL_DEFAULTS.general
      // must carry it -- an exemption would cover it instead, and deleting the
      // entry from PANEL_DEFAULTS would then sail through this very gate.
      "opt-backup-include-secrets",        // export picker: per-export, never persisted
      "backup-section-settings", "backup-section-themes", "backup-section-highlights",
      "backup-section-vocabulary", "backup-section-secrets",          // import preview pickers: session UI
    ],
    tags: ["tag-gov-select-all"],         // list selection helper, not a setting
  };
  const RESET_PANELS_WITHOUT_DEFAULTS = new Set(["storage"]); // nothing persisted to reset
  const pdStart = optionsJs.indexOf("const PANEL_DEFAULTS = {");
  const pdEnd = optionsJs.indexOf("\n  };", pdStart) + 4;
  let panelDefaults = null;
  try { panelDefaults = runInNewContext("(" + optionsJs.slice(pdStart + "const PANEL_DEFAULTS = ".length, pdEnd) + ")", {}); } catch (_) {}
  check(panelDefaults && typeof panelDefaults === "object", "options.js: PANEL_DEFAULTS is not a plain literal the coverage gate can evaluate");
  const panels = [...optionsHtml.matchAll(/<div id="panel-([a-z-]+)"[^>]*>/g)].map(m => ({ name: m[1], at: m.index }));
  const offenders = [];
  panels.forEach((p, i) => {
    const body = optionsHtml.slice(p.at, i + 1 < panels.length ? panels[i + 1].at : optionsHtml.length);
    const def = panelDefaults && panelDefaults[p.name];
    if (!def) { if (!RESET_PANELS_WITHOUT_DEFAULTS.has(p.name)) offenders.push(`${p.name}: no PANEL_DEFAULTS entry`); return; }
    const known = new Set([...Object.keys(def.fields || {}), ...(def.skip || []), ...(RESET_ALLOWLIST[p.name] || [])]);
    for (const group of Object.values(def.nested || {})) for (const id of Object.keys(group)) known.add(id);
    const radioGroups = new Set(Object.keys(def.radios || {}));
    for (const m of body.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      const attrs = m[2];
      const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
      const type = (attrs.match(/\btype="([^"]+)"/) || [])[1] || "";
      if (type === "hidden" || type === "file" || type === "button" || type === "submit") continue;
      if (type === "radio") {
        const name = (attrs.match(/\bname="([^"]+)"/) || [])[1];
        if (radioGroups.has(name) || (id && known.has(id))) continue;
        offenders.push(`${p.name}: radio ${name || id}`);
        continue;
      }
      if (!id || !known.has(id)) offenders.push(`${p.name}: ${id || "<" + m[1] + " without id>"}`);
    }
  });
  check(offenders.length === 0, "options.js: controls missing from the reset map -> " + offenders.join(", "));
  // Non-DOM reset state the walk above cannot see (Codex r2 M3): the active
  // Pinboard preset lives in options.js closure state, so the Appearance
  // entry must clear it through an `after` hook.
  check(panelDefaults && panelDefaults.appearance && typeof panelDefaults.appearance.after === "function",
    "options.js: Appearance reset lacks the after() hook that clears the active preset");
  // mdVideoDarkScheme data chain: default -> Options load -> collect -> reset
  // (the setting is otherwise invisible to every other gate).
  const sharedJsText = read("shared.js");
  check(/\bmdVideoDarkScheme:\s*false\b/.test(sharedJsText), "shared.js: SETTINGS_DEFAULTS lacks mdVideoDarkScheme: false");
  check(/"opt-md-video-dark":\s*s\.mdVideoDarkScheme === true/.test(optionsJs) &&
    /mdVideoDarkScheme:\s*\$id\("opt-md-video-dark"\)\.checked/.test(optionsJs) &&
    panelDefaults && panelDefaults.reader && panelDefaults.reader.fields && panelDefaults.reader.fields["opt-md-video-dark"] === false,
    "options.js: mdVideoDarkScheme is not wired through load, collect and the Reader reset map");
}

// Default-value equality gate (K79, follow-up to the reset-map coverage gate
// above): a setting's default is hand-copied in four places -- shared.js's
// SETTINGS_DEFAULTS (authoritative), options.html's static checked/value=,
// options.js's PANEL_DEFAULTS ("reset this panel"), and the collector's
// `|| "fallback"` literals (collectSettingsFromForm, options.js ~2592-2733).
// The reset-map gate above only asserts presence ("is this control listed
// somewhere"); it never compares values. Six checkboxes silently drifted to
// the wrong static default before this gate existed (SETTINGS_DEFAULTS said
// true, options.html shipped without `checked`) -- two of them privacy-
// facing (incognito-is-private, never-archive-private) -- and nothing caught
// it because "in PANEL_DEFAULTS" said nothing about "equal to it".
//
// Scope: this gate covers three of the four copies (SETTINGS_DEFAULTS,
// options.html, PANEL_DEFAULTS). The fourth -- collectSettingsFromForm's
// `|| "fallback"` -- is a different shape (id -> key, the save direction,
// not key -> id) serving a different purpose (a defensive fallback for an
// empty field at save time, not a declared default); folding it into this
// walk would force allowlist entries for shape mismatches rather than catch
// real drift, so it stays unwatched here (see task-7-report.md).
//
// loadSettings's checkMap/fieldMap (~1925/~1848) supply the id<->key
// registry: each entry says "this HTML id displays this SETTINGS_DEFAULTS
// key, in this shape". Three shapes cover every entry today -- bare `s.x`,
// `s.x !== false`, `s.x === true` (checkMap) and bare `s.x`, `s.x ||
// "literal"` (fieldMap). Anything else is an unrecognized shape and MUST be
// allowlisted with a reason or the gate fails loud -- never silently
// skipped: a future `s.foo ?? true` or ternary must not quietly drop out of
// the walk and leave the gate green over an unchecked control (CLAUDE.md:
// "断言要泛化到类别，别只问现在能不能过").
//
// checkMap/fieldMap do not see every checkbox, though: a few (URL Clean's
// four toggles) are populated from a nested SETTINGS_DEFAULTS object through
// a hand-written block, never through checkMap at all -- three of them
// drifted exactly like the six above and were invisible to a walk that only
// iterates checkMap's own keys (task-7 review, round 1). NESTED_CHECKBOX_
// DEFAULTS covers that specific shape, and a DOM-wide coverage sweep below
// requires every OTHER checkbox in options.html to resolve through checkMap,
// NESTED_CHECKBOX_DEFAULTS, or DEFAULT_EQ_ALLOWLIST -- so the next control
// added outside all three fails the gate instead of silently going
// unwatched.
{
  const DEFAULT_EQ_ALLOWLIST = {
    // customOverlayCSS is not a SETTINGS_DEFAULTS key at all -- it is a
    // schema-v2 large-value field synced outside the settings.get() default
    // merge (shared.js:1187-1199, options.js ~1814), so there is nothing in
    // SETTINGS_DEFAULTS to compare opt-custom-css's textarea content to.
    "opt-custom-css": "customOverlayCSS is not a SETTINGS_DEFAULTS key (large-value codec field)",
    // opt-preview-ai-model is a computed per-provider lookup
    // (_previewModelMap[s.aiProvider] ?? ""), not a declared default -- its
    // effective value depends on aiProvider and previewAiModelByProvider,
    // which a single static default cannot express.
    "opt-preview-ai-model": "computed per-provider override (previewAiModelByProvider lookup), not a literal default",
    // dict-anki-deck / dict-anki-port intentionally show placeholder= text
    // instead of value= (options.html ~884/~886): an empty field with a
    // grey hint never asserts a wrong state the way a checkbox's `checked`
    // or a select's `selected` does, so it is a different (and accepted)
    // pattern, not the K79 bug class this gate exists to catch.
    "dict-anki-deck": "placeholder-only field by design, not a value= default",
    "dict-anki-port": "placeholder-only field by design, not a value= default",
    // The following nine are checkboxes that never go through checkMap OR
    // NESTED_CHECKBOX_DEFAULTS -- they are populated from runtime/session
    // state that has no comparable SETTINGS_DEFAULTS entry, not from a
    // hand-copied default. Reasons mirror the reset-map coverage gate's own
    // RESET_ALLOWLIST above (same controls, same justification, reused here
    // because that allowlist is scoped to its own block).
    "opt-sync-enabled": "device-local flag read directly from chrome.storage.local (shared.js:1407), not part of the SETTINGS_DEFAULTS merge",
    "opt-sync-api-keys": "account-wide runtime routing state (options.js ~2040-2059 initialSyncState), not a SETTINGS_DEFAULTS default; a reset must never move secrets",
    "opt-backup-include-secrets": "export picker: per-export session choice, never persisted",
    "backup-section-settings": "import preview picker: session UI",
    "backup-section-themes": "import preview picker: session UI",
    "backup-section-highlights": "import preview picker: session UI",
    "backup-section-vocabulary": "import preview picker: session UI",
    "backup-section-secrets": "import preview picker: session UI",
    "tag-gov-select-all": "list selection helper hard-reset to false at render time (options.js ~4621), not a setting"
  };

  const sdStart = sharedJs.indexOf("const SETTINGS_DEFAULTS = {");
  const sdEnd = sharedJs.indexOf("\n};", sdStart);
  let settingsDefaults = null;
  try { settingsDefaults = runInNewContext("(" + sharedJs.slice(sdStart + "const SETTINGS_DEFAULTS = ".length, sdEnd + 2) + ")", {}); } catch (_) {}
  check(settingsDefaults && typeof settingsDefaults === "object",
    "shared.js: SETTINGS_DEFAULTS is not a plain literal the default-equality gate can evaluate");

  // Re-parsed independently of the coverage gate's local `panelDefaults`
  // above (that one lives in its own block scope) -- same technique, same
  // failure handling: a parse failure is a `check()` failure here too, not a
  // silently-empty map.
  const pdStart2 = optionsJs.indexOf("const PANEL_DEFAULTS = {");
  const pdEnd2 = optionsJs.indexOf("\n  };", pdStart2) + 4;
  let panelDefaults2 = null;
  try { panelDefaults2 = runInNewContext("(" + optionsJs.slice(pdStart2 + "const PANEL_DEFAULTS = ".length, pdEnd2) + ")", {}); } catch (_) {}
  check(panelDefaults2 && typeof panelDefaults2 === "object",
    "options.js: PANEL_DEFAULTS is not a plain literal the default-equality gate can evaluate");
  const flatPanelDefaults = {};
  if (panelDefaults2) {
    for (const panel of Object.values(panelDefaults2)) {
      Object.assign(flatPanelDefaults, panel.fields || {});
      for (const group of Object.values(panel.nested || {})) Object.assign(flatPanelDefaults, group);
    }
  }

  // Pull the `"id": expr,` entries out of a `const NAME = { ... };` block
  // (2-space indented, the same closing shape PANEL_DEFAULTS uses above)
  // WITHOUT evaluating them -- the right-hand sides reference the
  // closure-local `s`, so runInNewContext (fine for a plain object literal)
  // cannot run them.
  const extractIdExprBlock = (name) => {
    const s = optionsJs.indexOf(`const ${name} = {`);
    const e = optionsJs.indexOf("\n  };", s);
    return optionsJs.slice(s + `const ${name} = {`.length, e);
  };
  const parseIdExprMap = (block) => {
    const keyRe = /"([a-zA-Z0-9_-]+)":\s*/g;
    const matches = [...block.matchAll(keyRe)];
    const out = {};
    for (let i = 0; i < matches.length; i++) {
      const id = matches[i][1];
      const exprStart = matches[i].index + matches[i][0].length;
      const exprEnd = i + 1 < matches.length ? matches[i + 1].index : block.length;
      out[id] = block.slice(exprStart, exprEnd).replace(/\/\/.*$/m, "").replace(/,\s*$/, "").trim();
    }
    return out;
  };
  const checkMapIds = parseIdExprMap(extractIdExprBlock("checkMap"));
  const fieldMapIds = parseIdExprMap(extractIdExprBlock("fieldMap"));

  const classify = (expr) => {
    let m;
    if ((m = expr.match(/^s\.([A-Za-z0-9_]+)$/))) return { form: "bare", key: m[1] };
    if ((m = expr.match(/^s\.([A-Za-z0-9_]+) !== false$/))) return { form: "!==false", key: m[1] };
    if ((m = expr.match(/^s\.([A-Za-z0-9_]+) === true$/))) return { form: "===true", key: m[1] };
    if ((m = expr.match(/^s\.([A-Za-z0-9_]+) \|\| ("(?:[^"\\]|\\.)*")$/))) return { form: "||literal", key: m[1], literal: JSON.parse(m[2]) };
    return { form: "unrecognized", key: null };
  };
  const expectedFor = (cls, defaultValue) => {
    if (cls.form === "bare") return defaultValue;
    if (cls.form === "!==false") return defaultValue !== false;
    if (cls.form === "===true") return defaultValue === true;
    if (cls.form === "||literal") return defaultValue || cls.literal;
    return undefined;
  };

  const htmlCheckedDefault = (id) => {
    const m = optionsHtml.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`));
    return m ? /\bchecked\b/.test(m[0]) : null;
  };
  const htmlValueDefault = (id) => {
    const selM = optionsHtml.match(new RegExp(`<select[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</select>`));
    if (selM) {
      let selected = null, first = null;
      for (const om of selM[1].matchAll(/<option\b([^>]*)>/g)) {
        const val = (om[1].match(/\bvalue="([^"]*)"/) || [])[1] ?? "";
        if (first === null) first = val;
        if (/\bselected\b/.test(om[1])) selected = val;
      }
      return selected !== null ? selected : first;
    }
    const inM = optionsHtml.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`));
    if (inM) return (inM[0].match(/\bvalue="([^"]*)"/) || [])[1] ?? "";
    const taM = optionsHtml.match(new RegExp(`<textarea[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</textarea>`));
    return taM ? taM[1] : null;
  };

  const eqOffenders = [];
  const walkDefaults = (map, kind, htmlDefaultFn, coerce) => {
    for (const [id, expr] of Object.entries(map)) {
      const cls = classify(expr);
      const allowReason = DEFAULT_EQ_ALLOWLIST[id];
      const resolvable = cls.form !== "unrecognized" && settingsDefaults &&
        Object.prototype.hasOwnProperty.call(settingsDefaults, cls.key);
      if (!resolvable) {
        if (!allowReason) eqOffenders.push(`${id}: unrecognized ${kind} shape "${expr}" -- add to DEFAULT_EQ_ALLOWLIST with a reason or fix the shape`);
        continue;
      }
      if (allowReason) continue; // recognized shape, but documented as a different pattern -- trust the reason, don't also assert
      const expected = expectedFor(cls, settingsDefaults[cls.key]);
      const htmlVal = htmlDefaultFn(id);
      if (htmlVal === null) { eqOffenders.push(`${id}: no matching HTML element found for the default-equality gate`); continue; }
      if (coerce(htmlVal) !== coerce(expected)) {
        eqOffenders.push(`${id}: options.html default is ${JSON.stringify(htmlVal)}, SETTINGS_DEFAULTS.${cls.key} implies ${JSON.stringify(expected)}`);
      }
      if (Object.prototype.hasOwnProperty.call(flatPanelDefaults, id) && coerce(flatPanelDefaults[id]) !== coerce(expected)) {
        eqOffenders.push(`${id}: PANEL_DEFAULTS is ${JSON.stringify(flatPanelDefaults[id])}, SETTINGS_DEFAULTS.${cls.key} implies ${JSON.stringify(expected)}`);
      }
    }
  };
  walkDefaults(checkMapIds, "checkMap", htmlCheckedDefault, (v) => !!v);
  walkDefaults(fieldMapIds, "fieldMap", htmlValueDefault, (v) => String(v ?? ""));

  // loadSettings also populates a few checkboxes through a hand-written
  // block instead of checkMap -- URL Clean's four toggles (options.js
  // ~2031-2035: `$id("opt-urlclean-enabled").checked = !!urlClean.enabled;`)
  // read a nested SETTINGS_DEFAULTS object (shared.js:488
  // `urlClean: { enabled: true, onPopupOpen: true, onPaste: true,
  // aggressiveMode: false, ... }`), not `s.<key>`, so checkMap's shape
  // parser cannot see them at all. This is exactly how three of them
  // drifted (default true, options.html shipped without `checked`) and went
  // undetected by the walk above -- caught only by the DOM-wide coverage
  // sweep below, which is why that sweep is not optional.
  const NESTED_CHECKBOX_DEFAULTS = {
    "opt-urlclean-enabled": ["urlClean", "enabled"],
    "opt-urlclean-on-open": ["urlClean", "onPopupOpen"],
    "opt-urlclean-on-paste": ["urlClean", "onPaste"],
    "opt-urlclean-aggressive": ["urlClean", "aggressiveMode"]
  };
  for (const [id, [objKey, propKey]] of Object.entries(NESTED_CHECKBOX_DEFAULTS)) {
    const nested = settingsDefaults && settingsDefaults[objKey];
    if (!nested || !Object.prototype.hasOwnProperty.call(nested, propKey)) {
      eqOffenders.push(`${id}: SETTINGS_DEFAULTS.${objKey}.${propKey} does not exist`);
      continue;
    }
    const expected = !!nested[propKey];
    const htmlVal = htmlCheckedDefault(id);
    if (htmlVal === null) { eqOffenders.push(`${id}: no matching HTML element found for the default-equality gate`); continue; }
    if (htmlVal !== expected) {
      eqOffenders.push(`${id}: options.html default is ${htmlVal}, SETTINGS_DEFAULTS.${objKey}.${propKey} implies ${expected}`);
    }
    if (Object.prototype.hasOwnProperty.call(flatPanelDefaults, id) && !!flatPanelDefaults[id] !== expected) {
      eqOffenders.push(`${id}: PANEL_DEFAULTS is ${JSON.stringify(flatPanelDefaults[id])}, SETTINGS_DEFAULTS.${objKey}.${propKey} implies ${expected}`);
    }
  }

  // Coverage-completeness sweep (task-7 review, round 1): every checkbox id
  // in options.html must resolve through checkMap, NESTED_CHECKBOX_DEFAULTS,
  // or DEFAULT_EQ_ALLOWLIST with a documented reason -- falling out of all
  // three (as URL Clean's toggles did) must fail loud, not pass by omission.
  // This mirrors the reset-map coverage gate's own DOM walk above (walk
  // every <input|select|textarea> per panel, check membership in a name
  // set) applied to the narrower "is this checkbox's VALUE watched" question
  // instead of "is this checkbox LISTED for reset".
  const coveredCheckboxIds = new Set([...Object.keys(checkMapIds), ...Object.keys(NESTED_CHECKBOX_DEFAULTS)]);
  for (const m of optionsHtml.matchAll(/<input\b([^>]*)>/g)) {
    const attrs = m[1];
    if (!/\btype="checkbox"/.test(attrs)) continue;
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (!id || coveredCheckboxIds.has(id) || DEFAULT_EQ_ALLOWLIST[id]) continue;
    eqOffenders.push(`${id}: checkbox not resolved through checkMap, NESTED_CHECKBOX_DEFAULTS, or DEFAULT_EQ_ALLOWLIST -- extend one of them with a reason or wire it through checkMap`);
  }

  check(eqOffenders.length === 0,
    "default value drifted between SETTINGS_DEFAULTS / options.html / PANEL_DEFAULTS -> " + eqOffenders.join("; "));
}

// Provider default-model & id-set parity gate (K81, follow-up to the
// default-value equality gate above -- same "hand-copied, drift silently"
// failure class, but for the 15 AI providers rather than plain settings).
// Each provider's default model string is hand-copied SIX times (shared.js
// SETTINGS_DEFAULTS, ai.js OPENAI_COMPAT_PROVIDERS.defaultModel for the 12
// callOpenAICompat-dispatched providers, options.html's `value=`, options.js
// PANEL_DEFAULTS.ai.fields, options.js collectSettingsFromForm's `||
// "literal"` fallback, and options-connectivity.js pbpLiveAiSettingsSnapshot's
// getOptVal(...) fallback), and the provider ID list is separately
// hand-copied across five more spots. 0 drift today (verified by hand,
// 2026-09) -- this gate is what keeps it that way without merging any of the
// copies: K81's controller-reviewed direction explicitly rejects folding
// gemini/claude/ollama into OPENAI_COMPAT_PROVIDERS (that table's contract is
// "reached via callOpenAICompat", and scripts/network-exits-check.mjs parses
// it expecting every `base` host to be an allowlisted network exit -- ollama's
// localhost base would trip that door) and rejects merging the four ID
// arrays (AI_PROVIDER_ORDER's ordering is a deliberate fallback-provider
// priority, not an accidental duplicate of PBP_CONNECTION_HEALTH_IDS or the
// options.js/options-connectivity.js provider-id lists). See task-1-brief.md
// for the full reasoning trail this gate's shape is drawn from.
{
  // ---- ground truth: every SETTINGS_DEFAULTS key of shape "<id>Model",
  // minus the one documented non-provider exception. previewAiModel is a
  // COMPUTED per-provider override (_previewModelMap[s.aiProvider] ?? ""),
  // not a provider's declared default -- K79's own DEFAULT_EQ_ALLOWLIST
  // documents the exact same exception for opt-preview-ai-model. Deriving
  // PROVIDERS from the real SETTINGS_DEFAULTS keys (instead of hand-typing a
  // 15-provider array here, which would just be a seventh hand copy) means a
  // 16th provider is picked up automatically the moment shared.js adds
  // `<id>Model:` -- and the gate below will immediately point at every other
  // copy that still needs it.
  const NON_PROVIDER_MODEL_KEYS = new Set(["previewAiModel"]);

  const sdStart3 = sharedJs.indexOf("const SETTINGS_DEFAULTS = {");
  const sdEnd3 = sharedJs.indexOf("\n};", sdStart3);
  let settingsDefaultsK81 = null;
  try { settingsDefaultsK81 = runInNewContext("(" + sharedJs.slice(sdStart3 + "const SETTINGS_DEFAULTS = ".length, sdEnd3 + 2) + ")", {}); } catch (_) {}
  check(settingsDefaultsK81 && typeof settingsDefaultsK81 === "object",
    "shared.js: SETTINGS_DEFAULTS is not a plain literal the K81 parity gate can evaluate");

  const PROVIDERS = settingsDefaultsK81
    ? Object.keys(settingsDefaultsK81)
      .filter((k) => k.endsWith("Model") && !NON_PROVIDER_MODEL_KEYS.has(k))
      .map((k) => k.slice(0, -"Model".length))
    : [];
  check(PROVIDERS.length > 0, "shared.js: found no `<id>Model` keys in SETTINGS_DEFAULTS -- K81 parity gate has nothing to check");

  // ---- ai.js OPENAI_COMPAT_PROVIDERS (bespoke gemini/claude/ollama are
  // dispatched ahead of this table by design -- ai.js's own header comment
  // says so -- so they are excluded from this one comparison, not from the
  // gate overall: every other copy below still covers all 15).
  const cpStart = aiJs.indexOf("const OPENAI_COMPAT_PROVIDERS = {");
  const cpEnd = aiJs.indexOf("\n};", cpStart);
  let compatProviders = null;
  try { compatProviders = runInNewContext("(" + aiJs.slice(cpStart + "const OPENAI_COMPAT_PROVIDERS = ".length, cpEnd + 2) + ")", {}); } catch (_) {}
  check(compatProviders && typeof compatProviders === "object",
    "ai.js: OPENAI_COMPAT_PROVIDERS is not a plain literal the K81 parity gate can evaluate");
  const BESPOKE_PROVIDERS = new Set(["gemini", "claude", "ollama"]);

  // ---- reasoned allowlist: providers with no API-key concept at all.
  // ollama is a self-hosted local server -- confirmed by grep: there is no
  // `ollamaApiKey` anywhere (not in SETTINGS_DEFAULTS, not in
  // pbpLiveAiSettingsSnapshot, not in API_KEY_FIELDS), only ollamaBaseUrl /
  // ollamaModel. custom DOES have a key concept (`customApiKey`, wired
  // through the same getOptVal("opt-custom-key") shape as every other
  // provider) and is deliberately NOT in this set.
  const NO_KEY_PROVIDERS = new Set(["ollama"]);

  // ---- options.js PANEL_DEFAULTS.ai.fields (re-parsed independently of the
  // K79 block above, same technique/failure handling, matching this file's
  // own "re-parsed independently" idiom -- see K79's own comment on why).
  const pdStart3 = optionsJs.indexOf("const PANEL_DEFAULTS = {");
  const pdEnd3 = optionsJs.indexOf("\n  };", pdStart3) + 4;
  let panelDefaultsK81 = null;
  try { panelDefaultsK81 = runInNewContext("(" + optionsJs.slice(pdStart3 + "const PANEL_DEFAULTS = ".length, pdEnd3) + ")", {}); } catch (_) {}
  check(panelDefaultsK81 && panelDefaultsK81.ai && panelDefaultsK81.ai.fields && typeof panelDefaultsK81.ai.fields === "object",
    "options.js: PANEL_DEFAULTS.ai.fields is not a plain literal the K81 parity gate can evaluate");
  const aiFields = (panelDefaultsK81 && panelDefaultsK81.ai && panelDefaultsK81.ai.fields) || {};

  // options.html: `<input ... id="opt-<id>-model" value="...">`. opt-custom-
  // model carries no `value=` at all (placeholder="model-name" instead,
  // options.html ~592) -- a deliberate different pattern for the one provider
  // whose default really is "no default", mirrored by customModel: "" in
  // SETTINGS_DEFAULTS. The regex below resolves a missing value= to "" (not
  // to a sentinel), so custom's absence *agrees* with the empty-string
  // default -- no allowlist entry is needed to make this pass, but it also
  // means a provider that legitimately ships no value= must have "" as its
  // SETTINGS_DEFAULTS default, exactly like custom does.
  const htmlModelValue = (id) => {
    const m = optionsHtml.match(new RegExp(`<input[^>]*\\bid="opt-${id}-model"[^>]*>`));
    if (!m) return undefined;
    return (m[0].match(/\bvalue="([^"]*)"/) || [])[1] ?? "";
  };

  const offenders = [];
  const keyOffenders = [];
  for (const id of PROVIDERS) {
    const key = `${id}Model`;
    const expected = settingsDefaultsK81[key];

    const htmlVal = htmlModelValue(id);
    if (htmlVal === undefined) offenders.push(`${id}: options.html has no id="opt-${id}-model" input`);
    else if (htmlVal !== expected) offenders.push(`${id}: SETTINGS_DEFAULTS.${key}=${JSON.stringify(expected)} but options.html value="opt-${id}-model"=${JSON.stringify(htmlVal)}`);

    if (!Object.prototype.hasOwnProperty.call(aiFields, `opt-${id}-model`)) {
      offenders.push(`${id}: PANEL_DEFAULTS.ai.fields is missing opt-${id}-model`);
    } else if (aiFields[`opt-${id}-model`] !== expected) {
      offenders.push(`${id}: SETTINGS_DEFAULTS.${key}=${JSON.stringify(expected)} but PANEL_DEFAULTS.ai.fields["opt-${id}-model"]=${JSON.stringify(aiFields[`opt-${id}-model`])}`);
    }

    // collectSettingsFromForm: `<id>Model: $id("opt-<id>-model").value.trim()
    // [|| "literal"]` -- custom's line has no `|| "..."` tail at all (its
    // .trim() alone already agrees with customModel: ""), so the fallback
    // group is optional and a missing match resolves to "".
    const collectRe = new RegExp(`\\b${key}:\\s*\\$id\\("opt-${id}-model"\\)\\.value\\.trim\\(\\)(?:\\s*\\|\\|\\s*"((?:[^"\\\\]|\\\\.)*)")?`);
    const collectM = optionsJs.match(collectRe);
    if (!collectM) {
      offenders.push(`${id}: collectSettingsFromForm has no "${key}: $id(\\"opt-${id}-model\\").value.trim()" assignment`);
    } else {
      const collectVal = collectM[1] !== undefined ? collectM[1] : "";
      if (collectVal !== expected) offenders.push(`${id}: SETTINGS_DEFAULTS.${key}=${JSON.stringify(expected)} but collectSettingsFromForm fallback=${JSON.stringify(collectVal)}`);
    }

    // options-connectivity.js pbpLiveAiSettingsSnapshot:
    // getOptVal("opt-<id>-model"[, "literal"]) -- same optional-fallback
    // shape as above, same reason (custom has no second argument).
    const snapRe = new RegExp(`getOptVal\\("opt-${id}-model"(?:,\\s*"((?:[^"\\\\]|\\\\.)*)")?\\)`);
    const snapM = optionsConnectivityJs.match(snapRe);
    if (!snapM) {
      offenders.push(`${id}: pbpLiveAiSettingsSnapshot has no getOptVal("opt-${id}-model", ...) call`);
    } else {
      const snapVal = snapM[1] !== undefined ? snapM[1] : "";
      if (snapVal !== expected) offenders.push(`${id}: SETTINGS_DEFAULTS.${key}=${JSON.stringify(expected)} but pbpLiveAiSettingsSnapshot fallback=${JSON.stringify(snapVal)}`);
    }

    // pbpLiveAiSettingsSnapshot key-field coverage (group 2, fix round 1):
    // `<id>ApiKey: getOptVal("opt-<id>-key")` -- no fallback argument on any
    // provider's key line (a stale/blank key has no sane literal default),
    // so unlike the model check above this is presence-only, not a value
    // comparison. This is the one failure mode the brief's fact-lens
    // confirmed has NO other door: a provider whose key line is missing
    // here means the user can fill in a key that the connectivity test can
    // never actually read. ollama is excluded via NO_KEY_PROVIDERS (no key
    // concept at all); every other provider, including custom, must have it.
    if (!NO_KEY_PROVIDERS.has(id)) {
      const keyRe = new RegExp(`\\b${id}ApiKey:\\s*getOptVal\\("opt-${id}-key"\\)`);
      if (!keyRe.test(optionsConnectivityJs)) {
        keyOffenders.push(`${id}: pbpLiveAiSettingsSnapshot has no ${id}ApiKey: getOptVal("opt-${id}-key") call`);
      }
    }

    if (!BESPOKE_PROVIDERS.has(id)) {
      const cfg = compatProviders && compatProviders[id];
      if (!cfg) offenders.push(`${id}: OPENAI_COMPAT_PROVIDERS has no entry (and it is not in the bespoke gemini/claude/ollama exclusion set)`);
      else if (cfg.defaultModel !== expected) offenders.push(`${id}: SETTINGS_DEFAULTS.${key}=${JSON.stringify(expected)} but OPENAI_COMPAT_PROVIDERS.${id}.defaultModel=${JSON.stringify(cfg.defaultModel)}`);
    }
  }
  check(offenders.length === 0,
    "K81: provider default model drifted between SETTINGS_DEFAULTS / ai.js OPENAI_COMPAT_PROVIDERS / options.html / PANEL_DEFAULTS.ai.fields / collectSettingsFromForm / pbpLiveAiSettingsSnapshot -> " + offenders.join("; "));
  check(keyOffenders.length === 0,
    "K81: pbpLiveAiSettingsSnapshot is missing a provider's API-key field -> " + keyOffenders.join("; "));

  // ---- id-set parity: five more hand-copied provider-id lists, compared as
  // SETS against PROVIDERS -- never by order (AI_PROVIDER_ORDER's order is a
  // deliberate fallback-provider priority, e.g. minimax sits near the end on
  // purpose; PBP_CONNECTION_HEALTH_IDS is an independent validation
  // allowlist by design). A missing or extra id is a real drift signal
  // either way; only the ORDER is intentionally allowed to differ.
  const idOffenders = [];

  // options.js PBP_CONNECTION_HEALTH_IDS: `new Set(["pinboard","anki","eudic",
  // ...[...].map(p => \`ai:${p}\`)])` -- self-contained (no closure refs), so
  // the whole expression evaluates under runInNewContext; strip the "ai:"
  // prefix and drop the three non-AI integration ids it also carries.
  const chStart = optionsJs.indexOf("const PBP_CONNECTION_HEALTH_IDS = new Set([");
  const chEnd = optionsJs.indexOf("\n]);", chStart);
  let healthIds = null;
  try {
    const expr = optionsJs.slice(chStart + "const PBP_CONNECTION_HEALTH_IDS = ".length, chEnd + 4).replace(/;\s*$/, "");
    healthIds = runInNewContext(expr, {});
  } catch (_) {}
  // runInNewContext evaluates in a separate realm, so its `Set` is not the
  // outer realm's `Set` constructor -- `instanceof Set` would false-negative
  // here even on success; duck-type on the iterator protocol instead (the
  // spread below already relies on exactly that protocol).
  const healthIdsOk = healthIds && typeof healthIds[Symbol.iterator] === "function" && typeof healthIds.has === "function";
  check(healthIdsOk, "options.js: PBP_CONNECTION_HEALTH_IDS is not a plain Set literal the K81 parity gate can evaluate");
  const healthProviderIds = healthIdsOk ? [...healthIds].filter((v) => v.startsWith("ai:")).map((v) => v.slice(3)) : [];

  // options.js `const providers = [...]` (provider-field toggle) and
  // options-connectivity.js's `[...].forEach(p => { $id(\`test-${p}\`)... })`
  // (connectivity test buttons) are both single-line double-quoted JSON
  // array literals -- JSON.parse handles them directly, no eval needed.
  const providersArrM = optionsJs.match(/const providers = (\[[^\]]*\]);/);
  const connectivityArrM = optionsConnectivityJs.match(/(\["gemini"[^\]]*\])\.forEach\(p => \{/);
  let providersArr = null, connectivityArr = null;
  try { providersArr = providersArrM ? JSON.parse(providersArrM[1]) : null; } catch (_) {}
  try { connectivityArr = connectivityArrM ? JSON.parse(connectivityArrM[1]) : null; } catch (_) {}
  check(Array.isArray(providersArr), "options.js: `const providers = [...]` (provider-field toggle) is not a plain JSON-shaped array the K81 parity gate can evaluate");
  check(Array.isArray(connectivityArr), "options-connectivity.js: the connectivity-test-button provider array is not a plain JSON-shaped array the K81 parity gate can evaluate");

  // popup-ai.js AI_PROVIDER_ORDER (JSON-shaped array) and AI_PROVIDER_LABEL
  // (object literal, unquoted keys -- needs runInNewContext like PANEL_
  // DEFAULTS above, not JSON.parse).
  const aoStart = popupAiJs.indexOf("const AI_PROVIDER_ORDER = [");
  const aoEnd = popupAiJs.indexOf("];", aoStart) + 1;
  let aiProviderOrder = null;
  try { aiProviderOrder = JSON.parse(popupAiJs.slice(aoStart + "const AI_PROVIDER_ORDER = ".length, aoEnd)); } catch (_) {}
  check(Array.isArray(aiProviderOrder), "popup-ai.js: AI_PROVIDER_ORDER is not a plain JSON-shaped array the K81 parity gate can evaluate");

  const alStart = popupAiJs.indexOf("const AI_PROVIDER_LABEL = {");
  const alEnd = popupAiJs.indexOf("\n};", alStart);
  let aiProviderLabel = null;
  try { aiProviderLabel = runInNewContext("(" + popupAiJs.slice(alStart + "const AI_PROVIDER_LABEL = ".length, alEnd + 2) + ")", {}); } catch (_) {}
  check(aiProviderLabel && typeof aiProviderLabel === "object", "popup-ai.js: AI_PROVIDER_LABEL is not a plain literal the K81 parity gate can evaluate");

  const idSources = {
    "options.js PBP_CONNECTION_HEALTH_IDS (ai: prefix)": healthProviderIds,
    "options.js `const providers` (provider-field toggle)": providersArr || [],
    "options-connectivity.js connectivity-test-button array": connectivityArr || [],
    "popup-ai.js AI_PROVIDER_ORDER": aiProviderOrder || [],
    "popup-ai.js AI_PROVIDER_LABEL keys": aiProviderLabel ? Object.keys(aiProviderLabel) : [],
  };
  const canonical = new Set(PROVIDERS);
  for (const [name, list] of Object.entries(idSources)) {
    const set = new Set(list);
    const missing = PROVIDERS.filter((id) => !set.has(id));
    const extra = list.filter((id) => !canonical.has(id));
    if (missing.length) idOffenders.push(`${name} is missing: ${missing.join(", ")}`);
    if (extra.length) idOffenders.push(`${name} has unexpected extra ids: ${extra.join(", ")}`);
  }
  check(idOffenders.length === 0,
    "K81: provider id set drifted (compared as sets, order ignored) -> " + idOffenders.join("; "));

  // ---- API_KEY_FIELDS coverage (group 4, fix round 1): shared.js's
  // API_KEY_FIELDS drives the sync/local credential-routing split (shared.js
  // ~2153-2727) -- a provider whose `<id>ApiKey` is missing from it would
  // have its key silently fall outside that routing. It is a single-line
  // double-quoted JSON array with no trailing comma (also carries
  // pinboardToken/jinaApiKey/waybackS3Key/waybackS3Secret/dictAnkiKey/
  // dictEudicToken -- non-AI-provider secrets that are correctly NOT in
  // PROVIDERS), so JSON.parse handles it directly. Same NO_KEY_PROVIDERS
  // allowlist as the snapshot check above (ollama has no key at all).
  const akfStart = sharedJs.indexOf("const API_KEY_FIELDS = [");
  const akfEnd = sharedJs.indexOf("];", akfStart) + 1;
  let apiKeyFields = null;
  try { apiKeyFields = JSON.parse(sharedJs.slice(akfStart + "const API_KEY_FIELDS = ".length, akfEnd)); } catch (_) {}
  check(Array.isArray(apiKeyFields), "shared.js: API_KEY_FIELDS is not a plain JSON-shaped array the K81 parity gate can evaluate");
  const apiKeyFieldSet = new Set(apiKeyFields || []);
  const akfOffenders = [];
  for (const id of PROVIDERS) {
    if (NO_KEY_PROVIDERS.has(id)) continue;
    if (!apiKeyFieldSet.has(`${id}ApiKey`)) akfOffenders.push(`${id}: API_KEY_FIELDS is missing ${id}ApiKey`);
  }
  check(akfOffenders.length === 0,
    "K81: shared.js API_KEY_FIELDS is missing a provider's API-key field -> " + akfOffenders.join("; "));
}

// Embedded-frame extraction (2026-08-25/26): the candidate rule lives as a
// pure, unit-tested function in shared.js (pbpPickDominantFrame), but the two
// page-context detectors are injected as standalone functions and inline the
// same rule -- keep every guard present in BOTH copies, and keep the Service
// Worker's grant binding in order: permissions.contains for the exact origin
// BEFORE extractForPreview, a per-frame origin probe BEFORE any Defuddle
// injection, and a strict origin match on the picked result (no fallback).
{
  const backgroundJs = read("background.js");
  const popupJs = read("popup.js");
  // Source-shape checks (comments are stripped first so a guard cannot survive
  // in a comment); the detectors' BEHAVIOUR is exercised on a real DOM by
  // tests/frame-candidate-tests.html, which evaluates these very function
  // bodies against iframe fixtures.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const guards = ['f.hasAttribute("srcdoc")', 'allow-same-origin', 'cs.display === "none"', 'cs.visibility === "hidden"', 'Number(cs.opacity) === 0', 'n = n.parentElement', 'bestArea >= 0.4 * vw * vh', '/^https:\\/\\//.test(origin)', 'origin === location.origin', 'Math.min(r.right, vw)', 'Math.min(r.bottom, vh)'];
  for (const [name, src] of [["background.js", backgroundJs], ["popup.js", popupJs]]) {
    const start = src.indexOf("function dominantFrameOrigin()");
    const body = start >= 0 ? stripComments(src.slice(start, src.indexOf('} catch (_) { return ""; }', start))) : "";
    check(start >= 0 && guards.every((g) => body.includes(g)),
      `${name}: the embedded-frame detector lost one of its guards (${guards.filter((g) => !body.includes(g)).join(", ") || "none"})`);
  }
  // The "nothing here" gate must judge TEXT, not the HTML string (device
  // 2026-08-26: Defuddle returned the <main> shell holding only the artifact
  // <iframe> on claude.ai, a truthy string, so the frame offer never showed).
  // Both injected copies carry the same predicate and both gates call it.
  const predGuards = ['/<(img|picture|video|audio|svg|canvas|object|embed|math)\\b/i', 'replace(/<[^>]*>/g, " ")', '&(nbsp|#160|#xa0);'];
  const sliceFn = (src, name) => {
    const start = src.indexOf("function " + name + "(");
    if (start < 0) return "";
    let i = src.indexOf("{", start), depth = 0;
    for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
    return src.slice(start, i + 1);
  };
  const predBodies = {};
  for (const [name, src] of [["background.js", backgroundJs], ["popup.js", popupJs]]) {
    const body = stripComments(sliceFn(src, "extractionLooksEmpty"));
    predBodies[name] = body.replace(/^\s+/gm, "");
    check(body && predGuards.every((g) => body.includes(g)),
      `${name}: extractionLooksEmpty is missing or lost a guard (${predGuards.filter((g) => !body.includes(g)).join(", ") || "not found"})`);
    check(stripComments(src).includes('if (!result?.content || extractionLooksEmpty(result.content)) return { error: "No content extracted", frameOrigin: dominantFrameOrigin() };'),
      `${name}: the no-content gate must call extractionLooksEmpty(result.content) and still surface the frame candidate`);
  }
  check(predBodies["background.js"] && predBodies["background.js"] === predBodies["popup.js"],
    "background.js and popup.js carry the same extractionLooksEmpty predicate (isolated-context twins must not drift)");
  const hStart = backgroundJs.indexOf('message.type === "reextractMarkdown"');
  const hEnd = backgroundJs.indexOf('message.type === "mdPreviewBookmarkInfo"', hStart);
  const handler = stripComments(backgroundJs.slice(hStart, hEnd));
  const containsAt = handler.indexOf("held = await chrome.permissions.contains({ origins: [frameOrigin + \"/*\"] })");
  const refuseAt = handler.indexOf('if (!held) { sendResponse({ ok: false, error: "host_permission" }); return; }');
  const extractAt = handler.indexOf("await extractForPreview(");
  check(hStart >= 0 && hEnd > hStart && containsAt >= 0 && refuseAt > containsAt && extractAt > refuseAt &&
    handler.includes('u.protocol === "https:" && u.origin === message.frameOrigin') &&
    handler.includes("frame, frameOrigin });"),
    "background.js: the frame pass must URL-parse the origin, hold an exact-origin permissions.contains grant, refuse with host_permission otherwise, and only then extract");
  const eStart = backgroundJs.indexOf("async function extractForPreview(");
  const eEnd = backgroundJs.indexOf("async function openMarkdownPreviewFromShortcut", eStart);
  const extract = stripComments(backgroundJs.slice(eStart, eEnd));
  const probeAt = extract.indexOf("func: () => location.origin");
  const targetAt = extract.indexOf("target = { tabId, frameIds };");
  const defuddleAt = extract.indexOf('files: ["vendor/defuddle.js"]');
  const branchStart = extract.indexOf("if (frame === true && Array.isArray(results))");
  const branch = branchStart >= 0 ? extract.slice(branchStart, extract.indexOf("}", extract.indexOf("frameBase = pick.result.url", branchStart))) : "";
  check(eStart >= 0 && eEnd > eStart && probeAt >= 0 && targetAt > probeAt && defuddleAt > targetAt &&
    extract.includes("r.result === frameOrigin).map((r) => r.frameId)") &&
    branch.includes("new URL(u).origin === frameOrigin") &&
    branch.includes("out = pick ? pick.result : null") &&
    !/results\[0\]|\.at\(0\)|framed\[0\]|=\s*top\b/.test(branch), // no positional or top-frame fallback assignment inside the frame branch
    "background.js: the frame pass must probe frame origins, inject only into the equal-origin frameIds, take only an equal-origin result, and never fall back to another frame");
}
check(/id="translate-target-lang-custom"[^>]+aria-labelledby="translate-target-lang-label"/.test(optionsHtml),
  "options.html: custom translation language lacks an accessible name");
check(/id="tag-gov-progress-bar"[^>]+role="progressbar"[^>]+aria-labelledby="tag-gov-progress-text"[^>]+aria-valuenow="0"/.test(optionsHtml) &&
  /id="tag-gov-progress-text"[^>]+role="status"[^>]+aria-live="polite"/.test(optionsHtml),
  "options.html: tag governance progress lacks its accessible name/value or live status");
const tagGovProgressHelper = optionsJs.slice(
  optionsJs.indexOf("function _tagGovSetProgress(value"),
  optionsJs.indexOf('document.addEventListener("click",', optionsJs.indexOf("function _tagGovSetProgress(value"))
);
check(/fill\.style\.width = percent \+ "%"/.test(tagGovProgressHelper) &&
  /bar\.setAttribute\("aria-valuenow", String\(percent\)\)/.test(tagGovProgressHelper) &&
  !optionsJs.replace(tagGovProgressHelper, "").includes('$id("tag-gov-progress-fill")'),
  "options.js: tag governance visual and ARIA progress can drift");
check(/id="tags-input"[^>]+role="combobox"[^>]+aria-controls="tags-autocomplete"[^>]+aria-expanded="false"/.test(popupHtml) &&
  /id="tags-autocomplete"[^>]+role="listbox"/.test(popupHtml),
  "popup.html: tag autocomplete lacks combobox/listbox semantics");
check(/setAttribute\("role", "option"\)/.test(popupTagsJs) &&
  /aria-activedescendant/.test(popupTagsJs) && /aria-selected/.test(popupTagsJs) &&
  /scrollIntoView\(\{ block: "nearest" \}\)/.test(popupTagsJs),
  "popup-tags.js: tag options do not expose active selection semantics");
check(/finally\s*\{\s*container\.setAttribute\("aria-busy", "false"\)/.test(popupTagsJs),
  "popup-tags.js: suggested tags remain permanently busy after completion");
check(/const btn = document\.createElement\("button"\);[\s\S]{0,80}btn\.type = "button";[\s\S]{0,100}btn\.className = "preset-btn";/.test(popupBatchJs),
  "popup-batch.js: tag presets are not native buttons");
check(/btn\.disabled = true;\s*\$id\("tags-input"\)\?\.focus\(\)/.test(popupBatchJs),
  "popup-batch.js: used tag preset drops focus on a disabled button");
// K73: presets must stay a one-way "already inserted" marker (never gain a
// currentTags-derived disable path -- that would re-break the a11y focus
// contract just asserted above), but renderTags must reset them once the
// tag list is cleared to zero, so Clear all/loadBookmarkForEdit/deleting
// down to none don't leave a preset permanently unusable.
check(/btn\.disabled = true;\s*\$id\("tags-input"\)\?\.focus\(\)/.test(popupBatchJs) &&
  /if \(!currentTags\.length\) \{\s*document\.querySelectorAll\("#tag-presets \.preset-btn\.used"\)\.forEach\(\(b\) => \{\s*b\.classList\.remove\("used"\);\s*b\.disabled = false;\s*\}\);\s*\}/.test(popupTagsJs),
  "popup-tags.js: renderTags does not reset presets once tags are cleared to zero");
const cleanHint = popupJs.slice(popupJs.indexOf("function _renderCleanHint"), popupJs.indexOf('document.addEventListener("DOMContentLoaded"'));
check(cleanHint.indexOf('hint.classList.add("hidden")') < cleanHint.indexOf("urlInput.focus()"),
  "popup.js: URL-clean undo hides its focused button without returning focus");

check(manifest.host_permissions.join(",") === "https://api.pinboard.in/*,https://pinboard.in/*",
  "manifest.json: required hosts are not limited to core Pinboard access");
// Roadmap #33: the ceiling is https-anywhere plus literal-loopback http only —
// the exact set the endpoint validator enforces. Any wildcard-http regression
// (or a lost loopback pattern breaking local Ollama/AnkiConnect) fails here.
check(manifest.optional_host_permissions.join(",") ===
  "https://*/*,http://localhost/*,http://127.0.0.1/*,http://[::1]/*",
  "manifest.json: optional host ceiling must be https + literal-loopback http");

for (const [name, html] of [["popup.html", popupHtml], ["options.html", optionsHtml], ["md-preview.html", mdHtml]]) {
  const links = html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g);
  for (const [tag] of links) check(/\brel="[^"]*\bnoopener\b[^"]*"/.test(tag), `${name}: target=_blank missing rel=noopener -> ${tag}`);
}

// One collapsible-section primitive (2026-09-05): every collapsible section is
// a native <details class="disclosure"> whose first child is its <summary>.
// The custom JS accordion this replaced (a second mechanism with its own
// motion, persistence branch and body indent) must not come back.
for (const [file, text] of [["options.html", optionsHtml], ["options.css", optionsCss], ["options.js", optionsJs]]) {
  check(!/accordion-(?:section|header|body|arrow)|\.accordion|class="accordion/.test(text),
    `${file}: the retired custom accordion idiom is back (use details.disclosure)`);
}
for (const m of optionsHtml.matchAll(/<details class="disclosure"[^>]*>\s*<(\w+)/g)) {
  check(m[1] === "summary", `options.html: a .disclosure does not start with its <summary> (found <${m[1]}>)`);
}
check(/const det = document\.createElement\("details"\);\s*det\.className = "disclosure";\s*det\.dataset\.accKey = "et-" \+ id;/.test(optionsJs)
  && /const head = document\.createElement\("summary"\);/.test(optionsJs),
  "options.js: Send-to destination cards are not keyed details.disclosure sections");

// batch4 T3: the Send-to enable ×5 toggle (options.js renderExportTargets) is
// the one dynamically-built checkbox the static .switch census (D4) couldn't
// see through options.html -- pin its DOM shape the same way the .stag
// builder check above pins popup-tags.js: input FIRST (so collectExportTargets()'s
// `el.type === "checkbox" ? el.checked : ...` and the generic
// `input[type="checkbox"]` autosave binding keep working unchanged), then the
// copy span, then the drawn track, appended to the label in that order.
check(/enableLabel\.className = "switch";[\s\S]{0,200}cb\.type = "checkbox";[\s\S]{0,300}sp\.className = "switch-text";[\s\S]{0,300}track\.className = "switch-track";[\s\S]{0,200}enableLabel\.appendChild\(cb\); enableLabel\.appendChild\(sp\); enableLabel\.appendChild\(track\);/.test(optionsJs),
  "options.js: Send-to enable toggle is not rendered as label.switch > input + span.switch-text + span.switch-track");

const helperSource = optionsJs.slice(0, optionsJs.indexOf('document.addEventListener("DOMContentLoaded"'));
const permissionHelpers = Function(helperSource + "; return { pbpExactOriginPermissionSnapshot, pbpRevokeLegacyAllSitesPermission }; ")();
check(permissionHelpers.pbpExactOriginPermissionSnapshot([
  "*://*/*",
  "https://api.pinboard.in/*",
  "https://custom.example:8443/*",
  "https://*.example.com/*",
  "http://localhost:*/*",
  "not a pattern",
  "https://api.pinboard.in/*"
]).join(",") === "https://api.pinboard.in/*,https://custom.example:8443/*",
"options.js: legacy revoke snapshot is not limited to unique exact origins");

{
  const wildcard = "*://*/*";
  const exact = ["https://api.pinboard.in/*", "https://custom.example:8443/*"];
  const active = new Set([wildcard, ...exact]);
  const calls = [];
  const result = await permissionHelpers.pbpRevokeLegacyAllSitesPermission({
    async getAll() { calls.push("getAll"); return { origins: [...active] }; },
    async remove({ origins }) { calls.push("remove:" + origins.join(",")); active.delete(wildcard); return true; },
    async request({ origins }) { calls.push("request:" + origins.join(",")); return true; },
    async contains({ origins }) { calls.push("contains:" + origins[0]); return active.has(origins[0]); }
  });
  check(result.ok && calls.join("|") === [
    "getAll",
    "remove:*://*/*",
    "request:" + exact.join(","),
    "contains:" + exact[0],
    "contains:" + exact[1],
    "contains:*://*/*"
  ].join("|"), "options.js: legacy revoke does not restore/verify the exact snapshot in order");
}

{
  const wildcard = "*://*/*";
  const exact = "https://custom.example/*";
  const active = new Set([wildcard, exact]);
  const result = await permissionHelpers.pbpRevokeLegacyAllSitesPermission({
    async getAll() { return { origins: [...active] }; },
    async remove() { active.clear(); return true; },
    async request() { return false; },
    async contains({ origins }) { return active.has(origins[0]); }
  });
  check(!result.ok && result.wildcardAbsent && result.missing.includes(exact),
    "options.js: partial exact-origin restoration can be reported as success");
}

check(optionsJs.includes("btn.disabled = result.wildcardAbsent"),
  "options.js: partial legacy revoke failure can be retried into a false success");

const sendRuntimeStart = mdExportSendJs.indexOf("async function pbpSendToTarget");
const sendRuntimeEnd = mdExportSendJs.indexOf("\n}", sendRuntimeStart) + 2;
const sendRuntime = mdExportSendJs.slice(sendRuntimeStart, sendRuntimeEnd);
check(sendRuntimeStart >= 0 && /permissions\.contains/.test(sendRuntime) && !/permissions\.request/.test(sendRuntime),
  "md-export-send.js: execution layer must contain-check without requesting");
const doSendStart = mdPreviewJs.indexOf("async function doSend(id)");
const doSendEnd = mdPreviewJs.indexOf("primary.addEventListener", doSendStart);
const doSend = mdPreviewJs.slice(doSendStart, doSendEnd);
check(doSendStart >= 0 && doSendEnd > doSendStart &&
  doSend.indexOf("await pbpRequestTargetPermission(id, cfg)") >= 0 &&
  doSend.indexOf("await pbpRequestTargetPermission(id, cfg)") < doSend.indexOf("await pbpSetLastTarget(id)"),
  "md-preview.js: Send-to permission request is not the first await before last-target storage");
// Send-to status honesty. `.send-status` defaults to the SUCCESS stripe
// (md-preview.css: it is "only ever shown after a completed send"), so a
// failure that forgets isError paints a green bar for a send that never left
// the page -- md-export-send.js's required-settings guard returns
// "missing:<key>" before any request is fired. Category check over every
// branch keyed on res.error, not a list of codes, so a new error code added
// later is covered without editing this test.
{
  const branches = doSend.split(/\}\s*else\s+if\s*\(/).slice(1);
  const keyedOnError = branches.filter((b) => /^[^)]*res\.error/.test(b) && b.includes("showSendStatus("));
  check(keyedOnError.length >= 6,
    "md-preview.js: the Send-to failure ladder no longer parses as else-if branches -- re-derive this check before trusting it");
  check(keyedOnError.every((b) => /showSendStatus\([^;]*?,\s*true[,)]/.test(b)),
    "md-preview.js: a Send-to branch keyed on res.error paints its status with isError=false -- nothing was sent, but .send-status keeps its default success stripe, so a blocked/failed send looks identical to a completed one");
}
// ... and a failure must not be swept away on a timer: mdSendApiBadToken and
// mdSendNotionNotShared are instructions to leave the reader and change a
// setting elsewhere. Only link-less SUCCESS auto-hides; click-to-dismiss and
// the next send's clearTimeout already bound an error's lifetime, the same
// lifetime md-video.js's pbvSetStatus gives kind "error".
{
  const fnStart = mdPreviewJs.indexOf("function showSendStatus(msg, isError, url, viewLabel)");
  const fn = mdPreviewJs.slice(fnStart, mdPreviewJs.indexOf("\n    }", fnStart));
  const autoHide = (fn.match(/^.*sendStatusTimer = setTimeout.*$/m) || [""])[0];
  check(fnStart > 0 && /!isError/.test(autoHide),
    "md-preview.js: showSendStatus arms its 6s auto-hide without excluding errors -- the failure copy that tells the user to go re-paste a token or share a Notion page disappears before it can be read or acted on");
}
// Engine segments express structural unavailability with aria-disabled, never
// the disabled property: a disabled control receives no pointer events in
// Chromium (so its explanatory title never renders) and leaves the tab order
// (so a screen-reader user cannot reach the explanation either). Same choice
// md-preview.js's img-fix button and md-reader.js's typo steps already state.
{
  const applyStart = mdPreviewJs.indexOf("function applyAvailability(curEngine)");
  const applyFn = mdPreviewJs.slice(applyStart, mdPreviewJs.indexOf("// Why a transcript commit happened", applyStart));
  check(applyStart > 0 && !/seg\.disabled = unavail/.test(applyFn) && applyFn.includes('seg.setAttribute("aria-disabled", "true")'),
    "md-preview.js: applyAvailability marks an unavailable engine segment with the disabled property -- the mdEngineTabGone title it sets in the same breath can then never be shown or focused");
  check(!/\|\|\s*seg\.disabled\)/.test(mdPreviewJs),
    "md-preview.js: an engine-segment click guard still reads seg.disabled -- availability now lives in aria-disabled, so the guard would let a click through");
}
// The three download exits share one re-entrancy gate plus a busy indicator.
// With imagePolicy=embed a download runs a host-permission prompt and a
// budgeted image-fetch round, seconds to tens of seconds with the page still:
// an ungated second click starts a second full pass and lands a second file.
for (const id of ["btn-dl-md", "btn-dl-html", "btn-dl-epub"]) {
  const at = mdPreviewJs.indexOf('document.getElementById("' + id + '").addEventListener("click"');
  const head = mdPreviewJs.slice(at, at + 300);
  check(at > 0 && /if \(_exporting\) return;/.test(head) && /setExportBusy\(true\)/.test(head),
    "md-preview.js: #" + id + " has no re-entrancy gate or no busy indicator before its first await -- an embed export is silent for seconds, so the second click a user makes runs a whole second export");
}
// Copy HTML runs no resolveEmbed pass, but it lazily injects highlight.js and
// KaTeX and warms every mermaid diagram before copyToClipboard flashes the
// button label -- the same seconds of stillness, so it holds the same gate.
// Ordering, not adjacency: the handler carries enough comment that a fixed
// character window would double as a comment-length tripwire.
{
  const at = mdPreviewJs.indexOf('document.getElementById("btn-copy-html").addEventListener("click"');
  const end = mdPreviewJs.indexOf('document.getElementById("btn-dl-md")', at);
  const handler = at > 0 && end > at ? mdPreviewJs.slice(at, end) : "";
  const code = handler.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  const gateAt = code.indexOf("if (_exporting) return;");
  const busyAt = code.indexOf("setExportBusy(true)");
  const awaitAt = code.indexOf("await ");
  check(gateAt > 0 && busyAt > gateAt && awaitAt > busyAt,
    "md-preview.js: #btn-copy-html has no re-entrancy gate or no busy indicator before its first await -- the reader gets no feedback until copyToClipboard finally flashes, so a second click on that silence runs a second full pipeline and writes the clipboard twice");
}
// TOC current-section state must exist for assistive tech, not only as a
// colour: aria-current is this project's established "you are here" carrier
// (library-notes.js, library-vocab.js, md-video.js's caption cursor).
{
  const saStart = mdPreviewJs.indexOf("const setActive = (slug) => {");
  const setActiveFn = mdPreviewJs.slice(saStart, mdPreviewJs.indexOf("// Track which headings", saStart));
  check(saStart > 0 && setActiveFn.includes('removeAttribute("aria-current")')
    && /setAttribute\("aria-current", "location"\)/.test(setActiveFn),
    "md-preview.js: the scroll-spy marks the current TOC entry with .active alone -- the current section is invisible to a screen reader, and a stale aria-current on the previous entry is worse than none");
}

check(/const PBP_JINA_ORIGIN_PATTERN = "https:\/\/r\.jina\.ai\/\*";/.test(sharedJs) &&
  !/const\s+JINA_ORIGIN_PATTERN/.test(jinaJs) && /PBP_JINA_ORIGIN_PATTERN/.test(jinaJs),
  "Jina exact-origin pattern is not shared by preview and Service Worker paths");
const jinaRetryStart = mdPreviewJs.indexOf("async function retryExtract(engine, failure)");
// attemptExtract carries an `opts` bag since the embedded-frame pass (2026-08-25);
// match the signature by prefix so the slice still ends at that function.
const jinaRetryEnd = mdPreviewJs.indexOf("async function attemptExtract(engine", jinaRetryStart);
const jinaRetry = mdPreviewJs.slice(jinaRetryStart, jinaRetryEnd);
check(jinaRetryStart >= 0 && jinaRetryEnd > jinaRetryStart &&
  jinaRetry.indexOf("inFlight = true") >= 0 &&
  jinaRetry.indexOf("inFlight = true") < jinaRetry.indexOf("await pbpRequestJinaHostPermission()") &&
  jinaRetry.indexOf("await pbpRequestJinaHostPermission()") >= 0 &&
  jinaRetry.indexOf("await pbpRequestJinaHostPermission()") < jinaRetry.indexOf("await attemptExtract(engine)") &&
  /finally\s*\{\s*inFlight = false;/.test(jinaRetry),
  "md-preview.js: Jina retry is not guarded before its exact-origin request");
const switchRetryStart = mdPreviewJs.indexOf('if (e === "jina" && jinaPermissionMissing)');
const switchHandlerStart = mdPreviewJs.lastIndexOf('seg.addEventListener("click", async () => {', switchRetryStart);
const switchRetryEnd = mdPreviewJs.indexOf("chrome.runtime.sendMessage", switchRetryStart) + "chrome.runtime.sendMessage".length;
const switchRetry = mdPreviewJs.slice(switchHandlerStart, switchRetryEnd);
check(switchHandlerStart >= 0 && switchRetryEnd > switchRetryStart &&
  switchRetry.indexOf("switching = true") >= 0 &&
  switchRetry.indexOf("switching = true") < switchRetry.indexOf("await pbpRequestJinaHostPermission()") &&
  switchRetry.indexOf("await pbpRequestJinaHostPermission()") < switchRetry.indexOf("chrome.runtime.sendMessage") &&
  /if \(!await pbpRequestJinaHostPermission\(\)\) \{[\s\S]*?switching = false;[\s\S]*?applyAvailability\(curEngine\);[\s\S]*?return;/.test(switchRetry),
  "md-preview.js: Jina engine retry is not guarded before its permission request");
const renderErrorState = mdPreviewJs.slice(
  mdPreviewJs.indexOf("function renderErrorState"),
  mdPreviewJs.indexOf("function pbpRequestJinaHostPermission")
);
check(renderErrorState.indexOf('btn.textContent = t(permissionRequired ? "aiGrantRetry" : "askErrRetry")') >= 0 &&
  renderErrorState.indexOf("btn.disabled = true") < renderErrorState.indexOf("await retryFn()") &&
  renderErrorState.indexOf("btn.disabled = false") > renderErrorState.indexOf("await retryFn()") &&
  mdPreviewJs.includes('pr && pr.error === "host_permission"'),
  "md-preview.js: Jina permission retry lacks grant copy or synchronous button guard");

const aiRecoveryStart = mdAiCoreJs.indexOf("async function pbpAiRetryWithPermission");
const aiRecoveryEnd = mdAiCoreJs.indexOf("// ---- IDB persistence", aiRecoveryStart);
const aiRecovery = mdAiCoreJs.slice(aiRecoveryStart, aiRecoveryEnd);
check(aiRecoveryStart >= 0 && aiRecovery.indexOf("await requestAIHostPermissions(settings)") >= 0 &&
  aiRecovery.indexOf("await requestAIHostPermissions(settings)") < aiRecovery.indexOf("await retry()"),
  "md-ai-core.js: retry callback can run before the provider permission request");
check((mdAskJs.match(/pbpAiRetryWithPermission\(/g) || []).length >= 2,
  "md-ask.js: Ask and Explain do not both use permission-aware retry");
const skimRegenStart = mdSkimJs.indexOf("async function _pbpSkimRegen()");
const skimRegen = mdSkimJs.slice(skimRegenStart, mdSkimJs.indexOf("// Init hookup", skimRegenStart));
check(skimRegenStart >= 0 && skimRegen.indexOf("await pbpAiRetryWithPermission") >= 0 &&
  skimRegen.indexOf("st.running = true") >= 0 &&
  skimRegen.indexOf("st.running = true") < skimRegen.indexOf("await pbpAiRetryWithPermission") &&
  skimRegen.indexOf("retry.disabled = true") < skimRegen.indexOf("await pbpAiRetryWithPermission") &&
  skimRegen.indexOf("await pbpAiRetryWithPermission") < skimRegen.indexOf("body.replaceChildren()") &&
  /finally\s*\{[\s\S]*?st\.running = false;[\s\S]*?retry\.disabled = false;/.test(skimRegen),
  "md-skim.js: regenerate is not guarded before permission recovery");
const explainRetryStart = mdAskJs.indexOf('retry.className = "xp-retry"');
const explainRetryEnd = mdAskJs.indexOf("wrap.appendChild(retry)", explainRetryStart);
const explainRetry = mdAskJs.slice(explainRetryStart, explainRetryEnd);
check(explainRetryStart >= 0 && explainRetryEnd > explainRetryStart &&
  explainRetry.indexOf("retry.disabled = true") >= 0 &&
  explainRetry.indexOf("retry.disabled = true") < explainRetry.indexOf("await pbpAiRetryWithPermission") &&
  (explainRetry.match(/retry\.disabled = false/g) || []).length === 2,
  "md-ask.js: Explain permission retry lacks a synchronous button guard");
const trStart = mdTranslateJs.slice(mdTranslateJs.indexOf("async function _pbpTrStart(st)"), mdTranslateJs.indexOf("// Fill one block", mdTranslateJs.indexOf("async function _pbpTrStart(st)")));
check(trStart.indexOf("await pbpAiRetryWithPermission") >= 0 &&
  trStart.indexOf("await pbpAiRetryWithPermission") < trStart.indexOf("if (st.workReady) await st.workReady"),
  "md-translate.js: Continue does work before permission recovery");


const waybackLoadStart = optionsJs.indexOf("// ---- Wayback: check permission on load");
const waybackToggleStart = optionsJs.indexOf("// ---- Wayback: toggle permission", waybackLoadStart);
const waybackClearStart = optionsJs.indexOf("// ---- Wayback: clear", waybackToggleStart);
const waybackLoad = optionsJs.slice(waybackLoadStart, waybackToggleStart);
const waybackToggle = optionsJs.slice(waybackToggleStart, waybackClearStart);
check(waybackLoadStart >= 0 && waybackToggleStart > waybackLoadStart &&
  !/checked\s*=\s*false|waybackArchiveEnabled\s*=\s*false|getSettingsStorage\(\)/.test(waybackLoad),
  "options.js: Wayback load-time permission failure disables the saved setting");
check(waybackClearStart > waybackToggleStart &&
  !/checked\s*=\s*false|dispatchEvent\(/.test(waybackToggle),
  "options.js: Wayback permission denial disables the user's choice");
check(/result\.missing\.join\(", "\)/.test(optionsJs) && !/result\.ok[\s\S]{0,300}batchPermNone/.test(optionsJs),
  "options.js: legacy revoke restoration failure is not reported explicitly");

const popupRetryStart = popupAiJs.indexOf('$id("ai-error-retry")?.addEventListener');
const popupRetryEnd = popupAiJs.indexOf('$id("ai-error-fallback")?.addEventListener', popupRetryStart);
const popupRetry = popupAiJs.slice(popupRetryStart, popupRetryEnd);
check(popupRetryStart >= 0 && popupRetryEnd > popupRetryStart &&
  popupRetry.indexOf("retryBtn.disabled = true") >= 0 &&
  popupRetry.indexOf("retryBtn.disabled = true") < popupRetry.indexOf("await requestAIHostPermissions") &&
  popupRetry.indexOf("retryBtn.disabled = false") > popupRetry.indexOf("await requestAIHostPermissions") &&
  popupRetry.indexOf("await requestAIHostPermissions(recovery.settings, extraOrigins)") === popupRetry.indexOf("await ") &&
  popupRetry.includes("recovery.origins.filter") && !popupRetry.includes("PBP_JINA_ORIGIN_PATTERN") &&
  !popupRetry.includes("aiContentSource"),
  "popup-ai.js: permission retry recomputes destinations instead of using the failed-stage origins");
check(/err\.permissionStage = "extracting";[\s\S]{0,100}err\.permissionOrigins = origins;/.test(popupAiJs) &&
  (popupAiJs.match(/e\.permissionStage = "calling";/g) || []).length === 2 &&
  // (s) = the op's immutable settings snapshot (audit A4), not the mutable global
  (popupAiJs.match(/e\.permissionOrigins = _aiRequiredOriginPatterns\(s\);/g) || []).length === 2,
  "popup-ai.js: extraction and provider permission failures do not record their actual stage/origins");

const popupWaybackStart = popupJs.indexOf('$id("archive-check").addEventListener("change", async (e) =>');
const popupWaybackEnd = popupJs.indexOf("// Setup UI features immediately", popupWaybackStart);
const popupWayback = popupJs.slice(popupWaybackStart, popupWaybackEnd);
check(popupWaybackStart >= 0 && popupWaybackEnd > popupWaybackStart &&
  popupWayback.indexOf('await chrome.permissions.request({ origins: ["https://web.archive.org/*"] })') === popupWayback.indexOf("await ") &&
  !popupWayback.includes("permissions.contains"),
  "popup.js: Wayback grant is not the first await in the checkbox gesture");

const markdownClickStart = popupJs.indexOf('jinaMdBtn.addEventListener("click", async () =>');
const markdownClickEnd = popupJs.indexOf("// Fetch all user tags first", markdownClickStart);
const markdownClick = popupJs.slice(markdownClickStart, markdownClickEnd);
check(markdownClickStart >= 0 && markdownClickEnd > markdownClickStart &&
  markdownClick.indexOf("jinaMdBtn.disabled = true") >= 0 &&
  markdownClick.indexOf("jinaMdBtn.disabled = true") < markdownClick.indexOf("await chrome.permissions.request") &&
  markdownClick.indexOf("jinaMdBtn.disabled = false") > markdownClick.indexOf("await chrome.permissions.request") &&
  markdownClick.indexOf("await chrome.permissions.request({ origins: [PBP_JINA_ORIGIN_PATTERN] })") === markdownClick.indexOf("await ") &&
  markdownClick.includes('result.code === "host_permission"') && markdownClick.includes('t("aiGrantRetry")'),
  "popup.js: Markdown host-permission recovery is not a Jina-only first-await grant and retry");

const tagGovClickStart = optionsJs.indexOf('$id("tag-gov-ai-btn")?.addEventListener');
const tagGovClickEnd = optionsJs.indexOf("await renderWaybackLog()", tagGovClickStart);
const tagGovClick = optionsJs.slice(tagGovClickStart, tagGovClickEnd);
check(tagGovClickStart >= 0 && tagGovClickEnd > tagGovClickStart &&
  tagGovClick.indexOf("btn.disabled = true") >= 0 &&
  tagGovClick.indexOf("btn.disabled = true") < tagGovClick.indexOf("await requestAIHostPermissions(pending)") &&
  tagGovClick.indexOf("btn.disabled = false") > tagGovClick.indexOf("await requestAIHostPermissions(pending)") &&
  tagGovClick.indexOf("await requestAIHostPermissions(pending)") === tagGovClick.indexOf("await ") &&
  tagGovClick.includes("tagGovAiPendingSettings !== pending") &&
  tagGovClick.includes("await runTagGovAi(pending)"),
  "options.js: tag-governance grant click does not request before retrying the saved settings snapshot");
check(/opt-ai-provider[\s\S]{0,160}tagGovAiPendingSettings = null/.test(optionsJs.slice(optionsJs.indexOf("let tagGovAiPendingSettings"))),
  "options.js: tag-governance pending permission retry is not cleared when provider changes");
check(/function pbpLiveAiSettingsSnapshot\(provider\)/.test(optionsConnectivityJs) &&
  /const cs = pbpLiveAiSettingsSnapshot\(provider\);/.test(optionsConnectivityJs) &&
  (optionsConnectivityJs.match(/geminiApiKey: getOptVal/g) || []).length === 1 &&
  tagGovClick.indexOf("const live = pbpLiveAiSettingsSnapshot") < tagGovClick.indexOf("let sNow = await") &&
  tagGovClick.includes("sNow = { ...sNow, ...live"),
  "Options connectivity and tag governance do not share one live provider form snapshot");

check(/@media \(max-width: 720px\)[\s\S]*\.container\s*{[\s\S]*grid-template-columns:\s*1fr/.test(optionsCss), "options.css: missing mobile one-column container rule");
check(/@media \(max-width: 720px\)[\s\S]*\.options-nav\s*{[\s\S]*position:\s*static/.test(optionsCss) &&
  /@media \(max-width: 720px\)[\s\S]*\.tabs\s*{\s*display:\s*none/.test(optionsCss),
  "options.css: mobile category select does not replace the desktop tablist");

// The UA's `[hidden] { display: none }` is a NORMAL declaration, so any author
// `display` beats it by origin -- and options.html hands the bare attribute to
// controls that carry .btn (inline-flex) or .vocab-drive-actions (flex).
// options-vocab.js drives eight of them purely through the hidden property,
// including the three mutually exclusive Drive buttons, so the global fallback
// is load-bearing rather than tidiness. Counted from the markup so the check
// survives new hidden controls instead of enumerating today's eight.
{
  const globalHidden = /(^|\n)\s*\[hidden\]\s*\{[^}]*display:\s*none\s*!important/;
  const hiddenAttrs = (optionsHtml.match(/<[a-zA-Z][^>]*\shidden(?=[\s/>=])[^>]*>/g) || []).length;
  check(hiddenAttrs > 0 && globalHidden.test(optionsCss),
    `options.css: ${hiddenAttrs} element(s) in options.html ship the bare hidden attribute but options.css has no global [hidden] { display: none !important } fallback -- author display declarations outrank the UA rule by origin, so every hidden = true assignment is a visual no-op`);
  // library.css must stay out of this: .vocab-note-save[hidden] deliberately
  // keeps its layout slot via visibility:hidden (asserted above), and a global
  // display:none would take the reserved box away again.
  check(!globalHidden.test(libraryCss),
    "library.css: a global [hidden] { display: none !important } rule landed here -- it overrides .vocab-note-save[hidden]'s deliberate visibility:hidden and the note textarea jumps again");
}

// .options-nav is position:sticky and roughly 700px tall (search + 13 tabs + 5
// group labels + Reset This Tab). A sticky box has no inner scroll and the page
// scroll cannot move it, so on a viewport shorter than its own height the tail
// of the list is permanently below the fold. Accepts either escape hatch: drop
// sticky on a height breakpoint, or cap the height and scroll inside.
check(/@media[^{]*\(max-height:[^)]*\)\s*\{[\s\S]*?\.options-nav\s*\{[^}]*position:\s*static/.test(optionsCss)
  || /(^|\n)\.options-nav\s*\{[^}]*max-height:/.test(optionsCss),
  "options.css: .options-nav is sticky with no height escape hatch -- on a viewport shorter than the sidebar (1080p at 150% zoom is ~633px) the last tabs and Reset This Tab are unreachable");

// Disabled checkboxes had no visual state on this page: :disabled was only ever
// styled on the .btn family. Stage-3b Task 2 moved backup-section-picker's and
// storage-cats' disabled rows onto the .pick.pick-box primitive (COMPONENTS.md
// §6.4 exception 3): its own composer rule dims both the text AND the mark via
// `color` (not the older opacity-on-adjacent-span trick), so both containers
// now share one selector. The selector must sit in a rule that actually dims
// (declares color/opacity), not just be present in the file (the backup
// picker's selector once survived here while sharing a list with the
// #storage-cats margin rule, i.e. present and never dimmed).
check(/\.pick\s*>\s*input:disabled\s*~\s*\.pick-text[^{}]*\{[^}]*color\s*:/.test(optionsCss),
  "options.css: .pick disabled checkbox rows (backup-section-picker, storage-cats) keep full-contrast text -- the user cannot tick them and the page never says why");

function runOptionsEarly({ mode = "auto", preset = "", dark = false, syncMirror, chrome } = {}) {
  // dataset is a Proxy that counts real mutations (K33): the write-only-on-
  // change guard is the actual product of the options-theme-early.js fix,
  // so tests need to see how many times dataset.theme was actually touched,
  // not just its end state (a naive "delete then re-set" and the fixed
  // "write only on diff" produce the same end state for every input).
  const datasetStore = { theme: "stale" };
  let datasetWrites = 0;
  const dataset = new Proxy(datasetStore, {
    set(target, prop, value) { datasetWrites++; target[prop] = value; return true; },
    deleteProperty(target, prop) {
      if (prop in target) datasetWrites++;
      delete target[prop];
      return true;
    },
  });
  const root = { dataset };
  const values = new Map([["pp-theme", mode], ["pp-theme-preset", preset]]);
  // task-7/K5: "pp-sync-enabled" is only seeded when a test explicitly asks
  // for it, so the pre-existing tests above (which pass no syncMirror) keep
  // exercising the two-hop fallback path unchanged.
  if (syncMirror !== undefined) values.set("pp-sync-enabled", syncMirror);
  const timers = [];
  const context = {
    document: { documentElement: root, addEventListener() {}, getElementById() { return null; } },
    window: { matchMedia: () => ({ matches: dark }) },
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  };
  if (chrome) context.chrome = chrome;
  runInNewContext(optionsThemeEarlyJs, context);
  return {
    root, values, timers, context,
    datasetWrites: () => datasetWrites,
    resetDatasetWrites: () => { datasetWrites = 0; },
  };
}

for (const [preset, expected] of [["flexoki", "flexoki-dark"], ["solarized", "solarized-dark"], ["catppuccin", "catppuccin-mocha"]]) {
  const run = runOptionsEarly({ mode: "auto", preset, dark: true });
  check(run.root.dataset.theme === expected, `options-theme-early.js: ${preset} did not follow dark matchMedia without chrome`);
}
for (const preset of ["__proto__", "constructor"]) {
  const run = runOptionsEarly({ mode: "dark", preset });
  check(run.root.dataset.theme === preset, `options-theme-early.js: inherited key ${preset} interrupted theme bootstrap`);
}
const earlyLight = runOptionsEarly({ mode: "light", dark: true });
check(!("theme" in earlyLight.root.dataset),
  "options-theme-early.js: light/no-preset did not clear a stale theme without chrome");
check(earlyLight.timers.length === 1 && earlyLight.timers[0].ms === 3000, "options-theme-early.js: 3s fail-open timer is missing");
earlyLight.timers[0]?.fn();
check(earlyLight.root.dataset.optionsReady === "fallback", "options-theme-early.js: fail-open did not release the gate");
const earlyReady = runOptionsEarly();
earlyReady.root.dataset.optionsReady = "1";
earlyReady.timers[0]?.fn();
check(earlyReady.root.dataset.optionsReady === "1", "options-theme-early.js: fail-open overwrote authoritative readiness");

const sourceLocal = { get: defaults => Promise.resolve("optSyncEnabled" in defaults
  ? { optSyncEnabled: false } : { optTheme: "light", themePresetKey: "" }) };
const corrected = runOptionsEarly({ mode: "dark", preset: "dracula", chrome: { storage: { local: sourceLocal } } });
await new Promise(resolve => setImmediate(resolve));
check(corrected.values.get("pp-theme") === "light" && corrected.values.get("pp-theme-preset") === "" &&
  !("theme" in corrected.root.dataset), "options-theme-early.js: authoritative storage did not correct mirror and theme");

// pbpApplyOptionsEarlyTheme is called up to three times per cold Options/
// Library boot (mirror apply, authoritative re-read, onChanged) -- the K33
// fix's whole point is that a repeat call with the SAME resolved target
// must not touch dataset.theme again (popup-theme-early.js:76-103 shape).
{
  // (a) same target as what's already on dataset.theme -> zero writes.
  const same = runOptionsEarly({ mode: "auto", preset: "flexoki", dark: true });
  check(same.root.dataset.theme === "flexoki-dark", "options-theme-early.js: precondition for the repeat-call test failed");
  same.resetDatasetWrites();
  same.context.pbpApplyOptionsEarlyTheme("auto", "flexoki", true);
  check(same.datasetWrites() === 0,
    "options-theme-early.js: re-applying an unchanged theme still wrote to dataset.theme (delete-then-reset regressed)");

  // (b) target stays empty and dataset.theme is already absent -> no delete.
  const noTheme = runOptionsEarly({ mode: "light", preset: "", dark: false });
  check(!("theme" in noTheme.root.dataset), "options-theme-early.js: precondition for the no-theme repeat test failed");
  noTheme.resetDatasetWrites();
  noTheme.context.pbpApplyOptionsEarlyTheme("light", "", true);
  check(noTheme.datasetWrites() === 0,
    "options-theme-early.js: re-applying an unchanged no-theme state deleted a dataset.theme that was not there");

  // (c) a real change still writes -- exactly once, not zero.
  const changed = runOptionsEarly({ mode: "auto", preset: "flexoki", dark: true });
  changed.resetDatasetWrites();
  changed.context.pbpApplyOptionsEarlyTheme("auto", "solarized", true);
  check(changed.datasetWrites() === 1,
    "options-theme-early.js: switching preset did not write dataset.theme exactly once");
}

// K33: three runtime copies of the (mode, presetKey) -> [light, dark] preset
// map (shared.js's ADAPTIVE_THEME_MAP is authoritative; popup-theme-early.js
// and options-theme-early.js each hand-copy it). This asserts value-SET
// equality between the three copies by parsing each file's own source text
// -- it does NOT import ADAPTIVE_THEME_MAP from shared.js and treat it as
// the expectation, which would just be diffing two copies against a third
// copy instead of an independent source of truth. scripts/ui-render-audit.mjs
// carries a fourth, deliberately hand-copied oracle (its own comment says
// "not imported") that CLAUDE.md's theme-factory rule says must stay
// independent of the implementation -- it is intentionally excluded here.
// pinboard-style.js's PBP_ADAPTIVE_THEME_MAP and md-preview-theme-early.js
// are excluded too: they resolve a different (adaptive -> CSS variant /
// colorScheme) shape, not this (mode, presetKey, follow, prefersDark) ->
// data-theme lookup.
{
  function extractAdaptiveMapLiteral(source, varName) {
    const marker = `const ${varName} = {`;
    const start = source.indexOf(marker);
    if (start === -1) return null;
    const end = source.indexOf("\n};", start);
    if (end === -1) return null;
    try {
      return runInNewContext("(" + source.slice(start + `const ${varName} = `.length, end + 2) + ")", {});
    } catch (_) {
      return null;
    }
  }
  const adaptiveMapCopies = {
    "shared.js": extractAdaptiveMapLiteral(sharedJs, "ADAPTIVE_THEME_MAP"),
    "popup-theme-early.js": extractAdaptiveMapLiteral(popupThemeEarlyJs, "PBP_POPUP_ADAPTIVE_MAP"),
    "options-theme-early.js": extractAdaptiveMapLiteral(optionsThemeEarlyJs, "PBP_OPTIONS_ADAPTIVE_MAP"),
  };
  const tupleSet = (map) => map && typeof map === "object"
    ? new Set(Object.keys(map).sort().map((k) => JSON.stringify([k, ...map[k]])))
    : null;
  const [refFile, ...otherFiles] = Object.keys(adaptiveMapCopies);
  const refSet = tupleSet(adaptiveMapCopies[refFile]);
  check(refSet !== null, `${refFile}: ADAPTIVE_THEME_MAP literal not found/parseable for the K33 value-set comparison`);
  for (const file of otherFiles) {
    const set = tupleSet(adaptiveMapCopies[file]);
    check(set !== null, `${file}: adaptive theme map literal not found/parseable for the K33 value-set comparison`);
    if (refSet && set) {
      const missing = [...refSet].filter((t) => !set.has(t));
      const extra = [...set].filter((t) => !refSet.has(t));
      check(missing.length === 0 && extra.length === 0,
        `K33: adaptive theme map value-set mismatch between ${refFile} and ${file} -- missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`);
    }
  }
}

// ============ md-preview-theme-early.js: runReaderEarly (K27) ============
// Twin of runOptionsEarly above, over the reader's own anti-FOUC bootstrap.
// Unlike options-theme-early.js this file had ZERO test/script coverage
// (rg across tests/ and scripts/ for "md-preview-theme-early" was empty)
// even though rules/md-preview.md names its resolveReader() a "verbatim
// twin" of pbpResolveReaderScheme (md-preview.js:705-711) that must be kept
// in sync by hand. Asserts the OBSERVABLE product of the first-frame branch
// -- documentElement.style.colorScheme and the two hljs <link> media
// attributes (md-preview.html:8-9 / md-preview-theme-early.js:15-18) --
// against expectations hand-written from md-preview.js:705-711 and 680-683's
// stated rules, not against the twin's own source (a self-referential
// "diff the two copies" check would pass even if both sides drifted the
// same way).
function runReaderEarly({ optTheme = "auto", override = "auto", videoDark = false, search = "", syncMirror, chrome } = {}) {
  const root = { style: {} };
  const links = {
    "hljs-light-link": { media: "(prefers-color-scheme: light)" },
    "hljs-dark-link": { media: "(prefers-color-scheme: dark)" },
  };
  // Seeded directly under SHARED_THEME_KEY / SCHEME_KEY / VIDEO_KEY
  // (md-preview-theme-early.js:23/26/29) so the MIRROR_KEY fallback branch
  // never needs exercising here, same choice runOptionsEarly makes for
  // "pp-theme".
  const values = new Map([
    ["pp-theme", optTheme],
    ["md-preview-scheme", override],
    ["md-preview-video-dark", videoDark ? "1" : "0"],
  ]);
  // task-7/K5: only seeded when a test asks for it, so every pre-existing
  // caller above (no syncMirror) keeps exercising the two-hop fallback.
  if (syncMirror !== undefined) values.set("pp-sync-enabled", syncMirror);
  const context = {
    // videoMode (line 33) is read from location.search at parse time, not a
    // constructor argument -- this is the one input runOptionsEarly's
    // "preset" axis has no analogue for.
    location: { search },
    document: {
      documentElement: root,
      getElementById: (id) => links[id] || null,
    },
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    // chrome intentionally omitted unless passed: typeof chrome ===
    // "undefined" is true for an identifier never declared in this vm
    // context, so the async source-of-truth tail (md-preview-theme-early.js:71)
    // short-circuits at its own early return and only the synchronous
    // first-frame branch runs -- same trick runOptionsEarly uses.
  };
  if (chrome) context.chrome = chrome;
  runInNewContext(mdPreviewThemeEarlyJs, context);
  return { root, links, values };
}

// The rule restated independently of either implementation (same shape as
// the pbpResolveReaderScheme "full matrix" test at
// tests/md-ai-tests.html:5359-5360): an explicit override wins; otherwise a
// video page with the checkbox on is dark; otherwise the global theme
// passes through unless it is not one of light/dark, in which case "auto".
function expectedReaderMode(optTheme, override, videoMode, videoDark) {
  if (override === "light" || override === "dark") return override;
  if (videoMode && videoDark) return "dark";
  return optTheme === "light" || optTheme === "dark" ? optTheme : "auto";
}
// md-preview.js:680-683's pbpResolveColorScheme mapping (md-preview-theme-early.js's
// resolve(), lines 35-39, is a verbatim copy of it).
function expectedReaderResolve(mode) {
  if (mode === "dark") return { colorScheme: "dark", lightMedia: "not all", darkMedia: "all" };
  if (mode === "light") return { colorScheme: "light", lightMedia: "all", darkMedia: "not all" };
  return { colorScheme: "", lightMedia: "(prefers-color-scheme: light)", darkMedia: "(prefers-color-scheme: dark)" };
}

// resolveReader() has no map indexed by a settings-derived string key (no
// ADAPTIVE_THEME_MAP-style lookup the way options-theme-early.js's preset
// is), so there is no __proto__/constructor analogue to add here -- the
// only string inputs (optTheme/override) are compared with ===, never used
// as object keys.
{
  let combos = 0;
  for (const optTheme of ["auto", "light", "dark"]) {
    for (const override of ["auto", "light", "dark", "bogus"]) {
      for (const search of ["", "?video=1"]) {
        for (const videoDark of [false, true]) {
          combos++;
          const videoMode = search === "?video=1";
          const run = runReaderEarly({ optTheme, override, videoDark, search });
          const mode = expectedReaderMode(optTheme, override, videoMode, videoDark);
          const expected = expectedReaderResolve(mode);
          const label = `optTheme=${optTheme} override=${override} search=${JSON.stringify(search)} videoDark=${videoDark} (expected mode ${mode})`;
          check(run.root.style.colorScheme === expected.colorScheme,
            `md-preview-theme-early.js: colorScheme mismatch for ${label}`);
          check(run.links["hljs-light-link"].media === expected.lightMedia,
            `md-preview-theme-early.js: hljs-light-link media mismatch for ${label}`);
          check(run.links["hljs-dark-link"].media === expected.darkMedia,
            `md-preview-theme-early.js: hljs-dark-link media mismatch for ${label}`);
        }
      }
    }
  }
  check(combos === 48, "md-preview-theme-early.js: runReaderEarly matrix size (3 optTheme x 4 override x 2 search x 2 videoDark)");
}

// The async source-of-truth branch (chrome.storage read, lines 71-85) is a
// second call into the same resolve()/apply() pair fed from chrome.storage
// instead of localStorage. One case confirms it actually corrects a stale
// mirror and re-applies -- mirroring runOptionsEarly's `corrected` case
// above rather than re-running the full matrix through it.
{
  const chromeLocal = {
    get: (defaults) => Promise.resolve("optSyncEnabled" in defaults
      ? { optSyncEnabled: false, pbp_color_scheme: "dark" }
      : { optTheme: "light", mdVideoDarkScheme: false }),
  };
  const readerCorrected = runReaderEarly({
    optTheme: "auto", override: "auto", videoDark: false, search: "",
    chrome: { storage: { local: chromeLocal } },
  });
  await new Promise(resolve => setImmediate(resolve));
  check(readerCorrected.values.get("md-preview-theme") === "light" &&
    readerCorrected.values.get("md-preview-scheme") === "dark" &&
    readerCorrected.values.get("md-preview-video-dark") === "0" &&
    readerCorrected.root.style.colorScheme === "dark" &&
    readerCorrected.links["hljs-light-link"].media === "not all" &&
    readerCorrected.links["hljs-dark-link"].media === "all",
    "md-preview-theme-early.js: chrome.storage correction (override=dark) did not re-seed the mirrors and re-apply the resolved scheme");
}

// ============ task-7/K5: "pp-sync-enabled" one-hop mirror merge ============
// All three theme-early scripts read the localStorage mirror shared.js keeps
// current on every authoritative settings read/write (shared.js:
// getSettingsStorage's sync fast-path, its onChanged invalidation listener,
// and pbpReadSettingsWithSecrets -- the last one refreshes it on every popup/
// options/library open, so the mirror is hit in steady state). A hit lets
// each script's optSyncEnabled hop collapse: popup and options skip the
// local.get({optSyncEnabled}) round trip outright and read the routed area
// directly; the reader (which also needs the local-only pbp_color_scheme key
// in the same hop) instead fires its local + routed-area reads CONCURRENTLY
// once the mirror picks the area. A miss (first run / cleared site data)
// must fall back to today's two-hop chain byte-for-byte.
//
// countingArea/countingLocalDual wrap a storage.get so a test can assert not
// just the end VALUE (already covered above) but the CALL SHAPE -- how many
// times, and with which defaults, chrome.storage.{local,sync}.get fired --
// which is the actual product of this task (CLAUDE.md: assertions must
// question the category, and "was this hop skipped" can only be answered
// from what the code actually called, not from the value it settled on).
function countingArea(response) {
  let calls = 0;
  return { get: () => { calls++; return Promise.resolve(response); }, count: () => calls };
}
function countingLocalDual(syncEnabledResponse, themeResponse) {
  let calls = 0;
  return {
    get: (defaults) => {
      calls++;
      return Promise.resolve(Object.prototype.hasOwnProperty.call(defaults, "optSyncEnabled")
        ? syncEnabledResponse : themeResponse);
    },
    count: () => calls,
  };
}

// Twin of runOptionsEarly/runReaderEarly above: popup-theme-early.js had no
// VM harness at all before this task (only extractAdaptiveMapLiteral's
// static text parse). Only exercises the async tail (section 41-107 of the
// file) relevant to the mirror merge; applyTabMirror's DOMContentLoaded path
// is inert here (no "pp-last-tab" seeded, same abstinence runOptionsEarly
// shows toward fields it does not need).
function runPopupEarly({ syncMirror, chrome } = {}) {
  const datasetStore = {};
  const dataset = new Proxy(datasetStore, {
    set(target, prop, value) { target[prop] = value; return true; },
    deleteProperty(target, prop) { delete target[prop]; return true; },
  });
  const styleProps = {};
  const root = { dataset, style: { setProperty(k, v) { styleProps[k] = v; } } };
  const values = new Map();
  if (syncMirror !== undefined) values.set("pp-sync-enabled", syncMirror);
  const context = {
    document: { documentElement: root, addEventListener() {}, getElementById() { return null; } },
    window: { matchMedia: () => ({ matches: false }) },
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    chrome,
  };
  runInNewContext(popupThemeEarlyJs, context);
  return { root, values, styleProps };
}

// --- popup-theme-early.js: mirror "1" picks sync directly, zero local.get calls ---
{
  const syncArea = countingArea({ optTheme: "dark", themePresetKey: "", optPopupFollowTheme: true, popupWidth: 600 });
  const localSpy = countingArea({});
  const run = runPopupEarly({ syncMirror: "1", chrome: { storage: { sync: syncArea, local: localSpy } } });
  await new Promise(resolve => setImmediate(resolve));
  check(localSpy.count() === 0,
    'popup-theme-early.js: pp-sync-enabled mirror "1" still called chrome.storage.local.get (the optSyncEnabled hop was not skipped)');
  check(syncArea.count() === 1,
    'popup-theme-early.js: pp-sync-enabled mirror "1" did not read the sync area in exactly one hop');
  check(run.values.get("pp-theme") === "dark" && run.root.dataset.theme === "flexoki-dark",
    'popup-theme-early.js: pp-sync-enabled mirror "1" did not apply/mirror the sync-area theme correctly');
}

// --- popup-theme-early.js: mirror "0" picks local directly, exactly one hop ---
{
  const localArea = countingArea({ optTheme: "light", themePresetKey: "dracula", optPopupFollowTheme: true, popupWidth: 480 });
  const run = runPopupEarly({ syncMirror: "0", chrome: { storage: { local: localArea, sync: countingArea({}) } } });
  await new Promise(resolve => setImmediate(resolve));
  check(localArea.count() === 1,
    'popup-theme-early.js: pp-sync-enabled mirror "0" did not read the local area in exactly one hop');
  check(run.values.get("pp-theme") === "light" && run.root.dataset.theme === "dracula",
    'popup-theme-early.js: pp-sync-enabled mirror "0" did not apply/mirror the local-area theme correctly');
}

// --- popup-theme-early.js: missing mirror falls back to the original two-hop chain ---
{
  const localDual = countingLocalDual({ optSyncEnabled: false },
    { optTheme: "auto", themePresetKey: "", optPopupFollowTheme: true, popupWidth: 550 });
  const syncSpy = countingArea({});
  runPopupEarly({ chrome: { storage: { local: localDual, sync: syncSpy } } });
  await new Promise(resolve => setImmediate(resolve));
  check(localDual.count() === 2 && syncSpy.count() === 0,
    "popup-theme-early.js: a missing pp-sync-enabled mirror did not fall back to the original two-hop local-only chain");
}

// --- options-theme-early.js: same three cases over its boot-time hop ---
{
  const syncArea = countingArea({ optTheme: "dark", themePresetKey: "flexoki", optPopupFollowTheme: true });
  const localSpy = countingArea({});
  const run = runOptionsEarly({ syncMirror: "1", dark: true, chrome: { storage: { sync: syncArea, local: localSpy } } });
  await new Promise(resolve => setImmediate(resolve));
  check(localSpy.count() === 0,
    'options-theme-early.js: pp-sync-enabled mirror "1" still called chrome.storage.local.get on boot (the optSyncEnabled hop was not skipped)');
  check(syncArea.count() === 1,
    'options-theme-early.js: pp-sync-enabled mirror "1" did not read the sync area in exactly one hop on boot');
  check(run.root.dataset.theme === "flexoki-dark",
    'options-theme-early.js: pp-sync-enabled mirror "1" did not apply the sync-area theme correctly on boot');
}
{
  const localArea = countingArea({ optTheme: "light", themePresetKey: "dracula", optPopupFollowTheme: true });
  const run = runOptionsEarly({ syncMirror: "0", chrome: { storage: { local: localArea, sync: countingArea({}) } } });
  await new Promise(resolve => setImmediate(resolve));
  check(localArea.count() === 1,
    'options-theme-early.js: pp-sync-enabled mirror "0" did not read the local area in exactly one hop on boot');
  check(run.root.dataset.theme === "dracula",
    'options-theme-early.js: pp-sync-enabled mirror "0" did not apply the local-area theme correctly on boot');
}
{
  const localDual = countingLocalDual({ optSyncEnabled: false },
    { optTheme: "auto", themePresetKey: "", optPopupFollowTheme: true });
  const syncSpy = countingArea({});
  runOptionsEarly({ chrome: { storage: { local: localDual, sync: syncSpy } } });
  await new Promise(resolve => setImmediate(resolve));
  check(localDual.count() === 2 && syncSpy.count() === 0,
    "options-theme-early.js: a missing pp-sync-enabled mirror did not fall back to the original two-hop chain on boot");
}

// --- md-preview-theme-early.js: mirror "1" fires local(pbp_color_scheme) + sync(theme) concurrently ---
{
  const localArea = countingArea({ pbp_color_scheme: "dark" });
  const syncArea = countingArea({ optTheme: "light", mdVideoDarkScheme: false });
  const run = runReaderEarly({ syncMirror: "1", chrome: { storage: { local: localArea, sync: syncArea } } });
  await new Promise(resolve => setImmediate(resolve));
  check(localArea.count() === 1 && syncArea.count() === 1,
    'md-preview-theme-early.js: pp-sync-enabled mirror "1" did not read local(pbp_color_scheme) and sync(theme keys) exactly once each');
  check(run.values.get("md-preview-theme") === "light" && run.values.get("md-preview-scheme") === "dark",
    'md-preview-theme-early.js: pp-sync-enabled mirror "1" did not re-seed the mirrors from the concurrent reads');
}

// --- md-preview-theme-early.js: mirror "0" folds pbp_color_scheme + theme keys into ONE local.get ---
{
  const localArea = countingArea({ pbp_color_scheme: "light", optTheme: "dark", mdVideoDarkScheme: true });
  const run = runReaderEarly({ syncMirror: "0", chrome: { storage: { local: localArea, sync: countingArea({}) } } });
  await new Promise(resolve => setImmediate(resolve));
  check(localArea.count() === 1,
    'md-preview-theme-early.js: pp-sync-enabled mirror "0" did not fold pbp_color_scheme and the theme keys into a single chrome.storage.local.get call');
  check(run.values.get("md-preview-theme") === "dark" && run.values.get("md-preview-scheme") === "light" &&
    run.values.get("md-preview-video-dark") === "1",
    'md-preview-theme-early.js: pp-sync-enabled mirror "0" did not re-seed the mirrors from the merged local read');
}

// --- md-preview-theme-early.js: missing mirror falls back to the original two-hop chain ---
{
  const localDual = countingLocalDual({ optSyncEnabled: false, pbp_color_scheme: "auto" },
    { optTheme: "auto", mdVideoDarkScheme: false });
  const syncSpy = countingArea({});
  runReaderEarly({ chrome: { storage: { local: localDual, sync: syncSpy } } });
  await new Promise(resolve => setImmediate(resolve));
  check(localDual.count() === 2 && syncSpy.count() === 0,
    "md-preview-theme-early.js: a missing pp-sync-enabled mirror did not fall back to the original two-hop local-only chain");
}

const optionsHead = optionsHtml.slice(optionsHtml.indexOf("<head>"), optionsHtml.indexOf("</head>"));
const optionsEarlyTag = '<script src="options-theme-early.js"></script>';
check(optionsHead.indexOf(optionsEarlyTag) >= 0 &&
  optionsHead.indexOf(optionsEarlyTag) < optionsHead.indexOf('<link rel="stylesheet" href="options.css">') &&
  (optionsHtml.match(/options-theme-early\.js/g) || []).length === 1,
  "options.html: theme bootstrap is not one synchronous head script before options.css");
check(/\.container\s*{[\s\S]{0,100}visibility:\s*hidden/.test(optionsCss) &&
  /html\[data-options-ready\]\s+\.container\s*{\s*visibility:\s*visible/.test(optionsCss),
  "options.css: stable first-frame gate is missing");
function inOrder(source, ...parts) {
  let cursor = -1;
  return parts.every(part => (cursor = source.indexOf(part, cursor + 1)) >= 0);
}
const optionsThemeApplyStart = optionsJs.indexOf("function applyOptionsPageTheme");
const optionsThemeApplyEnd = optionsJs.indexOf("// Track active preset key", optionsThemeApplyStart);
const optionsThemeApply = optionsJs.slice(optionsThemeApplyStart, optionsThemeApplyEnd);
check(optionsThemeApply.includes('pbpApplyOptionsEarlyTheme(themeMode, presetKey, $id("opt-popup-follow-theme").checked)') &&
  !optionsThemeApply.includes("pbpStoreOptionsThemeMirror"),
  "options.js: visual theme apply also mutates the persisted mirror");
check(inOrder(optionsJs,
  "Object.entries(fieldMap)", "el.value = val", "Object.entries(checkMap)", "el.checked = val",
  "syncKeysToggle.checked = syncApiKeys", "applyOptionsPageTheme(currentPresetKey, s.optTheme);",
  "pbpStoreOptionsThemeMirror(s.optTheme, currentPresetKey, s.optPopupFollowTheme !== false);",
  'document.documentElement.dataset.optionsReady = "1";', "// Language change"),
  "options.js: General values, authoritative theme/mirror, and ready gate are out of order");
const optionsSnapshotStart = optionsJs.indexOf("async function pbpSaveOptionsSnapshot");
const optionsSnapshotEnd = optionsJs.indexOf("function pbpQueueOptionsSave", optionsSnapshotStart);
const optionsSnapshot = optionsJs.slice(optionsSnapshotStart, optionsSnapshotEnd);
const optionsSaveAllStart = optionsJs.indexOf("async function saveAll()", optionsSnapshotEnd);
const optionsSaveAllEnd = optionsJs.indexOf("function reportAutoSaveFailure", optionsSaveAllStart);
const optionsSaveAll = optionsJs.slice(optionsSaveAllStart, optionsSaveAllEnd);
check(inOrder(optionsSnapshot, "await persist(settingsDelta)", "if (!res.ok)",
  "if (onSettingsSaved) onSettingsSaved(settingsDelta);",
  "overlay = await saveOverlay(overlayValue);") &&
  /onSettingsSaved\(settingsDelta\)[\s\S]*pbpStoreOptionsThemeMirror\(data\.optTheme, data\.themePresetKey, data\.optPopupFollowTheme !== false\)/.test(optionsSaveAll),
  "options.js: theme mirror is updated before settings persistence succeeds or after overlay work");

check(/const el = document\.createElement\("button"\);[\s\S]{0,240}el\.className = "stag";/.test(popupTagsJs), "popup-tags.js: suggested tag is not a button");
check(/const aa = document\.createElement\("button"\);[\s\S]{0,240}aa\.className = "add-all-link";/.test(popupTagsJs), "popup-tags.js: add-all is not a button");
check(/const rm = document\.createElement\("button"\);[\s\S]{0,240}rm\.className = "tag-remove";/.test(popupTagsJs), "popup-tags.js: tag remove is not a button");
check(/<button\b(?=[^>]*id="tags-last-used")(?=[^>]*type="button")[^>]*>/.test(popupHtml), "popup.html: #tags-last-used is not a button");

check(/<section\b(?=[^>]*id="batch-permission")(?=[^>]*aria-labelledby="batch-permission-title")[^>]*>/.test(popupHtml) &&
  /<ul\b[^>]*id="batch-permission-list"[^>]*>/.test(popupHtml),
  "popup.html: Batch permission disclosure lacks labelled section/list semantics");
check(["batch-permission-grant", "batch-permission-cancel"].every(id =>
  new RegExp(`<button\\b(?=[^>]*id="${id}")(?=[^>]*type="button")[^>]*>`).test(popupHtml)),
  "popup.html: Batch permission actions are not real buttons");
const batchGrantStart = popupBatchJs.indexOf('grantBtn?.addEventListener("click", async () =>');
const batchGrantEnd = popupBatchJs.indexOf('cancelBtn?.addEventListener', batchGrantStart);
const batchGrant = popupBatchJs.slice(batchGrantStart, batchGrantEnd);
check(batchGrantStart >= 0 && batchGrantEnd > batchGrantStart &&
  batchGrant.indexOf("await chrome.permissions.request({ origins: pending.origins })") === batchGrant.indexOf("await ") &&
  batchGrant.indexOf("await chrome.permissions.request({ origins: pending.origins })") < batchGrant.indexOf("await dispatchBatchSave"),
  "popup-batch.js: Grant does not request the disclosed origins as its first await before starting Batch");
check(!/\bconfirm\s*\(/.test(popupBatchJs) && !popupBatchJs.includes("BATCH_PERMISSION_DISCLOSE_LIMIT") &&
  !popupBatchJs.includes("batchPermMore") && !popupBatchJs.includes("*://*/*"),
  "popup-batch.js: native confirm, truncated disclosure, or broad wildcard remains");
// Destructive micro-actions use the anchored confirm popover everywhere. The
// sanctioned native dialogs are the sync-enable conflict chain and the
// account-wide credential-sync disable confirmation.
check(!/\bconfirm\s*\(/.test(popupJs),
  "popup.js: a native confirm() dialog crept back in (use showConfirmPopover)");
check(!/\bconfirm\s*\(/.test(read("library-notes.js")),
  "library-notes.js: a native confirm() dialog crept back in (use showConfirmPopover)");
check((optionsJs.match(/\bconfirm\(t\(/g) || []).length === 3 &&
  optionsJs.includes('confirm(t("syncApiKeysDisableConfirm"))'),
  "options.js: native confirm() calls drifted from the sanctioned sync transitions");
check(/\.batch-permission-list\s*\{[\s\S]*?max-height:\s*92px;[\s\S]*?overflow:\s*auto;/.test(popupCss),
  "popup.css: complete Batch permission list is not bounded with scrolling");

check(/<aside\b(?=[^>]*id="rail")(?=[^>]*aria-labelledby="preview-title")[^>]*>/.test(mdHtml),
  "md-preview.html: mobile drawer is not labelled by the document title");
const drawerSetupStart = mdPreviewJs.indexOf("function setupDrawer()");
const drawerSetupEnd = mdPreviewJs.indexOf("function pbpRailDrawerClose()", drawerSetupStart);
const drawerSetup = mdPreviewJs.slice(drawerSetupStart, drawerSetupEnd);
const drawerCloseEnd = mdPreviewJs.indexOf("function pbpFocusArticleTarget", drawerSetupEnd);
const drawerClose = mdPreviewJs.slice(drawerSetupEnd, drawerCloseEnd);
check(drawerSetupStart >= 0 && drawerSetup.includes("main.inert = true") &&
  drawerSetup.includes('rail.setAttribute("aria-modal", "true")') &&
  drawerSetup.includes("requestAnimationFrame(() =>") &&
  drawerSetup.includes('document.getElementById("btn-rendered")') &&
  drawerSetup.includes('window.matchMedia("(max-width: 1000px)").addEventListener("change"') &&
  drawerSetup.includes("if (!e.matches) pbpRailDrawerClose()"),
"md-preview.js: drawer open/breakpoint state does not manage modal inertness");
// Opening the drawer must land focus INSIDE the modal. Any preferred landing
// element has to be visibility-tested first, with a fallback to the rail's own
// focusable list: on the extraction-failure shell body.md-shell hides
// `.rail > .view-toggle`, so focusing a hidden #btn-rendered is a silent no-op
// and focus stays on the hamburger, outside the aria-modal drawer.
const drawerOpenStart = drawerSetup.indexOf("if (main) main.inert = true");
const drawerOpenFocus = drawerOpenStart < 0 ? ""
  : drawerSetup.slice(drawerOpenStart, drawerSetup.indexOf("} else {", drawerOpenStart));
check(drawerOpenFocus.includes("offsetParent !== null") && drawerOpenFocus.includes("focusables()"),
  "md-preview.js: the drawer's open focus handoff is not visibility-gated -- a hidden landing element (body.md-shell hides the Raw/Rendered pair on the error shell) makes focus() a no-op, so the modal drawer opens with focus stranded outside it");
check(drawerClose.includes('document.body.classList.remove("rail-open")') &&
  drawerClose.includes("scrim.hidden = true") && drawerClose.includes('rail.removeAttribute("aria-modal")') &&
  drawerClose.includes("main.inert = false"),
"md-preview.js: shared drawer close does not clear every modal state");
const focusTargetEnd = mdPreviewJs.indexOf("// In tr-only mode", drawerCloseEnd);
const focusTarget = mdPreviewJs.slice(drawerCloseEnd, focusTargetEnd);
check(focusTarget.includes("pbpRailDrawerClose()") && focusTarget.includes("target.focus({ preventScroll: true })") &&
  mdPreviewJs.includes("pbpFocusArticleTarget(target);") &&
  mdAskJs.includes("pbpFocusArticleTarget(target);") &&
  (mdHighlightJs.match(/pbpFocusArticleTarget\(/g) || []).length >= 2,
"md-preview: TOC, Ask citations, and Notebook do not share visible-target focus recovery");

const askOpen = mdAskJs.slice(mdAskJs.indexOf("function _pbpAskSetOpen"), mdAskJs.indexOf("// Clear:", mdAskJs.indexOf("function _pbpAskSetOpen")));
check(askOpen.includes("drawerWasOpen") && askOpen.includes("pbpRailDrawerClose()") &&
  askOpen.includes('document.getElementById("rail-toggle")') && askOpen.includes("getBoundingClientRect()") &&
  askOpen.includes('document.getElementById("ask-open")') && askOpen.includes(".find(isVisible)"),
"md-ask.js: opening Ask from the drawer leaves a hidden opener/focus target");
const askError = mdAskJs.slice(mdAskJs.indexOf("function _pbpAskErrorUi"), mdAskJs.indexOf("// Core runner", mdAskJs.indexOf("function _pbpAskErrorUi")));
check(askError.indexOf("aEl.focus()") >= 0 && askError.indexOf("aEl.focus()") < askError.indexOf("aEl.replaceChildren()"),
  "md-ask.js: Ask retry removes its focused button before focus handoff");
const askClear = mdAskJs.slice(mdAskJs.indexOf("function _pbpAskShowClearConfirm"), mdAskJs.indexOf("// ---- Restore persisted", mdAskJs.indexOf("function _pbpAskShowClearConfirm")));
check(askClear.indexOf("input.focus()") < askClear.indexOf("strip.remove()") &&
  askClear.indexOf("clearBtn.focus()") < askClear.lastIndexOf("strip.remove()"),
"md-ask.js: clear confirmation removes the focused action before focus handoff");
const askRegenerate = mdAskJs.slice(mdAskJs.indexOf("function _pbpAskRegenerate"), mdAskJs.indexOf("// ---- Clear:", mdAskJs.indexOf("function _pbpAskRegenerate")));
check(askRegenerate.indexOf("el.focus()") >= 0 && askRegenerate.indexOf("el.focus()") < askRegenerate.indexOf("el.replaceChildren()"),
  "md-ask.js: regenerate removes its focused button before focus handoff");
const skimRegenFocus = mdSkimJs.slice(mdSkimJs.indexOf("async function _pbpSkimRegen"), mdSkimJs.indexOf("// Init hookup", mdSkimJs.indexOf("async function _pbpSkimRegen")));
check(skimRegenFocus.indexOf("body.focus()") >= 0 && skimRegenFocus.indexOf("body.focus()") < skimRegenFocus.indexOf("body.replaceChildren()"),
  "md-skim.js: retry removes its focused button before focus handoff");
const explainRun = mdAskJs.slice(mdAskJs.indexOf("async function _pbpExplainRun"), mdAskJs.indexOf("// ---- Explain: open", mdAskJs.indexOf("async function _pbpExplainRun")));
check(explainRun.indexOf("body.focus()") >= 0 && explainRun.indexOf("body.focus()") < explainRun.indexOf("body.replaceChildren()"),
  "md-ask.js: Explain retry removes its focused button before focus handoff");
const explainShell = mdAskJs.slice(mdAskJs.indexOf("// ---- Explain: popover shell"), mdAskJs.indexOf("// ---- Explain: context pack"));
check(explainShell.includes('pop.setAttribute("popover", "manual")') &&
  explainShell.includes("PBP_EXPLAIN_PIN_SVG") && explainShell.includes("PBP_EXPLAIN_CLOSE_SVG") &&
  explainShell.includes('pin.className = "xp-pin"') && explainShell.includes('close.className = "xp-close"') &&
  explainShell.includes('pin.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight")') &&
  explainShell.includes('pin.setAttribute("aria-pressed"') && explainShell.includes('pin.setAttribute("aria-label", label)') &&
  explainShell.includes('close.setAttribute("aria-label", t("explainClose"))'),
"md-ask.js: explain-pop is not a manual popover with native pin/close SVG controls");
check(explainShell.indexOf("_pbpExplainSetPinned(pop, false)") > explainShell.indexOf("pop.appendChild(head)"),
  "md-ask.js: explain pin is initialized before it becomes a popover descendant");
check(explainShell.includes("setPointerCapture") && explainShell.includes('addEventListener("pointermove"') &&
  explainShell.includes('addEventListener("pointercancel"') && explainShell.includes('addEventListener("resize"') &&
  explainShell.includes("new ResizeObserver") && explainShell.includes('matches(":popover-open")') &&
  explainShell.includes("e.altKey") && explainShell.includes("pbpExplainClampPosition") &&
  explainShell.includes('dragZone.className = "xp-drag-zone"') && explainShell.includes("!e.isPrimary"),
"md-ask.js: explain-pop lacks pointer capture, viewport clamping, resize handling, or Alt+Arrow movement");
check(explainShell.includes('document.querySelectorAll(":popover-open")') &&
  explainShell.includes("some((el) => el !== pop)"),
"md-ask.js: pinned explain-pop consumes Escape before a visually upper transient popover");
check(explainRun.includes("if (_pbpExplainAbort === ctrl) body.removeAttribute(\"aria-busy\")"),
"md-ask.js: a superseded Explain run can clear the active run's busy state");
check(explainShell.includes("explainTranslateSelection") && explainShell.includes("dictLookupSelection") &&
  explainRun.includes("explainTranslateLoading") && explainRun.includes("dictLoading") &&
  explainRun.includes("explainAiNotConfigured") && explainRun.includes("explainTranslateAiNotConfigured"),
"md-ask.js: dialog names, loading states, or no-AI messages are not action-specific");
const explainOpen = mdAskJs.slice(mdAskJs.indexOf("function _pbpExplainOpenPop"), mdAskJs.indexOf("// ---- Card AI row entry point"));
check(explainOpen.includes("_pbpExplainPinned") && explainOpen.includes('if (!pop.matches(":popover-open")) pop.showPopover()') &&
  explainOpen.includes("if (!_pbpExplainPinned)"),
"md-ask.js: pinned explain re-entry can hide/show or re-anchor the popover");
check(mdReaderJsSource.includes("_pbpReaderKeepPopover") &&
  (mdReaderJsSource.match(/_pbpReaderHideOtherPopovers\(/g) || []).length >= 5 &&
  mdHighlightJs.includes("pbpExplainDismissIfUnpinned"),
"reader/highlight popover mutual exclusion does not preserve a pinned explain-pop");
check(mdCss.includes(".xp-window-actions") && mdCss.includes(".xp-pin") && mdCss.includes(".xp-close") &&
  mdCss.includes(".xp-dragging") && mdCss.includes(".xp-drag-zone") &&
  !/\.xp-(?:pin|close)[^\n]*[📌📍✕×]/u.test(mdCss),
"md-preview.css: explain window controls or drag state are missing, or use literal symbol glyphs");
// The header reflow used to hang off a `@media (max-width: 420px)` breakpoint,
// which keyed on the VIEWPORT while the card is a fixed 420px -- so on any
// desktop it never fired and the title was squeezed to a few characters. The
// two-row layout is now unconditional, which is what the breakpoint was reaching
// for anyway. Pinned structurally so nobody folds it back behind a query.
check(/\.xp-head \{[^}]*flex-wrap: wrap;/.test(mdCss) &&
  /\.xp-act-group \{[^}]*flex: 1 0 100%;/.test(mdCss) &&
  /\.xp-term \{[^}]*flex: 1 1 48px;/.test(mdCss),
"md-preview.css: the explain header stopped giving the action group its own row and the title the rest");
// The drag zone must not grow. Once the title started taking free space, a
// growing drag zone split it and cut German to 40% of the card.
check(/\.xp-drag-zone \{[\s\S]{0,400}?flex: 0 0 12px;/.test(mdCss),
"md-preview.css: the drag zone grows again and competes with the title for width");
check(mdDictJs.includes("dictMatchedHeadword") && mdDictJs.includes("dictPermissionDenied") &&
  mdDictJs.includes("dictConnectRetry") && mdDictJs.includes("dictUpdateVocab") &&
  mdDictJs.includes("Intl.DisplayNames") && libraryVocabJs.includes("pbpDictLanguageLabel"),
"dictionary UI does not disclose fallback headwords, permission denial, saved-word updates, or localized language names");

const articleInject = mdPreviewJs.indexOf("renderedView.innerHTML = renderedHtml");
const firstProgressQueue = mdPreviewJs.indexOf("queueReadingStats();", articleInject);
check(articleInject >= 0 && firstProgressQueue > articleInject &&
  !mdPreviewJs.slice(mdPreviewJs.indexOf("// Reading stats"), articleInject).includes("renderStats();") &&
  mdPreviewJs.includes("new ResizeObserver(queueReadingStats).observe(renderedView)"),
"md-preview.js: reading progress is measured before article layout or not refreshed after layout changes");

// i18n substitutions ride t()/getMessage() ARGS, never a manual replace on
// the result: for any messages.json key carrying a "placeholders" block,
// chrome.i18n.getMessage (the t() fallback in auto-language mode) consumes
// $NAME$ placeholders BEFORE a manual replace could see them -- the value
// silently rendered empty (mdEmbedPartial counts and the reading-progress
// percent shipped blank for every auto-language user until 2026-07). The
// pattern bans ANY literal $NAME$ manual replace/replaceAll in root JS
// (Codex cross-audit: anchoring on the t(...) call missed nested-paren args,
// a variable between call and replace, and replaceAll); $NAME$ syntax exists
// only for i18n placeholders here, and the safe {name}-token replaces on
// placeholder-less keys don't match.
for (const f of readdirSync(root).filter((n) => n.endsWith(".js"))) {
  const m = read(f).match(/\.replace(?:All)?\(\s*["'`]\$[A-Za-z_]\w*\$["'`]\s*,/);
  check(!m, `${f}: literal $NAME$ manual replace -- pass substitutions as t() args instead -> ${m && m[0]}`);
}
// applyI18n (i18n.js) can never supply substitutions, so a placeholders key
// wired to a data-i18n* attribute renders empty (auto mode) or as a literal
// $NAME$ (manual language) -- the intersection must stay empty.
// Plus a HEURISTIC dead-key smoke check: every placeholders key's string
// literal must appear somewhere in root JS/HTML (batchSavedNotify survived
// the batch-to-SW migration by a year). Heuristic by design: a comment can
// satisfy it and it doesn't verify arg counts -- the runtime audit for that
// was done by hand (Codex-verified, 2026-07); this just catches key deletions
// and renames going stale.
{
  const enMessages = JSON.parse(read("_locales/en/messages.json"));
  const phKeys = Object.entries(enMessages).filter(([, d]) => d && d.placeholders).map(([k]) => k);
  const htmlSrc = readdirSync(root).filter((n) => n.endsWith(".html")).map(read).join("\n");
  const allSrc = readdirSync(root).filter((n) => n.endsWith(".js")).map(read).join("\n") + htmlSrc;
  for (const key of phKeys) {
    check(!new RegExp(`data-i18n[a-z-]*="${key}"`).test(htmlSrc),
      `md/popup/options HTML: placeholders key "${key}" bound via data-i18n* (applyI18n cannot pass substitutions)`);
    check(allSrc.includes(`"${key}"`), `_locales/en: placeholders key "${key}" has no call site in any root JS/HTML (dead key across 9 locales?)`);
  }
}

// ---- Reader typography invariants (plan B, the four defects Codex acceptance
// reproduced live -- each check encodes one so it cannot silently return;
// .qa-scan/typo-export-probe.mjs is the manual behavioral deep-probe, this is
// the per-verify gate). ----
const mdReaderJs = read("md-reader.js");
// (1) Load race: the tier maps/apply MUST live in shared.js (loaded before
// md-preview.js), never in the later md-reader.js defer script; and the
// pre-render read in md-preview.js must fetch the tier keys with the payload.
check(sharedJs.includes("function pbpTypoApplyVars") && sharedJs.includes("PBP_TYPO_FONT_SCALES"),
  "shared.js: typography tier maps/apply moved out (md-preview.js pre-render apply would race again)");
check(!mdReaderJs.includes("function pbpTypoApplyVars") && !mdReaderJs.includes("PBP_TYPO_FONT_SCALES ="),
  "md-reader.js: re-defines typography maps/apply (load-order race: it loads AFTER md-preview.js)");
{
  // Both indexes checked >= 0 explicitly: a DELETED apply call returns -1,
  // and -1 < renderAt would sail through the bare comparison (Codex final
  // review) -- the gate must catch removal, not just reordering.
  const applyAt = mdPreviewJs.indexOf("pbpTypoApplyVars(");
  const renderAt = mdPreviewJs.indexOf("renderedView.innerHTML = renderedHtml");
  // Key membership, not the literal array text: the reading-width key rides
  // the same get (item #93) and more may follow. What matters is that no
  // reading preference costs a SECOND storage round trip, and that they are
  // all applied before the first paint.
  const preReadCall = (mdPreviewJs.match(/chrome\.storage\.local\.get\(\[MP_KEY[^\]]*\]\)/) || [""])[0];
  check(preReadCall.includes('"pbp_font_tier"') && preReadCall.includes('"pbp_leading_tier"') &&
    applyAt >= 0 && renderAt >= 0 && applyAt < renderAt,
    "md-preview.js: typography tiers not applied before the first render (rode the MP_KEY read)");
  // Same contract for the reading width: md-reader.js's _pbpZenInit only runs
  // on "pbp:rendered", so a stored 680/1080 painted at the 880 CSS fallback
  // and re-laid the whole article out once per open.
  const widthAt = mdPreviewJs.indexOf('document.body.style.setProperty("--pbp-width"');
  check(preReadCall.includes('"pbp_zen_width"') && widthAt >= 0 && widthAt < renderAt &&
    mdPreviewJs.includes("window._pbpZenWidthStored = { width: data.pbp_zen_width }"),
    "md-preview.js: the stored reading width no longer rides the pre-paint read (or no longer hands md-reader.js the raw value), so an off-default width paints at 880 and re-lays the article out after the first render");
}
// (2) Scroll grab: tier changes settle the anchor SYNCHRONOUSLY -- the 300ms
// second phase belongs to the width path's max-width transition only.
{
  const typoSet = mdReaderJs.slice(mdReaderJs.indexOf("function _pbpTypoSet"), mdReaderJs.indexOf("function _pbpTypoSyncPop"));
  check(typoSet.includes("_pbpZenSettleAnchor(anchor)") && !typoSet.includes("_pbpZenSettleAfterLayout"),
    "md-reader.js: _pbpTypoSet uses the delayed two-phase settle (drags a user scroll back within 300ms)");
  check(mdReaderJs.includes("if (window.scrollY === 0) return null;"),
    "md-reader.js: _pbpZenCaptureAnchor lost the scrollY=0 guard (layout change at page top scrolls the reader)");
}
// (3) h4-h6 stay pinned while p/li follow the leading tier.
{
  // Voice round 2026-07 split the combined h4-h6 rule into three (distinct
  // sizes/colours); the PIN contract survives per-level: each heading rule
  // must carry its own literal line-height so none follows the leading tier.
  for (const h of ["h4", "h5", "h6"]) {
    check(new RegExp("#rendered-view " + h + " \\{[^}]*line-height: 1\\.75;").test(mdCss),
      "md-preview.css: " + h + " lost its pinned line-height (it would follow the prose leading tier)");
  }
  check((mdCss.match(/line-height: var\(--pbp-prose-leading, 1\.75\)/g) || []).length >= 3,
    "md-preview.css: the prose leading var no longer covers container+p+li");
}
// (4) Print: the consolidated open-popover hide must sit AFTER every
// ':popover-open { display: flex }' base rule (equal (1,1,0) specificity --
// source order decides, media queries add none) and must cover every popover.
{
  const lastFlex = mdCss.lastIndexOf(":popover-open { display: flex; }");
  const hideBlock = mdCss.indexOf("#explain-pop:popover-open, #pb-hl-bar:popover-open");
  check(hideBlock > lastFlex && hideBlock !== -1,
    "md-preview.css: consolidated print popover-hide block is missing or precedes a ':popover-open{display:flex}' base rule (open popovers print again)");
  const popIds = [...mdCss.matchAll(/#([a-z-]+):popover-open \{ display: flex; \}/g)].map((m) => m[1]);
  const hideRule = mdCss.slice(hideBlock, mdCss.indexOf("}", hideBlock));
  for (const id of popIds) {
    check(hideRule.includes(`#${id}:popover-open`), `md-preview.css: popover #${id} missing from the consolidated print hide (prints when open)`);
  }
}
// text-autospace must keep exempting the character grid.
check(mdCss.includes("text-autospace: normal") && /#rendered-view :is\(pre, code, kbd, samp\) \{\s*\n\s*text-autospace: no-autospace;/.test(mdCss),
  "md-preview.css: text-autospace code/pre exemption lost (autospace widens code glyph runs next to CJK)");

// ---- A4: export reuse of the preview fix cache (Codex-adjudicated). Scoped
// to the resolveEmbed function body, not the whole file. ----
{
  const embedFn = mdPreviewJs.slice(mdPreviewJs.indexOf("async function resolveEmbed"), mdPreviewJs.indexOf("// Fill header"));
  // The partition is synchronous and sits BEFORE the permission prompt --
  // chrome.permissions.request must stay the click chain's FIRST await, and a
  // full cache hit must reach zero-prompt/zero-network without ever asking.
  const partAt = embedFn.indexOf("pbpEmbedCacheEntryValid(");
  const permAt = embedFn.indexOf("chrome.permissions.request");
  check(partAt >= 0 && permAt >= 0 && partAt < permAt,
    "md-preview.js: resolveEmbed cache partition missing or moved after the permission prompt (first-await gesture invariant)");
  // The hotlink retry draws failures from the NETWORK list only: cache hits
  // and budget-dropped entries must never reach the DNR retry round.
  check(embedFn.includes("toFetch.filter((u) => !fetched.has(u))") &&
    !embedFn.includes("scan.candidates.filter((u) => !fetched.has(u))"),
    "md-preview.js: resolveEmbed retry round no longer scoped to the network list (cache/budget-dropped urls would refetch)");
}

// ---- Reduced motion ----
// scrollIntoView() only consults the `scroll-behavior` property when `behavior`
// is "auto" or omitted, so a `scroll-behavior: auto` inside a
// prefers-reduced-motion block cannot reach a call that passes "smooth".
// Whole-viewport travel is the most vestibular motion in the product, so every
// smooth scroll must route through pbpScrollIntoView, which checks the media
// query at the call site.
{
  const scrollOwners = {
    "shared.js": sharedJs, "popup.js": popupJs, "options.js": optionsJs,
    "md-preview.js": mdPreviewJs, "md-reader.js": mdReaderJs,
    "md-highlight.js": mdHighlightJs, "md-ask.js": mdAskJs,
    "md-translate.js": mdTranslateJs, "popup-tags.js": popupTagsJs,
  };
  for (const [name, src] of Object.entries(scrollOwners)) {
    // Raw `.scrollIntoView(` is allowed only when it cannot animate: either no
    // `behavior` at all (CSS default `auto`, and no stylesheet sets `smooth`)
    // or an explicit `"instant"`. shared.js owns the one guarded call.
    const raw = [...src.matchAll(/\.scrollIntoView\(\{[^}]*\}/g)]
      .map((m) => m[0])
      .filter((call) => /behavior:\s*"smooth"/.test(call));
    check(raw.length === 0,
      `${name}: smooth scrollIntoView bypasses pbpScrollIntoView, so prefers-reduced-motion cannot reach it (${raw.join(" | ")})`);
  }
  check(/function pbpScrollIntoView\([\s\S]{0,240}pbpPrefersReducedMotion\(\)[\s\S]{0,80}behavior: "instant"/.test(sharedJs),
    "shared.js: pbpScrollIntoView no longer downgrades to instant under prefers-reduced-motion");
  // A reduced-motion preference must not cost the user a status channel. The
  // blanket reset parks every infinite animation after one 0.01ms cycle, so each
  // status indicator restates its duration. The invariant asserted here is that
  // the override MIRRORS the base rule -- retiming the base rule then needs no
  // test edit, but forgetting to retime the override does fail.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lastMatch = (css, re) => { let m, last = null; while ((m = re.exec(css))) last = m[1]; return last; };
  const statusMotion = [
    ["popup.css", popupCss, ".tag-skel", "the AI tag skeleton"],
    ["popup.css", popupCss, ".offline-queue-retry.loading svg", "the offline retry spinner"],
    ["popup.css", popupCss, ".auto-close-bar", "the auto-close countdown, the only warning before the popup self-closes"],
    ["options.css", optionsCss, ".tab-btn.tab-busy::after", "the tab busy dot"],
    ["md-preview.css", mdCss, ".preview-spinner", "the page loading spinner"],
    ["md-preview.css", mdCss, ".xp-skel", "the streaming answer skeleton"],
    ["md-preview.css", mdCss, ".src-seg.loading::after", "the extraction spinner"],
  ];
  for (const [cssName, cssSrc, sel, what] of statusMotion) {
    const base = lastMatch(cssSrc, new RegExp(`${esc(sel)}\\s*\\{[^}]*animation:\\s*[\\w-]+\\s+([\\d.]+m?s)`, "g"));
    const override = lastMatch(cssSrc, new RegExp(`${esc(sel)}\\s*\\{[^}]*animation-duration:\\s*([\\d.]+m?s)\\s*!important`, "g"));
    check(base !== null, `${cssName}: cannot find the base animation for ${sel} — the status-motion contract has drifted`);
    check(override === base,
      `${cssName}: reduced motion no longer keeps ${what} running at its own rate (base ${base}, override ${override})`);
  }
  // The zen bar's positional half is vestibular; its idle fade is not. Killing
  // both turned the fade into a repeated hard brightness cut.
  const zenReduce = lastMatch(mdCss, /#zen-bar \{ transition: ([^}]*) \}/g);
  check(zenReduce !== null && /opacity/.test(zenReduce) && /!important/.test(zenReduce) && !/\bright\b/.test(zenReduce),
    `md-preview.css: the reduced-motion zen bar override no longer keeps opacity-only (${zenReduce})`);
  // The dead declaration is what made this bug invisible for so long: it read as
  // though reduced-motion scrolling were handled. It must not come back.
  for (const [name, src] of [["popup.css", popupCss], ["options.css", optionsCss], ["md-preview.css", mdCss]]) {
    const blocks = src.split("@media (prefers-reduced-motion: reduce)").slice(1);
    check(!blocks.some((b) => /scroll-behavior:/.test(b.slice(0, b.indexOf("\n}")))),
      `${name}: a reduced-motion block declares scroll-behavior again — it cannot reach scrollIntoView() and reads as false coverage`);
  }
}

// ---- Custom properties read from JS must exist in the stylesheet ----
// getPropertyValue() on a missing custom property returns "", so a `|| fallback`
// turns a deleted token into a silent downgrade rather than an error. That is
// exactly how retiring --motion-ease left the rail fold running on the weak
// built-in curve while every CSS-side check still passed.
{
  const surfaces = [
    { css: ["md-preview.css", mdCss], js: [["md-preview.js", mdPreviewJs], ["md-reader.js", mdReaderJs],
      ["md-ask.js", mdAskJs], ["md-highlight.js", mdHighlightJs], ["md-skim.js", mdSkimJs]] },
    { css: ["popup.css", popupCss], js: [["popup.js", popupJs], ["popup-ai.js", popupAiJs], ["popup-batch.js", popupBatchJs]] },
    { css: ["options.css", optionsCss], js: [["options.js", optionsJs], ["options-connectivity.js", optionsConnectivityJs]] },
  ];
  for (const { css: [cssName, cssSrc], js } of surfaces) {
    for (const [jsName, jsSrc] of js) {
      for (const m of jsSrc.matchAll(/getPropertyValue\(\s*"(--[a-z0-9-]+)"\s*\)/g)) {
        const token = m[1];
        check(new RegExp(`^\\s*${token}\\s*:`, "m").test(cssSrc),
          `${jsName} reads ${token} but ${cssName} does not define it — getPropertyValue returns "" and the fallback silently takes over`);
      }
    }
  }
}

// ---- Auto-close: cancelled by interaction, never merely paused ----
// The bar must never depict a countdown that is not running, which is what the
// old CSS-only `body:hover { animation-play-state: paused }` did while the
// setTimeout kept going. Reaching for the popup now cancels outright -- but the
// popup opens under a cursor already resting on the toolbar button, so the move
// that lands there must not count, or the feature would never fire for anyone.
{
  const block = popupJs.slice(popupJs.indexOf('bar.className = "auto-close-bar"'),
    popupJs.indexOf('if (btn.classList.contains("saved-success")) setSubmitState("idle"); }, 1200)'));
  check(!/^[^/*\n]*animation-play-state\s*:\s*paused/m.test(popupCss),
    "popup.css: the auto-close bar can be frozen again while its timer keeps running");
  check(/Math\.abs\(e\.clientX - moveOrigin\.x\) < 8 && Math\.abs\(e\.clientY - moveOrigin\.y\) < 8/.test(block),
    "popup.js: the auto-close pointer cancel lost its distance threshold, so the cursor the popup opens under cancels it immediately");
  check(block.includes('document.addEventListener("pointermove", onAutoCloseMove)') &&
    block.includes('document.addEventListener("mousedown", cancelAutoClose, { once: true })'),
    "popup.js: the auto-close is no longer cancelled by both pointer movement and a click");
  check((block.match(/removeEventListener\("pointermove", onAutoCloseMove\)/g) || []).length >= 2,
    "popup.js: the auto-close pointermove listener outlives the countdown on at least one path");
}

// ---- Tag reorder handle: visible while the tags are being edited ----
{
  check(/\.tags-display:hover \.tag-drag-handle,\s*\n\s*\.tags-input-wrap:focus-within \.tag-drag-handle \{ opacity: 0\.5; \}/.test(popupCss),
    "popup.css: the tag drag handle is hover-only again, so reordering is undiscoverable while you are typing tags");
  // Reordering is HTML5 drag-and-drop, which touch does not deliver. Revealing
  // the handle there would advertise a control that cannot be used.
  check(!/@media \(hover: none\)[\s\S]{0,200}\.tag-drag-handle/.test(popupCss) &&
    !/@media \(pointer: coarse\)[\s\S]{0,200}\.tag-drag-handle/.test(popupCss),
    "popup.css: the tag drag handle is revealed on coarse pointers, where HTML5 drag-and-drop cannot reorder anything");
}

// ---- Explain popover: the drag must not commit on a plain press ----
{
  const down = mdAskJs.slice(mdAskJs.indexOf('head.addEventListener("pointerdown"'),
    mdAskJs.indexOf('const endDrag = (e) =>'));
  const [downHandler, moveHandler] = down.split('head.addEventListener("pointermove"');
  // Pinning takes the card out of light-dismiss, so pinning on pointerdown made
  // a press that only meant to grab the card silently change how it closes.
  check(!downHandler.includes("_pbpExplainSetPinned") && !downHandler.includes('classList.add("xp-dragging")'),
    "md-ask.js: the explain popover pins (and leaves light-dismiss) on pointerdown, before the pointer has moved");
  check(moveHandler.includes("drag.moved") &&
    /Math\.abs\(e\.clientX - drag\.x\) < 4 && Math\.abs\(e\.clientY - drag\.y\) < 4/.test(moveHandler) &&
    moveHandler.includes("_pbpExplainSetPinned(pop, true)"),
    "md-ask.js: the explain popover drag lost its movement threshold, so a press commits a drag");
  // Placement must come from the SPACE available, never from a height measured
  // before _pbpExplainRun fills the body on the very next line. Measuring the
  // shell made the card crawl as the answer streamed; budgeting to the card's
  // max height instead flung short cards to the far edge.
  // The reader panel's icons are one family: Feather, 24x24, stroke 2, round caps
// and joins. The gear, pin and close were already drawn that way, so a
// hand-drawn set beside them read as a different toolkit even though the stroke
// width matched -- that is exactly how the foot actions went wrong. Pinned here
// so the next icon cannot drift, since nothing else would catch it.
{
  // Two families are allowed and nothing else. Feather 24 is the reader panel;
  // the 16-box set is deliberate and separate, because those are badges rendered
  // at 11-14px where Feather's geometry is too coarse. Skipping unknown
  // viewBoxes instead of rejecting them would let a drifting icon escape simply
  // by changing its box -- which is how the first version of this check passed a
  // deliberately broken icon.
  const FEATHER_24 = ['viewBox="0 0 24 24"', 'fill="none"', 'stroke="currentColor"',
    'stroke-width="2"', 'stroke-linecap="round"', 'stroke-linejoin="round"'];
  // The 16-box family had no pin at all, and drifted to four stroke widths
  // (1.3 / 1.4 / 1.5 / 1.6 / 1.8) across five files before this existed.
  const BOX_16 = ['viewBox="0 0 16 16"', 'fill="none"', 'stroke="currentColor"',
    'stroke-width="1.5"', 'stroke-linecap="round"', 'stroke-linejoin="round"'];
  const surfaces = {
    "md-ask.js": mdAskJs, "md-dict.js": mdDictJs, "md-translate.js": mdTranslateJs,
    "md-reader.js": mdReaderJs, "md-preview.js": mdPreviewJs, "shared.js": sharedJs,
    "pinboard-sort.js": read("pinboard-sort.js"),
  };
  const offenders = [];
  const classify = (file, name, tag) => {
    const family = tag.includes('viewBox="0 0 16 16"') ? BOX_16
      : tag.includes('viewBox="0 0 24 24"') ? FEATHER_24 : null;
    if (!family) { offenders.push(`${file}:${name} (foreign viewBox)`); return; }
    const missing = family.filter((attr) => !tag.includes(attr));
    if (missing.length) offenders.push(`${file}:${name} (${missing.join(" ")})`);
  };
  for (const [file, src] of Object.entries(surfaces)) {
    // Matches both the `const PBP_*_SVG = '<svg ...>'` constants and the icon
    // registry entries in shared.js, which are `name: '<svg ...>'`.
    for (const m of src.matchAll(/(PBP_[A-Z0-9_]*SVG|[a-zA-Z][a-zA-Z0-9]*)\s*[:=]\s*'(<svg[^>]*>)/g)) classify(file, m[1], m[2]);
  }
  // The reader's own markup carries six icons directly. They were the family
  // the JS ones are measured against, so leaving them unpinned would mean the
  // reference itself could drift.
  const mdPreviewHtml = read("md-preview.html");
  [...mdPreviewHtml.matchAll(/<svg[^>]*>/g)].forEach((m, i) => classify("md-preview.html", `svg#${i + 1}`, m[0]));
  check(offenders.length === 0,
    `inline icons left their family: ${offenders.join(", ")}`);
}

// Foot actions are icon-only. Any textContent assignment to one of them wipes
  // the SVG and leaves a blank square, which is how the vocabulary button broke
  // the first time. Names must come from title AND aria-label, never from text.
  check(!/\b(?:save|vocab|vocabBtn|openVocab|ask)\.textContent\s*=/.test(mdAskJs),
    "md-ask.js: a foot action is assigned textContent, which erases its icon");
  check(/function _pbpExplainIconBtn\(btn, svg, label\)[\s\S]{0,200}btn\.title = label;[\s\S]{0,120}aria-label", label/.test(mdAskJs),
    "md-ask.js: the foot-action helper stopped setting both the tooltip and the accessible name");
  // Either a literal inline <svg> or a guarded alias of a shared PBP_ICONS
  // member (the Lucide family) -- both are SVG; the contract's target is
  // emoji/dingbat text sneaking back in, not the sourcing of the paths.
  check(["PBP_EXPLAIN_NOTE_SVG", "PBP_EXPLAIN_VOCAB_ADD_SVG", "PBP_EXPLAIN_VOCAB_OPEN_SVG", "PBP_EXPLAIN_ASK_SVG"]
    .every((name) => new RegExp(`const ${name} = (?:'<svg|typeof PBP_ICONS !== "undefined" \\? PBP_ICONS\\.[A-Za-z]+ : "")`).test(mdAskJs)),
    "md-ask.js: a foot-action icon is no longer an SVG constant (literal or PBP_ICONS alias)");

  // The side choice now lives in a pure helper so it can be unit-tested; this
  // only pins that placement still asks it, and that the threshold is the
  // comfort one. MIN_CARD alone let a selection near the foot of the window open
  // into a 160px sliver with a screenful of unused space above it.
  check(/const openDown = pbpExplainOpensDown\(below, above\);/.test(mdAskJs) &&
    /function pbpExplainOpensDown\(below, above\)/.test(mdAskJs) &&
    /b >= PBP_EXPLAIN_COMFORT_CARD \|\| b >= a/.test(mdAskJs),
    "md-ask.js: the explain popover side choice left its tested helper or dropped the comfort threshold");
  check(/const room = openDown \? below : above;/.test(mdAskJs) &&
    /pop\.style\.maxHeight = Math\.floor\(Math\.min\(.*, room\)\) \+ "px";/.test(mdAskJs),
    "md-ask.js: the explain popover height budget can exceed the room on the side it was placed on, so it overflows and gets clawed back");
  // Opening upward has to keep the BOTTOM edge pinned to the selection, or the
  // card grows down over the very text it is explaining.
  check(/_pbpExplainAnchorBottom = rect\.top - edge;/.test(mdAskJs) &&
    /_pbpExplainAnchorBottom === null \? r\.top : _pbpExplainAnchorBottom - r\.height/.test(mdAskJs),
    "md-ask.js: an upward-opening explain popover is no longer bottom-anchored, so streamed content grows back over the selection");
  // Both are per-open state; leaking the inline budget would also make the next
  // open read it back instead of the stylesheet cap.
  check(/_pbpExplainAnchorBottom = null;\s*\n\s*pop\.style\.removeProperty\("max-height"\);/.test(mdAskJs),
    "md-ask.js: closing the explain popover leaves its anchor or its inline height budget behind for the next open");
  check(/#explain-pop \{[\s\S]{0,400}max-height: min\(480px, calc\(100vh - 32px\)\);/.test(mdCss),
    "md-preview.css: #explain-pop lost the max-height that md-ask.js reads back for placement");
  // The value must be derived from the skeleton and expressed in em, so it tracks
  // the typography tier the skeleton bars are also sized in. A round px number is
  // the tell that it was guessed again.
  check(/\.xp-body \{[\s\S]{0,700}min-height: calc\([\d.]+em \+ \d+px\);/.test(mdCss),
    "md-preview.css: .xp-body min-height is no longer derived from the skeleton in em, so the card shrinks then re-grows on the first token");
}

// ---- Connectivity tests: one run per target, and no cross-run status wipe ----
{
  {
    const fn = optionsConnectivityJs.slice(optionsConnectivityJs.indexOf("async function testAIProvider"),
      optionsConnectivityJs.indexOf('["gemini","openai"'));
    const disableAt = fn.indexOf("btn.disabled = true");
    const tryAt = fn.indexOf("try {");
    const finallyAt = fn.lastIndexOf("} finally {");
    check(disableAt > 0 && tryAt > disableAt && finallyAt > tryAt && fn.slice(finallyAt).includes("btn.disabled = false"),
      "options-connectivity.js: provider Test buttons no longer disable for the run and re-enable in a finally, so two runs can share one status element");
  }
  // Anonymous clear timers let a finished run erase the next run's real result.
  check(!/setTimeout\(\(\) => \{ statusEl\.textContent = ""/.test(optionsConnectivityJs),
    "options-connectivity.js: a status clear timer is unkeyed again — a finished run will wipe the next run's result off screen");
  check(optionsConnectivityJs.includes("const _testClearTimers = new Map();") &&
    /function scheduleStatusClear\(key, statusEl, ms\) \{\s*\n\s*cancelStatusClear\(key\);/.test(optionsConnectivityJs),
    "options-connectivity.js: the per-target status clear timers are gone");
}

// ---- Site-theme cloak: paint the themed background, never the white canvas ----
{
  const styleJs = read("pinboard-style.js");
  // The cloak must hide the BODY and paint the root, not just zero the root's
  // opacity: opacity on the root is not a reliable way to keep the propagated
  // canvas background painted, and the canvas is exactly what shows for the
  // up-to-400ms the theme takes to load.
  check(/html \{ background: \$\{_pbpCloakBg\} !important; \} html > \* \{ opacity: 0 !important; \}/.test(styleJs),
    "pinboard-style.js: cloak no longer paints the cached background under every rendered child, so themed loads flash the browser's white canvas");
  check(styleJs.includes('_pbpCloak.textContent = _pbpCloakBg'),
    "pinboard-style.js: cloak stopped branching on a cached background");
  // The cached value comes out of pinboard.in's own localStorage and goes into
  // a <style> element. It must be validated on the way in, every time.
  const reSrc = styleJs.match(/const PBP_CLOAK_BG_RE = (\/.*\/);/);
  check(!!reSrc, "pinboard-style.js: PBP_CLOAK_BG_RE is gone — the cached colour would reach <style> unvalidated");
  if (reSrc) {
    check(/PBP_CLOAK_BG_RE\.test\(cached\)/.test(styleJs) && /PBP_CLOAK_BG_RE\.test\(bg\)/.test(styleJs),
      "pinboard-style.js: the cloak colour is validated on only one of the read/write paths");
    const re = runInNewContext(reSrc[1]);
    for (const good of ["rgb(28, 27, 26)", "rgba(28, 27, 26, 0.5)", "rgb(255,255,255)", "rgba(0, 0, 0, 1)"]) {
      check(re.test(good), `pinboard-style.js: PBP_CLOAK_BG_RE rejects a legitimate computed colour ${good}`);
    }
    for (const bad of [
      "red",
      "rgb(28, 27, 26); } body { display: none",
      "url(javascript:alert(1))",
      "var(--x)",
      "rgb(28, 27, 26) !important",
      "expression(alert(1))",
      "",
    ]) {
      check(!re.test(bad), `pinboard-style.js: PBP_CLOAK_BG_RE accepts "${bad}" — that string would be injected into a <style> element`);
    }
  }
  // Sampling the background at document_start would read the UA default,
  // because the page's own stylesheet has not been applied yet.
  check(/if \(document\.readyState === "complete"\) cacheCloakBg\(\);\s*\n\s*else window\.addEventListener\("load", cacheCloakBg, \{ once: true \}\);/.test(styleJs),
    "pinboard-style.js: the cloak colour is sampled before load, so it would cache the UA default instead of the theme");
  check(/if \(!_pbpThemed\) \{\s*\n\s*localStorage\.removeItem\(pbpCloakBgKey\(true\)\);\s*\n\s*localStorage\.removeItem\(pbpCloakBgKey\(false\)\);/.test(styleJs),
    "pinboard-style.js: removing the theme leaves a stale cloak colour cached");
  // One key per resolved mode: the OS can flip light/dark between navigations
  // with no user action, and a single key would then paint the light background
  // over a dark render -- the very flash this is here to stop.
  check(/const pbpCloakBgKey = \(isDark\) => \(isDark \? "pbp_cloak_bg_d" : "pbp_cloak_bg_l"\);/.test(styleJs) &&
    /localStorage\.setItem\(pbpCloakBgKey\(isDark\), bg\)/.test(styleJs) &&
    /for \(const key of \[pbpCloakBgKey\(osDark\), pbpCloakBgKey\(!osDark\)\]\)/.test(styleJs),
    "pinboard-style.js: the cloak colour is no longer cached per light/dark mode, so an OS theme flip repaints the wrong shade");
}

// ---- hardcoded-color gate: popup.css / options.css / library.css. The
// var()-first color migration (design-uplift tasks 5/12/13) finished for
// popup.css and options.css -- both now sit at zero bare hex AND zero
// qualifying rgba() in the hand-maintained region, so this is a permanent
// RED (zero-tolerance) assertion for those two, not a movable ratchet: the
// tests/hex-ratchet-baseline.json ceiling file this gate used to read is
// gone (deleted design-uplift Task 13 step 4), and any future bare hex/rgba
// literal here is a straight regression, no baseline bump possible.
// library.css's hex is fully migrated too (own zero-tolerance assertion
// below). Its rgba() stays a live ratchet -- library.css:497's
// `background: rgba(220, 80, 80, 0.08)` has a comment admitting there is no
// token for it yet -- LIBRARY_RGBA_CEILING is the debt this last ratchet
// exists to track; lower it (never raise it) as that debt gets paid down.
{
  const LIBRARY_RGBA_CEILING = 1;
  for (const [file, css] of [["popup.css", popupCss], ["options.css", optionsCss]]) {
    check(countBareHex(css) === 0,
      `${file}: bare hex colors leaked outside var() fallbacks in the hand-maintained region (must stay at zero)`);
    check(countQualifyingRgba(css) === 0,
      `${file}: bare rgba() colors leaked outside var() fallbacks in the hand-maintained region (must stay at zero) -- migrate the new literal(s) to a var(--…) token instead of hardcoding a color`);
  }
  check(countBareHex(libraryCss) === 0,
    "library.css: bare hex colors leaked outside var() fallbacks in the hand-maintained region (must stay at zero)");
  const libRgba = countQualifyingRgba(libraryCss);
  check(libRgba <= LIBRARY_RGBA_CEILING,
    `library.css: bare rgba() colors in the hand-maintained region grew from the ceiling of ${LIBRARY_RGBA_CEILING} to ${libRgba} -- migrate the new literal(s) to a var(--…) token instead of hardcoding a color`);
  if (libRgba < LIBRARY_RGBA_CEILING) {
    console.log(`rgba-ratchet: library.css improved to ${libRgba} bare rgba (ceiling ${LIBRARY_RGBA_CEILING}) -- lower LIBRARY_RGBA_CEILING in tests/ui-contract-tests.mjs in this commit`);
  }
}

// ---- chip-bg must never be a literal "transparent" (vocab-group-inspect-
// report.md 2026-08-05 Finding 2): options-chrome.mjs / library-chrome.mjs
// used to copy their pilot's `tag-bg` role into `--{ns}-chip-bg` verbatim,
// and 9 of 13 pilots declare tag-bg as the literal CSS keyword
// "transparent" -- shipping `--lib-chip-bg: transparent;` straight into the
// generated region, which made .vocab-group-chip (and options'
// .tag-gov-chip-face, same derivation) render with NO pill background at
// all in those themes (dracula caught live: floating text, no pill).
// contrast-audit.mjs's chip-fg-vs-chip-bg pair can't catch a regression back
// to this shape -- it treats a non-hex chip-bg as "composite onto panel"
// and still finds AA against that reconstructed value, the same silent
// pass-through that let the original bug ship unnoticed. This is therefore
// a DIRECT text scan of the generated region, not a derived contrast check:
// grep the actual `--{ns}-chip-bg:` declarations verbatim and fail if any of
// them is the bare word "transparent" (the render oracle's textContrast also
// can't catch this shape -- it composites through an ancestor when the
// probed element's own background resolves transparent, so a chip that
// silently borrowed its panel's contrast would keep passing that check too).
{
  const chipBgLiteralTransparent = (css, ns) => {
    const re = new RegExp(`--${ns}-chip-bg:\\s*([^;]+);`, "g");
    const offenders = [];
    for (const m of css.matchAll(re)) if (m[1].trim() === "transparent") offenders.push(m[0].trim());
    return offenders;
  };
  // popup.css joined this scan (Task 4, taste-uplift-batch3, D9): popup-
  // chrome.mjs's chipMode switched from "verbatim" (chip-bg = raw tag-bg,
  // literal "transparent" on 8/15 blocks) to "tinted" -- the same
  // resolveChipBg -> fillSeparate -> fillDistinct path options/library
  // already used, so .stag now gets the same never-invisible guarantee.
  for (const [file, css, ns] of [["options.css", optionsCss, "opt"], ["library.css", libraryCss, "lib"], ["popup.css", popupCss, "pp"]]) {
    const offenders = chipBgLiteralTransparent(css, ns);
    check(offenders.length === 0,
      `${file}: --${ns}-chip-bg is the literal "transparent" for ${offenders.length} theme(s) -- .vocab-group-chip/.tag-gov-kind-badge would render with no pill background at all (${offenders.join(", ")})`);
  }
}

// ---- single-default-per-token gate (all three *-chrome surfaces,
// design-uplift Task 12 review round 3 + Task 13 review): a var(--{ns}-X,
// <literal>) fallback is only ever safe as a stand-in for a missing :root
// default IF every call site agrees on what that literal should be.
// options.css round 1/2 both shipped this exact bug -- --opt-save/
// --opt-warn/--opt-danger-bg each had 2-3 DIFFERENT fallback texts for the
// same token, each individually looking reasonable, silently drifted apart
// across call sites written at different times -- and the hex/rgba ratchet
// above cannot see it (the literal is inside a var() call, stripVarCalls
// already removes it from that scan by design). Generalized from
// options.css-only to all three namespaces (Task 13 review) turned up the
// identical bug class in library.css -- --lib-save/--lib-danger/--lib-bg/
// --lib-fg/--lib-fg-muted/--lib-btn-hover each had 2-3 drifted literals,
// none of which even matched library.css's own live :root default (fixed
// by stripping the dead fallback text since the token is never actually
// missing -- --lib-btn-hover's two remaining nested var() fallbacks,
// var(--lib-btn-bg)/var(--lib-code-bg), are the legitimate different shape
// this function already excludes). This walks the hand-maintained region
// for var(--{ns}-X, ...) pairs (skipping a fallback that is itself another
// var() call -- that's the legitimate nested-fallback shape, e.g.
// --opt-fg-hint, var(--opt-fg-muted))) and fails if any --{ns}-X shows up
// with more than one distinct fallback literal.
function findInconsistentVarFallbacks(css) {
  const hand = stripGeneratedRegions(css).replace(/\/\*[\s\S]*?\*\//g, "");
  const byToken = new Map();
  const re = /var\(\s*(--(?:opt|pp|lib)-[a-zA-Z0-9-]+)\s*,\s*([^()]+(?:\([^()]*\)[^()]*)*?)\)/g;
  let m;
  while ((m = re.exec(hand)) !== null) {
    const token = m[1];
    const fallback = m[2].trim();
    if (fallback.startsWith("var(")) continue; // nested var() fallback -- a different, legitimate shape
    if (!byToken.has(token)) byToken.set(token, new Set());
    byToken.get(token).add(fallback);
  }
  const offenders = [];
  for (const [token, fallbacks] of byToken) {
    if (fallbacks.size > 1) offenders.push(`${token}: ${[...fallbacks].join(" vs ")}`);
  }

  // ---- undefined-token gate (design-uplift final-fix I1): a var(--X,
  // fallback) consumer is only a safe stand-in for a token that might be
  // genuinely absent on some theme. If --X has NO definition anywhere in
  // this file -- hand-maintained :root blocks OR a @generated:ui-themes/
  // -components region (composer-derived tokens are real defaults, not
  // dead) -- the fallback isn't a safety net, it's the ONLY value that will
  // EVER render, on every theme, forever. That's exactly how options.css's
  // --opt-text-muted (a typo of --opt-fg-muted, never defined anywhere)
  // shipped a hardcoded #888 invisibly on all 14 themes + default. Scans at
  // ANY nesting depth, not just the direct/outer var() the loop above walks
  // (which deliberately skips nested fallbacks as "a different, legitimate
  // shape") -- a fallback token buried inside another fallback, e.g.
  // var(--pp-input-bg, var(--pp-bg-soft, #2a2a2a)), is exactly as
  // undefined-and-silent if --pp-bg-soft was never given a real value; the
  // outer token (--pp-input-bg) being defined doesn't excuse the inner one.
  const consumed = new Set();
  const fbTokenRe = /var\(\s*(--(?:opt|pp|lib)-[a-zA-Z0-9-]+)\s*,/g;
  let fm;
  while ((fm = fbTokenRe.exec(hand)) !== null) consumed.add(fm[1]);
  const defined = new Set();
  const defRe = /(--(?:opt|pp|lib)-[a-zA-Z0-9-]+)\s*:/g;
  let dm;
  // Full file (generated regions included), comments stripped -- a
  // composer-emitted :root declaration counts as a real definition; a
  // token name only ever appearing inside a doc comment must not.
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  while ((dm = defRe.exec(cssNoComments)) !== null) defined.add(dm[1]);
  for (const token of consumed) {
    if (!defined.has(token)) offenders.push(`${token}: consumed with a var(..., fallback) but never defined anywhere in this file (hand-maintained or generated) -- the fallback is the only value that will ever render`);
  }
  return offenders;
}
for (const [file, css] of [["popup.css", popupCss], ["options.css", optionsCss], ["library.css", libraryCss]]) {
  const offenders = findInconsistentVarFallbacks(css);
  check(offenders.length === 0,
    `${file}: var(--X, literal) fallback text disagrees across call sites for the same token -- pick one value (add/fix the :root default and consume bare, or align every fallback) -- ${offenders.join("; ")}`);
}

// COMPONENTS.md §4.2 solid-danger tier, file-wide: the confirm popover's
// confirm button is the ONE place a full-strength --{ns}-danger fill is
// allowed, and on all three surfaces its paint is owned by the
// @generated:ui-components recipe. A hand-written rule that paints
// .confirm-yes wins the moment it carries a theme prefix -- `html.dark
// .confirm-popover .confirm-yes` and `html[data-theme] .confirm-popover
// .confirm-yes` are both (0,2,1) against the recipe's (0,2,0) -- and the
// failure is SILENT: the recipe still emits, css-region-audit still passes,
// contrast-audit still greenlights on-danger x danger, and the presets
// quietly render a different palette family. popup shipped exactly that for
// 13 presets (`background: var(--pp-warn-fg); color: var(--pp-warn-bg)` --
// a warn-on-warn confirm button whose contrast measured 4.5-5.2:1 on every
// theme, so no contrast gate could ever have noticed).
//
// Class-level rather than a list of the selectors that once did it: the
// simplest counter-example to a blacklist is the next hand-written override
// nobody has written yet.
//
// The first version of this gate asked "does the selector TEXT contain
// .confirm-yes", and independent review found the counter-example it missed
// in one try: `html[data-theme] .confirm-popover button { background: … }`
// is (0,2,1), out-ranks the recipe's (0,2,0), repaints the confirm button in
// any colour you like -- and never spells `.confirm-yes`. Not a paper
// example either: this file already carries `html[data-theme]
// .confirm-popover button:focus-visible` rules written exactly that way, so
// the element-selector shape is the natural one for the next hand override.
//
// So the question the gate asks is now "COULD this rule paint the confirm
// button", answered from the selector's last compound (the part that decides
// what the rule actually targets):
//   - names .confirm-yes                       -> yes
//   - is a bare `button` under .confirm-popover -> yes (matches both buttons)
//   - is a bare `*` under .confirm-popover      -> yes (same reason)
//   - names .confirm-no / .confirm-msg, and does
//     NOT negate it with :not()                 -> no, those two are
//                                                   hand-written by design on
//                                                   all three surfaces
//   - is .confirm-popover itself                -> no, the container's own
//                                                   colour is legitimate and
//                                                   loses to the button rule
//
// The `:not()` carve-out in that fourth line is the second bypass review
// found: `.confirm-popover button:not(.confirm-no)` MENTIONS .confirm-no and
// so collected the exemption, while meaning the exact opposite -- "the button
// in this popover that is not Cancel" is the confirm button, spelled the way
// a person naturally writes a themed override, at (0,3,1). A tail that
// negates the class is not a tail that targets it.
//
// KNOWN AND DELIBERATELY OUT OF SCOPE (review-ruled): a tail written as
// `[class~="confirm-yes"]` evades the class-name test, and `.confirm-popover
// > *` evades the button/`*` test by targeting children generically. The
// first is a spelling nobody reaches for by accident; the second repaints
// .confirm-msg along with the buttons and is obvious on sight. This gate
// aims at the shapes a person writes while meaning well, not at someone
// working around it.
// `border` shorthand counts only when it carries a colour: every surface
// ships `.confirm-popover button { border: 1px solid }` deliberately
// colourless (it resolves to currentColor), and flagging that would make the
// gate unusable on the very code it is meant to protect. :hover's inset
// `box-shadow` ring stays allowed -- that is how §4.2 specifies the state.
const SOLID_DANGER_PAINT = /(?:^|;)\s*(background|background-color|color|border-color)\s*:/;
const SOLID_DANGER_BORDER_COLOUR = /(?:^|;)\s*border\s*:[^;]*(var\(|#[0-9a-fA-F]{3}|rgba?\(|color-mix\()/;
// Last compound = everything after the final descendant/child/sibling combinator.
const lastCompound = (sel) => sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() || "";
function paintsConfirmYes(selector) {
  if (!selector.includes(".confirm-popover") && !selector.includes(".confirm-yes")) return false;
  const tail = lastCompound(selector);
  if (!/:not\(/.test(tail) && /\.confirm-(no|msg)\b/.test(tail)) return false;
  return /\.confirm-yes\b/.test(tail) || /(^|[^-\w.])button\b/.test(tail) || /(^|[^-\w.])\*/.test(tail);
}
for (const [file, css] of [["popup.css", popupCss], ["options.css", optionsCss], ["library.css", libraryCss]]) {
  const hand = stripGeneratedRegions(css).replace(/\/\*[\s\S]*?\*\//g, "");
  const offenders = [];
  for (const m of hand.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    // A selector list is only as safe as its worst branch.
    if (!selector.split(",").some(paintsConfirmYes)) continue;
    const body = ";" + m[2];
    if (SOLID_DANGER_PAINT.test(body) || SOLID_DANGER_BORDER_COLOUR.test(body)) offenders.push(selector);
  }
  check(offenders.length === 0,
    `${file}: hand-written rule(s) can paint the confirm popover's confirm button -- the solid-danger tier belongs to the @generated:ui-components recipe (COMPONENTS.md §4.2); an element-selector or themed override outranks it silently. Offenders: ${offenders.join(" | ")}`);
}

// A1/A2 table-scroll CSS contract (final-review fix batch, 2026-08-20): pin
// the two literal declarations that make wide tables behave -- overflow-wrap
// on th/td (A1: lowers min-content contribution so a long unbreakable token
// can't drag the whole table into horizontal scroll) and the scroll-driven
// edge-fade timeline on .pb-table-wrap (A2) -- so a refactor can't silently
// drop either without this test noticing.
check(/#rendered-view th, #rendered-view td \{ overflow-wrap: anywhere; \}/.test(mdCss),
  "md-preview.css: th/td lost overflow-wrap: anywhere (A1 -- a long unbroken table cell token drags the table into horizontal scroll again)");
check(mdCss.includes("animation-timeline: scroll(self inline);"),
  "md-preview.css: .pb-table-wrap lost animation-timeline: scroll(self inline) (A2 -- the edge-fade scroll affordance stops tracking horizontal scroll)");

// ---- md-preview article-render pipeline invariants (in-place-replace
// campaign, T2). The first-render pipeline was extracted into re-callable
// functions (renderArticleContent / rebuildToc / setupScrollSpy's dispose /
// refreshReadingStats / syncRawView) so a later task can swap the article in
// place instead of reloading the page. Several of the properties that makes
// SAFE are structural and have no other gate in this repo: nothing under
// tests/ or scripts/ covers md-preview.js, and the render oracle has zero
// md-preview references, so a JS-only commit here passes through no automated
// check at all. Behavioural coverage of an actual SECOND render is Task 8's
// job -- the four closure-scoped functions are unreachable until a caller
// exists -- but the shape they depend on can be pinned now.
//
// Character scanner, not a line/regex filter. A naive version of this is
// wrong on JS source in (at least) two specific ways that both showed up on
// the first run against md-preview.js: `o + "/*"` (the permission-origin
// suffix, three sites -- background.js:3020's `frameOrigin + "/*"` is
// another live instance) reads as the start of a block comment and swallows
// the rest of the file, and `/^https?:\/\//i` (engine/URL guards) contains a
// literal `//` that reads as a line comment and truncates its line. So
// quotes, template literals and regex literals are all tracked, and newlines
// are always emitted so slice anchors that pin indentation still match.
// Module-scoped (not block-local): every check below that needs a
// comment-stripped copy of a JS file -- the md-preview.js invariants block
// right after this, and the K25 pbp-hl: writer-set gate far below -- shares
// this one scanner instead of each rolling its own weaker stripper (a
// regex-based `/\*[\s\S]*?\*\//` stripper doesn't track string boundaries at
// all, so it can't tell `frameOrigin + "/*"` from a real block-comment
// opener either).
const REGEX_CAN_FOLLOW = "(,=:[!&|?{};+-*%~^";
function stripJsComments(input) {
  let out = "";
  let i = 0;
  const prevSignificant = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      if (out[k] !== " " && out[k] !== "\t" && out[k] !== "\n") return out[k];
    }
    return "";
  };
  while (i < input.length) {
    const c = input[i], d = input[i + 1];
    if (c === "/" && d === "/") {                       // line comment
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {                       // block comment
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        if (input[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {           // string / template
      out += c; i++;
      while (i < input.length) {
        if (input[i] === "\\") { out += input.slice(i, i + 2); i += 2; continue; }
        out += input[i];
        const done = input[i] === c;
        i++;
        if (done) break;
      }
      continue;
    }
    const prev = prevSignificant();
    if (c === "/" && (prev === "" || REGEX_CAN_FOLLOW.includes(prev))) { // regex literal
      out += c; i++;
      let inClass = false;
      while (i < input.length) {
        if (input[i] === "\\") { out += input.slice(i, i + 2); i += 2; continue; }
        if (input[i] === "[") inClass = true;
        else if (input[i] === "]") inClass = false;
        out += input[i];
        const done = input[i] === "/" && !inClass;
        i++;
        if (done) break;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Everything below runs on a COMMENT-STRIPPED copy of the source. This repo's
// own rule is that a "has this been handled" judgement must not be satisfiable
// by prose, and md-preview.js's comments name every symbol these checks look
// for -- an unstripped scan would go green on a deleted guard sitting next to
// a comment that still describes it.
{
  const src = stripJsComments(mdPreviewJs);
  // Self-test the stripper before trusting it. A stripper that returned its
  // input would make every check below satisfiable by prose again; one that
  // over-stripped would make them all vacuously fail somewhere confusing. Both
  // hazards named above are pinned here as regression cases, along with
  // landmarks from the start, middle and end of the file so a runaway state
  // machine that ate a whole region cannot go unnoticed.
  check(!src.includes("Lazy-load images / async decode") &&
    !src.includes("leave $...$ source visible on failure") &&
    src.includes("renderMarkdown(markdown)") &&
    src.includes("function detectArticleLang(text)") &&
    src.includes("function cssEscape(s)") &&
    src.includes('o + "/*"') &&
    src.includes("i.test(srcUrlForSwitch)"),
    "ui-contract: the md-preview.js comment stripper is broken -- it must remove line AND block comments while preserving string literals like `o + \"/*\"` and regex literals like /^https?:\\/\\//i; until it is correct, every invariant in this block is unverified");

  const slice = (startNeedle, endNeedle, label) => {
    const a = src.indexOf(startNeedle);
    const b = a >= 0 ? src.indexOf(endNeedle, a + startNeedle.length) : -1;
    check(a >= 0 && b > a,
      `ui-contract: cannot slice ${label} out of md-preview.js (anchor moved) -- every invariant in this block is UNVERIFIED until the anchor is fixed`);
    return a >= 0 && b > a ? src.slice(a, b) : "";
  };
  const render = slice("function renderArticleContent(markdown) {", "\n  renderArticleContent(canonicalMarkdown);", "renderArticleContent");
  const toc = slice("function rebuildToc() {", "\n  rebuildToc();", "rebuildToc");
  const spy = slice("function setupScrollSpy(renderedView, tocList) {", "function cssEscape(s) {", "setupScrollSpy");
  const imgReset = slice("function imgFixResetForNewArticle() {", "async function imgFixAutoCheck", "imgFixResetForNewArticle");
  const rawSync = slice("function syncRawView() {", "function pbpScrollMapBlocks()", "syncRawView");
  check(render.includes("renderMarkdown(") && toc.includes("tocList.replaceChildren()") &&
    spy.includes("IntersectionObserver") && imgReset.includes("imgFixFailed") && rawSync.includes("getMarkdown()"),
    "ui-contract: an md-preview.js slice came back without its landmark -- the anchors are matching the wrong region");

  // --- Revision fence: captured at SCHEDULING time, re-checked in every
  // deferred continuation. A fence read inside the callback instead would
  // always see the current value and never fire, so the capture must precede
  // the first deferral; and any continuation that skips the re-check is a hole
  // through which a stale enhancer paints into the next article.
  check((render.match(/const rev = _articleRevision;/g) || []).length === 1,
    "md-preview.js: renderArticleContent must capture the article revision exactly once, as `const rev = _articleRevision;`");
  const capAt = render.indexOf("const rev = _articleRevision;");
  const deferOffsets = [...render.matchAll(/requestAnimationFrame\(|\.then\(/g)].map((m) => m.index);
  check(capAt >= 0 && deferOffsets.length > 0 && capAt < deferOffsets[0],
    "md-preview.js: renderArticleContent captures the revision AFTER its first deferred continuation -- a fence captured that late cannot fence anything");
  check(deferOffsets.length >= 5,
    `md-preview.js: renderArticleContent has ${deferOffsets.length} deferred continuations, expected at least 5 (hljs rAF + its .then, mermaid rAF, KaTeX rAF + its .then) -- the enhancer set changed, so re-check by hand that every new continuation carries the revision fence, then update this count`);
  const unfenced = deferOffsets.filter((i) => !render.slice(i, i + 160).includes("_articleRevision"));
  check(unfenced.length === 0,
    `md-preview.js: ${unfenced.length} deferred continuation(s) in renderArticleContent do not re-check _articleRevision -- a late hljs/mermaid/KaTeX callback can paint into a newer article`);

  // --- lang/dir must be cleared before re-detection, or an RTL article
  // followed by an LTR one keeps dir="rtl" forever (the branches only ever SET).
  const detectAt = render.indexOf("detectArticleLang(");
  const langRmAt = render.indexOf('removeAttribute("lang")');
  const dirRmAt = render.indexOf('removeAttribute("dir")');
  check(langRmAt >= 0 && dirRmAt >= 0 && detectAt > langRmAt && detectAt > dirRmAt,
    "md-preview.js: renderArticleContent must removeAttribute lang AND dir before detectArticleLang -- otherwise language/direction detection is not idempotent across renders");

  // --- Per-article image-fix accounting is dropped with the DOM it describes,
  // and only the per-article half: the page-level ceilings must survive or each
  // replacement punches a fresh hole through the page's network budget.
  const resetAt = render.indexOf("imgFixResetForNewArticle()");
  const injectAt = render.indexOf("renderedView.innerHTML =");
  check(resetAt >= 0 && injectAt > resetAt,
    "md-preview.js: renderArticleContent must reset the per-article image-fix state before swapping #rendered-view's children (else the sr-only note sums counts across two articles and old broken URLs leak into the new article's exports)");
  for (const stmt of ["imgFixFailed.clear()", "imgFixTried.clear()", "imgFixObserved.clear()", "imgFixFixed = 0", "imgFixStranded = 0", "clearTimeout(imgFixTimer)"]) {
    check(imgReset.includes(stmt), `md-preview.js: imgFixResetForNewArticle no longer does \`${stmt}\` -- that state survives an article swap and describes the previous document`);
  }
  check(!/imgFixBudget|imgFixOriginsSeen|imgFixCache\.clear|imgFixRunning\s*=|imgFixRerun\s*=/.test(imgReset),
    "md-preview.js: imgFixResetForNewArticle clears page-lifetime state (byte budget / origins seen / data-URI cache) or live run state -- those must survive a replacement, or every swap refunds the page's network ceiling");

  // --- TOC: one delegated listener bound once on the container, never
  // per-rebuild; and the rebuild clears before it appends.
  check((src.match(/tocList\.addEventListener\(/g) || []).length === 1,
    "md-preview.js: #toc-list must carry exactly one click listener (delegated) -- a second binding makes every TOC jump fire twice");
  check(!/addEventListener\(/.test(toc),
    "md-preview.js: rebuildToc() binds an event listener -- listeners must live outside the rebuild or each rebuild stacks another handler on the same container");
  const bindAt = src.indexOf('tocList.addEventListener("click"');
  const rebuildAt = src.indexOf("function rebuildToc() {");
  check(bindAt >= 0 && rebuildAt > bindAt,
    "md-preview.js: the delegated TOC click listener must be bound before/outside rebuildToc()");
  const clearAt = toc.indexOf("tocList.replaceChildren()");
  const appendAt = toc.indexOf("tocList.appendChild(");
  check(clearAt >= 0 && appendAt > clearAt,
    "md-preview.js: rebuildToc() appends without calling tocList.replaceChildren() first -- a second build would append to the first one's items");
  check(toc.includes("tocNav.hidden = true"),
    "md-preview.js: rebuildToc() no longer re-hides #toc on the no-headings path -- replacing an article with a headingless one would leave an empty TOC on screen");

  // --- Scroll spy hands back a dispose that unhooks ALL THREE things it
  // installs, and the rebuild runs it before the links it holds leave the DOM.
  // Brace-depth scoped: setupScrollSpy's nested helpers (runFallback, the
  // observer callback, onSpyScroll) legitimately use bare `return;`, so a
  // whole-body /\breturn;/ scan would flag them. Only the function's OWN exits
  // -- depth 1 -- have to hand back a dispose.
  const topLevelReturns = [];
  {
    let depth = 0;
    for (let i = 0; i < spy.length; i++) {
      const ch = spy[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (depth === 1 && spy.startsWith("return", i) &&
        !/[\w$]/.test(spy[i - 1] || " ") && !/[\w$]/.test(spy[i + 6] || " ")) {
        topLevelReturns.push(spy.slice(i, i + 24));
      }
    }
  }
  check(topLevelReturns.length === 3,
    `md-preview.js: setupScrollSpy has ${topLevelReturns.length} top-level returns, expected 3 (two early no-ops + the dispose) -- a new exit path must also hand back a callable`);
  check(topLevelReturns.every((r) => !/^return\s*;/.test(r)),
    "md-preview.js: setupScrollSpy has a bare `return;` at its top level -- every exit must hand back a callable dispose so callers can store and invoke it unconditionally");
  check((spy.match(/return noop;/g) || []).length === 2,
    "md-preview.js: setupScrollSpy's two early-exit paths must both return the no-op dispose");
  const disposeAt = spy.indexOf("return () => {");
  const dispose = disposeAt >= 0 ? spy.slice(disposeAt) : "";
  check(dispose.includes("observer.disconnect()") &&
    dispose.includes('removeEventListener("scroll", onSpyScroll)') &&
    dispose.includes("cancelAnimationFrame(spyRaf)"),
    "md-preview.js: setupScrollSpy's dispose must disconnect the observer, remove the named scroll listener, AND cancel a pending rAF -- a surviving frame runs runFallback() against the old headings after teardown");
  check((src.match(/_scrollSpyDispose = setupScrollSpy\(/g) || []).length === 1,
    "md-preview.js: the scroll-spy dispose must be stored in the module-level holder at its single install site");
  const disposeCallAt = toc.indexOf("_scrollSpyDispose()");
  check(disposeCallAt >= 0 && clearAt > disposeCallAt,
    "md-preview.js: rebuildToc() must dispose the old scroll spy BEFORE clearing the list -- otherwise the observer briefly holds links already detached from the document");

  // --- Raw view: filled lazily, but once filled it is kept in sync, and the
  // sync must not silently scroll the reader to the top (the campaign's whole
  // premise is that nothing about the page resets).
  check(rawSync.includes("_rawFilled") && rawSync.includes("rawView.textContent = getMarkdown()"),
    "md-preview.js: syncRawView must be gated on _rawFilled and write the current canonical markdown");
  // Ordering, not mere presence: the position has to be READ before the write
  // and RESTORED after it. A presence-only scan went green when the restore was
  // deleted, because the capture line still mentioned rawView.scrollTop.
  const rawWriteAt = rawSync.indexOf("rawView.textContent = getMarkdown()");
  const rawTopRestoreAt = rawSync.indexOf("rawView.scrollTop = ");
  const rawWinRestoreAt = rawSync.indexOf("window.scrollTo(");
  check(rawWriteAt >= 0 && rawTopRestoreAt > rawWriteAt && rawWinRestoreAt > rawWriteAt,
    "md-preview.js: syncRawView must restore reading position (rawView.scrollTop AND the window offset) AFTER rewriting the <pre> -- writing textContent rebuilds the box and dumps the reader at the top, which is the same felt regression as the reload this campaign removes");

  // ---- The commit transaction itself (in-place-replace campaign, T3).
  // pbpVideoCommitTranscript used to write the payload and reload the page;
  // it now writes the payload and swaps the article in place. The properties
  // that make that safe are ordering properties, and ordering is exactly what
  // no other gate in this repo checks.
  const commitFn = slice("window.pbpVideoCommitTranscript = async (", "\n  };", "pbpVideoCommitTranscript");
  const applier = slice("_applyArticleCommit = (markdown, meta) => {", "\n  };", "the in-place commit applier");
  // Slice self-check FIRST. Both anchors end on the same generic `\n  };`, so
  // an over-run would quietly hand the checks below a region containing the
  // other function (and every "must not contain" assertion would still pass).
  check(commitFn.includes("chrome.storage.local.set") && commitFn.includes("return true;") &&
    !commitFn.includes("_applyArticleCommit = ") && !commitFn.includes("renderArticleContent(") &&
    applier.includes("renderArticleContent(") && applier.includes("rebuildToc()") &&
    !applier.includes("chrome.storage.local.set"),
    "ui-contract: the T3 slices came back wrong (committer / applier anchors moved or over-ran) -- every T3 invariant below is UNVERIFIED");

  // --- No reload. This is the campaign's entire premise: a reload restarts
  // the player, drops the scroll position, and throws away the Ask/translate
  // session. The two page shells that genuinely cannot replace in place
  // install their own reload applier instead (asserted below), which is why
  // the file still contains the call at all.
  check(!/location\.reload\(/.test(commitFn),
    "md-preview.js: pbpVideoCommitTranscript reloads the page -- removing exactly that is the point of the in-place replacement campaign; a shell that cannot replace in place must install a reload applier instead");
  check(!/location\.reload\(/.test(applier),
    "md-preview.js: the in-place commit applier reloads the page -- it exists precisely to avoid that");
  check((src.match(/_applyArticleCommit = \(\) => \{ location\.reload\(\); \};/g) || []).length === 2,
    "md-preview.js: expected exactly 2 reload appliers (the pending/error shell and the empty-content guard, both of which return before the article runtime is built) -- if a shell lost its applier, a transcript committed there is written to storage and never shown; if a third appeared, an in-place-capable page is reloading for nothing");

  // --- pbp:rendered means "the FIRST render finished" and drives one-shot
  // init across the whole md-ai layer. Re-dispatching it on a replacement
  // would re-run every one of those inits; the two lifecycle events exist so
  // it does not have to be.
  check((src.match(/CustomEvent\("pbp:rendered"/g) || []).length === 1,
    "md-preview.js: pbp:rendered is dispatched more than once -- the in-place replacement path must announce itself with pbp:article-will-replace / pbp:article-replaced, never by re-firing the first-render event");
  check(!commitFn.includes("pbp:rendered") && !applier.includes("pbp:rendered"),
    "md-preview.js: the commit path dispatches pbp:rendered -- that event is the first render's, and re-firing it re-runs every one-shot md-ai init");

  // --- Transaction order in the committer: validate, THEN persist, THEN
  // swap. Validation via its own renderMarkdown() call is what makes a bad
  // transcript leave storage and the DOM untouched (renderArticleContent
  // renders and commits in one breath, so it cannot be the validator).
  const probeAt = commitFn.indexOf("renderMarkdown(");
  const setAt = commitFn.indexOf("chrome.storage.local.set");
  const applyAt = commitFn.indexOf("_applyArticleCommit(");
  check(probeAt >= 0 && setAt > probeAt && applyAt > setAt,
    "md-preview.js: pbpVideoCommitTranscript must pre-render (renderMarkdown) BEFORE the storage write and swap the article only AFTER it -- any other order can leave storage, memory and the DOM disagreeing");
  // Serial lock, released in a finally so a throw cannot wedge the page.
  const lockSetAt = commitFn.indexOf("_commitInFlight = true;");
  const finallyAt = commitFn.indexOf("} finally {");
  const lockClearAt = commitFn.indexOf("_commitInFlight = false;");
  check(commitFn.indexOf("if (_commitInFlight)") >= 0 && lockSetAt > commitFn.indexOf("if (_commitInFlight)") &&
    finallyAt > lockSetAt && lockClearAt > finallyAt,
    "md-preview.js: pbpVideoCommitTranscript must refuse a re-entrant commit and release its lock in a finally -- a lock leaked on a throw refuses every later commit for the life of the page");

  // --- Transaction order in the applier. Each of these is load-bearing:
  // the bump must precede the announcement (listeners fence on the revision
  // they are told about, and renderArticleContent captures the same counter);
  // canonical must be assigned before the render (every export/Copy/Raw reader
  // goes through it); the AI block index must be rebuilt before
  // article-replaced, or the first listener to read a block index reads the
  // previous article's detached elements.
  const bumpAt = applier.indexOf("_articleRevision++");
  const willAt = applier.indexOf('"pbp:article-will-replace"');
  const canonAt = applier.indexOf("canonicalMarkdown = markdown");
  const renderAt = applier.indexOf("renderArticleContent(canonicalMarkdown)");
  const tocAt = applier.indexOf("rebuildToc()");
  const statsAt = applier.indexOf("refreshReadingStats()");
  const rawAt = applier.indexOf("syncRawView()");
  const indexAt = applier.indexOf("pbpAiIndexBlocks(renderedView)");
  const replacedAt = applier.indexOf('"pbp:article-replaced"');
  check([bumpAt, willAt, canonAt, renderAt, tocAt, statsAt, rawAt, indexAt, replacedAt].every((i) => i >= 0),
    "md-preview.js: the in-place applier is missing one of its steps (revision bump / will-replace / canonical assignment / renderArticleContent / rebuildToc / refreshReadingStats / syncRawView / pbpAiIndexBlocks / article-replaced)");
  check(bumpAt < willAt && willAt < canonAt,
    "md-preview.js: the in-place applier must bump _articleRevision and dispatch pbp:article-will-replace BEFORE assigning canonicalMarkdown -- a listener that learns about the swap after the text changed cannot snapshot or abort anything");
  check(canonAt < renderAt && renderAt < tocAt && tocAt < indexAt && indexAt < replacedAt,
    "md-preview.js: the in-place applier's order must be canonical -> render -> TOC -> AI block index -> pbp:article-replaced; pbpAiIndexBlocks after the announcement means the first listener reads the OLD article's detached blocks");
  check(rawAt > canonAt && statsAt > canonAt,
    "md-preview.js: the in-place applier must refresh the reading stats and the raw view AFTER canonicalMarkdown is reassigned -- both read it through getMarkdown() and would otherwise repeat the previous article's text");
  // Final review M1: the "replaced ALWAYS pairs with will-replace" invariant
  // had no gate -- moving the dispatch out of its finally broke nothing.
  // Every subscriber tears down on will-replace and only recovers on
  // article-replaced, so a swap that throws WITHOUT this pairing leaves the
  // whole md-ai layer dead for the session. Structural pin: the replaced
  // dispatch must sit inside a finally block within the applier.
  // The dispatch must sit INSIDE the finally body, not merely after a finally
  // somewhere: slice from "} finally {" to its first closing brace -- an empty
  // finally with the dispatch moved below it fails this (the first draft of
  // this check only compared positions and passed exactly that mutation).
  const replFinallyAt = applier.indexOf("} finally {");
  const replFinallyBody = replFinallyAt >= 0
    ? applier.slice(replFinallyAt, applier.indexOf("}", replFinallyAt + "} finally {".length) + 1) : "";
  check(replFinallyBody.includes('"pbp:article-replaced"'),
    "md-preview.js: pbp:article-replaced must be dispatched from INSIDE a finally block -- a throw mid-swap would otherwise leave every will-replace subscriber torn down for the session");
  // Synchronous end to end: rebuildToc()'s scroll-spy teardown sits AFTER
  // renderArticleContent() has already swapped the children, so any suspension
  // between them leaves an IntersectionObserver holding detached links.
  // Two independent clauses on purpose: the `async` one is checked against the
  // WHOLE file, so it still fires when marking the applier async is what moved
  // the slice anchor (which would otherwise be reported only as "anchor moved").
  check(!/\bawait\b/.test(applier),
    "md-preview.js: the in-place applier awaits -- (1) the scroll-spy teardown inside rebuildToc runs after the DOM swap and is only safe while both happen in one synchronous task; (2) every article-replacement subscriber assumes will-replace and article-replaced arrive back-to-back in ONE task, and md-vocab-echo.js rests on that EXCLUSIVELY (it has no will handler at all) -- an await here silently breaks them");
  check(!/_applyArticleCommit\s*=\s*async\b/.test(src),
    "md-preview.js: an _applyArticleCommit implementation is async -- the applier must run start to finish in one task (renderArticleContent swaps the children, rebuildToc disposes the spy that was watching them)");
  // The event contract T4/T5/T6 consume. Detail keys, not just the names.
  for (const key of ["revision", "reason", "url", "title", "forum", "account"]) {
    check(new RegExp(`const detail = (?:Object\\.freeze\\()?\\{[^}]*\\b${key}\\b`).test(applier),
      `md-preview.js: the article-replacement event detail no longer carries \`${key}\` -- md-video/md-ask/md-highlight listeners fence and re-anchor on that detail`);
  }
  const reasonsAt = src.indexOf("const VIDEO_COMMIT_REASONS = new Set(");
  const reasonsDecl = reasonsAt >= 0 ? src.slice(reasonsAt, src.indexOf(";", reasonsAt)) : "";
  for (const r of ["video-track-switch", "video-ai-punctuation", "video-promotion", "legacy"]) {
    check(reasonsDecl.includes(`"${r}"`),
      `md-preview.js: the commit reason "${r}" left VIDEO_COMMIT_REASONS -- unknown reasons collapse to "legacy", which silently disables the per-reason behaviour keyed on it (e.g. punctuation-tolerant highlight re-anchoring)`);
  }
  check(commitFn.includes("VIDEO_COMMIT_REASONS.has(o.reason)") && commitFn.includes('aiPunct: opts === true'),
    "md-preview.js: pbpVideoCommitTranscript must validate opts.reason against the enum and keep the legacy third-argument mapping -- md-preview.js's OWN error-shell commit still calls it with two arguments, which lands on that fallback; deleting it would set reason:undefined on that path");

  // --- Payload/restore-record parity, read off the two object literals rather
  // than off a list in this file: both write the SAME MP_KEY slot and both are
  // read back by the SAME committed-transcript bootstrap branch, so a field
  // only one of them carries is silently lost on the F5 after the other wrote
  // last (this is how videoState would have been dropped).
  const braceBody = (text, from) => {
    const open = text.indexOf("{", from);
    if (open < 0) return "";
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(open + 1, i); }
    }
    return "";
  };
  const objectKeys = (body) => {
    const parts = [];
    let depth = 0, cur = "";
    for (const ch of body) {
      if ("{[(".includes(ch)) depth++;
      else if ("}])".includes(ch)) depth--;
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
      cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean)
      .map((p) => (p.includes(":") ? p.slice(0, p.indexOf(":")) : p).trim())
      .filter((key) => /^[A-Za-z_$][\w$]*$/.test(key));
  };
  const payloadKeys = objectKeys(braceBody(commitFn, commitFn.indexOf("[MP_KEY]:")));
  const restoreAt = src.indexOf("const _restoreRecord = info.videoTranscript === true");
  const restoreKeys = objectKeys(braceBody(src, restoreAt));
  check(payloadKeys.length >= 12 && restoreKeys.length >= 12,
    `ui-contract: could not read the commit payload / restore record object literals (${payloadKeys.length} and ${restoreKeys.length} keys) -- the parity check below is UNVERIFIED`);
  const missingInRestore = payloadKeys.filter((key) => !restoreKeys.includes(key));
  const missingInPayload = restoreKeys.filter((key) => !payloadKeys.includes(key));
  check(missingInRestore.length === 0 && missingInPayload.length === 0,
    `md-preview.js: the commit payload and the committed-transcript restore record disagree -- only in the payload: [${missingInRestore.join(", ")}]; only in the restore record: [${missingInPayload.join(", ")}]. Both write the same MP_KEY slot, so whichever wrote last decides what an F5 gets, and a field missing from one is lost the moment that one wins`);
}

// Rescue-tier traces are expected outcomes ("video has no caption tracks"),
// not defects: chrome://extensions lists console.warn in its Errors panel, so
// every `[pbp-video] ... trace` line reports at info (device 2026-08-26: the
// DOM tier's line was the one left at warn and surfaced as three "errors").
{
  const mdVideoJs = read("md-video.js");
  check(mdVideoJs.includes('console.info("[pbp-video] dom transcript:", r.trace)') &&
    mdVideoJs.includes('console.info("[pbp-video] player capture:", r.trace)') &&
    !/console\.warn\("\[pbp-video\] (dom transcript|player capture):", r\.trace\)/.test(mdVideoJs),
    "md-video.js: a rescue-tier trace line reports at warn (it lands in the chrome://extensions Errors list); expected info");
}

// The reader's page-wide `[hidden] { display: none !important; }` fallback is
// an AUTHOR important declaration: it beats every normal display rule in the
// file no matter how specific. Two contracts follow from that, and both were
// broken silently for a month.
//
// (1) #rail-toggle must express its visibility in CSS ALONE. Below 1000px the
// rail is an off-canvas drawer (transform: translateX(-100%)) whose only
// opener is that button, and the markup shipped a static `hidden` attribute
// that nothing ever removes -- so the media query's `display: inline-flex`
// lost to the fallback, and export / TOC / engine switch / Ask / zen were
// unreachable at any width the media query covers. A source check, not a
// render check: the attribute is the whole defect.
{
  const toggleTag = (mdHtml.match(/<button\b[^>]*id="rail-toggle"[^>]*>/) || [])[0] || "";
  check(!!toggleTag, "md-preview.html: #rail-toggle button markup not found");
  check(!/\shidden(\s|=|>)/.test(toggleTag),
    "md-preview.html: #rail-toggle carries a `hidden` attribute again -- the page-wide `[hidden]{display:none!important}` rule outranks the <=1000px `.rail-toggle{display:inline-flex}` reveal, so the off-canvas rail loses its only opener and every rail control (export, TOC, engine switch, Ask, zen) becomes unreachable on a narrow window. Visibility for this button lives in md-preview.css and nowhere else");
}
// (1b) Any render path that SHOWS the hamburger must also wire it. The error
// shell drops body.md-empty (md-preview.js renderErrorState) so the toggle
// paints below 1000px, and that branch returns before the fully-rendered
// path's setupDrawer() call -- an unwired toggle there is a lit no-op.
{
  const earlyReturn = mdPreviewJs.indexOf("await attemptExtract(info.engine);");
  const mainSetup = mdPreviewJs.lastIndexOf("setupDrawer();");
  check(earlyReturn > 0 && mainSetup > earlyReturn,
    "md-preview.js: the pending-extraction branch anchor moved -- re-derive this check before trusting it");
  check(mdPreviewJs.slice(0, earlyReturn).includes("setupDrawer();"),
    "md-preview.js: the error-shell early-return path no longer calls setupDrawer() -- renderErrorState removes body.md-empty, so below 1000px the drawer hamburger paints with no click/Esc listener and the rail stays off-canvas (a lit no-op control)");
}
// (2) #ask-panel INVERTS the meaning of [hidden]: it stays display:flex while
// closed and hides with transform+visibility, because a transform cannot
// animate across display:none. Restating display for that rule therefore
// needs the same weight as the fallback, in the base rule and again in the
// print hide that has to beat it back down.
{
  const bare = mdCss.replace(/\/\*[\s\S]*?\*\//g, "");
  check(/#ask-panel\[hidden\]\s*\{[^}]*display:\s*flex\s*!important/.test(bare),
    "md-preview.css: the closed #ask-panel no longer restates `display: flex !important` -- the page-wide `[hidden]{display:none!important}` fallback wins instead, the panel computes display:none while closed, and both 200ms slides (side panel and narrow bottom sheet) collapse into a hard cut");
  // Brace-depth scan rather than a lazy regex: the file carries several
  // @media print blocks and the hide has to live inside one of them.
  const printBlocks = [];
  for (const m of bare.matchAll(/@media\s+print\s*\{/g)) {
    let i = m.index + m[0].length, depth = 1;
    while (i < bare.length && depth > 0) {
      if (bare[i] === "{") depth++;
      else if (bare[i] === "}") depth--;
      i++;
    }
    printBlocks.push(bare.slice(m.index, i));
  }
  check(printBlocks.some((b) => /#ask-panel\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(b)),
    "md-preview.css: the print hide for a CLOSED #ask-panel lost its !important -- the base rule is important now, so a normal `display: none` here loses and the panel prints as an off-canvas flex column");
}
// The reader is the one surface that does not go through the theme factory,
// so nothing derives an on-danger foreground for it. A literal foreground on
// a themed --danger fill is exactly the shape that passes review in one
// colour scheme and fails AA in the other (white on the dark branch's coral
// measured 2.82:1). Asked as a category, not as a .confirm-yes special case.
{
  const offenders = [];
  for (const m of mdCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = ";" + m[2];
    if (!/(?:^|;)\s*background(?:-color)?\s*:[^;]*var\(--danger\)/.test(body)) continue;
    if (/(?:^|;)\s*color\s*:\s*(#|rgba?\(|hsla?\(|white\b|black\b)/.test(body)) offenders.push(m[1].trim().replace(/\s+/g, " "));
  }
  check(offenders.length === 0,
    `md-preview.css: a solid var(--danger) fill pairs with a hardcoded foreground -- pair it with var(--on-danger), the role this file names for exactly that (white is 2.82:1 over the dark branch's --danger). Offenders: ${offenders.join(" | ")}`);
  check(/--on-danger:\s*light-dark\(/.test(mdCss),
    "md-preview.css: --on-danger is gone from the token block -- the confirm popover's destructive button has no scheme-aware foreground left");
}
// The video toolbar paints its own background/color, which overrides the UA's
// greying for a disabled control -- and md-video.js disables members of that
// family for long stretches (follow in the reading view, the track select and
// the AI button during a batch, the AI button permanently once a pass is
// done) without ever clearing aria-pressed. Without a disabled state a lit
// toggle that does nothing is the result, hover tint included.
{
  const rules = [...mdCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => [m[1].trim().replace(/\s+/g, " "), m[2]]);
  const family = (sel) => /\.pbv-(bar|copy-group)\s*>/.test(sel);
  const hovers = rules.filter(([sel]) => family(sel) && sel.includes(":hover"));
  const count = (str, needle) => str.split(needle).length - 1;
  check(hovers.length > 0 && hovers.every(([sel]) => count(sel, ":not(:disabled)") >= count(sel, ":hover")),
    "md-preview.css: a .pbv-bar hover rule no longer excludes :disabled -- a disabled toolbar control lights up under the pointer as if it were live");
  check(rules.some(([sel, body]) => family(sel) && sel.includes(":disabled") &&
      /opacity:\s*0?\.\d/.test(body) && /cursor:\s*not-allowed/.test(body)),
    "md-preview.css: the .pbv-bar control family lost its :disabled state (opacity + not-allowed, same recipe as .src-seg:disabled) -- the family's own background/color mask the UA greying, so a disabled control is pixel-identical to a live one");
}

// .pop-panel (COMPONENTS.md §10.2): the five reader popovers take their chrome
// from the primitive; an id rule no longer paints a fill or a border, so a
// creator that forgets the class ships a transparent, borderless popover.
for (const [src, file, v, id] of [
  [mdReaderJsSource, "md-reader.js", "pop", "fn-pop"], [mdReaderJsSource, "md-reader.js", "pop", "search-pop"],
  [mdReaderJsSource, "md-reader.js", "pop", "kbd-help-pop"], [mdReaderJsSource, "md-reader.js", "pop", "typo-pop"],
  [mdHighlightJs, "md-highlight.js", "card", "pb-hl-card"],
]) {
  check(new RegExp(`${v}\\.id = "${id}";\\s*\\n\\s*${v}\\.className = "pop-panel";`).test(src),
    `${file}: #${id} is created without class="pop-panel" -- its chrome lives on the primitive, not on the id`);
}
check(/^\.pop-panel \{[\s\S]*?\}/m.test(mdCss) && !/#pb-hl-card \{[^}]*box-shadow/.test(mdCss) && !/#fn-pop \{[^}]*box-shadow/.test(mdCss),
  "md-preview.css: .pop-panel must exist and the popover id rules must not restate the panel shadow");

// The render sweep measures the video workbench through window.pbpVideoFixture
// (md-video.js prepareVideoSession): the fixture check must sit BEFORE the
// origin check, or the sweep silently falls back to the poster card and the
// bar / view toggle / cue list leave the gate again.
{
  const mdVideoJs = read("md-video.js");
  const prep = /async function prepareVideoSession\(ctx\) \{([\s\S]*?)\n  \}\n/.exec(mdVideoJs);
  const fixtureAt = prep ? prep[1].indexOf("window.pbpVideoFixture") : -1;
  const containsAt = prep ? prep[1].indexOf("chrome.permissions.contains") : -1;
  check(prep && fixtureAt >= 0 && containsAt > fixtureAt && /if \(window\.pbpVideoFixture\) return true;/.test(mdVideoJs),
    "md-video.js: prepareVideoSession must build a session from window.pbpVideoFixture before it checks the origin grant, and requestVideoOrigin must honour it -- the render sweep's video leg depends on it");
}

// ===================== K113: icon-only button accessible name =====================
// CLAUDE.md's icon contract requires every icon-only button to carry BOTH a
// title and an aria-label (plus >=24px hit area, which ui-render-audit
// family 4 already measures via its sweepProbe). Only three ids had a
// regression pin for the name half (the #vocab-lookup-narrow checks above);
// a newly added icon-only button was not covered at all. This walks every
// <button> in the four surface HTML files with a general content-shape
// classifier -- not a new regex per id -- so a future icon-only button is
// covered for free, plus the JS-constructed ones this codebase actually has
// (setBtnIcon call sites are always followed by a .title/.setAttribute
// aria-label pair already -- library-vocab.js:596-600 is representative --
// so the one JS-authored family that was NOT self-disciplined, the shared
// "×" dismiss/cancel/delete buttons built via createElement, is what this
// re-derives instead of pinning by file:line).
//
// "Icon-only" is decided from the three decorative/icon markup shapes this
// codebase actually renders inline -- <svg>, a `.btn-ic` span (hydrated at
// load by the repeated `.btn-ic[data-ic]` one-liner in library.js/popup.js/
// options.js), and any `aria-hidden="true"` element (CSS-drawn shapes like
// .send-tri) -- stripped away, then:
//   - if a tag still remains after that, the button is out of scope: a
//     leftover element is either a real text label (#dict-pack-open) or an
//     empty placeholder a JS routine fills with real text later
//     (#offline-queue-toggle's #offline-queue-text span). Neither is
//     icon-only even once rendered. This is exactly the generalization the
//     "any button with no text node" version (considered and rejected, see
//     the K113 brief) gets wrong: it misfires on #tags-last-used /
//     #ai-error-fallback / #offline-queue-toggle / #vocab-stat-learning /
//     #vocab-stat-known / #tag-gov-progress-btn -- six buttons that are
//     genuinely empty until JS fills them from scratch, where none of the
//     three recognized shapes are present statically to say so.
//   - otherwise, if what is left (with any literal "×" stripped) is empty,
//     the button is icon-only and needs a name.
//
// Known limitation, not exercised by any of the four surfaces today (none
// of them put an sr-only text span *inside* a button as its accessible
// name -- every sr-only usage in this codebase is a standalone label/status
// element): this classifier only reads title/aria-label/aria-labelledby
// attributes on the <button> itself. A button naming itself via a nested
// visually-hidden text node would be a real accessible name that this gate
// cannot see and would misreport as missing -- if that pattern is ever
// introduced, iconOnlyButtonInner needs a "does a stripped child still
// carry non-empty text" branch that treats it as already-named rather than
// out of scope.
function iconOnlyButtonInner(inner) {
  const svgFree = inner.replace(/<svg[\s\S]*?<\/svg>/g, "");
  const ariaHiddenFree = svgFree.replace(/<([a-zA-Z][\w-]*)\b[^>]*\baria-hidden="true"[^>]*>[\s\S]*?<\/\1>/g, "");
  const btnIcFree = ariaHiddenFree.replace(/<([a-zA-Z][\w-]*)\b[^>]*\bclass="[^"]*\bbtn-ic\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g, "");
  const hadIconMarkup = btnIcFree !== inner;
  if (/<[a-zA-Z]/.test(btnIcFree)) return false; // a non-decorative element remains -- not our concern
  const text = btnIcFree.replace(/&nbsp;/g, " ").trim();
  if (!hadIconMarkup && text === "") return false; // nothing renders statically at all -- JS fills it from scratch
  return text.replace(/×/g, "").trim() === ""; // empty (or only the × glyph) once the icon shapes are gone
}

// #vocab-remove-group's title legitimately lives at runtime:
// _pbpVocabSyncSelectionUi (library-vocab.js) swaps it between
// vocabRemoveFromGroup and vocabRemoveGroupNoMatch by selection state, so a
// static data-i18n-title would be overwritten by applyI18n on every locale
// refresh and permanently hide the "selection and group don't overlap"
// message. The gate still requires its aria-label statically (that half
// never changes) and cross-checks the JS ownership is really still there --
// an allowlist entry that stops verifying itself is worse than no entry.
const ICON_BUTTON_RUNTIME_TITLE_OWNERS = {
  "vocab-remove-group": () => {
    const fn = /function _pbpVocabSyncSelectionUi\(\) \{[\s\S]*?\n\}/.exec(libraryVocabJs);
    return !!fn && /\$id\("vocab-remove-group"\)/.test(fn[0]) && /removeBtn\.title\s*=/.test(fn[0]);
  },
};

// K113: buttons that render statically empty (no <svg>/.btn-ic/aria-hidden
// shape at all) but are hydrated with an icon by a known JS routine -- not
// "a JS routine fills it with real text" -- must still be in scope for this
// gate, not routed to iconOnlyButtonInner's "JS fills with text -> out of
// scope" branch. Today that's setupSecretToggles() (options.js): the 21
// `.key-toggle` show/hide buttons across popup.html/options.html ship with
// no children at all and get an eye/eyeOff SVG injected at runtime by
// data-target. An entry here forces the button into scope regardless of
// what iconOnlyButtonInner's static read says.
const JS_ICON_CLASSES = new Set(["key-toggle"]);

for (const [file, html] of [["popup.html", popupHtml], ["options.html", optionsHtml], ["library.html", libraryHtml], ["md-preview.html", mdHtml]]) {
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, attrs, inner] = m;
    const classAttr = (/\bclass="([^"]*)"/.exec(attrs) || [])[1] || "";
    const jsHydratedIcon = classAttr.split(/\s+/).some((c) => JS_ICON_CLASSES.has(c));
    if (!jsHydratedIcon && !iconOnlyButtonInner(inner)) continue;
    const id = (/\bid="([^"]*)"/.exec(attrs) || [])[1] || "";
    const label = id ? `#${id}` : `(${attrs.trim().slice(0, 60)})`;
    const hasName = /\baria-label="[^"]*"/.test(attrs) || /\bdata-i18n-aria="/.test(attrs) || /\baria-labelledby="/.test(attrs);
    check(hasName, `${file}: icon-only button ${label} has no aria-label/data-i18n-aria/aria-labelledby -- icon-only buttons must carry an accessible name (CLAUDE.md icon contract)`);
    const owner = id && ICON_BUTTON_RUNTIME_TITLE_OWNERS[id];
    if (owner) {
      check(owner(), `${file}: #${id} is allowlisted as a runtime-owned title, but the JS that is supposed to own it no longer matches that shape -- either restore the ownership or give it a static data-i18n-title and drop the allowlist entry`);
      continue;
    }
    // A literal title="" with no data-i18n-title to hydrate it is not a
    // title -- it is dead weight from a copy-pasted attribute list.
    const titleAttr = /\btitle="([^"]*)"/.exec(attrs);
    const hasTitle = (!!titleAttr && titleAttr[1] !== "") || /\bdata-i18n-title="/.test(attrs);
    check(hasTitle, `${file}: icon-only button ${label} has no title/data-i18n-title -- icon-only buttons must carry both a title and an aria-label (CLAUDE.md icon contract)`);
  }
}

// Regex-literal-vs-division disambiguation for blankNonCode below. Genuinely
// ambiguous from a single "/" in a text scan; this only resolves the
// unambiguous cases (an operator, an opening bracket, ";", or the "return"
// keyword immediately before it, skipping whitespace) and defaults to
// "division" otherwise -- getting that wrong is safe: a regex misread as
// division leaves its content unblanked, which can desync enclosingBlock,
// but the fail-closed check below turns that into a visible gate failure
// instead of a silent pass, so this heuristic only needs to cover the
// common cases, not all of them.
function regexLiteralAllowedBefore(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const c = src[j];
  if ("(,=:[!&|?{};".includes(c)) return true;
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    return src.slice(k + 1, j + 1) === "return";
  }
  return false;
}

// Blanks out string/template literals, regex literals and comments (same
// length, kept as spaces/newlines so indices don't move) so the brace
// counter below cannot be fooled by a "{"/"}" that only exists inside one
// of them -- both are real shapes in this codebase, not hypothetical:
// md-video.js:467's sentence-end regex has a literal "}" inside its
// character class (`/[...}"']*$/`), and md-epub.js:80 / popup-batch.js:301
// both nest a template literal inside another template's `${...}`. A naive
// quote-to-quote string scanner desyncs on the inner template's backtick;
// this tracks `${...}` interpolation with a depth-counted stack (one frame
// per currently-open interpolation) so nesting to any depth resolves, and
// the interpolation's own "${" / matching "}" delimiters are blanked while
// any real code braces inside it (an arrow function body, an object
// literal) pass through untouched for the caller's brace matching.
function blankNonCode(src) {
  const n = src.length;
  const out = new Array(n);
  const blank = (i) => { out[i] = src[i] === "\n" ? "\n" : " "; };
  const tpl = []; // depth of unmatched "{" remaining to close each open ${...}
  let mode = "code"; // code | linecomment | blockcomment | dq | sq | regex | template
  let regexInClass = false;
  let i = 0;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (mode === "code") {
      if (c === "/" && c2 === "/") { mode = "linecomment"; blank(i); i++; continue; }
      if (c === "/" && c2 === "*") { mode = "blockcomment"; blank(i); i++; continue; }
      if (c === "/" && regexLiteralAllowedBefore(src, i)) { mode = "regex"; regexInClass = false; blank(i); i++; continue; }
      if (c === '"') { mode = "dq"; blank(i); i++; continue; }
      if (c === "'") { mode = "sq"; blank(i); i++; continue; }
      if (c === "`") { mode = "template"; blank(i); i++; continue; }
      if (tpl.length) {
        if (c === "{") { tpl[tpl.length - 1]++; out[i] = c; i++; continue; }
        if (c === "}") {
          tpl[tpl.length - 1]--;
          if (tpl[tpl.length - 1] === 0) { tpl.pop(); blank(i); mode = "template"; i++; continue; }
          out[i] = c; i++; continue;
        }
      }
      out[i] = c; i++; continue;
    }
    if (mode === "linecomment") {
      blank(i);
      if (c === "\n") mode = "code";
      i++; continue;
    }
    if (mode === "blockcomment") {
      blank(i);
      if (c === "*" && c2 === "/") { blank(i + 1); i += 2; mode = "code"; continue; }
      i++; continue;
    }
    if (mode === "dq" || mode === "sq") {
      const q = mode === "dq" ? '"' : "'";
      if (c === "\\") { blank(i); i++; if (i < n) { blank(i); i++; } continue; }
      blank(i);
      if (c === q) mode = "code";
      i++; continue;
    }
    if (mode === "regex") {
      if (c === "\\") { blank(i); i++; if (i < n) { blank(i); i++; } continue; }
      if (c === "[") { regexInClass = true; blank(i); i++; continue; }
      if (c === "]") { regexInClass = false; blank(i); i++; continue; }
      if (c === "/" && !regexInClass) {
        blank(i); i++;
        while (i < n && /[a-z]/i.test(src[i])) { blank(i); i++; }
        mode = "code";
        continue;
      }
      if (c === "\n") { blank(i); mode = "code"; i++; continue; } // unterminated -- bail defensively
      blank(i); i++; continue;
    }
    if (mode === "template") {
      if (c === "\\") { blank(i); i++; if (i < n) { blank(i); i++; } continue; }
      if (c === "`") { blank(i); mode = "code"; i++; continue; }
      if (c === "$" && c2 === "{") { blank(i); blank(i + 1); i += 2; tpl.push(1); mode = "code"; continue; }
      blank(i); i++; continue;
    }
  }
  return out.join("");
}

// The smallest {...} block that encloses `index` in `code` (a blankNonCode
// output). Walking backward with a depth counter finds the nearest "{" that
// isn't already closed by a "}" seen between it and index; walking forward
// from there finds its matching close. Returns [openIndex, closeIndex], or
// null if index sits outside any block (top-level module code).
function enclosingBlock(code, index) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const c = code[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) {
        let d = 1;
        for (let j = i + 1; j < code.length; j++) {
          if (code[j] === "{") d++;
          else if (code[j] === "}") { d--; if (d === 0) return [i, j]; }
        }
        return [i, code.length];
      }
      depth--;
    }
  }
  return null;
}

// The lone "×" glyph is CLAUDE.md's one literal-character exception for an
// icon-only close/cancel/delete button (it inherits a fast-loading fallback
// font, unlike emoji/dingbats) -- but a bare "×" is still not an accessible
// name by itself, so every JS-constructed button that sets textContent to
// "×" must also set both a title and an aria-label near that assignment,
// same as its documented siblings (popup.html's #ai-error-dismiss is static
// and already covered by the HTML scan above; this re-derives the JS-built
// ones from the actual call sites across every root JS file instead of
// pinning three file:line locations, so a newly added one is covered too).
//
// Bound to real lexical scope, not a fixed character window: find the
// smallest enclosing {...} block around the × assignment (brace-balanced,
// via blankNonCode + enclosingBlock above), then within that block find
// this variable's most recent declaration/reassignment before the ×
// assignment and its next declaration/reassignment after it, if any -- the
// search window sits strictly between those two. A second button that
// happens to reuse the same local name, whether shadowed in a nested block
// or reassigned later in the very same block, cannot lend its title/
// aria-label to a different button that never set its own (reviewer
// counterexample: two `btn`-named buttons in one function, only the
// non-× one titled -- proven red/green by hand, see the K113 fix report).
//
// blankNonCode's regex/template handling is a heuristic, not a full parser
// (see regexLiteralAllowedBefore above), so enclosingBlock() can still fail
// to balance on a shape it doesn't recognize. When that happens this does
// NOT fall back to searching the whole file -- an unrelated .title on some
// other same-named variable elsewhere would silently satisfy the check,
// which is exactly the false pass a reviewer reproduced against the prior
// +-400-char-window version. Instead it fails the gate directly, naming the
// file and variable, so a desync is visible instead of silently passing.
for (const f of readdirSync(root).filter((n) => n.endsWith(".js"))) {
  const src = read(f);
  const code = blankNonCode(src);
  const xRe = /(\b[A-Za-z_$][\w$]*)\.textContent\s*=\s*(?:"×"|'×'|"\\u00d7"|'\\u00d7')/g;
  let xm;
  while ((xm = xRe.exec(src))) {
    const v = xm[1];
    const block = enclosingBlock(code, xm.index);
    if (!block) {
      check(false, `${f}: cannot determine enclosing scope for × button "${v}" -- blankNonCode likely desynced on a regex literal or template nesting it doesn't recognize; fix the scanner or, if this is a false trigger, narrow it instead of widening the scope search`);
      continue;
    }
    const [blockStart, blockEnd] = block;
    const declRe = new RegExp(`(?:\\b(?:const|let|var)\\s+${v}\\b|[^.\\w$]${v}\\s*=(?!=))`, "g");
    let scopeStart = blockStart, scopeEnd = blockEnd, dm;
    declRe.lastIndex = blockStart;
    while ((dm = declRe.exec(code)) && dm.index < blockEnd) {
      if (dm.index < xm.index) { scopeStart = dm.index; continue; }
      scopeEnd = dm.index;
      break;
    }
    const scope = src.slice(scopeStart, scopeEnd);
    const titleRe = new RegExp(`\\b${v}\\.title\\s*=`);
    const ariaRe = new RegExp(`\\b${v}\\.setAttribute\\(\\s*["']aria-label["']|\\b${v}\\.ariaLabel\\s*=`);
    check(titleRe.test(scope), `${f}: a JS-constructed "×" button ("${v}") has no ${v}.title assignment in its own scope -- a bare × glyph is not an accessible name on its own`);
    check(ariaRe.test(scope), `${f}: a JS-constructed "×" button ("${v}") has no aria-label in its own scope near its textContent = "×" assignment`);
  }
}

// K25: the pbp-hl:<key> Web Lock prefix has four writers -- three resident
// (md-highlight.js's reader commit path, library-notes.js's delete path,
// options-backup.js's backup restore) plus background.js's retiring
// pbpClaimLegacyHighlightOwners() one-shot legacy-owner migration -- that
// coordinate purely by each independently producing the SAME string
// literal. Nothing but four hand-written comments has ever enforced that
// the SET of files doing so stays exactly these four; this gate makes that
// machine-checked. Comments are stripped first, using the module-scope
// character-scanning stripJsComments defined above (NOT a regex stripper --
// fix round 1: a first cut here used
// `s.replace(/\/\*[\s\S]*?\*\//g, "")`, which does not track string
// boundaries and so reads `x + "/*"` -- background.js:3020's
// `frameOrigin + "/*"` is a live instance of exactly this idiom -- as an
// opened block comment; if a REAL comment closes somewhere later in the
// file, the regex greedily swallows everything in between, including a
// genuine "pbp-hl:" literal sitting between the two. It happened to pass
// today only because background.js:3020 sits AFTER its "pbp-hl:" literal at
// :1820 -- pure line-order luck, not a property the gate can rely on) so an
// explanatory mention of "pbp-hl:" inside a comment cannot masquerade as a
// writer, and the scan only counts the literal quoted exactly as "pbp-hl:"
// or 'pbp-hl:' (covers both the bare assignment and the "pbp-hl:" + key
// concatenation form) in the remaining, non-comment code.
//
// PBP_HL_LOCK_PREFIX_WRITERS below is the line that needs editing when
// background.js's pbpClaimLegacyHighlightOwners() migration retires
// (CLAUDE.md 临时事项, due 2026-12-31): deleting its inline "pbp-hl:"
// literal from background.js is meant to make this gate fail on purpose
// (background.js drops out of the detected set while still being
// registered here) until "background.js" is removed from this array too.
{
  // Self-test the shared scanner against exactly the string-boundary hazard
  // this gate depends on it handling, before trusting it (same discipline as
  // the md-preview.js self-check above stripJsComments's first use). Three
  // cases: (1) the safe idiom `x + "/*"` followed by a real comment BEFORE
  // the literal must still leave the literal intact (count 1) -- a stripper
  // that treats the string's "/*" as an opener and the real comment's "*/"
  // as its closer would eat the literal too if it came later, so this alone
  // doesn't fully clear the stripper, hence case 3; (2) the literal sitting
  // INSIDE a real block comment must be stripped (count 0); (3) the actual
  // danger case -- `x + "/*"` followed by the "pbp-hl:" literal and THEN an
  // unrelated real comment -- must still leave the literal intact (count 1).
  // A regex stripper fails case 3 specifically: it treats the string's "/*"
  // as opening a comment that only closes at the unrelated comment's "*/",
  // silently eating the literal sitting between them (reproduces the exact
  // background.js:3020/:1820 ordering hazard in isolation, so this check
  // does not depend on that file's current line order to catch a regression).
  const countPbpHl = (s) => (stripJsComments(s).match(/["']pbp-hl:["']/g) || []).length;
  const selfCheckSafe = 'const o = x + "/*"; /* real */ const k = "pbp-hl:" + key;';
  const selfCheckHidden = 'const o = x + "/*"; /* contains "pbp-hl:" in a real comment */ const k = 1;';
  const selfCheckDanger = 'const o = x + "/*"; const k = "pbp-hl:" + key; /* unrelated */ done();';
  check(countPbpHl(selfCheckSafe) === 1,
    'ui-contract: the pbp-hl: writer-set gate\'s comment stripper lost a "pbp-hl:" literal that follows a `x + "/*"` string and a real comment -- this gate is UNVERIFIED until the stripper is fixed');
  check(countPbpHl(selfCheckHidden) === 0,
    'ui-contract: the pbp-hl: writer-set gate\'s comment stripper failed to remove a "pbp-hl:" mention sitting inside a REAL block comment -- a stray comment mention would masquerade as a writer');
  check(countPbpHl(selfCheckDanger) === 1,
    'ui-contract: the pbp-hl: writer-set gate\'s comment stripper is broken on the `x + "/*"` string-boundary hazard -- it swallowed a real "pbp-hl:" literal that sits between that string and a later unrelated block comment (this is the exact background.js:3020/:1820 shape, reproduced in isolation so it does not depend on that file\'s current line order); a regex-based stripper without string tracking fails this case, which is why this gate must reuse the character-scanning stripJsComments defined above instead of rolling its own');

  const PBP_HL_LOCK_PREFIX_WRITERS = ["background.js", "library-notes.js", "md-highlight.js", "options-backup.js"];
  const pbpHlLiteralRe = /["']pbp-hl:["']/;
  const detected = readdirSync(root)
    .filter((n) => n.endsWith(".js"))
    .filter((n) => pbpHlLiteralRe.test(stripJsComments(read(n))))
    .sort();
  const registered = [...PBP_HL_LOCK_PREFIX_WRITERS].sort();
  const extra = detected.filter((n) => !registered.includes(n));
  const missing = registered.filter((n) => !detected.includes(n));
  check(extra.length === 0 && missing.length === 0,
    `pbp-hl: record lock writer set drifted (registered=${JSON.stringify(registered)}, detected=${JSON.stringify(detected)})` +
    (extra.length ? ` -- a fifth writer of the pbp-hl: record lock appeared (${extra.join(", ")})` : "") +
    (missing.length ? ` -- a registered writer stopped using the prefix (${missing.join(", ")})` : "") +
    ` -- update the registered set (PBP_HL_LOCK_PREFIX_WRITERS in tests/ui-contract-tests.mjs) and the contract comments in all writers.`);
}

// Ruling 22 (T1 review NOTE A, taste-uplift batch3): tests/md-preview-contrast-tests.mjs
// pins the pressed-state text/btn-hover contrast ratio at the TOKEN level --
// reverting a single CSS site's `color` does not move `--link`/`--link-hover`
// so that gate does not trip. This is the selector-level companion: every
// md-preview.css rule whose selector list contains "[aria-pressed", ".active"
// or ":checked" AND whose declarations paint `background: var(--btn-hover)`
// must also paint `color: light-dark(var(--link), var(--link-hover))` --
// the exact recipe documented in the comment above .toggle-btn.active
// (md-preview.css ~:263).
{
  const rules = parseStyleRules(mdCss);
  const offenders = [];
  const matchedSelectors = [];
  for (const rule of rules) {
    const isPressedFamily = rule.selectors.some((sel) =>
      sel.includes("[aria-pressed") || sel.includes(".active") || sel.includes(":checked"));
    if (!isPressedFamily) continue;
    const decls = parseDeclarations(rule.body);
    // Ruling 24 (T5 first commit, taste-uplift batch3): match `background` OR
    // `background-color`, and match the token appearing ANYWHERE in the
    // value (not just as the whole value) -- a future consumer painting
    // `background-color: var(--btn-hover)` or combining it with another
    // layer must not silently fall outside this gate.
    const bg = decls.find((d) =>
      (d.property === "background" || d.property === "background-color") &&
      d.value.includes("var(--btn-hover)"));
    if (!bg) continue;
    matchedSelectors.push(rule.selectorText);
    const color = decls.find((d) => d.property === "color");
    if (!color || color.value !== "light-dark(var(--link), var(--link-hover))") {
      offenders.push(`${rule.selectorText} (md-preview.css:${rule.lineNum})`);
    }
  }
  check(offenders.length === 0,
    "md-preview.css: a pressed-state rule (selector matches [aria-pressed]/.active/:checked, paints background:var(--btn-hover)) does not pair it with color: light-dark(var(--link), var(--link-hover)) -- offenders: " + offenders.join(", "));
  // Expected matches today: the ten pressed-state consumers named in that
  // comment -- .toggle-btn.active, .src-seg.active, .src-seg[aria-pressed="true"],
  // .exp-tgl[aria-pressed="true"], ".exp-img-row option:checked, .xp-dict-lang
  // option:checked", .xp-pin[aria-pressed="true"], .xp-act[aria-pressed="true"],
  // #ask-scope-near[aria-pressed="true"], .srch-regex[aria-pressed="true"],
  // .typo-seg-btn[aria-pressed="true"], and the grouped four-selector rule
  // ".pbv-follow/.pbv-loop/.pbv-autopause/.pbv-estimate[aria-pressed=\"true\"]"
  // -- eleven CSS rules in total (.src-seg alone contributes two declarations,
  // .active and [aria-pressed="true"], for one control family, which is why
  // "ten consumers" and "eleven rules" are both correct at once). Expected
  // non-matches, which correctly stay OUT of this gate: .toc-list a.active
  // (paints `background: var(--border-light)`, not --btn-hover) and
  // .hl-card-dot.active (no background declared at all).
  check(matchedSelectors.length === 11,
    `md-preview.css: pressed-state background:var(--btn-hover) rule count drifted from the expected 11 (found ${matchedSelectors.length}) -- a consumer was added, removed, or changed its fill; update this gate's comment and expectation once the drift is intentional`);
}

// T3 (D5, taste-uplift batch3): browsers synthesize an oblique for CJK glyphs
// (no true italic face exists in any CJK typeface most users have), so
// `font-style: italic` on text that can ever contain CJK reads as a
// rendering glitch, not emphasis -- the same reasoning that upright-ed
// options.css's .tag-gov-reason earlier (~:2674, "CJK has no true italic").
// This batch removed it from every remaining CJK-capable site across the
// four UI surface CSS files. What is left MUST be on this allowlist, each
// with a one-line reason the selector's text can never contain CJK (or, for
// #rendered-view em, is author emphasis rather than synthesized UI chrome):
// anything else declaring font-style: italic|oblique is either a missed
// site from this batch or a future regression re-introducing one.
{
  const ITALIC_ALLOWLIST = {
    "library.css": {
      ".xp-dict-pos": 'part-of-speech tags are English-normalised by the API across query languages (sampled ja/ko); local packs write pos:"" (dict-pack.js:75,388)',
      ".xp-dict-sense-tag": "sense tags are English-normalised by the API across query languages (sampled ja/ko); local packs write them empty (dict-pack.js:75,388)",
    },
    "md-preview.css": {
      ".xp-dict-pos": 'part-of-speech tags are English-normalised by the API across query languages (sampled ja/ko); local packs write pos:"" (dict-pack.js:75,388)',
      ".xp-dict-sense-tag": "sense tags are English-normalised by the API across query languages (sampled ja/ko); local packs write them empty (dict-pack.js:75,388)",
      "#rendered-view em": "author's own emphasis in article/translation content (D5, user ruling), not synthesized UI chrome",
    },
  };
  for (const reasons of Object.values(ITALIC_ALLOWLIST)) {
    for (const [sel, reason] of Object.entries(reasons)) {
      check(typeof reason === "string" && reason.length > 0,
        `tests/ui-contract-tests.mjs: ITALIC_ALLOWLIST entry "${sel}" has no reason string`);
    }
  }

  // Ruling 24 (T5 first commit, taste-uplift batch3): also catch the `font`
  // shorthand -- `font: italic 12px sans-serif` sets the same computed
  // font-style as a standalone `font-style: italic` declaration, and the
  // longhand-only check above would silently miss it.
  const isItalicDecl = (d) =>
    (d.property === "font-style" && /^(italic|oblique)/i.test(d.value)) ||
    (d.property === "font" && /\b(italic|oblique)\b/i.test(d.value));
  const italicFiles = [["popup.css", popupCss], ["options.css", optionsCss], ["library.css", libraryCss], ["md-preview.css", mdCss]];
  for (const [fileName, css] of italicFiles) {
    const allowed = ITALIC_ALLOWLIST[fileName] || {};
    for (const rule of parseStyleRules(css)) {
      if (!parseDeclarations(rule.body).some(isItalicDecl)) continue;
      for (const sel of rule.selectors) {
        check(Object.prototype.hasOwnProperty.call(allowed, sel),
          `${fileName}: "${sel}" declares font-style: italic/oblique but is not in the T3 ITALIC_ALLOWLIST (tests/ui-contract-tests.mjs) -- if this text can contain CJK, remove font-style instead (see options.css's .tag-gov-reason precedent); if it is genuinely Latin-only or author emphasis, add a reason string to the allowlist`);
      }
    }
  }
  // Coverage the other direction: an allowlisted selector that no longer
  // declares italic anywhere is a stale entry (the site was upright-ed and
  // the allowlist line was left behind), silently widening what the gate
  // above would accept without anyone noticing.
  for (const [fileName, css] of italicFiles) {
    const allowed = ITALIC_ALLOWLIST[fileName];
    if (!allowed) continue;
    const present = new Set();
    for (const rule of parseStyleRules(css)) {
      if (!parseDeclarations(rule.body).some(isItalicDecl)) continue;
      for (const sel of rule.selectors) present.add(sel);
    }
    const stale = Object.keys(allowed).filter((sel) => !present.has(sel));
    check(stale.length === 0,
      `${fileName}: T3 ITALIC_ALLOWLIST names selector(s) that no longer declare font-style: italic/oblique -- remove the stale entr${stale.length === 1 ? "y" : "ies"}: ${stale.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Stage-3b Task 1 (2026-09-24-ui-system-stage3b): the .pick primitive
// (COMPONENTS.md §6.4 exception 3) hides its native radio/checkbox input the
// same way .switch hides its checkbox -- opacity: 0, absolutely covering the
// row -- so options.js's existing `input[name=...]:checked` reads and
// `change` listeners keep working on the four migrated radio groups (bgsave-
// mode, tag-sync-mode, popup-width-preset, ai-content-source) without any JS
// changes, while a CSS-drawn `.pick-mark` (composer pickRules, ui-
// components.mjs) carries the visible state cue. Pin the generated rule
// directly (contract, not usability/render-audit) so a sync-all regression
// that dropped the opacity hide surfaces here instead of only showing up as
// "radio rows render a native dot AND a drawn mark" during a real audit.
check(/\.pick > input\[type="radio"\],\s*\.pick > input\[type="checkbox"\]\s*\{[^}]*opacity:\s*0;[^}]*\}/.test(optionsCss),
  'options.css: .pick > input[type="radio"|"checkbox"] does not hide the native control with opacity: 0 (composer pickRules, ui-components.mjs)');

// Stage-3c hand-off N1: a disabled-AND-checked .pick mark (no producer today
// -- options-backup.js and renderStoragePanel force checked=false when
// disabled) must fill with the hint role and a bg tick, not draw a hint tick
// on an accent fill -- and the old single rule that lumped disabled-checked
// in with disabled-unchecked must be gone.
check(/\.pick > input:disabled:checked ~ \.pick-mark \{[^}]*background: var\(--opt-fg-hint\);[^}]*color: var\(--opt-bg\);/.test(optionsCss) &&
  !/\.pick > input:disabled ~ \.pick-mark\b/.test(optionsCss),
  "options.css: a disabled+checked .pick mark must fill with --opt-fg-hint and a --opt-bg tick (composer pickRules), not a hint tick on the accent fill");

// ---- B+ field family, Task 1 (spec docs/superpowers/specs/2026-09-28-ui-
// fields-bplus-design.md §2/§3): the generated .fg recipe paints every value
// box from the --opt-field-* roles (composers/_ui-derive.mjs deriveFieldRoles)
// and owns the placeholder ink; the two hand-written overrides that used to
// repaint text fields -- stage 0's panel fill + --opt-border frame and stage
// 3c's color-mix(border 55%, fg) hover -- stay deleted (rulings superseded).
{
  const genStart = optionsCss.indexOf("/* @generated:ui-components start (options) */");
  const genEnd = optionsCss.indexOf("/* @generated:ui-components end (options) */");
  check(genStart >= 0 && genEnd > genStart, "options.css: @generated:ui-components (options) markers not found");
  const gen = optionsCss.slice(genStart, genEnd);
  const base = declarationValueMap(gen, '.fg input[type="text"]');
  // Stage 4 (spec 2026-09-30-ui-fields-stage4-design §2.1): every generated
  // state rule names each value-box kind -- a bare `.fg input:hover` /
  // `:focus` also reached the .pick / .switch radio and checkbox overlays --
  // and hover excludes the focus trigger and :disabled.
  const FIELD_KINDS = ['input[type="text"]', 'input[type="password"]', 'input[type="number"]', "select", "textarea"];
  const offKinds = FIELD_KINDS.filter((kind) => {
    const hover = declarationValueMap(gen, `.fg ${kind}:hover:not(:focus, :disabled)`);
    const focus = declarationValueMap(gen, `.fg ${kind}:focus`);
    const ring = declarationValueMap(gen, `.fg ${kind}:focus-visible`);
    return hover.get("background-color") !== "var(--opt-field-bg-hover)" || hover.get("border-color") !== "var(--opt-field-border-hover)" ||
      focus.get("outline") !== "none" || focus.get("background-color") !== "var(--opt-field-bg-focus)" ||
      focus.get("border-color") !== "var(--opt-field-border-focus)" || ring.get("box-shadow") !== "var(--opt-focus-ring)";
  });
  check(base.get("border") === "1px solid var(--opt-field-border)" && base.get("background-color") === "var(--opt-field-bg)" && offKinds.length === 0,
    "options.css: the generated .fg recipe no longer paints rest / hover (`:hover:not(:focus, :disabled)`) / focus (`:focus`, ring on `:focus-visible`) from the --opt-field-* family for every value-box kind (composers/ui-components.mjs formRules) -- off: " + offKinds.join(", "));
  // ...and no generated state rule addresses an untyped input again.
  const untypedState = parseStyleRules(gen).flatMap((r) => r.selectors).filter((sel) =>
    subjectAlternatives(subjectOf(sel)).some((compound) => {
      const c = classifyCompound(compound);
      return !c.pseudoElement && c.tag === "input" && c.type === null && /:(?:hover|focus|focus-visible)\b/.test(compound);
    }));
  check(untypedState.length === 0,
    "options.css: a generated state rule targets an untyped `input` (it reaches the .pick / .switch radio and checkbox overlays too): " + untypedState.join(" | "));
  check(declarationValueMap(gen, ".fg input::placeholder").get("color") === "var(--opt-field-placeholder)" &&
    declarationValueMap(gen, ".fg textarea::placeholder").get("color") === "var(--opt-field-placeholder)",
    "options.css: the generated .fg recipe lost its placeholder rule (color: var(--opt-field-placeholder))");
  // Typed text (final fix wave, ruling R13): every value box that paints
  // --opt-field-placeholder paints its typed text with --opt-field-fg, so
  // "empty" (placeholder) and "configured" (typed text) stay >= 1.4:1 apart
  // (contrast-audit's field-fg vs field-placeholder row gates the token
  // pair; these checks gate the consumers). The generated recipe covers
  // .fg text / password / number / textarea / the native select fallback and,
  // through them, the key-wrap inputs and the theme-name popover input.
  check(base.get("color") === "var(--opt-field-fg)",
    `options.css: the generated .fg recipe paints typed text with ${base.get("color")} instead of var(--opt-field-fg) (composers/ui-components.mjs formRules)`);
  const handTyped = stripGeneratedRegions(optionsCss).replace(/\/\*[\s\S]*?\*\//g, "");
  const SEARCH = '.options-search input[type="search"]';
  check(declarationValueMap(handTyped, ".listbox-btn").get("color") === "var(--opt-field-fg)" &&
    declarationValueMap(handTyped, SEARCH).get("color") === "var(--opt-field-fg)",
    "options.css: .listbox-btn and the sidebar search box must paint typed text with var(--opt-field-fg) (ruling R13)");
  // G1 (final review): the search box's placeholder consumer itself is
  // pinned -- contrast-audit's `field-placeholder vs input-bg` row only gates
  // the token pair, so deleting this rule used to leave every gate green
  // while the box fell back to the UA #757575 (nord-night 1.87:1).
  check(declarationValueMap(handTyped, `${SEARCH}::placeholder`).get("color") === "var(--opt-field-placeholder)",
    "options.css: the sidebar search box's ::placeholder must paint var(--opt-field-placeholder) (R4; contrast-audit gates only the token pair)");
  // Stage 4 (spec 2026-09-30 §3.1, §6 item 3): the search box paints the
  // field family at rest and on focus, and NO hover rule paints it -- a
  // field-bg-hover step, derived against panel / pf-bg, sinks into the page
  // bg it sits on (catppuccin-mocha 1.002, gruvbox-dark 1.003).
  const searchRest = declarationValueMap(handTyped, SEARCH);
  const searchFocus = declarationValueMap(handTyped, `${SEARCH}:focus-visible`);
  check(searchRest.get("background") === "var(--opt-field-bg)" && searchRest.get("border") === "1px solid var(--opt-field-border)" &&
    searchFocus.get("outline") === "none" && searchFocus.get("background-color") === "var(--opt-field-bg-focus)" &&
    searchFocus.get("border-color") === "var(--opt-field-border-focus)" && searchFocus.get("box-shadow") === "var(--opt-focus-ring)",
    "options.css: the sidebar search box must paint the field family at rest (background var(--opt-field-bg), border 1px solid var(--opt-field-border)) and on :focus-visible (outline none, --opt-field-bg-focus, --opt-field-border-focus, the ring) -- spec 2026-09-30 §3.1");
  // Fix round 1 (review finding 3, controller ruling): the narrow-screen tab
  // picker sits in .options-nav on the same --opt-bg and gets the same rule
  // -- rest and focus only, no hover (its field-bg-hover step fell to
  // ~1.002 / 1.003 against --opt-bg on catppuccin-mocha / gruvbox-dark,
  // spec F3). Its rest and focus consumers are pinned like the search box's.
  const PICKER = ".mobile-tab-picker select";
  const mergedDecls = (css, selector) => new Map(parseStyleRules(css).filter((r) => !inForcedColors(r) && r.selectors.includes(selector))
    .flatMap((r) => parseDeclarations(r.body).map((d) => [d.property, d.value])));
  const pickerRest = mergedDecls(handTyped, PICKER);
  const pickerFocus = mergedDecls(handTyped, `${PICKER}:focus-visible`);
  check(pickerRest.get("background-color") === "var(--opt-field-bg)" && pickerRest.get("border") === "1px solid var(--opt-field-border)" &&
    pickerRest.get("color") === "var(--opt-field-fg)" && pickerRest.get("background-image") === "var(--opt-field-chevron)" &&
    pickerFocus.get("outline") === "none" && pickerFocus.get("border-color") === "var(--opt-field-border-focus)" && pickerFocus.get("box-shadow") === "var(--opt-focus-ring)",
    "options.css: the narrow-screen tab picker must paint the field family at rest (background-color var(--opt-field-bg), border 1px solid var(--opt-field-border), color var(--opt-field-fg), the --opt-field-chevron) and on :focus-visible (outline none, --opt-field-border-focus, the ring) -- found rest " +
    JSON.stringify([...pickerRest]) + " focus " + JSON.stringify([...pickerFocus]));
  const SEARCH_PAINT_RE = /^(?:background(?:-color)?|border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-color)?)$/;
  // The two value boxes on --opt-bg: the search box (by id, by type, or an
  // untyped input under .options-search) and the picker (by id, or a select
  // under .mobile-tab-picker).
  const reachesSearchOnHover = (sel) => {
    if (!/:hover\b/.test(sel)) return false;
    const subject = subjectOf(sel);
    const prefix = sel.slice(0, sel.length - subject.length);
    return subjectAlternatives(subject).some((compound) => {
      const c = classifyCompound(compound);
      if (c.pseudoElement) return false;
      if (c.ids.includes("options-search-input") || c.ids.includes("mobile-tab-select")) return true;
      if (c.tag === "input" && (c.type === "search" || (c.type === null && /\.options-search(?![\w-])/.test(prefix)))) return true;
      return c.tag === "select" && /\.mobile-tab-picker(?![\w-])/.test(prefix);
    });
  };
  const searchHoverPainters = (css) => parseStyleRules(css)
    .filter((r) => !inForcedColors(r) && r.selectors.some(reachesSearchOnHover) &&
      parseDeclarations(r.body).some((d) => SEARCH_PAINT_RE.test(d.property)))
    .map((r) => r.selectorText);
  const searchHovers = searchHoverPainters(optionsCss.replace(/\/\*[\s\S]*?\*\//g, ""));
  check(searchHovers.length === 0,
    "options.css: a hover rule paints the fill or frame of a value box on --opt-bg -- the sidebar search box or the narrow-screen tab picker; neither has a hover state (spec 2026-09-30 §6 item 3; Task 4 fix round 1 for the picker): " + searchHovers.join(" | "));
  const SEARCH_HOVER_CASES = [
    ['.options-search input[type="search"]:hover { background: var(--opt-field-bg-hover); }', true],
    ["#options-search-input:hover:not(:focus-visible) { border-color: var(--opt-field-border-hover); }", true],
    ['.options-nav:hover .options-search input[type="search"] { background-color: var(--opt-field-bg-hover); }', true],
    ['.options-search input[type="search"]:hover { color: var(--opt-field-fg); }', false],
    [".options-search-result:hover { background: var(--opt-btn-hover); }", false],
    ['@media (forced-colors: active) { .options-search input[type="search"]:hover { border-color: Highlight; } }', false],
    // fix round 1 (review findings 1 / 3): the narrow-screen tab picker sits
    // on --opt-bg too and has no hover either; an untyped input under
    // .options-search is the search box; `forced-colors: none` is normal mode
    [".mobile-tab-picker select:hover:not(:focus-visible, :disabled) { background-color: var(--opt-field-bg-hover); }", true],
    ["#mobile-tab-select:hover { border-color: var(--opt-field-border-hover); }", true],
    [".options-search input:hover { background: var(--opt-field-bg-hover); }", true],
    ['@media (forced-colors: none) { .options-search input[type="search"]:hover { background: var(--opt-field-bg-hover); } }', true],
    [".mobile-tab-picker select:hover { color: var(--opt-field-fg); }", false],
    [".mobile-tab-picker label:hover { background: var(--opt-btn-hover); }", false],
    [".fg select:hover:not(:focus, :disabled) { background-color: var(--opt-field-bg-hover); }", false],
  ];
  const searchMisjudged = SEARCH_HOVER_CASES.filter(([css, want]) => (searchHoverPainters(css).length > 0) !== want);
  check(searchMisjudged.length === 0,
    "ui-contract-tests.mjs: the --opt-bg value boxes' no-hover scan (sidebar search, tab picker) no longer discriminates -- misjudged: " + searchMisjudged.map(([css, want]) => `${want ? "missed" : "false hit"}: ${css}`).join(" | "));
  // The popover input must not re-declare typed text (it inherits the recipe).
  const popoverColour = parseStyleRules(handTyped).filter((r) => r.selectors.some((sel) => /\.theme-name-popover input/.test(sel)) &&
    parseDeclarations(r.body).some((d) => d.property === "color" && d.value.trim() !== "var(--opt-field-fg)"));
  check(popoverColour.length === 0,
    "options.css: a hand rule repaints the theme-name popover input's typed text with something other than --opt-field-fg: " + popoverColour.map((r) => r.selectorText).join(" | "));
  const hand = stripGeneratedRegions(optionsCss).replace(/\/\*[\s\S]*?\*\//g, "");
  const rowModel = declarationValueMap(hand, '.fg :is(input[type="text"], input[type="password"], input[type="number"])');
  const textarea = declarationValueMap(hand, ".fg textarea");
  // Existence first (P10): a renamed or split selector makes declarationValueMap
  // return an empty Map, and the negative checks below would pass vacuously.
  check(rowModel.size > 0,
    "options.css: the hand-written row-model rule .fg :is(input[type=\"text\"], input[type=\"password\"], input[type=\"number\"]) was not found -- update this check's selector, do not let it pass vacuously");
  check(textarea.size > 0,
    "options.css: the hand-written .fg textarea rule was not found -- update this check's selector, do not let it pass vacuously");
  check(!rowModel.has("background-color") && !rowModel.has("border-color") &&
    !textarea.has("background-color") && !textarea.has("border-color") &&
    !/color-mix\(in srgb, var\(--opt-border\) 55%, var\(--opt-fg\)\)/.test(hand),
    "options.css: a hand-written row-model rule repaints text fields again (the stage-0 panel/--opt-border override or the stage-3c border-55% hover mix) -- superseded by the B+ field family");
}

// ---- B+ field family, Task 2 (+ fix round 1): every HAND-WRITTEN colour
// declaration on a value box reads the --opt-field-* family -- the class form
// of "the stage-0 panel/--opt-border override stays gone" (CLAUDE.md: assert
// the category, not the instance). "Value box" is the selector model above
// (subject compound, each :is() argument on its own, ids harvested from
// options.html), so a .fg / .key-wrap / .entry-block text control, textarea
// or select, the listbox button, the narrow-screen tab picker, the theme-name
// popover input and an #id rule on any of them are all in. Beyond colour the
// scan also rejects (fix round 1, final review G4): a rule that unpaints any
// side -- all four carry the box's one frame colour, collapsed into the fill
// or the pilot frame on nord-night / dracula / rose-pine / terminal (width 0
// / style none|hidden / transparent colour, in any physical or logical,
// longhand or shorthand spelling); a background that drops the Soft Fill (`transparent`
// / `none`, G2); text in anything but --opt-field-fg on any value box (ruling
// R13; stage 4 D6 -- select text and the narrow-screen tab picker's too,
// spec 2026-09-30 §2.2); a hand-written --opt-field-* custom property (a
// local re-point of the family; the generated ui-themes blocks own them),
// and a static value-box rule at or above the generated hover's (0,3,1)
// specificity that paints fill or frame -- it would freeze the hover/focus
// fills (the removed `html[data-theme] .theme-name-popover input` twin).
// Exempt: forced-colors blocks (system colours by design), ::picker(select)
// and <option> subjects (floating surfaces, §9.1 law 4), checkbox/radio/file
// inputs, and VALUE_BOX_EXEMPT by name.
{
  const VALUE_BOX_EXEMPT = [
    // The byte-over-limit ERROR state of the custom-CSS box repaints its whole
    // frame in --opt-danger on purpose (options.js toggles .over-limit); an
    // error state outranks the field family.
    { selector: "#opt-custom-css.over-limit", property: "border-color", value: "var(--opt-danger)" },
  ];
  const isExempt = (sel, d) => VALUE_BOX_EXEMPT.some((e) => e.selector === sel && e.property === d.property && e.value === d.value.trim());
  // P11: every colour-bearing fill / border property by PATTERN (all four
  // physical sides, the logical inline/block sides and their -start/-end,
  // shorthand and -color longhand), not a hand-kept list a new spelling
  // (border-left, border-inline-end-color) would walk around.
  const COLOUR_PROP_RE = /^(?:background(?:-color)?|border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-color)?)$/;
  const STATE_RE = /:(?:hover|focus|focus-visible|focus-within|active|disabled|checked|invalid|user-invalid|placeholder-shown|autofill)\b/;
  // valueTokens: module level (lifted with valueBoxShapeOffenders, Task 6).
  const ZERO_W = (t) => /^0(?:\.0*)?(?:px|em|rem|%)?$/i.test(t || "");
  const NO_STYLE = (t) => /^(?:none|hidden)$/i.test(t || "");
  const NO_COLOUR = (t) => /^transparent$/i.test(t || "");
  // GI-1 + G4: does this declaration leave ANY side unpainted? Every value of
  // a 1-4 value box list / 1-2 value logical pair names some side, so any one
  // of them failing is enough. Sides: the physical four and the logical
  // inline/block pairs with their -start/-end.
  const SIDE_RE = "(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?";
  const SHORTHAND_RE = new RegExp(`^border${SIDE_RE}$`);
  const PART_RE = new RegExp(`^border${SIDE_RE}-(width|style|color)$`);
  const unpaintsSide = (prop, value) => {
    const ts = valueTokens(value);
    if (!ts.length) return false;
    if (SHORTHAND_RE.test(prop)) return ts.some((t) => ZERO_W(t) || NO_STYLE(t) || NO_COLOUR(t));
    const part = PART_RE.exec(prop)?.[1];
    if (part === "width") return ts.some(ZERO_W);
    if (part === "style") return ts.some(NO_STYLE);
    if (part === "color") return ts.some(NO_COLOUR);
    return false;
  };
  const offenders = (css) => {
    const out = [];
    for (const rule of parseStyleRules(css)) {
      const decls = parseDeclarations(rule.body);
      for (const d of decls) {
        if (d.property.startsWith("--opt-field-")) out.push(`${rule.selectorText} { ${d.property}: ${d.value} } -- re-points the field family`);
      }
      if (inForcedColors(rule)) continue;
      // Follow-up 7a: a value box's placeholder ink is the field family's
      // secondary ink too. isValueBoxSelector drops pseudo-element subjects,
      // so a hand `::placeholder` repaint (fg-hint, a literal) walked around
      // every check above and re-opened the "empty reads as configured" gap.
      // The category is "anything that changes the placeholder's RENDERED
      // contrast", not only its colour (round 2, gates/F7): --opt-field-
      // placeholder is derived for >= 4.5:1 on both fills, and an opacity
      // below 1, a filter or a blend mode fades or shifts that ink after the
      // derivation (`opacity: .45` passed the colour-only scan). Identity
      // values (opacity 1 / 100%, filter none, mix-blend-mode normal) are
      // fine -- Firefox ships a UA placeholder opacity of .54, and resetting
      // it to 1 is the one opacity rule a stylesheet may want here.
      const placeholders = rule.selectors.filter(isValueBoxPlaceholderSelector);
      const PLACEHOLDER_INK_IDENTITY = {
        opacity: /^(?:1(?:\.0*)?|100(?:\.0*)?%)$/,
        filter: /^none$/i,
        "mix-blend-mode": /^normal$/i,
      };
      for (const d of decls) {
        if (!placeholders.length) continue;
        if (/^(?:color|-webkit-text-fill-color)$/.test(d.property) && d.value.trim() !== "var(--opt-field-placeholder)") {
          out.push(`${placeholders.join(", ")} { ${d.property}: ${d.value} } -- a value box's placeholder must paint var(--opt-field-placeholder)`);
        } else if (Object.hasOwn(PLACEHOLDER_INK_IDENTITY, d.property) && !PLACEHOLDER_INK_IDENTITY[d.property].test(d.value.trim())) {
          out.push(`${placeholders.join(", ")} { ${d.property}: ${d.value} } -- changes the placeholder's rendered contrast after --opt-field-placeholder was derived for it`);
        }
      }
      const boxes = rule.selectors.filter(isValueBoxSelector);
      if (!boxes.length) continue;
      const live = decls.filter((d) => !boxes.every((sel) => isExempt(sel, d)));
      for (const d of live) {
        if (unpaintsSide(d.property, d.value)) { out.push(`${boxes.join(", ")} { ${d.property}: ${d.value} } -- unpaints a border side`); continue; }
        if (d.property === "color") {
          if (d.value.trim() !== "var(--opt-field-fg)") out.push(`${boxes.join(", ")} { color: ${d.value} } -- text on a value box's fill must be var(--opt-field-fg)`);
          continue;
        }
        if (!COLOUR_PROP_RE.test(d.property)) continue;
        if (/^background(?:-color)?$/.test(d.property) && /^(?:none|transparent)$/i.test(d.value.trim())) {
          out.push(`${boxes.join(", ")} { ${d.property}: ${d.value} } -- drops the Soft Fill`);
          continue;
        }
        if (/^(?:none|transparent|inherit|currentcolor|0)$/i.test(d.value.trim())) continue;
        const refs = [...d.value.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]);
        const literal = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix\(/i.test(d.value);
        if (literal || !refs.length || refs.some((r) => !r.startsWith("--opt-field-"))) out.push(`${boxes.join(", ")} { ${d.property}: ${d.value} }`);
      }
      // (0,3,1): the lowest generated hover -- .fg select / textarea; the
      // typed input hovers are (0,4,1) (stage 4).
      const frozen = boxes.filter((sel) => !STATE_RE.test(sel) && cmpSpecificity(selectorSpecificity(sel), [0, 3, 1]) >= 0);
      const paints = live.filter((d) => COLOUR_PROP_RE.test(d.property));
      if (frozen.length && paints.length) {
        out.push(`${frozen.join(", ")} { ${paints.map((d) => d.property).join(", ")} } -- a static rule at >= (0,3,1) freezes the generated hover/focus fills`);
      }
    }
    return out;
  };
  const bad = offenders(stripGeneratedRegions(optionsCss).replace(/\/\*[\s\S]*?\*\//g, ""));
  check(bad.length === 0,
    "options.css: a hand-written value-box rule leaves the B+ field family (non-field colour / unpainted border side / dropped fill / typed text not --opt-field-fg / placeholder not --opt-field-placeholder / --opt-field-* re-point / state freeze): " + bad.join(" | "));
  // Discrimination, one synthetic rule at a time: [css, must be caught].
  // Fix round 1 added the second group; the Task 2 scan (subject-blind
  // substring exclusion, class-shaped selectors only, colour props only)
  // missed every one of them.
  const VALUE_BOX_CASES = [
    ['.fg input[type="text"] { border-color: var(--opt-border); }', true],
    [".listbox-btn:hover { border-color: var(--opt-focus-bd); }", true],
    ['.fg input[type="text"] { border-left: 1px solid var(--opt-border); }', true],
    [".fg select::picker(select) { border: 1px solid var(--opt-border); }", false],
    [".fg textarea { border-bottom-color: var(--opt-field-edge); }", false],
    // fix round 1
    ['.fg input:not([type="checkbox"]) { background: var(--opt-panel); }', true],
    ['.fg :is(input[type="checkbox"], textarea) { border-color: var(--opt-border); }', true],
    ["#dict-anki-deck { border-color: var(--opt-border); }", true],
    ["#opt-lang-btn:hover { background: var(--opt-btn-hover); }", true],
    ['.entry-block input[type="text"] { background-color: var(--opt-panel); }', true],
    ['.fg input[type="text"] { --opt-field-bg: var(--opt-panel); }', true],
    ['.fg :is(input[type="text"], textarea) { border-bottom-width: 0; }', true],
    [".listbox-btn { border-bottom-style: none; }", true],
    [".fg textarea { border-width: 1px 1px 0; }", true],
    ['.fg input[type="password"] { border: 0; }', true],
    [".fg textarea { border-style: solid solid hidden; }", true],
    ['.fg input[type="text"] { border-block-end: none; }', true],
    ['.fg input[type="text"] { border-bottom-color: transparent; }', true],
    ['html[data-theme] .theme-name-popover input[type="text"] { background: var(--opt-field-bg); }', true],
    ["#opt-custom-css.over-limit { border-color: var(--opt-border); }", true],
    ["#opt-custom-css.over-limit { background: var(--opt-panel); }", true],
    // must stay clean
    ["#opt-custom-css.over-limit { border-color: var(--opt-danger) !important; }", false],
    ['.fg input[type="checkbox"] { background: var(--opt-accent); }', false],
    ['.options-search input[type="search"] { background: var(--opt-field-bg); border: 1px solid var(--opt-field-border); }', false],
    [".fg option:hover { background: var(--opt-option-hover-bg); }", false],
    ['.fg input[type="text"]:hover:not(:focus) { background-color: var(--opt-field-bg-hover); }', false],
    [".fg textarea { border-width: 1px; }", false],
    // final fix wave: G2 (fill dropped), G4 (any side unpainted), R13 (typed text)
    ['.fg input[type="text"] { background: transparent; }', true],
    [".listbox-btn:hover { background-color: transparent; }", true],
    [".fg textarea { background: none; }", true],
    ['.fg input[type="text"] { border-top-width: 0; }', true],
    [".fg textarea { border-inline-style: none; }", true],
    [".listbox-btn { border-left-color: transparent; }", true],
    ['.fg input[type="password"] { border-width: 1px 0 1px 1px; }', true],
    ['.fg input[type="text"] { border-inline-start: 0; }', true],
    [".fg textarea { border-style: solid hidden solid solid; }", true],
    [".listbox-btn { color: var(--opt-fg); }", true],
    ['.fg input[type="text"] { color: var(--opt-fg-muted); }', true],
    ["#dict-anki-deck { color: #333; }", true],
    // stage 4: the sidebar search box is a value box; D6 -- select text too
    ['.options-search input[type="search"] { background: var(--opt-input-bg); }', true],
    ["#options-search-input { border-color: var(--opt-input-border); }", true],
    [".mobile-tab-picker select { color: var(--opt-fg); }", true],
    [".fg select { color: var(--opt-fg); }", true],
    ['.options-search input[type="search"]::placeholder { opacity: .5; }', true],
    ['.options-search input[type="search"]::placeholder { color: var(--opt-fg-hint); }', true],
    // must stay clean
    [".listbox-btn { color: var(--opt-field-fg); }", false],
    ['.fg :is(input[type="text"], textarea) { color: var(--opt-field-fg); }', false],
    [".mobile-tab-picker select { color: var(--opt-field-fg); }", false],
    [".fg select { color: var(--opt-field-fg); }", false],
    [".fg input::placeholder { color: var(--opt-field-placeholder); }", false],
    [".fg textarea { border-color: var(--opt-field-border); border-width: 1px 1px 1px 1px; }", false],
    [".key-toggle { background: none; }", false],
    // follow-up 7a: hand ::placeholder repaints on a value box
    ['.fg input[type="text"]::placeholder { color: var(--opt-fg-hint); }', true],
    [".fg textarea::placeholder { color: #999; }", true],
    ["#dict-anki-deck::placeholder { color: var(--opt-fg-muted); }", true],
    ['.fg :is(input[type="password"], textarea)::placeholder { color: var(--opt-fg-hint); }', true],
    ['.fg input[type="text"]::-webkit-input-placeholder { color: var(--opt-fg-hint); }', true],
    ['.fg input[type="text"]::placeholder { -webkit-text-fill-color: var(--opt-fg-hint); }', true],
    // round 2 (gates/F7): the rendered contrast, not only the colour
    ['.fg input[type="text"]::placeholder { opacity: .45; }', true],
    [".fg textarea::placeholder { opacity: 50%; }", true],
    ['.fg input[type="password"]::placeholder { filter: opacity(.6); }', true],
    ["#dict-anki-deck::placeholder { mix-blend-mode: multiply; }", true],
    // must stay clean
    ['.fg input[type="text"]::placeholder { color: var(--opt-field-placeholder); }', false],
    ['.fg input[type="text"]::placeholder { opacity: 1; }', false],
    [".fg textarea::placeholder { opacity: 100%; filter: none; mix-blend-mode: normal; }", false],
    [".fg textarea::placeholder { font-style: italic; }", false],
    ['.fg input[type="checkbox"]::placeholder { color: var(--opt-fg-hint); }', false],
  ];
  const misjudged = VALUE_BOX_CASES.filter(([css, want]) => (offenders(css).length > 0) !== want);
  check(misjudged.length === 0,
    "ui-contract-tests.mjs: the value-box scan no longer discriminates -- misjudged: " + misjudged.map(([css, want]) => `${want ? "missed" : "false hit"}: ${css}`).join(" | "));

  const hand = stripGeneratedRegions(optionsCss);
  // Stage 4 (spec 2026-09-30-ui-fields-stage4-design §2.1): a value box has
  // ONE radius on all four corners -- the surface's md -- and no bottom edge.
  // The generated base owns that radius for .fg text / password / number /
  // select / textarea (the hand-written B+ shape half that re-split it is
  // gone); the listbox button, a <button> outside the recipe's FIELD_SEL,
  // declares the same md itself. The class form -- no hand rule may split a
  // value box's radius or give it a bottom side -- is the shape scan below.
  {
    const genStart = optionsCss.indexOf("/* @generated:ui-components start (options) */");
    const genEnd = optionsCss.indexOf("/* @generated:ui-components end (options) */");
    const gen = genStart >= 0 && genEnd > genStart ? optionsCss.slice(genStart, genEnd) : "";
    check(declarationValueMap(gen, '.fg input[type="text"]').get("border-radius") === "var(--opt-radius-md)",
      "options.css: the generated .fg recipe no longer gives value boxes var(--opt-radius-md) on all four corners (composers/ui-components.mjs formRules)");
  }
  const lb = declarationValueMap(hand, ".listbox-btn");
  // Every top-level hover rule on the button itself, however its state
  // exclusions are spelled (`.listbox-btn:hover`, `...:hover:not(...)`).
  const lbHovers = parseStyleRules(hand.replace(/\/\*[\s\S]*?\*\//g, ""))
    .filter((r) => r.context.length === 0 && r.selectors.some((sel) => /^\.listbox-btn(?![\w-])[^\s>+~]*:hover/.test(sel)))
    .map((r) => new Map(parseDeclarations(r.body).map((d) => [d.property, d.value])));
  check(lb.get("border-radius") === "var(--opt-radius-md)" && lb.get("border") === "1px solid var(--opt-field-border)" && !lb.has("border-bottom-color") &&
    lbHovers.length > 0 && lbHovers.every((m) => m.get("border-color") === "var(--opt-field-border-hover)" && !m.has("border-bottom-color")),
    "options.css: the listbox button must be a stage-4 value box -- var(--opt-radius-md) on all four corners, one --opt-field-border frame, hover --opt-field-border-hover on all four sides, no bottom edge in either state");
  check(declarationValueMap(hand, ".listbox-btn .btn-ic").get("color") === "var(--opt-field-placeholder)" &&
    declarationValueMap(hand, ".key-toggle").get("color") === "var(--opt-field-placeholder)" &&
    declarationValueMap(hand, ".key-toggle:hover").get("background") === "color-mix(in srgb, var(--opt-field-fg) 8%, var(--opt-field-bg-hover))" &&
    declarationValueMap(hand, ".key-wrap:focus-within .key-toggle:hover").get("background") === "color-mix(in srgb, var(--opt-field-fg) 8%, var(--opt-field-bg-focus))",
    "options.css: the key-wrap eye / listbox chevron must paint the field's secondary ink (--opt-field-placeholder), and the eye's hover chip must mix over the fill its field paints in each state -- --opt-field-bg-hover while the unit is only hovered (C-1), --opt-field-bg-focus while it holds focus (B+ re-review M1) -- --opt-field-fg at 8% (stage 4 spec 2026-09-30 §2.2: a small button's hover fill inside a value box is the field's text ink at 8% over the fill; a heavier eye fill was rejected on sight; the chip-contrast block below holds it to FILL_SEPARATE_MIN)");
  // P7: the eye's inset focus ring sits ON the field fill, so its core is the
  // field's own focus border (flexoki-light: --opt-focus-bd is 2.73:1 there).
  check(declarationValueMap(hand, ".key-toggle:focus-visible").get("outline") === "2px solid var(--opt-field-border-focus)",
    "options.css: .key-toggle:focus-visible must draw its inset ring in --opt-field-border-focus (it sits on the field fill; B+ P7)");
  // Fix round 1 (T2-CAS-3): with the EYE focused and the pointer over the
  // input, the key-wrap unit's focus frame must beat every hover rule that
  // can paint a key-wrap input -- generated or hand-written -- on fill and
  // frame by STRICTLY higher specificity (stage 4, spec 2026-09-30-ui-
  // fields-stage4-design §2.1: focus never wins on source order). Both unit
  // rules paint only an enabled input (`:not(:disabled)`, spec §2.1: every
  // hover excludes :disabled), which also lifts the frame to (0,5,1), above
  // the typed generated hover's (0,4,1).
  {
    const FW = '.fg .key-wrap:focus-within :is(input[type="text"], input[type="password"]):not(:disabled)';
    // Comments are blanked, not removed, so r.lineNum is the real options.css
    // line in the failure messages below (T2 minor).
    const all = parseStyleRules(optionsCss.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, "")));
    const fw = all.filter((r) => r.context.length === 0 && r.selectors.includes(FW));
    const fwDecls = new Map(fw.flatMap((r) => parseDeclarations(r.body).map((d) => [d.property, d.value])));
    check(fw.length === 1 && fwDecls.get("background-color") === "var(--opt-field-bg-focus)" &&
      fwDecls.get("border-color") === "var(--opt-field-border-focus)" && fwDecls.get("box-shadow") === "var(--opt-focus-ring)",
      `options.css: the key-wrap focus frame rule \`${FW}\` is missing or no longer paints bg-focus + field-border-focus (all four sides) + the ring`);
    check(fw.length === 1 && optionsCss.split("\n")[fw[0].lineNum - 1].includes(".fg .key-wrap:focus-within"),
      `ui-contract-tests.mjs: rule line numbers no longer point at options.css's real lines (key-wrap frame reported at line ${fw[0]?.lineNum})`);
    // C-1 (final review): the pointer over the EYE (the input's sibling) keeps
    // the field in its hover paint -- fill and all four sides -- via the
    // unit's own :hover, which must out-rank the generated hover and be
    // mutually exclusive with the focus frame. (A render-audit row cannot pin
    // this: its "hover" state can only hover the probed element itself.)
    // Stage 4: no hand rest / hover edge rule is left for it to out-rank,
    // and it restates no bottom side of its own.
    const KWH = '.fg .key-wrap:hover:not(:focus-within) :is(input[type="text"], input[type="password"]):not(:disabled)';
    const kwh = all.filter((r) => r.context.length === 0 && r.selectors.includes(KWH));
    const kwhDecls = new Map(kwh.flatMap((r) => parseDeclarations(r.body).map((d) => [d.property, d.value])));
    check(kwh.length === 1 && kwhDecls.get("background-color") === "var(--opt-field-bg-hover)" &&
      kwhDecls.get("border-color") === "var(--opt-field-border-hover)" && !kwhDecls.has("border-bottom-color") &&
      ['input[type="text"]', 'input[type="password"]'].every((kind) => {
        const gen = `.fg ${kind}:hover:not(:focus, :disabled)`;
        return all.some((r) => r.selectors.includes(gen)) && cmpSpecificity(selectorSpecificity(KWH), selectorSpecificity(gen)) > 0;
      }),
      `options.css: the key-wrap unit hover rule \`${KWH}\` is missing, no longer restates the hover fill and all four sides (--opt-field-border-hover, no separate bottom side), or no longer out-ranks the generated hover`);
    // A hover rule whose key-wrap (or an ancestor of it) carries
    // :not(:focus-within) cannot match while the unit holds focus, so it
    // cannot beat the frame; every other hover rule must lose to it.
    const exclusiveOfFocusWithin = (sel) => {
      const parts = sel.split(/\s+|\s*>\s*/).filter(Boolean);
      const kw = parts.findIndex((p) => /\.key-wrap\b/.test(p));
      return kw >= 0 && parts.slice(0, kw + 1).some((p) => p.includes(":not(:focus-within)"));
    };
    check(exclusiveOfFocusWithin(KWH) && !exclusiveOfFocusWithin('.fg .key-wrap:hover :is(input[type="text"]):not(:focus-within)') &&
      !exclusiveOfFocusWithin(".fg input:hover:not(:focus)"),
      "ui-contract-tests.mjs: the focus-within exclusivity predicate no longer discriminates (it must only credit :not(:focus-within) on the key-wrap or an ancestor, never on the input)");
    const PAINT_RE = /^(?:background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?)$/;
    const reachesKeyWrapInput = (sel) => /:hover/.test(sel) && subjectAlternatives(subjectOf(sel)).some((compound) => {
      const c = classifyCompound(compound);
      return !c.pseudoElement && c.tag === "input" && (c.type === null || c.type === "text" || c.type === "password");
    });
    const hovers = all.filter((r) => !inForcedColors(r) && r.selectors.some(reachesKeyWrapInput) &&
      parseDeclarations(r.body).some((d) => PAINT_RE.test(d.property)));
    check(hovers.length >= 2,
      "ui-contract-tests.mjs: found fewer than 2 hover rules painting a key-wrap input (the generated .fg input hover + the key-wrap unit hover) -- the focus-within precedence check would be vacuous");
    const fwSpec = selectorSpecificity(FW);
    const winners = fw.length !== 1 ? [] : hovers.filter((r) => r.selectors.filter(reachesKeyWrapInput).filter((sel) => !exclusiveOfFocusWithin(sel))
      .some((sel) => cmpSpecificity(fwSpec, selectorSpecificity(sel)) <= 0));
    check(winners.length === 0,
      "options.css: a hover rule is not strictly out-ranked by the key-wrap focus frame (eye focused + pointer over the input would show hover paint, or win only on source order -- spec 2026-09-30 §2.1): " + winners.map((r) => `${r.selectorText} (line ${r.lineNum})`).join(" | "));
  }
  // Stage 4 shape scan (spec 2026-09-30-ui-fields-stage4-design §2.1 / §5.1;
  // COMPONENTS.md §6.1): no hand rule draws a value box apart from its one
  // frame colour and one radius. Every value box by the selector model above
  // (.fg text / password / number / textarea / select, the listbox button,
  // the tab picker, the key-wrap inputs, the theme-name popover input, their
  // options.html ids): no bottom-side border property (physical or logical;
  // shorthand, colour, width or style), no value that names an
  // --opt-field-edge* token (border, border-block, border-color lists,
  // box-shadow...), no multi-value border-color / border-block-color whose
  // bottom differs from its top, no multi-value border-radius and no
  // per-corner radius longhand (physical or logical). This is the class form
  // of the deleted B+ shape half (and of its predecessor, the native-select
  // fill-only check, which only covered selects).
  // valueBoxShapeOffenders is module level since stage 4 Task 6 (popup runs
  // it with its own predicate); options passes the B+ selector model.
  const optShapeOffenders = (css) => valueBoxShapeOffenders(css, isValueBoxSelector);
  const shapeBad = optShapeOffenders(hand);
  check(shapeBad.length === 0,
    "options.css: a hand-written value-box rule draws a bottom edge or splits the radius (stage 4: one frame colour on all four sides, one md radius on all four corners): " + shapeBad.join(" | "));
  const SHAPE_CASES = [
    // the retired B+ shape half, each piece on its own
    ['.fg :is(input[type="text"], input[type="password"], input[type="number"], textarea) { border-bottom-color: var(--opt-field-edge); }', true],
    ['.fg :is(input[type="text"], textarea):hover:not(:focus) { border-bottom-color: var(--opt-field-edge-hover); }', true],
    ['.fg :is(input[type="text"], textarea):focus { border-bottom-color: var(--opt-field-border-focus); }', true],
    ['.fg :is(input[type="text"], textarea) { border-radius: var(--opt-radius-md) var(--opt-radius-md) var(--opt-radius-sm) var(--opt-radius-sm); }', true],
    [".listbox-btn { border-bottom-color: var(--opt-field-edge); }", true],
    [".listbox-btn { border-radius: var(--opt-radius-md) var(--opt-radius-md) var(--opt-radius-sm) var(--opt-radius-sm); }", true],
    ['.fg .key-wrap:hover:not(:focus-within) :is(input[type="text"], input[type="password"]) { border-bottom-color: var(--opt-field-edge-hover); }', true],
    ['.fg input[type="text"] { border-bottom-left-radius: 0; }', true],
    [".fg textarea { border-end-end-radius: var(--opt-radius-sm); }", true],
    ["#dict-anki-deck { border-block-end-color: var(--opt-field-border-focus); }", true],
    ['.fg input[type="number"] { border-radius: var(--opt-radius-md) / var(--opt-radius-sm); }', true],
    // the former native-select fill-only cases, now over every value box
    [".fg select { border-bottom: 1px solid var(--opt-field-edge); }", true],
    [".mobile-tab-picker select:hover:not(:focus) { border-color: var(--opt-field-edge-hover); }", true],
    ['.fg :is(input[type="text"], select) { border-block-end-color: var(--opt-field-edge); }', true],
    [".fg select { border-block: 1px solid var(--opt-field-edge); }", true],
    [".fg select { border-color: var(--opt-field-border) var(--opt-field-border) var(--opt-field-edge); }", true],
    [".fg select { border-color: var(--opt-field-border) var(--opt-field-border) var(--opt-field-border-focus); }", true],
    [".fg select { border-block-color: var(--opt-field-border) var(--opt-field-border-focus); }", true],
    ["#mobile-tab-select { box-shadow: inset 0 -1px 0 var(--opt-field-edge); }", true],
    [".fg select { border-bottom-width: 2px; }", true],
    // must stay clean
    [".fg select { background-color: var(--opt-field-bg); border: 1px solid var(--opt-field-border); }", false],
    [".fg select { border-color: var(--opt-field-border-hover); }", false],
    [".fg select::picker(select) { border-bottom: 1px solid var(--opt-border); }", false],
    [".listbox-btn { border-radius: var(--opt-radius-md); }", false],
    ['.theme-name-popover input[type="text"] { border-radius: var(--opt-radius-sm); }', false],
    [".listbox-pop { border-radius: var(--opt-radius-lg) var(--opt-radius-lg) 0 0; }", false],
    ['.fg input[type="checkbox"] { border-bottom-color: var(--opt-accent); }', false],
    [".key-toggle:hover { border-radius: var(--opt-radius-sm); }", false],
    [".fg textarea { border-color: var(--opt-field-border); border-width: 1px 1px 1px 1px; }", false],
  ];
  const shapeMisjudged = SHAPE_CASES.filter(([css, want]) => (optShapeOffenders(css).length > 0) !== want);
  check(shapeMisjudged.length === 0,
    "ui-contract-tests.mjs: the value-box shape scan no longer discriminates -- misjudged: " + shapeMisjudged.map(([css, want]) => `${want ? "missed" : "false hit"}: ${css}`).join(" | "));
}

// ---- B+ follow-up (re-review M1): the key-wrap eye's hover chip must stay
// visible against the fill its field ACTUALLY paints under it, in both states
// the eye can be hovered in -- the unit hovered but unfocused (the field wears
// the unit-hover fill) and the unit holding focus (the focus frame wins, the
// field wears the focus fill). Mixing over the hover fill in both states left
// the chip at 1.113:1 (gruvbox-dark) / 1.094:1 (catppuccin-mocha) against the
// focus fill in the recessed wells, whose hover fill is darker than rest.
// The floor is FILL_SEPARATE_MIN (1.10), the project's "is this fill a plane
// of its own at all" separation floor (COMPONENTS.md §9 law 2), imported from
// the deriver rather than restated: the chip IS a fill on a fill. It is not a
// stricter number because the chip is deliberately faint -- a heavier eye
// fill was rejected on sight (options.css, the 10% ghost FILL of round 5) and
// 8% over the correct per-state base already clears 1.10 on all 15 blocks.
// Lives here, not in theme-ui-derive-tests.mjs: the gate is about what the
// HAND-WRITTEN rules do with the generated values (which rule paints the chip
// in which state, which fill the input paints then, the mix percentage), so it
// reads the chip rules, the key-wrap input rules and all 15 generated options
// blocks from the shipped CSS; the deriver never sees the chip.
// color-mix(in srgb, A p%, B) is a per-channel linear mix in sRGB space; the
// browser keeps it as float colour(srgb ...) and quantises to 8 bits at paint,
// so each channel is Math.round(A*p + B*(1-p)) on the 0-255 scale.
{
  const KEY_CHIP_MIN = FILL_SEPARATE_MIN;
  const cssNoComments = optionsCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const hand = stripGeneratedRegions(cssNoComments);
  const handRules = parseStyleRules(hand).filter((r) => !inForcedColors(r));
  const isChipSelector = (sel) => /:hover/.test(sel) && subjectAlternatives(subjectOf(sel)).some((compound) => {
    const c = classifyCompound(compound);
    return !c.pseudoElement && c.classes.includes("key-toggle");
  });
  const BG_RE = /^background(?:-color)?$/;
  // Chip side, as a category: every hand rule that paints a background on a
  // hovered eye is one of the two modelled below -- a third one would repaint
  // the chip in a state this block does not compute.
  const chipPainters = handRules.filter((r) => r.selectors.some(isChipSelector) && parseDeclarations(r.body).some((d) => BG_RE.test(d.property)));
  const CHIP_HOVER = ".key-toggle:hover";
  const CHIP_FOCUS = ".key-wrap:focus-within .key-toggle:hover";
  const painterSelectors = chipPainters.flatMap((r) => r.selectors.filter(isChipSelector));
  check(painterSelectors.length === 2 && painterSelectors.includes(CHIP_HOVER) && painterSelectors.includes(CHIP_FOCUS),
    `options.css: the eye's hover chip is painted by exactly \`${CHIP_HOVER}\` (unit hovered, not focused) and \`${CHIP_FOCUS}\` (unit focused) -- found ${JSON.stringify(painterSelectors)}`);
  // Specificity of the painters actually FOUND (not of the two constants
  // above, which could never disagree with themselves): every focus-within
  // painter must out-rank every other one, or the focused unit keeps the
  // hover-fill chip whatever the source order.
  const focusPainters = painterSelectors.filter((s) => /:focus-within/.test(s));
  const plainPainters = painterSelectors.filter((s) => !/:focus-within/.test(s));
  const underRanked = focusPainters.flatMap((f) => plainPainters
    .filter((h) => cmpSpecificity(selectorSpecificity(f), selectorSpecificity(h)) <= 0)
    .map((h) => `${f} (${selectorSpecificity(f).join(",")}) vs ${h} (${selectorSpecificity(h).join(",")})`));
  check(focusPainters.length > 0 && plainPainters.length > 0 && underRanked.length === 0,
    `options.css: the focused-unit eye chip must out-rank the plain hover chip -- ${focusPainters.length && plainPainters.length ? "not out-ranked: " + underRanked.join(" | ") : `found focus-within painters ${JSON.stringify(focusPainters)}, plain ${JSON.stringify(plainPainters)}`}`);
  const bgOf = (selector) => {
    const m = declarationValueMap(hand, selector);
    return (m.get("background") ?? m.get("background-color") ?? "").trim();
  };
  const KWH = '.fg .key-wrap:hover:not(:focus-within) :is(input[type="text"], input[type="password"]):not(:disabled)';
  const FW = '.fg .key-wrap:focus-within :is(input[type="text"], input[type="password"]):not(:disabled)';
  // Fill side, as a category too (round-2 gates/F1): the chip is only
  // computed against the fill the gate READS, so every rule that could paint
  // the key-wrap's text/password input must either BE one of the two read
  // below, or provably lose to them. Reaches that input = a subject compound
  // (after :is() expansion, no pseudo-element) that is an <input> typed
  // text/password or untyped, a key-wrap input id (options.html's, or one
  // options.js builds at run time -- see below), or a tagless, class-less
  // compound under a .key-wrap ancestor. Then:
  //   - one that names .key-wrap or a key-wrap id must be KWH or FW itself
  //     (a third, e.g. a later password-only override at the same (0,4,1),
  //     would silently repaint what the chip sits on);
  //   - a generic input rule must be strictly out-ranked by FW (0,5,1), the
  //     lower of the two (KWH is (0,6,1)), and not !important -- then it can
  //     never win while the unit is hovered or focused, whatever its source
  //     order. The typed generated hover is (0,4,1) (stage 4).
  // Runs over the whole file (generated fills included), so a composer that
  // starts emitting a stronger input fill is caught the same way.
  const STATIC_KEY_WRAP_IDS = new Set([...optionsHtml.matchAll(/<span class="key-wrap">\s*<input\b([^>]*)>/g)]
    .map((m) => (/\bid="([^"]+)"/.exec(m[1]) || [])[1]).filter(Boolean));
  check(STATIC_KEY_WRAP_IDS.size >= 19 && STATIC_KEY_WRAP_IDS.has("opt-pinboard-token") && STATIC_KEY_WRAP_IDS.has("dict-anki-key"),
    `ui-contract-tests.mjs: the options.html key-wrap input harvest drifted -- got ${STATIC_KEY_WRAP_IDS.size} ids`);
  // The key-wraps options.js builds at run time (round 3, K): the Send-to
  // cards' secret fields (notion-token, github-token, webhook-url,
  // webhook-token today) are not in options.html, so an id-only fill rule on
  // one of them used to pass. Harvested by RUNNING the builder,
  // renderExportTargets(), over the export-targets.js registry on a minimal
  // DOM stub and reading the ids of the inputs it put inside a .key-wrap: the
  // builder decides which settings get a key-wrap and how their ids are
  // formed, so neither is restated here. Fail-closed: a builder this stub can
  // no longer run (renamed, moved, a new DOM call) stops the test instead of
  // silently harvesting nothing.
  const RUNTIME_KEY_WRAP_IDS = (() => {
    const head = "  function renderExportTargets(exportTargets) {";
    const start = optionsJs.indexOf(head);
    const end = start < 0 ? -1 : optionsJs.indexOf("\n  }\n", start);
    if (start < 0 || end < 0 || optionsJs.indexOf(head, start + 1) >= 0) {
      check(false, "ui-contract-tests.mjs: cannot find exactly one `function renderExportTargets(exportTargets)` in options.js to harvest the runtime key-wrap ids from");
      return new Set();
    }
    class StubEl {
      constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.dataset = {}; this.className = ""; this.id = ""; this.attrs = {}; }
      get classList() { return { add: (...c) => { this.className = [this.className, ...c].join(" ").trim(); } }; }
      appendChild(c) { this.children.push(c); return c; }
      setAttribute(k, v) { this.attrs[k] = String(v); }
      removeAttribute(k) { delete this.attrs[k]; }
      addEventListener() {}
      querySelector() { return null; }
      querySelectorAll() { return []; }
      set innerHTML(_) { this.children = []; }
    }
    const host = new StubEl("div");
    try {
      runInNewContext(`${read("export-targets.js")}\n${optionsJs.slice(start, end + 4)}\nrenderExportTargets({});`, {
        document: { createElement: (tag) => new StubEl(tag) }, window: {},
        $id: (id) => (id === "export-targets" ? host : null), t: (key) => key, deobfuscateKey: (v) => v,
        pbpAccRestore() {}, setupSecretToggles() {}, bindAutoSave() {},
      });
    } catch (e) {
      check(false, `ui-contract-tests.mjs: running options.js renderExportTargets() on the DOM stub failed (${e.message}) -- extend the stub rather than dropping the runtime key-wrap harvest`);
      return new Set();
    }
    const ids = new Set();
    const walk = (node) => {
      const isWrap = node.className.split(/\s+/).includes("key-wrap");
      for (const child of node.children) {
        if (isWrap && child.tagName === "INPUT" && child.id) ids.add(child.id);
        walk(child);
      }
    };
    walk(host);
    return ids;
  })();
  // Drift pin: the harvest must return exactly the key-wraps the builder
  // makes today, one per secret setting in the registry (Notion and GitHub
  // tokens, the webhook's capability URL and token). A harvest that shrinks
  // -- a stub gap that loses a card, a builder change that stops wrapping a
  // secret -- would otherwise leave that field's id-only fill rules unchecked.
  const EXPECTED_RUNTIME_KEY_WRAP_IDS = ["github-token", "notion-token", "webhook-token", "webhook-url"];
  const runtimeKeyWrapIds = [...RUNTIME_KEY_WRAP_IDS].sort();
  check(JSON.stringify(runtimeKeyWrapIds) === JSON.stringify(EXPECTED_RUNTIME_KEY_WRAP_IDS),
    `ui-contract-tests.mjs: the runtime (renderExportTargets) key-wrap input harvest drifted -- got ${JSON.stringify(runtimeKeyWrapIds)}, expected ${JSON.stringify(EXPECTED_RUNTIME_KEY_WRAP_IDS)}. ` +
    "If export-targets.js's registry (or renderExportTargets() in options.js) legitimately changed which settings get a key-wrap, " +
    "set EXPECTED_RUNTIME_KEY_WRAP_IDS to the ids listed under `got`; otherwise fix the harvest's DOM stub so it reaches every card again.");
  const KEY_WRAP_INPUT_IDS = new Set([...STATIC_KEY_WRAP_IDS, ...RUNTIME_KEY_WRAP_IDS]);
  const reachesKeyWrapInput = (sel) => {
    const subject = subjectOf(sel);
    const underKeyWrap = /\.key-wrap(?![\w-])/.test(sel.slice(0, sel.length - subject.length));
    return subjectAlternatives(subject).some((compound) => {
      const c = classifyCompound(compound);
      if (c.pseudoElement) return false;
      if (c.ids.length) return c.ids.some((id) => KEY_WRAP_INPUT_IDS.has(id));
      if (c.tag === "input") return c.type === null || c.type === "text" || c.type === "password";
      return c.tag === null && c.classes.length === 0 && underKeyWrap;
    });
  };
  const FW_SPEC = selectorSpecificity(FW);
  const keyWrapFillOffenders = (css) => {
    const out = [];
    const modelled = new Set();
    for (const rule of parseStyleRules(css)) {
      if (inForcedColors(rule)) continue;
      const paints = parseDeclarations(rule.body).filter((d) => BG_RE.test(d.property));
      if (!paints.length) continue;
      for (const sel of rule.selectors.filter(reachesKeyWrapInput)) {
        if (sel === KWH || sel === FW) { modelled.add(sel); continue; }
        const named = /\.key-wrap(?![\w-])/.test(sel) || subjectAlternatives(subjectOf(sel)).some((c) => classifyCompound(c).ids.some((id) => KEY_WRAP_INPUT_IDS.has(id)));
        const decl = paints.map((d) => `${d.property}: ${d.value}${d.important ? " !important" : ""}`).join("; ");
        if (named) out.push(`${sel} { ${decl} } -- paints the key-wrap input's fill outside the two rules the eye-chip gate reads`);
        else if (paints.some((d) => d.important) || cmpSpecificity(selectorSpecificity(sel), FW_SPEC) >= 0) {
          out.push(`${sel} (${selectorSpecificity(sel).join(",")}) { ${decl} } -- can out-rank the key-wrap fill rules (${FW_SPEC.join(",")}), so the chip may sit on a fill the gate never reads`);
        }
      }
    }
    for (const sel of [KWH, FW]) if (!modelled.has(sel)) out.push(`${sel} -- missing: the eye-chip gate reads the field fill from it`);
    return out;
  };
  const shippedFill = keyWrapFillOffenders(cssNoComments);
  check(shippedFill.length === 0, "options.css: the key-wrap input's hover/focus fill is painted by a rule the eye-chip gate does not read: " + shippedFill.join(" | "));
  // Discrimination: [rule appended to the shipped CSS, must be caught].
  const FILL_CASES = [
    // round-2 gates/F1's counterexample: same specificity as FW ((0,5,1)
    // since stage 4), later in source.
    ['.fg .key-wrap:focus-within input[type="password"]:not(:disabled) { background-color: var(--opt-field-bg-hover); }', true],
    ["#opt-pinboard-token:focus { background-color: var(--opt-field-bg); }", true],
    [".key-wrap:hover input { background: var(--opt-field-bg); }", true],
    [".key-wrap:focus-within :not(.key-toggle) { background: var(--opt-field-bg); }", true],
    ['html[data-theme] .fg input[type="password"]:focus:not(:disabled) { background-color: var(--opt-field-bg); }', true],
    ['.fg input[type="password"]:focus { background-color: var(--opt-field-bg) !important; }', true],
    // round-3 K: id-only rules on key-wraps options.js builds at run time
    // (Send-to secrets), which the options.html harvest alone never saw.
    ["#notion-token:focus { background-color: var(--opt-field-bg-hover); }", true],
    ["#webhook-url:hover { background: var(--opt-field-bg); }", true],
    // must stay clean
    ['.fg input[type="text"]:focus { background-color: var(--opt-field-bg-focus); }', false],
    // stage 4: the typed generated hover (0,4,1) stays under FW (0,5,1)
    ['.fg input[type="password"]:hover:not(:focus, :disabled) { background-color: var(--opt-field-bg-hover); }', false],
    ['html[data-theme] .fg input[type="password"]:focus { background-color: var(--opt-field-bg); }', false],
    [".key-wrap:focus-within .key-toggle:hover { background: color-mix(in srgb, var(--opt-field-fg) 8%, var(--opt-field-bg-focus)); }", false],
    [".fg .key-wrap input { padding-right: 32px; }", false],
    // a builder-made Send-to field OUTSIDE a key-wrap: the runtime harvest
    // reads the key-wrap, not every input the builder makes
    ["#notion-parent:focus { background-color: var(--opt-field-bg-hover); }", false],
    ['.options-search input[type="search"]:hover { background: var(--opt-input-bg); }', false],
    ['.fg input[type="checkbox"]:focus { background: var(--opt-accent); }', false],
    ["@media (forced-colors: active) { .fg .key-wrap:focus-within input { background: Canvas; } }", false],
  ];
  // Judged by what the synthetic rule ADDS, so a shipped offender reported
  // above does not also turn every clean case into a false hit.
  const fillMisjudged = FILL_CASES.filter(([css, want]) =>
    keyWrapFillOffenders(`${cssNoComments}\n${css}`).some((o) => !shippedFill.includes(o)) !== want);
  check(fillMisjudged.length === 0,
    "ui-contract-tests.mjs: the eye-chip fill category no longer discriminates -- misjudged: " + fillMisjudged.map(([css, want]) => `${want ? "missed" : "false hit"}: ${css}`).join(" | "));
  // A missing focus chip falls back (cascade) to the plain hover chip -- the
  // exact M1 shape; the base check below catches its removal. The chip as
  // painted (its own mix base), against the fill the field really paints
  // beneath it in this state, on all 15 generated options blocks (14
  // html[data-theme] + the default :root, which inherits every role it does
  // not re-declare from the hand :root) -- the shared chipOverFillAcrossBlocks.
  // Stage 4 (spec 2026-09-30 §2.2, F10): a small button's hover fill inside a
  // value box is the field's own text ink, --opt-field-fg, at 8% over the fill
  // it sits on (popup's eye and library's steppers follow).
  const eyeChip = chipOverFillAcrossBlocks(optionsCss, "opt", [
    { name: "unit hovered", chip: bgOf(CHIP_HOVER), fill: bgOf(KWH), pct: 0.08 },
    { name: "unit focused", chip: bgOf(CHIP_FOCUS) || bgOf(CHIP_HOVER), fill: bgOf(FW), pct: 0.08 },
  ], { file: "options.css", what: "the eye's hover chip" });
  for (const failure of eyeChip.failures) check(false, failure);
  check(eyeChip.measured === 30, `ui-contract-tests.mjs: the eye chip gate measured ${eyeChip.measured} (block, state) pairs, expected 30`);
  if (process.env.PBP_KEY_CHIP_MIN === "1") console.log(`[ui-contract] eye chip: lowest ${eyeChip.lowest.r.toFixed(3)}:1 (${eyeChip.lowest.where}) over ${eyeChip.measured} (block, state) pairs; floor ${KEY_CHIP_MIN}`);
  gateDump(`[gate] chip options measured=${eyeChip.measured} lowest=${eyeChip.lowest.r.toFixed(3)} (${eyeChip.lowest.where}) ratios=${ratioHash(eyeChip.ratios)}`);
}

// ---- Retired field roles (stage 4 spec docs/superpowers/specs/2026-09-30-
// ui-fields-stage4-design.md §1.4 item 2, §2.4): the B+ bottom edge is gone.
// field-edge / field-edge-hover must not come back through any door -- the
// deriver's role registries, a composer map on any surface, a pilot's ui.*
// block (validate-contracts stopped blocking the two names the moment they
// left UI_DERIVED_OUTPUT_ROLES, so a pilot writing one would ship an orphan
// custom property), or any declaration in the three surface stylesheets --
// and FIELD_EDGE_HOVER_FG_MIX must not be re-exported. Declarations are read
// through the CSS parser, so a comment that mentions the old names (or a
// history note) is not a hit, and a consumer anywhere -- generated region,
// hand-written region, @media / @supports -- is.
{
  const RETIRED_FIELD_ROLES = ["field-edge", "field-edge-hover"];
  const RETIRED_TOKEN_RE = /--[a-z]+-field-edge/;
  const retiredDecls = (css) => parseStyleRules(css).flatMap((rule) =>
    parseDeclarations(rule.body)
      .filter((d) => RETIRED_TOKEN_RE.test(d.property) || RETIRED_TOKEN_RE.test(d.value))
      .map((d) => `${rule.selectorText} { ${d.property}: ${d.value} }`));
  // The scan must be able to fail (negative controls): a consumer, a
  // definition and an @media-nested use are all caught; a comment is not.
  check(retiredDecls(".fg textarea { border-bottom-color: var(--opt-field-edge); }").length === 1 &&
    retiredDecls(':root { --lib-field-edge-hover: #000000; }').length === 1 &&
    retiredDecls("@media (min-width: 1px) { .listbox-btn:hover { border-bottom-color: var(--pp-field-edge-hover); } }").length === 1 &&
    retiredDecls("/* --opt-field-edge retired */ .x { color: var(--opt-field-fg); }").length === 0,
    "ui-contract-tests.mjs: the retired field-edge scan no longer tells a consumer / definition from a comment");
  for (const [file, css] of [["popup.css", popupCss], ["options.css", optionsCss], ["library.css", libraryCss]]) {
    const hits = retiredDecls(css);
    check(hits.length === 0, `${file}: declares or consumes a retired field-edge token (the B+ bottom edge is gone, spec 2026-09-30 §2.2): ${hits.join(" | ")}`);
  }
  for (const r of RETIRED_FIELD_ROLES) {
    check(!FIELD_ROLES.includes(r), `_ui-derive.mjs FIELD_ROLES lists the retired role ${r}`);
    for (const [surface, roles] of Object.entries(UI_DERIVED_OUTPUT_ROLES)) {
      check(!roles.includes(r), `_ui-derive.mjs UI_DERIVED_OUTPUT_ROLES.${surface} lists the retired role ${r}`);
    }
  }
  check(!("FIELD_EDGE_HOVER_FG_MIX" in uiDerive), "_ui-derive.mjs exports FIELD_EDGE_HOVER_FG_MIX again (retired with the bottom edge)");
  let composed = 0;
  for (const entry of POPUP_THEME_MAP) {
    const tk = JSON.parse(read(`docs/theme-surface/pilots/${entry.pilot}.tokens.json`));
    const maps = {
      options: composeOptionsThemeMap(tk, entry.mode, entry.useDarkMode).map,
      popup: composePopupThemeMap(tk, entry.mode, entry.useDarkMode),
      library: composeLibraryThemeMap(tk, entry.mode, entry.useDarkMode).map,
    };
    for (const [surface, map] of Object.entries(maps)) {
      composed++;
      const stale = Object.keys(map).filter((k) => RETIRED_FIELD_ROLES.includes(k));
      check(stale.length === 0, `${surface} composer map for ${entry.id} carries retired role(s) ${stale.join(", ")}`);
    }
  }
  check(composed === 42, `ui-contract-tests.mjs: the retired-role composer walk visited ${composed} (surface, theme) maps, expected 42 (3 x 14)`);
  const pilotDir = resolve(root, "docs/theme-surface/pilots");
  const pilotFiles = readdirSync(pilotDir).filter((f) => f.endsWith(".tokens.json"));
  check(pilotFiles.length >= 13, `ui-contract-tests.mjs: found only ${pilotFiles.length} pilot files under docs/theme-surface/pilots`);
  for (const file of pilotFiles) {
    const pilot = JSON.parse(readFileSync(resolve(pilotDir, file), "utf8"));
    for (const [surface, modes] of Object.entries(pilot.ui ?? {})) {
      for (const [mode, roles] of Object.entries(modes ?? {})) {
        if (!roles || typeof roles !== "object") continue;
        for (const role of Object.keys(roles)) {
          check(!RETIRED_FIELD_ROLES.includes(role), `${file}: ui.${surface}.${mode}.${role} sets a retired field role (it would ship as an orphan custom property)`);
        }
      }
    }
  }
}

// ---- Stage 4 Task 4 (spec docs/superpowers/specs/2026-09-30-ui-fields-
// stage4-design.md §2.1 / §2.2 / §6 item 10), options scope: the value boxes'
// state exclusions, their chevron and their forced-colours focus. Read through
// the CSS parser over the whole options.css (comments blanked, line numbers
// kept), so a comment is not a hit and a generated rule counts like a hand one.
{
  const css = optionsCss.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));
  const forced = inForcedColors;
  // The top-level :not(...) arguments of one compound, e.g.
  // `input[type="text"]:hover:not(:focus, :disabled)` -> [":focus", ":disabled"].
  const notArgs = (compound) => {
    const out = [];
    for (let i = 0; i < compound.length; i += 1) {
      if (compound[i] === "[") { i = closeOfBracket(compound, i); continue; }
      if (compound.startsWith(":not(", i)) {
        const close = closeOfBracket(compound, i + 4);
        out.push(...splitSelectorList(compound.slice(i + 5, close)));
        i = close;
      } else if (compound[i] === "(") i = closeOfBracket(compound, i);
    }
    return out;
  };
  // Compounds of a complex selector, subject last (combinators split them).
  const compoundsOf = (sel) => {
    const parts = [];
    let cur = "";
    for (let i = 0; i < sel.length; i += 1) {
      const ch = sel[i];
      if (ch === "(" || ch === "[") { const close = closeOfBracket(sel, i); cur += sel.slice(i, close + 1); i = close; continue; }
      if (ch === " " || ch === ">" || ch === "+" || ch === "~") { if (cur.trim()) parts.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  };
  // The focus trigger of a value box (spec §2.1 table): :focus-visible for
  // the listbox button, the narrow-screen tab picker and the sidebar search
  // box; :focus for the .fg text / secret / number / textarea / select.
  const triggerOf = (sel) => {
    const subject = subjectOf(sel);
    const prefix = sel.slice(0, sel.length - subject.length);
    const visible = subjectAlternatives(subject).some((compound) => {
      const c = classifyCompound(compound);
      // a listbox button by id: listbox.js names it `<select id>-btn`
      const listboxId = c.ids.some((id) => id.endsWith("-btn") && OPTIONS_VALUE_BOX_IDS.selectIds.has(id.slice(0, -4)));
      return c.classes.includes("listbox-btn") || listboxId || (c.tag === "input" && c.type === "search") ||
        c.ids.includes("options-search-input") || c.ids.includes("mobile-tab-select") ||
        (c.tag === "select" && /\.mobile-tab-picker(?![\w-])/.test(prefix));
    });
    return visible ? ":focus-visible" : ":focus";
  };

  // (1) Hover exclusions (spec §2.1): every hover rule that paints a value
  // box's fill or frame excludes the box's own focus trigger and :disabled
  // -- on the box itself, or, for a fused unit hovered on its shell (the
  // key-wrap), :focus-within on the shell and :disabled on the input.
  const PAINT_RE = /^(?:background(?:-color)?|border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-color)?)$/;
  const hoverExclusionOffenders = (text) => {
    const out = [];
    for (const r of parseStyleRules(text)) {
      if (forced(r) || !parseDeclarations(r.body).some((d) => PAINT_RE.test(d.property))) continue;
      for (const sel of r.selectors.filter((x) => /:hover\b/.test(x) && isValueBoxSelector(x))) {
        const parts = compoundsOf(sel);
        const subject = parts[parts.length - 1];
        const own = notArgs(subject);
        if (/:hover\b/.test(subject)) {
          const want = [triggerOf(sel), ":disabled"];
          if (!want.every((w) => own.includes(w))) out.push(`${sel} -- a value box's hover must exclude ${want.join(" and ")} (spec §2.1)`);
        } else {
          const shell = parts.slice(0, -1).find((p) => /:hover\b/.test(p)) || "";
          if (!notArgs(shell).includes(":focus-within") || !own.includes(":disabled")) {
            out.push(`${sel} -- a fused unit's shell hover must exclude the shell's :focus-within and the input's :disabled (spec §2.1)`);
          }
        }
      }
    }
    return out;
  };
  const hoverBad = hoverExclusionOffenders(css);
  check(hoverBad.length === 0, "options.css: " + hoverBad.join(" | "));
  const HOVER_CASES = [
    ['.fg input[type="text"]:hover:not(:focus) { background-color: var(--opt-field-bg-hover); }', true],
    [".listbox-btn:hover:not(:focus, :disabled) { border-color: var(--opt-field-border-hover); }", true],
    [".mobile-tab-picker select:hover { background-color: var(--opt-field-bg-hover); }", true],
    ['.fg .key-wrap:hover :is(input[type="password"]):not(:disabled) { background-color: var(--opt-field-bg-hover); }', true],
    ['.fg .key-wrap:hover:not(:focus-within) :is(input[type="password"]) { border-color: var(--opt-field-border-hover); }', true],
    ["#dict-anki-deck:hover { background-color: var(--opt-field-bg-hover); }", true],
    ["#opt-lang-btn:hover:not(:focus, :disabled) { background: var(--opt-field-bg-hover); }", true],
    // fix round 1: `forced-colors: none` is the NORMAL rendering, not a
    // system-colour exemption; an untyped input is a value box too
    ["@media (forced-colors: none) { .listbox-btn:hover { background: var(--opt-field-bg-hover); } }", true],
    [".fg input:hover:not(:disabled) { background-color: var(--opt-field-bg-hover); }", true],
    // must stay clean
    [".fg textarea:hover:not(:focus):not(:disabled) { background-color: var(--opt-field-bg-hover); }", false],
    [".listbox-btn:hover:not(:focus-visible, :disabled) { background: var(--opt-field-bg-hover); }", false],
    ["#opt-lang-btn:hover:not(:focus-visible, :disabled) { background: var(--opt-field-bg-hover); }", false],
    ['.fg input[type="text"]:hover { color: var(--opt-field-fg); }', false],
    [".key-toggle:hover { background: color-mix(in srgb, var(--opt-field-fg) 8%, var(--opt-field-bg-hover)); }", false],
    ["@media (forced-colors: active) { .listbox-btn:hover { border-color: Highlight; } }", false],
  ];
  const hoverMisjudged = HOVER_CASES.filter(([text, want]) => (hoverExclusionOffenders(text).length > 0) !== want);
  check(hoverMisjudged.length === 0,
    "ui-contract-tests.mjs: the value-box hover-exclusion scan no longer discriminates -- misjudged: " + hoverMisjudged.map(([text, want]) => `${want ? "missed" : "false hit"}: ${text}`).join(" | "));

  // (2) The chevron (spec §2.2): a value box never carries a colour literal
  // inside a url() -- the %23888 / %23aaa data URIs this replaced sailed past
  // countBareHex (no bare "#") and ignored every theme -- and each native
  // select's drawn chevron is the per-theme --opt-field-chevron.
  const urlColourOffenders = (text) => valueBoxUrlColourOffenders(text, isValueBoxSelector);
  const urlBad = urlColourOffenders(css);
  check(urlBad.length === 0,
    "options.css: a value box paints a url() carrying its own colour literal (%23<hex> / #<hex> / rgb() / hsl()) -- use the per-theme var(--opt-field-chevron) (spec 2026-09-30 §2.2): " + urlBad.join(" | "));
  const URL_CASES = [
    [".fg select { background-image: url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><path d='M3 4.5 6 7.5 9 4.5' stroke='%23888'/></svg>\"); }", true],
    ["html[data-theme=\"nord-night\"] .mobile-tab-picker select { background-image: url(\"data:image/svg+xml,%3Csvg stroke='%23aaa'%3E%3C/svg%3E\"); }", true],
    [".listbox-btn { background: var(--opt-field-bg) url(\"data:image/svg+xml,%3Csvg stroke='#888'%3E%3C/svg%3E\") no-repeat; }", true],
    ["#mobile-tab-select { mask-image: url('data:image/svg+xml,<svg stroke=\"rgb(136, 136, 136)\"/>'); }", true],
    // must stay clean
    [".fg select { background-image: var(--opt-field-chevron); }", false],
    [".hint-warn::before { background-image: url(\"data:image/svg+xml,%3Csvg stroke='%23c0840a'%3E%3C/svg%3E\"); }", false],
    [".fg select::picker-icon { background-image: url(\"data:image/svg+xml,%3Csvg stroke='%23888'%3E%3C/svg%3E\"); }", false],
  ];
  const urlMisjudged = URL_CASES.filter(([text, want]) => (urlColourOffenders(text).length > 0) !== want);
  check(urlMisjudged.length === 0,
    "ui-contract-tests.mjs: the value-box url() colour scan no longer discriminates -- misjudged: " + urlMisjudged.map(([text, want]) => `${want ? "missed" : "false hit"}: ${text}`).join(" | "));
  const chevrons = parseStyleRules(css).filter((r) => !forced(r)).flatMap((r) => r.selectors.filter(isNativeSelectSelector)
    .flatMap((sel) => parseDeclarations(r.body).filter((d) => /^background(?:-image)?$/.test(d.property)).map((d) => ({ sel, value: d.value }))));
  const offChevron = chevrons.filter(({ value }) => value !== "var(--opt-field-chevron)");
  check(offChevron.length === 0 && ['.fg select', ".mobile-tab-picker select"].every((sel) => chevrons.some((c) => c.sel === sel)),
    "options.css: every native select's drawn chevron must be `background-image: var(--opt-field-chevron)` (.fg select and .mobile-tab-picker select at least; spec 2026-09-30 §3.1) -- found " + JSON.stringify(chevrons));

  // (3) Forced colours (spec §6 item 10): every value-box kind gets a
  // 1px solid Highlight outline on :focus-visible inside
  // @media (forced-colors: active) -- §7.3's scan above holds its shape --
  // and no outline-suppressing focus rule that applies under forced colours
  // out-ranks it for the same kind. Fix round 1 (review finding 1) widened
  // both halves to the value-box model used everywhere else in this file:
  //   - a subject is mapped to kinds the way isValueBoxCompound sees it: an
  //     options.html value-box id through its element / type (a `-btn` id is
  //     the listbox button), an untyped `input` to every input kind it can
  //     match there (the search box under .options-search, else the .fg
  //     text / password / number), a tag-, class- and id-less compound
  //     (`.fg :focus`) to every kind under its prefix;
  //   - coverage counts only `forced-colors: active` contexts, never
  //     `forced-colors: none`;
  //   - a suppressor is any rule that applies with forced colours on --
  //     outside every forced-colors context OR inside `forced-colors:
  //     active` itself, but not inside `forced-colors: none` -- and can apply
  //     while the box holds focus: a focus rule, and since Task 7 fix round 1
  //     also a hover or stateless one (suppressorExcludedBy);
  //   - "out-ranks" follows the cascade: an !important suppressor beats a
  //     normal outline outright; otherwise (both or neither important)
  //     strictly higher specificity, or equal and later in the file.
  const VALUE_BOX_ID_KINDS = (() => {
    const kinds = new Map();
    for (const m of optionsHtml.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
      const tag = m[1].toLowerCase(), attrs = m[2];
      const id = (/\bid="([^"]+)"/.exec(attrs) || [])[1];
      if (!id || !OPTIONS_VALUE_BOX_IDS.ids.has(id)) continue;
      if (tag === "textarea") kinds.set(id, "fg textarea");
      else if (tag === "select") {
        kinds.set(id, id === "mobile-tab-select" ? "picker select" : "fg select");
        if (OPTIONS_VALUE_BOX_IDS.ids.has(`${id}-btn`)) kinds.set(`${id}-btn`, "listbox-btn");
      } else {
        const type = ((/\btype="([^"]+)"/.exec(attrs) || [])[1] || "text").toLowerCase();
        kinds.set(id, type === "search" ? "search" : `fg ${type}`);
      }
    }
    return kinds;
  })();
  check(VALUE_BOX_ID_KINDS.get("opt-pinboard-token") === "fg password" && VALUE_BOX_ID_KINDS.get("options-search-input") === "search" &&
    VALUE_BOX_ID_KINDS.get("mobile-tab-select") === "picker select" && VALUE_BOX_ID_KINDS.get("opt-custom-css") === "fg textarea" &&
    VALUE_BOX_ID_KINDS.get("opt-lang-btn") === "listbox-btn" && VALUE_BOX_ID_KINDS.size === OPTIONS_VALUE_BOX_IDS.ids.size,
    `ui-contract-tests.mjs: the options.html value-box id -> kind map drifted (${VALUE_BOX_ID_KINDS.size} kinds for ${OPTIONS_VALUE_BOX_IDS.ids.size} ids)`);
  const FORCED_KINDS = ["fg text", "fg password", "fg number", "fg select", "fg textarea", "picker select", "search", "listbox-btn"];
  const kindsOf = (sel) => {
    const subject = subjectOf(sel);
    const prefix = sel.slice(0, sel.length - subject.length);
    const underPicker = /\.mobile-tab-picker(?![\w-])/.test(prefix), underSearch = /\.options-search(?![\w-])/.test(prefix);
    return [...new Set(subjectAlternatives(subject).flatMap((compound) => {
      const c = classifyCompound(compound);
      if (c.pseudoElement) return [];
      const byId = c.ids.map((id) => VALUE_BOX_ID_KINDS.get(id)).filter(Boolean);
      if (byId.length) return byId;
      if (c.ids.length) return [];
      if (c.classes.includes("listbox-btn")) return ["listbox-btn"];
      if (c.tag === "select") return [underPicker ? "picker select" : "fg select"];
      if (c.tag === "textarea") return ["fg textarea"];
      if (c.tag === "input" && c.type === "search") return ["search"];
      if (c.tag === "input" && ["text", "password", "number"].includes(c.type)) return [`fg ${c.type}`];
      if (c.tag === "input" && c.type === null) return underSearch ? ["search"] : ["fg text", "fg password", "fg number"];
      if ((c.tag === null || c.tag === "*") && !c.classes.length && c.type === null) {
        return underPicker ? ["picker select"] : underSearch ? ["search"] : FORCED_KINDS;
      }
      return [];
    }))];
  };
  check(["#opt-pinboard-token:focus", "html[data-theme] .fg input:focus", ".options-search input:focus-visible", ".fg :focus", ".pick > input[type=\"radio\"]:focus"]
    .map((sel) => kindsOf(sel).join("+")).join(" | ") === "fg password | fg text+fg password+fg number | search | " + FORCED_KINDS.join("+") + " | ",
    "ui-contract-tests.mjs: kindsOf no longer maps ids / untyped inputs / wildcard subjects onto the value-box kinds they can match");
  // The shared forcedOutlineReport over value-box KINDS (kindsOf): an outline
  // counts on its :focus-visible selectors, and every kind must be reached by
  // one. Suppressors: see the helper (Task 7 fix round 1 widened them from
  // focus rules to every rule that can apply while the box holds focus).
  const forcedFocusReport = (text) => forcedOutlineReport(text, {
    targetsOf: kindsOf,
    outlineSelector: (sel) => /:focus-visible\b/.test(sel),
    requireOffset: false,
    required: FORCED_KINDS.map((k) => ({ label: k, target: k })),
  });
  const shipped = forcedFocusReport(css);
  check(shipped.missing.length === 0,
    `options.css: no forced-colors :focus-visible outline (1px solid Highlight) covers the value box kind(s) ${shipped.missing.join(", ")} -- spec 2026-09-30 §6 item 10`);
  check(shipped.outranked.length === 0,
    "options.css: an outline-suppressing rule that can apply while the box holds focus out-ranks the forced-colors value-box outline, so High Contrast shows no focus: " + shipped.outranked.join(" | "));
  const FORCED_CASES = [
    // appended to the shipped file: [rule, must be caught]
    ['html[data-theme] .fg input[type="text"]:focus { outline: none; }', true],
    [".mobile-tab-picker select:focus-visible { outline: none; }", true],
    ['.options-search input[type="search"]:focus-visible { outline-style: none; }', true],
    // fix round 1 (review finding 1): an id-addressed value box (options.html
    // names #opt-pinboard-token a password input); an untyped input, in .fg
    // and under .options-search; an !important suppressor below the
    // Highlight rule's specificity; a later suppressor INSIDE forced-colors
    // active (it applies exactly when the outline should)
    ["#opt-pinboard-token:focus { outline: none; }", true],
    ["#mobile-tab-select:focus-visible { outline-width: 0; }", true],
    ["html[data-theme] .fg input:focus { outline: none; }", true],
    ["html[data-theme] .options-search input:focus-visible { outline: none; }", true],
    [".fg textarea:focus { outline: none !important; }", true],
    ["@media (forced-colors: active) { .mobile-tab-picker select:focus-visible { outline: none; } }", true],
    [".fg :focus { outline: none !important; }", true],
    // Task 7 fix round 1: a hover rule applies while the pointer rests on a
    // keyboard-focused box, a stateless one always; at equal specificity and
    // later in the file, or with an id, either erases the Highlight edge
    [".listbox-btn:hover { outline: none; }", true],
    ["#opt-pinboard-token:hover { outline: none; }", true],
    [".fg textarea { outline: none !important; }", true],
    // Task 7 fix round 2: :not(<trigger>) on an ancestor excludes nothing
    [".fg:not(:focus) textarea:focus { outline: none !important; }", true],
    [".fg:not(:focus-visible) .key-wrap input:focus { outline: none !important; }", true],
    // final fix wave: a :not(:focus-within) on a SIBLING compound (the label
    // beside the textarea) excludes nothing -- only an ancestor contains focus
    [".fg label:not(:focus-within) ~ textarea:focus { outline: none !important; }", true],
    [".fg > label:not(:focus-within) + textarea:focus { outline: none !important; }", true],
    // must stay clean: an ancestor stays an ancestor whatever sits below it
    [".fg:not(:focus-within) label ~ textarea:focus { outline: none !important; }", false],
    // must stay clean: `forced-colors: none` never applies with forced colours on
    ['@media (forced-colors: none) { html[data-theme] .fg input[type="text"]:focus { outline: none !important; } }', false],
    [".fg textarea:focus { outline: 0; }", false],
    [".fg textarea { outline: none; }", false],
    [".listbox-btn:not(:focus-visible) { outline: none !important; }", false],
    [".fg input[type=\"text\"]:disabled { outline: none !important; }", false],
  ];
  const forcedMisjudged = FORCED_CASES.filter(([rule, want]) => (forcedFocusReport(`${css}\n${rule}`).outranked.length > shipped.outranked.length) !== want);
  const onlyText = forcedFocusReport('@media (forced-colors: active) { .fg input[type="text"]:focus-visible { outline: 1px solid Highlight; outline-offset: 2px; } }');
  // A Highlight outline inside `forced-colors: none` covers nothing (fix round 1).
  const onlyNone = forcedFocusReport('@media (forced-colors: none) { .fg input[type="text"]:focus-visible { outline: 1px solid Highlight; outline-offset: 2px; } }');
  // !important on both sides falls back to specificity; only an important
  // suppressor over a normal outline wins regardless (fix round 1).
  // The outline rule (0,2,2) out-specifies the suppressor (0,2,1) here.
  const FORCED_IMPORTANT = "@media (forced-colors: active) { html .fg textarea:focus-visible { outline: 1px solid Highlight IMP; outline-offset: 2px; } }\n.fg textarea:focus { outline: none !important; }";
  const impBoth = forcedFocusReport(FORCED_IMPORTANT.replace(" IMP", " !important"));
  const impSupOnly = forcedFocusReport(FORCED_IMPORTANT.replace(" IMP", ""));
  check(forcedMisjudged.length === 0 && onlyText.missing.length === FORCED_KINDS.length - 1 && !onlyText.missing.includes("fg text") &&
    onlyNone.missing.length === FORCED_KINDS.length && impBoth.outranked.length === 0 && impSupOnly.outranked.length === 1,
    "ui-contract-tests.mjs: the forced-colors value-box focus scan no longer discriminates -- misjudged: " + forcedMisjudged.map(([rule, want]) => `${want ? "missed" : "false hit"}: ${rule}`).join(" | ") +
    ` (coverage probe missing=${JSON.stringify(onlyText.missing)}; forced-colors:none probe missing ${onlyNone.missing.length}/${FORCED_KINDS.length}; !important probes both=${impBoth.outranked.length} (want 0) suppressor-only=${impSupOnly.outranked.length} (want 1))`);
  gateDump(`[gate] forced options missing=${JSON.stringify(shipped.missing)} outranked=${JSON.stringify(shipped.outranked)} none-missing=${onlyNone.missing.length} text-only-missing=${onlyText.missing.length} imp-both=${impBoth.outranked.length} imp-sup=${impSupOnly.outranked.length}`);
  for (const [rule] of FORCED_CASES) gateDump(`[gate] forced options case ${forcedFocusReport(`${css}\n${rule}`).outranked.length > shipped.outranked.length ? "CAUGHT" : "clean "} ${rule}`);
}

// ---- Stage 4 Task 6 (spec §2.2 / §2.3 F10): popup's eye hover chip, the
// same gate as options' key-wrap eye above. The chip must stay a visible
// plane (>= FILL_SEPARATE_MIN, imported from the deriver) against the fill
// the token field ACTUALLY paints beneath it in each state the eye can be
// hovered in: the shell hovered but not focused (the field wears
// FIELD_TARGETS.pp pp-secret's hover fill) and the shell holding focus (its
// focus fill). Both fills are read from the GENERATED rules of that registry
// entry, and the hand-region value-box scan above guarantees no hand rule
// repaints the field, so the fill read here is the fill that ships. Before
// stage 4 the chip mixed fg 8% over --pp-input-bg in both states;
// fg 8% over the hover fill would be 1.098:1 on solarized-light, which is
// why the ink is --pp-field-fg (lowest 1.119:1, spec §2.2).
{
  const hand = stripGeneratedRegions(popupCss).replace(/\/\*[\s\S]*?\*\//g, "");
  const gen = popupCss.slice(popupCss.indexOf("/* @generated:ui-components start (popup) */"), popupCss.indexOf("/* @generated:ui-components end (popup) */"));
  const secret = FIELD_TARGETS.pp.filter((t) => selectorListOf(t.rest).some((sel) => /\.secret-field\b/.test(sel)));
  check(secret.length === 1, `ui-components.mjs: expected exactly one FIELD_TARGETS.pp entry painting the .secret-field input, found ${secret.length}`);
  const fillVarOf = (list) => (declarationValueMap(gen, selectorListOf(list)[0] ?? "").get("background-color") ?? "").trim();
  const isChip = (sel) => /:hover\b/.test(sel) && (() => { const s = structuralCompound(subjectOf(sel)); return !s.pseudoElement && s.classes.includes("key-toggle"); })();
  const painters = parseStyleRules(hand)
    .filter((r) => !inForcedColors(r) && parseDeclarations(r.body).some((d) => /^background(?:-color)?$/.test(d.property)))
    .flatMap((r) => r.selectors.filter(isChip));
  const CHIP_HOVER = ".login-body .secret-field .key-toggle:hover";
  const CHIP_FOCUS = ".login-body .secret-field:focus-within .key-toggle:hover";
  check(painters.length === 2 && painters.includes(CHIP_HOVER) && painters.includes(CHIP_FOCUS),
    `popup.css: the eye's hover chip is painted by exactly \`${CHIP_HOVER}\` (shell hovered) and \`${CHIP_FOCUS}\` (shell focused) -- found ${JSON.stringify(painters)}`);
  check(cmpSpecificity(selectorSpecificity(CHIP_FOCUS), selectorSpecificity(CHIP_HOVER)) > 0,
    `popup.css: the focused-shell eye chip (${selectorSpecificity(CHIP_FOCUS).join(",")}) must out-rank the plain hover chip (${selectorSpecificity(CHIP_HOVER).join(",")})`);
  const bgOf = (sel) => { const m = declarationValueMap(hand, sel); return (m.get("background") ?? m.get("background-color") ?? "").trim(); };
  // The chip against the fill the token field paints in each state, on all
  // 15 popup blocks (the shared chipOverFillAcrossBlocks).
  const ppChip = chipOverFillAcrossBlocks(popupCss, "pp", secret.length !== 1 ? [] : [
    { name: "shell hovered", chip: bgOf(CHIP_HOVER), fill: fillVarOf(secret[0].hover), pct: 0.08 },
    { name: "shell focused", chip: bgOf(CHIP_FOCUS), fill: fillVarOf(secret[0].focus), pct: 0.08 },
  ], { file: "popup.css", what: "the eye's hover chip" });
  for (const failure of ppChip.failures) check(false, failure);
  check(ppChip.measured === 30, `ui-contract-tests.mjs: the popup eye chip gate measured ${ppChip.measured} (block, state) pairs, expected 30`);
  if (process.env.PBP_KEY_CHIP_MIN === "1") console.log(`[ui-contract] popup eye chip: lowest ${ppChip.lowest.r.toFixed(3)}:1 (${ppChip.lowest.where}) over ${ppChip.measured} (block, state) pairs; floor ${FILL_SEPARATE_MIN}`);
  gateDump(`[gate] chip popup measured=${ppChip.measured} lowest=${ppChip.lowest.r.toFixed(3)} (${ppChip.lowest.where}) ratios=${ratioHash(ppChip.ratios)}`);
}

// ---- Stage 4 Task 7: library's value boxes speak the field language through
// the generated recipe (spec 2026-09-30-ui-fields-stage4-design §3.3 / §4 /
// §5.1). Every answer comes from what the program consumes: FIELD_TARGETS.lib
// (the registry formRules("lib") emits from), the shipped library.css, and
// library.html plus the runtime boxes the LIBRARY_VALUE_BOX harvest pins --
// never from prose or comments. The rest < hover < focus ladder of every lib
// entry is the registry gate above (it walks every surface's entries).
{
  const LIB = FIELD_TARGETS.lib || [];
  const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  const libNoComments = noComments(libraryCss);
  // The region markers ARE comments: cut the generated regions first.
  const libHand = noComments(stripGeneratedRegions(libraryCss));
  const genStart = libraryCss.indexOf("/* @generated:ui-components start (library) */");
  const genEnd = libraryCss.indexOf("/* @generated:ui-components end (library) */");
  check(genStart >= 0 && genEnd > genStart, "library.css: cannot find the @generated:ui-components (library) region");
  const libGen = noComments(libraryCss.slice(genStart, genEnd));
  const subjects = (sel) => subjectAlternatives(subjectOf(sel)).map(classifyCompound);

  // (a) Registry: every entry names rest / hover / focus, every selector it
  // carries reaches a library value box (or, for placeholder / passenger, the
  // text part of one), no subject is an untyped <input> (§4: typed from day
  // one), and only the <select> families carry the per-theme chevron.
  check(LIB.length > 0, `ui-components.mjs: FIELD_TARGETS.lib is empty -- library's value boxes take their colours from it (stage 4 Task 7)`);
  for (const t of LIB) {
    for (const key of ["rest", "hover", "focus"]) {
      check(selectorListOf(t[key]).length > 0 && selectorListOf(t[key]).every(isValueBoxSelector),
        `ui-components.mjs FIELD_TARGETS.lib ${t.id}.${key}: every selector must reach a library value box -- got ${JSON.stringify(t[key])}`);
    }
    check(t.placeholder === null || (selectorListOf(t.placeholder).length > 0 && selectorListOf(t.placeholder).every(isValueBoxPlaceholderSelector)),
      `ui-components.mjs FIELD_TARGETS.lib ${t.id}.placeholder must be null or ::placeholder of a value box -- got ${JSON.stringify(t.placeholder)}`);
    check(t.passenger === null || (selectorListOf(t.passenger).length > 0 && selectorListOf(t.passenger).every((p) => selectorListOf(t.rest).some((r) => p.startsWith(`${r} > `)))),
      `ui-components.mjs FIELD_TARGETS.lib ${t.id}.passenger must be null or direct children (\`<rest> > ...\`) of the entry's shell -- got ${JSON.stringify(t.passenger)}`);
    const untyped = ["rest", "hover", "focus", "placeholder", "passenger", "chevron"].flatMap((k) => selectorListOf(t[k]))
      .filter((sel) => subjects(sel).some((c) => c.tag === "input" && c.type === null));
    check(untyped.length === 0, `ui-components.mjs FIELD_TARGETS.lib ${t.id}: untyped input subject(s) ${JSON.stringify(untyped)} -- type-restrict them (a checkbox must never take the field fill)`);
    // A <select> family (a select tag, or a class the harvest saw on a runtime
    // select) takes the per-theme chevron on exactly its rest selectors;
    // nothing else does.
    const isSelect = selectorListOf(t.rest).every((sel) => subjects(sel).some((c) => c.tag === "select" || c.classes.some((cl) => LIBRARY_VALUE_BOX.selectClasses.has(cl))));
    check(isSelect ? t.chevron === t.rest : t.chevron === null,
      `ui-components.mjs FIELD_TARGETS.lib ${t.id}: chevron must be ${isSelect ? "the rest selector list (a select family)" : "null (not a select)"} -- got ${JSON.stringify(t.chevron)}`);
  }
  const coveredClasses = new Set(LIB.flatMap((t) => selectorListOf(t.rest).flatMap((sel) => subjects(sel).flatMap((c) => c.classes))));
  const uncoveredClasses = [...LIBRARY_VALUE_BOX.classes].filter((cl) => !coveredClasses.has(cl));
  check(uncoveredClasses.length === 0, `ui-components.mjs FIELD_TARGETS.lib covers no rest selector for the library value box class(es) ${JSON.stringify(uncoveredClasses)}`);

  // (a2) Coverage, structurally (valueBoxCoverage, the popup model): library
  // .html as a tree plus the runtime boxes, grafted under #vocab-detail from
  // the pinned harvest -- the classed ones as themselves, the unclassed text
  // input inside its .vocab-group-unit shell (the groupUnit build the drift
  // check above pins). Every text-entry control is painted by exactly one
  // entry (as its box or as a shell's passenger), every rendered <select>
  // (the `hidden` state carriers never render) by exactly one entry's rest,
  // and every entry reaches something.
  const LIB_TREE = htmlNodes(libraryHtml);
  const LIB_SCOPE = scanScopeOf(LIB_TREE);
  const detailNode = LIB_TREE.find((n) => n.attrs.id === "vocab-detail");
  const runtimeHtml = LIBRARY_VALUE_BOX.built.map((b) => {
    const m = /^[^:]+:(\w+)(?:\[type="([^"]+)"\])?(?:\.([\w-]+))?$/.exec(b);
    if (!m) return "";
    const [, tag, type, cls] = m;
    const el = `<${tag}${type ? ` type="${type}"` : ""}${cls ? ` class="${cls}"` : ""}>${tag === "input" ? "" : `</${tag}>`}`;
    return cls ? el : `<span class="${[...LIBRARY_VALUE_BOX.shells][0]}">${el}</span>`;
  }).join("");
  const runtimeNodes = htmlNodes(runtimeHtml);
  // Grafted boxes sit somewhere under #vocab-detail next to other runtime
  // elements: their place among siblings is unknown (`unplaced`, which scan
  // mode's sibling combinators read fail-closed; strict mode never follows one).
  for (const n of runtimeNodes) {
    if (n.parent?.tag === "#root") n.parent = detailNode;
    n.unplaced = true;
  }
  const LIB_NODES = [...LIB_TREE, ...runtimeNodes];
  check(!!detailNode && runtimeNodes.length === 4,
    `ui-contract-tests.mjs: the library tree model could not graft the runtime value boxes under #vocab-detail (${detailNode ? "found" : "no"} #vocab-detail, ${runtimeNodes.length} runtime node(s), expected 4)`);
  const libCov = valueBoxCoverage(LIB_NODES, LIB);
  check(libCov.entries === 6 && libCov.uncovered.length === 0,
    `library.html + runtime boxes / FIELD_TARGETS.lib: every text-entry control must be painted by exactly one registry entry (as its box or as a shell's passenger) -- ${libCov.entries} controls (expected 6); ${libCov.uncovered.join(" | ") || "none uncovered"}`);
  check(libCov.dead.length === 0, `ui-components.mjs: FIELD_TARGETS.lib entries whose rest selector reaches nothing in library.html + the runtime boxes: ${libCov.dead.map((t) => t.id).join(", ")}`);
  const libSelects = LIB_NODES.filter((n) => n.tag === "select" && !Object.hasOwn(n.attrs, "hidden"));
  const selectMiss = libSelects.filter((n) => LIB.filter((t) => selectorListOf(t.rest).some((sel) => selectorReaches(sel, n))).length !== 1);
  check(libSelects.length === 3 && selectMiss.length === 0,
    `library.html + runtime boxes / FIELD_TARGETS.lib: every rendered <select> must be the rest box of exactly one entry -- ${libSelects.length} select(s) (expected 3), unpainted or doubly painted: ${selectMiss.map((n) => n.attrs.id ? `#${n.attrs.id}` : `select.${n.classes.join(".")}`).join(", ") || "none"}`);
  const LIB_BOX_NODES = new Set([...libCov.boxes, ...libSelects]);
  const libReaches = (sel, node) => selectorReaches(sel, node, LIB_SCOPE);
  // Scan mode vs strict mode on library (final fix wave; the popup block
  // above holds the model's full case list): [selector, node, scan, strict].
  {
    const libNode = (key) => LIB_NODES.find((n) => (key.startsWith("#") ? n.attrs.id === key.slice(1) : n.classes.includes(key.slice(1))));
    const LIB_SCAN_CASES = [
      ["#vocab-lookup-input + select", "#vocab-lookup-lang", true, false],
      ["#vocab-lookup-input ~ select", "#vocab-lookup-lang", true, false],
      // a runtime box's siblings are unknown (library-vocab.js builds them):
      // scan mode lets any sibling compound precede it
      ["#vocab-lookup-input + select", ".xp-dict-lang", true, false],
      ['html[data-theme="dracula"] .vocab-filter-row select', "#vocab-group-filter", true, false],
      ["#vocab-detail[aria-busy] .vocab-note-input", ".vocab-note-input", true, false],
      ['[role="search"] select', "#vocab-lookup-lang", true, true],
      // must NOT reach
      ["#vocab-search + select", "#vocab-group-filter", false, false],
      ['[role="grid"] select', "#vocab-lookup-lang", false, false],
      ["#vocab-lookup-lang + input", "#vocab-lookup-input", false, false],
    ];
    const libScanMisjudged = LIB_SCAN_CASES.filter(([sel, key, scan, strict]) => !libNode(key) || libReaches(sel, libNode(key)) !== scan || selectorReaches(sel, libNode(key)) !== strict);
    check(libScanMisjudged.length === 0,
      "ui-contract-tests.mjs: the library scan-mode matcher (runtime attributes off the subject, sibling combinators) or its strict coverage mode no longer discriminates -- misjudged: " +
      libScanMisjudged.map(([sel, key, scan, strict]) => `${sel} on ${key}: ${libNode(key) ? `scan ${libReaches(sel, libNode(key))} (want ${scan}), strict ${selectorReaches(sel, libNode(key))} (want ${strict})` : "node not found"}`).join(" | "));
  }
  gateDump(`[gate] coverage library entries=${libCov.entries} boxes=${libCov.boxes.size} passengers=${libCov.passengers.size} selects=${libSelects.length} uncovered=${libCov.uncovered.length} dead=${libCov.dead.length}`);

  // (a3) A shell's busy state (plan review focus 4; Task 7 fix round 1): an
  // entry whose rest box is not a form control -- the .vocab-group-unit
  // <span> -- can never itself match :disabled, so the ladder gate's bare
  // `:disabled` exclusion is meaningless on it. Its hover must exclude the
  // disabled control INSIDE it, with a `:has(... :disabled)` :not() argument
  // (hasDisabledArgument): #vocab-group-input is disabled while a batch
  // mutation runs, and the shell must not answer the pointer then. Shells are
  // found on the tree (what each rest selector reaches), not by name.
  const FORM_CONTROL_TAGS = new Set(["input", "select", "textarea", "button"]);
  const shellEntries = LIB.filter((t) => {
    const reached = LIB_NODES.filter((n) => selectorListOf(t.rest).some((sel) => selectorReaches(sel, n)));
    return reached.length > 0 && reached.every((n) => !FORM_CONTROL_TAGS.has(n.tag));
  });
  const shellBusyMisses = (hover) => selectorListOf(hover).filter((sel) => !notArgumentsOf(sel).some(hasDisabledArgument));
  const shellBusyBad = shellEntries.flatMap((t) => shellBusyMisses(t.hover).map((sel) => `${t.id}: ${sel}`));
  check(shellEntries.map((t) => t.id).join(",") === "lib-group-unit" && shellBusyBad.length === 0,
    `ui-components.mjs FIELD_TARGETS.lib: a shell entry's hover must exclude its disabled control with :not(:has(> input:disabled)) -- a bare :disabled never matches a <span> -- shells ${JSON.stringify(shellEntries.map((t) => t.id))}; missing on ${JSON.stringify(shellBusyBad)}`);
  {
    // The bare-:disabled shell hover passes the ladder gate (which accepts
    // either form on any compound) and must fail here.
    const focusSel = '.vocab-group-unit:has(> input[type="text"]:focus):not(:disabled)';
    const bare = '.vocab-group-unit:hover:where(:not(:has(> input[type="text"]:focus), :disabled))';
    const shipped = '.vocab-group-unit:hover:where(:not(:has(> input[type="text"]:focus), :has(> input:disabled)))';
    check(fieldLadderProblems(".vocab-group-unit", bare, focusSel).length === 0 && shellBusyMisses(bare).length === 1 &&
      shellBusyMisses(shipped).length === 0 && shellBusyMisses('.vocab-group-unit:hover:where(:not(:has(> input[type="text"]:focus))):not(:has(> input:disabled))').length === 0 &&
      shellBusyMisses('.vocab-group-unit:hover:where(:not(:has(> input[type="text"]:focus), :has(> input:focus)))').length === 1,
      "ui-contract-tests.mjs: the shell busy-state check no longer discriminates (a bare :disabled on the shell hover must fail it while the ladder gate still passes; :not(:has(> input:disabled)) anywhere on the selector must pass)");
  }

  // (b) Emission: formRules("lib") shipped every role of every entry into the
  // generated region with exactly the field tokens the binding contract names
  // (the shared fieldTargetEmissionProblems).
  const libEmission = fieldTargetEmissionProblems("lib", LIB, libGen, "library.css");
  for (const problem of libEmission.problems) check(false, problem);
  gateDump(`[gate] emission library selectors=${libEmission.checked} problems=${JSON.stringify(libEmission.problems.map((m) => /`([^`]+)`/.exec(m)?.[1]))}`);

  // (b2) The hand half keeps each box's ring on the entry's own ring
  // selectors (the shared fieldRingMissing).
  const libRing = fieldRingMissing("lib", LIB, libHand);
  for (const { id, sels } of libRing.missing) {
    check(false, `library.css: FIELD_TARGETS.lib ${id} has no hand-written ring (box-shadow: var(--lib-focus-ring)) on ${sels.map((sel) => `\`${sel}\``).join(", ")}`);
  }
  gateDump(`[gate] ring library selectors=${libRing.checked} missing=${JSON.stringify(libRing.missing.flatMap((m) => m.sels))}`);

  // (c) The hand-written region paints no value-box colour (§4 / 3c lesson):
  // it sits after the generated one, so a same-specificity hand colour wins,
  // and a colourless `border: 1px solid` resets border-color to currentColor.
  // A passenger (a direct child of a shell) may only declare the transparent /
  // borderless half of §8 law 1; its text colour is generated too. No hand
  // rule re-points a --lib-field-* role (the generated ui-themes blocks own
  // them). Forced-colors (active) blocks are exempt: system colours by design.
  const SHELLS = [...LIBRARY_VALUE_BOX.shells].map((cl) => `.${cl}`);
  const COLOUR_PROPS = /^(?:color|-webkit-text-fill-color|background|background-color|background-image|border-(?:top-|right-|bottom-|left-|block-|inline-|block-start-|block-end-|inline-start-|inline-end-)?color)$/;
  const BORDER_SHORTHAND = /^border(?:-(?:top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?$/;
  const libHandColourOffenders = (hand) => {
    const out = [];
    for (const rule of parseStyleRules(hand)) {
      for (const d of parseDeclarations(rule.body)) {
        if (d.property.startsWith("--lib-field-")) out.push(`${rule.selectorText} { ${d.property}: ${d.value} } (re-points a --lib-field-* role)`);
      }
      if (inForcedColors(rule)) continue;
      for (const sel of rule.selectors) {
        if (!isValueBoxSelector(sel) && !isValueBoxPlaceholderSelector(sel)) continue;
        const subject = subjectOf(sel);
        const prefix = sel.slice(0, sel.length - subject.length).trim();
        const passenger = SHELLS.some((s) => prefix === `${s} >`);
        for (const d of parseDeclarations(rule.body)) {
          const v = d.value.trim();
          const allowed = passenger && ((/^background(?:-color)?$/.test(d.property) && v === "transparent") || (BORDER_SHORTHAND.test(d.property) && /^(?:0|none)$/.test(v)));
          if (allowed) continue;
          if (COLOUR_PROPS.test(d.property) || (BORDER_SHORTHAND.test(d.property) && !/^(?:0|none)$/.test(v))) out.push(`${sel} { ${d.property}: ${v} }`);
        }
      }
    }
    return out;
  };
  const shippedColour = libHandColourOffenders(libHand);
  check(shippedColour.length === 0,
    "library.css: a hand-written rule paints a value box's colour (the generated FIELD_TARGETS.lib recipe owns fill / frame / text / placeholder / chevron; write border-width + border-style, never a `border` shorthand) -- " + shippedColour.join(" | "));
  // The stepper cells are passengers too (FIELD_TARGETS.lib's passenger list
  // paints their icon ink --lib-field-fg): no hand rule restates a cell's
  // `color` -- the base cell rule used to (--lib-fg), at the generated
  // passenger rule's own (0,2,0) and later in source, so it won.
  const stepInkOffenders = (hand) => parseStyleRules(hand).filter((r) => !inForcedColors(r)).flatMap((r) => r.selectors
    .filter((sel) => { const s = structuralCompound(subjectOf(sel)); return !s.pseudoElement && s.classes.includes("vocab-group-step"); })
    .flatMap((sel) => parseDeclarations(r.body).filter((d) => d.property === "color" || d.property === "-webkit-text-fill-color").map((d) => `${sel} { ${d.property}: ${d.value} }`)));
  check(stepInkOffenders(libHand).length === 0,
    "library.css: a hand-written rule restates a .vocab-group-step cell's ink (the generated FIELD_TARGETS.lib passenger rule paints it --lib-field-fg, stage 4 D6) -- " + stepInkOffenders(libHand).join(" | "));
  // Discrimination: [hand rule appended, caught by the colour scan].
  const CHEVRON = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><path stroke='%23888'/></svg>")`;
  const LIB_CASES = [
    [`.xp-dict-lang { background-image: ${CHEVRON}; }`, true],
    [`html[data-theme="dracula"] .vocab-filter-row select { background-image: ${CHEVRON}; }`, true],
    [".vocab-note-input { background: inherit; }", true],
    [".notes-toolbar input[type=\"search\"] { border: 1px solid; }", true],
    [".vocab-group-unit { border: 1px solid var(--lib-input-border); }", true],
    [".vocab-group-unit:hover { background-color: var(--lib-btn-hover); }", true],
    ["#vocab-lookup-lang:focus { border-color: var(--lib-focus-bd); }", true],
    [".vocab-group-unit > input[type=\"text\"] { color: var(--lib-fg); }", true],
    [".vocab-note-input::placeholder { color: var(--lib-fg-hint); }", true],
    ["#vocab-search { --lib-field-bg: #fff; }", true],
    ["@media (forced-colors: none) { .xp-dict-lang { background-color: var(--lib-btn-bg); } }", true],
    // final fix wave: a sibling combinator and a runtime attribute off the subject
    ["#vocab-lookup-input + select { background-color: var(--lib-bg2); }", true],
    [':root[data-theme] .vocab-lookup-bar input[type="search"] { color: var(--lib-fg); }', true],
    // must stay clean
    [".vocab-group-unit > input[type=\"text\"] { background: transparent; border: 0; }", false],
    [".vocab-group-unit > .vocab-group-step { border-left: 1px solid var(--lib-field-border); }", false],
    [".xp-dict-lang { border-width: 1px; border-style: solid; background-position: right 6px center; }", false],
    [".vocab-note-input:focus-visible:not(:disabled) { box-shadow: var(--lib-focus-ring); }", false],
    ["@media (forced-colors: active) { .notes-toolbar input[type=\"search\"]:focus-visible { outline: 1px solid Highlight; outline-offset: 2px; } }", false],
    [`.vocab-sort-seg { background-image: ${CHEVRON}; }`, false],
  ];
  const libMisjudged = LIB_CASES.filter(([css, want]) => (libHandColourOffenders(`${libHand}\n${css}`).length > shippedColour.length) !== want);
  check(libMisjudged.length === 0,
    "ui-contract-tests.mjs: the library value-box colour scan no longer discriminates -- misjudged: " + libMisjudged.map(([css, want]) => `${want ? "missed" : "false hit"}: ${css}`).join(" | "));
  check(stepInkOffenders(".vocab-group-unit > .vocab-group-step { color: var(--lib-fg); }").length === 1 &&
    stepInkOffenders(".vocab-group-unit:has(> input[type=\"text\"]:focus) > .vocab-group-step:hover:not(:disabled) { color: var(--lib-fg-muted); }").length === 1 &&
    stepInkOffenders(".vocab-group-unit > .vocab-group-step { border-left: 1px solid var(--lib-field-border); background: transparent; }").length === 0 &&
    stepInkOffenders("@media (forced-colors: active) { .vocab-group-unit > .vocab-group-step:focus-visible { color: Highlight; } }").length === 0,
    "ui-contract-tests.mjs: the stepper-ink scan no longer discriminates");

  // (c2) Shape (stage 4 T7-b; the module-level valueBoxShapeOffenders the
  //      options and popup blocks run too): no hand rule draws a library value
  //      box apart from its one frame colour and one radius. The one named
  //      exception is geometry, not a split box: the group unit's text
  //      passenger nests its two LEFT corners concentrically inside the shell
  //      (COMPONENTS.md §9.2 law 2), by selector, property and value. The
  //      stepper cells' concentric corners never reach this scan -- a
  //      .vocab-group-step is a button passenger, not a value box (the model
  //      check below pins that).
  const LIB_SHAPE_EXEMPT = [{ selector: '.vocab-group-unit > input[type="text"]', property: "border-radius", value: "calc(var(--lib-radius-md) - 1px) 0 0 calc(var(--lib-radius-md) - 1px)" }];
  const libShapeExempt = (sels, d) => LIB_SHAPE_EXEMPT.some((e) => sels.every((sel) => sel === e.selector) && d.property === e.property && d.value.trim() === e.value);
  const libShapeOffenders = (css) => valueBoxShapeOffenders(css, isValueBoxSelector, { ns: "lib", exempt: libShapeExempt });
  const libShapeBad = libShapeOffenders(libHand);
  check(libShapeBad.length === 0,
    "library.css: a hand-written value-box rule draws a bottom edge or splits the radius (stage 4: one frame colour on all four sides, one md radius on all four corners; only the group-unit text passenger's concentric left corners are exempt): " + libShapeBad.join(" | "));
  const LIB_SHAPE_CASES = [
    [".xp-dict-lang { border-radius: var(--lib-radius-md) var(--lib-radius-md) 0 0; }", true],
    [".vocab-note-input { border-bottom: 1px solid var(--lib-field-border-focus); }", true],
    [".vocab-group-unit { border-top-left-radius: 0; }", true],
    ["#vocab-search { border-bottom-color: var(--lib-accent); }", true],
    [".vocab-group-unit > input[type=\"text\"] { border-radius: calc(var(--lib-radius-md) - 1px) 0 0 0; }", true],
    [".vocab-filter-row select { border-color: var(--lib-field-border) var(--lib-field-border) var(--lib-accent); }", true],
    // final fix wave: a sibling combinator and a runtime attribute off the subject
    ["#vocab-lookup-input + select { border-bottom-color: red; }", true],
    ['html[data-section="main"] .vocab-note-input { border-bottom: 1px solid red; }', true],
    // must stay clean
    [".vocab-group-unit > input[type=\"text\"] { border-radius: calc(var(--lib-radius-md) - 1px) 0 0 calc(var(--lib-radius-md) - 1px); }", false],
    [".vocab-group-unit > .vocab-group-step:last-child { border-radius: 0 calc(var(--lib-radius-md) - 1px) calc(var(--lib-radius-md) - 1px) 0; }", false],
    [".vocab-note-input { border-radius: var(--lib-radius-md); }", false],
    [".vocab-sort-seg > .vocab-sort-btn:first-child { border-radius: 3px 0 0 3px; }", false],
  ];
  const libShapeMisjudged = LIB_SHAPE_CASES.filter(([css, want]) => (libShapeOffenders(css).length > 0) !== want);
  check(libShapeMisjudged.length === 0,
    "ui-contract-tests.mjs: the library value-box shape scan no longer discriminates -- misjudged: " + libShapeMisjudged.map(([css, want]) => `${want ? "missed" : "false hit"}: ${css}`).join(" | "));

  // (d) A colour literal inside a url() of a value-box rule (%23<hex>, #<hex>,
  //     rgb(), hsl() -- stage 4 T7-e, Task 4's module-level
  //     valueBoxUrlColourOffenders): the bare hex ratchet cannot see it, and
  //     library's chevrons are the per-theme --lib-field-chevron role now
  //     (§2.2). Whole file, generated regions included.
  const libUrlOffenders = (css) => valueBoxUrlColourOffenders(css, isValueBoxSelector);
  check(libUrlOffenders(libNoComments).length === 0,
    "library.css: a value-box rule carries a colour literal inside url() -- the chevron is var(--lib-field-chevron): " + libUrlOffenders(libNoComments).join(" | "));
  check(libUrlOffenders(`.xp-dict-lang { background-image: ${CHEVRON}; }`).length === 1 &&
    libUrlOffenders(`html[data-theme="dracula"] .vocab-filter-row select { background-image: ${CHEVRON}; }`).length === 1 &&
    libUrlOffenders(`.vocab-sort-seg { background-image: ${CHEVRON}; }`).length === 0 &&
    libUrlOffenders(".xp-dict-lang { background-image: var(--lib-field-chevron); }").length === 0,
    "ui-contract-tests.mjs: the library url() colour scan no longer discriminates");

  // The value-box model itself must tell library's boxes from their neighbours.
  check(isValueBoxSelector(".vocab-note-input:focus") && isValueBoxSelector(".xp-dict-lang") && isValueBoxSelector("#vocab-group-filter") &&
    isValueBoxSelector('.notes-toolbar input[type="search"]') && isValueBoxSelector('.vocab-group-unit:has(> input[type="text"]:focus)') &&
    !isValueBoxSelector(".vocab-group-unit > .vocab-group-step") && !isValueBoxSelector("#vocab-status-filter") &&
    !isValueBoxSelector(".xp-dict-lang option:checked") && !isValueBoxSelector(".vocab-sort-seg") &&
    acceptsFieldFocusCore(".vocab-note-input:focus:not(:disabled)") && acceptsFieldFocusCore(".xp-dict-lang:focus-visible:not(:disabled)") &&
    acceptsFieldFocusCore('.notes-toolbar input[type="search"]:focus-visible:not(:disabled), .vocab-lookup-bar input[type="search"]:focus-visible:not(:disabled)') &&
    !acceptsFieldFocusCore(".vocab-group-unit > .vocab-group-step:focus-visible"),
    "ui-contract-tests.mjs: the value-box model no longer tells library's value boxes (toolbar search, selects, .xp-dict-lang, note editor, group-unit shell) from their neighbours");

  // (e) §8 law 3 under stage 4: the stepper dividers are the shell's frame
  // colour at rest and follow the shell into its hover state under exactly
  // the shell hover's own selector (read from the registry), so a
  // rest-coloured hairline never shows on the hover fill -- and they win over
  // the rest divider by specificity, not by source order.
  const groupShell = LIB.find((t) => t.passenger !== null && selectorListOf(t.rest).includes(".vocab-group-unit"));
  check(!!groupShell && selectorListOf(groupShell.hover).length === 1,
    `ui-components.mjs FIELD_TARGETS.lib: no single-selector .vocab-group-unit shell entry with passengers -- got ${JSON.stringify(groupShell?.hover)}`);
  if (groupShell) {
    const DIVIDER = ".vocab-group-unit > .vocab-group-step";
    const dividerHover = `${selectorListOf(groupShell.hover)[0]} > .vocab-group-step`;
    check(declarationValueMap(libHand, DIVIDER).get("border-left") === "1px solid var(--lib-field-border)" &&
      declarationValueMap(libHand, dividerHover).get("border-left-color") === "var(--lib-field-border-hover)" &&
      cmpSpecificity(selectorSpecificity(dividerHover), selectorSpecificity(DIVIDER)) > 0,
      `library.css: the group-unit dividers must be \`${DIVIDER} { border-left: 1px solid var(--lib-field-border) }\` at rest and \`${dividerHover} { border-left-color: var(--lib-field-border-hover) }\` on hover (the shell hover's own selector, out-ranking the rest divider)`);
  }

  // (f) Forced colours (spec §6 item 10, ruling R5 / T7-g): the UA drops the
  //     box-shadow ring and remaps the focus frame, so every library value
  //     box draws `outline: 1px solid Highlight` (a non-negative offset)
  //     inside @media (forced-colors: active) on each of its entry's ring
  //     selectors (fieldRingSelectors -- the group-unit shell keeps its :has()
  //     trigger), and no outline-suppressing rule that can apply while the
  //     box holds focus -- a focus, hover or stateless rule (suppressorExcludedBy)
  //     -- out-ranks it on the same box (the tree above: library.html plus the
  //     grafted runtime boxes; the shared forcedOutlineReport). §7.3's
  //     forced-colors branch holds the outline's own shape where the selector
  //     names :focus-visible.
  const libForcedReport = (text) => forcedOutlineReport(text, {
    targetsOf: (sel) => [...LIB_BOX_NODES].filter((n) => libReaches(sel, n)),
    required: LIB.flatMap((t) => fieldRingSelectors(t).map((sel) => ({ label: `${t.id}: ${sel}`, sel }))),
  });
  const libForced = libForcedReport(libNoComments);
  check(libForced.missing.length === 0,
    "library.css: a library value box has no forced-colors focus outline (1px solid Highlight, non-negative offset, on its registry entry's ring selector) -- spec 2026-09-30 §6 item 10 / R5: " + libForced.missing.join(" | "));
  check(libForced.outranked.length === 0,
    "library.css: an outline-suppressing rule that can apply while the box holds focus out-ranks the forced-colors value-box outline, so High Contrast shows no focus: " + [...new Set(libForced.outranked)].join(" | "));
  const LIB_FORCED_CASES = [
    // appended to the shipped file: [rule, must be caught]
    ["#vocab-search:focus { outline: none !important; }", true],
    [".xp-dict-lang:focus-visible:not(:disabled) { outline: none; }", true],
    [".vocab-note-input:focus:not(:disabled):not(.a):not(.b) { outline-style: none; }", true],
    ["@media (forced-colors: active) { .vocab-group-unit:has(> input[type=\"text\"]:focus):not(:disabled):not(.x) { outline: 0; } }", true],
    ["html[data-theme] .vocab-filter-row select:focus-visible:not(:disabled) { outline: none; }", true],
    // Task 7 fix round 1: a hover rule applies while the pointer rests on a
    // keyboard-focused box, a stateless one always
    [".vocab-note-input:hover { outline: none !important; }", true],
    [".vocab-note-input { outline: none !important; }", true],
    ["#vocab-detail .vocab-group-unit:hover { outline-width: 0; }", true],
    // Task 7 fix round 2: :not(<trigger>) excludes nothing on a shell or an
    // ancestor
    [".vocab-group-unit:not(:focus-visible) { outline: none !important; }", true],
    [".vocab-group-unit:not(:focus) { outline: none !important; }", true],
    ["#vocab-detail:not(:focus) .vocab-note-input:focus { outline: none !important; }", true],
    // final fix wave: a sibling combinator and a runtime attribute off the
    // subject reach the box in the browser; a :not(:focus-within) on a
    // SIBLING compound excludes nothing
    ["#vocab-lookup-input + select { outline: none !important; }", true],
    [":root[data-theme] .vocab-note-input { outline: none !important; }", true],
    ['#vocab-detail[aria-busy="true"] .vocab-group-unit { outline: none !important; }', true],
    [".vocab-lookup-bar > #vocab-lookup-input:not(:focus-within) + select:focus { outline: none !important; }", true],
    // must stay clean
    [".vocab-lookup-bar:not(:focus-within) > #vocab-lookup-input + select:focus { outline: none !important; }", false],
    ["#vocab-lookup-lang + input[type=\"search\"] { outline: none !important; }", false],
    ["@media (forced-colors: none) { .xp-dict-lang:focus-visible { outline: none !important; } }", false],
    [".vocab-group-unit > input[type=\"text\"]:focus { outline: none !important; }", false],
    [".notes-toolbar input[type=\"search\"]:focus { outline: none; }", false],
    [".vocab-note-input { outline: none; }", false],
    [".vocab-note-input:not(:focus) { outline: none !important; }", false],
    [".vocab-group-unit:not(:focus-within) { outline: none !important; }", false],
    ['.vocab-group-unit:not(:has(> input[type="text"]:focus)) { outline: none !important; }', false],
    ["#vocab-detail:not(:focus-within) .xp-dict-lang { outline: none !important; }", false],
    // a multi-argument :where() is an OR: no exclusion is credited from it
    [".vocab-note-input:where(:not(:focus), .never) { outline: none !important; }", true],
  ];
  const libForcedMisjudged = LIB_FORCED_CASES.filter(([rule, want]) => (libForcedReport(`${libNoComments}\n${rule}`).outranked.length > libForced.outranked.length) !== want);
  const libForcedNone = libForcedReport(libNoComments.replace(/forced-colors\s*:\s*active/g, "forced-colors: none"));
  check(libForcedMisjudged.length === 0 && libForcedNone.missing.length === LIB.flatMap(fieldRingSelectors).length && LIB.flatMap(fieldRingSelectors).length > 0,
    "ui-contract-tests.mjs: the library forced-colors value-box focus scan no longer discriminates -- misjudged: " + libForcedMisjudged.map(([rule, want]) => `${want ? "missed" : "false hit"}: ${rule}`).join(" | ") +
    ` (with every forced-colors block flipped to none, ${libForcedNone.missing.length}/${LIB.flatMap(fieldRingSelectors).length} ring selectors reported missing)`);
  gateDump(`[gate] forced library missing=${JSON.stringify(libForced.missing)} outranked=${JSON.stringify(libForced.outranked)} none-missing=${libForcedNone.missing.length}`);
  for (const [rule] of LIB_FORCED_CASES) gateDump(`[gate] forced library case ${libForcedReport(`${libNoComments}\n${rule}`).outranked.length > libForced.outranked.length ? "CAUGHT" : "clean "} ${rule}`);
}

// ---- Stage 4 F10 (spec §2.2 / §2.3), library leg: the .vocab-group-unit
// stepper cells' ghost chip must stay visible against the fill the SHELL
// actually paints beneath it, in every state a cell can be hovered or pressed
// in -- the unit hovered (shell on its hover fill) and the unit's text entry
// focused (shell on its focus fill; the pointer can rest on a cell then, and a
// press keeps it there where buttons do not take focus). Ink is
// --lib-field-fg (D6: ink drawn on a field fill), 8% for hover and 10% for
// press (ruling R6 / T7-h), over that same fill. Floor FILL_SEPARATE_MIN
// (1.10), imported from the deriver, the same floor the options / popup eye
// chips are held to. The shell fill per state is read from the generated
// rules of FIELD_TARGETS.lib's shell entry (the registry formRules consumes),
// the chips from the hand rules, the values from all 15 library blocks.
{
  const STEP_CHIP_MIN = FILL_SEPARATE_MIN;
  const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  const hand = noComments(stripGeneratedRegions(libraryCss));
  const all = noComments(libraryCss);
  const handRules = parseStyleRules(hand).filter((r) => !inForcedColors(r));
  const BG_RE = /^background(?:-color)?$/;
  const isStepChipSelector = (sel) => /:(?:hover|active)/.test(sel) && subjectAlternatives(subjectOf(sel)).some((compound) => {
    const c = classifyCompound(compound);
    return !c.pseudoElement && c.classes.includes("vocab-group-step");
  });
  const painterSelectors = handRules.filter((r) => r.selectors.some(isStepChipSelector) && parseDeclarations(r.body).some((d) => BG_RE.test(d.property)))
    .flatMap((r) => r.selectors.filter(isStepChipSelector));
  const shell = (FIELD_TARGETS.lib || []).find((t) => t.passenger !== null && splitSelectorList(t.rest).includes(".vocab-group-unit"));
  const FOCUSED = shell ? `${shell.focus} > ` : "\u0000";
  const CHIPS = [
    { name: "unit hovered, cell hovered", sel: ".vocab-group-unit > .vocab-group-step:hover:not(:disabled)", fillRule: shell?.hover, pct: 0.08 },
    { name: "unit hovered, cell pressed", sel: ".vocab-group-unit > .vocab-group-step:active:not(:disabled)", fillRule: shell?.hover, pct: 0.10 },
    { name: "unit focused, cell hovered", sel: `${FOCUSED}.vocab-group-step:hover:not(:disabled)`, fillRule: shell?.focus, pct: 0.08 },
    { name: "unit focused, cell pressed", sel: `${FOCUSED}.vocab-group-step:active:not(:disabled)`, fillRule: shell?.focus, pct: 0.10 },
  ];
  check(!!shell && JSON.stringify([...painterSelectors].sort()) === JSON.stringify(CHIPS.map((c) => c.sel).sort()),
    `library.css: the stepper ghost chip is painted by exactly ${JSON.stringify(CHIPS.map((c) => c.sel))} -- found ${JSON.stringify(painterSelectors)}`);
  // Specificity of what was FOUND: every focused-unit painter out-ranks every
  // plain one, and each press rule comes after its equal-specificity hover rule.
  const focusPainters = painterSelectors.filter((s) => s.startsWith(FOCUSED));
  const plainPainters = painterSelectors.filter((s) => !s.startsWith(FOCUSED));
  const underRanked = focusPainters.flatMap((f) => plainPainters.filter((p) => cmpSpecificity(selectorSpecificity(f), selectorSpecificity(p)) <= 0).map((p) => `${f} vs ${p}`));
  check(focusPainters.length === 2 && plainPainters.length === 2 && underRanked.length === 0,
    `library.css: the focused-unit stepper chips must out-rank the plain ones -- ${underRanked.join(" | ") || JSON.stringify({ focusPainters, plainPainters })}`);
  const at = (sel) => handRules.findIndex((r) => r.selectors.includes(sel));
  check(at(CHIPS[1].sel) > at(CHIPS[0].sel) && at(CHIPS[3].sel) > at(CHIPS[2].sel),
    "library.css: each stepper press chip rule must come after its hover chip rule (equal specificity: source order decides)");
  // The chip against the fill the shell paints in each state, on all 15
  // library blocks (the shared chipOverFillAcrossBlocks); the shell fills are
  // read from the generated rules of the shell entry.
  const fillOf = (sel) => (sel ? (declarationValueMap(all, sel).get("background-color") ?? "").trim() : "");
  const chipOf = (sel) => { const m = declarationValueMap(hand, sel); return (m.get("background") ?? m.get("background-color") ?? "").trim(); };
  const stepChip = chipOverFillAcrossBlocks(libraryCss, "lib", CHIPS.map((c) => ({ name: c.name, chip: chipOf(c.sel), fill: fillOf(c.fillRule), pct: c.pct })),
    { file: "library.css", what: "the stepper chip" });
  for (const failure of stepChip.failures) check(false, failure);
  check(stepChip.measured === 60, `ui-contract-tests.mjs: the stepper chip gate measured ${stepChip.measured} (block, state) pairs, expected 60`);
  if (process.env.PBP_KEY_CHIP_MIN === "1") console.log(`[ui-contract] stepper chip: lowest ${stepChip.lowest.r.toFixed(3)}:1 (${stepChip.lowest.where}) over ${stepChip.measured} (block, state) pairs; floor ${STEP_CHIP_MIN}`);
  gateDump(`[gate] chip library measured=${stepChip.measured} lowest=${stepChip.lowest.r.toFixed(3)} (${stepChip.lowest.where}) ratios=${ratioHash(stepChip.ratios)}`);
}

if (fail.length) {
  console.error(fail.join("\n"));
  process.exit(1);
}
console.log("ui contract ok");
