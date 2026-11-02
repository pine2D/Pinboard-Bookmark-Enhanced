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
assert.ok(source.includes(': 30000;'), 'the TEST_TIMEOUT_MS default moved');
// A 20s stall deadline (instead of 30s; about 13s of waiting) so the UNCONFIRMED case below ends quickly.
writeFileSync(join(tree, '.qa-scan/run-test.mjs'), source.replace(': 30000;', ': 20000;').replace('Object.freeze({', 'Object.freeze({\n  "tests/gap-tests.html": 3,\n  "tests/extra-tests.html": 2,\n  "tests/low-tests.html": 2,\n  "tests/summary-tests.html": 2,\n  "tests/title-tests.html": 2,\n  "tests/short-tests.html": 3,\n  "tests/early-tests.html": 2,\n  "tests/late-tests.html": 2,\n  "tests/latesum-tests.html": 2,\n  "tests/sigstall-tests.html": 3,\n  "tests/fmt-tests.html": 2,'));
writeFileSync(join(tree, '.qa-scan/package.json'), '{"type":"module"}');
// rows: [[delayMs, class], ...] appended one by one after load.
const page = (name, rows) => writeFileSync(join(tree, 'tests', name), `<!doctype html><meta charset=utf-8><title>${name}</title><body><script>
for (const [delay, cls] of ${JSON.stringify(rows)}) setTimeout(() => { const d = document.createElement('div'); d.className = cls; d.textContent = cls; document.body.append(d); }, delay);
</script>`);
// Pauses of 2.2s between rows: longer than any "count held still" heuristic a few seconds wide would tolerate.
page('gap-tests.html', [[0, 'pass'], [2200, 'pass'], [4400, 'pass']]);
page('extra-tests.html', [[0, 'pass'], [100, 'pass'], [900, 'pass']]);
page('unreg-tests.html', [[0, 'pass'], [2200, 'pass']]);
// A registered count that is too low: the third row arrives 2s after the second.
page('low-tests.html', [[0, 'pass'], [100, 'pass'], [2100, 'pass']]);
// Pages that announce their own end: the extra row comes after any plausible quiet window.
writeFileSync(join(tree, 'tests/summary-tests.html'), `<!doctype html><meta charset=utf-8><title>summary</title><body><div id="summary"></div><script>
const add = () => { const d = document.createElement('div'); d.className = 'pass'; d.textContent = 'ok'; document.body.append(d); };
add(); setTimeout(add, 100); setTimeout(add, 4000);
setTimeout(() => { document.getElementById('summary').textContent = '3 passed, 0 failed'; }, 4100);
</script>`);
writeFileSync(join(tree, 'tests/title-tests.html'), `<!doctype html><meta charset=utf-8><title>title</title><body><script>
const add = () => { const d = document.createElement('div'); d.className = 'pass'; d.textContent = 'ok'; document.body.append(d); };
add(); setTimeout(add, 100); setTimeout(() => { document.title = 'PASS title'; }, 300);
</script>`);
// A title that says PASS from the start (some suites write theirs at load) while rows still come.
writeFileSync(join(tree, 'tests/early-tests.html'), `<!doctype html><meta charset=utf-8><title>PASS early</title><body><script>
const add = () => { const d = document.createElement('div'); d.className = 'pass'; d.textContent = 'ok'; document.body.append(d); };
add(); setTimeout(add, 800); setTimeout(add, 1400);
</script>`);
// A signal that is already there at load, with a row coming 2s after the registered count was reached.
const rows3 = `add(); setTimeout(add, 100); setTimeout(add, 2100);`;
const add = `const add = () => { const d = document.createElement('div'); d.className = 'pass'; d.textContent = 'ok'; document.body.append(d); };`;
for (const name of ['late-tests.html', 'lateunreg-tests.html']) {
  writeFileSync(join(tree, 'tests', name), `<!doctype html><meta charset=utf-8><title>PASS late</title><body><script>${add} ${rows3}</script>`);
}
writeFileSync(join(tree, 'tests/latesum-tests.html'), `<!doctype html><meta charset=utf-8><title>latesum</title><body><div id="summary"></div><script>${add}
document.getElementById('summary').textContent = 'SUMMARY: 2 passed, 0 failed'; ${rows3}</script>`);
// Announces its end after 2 rows, but 3 are registered.
writeFileSync(join(tree, 'tests/sigstall-tests.html'), `<!doctype html><meta charset=utf-8><title>sigstall</title><body><script>${add}
add(); setTimeout(add, 100); setTimeout(() => { document.title = 'PASS sigstall'; }, 300);</script>`);
// Another summary format (pass=N fail=M, as ten suites write it), filled in at the end.
writeFileSync(join(tree, 'tests/fmt-tests.html'), `<!doctype html><meta charset=utf-8><title>fmt</title><body><div id="summary"></div><script>${add}
add(); setTimeout(add, 100); setTimeout(() => { document.getElementById('summary').textContent = 'pass=2 fail=0'; }, 300);</script>`);
// Registered 3, only one row ever appears.
page('short-tests.html', [[0, 'pass']]);
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

