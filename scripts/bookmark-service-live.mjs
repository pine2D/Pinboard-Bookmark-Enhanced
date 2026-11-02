// Opt-in real-service acceptance runner (harness v3). verify.sh never points
// it at a service: tests/bookmark-live-preflight-tests.mjs exercises it with
// synthetic fixtures, an injected Docker executor and a loopback fake AI.
//
// Targets
//   --target temp (default): throwaway linkding (SQLite), linkding-pg
//     (postgres:18) and Karakeep containers built from the images the user's
//     own containers already run (read-only `docker inspect`; never pulled).
//     Data lives in tmpfs, every object is named pbp-it-<runId>-*, and the
//     services sit on an --internal Docker network: they cannot reach the
//     internet at all. An edge container (also pbp-it-<runId>-*) publishes
//     each service on a random 127.0.0.1 port. Bookmark URLs are
//     http://localhost:<TEMP_FIXTURE_PORT>/?pbp-it=... because the extension
//     may only be granted https://* or loopback HTTP hosts: the browser gets
//     the synthetic article from ctx.route, and inside each service a
//     fixture sidecar sharing the service's network namespace serves the
//     same article on that loopback port. Server-side fetches (linkding
//     /check/ metadata and HTML snapshots, the Karakeep crawler) therefore
//     reach a controlled page and nothing else; only `localhost` is
//     allow-listed in each service's SSRF guard. No credential file is read:
//     the run creates a throwaway account and token inside the containers.
//   --target user: the user's own loopback instances with tokens from a
//     0600 credential file, read by this process only. Tight per-service
//     budgets; Karakeep writes need the public /signin configuration to show
//     server-side auto tagging and summarisation disabled, plus
//     --confirm-karakeep-no-auto-ai.
//
// Safety layers (both targets)
//   - Node API calls: loopback base only, no redirects, no cookies, 20 s
//     timeout, zero retries, and writes limited to objects this run created.
//   - Browser: one throwaway profile, host resolver maps everything except
//     loopback to NOTFOUND, ctx.route answers fixture pages and aborts every
//     other origin. The route layer applies the same rule as the service
//     worker guard (liveGuardRule), counts page and worker requests, and
//     records each creation the moment its response arrives.
//   - Caps: both layers, and Node API writes, refuse a bookmark, a Read Later
//     list or run-prefix tags beyond the run's caps before the request
//     leaves, counting the ledger and the creations still in flight.
//   - Service worker: a second guard wraps fetch; a new worker (restart)
//     aborts the run because that second layer would be gone.
//   - Fake AI: a loopback OpenAI-compatible server; only POST chat/completions
//     on its exact origin is allowed; 60 calls per run; metadata only.
//   - Cleanup: one idempotent cleanupAll on success, failure, signals and
//     uncaught errors; ledger written to disk at every creation; --cleanup
//     <report> resumes; a run refuses to start while an earlier report is not
//     fully cleaned. Reports, screenshots and the profile stay in a 0700
//     directory with 0600 files. No tracing, HAR or video is ever enabled.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { GROUPS, LIST_MARKER, META_DESCRIPTION, MODULES, UNCOVERED, budgetValue } from './bookmark-service-live-scenarios.mjs';

// v3: pool URLs changed format after v2 (H1b), so an unfinished v2 report
// is foreign: it neither blocks a run nor resumes.
export const HARNESS_VERSION = 3;
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SERVICE_TYPES = ['linkding', 'karakeep', 'pinboard'];
// Pinboard is opt-in (--service ...,pinboard): it is the user's real account
// on a 3-second throttle.
export const DEFAULT_SERVICES = Object.freeze(['linkding', 'karakeep']);
export const TEMP_FIXTURE_HOST = 'localhost';
// Fixture port inside each temporary service's network namespace (and in the
// bookmark URLs). The browser never connects to it: ctx.route answers it.
export const TEMP_FIXTURE_PORT = 47391;
export const PINBOARD_ROOT = 'https://api.pinboard.in/v1/';
// Pinboard (user target only; there is no temporary Pinboard). One call per
// user every three seconds (pinboard.in/api): every Pinboard request, the
// extension's and the runner's own, passes one gate that waits this long
// after the previous answer, and doubles the wait after a 429 until an
// answer is not one (capped). Only the runner's own reads and deletions are
// retried after a 429, each retry counted against the Node budget; the
// extension gets the 429 as Pinboard sent it.
export const PINBOARD_MIN_INTERVAL_MS = 3000;
export const PINBOARD_MAX_BACKOFF_MS = 60000;
export const PINBOARD_429_RETRIES = 3;
export const PINBOARD_BOOKMARKS_PER_RUN = 8;
// A request queued at the gate longer than this is a finding: the extension
// gives each Pinboard request 15 s (_executePinboardFetch) from its own
// start, and the route holds it while it queues here.
export const PINBOARD_QUEUE_WARN_MS = 10000;
// The endpoints a run may reach, by who sends them. The extension's save
// chain under HARDENED_SETTINGS: posts/get (lookups), posts/add (every save
// and edit), posts/delete (reader delete), tags/get (tag list) and
// user/api_token (the options page's token test). The runner reads with
// posts/get and tags/get and deletes its ledger with posts/delete. Anything
// else under /v1/ (posts/all, posts/recent, posts/suggest, posts/update,
// posts/dates, tags/rename, tags/delete, notes/*, user/secret) is refused as
// a guard violation; pinboard.in pages are outside every instance and aborted.
export const PINBOARD_ENDPOINTS = Object.freeze({
  extension: Object.freeze(['posts/add', 'posts/get', 'posts/delete', 'tags/get', 'user/api_token']),
  node: Object.freeze(['posts/get', 'posts/delete', 'tags/get']),
});
export const PINBOARD_REFUSED_EXAMPLES = Object.freeze(['posts/all', 'posts/recent', 'posts/suggest', 'posts/update', 'posts/dates', 'tags/rename', 'tags/delete', 'notes/list', 'user/secret', 'https://pinboard.in/']);
// The endpoint a Pinboard v1 URL names: no query, no trailing slash
// (user/api_token/ is how the extension spells that one).
export const pinboardEndpoint = url => { try { const u = new URL(url); return u.origin + '/v1/' === PINBOARD_ROOT && u.pathname.startsWith('/v1/') ? u.pathname.slice(4).replace(/\/+$/, '') : ''; } catch { return ''; } };
// The run's Pinboard bookmark URLs live under a reserved .example name that
// ctx.route answers; no loopback port is ever stored in the user's account.
export const pinboardPoolHost = runId => runId + '.pbp-it.example';
// "username:HEX" on one line. The name is account data: only "configured"
// reaches the report.
export const PINBOARD_TOKEN_RE = /^([^:\s]+):([0-9A-Fa-f]{8,})$/;

// Temporary instances: container port, edge port and the service type.
export const TEMP_INSTANCES = Object.freeze({
  linkding: { service: 'linkding', port: 9090, edgePort: 9101 },
  karakeep: { service: 'karakeep', port: 3000, edgePort: 9102 },
  'linkding-pg': { service: 'linkding', port: 9090, edgePort: 9103 },
});

// Per-instance caps for one run. user = the 2026-11-01 authorisation; temp is
// looser because every object dies with its tmpfs, but still bounded.
export const BUDGETS = Object.freeze({
  user: {
    linkding: { bookmarks: 15, node: 250, cleanupReserve: 60, browser: 350, tags: 20, lists: 0 },
    karakeep: { bookmarks: 12, node: 250, cleanupReserve: 60, browser: 500, tags: 20, lists: 1 },
    pinboard: { bookmarks: PINBOARD_BOOKMARKS_PER_RUN, node: 100, cleanupReserve: 40, browser: 150, tags: 10, lists: 0, minIntervalMs: PINBOARD_MIN_INTERVAL_MS },
    run: { fakeAi: 60, moduleSeconds: 120, runMinutes: 20, urlMargin: 3, roundsPerAuthorization: 3 },
  },
  temp: {
    linkding: { bookmarks: 60, node: 1200, cleanupReserve: 300, browser: 2000, tags: 120, lists: 0 },
    'linkding-pg': { bookmarks: 60, node: 1200, cleanupReserve: 300, browser: 2000, tags: 120, lists: 0 },
    karakeep: { bookmarks: 60, node: 1200, cleanupReserve: 300, browser: 3000, tags: 120, lists: 3 },
    run: { fakeAi: 60, moduleSeconds: 180, runMinutes: 45, urlMargin: 5 },
  },
});
// Connect (options page) cost per instance, added to the browser plan.
const CONNECT_BROWSER = { linkding: 30, karakeep: 60, pinboard: 20 };
// Planning estimate for everything outside the modules (containers, browser,
// Connect, preflight, cleanup). Temporary runs measured 11-16 s of setup and
// 2-20 s of cleanup; a user run adds Karakeep tag sweeps over a large library.
export const SETUP_ALLOWANCE_SECONDS = Object.freeze({ user: 120, temp: 300 });

// Settings every run starts from. Each key must exist in SETTINGS_DEFAULTS
// (checked inside the worker) except the per-device sync switch.
export const HARDENED_SETTINGS = Object.freeze({
  optSyncEnabled: false, optAiAutoTags: false, previewAiEnabled: false, previewSkimEnabled: false,
  optShowAiTags: false, optShowAiSummary: false, qsAiTags: false, qsAiSummary: false, rlAiTags: false,
  rlAiSummary: false, batchAiTags: false, batchAiSummary: false, aiContentSource: 'local',
  optAutoCloseAfterSave: false, optLang: 'en', optCheckBookmarkStatus: false, waybackArchiveEnabled: false,
  optPrivateDefault: true, offlineQueueEnabled: false, aiTagSeparator: '_', optAutoDescription: true,
  // The extension's own background Pinboard calls: the unread badge
  // (posts/all), the 15-minute tag prewarm (tags/get; only in "prewarmed"),
  // and the popup's suggestions (posts/suggest) and recent list (posts/recent).
  // optCheckBookmarkStatus above covers the icon's status lookups.
  optShowBadge: false, tagSyncMode: 'cached', optShowSuggestTags: false, optShowRecent: false,
});
const LOCAL_ONLY_SETTINGS = ['optSyncEnabled', 'syncApiKeys'];

// Report fields whose values the harness writes itself (ids, states, codes),
// never text from a page, a service or the account.
export const REPORT_IDENTIFIER_KEYS = new Set(['service', 'instance', 'id', 'status', 'kind', 'source', 'module', 'phase', 'code', 'target', 'mode', 'scenario', 'reason', 'surface', 'type', 'state', 'error']);
export class HarnessFailure extends Error {
  constructor(code, { fatal = false } = {}) { super(code); this.code = code; this.fatal = fatal; }
}
const fail = (code, fatal = false) => { throw new HarnessFailure(code, { fatal }); };
const check = (condition, code, fatal = false) => { if (!condition) fail(code, fatal); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Pure helpers (exported for the synthetic preflight tests)
// ---------------------------------------------------------------------------

const BOOL_FLAGS = new Set(['--run', '--plan', '--list', '--help', '--read-only', '--confirm-karakeep-no-auto-ai', '--allow-dirty', '--shots', '--headed']);
const VALUE_FLAGS = new Set(['--target', '--scenario', '--service', '--linkding', '--karakeep', '--credentials', '--cleanup', '--shots-dir', '--authorization']);

export function parseArgs(argv) {
  const flags = new Set(), values = {}, errors = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (BOOL_FLAGS.has(arg)) flags.add(arg);
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) errors.push('missing_value');
      else { values[arg.slice(2)] = value; i++; }
    } else errors.push('unknown_argument');
  }
  let mode = 'usage';
  if (flags.has('--help')) mode = 'help';
  else if (values.cleanup) mode = 'cleanup';
  else if (flags.has('--run')) mode = 'run';
  else if (flags.has('--plan')) mode = 'plan';
  else if (flags.has('--list')) mode = 'list';
  return { mode, flags, values, errors };
}

export const SNAPSHOT_SKIP_NOTE = id => `工具读不到用户 linkding 的「自动 HTML 快照」开关，user 目标默认跳过；确认开关已开后可用 --scenario ${id} 显式点名运行`;

export function globToRegExp(glob) {
  const source = String(glob).split('').map(ch => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[\\^$+.()|[\]{}]/g, '\\$&'))).join('');
  return new RegExp('^' + source + '$');
}

// Every registry row expanded to concrete instances, in a stable order:
// instances first (linkding, linkding-pg, karakeep, pinboard), rows after.
export function expandRegistry(modules = MODULES) {
  const out = [];
  for (const row of modules) {
    for (const service of row.services) {
      const instance = row.needs?.container || service;
      out.push({ ...row, rowId: row.id, service, instance, id: instance + '.' + row.id });
    }
  }
  const order = ['linkding', 'linkding-pg', 'karakeep', 'pinboard'];
  return out.sort((a, b) => order.indexOf(a.instance) - order.indexOf(b.instance) || modules.indexOf(modules.find(m => m.id === a.rowId)) - modules.indexOf(modules.find(m => m.id === b.rowId)));
}

export function listIds(modules = MODULES) {
  return expandRegistry(modules).map(m => m.id);
}

// --scenario: comma list of group names and/or globs over expanded ids.
export function selectModules(spec, { services = DEFAULT_SERVICES, target = 'temp', modules = MODULES, groups = GROUPS } = {}) {
  const all = expandRegistry(modules);
  const tokens = String(spec || 'core').split(',').map(s => s.trim()).filter(Boolean);
  if (!tokens.length) fail('scenario');
  const chosen = new Set(), skipped = [];
  for (const token of tokens) {
    const patterns = groups[token] || [token];
    const explicit = !groups[token] && !/[*?]/.test(token);
    let matched = 0;
    for (const pattern of patterns) {
      const re = globToRegExp(pattern);
      for (const mod of all) {
        if (!re.test(mod.id)) continue;
        matched++;
        if (!services.includes(mod.service)) continue;
        // There is no temporary Pinboard: its modules run on the user target.
        if (mod.service === 'pinboard' && target !== 'user') {
          if (explicit) fail('module_requires_user');
          skipped.push({ id: mod.id, reason: 'pinboard_user_only' });
          continue;
        }
        const need = mod.needs?.target || 'any';
        if (need !== 'any' && need !== target) {
          if (explicit) fail('module_requires_' + need);
          skipped.push({ id: mod.id, reason: 'target_' + need });
          continue;
        }
        if (target === 'user' && mod.needs?.sharing === 'on') {
          if (explicit) fail('module_requires_sharing_on');
          skipped.push({ id: mod.id, reason: 'sharing_on_temp_only' });
          continue;
        }
        if (target === 'user' && mod.instance !== mod.service) {
          skipped.push({ id: mod.id, reason: 'temp_container_only' });
          continue;
        }
        // The harness cannot read the user's linkding "automatic HTML
        // snapshots" switch: with it off the module can only fail, with it on
        // the user's server fetches the page. It runs on the user target only
        // when its id is named exactly.
        if (target === 'user' && mod.needs?.snapshots && !explicit) {
          skipped.push({ id: mod.id, reason: 'snapshot_setting_unreadable', note: SNAPSHOT_SKIP_NOTE(mod.id) });
          continue;
        }
        chosen.add(mod.id);
      }
    }
    if (!matched) fail('scenario');
  }
  const selected = all.filter(m => chosen.has(m.id));
  return { selected, skipped: skipped.filter(s => !chosen.has(s.id)) };
}

export function resolveBudget(mod) {
  const b = mod.budget || {}, s = mod.service;
  const bookmarks = budgetValue(b.bookmarks, s);
  return {
    bookmarks, urls: Math.max(bookmarks, budgetValue(b.urls, s)), node: budgetValue(b.node, s),
    browser: budgetValue(b.browser, s), ai: budgetValue(b.ai, s), tags: budgetValue(b.tags, s),
    lists: budgetValue(b.lists, s), seconds: budgetValue(b.seconds, s),
    // Expected Pinboard requests (extension and Node) of one pass, measured
    // on the mock: the throttle floor --plan shows. Not a cap.
    calls: budgetValue(b.calls, s),
  };
}

// Requests cleanup and its read-only verification may need for one instance.
export function cleanupCost({ service, bookmarks = 0, urls = 0, tags = 0, lists = 0 }) {
  // Pinboard: posts/delete + posts/get per ledger bookmark (delete answers
  // "item not found" for nothing, so no read first), at most one posts/get
  // per pool URL (a URL read empty after the browser closed is not read
  // again, by the pool scan or the verify pass), a tags/get to see no run
  // tag is left (Pinboard drops a tag with its last bookmark), and the
  // margin of the other services.
  if (service === 'pinboard') return 2 * bookmarks + urls + 1 + 2;
  const tagPages = service === 'karakeep' ? 6 : 2;
  const tagCost = service === 'linkding' ? 4 * tags : 2 * tags;
  // ledger bookmarks: GET + DELETE + GET; pool: check each URL once, then a
  // read-only pass; lists: GET + members + DELETE + GET; tags: DELETE + GET,
  // after two reference searches per tag on linkding; sweep and verify pages.
  return 3 * bookmarks + 2 * urls + 4 * lists + tagCost + 2 * tagPages + 2;
}

export function preflightCost({ service, urls = 0, writes = false }) {
  // Pinboard has no health endpoint: one posts/get of the first pool URL
  // proves the token. The others carry the same fresh run id, so they
  // cannot exist either.
  if (service === 'pinboard') return Math.min(urls, 1);
  return 2 + urls + (service === 'linkding' ? 1 : 0) + (service === 'karakeep' && writes ? 1 : 0);
}

export function poolUrls(target, runId, instance, count) {
  if (instance === 'pinboard') return Array.from({ length: count }, (_, i) => `https://${pinboardPoolHost(runId)}/?pbp-it=${runId}-pinboard-${i + 1}`);
  const origin = target === 'temp' ? `http://${TEMP_FIXTURE_HOST}:${TEMP_FIXTURE_PORT}` : 'https://example.com';
  return Array.from({ length: count }, (_, i) => `${origin}/?pbp-it=${runId}-${instance}-${i + 1}`);
}

export function buildPlan({ target = 'temp', selected, skipped = [], shotsEnabled = false, headedFlag = false }) {
  const caps = BUDGETS[target];
  const instances = [...new Set(selected.map(m => m.instance))];
  const perInstance = {}, problems = [];
  let fakeAiCalls = 0, throttleSeconds = 0;
  for (const instance of instances) {
    const mods = selected.filter(m => m.instance === instance);
    const service = mods[0].service;
    const cap = caps[instance];
    if (!cap) { problems.push(instance + ':no_budget'); continue; }
    const sum = { bookmarks: 0, urls: 0, node: 0, browser: CONNECT_BROWSER[service] || 0, ai: 0, tags: 0, lists: 0, seconds: 0, calls: 0 };
    for (const mod of mods) {
      const b = resolveBudget(mod);
      for (const key of Object.keys(sum)) sum[key] += key === 'browser' ? b.browser : b[key];
    }
    const writes = mods.some(m => m.needs?.writes !== false);
    const urls = sum.urls ? sum.urls + (writes ? caps.run.urlMargin : 0) : 0;
    const reserve = Math.max(cap.cleanupReserve, cleanupCost({ service, bookmarks: sum.bookmarks, urls, tags: sum.tags, lists: sum.lists }));
    const node = preflightCost({ service, urls, writes }) + sum.node;
    fakeAiCalls += sum.ai;
    const row = {
      service, modules: mods.map(m => m.id), bookmarks: sum.bookmarks, urls, node, cleanupReserve: reserve,
      browser: sum.browser, ai: sum.ai, tags: sum.tags, lists: sum.lists, moduleSeconds: sum.seconds,
      caps: { bookmarks: cap.bookmarks, node: cap.node, cleanupReserve: cap.cleanupReserve, browser: cap.browser, tags: cap.tags, lists: cap.lists },
    };
    if (sum.bookmarks > cap.bookmarks) problems.push(instance + ':bookmarks');
    // Each pool URL can hold a run bookmark (the guards create pool URLs
    // only), so a pool larger than the cap offers more than the run may make.
    if (urls > cap.bookmarks) problems.push(instance + ':urls');
    if (node + reserve > cap.node) problems.push(instance + ':node');
    if (sum.browser > cap.browser) problems.push(instance + ':browser');
    if (sum.tags > cap.tags) problems.push(instance + ':tags');
    if (sum.lists > cap.lists) problems.push(instance + ':lists');
    for (const mod of mods) if (resolveBudget(mod).seconds > caps.run.moduleSeconds) problems.push(mod.id + ':seconds');
    if (service === 'pinboard') {
      // Every Pinboard request waits for the gate, so the throttle alone
      // sets a floor: the expected requests (preflight, the modules' measured
      // calls, cleanup) times the interval. Outside the modules (preflight
      // and a cleanup that may use its whole reserve) it adds to the run's
      // worst case; inside, each module's own timeout must leave room for it.
      const interval = cap.minIntervalMs || PINBOARD_MIN_INTERVAL_MS;
      const pre = preflightCost({ service, urls, writes });
      const cleanupExpected = cleanupCost({ service, bookmarks: sum.bookmarks, urls });
      const expectedRequests = pre + sum.calls + cleanupExpected;
      const capRequests = node + reserve + sum.browser;
      row.pinboard = {
        minIntervalMs: interval, maxBackoffMs: PINBOARD_MAX_BACKOFF_MS, retriesOn429: PINBOARD_429_RETRIES, bookmarksPerRun: cap.bookmarks,
        privateOnly: true, endpoints: PINBOARD_ENDPOINTS, refusedExamples: PINBOARD_REFUSED_EXAMPLES,
        poolHost: '<runId>.pbp-it.example', expectedRequests, floorSeconds: expectedRequests * interval / 1000,
        capRequests, capSeconds: capRequests * interval / 1000, outsideModulesSeconds: (pre + reserve) * interval / 1000,
      };
      throttleSeconds += row.pinboard.outsideModulesSeconds;
      for (const mod of mods) {
        const b = resolveBudget(mod);
        if (b.calls * interval / 1000 + 15 > b.seconds) problems.push(mod.id + ':throttle_seconds');
      }
    }
    perInstance[instance] = row;
  }
  if (fakeAiCalls > caps.run.fakeAi) problems.push('fake_ai');
  // Module seconds are timeouts, not estimates. A timer enforces the run
  // cap; the plan also refuses a selection whose timeouts plus the setup
  // estimate could outlast it, so a slow round is not cut off half-way.
  const worstCaseSeconds = Object.values(perInstance).reduce((n, r) => n + r.moduleSeconds, 0) + throttleSeconds;
  const setupAllowanceSeconds = SETUP_ALLOWANCE_SECONDS[target];
  if (worstCaseSeconds + setupAllowanceSeconds > caps.run.runMinutes * 60) problems.push('run_minutes');
  const shotModules = selected.filter(m => m.needs?.shots).map(m => m.id);
  return {
    harness: HARNESS_VERSION, target, credentialsRead: false, realRequests: 0, docker: false, browser: false,
    modules: selected.map(m => ({ id: m.id, instance: m.instance, service: m.service, surfaces: m.surfaces, features: m.features, needs: m.needs, budget: resolveBudget(m) })),
    skipped, instances, budget: perInstance,
    fakeAi: { needed: selected.some(m => m.needs?.fakeAi), calls: fakeAiCalls, cap: caps.run.fakeAi },
    headed: headedFlag || selected.some(m => m.needs?.headed),
    shots: { modules: shotModules, enabled: shotsEnabled },
    containers: target === 'temp' ? [...new Set(instances.flatMap(i => (i === 'linkding-pg' ? ['postgres', 'linkding-pg'] : [i])))].concat(instances.length ? ['edge'] : []) : [],
    limits: { moduleSeconds: caps.run.moduleSeconds, runMinutes: caps.run.runMinutes, worstCaseSeconds, setupAllowanceSeconds, fakeAi: caps.run.fakeAi, roundsPerAuthorization: caps.run.roundsPerAuthorization ?? null, automaticRetries: 0 },
    karakeepWritesRequireAutoAiDisabled: target === 'user' && selected.some(m => m.service === 'karakeep' && m.needs?.writes !== false),
    cleanup: 'ledger bookmarks, ledger lists and zero-use run-prefix tags; then a read-only pass over the URL pool',
    withinCaps: problems.length === 0, problems,
  };
}

export function validateBase(raw) {
  let url;
  try { url = new URL(raw); } catch { fail('loopback_required'); }
  // [::1] passes URL parsing but the browser's host resolver is not told to
  // exclude it, so refuse it here instead of letting the browser fail later.
  check(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && /^\/?$/.test(url.pathname), 'loopback_required');
  return url.origin + '/';
}

