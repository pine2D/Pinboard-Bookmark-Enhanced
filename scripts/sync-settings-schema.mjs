#!/usr/bin/env node
// Generates and checks all `@generated:settings-schema` regions across
// `shared.js`, `options-backup.js`, and `options.js`, verifies/syncs static
// defaults and reset/checkbox DOM coverage in `options.html`, and enforces an
// `espree` AST gate preventing unschema'd hand-written entries.
//
// Usage:
//   node scripts/sync-settings-schema.mjs --check   (default, read-only)
//   node scripts/sync-settings-schema.mjs --write   (updates runtime files)

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_PROVIDERS } from "./ai-providers-source.mjs";
import {
  NON_SETTING_CHECKBOX_ALLOWLIST,
  NON_SETTING_FIELD_MAP_ENTRIES,
  PANEL_SCHEMA,
  SETTINGS_SCHEMA,
  URL_CLEAN_CONTROLS,
} from "./settings-schema.mjs";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(SELF_DIR, "..");

const require = createRequire(import.meta.url);
const espree = require(join(DEFAULT_ROOT, ".qa-scan/node_modules/espree"));

const q = (v) => JSON.stringify(v);

function formatJsValue(val) {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const entries = Object.entries(val);
    if (entries.length === 0) return "{}";
    return `{ ${entries.map(([k, v]) => `${k}: ${formatJsValue(v)}`).join(", ")} }`;
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return "[]";
    return `[${val.map((x) => formatJsValue(x)).join(", ")}]`;
  }
  return JSON.stringify(val);
}

function aiProviderSettingKeys() {
  const keys = new Set();
  for (const p of AI_PROVIDERS) {
    if (p.keyField) keys.add(p.keyField);
    keys.add(p.modelField);
    if (p.baseField) keys.add(p.baseField);
    if (p.regionField) keys.add(p.regionField);
    if (p.workspaceField) keys.add(p.workspaceField);
    if (p.protocolField) keys.add(p.protocolField);
  }
  return keys;
}

// ---- Schema self-validation ----

export function validateSettingsSchema() {
  const problems = [];
  const seenKeys = new Set();
  const aiKeys = aiProviderSettingKeys();

  for (const entry of SETTINGS_SCHEMA) {
    if (!entry.key || typeof entry.key !== "string") {
      problems.push("settings-schema: entry with missing/invalid key");
      continue;
    }
    if (seenKeys.has(entry.key)) {
      problems.push(`settings-schema: duplicate key "${entry.key}"`);
    }
    seenKeys.add(entry.key);
    if (aiKeys.has(entry.key)) {
      problems.push(`settings-schema: key "${entry.key}" overlaps AI_PROVIDERS`);
    }
    if (entry.backupEnum) {
      if (!Array.isArray(entry.backupEnum) || entry.backupEnum.length === 0) {
        problems.push(`settings-schema:${entry.key}: backupEnum must be a non-empty array`);
      } else if (!entry.backupEnum.includes(entry.defaultValue)) {
        problems.push(`settings-schema:${entry.key}: defaultValue ${q(entry.defaultValue)} is not in backupEnum`);
      }
    }
    if (entry.dropOnUnknownEnum && !entry.backupEnum) {
      problems.push(`settings-schema:${entry.key}: dropOnUnknownEnum requires backupEnum`);
    }
    const load = entry.options?.load;
    if (load) {
      if (load.form === "!==false" && entry.defaultValue !== true) {
        problems.push(`settings-schema:${entry.key}: load.form "!==false" requires defaultValue === true`);
      }
      if (load.form === "===true" && typeof entry.defaultValue !== "boolean") {
        problems.push(`settings-schema:${entry.key}: load.form "===true" requires boolean defaultValue`);
      }
      if (load.form === "||literal" && (entry.defaultValue || load.literal) !== entry.defaultValue) {
        problems.push(`settings-schema:${entry.key}: load.form "||literal" (${q(load.literal)}) alters defaultValue ${q(entry.defaultValue)}`);
      }
    }
    const reset = entry.options?.reset;
    if (reset?.mode === "radioFields") {
      const expectedId = `opt-bgsave-${entry.defaultValue}`;
      if (entry.key === "bgSaveMode" && reset.fields?.[expectedId] !== true) {
        problems.push(`settings-schema:${entry.key}: radioFields does not mark ${expectedId} true`);
      }
    }
  }

  const urlCleanEntry = SETTINGS_SCHEMA.find((e) => e.key === "urlClean");
  if (!urlCleanEntry) {
    problems.push("settings-schema: missing urlClean entry");
  } else {
    for (const c of URL_CLEAN_CONTROLS) {
      const actual = urlCleanEntry.defaultValue[c.prop];
      if (JSON.stringify(actual) !== JSON.stringify(c.defaultValue)) {
        problems.push(`settings-schema:urlClean.${c.prop}: URL_CLEAN_CONTROLS default ${q(c.defaultValue)} !== ${q(actual)}`);
      }
    }
  }

  return problems;
}

// ---- Region renderers ----

function renderSettingsDefaultsSection(section) {
  const regionName = `settings-defaults-${section}`;
  const lines = [`  // @generated:settings-schema start (${regionName})`];
  for (const e of SETTINGS_SCHEMA.filter((x) => x.section === section)) {
    lines.push(`  ${e.key}: ${formatJsValue(e.defaultValue)},`);
  }
  lines.push(`  // @generated:settings-schema end (${regionName})`);
  return lines.join("\n");
}

function renderPrimeExcludedKeys() {
  const keys = SETTINGS_SCHEMA
    .filter((e) => e.primeExcluded)
    .sort((a, b) => (a.primeExcludedOrder || 0) - (b.primeExcludedOrder || 0))
    .map((e) => q(e.key));
  return [
    "// @generated:settings-schema start (prime-excluded-keys)",
    `const PRIME_EXCLUDED_KEYS = [${keys.join(", ")}];`,
    "// @generated:settings-schema end (prime-excluded-keys)",
  ].join("\n");
}

