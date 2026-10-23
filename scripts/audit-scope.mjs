// Shared selection and coverage boundary for the existing audit runners.
// This module only describes execution; it never imports a browser or test body.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const AUDIT_AXES = Object.freeze(['theme', 'scheme', 'locale', 'viewport', 'dpr', 'font', 'density', 'state', 'input', 'fault', 'data', 'tier']);
const SELECTORS = ['surface', 'scenario', 'kind', 'feature'];
const alias = (axis, value) => axis === 'surface' ? ({ reader: 'md-preview', preview: 'md-preview', site: 'pinboard' }[value] || value)
  : axis === 'theme' && value === '(default)' ? 'default' : String(value);
const unique = values => [...new Set(values)];

export function readAuditFilters(argv = []) {
  const filters = { surface: [], scenario: [], kind: [], feature: [], axes: {}, plan: false, list: false, report: null, active: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--audit-')) continue;
    filters.active = true;
    const eq = arg.indexOf('=');
    const name = arg.slice(8, eq < 0 ? undefined : eq);
    if (name === 'plan' || name === 'list') {
      if (eq >= 0) throw new Error(`--audit-${name} takes no value`);
      filters[name] = true; continue;
    }
    if (![...SELECTORS, ...AUDIT_AXES, 'report'].includes(name)) throw new Error(`Unknown audit option: ${arg}`);
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`--audit-${name} has an empty value`);
    if (name === 'report') { filters.report = resolve(value); continue; }
    const values = value.split(',').map(v => alias(name, v.trim()));
    if (values.some(v => !v)) throw new Error(`--audit-${name} contains an empty selection`);
    if (SELECTORS.includes(name)) filters[name] = unique([...filters[name], ...values]);
    else filters.axes[name] = unique([...(filters.axes[name] || []), ...values]);
  }
  return filters;
}

const matchesPattern = (id, pattern) => new RegExp('^' + pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(id);
export function validateAuditCatalog(scenarios) {
  const byId = new Map();
  for (const scenario of scenarios) {
    if (!scenario.id || byId.has(scenario.id)) throw new Error(`Duplicate or missing scenario id: ${scenario.id}`);
    byId.set(scenario.id, scenario);
  }
  const visited = new Set(), pending = new Set();
  const visit = id => {
    if (pending.has(id)) throw new Error(`Scenario dependency cycle: ${id}`);
    if (visited.has(id)) return;
    const row = byId.get(id);
    if (!row) throw new Error(`Unknown scenario dependency: ${id}`);
    pending.add(id);
    for (const dep of row.dependencies || []) visit(dep);
    pending.delete(id); visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  return byId;
}

export function selectAuditScenarios(scenarios, filters = readAuditFilters(), { allowEmpty = false } = {}) {
  const byId = validateAuditCatalog(scenarios);
  const requested = {
    surface: row => (row.surfaces || []).map(v => alias('surface', v)),
    kind: row => row.kinds || [], feature: row => row.features || [],
  };
  for (const [name, get] of Object.entries(requested)) {
    const known = new Set(scenarios.flatMap(get));
    for (const value of filters[name] || []) if (!known.has(value)) throw new Error(`Unknown ${name}: ${value}`);
  }
  for (const pattern of filters.scenario || []) if (!scenarios.some(row => matchesPattern(row.id, pattern))) throw new Error(`Unknown scenario: ${pattern}`);
  for (const [axis, values] of Object.entries(filters.axes || {})) {
    const known = new Set(scenarios.flatMap(row => (row.axes?.[axis] || []).map(v => alias(axis, v))));
    for (const value of values) if (!known.has(value)) throw new Error(`Unsupported ${axis}: ${value}`);
  }
  const chosen = scenarios.filter(row => {
    if (filters.scenario?.length && !filters.scenario.some(p => matchesPattern(row.id, p))) return false;
    for (const [name, get] of Object.entries(requested)) if (filters[name]?.length && !filters[name].some(v => get(row).includes(v))) return false;
    return Object.entries(filters.axes || {}).every(([axis, values]) => (row.axes?.[axis] || []).some(v => values.includes(alias(axis, v))));
  });
  if (!chosen.length && !allowEmpty) throw new Error('No scenarios match the requested combination');
  const result = [], included = new Set();
  const add = (row, reason) => {
    if (included.has(row.id)) return;
    for (const dep of row.dependencies || []) add(byId.get(dep), 'dependency of ' + row.id);
    const selectedAxes = {};
    for (const [axis, values] of Object.entries(filters.axes || {})) {
      if (row.axes?.[axis]) {
        const supported = row.axes[axis].filter(v => values.includes(alias(axis, v)));
        if (supported.length) selectedAxes[axis] = supported;
      }
    }
    included.add(row.id); result.push({ ...row, selectedAxes, selectionReason: reason });
  };
  for (const row of chosen) add(row, 'selected');
  return result;
}

export function auditSelection({ runner, scenarios, argv = process.argv.slice(2) }) {
  const filters = readAuditFilters(argv);
  const selected = selectAuditScenarios(scenarios, filters);
  const ids = new Set(selected.map(row => row.id));
  const selectedById = new Map(selected.map(row => [row.id, row]));
  const started = new Map(), completed = new Map();
  const began = performance.now();
  const partial = selected.length !== scenarios.length || SELECTORS.some(k => filters[k].length) || Object.keys(filters.axes).length > 0;
  const coverage = () => ({
    schemaVersion: 1, runner, partial, filters, axes: structuredClone(filters.axes), expected: [...ids],
    completed: [...completed].map(([id, value]) => ({ id, ...value })),
    missing: [...ids].filter(id => !completed.has(id)), durationMs: Math.round(performance.now() - began),
  });
  const requireSelected = id => { if (!ids.has(id)) throw new Error(`Scenario not selected: ${id}`); };
  return {
    runner, filters, selected, ids, partial, active: filters.active,
    has: id => ids.has(id),
    values(id, axis, defaults) {
      requireSelected(id);
      const requestedValues = selectedById.get(id).selectedAxes[axis]?.map(v => alias(axis, v));
      if (!requestedValues || !selectedById.get(id).axes?.[axis]) return [...defaults];
      return defaults.filter(v => requestedValues.includes(alias(axis, v)));
    },
    maybePrintPlan() {
      if (!filters.plan && !filters.list) return false;
      writeFileSync(1, JSON.stringify({ schemaVersion: 1, runner, partial, filters, scenarios: selected }, null, 2) + '\n');
      return true;
    },
    start(id) { requireSelected(id); if (!started.has(id)) started.set(id, performance.now()); },
    complete(id, detail = {}) {
      requireSelected(id);
      const previous = completed.get(id);
      const snapshot = structuredClone(detail);
      completed.set(id, {
        durationMs: Math.round(performance.now() - (started.get(id) ?? began)), runs: (previous?.runs || 0) + 1,
        axes: structuredClone(selectedById.get(id).selectedAxes), detail: snapshot,
        details: [...(previous?.details || []), snapshot],
      });
    },
    finish() {
      const report = coverage();
      if (filters.report) { mkdirSync(dirname(filters.report), { recursive: true }); writeFileSync(filters.report, JSON.stringify(report, null, 2) + '\n'); }
      if (report.missing.length) throw new Error(`Audit scenarios not completed: ${report.missing.join(', ')}`);
      return report;
    },
  };
}
