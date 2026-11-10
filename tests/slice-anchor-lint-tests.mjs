// Self-test for scripts/slice-anchor-lint.mjs. Every sample below is written
// by hand; nothing is generated from the lint itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  analyzeFile, compareCounts, nextBaseline, compareBaselineFiles, markerPlacement, cleanupList, scriptBlocks,
} from '../scripts/slice-anchor-lint.mjs';

// A throwaway git repo is built below: forget every git variable the caller
// handed down first (a pre-commit hook exports GIT_DIR and GIT_INDEX_FILE).
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = new Set(['popup.js', 'background.js', 'popup.html', 'popup.css']);
const html = (body) => `<!doctype html><script src="../shared.js"></script>\n<script>\n${body}\n</script>`;
const anchorsOf = (body, file = 'tests/x-tests.html') => {
  const r = analyzeFile(file.endsWith('.html') ? html(body) : body, file, RUNTIME);
  assert.deepEqual(r.errors, []);
  return r.anchors;
};
const LOAD = 'const src = await (await fetch("../popup.js")).text();\n';

// ---- what counts ----
test('indexOf + slice on fetched runtime source counts both markers', () => {
  const a = anchorsOf(`(async () => { ${LOAD} const s = src.indexOf("function a("); const e = src.indexOf("function b(", s); new Function(src.slice(s, e)); })();`);
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((x) => x.marker.value), ['function a(', 'function b(']);
  assert.deepEqual(a[0].targets, ['popup.js']);
});
test('lastIndexOf and search count', () => {
  const a = anchorsOf(`(async () => { ${LOAD} const x = src.lastIndexOf("}"); const y = src.search(/function c\\(/); return src.slice(y, x); })();`);
  assert.deepEqual(a.map((x) => x.form), ['lastIndexOf', 'search']);
  assert.equal(a[1].marker.kind, 'regex');
});
test('regex cuts: match, matchAll and RegExp#exec count when the result is kept', () => {
  const a = anchorsOf(`(async () => { ${LOAD} const m = src.match(/function d\\([\\s\\S]*?\\n}/); const all = [...src.matchAll(/id="(\\w+)"/g)]; const e = /const K = (\\d+)/.exec(src); return [m, all, e]; })();`);
  assert.deepEqual(a.map((x) => x.form), ['match', 'matchAll', 'exec']);
});
test('split counts only when one piece is taken', () => {
  const a = anchorsOf(`(async () => { ${LOAD} const tail = src.split("// ==== Tail")[1]; const [head] = src.split("// ==== Head"); const lines = src.split("\\n"); for (const l of src.split("// x")) l; return [tail, head, lines]; })();`);
  assert.deepEqual(a.map((x) => x.marker.value), ['// ==== Tail', '// ==== Head']);
});
test('a helper taking the marker as a parameter counts at each literal call site', () => {
  const a = anchorsOf(`
function fnSource(source, signature) { const at = source.indexOf(signature); if (at < 0) throw new Error("x"); return source.slice(at, source.indexOf("\\n}\\n", at) + 2); }
function bodyOf(source, name) { return source.slice(source.indexOf("function " + name + "(")); }
(async () => { ${LOAD} fnSource(src, "function e("); fnSource(src, "function f("); bodyOf(src, "g"); const dyn = "h" + Math.random(); fnSource(src, dyn); })();`);
  const helpers = a.filter((x) => x.form.startsWith('helper:'));
  assert.deepEqual(helpers.map((x) => x.marker.value), ['function e(', 'function f(', 'g']);
  assert.equal(helpers[0].checked, true, 'fnSource checks its marker');
  assert.equal(helpers[2].checked, false, 'bodyOf does not');
  assert.equal(a.filter((x) => x.form === 'indexOf').length, 1, 'the helper\'s own literal end marker still counts, once');
});
test('sources reached through Promise.all, .then(r => r.text()), objects, params and for-of', () => {
  const a = anchorsOf(`
function cut(text) { return text.slice(text.indexOf("A1")); }
(async () => {
  const [p, b, j] = await Promise.all([fetch("../popup.js").then((r) => r.text()), fetch("../background.js").then((r) => r.text()), fetch("../_locales/en/messages.json").then((r) => r.json())]);
  const all = { popup: p, bg: b };
  all.popup.indexOf("B1"); cut(b);
  for (const s of [p, b]) s.indexOf("C1");
  JSON.stringify(j).indexOf("not-source");
})();`);
  const byMarker = Object.fromEntries(a.map((x) => [x.marker.value, x.targets]));
  assert.deepEqual(Object.keys(byMarker).sort(), ['A1', 'B1', 'C1']);
  assert.deepEqual(byMarker.B1, ['popup.js']);
  assert.deepEqual(byMarker.A1, ['background.js']);
  assert.deepEqual(byMarker.C1, ['background.js', 'popup.js']);
});
test('node tests: readFileSync(join(ROOT, file)) and a local read() loader', () => {
  const a = anchorsOf(`import { readFileSync } from "node:fs"; import { join } from "node:path";
const ROOT = "/r"; const read = (f) => readFileSync(join(ROOT, f), "utf8");
const css = read("popup.css"); const bg = readFileSync(join(ROOT, "background.js"), "utf8"); const fx = read("tests/fixtures/x.html");
css.slice(css.indexOf(".a {")); bg.slice(bg.indexOf("function z(")); fx.slice(fx.indexOf("fixture"));`, 'tests/x-tests.mjs');
  assert.deepEqual(a.map((x) => [x.marker.value, x.targets[0]]), [['.a {', 'popup.css'], ['function z(', 'background.js']]);
});
test('a const marker resolves; a computed marker does not count', () => {
  const a = anchorsOf(`const START = "// ---- start"; (async () => { ${LOAD} src.slice(src.indexOf(START)); src.slice(src.indexOf(window.name)); })();`);
  assert.deepEqual(a.map((x) => x.marker.value), ['// ---- start']);
});

