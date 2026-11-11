// Self-test for scripts/sentinel-report.mjs. The tool outputs below are
// written by hand in the shape the real tools print (update-vendor.sh
// --check-only and npm outdated --json were run once to see it), not produced
// by this script, so a parser that only agrees with itself fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  vendorRecords, npmRecords, linkRecords, dueRecords, browserRecords, failedPages,
  buildReport, decide, escapeText, code, parseRecords,
} from '../scripts/sentinel-report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const kinds = (rs) => rs.map((r) => `${r.check}/${r.kind}/${r.subject}`);

const VENDOR_DRIFT = `Upstream drift check (--check-only): vendor-lock.json versions vs registry.npmjs.org latest.

  package       current     latest      status
  defuddle      0.19.4      0.19.6      BEHIND
  highlight.js  11.12.0     11.12.0     ok
  katex         ?           ?           manual (no lock entry at vendor/katex/katex.min.js)
  mermaid       12.1.0      ?           UNVERIFIED (fetch-error: network; not counted as drift, but NOT confirmed current either)

OpenRouter default-model liveness (the only provider-catalog check kept):
  openrouter    openai/gpt-oss-20b  DEAD (not in https://openrouter.ai/api/v1/models data[].id)

Result: ... Exit 2.
`;
test('vendor: BEHIND, manual and DEAD are findings; UNVERIFIED is a note; ok is silent', () => {
  const rs = vendorRecords(VENDOR_DRIFT, 2);
  assert.deepEqual(kinds(rs), ['vendor/finding/defuddle', 'vendor/finding/katex', 'vendor/note/mermaid', 'vendor/finding/openrouter openai/gpt-oss-20b']);
  assert.match(rs[0].message, /vendored 0\.19\.4, latest on npm 0\.19\.6/);
});
test('vendor: a clean run has no records; an unknown exit or unreadable drift is broken', () => {
  assert.deepEqual(vendorRecords('  highlight.js  11.12.0     11.12.0     ok\n', 0), []);
  assert.deepEqual(kinds(vendorRecords('', 127)), ['vendor/broken/scripts/update-vendor.sh --check-only']);
  assert.equal(vendorRecords('Result: drift\n', 1)[0].kind, 'broken');
});

const NPM = JSON.stringify({
  '@axe-core/playwright': { current: '4.10.2', wanted: '4.14.0', latest: '4.14.0', dependent: '.qa-scan', location: '/x/.qa-scan/node_modules/@axe-core/playwright' },
  playwright: { current: '1.59.1', wanted: '1.59.1', latest: '1.65.0', dependent: '.qa-scan', location: '/x/.qa-scan/node_modules/playwright' },
  pngjs: { current: '7.0.0', wanted: '7.0.0', latest: '7.0.0', dependent: '.qa-scan', location: '/x' },
}, null, 2);
test('npm: one finding per outdated package; playwright says the baselines need a re-check; no local path leaks', () => {
  const rs = npmRecords(NPM, 1);
  assert.deepEqual(kinds(rs), ['npm/finding/@axe-core/playwright', 'npm/finding/playwright']);
  assert.match(rs[1].message, /installed 1\.59\.1, latest 1\.65\.0.*render baselines/);
  assert.doesNotMatch(JSON.stringify(rs), /\/x\/|node_modules/);
  assert.deepEqual(npmRecords('', 0), []);
  assert.deepEqual(npmRecords('{}', 0), []);
  assert.deepEqual(kinds(npmRecords(NPM + '\nℹ Safe-chain: Some package versions were suppressed\n', 1)), kinds(npmRecords(NPM, 1)), 'a wrapper line after the JSON is ignored');
});
test('npm: exit 1 is not an error, other exits and bad JSON are broken', () => {
  assert.equal(npmRecords(NPM, 1).every((r) => r.kind === 'finding'), true);
  for (const [out, exit] of [[NPM, 254], ['not json', 1], ['{"error":{"code":"E404"}}', 1], ['{}', 1]]) assert.equal(npmRecords(out, exit)[0].kind, 'broken', `${out} ${exit}`);
});

const LINKS = { results: [
  { url: 'https://ok.org/', result: 'ok', detail: '200', files: ['README.md'] },
  { url: 'https://gone.org/', result: 'broken', detail: '404', files: ['README.md', 'docs/index.md'] },
  { url: 'https://wall.org/', result: 'unverifiable', detail: '403', files: ['docs/privacy.md'] },
], skipped: [] };
test('links: broken is a finding, unverifiable a note, ok nothing; a run that could not read the docs is broken', () => {
  const rs = linkRecords(LINKS, 1);
  assert.deepEqual(kinds(rs), ['links/finding/https://gone.org/', 'links/note/https://wall.org/']);
  assert.match(rs[0].message, /404, in README\.md, docs\/index\.md/);
  assert.equal(linkRecords(null, 2)[0].kind, 'broken');
  assert.equal(linkRecords({ results: [] }, 1)[0].kind, 'broken');
});

