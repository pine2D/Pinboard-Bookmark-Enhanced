// Self-test of scripts/mutate-check.mjs (Node only, temp directories, no browser):
// the file always comes back, the old string must be unique, and a crashed
// run's backup blocks the next one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runMutations, MutateRefusal, BACKUP_SUFFIX, restoreHint } from '../scripts/mutate-check.mjs';

const CLI = fileURLToPath(new URL('../scripts/mutate-check.mjs', import.meta.url));
const ORIGINAL = 'const a = "GOOD";\nconst b = 1;\nconst c = 1;\n';
// Exit 0 while the file still says GOOD; with it broken, either fail or hang a few seconds.
const checker = (mode = 'fail') => [process.execPath, '-e', `const t=require('fs').readFileSync(process.argv[1],'utf8');if(t.includes('GOOD'))process.exit(0);${mode === 'hang' ? 'setTimeout(()=>process.exit(1),4000)' : 'process.exit(1)'}`];
const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbp-mutate-'));
  const file = join(dir, 'target.js');
  writeFileSync(file, ORIGINAL);
  return { dir, file, done: () => rmSync(dir, { recursive: true, force: true }) };
};
const quiet = { log: () => {}, warn: () => {} };
const withFile = (file, command) => command.map((part, i) => i === command.length - 1 ? part : part).concat(file);

test('a killed mutation is reported and the file is restored byte for byte', async () => {
  const s = sandbox();
  try {
    const { results, survived } = await runMutations([{ file: s.file, old: 'GOOD', new: 'BAD' }], { command: withFile(s.file, checker()), ...quiet });
    assert.deepEqual(results.map(r => r.status), ['killed']);
    assert.equal(survived, 0);
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
    assert.equal(existsSync(s.file + BACKUP_SUFFIX), false, 'the backup outlived a clean run');
  } finally { s.done(); }
});

test('a surviving mutation is reported as survived and the file is still restored', async () => {
  const s = sandbox();
  try {
    // "const b" is not what the checker looks at, so breaking it goes unnoticed.
    const { results, survived } = await runMutations([{ file: s.file, old: 'const b = 1', new: 'const b = 2' }], { command: withFile(s.file, checker()), ...quiet });
    assert.deepEqual(results.map(r => r.status), ['survived']);
    assert.equal(survived, 1);
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
  } finally { s.done(); }
});

test('several mutations are judged one at a time, each from the original', async () => {
  const s = sandbox();
  try {
    const { results } = await runMutations([
      { file: s.file, old: 'const b = 1', new: 'const b = 2', label: 'unobserved' },
      { file: s.file, old: 'GOOD', new: 'BAD', label: 'observed' },
    ], { command: withFile(s.file, checker()), ...quiet });
    assert.deepEqual(results.map(r => [r.label, r.status]), [['unobserved', 'survived'], ['observed', 'killed']]);
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
  } finally { s.done(); }
});

test('a mutation never leaks into the next one, even in another file', async () => {
  const s = sandbox();
  try {
    const other = join(s.dir, 'other.js');
    writeFileSync(other, ORIGINAL);
    // The checker only looks at target.js. Breaking it is caught; breaking other.js afterwards
    // must then go unnoticed, which fails if target.js were still broken from the first run.
    const { results } = await runMutations([
      { file: s.file, old: 'GOOD', new: 'BAD', label: 'first' },
      { file: other, old: 'const b = 1', new: 'const b = 2', label: 'second' },
    ], { command: withFile(s.file, checker()), ...quiet });
    assert.deepEqual(results.map(r => [r.label, r.status]), [['first', 'killed'], ['second', 'survived']]);
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
    assert.equal(readFileSync(other, 'utf8'), ORIGINAL);
  } finally { s.done(); }
});

