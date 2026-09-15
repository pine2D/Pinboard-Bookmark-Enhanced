#!/usr/bin/env node
// Page-function closure-freedom gate (K24).
//
// chrome.scripting.executeScript({ func }) does NOT ship a closure: Chrome
// serializes the function's SOURCE and re-evaluates it inside the target page.
// Every identifier the body reads must therefore resolve against the PAGE's
// own globals (or the function's own arguments/locals) at run time. A
// reference to anything the extension bundle defines -- a top-level helper of
// the calling file, or a symbol another root script exports -- is a runtime
// ReferenceError in the injected tab, and nothing in this repo can see it:
//   - eslint's no-undef is fed the UNION of every root *.js top-level
//     declaration (eslint.config.mjs collectTopLevelGlobals), so a page
//     function referencing a bundle symbol looks perfectly defined to it;
//   - no test can observe it either -- the failure happens in a third-party
//     tab, inside an injection whose rejection the callers deliberately
//     swallow (a broken rule must never mask the Defuddle path).
// md-video.js:1610 already states the invariant in prose ("it must stay
// closure-free -- nothing else from this file, only page globals and its own
// arguments"). This gate is that sentence, machine-checked.
//
// A reference guarded by `typeof X === "function"` (or an equivalent early
// return) is NOT an error: that is this repo's established way of declaring an
// optional page-side dependency -- site-rules.js is injected separately with
// its failure ignored on purpose, so its exports are genuinely "maybe there".
// The gate's job is to keep the unguarded set empty.
//
// Dev-only (never shipped: scripts/ is outside release.sh's packaging
// patterns). Parses with espree + eslint-scope from .qa-scan/node_modules --
// the same parser ESLint itself uses there, so the scope analysis is real, not
// a regex approximation. Both are declared in .qa-scan/package.json so this
// gate owns them outright instead of borrowing whatever eslint happens to hoist.
//
// Scope and its one edge: every `func:` whose options object is written
// literally at the call site (all of today's, plus the named top-level form
// `func: extractPageForMarkdown`). An options object handed over as a VARIABLE
// hides its func: from this gate, so those calls are a baseline assertion of
// their own: INDIRECT_ALLOWLIST registers the one legitimate forwarder by file
// + enclosing function name, and any other such call -- or a registration that
// stops matching -- fails the run. `files:` injections are NOT this gate's
// business: those scripts carry their own top level into the page, closure and
// all.
//
// Usage: node scripts/script-graph-lint.mjs [--verbose]
// Exit 1 with `symbol  file:line` lines when an unguarded reference exists.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
// The page's own globals, borrowed from the lint config that already has to
// know them — one list, not two.
import { PAGE_GLOBALS } from "../eslint.config.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(ROOT, ".qa-scan", "package.json"));

let espree, eslintScope;
try {
  espree = require("espree");
  eslintScope = require("eslint-scope");
} catch (e) {
  console.error("[script-graph] cannot load espree/eslint-scope from .qa-scan/node_modules.");
  console.error("[script-graph] run `npm install` in .qa-scan first (same sandbox verify.sh's eslint uses).");
  console.error("[script-graph] " + ((e && e.message) || e));
  process.exit(2);
}

const VERBOSE = process.argv.includes("--verbose");
const PARSE_OPTS = { ecmaVersion: 2024, sourceType: "script", loc: true, range: true };

// ---------- generic AST helpers ----------

function childNodes(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const item of v) if (item && typeof item.type === "string") out.push(item);
    } else if (v && typeof v.type === "string") {
      out.push(v);
    }
  }
  return out;
}

// One walk per file: visit every node and record its parent.
function walk(root, visit) {
  const parents = new Map();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    visit(node, parents.get(node) || null);
    for (const child of childNodes(node)) {
      parents.set(child, node);
      stack.push(child);
    }
  }
  return parents;
}

function calleeName(callee) {
  if (!callee) return "";
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return "";
}

// Two distinct outcomes, never conflated: MODULE_SCOPE means the walk crossed
// no function at all, ANONYMOUS means it crossed one (or more) whose name
// cannot be derived. Only the first is a real coordinate; the second must never
// be registrable, or one entry would cover every unresolvable shape in a file.
const MODULE_SCOPE = "(top level)";
const ANONYMOUS_FN = "(anonymous)";

// `class C { m() {} }` / `class C { m = () => {} }` -> "C.m", or "m" when the
// class itself is anonymous.
function classMemberName(owner, parents) {
  const key = owner.key.name;
  const body = parents.get(owner);
  const klass = body ? parents.get(body) : null;
  const cls = klass && klass.id && klass.id.name ? klass.id.name : "";
  return cls ? `${cls}.${key}` : key;
}