function renderApiKeyFieldsSection(secretSection) {
  const regionName = `api-key-fields-${secretSection}`;
  const keys = SETTINGS_SCHEMA
    .filter((e) => e.secret && e.secretSection === secretSection)
    .map((e) => q(e.key));
  return [
    `  // @generated:settings-schema start (${regionName})`,
    `  ${keys.join(", ")},`,
    `  // @generated:settings-schema end (${regionName})`,
  ].join("\n");
}

function renderBackupEnums() {
  const schemaEnums = SETTINGS_SCHEMA
    .filter((e) => e.backupEnum)
    .sort((a, b) => (a.backupEnumOrder || 0) - (b.backupEnumOrder || 0));

  const lines = [
    "// @generated:settings-schema start (backup-enums)",
    "const PBP_BACKUP_ENUMS = Object.freeze({",
  ];
  for (const e of schemaEnums.filter((x) => (x.backupEnumOrder || 0) < 10)) {
    lines.push(`  ${e.key}: ${formatJsValue(e.backupEnum)},`);
  }
  const dropKeys = [];
  for (const p of AI_PROVIDERS) {
    if (p.regionField) {
      lines.push(`  ${p.regionField}: ${formatJsValue(Object.keys(p.regions))},`);
      dropKeys.push(p.regionField);
    }
  }
  for (const p of AI_PROVIDERS) {
    if (p.protocolField) {
      lines.push(`  ${p.protocolField}: ["openai", "anthropic"],`);
      dropKeys.push(p.protocolField);
    }
  }
  for (const e of schemaEnums.filter((x) => (x.backupEnumOrder || 0) >= 10)) {
    lines.push(`  ${e.key}: ${formatJsValue(e.backupEnum)},`);
    if (e.dropOnUnknownEnum) dropKeys.push(e.key);
  }
  for (const e of schemaEnums.filter((x) => (x.backupEnumOrder || 0) < 10 && x.dropOnUnknownEnum)) {
    dropKeys.push(e.key);
  }
  lines.push("});");
  lines.push("");
  lines.push("const PBP_BACKUP_DROP_ON_UNKNOWN_ENUM = new Set([");
  lines.push(`  ${dropKeys.map(q).join(", ")},`);
  lines.push("]);");
  lines.push("// @generated:settings-schema end (backup-enums)");
  return lines.join("\n");
}

function formatPanelKey(panelName) {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(panelName) ? panelName : q(panelName);
}

function renderSinglePanelDefault(panelName) {
  const pMeta = PANEL_SCHEMA[panelName];
  const fieldItems = (pMeta.extraFields || []).map((x) => ({
    order: x.order,
    entries: [[x.domId, x.value]],
  }));
  const radios = [];
  let hasUrlCleanNested = false;
  const skipItems = [];

  for (const e of SETTINGS_SCHEMA) {
    if (e.options?.panel !== panelName) continue;
    const r = e.options.reset;
    if (!r || r.mode === "allowlist" || r.mode === "panelNoReset") continue;
    if (r.mode === "field") {
      const val = Object.hasOwn(r, "value") ? r.value : e.defaultValue;
      fieldItems.push({ order: r.order, entries: [[e.options.domId, val]] });
    } else if (r.mode === "radioFields") {
      fieldItems.push({ order: r.order, entries: Object.entries(r.fields) });
    } else if (r.mode === "radio") {
      const val = Object.hasOwn(r, "value") ? r.value : e.defaultValue;
      radios.push([e.options.radioName, val]);
    } else if (r.mode === "nested" && r.group === "urlClean") {
      hasUrlCleanNested = true;
    } else if (r.mode === "skip") {
      skipItems.push({ order: r.order, domId: e.options.domId });
    }
  }

  fieldItems.sort((a, b) => a.order - b.order);
  const allFields = fieldItems.flatMap((x) => x.entries);
  const skipIds = [
    ...skipItems.sort((a, b) => a.order - b.order).map((x) => x.domId),
    ...(pMeta.nonSettingSkip || []),
  ];

  const lines = [`    ${formatPanelKey(panelName)}: {`];
  lines.push("      fields: {");
  for (const [domId, val] of allFields) {
    lines.push(`        ${q(domId)}: ${formatJsValue(val)},`);
  }
  lines.push("      },");
  if (radios.length > 0) {
    lines.push(`      radios: { ${radios.map(([n, v]) => `${q(n)}: ${formatJsValue(v)}`).join(", ")} },`);
  }
  if (hasUrlCleanNested) {
    lines.push("      nested: {");
    lines.push("        urlClean: {");
    for (const c of URL_CLEAN_CONTROLS) {
      lines.push(`          ${q(c.domId)}: ${formatJsValue(c.defaultValue)},`);
    }
    lines.push("        },");
    lines.push("      },");
  }
  if (pMeta.keepsSecrets) {
    lines.push("      keepsSecrets: true,");
  }
  if (skipIds.length > 0) {
    lines.push(`      skip: [${skipIds.map(q).join(", ")}],`);
  }
  if (pMeta.afterHook) {
    lines.push(`      after: ${pMeta.afterHook},`);
  }
  lines.push("    },");
  return lines.join("\n");
}

function renderPanelDefaultsGroup(position) {
  const regionName = `panel-defaults-${position}`;
  const panels = Object.entries(PANEL_SCHEMA)
    .filter(([, meta]) => meta.hasReset && meta.position === position)
    .map(([name]) => name);
  const lines = [`    // @generated:settings-schema start (${regionName})`];
  for (const name of panels) {
    lines.push(renderSinglePanelDefault(name));
  }
  lines.push(`    // @generated:settings-schema end (${regionName})`);
  return lines.join("\n");
}

function renderPanelDefaultsAiFieldsHead() {
  const aiFields = SETTINGS_SCHEMA
    .filter((e) => e.options?.panel === "ai" && e.options.reset?.mode === "field")
    .sort((a, b) => a.options.reset.order - b.options.reset.order);
  const lines = ["        // @generated:settings-schema start (panel-defaults-ai-fields-head)"];
  for (const e of aiFields) {
    const val = Object.hasOwn(e.options.reset, "value") ? e.options.reset.value : e.defaultValue;
    lines.push(`        ${q(e.options.domId)}: ${formatJsValue(val)},`);
  }
  lines.push("        // @generated:settings-schema end (panel-defaults-ai-fields-head)");
  return lines.join("\n");
}

