#!/usr/bin/env node
// Development-time mutation check: does the test command notice a deliberate
// one-line break of the source? It never leaves the file broken:
//   - the old string must occur exactly once, else the mutation is refused;
//   - a backup is written beside each target before the first edit, and an
//     existing backup (a crashed earlier run) makes the tool refuse to start;
//   - the original is restored after every mutation, on failure, exception,
//     SIGINT/SIGTERM/SIGHUP and process exit.
// Only an uncatchable SIGKILL or power loss leaves the backup behind; the next
// run prints the command that puts the file back.
//
//   node scripts/mutate-check.mjs [options] <file> <old> <new> -- <test command...>
//   node scripts/mutate-check.mjs [options] --json <mutations.json> [-- <test command...>]
//
// mutations.json: [{"file":"x.js","old":"a","new":"b","label":"optional","command":["node","t.mjs"]}]
// (a per-entry command overrides the shared one). Options: --timeout=<ms>
// (default 300000; a timeout counts as killed), --no-baseline (skip the
// unmutated run that must pass first), --verbose (show test output).
// Exit: 0 every mutation killed; 1 some survived; 2 refused or misused.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKUP_SUFFIX = '.mutate-check.bak';
const backupOf = file => file + BACKUP_SUFFIX;

export class MutateRefusal extends Error {}

export function restoreHint(file) {
  return `cp -p ${JSON.stringify(backupOf(file))} ${JSON.stringify(file)} && rm ${JSON.stringify(backupOf(file))}`;
}

