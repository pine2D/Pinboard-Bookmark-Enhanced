#!/usr/bin/env node
// screenshot-themes — drives an already-logged-in Chrome via CDP, renders
// each theme over the same live Pinboard page, screenshots the viewport.
// Catches per-theme visual regressions the 5 static lints can't see (cascade
// surprises on a specific palette, low-contrast token picks, per-theme
// override interactions).
//
// COMPLEMENTS visual-qa.mjs (which builds static HTML harness from saved
// snapshots). screenshot-themes runs against the LIVE running app — useful
// when verifying that the deployed extension actually renders correctly on
// today's Pinboard DOM, not a stored copy.
//
// PREREQUISITES
//   1. Chrome running with --remote-debugging-port=9222 (override via --port)
//   2. A pinboard.in tab open and logged in (any tag-detail page exercises
//      tag-cloud + bookmark rows + "by" meta)
//   3. sync-all has been run recently so pilots/*.generated.css is fresh
//   4. .qa-scan/ has playwright installed:  cd .qa-scan && npm install
//
// USAGE
//   node docs/theme-surface/tools/screenshot-themes.mjs
//   node docs/theme-surface/tools/screenshot-themes.mjs --only flexoki,paper-ink
//   node docs/theme-surface/tools/screenshot-themes.mjs --port 9222 --out /tmp/qa
//
// OUTPUT
//   .qa-scan/visual-qa-YYYY-MM-DD/<slug>.png per theme (override via --out).
//   Restores whatever <style id="pbp-injected"> held on entry, so the user's
//   actual extension theme state is preserved.

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SURFACE = resolve(__dirname, '..');
const PILOTS = resolve(SURFACE, 'pilots');
const REPO = resolve(SURFACE, '..', '..');
const QA_SCAN = resolve(REPO, '.qa-scan');

// Pull playwright from .qa-scan/node_modules so cwd doesn't matter.
let chromium;
try {
  const req = createRequire(resolve(QA_SCAN, 'package.json'));
  ({ chromium } = req('playwright'));
} catch {
  console.error('[screenshot-themes] playwright not found.');
  console.error('  Install:  cd .qa-scan && npm install');
  process.exit(2);
}

// ---- CLI ----
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};

const PORT = flag('--port', '9222');
const dateStamp = new Date().toISOString().slice(0, 10);
const OUT_DIR = flag('--out', resolve(QA_SCAN, `visual-qa-${dateStamp}`));
const ONLY = flag('--only', null);

// ---- Discover themes ----
let SLUGS = readdirSync(PILOTS)
  .filter(f => f.endsWith('.tokens.json'))
  .map(f => f.replace(/\.tokens\.json$/, ''))
  .sort();

if (ONLY) {
  const want = new Set(ONLY.split(',').map(s => s.trim()));
  SLUGS = SLUGS.filter(s => want.has(s));
  if (!SLUGS.length) {
    console.error(`[screenshot-themes] no themes matched --only ${ONLY}`);
    process.exit(2);
  }
}

const missing = SLUGS.filter(s => !existsSync(resolve(PILOTS, `${s}.generated.css`)));
if (missing.length) {
  console.error(`[screenshot-themes] missing generated.css for: ${missing.join(', ')}`);
  console.error('  Run:  node docs/theme-surface/tools/sync-all.mjs');
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });

// ---- Connect ----
const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
const ctx = browser.contexts()[0];
const pb = ctx.pages().find(p => p.url().includes('pinboard.in'));
if (!pb) {
  console.error(`[screenshot-themes] no pinboard.in tab open in Chrome :${PORT}`);
  console.error('  Open one and log in, then re-run.');
  await browser.close();
  process.exit(2);
}

console.log(`[screenshot-themes] ${SLUGS.length} themes | tab: ${pb.url()}`);
console.log(`[screenshot-themes] out: ${OUT_DIR}\n`);

// ---- Capture original CSS so we can restore it ----
const originalCss = await pb.evaluate(
  () => document.getElementById('pbp-injected')?.textContent || ''
);

const injectCss = async (css) => {
  return pb.evaluate(
    (cssArg) => {
      let s = document.getElementById('pbp-injected');
      if (!s) {
        s = document.createElement('style');
        s.id = 'pbp-injected';
        document.head.appendChild(s);
      }
      s.textContent = cssArg;
      const m = s.textContent.match(/--pinboard-accent:\s*([^;]+)/);
      return { len: s.textContent.length, accent: m ? m[1].trim() : 'none' };
    },
    css
  );
};

// ---- Per-theme: inject + screenshot ----
const failed = [];
for (const slug of SLUGS) {
  process.stdout.write(`  ${slug.padEnd(18)} `);
  try {
    const css = readFileSync(resolve(PILOTS, `${slug}.generated.css`), 'utf8');
    const ret = await injectCss(css);
    await pb.waitForTimeout(120);  // let layout settle
    const outPath = resolve(OUT_DIR, `${slug}.png`);
    await pb.screenshot({ path: outPath, type: 'png', fullPage: false });
    console.log(`OK ${ret.accent}  ${slug}.png`);
  } catch (e) {
    failed.push({ slug, error: e.message });
    console.log(`FAIL ${e.message}`);
  }
}

// ---- Restore ----
process.stdout.write('  restore original   ');
if (originalCss) {
  await injectCss(originalCss);
  console.log('OK');
} else {
  console.log('SKIP (no pre-existing style; extension will re-inject on next interaction)');
}

await browser.close();

console.log(`\n[screenshot-themes] ${SLUGS.length - failed.length}/${SLUGS.length} OK`);
console.log(`[screenshot-themes] artifacts: ${OUT_DIR}`);
if (failed.length) {
  console.log('[screenshot-themes] failures:', failed);
  process.exit(1);
}
