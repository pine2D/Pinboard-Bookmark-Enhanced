// Synthetic preflight for scripts/bookmark-service-live.mjs (harness v2).
// Nothing here reaches a real bookmark service, credential, AI provider or
// Docker daemon:
//  - spawned CLI runs load a hook that blocks the synthetic credential file
//    and global fetch, and PATH starts with a docker stub that records calls;
//  - runs that must talk to a service talk to loopback fixtures shaped like
//    the real responses (linkding 1.47 / Karakeep 0.34.1);
//  - temporary-container runs get an injected Docker executor;
//  - the browser is the bundled Chromium with the extension, for the
//    read-only loopback path.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'pbp-live-preflight-'));
const live = await import('../scripts/bookmark-service-live.mjs');
const { MODULES, GROUPS } = await import('../scripts/bookmark-service-live-scenarios.mjs');

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
const stateDirFor = name => { const d = join(dir, 'state-' + name); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
const secretValues = [syntheticKey, syntheticKarakeepKey];

async function run(args, { guard = true, credentials = true, state = stateDirFor('default'), onSpawn } = {}) {
  const child = spawn(process.execPath, [...(guard ? ['--import', hook] : []), 'scripts/bookmark-service-live.mjs', ...args, ...(credentials ? ['--credentials', credentialsPath] : [])], {
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
  assert.deepEqual(pick('core'), ['linkding.core.popup-reader', 'linkding.core.worker', 'karakeep.core.popup-reader', 'karakeep.core.worker']);
  assert.deepEqual(pick('edges'), ['linkding.edges.quote-unread', 'linkding.edges.offline', 'karakeep.edges.tags']);
  const karakeepAll = pick('karakeep.*');
  assert(karakeepAll.length >= 4 && karakeepAll.every(id => id.startsWith('karakeep.')), 'karakeep.* wildcard');
  assert.deepEqual(pick('karakeep.*', { services: ['linkding'] }), [], '--service filters wildcard matches');
  assert.deepEqual(pick('*.readonly,*.edges.*'), ids.filter(id => id.endsWith('.readonly') || id.includes('.edges.')).filter(id => !id.startsWith('pinboard.')));
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

  // ---------------------------------------------------------------------
  // Budgets: sums come from the rows, caps from the target
  // ---------------------------------------------------------------------
  for (const target of ['temp', 'user']) {
    for (const spec of ['core', 'edges', 'readonly']) {
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
        assert.deepEqual(Object.keys(row.caps).sort(), ['bookmarks', 'browser', 'lists', 'node', 'tags']);
      }
      assert.equal(plan.withinCaps, true, `${target}/${spec} must fit its caps: ${plan.problems.join(',')}`);
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
  // Over-budget rows are refused by --plan and by --run before anything starts.
  const base = MODULES.find(m => m.id === 'core.worker');
  const over = (id, budget) => ({ ...base, id, services: ['linkding'], budget: { ...base.budget, ...budget } });
  const overRows = [over('over.bookmarks', { bookmarks: 16, urls: 16 }), over('over.node', { node: 400 }), over('over.browser', { browser: 900 }), over('over.tags', { tags: 21 }), over('over.ai', { ai: 61, node: 1 })];
  for (const row of overRows) {
    const { selected } = live.selectModules('*', { target: 'user', modules: [row] });
    const plan = live.buildPlan({ target: 'user', selected });
    assert.equal(plan.withinCaps, false, row.id);
    const expectProblem = { 'over.bookmarks': 'linkding:bookmarks', 'over.node': 'linkding:node', 'over.browser': 'linkding:browser', 'over.tags': 'linkding:tags', 'over.ai': 'fake_ai' }[row.id];
    assert(plan.problems.includes(expectProblem), row.id + ' -> ' + plan.problems.join(','));
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
    pools: { linkding: live.poolUrls('temp', runId, 'linkding', 2), karakeep: live.poolUrls('temp', runId, 'karakeep', 2), pinboard: live.poolUrls('user', runId, 'pinboard', 1) },
    listMarker: 'Pinboard Bookmark Enhanced: Read Later', writes: true,
  };
  const view = { created: [{ instance: 'linkding', id: '7', url: cfg.pools.linkding[0] }, { instance: 'karakeep', id: 'k7', url: cfg.pools.karakeep[0] }, { instance: 'pinboard', id: cfg.pools.pinboard[0], url: cfg.pools.pinboard[0] }] };
  const transported = new Function('return (' + live.liveGuardRule.toString() + ')')();
  const cases = [
    [{ url: 'https://example.org/x', method: 'GET' }, false, 'live_guard_origin'],
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
    [{ url: live.PINBOARD_ROOT + 'posts/add?url=' + encodeURIComponent(cfg.pools.pinboard[0]) + '&shared=no', method: 'GET' }, true],
    [{ url: live.PINBOARD_ROOT + 'posts/add?url=' + encodeURIComponent(cfg.pools.pinboard[0]) + '&shared=yes', method: 'GET' }, false, 'live_guard_create'],
    [{ url: live.PINBOARD_ROOT + 'posts/delete?url=' + encodeURIComponent('https://example.com/mine'), method: 'GET' }, false, 'live_guard_mutation'],
    [{ url: live.PINBOARD_ROOT + 'posts/rename?old=a&new=b', method: 'GET' }, false, 'live_guard_mutation'],
  ];
  for (const rule of [live.liveGuardRule, transported]) {
    for (const [req, ok, code] of cases) {
      const d = rule(cfg, view, req);
      assert.equal(d.ok, ok, req.method + ' ' + req.url);
      if (code) assert.equal(d.code, code, req.method + ' ' + req.url);
    }
    const readOnly = rule({ ...cfg, writes: false }, view, { url: 'http://127.0.0.1:1001/api/bookmarks/7/', method: 'PATCH', body: '{}' });
    assert.equal(readOnly.code, 'live_guard_read_only', 'read-only modules refuse every write');
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
    live.writePrivateJson(join(stale, 'report.json'), { harness: live.HARNESS_VERSION, cleanup: { complete: true } });
    live.acquireLock(state, { pid: process.pid, runId: 'e' })();
    assert.deepEqual(live.scanIncompleteReports(state), []);
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
    run.caps = { linkding: { node: 10 } };
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
    const docker = fakeDocker({ states: {} });
    // The linkding container dies right after start: its logs are kept, redacted.
    const exitDocker = { ...docker, exec: async args => (args[0] === 'inspect' && args[2] !== '{{.Image}}' && /-linkding$/.test(args[3]) ? (docker.calls.push(args), { code: 0, stdout: 'exited 1\n', stderr: '' }) : docker.exec(args)) };
    const { report } = await tempRun('container-exit', exitDocker);
    assert.equal(report.failure.code, 'container_start_failed');
    assert(report.temp.logs.linkding.some(line => line.includes('[redacted]')), 'container logs are redacted');
    assert.equal(report.temp.removed, true);
  }

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
  assert.equal(value.budget.linkding.bookmarks, 2);
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
    modules: [], cleanup: { complete: false, entries: [] }, checks: [], readBackDiffs: [], console: [], swConsole: [], pageErrors: [], requestFailed: [], blockedOrigins: [], violations: [], skipped: [],
  };
  live.writePrivateJson(join(pendingDir, 'report.json'), pendingReport);
  requests.length = 0;
  const blocked = await run(readOnlyArgs, { guard: false, state: linkdingState });
  assert.equal(blocked.report.failure.code, 'previous_cleanup_incomplete');
  assert.deepEqual(requests, [], 'refused before any request');

  const resumed = await run(['--cleanup', join(pendingDir, 'report.json')], { guard: false, state: linkdingState });
  assert.equal(resumed.code, 0, resumed.output);
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

  console.log('bookmark live preflight: registry/selection/budgets/guard rule/docker fake executor/plan/gates/Karakeep auto-AI/linkding read-only browser/cleanup resume/SIGINT passed');
} finally {
  for (const server of servers) await closeServer(server);
  rmSync(dir, { recursive: true, force: true });
}
