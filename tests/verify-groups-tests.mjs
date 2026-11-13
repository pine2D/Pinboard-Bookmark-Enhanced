// Self-test for the scripts/verify.sh groups and the retry/flake path.
// Node only, no browser. Part 1 reads the real command list through
// PBP_VERIFY_DRY=1 and checks that the four groups split it exactly. Part 2
// copies verify.sh, run-html-suites.mjs and flake-record.mjs into a throwaway
// git repo whose every gate command is a stub, then makes chosen stubs fail
// once or always and checks what verify.sh and the page runner do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordFlake, tailLines } from '../scripts/flake-record.mjs';

// First thing, before anything is spawned: forget every git variable the
// caller handed down. A pre-commit hook, `git rebase -x` and `git bisect run`
// all export GIT_DIR and friends, and this file builds a throwaway repo at
// load time. With GIT_DIR inherited, its `git init` and `git add -A` rewrote
// the real repo once (2026-11-10). cleanEnv() below is the second line of
// defence, makeSandbox() checks where git really landed, and the last test
// in this file proves all of it against a decoy repo.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const GROUPS = ['static', 'pages', 'render', 'journeys'];
// The gates of `sh scripts/verify.sh` at 34a8a91c, the commit before the
// groups existed, written out by reading that script. Every one must still be
// in the no-argument dry list, so dropping a fixed gate fails here whatever
// else is added. Nothing here is generated from the current script.
// The glob parts are not frozen: tests/*-tests.html and tests/audit*-tests.mjs
// are compared with the directory live in the tests below.
// Two spellings changed with the groups, nothing else: the eslint line is now
// printed with `env` in front (a gate command cannot start with a variable
// assignment), and the syntax pipeline became the function check_js_syntax.
// The render audit ran as shards; with PBP_RENDER_SHARDS=4 that is four commands.
const OLD_FIXED_COMMANDS = [
  'node tests/bookmark-service-runtime-tests.mjs',
  'node tests/bookmark-live-preflight-tests.mjs',
  'node tests/ask-history-tests.mjs',
  'node tests/library-ask-history-tests.mjs',
  'node tests/mutate-check-tests.mjs',
  'node tests/run-test-print-counts-tests.mjs',
  'node scripts/qa-drive.mjs --headless --surfaces selection --check --label selection-default-contract',
  'node scripts/qa-drive.mjs --headless --surfaces selection --click-dismiss --check --label selection-click-contract',
  'node scripts/qa-drive.mjs --surfaces drafts --check --label popup-draft-contract',
  'node scripts/qa-drive.mjs --headless --surfaces options-save --check --label options-save-contract',
  'node scripts/qa-drive.mjs --headless --surfaces translate-stop --fault ai-429 --check --label translate-stop-contract',
  'node scripts/qa-drive.mjs --headless --surfaces layouts --check --label layouts-contract',
  'node scripts/qa-drive.mjs --headless --surfaces journey --check --label notes-edit-clear-contract',
  'node scripts/qa-drive.mjs --headless --surfaces discovery --check --label discovery-contract',
  'node scripts/qa-drive.mjs --headless --surfaces reader-bookmark,reader-export --check --label reader-save-export-contract',
  'env ESLINT_USE_FLAT_CONFIG=true npx --prefix .qa-scan eslint . --suppressions-location scripts/eslint-suppressions.json',
  'node tests/eslint-silent-catch-tests.mjs',
  'node tests/eslint-baseline-tests.mjs',
  'node scripts/script-graph-lint.mjs',
  'node scripts/vendor-lock-check.mjs',
  'node scripts/network-exits-check.mjs',
  'node tests/ui-contract-tests.mjs',
  'node tests/popup-label-fit-tests.mjs',
  'node tests/md-preview-contrast-tests.mjs',
  'node scripts/ui-vocabulary-lint.mjs',
  'node tests/ui-vocabulary-tests.mjs',
  'node scripts/options-help-render-audit.mjs',
  'node scripts/docs-lint.mjs',
  'node scripts/registers-lint.mjs',
  'node tests/registers-lint-tests.mjs',
  'node scripts/rules-lint.mjs',
  'node tests/rules-lint-tests.mjs',
  'node scripts/sync-store-descriptions.mjs --check',
  'sh scripts/setup-hooks.sh --check',
  'node docs/theme-surface/tools/validate-contracts.mjs',
  'node tests/theme-contract-tests.mjs',
  'node tests/theme-css-syntax-tests.mjs',
  'node tests/theme-tooling-tests.mjs',
  'node tests/theme-ui-derive-tests.mjs',
  'node tests/theme-media-audit-tests.mjs',
  'node tests/pinboard-theme-render-tests.mjs',
  'node tests/theme-override-debt-tests.mjs',
  'node tests/theme-sync-check-tests.mjs',
  'node docs/theme-surface/tools/diff-all.mjs --strict',
  'node docs/theme-surface/tools/token-coverage.mjs',
  'node docs/theme-surface/tools/cascade-lint.mjs',
  'node docs/theme-surface/tools/override-drift.mjs',
  'node docs/theme-surface/tools/override-debt.mjs',
  'node docs/theme-surface/tools/handedit-audit.mjs',
  'node docs/theme-surface/tools/css-region-audit.mjs',
  'node docs/theme-surface/tools/ui-token-coverage.mjs',
  'node docs/theme-surface/tools/contrast-audit.mjs',
  'node docs/theme-surface/tools/recipe-lint.mjs',
  'check_js_syntax',
  'node scripts/ui-render-audit.mjs --shard=0/4',
  'node scripts/ui-render-audit.mjs --shard=1/4',
  'node scripts/ui-render-audit.mjs --shard=2/4',
  'node scripts/ui-render-audit.mjs --shard=3/4',
];
// The stage label lines of 34a8a91c, verbatim and in order. Left out: the
// [browser] lines (their text holds a count) and the render-audit progress line.
// [verify-groups] is the one label this change added; it sits second.
const OLD_LABELS = [
  "[audit-scope] checking selection, dependencies, matrices and runner plans",
  "[bookmark-services] isolated primary-service UI and personal-library restore",
  "[ask-history] reader and library Ask history against an isolated archive",
  "[mutate-check] self-test: restore, exactly-once, crash backup",
  "[run-test] self-test: --print-counts waits for the registered count",
  "[selection] real pointer selection with native popover light-dismiss",
  "[draft] native popup close/reopen preserves unsaved edits",
  "[options-save] persistent feedback, retry and translated narrow layouts",
  "[translate-stop] HTTP 429 wait responds to Stop",
  "[layouts] nine locales, narrow settings, Ask width and popup semantics",
  "[journey] note editing, failure retry and clearing combined filters",
  "[discovery] source controls, AI setup and preset CSS",
  "[reader-save-export] bookmark completion and portable Q&A exports",
  "[syntax] checking JavaScript",
  "[eslint] correctness lint over runtime scripts (config: eslint.config.mjs)",
  "[eslint-silent-catch] checking the no-silent-catch rule against valid and invalid samples",
  "[eslint-baseline] checking the silent-catch baseline check against growing and shrinking samples",
  "[script-graph] checking executeScript page functions are closure-free",
  "[vendor-lock] verifying vendored artifacts against vendor/vendor-lock.json",
  "[network-exits] cross-checking runtime hosts vs docs/network-exits.json vs privacy.md",
  "[ui-contract] checking static UI contracts",
  "[popup-label-fit] checking every popup form label fits its column in every UI locale",
  "[md-preview-contrast] checking md-preview.css's light-dark token contrast pairs",
  "[ui-vocabulary] checking structural class tokens against the registry and the legacy baseline",
  "[render-audit] checking hand-written render oracle (contrast + geometry + media preferences)",
  "[options-help-render] checking semantic roles and raster alignment",
  "[docs-lint] checking README x9 mirror + prose contracts + .claude/expiring-items.md 临时事项 expiry dates",
  "[registers] checking .claude/ registers (decisions, acceptance debt, flake ledger, store ledger) + lint self-tests",
  "[rules-lint] checking CLAUDE.md index, rule files, skills, backticked references and number claims + lint self-tests",
  "[store-descriptions] checking CWS store copy is regenerated from the READMEs",
  "[hooks] checking installed git hooks still delegate to the tracked scripts",
  "[theme] checking generated theme integrity",
];
const NEW_LABEL = '[verify-groups] checking that the verify groups cover every gate exactly once';
// Added after the split (2026-11-10): the slice-anchor baseline, right after
// the eslint baseline it is modelled on, with its two static commands.
const SLICE_LABEL = '[slice-anchor] counting tests that cut runtime source by a marker against the shrink-only baseline + lint self-test';
const SLICE_COMMANDS = ['node scripts/slice-anchor-lint.mjs', 'node tests/slice-anchor-lint-tests.mjs'];
const afterEslintBaseline = OLD_LABELS.findIndex((l) => l.startsWith('[eslint-baseline]')) + 1;
// Reworded 2026-11-11: the registers stage names the fifth register, freshness-ledger.md.
const REGISTERS_LABEL_OLD = "[registers] checking .claude/ registers (decisions, acceptance debt, flake ledger, store ledger) + lint self-tests";
const DOCTOR_LABEL = '[doctor] checking the read-only local setup doctor in throwaway repos';
const SENTINEL_LABEL = "[sentinel] checking the weekly sentinel's link check and report against local fixtures";
const UPGRADE_LABEL = '[upgrade-path] store baseline upgrade to current tree';
const AI_PROVIDERS_LABEL = '[ai-providers] checking AI provider single-source sync and AST no-second-copy gate + self-tests';
const AI_PROVIDERS_COMMANDS = ['node scripts/sync-ai-providers.mjs --check', 'node tests/ai-providers-source-tests.mjs'];
const SETTINGS_SCHEMA_LABEL = '[settings-schema] checking settings schema single-source sync, DOM coverage and AST gate + self-tests';
const SETTINGS_SCHEMA_COMMANDS = ['node scripts/sync-settings-schema.mjs --check', 'node tests/settings-schema-tests.mjs'];
const TYPECHECK_LABEL = '[typecheck] checking JSDoc and null-safety types on the pure data-layer modules + self-tests';
const TYPECHECK_COMMANDS = ['node scripts/typecheck-data-layer.mjs', 'node tests/typecheck-data-layer-tests.mjs'];
const RUNTIME_MESSAGES_LABEL = '[runtime-messages] checking runtime message single-source sync, MV3 onMessage channel rules and AST parity + self-tests';
const RUNTIME_MESSAGES_COMMANDS = ['node scripts/sync-runtime-messages.mjs --check', 'node tests/runtime-messages-tests.mjs'];
const HARD_RULES_LABEL = '[hard-rules] checking sync storage write error handling and credential literal gates + self-tests';
const HARD_RULES_COMMANDS = ['node scripts/hard-rules-lint.mjs', 'node tests/hard-rules-lint-tests.mjs'];
const REGISTERS_LABEL = "[registers] checking .claude/ registers (decisions, acceptance debt, flake ledger, store ledger, freshness ledger) + lint self-tests";
const EXPECTED_LABELS = [OLD_LABELS[0], NEW_LABEL, ...OLD_LABELS.slice(1, afterEslintBaseline), SLICE_LABEL, ...OLD_LABELS.slice(afterEslintBaseline)]
  .map((l) => (l === REGISTERS_LABEL_OLD ? REGISTERS_LABEL : l))
  // Added 2026-11-11, right after the registers whose parser they share: the
  // local doctor's self-test.
  .flatMap((l) => (l === REGISTERS_LABEL ? [l, DOCTOR_LABEL, SENTINEL_LABEL] : [l]))
  .flatMap((l) => (l.startsWith('[ask-history]') ? [l, UPGRADE_LABEL] : [l]))
  .flatMap((l) => (l.startsWith('[script-graph]') ? [l, TYPECHECK_LABEL] : [l]))
  .flatMap((l) => (l === '[store-descriptions] checking CWS store copy is regenerated from the READMEs' ? [l, AI_PROVIDERS_LABEL, SETTINGS_SCHEMA_LABEL, RUNTIME_MESSAGES_LABEL, HARD_RULES_LABEL] : [l]));
