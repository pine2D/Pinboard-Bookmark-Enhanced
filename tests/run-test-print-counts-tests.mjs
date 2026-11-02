// Self-test of `.qa-scan/run-test.mjs --print-counts`: it must not report a page
// as finished because the row count paused (a case that waits a second or two),
// and it must still notice rows beyond the registered number. Runs a copy of the
// runner against synthetic pages in a temp tree (Node + bundled Chromium).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const tree = mkdtempSync(join(tmpdir(), 'pbp-print-counts-'));
mkdirSync(join(tree, '.qa-scan')); mkdirSync(join(tree, 'tests'));
symlinkSync(join(repo, '.qa-scan/node_modules'), join(tree, '.qa-scan/node_modules'));
const source = readFileSync(join(repo, '.qa-scan/run-test.mjs'), 'utf8');
// The synthetic pages wait in real time, so this suite is scaled down: every page delay above one second, every quiet window of the runner
// copy and its stall deadline are multiplied by SCALE, which keeps each ratio the cases depend on (a pause shorter than the window it must
// survive, a late row still inside it). Delays of a second or less stay as they are because the runner polls every 100ms and the order of
// events a few hundred ms apart matters. The real runner is untouched.
const SCALE = 0.5;
const t = ms => ms <= 1000 ? ms : Math.round(ms * SCALE);
const sec = n => n * SCALE;
// Each patch must actually change the runner copy: a moved table or default would otherwise leave the real deadlines and no registered pages.
const patchOnce = (text, from, to, what) => {
  assert.equal(text.split(from).length, 2, what + ' moved or is not unique in the runner');
  return text.replace(from, () => to);
};
let shortened = patchOnce(source, ': 30000;', ': 16000;', 'the TEST_TIMEOUT_MS default');
// The quiet windows: 3s default, 1.5s with a trusted end signal, 10s while #summary is still empty.
shortened = patchOnce(shortened, 'trusted: false, windowMs: 3000 }', `trusted: false, windowMs: ${3000 * SCALE} }`, 'the initial quiet window');
shortened = patchOnce(shortened, 'seen.trusted ? 1500 : summary && !summaryFilled ? 10000 : 3000;', `seen.trusted ? ${1500 * SCALE} : summary && !summaryFilled ? ${10000 * SCALE} : ${3000 * SCALE};`, 'the quiet-window choice');
shortened = patchOnce(shortened, 'watch ? watch.windowMs : 3000', `watch ? watch.windowMs : ${3000 * SCALE}`, 'the sampled quiet window');
const registered = shortened.replace('Object.freeze({', 'Object.freeze({\n  "tests/gap-tests.html": 3,\n  "tests/extra-tests.html": 2,\n  "tests/low-tests.html": 2,\n  "tests/summary-tests.html": 2,\n  "tests/title-tests.html": 2,\n  "tests/short-tests.html": 3,\n  "tests/early-tests.html": 2,\n  "tests/late-tests.html": 2,\n  "tests/latesum-tests.html": 2,\n  "tests/sigstall-tests.html": 3,\n  "tests/fmt-tests.html": 2,\n  "tests/g1-tests.html": 3,\n  "tests/g2-tests.html": 2,');
assert.notEqual(registered, shortened, 'the EXPECTED_RESULTS table moved');
// A 16s outer deadline (instead of 30s; about 9s of waiting for rows) so the UNCONFIRMED cases below end quickly.
writeFileSync(join(tree, '.qa-scan/run-test.mjs'), registered);
writeFileSync(join(tree, '.qa-scan/package.json'), '{"type":"module"}');
// rows: [[delayMs, class], ...] appended one by one after load.
const page = (name, rows) => writeFileSync(join(tree, 'tests', name), `<!doctype html><meta charset=utf-8><title>${name}</title><body><script>
for (const [delay, cls] of ${JSON.stringify(rows)}) setTimeout(() => { const d = document.createElement('div'); d.className = cls; d.textContent = cls; document.body.append(d); }, delay);
</script>`);
// Pauses of 2.2s between rows: longer than any "count held still" heuristic a few seconds wide would tolerate.
page('gap-tests.html', [[0, 'pass'], [t(2200), 'pass'], [t(4400), 'pass']]);
page('extra-tests.html', [[0, 'pass'], [t(100), 'pass'], [t(900), 'pass']]);
page('unreg-tests.html', [[0, 'pass'], [t(2200), 'pass']]);
// A registered count that is too low: the third row arrives 2s after the second.
page('low-tests.html', [[0, 'pass'], [t(100), 'pass'], [t(2100), 'pass']]);
// Pages that announce their own end: the extra row comes after any plausible quiet window.
writeFileSync(join(tree, 'tests/summary-tests.html'), `<!doctype html><meta charset=utf-8><title>summary</title><body><div id="summary"></div><script>
const add = () => { const d = document.createElement('div'); d.className = 'pass'; d.textContent = 'ok'; document.body.append(d); };
add(); setTimeout(add, ${t(100)}); setTimeout(add, ${t(4000)});
setTimeout(() => { document.getElementById('summary').textContent = '3 passed, 0 failed'; }, ${t(4100)});
</script>`);
writeFileSync(join(tree, 'tests/title-tests.html'), `<!doctype html><meta charset=utf-8><title>title</title><body><script>
const add = () => { const d = document.createElement('div'); d.className = 'pass'; d.textContent = 'ok'; document.body.append(d); };
add(); setTimeout(add, ${t(100)}); setTimeout(() => { document.title = 'PASS title'; }, ${t(300)});
</script>`);
// A title that says PASS from the start (some suites write theirs at load) while rows still come.
writeFileSync(join(tree, 'tests/early-tests.html'), `<!doctype html><meta charset=utf-8><title>PASS early</title><body><script>
const add = () => { const d = document.createElement('div'); d.className = 'pass'; d.textContent = 'ok'; document.body.append(d); };
add(); setTimeout(add, ${t(800)}); setTimeout(add, ${t(1400)});
</script>`);
// A signal that is already there at load, with a row coming 2s after the registered count was reached.
const rows3 = `add(); setTimeout(add, ${t(100)}); setTimeout(add, ${t(2100)});`;
const add = `const add = () => { const d = document.createElement('div'); d.className = 'pass'; d.textContent = 'ok'; document.body.append(d); };`;
for (const name of ['late-tests.html', 'lateunreg-tests.html']) {
  writeFileSync(join(tree, 'tests', name), `<!doctype html><meta charset=utf-8><title>PASS late</title><body><script>${add} ${rows3}</script>`);
}
writeFileSync(join(tree, 'tests/latesum-tests.html'), `<!doctype html><meta charset=utf-8><title>latesum</title><body><div id="summary"></div><script>${add}
document.getElementById('summary').textContent = 'SUMMARY: 2 passed, 0 failed'; ${rows3}</script>`);
// Announces its end after 2 rows, but 3 are registered.
writeFileSync(join(tree, 'tests/sigstall-tests.html'), `<!doctype html><meta charset=utf-8><title>sigstall</title><body><script>${add}
add(); setTimeout(add, ${t(100)}); setTimeout(() => { document.title = 'PASS sigstall'; }, ${t(300)});</script>`);
// Another summary format (pass=N fail=M, as ten suites write it), filled in at the end.
writeFileSync(join(tree, 'tests/fmt-tests.html'), `<!doctype html><meta charset=utf-8><title>fmt</title><body><div id="summary"></div><script>${add}
add(); setTimeout(add, ${t(100)}); setTimeout(() => { document.getElementById('summary').textContent = 'pass=2 fail=0'; }, ${t(300)});</script>`);
// Unregistered, #summary still empty through a 3.5s pause, filled after the last row (md-video shape).
writeFileSync(join(tree, 'tests/slowsum-tests.html'), `<!doctype html><meta charset=utf-8><title>slowsum</title><body><div id="summary"></div><script>${add}
add(); setTimeout(add, ${t(100)}); setTimeout(add, ${t(3600)}); setTimeout(() => { document.getElementById('summary').textContent = '3 passed, 0 failed'; }, ${t(3700)});</script>`);
// g1: registered 3, the title says PASS after two rows, then a row comes at once and another 2s later.
writeFileSync(join(tree, 'tests/g1-tests.html'), `<!doctype html><meta charset=utf-8><title>g1</title><body><script>${add}
add(); setTimeout(add, ${t(100)}); setTimeout(() => { document.title = 'PASS g1'; }, ${t(300)}); setTimeout(add, ${t(400)}); setTimeout(add, ${t(2400)});</script>`);
// g2: registered 2, title PASS and both rows already there at load, a third row 2s later.
writeFileSync(join(tree, 'tests/g2-tests.html'), `<!doctype html><meta charset=utf-8><title>PASS g2</title><body><script>${add}
add(); add(); setTimeout(add, ${t(2000)});</script>`);
// g3: unregistered, a trusted-looking signal after two rows, a third row 2s after it.
writeFileSync(join(tree, 'tests/g3-tests.html'), `<!doctype html><meta charset=utf-8><title>g3</title><body><script>${add}
add(); setTimeout(add, ${t(100)}); setTimeout(() => { document.title = 'PASS g3'; }, ${t(300)}); setTimeout(add, ${t(2300)});</script>`);
// Registered 3, only one row ever appears.
page('short-tests.html', [[0, 'pass']]);
// One run per page (several cases read different facts from the same output), all started up front with at most POOL at a time: each
// run is mostly waiting on a timer, so overlapping them keeps the suite short, and the pool stays small so a busy machine does not delay
// a 100ms poll enough to move a row across a quiet window.
const POOL = 4;
const runs = new Map();
const waiting = [];
let active = 0;
const launch = file => new Promise(resolve => {
  const start = () => {
    active++;
    const child = spawn(process.execPath, [join(tree, '.qa-scan/run-test.mjs'), '--print-counts', 'tests/' + file], { cwd: tree });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('close', status => { clearTimeout(timer); active--; resolve({ stdout, stderr, status }); const next = waiting.shift(); if (next) next(); });
  };
  if (active < POOL) start(); else waiting.push(start);
});
const run = file => {
  if (!runs.has(file)) runs.set(file, launch(file));
  return runs.get(file);
};
// The slowest pages (the two that end UNCONFIRMED) go first so they overlap everything else.
for (const file of ['short-tests.html', 'sigstall-tests.html', ...readdirSync(join(tree, 'tests'))]) run(file);
test.after(() => rmSync(tree, { recursive: true, force: true }));

