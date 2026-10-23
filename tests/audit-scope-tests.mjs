import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSelection, readAuditFilters, selectAuditScenarios } from '../scripts/audit-scope.mjs';

const scenes = [
  { id: 'qa.popup.form', runner: 'qa', surfaces: ['popup'], kinds: ['layout'], features: ['save'], axes: { locale: ['en', 'de'], viewport: [360, 1280], scheme: ['light', 'dark'] } },
  { id: 'qa.options.provider', runner: 'qa', surfaces: ['options'], kinds: ['interaction'], features: ['ai'], axes: { locale: ['en', 'zh_CN'] } },
  { id: 'qa.reader.explain', runner: 'qa', surfaces: ['md-preview'], kinds: ['interaction'], axes: { scheme: ['light', 'dark'] } },
  { id: 'qa.reader.dict', runner: 'qa', surfaces: ['md-preview'], kinds: ['interaction'], dependencies: ['qa.reader.explain'], axes: { scheme: ['light', 'dark'] } },
  { id: 'qa.journey', runner: 'qa', surfaces: ['md-preview', 'library'], kinds: ['interaction'], axes: {} },
];
const filters = (...argv) => readAuditFilters(argv);

test('default selection preserves the entire catalog', () => {
  assert.deepEqual(selectAuditScenarios(scenes, filters()).map(s => s.id), scenes.map(s => s.id));
});
test('same dimension is a union; dimensions intersect before prerequisites expand', () => {
  const got = selectAuditScenarios(scenes, filters('--audit-surface=popup,options', '--audit-kind=layout', '--audit-locale=de', '--audit-viewport=360'));
  assert.deepEqual(got.map(s => s.id), ['qa.popup.form']);
  assert.deepEqual(got[0].selectedAxes.locale, ['de']);
});
test('explicit scenarios preserve dependency order and disclose the added prerequisite', () => {
  const got = selectAuditScenarios(scenes, filters('--audit-scenario=qa.reader.dict'));
  assert.deepEqual(got.map(s => s.id), ['qa.reader.explain', 'qa.reader.dict']);
  assert.equal(got[0].selectionReason, 'dependency of qa.reader.dict');
});
test('reader alias and cross-surface flows have real ownership', () => {
  assert.deepEqual(selectAuditScenarios(scenes, filters('--audit-surface=reader')).map(s => s.id), ['qa.reader.explain', 'qa.reader.dict', 'qa.journey']);
  assert.deepEqual(selectAuditScenarios(scenes, filters('--audit-surface=library')).map(s => s.id), ['qa.journey']);
});
test('unknown, empty, invalid combinations and misspelled switches cannot pass', () => {
  for (const arg of ['--audit-surface=missing', '--audit-scenario=typo', '--audit-locale=xx', '--audit-dpr=7']) {
    assert.throws(() => selectAuditScenarios(scenes, filters(arg)), /No scenarios|Unknown|Unsupported/i);
  }
  assert.throws(() => selectAuditScenarios(scenes, filters('--audit-surface=popup', '--audit-kind=interaction')), /No scenarios/i);
  assert.throws(() => filters('--audit-surface='), /empty/i);
  assert.throws(() => filters('--audit-scenrio=x'), /Unknown/i);
});
test('duplicate ids, missing dependencies and dependency cycles fail closed', () => {
  assert.throws(() => selectAuditScenarios([...scenes, scenes[0]], filters()), /Duplicate/);
  assert.throws(() => selectAuditScenarios([{ id: 'a', dependencies: ['b'] }], filters()), /dependency/);
  assert.throws(() => selectAuditScenarios([{ id: 'a', dependencies: ['b'] }, { id: 'b', dependencies: ['a'] }], filters()), /cycle/);
});
test('bounded scenario wildcards select only registered cases', () => {
  assert.deepEqual(selectAuditScenarios(scenes, filters('--audit-scenario=qa.popup.*')).map(s => s.id), ['qa.popup.form']);
});
test('partial execution retains numeric axes and detects missing or foreign completions', () => {
  const scope = auditSelection({ runner: 'qa', scenarios: scenes, argv: ['--audit-scenario=qa.popup.form', '--audit-viewport=360'] });
  assert.equal(scope.partial, true);
  assert.deepEqual(scope.values('qa.popup.form', 'viewport', [360, 1280]), [360]);
  assert.throws(() => scope.finish(), /not completed/i);
  assert.throws(() => scope.complete('unknown'), /not selected/i);
  scope.start('qa.popup.form'); scope.complete('qa.popup.form', { measured: 3 });
  assert.equal(scope.finish().completed.length, 1);
});
test('coverage report records expected and completed ids independently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbp-audit-scope-'));
  try {
    const report = join(dir, 'report.json');
    const scope = auditSelection({ runner: 'qa', scenarios: scenes, argv: ['--audit-scenario=qa.reader.dict', '--audit-report=' + report] });
    scope.complete('qa.reader.explain');
    assert.throws(() => scope.finish(), /not completed/);
    const data = JSON.parse(readFileSync(report, 'utf8'));
    assert.deepEqual(data.expected, ['qa.reader.explain', 'qa.reader.dict']);
    assert.deepEqual(data.missing, ['qa.reader.dict']);
    scope.complete('qa.reader.dict');
    assert.deepEqual(scope.finish().missing, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
