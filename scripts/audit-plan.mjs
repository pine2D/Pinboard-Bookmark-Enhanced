import { AUDIT_AXES, readAuditFilters, selectAuditScenarios } from './audit-scope.mjs';
import { SITE_VARIANTS } from './audit-site-scenarios.mjs';
import { renderScheme } from './audit-render-scenarios.mjs';
import { iconConsumers } from './audit-icon-impact.mjs';
import { qaThemeCases } from './audit-qa-scenarios.mjs';

export function parseAuditArgs(argv) {
  const options = { all: false, changed: false, staged: false, base: null, plan: false, list: false, report: null, filters: null };
  const forwarded = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], eq = arg.indexOf('='), name = arg.slice(2, eq < 0 ? undefined : eq);
    if (['all', 'changed', 'staged', 'plan', 'list'].includes(name) && eq < 0) { options[name] = true; continue; }
    if (!['surface', 'scenario', 'kind', 'feature', ...AUDIT_AXES, 'base', 'report'].includes(name)) throw new Error('Unknown audit option: ' + arg);
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (!value || value.startsWith('--')) throw new Error('Empty value for ' + arg);
    if (['base', 'report'].includes(name)) options[name] = value;
    else forwarded.push(`--audit-${name}=${value}`);
  }
  if ([options.changed, options.staged, !!options.base].filter(Boolean).length > 1) throw new Error('Choose one Git range: --changed, --staged or --base');
  if (options.all && (options.changed || options.staged || options.base)) throw new Error('--all cannot be combined with a Git range');
  options.filters = readAuditFilters(forwarded);
  if (options.all && forwarded.length) throw new Error('--all cannot be combined with scenario filters');
  if (!options.all && !options.changed && !options.staged && !options.base && !forwarded.length && !options.list) throw new Error('Choose --changed, --staged, --base=<ref>, --all or an explicit --surface/--scenario');
  return options;
}

