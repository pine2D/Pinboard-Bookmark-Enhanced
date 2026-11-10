#!/usr/bin/env node
// Records one flake: a gate command or test page that failed, was retried once
// (PBP_RETRY_FLAKY=1) and then passed. Appends one JSON line to
// $PBP_QA_REPORT_DIR/flakes.jsonl (default ~/.local/share/pbp-qa-report), the
// file .claude/flake-ledger.md tells people to copy from. Under GitHub Actions
// it also prints a ::warning:: line and adds a line to $GITHUB_STEP_SUMMARY.
//
// Used by scripts/run-html-suites.mjs (import) and scripts/verify.sh (CLI):
//   node scripts/flake-record.mjs --stage=<name> --target=<what> --log=<first failure log>
// Exit 1 when the line could not be written. Callers treat that as a loud
// warning only: the retried gate already passed, and a broken report dir must
// neither fail the run nor hide a real failure.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIRST_FAILURE_LINES = 40;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function reportDir(env = process.env) {
  return resolve(env.PBP_QA_REPORT_DIR || join(homedir(), '.local/share/pbp-qa-report'));
}

export function tailLines(text, count = FIRST_FAILURE_LINES) {
  const lines = String(text || '').replace(/\s+$/, '').split('\n');
  return lines.slice(-count).join('\n');
}

function headSha(root, env) {
  if (env.GITHUB_SHA) return env.GITHUB_SHA;
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return git.status === 0 ? git.stdout.trim() : 'unknown';
}

// GitHub workflow command escaping (data and property values).
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function recordFlake({ stage, target, output, root = ROOT, env = process.env, now = new Date(), out = process.stdout }) {
  if (!stage || !target) throw new Error('recordFlake needs a stage and a target');
  const entry = { date: now.toISOString(), stage, target, sha: headSha(root, env), firstFailure: tailLines(output) };
  const dir = reportDir(env);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'flakes.jsonl');
  appendFileSync(file, JSON.stringify(entry) + '\n');
  if (env.GITHUB_ACTIONS === 'true') {
    out.write(`::warning title=${escapeProperty(`Flaky: ${stage}`)}::${escapeData(`${target} failed once and passed on retry. Add it to .claude/flake-ledger.md.`)}\n`);
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `- Flaky (passed on retry): \`${stage}\` ${target.replace(/`/g, "'")}\n`);
    }
  }
  return { file, entry };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = {};
  for (const arg of process.argv.slice(2)) {
    const m = /^--(stage|target|log)=(.*)$/s.exec(arg);
    if (!m) { console.error(`[flake] unknown argument: ${arg}`); process.exit(2); }
    opts[m[1]] = m[2];
  }
  try {
    const output = opts.log ? readFileSync(opts.log, 'utf8') : '';
    const { file } = recordFlake({ stage: opts.stage, target: opts.target, output });
    console.log(`[flake] ${opts.stage}: ${opts.target} passed on retry; recorded in ${file}`);
  } catch (error) {
    console.error(`[flake] WARNING: could not record the flake for ${opts.stage || '?'}: ${opts.target || '?'} (${error.message})`);
    process.exit(1);
  }
}
