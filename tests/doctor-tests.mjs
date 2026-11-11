// Self-test for scripts/doctor.mjs. Every case runs a copy of the script in a
// throwaway git repo under the system temp dir, with a fake .qa-scan and fake
// registers, so nothing here reads or writes this repo or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// First, before any git call: forget every git variable the caller exported.
// A pre-commit hook runs this file with GIT_DIR and GIT_INDEX_FILE set, and a
// throwaway repo's `git init` / `git commit` would then write to the real repo
// (that happened once, 2026-11-10). sandbox() also checks where git landed.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-11-10';
const COPY = ['scripts/doctor.mjs', 'scripts/registers-lint.mjs', 'scripts/docs-lint.mjs', 'scripts/setup-hooks.sh', 'scripts/pre-commit-hook.sh', 'scripts/commit-msg-hook.sh'];
const boxes = [];
test.after(() => { for (const b of boxes) rmSync(b, { recursive: true, force: true }); });

function env(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|PBP_)/.test(k)) e[k] = v;
  return { ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', PBP_LINT_TODAY: TODAY, ...extra };
}
function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, env: env(), encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function put(dir, rel, body, mode) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
  if (mode) chmodSync(join(dir, rel), mode);
}

const FM = '| 服务商 | 默认模型 | 最近核实 | 备注 |\n|---|---|---|---|\n';
const FF = '| 服务 | 位置 | 最近核实 | 备注 |\n|---|---|---|---|\n';
function sandbox({ commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pbp-doctor-'));
  boxes.push(dir);
  for (const rel of COPY) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); copyFileSync(join(ROOT, rel), join(dir, rel)); chmodSync(join(dir, rel), statSync(join(ROOT, rel)).mode); }
  put(dir, 'shared.js', 'const SETTINGS_DEFAULTS = {};\n');
  put(dir, 'ai.js', 'const OPENAI_COMPAT_PROVIDERS = { alpha: { defaultModel: "a-1" } };\nconst _AI_BESPOKE_PROVIDERS = {};\n');
  put(dir, '.claude/expiring-items.md', '# x\n\n## 临时事项\n\n- **远（到期日 2027-06-01）**\n');
  put(dir, '.claude/acceptance-debt.md', '# x\n\n## 待验\n\n| 编号 | 登记日 | 来源 | 验什么 | 怎么验 | 到期日 |\n|---|---|---|---|---|---|\n\n## 已清\n\n| 编号 | 清账日 | 结果 |\n|---|---|---|\n');
  put(dir, '.claude/freshness-ledger.md', `# x\n\n## 默认模型\n\n${FM}| alpha | a-1 | 未核实 | - |\n\n## 远端夹具\n\n${FF}| S | ai.js | 2026-11-01 | - |\n`);
  put(dir, 'scripts/slice-anchor-baseline.json', JSON.stringify({ total: 7, files: {} }));
  put(dir, 'scripts/eslint-suppressions.json', JSON.stringify({ 'a.js': { 'pbp/no-silent-catch': { count: 3 }, 'no-undef': { count: 2 } }, 'b.js': { 'pbp/no-silent-catch': { count: 4 } } }));
  put(dir, 'scripts/ui-vocabulary-baseline.json', JSON.stringify({ version: 1, entries: [{}, {}, {}] }));
  put(dir, 'tests/render-audit-known-failures.json', JSON.stringify({ x: 1, y: 2 }));
  put(dir, '.qa-scan/package.json', JSON.stringify({ dependencies: { playwright: '1.2.3' } }));
  put(dir, '.qa-scan/run-test.mjs', '// tracked\n');
  const chrome = join(dir, '.fake-chrome');
  put(dir, '.qa-scan/node_modules/playwright/package.json', JSON.stringify({ name: 'playwright', version: '1.2.3', main: 'index.js' }));
  put(dir, '.qa-scan/node_modules/playwright/index.js', `module.exports = { chromium: { executablePath: () => ${JSON.stringify(chrome)} } };\n`);
  put(dir, '.fake-chrome', '');
  put(dir, '.gitignore', '.qa-scan/*\n!.qa-scan/package.json\n!.qa-scan/run-test.mjs\n.fake-chrome\n');
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  const where = realpathSync(sh(dir, 'git', ['rev-parse', '--absolute-git-dir']));
  if (where !== join(realpathSync(dir), '.git')) throw new Error(`sandbox git points at ${where}; refusing to go on`);
  if (commit) { sh(dir, 'git', ['add', '-A']); sh(dir, 'git', ['commit', '-q', '-m', 'init']); }
  return dir;
}

