import test from 'node:test';
import assert from 'node:assert/strict';
import { getAuditCatalog } from '../scripts/audit-catalog.mjs';
import { addedIconKeys, createAuditPlan, inferAuditImpact, parseAuditArgs } from '../scripts/audit-plan.mjs';

const catalog = getAuditCatalog();
const plan = (...args) => createAuditPlan(catalog, parseAuditArgs(args));
test('every declared surface supports meaningful scenario selection', () => {
  for (const surface of ['popup', 'options', 'library', 'reader', 'site', 'background']) {
    const p = plan('--surface=' + surface, '--plan');
    assert.ok(p.scenarios.length > 0, surface);
    assert.ok(p.jobs.length > 0, surface);
  }
});
test('popup and options narrow selection never schedule library or reader', () => {
  for (const id of ['qa.popup.login', 'qa.options.panel.ai']) {
    const p = plan('--scenario=' + id);
    assert.deepEqual(p.scenarios.map(s => s.id), [id]);
    assert.equal(p.jobs.length, 1);
    assert.equal(p.jobs[0].runner, 'qa');
  }
});
test('cross-surface flows keep declared dependencies and explain their ownership', () => {
  const p = plan('--scenario=qa.discovery.reader-setup');
  assert.ok(p.scenarios[0].surfaces.includes('options'));
  assert.ok(p.scenarios[0].surfaces.includes('reader'));
});
test('multidimensional plan passes only supported axes to each runner', () => {
  const p = plan('--scenario=help.options.field', '--locale=en', '--dpr=1.25', '--font=ci');
  assert.deepEqual(p.jobs[0].axes, { locale: ['en'], dpr: ['1.25'], font: ['ci'] });
  assert.equal(p.jobs[0].font, 'ci');
});
test('conflicting theme/scheme and unsupported axes fail before execution', () => {
  assert.throws(() => plan('--scenario=site.tag-cloud', '--theme=terminal', '--scheme=light'), /combination/i);
  assert.throws(() => plan('--scenario=qa.popup.login', '--locale=xx'), /Unsupported/);
  assert.throws(() => plan('--scenario=qa.themes.popup', '--theme=dracula', '--scheme=light'), /combination/i);
});
test('file influence follows module ownership and includes reasons', () => {
  const impact = inferAuditImpact(catalog, [{ path: 'listbox.js' }]);
  assert.ok(impact.ids.some(id => id.includes('options')));
  assert.ok(impact.ids.some(id => id.includes('library')));
  assert.ok(catalog.filter(r => impact.ids.includes(r.id) && ['qa', 'render', 'help'].includes(r.runner)).every(r => r.surfaces.every(s => ['options', 'library'].includes(s))));
  assert.ok(impact.reasons.every(r => r.reason));
});
test('explicit unknown scopes and empty plans cannot report green', () => {
  assert.throws(() => plan('--surface=popupp'), /Unknown/);
  assert.throws(() => plan('--scenario=help.options.field', '--surface=popup'), /No scenarios/);
  assert.throws(() => parseAuditArgs(['--surfaec=popup']), /Unknown/);
  assert.throws(() => parseAuditArgs([]), /Choose/);
  assert.throws(() => parseAuditArgs(['--all', '--surface=popup']), /cannot/);
});
test('dependency state runs once with its own setup defaults', () => {
  const p = plan('--scenario=render.library.sweep.notes-color-menu', '--state=notes-color-menu');
  assert.equal(p.jobs.length, 1);
  assert.deepEqual(p.jobs[0].scenarios, ['render.library.sweep.notes-detail', 'render.library.sweep.notes-color-menu']);
  assert.deepEqual(p.scenarios[0].selectedAxes, {});
});
test('new icon consumers do not cause unrelated browser surfaces', () => {
  const before = 'const PBP_ICONS = {\n  check: \'<svg></svg>\',\n};';
  const after = 'const PBP_ICONS = {\n  check: \'<svg></svg>\',\n  clock: \'<svg><path/></svg>\',\n};';
  assert.deepEqual(addedIconKeys(before, after), ['clock']);
  assert.equal(addedIconKeys(before, after + '\nfunction changed() {}'), null);
  const impact = inferAuditImpact(catalog, [{ path: 'shared.js', before, after }], { consumers: [{ path: 'md-preview.js', source: 'PBP_ICONS.clock' }] });
  const browserRows = catalog.filter(r => impact.ids.includes(r.id) && ['qa', 'render', 'help', 'site'].includes(r.runner));
  assert.ok(browserRows.length);
  assert.ok(browserRows.every(r => r.surfaces.every(s => ['reader', 'md-preview'].includes(s))));
});
test('surface recommendations retain cross-surface security gates and runner inputs', () => {
  assert.ok(inferAuditImpact(catalog, [{ path: 'options.js' }]).ids.includes('static.network-exits'));
  assert.ok(inferAuditImpact(catalog, [{ path: 'scripts/ui-render-audit.mjs' }]).ids.some(id => id.startsWith('render.')));
  assert.ok(plan('--surface=options').scenarios.some(row => row.id === 'test.tag-gov-layout'));
});
test('input, fixture and execution-tier classifications select registered scenarios', () => {
  assert.ok(plan('--input=keyboard').scenarios.some(row => row.id === 'qa.reader.controls.editor'));
  assert.deepEqual(plan('--data=saved-history').scenarios.map(row => row.id), ['qa.reader.controls.history']);
  assert.ok(plan('--surface=popup', '--tier=smoke').scenarios.some(row => row.id === 'qa.popup.login'));
});
test('full catalog and surface selections preserve all registered scenario identities', () => {
  const full = plan('--all');
  assert.equal(new Set(full.scenarios.map(s => s.id)).size, catalog.length);
  const union = new Set(['popup', 'options', 'library', 'reader', 'site', 'background', 'tooling'].flatMap(s => plan('--surface=' + s).scenarios.map(r => r.id)));
  assert.deepEqual([...union].sort(), catalog.map(s => s.id).sort());
});