const JOURNEY_STAGES = ['bookmark-services', 'ask-history', 'upgrade-path', 'selection', 'draft', 'options-save', 'translate-stop',
  'layouts', 'journey', 'discovery', 'reader-save-export'];

// Environment without anything from the caller's CI or retry settings. GIT_*
// goes too: the pre-commit hook runs this file with GIT_INDEX_FILE and GIT_DIR
// set, and the stub repo's `git init` / `git add -A` would then hit the real repo.
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(PBP_|GITHUB_|STUB_|GIT_)/.test(k)) continue;
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
  const labels = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\[dry\]\[([^\]]+)\] (.+)$/.exec(line);
    if (m) commands.push({ group: m[1], command: m[2] });
    else {
      const s = /^\[([a-z-]+)\] /.exec(line);
      if (s && s[1] !== 'verify') { stages.push(s[1]); labels.push(line); }
    }
  }
  return { ...r, commands, stages, labels };
}

const key = (c) => `${c.group}\t${c.command}`;

// ---------- Part 1: the real command list ----------

const full = dry([]);

test('no-argument dry run lists every gate command', () => {
  assert.equal(full.status, 0, full.stderr);
  for (const c of full.commands) assert.ok(GROUPS.includes(c.group), `unknown group tag ${c.group}`);
});