function doctor(dir, args = [], extra = {}) {
  const r = spawnSync(process.execPath, [join(dir, 'scripts/doctor.mjs'), ...args], { cwd: dir, env: env(extra), encoding: 'utf8', timeout: 60000 });
  let json = null;
  if (args.includes('--json')) json = JSON.parse(r.stdout);
  const by = json ? Object.fromEntries(json.checks.map((c) => [c.id, c])) : null;
  return { ...r, json, by };
}
const statusOf = (dir, id, args = ['--offline'], extra) => doctor(dir, ['--json', ...args], extra).by[id];

test('the sandbox is its own repo, not this one', () => {
  const d = sandbox();
  assert.equal(realpathSync(sh(d, 'git', ['rev-parse', '--show-toplevel'])), realpathSync(d));
  assert.notEqual(realpathSync(sh(d, 'git', ['rev-parse', '--show-toplevel'])), realpathSync(ROOT));
});

test('hooks: missing warns with the setup command; installed passes, also from a linked worktree', () => {
  const d = sandbox();
  const before = statusOf(d, 'hooks');
  assert.equal(before.status, 'warn'); assert.match(before.line, /pre-commit is not installed/); assert.equal(before.fix, 'sh scripts/setup-hooks.sh');
  sh(d, 'sh', ['scripts/setup-hooks.sh']);
  assert.equal(statusOf(d, 'hooks').status, 'ok');
  const wt = join(d, '.wt');
  sh(d, 'git', ['worktree', 'add', '-q', wt, '-b', 'side']);
  assert.equal(statusOf(wt, 'hooks').status, 'ok', 'a linked worktree uses the hooks of the common dir');
  chmodSync(join(d, '.git/hooks/pre-commit'), 0o644);
  assert.match(statusOf(d, 'hooks').line, /not executable/);
  writeFileSync(join(d, '.git/hooks/commit-msg'), '#!/bin/sh\necho old copy\n'); chmodSync(join(d, '.git/hooks/commit-msg'), 0o755);
  assert.match(statusOf(d, 'hooks').line, /commit-msg does not delegate/);
});

test('qa-deps and chromium: version mismatch, missing modules and a missing browser warn', () => {
  const d = sandbox();
  assert.equal(statusOf(d, 'qa-deps').status, 'ok');
  assert.equal(statusOf(d, 'chromium').status, 'ok');
  put(d, '.qa-scan/package.json', JSON.stringify({ dependencies: { playwright: '1.2.4' } }));
  const mismatch = statusOf(d, 'qa-deps');
  assert.equal(mismatch.status, 'warn'); assert.match(mismatch.line, /1\.2\.3.*1\.2\.4/); assert.equal(mismatch.fix, 'npm ci --prefix .qa-scan');
  rmSync(join(d, '.fake-chrome'));
  const chrome = statusOf(d, 'chromium');
  assert.equal(chrome.status, 'warn'); assert.match(chrome.fix, /playwright install chromium/);
  rmSync(join(d, '.qa-scan/node_modules'), { recursive: true });
  assert.match(statusOf(d, 'qa-deps').line, /node_modules is missing/);
  assert.equal(statusOf(d, 'chromium').status, 'warn');
});

test('file count: over the limit warns; .git is not counted', () => {
  const d = sandbox();
  const n = Number(/^(\d+) files/.exec(statusOf(d, 'file-count').line)[1]);
  const walk = (p) => readdirSync(p, { withFileTypes: true }).reduce((a, e) => a + (e.name === '.git' && p === d ? 0 : e.isDirectory() ? walk(join(p, e.name)) : e.isFile() ? 1 : 0), 0);
  assert.equal(n, walk(d));
  assert.equal(statusOf(d, 'file-count', ['--offline'], { PBP_DOCTOR_FILE_LIMIT: String(n) }).status, 'ok');
  const over = statusOf(d, 'file-count', ['--offline'], { PBP_DOCTOR_FILE_LIMIT: String(n - 1) });
  assert.equal(over.status, 'warn'); assert.match(over.line, new RegExp(`${n} files.*over the ${n - 1} limit`));
});

test('qa-stray: untracked entries at the .qa-scan top level are listed, whatever their name; tracked and kept ones are not', () => {
  const d = sandbox();
  assert.equal(statusOf(d, 'qa-stray').status, 'ok');
  put(d, '.qa-scan/run.log', 'x'); put(d, '.qa-scan/Q3 notes (copy)', 'x'); put(d, '.qa-scan/report/a.html', 'x'); put(d, '.qa-scan/promo-video/out.mp4', 'x');
  const s = statusOf(d, 'qa-stray');
  assert.equal(s.status, 'warn'); assert.match(s.line, /^3 untracked entries/); assert.match(s.line, /Q3 notes \(copy\), report, run\.log/);
  assert.doesNotMatch(s.line, /run-test|package|node_modules|promo-video/);
  // A file git does not ignore is just as stray as an ignored one.
  put(d, '.gitignore', '.fake-chrome\n.qa-scan/node_modules\n');
  assert.match(statusOf(d, 'qa-stray').line, /^3 untracked entries/);
});

