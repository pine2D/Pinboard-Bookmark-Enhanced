import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { ledgerKey, reconcileKnownFailures } from '../scripts/render-audit-ledger.mjs';
import { DICT_LOOKUP_GEOMETRY, evaluateDictLookupGeometry } from './render-audit-checklist.mjs';
import { RENDER_SWEEP_CONTEXTS } from '../scripts/audit-render-scenarios.mjs';

const row = (status, check, extra = {}) => ({ surface: 'md-preview', theme: '', selector: '#explain-pop .xp-dict', state: 'dict-entry-result', check, status, ...extra });
const ledger = (...rows) => Object.fromEntries(rows.map((r) => [ledgerKey(r), { note: 'registered' }]));

test('a registered failure whose row now passes is reported as resolved, in a whole run and in a slice', () => {
  const known = ledger(row('FAIL', 'dictLeftEdges'), row('FAIL', 'dictExampleColor'));
  const results = [row('OK', 'dictLeftEdges'), row('FAIL', 'dictExampleColor')];
  for (const sliced of [false, true]) {
    const out = reconcileKnownFailures(results, known, { sliced });
    assert.deepEqual(out.resolved, [ledgerKey(row('OK', 'dictLeftEdges'))]);
    assert.deepEqual(out.warnings.map((r) => r.check), ['dictExampleColor']);
    assert.deepEqual(out.violations, []);
    assert.deepEqual(out.stale, []);
  }
});

test('a key with both an OK and a FAIL row this run is still failing, not resolved', () => {
  const known = ledger(row('FAIL', 'dictLeftEdges'));
  const out = reconcileKnownFailures([row('OK', 'dictLeftEdges'), row('FAIL', 'dictLeftEdges')], known);
  assert.deepEqual(out.resolved, []);
  assert.equal(out.warnings.length, 1);
});

test('an unregistered failure is a violation; an unmeasured registered key is stale only in a whole run', () => {
  const known = ledger(row('FAIL', 'dictViewport320'));
  const results = [row('FAIL', 'dictSenseIndent')];
  const whole = reconcileKnownFailures(results, known);
  assert.deepEqual(whole.violations.map((r) => r.check), ['dictSenseIndent']);
  assert.deepEqual(whole.resolved, []);
  assert.deepEqual(whole.stale, [ledgerKey(row('FAIL', 'dictViewport320'))]);
  assert.deepEqual(reconcileKnownFailures(results, known, { sliced: true }).stale, []);
});

test('a registered key under a SETUP row is unmeasured, never stale or resolved', () => {
  const known = ledger(row('FAIL', 'dictExampleColor'));
  const out = reconcileKnownFailures([row('SETUP', 'dictTranslationColor')], known);
  assert.deepEqual(out.unmeasuredKnown, [ledgerKey(row('FAIL', 'dictExampleColor'))]);
  assert.deepEqual(out.stale, []);
  assert.deepEqual(out.resolved, []);
});

test('every registered known failure names a check its runner still emits', () => {
  // A ledger key whose check no longer exists could never resolve; the dict
  // rows in particular must stay in the shape evaluateDictLookupGeometry emits.
  const known = JSON.parse(readFileSync(new URL('./render-audit-known-failures.json', import.meta.url), 'utf8'));
  for (const [key, entry] of Object.entries(known)) {
    assert.equal(key, ledgerKey(entry), `ledger key ${key} does not match its own fields`);
    if (!entry.check.startsWith('dict')) continue;
    const spec = DICT_LOOKUP_GEOMETRY.surfaces[entry.surface];
    assert.ok(spec?.contexts[entry.state], `${key}: no DICT_LOOKUP_GEOMETRY context`);
    assert.equal(entry.selector, spec.root, `${key}: selector is not the surface root`);
    assert.ok(['', 'dark'].includes(entry.theme), `${key}: theme label`);
  }
});

// ---- the dictionary geometry oracle itself ----
const probe = (blocks, examples = [], viewports = DICT_LOOKUP_GEOMETRY.viewports.map((width) => ({ width, rootVisible: true, viewport: width - 10, rootLeft: 16, rootRight: width - 26, offenders: [] }))) =>
  ({ blocks, examples, viewports });
const verdicts = (p, context = 'dict-entry-details', surface = 'md-preview') =>
  Object.fromEntries(evaluateDictLookupGeometry(p, { surface, context }).map((r) => [r.check, r.status]));