// Nearest enclosing function that has a name we can derive -- the stable key
// for the indirect-call registry below (a line number drifts on every edit).
function enclosingFunctionName(node, parents) {
  let sawFunction = false;
  for (let cur = parents.get(node); cur; cur = parents.get(cur)) {
    if (!/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(cur.type)) continue;
    sawFunction = true;
    if (cur.id && cur.id.name) return cur.id.name;
    const owner = parents.get(cur);
    if (!owner) continue;
    if (owner.type === "VariableDeclarator" && owner.id.type === "Identifier") return owner.id.name;
    if (owner.type === "Property" && !owner.computed && owner.key.type === "Identifier") return owner.key.name;
    // Class members: without these the walk would pass straight through a
    // method and report the call as module scope.
    if ((owner.type === "MethodDefinition" || owner.type === "PropertyDefinition") &&
        !owner.computed && owner.key.type === "Identifier") return classMemberName(owner, parents);
    if (owner.type === "AssignmentExpression" && owner.left.type === "MemberExpression" &&
        !owner.left.computed && owner.left.property.type === "Identifier") return owner.left.property.name;
  }
  return sawFunction ? ANONYMOUS_FN : MODULE_SCOPE;
}

// Names bound by a declaration id (handles destructuring).
function patternNames(pattern, out) {
  if (!pattern) return out;
  switch (pattern.type) {
    case "Identifier": out.push(pattern.name); break;
    case "ObjectPattern": for (const p of pattern.properties) patternNames(p.value || p.argument, out); break;
    case "ArrayPattern": for (const el of pattern.elements) patternNames(el, out); break;
    case "AssignmentPattern": patternNames(pattern.left, out); break;
    case "RestElement": patternNames(pattern.argument, out); break;
    default: break;
  }
  return out;
}

// ---------- the extension bundle's symbol table ----------
// Every top-level declaration of every root *.js, plus the deliberate
// cross-context exports (`window.X = ...`). Same source of truth as
// eslint.config.mjs, read from the real files on every run -- but AST-based,
// so a `const` inside a function body can never be mistaken for a top-level
// one (the regex version of this collector cannot tell them apart).
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self", "g"]);
const PAGE_OWNED = new Set(PAGE_GLOBALS);

// ---------- the indirect-call registry ----------
// An executeScript call whose options object arrives as a VARIABLE hides its
// `func` from this gate. Exactly one such call is legitimate, so it is
// registered here by file + enclosing function (a line number drifts on every
// edit above it); any other one is a hole in the gate and fails the run. An
// entry that stops matching also fails -- a registry that silently covers
// nothing is worse than no registry.
const INDIRECT_ALLOWLIST = [
  {
    file: "ai.js",
    fn: "_cbExecuteScript",
    why: "callback-form forwarder: it hands its caller's own literal options object straight to chrome.scripting, and every one of those call sites is checked here.",
  },
];

// A key must name one function, not a shape. ANONYMOUS_FN is what an
// unresolvable enclosing function reports, so registering it would wave through
// every such call in that file -- refuse the registry outright rather than run
// with a hole in it.
for (const entry of INDIRECT_ALLOWLIST) {
  if (entry.fn !== ANONYMOUS_FN) continue;
  console.error(`[script-graph] INDIRECT_ALLOWLIST cannot register "${ANONYMOUS_FN}" (entry for ${entry.file}):`);
  console.error("[script-graph] it is the marker for a call whose enclosing function has no derivable name, not a coordinate.");
  console.error("[script-graph] Give that function a name, then register it.");
  process.exit(2);
}

function collectBundleSymbols(parsed) {
  const table = new Map(); // name -> Set(file)
  const add = (name, file) => {
    // A name the page already owns is never "the bundle's": `window.fetch = ...`
    // and `window.URL = SafeURL` are deliberate monkey-patches installed BY the
    // page functions themselves, and a page function reading `fetch` reads the
    // page's own. Only names the bundle introduces can go missing in a tab.
    if (!name || PAGE_OWNED.has(name)) return;
    if (!table.has(name)) table.set(name, new Set());
    table.get(name).add(file);
  };
  for (const [file, ast] of parsed) {
    for (const stmt of ast.body) {
      if (stmt.type === "FunctionDeclaration" || stmt.type === "ClassDeclaration") {
        if (stmt.id) add(stmt.id.name, file);
      } else if (stmt.type === "VariableDeclaration") {
        for (const d of stmt.declarations) for (const n of patternNames(d.id, [])) add(n, file);
      }
    }
    walk(ast, (node) => {
      if (node.type !== "AssignmentExpression" || node.operator !== "=") return;
      const t = node.left;
      if (t && t.type === "MemberExpression" && !t.computed &&
          t.object.type === "Identifier" && GLOBAL_OBJECTS.has(t.object.name) &&
          t.property.type === "Identifier") {
        add(t.property.name, file);
      }
    });
  }
  return table;
}

