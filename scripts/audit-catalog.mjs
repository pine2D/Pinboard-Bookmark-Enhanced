// One catalog for planning and execution. Runtime assertions remain in their
// existing, independent test files; this layer only assigns ownership/inputs.
import { readdirSync } from 'node:fs';
import { RENDER_SCENARIOS } from './audit-render-scenarios.mjs';
import { QA_SCENARIOS } from './audit-qa-scenarios.mjs';
import { SITE_SCENARIOS } from './audit-site-scenarios.mjs';
import { HELP_SCENARIOS } from './audit-help-scenarios.mjs';

export const AUDIT_SURFACES = Object.freeze(['popup', 'options', 'library', 'md-preview', 'pinboard', 'background', 'tooling']);
const ui = ['popup', 'options', 'library', 'md-preview'];
function ownership(name) {
  if (name === 'tag-gov-layout') return ['options'];
  if (name === 'save-pipeline') return ['background', 'popup', 'md-preview'];
  if (['icon-state', 'wayback', 'url-strip'].includes(name)) return ['background'];
  if (/^audit-|^ui-contract-scan/.test(name)) return ['tooling'];
  if (/^popup-|^ai-tags|^tag-gov|^union-tags|^offline-queue|^batch-/.test(name)) return ['popup'];
  if (/^options-|^settings-/.test(name)) return ['options'];
  if (/^library-/.test(name)) return ['library'];
  if (/^md-|^reader-|^bili-|^frame-|^dict-/.test(name)) return ['md-preview'];
  if (/^pinboard-/.test(name)) return ['pinboard'];
  if (/^theme-/.test(name)) return ['popup', 'options', 'library', 'pinboard'];
  if (/^ui-|^i18n-|^a11y|^contrast|^escape-html/.test(name)) return ui;
  if (/^vocab-|^notes-|^drive-|^anki-|^eudic-/.test(name)) return ['background', 'library', 'options', 'md-preview'];
  if (/^ai-|^export-|^jina-/.test(name)) return ['background', 'popup', 'options', 'md-preview'];
  if (/^background-/.test(name)) return ['background'];
  throw new Error(`Audit suite has no surface owner: ${name}; register it in audit-catalog.mjs`);
}
function features(name) {
  const out = name.split('-');
  for (const [pattern, feature] of [[/bookmark|save|draft/, 'bookmark'], [/ask|ai-/, 'ai'], [/dict|vocab/, 'vocabulary'], [/notes|highlight/, 'notes'], [/tags|tag-/, 'tags'], [/gdrive|sync/, 'sync'], [/auth|account|save-pipeline/, 'account']]) {
    if (pattern.test(name)) out.push(feature);
  }
  return [...new Set(out)];
}
const sourcePatterns = {
  popup: ['popup*.js', 'popup.html', 'popup.css'], options: ['options*.js', 'options.html', 'options.css'],
  library: ['library*.js', 'library.html', 'library.css'], 'md-preview': ['md-*.js', 'md-preview.html', 'md-preview.css'],
  pinboard: ['pinboard-*.js'], background: ['background.js', 'shared.js', 'manifest.json'],
  tooling: ['scripts/audit*.mjs', 'tests/audit*-tests.mjs'],
};
const testFiles = readdirSync(new URL('../tests/', import.meta.url)).filter(name => /-tests\.(?:html|mjs)$/.test(name));
export const TEST_SCENARIOS = testFiles.filter(name => name !== 'pinboard-theme-render-tests.mjs').map(name => {
  const base = name.replace(/-tests\.(html|mjs)$/, '');
  const surfaces = ownership(base);
  const file = 'tests/' + name;
  return {
    id: 'test.' + base, runner: name.endsWith('.html') ? 'html' : 'node', file,
    surfaces, features: features(base), kinds: base === 'popup-label-fit' ? ['layout', 'i18n'] : [name.endsWith('.html') ? 'logic' : 'contract'],
    browser: base === 'popup-label-fit',
    files: [file, base + '.js', ...surfaces.flatMap(s => sourcePatterns[s] || []), ...(base.startsWith('theme-') ? ['docs/theme-surface/**'] : [])],
    dependencies: [], axes: {},
  };
});
const staticRow = (id, file, surfaces, inputs, kinds = ['contract'], args = []) => ({
  id: 'static.' + id, runner: 'node', file, args, surfaces, features: [id], kinds, files: [file, ...inputs], dependencies: [], axes: {},
});
export const STATIC_SCENARIOS = [
  staticRow('script-graph', 'scripts/script-graph-lint.mjs', ['background', ...ui], ['*.js'], ['syntax', 'security']),
  staticRow('ui-vocabulary', 'scripts/ui-vocabulary-lint.mjs', ui, ['*.html', '*.js', 'docs/theme-surface/ui-vocabulary.json']),
  staticRow('layout', 'docs/theme-surface/tools/layout-lint.mjs', ui, ['*.html', '*.css'], ['layout', 'contract']),
  staticRow('network-exits', 'scripts/network-exits-check.mjs', ['background'], ['manifest.json', 'docs/network-exits.json', 'docs/privacy.md', '*.js'], ['security']),
  staticRow('vendor-lock', 'scripts/vendor-lock-check.mjs', ['tooling'], ['vendor/**']),
  staticRow('docs', 'scripts/docs-lint.mjs', ['tooling'], ['README*.md', 'CLAUDE.md', 'docs/index.md', 'docs/privacy.md'], ['docs']),
  staticRow('store-copy', 'scripts/sync-store-descriptions.mjs', ['tooling'], ['README*.md', 'docs/cws-assets/**'], ['docs'], ['--check']),
  staticRow('theme-sync', 'docs/theme-surface/tools/sync-all.mjs', ['popup', 'options', 'library', 'pinboard'], ['docs/theme-surface/**', 'pinboard-themes.js', 'popup.css', 'options.css', 'library.css'], ['generation'], ['--check']),
  ...['token-coverage', 'cascade-lint', 'override-drift', 'handedit-audit'].map(name => staticRow(name, `docs/theme-surface/tools/${name}.mjs`, ['popup', 'options', 'library', 'pinboard'], ['docs/theme-surface/**', 'pinboard-themes.js'], ['generation'])),
];
export function getAuditCatalog() {
  const inputs = {
    render: ['scripts/ui-render-audit.mjs', 'scripts/audit-render-scenarios.mjs', 'tests/render-audit-checklist.mjs'],
    qa: ['scripts/qa-drive.mjs', 'scripts/audit-qa-scenarios.mjs'],
    site: ['tests/pinboard-theme-render-tests.mjs', 'scripts/audit-site-scenarios.mjs'],
    help: ['scripts/options-help-render-audit.mjs', 'scripts/audit-help-scenarios.mjs'],
  };
  return [...RENDER_SCENARIOS, ...QA_SCENARIOS, ...SITE_SCENARIOS, ...HELP_SCENARIOS, ...TEST_SCENARIOS, ...STATIC_SCENARIOS].map(row => ({ ...row,
    files: [...row.files, ...(inputs[row.runner] || []), 'scripts/audit-scope.mjs', 'scripts/audit-plan.mjs', 'scripts/audit.mjs'],
  }));
}
