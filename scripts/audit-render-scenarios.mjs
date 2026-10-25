// Execution metadata only. Assertions stay in the independent, hand-written oracle.
import { CHECKS, THEMES, MEDIA_CHECKS, MEDIA_SCENARIOS, MEDIA_THEMES } from '../tests/render-audit-checklist.mjs';

export const RENDER_DARK_THEMES = new Set([
  'nord-night', 'terminal', 'dracula', 'flexoki-dark',
  'solarized-dark', 'catppuccin-mocha', 'gruvbox-dark', 'rose-pine',
]);
export const renderScheme = (theme) => RENDER_DARK_THEMES.has(theme) ? 'dark' : 'light';
export const checkScenarioId = (check) => `render.${check.surface}.${check.state || 'default'}`;
export const sweepScenarioId = (surface, name) => `render.${surface}.sweep.${name}`;
export const paintScenarioId = (surface) => `render.${surface}.paint`;
export const mediaScenarioId = (surface, name) => `render.${surface}.media.${name}`;

export function popupCheckSetup(checks, { paint = false } = {}) {
  return { form: paint || checks.length > 0, chips: paint || checks.some((check) => check.selector.startsWith('.stag')) };
}

export const RENDER_OPTIONS_TABS = Object.freeze([
  'tab-general', 'tab-popup', 'tab-bookmarks', 'tab-quick', 'tab-ai', 'tab-ai-behavior',
  'tab-reader', 'tab-vocab', 'tab-markdown', 'tab-tags', 'tab-archive', 'tab-appearance', 'tab-storage',
]);
export const RENDER_READER_CONTEXTS = Object.freeze([
  'reader-source-details', 'export-more', 'reader-bookmark-footer', 'reader-bookmark-editor', 'reader-bookmark-delete-confirm',
  'explain-pop', 'explain-dict', 'dict-entry-idle', 'dict-entry-busy', 'dict-entry-result', 'dict-entry-details', 'dict-entry-cached', 'dict-entry-error', 'ask-panel', 'search-pop', 'kbd-help-pop', 'typo-pop',
  'pb-hl-card', 'send-menu', 'confirm-popover', 'tr-ask',
]);
const context = (name, dependencies = [], extra = {}) => ({ name, dependencies, ...extra });
export const RENDER_SWEEP_CONTEXTS = Object.freeze({
  options: [...RENDER_OPTIONS_TABS.map((name) => context(name, [], { target: `#panel-${name.slice(4)}.active` })),
    context('vocab-pack-preview', [], { target: '#multi-pack-preview:not([hidden])' }),
    context('vocab-pack-installed', ['vocab-pack-preview'], { target: '#multi-pack-list button[data-pack-action]' }),
    context('save-failure', [], { target: '#auto-save-retry' })],
  library: [
    context('vocab-list', [], { target: '#vocab-list .vocab-card' }),
    context('vocab-filter-set', [], { target: '#vocab-filter-set:popover-open' }),
    context('vocab-listbox-open', [], { target: '#vocab-group-filter-list .listbox-opt' }),
    context('vocab-export-menu', [], { target: '.vocab-export-menu:popover-open' }),
    context('vocab-detail', [], { target: '#vocab-detail:not([hidden])' }),
    context('dict-entry-idle', [], { target: '.xp-dict-ai-generate:not([disabled])' }),
    context('dict-entry-busy', ['dict-entry-idle'], { target: '.xp-dict-ai-stop:not([hidden])' }),
    context('dict-entry-result', ['dict-entry-busy'], { target: '.xp-dict-ai-content:not([hidden])' }),
    context('dict-entry-details', ['dict-entry-result'], { target: '.xp-dict-ai-details[open]' }),
    context('dict-entry-cached', ['dict-entry-result'], { target: '.xp-dict-ai-content:not([hidden])' }),
    context('dict-entry-error', ['dict-entry-idle'], { target: '.xp-dict-ai-status:not([hidden])' }),
    context('vocab-batch-bar', ['vocab-detail'], { target: '#vocab-batch-toolbar.selecting' }),
    context('ask-history-list', [], { target: '#ask-library-list .ask-library-hit' }),
    context('ask-history-detail', ['ask-history-list'], { target: '#ask-library-detail:not([hidden])' }),
    context('ask-history-evidence', ['ask-history-detail'], { target: '.ask-library-round .ask-library-evidence[open]' }),
    context('ask-history-versions', ['ask-history-detail'], { target: '#ask-library-detail > .ask-library-evidence[open]' }),
    context('ask-history-delete', ['ask-history-detail'], { target: '.confirm-popover' }),
    context('notes-list', [], { target: '#notes-list .notes-hit' }),
    context('notes-detail', [], { target: '#notes-detail:not([hidden])' }),
    context('notes-color-menu', ['notes-detail'], { target: '.notes-color-menu:popover-open' }),
    context('notes-batch-bar', ['notes-detail'], { target: '#notes-batch-toolbar.selecting' }),
  ],
  'md-preview': [context('reader', [], { target: '#rendered-view' }), ...RENDER_READER_CONTEXTS.map((name) => context(name,
    name === 'explain-dict' ? ['explain-pop'] : name === 'dict-entry-busy' ? ['dict-entry-idle'] : name === 'dict-entry-result' ? ['dict-entry-busy'] : ['dict-entry-details', 'dict-entry-cached'].includes(name) ? ['dict-entry-result'] : name === 'dict-entry-error' ? ['dict-entry-idle'] : [])), context('video', [], { target: '.pbv-bar' })],
  popup: [context('light', [], { target: '#main-section' }), context('states', [], { target: '.offline-queue-item' }),
    context('form', [], { target: '#url-input' }), context('dpi', [], { dpr: [1.5, 2] }),
    context('dark', [], { theme: 'flexoki-dark', scheme: 'dark', target: '#main-section' }),
    context('login', [], { target: '#login-section' })],
});