test('a registered page with a pause longer than 1.5s is counted to its end', async () => {
  const r = await run('gap-tests.html');
  assert.match(r.stdout, /total=3 expected=3 match/, r.stdout + r.stderr);
  assert.equal(r.status, 0);
});
test('rows beyond the registered number are reported as DIFFERS', async () => {
  const r = await run('extra-tests.html');
  assert.match(r.stdout, /total=3 expected=2 DIFFERS \(\+1\)/, r.stdout + r.stderr);
});
test('an unregistered page with a 2.2s pause still gets both rows counted', async () => {
  const r = await run('unreg-tests.html');
  assert.match(r.stdout, /total=2 expected=unregistered NOT REGISTERED/, r.stdout + r.stderr);
});

test('a registered count that is too low is not trusted when more rows follow a 2s pause', async () => {
  const r = await run('low-tests.html');
  assert.match(r.stdout, /total=3 expected=2 DIFFERS \(\+1\)/, r.stdout + r.stderr);
});
test('a match without a page-side end signal says what the tool could not see', async () => {
  const r = await run('extra-tests.html');
  assert.match(r.stdout, /later rows are not seen|silent/i, r.stdout);
});
test('a #summary line "N passed, M failed" ends the page, however late the last row came', async () => {
  const r = await run('summary-tests.html');
  assert.match(r.stdout, /total=3 expected=2 DIFFERS \(\+1\)/, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /silent|not seen/i, r.stdout);
});
test('a PASS/FAIL document title ends the page without the silence caveat', async () => {
  const r = await run('title-tests.html');
  assert.match(r.stdout, /total=2 expected=2 match/, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /silent|not seen/i, r.stdout);
});
test('a page that never reaches its registered count is UNCONFIRMED and exits 1', async () => {
  const r = await run('short-tests.html');
  assert.match(r.stdout, /UNCONFIRMED/, r.stdout + r.stderr);
  assert.equal(r.status, 1);
});
test('a signal written at load does not end the page while rows keep coming', async () => {
  const r = await run('early-tests.html');
  assert.match(r.stdout, /total=3 expected=2 DIFFERS \(\+1\)/, r.stdout + r.stderr);
});

