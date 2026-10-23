import test from 'node:test';
import assert from 'node:assert/strict';
import { jobInvocation, validateJobCoverage } from '../scripts/audit.mjs';
import { getAuditCatalog } from '../scripts/audit-catalog.mjs';
import { createAuditPlan, parseAuditArgs } from '../scripts/audit-plan.mjs';
import { existsSync } from 'node:fs';

test('every registered command refers to a real file', () => {
  for (const row of getAuditCatalog()) if (row.file) assert.ok(existsSync(row.file), row.id);
});
test('fonts, errors and actual axes reach runner arguments without shell interpolation', () => {
  const plan = createAuditPlan(getAuditCatalog(), parseAuditArgs(['--scenario=help.options.field', '--dpr=1.25', '--font=native,ci']));
  assert.equal(plan.jobs.length, 2);
  for (const job of plan.jobs) {
    const call = jobInvocation(job, '/tmp/audit report.json');
    assert.ok(call.args.includes('--audit-dpr=1.25'));
    assert.ok(call.args.includes('--audit-report=/tmp/audit report.json'));
    assert.equal(!!call.env.FONTCONFIG_FILE, job.font === 'ci');
  }
  const fault = createAuditPlan(getAuditCatalog(), parseAuditArgs(['--scenario=qa.fault.ai-429'])).jobs[0];
  assert.ok(jobInvocation(fault, '/tmp/report').args.includes('ai-429'));
});
test('coverage validates actual selected outcomes rather than process success alone', () => {
  const job = { runner: 'qa', scenarios: ['qa.popup.login'], font: 'native' };
  const good = () => ({ runner: 'qa', expected: ['qa.popup.login'], completed: [{ id: 'qa.popup.login', runs: 1, detail: { status: 'passed' }, details: [{ status: 'passed', cases: [{ font: 'native', dpr: 1 }] }] }], missing: [] });
  assert.doesNotThrow(() => validateJobCoverage(job, good()));
  assert.throws(() => validateJobCoverage(job, { ...good(), completed: [] }), /missing/);
  assert.throws(() => validateJobCoverage(job, { ...good(), runner: 'render' }), /Invalid/);
  assert.throws(() => validateJobCoverage(job, { ...good(), expected: [...good().expected, 'qa.library.notes'] }), /Unexpected/);
  assert.throws(() => validateJobCoverage({ ...job, axes: { dpr: ['1'] } }, good()), /axes differ/);
  const failure = good(); failure.completed[0].detail.status = 'failed';
  assert.throws(() => validateJobCoverage(job, failure), /Failed/);
});
