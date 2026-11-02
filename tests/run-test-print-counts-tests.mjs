// Self-test of `.qa-scan/run-test.mjs --print-counts`: it must not report a page
// as finished because the row count paused (a case that waits a second or two),
// and it must still notice rows beyond the registered number. Runs a copy of the
// runner against synthetic pages in a temp tree (Node + bundled Chromium).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const tree = mkdtempSync(join(tmpdir(), 'pbp-print-counts-'));
mkdirSync(join(tree, '.qa-scan')); mkdirSync(join(tree, 'tests'));
symlinkSync(join(repo, '.qa-scan/node_modules'), join(tree, '.qa-scan/node_modules'));
const source = readFileSync(join(repo, '.qa-scan/run-test.mjs'), 'utf8');
assert.ok(source.includes('Object.freeze({'), 'the EXPECTED_RESULTS table moved');
writeFileSync(join(tree, '.qa-scan/run-test.mjs'), source.replace('Object.freeze({', 'Object.freeze({\n  "tests/gap-tests.html": 3,\n  "tests/extra-tests.html": 2,'));
writeFileSync(join(tree, '.qa-scan/package.json'), '{"type":"module"}');
// rows: [[delayMs, class], ...] appended one by one after load.
const page = (name, rows) => writeFileSync(join(tree, 'tests', name), `<!doctype html><meta charset=utf-8><title>${name}</title><body><script>
for (const [delay, cls] of ${JSON.stringify(rows)}) setTimeout(() => { const d = document.createElement('div'); d.className = cls; d.textContent = cls; document.body.append(d); }, delay);
</script>`);
// Pauses of 2.2s between rows: longer than any "count held still" heuristic a few seconds wide would tolerate.
page('gap-tests.html', [[0, 'pass'], [2200, 'pass'], [4400, 'pass']]);
page('extra-tests.html', [[0, 'pass'], [100, 'pass'], [900, 'pass']]);
page('unreg-tests.html', [[0, 'pass'], [2200, 'pass']]);
const run = file => spawnSync(process.execPath, [join(tree, '.qa-scan/run-test.mjs'), '--print-counts', 'tests/' + file], { cwd: tree, encoding: 'utf8', timeout: 90000 });
test.after(() => rmSync(tree, { recursive: true, force: true }));

test('a registered page with a pause longer than 1.5s is counted to its end', () => {
  const r = run('gap-tests.html');
  assert.match(r.stdout, /total=3 expected=3 match/, r.stdout + r.stderr);
  assert.equal(r.status, 0);
});
test('rows beyond the registered number are reported as DIFFERS', () => {
  const r = run('extra-tests.html');
  assert.match(r.stdout, /total=3 expected=2 DIFFERS \(\+1\)/, r.stdout + r.stderr);
});
test('an unregistered page with a 2.2s pause still gets both rows counted', () => {
  const r = run('unreg-tests.html');
  assert.match(r.stdout, /total=2 expected=unregistered NOT REGISTERED/, r.stdout + r.stderr);
});