test('every gate of the pre-split script is still listed', () => {
  const listed = new Set(full.commands.map((c) => c.command));
  const missing = OLD_FIXED_COMMANDS.filter((c) => !listed.has(c));
  assert.deepEqual(missing, []);
  assert.equal(new Set(OLD_FIXED_COMMANDS).size, OLD_FIXED_COMMANDS.length, 'the frozen list has no repeats');
});

test('the doctor and sentinel self-tests run in the static group', () => {
  for (const c of ['node tests/doctor-tests.mjs', 'node tests/link-check-tests.mjs', 'node tests/sentinel-report-tests.mjs']) {
    assert.ok(full.commands.some((x) => x.command === c && x.group === 'static'), `${c} must be a static gate`);
  }
});

test('the slice-anchor gate runs in the static group', () => {
  for (const c of SLICE_COMMANDS) assert.ok(full.commands.some((x) => x.command === c && x.group === 'static'), `${c} must be a static gate`);
});

test('the ai-providers gate runs in the static group', () => {
  for (const c of AI_PROVIDERS_COMMANDS) assert.ok(full.commands.some((x) => x.command === c && x.group === 'static'), `${c} must be a static gate`);
});

test('the settings-schema gate runs in the static group', () => {
  for (const c of SETTINGS_SCHEMA_COMMANDS) assert.ok(full.commands.some((x) => x.command === c && x.group === 'static'), `${c} must be a static gate`);
});

