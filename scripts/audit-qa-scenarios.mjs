// These rows are consumed by qa-drive's dispatcher, not a second inventory.
import { readFileSync } from 'node:fs';

const optionsHtml = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
export const QA_OPTIONS_PANELS = [...optionsHtml.matchAll(/id="tab-([a-z-]+)"/g)].map(m => m[1]);
export const QA_THEME_PRESETS = [...new Set([...optionsHtml.matchAll(/theme-preset-btn" data-theme="([a-z0-9-]*)"/g)].map(m => m[1] || 'default'))];
export const QA_LOCALES = ['zh_CN', 'en', 'de', 'fr', 'ja', 'pl', 'ru', 'zh_TW', 'zh_HK'];
const adaptiveBlock = readFileSync(new URL('../shared.js', import.meta.url), 'utf8').match(/const ADAPTIVE_THEME_MAP = \{([\s\S]*?)\n\};/);
if (!adaptiveBlock) throw new Error('QA theme metadata: ADAPTIVE_THEME_MAP missing');
const adaptiveThemes = new Set([...adaptiveBlock[1].matchAll(/([a-z0-9-]+):\s*\[/g)].map(match => match[1]));
const themeModes = new Map(QA_THEME_PRESETS.map(theme => {
  if (theme === 'default' || adaptiveThemes.has(theme)) return [theme, ['light', 'dark']];
  const mode = JSON.parse(readFileSync(new URL(`../docs/theme-surface/pilots/${theme}.tokens.json`, import.meta.url), 'utf8')).meta.mode;
  if (!['light', 'dark'].includes(mode)) throw new Error(`QA theme metadata: unsupported mode ${theme}/${mode}`);
  return [theme, [mode]];
}));
const runtimeAxes = { dpr: ['1'], font: ['native', 'ci'] };
const narrowAxes = { locale: QA_LOCALES, viewport: ['320', '420'], scheme: ['light', 'dark'], density: ['comfortable', 'compact'] };
const files = {
  options: ['options.html', 'options.js', 'options.css', 'options-connectivity.js', 'options-backup.js', 'options-vocab.js'],
  popup: ['popup.html', 'popup.js', 'popup.css', 'popup-ai.js', 'popup-tags.js', 'popup-offline.js'],
  library: ['library.html', 'library.js', 'library.css', 'library-notes.js', 'library-vocab.js'],
  reader: ['md-preview.html', 'md-preview.js', 'md-preview.css', 'md-reader.js', 'md-ask.js', 'md-translate.js', 'md-highlight.js'],
  site: ['pinboard-style.js', 'pinboard-sort.js', 'pinboard-themes.js'],
};
const row = (id, driver, step, surfaces, features, kinds = ['interaction'], axes = {}, extra = {}) => ({
  id: `qa.${id}`, runner: 'qa', driver, step, surfaces, features, kinds,
  files: [...new Set(surfaces.flatMap(surface => files[surface] || []))], dependencies: [], axes: { ...runtimeAxes, ...axes }, ...extra,
});
export const QA_SCENARIOS = [
  ...QA_OPTIONS_PANELS.map(panel => row(`options.panel.${panel}`, 'options', panel, ['options'], [panel, 'settings'], ['interaction', 'layout'])),
  ...QA_OPTIONS_PANELS.map(panel => row(`options.layout.${panel}`, 'layouts', `options-${panel}`, ['options'], [panel, 'settings'], ['layout'], narrowAxes)),
  row('options.locale-refresh', 'options-save', 'locale-refresh', ['options'], ['settings', 'locale'], ['interaction']),
  row('options.save-failure', 'options-save', 'save-failure', ['options'], ['settings', 'save', 'retry'], ['interaction', 'layout', 'error'], narrowAxes),
  ...['vocab-list', 'vocab-detail', 'vocab-rich-detail', 'vocab-batch-bar', 'vocab-export-menu', 'notes-two-pane', 'notes-same-page', 'narrow'].map(step => row(`library.${step}`, 'library', step, ['library'], [step.startsWith('notes') ? 'notes' : 'vocabulary', ...(step.includes('export') ? ['export'] : [])], ['interaction', 'layout'], step === 'narrow' ? { viewport: ['420'] } : {})),
  ...['base', 'help-overlay', 'search', 'dictionary', 'highlight-bar', 'highlight', 'export-rail', 'ask-panel', 'translate-ask', 'translate'].map(step => row(`reader.${step}`, 'preview', step, ['reader'], [step.startsWith('highlight') ? 'highlight' : step.startsWith('translate') ? 'translation' : step === 'ask-panel' ? 'ask' : step], ['interaction'], {}, { needsNetwork: ['dictionary', 'ask-panel', 'translate'].includes(step) })),
  row('reader.selection', 'selection', 'selection', ['reader'], ['selection', 'highlight', 'popover']),
  row('reader.export', 'reader-export', 'export', ['reader'], ['export', 'ask']),
  row('reader.bookmark', 'reader-bookmark', 'bookmark', ['reader'], ['bookmark', 'account']),
  ...['editor', 'ask'].map(step => row(`reader.controls.${step}`, 'reader-controls', step, ['reader'], [step === 'editor' ? 'bookmark' : 'ask', 'keyboard'], ['interaction', 'layout'], { locale: QA_LOCALES, viewport: ['1440', '360', '320'], scheme: ['light', 'dark'], density: ['default', 'large'] })),
  row('reader.controls.history', 'reader-controls', 'history', ['reader'], ['ask', 'history'], ['interaction', 'layout'], { locale: QA_LOCALES, viewport: ['360'], scheme: ['dark'], density: ['large'] }),
  row('reader.controls.stop', 'reader-controls', 'stop', ['reader'], ['ask', 'keyboard'], ['interaction'], {}, { needsNetwork: true }),
  row('reader.layout.ask', 'layouts', 'reader-ask', ['reader'], ['ask'], ['layout'], { viewport: ['880', '1000', '1001', '1024', '1100', '1199', '1200', '1280', '1440'] }),
  row('reader.edge', 'reader-edge', 'edge', ['reader'], ['translation', 'drawer', 'typography'], ['interaction', 'layout', 'error'], {}, { needsNetwork: true }),
  row('reader.translate-stop', 'translate-stop', 'translate-stop', ['reader'], ['translation', 'keyboard'], ['interaction', 'error'], { fault: ['ai-429'] }, { needsNetwork: true, fault: 'ai-429' }),
  row('popup.page', 'popup', 'page', ['popup'], ['bookmark'], ['interaction', 'accessibility']),
  row('popup.toolbar', 'popup', 'toolbar', ['popup'], ['bookmark', 'ai'], ['interaction'], {}, { headed: true, needsNetwork: true }),
  row('popup.form', 'layouts', 'popup-form', ['popup'], ['bookmark', 'form'], ['accessibility']),
  row('popup.login', 'layouts', 'popup-login', ['popup'], ['login'], ['accessibility']),
  row('popup.drafts', 'drafts', 'drafts', ['popup'], ['drafts', 'bookmark'], ['interaction'], {}, { headed: true }),
  row('site.theme', 'pinboard', 'theme', ['site'], ['theme'], ['visual']),
  row('journey.notes-account', 'journey', 'journey', ['reader', 'library'], ['notes', 'highlight', 'account', 'source'], ['interaction', 'journey']),
  row('discovery.appearance', 'discovery', 'appearance', ['options'], ['theme', 'settings'], ['interaction']),
  row('discovery.reader-setup', 'discovery', 'reader-setup', ['reader', 'options'], ['ai', 'settings', 'account'], ['interaction', 'journey'], {}, { needsNetwork: true }),
  row('discovery.popup-setup', 'discovery', 'popup-setup', ['popup', 'options'], ['ai', 'settings'], ['interaction', 'journey']),
  ...['options', 'library', 'popup', 'site', 'reader'].map(surface => row(`themes.${surface}`, 'themes', surface, [surface], ['theme'], ['visual'], {
    scheme: ['light', 'dark'], ...(surface !== 'reader' ? { theme: surface === 'site' ? QA_THEME_PRESETS.filter(p => p !== 'default') : QA_THEME_PRESETS } : {}),
  })),
  ...['options', 'library', 'popup'].map(surface => row(`themes.${surface}-unset`, 'themes', `${surface}-unset`, [surface], ['theme'], ['visual'], { scheme: surface === 'popup' ? ['light', 'dark'] : ['light'] })),
  ...['ai-429', 'ai-500', 'ai-malformed', 'ai-truncated', 'pb-401', 'pb-500'].map(fault => row(`fault.${fault}`, 'faults', fault, [fault.startsWith('ai-') ? 'reader' : 'popup'], [fault.startsWith('ai-') ? 'translation' : 'bookmark'], ['error'], { fault: [fault] }, { fault, needsNetwork: fault.startsWith('ai-') })),
];

// These are scenario classifications: selecting them chooses an existing
// interaction/fixture; it does not introduce a new Cartesian matrix axis.
for (const scenario of QA_SCENARIOS) {
  if (['qa.reader.controls.editor', 'qa.reader.controls.stop'].includes(scenario.id)) scenario.axes.input = ['keyboard'];
  else if (scenario.id.startsWith('qa.options.panel.') || ['qa.library.vocab-detail', 'qa.library.notes-same-page'].includes(scenario.id)) scenario.axes.input = ['pointer'];
  const data = { 'qa.library.vocab-rich-detail': 'rich-vocabulary', 'qa.library.notes-same-page': 'multi-excerpt', 'qa.reader.controls.history': 'saved-history' }[scenario.id];
  if (data) scenario.axes.data = [data];
  if (scenario.kinds.includes('journey')) scenario.axes.tier = ['journey'];
  else if (scenario.driver === 'themes' || scenario.id.startsWith('qa.options.layout.') || ['qa.reader.controls.editor', 'qa.reader.controls.ask', 'qa.reader.controls.history'].includes(scenario.id)) scenario.axes.tier = ['matrix'];
  else if (scenario.id.startsWith('qa.options.panel.') || ['qa.popup.login', 'qa.popup.form'].includes(scenario.id)) scenario.axes.tier = ['smoke'];
}

const selected = (axes, axis, defaults) => axis in axes ? [...axes[axis]] : [...defaults];
export function qaThemeCases(scenario, axes = {}) {
  if (scenario.driver !== 'themes' || !scenario.axes.theme) return [];
  const schemes = selected(axes, 'scheme', scenario.axes.scheme);
  const cases = selected(axes, 'theme', scenario.axes.theme).flatMap(theme =>
    (themeModes.get(theme) || []).filter(scheme => schemes.includes(scheme)).map(scheme => ({ theme, scheme })));
  if (!cases.length) throw new Error(`Invalid theme/scheme combination for ${scenario.id}`);
  return cases;
}

export function qaReaderControlCases(locale, axes = {}, { representative = false, scoped = true } = {}) {
  const explicit = scoped && ['locale', 'viewport', 'scheme', 'density'].some(axis => axis in axes);
  if (explicit) {
    return selected(axes, 'scheme', ['light', 'dark']).flatMap(mode =>
      selected(axes, 'viewport', representative ? [360] : [1440, 360, 320]).flatMap(width =>
        selected(axes, 'density', representative ? ['large'] : ['default', 'large']).map(density => ({ mode, width: Number(width), tier: density === 'large' ? 2 : 0 }))));
  }
  if (representative) return ['light', 'dark'].map(mode => ({ mode, width: 360, tier: 2 }));
  const cases = ['light', 'dark'].flatMap(mode => [1440, 360].flatMap(width => [0, 2].map(tier => ({ mode, width, tier }))));
  if (locale === 'zh_CN' || locale === 'de') cases.push(...['light', 'dark'].map(mode => ({ mode, width: 320, tier: 2 })));
  return cases;
}

export function qaExpectedCases(scenario, axes = {}, { font = 'native', representative = false } = {}) {
  const base = { font, dpr: 1 };
  const rows = [];
  if (scenario.driver === 'themes') {
    if (scenario.axes.theme) rows.push(...qaThemeCases(scenario, axes));
    else rows.push(...selected(axes, 'scheme', scenario.axes.scheme).map(scheme => ({ scheme })));
  } else if (scenario.driver === 'reader-controls' && scenario.step !== 'stop') {
    for (const locale of selected(axes, 'locale', representative ? ['zh_CN', 'de'] : QA_LOCALES)) {
      const cases = scenario.step === 'history' ? [{ mode: 'dark', width: 360, tier: 2 }] : qaReaderControlCases(locale, axes, { representative });
      for (const c of cases) rows.push({ locale, viewport: c.width, scheme: c.mode, density: c.tier === 2 ? 'large' : 'default' });
    }
  } else if (scenario.id.startsWith('qa.options.layout.') || scenario.id === 'qa.options.save-failure') {
    for (const locale of selected(axes, 'locale', QA_LOCALES)) for (const density of selected(axes, 'density', narrowAxes.density))
      for (const scheme of selected(axes, 'scheme', narrowAxes.scheme)) for (const viewport of selected(axes, 'viewport', [320, 420])) rows.push({ locale, density, scheme, viewport: Number(viewport) });
  } else if (scenario.id === 'qa.reader.layout.ask') {
    rows.push(...selected(axes, 'viewport', scenario.axes.viewport).map(viewport => ({ viewport: Number(viewport) })));
  } else if (scenario.id === 'qa.library.narrow') rows.push({ viewport: 420 });
  else rows.push(scenario.fault ? { fault: scenario.fault } : {});
  return rows.map(row => ({ ...base, ...row }));
}

export function assertQaCases(expected, actual) {
  const key = value => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([axis, entry]) => [axis, String(entry)]));
  const expectedKeys = new Set(expected.map(key)), actualKeys = new Set(actual.map(key));
  if (actualKeys.size !== actual.length) throw new Error('Duplicate QA matrix cases');
  const missing = [...expectedKeys].filter(value => !actualKeys.has(value));
  const unexpected = [...actualKeys].filter(value => !expectedKeys.has(value));
  if (missing.length) throw new Error(`Missing QA matrix cases (${missing.length}): ${missing.slice(0, 3).join('; ')}`);
  if (unexpected.length) throw new Error(`Unexpected QA matrix cases (${unexpected.length}): ${unexpected.slice(0, 3).join('; ')}`);
}

export async function runQaScenarios(selection, drivers) {
  for (const scenario of selection.selected) {
    const drive = drivers[scenario.driver];
    if (!drive) throw new Error(`QA driver unavailable: ${scenario.driver}`);
    selection.start(scenario.id);
    const detail = await drive(scenario);
    selection.complete(scenario.id, detail);
  }
}
