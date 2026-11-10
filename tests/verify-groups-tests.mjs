// Self-test for the scripts/verify.sh groups and the retry/flake path.
// Node only, no browser. Part 1 reads the real command list through
// PBP_VERIFY_DRY=1 and checks that the four groups split it exactly. Part 2
// copies verify.sh, run-html-suites.mjs and flake-record.mjs into a throwaway
// git repo whose every gate command is a stub, then makes chosen stubs fail
// once or always and checks what verify.sh and the page runner do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordFlake, tailLines } from '../scripts/flake-record.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = ['static', 'pages', 'render', 'journeys'];
// Gate commands in `sh scripts/verify.sh` at 34a8a91c, the commit before the
// groups existed, counted with PBP_RENDER_SHARDS=4 the way the dry list counts
// them: one per tests/audit*-tests.mjs file, one per HTML page, one per
// render shard, the syntax loop as one, every other command line as one.
// Measured by running that verify.sh with logging stubs for node/npx/sh on
// PATH. The list may grow; it may only shrink by lowering this on purpose.
const PRE_CHANGE_COMMANDS = 148;
// The [verify-groups] stage added one command (this test), so dropping any
// older gate must still show up.
const ADDED_WITH_GROUPS = 1;
// Stage labels in run order. The first and second lines of every stage stay
// as they were; [verify-groups] is the one stage this change added.
const STAGES = ['audit-scope', 'verify-groups', 'bookmark-services', 'ask-history', 'mutate-check', 'run-test',
  'selection', 'draft', 'options-save', 'translate-stop', 'layouts', 'journey', 'discovery', 'reader-save-export',
  'syntax', 'eslint', 'eslint-silent-catch', 'eslint-baseline', 'script-graph', 'vendor-lock', 'network-exits',
  'ui-contract', 'popup-label-fit', 'md-preview-contrast', 'ui-vocabulary', 'render-audit', 'options-help-render',
  'docs-lint', 'registers', 'rules-lint', 'store-descriptions', 'hooks', 'theme'];
const JOURNEY_STAGES = ['bookmark-services', 'ask-history', 'selection', 'draft', 'options-save', 'translate-stop',
  'layouts', 'journey', 'discovery', 'reader-save-export'];

