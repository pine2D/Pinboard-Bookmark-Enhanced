import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const SITE_THEMES = vm.runInNewContext(readFileSync(new URL('../pinboard-themes.js', import.meta.url), 'utf8') + '; PINBOARD_THEMES');
const darkNames = new Set(['nord-night', 'terminal', 'dracula', 'flexoki:dark', 'solarized-dark', 'catppuccin-mocha', 'gruvbox-dark', 'rose-pine']);
export const SITE_VARIANTS = [
  ...Object.entries(SITE_THEMES).map(([key, { css }]) => ({ key, css, dark: false, scheme: darkNames.has(key) ? 'dark' : 'light' })),
  { key: 'flexoki:dark', css: SITE_THEMES.flexoki.css, dark: true, scheme: 'dark' },
];
export const SITE_FIXTURES = Object.freeze([
  'note', 'help', 'howto', 'editor', 'status', 'token', 'nav', 'completion', 'bulk',
  'search-sidebar', 'search-tweets', 'bookmarks', 'subscriptions', 'bundles', 'tag-nav',
  'tag-list', 'tag-cloud', 'sidebar-tag-frequency', 'bundle-editor', 'bundle-density',
  'import-layout', 'toc-layout', 'profile-layout', 'widget', 'blog-sidebar',
]);
export const SITE_WIDTHS = Object.freeze({
  'bundle-editor': [390, 768, 1440], 'import-layout': [390, 641, 768, 1024, 1080, 1440],
  'toc-layout': [390, 641, 768, 1024, 1080, 1440], 'profile-layout': [320, 390, 640, 641, 768, 1440],
});
export const SITE_SCENARIOS = SITE_FIXTURES.map(fixture => ({
  id: 'site.' + fixture, runner: 'site', fixture, surfaces: ['pinboard'],
  features: ['theme', fixture, ...(fixture.includes('tag') ? ['tags'] : [])],
  kinds: SITE_WIDTHS[fixture] || ['tag-list', 'tag-cloud', 'bundle-density'].includes(fixture) ? ['layout', 'contrast'] : ['contrast'],
  files: ['pinboard-themes.js', 'pinboard-style.js', 'docs/theme-surface/pilots/*.tokens.json', 'tests/fixtures/pinboard-theme-pages.html'],
  dependencies: [], axes: { theme: SITE_VARIANTS.map(v => v.key), scheme: ['light', 'dark'], font: ['native'], viewport: SITE_WIDTHS[fixture] || [1440] },
}));
export function siteVariants(audit, id) {
  const themes = audit.values(id, 'theme', SITE_VARIANTS.map(v => v.key));
  const schemes = audit.values(id, 'scheme', ['light', 'dark']);
  return SITE_VARIANTS.filter(v => themes.includes(v.key) && schemes.includes(v.scheme));
}
