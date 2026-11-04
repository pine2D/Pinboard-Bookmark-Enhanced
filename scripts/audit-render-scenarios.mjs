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
  'reader-source-details', 'export-more', 'reader-bookmark-footer', 'reader-bookmark-editor', 'reader-bookmark-title-error', 'reader-bookmark-quote-error', 'reader-bookmark-sharing', 'reader-bookmark-delete-confirm',
  'explain-pop', 'explain-dict', 'dict-resize-menu', 'dict-entry-idle', 'dict-entry-busy', 'dict-entry-progress', 'dict-entry-result', 'dict-entry-details',
  'dict-entry-usage-busy', 'dict-entry-usage-error', 'dict-entry-usage-result',
  'dict-entry-panel', 'dict-entry-cached', 'dict-entry-folded', 'dict-entry-revealed', 'dict-entry-error', 'dict-entry-examples', 'dict-entry-negative', 'dict-entry-legacy', 'dict-save-bar', 'dict-save-change-menu', 'dict-save-saved', 'dict-entry-paid-negative', 'ask-panel', 'ask-clear-confirm', 'search-pop', 'kbd-help-pop', 'typo-pop',
  'pb-hl-card', 'send-menu', 'confirm-popover', 'tr-ask',
]);
const context = (name, dependencies = [], extra = {}) => ({ name, dependencies, ...extra });
// The remembered paid learning actions (plan 3.3, ruling 2026-10-28) must stay
// one control-rung line in every UI language they are written for: CJK, long
// Latin and Cyrillic labels. The state runs once per locale (--locale picks).
export const DICT_PAID_NEGATIVE_LOCALES = Object.freeze(['en', 'zh_CN', 'de', 'ru', 'pl', 'ja']);
const DICT_PAID_NEGATIVE_TARGET = '[data-learning-block="etymology"] .xp-dict-supplement-generate[data-remembered="true"]';
// The library states that show the sticky save bar and paid buttons run at a
// phone and a desktop width (batch-3 review, task 3b.2): the save bar must sit
// on the detail scroller's visible bottom and the back bar on its top, and a
// paid button's model note must stay on one line, at both. --viewport picks.
export const DICT_STICKY_VIEWPORTS = Object.freeze(['360', '1280']);
const sticky = { viewports: DICT_STICKY_VIEWPORTS };
// The library save bar's Save label wraps inside the button below 440px; the
// longest labels are German and French (batch-3b review, 16-save-bar-b), so
// the state runs once per locale (--locale picks).
export const DICT_SAVE_BAR_LOCALES = Object.freeze(['en', 'de', 'fr']);
export const READER_BOOKMARK_QUOTE_LOCALES = Object.freeze(['en', 'de', 'fr', 'ja', 'pl', 'ru', 'zh_CN', 'zh_HK', 'zh_TW']);
export const RENDER_SWEEP_CONTEXTS = Object.freeze({
  options: [...RENDER_OPTIONS_TABS.map((name) => context(name, [], { target: `#panel-${name.slice(4)}.active` })),
    // Leftover entity codes in tags: the list exists only after Scan.
    context('tag-gov-entity-scan', [], { target: '#tag-gov-entity-list .tag-gov-entity-checkbox' }),
    context('tag-gov-entity-deselected', ['tag-gov-entity-scan'], { target: '.tag-gov-entity-checkbox:not(:checked)' }),
    context('tag-gov-entity-partial', ['tag-gov-entity-scan'], { target: '#tag-gov-entity-status.bad' }),
    context('vocab-pack-preview', [], { target: '#multi-pack-preview:not([hidden])' }),
    context('vocab-pack-installed', ['vocab-pack-preview'], { target: '#multi-pack-list button[data-pack-action]' }),
    context('vocab-pack-delete-confirm', ['vocab-pack-installed'], { target: '.confirm-popover .confirm-subject' }),
    context('save-failure', [], { target: '#auto-save-retry' }),
    // Access gateway of the self-hosted bookmark services (hidden until the
    // service radio and the gateway type are chosen).
    context('bookmark-karakeep-cloudflare', [], { target: '#karakeep-gateway-cloudflare:not([hidden]) #opt-karakeep-cf-secret' }),
    context('bookmark-karakeep-custom', [], { target: '#karakeep-gateway-custom:not([hidden]) #opt-karakeep-gw-value-4' }),
    context('bookmark-linkding-cloudflare', [], { target: '#linkding-gateway-cloudflare:not([hidden]) #opt-linkding-cf-secret' }),
    context('bookmark-linkding-custom', [], { target: '#linkding-gateway-custom:not([hidden]) #opt-linkding-gw-value-4' }),
    context('bookmark-gateway-pending', ['bookmark-linkding-cloudflare'], { target: '#linkding-connect-pending:not([hidden])' }),
    // A connected linkding shows Disconnect beside Connect; its confirm is the
    // anchored popover. With a self-hosted service chosen the Bookmarks panel
    // hides the Pinboard-only Private rows (the first rows of its group).
    context('bookmark-linkding-connected', [], { target: '#disconnect-linkding:not([hidden])' }),
    context('bookmark-disconnect-confirm', ['bookmark-linkding-connected'], { target: '.confirm-popover .confirm-msg' }),
    context('bookmarks-selfhosted', ['bookmark-linkding-connected'], { target: '#panel-bookmarks.active #opt-readlater-default' }),
    context('ai-qwen-fields', [], { target: '#fields-qwen:not([hidden]) #opt-qwen-region-btn' }),
    context('ai-qwen-workspace-warn', ['ai-qwen-fields'], { target: '#qwen-workspace-warn:not([hidden])' }),
    context('ai-provider-ark', [], { target: '#fields-ark:not([hidden]) #opt-ark-region-btn' }),
    context('ai-provider-opencode', [], { target: '#fields-opencode:not([hidden]) #opt-opencode-protocol-btn' }),
    // Custom AI provider entries share one panel; the driver seeds eight.
    context('ai-custom-entry', [], { target: '#fields-custom:not([hidden]) #opt-custom-name' }),
    context('ai-custom-limit', ['ai-custom-entry'], { target: '#ai-custom-limit-hint:not([hidden])' }),
    context('ai-custom-key-rebind', ['ai-custom-entry'], { target: '#ai-custom-key-rebind:not([hidden])' }),
    context('ai-custom-key-pending', ['ai-custom-entry'], { target: '#ai-custom-key-pending:not([hidden])' }),
    context('ai-custom-delete-confirm', ['ai-custom-entry'], { target: '.confirm-popover .confirm-subject' })],
  library: [
    context('vocab-list', [], { target: '#vocab-list .vocab-card' }),
    context('vocab-filter-set', [], { target: '#vocab-filter-set:popover-open' }),
    context('vocab-listbox-open', [], { target: '#vocab-group-filter-list .listbox-opt' }),
    context('vocab-export-menu', [], { target: '.vocab-export-menu:popover-open' }),
    context('vocab-detail', [], { target: '#vocab-detail:not([hidden])' }),
    context('dict-entry-idle', [], { target: '.xp-dict-ai-generate:not([disabled])' }),
    // The first entry generation reports in the panel's progress line with
    // its own cancel (plan 2.6); progress then drives the stream phases and
    // waits for the seconds waited.
    context('dict-entry-busy', ['dict-entry-idle'], { target: '.xp-dict-ai > .xp-dict-usage-feedback[data-state="busy"] .xp-dict-usage-stop' }),
    context('dict-entry-progress', ['dict-entry-busy'], { target: '.xp-dict-ai > .xp-dict-usage-feedback[data-state="busy"] .xp-dict-usage-elapsed:not([hidden])' }),
    context('dict-entry-result', ['dict-entry-busy'], { target: '.xp-dict-ai-content:not([hidden])', ...sticky }),
    context('dict-entry-details', ['dict-entry-result'], { target: '.xp-dict-ai-details[data-supplement-id][open]' }),
    context('dict-entry-usage-busy', ['dict-entry-result'], { target: '.xp-dict-usage-feedback[data-state="busy"]' }),
    context('dict-entry-usage-error', ['dict-entry-usage-busy'], { target: '.xp-dict-usage-actions > .xp-dict-action-error' }),
    context('dict-entry-usage-result', ['dict-entry-usage-error'], { target: '[data-learning-block="usage"] .xp-dict-usage-feedback[data-state="saved"]', ...sticky }),
    context('dict-entry-cached', ['dict-entry-result'], { target: '.xp-dict-ai-content:not([hidden])' }),
    // dictDefaultView "dictionary" (Q14=A, plan 3.1): the saved entry the
    // result state archived folds into one free reveal line; opening it shows
    // the entry and focuses its title.
    context('dict-entry-folded', ['dict-entry-result'], { target: '.xp-dict-ai-reveal:not([hidden])' }),
    context('dict-entry-revealed', ['dict-entry-folded'], { target: '.xp-dict-ai-title:not([hidden])' }),
    context('dict-entry-error', ['dict-entry-idle'], { target: '.xp-dict-ai-controls > .xp-dict-ai-generate + .xp-dict-action-error' }),
    // Free original-text examples (plan 1C.2): its fixture has no AI key and
    // no AI entry, so it depends on no AI state.
    context('dict-entry-examples', [], { target: '.xp-dict-examples .xp-dict-learning-item' }),
    // The remembered empty result (plan 1C.4) of the same free block: a real
    // clean miss writes the local memory, the next lookup reads it back.
    context('dict-entry-negative', [], { target: '.xp-dict-examples .xp-dict-examples-find[data-remembered="true"]' }),
    // Old literature, culture and topic collocations records (plan 1B.7,
    // 1C.3), seeded into the production archive: no AI state is needed.
    context('dict-entry-legacy', [], { target: '.xp-dict-ai-details[data-supplement-category="literature"][open]' }),
    // The sticky save bar (dict redesign 3.2): the meaning listbox beside
    // Save, then its choice list opened by click.
    context('dict-save-bar', [], { target: '.vocab-save-controls .listbox-btn', locales: DICT_SAVE_BAR_LOCALES, ...sticky }),
    context('dict-save-change-menu', ['dict-save-bar'], { target: '[id^="vocab-save-definition-opt-"]:not([hidden])' }),
    // A saved AI entry whose three paid learning actions this account last
    // found nothing for, with an AI key configured (plan 3.3): each reads
    // "Not found last time · Try again" plus the model note on one line.
    context('dict-entry-paid-negative', [], { target: DICT_PAID_NEGATIVE_TARGET, locales: DICT_PAID_NEGATIVE_LOCALES, ...sticky }),
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
    name === 'explain-dict' ? ['explain-pop'] : name === 'dict-resize-menu' ? ['explain-dict'] : name === 'dict-entry-busy' ? ['dict-entry-idle'] : name === 'dict-entry-progress' ? ['dict-entry-busy'] : name === 'dict-entry-result' ? ['dict-entry-busy'] : ['dict-entry-details', 'dict-entry-cached', 'dict-entry-usage-busy', 'dict-entry-panel', 'dict-entry-folded'].includes(name) ? ['dict-entry-result'] : name === 'dict-entry-revealed' ? ['dict-entry-folded'] : name === 'dict-entry-usage-error' ? ['dict-entry-usage-busy'] : name === 'dict-entry-usage-result' ? ['dict-entry-usage-error'] : name === 'dict-entry-error' ? ['dict-entry-idle'] : name === 'dict-save-change-menu' ? ['dict-save-bar'] : [],
    name === 'dict-entry-paid-negative' ? { target: DICT_PAID_NEGATIVE_TARGET, locales: DICT_PAID_NEGATIVE_LOCALES }
      : name === 'reader-bookmark-quote-error' ? { target: '#reader-bookmark-editor-status[data-state="error"]', locales: READER_BOOKMARK_QUOTE_LOCALES } : {})), context('video', [], { target: '.pbv-bar' })],
  popup: [context('light', [], { target: '#main-section' }), context('states', [], { target: '.offline-queue-item' }),
    context('form', [], { target: '#url-input' }), context('title-error', ['form'], { target: '#desc-char-count.over-limit' }), context('linkding-sharing', ['form'], { target: '#share-check' }), context('linkding-description', ['form'], { target: '#linkding-description-input' }), context('dpi', [], { dpr: [1.5, 2] }),
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
    if (item.locales) axes.locale = [...item.locales];
    if (item.viewports) axes.viewport = [...item.viewports];
    return row(sweepScenarioId(surface, item.name), surface, themes, {
      type: 'sweep', context: item.name,
      ...(item.name.startsWith('vocab-pack-') ? { files: [...files(surface), 'options-vocab.js', 'dict-pack.js', 'scripts/audit-vocab-pack-fixture.mjs'] } : {}),
      ...(/^dict-(entry|save)-/.test(item.name) ? { files: [...files(surface), 'md-dict.js', 'dict-entry.js', 'dict-evidence.js', 'dict-archive.js', 'ai.js', 'ai-cache.js', 'library-vocab.js', 'scripts/audit-dict-entry-fixture.mjs'] } : {}),
      features: [...new Set([item.name, item.name.replace(/^tab-/, ''), surface, ...(/^dict-(entry|save)-/.test(item.name) ? ['dictionary', 'dictionary-entry'] : [])])], kinds: ['layout'], axes: { ...axes, state: [item.name] },
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
