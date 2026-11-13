#!/usr/bin/env node
// Generates and checks all `@generated:ai-providers` regions and HTML default
// attributes from `scripts/ai-providers-source.mjs`, and enforces an AST
// "no second copy" gate across root runtime `*.js` files.
//
// Usage:
//   node scripts/sync-ai-providers.mjs --check   (default, read-only)
//   node scripts/sync-ai-providers.mjs --write   (updates runtime files)

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_PROVIDERS, AI_PROVIDER_CATALOG_IDS, AI_PROVIDER_FALLBACK_IDS } from "./ai-providers-source.mjs";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(SELF_DIR, "..");

const require = createRequire(import.meta.url);
const espree = require(join(DEFAULT_ROOT, ".qa-scan/node_modules/espree"));

const q = (s) => JSON.stringify(s);

function formatCompactObject(obj) {
  const parts = Object.entries(obj).map(([k, v]) => (
    v && typeof v === "object" && !Array.isArray(v)
      ? `${k}: ${formatCompactObject(v)}`
      : `${k}: ${q(v)}`
  ));
  return `{ ${parts.join(", ")} }`;
}

// ---- Renderers for each @generated:ai-providers region ----

function renderAiOpenAiCompat() {
  const lines = [
    "// @generated:ai-providers start (openai-compat)",
    "const OPENAI_COMPAT_PROVIDERS = {",
  ];
  for (const p of AI_PROVIDERS.filter((x) => x.kind === "openai-compat")) {
    const props = [
      `keyField: ${q(p.keyField)}`,
      `base: ${q(p.base)}`,
    ];
    if (p.baseField) props.push(`baseField: ${q(p.baseField)}`);
    props.push(`modelField: ${q(p.modelField)}`);
    // Keep defaultModel before nested objects so scripts/update-vendor.sh regex matches.
    props.push(`defaultModel: ${q(p.defaultModel)}`);
    if (p.thinkingOff) props.push(`thinkingOff: ${formatCompactObject(p.thinkingOff)}`);
    if (p.thinkingFallback) props.push(`thinkingFallback: ${formatCompactObject(p.thinkingFallback)}`);
    if (p.tokenField) props.push(`tokenField: ${q(p.tokenField)}`);
    if (p.regionField) {
      props.push(`regionField: ${q(p.regionField)}`);
      props.push(`regions: ${formatCompactObject(p.regions)}`);
    }
    if (p.workspaceField) {
      props.push(`workspaceField: ${q(p.workspaceField)}`);
      props.push(`workspaceRegions: ${formatCompactObject(p.workspaceRegions)}`);
      props.push(`workspaceTemplate: ${q(p.workspaceTemplate)}`);
    }
    if (p.protocolField) {
      props.push(`protocolField: ${q(p.protocolField)}`);
      props.push(`anthropicBase: ${q(p.anthropicBase)}`);
    }
    const suffix = p.comment ? `  // ${p.comment}` : "";
    lines.push(`  ${p.id}: { ${props.join(", ")} },${suffix}`);
  }
  lines.push("};");
  lines.push("// @generated:ai-providers end (openai-compat)");
  return lines.join("\n");
}

function renderAiBespoke() {
  const lines = [
    "// @generated:ai-providers start (bespoke)",
    "const _AI_BESPOKE_PROVIDERS = {",
  ];
  for (const p of AI_PROVIDERS.filter((x) => x.kind === "bespoke")) {
    const props = [
      `protocol: ${q(p.protocol)}`,
      `keyField: ${q(p.keyField)}`,
      `modelField: ${q(p.modelField)}`,
      `defaultModel: ${q(p.defaultModel)}`,
      `base: ${q(p.base)}`,
    ];
    if (p.baseField) props.push(`baseField: ${q(p.baseField)}`);
    lines.push(`  ${p.id}: { ${props.join(", ")} },`);
  }
  lines.push("};");
  lines.push("// @generated:ai-providers end (bespoke)");
  return lines.join("\n");
}

function renderAiStatusPages() {
  const lines = [
    "// @generated:ai-providers start (status-pages)",
    "const PBP_AI_STATUS_PAGES = {",
  ];
  const pages = AI_PROVIDERS
    .filter((x) => x.statusPage)
    .sort((a, b) => a.statusPage.order - b.statusPage.order);
  for (const p of pages) {
    lines.push(`  ${p.id}: { url: ${q(p.statusPage.url)}, name: ${q(p.statusPage.name)} },`);
  }
  lines.push("};");
  lines.push("// @generated:ai-providers end (status-pages)");
  return lines.join("\n");
}