function renderPanelDefaultsAiSkipTail() {
  const skipIds = PANEL_SCHEMA.ai.nonSettingSkip || [];
  return [
    "        // @generated:settings-schema start (panel-defaults-ai-skip-tail)",
    `        ${skipIds.map(q).join(", ")},`,
    "        // @generated:settings-schema end (panel-defaults-ai-skip-tail)",
  ].join("\n");
}

function formatLoadExpr(entry) {
  const load = entry.options.load;
  if (load.form === "bare") return `s.${entry.key}`;
  if (load.form === "!==false") return `s.${entry.key} !== false`;
  if (load.form === "===true") return `s.${entry.key} === true`;
  if (load.form === "||literal") return `s.${entry.key} || ${q(load.literal)}`;
  if (load.form === "customExpr") return load.expr;
  throw new Error(`Unknown load.form "${load.form}" on ${entry.key}`);
}

function renderFieldMapSection(section) {
  const regionName = `field-map-${section}`;
  const items = [
    ...SETTINGS_SCHEMA
      .filter((e) => e.options?.load?.map === "fieldMap" && e.options.load.section === section)
      .map((e) => ({ order: e.options.load.order, domId: e.options.domId, expr: formatLoadExpr(e) })),
    ...NON_SETTING_FIELD_MAP_ENTRIES
      .filter((x) => x.section === section)
      .map((x) => ({ order: x.order, domId: x.domId, expr: x.expr })),
  ].sort((a, b) => a.order - b.order);

  const lines = [`    // @generated:settings-schema start (${regionName})`];
  for (const item of items) {
    lines.push(`    ${q(item.domId)}: ${item.expr},`);
  }
  lines.push(`    // @generated:settings-schema end (${regionName})`);
  return lines.join("\n");
}

function renderCheckMap() {
  const items = SETTINGS_SCHEMA
    .filter((e) => e.options?.load?.map === "checkMap")
    .sort((a, b) => a.options.load.order - b.options.load.order);

  const lines = ["    // @generated:settings-schema start (check-map)"];
  for (const e of items) {
    lines.push(`    ${q(e.options.domId)}: ${formatLoadExpr(e)},`);
  }
  lines.push("    // @generated:settings-schema end (check-map)");
  return lines.join("\n");
}

function formatCollectExpr(entry) {
  const c = entry.options.collect;
  const domId = entry.options.domId;
  if (c.kind === "checked") return `$id(${q(domId)}).checked`;
  if (c.kind === "value") return `$id(${q(domId)}).value`;
  if (c.kind === "trim") return `$id(${q(domId)}).value.trim()`;
  if (c.kind === "trimOrDefault") return `$id(${q(domId)}).value.trim() || ${q(entry.defaultValue)}`;
  if (c.kind === "secret") return `obfuscateKey($id(${q(domId)}).value.trim())`;
  if (c.kind === "radio") {
    return `document.querySelector('input[name="${entry.options.radioName}"]:checked')?.value || ${q(entry.defaultValue)}`;
  }
  throw new Error(`Unknown declarative collect.kind "${c.kind}" on ${entry.key}`);
}

function renderCollectFormSection(section) {
  const regionName = `collect-form-${section}`;
  const items = SETTINGS_SCHEMA
    .filter((e) => e.options?.collect?.section === section)
    .sort((a, b) => a.options.collect.order - b.options.collect.order);

  const lines = [`      // @generated:settings-schema start (${regionName})`];
  for (const e of items) {
    lines.push(`      ${e.key}: ${formatCollectExpr(e)},`);
  }
  lines.push(`      // @generated:settings-schema end (${regionName})`);
  return lines.join("\n");
}

export const REGION_SPECS = [
  { file: "shared.js", region: "settings-defaults-head", render: () => renderSettingsDefaultsSection("head") },
  { file: "shared.js", region: "settings-defaults-tail", render: () => renderSettingsDefaultsSection("tail") },
  { file: "shared.js", region: "prime-excluded-keys", render: renderPrimeExcludedKeys },
  { file: "shared.js", region: "api-key-fields-head", render: () => renderApiKeyFieldsSection("head") },
  { file: "shared.js", region: "api-key-fields-tail", render: () => renderApiKeyFieldsSection("tail") },
  { file: "options-backup.js", region: "backup-enums", render: renderBackupEnums },
  { file: "options.js", region: "panel-defaults-before-ai", render: () => renderPanelDefaultsGroup("before-ai") },
  { file: "options.js", region: "panel-defaults-ai-fields-head", render: renderPanelDefaultsAiFieldsHead },
  { file: "options.js", region: "panel-defaults-ai-skip-tail", render: renderPanelDefaultsAiSkipTail },
  { file: "options.js", region: "panel-defaults-after-ai", render: () => renderPanelDefaultsGroup("after-ai") },
  { file: "options.js", region: "field-map-head", render: () => renderFieldMapSection("head") },
  { file: "options.js", region: "field-map-tail", render: () => renderFieldMapSection("tail") },
  { file: "options.js", region: "check-map", render: renderCheckMap },
  { file: "options.js", region: "collect-form-head", render: () => renderCollectFormSection("head") },
  { file: "options.js", region: "collect-form-tail", render: () => renderCollectFormSection("tail") },
];

function markerRegex(region) {
  return new RegExp(
    `^[ \\t]*// @generated:settings-schema start \\(${region}\\)[\\s\\S]*?^[ \\t]*// @generated:settings-schema end \\(${region}\\)`,
    "m",
  );
}

// ---- options.html static default sync & Reset/Checkbox DOM coverage ----

