#!/usr/bin/env node
// Enforces the repository's Conventional Commits message contract
// (CLAUDE.md:60, scripts/bump-version.sh, scripts/changelog.py).
//
// Usage:
//   node scripts/commit-msg-lint.mjs <path-to-COMMIT_EDITMSG>
//   node scripts/commit-msg-lint.mjs --text "<raw message>"

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_COMMIT_TYPES = Object.freeze([
  "feat",
  "fix",
  "refactor",
  "perf",
  "docs",
  "style",
  "chore",
  "test",
  "ci",
  "build",
  "i18n",
  "a11y",
  "revert",
]);

const CONVENTIONAL_SUBJECT_RE = new RegExp(
  `^(?:${ALLOWED_COMMIT_TYPES.join("|")})(?:\\([a-zA-Z0-9_./-]+\\))?!?: \\S.*$`
);
const GIT_GENERATED_SUBJECT_RE = /^(?:Revert ".+"|Merge (?:branch|pull request|remote-tracking branch|tag) .+)$/;
const SCISSOR_LINE_RE = /^# -+ >8 -+\s*$/;

/**
 * Strips git's scissor diff block (`git commit -v`) and `#` comment lines the
 * way git's default cleanup prepares `COMMIT_EDITMSG`.
 * @param {string} raw
 * @returns {string[]}
 */
export function cleanCommitLines(raw) {
  const normalized = String(raw || "").replace(/\r\n/g, "\n");
  const rawLines = normalized.split("\n");
  const kept = [];
  for (const line of rawLines) {
    if (SCISSOR_LINE_RE.test(line)) break;
    if (line.startsWith("#")) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[0].trim() === "") kept.shift();
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  return kept;
}

/**
 * Validates a raw commit message string.
 * @param {string} raw
 * @returns {{ ok: boolean, subject: string, errors: string[] }}
 */
export function validateCommitMessage(raw) {
  const lines = cleanCommitLines(raw);
  const errors = [];
  if (lines.length === 0) {
    errors.push("commit message is empty");
    return { ok: false, subject: "", errors };
  }
  const subject = lines[0];
  if (/\s$/.test(subject)) {
    errors.push(`commit subject has trailing whitespace: ${JSON.stringify(subject)}`);
  }
  if (!CONVENTIONAL_SUBJECT_RE.test(subject) && !GIT_GENERATED_SUBJECT_RE.test(subject)) {
    errors.push(
      `commit subject ${JSON.stringify(subject)} does not match "<type>[optional (scope)][!]: <summary>" ` +
      `(allowed types: ${ALLOWED_COMMIT_TYPES.join(", ")})`
    );
  }
  if (lines.length > 1 && lines[1].trim() !== "") {
    errors.push("line 2 of a multi-line commit message must be blank (separate subject from body)");
  }
  return { ok: errors.length === 0, subject, errors };
}

function main(argv) {
  let raw = "";
  if (argv[0] === "--text") {
    if (typeof argv[1] !== "string") {
      console.error("Usage: node scripts/commit-msg-lint.mjs [--text <msg> | <commit-msg-file>]");
      process.exit(2);
    }
    raw = argv[1];
  } else if (argv[0]) {
    raw = readFileSync(resolve(argv[0]), "utf8");
  } else {
    console.error("Usage: node scripts/commit-msg-lint.mjs [--text <msg> | <commit-msg-file>]");
    process.exit(2);
  }

  const verdict = validateCommitMessage(raw);
  if (!verdict.ok) {
    console.error("[commit-msg] COMMIT BLOCKED — invalid commit message format:");
    for (const err of verdict.errors) {
      console.error(`  - ${err}`);
    }
    console.error("  Examples: feat(reader): add keyboard shortcut | fix(sync): check quota error");
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
