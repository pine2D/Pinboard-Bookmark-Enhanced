#!/usr/bin/env node
// Keeps the silent-catch baseline from growing.
//   node scripts/eslint-baseline-check.mjs <old.json> <new.json>
// Both files are eslint suppression files: file -> rule id -> { count }.
// Fails (exit 1) when a file's count for pbp/no-silent-catch went up, a file
// is new, or the new baseline suppresses any other rule. Exit 2 on unreadable input. The pre-commit hook hands it the HEAD
// copy and the staged copy of scripts/eslint-suppressions.json.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RULE = 'pbp/no-silent-catch';

function countOf(baseline, file) {
  const e = baseline[file] && baseline[file][RULE];
  if (e === undefined) return 0;
  if (!e || typeof e.count !== 'number' || !Number.isInteger(e.count) || e.count < 0) {
    throw new Error(`${file}: ${RULE} has no valid count`);
  }
  return e.count;
}

// Returns one line per file that got worse; an empty list means the baseline
// did not grow. The new baseline may hold RULE only: any other rule there
// would silence real errors (no-undef and the like) through a JSON edit.
export function compareBaselines(oldB, newB) {
  for (const b of [oldB, newB]) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('a baseline must be a JSON object');
  }
  const out = [];
  for (const file of Object.keys(newB).sort()) {
    const rules = newB[file] && typeof newB[file] === 'object' ? Object.keys(newB[file]) : [];
    for (const r of rules) {
      if (r !== RULE) out.push(`${file}: rule ${r} is not allowed in the baseline (only ${RULE} is)`);
    }
    const was = countOf(oldB, file);
    const now = countOf(newB, file);
    if (now > was) {
      out.push(was === 0 && !(oldB[file] && oldB[file][RULE])
        ? `${file}: new in the baseline with ${now} (was not listed)`
        : `${file}: ${was} -> ${now}`);
    }
  }
  return out;
}

function main(argv) {
  if (argv.length !== 2) {
    console.error('usage: node scripts/eslint-baseline-check.mjs <old.json> <new.json>');
    return 2;
  }
  let parsed;
  try {
    parsed = argv.map((p) => JSON.parse(readFileSync(p, 'utf8')));
  } catch (e) {
    console.error(`[eslint-baseline] cannot read the baselines: ${e.message}`);
    return 2;
  }
  let grown;
  try {
    grown = compareBaselines(parsed[0], parsed[1]);
  } catch (e) {
    console.error(`[eslint-baseline] bad baseline: ${e.message}`);
    return 2;
  }
  if (grown.length) {
    console.error('[eslint-baseline] the silent-catch baseline only shrinks and holds no other rule. Problems:');
    for (const l of grown) console.error(`  ${l}`);
    console.error("Fix the new silent catch, or add a '// swallow-ok: <reason>' comment inside it. Do not raise the count.");
    console.error('Other rules are never suppressed here: fix the code eslint points at.');
    console.error('If you renamed a file, its old silent catches count as new: fix them or give each a swallow-ok reason.');
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