test('due: items and register problems are findings; a missing list is broken', () => {
  const rs = dueRecords({ today: '2026-11-11', within: 14, items: [
    { source: 'expiring-items', where: 'expiring-items.md:12', what: '复盘', due: '2026-11-18', daysLeft: 7 },
    { source: 'freshness', where: 'freshness-ledger.md:58', what: '夹具该再核实了', due: '2026-10-29', daysLeft: -13 },
  ], problems: ['acceptance-debt.md: 读不到文件（ENOENT）'] }, 2);
  assert.deepEqual(rs.map((r) => r.message), ['复盘: due 2026-11-18, in 7 days', '夹具该再核实了: due 2026-10-29, 13 days overdue', 'acceptance-debt.md: 读不到文件（ENOENT）']);
  assert.deepEqual(rs.map((r) => r.subject), ['expiring-items.md:12', 'freshness-ledger.md:58', '.claude/']);
  assert.equal(dueRecords(null, 1)[0].kind, 'broken');
  assert.deepEqual(dueRecords({ items: [], problems: [] }, 0), []);
});

const PAGES_LOG = `[browser] running 3 HTML suites
[browser] tests/a-tests.html
pass=3 fail=0
[browser] 2 suite(s) failed
  tests/b-tests.html  (log: /tmp/r/html-suites/b-tests.log)
  tests/c-tests.html  (log: /tmp/r/html-suites/c-tests.log)
`;
test('browser: names channel, version and page; a failed install is a finding, never broken', () => {
  assert.deepEqual(failedPages(PAGES_LOG), ['tests/b-tests.html', 'tests/c-tests.html']);
  const rs = browserRecords({ channel: 'beta', version: 'Google Chrome for Testing 143.0.7499.4 ', pagesLog: PAGES_LOG, pagesExit: 1, smokeExit: 1 });
  assert.deepEqual(rs.map((r) => `${r.subject}: ${r.message}`), [
    'tests/b-tests.html: fails on Chrome for Testing beta 143.0.7499.4',
    'tests/c-tests.html: fails on Chrome for Testing beta 143.0.7499.4',
    'scripts/zip-install-smoke.mjs: the release ZIP install smoke fails on Chrome for Testing beta 143.0.7499.4 (exit 1)',
  ]);
  assert.doesNotMatch(JSON.stringify(rs), /\/tmp\//, 'no log path');
  const inst = browserRecords({ channel: 'stable', installFailed: true });
  assert.equal(inst.length, 1); assert.equal(inst[0].kind, 'finding'); assert.equal(inst[0].subject, 'chrome@stable');
  assert.deepEqual(browserRecords({ channel: 'stable', version: '142.0.1' }), []);
  assert.match(browserRecords({ channel: 'stable', version: '142.0.1', pagesExit: 2, pagesLog: 'crash' })[0].message, /before naming a page/);
});

test('escaping: Markdown, HTML, mentions and code fences cannot break out', () => {
  assert.equal(escapeText('a|b <img> *x* @team #1'), 'a\\|b \\<img\\> \\*x\\* @​team \\#1');
  assert.equal(escapeText('line\nbreak'), 'line break');
  assert.equal(code('@axe-core/playwright'), '`@axe-core/playwright`');
  assert.equal(code('a`b'), '``a`b``');
  assert.equal(code('`x'), '`` `x ``');
  const r = buildReport({ records: [{ check: 'npm', kind: 'finding', subject: 'x`y', message: '</details><script>@here' }], event: 'schedule', runUrl: 'https://github.com/o/r/actions/runs/1', date: '2026-11-16' });
  assert.doesNotMatch(r.body, /<script>|<\/details>|@here/);
  assert.match(r.body, /``x`y``/);
});

const ONE = [{ check: 'npm', kind: 'finding', subject: 'eslint', message: 'installed 1, latest 2' }];
const NOTE = [{ check: 'links', kind: 'note', subject: 'https://wall.org/', message: 'could not be verified (403)' }];
test('decision: findings on schedule or manual runs write; nothing else does', () => {
  assert.equal(decide({ event: 'schedule', records: ONE }).write, true);
  assert.equal(decide({ event: 'workflow_dispatch', records: ONE }).write, true);
  assert.equal(decide({ event: 'workflow_dispatch', dryRun: true, records: ONE }).write, false);
  assert.equal(decide({ event: 'pull_request', records: ONE }).write, false);
  assert.equal(decide({ event: 'push', records: ONE }).write, false);
  for (const ev of ['schedule', 'workflow_dispatch', 'pull_request']) {
    assert.equal(decide({ event: ev, records: [] }).write, false, ev);
    assert.equal(decide({ event: ev, records: NOTE }).write, false, `${ev}: notes alone never write`);
  }
  assert.equal(decide({ event: 'schedule', records: [{ check: 'vendor', kind: 'broken', subject: 's', message: 'm' }] }).write, true, 'a broken check is reported');
});
test('report: no findings says so; pull request and dry run show "would update" and the body', () => {
  const none = buildReport({ records: NOTE, event: 'schedule', runUrl: 'u', date: 'd' });
  assert.equal(none.write, false); assert.match(none.summary, /no findings, so the issue is left alone/); assert.match(none.body, /No findings\./);
  assert.match(none.summary, /Notes for this run only/); assert.doesNotMatch(none.body, /wall\.org/, 'notes stay out of the issue');
  for (const opts of [{ event: 'pull_request' }, { event: 'workflow_dispatch', dryRun: true }]) {
    const r = buildReport({ records: ONE, runUrl: 'https://github.com/o/r/actions/runs/9', date: '2026-11-16', ...opts });
    assert.equal(r.write, false);
    assert.match(r.summary, /would update the issue/);
    assert.ok(r.summary.includes(r.body), 'the body that would be written is in the summary');
  }
});
test('report: body has the date, the run link, grouped findings and broken checks; the comment lists only this run', () => {
  const recs = [...ONE, ...NOTE, { check: 'vendor', kind: 'broken', subject: 'scripts/update-vendor.sh --check-only', message: 'exited 127' }];
  const r = buildReport({ records: recs, event: 'schedule', runUrl: 'https://github.com/o/r/actions/runs/7', sha: '0123456789abcdef', date: '2026-11-16' });
  assert.equal(r.write, true); assert.equal(r.broken, true);
  assert.match(r.body, /2026-11-16, \[run log\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/7\), commit `01234567`/);
  assert.match(r.body, /### Checks that could not run \(1\)[\s\S]*#### Vendored libraries/);
  assert.match(r.body, /### Findings \(1\)[\s\S]*#### \.qa-scan npm packages\n\n- `eslint`: installed 1, latest 2/);
  assert.match(r.comment, /^2026-11-16: 1 finding\(s\), 1 check\(s\) could not run\. \[Run log\]/);
  assert.equal(r.comment.split('\n').filter((l) => l.startsWith('- ')).length, 2);
  assert.doesNotMatch(r.comment, /wall\.org/);
});
test('records: a corrupt line becomes a broken record instead of vanishing', () => {
  const rs = parseRecords('{"check":"npm","kind":"finding","subject":"a","message":"b"}\nnot json\n{"check":"x","kind":"weird","subject":"","message":""}\n\n');
  assert.deepEqual(rs.map((r) => r.kind), ['finding', 'broken', 'broken']);
});

test('cli: add appends records, report writes body, comment, summary and outputs; pull_request never writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbp-sentinel-report-'));
  try {
    const f = join(dir, 'findings.jsonl');
    const cli = (...a) => spawnSync(process.execPath, [join(ROOT, 'scripts/sentinel-report.mjs'), ...a], { encoding: 'utf8' });
    writeFileSync(join(dir, 'npm.json'), NPM);
    assert.equal(cli('add', 'npm', '--findings', f, '--log', join(dir, 'npm.json'), '--exit', '1').status, 0);
    assert.equal(cli('add', 'browser', '--findings', f, '--channel', 'stable', '--install-failed').status, 0);
    assert.equal(readFileSync(f, 'utf8').trim().split('\n').length, 3);
    const out = (ev, dry) => {
      for (const n of ['summary.md', 'out.txt', 'body.md', 'comment.md']) rmSync(join(dir, n), { force: true });
      const r = cli('report', '--findings', f, '--event', ev, '--dry-run', dry, '--run-url', 'https://github.com/o/r/actions/runs/1', '--sha', 'abc', '--date', '2026-11-16',
        '--summary', join(dir, 'summary.md'), '--body', join(dir, 'body.md'), '--comment', join(dir, 'comment.md'), '--output', join(dir, 'out.txt'));
      assert.equal(r.status, 0, r.stderr);
      return { o: readFileSync(join(dir, 'out.txt'), 'utf8'), s: readFileSync(join(dir, 'summary.md'), 'utf8') };
    };
    assert.match(out('schedule', 'false').o, /^write=true\nbroken=false\n$/);
    const pr = out('pull_request', 'false');
    assert.match(pr.o, /write=false/); assert.match(pr.s, /would update the issue/);
    assert.match(out('workflow_dispatch', 'true').o, /write=false/);
    assert.ok(existsSync(join(dir, 'body.md')));
    rmSync(f);
    assert.match(out('schedule', 'false').o, /write=false/, 'no findings file means no findings');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
