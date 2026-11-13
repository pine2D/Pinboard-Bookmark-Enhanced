import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_PROVIDERS } from "../scripts/ai-providers-source.mjs";
import {
  NON_SETTING_CHECKBOX_ALLOWLIST,
  NON_SETTING_FIELD_MAP_ENTRIES,
  PANEL_SCHEMA,
  SETTINGS_SCHEMA,
  URL_CLEAN_CONTROLS,
} from "../scripts/settings-schema.mjs";
import {
  REGION_SPECS,
  checkOptionsHtmlCoverage,
  checkSettingsSchemaSync,
  findSchemaAstViolations,
  syncSettingsSchema,
  validateSettingsSchema,
} from "../scripts/sync-settings-schema.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_FILES = [
  "shared.js",
  "options-backup.js",
  "options.js",
  "options.html",
];

function makeTempWorkspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "pbp-settings-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const rel of RUNTIME_FILES) {
    cpSync(join(ROOT, rel), join(dir, rel));
  }
  return dir;
}

test("schema exports 122 deeply frozen non-provider settings disjoint from AI_PROVIDERS", () => {
  assert.equal(SETTINGS_SCHEMA.length, 122);
  assert.equal(REGION_SPECS.length, 15);
  assert.ok(Object.isFrozen(SETTINGS_SCHEMA));
  assert.ok(Object.isFrozen(SETTINGS_SCHEMA[0]));
  assert.ok(Object.isFrozen(PANEL_SCHEMA));
  assert.ok(Object.isFrozen(URL_CLEAN_CONTROLS));
  assert.ok(Object.isFrozen(NON_SETTING_FIELD_MAP_ENTRIES));
  assert.ok(Object.isFrozen(NON_SETTING_CHECKBOX_ALLOWLIST));

  const schemaKeys = new Set(SETTINGS_SCHEMA.map((e) => e.key));
  assert.equal(schemaKeys.size, 122);

  const aiKeys = new Set();
  for (const p of AI_PROVIDERS) {
    if (p.keyField) aiKeys.add(p.keyField);
    aiKeys.add(p.modelField);
    if (p.baseField) aiKeys.add(p.baseField);
    if (p.regionField) aiKeys.add(p.regionField);
    if (p.workspaceField) aiKeys.add(p.workspaceField);
    if (p.protocolField) aiKeys.add(p.protocolField);
  }
  assert.equal(aiKeys.size, 43);
  for (const k of schemaKeys) {
    assert.equal(aiKeys.has(k), false, `key "${k}" must not overlap AI_PROVIDERS`);
  }
  assert.equal(schemaKeys.size + aiKeys.size, 165);
  assert.deepEqual(validateSettingsSchema(), []);
});

test("live repository passes settings schema sync, DOM coverage, and AST gates", () => {
  const res = checkSettingsSchemaSync(ROOT);
  assert.equal(res.ok, true, res.problems.join("\n"));
  assert.deepEqual(res.schemaProblems, []);
  assert.deepEqual(res.drifted, []);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.htmlDrift, []);
  assert.deepEqual(res.coverageProblems, []);
  assert.deepEqual(res.astViolations, []);
});

test("generated region drift in shared.js, options-backup.js, or options.js is caught and healed by --write", (t) => {
  const mutations = [
    { file: "shared.js", from: 'aiContentSource: "local",', to: 'aiContentSource: "jina",' },
    { file: "options-backup.js", from: 'aiContentSource: ["local", "jina"],', to: 'aiContentSource: ["local"],' },
    { file: "options.js", from: '"opt-ai-tag-lang": "en",', to: '"opt-ai-tag-lang": "auto",' },
  ];

  for (const { file, from, to } of mutations) {
    const dir = makeTempWorkspace(t);
    const abs = join(dir, file);
    const original = readFileSync(abs, "utf8");
    const mutated = original.replace(from, to);
    assert.notEqual(mutated, original, `expected ${file} to contain ${from}`);
    writeFileSync(abs, mutated, "utf8");

    const checkRes = checkSettingsSchemaSync(dir);
    assert.equal(checkRes.ok, false, `drift in ${file} must fail check`);
    assert.ok(
      checkRes.drifted.some((d) => d.includes(file)),
      `expected drifted report for ${file}, got: ${checkRes.problems.join("; ")}`,
    );

    const writeRes = syncSettingsSchema({ root: dir, write: true });
    assert.equal(writeRes.ok, true, `--write should heal ${file}`);
    assert.ok(writeRes.updatedFiles.includes(file));
    assert.equal(checkSettingsSchemaSync(dir).ok, true, `${file} should pass after --write`);
  }
});

test("static HTML default drift on checkbox, select, or radio in options.html is caught and healed by --write", (t) => {
  const mutations = [
    {
      name: "checkbox checked attribute",
      from: 'id="opt-auto-close" checked />',
      to: 'id="opt-auto-close" />',
      expectedNeedle: "options.html:opt-auto-close",
    },
    {
      name: "select selected option",
      from: '<option value="en" data-i18n="langEn" selected>',
      to: '<option value="en" data-i18n="langEn">',
      expectedNeedle: "options.html:opt-ai-tag-lang",
    },
    {
      name: "radio checked default",
      from: 'id="opt-ai-src-local" value="local" checked />',
      to: 'id="opt-ai-src-local" value="local" />',
      expectedNeedle: "options.html:radio[ai-content-source]",
    },
  ];

  for (const tc of mutations) {
    const dir = makeTempWorkspace(t);
    const abs = join(dir, "options.html");
    const original = readFileSync(abs, "utf8");
    const mutated = original.replace(tc.from, tc.to);
    assert.notEqual(mutated, original, `expected options.html to contain ${tc.from}`);
    writeFileSync(abs, mutated, "utf8");

    const checkRes = checkSettingsSchemaSync(dir);
    assert.equal(checkRes.ok, false, `${tc.name} drift must fail check`);
    assert.ok(
      checkRes.htmlDrift.some((d) => d.includes(tc.expectedNeedle)),
      `expected htmlDrift to name ${tc.expectedNeedle}, got: ${checkRes.htmlDrift.join("; ")}`,
    );

    const writeRes = syncSettingsSchema({ root: dir, write: true });
    assert.equal(writeRes.ok, true, `--write should heal ${tc.name}`);
    assert.equal(checkSettingsSchemaSync(dir).ok, true, `${tc.name} should pass after --write`);
  }
});

