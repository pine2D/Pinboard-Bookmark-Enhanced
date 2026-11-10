// Self-test for scripts/coverage-report.mjs. Runs the real page runner with
// coverage on a tiny fixture page (tests/fixtures/coverage-fixture.html) and
// checks the merge: a called function is not listed, an uncalled one is, and a
// function that only ran through a sliced copy (new Function) is still listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { executedSet, functionsOf, isInside, mergeCoverage, renderMarkdown, reportDir } from '../scripts/coverage-report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_JS = 'tests/fixtures/coverage-fixture.js';
const dir = mkdtempSync(join(tmpdir(), 'pbp-coverage-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('functionsOf names declarations, arrows bound to a const and methods', () => {
  const fns = functionsOf(readFileSync(join(ROOT, FIXTURE_JS), 'utf8'));
  assert.deepEqual(fns.map((f) => [f.name, f.line]), [['calledFn', 2], ['uncalledFn', 3], ['slicedOnlyFn', 4], ['arrowCalled', 5], ['method', 6]]);
});

test('executedSet: count 0 or no V8 entry means not run; the whole-script entry is ignored', () => {
  const text = 'function a() {}\nfunction b() {}\nfunction c() {}\n';
  const fns = functionsOf(text);
  // Hand-written in the shape of the DevTools protocol's Profiler.FunctionCoverage.
  const v8 = [
    { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }] },
    { functionName: 'a', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 15, count: 2 }] },
    { functionName: 'b', isBlockCoverage: true, ranges: [{ startOffset: 16, endOffset: 31, count: 0 }] },
  ];
  assert.deepEqual([...executedSet(fns, v8)], [0]);
});

test('the real runner with PBP_COVERAGE_DIR: called vs uncalled vs only sliced', () => {
  const raw = join(dir, 'raw');
  const r = spawnSync(process.execPath, ['.qa-scan/run-test.mjs', 'tests/fixtures/coverage-fixture.html'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, PBP_COVERAGE_DIR: raw },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const docs = readdirSync(raw).map((n) => JSON.parse(readFileSync(join(raw, n), 'utf8')));
  assert.equal(docs.length, 1);
  assert.ok(docs[0].entries.every((e) => !('source' in e)), 'raw coverage carries no source text');
  const summary = mergeCoverage(docs, { root: ROOT, files: [FIXTURE_JS] });
  const s = summary.files[FIXTURE_JS];
  const never = s.neverRun.map((f) => f.name);
  assert.ok(!never.includes('calledFn'), 'a called function is not listed');
  assert.ok(!never.includes('arrowCalled') && !never.includes('method'), 'a called arrow and method are not listed');
  assert.ok(never.includes('uncalledFn'), 'an uncalled function is listed');
  assert.ok(never.includes('slicedOnlyFn'), 'a function run only through a sliced copy is still listed');
  assert.deepEqual(s.loadedBy, ['tests/fixtures/coverage-fixture.html']);
  assert.ok(summary.anonymousRan >= 1, 'the sliced copy shows up as an anonymous script');
  const md = renderMarkdown(summary);
  assert.match(md, /new Function/);
  assert.match(md, /- slicedOnlyFn \(line 4\)/);
  assert.doesNotMatch(md, /- calledFn/);
});

test('a runtime file no page loaded lists every function and says so', () => {
  const summary = mergeCoverage([{ page: 'tests/x.html', entries: [] }], { root: ROOT, files: [FIXTURE_JS] });
  assert.equal(summary.files[FIXTURE_JS].neverRun.length, 5);
  assert.match(renderMarkdown(summary), /not loaded by any page/);
});

test('a relative PBP_QA_REPORT_DIR is made absolute before the inside-repo check', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = reportDir({ PBP_QA_REPORT_DIR: 'out' }, root);
  assert.equal(dir, join(root, 'out', 'coverage'));
  assert.ok(isInside(dir, root));
  assert.ok(!isInside('/elsewhere/coverage', root));
  const r = spawnSync(process.execPath, ['scripts/coverage-report.mjs'], { cwd: root, encoding: 'utf8', env: { ...process.env, PBP_QA_REPORT_DIR: '.cov-should-not-exist' } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /refusing to write inside the repo/);
  assert.ok(!readdirSync(root).includes('.cov-should-not-exist'));
});