test('an order assertion between two markers counts both (it locates, it does not test presence)', () => {
  const a = anchorsOf(`(async () => { ${LOAD} assert(src.indexOf("first") < src.indexOf("second"), "order"); })();`);
  assert.deepEqual(a.map((x) => x.marker.value), ['first', 'second']);
});

// ---- what does not count ----
test('presence checks do not count', () => {
  const a = anchorsOf(`(async () => { ${LOAD} if (src.indexOf("x") === -1) throw 1; assert(src.indexOf("y") >= 0); src.includes("z"); /w/.test(src); if (src.match(/v/)) 1; assert(src.match(/u/), "m"); return src.indexOf("t") !== -1 && !src.match(/s/); })();`);
  assert.deepEqual(a, []);
});
test('indexOf on non-source data does not count', () => {
  const a = anchorsOf(`(async () => { const r = await (await fetch("fixtures/x.json")).text(); r.slice(r.indexOf("a")); const out = render(); out.slice(out.indexOf("b")); [1,2].indexOf(2); document.body.textContent.indexOf("c"); })();`);
  assert.deepEqual(a, []);
});
test('decoys in comments and string contents are not read as code', () => {
  const a = anchorsOf(`// const s = src.slice(src.indexOf("comment decoy"));
/* src.indexOf("block decoy") */
(async () => { ${LOAD} const msg = 'src.slice(src.indexOf("string decoy"))'; const t = \`src.indexOf("template decoy")\`; return [msg, t]; })();`);
  assert.deepEqual(a, []);
});
test('HTML: only inline scripts are read, with their line numbers', () => {
  const text = '<!doctype html>\n<script src="../popup.js"></script>\n<script type="text/plain">src.indexOf("plain")</script>\n<script>\n(async () => {\n' + LOAD + 'src.slice(src.indexOf("here"));\n})();\n</script>';
  assert.equal(scriptBlocks(text, 'tests/a-tests.html').length, 1);
  const r = analyzeFile(text, 'tests/a-tests.html', RUNTIME);
  assert.equal(r.anchors.length, 1);
  assert.equal(r.anchors[0].line, 7);
});
test('a script block that does not parse is an error, not zero anchors', () => {
  const r = analyzeFile(html('const = ;'), 'tests/x-tests.html', RUNTIME);
  assert.equal(r.errors.length, 1);
});

// ---- "not found" checks ----
test('an index stored and compared with -1 or < 0 is checked; an inline one is not', () => {
  const a = anchorsOf(`(async () => { ${LOAD} const s = src.indexOf("one"); if (s < 0) throw 1; const e = src.indexOf("two"); return src.slice(s, e) + src.slice(src.indexOf("three")); })();`);
  assert.deepEqual(a.map((x) => [x.marker.value, x.checked]), [['one', true], ['two', false], ['three', false]]);
});
test('a match read at once throws on a miss and counts as checked; split never is', () => {
  const a = anchorsOf(`(async () => { ${LOAD} const g = src.match(/a(b)/)[1]; const m = src.match(/c/); const n = src.match(/d/); if (!n) throw 1; return [g, m?.[0], src.split("e")[1], n]; })();`);
  assert.deepEqual(a.map((x) => [x.form, x.checked]), [['match', true], ['match', false], ['match', true], ['split', false]]);
});

