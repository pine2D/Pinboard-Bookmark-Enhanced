// Self-tests for scripts/typecheck-data-layer.mjs (dev-only JSDoc + strictNullChecks
// gate over the 28 pure data-layer, sync, backup, send, cache, AI, dictionary and conversion files). Node only, 0 slice anchors.
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
  assert.equal(DATA_LAYER_FILES.length, 28);
  const res = runDataLayerTypecheck({ root: ROOT });
  assert.equal(res.ok, true, res.errors.join('\n'));
  assert.equal(res.checkedFiles, 28);
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

    // 3. Dropping any of the 28 checked files from files[] must fail closed.
    for (const target of ['notes-sync.js', 'vocab-gdrive.js', 'options-backup.js', 'ai.js', 'dict-pack.js', 'md-convert.js']) {
      writeFileSync(cfgPath, JSON.stringify({
        ...baseCfg,
        files: baseCfg.files.filter((f) => !f.endsWith(target)),
      }, null, 2));
      const missingFile = runDataLayerTypecheck({ root: dir, qaRoot: QA_ROOT });
      assert.equal(missingFile.ok, false);
      assert.match(missingFile.errors.join('\n'), new RegExp(target.replace('.', '\\.')));
    }
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
    appendFileSync(
      join(dir, 'options-backup.js'),
      [
        '',
        'function __pbpTypecheckDomProbe() {',
        '  const unguarded = $id("missing-el").textContent;',
        '  const providers = pbpSanitizeAiCustomProviders(null);',
        '  const badCount = providers.length;',
        '  return [unguarded, badCount];',
        '}',
      ].join('\n'),
    );
    appendFileSync(
      join(dir, 'export-targets.js'),
      [
        '',
        'async function __pbpTypecheckExpandedModuleProbe() {',
        '  const badObsidian = buildObsidianUri({ title: "wrong-prop" });',
        '  const meta = await pbpEcdictMeta();',
        '  const unguardedMeta = meta.state;',
        '  const badFetchArity = fetchWithTimeout();',
        '  const renderer = new marked.Renderer();',
        '  const okDef = renderer.def({ type: "def" });',
        '  const unguardedParser = renderer.parser.parse([]);',
        '  const badRenderer = renderer.nonExistentHook;',
        '  return [badObsidian, unguardedMeta, badFetchArity, okDef, unguardedParser, badRenderer];',
        '}',
      ].join('\n'),
    );

    const res = runDataLayerTypecheck({ root: dir, qaRoot: QA_ROOT });
    assert.equal(res.ok, false, 'injected null/property/arity defects must fail typecheck');
    // TS18047 ('pattern'/'meta' is possibly 'null') or TS2531, TS2339 (unknown property), TS2353 (unknown object-literal option), TS2554 (wrong arity)
    assert.ok(
      res.codes.includes(18047) || res.codes.includes(2531),
      `expected null-dereference diagnostic code, got ${JSON.stringify(res.codes)}:\n${res.errors.join('\n')}`,
    );
    assert.ok(
      res.codes.includes(2339),
      `expected unknown-property diagnostic TS2339, got ${JSON.stringify(res.codes)}:\n${res.errors.join('\n')}`,
    );
    assert.ok(
      res.codes.includes(2353),
      `expected excess-property diagnostic TS2353 on buildObsidianUri, got ${JSON.stringify(res.codes)}:\n${res.errors.join('\n')}`,
    );
    assert.ok(
      res.errors.some((line) => line.includes('meta') && (line.includes('TS18047') || line.includes('TS2531'))),
      `expected null-dereference diagnostic on pbpEcdictMeta(), got:\n${res.errors.join('\n')}`,
    );
    assert.ok(
      res.errors.some((line) => line.startsWith('export-targets.js:') && line.includes('TS2554') && line.includes('Expected 1-3 arguments')),
      `expected arity diagnostic TS2554 on fetchWithTimeout(), got:\n${res.errors.join('\n')}`,
    );
    assert.ok(
      res.errors.some((line) => line.includes('nonExistentHook') && line.includes('TS2339')),
      `expected unknown-property diagnostic TS2339 on marked.Renderer, got:\n${res.errors.join('\n')}`,
    );
    assert.ok(
      res.errors.some((line) => line.includes('renderer.parser') && (line.includes('TS18048') || line.includes('TS2532'))),
      `expected possibly-undefined diagnostic on (new marked.Renderer()).parser, got:\n${res.errors.join('\n')}`,
    );
    assert.ok(
      !res.errors.some((line) => line.includes("Property 'def'")),
      `marked.Renderer.prototype.def must be recognized without error, got:\n${res.errors.join('\n')}`,
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
