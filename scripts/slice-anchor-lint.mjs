#!/usr/bin/env node
// Slice-anchor baseline: the number of places where tests cut runtime source
// text out by a literal marker only goes down.
//
// What an anchor is. A test locates runtime source text by a literal marker so
// that it can run or assert on the code it cut out. Concretely, on a value that
// holds the text of a runtime root file (a repo-root *.js / *.html / *.css):
//   indexOf / lastIndexOf / search with a literal marker, unless the call is
//     only a presence check (compared straight away with -1 or 0);
//   match / matchAll / RegExp#exec with a literal regex (written inline or held
//     in a const, as the argument or as the exec receiver), unless the result
//     is only used as a boolean (if / while / ?: test, operand of !, compared
//     with null, passed straight to an assert, or a && / || chain that itself
//     sits in one of those places; (src.match(re) || [])[1] keeps the value),
//     or only its .length is read ((src.match(/x/g) || []).length counts
//     occurrences and cuts nothing);
//   split with a literal separator when one piece is taken: [k], .pop(),
//     .shift(), .at(k), .slice(k), destructuring, or the array kept in a
//     variable that is later read one of those ways;
//   a call to a test-local helper that does one of the above with a marker it
//     takes as a parameter, counted at each call site that passes a literal
//     marker: extractFunction(src, "name"), fnSource(src, sig), a helper reading
//     the source from its closure (block("start", "end")), a method of an
//     object literal (H.cut(src, "x")), a marker inside an options object
//     (cut(src, { start: "x" })), and a wrapper that hands its own parameter on
//     (fn = (n) => extract(src, "function " + n); fn("foo") counts "foo").
// A literal marker is a string, a template without ${}, a regex literal, a
// `+` chain of those, a const (or a let / var written only once) bound to one
// of them, or the loop variable of for (const m of ["a", "b"]), which counts
// once per element.
// includes / startsWith / RegExp#test are presence checks and never count.
//
// How source text is told from other data. The test JS is parsed with espree
// and scoped with eslint-scope (from .qa-scan/node_modules, optimistic mode so
// a direct eval() does not unresolve the scope); .html / .htm files give their
// inline <script> blocks; .js / .mjs / .cjs files are read whole. A value is
// runtime source when it comes from
//   fetch("../<root file>") (or new URL("../<root file>", ...), or a name bound
//     to fetch such as const realFetch = window.fetch) followed by .text():
//     await, .then(r => r.text()), a block-bodied or function callback that
//     returns r.text(), the parameter of a later .then(src => ...), Promise.all
//     destructuring; or
//   readFileSync / readFile on a path whose literal names a root file, directly
//     or through a const (const P = join(ROOT, "popup.js")), a local
//     read("popup.js") loader, or a loop variable over readdirSync(ROOT)
//     (target "?"); or
//   string methods (slice, substring, replace, trim, ...) and + on such a value,
//   function parameters that receive such a value at a call site in the same
//     file, array / object members (including obj[k] = source and
//     Object.entries / Object.values), for-of and map / forEach callback
//     parameters.
// indexOf on anything else (a rendered string, an array of ids, a fixture
// JSON) is not an anchor. Comments and string contents in the test are never
// read as code, so a commented-out cut or a marker inside a message string
// cannot count.
//
// Known misses (a cut that is not counted). Each keeps the count low, never
// high; the baseline still stops the forms it does see from growing.
//   Source: a global set by another script or page, a value passed through
//     postMessage, this / class fields, Function.prototype.toString of a
//     loaded function, a fetch or read whose path sits in a variable written
//     more than once or comes from anything but a literal, a const, a parameter
//     or a readdirSync(ROOT) loop.
//   Markers: computed at run time; a let / var assigned again; markers walked
//     with ["a", "b"].forEach(m => ...) or any loop other than for-of over a
//     literal array; markers spread into a call.
//   Helpers: defined in another file; reached through .call / .apply, a
//     computed name or an object built at run time; a class method; a helper
//     taking its options destructured (function cut(s, { start })); a split
//     result handed to another function before a piece is taken.
//
// Usage:
//   node scripts/slice-anchor-lint.mjs            check against the baseline
//   node scripts/slice-anchor-lint.mjs --update   rewrite the baseline (shrink only)
//   node scripts/slice-anchor-lint.mjs --update --allow-growth "<reason>"
//   node scripts/slice-anchor-lint.mjs --compare <old.json> <new.json>
//                                                 baseline-to-baseline check (pre-commit)
//   node scripts/slice-anchor-lint.mjs --survey   counts by form, execution form and file
//   node scripts/slice-anchor-lint.mjs --list [--cleanup]   every anchor (or only the cleanup list)
// Exit 0 pass, 1 the count grew / baseline problem, 2 bad input.
// Alongside the check it reports, without failing, anchors whose marker only
// occurs inside a comment of the target file (or not at all) and anchors whose
// result is never checked for "not found". Those are the next cleanup list.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const BASELINE_PATH = join(ROOT, 'scripts', 'slice-anchor-baseline.json');
const require = createRequire(join(ROOT, '.qa-scan', 'package.json'));
let espree, eslintScope;
function loadParsers() {
  if (espree) return;
  try {
    espree = require('espree');
    eslintScope = require('eslint-scope');
  } catch (e) {
    console.error('[slice-anchor] cannot load espree/eslint-scope from .qa-scan/node_modules; run: npm ci --prefix .qa-scan');
    console.error('[slice-anchor] ' + ((e && e.message) || e));
    process.exit(2);
  }
}

// ---------- inputs ----------

export function runtimeRootFiles(root = ROOT) {
  const out = new Set();
  for (const name of readdirSync(root)) {
    if (!/\.(js|html|css)$/.test(name)) continue;
    try { if (statSync(join(root, name)).isFile()) out.add(name); } catch { /* swallow-ok: a vanished file is not a root file */ }
  }
  return out;
}

export function testFiles(root = ROOT) {
  const dir = join(root, 'tests');
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(html?|mjs|cjs|js)$/.test(name)) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// Inline <script> blocks of an HTML file, with their line offset and type.
export function scriptBlocks(text, file) {
  if (!/\.html?$/.test(file)) return [{ code: text, line: 0, module: file.endsWith('.mjs') }];
  const out = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(text))) {
    const attrs = m[1] || '';
    if (/\ssrc\s*=/.test(' ' + attrs)) continue;
    const type = /type\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type[1])) continue;
    const start = m.index + m[0].indexOf('>') + 1;
    out.push({ code: m[2], line: text.slice(0, start).split('\n').length - 1, module: !!(type && /module/i.test(type[1])) });
  }
  return out;
}

function parse(code, module) {
  const opts = { ecmaVersion: 'latest', loc: true, range: true, comment: true };
  const order = module ? ['module', 'script'] : ['script', 'module'];
  let first;
  for (const sourceType of order) {
    try { return { ast: espree.parse(code, { ...opts, sourceType }), sourceType }; } catch (e) { first = first || e; }
  }
  throw first;
}

// ---------- AST helpers ----------