// ---- marker placement in the target ----
const dir = mkdtempSync(join(tmpdir(), 'pbp-slice-anchor-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
test('a marker found only inside comments of the target is comment-only; absent is missing', () => {
  const root = join(dir, 'place');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'popup.js'), '// ---- Section A ----\nfunction a() { return "// in a string"; }\n/* block marker */\n');
  assert.equal(markerPlacement(root, 'popup.js', { kind: 'string', value: '// ---- Section A' }), 'comment');
  assert.equal(markerPlacement(root, 'popup.js', { kind: 'string', value: 'block marker' }), 'comment');
  assert.equal(markerPlacement(root, 'popup.js', { kind: 'string', value: '// in a string' }), 'code');
  assert.equal(markerPlacement(root, 'popup.js', { kind: 'string', value: 'function a(' }), 'code');
  assert.equal(markerPlacement(root, 'popup.js', { kind: 'string', value: 'nowhere' }), 'missing');
  assert.equal(markerPlacement(root, 'popup.js', { kind: 'regex', value: 'Section\\s+A', flags: '' }), 'comment');
  const list = cleanupList(root, [
    { marker: { kind: 'string', value: '// ---- Section A' }, targets: ['popup.js'], checked: true },
    { marker: { kind: 'string', value: 'function a(' }, targets: ['popup.js'], checked: false },
  ]);
  assert.equal(list.commentOnly.length, 1);
  assert.equal(list.unchecked.length, 1);
});

// ---- baseline rules ----
const B = { total: 7, files: { 'tests/a.html': { count: 5 }, 'tests/b.html': { count: 2 } } };
test('same counts pass', () => assert.deepEqual(compareCounts(B, { 'tests/a.html': 5, 'tests/b.html': 2 }).grown, []));
test('a file growing fails and names it', () => {
  const r = compareCounts(B, { 'tests/a.html': 6, 'tests/b.html': 1 });
  assert.equal(r.grown.length, 1);
  assert.match(r.grown[0], /tests\/a\.html: 5 -> 6/);
});
test('a new file with anchors fails', () => {
  const r = compareCounts(B, { 'tests/a.html': 4, 'tests/b.html': 2, 'tests/c.html': 1 });
  assert.equal(r.grown.length, 1);
  assert.match(r.grown[0], /tests\/c\.html: new file/);
});
test('the total growing fails even when spread over files', () => {
  const r = compareCounts(B, { 'tests/a.html': 5, 'tests/b.html': 3 });
  assert.ok(r.grown.some((l) => /^total: 7 -> 8/.test(l)));
});
test('shrinking passes and is listed for a refresh', () => {
  const r = compareCounts(B, { 'tests/a.html': 3 });
  assert.deepEqual(r.grown, []);
  assert.equal(r.shrunk.length, 2);
});
test('--update logic refuses growth without a reason and records one with it', () => {
  assert.ok(nextBaseline(B, { 'tests/a.html': 6, 'tests/b.html': 2 }).refused);
  assert.ok(nextBaseline(B, { 'tests/a.html': 6 }, { allowGrowth: '  ' }).refused);
  const ok = nextBaseline(B, { 'tests/a.html': 6, 'tests/b.html': 1 }, { allowGrowth: 'no seam yet', date: '2026-11-10' });
  assert.deepEqual(ok.baseline.files['tests/a.html'], { count: 6, growth: [{ date: '2026-11-10', from: 5, to: 6, reason: 'no seam yet' }] });
  assert.equal(ok.baseline.total, 7);
  const shrink = nextBaseline(B, { 'tests/a.html': 1 });
  assert.deepEqual(shrink.baseline.files, { 'tests/a.html': { count: 1 } });
});
test('baseline vs baseline: growth needs a new growth record with a reason', () => {
  const grown = { total: 8, files: { 'tests/a.html': { count: 6 }, 'tests/b.html': { count: 2 } } };
  assert.equal(compareBaselineFiles(B, grown).length, 1);
  const reasoned = { total: 8, files: { 'tests/a.html': { count: 6, growth: [{ date: 'd', from: 5, to: 6, reason: 'r' }] }, 'tests/b.html': { count: 2 } } };
  assert.deepEqual(compareBaselineFiles(B, reasoned), []);
  const stale = { total: 9, files: { 'tests/a.html': { count: 7, growth: [{ date: 'd', from: 5, to: 6, reason: 'r' }] }, 'tests/b.html': { count: 2 } } };
  assert.equal(compareBaselineFiles(reasoned, stale).length, 1, 'an old growth record does not cover a second rise');
  assert.throws(() => compareBaselineFiles(B, { total: 1, files: { 'tests/a.html': { count: 2 } } }), /add up/);
});