test('every geometry context is a registered sweep context of its surface', () => {
  for (const [surface, spec] of Object.entries(DICT_LOOKUP_GEOMETRY.surfaces)) {
    const names = new Set(RENDER_SWEEP_CONTEXTS[surface].map((c) => c.name));
    for (const context of Object.keys(spec.contexts)) assert.ok(names.has(context), `${surface}/${context}`);
  }
});

test('left edges: the column edge plus one indent pass; a title pushed 8px in is a third edge', () => {
  const ok = [{ role: 'sense', left: 24.5 }, { role: 'sense', left: 24.5 }, { role: 'summary', left: 0 }, { role: 'body', left: 0.6 }];
  assert.equal(verdicts(probe(ok)).dictLeftEdges, 'OK');
  // Without any block at 0 the column edge still counts.
  assert.equal(verdicts(probe([{ role: 'summary', left: 8 }, { role: 'sense', left: 24.5 }])).dictLeftEdges, 'FAIL');
  assert.equal(verdicts(probe([...ok, { role: 'summary', left: 8 }])).dictLeftEdges, 'FAIL');
  // A block left of the column edge is its own edge too.
  assert.equal(verdicts(probe([...ok, { role: 'body', left: -6 }])).dictLeftEdges, 'FAIL');
});

test('sense indent: a lone sense on the column edge fails even when the edge count passes', () => {
  const lone = [{ role: 'sense', left: 24, path: 'a' }, { role: 'sense', left: 24, path: 'b' }, { role: 'sense', left: 0, path: 'lone' }];
  const out = verdicts(probe(lone), 'dict-entry-idle');
  assert.equal(out.dictLeftEdges, 'OK');
  assert.equal(out.dictSenseIndent, 'FAIL');
  assert.equal(verdicts(probe([{ role: 'sense', left: 24 }]), 'dict-entry-idle').dictSenseIndent, 'OK');
  assert.equal(verdicts(probe([{ role: 'sense', left: 24 }, { role: 'sense', left: 30 }]), 'dict-entry-idle').dictSenseIndent, 'FAIL');
});

test('example colours compare each sentence with its resolved token', () => {
  const blocks = [{ role: 'sense', left: 24 }];
  const good = [{ role: 'original', color: 'rgb(1, 1, 1)', expected: 'rgb(1, 1, 1)' }, { role: 'translation', color: 'rgb(2, 2, 2)', expected: 'rgb(2, 2, 2)' }];
  assert.equal(verdicts(probe(blocks, good)).dictExampleColor, 'OK');
  assert.equal(verdicts(probe(blocks, good)).dictTranslationColor, 'OK');
  const inverted = [{ role: 'original', color: 'rgb(2, 2, 2)', expected: 'rgb(1, 1, 1)' }, { role: 'translation', color: 'rgb(1, 1, 1)', expected: 'rgb(2, 2, 2)' }];
  assert.equal(verdicts(probe(blocks, inverted)).dictExampleColor, 'FAIL');
  assert.equal(verdicts(probe(blocks, inverted)).dictTranslationColor, 'FAIL');
});

test('viewport: any visible descendant outside the narrow viewport fails that width', () => {
  const views = [
    { width: 320, rootVisible: true, viewport: 310, rootLeft: 16, rootRight: 294, offenders: [{ path: 'select.xp-dict-save-meaning', left: 200, right: 330 }] },
    { width: 360, rootVisible: true, viewport: 350, rootLeft: 16, rootRight: 334, offenders: [] },
  ];
  const out = verdicts(probe([{ role: 'sense', left: 24 }], [], views), 'explain-dict');
  assert.equal(out.dictViewport320, 'FAIL');
  assert.equal(out.dictViewport360, 'OK');
});

test('a context that should render a block but measured none is SETUP, never a vacuous pass', () => {
  const out = verdicts(probe([], []), 'dict-entry-result');
  for (const check of ['dictLeftEdges', 'dictSenseIndent', 'dictExampleColor', 'dictTranslationColor']) assert.equal(out[check], 'SETUP', check);
  const hidden = verdicts(probe([], [], [{ width: 320, rootVisible: false }, { width: 360, rootVisible: false }]), 'explain-dict');
  assert.equal(hidden.dictViewport320, 'SETUP');
  // explain-dict (connect state) is not required to render senses.
  assert.equal(hidden.dictSenseIndent, undefined);
});
