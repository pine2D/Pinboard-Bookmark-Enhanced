export const HELP_ROLES = Object.freeze(['section', 'field', 'choice', 'group', 'action']);
export const HELP_LOCALES = Object.freeze([{ id: 'zh-CN', messagesDir: 'zh_CN' }, { id: 'en', messagesDir: 'en' }]);
export const HELP_DPRS = Object.freeze([1, 1.25, 1.5, 2]);
export const HELP_SCENARIOS = HELP_ROLES.map(role => ({
  id: 'help.options.' + role, runner: 'help', role, surfaces: ['options'], features: ['help', role],
  kinds: ['layout', 'raster', 'i18n'], dependencies: [],
  files: ['options.html', 'options.css', '_locales/*/messages.json', 'scripts/options-help-render-audit.mjs'],
  axes: { locale: HELP_LOCALES.map(v => v.messagesDir), dpr: HELP_DPRS, font: ['native', 'ci'] },
}));