test("DOM coverage gate rejects unregistered panel controls, removed controls, and unmapped checkboxes", () => {
  const baseHtml = readFileSync(join(ROOT, "options.html"), "utf8");

  // 1. Unregistered text input inside a resettable panel (#panel-popup)
  const withRogueInput = baseHtml.replace(
    'id="opt-auto-close" checked />',
    'id="opt-auto-close" checked /><input type="text" id="opt-rogue-input" />',
  );
  assert.notEqual(withRogueInput, baseHtml);
  const resRogueInput = checkOptionsHtmlCoverage(withRogueInput);
  assert.ok(
    resRogueInput.some((p) => p.includes('control "opt-rogue-input" missing from PANEL_DEFAULTS')),
    `expected rogue input failure, got: ${resRogueInput.join("; ")}`,
  );

  // 2. Removed control still referenced by schema
  const withMissingControl = baseHtml.replace('id="opt-auto-close"', 'id="opt-renamed-auto-close"');
  assert.notEqual(withMissingControl, baseHtml);
  const resMissing = checkOptionsHtmlCoverage(withMissingControl);
  assert.ok(
    resMissing.some((p) => p.includes('id="opt-auto-close" no longer exists')),
    `expected reverse walk failure, got: ${resMissing.join("; ")}`,
  );

  // 3. Unmapped checkbox inside #panel-general (hasReset: false, caught by DOM-wide checkbox sweep)
  const withRogueCheckbox = baseHtml.replace(
    'id="panel-general"',
    'id="panel-general"><input type="checkbox" id="opt-rogue-general-check"',
  );
  assert.notEqual(withRogueCheckbox, baseHtml);
  const resRogueCheck = checkOptionsHtmlCoverage(withRogueCheckbox);
  assert.ok(
    resRogueCheck.some((p) => p.includes("opt-rogue-general-check: checkbox not covered")),
    `expected checkbox sweep failure, got: ${resRogueCheck.join("; ")}`,
  );
});

test("AST gate rejects hand-written settings, secrets, enums, form maps, panel defaults, and unknown collected keys", (t) => {
  const cases = [
    {
      name: "hand-written SETTINGS_DEFAULTS key",
      file: "shared.js",
      from: "// @generated:settings-schema end (settings-defaults-tail)",
      to: "// @generated:settings-schema end (settings-defaults-tail)\n  rogueSetting: true,",
      rule: "unschemad-settings-default",
    },
    {
      name: "hand-written API_KEY_FIELDS element",
      file: "shared.js",
      from: "// @generated:settings-schema end (api-key-fields-tail)",
      to: '// @generated:settings-schema end (api-key-fields-tail)\n  "rogueSecret",',
      rule: "unschemad-api-key-field",
    },
    {
      name: "duplicate PBP_BACKUP_ENUMS outside @generated",
      file: "options-backup.js",
      from: "// @generated:settings-schema end (backup-enums)",
      to: "// @generated:settings-schema end (backup-enums)\n{ const PBP_BACKUP_ENUMS = {}; void PBP_BACKUP_ENUMS; }",
      rule: "unschemad-backup-enum",
    },
    {
      name: "hand-written fieldMap entry outside @generated",
      file: "options.js",
      from: "// @generated:settings-schema end (field-map-tail)",
      to: '// @generated:settings-schema end (field-map-tail)\n    "opt-rogue": s.rogue,',
      rule: "unschemad-fieldMap",
    },
    {
      name: "hand-written checkMap entry outside @generated",
      file: "options.js",
      from: "// @generated:settings-schema end (check-map)",
      to: '// @generated:settings-schema end (check-map)\n    "opt-rogue-check": s.rogue === true,',
      rule: "unschemad-checkMap",
    },
    {
      name: "hand-written PANEL_DEFAULTS panel outside @generated",
      file: "options.js",
      from: "// @generated:settings-schema end (panel-defaults-after-ai)",
      to: "// @generated:settings-schema end (panel-defaults-after-ai)\n    roguePanel: { fields: {} },",
      rule: "unschemad-panel-default",
    },
    {
      name: "unknown key returned by collectSettingsFromForm",
      file: "options.js",
      from: "// @generated:settings-schema end (collect-form-tail)",
      to: "// @generated:settings-schema end (collect-form-tail)\n      rogueCollectedKey: true,",
      rule: "collect-unknown-key",
    },
  ];

  for (const tc of cases) {
    const dir = makeTempWorkspace(t);
    const abs = join(dir, tc.file);
    const original = readFileSync(abs, "utf8");
    const mutated = original.replace(tc.from, tc.to);
    assert.notEqual(mutated, original, `expected ${tc.file} to contain ${tc.from}`);
    writeFileSync(abs, mutated, "utf8");

    const violations = findSchemaAstViolations(dir);
    assert.ok(
      violations.some((v) => v.file === tc.file && v.rule === tc.rule),
      `expected ${tc.name} (${tc.rule}), got: ${JSON.stringify(violations)}`,
    );
    assert.equal(checkSettingsSchemaSync(dir).ok, false);
  }
});