function syncCheckboxAttr(html, domId, expectedChecked, htmlDrift, missing) {
  const tagRe = new RegExp(`<input\\b[^>]*\\bid="${domId}"[^>]*>`, "g");
  const matches = [...html.matchAll(tagRe)];
  if (matches.length !== 1) {
    missing.push(`options.html: expected 1 <input id="${domId}">, found ${matches.length}`);
    return html;
  }
  const tag = matches[0][0];
  const hasChecked = /\bchecked\b/.test(tag);
  if (hasChecked === expectedChecked) return html;
  htmlDrift.push(`options.html:${domId} checked=${hasChecked} (expected ${expectedChecked})`);
  let updatedTag;
  if (expectedChecked) {
    updatedTag = /\/>$/.test(tag)
      ? tag.replace(/\s*\/>$/, " checked />")
      : tag.replace(/>$/, " checked>");
  } else {
    updatedTag = tag.replace(/\s+\bchecked(?:="[^"]*")?/, "");
  }
  return html.slice(0, matches[0].index) + updatedTag + html.slice(matches[0].index + tag.length);
}

function checkOrSyncValueControl(html, domId, expectedStr, htmlDrift, missing) {
  const selRe = new RegExp(`<select\\b[^>]*\\bid="${domId}"[^>]*>([\\s\\S]*?)</select>`, "g");
  const selMatches = [...html.matchAll(selRe)];
  if (selMatches.length === 1) {
    let selected = null;
    let first = null;
    for (const om of selMatches[0][1].matchAll(/<option\b([^>]*)>/g)) {
      const val = (om[1].match(/\bvalue="([^"]*)"/) || [])[1] ?? "";
      if (first === null) first = val;
      if (/\bselected\b/.test(om[1])) selected = val;
    }
    const actual = selected !== null ? selected : first;
    if (actual !== expectedStr) {
      htmlDrift.push(`options.html:${domId} <select> default=${q(actual)} (expected ${q(expectedStr)})`);
      const body = selMatches[0][1];
      let foundTarget = false;
      const updatedBody = body.replace(/<option\b([^>]*)>/g, (full, attrs) => {
        const val = (attrs.match(/\bvalue="([^"]*)"/) || [])[1] ?? "";
        const cleanAttrs = attrs.replace(/\s+\bselected(?:="[^"]*")?/, "");
        if (val === expectedStr && !foundTarget) {
          foundTarget = true;
          return `<option${cleanAttrs} selected>`;
        }
        return `<option${cleanAttrs}>`;
      });
      if (foundTarget) {
        const fullSelect = selMatches[0][0];
        const openEnd = fullSelect.indexOf(">") + 1;
        const closeStart = fullSelect.lastIndexOf("</select>");
        const updatedSelect = fullSelect.slice(0, openEnd) + updatedBody + fullSelect.slice(closeStart);
        return html.slice(0, selMatches[0].index) + updatedSelect + html.slice(selMatches[0].index + fullSelect.length);
      }
    }
    return html;
  }

  const inRe = new RegExp(`<input\\b[^>]*\\bid="${domId}"[^>]*>`, "g");
  const inMatches = [...html.matchAll(inRe)];
  if (inMatches.length === 1) {
    const tag = inMatches[0][0];
    const valM = /\bvalue="([^"]*)"/.exec(tag);
    const actual = valM ? valM[1] : "";
    if (actual === expectedStr) return html;
    htmlDrift.push(`options.html:${domId} value=${q(actual)} (expected ${q(expectedStr)})`);
    let updatedTag;
    if (valM) {
      updatedTag = expectedStr === ""
        ? tag.replace(/\s+\bvalue="[^"]*"/, "")
        : tag.replace(/\bvalue="[^"]*"/, `value=${q(expectedStr)}`);
    } else {
      updatedTag = /\/>$/.test(tag)
        ? tag.replace(/\s*\/>$/, ` value=${q(expectedStr)} />`)
        : tag.replace(/>$/, ` value=${q(expectedStr)}>`);
    }
    return html.slice(0, inMatches[0].index) + updatedTag + html.slice(inMatches[0].index + tag.length);
  }

  const taRe = new RegExp(`<textarea\\b[^>]*\\bid="${domId}"[^>]*>([\\s\\S]*?)</textarea>`, "g");
  const taMatches = [...html.matchAll(taRe)];
  if (taMatches.length === 1) {
    const actual = taMatches[0][1];
    if (actual === expectedStr) return html;
    htmlDrift.push(`options.html:${domId} <textarea> body=${q(actual)} (expected ${q(expectedStr)})`);
    const fullTa = taMatches[0][0];
    const openEnd = fullTa.indexOf(">") + 1;
    const closeStart = fullTa.lastIndexOf("</textarea>");
    const updatedTa = fullTa.slice(0, openEnd) + expectedStr + fullTa.slice(closeStart);
    return html.slice(0, taMatches[0].index) + updatedTa + html.slice(taMatches[0].index + fullTa.length);
  }

  missing.push(`options.html: no <input|select|textarea id="${domId}"> found`);
  return html;
}