test('tags: offline and no origin skip; missing release tags warn; an unreachable origin is a failure, not "none missing"', () => {
  const d = sandbox();
  assert.equal(statusOf(d, 'tags').status, 'skip');
  assert.match(statusOf(d, 'tags', []).line, /no origin/);
  const bare = mkdtempSync(join(tmpdir(), 'pbp-doctor-origin-')); boxes.push(bare);
  sh(bare, 'git', ['init', '-q', '--bare']);
  sh(d, 'git', ['remote', 'add', 'origin', bare]);
  sh(d, 'git', ['tag', 'v1.0.0']); sh(d, 'git', ['tag', 'v1.1.0']); sh(d, 'git', ['tag', 'not-a-release']);
  sh(d, 'git', ['push', '-q', 'origin', '--tags']);
  assert.equal(statusOf(d, 'tags', []).status, 'ok');
  sh(d, 'git', ['tag', '-d', 'v1.1.0']); sh(d, 'git', ['tag', '-d', 'not-a-release']);
  const miss = statusOf(d, 'tags', []);
  assert.equal(miss.status, 'warn'); assert.match(miss.line, /1 release tag.*v1\.1\.0/); assert.doesNotMatch(miss.line, /not-a-release/); assert.equal(miss.fix, 'git fetch --tags origin');
  sh(d, 'git', ['remote', 'set-url', 'origin', join(bare, 'gone')]);
  const down = statusOf(d, 'tags', []);
  assert.equal(down.status, 'warn'); assert.match(down.line, /could not read/);
});

test('due: an overdue or near item warns; a broken register is reported', () => {
  const d = sandbox();
  assert.equal(statusOf(d, 'due').status, 'ok');
  put(d, '.claude/expiring-items.md', '# x\n\n## 临时事项\n\n- **近（到期日 2026-11-20）**\n');
  const near = statusOf(d, 'due');
  assert.equal(near.status, 'warn'); assert.match(near.line, /1 register item.*0 overdue/); assert.match(near.fix, /--due-within 14/);
  put(d, '.claude/freshness-ledger.md', `# x\n\n## 默认模型\n\n${FM}| alpha | a-0 | 未核实 | - |\n\n## 远端夹具\n\n${FF}`);
  assert.match(statusOf(d, 'due').line, /register problem/);
});

test('baselines: plain numbers read from the files', () => {
  const d = sandbox();
  const b = statusOf(d, 'baselines');
  assert.equal(b.status, 'info');
  assert.deepEqual(b.data, { sliceAnchors: 7, eslintSuppressions: 9, silentCatches: 7, uiVocabularyEntries: 3, renderKnownFailures: 2 });
  rmSync(join(d, 'scripts/slice-anchor-baseline.json'));
  assert.equal(statusOf(d, 'baselines').data.sliceAnchors, null);
});

test('read-only: a full run changes no file and no git state; --strict fails only on a warning', () => {
  const d = sandbox();
  put(d, '.env', 'SECRET_TOKEN=do-not-print-me\n');
  const snap = () => sh(d, 'git', ['status', '--porcelain', '--ignored']) + '\n' + readdirSync(d, { recursive: true }).filter((f) => f !== '.git' && !String(f).startsWith('.git/')).sort().map((f) => { const s = statSync(join(d, String(f))); return `${f} ${s.size} ${s.mtimeMs}`; }).join('\n');
  const before = snap();
  const r = doctor(d, [], { PBP_QA_REPORT_DIR: '/marker-of-an-env-value' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(snap(), before);
  assert.doesNotMatch(r.stdout + r.stderr, /do-not-print-me|marker-of-an-env-value/);
  assert.match(r.stdout, /^warn  git hooks/m); assert.match(r.stdout, /fix: sh scripts\/setup-hooks\.sh/);
  assert.equal(doctor(d, ['--strict', '--offline']).status, 1, 'hooks are missing, so --strict fails');
  sh(d, 'sh', ['scripts/setup-hooks.sh']);
  const clean = doctor(d, ['--strict', '--offline']);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /^skip  remote tags not checked/m);
});

test('--help and unknown arguments', () => {
  const d = sandbox();
  const h = doctor(d, ['--help']);
  assert.equal(h.status, 0); assert.match(h.stdout, /--offline/);
  const bad = doctor(d, ['--fix']);
  assert.equal(bad.status, 2); assert.match(bad.stderr, /unknown argument/);
});
