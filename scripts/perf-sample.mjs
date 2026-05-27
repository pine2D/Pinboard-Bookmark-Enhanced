#!/usr/bin/env node
// perf-sample — drives an already-running Chrome via CDP to collect performance
// baseline samples for popup/options/content_script. Mirrors the connection
// pattern from docs/theme-surface/tools/screenshot-themes.mjs.
//
// PREREQUISITES
//   1. Chrome running with --remote-debugging-port=9222
//   2. Pinboard Bookmark Enhanced extension loaded (any version with perf-mark.js)
//   3. A pinboard.in tab open (for content_script measurement)
//   4. .qa-scan/ has playwright installed:  cd .qa-scan && npm install
//
// USAGE
//   node scripts/perf-sample.mjs
//   node scripts/perf-sample.mjs --port 9222 --out ./perf-baseline.json --runs 10
//   node scripts/perf-sample.mjs --only popup-cold,options-cold

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const QA_SCAN = resolve(REPO, '.qa-scan');

let chromium;
try {
  const req = createRequire(resolve(QA_SCAN, 'package.json'));
  ({ chromium } = req('playwright'));
} catch {
  console.error('[perf-sample] playwright not found.');
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
const OUT = flag('--out', resolve(REPO, 'perf-baseline.json'));
const RUNS = parseInt(flag('--runs', '10'), 10);
const ONLY = flag('--only', null);
const WARM_RUNS = 5;

const SCENARIOS = ['popup-cold', 'popup-warm', 'options-cold', 'options-warm', 'pinboard-inject'];
const ACTIVE = ONLY
  ? SCENARIOS.filter(s => ONLY.split(',').includes(s))
  : SCENARIOS;

// ---- Connect ----
console.log(`[perf-sample] connecting to chrome :${PORT}`);
const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
const ctx = browser.contexts()[0];

// Find extension ID
const swTargets = await browser.newBrowserCDPSession().then(s =>
  s.send('Target.getTargets')
).catch(() => ({ targetInfos: [] }));
const swInfo = swTargets.targetInfos?.find(t =>
  t.type === 'service_worker' &&
  t.url.includes('chrome-extension://') &&
  t.url.endsWith('/background.js')
);
if (!swInfo) {
  console.error('[perf-sample] could not find extension service worker. Is the extension loaded?');
  await browser.close();
  process.exit(2);
}
const EXT_ID = new URL(swInfo.url).hostname;
console.log(`[perf-sample] extension id: ${EXT_ID}`);

// Helper: read/write chrome.storage.local from any extension context.
// We open the extension's popup.html in a fresh tab as a sandbox.
async function withSandbox(fn) {
  const sb = await ctx.newPage();
  await sb.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await sb.waitForLoadState('domcontentloaded');
  const result = await fn(sb);
  await sb.close();
  return result;
}

async function enablePerf() {
  await withSandbox(async (sb) => {
    await sb.evaluate(async () => {
      await chrome.storage.local.set({ _perfEnabled: true, _perfSamples: [] });
    });
  });
}

async function disablePerf() {
  await withSandbox(async (sb) => {
    await sb.evaluate(async () => {
      await chrome.storage.local.set({ _perfEnabled: false });
    });
  });
}

async function clearSamples() {
  await withSandbox(async (sb) => {
    await sb.evaluate(async () => {
      await chrome.storage.local.set({ _perfSamples: [] });
    });
  });
}

async function readSamples() {
  return withSandbox(async (sb) => {
    return sb.evaluate(async () => {
      const r = await chrome.storage.local.get({ _perfSamples: [] });
      return r._perfSamples;
    });
  });
}

async function reloadExtension() {
  await withSandbox(async (sb) => {
    await sb.evaluate(() => chrome.runtime.reload());
  });
  // Wait for SW to come back
  await new Promise(r => setTimeout(r, 3000));
}

// ---- Scenarios ----

async function runPopupOpen(times) {
  for (let i = 0; i < times; i++) {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${EXT_ID}/popup.html`);
    await p.waitForLoadState('networkidle').catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    await p.evaluate(() => { if (typeof pbpFlush === "function") return pbpFlush().catch(() => {}); }).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
    await p.close();
    await new Promise(r => setTimeout(r, 200));
  }
}

async function runOptionsOpen(times) {
  for (let i = 0; i < times; i++) {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${EXT_ID}/options.html`);
    await p.waitForLoadState('networkidle').catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    await p.evaluate(() => { if (typeof pbpFlush === "function") return pbpFlush().catch(() => {}); }).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
    await p.close();
    await new Promise(r => setTimeout(r, 200));
  }
}

async function runPinboardInject(times) {
  const pb = ctx.pages().find(p => p.url().includes('pinboard.in'));
  if (!pb) {
    console.warn('[perf-sample] no pinboard.in tab open — skipping pinboard-inject');
    return;
  }
  for (let i = 0; i < times; i++) {
    await pb.reload({ waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1500));
  }
}

// ---- Stats ----
function stats(samples) {
  const by = {};
  for (const s of samples) {
    if (!by[s.name]) by[s.name] = [];
    by[s.name].push(s.ms);
  }
  const out = {};
  for (const [name, arr] of Object.entries(by)) {
    arr.sort((a, b) => a - b);
    const p = (q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
    out[name] = {
      n: arr.length,
      p50: Math.round(p(0.5) * 100) / 100,
      p90: Math.round(p(0.9) * 100) / 100,
      max: Math.round(arr[arr.length - 1] * 100) / 100,
      mean: Math.round(mean * 100) / 100,
      stddev: Math.round(sd * 100) / 100,
    };
  }
  return out;
}

// ---- Main ----
console.log(`[perf-sample] enabling perf collection`);
await enablePerf();

const results = {};

for (const scenario of ACTIVE) {
  console.log(`[perf-sample] scenario: ${scenario}`);
  await clearSamples();

  if (scenario === 'popup-cold') {
    for (let i = 0; i < RUNS; i++) {
      await reloadExtension();
      await runPopupOpen(1);
    }
  } else if (scenario === 'popup-warm') {
    await runPopupOpen(2); // prime
    await clearSamples();
    await runPopupOpen(WARM_RUNS);
  } else if (scenario === 'options-cold') {
    for (let i = 0; i < RUNS; i++) {
      await reloadExtension();
      await runOptionsOpen(1);
    }
  } else if (scenario === 'options-warm') {
    await runOptionsOpen(2);
    await clearSamples();
    await runOptionsOpen(WARM_RUNS);
  } else if (scenario === 'pinboard-inject') {
    await runPinboardInject(RUNS);
  }

  const samples = await readSamples();
  results[scenario] = stats(samples);
  console.log(`  ${Object.keys(results[scenario]).length} unique measures, ${samples.length} raw samples`);
}

console.log(`[perf-sample] disabling perf collection`);
await disablePerf();

const baseline = {
  generated: new Date().toISOString(),
  runs: RUNS,
  warmRuns: WARM_RUNS,
  results,
};
writeFileSync(OUT, JSON.stringify(baseline, null, 2));
console.log(`[perf-sample] wrote ${OUT}`);

await browser.close();