test('the old string must occur exactly once: none or several is refused before anything runs', async () => {
  const s = sandbox();
  try {
    const marker = join(s.dir, 'ran');
    const command = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`];
    for (const old of ['absent', 'const c = 1;\n'.slice(0, 5), 'const']) {
      await assert.rejects(runMutations([{ file: s.file, old, new: 'x' }], { command, ...quiet }), error => error instanceof MutateRefusal && /exactly once/.test(error.message));
    }
    assert.equal(existsSync(marker), false, 'the test command ran for a refused mutation');
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
    assert.equal(existsSync(s.file + BACKUP_SUFFIX), false);
    // One bad entry refuses the whole batch, even when an earlier entry is fine.
    await assert.rejects(runMutations([{ file: s.file, old: 'GOOD', new: 'BAD' }, { file: s.file, old: 'absent', new: 'x' }], { command, ...quiet }), MutateRefusal);
    assert.equal(existsSync(marker), false);
  } finally { s.done(); }
});

test('an exception while running restores the file: a command that cannot start, a failing baseline', async () => {
  const s = sandbox();
  try {
    await assert.rejects(runMutations([{ file: s.file, old: 'GOOD', new: 'BAD' }], { command: ['pbp-no-such-command-xyz'], baseline: false, ...quiet }), MutateRefusal);
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
    assert.equal(existsSync(s.file + BACKUP_SUFFIX), false);
    // The unmutated source must pass first, otherwise "killed" means nothing.
    writeFileSync(s.file, ORIGINAL.replace('GOOD', 'BROKEN'));
    await assert.rejects(runMutations([{ file: s.file, old: 'BROKEN', new: 'WORSE' }], { command: withFile(s.file, checker()), ...quiet }), /already fails/);
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL.replace('GOOD', 'BROKEN'));
    assert.equal(existsSync(s.file + BACKUP_SUFFIX), false);
  } finally { s.done(); }
});

test('a timeout counts as killed and still restores', async () => {
  const s = sandbox();
  try {
    const { results } = await runMutations([{ file: s.file, old: 'GOOD', new: 'BAD' }], { command: withFile(s.file, checker('hang')), timeoutMs: 400, baseline: false, ...quiet });
    assert.deepEqual(results.map(r => [r.status, r.detail]), [['killed', 'timeout']]);
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
  } finally { s.done(); }
});

test('a backup left by a crashed run blocks the next run and says how to restore', async () => {
  const s = sandbox();
  try {
    writeFileSync(s.file, ORIGINAL.replace('GOOD', 'BAD'));
    writeFileSync(s.file + BACKUP_SUFFIX, ORIGINAL);
    await assert.rejects(runMutations([{ file: s.file, old: 'BAD', new: 'GOOD' }], { command: withFile(s.file, checker()), ...quiet }),
      error => error instanceof MutateRefusal && error.message.includes(restoreHint(s.file)) && error.message.includes(s.file + BACKUP_SUFFIX));
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL.replace('GOOD', 'BAD'), 'a refused run touched the file');
    assert.equal(readFileSync(s.file + BACKUP_SUFFIX, 'utf8'), ORIGINAL, 'a refused run touched the backup');
    // The printed command really restores it.
    execFileSync('sh', ['-c', restoreHint(s.file)]);
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
    assert.equal(existsSync(s.file + BACKUP_SUFFIX), false);
  } finally { s.done(); }
});

// The CLI as a user runs it. The test command exits at once while the file is
// intact (the baseline) and sits for four seconds once it is mutated.
const startCli = (file, extra = []) => spawn(process.execPath, [CLI, ...extra, file, 'GOOD', 'BAD', '--', ...checker('hang'), file], { stdio: ['ignore', 'pipe', 'pipe'] });
const waitMutated = async file => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (readFileSync(file, 'utf8').includes('BAD')) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('the CLI never mutated the file');
};
const exited = child => new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));

test('SIGINT in the middle of a run restores the file and removes the backup', async () => {
  const s = sandbox();
  try {
    const child = startCli(s.file), closed = exited(child);
    await waitMutated(s.file);
    assert.equal(existsSync(s.file + BACKUP_SUFFIX), true, 'no backup was written before mutating');
    child.kill('SIGINT');
    const { code } = await closed;
    assert.equal(code, 130);
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
    assert.equal(existsSync(s.file + BACKUP_SUFFIX), false);
  } finally { s.done(); }
});

test('SIGKILL cannot be caught: the backup stays, the next run refuses, the printed command recovers', async () => {
  const s = sandbox();
  try {
    const child = startCli(s.file), closed = exited(child);
    await waitMutated(s.file);
    child.kill('SIGKILL');
    await closed;
    assert.equal(readFileSync(s.file, 'utf8').includes('BAD'), true);
    assert.equal(readFileSync(s.file + BACKUP_SUFFIX, 'utf8'), ORIGINAL);
    const second = spawn(process.execPath, [CLI, s.file, 'BAD', 'GOOD', '--', ...checker(), s.file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    second.stderr.on('data', chunk => { stderr += chunk; });
    const { code } = await exited(second);
    assert.equal(code, 2);
    assert.ok(stderr.includes(restoreHint(s.file)), stderr);
    execFileSync('sh', ['-c', restoreHint(s.file)]);
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
  } finally { s.done(); }
});

for (const [signal, expected] of [['SIGTERM', 143], ['SIGHUP', 129]]) {
  test(`${signal} in the middle of a run restores the file and removes the backup`, async () => {
    const s = sandbox();
    try {
      const child = startCli(s.file), closed = exited(child);
      await waitMutated(s.file);
      child.kill(signal);
      const { code } = await closed;
      assert.equal(code, expected);
      assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
      assert.equal(existsSync(s.file + BACKUP_SUFFIX), false);
    } finally { s.done(); }
  });
}

// An exit that no signal handler sees: an uncaught exception or a bare process.exit
// while the file is mutated and the test command is still running.
for (const [name, trigger] of [['an uncaught exception', "throw new Error('boom')"], ['process.exit()', 'process.exit(3)']]) {
  test(`${name} while mutated still restores the file`, async () => {
    const s = sandbox();
    try {
      const driver = `import { runMutations } from ${JSON.stringify(new URL('../scripts/mutate-check.mjs', import.meta.url).href)};
        setTimeout(() => { ${trigger} }, 700);
        await runMutations([{ file: ${JSON.stringify(s.file)}, old: 'GOOD', new: 'BAD' }], { command: ${JSON.stringify(checker('hang').concat(s.file))}, log() {}, warn() {} });`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', driver], { stdio: ['ignore', 'ignore', 'ignore'] });
      const closed = exited(child);
      await waitMutated(s.file);
      await closed;
      assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
      assert.equal(existsSync(s.file + BACKUP_SUFFIX), false);
    } finally { s.done(); }
  });
}

test('a backup stranded for one file blocks a run on another file and lists the way back', async () => {
  const s = sandbox();
  try {
    const other = join(s.dir, 'other.js');
    writeFileSync(other, ORIGINAL);
    const child = startCli(s.file), closed = exited(child);
    await waitMutated(s.file);
    child.kill('SIGKILL');
    await closed;
    const second = spawn(process.execPath, [CLI, other, 'GOOD', 'BAD', '--', ...checker(), other], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    second.stderr.on('data', chunk => { stderr += chunk; });
    assert.equal((await exited(second)).code, 2);
    assert.ok(stderr.includes(restoreHint(s.file)), stderr);
    assert.equal(readFileSync(other, 'utf8'), ORIGINAL, 'the refused run touched an unrelated file');
    execFileSync('sh', ['-c', restoreHint(s.file)]);
    // With the stranded file put back, the same run goes through.
    const third = await runMutations([{ file: other, old: 'GOOD', new: 'BAD' }], { command: withFile(other, checker()), cwd: s.dir, ...quiet });
    assert.equal(third.survived, 0);
  } finally { s.done(); }
});

test('the printed restore command keeps an executable file executable', async () => {
  const s = sandbox();
  try {
    chmodSync(s.file, 0o755);
    const child = startCli(s.file), closed = exited(child);
    await waitMutated(s.file);
    child.kill('SIGKILL');
    await closed;
    execFileSync('sh', ['-c', restoreHint(s.file)]);
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
    assert.equal(statSync(s.file).mode & 0o777, 0o755);
  } finally { s.done(); }
});

test('a timeout also ends grandchildren that hold the output pipes', async () => {
  const s = sandbox();
  try {
    const started = Date.now(), pidFile = join(s.dir, 'grandchild.pid');
    const command = ['sh', '-c', `sleep 6 & echo $! > ${JSON.stringify(pidFile)}; wait`];
    const { results } = await runMutations([{ file: s.file, old: 'GOOD', new: 'BAD' }], { command, timeoutMs: 400, baseline: false, ...quiet });
    assert.deepEqual(results.map(r => [r.status, r.detail]), [['killed', 'timeout']]);
    assert.ok(Date.now() - started < 3000, 'the timeout waited for the grandchild');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise(r => setTimeout(r, 200));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) process.kill(pid, 'SIGKILL');
    assert.equal(alive, false, 'the grandchild outlived the timeout');
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
  } finally { s.done(); }
});

test('exit codes: all killed 0, any survivor 1, refusal 2; --json carries several mutations', async () => {
  const s = sandbox();
  try {
    const run = args => new Promise(resolve => {
      const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', c => { out += c; });
      child.once('close', code => resolve({ code, out }));
    });
    assert.equal((await run([s.file, 'GOOD', 'BAD', '--', ...checker(), s.file])).code, 0);
    const survivor = await run([s.file, 'const b = 1', 'const b = 2', '--', ...checker(), s.file]);
    assert.equal(survivor.code, 1);
    assert.match(survivor.out, /SURVIVED/);
    assert.equal((await run([s.file, 'nowhere', 'x', '--', ...checker(), s.file])).code, 2);
    const json = join(s.dir, 'mutations.json');
    writeFileSync(json, JSON.stringify([{ file: s.file, old: 'GOOD', new: 'BAD', command: checker().concat(s.file) }, { file: s.file, old: 'const c = 1', new: 'const c = 2', command: checker().concat(s.file) }]));
    const many = await run(['--json', json]);
    assert.equal(many.code, 1);
    assert.match(many.out, /1\/2 mutations killed, 1 survived/);
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL);
  } finally { s.done(); }
});

test('uncommitted changes in the target are warned about and kept', async () => {
  const s = sandbox();
  try {
    try { execFileSync('git', ['init', '-q'], { cwd: s.dir }); } catch { return; }
    const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: s.dir, stdio: 'ignore' });
    git('add', 'target.js'); git('commit', '-qm', 'base');
    writeFileSync(s.file, ORIGINAL + '// local edit\n');
    const warnings = [];
    await runMutations([{ file: s.file, old: 'GOOD', new: 'BAD' }], { command: withFile(s.file, checker()), cwd: s.dir, log: () => {}, warn: message => warnings.push(message) });
    assert.ok(warnings.some(w => /uncommitted/.test(w)), 'no warning for a dirty target');
    assert.equal(readFileSync(s.file, 'utf8'), ORIGINAL + '// local edit\n', 'the uncommitted edit was lost');
    warnings.length = 0;
    git('commit', '-qam', 'edit');
    await runMutations([{ file: s.file, old: 'GOOD', new: 'BAD' }], { command: withFile(s.file, checker()), cwd: s.dir, log: () => {}, warn: message => warnings.push(message) });
    assert.deepEqual(warnings, []);
  } finally { s.done(); }
});