function children(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') out.push(c); }
    else if (v && typeof v.type === 'string') out.push(v);
  }
  return out;
}
function walk(node, fn, parent = null) {
  node.parent = parent;
  fn(node);
  for (const c of children(node)) walk(c, fn, node);
}
const isFn = (n) => n && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);
const memberName = (n) => n && n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier' ? n.property.name
  : n && n.type === 'MemberExpression' && n.computed && n.property.type === 'Literal' ? String(n.property.value) : null;
const calleeName = (call) => call.callee.type === 'Identifier' ? call.callee.name : memberName(call.callee);
function enclosingFn(node) { for (let p = node.parent; p; p = p.parent) if (isFn(p)) return p; return null; }

// ---------- taint values ----------
// { kind: 'src', targets: Set }       runtime source text
// { kind: 'resp', targets: Set }      a fetch Response for runtime source
// { kind: 'arr', items: [taint|null], any: taint|null }
// { kind: 'obj', props: Map, any: taint|null }
// { kind: 'param', index }            (only inside loaders: a path built from a parameter)
const src = (targets) => ({ kind: 'src', targets: new Set(targets) });
function union(a, b) {
  if (!a) return b; if (!b) return a;
  if (a.kind === 'src' && b.kind === 'src') return src([...a.targets, ...b.targets]);
  if (a.kind === b.kind && a.kind === 'resp') return { kind: 'resp', targets: new Set([...a.targets, ...b.targets]) };
  if (a.kind === 'src') return a; if (b.kind === 'src') return b;
  // Containers merge member by member, so a value learnt in a later pass is
  // not dropped (const sites = [[source, "k"]] before source is known).
  if (a.kind === 'arr' && b.kind === 'arr') {
    const n = Math.max(a.items.length, b.items.length);
    return { kind: 'arr', items: Array.from({ length: n }, (_, i) => union(a.items[i] || null, b.items[i] || null)), any: union(a.any, b.any) };
  }
  if (a.kind === 'obj' && b.kind === 'obj') {
    const props = new Map(a.props);
    for (const [k, v] of b.props) props.set(k, union(props.get(k) || null, v));
    return { kind: 'obj', props, any: union(a.any, b.any) };
  }
  return a;
}
function flat(t) { // any source text reachable inside t
  if (!t) return null;
  if (t.kind === 'src') return t;
  if (t.kind === 'arr') return t.items.reduce((acc, i) => union(acc, flat(i)), flat(t.any));
  if (t.kind === 'obj') return [...t.props.values()].reduce((acc, i) => union(acc, flat(i)), flat(t.any));
  return null;
}
const same = (a, b) => JSON.stringify(sig(a)) === JSON.stringify(sig(b));
function sig(t) {
  if (!t) return null;
  if (t.kind === 'src' || t.kind === 'resp') return [t.kind, [...t.targets].sort()];
  if (t.kind === 'arr') return ['arr', t.items.map(sig), sig(t.any)];
  if (t.kind === 'obj') return ['obj', [...t.props].map(([k, v]) => [k, sig(v)]).sort(), sig(t.any)];
  return [t.kind, t.index];
}

const STRING_METHODS = new Set(['slice', 'substring', 'substr', 'trim', 'trimStart', 'trimEnd', 'replace', 'replaceAll',
  'toString', 'concat', 'toLowerCase', 'normalize', 'padStart', 'padEnd', 'at', 'repeat']);
const ANCHOR_METHODS = new Set(['indexOf', 'lastIndexOf', 'search', 'match', 'matchAll', 'split']);
const ASSERTISH = /^(assert|ok|check|expect|equal|truthy|must|pass|fail|t)$|^assert/i;

// Literal value of a marker expression, or undefined.
function literalOf(node, constOf) {
  if (!node) return undefined;
  if (node.type === 'Literal') {
    if (node.regex) return { kind: 'regex', value: node.regex.pattern, flags: node.regex.flags };
    if (typeof node.value === 'string') return { kind: 'string', value: node.value };
    return undefined;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return { kind: 'string', value: node.quasis[0].value.cooked };
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const a = literalOf(node.left, constOf), b = literalOf(node.right, constOf);
    if (a && b && a.kind === 'string' && b.kind === 'string') return { kind: 'string', value: a.value + b.value };
    return undefined;
  }
  if (node.type === 'Identifier') return constOf(node);
  return undefined;
}

// Root file named by a path literal, '?' for a dynamic runtime path, null otherwise.
function runtimeTargetOfPath(strs, runtime) {
  for (const s of strs.slice().reverse()) {
    if (/(^|\/)(tests|fixtures|docs|scripts|_locales|vendor|\.qa-scan)(\/|$)/.test(s)) return null;
    const name = s.replace(/^(\.\.?\/)+/, '');
    if (runtime.has(name)) return name;
  }
  return null;
}

// ---------- analysis of one script ----------