test('the typecheck gate runs in the static group', () => {
  for (const c of TYPECHECK_COMMANDS) assert.ok(full.commands.some((x) => x.command === c && x.group === 'static'), `${c} must be a static gate`);
});

test('the runtime-messages gate runs in the static group', () => {
  for (const c of RUNTIME_MESSAGES_COMMANDS) assert.ok(full.commands.some((x) => x.command === c && x.group === 'static'), `${c} must be a static gate`);
});

test('the hard-rules gate runs in the static group', () => {
  for (const c of HARD_RULES_COMMANDS) assert.ok(full.commands.some((x) => x.command === c && x.group === 'static'), `${c} must be a static gate`);
});

test('the glob gates follow the directory', () => {
  const tests = readdirSync(join(ROOT, 'tests'));
  const scopes = tests.filter((n) => /^audit.*-tests\.mjs$/.test(n)).map((n) => `node tests/${n}`);
  assert.ok(scopes.length > 0);
  assert.deepEqual(full.commands.filter((c) => /^node tests\/audit[^/ ]*-tests\.mjs$/.test(c.command)).map((c) => c.command).sort(), scopes.sort(), 'every audit scope test is listed once');
  const pages = tests.filter((n) => n.endsWith('-tests.html')).map((n) => `node .qa-scan/run-test.mjs tests/${n}`);
  assert.ok(pages.length > 0);
  assert.deepEqual(full.commands.filter((c) => c.command.includes('run-test.mjs tests/')).map((c) => c.command).sort(), pages.sort(), 'every HTML page is listed once');
});

test('stage label lines are the old ones, word for word, in order', () => {
  assert.deepEqual(full.labels, EXPECTED_LABELS);
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
const leaked = Object.keys(process.env).filter((k) => k.startsWith('GIT_'));
if (leaked.length) { console.log('stub: git variable reached a gate: ' + leaked.join(' ') + ' in ' + key); process.exit(5); }
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
  const git = spawnSync('git', ['init', '-q'], { cwd: dir, env: cleanEnv() });
  assert.equal(git.status, 0, 'git init');
  // Refuse to go on unless git is looking at the sandbox and nothing else.
  const where = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: dir, env: cleanEnv(), encoding: 'utf8' });
  const expected = join(realpathSync(dir), '.git');
  if (where.status !== 0 || realpathSync(where.stdout.trim()) !== expected) {
    throw new Error(`sandbox git points at "${where.stdout.trim()}", not ${expected}; refusing to touch it`);
  }
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: dir, env: cleanEnv() }).status, 0, 'git add');
  return dir;
}

const box = makeSandbox();
// Self-check mode for the decoy-repo test at the end: do everything this file
// does to git at load time, then stop before any test runs.
if (process.env.PBP_VG_SELFCHECK === '1') {
  rmSync(box, { recursive: true, force: true });
  process.exit(0);
}
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