// Environment without anything from the caller's CI or retry settings.
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(PBP_|GITHUB_|STUB_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function verify(cwd, args, env) {
  const r = spawnSync('sh', ['scripts/verify.sh', ...args], { cwd, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function dry(args) {
  const r = verify(ROOT, args, cleanEnv({ PBP_VERIFY_DRY: '1', PBP_RENDER_SHARDS: '4' }));
  const commands = [];
  const stages = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\[dry\]\[([^\]]+)\] (.+)$/.exec(line);
    if (m) commands.push({ group: m[1], command: m[2] });
    else {
      const s = /^\[([a-z-]+)\] /.exec(line);
      if (s && s[1] !== 'verify') stages.push(s[1]);
    }
  }
  return { ...r, commands, stages };
}

const key = (c) => `${c.group}\t${c.command}`;

// ---------- Part 1: the real command list ----------

const full = dry([]);

test('no-argument dry run lists every gate command', () => {
  assert.equal(full.status, 0, full.stderr);
  assert.ok(full.commands.length >= PRE_CHANGE_COMMANDS + ADDED_WITH_GROUPS,
    `dry run lists ${full.commands.length} commands, fewer than the ${PRE_CHANGE_COMMANDS} before the groups existed plus ${ADDED_WITH_GROUPS} added with them`);
  for (const c of full.commands) assert.ok(GROUPS.includes(c.group), `unknown group tag ${c.group}`);
});

test('stage labels keep their order', () => {
  assert.deepEqual(full.stages, STAGES);
});

test('--all lists exactly what no argument lists', () => {
  const all = dry(['--all']);
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(all.commands, full.commands);
});

const byGroup = Object.fromEntries(GROUPS.map((g) => [g, dry([`--group=${g}`])]));

test('each group is non-empty and only lists its own commands', () => {
  for (const g of GROUPS) {
    const r = byGroup[g];
    assert.equal(r.status, 0, `${g}: ${r.stderr}`);
    assert.ok(r.commands.length > 0, `group ${g} is empty`);
    for (const c of r.commands) assert.equal(c.group, g, `group ${g} printed a ${c.group} command: ${c.command}`);
    assert.deepEqual(r.commands, full.commands.filter((c) => c.group === g), `group ${g} differs from its part of the full list`);
  }
});

test('the four groups together are the full list, same commands, same counts', () => {
  const count = (list) => list.reduce((m, c) => m.set(key(c), (m.get(key(c)) || 0) + 1), new Map());
  const union = GROUPS.flatMap((g) => byGroup[g].commands);
  assert.equal(union.length, full.commands.length);
  assert.deepEqual(count(union), count(full.commands));
});

test('no command belongs to two groups', () => {
  const owners = new Map();
  for (const g of GROUPS) {
    for (const c of byGroup[g].commands) {
      if (!owners.has(c.command)) owners.set(c.command, new Set());
      owners.get(c.command).add(g);
    }
  }
  const shared = [...owners].filter(([, set]) => set.size > 1).map(([cmd, set]) => `${cmd} (${[...set].join(', ')})`);
  assert.deepEqual(shared, []);
});

test('group membership matches what each gate needs', () => {
  const stagesOf = (g) => byGroup[g].stages;
  assert.deepEqual(stagesOf('journeys'), JOURNEY_STAGES);
  for (const s of ['render-audit', 'options-help-render']) assert.ok(stagesOf('render').includes(s), `render group lacks ${s}`);
  const commandsOf = (g) => byGroup[g].commands.map((c) => c.command);
  assert.ok(commandsOf('static').includes('node tests/verify-groups-tests.mjs'), 'this test must run in the static group');
  assert.ok(commandsOf('pages').some((c) => /^node \.qa-scan\/run-test\.mjs tests\/.+-tests\.html$/.test(c)), 'pages must list the HTML pages');
  const pages = readdirSync(join(ROOT, 'tests')).filter((n) => n.endsWith('-tests.html')).map((n) => `node .qa-scan/run-test.mjs tests/${n}`);
  assert.deepEqual(commandsOf('pages').filter((c) => c.includes('run-test.mjs tests/')).sort(), pages.sort(), 'every HTML page is listed once');
  for (const c of commandsOf('static')) assert.doesNotMatch(c, /qa-drive|ui-render-audit|run-test\.mjs/, `static must not hold browser gate ${c}`);
});

test('several groups run in stage order, whatever order they are given', () => {
  const want = full.commands.filter((c) => c.group === 'static' || c.group === 'render');
  assert.deepEqual(dry(['--group=render,static']).commands, want);
  assert.deepEqual(dry(['--group=render', '--group=static']).commands, want);
  assert.deepEqual(dry(['--group=static,static']).commands, byGroup.static.commands);
});

test('bad --group use exits non-zero and runs nothing', () => {
  for (const args of [['--group=bogus'], ['--group=static,bogus'], ['--group='], ['--group=static,'], ['--group=,static'], ['--group=static,,pages'], ['--group'],
    ['--group', 'static'], ['--group=static', '--changed'], ['--all', '--group=static'], ['--group=*']]) {
    const r = dry(args);
    assert.notEqual(r.status, 0, `${args.join(' ')} must fail`);
    assert.equal(r.commands.length, 0, `${args.join(' ')} must not list commands`);
    assert.match(r.stderr, /\[verify\]/, `${args.join(' ')} must say why`);
  }
});

test('other arguments still go to scripts/audit.mjs', () => {
  const viaVerify = verify(ROOT, ['--help'], cleanEnv({ PBP_VERIFY_DRY: '1' }));
  const direct = spawnSync(process.execPath, ['scripts/audit.mjs', '--help'], { cwd: ROOT, env: cleanEnv(), encoding: 'utf8' });
  assert.equal(viaVerify.status, 0, viaVerify.stderr);
  assert.equal(viaVerify.stdout, direct.stdout);
  assert.doesNotMatch(viaVerify.stdout, /\[dry\]/);
});

// ---------- Part 2: retry and flake recording, in a stub repo ----------

const STUB = `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const key = [relative(process.cwd(), fileURLToPath(import.meta.url)), ...process.argv.slice(2)].join(' ');
const state = process.env.STUB_STATE;
appendFileSync(join(state, 'calls.log'), key + '\\n');
const has = (name) => (process.env[name] || '').split('|').includes(key);
if (has('STUB_SLOW')) await new Promise((r) => setTimeout(r, 700));
if (has('STUB_FAIL_ALWAYS')) { console.log('stub: always failing ' + key); process.exit(3); }
if (has('STUB_FAIL_ONCE')) {
  const flag = join(state, encodeURIComponent(key));
  if (!existsSync(flag)) { writeFileSync(flag, ''); console.log('stub: failing once ' + key); process.exit(4); }
}
console.log('stub ok ' + key);
`;

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pbp-verify-groups-'));
  const put = (rel, body, mode) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
    if (mode) chmodSync(join(dir, rel), mode);
  };
  for (const rel of ['scripts/verify.sh', 'scripts/run-html-suites.mjs', 'scripts/flake-record.mjs']) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(dir, rel));
  }
  const real = new Set(['scripts/verify.sh', 'scripts/run-html-suites.mjs', 'scripts/flake-record.mjs']);
  for (const c of full.commands) {
    for (const token of c.command.split(' ')) {
      if (!/^(tests|scripts|docs)\/\S+\.(mjs|sh)$/.test(token) || real.has(token)) continue;
      put(token, token.endsWith('.sh') ? '#!/bin/sh\nexit 0\n' : STUB);
    }
  }
  for (const page of ['md-convert', 'a', 'b', 'c']) put(`tests/${page}-tests.html`, '<!doctype html>\n');
  put('.qa-scan/run-test.mjs', STUB);
  mkdirSync(join(dir, '.qa-scan/node_modules/playwright'), { recursive: true });
  // npx would reach for the network; the eslint gate gets a stub on PATH.
  put('.bin/npx', '#!/bin/sh\necho "stub npx $*"\n', 0o755);
  const git = spawnSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(git.status, 0, 'git init');
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: dir }).status, 0, 'git add');
  return dir;
}