export function analyzeScript(code, { file = '<input>', lineOffset = 0, module = false, runtime }) {
  loadParsers();
  const { ast, sourceType } = parse(code, module);
  walk(ast, () => {});
  // optimistic: a direct eval() in a scope would otherwise make eslint-scope
  // leave every name there unresolved, and the source taint would be lost.
  const sm = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType, nodejsScope: false, optimistic: true });
  const varOf = new Map(); // Identifier node -> Variable
  for (const scope of sm.scopes) {
    for (const ref of scope.references) if (ref.resolved) varOf.set(ref.identifier, ref.resolved);
    for (const v of scope.variables) for (const d of v.defs) if (d.name) varOf.set(d.name, v);
  }
  const taintOfVar = new Map();
  const fnOfVar = new Map(); // Variable -> function node
  // The initializer of a binding that is written once: a const, or a let/var
  // never assigned again.
  const initOf = (id) => {
    const v = varOf.get(id);
    if (!v || v.defs.length !== 1) return undefined;
    const d = v.defs[0];
    if (d.type !== 'Variable' || !d.node.init || d.node.id.type !== 'Identifier') return undefined;
    if (d.parent.kind !== 'const' && v.references.filter((r) => r.isWrite()).length > 1) return undefined;
    return d.node.init;
  };
  const constOf = (id) => {
    const init = initOf(id);
    return init ? literalOf(init, () => undefined) : undefined;
  };
  // fetch, or a name bound to it (const realFetch = window.fetch).
  const isFetch = (id) => {
    if (id.name === 'fetch') return true;
    const init = initOf(id);
    return !!init && ((init.type === 'Identifier' && init.name === 'fetch') || memberName(init) === 'fetch');
  };
  // A loop variable over a listing of the repo root (readdirSync(ROOT)): some root file.
  const fromRootListing = (id) => {
    const v = varOf.get(id);
    const d = v && v.defs.length === 1 ? v.defs[0] : null;
    const loop = d && d.type === 'Variable' && d.parent && d.parent.parent;
    if (!loop || loop.type !== 'ForOfStatement' || loop.left !== d.parent) return false;
    let hit = false;
    const visit = (n) => {
      if (!n || hit || isFn(n)) return;
      if (n.type === 'CallExpression' && calleeName(n) === 'readdirSync' && n.arguments[0] && !hasString(n.arguments[0])) { hit = true; return; }
      for (const c of children(n)) visit(c);
    };
    visit(loop.right);
    return hit;
  };
  const hasString = (n) => {
    if (!n || isFn(n)) return false;
    if (n.type === 'Literal' && typeof n.value === 'string') return true;
    if (n.type === 'TemplateLiteral') return true;
    return children(n).some(hasString);
  };
  const isRegexNode = (n) => { const l = n && literalOf(n, constOf); return !!(l && l.kind === 'regex'); };
  // Every literal marker an expression can stand for: itself, or the literal
  // elements of the array a for-of loop variable walks.
  const markersOf = (node) => {
    const lit = literalOf(node, constOf);
    if (lit) return [lit];
    if (!node || node.type !== 'Identifier') return [];
    const v = varOf.get(node);
    const d = v && v.defs.length === 1 ? v.defs[0] : null;
    const loop = d && d.type === 'Variable' && d.parent && d.parent.parent;
    if (!loop || loop.type !== 'ForOfStatement' || loop.left !== d.parent || d.node.id.type !== 'Identifier') return [];
    let arr = loop.right;
    if (arr.type === 'Identifier') arr = initOf(arr);
    if (!arr || arr.type !== 'ArrayExpression') return [];
    const lits = arr.elements.map((e) => literalOf(e, constOf));
    return lits.every(Boolean) ? lits : [];
  };
  for (const scope of sm.scopes) {
    for (const v of scope.variables) {
      for (const d of v.defs) {
        if (d.type === 'FunctionName') fnOfVar.set(v, d.node);
        if (d.type === 'Variable' && d.node.init && isFn(d.node.init) && d.node.id.type === 'Identifier') fnOfVar.set(v, d.node.init);
      }
    }
  }
  // Methods of an object literal bound to a name: const H = { cut(s, m) {...} }.
  const objMethods = new Map(); // Variable -> Map(name -> function node)
  for (const scope of sm.scopes) {
    for (const v of scope.variables) {
      const d = v.defs.length === 1 ? v.defs[0] : null;
      if (!d || d.type !== 'Variable' || !d.node.init || d.node.init.type !== 'ObjectExpression' || d.node.id.type !== 'Identifier') continue;
      const m = new Map();
      for (const p of d.node.init.properties) {
        if (p.type === 'Property' && !p.computed && p.key.type === 'Identifier' && isFn(p.value)) m.set(p.key.name, p.value);
      }
      if (m.size) objMethods.set(v, m);
    }
  }
  const allFns = [...fnOfVar.values(), ...[...objMethods.values()].flatMap((m) => [...m.values()])];
  const fnReturn = new Map(); // function node -> taint of its return value
  const paramOwner = new Map(); // Variable of a param -> { fn, index }
  for (const fn of allFns) {
    fn.params.forEach((p, index) => {
      if (p.type === 'Identifier') { const v = varOf.get(p); if (v) paramOwner.set(v, { fn, index }); }
      if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') { const v = varOf.get(p.left); if (v) paramOwner.set(v, { fn, index }); }
    });
  }
  const fnOfCallee = (call) => {
    const c = call.callee;
    if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.property.type === 'Identifier') {
      const v = varOf.get(c.object);
      const m = v && objMethods.get(v);
      return (m && m.get(c.property.name)) || null;
    }
    if (c.type !== 'Identifier') return null;
    const v = varOf.get(c);
    return v ? fnOfVar.get(v) || null : null;
  };

  function pathStrings(node) { // string literals inside a path expression, plus whether a param is used
    const strs = []; let paramIndex = null; let listed = false;
    const seen = new Set();
    const visit = (n) => {
      if (!n || typeof n.type !== 'string') return;
      const lit = literalOf(n, constOf);
      if (lit && lit.kind === 'string') { strs.push(lit.value); return; }
      if (n.type === 'Identifier') {
        const v = varOf.get(n);
        const owner = v && paramOwner.get(v);
        if (owner && owner.fn === enclosingFn(n) && paramIndex === null) paramIndex = owner.index;
        // const P = join(ROOT, "popup.js"); const u = new URL("../popup.js", location.href)
        if (!owner && fromRootListing(n)) listed = true;
        const init = !owner && initOf(n);
        if (init && !isFn(init) && !seen.has(init)) { seen.add(init); visit(init); }
        return;
      }
      if (n.type === 'TemplateLiteral') { n.quasis.forEach((q) => strs.push(q.value.cooked)); n.expressions.forEach(visit); return; }
      if (isFn(n)) return;
      for (const c of children(n)) visit(c);
    };
    visit(node);
    return { strs, paramIndex, listed };
  }

  function evalPathCall(argNode, viaFetch) {
    const { strs, paramIndex, listed } = pathStrings(argNode);
    const target = runtimeTargetOfPath(strs, runtime);
    if (target) return { targets: [target] };
    if (listed && !strs.some((x) => /(^|\/)(tests|fixtures|docs|scripts|_locales|vendor)(\/|$)/.test(x))) return { targets: ['?'] };
    if (paramIndex !== null) return { param: paramIndex };
    if (viaFetch && strs.length && /^\.\.\//.test(strs[0]) && !strs.some((s) => /\.json\b|_locales|fixtures/.test(s))) return { targets: ['?'] };
    return null;
  }

  function T(node) {
    if (!node) return null;
    switch (node.type) {
      case 'Identifier': { const v = varOf.get(node); return v ? taintOfVar.get(v) || null : null; }
      case 'AwaitExpression': return T(node.argument);
      case 'ChainExpression': return T(node.expression);
      case 'ParenthesizedExpression': return T(node.expression);
      case 'SequenceExpression': return T(node.expressions[node.expressions.length - 1]);
      case 'AssignmentExpression': return T(node.right);
      case 'ConditionalExpression': return union(T(node.consequent), T(node.alternate));
      case 'LogicalExpression': return union(T(node.left), T(node.right));
      case 'TemplateLiteral': return node.expressions.reduce((a, e) => union(a, flat(T(e)) && src(flat(T(e)).targets)), null);
      case 'BinaryExpression': {
        if (node.operator !== '+') return null;
        const a = flat(T(node.left)), b = flat(T(node.right));
        return a || b ? union(a, b) : null;
      }
      case 'ArrayExpression': return { kind: 'arr', items: node.elements.map((e) => e && (e.type === 'SpreadElement' ? null : T(e))), any: null };
      case 'ObjectExpression': {
        const props = new Map(); let any = null;
        for (const p of node.properties) {
          if (p.type !== 'Property') { any = union(any, flat(T(p.argument))); continue; }
          const k = !p.computed && p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : null;
          const t = T(p.value);
          if (k === null) any = union(any, t); else if (t) props.set(k, t);
        }
        return props.size || any ? { kind: 'obj', props, any } : null;
      }
      case 'MemberExpression': {
        const o = T(node.object);
        if (!o) return null;
        const k = memberName(node);
        if (o.kind === 'arr') return k !== null && /^\d+$/.test(k) ? o.items[Number(k)] || o.any : node.computed ? flat(o) : null;
        if (o.kind === 'obj') return k !== null && o.props.has(k) ? o.props.get(k) : node.computed ? flat(o) : o.any;
        if (o.kind === 'src' && node.parent && node.parent.type === 'CallExpression' && node.parent.callee === node) return null;
        return null;
      }
      case 'CallExpression': return TCall(node);
      default: return null;
    }
  }

  function TCall(call) {
    const name = calleeName(call);
    const recv = call.callee.type === 'MemberExpression' ? call.callee.object : null;
    if (call.callee.type === 'Identifier' && isFetch(call.callee) && call.arguments[0]) {
      const r = evalPathCall(call.arguments[0], true);
      if (r && r.targets) return { kind: 'resp', targets: new Set(r.targets) };
      if (r && r.param !== undefined) return { kind: 'param', index: r.param, resp: true };
      return null;
    }
    if ((name === 'readFileSync' || name === 'readFile') && call.arguments[0]) {
      const r = evalPathCall(call.arguments[0], false);
      if (r && r.targets) return src(r.targets);
      if (r && r.param !== undefined) return { kind: 'param', index: r.param };
      return null;
    }
    if (recv) {
      const rt = T(recv);
      if (name === 'text' && rt && rt.kind === 'resp') return src(rt.targets);
      if (name === 'text' && rt && rt.kind === 'param' && rt.resp) return { kind: 'param', index: rt.index };
      if (name === 'then' && rt && (rt.kind === 'resp' || rt.kind === 'src' || (rt.kind === 'param'))) {
        const cb = call.arguments[0];
        if (rt.kind !== 'param' && isFn(cb)) return cbReturn(cb); // its first parameter gets rt below
        if (rt.kind === 'param' && rt.resp && isFn(cb)) {
          const body = cb.body.type === 'BlockStatement' ? null : cb.body;
          if (body && body.type === 'CallExpression' && memberName(body.callee) === 'text') return { kind: 'param', index: rt.index };
          return null;
        }
        return null;
      }
      if (name === 'all' && recv.type === 'Identifier' && recv.name === 'Promise') return T(call.arguments[0]);
      const f = flat(rt);
      if (rt && rt.kind === 'src' && STRING_METHODS.has(name)) return rt;
      if (rt && rt.kind === 'src' && name === 'split') return { kind: 'arr', items: [], any: rt };
      if (rt && rt.kind === 'src' && (name === 'match' || name === 'exec')) return { kind: 'arr', items: [], any: rt };
      if (isRegexNode(recv) && name === 'exec') {
        const a = flat(T(call.arguments[0]));
        return a ? { kind: 'arr', items: [], any: a } : null;
      }
      if (rt && rt.kind === 'arr' && /^(map|filter|slice|concat|flat|reverse|sort)$/.test(name)) {
        if (name === 'map') { const cb = call.arguments[0]; const r = isFn(cb) ? cbReturn(cb) : null; return r ? { kind: 'arr', items: [], any: r } : null; }
        return { kind: 'arr', items: [], any: f };
      }
      if (rt && rt.kind === 'arr' && name === 'join') return f;
      if (name === 'entries' && recv.type === 'Identifier' && recv.name === 'Object') { const o = flat(T(call.arguments[0])); return o ? { kind: 'arr', items: [], any: { kind: 'arr', items: [null, o], any: null } } : null; }
      if (name === 'values' && recv.type === 'Identifier' && recv.name === 'Object') { const o = T(call.arguments[0]); return o ? { kind: 'arr', items: [], any: flat(o) } : null; }
    }
    const fn = fnOfCallee(call);
    if (fn) {
      const r = fnReturn.get(fn);
      if (r && r.kind === 'param') {
        const arg = call.arguments[r.index];
        if (!arg) return null;
        const p = evalPathCall(arg, !!r.resp);
        if (p && p.targets) return r.resp ? { kind: 'resp', targets: new Set(p.targets) } : src(p.targets);
        const at = T(arg); // a path held in a variable is not followed
        return at && at.kind === 'src' ? null : null;
      }
      return r || null;
    }
    return null;
  }
  function cbReturn(cb) {
    if (cb.body.type !== 'BlockStatement') return T(cb.body);
    let r = null;
    walk2(cb.body, (n) => { if (n.type === 'ReturnStatement' && enclosingFn(n) === cb) r = union(r, T(n.argument)); });
    return r;
  }
  function walk2(node, fn) { fn(node); for (const c of children(node)) if (!isFn(c)) walk2(c, fn); }

  function assignPattern(pattern, t, changed) {
    if (!pattern || !t) return changed;
    if (pattern.type === 'Identifier') {
      const v = varOf.get(pattern);
      if (!v) return changed;
      const old = taintOfVar.get(v) || null;
      const next = union(old, t);
      if (!same(old, next)) { taintOfVar.set(v, next); return true; }
      return changed;
    }
    if (pattern.type === 'AssignmentPattern') return assignPattern(pattern.left, t, changed);
    if (pattern.type === 'ArrayPattern') {
      pattern.elements.forEach((el, i) => {
        if (!el) return;
        const item = t.kind === 'arr' ? t.items[i] || t.any : flat(t);
        changed = assignPattern(el.type === 'RestElement' ? el.argument : el, el.type === 'RestElement' ? t : item, changed);
      });
      return changed;
    }
    if (pattern.type === 'ObjectPattern') {
      for (const p of pattern.properties) {
        if (p.type === 'RestElement') { changed = assignPattern(p.argument, t, changed); continue; }
        const k = !p.computed && p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : null;
        const item = t.kind === 'obj' ? (k !== null && t.props.get(k)) || t.any : null;
        changed = assignPattern(p.value, item, changed);
      }
    }
    return changed;
  }

  // Propagate to a fixed point.
  const nodes = [];
  walk(ast, (n) => nodes.push(n));
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    for (const n of nodes) {
      if (n.type === 'VariableDeclarator' && n.init) changed = assignPattern(n.id, T(n.init), changed);
      else if (n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'MemberExpression' && n.left.object.type === 'Identifier') {
        // sources[f] = await res.text(): the object holds source
        const r = flat(T(n.right));
        if (r) changed = assignPattern(n.left.object, { kind: 'obj', props: new Map(), any: r }, changed);
      } else if (n.type === 'AssignmentExpression' && n.operator === '=') changed = assignPattern(n.left, T(n.right), changed);
      else if (n.type === 'AssignmentExpression' && n.operator === '+=') { const r = flat(T(n.right)); if (r) changed = assignPattern(n.left, r, changed); }
      else if (n.type === 'ForOfStatement') {
        const t = T(n.right); const item = t && (t.kind === 'arr' ? (t.any || flat(t)) : t.kind === 'obj' ? flat(t) : null);
        const target = n.left.type === 'VariableDeclaration' ? n.left.declarations[0].id : n.left;
        if (item) changed = assignPattern(target, item, changed);
      } else if (n.type === 'CallExpression') {
        const fn = fnOfCallee(n);
        if (fn) n.arguments.forEach((a, i) => { const p = fn.params[i]; if (p && a.type !== 'SpreadElement') changed = assignPattern(p, T(a), changed); });
        const name = calleeName(n);
        if (n.callee.type === 'MemberExpression' && name === 'then' && isFn(n.arguments[0])) {
          const t = T(n.callee.object);
          if (t && t.kind !== 'param') changed = assignPattern(n.arguments[0].params[0], t, changed);
        }
        if (n.callee.type === 'MemberExpression' && /^(map|forEach|filter|some|every|find|flatMap|reduce)$/.test(name)) {
          const t = T(n.callee.object);
          const cb = n.arguments[0];
          if (t && t.kind === 'arr' && isFn(cb)) changed = assignPattern(cb.params[name === 'reduce' ? 1 : 0], flat(t), changed);
        }
      } else if (isFn(n)) {
        const r = cbReturn(n);
        const old = fnReturn.get(n) || null;
        if (r && !same(old, r)) { fnReturn.set(n, r); changed = true; }
      }
    }
    if (!changed) break;
  }

  // ---------- anchors ----------
  const anchors = [];
  const helperMarkerParams = new Map(); // fn node -> [{ index, checked, form }]
  const survey = { presence: 0, computedMarker: 0, exec: { newFunction: 0, eval: 0, scriptText: 0, vm: 0 } };
  const lineOf = (n) => n.loc.start.line + lineOffset;

  const isPresenceCompare = (call) => {
    const p = call.parent;
    if (!p || p.type !== 'BinaryExpression' || !/^(<|<=|>|>=|===|!==|==|!=)$/.test(p.operator)) return false;
    const other = p.left === call ? p.right : p.left;
    const v = other.type === 'UnaryExpression' && other.operator === '-' && other.argument.type === 'Literal' ? -other.argument.value
      : other.type === 'Literal' ? other.value : null;
    return v === -1 || v === 0;
  };
  const isBooleanUse = (call) => {
    const p = call.parent;
    if (!p) return false;
    if (p.type === 'UnaryExpression' && p.operator === '!') return true;
    if ((p.type === 'IfStatement' || p.type === 'ConditionalExpression' || p.type === 'WhileStatement') && p.test === call) return true;
    // (src.match(re) || [])[1] keeps the value: a logical expression is a
    // boolean use only where the logical expression itself is one.
    if (p.type === 'LogicalExpression') return isBooleanUse(p);
    if (p.type === 'CallExpression' && p.arguments.includes(call) && ASSERTISH.test(calleeName(p) || '')) return true;
    if (p.type === 'BinaryExpression' && /^(===|!==|==|!=)$/.test(p.operator) && [p.left, p.right].some((x) => x.type === 'Literal' && x.value === null)) return true;
    return false;
  };
  // (src.match(/x/g) || []).length or src.match(/x/g).length: counts
  // occurrences, like a presence check; nothing is cut out.
  const isCountUse = (call) => {
    let e = call;
    if (e.parent && e.parent.type === 'LogicalExpression' && e.parent.operator === '||' && e.parent.left === e
      && e.parent.right.type === 'ArrayExpression' && e.parent.right.elements.length === 0) e = e.parent;
    const p = e.parent;
    return !!(p && p.type === 'MemberExpression' && p.object === e && !p.computed && p.property.name === 'length');
  };
  // The variable the call result is stored in, if any.
  const holder = (call) => {
    let n = call;
    while (n.parent && (n.parent.type === 'AwaitExpression' || n.parent.type === 'ChainExpression')) n = n.parent;
    const p = n.parent;
    if (p && p.type === 'VariableDeclarator' && p.init === n && p.id.type === 'Identifier') return varOf.get(p.id);
    if (p && p.type === 'AssignmentExpression' && p.right === n && p.left.type === 'Identifier') return varOf.get(p.left);
    return null;
  };
  const checkedIndex = (call) => {
    const v = holder(call);
    if (!v) return false;
    return v.references.some((ref) => {
      const id = ref.identifier;
      if (id.parent && id.parent.type === 'BinaryExpression') return isPresenceCompare(id);
      if (id.parent && id.parent.type === 'UnaryExpression' && id.parent.operator === '~') return true;
      return false;
    });
  };
  const checkedMatch = (call) => {
    const v = holder(call);
    if (!v) {
      // Read straight away (m[1], .index): a miss throws a TypeError, so it cannot pass quietly.
      return !!(call.parent && call.parent.type === 'MemberExpression' && call.parent.object === call && !call.parent.optional);
    }
    const guards = (id) => isBooleanUse(id) || (id.parent && id.parent.type === 'LogicalExpression' && id.parent.left === id);
    return v.references.some((ref) => guards(ref.identifier) || (ref.identifier.parent && ref.identifier.parent.type === 'MemberExpression' && !ref.identifier.parent.optional && ref.identifier.parent.object === ref.identifier));
  };
  // One piece of a split is taken: [k], .pop(), .shift(), .at(k), .slice(k), or destructuring.
  const takesPiece = (e) => {
    const p = e.parent;
    if (!p) return false;
    if (p.type === 'MemberExpression' && p.object === e) {
      if (p.computed) return p.property.type === 'Literal' && typeof p.property.value === 'number';
      return /^(pop|shift|at|slice)$/.test(p.property.name) && p.parent && p.parent.type === 'CallExpression' && p.parent.callee === p;
    }
    return p.type === 'VariableDeclarator' && p.init === e && p.id.type === 'ArrayPattern';
  };
  const markerParam = (argNode) => { // index of the enclosing fn's param the marker is built from
    const fn = enclosingFn(argNode);
    if (!fn) return null;
    let found = null;
    const visit = (n) => {
      if (!n || found !== null || isFn(n)) return;
      if (n.type === 'Identifier') {
        const v = varOf.get(n); const o = v && paramOwner.get(v);
        if (o && o.fn === fn) {
          found = o.index;
          // cut(s, { start: "x" }): the marker is a property of the parameter
          if (n.parent && n.parent.type === 'MemberExpression' && n.parent.object === n && !n.parent.computed) prop = n.parent.property.name;
        }
        return;
      }
      for (const c of children(n)) visit(c);
    };
    let prop = null;
    visit(argNode);
    return found === null ? null : { fn, index: found, prop };
  };

  for (const n of nodes) {
    if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && n.callee.name === 'Function' && n.arguments.some((a) => flat(T(a)))) survey.exec.newFunction++;
    if (n.type === 'NewExpression' && /^(Script)$/.test(memberName(n.callee) || (n.callee.type === 'Identifier' ? n.callee.name : '')) && n.arguments.some((a) => flat(T(a)))) survey.exec.vm++;
    if (n.type !== 'CallExpression') continue;
    const name = calleeName(n);
    // execution forms (survey only)
    if (n.callee.type === 'Identifier' && n.callee.name === 'Function' && n.arguments.some((a) => flat(T(a)))) survey.exec.newFunction++;
    if (n.callee.type === 'Identifier' && n.callee.name === 'eval' && n.arguments.some((a) => flat(T(a)))) survey.exec.eval++;
    if (/^(runInNewContext|runInContext|runInThisContext|compileFunction)$/.test(name || '') && n.arguments.some((a) => flat(T(a)))) survey.exec.vm++;
    if (!n.callee || n.callee.type !== 'MemberExpression') continue;
    const recv = n.callee.object;
    let receiverTaint;
    let form = name;
    if (isRegexNode(recv) && name === 'exec') { receiverTaint = flat(T(n.arguments[0])); form = 'exec'; }
    else if (ANCHOR_METHODS.has(name)) receiverTaint = T(recv);
    else if (name === 'includes' || name === 'startsWith' || name === 'endsWith' || name === 'test') {
      const t = name === 'test' ? flat(T(n.arguments[0])) : T(recv);
      if (t && t.kind === 'src') survey.presence++;
      continue;
    } else continue;
    if (!receiverTaint || receiverTaint.kind !== 'src') continue;
    const markerNode = form === 'exec' ? recv : n.arguments[0];
    const lits = markersOf(markerNode);
    const lit = lits[0];
    const isIndex = form === 'indexOf' || form === 'lastIndexOf' || form === 'search';
    if (!lit) {
      const mp = markerNode && markerParam(markerNode);
      if (mp) {
        const list = helperMarkerParams.get(mp.fn) || [];
        list.push({ index: mp.index, prop: mp.prop, form, targets: [...receiverTaint.targets], checked: isIndex ? (isPresenceCompare(n) || checkedIndex(n)) : form === 'split' ? false : checkedMatch(n) });
        helperMarkerParams.set(mp.fn, list);
      } else survey.computedMarker++;
      continue;
    }
    if (isIndex && isPresenceCompare(n)) { survey.presence++; continue; }
    if ((form === 'match' || form === 'exec' || form === 'matchAll') && (isBooleanUse(n) || isCountUse(n))) { survey.presence++; continue; }
    // split cuts only when one piece is taken: [k] or destructuring; a split
    // on whitespace (lines, words) walks the whole text and locates nothing.
    if (form === 'split') {
      const p = n.parent;
      const h = holder(n);
      const piece = takesPiece(n) || (h && h.references.some((ref) => !ref.isWrite() && takesPiece(ref.identifier)));
      if (!piece || lit.kind !== 'string' || /^\s*$/.test(lit.value)) { survey.presence++; continue; }
    }
    for (const marker of lits) {
      anchors.push({
        file, line: lineOf(n), form, marker, targets: [...receiverTaint.targets].sort(),
        checked: isIndex ? checkedIndex(n) : form === 'split' ? false : checkedMatch(n),
      });
    }
  }
  // Wrappers: a function that hands its own parameter to a helper as the
  // marker is a helper too (fn = (n) => extract(s, "function " + n)).
  for (let grew = true, round = 0; grew && round < 8; round++) {
    grew = false;
    for (const n of nodes) {
      if (n.type !== 'CallExpression') continue;
      const fn = fnOfCallee(n);
      const list = fn && helperMarkerParams.get(fn);
      if (!list) continue;
      for (const h of list.slice()) {
        const arg = n.arguments[h.index];
        if (!arg || markersOf(arg).length || (h.prop && arg.type === 'ObjectExpression')) continue;
        const mp = markerParam(arg);
        if (!mp || mp.fn === fn) continue;
        const outer = helperMarkerParams.get(mp.fn) || [];
        if (outer.some((o) => o.index === mp.index && o.prop === mp.prop && o.via === h)) continue;
        let targets = h.targets;
        for (const a of n.arguments) { const t = flat(T(a)); if (t) targets = [...new Set([...targets, ...t.targets])]; }
        outer.push({ index: mp.index, prop: mp.prop, form: h.form, targets, checked: h.checked, via: h });
        helperMarkerParams.set(mp.fn, outer);
        grew = true;
      }
    }
  }
  // Helper call sites with a literal marker.
  for (const n of nodes) {
    if (n.type !== 'CallExpression') continue;
    const fn = fnOfCallee(n);
    const list = fn && helperMarkerParams.get(fn);
    if (!list) continue;
    // The source: an argument holding runtime source, or else the source the
    // helper reads from its closure (const block = (a, b) => source.slice(...)).
    let targets = null;
    for (const a of n.arguments) { const t = flat(T(a)); if (t) targets = union(targets, t); }
    if (!targets) targets = src(list.flatMap((h) => h.targets));
    const slots = new Map();
    for (const h of list) { const k = h.index + '\0' + (h.prop || ''); if (!slots.has(k)) slots.set(k, []); slots.get(k).push(h); }
    for (const uses of slots.values()) {
      const { index, prop } = uses[0];
      let arg = n.arguments[index];
      if (prop) {
        if (!arg || arg.type !== 'ObjectExpression') continue;
        const p = arg.properties.find((q) => q.type === 'Property' && !q.computed && q.key.type === 'Identifier' && q.key.name === prop);
        arg = p && p.value;
      }
      for (const marker of markersOf(arg)) {
        anchors.push({
          file, line: lineOf(n), form: 'helper:' + (n.callee.name || memberName(n.callee) || '?'), marker, targets: [...targets.targets].sort(),
          checked: uses.every((h) => h.checked),
        });
      }
    }
  }
  // Script injection: <script>.textContent / .text = <source>.
  for (const n of nodes) {
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && /^(textContent|text|innerHTML)$/.test(memberName(n.left) || '') && flat(T(n.right))) survey.exec.scriptText++;
  }
  return { anchors, survey };
}

