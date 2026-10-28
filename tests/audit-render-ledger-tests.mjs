import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { ledgerKey, reconcileKnownFailures } from '../scripts/render-audit-ledger.mjs';
import { DICT_LOOKUP_GEOMETRY, dictLookupRoots, evaluateDictLookupGeometry, NOTES_BACK_BAR, evaluateNotesBackBar } from './render-audit-checklist.mjs';
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
    assert.equal(entry.selector, dictLookupRoots(entry.surface, entry.state).root, `${key}: selector is not the context's lookup root`);
    assert.ok(['', 'dark'].includes(entry.theme), `${key}: theme label`);
  }
});

// ---- the dictionary geometry oracle itself ----
const probe = (blocks, examples = [], viewports = DICT_LOOKUP_GEOMETRY.viewports.map((width) => ({ width, rootVisible: true, viewport: width - 10, rootLeft: 16, rootRight: width - 26, offenders: [] })), clip = { measured: blocks.length, offenders: [] }) =>
  ({ blocks, examples, viewports, clip });
const verdicts = (p, context = 'dict-entry-details', surface = 'md-preview') =>
  Object.fromEntries(evaluateDictLookupGeometry(p, { surface, context }).map((r) => [r.check, r.status]));

test('every geometry context is a registered sweep context of its surface', () => {
  for (const [surface, spec] of Object.entries(DICT_LOOKUP_GEOMETRY.surfaces)) {
    const names = new Set(RENDER_SWEEP_CONTEXTS[surface].map((c) => c.name));
    for (const context of Object.keys(spec.contexts)) assert.ok(names.has(context), `${surface}/${context}`);
  }
});

