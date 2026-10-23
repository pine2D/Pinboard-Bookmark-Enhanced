import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { chromium } from '../.qa-scan/node_modules/playwright/index.mjs';
import { CHIP_TARGETS } from '../docs/theme-surface/composers/ui-components.mjs';
import { readOptionsDensity } from '../docs/theme-surface/tools/options-density.mjs';

// Exercise the real browser probe without importing the runner's CLI/main.
// AST ranges avoid matching comments or another function with a similar name.
const require = createRequire(new URL('../.qa-scan/package.json', import.meta.url));
const { parse } = require('espree');
const source = readFileSync(new URL('../scripts/ui-render-audit.mjs', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true });
const cfgNode = ast.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : [])
  .find(node => node.id.name === 'SWEEP_CFG')?.init;
const probeNode = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'sweepProbe');
assert.ok(cfgNode && probeNode, 'the render audit must expose its real config/probe declarations');
const sourceOf = node => source.slice(...node.range);
const cfg = vm.runInNewContext(`(${sourceOf(cfgNode)})`, {
  CHIP_TARGETS, OPTIONS_DENSITY: readOptionsDensity(fileURLToPath(new URL('..', import.meta.url))),
});
const probe = vm.runInNewContext(`(${sourceOf(probeNode)})`);

const icon = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/></svg>';
const bookmark = `<button class="reader-bookmark-ic" aria-label="Save">${icon}</button>`;
const ordinary = '<button>Save</button><button>Cancel</button>';
const chips = '<button class="ask-chip">Summarize</button><button class="ask-chip">Key argument</button>';
// Inputs and expected results are hand-written, independent of SWEEP_CFG.
const html = `<!doctype html><html><head><style>
  body { margin: 16px; font: 13px/16px sans-serif; }
  .row { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
  .gap-8 { gap: 8px; } .gap-6 { gap: 6px; } .gap-5 { gap: 5px; }
  button { display: inline-flex; align-items: center; height: 26px; padding: 4px 8px; border: 0; border-radius: 4px; font: inherit; }
  .reader-bookmark-ic { width: 26px; padding: 0; justify-content: center; }
  [hidden] { display: none; }
</style></head><body>
  <div class="row" id="ordinary-4">${ordinary}</div>
  <div class="row gap-8" id="ordinary-8">${ordinary}</div>
  <div class="row" id="unregistered-icons"><button>${icon}</button><button>${icon}</button></div>
  <div class="row" id="export-toggles-4"><button aria-pressed="true">${icon}</button><button aria-pressed="false">${icon}</button></div>
  <div class="row gap-8" id="export-toggles"><button aria-pressed="true">${icon}</button><button aria-pressed="false">${icon}</button></div>
  <div class="row" id="bookmark-4">${bookmark}${bookmark}</div>
  <div class="row gap-6" id="bookmark-6">${bookmark}${bookmark}</div>
  <div class="row gap-8" id="bookmark-8">${bookmark}${bookmark}</div>
  <div class="row" id="mixed-label">${bookmark}<button class="reader-bookmark-ic">Save</button></div>
  <div class="row" id="own-label">Save actions${bookmark}${bookmark}</div>
  <div class="row" id="hidden-label">${bookmark}${bookmark}<button hidden>Hidden</button></div>
  <div class="row" id="chips-4">${chips}</div>
  <div class="row" id="mixed-chips">${chips}<button>Send</button></div>
  <div class="row gap-5" id="chips-5">${chips}</div>
  <div class="row" id="ask-chips">${chips}<div class="row" id="nested-actions">${ordinary}</div></div>
</body></html>`;

let browser;
let hits;
before(async () => {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 1000 } });
  await page.route('https://audit.test/md-preview.html', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://audit.test/md-preview.html');
  hits = await page.evaluate(probe, cfg);
});
after(async () => { await browser?.close(); });

const kindsAt = id => hits.filter(hit => hit.path === `#${id}` && ['actionRowGap', 'clusterGap'].includes(hit.kind))
  .map(hit => hit.kind).sort();
for (const [id, expected] of [
  ['ordinary-4', ['actionRowGap']], ['ordinary-8', []],
  ['unregistered-icons', ['actionRowGap']], ['export-toggles-4', ['actionRowGap']], ['export-toggles', []],
  ['bookmark-4', []], ['bookmark-6', ['clusterGap']], ['bookmark-8', ['clusterGap']],
  ['mixed-label', ['actionRowGap']], ['own-label', ['actionRowGap']], ['hidden-label', []],
  ['chips-4', []], ['mixed-chips', ['actionRowGap']],
  ['ask-chips', ['actionRowGap']], ['nested-actions', ['actionRowGap']],
]) {
  test(`actual row-gap probe: ${id}`, () => assert.deepEqual(kindsAt(id), expected));
}
test('chip-row exemption still leaves off-token rhythm to spacingScale', () => {
  assert.deepEqual(kindsAt('chips-5'), []);
  assert.deepEqual(hits.filter(hit => hit.path === 'body > #chips-5' && hit.kind === 'spacingScale')
    .map(hit => [hit.prop, hit.value]).sort(), [['column-gap', 5], ['row-gap', 5]]);
  assert.ok(!hits.some(hit => hit.path === 'body > #chips-4' && hit.kind === 'spacingScale'), '4px chip-row gap is on scale');
});
