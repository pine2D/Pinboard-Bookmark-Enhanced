// Synthetic preflight for scripts/bookmark-service-live.mjs (harness v2).
// Nothing here reaches a real bookmark service, credential, AI provider or
// Docker daemon:
//  - spawned CLI runs load a hook that blocks the synthetic credential file
//    and global fetch, and PATH starts with a docker stub that records calls;
//  - runs that must talk to a service talk to loopback fixtures shaped like
//    the real responses (linkding 1.47 / Karakeep 0.34.1);
//  - temporary-container runs get an injected Docker executor;
//  - the browser is the bundled Chromium: a plain page for the screenshot
//    canary and the extension for the read-only loopback path.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'pbp-live-preflight-'));
const live = await import('../scripts/bookmark-service-live.mjs');
const { MODULES, GROUPS, LIST_MARKER, SNAPSHOT_POLL_MS, SNAPSHOT_MARGIN_MS } = await import('../scripts/bookmark-service-live-scenarios.mjs');

const credentialsPath = join(dir, 'synthetic-credentials.json');
const marker = join(dir, 'credential-access');
const dockerMarker = join(dir, 'docker-called');
const hook = join(dir, 'guard.mjs');
const binDir = join(dir, 'bin');
const syntheticKey = 'synthetic-key-must-not-appear-in-output';
const syntheticKarakeepKey = 'synthetic-karakeep-key-must-not-appear';
mkdirSync(binDir);
writeFileSync(credentialsPath, JSON.stringify({ linkdingToken: syntheticKey, karakeepToken: syntheticKarakeepKey }), { mode: 0o600 });
writeFileSync(join(binDir, 'docker'), `#!/bin/sh\necho called >> ${JSON.stringify(dockerMarker)}\nexit 1\n`, { mode: 0o755 });
writeFileSync(hook, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
for (const name of ['readFileSync','lstatSync']) {
  const original=fs[name];
  fs[name]=function(path,...args) {
    if(String(path)===${JSON.stringify(credentialsPath)}) {
      fs.writeFileSync(${JSON.stringify(marker)},'attempted');
      throw new Error('credential_access_blocked');
    }
    return original.call(this,path,...args);
  };
}
syncBuiltinESMExports();
globalThis.fetch=()=>{throw new Error('network_access_blocked');};
`);
// A spawned temporary-target run with a scripted Docker executor, so real
// signals and a real process.exit are exercised without a Docker daemon.
// Every command logs "start<TAB>key<TAB>args" and "done<TAB>key"; the keys in
// the JSON argument (key -> ms) are held that long before they answer.
const dockerChild = join(dir, 'docker-child.mjs');
writeFileSync(dockerChild, `import { appendFileSync } from 'node:fs';
const [runner, log, holdSpec, ...argv] = process.argv.slice(2);
const live = await import(runner);
const holds = JSON.parse(holdSpec);
const keyOf = args => {
  const name = args.includes('--name') ? args[args.indexOf('--name') + 1].replace(/^pbp-it-[0-9a-f-]{36}-/, '') : '';
  return args[0] + (args[1] && !args[1].startsWith('-') && ['network', 'image', 'volume'].includes(args[0]) ? ' ' + args[1] : '') + (name ? ':' + name : '');
};
const exec = async args => {
  const key = keyOf(args);
  appendFileSync(log, 'start\\t' + key + '\\t' + JSON.stringify(args) + '\\n');
  if (holds[key]) await new Promise(r => setTimeout(r, holds[key]));
  appendFileSync(log, 'done\\t' + key + '\\n');
  const [cmd, sub] = args;
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  if (cmd === 'ps' || (cmd === 'network' && sub === 'ls') || (cmd === 'volume' && sub === 'ls')) return ok('');
  if (cmd === 'inspect' && args[2] === '{{.Image}}') return ok('sha256:' + 'a'.repeat(64) + '\\n');
  if (cmd === 'inspect') return ok('running 0\\n');
  if (cmd === 'image') return ok('sha256:' + 'c'.repeat(64) + '\\n');
  if (cmd === 'port') return ok('127.0.0.1:9\\n');
  return ok('');
};
process.exitCode = await live.main(argv, { dockerExec: exec });
`);
const stateDirFor = name => { const d = join(dir, 'state-' + name); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
const secretValues = [syntheticKey, syntheticKarakeepKey];

// A user-target run names its authorisation; each spawned run gets a label of
// its own unless the test is about authorisation itself.
async function run(args, { guard = true, credentials = true, state = stateDirFor('default'), onSpawn, authorization = true } = {}) {
  const userRun = args.includes('--run') && args[args.indexOf('--target') + 1] === 'user' && !args.includes('--authorization');
  const auth = authorization && userRun ? ['--authorization', 'preflight-' + randomUUID().slice(0, 8)] : [];
  const child = spawn(process.execPath, [...(guard ? ['--import', hook] : []), 'scripts/bookmark-service-live.mjs', ...args, ...auth, ...(credentials ? ['--credentials', credentialsPath] : [])], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: binDir + ':' + process.env.PATH, PBP_LIVE_STATE_DIR: state },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  if (onSpawn) onSpawn(child, () => output);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (c, signal) => resolve(c ?? signal)); });
  for (const value of secretValues) assert(!output.includes(value), 'synthetic credential leaked to output');
  if (guard) assert(!existsSync(marker), 'preflight accessed the credential file');
  assert(!existsSync(dockerMarker), 'a non-temp run invoked docker');
  const reportPath = output.match(/Local report: (.+)/)?.[1];
  let report;
  if (reportPath) {
    const raw = readFileSync(reportPath, 'utf8');
    for (const value of secretValues) assert(!raw.includes(value), 'synthetic credential leaked to report');
    assert.equal(statSync(reportPath).mode & 0o777, 0o600, 'report must be 0600');
    assert.equal(statSync(join(reportPath, '..')).mode & 0o777, 0o700, 'run directory must be 0700');
    report = JSON.parse(raw);
  }
  return { code, output, report, reportPath };
}

// Runs docker-child.mjs in `state` and sends one SIGINT each time the Docker
// log gains a line starting with the next entry of `signals` (marking it in
// the log as "signal"). Returns the exit code, the log lines and the report.
async function dockerChildRun({ state, args, holds = {}, signals = [] }) {
  const log = join(state, 'docker.log');
  writeFileSync(log, '');
  const runner = new URL('../scripts/bookmark-service-live.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', hook, dockerChild, runner, log, JSON.stringify(holds), ...args], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: binDir + ':' + process.env.PATH, PBP_LIVE_STATE_DIR: state },
  });
  let output = '', closed = false;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exit = new Promise(resolve => child.on('close', (c, signal) => { closed = true; resolve(c ?? signal); }));
  const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  for (const prefix of signals) {
    const end = Date.now() + 20000;
    while (!closed && Date.now() < end && !lines().some(l => l.startsWith(prefix))) await new Promise(r => setTimeout(r, 20));
    if (closed || Date.now() >= end) break;
    appendFileSync(log, 'signal\tSIGINT\n');
    child.kill('SIGINT');
  }
  const code = await exit;
  assert(!existsSync(dockerMarker), 'the scripted run reached the docker binary');
  // The report the run names, else (a forced exit names none) the only one.
  const runDirs = readdirSync(state).filter(n => /^pbp-it-[0-9a-f-]{36}$/.test(n));
  const reportPath = output.match(/Local report: (.+)/)?.[1] || (runDirs.length === 1 ? join(state, runDirs[0], 'report.json') : '');
  return { code, output, lines: lines(), reportPath, report: reportPath ? JSON.parse(readFileSync(reportPath, 'utf8')) : null };
}

function httpCall({ port, method = 'POST', path = '/v1/chat/completions', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

// In-process runs print their own progress; keep it unless an assertion fails.
async function quiet(fn) {
  const { log, error } = console, lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { return await fn(); } catch (e) { log(lines.join('\n')); throw e; } finally { console.log = log; console.error = error; }
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const closeServer = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
const servers = [];
let browser;

try {
  // ---------------------------------------------------------------------
  // Registry, selection and wildcards
  // ---------------------------------------------------------------------
  const ids = live.listIds();
  assert.equal(new Set(ids).size, ids.length, 'module ids must be unique');
  for (const id of ids) assert.match(id, /^(linkding|linkding-pg|karakeep|pinboard)\.[a-z0-9.-]+$/);
  for (const row of MODULES) {
    for (const key of ['id', 'services', 'surfaces', 'features', 'needs', 'budget', 'steps']) assert(row[key] !== undefined, row.id + ' lacks ' + key);
    assert(['temp', 'user', 'any'].includes(row.needs.target) && ['any', 'on', 'off'].includes(row.needs.sharing), row.id + ' needs');
    assert.equal(typeof row.needs.snapshots, 'boolean', row.id + ' needs.snapshots');
    if (row.needs.snapshots) assert.deepEqual(row.services, ['linkding'], row.id + ': only linkding builds HTML snapshots');
    for (const service of row.services) {
      const b = live.resolveBudget({ ...row, service });
      assert(b.seconds > 0 && b.urls >= b.bookmarks && b.node > 0 && b.browser > 0, row.id + ' budget for ' + service);
      if (row.needs.writes === false) assert.equal(b.bookmarks, 0, row.id + ' is read-only but plans bookmarks');
    }
  }
  const pick = (spec, opts) => live.selectModules(spec, opts).selected.map(m => m.id);
  // Group aliases keep the pre-registry meaning; every member matches its glob.
  for (const [group, patterns] of Object.entries(GROUPS)) {
    const selected = pick(group);
    const expected = ids.filter(id => patterns.some(p => live.globToRegExp(p).test(id)) && !id.startsWith('pinboard.'));
    assert.deepEqual(selected, expected, group + ' group');
  }
  // The snapshot module is linkding's first writing module: snapshots run one
  // at a time, so its bookmark must not queue behind the others.
  assert.deepEqual(pick('core'), ['linkding.core.snapshot', 'linkding.core.popup-reader', 'linkding.core.worker', 'karakeep.core.popup-reader', 'karakeep.core.worker']);
  assert.deepEqual(MODULES.filter(m => m.needs.snapshots).map(m => m.id), ['core.snapshot'], 'only the snapshot module waits for snapshots');
  assert.deepEqual(pick('edges'), ['linkding.edges.quote-unread', 'linkding.edges.offline', 'karakeep.edges.tags']);
  const karakeepAll = pick('karakeep.*');
  assert(karakeepAll.length >= 4 && karakeepAll.every(id => id.startsWith('karakeep.')), 'karakeep.* wildcard');
  assert.deepEqual(pick('karakeep.*', { services: ['linkding'] }), [], '--service filters wildcard matches');
  assert.deepEqual(pick('*.readonly,*.ai.*'), ids.filter(id => id.endsWith('.readonly') || id.includes('.ai.')).filter(id => !id.startsWith('pinboard.')));
  assert.deepEqual(pick('linkding.core.worker,linkding.core.worker'), ['linkding.core.worker'], 'duplicates collapse');
  assert.deepEqual(pick('linkding.core.wo?ker'), ['linkding.core.worker'], '? wildcard');
  assert.throws(() => live.selectModules('nothing.matches.this'), e => e.code === 'scenario');
  assert.throws(() => live.selectModules(' , '), e => e.code === 'scenario');
  // A temp-only row is skipped by a group on the user target and refused by name.
  const tempOnly = { ...MODULES.find(m => m.id === 'readonly'), id: 'temp.only', services: ['linkding'], needs: { ...MODULES[0].needs, target: 'temp' } };
  const sharingOn = { ...tempOnly, id: 'sharing.on', needs: { ...tempOnly.needs, target: 'any', sharing: 'on' } };
  assert.deepEqual(live.selectModules('*', { target: 'user', modules: [tempOnly, sharingOn] }).selected, []);
  assert.deepEqual(live.selectModules('*', { target: 'user', modules: [tempOnly, sharingOn] }).skipped.map(s => s.reason), ['target_temp', 'sharing_on_temp_only']);
  assert.throws(() => live.selectModules('linkding.temp.only', { target: 'user', modules: [tempOnly] }), e => e.code === 'module_requires_temp');
  assert.deepEqual(live.selectModules('linkding.temp.only', { target: 'temp', modules: [tempOnly] }).selected.map(m => m.id), ['linkding.temp.only']);

  // The snapshot module polls every 5 s and stops while its module still has
  // time for its checks and cleanup (E2); "missing" fails at once.
  {
    const snap = MODULES.find(m => m.id === 'core.snapshot');
    const budget = live.resolveBudget({ ...snap, service: 'linkding' });
    assert.equal(SNAPSHOT_POLL_MS, 5000);
    const drive = async statuses => {
      let now = 0, polls = 0;
      const sleeps = [], notes = {};
      const failWith = code => { const e = new Error(code); e.code = code; throw e; };
      const t = {
        service: 'linkding', prefix: 'pbp-it-x',
        claimUrl: () => 'http://localhost:47391/?pbp-it=x-linkding-1',
        phase: () => {}, check: () => {}, note: (k, v) => { notes[k] = v; },
        sw: async (fn, intent) => { assert.equal(intent.mode, 'create'); return { status: 'saved' }; },
        ownRow: async () => ({ id: 7 }),
        api: async path => {
          assert.equal(path, 'bookmarks/7/assets/');
          const s = statuses[Math.min(polls++, statuses.length - 1)];
          return { count: 1, results: s === 'missing' ? [] : [{ id: 3, asset_type: 'snapshot', status: s }] };
        },
        sleep: async ms => { sleeps.push(ms); now += ms; },
        remainingMs: () => Math.max(0, budget.seconds * 1000 - now),
        expect: (c, code) => { if (!c) failWith(code); },
        expectEq: (a, b, code) => { if (a !== b) failWith(code); },
      };
      let code = '';
      try { await snap.steps(t); } catch (e) { code = e.code || String(e); }
      return { code, polls, sleeps, now, notes };
    };
    const done = await drive(['pending', 'pending', 'complete']);
    assert.equal(done.code, '');
    assert.equal(done.polls, 3);
    assert.equal(done.notes.snapshot.status, 'complete');
    for (const [statuses, code, polls] of [[['pending'], 'snapshot_incomplete', 21], [['missing'], 'snapshot_not_queued', 1], [['pending', 'failure'], 'snapshot_failed', 2], [done.sleeps.map(() => 'pending').concat('complete'), '', 4]]) {
      const r = await drive(statuses);
      assert.equal(r.code, code, statuses.join());
      assert.equal(r.polls, polls, statuses.join());
      assert(r.sleeps.length && r.sleeps.every(ms => ms === SNAPSHOT_POLL_MS), 'one poll every 5 s');
      assert(r.now <= budget.seconds * 1000 - SNAPSHOT_MARGIN_MS, 'stops while the module has time left: ' + r.now);
      assert(r.polls + 3 <= budget.node, 'polls fit the module node budget');
    }
  }

  // Profile switches on a throwaway linkding account: allow-listed fields,
  // temp target only, and the container must confirm the new value.
  {
    assert.throws(() => live.linkdingProfileScript('is_superuser', true), e => e.code === 'temp_profile_field' && e.fatal === true);
    assert.match(live.linkdingProfileScript('enable_automatic_html_snapshots', false), /^u\.profile\.enable_automatic_html_snapshots=False$/m);
    const run = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
    const calls = [];
    let reply = script => 'PBPPROFILE=enable_automatic_html_snapshots=' + (/=True$/m.test(script) ? 'True' : 'False') + '\n';
    run.target = 'temp';
    run.snapshots.linkding = false;
    run.docker = { names: { linkding: 'pbp-it-x-linkding' }, exec: async (name, cmd) => { calls.push([name, ...cmd]); return { code: 0, stdout: reply(cmd.at(-1)) }; } };
    assert.equal(await run.setTempProfile('linkding', 'enable_automatic_html_snapshots', true), true);
    assert.equal(await run.setTempProfile('linkding', 'enable_automatic_html_snapshots', true), false, 'no exec when the value is already set');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 5), ['pbp-it-x-linkding', 'python', 'manage.py', 'shell', '-c']);
    reply = () => 'Traceback (most recent call last)\n';
    await assert.rejects(run.setTempProfile('linkding', 'enable_automatic_html_snapshots', false), e => e.code === 'temp_profile_failed');
    assert.equal(run.snapshots.linkding, true, 'an unconfirmed switch keeps the known state');
    run.target = 'user';
    await assert.rejects(run.setTempProfile('linkding', 'enable_sharing', true), e => e.code === 'profile_requires_temp' && e.fatal === true);
    assert.equal(calls.length, 2, 'a user target never reaches docker');
  }

  // ---------------------------------------------------------------------
  // Budgets: sums come from the rows, caps from the target
  // ---------------------------------------------------------------------
  for (const target of ['temp', 'user']) {
    for (const spec of ['core', 'edges', 'readonly', 'ai', 'all']) {
      const { selected, skipped } = live.selectModules(spec, { target });
      const plan = live.buildPlan({ target, selected, skipped });
      for (const instance of plan.instances) {
        const mods = selected.filter(m => m.instance === instance);
        const sum = key => mods.reduce((n, m) => n + live.resolveBudget(m)[key], 0);
        const row = plan.budget[instance];
        assert.equal(row.bookmarks, sum('bookmarks'), `${target}/${spec}/${instance} bookmarks`);
        assert.equal(row.tags, sum('tags'));
        assert.equal(row.ai, sum('ai'));
        assert(row.urls >= sum('urls') && row.urls <= sum('urls') + live.BUDGETS[target].run.urlMargin, 'url pool = planned URLs + margin');
        assert(row.browser >= sum('browser'), 'browser plan includes every module');
        assert(row.node > sum('node'), 'node plan includes the read-only preflight');
        assert(row.cleanupReserve >= live.cleanupCost({ service: row.service, bookmarks: row.bookmarks, urls: row.urls, tags: row.tags, lists: row.lists }));
        assert.deepEqual(Object.keys(row.caps).sort(), ['bookmarks', 'browser', 'cleanupReserve', 'lists', 'node', 'tags']);
        // The policy reserve is shown next to the computed one, which never undercuts it.
        assert.equal(row.caps.cleanupReserve, live.BUDGETS[target][instance].cleanupReserve);
        assert(row.cleanupReserve >= row.caps.cleanupReserve && row.node + row.cleanupReserve <= row.caps.node, `${target}/${spec}/${instance} node + reserve`);
      }
      assert.equal(plan.withinCaps, true, `${target}/${spec} must fit its caps: ${plan.problems.join(',')}`);
      // Every timeout plus the setup estimate fits the run cap.
      assert(plan.limits.worstCaseSeconds + plan.limits.setupAllowanceSeconds <= plan.limits.runMinutes * 60, `${target}/${spec} worst case ${plan.limits.worstCaseSeconds}s`);
      assert.equal(plan.fakeAi.needed, selected.some(m => m.needs.fakeAi));
      if (target === 'temp') assert(plan.containers.includes('edge') && plan.instances.every(i => plan.containers.includes(i)));
      else assert.deepEqual(plan.containers, []);
    }
  }
  assert.equal(live.BUDGETS.user.linkding.bookmarks, 15);
  assert.equal(live.BUDGETS.user.karakeep.bookmarks, 12);
  assert.equal(live.BUDGETS.user.karakeep.lists, 1);
  assert.equal(live.BUDGETS.user.pinboard.minIntervalMs, 3000);
  for (const target of ['temp', 'user']) assert.equal(live.BUDGETS[target].run.fakeAi, 60);
  // The user caps as authorised on 2026-11-01, as --plan shows them.
  {
    const { selected, skipped } = live.selectModules('all', { target: 'user' });
    const plan = live.buildPlan({ target: 'user', selected, skipped });
    assert.deepEqual(plan.budget.linkding.caps, { bookmarks: 15, node: 250, cleanupReserve: 60, browser: 350, tags: 20, lists: 0 });
    assert.deepEqual(plan.budget.karakeep.caps, { bookmarks: 12, node: 250, cleanupReserve: 60, browser: 500, tags: 20, lists: 1 });
    assert.deepEqual([plan.limits.runMinutes, plan.limits.moduleSeconds, plan.limits.fakeAi, plan.limits.automaticRetries], [20, 120, 60, 0]);
    assert.deepEqual(plan.skipped.map(s => s.reason), ['target_temp', 'target_temp'], 'temp-only modules are skipped on the user target');
  }
  // Timeouts that could outlast the 20-minute run are refused up front.
  {
    const slow = Array.from({ length: 9 }, (_, i) => ({ ...MODULES.find(m => m.id === 'core.worker'), id: 'slow.' + i, services: ['linkding'], budget: { bookmarks: 0, urls: 1, node: 2, browser: 2, seconds: 120 } }));
    const fits = live.buildPlan({ target: 'user', selected: live.selectModules('*', { target: 'user', modules: slow }).selected });
    assert.equal(fits.limits.worstCaseSeconds, 1080);
    assert.equal(fits.withinCaps, true, fits.problems.join(','));
    const tooSlow = [...slow, { ...slow[0], id: 'slow.9' }];
    const refused = live.buildPlan({ target: 'user', selected: live.selectModules('*', { target: 'user', modules: tooSlow }).selected });
    assert.deepEqual(refused.problems, ['run_minutes']);
  }
  // Over-budget rows are refused by --plan and by --run before anything starts.
  const base = MODULES.find(m => m.id === 'core.worker');
  const over = (id, budget) => ({ ...base, id, services: ['linkding'], budget: { ...base.budget, ...budget } });
  const overRows = [over('over.bookmarks', { bookmarks: 16, urls: 16 }), over('over.node', { node: 400 }), over('over.browser', { browser: 900 }), over('over.tags', { tags: 21 }), over('over.ai', { ai: 61, node: 1 }), over('over.urls', { urls: 13 })];
  for (const row of overRows) {
    const { selected } = live.selectModules('*', { target: 'user', modules: [row] });
    const plan = live.buildPlan({ target: 'user', selected });
    assert.equal(plan.withinCaps, false, row.id);
    const expectProblem = { 'over.bookmarks': 'linkding:bookmarks', 'over.node': 'linkding:node', 'over.browser': 'linkding:browser', 'over.tags': 'linkding:tags', 'over.ai': 'fake_ai', 'over.urls': 'linkding:urls' }[row.id];
    assert(plan.problems.includes(expectProblem), row.id + ' -> ' + plan.problems.join(','));
    // A pool larger than the bookmark cap is refused even when the rows'
    // bookmarks fit (second review): each pool URL can hold a run bookmark.
    if (row.id === 'over.urls') assert.deepEqual([plan.budget.linkding.bookmarks, plan.budget.linkding.urls, plan.problems], [1, 16, ['linkding:urls']]);
  }
  {
    const state = stateDirFor('over');
    process.env.PBP_LIVE_STATE_DIR = state;
    // A credential path that does not exist: reading it would change the code.
    const code = await quiet(() => live.main(['--run', '--target', 'user', '--scenario', 'linkding.over.bookmarks', '--linkding', 'http://127.0.0.1:9', '--credentials', join(dir, 'absent.json')], { modules: overRows }));
    assert.equal(code, 1);
    const reports = readdirSync(state).filter(n => n.startsWith('pbp-it-')).map(n => JSON.parse(readFileSync(join(state, n, 'report.json'), 'utf8')));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].failure.code, 'budget_exceeded_plan');
    assert.equal(reports[0].cleanup.complete, true);
  }

  // ---------------------------------------------------------------------
  // Guard rule: one function, both layers (the worker gets its source text)
  // ---------------------------------------------------------------------
  const runId = randomUUID();
  const cfg = {
    instances: {
      linkding: { service: 'linkding', base: 'http://127.0.0.1:1001/', root: 'http://127.0.0.1:1001/api/' },
      karakeep: { service: 'karakeep', base: 'http://127.0.0.1:1002/', root: 'http://127.0.0.1:1002/api/v1/' },
      pinboard: { service: 'pinboard', base: '', root: live.PINBOARD_ROOT },
    },
    pools: { linkding: live.poolUrls('temp', runId, 'linkding', 2), karakeep: live.poolUrls('temp', runId, 'karakeep', 2), pinboard: live.poolUrls('user', runId, 'pinboard', 3) },
    listMarker: 'Pinboard Bookmark Enhanced: Read Later', writes: true, aiOrigin: 'http://127.0.0.1:1003', aiPath: '/v1/chat/completions',
  };
  const view = { created: [{ instance: 'linkding', id: '7', url: cfg.pools.linkding[0] }, { instance: 'karakeep', id: 'k7', url: cfg.pools.karakeep[0] }, { instance: 'pinboard', id: 'pool-1', url: cfg.pools.pinboard[0] }, { instance: 'pinboard', id: 'pool-3', url: cfg.pools.pinboard[2], deleted: true }] };
  const pbAdd = (url, shared) => live.PINBOARD_ROOT + 'posts/add?auth_token=a%3A1&format=json&url=' + encodeURIComponent(url) + '&description=x&extended=&tags=' + (shared ? '&shared=' + shared : '') + '&toread=no&replace=yes';
  // The worker's copy: the rule's source with liveTagKey bound in.
  const transported = new Function('return ' + live.guardRuleSource())();
  const cases = [
    [{ url: 'https://example.org/x', method: 'GET' }, false, 'live_guard_origin'],
    [{ url: 'http://127.0.0.1:1003/v1/chat/completions', method: 'POST' }, true],
    [{ url: 'http://127.0.0.1:1003/v1/chat/completions', method: 'GET' }, false, 'live_guard_ai'],
    [{ url: 'http://127.0.0.1:1003/v1/models', method: 'POST' }, false, 'live_guard_ai'],
    [{ url: 'http://127.0.0.1:1001/api/bookmarks/', method: 'POST', body: JSON.stringify({ url: cfg.pools.linkding[1] }) }, true],
    [{ url: 'http://127.0.0.1:1001/api/bookmarks/', method: 'POST', body: JSON.stringify({ url: 'https://example.com/private' }) }, false, 'live_guard_create'],
    [{ url: 'http://127.0.0.1:1001/api/bookmarks/7/', method: 'PATCH', body: '{}' }, true],
    [{ url: 'http://127.0.0.1:1001/api/bookmarks/8/', method: 'PATCH', body: '{}' }, false, 'live_guard_mutation'],
    [{ url: 'http://127.0.0.1:1001/api/tags/3/', method: 'DELETE' }, false, 'live_guard_mutation'],
    [{ url: 'http://127.0.0.1:1001/api/bookmarks/8/', method: 'OPTIONS' }, true],
    [{ url: 'http://127.0.0.1:1001/bookmarks?unread=yes', method: 'GET' }, true],
    [{ url: 'http://127.0.0.1:1001/admin/logout', method: 'POST' }, false, 'live_guard_mutation'],
    [{ url: 'http://127.0.0.1:1002/api/v1/lists', method: 'POST', body: JSON.stringify({ name: 'Read later', description: cfg.listMarker }) }, true],
    [{ url: 'http://127.0.0.1:1002/api/v1/lists', method: 'POST', body: JSON.stringify({ name: 'Other' }) }, false, 'live_guard_mutation'],
    [{ url: 'http://127.0.0.1:1002/api/v1/lists/L1/bookmarks/k7', method: 'PUT' }, true],
    [{ url: 'http://127.0.0.1:1002/api/v1/lists/L1/bookmarks/k8', method: 'PUT' }, false, 'live_guard_mutation'],
    [{ url: 'http://127.0.0.1:1002/api/v1/bookmarks/k8/tags', method: 'POST', body: '{}' }, false, 'live_guard_mutation'],
    // Pinboard (H2): writes are GETs. posts/add saves only a private pool
    // URL (a create unless the run holds it), posts/delete only a ledger URL;
    // the save chain's reads pass; every other endpoint, bulk ones first, is
    // refused; pinboard.in pages and other API versions are outside.
    [{ url: pbAdd(cfg.pools.pinboard[0], 'no'), method: 'GET' }, true, '', 'mutate'],
    [{ url: pbAdd(cfg.pools.pinboard[1], 'no'), method: 'GET' }, true, '', 'create'],
    [{ url: pbAdd(cfg.pools.pinboard[2], 'no'), method: 'GET' }, true, '', 'create'],
    [{ url: pbAdd(cfg.pools.pinboard[0], 'yes'), method: 'GET' }, false, 'live_guard_create'],
    [{ url: pbAdd(cfg.pools.pinboard[1], ''), method: 'GET' }, false, 'live_guard_create'],
    [{ url: pbAdd('https://example.com/mine', 'no'), method: 'GET' }, false, 'live_guard_create'],
    [{ url: pbAdd(cfg.pools.pinboard[1], 'no'), method: 'POST' }, false, 'live_guard_mutation'],
    [{ url: live.PINBOARD_ROOT + 'posts/delete?url=' + encodeURIComponent(cfg.pools.pinboard[0]) + '&auth_token=t&format=json', method: 'GET' }, true, '', 'mutate'],
    [{ url: live.PINBOARD_ROOT + 'posts/delete?url=' + encodeURIComponent(cfg.pools.pinboard[1]), method: 'GET' }, false, 'live_guard_mutation'],
    [{ url: live.PINBOARD_ROOT + 'posts/delete?url=' + encodeURIComponent('https://example.com/mine'), method: 'GET' }, false, 'live_guard_mutation'],
    [{ url: live.PINBOARD_ROOT + 'posts/get?url=' + encodeURIComponent('https://example.com/mine') + '&format=json', method: 'GET' }, true, '', 'read'],
    [{ url: live.PINBOARD_ROOT + 'tags/get?format=json', method: 'GET' }, true, '', 'read'],
    [{ url: live.PINBOARD_ROOT + 'user/api_token/?auth_token=a%3A1&format=json', method: 'GET' }, true, '', 'read'],
    [{ url: live.PINBOARD_ROOT + 'posts/get?format=json', method: 'OPTIONS' }, false, 'live_guard_mutation'],
    ...['posts/all?toread=yes', 'posts/recent?count=5', 'posts/suggest?url=x', 'posts/update', 'posts/dates', 'tags/rename?old=a&new=b', 'tags/delete?tag=a', 'notes/list', 'user/secret', 'posts/rename?old=a&new=b']
      .map(path => [{ url: live.PINBOARD_ROOT + path, method: 'GET' }, false, 'live_guard_pinboard_endpoint']),
    [{ url: 'https://pinboard.in/u:someone/', method: 'GET' }, false, 'live_guard_origin'],
    [{ url: 'https://api.pinboard.in/v2/bookmarks', method: 'GET' }, false, 'live_guard_origin'],
    // A repeated parameter is refused on every endpoint: a server that reads
    // the last value would otherwise delete, save or publish what the guard
    // never judged (third review).
    [{ url: live.PINBOARD_ROOT + 'posts/delete?url=' + encodeURIComponent(cfg.pools.pinboard[0]) + '&url=' + encodeURIComponent('https://real.example.org/'), method: 'GET' }, false, 'live_guard_pinboard_params'],
    [{ url: pbAdd(cfg.pools.pinboard[1], 'no') + '&url=' + encodeURIComponent('https://real.example.org/'), method: 'GET' }, false, 'live_guard_pinboard_params'],
    [{ url: pbAdd(cfg.pools.pinboard[1], 'no') + '&shared=yes', method: 'GET' }, false, 'live_guard_pinboard_params'],
    ...['tags=x', 'auth_token=b%3A2', 'replace=no', 'toread=yes'].map(extra => [{ url: pbAdd(cfg.pools.pinboard[1], 'no') + '&' + extra, method: 'GET' }, false, 'live_guard_pinboard_params']),
    [{ url: live.PINBOARD_ROOT + 'posts/get?url=' + encodeURIComponent(cfg.pools.pinboard[0]) + '&url=' + encodeURIComponent('https://real.example.org/'), method: 'GET' }, false, 'live_guard_pinboard_params'],
  ];
  for (const rule of [live.liveGuardRule, transported]) {
    for (const [req, ok, code, kind] of cases) {
      const d = rule(cfg, view, req);
      assert.equal(d.ok, ok, req.method + ' ' + req.url);
      if (code) assert.equal(d.code, code, req.method + ' ' + req.url);
      if (kind) assert.equal(d.kind, kind, req.method + ' ' + req.url);
    }
    const readOnly = rule({ ...cfg, writes: false }, view, { url: 'http://127.0.0.1:1001/api/bookmarks/7/', method: 'PATCH', body: '{}' });
    assert.equal(readOnly.code, 'live_guard_read_only', 'read-only modules refuse every write');
    for (const url of [pbAdd(cfg.pools.pinboard[1], 'no'), live.PINBOARD_ROOT + 'posts/delete?url=' + encodeURIComponent(cfg.pools.pinboard[0])]) assert.equal(rule({ ...cfg, writes: false }, view, { url, method: 'GET' }).code, 'live_guard_read_only', url);
  }
  // The rule's endpoint list is the one --plan prints, minus what only the
  // runner may send.
  for (const endpoint of live.PINBOARD_ENDPOINTS.extension) assert(cases.some(([req, ok]) => ok && live.pinboardEndpoint(req.url) === endpoint), endpoint + ' allowed');
  for (const endpoint of live.PINBOARD_REFUSED_EXAMPLES.filter(e => !e.startsWith('https:'))) assert(cases.some(([req, ok]) => !ok && live.pinboardEndpoint(req.url) === endpoint), endpoint + ' refused');
  assert.equal(live.pinboardEndpoint('https://api.pinboard.in/v1/user/api_token/?x=1'), 'user/api_token');
  assert.equal(live.pinboardEndpoint('https://api.pinboard.in.evil.test/v1/posts/get'), '');
  assert.equal(live.pinboardEndpoint('https://pinboard.in/v1/posts/get'), '');
  // Pool URLs: a reserved .example name per run, https, never a loopback port.
  for (const url of cfg.pools.pinboard) assert.match(url, new RegExp('^https://' + runId + '\\.pbp-it\\.example/\\?pbp-it=' + runId + '-pinboard-\\d+$'));

  // ---------------------------------------------------------------------
  // Caps before dispatch (second review). A bookmark, a Read Later list or
  // run-prefix tags beyond the run's limits used to be judged only after the
  // service had created them: two saves that both found no marked list could
  // each create one, and the run would learn of the second only once the
  // user's Karakeep held it. Now both layers refuse such a request before it
  // leaves, counting the ledger and the creations still in flight, and tags
  // count once however a write spells them (keyed the way each service
  // stores them).
  // ---------------------------------------------------------------------
  const prefix0 = 'pbp-it-' + runId;
  const limits0 = { linkding: { bookmarks: 2, lists: 0, tags: 3 }, karakeep: { bookmarks: 2, lists: 1, tags: 3 }, pinboard: { bookmarks: 2, lists: 0, tags: 2 } };
  const listBody = JSON.stringify({ name: 'Read later', icon: 'bookmark', description: cfg.listMarker, type: 'manual' });
  {
    // Route layer: the first list create holds its slot while the service
    // answers; the second is aborted without being sent, and the first is
    // recorded for cleanup.
    const routeRun = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
    routeRun.target = 'user';
    routeRun.instances.karakeep = { id: 'karakeep', service: 'karakeep', ...cfg.instances.karakeep, token: 'k'.repeat(40) };
    routeRun.caps = { karakeep: live.BUDGETS.user.karakeep };
    routeRun.pools.karakeep = cfg.pools.karakeep;
    routeRun.guardCfg = { instances: { karakeep: cfg.instances.karakeep }, pools: routeRun.pools, listMarker: LIST_MARKER, writes: true, aiOrigin: '', aiPath: '', caps: { karakeep: 500 }, prefix: routeRun.prefix, limits: { karakeep: { bookmarks: 12, lists: 1, tags: 20 } } };
    routeRun.poolSet = new Set(routeRun.pools.karakeep);
    routeRun.routeProbe = { url: 'http://pbp-it-route-probe.invalid/' + routeRun.runId, seen: false };
    const sent = [];
    const answers = [];
    const fakeRoute = (path, method, body) => {
      const out = {};
      out.route = {
        request: () => ({ url: () => cfg.instances.karakeep.root + path, method: () => method, postData: () => body }),
        fetch: () => { sent.push(method + ' ' + path); return new Promise(r => answers.push(r)); },
        fulfill: async () => { out.fulfilled = true; },
        abort: async code => { out.aborted = code; },
        continue: async () => { sent.push(method + ' ' + path); out.continued = true; },
      };
      return out;
    };
    const first = fakeRoute('lists', 'POST', listBody), second = fakeRoute('lists', 'POST', listBody);
    const firstDone = routeRun.onRoute(first.route);
    // A second create that is sent waits on its answer forever: bound it.
    await Promise.race([routeRun.onRoute(second.route), new Promise(r => setTimeout(r, 300))]);
    assert.deepEqual(sent, ['POST lists'], 'the second list create is not sent');
    assert.deepEqual([second.aborted, routeRun.fatal, routeRun.report.violations.map(v => v.code)], ['blockedbyclient', 'live_guard_list_budget', ['live_guard_list_budget']]);
    answers[0]({ ok: () => true, text: async () => JSON.stringify({ id: 'L1', name: 'Read later', description: LIST_MARKER, type: 'manual', public: false, hasCollaborators: false, userRole: 'owner' }) });
    await firstDone;
    assert.equal(first.fulfilled, true);
    assert.deepEqual(routeRun.report.ledger.lists.map(l => [l.instance, l.id]), [['karakeep', 'L1']], 'the list that exists is on the ledger for cleanup');
    assert.deepEqual(routeRun.pending.karakeep, { bookmarks: 0, lists: 0 }, 'the slot is released once its answer is recorded');
    // Run-prefix tags are reserved the moment a write naming them leaves.
    routeRun.fatal = null;
    routeRun.report.ledger.created.push({ instance: 'karakeep', id: 'k7', url: cfg.pools.karakeep[0], source: 'route', module: '', deleted: false });
    const tagged = fakeRoute('bookmarks/k7/tags', 'POST', JSON.stringify({ tags: [{ tagName: routeRun.prefix + ' machine learning' }, { tagName: 'personal' }] }));
    await routeRun.onRoute(tagged.route);
    assert.equal(tagged.continued, true);
    assert.deepEqual(routeRun.report.ledger.tags.map(t => [t.instance, t.key, t.source]), [['karakeep', routeRun.prefix + ' machine learning', 'route']]);

    // A list create without an answer may have made a list nobody recorded:
    // its slot stays held and the next one is not sent. A refusal (4xx)
    // made nothing and frees it.
    for (const [label, answer, secondSent] of [['no answer', null, false], ['server error', 503, false], ['refusal', 409, true]]) {
      routeRun.fatal = null;
      routeRun.report.ledger.lists.length = 0;
      routeRun.pending = {};
      sent.length = 0;
      answers.length = 0;
      const lost = fakeRoute('lists', 'POST', listBody);
      if (answer === null) lost.route.fetch = async () => { sent.push('POST lists'); throw new Error('socket hang up'); };
      const lostDone = routeRun.onRoute(lost.route);
      if (answer !== null) {
        for (let i = 0; i < 100 && !answers.length; i++) await new Promise(r => setTimeout(r, 1));
        answers[0]({ ok: () => false, status: () => answer, text: async () => '{}' });
      }
      await lostDone;
      const next = fakeRoute('lists', 'POST', listBody);
      await Promise.race([routeRun.onRoute(next.route), new Promise(r => setTimeout(r, 100))]);
      assert.deepEqual([sent.length, routeRun.fatal], secondSent ? [2, null] : [1, 'live_guard_list_budget'], label);
    }
  }
  {
    // Worker layer, same race: the worker sends one list create, refuses the
    // second (and any later one) and records the violation for syncGuard.
    const sent = [];
    const answers = [];
    const sandbox = vm.createContext({ fetch: (input, opts) => { sent.push((opts?.method || 'GET') + ' ' + input); return new Promise(r => answers.push(r)); }, URL, location: { href: 'chrome-extension://' + 'a'.repeat(32) + '/background.js' } });
    vm.runInContext(`(${live.installWorkerGuard.toString()})(${live.guardRuleSource()}, ${JSON.stringify({ ...cfg, caps: {}, prefix: prefix0, limits: limits0 })}, 'tok')`, sandbox);
    const post = vm.runInContext('(function readLater(u, body) { return fetch(u, { method: "POST", body }); })', sandbox);
    const listsUrl = cfg.instances.karakeep.root + 'lists';
    const firstList = post(listsUrl, listBody);
    const secondList = await Promise.race([post(listsUrl, listBody).then(() => 'answered', e => e.message), new Promise(r => setTimeout(() => r('sent and waiting'), 300))]);
    assert.deepEqual([secondList, sent], ['live_guard_list_budget', ['POST ' + listsUrl]], 'the worker sends one list create');
    answers[0]({ ok: true, clone: () => ({ json: async () => ({ id: 'L1' }) }) });
    await firstList;
    await assert.rejects(post(listsUrl, listBody), e => e.message === 'live_guard_list_budget', 'nor any after it');
    const g = JSON.parse(JSON.stringify(sandbox.pbpLiveGuard));
    assert.deepEqual([g.lists, g.violations.map(v => v.code), g.pending], [[{ instance: 'karakeep', id: 'L1' }], ['live_guard_list_budget', 'live_guard_list_budget'], { karakeep: { bookmarks: 0, lists: 0 } }]);
    // Run tags are reserved as the write leaves; past the cap it is not sent.
    vm.runInContext(`pbpLiveGuard.created.push({ instance: 'karakeep', id: 'k7', url: ${JSON.stringify(cfg.pools.karakeep[0])} })`, sandbox);
    const tagsUrl = cfg.instances.karakeep.root + 'bookmarks/k7/tags';
    const tagBody = names => JSON.stringify({ tags: names.map(tagName => ({ tagName })) });
    const attached = post(tagsUrl, tagBody([prefix0 + '_a', prefix0 + '_b', 'personal']));
    answers[1]({ ok: true, status: 200 });
    await attached;
    const overTags = await Promise.race([post(tagsUrl, tagBody([prefix0 + '_c', prefix0 + '_d'])).then(() => 'answered', e => e.message), new Promise(r => setTimeout(() => r('sent and waiting'), 100))]);
    assert.deepEqual([overTags, JSON.parse(JSON.stringify(sandbox.pbpLiveGuard.tags)), sent.length], ['live_guard_tag_budget', [{ instance: 'karakeep', key: prefix0 + '_a' }, { instance: 'karakeep', key: prefix0 + '_b' }], 2]);
  }
  for (const [label, answer, secondSent] of [['no answer', null, false], ['server error', 503, false], ['refusal', 409, true]]) {
    // As in the route layer: a list create without an answer, or after a
    // server error, keeps its slot in the worker too.
    const sent = [];
    const sandbox = vm.createContext({
      fetch: async (input, opts) => {
        sent.push((opts?.method || 'GET') + ' ' + input);
        if (sent.length > 1) return new Promise(() => {});
        if (answer === null) throw new TypeError('Failed to fetch');
        return { ok: false, status: answer };
      },
      URL, location: { href: 'chrome-extension://' + 'a'.repeat(32) + '/background.js' },
    });
    vm.runInContext(`(${live.installWorkerGuard.toString()})(${live.guardRuleSource()}, ${JSON.stringify({ ...cfg, caps: {}, prefix: prefix0, limits: limits0 })}, 'tok')`, sandbox);
    const post = vm.runInContext('(function readLater(u, body) { return fetch(u, { method: "POST", body }); })', sandbox);
    await post(cfg.instances.karakeep.root + 'lists', listBody).catch(() => {});
    const second = await Promise.race([post(cfg.instances.karakeep.root + 'lists', listBody).then(() => 'answered', e => e.message), new Promise(r => setTimeout(() => r('sent and waiting'), 100))]);
    assert.deepEqual([second, sent.length], secondSent ? ['sent and waiting', 2] : ['live_guard_list_budget', 1], 'worker: ' + label);
  }
  for (const rule of [live.liveGuardRule, transported]) {
    const limited = { ...cfg, prefix: prefix0, limits: limits0 };
    const at = (over = {}) => ({ created: view.created, lists: [], tags: [], pending: {}, ...over });
    const verdict = (v, req, c = limited) => { const d = rule(c, v, req); return d.ok ? 'ok' : d.code; };
    const listPost = { url: cfg.instances.karakeep.root + 'lists', method: 'POST', body: listBody };
    const create = (tagNames = []) => ({ url: cfg.instances.linkding.root + 'bookmarks/?disable_scraping', method: 'POST', body: JSON.stringify({ url: cfg.pools.linkding[1], tag_names: tagNames }) });
    const linkdingTags = names => ({ url: cfg.instances.linkding.root + 'bookmarks/7/', method: 'PATCH', body: JSON.stringify({ tag_names: names }) });
    const karakeepTags = (names, method = 'POST') => ({ url: cfg.instances.karakeep.root + 'bookmarks/k7/tags', method, body: JSON.stringify({ tags: names.map(tagName => ({ tagName })) }) });
    const pinboardAdd = tags => ({ url: live.PINBOARD_ROOT + 'posts/add?url=' + encodeURIComponent(cfg.pools.pinboard[0]) + '&shared=no&tags=' + encodeURIComponent(tags), method: 'GET' });
    const known = (instance, n) => Array.from({ length: n }, (_, i) => ({ instance, key: prefix0 + '_' + (i + 1) }));
    // Lists: one per run on the user target, a create in flight included.
    assert.equal(verdict(at(), listPost), 'ok', 'the first Read Later list');
    assert.equal(verdict(at({ lists: [{ instance: 'karakeep', id: 'L1' }] }), listPost), 'live_guard_list_budget', 'a second list is refused before it is sent');
    assert.equal(verdict(at({ pending: { karakeep: { lists: 1 } } }), listPost), 'live_guard_list_budget', 'a list create in flight holds its slot');
    // Bookmarks: every create counts, a deleted one and one in flight too.
    assert.equal(verdict(at(), create()), 'ok');
    assert.equal(verdict(at({ pending: { linkding: { bookmarks: 1 } } }), create()), 'live_guard_bookmark_budget');
    assert.equal(verdict(at({ created: [...view.created, { instance: 'linkding', id: '6', url: cfg.pools.linkding[1], deleted: true }] }), create()), 'live_guard_bookmark_budget', 'a deleted run bookmark still counts');
    assert.equal(verdict(at({ created: [...view.created, { instance: 'linkding', id: '6', url: cfg.pools.linkding[1] }] }), listPost), 'ok', 'caps are per instance');
    // linkding: tag_names split on commas, spaces become hyphens and ASCII
    // case folds, as linkding stores them; names outside the run prefix are
    // not run tags; names already known are not new.
    let d = rule(limited, at(), linkdingTags([prefix0 + '_a', prefix0 + ' b', prefix0.toUpperCase() + '_A', 'personal']));
    assert.deepEqual([d.ok, d.tags], [true, [prefix0 + '_a', prefix0 + '-b']]);
    d = rule(limited, at({ tags: [{ instance: 'linkding', key: prefix0 + '_a' }] }), linkdingTags([prefix0 + '_a,' + prefix0 + '_c', prefix0 + '_d']));
    assert.deepEqual([d.ok, d.tags], [true, [prefix0 + '_c', prefix0 + '_d']]);
    assert.equal(verdict(at({ tags: [{ instance: 'linkding', key: prefix0 + '_a' }] }), linkdingTags([prefix0 + '_b,' + prefix0 + '_c', prefix0 + '_d'])), 'live_guard_tag_budget', 'one name with commas is three tags');
    assert.equal(verdict(at(), create([1, 2, 3, 4].map(n => prefix0 + '_' + n))), 'live_guard_tag_budget', 'a create naming too many run tags');
    assert.equal(verdict(at({ tags: known('linkding', 3) }), linkdingTags([prefix0 + '_1', prefix0 + '_3', 'personal'])), 'ok', 'known run tags and foreign names add nothing');
    // Karakeep: exact names once trimmed and stripped of leading '#'.
    d = rule(limited, at(), karakeepTags(['#' + prefix0 + '_A', ' ' + prefix0 + '_a ', 'Personal']));
    assert.deepEqual([d.ok, d.tags], [true, [prefix0 + '_A', prefix0 + '_a']]);
    assert.equal(verdict(at({ tags: known('karakeep', 3) }), karakeepTags([prefix0 + '_4'])), 'live_guard_tag_budget');
    assert.equal(verdict(at({ tags: known('karakeep', 3) }), { ...karakeepTags([], 'DELETE'), body: JSON.stringify({ tags: [{ tagId: 't1' }] }) }), 'ok', 'a detach names no tag');
    assert.equal(verdict(at({ tags: known('linkding', 3) }), karakeepTags([prefix0 + '_9'])), 'ok', 'tag caps are per instance');
    // Pinboard posts/add: space-separated tags.
    assert.equal(verdict(at(), pinboardAdd(prefix0 + '_x ' + prefix0 + '_y ' + prefix0 + '_z')), 'live_guard_tag_budget');
    assert.equal(verdict(at(), pinboardAdd(prefix0 + '_x ' + prefix0 + '_y')), 'ok');
    // An instance missing from the limits gets none; a configuration without
    // limits (the earlier shape, kept by the cases above) judges no budget.
    assert.equal(verdict(at(), listPost, { ...limited, limits: {} }), 'live_guard_list_budget');
    assert.equal(verdict(at({ lists: [{ instance: 'karakeep', id: 'L1' }] }), listPost, cfg), 'ok');
    // trackTag keys read-backs with liveTagKey, the rule's own key outside
    // the worker: they must agree, or one tag would count twice.
    const roomy = { ...limited, limits: { linkding: { bookmarks: 9, lists: 0, tags: 99 }, karakeep: { bookmarks: 9, lists: 1, tags: 99 } } };
    const samples = [prefix0 + ' x y', prefix0 + '_Mixed', ' ' + prefix0 + '-z ', '#' + prefix0 + '_h', prefix0 + '_中文', prefix0 + '  double  space'];
    for (const [service, req] of [['linkding', linkdingTags], ['karakeep', karakeepTags]]) {
      const expected = [...new Set(samples.map(n => live.liveTagKey(service, n)))].filter(k => k.toLowerCase().startsWith(prefix0));
      assert.deepEqual(rule(roomy, at(), req(samples)).tags, expected, service + ' keys agree with liveTagKey');
    }
  }

  // fetch resolves a relative URL against the worker script, and so does the
  // guard: Chrome's own chrome.action.setIcon({ path }) binding fetches
  // "icons/pin-default-16.png" through the worker's fetch (run afd11fff), and
  // an extension resource never leaves the browser. A URL that does not parse
  // even then (runs 22df1c6e and f1446f8e listed a blocked origin "invalid"
  // with nothing to trace it by) keeps a query-free sample and the calling
  // frames; syncGuard files them under the module and phase.
  {
    const passed = [];
    const sandbox = vm.createContext({ fetch: async input => { passed.push(String(input)); return { ok: true }; }, URL, location: { href: 'chrome-extension://' + 'a'.repeat(32) + '/background.js' } });
    vm.runInContext(`(${live.installWorkerGuard.toString()})(${live.guardRuleSource()}, ${JSON.stringify({ ...cfg, caps: {} })}, 'tok')`, sandbox);
    const call = vm.runInContext('(function productCaller(u) { return fetch(u); })', sandbox);
    for (const resource of ['icons/pin-default-16.png', '/_locales/en/messages.json', '']) assert.equal((await call(resource)).ok, true, 'extension resource ' + JSON.stringify(resource));
    assert.deepEqual(passed, ['icons/pin-default-16.png', '/_locales/en/messages.json', ''], 'passed to fetch as given');
    for (const bad of ['http://[bad', 'https://exa mple.org/x?token=' + syntheticKey]) await assert.rejects(call(bad), e => e.message === 'live_guard_origin');
    await assert.rejects(call('https://example.org/x'), e => e.message === 'live_guard_origin');
    // The guard state lives in the vm realm: copy before strict deepEqual.
    const seen = JSON.parse(JSON.stringify(sandbox.pbpLiveGuard.violations));
    assert.deepEqual(seen.map(v => [v.origin, v.sample || '']), [['invalid', 'string:http://[bad'], ['invalid', 'string:https://exa mple.org/x'], ['https://example.org', '']]);
    assert(seen.slice(0, 2).every(v => v.where.includes('productCaller')), 'the calling frame is kept: ' + seen[0].where);
    assert(!JSON.stringify(seen).includes(syntheticKey), 'no query string in a sample');
    const syncRun = new live.LiveRun({ mode: 'run' });
    syncRun.ctx = {};
    syncRun.swToken = 'tok';
    syncRun.worker = { evaluate: async () => ({ created: [], lists: [], counts: {}, violations: seen.splice(0) }) };
    syncRun.currentModule = { id: 'linkding.core.snapshot' };
    syncRun.phaseName = 'snapshot_wait';
    await syncRun.syncGuard();
    assert.deepEqual(syncRun.report.blockedOrigins, ['invalid', 'https://example.org']);
    assert.deepEqual(syncRun.report.blockedSamples.map(s => [s.module, s.phase, s.sample]), [['linkding.core.snapshot', 'snapshot_wait', 'string:http://[bad'], ['linkding.core.snapshot', 'snapshot_wait', 'string:https://exa mple.org/x']]);
    assert.equal(syncRun.fatal, null, 'a blocked outside request is evidence, not a fatal violation');
  }

  // Every module phase confirms the worker guard is still installed. A phase
  // that is not awaited still stops the next harness call.
  {
    const guardRun = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
    let present = true;
    const asked = [];
    guardRun.swToken = 'guard-token';
    guardRun.worker = { evaluate: async (fn, token) => { asked.push(token); return present; } };
    guardRun.instances.linkding = cfg.instances.linkding;
    const mod = { id: 'linkding.guard.check', instance: 'linkding', service: 'linkding', record: { checks: [], notes: {} }, budget: { urls: 1 }, claimed: 0, revoked: false };
    const t = guardRun.harness(mod);
    await t.phase('first');
    assert.deepEqual([guardRun.phaseName, guardRun.fatal, asked], ['first', null, ['guard-token']]);
    present = false;
    const unawaited = t.phase('second');
    await new Promise(r => setTimeout(r, 0));
    assert.throws(() => t.expect(true, 'next_step'), e => e.code === 'live_guard_missing' && e.fatal === true);
    await assert.rejects(unawaited, e => e.code === 'live_guard_missing');
    assert.equal(guardRun.fatal, 'live_guard_missing');
    assert.deepEqual(guardRun.report.violations.map(v => [v.code, v.phase]), [['live_guard_missing', 'second']]);
  }

  // A module that times out is revoked before its cleanup starts. Its steps
  // keep running in the background; a late seed must fail locally with
  // module_revoked, not reach the Node guard while cleanup deletes (where a
  // create reads as node_guard_mutation and aborts the whole run).
  {
    const rows = new Map(), seen = [];
    let next = 1;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const path = req.url.split('?')[0];
        seen.push(req.method + ' ' + path);
        const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
        if (req.method === 'POST' && path === '/api/bookmarks/') {
          const b = JSON.parse(body);
          const row = { id: next++, url: b.url, title: b.title, tag_names: [] };
          rows.set(String(row.id), row);
          return json(201, row);
        }
        const record = path.match(/^\/api\/bookmarks\/(\d+)\/$/);
        if (record) {
          const row = rows.get(record[1]);
          if (!row) return json(404, { detail: 'No Bookmark matches the given query.' });
          // A slow DELETE keeps the module cleanup running while the late seed fires.
          if (req.method === 'DELETE') return setTimeout(() => { rows.delete(record[1]); res.writeHead(204); res.end(); }, 600);
          return json(200, row);
        }
        json(404, { detail: 'Not found.' });
      });
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}/`;
    const timeoutRun = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
    timeoutRun.target = 'user';
    timeoutRun.instances.linkding = { id: 'linkding', service: 'linkding', base, root: live.apiRootFor('linkding', base), token: 'f'.repeat(40) };
    timeoutRun.caps = { linkding: live.BUDGETS.user.linkding };
    timeoutRun.reserve = { linkding: 60 };
    timeoutRun.pools.linkding = live.poolUrls('user', timeoutRun.runId, 'linkding', 2);
    timeoutRun.claimed.linkding = 0;
    timeoutRun.guardCfg = {};
    timeoutRun.ctx = { pages: () => [] };
    timeoutRun.worker = { evaluate: async () => {} };
    timeoutRun.syncGuard = async () => {};
    timeoutRun.pushGuardWrites = async () => {};
    // No browser here: the settings snapshot and restore get empty answers.
    timeoutRun.sw = async fn => (String(fn).includes('SETTINGS_DEFAULTS') ? [] : String(fn).includes('storage.local.get') ? {} : undefined);
    let late = '';
    const mod = {
      id: 'linkding.timeout.check', instance: 'linkding', service: 'linkding', needs: { writes: true }, settings: {},
      budget: { bookmarks: 2, urls: 2, node: 40, browser: 0, ai: 0, tags: 0, seconds: 0.3 },
      async steps(t) {
        await t.seed({ title: 'first' });
        await t.sleep(500);
        try { await t.seed({ title: 'late' }); } catch (e) { late = e.code; throw e; }
      },
    };
    await quiet(() => timeoutRun.runModule(mod));
    await new Promise(r => setTimeout(r, 50));
    const record = timeoutRun.report.modules[0];
    assert.deepEqual([record.status, record.failure.code, timeoutRun.fatal], ['failed', 'module_timeout', null], 'a timeout fails the module, not the run');
    assert.equal(late, 'module_revoked', 'the late seed is refused before it reaches the service');
    assert.equal(record.restore, undefined, 'the module settings are restored');
    assert.deepEqual(seen, ['POST /api/bookmarks/', 'GET /api/bookmarks/1/', 'DELETE /api/bookmarks/1/', 'GET /api/bookmarks/1/'], 'one create, then the module cleanup');
    assert.equal(timeoutRun.report.ledger.created[0].deleted, true);
    await closeServer(server);
  }

  // ---------------------------------------------------------------------
  // Pure helpers: endpoints, redaction, Karakeep config, signals, lock
  // ---------------------------------------------------------------------
  for (const bad of ['https://example.com', 'http://127.0.0.1.evil.test', 'http://user:password@127.0.0.1:48100', 'http://127.0.0.1:48100/?key=x', 'http://[::1]:48100', 'http://127.0.0.1:48100/sub/']) {
    assert.throws(() => live.validateBase(bad), e => e.code === 'loopback_required', bad);
  }
  assert.equal(live.validateBase('http://localhost:3030'), 'http://localhost:3030/');
  assert.equal(live.redact('token=' + syntheticKey + '!', [syntheticKey]), 'token=[redacted]!');
  assert.equal(live.failureCode(new Error('fetch failed for ' + syntheticKey), [syntheticKey]), 'Error');
  assert.equal(live.failureCode(new live.HarnessFailure('api_http_403'), [syntheticKey]), 'api_http_403');
  assert.equal(live.findSecret(['harmless', 'contains ' + syntheticKey], [syntheticKey]), true);
  assert.equal(live.findSecret(['pbp-it-run prefix only'], ['pbp-it-run']), false, 'short values never count as canaries');

  // Karakeep /signin: Next.js flight chunks, JSON-string encoded, carrying
  // the root layout's clientConfig (shape captured from Karakeep 0.34.1).
  const flight = inference => `<!DOCTYPE html><html><head><title>Karakeep</title></head><body><script>self.__next_f.push([0])</script>`
    + `<script>self.__next_f.push([1,${JSON.stringify('1:"$Sreact.fragment"\n')}])</script>`
    + `<script>self.__next_f.push([1,${JSON.stringify('7:["$","$L12",null,{"clientConfig":{"publicUrl":"http://127.0.0.1:3000","publicApiUrl":"http://127.0.0.1:3000/api","demoMode":false,"auth":{"disableSignups":false,"disablePasswordAuth":false},"inference":' + JSON.stringify(inference) + ',"serverVersion":"0.34.1","disableNewReleaseCheck":true},"children":["$","$L13",null,{}]}]\n')}])</script></body></html>`;
  const off = { isConfigured: false, inferredTagLang: 'english', enableAutoTagging: false, enableAutoSummarization: false };
  assert.equal(live.karakeepAutoAiOff(live.parseKarakeepClientConfig(flight(off))), true);
  assert.equal(live.karakeepAutoAiOff(live.parseKarakeepClientConfig(flight({ ...off, enableAutoTagging: true }))), false);
  assert.equal(live.karakeepAutoAiOff(live.parseKarakeepClientConfig(flight({ ...off, enableAutoSummarization: true }))), false);
  assert.equal(live.karakeepAutoAiOff(live.parseKarakeepClientConfig(flight({ isConfigured: true }))), false, 'missing flags are not "off"');
  assert.equal(live.parseKarakeepClientConfig('<html><body>Sign in</body></html>'), null);

  const emitter = new EventEmitter();
  const seen = [];
  const remove = live.installSignalHandlers({ proc: emitter, onFirst: s => seen.push('first:' + s), onForce: s => seen.push('force:' + s) });
  emitter.emit('SIGTERM');
  emitter.emit('SIGINT');
  assert.deepEqual(seen, ['first:SIGTERM', 'force:SIGINT'], 'first signal cleans up, second forces exit');
  remove();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(emitter.listenerCount(signal), 0);

  {
    const state = stateDirFor('lock');
    const release = live.acquireLock(state, { pid: process.pid, runId: 'a', reportPath: join(state, 'missing.json') });
    assert.throws(() => live.acquireLock(state, { pid: process.pid, runId: 'b' }), e => e.code === 'run_locked');
    release();
    const again = live.acquireLock(state, { pid: process.pid, runId: 'c' });
    again();
    // A dead holder whose report is unfinished must be resumed, not replaced.
    const stale = join(state, 'pbp-it-' + randomUUID());
    mkdirSync(stale, { mode: 0o700 });
    live.writePrivateJson(join(stale, 'report.json'), { harness: live.HARNESS_VERSION, cleanup: { complete: false } });
    writeFileSync(join(state, 'pbp-it-live.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, runId: 'dead', reportPath: join(stale, 'report.json') }));
    assert.throws(() => live.acquireLock(state, { pid: process.pid, runId: 'd' }), e => e.code === 'previous_cleanup_incomplete');
    assert.deepEqual(live.scanIncompleteReports(state), [join(stale, 'report.json')]);
    // Only a --cleanup of that very report takes a dead holder's lock over (a
    // second Ctrl-C, kill -9, OOM or a crash), under any spelling of its path.
    const other = join(state, 'pbp-it-' + randomUUID());
    mkdirSync(other, { mode: 0o700 });
    live.writePrivateJson(join(other, 'report.json'), { harness: live.HARNESS_VERSION, cleanup: { complete: false } });
    assert.throws(() => live.acquireLock(state, { pid: process.pid, runId: 'f' }, { resume: join(other, 'report.json') }), e => e.code === 'previous_cleanup_incomplete', 'resuming another report does not free the lock');
    symlinkSync(stale, join(state, 'alias'));
    const takeover = live.acquireLock(state, { pid: process.pid, runId: 'dead' }, { resume: join(state, 'alias', 'report.json') });
    assert.equal(JSON.parse(readFileSync(join(state, 'pbp-it-live.lock'), 'utf8')).pid, process.pid, 'the --cleanup of that report now holds the lock');
    takeover();
    assert(!existsSync(join(state, 'pbp-it-live.lock')));
    // A live holder is never taken over, not even by a --cleanup of its report.
    writeFileSync(join(state, 'pbp-it-live.lock'), JSON.stringify({ pid: process.pid, runId: 'live', reportPath: join(stale, 'report.json') }));
    assert.throws(() => live.acquireLock(state, { pid: process.pid, runId: 'g' }, { resume: join(stale, 'report.json') }), e => e.code === 'run_locked');
    rmSync(join(state, 'pbp-it-live.lock'));
    rmSync(join(state, 'alias'));
    live.writePrivateJson(join(other, 'report.json'), { harness: live.HARNESS_VERSION, cleanup: { complete: true } });
    live.writePrivateJson(join(stale, 'report.json'), { harness: live.HARNESS_VERSION, cleanup: { complete: true } });
    live.acquireLock(state, { pid: process.pid, runId: 'e' })();
    assert.deepEqual(live.scanIncompleteReports(state), []);
  }

  // --cleanup holds its report to what this harness writes for that run id
  // before it reads a credential or sends a request. Review finding B: an
  // edited prefix '' made the tag sweep delete an unrelated zero-use tag,
  // and an edited base sent the token to 127.0.0.2.
  {
    const state = stateDirFor('resume-validate');
    const runId = randomUUID();
    const runDir = join(state, 'pbp-it-' + runId);
    mkdirSync(runDir, { mode: 0o700 });
    const reportPath = join(runDir, 'report.json');
    const base = 'http://127.0.0.1:48999/';
    const names = live.tempNames(runId);
    const genuine = (target = 'user') => {
      const r = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] }).report;
      Object.assign(r, { runId, prefix: 'pbp-it-' + runId, target, instances: { linkding: { service: 'linkding', base } }, pools: { linkding: live.poolUrls(target, runId, 'linkding', 4) } });
      r.ledger.created.push({ instance: 'linkding', id: '7', url: r.pools.linkding[0], source: 'route', module: 'linkding.core.worker', deleted: false });
      if (target === 'temp') r.temp = { names: [names.edge, names.linkding], network: names.net };
      return r;
    };
    live.writePrivateJson(reportPath, genuine());
    const userValues = { cleanup: reportPath, credentials: credentialsPath, linkding: 'http://127.0.0.1:48999' };
    const tempValues = { cleanup: reportPath };
    const validate = (r, values, path = reportPath) => live.validateResumeReport(r, path, { values, state });
    validate(genuine(), userValues);
    validate(genuine('temp'), tempValues);
    // Written before its arguments were read: valid, and nothing to clean.
    const skeleton = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] }).report;
    validate(Object.assign(skeleton, { runId, prefix: 'pbp-it-' + runId }), tempValues);
    const refused = (target, mutate, code, values = target === 'user' ? userValues : tempValues, path = reportPath) => {
      const r = genuine(target);
      mutate(r);
      assert.throws(() => validate(r, values, path), e => e.code === code, `${target}: ${code} expected`);
    };
    const invalid = 'cleanup_report_invalid';
    refused('user', r => { r.prefix = ''; }, invalid);
    refused('user', r => { r.prefix = 'pbp-it-'; }, invalid);
    refused('user', r => { r.runId = '-'.repeat(36); }, invalid);
    refused('user', r => { r.runId = [runId]; }, invalid);
    refused('user', r => { r.target = 'pinboard'; }, invalid);
    refused('user', r => { r.instances.linkding.service = 'pinboard'; }, invalid);
    refused('user', r => { r.instances.pinboard = { service: 'pinboard', base: 'https://api.pinboard.in/' }; }, invalid);
    refused('user', r => { r.instances.linkding.base = 'http://127.0.0.2:48999/'; }, invalid);
    refused('user', r => { r.instances.linkding.base = 'http://127.0.0.1:48999/api/'; }, invalid);
    refused('user', r => { r.instances.linkding.base = 'https://127.0.0.1:48999/'; }, invalid);
    // The user target names its instances again; the report cannot redirect.
    refused('user', () => {}, 'cleanup_base_required', { ...userValues, linkding: undefined });
    refused('user', () => {}, 'cleanup_base_mismatch', { ...userValues, linkding: 'http://127.0.0.1:48100' });
    refused('user', () => {}, 'cleanup_target_mismatch', { ...userValues, target: 'temp' });
    // Pools are this run's exact URLs, never a personal one or another run's.
    refused('user', r => { r.pools.linkding[1] = 'https://example.com/personal'; }, invalid);
    refused('user', r => { r.pools.linkding = live.poolUrls('user', randomUUID(), 'linkding', 4); }, invalid);
    refused('user', r => { r.pools.linkding = live.poolUrls('temp', runId, 'linkding', 4); }, invalid);
    refused('user', r => { r.pools.linkding = live.poolUrls('user', runId, 'linkding', 189); }, invalid);
    refused('user', r => { r.pools.linkding = 'https://example.com/'; }, invalid);
    refused('user', r => { r.ledger.created[0].id = '../7'; }, invalid);
    refused('user', r => { r.ledger.created[0].instance = 'karakeep'; }, invalid);
    refused('user', r => { r.ledger.lists.push({ instance: 'linkding', id: 'abc' }); }, invalid);
    refused('user', r => { r.ledger = []; }, invalid);
    refused('user', r => { r.cleanup = null; }, invalid);
    refused('user', r => { r.temp = { names: [], network: '' }; }, invalid);
    refused('temp', r => { r.temp.names.push('linkding'); }, invalid);
    refused('temp', r => { r.temp.names.push('pbp-it-' + randomUUID() + '-edge'); }, invalid);
    refused('temp', r => { r.temp.names.push(names.prefix); }, invalid);
    refused('temp', r => { r.temp.network = 'bridge'; }, invalid);
    refused('temp', r => { r.instances['linkding-pg'] = { service: 'karakeep', base }; }, invalid);
    refused('temp', () => {}, 'temp_target_rejects_user_endpoints', userValues);
    assert.throws(() => validate(Object.assign(genuine('temp'), { target: '' }), tempValues), e => e.code === invalid, 'an untargeted report holds nothing');
    // The report lives in its own run directory of this state directory.
    const elsewhere = join(dir, 'elsewhere-' + runId);
    mkdirSync(elsewhere, { mode: 0o700 });
    live.writePrivateJson(join(elsewhere, 'report.json'), genuine());
    refused('user', () => {}, 'cleanup_report_location', userValues, join(elsewhere, 'report.json'));
    const otherDir = join(state, 'pbp-it-' + randomUUID());
    mkdirSync(otherDir, { mode: 0o700 });
    live.writePrivateJson(join(otherDir, 'report.json'), genuine());
    refused('user', () => {}, 'cleanup_report_location', userValues, join(otherDir, 'report.json'));
    const linkedId = randomUUID();
    mkdirSync(join(state, 'pbp-it-' + linkedId), { mode: 0o700 });
    symlinkSync(join(elsewhere, 'report.json'), join(state, 'pbp-it-' + linkedId, 'report.json'));
    assert.throws(() => validate(Object.assign(genuine(), { runId: linkedId, prefix: 'pbp-it-' + linkedId, pools: { linkding: live.poolUrls('user', linkedId, 'linkding', 4) } }), userValues, join(state, 'pbp-it-' + linkedId, 'report.json')), e => e.code === 'cleanup_report_location', 'a symlinked report is not in its run directory');
    // Nor may the run directory itself be a link (second review): its
    // realpath used to pass, and cleanup then removed `profile` and `env-*`
    // inside the link's target.
    const linkedDirId = randomUUID();
    const linkTarget = join(dir, 'link-target-' + linkedDirId);
    mkdirSync(linkTarget, { mode: 0o700 });
    const linkedDir = Object.assign(genuine(), { runId: linkedDirId, prefix: 'pbp-it-' + linkedDirId, pools: { linkding: live.poolUrls('user', linkedDirId, 'linkding', 4) } });
    live.writePrivateJson(join(linkTarget, 'report.json'), linkedDir);
    symlinkSync(linkTarget, join(state, 'pbp-it-' + linkedDirId));
    assert.throws(() => validate(linkedDir, userValues, join(state, 'pbp-it-' + linkedDirId, 'report.json')), e => e.code === 'cleanup_report_location', 'a run directory that is a link is refused');
    // A link to the state directory (or one inside it) still names the real run directory.
    symlinkSync(state, join(dir, 'state-alias-' + runId));
    validate(genuine(), userValues, join(dir, 'state-alias-' + runId, 'pbp-it-' + runId, 'report.json'));
    live.validateResumeReport(genuine(), reportPath, { values: userValues, state: join(dir, 'state-alias-' + runId) });
    rmSync(join(dir, 'state-alias-' + runId));
    rmSync(state, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
    rmSync(linkTarget, { recursive: true, force: true });

    // Cleanup itself: a ledger entry outside the pool is not even read, and
    // the tag sweep refuses any prefix but the run's own. No request leaves.
    const guarded = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
    guarded.instances.linkding = { id: 'linkding', service: 'linkding', base, root: live.apiRootFor('linkding', base), token: 'f'.repeat(40) };
    guarded.caps = { linkding: live.BUDGETS.user.linkding };
    guarded.reserve = { linkding: 0 };
    guarded.pools.linkding = live.poolUrls('user', guarded.runId, 'linkding', 2);
    guarded.cleaning = true;
    assert.equal(await guarded.deleteBookmark({ instance: 'linkding', id: '99', url: 'https://example.com/personal', deleted: false }), false);
    assert.equal(guarded.report.cleanup.entries.at(-1).code, 'cleanup_url');
    guarded.prefix = 'pbp-it-';
    await assert.rejects(guarded.runTags('linkding'), e => e.code === 'cleanup_prefix_invalid' && e.fatal);
    assert.equal(guarded.counts.linkding?.node ?? 0, 0, 'no request before the checks');
  }

  // ---------------------------------------------------------------------
  // Node API: a module reproducing a server failure names the status; it
  // gets the status back and nothing is recorded. Other failures throw.
  // The report on disk is redacted as a whole.
  // ---------------------------------------------------------------------
  {
    const seen = [];
    const server = createServer((req, res) => {
      seen.push(req.method + ' ' + req.url);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h1>Server Error (500)</h1>');
    });
    const port = await listen(server);
    const run = new live.LiveRun({ mode: 'run' });
    const base = `http://127.0.0.1:${port}/`;
    run.instances.linkding = { id: 'linkding', service: 'linkding', base, root: live.apiRootFor('linkding', base), token: 'f'.repeat(40) };
    // Complete caps, as a run has them: a missing bookmark cap allows none.
    run.caps = { linkding: { ...live.BUDGETS.temp.linkding, node: 10 } };
    run.reserve = { linkding: 2 };
    run.pools.linkding = live.poolUrls('temp', run.runId, 'linkding', 2);
    const reproduced = await run.api('linkding', 'bookmarks/', { method: 'POST', body: { url: run.pools.linkding[0], tag_names: ['x'.repeat(70)] }, allowStatus: [500] });
    assert.deepEqual(reproduced, { failedStatus: 500 });
    assert.equal(run.report.ledger.created.length, 0, 'a reproduced failure records nothing');
    await assert.rejects(run.api('linkding', 'bookmarks/', { method: 'POST', body: { url: run.pools.linkding[1] } }), e => e.code === 'api_http_500');
    assert.deepEqual(seen, ['POST /api/bookmarks/', 'POST /api/bookmarks/']);
    await closeServer(server);
    // persist(): free-text notes that echo a secret never reach the disk.
    mkdirSync(run.runDir, { recursive: true, mode: 0o700 });
    run.addSecret(syntheticKey);
    run.report.modules.push({ id: 'linkding.x', notes: { popupMessage: 'echo ' + syntheticKey } });
    run.persist();
    assert(!readFileSync(run.reportPath, 'utf8').includes(syntheticKey), 'persisted report is redacted');
    rmSync(run.runDir, { recursive: true, force: true });
  }

  // Node writes (seeds) count against the same caps by the same rule
  // (second review): a seed past a cap is refused before it is sent, the run
  // tags it names are reserved before it leaves, and a Node create in flight
  // holds its slot against a browser create. A read-back confirms a reserved
  // tag instead of counting it again, and still catches a run tag no write
  // named.
  {
    const seen = [], answers = [];
    let next = 1, holdPosts = false, failStatus = 0;
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        seen.push(req.method + ' ' + req.url.split('?')[0]);
        const send = () => {
          if (failStatus) { res.writeHead(failStatus, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
          const b = JSON.parse(raw);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: next++, url: b.url, tag_names: b.tag_names || [] }));
        };
        if (holdPosts) answers.push(send); else send();
      });
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}/`;
    const nodeRun = caps => {
      const r = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      r.target = 'user';
      r.instances.linkding = { id: 'linkding', service: 'linkding', base, root: live.apiRootFor('linkding', base), token: 'f'.repeat(40) };
      r.caps = { linkding: { ...live.BUDGETS.user.linkding, ...caps } };
      r.reserve = { linkding: 60 };
      r.pools.linkding = live.poolUrls('user', r.runId, 'linkding', 3);
      return r;
    };
    let r = nodeRun({ tags: 2 });
    const p = r.prefix;
    await r.api('linkding', 'bookmarks/', { method: 'POST', body: { url: r.pools.linkding[0], tag_names: [p + '_a', 'personal'] } });
    assert.deepEqual(r.report.ledger.tags.map(t => [t.key, t.source]), [[p + '_a', 'node']], 'reserved when the seed leaves');
    r.trackTag('linkding', { id: 5, name: p + '_a' });
    assert.deepEqual(r.report.ledger.tags.map(t => [t.key, t.id, t.source]), [[p + '_a', '5', 'node']], 'a read-back confirms a reserved tag');
    await assert.rejects(r.api('linkding', 'bookmarks/', { method: 'POST', body: { url: r.pools.linkding[1], tag_names: [p + '_b', p + '_c'] } }), e => e.code === 'live_guard_tag_budget' && e.fatal === true);
    assert.deepEqual(seen, ['POST /api/bookmarks/'], 'a seed past the tag cap is not sent');
    r = nodeRun({ tags: 1 });
    r.trackTag('linkding', { id: 6, name: r.prefix + '_x' });
    assert.equal(r.fatal, null);
    r.trackTag('linkding', { id: 7, name: r.prefix.toUpperCase() + '_X' });
    assert.equal(r.fatal, null, 'one linkding tag in two cases');
    r.trackTag('linkding', { id: 8, name: r.prefix + '_y' });
    assert.equal(r.fatal, 'tag_budget', 'a run tag no write named still counts');
    seen.length = 0;
    r = nodeRun({ bookmarks: 1 });
    r.report.ledger.created.push({ instance: 'linkding', id: '9', url: r.pools.linkding[0], source: 'route', module: '', deleted: true });
    await assert.rejects(r.api('linkding', 'bookmarks/', { method: 'POST', body: { url: r.pools.linkding[1] } }), e => e.code === 'live_guard_bookmark_budget' && e.fatal === true);
    assert.deepEqual(seen, [], 'a seed past the bookmark cap is not sent');
    r = nodeRun({ bookmarks: 1 });
    holdPosts = true;
    const seeding = r.api('linkding', 'bookmarks/', { method: 'POST', body: { url: r.pools.linkding[0] } });
    r.guardCfg = r.buildGuardCfg();
    r.guardCfg.writes = true;
    r.poolSet = new Set(r.pools.linkding);
    r.routeProbe = { url: 'http://pbp-it-route-probe.invalid/' + r.runId, seen: false };
    const browser = { sent: 0, aborted: '' };
    await r.onRoute({
      request: () => ({ url: () => r.instances.linkding.root + 'bookmarks/', method: () => 'POST', postData: () => JSON.stringify({ url: r.pools.linkding[1], tag_names: [] }) }),
      fetch: async () => { browser.sent++; throw new Error('sent'); }, fulfill: async () => {}, continue: async () => { browser.sent++; },
      abort: async code => { browser.aborted = code; },
    });
    assert.deepEqual([browser.sent, browser.aborted, r.fatal], [0, 'blockedbyclient', 'live_guard_bookmark_budget'], 'a browser create meets the Node create in flight');
    for (let i = 0; i < 400 && !answers.length; i++) await new Promise(res => setTimeout(res, 5));
    holdPosts = false;
    answers.shift()();
    await seeding;
    assert.deepEqual([r.report.ledger.created.map(e => e.source), r.pending.linkding], [['node'], { bookmarks: 0, lists: 0 }], 'the seed is recorded and its slot released');
    // A seed that failed with a server error may exist unrecorded: its slot
    // stays held. One the service refused (4xx) made nothing.
    for (const [status, nextSent] of [[500, false], [400, true]]) {
      r = nodeRun({ bookmarks: 1 });
      seen.length = 0;
      failStatus = status;
      assert.deepEqual(await r.api('linkding', 'bookmarks/', { method: 'POST', body: { url: r.pools.linkding[0] }, allowStatus: [status] }), { failedStatus: status });
      failStatus = 0;
      const after = r.api('linkding', 'bookmarks/', { method: 'POST', body: { url: r.pools.linkding[1] } });
      if (nextSent) await after; else await assert.rejects(after, e => e.code === 'live_guard_bookmark_budget');
      assert.equal(seen.length, nextSent ? 2 : 1, 'after status ' + status);
    }
    await closeServer(server);

    // The guard configuration a run hands both layers carries its limits and
    // prefix, and survives the JSON trip to the worker.
    const cfgRun = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
    for (const id of ['linkding', 'karakeep']) cfgRun.instances[id] = { id, service: id, ...cfg.instances[id], token: 'x'.repeat(40) };
    cfgRun.caps = { linkding: live.BUDGETS.user.linkding, karakeep: live.BUDGETS.user.karakeep };
    cfgRun.pools = { linkding: cfg.pools.linkding, karakeep: cfg.pools.karakeep };
    const built = JSON.parse(JSON.stringify(cfgRun.buildGuardCfg()));
    assert.deepEqual(built.limits, { linkding: { bookmarks: 15, lists: 0, tags: 20 }, karakeep: { bookmarks: 12, lists: 1, tags: 20 } });
    assert.deepEqual([built.prefix, built.writes, built.caps, built.listMarker], [cfgRun.prefix, false, { linkding: 350, karakeep: 500 }, LIST_MARKER]);
    // syncGuard confirms the worker's own reservations.
    cfgRun.ctx = {};
    cfgRun.swToken = 'tok';
    cfgRun.worker = { evaluate: async () => ({ created: [], lists: [], tags: [{ instance: 'karakeep', key: cfgRun.prefix + '_w' }], counts: {}, violations: [] }) };
    await cfgRun.syncGuard();
    assert.deepEqual(cfgRun.report.ledger.tags.map(t => [t.instance, t.key, t.source]), [['karakeep', cfgRun.prefix + '_w', 'sw']]);
    // What the other layers record reaches the worker guard, so it judges
    // by the same counts; what the worker reported is not sent back.
    const g = { token: 'tok', created: [], lists: [], tags: [{ instance: 'karakeep', key: cfgRun.prefix + '_w' }] };
    const shares = [];
    cfgRun.worker = { evaluate: async (fn, arg) => { shares.push(arg.field); const saved = globalThis.pbpLiveGuard; globalThis.pbpLiveGuard = g; try { return fn(arg); } finally { globalThis.pbpLiveGuard = saved; } } };
    cfgRun.noteTags('karakeep', [{ key: cfgRun.prefix + '_w' }, { key: cfgRun.prefix + '_r' }], 'route');
    cfgRun.noteTags('karakeep', [{ key: cfgRun.prefix + '_s' }], 'sw');
    for (let i = 0; i < 2; i++) await cfgRun.shareGuard('lists', [{ instance: 'karakeep', id: 'L9' }]);
    assert.deepEqual([shares, g.tags.map(t => t.key), g.lists], [['tags', 'lists', 'lists'], [cfgRun.prefix + '_w', cfgRun.prefix + '_r'], [{ instance: 'karakeep', id: 'L9' }]]);
  }

  // A guard violation stops the run, but cleanup still needs the API (run
  // f1446f8e deleted only 3 of its 5 ledger bookmarks when every cleanup
  // request failed with the violation): finalize deletes the ledger bookmark,
  // adopts and deletes an unrecorded pool bookmark, and verifies.
  {
    const fatalRun = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
    const pool = live.poolUrls('user', fatalRun.runId, 'linkding', 3);
    const rows = new Map([['7', { id: 7, url: pool[0], tag_names: [] }], ['8', { id: 8, url: pool[1], tag_names: [] }], ['99', { id: 99, url: 'https://example.com/personal', tag_names: ['personal'] }]]);
    const seen = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      seen.push(req.method + ' ' + url.pathname);
      const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const record = url.pathname.match(/^\/api\/bookmarks\/(\d+)\/$/);
      if (record) {
        const row = rows.get(record[1]);
        if (!row) return json(404, { detail: 'No Bookmark matches the given query.' });
        if (req.method === 'DELETE') { rows.delete(record[1]); res.writeHead(204); return res.end(); }
        return json(200, row);
      }
      if (url.pathname === '/api/bookmarks/check/') return json(200, { bookmark: [...rows.values()].find(r => r.url === url.searchParams.get('url')) || null, metadata: { title: null, description: null }, auto_tags: [] });
      if (url.pathname === '/api/tags/') return json(200, { count: 0, next: null, previous: null, results: [] });
      json(404, { detail: 'Not found.' });
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}/`;
    fatalRun.target = 'user';
    fatalRun.instances.linkding = { id: 'linkding', service: 'linkding', base, root: live.apiRootFor('linkding', base), token: 'f'.repeat(40) };
    fatalRun.caps = { linkding: live.BUDGETS.user.linkding };
    fatalRun.reserve = { linkding: 60 };
    fatalRun.pools.linkding = pool;
    fatalRun.writesPossible = true;
    fatalRun.report.ledger.created.push({ instance: 'linkding', id: '7', url: pool[0], source: 'route', module: 'linkding.core.worker', deleted: false });
    fatalRun.setFatal('live_guard_mutation');
    await fatalRun.finalize();
    assert.deepEqual(seen.filter(s => s.startsWith('DELETE')), ['DELETE /api/bookmarks/7/', 'DELETE /api/bookmarks/8/'], 'ledger and pool bookmarks are deleted after a guard violation');
    assert(rows.has('99'), 'a personal bookmark is untouched');
    assert.deepEqual(fatalRun.report.ledger.created.map(e => [e.id, e.source, e.deleted]), [['7', 'route', true], ['8', 'pool', true]]);
    assert.deepEqual([fatalRun.report.cleanup.apiVerified, fatalRun.report.cleanup.complete, fatalRun.fatal], [true, true, 'live_guard_mutation'], 'cleanup verifies; the violation stays on record');
    await closeServer(server);
  }

  // ---------------------------------------------------------------------
  // linkding tag cleanup: a run tag is deleted only after its own searches
  // (active and archived) find no bookmark. linkding 1.47 has two search
  // modes (bookmarks/queries.py): the expression parser, where "or" is an
  // operator, and profile.legacy_search, which splits on spaces and ANDs
  // every word ("#x" = tag iexact, other words = title/description/notes/url
  // icontains), so "#a or #b" there matches only bookmarks carrying both tags
  // and "or". The profile API does not say which mode is on.
  // ---------------------------------------------------------------------
  for (const mode of ['legacy', 'expression']) {
    const run = new live.LiveRun({ mode: 'run' });
    const p = run.prefix;
    const tags = [{ id: 1, name: p + '_a' }, { id: 2, name: p + '_b' }, { id: 3, name: p.toUpperCase() + '_C' }, { id: 4, name: p + '_q"x' }, { id: 5, name: 'personal' }];
    const bookmarks = [
      { id: 10, url: 'https://example.com/kept', title: 'Kept', description: '', notes: '', is_archived: false, tag_names: [p + '_b', 'personal'] },
      { id: 11, url: 'https://example.com/old', title: 'Old', description: '', notes: '', is_archived: true, tag_names: [p.toUpperCase() + '_C'] },
    ];
    const hasTag = (b, name) => b.tag_names.some(t => t.toLowerCase() === name.toLowerCase());
    const legacy = (b, q) => q.trim().split(' ').filter(Boolean).every(w => w[0] === '#' ? hasTag(b, w.slice(1)) : [b.title, b.description, b.notes, b.url].some(f => f.toLowerCase().includes(w.toLowerCase())));
    // The subset of the expression grammar a cleanup query can use: tags and
    // words joined by implicit AND, alternatives joined by "or".
    const expression = (b, q) => q.trim().split(/\s+or\s+/i).some(alt => legacy(b, alt));
    const requests = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      requests.push(req.method + ' ' + url.pathname + (url.searchParams.has('q') ? ' q=' + url.searchParams.get('q') : ''));
      const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
      const tag = url.pathname.match(/^\/api\/tags\/(\d+)\/$/);
      if (tag) {
        const at = tags.findIndex(t => String(t.id) === tag[1]);
        if (at < 0) return json(404, { detail: 'No Tag matches the given query.' });
        if (req.method === 'DELETE') { tags.splice(at, 1); res.writeHead(204); return res.end(); }
        return json(200, tags[at]);
      }
      if (url.pathname === '/api/tags/') return json(200, { count: tags.length, next: null, previous: null, results: tags });
      const archived = url.pathname === '/api/bookmarks/archived/';
      if (archived || url.pathname === '/api/bookmarks/') {
        const q = url.searchParams.get('q') || '';
        const hits = bookmarks.filter(b => b.is_archived === archived && (mode === 'legacy' ? legacy : expression)(b, q));
        return json(200, { count: hits.length, next: null, previous: null, results: hits.slice(0, Number(url.searchParams.get('limit')) || 100) });
      }
      return json(404, { detail: 'Not found.' });
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}/`;
    run.instances.linkding = { id: 'linkding', service: 'linkding', base, root: live.apiRootFor('linkding', base), token: 'f'.repeat(40) };
    run.caps = { linkding: { node: 100 } };
    run.reserve = { linkding: 0 };
    run.cleaning = true;
    assert.equal(await run.cleanupTags('linkding'), false, mode + ': referenced run tags fail the cleanup');
    assert.deepEqual(tags.map(t => t.id), [2, 3, 4, 5], mode + ': only the unreferenced run tag is deleted');
    assert.deepEqual(run.report.cleanup.entries.map(e => [e.id, e.deleted, e.code || '']), [['1', true, ''], ['2', false, 'cleanup_tag_referenced'], ['3', false, 'cleanup_tag_referenced'], ['4', false, 'cleanup_tag_unsearchable']], mode);
    const searches = requests.filter(r => r.includes(' q='));
    assert(searches.every(r => /^GET \/api\/bookmarks\/(archived\/)? q=#\S+$/.test(r)), mode + ': each search names one tag: ' + searches.join(' | '));
    assert(!searches.some(r => r.includes('personal')), 'only run tags are searched');
    assert(requests.length <= 2 + 4 * 4, mode + ': a tag costs at most two searches, a DELETE and a GET, on top of the sweep');
    assert(requests.length <= live.cleanupCost({ service: 'linkding', tags: 4 }), mode + ': cleanupCost covers the tag cleanup');
    await closeServer(server);
  }

  // ---------------------------------------------------------------------
  // Fake AI: product prompts classify, replies parse with product parsers
  // ---------------------------------------------------------------------
  const productCtx = vm.createContext({ console, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, btoa, atob, encodeURIComponent, decodeURIComponent, escape, unescape });
  for (const file of ['shared.js', 'ai.js']) vm.runInContext(readFileSync(join(root, file), 'utf8'), productCtx, { filename: file });
  const product = vm.runInContext(`({
    tags: buildTagPrompt({ aiTagSeparator: '_' }, 'Title', 'http://localhost:47391/', 'Body', '', ['existing']),
    summary: buildSummaryPrompt({}, 'Title', 'http://localhost:47391/', 'Body', ''),
    combined: buildCombinedPrompt({ aiTagSeparator: '_' }, 'Title', 'http://localhost:47391/', 'Body', '', ['existing']),
    parseTags: parseAITags, parseCombined: parseAICombined,
  })`, productCtx);
  for (const kind of ['tags', 'summary', 'combined']) assert.equal(live.classifyPrompt(product[kind]), kind, kind + ' prompt drifted from the fake AI classifier');
  assert.equal(live.classifyPrompt('Translate this'), 'unknown');

  const prefix = 'pbp-it-' + randomUUID();
  const fake = await live.startFakeAi({ prefix, limit: 7 });
  const statuses = [];
  const ask = async (prompt, extra = {}) => {
    const r = await httpCall({ port: fake.port, headers: { Authorization: 'Bearer ' + fake.key, ...extra.headers }, path: extra.path, method: extra.method, body: extra.body ?? { model: 'pbp-fake-ai', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1024, ...(extra.stream ? { stream: true } : {}) } });
    statuses.push(r.status);
    return r;
  };
  const replyOf = r => JSON.parse(r.text).choices[0];
  let r = await ask(product.tags);
  assert.equal(r.status, 200);
  assert.equal(replyOf(r).finish_reason, 'stop');
  // Product parsers run in a vm realm; copy results before strict deepEqual.
  const tags = Array.from(product.parseTags(replyOf(r).message.content, '_'));
  assert(tags.length >= 1 && tags.every(t => t.startsWith(prefix)), 'fake tags carry the run prefix after the product parser');
  r = await ask(product.summary);
  const summary = replyOf(r).message.content;
  assert(summary.includes(fake.marker) && summary.includes('\n'), 'summary is multi-line and carries the run marker');
  r = await ask(product.combined);
  const combined = JSON.parse(JSON.stringify(product.parseCombined(replyOf(r).message.content, '_')));
  assert(combined.summary.includes(fake.marker) && combined.tags.every(t => t.startsWith(prefix)));
  fake.expect({ kind: 'tags', reply: '["' + prefix + '_queued"]' });
  r = await ask(product.tags);
  assert.deepEqual(Array.from(product.parseTags(replyOf(r).message.content, '_')), [prefix + '_queued'], 'expect() queues one reply');
  r = await ask(product.summary, { stream: true });
  assert.equal(r.status, 200);
  assert(r.type.startsWith('text/event-stream'));
  const events = r.text.split('\n\n').filter(Boolean);
  assert.equal(events.at(-1), 'data: [DONE]');
  const streamed = events.slice(0, -1).map(e => JSON.parse(e.slice(6))).map(e => e.choices[0].delta.content || '').join('');
  assert(streamed.includes(fake.marker), 'SSE chunks reassemble the summary');
  r = await ask(product.tags, { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(r.status, 401);
  r = await ask('Translate this page');
  assert.equal(r.status, 404);
  assert.equal(fake.unknown(), 1);
  // 8th request: over the cap of 7, refused with 503 and the run marked failed.
  r = await ask(product.tags);
  assert.equal(r.status, 503);
  assert.equal(fake.failed(), 'fake_ai_auth', 'first failure is kept');
  const forged = await httpCall({ port: fake.port, headers: { Host: 'example.com', Authorization: 'Bearer ' + fake.key }, body: {} });
  assert.equal(forged.status, 403, 'foreign Host header is refused');
  assert(!statuses.includes(400) && !statuses.includes(422), 'never 400/422: they trigger dialect fallback retries');
  const metadata = fake.all();
  for (const entry of metadata) assert.deepEqual(Object.keys(entry).sort(), ['auth', 'hasPrefix', 'kind', 'method', 'model', 'n', 'path', 'promptBytes', 'status', 'stream']);
  assert(!JSON.stringify(metadata).includes('Suggest up to') && !JSON.stringify(metadata).includes(fake.key), 'fake AI records metadata only');
  assert.equal(fake.calls(), 5);
  await fake.close();
  const capped = await live.startFakeAi({ prefix, limit: 1 });
  await httpCall({ port: capped.port, headers: { Authorization: 'Bearer ' + capped.key }, body: { model: 'm', messages: [{ role: 'user', content: product.summary }] } });
  const capReply = await httpCall({ port: capped.port, headers: { Authorization: 'Bearer ' + capped.key }, body: { model: 'm', messages: [{ role: 'user', content: product.summary }] } });
  assert.equal(capReply.status, 503);
  assert.equal(capped.failed(), 'fake_ai_budget', 'exceeding the cap fails the run');
  await capped.close();

  // ---------------------------------------------------------------------
  // Docker: names, refusals, and the temp lifecycle with a fake executor
  // ---------------------------------------------------------------------
  const names = live.tempNames(runId);
  for (const [key, name] of Object.entries(names)) assert(name.startsWith('pbp-it-' + runId + '-'), key);
  const own = names.linkding;
  const refused = [
    [['rm', '-f', '-v', 'linkding'], 'docker_foreign_object'],
    [['rm', '-f', '-v', own, 'karakeep-web'], 'docker_foreign_object'],
    [['stop', own], 'docker_command_refused'],
    [['restart', 'linkding'], 'docker_command_refused'],
    [['update', '--memory', '1g', 'karakeep-web'], 'docker_command_refused'],
    [['exec', 'karakeep-web', 'sh'], 'docker_foreign_object'],
    [['pull', 'postgres:18'], 'docker_command_refused'],
    [['inspect', 'linkding'], 'docker_command_refused'],
    [['inspect', '--format', '{{json .Config.Env}}', 'karakeep-web'], 'docker_command_refused'],
    [['network', 'connect', 'bridge', 'linkding'], 'docker_foreign_object'],
    [['run', '-d', '--pull', 'never', '--name', names['linkding-fixture'], '--network', 'container:linkding', 'img'], 'docker_foreign_object'],
    [['network', 'create', '--subnet', '10.1.2.0/24', names.net], 'docker_foreign_object'],
    [['network', 'rm', 'bridge'], 'docker_foreign_object'],
    [['run', '-d', '--pull', 'never', '--name', 'pbp-it-' + randomUUID() + '-linkding', '--network', names.net, 'img'], 'docker_foreign_object'],
    [['run', '-d', '--pull', 'missing', '--name', own, '--network', names.net, 'img'], 'docker_command_refused'],
    [['run', '-d', '--pull', 'never', '--name', own, '--network', 'host', 'img'], 'docker_foreign_object'],
    [['run', '-d', '--pull', 'never', '--name', own, '--network', names.net, '-v', '/:/host', 'img'], 'docker_command_refused'],
    [['run', '-d', '--pull', 'never', '--name', own, '--network', 'bridge', '-p', '0.0.0.0::80', 'img'], 'docker_command_refused'],
    [['ps', '-a'], 'docker_command_refused'],
  ];
  for (const [args, code] of refused) assert.throws(() => live.assertDockerArgs(args, runId), e => e.code === code && e.fatal === true, args.join(' '));
  for (const args of [['inspect', '--format', '{{.Image}}', 'linkding'], ['image', 'inspect', '--format', '{{.Id}}', 'postgres:18'], ['ps', '-a', '--filter', 'name=pbp-it-', '--format', '{{.Names}}'], ['rm', '-f', '-v', own, names.edge], ['exec', own, 'python', 'manage.py', 'shell', '-c', 'x'], ['run', '-d', '--pull', 'never', '--name', names['linkding-fixture'], '--network', 'container:' + own, 'img']]) {
    live.assertDockerArgs(args, runId);
  }

  const linkdingHealth = createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'healthy' })); });
  const karakeepHealth = createServer((req, res) => { res.writeHead(req.url === '/api/health' ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', message: 'Web app is working' })); });
  servers.push(linkdingHealth, karakeepHealth);
  const ports = { '9101/tcp': await listen(linkdingHealth), '9102/tcp': await listen(karakeepHealth) };
  const fakeDocker = ({ leftovers = [], imageMissing = false, states = {}, token = 'Traceback (most recent call last)' } = {}) => {
    const calls = [], envFiles = {};
    let password = '';
    const exec = async args => {
      calls.push([...args]);
      const [cmd, sub] = args;
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      if (cmd === 'ps' || (cmd === 'network' && sub === 'ls') || (cmd === 'volume' && sub === 'ls')) return ok(cmd === 'ps' ? leftovers.join('\n') : '');
      if (cmd === 'inspect' && args[2] === '{{.Image}}') return imageMissing ? { code: 1, stdout: '', stderr: 'Error: No such object' } : ok('sha256:' + (args[3] === 'linkding' ? 'a' : 'b').repeat(64) + '\n');
      if (cmd === 'inspect') return ok((states[args[3]] || 'running 0') + '\n');
      if (cmd === 'image') return ok('sha256:' + 'c'.repeat(64) + '\n');
      if (cmd === 'create' || cmd === 'run') {
        const name = args[args.indexOf('--name') + 1];
        const text = readFileSync(args[args.indexOf('--env-file') + 1], 'utf8');
        envFiles[name] = text;
        password ||= (text.match(/^LD_SUPERUSER_PASSWORD=(.+)$/m) || [])[1] || '';
        return ok('0123456789ab\n');
      }
      if (cmd === 'network' || cmd === 'start' || cmd === 'rm') return ok();
      if (cmd === 'port') return ok('127.0.0.1:' + ports[args[2]] + '\n');
      if (cmd === 'logs') return ok('Superuser password ' + password + '\nlinkding exited\n');
      if (cmd === 'exec') return ok(token + '\n');
      return { code: 1, stdout: '', stderr: 'unexpected command' };
    };
    return { exec, calls, envFiles, password: () => password };
  };
  const tempRun = async (name, docker, scenario = 'readonly') => {
    const state = stateDirFor(name);
    process.env.PBP_LIVE_STATE_DIR = state;
    const code = await quiet(() => live.main(['--run', '--target', 'temp', '--scenario', scenario, '--allow-dirty'], { dockerExec: docker.exec }));
    const runDirs = readdirSync(state).filter(n => n.startsWith('pbp-it-') && n !== 'pbp-it-live.lock');
    assert.equal(runDirs.length, 1);
    const runDir = join(state, runDirs[0]);
    const raw = readFileSync(join(runDir, 'report.json'), 'utf8');
    if (docker.password()) {
      assert(!raw.includes(docker.password()), 'temp superuser password leaked to report');
      assert(!readFileSync(join(runDir, 'summary.zh.md'), 'utf8').includes(docker.password()));
    }
    assert(!readdirSync(runDir).some(n => n.startsWith('env-') || n === 'profile'), 'env files and profile are removed');
    assert(!existsSync(join(state, 'pbp-it-live.lock')), 'lock released');
    const report = JSON.parse(raw);
    for (const args of docker.calls) live.assertDockerArgs(args, report.runId);
    const ownPrefix = 'pbp-it-' + report.runId + '-';
    for (const args of docker.calls) {
      if (['create', 'run', 'start', 'exec', 'rm'].includes(args[0]) || (args[0] === 'network' && ['create', 'connect', 'rm'].includes(args[1]))) {
        // Every run-scoped name anywhere in the call (container:<name> too)
        // belongs to this run.
        const named = args.join(' ').match(/pbp-it-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g) || [];
        assert(named.length && named.every(a => a === 'pbp-it-' + report.runId), 'mutating docker call outside this run: ' + args[0]);
      }
      if (args[0] === 'inspect' && args[2] === '{{.Image}}') assert(['linkding', 'karakeep-web'].includes(args[3]));
    }
    return { code, report, ownPrefix };
  };

  {
    const foreign = 'pbp-it-' + randomUUID() + '-edge';
    const docker = fakeDocker({ leftovers: [foreign] });
    const { code, report } = await tempRun('leftovers', docker);
    assert.equal(code, 1);
    assert.equal(report.failure.code, 'temp_leftovers_present');
    assert.deepEqual(report.temp.leftovers, [foreign]);
    assert(!docker.calls.some(a => ['create', 'run', 'rm', 'exec', 'start'].includes(a[0]) || (a[0] === 'network' && a[1] !== 'ls')), 'leftovers stop the run before any docker change');
    assert.equal(report.cleanup.complete, true);
  }
  {
    const docker = fakeDocker({ imageMissing: true });
    const { report } = await tempRun('image-missing', docker);
    assert.equal(report.failure.code, 'temp_image_missing');
    assert(!docker.calls.some(a => a[0] === 'pull'));
  }
  {
    const docker = fakeDocker();
    const { code, report, ownPrefix } = await tempRun('token-failure', docker);
    assert.equal(code, 1);
    assert.equal(report.failure.code, 'temp_token_failed');
    const created = docker.calls.filter(a => a[0] === 'create' || a[0] === 'run').map(a => a[a.indexOf('--name') + 1]);
    assert.deepEqual(created.sort(), ['edge', 'karakeep', 'karakeep-fixture', 'linkding', 'linkding-fixture'].map(n => ownPrefix + n).sort());
    const removedNames = docker.calls.filter(a => a[0] === 'rm').flatMap(a => a.slice(3));
    assert.deepEqual(removedNames.sort(), created.sort(), 'cleanup removes exactly what this run created');
    const net = docker.calls.find(a => a[0] === 'network' && a[1] === 'create');
    assert(net.includes('--internal') && net.includes('--subnet') && net.at(-1) === ownPrefix + 'net', 'services sit on an --internal network');
    assert(docker.calls.some(a => a[0] === 'network' && a[1] === 'rm' && a[2] === ownPrefix + 'net'));
    const edge = docker.calls.find(a => a[0] === 'create');
    assert.equal(edge[edge.indexOf('--network') + 1], 'bridge');
    assert(edge.filter((a, i) => edge[i - 1] === '-p').every(p => /^127\.0\.0\.1::\d+$/.test(p)), 'edge publishes on 127.0.0.1 only');
    assert(docker.calls.some(a => a.join(' ') === `network connect ${ownPrefix}net ${ownPrefix}edge`), 'edge joins the internal network to forward');
    for (const svc of docker.calls.filter(a => a[0] === 'run')) {
      const name = svc[svc.indexOf('--name') + 1], network = svc[svc.indexOf('--network') + 1];
      // Services sit on the internal network; each fixture sidecar shares
      // its service's namespace so `localhost` there is the fixture.
      if (name.endsWith('-fixture')) assert.equal(network, 'container:' + name.slice(0, -'-fixture'.length));
      else assert(network === ownPrefix + 'net' && svc.includes('--tmpfs'));
      assert(svc[svc.indexOf('--pull') + 1] === 'never' && !svc.includes('-p'));
    }
    assert.match(docker.envFiles[ownPrefix + 'linkding'], /^LD_ALLOWED_INTERNAL_HOSTS=localhost$/m);
    assert.match(docker.envFiles[ownPrefix + 'linkding-fixture'], new RegExp('^PBP_FIXTURE_PORT=' + live.TEMP_FIXTURE_PORT + '$', 'm'));
    assert.match(docker.envFiles[ownPrefix + 'karakeep'], /^INFERENCE_ENABLE_AUTO_TAGGING=false$/m);
    assert.match(docker.envFiles[ownPrefix + 'karakeep'], /^INFERENCE_ENABLE_AUTO_SUMMARIZATION=false$/m);
    assert.match(docker.envFiles[ownPrefix + 'karakeep'], /^CRAWLER_ALLOWED_INTERNAL_HOSTNAMES=localhost$/m);
    assert(live.poolUrls('temp', report.runId, 'linkding', 1)[0].startsWith(`http://localhost:${live.TEMP_FIXTURE_PORT}/?pbp-it=`), 'temp bookmark URLs use the loopback fixture the extension may be granted');
    assert.equal(report.temp.removed, true);
    assert.equal(report.cleanup.complete, true);
    assert(!docker.calls.some(a => a[0] === 'exec' && !a[1].startsWith(ownPrefix)));
  }
  {
    // The throwaway account must confirm that automatic snapshots are off.
    const docker = fakeDocker({ token: 'PBPTOKEN=' + 'a'.repeat(40) });
    const { report } = await tempRun('profile-unconfirmed', docker);
    assert.equal(report.failure.code, 'temp_profile_failed');
    const script = docker.calls.find(a => a[0] === 'exec' && a.includes('manage.py')).at(-1);
    assert.match(script, /^u\.profile\.enable_automatic_html_snapshots=False$/m);
  }
  {
    const docker = fakeDocker({ token: 'PBPSNAPSHOTS=False\nPBPTOKEN=' + 'a'.repeat(40) });
    const { report } = await tempRun('profile-confirmed', docker);
    // linkding is ready; the fake Karakeep only answers its health route.
    assert.equal(report.failure.code, 'temp_signup_failed');
    assert(!JSON.stringify(report).includes('a'.repeat(40)), 'the temp token stays out of the report');
  }
  {
    const docker = fakeDocker({ states: {} });
    // The linkding container dies right after start: its logs are kept, redacted.
    const exitDocker = { ...docker, exec: async args => (args[0] === 'inspect' && args[2] !== '{{.Image}}' && /-linkding$/.test(args[3]) ? (docker.calls.push(args), { code: 0, stdout: 'exited 1\n', stderr: '' }) : docker.exec(args)) };
    const { report } = await tempRun('container-exit', exitDocker);
    assert.equal(report.failure.code, 'container_start_failed');
    assert(report.temp.logs.linkding.some(line => line.includes('[redacted]')), 'container logs are redacted');
    assert.equal(report.temp.removed, true);
  }

  // ---------------------------------------------------------------------
  // Signals during a temporary run (real signals, scripted Docker executor)
  // ---------------------------------------------------------------------
  const teardown = ['rm', 'ps', 'network rm', 'network ls', 'volume ls'];
  {
    // SIGINT while `docker run` is still creating linkding (container start
    // takes 9-15 s, the likeliest moment for Ctrl-C): cleanup waits for that
    // command, every later create/run/start/exec is refused (the fixture
    // sidecar came next), and only then are the names removed and checked.
    const state = stateDirFor('signal-start');
    const { code, lines, report, reportPath } = await dockerChildRun({ state, holds: { 'run:linkding': 1500 }, signals: ['start\trun:linkding\t'], args: ['--run', '--target', 'temp', '--scenario', 'linkding.readonly', '--service', 'linkding', '--allow-dirty'] });
    assert.equal(code, 130);
    const signalled = lines.indexOf('signal\tSIGINT');
    const later = lines.slice(signalled + 1).filter(l => l.startsWith('start\t')).map(l => l.split('\t')[1]);
    assert(signalled > 0 && later.length && later.every(key => teardown.includes(key)), 'only teardown reaches Docker after the signal: ' + later.join(', '));
    const settled = lines.indexOf('done\trun:linkding'), removal = lines.findIndex(l => l.startsWith('start\trm\t'));
    assert(settled > signalled && removal > settled, 'the in-flight run settles before anything is removed');
    const own = live.tempNames(report.runId);
    assert.deepEqual(JSON.parse(lines[removal].split('\t')[2]).slice(3).sort(), [own.edge, own.linkding].sort(), 'the container created during the signal is removed by name');
    assert(lines.slice(removal).some(l => l === 'start\tnetwork rm\t' + JSON.stringify(['network', 'rm', own.net])));
    assert.deepEqual([report.failure.code, report.temp.removed, report.cleanup.complete], ['interrupted_sigint', true, true]);
    assert(!readdirSync(join(reportPath, '..')).some(n => n.startsWith('env-')), 'no env file is written after cleanup began');
    assert(!existsSync(join(state, 'pbp-it-live.lock')));
    assert(['rm', 'ps'].every(cmd => live.isTeardownCommand([cmd])) && !['run', 'create', 'start', 'exec'].some(cmd => live.isTeardownCommand([cmd])));
    assert(live.isTeardownCommand(['network', 'rm', 'x']) && !live.isTeardownCommand(['network', 'create', 'x']) && !live.isTeardownCommand(['network', 'connect', 'x', 'y']));
  }
  {
    // A second signal skips the rest of cleanup, marks the report incomplete
    // and exits, but drops its lock: the report alone keeps new runs out and
    // --cleanup can finish the job at once. Before, the forced exit left its
    // lock and --cleanup was refused with previous_cleanup_incomplete.
    const state = stateDirFor('signal-force');
    const args = ['--run', '--target', 'temp', '--scenario', 'linkding.readonly', '--service', 'linkding', '--allow-dirty'];
    const forced = await dockerChildRun({ state, args, holds: { 'network create': 1500, 'network rm': 20000 }, signals: ['start\tnetwork create\t', 'start\tnetwork rm\t'] });
    assert.equal(forced.code, 130, forced.output);
    assert.deepEqual([forced.report.cleanup.forced, forced.report.cleanup.complete, forced.report.failure.code], [true, false, 'cleanup_incomplete']);
    assert(!existsSync(join(state, 'pbp-it-live.lock')), 'the forced exit releases its lock');
    assert(forced.output.includes('--cleanup ' + forced.reportPath), 'the forced exit names the report to resume');
    const own = live.tempNames(forced.report.runId);
    assert.equal(forced.report.temp.network, own.net, 'the network is on record although its creation was cut short');
    const blocked = await dockerChildRun({ state, args });
    assert.deepEqual([blocked.code, blocked.report.failure.code, blocked.lines], [1, 'previous_cleanup_incomplete', []], 'a new run is refused before Docker');
    const resumed = await dockerChildRun({ state, args: ['--cleanup', forced.reportPath] });
    assert.equal(resumed.code, 0, resumed.output);
    assert.equal(resumed.reportPath, forced.reportPath);
    assert(resumed.lines.includes('start\tnetwork rm\t' + JSON.stringify(['network', 'rm', own.net])), 'the resume removes the network');
    assert(resumed.lines.filter(l => l.startsWith('start\t')).every(l => teardown.includes(l.split('\t')[1])), 'the resume only tears down');
    assert.deepEqual([resumed.report.cleanup.complete, resumed.report.temp.removed, resumed.report.cleanup.resumed], [true, true, 1]);
    assert(!existsSync(join(state, 'pbp-it-live.lock')));
  }
  {
    // A temp run killed (kill -9, OOM) after its pools were written but
    // before startTemp recorded anything has no temp record. Every container
    // and the network are recorded before they are created, so nothing of
    // that run can exist: --cleanup checks for leftovers and completes,
    // instead of failing on the missing record at every attempt while the
    // incomplete report blocks every new run.
    const state = stateDirFor('resume-early');
    const id = randomUUID();
    const early = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] }).report;
    Object.assign(early, { runId: id, prefix: 'pbp-it-' + id, target: 'temp', scenario: 'linkding.readonly', pools: { linkding: live.poolUrls('temp', id, 'linkding', 3) } });
    mkdirSync(join(state, 'pbp-it-' + id), { mode: 0o700 });
    live.writePrivateJson(join(state, 'pbp-it-' + id, 'report.json'), early);
    const resumed = await dockerChildRun({ state, args: ['--cleanup', join(state, 'pbp-it-' + id, 'report.json')] });
    assert.equal(resumed.code, 0, resumed.output);
    assert.deepEqual(resumed.lines.filter(l => l.startsWith('start\t')).map(l => l.split('\t')[1]), ['ps', 'network ls', 'volume ls'], 'only the leftover check');
    assert.deepEqual([resumed.report.cleanup.complete, resumed.report.temp.removed, resumed.report.temp.residue], [true, true, []]);
  }

  // ---------------------------------------------------------------------
  // Screenshot canary on a plain page (no extension, no network)
  // ---------------------------------------------------------------------
  const { chromium } = createRequire(join(root, '.qa-scan/package.json'))('playwright');
  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const page = await browser.newPage({ viewport: { width: 420, height: 600 } });
  const shotsDir = join(dir, 'shots');
  mkdirSync(shotsDir, { mode: 0o700 });
  const shoot = async (html, name) => {
    await page.setContent('<!doctype html><title>Shot</title><body style="margin:0">' + html + '</body>');
    const file = join(shotsDir, name + '.png');
    return { file, result: await live.takeShot(page, { file, secrets: [syntheticKey], keys: ['#save'] }) };
  };
  let shot = await shoot(`<input type="password" id="opt-linkding-token" value="${syntheticKey}"><input type="text" id="opt-linkding-cf-id" value="client-id"><input type="checkbox" id="opt-sync-api-keys"><button class="key-toggle" data-target="opt-linkding-token" aria-pressed="false">show</button><button id="save">Save</button>`, 'masked');
  assert.equal(shot.result.ok, true, 'masked password field passes');
  assert(existsSync(shot.file) && (statSync(shot.file).mode & 0o777) === 0o600);
  assert.equal(shot.result.geometry.ok, true);
  shot = await shoot(`<p>Token: ${syntheticKey}</p><button id="save">Save</button>`, 'body-leak');
  assert.equal(shot.result.code, 'shot_secret_canary');
  assert(!existsSync(shot.file), 'a leaking screenshot is deleted');
  shot = await shoot(`<input id="title-input" value="${syntheticKey}"><button id="save">Save</button>`, 'value-leak');
  assert.equal(shot.result.code, 'shot_secret_canary');
  shot = await shoot(`<button id="save" title="${syntheticKey}">Save</button>`, 'title-leak');
  assert.equal(shot.result.code, 'shot_secret_canary');
  shot = await shoot(`<button id="save" aria-label="Copy ${syntheticKey}">Save</button>`, 'aria-leak');
  assert.equal(shot.result.code, 'shot_secret_canary');
  shot = await shoot(`<input type="text" id="opt-karakeep-token" value="x"><button id="save">Save</button>`, 'revealed');
  assert.equal(shot.result.code, 'shot_secret_field_revealed');
  assert(!existsSync(shot.file), 'nothing is captured while a secret field is revealed');
  shot = await shoot(`<input type="password" id="opt-karakeep-token" value="x"><button class="key-toggle" data-target="opt-karakeep-token" aria-pressed="true">hide</button><button id="save">Save</button>`, 'toggle-pressed');
  assert.equal(shot.result.code, 'shot_secret_field_revealed');
  shot = await shoot(`<div style="width:900px;height:10px"></div><button id="save" style="margin-top:2000px">Save</button>`, 'geometry');
  assert.equal(shot.result.ok, true);
  assert.equal(shot.result.geometry.overflowOk, false, 'horizontal overflow is reported');
  assert.equal(shot.result.geometry.ok, false);
  assert.deepEqual([shot.result.geometry.scrollWidth, shot.result.geometry.viewport.width], [900, 420]);
  assert.equal(shot.result.geometry.overflowBy[0].el, 'div', 'the element that widens the page is named');
  assert.equal(shot.result.geometry.keys[0].inViewport, false);
  assert.equal(shot.result.geometry.keys[0].state, 'scroll', 'a key below the fold is reachable by scrolling');
  // A toolbar popup is at most 600px tall and scrolls vertically: a key
  // control below the fold is reachable, not a finding.
  shot = await shoot(`<div style="height:900px"></div><button id="save">Save</button>`, 'below-fold');
  assert.deepEqual([shot.result.geometry.keys[0].state, shot.result.geometry.ok], ['scroll', true]);
  assert(shot.result.geometry.scrollHeight > 900);
  // The popup clips horizontally (body overflow-x: hidden): a control pushed
  // past the right edge cannot be scrolled to.
  shot = await shoot(`<style>body{overflow-x:hidden}</style><span class="tag-item" style="display:inline-flex;white-space:nowrap;margin-left:380px">long-tag<button id="save">x</button></span>`, 'clipped-x');
  assert.deepEqual([shot.result.geometry.keys[0].state, shot.result.geometry.ok, shot.result.geometry.overflowOk], ['clipped', false, false]);
  assert.equal(shot.result.geometry.overflowBy[0].el, 'span.tag-item');
  // Clipped by an ancestor that cannot scroll, versus one that can.
  shot = await shoot(`<div style="height:50px;overflow:hidden"><div style="height:200px"></div><button id="save">Save</button></div>`, 'clipped-ancestor');
  assert.deepEqual([shot.result.geometry.keys[0].state, shot.result.geometry.ok], ['clipped', false]);
  shot = await shoot(`<div style="height:50px;overflow:auto"><div style="height:200px"></div><button id="save">Save</button></div>`, 'scroll-ancestor');
  assert.deepEqual([shot.result.geometry.keys[0].state, shot.result.geometry.ok], ['scroll', true]);
  // A page that cannot scroll vertically hides what is below the fold.
  shot = await shoot(`<style>html,body{overflow:hidden}</style><div style="height:900px"></div><button id="save">Save</button>`, 'no-scroll');
  assert.deepEqual([shot.result.geometry.keys[0].state, shot.result.geometry.ok], ['clipped', false]);
  // A consumed action (display:none) and a control that never rendered are
  // told apart from one that is merely below the fold.
  shot = await shoot(`<button id="save" style="display:none">Save</button>`, 'hidden');
  assert.deepEqual([shot.result.geometry.keys[0].state, shot.result.geometry.ok], ['hidden', false]);
  shot = await shoot(`<p>No button</p>`, 'missing');
  assert.deepEqual([shot.result.geometry.keys[0].state, shot.result.geometry.ok], ['missing', false]);
  await browser.close();
  browser = null;

  // ---------------------------------------------------------------------
  // Spawned CLI: plan, list, gates (credential file and fetch blocked)
  // ---------------------------------------------------------------------
  const plan = await run(['--plan'], { credentials: false });
  assert.equal(plan.code, 0, '--plan must succeed without credential, network or docker access');
  const value = JSON.parse(plan.output);
  assert.equal(value.harness, live.HARNESS_VERSION);
  assert.equal(value.target, 'temp');
  assert.deepEqual(value.modules.map(m => m.id), pick('core'));
  assert.deepEqual(value.instances, ['linkding', 'karakeep']);
  assert(value.containers.includes('edge'));
  assert.equal(value.credentialsRead, false);
  assert.equal(value.realRequests, 0);
  assert.equal(value.docker, false);
  assert.equal(value.browser, false);
  // core on linkding: the snapshot, popup/reader and worker modules, one bookmark each.
  assert.equal(value.budget.linkding.bookmarks, 3);
  const userPlan = JSON.parse((await run(['--plan', '--target', 'user', '--service', 'linkding', '--linkding', 'http://127.0.0.1:48100'])).output);
  assert.deepEqual(userPlan.services, ['linkding']);
  assert.deepEqual(userPlan.bases, { linkding: 'http://127.0.0.1:48100/' });
  assert.equal(userPlan.budget.linkding.caps.bookmarks, 15);
  assert.equal(userPlan.karakeepWritesRequireAutoAiDisabled, false);
  const edges = await run(['--plan', '--target', 'user', '--scenario', 'edges', '--service', 'karakeep', '--karakeep', 'http://127.0.0.1:3030']);
  assert.equal(edges.code, 0);
  const edgePlan = JSON.parse(edges.output);
  assert.equal(edgePlan.scenario, 'edges');
  assert.deepEqual(edgePlan.modules.map(m => m.id), ['karakeep.edges.tags']);
  assert.equal(edgePlan.budget.karakeep.bookmarks, 4);
  assert.equal(edgePlan.budget.karakeep.caps.bookmarks, 12);
  assert.equal(edgePlan.karakeepWritesRequireAutoAiDisabled, true);
  // Rounds per authorisation: three per label, refused before any credential
  // read or request, and shown by --plan.
  {
    const state = stateDirFor('authorization');
    const cap = live.BUDGETS.user.run.roundsPerAuthorization;
    assert.equal(cap, 3);
    assert.deepEqual(live.authorizationStatus(state, 'auth-a', cap), { required: true, label: 'auth-a', roundsPerAuthorization: 3, used: 0, left: 3 });
    for (let i = 1; i <= 3; i++) assert.equal(live.claimAuthorizationRound(state, 'auth-a', { runId: 'r' + i }, cap).round, i);
    assert.throws(() => live.claimAuthorizationRound(state, 'auth-a', { runId: 'r4' }, cap), e => e.code === 'authorization_rounds_exhausted');
    assert.equal(live.claimAuthorizationRound(state, 'auth-b', { runId: 'r5' }, cap).round, 1, 'labels count separately');
    assert.equal(statSync(join(state, 'pbp-it-authorizations.json')).mode & 0o777, 0o600);
    for (const bad of ['', ' x', 'a b', 'x'.repeat(65), '../x', 'a/b', '-x']) assert.throws(() => live.validateAuthorizationLabel(bad), e => e.code === 'authorization_label', JSON.stringify(bad));
    const shown = JSON.parse((await run(['--plan', '--target', 'user', '--authorization', 'auth-a'], { credentials: false, state })).output);
    assert.deepEqual(shown.authorization, { required: true, label: 'auth-a', roundsPerAuthorization: 3, used: 3, left: 0 });
    assert.equal(shown.limits.roundsPerAuthorization, 3);
    assert.equal((await run(['--plan', '--target', 'user', '--authorization', 'auth-a'], { credentials: false, state })).code, 1, 'an exhausted label fails --plan');
    assert.deepEqual(JSON.parse((await run(['--plan', '--target', 'user'], { credentials: false, state })).output).authorization, { required: true, label: '', roundsPerAuthorization: 3, used: null, left: null });
    assert.deepEqual(JSON.parse((await run(['--plan'], { credentials: false, state })).output).authorization, { required: false });
    const missing = await run(['--run', '--target', 'user', '--service', 'linkding', '--linkding', 'http://127.0.0.1:48100'], { state, authorization: false });
    assert.equal(missing.code, 1);
    assert.equal(missing.report.failure.code, 'authorization_required');
    const exhausted = await run(['--run', '--target', 'user', '--service', 'linkding', '--linkding', 'http://127.0.0.1:48100', '--read-only', '--allow-dirty', '--authorization', 'auth-a'], { state });
    assert.equal(exhausted.code, 1);
    assert.equal(exhausted.report.failure.code, 'authorization_rounds_exhausted');
    assert.equal(exhausted.report.cleanup.complete, true);
    assert.equal(live.readAuthorizations(state).labels['auth-a'].length, 3, 'a refused round is not recorded twice');
    writeFileSync(join(state, 'pbp-it-authorizations.json'), '{not json');
    assert.throws(() => live.claimAuthorizationRound(state, 'auth-c', {}, cap), e => e.code === 'authorization_ledger_invalid');
  }
  const listed = await run(['--list'], { credentials: false });
  assert.deepEqual(listed.output.trim().split('\n'), ids);
  const unknown = await run(['--run', '--target', 'user', '--scenario', 'unknown', '--service', 'linkding', '--linkding', 'http://127.0.0.1:48100']);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.report.failure.code, 'scenario');
  for (const args of [['--help', '--run'], []]) {
    const result = await run(args, { credentials: false });
    assert.equal(result.code, args.includes('--help') ? 0 : 2);
  }
  for (const badBase of ['https://example.com', 'http://127.0.0.1.evil.test', 'http://user:password@127.0.0.1:48100', 'http://127.0.0.1:48100/?key=x', 'http://[::1]:48100']) {
    const result = await run(['--run', '--target', 'user', '--service', 'linkding', '--linkding', badBase]);
    assert.equal(result.code, 1);
    assert.equal(result.report.failure.code, 'loopback_required');
  }
  for (const args of [['--linkding', 'http://127.0.0.1:48100'], ['--credentials', credentialsPath]]) {
    const result = await run(['--run', '--target', 'temp', ...args], { credentials: false });
    assert.equal(result.report.failure.code, 'temp_target_rejects_user_endpoints');
  }
  const inference = await run(['--run', '--target', 'user', '--service', 'karakeep', '--karakeep', 'http://127.0.0.1:48101']);
  assert.equal(inference.code, 1);
  assert.equal(inference.report.failure.code, 'karakeep_auto_ai_not_confirmed_off');

  // ---------------------------------------------------------------------
  // Karakeep on the user target: /signin must prove auto AI off
  // ---------------------------------------------------------------------
  for (const signin of [flight({ ...off, enableAutoTagging: true }), '<html><body>Sign in</body></html>']) {
    const requests = [];
    const karakeep = createServer((req, res) => {
      requests.push({ method: req.method, path: req.url.split('?')[0], authenticated: req.headers.authorization === 'Bearer ' + syntheticKarakeepKey });
      const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/api/health') return json(200, { status: 'ok', message: 'Web app is working' });
      if (req.url === '/signin') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(signin); }
      if (req.headers.authorization !== 'Bearer ' + syntheticKarakeepKey) return json(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });
      if (req.url === '/api/v1/users/me') return json(200, { id: 'u1', name: 'Synthetic', email: 'synthetic@example.invalid', image: null, localUser: true });
      if (req.url.startsWith('/api/v1/bookmarks/check-url?')) return json(200, { bookmarkId: null });
      return json(404, { code: 'NOT_FOUND', message: 'Not found' });
    });
    servers.push(karakeep);
    const port = await listen(karakeep);
    const result = await run(['--run', '--target', 'user', '--service', 'karakeep', '--karakeep', 'http://127.0.0.1:' + port, '--scenario', 'karakeep.core.worker', '--confirm-karakeep-no-auto-ai', '--allow-dirty'], { guard: false, state: stateDirFor('karakeep-ai-' + port) });
    assert.equal(result.code, 1);
    assert.equal(result.report.failure.code, 'karakeep_auto_ai_not_verified_off');
    assert(requests.every(q => q.method === 'GET'), 'no write before the auto AI check');
    assert.equal(requests.at(-1).path, '/signin');
    assert.deepEqual(result.report.modules, [], 'no module (and no browser) ran');
    assert.equal(result.report.cleanup.complete, true);
    assert(requests.length === 3 + result.report.pools.karakeep.length, 'health, users/me, one check per pool URL, /signin; no cleanup traffic');
  }

  // ---------------------------------------------------------------------
  // linkding on the user target: opaque 403, read-only browser path,
  // refusal after an unfinished run, --cleanup resume, SIGINT
  // ---------------------------------------------------------------------
  const linkdingState = stateDirFor('linkding');
  const requests = [];
  let allowAuthentication = false, hang = false;
  const store = { bookmarks: new Map(), tags: new Map() };
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    const query = new URL(req.url, 'http://x').searchParams;
    requests.push({ url: req.url, path, method: req.method, authenticated: req.headers.authorization === 'Token ' + syntheticKey });
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    if (path === '/health') { if (hang) return; return json(200, { status: 'healthy' }); }
    if (!allowAuthentication || req.headers.authorization !== 'Token ' + syntheticKey) return json(403, { detail: syntheticKey });
    if (path === '/api/user/profile/') return json(200, { theme: 'auto', enable_sharing: false, permanent_notes: false, version: '1.47.0' });
    if (path === '/api/bookmarks/check/') {
      const hit = [...store.bookmarks.values()].find(b => b.url === query.get('url'));
      return json(200, { bookmark: hit || null, metadata: { title: null, description: null }, auto_tags: [] });
    }
    const record = path.match(/^\/api\/bookmarks\/(\d+)\/$/);
    if (record) {
      const row = store.bookmarks.get(record[1]);
      if (!row) return json(404, { detail: 'No Bookmark matches the given query.' });
      if (req.method === 'GET') return json(200, row);
      if (req.method === 'DELETE') { store.bookmarks.delete(record[1]); res.writeHead(204); return res.end(); }
    }
    const tag = path.match(/^\/api\/tags\/(\d+)\/$/);
    if (tag) {
      const row = store.tags.get(tag[1]);
      if (!row) return json(404, { detail: 'No Tag matches the given query.' });
      if (req.method === 'GET') return json(200, row);
      if (req.method === 'DELETE') { store.tags.delete(tag[1]); res.writeHead(204); return res.end(); }
    }
    if (path === '/api/tags/') return json(200, { count: store.tags.size, next: null, previous: null, results: [...store.tags.values()] });
    if (path === '/api/bookmarks/' || path === '/api/bookmarks/archived/') return json(200, { count: 0, next: null, previous: null, results: [] });
    return json(404, { detail: 'Unknown fixture route' });
  });
  servers.push(server);
  const port = await listen(server);
  const linkdingBase = 'http://127.0.0.1:' + port;
  const readOnlyArgs = ['--run', '--target', 'user', '--read-only', '--service', 'linkding', '--linkding', linkdingBase, '--allow-dirty'];

  const denied = await run(readOnlyArgs, { guard: false, state: linkdingState });
  assert.equal(denied.code, 1);
  assert.equal(denied.report.failure.code, 'api_http_403');
  assert.deepEqual(requests.map(q => [q.path, q.method, q.authenticated]), [['/health', 'GET', false], ['/api/user/profile/', 'GET', true]], 'a failed preflight costs no cleanup requests');
  assert.deepEqual(denied.report.stages.map(s => [s.name, s.ok]), [['credentials', true], ['preflight', false], ['cleanup', true]], 'a failed stage is timed too');
  assert.equal(denied.report.cleanup.complete, true);
  assert.match(denied.report.head, /^[0-9a-f]{40}$/);
  assert.equal(typeof denied.report.clean, 'boolean');

  allowAuthentication = true;
  requests.length = 0;
  const success = await run(readOnlyArgs, { guard: false, state: linkdingState });
  assert.equal(success.code, 0, success.output);
  assert.equal(success.report.passed, true);
  assert.deepEqual(success.report.ledger.created, []);
  assert.deepEqual(success.report.modules.map(m => [m.id, m.status]), [['linkding.readonly', 'passed']]);
  assert(requests.length > 4);
  assert(requests.every(q => q.method === 'GET' && (q.path === '/health' || q.authenticated)), 'read-only browser path escaped authenticated GETs');
  assert.equal(success.report.cleanup.apiVerified, true);
  assert(!existsSync(join(success.reportPath, '..', 'profile')), 'browser profile removed');
  const summaryText = readFileSync(join(success.reportPath, '..', 'summary.zh.md'), 'utf8');
  assert(summaryText.includes('未覆盖项') && summaryText.includes('linkding.readonly'));
  // Stage durations (E8/E10): setup steps and cleanup, in run order.
  assert.deepEqual(success.report.stages.map(s => s.name), ['credentials', 'preflight', 'browser_start', 'connect:linkding', 'cleanup']);
  assert(success.report.stages.every(s => Number.isInteger(s.ms) && s.ms >= 0 && !Number.isNaN(Date.parse(s.started))));
  assert.match(summaryText, /阶段耗时：credentials \d+\.\ds，preflight \d+\.\ds，browser_start \d+\.\ds，connect:linkding \d+\.\ds，cleanup \d+\.\ds/);
  assert.equal(statSync(join(success.reportPath, '..', 'summary.zh.md')).mode & 0o777, 0o600);

  // An unfinished earlier run blocks the next one before any request.
  const pendingId = randomUUID();
  const pendingPrefix = 'pbp-it-' + pendingId;
  const pendingDir = join(linkdingState, pendingPrefix);
  mkdirSync(pendingDir, { mode: 0o700 });
  const pendingPool = live.poolUrls('user', pendingId, 'linkding', 3);
  store.bookmarks.set('7', { id: 7, url: pendingPool[0], title: pendingPrefix, tag_names: [pendingPrefix + '_x'] });
  store.bookmarks.set('8', { id: 8, url: pendingPool[1], title: pendingPrefix + ' unrecorded', tag_names: [] });
  store.bookmarks.set('99', { id: 99, url: 'https://example.com/personal', title: 'Personal', tag_names: ['personal'] });
  store.tags.set('5', { id: 5, name: pendingPrefix + '_x', date_added: '2026-11-01T00:00:00Z' });
  // Same prefix in another case: cleanup matches run tags case-insensitively.
  store.tags.set('9', { id: 9, name: pendingPrefix.toUpperCase() + '_Upper', date_added: '2026-11-01T00:00:00Z' });
  store.tags.set('6', { id: 6, name: 'personal', date_added: '2026-11-01T00:00:00Z' });
  const pendingReport = {
    harness: live.HARNESS_VERSION, runId: pendingId, prefix: pendingPrefix, target: 'user',
    instances: { linkding: { service: 'linkding', base: linkdingBase + '/' } }, pools: { linkding: pendingPool },
    ledger: { created: [{ instance: 'linkding', id: '7', url: pendingPool[0], source: 'route', module: 'linkding.core.worker', deleted: false }], lists: [], tags: [] },
    modules: [], cleanup: { complete: false, entries: [] }, checks: [], readBackDiffs: [], console: [], swConsole: [], pageErrors: [], requestFailed: [], blockedOrigins: [], violations: [], findings: [], skipped: [], shots: { count: 0 },
  };
  live.writePrivateJson(join(pendingDir, 'report.json'), pendingReport);
  // The run that left it was cut off with its lock in place (kill -9, OOM, a
  // crash): the lock names a pid above the kernel's limit, so it is dead.
  const deadLock = join(linkdingState, 'pbp-it-live.lock');
  writeFileSync(deadLock, JSON.stringify({ pid: 2 ** 22 + 12345, runId: pendingId, reportPath: join(pendingDir, 'report.json'), started: '2026-11-01T00:00:00Z' }), { mode: 0o600 });
  requests.length = 0;
  const blocked = await run(readOnlyArgs, { guard: false, state: linkdingState });
  assert.equal(blocked.report.failure.code, 'previous_cleanup_incomplete');
  assert.deepEqual(requests, [], 'refused before any request');
  assert(existsSync(deadLock), 'a new run leaves the dead lock to the --cleanup of its report');

  // The user target names its instance again (finding B).
  const resumed = await run(['--cleanup', join(pendingDir, 'report.json'), '--linkding', linkdingBase], { guard: false, state: linkdingState });
  assert.equal(resumed.code, 0, resumed.output);
  assert(!existsSync(deadLock), 'the --cleanup took the dead lock over and released it');
  assert.equal(resumed.report.cleanup.complete, true);
  assert.equal(resumed.report.cleanup.apiVerified, true);
  const writes = requests.filter(q => q.method !== 'GET');
  assert.deepEqual(writes.map(q => q.method + ' ' + q.path).sort(), ['DELETE /api/bookmarks/7/', 'DELETE /api/bookmarks/8/', 'DELETE /api/tags/5/', 'DELETE /api/tags/9/'].sort(), 'only ledger, pool and run-prefix objects are deleted');
  assert(requests.every(q => q.authenticated));
  assert(store.bookmarks.has('99') && store.tags.has('6'), 'personal bookmark and tag untouched');
  const tagQuery = requests.find(q => q.path === '/api/bookmarks/' && q.url.includes('q='));
  assert(tagQuery && !decodeURIComponent(tagQuery.url).includes('#personal'), 'reference check names only run tags');
  assert.equal(resumed.report.ledger.created.find(e => e.id === '8').source, 'pool', 'unrecorded pool bookmark adopted by exact URL');

  requests.length = 0;
  const unblocked = await run(readOnlyArgs, { guard: false, state: linkdingState });
  assert.equal(unblocked.code, 0, 'a completed --cleanup unblocks the next run');

  // The reviewer's report for finding B, through the CLI: prefix '' and a
  // Karakeep base on 127.0.0.2. Refused before the credential file is read
  // (the guard hook would record it) and before any request; the report and
  // the state directory are left as they were.
  {
    const state = stateDirFor('resume-tampered');
    const id = randomUUID();
    const tamperedDir = join(state, 'pbp-it-' + id);
    mkdirSync(tamperedDir, { mode: 0o700 });
    const tampered = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] }).report;
    Object.assign(tampered, { runId: id, prefix: '', target: 'user', instances: { karakeep: { service: 'karakeep', base: 'http://127.0.0.2:3030/' } }, pools: {} });
    live.writePrivateJson(join(tamperedDir, 'report.json'), tampered);
    const before = readFileSync(join(tamperedDir, 'report.json'), 'utf8');
    requests.length = 0;
    const refusedRun = await run(['--cleanup', join(tamperedDir, 'report.json'), '--karakeep', 'http://127.0.0.1:3030'], { guard: true, state });
    assert.equal(refusedRun.code, 1);
    assert(refusedRun.output.includes('FAILED: cleanup_report_invalid'), refusedRun.output);
    assert.deepEqual(requests, []);
    assert.equal(readFileSync(join(tamperedDir, 'report.json'), 'utf8'), before, 'a refused report is not written');
    assert.deepEqual(readdirSync(state).sort(), ['pbp-it-' + id], 'no lock or other file is left');
  }
  {
    // Second review: a run directory that is a link to another directory.
    // Through the CLI the temporary report is refused before the lock, Docker
    // (the stub would mark it) or any file; the link's target keeps its
    // `profile` and `env-*`, which cleanup removes next to a report.
    const state = stateDirFor('resume-linked-dir');
    const id = randomUUID();
    const linkTarget = join(dir, 'linked-run-' + id);
    mkdirSync(join(linkTarget, 'profile'), { recursive: true, mode: 0o700 });
    writeFileSync(join(linkTarget, 'profile', 'keep.txt'), 'x');
    writeFileSync(join(linkTarget, 'env-keep'), 'x');
    const linked = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] }).report;
    Object.assign(linked, { runId: id, prefix: 'pbp-it-' + id, target: 'temp', pools: { linkding: live.poolUrls('temp', id, 'linkding', 3) } });
    linked.temp = { names: [live.tempNames(id).edge], network: live.tempNames(id).net };
    live.writePrivateJson(join(linkTarget, 'report.json'), linked);
    symlinkSync(linkTarget, join(state, 'pbp-it-' + id));
    const before = readFileSync(join(linkTarget, 'report.json'), 'utf8');
    const refusedRun = await run(['--cleanup', join(state, 'pbp-it-' + id, 'report.json')], { credentials: false, state });
    assert.equal(refusedRun.code, 1);
    assert(refusedRun.output.includes('FAILED: cleanup_report_location'), refusedRun.output);
    assert(existsSync(join(linkTarget, 'profile', 'keep.txt')) && existsSync(join(linkTarget, 'env-keep')), 'the link target keeps its files');
    assert.equal(readFileSync(join(linkTarget, 'report.json'), 'utf8'), before, 'a refused report is not written');
    assert.deepEqual(readdirSync(state), ['pbp-it-' + id], 'no lock or other file is left');
    rmSync(linkTarget, { recursive: true, force: true });
  }

  // SIGINT while the preflight waits on the service: cleanup, report, exit 130.
  hang = true;
  requests.length = 0;
  const interrupted = await run(readOnlyArgs, {
    guard: false, state: linkdingState,
    onSpawn: child => {
      const timer = setInterval(() => { if (requests.some(q => q.path === '/health')) { clearInterval(timer); child.kill('SIGINT'); } }, 50);
      child.on('close', () => clearInterval(timer));
    },
  });
  assert.equal(interrupted.code, 130);
  assert.equal(interrupted.report.interrupted, 'SIGINT');
  assert.equal(interrupted.report.failure.code, 'interrupted_sigint');
  assert.equal(interrupted.report.cleanup.complete, true);
  assert.equal(interrupted.report.passed, false);
  assert(!existsSync(join(linkdingState, 'pbp-it-live.lock')), 'lock released on SIGINT');
  hang = false;

  // ---------------------------------------------------------------------
  // Pinboard (H2). Everything runs against tests/bookmark-live-pinboard-mock.mjs
  // in this process; nothing reaches api.pinboard.in. The runner takes the
  // mock only through main()'s in-process options, so the CLI cannot.
  // ---------------------------------------------------------------------
  {
    const { createPinboardMock } = await import('./bookmark-live-pinboard-mock.mjs');

    // The gate, on a fake clock: each request starts one interval after the
    // previous answer; a 429 doubles it up to the cap; a good answer resets.
    {
      let clock = 0;
      const starts = [];
      const gate = live.createPinboardGate({ intervalMs: 3000, maxBackoffMs: 10000, now: () => clock, wait: async ms => { clock += ms; } });
      const answer = (status, took = 200) => () => { starts.push(clock); clock += took; return { status }; };
      for (const status of [200, 200, 429, 429, 429, 200, 200]) await gate.run(answer(status));
      const gaps = starts.slice(1).map((s, i) => s - (starts[i] + 200));
      assert.deepEqual(gaps, [3000, 3000, 6000, 10000, 10000, 3000], 'gap after each answer');
      assert.deepEqual({ ...gate.stats }, { requests: 7, waitedMs: 3000 + 3000 + 6000 + 10000 + 10000 + 3000, rateLimited: 3, maxIntervalMs: 10000 });
      // Concurrent callers queue: the second starts after the first answers.
      clock = 100000;
      const order = [];
      await Promise.all([1, 2, 3].map(n => gate.run(async () => { order.push([n, clock]); clock += 50; return { status: 200 }; })));
      assert.deepEqual(order.map(o => o[0]), [1, 2, 3]);
      assert(order[1][1] - order[0][1] >= 3050 && order[2][1] - order[1][1] >= 3050, 'serialised with the interval');
      // A thrown request still frees the queue and counts as an answer.
      await assert.rejects(gate.run(async () => { throw new Error('net'); }));
      assert.equal((await gate.run(async () => ({ status: 200 }))).status, 200);
    }

    // Selection and plan: Pinboard is opt-in, user target only, 8 bookmarks.
    {
      assert(!live.DEFAULT_SERVICES.includes('pinboard'), 'Pinboard only on request');
      const temp = live.selectModules('pinboard.*', { services: ['pinboard'], target: 'temp' });
      assert.deepEqual(temp.selected, []);
      assert(temp.skipped.length > 0 && temp.skipped.every(s => s.reason === 'pinboard_user_only'));
      assert.throws(() => live.selectModules('pinboard.core.worker', { services: ['pinboard'], target: 'temp' }), e => e.code === 'module_requires_user');
      const { selected, skipped } = live.selectModules('pinboard.*', { services: ['pinboard'], target: 'user' });
      assert(selected.length >= 4 && selected.every(m => m.id.startsWith('pinboard.')));
      const plan = live.buildPlan({ target: 'user', selected, skipped });
      assert.deepEqual(plan.problems, []);
      const pb = plan.budget.pinboard.pinboard;
      assert.equal(pb.bookmarksPerRun, 8);
      assert.equal(live.PINBOARD_BOOKMARKS_PER_RUN, 8);
      assert(plan.budget.pinboard.caps.bookmarks <= 8 && plan.budget.pinboard.bookmarks <= 8);
      assert.equal(pb.minIntervalMs, 3000);
      assert.equal(pb.privateOnly, true);
      assert.deepEqual(pb.endpoints, live.PINBOARD_ENDPOINTS);
      assert(pb.floorSeconds >= pb.expectedRequests * 3, 'floor = requests x 3 s');
      assert(plan.limits.worstCaseSeconds <= plan.limits.runMinutes * 60);
      const sum = selected.reduce((n, m) => n + live.resolveBudget(m, 'pinboard').urls, 0);
      assert(sum <= 8, 'urls of every Pinboard module fit one round');
    }

    // Account names: whole words, never a JSON key.
    {
      const r = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      r.accountNames.push('pinboard');
      assert.equal(r.sanitize('{"pinboard":{"user":"pinboard"},"x":"pinboard-ish pinboard."}'), '{"pinboard":{"user":"[account]"},"x":"pinboard-ish pinboard."}');
      r.accountNames.length = 0;
      r.accountNames.push('alice');
      assert.equal(r.sanitize('status: alice ok; malice; alice_2'), 'status: [account] ok; malice; alice_2');
    }

    const pbState = stateDirFor('pinboard');
    const user = 'pbpsynthetic';
    const hex = '0f1e2d3c4b5a69788796a5b4';
    const token = user + ':' + hex;

    // A LiveRun wired to the mock without a browser, for the Node and route
    // paths one at a time.
    const unitRun = (mock, { node = live.BUDGETS.user.pinboard.node } = {}) => {
      const r = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [], pinboard: { transport: mock.transport, intervalMs: 1, mock: true } });
      r.target = 'user';
      r.instances = { pinboard: { id: 'pinboard', service: 'pinboard', base: '', root: live.PINBOARD_ROOT, token } };
      r.pools = { pinboard: live.poolUrls('user', r.runId, 'pinboard', 3) };
      r.caps = { pinboard: { ...live.BUDGETS.user.pinboard, node } };
      r.reserve = { pinboard: live.BUDGETS.user.pinboard.cleanupReserve };
      return r;
    };

    // The send gate takes exactly one auth_token, this run's.
    {
      const mock = createPinboardMock({ token });
      const r = unitRun(mock);
      const t = encodeURIComponent(token);
      await assert.rejects(r.pinboardSend('pinboard', live.PINBOARD_ROOT + 'posts/get?auth_token=' + t + '&auth_token=other%3A00000000'), e => e.code === 'live_guard_pinboard_token');
      assert.deepEqual(mock.calls, []);
    }
    const pbCredentials = join(pbState, '..', 'pinboard-credentials.json');
    writeFileSync(pbCredentials, JSON.stringify({ pinboardToken: token }), { mode: 0o600 });
    const noTokenCredentials = join(pbState, '..', 'pinboard-none.json');
    writeFileSync(noTokenCredentials, JSON.stringify({}), { mode: 0o600 });
    const badCredentials = join(pbState, '..', 'pinboard-bad.json');
    writeFileSync(badCredentials, JSON.stringify({ pinboardToken: 'no-colon-' + hex }), { mode: 0o600 });
    const INTERVAL = 40;
    const inProcess = async (args, mock) => {
      const before = process.env.PBP_LIVE_STATE_DIR;
      process.env.PBP_LIVE_STATE_DIR = pbState;
      const lines = [];
      const log = console.log, err = console.error;
      console.log = (...a) => lines.push(a.join(' '));
      console.error = (...a) => lines.push(a.join(' '));
      let code;
      // As the CLI entry: a thrown failure prints its code and exits 1.
      try { code = await live.main(args, { pinboard: { transport: mock.transport, intervalMs: INTERVAL, mock: true } }); }
      catch (error) { lines.push('FAILED: ' + live.failureCode(error)); code = 1; }
      finally { console.log = log; console.error = err; if (before === undefined) delete process.env.PBP_LIVE_STATE_DIR; else process.env.PBP_LIVE_STATE_DIR = before; }
      const reportLine = lines.find(l => l.startsWith('Local report: '));
      const reportPath = reportLine ? reportLine.slice('Local report: '.length).trim() : '';
      const report = reportPath ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
      return { code, output: lines.join('\n'), reportPath, report };
    };
    const pbArgs = (credentials, scenario, auth) => ['--run', '--target', 'user', '--service', 'pinboard', '--scenario', scenario, '--credentials', credentials, '--allow-dirty', '--authorization', auth];
    const secretsOf = [token, encodeURIComponent(token), hex, hex.toUpperCase(), user];

    // No pinboardToken: the modules are skipped with a reason, nothing is sent.
    {
      const mock = createPinboardMock({ token });
      const skipped = await inProcess(pbArgs(noTokenCredentials, 'pinboard.*', 'pb-none'), mock);
      assert.equal(skipped.code, 0, skipped.output);
      assert.deepEqual(mock.calls, []);
      assert.equal(skipped.report.pinboard.configured, false);
      assert.equal(skipped.report.pinboard.reason, 'pinboard_token_missing');
      assert(skipped.report.skipped.some(s => s.reason === 'pinboard_token_missing'));
      assert.deepEqual(skipped.report.modules, []);
      assert(readFileSync(join(skipped.reportPath, '..', 'summary.zh.md'), 'utf8').includes('Pinboard：未配置'));
    }
    // A token not in "user:HEX" form fails before any request, and is not echoed.
    {
      const mock = createPinboardMock({ token });
      const bad = await inProcess(pbArgs(badCredentials, 'pinboard.readonly', 'pb-bad'), mock);
      assert.equal(bad.code, 1);
      assert.equal(bad.report.failure.code, 'pinboard_token_format');
      assert.deepEqual(mock.calls, []);
      assert(!bad.output.includes(hex) && !readFileSync(bad.reportPath, 'utf8').includes(hex));
    }

    // A full write round on the mock: quick save and batch save (with a "
    // tag), one 429 on the first request, ledger before create, delete per
    // ledger entry, posts/get afterwards, no secret or account name anywhere.
    {
      const mock = createPinboardMock({ token });
      mock.rateLimit(1);
      const done = await inProcess(pbArgs(pbCredentials, 'pinboard.core.save-paths', 'pb-mock'), mock);
      assert.equal(done.code, 0, done.output);
      const rep = done.report;
      assert.equal(rep.passed, true);
      assert.deepEqual(rep.modules.map(m => [m.id, m.status]), [['pinboard.core.save-paths', 'passed']]);
      assert.equal(rep.pinboard.configured, true);
      assert.equal(mock.posts.size, 0, 'nothing left in the account');
      assert.equal(rep.ledger.created.length, 2);
      assert(rep.ledger.created.every(e => e.instance === 'pinboard' && e.deleted && /^pool-\d+$/.test(e.id) && rep.pools.pinboard.includes(e.url)));
      assert.equal(rep.cleanup.complete, true);
      // Throttle: one 429 counted and retried; every request after an answer waited.
      assert.equal(rep.timing.throttle.rateLimited, 1);
      assert.equal(rep.timing.throttle.requests, mock.calls.length);
      for (let i = 1; i < mock.calls.length; i++) assert(mock.calls[i].at - mock.calls[i - 1].at >= INTERVAL - 2, 'gap ' + i);
      // Only listed endpoints; adds private; deletes only ledger URLs; a
      // check after each delete.
      const allowed = new Set([...live.PINBOARD_ENDPOINTS.extension, ...live.PINBOARD_ENDPOINTS.node]);
      assert(mock.calls.every(c => allowed.has(c.path)), JSON.stringify([...new Set(mock.calls.map(c => c.path))]));
      const deletes = mock.calls.filter(c => c.path === 'posts/delete');
      assert.deepEqual(deletes.map(c => c.url).sort(), rep.ledger.created.map(e => e.url).sort());
      for (const d of deletes) assert(mock.calls.slice(mock.calls.indexOf(d) + 1).some(c => c.path === 'posts/get' && c.url === d.url), 'verified after delete');
      // Timing: stages, module phases, top five.
      assert(rep.timing.slowest.length > 0 && rep.timing.slowest.length <= 5);
      assert(rep.timing.slowest.every((s, i, a) => i === 0 || a[i - 1].ms >= s.ms));
      assert(Number.isInteger(rep.timing.totals.throttleMs) || typeof rep.timing.totals.throttleMs === 'number');
      assert(rep.modules[0].timing && Number.isInteger(rep.modules[0].ms));
      const summary = readFileSync(join(done.reportPath, '..', 'summary.zh.md'), 'utf8');
      assert(summary.split('\n').length <= live.SUMMARY_MAX_LINES, 'one screen');
      assert(summary.includes('Pinboard：已配置') && summary.includes('最慢 5 个阶段') && summary.includes('耗时分类'));
      const texts = [done.output, readFileSync(done.reportPath, 'utf8'), summary];
      for (const s of secretsOf) assert(!texts.some(t => t.includes(s)), 'leaked ' + (s === user ? 'account name' : 'token'));
    }

    // --cleanup resume: a run cut off after creating one pool bookmark.
    {
      const mock = createPinboardMock({ token });
      const id = randomUUID();
      const prefix = 'pbp-it-' + id;
      const pool = live.poolUrls('user', id, 'pinboard', 3);
      const runDir = join(pbState, prefix);
      mkdirSync(runDir, { mode: 0o700 });
      const add = (url, tags) => mock.transport(live.PINBOARD_ROOT + 'posts/add?auth_token=' + encodeURIComponent(token) + '&url=' + encodeURIComponent(url) + '&description=x&tags=' + encodeURIComponent(tags) + '&shared=no');
      await add(pool[0], prefix);
      // Saved but not yet in the ledger when the run was cut off: adopted.
      await add(pool[1], prefix + '_b');
      await add('https://example.com/personal', 'personal');
      mock.calls.length = 0;
      live.writePrivateJson(join(runDir, 'report.json'), {
        harness: live.HARNESS_VERSION, runId: id, prefix, target: 'user',
        instances: { pinboard: { service: 'pinboard', base: '' } }, pools: { pinboard: pool },
        ledger: { created: [{ instance: 'pinboard', id: 'pool-1', url: pool[0], source: 'route', module: 'pinboard.core.worker', deleted: false }], lists: [], tags: [] },
        modules: [], cleanup: { complete: false, entries: [] }, checks: [], readBackDiffs: [], console: [], swConsole: [], pageErrors: [], requestFailed: [], blockedOrigins: [], violations: [], findings: [], skipped: [], shots: { count: 0 },
      });
      // A ledger id that is not the URL's pool slot is refused untouched.
      const tamperedDir = join(pbState, 'pbp-it-' + randomUUID());
      mkdirSync(tamperedDir, { mode: 0o700 });
      const tamperedId = tamperedDir.split('pbp-it-')[1];
      live.writePrivateJson(join(tamperedDir, 'report.json'), { ...JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8')), runId: tamperedId, prefix: 'pbp-it-' + tamperedId, ledger: { created: [{ instance: 'pinboard', id: 'pool-2', url: pool[0], source: 'route', deleted: false }], lists: [], tags: [] } });
      const refused = await inProcess(['--cleanup', join(tamperedDir, 'report.json'), '--credentials', pbCredentials], mock);
      assert.equal(refused.code, 1);
      assert(refused.output.includes('cleanup_report_invalid'), refused.output);
      assert.deepEqual(mock.calls, []);
      rmSync(tamperedDir, { recursive: true, force: true });
      // Without the token the cleanup fails rather than skipping.
      const noToken = await inProcess(['--cleanup', join(runDir, 'report.json'), '--credentials', noTokenCredentials], mock);
      assert.equal(noToken.code, 1);
      assert.equal(noToken.report.cleanup.error, 'missing_pinboard_token', noToken.output);
      assert.equal(noToken.report.cleanup.complete, false);
      assert.deepEqual(mock.calls, []);
      const resumed = await inProcess(['--cleanup', join(runDir, 'report.json'), '--credentials', pbCredentials], mock);
      assert.equal(resumed.code, 0, JSON.stringify(resumed.report?.cleanup));
      const after = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'));
      assert.equal(after.cleanup.complete, true);
      assert.deepEqual([...mock.posts.keys()], ['https://example.com/personal'], 'pool URLs gone, the personal bookmark kept');
      assert.deepEqual(mock.calls.filter(c => c.path === 'posts/delete').map(c => c.url).sort(), [pool[0], pool[1]].sort());
      assert.deepEqual(after.ledger.created.map(e => [e.id, e.deleted]).sort(), [['pool-1', true], ['pool-2', true]]);
      for (let i = 1; i < mock.calls.length; i++) assert(mock.calls[i].at - mock.calls[i - 1].at >= INTERVAL - 2);
    }
  }

  console.log('bookmark live preflight: registry/selection/budgets/guard rule/fake AI/docker fake executor/screenshot canary/plan/gates/Karakeep auto-AI/linkding read-only browser/cleanup resume/SIGINT/Pinboard mock passed');
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const server of servers) await closeServer(server);
  rmSync(dir, { recursive: true, force: true });
}
