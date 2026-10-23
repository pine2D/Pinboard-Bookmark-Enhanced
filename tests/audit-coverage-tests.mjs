import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAuditMatrices } from '../scripts/audit-coverage.mjs';
import { auditSelection } from '../scripts/audit-scope.mjs';

const helpJob = { runner: 'help', font: 'native', scenarios: ['help.options.field'], axes: { locale: ['en', 'zh_CN'], dpr: ['1', '1.25'] } };
const helpCases = [
  { locale: 'en', dpr: 1, font: 'native' }, { locale: 'en', dpr: 1.25, font: 'native' },
  { locale: 'zh_CN', dpr: 1, font: 'native' }, { locale: 'zh_CN', dpr: 1.25, font: 'native' },
];
const report = (id, details) => ({ completed: [{ id, runs: details.length, detail: details.at(-1), details }] });

test('help requires every requested locale/DPR cell, not just a completed scenario id', () => {
  assert.throws(() => validateAuditMatrices(helpJob, report('help.options.field', helpCases.slice(0, 1))), /missing.*3|3.*missing/i);
  assert.doesNotThrow(() => validateAuditMatrices(helpJob, report('help.options.field', helpCases)));
});
test('duplicate cells cannot replace a missing cell, and foreign fonts cannot pass', () => {
  assert.throws(() => validateAuditMatrices(helpJob, report('help.options.field', [...helpCases.slice(0, 3), helpCases[0]])), /duplicate/i);
  assert.throws(() => validateAuditMatrices(helpJob, report('help.options.field', helpCases.map(c => ({ ...c, font: 'ci' })))), /unexpected|font/i);
});
test('default help coverage retains both locales and all four DPRs', () => {
  const job = { ...helpJob, axes: {} };
  assert.throws(() => validateAuditMatrices(job, report('help.options.field', helpCases)), /missing.*4|4.*missing/i);
  const full = [...helpCases,
    { locale: 'en', dpr: 1.5, font: 'native' }, { locale: 'en', dpr: 2, font: 'native' },
    { locale: 'zh_CN', dpr: 1.5, font: 'native' }, { locale: 'zh_CN', dpr: 2, font: 'native' }];
  assert.doesNotThrow(() => validateAuditMatrices(job, report('help.options.field', full)));
});
test('site requires every compatible theme and each selected viewport', () => {
  const job = { runner: 'site', font: 'native', scenarios: ['site.profile-layout'], axes: { theme: ['terminal', 'github-light'], viewport: ['320', '641'] } };
  const records = [
    { theme: 'terminal', scheme: 'dark', font: 'native', viewports: [320, 641] },
    { theme: 'github-light', scheme: 'light', font: 'native', viewports: [320, 641] },
  ];
  assert.doesNotThrow(() => validateAuditMatrices(job, report('site.profile-layout', records)));
  assert.throws(() => validateAuditMatrices(job, report('site.profile-layout', [records[0]])), /missing.*2|2.*missing/i);
  assert.throws(() => validateAuditMatrices(job, report('site.profile-layout', [records[0], { ...records[1], viewports: [320] }])), /missing.*1|1.*missing/i);
  assert.doesNotThrow(() => validateAuditMatrices({ ...job, axes: { ...job.axes, scheme: ['dark'] } }, report('site.profile-layout', [records[0]])));
});
test('coverage history snapshots each completion and echoes effective axes', () => {
  const scope = auditSelection({ runner: 'help', scenarios: [{ id: 'help.options.field', axes: { locale: ['en'], dpr: [1, 1.25] } }], argv: ['--audit-locale=en', '--audit-dpr=1,1.25'] });
  const detail = { locale: 'en', dpr: 1 };
  scope.complete('help.options.field', detail);
  detail.dpr = 1.25;
  scope.complete('help.options.field', detail);
  const result = scope.finish();
  assert.deepEqual(result.axes, { locale: ['en'], dpr: ['1', '1.25'] });
  assert.deepEqual(result.completed[0].axes, { locale: ['en'], dpr: [1, 1.25] });
  assert.deepEqual(result.completed[0].details, [{ locale: 'en', dpr: 1 }, { locale: 'en', dpr: 1.25 }]);
});
test('QA reader control evidence must include every requested locale and width', () => {
  const job = { runner: 'qa', font: 'native', scenarios: ['qa.reader.controls.ask'], axes: { locale: ['en', 'zh_CN'], viewport: ['320', '360'], scheme: ['light'], density: ['large'] } };
  const cases = [
    { font: 'native', dpr: 1, locale: 'en', viewport: 320, scheme: 'light', density: 'large' },
    { font: 'native', dpr: 1, locale: 'en', viewport: 360, scheme: 'light', density: 'large' },
    { font: 'native', dpr: 1, locale: 'zh_CN', viewport: 320, scheme: 'light', density: 'large' },
    { font: 'native', dpr: 1, locale: 'zh_CN', viewport: 360, scheme: 'light', density: 'large' },
  ];
  assert.throws(() => validateAuditMatrices(job, report(job.scenarios[0], [{ cases: cases.slice(0, 1) }])), /missing.*3|3.*missing/i);
  assert.doesNotThrow(() => validateAuditMatrices(job, report(job.scenarios[0], [{ cases }])));
  assert.throws(() => validateAuditMatrices(job, report(job.scenarios[0], [{ cases: [...cases, cases[0]] }])), /duplicate/i);
});