function checkOrSyncRadioGroup(html, radioName, expectedVal, requireChecked, htmlDrift, missing) {
  const re = new RegExp(`<input\\b[^>]*\\bname="${radioName}"[^>]*>`, "g");
  const matches = [...html.matchAll(re)];
  if (matches.length === 0) {
    missing.push(`options.html: no <input type="radio" name="${radioName}"> found`);
    return html;
  }
  if (!requireChecked) {
    for (const m of matches) {
      const val = (m[0].match(/\bvalue="([^"]*)"/) || [])[1] ?? "";
      if (/\bchecked\b/.test(m[0]) && val !== expectedVal) {
        htmlDrift.push(`options.html:radio[${radioName}] value=${q(val)} is checked (expected default ${q(expectedVal)})`);
      }
    }
    return html;
  }
  let updated = html;
  let offset = 0;
  for (const m of matches) {
    const tag = m[0];
    const val = (tag.match(/\bvalue="([^"]*)"/) || [])[1] ?? "";
    const shouldCheck = val === expectedVal;
    const isChecked = /\bchecked\b/.test(tag);
    if (shouldCheck === isChecked) continue;
    htmlDrift.push(`options.html:radio[${radioName}][value=${q(val)}] checked=${isChecked} (expected ${shouldCheck})`);
    const newTag = shouldCheck
      ? (/\/>$/.test(tag) ? tag.replace(/\s*\/>$/, " checked />") : tag.replace(/>$/, " checked>"))
      : tag.replace(/\s+\bchecked(?:="[^"]*")?/, "");
    const idx = m.index + offset;
    updated = updated.slice(0, idx) + newTag + updated.slice(idx + tag.length);
    offset += newTag.length - tag.length;
  }
  return updated;
}

export function checkOptionsHtmlCoverage(html) {
  const problems = [];

  // Build per-panel expected reset sets from SETTINGS_SCHEMA + AI_PROVIDERS + PANEL_SCHEMA
  const panelKnownIds = new Map();
  const panelRadioNames = new Map();
  for (const [panelName, pMeta] of Object.entries(PANEL_SCHEMA)) {
    if (!pMeta.hasReset) continue;
    const ids = new Set([
      ...(pMeta.extraFields || []).map((x) => x.domId),
      ...(pMeta.nonSettingSkip || []),
      ...Object.keys(pMeta.resetAllowlist || {}),
    ]);
    const radios = new Set();
    for (const e of SETTINGS_SCHEMA) {
      if (e.options?.panel !== panelName) continue;
      const r = e.options.reset;
      if (!r) continue;
      if (r.mode === "field" || r.mode === "skip" || r.mode === "allowlist") {
        if (e.options.domId) ids.add(e.options.domId);
      } else if (r.mode === "radioFields") {
        for (const id of Object.keys(r.fields)) ids.add(id);
      } else if (r.mode === "radio") {
        radios.add(e.options.radioName);
      } else if (r.mode === "nested" && r.group === "urlClean") {
        for (const c of URL_CLEAN_CONTROLS) ids.add(c.domId);
      }
    }
    if (panelName === "ai") {
      for (const p of AI_PROVIDERS) {
        if (p.keyField) ids.add(`opt-${p.id}-key`);
        if (p.id === "custom") continue;
        ids.add(`opt-${p.id}-model`);
        if (p.baseField) ids.add(`opt-${p.id}-baseurl`);
        if (p.regionField) ids.add(`opt-${p.id}-region`);
        if (p.workspaceDomId) ids.add(p.workspaceDomId);
        if (p.protocolField) ids.add(`opt-${p.id}-protocol`);
      }
    }
    panelKnownIds.set(panelName, ids);
    panelRadioNames.set(panelName, radios);
  }

  // 1. Forward DOM walk per #panel-*
  const panels = [...html.matchAll(/<div id="panel-([a-z-]+)"[^>]*>/g)].map((m) => ({
    name: m[1],
    at: m.index,
  }));
  panels.forEach((p, i) => {
    const body = html.slice(p.at, i + 1 < panels.length ? panels[i + 1].at : html.length);
    const pMeta = PANEL_SCHEMA[p.name];
    if (!pMeta) {
      problems.push(`options.html: panel "${p.name}" has no PANEL_SCHEMA entry`);
      return;
    }
    if (!pMeta.hasReset) return;
    const known = panelKnownIds.get(p.name);
    const radioGroups = panelRadioNames.get(p.name);
    for (const m of body.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      const attrs = m[2];
      const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
      const type = (attrs.match(/\btype="([^"]+)"/) || [])[1] || "";
      if (type === "hidden" || type === "file" || type === "button" || type === "submit") continue;
      if (type === "radio") {
        const name = (attrs.match(/\bname="([^"]+)"/) || [])[1];
        if (radioGroups.has(name) || (id && known.has(id))) continue;
        problems.push(`options.html:${p.name}: radio "${name || id}" missing from PANEL_DEFAULTS/resetAllowlist`);
        continue;
      }
      if (!id || !known.has(id)) {
        problems.push(`options.html:${p.name}: control "${id || `<${m[1]} without id>`}" missing from PANEL_DEFAULTS/resetAllowlist`);
      }
    }
  });

  // 2. Reverse walk: every id / radio group in PANEL_DEFAULTS & resetAllowlist must exist in options.html
  for (const [panelName, ids] of panelKnownIds.entries()) {
    for (const id of ids) {
      if (!html.includes(`id="${id}"`)) {
        problems.push(`options.html:${panelName}: schema/reset control id="${id}" no longer exists in options.html`);
      }
    }
    for (const radioName of panelRadioNames.get(panelName)) {
      if (!html.includes(`name="${radioName}"`)) {
        problems.push(`options.html:${panelName}: schema radio group name="${radioName}" no longer exists in options.html`);
      }
    }
  }

  // 3. DOM-wide checkbox default coverage sweep
  const coveredCheckboxIds = new Set([
    ...SETTINGS_SCHEMA.filter((e) => e.options?.load?.map === "checkMap").map((e) => e.options.domId),
    ...URL_CLEAN_CONTROLS.filter((c) => c.kind === "checkbox").map((c) => c.domId),
  ]);
  for (const m of html.matchAll(/<input\b([^>]*)>/g)) {
    const attrs = m[1];
    if (!/\btype="checkbox"/.test(attrs)) continue;
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (!id || coveredCheckboxIds.has(id) || NON_SETTING_CHECKBOX_ALLOWLIST[id]) continue;
    problems.push(`options.html:${id}: checkbox not covered by SETTINGS_SCHEMA, URL_CLEAN_CONTROLS, or NON_SETTING_CHECKBOX_ALLOWLIST`);
  }
  for (const id of Object.keys(NON_SETTING_CHECKBOX_ALLOWLIST)) {
    if (!html.includes(`id="${id}"`)) {
      problems.push(`options.html:${id}: NON_SETTING_CHECKBOX_ALLOWLIST entry has no control in options.html`);
    }
  }

  // 4. Reverse check on htmlDefault skip allowlist entries
  for (const e of SETTINGS_SCHEMA) {
    if (e.options?.htmlDefault?.check === "skip" && e.options.domId) {
      if (!e.options.htmlDefault.allowlistReason) {
        problems.push(`settings-schema:${e.key}: htmlDefault.check="skip" requires allowlistReason`);
      }
      if (!html.includes(`id="${e.options.domId}"`)) {
        problems.push(`options.html:${e.options.domId}: htmlDefault skip entry has no control in options.html`);
      }
    }
  }
  for (const x of NON_SETTING_FIELD_MAP_ENTRIES) {
    if (!html.includes(`id="${x.domId}"`)) {
      problems.push(`options.html:${x.domId}: NON_SETTING_FIELD_MAP_ENTRIES entry has no control in options.html`);
    }
  }

  return problems;
}

// ---- AST "no unschema'd setting" gate ----

const ALL_GENERATED_BLOCKS_RE = /^[ \t]*\/\/ @generated:(?:settings-schema|ai-providers) start \(([a-z0-9-]+)\)[\s\S]*?^[ \t]*\/\/ @generated:(?:settings-schema|ai-providers) end \(\1\)/gm;

function stripAllGeneratedPreservingLines(source) {
  return source.replace(ALL_GENERATED_BLOCKS_RE, (block) => block.replace(/[^\n]/g, ""));
}

function visitAst(node, fn, parents = []) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") fn(node, parents);
  const nextParents = typeof node.type === "string" ? [...parents, node] : parents;
  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) visitAst(item, fn, nextParents);
    } else if (child && typeof child.type === "string") {
      visitAst(child, fn, nextParents);
    }
  }
}

