#!/usr/bin/env node
// ui-consumer-lint — the edit-time face of the UI design-language gates.
//
// Wired as a Claude Code PostToolUse hook (.claude/settings.json) on Edit /
// Write / MultiEdit. It reads the hook payload from stdin, and when the edited
// file is one of the UI consumer surfaces (popup/options/library/md-preview
// HTML, their JS, shared.js, md-preview.css) it runs the two sub-second static
// gates -- layout-lint (inline spacing, RULE 5) and ui-vocabulary-lint (new
// structural class tokens). When the edited file is a theme-factory generated
// artifact it instead runs whichever existing full-repo audits actually read
// that file -- reused verbatim, no second region parser here -- routed by
// what each script's own source touches:
//   popup.css / options.css / library.css -> layout-lint (its TARGETS are
//     exactly these three files) + css-region-audit (its SURFACES are these
//     three files' cssPath, each with two @generated regions).
//   pinboard-themes.js -> handedit-audit only (it reads pinboard-themes.js
//     specifically; css-region-audit's SURFACES never include it, and
//     layout-lint's TARGETS never include it, so running either there would
//     be dead weight that can never fail).
// Either way it exits 2 with the findings on stderr so the violation reaches
// the model in the same turn it was written, not at commit time. Any other
// file, or no stdin, exits 0 silently. It never edits anything.
//
// Deliberately excludes docs/theme-surface/composers/*.mjs and
// pilots/*.tokens.json (and does not run diff-all): mid-edit-before-sync-all
// is a legitimate workflow state (CLAUDE.md's "改 composer/pilot -> sync-all
// -> commit" order) that would make those whole-repo checks red for the
// *correct* next step, not a violation -- flagging it here would just be
// noise. css-region-audit/handedit-audit/layout-lint don't have this problem
// because they only judge the generated/hand-written files themselves, not
// the composer/pilot sources that feed them.
//
// Manual use: node scripts/ui-consumer-lint.mjs --file options.html

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERNED = /^(?:(?:popup|options|library|md-preview)\.html|(?:popup|options|library)(?:-[a-z-]+)?\.js|md-[a-z-]+\.js|shared\.js|md-preview\.css|docs\/theme-surface\/ui-vocabulary\.json|scripts\/ui-vocabulary-baseline\.json)$/;
const THEME_CSS_GOVERNED = /^(?:popup|options|library)\.css$/;
const THEME_JS_GOVERNED = /^pinboard-themes\.js$/;

function targetFromArgsOrStdin() {
  const i = process.argv.indexOf("--file");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch (_) { return null; }
  if (!raw.trim()) return null;
  try {
    const payload = JSON.parse(raw);
    return payload?.tool_input?.file_path || payload?.tool_response?.filePath || null;
  } catch (_) { return null; }
}

const target = targetFromArgsOrStdin();
if (!target) process.exit(0);
const rel = relative(ROOT, resolve(ROOT, target)).replace(/\\/g, "/");
const governed = GOVERNED.test(rel);
const themeCssGoverned = THEME_CSS_GOVERNED.test(rel);
const themeJsGoverned = THEME_JS_GOVERNED.test(rel);
const themeGoverned = themeCssGoverned || themeJsGoverned;
if (!governed && !themeGoverned) process.exit(0);

// Map, not array: keeps each gate script running at most once even if a
// future GOVERNED/THEME_* pattern were to overlap on the same file.
const gateMap = new Map();
const addGate = (name, script) => { if (!gateMap.has(name)) gateMap.set(name, resolve(ROOT, script)); };
if (governed) {
  addGate("layout-lint", "docs/theme-surface/tools/layout-lint.mjs");
  addGate("ui-vocabulary", "scripts/ui-vocabulary-lint.mjs");
}
if (themeCssGoverned) {
  addGate("layout-lint", "docs/theme-surface/tools/layout-lint.mjs");
  addGate("css-region-audit", "docs/theme-surface/tools/css-region-audit.mjs");
}
if (themeJsGoverned) {
  addGate("handedit-audit", "docs/theme-surface/tools/handedit-audit.mjs");
}
const gates = [...gateMap.entries()];
const failures = [];
for (const [name, script] of gates) {
  const r = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    const out = `${r.stdout || ""}${r.stderr || ""}`.split("\n").filter((l) => /BLOCK|FAIL|ERROR/.test(l)).join("\n");
    failures.push(`[${name}] ${rel}\n${out}`);
  }
}
if (failures.length) {
  const themeHint = themeGoverned
    ? "This is a theme-factory generated artifact -- do not hand-edit it. Edit docs/theme-surface/composers/*.mjs or pilots/*.tokens.json instead, then run: node docs/theme-surface/tools/sync-all.mjs\n"
    : "";
  process.stderr.write(`UI design-language gate failed after editing ${rel}:\n${failures.join("\n")}\n${themeHint}Rules: .claude/rules/ui-primitives.md (three questions for any new element)${themeGoverned ? " / .claude/rules/theme-factory.md" : ""}. Fix before moving on.\n`);
  process.exit(2);
}
process.exit(0);
