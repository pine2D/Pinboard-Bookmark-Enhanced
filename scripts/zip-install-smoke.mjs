#!/usr/bin/env node
// zip-install-smoke — extracts a release ZIP, installs it into a fresh
// Playwright-bundled Chromium via --load-extension, then verifies basic
// runtime health (SW registers; popup, options, and preview open cleanly).
//
// Designed to catch the bug class where the shipped ZIP is missing a file
// that manifest/HTML references (e.g. SW importScripts 404, popup script
// 404 → ReferenceError on first call). Loaded-unpacked tests don't catch
// this; only a real ZIP install does.
//
// PREREQUISITES
//   1. .qa-scan/ has playwright installed:  cd .qa-scan && npm install
//   2. Playwright's bundled Chromium has been downloaded:
//      cd .qa-scan && npx playwright install chromium
//
// USAGE
//   node scripts/zip-install-smoke.mjs
//   node scripts/zip-install-smoke.mjs --zip release/pinboard-bookmark-enhanced-v2.71.zip
//   node scripts/zip-install-smoke.mjs --keep-tmp  # leave extracted dir for inspection
//
// EXIT
//   0 → all checks passed
//   1 → at least one check failed (SW missing, page errors, etc.)
//   2 → tooling/env error (no playwright, no ZIP, etc.)

import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const QA_SCAN = resolve(REPO, '.qa-scan');

let chromium;
try {
  const req = createRequire(resolve(QA_SCAN, 'package.json'));
  ({ chromium } = req('playwright'));
} catch {
  console.error('[zip-smoke] playwright not found.');
  console.error('  Install:  cd .qa-scan && npm install && npx playwright install chromium');
  process.exit(2);
}

// ---- CLI ----
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const hasFlag = (n) => argv.includes(n);
const KEEP_TMP = hasFlag('--keep-tmp');

let zipPath = flag('--zip', null);
if (!zipPath) {
  const releaseDir = resolve(REPO, 'release');
  if (!existsSync(releaseDir)) {
    console.error('[zip-smoke] no release/ dir; pass --zip <path>');
    process.exit(2);
  }
  const zips = readdirSync(releaseDir)
    .filter(f => f.endsWith('.zip') && f.startsWith('pinboard-bookmark-enhanced-v'))
    .sort()
    .reverse();
  if (!zips.length) {
    console.error('[zip-smoke] no ZIP in release/; pass --zip <path>');
    process.exit(2);
  }
  zipPath = resolve(releaseDir, zips[0]);
}

if (!existsSync(zipPath)) {
  console.error(`[zip-smoke] ZIP not found: ${zipPath}`);
  process.exit(2);
}

// ---- Extract ZIP ----
const tmpRoot = mkdtempSync(join(tmpdir(), 'pbp-zip-smoke-'));
const extractDir = join(tmpRoot, 'ext');
console.log(`[zip-smoke] ZIP: ${zipPath}`);
console.log(`[zip-smoke] extracting → ${extractDir}`);
try {
  // execFileSync (no shell) — argv-array form prevents injection
  execFileSync('unzip', ['-q', zipPath, '-d', extractDir], { stdio: 'inherit' });
} catch {
  console.error('[zip-smoke] unzip failed; is `unzip` installed?');
  rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(2);
}

// ZIP contains pinboard-bookmark-enhanced-vX.Y.Z/ as a single root dir
const subdirs = readdirSync(extractDir);
if (subdirs.length !== 1) {
  console.error(`[zip-smoke] expected 1 dir at ZIP root, got ${subdirs.length}: ${subdirs.join(', ')}`);
  if (!KEEP_TMP) rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(2);
}
const extPath = join(extractDir, subdirs[0]);
const userDataDir = join(tmpRoot, 'profile');

