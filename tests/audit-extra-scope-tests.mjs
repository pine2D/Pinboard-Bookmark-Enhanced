import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { auditSelection } from '../scripts/audit-scope.mjs';
import { SITE_SCENARIOS, SITE_FIXTURES, SITE_VARIANTS, siteVariants } from '../scripts/audit-site-scenarios.mjs';
import { HELP_SCENARIOS, HELP_ROLES } from '../scripts/audit-help-scenarios.mjs';

test('site metadata covers every independent native fixture', () => {
  const html = readFileSync(new URL('./fixtures/pinboard-theme-pages.html', import.meta.url), 'utf8');
  const fixtures = [...html.matchAll(/<template id="([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual([...SITE_FIXTURES].sort(), fixtures);
  assert.equal(SITE_SCENARIOS.length, new Set(SITE_SCENARIOS.map(s => s.id)).size);
});
test('site theme and scheme intersect without inventing a light Terminal', () => {
  const scope = auditSelection({ runner: 'site', scenarios: SITE_SCENARIOS, argv: ['--audit-scenario=site.tag-cloud', '--audit-theme=terminal', '--audit-scheme=light'] });
  assert.deepEqual(siteVariants(scope, 'site.tag-cloud'), []);
  const all = auditSelection({ runner: 'site', scenarios: SITE_SCENARIOS, argv: [] });
  assert.deepEqual(siteVariants(all, 'site.tag-cloud'), SITE_VARIANTS);
});
test('options help can select a role, language and exact DPR', () => {
  const scope = auditSelection({ runner: 'help', scenarios: HELP_SCENARIOS, argv: ['--audit-scenario=help.options.field', '--audit-locale=en', '--audit-dpr=1.25'] });
  assert.deepEqual(scope.selected.map(r => r.role), ['field']);
  assert.deepEqual(scope.values('help.options.field', 'dpr', [1, 1.25, 2]), [1.25]);
  assert.equal(HELP_SCENARIOS.length, HELP_ROLES.length);
});
test('real runner plan commands select exactly one scene without browser initialization', () => {
  for (const [file, id] of [['../scripts/options-help-render-audit.mjs', 'help.options.field'], ['./pinboard-theme-render-tests.mjs', 'site.tag-cloud']]) {
    const result = spawnSync(process.execPath, [new URL(file, import.meta.url).pathname, '--audit-plan', '--audit-scenario=' + id], { encoding: 'utf8', env: { ...process.env, FONTCONFIG_FILE: '/intentionally-invalid-before-browser.conf' } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).scenarios.map(r => r.id), [id]);
  }
});
