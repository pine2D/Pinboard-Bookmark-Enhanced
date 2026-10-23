import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { CHECKS, THEMES } from './render-audit-checklist.mjs';
import { auditSelection } from '../scripts/audit-scope.mjs';

const catalog = await import('../scripts/audit-render-scenarios.mjs').catch((error) => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

test('every hand-written checklist row belongs to an executable surface/state scenario', () => {
  assert.ok(Array.isArray(catalog.RENDER_SCENARIOS), 'render scenario registry is missing');
  const ids = new Set(catalog.RENDER_SCENARIOS.map((row) => row.id));
  for (const check of CHECKS) assert.ok(ids.has(catalog.checkScenarioId(check)));
  assert.equal(ids.size, catalog.RENDER_SCENARIOS.length, 'duplicate scenario ids');
  for (const surface of ['popup', 'options', 'library', 'md-preview']) {
    assert.ok(catalog.RENDER_SCENARIOS.some((row) => row.surfaces.includes(surface)));
  }
});

test('theme planning respects a row restriction and the real scheme of fixed presets', () => {
  assert.equal(typeof catalog.renderThemes, 'function');
  const rows = new Map(catalog.RENDER_SCENARIOS.map((row) => [row.id, row]));
  const selection = {
    has: () => true,
    values(id, axis, defaults) {
      const declared = rows.get(id).axes[axis];
      return defaults.filter((value) => declared.includes(value) && (axis !== 'scheme' || value === 'dark'));
    },
  };
  assert.deepEqual(catalog.renderThemes(selection, 'render.popup.default', ['', 'terminal', 'paper-ink']), ['terminal']);
  assert.deepEqual(catalog.renderThemes(selection, 'render.library.hangOrder', ['', 'terminal', 'dracula']), ['terminal']);
});

test('sweep dependencies open explain before dictionary and do not select other reader features', () => {
  assert.equal(typeof catalog.renderSweepPlan, 'function');
  assert.deepEqual(catalog.renderSweepPlan('md-preview', ['explain-dict']), ['explain-pop', 'explain-dict']);
  assert.deepEqual(catalog.renderSweepPlan('options', ['tab-reader']), ['tab-reader']);
  assert.deepEqual(catalog.renderSweepPlan('library', ['notes-color-menu']), ['notes-detail', 'notes-color-menu']);
  assert.throws(() => catalog.renderSweepPlan('popup', ['unknown']), /unknown/i);
});

test('an unopened selected scenario fails setup and cannot claim completion', async () => {
  assert.equal(typeof catalog.runRenderScenario, 'function');
  const events = [];
  const audit = { start(id) { events.push(['start', id]); }, complete(id) { events.push(['complete', id]); } };
  await assert.rejects(catalog.runRenderScenario(audit, 'render.md-preview.sweep.ask-panel', async () => false, async () => {
    events.push(['measure']);
  }), /SETUP.*ask-panel/);
  assert.deepEqual(events, [['start', 'render.md-preview.sweep.ask-panel']]);
  await catalog.runRenderScenario(audit, 'render.options.sweep.tab-reader', async () => true, async () => events.push(['measure']));
  assert.deepEqual(events.slice(1), [['start', 'render.options.sweep.tab-reader'], ['measure'], ['complete', 'render.options.sweep.tab-reader']]);
});

function command(...args) {
  return spawnSync(process.execPath, ['scripts/ui-render-audit.mjs', ...args], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, FONTCONFIG_FILE: '', DISPLAY: ':65534' },
  });
}
function plan(...args) {
  const result = command(...args, '--audit-plan');
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).scenarios;
}

test('real selection does not broaden a theme-limited checklist state', () => {
  const selection = auditSelection({ runner: 'render', scenarios: catalog.RENDER_SCENARIOS,
    argv: ['--audit-scenario=render.library.hangOrder'] });
  assert.deepEqual(catalog.renderThemes(selection, 'render.library.hangOrder'), ['', 'terminal']);
});

test('isolated popup hover checks reveal their form without fetching unrelated tag chips', () => {
  assert.equal(typeof catalog.popupCheckSetup, 'function');
  const checks = CHECKS.filter((check) => check.surface === 'popup' && check.state === 'hover');
  assert.deepEqual(catalog.popupCheckSetup(checks), { form: true, chips: false });
  assert.deepEqual(catalog.popupCheckSetup([], { paint: true }), { form: true, chips: true });
  assert.equal(catalog.popupCheckSetup([{ selector: '.stag.ai', state: 'default' }]).chips, true);
});

test('plans isolate a tab, popup form and dictionary closure without a usable display', () => {
  for (const id of ['render.options.sweep.tab-reader', 'render.popup.sweep.form']) {
    assert.deepEqual(plan(`--audit-scenario=${id}`).map((row) => row.id), [id]);
  }
  const reader = plan('--audit-scenario=render.md-preview.sweep.explain-dict', '--audit-scheme=dark');
  assert.deepEqual(reader.map((row) => row.id), ['render.md-preview.sweep.explain-pop', 'render.md-preview.sweep.explain-dict']);
  assert.ok(reader.every((row) => row.selectedAxes.scheme.join() === 'dark' && !row.axes.theme));
});

test('partial baseline writes and impossible theme/scheme pairs fail before browser launch', () => {
  for (const write of ['--update-known-failures', '--write-spacing-baseline']) {
    const result = command('--audit-scenario=render.popup.sweep.form', write);
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /partial audit cannot rewrite/);
  }
  const impossible = command('--audit-scenario=render.popup.default', '--audit-theme=default', '--audit-scheme=dark');
  assert.ifError(impossible.error);
  assert.equal(impossible.status, 2);
  assert.match(impossible.stderr, /no executable theme\/scheme/);
  const unsupported = command('--audit-surface=md-preview', '--audit-theme=terminal');
  assert.ifError(unsupported.error);
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /No scenarios match/);
});

test('font plans are environment independent and execution rejects the wrong configured font environment', () => {
  const rows = plan('--audit-scenario=render.popup.sweep.form', '--audit-font=ci');
  assert.deepEqual(rows[0].selectedAxes.font, ['ci']);
  const result = command('--audit-scenario=render.popup.sweep.form', '--audit-font=ci');
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /font.*ci.*native/i);
});

test('full and sharded plans allocate every scenario/theme once, including relocated rows', () => {
  const full = plan();
  const shards = Array.from({ length: 4 }, (_, index) => plan(`--shard=${index}/4`));
  for (const row of full) {
    const occurrences = shards.flatMap((rows) => rows.filter((candidate) => candidate.id === row.id));
    if (row.type === 'sweep') {
      assert.equal(occurrences.length, 1, row.id);
      assert.ok(shards[0].some((candidate) => candidate.id === row.id), row.id);
    } else {
      const themes = occurrences.flatMap((candidate) => candidate.axes.theme);
      assert.equal(new Set(themes).size, themes.length, `${row.id}: repeated theme`);
      assert.deepEqual([...themes].sort(), [...row.axes.theme].sort(), `${row.id}: lost theme`);
    }
  }
  assert.deepEqual(shards[3].find((row) => row.id === 'render.library.hangOrder').axes.theme, ['default']);
  assert.deepEqual(shards[1].find((row) => row.id === 'render.library.hangOrder').axes.theme, ['terminal']);
  assert.equal(full.filter((row) => row.type === 'paint').length, 3);
  assert.equal(full.find((row) => row.id === 'render.popup.paint').axes.theme.length, THEMES.length);
});
