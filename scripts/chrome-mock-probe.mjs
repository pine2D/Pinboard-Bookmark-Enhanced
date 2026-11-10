#!/usr/bin/env node
// Measures, in the bundled Chromium, the chrome.* behaviours that
// tests/fixtures/chrome-mock.js copies, and prints them as JSON. Dev tool:
// not in verify, not in the ZIP. It writes a throwaway unpacked extension to
// a temp folder, loads it, runs the probes in its service worker and in one
// extension page, then deletes the folder.
//
//   node scripts/chrome-mock-probe.mjs        (needs .qa-scan/node_modules)
//
// When the output changes after a Chromium update, update the mock and the
// facts quoted in its header.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(ROOT, '.qa-scan', 'package.json'))('playwright');

const ext = mkdtempSync(join(tmpdir(), 'pbp-chrome-probe-'));
writeFileSync(join(ext, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'probe', version: '1', default_locale: 'en',
  background: { service_worker: 'sw.js' }, permissions: ['storage'],
}));
// A listener that never answers, for the sendMessage probe.
writeFileSync(join(ext, 'sw.js'), 'chrome.runtime.onMessage.addListener(() => {});\n');
mkdirSync(join(ext, '_locales', 'en'), { recursive: true });
writeFileSync(join(ext, '_locales', 'en', 'messages.json'), JSON.stringify({
  helloWorld: { message: 'Hi $1 and $NAME$', placeholders: { name: { content: '$2' } } },
}));

let ctx;
try {
  ctx = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  const inWorker = await sw.evaluate(async () => {
    class K { constructor() { this.x = 1; } }
    const e = new Error('m'); e.code = 7;
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      date: new Date(0), regexp: /a/g, map: new Map([[1, 2]]), set: new Set([1]), instance: new K(), error: e,
      infinity: Infinity, fn: () => 1, undef: undefined,
      array: [1, undefined, NaN, () => 1, new Date(0), null], nested: { a: undefined, b: NaN, c: 'ok', d: new Date(0) },
    });
    const stored = await chrome.storage.local.get(null);
    let permissionsRequestWithoutGesture;
    try { await chrome.permissions.request({ origins: ['https://example.com/*'] }); permissionsRequestWithoutGesture = 'resolved'; } catch (err) { permissionsRequestWithoutGesture = 'rejected: ' + err.message; }
    return { storageSetThenGetAll: stored, permissionsRequestWithoutGesture };
  });
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/manifest.json`);
  const inPage = await page.evaluate(async () => {
    const out = {
      getMessageExactName: chrome.i18n.getMessage('helloWorld', ['A', 'B']),
      getMessageLowerCaseName: chrome.i18n.getMessage('helloworld', ['A', 'B']),
    };
    try { out.sendMessageListenerNeverAnswers = 'resolved: ' + String(await chrome.runtime.sendMessage({ x: 1 })); } catch (err) { out.sendMessageListenerNeverAnswers = 'rejected: ' + err.message; }
    try { chrome.storage.local.get(42); out.storageGetWithNumber = 'no synchronous throw'; } catch (err) { out.storageGetWithNumber = 'synchronous ' + err.name + ': ' + err.message; }
    return out;
  });
  console.log(JSON.stringify({ browser: ctx.browser()?.version() || (await page.evaluate(() => navigator.userAgent)), ...inWorker, ...inPage }, null, 2));
} finally {
  if (ctx) await ctx.close();
  rmSync(ext, { recursive: true, force: true });
}
