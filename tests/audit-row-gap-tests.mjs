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
const dictAction = `<button class="xp-dict-connect" aria-label="Dictionary source">${icon}</button>`;
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
  <div class="row xp-dict-ai-controls" id="dict-icons-4">${dictAction}${dictAction}</div>
  <div class="row xp-dict-ai-controls gap-8" id="dict-icons-8">${dictAction}${dictAction}</div>
  <div class="row xp-dict-ai-controls" id="dict-mixed-label">${dictAction}<button class="xp-dict-connect">Generate entry</button></div>
  <div class="row xp-dict-ai-controls" id="dict-hidden-label">${dictAction}${dictAction}<button hidden>Generate</button></div>
  <div class="row" id="dict-outside-controls">${dictAction}${dictAction}</div>
  <div class="row xp-dict-ai-controls" id="dict-with-nested-row">${dictAction}<div class="row" id="dict-nested-actions">${ordinary}</div></div>
</body></html>`;

let browser;
let hits;
const proseHits = new Map();
const dictionaryHits = new Map();
before(async () => {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 1000 } });
  await page.route('https://audit.test/md-preview.html', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://audit.test/md-preview.html');
  hits = await page.evaluate(probe, cfg);
  dictionaryHits.set('md-preview', hits);
  await page.route('https://audit.test/library.html', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://audit.test/library.html');
  dictionaryHits.set('library', await page.evaluate(probe, cfg));
  await collectProseHits();
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
// The lookup's AI row is no icon cluster any more: since the one-column
// redesign (plan 3.3) every action in it is icon + text, so even two
// icon-only buttons there are an ordinary action row held to 8px -- the
// 4px cluster rung no longer applies to them on either surface.
for (const surface of ['library', 'md-preview']) {
  for (const [id, expected] of [
    ['dict-icons-4', ['actionRowGap']], ['dict-icons-8', []],
    ['dict-mixed-label', ['actionRowGap']], ['dict-hidden-label', ['actionRowGap']],
    ['dict-outside-controls', ['actionRowGap']], ['dict-nested-actions', ['actionRowGap']],
  ]) {
    test(`dictionary AI row is an action row: ${surface} ${id}`, () => {
      assert.deepEqual(dictionaryHits.get(surface)
        .filter(hit => hit.path === `#${id}` && ['actionRowGap', 'clusterGap'].includes(hit.kind))
        .map(hit => hit.kind).sort(), expected);
    });
  }
}