function propKeyName(prop) {
  if (!prop || prop.type !== "Property" || prop.computed) return null;
  if (prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "Literal") return String(prop.key.value);
  return null;
}

export function findSchemaAstViolations(root = DEFAULT_ROOT) {
  const violations = [];

  // 1. shared.js: SETTINGS_DEFAULTS and API_KEY_FIELDS must have 0 hand-written entries outside @generated
  {
    const file = "shared.js";
    const stripped = stripAllGeneratedPreservingLines(readFileSync(join(root, file), "utf8"));
    let ast;
    try {
      ast = espree.parse(stripped, { ecmaVersion: "latest", sourceType: "script", loc: true });
    } catch (err) {
      violations.push({
        file,
        line: err.lineNumber || 1,
        rule: "ast-parse-error",
        message: `${file}:${err.lineNumber || 1}: failed to parse after stripping @generated blocks: ${err.message}`,
      });
    }
    if (ast) {
      let sawDefaults = false;
      let sawApiKeys = false;
      visitAst(ast, (node) => {
        if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") return;
        const name = node.id.name;
        if (name === "SETTINGS_DEFAULTS") {
          sawDefaults = true;
          if (node.init?.type !== "ObjectExpression") {
            violations.push({
              file,
              line: node.loc.start.line,
              rule: "settings-defaults-shape",
              message: `${file}:${node.loc.start.line}: SETTINGS_DEFAULTS must remain a plain mutable ObjectExpression literal`,
            });
            return;
          }
          for (const prop of node.init.properties) {
            const k = propKeyName(prop) || "<computed>";
            violations.push({
              file,
              line: prop.loc.start.line,
              rule: "unschemad-settings-default",
              message: `${file}:${prop.loc.start.line}: hand-written key "${k}" in SETTINGS_DEFAULTS outside @generated blocks (add to scripts/settings-schema.mjs)`,
            });
          }
        } else if (name === "API_KEY_FIELDS") {
          sawApiKeys = true;
          if (node.init?.type !== "ArrayExpression") {
            violations.push({
              file,
              line: node.loc.start.line,
              rule: "api-key-fields-shape",
              message: `${file}:${node.loc.start.line}: API_KEY_FIELDS must be an ArrayExpression`,
            });
            return;
          }
          for (const el of node.init.elements) {
            if (!el) continue;
            const val = el.type === "Literal" ? String(el.value) : "<expr>";
            violations.push({
              file,
              line: el.loc.start.line,
              rule: "unschemad-api-key-field",
              message: `${file}:${el.loc.start.line}: hand-written secret "${val}" in API_KEY_FIELDS outside @generated blocks`,
            });
          }
        } else if (name === "PRIME_EXCLUDED_KEYS") {
          violations.push({
            file,
            line: node.loc.start.line,
            rule: "unschemad-prime-excluded",
            message: `${file}:${node.loc.start.line}: hand-written PRIME_EXCLUDED_KEYS outside @generated:settings-schema`,
          });
        }
      });
      if (!sawDefaults) violations.push({ file, line: 1, rule: "missing-settings-defaults", message: `${file}: missing SETTINGS_DEFAULTS` });
      if (!sawApiKeys) violations.push({ file, line: 1, rule: "missing-api-key-fields", message: `${file}: missing API_KEY_FIELDS` });
    }
  }

  // 2. options-backup.js: PBP_BACKUP_ENUMS & PBP_BACKUP_DROP_ON_UNKNOWN_ENUM must live inside @generated
  {
    const file = "options-backup.js";
    const stripped = stripAllGeneratedPreservingLines(readFileSync(join(root, file), "utf8"));
    let ast;
    try {
      ast = espree.parse(stripped, { ecmaVersion: "latest", sourceType: "script", loc: true });
    } catch (err) {
      violations.push({
        file,
        line: err.lineNumber || 1,
        rule: "ast-parse-error",
        message: `${file}:${err.lineNumber || 1}: failed to parse after stripping @generated blocks: ${err.message}`,
      });
    }
    if (ast) {
      visitAst(ast, (node) => {
        if (node.type === "VariableDeclarator" && (node.id?.name === "PBP_BACKUP_ENUMS" || node.id?.name === "PBP_BACKUP_DROP_ON_UNKNOWN_ENUM")) {
          violations.push({
            file,
            line: node.loc.start.line,
            rule: "unschemad-backup-enum",
            message: `${file}:${node.loc.start.line}: hand-written ${node.id.name} outside @generated:settings-schema`,
          });
        }
      });
    }
  }

  // 3. options.js: PANEL_DEFAULTS, fieldMap, checkMap stripped check + collectSettingsFromForm full AST check
  {
    const file = "options.js";
    const raw = readFileSync(join(root, file), "utf8");
    const stripped = stripAllGeneratedPreservingLines(raw);
    let strippedAst;
    try {
      strippedAst = espree.parse(stripped, { ecmaVersion: "latest", sourceType: "script", loc: true });
    } catch (err) {
      violations.push({
        file,
        line: err.lineNumber || 1,
        rule: "ast-parse-error",
        message: `${file}:${err.lineNumber || 1}: failed to parse after stripping @generated blocks: ${err.message}`,
      });
    }
    if (strippedAst) {
      let sawPanelDefaults = false;
      let sawFieldMap = false;
      let sawCheckMap = false;
      visitAst(strippedAst, (node) => {
        if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") return;
        const name = node.id.name;
        if (name === "PANEL_DEFAULTS") {
          sawPanelDefaults = true;
          if (node.init?.type !== "ObjectExpression") {
            violations.push({
              file,
              line: node.loc.start.line,
              rule: "panel-defaults-shape",
              message: `${file}:${node.loc.start.line}: PANEL_DEFAULTS must remain a plain ObjectExpression`,
            });
            return;
          }
          for (const prop of node.init.properties) {
            const pName = propKeyName(prop);
            if (pName !== "ai") {
              violations.push({
                file,
                line: prop.loc.start.line,
                rule: "unschemad-panel-default",
                message: `${file}:${prop.loc.start.line}: hand-written panel "${pName || "<computed>"}" in PANEL_DEFAULTS outside @generated blocks`,
              });
              continue;
            }
            if (prop.value?.type === "ObjectExpression") {
              for (const aiProp of prop.value.properties) {
                const k = propKeyName(aiProp);
                if (k === "fields" && aiProp.value?.type === "ObjectExpression") {
                  for (const fp of aiProp.value.properties) {
                    violations.push({
                      file,
                      line: fp.loc.start.line,
                      rule: "unschemad-panel-default-field",
                      message: `${file}:${fp.loc.start.line}: hand-written PANEL_DEFAULTS.ai.fields entry "${propKeyName(fp)}" outside @generated blocks`,
                    });
                  }
                } else if (k === "skip" && aiProp.value?.type === "ArrayExpression") {
                  for (const se of aiProp.value.elements) {
                    if (!se) continue;
                    violations.push({
                      file,
                      line: se.loc.start.line,
                      rule: "unschemad-panel-default-skip",
                      message: `${file}:${se.loc.start.line}: hand-written PANEL_DEFAULTS.ai.skip entry outside @generated blocks`,
                    });
                  }
                } else if (k !== "keepsSecrets") {
                  violations.push({
                    file,
                    line: aiProp.loc.start.line,
                    rule: "unschemad-panel-default-prop",
                    message: `${file}:${aiProp.loc.start.line}: unexpected property "${k}" in PANEL_DEFAULTS.ai`,
                  });
                }
              }
            }
          }
        } else if (name === "fieldMap" || name === "checkMap") {
          if (name === "fieldMap") sawFieldMap = true;
          if (name === "checkMap") sawCheckMap = true;
          if (node.init?.type === "ObjectExpression") {
            for (const prop of node.init.properties) {
              violations.push({
                file,
                line: prop.loc.start.line,
                rule: `unschemad-${name}`,
                message: `${file}:${prop.loc.start.line}: hand-written entry "${propKeyName(prop)}" in ${name} outside @generated:settings-schema`,
              });
            }
          }
        }
      });
      if (!sawPanelDefaults) violations.push({ file, line: 1, rule: "missing-panel-defaults", message: `${file}: missing PANEL_DEFAULTS` });
      if (!sawFieldMap) violations.push({ file, line: 1, rule: "missing-field-map", message: `${file}: missing fieldMap` });
      if (!sawCheckMap) violations.push({ file, line: 1, rule: "missing-check-map", message: `${file}: missing checkMap` });
    }

    // Parse full options.js to validate PANEL_DEFAULTS after() hooks and collectSettingsFromForm()
    let fullAst;
    try {
      fullAst = espree.parse(raw, { ecmaVersion: "latest", sourceType: "script", loc: true });
    } catch (_) {}
    if (fullAst) {
      const validSettingKeys = new Set([
        ...SETTINGS_SCHEMA.map((e) => e.key),
        ...aiProviderSettingKeys(),
      ]);
      const customSpreadKeys = new Set([
        "customDisplayName", "customProtocol", "aiCustomProviders",
        "customApiKey2", "customApiKey3", "customApiKey4", "customApiKey5",
        "customApiKey6", "customApiKey7", "customApiKey8",
      ]);

      let sawCollectFn = false;
      visitAst(fullAst, (node) => {
        if (node.type === "VariableDeclarator" && node.id?.name === "PANEL_DEFAULTS" && node.init?.type === "ObjectExpression") {
          for (const [panelName, pMeta] of Object.entries(PANEL_SCHEMA)) {
            if (!pMeta.afterHook) continue;
            const panelProp = node.init.properties.find((p) => propKeyName(p) === panelName);
            const afterProp = panelProp?.value?.type === "ObjectExpression"
              ? panelProp.value.properties.find((p) => propKeyName(p) === "after")
              : null;
            if (!afterProp || !["ArrowFunctionExpression", "FunctionExpression"].includes(afterProp.value?.type)) {
              violations.push({
                file,
                line: node.loc.start.line,
                rule: "missing-panel-after-hook",
                message: `${file}:${node.loc.start.line}: PANEL_DEFAULTS.${panelName} lacks required after() hook`,
              });
            }
          }
        }

        if (node.type === "FunctionDeclaration" && node.id?.name === "collectSettingsFromForm") {
          sawCollectFn = true;
          const retStmt = node.body.body.find((s) => s.type === "ReturnStatement");
          if (!retStmt || retStmt.argument?.type !== "ObjectExpression") {
            violations.push({
              file,
              line: node.loc.start.line,
              rule: "collect-return-shape",
              message: `${file}:${node.loc.start.line}: collectSettingsFromForm must return an ObjectExpression`,
            });
            return;
          }
          const collectedDirect = new Set();
          for (const prop of retStmt.argument.properties) {
            if (prop.type === "SpreadElement") continue;
            const k = propKeyName(prop);
            if (!k) continue;
            collectedDirect.add(k);
            if (!validSettingKeys.has(k)) {
              violations.push({
                file,
                line: prop.loc.start.line,
                rule: "collect-unknown-key",
                message: `${file}:${prop.loc.start.line}: collectSettingsFromForm returns unknown key "${k}" not in SETTINGS_DEFAULTS`,
              });
            }
          }
          for (const e of SETTINGS_SCHEMA) {
            if (!e.options?.collect) continue;
            if (customSpreadKeys.has(e.key) || e.key === "popupWidth") continue;
            if (!collectedDirect.has(e.key)) {
              violations.push({
                file,
                line: node.loc.start.line,
                rule: "collect-missing-key",
                message: `${file}:${node.loc.start.line}: collectSettingsFromForm is missing schema key "${e.key}"`,
              });
            }
          }
        }
      });
      if (!sawCollectFn) {
        violations.push({ file, line: 1, rule: "missing-collect-fn", message: `${file}: missing collectSettingsFromForm` });
      }
    }
  }

  return violations;
}

