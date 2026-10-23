#!/usr/bin/env node
// Explicit development audit entry point; verify.sh without args remains the CI gate.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getAuditCatalog } from './audit-catalog.mjs';
import { createAuditPlan, inferAuditImpact, parseAuditArgs } from './audit-plan.mjs';
import { validateAuditMatrices } from './audit-coverage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
export function readAuditChanges(options) {
  const base = options.base ? git(['merge-base', options.base, 'HEAD']).trim() : 'HEAD';
  const range = options.staged ? ['--cached'] : [base];
  const names = git(['diff', ...range, '--name-only', '-z']).split('\0').filter(Boolean);
  if (options.changed) names.push(...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
  return [...new Set(names)].map(path => {
    const patch = git(['diff', ...range, '--unified=1', '--', path]);
    const change = { path, patch };
    if (path === 'shared.js') {
      change.before = git(['show', base + ':' + path]);
      change.after = options.staged ? git(['show', ':' + path]) : readFileSync(resolve(ROOT, path), 'utf8');
    }
    return change;
  });
}

export function jobInvocation(job, report, index = 0) {
  const env = { ...process.env };
  if (job.font === 'ci') env.FONTCONFIG_FILE = resolve(ROOT, 'scripts/ci-fonts.conf');
  else delete env.FONTCONFIG_FILE;
  const files = { qa: 'scripts/qa-drive.mjs', render: 'scripts/ui-render-audit.mjs', site: 'tests/pinboard-theme-render-tests.mjs', help: 'scripts/options-help-render-audit.mjs' };
  let args;
  if (job.runner === 'html') args = ['.qa-scan/run-test.mjs', job.file];
  else if (job.runner === 'node') args = [job.file, ...job.args];
  else {
    args = [files[job.runner], '--audit-scenario=' + job.scenarios.join(','), '--audit-report=' + report];
    for (const [axis, values] of Object.entries(job.axes)) args.push('--audit-' + axis + '=' + values.join(','));
    if (job.runner === 'qa') {
      args.push('--check', '--label', 'audit-' + basename(dirname(report)).slice(-16).replace(/[^a-zA-Z0-9_-]/g, '-') + '-' + index);
      if (!job.headed) args.push('--headless');
      if (job.fault) args.push('--fault', job.fault);
    }
  }
  if (!args[0]) throw new Error('Unknown audit runner: ' + job.runner);
  return { command: process.execPath, args, env, cwd: ROOT };
}

export function validateJobCoverage(job, coverage) {
  if (coverage.runner !== job.runner || !Array.isArray(coverage.expected) || !Array.isArray(coverage.completed) || !Array.isArray(coverage.missing)) throw new Error('Invalid runner coverage report');
  const completed = new Set(coverage.completed.map(r => r.id));
  if (coverage.missing.length || job.scenarios.some(id => !completed.has(id) || !coverage.expected.includes(id))) throw new Error('Selected scenarios missing from runner coverage');
  if (coverage.expected.some(id => !job.scenarios.includes(id))) throw new Error('Unexpected scenario in runner coverage');
  if (coverage.completed.some(row => row.runs < 1 || row.detail?.status === 'failed')) throw new Error('Failed scenario in runner coverage');
  const axesKey = axes => JSON.stringify(Object.entries(axes || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, values.map(String).sort()]));
  if (axesKey(job.axes) !== axesKey(coverage.axes)) throw new Error('Runner coverage axes differ from the requested job');
  validateAuditMatrices(job, coverage);
}

async function main(argv) {
  if (argv.includes('--help')) {
    console.log('Usage: node scripts/audit.mjs --changed|--staged|--base=<ref>|--all|--surface=<names>|--scenario=<IDs> [--plan] [--report=<file>]\nFilters: --kind --feature --theme --scheme --locale --viewport --dpr --font --density --state --input --fault --data --tier\n--list prints the selected scenario catalog. Same-axis values use commas; different axes intersect.');
    return;
  }
  const options = parseAuditArgs(argv), catalog = getAuditCatalog();
  let impact = null;
  if (options.changed || options.staged || options.base) {
    const consumers = readdirSync(ROOT).filter(p => /\.(js|html)$/.test(p) && p !== 'shared.js').map(path => ({ path, source: options.staged ? (() => { try { return git(['show', ':' + path]); } catch { return ''; } })() : readFileSync(resolve(ROOT, path), 'utf8') }));
    impact = inferAuditImpact(catalog, readAuditChanges(options), { consumers });
  }
  const plan = createAuditPlan(catalog, options, impact);
  if (options.plan || options.list) { writeFileSync(1, JSON.stringify(plan, null, 2) + '\n'); return; }
  const output = options.report ? resolve(options.report) : resolve(mkdtempSync(resolve(tmpdir(), 'pbp-audit-')), 'report.json');
  mkdirSync(dirname(output), { recursive: true });
  const evidence = mkdtempSync(output + '.runs-');
  const report = { schemaVersion: 1, plan, expected: plan.scenarios.map(r => r.id), completed: [], jobs: [], missing: [], passed: false };
  const writeReport = () => { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); };
  console.log(`[audit] ${plan.scenarios.length} scenarios, ${plan.jobs.length} jobs; report ${output}`);
  for (const warning of plan.warnings) console.warn('[audit] ' + warning);
  let failed = false;
  const started = performance.now();
  for (const [index, job] of plan.jobs.entries()) {
    const detailFile = resolve(evidence, index + '.json');
    const invocation = jobInvocation(job, detailFile, index);
    console.log(`[audit ${index + 1}/${plan.jobs.length}] ${job.runner}: ${job.scenarios.join(', ')}`);
    const began = performance.now();
    const result = await new Promise(resolveResult => {
      const child = spawn(invocation.command, invocation.args, { cwd: ROOT, env: invocation.env, stdio: 'inherit' });
      child.once('error', error => resolveResult({ code: null, error: error.message }));
      child.once('close', (code, signal) => resolveResult({ code, signal }));
    });
    let coverage = null;
    if (result.code === 0 && !['node', 'html'].includes(job.runner)) {
      try {
        coverage = JSON.parse(readFileSync(detailFile, 'utf8'));
        validateJobCoverage(job, coverage);
      } catch (error) { result.error = error.message; }
    }
    const passed = result.code === 0 && !result.error;
    report.jobs.push({ ...job, ...result, passed, durationMs: Math.round(performance.now() - began), report: coverage ? detailFile : null });
    if (passed) report.completed.push(...job.scenarios);
    else failed = true;
    report.completed = [...new Set(report.completed)];
    report.missing = report.expected.filter(id => !report.completed.includes(id));
    report.durationMs = Math.round(performance.now() - started);
    writeReport();
    if (!passed) { console.error('[audit] Failed job; remaining jobs were not started.'); break; }
  }
  report.passed = !failed && !report.missing.length && report.jobs.length === plan.jobs.length;
  writeReport();
  console.log(`[audit] ${report.passed ? 'PASS' : 'FAIL'} ${report.completed.length}/${report.expected.length}; ${report.durationMs}ms; ${output}`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error('[audit] ' + error.message); process.exitCode = 1; });
}