// Reader prose uses em rhythm; the chrome spacing scale must not override it.
// These are independent CSS fixtures, exercised at two actual font sizes.
async function collectProseHits() {
  for (const size of [19, 27]) {
    const page = await browser.newPage({ viewport: { width: 800, height: 1000 } });
    const body = `<!doctype html><html><head><style>
      body { margin: 16px; font: ${size}px/1.6 sans-serif; }
      .xp-md p { margin: .5em 0; }
      ol.xp-dict-senses { padding: 0; margin: 8px 0; }
      ol.xp-dict-senses > li { margin: 4px 0; margin-inline-start: 1.4em; }
      ol.xp-dict-senses > li:only-child { list-style: none; }
      button { height: 31px; margin: 5px; padding: 0 8px; font: 12px sans-serif; }
    </style></head><body>
      <div class="xp-md">
        <p id="prose-relative">Original definition <button id="prose-control">Look up base</button></p>
        <p id="prose-fixed" style="margin-top:9.5px;margin-bottom:9.5px">Fixed at one size</p>
        <p id="prose-token" style="margin-top:8px;margin-bottom:8px">Incorrect fixed chrome token</p>
        <p id="prose-other" style="padding-left:5px">Other properties still use the scale</p>
      </div>
      <ol class="xp-dict-senses"><li id="senses-relative">A meaning</li><li>Another meaning</li></ol>
      <ol class="xp-dict-senses"><li id="senses-fixed" style="margin-inline-start:26.6px">Fixed at one size</li><li>Another meaning</li></ol>
      <ol class="xp-dict-senses"><li id="senses-token" style="margin-inline-start:24px">Incorrect chrome token</li><li>Another meaning</li></ol>
      <ol class="xp-dict-senses"><li id="senses-rtl-relative" dir="auto">قصر (Schloss)</li><li dir="rtl">معنى آخر</li></ol>
      <ol class="xp-dict-senses"><li id="senses-rtl-fixed" dir="rtl" style="margin-inline-start:26.6px">قصر (Schloss)</li><li dir="rtl">معنى آخر</li></ol>
      <ol class="xp-dict-senses"><li id="senses-rtl-token" dir="rtl" style="margin-inline-start:24px">قصر (Schloss)</li><li dir="rtl">معنى آخر</li></ol>
      <ol class="xp-dict-senses"><li id="senses-single">A single meaning keeps the indent</li></ol>
      <ol class="xp-dict-senses"><li id="senses-rtl-single" dir="rtl">معنى وحيد</li></ol>
      <ol class="xp-dict-senses"><li id="senses-single-invalid" style="margin-inline-start:5px">Off-scale single meaning</li></ol>
      <ol class="xp-dict-senses"><li id="senses-rtl-single-invalid" dir="rtl" style="margin-inline-start:5px">معنى وحيد</li></ol>
      <ol class="xp-dict-senses"><li id="senses-other" style="margin-top:5px">Other margins stay checked</li><li>Another meaning</li></ol>
      <div id="senses-wrong-tag" class="xp-dict-senses" style="padding-left:1.4em">This is not a prose list</div>
    </body></html>`;
    await page.route('https://audit.test/md-preview.html', route => route.fulfill({ contentType: 'text/html', body }));
    await page.goto('https://audit.test/md-preview.html');
    proseHits.set(size, await page.evaluate(probe, cfg));
    await page.close();
  }
}
const spacingAt = (size, id, prop) => proseHits.get(size).some(hit => hit.kind === 'spacingScale' && hit.path.endsWith(' > #' + id) && hit.prop === prop);
for (const size of [19, 27]) {
  test(`reader prose relative rhythm is accepted at ${size}px`, () => {
    for (const prop of ['margin-top', 'margin-bottom']) assert.equal(spacingAt(size, 'prose-relative', prop), false, prop);
    assert.equal(spacingAt(size, 'senses-relative', 'margin-left'), false);
    assert.equal(spacingAt(size, 'senses-rtl-relative', 'margin-right'), false);
  });
  test(`reader prose fixed dimensions cannot hide behind a matching first size or chrome token at ${size}px`, () => {
    for (const prop of ['margin-top', 'margin-bottom']) {
      assert.equal(spacingAt(size, 'prose-fixed', prop), size !== 19, prop);
      assert.equal(spacingAt(size, 'prose-token', prop), true, 'fixed 8px must not replace .5em');
    }
    for (const [prefix, prop] of [['senses', 'margin-left'], ['senses-rtl', 'margin-right']]) {
      assert.equal(spacingAt(size, prefix + '-fixed', prop), size !== 19);
      assert.equal(spacingAt(size, prefix + '-token', prop), true, 'fixed 24px must not replace 1.4em');
    }
  });
  // A lone sense keeps the 1.4em indent (dict redesign ruling 2026-10-26), so
  // it is held to the same em rhythm as a numbered one: the relative indent
  // passes at both sizes, an off-rhythm one does not.
  test(`single dictionary meanings keep the em indent in either direction at ${size}px`, () => {
    for (const id of ['senses-single', 'senses-rtl-single']) {
      for (const prop of ['margin-left', 'margin-right']) assert.equal(spacingAt(size, id, prop), false);
    }
    assert.equal(spacingAt(size, 'senses-single-invalid', 'margin-left'), true);
    assert.equal(spacingAt(size, 'senses-rtl-single-invalid', 'margin-right'), true);
  });
  test(`reader prose handling retains all other geometry checks at ${size}px`, () => {
    assert.equal(spacingAt(size, 'prose-other', 'padding-left'), true);
    assert.equal(spacingAt(size, 'senses-other', 'margin-top'), true);
    assert.equal(spacingAt(size, 'senses-wrong-tag', 'padding-left'), true);
    assert.equal(spacingAt(size, 'prose-control', 'margin-top'), true);
    assert.ok(proseHits.get(size).some(hit => hit.kind === 'controlRung' && hit.path === '#prose-control'));
  });
}