function renderSharedSettingsDefaults() {
  const lines = ["  // @generated:ai-providers start (settings-defaults)"];
  for (const p of AI_PROVIDERS) {
    const entries = [];
    if (p.id === "ollama") {
      entries.push(`${p.baseField}: ${q(p.base)}`);
      entries.push(`${p.modelField}: ${q(p.defaultModel)}`);
    } else {
      if (p.keyField) entries.push(`${p.keyField}: ""`);
      entries.push(`${p.modelField}: ${q(p.defaultModel)}`);
      if (p.baseField) entries.push(`${p.baseField}: ${q(p.base)}`);
      if (p.regionField) entries.push(`${p.regionField}: ${q(p.defaultRegion)}`);
      if (p.workspaceField) entries.push(`${p.workspaceField}: ""`);
      if (p.protocolField) entries.push(`${p.protocolField}: ${q(p.defaultProtocol)}`);
    }
    lines.push(`  ${entries.join(", ")},`);
  }
  lines.push("  // @generated:ai-providers end (settings-defaults)");
  return lines.join("\n");
}

function renderSharedProviderLists() {
  return [
    "// @generated:ai-providers start (provider-lists)",
    `const PBP_AI_PROVIDER_IDS = Object.freeze(${JSON.stringify(AI_PROVIDER_CATALOG_IDS)});`,
    `const PBP_AI_FALLBACK_ORDER = Object.freeze(${JSON.stringify(AI_PROVIDER_FALLBACK_IDS)});`,
    "// @generated:ai-providers end (provider-lists)",
  ].join("\n");
}

function renderSharedApiKeyFields() {
  const keys = AI_PROVIDERS.map((p) => p.keyField).filter(Boolean);
  return [
    "  // @generated:ai-providers start (api-key-fields)",
    `  ${keys.map(q).join(", ")},`,
    "  // @generated:ai-providers end (api-key-fields)",
  ].join("\n");
}

function renderSharedOverrideFields() {
  const modelFields = AI_PROVIDERS.map((p) => p.modelField);
  const baseFields = AI_PROVIDERS.map((p) => p.baseField).filter(Boolean);
  const enumAndWorkspace = AI_PROVIDERS.flatMap((p) => [p.regionField, p.workspaceField, p.protocolField]).filter(Boolean);
  return [
    "  // @generated:ai-providers start (override-fields)",
    `  ${modelFields.map(q).join(", ")},`,
    `  ${baseFields.map(q).join(", ")},`,
    `  ${enumAndWorkspace.map(q).join(", ")},`,
    "  // @generated:ai-providers end (override-fields)",
  ].join("\n");
}

function renderPopupOrder() {
  const labelPairs = AI_PROVIDERS.map((p) => `${p.id}: ${q(p.popupLabel)}`);
  return [
    "// @generated:ai-providers start (popup-order)",
    `const AI_PROVIDER_ORDER = ${JSON.stringify(AI_PROVIDER_FALLBACK_IDS)};`,
    "const AI_PROVIDER_LABEL = {",
    `  ${labelPairs.join(", ")},`,
    "};",
    "// @generated:ai-providers end (popup-order)",
  ].join("\n");
}

function renderOptionsHtmlSelect() {
  const groups = [
    { key: "key", labelKey: "providerGroupKey", label: "Cloud (API key)" },
    { key: "local", labelKey: "providerGroupLocal", label: "Local" },
    { key: "compat", labelKey: "providerGroupCompat", label: "Custom" },
  ];
  const lines = ["          <!-- @generated:ai-providers start (provider-select) -->"];
  for (const g of groups) {
    lines.push(`            <optgroup data-i18n-label="${g.labelKey}" label="${g.label}">`);
    for (const p of AI_PROVIDERS.filter((x) => x.optionsGroup === g.key)) {
      const i18nAttr = p.labelKey ? ` data-i18n="${p.labelKey}"` : "";
      lines.push(`              <option value="${p.id}"${i18nAttr}>${p.optionText}</option>`);
    }
    lines.push("            </optgroup>");
  }
  lines.push("          <!-- @generated:ai-providers end (provider-select) -->");
  return lines.join("\n");
}

function renderOptionsHealthIds() {
  const items = AI_PROVIDERS.map((p) => q(`ai:${p.id}`));
  return [
    "  // @generated:ai-providers start (health-ids)",
    `  ${items.join(", ")},`,
    "  // @generated:ai-providers end (health-ids)",
  ].join("\n");
}