test('a signal already showing at load is not trusted: a row 2s after the registered count is still counted', async () => {
  const r = await run('late-tests.html');
  assert.match(r.stdout, /total=3 expected=2 DIFFERS \(\+1\)/, r.stdout + r.stderr);
  assert.match(r.stdout, /later rows are not seen/, r.stdout);
});
test('the same holds for a #summary line written at load', async () => {
  const r = await run('latesum-tests.html');
  assert.match(r.stdout, /total=3 expected=2 DIFFERS \(\+1\)/, r.stdout + r.stderr);
});
test('an unregistered page waits at least 3s whatever its signal says', async () => {
  const r = await run('lateunreg-tests.html');
  assert.match(r.stdout, /total=3 expected=unregistered NOT REGISTERED/, r.stdout + r.stderr);
});
test('the note names the quiet window that was used', async () => {
  const r = await run('extra-tests.html');
  assert.match(r.stdout, new RegExp('no new row for ' + sec(3) + 's'), r.stdout);
});
test('a page that announces its end below the registered count is UNCONFIRMED, not a smaller "actual" count', async () => {
  const r = await run('sigstall-tests.html');
  assert.match(r.stdout, /UNCONFIRMED/, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /DIFFERS/, r.stdout);
  assert.equal(r.status, 1);
});
test('a summary in the "pass=N fail=M" format counts as the page filling in its result', async () => {
  const r = await run('fmt-tests.html');
  assert.match(r.stdout, /total=2 expected=2 match/, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /not seen|no new row/, r.stdout);
  assert.equal(r.status, 0);
});

test('an unregistered page with an empty #summary is waited out past a 3.5s pause', async () => {
  const r = await run('slowsum-tests.html');
  assert.match(r.stdout, /total=3 expected=unregistered NOT REGISTERED/, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /no trusted end signal/, r.stdout);
  assert.match(r.stdout, /unregistered.*later rows are not seen/, r.stdout);
});
test('a row that comes after the signal makes the signal untrusted', async () => {
  const r = await run('g1-tests.html');
  assert.match(r.stdout, /total=4 expected=3 DIFFERS \(\+1\)/, r.stdout + r.stderr);
  assert.match(r.stdout, /later rows are not seen/, r.stdout);
});
test('a signal that was showing at the first poll is untrusted even with no row after it appeared', async () => {
  const r = await run('g2-tests.html');
  assert.match(r.stdout, /total=3 expected=2 DIFFERS \(\+1\)/, r.stdout + r.stderr);
});
test('an unregistered page does not shorten its window to follow a signal', async () => {
  const r = await run('g3-tests.html');
  assert.match(r.stdout, /total=3 expected=unregistered NOT REGISTERED/, r.stdout + r.stderr);
});