// ---------- whole repo ----------

export function analyzeFile(text, file, runtime) {
  const out = { anchors: [], survey: { presence: 0, computedMarker: 0, exec: { newFunction: 0, eval: 0, scriptText: 0, vm: 0 } }, errors: [] };
  for (const block of scriptBlocks(text, file)) {
    let r;
    try { r = analyzeScript(block.code, { file, lineOffset: block.line, module: block.module, runtime }); } catch (e) {
      out.errors.push(`${file}:${block.line + 1}: cannot parse the script block (${e.message})`);
      continue;
    }
    out.anchors.push(...r.anchors);
    out.survey.presence += r.survey.presence;
    out.survey.computedMarker += r.survey.computedMarker;
    for (const k of Object.keys(out.survey.exec)) out.survey.exec[k] += r.survey.exec[k];
  }
  return out;
}

export function collect(root = ROOT, { files } = {}) {
  const runtime = runtimeRootFiles(root);
  const list = files || testFiles(root);
  const result = { files: {}, anchors: [], errors: [], survey: { presence: 0, computedMarker: 0, exec: { newFunction: 0, eval: 0, scriptText: 0, vm: 0 } } };
  for (const file of list) {
    const r = analyzeFile(readFileSync(join(root, file), 'utf8'), file, runtime);
    result.errors.push(...r.errors);
    if (r.anchors.length) result.files[file] = r.anchors.length;
    result.anchors.push(...r.anchors);
    result.survey.presence += r.survey.presence;
    result.survey.computedMarker += r.survey.computedMarker;
    for (const k of Object.keys(result.survey.exec)) result.survey.exec[k] += r.survey.exec[k];
  }
  return result;
}