// ---- Orchestrator ----

export function syncSettingsSchema({ root = DEFAULT_ROOT, write = false } = {}) {
  const schemaProblems = validateSettingsSchema();

  const byFile = new Map();
  for (const spec of REGION_SPECS) {
    if (!byFile.has(spec.file)) byFile.set(spec.file, []);
    byFile.get(spec.file).push(spec);
  }

  const drifted = [];
  const missing = [];
  const htmlDrift = [];
  const updatedFiles = [];

  for (const [relFile, specs] of byFile.entries()) {
    const absPath = join(root, relFile);
    let content = readFileSync(absPath, "utf8");
    const original = content;

    for (const spec of specs) {
      const re = markerRegex(spec.region);
      const match = re.exec(content);
      if (!match) {
        missing.push(`${relFile}: missing @generated:settings-schema block (${spec.region})`);
        continue;
      }
      const expected = spec.render();
      if (match[0] !== expected) {
        drifted.push(`${relFile}: @generated:settings-schema (${spec.region}) is out of date`);
        content = content.slice(0, match.index) + expected + content.slice(match.index + match[0].length);
      }
    }

    if (write && content !== original) {
      writeFileSync(absPath, content, "utf8");
      updatedFiles.push(relFile);
    }
  }

  // Sync / verify options.html static defaults and DOM coverage
  const htmlPath = join(root, "options.html");
  let htmlContent = readFileSync(htmlPath, "utf8");
  const originalHtml = htmlContent;

  for (const e of SETTINGS_SCHEMA) {
    const hd = e.options?.htmlDefault;
    if (!hd || hd.check === "skip") continue;
    if (hd.check === "checkbox") {
      htmlContent = syncCheckboxAttr(htmlContent, e.options.domId, Boolean(e.defaultValue), htmlDrift, missing);
    } else if (hd.check === "value") {
      htmlContent = checkOrSyncValueControl(htmlContent, e.options.domId, String(e.defaultValue ?? ""), htmlDrift, missing);
    } else if (hd.check === "radioChecked") {
      htmlContent = checkOrSyncRadioGroup(htmlContent, e.options.radioName, String(e.defaultValue), true, htmlDrift, missing);
    } else if (hd.check === "radioUnchecked") {
      htmlContent = checkOrSyncRadioGroup(htmlContent, e.options.radioName, String(e.defaultValue), false, htmlDrift, missing);
    } else if (hd.check === "nestedUrlClean") {
      for (const c of URL_CLEAN_CONTROLS) {
        if (c.kind === "checkbox") {
          htmlContent = syncCheckboxAttr(htmlContent, c.domId, Boolean(c.defaultValue), htmlDrift, missing);
        } else if (c.kind === "textarea-lines") {
          htmlContent = checkOrSyncValueControl(htmlContent, c.domId, c.defaultValue.join("\n"), htmlDrift, missing);
        }
      }
    }
  }

  if (write && htmlContent !== originalHtml) {
    writeFileSync(htmlPath, htmlContent, "utf8");
    updatedFiles.push("options.html");
  }

  const coverageProblems = checkOptionsHtmlCoverage(htmlContent);
  const astViolations = findSchemaAstViolations(root);

  const ok = schemaProblems.length === 0
    && missing.length === 0
    && coverageProblems.length === 0
    && (write ? true : (drifted.length === 0 && htmlDrift.length === 0))
    && astViolations.length === 0;

  return {
    ok,
    schemaProblems,
    drifted,
    missing,
    htmlDrift,
    coverageProblems,
    astViolations,
    updatedFiles,
  };
}

