#!/usr/bin/env node
// Dev-only JSDoc + strictNullChecks gate over the 6 pure data-layer files
// (vocab-store.js, bookmark-services.js, export-targets.js, dict-archive.js,
// ask-archive.js, notes-sync.js). Runs TypeScript's checkJs analyser in-memory
// with noEmit: true — zero build step, zero emitted files, zero runtime deps.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_REL = 'scripts/jsconfig.data-layer.json';
export const GLOBALS_DTS_REL = 'scripts/types/data-layer-globals.d.ts';
export const DATA_LAYER_FILES = Object.freeze([
  'vocab-store.js',
  'bookmark-services.js',
  'export-targets.js',
  'dict-archive.js',
  'ask-archive.js',
  'notes-sync.js',
]);

function loadTypeScript(qaRoot) {
  const pkgPath = join(qaRoot, 'package.json');
  const chromeTypes = join(qaRoot, 'node_modules', '@types', 'chrome', 'index.d.ts');
  if (!existsSync(pkgPath) || !existsSync(chromeTypes)) {
    return { ts: null, error: 'missing @types/chrome in .qa-scan/node_modules; run: npm ci --prefix .qa-scan' };
  }
  try {
    const req = createRequire(pkgPath);
    return { ts: req('typescript'), error: null };
  } catch (err) {
    return {
      ts: null,
      error: `cannot load typescript from .qa-scan/node_modules (${err?.message || err}); run: npm ci --prefix .qa-scan`,
    };
  }
}

function formatDiagnostic(ts, root, diag) {
  const msg = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
  if (!diag.file || typeof diag.start !== 'number') {
    return `TS${diag.code}: ${msg}`;
  }
  const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
  const rel = relative(root, diag.file.fileName).replace(/\\/g, '/');
  return `${rel}:${pos.line + 1}:${pos.character + 1} - error TS${diag.code}: ${msg}`;
}

export function runDataLayerTypecheck({
  root = DEFAULT_ROOT,
  configPath = join(root, CONFIG_REL),
  qaRoot = join(root, '.qa-scan'),
} = {}) {
  const loaded = loadTypeScript(qaRoot);
  if (!loaded.ts) {
    return { ok: false, errors: [loaded.error], codes: [], checkedFiles: 0 };
  }
  const { ts } = loaded;

  if (!existsSync(configPath)) {
    return { ok: false, errors: [`missing config file: ${relative(root, configPath)}`], codes: [], checkedFiles: 0 };
  }

  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  if (raw.error) {
    return {
      ok: false,
      errors: [formatDiagnostic(ts, root, raw.error)],
      codes: [raw.error.code],
      checkedFiles: 0,
    };
  }

  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(configPath));
  const invariantErrors = [];
  if (parsed.options.noEmit !== true) {
    invariantErrors.push(`${CONFIG_REL} must keep compilerOptions.noEmit === true`);
  }
  if (parsed.options.allowJs !== true || parsed.options.checkJs !== true) {
    invariantErrors.push(`${CONFIG_REL} must keep compilerOptions.allowJs === true and checkJs === true`);
  }
  const strictNull = parsed.options.strictNullChecks === true ||
    (parsed.options.strict === true && parsed.options.strictNullChecks !== false);
  if (!strictNull) {
    invariantErrors.push(`${CONFIG_REL} must keep strictNullChecks enabled`);
  }
  if (parsed.options.moduleDetection !== ts.ModuleDetectionKind.Legacy) {
    invariantErrors.push(`${CONFIG_REL} must set compilerOptions.moduleDetection to "legacy" to match classic script globals`);
  }

  const resolvedSet = new Set(parsed.fileNames.map((f) => resolve(f)));
  for (const rel of [GLOBALS_DTS_REL, ...DATA_LAYER_FILES]) {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) {
      invariantErrors.push(`missing required data-layer file: ${rel}`);
    } else if (!resolvedSet.has(abs)) {
      invariantErrors.push(`${CONFIG_REL} files[] omits required entry: ${rel}`);
    }
  }
  if (invariantErrors.length > 0) {
    return { ok: false, errors: invariantErrors, codes: [], checkedFiles: 0 };
  }

  const options = {
    ...parsed.options,
    noEmit: true,
    typeRoots: [join(qaRoot, 'node_modules', '@types')],
  };
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options,
    configFileParsingDiagnostics: parsed.errors,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const errors = diagnostics.map((d) => formatDiagnostic(ts, root, d));
  const codes = diagnostics.map((d) => d.code);

  return {
    ok: errors.length === 0,
    errors,
    codes,
    checkedFiles: DATA_LAYER_FILES.length,
  };
}

function main() {
  const result = runDataLayerTypecheck();
  if (!result.ok) {
    for (const line of result.errors) {
      console.error(`[typecheck] ${line}`);
    }
    process.exit(1);
  }
  console.log(`[typecheck] checked ${result.checkedFiles} pure data-layer files (checkJs + strictNullChecks, noEmit) — 0 errors`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
