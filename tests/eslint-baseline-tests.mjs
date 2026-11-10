// Self-test for scripts/eslint-baseline-check.mjs. Baselines are written by hand
// in the shape eslint itself writes: file -> rule id -> { count }.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compareBaselines } from '../scripts/eslint-baseline-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RULE = 'pbp/no-silent-catch';
const entry = (n, rule = RULE) => ({ [rule]: { count: n } });
const base = { 'a.js': entry(5), 'b.js': entry(2) };

test('same baseline passes', () => assert.deepEqual(compareBaselines(base, structuredClone(base)), []));
test('count down passes', () => assert.deepEqual(compareBaselines(base, { 'a.js': entry(4), 'b.js': entry(2) }), []));
test('file removed passes', () => assert.deepEqual(compareBaselines(base, { 'a.js': entry(5) }), []));
test('both emptied passes', () => assert.deepEqual(compareBaselines(base, {}), []));
test('count up fails and names the file', () => {
  const out = compareBaselines(base, { 'a.js': entry(6), 'b.js': entry(2) });
  assert.equal(out.length, 1);
  assert.match(out[0], /a\.js/);
  assert.match(out[0], /5/);
  assert.match(out[0], /6/);
});
test('new file fails', () => {
  const out = compareBaselines(base, { ...base, 'c.js': entry(1) });
  assert.equal(out.length, 1);
  assert.match(out[0], /c\.js/);
});
test('new file with zero count passes', () => assert.deepEqual(compareBaselines(base, { ...base, 'c.js': entry(0) }), []));
test('unrelated rule keys are ignored', () => {
  const next = { 'a.js': { ...entry(5), 'no-unused-vars': { count: 99 } }, 'z.js': entry(7, 'no-undef') };
  assert.deepEqual(compareBaselines(base, next), []);
});
test('old baseline without the rule: any count in the new one fails', () => {
  const out = compareBaselines({ 'a.js': entry(1, 'no-undef') }, { 'a.js': entry(1) });
  assert.equal(out.length, 1);
});
test('several offenders are all listed', () => {
  const out = compareBaselines(base, { 'a.js': entry(9), 'b.js': entry(3), 'c.js': entry(1) });
  assert.equal(out.length, 3);
});
test('non-object input is an error', () => {
  assert.throws(() => compareBaselines(null, {}), /object/);
  assert.throws(() => compareBaselines({}, []), /object/);
});
test('a rule entry without a numeric count is an error', () => {
  assert.throws(() => compareBaselines(base, { 'a.js': { [RULE]: { count: 'x' } } }), /count/);
});

// ---- CLI ----
const dir = mkdtempSync(join(tmpdir(), 'pbp-baseline-'));
const put = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
const cli = (...args) => spawnSync('node', [join(ROOT, 'scripts/eslint-baseline-check.mjs'), ...args], { encoding: 'utf8' });
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('CLI: equal files exit 0', () => {
  const a = put('a.json', JSON.stringify(base));
  assert.equal(cli(a, a).status, 0);
});
test('CLI: growth exits 1 and says the baseline only shrinks', () => {
  const a = put('old.json', JSON.stringify(base));
  const b = put('new.json', JSON.stringify({ ...base, 'a.js': entry(6) }));
  const r = cli(a, b);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only shrinks/);
  assert.match(r.stderr, /swallow-ok:/);
});
test('CLI: malformed JSON exits 2', () => {
  const a = put('ok.json', JSON.stringify(base));
  const b = put('bad.json', '{ nope');
  assert.equal(cli(a, b).status, 2);
  assert.equal(cli(b, a).status, 2);
});
test('CLI: missing file exits 2', () => {
  const a = put('ok2.json', JSON.stringify(base));
  assert.equal(cli(a, join(dir, 'missing.json')).status, 2);
});
test('CLI: wrong argument count exits 2', () => assert.equal(cli().status, 2));