// ---------- typeof guards ----------
// `typeof X === "function"` (and its equivalents) is this repo's declaration
// of an optional page-side dependency. Polarity is resolved properly so a
// NEGATIVE test guards the early-return form, not the call itself.

function typeofPolarity(expr, name, negated = false) {
  // Returns the set of polarities asserted about `name` inside `expr`.
  const found = [];
  const visit = (node, neg) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "UnaryExpression" && node.operator === "!") { visit(node.argument, !neg); return; }
    if (node.type === "BinaryExpression" && ["===", "==", "!==", "!="].includes(node.operator)) {
      const sides = [[node.left, node.right], [node.right, node.left]];
      for (const [a, b] of sides) {
        if (a && a.type === "UnaryExpression" && a.operator === "typeof" &&
            a.argument.type === "Identifier" && a.argument.name === name &&
            b && b.type === "Literal" && typeof b.value === "string") {
          const isUndef = b.value === "undefined";
          const eq = node.operator === "===" || node.operator === "==";
          // eq+undefined => "absent"; eq+anything-else => "present"; ne flips.
          let present = eq ? !isUndef : isUndef;
          if (neg) present = !present;
          found.push(present);
          return;
        }
      }
    }
    for (const child of childNodes(node)) visit(child, neg);
  };
  visit(expr, negated);
  return found;
}

const hasPositive = (expr, name) => typeofPolarity(expr, name).includes(true);
const hasNegative = (expr, name) => typeofPolarity(expr, name).includes(false);

function alwaysExits(node) {
  if (!node) return false;
  if (["ReturnStatement", "ThrowStatement", "ContinueStatement", "BreakStatement"].includes(node.type)) return true;
  if (node.type === "BlockStatement") return node.body.some(alwaysExits);
  return false;
}

const STATEMENT_LIST_KEYS = ["body", "consequent"]; // BlockStatement/Program body, SwitchCase consequent

// Is this reference governed by a typeof guard somewhere between it and the
// page function's own boundary?
function isGuarded(idNode, funcNode, parents, name) {
  let cur = idNode;
  while (cur && cur !== funcNode) {
    const parent = parents.get(cur);
    if (!parent) return false;
    if (parent.type === "IfStatement") {
      if (parent.consequent === cur && hasPositive(parent.test, name)) return true;
      if (parent.alternate === cur && hasNegative(parent.test, name)) return true;
    } else if (parent.type === "ConditionalExpression") {
      if (parent.consequent === cur && hasPositive(parent.test, name)) return true;
      if (parent.alternate === cur && hasNegative(parent.test, name)) return true;
    } else if (parent.type === "LogicalExpression") {
      if (parent.right === cur && parent.operator === "&&" && hasPositive(parent.left, name)) return true;
      if (parent.right === cur && parent.operator === "||" && hasNegative(parent.left, name)) return true;
    }
    // Early-return form: an earlier sibling statement bails out when absent.
    for (const key of STATEMENT_LIST_KEYS) {
      const list = parent[key];
      if (!Array.isArray(list)) continue;
      const idx = list.indexOf(cur);
      if (idx < 0) continue;
      for (let i = 0; i < idx; i++) {
        const stmt = list[i];
        if (stmt.type === "IfStatement" && !stmt.alternate &&
            hasNegative(stmt.test, name) && alwaysExits(stmt.consequent)) return true;
      }
    }
    cur = parent;
  }
  return false;
}

// ---------- page-function sites ----------

function findPageFunctionSites(file, ast, parents, indirect) {
  const sites = [];
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    // chrome.scripting.executeScript(...) and the repo's callback wrappers
    // (_cbExecuteScript in ai.js / background.js) all end in executeScript.
    if (!/executescript$/i.test(calleeName(node.callee))) return;
    let literalOptions = false;
    for (const arg of node.arguments) {
      if (!arg || arg.type !== "ObjectExpression") continue;
      literalOptions = true;
      for (const prop of arg.properties) {
        if (prop.type !== "Property" || prop.computed) continue;
        const key = prop.key.type === "Identifier" ? prop.key.name
          : (prop.key.type === "Literal" ? String(prop.key.value) : "");
        if (key !== "func") continue;
        sites.push({ file, line: prop.loc.start.line, value: prop.value });
      }
    }
    // The options object came from a variable, so its `func` (if any) is out of
    // reach of this gate. Checked against INDIRECT_ALLOWLIST below: registered
    // forwarder or red, never a number nobody reads.
    if (!literalOptions) {
      indirect.push({ file, line: node.loc.start.line, fn: enclosingFunctionName(node, parents) });
    }
  });
  return sites.sort((a, b) => a.line - b.line);
}