const canonical = s => ({ reader: 'md-preview', site: 'pinboard' }[s] || s);
const uniq = rows => [...new Set(rows)];
const match = (path, pattern) => new RegExp('^' + pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(path);
const visual = row => ['render', 'site', 'help', 'qa'].includes(row.runner) || row.browser;
const surfaceOf = path => /^popup/.test(path) ? 'popup' : /^options/.test(path) ? 'options' : /^library/.test(path) ? 'library' : /^md-|^reader-/.test(path) ? 'md-preview' : /^pinboard-/.test(path) ? 'pinboard' : null;
const owns = (row, surfaces) => row.surfaces.some(s => surfaces.includes(canonical(s)));

// Only a provably additive icon-table edit can narrow shared.js by symbols.
// Unknown or dynamic consumers deliberately fall back to all actual surfaces.
export function addedIconKeys(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return null;
  const pattern = /const PBP_ICONS = \{([\s\S]*?)\n\};/;
  const a = before.match(pattern), b = after.match(pattern);
  if (!a || !b || before.replace(pattern, '') !== after.replace(pattern, '')) return null;
  const entries = body => {
    const rows = new Map();
    for (const line of body.split('\n')) {
      if (!line.trim() || line.trim().startsWith('//')) continue;
      const entry = line.match(/^\s*(\w+):\s*(['"])(<svg[^\n]+<\/svg>)\2,?\s*$/);
      if (!entry) return null;
      rows.set(entry[1], entry[3]);
    }
    return rows;
  };
  const old = entries(a[1]), next = entries(b[1]);
  if (!old || !next || [...old].some(([key, value]) => next.get(key) !== value)) return null;
  const keys = [...next.keys()].filter(key => !old.has(key));
  return keys.length ? keys : null;
}

export function inferAuditImpact(catalog, changes, { consumers = [] } = {}) {
  const ids = new Set(), reasons = [], warnings = [];
  function include(rows, path, reason) {
    for (const row of rows) { ids.add(row.id); reasons.push({ id: row.id, path, reason }); }
  }
  for (const change of changes) {
    const path = change.path, direct = catalog.filter(row => row.file === path || row.files?.some(pattern => match(path, pattern)));
    let surfaces = surfaceOf(path) ? [surfaceOf(path)] : null;
    let reason = 'surface owner', isolated = false;
    if (path === 'listbox.js') { surfaces = ['options', 'library']; reason = 'shared listbox: options and library consumers'; }
    else if (path === 'shared.js') {
      const icons = addedIconKeys(change.before, change.after);
      const traced = icons ? iconConsumers(icons, consumers) : null;
      const mapped = traced && !traced.uncertain && traced.surfaces.length;
      surfaces = mapped ? traced.surfaces : ['popup', 'options', 'library', 'md-preview', 'background'];
      isolated = !!mapped;
      reason = mapped ? 'additive icons (' + icons.join(', ') + ') traced to AST consumers' : 'shared dependency could not be safely narrowed; include all consumers';
      if (traced?.uncertain) warnings.push(...traced.reasons.map(r => `${path}: ${r.path}: ${r.reason}`));
    } else if (/^docs\/theme-surface\/(composers|pilots)\//.test(path) || /^(popup|options|library)\.css$/.test(path) && /@generated:/.test(change.patch || '')) {
      surfaces = /ui-components|ui-themes/.test(path) ? ['popup', 'options', 'library'] : ['popup', 'options', 'library', 'pinboard'];
      reason = 'theme generation dependency';
    } else if (['_locales/', 'i18n.js'].some(p => path.startsWith(p))) {
      surfaces = ['popup', 'options', 'library', 'md-preview']; reason = 'localized content consumers';
    } else if (path === 'ai.js' || path === 'ai-cache.js') {
      surfaces = ['popup', 'options', 'md-preview', 'background']; reason = 'AI shared consumers';
    }
    if (surfaces) {
      // A caller can attest a non-UI change; otherwise module-level JS is
      // conservative. Explicit --kind still intersects the recommendation.
      const candidates = catalog.filter(row => owns(row, surfaces) && (!(path === 'listbox.js' || isolated) || !visual(row) || row.surfaces.every(s => surfaces.includes(canonical(s)))));
      const feature = ({ 'md-ask.js': 'ask', 'md-translate.js': 'translation', 'md-dict.js': 'dictionary', 'md-video.js': 'video', 'library-notes.js': 'notes', 'library-vocab.js': 'vocab', 'popup-tags.js': 'tag', 'popup-ai.js': 'ai' })[path];
      const rows = candidates.filter(row => {
        if (change.logicOnly && visual(row)) return false;
        if (feature && visual(row)) return (row.features || []).some(f => f.includes(feature)) || row.id.includes(feature);
        return true;
      });
      include(rows, path, reason + (feature ? '; feature ' + feature : '') + (change.logicOnly ? '; logic only' : ''));
      include(direct.filter(row => row.id.startsWith('static.')), path, 'registered static/security dependency');
    } else if (direct.length) include(direct, path, 'registered input dependency');
    else if (/\.md$/.test(path) || path.startsWith('docs/')) include(catalog.filter(r => r.id === 'static.docs'), path, 'documentation-only check');
    else {
      const rows = catalog.filter(row => !visual(row));
      include(rows, path, 'unmapped input: conservative static/logic coverage; visual scope requires explicit selection');
      warnings.push(`Unmapped input ${path}; review visual scope with --surface/--scenario`);
    }
  }
  return { ids: [...ids], reasons, warnings };
}

export function createAuditPlan(catalog, options, impact = null) {
  let candidates = catalog;
  if (impact) candidates = catalog.filter(row => impact.ids.includes(row.id));
  // Validate against the full vocabulary first, then intersect the impact set.
  const explicit = selectAuditScenarios(catalog, options.filters);
  const allowed = new Set(candidates.map(row => row.id));
  const selected = explicit.filter(row => allowed.has(row.id));
  if (!selected.length) throw new Error('No scenarios match the requested combination or Git changes');
  // Re-expand prerequisites even when the prerequisite itself was not changed.
  const scenarios = selectAuditScenarios(catalog, { ...readAuditFilters(), scenario: selected.map(s => s.id), axes: {} }).map(row => {
    const chosen = explicit.find(r => r.id === row.id);
    return chosen || row;
  });
  const groups = new Map();
  for (const row of scenarios) {
    if (row.selectionReason.startsWith('dependency of ') && scenarios.some(other => other.runner === row.runner && other.dependencies.includes(row.id))) continue;
    const axes = Object.fromEntries(Object.entries(row.selectedAxes).map(([key, values]) => [key, values.map(String)]));
    if (row.runner === 'qa') qaThemeCases(row, axes);
    if (axes.theme && axes.scheme && (row.runner === 'site' || row.runner === 'render' && row.axes.theme)) {
      if (!axes.theme.some(theme => axes.scheme.includes(row.runner === 'site' ? SITE_VARIANTS.find(v => v.key === theme)?.scheme : renderScheme(theme)))) throw new Error(`Invalid theme/scheme combination for ${row.id}`);
    }
    const fonts = axes.font || [row.runner === 'site' ? 'native' : process.env.FONTCONFIG_FILE ? 'ci' : 'native'];
    for (const font of fonts) {
      const effective = { ...axes, ...(axes.font ? { font: [font] } : {}) };
      const key = JSON.stringify([row.runner, row.file || '', effective, !!row.headed, row.fault || '']);
      if (!groups.has(key)) groups.set(key, { runner: row.runner, file: row.file, args: row.args || [], axes: effective, font, headed: !!row.headed, fault: row.fault, scenarios: [] });
      const add = id => {
        const entry = scenarios.find(s => s.id === id);
        for (const dep of entry.dependencies || []) {
          if (scenarios.find(s => s.id === dep)?.runner === row.runner) add(dep);
        }
        if (!groups.get(key).scenarios.includes(id)) groups.get(key).scenarios.push(id);
      };
      add(row.id);
    }
  }
  return { schemaVersion: 1, mode: options.all ? 'all' : impact ? 'changed' : 'selected', filters: options.filters, scenarios, jobs: [...groups.values()], reasons: impact?.reasons || [], warnings: impact?.warnings || [] };
}
