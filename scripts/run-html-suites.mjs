#!/usr/bin/env node
// Runs the tests/*-tests.html browser suites for scripts/verify.sh (the
// `pages` group). Each page still runs in its own process as
//   node .qa-scan/run-test.mjs tests/<page>.html
// and that runner alone decides pass or fail; this file only schedules pages,
// collects their output and reports.
//
//   node scripts/run-html-suites.mjs                    # every tests/*-tests.html
//   node scripts/run-html-suites.mjs tests/a-tests.html # only the pages named
//
// PBP_PAGE_JOBS     pages run at once; default min(4, CPU count). 1 runs the
//                   pages one after another and prints each one live, as
//                   verify.sh did before this file existed.
// PBP_RETRY_FLAKY=1 a failed page runs once more. A pass on the second try
//                   counts as a pass and is recorded as a flake (see
//                   scripts/flake-record.mjs); a second failure is a failure.
//                   Unset, nothing is retried.
// PBP_VERIFY_DRY=1  print one "[dry][pages] <command>" line per page, run none.
// PBP_QA_REPORT_DIR each page's full output goes to html-suites/<page>.log
//                   under it (default ~/.local/share/pbp-qa-report).
//
// With more than one job the output of each page is held back and printed as
// one block per page, in file name order, after all pages finish. Exit 1 when
// any page finally fails; the failed pages are listed at the end.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordFlake, reportDir } from './flake-record.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = '.qa-scan/run-test.mjs';
// Run the large synchronous conversion suite first, as verify.sh always has.
const FIRST = 'tests/md-convert-tests.html';

function defaultJobs() {
  return Math.max(1, Math.min(4, (cpus() || []).length || 1));
}

function jobCount(env) {
  const raw = env.PBP_PAGE_JOBS;
  if (raw === undefined || raw === '') return defaultJobs();
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
    console.error(`[browser] ignoring invalid PBP_PAGE_JOBS="${raw}" (must be a positive integer); using ${defaultJobs()}`);
    return defaultJobs();
  }
  return Number(raw);
}

function listPages(args) {
  if (args.length) {
    for (const page of args) {
      if (!/^tests\/[^/]+-tests\.html$/.test(page)) {
        console.error(`[browser] not a test page: ${page} (expected tests/<name>-tests.html)`);
        process.exit(2);
      }
    }
    return [...new Set(args)].sort();
  }
  const dir = join(ROOT, 'tests');
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('-tests.html')) : [];
  return names.sort().map((name) => 'tests/' + name);
}

function runOnce(page, live) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [RUNNER, page], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const take = (stream) => (chunk) => {
      output += chunk;
      if (live) stream.write(chunk);
    };
    child.stdout.setEncoding('utf8').on('data', take(process.stdout));
    child.stderr.setEncoding('utf8').on('data', take(process.stderr));
    child.on('error', (error) => { output += `\n[browser] could not start the runner: ${error.message}\n`; });
    child.on('close', (code, signal) => {
      done({ code: code === null ? 1 : code, signal, output });
    });
  });
}

async function runPage(page, ctx) {
  const logFile = join(ctx.logDir, basename(page, '.html') + '.log');
  const header = `[browser] ${page}\n`;
  if (ctx.live) process.stdout.write(header);
  const first = await runOnce(page, ctx.live);
  const exitNote = (r) => (r.signal ? `signal ${r.signal}` : `exit ${r.code}`);
  // Written before any retry, so the first try is on disk even if the retry hangs.
  writeFileSync(logFile, header + first.output);
  let block = header + first.output;
  if (first.code === 0) return { page, ok: true, block };
  if (!ctx.retry) return { page, ok: false, block };
  const note = `[browser] ${page} failed (${exitNote(first)}); running it once more because PBP_RETRY_FLAKY=1\n[browser] ${page} (retry)\n`;
  if (ctx.live) process.stdout.write(note);
  const second = await runOnce(page, ctx.live);
  appendFileSync(logFile, note + second.output);
  block += note + second.output;
  if (second.code !== 0) return { page, ok: false, block };
  let flakeNote;
  try {
    const { file } = recordFlake({ stage: 'browser', target: page, output: first.output, root: ROOT });
    flakeNote = `[flake] browser: ${page} passed on retry; recorded in ${file}\n`;
  } catch (error) {
    flakeNote = `[flake] WARNING: could not record the flake for browser: ${page} (${error.message})\n`;
  }
  if (ctx.live) process.stdout.write(flakeNote);
  block += flakeNote;
  return { page, ok: true, flaky: true, block };
}

async function main() {
  const env = process.env;
  const pages = listPages(process.argv.slice(2));
  if (!pages.length) {
    console.error('[browser] no tests/*-tests.html suites found');
    process.exit(1);
  }
  const order = pages.includes(FIRST) ? [FIRST, ...pages.filter((p) => p !== FIRST)] : pages;
  if (env.PBP_VERIFY_DRY === '1') {
    for (const page of order) console.log(`[dry][pages] node ${RUNNER} ${page}`);
    return 0;
  }
  if (!existsSync(join(ROOT, '.qa-scan/node_modules/playwright'))) {
    console.error('[browser] Playwright is not installed; run: npm ci --prefix .qa-scan');
    process.exit(1);
  }
  const jobs = jobCount(env);
  const logDir = join(reportDir(env), 'html-suites');
  mkdirSync(logDir, { recursive: true });
  // A full run replaces every log, so a log left from a deleted page cannot mislead.
  if (!process.argv.slice(2).length) {
    for (const name of readdirSync(logDir)) if (name.endsWith('.log')) rmSync(join(logDir, name), { force: true });
  }
  const ctx = { live: jobs === 1, retry: env.PBP_RETRY_FLAKY === '1', logDir };
  console.log(`[browser] running ${pages.length} HTML suites`);
  if (jobs > 1) console.log(`[browser] ${Math.min(jobs, pages.length)} at a time; output follows in file name order once all finish (logs: ${logDir})`);

  const results = new Map();
  let next = 0;
  const worker = async () => {
    while (next < order.length) {
      const page = order[next++];
      results.set(page, await runPage(page, ctx));
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, order.length) }, worker));

  if (!ctx.live) for (const page of pages) process.stdout.write(results.get(page).block);
  const flaky = pages.filter((p) => results.get(p).flaky);
  const failed = pages.filter((p) => !results.get(p).ok);
  if (flaky.length) console.log(`[browser] ${flaky.length} suite(s) passed only on retry: ${flaky.join(', ')}`);
  if (failed.length) {
    console.error(`[browser] ${failed.length} suite(s) failed`);
    for (const page of failed) console.error(`  ${page}  (log: ${join(logDir, basename(page, '.html') + '.log')})`);
    return 1;
  }
  return 0;
}

process.exitCode = await main();
