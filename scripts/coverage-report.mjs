#!/usr/bin/env node
// Never-run function report (dev tool: not in verify.sh, not in CI).
//
//   node scripts/coverage-report.mjs                      # every tests/*-tests.html
//   node scripts/coverage-report.mjs tests/a-tests.html   # only the pages named
//
// Runs the HTML test pages through scripts/run-html-suites.mjs with
// PBP_COVERAGE_DIR set, so .qa-scan/run-test.mjs records Playwright's V8 JS
// coverage per page (same runner, same verdicts). Then it merges the pages and
// writes, under $PBP_QA_REPORT_DIR/coverage/ (default
// ~/.local/share/pbp-qa-report/coverage/, never inside the repo):
//   never-run.md   per runtime root script: functions never executed (name,
//                  line) and per-file totals
//   summary.json   the same as data
//   raw/<page>.json  the V8 coverage of each page (url + function ranges)
//
// Only functions of runtime root *.js files that a page loaded BY URL count.
// Source a test cut out of a file and ran through new Function / eval shows up
// in V8 as an anonymous script with no url, and is NOT credited to the file it
// was cut from. So a function that only runs through such a slice is listed as
// never run: that is the blind spot this report measures.
//
// Functions are enumerated by parsing each runtime file with espree; a V8
// function entry marks one as run when it ends at the same offset (start
// matched as closely as possible) and its call count is above zero. A file no
// page loaded is listed with all its functions and marked "not loaded".
// Exit 0 when the report was written, even if some pages failed (they are
// named in the report; their coverage up to the failure still counts).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(ROOT, '.qa-scan', 'package.json'));

// The report folder, made absolute first: a relative PBP_QA_REPORT_DIR is
// read against the current folder, which may be the repo.
export function reportDir(env = process.env, cwd = process.cwd()) {
  return resolve(cwd, env.PBP_QA_REPORT_DIR || join(homedir(), '.local/share/pbp-qa-report'), 'coverage');
}
export const isInside = (dir, root) => dir === root || dir.startsWith(root + '/');

export function runtimeScripts(root = ROOT) {
  return readdirSync(root).filter((n) => n.endsWith('.js') && statSync(join(root, n)).isFile()).sort();
}

// Every function in a script: { name, line, start, end }.
export function functionsOf(text) {
  const espree = require('espree');
  let ast;
  try { ast = espree.parse(text, { ecmaVersion: 'latest', sourceType: 'script', range: true, loc: true }); } catch {
    ast = espree.parse(text, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
  }
  const out = [];
  const keyName = (k) => (k.type === 'Identifier' ? k.name : k.type === 'Literal' ? String(k.value) : null);
  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    if (/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) {
      let name = node.id ? node.id.name : null;
      if (!name && parent) {
        if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') name = parent.id.name;
        else if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key) name = keyName(parent.key);
        else if (parent.type === 'AssignmentExpression' && parent.left.type === 'MemberExpression' && !parent.left.computed) name = parent.left.property.name;
        else if (parent.type === 'AssignmentExpression' && parent.left.type === 'Identifier') name = parent.left.name;
      }
      out.push({ name: name || '<anonymous>', line: node.loc.start.line, start: node.range[0], end: node.range[1] });
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => visit(c, node));
      else if (v && typeof v.type === 'string') visit(v, node);
    }
  };
  visit(ast, null);
  return out;
}

// Which of `fns` ran, given V8 function entries of one script.
export function executedSet(fns, v8Functions) {
  const byEnd = new Map();
  for (const f of v8Functions) {
    const r = f.ranges && f.ranges[0];
    if (!r || (f.functionName === '' && r.startOffset === 0)) continue; // the whole-script entry
    if (!byEnd.has(r.endOffset)) byEnd.set(r.endOffset, []);
    byEnd.get(r.endOffset).push(r);
  }
  const ran = new Set();
  fns.forEach((fn, i) => {
    const cands = (byEnd.get(fn.end) || []).filter((r) => r.startOffset >= fn.start - 1 && r.startOffset < fn.end);
    if (!cands.length) {
      // A method's V8 range starts at its name, before espree's FunctionExpression.
      const before = (byEnd.get(fn.end) || []).filter((r) => r.startOffset < fn.start && r.startOffset >= fn.start - 200);
      if (!before.length) return;
      before.sort((a, b) => b.startOffset - a.startOffset);
      if (before[0].count > 0) ran.add(i);
      return;
    }
    cands.sort((a, b) => Math.abs(a.startOffset - fn.start) - Math.abs(b.startOffset - fn.start));
    if (cands[0].count > 0) ran.add(i);
  });
  return ran;
}

