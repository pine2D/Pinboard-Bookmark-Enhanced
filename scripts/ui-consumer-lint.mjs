#!/usr/bin/env node
// ui-consumer-lint — the edit-time face of the UI design-language gates.
//
// Wired as a Claude Code PostToolUse hook (.claude/settings.json) on Edit /
// Write / MultiEdit. It reads the hook payload from stdin, and when the edited
// file is one of the UI consumer surfaces (popup/options/library/md-preview
// HTML, their JS, shared.js, md-preview.css) it runs the two sub-second static
// gates -- layout-lint (inline spacing, RULE 5) and ui-vocabulary-lint (new
// structural class tokens). When the edited file is a theme-factory generated
// artifact (pinboard-themes.js, or popup.css/options.css/library.css, which
// each carry two @generated regions alongside hand-written layout/spacing
// tokens) it instead runs the two existing full-repo audits that already make
// this judgment for pre-commit/verify.sh -- css-region-audit and
// handedit-audit -- reused verbatim (no second region parser here). Either
// way it exits 2 with the findings on stderr so the violation reaches the
// model in the same turn it was written, not at commit time. Any other file,
// or no stdin, exits 0 silently. It never edits anything.
//
// Deliberately excludes docs/theme-surface/composers/*.mjs and
// pilots/*.tokens.json (and does not run diff-all): mid-edit-before-sync-all
// is a legitimate workflow state (CLAUDE.md's "改 composer/pilot -> sync-all
// -> commit" order) that would make those whole-repo checks red for the
// *correct* next step, not a violation -- flagging it here would just be
// noise. css-region-audit/handedit-audit don't have this problem because
// they only judge the generated files themselves, not the sources.
//
// Manual use: node scripts/ui-consumer-lint.mjs --file options.html

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERNED = /^(?:(?:popup|options|library|md-preview)\.html|(?:popup|options|library)(?:-[a-z-]+)?\.js|md-[a-z-]+\.js|shared\.js|md-preview\.css|docs\/theme-surface\/ui-vocabulary\.json|scripts\/ui-vocabulary-baseline\.json)$/;
const THEME_GOVERNED = /^(?:pinboard-themes\.js|(?:popup|options|library)\.css)$/;

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
const themeGoverned = THEME_GOVERNED.test(rel);
if (!governed && !themeGoverned) process.exit(0);

const gates = [];
if (governed) {
  gates.push(
    ["layout-lint", resolve(ROOT, "docs/theme-surface/tools/layout-lint.mjs")],
    ["ui-vocabulary", resolve(ROOT, "scripts/ui-vocabulary-lint.mjs")],
  );
}
if (themeGoverned) {
  gates.push(
    ["css-region-audit", resolve(ROOT, "docs/theme-surface/tools/css-region-audit.mjs")],
    ["handedit-audit", resolve(ROOT, "docs/theme-surface/tools/handedit-audit.mjs")],
  );
}
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