export function checkSettingsSchemaSync(root = DEFAULT_ROOT) {
  const res = syncSettingsSchema({ root, write: false });
  const problems = [
    ...res.schemaProblems,
    ...res.missing,
    ...res.drifted,
    ...res.htmlDrift,
    ...res.coverageProblems,
    ...res.astViolations.map((v) => v.message),
  ];
  return { ok: problems.length === 0, problems, ...res };
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const write = args.has("--write");
  if (args.size > 0 && !write && !args.has("--check")) {
    console.error("Usage: node scripts/sync-settings-schema.mjs [--check | --write]");
    process.exit(2);
  }
  const res = syncSettingsSchema({ root: DEFAULT_ROOT, write });
  if (write) {
    if (res.updatedFiles.length > 0) {
      console.log(`[settings-schema] updated ${res.updatedFiles.length} file(s): ${res.updatedFiles.join(", ")}`);
    } else {
      console.log("[settings-schema] all generated regions already up to date");
    }
  }
  const errors = [
    ...res.schemaProblems,
    ...res.missing,
    ...(write ? [] : res.drifted),
    ...(write ? [] : res.htmlDrift),
    ...res.coverageProblems,
    ...res.astViolations.map((v) => v.message),
  ];
  if (errors.length > 0) {
    for (const err of errors) console.error(`[settings-schema] ${err}`);
    if (!write && (res.drifted.length > 0 || res.htmlDrift.length > 0)) {
      console.error("[settings-schema] run: node scripts/sync-settings-schema.mjs --write");
    }
    process.exit(1);
  }
  if (!write) {
    console.log(`[settings-schema] OK: ${SETTINGS_SCHEMA.length} settings, ${REGION_SPECS.length} generated regions, 0 drift, 0 DOM coverage gaps, 0 AST violations`);
  }
}