// `func: someNamedFunction` -> the declaration it names, in the same file.
function resolveNamedPageFunction(ast, name) {
  for (const stmt of ast.body) {
    if (stmt.type === "FunctionDeclaration" && stmt.id && stmt.id.name === name) return stmt;
    if (stmt.type === "VariableDeclaration") {
      for (const d of stmt.declarations) {
        if (d.id.type === "Identifier" && d.id.name === name && d.init &&
            (d.init.type === "FunctionExpression" || d.init.type === "ArrowFunctionExpression")) return d.init;
      }
    }
  }
  return null;
}

// ---------- main ----------

const files = readdirSync(ROOT).filter((f) => f.endsWith(".js")).sort();
const parsed = new Map();
const parentMaps = new Map();
for (const f of files) {
  let src = "";
  try { src = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
  let ast;
  try {
    ast = espree.parse(src, PARSE_OPTS);
  } catch (e) {
    console.error(`[script-graph] parse error in ${f}: ${(e && e.message) || e}`);
    process.exit(2);
  }
  parsed.set(f, ast);
  parentMaps.set(f, walk(ast, () => {}));
}

const bundle = collectBundleSymbols(parsed);

const unguarded = [];
const guarded = [];
const broken = [];
const indirect = [];
const registry = [];
let siteCount = 0;

for (const [file, ast] of parsed) {
  const parents = parentMaps.get(file);
  const sites = findPageFunctionSites(file, ast, parents, indirect);
  if (!sites.length) continue;

  const scopeManager = eslintScope.analyze(ast, {
    ecmaVersion: PARSE_OPTS.ecmaVersion,
    sourceType: PARSE_OPTS.sourceType,
  });

  for (const site of sites) {
    let funcNode = site.value;
    let label = "";
    if (funcNode.type === "Identifier") {
      label = funcNode.name;
      const resolved = resolveNamedPageFunction(ast, funcNode.name);
      if (!resolved) {
        broken.push({
          file, line: site.line, name: funcNode.name,
          why: `func: ${funcNode.name} names no top-level function in ${file} — a page function must be defined in the file that injects it`,
        });
        continue;
      }
      funcNode = resolved;
      registry.push(`${file}:${site.line}  func: ${label}  (${file}:${funcNode.loc.start.line})`);
    } else if (funcNode.type !== "FunctionExpression" && funcNode.type !== "ArrowFunctionExpression") {
      broken.push({
        file, line: site.line, name: funcNode.type,
        why: `func: is a ${funcNode.type}; the gate can only verify a literal function or a named top-level function`,
      });
      continue;
    } else {
      registry.push(`${file}:${site.line}  func: (inline ${funcNode.type === "ArrowFunctionExpression" ? "arrow" : "function"})`);
    }
    siteCount++;

    const funcScope = scopeManager.acquire(funcNode, true);
    if (!funcScope) {
      broken.push({ file, line: site.line, name: label || "(inline)", why: "no scope found for this page function" });
      continue;
    }
    // Every scope nested inside the page function.
    const inner = new Set();
    const queue = [funcScope];
    while (queue.length) {
      const s = queue.pop();
      inner.add(s);
      for (const c of s.childScopes) queue.push(c);
    }

    const seen = new Set();
    for (const scope of inner) {
      for (const ref of scope.references) {
        const name = ref.identifier.name;
        // `typeof X` is the one expression that never throws on an undeclared
        // name — it is the guard itself, not a use of the symbol.
        const refParent = parents.get(ref.identifier);
        if (refParent && refParent.type === "UnaryExpression" && refParent.operator === "typeof") continue;
        let origin = null;
        if (ref.resolved) {
          // Declared inside the page function? Then it travels with the source.
          let s = ref.resolved.scope, local = false;
          while (s) { if (inner.has(s)) { local = true; break; } s = s.upper; }
          if (local) continue;
          // Captured from an enclosing scope of this file: the file's top level,
          // or a wrapper function (an IIFE module) around the page function.
          const def = ref.resolved.defs[0];
          const enclosing = def ? enclosingFunctionName(def.name, parents) : "(top level)";
          origin = ref.resolved.scope.type === "global"
            ? `${file} top level`
            : `${file}, inside ${enclosing === "(top level)" ? "an unnamed wrapper" : enclosing}`;
        } else {
          // Unresolved: a genuine free identifier. Only the bundle's own
          // symbols are a problem -- everything else is a page/browser global,
          // which is exactly what a page function is allowed to use.
          if (!bundle.has(name)) continue;
          origin = [...bundle.get(name)].sort().join(", ");
        }
        const line = ref.identifier.loc.start.line;
        const dedupe = `${name}@${line}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const record = {
          file, line, name, origin,
          site: `${file}:${site.line}`,
          func: label || "(inline)",
        };
        if (isGuarded(ref.identifier, funcNode, parents, name)) guarded.push(record);
        else unguarded.push(record);
      }
    }
  }
}

const bySite = (a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file));
unguarded.sort(bySite);
guarded.sort(bySite);
indirect.sort(bySite);

// Baseline assertion, not a statistic: every indirect call must be registered,
// and every registration must still match something.
const unregistered = indirect.filter((r) => !INDIRECT_ALLOWLIST.some((a) => a.file === r.file && a.fn === r.fn));
const stale = INDIRECT_ALLOWLIST.filter((a) => !indirect.some((r) => r.file === a.file && r.fn === a.fn));

if (VERBOSE) {
  console.log(`[script-graph] ${registry.length} page function site(s):`);
  for (const r of registry.sort()) console.log(`  ${r}`);
  if (indirect.length) {
    console.log(`[script-graph] ${indirect.length} executeScript call(s) with non-literal options (func: unreachable from here):`);
    for (const r of indirect) console.log(`  ${r.fn.padEnd(28)} ${r.file}:${r.line}`);
  }
}

if (VERBOSE && guarded.length) {
  console.log(`[script-graph] ${guarded.length} guarded optional dependencies (declared with typeof, OK):`);
  for (const r of guarded) console.log(`  ${r.name.padEnd(28)} ${r.file}:${r.line}  (from ${r.origin}, page fn ${r.func} @ ${r.site})`);
}

if (broken.length) {
  console.error(`[script-graph] FAIL — ${broken.length} page function(s) the gate cannot verify:`);
  for (const b of broken) console.error(`  ${b.name.padEnd(28)} ${b.file}:${b.line}  ${b.why}`);
}

if (unguarded.length) {
  console.error(`[script-graph] FAIL — ${unguarded.length} unguarded reference(s) inside executeScript page functions.`);
  console.error("[script-graph] These run in the injected PAGE, where the extension bundle does not exist:");
  for (const r of unguarded) {
    console.error(`  ${r.name.padEnd(28)} ${r.file}:${r.line}  (defined in ${r.origin}; page fn ${r.func} injected at ${r.site})`);
  }
  console.error('[script-graph] Fix: inline the value, pass it through `args:`, or declare it optional with `typeof X === "function"`.');
}

if (unregistered.length) {
  console.error(`[script-graph] FAIL — ${unregistered.length} executeScript call(s) hand over an options object this gate cannot read:`);
  for (const r of unregistered) console.error(`  ${r.fn.padEnd(28)} ${r.file}:${r.line}  (options arrive as a variable, so any func: in them is unchecked)`);
  console.error("[script-graph] Fix: write the options object literally at the call site so its func: can be checked,");
  console.error("[script-graph] or register the forwarder in INDIRECT_ALLOWLIST (scripts/script-graph-lint.mjs) with the reason it is safe.");
}

if (stale.length) {
  console.error(`[script-graph] FAIL — ${stale.length} INDIRECT_ALLOWLIST entr(ies) no longer match any call:`);
  for (const a of stale) console.error(`  ${a.fn.padEnd(28)} ${a.file}  (renamed, moved or removed — drop the entry or fix its key)`);
}

const indirectNote = `${indirect.length} call(s) with non-literal options, ${INDIRECT_ALLOWLIST.length} registered`;

if (unguarded.length || broken.length || unregistered.length || stale.length) {
  console.error(`[script-graph] (${siteCount} page function site(s) checked, ${guarded.length} guarded optional dependencies, ${indirectNote}.)`);
  process.exit(1);
}

console.log(`[script-graph] OK — ${siteCount} executeScript page function(s) are closure-free ` +
  `(${guarded.length} guarded optional dependencies, ${indirectNote}). --verbose lists them.`);