const box = makeSandbox();
test.after(() => rmSync(box, { recursive: true, force: true }));

function run(args, extra = {}) {
  const state = join(box, '.state');
  const report = join(box, '.report');
  rmSync(state, { recursive: true, force: true });
  rmSync(report, { recursive: true, force: true });
  mkdirSync(state);
  if (extra.prepare) extra.prepare(report);
  const env = cleanEnv({
    PATH: `${join(box, '.bin')}:${process.env.PATH}`, STUB_STATE: state, PBP_QA_REPORT_DIR: report,
    PBP_RENDER_SHARDS: '4', PBP_PAGE_JOBS: '2', GITHUB_SHA: 'sandbox-sha', ...extra.env,
  });
  const r = verify(box, args, env);
  const callsFile = join(state, 'calls.log');
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n') : [];
  const flakesFile = join(report, 'flakes.jsonl');
  let flakes = [];
  try { flakes = readFileSync(flakesFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { flakes = []; }
  return { ...r, calls, flakes, report, out: r.stdout + r.stderr };
}
const retry = { PBP_RETRY_FLAKY: '1' };
const times = (calls, k) => calls.filter((c) => c === k).length;

test('stub repo: every group passes when nothing fails', () => {
  for (const g of GROUPS) {
    const r = run([`--group=${g}`], { env: retry });
    assert.equal(r.status, 0, `${g}: ${r.out}`);
    assert.deepEqual(r.flakes, []);
  }
  const all = run([]);
  assert.equal(all.status, 0, all.out);
  assert.match(all.stdout, /\[verify\] all checks passed\n$/);
});

test('journeys: fails once, retry on -> passes and records one flake', () => {
  const r = run(['--group=journeys'], { env: { ...retry, STUB_FAIL_ONCE: 'tests/ask-history-tests.mjs' } });
  assert.equal(r.status, 0, r.out);
  assert.equal(times(r.calls, 'tests/ask-history-tests.mjs'), 2);
  assert.equal(r.flakes.length, 1);
  const f = r.flakes[0];
  assert.deepEqual(Object.keys(f).sort(), ['date', 'firstFailure', 'sha', 'stage', 'target']);
  assert.equal(f.stage, 'ask-history');
  assert.equal(f.target, 'node tests/ask-history-tests.mjs');
  assert.equal(f.sha, 'sandbox-sha');
  assert.match(f.firstFailure, /failing once/);
  assert.ok(!Number.isNaN(Date.parse(f.date)));
  assert.ok(existsSync(join(r.report, 'verify-logs/ask-history-1.log')));
  assert.ok(existsSync(join(r.report, 'verify-logs/ask-history-1.retry.log')));
});

test('journeys: fails once, retry off -> fails at once, nothing recorded', () => {
  const r = run(['--group=journeys'], { env: { STUB_FAIL_ONCE: 'tests/ask-history-tests.mjs' } });
  assert.notEqual(r.status, 0);
  assert.equal(times(r.calls, 'tests/ask-history-tests.mjs'), 1);
  assert.ok(!r.calls.includes('tests/library-ask-history-tests.mjs'), 'later gates must not run');
  assert.deepEqual(r.flakes, []);
});

test('journeys: fails twice, retry on -> fails with the command exit code', () => {
  const r = run(['--group=journeys'], { env: { ...retry, STUB_FAIL_ALWAYS: 'tests/library-ask-history-tests.mjs' } });
  assert.equal(r.status, 3, r.out);
  assert.equal(times(r.calls, 'tests/library-ask-history-tests.mjs'), 2);
  assert.ok(!r.calls.some((c) => c.startsWith('scripts/qa-drive.mjs')), 'later gates must not run');
  assert.deepEqual(r.flakes, []);
});

test('render: a shard that fails once is retried alone and recorded', () => {
  const shard = 'scripts/ui-render-audit.mjs --shard=2/4';
  const r = run(['--group=render'], { env: { ...retry, STUB_FAIL_ONCE: shard } });
  assert.equal(r.status, 0, r.out);
  assert.equal(times(r.calls, shard), 2);
  assert.equal(times(r.calls, 'scripts/ui-render-audit.mjs --shard=1/4'), 1);
  assert.equal(r.flakes.length, 1);
  assert.equal(r.flakes[0].stage, 'render-audit');
  assert.equal(r.flakes[0].target, 'node ' + shard);
  for (const f of ['shard-0.log', 'shard-2.log', 'shard-2.retry.log']) assert.ok(existsSync(join(r.report, 'render-audit', f)), f);
});

test('render: shard failures without retry, or twice, fail', () => {
  const shard = 'scripts/ui-render-audit.mjs --shard=2/4';
  const once = run(['--group=render'], { env: { STUB_FAIL_ONCE: shard } });
  assert.notEqual(once.status, 0);
  assert.equal(times(once.calls, shard), 1);
  const always = run(['--group=render'], { env: { ...retry, STUB_FAIL_ALWAYS: shard } });
  assert.notEqual(always.status, 0);
  assert.equal(times(always.calls, shard), 2);
  assert.deepEqual(always.flakes, []);
});

test('render: a single-command gate is retried like journeys', () => {
  const r = run(['--group=render'], { env: { ...retry, STUB_FAIL_ONCE: 'scripts/options-help-render-audit.mjs' } });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.flakes.length, 1);
  assert.equal(r.flakes[0].stage, 'options-help-render');
});

test('static never retries, even with PBP_RETRY_FLAKY=1', () => {
  const r = run(['--group=static'], { env: { ...retry, STUB_FAIL_ONCE: 'scripts/docs-lint.mjs' } });
  assert.notEqual(r.status, 0);
  assert.equal(times(r.calls, 'scripts/docs-lint.mjs'), 1);
  assert.deepEqual(r.flakes, []);
});

test('pages: fails once, retry on -> passes, flake recorded, both tries in the log', () => {
  const page = '.qa-scan/run-test.mjs tests/b-tests.html';
  const r = run(['--group=pages'], { env: { ...retry, STUB_FAIL_ONCE: page } });
  assert.equal(r.status, 0, r.out);
  assert.equal(times(r.calls, page), 2);
  assert.equal(r.flakes.length, 1);
  assert.equal(r.flakes[0].stage, 'browser');
  assert.equal(r.flakes[0].target, 'tests/b-tests.html');
  const log = readFileSync(join(r.report, 'html-suites/b-tests.log'), 'utf8');
  assert.match(log, /failing once/);
  assert.match(log, /stub ok/);
  assert.ok(existsSync(join(r.report, 'html-suites/a-tests.log')));
});

test('pages: failures without retry, or twice, exit 1 and name the page', () => {
  const page = '.qa-scan/run-test.mjs tests/b-tests.html';
  const once = run(['--group=pages'], { env: { STUB_FAIL_ONCE: page } });
  assert.equal(once.status, 1);
  assert.equal(times(once.calls, page), 1);
  assert.equal(once.calls.length, 4, 'the other pages still run');
  assert.match(once.stderr, /1 suite\(s\) failed\n\s+tests\/b-tests\.html/);
  const always = run(['--group=pages'], { env: { ...retry, STUB_FAIL_ALWAYS: page } });
  assert.equal(always.status, 1);
  assert.equal(times(always.calls, page), 2);
  assert.deepEqual(always.flakes, []);
});

test('pages: parallel output comes back in file name order; one job keeps the old order', () => {
  const browserLines = (s) => s.split('\n').filter((l) => /^\[browser\] tests\/\S+$/.test(l));
  const par = run(['--group=pages'], { env: { PBP_PAGE_JOBS: '4', STUB_SLOW: '.qa-scan/run-test.mjs tests/a-tests.html' } });
  assert.equal(par.status, 0, par.out);
  assert.deepEqual(browserLines(par.stdout), ['a', 'b', 'c', 'md-convert'].map((p) => `[browser] tests/${p}-tests.html`));
  const serial = run(['--group=pages'], { env: { PBP_PAGE_JOBS: '1' } });
  assert.equal(serial.status, 0, serial.out);
  const order = ['md-convert', 'a', 'b', 'c'].map((p) => `.qa-scan/run-test.mjs tests/${p}-tests.html`);
  assert.deepEqual(serial.calls.filter((c) => c.startsWith('.qa-scan/run-test.mjs ')), order);
  assert.deepEqual(browserLines(serial.stdout), order.map((c) => `[browser] ${c.split(' ')[1]}`));
});

test('a broken flake file warns loudly but changes no verdict', () => {
  const brokenFile = (report) => mkdirSync(join(report, 'flakes.jsonl'), { recursive: true });
  const j = run(['--group=journeys'], { env: { ...retry, STUB_FAIL_ONCE: 'tests/ask-history-tests.mjs' }, prepare: brokenFile });
  assert.equal(j.status, 0, j.out);
  assert.match(j.stderr, /could not record/);
  const p = run(['--group=pages'], { env: { ...retry, STUB_FAIL_ONCE: '.qa-scan/run-test.mjs tests/c-tests.html' }, prepare: brokenFile });
  assert.equal(p.status, 0, p.out);
  assert.match(p.out, /could not record/);
  const fail = run(['--group=journeys'], { env: { ...retry, STUB_FAIL_ALWAYS: 'tests/ask-history-tests.mjs' }, prepare: brokenFile });
  assert.notEqual(fail.status, 0);
});

test('under GitHub Actions a flake prints ::warning:: and joins the step summary', () => {
  const summaryDir = mkdtempSync(join(tmpdir(), 'pbp-verify-summary-'));
  try {
    const summary = join(summaryDir, 'summary.md');
    const r = run(['--group=journeys'], { env: { ...retry, STUB_FAIL_ONCE: 'tests/ask-history-tests.mjs', GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^::warning title=Flaky%3A ask-history::node tests\/ask-history-tests\.mjs failed once/m);
    assert.match(readFileSync(summary, 'utf8'), /ask-history.*node tests\/ask-history-tests\.mjs/);
  } finally {
    rmSync(summaryDir, { recursive: true, force: true });
  }
});

test('recordFlake keeps the last lines of the first failure and escapes workflow commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbp-flake-unit-'));
  try {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    assert.equal(tailLines(lines).split('\n').length, 40);
    assert.match(tailLines(lines), /^line 20\nline 21/);
    let printed = '';
    const { entry } = recordFlake({ stage: 's,1', target: 'x%\ny', output: lines, env: { PBP_QA_REPORT_DIR: dir, GITHUB_SHA: 'abc', GITHUB_ACTIONS: 'true' }, out: { write: (s) => { printed += s; } } });
    assert.equal(entry.sha, 'abc');
    assert.equal(printed.split('\n').filter(Boolean).length, 1, 'one workflow command line');
    assert.match(printed, /^::warning title=Flaky%3A s%2C1::x%25%0Ay failed once/);
    const saved = readFileSync(join(dir, 'flakes.jsonl'), 'utf8').trim().split('\n');
    assert.equal(saved.length, 1);
    assert.deepEqual(JSON.parse(saved[0]), entry);
    assert.throws(() => recordFlake({ stage: '', target: 't', output: '', env: { PBP_QA_REPORT_DIR: dir } }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
