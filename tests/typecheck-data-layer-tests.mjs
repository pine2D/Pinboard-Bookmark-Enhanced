// Self-tests for scripts/typecheck-data-layer.mjs (dev-only JSDoc + strictNullChecks
// gate over the 6 pure data-layer files). Node only, 0 slice anchors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_REL,
  DATA_LAYER_FILES,
  GLOBALS_DTS_REL,
  runDataLayerTypecheck,
} from '../scripts/typecheck-data-layer.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QA_ROOT = join(ROOT, '.qa-scan');

function makeTempFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pbp-typecheck-dl-'));
  for (const rel of [CONFIG_REL, GLOBALS_DTS_REL, ...DATA_LAYER_FILES]) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(ROOT, rel), dest);
  }
  return dir;
}

function listAllFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out.sort();
}

test('live repository pure data-layer passes checkJs + strictNullChecks with zero errors', () => {
  // 最简单漏判反例：jsconfig 漏收某个纯数据层文件，或默认 strictNullChecks 未生效导致真实代码带空指针隐患却静默绿灯。
  assert.equal(DATA_LAYER_FILES.length, 6);
  const res = runDataLayerTypecheck({ root: ROOT });
  assert.equal(res.ok, true, res.errors.join('\n'));
  assert.equal(res.checkedFiles, 6);
  assert.deepEqual(res.errors, []);
});

test('config invariants fail closed if strictNullChecks, noEmit or a required file is dropped', () => {
  const dir = makeTempFixture();
  try {
    const cfgPath = join(dir, CONFIG_REL);
    const baseCfg = JSON.parse(readFileSync(cfgPath, 'utf8'));

    // 1. Disabling strictNullChecks must fail closed even when syntax is valid.
    writeFileSync(cfgPath, JSON.stringify({
      ...baseCfg,
      compilerOptions: { ...baseCfg.compilerOptions, strictNullChecks: false },
    }, null, 2));
    const noStrictNull = runDataLayerTypecheck({ root: dir, qaRoot: QA_ROOT });
    assert.equal(noStrictNull.ok, false);
    assert.match(noStrictNull.errors.join('\n'), /strictNullChecks/);

    // 2. Disabling noEmit must fail closed and emit zero files.
    const beforeFiles = listAllFiles(dir);
    writeFileSync(cfgPath, JSON.stringify({
      ...baseCfg,
      compilerOptions: { ...baseCfg.compilerOptions, noEmit: false },
    }, null, 2));
    const emitEnabled = runDataLayerTypecheck({ root: dir, qaRoot: QA_ROOT });
    assert.equal(emitEnabled.ok, false);
    assert.match(emitEnabled.errors.join('\n'), /noEmit/);
    assert.deepEqual(listAllFiles(dir), beforeFiles, 'typecheck gate must never emit build artifacts');

    // 3. Dropping any of the 6 pure data-layer files from files[] must fail closed.
    writeFileSync(cfgPath, JSON.stringify({
      ...baseCfg,
      files: baseCfg.files.filter((f) => !f.endsWith('notes-sync.js')),
    }, null, 2));
    const missingFile = runDataLayerTypecheck({ root: dir, qaRoot: QA_ROOT });
    assert.equal(missingFile.ok, false);
    assert.match(missingFile.errors.join('\n'), /notes-sync\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strictNullChecks and cross-file ambient signatures catch null dereferences, arity bugs and unknown properties', () => {
  const dir = makeTempFixture();
  try {
    const beforeFiles = listAllFiles(dir);
    // 最简单漏判反例：data-layer-globals.d.ts 把跨文件 helper 全标成 any，导致返回 null 未判空、多传必选外错误属性或漏参都不报错。
    appendFileSync(
      join(dir, 'bookmark-services.js'),
      [
        '',
        'function __pbpTypecheckProbe(rawUrl) {',
        '  const pattern = pbpEndpointOriginPattern(rawUrl);',
        '  const badLen = pattern.length;',
        '  const stripped = stripTrackingParams(rawUrl);',
        '  const badProp = stripped.nonExistentField;',
        '  const badArity = pbpBookmarkEndpoint();',
        '  return [badLen, badProp, badArity];',
        '}',
      ].join('\n'),
    );

    const res = runDataLayerTypecheck({ root: dir, qaRoot: QA_ROOT });
    assert.equal(res.ok, false, 'injected null/property/arity defects must fail typecheck');
    // TS18047 ('pattern' is possibly 'null') or TS2531, TS2339 (Property 'nonExistentField' does not exist), TS2554 (Expected 1 arguments, but got 0)
    assert.ok(
      res.codes.includes(18047) || res.codes.includes(2531),
      `expected null-dereference diagnostic code, got ${JSON.stringify(res.codes)}:\n${res.errors.join('\n')}`,
    );
    assert.ok(
      res.codes.includes(2339),
      `expected unknown-property diagnostic TS2339, got ${JSON.stringify(res.codes)}:\n${res.errors.join('\n')}`,
    );
    assert.ok(
      res.codes.includes(2554),
      `expected arity diagnostic TS2554, got ${JSON.stringify(res.codes)}:\n${res.errors.join('\n')}`,
    );
    assert.deepEqual(listAllFiles(dir), beforeFiles, 'failed check must also leave zero emitted files');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
