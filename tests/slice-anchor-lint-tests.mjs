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
  analyzeFile, testFiles, compareCounts, nextBaseline, compareBaselineFiles, markerPlacement, cleanupList, scriptBlocks,
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
test('a helper reading the source from its closure counts at its call sites', () => {
  const a = anchorsOf(`(async () => { ${LOAD} const block = (from, to) => { const s = src.indexOf(from); const e = src.indexOf(to, s); if (s < 0 || e < 0) throw 1; return src.slice(s, e); }; block("function k(", "function l("); })();`);
  assert.deepEqual(a.map((x) => [x.form, x.marker.value, x.targets[0], x.checked]), [['helper:block', 'function k(', 'popup.js', true], ['helper:block', 'function l(', 'popup.js', true]]);
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


// ---- review round 1: ordinary spellings that used to slip past the count ----
const markers = (a) => a.map((x) => x.marker.value);
test('a direct eval in the same scope does not hide the source (script and module top level)', () => {
  assert.deepEqual(markers(anchorsOf(`(async () => { const s = await (await fetch('../popup.js')).text(); eval(s.slice(s.indexOf('function foo'))); })();`)), ['function foo']);
  assert.deepEqual(markers(anchorsOf(`import { readFileSync } from "node:fs"; const s = readFileSync("popup.js", "utf8"); eval(s.slice(s.indexOf("function bar")));`, 'tests/x-tests.mjs')), ['function bar']);
});
test('a match kept through || [] counts; a match inside an if test does not', () => {
  const a = anchorsOf(`(async () => { ${LOAD} const v = (src.match(/K = (\\d+)/) || [])[1]; if (src.match(/a/) || src.match(/b/)) v; const n = (src.match(/d/g) || []).length + src.match(/e/g).length; return !(src.match(/c/) && 1); })();`);
  assert.deepEqual(a.map((x) => x.marker.value), ['K = (\\d+)']);
});
test('a regex held in a const counts as the receiver of exec; test() stays a presence check', () => {
  const a = anchorsOf(`(async () => { ${LOAD} const RE = /function z\\(/g; const m = RE.exec(src); const T = /y/; T.test(src); return m; })();`);
  assert.deepEqual(a.map((x) => [x.form, x.marker.value]), [['exec', 'function z\\(']]);
});
test('source through block-bodied and function callbacks, a chained then, a fetch alias and a URL object', () => {
  const a = anchorsOf(`
fetch("../popup.js").then((r) => { return r.text(); }).then((s) => s.slice(s.indexOf("A2")));
fetch("../popup.js").then(function (r) { return r.text(); }).then(function (s) { s.slice(s.indexOf("B2")); });
(async () => {
  const u = new URL("../popup.js", location.href);
  const t = await (await fetch(u)).text(); t.slice(t.indexOf("C2"));
  const realFetch = window.fetch;
  const sources = {};
  for (const f of ["popup.js"]) sources[f] = await (await realFetch("../" + f)).text();
  for (const [f, code] of Object.entries(sources)) code.slice(code.indexOf("D2"));
})();`);
  assert.deepEqual(markers(a).sort(), ['A2', 'B2', 'C2', 'D2']);
});
test('an array built before its source is known still carries it (Promise.all of then callbacks)', () => {
  const a = anchorsOf(`(async () => { const [source] = await Promise.all([fetch("../popup.js").then((response) => response.text())]);
  const sites = [[source, "k"]]; for (const [s, key] of sites) s.slice(s.indexOf("S2")); })();`);
  assert.deepEqual(markers(a), ['S2']);
});
test('node: a path held in a const, and a loop over the root listing', () => {
  const a = anchorsOf(`import { readFileSync, readdirSync } from "node:fs"; import { join } from "node:path";
const ROOT = "/r"; const P = join(ROOT, "popup.js"); const s = readFileSync(P, "utf8"); s.slice(s.indexOf("E2"));
const read = (f) => readFileSync(join(ROOT, f), "utf8");
for (const f of readdirSync(ROOT).filter((n) => n.endsWith(".js"))) { const src = read(f); src.slice(src.indexOf("F2")); }
for (const f of readdirSync(join(ROOT, "tests"))) { const t = read(f); t.slice(t.indexOf("not-runtime")); }
for (const g of readdirSync(ROOT)) { const d = readFileSync(join(ROOT, g), "utf8"); d.slice(d.indexOf("G3")); }`, 'tests/x-tests.mjs');
  assert.deepEqual(a.map((x) => [x.marker.value, x.targets[0]]), [['E2', 'popup.js'], ['F2', '?'], ['G3', '?']]);
});
test('split pieces: pop(), slice(k), and a kept array read by index', () => {
  const a = anchorsOf(`(async () => { ${LOAD} src.split("// G2").pop(); src.split("// H2").slice(1); const parts = src.split("// I2"); parts[1]; const all = src.split("// J2"); all.length; })();`);
  assert.deepEqual(markers(a), ['// G2', '// H2', '// I2']);
});
test('helpers: a wrapper passing its parameter on, an object method, a marker in an options object', () => {
  const a = anchorsOf(`
function extract(s, m) { return s.slice(s.indexOf(m)); }
const H = { cut(s, m) { return s.slice(s.indexOf(m)); } };
function between(s, o) { return s.slice(s.indexOf(o.start), s.indexOf(o.end)); }
(async () => { ${LOAD}
  const fn = (n) => extract(src, "function " + n); fn("K2");
  H.cut(src, "L2");
  between(src, { start: "M2", end: "N2" });
})();`);
  assert.deepEqual(a.map((x) => [x.form, x.marker.value]).sort(), [['helper:between', 'M2'], ['helper:between', 'N2'], ['helper:cut', 'L2'], ['helper:fn', 'K2']]);
});
test('markers from a let written once and from a loop over a literal array; a reassigned let does not count', () => {
  const a = anchorsOf(`(async () => { ${LOAD} let m = "O2"; src.slice(src.indexOf(m)); let w = "x"; w = location.hash; src.indexOf(w) + 1; for (const k of ["P2", "Q2"]) src.slice(src.indexOf(k)); })();`);
  assert.deepEqual(markers(a), ['O2', 'P2', 'Q2']);
});
test('.cjs and .htm test files are scanned', () => {
  const root = mkdtempSync(join(tmpdir(), 'pbp-slice-ext-'));
  try {
    mkdirSync(join(root, 'tests'));
    for (const f of ['a.cjs', 'b.htm', 'c.txt']) writeFileSync(join(root, 'tests', f), '');
    assert.deepEqual(testFiles(root), ['tests/a.cjs', 'tests/b.htm']);
    assert.equal(analyzeFile(html(`(async () => { ${LOAD} src.slice(src.indexOf("R2")); })();`), 'tests/b.htm', RUNTIME).anchors.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


// ---- review round 2 ----
const LATE = 'const [src] = await Promise.all([fetch("../popup.js").then((response) => response.text())]);\n';
test('split with a regex separator counts; a whitespace-only separator does not', () => {
  const a = anchorsOf(`(async () => { ${LOAD} src.split(/<div\\b/)[0]; src.split(/\\}\\s*else/).slice(1); src.split(/\\r?\\n/)[1]; src.split(/\\s+/)[0]; src.split(/\\n/).pop(); src.split("\\n")[2]; })();`);
  assert.deepEqual(a.map((x) => x.marker.value), ['<div\\b', '\\}\\s*else']);
});
test('a loader cutting the text of its path parameter counts at its call sites (read and block-bodied then)', () => {
  const a = anchorsOf(`import { readFileSync } from "node:fs"; import { join } from "node:path"; const ROOT = "/r";
function audit(f) { const s = readFileSync(join(ROOT, f), "utf8"); return s.slice(s.indexOf("A3")); }
audit("popup.js");
const load = (f) => fetch("../" + f).then((r) => { return r.text(); });
const t = await load("background.js"); t.slice(t.indexOf("B3"));`, 'tests/x-tests.mjs');
  assert.deepEqual(a.map((x) => [x.marker.value, x.targets.join()]), [['A3', 'popup.js'], ['B3', 'background.js']]);
});
test('containers built before the source is known: objects merge member by member too', () => {
  const a = anchorsOf(`(async () => { ${LATE} const early = await (await fetch("../background.js")).text(); const box = { e: early, s: src }; box.s.slice(box.s.indexOf("O3")); })();`);
  assert.deepEqual(a.map((x) => [x.marker.value, x.targets.join()]), [['O3', 'popup.js']]);
});
test('the array from a const regex exec carries the source; split pieces by shift() and at(); Object.values', () => {
  const a = anchorsOf(`(async () => { ${LOAD} const RE = /function z\\(/; const m = RE.exec(src); m.input.length; const piece = m[0]; piece.slice(piece.indexOf("Z3"));
  src.split("// T3").shift(); src.split("// U3").at(-1); const o = { a: src }; for (const v of Object.values(o)) v.slice(v.indexOf("V3")); })();`);
  assert.deepEqual(markers(a).sort(), ['// T3', '// U3', 'V3', 'Z3', 'function z\\(']);
});
test('node: a read of each name in a literal array; a root listing filtered to docs is not source', () => {
  const a = anchorsOf(`import { readFileSync, readdirSync } from "node:fs"; import { join } from "node:path"; const ROOT = "/r";
const read = (f) => readFileSync(join(ROOT, f), "utf8");
for (const f of ["popup.css", "background.js"]) { const s = read(f); s.slice(s.indexOf("W3")); }
for (const f of readdirSync(ROOT).filter((n) => n.endsWith(".md"))) { const d = read(f); d.slice(d.indexOf("not-source")); }
for (const f of readdirSync(ROOT).filter((n) => /\\.json$/.test(n))) { const d = read(f); d.slice(d.indexOf("not-source-2")); }`, 'tests/x-tests.mjs');
  assert.deepEqual(a.map((x) => [x.marker.value, x.targets.join()]), [['W3', 'background.js,popup.css']]);
});
test('a held match read only through .length is a count; one read otherwise is a cut', () => {
  const a = anchorsOf(`(async () => { ${LOAD} const caps = src.match(/c1/g) || []; caps.length === 0; const hits = src.match(/c2/g) || []; hits.length && hits.join(" "); })();`);
  assert.deepEqual(markers(a), ['c2']);
});
test('a template with a const and new RegExp(literal) are literal markers', () => {
  const a = anchorsOf(`(async () => { ${LOAD} const NAME = "foo"; src.slice(src.indexOf(\`function \${NAME}(\`)); src.match(new RegExp("bar\\\\(", "g"))[0]; })();`);
  assert.deepEqual(markers(a), ['function foo(', 'bar\\(']);
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