function renderOptionsPanelDefaultsFields() {
  const entries = [];
  for (const p of AI_PROVIDERS) {
    if (p.id === "custom") continue;
    if (p.id === "ollama") {
      entries.push(`${q(`opt-${p.id}-baseurl`)}: ${q(p.base)}`);
      entries.push(`${q(`opt-${p.id}-model`)}: ${q(p.defaultModel)}`);
    } else {
      entries.push(`${q(`opt-${p.id}-model`)}: ${q(p.defaultModel)}`);
      if (p.baseField) entries.push(`${q(`opt-${p.id}-baseurl`)}: ${q(p.base)}`);
      if (p.regionField) entries.push(`${q(`opt-${p.id}-region`)}: ${q(p.defaultRegion)}`);
      if (p.workspaceDomId) entries.push(`${q(p.workspaceDomId)}: ""`);
      if (p.protocolField) entries.push(`${q(`opt-${p.id}-protocol`)}: ${q(p.defaultProtocol)}`);
    }
  }
  return [
    "        // @generated:ai-providers start (panel-defaults-fields)",
    `        ${entries.join(", ")},`,
    "        // @generated:ai-providers end (panel-defaults-fields)",
  ].join("\n");
}

function renderOptionsPanelDefaultsSkip() {
  const keys = AI_PROVIDERS.filter((p) => p.keyField).map((p) => q(`opt-${p.id}-key`));
  return [
    "        // @generated:ai-providers start (panel-defaults-skip)",
    `        ${keys.join(", ")},`,
    "        // @generated:ai-providers end (panel-defaults-skip)",
  ].join("\n");
}

function renderOptionsFieldMap() {
  const lines = ["    // @generated:ai-providers start (field-map)"];
  for (const p of AI_PROVIDERS) {
    if (p.id === "custom") continue;
    const entries = [];
    if (p.id === "ollama") {
      entries.push(`${q(`opt-${p.id}-baseurl`)}: s.${p.baseField}`);
      entries.push(`${q(`opt-${p.id}-model`)}: s.${p.modelField}`);
    } else {
      if (p.keyField) entries.push(`${q(`opt-${p.id}-key`)}: s.${p.keyField}`);
      entries.push(`${q(`opt-${p.id}-model`)}: s.${p.modelField}`);
      if (p.baseField) entries.push(`${q(`opt-${p.id}-baseurl`)}: s.${p.baseField}`);
      if (p.regionField) entries.push(`${q(`opt-${p.id}-region`)}: s.${p.regionField}`);
      if (p.workspaceField) entries.push(`${q(p.workspaceDomId)}: s.${p.workspaceField}`);
      if (p.protocolField) entries.push(`${q(`opt-${p.id}-protocol`)}: s.${p.protocolField}`);
    }
    lines.push(`    ${entries.join(", ")},`);
  }
  lines.push("    // @generated:ai-providers end (field-map)");
  return lines.join("\n");
}

function renderOptionsCollectForm() {
  const lines = ["      // @generated:ai-providers start (collect-form)"];
  for (const p of AI_PROVIDERS) {
    if (p.id === "custom") continue;
    if (p.id === "ollama") {
      lines.push(`      ${p.baseField}: $id(${q(`opt-${p.id}-baseurl`)}).value.trim() || ${q(p.base)},`);
      lines.push(`      ${p.modelField}: $id(${q(`opt-${p.id}-model`)}).value.trim() || ${q(p.defaultModel)},`);
      continue;
    }
    if (p.keyField) lines.push(`      ${p.keyField}: obfuscateKey($id(${q(`opt-${p.id}-key`)}).value.trim()),`);
    lines.push(`      ${p.modelField}: $id(${q(`opt-${p.id}-model`)}).value.trim() || ${q(p.defaultModel)},`);
    if (p.baseField) lines.push(`      ${p.baseField}: $id(${q(`opt-${p.id}-baseurl`)}).value.trim() || ${q(p.base)},`);
    if (p.workspaceField) lines.push(`      ${p.workspaceField}: $id(${q(p.workspaceDomId)}).value.trim(),`);
    if (p.regionField) lines.push(`      ...pbpOptKnownEnumPatch(${q(p.regionField)}, $id(${q(`opt-${p.id}-region`)}).value, Object.keys(OPENAI_COMPAT_PROVIDERS.${p.id}.regions)),`);
    if (p.protocolField) lines.push(`      ...pbpOptKnownEnumPatch(${q(p.protocolField)}, $id(${q(`opt-${p.id}-protocol`)}).value, PBP_AI_PROTOCOLS),`);
  }
  lines.push("      // @generated:ai-providers end (collect-form)");
  return lines.join("\n");
}

