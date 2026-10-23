import assert from 'node:assert/strict';
import test from 'node:test';

const module = await import('../scripts/audit-icon-impact.mjs').catch(() => null);
const scan = (consumers, keys = ['newIcon']) => {
  assert.ok(module, 'icon impact must use parsed JavaScript consumers');
  return module.iconConsumers(keys, consumers);
};

test('icon names in comments, ordinary strings and HTML text do not select a surface', () => {
  const result = scan([
    { path: 'popup.js', source: '// PBP_ICONS.newIcon\nconst label = "setBtnIcon(button, \'newIcon\')";' },
    { path: 'options.html', source: '<!-- <script>PBP_ICONS.newIcon</script> --><p>PBP_ICONS.newIcon</p>' },
  ]);
  assert.deepEqual(result.surfaces, []);
  assert.equal(result.uncertain, false);
});

test('static members and button icon arguments identify only their actual consumers', () => {
  const result = scan([
    { path: 'popup-ai.js', source: 'button.innerHTML = PBP_ICONS.newIcon;' },
    { path: 'md-reader.js', source: 'const svg = PBP_ICONS["newIcon"];' },
    { path: 'options.js', source: 'setBtnIcon(button, "newIcon", label);' },
    { path: 'library.js', source: 'setBtnIcon(button, "anotherIcon", "newIcon");' },
  ]);
  assert.deepEqual(result.surfaces, ['popup', 'md-preview', 'options']);
  assert.deepEqual(result.references.map(row => row.path), ['popup-ai.js', 'md-reader.js', 'options.js']);
  assert.equal(result.uncertain, false);
});

test('an unknown computed consumer prevents narrowing even without a literal new icon name', () => {
  for (const source of ['PBP_ICONS[iconName]', 'setBtnIcon(button, iconName, label)', 'const icons = PBP_ICONS; icons[iconName]', 'const paint = setBtnIcon; paint(button, iconName)']) {
    const result = scan([{ path: 'popup.js', source: 'PBP_ICONS.newIcon;' }, { path: 'library.js', source }]);
    assert.equal(result.uncertain, true, source);
    assert.ok(result.reasons.some(row => row.path === 'library.js'), source);
  }
});

test('finite conditional keys and typeof guards remain statically attributable', () => {
  const result = scan([{ path: 'library-vocab.js', source: 'const svg = typeof PBP_ICONS !== "undefined" ? PBP_ICONS[known ? "newIcon" : "oldIcon"] : ""; setBtnIcon(button, known ? "oldIcon" : "newIcon", "");' }]);
  assert.deepEqual(result.surfaces, ['library']);
  assert.equal(result.uncertain, false);
});

test('local bindings with the same names are not shared icon consumers', () => {
  const result = scan([{ path: 'popup.js', source: 'function local(PBP_ICONS, setBtnIcon) { return PBP_ICONS.newIcon + setBtnIcon(button, unknown); }' }]);
  assert.deepEqual(result.surfaces, []);
  assert.equal(result.uncertain, false);
});

test('inline HTML scripts are parsed while inert script data is ignored', () => {
  const result = scan([{ path: 'options.html', source: '<script type="application/json">{"text":"PBP_ICONS[dynamic]"}</script><script type="module">setBtnIcon(button, "newIcon", "");</script>' }]);
  assert.deepEqual(result.surfaces, ['options']);
  assert.equal(result.uncertain, false);
});

test('unparseable code and unmapped real consumers fail closed', () => {
  assert.equal(scan([{ path: 'popup.js', source: 'const = PBP_ICONS.newIcon' }]).uncertain, true);
  assert.equal(scan([{ path: 'new-surface.js', source: 'PBP_ICONS.newIcon;' }]).uncertain, true);
});