// Where the marker sits in the target file: 'code', 'comment' (only in comments) or 'missing'.
const commentCache = new Map();
function commentRanges(root, target) {
  const key = root + '\0' + target;
  if (commentCache.has(key)) return commentCache.get(key);
  const text = readFileSync(join(root, target), 'utf8');
  let ranges = [];
  if (target.endsWith('.js')) {
    loadParsers();
    try {
      const ast = espree.parse(text, { ecmaVersion: 'latest', sourceType: 'script', comment: true, range: true });
      ranges = ast.comments.map((c) => c.range);
    } catch {
      try { ranges = espree.parse(text, { ecmaVersion: 'latest', sourceType: 'module', comment: true, range: true }).comments.map((c) => c.range); } catch { ranges = []; }
    }
  } else {
    const re = target.endsWith('.css') ? /\/\*[\s\S]*?\*\//g : /<!--[\s\S]*?-->/g;
    let m; while ((m = re.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  }
  const entry = { text, ranges };
  commentCache.set(key, entry);
  return entry;
}
export function markerPlacement(root, target, marker) {
  if (target === '?' || !existsSync(join(root, target))) return null;
  const { text, ranges } = commentRanges(root, target);
  const hits = [];
  if (marker.kind === 'string') {
    if (!marker.value) return null;
    for (let i = text.indexOf(marker.value); i !== -1; i = text.indexOf(marker.value, i + 1)) hits.push(i);
  } else {
    let re;
    try { re = new RegExp(marker.value, marker.flags.includes('g') ? marker.flags : marker.flags + 'g'); } catch { return null; }
    let m; while ((m = re.exec(text))) { hits.push(m.index); if (m[0] === '') re.lastIndex++; }
  }
  if (!hits.length) return 'missing';
  const inComment = (i) => ranges.some(([a, b]) => i >= a && i < b);
  return hits.every(inComment) ? 'comment' : 'code';
}

export function cleanupList(root, anchors) {
  const commentOnly = [], missing = [], unchecked = [];
  for (const a of anchors) {
    const places = a.targets.map((t) => markerPlacement(root, t, a.marker)).filter(Boolean);
    if (places.length && places.every((p) => p === 'comment')) commentOnly.push(a);
    else if (places.length && places.every((p) => p === 'missing' || p === 'comment')) missing.push(a);
    if (!a.checked) unchecked.push(a);
  }
  return { commentOnly, missing, unchecked };
}

// ---------- baseline ----------

export function readBaseline(path = BASELINE_PATH) {
  const b = JSON.parse(readFileSync(path, 'utf8'));
  validateBaseline(b);
  return b;
}
export function validateBaseline(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('the baseline must be a JSON object');
  if (!b.files || typeof b.files !== 'object' || Array.isArray(b.files)) throw new Error('the baseline has no "files" object');
  if (!Number.isInteger(b.total) || b.total < 0) throw new Error('the baseline has no valid "total"');
  let sum = 0;
  for (const [f, e] of Object.entries(b.files)) {
    if (!e || !Number.isInteger(e.count) || e.count < 1) throw new Error(`${f}: no valid count`);
    sum += e.count;
  }
  if (sum !== b.total) throw new Error(`"total" is ${b.total} but the file counts add up to ${sum}`);
}

// Current counts against the baseline. grown: failures; shrunk: refresh hints.
export function compareCounts(baseline, current) {
  const grown = [], shrunk = [];
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  for (const f of Object.keys(current).sort()) {
    const was = baseline.files[f] ? baseline.files[f].count : 0;
    const now = current[f];
    if (now > was) grown.push(baseline.files[f] ? `${f}: ${was} -> ${now}` : `${f}: new file with ${now} anchor(s) (not in the baseline)`);
    else if (now < was) shrunk.push(`${f}: ${was} -> ${now}`);
  }
  for (const f of Object.keys(baseline.files).sort()) if (!(f in current)) shrunk.push(`${f}: ${baseline.files[f].count} -> 0`);
  if (total > baseline.total) grown.push(`total: ${baseline.total} -> ${total}`);
  return { grown, shrunk, total };
}

// A new baseline built from current counts. Growth needs a reason, written
// into the entry so a reviewer sees it in the diff.
export function nextBaseline(baseline, current, { allowGrowth = null, initial = false, date = new Date().toISOString().slice(0, 10) } = {}) {
  const files = {};
  const grown = [];
  for (const f of Object.keys(current).sort()) {
    const old = baseline && baseline.files[f];
    const was = old ? old.count : 0;
    const entry = { count: current[f] };
    const history = old && Array.isArray(old.growth) ? old.growth.slice() : [];
    if (current[f] > was && !initial) {
      grown.push(`${f}: ${was} -> ${current[f]}`);
      history.push({ date, from: was, to: current[f], reason: allowGrowth });
    }
    if (history.length) entry.growth = history;
    files[f] = entry;
  }
  if (grown.length && !initial && !(typeof allowGrowth === 'string' && allowGrowth.trim())) return { refused: grown };
  const total = Object.values(files).reduce((a, e) => a + e.count, 0);
  return { baseline: { note: BASELINE_NOTE, total, files } };
}
const BASELINE_NOTE = 'Slice anchors per test file (scripts/slice-anchor-lint.mjs). Only shrinks: refresh with --update after removing anchors. New tests load the real file with tests/fixtures/chrome-mock.js instead of cutting source.';

// Baseline-to-baseline (pre-commit: HEAD copy vs staged copy). A count may
// only go up together with a new growth record carrying a reason.
export function compareBaselineFiles(oldB, newB) {
  validateBaseline(oldB); validateBaseline(newB);
  const out = [];
  for (const f of Object.keys(newB.files).sort()) {
    const was = oldB.files[f] ? oldB.files[f].count : 0;
    const e = newB.files[f];
    if (e.count <= was) continue;
    const oldGrowth = (oldB.files[f] && oldB.files[f].growth) || [];
    const added = (e.growth || []).slice(oldGrowth.length);
    const ok = added.some((g) => g && g.to === e.count && typeof g.reason === 'string' && g.reason.trim());
    if (!ok) out.push(`${f}: ${was} -> ${e.count} without a growth record and reason (use --update --allow-growth "<reason>")`);
  }
  if (newB.total > oldB.total) {
    const grownFiles = Object.keys(newB.files).filter((f) => newB.files[f].count > (oldB.files[f] ? oldB.files[f].count : 0));
    if (!grownFiles.length) out.push(`total: ${oldB.total} -> ${newB.total}`);
  }
  return out;
}

// ---------- CLI ----------

function fmt(a) { return `${a.file}:${a.line}  ${a.form}  ${a.marker.kind === 'regex' ? '/' + a.marker.value + '/' : JSON.stringify(a.marker.value)}  -> ${a.targets.join(',')}${a.checked ? '' : '  (unchecked)'}`; }

function main(argv) {
  const root = process.env.PBP_SLICE_ANCHOR_ROOT || ROOT;
  const baselinePath = join(root, 'scripts', 'slice-anchor-baseline.json');
  if (argv[0] === '--compare') {
    if (argv.length !== 3) { console.error('usage: node scripts/slice-anchor-lint.mjs --compare <old.json> <new.json>'); return 2; }
    let oldB, newB;
    try { [oldB, newB] = argv.slice(1).map((p) => JSON.parse(readFileSync(p, 'utf8'))); } catch (e) { console.error(`[slice-anchor] cannot read the baselines: ${e.message}`); return 2; }
    let out;
    try { out = compareBaselineFiles(oldB, newB); } catch (e) { console.error(`[slice-anchor] bad baseline: ${e.message}`); return 1; }
    if (out.length) {
      console.error('[slice-anchor] the slice-anchor baseline only shrinks. Problems:');
      for (const l of out) console.error('  ' + l);
      return 1;
    }
    return 0;
  }
  const update = argv.includes('--update');
  const gi = argv.indexOf('--allow-growth');
  const allowGrowth = gi >= 0 ? argv[gi + 1] : null;
  if (gi >= 0 && (!allowGrowth || allowGrowth.startsWith('--') || !allowGrowth.trim())) { console.error('[slice-anchor] --allow-growth needs a reason: --allow-growth "<why the new anchor cannot be avoided>"'); return 2; }
  if (gi >= 0 && !update) { console.error('[slice-anchor] --allow-growth only works with --update'); return 2; }
  const known = new Set(['--update', '--allow-growth', '--survey', '--list', '--cleanup']);
  for (const [i, a] of argv.entries()) if (!known.has(a) && !(gi >= 0 && i === gi + 1)) { console.error(`[slice-anchor] unknown argument ${a}`); return 2; }

  const result = collect(root);
  if (result.errors.length) {
    for (const e of result.errors) console.error('[slice-anchor] ' + e);
    console.error('[slice-anchor] a test file could not be parsed, so its anchors cannot be counted');
    return 1;
  }
  const { commentOnly, missing, unchecked } = cleanupList(root, result.anchors);
  if (argv.includes('--list')) {
    const set = argv.includes('--cleanup') ? [...commentOnly, ...missing, ...unchecked.filter((a) => !commentOnly.includes(a) && !missing.includes(a))] : result.anchors;
    for (const a of set) {
      const tag = commentOnly.includes(a) ? '  [comment-only]' : missing.includes(a) ? '  [marker-missing]' : '';
      console.log(fmt(a) + tag);
    }
    return 0;
  }
  if (argv.includes('--survey')) {
    const byForm = {};
    for (const a of result.anchors) { const k = a.form.startsWith('helper:') ? 'helper call' : a.form; byForm[k] = (byForm[k] || 0) + 1; }
    const helpers = {};
    for (const a of result.anchors) if (a.form.startsWith('helper:')) helpers[a.form.slice(7)] = (helpers[a.form.slice(7)] || 0) + 1;
    console.log(`anchors: ${result.anchors.length} in ${Object.keys(result.files).length} files`);
    console.log('by form: ' + Object.entries(byForm).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
    console.log('helpers: ' + Object.entries(helpers).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
    console.log(`execution of source text: new Function=${result.survey.exec.newFunction} eval=${result.survey.exec.eval} script text=${result.survey.exec.scriptText} vm=${result.survey.exec.vm}`);
    console.log(`not counted: presence checks on source=${result.survey.presence} computed markers=${result.survey.computedMarker}`);
    const byExt = {};
    for (const a of result.anchors) for (const t of a.targets) { const k = t === '?' ? '?' : t.split('.').pop(); byExt[k] = (byExt[k] || 0) + 1; }
    console.log('by target type (an anchor on a union counts once per target): ' + Object.entries(byExt).map(([k, v]) => `${k}=${v}`).join(' '));
    console.log(`regex markers=${result.anchors.filter((a) => a.marker.kind === 'regex').length} string markers=${result.anchors.filter((a) => a.marker.kind === 'string').length}`);
    console.log('per file: ' + Object.entries(result.files).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
    console.log(`cleanup: comment-only=${commentOnly.length} marker-missing=${missing.length} unchecked=${unchecked.length}`);
    return 0;
  }

  if (update) {
    let old = null;
    if (existsSync(baselinePath)) {
      try { old = readBaseline(baselinePath); } catch (e) { console.error(`[slice-anchor] the baseline is broken (${e.message}); fix or restore it before --update`); return 1; }
    }
    // No baseline yet: the first one records today's counts as they are. Deleting
    // it later to start over is what the pre-commit check (--compare against
    // HEAD) refuses.
    const next = old ? nextBaseline(old, result.files, { allowGrowth }) : nextBaseline(null, result.files, { allowGrowth: null, initial: true });
    if (next.refused) {
      console.error('[slice-anchor] refusing to grow the baseline:');
      for (const l of next.refused) console.error('  ' + l);
      console.error('Load the real file with tests/fixtures/chrome-mock.js instead of cutting source text.');
      console.error('If a new anchor really cannot be avoided: --update --allow-growth "<reason>"');
      return 1;
    }
    writeFileSync(baselinePath, JSON.stringify(next.baseline, null, 2) + '\n');
    console.log(`[slice-anchor] baseline written: ${next.baseline.total} anchors in ${Object.keys(next.baseline.files).length} files`);
    return 0;
  }

  if (!existsSync(baselinePath)) {
    console.error(`[slice-anchor] ${relative(root, baselinePath)} is missing; it cannot be deleted or renamed. Restore it from git.`);
    return 1;
  }
  let baseline;
  try { baseline = readBaseline(baselinePath); } catch (e) { console.error(`[slice-anchor] bad baseline: ${e.message}`); return 1; }
  const { grown, shrunk, total } = compareCounts(baseline, result.files);
  console.log(`[slice-anchor] ${total} anchors in ${Object.keys(result.files).length} test files (baseline ${baseline.total})`);
  console.log(`[slice-anchor] cleanup list (not failing): ${commentOnly.length} marker only in a comment of the target, ${missing.length} marker not found in the target, ${unchecked.length} with no "not found" check (details: --list --cleanup)`);
  if (grown.length) {
    console.error('[slice-anchor] new slice anchors. The count only shrinks:');
    for (const l of grown) console.error('  ' + l);
    const fresh = new Set(grown.map((l) => l.split(':')[0]));
    for (const a of result.anchors) if (fresh.has(a.file)) { /* listed below */ }
    console.error('Load the real file in the test page with tests/fixtures/chrome-mock.js instead of cutting source text by a marker.');
    console.error('See them: node scripts/slice-anchor-lint.mjs --list');
    return 1;
  }
  if (shrunk.length) {
    console.log('[slice-anchor] fewer anchors than the baseline, good. Refresh it: node scripts/slice-anchor-lint.mjs --update');
    for (const l of shrunk) console.log('  ' + l);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