function renderOptionsOverviewInputs() {
  const ids = [];
  for (const p of AI_PROVIDERS) {
    if (p.keyField) ids.push(`opt-${p.id}-key`);
    if (p.baseField && (!p.keyField || p.id === "custom")) ids.push(`opt-${p.id}-baseurl`);
    if (p.regionField) ids.push(`opt-${p.id}-region`);
    if (p.workspaceDomId) ids.push(p.workspaceDomId);
    if (p.protocolField) ids.push(`opt-${p.id}-protocol`);
  }
  return [
    "    // @generated:ai-providers start (overview-inputs)",
    `    ${ids.map(q).join(", ")},`,
    "    // @generated:ai-providers end (overview-inputs)",
  ].join("\n");
}

function renderConnectivityLiveSnapshot() {
  const lines = ["    // @generated:ai-providers start (live-snapshot)"];
  for (const p of AI_PROVIDERS) {
    const parts = [];
    if (p.id === "custom") {
      parts.push(`customApiKey: getOptVal("opt-custom-key")`);
      parts.push(`customModel: getOptVal("opt-custom-model")`);
      parts.push(`customBaseUrl: getOptVal("opt-custom-baseurl")`);
    } else if (p.id === "ollama") {
      parts.push(`${p.baseField}: getOptVal(${q(`opt-${p.id}-baseurl`)}, ${q(p.base)})`);
      parts.push(`${p.modelField}: getOptVal(${q(`opt-${p.id}-model`)}, ${q(p.defaultModel)})`);
    } else {
      if (p.keyField) parts.push(`${p.keyField}: getOptVal(${q(`opt-${p.id}-key`)})`);
      parts.push(`${p.modelField}: getOptVal(${q(`opt-${p.id}-model`)}, ${q(p.defaultModel)})`);
      if (p.baseField) parts.push(`${p.baseField}: getOptVal(${q(`opt-${p.id}-baseurl`)}, ${q(p.base)})`);
      if (p.regionField) parts.push(`${p.regionField}: $id(${q(`opt-${p.id}-region`)})?.value ?? ${q(p.defaultRegion)}`);
      if (p.workspaceField) parts.push(`${p.workspaceField}: getOptVal(${q(p.workspaceDomId)})`);
      if (p.protocolField) parts.push(`${p.protocolField}: $id(${q(`opt-${p.id}-protocol`)})?.value ?? ${q(p.defaultProtocol)}`);
    }
    lines.push(`    ${parts.join(", ")},`);
  }
  lines.push("    // @generated:ai-providers end (live-snapshot)");
  return lines.join("\n");
}

const REGION_SPECS = [
  { file: "ai.js", kind: "js", region: "openai-compat", render: renderAiOpenAiCompat },
  { file: "ai.js", kind: "js", region: "bespoke", render: renderAiBespoke },
  { file: "ai.js", kind: "js", region: "status-pages", render: renderAiStatusPages },
  { file: "shared.js", kind: "js", region: "settings-defaults", render: renderSharedSettingsDefaults },
  { file: "shared.js", kind: "js", region: "provider-lists", render: renderSharedProviderLists },
  { file: "shared.js", kind: "js", region: "api-key-fields", render: renderSharedApiKeyFields },
  { file: "shared.js", kind: "js", region: "override-fields", render: renderSharedOverrideFields },
  { file: "popup-ai.js", kind: "js", region: "popup-order", render: renderPopupOrder },
  { file: "options.html", kind: "html", region: "provider-select", render: renderOptionsHtmlSelect },
  { file: "options.js", kind: "js", region: "health-ids", render: renderOptionsHealthIds },
  { file: "options.js", kind: "js", region: "panel-defaults-fields", render: renderOptionsPanelDefaultsFields },
  { file: "options.js", kind: "js", region: "panel-defaults-skip", render: renderOptionsPanelDefaultsSkip },
  { file: "options.js", kind: "js", region: "field-map", render: renderOptionsFieldMap },
  { file: "options.js", kind: "js", region: "collect-form", render: renderOptionsCollectForm },
  { file: "options.js", kind: "js", region: "overview-inputs", render: renderOptionsOverviewInputs },
  { file: "options-connectivity.js", kind: "js", region: "live-snapshot", render: renderConnectivityLiveSnapshot },
];

