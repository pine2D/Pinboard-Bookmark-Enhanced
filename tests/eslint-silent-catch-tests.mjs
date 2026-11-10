// Self-test for scripts/eslint-rules/no-silent-catch.mjs. Runs the rule through
// ESLint's own Linter on in-memory sources, so scope analysis is the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from '../.qa-scan/node_modules/eslint/lib/api.js';
import rule from '../scripts/eslint-rules/no-silent-catch.mjs';

function run(code) {
  const linter = new Linter();
  const messages = linter.verify(code, [{
    plugins: { pbp: { rules: { 'no-silent-catch': rule } } },
    languageOptions: { ecmaVersion: 2024, sourceType: 'script' },
    rules: { 'pbp/no-silent-catch': 'error' },
  }], 'sample.js');
  const fatal = messages.filter((m) => m.fatal);
  assert.deepEqual(fatal, [], 'sample must parse');
  return messages.map((m) => m.ruleId);
}
const bad = (name, code) => test(`reports: ${name}`, () => assert.deepEqual(run(code), ['pbp/no-silent-catch']));
const ok = (name, code) => test(`allows: ${name}`, () => assert.deepEqual(run(code), []));

// ---- try/catch ----
bad('empty catch', 'try { x(); } catch (e) {}');
bad('catch without binding, no trace', 'try { x(); } catch { }');
bad('catch that only sets a flag', 'let f; try { x(); } catch (e) { f = 1; }');
bad('binding shadowed by an inner variable of the same name',
  'try { x(); } catch (e) { (function () { const e = 1; return e; })(); }');
bad('console call that is not a logging method', 'try { x(); } catch (e) { console.table([]); }');
ok('console.warn', 'try { x(); } catch (e) { console.warn("x"); }');
ok('console.error without using the binding', 'try { x(); } catch { console.error("x"); }');
ok('throw', 'try { x(); } catch (e) { throw new Error("y"); }');
ok('binding read', 'let m; try { x(); } catch (e) { m = e.message; }');
ok('binding read only inside a nested function',
  'let h; try { x(); } catch (e) { h = () => e.message; }');
ok('destructured binding read', 'let m; try { x(); } catch ({ message }) { m = message; }');
bad('destructured binding not read', 'try { x(); } catch ({ message }) { }');
bad('throw only inside a nested function does not count',
  'try { x(); } catch (e2) { const f = () => { throw 1; }; }');
ok('swallow-ok with a reason (line comment)', 'try { x(); } catch (e) { /* swallow-ok: best effort cleanup */ }');
ok('swallow-ok with a reason (line comment form)', 'try { x(); } catch {\n // swallow-ok: tab may be gone\n}');
bad('swallow-ok with an empty reason', 'try { x(); } catch (e) { // swallow-ok:\n}');
bad('swallow-ok with an empty reason (block)', 'try { x(); } catch (e) { /* swallow-ok:   */ }');
bad('ordinary comment only', 'try { x(); } catch (e) { /* ignore */ }');
bad('swallow-ok outside the catch block does not exempt',
  '// swallow-ok: not here\ntry { x(); } catch (e) {}');

// ---- .catch(callback) ----
bad('.catch(() => {})', 'p.catch(() => {});');
bad('.catch(function () {})', 'p.catch(function () {});');
bad('.catch(e => {}) with unused param', 'p.catch((e) => {});');
bad('.catch with an expression body that ignores the error', 'p.catch(() => null);');
ok('.catch(e => console.warn(e))', 'p.catch((e) => console.warn(e));');
ok('.catch(() => console.warn("x"))', 'p.catch(() => console.warn("x"));');
ok('.catch(e => { throw e; })', 'p.catch((e) => { throw e; });');
ok('.catch(handler)', 'p.catch(handler);');
ok('.catch(e => e.message) reads the parameter', 'p.catch((e) => e.message);');
ok('.catch(function (e) { return e; })', 'p.catch(function (e) { return e; });');
bad('.catch param shadowed inside', 'p.catch((e) => { const f = (e) => e; });');
ok('.catch with swallow-ok and a reason', 'p.catch(() => { /* swallow-ok: fire and forget */ });');
bad('.catch with swallow-ok and no reason', 'p.catch(() => { /* swallow-ok: */ });');
ok('.then(a, b) is not a .catch call', 'p.then(() => {}, () => {});');
ok('a method named catch with a non-function argument', 'p.catch(null);');