// Every lookup state the reader and the library register (dict redesign 3.6)
// is held to the batch-0 geometry, so a new one cannot slip in unmeasured.
// The exemptions are transitional states whose layout a measured successor
// already covers: busy -> progress (adds the seconds), cached -> result (the
// same DOM read back from the cache). A usage supplement in flight is not
// exempt: its progress row replaces the button, a layout no later state shows.
const DICT_GEOMETRY_EXEMPT = new Set(['dict-entry-busy', 'dict-entry-cached']);
test('every lookup sweep state on the reader and the library has a geometry context', () => {
  for (const surface of ['md-preview', 'library']) {
    const spec = DICT_LOOKUP_GEOMETRY.surfaces[surface];
    const names = RENDER_SWEEP_CONTEXTS[surface].map((c) => c.name).filter((name) => /^dict-(entry|save)-/.test(name));
    assert.ok(names.length > 0, `${surface}: no lookup sweep states found`);
    for (const name of names) {
      if (DICT_GEOMETRY_EXEMPT.has(name)) continue;
      assert.ok(spec.contexts[name], `${surface}/${name}: registered sweep state without DICT_LOOKUP_GEOMETRY`);
    }
    for (const name of DICT_GEOMETRY_EXEMPT) assert.ok(names.includes(name), `${surface}/${name}: stale exemption`);
  }
  // The redesign's own states (plan 3.6) are registered on both surfaces.
  for (const name of ['dict-entry-negative', 'dict-entry-legacy', 'dict-entry-examples', 'dict-entry-progress', 'dict-entry-usage-busy',
    'dict-save-bar', 'dict-save-change-menu', 'dict-entry-paid-negative']) {
    for (const surface of ['md-preview', 'library']) {
      assert.ok(RENDER_SWEEP_CONTEXTS[surface].some((c) => c.name === name), `${surface}/${name} is not a sweep state`);
    }
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

test('scroll clip: a disclosure title hanging out of its scroller fails; nothing measured is SETUP', () => {
  const blocks = [{ role: 'sense', left: 24 }, { role: 'summary', left: 0 }];
  assert.equal(verdicts(probe(blocks), 'dict-entry-panel').dictScrollClip, 'OK');
  const views = DICT_LOOKUP_GEOMETRY.viewports.map((width) => ({ width, rootVisible: true, viewport: width, rootLeft: 0, rootRight: width, offenders: [] }));
  const hanging = { measured: 3, offenders: [{ path: 'details.xp-dict-ai-details > summary', kind: 'box', detail: '[1354.2, 1720] outside .xp-body [1362.2, 1716]' }] };
  assert.equal(verdicts(probe(blocks, [], views, hanging), 'dict-entry-panel').dictScrollClip, 'FAIL');
  const sideways = { measured: 3, offenders: [{ path: '.xp-body', kind: 'scroll', detail: 'scrollWidth 451 > clientWidth 447' }] };
  assert.equal(verdicts(probe(blocks, [], views, sideways), 'dict-entry-result').dictScrollClip, 'FAIL');
  assert.equal(verdicts(probe(blocks, [], views, { measured: 0, offenders: [] }), 'dict-entry-panel').dictScrollClip, 'SETUP');
  // The connect state has no text blocks and does not require the check.
  assert.equal(verdicts(probe([], [], views, { measured: 0, offenders: [] }), 'explain-dict').dictScrollClip, undefined);
});

test('a context can name its own lookup root; the docked panel is measured in the side panel', () => {
  assert.deepEqual(dictLookupRoots('md-preview', 'dict-entry-panel'), { root: '#reader-dict-view .xp-dict', overflowRoot: '#reader-dict-view' });
  assert.deepEqual(dictLookupRoots('md-preview', 'dict-entry-result'), { root: '#explain-pop .xp-dict', overflowRoot: '#explain-pop' });
  assert.throws(() => dictLookupRoots('md-preview', 'reader'));
});

test('action notes: a note beside its button (a narrow column) fails; the line below passes; none measured is SETUP', () => {
  const blocks = [{ role: 'sense', left: 24 }];
  const withNotes = (notes) => ({ ...probe(blocks), notes });
  // The 2026-10-28 ruling: the remembered state's note is the line below the button.
  const below = [{ path: 'a', buttonBottom: 126, top: 134 }, { path: 'b', buttonBottom: 180, top: 188 }];
  for (const surface of ['md-preview', 'library']) {
    for (const context of ['dict-entry-paid-negative', 'dict-entry-negative']) {
      assert.equal(verdicts(withNotes(below), context, surface).dictActionNoteBelow, 'OK', `${surface}/${context}`);
      // de in the reader before the fix: a 92px-wide note beside a 344px button.
      assert.equal(verdicts(withNotes([...below, { path: 'c', buttonBottom: 226, top: 200 }]), context, surface).dictActionNoteBelow, 'FAIL', `${surface}/${context}`);
      assert.equal(verdicts(withNotes([]), context, surface).dictActionNoteBelow, 'SETUP', `${surface}/${context}`);
    }
  }
  // Within the edge tolerance is still below (sub-pixel rounding).
  assert.equal(verdicts(withNotes([{ path: 'a', buttonBottom: 126.6, top: 126 }]), 'dict-entry-paid-negative').dictActionNoteBelow, 'OK');
  // A context that renders no remembered note does not require the check.
  assert.equal(verdicts(withNotes([]), 'dict-entry-result').dictActionNoteBelow, undefined);
});

test('usage slots: each category under its own label, patterns before confusables; a receipt under the other button fails', () => {
  const blocks = [{ role: 'sense', left: 24 }];
  const withSlots = (slots) => ({ ...probe(blocks), slots });
  const band = (category, index, top, bottom, label = { top: top - 26, bottom: top - 8 }) => ({ category, index, items: 2, top, bottom, path: category, label });
  const good = [band('patterns', 0, 126, 160), band('confusables', 1, 210, 320)];
  for (const surface of ['md-preview', 'library']) {
    for (const context of ['dict-entry-usage-busy', 'dict-entry-usage-error', 'dict-entry-usage-result', 'dict-entry-paid-negative', 'dict-entry-legacy']) {
      assert.equal(verdicts(withSlots(good), context, surface).dictUsageSlots, 'OK', `${surface}/${context}`);
      // Before the slots: no label line names either category.
      assert.equal(verdicts(withSlots(good.map((b) => ({ ...b, label: null }))), context, surface).dictUsageSlots, 'FAIL', `${surface}/${context}`);
      assert.equal(verdicts(withSlots([]), context, surface).dictUsageSlots, 'SETUP', `${surface}/${context}`);
    }
  }
  // 08-usage-result-p3: the confusables result sits above the patterns
  // button and its receipt below it -- the two bands interleave.
  assert.equal(verdicts(withSlots([band('patterns', 0, 300, 330), band('confusables', 1, 120, 360)]), 'dict-entry-usage-result').dictUsageSlots, 'FAIL');
  // A label under the thing it names fails too.
  assert.equal(verdicts(withSlots([band('patterns', 0, 126, 160, { top: 150, bottom: 168 }), good[1]]), 'dict-entry-usage-result').dictUsageSlots, 'FAIL');
  // A category with nothing on screen is not measured; a context that does
  // not show the usage block does not require the check.
  assert.equal(verdicts(withSlots([{ ...good[0], items: 0 }, good[1]]), 'dict-entry-usage-result').dictUsageSlots, 'OK');
  assert.equal(verdicts(withSlots([]), 'dict-entry-result').dictUsageSlots, undefined);
  // The learner-profile line serves both slots: nearer to the last slot
  // than the slots are apart (sp-2 under sp-4, the 55db5993 review's
  // 06-usage-busy-p2), it reads as part of confusables and fails.
  const withLead = (profileGap, slotGap = 16) => ({ ...withSlots(good), slotProfile: { slotGap, profileGap, path: 'profile' } });
  assert.equal(verdicts(withLead(8), 'dict-entry-usage-busy').dictUsageSlots, 'FAIL');
  assert.equal(verdicts(withLead(16), 'dict-entry-usage-busy').dictUsageSlots, 'OK');
  assert.equal(verdicts(withLead(15.5), 'dict-entry-usage-busy').dictUsageSlots, 'OK');
});

test('paid model note: one line in one flow; a wrapped note or a column beside the label fails; none measured is SETUP', () => {
  const blocks = [{ role: 'sense', left: 24 }];
  const withPaid = (buttons, width = 360) => ({ ...probe(blocks), paid: [{ width, buttons }] });
  const good = [{ path: 'a', lines: 1, flow: true, sep: true, detail: '' }, { path: 'b', lines: 1, flow: true, sep: true, detail: '' }];
  for (const surface of ['md-preview', 'library']) {
    for (const context of ['dict-entry-result', 'dict-entry-usage-result', 'dict-entry-error', 'dict-entry-paid-negative']) {
      assert.equal(verdicts(withPaid(good), context, surface).dictPaidModel360, 'OK', `${surface}/${context}`);
      // 18-paid-negative-b: "· gpt-5.4- / nano" in a column beside the label.
      assert.equal(verdicts(withPaid([...good, { path: 'c', lines: 2, flow: false, detail: 'column' }]), context, surface).dictPaidModel360, 'FAIL', `${surface}/${context}`);
      assert.equal(verdicts(withPaid([...good, { path: 'c', lines: 1, flow: false, detail: 'beside' }]), context, surface).dictPaidModel360, 'FAIL', `${surface}/${context}`);
      // The batch-3b review: a wrapped note whose second line starts "· gpt-5.4-nano".
      assert.equal(verdicts(withPaid([...good, { path: 'c', lines: 1, flow: true, sep: false, detail: 'separator' }]), context, surface).dictPaidModel360, 'FAIL', `${surface}/${context}`);
      assert.equal(verdicts(withPaid([]), context, surface).dictPaidModel360, 'SETUP', `${surface}/${context}`);
      assert.equal(verdicts(probe(blocks), context, surface).dictPaidModel, 'SETUP', `${surface}/${context}`);
    }
  }
  // A state without paid buttons does not require the check.
  assert.equal(verdicts(probe(blocks), 'dict-entry-examples', 'library').dictPaidModel, undefined);
});

test('sticky bars: the save bar on the scroller bottom and the back bar from its top; a strip of content fails', () => {
  const blocks = [{ role: 'sense', left: 24 }];
  const foot = (bottom, strip = []) => ({ stuck: true, bottom, scrollerBottom: 900, strip });
  const back = (strip = []) => ({ measured: true, top: 124, scrollerTop: 124, strip });
  const withSticky = (sticky) => ({ ...probe(blocks), sticky });
  const good = [{ width: 360, foot: foot(900), back: back() }, { width: 1280, foot: foot(900.4), back: null }];
  for (const context of ['dict-entry-result', 'dict-entry-usage-result', 'dict-save-bar', 'dict-entry-paid-negative']) {
    const out = verdicts(withSticky(good), context, 'library');
    assert.equal(out.dictSaveBarFlush360, 'OK', context);
    assert.equal(out.dictSaveBarFlush1280, 'OK', context);
    assert.equal(out.dictBackBarTop360, 'OK', context);
    // Two panes at 1280: there is no back bar to measure.
    assert.equal(out.dictBackBarTop1280, undefined, context);
  }
  // 04-result-b: a sticky bottom:0 stops at the pane's 96px bottom padding.
  const raised = verdicts(withSticky([{ width: 360, foot: foot(804, ['li']), back: back() }, good[1]]), 'dict-save-bar', 'library');
  assert.equal(raised.dictSaveBarFlush360, 'FAIL');
  assert.equal(raised.dictSaveBarFlush1280, 'OK');
  // Content painted under a flush bar still fails.
  assert.equal(verdicts(withSticky([{ width: 360, foot: foot(900, ['p']), back: back() }, good[1]]), 'dict-save-bar', 'library').dictSaveBarFlush360, 'FAIL');
  // 12-error-b: 8px of text above the back button.
  assert.equal(verdicts(withSticky([{ width: 360, foot: foot(900), back: back(['ol.xp-dict-senses > li']) }, good[1]]), 'dict-save-bar', 'library').dictBackBarTop360, 'FAIL');
  // A bar that is not stuck (the lookup is shorter than the pane) or a width
  // never measured is SETUP, not a pass.
  const unstuck = verdicts(withSticky([{ width: 360, foot: { stuck: false }, back: back() }]), 'dict-save-bar', 'library');
  assert.equal(unstuck.dictSaveBarFlush360, 'SETUP');
  assert.equal(unstuck.dictSaveBarFlush1280, 'SETUP');
  assert.equal(verdicts(withSticky([{ width: 360, foot: foot(900), back: { measured: false } }]), 'dict-save-bar', 'library').dictBackBarTop360, 'SETUP');
  // The viewport axis narrows the widths that must be measured.
  const only360 = Object.fromEntries(evaluateDictLookupGeometry(withSticky([good[0]]), { surface: 'library', context: 'dict-save-bar', stickyViewports: [360] }).map((r) => [r.check, r.status]));
  assert.equal(only360.dictSaveBarFlush360, 'OK');
  assert.equal(only360.dictSaveBarFlush1280, undefined);
  // The reader has no sticky library bars.
  assert.equal(verdicts(withSticky(good), 'dict-save-bar', 'md-preview').dictSaveBarFlush360, undefined);
});

test('save bar focus: a focused control clear of the stuck bar; one under it fails', () => {
  const blocks = [{ role: 'sense', left: 24 }];
  const foot = (focus) => ({ stuck: true, bottom: 900, scrollerBottom: 900, strip: [], focus });
  const at = (f360, f1280 = { controls: 15, covered: [] }) => ({ ...probe(blocks), sticky: [{ width: 360, foot: foot(f360), back: null }, { width: 1280, foot: foot(f1280), back: null }] });
  for (const context of ['dict-entry-result', 'dict-entry-usage-result', 'dict-save-bar', 'dict-entry-paid-negative']) {
    const out = verdicts(at({ controls: 16, covered: [] }), context, 'library');
    assert.equal(out.dictSaveBarFocus360, 'OK', context);
    assert.equal(out.dictSaveBarFocus1280, 'OK', context);
  }
  // The 3b.2 review: "Generate" focused wholly under the bar at 1280.
  const under = verdicts(at({ controls: 16, covered: [] }, { controls: 15, covered: ['button.xp-dict-supplement-generate [692, 720] under the bar [672, 720]'] }), 'dict-save-bar', 'library');
  assert.equal(under.dictSaveBarFocus360, 'OK');
  assert.equal(under.dictSaveBarFocus1280, 'FAIL');
  // An unstuck bar, no probe, or no control to focus is SETUP, not a pass.
  assert.equal(verdicts({ ...probe(blocks), sticky: [{ width: 360, foot: { stuck: false }, back: null }] }, 'dict-save-bar', 'library').dictSaveBarFocus360, 'SETUP');
  assert.equal(verdicts(at(undefined), 'dict-save-bar', 'library').dictSaveBarFocus360, 'SETUP');
  assert.equal(verdicts(at({ controls: 0, covered: [] }), 'dict-save-bar', 'library').dictSaveBarFocus360, 'SETUP');
  assert.equal(verdicts(at({ controls: 16, covered: [] }), 'dict-save-bar', 'md-preview').dictSaveBarFocus360, undefined);
});

test('save text: the save button keeps its label beside the icon-only re-lookup; two icon squares fail', () => {
  const blocks = [{ role: 'sense', left: 24 }];
  const foot = { stuck: true, bottom: 900, scrollerBottom: 900, strip: [] };
  const save = (over = {}) => ({ labelVisible: true, label: 'Save to vocabulary', width: 180, height: 32, lines: 1, iconOffset: 0, controlH: 32, bodyLh: 20, relookupWidth: 26, iconOnly: ['button.btn.vocab-ref-relookup'], ...over });
  const at = (s360, s1280 = save()) => ({ ...probe(blocks), sticky: [{ width: 360, foot, back: null, save: s360 }, { width: 1280, foot, back: null, save: s1280 }] });
  for (const context of ['dict-entry-result', 'dict-entry-usage-result', 'dict-save-bar', 'dict-entry-paid-negative']) {
    const out = verdicts(at(save()), context, 'library');
    assert.equal(out.dictSaveText360, 'OK', context);
    assert.equal(out.dictSaveText1280, 'OK', context);
  }
  // e023a00b's (d): <=440px hid the label and cut the button to a square.
  const square = save({ labelVisible: false, width: 26, iconOnly: ['button.btn.vocab-lookup-save', 'button.btn.vocab-ref-relookup'] });
  const old = verdicts(at(square), 'dict-save-bar', 'library');
  assert.equal(old.dictSaveText360, 'FAIL');
  assert.equal(old.dictSaveText1280, 'OK');
  // Each condition alone fails: a hidden label, an empty one, a button no
  // wider than the re-lookup, a second icon-only button in the bar.
  for (const over of [{ labelVisible: false }, { label: '' }, { width: 26 }, { iconOnly: ['a', 'b'] }]) {
    assert.equal(verdicts(at(save(over)), 'dict-save-bar', 'library').dictSaveText360, 'FAIL', JSON.stringify(over));
  }
  // The batch-3b review's 16-save-bar-b (de, 360): a two-line label in the
  // rung's 30px line-height made a 62px button; two body lines fit 52.
  assert.equal(verdicts(at(save({ label: 'Gespeicherte Vokabel aktualisieren', width: 262, lines: 2, height: 62 })), 'dict-save-bar', 'library').dictSaveText360, 'FAIL');
  assert.equal(verdicts(at(save({ label: 'Gespeicherte Vokabel aktualisieren', width: 262, lines: 2, height: 52 })), 'dict-save-bar', 'library').dictSaveText360, 'OK');
  assert.equal(verdicts(at(save({ lines: 1, height: 34 })), 'dict-save-bar', 'library').dictSaveText360, 'FAIL');
  // Task 3d: a two-line label centred its icon across both lines (10px below
  // the first line's centre in a 52px button); the icon belongs to line one.
  assert.equal(verdicts(at(save({ label: 'Gespeicherte Vokabel aktualisieren', width: 262, lines: 2, height: 52, iconOffset: 10 })), 'dict-save-bar', 'library').dictSaveText360, 'FAIL');
  assert.equal(verdicts(at(save({ label: 'Gespeicherte Vokabel aktualisieren', width: 262, lines: 2, height: 52, iconOffset: -0.5 })), 'dict-save-bar', 'library').dictSaveText360, 'OK');
  assert.equal(verdicts(at(save({ iconOffset: null })), 'dict-save-bar', 'library').dictSaveText360, 'FAIL');
  // Compact density: 28 + 18 for a second line.
  assert.equal(verdicts(at(save({ controlH: 28, bodyLh: 18, lines: 2, height: 46 })), 'dict-save-bar', 'library').dictSaveText360, 'OK');
  // Unread tokens cannot pass the height check.
  assert.equal(verdicts(at(save({ controlH: 0 })), 'dict-save-bar', 'library').dictSaveText360, 'FAIL');
  // No save button measured at a width the axis selects is SETUP.
  assert.equal(verdicts(at(null), 'dict-save-bar', 'library').dictSaveText360, 'SETUP');
  assert.equal(verdicts({ ...probe(blocks), sticky: [] }, 'dict-save-bar', 'library').dictSaveText1280, 'SETUP');
  // The reader has no library save bar.
  assert.equal(verdicts(at(save()), 'dict-save-bar', 'md-preview').dictSaveText360, undefined);
});

test('the library states with the save bar and paid buttons run at a phone and a desktop width', () => {
  for (const name of ['dict-save-bar', 'dict-entry-result', 'dict-entry-paid-negative', 'dict-entry-usage-result']) {
    const item = RENDER_SWEEP_CONTEXTS.library.find((c) => c.name === name);
    assert.deepEqual(item?.viewports, ['360', '1280'], name);
    assert.ok(DICT_LOOKUP_GEOMETRY.surfaces.library.contexts[name].requires.includes('sticky'), `${name} requires the sticky bars`);
  }
  assert.deepEqual(DICT_LOOKUP_GEOMETRY.sticky.viewports, [360, 1280]);
});

test('save choice list: inside the reader card, definitions only in the library', () => {
  const withMenu = (menu) => ({ ...probe([]), menu });
  const frame = { left: 427, right: 905 };
  assert.equal(verdicts(withMenu({ open: true, box: { left: 427, right: 905 }, frame, rows: [] }), 'dict-save-change-menu').dictSaveMenuBox, 'OK');
  // 18-save-change-menu-viewport: right-aligned to "Change" at a 480px cap,
  // the list hung ~120px past the card's left edge.
  assert.equal(verdicts(withMenu({ open: true, box: { left: 309, right: 789 }, frame, rows: [] }), 'dict-save-change-menu').dictSaveMenuBox, 'FAIL');
  // Inside but narrower than the card is not aligned either.
  assert.equal(verdicts(withMenu({ open: true, box: { left: 440, right: 905 }, frame, rows: [] }), 'dict-save-change-menu').dictSaveMenuBox, 'FAIL');
  assert.equal(verdicts(withMenu(null), 'dict-save-change-menu').dictSaveMenuBox, 'SETUP');
  assert.equal(verdicts(withMenu({ open: true, box: { left: 427, right: 905 }, frame: null, rows: [] }), 'dict-save-change-menu').dictSaveMenuBox, 'SETUP');
  const lib = (rows, title = 'serendipity') => verdicts(withMenu({ open: true, rows, title }), 'dict-save-change-menu', 'library').dictSaveMenuChoices;
  assert.equal(lib([{ value: 'online:0', text: 'a' }, { value: 'ai:0', text: 'b' }]), 'OK');
  // 17-save-change-menu-a: the "Definition to save" prompt listed as a row.
  assert.equal(lib([{ value: '', text: 'Definition to save' }, { value: 'online:0', text: 'a' }]), 'FAIL');
  // The batch-3b review's lib-menus: every row led by the heading's word.
  assert.equal(lib([{ value: 'online:0', text: 'serendipity · luck (Wiktionary)' }, { value: 'ai:0', text: 'b' }]), 'FAIL');
  // A different word to save (a lemma, a shorter headword) keeps its word.
  assert.equal(lib([{ value: 'pack:0', text: 'run · to move fast (Pack)' }, { value: 'online:0', text: 'luck' }], 'running'), 'OK');
  assert.equal(lib([{ value: 'online:0', text: 'serendipityism · x' }]), 'OK');
  // No heading to compare with is SETUP, not a pass.
  assert.equal(lib([{ value: 'online:0', text: 'a' }], ''), 'SETUP');
  assert.equal(lib([]), 'SETUP');
  assert.equal(verdicts(withMenu({ open: false, rows: [] }), 'dict-save-change-menu', 'library').dictSaveMenuChoices, 'SETUP');
  // Other contexts do not require it.
  assert.equal(verdicts(withMenu(null), 'dict-save-bar').dictSaveMenuBox, undefined);
});

test('notes back bar: the band covers the scroller from its visible top; a strip of the scrolled page fails', () => {
  const at = (back) => Object.fromEntries(evaluateNotesBackBar([{ width: 360, foot: null, back }]).map((r) => [r.check, r.status]));
  assert.deepEqual(NOTES_BACK_BAR.viewports, [360]);
  assert.equal(at({ measured: true, top: 132, scrollerTop: 124, strip: [] }).notesBackBarTop360, 'OK');
  // The batch-3b review: the bare sticky button stopped at the pane's top
  // padding, the scrolled title showing above and beside it.
  assert.equal(at({ measured: true, top: 132, scrollerTop: 124, strip: ['h2.notes-detail-source'] }).notesBackBarTop360, 'FAIL');
  assert.equal(at({ measured: true, top: 110, scrollerTop: 124, strip: [] }).notesBackBarTop360, 'FAIL');
  // Nothing scrolled under the bar, or no bar, is SETUP, not a pass.
  assert.equal(at({ measured: false }).notesBackBarTop360, 'SETUP');
  assert.equal(at(null).notesBackBarTop360, 'SETUP');
  assert.equal(Object.fromEntries(evaluateNotesBackBar([]).map((r) => [r.check, r.status])).notesBackBarTop360, 'SETUP');
});