function markerRegex(kind, region) {
  if (kind === "html") {
    return new RegExp(
      `^[ \\t]*<!-- @generated:ai-providers start \\(${region}\\) -->[\\s\\S]*?^[ \\t]*<!-- @generated:ai-providers end \\(${region}\\) -->`,
      "m",
    );
  }
  return new RegExp(
    `^[ \\t]*// @generated:ai-providers start \\(${region}\\)[\\s\\S]*?^[ \\t]*// @generated:ai-providers end \\(${region}\\)`,
    "m",
  );
}

// ---- options.html input value="..." attribute sync ----

function syncInputValueAttr(html, inputId, expectedValue, driftList, missingList) {
  const tagRe = new RegExp(`<input\\b[^>]*\\bid="${inputId}"[^>]*>`, "g");
  const matches = [...html.matchAll(tagRe)];
  if (matches.length !== 1) {
    missingList.push(`options.html: expected 1 <input id="${inputId}">, found ${matches.length}`);
    return html;
  }
  const tag = matches[0][0];
  const valMatch = /\bvalue="([^"]*)"/.exec(tag);
  if (!valMatch) {
    missingList.push(`options.html: <input id="${inputId}"> has no value="..." attribute`);
    return html;
  }
  if (valMatch[1] === expectedValue) return html;
  driftList.push(`options.html:${inputId} value=${q(valMatch[1])} (expected ${q(expectedValue)})`);
  const updatedTag = tag.replace(/\bvalue="[^"]*"/, `value=${q(expectedValue)}`);
  return html.slice(0, matches[0].index) + updatedTag + html.slice(matches[0].index + tag.length);
}

// ---- AST "no second copy" gate over root runtime *.js files ----

const GENERATED_BLOCK_ANY_RE = /^[ \t]*\/\/ @generated:ai-providers start \(([a-z0-9-]+)\)[\s\S]*?^[ \t]*\/\/ @generated:ai-providers end \(\1\)/gm;

function stripGeneratedPreservingLines(source) {
  return source.replace(GENERATED_BLOCK_ANY_RE, (block) => block.replace(/[^\n]/g, ""));
}

const KNOWN_IDS_PATTERN = AI_PROVIDER_CATALOG_IDS.join("|");
const PROVIDER_TOKEN_RE = new RegExp(
  `^(?:(?:ai:)?(${KNOWN_IDS_PATTERN})|(${KNOWN_IDS_PATTERN})(?:Model|ApiKey)|opt-(${KNOWN_IDS_PATTERN})-(?:key|model|baseurl|region|workspace|protocol)|(?:test|fields)-(${KNOWN_IDS_PATTERN}))$`,
);
const DEFAULT_MODEL_SET = new Set(AI_PROVIDERS.map((p) => p.defaultModel).filter(Boolean));

function matchProviderId(token) {
  const m = PROVIDER_TOKEN_RE.exec(token);
  if (!m) return null;
  return m[1] || m[2] || m[3] || m[4] || null;
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

function isProtocolFinishReasonsTable(file, matched, parents) {
  if (file !== "ai.js" || matched.size !== 4) return false;
  if (!["openai", "gemini", "claude", "ollama"].every((k) => matched.has(k))) return false;
  return parents.some((p) => p.type === "VariableDeclarator" && p.id?.name === "_AI_FINISH_REASONS");
}

export function findSecondCopyViolations(root = DEFAULT_ROOT) {
  const violations = [];
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".js"))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const file = entry.name;
    const raw = readFileSync(join(root, file), "utf8");
    const stripped = stripGeneratedPreservingLines(raw);
    let ast;
    try {
      ast = espree.parse(stripped, { ecmaVersion: "latest", sourceType: "script", loc: true });
    } catch (err) {
      violations.push({
        file,
        line: err.lineNumber || 1,
        rule: "ast-parse-error",
        message: `${file}:${err.lineNumber || 1}: failed to parse after stripping @generated:ai-providers blocks: ${err.message}`,
      });
      continue;
    }

    visitAst(ast, (node, parents) => {
      if (node.type === "ArrayExpression") {
        const matched = new Set();
        for (const el of node.elements) {
          if (el && el.type === "Literal" && typeof el.value === "string") {
            const id = matchProviderId(el.value);
            if (id) matched.add(id);
          }
        }
        if (matched.size >= 4) {
          violations.push({
            file,
            line: node.loc.start.line,
            rule: "array-second-copy",
            message: `${file}:${node.loc.start.line}: hand-written ArrayExpression lists ${matched.size} built-in providers (${[...matched].join(", ")}) outside @generated:ai-providers`,
          });
        }
      } else if (node.type === "ObjectExpression") {
        const matched = new Set();
        for (const prop of node.properties) {
          if (prop.type !== "Property" || prop.computed) continue;
          const keyName = prop.key.type === "Identifier"
            ? prop.key.name
            : (prop.key.type === "Literal" && typeof prop.key.value === "string" ? prop.key.value : "");
          const id = matchProviderId(keyName);
          if (id) matched.add(id);
        }
        if (matched.size >= 4 && !isProtocolFinishReasonsTable(file, matched, parents)) {
          violations.push({
            file,
            line: node.loc.start.line,
            rule: "object-second-copy",
            message: `${file}:${node.loc.start.line}: hand-written ObjectExpression maps ${matched.size} built-in providers (${[...matched].join(", ")}) outside @generated:ai-providers`,
          });
        }
      } else if (node.type === "Literal" && typeof node.value === "string" && DEFAULT_MODEL_SET.has(node.value)) {
        violations.push({
          file,
          line: node.loc.start.line,
          rule: "hardcoded-default-model",
          message: `${file}:${node.loc.start.line}: hardcoded defaultModel literal ${q(node.value)} outside @generated:ai-providers`,
        });
      }
    });
  }
  return violations;
}