export const apiRootFor = (service, base) => (service === 'pinboard' ? PINBOARD_ROOT : base + (service === 'linkding' ? 'api/' : 'api/v1/'));

// How a service keys a tag name, so one tag counts once however a write or a
// read-back spells it: linkding replaces spaces with hyphens and matches
// names case-insensitively (Django iexact; on SQLite only ASCII folds),
// Karakeep trims and drops a leading '#', then matches exactly. Pinboard
// keys stay as given. A key stricter than the service's only counts a tag
// twice, which refuses earlier, never later.
export function liveTagKey(service, name) {
  const text = String(name == null ? '' : name).trim();
  if (service === 'linkding') return text.replace(/ /g, '-').replace(/[A-Z]/g, c => c.toLowerCase());
  if (service === 'karakeep') return text.replace(/^#+/, '');
  return text;
}

// Ledger tag sources that mean a write named the tag before it left.
export const TAG_WRITE_SOURCES = Object.freeze(['route', 'sw', 'node']);

// The one request rule both guard layers apply: Node's ctx.route handler
// and the Node API call it directly, the service worker gets its source
// text from guardRuleSource(). Its only outer reference is liveTagKey,
// which that source carries along.
//
// With cfg.limits ({ [instance]: { bookmarks, lists, tags } }) a write that
// would take the run past a cap is refused before it leaves: view.created,
// view.lists and view.tags hold what the calling layer has recorded (a
// deleted bookmark still counts), view.pending the creations it has in
// flight. An allowed write carries the run-prefix tag keys it names that
// are not yet known (`tags`), for the layer to reserve as it sends it. With
// cfg.prefix a write naming any tag outside that prefix is refused.
export function liveGuardRule(cfg, view, req) {
  const url = String(req.url || '');
  const method = String(req.method || 'GET').toUpperCase();
  if (cfg.aiOrigin && (url === cfg.aiOrigin || url.startsWith(cfg.aiOrigin + '/'))) {
    const path = url.slice(cfg.aiOrigin.length).split('?')[0];
    return method === 'POST' && path === cfg.aiPath ? { ok: true, instance: 'ai', kind: 'ai' } : { ok: false, instance: 'ai', code: 'live_guard_ai' };
  }
  let instance = '';
  for (const id of Object.keys(cfg.instances)) {
    const inst = cfg.instances[id];
    if (url.startsWith(inst.root) || (inst.base && url.startsWith(inst.base))) { instance = id; break; }
  }
  if (!instance) return { ok: false, kind: 'outside', code: 'live_guard_origin' };
  const inst = cfg.instances[instance];
  // OPTIONS never changes state; a CORS preflight must not trip the guard.
  const read = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  if (!url.startsWith(inst.root)) {
    return read ? { ok: true, instance, kind: 'page' } : { ok: false, instance, code: 'live_guard_mutation' };
  }
  const full = url.slice(inst.root.length);
  const path = full.split('?')[0];
  const segs = path.split('/').filter(Boolean);
  const pool = cfg.pools[instance] || [];
  const created = view.created || [];
  const own = id => created.some(r => r.instance === instance && r.id === String(id));
  const capped = (decision, names) => {
    // Every tag a write names carries the run prefix: a tag the product (or
    // a fake AI reply) adds under any other name would stay on a user
    // instance, where cleanup removes ledger tags only. Fatal, not sent.
    const runPrefix = String(cfg.prefix || '');
    if (runPrefix && names.some(name => { const key = liveTagKey(inst.service, name); return key && !key.toLowerCase().startsWith(runPrefix); })) return { ok: false, instance, code: 'live_guard_foreign_tag' };
    if (!cfg.limits) return decision;
    const limit = cfg.limits[instance] || {};
    const cap = key => (typeof limit[key] === 'number' ? limit[key] : 0);
    const pending = (view.pending && view.pending[instance]) || {};
    const mine = list => (list || []).filter(r => r.instance === instance).length;
    if (decision.kind === 'create' && mine(created) + (pending.bookmarks || 0) >= cap('bookmarks')) return { ok: false, instance, code: 'live_guard_bookmark_budget' };
    if (decision.kind === 'list-create' && mine(view.lists) + (pending.lists || 0) >= cap('lists')) return { ok: false, instance, code: 'live_guard_list_budget' };
    const prefix = String(cfg.prefix || '');
    const known = new Set((view.tags || []).filter(t => t.instance === instance).map(t => t.key));
    const fresh = [];
    for (const name of names) {
      const key = liveTagKey(inst.service, name);
      if (key && key.toLowerCase().startsWith(prefix) && !known.has(key) && !fresh.includes(key)) fresh.push(key);
    }
    if (fresh.length && known.size + fresh.length > cap('tags')) return { ok: false, instance, code: 'live_guard_tag_budget' };
    return { ...decision, tags: fresh };
  };
  if (inst.service === 'pinboard') {
    // Pinboard writes are GETs: posts/add may only save a private run URL
    // (a create unless the run already made it and has not deleted it),
    // posts/delete only a run URL in the ledger. Reads are the save chain's
    // own (posts/get, tags/get, the options token test); every other
    // endpoint, bulk ones included, is refused.
    let params;
    try { params = new URL(url).searchParams; } catch (_) { return { ok: false, instance, code: 'live_guard_mutation' }; }
    if (!read || method === 'OPTIONS') return { ok: false, instance, code: 'live_guard_mutation' };
    // Each judged parameter once: get() reads the first value, a server may
    // act on the last, so a repeat could delete, save or publish a URL the
    // guard never judged. The fields a save carries (title, note, date) are
    // held to one value as well.
    if (['url', 'shared', 'tags', 'auth_token', 'replace', 'toread', 'description', 'extended', 'dt'].some(key => params.getAll(key).length > 1)) return { ok: false, instance, code: 'live_guard_pinboard_params' };
    const endpoint = path.replace(/\/+$/, '');
    const target = params.get('url');
    const mine = created.some(r => r.instance === instance && r.url === target && !r.deleted);
    if (endpoint === 'posts/add') {
      if (!cfg.writes) return { ok: false, instance, code: 'live_guard_read_only' };
      // Tags are space-separated; a comma splits too (counting more names
      // only refuses earlier).
      return pool.includes(target) && params.get('shared') === 'no' ? capped({ ok: true, instance, kind: mine ? 'mutate' : 'create', url: target }, String(params.get('tags') || '').split(/[\s,]+/)) : { ok: false, instance, code: 'live_guard_create' };
    }
    if (endpoint === 'posts/delete') {
      if (!cfg.writes) return { ok: false, instance, code: 'live_guard_read_only' };
      return created.some(r => r.instance === instance && r.url === target) ? capped({ ok: true, instance, kind: 'mutate' }, []) : { ok: false, instance, code: 'live_guard_mutation' };
    }
    return ['posts/get', 'tags/get', 'user/api_token'].includes(endpoint)
      ? { ok: true, instance, kind: 'read' } : { ok: false, instance, code: 'live_guard_pinboard_endpoint' };
  }
  if (read) return { ok: true, instance, kind: 'read' };
  if (!cfg.writes) return { ok: false, instance, code: 'live_guard_read_only' };
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  // The tag names a write body carries, as the service splits them: linkding
  // joins tag_names with commas and splits the string again; Karakeep names
  // each tag in tags[].tagName (an attach by tagId names none).
  let names = [];
  if (body && typeof body === 'object') {
    if (inst.service === 'linkding' && Array.isArray(body.tag_names)) names = body.tag_names.map(String).join(',').split(',');
    if (inst.service === 'karakeep' && Array.isArray(body.tags)) names = body.tags.map(t => (t && typeof t.tagName === 'string' ? t.tagName : ''));
  }
  if (method === 'POST' && segs.length === 1 && segs[0] === 'bookmarks') {
    return body && pool.includes(body.url) ? capped({ ok: true, instance, kind: 'create', url: body.url }, names) : { ok: false, instance, code: 'live_guard_create' };
  }
  if (segs[0] === 'bookmarks' && segs.length >= 2 && own(segs[1])) return capped({ ok: true, instance, kind: 'mutate' }, names);
  if (inst.service === 'karakeep') {
    if (method === 'POST' && path === 'lists' && body && body.description === cfg.listMarker) return capped({ ok: true, instance, kind: 'list-create' }, []);
    if (segs[0] === 'lists' && segs.length === 4 && segs[2] === 'bookmarks' && own(segs[3])) return capped({ ok: true, instance, kind: 'member' }, []);
  }
  return { ok: false, instance, code: 'live_guard_mutation' };
}

// liveGuardRule as source text for the worker, with liveTagKey bound in.
export const guardRuleSource = () => `(() => { const liveTagKey = ${liveTagKey.toString()}; return ${liveGuardRule.toString()}; })()`;

// Pinboard keys a bookmark by its URL; the ledger names it by its place in
// the run's pool, so its id stays a short safe token like the others.
export const pinboardLedgerId = (pool, url) => { const i = (pool || []).indexOf(url); return i < 0 ? '' : 'pool-' + (i + 1); };
// ---------------------------------------------------------------------------
// Pinboard gate and transport
// ---------------------------------------------------------------------------
// One queue for every Pinboard request of a run. A request starts only after
// the previous one answered and `interval` has passed since; a 429 doubles
// the interval (up to maxBackoffMs) until an answer is not a 429. `wait` and
// `now` are injectable for the preflight's fake clock.
//
// Queue depth (requests waiting or in flight, this one included) and time
// (from run() to the request's start) are kept: the extension spaces its own
// requests 3.1 s apart by start and aborts each after 15 s (shared.js
// pinboardFetch), while this gate waits after each answer, so a burst queues
// here, and one queued past the extension's deadline fails in the extension
// for a reason of the harness's making. onSlow hears of each request that
// waited longer than warnMs.
export function createPinboardGate({ intervalMs = PINBOARD_MIN_INTERVAL_MS, maxBackoffMs = PINBOARD_MAX_BACKOFF_MS, now = () => Date.now(), wait = sleep, onWait = () => {}, warnMs = PINBOARD_QUEUE_WARN_MS, onSlow = () => {} } = {}) {
  let tail = Promise.resolve(), lastEnd = -Infinity, interval = intervalMs, depth = 0;
  const stats = { requests: 0, waitedMs: 0, rateLimited: 0, maxIntervalMs: intervalMs, maxQueueDepth: 0, maxQueueMs: 0, slowQueued: 0 };
  return {
    stats,
    get intervalMs() { return interval; },
    run(fn) {
      const enqueued = now();
      depth++;
      stats.maxQueueDepth = Math.max(stats.maxQueueDepth, depth);
      const turn = tail.then(async () => {
        const delay = lastEnd + interval - now();
        if (delay > 0) { stats.waitedMs += delay; onWait(delay); await wait(delay); }
        const queuedMs = now() - enqueued;
        stats.maxQueueMs = Math.max(stats.maxQueueMs, queuedMs);
        if (queuedMs > warnMs) { stats.slowQueued++; onSlow({ queuedMs, depth }); }
        stats.requests++;
        try {
          const res = await fn();
          if (res && res.status === 429) { stats.rateLimited++; interval = Math.min(maxBackoffMs, interval * 2); } else interval = intervalMs;
          stats.maxIntervalMs = Math.max(stats.maxIntervalMs, interval);
          return res;
        } finally { lastEnd = now(); depth--; }
      });
      tail = turn.catch(() => {});
      return turn;
    },
  };
}

// The real transport: Node fetch to api.pinboard.in only, no redirects (the
// token rides the query string), no cookies, 20 s. Request headers from the
// browser are never forwarded. Answers { status, contentType, body }.
export async function pinboardHttp(url) {
  check(pinboardEndpoint(url) !== '', 'api_origin', true);
  const res = await fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
  return { status: res.status, contentType: res.headers.get('content-type') || '', body: await res.text() };
}

export const rowUrl = (service, row) => (service === 'linkding' ? row?.url : row?.content?.url);
// A request's endpoint without ids or query values: "GET tags",
// "GET tags?cursor" (a later page), "PATCH bookmarks/:id". Outside the API
// root only "page" is kept. No account data reaches the report this way.
export function endpointKey(url, root) {
  if (!root || !String(url).startsWith(root)) return 'page';
  const [path, query = ''] = String(url).slice(root.length).split('?');
  // Karakeep ids are 24+ lower-case letters (cuid2), linkding's digits; the
  // API's own words are short.
  const segs = path.split('/').filter(Boolean).map(seg => (/^[a-z_-]+$/.test(seg) && seg.length <= 12 ? seg : ':id'));
  return segs.join('/') + (/(^|&)cursor=/.test(query) ? '?cursor' : /(^|&)offset=/.test(query) ? '?offset' : '');
}

export const recordPath = (service, id) => 'bookmarks/' + encodeURIComponent(id) + (service === 'linkding' ? '/' : '');

// Replace every secret value; then keep only a fixed code when the text is
// one (assertion codes), else the error class (transport text may carry data).
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const value of secrets) if (typeof value === 'string' && value.length >= 8) out = out.split(value).join('[redacted]');
  return out;
}
export function failureCode(error, secrets = []) {
  const message = redact(error?.code || error?.message || '', secrets);
  return /^[a-z_0-9]+$/.test(message) ? message : (error?.name || 'Error');
}
// Every real secret here is long (tokens, keys, random passwords); a short
// value would only produce false hits on ordinary page text.
export function findSecret(texts, secrets) {
  const values = secrets.filter(s => typeof s === 'string' && s.length >= 12);
  return texts.some(text => values.some(value => String(text ?? '').includes(value)));
}
export const stripQuery = raw => { try { const u = new URL(raw); return u.origin + u.pathname; } catch { return 'invalid-url'; } };

// Karakeep's root layout serialises clientConfig into the RSC stream of every
// page, /signin included. Decode the flight chunks, cut out the balanced
// object and read inference.* from it; null when it cannot be found.
export function parseKarakeepClientConfig(html) {
  const text = String(html || '');
  let decoded = '';
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  for (const m of text.matchAll(re)) { try { decoded += JSON.parse(m[1]); } catch (_) { /* skip a malformed chunk */ } }
  const haystack = decoded || text;
  const at = haystack.indexOf('"clientConfig":{');
  if (at < 0) return null;
  let i = at + '"clientConfig":'.length, depth = 0, inString = false, escaped = false;
  const start = i;
  for (; i < haystack.length; i++) {
    const ch = haystack[i];
    if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (!depth) break; }
  }
  try { return JSON.parse(haystack.slice(start, i + 1)); } catch { return null; }
}
export const karakeepAutoAiOff = config => !!config && !!config.inference
  && config.inference.enableAutoTagging === false && config.inference.enableAutoSummarization === false;

// The fake AI tells requests apart by the product's own prompt openings.
export function classifyPrompt(text) {
  const value = String(text || '');
  if (/Reply with just the word: OK/.test(value)) return 'connectivity';
  if (value.includes('exactly two keys: "summary" and "tags"')) return 'combined';
  if (/^\s*Suggest up to \d+ bookmark tags/.test(value)) return 'tags';
  if (/^\s*You are writing a bookmark note, not an article summary\./.test(value)) return 'summary';
  return 'unknown';
}

// One synthetic article: the browser route serves it and so does the edge
// container's fixture host, so server-side metadata equals what the popup reads.
export function fixtureHtml() {
  return '<!doctype html><html><head><meta charset="utf-8"><title>联调样例</title><meta name="description" content="' + META_DESCRIPTION + '"></head>'
    + '<body><article><h1>联调样例</h1><pre id="quote-fixture">First line\n\n# Heading\n**bold** &lt;tag&gt;\n1. item</pre><p>'
    + '公开合成文本，不含个人资料。 '.repeat(100) + '</p></article></body></html>';
}

// ---------------------------------------------------------------------------
// Signal handling (installed by a run; unit-tested with a fake emitter)
// ---------------------------------------------------------------------------
export function installSignalHandlers({ proc = process, onFirst, onForce, signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] }) {
  let count = 0;
  const listeners = signals.map(signal => [signal, () => { count++; if (count === 1) onFirst(signal); else onForce(signal); }]);
  for (const [signal, listener] of listeners) proc.on(signal, listener);
  return () => { for (const [signal, listener] of listeners) proc.off(signal, listener); };
}

// ---------------------------------------------------------------------------
// State directory: reports, lock, previous-run checks
// ---------------------------------------------------------------------------
export const stateDir = () => process.env.PBP_LIVE_STATE_DIR || tmpdir();
const RUN_DIR_RE = /^pbp-it-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function scanIncompleteReports(dir = stateDir(), exceptRunId = '') {
  const out = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!RUN_DIR_RE.test(name) || name === 'pbp-it-' + exceptRunId) continue;
    const file = join(dir, name, 'report.json');
    try {
      const report = JSON.parse(readFileSync(file, 'utf8'));
      if (report.harness === HARNESS_VERSION && report.cleanup?.complete !== true) out.push(file);
    } catch { /* unreadable or foreign: not ours */ }
  }
  return out;
}

export function writePrivateJson(path, value) {
  const tmp = path + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// One run (or one --cleanup) at a time per state directory. A lock whose
// holder has died is free once that holder's report is clean. While it is
// not, only a --cleanup of that very report (resume: its path) may take the
// lock over: that is how a run cut off by a second signal, kill -9, OOM or a
// crash gets finished. Any other run is refused.
export function acquireLock(dir, info, { resume = '' } = {}) {
  const path = join(dir, 'pbp-it-live.lock');
  const real = file => { try { return realpathSync(file); } catch { return ''; } };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
      return () => { try { if (JSON.parse(readFileSync(path, 'utf8')).runId === info.runId) unlinkSync(path); } catch { /* already gone */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let held = {};
      try { held = JSON.parse(readFileSync(path, 'utf8')); } catch { /* unreadable lock */ }
      let alive = false;
      try { if (held.pid) { process.kill(held.pid, 0); alive = true; } } catch (e) { alive = e.code === 'EPERM'; }
      if (alive) fail('run_locked');
      let report = null;
      try { report = JSON.parse(readFileSync(held.reportPath, 'utf8')); } catch { /* missing report */ }
      const complete = report?.cleanup?.complete === true;
      // A report another harness version wrote is foreign, as in
      // scanIncompleteReports: no --cleanup of this version accepts it
      // (validateResumeReport), so its lock would block every run for good.
      // The stale lock goes; the report stays, named for a person to check.
      const foreign = !!report && typeof report === 'object' && report.harness !== HARNESS_VERSION;
      if (foreign) console.warn('Removing a stale lock whose report another harness version wrote; check it by hand: ' + held.reportPath);
      const resuming = !!resume && typeof held.reportPath === 'string' && !!real(held.reportPath) && real(held.reportPath) === real(resume);
      if (!complete && !foreign && !resuming && held.reportPath && existsSync(held.reportPath)) fail('previous_cleanup_incomplete');
      unlinkSync(path);
    }
  }
  fail('run_locked');
}

// Rounds per user authorisation. Every --run --target user names the
// authorisation it runs under (--authorization LABEL); the rounds are
// counted in the state directory next to the reports and claimed under the
// run lock, after the tree and earlier-cleanup checks and before any
// credential is read. A refused or failed round still counts; --cleanup
// never does. Temporary targets need no authorisation.
const AUTH_LEDGER = 'pbp-it-authorizations.json';
const AUTH_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export function validateAuthorizationLabel(label) {
  check(typeof label === 'string' && AUTH_LABEL_RE.test(label), 'authorization_label');
  return label;
}
export function readAuthorizations(dir = stateDir()) {
  const path = join(dir, AUTH_LEDGER);
  if (!existsSync(path)) return { version: 1, labels: {} };
  let data = null;
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { /* checked below */ }
  // An unreadable count is refused, never reset.
  check(data?.version === 1 && data.labels && typeof data.labels === 'object' && Object.values(data.labels).every(Array.isArray), 'authorization_ledger_invalid');
  return data;
}
export function authorizationStatus(dir, label, cap) {
  if (!label) return { required: true, label: '', roundsPerAuthorization: cap, used: null, left: null };
  validateAuthorizationLabel(label);
  const used = (readAuthorizations(dir).labels[label] || []).length;
  return { required: true, label, roundsPerAuthorization: cap, used, left: Math.max(0, cap - used) };
}
export function claimAuthorizationRound(dir, label, entry, cap) {
  validateAuthorizationLabel(label);
  const data = readAuthorizations(dir);
  const rounds = (data.labels[label] ||= []);
  check(rounds.length < cap, 'authorization_rounds_exhausted');
  rounds.push(entry);
  writePrivateJson(join(dir, AUTH_LEDGER), data);
  return { label, round: rounds.length, roundsPerAuthorization: cap };
}

// ---------------------------------------------------------------------------
// Docker (temp target). Every call passes assertDockerArgs: mutating
// commands may only name pbp-it-<runId>-* objects, `docker inspect` of a
// foreign container is read-only and limited to fixed --format templates,
// nothing is ever pulled, and published ports are 127.0.0.1 only.
// ---------------------------------------------------------------------------
export function tempNames(runId) {
  const p = 'pbp-it-' + runId + '-';
  const names = { prefix: p, net: p + 'net', edge: p + 'edge', postgres: p + 'postgres' };
  for (const instance of Object.keys(TEMP_INSTANCES)) { names[instance] = p + instance; names[instance + '-fixture'] = p + instance + '-fixture'; }
  return names;
}
const USER_CONTAINERS = { linkding: 'linkding', karakeep: 'karakeep-web' };
const INSPECT_FORMATS = new Set(['{{.Image}}', '{{.State.Status}} {{.State.ExitCode}}', '{{.Id}}']);

export function assertDockerArgs(args, runId) {
  const own = name => typeof name === 'string' && name.startsWith('pbp-it-' + runId + '-');
  const [cmd, sub] = args;
  const refuse = code => fail(code, true);
  const formatOk = () => args[1] === '--format' && INSPECT_FORMATS.has(args[2]) && args.length === 4;
  if (cmd === 'inspect') { if (!formatOk()) refuse('docker_command_refused'); return 'read'; }
  if (cmd === 'image' && sub === 'inspect') { if (!(args[2] === '--format' && args[3] === '{{.Id}}' && args.length === 5)) refuse('docker_command_refused'); return 'read'; }
  if (cmd === 'ps' || (cmd === 'network' && sub === 'ls') || (cmd === 'volume' && sub === 'ls')) {
    const filter = args[args.indexOf('--filter') + 1] || '';
    if (!filter.startsWith('name=pbp-it-')) refuse('docker_command_refused');
    return 'read';
  }
  if (cmd === 'network' && sub === 'create') {
    if (!own(args[args.length - 1]) || !args.includes('--internal')) refuse('docker_foreign_object');
    return 'write';
  }
  if (cmd === 'network' && sub === 'connect') { if (!own(args[args.length - 2]) || !own(args[args.length - 1])) refuse('docker_foreign_object'); return 'write'; }
  if (cmd === 'network' && sub === 'rm') { if (args.length !== 3 || !own(args[2])) refuse('docker_foreign_object'); return 'write'; }
  if (cmd === 'create' || cmd === 'run') {
    const name = args[args.indexOf('--name') + 1];
    const network = args[args.indexOf('--network') + 1] || '';
    if (!args.includes('--name') || !own(name)) refuse('docker_foreign_object');
    // bridge (the edge), this run's network, or the namespace of one of this
    // run's containers (a fixture sidecar).
    const shared = network.startsWith('container:') ? network.slice('container:'.length) : '';
    if (!args.includes('--network') || !(own(network) || network === 'bridge' || own(shared))) refuse('docker_foreign_object');
    if (args[args.indexOf('--pull') + 1] !== 'never') refuse('docker_command_refused');
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (['-v', '--volume', '--mount', '--privileged', '--cap-add', '--device', '--pid', '--ipc', '--userns', '--volumes-from'].includes(a) || a.startsWith('--volume=') || a.startsWith('--mount=')) refuse('docker_command_refused');
      if ((a === '-p' || a === '--publish') && !/^127\.0\.0\.1::\d+$/.test(args[i + 1] || '')) refuse('docker_command_refused');
    }
    return 'write';
  }
  if (['start', 'port', 'logs', 'exec'].includes(cmd)) {
    const target = cmd === 'exec' ? args[1] : cmd === 'logs' ? args[args.length - 1] : args[1];
    if (!own(target)) refuse('docker_foreign_object');
    return cmd === 'exec' ? 'write' : 'read';
  }
  if (cmd === 'rm') {
    if (args[1] !== '-f' || args[2] !== '-v' || args.length < 4 || !args.slice(3).every(own)) refuse('docker_foreign_object');
    return 'write';
  }
  refuse('docker_command_refused');
}