test('a registered count that is too low is not trusted when more rows follow a 2s pause', () => {
  const r = run('low-tests.html');
  assert.match(r.stdout, /total=3 expected=2 DIFFERS \(\+1\)/, r.stdout + r.stderr);
});
test('a match without a page-side end signal says what the tool could not see', () => {
  const r = run('extra-tests.html');
  assert.match(r.stdout, /later rows are not seen|silent/i, r.stdout);
});
test('a #summary line "N passed, M failed" ends the page, however late the last row came', () => {
  const r = run('summary-tests.html');
  assert.match(r.stdout, /total=3 expected=2 DIFFERS \(\+1\)/, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /silent|not seen/i, r.stdout);
});
test('a PASS/FAIL document title ends the page without the silence caveat', () => {
  const r = run('title-tests.html');
  assert.match(r.stdout, /total=2 expected=2 match/, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /silent|not seen/i, r.stdout);
});
test('a page that never reaches its registered count is UNCONFIRMED and exits 1', () => {
  const r = run('short-tests.html');
  assert.match(r.stdout, /UNCONFIRMED/, r.stdout + r.stderr);
  assert.equal(r.status, 1);
});
test('a signal written at load does not end the page while rows keep coming', () => {
  const r = run('early-tests.html');
  assert.match(r.stdout, /total=3 expected=2 DIFFERS \(\+1\)/, r.stdout + r.stderr);
});

test('a signal already showing at load is not trusted: a row 2s after the registered count is still counted', () => {
  const r = run('late-tests.html');
  assert.match(r.stdout, /total=3 expected=2 DIFFERS \(\+1\)/, r.stdout + r.stderr);
  assert.match(r.stdout, /later rows are not seen/, r.stdout);
});
test('the same holds for a #summary line written at load', () => {
  const r = run('latesum-tests.html');
  assert.match(r.stdout, /total=3 expected=2 DIFFERS \(\+1\)/, r.stdout + r.stderr);
});
test('an unregistered page waits at least 3s whatever its signal says', () => {
  const r = run('lateunreg-tests.html');
  assert.match(r.stdout, /total=3 expected=unregistered NOT REGISTERED/, r.stdout + r.stderr);
});
test('the note names the quiet window that was used', () => {
  const r = run('extra-tests.html');
  assert.match(r.stdout, /no new row for 3s/, r.stdout);
});
test('a page that announces its end below the registered count is UNCONFIRMED, not a smaller "actual" count', () => {
  const r = run('sigstall-tests.html');
  assert.match(r.stdout, /UNCONFIRMED/, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /DIFFERS/, r.stdout);
  assert.equal(r.status, 1);
});
test('a summary in the "pass=N fail=M" format counts as the page filling in its result', () => {
  const r = run('fmt-tests.html');
  assert.match(r.stdout, /total=2 expected=2 match/, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /not seen|no new row/, r.stdout);
  assert.equal(r.status, 0);
});
