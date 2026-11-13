// Self-test for scripts/link-check.mjs against a local http server. No real
// network: every request goes to 127.0.0.1 (checkUrl is called directly; the
// loopback skip lives in collectLinks and is tested on its own).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkUrl, checkAll, collectLinks, defaultFiles, extractLinks, skipReason, USER_AGENT } from '../scripts/link-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const hits = [];
const counters = new Map();
const server = createServer((req, res) => {
  hits.push({ method: req.method, url: req.url, ua: req.headers['user-agent'] });
  const n = (counters.get(req.url) || 0) + 1; counters.set(req.url, n);
  const send = (code, headers = {}) => { res.writeHead(code, headers); res.end(req.method === 'HEAD' ? undefined : 'body'); };
  switch (req.url) {
    case '/ok': return send(200);
    case '/missing': return send(404);
    case '/gone': return send(410);
    case '/no-head': return req.method === 'HEAD' ? send(405) : send(200);
    case '/head-not-implemented': return req.method === 'HEAD' ? send(501) : send(200);
    case '/head-forbidden-get-ok': return req.method === 'HEAD' ? send(403) : send(200);
    case '/forbidden': return send(403);
    case '/auth': return send(401);
    case '/busy': return send(429);
    case '/wall': return send(403, { 'cf-mitigated': 'challenge' });
    case '/redirect': return send(301, { location: '/ok' });
    case '/redirect-dead': return send(302, { location: '/missing' });
    case '/down': return send(503);
    case '/flaky': return n <= 2 ? send(500) : send(200);
    case '/hang': return; // never answers
    default: return send(404);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.closeAllConnections(); server.close(); });
const fast = { timeoutMs: 300, retries: 2, backoffMs: 5 };
const check = (path, extra = {}) => checkUrl(base + path, { ...fast, ...extra });
const methods = (path) => hits.filter((h) => h.url === path).map((h) => h.method);

test('200 is ok after one HEAD, with the generic user agent', async () => {
  const r = await check('/ok');
  assert.equal(r.result, 'ok'); assert.equal(r.tries, 1);
  assert.deepEqual(methods('/ok'), ['HEAD']);
  assert.equal(hits.find((h) => h.url === '/ok').ua, USER_AGENT);
  assert.doesNotMatch(USER_AGENT, /@|mailto|https?:/, 'no contact details');
});
test('404 and 410 are broken, without retrying', async () => {
  for (const p of ['/missing', '/gone']) {
    const r = await check(p);
    assert.equal(r.result, 'broken', p); assert.equal(r.tries, 1, p);
  }
});
test('HEAD 501 falls back to GET', async () => {
  assert.equal((await check('/head-not-implemented')).result, 'ok');
  assert.deepEqual(methods('/head-not-implemented'), ['HEAD', 'GET']);
});
test('HEAD 405 or 403 falls back to GET', async () => {
  assert.equal((await check('/no-head')).result, 'ok');
  assert.deepEqual(methods('/no-head'), ['HEAD', 'GET']);
  assert.equal((await check('/head-forbidden-get-ok')).result, 'ok');
  assert.deepEqual(methods('/head-forbidden-get-ok'), ['HEAD', 'GET']);
});
test('401, 403, 429 and a bot wall are unverifiable, not broken', async () => {
  for (const p of ['/forbidden', '/auth', '/busy', '/wall']) assert.equal((await check(p)).result, 'unverifiable', p);
  assert.match((await check('/wall')).detail, /bot wall/);
});
test('redirects are followed to their end', async () => {
  assert.equal((await check('/redirect')).result, 'ok');
  assert.equal((await check('/redirect-dead')).result, 'broken');
});
test('5xx is retried twice, then broken; a 5xx that recovers is ok', async () => {
  const down = await check('/down');
  assert.equal(down.result, 'broken'); assert.equal(down.tries, 3);
  assert.equal(methods('/down').filter((m) => m === 'HEAD').length, 3);
  const flaky = await check('/flaky');
  assert.equal(flaky.result, 'ok'); assert.equal(flaky.tries, 3);
});
test('a timeout is retried and ends unverifiable', async () => {
  const r = await check('/hang', { timeoutMs: 150 });
  assert.equal(r.result, 'unverifiable'); assert.equal(r.detail, 'timeout'); assert.equal(r.tries, 3);
});
test('a host that does not resolve is broken', async () => {
  const fetchImpl = async () => { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); throw e; };
  const r = await checkUrl('https://no-such-host.invalid/', { ...fast, fetchImpl });
  assert.equal(r.result, 'broken'); assert.match(r.detail, /ENOTFOUND/);
});
test('checkAll checks each URL once, keeps order and limits concurrency', async () => {
  let live = 0, peak = 0;
  const fetchImpl = async (url, init) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 20)); live--; return fetch(url, init); };
  const before = hits.length;
  const r = await checkAll([base + '/ok', base + '/missing', base + '/ok', base + '/redirect', base + '/gone', base + '/ok'], { ...fast, fetchImpl, concurrency: 2 });
  assert.deepEqual(r.map((x) => x.url.slice(base.length)), ['/ok', '/missing', '/redirect', '/gone']);
  assert.ok(peak <= 2, `peak ${peak}`);
  assert.equal(hits.slice(before).filter((h) => h.url === '/ok').length, 2, 'once for /ok, once more as the redirect target');
});