function files(surface) {
  return [`${surface}.html`, `${surface}.css`, `${surface}.js`, ...(surface === 'md-preview' ? ['md-*.js'] : surface === 'library' ? ['library-*.js', 'scripts/audit-ask-history-fixture.mjs'] : [])];
}
function row(id, surface, themes, extra) {
  return { id, runner: 'render', surfaces: [surface], files: files(surface), dependencies: [],
    axes: { theme: themes.map((t) => t || 'default'), scheme: [...new Set(themes.map(renderScheme))] }, ...extra };
}

const groups = new Map();
for (const check of CHECKS) {
  const id = checkScenarioId(check);
  if (!groups.has(id)) groups.set(id, []);
  groups.get(id).push(check);
}
const PAINT_KEYS = new Set(['textContrast', 'textContrastMulti', 'iconContrast', 'backgroundAlphaMax',
  'bgEqVar', 'bgChangedFromRest', 'colorEqVar', 'borderColorEqVar', 'borderSidesEqVar', 'colorSchemeMatchesTheme']);

export const RENDER_SCENARIOS = Object.freeze([
  ...[...groups].map(([id, checks]) => {
    const themes = THEMES.filter((theme) => checks.some((check) => !check.themes || check.themes.includes(theme)));
    const keys = checks.flatMap((check) => Object.keys(check.expect || {}));
    return row(id, checks[0].surface, themes, {
      type: 'checks', state: checks[0].state || 'default',
      axes: { theme: themes.map((t) => t || 'default'), scheme: [...new Set(themes.map(renderScheme))], state: [checks[0].state || 'default'] },
      features: [...new Set([checks[0].surface, checks[0].state || 'default', ...checks.map((c) => c.tab).filter(Boolean)])],
      kinds: [...new Set(keys.map((key) => PAINT_KEYS.has(key) ? 'contrast' : 'layout'))],
    });
  }),
  ...['popup', 'options', 'library'].map((surface) => row(paintScenarioId(surface), surface, THEMES, {
    type: 'paint', features: ['fields', 'weak-text'], kinds: ['contrast'],
  })),
  ...MEDIA_CHECKS.flatMap(({ surface }) => MEDIA_SCENARIOS.map(({ id }) => row(mediaScenarioId(surface, id), surface, MEDIA_THEMES, {
    type: 'media', features: [id], kinds: ['contrast', 'media'],
  }))),
  ...Object.entries(RENDER_SWEEP_CONTEXTS).flatMap(([surface, contexts]) => contexts.map((item) => {
    const themes = [item.theme || ''];
    const axes = surface === 'md-preview' ? { scheme: ['light', 'dark'] }
      : { theme: themes.map((t) => t || 'default'), scheme: [item.scheme || 'light'] };
    if (item.dpr) axes.dpr = item.dpr;
    return row(sweepScenarioId(surface, item.name), surface, themes, {
      type: 'sweep', context: item.name,
      ...(item.name.startsWith('vocab-pack-') ? { files: [...files(surface), 'options-vocab.js', 'dict-pack.js', 'scripts/audit-vocab-pack-fixture.mjs'] } : {}),
      ...(/^dict-entry-/.test(item.name) ? { files: [...files(surface), 'md-dict.js', 'dict-entry.js', 'ai.js', 'ai-cache.js', 'library-vocab.js', 'scripts/audit-dict-entry-fixture.mjs'] } : {}),
      features: [...new Set([item.name, item.name.replace(/^tab-/, ''), surface, ...(/^dict-entry-/.test(item.name) ? ['dictionary', 'dictionary-entry'] : [])])], kinds: ['layout'], axes: { ...axes, state: [item.name] },
      defaults: surface === 'md-preview' ? { scheme: ['light'] } : {},
      dependencies: item.dependencies.map((name) => sweepScenarioId(surface, name)),
    });
  })),
].map((entry) => ({ ...entry, axes: { ...entry.axes, font: ['native', 'ci'] } })));

export function renderThemes(audit, id, defaults = THEMES) {
  if (!audit.has(id)) return [];
  const row = (audit.selected || RENDER_SCENARIOS).find((entry) => entry.id === id);
  const themes = audit.values(id, 'theme', defaults.map((theme) => theme || 'default').filter((name) => row.axes.theme.includes(name)));
  const schemes = audit.values(id, 'scheme', row.axes.scheme);
  return defaults.filter((theme) => themes.includes(theme || 'default') && schemes.includes(renderScheme(theme)));
}

// The same dependency order is consumed by the runner and its pre-browser plan.
export function renderSweepPlan(surface, names) {
  const contexts = RENDER_SWEEP_CONTEXTS[surface];
  if (!contexts) throw new Error(`unknown render surface: ${surface}`);
  const selected = new Set();
  function add(name) {
    const item = contexts.find((entry) => entry.name === name);
    if (!item) throw new Error(`unknown render context: ${surface}/${name}`);
    if (selected.has(name)) return;
    for (const dependency of item.dependencies) add(dependency);
    selected.add(name);
  }
  for (const name of names) add(name);
  return [...selected];
}

export async function runRenderScenario(audit, id, open, measure) {
  audit.start(id);
  const opened = await open();
  if (opened !== true) throw new Error(`SETUP: ${id} did not open (${opened || 'opener returned false'})`);
  const result = await measure();
  audit.complete(id);
  return result;
}