// ---- CLI in a throwaway root ----
const cliRoot = join(dir, 'cli');
mkdirSync(join(cliRoot, 'tests'), { recursive: true });
mkdirSync(join(cliRoot, 'scripts'), { recursive: true });
writeFileSync(join(cliRoot, 'popup.js'), 'function a() {}\n// ---- tail\n');
const page = (n) => html(`(async () => { ${LOAD} ${Array.from({ length: n }, (_, i) => `src.slice(src.indexOf("m${i}"));`).join(' ')} })();`);
const cli = (...args) => spawnSync('node', [join(ROOT, 'scripts/slice-anchor-lint.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, PBP_SLICE_ANCHOR_ROOT: cliRoot } });
const baselineFile = join(cliRoot, 'scripts', 'slice-anchor-baseline.json');

test('CLI: missing baseline fails', () => {
  writeFileSync(join(cliRoot, 'tests', 'a-tests.html'), page(2));
  const r = cli();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing/);
});
test('CLI: first --update writes the baseline, check passes', () => {
  assert.equal(cli('--update').status, 0);
  assert.equal(JSON.parse(readFileSync(baselineFile, 'utf8')).total, 2);
  assert.equal(cli().status, 0);
});
test('CLI: growth fails, --update refuses it, --allow-growth records the reason', () => {
  writeFileSync(join(cliRoot, 'tests', 'a-tests.html'), page(3));
  const r = cli();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only shrinks/);
  assert.equal(cli('--update').status, 1);
  assert.equal(cli('--update', '--allow-growth').status, 2);
  assert.equal(cli('--allow-growth', 'why').status, 2);
  assert.equal(cli('--update', '--allow-growth', 'kept for the test').status, 0);
  const b = JSON.parse(readFileSync(baselineFile, 'utf8'));
  assert.equal(b.files['tests/a-tests.html'].growth[0].reason, 'kept for the test');
});
test('CLI: a new test file with anchors fails', () => {
  writeFileSync(join(cliRoot, 'tests', 'b-tests.html'), page(1));
  assert.equal(cli().status, 1);
  rmSync(join(cliRoot, 'tests', 'b-tests.html'));
});
test('CLI: shrinking passes and asks for a refresh', () => {
  writeFileSync(join(cliRoot, 'tests', 'a-tests.html'), page(1));
  const r = cli();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--update/);
});
test('CLI: a broken baseline fails', () => {
  const keep = readFileSync(baselineFile, 'utf8');
  writeFileSync(baselineFile, JSON.stringify({ total: 99, files: { 'tests/a-tests.html': { count: 1 } } }));
  assert.equal(cli().status, 1);
  writeFileSync(baselineFile, keep);
});
test('CLI --compare: growth without a reason exits 1, malformed input exits 2', () => {
  const o = join(dir, 'old.json'), n = join(dir, 'new.json');
  writeFileSync(o, JSON.stringify(B));
  writeFileSync(n, JSON.stringify({ total: 8, files: { 'tests/a.html': { count: 6 }, 'tests/b.html': { count: 2 } } }));
  assert.equal(cli('--compare', o, n).status, 1);
  assert.equal(cli('--compare', o, o).status, 0);
  writeFileSync(n, '{ nope');
  assert.equal(cli('--compare', o, n).status, 2);
  assert.equal(cli('--compare', o).status, 2);
});

// ---- the pre-commit hook refuses a deleted or renamed baseline ----
test('pre-commit: deleting or renaming the baseline is blocked', () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  for (const f of ['scripts/pre-commit-hook.sh', 'scripts/slice-anchor-lint.mjs']) writeFileSync(join(repo, f), readFileSync(join(ROOT, f)));
  writeFileSync(join(repo, 'scripts/slice-anchor-baseline.json'), JSON.stringify({ note: '', total: 0, files: {} }));
  const git = (...a) => spawnSync('git', a, { cwd: repo, env, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  const where = git('rev-parse', '--absolute-git-dir').stdout.trim();
  if (realpathSync(where) !== join(realpathSync(repo), '.git')) throw new Error(`git points at ${where}, not the throwaway repo; refusing to go on`);
  git('add', 'scripts/slice-anchor-baseline.json');
  assert.equal(git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-gpg-sign', '-m', 'init').status, 0);
  git('mv', 'scripts/slice-anchor-baseline.json', 'scripts/renamed.json');
  const r = spawnSync('sh', ['scripts/pre-commit-hook.sh'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /slice-anchor-baseline\.json cannot be deleted or renamed/);
});
