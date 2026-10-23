import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const catalog = await import('../scripts/audit-qa-scenarios.mjs').catch(() => null);

test('QA selection dispatches only the requested options panel and preserves the scenario identity', async () => {
  assert.ok(catalog, 'QA must expose its actual scenario dispatcher without starting Chromium');
  const calls = [];
  const selection = {
    selected: catalog.QA_SCENARIOS.filter(row => row.id === 'qa.options.panel.ai'),
    start: id => calls.push(['start', id]),
    complete: id => calls.push(['complete', id]),
  };
  await catalog.runQaScenarios(selection, { options: async row => calls.push(['options', row.step]) });
  assert.deepEqual(calls, [['start', 'qa.options.panel.ai'], ['options', 'ai'], ['complete', 'qa.options.panel.ai']]);
});

test('mixed drivers route independently selected popup login and reader Ask layout', async () => {
  assert.ok(catalog);
  const calls = [];
  const selection = { selected: catalog.QA_SCENARIOS.filter(row => ['qa.popup.login', 'qa.reader.layout.ask'].includes(row.id)), start() {}, complete() {} };
  await catalog.runQaScenarios(selection, { layouts: async row => calls.push(row.step) });
  assert.deepEqual(calls.sort(), ['popup-login', 'reader-ask']);
});

test('a failed driver cannot be reported as completed coverage', async () => {
  assert.ok(catalog);
  const completed = [];
  const selection = { selected: catalog.QA_SCENARIOS.filter(row => row.id === 'qa.popup.drafts'), start() {}, complete: id => completed.push(id) };
  await assert.rejects(catalog.runQaScenarios(selection, { drafts: async () => { throw new Error('browser failed'); } }), /browser failed/);
  assert.deepEqual(completed, []);
});

test('matrix metadata does not claim axes that its runner never applies', () => {
  assert.ok(catalog);
  const row = id => catalog.QA_SCENARIOS.find(item => item.id === id);
  assert.deepEqual(row('qa.options.layout.ai').axes.viewport, ['320', '420']);
  assert.deepEqual(row('qa.reader.layout.ask').axes.viewport, ['880', '1000', '1001', '1024', '1100', '1199', '1200', '1280', '1440']);
  assert.equal(row('qa.popup.drafts').axes.locale, undefined);
  assert.equal(row('qa.themes.reader').axes.theme, undefined);
  assert.deepEqual(row('qa.options.save-failure').axes.density, ['comfortable', 'compact']);
  assert.deepEqual(row('qa.options.panel.ai').axes.font, ['native', 'ci']);
});

test('fixed themes only schedule their real scheme and reject incompatible requests', () => {
  assert.equal(typeof catalog.qaThemeCases, 'function');
  const scenario = catalog.QA_SCENARIOS.find(row => row.id === 'qa.themes.options');
  assert.throws(() => catalog.qaThemeCases(scenario, { theme: ['dracula'], scheme: ['light'] }), /Invalid theme\/scheme combination/);
  assert.deepEqual(catalog.qaThemeCases(scenario, { theme: ['dracula', 'modern-card'], scheme: ['light'] }), [{ theme: 'modern-card', scheme: 'light' }]);
  assert.deepEqual(catalog.qaThemeCases(scenario, { theme: ['flexoki'], scheme: ['light', 'dark'] }), [{ theme: 'flexoki', scheme: 'light' }, { theme: 'flexoki', scheme: 'dark' }]);
});

test('explicit 320px controls axes cover every requested locale without dropping English', () => {
  assert.equal(typeof catalog.qaExpectedCases, 'function');
  const scenario = catalog.QA_SCENARIOS.find(row => row.id === 'qa.reader.controls.ask');
  assert.deepEqual(catalog.qaExpectedCases(scenario, { locale: ['en', 'zh_CN'], viewport: ['320'], scheme: ['dark'], density: ['large'] }), [
    { font: 'native', dpr: 1, locale: 'en', viewport: 320, scheme: 'dark', density: 'large' },
    { font: 'native', dpr: 1, locale: 'zh_CN', viewport: 320, scheme: 'dark', density: 'large' },
  ]);
});

test('missing matrix tuples cannot be reported as complete scenario coverage', () => {
  assert.equal(typeof catalog.assertQaCases, 'function');
  assert.throws(() => catalog.assertQaCases([{ locale: 'en', viewport: 320 }, { locale: 'zh_CN', viewport: 320 }], [{ locale: 'zh_CN', viewport: 320 }]), /Missing QA matrix cases/);
  assert.throws(() => catalog.assertQaCases([{ locale: 'en', viewport: 320 }], [{ locale: 'en', viewport: 320 }, { locale: 'en', viewport: 320 }]), /Duplicate QA matrix cases/);
});

test('a requested CI font cannot silently run with the native font environment', () => {
  const env = { ...process.env };
  delete env.FONTCONFIG_FILE;
  const result = spawnSync(process.execPath, [qaScript, '--audit-scenario=qa.options.panel.ai', '--audit-font=ci'], { encoding: 'utf8', env });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /font environment mismatch/);
  assert.doesNotMatch(result.stdout, /phase 1|AI mock/);
});

const qaScript = fileURLToPath(new URL('../scripts/qa-drive.mjs', import.meta.url));
test('QA planning selects a panel before font or browser initialization', () => {
  const result = spawnSync(process.execPath, [qaScript, '--audit-scenario=qa.options.panel.ai', '--audit-plan'], {
    encoding: 'utf8', env: { ...process.env, FONTCONFIG_FILE: '/qa-plan-must-not-read-fontconfig.conf' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).scenarios.map(row => row.id), ['qa.options.panel.ai']);
});

test('unsupported axis combinations and misspelled legacy surfaces fail before a run', () => {
  for (const args of [
    ['--audit-scenario=qa.popup.drafts', '--audit-locale=de', '--audit-plan'],
    ['--audit-scenario=qa.themes.reader', '--audit-theme=dracula', '--audit-plan'],
    ['--surfaces', 'optinos'],
    ['--surfaces=optinos', '--audit-plan'],
    ['--surfaces=', '--audit-plan'],
  ]) {
    const result = spawnSync(process.execPath, [qaScript, ...args], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No scenarios match|Unknown --surfaces/);
    assert.doesNotMatch(result.stdout, /phase 1|AI mock/);
  }
  const incompatible = spawnSync(process.execPath, [qaScript, '--audit-scenario=qa.themes.options', '--audit-theme=dracula', '--audit-scheme=light', '--audit-plan'], { encoding: 'utf8' });
  assert.ifError(incompatible.error);
  assert.notEqual(incompatible.status, 0);
  assert.match(incompatible.stderr, /Invalid theme\/scheme combination/);
  assert.doesNotMatch(incompatible.stdout, /phase 1|AI mock/);
});