export function defaultDockerExec(args, { timeoutMs = 120000 } = {}) {
  return new Promise(resolvePromise => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', () => { clearTimeout(timer); resolvePromise({ code: 127, stdout, stderr: 'docker_unavailable' }); });
    child.on('close', code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  });
}

// Once cleanup has begun (a signal, a fatal finding, the end of the run or
// --cleanup), only the teardown may still reach Docker: removing this run's
// containers and network, and listing what is left.
export function isTeardownCommand(args) {
  const [cmd, sub] = args;
  return cmd === 'rm' || cmd === 'ps' || (cmd === 'network' && (sub === 'rm' || sub === 'ls')) || (cmd === 'volume' && sub === 'ls');
}

export function createDocker({ runId, exec = defaultDockerExec, log = () => {}, stopped = () => false }) {
  const names = tempNames(runId);
  // Commands still running when cleanup begins (a `docker run` creating its
  // container as a signal arrives). Removal waits for them to settle, or the
  // container could appear after the leftover check has passed.
  const inflight = new Set();
  const run = async (args, { allowFail = false, timeoutMs } = {}) => {
    assertDockerArgs(args, runId);
    if (stopped() && !isTeardownCommand(args)) fail('docker_after_cleanup');
    const pending = exec(args, { timeoutMs });
    inflight.add(pending);
    let result;
    try { result = await pending; } finally { inflight.delete(pending); }
    log({ cmd: args[0] + (args[1] && !args[1].startsWith('-') && ['network', 'image', 'volume'].includes(args[0]) ? ' ' + args[1] : ''), code: result.code });
    if (result.code !== 0 && !allowFail) fail('docker_' + args[0] + '_failed');
    return result;
  };
  return {
    names, run,
    async settle() { while (inflight.size) await Promise.allSettled([...inflight]); },
    async leftovers() {
      const out = [];
      for (const args of [['ps', '-a', '--filter', 'name=pbp-it-', '--format', '{{.Names}}'], ['network', 'ls', '--filter', 'name=pbp-it-', '--format', '{{.Name}}'], ['volume', 'ls', '--filter', 'name=pbp-it-', '--format', '{{.Name}}']]) {
        const r = await run(args);
        out.push(...r.stdout.split('\n').map(s => s.trim()).filter(s => s.startsWith('pbp-it-')));
      }
      return out;
    },
    async ownLeftovers() {
      return (await this.leftovers()).filter(n => n.startsWith(names.prefix));
    },
    async userImage(kind) {
      const r = await run(['inspect', '--format', '{{.Image}}', USER_CONTAINERS[kind]], { allowFail: true });
      const id = r.stdout.trim();
      check(r.code === 0 && /^sha256:[0-9a-f]{64}$/.test(id), 'temp_image_missing');
      return id;
    },
    async image(ref) {
      const r = await run(['image', 'inspect', '--format', '{{.Id}}', ref], { allowFail: true });
      const id = r.stdout.trim();
      check(r.code === 0 && /^sha256:[0-9a-f]{64}$/.test(id), 'temp_image_missing');
      return id;
    },
    async state(name) {
      const r = await run(['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', name], { allowFail: true });
      return r.code === 0 ? r.stdout.trim() : 'missing';
    },
    async port(name, privatePort) {
      const r = await run(['port', name, privatePort + '/tcp']);
      const m = r.stdout.match(/127\.0\.0\.1:(\d+)/);
      check(m, 'temp_port_missing');
      return Number(m[1]);
    },
    async exec(name, cmd, opts) { return run(['exec', name, ...cmd], opts); },
    async logs(name) { return (await run(['logs', '--tail', '20', name], { allowFail: true })).stdout; },
    async remove(list) {
      if (list.length) await run(['rm', '-f', '-v', ...list], { allowFail: true });
    },
    async removeNetwork(net) { await run(['network', 'rm', net], { allowFail: true }); },
  };
}

// One script, two roles (Python from the linkding image). The edge forwards
// its 127.0.0.1-published ports to the services on the internal network
// (PBP_FORWARDS); a fixture sidecar serves the synthetic article on
// 127.0.0.1:PBP_FIXTURE_PORT inside a service's network namespace, only for
// GET/HEAD of ?pbp-it= URLs.
const EDGE_SCRIPT = String.raw`
import asyncio, base64, os
html = base64.b64decode(os.environ.get('PBP_FIXTURE_HTML_B64', ''))
fixture_port = int(os.environ.get('PBP_FIXTURE_PORT', '0') or 0)
fw = [x.split('=', 1) for x in os.environ.get('PBP_FORWARDS', '').split(',') if x]
async def pipe(r, w):
    try:
        while True:
            d = await r.read(65536)
            if not d: break
            w.write(d); await w.drain()
    except Exception: pass
    finally:
        try: w.close()
        except Exception: pass
def forward(host, port):
    async def handle(r, w):
        try: ur, uw = await asyncio.open_connection(host, int(port))
        except Exception:
            w.close(); return
        await asyncio.gather(pipe(r, uw), pipe(ur, w))
    return handle
async def fixture(r, w):
    try:
        req = await r.readuntil(b'\r\n\r\n')
        parts = req.split(b'\r\n', 1)[0].decode('latin-1').split(' ')
        ok = len(parts) >= 2 and parts[0] in ('GET', 'HEAD') and '?pbp-it=' in parts[1]
        body = html if ok else b'not found'
        head = 'HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n' % ('200 OK' if ok else '404 Not Found', 'text/html; charset=utf-8' if ok else 'text/plain', len(body))
        w.write(head.encode() + (body if parts[0] != 'HEAD' else b''))
        await w.drain()
    except Exception: pass
    finally: w.close()
async def main():
    servers = []
    if fixture_port:
        servers.append(await asyncio.start_server(fixture, '127.0.0.1', fixture_port))
        try: servers.append(await asyncio.start_server(fixture, '::1', fixture_port))
        except Exception: pass
    for listen, target in fw:
        host, port = target.rsplit(':', 1)
        servers.append(await asyncio.start_server(forward(host, port), '0.0.0.0', int(listen)))
    print('edge ready', flush=True)
    await asyncio.gather(*(s.serve_forever() for s in servers))
asyncio.run(main())
`;

const TEMP_SECRET_ENV = new Set(['LD_SUPERUSER_PASSWORD', 'POSTGRES_PASSWORD', 'LD_DB_PASSWORD', 'NEXTAUTH_SECRET']);
// The throwaway account also starts with automatic HTML snapshots off: each
// one runs Chromium inside the container, one at a time, and only the
// snapshot module waits for them (E2 in live-test-efficiency.md).
const LINKDING_TOKEN_SCRIPT = "from django.contrib.auth.models import User\nfrom bookmarks.models import ApiToken\nu=User.objects.get(username='pbp-it')\nu.profile.enable_automatic_html_snapshots=False\nu.profile.save()\nprint('PBPSNAPSHOTS='+str(u.profile.enable_automatic_html_snapshots))\nprint('PBPTOKEN='+ApiToken.objects.create(user=u,name='pbp-it').key)";
// Profile switches the runner may flip on a temporary linkding account, and
// only there. The REST API does not expose them for writing.
export const TEMP_PROFILE_FIELDS = Object.freeze(['enable_sharing', 'enable_automatic_html_snapshots']);
export function linkdingProfileScript(field, on) {
  check(TEMP_PROFILE_FIELDS.includes(field), 'temp_profile_field', true);
  const value = on ? 'True' : 'False';
  return `from django.contrib.auth.models import User\nu=User.objects.get(username='pbp-it')\nu.profile.${field}=${value}\nu.profile.save()\nprint('PBPPROFILE=${field}=' + str(u.profile.${field}))`;
}