test('extraction: links, autolinks, HTML, trailing punctuation; code is not a link', () => {
  const md = 'See [a](https://a.example.net/x). Also <https://b.org/y>, and https://c.org/z.\n<a href="https://d.org/w">d</a>\n' +
    'Wiki [w](https://en.wikipedia.org/wiki/Foo_(bar)) and `https://e.org/in-code` and\n```\nhttps://f.org/fenced\n```\n';
  assert.deepEqual(extractLinks(md), ['https://a.example.net/x', 'https://b.org/y', 'https://c.org/z', 'https://d.org/w', 'https://en.wikipedia.org/wiki/Foo_(bar)']);
});
test('skips: loopback, example domains, templates; public hosts are kept', () => {
  for (const u of ['http://localhost:8765/x', 'http://127.0.0.1', 'http://[::1]:3000/', 'https://example.com/a', 'https://www.example.org/', 'https://foo.example/', 'https://x.invalid/']) assert.notEqual(skipReason(u), '', u);
  for (const u of ['https://api.example.com/{id}', 'https://*/', 'https://host.org/$PATH']) assert.equal(skipReason(u), 'template', u);
  for (const u of ['https://github.com/a/b', 'https://example.community/']) assert.equal(skipReason(u), '', u);
});
test('collectLinks dedupes across files and remembers where each link is', () => {
  const files = { 'a.md': '[x](https://one.org/) https://one.org/ http://localhost/', 'b.md': 'https://one.org/ https://two.org/' };
  const { links, skipped } = collectLinks(Object.keys(files), (f) => files[f]);
  assert.deepEqual([...links.keys()], ['https://one.org/', 'https://two.org/']);
  assert.deepEqual(links.get('https://one.org/').files, ['a.md', 'b.md']);
  assert.deepEqual([...skipped.keys()], ['http://localhost/']);
});
test('defaultFiles includes READMEs, SECURITY.md, and outward-facing docs pages, and all are readable', () => {
  const files = defaultFiles(ROOT);
  for (const required of ['README.md', 'SECURITY.md', 'docs/privacy.md', 'docs/index.md', 'docs/troubleshooting.md', 'docs/data-format.md']) {
    assert.ok(files.includes(required), `defaultFiles must include ${required}`);
    assert.ok(readFileSync(join(ROOT, required), 'utf8').length > 0);
  }
});

test('cli: a file with only skipped links makes no request and exits 0; --json writes the results', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbp-link-check-'));
  try {
    writeFileSync(join(dir, 'a.md'), 'http://localhost/ and https://example.com/ and `https://real.org/`\n');
    const out = join(dir, 'out.json');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/link-check.mjs'), '--json', out, join(dir, 'a.md')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /0 links: ok 0, broken 0, unverifiable 0, skipped 2/);
    const j = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(j.results, []); assert.equal(j.skipped.length, 2);
    assert.equal(spawnSync(process.execPath, [join(ROOT, 'scripts/link-check.mjs'), join(dir, 'missing.md')], { encoding: 'utf8' }).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cli: exits 1 when a link is broken, 0 when the rest is only unverifiable', async () => {
  const { spawn } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'pbp-link-check-cli-'));
  // The server runs in this process, so the CLI is spawned asynchronously.
  const cli = (file) => new Promise((done) => {
    const c = spawn(process.execPath, [join(ROOT, 'scripts/link-check.mjs'), file], { env: { ...process.env, PBP_LINK_CHECK_ALLOW_LOOPBACK: '1' } });
    let out = ''; c.stdout.on('data', (b) => { out += b; }); c.stderr.on('data', (b) => { out += b; });
    c.on('close', (status) => done({ status, out }));
  });
  try {
    writeFileSync(join(dir, 'bad.md'), `[a](${base}/ok) [b](${base}/missing) [c](${base}/forbidden)\n`);
    writeFileSync(join(dir, 'meh.md'), `[a](${base}/ok) [c](${base}/forbidden) [d](${base}/busy)\n`);
    const bad = await cli(join(dir, 'bad.md'));
    assert.equal(bad.status, 1, bad.out); assert.match(bad.out, /broken 1, unverifiable 1/);
    const meh = await cli(join(dir, 'meh.md'));
    assert.equal(meh.status, 0, meh.out); assert.match(meh.out, /broken 0, unverifiable 2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