test('pages: the group own gate command is retried like the other browser groups', () => {
  const gate = 'tests/run-test-print-counts-tests.mjs';
  const once = run(['--group=pages'], { env: { ...retry, STUB_FAIL_ONCE: gate } });
  assert.equal(once.status, 0, once.out);
  assert.equal(times(once.calls, gate), 2);
  assert.equal(once.flakes.length, 1);
  assert.equal(once.flakes[0].stage, 'run-test');
  assert.equal(once.flakes[0].target, 'node ' + gate);
  assert.match(once.flakes[0].firstFailure, /failing once/);
  const off = run(['--group=pages'], { env: { STUB_FAIL_ONCE: gate } });
  assert.notEqual(off.status, 0);
  assert.equal(times(off.calls, gate), 1);
  assert.deepEqual(off.flakes, []);
  const twice = run(['--group=pages'], { env: { ...retry, STUB_FAIL_ALWAYS: gate } });
  assert.equal(twice.status, 3, twice.out);
  assert.equal(times(twice.calls, gate), 2);
  assert.deepEqual(twice.flakes, []);
});

test('a real no-argument run calls exactly what the dry run lists', () => {
  const dryList = run([], { env: { PBP_VERIFY_DRY: '1' } });
  assert.equal(dryList.status, 0, dryList.out);
  assert.deepEqual(dryList.calls, [], 'a dry run calls nothing');
  // Only commands that start a stub script leave a call-log line. The eslint
  // line (env ... npx), the syntax loop and setup-hooks.sh are stubbed or
  // run without logging, so they are not part of the comparison.
  const expected = dryList.stdout.split('\n')
    .map((l) => /^\[dry\]\[[a-z]+\] node (.+)$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
  assert.ok(expected.length > 40, 'the dry list has the expected size');
  assert.ok(expected.some((c) => c.startsWith('scripts/ui-render-audit.mjs --shard=')), 'the render shards are in the dry list');
  const real = run([]);
  assert.equal(real.status, 0, real.out);
  assert.deepEqual([...real.calls].sort(), expected);
});

// ---------- Part 3: git variables from the caller ----------

test('static: a tracked script with a syntax error stops the run at [syntax]', () => {
  for (const name of ['zz-broken.js', 'zz-broken.mjs']) {
    writeFileSync(join(box, name), 'const = ;\n');
    assert.equal(spawnSync('git', ['add', name], { cwd: box, env: cleanEnv() }).status, 0);
    try {
      const r = run(['--group=static']);
      assert.notEqual(r.status, 0, `${name}: ${r.out}`);
      assert.match(r.out, new RegExp(name.replace('.', '\\.')), r.out);
      assert.match(r.stdout, /\[syntax\] /);
      assert.doesNotMatch(r.stdout, /\[eslint\] /, 'the run must stop at the syntax stage');
    } finally {
      spawnSync('git', ['rm', '-q', '--cached', name], { cwd: box, env: cleanEnv() });
      rmSync(join(box, name), { force: true });
    }
  }
});

test('verify.sh drops inherited git variables before any gate runs', () => {
  // GIT_DIR points at the sandbox itself, so nothing real is in reach. Every
  // stub exits 5 if a GIT_* variable gets through.
  for (const g of GROUPS) {
    const r = run([`--group=${g}`], { env: { GIT_DIR: join(box, '.git'), GIT_WORK_TREE: box, GIT_PREFIX: '' } });
    assert.equal(r.status, 0, `${g}: ${r.out}`);
    assert.doesNotMatch(r.out, /git variable reached a gate/);
  }
});

test('with hook-style git variables set, loading this file leaves the pointed-at repo alone', () => {
  // A decoy repo stands in for the real one. Never point these at a real checkout.
  const decoy = mkdtempSync(join(tmpdir(), 'pbp-verify-groups-decoy-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd: decoy, env: cleanEnv(), encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    writeFileSync(join(decoy, 'keep.txt'), 'keep\n');
    git('add', '-A');
    assert.equal(git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'decoy').status, 0);
    const snapshot = () => ({
      head: git('rev-parse', 'HEAD').stdout.trim(),
      index: createHash('sha1').update(readFileSync(join(decoy, '.git/index'))).digest('hex'),
      config: readFileSync(join(decoy, '.git/config'), 'utf8'),
      files: git('ls-files').stdout,
      status: git('status', '--porcelain').stdout,
    });
    const before = snapshot();
    const child = spawnSync(process.execPath, [SELF], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...cleanEnv(), PBP_VG_SELFCHECK: '1', GIT_DIR: join(decoy, '.git'), GIT_INDEX_FILE: join(decoy, '.git/index'), GIT_WORK_TREE: decoy },
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.deepEqual(snapshot(), before);
  } finally {
    rmSync(decoy, { recursive: true, force: true });
  }
});