function occurrences(text, needle) {
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

function runCommand(command, { timeoutMs, verbose, cwd, onChild }) {
  return new Promise(resolveRun => {
    let output = '', settled = false, timedOut = false;
    const done = result => { if (!settled) { settled = true; clearTimeout(timer); onChild(null); resolveRun({ ...result, timedOut, output }); } };
    let child;
    try { child = spawn(command[0], command.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolveRun({ code: null, error: error.message, timedOut: false, output: '' }); return; }
    onChild(child);
    const collect = chunk => { output += chunk; if (output.length > 200000) output = output.slice(-100000); if (verbose) process.stdout.write(chunk); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', error => done({ code: null, error: error.message }));
    child.once('close', (code, signal) => done({ code, signal }));
  });
}

// mutations: [{file, old, new, label?, command?}] with absolute or cwd-relative files.
export async function runMutations(mutations, { command = null, timeoutMs = 300000, baseline = true, verbose = false, cwd = process.cwd(), log = console.log, warn = console.error } = {}) {
  const files = [...new Set(mutations.map(m => resolve(cwd, m.file)))];
  const originals = new Map();
  for (const file of files) {
    if (existsSync(backupOf(file))) throw new MutateRefusal(`A backup from an earlier run exists: ${backupOf(file)}\nThe previous run may have crashed with ${file} still mutated. Check it, then put it back with:\n  ${restoreHint(file)}`);
  }
  for (const file of files) {
    if (!existsSync(file)) throw new MutateRefusal(`No such file: ${file}`);
    originals.set(file, readFileSync(file));
  }
  const prepared = mutations.map((m, index) => {
    const file = resolve(cwd, m.file), text = originals.get(file).toString('utf8');
    if (typeof m.old !== 'string' || !m.old || typeof m.new !== 'string') throw new MutateRefusal(`Mutation ${index + 1}: old and new must be strings and old must not be empty`);
    if (m.old === m.new) throw new MutateRefusal(`Mutation ${index + 1}: old and new are identical`);
    const count = occurrences(text, m.old);
    if (count !== 1) throw new MutateRefusal(`Mutation ${index + 1}: the old string must occur exactly once in ${file}, found ${count}`);
    const cmd = m.command || command;
    if (!Array.isArray(cmd) || !cmd.length) throw new MutateRefusal(`Mutation ${index + 1}: no test command (give one after "--" or per entry)`);
    return { file, text, at: text.indexOf(m.old), old: m.old, new: m.new, label: m.label || `${m.file}: ${JSON.stringify(m.old.length > 50 ? m.old.slice(0, 47) + '...' : m.old)}`, command: cmd };
  });
  for (const file of files) {
    try {
      const status = execFileSync('git', ['status', '--porcelain', '--', file], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (status) warn(`warning: ${file} has uncommitted changes; they are kept (the file is restored to its present content), but commit or stash first if you can.`);
    } catch { /* not a git checkout: nothing to warn about */ }
  }

  let child = null, restored = true;
  const restoreAll = () => {
    for (const [file, bytes] of originals) { try { writeFileSync(file, bytes); } catch (error) { warn(`CANNOT RESTORE ${file}: ${error.message}\nRestore with: ${restoreHint(file)}`); return false; } }
    for (const file of files) { try { rmSync(backupOf(file), { force: true }); } catch { /* the original is back; a stray backup is harmless */ } }
    return true;
  };
  const onExit = () => { if (!restored) restoreAll(); };
  const onSignal = signal => { try { child?.kill('SIGKILL'); } catch { /* already gone */ } onExit(); restored = true; process.exit(128 + ({ SIGINT: 2, SIGHUP: 1, SIGTERM: 15 }[signal] || 0)); };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  process.on('exit', onExit);
  for (const signal of signals) process.on(signal, onSignal);
  const opts = { timeoutMs, verbose, cwd, onChild: c => { child = c; } };
  const results = [];
  try {
    for (const file of files) writeFileSync(backupOf(file), originals.get(file));
    restored = false;
    if (baseline) {
      const seen = new Set();
      for (const m of prepared) {
        const key = m.command.join('\0');
        if (seen.has(key)) continue;
        seen.add(key);
        const base = await runCommand(m.command, opts);
        if (base.code !== 0) throw new MutateRefusal(`The unmutated source already fails the test command (${m.command.join(' ')}); every mutation would look killed.\n${base.error || base.output.split('\n').slice(-15).join('\n')}`);
      }
    }
    for (const m of prepared) {
      writeFileSync(m.file, m.text.slice(0, m.at) + m.new + m.text.slice(m.at + m.old.length));
      let run;
      try { run = await runCommand(m.command, opts); }
      finally { writeFileSync(m.file, originals.get(m.file)); }
      const spawnFailed = run.code === null && run.error && !run.timedOut;
      if (spawnFailed) throw new MutateRefusal(`Could not run the test command ${m.command.join(' ')}: ${run.error}`);
      const status = run.code === 0 ? 'survived' : 'killed';
      results.push({ label: m.label, status, detail: run.timedOut ? 'timeout' : run.signal ? 'signal ' + run.signal : 'exit ' + run.code });
      log(`${status === 'killed' ? 'killed  ' : 'SURVIVED'}  ${m.label}  (${results.at(-1).detail})`);
      if (status === 'survived' && !verbose) log(run.output.split('\n').filter(Boolean).slice(-3).map(line => '    | ' + line.slice(0, 200)).join('\n'));
    }
  } finally {
    restored = restoreAll();
    process.off('exit', onExit);
    for (const signal of signals) process.off(signal, onSignal);
  }
  const survived = results.filter(r => r.status === 'survived').length;
  log(`${results.length - survived}/${results.length} mutations killed, ${survived} survived`);
  return { results, survived };
}

function parseArgs(argv) {
  const dash = argv.indexOf('--');
  const head = dash < 0 ? argv : argv.slice(0, dash), command = dash < 0 ? null : argv.slice(dash + 1);
  const options = { timeoutMs: 300000, baseline: true, verbose: false, json: null }, positional = [];
  for (let i = 0; i < head.length; i++) {
    const arg = head[i];
    if (arg === '--no-baseline') options.baseline = false;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg.startsWith('--timeout=')) options.timeoutMs = Number(arg.slice(10));
    else if (arg === '--json') options.json = head[++i];
    else if (arg.startsWith('--json=')) options.json = arg.slice(7);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) throw new MutateRefusal('Unknown option: ' + arg);
    else positional.push(arg);
  }
  if (!(options.timeoutMs > 0)) throw new MutateRefusal('--timeout must be a positive number of milliseconds');
  return { options, positional, command: command && command.length ? command : null };
}

const USAGE = `Usage: node scripts/mutate-check.mjs [--timeout=ms] [--no-baseline] [--verbose] <file> <old> <new> -- <test command...>
       node scripts/mutate-check.mjs [options] --json <mutations.json> [-- <test command...>]
Breaks <old> (must occur exactly once) into <new>, runs the command, always restores the file.
Exit 0: all mutations killed. 1: some survived. 2: refused or misused.`;

export async function main(argv) {
  try {
    const { options, positional, command } = parseArgs(argv);
    if (options.help) { console.log(USAGE); return 0; }
    let mutations;
    if (options.json) {
      if (positional.length) throw new MutateRefusal('--json replaces the <file> <old> <new> arguments');
      mutations = JSON.parse(readFileSync(options.json, 'utf8'));
      if (!Array.isArray(mutations) || !mutations.length) throw new MutateRefusal('The JSON file must hold a non-empty array of mutations');
    } else {
      if (positional.length !== 3) throw new MutateRefusal(USAGE);
      mutations = [{ file: positional[0], old: positional[1], new: positional[2] }];
    }
    const { survived } = await runMutations(mutations, { command, timeoutMs: options.timeoutMs, baseline: options.baseline, verbose: options.verbose });
    return survived ? 1 : 0;
  } catch (error) {
    if (!(error instanceof MutateRefusal)) console.error('mutate-check: unexpected ' + (error?.stack || error));
    else console.error('mutate-check: ' + error.message);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