function cleanup() {
  if (KEEP_TMP) {
    console.log(`[zip-smoke] --keep-tmp: tmp preserved at ${tmpRoot}`);
  } else {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

// ---- Check 0: dynamically-referenced runtime files survived packaging ----
// These aren't all referenced by manifest/HTML tags, so release.sh's static
// sanity check can't see them. Keep this explicit list beside the real ZIP test.
console.log('[zip-smoke] check 0: dynamically-referenced runtime files present...');
const REQUIRED_RUNTIME_FILES = [
  'site-rules.js',
  'vendor/turndown.js',
  'vendor/highlight.min.js',
  'vendor/hljs-github.min.css',
  'vendor/hljs-github-dark.min.css',
  'vendor/katex/katex.min.js',
  'vendor/katex/katex.min.css',
  'vendor/katex/auto-render.min.js',
  'vendor/defuddle.js',
  'icons/pin-default-16.png',
  'icons/pin-default-32.png',
  'icons/pin-default-48.png',
  'icons/pin-default-128.png',
  'icons/pin-saved-16.png',
  'icons/pin-saved-32.png',
  'icons/pin-saved-48.png',
  'icons/pin-saved-128.png',
];
const missingRuntime = REQUIRED_RUNTIME_FILES.filter(f => !existsSync(join(extPath, f)));
if (missingRuntime.length) {
  console.error('[zip-smoke] FAIL: ZIP missing dynamically-referenced runtime file(s):');
  missingRuntime.forEach(f => console.error(`    - ${f}`));
  cleanup();
  process.exit(1);
}
console.log(`  present: ${REQUIRED_RUNTIME_FILES.join(', ')}`);

// ---- Launch fresh Chromium with extension ----
console.log('[zip-smoke] launching Chromium with extension loaded...');
let ctx;
try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // MV3 extensions require headed (or 'new' headless on recent Chrome)
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
    ],
  });
} catch (e) {
  console.error(`[zip-smoke] Chromium launch failed: ${e.message}`);
  console.error('  If running headless on a server, try installing X virtual framebuffer:');
  console.error('    sudo apt install xvfb && xvfb-run -a node scripts/zip-install-smoke.mjs');
  cleanup();
  process.exit(2);
}

const consoleErrors = [];
ctx.on('console', msg => {
  if (msg.type() === 'error') {
    consoleErrors.push({ scope: 'ctx', text: msg.text() });
  }
});

// ---- Check 1: Service worker registers ----
console.log('[zip-smoke] check 1: service worker registers...');
let sw = ctx.serviceWorkers()[0];
if (!sw) {
  sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
}
if (!sw) {
  console.error('[zip-smoke] FAIL: no service worker registered within 15s');
  await ctx.close().catch(() => {});
  cleanup();
  process.exit(1);
}
console.log(`  SW URL: ${sw.url()}`);

const extId = new URL(sw.url()).hostname;
console.log(`  extension ID: ${extId}`);

// Capture SW console errors
sw.on('console', msg => {
  if (msg.type() === 'error') {
    consoleErrors.push({ scope: 'sw', text: msg.text() });
  }
});

// Brief wait so SW can finish boot (importScripts, alarm setup, etc.)
await new Promise(r => setTimeout(r, 1500));

// ---- Checks 2-4: extension pages open without runtime/resource failures ----
const extensionBase = `chrome-extension://${extId}/`;
async function checkExtensionPage(number, name, waitMs) {
  console.log(`[zip-smoke] check ${number}: ${name}.html opens...`);
  const failures = [];
  const page = await ctx.newPage();
  let collecting = true;
  page.on('pageerror', e => {
    if (collecting) failures.push(`pageerror: ${e.message}`);
  });
  page.on('requestfailed', request => {
    if (!collecting || !request.url().startsWith(extensionBase)) return;
    failures.push(`request failed: ${request.url()} (${request.failure()?.errorText || 'unknown error'})`);
  });
  page.on('response', response => {
    if (collecting && response.url().startsWith(extensionBase) && response.status() >= 400) {
      failures.push(`extension resource HTTP ${response.status()}: ${response.url()}`);
    }
  });
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push({ scope: name, text: msg.text() });
  });
  try {
    await page.goto(`${extensionBase}${name}.html`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await new Promise(r => setTimeout(r, waitMs));
  } catch (e) {
    failures.push(`navigation failed: ${e.message}`);
  }
  collecting = false;
  await page.close().catch(() => {});
  if (failures.length) {
    console.error(`  FAIL: ${name} raised ${failures.length} runtime/resource failure(s):`);
    failures.forEach(e => console.error(`    - ${e}`));
    return false;
  }
  console.log(`  ${name} OK`);
  return true;
}

for (const check of [[2, 'popup', 1500], [3, 'options', 2000], [4, 'md-preview', 2000]]) {
  if (!await checkExtensionPage(...check)) {
    await ctx.close().catch(() => {});
    cleanup();
    process.exit(1);
  }
}

// ---- Teardown ----
await ctx.close().catch(() => {});
cleanup();

// Console errors are warnings — fail count is for diagnostics only.
// Real failures already exited above. Common benign console errors:
// "Failed to load resource" for icons on chrome:// pages, etc.
if (consoleErrors.length) {
  console.warn(`[zip-smoke] note: ${consoleErrors.length} console error(s) captured (not a fail):`);
  consoleErrors.slice(0, 5).forEach(e => console.warn(`  [${e.scope}] ${e.text}`));
  if (consoleErrors.length > 5) console.warn(`  ... and ${consoleErrors.length - 5} more`);
}

console.log('[zip-smoke] PASS');
process.exit(0);