const pathOfUrl = (url) => { try { return decodeURIComponent(new URL(url).pathname).replace(/^\//, ''); } catch { return null; } };

// docs: [{ page, entries: [{ url, functions }] }]. files: repo-relative paths that count.
export function mergeCoverage(docs, { root = ROOT, files = runtimeScripts(root) } = {}) {
  const wanted = new Set(files);
  const fileFns = new Map();
  const result = { files: {}, anonymousScripts: 0, anonymousRan: 0, pages: docs.map((d) => d.page) };
  for (const f of files) {
    fileFns.set(f, functionsOf(readFileSync(join(root, f), 'utf8')));
    result.files[f] = { loadedBy: [], ran: new Set() };
  }
  for (const doc of docs) {
    for (const e of doc.entries) {
      if (!e.url) {
        result.anonymousScripts++;
        if (e.functions.some((f) => f.ranges[0] && f.ranges[0].count > 0)) result.anonymousRan++;
        continue;
      }
      const p = pathOfUrl(e.url);
      if (!p || !wanted.has(p)) continue;
      const slot = result.files[p];
      if (!slot.loadedBy.includes(doc.page)) slot.loadedBy.push(doc.page);
      for (const i of executedSet(fileFns.get(p), e.functions)) slot.ran.add(i);
    }
  }
  const out = { pages: result.pages, anonymousScripts: result.anonymousScripts, anonymousRan: result.anonymousRan, files: {} };
  for (const f of files) {
    const fns = fileFns.get(f);
    const slot = result.files[f];
    const neverRun = fns.filter((_, i) => !slot.ran.has(i)).map(({ name, line }) => ({ name, line }));
    out.files[f] = { total: fns.length, run: fns.length - neverRun.length, neverRun, loadedBy: slot.loadedBy.sort() };
  }
  return out;
}

export function renderMarkdown(summary, { failedPages = [], date = new Date().toISOString() } = {}) {
  const lines = [];
  lines.push('# Never-run functions');
  lines.push('');
  lines.push(`Generated ${date} by scripts/coverage-report.mjs from ${summary.pages.length} test page(s).`);
  lines.push('');
  lines.push('Only functions of runtime root scripts loaded by URL count. Code that a test cut out of a file and ran through `new Function` or `eval` runs as an anonymous script and is **not** credited to its file: a function that only runs that way is listed here as never run. That is the blind spot this report measures.');
  lines.push('');
  lines.push(`Anonymous (eval / new Function) scripts seen: ${summary.anonymousScripts}, of which ${summary.anonymousRan} ran code.`);
  if (failedPages.length) { lines.push(''); lines.push(`Pages that failed (their coverage up to the failure still counts): ${failedPages.join(', ')}`); }
  lines.push('');
  lines.push('| file | functions | never run | loaded by pages |');
  lines.push('|---|---:|---:|---:|');
  const files = Object.keys(summary.files).sort();
  let tot = 0, never = 0;
  for (const f of files) {
    const s = summary.files[f];
    tot += s.total; never += s.neverRun.length;
    lines.push(`| ${f} | ${s.total} | ${s.neverRun.length} | ${s.loadedBy.length || 'not loaded'} |`);
  }
  lines.push(`| **all** | ${tot} | ${never} | |`);
  for (const f of files) {
    const s = summary.files[f];
    if (!s.neverRun.length) continue;
    lines.push('');
    lines.push(`## ${f}${s.loadedBy.length ? '' : ' (not loaded by any page)'}`);
    lines.push('');
    for (const fn of s.neverRun) lines.push(`- ${fn.name} (line ${fn.line})`);
  }
  return lines.join('\n') + '\n';
}

function main(argv) {
  const outDir = reportDir();
  const rawDir = join(outDir, 'raw');
  if (isInside(outDir, ROOT)) { console.error(`[coverage] refusing to write inside the repo (${outDir}); set PBP_QA_REPORT_DIR outside it`); return 2; }
  rmSync(rawDir, { recursive: true, force: true });
  mkdirSync(rawDir, { recursive: true });
  const run = spawnSync(process.execPath, ['scripts/run-html-suites.mjs', ...argv], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, PBP_COVERAGE_DIR: rawDir, PBP_VERIFY_DRY: '' }, maxBuffer: 1 << 28,
  });
  const failedPages = [...(run.stderr || '').matchAll(/^\s+(tests\/\S+\.html)\s+\(log:/gm)].map((m) => m[1]);
  if (run.status !== 0 && !failedPages.length) {
    process.stderr.write(run.stdout + run.stderr);
    console.error('[coverage] the page runner failed before any page ran');
    return 1;
  }
  const docs = readdirSync(rawDir).filter((n) => n.endsWith('.json')).sort().map((n) => JSON.parse(readFileSync(join(rawDir, n), 'utf8')));
  if (!docs.length) { console.error('[coverage] no page wrote coverage'); return 1; }
  const summary = mergeCoverage(docs);
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ ...summary, failedPages }, null, 2));
  writeFileSync(join(outDir, 'never-run.md'), renderMarkdown(summary, { failedPages }));
  let tot = 0, never = 0;
  for (const s of Object.values(summary.files)) { tot += s.total; never += s.neverRun.length; }
  console.log(`[coverage] ${docs.length} page(s); ${never} of ${tot} functions in ${Object.keys(summary.files).length} runtime scripts never ran`);
  if (failedPages.length) console.log(`[coverage] failed pages (still counted): ${failedPages.join(', ')}`);
  console.log(`[coverage] report: ${join(outDir, 'never-run.md')}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
