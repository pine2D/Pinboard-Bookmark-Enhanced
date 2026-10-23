// Matrix evidence is validated independently of the browser's loop body.
// Expected cells come from the public scenario contract; actual cells must
// be recorded only after their measurements finish.
import { HELP_LOCALES, HELP_DPRS } from './audit-help-scenarios.mjs';
import { SITE_VARIANTS, SITE_WIDTHS } from './audit-site-scenarios.mjs';
import { QA_SCENARIOS, qaExpectedCases } from './audit-qa-scenarios.mjs';

const values = (job, axis, defaults) => job.axes?.[axis]
  ? defaults.filter(value => job.axes[axis].map(String).includes(String(value))) : defaults;

function requireCells(id, expected, actual) {
  if (!expected.length) throw new Error(`${id}: no valid expected matrix cells`);
  const axes = Object.keys(expected[0]).sort();
  const key = cell => JSON.stringify(axes.map(axis => {
    if (cell?.[axis] === undefined) throw new Error(`${id}: matrix evidence lacks ${axis}`);
    return String(cell[axis]);
  }));
  const wanted = new Set(expected.map(key)), measured = new Set();
  for (const cell of actual) {
    const value = key(cell);
    if (measured.has(value)) throw new Error(`${id}: duplicate matrix cell ${value}`);
    if (!wanted.has(value)) throw new Error(`${id}: unexpected matrix cell ${value}`);
    measured.add(value);
  }
  const missing = [...wanted].filter(value => !measured.has(value));
  if (missing.length) throw new Error(`${id}: missing ${missing.length} matrix cells: ${missing.slice(0, 4).join(', ')}`);
}

export function validateAuditMatrices(job, coverage) {
  if (!['help', 'site', 'qa'].includes(job.runner)) return;
  for (const id of job.scenarios) {
    const row = coverage.completed.find(entry => entry.id === id);
    if (!row || !Array.isArray(row.details) || row.runs !== row.details.length) {
      throw new Error(`${id}: missing or inconsistent matrix completion history`);
    }
    if (job.runner === 'help') {
      const locales = values(job, 'locale', HELP_LOCALES.map(locale => locale.messagesDir));
      const dprs = values(job, 'dpr', HELP_DPRS);
      const expected = locales.flatMap(locale => dprs.map(dpr => ({ locale, dpr, font: job.font })));
      requireCells(id, expected, row.details);
    } else if (job.runner === 'site') {
      const themes = values(job, 'theme', SITE_VARIANTS.map(variant => variant.key));
      const schemes = values(job, 'scheme', ['light', 'dark']);
      const widths = values(job, 'viewport', SITE_WIDTHS[id.slice('site.'.length)] || [1440]);
      const expected = SITE_VARIANTS.filter(variant => themes.includes(variant.key) && schemes.includes(variant.scheme))
        .flatMap(variant => widths.map(viewport => ({ theme: variant.key, scheme: variant.scheme, viewport, font: 'native' })));
      const actual = row.details.flatMap(detail => {
        if (!Array.isArray(detail.viewports)) throw new Error(`${id}: matrix evidence lacks viewports`);
        return detail.viewports.map(viewport => ({ theme: detail.theme, scheme: detail.scheme, font: detail.font, viewport }));
      });
      requireCells(id, expected, actual);
    } else {
      const scenario = QA_SCENARIOS.find(entry => entry.id === id);
      if (!scenario) throw new Error(`${id}: unknown QA matrix scenario`);
      const expected = qaExpectedCases(scenario, job.axes || {}, { font: job.font });
      const actual = row.details.flatMap(detail => {
        if (!Array.isArray(detail.cases)) throw new Error(`${id}: matrix evidence lacks cases`);
        return detail.cases;
      });
      requireCells(id, expected, actual);
    }
  }
}
