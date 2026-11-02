// Synthetic preflight for scripts/bookmark-service-live.mjs (harness v3).
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
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

// Sections, in run order. PBP_PREFLIGHT_ONLY=<name part>[,<name part>...]
// runs only the sections whose name contains one of the parts
// (case-insensitive); --list prints the names and exits. Neither set (as in
// verify.sh): every section runs. Each section sets up what it reads, so one
// run alone reaches the same verdict as in the full run.
const SECTIONS = ['registry and selection', 'budgets', 'guard rule and caps', 'pure helpers', 'node api', 'linkding tag cleanup', 'karakeep tag cleanup', 'summary', 'fake ai', 'docker fake executor', 'signals', 'screenshot canary', 'spawned cli', 'karakeep user target', 'linkding user target', 'pinboard units', 'pinboard token', 'pinboard mock browser write round', 'pinboard cleanup resume'];
const onlyParts = (process.env.PBP_PREFLIGHT_ONLY || '').split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
const only = name => {
  if (!SECTIONS.includes(name)) throw new Error('unlisted preflight section: ' + name);
  return !onlyParts.length || onlyParts.some(part => name.includes(part));
};
if (process.argv.includes('--list')) { console.log(SECTIONS.join('\n')); process.exit(0); }
if (onlyParts.length && !SECTIONS.some(only)) { console.error('PBP_PREFLIGHT_ONLY=' + process.env.PBP_PREFLIGHT_ONLY + ' matched no section; run with --list for the names'); process.exit(2); }
const filterNote = onlyParts.length ? 'only ran ' + SECTIONS.filter(only).length + '/' + SECTIONS.length + ' sections (PBP_PREFLIGHT_ONLY=' + process.env.PBP_PREFLIGHT_ONLY + '): ' + SECTIONS.filter(only).join('; ') : '';
if (filterNote) console.log(filterNote.replace('only ran', 'Running only'));
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'pbp-live-preflight-'));
const live = await import('../scripts/bookmark-service-live.mjs');
const { MODULES, GROUPS, LIST_MARKER, SNAPSHOT_POLL_MS, SNAPSHOT_TEMP_POLL_MS, SNAPSHOT_MARGIN_MS, SNAPSHOT_TEMP_POLLS } = await import('../scripts/bookmark-service-live-scenarios.mjs');

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
// the JSON argument (key -> ms) are held that long before they answer, and
// its "__states" map (container suffix -> inspect state, say "exited 1")
// scripts a container that dies.
const dockerChild = join(dir, 'docker-child.mjs');
writeFileSync(dockerChild, `import { appendFileSync } from 'node:fs';
const [runner, log, holdSpec, ...argv] = process.argv.slice(2);
const live = await import(runner);
const holds = JSON.parse(holdSpec);
const states = holds.__states || {};
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
  if (cmd === 'inspect') return ok((states[String(args[3]).replace(/^pbp-it-[0-9a-f-]{36}-/, '')] || 'running 0') + '\\n');
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

// Read by more than one section, so defined before them: each section runs alone.
const ids = live.listIds();
const pick = (spec, opts) => live.selectModules(spec, opts).selected.map(m => m.id);
// Karakeep /signin: Next.js flight chunks, JSON-string encoded, carrying the
// root layout's clientConfig (shape captured from Karakeep 0.34.1).
const flight = inference => `<!DOCTYPE html><html><head><title>Karakeep</title></head><body><script>self.__next_f.push([0])</script>`
  + `<script>self.__next_f.push([1,${JSON.stringify('1:"$Sreact.fragment"\n')}])</script>`
  + `<script>self.__next_f.push([1,${JSON.stringify('7:["$","$L12",null,{"clientConfig":{"publicUrl":"http://127.0.0.1:3000","publicApiUrl":"http://127.0.0.1:3000/api","demoMode":false,"auth":{"disableSignups":false,"disablePasswordAuth":false},"inference":' + JSON.stringify(inference) + ',"serverVersion":"0.34.1","disableNewReleaseCheck":true},"children":["$","$L13",null,{}]}]\n')}])</script></body></html>`;
const off = { isConfigured: false, inferredTagLang: 'english', enableAutoTagging: false, enableAutoSummarization: false };
const { chromium } = createRequire(join(root, '.qa-scan/package.json'))('playwright');
// The guard configuration the guard and Node API sections read.
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

try {
  // ---------------------------------------------------------------------
  // Registry, selection and wildcards
  // ---------------------------------------------------------------------
  if (only('registry and selection')) {
    // H3c modules: the screenshot matrix writes nothing and covers every
    // locale the extension ships (pictures or geometry alone).
    {
      const scen = await import('../scripts/bookmark-service-live-scenarios.mjs');
      const matrix = MODULES.find(m => m.id === 'shots.matrix');
      assert.ok(matrix && matrix.budget.bookmarks === 0, 'shots.matrix creates no bookmark');
      assert.equal(matrix.needs.writes, false, 'shots.matrix is read-only');
      const shipped = readdirSync(join(root, '_locales')).sort();
      assert.deepEqual([...scen.SHOT_LOCALES, ...scen.GEOMETRY_LOCALES].sort(), shipped, 'every shipped locale is shot or measured');
      for (const id of ['ux.reader-bar', 'ux.copy-exits', 'ux.status-check', 'regress.tags-notes']) assert.ok(MODULES.some(m => m.id === id), id);
    }
    assert.equal(new Set(ids).size, ids.length, 'module ids must be unique');
    for (const id of ids) assert.match(id, /^(linkding|linkding-pg|karakeep|pinboard)\.[a-z0-9.-]+$/);
    for (const row of MODULES) {
      for (const key of ['id', 'services', 'surfaces', 'features', 'fixRefs', 'needs', 'budget', 'files', 'steps']) assert(row[key] !== undefined, row.id + ' lacks ' + key);
      // Fix groups as the fix branch names them (G2, G2b, G21+G23).
      assert(Array.isArray(row.fixRefs) && row.fixRefs.every(g => /^G\d+[a-z]?(\+G\d+[a-z]?)*$/.test(g)), row.id + ' fixRefs');
      // Every self-hosted save row (H3b) names the fixes it asserts.
      if (row.id.startsWith('sh.')) assert(row.fixRefs.length > 0 && row.services.every(s => s !== 'pinboard'), row.id + ' is a self-hosted row with fix groups');
      assert(['temp', 'user', 'any'].includes(row.needs.target) && ['any', 'on', 'off'].includes(row.needs.sharing), row.id + ' needs');
      assert.equal(typeof row.needs.snapshots, 'boolean', row.id + ' needs.snapshots');
      // A row that writes an over-long tag says how it reaches the service:
      // 'server' only on temporary instances, 'injected' answered by faults.
      assert(['none', 'injected', 'server'].includes(row.needs.longTag), row.id + ' needs.longTag');
      if (row.needs.longTag === 'server') assert.equal(row.needs.target, 'temp', row.id + ' sends an over-long tag to the service: temporary instances only');
      if (row.needs.writes !== false && row.features.some(f => /long-tag/.test(f))) assert.notEqual(row.needs.longTag, 'none', row.id + ' writes over-long tags without saying how they reach the service');
      if (row.needs.snapshots) assert.deepEqual(row.services, ['linkding'], row.id + ': only linkding builds HTML snapshots');
      for (const service of row.services) {
        const b = live.resolveBudget({ ...row, service });
        assert(b.seconds > 0 && b.urls >= b.bookmarks && b.node > 0 && b.browser > 0, row.id + ' budget for ' + service);
        if (row.needs.writes === false) assert.equal(b.bookmarks, 0, row.id + ' is read-only but plans bookmarks');
      }
    }
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
    // --changed (E7): modules are picked by the product files they declare,
    // from synthetic file lists here (no git). Every declared path or glob
    // names a shipped file of this repository.
    {
      const shipped = [];
      const walk = rel => { for (const e of readdirSync(join(root, rel), { withFileTypes: true })) { const p = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) { if (!rel ? ['vendor', 'icons', '_locales'].includes(e.name) : true) walk(p); } else if (live.isProductRuntimeFile(p)) shipped.push(p); } };
      walk('');
      for (const mod of live.expandRegistry()) {
        assert(mod.files !== undefined, mod.id + ' has no files field');
        const files = live.moduleFiles(mod);
        for (const glob of files) {
          assert(live.isProductRuntimeFile(glob), mod.id + ': ' + glob + ' is not shipped');
          assert(shipped.some(f => live.globToRegExp(glob).test(f)), mod.id + ': ' + glob + ' matches no file');
        }
      }
      for (const [path, product] of [['popup.js', true], ['manifest.json', true], ['_locales/de/messages.json', true], ['vendor/marked.min.js', true], ['icons/pin-default-16.png', true], ['tests/x.html', false], ['scripts/release.sh', false], ['README.md', false], ['docs/index.md', false], ['.claude/rules/l10n.md', false]]) assert.equal(live.isProductRuntimeFile(path), product, path);
      const route = files => live.routeChangedFiles(files);
      // A module covers every file its surfaces load, read from the tree
      // itself: the worker's importScripts, each page's script and
      // stylesheet tags and the files they inject. Every module connects
      // through options.html and waits for English text, so the worker,
      // the options page and the default locale belong to all of them.
      const surfaces = live.surfaceFiles(root);
      const tags = (page, re) => [...readFileSync(join(root, page), 'utf8').matchAll(re)].map(x => x[1]).filter(f => !/^[a-z]+:|^\/\//i.test(f));
      const imported = [...readFileSync(join(root, 'background.js'), 'utf8').match(/importScripts\(([\s\S]*?)\)/)[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
      for (const f of ['manifest.json', 'background.js', '_locales/en/messages.json', ...imported]) assert(surfaces.worker.includes(f), 'worker loads ' + f);
      for (const [name, page] of Object.entries(live.SURFACE_PAGES)) {
        for (const f of [page, ...tags(page, /<script\b[^>]*\bsrc="([^"]+)"/g)]) assert(surfaces[name].includes(f), name + ' loads ' + f);
      }
      for (const f of ['site-rules.js', 'vendor/defuddle.js']) assert(surfaces.popup.includes(f) && surfaces.worker.includes(f), 'injected ' + f);
      for (const set of Object.values(surfaces)) for (const f of set) assert(shipped.includes(f), f + ' is loaded but not shipped');
      for (const mod of live.expandRegistry()) {
        const files = new Set(live.moduleFiles(mod));
        for (const name of ['worker', 'options', ...mod.surfaces.map(s => (s === 'background' ? 'worker' : s))]) {
          for (const f of surfaces[name]) assert(files.has(f), mod.id + ' declares ' + name + ' but its files leave out ' + f);
        }
      }
      assert.throws(() => live.moduleFiles({ id: 'x', surfaces: ['library'], files: [] }), e => e.code === 'module_surface_unknown');
      // What a module drives is read at run time from the extension pages it
      // opens, not from its row: a row that leaves out a surface it opens
      // fails surface_undeclared (the mock browser round runs one).
      const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
      assert.deepEqual(['popup.html', 'popup.html?x=1#y', 'md-preview.html?k=live', 'options.html#tab-ai', 'library.html', 'batch.html'].map(p => live.surfaceOfUrl(ext + p, ext)), ['popup', 'popup', 'reader', 'options', '', '']);
      assert.deepEqual(['https://example.test/popup.html', 'chrome-extension://otherotherotherotherotherotherot/popup.html', 'about:blank', 'not a url'].map(u => live.surfaceOfUrl(u, ext)), ['', '', '', '']);
      assert.deepEqual(live.undeclaredSurfaces(['popup'], ['popup', 'options']), [], 'options and the worker belong to every module');
      assert.deepEqual(live.undeclaredSurfaces([], ['popup']), ['popup']);
      assert.deepEqual(live.undeclaredSurfaces(['background'], ['reader', 'popup', 'reader']), ['popup', 'reader']);
      // A common file selects every module that declares it.
      assert.deepEqual(route(['shared.js']).modules, ids);
      assert.deepEqual(route(['background.js']).modules, ids);
      assert.deepEqual(route(['bookmark-services.js']).modules, ids, 'the worker loads it for Pinboard too');
      // The review's counterexamples: ai.js (prefill, quick-save notes) and
      // the English messages (Connect, "Bookmark deleted") reach every module.
      assert.deepEqual(route(['ai.js']).modules, ids);
      assert.deepEqual(route(['_locales/en/messages.json']).modules, ids);
      const popupIds = live.expandRegistry().filter(m => m.surfaces.includes('popup')).map(m => m.id);
      assert(popupIds.includes('linkding.edges.quote-unread') && popupIds.includes('pinboard.readonly'));
      assert.deepEqual(route(['popup-offline.js']).modules, popupIds);
      // Rows that open the reader, and rows that name a locale file in
      // `files`: read from the registry rows, then the known members.
      const readerIds = live.expandRegistry().filter(m => m.surfaces.includes('reader')).map(m => m.id);
      for (const id of ['linkding.core.popup-reader', 'linkding.sharing.popup-reader', 'karakeep.core.popup-reader', 'karakeep.edges.tags', 'pinboard.core.popup-reader', 'linkding.sh.changed-elsewhere', 'karakeep.sh.read-later']) assert(readerIds.includes(id), id + ' opens the reader');
      assert.deepEqual(route(['md-bookmark.js']).modules, readerIds);
      const declares = file => live.expandRegistry().filter(m => (Array.isArray(m.files) ? m.files : [...(m.files.all || []), ...(m.files[m.service] || [])]).includes(file)).map(m => m.id);
      assert.deepEqual(declares('_locales/zh_CN/messages.json'), ['linkding.ai.popup-summary-tags', 'karakeep.ai.popup-summary-tags']);
      assert.deepEqual(route(['_locales/zh_CN/messages.json']).modules, declares('_locales/zh_CN/messages.json'));
      assert.deepEqual(route(['_locales/de/messages.json']).modules, ['linkding.sh.tag-input', 'karakeep.sh.tag-input'], 'the German chip geometry row');
      const mixed = route(['library.js', 'md-bookmark.js', 'tests/bookmark-live-preflight-tests.mjs', 'README.md', 'pinboard-sort.js', 'md-bookmark.js']);
      assert.deepEqual(mixed.modules, route(['md-bookmark.js']).modules);
      assert.deepEqual(mixed.uncovered, ['library.js', 'pinboard-sort.js'], 'a shipped file nobody declares is listed, not skipped');
      assert.deepEqual(mixed.ignored, ['README.md', 'tests/bookmark-live-preflight-tests.mjs']);
      assert.deepEqual(Object.keys(mixed.byFile), ['md-bookmark.js']);
      // Selection: target and service filters still apply; --scenario intersects.
      const changedSel = (files, values = {}) => live.resolveSelection({ values, flags: new Set(['--changed']) }, { changedFiles: (d, base) => ({ base, mergeBase: 'f'.repeat(40), files }) });
      const zh = changedSel(['_locales/zh_CN/messages.json', 'library.js']);
      assert.deepEqual(zh.selected.map(m => m.id), ['linkding.ai.popup-summary-tags', 'karakeep.ai.popup-summary-tags']);
      assert.deepEqual([zh.scenario, zh.changed.base, zh.changed.files, zh.changed.uncovered], ['all', 'main', 2, ['library.js']]);
      assert(zh.changed.note.includes('未覆盖'));
      assert.deepEqual(changedSel(['popup-offline.js'], { scenario: 'edges' }).selected.map(m => m.id), ['linkding.edges.quote-unread', 'linkding.edges.offline', 'karakeep.edges.tags']);
      assert.deepEqual(changedSel(['_locales/zh_CN/messages.json'], { target: 'user', service: 'karakeep' }).selected.map(m => m.id), ['karakeep.ai.popup-summary-tags']);
      assert.deepEqual(changedSel(['md-bookmark.js'], { target: 'user', service: 'karakeep' }).selected.map(m => m.id), readerIds.filter(id => id.startsWith('karakeep.')));
      assert.deepEqual(changedSel(['shared.js'], { changed: 'origin/main', target: 'user', service: 'pinboard' }).selected.map(m => m.id), ids.filter(id => id.startsWith('pinboard.')));
      assert.equal(changedSel(['shared.js'], { changed: 'origin/main' }).changed.base, 'origin/main');
      assert.deepEqual(changedSel(['README.md']).selected, []);
      assert.throws(() => live.resolveSelection({ values: { 'rerun-failed': 'x' }, flags: new Set(['--changed']) }, { readReport: () => ({}) }), e => e.code === 'rerun_conflict');
      // The optional base: a value only when the next argument is not a flag.
      assert.deepEqual([live.parseArgs(['--plan', '--changed']).values.changed, live.parseArgs(['--changed', '--plan']).flags.has('--plan'), live.parseArgs(['--changed', 'v2.121', '--plan']).values.changed], [undefined, true, 'v2.121']);
      // --plan, in process: the uncovered files are listed even with nothing to run.
      const planOut = async (argv, files) => {
        const write = process.stdout.write, chunks = [];
        process.stdout.write = (chunk, cb) => { chunks.push(String(chunk)); if (typeof cb === 'function') cb(); return true; };
        try { return { code: await live.main(argv, { changedFiles: (d, base) => ({ base, mergeBase: '', files }) }), value: JSON.parse(chunks.join('')) }; } finally { process.stdout.write = write; }
      };
      const cp = await planOut(['--plan', '--changed'], ['_locales/zh_CN/messages.json', 'library.js']);
      assert.equal(cp.code, 0);
      assert.deepEqual([cp.value.modules.map(m => m.id), cp.value.changed.uncovered], [['linkding.ai.popup-summary-tags', 'karakeep.ai.popup-summary-tags'], ['library.js']]);
      const none = await planOut(['--plan', '--changed'], ['library.js', 'docs/index.md']);
      assert.deepEqual([none.code, none.value.error, none.value.changed.uncovered, none.value.changed.ignored], [1, 'no_modules_selected', ['library.js'], ['docs/index.md']]);
    }
    // A temp-only row is skipped by a group on the user target and refused by name.
    const tempOnly = { ...MODULES.find(m => m.id === 'readonly'), id: 'temp.only', services: ['linkding'], needs: { ...MODULES[0].needs, target: 'temp' } };
    const sharingOn = { ...tempOnly, id: 'sharing.on', needs: { ...tempOnly.needs, target: 'any', sharing: 'on' } };
    assert.deepEqual(live.selectModules('*', { target: 'user', modules: [tempOnly, sharingOn] }).selected, []);
    assert.deepEqual(live.selectModules('*', { target: 'user', modules: [tempOnly, sharingOn] }).skipped.map(s => s.reason), ['target_temp', 'sharing_on_temp_only']);
    assert.throws(() => live.selectModules('linkding.temp.only', { target: 'user', modules: [tempOnly] }), e => e.code === 'module_requires_temp');
    // H1b: the harness cannot read the user's linkding "automatic HTML
    // snapshots" switch, so on the user target the snapshot module runs only
    // when named exactly; a group or glob skips it with the reason in --plan.
    for (const spec of ['core', 'linkding.*', '*.core.snapshot', '*']) {
      const sel = live.selectModules(spec, { target: 'user' });
      assert(!sel.selected.some(m => m.id === 'linkding.core.snapshot'), spec + ' leaves the snapshot module out on the user target');
      const skip = sel.skipped.find(x => x.id === 'linkding.core.snapshot');
      assert.equal(skip?.reason, 'snapshot_setting_unreadable', spec);
      assert.match(skip.note, /自动 HTML 快照/);
      assert.match(skip.note, /--scenario linkding\.core\.snapshot/);
    }
    assert.deepEqual(pick('linkding.core.snapshot,core', { target: 'user' }), ['linkding.core.snapshot', 'linkding.core.popup-reader', 'linkding.core.worker', 'karakeep.core.popup-reader', 'karakeep.core.worker'], 'named exactly, it runs');
    assert.deepEqual(live.selectModules('linkding.core.snapshot,core', { target: 'user' }).skipped.filter(x => x.id === 'linkding.core.snapshot'), [], 'and is not listed as skipped');
    assert(pick('core', { target: 'temp' }).includes('linkding.core.snapshot'), 'the temp target keeps it');
    assert.deepEqual(live.selectModules('linkding.temp.only', { target: 'temp', modules: [tempOnly] }).selected.map(m => m.id), ['linkding.temp.only']);

    // The snapshot module polls every 5 s and stops while its module still has
    // time for its checks and cleanup (E2); "missing" fails at once.
    {
      const snap = MODULES.find(m => m.id === 'core.snapshot');
      const budget = live.resolveBudget({ ...snap, service: 'linkding' });
      assert.equal(SNAPSHOT_POLL_MS, 5000);
      const drive = async (statuses, { target = 'user', diagnostics = null } = {}) => {
        let now = 0, polls = 0, diagnosed = 0;
        const sleeps = [], notes = {};
        const failWith = code => { const e = new Error(code); e.code = code; throw e; };
        const t = {
          service: 'linkding', prefix: 'pbp-it-x', target,
          snapshotDiagnostics: async () => { diagnosed++; return diagnostics; },
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
        return { code, polls, sleeps, now, notes, diagnosed };
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
        assert.equal(r.diagnosed, 0, 'the user target reads no task queue');
      }
      // Temporary linkding (E-H1c): a snapshot normally completes in about
      // 10 s, but one run in four sat pending for the whole 100 s. The temp
      // target stops after SNAPSHOT_TEMP_POLLS polls (30 s) with its own
      // code, still a failure, and records the container's snapshot task
      // state for diagnosis. It polls every 2 s (E26: the wait ends within
      // 2 s of completion, not 5 s), within the module's node budget.
      assert.equal(SNAPSHOT_TEMP_POLL_MS, 2000);
      assert.equal(SNAPSHOT_TEMP_POLLS * SNAPSHOT_TEMP_POLL_MS, 30000);
      const diag = { hueyPending: 1, hueyScheduled: 0, assets: { pending: 1 }, tasks: ['bookmarks.services.tasks._create_html_snapshot_task'], jobs: 'RUNNING', chromium: 0 };
      const stuck = await drive(['pending'], { target: 'temp', diagnostics: diag });
      assert.deepEqual([stuck.code, stuck.polls, stuck.diagnosed], ['snapshot_pending_timeout', SNAPSHOT_TEMP_POLLS, 1]);
      assert(stuck.sleeps.every(ms => ms === SNAPSHOT_TEMP_POLL_MS) && stuck.now === 30000, 'temp: one poll every 2 s for 30 s');
      assert(stuck.polls + 3 <= budget.node, 'temp polls fit the module node budget');
      const tempDone = await drive(['pending', 'pending', 'pending', 'pending', 'complete'], { target: 'temp', diagnostics: diag });
      assert.deepEqual([tempDone.code, tempDone.now], ['', 10000], 'a 10 s snapshot is seen at 10 s');
      assert.deepEqual(stuck.notes.snapshotTasks, diag);
      assert.equal(stuck.notes.snapshot.status, 'pending');
      const quick = await drive(['pending', 'complete'], { target: 'temp', diagnostics: diag });
      assert.deepEqual([quick.code, quick.polls, quick.diagnosed, quick.now], ['', 2, 0, 2 * SNAPSHOT_TEMP_POLL_MS]);
      // The task state comes from the run's own container, read-only.
      const dRun = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      const dCalls = [];
      dRun.target = 'temp';
      dRun.docker = { names: { linkding: 'pbp-it-x-linkding' }, exec: async (name, cmd) => {
        dCalls.push([name, ...cmd]);
        if (cmd[0] === 'python') return { code: 0, stdout: '23 objects imported automatically\nPBPHUEY pending=1 scheduled=0\nPBPASSETS complete=3 pending=1\nPBPTASKS bookmarks.services.tasks._create_html_snapshot_task\n' };
        if (cmd[0] === 'supervisorctl') return { code: 0, stdout: 'jobs                             RUNNING   pid 17, uptime 0:01:40\n' };
        return { code: 0, stdout: 'COMMAND\npython\nchromium\nchrome_crashpad\nuwsgi\n' };
      } };
      assert.deepEqual(await dRun.snapshotDiagnostics('linkding'), { hueyPending: 1, hueyScheduled: 0, assets: { complete: 3, pending: 1 }, tasks: ['bookmarks.services.tasks._create_html_snapshot_task'], jobs: 'RUNNING', chromium: 2 });
      assert(dCalls.every(c => c[0] === 'pbp-it-x-linkding'));
      dRun.target = 'user';
      await assert.rejects(dRun.snapshotDiagnostics('linkding'), e => e.code === 'profile_requires_temp');
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
  }

  // ---------------------------------------------------------------------
  // Budgets: sums come from the rows, caps from the target
  // ---------------------------------------------------------------------
  if (only('budgets')) {
    for (const target of ['temp', 'user']) {
      for (const spec of ['core', 'edges', 'readonly', 'ai', 'selfhosted', 'h3c', 'all']) {
        // One run holds the groups older than the self-hosted rows; those
        // and the whole registry are packed into rounds (checked below).
        const oneRun = !['selfhosted', 'h3c', 'all'].includes(spec);
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
          assert(row.cleanupReserve >= row.caps.cleanupReserve && (!oneRun || row.node + row.cleanupReserve <= row.caps.node), `${target}/${spec}/${instance} node + reserve`);
        }
        if (oneRun) {
          assert.equal(plan.withinCaps, true, `${target}/${spec} must fit its caps: ${plan.problems.join(',')}`);
          // Every timeout plus the setup estimate fits the run cap.
          assert(plan.limits.worstCaseSeconds + plan.limits.setupAllowanceSeconds <= plan.limits.runMinutes * 60, `${target}/${spec} worst case ${plan.limits.worstCaseSeconds}s`);
        } else {
          // Rounds: every module fits one; on the user target all of them fit
          // the three rounds of one authorisation.
          // The whole registry outgrew three user rounds with the H3c rows:
          // on the user target it has to be split across authorisations, so
          // there only every round fitting is checked; each group still fits.
          const packed = live.packRounds(selected, target, target === 'user' && spec === 'all' ? { maxRounds: 99 } : undefined);
          assert.deepEqual([packed.unfit, packed.overflow], [[], []], `${target}/${spec} rounds`);
          assert.equal(packed.ok, true);
          if (target === 'user' && spec !== 'all') assert(packed.count <= 3, `${target}/${spec} takes ${packed.count} rounds`);
          for (const round of packed.rounds) assert.equal(live.buildPlan({ target, selected: selected.filter(m => round.modules.includes(m.id)) }).withinCaps, true, `${target}/${spec} round ${round.n}`);
        }
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
    // The user caps as authorised on 2026-11-01, as --plan shows them, on
    // the rows that fit one run (the registry before the self-hosted rows).
    const ONE_RUN = 'readonly,core,edges,ai,*.sharing.*,*.limits.*';
    {
      const { selected, skipped } = live.selectModules(ONE_RUN, { target: 'user' });
      const plan = live.buildPlan({ target: 'user', selected, skipped });
      assert.deepEqual(plan.budget.linkding.caps, { bookmarks: 15, node: 250, cleanupReserve: 60, browser: 350, tags: 20, lists: 0 });
      assert.deepEqual(plan.budget.karakeep.caps, { bookmarks: 12, node: 250, cleanupReserve: 60, browser: 500, tags: 20, lists: 1 });
      // Tag pages (main-session ruling on H1b): the plan states how many pages
      // of the user's tag library it can take; the preflight counts them.
      // linkding: six tag-list reads at 100 a page, 330/350 browser requests
      // planned, so four pages; Karakeep's budgets cover six pages of 1000.
      const ld = plan.budget.linkding, kk = plan.budget.karakeep;
      assert.deepEqual([ld.tagPages.perPage, ld.tagPages.assumedPages, ld.tagPages.tagReads, ld.tagPages.maxPagesWithinCaps], [100, 1, 6, 4]);
      assert.deepEqual([kk.tagPages.perPage, kk.tagPages.assumedPages, kk.tagPages.maxPagesWithinCaps >= 6], [1000, 6, true]);
      assert.deepEqual(live.tagPageBudget(ld, 4).problems, []);
      assert.deepEqual([live.tagPageBudget(ld, 4).browser, live.tagPageBudget(ld, 5).problems], [ld.browser + 18, ['browser']]);
      assert.deepEqual(live.tagPageBudget(kk, 5).extraPages, 0, 'the user Karakeep library (about five pages) costs nothing extra');
      assert.deepEqual(live.tagPageBudget(ld, 200).problems, ['tag_pages', 'browser', 'node']);
      assert.equal(live.cleanupCost({ service: 'linkding', tagPages: 10 }) - live.cleanupCost({ service: 'linkding' }), 16, 'the sweep and verify pass read every page');
      assert(live.tagPageBudget(ld, 3).cleanupReserve >= live.cleanupCost({ service: 'linkding', bookmarks: ld.bookmarks, urls: ld.urls, tags: ld.tags, lists: ld.lists, tagPages: 3 }));
      // The count itself is in the plan's Node requests on the user target:
      // one count page on linkding, Karakeep paged through (review of H1c,
      // should-fix 2).
      assert.deepEqual(['linkding', 'karakeep'].map(s => live.preflightCost({ service: s, target: 'user' }) - live.preflightCost({ service: s, target: 'temp' })), [1, live.TAG_PAGES.karakeep.browser]);
      for (const [instance, row] of Object.entries(plan.budget)) {
        const moduleNode = row.modules.reduce((n, id) => n + live.resolveBudget(selected.find(m => m.id === id)).node, 0);
        const writes = row.modules.some(id => selected.find(m => m.id === id).needs?.writes !== false);
        assert.equal(row.node - moduleNode - live.preflightCost({ service: row.service, urls: row.urls, writes }), { linkding: 1, karakeep: 6 }[instance], instance);
      }
      // The temporary target counts nothing: its libraries hold the run's tags only.
      const tempPlan = live.buildPlan({ target: 'temp', ...live.selectModules(ONE_RUN, { target: 'temp' }) });
      assert(Object.values(tempPlan.budget).every(row => row.tagPages === undefined));
      assert.deepEqual([plan.limits.runMinutes, plan.limits.moduleSeconds, plan.limits.fakeAi, plan.limits.automaticRetries], [20, 120, 60, 0]);
      assert.deepEqual(plan.skipped.map(s => s.reason), ['snapshot_setting_unreadable', 'target_temp', 'target_temp'], 'the snapshot module and temp-only modules are skipped on the user target');
      // Named exactly next to all, the snapshot module still fits the caps.
      const named = live.selectModules('linkding.core.snapshot,' + ONE_RUN, { target: 'user' });
      const namedPlan = live.buildPlan({ target: 'user', selected: named.selected, skipped: named.skipped });
      assert.equal(namedPlan.withinCaps, true, namedPlan.problems.join(','));
      assert(namedPlan.limits.worstCaseSeconds + namedPlan.limits.setupAllowanceSeconds <= namedPlan.limits.runMinutes * 60);
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
    // Rounds (E8): a selection over one run's caps is packed into the fewest
    // runs each within every cap, from the rows alone (the same answer each
    // time); past three on the user target the plan fails and names the
    // modules left over; --round N runs one of them.
    {
      // Every row but the H3c ux/shots ones, which a user-target run takes
      // as their own authorisation (group h3c, two rounds).
      const USER_ROUNDS = 'core,edges,readonly,ai,selfhosted,regress';
      const userAll = live.selectModules(USER_ROUNDS, { target: 'user', services: ['linkding', 'karakeep', 'pinboard'] }).selected;
      assert.equal(live.packRounds(live.selectModules('h3c', { target: 'user', services: ['linkding', 'karakeep', 'pinboard'] }).selected, 'user').count, 2, 'h3c: two user rounds');
      assert.equal(live.buildPlan({ target: 'user', selected: userAll }).withinCaps, false, 'all modules do not fit one user round');
      const packed = live.packRounds(userAll, 'user');
      assert.deepEqual(live.packRounds([...userAll].reverse(), 'user').rounds.map(r => [...r.modules].sort()).sort(), packed.rounds.map(r => [...r.modules].sort()).sort(), 'the order given does not change the rounds');
      assert.deepEqual(live.packRounds(userAll, 'user'), packed, 'recomputed the same');
      assert.deepEqual([packed.ok, packed.exhaustive, packed.count, packed.maxRounds, packed.overflow, packed.unfit], [true, true, 3, 3, [], []]);
      // Three since the self-hosted save rows (H3b): the rounds of one
      // authorisation, with nothing left over.
      const placed = packed.rounds.flatMap(r => r.modules);
      assert.deepEqual([...placed].sort(), userAll.map(m => m.id).sort(), 'every module in exactly one round');
      for (const round of packed.rounds) {
        const mods = userAll.filter(m => round.modules.includes(m.id));
        assert.deepEqual(round.modules, mods.map(m => m.id), 'registry order inside a round');
        const plan = live.buildPlan({ target: 'user', selected: mods });
        assert.equal(plan.withinCaps, true, plan.problems.join(','));
        for (const [instance, row] of Object.entries(round.instances)) {
          const cap = live.BUDGETS.user[instance];
          assert(row.bookmarks <= cap.bookmarks && row.node + row.cleanupReserve <= cap.node && row.browser <= cap.browser && row.tags <= cap.tags, instance);
        }
        assert(round.fakeAi <= live.BUDGETS.user.run.fakeAi && round.worstCaseSeconds <= live.BUDGETS.user.run.runMinutes * 60);
      }
      assert.deepEqual([packed.caps.linkding.bookmarks, packed.caps.karakeep.bookmarks, packed.caps.pinboard.bookmarks, packed.caps.linkding.node, packed.caps.linkding.cleanupReserve, packed.caps.linkding.browser, packed.caps.karakeep.browser, packed.caps.run.fakeAi, packed.caps.run.runMinutes], [15, 12, 8, 250, 60, 350, 500, 60, 20]);
      // The temporary target: the self-hosted rows fit one 45-minute run,
      // the whole registry two.
      assert.deepEqual(live.packRounds(live.selectModules('selfhosted').selected, 'temp').count, 1);
      assert.deepEqual(live.packRounds(live.selectModules('all').selected, 'temp').count, 2);
      // Seven Karakeep bookmarks each: one module per round, four rounds.
      const big = Array.from({ length: 4 }, (_, i) => ({ ...base, id: 'big.' + i, services: ['karakeep'], budget: { bookmarks: 7, urls: 7, node: 10, browser: 20, ai: 0, tags: 0, seconds: 30 } }));
      const overRound = { ...base, id: 'big.alone', services: ['karakeep'], budget: { bookmarks: 13, urls: 13, node: 10, browser: 20, seconds: 30 } };
      const fourRows = [...big, overRound];
      const four = live.packRounds(live.selectModules('*', { target: 'user', services: ['karakeep'], modules: fourRows }).selected, 'user');
      assert.deepEqual([four.ok, four.count, four.overflow, four.unfit], [false, 4, ['karakeep.big.3'], ['karakeep.big.alone']]);
      const roundSel = (values, rows = undefined) => live.resolveSelection({ values: { target: 'user', service: 'linkding,karakeep,pinboard', scenario: USER_ROUNDS, ...values }, flags: new Set() }, rows ? { modules: rows } : {});
      assert.deepEqual(roundSel({ round: '2' }).selected.map(m => m.id), packed.rounds[1].modules);
      assert.deepEqual(roundSel({ round: '2' }).round, { n: 2, of: 3, modules: packed.rounds[1].modules });
      assert.throws(() => roundSel({ round: '4' }), e => e.code === 'round_out_of_range');
      for (const bad of ['0', 'x', '-1', '1.5']) assert.throws(() => roundSel({ round: bad }), e => e.code === 'round', bad);
      assert.throws(() => roundSel({ round: '1', service: 'karakeep', scenario: '*' }, fourRows), e => e.code === 'rounds_exceeded');
      // --plan: rounds and their totals; an error past three rounds.
      const planOut = async (argv, rows) => {
        const write = process.stdout.write, chunks = [];
        process.stdout.write = (chunk, cb) => { chunks.push(String(chunk)); if (typeof cb === 'function') cb(); return true; };
        process.env.PBP_LIVE_STATE_DIR = stateDirFor('rounds');
        try { return { code: await live.main(argv, rows ? { modules: rows } : {}), value: JSON.parse(chunks.join('')) }; } finally { process.stdout.write = write; }
      };
      const shown = await planOut(['--plan', '--target', 'user', '--service', 'linkding,karakeep,pinboard', '--scenario', USER_ROUNDS]);
      assert.equal(shown.code, 0, 'over one round but within three: the plan stands');
      assert.equal(shown.value.withinCaps, false);
      assert.deepEqual(shown.value.rounds.rounds, packed.rounds);
      assert(shown.value.rounds.hint.includes('--round 1..3'), shown.value.rounds.hint);
      const second = await planOut(['--plan', '--target', 'user', '--service', 'linkding,karakeep,pinboard', '--scenario', USER_ROUNDS, '--round', '2']);
      assert.deepEqual([second.value.withinCaps, second.value.modules.map(m => m.id), second.value.round.n, second.value.rounds.count], [true, packed.rounds[1].modules, 2, 3]);
      const tooMany = await planOut(['--plan', '--target', 'user', '--service', 'karakeep', '--scenario', '*', '--authorization', 'rounds-test'], fourRows);
      assert.equal(tooMany.code, 1);
      assert(tooMany.value.problems.includes('rounds'));
      assert.deepEqual([tooMany.value.rounds.overflow, tooMany.value.rounds.unfit], [['karakeep.big.3'], ['karakeep.big.alone']]);
      // --run --round records which round it ran.
      const state = stateDirFor('round-run');
      process.env.PBP_LIVE_STATE_DIR = state;
      const code = await quiet(() => live.main(['--run', '--target', 'user', '--service', 'linkding,karakeep,pinboard', '--scenario', USER_ROUNDS, '--round', '2', '--linkding', 'http://127.0.0.1:9', '--karakeep', 'http://127.0.0.1:10', '--confirm-karakeep-no-auto-ai', '--allow-dirty', '--authorization', 'round-run', '--credentials', join(dir, 'absent.json')]));
      assert.equal(code, 1);
      const roundReport = JSON.parse(readFileSync(join(state, readdirSync(state).find(n => /^pbp-it-[0-9a-f-]{36}$/.test(n)), 'report.json'), 'utf8'));
      assert.equal(roundReport.failure.code, 'credentials_unreadable');
      assert.deepEqual(roundReport.round, { n: 2, of: 3, modules: packed.rounds[1].modules });
      assert.deepEqual(roundReport.selected, packed.rounds[1].modules);
    }
  }

  // ---------------------------------------------------------------------
  // Guard rule: one function, both layers (the worker gets its source text)
  // ---------------------------------------------------------------------
  if (only('guard rule and caps')) {
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
      // description, extended and dt too (H1b): a second value could carry a
      // title, note or date the guard never saw.
      ...['tags=x', 'auth_token=b%3A2', 'replace=no', 'toread=yes', 'description=y', 'extended=z', 'dt=2020-01-01T00%3A00%3A00Z&dt=2021-01-01T00%3A00%3A00Z'].map(extra => [{ url: pbAdd(cfg.pools.pinboard[1], 'no') + '&' + extra, method: 'GET' }, false, 'live_guard_pinboard_params']),
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
    // Per-endpoint tallies keep no ids or query values.
    assert.equal(live.endpointKey('http://127.0.0.1:1002/api/v1/tags?limit=1000', 'http://127.0.0.1:1002/api/v1/'), 'tags');
    assert.equal(live.endpointKey('http://127.0.0.1:1002/api/v1/tags?limit=1000&cursor=abc', 'http://127.0.0.1:1002/api/v1/'), 'tags?cursor');
    assert.equal(live.endpointKey('http://127.0.0.1:1002/api/v1/bookmarks/clx9z8k2/tags', 'http://127.0.0.1:1002/api/v1/'), 'bookmarks/:id/tags');
    // A Karakeep id from run 8bdd50c7: letters only.
    assert.equal(live.endpointKey('http://127.0.0.1:1002/api/v1/bookmarks/jrpkwzchichxdmmsuksxvkqh/tags', 'http://127.0.0.1:1002/api/v1/'), 'bookmarks/:id/tags');
    assert.equal(live.endpointKey('http://127.0.0.1:1002/api/v1/bookmarks/check-url?url=x', 'http://127.0.0.1:1002/api/v1/'), 'bookmarks/check-url');
    assert.equal(live.endpointKey('http://127.0.0.1:1001/api/bookmarks/12/', 'http://127.0.0.1:1001/api/'), 'bookmarks/:id');
    assert.equal(live.endpointKey(live.PINBOARD_ROOT + 'posts/get?url=x&auth_token=a%3A1', live.PINBOARD_ROOT), 'posts/get');
    assert.equal(live.endpointKey('http://127.0.0.1:1001/bookmarks?q=x', 'http://127.0.0.1:1001/api/'), 'page');
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
      const tagged = fakeRoute('bookmarks/k7/tags', 'POST', JSON.stringify({ tags: [{ tagName: routeRun.prefix + ' machine learning' }] }));
      await routeRun.onRoute(tagged.route);
      assert.equal(tagged.continued, true);
      assert.deepEqual(routeRun.report.ledger.tags.map(t => [t.instance, t.key, t.source]), [['karakeep', routeRun.prefix + ' machine learning', 'route']]);
      // A write naming a tag outside the run prefix is fatal and not sent
      // (H1b): such a tag could never be cleaned up from a user instance.
      sent.length = 0;
      const foreign = fakeRoute('bookmarks/k7/tags', 'POST', JSON.stringify({ tags: [{ tagName: routeRun.prefix + '_ok' }, { tagName: 'personal' }] }));
      await routeRun.onRoute(foreign.route);
      assert.deepEqual([foreign.aborted, foreign.continued, sent, routeRun.fatal], ['blockedbyclient', undefined, [], 'live_guard_foreign_tag']);
      assert.equal(routeRun.report.ledger.tags.length, 1, 'a refused write reserves nothing');
      // An over-long tag (past 64 code points) never reaches a user
      // instance: fatal and not sent, unless an injected answer stands in
      // for the service. A temporary instance gets it.
      const longName = routeRun.prefix + '_' + 'long'.repeat(6);
      assert(longName.length > 64);
      for (const [target, injected, outcome] of [['user', false, ['blockedbyclient', undefined, [], live.LONG_TAG_USER_CODE]], ['user', true, [undefined, undefined, [], null]], ['temp', false, [undefined, true, ['POST bookmarks/k7/tags'], null]]]) {
        routeRun.fatal = null;
        routeRun.target = target;
        routeRun.faults = injected ? [{ on: 'service', instance: 'karakeep', method: 'POST', path: /tags$/, status: 500, left: -1, hits: 0 }] : [];
        sent.length = 0;
        const long = fakeRoute('bookmarks/k7/tags', 'POST', JSON.stringify({ tags: [{ tagName: longName }] }));
        await routeRun.onRoute(long.route);
        assert.deepEqual([long.aborted, long.continued, sent, routeRun.fatal], outcome, 'over-long tag on ' + target + (injected ? ' (injected)' : ''));
        if (injected) assert.equal(long.fulfilled, true, 'the injected answer stands in for the service');
      }
      assert.equal(live.liveGuardRule({ ...cfg, prefix: routeRun.prefix }, { created: [{ instance: 'linkding', id: '1', url: cfg.pools.linkding[0] }] }, { url: cfg.instances.linkding.root + 'bookmarks/1/', method: 'PATCH', body: JSON.stringify({ tag_names: [routeRun.prefix + '_' + 'é'.repeat(64)] }) }).longTag, true, 'code points, not bytes or UTF-16 units: 64 accented letters past the prefix are long');
      assert.equal(live.liveGuardRule({ ...cfg, prefix: 'pbp-it-x' }, { created: [{ instance: 'linkding', id: '1', url: cfg.pools.linkding[0] }] }, { url: cfg.instances.linkding.root + 'bookmarks/1/', method: 'PATCH', body: JSON.stringify({ tag_names: ['pbp-it-x' + '😀'.repeat(56)] }) }).longTag, false, '64 code points is not long, however many UTF-16 units');
      routeRun.target = 'user';
      routeRun.faults = [];
      routeRun.fatal = null;
      // Where faults sit in onRoute (t.inject): a page fault answers only the
      // run's fixture origins; a service fault answers only after the guard
      // judged and counted the request, so a forbidden write still trips the
      // guard; an injected create records nothing for cleanup.
      {
        sent.length = 0;
        const fixture = cfg.pools.karakeep[1];
        routeRun.fixtureOrigins = new Set([live.originOf(fixture)]);
        routeRun.poolSet = new Set();
        const pageFault = { on: 'page', method: '', path: /./, abort: 'connectionrefused', left: -1, hits: 0 };
        const serviceFault = { on: 'service', instance: 'karakeep', method: '', path: undefined, status: 502, left: -1, hits: 0 };
        routeRun.faults = [pageFault, serviceFault];
        const pageAt = (url, method = 'GET') => {
          const out = {};
          out.route = { request: () => ({ url: () => url, method: () => method, postData: () => null }), fetch: async () => { sent.push(method + ' ' + url); }, fulfill: async () => { out.fulfilled = true; }, abort: async code => { out.aborted = code; }, continue: async () => { sent.push(method + ' ' + url); out.continued = true; } };
          return out;
        };
        const fixtureLoad = pageAt(fixture);
        await routeRun.onRoute(fixtureLoad.route);
        assert.deepEqual([fixtureLoad.aborted, pageFault.hits], ['connectionrefused', 1], 'a fixture page load gets the page fault');
        const elsewhere = pageAt('https://example.org/page');
        await routeRun.onRoute(elsewhere.route);
        assert.deepEqual([elsewhere.aborted, pageFault.hits, routeRun.fatal], ['blockedbyclient', 1, null], 'another origin is never answered by a page fault');
        const serviceRead = pageAt(cfg.instances.karakeep.root + 'bookmarks/check-url?url=x');
        const browserBefore = routeRun.count('karakeep').browser;
        await routeRun.onRoute(serviceRead.route);
        assert.deepEqual([serviceRead.fulfilled, pageFault.hits, serviceFault.hits, routeRun.count('karakeep').browser - browserBefore], [true, 1, 1, 1], 'a service request is not a page load: the service fault answers it, counted');
        const forbidden = fakeRoute('bookmarks/not-ours', 'DELETE', null);
        await routeRun.onRoute(forbidden.route);
        assert.deepEqual([forbidden.aborted, forbidden.fulfilled, serviceFault.hits, routeRun.fatal], ['blockedbyclient', undefined, 1, 'live_guard_mutation'], 'a forbidden write trips the guard even when a fault would answer it');
        routeRun.fatal = null;
        const ledgerBefore = routeRun.report.ledger.created.length;
        const injectedCreate = fakeRoute('bookmarks', 'POST', JSON.stringify({ type: 'link', url: cfg.pools.karakeep[0] }));
        const createsBefore = routeRun.count('karakeep').browserWrites;
        await routeRun.onRoute(injectedCreate.route);
        assert.deepEqual([injectedCreate.fulfilled, sent, routeRun.report.ledger.created.length - ledgerBefore, routeRun.count('karakeep').browserWrites - createsBefore, routeRun.pending.karakeep?.bookmarks || 0], [true, [], 0, 1, 0], 'an injected create is counted, never sent, records nothing and holds no slot');
        routeRun.faults = [];
      }
      // The Node API (t.api, t.seed) refuses it on a user instance too.
      for (const target of ['user', 'temp']) {
        const nodeRun = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
        nodeRun.target = target;
        nodeRun.instances.linkding = { id: 'linkding', service: 'linkding', ...cfg.instances.linkding };
        nodeRun.caps = { linkding: live.BUDGETS[target].linkding };
        nodeRun.pools.linkding = cfg.pools.linkding;
        const body = { url: cfg.pools.linkding[0], title: 't', tag_names: [nodeRun.prefix + '_' + 'long'.repeat(6)] };
        const attempt = () => nodeRun.nodeGuard('linkding', 'POST', cfg.instances.linkding.root + 'bookmarks/', body);
        if (target === 'user') { assert.throws(attempt, e => e.code === live.LONG_TAG_USER_CODE && e.fatal === true); assert.equal(nodeRun.fatal, live.LONG_TAG_USER_CODE); }
        else assert.equal(attempt().create, cfg.pools.linkding[0], 'a temporary instance takes it');
      }

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
      await assert.rejects(post(tagsUrl, tagBody([prefix0 + '_a', 'personal'])), e => e.message === 'live_guard_foreign_tag', 'a foreign tag name is refused in the worker too');
      assert.equal(sent.length, 1, 'and not sent');
      const attached = post(tagsUrl, tagBody([prefix0 + '_a', prefix0 + '_b']));
      answers[1]({ ok: true, status: 200 });
      await attached;
      const overTags = await Promise.race([post(tagsUrl, tagBody([prefix0 + '_c', prefix0 + '_d'])).then(() => 'answered', e => e.message), new Promise(r => setTimeout(() => r('sent and waiting'), 100))]);
      assert.deepEqual([overTags, JSON.parse(JSON.stringify(sandbox.pbpLiveGuard.tags)), sent.length], ['live_guard_tag_budget', [{ instance: 'karakeep', key: prefix0 + '_a' }, { instance: 'karakeep', key: prefix0 + '_b' }], 2]);
    }
    {
      // Second H1 review note: the route layer records a worker create and
      // shares it with the worker (shareCreated) as soon as it has the answer,
      // which can reach the worker before the worker reads that same answer
      // and frees the slot. For that moment one bookmark counted twice
      // (created and pending), so at cap - 1 a second, legitimate create was
      // refused and the run failed. A slot whose URL is already recorded no
      // longer counts.
      const sent = [];
      const answers = [];
      const sandbox = vm.createContext({ fetch: (input, opts) => { sent.push((opts?.method || 'GET') + ' ' + input); return new Promise(r => answers.push(r)); }, URL, location: { href: 'chrome-extension://' + 'a'.repeat(32) + '/background.js' } });
      vm.runInContext(`(${live.installWorkerGuard.toString()})(${live.guardRuleSource()}, ${JSON.stringify({ ...cfg, caps: {}, prefix: prefix0, limits: { ...limits0, linkding: { bookmarks: 2, lists: 0, tags: 3 } } })}, 'tok')`, sandbox);
      const post = vm.runInContext('(function save(u, body) { return fetch(u, { method: "POST", body }); })', sandbox);
      const createUrl = cfg.instances.linkding.root + 'bookmarks/';
      const firstCreate = post(createUrl, JSON.stringify({ url: cfg.pools.linkding[0] }));
      // shareCreated from the route layer lands first.
      vm.runInContext(`pbpLiveGuard.created.push({ instance: 'linkding', id: '41', url: ${JSON.stringify(cfg.pools.linkding[0])} })`, sandbox);
      const secondCreate = await Promise.race([post(createUrl, JSON.stringify({ url: cfg.pools.linkding[1] })).then(() => 'answered', e => e.message), new Promise(r => setTimeout(() => r('sent and waiting'), 100))]);
      assert.deepEqual([secondCreate, sent.length, JSON.parse(JSON.stringify(sandbox.pbpLiveGuard.violations))], ['sent and waiting', 2, []], 'one recorded bookmark and one in flight do not count as two');
      answers[0]({ ok: true, clone: () => ({ json: async () => ({ id: 41, url: cfg.pools.linkding[0] }) }) });
      await firstCreate;
      assert.deepEqual(JSON.parse(JSON.stringify(sandbox.pbpLiveGuard.created)).map(r => r.id), ['41'], 'recorded once');
      // The cap still holds: two bookmarks (one recorded, one in flight) fill it.
      const third = await Promise.race([post(createUrl, JSON.stringify({ url: cfg.pools.linkding[1] })).then(() => 'answered', e => e.message), new Promise(r => setTimeout(() => r('sent and waiting'), 100))]);
      assert.equal(third, 'live_guard_bookmark_budget');
      // A record that predates the flight (a deleted bookmark whose URL is
      // saved again makes a new one) offsets nothing.
      const again = vm.createContext({ fetch: () => new Promise(() => {}), URL, location: { href: 'chrome-extension://' + 'a'.repeat(32) + '/background.js' } });
      vm.runInContext(`(${live.installWorkerGuard.toString()})(${live.guardRuleSource()}, ${JSON.stringify({ ...cfg, caps: {}, prefix: prefix0, limits: { ...limits0, linkding: { bookmarks: 2, lists: 0, tags: 3 } } })}, 'tok')`, again);
      vm.runInContext(`pbpLiveGuard.created.push({ instance: 'linkding', id: '40', url: ${JSON.stringify(cfg.pools.linkding[0])} })`, again);
      const postAgain = vm.runInContext('(function save(u, body) { return fetch(u, { method: "POST", body }); })', again);
      postAgain(createUrl, JSON.stringify({ url: cfg.pools.linkding[0] }));
      const over = await Promise.race([postAgain(createUrl, JSON.stringify({ url: cfg.pools.linkding[1] })).then(() => 'answered', e => e.message), new Promise(r => setTimeout(() => r('sent and waiting'), 100))]);
      assert.equal(over, 'live_guard_bookmark_budget', 'a re-save of a recorded URL still holds its slot');
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
      let d = rule(limited, at(), linkdingTags([prefix0 + '_a', prefix0 + ' b', prefix0.toUpperCase() + '_A']));
      assert.deepEqual([d.ok, d.tags], [true, [prefix0 + '_a', prefix0 + '-b']]);
      // Any tag name outside the run prefix is refused (H1b), in every write
      // shape of every service, whatever caps remain.
      for (const req of [linkdingTags([prefix0 + '_a', 'personal']), create([prefix0 + '_a,personal']), linkdingTags(['pbp-it-' + randomUUID() + '_a']), karakeepTags([prefix0 + '_a', 'Personal']), karakeepTags(['#personal']), pinboardAdd(prefix0 + '_x personal'), pinboardAdd('personal,' + prefix0 + '_x')]) {
        assert.equal(verdict(at(), req), 'live_guard_foreign_tag', req.url + ' ' + (req.body || ''));
        assert.equal(verdict(at(), req, { ...limited, limits: undefined }), 'live_guard_foreign_tag', 'without limits too');
      }
      d = rule(limited, at({ tags: [{ instance: 'linkding', key: prefix0 + '_a' }] }), linkdingTags([prefix0 + '_a,' + prefix0 + '_c', prefix0 + '_d']));
      assert.deepEqual([d.ok, d.tags], [true, [prefix0 + '_c', prefix0 + '_d']]);
      assert.equal(verdict(at({ tags: [{ instance: 'linkding', key: prefix0 + '_a' }] }), linkdingTags([prefix0 + '_b,' + prefix0 + '_c', prefix0 + '_d'])), 'live_guard_tag_budget', 'one name with commas is three tags');
      assert.equal(verdict(at(), create([1, 2, 3, 4].map(n => prefix0 + '_' + n))), 'live_guard_tag_budget', 'a create naming too many run tags');
      assert.equal(verdict(at({ tags: known('linkding', 3) }), linkdingTags([prefix0 + '_1', prefix0 + '_3'])), 'ok', 'known run tags add nothing');
      // Karakeep: exact names once trimmed and stripped of leading '#'.
      d = rule(limited, at(), karakeepTags(['#' + prefix0 + '_A', ' ' + prefix0 + '_a ']));
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
        // linkding keeps a leading '#': that name is outside the prefix there.
        const names = samples.filter(n => live.liveTagKey(service, n).toLowerCase().startsWith(prefix0));
        assert.deepEqual(names.length, service === 'linkding' ? samples.length - 1 : samples.length);
        const expected = [...new Set(names.map(n => live.liveTagKey(service, n)))];
        assert.deepEqual(rule(roomy, at(), req(names)).tags, expected, service + ' keys agree with liveTagKey');
        if (names.length < samples.length) assert.equal(rule(roomy, at(), req(samples)).code, 'live_guard_foreign_tag');
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
    {
      // Parts (t.part): a failed expectation inside one is recorded with the
      // part's own fix groups, its faults are cleared, the settings it found
      // are put back, and the module goes on; the module still fails on the
      // first failed part, at that part's phase. A pending ruling (t.pending)
      // is recorded without failing. A fatal finding ends the module at once.
      const partRun = () => {
        const r = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
        r.target = 'temp';
        r.instances.linkding = { id: 'linkding', service: 'linkding', base: 'http://127.0.0.1:9/', root: 'http://127.0.0.1:9/api/', token: 'f'.repeat(40) };
        r.caps = { linkding: live.BUDGETS.temp.linkding };
        r.reserve = { linkding: 60 };
        r.pools.linkding = live.poolUrls('temp', r.runId, 'linkding', 2);
        r.claimed.linkding = 0;
        r.guardCfg = {};
        r.ctx = { pages: () => [] };
        r.worker = { evaluate: async () => {} };
        r.syncGuard = async () => {};
        r.pushGuardWrites = async () => {};
        r.restores = [];
        r.sw = async (fn, arg) => {
          const text = String(fn);
          if (text.includes('SETTINGS_DEFAULTS')) {
            // The module's snapshot keys, as the worker would list them.
            globalThis.SETTINGS_DEFAULTS = { optA: 1 };
            try { r.snapshotKeys = fn(); } finally { delete globalThis.SETTINGS_DEFAULTS; }
            return ['optA'];
          }
          if (text.includes('local.set(saved)')) { r.restores.push(arg.saved); return undefined; }
          if (text.includes('local.set(snapshot)')) { r.restores.push(arg.snapshot); return undefined; }
          if (text.includes('storage.local.get')) return { optA: 'before' };
          return undefined;
        };
        return r;
      };
      const run = partRun();
      const seen = [];
      const mod = {
        id: 'linkding.parts.check', instance: 'linkding', service: 'linkding', needs: { writes: false }, settings: {}, fixRefs: ['G1', 'G2'], features: ['f-first', 'f-second', 'f-outside'],
        budget: { bookmarks: 0, urls: 0, node: 0, browser: 0, ai: 0, tags: 0, seconds: 5 },
        async steps(t) {
          t.inject({ method: 'POST', path: /^bookmarks/, status: 502 });
          t.inject({ method: 'GET', path: /^bookmarks\/check/, status: 200, body: { bookmark: null } });
          for (const spec of [{ method: 'POST', status: 201, body: { id: 1 } }, { status: 200, body: {} }, { method: 'PATCH', status: 204 }]) {
            assert.throws(() => t.inject(spec), e => e.code === 'inject_write_success' && e.fatal === true, 'a made-up write success would be recorded by the worker guard: ' + JSON.stringify(spec));
          }
          await t.part('first', ['G1'], async () => {
            await t.phase('first_phase');
            t.inject({ method: 'GET', path: /^bookmarks\/check/, status: 503 });
            t.expectEq('shown', 'wanted', 'first_failed');
            seen.push('after the failed expectation');
          }, ['f-first']);
          seen.push(run.faults.length);
          const ok = await t.part('second', ['G2'], async () => { await t.phase('second_phase'); seen.push('second'); }, ['f-second']);
          seen.push(ok);
          seen.push(t.pending('one line', 'two\n\nlines', 'pending_split', 'Description control shape'));
        },
      };
      await quiet(() => run.runModule(mod));
      const record = run.report.modules[0];
      assert.deepEqual([record.status, record.failure.code, record.failure.phase], ['failed', 'first_failed', 'first_phase'], 'the module fails on its first failed part, at that part');
      assert.deepEqual(record.parts.map(p => [p.name, p.status, p.fixRefs.join(','), p.code || '']), [['first', 'failed', 'G1', 'first_failed'], ['second', 'passed', 'G2', '']]);
      assert.deepEqual(seen, [2, 'second', true, false], 'the part stops at its failure; its fault is cleared, the earlier ones stay; the next part runs');
      assert.deepEqual(run.faults, [], 'the module leaves no fault behind');
      assert.deepEqual(run.restores, [{ optA: 'before' }, { optA: 'before' }], 'the failed part restores its settings, then the module does');
      assert.deepEqual(record.pendingDecisions.map(d => [d.code, d.actual]), [['pending_split', 'one line']], 'a pending ruling is recorded, not failed');
      assert.equal(run.fatal, null);
      for (const key of ['optA', 'offlineQueue', 'offlineQueuePause']) assert(run.snapshotKeys.includes(key), 'a module restores ' + key + ' when it ends');
      assert.equal(record.failure.part, 'first', 'the failure names its part');
      run.selected = [mod];
      run.runDir = mkdtempSync(join(dir, 'parts-'));
      run.summaryPath = join(run.runDir, 'summary.zh.md');
      run.writeSummary();
      const summary = readFileSync(run.summaryPath, 'utf8');
      // A feature takes the verdict of the parts that name it; one no part
      // names follows the module.
      assert(/- 通过（1）：f-second\n/.test(summary), 'a passed part\'s feature passes');
      assert(summary.includes('- 未通过 f-first：linkding.parts.check') && summary.includes('- 未通过 f-outside：linkding.parts.check'), 'the failed part\'s feature and an unmapped one fail');
      const strayRun = partRun();
      const strayMod = { ...mod, id: 'linkding.parts.stray', async steps(t) { await t.part('stray', ['G1'], async () => {}, ['not-declared']); } };
      await assert.rejects(quiet(() => strayRun.runModule(strayMod)), e => e.code === 'part_feature_undeclared');
      assert(summary.includes('分段：first 失败于 first_phase，first_failed（依赖 G1）；second 通过（依赖 G2）'), 'the summary names each part with its own fix groups');
      assert(summary.includes('linkding.parts.check 待裁定：pending_split（Description control shape'), 'the summary lists pending rulings');
      const fatalRun = partRun();
      let after = false;
      const fatalMod = { ...mod, id: 'linkding.parts.fatal', async steps(t) { await t.part('fatal', ['G1'], async () => { fatalRun.setFatal('live_guard_mutation'); t.expect(true, 'x'); }); after = true; } };
      await assert.rejects(quiet(() => fatalRun.runModule(fatalMod)), e => e.code === 'live_guard_mutation');
      assert.deepEqual([fatalRun.report.modules[0].status, after], ['aborted', false], 'a fatal finding in a part ends the module');
      // A failed part does not skip the module's closing checks: a module
      // over its request budget still aborts the run as module_request_budget,
      // and an undeclared surface or an uncaught page error is recorded.
      const overRun = partRun();
      const overMod = { ...mod, id: 'linkding.parts.over', surfaces: [], async steps(t) {
        await t.part('first', ['G1'], async () => { t.expectEq('shown', 'wanted', 'first_failed'); });
        await t.part('second', ['G2'], async () => { overRun.count('linkding').browser += 5; overRun.report.pageErrors.push({ message: 'boom' }); });
      } };
      await assert.rejects(quiet(() => overRun.runModule(overMod)), e => e.code === 'module_request_budget');
      const over = overRun.report.modules[0];
      assert.deepEqual([over.status, over.failure.code, overRun.fatal, over.counts.browser], ['aborted', 'module_request_budget', 'module_request_budget', 5], 'the budget is checked after a failed part');
      // A fatal finding the parts left (set after the last harness call)
      // names the abort, not the earlier part's code.
      const lateRun = partRun();
      const lateMod = { ...mod, id: 'linkding.parts.late', async steps(t) {
        await t.part('first', ['G1'], async () => { t.expectEq('shown', 'wanted', 'first_failed'); });
        lateRun.fatal = 'live_guard_mutation';
      } };
      await assert.rejects(quiet(() => lateRun.runModule(lateMod)), e => e.code === 'live_guard_mutation');
      assert.deepEqual([lateRun.report.modules[0].status, lateRun.report.modules[0].failure.code], ['aborted', 'live_guard_mutation']);
      // Within budget: the part's failure stands, the page error and the
      // undeclared surface are kept beside it.
      const softRun = partRun();
      const softMod = { ...mod, id: 'linkding.parts.soft', surfaces: [], async steps(t) {
        await t.part('first', ['G1'], async () => { t.expectEq('shown', 'wanted', 'first_failed'); });
        await t.part('second', ['G2'], async () => { softRun.report.pageErrors.push({ message: 'boom' }); softRun.currentModule.driven.add('popup'); });
      } };
      await quiet(() => softRun.runModule(softMod));
      const soft = softRun.report.modules[0];
      assert.deepEqual([soft.status, soft.failure.code, soft.alsoFailed, soft.undeclaredSurfaces], ['failed', 'first_failed', ['surface_undeclared', 'browser_page_error'], ['popup']]);
      softRun.runDir = mkdtempSync(join(dir, 'parts-soft-'));
      softRun.summaryPath = join(softRun.runDir, 'summary.zh.md');
      softRun.writeSummary();
      assert(readFileSync(softRun.summaryPath, 'utf8').includes('另有收尾检查未过：surface_undeclared、browser_page_error'), 'the summary names the closing checks that failed beside the part');
    }
  }

  // ---------------------------------------------------------------------
  // Pure helpers: endpoints, redaction, Karakeep config, signals, lock
  // ---------------------------------------------------------------------
  if (only('pure helpers')) {
    // H3c: a fault with `pass` lets the first n matching requests through.
    {
      const run = new live.LiveRun({ mode: 'plan', flags: new Set(), values: {}, errors: [] });
      const fault = { pass: 1 };
      assert.equal(run.passFault(fault), true, 'the first request passes');
      assert.equal(run.passFault(fault), false, 'the next one is answered');
      assert.equal(fault.passed, 1);
      assert.equal(run.passFault({ pass: 0 }), false, 'no pass: every request is answered');
    }
    // The Impeccable list: Operate for popup and options, Read for the
    // reader; axe matched by state or state:locale:scheme; pictures only.
    {
      const shots = [
        { file: '/s/1.png', surface: 'popup', module: 'linkding.shots.matrix', state: 'matrix', locale: 'ja', scheme: 'dark', geometry: { ok: true } },
        { file: '/s/2.png', surface: 'options', module: 'linkding.shots.matrix', state: 'matrix', locale: 'en', scheme: 'light' },
        { file: '/s/3.png', surface: 'reader', module: 'linkding.sh.copy-exits', state: 'created', locale: 'en', scheme: 'light' },
      ];
      const findings = [
        { kind: 'axe', module: 'linkding.shots.matrix', state: 'matrix:ja:dark', violations: [{ id: 'color-contrast', impact: 'serious', nodes: 5 }] },
        { kind: 'axe', module: 'linkding.sh.copy-exits', state: 'created', violations: [] },
        { kind: 'geometry', module: 'linkding.shots.matrix', state: 'matrix:en:light' },
      ];
      const list = live.reviewList(shots, findings);
      assert.deepEqual(list.modes, { Operate: ['/s/1.png', '/s/2.png'], Read: ['/s/3.png'] });
      assert.deepEqual(list.entries[0].axe, { violations: ['color-contrast(serious)x5'], byImpact: { serious: 1 } });
      assert.equal(list.entries[1].axe, null, 'no axe run in that state');
      assert.deepEqual(list.entries[2].axe, { violations: [], byImpact: {} });
      assert.equal(list.entries[2].mode, 'Read');
    }
    // 待人工看 quotes the §9-18 copy from the tree under test.
    {
      const manualRoot = join(dir, 'manual-root');
      for (const locale of ['en', 'zh_CN']) {
        mkdirSync(join(manualRoot, '_locales', locale), { recursive: true });
        writeFileSync(join(manualRoot, '_locales', locale, 'messages.json'), JSON.stringify({ tagSeparatorHint: { message: locale + ' sep\n hint' } }));
      }
      const items = live.manualReviewItems(manualRoot);
      assert.match(items[0], /tagSeparatorHint.*en 「en sep hint」；zh_CN 「zh_CN sep hint」/);
      assert.match(items[1], /batchTagsHint.*en （缺）/, 'a missing key is said, not skipped');
      assert.ok(items.some(i => i.includes('Karakeep 列表图标') && i.includes(LIST_MARKER)));
      assert.ok(items.some(i => i.includes('linkding Notes')));
      assert.match(live.manualReviewItems(join(dir, 'nowhere'))[0], /（读不到）/);
    }
    // Route faults (t.inject): page faults match the whole URL, service
    // faults one instance's path after its API root; `times` runs out.
    {
      const svc = { on: 'service', instance: 'linkding', method: 'POST', path: /^bookmarks\/(\?|$)/, left: -1 };
      assert.equal(live.faultMatches(svc, { on: 'service', instance: 'linkding', method: 'post', path: 'bookmarks/?disable_scraping' }), true);
      assert.equal(live.faultMatches(svc, { on: 'service', instance: 'linkding', method: 'POST', path: 'bookmarks/12/' }), false, 'an update is not a create');
      assert.equal(live.faultMatches(svc, { on: 'service', instance: 'karakeep', method: 'POST', path: 'bookmarks/' }), false, 'another instance');
      assert.equal(live.faultMatches(svc, { on: 'page', url: 'bookmarks/' }), false, 'a page load is not a service request');
      assert.equal(live.faultMatches({ ...svc, left: 0 }, { on: 'service', instance: 'linkding', method: 'POST', path: 'bookmarks/' }), false, 'used up');
      assert.equal(live.faultMatches({ on: 'service', instance: 'linkding', method: '', path: undefined, left: -1 }, { on: 'service', instance: 'linkding', method: 'DELETE', path: 'x' }), true, 'no method or path: every request');
      const pageFault = { on: 'page', path: 'http://localhost:47391/?pbp-it=a-1', left: 1 };
      assert.equal(live.faultMatches(pageFault, { on: 'page', url: 'http://localhost:47391/?pbp-it=a-1', method: 'GET' }), true);
      assert.equal(live.faultMatches(pageFault, { on: 'page', url: 'http://localhost:47391/?pbp-it=a-10', method: 'GET' }), false, 'a string path is exact');
      assert.deepEqual(live.faultResponse({ status: 429, headers: { 'Retry-After': '120' }, body: { detail: 'x' } }), { status: 429, headers: { 'Retry-After': '120', 'content-type': 'application/json' }, body: '{"detail":"x"}' });
      assert.deepEqual(live.faultResponse({ status: 401, contentType: 'text/plain;charset=UTF-8', body: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: 'Unauthorized' });
      assert.equal(live.faultResponse({ abort: 'connectionrefused' }), null, 'an abort has no response');
      assert.equal(live.faultResponse({}).status, 503);
      assert.deepEqual([live.parseRequestBody('{"url":"u"}'), live.parseRequestBody('a=b'), live.parseRequestBody(''), live.parseRequestBody(null)], [{ url: 'u' }, 'a=b', null, null]);
      // The Notes renderer runs only when both paths are given and exist;
      // its input file is removed afterwards. A stand-in "python" echoes
      // the cases back as the replica's JSON shape.
      assert.equal(live.linkdingRenderer({}), null);
      assert.equal(live.linkdingRenderer({ PBP_LD_RENDER_PYTHON: join(dir, 'missing-python'), PBP_LD_RENDER_SCRIPT: join(dir, 'missing.py') }), null);
      const fakePython = join(dir, 'fake-python.sh'), fakeScript = join(dir, 'fake-render.py');
      writeFileSync(fakePython, `#!/bin/sh\n# $1 is -I, $2 the script, $3 the cases\nnode -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify({cases:c.map(x=>({key:x.key,html:"<p>"+x.notes+"</p>"}))}))' "$3"\n`, { mode: 0o755 });
      writeFileSync(fakeScript, '# stand-in\n');
      const renderer = live.linkdingRenderer({ PBP_LD_RENDER_PYTHON: fakePython, PBP_LD_RENDER_SCRIPT: fakeScript });
      const renderDir = mkdtempSync(join(dir, 'render-'));
      assert.deepEqual(await live.renderLinkdingNotes(renderer, ['a', 'b'], renderDir), ['<p>a</p>', '<p>b</p>']);
      assert.deepEqual(readdirSync(renderDir), [], 'the cases file is removed');
      assert.equal(await live.renderLinkdingNotes(null, ['a'], renderDir), null);
      // Asynchronous, with its own deadline: a stuck renderer is killed and
      // fails the module, and the event loop keeps running meanwhile.
      const slowPython = join(dir, 'slow-python.sh');
      writeFileSync(slowPython, '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
      let ticks = 0;
      const ticker = setInterval(() => ticks++, 20);
      await assert.rejects(live.renderLinkdingNotes({ python: slowPython, script: fakeScript }, ['a'], renderDir, { timeoutMs: 300 }), e => e.code === 'ld_render_failed');
      clearInterval(ticker);
      assert(ticks >= 5, 'the event loop ran while the renderer worked: ' + ticks);
      assert.deepEqual(readdirSync(renderDir), [], 'the cases file is removed after a failure too');
      // A selected row that needs the renderer is listed by --plan when it is
      // missing (and fails as ld_render_missing when run), never skipped.
      const quoteRows = live.selectModules('linkding.sh.quote-escape', { services: ['linkding'], target: 'temp' }).selected;
      assert.deepEqual(live.buildPlan({ target: 'temp', selected: quoteRows, env: {} }).missing.map(m => [m.code, m.modules.join()]), [['ld_render_missing', 'linkding.sh.quote-escape']]);
      assert.deepEqual(live.buildPlan({ target: 'temp', selected: quoteRows, env: { PBP_LD_RENDER_PYTHON: fakePython, PBP_LD_RENDER_SCRIPT: fakeScript } }).missing, []);
      // The quote judge (sh.quote-escape): visible lines inside a blockquote,
      // no Markdown structure.
      const { judgeRenderedQuote, QUOTE_CASES } = await import('../scripts/bookmark-service-live-scenarios.mjs');
      assert.equal(judgeRenderedQuote('Setext title\n===', { tags: ['blockquote', 'p', 'br'], text: 'Setext title\n===' }).ok, true);
      assert.deepEqual(judgeRenderedQuote('Setext title\n===', { tags: ['blockquote', 'h1'], text: 'Setext title' }).problems, ['structure:h1', 'text']);
      assert.deepEqual(judgeRenderedQuote('literal &lt;tag&gt;', { tags: ['blockquote', 'p'], text: 'literal <tag>' }).problems, ['text'], 'a decoded entity is a different text');
      assert.deepEqual(judgeRenderedQuote('1. item', { tags: ['p'], text: '1. item' }).problems, ['not_blockquote']);
      for (const needle of ['Setext title\n===', '1. item', '# heading', '&lt;tag&gt;', '\n\n    indented']) assert(QUOTE_CASES.some(c => c.includes(needle)), 'quote cases cover ' + JSON.stringify(needle));
      assert(QUOTE_CASES.some(c => /^.+\n=+$/.test(c)), 'a setext underline as the second line of its own case');
      // The rest of each escaped class, not only the inputs the brief named:
      // inline markup, a leading backslash, an HTML tag with no space after <.
      for (const re of [/\*\*\S/, /(^|\s)_\S/, /`[^`]+`/, /\[[^\]]+\]\(/, /^\\/m, /<[a-z]/]) assert(QUOTE_CASES.slice(0, -1).some(c => re.test(c)), 'a case of its own covers ' + re);
      assert.deepEqual(judgeRenderedQuote('x <b>y</b> z', { tags: ['blockquote', 'p', 'b'], text: 'x y z' }).problems, ['text'], 'a tag that renders is a different text');
    }
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
    // Harness v3 (H1b): the pool URL format changed after v2 reports were
    // written (http://pbp-it-fixture.test/ without a port), so an unfinished v2
    // report could neither be resumed (its pools no longer match poolUrls) nor
    // be stepped over. It is foreign now: not a blocking report, and --cleanup
    // refuses it before reading anything.
    {
      assert.equal(live.HARNESS_VERSION, 3);
      const state = stateDirFor('old-format');
      const runId = randomUUID();
      const oldDir = join(state, 'pbp-it-' + runId);
      mkdirSync(oldDir, { mode: 0o700 });
      const oldReport = { harness: 2, runId, prefix: 'pbp-it-' + runId, target: 'temp', instances: { linkding: { service: 'linkding', base: 'http://127.0.0.1:9/' } }, pools: { linkding: ['http://pbp-it-fixture.test/?pbp-it=' + runId + '-linkding-1'] }, ledger: { created: [], lists: [], tags: [] }, cleanup: { complete: false, entries: [] }, violations: [] };
      live.writePrivateJson(join(oldDir, 'report.json'), oldReport);
      assert.deepEqual(live.scanIncompleteReports(state), [], 'an unfinished v2 report does not block a run');
      live.acquireLock(state, { pid: process.pid, runId: 'v3' })();
      assert.throws(() => live.validateResumeReport(oldReport, join(oldDir, 'report.json'), { state }), e => e.code === 'cleanup_report_invalid');
      // The v2 run was killed (kill -9, OOM) with its lock in place. That lock
      // names the foreign report, which no --cleanup can take: a new run
      // removes the stale lock and names the report for a person to check.
      const lockPath = join(state, 'pbp-it-live.lock');
      writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, runId, reportPath: join(oldDir, 'report.json') }));
      const warned = [];
      const warn = console.warn;
      console.warn = (...args) => warned.push(args.join(' '));
      let release;
      try { release = live.acquireLock(state, { pid: process.pid, runId: 'v3-after-v2' }); } finally { console.warn = warn; }
      assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).runId, 'v3-after-v2', 'the stale lock of a foreign report is replaced');
      release();
      assert(warned.some(w => w.includes(join(oldDir, 'report.json'))), 'the foreign report is named: ' + warned.join(' | '));
      assert(existsSync(join(oldDir, 'report.json')), 'the foreign report itself is left as it was');
      // A run that frees such a lock says so in its own report and summary,
      // not only once on stderr (main-session ruling on H1b).
      writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, runId, reportPath: join(oldDir, 'report.json') }));
      const freed = await run(['--run', '--target', 'user', '--service', 'linkding', '--scenario', 'linkding.readonly', '--linkding', 'http://127.0.0.1:9', '--allow-dirty'], { credentials: false, state });
      assert.equal(freed.report.failure.code, 'credentials_path', freed.output);
      assert.deepEqual(freed.report.foreignLocks, [join(oldDir, 'report.json')]);
      // configure() records every module the run means to start, before any
      // later step can fail: the summary's "not run" list and --cleanup read
      // it back (review of H1c, should-fix 1).
      assert.deepEqual(freed.report.selected, ['linkding.readonly']);
      assert(readFileSync(join(freed.reportPath, '..', 'summary.zh.md'), 'utf8').includes('已释放外来版本的陈旧锁：' + join(oldDir, 'report.json')), 'named in the summary');
      rmSync(join(freed.reportPath, '..'), { recursive: true, force: true });
      // A lock whose report is this version and unfinished still blocks.
      const ownDir = join(state, 'pbp-it-' + randomUUID());
      mkdirSync(ownDir, { mode: 0o700 });
      live.writePrivateJson(join(ownDir, 'report.json'), { harness: live.HARNESS_VERSION, cleanup: { complete: false } });
      writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, runId: 'own', reportPath: join(ownDir, 'report.json') }));
      assert.throws(() => live.acquireLock(state, { pid: process.pid, runId: 'v3-blocked' }), e => e.code === 'previous_cleanup_incomplete');
      rmSync(lockPath);
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
      // Ledger tags are what cleanup deletes (H1b): each under the run's full
      // prefix, on a known instance, recorded by a write or a read-back.
      const ledgerTag = { instance: 'linkding', key: 'pbp-it-' + runId + '_a', id: '5', source: 'route', module: '' };
      validate(Object.assign(genuine(), { ledger: { ...genuine().ledger, tags: [ledgerTag, { ...ledgerTag, key: 'pbp-it-' + runId + '_b', id: '', source: 'read' }] } }), userValues);
      refused('user', r => { r.ledger.tags.push({ ...ledgerTag, key: 'personal' }); }, invalid);
      refused('user', r => { r.ledger.tags.push({ ...ledgerTag, key: 'pbp-it-' + randomUUID() + '_a' }); }, invalid);
      refused('user', r => { r.ledger.tags.push({ ...ledgerTag, instance: 'karakeep' }); }, invalid);
      refused('user', r => { r.ledger.tags.push({ ...ledgerTag, source: 'pool' }); }, invalid);
      refused('user', r => { r.ledger.tags.push({ ...ledgerTag, id: '../5' }); }, invalid);
      refused('user', r => { delete r.ledger.tags; }, invalid);
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
  }

  // ---------------------------------------------------------------------
  // Node API: a module reproducing a server failure names the status; it
  // gets the status back and nothing is recorded. Other failures throw.
  // The report on disk is redacted as a whole.
  // ---------------------------------------------------------------------
  if (only('node api')) {
    {
      const seen = [];
      const server = createServer((req, res) => {
        seen.push(req.method + ' ' + req.url);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>Server Error (500)</h1>');
      });
      const port = await listen(server);
      const run = new live.LiveRun({ mode: 'run' });
      // A temporary instance, as limits.long-tag runs on: the over-long tag
      // below would be refused on a user one (live_guard_long_tag_user).
      run.target = 'temp';
      const base = `http://127.0.0.1:${port}/`;
      run.instances.linkding = { id: 'linkding', service: 'linkding', base, root: live.apiRootFor('linkding', base), token: 'f'.repeat(40) };
      // Complete caps, as a run has them: a missing bookmark cap allows none.
      run.caps = { linkding: { ...live.BUDGETS.temp.linkding, node: 10 } };
      run.reserve = { linkding: 2 };
      run.pools.linkding = live.poolUrls('temp', run.runId, 'linkding', 2);
      const reproduced = await run.api('linkding', 'bookmarks/', { method: 'POST', body: { url: run.pools.linkding[0], tag_names: [run.prefix + '_' + 'x'.repeat(26)] }, allowStatus: [500] });
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
      // A seed naming a tag outside the run prefix is refused unsent (H1b).
      await assert.rejects(r.api('linkding', 'bookmarks/', { method: 'POST', body: { url: r.pools.linkding[0], tag_names: [p + '_a', 'personal'] } }), e => e.code === 'live_guard_foreign_tag' && e.fatal === true);
      assert.deepEqual([seen, r.report.ledger.tags, r.fatal], [[], [], 'live_guard_foreign_tag']);
      r.fatal = null;
      await r.api('linkding', 'bookmarks/', { method: 'POST', body: { url: r.pools.linkding[0], tag_names: [p + '_a'] } });
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
  if (only('linkding tag cleanup')) {
    for (const mode of ['legacy', 'expression']) {
      const run = new live.LiveRun({ mode: 'run' });
      const p = run.prefix;
      // 6 carries the run prefix but no write reserved it (not in the ledger),
      // 7 only a read-back found: both are residue, reported and never deleted
      // (H1b: a user instance loses only ledger tags).
      const tags = [{ id: 1, name: p + '_a' }, { id: 2, name: p + '_b' }, { id: 3, name: p.toUpperCase() + '_C' }, { id: 4, name: p + '_q"x' }, { id: 5, name: 'personal' }, { id: 6, name: p + '_stray' }, { id: 7, name: p + '_seen' }];
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
      run.report.ledger.tags.push(...[p + '_a', p + '_b', p + '_c', p + '_q"x'].map((key, i) => ({ instance: 'linkding', key, id: '', source: ['route', 'sw', 'node', 'route'][i], module: '' })),
        { instance: 'linkding', key: p + '_seen', id: '7', source: 'read', module: '' });
      assert.equal(await run.cleanupTags('linkding'), false, mode + ': referenced run tags fail the cleanup');
      assert.deepEqual(tags.map(t => t.id), [2, 3, 4, 5, 6, 7], mode + ': only the unreferenced ledger tag is deleted');
      assert.deepEqual(run.report.cleanup.entries.map(e => [e.id, e.deleted, e.code || '', !!e.residue]), [['1', true, '', false], ['2', false, 'cleanup_tag_referenced', false], ['3', false, 'cleanup_tag_referenced', false], ['4', false, 'cleanup_tag_unsearchable', false], ['6', false, 'residue_tag_not_in_ledger', true], ['7', false, 'residue_tag_unreserved', true]], mode);
      assert(!requests.some(r => r.startsWith('DELETE') && /\/(6|7)\/$/.test(r)) && !requests.some(r => r.includes('_stray') || r.includes('_seen')), mode + ': residue is neither searched nor deleted');
      const searches = requests.filter(r => r.includes(' q='));
      assert(searches.every(r => /^GET \/api\/bookmarks\/(archived\/)? q=#\S+$/.test(r)), mode + ': each search names one tag: ' + searches.join(' | '));
      assert(!searches.some(r => r.includes('personal')), 'only run tags are searched');
      assert(requests.length <= 2 + 4 * 4, mode + ': a tag costs at most two searches, a DELETE and a GET, on top of the sweep');
      assert(requests.length <= live.cleanupCost({ service: 'linkding', tags: 4 }), mode + ': cleanupCost covers the tag cleanup');
      await closeServer(server);
    }
  }

  // ---------------------------------------------------------------------
  // Karakeep tag cleanup (review of H1b, should-fix): a ledger tag is
  // deleted only while no bookmark refers to it (numBookmarks from
  // GET /api/v1/tags, Karakeep 0.34.1); a ledger tag still attached to a
  // bookmark is kept, and a run-prefix tag outside the ledger is residue,
  // never deleted.
  // ---------------------------------------------------------------------
  if (only('karakeep tag cleanup')) {
    {
      const run = new live.LiveRun({ mode: 'run' });
      const p = run.prefix;
      const kTag = (id, name, n) => ({ id, name, numBookmarks: n, numBookmarksByAttachedType: { ai: 0, human: n } });
      const tags = [kTag('ta', p + '_free', 0), kTag('tb', p + '_held', 1), kTag('tc', p + '_stray', 0), kTag('td', 'personal', 3)];
      const requests = [];
      const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        requests.push(req.method + ' ' + url.pathname);
        const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
        const tag = url.pathname.match(/^\/api\/v1\/tags\/([^/]+)$/);
        if (tag) {
          const at = tags.findIndex(t => t.id === tag[1]);
          if (at < 0) return json(404, { code: 'NOT_FOUND', message: 'Tag not found' });
          if (req.method === 'DELETE') { tags.splice(at, 1); res.writeHead(204); return res.end(); }
          return json(200, tags[at]);
        }
        if (url.pathname === '/api/v1/tags') return json(200, { tags, nextCursor: null });
        return json(404, { code: 'NOT_FOUND', message: 'Unknown fixture route' });
      });
      const port = await listen(server);
      const base = `http://127.0.0.1:${port}/`;
      run.instances.karakeep = { id: 'karakeep', service: 'karakeep', base, root: live.apiRootFor('karakeep', base), token: 'k'.repeat(40) };
      run.caps = { karakeep: { node: 100 } };
      run.reserve = { karakeep: 0 };
      run.cleaning = true;
      run.report.ledger.tags.push({ instance: 'karakeep', key: p + '_free', id: '', source: 'route', module: '' }, { instance: 'karakeep', key: p + '_held', id: 'tb', source: 'sw', module: '' });
      assert.equal(await run.cleanupTags('karakeep'), false, 'a referenced ledger tag and residue fail the cleanup');
      assert.deepEqual(tags.map(t => t.id), ['tb', 'tc', 'td'], 'only the unreferenced ledger tag is deleted');
      assert.deepEqual(requests.filter(r => r.startsWith('DELETE')), ['DELETE /api/v1/tags/ta']);
      assert.deepEqual(run.report.cleanup.entries.map(e => [e.id, e.deleted, e.code || '', !!e.residue]), [['ta', true, '', false], ['tb', false, 'cleanup_tag_referenced', false], ['tc', false, 'residue_tag_not_in_ledger', true]]);
      await closeServer(server);
    }

    // A fatal finding left by the previous module (a failed restore, a guard
    // violation between modules, the run timer) stops the run before the next
    // module starts: no record stays "running" to read as an interruption
    // (review of H1b r2). The modules selected but never started are listed
    // as not run, and the features they share stay unfinished, never passed
    // on the strength of another service's module.
    {
      const all = live.expandRegistry(MODULES);
      const fr = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      let swCalls = 0;
      fr.ctx = { pages: () => [] };
      fr.sw = async () => { swCalls++; return []; };
      fr.setFatal('module_restore_failed');
      await assert.rejects(fr.runModule(all.find(m => m.id === 'linkding.core.worker')), e => e.code === 'module_restore_failed' && e.fatal === true);
      assert.deepEqual([fr.report.modules, swCalls], [[], 0], 'refused before its record or any worker call');
      // A browser the run timer closed: the same, without a TypeError.
      const closed = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      closed.ctx = null;
      await assert.rejects(closed.runModule(all.find(m => m.id === 'linkding.core.worker')), e => e.code === 'browser_closed');
      assert.deepEqual(closed.report.modules, []);
      // A worker gone before the module's settings snapshot: the record it
      // just made is aborted with the cause, never left "running" to read as
      // an interruption (review of H1c, should-fix 1). The same call shows
      // the module's browser budget carrying its tag-list reads times the
      // extra pages the preflight measured (review of H1c, should-fix 2).
      const gone = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      const offline = all.find(m => m.id === 'linkding.edges.offline');
      const planned = live.resolveBudget(offline);
      assert(planned.tagReads > 0);
      gone.ctx = { pages: () => [] };
      gone.tagExtraPages = { linkding: 2 };
      let budgetSeen = null;
      gone.sw = async () => { budgetSeen = gone.currentModule?.budget.browser; throw new live.HarnessFailure('worker_gone'); };
      await assert.rejects(gone.runModule(offline), e => e.code === 'worker_gone');
      assert.equal(budgetSeen, planned.browser + planned.tagReads * 2, 'tag-list reads cost one request per extra page');
      assert.deepEqual(gone.report.modules.map(m => [m.id, m.status, m.failure?.code]), [['linkding.edges.offline', 'aborted', 'worker_gone']]);
      assert.equal(gone.currentModule, null);
      // The phase is the module's own, never the previous module's last step
      // left in phaseName, and the record says no step of it ran (review of
      // H1c round 2): its features are unfinished, not failed.
      const prev = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      const popupReader = all.find(m => m.id === 'linkding.core.popup-reader');
      prev.runDir = join(dir, 'summary-gone-before-steps');
      mkdirSync(prev.runDir, { mode: 0o700 });
      prev.reportPath = join(prev.runDir, 'report.json');
      prev.ctx = { pages: () => [] };
      prev.selected = [popupReader];
      prev.phaseName = 'readonly_popup';
      prev.sw = async () => { throw new live.HarnessFailure('worker_gone'); };
      await assert.rejects(prev.runModule(popupReader), e => e.code === 'worker_gone');
      const goneRec = prev.report.modules[0];
      assert.equal(goneRec.failure.phase, popupReader.id, 'the module\'s own phase, not readonly_popup');
      assert.equal(goneRec.beforeSteps, true);
      Object.assign(prev.report, { target: 'temp', selected: [popupReader.id], failure: goneRec.failure, instances: { linkding: { service: 'linkding', base: 'http://127.0.0.1:9/' } } });
      prev.writeSummary();
      const goneText = readFileSync(join(prev.runDir, 'summary.zh.md'), 'utf8');
      assert(!goneText.includes('readonly_popup'), goneText);
      assert(!/^- 未通过 /m.test(goneText), 'no feature failed on a module that ran no step: ' + goneText);
      // A feature named after another service is not this module's.
      for (const f of popupReader.features.filter(f => !/^(pinboard|karakeep)-/.test(f))) assert.match(goneText, new RegExp('未完成（[^\\n]*：[^\\n]*' + f), goneText);
      assert.match(goneText, /linkding\.core\.popup-reader：[^\n]*未执行任何步骤[^\n]*worker_gone/, goneText);

      const run = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      run.runDir = join(dir, 'summary-not-started');
      mkdirSync(run.runDir, { mode: 0o700 });
      run.reportPath = join(run.runDir, 'report.json');
      const chosen = ['linkding.core.popup-reader', 'linkding.core.worker', 'karakeep.core.popup-reader', 'karakeep.core.worker'];
      run.selected = all.filter(m => chosen.includes(m.id));
      const r = run.report;
      Object.assign(r, { target: 'user', selected: chosen, failure: { phase: 'linkding.core.worker', code: 'module_restore_failed' }, instances: { linkding: { service: 'linkding', base: 'http://127.0.0.1:9/' }, karakeep: { service: 'karakeep', base: 'http://127.0.0.1:9/' } } });
      r.modules.push({ id: 'linkding.core.popup-reader', status: 'passed', notes: {}, counts: {} }, { id: 'linkding.core.worker', status: 'passed', notes: {}, counts: {} });
      run.writeSummary();
      const text = readFileSync(join(run.runDir, 'summary.zh.md'), 'utf8');
      assert.match(text, /未执行（2[^\n]*）：karakeep\.core\.popup-reader，karakeep\.core\.worker/, text);
      assert(!text.includes('无模块失败'), text);
      const passedLine = text.split('\n').find(l => l.startsWith('- 通过')) || '';
      for (const f of ['popup-save', 'reader-edit', 'worker-create']) {
        assert(!passedLine.includes(f), f + ' is not passed while the Karakeep module never ran: ' + text);
        assert.match(text, new RegExp('未完成（[^\\n]*：[^\\n]*' + f), text);
      }
      // linkding-description belongs to linkding alone: its module passed.
      assert(passedLine.includes('linkding-description'), text);
    }
  }

  // ---------------------------------------------------------------------
  // Summary cap (review of H1b, should-fix 5): with many failures the
  // one-screen summary is cut, but never its cleanup section, which tells
  // a person what to remove by hand.
  // ---------------------------------------------------------------------
  if (only('summary')) {
    // worktree_dirty / ext_root_dirty: the summary names which check failed,
    // since git status can look clean (an ignored loadable file, an ignored
    // subdirectory) and the code alone does not say why.
    {
      const run = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      run.runDir = join(dir, 'summary-dirty');
      mkdirSync(run.runDir, { mode: 0o700 });
      run.reportPath = join(run.runDir, 'report.json');
      Object.assign(run.report, { target: 'user', head: 'a'.repeat(40), clean: false, cleanReason: 'ignored_product_files', failure: { phase: 'preflight', code: 'worktree_dirty' } });
      run.writeSummary();
      assert.match(readFileSync(join(run.runDir, 'summary.zh.md'), 'utf8'), /工作区干净：否（ignored_product_files）/);
      Object.assign(run.report, { clean: true, cleanReason: '', extRoot: join(dir, 'elsewhere') + '/', productHead: 'b'.repeat(40), productClean: false, productReason: 'not_toplevel', failure: { phase: 'preflight', code: 'ext_root_dirty' } });
      run.writeSummary();
      const text = readFileSync(join(run.runDir, 'summary.zh.md'), 'utf8');
      assert.match(text, /工作区干净：是；产品 HEAD bbbbbbbbbbbb（--ext-root，不干净：not_toplevel）/, text);
    }
    {
      const run = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      run.runDir = join(dir, 'summary-cap');
      mkdirSync(run.runDir, { mode: 0o700 });
      run.reportPath = join(run.runDir, 'report.json');
      const r = run.report;
      Object.assign(r, { target: 'user', instances: { linkding: { service: 'linkding', base: 'http://127.0.0.1:9/' }, karakeep: { service: 'karakeep', base: 'http://127.0.0.1:9/' } } });
      const failedIds = ['linkding.core.worker', 'linkding.core.popup-reader', 'karakeep.core.worker', 'karakeep.core.popup-reader', 'linkding.edges.offline', 'karakeep.edges.tags'];
      run.selected = live.expandRegistry(MODULES).filter(m => failedIds.includes(m.id));
      for (const id of failedIds) r.modules.push({ id, status: 'failed', failure: { phase: id, code: 'read_back_mismatch' }, notes: { observed: 'x'.repeat(40) }, counts: {} });
      r.violations.push({ code: 'live_guard_mutation', phase: 'karakeep.core.worker' });
      r.blockedOrigins.push('https://blocked.example');
      r.blockedSamples.push({ sample: 'https://blocked.example/a', module: 'karakeep.core.worker', where: 'fetch' });
      r.cleanup.passStart = 0;
      r.cleanup.entries.push({ kind: 'tag', instance: 'karakeep', id: 'abc', deleted: false, residue: true, code: 'residue_tag_not_in_ledger' });
      run.writeSummary();
      const text = readFileSync(join(run.runDir, 'summary.zh.md'), 'utf8');
      const lines = text.trimEnd().split('\n');
      assert(lines.length <= live.SUMMARY_MAX_LINES, 'one screen: ' + lines.length);
      assert(text.includes('摘要已截断'), 'this summary does not fit: ' + text);
      for (const want of ['## 清理', '清理完成：否', '残留 1 项', '未清理：tag karakeep abc residue_tag_not_in_ledger', '完整报告：' + run.reportPath]) assert(text.includes(want), want + ' kept: ' + text);
      // Low-priority sections go before the failures and the verdicts.
      assert(text.includes('linkding.edges.offline：失败') && text.includes('## 在修项结论'), text);
      assert(!text.includes('## 观察记录'), 'observations are dropped first: ' + text);
    }
    // Read-back diffs are folded onto one line like observations (review of
    // H1b r2): a multi-line expected value (a blockquote with "# Heading")
    // must neither break the one-screen cap counted in physical lines nor
    // add a heading to the summary.
    {
      const run = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      run.runDir = join(dir, 'summary-multiline');
      mkdirSync(run.runDir, { mode: 0o700 });
      run.reportPath = join(run.runDir, 'report.json');
      const r = run.report;
      Object.assign(r, { target: 'user', instances: { pinboard: { service: 'pinboard', base: '' } } });
      const failedIds = ['linkding.core.worker', 'linkding.core.popup-reader', 'karakeep.core.worker', 'karakeep.core.popup-reader', 'linkding.edges.offline'];
      run.selected = live.expandRegistry(MODULES).filter(m => failedIds.includes(m.id));
      const quote = '> First line\n>\n> # Heading\n> **bold** <tag>\n> 1. item\n\n# Heading\n';
      for (const id of failedIds) {
        r.modules.push({ id, status: 'failed', failure: { phase: id, code: 'quick_save_quote_format' }, notes: {}, counts: {} });
        r.readBackDiffs.push({ module: id, phase: id, code: 'quick_save_quote_format', expected: quote, actual: quote.replace('First', 'Second') });
      }
      r.cleanup.passStart = 0;
      r.cleanup.entries.push({ kind: 'tag', instance: 'karakeep', id: 'abc', name: 'pbp-it-x_stray', deleted: false, residue: true, code: 'residue_tag_not_in_ledger' });
      run.writeSummary();
      const text = readFileSync(join(run.runDir, 'summary.zh.md'), 'utf8');
      const lines = text.trimEnd().split('\n');
      assert(lines.length <= live.SUMMARY_MAX_LINES, 'one screen in physical lines: ' + lines.length);
      assert.equal(lines.filter(l => l.startsWith('# ')).length, 1, 'only the title is a heading: ' + text);
      assert(lines.some(l => l.includes('quick_save_quote_format：期望 > First line > > # Heading')), text);
      assert(lines.every(l => l.length <= 400), 'snippets are cut short');
    }
    // Karakeep has no tag count: the preflight pages through, counting rows
    // only, and stops as soon as it has passed what the plan can take.
    {
      const kTagRequests = [];
      const kServer = createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        kTagRequests.push(url.pathname + (url.searchParams.get('cursor') ? '?cursor' : ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const n = kTagRequests.length;
        res.end(JSON.stringify({ tags: Array.from({ length: 1000 }, (_, i) => ({ id: 't' + n + '-' + i, name: 'tag' + i, numBookmarks: 1, numBookmarksByAttachedType: { ai: 0, human: 1 } })), nextCursor: 'c' + n }));
      });
      const kPort = await listen(kServer);
      const kBase = `http://127.0.0.1:${kPort}/`;
      const kRun = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      const { selected, skipped } = live.selectModules('karakeep.readonly,karakeep.core.*,karakeep.edges.*,karakeep.ai.*', { target: 'user' });
      kRun.target = 'user';
      kRun.plan = live.buildPlan({ target: 'user', selected, skipped });
      kRun.instances.karakeep = { id: 'karakeep', service: 'karakeep', base: kBase, root: live.apiRootFor('karakeep', kBase), token: 'k'.repeat(40) };
      kRun.caps = { karakeep: live.BUDGETS.user.karakeep };
      kRun.reserve = { karakeep: kRun.plan.budget.karakeep.cleanupReserve };
      const most = kRun.plan.budget.karakeep.tagPages.maxPagesWithinCaps;
      await assert.rejects(kRun.checkTagPages('karakeep'), e => e.code === 'tag_pages_over_budget');
      assert.equal(kTagRequests.length, most + 1, 'stops one page past the maximum');
      assert.deepEqual([kRun.report.tagPages.karakeep.complete, kRun.report.tagPages.karakeep.tags, kRun.report.tagPages.karakeep.ok], [false, 1000 * (most + 1), false]);
      assert(!JSON.stringify(kRun.report.tagPages).includes('tag1'), 'no tag name is kept');
      await closeServer(kServer);
    }
    // A linkding library within the caps (250 tags, three pages): the run
    // keeps going with the cleanup reserve api() enforces and the extra pages
    // runModule charges recomputed for the pages counted (review of H1c,
    // should-fix 2).
    {
      const lServer = createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: 250, next: null, previous: null, results: [] }));
      });
      const lPort = await listen(lServer);
      const lBase = `http://127.0.0.1:${lPort}/`;
      const lRun = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      const { selected, skipped } = live.selectModules('linkding.readonly,linkding.core.*,linkding.edges.*,linkding.ai.*', { target: 'user' });
      lRun.target = 'user';
      lRun.plan = live.buildPlan({ target: 'user', selected, skipped });
      lRun.instances.linkding = { id: 'linkding', service: 'linkding', base: lBase, root: live.apiRootFor('linkding', lBase), token: 'l'.repeat(40) };
      lRun.caps = { linkding: live.BUDGETS.user.linkding };
      const row = lRun.plan.budget.linkding;
      lRun.reserve = { linkding: row.cleanupReserve };
      await lRun.checkTagPages('linkding');
      const expected = live.tagPageBudget(row, 3);
      assert(expected.ok && expected.cleanupReserve !== row.cleanupReserve, 'three pages change the reserve');
      assert.equal(lRun.reserve.linkding, expected.cleanupReserve);
      assert.deepEqual(lRun.tagExtraPages, { linkding: 2 });
      assert.deepEqual([lRun.report.tagPages.linkding.pages, lRun.report.tagPages.linkding.ok], [3, true]);
      await closeServer(lServer);
    }

    // Review of H1b r2, notes: a failed feature names its failed modules and
    // its interrupted ones apart; a run with no stage says nothing of stage
    // times; residue names each tag and why it is residue (an id the ledger
    // holds differently, a tag the ledger lacks, one only a read-back found);
    // a skipped snapshot module keeps its note in the summary.
    {
      const tagRequests = [];
      const tRun = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      const p = tRun.prefix;
      const tServer = createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        tagRequests.push(req.method + ' ' + url.pathname);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (url.pathname === '/api/tags/') return res.end(JSON.stringify({ count: 3, next: null, previous: null, results: [{ id: 5, name: p + '_moved', date_added: '2026-11-01T00:00:00Z' }, { id: 6, name: p + '_stray', date_added: '2026-11-01T00:00:00Z' }, { id: 7, name: p + '_seen', date_added: '2026-11-01T00:00:00Z' }] }));
        res.end(JSON.stringify({ count: 0, next: null, previous: null, results: [] }));
      });
      const tPort = await listen(tServer);
      const tBase = `http://127.0.0.1:${tPort}/`;
      tRun.runDir = join(dir, 'summary-notes');
      mkdirSync(tRun.runDir, { mode: 0o700 });
      tRun.reportPath = join(tRun.runDir, 'report.json');
      tRun.target = 'user';
      tRun.cleaning = true;
      tRun.instances.linkding = { id: 'linkding', service: 'linkding', base: tBase, root: live.apiRootFor('linkding', tBase), token: 'f'.repeat(40) };
      tRun.caps = { linkding: live.BUDGETS.user.linkding };
      tRun.reserve = { linkding: 60 };
      tRun.report.ledger.tags.push({ instance: 'linkding', key: p + '_moved', id: '99', source: 'route', module: '' }, { instance: 'linkding', key: p + '_seen', id: '7', source: 'read', module: '' });
      assert.equal(await tRun.cleanupTags('linkding'), false);
      assert.deepEqual(tagRequests.filter(q => !q.startsWith('GET')), [], 'no residue is deleted');
      assert.deepEqual(tRun.report.cleanup.entries.map(e => [e.id, e.name, e.code]), [['5', p + '_moved', 'residue_tag_id_mismatch'], ['6', p + '_stray', 'residue_tag_not_in_ledger'], ['7', p + '_seen', 'residue_tag_unreserved']]);
      await closeServer(tServer);
      const r = tRun.report;
      r.target = 'user';
      r.instances = { linkding: { service: 'linkding', base: tBase } };
      r.cleanup.passStart = 0;
      const chosen = ['linkding.readonly', 'linkding.core.worker'];
      tRun.selected = live.expandRegistry(MODULES).filter(m => chosen.includes(m.id));
      r.selected = chosen;
      r.modules.push({ id: 'linkding.readonly', status: 'failed', failure: { phase: 'linkding.readonly', code: 'read_back_mismatch' }, notes: {}, counts: {} }, { id: 'linkding.core.worker', status: 'running', notes: {}, counts: {} });
      r.skipped = live.selectModules('core', { target: 'user' }).skipped;
      assert(r.skipped.some(x => x.reason === 'snapshot_setting_unreadable'));
      tRun.writeSummary();
      const text = readFileSync(join(tRun.runDir, 'summary.zh.md'), 'utf8');
      assert(text.includes('- 未通过 tags-recent：linkding.readonly（另有中断：linkding.core.worker）'), text);
      assert(text.includes('耗时分类：未统计（运行未正常结束）') && !text.includes('见上方阶段耗时'), text);
      for (const want of ['账本里同名标签的 id 与服务上的不一致', '带本轮前缀但不在账本里的标签', '只在读回时发现、未经写入预留的标签', p + '_moved', p + '_stray', p + '_seen']) assert(text.includes(want), want + ': ' + text);
      assert(text.includes(live.SNAPSHOT_SKIP_NOTE('linkding.core.snapshot')), 'the snapshot skip keeps its note: ' + text);
    }
  }

  // ---------------------------------------------------------------------
  // Fake AI: product prompts classify, replies parse with product parsers
  // ---------------------------------------------------------------------
  if (only('fake ai')) {
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
    // A reply suggesting a tag outside the run prefix is refused (H1b): when
    // queued as text at once, from a function when it is asked for.
    assert.throws(() => fake.expect({ kind: 'tags', reply: '["' + prefix + '_ok", "personal"]' }), e => e.code === 'fake_ai_foreign_tag');
    assert.throws(() => fake.expect({ kind: 'combined', reply: JSON.stringify({ summary: 's', tags: ['other'] }) }), e => e.code === 'fake_ai_foreign_tag');
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
    const foreignAi = await live.startFakeAi({ prefix, limit: 2 });
    foreignAi.expect({ kind: 'tags', reply: () => '["' + prefix + '_ok", "personal"]' });
    const foreignReply = await httpCall({ port: foreignAi.port, headers: { Authorization: 'Bearer ' + foreignAi.key }, body: { model: 'm', messages: [{ role: 'user', content: product.tags }] } });
    assert.deepEqual([foreignReply.status, foreignAi.failed(), foreignAi.calls()], [503, 'fake_ai_foreign_tag', 0], 'a computed foreign tag reply is refused and fails the run');
    await foreignAi.close();
  }

  // ---------------------------------------------------------------------
  // Docker: names, refusals, and the temp lifecycle with a fake executor
  // ---------------------------------------------------------------------
  if (only('docker fake executor')) {
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

    // healthyAt: both health routes answer "starting" until then.
    let healthyAt = 0;
    const linkdingHealth = createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: Date.now() < healthyAt ? 'starting' : 'healthy' })); });
    const karakeepHealth = createServer((req, res) => { res.writeHead(req.url === '/api/health' ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: Date.now() < healthyAt ? 'starting' : 'ok', message: 'Web app is working' })); });
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
      // The two health waits run side by side: they count once on the wall
      // clock in temp_start and the run's totals, never more than the stage
      // lasted; their plain sum stays in report.temp.timing.waitSumMs.
      healthyAt = Date.now() + 1500;
      const docker = fakeDocker({ token: 'PBPSNAPSHOTS=False\nPBPTOKEN=' + 'a'.repeat(40) });
      const { report } = await tempRun('parallel-waits', docker);
      healthyAt = 0;
      const stage = report.stages.find(st => st.name === 'temp_start');
      const t = report.temp.timing;
      assert(t['health:linkding'] >= 1000 && t['health:karakeep'] >= 1000, JSON.stringify(t));
      assert(t.waitSumMs > stage.ms, 'the waits overlapped: ' + JSON.stringify({ t, ms: stage.ms }));
      assert(stage.waitMs <= stage.ms && t.waitMs === stage.waitMs, 'temp_start waits on the wall clock: ' + JSON.stringify({ wait: stage.waitMs, ms: stage.ms }));
      assert(report.timing.totals.waitMs <= stage.ms, 'the run total counts them once');
      assert(readFileSync(join(stateDirFor('parallel-waits'), 'pbp-it-' + report.runId, 'summary.zh.md'), 'utf8').includes('墙钟'), 'the summary names the measure');
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
  }

  // ---------------------------------------------------------------------
  // Signals during a temporary run (real signals, scripted Docker executor)
  // ---------------------------------------------------------------------
  if (only('signals')) {
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
      // Two services start side by side (E25): a signal or a failure in one
      // branch while the other's `docker run` is in flight. Each time only
      // teardown reaches Docker afterwards, the in-flight command settles
      // before anything is removed, every recorded name is removed (the one
      // being created too) and no env file is left.
      const both = ['--run', '--target', 'temp', '--scenario', 'linkding.readonly,karakeep.readonly', '--service', 'linkding,karakeep', '--allow-dirty'];
      const interleaved = async (name, { holds, signals = [], held, expect }) => {
        const r = await dockerChildRun({ state: stateDirFor(name), args: both, holds, signals });
        assert.deepEqual([r.code, r.report.failure.code], expect, name + ': ' + r.output);
        const begun = signals.length ? r.lines.indexOf('signal\tSIGINT') : r.lines.findIndex(l => l.startsWith('start\tlogs'));
        assert(begun > 0, name + ': the trigger is in the log');
        const settled = r.lines.indexOf('done\t' + held), removal = r.lines.findIndex(l => l.startsWith('start\trm\t'));
        assert(settled > begun && removal > settled, name + ': the held command settles before anything is removed');
        const later = r.lines.slice(settled + 1).filter(l => l.startsWith('start\t')).map(l => l.split('\t')[1]);
        assert(later.every(key => teardown.includes(key)), name + ': only teardown after the cleanup began: ' + later.join(', '));
        const removed = r.lines.filter(l => l.startsWith('start\trm\t')).flatMap(l => JSON.parse(l.split('\t')[2]).slice(3));
        const own = live.tempNames(r.report.runId);
        assert(r.report.temp.names.includes(own[held.split(':')[1]]), name + ': the held container is on record');
        assert.deepEqual(removed.sort(), [...r.report.temp.names].sort(), name + ': every recorded name is removed');
        assert.deepEqual([r.report.temp.removed, r.report.cleanup.complete], [true, true], name);
        assert(!readdirSync(join(r.reportPath, '..')).some(n => n.startsWith('env-')), name + ': no env file is left');
        return r;
      };
      await interleaved('signal-two-services', { holds: { 'run:karakeep': 1500 }, signals: ['start\trun:karakeep\t'], held: 'run:karakeep', expect: [130, 'interrupted_sigint'] });
      const kExit = await interleaved('linkding-exits', { holds: { 'run:karakeep': 3000, __states: { linkding: 'exited 1' } }, held: 'run:karakeep', expect: [1, 'container_start_failed'] });
      assert(!kExit.lines.some(l => l.startsWith('start\trun:karakeep-fixture')), 'the fixture of a branch still starting is never created');
      const lExit = await interleaved('karakeep-exits', { holds: { 'run:linkding-fixture': 3000, __states: { karakeep: 'exited 1' } }, held: 'run:linkding-fixture', expect: [1, 'container_start_failed'] });
      assert(lExit.report.temp.names.includes(live.tempNames(lExit.report.runId)['linkding-fixture']));
      // A forced exit (second signal) while run:karakeep is in flight: the
      // name was recorded before the command, so --cleanup removes it.
      const state = stateDirFor('force-two-services');
      const forced = await dockerChildRun({ state, args: both, holds: { 'run:karakeep': 3000 }, signals: ['start\trun:karakeep\t', 'signal\tSIGINT'] });
      assert.deepEqual([forced.code, forced.report.cleanup.complete], [130, false], forced.output);
      const own = live.tempNames(forced.report.runId);
      assert(forced.report.temp.names.includes(own.karakeep), 'the container being created is on record before its command');
      const resumed = await dockerChildRun({ state, args: ['--cleanup', forced.reportPath] });
      assert.equal(resumed.code, 0, resumed.output);
      const removed = resumed.lines.filter(l => l.startsWith('start\trm\t')).flatMap(l => JSON.parse(l.split('\t')[2]).slice(3));
      assert(removed.includes(own.karakeep) && resumed.lines.every(l => !l.startsWith('start\t') || teardown.includes(l.split('\t')[1])), 'the resume removes it by name and only tears down');
      assert(!readdirSync(join(forced.reportPath, '..')).some(n => n.startsWith('env-')), 'no env file is left');
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
      // Docker unavailable on a later --cleanup (main-session ruling on H1b):
      // the terminal and the summary name the code, not only "complete: false".
      const before = process.env.PBP_LIVE_STATE_DIR;
      process.env.PBP_LIVE_STATE_DIR = state;
      const out = [];
      const { log, error } = console;
      console.log = (...a) => out.push(a.join(' '));
      console.error = (...a) => out.push(a.join(' '));
      let code;
      try { code = await live.main(['--cleanup', join(state, 'pbp-it-' + id, 'report.json')], { dockerExec: async () => ({ code: 127, stdout: '', stderr: 'docker_unavailable' }) }); }
      finally { console.log = log; console.error = error; if (before === undefined) delete process.env.PBP_LIVE_STATE_DIR; else process.env.PBP_LIVE_STATE_DIR = before; }
      assert.equal(code, 1, out.join('\n'));
      assert(out.includes('Not cleaned: temp docker_ps_failed'), out.join('\n'));
      assert(readFileSync(join(state, 'pbp-it-' + id, 'summary.zh.md'), 'utf8').includes('未清理：temp docker_ps_failed'));
    }
  }

  // ---------------------------------------------------------------------
  // Screenshot canary on a plain page (no extension, no network)
  // ---------------------------------------------------------------------
  if (only('screenshot canary')) {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ viewport: { width: 420, height: 600 } });
    const shotsDir = join(dir, 'shots');
    mkdirSync(shotsDir, { mode: 0o700 });
    const shoot = async (html, name) => {
      await page.setContent('<!doctype html><title>Shot</title><body style="margin:0">' + html + '</body>');
      const file = join(shotsDir, name + '.png');
      return { file, result: await live.takeShot(page, { file, secrets: [syntheticKey], keys: ['#save'] }) };
    };
    // capture: false measures without a picture, and still refuses a
    // revealed secret.
    {
      await page.setContent('<!doctype html><title>Shot</title><body style="margin:0"><button id="save">Save</button></body>');
      const file = join(shotsDir, 'geometry-only.png');
      const result = await live.takeShot(page, { file, secrets: [syntheticKey], keys: ['#save'], capture: false });
      assert.equal(result.ok, true);
      assert.equal(result.geometry.ok, true);
      assert.equal(existsSync(file), false, 'no picture written');
      await page.setContent(`<!doctype html><title>Shot</title><body><input type="text" id="opt-linkding-token" value="${syntheticKey}"></body>`);
      const revealed = await live.takeShot(page, { file, secrets: [syntheticKey], keys: [], capture: false });
      assert.equal(revealed.ok, false, 'a revealed secret field is refused without a picture too');
      assert.equal(existsSync(file), false);
    }
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
  }

  // ---------------------------------------------------------------------
  // Spawned CLI: plan, list, gates (credential file and fetch blocked)
  // ---------------------------------------------------------------------
  if (only('spawned cli')) {
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
    // --ext-root (H3a): the browser loads another worktree's extension. The
    // report keeps this harness's HEAD and the product's apart; a product
    // tree that is not clean is refused before any credential, round or
    // request (--allow-dirty covers only the harness's own tree).
    {
      const ext = join(dir, 'ext-root');
      mkdirSync(ext);
      writeFileSync(join(ext, 'manifest.json'), '{}\n');
      const git = (...args) => spawnSync('git', ['-C', ext, '-c', 'user.name=pbp', '-c', 'user.email=pbp@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
      git('init', '-q');
      git('add', 'manifest.json');
      git('commit', '-q', '-m', 'synthetic product');
      const productHead = git('rev-parse', 'HEAD').stdout.trim();
      assert.match(productHead, /^[0-9a-f]{40}$/);
      const extState = stateDirFor('ext-root');
      const extArgs = ['--run', '--target', 'user', '--read-only', '--service', 'linkding', '--linkding', 'http://127.0.0.1:9', '--allow-dirty', '--ext-root', ext];
      const clean = await run(extArgs, { credentials: false, state: extState });
      assert.equal(clean.report.failure.code, 'credentials_path', clean.output);
      assert.equal(clean.report.extRoot, realpathSync(ext) + '/');
      assert.equal(clean.report.productHead, productHead);
      assert.equal(clean.report.productClean, true);
      assert.equal(clean.report.productReason, '');
      assert.equal(typeof clean.report.cleanReason, 'string', 'the harness tree records why it is not clean');
      assert.match(clean.report.head, /^[0-9a-f]{40}$/);
      assert.notEqual(clean.report.head, productHead);
      assert(readFileSync(join(clean.reportPath, '..', 'summary.zh.md'), 'utf8').includes('产品 HEAD ' + productHead.slice(0, 12)));
      writeFileSync(join(ext, 'popup.js'), '// uncommitted\n');
      const dirty = await run(extArgs, { credentials: false, state: extState });
      assert.equal(dirty.code, 1);
      assert.equal(dirty.report.failure.code, 'ext_root_dirty');
      assert.equal(dirty.report.productClean, false);
      assert.equal(dirty.report.productReason, 'uncommitted');
      assert(readFileSync(join(dirty.reportPath, '..', 'summary.zh.md'), 'utf8').includes('uncommitted'), 'the summary names why the product tree was refused');
      assert.equal(dirty.report.authorization, undefined, 'no round claimed');
      // A directory git ignores inside a clean tree is not that tree: it
      // holds files of no commit (say an unpacked release ZIP), so it is
      // refused and never reported under the outer HEAD. An ignored file
      // the extension would load is refused too; other ignored files are not.
      rmSync(join(ext, 'popup.js'));
      writeFileSync(join(ext, '.gitignore'), 'release/\nlocal-*.js\nnode_modules/\n');
      git('add', '.gitignore');
      git('commit', '-q', '-m', 'ignore build output');
      mkdirSync(join(ext, 'node_modules'));
      writeFileSync(join(ext, 'node_modules', 'x.js'), '// tooling\n');
      assert.deepEqual(live.gitState(realpathSync(ext) + '/'), { head: git('rev-parse', 'HEAD').stdout.trim(), clean: true, reason: '' }, 'ignored tooling outside the product stays clean');
      mkdirSync(join(ext, 'release', 'unpacked'), { recursive: true });
      writeFileSync(join(ext, 'release', 'unpacked', 'manifest.json'), '{}\n');
      writeFileSync(join(ext, 'release', 'unpacked', 'background.js'), '// edited copy\n');
      const nested = live.gitState(realpathSync(join(ext, 'release', 'unpacked')) + '/');
      assert.deepEqual([nested.clean, nested.reason], [false, 'not_toplevel']);
      const ignoredDir = await run([...extArgs.slice(0, -1), join(ext, 'release', 'unpacked')], { credentials: false, state: extState });
      assert.equal(ignoredDir.report.failure.code, 'ext_root_dirty', ignoredDir.output);
      assert.equal(ignoredDir.report.productClean, false);
      assert.equal(ignoredDir.report.productReason, 'not_toplevel');
      assert(readFileSync(join(ignoredDir.reportPath, '..', 'summary.zh.md'), 'utf8').includes('not_toplevel'));
      writeFileSync(join(ext, 'local-debug.js'), '// ignored but loadable\n');
      assert.deepEqual([live.gitState(realpathSync(ext) + '/').clean, live.gitState(realpathSync(ext) + '/').reason], [false, 'ignored_product_files']);
      // status.showUntrackedFiles=no hides untracked and ignored files from
      // a plain git status; the check must not depend on that setting.
      git('config', 'status.showUntrackedFiles', 'no');
      assert.deepEqual([live.gitState(realpathSync(ext) + '/').clean, live.gitState(realpathSync(ext) + '/').reason], [false, 'ignored_product_files'], 'showUntrackedFiles=no still sees ignored product files');
      const ignoredFile = await run(extArgs, { credentials: false, state: extState });
      assert.deepEqual([ignoredFile.report.failure.code, ignoredFile.report.productReason], ['ext_root_dirty', 'ignored_product_files'], ignoredFile.output);
      rmSync(join(ext, 'local-debug.js'));
      writeFileSync(join(ext, 'other.js'), '// untracked\n');
      assert.deepEqual([live.gitState(realpathSync(ext) + '/').clean, live.gitState(realpathSync(ext) + '/').reason], [false, 'uncommitted'], 'showUntrackedFiles=no still sees untracked files');
      rmSync(join(ext, 'other.js'));
      git('config', '--unset', 'status.showUntrackedFiles');
      // manifest.json itself untracked (ignored) in a clean tree.
      const loose = join(dir, 'ext-loose');
      mkdirSync(loose);
      spawnSync('git', ['-C', loose, 'init', '-q']);
      writeFileSync(join(loose, '.gitignore'), 'manifest.json\n');
      writeFileSync(join(loose, 'manifest.json'), '{}\n');
      spawnSync('git', ['-C', loose, '-c', 'user.name=pbp', '-c', 'user.email=pbp@example.invalid', '-c', 'commit.gpgsign=false', 'add', '.gitignore']);
      spawnSync('git', ['-C', loose, '-c', 'user.name=pbp', '-c', 'user.email=pbp@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'x']);
      assert.equal(live.gitState(realpathSync(loose) + '/').clean, false, 'an untracked manifest is not a commit');
      const missing = await run([...extArgs.slice(0, -1), join(dir, 'no-such-tree')], { credentials: false, state: extState });
      assert.equal(missing.report.failure.code, 'ext_root_invalid');
      const extPlan = JSON.parse((await run(['--plan', '--ext-root', ext], { credentials: false })).output);
      assert.equal(extPlan.extRoot, realpathSync(ext) + '/');
      assert.equal(JSON.parse((await run(['--plan'], { credentials: false })).output).extRoot, root);
    }

    // --rerun-failed (E7): only what did not pass, on the report's own target
    // and services; refused until that report's cleanup is complete. A
    // skipped module was never meant to run; one never started was.
    {
      const sourceId = randomUUID();
      const source = {
        harness: live.HARNESS_VERSION, runId: sourceId, target: 'user', scenario: 'core,edges',
        instances: { linkding: { service: 'linkding', base: 'http://127.0.0.1:9/' }, karakeep: { service: 'karakeep', base: 'http://127.0.0.1:10/' } },
        selected: ['linkding.core.popup-reader', 'linkding.core.worker', 'linkding.edges.offline', 'karakeep.core.worker', 'karakeep.edges.tags'],
        skipped: [{ id: 'karakeep.edges.tags', reason: 'pinboard_token_missing' }],
        modules: [{ id: 'linkding.core.popup-reader', status: 'passed' }, { id: 'linkding.core.worker', status: 'failed' }, { id: 'karakeep.core.worker', status: 'interrupted' }],
        cleanup: { complete: true, entries: [] },
      };
      const ids = live.rerunSource(source).ids;
      assert.deepEqual(ids, ['linkding.core.worker', 'karakeep.core.worker', 'linkding.edges.offline']);
      assert.throws(() => live.rerunSource({ ...source, cleanup: { complete: false, entries: [] } }), e => e.code === 'rerun_source_cleanup_incomplete');
      assert.throws(() => live.rerunSource({ ...source, modules: source.modules.map(m => ({ ...m, status: 'passed' })), selected: source.modules.map(m => m.id) }), e => e.code === 'rerun_nothing_failed');
      assert.throws(() => live.rerunSource(source, { target: 'temp' }), e => e.code === 'rerun_target_mismatch');
      assert.throws(() => live.rerunSource(source, { linkding: 'http://127.0.0.1:11' }), e => e.code === 'rerun_base_mismatch');
      assert.throws(() => live.rerunSource({ ...source, harness: live.HARNESS_VERSION - 1 }), e => e.code === 'rerun_report_invalid');
      const sel = live.resolveSelection({ values: { 'rerun-failed': 'x' }, flags: new Set() }, { readReport: () => source });
      assert.deepEqual([sel.target, sel.services, sel.selected.map(m => m.id)], ['user', ['linkding', 'karakeep'], ['linkding.core.worker', 'linkding.edges.offline', 'karakeep.core.worker']]);
      assert.deepEqual(sel.rerunOf, { runId: sourceId, modules: ids });
      for (const extra of [{ scenario: 'core' }, { service: 'linkding' }]) assert.throws(() => live.resolveSelection({ values: { 'rerun-failed': 'x', ...extra }, flags: new Set() }, { readReport: () => source }), e => e.code === 'rerun_conflict');
      const sourcePath = join(dir, 'rerun-source.json');
      writeFileSync(sourcePath, JSON.stringify(source));
      const rerunPlan = await run(['--plan', '--rerun-failed', sourcePath, '--linkding', 'http://127.0.0.1:9', '--karakeep', 'http://127.0.0.1:10'], { credentials: false });
      const rp = JSON.parse(rerunPlan.output);
      assert.deepEqual([rp.target, rp.modules.map(m => m.id), rp.rerunOf.runId], ['user', sel.selected.map(m => m.id), sourceId]);
      // The new run names its source; nothing else is read or sent.
      const rerunState = stateDirFor('rerun');
      const rerun = await run(['--run', '--rerun-failed', sourcePath, '--target', 'user', '--linkding', 'http://127.0.0.1:9', '--karakeep', 'http://127.0.0.1:10', '--confirm-karakeep-no-auto-ai', '--allow-dirty'], { credentials: false, state: rerunState });
      assert.equal(rerun.report.failure.code, 'credentials_path', rerun.output);
      assert.deepEqual(rerun.report.rerunOf, { runId: sourceId, modules: ids });
      assert.deepEqual(rerun.report.selected, sel.selected.map(m => m.id));
      writeFileSync(sourcePath, JSON.stringify({ ...source, cleanup: { complete: false, entries: [] } }));
      const unclean = await run(['--run', '--rerun-failed', sourcePath, '--target', 'user', '--allow-dirty'], { credentials: false, state: rerunState });
      assert.equal(unclean.report.failure.code, 'rerun_source_cleanup_incomplete');
      assert.equal(unclean.report.authorization, undefined);
    }

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
  }

  // ---------------------------------------------------------------------
  // Karakeep on the user target: /signin must prove auto AI off
  // ---------------------------------------------------------------------
  if (only('karakeep user target')) {
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
  }

  // ---------------------------------------------------------------------
  // linkding on the user target: opaque 403, read-only browser path,
  // refusal after an unfinished run, --cleanup resume, SIGINT
  // ---------------------------------------------------------------------
  if (only('linkding user target')) {
    const linkdingState = stateDirFor('linkding');
    const requests = [];
    let allowAuthentication = false, hang = false, tagCount = null;
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
      if (path === '/api/tags/') return json(200, { count: tagCount ?? store.tags.size, next: null, previous: null, results: [...store.tags.values()] });
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
    // The tag library was counted, by its count alone, before the browser.
    assert.deepEqual([success.report.tagPages.linkding.pages, success.report.tagPages.linkding.ok, success.report.tagPages.linkding.extraPages], [1, true, 0]);
    assert.match(summaryText, /标签页数：linkding 0 个标签，1 页/);
    // A library past what the plan can take is refused in the read-only
    // preflight: no browser, no module, no write; the plan's maximum and the
    // count are in the report and the summary.
    tagCount = 100000;
    requests.length = 0;
    const tooMany = await run(readOnlyArgs, { guard: false, state: linkdingState });
    tagCount = null;
    assert.equal(tooMany.code, 1);
    assert.equal(tooMany.report.failure.code, 'tag_pages_over_budget');
    assert.deepEqual(tooMany.report.modules, []);
    assert(!tooMany.report.stages.some(st => st.name === 'browser_start'), 'refused before the browser');
    assert(requests.every(q => q.method === 'GET'));
    assert.equal(requests.filter(q => q.path === '/api/tags/').length, 1, 'one count read; nothing was written, so no cleanup sweep');
    const overPages = tooMany.report.tagPages.linkding;
    assert.deepEqual([overPages.tags, overPages.pages, overPages.ok, overPages.maxPagesWithinCaps], [100000, 1000, false, tooMany.report.plan.instances.linkding.tagPages.maxPagesWithinCaps]);
    const overSummary = readFileSync(join(tooMany.reportPath, '..', 'summary.zh.md'), 'utf8');
    assert(overSummary.includes('标签页数：linkding 100000 个标签，1000 页') && overSummary.includes('超出上限（tag_pages、browser、node），未开跑'), overSummary);

    // An unfinished earlier run blocks the next one before any request. The
    // report is the one a run cut off by kill -9, OOM or a crash leaves: what
    // its own persist() wrote mid-run, one module passed and the next still
    // running. No conclude(), no cleanupAll(): nothing hand-written stands in
    // for what such a run records (review of H1b, must-fix 1).
    const pendingRun = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
    const pendingId = pendingRun.runId;
    const pendingPrefix = pendingRun.prefix;
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
    // The run prefix on a tag the ledger does not hold: residue (H1b).
    store.tags.set('10', { id: 10, name: pendingPrefix + '_stray', date_added: '2026-11-01T00:00:00Z' });
    pendingRun.runDir = pendingDir;
    pendingRun.reportPath = join(pendingDir, 'report.json');
    pendingRun.target = 'user';
    Object.assign(pendingRun.report, { target: 'user', instances: { linkding: { service: 'linkding', base: linkdingBase + '/' } }, pools: { linkding: pendingPool } });
    pendingRun.report.ledger.created.push({ instance: 'linkding', id: '7', url: pendingPool[0], source: 'route', module: 'linkding.core.worker', deleted: false });
    pendingRun.report.ledger.tags.push(
      { instance: 'linkding', key: pendingPrefix + '_x', id: '5', source: 'route', module: 'linkding.core.worker' },
      { instance: 'linkding', key: pendingPrefix + '_upper', id: '', source: 'sw', module: 'linkding.core.worker' },
    );
    await pendingRun.timed('credentials', async () => {});
    // Requests go through the run's own counter, as api() and the route count them.
    Object.assign(pendingRun.count('linkding'), { node: 105, browser: 77, browserWrites: 3, sw: 70, setup: 4 });
    pendingRun.report.modules.push({ id: 'linkding.core.worker', instance: 'linkding', status: 'passed', started: '2026-11-01T00:00:00.000Z', finished: '2026-11-01T00:00:10.000Z', ms: 10000, checks: [], notes: {}, failure: null, counts: {}, timing: { waitMs: 0, throttleMs: 0 } },
      { id: 'linkding.edges.quote-unread', instance: 'linkding', status: 'failed', started: '2026-11-01T00:00:10.000Z', finished: '2026-11-01T00:00:20.000Z', ms: 10000, checks: [], notes: {}, failure: { phase: 'linkding.edges.quote-unread', code: 'read_back_mismatch' }, counts: {}, timing: { waitMs: 0, throttleMs: 0 } });
    // The failed module's screenshot, through the run's own shot() writer: the
    // shots.json manifest a --cleanup reads back for the summary.
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const pendingPage = await browser.newPage({ viewport: { width: 420, height: 600 } });
    await pendingPage.setContent('<!doctype html><title>Shot</title><body style="margin:0"><button id="save">Save</button></body>');
    pendingRun.shotsEnabled = true;
    pendingRun.shotsDir = join(pendingDir, 'shots');
    pendingRun.currentModule = { id: 'linkding.edges.quote-unread' };
    const [pendingShot] = await pendingRun.shot(pendingPage, 'failed', { service: 'linkding', keys: ['#save'] });
    pendingRun.currentModule = null;
    await browser.close();
    browser = null;
    assert(pendingShot.file && existsSync(pendingShot.file), 'the run wrote the screenshot');
    pendingRun.report.modules.push(
      { id: 'linkding.core.popup-reader', instance: 'linkding', status: 'running', started: '2026-11-01T00:00:10.000Z', ms: 0, checks: [], notes: {}, failure: null, counts: {}, timing: { waitMs: 0, throttleMs: 0 } });
    // Selected but never started when the run was cut off.
    pendingRun.report.selected = ['linkding.core.worker', 'linkding.edges.quote-unread', 'linkding.core.popup-reader', 'linkding.edges.offline'];
    pendingRun.persist();
    const pendingReport = JSON.parse(readFileSync(join(pendingDir, 'report.json'), 'utf8'));
    assert.deepEqual(pendingReport.counts.linkding, { node: 105, browser: 77, browserWrites: 3, sw: 70, setup: 4 }, 'every persist carries the live request counts');
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
    assert.equal(resumed.code, 1, 'run-prefix residue outside the ledger leaves the cleanup incomplete');
    assert(!existsSync(deadLock), 'the --cleanup took the dead lock over and released it');
    assert.equal(resumed.report.cleanup.complete, false);
    assert.equal(resumed.report.cleanup.apiVerified, false);
    const writes = requests.filter(q => q.method !== 'GET');
    assert.deepEqual(writes.map(q => q.method + ' ' + q.path).sort(), ['DELETE /api/bookmarks/7/', 'DELETE /api/bookmarks/8/', 'DELETE /api/tags/5/', 'DELETE /api/tags/9/'].sort(), 'only ledger and pool objects are deleted');
    assert(requests.every(q => q.authenticated));
    assert(store.bookmarks.has('99') && store.tags.has('6'), 'personal bookmark and tag untouched');
    assert(store.tags.has('10'), 'a run-prefix tag outside the ledger is never deleted');
    assert.deepEqual(resumed.report.cleanup.entries.filter(e => e.residue).map(e => [e.kind, e.id, e.code]), [['tag', '10', 'residue_tag_not_in_ledger']]);
    assert(resumed.report.cleanup.entries.some(e => e.kind === 'verify' && e.code === 'verify_tag_residue'));
    const resumedSummary = readFileSync(join(pendingDir, 'summary.zh.md'), 'utf8');
    assert.match(resumedSummary, /残留 1 项/);
    // The rewritten summary keeps the run's own findings (review of H1b):
    // module verdicts by feature and the run's request counts; the cleanup's
    // own requests are kept apart.
    assert.match(resumedSummary, /通过（\d+）：[^\n]*worker-create/, resumedSummary);
    assert(!resumedSummary.includes('本轮没有执行模块'), resumedSummary);
    assert.match(resumedSummary, /请求：linkding Node 105 \/ 浏览器 77/, resumedSummary);
    // The module the run was cut off in is interrupted, not failed: its
    // features are unfinished, and a run that never summed its timing says so.
    assert.match(resumedSummary, /linkding\.core\.popup-reader：中断/, resumedSummary);
    assert.match(resumedSummary, /未执行（1[^\n]*）：linkding\.edges\.offline/, resumedSummary);
    assert.match(resumedSummary, /未完成（[^\n]*：[^\n]*offline-queue/, resumedSummary);
    // The failed module's screenshot is read back from the run's manifest.
    assert(resumedSummary.includes('linkding.edges.quote-unread：失败于 linkding.edges.quote-unread，read_back_mismatch') && resumedSummary.includes('截图 ' + pendingShot.file), resumedSummary);
    // The cleanup pass's own requests, apart from the run's.
    assert(resumedSummary.includes(`续清请求（第 1 次 --cleanup）：linkding Node ${resumed.report.cleanup.counts.linkding.node}\n`), resumedSummary);
    assert(!resumedSummary.includes('undefined'), resumedSummary);
    assert.match(resumedSummary, /未完成（\d+，[^）]*）：[^\n]*popup-save/, resumedSummary);
    assert(!/未通过 (popup-save|reader-edit)/.test(resumedSummary), resumedSummary);
    assert.match(resumedSummary, /耗时分类：未统计/, resumedSummary);
    assert.deepEqual(resumed.report.counts.linkding, pendingReport.counts.linkding, 'a --cleanup leaves the run counts as they were');
    assert(resumed.report.cleanup.counts.linkding.node > 0, 'the cleanup pass counts its own requests');
    const tagQuery = requests.find(q => q.path === '/api/bookmarks/' && q.url.includes('q='));
    assert(tagQuery && !decodeURIComponent(tagQuery.url).includes('#personal'), 'reference check names only run tags');
    assert.equal(resumed.report.ledger.created.find(e => e.id === '8').source, 'pool', 'unrecorded pool bookmark adopted by exact URL');
    // Removed by hand. A --cleanup that fails before it starts cleaning (a
    // wrong --credentials path) must not report the previous pass's residue
    // and requests as its own (review of H1b, must-fix 2): its summary shows
    // why it stopped and nothing of the earlier pass.
    store.tags.delete('10');
    requests.length = 0;
    const misread = await run(['--cleanup', join(pendingDir, 'report.json'), '--linkding', linkdingBase, '--credentials', join(dir, 'no-such-credentials.json')], { guard: false, credentials: false, state: linkdingState });
    assert.equal(misread.code, 1);
    assert.deepEqual(requests, [], 'nothing is sent without credentials');
    assert.equal(misread.report.cleanup.error, 'credentials_unreadable');
    assert.equal(misread.report.cleanup.resumed, 2);
    assert.equal(misread.report.cleanup.counts, undefined, 'the previous pass\'s request counts are not this pass\'s');
    assert(misread.output.includes('Cleanup error: credentials_unreadable'), misread.output);
    const misreadSummary = readFileSync(join(pendingDir, 'summary.zh.md'), 'utf8');
    assert.match(misreadSummary, /本轮续清在开始清理前失败：credentials_unreadable/, misreadSummary);
    assert(!/残留|未清理|续清请求/.test(misreadSummary), misreadSummary);
    // The same for a credential file that is not 0600 or not JSON: the code
    // reaches the terminal and the summary, the file's content does not.
    for (const [mode, text, code] of [[0o644, JSON.stringify({ linkdingToken: syntheticKey }), 'credentials_permissions'], [0o600, '{"linkdingToken":"' + syntheticKey + '"', 'credentials_json']]) {
      const bad = join(dir, 'bad-credentials-' + code + '.json');
      writeFileSync(bad, text, { mode });
      chmodSync(bad, mode);
      requests.length = 0;
      const failed = await run(['--cleanup', join(pendingDir, 'report.json'), '--linkding', linkdingBase, '--credentials', bad], { guard: false, credentials: false, state: linkdingState });
      assert.deepEqual([failed.code, requests, failed.report.cleanup.error, failed.report.cleanup.errorBeforeStart], [1, [], code, true], failed.output);
      assert(failed.output.includes('Cleanup error: ' + code), failed.output);
      assert(readFileSync(join(pendingDir, 'summary.zh.md'), 'utf8').includes('本轮续清在开始清理前失败：' + code));
    }
    // The next --cleanup, with the right credentials, confirms and completes.
    requests.length = 0;
    const confirmed = await run(['--cleanup', join(pendingDir, 'report.json'), '--linkding', linkdingBase], { guard: false, state: linkdingState });
    assert.equal(confirmed.code, 0, confirmed.output);
    assert.equal(confirmed.report.cleanup.complete, true);
    assert.deepEqual(requests.filter(q => q.method !== 'GET'), [], 'the confirming pass deletes nothing');
    // The summary reports this pass: the residue removed by hand is gone.
    const confirmedSummary = readFileSync(join(pendingDir, 'summary.zh.md'), 'utf8');
    assert.match(confirmedSummary, /清理完成：是/);
    assert(!/残留|未清理/.test(confirmedSummary), confirmedSummary);
    assert.match(confirmedSummary, /请求：linkding Node 105 \/ 浏览器 77/, confirmedSummary);
    // The latest pass's number and requests: a confirming pass deletes
    // nothing, so it costs fewer requests than the first.
    assert(confirmed.report.cleanup.counts.linkding.node < resumed.report.cleanup.counts.linkding.node);
    assert(confirmedSummary.includes(`续清请求（第 5 次 --cleanup）：linkding Node ${confirmed.report.cleanup.counts.linkding.node}\n`), confirmedSummary);
    assert(confirmed.report.cleanup.entries.some(e => e.code === 'residue_tag_not_in_ledger'), 'earlier passes stay in report.json');

    requests.length = 0;
    const unblocked = await run(readOnlyArgs, { guard: false, state: linkdingState });
    assert.equal(unblocked.code, 0, 'a completed --cleanup unblocks the next run');

    // Karakeep lists (H1b): a --cleanup acts on a report read from disk, which
    // could have been edited to name the user's own Read Later list (same
    // marker, possibly empty). So it never deletes a list: one still there is
    // residue for a person; one already gone is confirmed. In the run's own
    // process the ledger list is deleted after its checks, as before.
    {
      const kRequests = [];
      const lists = new Map([['L1', { id: 'L1', name: 'Read later', icon: 'bookmark', description: LIST_MARKER, type: 'manual', public: false, hasCollaborators: false, userRole: 'owner', parentId: null }]]);
      const kServer = createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        kRequests.push(req.method + ' ' + url.pathname);
        const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
        if (req.headers.authorization !== 'Bearer ' + syntheticKarakeepKey) return json(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });
        const list = url.pathname.match(/^\/api\/v1\/lists\/([^/]+)(\/bookmarks)?$/);
        if (list) {
          if (!lists.has(list[1])) return json(404, { code: 'NOT_FOUND', message: 'List not found' });
          if (list[2]) return json(200, { bookmarks: [], nextCursor: null });
          if (req.method === 'DELETE') { lists.delete(list[1]); res.writeHead(204); return res.end(); }
          return json(200, lists.get(list[1]));
        }
        if (url.pathname === '/api/v1/bookmarks/check-url') return json(200, { bookmarkId: null });
        if (url.pathname === '/api/v1/tags') return json(200, { tags: [], nextCursor: null });
        return json(404, { code: 'NOT_FOUND', message: 'Unknown fixture route' });
      });
      const kPort = await listen(kServer);
      const kBase = 'http://127.0.0.1:' + kPort;
      const state = stateDirFor('karakeep-list-resume');
      const id = randomUUID();
      const kDir = join(state, 'pbp-it-' + id);
      mkdirSync(kDir, { mode: 0o700 });
      const kReport = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] }).report;
      Object.assign(kReport, { runId: id, prefix: 'pbp-it-' + id, target: 'user', instances: { karakeep: { service: 'karakeep', base: kBase + '/' } }, pools: { karakeep: live.poolUrls('user', id, 'karakeep', 2) } });
      kReport.ledger.lists.push({ instance: 'karakeep', id: 'L1', module: 'karakeep.core.popup-reader' }, { instance: 'karakeep', id: 'L2', module: 'karakeep.core.popup-reader' });
      live.writePrivateJson(join(kDir, 'report.json'), kReport);
      const kResumed = await run(['--cleanup', join(kDir, 'report.json'), '--karakeep', kBase], { guard: false, state });
      assert.equal(kResumed.code, 1, kResumed.output);
      assert(lists.has('L1'), 'a --cleanup never deletes a list');
      assert(!kRequests.some(r => r.startsWith('DELETE')), kRequests.join(' | '));
      const listEntries = kResumed.report.cleanup.entries.filter(e => e.kind === 'list').map(e => [e.id, e.deleted, e.code || '', !!e.residue]);
      assert.deepEqual(listEntries, [['L1', false, 'residue_list_resume', true], ['L2', true, '', false]]);
      assert.deepEqual(kResumed.report.ledger.lists.map(l => [l.id, l.deleted]), [['L1', undefined], ['L2', true]]);
      assert.equal(kResumed.report.cleanup.complete, false);
      assert.match(readFileSync(join(kDir, 'summary.zh.md'), 'utf8'), /残留 1 项/);
      // In the run's own process the same ledger list is deleted.
      const own = new live.LiveRun({ mode: 'run', flags: new Set(), values: {}, errors: [] });
      own.target = 'user';
      own.instances.karakeep = { id: 'karakeep', service: 'karakeep', base: kBase + '/', root: live.apiRootFor('karakeep', kBase + '/'), token: syntheticKarakeepKey };
      own.caps = { karakeep: live.BUDGETS.user.karakeep };
      own.reserve = { karakeep: 60 };
      own.cleaning = true;
      own.report.ledger.lists.push({ instance: 'karakeep', id: 'L1', module: '' });
      kRequests.length = 0;
      assert.equal(await own.cleanupLists('karakeep'), true);
      assert(!lists.has('L1') && kRequests.includes('DELETE /api/v1/lists/L1'), 'deleted in-process after its checks');
      // The guard itself refuses a list deletion on a --cleanup (review of
      // H1b r2): its ledger comes from a report on disk, so a DELETE lists/:id
      // that bypasses cleanupLists is fatal before it leaves, even for a list
      // the ledger names.
      lists.set('L3', { id: 'L3', name: 'Read later', icon: 'bookmark', description: LIST_MARKER, type: 'manual', public: false, hasCollaborators: false, userRole: 'owner', parentId: null });
      own.report.ledger.lists.push({ instance: 'karakeep', id: 'L3', module: '' });
      own.resumed = true;
      kRequests.length = 0;
      await assert.rejects(own.api('karakeep', 'lists/L3', { method: 'DELETE' }), e => e.code === 'node_guard_resume_list' && e.fatal === true);
      assert.deepEqual([lists.has('L3'), kRequests, own.fatal], [true, [], 'node_guard_resume_list'], 'refused before it leaves');
      assert.equal(await own.cleanupLists('karakeep'), false, 'cleanupLists on a resume reports the list as residue');
      assert(lists.has('L3') && !kRequests.some(r => r.startsWith('DELETE')), kRequests.join(' | '));
      lists.delete('L3');
      // With the list gone, the next --cleanup confirms it and its summary no
      // longer reports the earlier pass's residue.
      const kConfirmed = await run(['--cleanup', join(kDir, 'report.json'), '--karakeep', kBase], { guard: false, state });
      assert.equal(kConfirmed.code, 0, kConfirmed.output);
      const kSummary = readFileSync(join(kDir, 'summary.zh.md'), 'utf8');
      assert(/清理完成：是/.test(kSummary) && !/残留|未清理/.test(kSummary), kSummary);
      await closeServer(kServer);
    }

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
  }

  // ---------------------------------------------------------------------
  // Pinboard (H2). Everything runs against tests/bookmark-live-pinboard-mock.mjs
  // in this process; nothing reaches api.pinboard.in. The runner takes the
  // mock only through main()'s in-process options, so the CLI cannot.
  // ---------------------------------------------------------------------
  if (SECTIONS.filter(name => name.startsWith('pinboard')).some(only)) {
    const { createPinboardMock } = await import('./bookmark-live-pinboard-mock.mjs');

    // The gate, on a fake clock: each request starts one interval after the
    // previous answer; a 429 doubles it up to the cap; a good answer resets.
    if (only('pinboard units')) {
      let clock = 0;
      const starts = [];
      const gate = live.createPinboardGate({ intervalMs: 3000, maxBackoffMs: 10000, now: () => clock, wait: async ms => { clock += ms; } });
      const answer = (status, took = 200) => () => { starts.push(clock); clock += took; return { status }; };
      for (const status of [200, 200, 429, 429, 429, 200, 200]) await gate.run(answer(status));
      const gaps = starts.slice(1).map((s, i) => s - (starts[i] + 200));
      assert.deepEqual(gaps, [3000, 3000, 6000, 10000, 10000, 3000], 'gap after each answer');
      assert.deepEqual({ ...gate.stats }, { requests: 7, waitedMs: 3000 + 3000 + 6000 + 10000 + 10000 + 3000, rateLimited: 3, maxIntervalMs: 10000, maxQueueDepth: 1, maxQueueMs: 10000, slowQueued: 0 });
      // Concurrent callers queue: the second starts after the first answers.
      clock = 100000;
      const order = [];
      await Promise.all([1, 2, 3].map(n => gate.run(async () => { order.push([n, clock]); clock += 50; return { status: 200 }; })));
      assert.deepEqual(order.map(o => o[0]), [1, 2, 3]);
      assert(order[1][1] - order[0][1] >= 3050 && order[2][1] - order[1][1] >= 3050, 'serialised with the interval');
      // A thrown request still frees the queue and counts as an answer.
      await assert.rejects(gate.run(async () => { throw new Error('net'); }));
      assert.equal((await gate.run(async () => ({ status: 200 }))).status, 200);
      // Queue depth and time (third review): the extension spaces its own
      // Pinboard requests 3.1 s apart by start and aborts each after 15 s,
      // while this gate waits 3 s after each answer, so a burst queues here.
      // Every request waiting longer than warnMs is reported.
      let qclock = 0;
      const slow = [];
      const burst = live.createPinboardGate({ intervalMs: 3000, now: () => qclock, wait: async ms => { qclock += ms; }, onSlow: info => slow.push(info) });
      qclock = 50000;
      await Promise.all([1, 2, 3, 4, 5].map(() => burst.run(async () => { qclock += 500; return { status: 200 }; })));
      // Starts at 0, 3.5, 7, 10.5, 14 s after the burst.
      assert.equal(burst.stats.maxQueueDepth, 5);
      assert.equal(burst.stats.maxQueueMs, 14000);
      assert.equal(burst.stats.slowQueued, 2);
      assert.deepEqual(slow.map(s => [s.queuedMs, s.depth]), [[10500, 2], [14000, 1]]);
      assert.equal(live.PINBOARD_QUEUE_WARN_MS, 10000);
    }

    // Selection and plan: Pinboard is opt-in, user target only, 8 bookmarks.
    if (only('pinboard units')) {
      assert(!live.DEFAULT_SERVICES.includes('pinboard'), 'Pinboard only on request');
      const temp = live.selectModules('pinboard.*', { services: ['pinboard'], target: 'temp' });
      assert.deepEqual(temp.selected, []);
      assert(temp.skipped.length > 0 && temp.skipped.every(s => s.reason === 'pinboard_user_only'));
      assert.throws(() => live.selectModules('pinboard.core.worker', { services: ['pinboard'], target: 'temp' }), e => e.code === 'module_requires_user');
      // The pre-H3c set (readonly and core) fits one round; the H3c
      // regression module takes a second (Pinboard: 8 URLs, 10 run tags).
      const { selected, skipped } = live.selectModules('pinboard.readonly,pinboard.core.*', { services: ['pinboard'], target: 'user' });
      assert(selected.length >= 4 && selected.every(m => m.id.startsWith('pinboard.')));
      const every = live.selectModules('pinboard.*', { services: ['pinboard'], target: 'user' }).selected;
      assert(every.some(m => m.id === 'pinboard.regress.tags-notes'));
      const packed = live.packRounds(every, 'user');
      assert.equal(packed.ok, true, JSON.stringify(packed.overflow));
      assert.equal(packed.count, 2);
      assert.deepEqual(packed.overflow, []);
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
    if (only('pinboard units')) {
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
      // Never the default state directory: this test's own.
      r.state = pbState;
      r.runDir = join(pbState, 'pbp-it-' + r.runId);
      r.reportPath = join(r.runDir, 'report.json');
      r.target = 'user';
      r.instances = { pinboard: { id: 'pinboard', service: 'pinboard', base: '', root: live.PINBOARD_ROOT, token } };
      r.pools = { pinboard: live.poolUrls('user', r.runId, 'pinboard', 3) };
      r.caps = { pinboard: { ...live.BUDGETS.user.pinboard, node } };
      r.reserve = { pinboard: live.BUDGETS.user.pinboard.cleanupReserve };
      return r;
    };

    // The send gate takes exactly one auth_token, this run's.
    if (only('pinboard units')) {
      const mock = createPinboardMock({ token });
      const r = unitRun(mock);
      const t = encodeURIComponent(token);
      await assert.rejects(r.pinboardSend('pinboard', live.PINBOARD_ROOT + 'posts/get?auth_token=' + t + '&auth_token=other%3A00000000'), e => e.code === 'live_guard_pinboard_token');
      assert.deepEqual(mock.calls, []);
    }

    // A user name equal to a value the harness writes (the instance id
    // "pinboard", a status "passed") must not corrupt report.json: --cleanup
    // reads it back. Free text is still masked.
    if (only('pinboard units')) for (const name of ['pinboard', 'passed', 'user', 'route']) {
      const r = unitRun(createPinboardMock({ token }));
      mkdirSync(r.runDir, { recursive: true, mode: 0o700 });
      r.accountNames.push(name);
      Object.assign(r.report, { target: 'user', instances: { pinboard: { service: 'pinboard', base: '' } }, pools: { pinboard: r.pools.pinboard } });
      r.report.ledger.created.push({ instance: 'pinboard', id: 'pool-1', url: r.pools.pinboard[0], source: 'route', module: 'pinboard.core.worker', deleted: false });
      r.report.modules.push({ id: 'pinboard.core.worker', status: 'passed' });
      r.report.console.push({ type: 'error', text: `Connected as ${name} (ok)` });
      r.report.checks.push(`${name}: signed in`);
      r.persist();
      const back = JSON.parse(readFileSync(r.reportPath, 'utf8'));
      assert.equal(back.instances.pinboard.service, 'pinboard', name);
      assert.equal(back.ledger.created[0].instance, 'pinboard', name);
      assert.equal(back.ledger.created[0].source, 'route', name);
      assert.equal(back.modules[0].status, 'passed', name);
      assert.equal(back.target, 'user', name);
      assert.equal(back.console[0].text, 'Connected as [account] (ok)', name);
      assert.equal(back.checks[0], '[account]: signed in', name);
      live.validateResumeReport(back, r.reportPath, { state: pbState });
      rmSync(r.runDir, { recursive: true, force: true });
    }

    // The extension's posts/add through the route: the ledger on disk names
    // the bookmark before Pinboard sees the request; an answer that made
    // nothing (a 4xx such as 429) takes the entry back, one that may have
    // (no answer, 5xx) keeps it pending for cleanup.
    if (only('pinboard units')) {
      const fakeRoute = () => { const out = { fulfilled: null, aborted: false }; out.route = { fulfill: async o => { out.fulfilled = o; }, abort: async () => { out.aborted = true; } }; return out; };
      const addUrl = url => live.PINBOARD_ROOT + 'posts/add?auth_token=' + encodeURIComponent(token) + '&format=json&url=' + encodeURIComponent(url) + '&description=x&shared=no';
      const setup = (status) => {
        const mock = createPinboardMock({ token });
        const seen = [];
        const transport = async url => {
          if (live.pinboardEndpoint(url) === 'posts/add') seen.push(JSON.parse(readFileSync(r.reportPath, 'utf8')).ledger.created.map(e => ({ ...e })));
          return status ? { status, contentType: 'text/html', body: '<html></html>' } : mock.transport(url);
        };
        const r = unitRun({ transport });
        mkdirSync(r.runDir, { recursive: true, mode: 0o700 });
        return { r, mock, seen };
      };
      const onDisk = r => JSON.parse(readFileSync(r.reportPath, 'utf8')).ledger.created;
      // done: written before the send, settled after.
      {
        const { r, mock, seen } = setup(0);
        const pool = r.pools.pinboard;
        const fr = fakeRoute();
        await r.routePinboard(fr.route, addUrl(pool[0]), { instance: 'pinboard', kind: 'create', url: pool[0] });
        assert.equal(fr.fulfilled.status, 200);
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0].map(e => [e.id, e.url, e.deleted, e.pending]), [['pool-1', pool[0], false, true]], 'ledger on disk before posts/add');
        assert.deepEqual(onDisk(r).map(e => [e.id, e.deleted, e.pending]), [['pool-1', false, undefined]]);
        assert.equal(r.pending.pinboard?.bookmarks || 0, 0);
        assert.equal(mock.posts.size, 1);
        // Saved again after the run deleted it: reopened before the send. A
        // refusal leaves it open (not deleted): a save of the same URL let
        // through as a mutate meanwhile may have made it, and cleanup's
        // posts/delete takes "item not found".
        r.report.ledger.created[0].deleted = true;
        mock.posts.clear();
        mock.rateLimit(1);
        const again = fakeRoute();
        await r.routePinboard(again.route, addUrl(pool[0]), { instance: 'pinboard', kind: 'create', url: pool[0] });
        assert.equal(again.fulfilled.status, 429);
        assert.deepEqual(seen[1].map(e => [e.id, e.deleted, e.pending]), [['pool-1', false, true]]);
        assert.deepEqual(onDisk(r).map(e => [e.id, e.deleted, e.pending]), [['pool-1', false, undefined]]);
        r.cleaning = true;
        assert.equal(await r.deleteBookmark(r.report.ledger.created[0]), true, 'cleanup takes the reopened entry');
        assert.equal(r.report.ledger.created[0].deleted, true);
        rmSync(r.runDir, { recursive: true, force: true });
      }
      // Two saves of one URL in the gate queue: the first is judged a create
      // (it writes the entry), the second a mutate of that pending entry. The
      // first gets a 429, the second saves. Cleanup must still find it, both
      // for a URL the run deleted before (reopened) and for a new one.
      for (const reopened of [true, false]) {
        const mock = createPinboardMock({ token });
        let first = true;
        const transport = async url => {
          if (live.pinboardEndpoint(url) === 'posts/add' && first) { first = false; return { status: 429, contentType: 'text/html', body: '' }; }
          return mock.transport(url);
        };
        const r = unitRun({ transport });
        mkdirSync(r.runDir, { recursive: true, mode: 0o700 });
        r.guardCfg = { ...r.buildGuardCfg(), writes: true };
        const u = r.pools.pinboard[0];
        if (reopened) r.report.ledger.created.push({ instance: 'pinboard', id: 'pool-1', url: u, source: 'route', module: '', deleted: true });
        const d1 = live.liveGuardRule(r.guardCfg, r.guardView(), { url: addUrl(u), method: 'GET' });
        const p1 = r.routePinboard(fakeRoute().route, addUrl(u), d1);
        const d2 = live.liveGuardRule(r.guardCfg, r.guardView(), { url: addUrl(u), method: 'GET' });
        const p2 = r.routePinboard(fakeRoute().route, addUrl(u), d2);
        await Promise.all([p1, p2]);
        assert.deepEqual([d1.kind, d2.kind], ['create', 'mutate'], `judged (${reopened})`);
        assert.equal(mock.posts.has(u), true);
        assert.deepEqual(onDisk(r).map(e => [e.id, e.deleted, e.pending]), [['pool-1', false, undefined]], `still named on disk (${reopened})`);
        r.cleaning = true;
        for (const entry of r.report.ledger.created.filter(e => !e.deleted)) assert.equal(await r.deleteBookmark(entry), true);
        assert.equal(await r.cleanupPool('pinboard'), true);
        assert.equal(mock.posts.has(u), false, `cleanup removed it (${reopened})`);
        rmSync(r.runDir, { recursive: true, force: true });
      }
      // 429 (Pinboard's rate limit, a 4xx): nothing made, entry and slot gone.
      {
        const { r, seen } = setup(429);
        const pool = r.pools.pinboard;
        const fr = fakeRoute();
        await r.routePinboard(fr.route, addUrl(pool[1]), { instance: 'pinboard', kind: 'create', url: pool[1] });
        assert.equal(fr.fulfilled.status, 429);
        assert.equal(seen[0].length, 1, 'held while in flight');
        assert.deepEqual(onDisk(r), []);
        assert.deepEqual(r.report.ledger.created, []);
        assert.equal(r.pending.pinboard?.bookmarks || 0, 0);
        rmSync(r.runDir, { recursive: true, force: true });
      }
      // 502: the save may exist, so the entry stays (pending) for cleanup.
      {
        const { r } = setup(502);
        const pool = r.pools.pinboard;
        await r.routePinboard(fakeRoute().route, addUrl(pool[2]), { instance: 'pinboard', kind: 'create', url: pool[2] });
        assert.deepEqual(onDisk(r).map(e => [e.id, e.deleted, e.pending]), [['pool-3', false, true]]);
        rmSync(r.runDir, { recursive: true, force: true });
      }
    }

    // A URL read empty is skipped later only once the browser is closed: a
    // module's own cleanup runs with the extension still able to save.
    if (only('pinboard units')) {
      const r = unitRun(createPinboardMock({ token }));
      r.pinboardEmpty = new Set();
      r.ctx = {};
      r.notePinboardEmpty('pinboard', r.pools.pinboard[0]);
      assert.equal(r.pinboardEmpty.size, 0);
      r.ctx = null;
      r.notePinboardEmpty('pinboard', r.pools.pinboard[0]);
      assert.equal(r.pinboardEmpty.size, 1);
    }

    // The runner's own reads: a 429 is retried PINBOARD_429_RETRIES times,
    // each a counted request, then fails; the Node cap and the cleanup cap
    // stop a request before it is sent.
    if (only('pinboard units')) {
      const read = r => r.pinboardApi('pinboard', 'posts/get?url=' + encodeURIComponent(r.pools.pinboard[0]));
      let mock = createPinboardMock({ token });
      let r = unitRun(mock);
      mock.rateLimit(5);
      await assert.rejects(read(r), e => e.code === 'api_http_429');
      assert.equal(live.PINBOARD_429_RETRIES, 3);
      assert.equal(r.counts.pinboard.node, 1 + live.PINBOARD_429_RETRIES);
      assert.equal(mock.calls.length, 1 + live.PINBOARD_429_RETRIES);
      assert.equal(r.gate.stats.rateLimited, 1 + live.PINBOARD_429_RETRIES);
      // Run budget: node cap minus the cleanup reserve.
      mock = createPinboardMock({ token });
      r = unitRun(mock, { node: live.BUDGETS.user.pinboard.cleanupReserve });
      await assert.rejects(read(r), e => e.code === 'node_request_budget');
      assert.deepEqual(mock.calls, []);
      // Cleanup budget: the whole cap, retries included.
      mock = createPinboardMock({ token });
      r = unitRun(mock, { node: 2 });
      r.cleaning = true;
      mock.rateLimit(5);
      await assert.rejects(read(r), e => e.code === 'cleanup_request_budget');
      assert.equal(mock.calls.length, 2);
      assert.equal(r.fatal, 'cleanup_request_budget');
    }
    const pbCredentials = join(pbState, '..', 'pinboard-credentials.json');
    writeFileSync(pbCredentials, JSON.stringify({ pinboardToken: token }), { mode: 0o600 });
    const noTokenCredentials = join(pbState, '..', 'pinboard-none.json');
    writeFileSync(noTokenCredentials, JSON.stringify({}), { mode: 0o600 });
    const badCredentials = join(pbState, '..', 'pinboard-bad.json');
    writeFileSync(badCredentials, JSON.stringify({ pinboardToken: 'no-colon-' + hex }), { mode: 0o600 });
    const INTERVAL = 40;
    const inProcess = async (args, mock, { intervalMs = INTERVAL, modules } = {}) => {
      const before = process.env.PBP_LIVE_STATE_DIR;
      process.env.PBP_LIVE_STATE_DIR = pbState;
      const lines = [];
      const log = console.log, err = console.error;
      console.log = (...a) => lines.push(a.join(' '));
      console.error = (...a) => lines.push(a.join(' '));
      let code;
      // As the CLI entry: a thrown failure prints its code and exits 1.
      try { code = await live.main(args, { pinboard: { transport: mock.transport, intervalMs, mock: true }, modules }); }
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
    if (only('pinboard token')) {
      const mock = createPinboardMock({ token });
      const skipped = await inProcess(pbArgs(noTokenCredentials, 'pinboard.readonly,pinboard.core.*', 'pb-none'), mock);
      assert.equal(skipped.code, 0, skipped.output);
      assert.deepEqual(mock.calls, []);
      assert.equal(skipped.report.pinboard.configured, false);
      assert.equal(skipped.report.pinboard.reason, 'pinboard_token_missing');
      assert(skipped.report.skipped.some(s => s.reason === 'pinboard_token_missing'));
      assert.deepEqual(skipped.report.modules, []);
      assert(readFileSync(join(skipped.reportPath, '..', 'summary.zh.md'), 'utf8').includes('Pinboard：未配置'));
    }
    // A token not in "user:HEX" form fails before any request, and is not echoed.
    if (only('pinboard token')) {
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
    if (only('pinboard mock browser write round')) {
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
      // Requests spent outside the module (third review, E6): the preflight
      // reads one pool URL (the run id makes the others new too), plus the
      // 429 retry; cleanup deletes each ledger URL straight away, reads it
      // once, and does not read a URL again once it read it empty with the
      // browser closed: 2 per bookmark, one posts/get per other pool URL
      // (the pool scan) and one tags/get; the verify pass reads nothing again.
      const stageRequests = name => rep.stages.filter(st => st.name === name).reduce((n, st) => n + st.requests, 0);
      assert.equal(live.preflightCost({ service: 'pinboard', urls: rep.pools.pinboard.length }), 1);
      assert.equal(stageRequests('preflight'), 1 + 1);
      assert.equal(stageRequests('cleanup'), 2 * rep.ledger.created.length + (rep.pools.pinboard.length - rep.ledger.created.length) + 1);
      assert(stageRequests('cleanup') <= live.cleanupCost({ service: 'pinboard', bookmarks: rep.ledger.created.length, urls: rep.pools.pinboard.length }));
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
      assert(Array.isArray(rep.modules[0].surfaces), 'the surfaces a module drove are recorded');
    }
    // H3c Pinboard regression on the mock: twin merge, the duplicate-URL
    // answer recorded as Pinboard wrote it and recognised as a conflict, the
    // reader's title/extended write. A mock that words the duplicate answer
    // differently fails that part alone, with the text in the report.
    if (only('pinboard mock browser write round')) {
      const mock = createPinboardMock({ token });
      const extRoot = process.env.PBP_PREFLIGHT_EXT_ROOT ? ['--ext-root', process.env.PBP_PREFLIGHT_EXT_ROOT] : [];
      const done = await inProcess([...pbArgs(pbCredentials, 'pinboard.regress.*', 'pb-regress'), ...extRoot], mock);
      const mod = done.report.modules.find(m => m.id === 'pinboard.regress.tags-notes');
      // The twin merge is G4b (ec31de02): a product tree without it sends the
      // NFD and zero-width twins next to their visible spelling, and only that
      // part fails (PBP_PREFLIGHT_EXT_ROOT=<a G4b tree> checks the pass).
      const merge = mod.parts.find(p => p.name === 'merge_twins');
      assert(merge.status === 'passed' || (merge.status === 'failed' && merge.code === 'regress_merge_sent_tags'), JSON.stringify(merge));
      if (merge.status === 'failed') assert(done.report.readBackDiffs.some(d => d.code === 'regress_merge_sent_tags'), JSON.stringify(done.report.readBackDiffs));
      if (extRoot.length) assert.equal(merge.status, 'passed');
      assert.equal(done.code, merge.status === 'passed' ? 0 : 1, done.output);
      assert.equal(mod.status, merge.status, done.output);
      assert.deepEqual(mod.parts.map(p => [p.name, p.status]), [['create_plain', 'passed'], ['merge_twins', merge.status], ['duplicate_result_code', 'passed'], ['reader_title_extended', 'passed']]);
      assert.deepEqual(mod.notes.duplicateResultCode, { code: 'item already exists', status: 200, recognizedAs: 'conflict' });
      assert(done.report.pinboardResults.some(r => r.replace === 'no' && r.code === 'item already exists'));
      assert(done.report.pinboardResults.every(r => Object.keys(r).sort().join() === 'code,module,replace,status'), 'only replace, status and the code are kept');
      assert.equal(mock.posts.size, 0);
      assert(mock.calls.filter(c => c.path !== 'tags/get').length <= 18 + 1 + live.cleanupCost({ service: 'pinboard', bookmarks: 1, urls: done.report.pools.pinboard.length }), 'calls ' + mock.calls.length);
      const summary = readFileSync(join(done.reportPath, '..', 'summary.zh.md'), 'utf8');
      assert(summary.includes('实测 result_code：「item already exists」'), summary);
      for (const s of secretsOf) assert(!readFileSync(done.reportPath, 'utf8').includes(s));

      const other = createPinboardMock({ token });
      const transport = async url => {
        const u = new URL(url);
        if (live.pinboardEndpoint(url) === 'posts/add' && u.searchParams.get('replace') === 'no' && other.posts.has(u.searchParams.get('url'))) return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ result_code: 'duplicate URL' }) };
        return other.transport(url);
      };
      const worded = await inProcess([...pbArgs(pbCredentials, 'pinboard.regress.*', 'pb-regress-worded'), ...extRoot], { transport });
      assert.notEqual(worded.code, 0);
      const wmod = worded.report.modules[0];
      assert.deepEqual(wmod.parts.map(p => [p.name, p.status, p.code || '']), [['create_plain', 'passed', ''], ['merge_twins', merge.status, merge.code || ''], ['duplicate_result_code', 'failed', 'duplicate_result_code'], ['reader_title_extended', 'passed', '']]);
      assert.deepEqual(wmod.notes.duplicateResultCode, { code: 'duplicate URL', status: 200, recognizedAs: 'api' });
      assert.equal(worded.report.cleanup.complete, true);
      assert.equal(other.posts.size, 0);
    }
    // The review's counterexample: a row that opens the popup but leaves it
    // out of `surfaces` (so --changed would never pick it for popup.js)
    // fails at run time instead of passing.
    if (only('pinboard mock browser write round')) {
      const mock = createPinboardMock({ token });
      const readonly = MODULES.find(m => m.id === 'readonly');
      const rows = [{ ...readonly, services: ['pinboard'], surfaces: ['options'] }];
      const done = await inProcess(pbArgs(pbCredentials, 'pinboard.readonly', 'pb-undeclared'), mock, { modules: rows });
      assert.notEqual(done.code, 0, done.output);
      const mod = done.report.modules[0];
      assert.deepEqual([mod.id, mod.status, mod.failure?.code], ['pinboard.readonly', 'failed', 'surface_undeclared'], done.output);
      assert.deepEqual(mod.undeclaredSurfaces, ['popup']);
      assert(mod.surfaces.includes('popup'));
      assert.equal(done.report.cleanup.complete, true);
      assert.equal(mock.posts.size, 0);
      // The same row with the popup declared passes.
      const ok = await inProcess(pbArgs(pbCredentials, 'pinboard.readonly', 'pb-declared'), createPinboardMock({ token }), { modules: [{ ...rows[0], surfaces: ['options', 'popup'] }] });
      assert.equal(ok.code, 0, ok.output);
      assert.deepEqual(ok.report.modules[0].undeclaredSurfaces || [], []);
    }

    // Rehearsal at the real interval (third review), behind a switch: about
    // two minutes. The 40 ms interval above hides how deep the gate's queue
    // gets when the reader opens; this runs pinboard.core.popup-reader on the
    // mock with 3 s between requests and 400 ms answers, and prints the
    // queue depth and time the real run will meet.
    if (only('pinboard mock browser write round') && process.env.PBP_LIVE_PINBOARD_REAL_INTERVAL === '1') {
      const mock = createPinboardMock({ token, latencyMs: 400 });
      const started = Date.now();
      const done = await inProcess(pbArgs(pbCredentials, 'pinboard.core.popup-reader', 'pb-real-interval'), mock, { intervalMs: live.PINBOARD_MIN_INTERVAL_MS });
      const th = done.report?.timing?.throttle || {};
      console.log(`pinboard real-interval rehearsal: exit ${done.code}, ${((Date.now() - started) / 1000).toFixed(1)} s, ${th.requests} requests, max queue ${th.maxQueueDepth} deep / ${th.maxQueueMs} ms, ${th.slowQueued} over ${live.PINBOARD_QUEUE_WARN_MS} ms, throttle wait ${th.waitedMs} ms; endpoints ${JSON.stringify(mock.calls.reduce((o, c) => ({ ...o, [c.path]: (o[c.path] || 0) + 1 }), {}))}`);
      console.log('pinboard real-interval rehearsal slowest: ' + JSON.stringify(done.report?.timing?.slowest || []));
      assert.equal(done.code, 0, done.output);
      assert.equal(mock.posts.size, 0);
    }

    // --cleanup resume: a run cut off after creating one pool bookmark.
    if (only('pinboard cleanup resume')) {
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
        modules: [], cleanup: { complete: false, entries: [] }, checks: [], readBackDiffs: [], console: [], swConsole: [], pageErrors: [], requestFailed: [], blockedOrigins: [], violations: [], skipped: [], shots: { count: 0 },
        // The run's own gate statistics: a --cleanup must not overwrite them
        // (review of H1b r2), or a run that met a 429 reads as one that did not.
        findings: [{ kind: 'pinboard_queue', module: 'pinboard.core.worker', phase: 'pinboard.core.worker', queuedMs: 12000, depth: 3 }],
        timing: { phases: [], totals: { throttleMs: 120000, waitMs: 500 }, slowest: [], throttle: { requests: 40, waitedMs: 120000, rateLimited: 1, maxIntervalMs: 6000, maxQueueDepth: 3, maxQueueMs: 12000, slowQueued: 1 } },
        pinboard: { configured: true },
      });
      const runTiming = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8')).timing;
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
      // pool-1: delete + get; pool-2: get, delete, get; pool-3: get; tags/get.
      // Nothing is read twice (it was 12 requests).
      assert.deepEqual(mock.calls.map(c => c.path + ' ' + (c.url ? 'pool-' + (pool.indexOf(c.url) + 1) : '')), ['posts/delete pool-1', 'posts/get pool-1', 'posts/get pool-2', 'posts/delete pool-2', 'posts/get pool-2', 'posts/get pool-3', 'tags/get ']);
      for (let i = 1; i < mock.calls.length; i++) assert(mock.calls[i].at - mock.calls[i - 1].at >= INTERVAL - 2);
      // The run's gate statistics and waits stay as the run left them; the
      // cleanup pass keeps its own beside its request counts.
      assert.deepEqual(after.timing, runTiming, 'a --cleanup leaves the run timing as it was');
      assert.deepEqual(after.findings.filter(f => f.kind === 'pinboard_queue').length, 1);
      assert.equal(after.cleanup.throttle.requests, mock.calls.length);
      assert(after.cleanup.timing.throttleMs > 0, JSON.stringify(after.cleanup.timing));
      const pbSummary = readFileSync(join(runDir, 'summary.zh.md'), 'utf8');
      assert(pbSummary.includes('节流请求 40 次') && pbSummary.includes('429 1 次') && pbSummary.includes('排队超过 10s 的请求 1 个'), pbSummary);
      assert(pbSummary.includes(`Pinboard 节流 ${mock.calls.length} 次`), pbSummary);
    }
  }

  if (filterNote) console.log('bookmark live preflight: ' + filterNote + ' passed');
  else console.log('bookmark live preflight: registry/selection/budgets/guard rule/fake AI/docker fake executor/screenshot canary/plan/gates/Karakeep auto-AI/linkding read-only browser/cleanup resume/SIGINT/Pinboard mock passed');
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const server of servers) await closeServer(server);
  rmSync(dir, { recursive: true, force: true });
}