// ---- Sync orchestrator ----

export function syncAiProviders({ root = DEFAULT_ROOT, write = false } = {}) {
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
      const re = markerRegex(spec.kind, spec.region);
      const match = re.exec(content);
      if (!match) {
        missing.push(`${relFile}: missing @generated:ai-providers block (${spec.region})`);
        continue;
      }
      const expected = spec.render();
      if (match[0] !== expected) {
        drifted.push(`${relFile}: @generated:ai-providers (${spec.region}) is out of date`);
        content = content.slice(0, match.index) + expected + content.slice(match.index + match[0].length);
      }
    }

    if (relFile === "options.html") {
      for (const p of AI_PROVIDERS) {
        if (p.id !== "custom") {
          content = syncInputValueAttr(content, `opt-${p.id}-model`, p.defaultModel, htmlDrift, missing);
        }
        if (p.baseField && p.base) {
          content = syncInputValueAttr(content, `opt-${p.id}-baseurl`, p.base, htmlDrift, missing);
        }
      }
    }

    if (write && content !== original) {
      writeFileSync(absPath, content, "utf8");
      updatedFiles.push(relFile);
    }
  }

  const astViolations = findSecondCopyViolations(root);
  const ok = missing.length === 0
    && (write ? true : (drifted.length === 0 && htmlDrift.length === 0))
    && astViolations.length === 0;

  return { ok, drifted, missing, htmlDrift, astViolations, updatedFiles };
}

export function checkAiProviderSync(root = DEFAULT_ROOT) {
  const res = syncAiProviders({ root, write: false });
  const problems = [
    ...res.missing,
    ...res.drifted,
    ...res.htmlDrift,
    ...res.astViolations.map((v) => v.message),
  ];
  return { ok: problems.length === 0, problems, ...res };
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const write = args.has("--write");
  if (args.size > 0 && !write && !args.has("--check")) {
    console.error("Usage: node scripts/sync-ai-providers.mjs [--check | --write]");
    process.exit(2);
  }
  const res = syncAiProviders({ root: DEFAULT_ROOT, write });
  if (write) {
    if (res.updatedFiles.length > 0) {
      console.log(`[ai-providers] updated ${res.updatedFiles.length} file(s): ${res.updatedFiles.join(", ")}`);
    } else {
      console.log("[ai-providers] all generated regions already up to date");
    }
  }
  const errors = [
    ...res.missing,
    ...(write ? [] : res.drifted),
    ...(write ? [] : res.htmlDrift),
    ...res.astViolations.map((v) => v.message),
  ];
  if (errors.length > 0) {
    for (const err of errors) console.error(`[ai-providers] ${err}`);
    if (!write && (res.drifted.length > 0 || res.htmlDrift.length > 0)) {
      console.error("[ai-providers] run: node scripts/sync-ai-providers.mjs --write");
    }
    process.exit(1);
  }
  if (!write) {
    console.log(`[ai-providers] OK: ${AI_PROVIDERS.length} providers, ${REGION_SPECS.length} generated regions, 0 drift, 0 AST second-copy hits`);
  }
}