// ---------------------------------------------------------------------------
// Fake AI: OpenAI-compatible chat completions on 127.0.0.1, metadata only.
// ---------------------------------------------------------------------------
export async function startFakeAi({ prefix, limit = 60 } = {}) {
  const key = 'pbp-fake-' + randomBytes(12).toString('hex');
  const marker = `${prefix} fake-ai`;
  const calls = [];
  const queues = { combined: [], tags: [], summary: [], connectivity: [] };
  const state = { failed: '', unknown: 0 };
  const replies = {
    summary: () => `${marker} summary v1: a synthetic bookmark note for the live harness.\nSecond line keeps > # ** <b> literal.`,
    tags: () => JSON.stringify([`${prefix}_ai_alpha`, `${prefix}_ai_beta`]),
    combined: () => JSON.stringify({ summary: replies.summary(), tags: JSON.parse(replies.tags()) }),
    connectivity: () => 'OK',
  };
  // Every tag a reply suggests carries the run prefix: the guards refuse a
  // write naming any other tag, so a foreign suggestion would only fail the
  // run later. A JSON reply is checked; free text is left to the guards.
  const foreignTags = (kind, content) => {
    if (kind !== 'tags' && kind !== 'combined') return false;
    let value;
    try { value = JSON.parse(content); } catch { return false; }
    const tags = kind === 'tags' ? value : value?.tags;
    return Array.isArray(tags) && tags.some(tag => !String(tag).startsWith(String(prefix || '')));
  };
  let port = 0;
  const server = createServer((req, res) => {
    const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const remote = req.socket.remoteAddress || '';
    const n = calls.length + 1;
    const meta = { n, path: (req.url || '').split('?')[0], method: req.method, kind: 'unknown', model: '', stream: false, promptBytes: 0, hasPrefix: false, auth: false, status: 0 };
    calls.push(meta);
    const reject = (status, code) => { meta.status = status; state.failed ||= code; if (code === 'fake_ai_unknown_request') state.unknown++; send(status, { error: { message: code, type: 'pbp_fake_ai' } }); };
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(remote) || req.headers.host !== `127.0.0.1:${port}`) return reject(403, 'fake_ai_foreign_client');
    if (n > limit) return reject(503, 'fake_ai_budget');
    if (req.method !== 'POST' || meta.path !== '/v1/chat/completions') return reject(404, 'fake_ai_unknown_request');
    meta.auth = req.headers.authorization === 'Bearer ' + key;
    if (!meta.auth) return reject(401, 'fake_ai_auth');
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; if (raw.length > 2_000_000) req.destroy(); });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { return reject(404, 'fake_ai_unknown_request'); }
      const prompt = (Array.isArray(body?.messages) ? body.messages : []).filter(m => m && m.role !== 'system').map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
      meta.model = typeof body?.model === 'string' ? body.model.slice(0, 60) : '';
      meta.stream = body?.stream === true;
      meta.promptBytes = Buffer.byteLength(prompt);
      meta.hasPrefix = !!prefix && prompt.includes(prefix);
      meta.kind = classifyPrompt(prompt);
      if (meta.kind === 'unknown') return reject(404, 'fake_ai_unknown_request');
      const queued = queues[meta.kind].shift();
      const content = String(typeof queued === 'function' ? queued(meta) : queued ?? replies[meta.kind]());
      if (foreignTags(meta.kind, content)) return reject(503, 'fake_ai_foreign_tag');
      meta.status = 200;
      const usage = { prompt_tokens: Math.ceil(meta.promptBytes / 4), completion_tokens: Math.ceil(content.length / 4) };
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      if (meta.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const step = Math.max(1, Math.ceil(content.length / 3));
        for (let i = 0; i < content.length; i += step) res.write(`data: ${JSON.stringify({ id: 'chatcmpl-pbp-' + n, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: content.slice(i, i + step) }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-pbp-' + n, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(body?.stream_options?.include_usage ? { usage } : {}) })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      send(200, { id: 'chatcmpl-pbp-' + n, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: meta.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage });
    });
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    key, port, origin, base: origin + '/v1', path: '/v1/chat/completions', marker, limit,
    calls: kind => calls.filter(c => c.status === 200 && (!kind || c.kind === kind)).length,
    all: () => calls.map(c => ({ ...c })),
    unknown: () => state.unknown,
    failed: () => state.failed,
    expect({ kind, reply }) { check(queues[kind], 'fake_ai_kind'); check(typeof reply === 'function' || !foreignTags(kind, String(reply)), 'fake_ai_foreign_tag'); queues[kind].push(reply); },
    reset() { for (const q of Object.values(queues)) q.length = 0; },
    close: () => new Promise(r => server.close(() => r())),
  };
}

// ---------------------------------------------------------------------------
// Screenshots: masked, canary-checked, geometry recorded.
// ---------------------------------------------------------------------------
// Masked in every screenshot. Switches whose id mentions a key (e.g.
// opt-sync-api-keys) hold no secret and stay visible.
const FIELD = 'input:not([type="checkbox"]):not([type="radio"])';
export const SECRET_FIELD_SELECTOR = ['input[type="password"]', ...['token', 'secret', 'key', 'gw-value', 'cf-id'].map(word => `${FIELD}[id*="${word}" i]`), 'textarea[id*="token" i]', 'textarea[id*="secret" i]'].join(', ');

// Text that names the signed-in account (Pinboard's "Connected as <name>").
export const ACCOUNT_TEXT_SELECTOR = '#test-pinboard-status';

export async function takeShot(page, { file, secrets = [], keys = [] }) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (typeof pbpI18nReady === 'function') await pbpI18nReady();
  });
  const revealed = await page.evaluate(() => {
    const rx = /token|secret|key|gw-value/i, bad = [];
    for (const el of document.querySelectorAll('input, textarea')) {
      if (el.type === 'checkbox' || el.type === 'radio' || /cf-id/i.test(el.id || '')) continue;
      if (rx.test(el.id || '') && el.type !== 'password') bad.push(el.id);
    }
    for (const btn of document.querySelectorAll('.key-toggle[aria-pressed="true"]')) if (rx.test(btn.dataset.target || '')) bad.push(btn.dataset.target);
    return bad.length;
  });
  if (revealed) return { ok: false, code: 'shot_secret_field_revealed' };
  const geometry = await page.evaluate(selectors => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const doc = document.documentElement, scroller = document.scrollingElement || doc;
    const overflow = doc.scrollWidth - vw;
    // The viewport takes html's overflow, or body's when html's is visible.
    const htmlStyle = getComputedStyle(doc), bodyStyle = document.body ? getComputedStyle(document.body) : null;
    const viewportOverflow = axis => htmlStyle[axis] !== 'visible' || !bodyStyle ? htmlStyle[axis] : bodyStyle[axis];
    const userScrolls = value => value !== 'hidden' && value !== 'clip';
    const describe = el => el.tagName.toLowerCase() + (/^[A-Za-z0-9_-]{1,40}$/.test(el.id) ? '#' + el.id : '')
      + [...el.classList].filter(c => /^[A-Za-z0-9_-]{1,40}$/.test(c)).slice(0, 2).map(c => '.' + c).join('');
    // Evidence for a horizontal overflow: the outermost boxes past the right edge.
    const overflowBy = [];
    if (overflow > 1) {
      const wide = [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1; });
      for (const el of wide.filter(el => !wide.includes(el.parentElement)).slice(0, 3)) {
        const r = el.getBoundingClientRect();
        overflowBy.push({ el: describe(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
      }
    }
    // missing: not in the DOM; hidden: zero-sized (display:none, a consumed
    // action); ok: fully in view; scroll: reachable by scrolling the page or
    // a scrollable ancestor (a toolbar popup is at most 600px tall and
    // scrolls vertically); clipped: cut off where nothing can scroll
    // (overflow hidden or clip, or past the edge of a page that clips
    // horizontally).
    const keyState = selectors.map(sel => {
      const el = document.querySelector(sel);
      if (!el) return { selector: sel, state: 'missing', inViewport: false };
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return { selector: sel, state: 'hidden', inViewport: false };
      let clipped = false, inScroller = false;
      for (let a = el.parentElement; a && a !== document.body && a !== doc; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const ar = a.getBoundingClientRect();
        const outX = r.left < ar.left - 1 || r.right > ar.right + 1, outY = r.top < ar.top - 1 || r.bottom > ar.bottom + 1;
        if ((outX && !userScrolls(s.overflowX)) || (outY && !userScrolls(s.overflowY))) { clipped = true; break; }
        if (outX || outY) inScroller = true;
      }
      const inX = r.left >= -1 && r.right <= vw + 1, inY = r.top >= -1 && r.bottom <= vh + 1;
      const top = r.top + scroller.scrollTop, left = r.left + scroller.scrollLeft;
      const reachX = inX || (userScrolls(viewportOverflow('overflowX')) && left >= -1 && left + r.width <= scroller.scrollWidth + 1);
      const reachY = inY || (userScrolls(viewportOverflow('overflowY')) && top >= -1 && top + r.height <= scroller.scrollHeight + 1);
      const state = clipped || !reachX || !reachY ? 'clipped' : inX && inY && !inScroller ? 'ok' : 'scroll';
      return { selector: sel, state, inViewport: inX && inY && !inScroller && !clipped };
    });
    return {
      viewport: { width: vw, height: vh }, scrollWidth: scroller.scrollWidth, scrollHeight: scroller.scrollHeight,
      overflow, overflowOk: overflow <= 1, overflowBy, keys: keyState,
      ok: overflow <= 1 && keyState.every(k => k.state === 'ok' || k.state === 'scroll'),
    };
  }, keys);
  await page.screenshot({ path: file, mask: [page.locator(SECRET_FIELD_SELECTOR), page.locator(ACCOUNT_TEXT_SELECTOR)], animations: 'disabled', caret: 'hide' });
  chmodSync(file, 0o600);
  const texts = await page.evaluate(() => {
    const out = [document.title, document.body ? document.body.innerText : ''];
    for (const el of document.querySelectorAll('input, textarea')) if (el.type !== 'password') out.push(el.value || '');
    for (const el of document.querySelectorAll('[title], [aria-label]')) out.push(el.getAttribute('title') || '', el.getAttribute('aria-label') || '');
    return out;
  });
  if (findSecret(texts, secrets)) { rmSync(file, { force: true }); return { ok: false, code: 'shot_secret_canary' }; }
  return { ok: true, geometry };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
// The summary file is read on one screen.
export const SUMMARY_MAX_LINES = 40;

export class LiveRun {
  constructor(opts) {
    this.opts = opts;
    this.runId = randomUUID();
    this.prefix = 'pbp-it-' + this.runId;
    this.state = stateDir();
    this.runDir = join(this.state, 'pbp-it-' + this.runId);
    this.reportPath = join(this.runDir, 'report.json');
    this.secrets = [];
    // Account names (the Pinboard user name) are redacted from the report
    // like secrets, but never canary-checked: a short name would match
    // ordinary page text.
    this.accountNames = [];
    // In-process only (the preflight's mock): { transport, intervalMs, mock }.
    // The CLI never sets it, so a real run always uses pinboardHttp and the
    // 3 s interval.
    this.pinboardOpts = opts.pinboard || null;
    this.instances = {};
    this.pools = {};
    this.claimed = {};
    this.counts = {};
    this.phaseName = 'configuration';
    this.stage = 'configuration';
    this.cleaning = false;
    this.fatal = null;
    this.pages = new Set();
    this.consoleSeen = [];
    this.guardCfg = null;
    // Creations in flight per instance ({ bookmarks, lists }), counted by
    // the caps until their answer is recorded.
    this.pending = {};
    this.deletableTags = new Set();
    // A --cleanup of a report on disk (resumeCleanup) deletes no list.
    this.resumed = false;
    this.sharing = {};
    this.snapshots = {};
    this.shotCount = 0;
    this.locale = 'en';
    this.scheme = 'light';
    this.report = {
      harness: HARNESS_VERSION, runId: this.runId, prefix: this.prefix, mode: opts.mode, started: new Date().toISOString(),
      head: '', clean: null, target: '', scenario: '', modules: [], skipped: [], instances: {}, pools: {},
      ledger: { created: [], lists: [], tags: [] }, counts: {}, checks: [], readBackDiffs: [], console: [], swConsole: [],
      pageErrors: [], requestFailed: [], blockedOrigins: [], blockedSamples: [], violations: [], findings: [], shots: { dir: '', count: 0, manifest: '' },
      fakeAi: null, temp: null, cleanup: { complete: false, entries: [] }, failure: null, finished: null, passed: false,
      stages: [], timing: { phases: [], totals: {}, slowest: [], throttle: null }, pinboard: null,
    };
    // The live counters themselves: every persist() carries them, so a run
    // cut off by kill -9, OOM, a crash or a second signal (none reaches
    // cleanupAll) still leaves its request counts on disk for --cleanup.
    this.report.counts = this.counts;
  }

  // Wall time of the setup steps and the cleanup (modules carry their own
  // started/finished), so a slow stage shows up without a profiler.
  async timed(name, fn) {
    const started = new Date();
    const stage = { name, started: started.toISOString(), ms: 0, ok: false, requests: 0, waitMs: 0, throttleMs: 0 };
    const requestsBefore = this.requestTotal();
    const outer = this.openStage;
    this.openStage = stage;
    try { const value = await fn(); stage.ok = true; return value; } finally {
      this.openStage = outer;
      stage.ms = Date.now() - started.getTime();
      stage.requests = this.requestTotal() - requestsBefore;
      this.report.stages.push(stage);
      this.persist();
    }
  }

  // Requests sent so far, every instance and the fake AI.
  requestTotal() {
    return Object.values(this.counts).reduce((n, c) => n + c.node + c.browser + c.setup, 0) + (this.aiCount || 0);
  }
  // Time spent waiting (until/waitFor polls, module sleeps: "wait") or at the
  // Pinboard gate ("throttle"), charged to the run, the open stage, the
  // module and its current phase.
  noteWait(kind, ms) {
    const key = kind + 'Ms';
    const add = obj => { if (obj) obj[key] = (obj[key] || 0) + ms; };
    add(this.report.timing.totals);
    add(this.openStage);
    add(this.openPhase);
    if (this.currentModule?.record) add(this.currentModule.record.timing ||= {});
  }
  // Module phases (t.phase) are timed one after the other; the next phase,
  // or the module's end, closes the open one.
  closePhase() {
    const open = this.openPhase;
    if (!open) return;
    this.openPhase = null;
    open.ms = Date.now() - open.startedAt;
    open.requests = this.requestTotal() - open.requestsBefore;
    delete open.startedAt;
    delete open.requestsBefore;
    this.report.timing.phases.push(open);
  }
  openModulePhase(name) {
    this.closePhase();
    if (!this.currentModule) return;
    this.openPhase = { module: this.currentModule.id, name, ms: 0, requests: 0, waitMs: 0, throttleMs: 0, startedAt: Date.now(), requestsBefore: this.requestTotal() };
  }
  // Totals by kind and the five slowest spans (setup and cleanup stages,
  // module phases), for the summary.
  timingSummary() {
    const timing = this.report.timing;
    const stageMs = prefix => this.report.stages.filter(st => st.name === prefix || st.name.startsWith(prefix + ':')).reduce((n, st) => n + st.ms, 0);
    Object.assign(timing.totals, {
      containerStartMs: stageMs('temp_start'), browserStartMs: stageMs('browser_start'), connectMs: stageMs('connect'), cleanupMs: stageMs('cleanup'),
      modulesMs: this.report.modules.reduce((n, m) => n + (m.ms || 0), 0), waitMs: timing.totals.waitMs || 0, throttleMs: timing.totals.throttleMs || 0,
    });
    const spans = [...this.report.stages.map(st => ({ name: st.name, ms: st.ms, requests: st.requests || 0, waitMs: st.waitMs || 0, throttleMs: st.throttleMs || 0 })),
      ...timing.phases.map(ph => ({ name: ph.module + ' ' + ph.name, ms: ph.ms, requests: ph.requests, waitMs: ph.waitMs || 0, throttleMs: ph.throttleMs || 0 }))];
    timing.slowest = spans.sort((a, b) => b.ms - a.ms).slice(0, 5);
    return timing;
  }

  // Free text (module notes, console lines) may echo anything: redact the
  // whole report on every write, not only the fields known to carry text.
  persist() { if (existsSync(this.runDir)) writePrivateJson(this.reportPath, this.sanitizeReport(this.report)); }
  // Secrets go everywhere. Account names go everywhere but object keys and
  // a value of a field the harness itself writes (REPORT_IDENTIFIER_KEYS)
  // that is exactly the name: a user called "pinboard" or "passed" must not
  // turn the instance id or a module status into [account], or --cleanup
  // refuses its own report. Such a value names the harness's own state, not
  // the account.
  sanitizeReport(report) {
    const parsed = JSON.parse(redact(JSON.stringify(report), this.secrets));
    const walk = (value, key) => {
      if (typeof value === 'string') return REPORT_IDENTIFIER_KEYS.has(key) && this.accountNames.includes(value) ? value : this.maskAccounts(value);
      if (Array.isArray(value)) return value.map(item => walk(item, key));
      if (value && typeof value === 'object') { for (const k of Object.keys(value)) value[k] = walk(value[k], k); }
      return value;
    };
    return walk(parsed, '');
  }
  sanitize(text) { return this.maskAccounts(redact(text, this.secrets)); }
  maskAccounts(text) {
    let out = text;
    // Whole names only, and never a JSON key (the instance id "pinboard"
    // must survive a user called pinboard).
    for (const name of this.accountNames) {
      const esc = name.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
      out = out.replace(new RegExp(`(?<![A-Za-z0-9_.-])${esc}(?![A-Za-z0-9_.-])(?!":)`, 'g'), '[account]');
    }
    return out;
  }
  addSecret(value) { if (typeof value === 'string' && value && !this.secrets.includes(value)) this.secrets.push(value); }
  phase(name) {
    this.phaseName = name;
    if (this.currentModule) this.openModulePhase(name);
    this.throwIfFatal();
  }
  setFatal(code) {
    if (!this.fatal) { this.fatal = code; this.report.violations.push({ code, phase: this.phaseName }); this.persist(); }
  }
  throwIfFatal() { if (this.fatal) throw new HarnessFailure(this.fatal, { fatal: true }); }
  count(instance) {
    return (this.counts[instance] ||= { node: 0, browser: 0, browserWrites: 0, sw: 0, setup: 0 });
  }

  // ---- Node API ------------------------------------------------------------
  async api(instance, path, { method = 'GET', body, allow404 = false, auth = true, accept = 'json', allowStatus = [] } = {}) {
    // After a guard violation the run stops, but cleanup still needs the API.
    if (!this.cleaning) this.throwIfFatal();
    const inst = this.instances[instance];
    check(inst, 'api_instance', true);
    if (inst.service === 'pinboard') return this.pinboardApi(instance, path, { allow404 });
    const url = new URL(path, inst.root).href;
    check(url.startsWith(auth ? inst.root : inst.base), 'api_origin', true);
    const guard = this.nodeGuard(instance, method, url, body);
    const c = this.count(instance);
    const cap = this.caps[instance];
    const limit = this.cleaning ? cap.node : cap.node - this.reserve[instance];
    if (++c.node > limit) { this.setFatal(this.cleaning ? 'cleanup_request_budget' : 'node_request_budget'); this.throwIfFatal(); }
    // What leaves counts from here, before any wait: the run tags it names,
    // and a create's slot until its answer is recorded.
    if (guard.tags.length) this.noteTags(instance, guard.tags.map(key => ({ key })), 'node');
    const release = guard.create ? this.hold(instance, 'bookmarks') : null;
    const headers = { Accept: accept === 'json' ? 'application/json' : 'text/html' };
    if (auth && inst.service !== 'pinboard') headers.Authorization = (inst.service === 'linkding' ? 'Token ' : 'Bearer ') + inst.token;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, { method, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000), headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    // A create the service refused (4xx) made nothing. Without an answer or
    // after a server error it may have: the slot stays held.
    if (release && !response.ok && response.status < 500) release();
    if (allow404 && response.status === 404) return null;
    // A module reproducing a server failure names the status it expects:
    // nothing is parsed or recorded as created.
    if (!response.ok && allowStatus.includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      return { failedStatus: response.status };
    }
    check(response.ok, 'api_http_' + response.status);
    if (response.status === 204) return null;
    if (accept !== 'json') return response.text();
    check((response.headers.get('content-type') || '').includes('json'), 'api_not_json');
    const data = await response.json();
    if (guard.create) {
      const actual = rowUrl(inst.service, data);
      check(actual === guard.create, 'seed_response_url', true);
      this.recordCreated({ instance, id: String(data.id), url: actual, source: 'node' });
      release();
      // The worker guard must know a seeded bookmark before the extension
      // edits it, or it refuses the edit as foreign.
      await this.shareCreated({ instance, id: String(data.id), url: actual });
    }
    return data;
  }

  // ---- Pinboard ------------------------------------------------------------
  pinboardGate() {
    if (!this.gate) {
      const mock = this.pinboardOpts?.mock === true && typeof this.pinboardOpts.transport === 'function';
      // Only the in-process mock may shorten the interval.
      const intervalMs = mock && Number.isFinite(this.pinboardOpts.intervalMs) ? this.pinboardOpts.intervalMs : PINBOARD_MIN_INTERVAL_MS;
      this.gate = createPinboardGate({
        intervalMs, onWait: ms => this.noteWait('throttle', ms),
        // Ten at most in the report; the gate's stats count all of them.
        onSlow: ({ queuedMs, depth }) => {
          if (this.report.findings.filter(f => f.kind === 'pinboard_queue').length >= 10) return;
          this.report.findings.push({ kind: 'pinboard_queue', module: this.currentModule?.id || '', phase: this.phaseName, queuedMs, depth });
        },
      });
      this.pinboardTransport = mock ? this.pinboardOpts.transport : pinboardHttp;
      this.report.timing.throttle = this.gate.stats;
    }
    return this.gate;
  }

  // Every Pinboard request of the run, extension or Node, leaves through
  // here: the URL must carry this run's token (another account's token is a
  // guard violation), then it waits its turn at the gate.
  async pinboardSend(instance, url) {
    const inst = this.instances[instance];
    check(inst?.service === 'pinboard' && pinboardEndpoint(url), 'api_origin', true);
    // Exactly one auth_token, this run's: a second one is what a server
    // reading the last value would use.
    let tokens = [];
    try { tokens = new URL(url).searchParams.getAll('auth_token'); } catch { /* refused below */ }
    if (!inst.token || tokens.length !== 1 || tokens[0] !== inst.token) { this.setFatal('live_guard_pinboard_token'); this.throwIfFatal(); }
    const gate = this.pinboardGate();
    return gate.run(() => this.pinboardTransport(url));
  }

  // The runner's own Pinboard calls: posts/get and tags/get any time,
  // posts/delete only during cleanup and only for a run URL in the ledger.
  // A 429 is retried after the gate's backoff, each retry a counted request.
  async pinboardApi(instance, path, { allow404 = false } = {}) {
    const inst = this.instances[instance];
    const url = new URL(path, PINBOARD_ROOT);
    const endpoint = pinboardEndpoint(url.href);
    const refuse = code => { this.setFatal(code); throw new HarnessFailure(code, { fatal: true }); };
    if (!PINBOARD_ENDPOINTS.node.includes(endpoint)) refuse('node_guard_pinboard_endpoint');
    if (url.searchParams.getAll('url').length > 1) refuse('node_guard_pinboard_params');
    if (endpoint === 'posts/delete') {
      const target = url.searchParams.get('url');
      this.writesPossible = true;
      if (!this.cleaning || !(this.pools[instance] || []).includes(target) || !this.report.ledger.created.some(r => r.instance === instance && r.url === target && !r.deleted)) refuse('node_guard_mutation');
    }
    url.searchParams.set('auth_token', inst.token);
    url.searchParams.set('format', 'json');
    const c = this.count(instance);
    const cap = this.caps[instance];
    for (let attempt = 0; ; attempt++) {
      const limit = this.cleaning ? cap.node : cap.node - this.reserve[instance];
      if (++c.node > limit) { this.setFatal(this.cleaning ? 'cleanup_request_budget' : 'node_request_budget'); this.throwIfFatal(); }
      const res = await this.pinboardSend(instance, url.href);
      if (res.status === 429 && attempt < PINBOARD_429_RETRIES) continue;
      if (allow404 && res.status === 404) return null;
      check(res.status === 200, 'api_http_' + res.status);
      try { return JSON.parse(res.body); } catch { fail('api_not_json'); }
    }
  }

  // The post Pinboard holds for one URL, or null.
  async pinboardPost(instance, target) {
    const data = await this.api(instance, 'posts/get?url=' + encodeURIComponent(target));
    check(Array.isArray(data?.posts), 'pinboard_posts_shape');
    const post = data.posts[0] || null;
    if (post) check(post.href === target, 'pinboard_post_url', true);
    return post;
  }

  // Node-side writes may only touch this run's objects, and count against
  // the run's caps by the browser layers' rule. Returns what a write may
  // create: a pool URL, and the run-prefix tag keys it names first.
  nodeGuard(instance, method, url, body) {
    const none = { create: '', tags: [] };
    if (method === 'GET' || method === 'HEAD') return none;
    this.writesPossible = true;
    const inst = this.instances[instance];
    const segs = url.slice(inst.root.length).split('?')[0].split('/').filter(Boolean);
    const own = id => this.report.ledger.created.some(r => r.instance === instance && r.id === String(id) && !r.deleted);
    const refuse = code => { this.setFatal(code); throw new HarnessFailure(code, { fatal: true }); };
    // What the checks here allow, the rule allows too unless a cap would be
    // passed; the caps are the rule's alone.
    const capped = create => {
      const decision = liveGuardRule({ ...this.buildGuardCfg(), writes: true }, this.guardView(), { url, method, body });
      if (!decision.ok) refuse(decision.code);
      return { create, tags: decision.tags || [] };
    };
    if (method === 'POST' && segs.length === 1 && segs[0] === 'bookmarks' && !this.cleaning) {
      const pool = this.pools[instance] || [];
      if (!pool.includes(body?.url) || this.report.ledger.created.some(r => r.instance === instance && r.url === body.url)) refuse('node_guard_create');
      return capped(body.url);
    }
    if (segs[0] === 'bookmarks' && segs[1] && own(segs[1])) {
      if (method === 'DELETE' && segs.length === 2 && !this.cleaning) refuse('node_guard_mutation');
      return this.cleaning ? none : capped('');
    }
    if (this.cleaning && method === 'DELETE' && segs.length === 2) {
      if (segs[0] === 'lists' && this.report.ledger.lists.some(l => l.instance === instance && l.id === segs[1])) return none;
      if (segs[0] === 'tags' && this.deletableTags.has(instance + ':' + segs[1])) return none;
    }
    refuse('node_guard_mutation');
  }

  // The configuration the guard rule judges by: both browser layers (the
  // worker gets it as JSON) and, with writes on, the Node layer.
  buildGuardCfg() {
    const ids = Object.keys(this.instances);
    const capOf = (id, key) => this.caps?.[id]?.[key] ?? 0;
    return {
      instances: Object.fromEntries(Object.values(this.instances).map(i => [i.id, { service: i.service, base: i.base, root: i.root }])),
      pools: this.pools, listMarker: LIST_MARKER, writes: false,
      aiOrigin: this.fakeAi ? this.fakeAi.origin : '', aiPath: this.fakeAi ? this.fakeAi.path : '',
      caps: Object.fromEntries(ids.map(id => [id, capOf(id, 'browser')])),
      limits: Object.fromEntries(ids.map(id => [id, { bookmarks: capOf(id, 'bookmarks'), lists: capOf(id, 'lists'), tags: capOf(id, 'tags') }])),
      prefix: this.prefix,
    };
  }
  guardView() {
    const { created, lists, tags } = this.report.ledger;
    return { created, lists, tags, pending: this.pending };
  }
  // A creation in flight holds its slot, so one sent meanwhile is judged as
  // if this one had succeeded. The returned release frees it once.
  hold(instance, slot) {
    const pending = (this.pending[instance] ||= { bookmarks: 0, lists: 0 });
    pending[slot]++;
    let held = true;
    return () => { if (held) { held = false; pending[slot]--; } };
  }

  recordCreated(entry) {
    const ledger = this.report.ledger.created;
    // Known already: a later report of the same creation. (A Pinboard URL
    // the run deleted and saves again is reopened by reservePinboardCreate,
    // which the route calls before the save leaves.)
    if (ledger.some(r => r.instance === entry.instance && r.id === entry.id)) return;
    const total = ledger.filter(r => r.instance === entry.instance).length + 1;
    ledger.push({ ...entry, module: this.currentModule?.id || '', deleted: false });
    this.persist();
    if (total > this.caps[entry.instance].bookmarks) this.setFatal('bookmark_budget');
    if (this.currentModule && this.currentModule.created + 1 > this.currentModule.budget.bookmarks) this.setFatal('module_bookmark_budget');
    if (this.currentModule) this.currentModule.created++;
  }
  recordList(entry) {
    if (this.report.ledger.lists.some(l => l.instance === entry.instance && l.id === entry.id)) return;
    this.report.ledger.lists.push({ ...entry, module: this.currentModule?.id || '' });
    this.persist();
    if (this.report.ledger.lists.filter(l => l.instance === entry.instance).length > this.caps[entry.instance].lists) this.setFatal('list_budget');
  }
  // Run-prefix tag keys (liveTagKey), once per instance: reserved as a write
  // naming them leaves (source route, sw or node) or found on a read-back
  // (read), which also fills in the id. The guards refuse a write past the
  // tag cap before it leaves, so only a tag no write named can pass the cap
  // here, which is fatal.
  noteTags(instance, entries, source) {
    const tags = this.report.ledger.tags;
    const added = [];
    let changed = false;
    for (const { key, id = '' } of entries) {
      const known = tags.find(t => t.instance === instance && t.key === key);
      if (known) { if (id && !known.id) { known.id = id; changed = true; } continue; }
      const entry = { instance, key, id, source, module: this.currentModule?.id || '' };
      tags.push(entry);
      added.push({ instance, key });
      changed = true;
    }
    if (!changed) return;
    this.persist();
    // The worker reports its own; tell it the others.
    if (added.length && source !== 'sw') this.shareGuard('tags', added);
    if (added.length && tags.filter(t => t.instance === instance).length > (this.caps?.[instance]?.tags ?? 0)) this.setFatal('tag_budget');
  }
  trackTag(instance, tag) {
    const key = liveTagKey(this.instances[instance]?.service, tag.name);
    if (!key.toLowerCase().startsWith(this.prefix)) return;
    this.noteTags(instance, [{ key, id: tag.id == null ? '' : String(tag.id) }], 'read');
  }

  // ---- configuration -------------------------------------------------------
  configure() {
    const { values, flags, errors } = this.opts;
    check(!errors.length, errors[0] || 'arguments');
    const target = values.target || 'temp';
    check(['temp', 'user'].includes(target), 'target');
    this.target = target;
    this.report.target = target;
    const services = values.service ? values.service.split(',').map(s => s.trim()) : [...DEFAULT_SERVICES];
    check(services.length && services.every(s => SERVICE_TYPES.includes(s)), 'service');
    let scenario = values.scenario || 'core';
    if (flags.has('--read-only')) { check(!values.scenario || values.scenario === 'readonly', 'read_only_conflict'); scenario = 'readonly'; }
    this.report.scenario = scenario;
    const { selected, skipped } = selectModules(scenario, { services, target, modules: this.opts.modules || MODULES });
    check(selected.length, 'no_modules_selected');
    this.report.skipped = skipped;
    this.selected = selected;
    this.shotsEnabled = flags.has('--shots') || !!values['shots-dir'];
    this.plan = buildPlan({ target, selected, skipped, shotsEnabled: this.shotsEnabled, headedFlag: flags.has('--headed') });
    check(this.plan.withinCaps, 'budget_exceeded_plan');
    this.caps = {};
    this.reserve = {};
    for (const instance of this.plan.instances) {
      this.caps[instance] = BUDGETS[target][instance];
      this.reserve[instance] = this.plan.budget[instance].cleanupReserve;
    }
    if (target === 'user') {
      for (const instance of this.plan.instances) {
        const service = this.plan.budget[instance].service;
        // Pinboard's API has one fixed root; no base is taken for it.
        if (service === 'pinboard') {
          this.instances[instance] = { id: instance, service, base: '', root: PINBOARD_ROOT, token: '' };
          continue;
        }
        check(values[service], 'missing_base');
        const base = validateBase(values[service]);
        this.instances[instance] = { id: instance, service, base, root: apiRootFor(service, base), token: '' };
      }
      check(!this.plan.karakeepWritesRequireAutoAiDisabled || flags.has('--confirm-karakeep-no-auto-ai'), 'karakeep_auto_ai_not_confirmed_off');
      check(values.authorization, 'authorization_required');
      this.authorization = validateAuthorizationLabel(values.authorization);
    } else {
      check(!values.credentials && !values.linkding && !values.karakeep, 'temp_target_rejects_user_endpoints');
    }
    if (values['shots-dir']) {
      const dir = resolve(values['shots-dir']);
      check(!dir.startsWith(resolve(ROOT, 'docs')), 'shots_dir_public');
      if (dir.startsWith(ROOT)) check(spawnSync('git', ['-C', ROOT, 'check-ignore', '-q', dir]).status === 0, 'shots_dir_not_ignored');
      this.shotsDir = dir;
    }
  }

  // ---- lifecycle ------------------------------------------------------------
  async execute() {
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
    chmodSync(this.runDir, 0o700);
    this.persist();
    let release = () => {};
    // Signals and uncaught errors run the same cleanup as a normal exit; a
    // second signal skips it and leaves the report marked incomplete, so the
    // next run refuses to start until --cleanup has finished the job. The
    // forced exit still drops this run's lock: the incomplete report alone
    // keeps other runs out, and --cleanup can start at once.
    const removeSignals = installSignalHandlers({
      onFirst: signal => {
        this.report.interrupted = signal;
        this.report.failure ||= { phase: this.phaseName, code: 'interrupted_' + signal.toLowerCase() };
        this.setFatal('interrupted_' + signal.toLowerCase());
        this.closeBrowserNow();
        this.finalize().finally(() => { this.conclude(); release(); process.exit(130); });
      },
      onForce: () => {
        this.report.cleanup.complete = false;
        this.report.cleanup.forced = true;
        this.report.failure = { phase: this.phaseName, code: 'cleanup_incomplete' };
        this.report.passed = false;
        this.persist();
        release();
        console.error('Cleanup skipped by a second signal; finish it with --cleanup ' + this.reportPath);
        process.exit(130);
      },
    });
    const onUncaught = error => {
      if (this.cleaning) return;
      this.report.failure ||= { phase: this.phaseName, code: 'uncaught_' + failureCode(error, this.secrets) };
      this.setFatal('uncaught_error');
      this.closeBrowserNow();
      this.finalize().finally(() => { this.conclude(); release(); process.exit(1); });
    };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
    try {
      this.configure();
      this.stage = 'preconditions';
      // Lock first: a run still in progress reports run_locked, not an
      // incomplete cleanup.
      release = acquireLock(this.state, { pid: process.pid, runId: this.runId, reportPath: this.reportPath, started: this.report.started });
      const incomplete = scanIncompleteReports(this.state, this.runId);
      if (incomplete.length) { for (const file of incomplete) console.error('Previous report not cleaned: ' + file); fail('previous_cleanup_incomplete'); }
      const head = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      this.report.head = head.status === 0 ? head.stdout.trim() : '';
      const status = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
      this.report.clean = status.status === 0 && status.stdout.trim() === '';
      check(this.report.clean || this.opts.flags.has('--allow-dirty'), 'worktree_dirty');
      this.report.allowDirty = this.opts.flags.has('--allow-dirty');
      this.report.plan = { instances: this.plan.budget, fakeAi: this.plan.fakeAi, limits: this.plan.limits };
      this.runDeadline = Date.now() + BUDGETS[this.target].run.runMinutes * 60000;
      this.runTimer = setTimeout(() => { this.setFatal('run_time_budget'); this.closeBrowserNow(); }, BUDGETS[this.target].run.runMinutes * 60000);
      this.runTimer.unref();
      for (const instance of this.plan.instances) {
        const count = this.plan.budget[instance].urls;
        this.pools[instance] = poolUrls(this.target, this.runId, instance, count);
        this.claimed[instance] = 0;
      }
      this.report.pools = this.pools;
      this.persist();
      if (this.target === 'user') {
        this.report.authorization = claimAuthorizationRound(this.state, this.authorization, { runId: this.runId, started: this.report.started, scenario: this.report.scenario }, BUDGETS.user.run.roundsPerAuthorization);
        this.persist();
      }
      if (this.target === 'temp') await this.timed('temp_start', () => this.startTemp());
      else await this.timed('credentials', () => this.loadCredentials());
      // Every module may have been skipped (no pinboardToken): nothing to start.
      if (this.selected.length) {
        await this.timed('preflight', () => this.preflight());
        if (this.selected.some(m => m.needs?.fakeAi)) await this.timed('fake_ai_start', () => this.startFakeAi());
        await this.timed('browser_start', () => this.setupBrowser());
        for (const instance of this.plan.instances) {
          await this.timed('connect:' + instance, () => this.connect(instance));
          for (const mod of this.selected.filter(m => m.instance === instance)) await this.runModule(mod);
        }
      } else console.log('No module left to run after the skips above.');
      this.stage = 'final';
      await this.syncGuard();
      this.throwIfFatal();
      check(!this.report.pageErrors.some(e => !e.module), 'browser_page_error');
    } catch (error) {
      this.report.failure ||= { phase: this.phaseName, code: failureCode(error, this.secrets) };
      console.error('FAILED ' + this.phaseName + ': ' + this.report.failure.code);
    } finally {
      await this.finalize();
      removeSignals();
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUncaught);
      release();
      this.conclude();
    }
    return this.report.passed ? 0 : 1;
  }

  conclude() {
    if (this.concluded) return;
    this.concluded = true;
    this.timingSummary();
    const modulesFailed = this.report.modules.some(m => m.status !== 'passed');
    this.report.passed = !this.report.failure && !modulesFailed && this.report.cleanup.complete === true && this.report.cleanup.apiVerified !== false;
    this.persist();
    this.writeSummary();
    console.log('Local report: ' + this.reportPath);
    if (this.summaryPath) console.log('Summary: ' + this.summaryPath);
    const created = this.report.ledger.created.length;
    console.log('Created bookmarks: ' + created + '; deleted: ' + this.report.ledger.created.filter(r => r.deleted).length + '; cleanup complete: ' + this.report.cleanup.complete);
  }

  closeBrowserNow() {
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) ctx.close().catch(() => {});
  }

  async finalize() {
    if (this.finalizing) return this.finalizing;
    this.finalizing = (async () => {
      clearTimeout(this.runTimer);
      this.cleaning = true;
      this.stage = 'cleanup';
      try { await this.timed('cleanup', () => this.cleanupAll()); } catch (error) { this.report.cleanup.complete = false; this.report.cleanup.error = failureCode(error, this.secrets); }
      this.report.finished = new Date().toISOString();
      this.persist();
    })();
    return this.finalizing;
  }

  // ---- targets ---------------------------------------------------------------
  async loadCredentials() {
    this.phase('credentials');
    const path = this.opts.values.credentials;
    check(path, 'credentials_path');
    const stat = lstatSync(path);
    check(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'credentials_permissions');
    const credentials = JSON.parse(readFileSync(path, 'utf8'));
    for (const value of Object.values(credentials)) if (typeof value === 'string') this.addPinboardSecrets(value);
    for (const instance of [...this.plan.instances]) {
      const inst = this.instances[instance];
      const token = credentials[inst.service + 'Token'];
      // Without pinboardToken the Pinboard modules are skipped, not failed;
      // a --cleanup that must finish Pinboard work fails instead.
      if (inst.service === 'pinboard' && token === undefined && this.stage !== 'resume') { this.dropInstance(instance, 'pinboard_token_missing'); continue; }
      // Lower case: failureCode keeps only [a-z_0-9] codes, so the old
      // "missing_linkdingToken" reached reports as a bare "Error".
      check(typeof token === 'string' && token.trim() && !/[\r\n]/.test(token), 'missing_' + inst.service + '_token');
      if (inst.service === 'pinboard') {
        const m = PINBOARD_TOKEN_RE.exec(token);
        check(m, 'pinboard_token_format');
        if (!this.accountNames.includes(m[1])) this.accountNames.push(m[1]);
        this.report.pinboard = { configured: true };
      }
      inst.token = token;
      this.addSecret(token);
    }
    for (const value of Object.values(credentials)) if (typeof value === 'string') this.addSecret(value);
    this.report.instances = Object.fromEntries(Object.values(this.instances).map(i => [i.id, { service: i.service, base: i.base }]));
    this.persist();
  }

  // A token shows up in a request as given and percent-encoded, and its
  // secret half on its own: all three are redacted and canary-checked.
  addPinboardSecrets(value) {
    const m = PINBOARD_TOKEN_RE.exec(String(value || ''));
    if (!m) return;
    this.addSecret(value);
    this.addSecret(encodeURIComponent(value));
    this.addSecret(m[2]);
  }

  // Leaves an instance out of this run before any request reaches it.
  dropInstance(instance, reason) {
    for (const mod of this.selected.filter(m => m.instance === instance)) this.report.skipped.push({ id: mod.id, reason });
    this.selected = this.selected.filter(m => m.instance !== instance);
    this.plan.instances = this.plan.instances.filter(i => i !== instance);
    delete this.instances[instance];
    delete this.pools[instance];
    delete this.report.pools[instance];
    if (instance === 'pinboard') this.report.pinboard = { configured: false, reason };
    console.log(instance + ': skipped (' + reason + '); its modules are listed under skipped');
  }

  async startTemp() {
    this.phase('temp_containers');
    // After a signal or a fatal finding only the teardown reaches Docker.
    const stopped = () => this.cleaning || !!this.fatal;
    const docker = this.docker = createDocker({ runId: this.runId, exec: this.opts.dockerExec, log: entry => (this.report.temp.commands ||= []).push(entry), stopped });
    const names = docker.names;
    this.report.temp = { names: [], network: '', images: {}, fixture: `http://${TEMP_FIXTURE_HOST}:${TEMP_FIXTURE_PORT}`, commands: [] };
    const leftovers = await docker.leftovers();
    if (leftovers.length) { this.report.temp.leftovers = leftovers; this.persist(); fail('temp_leftovers_present'); }
    const need = new Set(this.plan.instances);
    const images = { linkding: await docker.userImage('linkding') };
    if (need.has('karakeep')) images.karakeep = await docker.userImage('karakeep');
    if (need.has('linkding-pg')) images.postgres = await docker.image('postgres:18');
    this.report.temp.images = images;
    const envFile = values => {
      // Cleanup removes env files before the containers; none may appear after.
      check(!stopped(), 'docker_after_cleanup');
      const file = join(this.runDir, 'env-' + randomBytes(4).toString('hex'));
      writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
      // Only real secrets join the redaction/canary list; names, hosts and
      // flags such as the run prefix would turn every screenshot into a hit.
      for (const [k, v] of Object.entries(values)) if (TEMP_SECRET_ENV.has(k)) this.addSecret(String(v));
      return file;
    };
    const created = name => { this.report.temp.names.push(name); this.persist(); };
    // Registered before it exists, like every container: a signal, a crash
    // or a forced exit during `network create` must still leave --cleanup a
    // name to remove. Explicit subnets: Docker Desktop here has no free
    // default pool, and an --internal network is what cuts the services off
    // from the internet.
    this.report.temp.network = names.net;
    this.persist();
    let netOk = false;
    for (let attempt = 0; attempt < 8 && !netOk; attempt++) {
      const third = 1 + ((parseInt(this.runId.slice(0, 2), 16) + attempt * 37) % 250);
      const r = await docker.run(['network', 'create', '--internal', '--subnet', `10.234.${third}.0/24`, '--label', 'pbp-it=' + this.runId, names.net], { allowFail: true });
      netOk = r.code === 0;
    }
    check(netOk, 'temp_network_failed');
    const forwards = [...need].map(i => `${TEMP_INSTANCES[i].edgePort}=${names[i]}:${TEMP_INSTANCES[i].port}`).join(',');
    const publish = [...need].flatMap(i => ['-p', '127.0.0.1::' + TEMP_INSTANCES[i].edgePort]);
    created(names.edge);
    const edgeEnv = envFile({ PBP_FORWARDS: forwards });
    await docker.run(['create', '--pull', 'never', '--name', names.edge, '--label', 'pbp-it=' + this.runId, '--network', 'bridge', '--memory', '128m', ...publish, '--env-file', edgeEnv, images.linkding, 'python3', '-c', EDGE_SCRIPT]);
    rmSync(edgeEnv, { force: true });
    await docker.run(['network', 'connect', names.net, names.edge]);
    await docker.run(['start', names.edge]);
    // Fixture sidecar: joins the service's network namespace, so the
    // service's own `localhost:TEMP_FIXTURE_PORT` is the synthetic article.
    const startFixture = async instance => {
      const env = envFile({ PBP_FIXTURE_HTML_B64: Buffer.from(fixtureHtml()).toString('base64'), PBP_FIXTURE_PORT: String(TEMP_FIXTURE_PORT) });
      created(names[instance + '-fixture']);
      await docker.run(['run', '-d', '--pull', 'never', '--name', names[instance + '-fixture'], '--label', 'pbp-it=' + this.runId, '--network', 'container:' + names[instance], '--memory', '64m', '--env-file', env, images.linkding, 'python3', '-c', EDGE_SCRIPT]);
      rmSync(env, { force: true });
    };
    const edgePorts = {};
    for (const instance of need) edgePorts[instance] = await docker.port(names.edge, TEMP_INSTANCES[instance].edgePort);
    const baseOf = instance => `http://127.0.0.1:${edgePorts[instance]}/`;
    const startLinkding = async (instance, extra = {}) => {
      const password = randomBytes(18).toString('base64url');
      const env = envFile({ LD_SUPERUSER_NAME: 'pbp-it', LD_SUPERUSER_PASSWORD: password, LD_SUPERVISOR_MANAGED: 'True', LD_ALLOWED_INTERNAL_HOSTS: TEMP_FIXTURE_HOST, ...extra });
      created(names[instance]);
      await docker.run(['run', '-d', '--pull', 'never', '--name', names[instance], '--label', 'pbp-it=' + this.runId, '--network', names.net, '--memory', '1g', '--tmpfs', '/etc/linkding/data:rw,size=256m', '--env-file', env, images.linkding]);
      rmSync(env, { force: true });
      await startFixture(instance);
    };
    if (need.has('linkding')) await startLinkding('linkding');
    if (need.has('linkding-pg')) {
      const pgPassword = randomBytes(18).toString('base64url');
      const env = envFile({ POSTGRES_USER: 'linkding', POSTGRES_PASSWORD: pgPassword, POSTGRES_DB: 'linkding' });
      created(names.postgres);
      await docker.run(['run', '-d', '--pull', 'never', '--name', names.postgres, '--label', 'pbp-it=' + this.runId, '--network', names.net, '--memory', '512m', '--tmpfs', '/var/lib/postgresql:rw,size=256m', '--env-file', env, images.postgres]);
      rmSync(env, { force: true });
      await this.waitFor(async () => (await docker.exec(names.postgres, ['pg_isready', '-U', 'linkding', '-d', 'linkding'], { allowFail: true })).code === 0, 60000, names.postgres, 'container_unhealthy');
      await startLinkding('linkding-pg', { LD_DB_ENGINE: 'postgres', LD_DB_HOST: names.postgres, LD_DB_PORT: '5432', LD_DB_DATABASE: 'linkding', LD_DB_USER: 'linkding', LD_DB_PASSWORD: pgPassword });
    }
    if (need.has('karakeep')) {
      const env = envFile({
        DATA_DIR: '/data', NEXTAUTH_SECRET: randomBytes(32).toString('base64url'), NEXTAUTH_URL: baseOf('karakeep').replace(/\/$/, ''),
        INFERENCE_ENABLE_AUTO_TAGGING: 'false', INFERENCE_ENABLE_AUTO_SUMMARIZATION: 'false', CRAWLER_ALLOWED_INTERNAL_HOSTNAMES: TEMP_FIXTURE_HOST,
      });
      created(names.karakeep);
      await docker.run(['run', '-d', '--pull', 'never', '--name', names.karakeep, '--label', 'pbp-it=' + this.runId, '--network', names.net, '--memory', '2g', '--tmpfs', '/data:rw,size=512m', '--env-file', env, images.karakeep]);
      rmSync(env, { force: true });
      await startFixture('karakeep');
    }
    for (const instance of need) {
      const service = TEMP_INSTANCES[instance].service;
      const base = baseOf(instance);
      this.instances[instance] = { id: instance, service, base, root: apiRootFor(service, base), token: '' };
      await this.waitFor(async () => {
        const st = await docker.state(names[instance]);
        if (!st.startsWith('running')) { this.report.temp.logs = { [instance]: this.sanitize(await docker.logs(names[instance])).split('\n').slice(-15) }; fail('container_start_failed'); }
        try {
          const r = await fetch(base + (service === 'linkding' ? 'health' : 'api/health'), { redirect: 'error', signal: AbortSignal.timeout(3000) });
          this.count(instance).setup++;
          const data = r.ok ? await r.json() : {};
          return ['healthy', 'ok'].includes(data.status);
        } catch { return false; }
      }, 120000, names[instance], 'container_unhealthy');
    }
    for (const instance of need) {
      const inst = this.instances[instance];
      if (inst.service === 'linkding') {
        const r = await docker.exec(names[instance], ['python', 'manage.py', 'shell', '-c', LINKDING_TOKEN_SCRIPT], { timeoutMs: 60000 });
        const token = (r.stdout.match(/^PBPTOKEN=([0-9a-f]{40})$/m) || [])[1];
        check(token, 'temp_token_failed');
        inst.token = token;
        check(/^PBPSNAPSHOTS=False$/m.test(r.stdout), 'temp_profile_failed');
        this.sharing[instance] = false;
        this.snapshots[instance] = false;
      } else {
        const email = `pbp-it-${this.runId.slice(0, 8)}@example.invalid`, password = randomBytes(18).toString('base64url');
        this.addSecret(password);
        const signup = await fetch(inst.base + 'api/auth/sign-up/email', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', Origin: inst.base.replace(/\/$/, '') }, body: JSON.stringify({ name: 'pbp-it', email, password }) });
        this.count(instance).setup++;
        check(signup.ok, 'temp_signup_failed');
        const exchange = await fetch(inst.base + 'api/trpc/apiKeys.exchange', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: { keyName: 'pbp-it', email, password } }) });
        this.count(instance).setup++;
        const key = exchange.ok ? (await exchange.json())?.result?.data?.json?.key : '';
        check(typeof key === 'string' && key.length > 20, 'temp_api_key_failed');
        inst.token = key;
      }
      this.addSecret(inst.token);
    }
    this.report.instances = Object.fromEntries(Object.values(this.instances).map(i => [i.id, { service: i.service, base: i.base }]));
    this.persist();
  }

  async waitFor(read, timeoutMs, label, code) {
    const started = Date.now(), end = started + timeoutMs;
    try {
      while (Date.now() < end) { this.throwIfFatal(); if (await read()) return; await sleep(1000); }
    } finally { this.noteWait('wait', Date.now() - started); }
    void label;
    fail(code);
  }

  // Flips one profile switch of the throwaway linkding account. Never used on
  // a user instance. Returns true when the value changed.
  async setTempProfile(instance, field, on) {
    check(this.target === 'temp' && this.docker && TEMP_PROFILE_FIELDS.includes(field), 'profile_requires_temp', true);
    const state = field === 'enable_sharing' ? this.sharing : this.snapshots;
    if (state[instance] === on) return false;
    const r = await this.docker.exec(this.docker.names[instance], ['python', 'manage.py', 'shell', '-c', linkdingProfileScript(field, on)], { timeoutMs: 60000 });
    check(new RegExp(`^PBPPROFILE=${field}=${on ? 'True' : 'False'}$`, 'm').test(r.stdout), 'temp_profile_failed');
    state[instance] = on;
    return true;
  }

  // Returns true when the switch changed (the caller then reconnects).
  setTempSharing(instance, on) { return this.setTempProfile(instance, 'enable_sharing', on); }

  async preflight() {
    for (const instance of this.plan.instances) {
      const inst = this.instances[instance];
      this.phase(instance + '_readonly');
      if (inst.service === 'pinboard') {
        // One posts/get of the first pool URL proves the token and that this
        // run's URLs are new (each carries the run's fresh UUID, so the
        // others cannot exist either; cleanup reads every one anyway). No
        // other read is spent on Pinboard here.
        const first = this.pools[instance][0];
        if (first) check(await this.pinboardPost(instance, first) === null, 'fixture_already_exists');
        this.report.checks.push(instance + ': authentication, unique URLs');
        this.persist();
        console.log(instance + ': readonly preflight passed');
        continue;
      }
      const health = await this.api(instance, new URL(inst.service === 'linkding' ? 'health' : 'api/health', inst.base).href, { auth: false });
      check(['ok', 'healthy'].includes(health.status), 'health');
      if (inst.service === 'linkding') {
        const profile = await this.api(instance, 'user/profile/');
        this.sharing[instance] = profile.enable_sharing === true;
        inst.version = String(profile.version || '');
      } else await this.api(instance, 'users/me');
      for (const url of this.pools[instance]) {
        const data = await this.api(instance, (inst.service === 'linkding' ? 'bookmarks/check/' : 'bookmarks/check-url') + '?url=' + encodeURIComponent(url));
        check(!(inst.service === 'linkding' ? data.bookmark : data.bookmarkId), 'fixture_already_exists');
        // linkding auto-tagging rules would append tags to run bookmarks.
        if (inst.service === 'linkding') check(!Array.isArray(data.auto_tags) || data.auto_tags.length === 0, 'linkding_auto_tags_present');
      }
      const writes = this.selected.some(m => m.instance === instance && m.needs?.writes !== false);
      if (inst.service === 'karakeep' && (writes || this.target === 'temp')) {
        const html = await this.api(instance, inst.base + 'signin', { auth: false, accept: 'html' });
        const config = parseKarakeepClientConfig(html);
        this.report.instances[instance].autoAi = config?.inference ? { tagging: config.inference.enableAutoTagging, summarization: config.inference.enableAutoSummarization } : null;
        if (writes) check(karakeepAutoAiOff(config), 'karakeep_auto_ai_not_verified_off');
      }
      this.report.checks.push(instance + ': health, authentication, unique URLs' + (inst.service === 'karakeep' && writes ? ', server auto AI off' : ''));
      this.persist();
      console.log(instance + ': readonly preflight passed');
    }
  }

  async startFakeAi() {
    this.phase('fake_ai');
    this.fakeAi = await startFakeAi({ prefix: this.prefix, limit: BUDGETS[this.target].run.fakeAi });
    this.addSecret(this.fakeAi.key);
    this.report.fakeAi = { origin: this.fakeAi.origin, limit: this.fakeAi.limit, calls: [] };
    this.persist();
  }

  // ---- browser ---------------------------------------------------------------
  async setupBrowser() {
    this.phase('browser_setup');
    this.writesPossible = true;
    const { chromium } = createRequire(resolve(ROOT, '.qa-scan/package.json'))('playwright');
    this.profile = join(this.runDir, 'profile');
    mkdirSync(this.profile, { mode: 0o700 });
    this.report.profile = this.profile;
    this.headed = this.plan.headed;
    const launch = () => chromium.launchPersistentContext(this.profile, {
      headless: !this.headed, executablePath: chromium.executablePath(), viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
    });
    const getWorker = async ctx => ctx.serviceWorkers().find(w => w.url().startsWith('chrome-extension://')) || ctx.waitForEvent('serviceworker', { predicate: w => w.url().startsWith('chrome-extension://') });
    let ctx = await launch();
    let worker = await getWorker(ctx);
    const extId = new URL(worker.url()).hostname;
    const unknown = await worker.evaluate(async ({ hardened, localOnly }) => {
      await primeSettings();
      const missing = Object.keys(hardened).filter(k => !Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, k) && !localOnly.includes(k));
      if (!missing.length) await chrome.storage.local.set(hardened);
      return missing;
    }, { hardened: HARDENED_SETTINGS, localOnly: LOCAL_ONLY_SETTINGS });
    check(!unknown.length, 'hardened_setting_unknown');
    await ctx.close();
    const prefsPath = join(this.profile, 'Default', 'Preferences');
    const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
    const fixtureOrigins = [...new Set(Object.values(this.pools).flat().map(u => new URL(u).origin))];
    for (const key of ['granted_permissions', 'active_permissions']) {
      const bucket = prefs.extensions.settings[extId][key] ||= {};
      const hosts = bucket.explicit_host ||= [];
      // popup.html opened as a tab has no activeTab grant; permit only the
      // intercepted synthetic article origin, the services and the fake AI.
      for (const origin of [...Object.values(this.instances).filter(i => i.base).map(i => new URL(i.base).origin), ...fixtureOrigins, ...(this.fakeAi ? [this.fakeAi.origin] : [])]) {
        const pattern = origin + '/*';
        if (!hosts.includes(pattern)) hosts.push(pattern);
      }
    }
    writeFileSync(prefsPath, JSON.stringify(prefs));
    ctx = await launch();
    this.ctx = ctx;
    worker = await getWorker(ctx);
    this.worker = worker;
    this.extension = 'chrome-extension://' + extId + '/';
    await worker.evaluate(() => primeSettings());
    this.guardCfg = this.buildGuardCfg();
    this.poolSet = new Set(Object.values(this.pools).flat());
    this.routeProbe = { url: 'http://pbp-it-route-probe.invalid/' + this.runId, seen: false };
    await ctx.route(/^https?:\/\//, route => this.onRoute(route));
    // The route layer must see worker traffic, or it guards nothing.
    await worker.evaluate(url => fetch(url).then(r => r.status).catch(() => 0), this.routeProbe.url);
    check(this.routeProbe.seen, 'route_guard_blind_to_worker', true);
    this.swToken = randomBytes(8).toString('hex');
    await worker.evaluate(`(${installWorkerGuard.toString()})(${guardRuleSource()}, ${JSON.stringify(this.guardCfg)}, ${JSON.stringify(this.swToken)})`);
    ctx.on('serviceworker', w => {
      if (!w.url().startsWith(this.extension)) return;
      this.setFatal('live_guard_sw_restart');
    });
    const surfaceOf = url => { try { const u = new URL(url); return u.protocol === 'chrome-extension:' ? u.pathname.replace(/^\//, '') : u.origin; } catch { return 'unknown'; } };
    const watch = page => {
      page.on('pageerror', error => this.report.pageErrors.push({ module: this.currentModule?.id || '', surface: surfaceOf(page.url()), name: error.name, message: this.sanitize(error.message).slice(0, 200) }));
      page.on('console', msg => { if (['error', 'warning'].includes(msg.type())) this.report.console.push({ module: this.currentModule?.id || '', surface: surfaceOf(page.url()), type: msg.type(), text: this.sanitize(msg.text()).slice(0, 240) }); });
    };
    for (const page of ctx.pages()) watch(page);
    ctx.on('page', page => { watch(page); this.pages.add(page); });
    worker.on('console', msg => { if (['error', 'warning'].includes(msg.type())) this.report.swConsole.push({ module: this.currentModule?.id || '', type: msg.type(), text: this.sanitize(msg.text()).slice(0, 240) }); });
    ctx.on('requestfailed', request => {
      const url = request.url();
      const d = liveGuardRule(this.guardCfg, { created: [] }, { url, method: 'GET' });
      if (d.kind === 'outside') return;
      // Worker fetches whose body is never read (204 DELETE/PUT replies)
      // end as ERR_ABORTED although the server answered; count, don't list.
      if (request.failure()?.errorText === 'net::ERR_ABORTED') { this.report.abortedRequests = (this.report.abortedRequests || 0) + 1; return; }
      this.report.requestFailed.push({ module: this.currentModule?.id || '', method: request.method(), url: stripQuery(url), failure: this.sanitize(request.failure()?.errorText || '') });
    });
    this.persist();
  }

  async onRoute(route) {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    if (url === this.routeProbe.url) { this.routeProbe.seen = true; return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' }); }
    if (this.probe && url === this.probe.url) { this.probe.seen = true; return route.fulfill({ contentType: 'text/html', body: '<title>Navigation probe</title>' }); }
    if (this.poolSet.has(url) && (method === 'GET' || method === 'HEAD')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml() });
    const decision = liveGuardRule(this.guardCfg, this.guardView(), { url, method, body: request.postData() });
    if (decision.kind === 'outside') {
      const origin = (() => { try { return new URL(url).origin; } catch { return 'invalid'; } })();
      if (!this.report.blockedOrigins.includes(origin) && this.report.blockedOrigins.length < 50) this.report.blockedOrigins.push(origin);
      return route.abort('blockedbyclient');
    }
    if (!decision.ok) {
      this.setFatal(decision.code);
      return route.abort('blockedbyclient');
    }
    const counter = decision.instance === 'ai' ? (this.aiCount = (this.aiCount || 0) + 1) : ++this.count(decision.instance).browser;
    const cap = decision.instance === 'ai' ? BUDGETS[this.target].run.fakeAi : this.caps[decision.instance].browser;
    if (counter > cap) { this.setFatal(decision.instance === 'ai' ? 'fake_ai_budget' : 'browser_request_budget'); return route.abort('blockedbyclient'); }
    if (decision.instance !== 'ai' && method !== 'GET' && method !== 'HEAD') this.count(decision.instance).browserWrites++;
    if (decision.instance !== 'ai' && this.currentModule?.record) {
      // Browser requests per endpoint, for budgeting (E: which reads a
      // module repeats, e.g. Karakeep tags pages on a large library).
      const paths = this.currentModule.record.paths ||= {};
      const key = method + ' ' + endpointKey(url, this.instances[decision.instance]?.root || '');
      paths[key] = (paths[key] || 0) + 1;
    }
    if (this.offline && decision.instance === this.offline) return route.abort('internetdisconnected');
    // What leaves counts from here: its run tags now, a creation's slot
    // until its answer is recorded.
    if (decision.tags?.length) this.noteTags(decision.instance, decision.tags.map(key => ({ key })), 'route');
    if (this.instances[decision.instance]?.service === 'pinboard') return this.routePinboard(route, url, decision);
    if (decision.kind === 'create' || decision.kind === 'list-create') {
      const release = this.hold(decision.instance, decision.kind === 'create' ? 'bookmarks' : 'lists');
      let response;
      // Without an answer, or after a server error, the creation may exist
      // unrecorded: the slot stays held. A refusal (4xx) made nothing.
      try { response = await route.fetch({ maxRedirects: 0 }); } catch { return route.abort('failed'); }
      if (response.ok()) {
        try {
          const row = JSON.parse(await response.text());
          const service = this.instances[decision.instance].service;
          if (decision.kind === 'create') {
            const actual = rowUrl(service, row);
            if (actual !== decision.url) this.setFatal('live_guard_response');
            else {
              this.recordCreated({ instance: decision.instance, id: String(row.id), url: actual, source: 'route' });
              release();
              // A page-context create never passes the worker guard; tell it,
              // so a later worker update of that bookmark is not refused.
              this.shareCreated({ instance: decision.instance, id: String(row.id), url: actual });
            }
          } else {
            const entry = { instance: decision.instance, id: String(row.id) };
            this.recordList(entry);
            release();
            this.shareGuard('lists', [entry]);
          }
        } catch { this.setFatal('live_guard_response'); }
      } else if (response.status() < 500) release();
      return route.fulfill({ response });
    }
    return route.continue();
  }

  // The browser never reaches Pinboard itself (its resolver maps every
  // non-loopback name to NOTFOUND): the route answers each allowed request
  // with what the gate got from Pinboard (or the mock). A create's ledger
  // entry is on disk before the request joins the gate (pending until the
  // answer): a run killed while posts/add is in flight leaves the URL named
  // for --cleanup. "done" settles it; an answer that made nothing (a 4xx,
  // or a 200 with another result_code) takes it back; no answer or a 5xx
  // keeps it, as the save may exist. A second posts/add of a URL whose
  // create is still pending is judged a mutate and sent as is: it contends
  // the reservation, which then keeps the entry whatever the first answer.
  async routePinboard(route, url, decision) {
    const instance = decision.instance;
    const reservation = decision.kind === 'create' ? this.reservePinboardCreate({ instance, id: pinboardLedgerId(this.pools[instance], decision.url), url: decision.url }) : null;
    if (decision.kind === 'mutate' && decision.url && pinboardEndpoint(url) === 'posts/add') this.pinboardReservations?.get(instance + ' ' + decision.url)?.contend();
    if (this.fatal) { reservation?.abandon(); return route.abort('blockedbyclient').catch(() => {}); }
    let res;
    try { res = await this.pinboardSend(instance, url); } catch { return route.abort('failed').catch(() => {}); }
    if (reservation) {
      let code = '';
      if (res.status === 200) { try { code = JSON.parse(res.body)?.result_code || ''; } catch { /* no creation */ } }
      if (code === 'done') reservation.confirm();
      else if (res.status < 500) reservation.abandon();
    }
    return route.fulfill({ status: res.status, headers: { 'content-type': res.contentType || 'application/json; charset=utf-8' }, body: res.body }).catch(() => {});
  }

  // The ledger entry of a Pinboard create about to be sent: a new entry, or
  // the run's deleted entry for that URL reopened. It counts against the
  // caps as soon as it is written (no separate pending slot). The worker
  // guard learns of it only once it is confirmed: its list only grows, and
  // syncGuard would bring an abandoned entry back into the ledger.
  // An abandoned entry is taken back only when nothing else may have saved
  // the URL: a reopened entry stays open (cleanup's posts/delete takes "item
  // not found", then posts/get confirms), and so does one a same-URL save
  // contended while it was pending.
  reservePinboardCreate(entry) {
    const ledger = this.report.ledger.created;
    let known = ledger.find(r => r.instance === entry.instance && r.id === entry.id);
    const reopened = !!known;
    const mod = this.currentModule;
    if (known) { known.deleted = false; known.pending = true; this.persist(); }
    else { this.recordCreated({ ...entry, source: 'route', pending: true }); known = ledger.find(r => r.instance === entry.instance && r.id === entry.id); }
    const key = entry.instance + ' ' + entry.url;
    const reservations = (this.pinboardReservations ||= new Map());
    let open = true;
    let contended = false;
    const close = () => { open = false; if (reservations.get(key) === reservation) reservations.delete(key); };
    const reservation = {
      contend: () => { if (open) contended = true; },
      confirm: () => { if (!open) return; close(); delete known.pending; this.persist(); this.shareCreated({ instance: entry.instance, id: entry.id, url: entry.url }); },
      abandon: () => {
        if (!open) return;
        close();
        if (reopened || contended) {
          delete known.pending;
          if (contended) this.shareCreated({ instance: entry.instance, id: entry.id, url: entry.url });
        } else {
          const i = ledger.indexOf(known);
          if (i >= 0) ledger.splice(i, 1);
          if (mod && mod.created > 0) mod.created--;
        }
        this.persist();
      },
    };
    reservations.set(key, reservation);
    return reservation;
  }

  // Tell the worker guard what another layer recorded (page-context and
  // Node requests never pass the worker), so both layers count the same
  // bookmarks, lists and tags.
  shareGuard(field, entries) {
    if (!this.worker || !entries.length) return Promise.resolve();
    return this.worker.evaluate(({ token, field, entries }) => {
      const g = globalThis.pbpLiveGuard;
      if (!g || g.token !== token || !Array.isArray(g[field])) return;
      for (const entry of entries) {
        if (!g[field].some(r => r.instance === entry.instance && (field === 'tags' ? r.key === entry.key : r.id === entry.id))) g[field].push(entry);
      }
    }, { token: this.swToken, field, entries }).catch(() => {});
  }
  shareCreated(entry) { return this.shareGuard('created', [entry]); }

  // Merge the worker guard's view: creations it saw, counts, violations.
  async syncGuard() {
    if (!this.worker || !this.ctx) return;
    let state;
    try {
      state = await Promise.race([
        this.worker.evaluate(token => {
          const g = globalThis.pbpLiveGuard;
          if (!g || g.token !== token) return null;
          return { created: g.created, lists: g.lists, tags: g.tags, counts: g.counts, violations: g.violations.splice(0) };
        }, this.swToken),
        sleep(5000).then(() => 'timeout'),
      ]);
    } catch { state = 'error'; }
    if (state === 'timeout' || state === 'error') return;
    if (!state) { this.setFatal('live_guard_missing'); return; }
    for (const entry of state.created) this.recordCreated({ ...entry, source: 'sw' });
    for (const entry of state.lists) this.recordList(entry);
    const swTags = {};
    for (const tag of state.tags || []) (swTags[tag.instance] ||= []).push({ key: tag.key });
    for (const [instance, entries] of Object.entries(swTags)) this.noteTags(instance, entries, 'sw');
    for (const [instance, n] of Object.entries(state.counts)) if (this.counts[instance]) this.counts[instance].sw = n;
    for (const v of state.violations) {
      if (v.code === 'live_guard_origin') {
        if (!this.report.blockedOrigins.includes(v.origin) && this.report.blockedOrigins.length < 50) this.report.blockedOrigins.push(v.origin);
        if (v.sample !== undefined && this.report.blockedSamples.length < 20) this.report.blockedSamples.push({ module: this.currentModule?.id || '', phase: this.phaseName, sample: this.sanitize(String(v.sample)), where: this.sanitize(String(v.where || '')) });
        continue;
      }
      this.setFatal(v.code);
    }
  }

  // The worker guard is the second layer behind ctx.route. A busy or closing
  // worker (timeout, error) is left to the serviceworker event and syncGuard;
  // a live worker without this run's guard is fatal.
  async assertGuardPresent() {
    if (!this.worker || !this.swToken) return;
    let present, timer;
    try {
      present = await Promise.race([
        this.worker.evaluate(token => globalThis.pbpLiveGuard?.token === token, this.swToken),
        new Promise(r => { timer = setTimeout(() => r('timeout'), 5000); }),
      ]);
    } catch { present = 'error'; } finally { clearTimeout(timer); }
    if (present === false) this.setFatal('live_guard_missing');
  }

  async sw(fn, arg) {
    this.throwIfFatal();
    check(this.worker, 'worker_missing', true);
    const present = await this.worker.evaluate(token => globalThis.pbpLiveGuard?.token === token, this.swToken);
    if (!present) { this.setFatal('live_guard_missing'); this.throwIfFatal(); }
    return this.worker.evaluate(fn, arg);
  }

  async connect(instance) {
    const inst = this.instances[instance];
    this.currentModule = null;
    this.guardCfg.writes = false;
    await this.pushGuardWrites(false);
    this.phase(instance + '_connect');
    const options = await this.connectUi(instance);
    const owner = await this.sw(() => pbpVocabCurrentOwner());
    if (!this.libraryOwner) {
      this.libraryOwner = owner;
      await this.sw(owner => pbpVocabSaveWord(owner, { term: 'shared', language: 'en', gloss: 'local fixture', contexts: [] }), owner);
    }
    check(owner === this.libraryOwner, 'library_switched');
    check(await this.sw(async owner => (await pbpVocabAll(owner)).length === 1, owner), 'library_lost');
    await this.shot(options, 'connected', { surface: 'options', service: inst.service, keys: [inst.service === 'pinboard' ? '#test-pinboard-token' : '#connect-' + inst.service] });
    await options.close();
    await this.syncGuard();
    this.throwIfFatal();
    console.log(instance + ': connected');
  }

  // The options-page Connect flow; also re-run after a temporary instance's
  // sharing switch changes, since the extension reads it at Connect time.
  async connectUi(instance, { keepOpen = true } = {}) {
    const inst = this.instances[instance];
    const options = await this.ctx.newPage();
    await options.goto(this.extension + 'options.html');
    await options.locator(`input[name="bookmark-service"][value="${inst.service}"]`).check();
    if (inst.service === 'pinboard') {
      // Pinboard has no Connect button: the token field auto-saves, and Test
      // connection (user/api_token) proves it. Its status line names the
      // account, so screenshots mask it.
      await options.locator('#opt-pinboard-token').fill(inst.token);
      await options.locator('#test-pinboard-token').click();
      await options.locator('#test-pinboard-status.ok, #test-pinboard-status.bad').first().waitFor({ timeout: 25000 });
      check(await options.locator('#test-pinboard-status.ok').count() === 1, 'pinboard_token_test');
      await this.until(() => this.sw(async () => { const c = await pbpReadBookmarkConnection(); return c.service === 'pinboard' && !!c.account; }), 'selected_service');
      if (keepOpen) return options;
      await options.close();
      return null;
    }
    await options.locator('#opt-' + inst.service + '-url').fill(inst.base);
    await options.locator('#opt-' + inst.service + '-token').fill(inst.token);
    await options.locator('#connect-' + inst.service).click();
    await options.locator('#connect-' + inst.service + '-status').filter({ hasText: 'Connected' }).waitFor({ timeout: 25000 });
    await this.until(() => this.sw(async service => (await pbpReadBookmarkConnection()).service === service, inst.service), 'selected_service');
    if (keepOpen) return options;
    await options.close();
    return null;
  }

  async pushGuardWrites(writes) {
    if (!this.worker) return;
    await this.worker.evaluate(({ token, writes }) => { if (globalThis.pbpLiveGuard?.token === token) globalThis.pbpLiveGuard.cfg.writes = writes; }, { token: this.swToken, writes });
  }

  async until(read, label, timeout = 20000) {
    const started = Date.now(), end = started + timeout;
    try {
      while (Date.now() < end) { this.throwIfFatal(); if (await read()) return; await sleep(150); }
    } finally { this.noteWait('wait', Date.now() - started); }
    fail('timeout_' + label);
  }

  // ---- modules ---------------------------------------------------------------
  harness(mod) {
    const run = this;
    const instance = mod.instance;
    const inst = this.instances[instance];
    // Every harness call checks that the module is still current: a module
    // that timed out keeps running in the background until its pages close,
    // and must not reach the services while its cleanup or the next module
    // runs. The Node API and the worker are only reached through these two.
    const alive = () => { if (mod.revoked) fail('module_revoked'); run.throwIfFatal(); };
    const api = (path, opts) => { alive(); return run.api(instance, path, opts); };
    const sw = (fn, arg) => { alive(); return run.sw(fn, arg); };
    const t = {
      service: mod.service, instance, prefix: run.prefix, runId: run.runId, target: run.target,
      base: inst.base, root: inst.root, ctx: run.ctx, worker: run.worker, extension: run.extension,
      libraryOwner: run.libraryOwner,
      get fakeAi() {
        const f = run.fakeAi;
        check(f, 'fake_ai_not_started');
        return { marker: f.marker, calls: kind => f.calls(kind), unknown: () => f.unknown(), expect: spec => f.expect(spec) };
      },
      // Each phase also confirms the worker guard is still installed. The
      // returned promise is marked handled, so a phase that is not awaited
      // cannot crash the run; its finding stops the next harness call.
      phase(name) {
        run.phase(name);
        const checked = run.assertGuardPresent().then(() => run.throwIfFatal());
        checked.catch(() => {});
        return checked;
      },
      expect: (condition, code) => { run.throwIfFatal(); check(condition, code); },
      expectEq(actual, expected, code) {
        run.throwIfFatal();
        if (actual === expected) return;
        const show = v => (v === undefined ? 'undefined' : run.sanitize(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 200));
        run.report.readBackDiffs.push({ module: mod.id, phase: run.phaseName, code, expected: show(expected), actual: show(actual) });
        fail(code);
      },
      check: text => { mod.record.checks.push(text); run.report.checks.push(text); },
      note: (key, value) => { mod.record.notes[key] = value; },
      sleep: async ms => { const started = Date.now(); try { await sleep(ms); } finally { run.noteWait('wait', Date.now() - started); } },
      // Time left before this module's own seconds budget runs out.
      remainingMs: () => Math.max(0, (mod.deadline || 0) - Date.now()),
      until: (read, label, timeout) => { alive(); return run.until(read, label, timeout); },
      claimUrl() {
        alive();
        const pool = run.pools[instance];
        if (mod.claimed >= mod.budget.urls || run.claimed[instance] >= pool.length) { run.setFatal('url_budget'); run.throwIfFatal(); }
        mod.claimed++;
        return pool[run.claimed[instance]++];
      },
      api,
      recordPath: id => recordPath(mod.service, id),
      rowUrl: row => rowUrl(mod.service, row),
      async seed({ url, title = '', tags = [], description = '', notes = '' } = {}) {
        alive();
        // The runner never writes a Pinboard bookmark itself.
        check(mod.service !== 'pinboard', 'pinboard_seed_refused', true);
        const target = url || t.claimUrl();
        let row;
        if (mod.service === 'linkding') {
          row = await api('bookmarks/', { method: 'POST', body: { url: target, title, description, notes, tag_names: tags, is_archived: false, unread: false, shared: false } });
        } else {
          row = await api('bookmarks', { method: 'POST', body: { type: 'link', url: target, title, note: notes, source: 'api' } });
          if (tags.length) await api('bookmarks/' + encodeURIComponent(row.id) + '/tags', { method: 'POST', body: { tags: tags.map(tagName => ({ tagName })) } });
        }
        return row;
      },
      async ownRow(url) {
        alive();
        await run.syncGuard();
        run.throwIfFatal();
        const entry = run.report.ledger.created.find(r => r.instance === instance && r.url === url && !r.deleted);
        check(entry, 'created_id_missing');
        if (mod.service === 'pinboard') {
          // Assertions read what Pinboard holds: posts/get's post object.
          alive();
          const post = await run.pinboardPost(instance, url);
          check(post, 'created_row_missing');
          for (const name of String(post.tags || '').split(/\s+/).filter(Boolean)) run.trackTag(instance, { name });
          run.throwIfFatal();
          return post;
        }
        const row = await api(recordPath(mod.service, entry.id));
        check(rowUrl(mod.service, row) === url, 'created_url_mismatch', true);
        if (mod.service === 'karakeep') for (const tag of row.tags || []) run.trackTag(instance, tag);
        else for (const name of row.tag_names || []) run.trackTag(instance, { name });
        run.throwIfFatal();
        return row;
      },
      // What the service holds for a run URL now, or null (Pinboard: the
      // post; linkding / Karakeep: the ledger row by id).
      async lookup(url) {
        alive();
        if (mod.service === 'pinboard') return run.pinboardPost(instance, url);
        const entry = run.report.ledger.created.find(r => r.instance === instance && r.url === url);
        return entry ? api(recordPath(mod.service, entry.id), { allow404: true }) : null;
      },
      async openPopup(url, { selection = false, width, locale, scheme } = {}) {
        alive();
        if (locale) await t.settings({ optLang: locale });
        const article = await run.ctx.newPage();
        await article.goto(url);
        await article.bringToFront();
        if (selection) await article.evaluate(() => {
          const range = document.createRange();
          range.selectNodeContents(document.getElementById('quote-fixture'));
          const selected = window.getSelection();
          selected.removeAllRanges();
          selected.addRange(range);
        });
        const opened = run.ctx.waitForEvent('page');
        await sw(url => chrome.tabs.create({ url, active: false }), run.extension + 'popup.html');
        const popup = await opened;
        if (width) await popup.setViewportSize({ width, height: 900 });
        await popup.waitForLoadState();
        await popup.locator('#main-section:not(.hidden)').waitFor();
        await popup.waitForFunction(() => typeof _popupDraftContext !== 'undefined' && _popupDraftContext?.ready === true
          && ['found', 'missing'].includes(bookmarkLookup.status) && !document.getElementById('submit-btn').disabled);
        if (scheme) await run.applyScheme(popup, scheme);
        return { popup, article, close: async () => { await popup.close().catch(() => {}); await article.close().catch(() => {}); } };
      },
      async savePopup(popup) {
        await popup.locator('#submit-btn').click();
        await run.until(() => popup.evaluate(() => document.getElementById('submit-btn').classList.contains('saved-success')), 'popup_save');
      },
      async openReader(url, { markdown = '# Synthetic article\n\nPublic fixture.', title = 'Synthetic article', ready = '#reader-bookmark-save' } = {}) {
        alive();
        const account = await sw(async () => (await getCurrentBookmarkAuth()).account);
        await sw(async data => chrome.storage.local.set({ md_preview_data_live: { markdown: data.markdown, title: data.title, url: data.url, baseUrl: data.url, account: data.account, tags: [], description: '', source: 'local', ts: Date.now() } }), { url, account, markdown, title });
        const reader = await run.ctx.newPage();
        await reader.goto(run.extension + 'md-preview.html?k=live');
        await reader.waitForFunction(sel => document.querySelector(sel)?.getAttribute('aria-busy') === 'false', ready);
        return reader;
      },
      async applyReader(reader) {
        await reader.locator('#reader-bookmark-apply').click();
        await run.until(() => reader.evaluate(() => !document.getElementById('reader-bookmark-editor').matches(':popover-open')), 'reader_apply');
      },
      async openOptions(hash = '') {
        const page = await run.ctx.newPage();
        await page.goto(run.extension + 'options.html' + (hash ? '#' + String(hash).replace(/^#/, '') : ''));
        return page;
      },
      sw,
      async settings(values) {
        alive();
        await sw(async values => { await chrome.storage.local.set(values); await new Promise(r => setTimeout(r, 50)); }, values);
        if (typeof values.optLang === 'string') run.locale = values.optLang;
      },
      async offline(which) {
        if (which) alive();
        const target = which === 'self' || which === true ? instance : (which || '');
        run.offline = target;
        await run.worker.evaluate(({ token, target }) => { if (globalThis.pbpLiveGuard?.token === token) globalThis.pbpLiveGuard.offline = target; }, { token: run.swToken, target });
      },
      writes: async () => { await run.syncGuard(); return run.count(instance).browserWrites; },
      probe(url) {
        run.probe = { url, seen: false };
        return { url, observed: () => !!run.probe?.seen, clear: () => { run.probe = null; } };
      },
      shot: (page, state, opts = {}) => { alive(); return run.shot(page, state, { service: mod.service, ...opts }); },
    };
    return t;
  }

  async runModule(mod) {
    const budget = resolveBudget(mod);
    const record = { id: mod.id, instance: mod.instance, status: 'running', started: new Date().toISOString(), ms: 0, checks: [], notes: {}, failure: null, counts: {}, timing: { waitMs: 0, throttleMs: 0 } };
    this.report.modules.push(record);
    this.persist();
    const current = { id: mod.id, budget, created: 0, claimed: 0, record };
    this.currentModule = current;
    const before = { ...this.count(mod.instance), ai: this.fakeAi ? this.fakeAi.calls() : 0 };
    const pagesBefore = new Set(this.ctx.pages());
    const errorsBefore = this.report.pageErrors.length;
    const settingsKeys = await this.sw(() => Object.keys(SETTINGS_DEFAULTS).concat(['optSyncEnabled', 'offlineQueue']));
    const snapshot = await this.sw(keys => chrome.storage.local.get(keys), settingsKeys);
    const t = this.harness({ ...mod, record, budget, get claimed() { return current.claimed; }, set claimed(v) { current.claimed = v; }, get revoked() { return current.revoked === true; }, get deadline() { return current.deadline; } });
    let timer;
    try {
      this.phase(mod.id);
      if (mod.needs?.sharing && mod.needs.sharing !== 'any' && mod.service === 'linkding') {
        if (this.target !== 'temp') check((mod.needs.sharing === 'on') === !!this.sharing[mod.instance], 'sharing_state_mismatch');
        else if (await this.setTempSharing(mod.instance, mod.needs.sharing === 'on')) await this.connectUi(mod.instance, { keepOpen: false });
      }
      // Background snapshots stay off on a temporary instance except for the
      // module that waits for one; a user instance keeps its own setting.
      if (mod.needs?.snapshots && mod.service === 'linkding' && this.target === 'temp') await this.setTempProfile(mod.instance, 'enable_automatic_html_snapshots', true);
      this.guardCfg.writes = mod.needs?.writes !== false;
      await this.pushGuardWrites(this.guardCfg.writes);
      if (mod.needs?.fakeAi) {
        check(this.fakeAi, 'fake_ai_not_started', true);
        const key = await this.sw(k => obfuscateKey(k), this.fakeAi.key);
        await t.settings({ aiProvider: 'custom', customProtocol: 'openai', customBaseUrl: this.fakeAi.base, customApiKey: key, customModel: 'pbp-fake-ai', customDisplayName: 'Fake AI', aiContentSource: 'local', aiTagSeparator: '_', aiTagLang: 'en', aiSummaryLang: 'en', optRespectTagCase: true });
      }
      if (mod.settings && Object.keys(mod.settings).length) await t.settings(mod.settings);
      const seconds = budget.seconds || BUDGETS[this.target].run.moduleSeconds;
      current.deadline = Date.now() + seconds * 1000;
      const work = (async () => { await mod.steps(t); if (mod.verify) await mod.verify(t); })();
      // After a timeout the steps fail on revoked calls or closed pages;
      // those late rejections are expected, not uncaught errors. The module is
      // revoked the moment it times out, before its cleanup starts: cleanup
      // switches the Node guard to deletions, where a late seed would read as
      // a guard violation and abort the whole run.
      work.catch(() => {});
      await Promise.race([
        work,
        new Promise((_, reject) => { timer = setTimeout(() => { current.revoked = true; reject(new HarnessFailure('module_timeout')); }, seconds * 1000); }),
      ]);
      await this.syncGuard();
      this.throwIfFatal();
      check(this.report.pageErrors.length === errorsBefore, 'browser_page_error');
      const after = this.count(mod.instance);
      const usedNode = after.node - before.node, usedBrowser = after.browser - before.browser;
      const usedAi = this.fakeAi ? this.fakeAi.calls() - before.ai : 0;
      record.counts = { node: usedNode, browser: usedBrowser, ai: usedAi };
      if (usedNode > budget.node || usedBrowser > budget.browser || usedAi > budget.ai) { this.setFatal('module_request_budget'); this.throwIfFatal(); }
      if (this.fakeAi?.failed()) { this.setFatal(this.fakeAi.failed()); this.throwIfFatal(); }
      record.status = 'passed';
      console.log(mod.id + ': passed');
    } catch (error) {
      // Whatever failed, nothing the module still has in flight may reach a
      // service from here on.
      current.revoked = true;
      const code = failureCode(error, this.secrets);
      record.failure = { phase: this.phaseName, code };
      const after = this.count(mod.instance);
      record.counts = { node: after.node - before.node, browser: after.browser - before.browser, ai: this.fakeAi ? this.fakeAi.calls() - before.ai : 0 };
      if (error instanceof HarnessFailure && error.fatal || this.fatal) {
        record.status = 'aborted';
        console.error('ABORTED ' + mod.id + ' at ' + this.phaseName + ': ' + code);
        this.persist();
        throw error;
      }
      record.status = 'failed';
      console.error('FAILED ' + mod.id + ' at ' + this.phaseName + ': ' + code);
      await this.closePagesSince(pagesBefore);
      await this.cleanupModule(mod);
    } finally {
      clearTimeout(timer);
      current.revoked = true;
      this.closePhase();
      record.finished = new Date().toISOString();
      record.ms = Date.parse(record.finished) - Date.parse(record.started);
      if (!this.fatal) {
        try {
          await this.closePagesSince(pagesBefore);
          await t.offline('');
          this.fakeAi?.reset();
          this.probe = null;
          await this.sw(async ({ keys, snapshot }) => {
            const extra = keys.filter(k => !(k in snapshot));
            if (extra.length) await chrome.storage.local.remove(extra);
            await chrome.storage.local.set(snapshot);
          }, { keys: settingsKeys, snapshot });
          this.locale = typeof snapshot.optLang === 'string' ? snapshot.optLang : 'en';
          this.guardCfg.writes = false;
          await this.pushGuardWrites(false);
          if (mod.needs?.sharing === 'on' && this.target === 'temp' && await this.setTempSharing(mod.instance, false)) await this.connectUi(mod.instance, { keepOpen: false });
          if (mod.needs?.snapshots && mod.service === 'linkding' && this.target === 'temp') await this.setTempProfile(mod.instance, 'enable_automatic_html_snapshots', false);
        } catch (error) {
          this.setFatal('module_restore_failed');
          record.restore = failureCode(error, this.secrets);
        }
      }
      this.currentModule = null;
      this.persist();
    }
  }

  async closePagesSince(before) {
    if (!this.ctx) return;
    for (const page of this.ctx.pages()) if (!before.has(page)) await page.close().catch(() => {});
  }

  async cleanupModule(mod) {
    const entries = this.report.ledger.created.filter(r => r.module === mod.id && !r.deleted);
    if (!entries.length) return;
    const wasCleaning = this.cleaning;
    this.cleaning = true;
    try {
      for (const entry of entries) {
        const ok = await this.deleteBookmark(entry);
        if (!ok) { this.setFatal('module_cleanup_failed'); break; }
      }
    } finally { this.cleaning = wasCleaning; }
  }

  // ---- screenshots -----------------------------------------------------------
  async applyScheme(page, scheme) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(scheme => {
      const root = document.documentElement;
      // Mirror the early theme scripts for the default (no preset) theme.
      if (!localStorage.getItem('pp-theme-preset')) { if (scheme === 'dark') root.dataset.theme = 'flexoki-dark'; else delete root.dataset.theme; }
    }, scheme);
    this.scheme = scheme;
  }

  async shot(page, state, { surface = 'page', service = '', keys = [], locales, schemes } = {}) {
    if (!this.shotsEnabled || !page) return null;
    this.throwIfFatal();
    const dir = this.shotsDir || join(this.runDir, 'shots');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.report.shots.dir = dir;
    this.report.shots.manifest = join(dir, 'shots.json');
    const locs = locales || [this.locale], schs = schemes || [this.scheme];
    const originalLocale = this.locale, originalScheme = this.scheme;
    const results = [];
    // A toolbar popup is as wide as its body (at most 800px) and at most
    // 600px tall, and scrolls vertically past that. Shoot it at that size:
    // a key control below the fold is reachable by scrolling, one pushed past
    // the clipped right edge is a finding.
    let viewport = null;
    if (surface === 'popup') {
      viewport = page.viewportSize();
      const width = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().width));
      await page.setViewportSize({ width: Math.max(320, Math.min(800, width)), height: 600 });
    }
    for (const locale of locs) {
      if (locale !== this.locale) {
        await this.sw(async locale => chrome.storage.local.set({ optLang: locale }), locale);
        await page.evaluate(async () => { if (typeof initI18n === 'function') { initI18n(); await pbpI18nReady(); } });
        this.locale = locale;
      }
      for (const scheme of schs) {
        if (scheme !== this.scheme) await this.applyScheme(page, scheme);
        const n = String(++this.shotCount).padStart(2, '0');
        const safe = v => String(v || 'x').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
        const file = join(dir, `${n}-${safe(service)}-${safe(surface)}-${safe(state)}-${safe(locale)}-${safe(scheme)}.png`);
        const consoleBefore = this.report.console.length, errorsBefore = this.report.pageErrors.length;
        const result = await takeShot(page, { file, secrets: this.secrets, keys });
        const entry = {
          n: Number(n), file: result.ok ? file : '', module: this.currentModule?.id || 'connect', service, surface, state, locale, scheme,
          geometry: result.geometry || null, consoleDelta: this.report.console.length - consoleBefore, pageErrorDelta: this.report.pageErrors.length - errorsBefore,
          consoleTotal: this.report.console.filter(c => c.surface && page.url().includes(c.surface)).length,
        };
        this.shotsManifest ||= [];
        this.shotsManifest.push(entry);
        writePrivateJson(this.report.shots.manifest, this.shotsManifest);
        this.report.shots.count = this.shotsManifest.filter(s => s.file).length;
        if (!result.ok) { this.persist(); fail(result.code); }
        if (result.geometry && !result.geometry.ok) {
          const g = result.geometry;
          this.report.findings.push({
            kind: 'geometry', module: entry.module, shot: file, overflow: g.overflow, viewport: g.viewport, scrollWidth: g.scrollWidth, scrollHeight: g.scrollHeight,
            overflowBy: g.overflowBy.map(e => `${e.el}@${e.left}-${e.right}`), keys: g.keys.filter(k => k.state !== 'ok' && k.state !== 'scroll').map(k => k.selector + ':' + k.state),
          });
        }
        results.push(entry);
      }
    }
    if (this.locale !== originalLocale) {
      await this.sw(async locale => chrome.storage.local.set({ optLang: locale }), originalLocale);
      await page.evaluate(async () => { if (typeof initI18n === 'function') { initI18n(); await pbpI18nReady(); } });
      this.locale = originalLocale;
    }
    if (this.scheme !== originalScheme) await this.applyScheme(page, originalScheme);
    if (viewport) await page.setViewportSize(viewport);
    this.persist();
    return results;
  }

  // ---- cleanup ----------------------------------------------------------------
  async deleteBookmark(entry) {
    const inst = this.instances[entry.instance];
    try {
      // Only this run's pool URLs are deleted; any other entry is not even read.
      check((this.pools[entry.instance] || []).includes(entry.url), 'cleanup_url');
      if (inst.service === 'pinboard') {
        // By the ledger's URL only: posts/delete ("done", or "item not
        // found" when nothing is there), then posts/get must find nothing.
        check(entry.id === pinboardLedgerId(this.pools[entry.instance], entry.url), 'cleanup_url');
        const answer = await this.api(entry.instance, 'posts/delete?url=' + encodeURIComponent(entry.url));
        check(['done', 'item not found'].includes(answer?.result_code), 'cleanup_delete');
        check(await this.pinboardPost(entry.instance, entry.url) === null, 'cleanup_delete');
        this.notePinboardEmpty(entry.instance, entry.url);
        entry.deleted = true;
        this.report.cleanup.entries.push({ kind: 'bookmark', instance: entry.instance, id: entry.id, deleted: true });
        this.persist();
        return true;
      }
      const path = recordPath(inst.service, entry.id);
      const row = await this.api(entry.instance, path, { allow404: true });
      if (row !== null) {
        check(rowUrl(inst.service, row) === entry.url, 'cleanup_url');
        await this.api(entry.instance, path, { method: 'DELETE' });
      }
      check(await this.api(entry.instance, path, { allow404: true }) === null, 'cleanup_delete');
      entry.deleted = true;
      this.report.cleanup.entries.push({ kind: 'bookmark', instance: entry.instance, id: entry.id, deleted: true });
      this.persist();
      return true;
    } catch (error) {
      this.report.cleanup.entries.push({ kind: 'bookmark', instance: entry.instance, id: entry.id, deleted: false, code: failureCode(error, this.secrets) });
      this.persist();
      return false;
    }
  }

  // Pinboard pool URLs read empty in this cleanup after the browser closed.
  // Nothing writes to Pinboard after that but this cleanup, which only
  // deletes, so such a URL stays empty and is not read again. Never filled
  // while a browser is open (a module's own cleanup).
  notePinboardEmpty(instance, url) { if (this.pinboardEmpty && !this.ctx) this.pinboardEmpty.add(instance + ' ' + url); }

  async cleanupAll() {
    const entries = this.report.cleanup.entries;
    // 1. Stop the browser (and with it queue replays and other workers).
    if (this.ctx && this.worker) await this.syncGuard().catch(() => {});
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) await ctx.close().catch(() => {});
    this.worker = null;
    this.pinboardEmpty = new Set();
    if (this.fakeAi) {
      this.report.fakeAi.calls = this.fakeAi.all();
      await this.fakeAi.close().catch(() => {});
    }
    // 2-6. Service objects, per instance. Before the browser starts and
    // before any Node write, nothing can exist, so a failed preflight costs
    // no cleanup requests.
    let apiOk = true;
    for (const instance of Object.keys(this.instances)) {
      const inst = this.instances[instance];
      const ledgered = this.report.ledger.created.some(r => r.instance === instance && !r.deleted) || this.report.ledger.lists.some(l => l.instance === instance && !l.deleted);
      if (!inst.token) {
        if (ledgered && this.target === 'user') { apiOk = false; entries.push({ kind: 'instance', instance, deleted: false, code: 'cleanup_token_missing' }); }
        continue;
      }
      if (!this.writesPossible && !ledgered) { entries.push({ kind: 'instance', instance, deleted: true, skipped: 'no_writes_possible' }); continue; }
      try {
        for (const entry of this.report.ledger.created.filter(r => r.instance === instance && !r.deleted)) apiOk = (await this.deleteBookmark(entry)) && apiOk;
        apiOk = (await this.cleanupLists(instance)) && apiOk;
        apiOk = (await this.cleanupPool(instance)) && apiOk;
        apiOk = (await this.cleanupTags(instance)) && apiOk;
        apiOk = (await this.verifyClean(instance)) && apiOk;
      } catch (error) {
        apiOk = false;
        entries.push({ kind: 'instance', instance, deleted: false, code: failureCode(error, this.secrets) });
      }
    }
    // 7. Profile and temporary files.
    let filesOk = true;
    try {
      for (const name of existsSync(this.runDir) ? readdirSync(this.runDir) : []) if (name === 'profile' || name.startsWith('env-')) rmSync(join(this.runDir, name), { recursive: true, force: true });
      entries.push({ kind: 'profile', deleted: true });
    } catch { filesOk = false; entries.push({ kind: 'profile', deleted: false }); }
    // 8. Temporary containers and network, by this run's exact names.
    const tempOk = this.docker ? await this.removeTemp() : true;
    // A --cleanup of a report on disk keeps the run's own counts (the
    // summary's request line is the run's) and records its own apart.
    if (this.resumed) this.report.cleanup.counts = this.counts;
    else this.report.counts = this.counts;
    this.report.cleanup.apiVerified = apiOk;
    // Removing a temporary container removes its tmpfs data, so residue on a
    // temporary instance cannot outlive the run; apiVerified still fails the
    // run so cleanup code is proven against temp before it meets a user
    // instance. On the user target the API pass is the only cleanup.
    this.report.cleanup.complete = filesOk && tempOk && (this.target === 'temp' ? true : apiOk);
    this.persist();
  }

  async removeTemp() {
    const docker = this.docker;
    // No record yet (a run killed before startTemp wrote one): every container
    // and the network are recorded before they are created, so none exists,
    // and the leftover check below confirms it.
    const temp = this.report.temp ||= { names: [], network: '' };
    try {
      // A command still running when cleanup began finishes first; only then
      // are the names read, removed and the leftovers checked.
      await docker.settle();
      const names = [...(temp.names || [])].reverse();
      await docker.remove(names);
      if (temp.network) await docker.removeNetwork(temp.network);
      const left = await docker.ownLeftovers();
      temp.removed = left.length === 0;
      temp.residue = left;
      this.report.cleanup.entries.push({ kind: 'temp', deleted: left.length === 0, names: names.length });
      this.persist();
      return left.length === 0;
    } catch (error) {
      this.report.cleanup.entries.push({ kind: 'temp', deleted: false, code: failureCode(error, this.secrets) });
      this.persist();
      return false;
    }
  }

  // In the run's own process a ledger list is deleted after its checks. A
  // --cleanup (this.resumed) knows its lists only from a report on disk,
  // which could have been edited to name the user's own Read Later list
  // (same marker, possibly empty): it reads each one and deletes none. A
  // list still there is residue for a person; one already gone is confirmed.
  async cleanupLists(instance) {
    let ok = true;
    for (const item of this.report.ledger.lists.filter(l => l.instance === instance && !l.deleted)) {
      try {
        const row = await this.api(instance, 'lists/' + item.id, { allow404: true });
        if (row !== null && this.resumed) {
          ok = false;
          this.report.cleanup.entries.push({ kind: 'list', instance, id: item.id, deleted: false, residue: true, code: 'residue_list_resume' });
          this.persist();
          continue;
        }
        if (row !== null) {
          const members = await this.api(instance, 'lists/' + item.id + '/bookmarks?limit=1');
          check(row.description === LIST_MARKER && !row.public && !row.hasCollaborators && row.userRole === 'owner' && !members.bookmarks.length, 'cleanup_list');
          await this.api(instance, 'lists/' + item.id, { method: 'DELETE' });
        }
        check(await this.api(instance, 'lists/' + item.id, { allow404: true }) === null, 'cleanup_list_delete');
        item.deleted = true;
        this.report.cleanup.entries.push({ kind: 'list', instance, id: item.id, deleted: true });
      } catch (error) {
        ok = false;
        this.report.cleanup.entries.push({ kind: 'list', instance, id: item.id, deleted: false, code: failureCode(error, this.secrets) });
      }
      this.persist();
    }
    return ok;
  }

  // Pool fallback: a pool URL that exists without a ledger entry (a creation
  // the route never recorded) is adopted after an exact URL check, then
  // deleted like any ledger bookmark.
  async cleanupPool(instance) {
    const inst = this.instances[instance];
    let ok = true;
    for (const url of this.pools[instance] || []) {
      if (this.report.ledger.created.some(r => r.instance === instance && r.url === url && r.deleted)) continue;
      try {
        if (inst.service === 'pinboard') {
          if (this.pinboardEmpty?.has(instance + ' ' + url)) continue;
          if (await this.pinboardPost(instance, url) === null) { this.notePinboardEmpty(instance, url); continue; }
          const id = pinboardLedgerId(this.pools[instance], url);
          let known = this.report.ledger.created.find(r => r.instance === instance && r.id === id);
          if (!known) { known = { instance, id, url, source: 'pool', module: '', deleted: false }; this.report.ledger.created.push(known); this.persist(); }
          ok = (await this.deleteBookmark(known)) && ok;
          continue;
        }
        const data = await this.api(instance, (inst.service === 'linkding' ? 'bookmarks/check/' : 'bookmarks/check-url') + '?url=' + encodeURIComponent(url));
        const id = inst.service === 'linkding' ? data.bookmark?.id : data.bookmarkId;
        if (!id) continue;
        if (inst.service === 'linkding') check(data.bookmark.url === url, 'cleanup_pool_url');
        const entry = { instance, id: String(id), url, source: 'pool', module: '', deleted: false };
        if (!this.report.ledger.created.some(r => r.instance === instance && r.id === entry.id)) this.report.ledger.created.push(entry);
        ok = (await this.deleteBookmark(this.report.ledger.created.find(r => r.instance === instance && r.id === entry.id))) && ok;
      } catch (error) {
        ok = false;
        this.report.cleanup.entries.push({ kind: 'pool', instance, deleted: false, code: failureCode(error, this.secrets) });
      }
    }
    return ok;
  }

  // Every tag on the instance whose name starts with this run's full prefix:
  // a read-only sweep that resolves ledger keys to ids and finds residue.
  // Nothing is deleted because it is listed here (cleanupTags deletes only
  // ledger tags).
  async runTags(instance) {
    check(this.prefix === 'pbp-it-' + this.runId && RUN_DIR_RE.test(this.prefix), 'cleanup_prefix_invalid', true);
    const inst = this.instances[instance];
    const out = [];
    if (inst.service === 'pinboard') {
      // tags/get: { "<tag>": count, ... } over the whole account.
      const data = await this.api(instance, 'tags/get');
      check(data && typeof data === 'object' && !Array.isArray(data), 'pinboard_tags_shape');
      for (const name of Object.keys(data)) if (name.toLowerCase().startsWith(this.prefix)) out.push({ id: name, name });
    } else if (inst.service === 'karakeep') {
      let cursor = '', pages = 0;
      do {
        check(++pages <= 20, 'cleanup_pagination');
        const data = await this.api(instance, 'tags?limit=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        for (const tag of data.tags || []) if (String(tag.name).toLowerCase().startsWith(this.prefix)) out.push(tag);
        cursor = data.nextCursor || '';
      } while (cursor);
    } else if (inst.service === 'linkding') {
      let path = 'tags/?limit=100';
      const seen = new Set();
      while (path) {
        check(!seen.has(path) && seen.size < 100, 'cleanup_pagination');
        seen.add(path);
        const data = await this.api(instance, path);
        for (const tag of data.results || []) if (String(tag.name).toLowerCase().startsWith(this.prefix)) out.push(tag);
        path = data.next || '';
      }
    }
    return out;
  }

  // The tags cleanup may delete: ledger entries a write reserved before it
  // left (source route, sw or node), under this run's full prefix. A tag
  // only a read-back found (source read) was named by no write the guards
  // judged, so it is residue like a tag missing from the ledger.
  ledgerTagKeys(instance) {
    const keys = new Map();
    for (const t of this.report.ledger.tags || []) {
      if (t.instance === instance && TAG_WRITE_SOURCES.includes(t.source) && typeof t.key === 'string' && t.key.toLowerCase().startsWith(this.prefix)) keys.set(t.key, t);
    }
    return keys;
  }

  // Deletes only this run's ledger tags (ledgerTagKeys), each after checking
  // its name carries the run's full prefix and no bookmark refers to it, then
  // reading it back gone. The sweep is how a ledger key finds its id; a
  // run-prefix tag outside the ledger is residue: reported, never deleted,
  // and the cleanup is incomplete until someone removes it by hand. The same
  // rule holds on a temporary instance (its container goes anyway).
  async cleanupTags(instance) {
    const inst = this.instances[instance];
    if (inst.service === 'pinboard') return true;
    let ok = true;
    const tags = await this.runTags(instance);
    if (!tags.length) return true;
    const ledgerKeys = this.ledgerTagKeys(instance);
    for (const tag of tags) {
      const id = String(tag.id);
      const key = liveTagKey(inst.service, tag.name);
      const entry = ledgerKeys.get(key);
      if (!entry || (entry.id && entry.id !== id)) {
        ok = false;
        const known = (this.report.ledger.tags || []).some(t => t.instance === instance && t.key === key);
        this.report.cleanup.entries.push({ kind: 'tag', instance, id, deleted: false, residue: true, code: !known ? 'residue_tag_not_in_ledger' : entry ? 'residue_tag_id_mismatch' : 'residue_tag_unreserved' });
        this.persist();
        continue;
      }
      try {
        check(String(tag.name).toLowerCase().startsWith(this.prefix) && key.toLowerCase().startsWith(this.prefix), 'cleanup_tag_prefix');
        if (inst.service === 'karakeep') check(tag.numBookmarks === 0, 'cleanup_tag_referenced');
        if (inst.service === 'linkding') {
          // Each tag gets its own searches, active and archived: with
          // profile.legacy_search (not visible in the profile API) every word
          // is ANDed, so one "#a or #b" query would miss a bookmark that
          // carries only one of them. A name the search syntax cannot express
          // as a single tag is kept.
          check(/^[^\s()"']+$/.test(tag.name), 'cleanup_tag_unsearchable');
          const query = '?limit=1&q=' + encodeURIComponent('#' + tag.name);
          for (const list of ['bookmarks/', 'bookmarks/archived/']) check((await this.api(instance, list + query)).count === 0, 'cleanup_tag_referenced');
        }
        this.deletableTags.add(instance + ':' + id);
        const path = 'tags/' + encodeURIComponent(id) + (inst.service === 'linkding' ? '/' : '');
        await this.api(instance, path, { method: 'DELETE' });
        check(await this.api(instance, path, { allow404: true }) === null, 'cleanup_tag_delete');
        this.report.cleanup.entries.push({ kind: 'tag', instance, id, deleted: true });
      } catch (error) {
        ok = false;
        this.report.cleanup.entries.push({ kind: 'tag', instance, id, deleted: false, code: failureCode(error, this.secrets) });
      }
      this.persist();
    }
    return ok;
  }

  async verifyClean(instance) {
    const inst = this.instances[instance];
    try {
      for (const url of this.pools[instance] || []) {
        if (inst.service === 'pinboard') {
          if (!this.pinboardEmpty?.has(instance + ' ' + url)) check(await this.pinboardPost(instance, url) === null, 'verify_pool_residue');
          continue;
        }
        const data = await this.api(instance, (inst.service === 'linkding' ? 'bookmarks/check/' : 'bookmarks/check-url') + '?url=' + encodeURIComponent(url));
        check(!(inst.service === 'linkding' ? data.bookmark : data.bookmarkId), 'verify_pool_residue');
      }
      check((await this.runTags(instance)).length === 0, 'verify_tag_residue');
      for (const item of this.report.ledger.lists.filter(l => l.instance === instance)) check(await this.api(instance, 'lists/' + item.id, { allow404: true }) === null, 'verify_list_residue');
      this.report.cleanup.entries.push({ kind: 'verify', instance, deleted: true });
      return true;
    } catch (error) {
      this.report.cleanup.entries.push({ kind: 'verify', instance, deleted: false, code: failureCode(error, this.secrets) });
      return false;
    } finally { this.persist(); }
  }

  // ---- summary ----------------------------------------------------------------
  // Two layers: report.json holds everything; summary.zh.md fits one screen
  // (SUMMARY_MAX_LINES) and is what the main session reads. Each section
  // shows its first entries and counts the rest, which stay in the report.
  writeSummary() {
    if (!existsSync(this.runDir)) return;
    const r = this.report;
    const sec = ms => (ms / 1000).toFixed(1) + 's';
    const lines = [];
    const capped = (items, max, render, rest = n => `- 另有 ${n} 条，见 report.json`) => {
      for (const item of items.slice(0, max)) lines.push(render(item));
      if (items.length > max) lines.push(rest(items.length - max));
    };
    lines.push(`# 真实测试摘要 ${r.runId}`);
    lines.push(`- 结论：${r.passed ? '通过' : '未通过'}${r.failure ? `（${r.failure.phase}：${r.failure.code}）` : ''}；目标 ${r.target || '未定'}；HEAD ${(r.head || '未知').slice(0, 12)}；工作区干净：${r.clean === null ? '未检查' : r.clean ? '是' : '否'}`);
    const instanceNames = Object.keys(r.instances || {});
    if (instanceNames.length) lines.push(`- 请求：${instanceNames.map(i => `${i} Node ${r.counts?.[i]?.node ?? 0} / 浏览器 ${r.counts?.[i]?.browser ?? 0}`).join('；')}${r.fakeAi ? `；假 AI ${(r.fakeAi.calls || []).filter(c => c.status === 200).length}/${r.fakeAi.limit}` : ''}`);
    // The latest --cleanup pass, counted apart from the run.
    if (r.cleanup?.counts && instanceNames.length) lines.push(`- 续清请求（第 ${r.cleanup.resumed || 1} 次 --cleanup）：${instanceNames.map(i => `${i} Node ${r.cleanup.counts[i]?.node ?? 0}`).join('；')}`);
    // The Pinboard account is named nowhere in this file.
    if (r.pinboard) {
      const th = r.timing?.throttle;
      lines.push(`- Pinboard：${r.pinboard.configured ? '已配置' : '未配置（凭据缺 pinboardToken，Pinboard 模块已跳过，不算失败）'}${th ? `；节流请求 ${th.requests} 次，等待 ${sec(th.waitedMs)}，429 ${th.rateLimited} 次；最大排队 ${th.maxQueueDepth ?? 0} 个、${sec(th.maxQueueMs || 0)}` : ''}`);
      // Queued past PINBOARD_QUEUE_WARN_MS: an extension-side timeout there
      // is the harness's doing, not a product defect.
      const queue = r.findings.filter(f => f.kind === 'pinboard_queue');
      if (th?.slowQueued) lines.push(`  - 排队超过 ${PINBOARD_QUEUE_WARN_MS / 1000}s 的请求 ${th.slowQueued} 个（扩展单请求超时 15s，此时的超时多半是工具造成的）：${queue.slice(0, 3).map(f => `${f.module || f.phase} ${sec(f.queuedMs)}`).join('，')}`);
    }
    if (r.stages?.length) lines.push(`- 阶段耗时：${r.stages.map(st => `${st.name} ${sec(st.ms)}${st.ok ? '' : '（失败）'}`).join('，')}`);
    const tt = r.timing?.totals || {};
    // timingSummary() runs in conclude(); a run cut off before it has none.
    if (!('modulesMs' in tt)) lines.push('- 耗时分类：未统计（运行未正常结束，见上方阶段耗时）');
    else lines.push(`- 耗时分类：容器启动 ${sec(tt.containerStartMs || 0)}，浏览器启动 ${sec(tt.browserStartMs || 0)}，连接 ${sec(tt.connectMs || 0)}，模块 ${sec(tt.modulesMs || 0)}，等待 ${sec(tt.waitMs || 0)}，节流等待 ${sec(tt.throttleMs || 0)}，清理 ${sec(tt.cleanupMs || 0)}`);
    if (r.timing?.slowest?.length) lines.push(`- 最慢 5 个阶段：${r.timing.slowest.map(x => `${x.name} ${sec(x.ms)}（${x.requests} 次请求${x.throttleMs ? `，节流 ${sec(x.throttleMs)}` : ''}${x.waitMs ? `，等待 ${sec(x.waitMs)}` : ''}）`).join('；')}`);
    lines.push('', '## 失败与证据');
    const bad = r.modules.filter(m => m.status !== 'passed');
    if (!bad.length) lines.push(`- 无模块失败（${r.modules.length} 个通过：${r.modules.map(m => m.id).join('，').slice(0, 300) || '无'}）。`);
    capped(bad, 5, m => {
      const shots = (this.shotsManifest || []).filter(x => x.module === m.id && x.file).map(x => x.file);
      const diffs = r.readBackDiffs.filter(d => d.module === m.id);
      // Still "running": the run was cut off in this module (kill -9, OOM, a
      // crash, a second signal) before it reached a verdict.
      const verdict = m.status === 'running' ? '中断（运行在此模块中被打断，未得出结论）' : `${m.status === 'aborted' ? '中止' : '失败'}于 ${m.failure?.phase}，${m.failure?.code}`;
      return `- ${m.id}：${verdict}；读回差异 ${diffs.length} 条${diffs[0] ? `（${diffs[0].code}：期望 ${diffs[0].expected.slice(0, 60)}，实际 ${diffs[0].actual.slice(0, 60)}）` : ''}；console 错误 ${r.console.filter(c => c.module === m.id).length} 条${shots.length ? `；截图 ${shots[shots.length - 1]}` : ''}`;
    });
    if (r.violations.length) lines.push(`- 守卫/预算触发：${r.violations.slice(0, 5).map(v => `${v.code}@${v.phase}`).join('，')}${r.violations.length > 5 ? ` 等 ${r.violations.length} 条` : ''}`);
    if (r.blockedOrigins.length) lines.push(`- 被拦截的外部来源（${r.blockedOrigins.length}）：${r.blockedOrigins.slice(0, 5).join('，')}`);
    for (const b of (r.blockedSamples || []).slice(0, 2)) lines.push(`  - 无法解析的 URL：${b.sample || '（空）'}，模块 ${b.module || '无'}，调用方 ${(b.where || '未知').slice(0, 80)}`);
    // What modules observed without asserting: evidence for review, not a verdict.
    const observed = r.modules.filter(m => Object.keys(m.notes || {}).length);
    if (observed.length) {
      lines.push('', '## 观察记录（未作断言）');
      capped(observed, 3, m => `- ${m.id}：${Object.entries(m.notes).map(([k, v]) => `${k}=${this.sanitize(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, 90)}`).join('；').slice(0, 220)}`);
    }
    lines.push('', '## 在修项结论（按 features）');
    const features = new Map();
    for (const m of r.modules) {
      const row = this.selected?.find(x => x.id === m.id);
      for (const f of row?.features || []) {
        // A feature named after another service says nothing about this module.
        const owner = SERVICE_TYPES.find(svc => f.startsWith(svc + '-'));
        if (owner && owner !== row.service) continue;
        const list = features.get(f) || [];
        list.push({ id: m.id, ok: m.status === 'passed', open: m.status === 'running' });
        features.set(f, list);
      }
    }
    if (!features.size) lines.push('- 本轮没有执行模块。');
    else {
      // A feature some module failed is failed; one whose only shortfall is
      // a module the run was cut off in is unfinished, not failed.
      const failed = [...features].filter(([, list]) => list.some(x => !x.ok && !x.open));
      const open = [...features].filter(([, list]) => list.some(x => x.open) && list.every(x => x.ok || x.open)).map(([f]) => f);
      const passed = [...features].filter(([, list]) => list.every(x => x.ok)).map(([f]) => f);
      if (passed.length) lines.push(`- 通过（${passed.length}）：${passed.join('，').slice(0, 300)}`);
      if (open.length) lines.push(`- 未完成（${open.length}，运行被打断，不算失败）：${open.join('，').slice(0, 300)}`);
      capped(failed, 4, ([f, list]) => `- 未通过 ${f}：${list.filter(x => !x.ok).map(x => x.id).join('，')}`);
    }
    lines.push('', '## 截图与布局');
    const geometry = r.findings.filter(x => x.kind === 'geometry');
    lines.push(`- 截图 ${r.shots.count} 张${r.shots.dir ? `，目录 ${r.shots.dir}` : '（本轮未开启 --shots）'}；几何断言未通过 ${geometry.length} 张`);
    capped(geometry, 2, f => `- ${f.shot}：视口 ${f.viewport?.width}×${f.viewport?.height}，横向溢出 ${f.overflow}px${f.overflowBy?.length ? `，越界 ${f.overflowBy.join('、')}` : ''}；够不到 ${f.keys.join('、') || '无'}`);
    lines.push('', '## 未覆盖项');
    const gaps = [...r.skipped.map(x => `${x.id}：因 ${x.reason} 未执行${x.note ? `（${x.note}）` : ''}`), ...UNCOVERED.filter(u => !(u.coveredBy && r.modules.some(m => globToRegExp(u.coveredBy).test(m.id)))).map(u => u.text)];
    capped(gaps, 4, g => `- ${g}`);
    lines.push('', '## 清理');
    lines.push(`- 书签：创建 ${r.ledger.created.length}，删除 ${r.ledger.created.filter(x => x.deleted).length}；列表：创建 ${r.ledger.lists.length}，删除 ${r.ledger.lists.filter(x => x.deleted).length}；前缀标签 ${r.ledger.tags.length}；清理完成：${r.cleanup.complete ? '是' : '否'}${r.temp ? `；临时容器已删除：${r.temp.removed ? '是' : '否'}` : ''}`);
    // This pass only: report.cleanup.entries keeps every pass, and a
    // --cleanup that confirms residue removed by hand must not report it again.
    const start = r.cleanup.passStart;
    const pass = r.cleanup.entries.slice(Number.isInteger(start) && start >= 0 && start <= r.cleanup.entries.length ? start : 0);
    const residue = pass.filter(e => e.residue);
    if (residue.length) lines.push(`- 残留 ${residue.length} 项（工具不删，需人工核对后处理，再跑 --cleanup 复核）：${[...new Set(residue.map(e => e.kind === 'list' ? '续清不删的 Karakeep 列表' : '带本轮前缀但不在账本里或未经写入预留的标签'))].join('；')}`);
    capped(pass.filter(e => e.deleted === false), 3, e => `- 未清理：${e.kind} ${e.instance || ''} ${e.id || ''} ${e.code || ''}`.trim());
    lines.push(`- 完整报告：${this.reportPath}`);
    // One screen: anything past the cap is in report.json.
    const out = lines.length > SUMMARY_MAX_LINES ? [...lines.slice(0, SUMMARY_MAX_LINES - 1), '- （摘要已截断，完整内容见 report.json）'] : lines;
    this.summaryPath = join(this.runDir, 'summary.zh.md');
    writeFileSync(this.summaryPath, this.sanitize(out.join('\n')) + '\n', { mode: 0o600 });
    chmodSync(this.summaryPath, 0o600);
  }
}

// Second guard layer, evaluated inside the service worker. It receives the
// rule as source text (CSP forbids eval inside the worker; CDP evaluation of
// the whole expression is how Playwright delivers any worker function).
export function installWorkerGuard(rule, cfg, token) {
  const original = globalThis.fetch;
  const state = globalThis.pbpLiveGuard = { token, cfg, created: [], lists: [], tags: [], pending: {}, inflight: [], counts: {}, writes: {}, offline: '', violations: [] };
  // The route layer shares a create it recorded (shareCreated) as soon as it
  // has the answer, possibly before this layer reads the same answer and
  // frees the slot. A bookmark create in flight is not counted again once a
  // record of its URL arrived after it left: per URL, the records added since
  // the earliest such flight left offset at most that many flights. A record
  // that was there before (a deleted bookmark whose URL is saved again)
  // offsets nothing.
  const view = () => {
    const shared = {};
    const groups = {};
    for (const f of state.inflight) (groups[f.instance + ' ' + f.url] = groups[f.instance + ' ' + f.url] || []).push(f);
    for (const flights of Object.values(groups)) {
      const { instance, url } = flights[0];
      const now = state.created.filter(r => r.instance === instance && r.url === url).length;
      const added = now - Math.min(...flights.map(f => f.before));
      shared[instance] = (shared[instance] || 0) + Math.max(0, Math.min(flights.length, added));
    }
    const pending = {};
    for (const [id, p] of Object.entries(state.pending)) pending[id] = { bookmarks: Math.max(0, p.bookmarks - (shared[id] || 0)), lists: p.lists };
    return { created: state.created, lists: state.lists, tags: state.tags, pending };
  };
  globalThis.fetch = async function pbpGuardFetch(input, opts = {}) {
    // fetch accepts a string, a URL or a Request.
    const url = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input));
    // fetch resolves a relative URL against the worker script, so it names an
    // extension resource; Chrome's own chrome.action.setIcon({ path }) binding
    // fetches "icons/..." that way. Extension resources never leave the browser.
    let resolved = '';
    try { resolved = new URL(url, globalThis.location?.href).href; } catch (_) { /* judged as given below */ }
    if (url.startsWith('chrome-extension://') || resolved.startsWith('chrome-extension://')) return original(input, opts);
    const method = String(opts.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    const body = typeof opts.body === 'string' ? opts.body : null;
    const decision = rule(state.cfg, view(), { url, method, body });
    if (!decision.ok) {
      let origin = 'invalid';
      try { origin = new URL(url).origin; } catch (_) { /* keep invalid */ }
      const violation = { code: decision.code, instance: decision.instance || '', origin };
      // A URL that does not parse cannot be told apart by origin: keep its
      // shape without query or fragment, and the calling frames.
      if (origin === 'invalid') {
        violation.sample = typeof input + ':' + url.split(/[?#]/)[0].slice(0, 60);
        violation.where = String(new Error().stack || '').split('\n').slice(1).map(line => line.trim().replace(/^at /, '')).filter(line => !line.startsWith('pbpGuardFetch') && !line.includes('.pbpGuardFetch')).slice(0, 3).join(' < ').slice(0, 300);
      }
      state.violations.push(violation);
      throw new Error(decision.code);
    }
    const id = decision.instance;
    state.counts[id] = (state.counts[id] || 0) + 1;
    if (state.counts[id] > (cfg.caps[id] ?? 60)) { state.violations.push({ code: 'live_guard_request_budget', instance: id }); throw new Error('live_guard_request_budget'); }
    // Only the transport fails; the product save, queue and replay code is real.
    if (state.offline && state.offline === id) throw new TypeError('Failed to fetch');
    if (method !== 'GET' && method !== 'HEAD') state.writes[id] = (state.writes[id] || 0) + 1;
    // What leaves counts from here: its run tags now, a creation's slot until
    // its answer is recorded (kept without an answer or after a server
    // error, when the creation may exist; a refusal, 4xx, made nothing).
    for (const key of decision.tags || []) if (!state.tags.some(t => t.instance === id && t.key === key)) state.tags.push({ instance: id, key });
    const slot = decision.kind === 'create' ? 'bookmarks' : decision.kind === 'list-create' ? 'lists' : '';
    const pending = slot ? (state.pending[id] = state.pending[id] || { bookmarks: 0, lists: 0 }) : null;
    let held = !!slot;
    const flight = slot === 'bookmarks' ? { instance: id, url: decision.url, before: state.created.filter(r => r.instance === id && r.url === decision.url).length } : null;
    const release = () => { if (held) { held = false; pending[slot]--; if (flight) state.inflight.splice(state.inflight.indexOf(flight), 1); } };
    if (slot) pending[slot]++;
    if (flight) state.inflight.push(flight);
    const response = await original(input, opts);
    if (slot && !response.ok && response.status < 500) release();
    if (slot && response.ok) {
      const row = await response.clone().json();
      if (decision.kind === 'create' && cfg.instances[id].service === 'pinboard') {
        // posts/add answers {"result_code":"done"} with HTTP 200 for a save,
        // and a 200 with another code ("item already exists") for none.
        const entryId = 'pool-' + ((cfg.pools[id] || []).indexOf(decision.url) + 1);
        if (row?.result_code === 'done' && !state.created.some(r => r.instance === id && r.id === entryId)) state.created.push({ instance: id, id: entryId, url: decision.url });
      } else if (decision.kind === 'create') {
        const service = cfg.instances[id].service;
        const actual = service === 'linkding' ? row.url : row.content?.url;
        if (actual !== decision.url) { state.violations.push({ code: 'live_guard_response', instance: id }); throw new Error('live_guard_response'); }
        if (!state.created.some(r => r.instance === id && r.id === String(row.id))) state.created.push({ instance: id, id: String(row.id), url: actual });
      } else if (!state.lists.some(l => l.instance === id && l.id === String(row.id))) state.lists.push({ instance: id, id: String(row.id) });
      release();
    }
    return response;
  };
}

// ---------------------------------------------------------------------------
// --cleanup <report>: resume an incomplete cleanup with a fresh reserve.
// ---------------------------------------------------------------------------
// --cleanup acts with the user's credentials on whatever its report names, so
// before anything is read or sent the report is held to what this harness
// writes for its run id: its own directory in the state directory, a real one
// and not a link (cleanup removes `profile` and `env-*` next to the report),
// the prefix that selects tags, the target, instance ids and services,
// loopback bases (given again on the command line for the user target, so a
// report cannot send a token elsewhere), the exact URL pools, the ledger's
// shape and the container names. A report that fails any of this was edited,
// damaged or written elsewhere, and is refused whole, without a write.
export function validateResumeReport(report, reportPath, { values = {}, state = stateDir() } = {}) {
  const invalid = 'cleanup_report_invalid';
  const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
  check(isObject(report) && report.harness === HARNESS_VERSION && typeof report.runId === 'string' && RUN_DIR_RE.test('pbp-it-' + report.runId), invalid);
  const runId = report.runId;
  const real = file => { try { return realpathSync(file); } catch { return ''; } };
  // The run directory itself, never a link to one: its realpath alone would
  // pass a link, and cleanup would then remove `profile` and `env-*` inside
  // the link's target. The state directory may be reached through a link.
  let entry = null;
  try { entry = lstatSync(join(state, 'pbp-it-' + runId)); } catch { /* missing: refused below */ }
  const runDir = entry && entry.isDirectory() && !entry.isSymbolicLink() && real(state) ? join(real(state), 'pbp-it-' + runId) : '';
  check(runDir && real(join(state, 'pbp-it-' + runId)) === runDir && real(reportPath) === join(runDir, 'report.json'), 'cleanup_report_location');
  check(report.prefix === 'pbp-it-' + runId && ['', 'user', 'temp'].includes(report.target), invalid);
  check(['instances', 'pools', 'ledger', 'cleanup'].every(key => isObject(report[key])) && Array.isArray(report.cleanup.entries) && Array.isArray(report.violations), invalid);
  const { created, lists, tags } = report.ledger;
  check(Array.isArray(created) && Array.isArray(lists) && Array.isArray(tags), invalid);
  const target = report.target;
  if (!target) {
    // Written before the arguments were read: nothing can exist yet.
    check(!Object.keys(report.instances).length && !Object.keys(report.pools).length && !created.length && !lists.length && !tags.length && report.temp == null, invalid);
    return report;
  }
  check(!values.target || values.target === target, 'cleanup_target_mismatch');
  if (target === 'temp') check(!values.credentials && !values.linkding && !values.karakeep, 'temp_target_rejects_user_endpoints');
  const ids = target === 'temp' ? Object.keys(TEMP_INSTANCES) : ['linkding', 'karakeep', 'pinboard'];
  const serviceOf = id => (target === 'temp' ? TEMP_INSTANCES[id].service : id);
  for (const [id, info] of Object.entries(report.instances)) {
    check(ids.includes(id) && isObject(info) && info.service === serviceOf(id), invalid);
    // Pinboard's root is fixed: a report naming any base for it is refused.
    if (id === 'pinboard') { check(info.base === '', invalid); continue; }
    let base = '';
    try { base = validateBase(info.base); } catch { /* refused below */ }
    check(base && base === info.base, invalid);
    if (target === 'user') {
      check(values[info.service], 'cleanup_base_required');
      check(validateBase(values[info.service]) === base, 'cleanup_base_mismatch');
    }
  }
  for (const [id, pool] of Object.entries(report.pools)) {
    check(ids.includes(id) && Array.isArray(pool), invalid);
    // A plan within caps checks each pool URL once in its preflight, so no
    // genuine pool is longer than this.
    const cap = BUDGETS[target][id];
    check(pool.length <= cap.node - cap.cleanupReserve - 2, invalid);
    const expected = poolUrls(target, runId, id, pool.length);
    check(pool.every((url, i) => url === expected[i]), invalid);
  }
  const known = instance => typeof instance === 'string' && Object.hasOwn(report.instances, instance);
  for (const e of created) check(isObject(e) && known(e.instance) && safeId(e.id) && typeof e.url === 'string' && typeof e.deleted === 'boolean', invalid);
  // A Pinboard entry is deleted by its URL: it must be one of the run's pool
  // URLs, under the id the runner gives it.
  for (const e of created.filter(r => r.instance === 'pinboard')) check(Array.isArray(report.pools.pinboard) && e.id === pinboardLedgerId(report.pools.pinboard, e.url), invalid);
  // Cleanup deletes ledger tags: each names a known instance, a key under
  // the run's full prefix, and how it was recorded.
  for (const t of tags) check(isObject(t) && known(t.instance) && typeof t.key === 'string' && t.key.toLowerCase().startsWith(report.prefix) && [...TAG_WRITE_SOURCES, 'read'].includes(t.source) && (t.id === '' || safeId(t.id) || (typeof t.id === 'string' && t.id.toLowerCase().startsWith(report.prefix))), invalid);
  for (const l of lists) check(isObject(l) && known(l.instance) && report.instances[l.instance].service === 'karakeep' && safeId(l.id) && [undefined, true, false].includes(l.deleted), invalid);
  if (target === 'user') check(report.temp == null, invalid);
  else if (report.temp != null) {
    const names = tempNames(runId);
    const ownNames = new Set(Object.values(names).filter(n => n !== names.prefix));
    check(isObject(report.temp) && (report.temp.names === undefined || (Array.isArray(report.temp.names) && report.temp.names.every(n => ownNames.has(n)))) && [undefined, '', names.net].includes(report.temp.network), invalid);
  }
  return report;
}

// The screenshot manifest a run wrote next to its shots: only file names
// for the summary, read as data. Anything else reads as no screenshots.
function readShotsManifest(path) {
  if (typeof path !== 'string' || basename(path) !== 'shots.json') return [];
  try {
    const list = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(list) ? list.filter(x => x && typeof x.module === 'string' && typeof x.file === 'string') : [];
  } catch { return []; }
}

async function resumeCleanup(opts) {
  check(!opts.errors.length, opts.errors[0] || 'arguments');
  const path = resolve(opts.values.cleanup);
  let report;
  try { report = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('cleanup_report_invalid'); }
  validateResumeReport(report, path, { values: opts.values, state: stateDir() });
  const run = new LiveRun(opts);
  run.runId = report.runId;
  run.prefix = report.prefix;
  // The directory validateResumeReport checked, not whatever spelling of the
  // report path was given: cleanup removes files inside it.
  run.runDir = join(realpathSync(stateDir()), 'pbp-it-' + report.runId);
  run.reportPath = path;
  run.report = report;
  // A report without a timing section (none this version writes, kept as a
  // guard) gets one: a resumed cleanup times its Pinboard throttle like a
  // run does.
  const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!plain(report.timing) || !Array.isArray(report.timing.phases)) report.timing = { phases: [], totals: {}, slowest: [], throttle: null };
  if (!plain(report.timing.totals)) report.timing.totals = {};
  delete report.cleanup.error;
  run.target = report.target;
  run.stage = 'resume';
  run.writesPossible = true;
  // Lists are only checked here, never deleted (cleanupLists).
  run.resumed = true;
  // The summary is rewritten after this pass; it still reports the run's
  // module verdicts by feature (from the registry rows of the modules the
  // report lists) and the failed modules' screenshots.
  const ran = new Set((Array.isArray(report.modules) ? report.modules : []).map(m => m?.id));
  run.selected = expandRegistry(opts.modules || MODULES).filter(m => ran.has(m.id));
  run.shotsManifest = readShotsManifest(report.shots?.manifest);
  const release = acquireLock(run.state, { pid: process.pid, runId: run.runId, reportPath: path, started: new Date().toISOString() }, { resume: path });
  try {
    report.cleanup.resumed = (report.cleanup.resumed || 0) + 1;
    run.pools = report.pools;
    run.caps = {};
    run.reserve = {};
    for (const [instance, info] of Object.entries(report.instances)) {
      run.caps[instance] = BUDGETS[report.target][instance];
      run.reserve[instance] = 0;
      run.instances[instance] = { id: instance, service: info.service, base: info.base, root: apiRootFor(info.service, info.base), token: '' };
    }
    if (report.target === 'user') {
      run.opts.values.credentials = opts.values.credentials;
      run.plan = { instances: Object.keys(run.instances) };
      await run.loadCredentials();
    }
    if (report.target === 'temp') run.docker = createDocker({ runId: run.runId, exec: opts.dockerExec, stopped: () => true });
    run.cleaning = true;
    run.stage = 'cleanup';
    // Entries from here on are this pass's; earlier ones stay in the report.
    report.cleanup.passStart = report.cleanup.entries.length;
    await run.cleanupAll();
  } catch (error) {
    report.cleanup.complete = false;
    report.cleanup.error = failureCode(error, run.secrets);
  } finally {
    run.persist();
    // The summary shows this pass's cleanup (residue included); a report
    // missing a section the summary reads keeps the earlier summary.
    try { run.writeSummary(); } catch { /* report.json stays authoritative */ }
    release();
  }
  console.log('Local report: ' + path);
  console.log('Cleanup complete: ' + report.cleanup.complete);
  return report.cleanup.complete ? 0 : 1;
}

function printHelp() {
  console.log([
    'Opt-in: node scripts/bookmark-service-live.mjs --run [--target temp|user] [--scenario core|edges|readonly|ai|<glob>,...]',
    '  --target temp (default) starts throwaway containers from the images of the existing linkding / karakeep-web containers.',
    '  --target user --credentials /private/credentials.json --linkding http://127.0.0.1:PORT --karakeep http://127.0.0.1:PORT',
    '  Karakeep writes on --target user also require --confirm-karakeep-no-auto-ai (and a /signin check that auto AI is off).',
    '  --target user also requires --authorization LABEL: at most 3 rounds per label, counted in the state directory;',
    '  --plan --target user --authorization LABEL shows the rounds used and left. --cleanup never uses a round.',
    '--plan prints modules, budgets, URLs, containers, headed and shot needs without credentials, network, browser or Docker.',
    '--list prints module ids. --service linkding,karakeep[,pinboard] filters. --read-only = --scenario readonly.',
    '  On --target user linkding.core.snapshot runs only when named exactly (the harness cannot read the user\'s',
    '  automatic HTML snapshot switch); groups and globs skip it with that reason in --plan and the summary.',
    '  Pinboard runs on --target user only, with pinboardToken ("user:HEX") from --credentials; without that key its',
    '  modules are skipped. Every Pinboard request waits 3 s after the previous answer; --plan shows the floor.',
    '--shots [--shots-dir DIR] saves masked screenshots; --headed launches a visible browser; --allow-dirty runs on a dirty tree.',
    '--cleanup REPORT resumes an incomplete cleanup of a report in the state directory; the user target needs',
    '  --credentials and the same --linkding / --karakeep again. It deletes no Karakeep list: one still present is',
    '  reported as residue for a person to check and remove.',
  ].join('\n'));
}

export async function main(argv = process.argv.slice(2), { dockerExec, modules, pinboard } = {}) {
  const opts = parseArgs(argv);
  opts.dockerExec = dockerExec;
  // In-process only (the preflight's Pinboard mock); never from the CLI.
  opts.pinboard = pinboard;
  opts.modules = modules;
  if (opts.mode === 'help') { printHelp(); return 0; }
  if (opts.mode === 'usage') { printHelp(); return 2; }
  if (opts.mode === 'list') { for (const id of listIds(modules || MODULES)) console.log(id); return 0; }
  if (opts.mode === 'plan') {
    try {
      check(!opts.errors.length, opts.errors[0] || 'arguments');
      const target = opts.values.target || 'temp';
      check(['temp', 'user'].includes(target), 'target');
      const services = opts.values.service ? opts.values.service.split(',').map(s => s.trim()) : [...DEFAULT_SERVICES];
      check(services.every(s => SERVICE_TYPES.includes(s)), 'service');
      const scenario = opts.flags.has('--read-only') ? 'readonly' : (opts.values.scenario || 'core');
      const { selected, skipped } = selectModules(scenario, { services, target, modules: modules || MODULES });
      check(selected.length, 'no_modules_selected');
      const plan = buildPlan({ target, selected, skipped, shotsEnabled: opts.flags.has('--shots') || !!opts.values['shots-dir'], headedFlag: opts.flags.has('--headed') });
      plan.scenario = scenario;
      plan.services = services;
      if (target === 'user') plan.bases = Object.fromEntries(services.filter(s => opts.values[s]).map(s => [s, validateBase(opts.values[s])]));
      // Rounds left under the named authorisation: a local count, no credential.
      plan.authorization = target === 'user' ? authorizationStatus(stateDir(), opts.values.authorization || '', BUDGETS.user.run.roundsPerAuthorization) : { required: false };
      await new Promise(r => process.stdout.write(JSON.stringify(plan, null, 2) + '\n', r));
      return plan.withinCaps && plan.authorization.left !== 0 ? 0 : 1;
    } catch (error) {
      await new Promise(r => process.stdout.write(JSON.stringify({ error: failureCode(error) }) + '\n', r));
      return 1;
    }
  }
  if (opts.mode === 'cleanup') return resumeCleanup(opts);
  return new LiveRun(opts).execute();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, error => { console.error('FAILED: ' + failureCode(error)); process.exitCode = 1; });
}
