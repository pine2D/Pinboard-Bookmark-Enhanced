// End-to-end upgrade-path test: installs the latest store-approved git tag
// into an isolated Chromium profile, seeds real user data via the old tag's own
// writers, upgrades the unpacked extension to the current working tree, and
// asserts onInstalled("update"), migrations, lossless reader & IndexedDB parity,
// zero-error UI rendering across options/library/popup, zero outgoing network
// requests, and one deliberate-break honesty failure.
//
// Chromium MV3 unpacked-upgrade behavior observed empirically (2026-11-13):
// 1. Playwright `headless: true` runs `chromium_headless_shell`, which lacks
//    Chrome's ExtensionService upgrade/reload machinery; `headless: false`
//    under `xvfb-run -a` (matching scripts/zip-install-smoke.mjs) is required.
// 2. On cold close + file swap + relaunch with `--load-extension`, full
//    Chromium updates `chrome.runtime.getManifest().version`, yet keeps serving
//    the previous Service Worker `ScriptCache` and does NOT fire
//    `chrome.runtime.onInstalled({ reason: "update" })`.
// 3. Swapping files on disk and triggering Developer Mode Reload
//    (`#dev-reload-button` on `chrome://extensions`) replaces the cached SW with
//    the new `background.js` and fires real `onInstalled({ reason: "update" })`
//    while preserving `chrome.storage` and IndexedDB in the profile.

// Clear inherited hook/repo GIT_* vars before importing or spawning git.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) delete process.env[key];
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestApprovedStoreVersion } from '../scripts/registers-lint.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const args = process.argv.slice(2);
const PRINT_TAG = args.includes('--print-tag');
const KEEP_TMP = args.includes('--keep-tmp');

const LEDGER_PATH = process.env.PBP_UPGRADE_LEDGER_PATH || join(ROOT, '.claude/store-ledger.md');
let ledgerText;
try {
  ledgerText = readFileSync(LEDGER_PATH, 'utf8');
} catch (err) {
  console.error(`[upgrade-path] Store ledger unreadable at ${LEDGER_PATH}: ${err.message}`);
  process.exit(1);
}
const OLD_VERSION = latestApprovedStoreVersion(ledgerText);
if (!OLD_VERSION) {
  console.error('[upgrade-path] Store ledger has no approved ("通过") version row');
  process.exit(1);
}
const OLD_TAG = `v${OLD_VERSION}`;

if (PRINT_TAG) {
  console.log(OLD_TAG);
  process.exit(0);
}

try {
  execFileSync('git', ['-C', ROOT, 'rev-parse', '--verify', `refs/tags/${OLD_TAG}^{commit}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
} catch {
  console.error(`[upgrade-path] Store ledger names ${OLD_TAG} as the latest approved version, but git tag ${OLD_TAG} is missing locally; fetch it with: git fetch --depth 1 origin tag ${OLD_TAG}`);
  process.exit(1);
}

const { chromium } = createRequire(resolve(ROOT, '.qa-scan/package.json'))('playwright');
const BROWSER_EXECUTABLE = (process.env.PBP_BROWSER_EXECUTABLE || '').trim();
const REPORT_BASE = process.env.PBP_QA_REPORT_DIR || join(homedir(), '.local/share/pbp-qa-report');
const EVIDENCE_DIR = join(REPORT_BASE, 'upgrade-path');
mkdirSync(EVIDENCE_DIR, { recursive: true });

// Parse file-selection rules directly from scripts/release.sh so upgrade staging
// mirrors the release ZIP file set without duplicating the lists.
function parsePythonStringList(src, varName) {
  const m = src.match(new RegExp(`^${varName}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'));
  assert.ok(m, `[upgrade-path] Could not parse ${varName} from scripts/release.sh`);
  const items = [];
  for (const part of m[1].matchAll(/['"]([^'"]*)['"]/g)) items.push(part[1]);
  assert.ok(items.length > 0, `[upgrade-path] Parsed empty ${varName} from scripts/release.sh`);
  return items;
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function loadReleaseSelectionRules() {
  const releaseSrc = readFileSync(join(ROOT, 'scripts/release.sh'), 'utf8');
  return {
    topLevelAllow: parsePythonStringList(releaseSrc, 'TOP_LEVEL_PATTERNS').map(globToRegExp),
    includeDirs: parsePythonStringList(releaseSrc, 'INCLUDE_DIRS'),
    excludeTopLevel: parsePythonStringList(releaseSrc, 'EXCLUDE_PATTERNS').map(globToRegExp),
  };
}

const RELEASE_RULES = loadReleaseSelectionRules();

function shouldKeepTopLevel(name) {
  if (RELEASE_RULES.excludeTopLevel.some((re) => re.test(name))) return false;
  return RELEASE_RULES.topLevelAllow.some((re) => re.test(name));
}

function copyReleaseFiles(srcDir, dstDir) {
  rmSync(dstDir, { recursive: true, force: true });
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      if (!RELEASE_RULES.includeDirs.includes(name)) continue;
      cpSync(src, join(dstDir, name), {
        recursive: true,
        filter: (p) => !relative(srcDir, p).split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..'),
      });
    } else if (st.isFile() && shouldKeepTopLevel(name)) {
      cpSync(src, join(dstDir, name));
    }
  }
}

function compareDottedVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function extractOldReleaseStage(tag, stageDir) {
  mkdirSync(stageDir, { recursive: true });
  const tarBuf = execFileSync('git', ['-C', ROOT, 'archive', '--format=tar', tag], {
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync('tar', ['-xf', '-', '-C', stageDir], { input: tarBuf });
}

function materializeNewReleaseTree(extDir, oldVersion, mutateNewTree) {
  copyReleaseFiles(ROOT, extDir);
  const manifestPath = join(extDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let syntheticBump = false;
  if (compareDottedVersions(manifest.version, oldVersion) <= 0) {
    manifest.version = `${oldVersion}.1`;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    syntheticBump = true;
  }
  if (typeof mutateNewTree === 'function') mutateNewTree(extDir);
  return { version: manifest.version, syntheticBump };
}

async function launchExtension(profileDir, extDir, tag) {
  const externalRequests = [];
  const context = await chromium.launchPersistentContext(profileDir, {
    ...(BROWSER_EXECUTABLE ? { executablePath: BROWSER_EXECUTABLE } : {}),
    headless: false, // MV3 unpacked extensions & reload require full Chromium
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
  try {
    context.on('request', (req) => {
      if (/^https?:/i.test(req.url())) {
        externalRequests.push({ tag, method: req.method(), url: req.url() });
      }
    });
    await context.route(/^https?:/, (route) => route.abort());
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).hostname;
    return { context, sw, extId, base: `chrome-extension://${extId}`, externalRequests };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

function attachErrorCollectors(page, bucket) {
  page.on('pageerror', (err) => bucket.push(`pageerror(${page.url()}): ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      bucket.push(`console.error(${page.url()}): ${msg.text()}`);
    }
  });
}

async function readAllIdbCounts(page) {
  return page.evaluate(async () => {
    const targets = {
      'pbp-vocab': ['words', 'sync'],
      'pbp-dict-archive': ['records', 'sync'],
      'pbp-ask-archive': ['records', 'sync'],
      'pbp-restore-points': ['meta', 'points'],
    };
    const existing = indexedDB.databases ? new Set((await indexedDB.databases()).map((d) => d.name)) : null;
    const counts = {};
    for (const [dbName, stores] of Object.entries(targets)) {
      if (existing && !existing.has(dbName)) {
        counts[dbName] = null;
        continue;
      }
      counts[dbName] = await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onerror = () => reject(req.error || new Error(`open ${dbName} failed`));
        req.onsuccess = () => {
          const db = req.result;
          const out = { version: db.version, stores: {} };
          const present = stores.filter((s) => db.objectStoreNames.contains(s));
          if (!present.length) {
            db.close();
            resolve(out);
            return;
          }
          const tx = db.transaction(present, 'readonly');
          for (const storeName of present) {
            const cReq = tx.objectStore(storeName).count();
            cReq.onsuccess = () => { out.stores[storeName] = cReq.result; };
          }
          tx.oncomplete = () => { db.close(); resolve(out); };
          tx.onerror = () => { db.close(); reject(tx.error || new Error(`tx ${dbName} failed`)); };
          tx.onabort = () => { db.close(); reject(tx.error || new Error(`tx ${dbName} aborted`)); };
        };
      });
    }
    return counts;
  });
}

function normalizeVocab(rows) {
  return [...rows]
    .sort((a, b) => a.term.localeCompare(b.term))
    .map((w) => ({
      id: w.id,
      term: w.term,
      language: w.language,
      gloss: w.gloss,
      lemma: w.lemma || '',
      note: w.note || '',
      groups: [...(w.groups || [])].sort(),
      status: w.status || 'new',
      contexts: (w.contexts || []).map((c) => ({ quote: c.quote, articleUrl: c.articleUrl, articleTitle: c.articleTitle })),
    }));
}

function normalizeHighlights(recordsByKey) {
  return Object.fromEntries(
    Object.entries(recordsByKey)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, rec]) => [
        k,
        {
          url: rec?.url || '',
          title: rec?.title || '',
          items: [...(rec?.items || [])]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((it) => ({ id: it.id, quote: it.quote, note: it.note, color: it.color, owner: it.owner })),
        },
      ]),
  );
}

function normalizeDict(entry) {
  if (!entry) return null;
  return {
    archiveId: entry.archiveId,
    term: entry.term,
    sourceLanguage: entry.sourceLanguage,
    supplements: [...(entry.supplements || [])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => ({ id: s.id, category: s.category, content: s.content })),
  };
}

function normalizeAsk(sessions) {
  return [...sessions]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({
      id: s.id,
      url: s.url,
      title: s.title,
      records: [...(s.records || [])]
        .sort((a, b) => a.ts - b.ts)
        .map((r) => ({ id: r.id, q: r.q, a: r.a, replacesId: r.replacesId || '', model: r.model })),
    }));
}

function assertCategoryEqual(label, category, actual, expected) {
  assert.deepEqual(actual, expected, `[${label}] ${category} mismatch`);
}

async function seedOldVersion({ sw, base, context }) {
  const pageErrors = [];
  const seededSw = await sw.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      if (typeof persistSettings === 'function' && typeof pbpPersonalLibraryAccount === 'function' &&
          typeof enqueueOfflineSave === 'function') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    // Enable Chrome Sync routing first, then persist non-default values so general
    // settings land in chrome.storage.sync and credentials/device keys in local.
    const enableSync = await persistSettings({ optSyncEnabled: true, syncApiKeys: false });
    if (!enableSync?.ok) throw new Error('persistSettings(optSyncEnabled) failed on old version');
    const saved = await persistSettings({
      pinboardToken: obfuscateKey('tester:upgrade-fixture-token'),
      openaiApiKey: obfuscateKey('sk-tester-fixture-000'),
      optLang: 'zh_CN',
      optPrivateDefault: true,
      optReadlaterDefault: true,
      previewAiEnabled: false,
      previewSkimEnabled: true,
      aiProvider: 'openai',
      tagSyncMode: 'fresh',
      optSyncEnabled: true,
      syncApiKeys: false,
      bookmarkService: 'pinboard',
      bookmarkServiceActive: 'pinboard',
    });
    if (!saved?.ok) throw new Error('persistSettings failed on old version');

    const syncCheck = await chrome.storage.sync.get(['optLang', 'optPrivateDefault', 'optReadlaterDefault', 'previewAiEnabled', 'previewSkimEnabled', 'aiProvider', 'tagSyncMode', 'personalLibraryAccount']);
    const localCheck = await chrome.storage.local.get(['pinboardToken', 'openaiApiKey', 'optSyncEnabled', 'syncApiKeys', 'bookmarkServiceActive']);
    if (syncCheck.optLang !== 'zh_CN' || syncCheck.optPrivateDefault !== true) {
      throw new Error(`Expected non-default sync settings in chrome.storage.sync, got: ${JSON.stringify(syncCheck)}`);
    }
    if (!localCheck.pinboardToken || !localCheck.openaiApiKey || localCheck.bookmarkServiceActive !== 'pinboard') {
      throw new Error(`Expected secrets and device key in chrome.storage.local, got: ${JSON.stringify(localCheck)}`);
    }

    const account = await pbpPersonalLibraryAccount();
    const owner = await pbpVocabCurrentOwner();
    const qOk = await enqueueOfflineSave({
      url: 'https://example.com/offline-queued',
      description: 'Queued before upgrade',
      extended: 'Offline note preserved across update',
      tags: 'upgrade queued',
      shared: 'no',
      toread: 'yes',
    });
    if (!qOk) throw new Error('enqueueOfflineSave returned false on old version');
    const settings = await pbpReadSettingsWithSecrets({
      pinboardToken: '', openaiApiKey: '', personalLibraryAccount: '',
      optLang: '', optPrivateDefault: false, optReadlaterDefault: false,
      previewAiEnabled: true, previewSkimEnabled: false, aiProvider: '', tagSyncMode: '',
      optSyncEnabled: false, syncApiKeys: false, bookmarkService: '', bookmarkServiceActive: '',
    });
    const offlineQueue = await readOfflineQueueWithIds();
    return {
      manifestVersion: chrome.runtime.getManifest().version,
      account,
      owner,
      settings,
      syncCheck,
      localKeysPresent: {
        hasPinboardToken: !!localCheck.pinboardToken,
        hasOpenaiApiKey: !!localCheck.openaiApiKey,
        bookmarkServiceActive: localCheck.bookmarkServiceActive,
        optSyncEnabled: localCheck.optSyncEnabled,
      },
      offlineQueue: offlineQueue.map((q) => ({ url: q.url, description: q.description, extended: q.extended, tags: q.tags })),
    };
  });

  const libPage = await context.newPage();
  attachErrorCollectors(libPage, pageErrors);
  await libPage.goto(`${base}/library.html`, { waitUntil: 'domcontentloaded' });
  await libPage.waitForFunction(() =>
    typeof pbpVocabSaveWord === 'function' &&
    typeof pbpNotesWriteRecord === 'function' &&
    typeof pbpDictArchiveSave === 'function' &&
    typeof pbpAskArchiveAppend === 'function',
  );

  const seedResult = await libPage.evaluate(async ({ owner }) => {
    const w1 = await pbpVocabSaveWord(owner, {
      term: 'ephemeral',
      language: 'en',
      gloss: 'lasting for a very short time',
      ipa: '/ɪˈfɛmərəl/',
      context: { articleUrl: 'https://example.com/article-1', articleTitle: 'Article One', quote: 'Ephemeral notes vanish quickly.' },
    });
    if (!w1?.id) throw new Error('pbpVocabSaveWord(ephemeral) failed');
    await pbpVocabSetLemma(w1.id, owner, 'ephemera');
    await pbpVocabSetNote(w1.id, owner, 'Root epi + hemera');
    await pbpVocabBatchAddGroup([w1.id], owner, 'GRE');

    const w2 = await pbpVocabSaveWord(owner, {
      term: 'resilient',
      language: 'en',
      gloss: 'able to withstand recovery',
      context: { articleUrl: 'https://example.com/article-2', articleTitle: 'Article Two', quote: 'Resilient storage retains rows.' },
    });
    if (!w2?.id) throw new Error('pbpVocabSaveWord(resilient) failed');
    await pbpVocabBatchSetStatus([w2.id], owner, 'known');

    const w3 = await pbpVocabSaveWord(owner, {
      term: 'lucid',
      language: 'en',
      gloss: 'expressed clearly and easy to understand',
      context: { articleUrl: 'https://example.com/article-1', articleTitle: 'Article One', quote: 'Lucid prose helps readers.' },
    });
    if (!w3?.id) throw new Error('pbpVocabSaveWord(lucid) failed');

    // Two distinct articles with highlights & notes.
    const articles = [
      {
        url: 'https://example.com/upgrade-notes-1',
        title: 'Upgrade Notes Article One',
        items: [
          { id: 'hl-1', n: 0, quote: 'First article highlight one', prefix: '', suffix: '', note: 'Note one preserved', color: 1, ts: 1700000001000, owner, fp: 'fp-up-1' },
          { id: 'hl-2', n: 1, quote: 'First article highlight two', prefix: '', suffix: '', note: 'Note two preserved', color: 3, ts: 1700000002000, owner, fp: 'fp-up-2' },
        ],
      },
      {
        url: 'https://example.com/upgrade-notes-2',
        title: 'Upgrade Notes Article Two',
        items: [
          { id: 'hl-3', n: 0, quote: 'Second article highlight one', prefix: '', suffix: '', note: 'Note three preserved', color: 2, ts: 1700000003000, owner, fp: 'fp-up-3' },
        ],
      },
    ];
    const hlKeys = [];
    for (const art of articles) {
      const key = pbpNotesArticleKey(art.url);
      hlKeys.push(key);
      const res = await pbpNotesWriteRecord(key, {
        v: 1, url: art.url, title: art.title, items: art.items,
      }, owner, { getCurrentOwner: async () => owner });
      if (!res?.items?.length) throw new Error(`pbpNotesWriteRecord failed for ${art.url}`);
    }

    const dictEntry = await pbpDictArchiveSave({
      owner,
      term: 'ephemeral',
      sourceLanguage: 'en',
      target: { name: 'Chinese', lang: 'zh-CN' },
      record: {
        provider: 'peer-provider',
        model: 'peer-model',
        generatedAt: 301,
        entry: {
          word: 'ephemeral',
          language: 'en',
          pronunciation: '/ɪˈfɛmərəl/',
          meanings: [{
            partOfSpeech: 'adjective',
            definition: 'lasting for a very short time',
            examples: [{ text: 'Ephemeral blossoms fade fast.', translation: '转瞬即逝的花很快凋谢。' }],
          }],
          etymology: 'Greek ephemeros.',
          relatedWords: ['ephemera'],
        },
      },
    });
    if (!dictEntry?.archiveId) throw new Error('pbpDictArchiveSave failed');

    const dictSupp = await pbpDictArchiveAppend({
      owner,
      archiveId: dictEntry.archiveId,
      category: 'etymology',
      profile: { nativeLanguage: 'Chinese', level: 'intermediate', topic: '' },
      provider: 'peer-provider',
      model: 'peer-model',
      generatedAt: 302,
      content: 'From Greek epi + hemera (day).',
      sources: [],
    });
    if (!dictSupp?.archiveSaved) throw new Error('pbpDictArchiveAppend failed');

    const askSessionId = 'upgrade-ask-session-1';
    const askUrl = 'https://example.com/ask-upgrade-article';
    const r1 = await pbpAskArchiveAppend({
      owner,
      sessionId: askSessionId,
      url: askUrl,
      title: 'Ask Upgrade Article',
      record: {
        q: 'What is the main point?',
        a: 'Data survives updates [P1].',
        cites: [{ p: 1, quote: 'Data survives updates.' }],
        ts: 1700000010000,
        model: 'fixture-model',
        blocksHash: '',
        evidence: [{ p: 1, quote: 'Data survives updates.', state: 'matched', sourceUrl: askUrl }],
      },
    });
    const r2 = await pbpAskArchiveAppend({
      owner,
      sessionId: askSessionId,
      url: askUrl,
      title: 'Ask Upgrade Article',
      replacesId: r1.id,
      record: {
        q: 'What is the main point?',
        a: 'User data survives extension updates losslessly [P1].',
        cites: [{ p: 1, quote: 'Data survives updates.' }],
        ts: 1700000011000,
        model: 'fixture-model',
        blocksHash: '',
        evidence: [{ p: 1, quote: 'Data survives updates.', state: 'matched', sourceUrl: askUrl }],
      },
    });
    if (!r1?.id || !r2?.id) throw new Error('pbpAskArchiveAppend failed');

    const vocabRaw = await pbpVocabAll(owner);
    const hlRaw = await chrome.storage.local.get(hlKeys);
    const dictRead = await pbpDictArchiveRead({
      owner,
      term: 'ephemeral',
      sourceLanguage: 'en',
      target: { name: 'Chinese', lang: 'zh-CN' },
    });
    const askSessions = await pbpAskArchiveRead({ owner });
    return { hlKeys, hlRaw, vocabRaw, dictRead, askSessions };
  }, { owner: seededSw.owner });

  const idbCounts = await readAllIdbCounts(libPage);
  await libPage.close();

  return {
    ...seededSw,
    hlKeys: seedResult.hlKeys,
    highlights: normalizeHighlights(seedResult.hlRaw),
    vocab: normalizeVocab(seedResult.vocabRaw),
    dictArchive: normalizeDict(seedResult.dictRead),
    askArchive: normalizeAsk(seedResult.askSessions),
    idbCounts,
    seedPageErrors: pageErrors,
  };
}

// Reopens a closed seeded profile running the old tag, clears the three live
// one-shot migration flags so the new worker runs them cleanly, replaces the
// extension folder with the new working tree, and clicks Developer Mode Reload
// (`#dev-reload-button`) on `chrome://extensions` so Chromium flushes the SW
// ScriptCache and fires `chrome.runtime.onInstalled({ reason: "update" })`.
async function runUpgradeRound(profileDir, oldStageDir, workExtDir, oldVersion, mutateNewTree) {
  copyReleaseFiles(oldStageDir, workExtDir);
  const launch = await launchExtension(profileDir, workExtDir, mutateNewTree ? 'honesty' : 'upgraded');
  try {
    await launch.sw.evaluate(async () => {
      await chrome.storage.local.remove([
        '_webhookSyncScrubDone',
        '_hlOwnerClaimDone',
        '_driveScopeKeysRetiredDone',
      ]);
    });
    const newMeta = materializeNewReleaseTree(workExtDir, oldVersion, mutateNewTree);
    const extPage = await launch.context.newPage();
    await extPage.goto('chrome://extensions');
    const nextSwPromise = launch.context.waitForEvent('serviceworker', { timeout: 15000 });
    await extPage.evaluate(async () => {
      const mgr = document.querySelector('extensions-manager');
      const toggle = mgr?.shadowRoot?.querySelector('extensions-toolbar')?.shadowRoot?.querySelector('#devMode');
      if (toggle && !toggle.checked) toggle.click();
      for (let i = 0; i < 40; i++) {
        const btn = mgr?.shadowRoot?.querySelector('extensions-item-list')?.shadowRoot
          ?.querySelector('extensions-item')?.shadowRoot?.querySelector('#dev-reload-button');
        if (btn) {
          btn.click();
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('Developer mode #dev-reload-button not found on chrome://extensions');
    });
    const newSw = await nextSwPromise;
    await extPage.close();
    return { ...launch, sw: newSw, newMeta };
  } catch (err) {
    await launch.context.close().catch(() => {});
    throw err;
  }
}

async function verifyPostUpgrade(launch, snapshot, { label }) {
  const { context, sw, base, externalRequests } = launch;
  const errors = [];

  let swState = null;
  for (let i = 0; i < 60; i++) {
    swState = await sw.evaluate(async ({ account }) => {
      const flags = await chrome.storage.local.get([
        '_webhookSyncScrubDone',
        '_hlOwnerClaimDone',
        '_driveScopeKeysRetiredDone',
      ]);
      const points = typeof pbpRestorePointList === 'function' ? await pbpRestorePointList(account) : [];
      return {
        manifestVersion: chrome.runtime.getManifest().version,
        hasRestorePointApi: typeof pbpRestorePointList === 'function',
        flags,
        points,
      };
    }, { account: snapshot.account });
    const allFlags = swState.flags._webhookSyncScrubDone === true &&
      swState.flags._hlOwnerClaimDone === true &&
      swState.flags._driveScopeKeysRetiredDone === true;
    const hasUpdatePoint = swState.points.some((p) => p.reason === 'update');
    if (swState.hasRestorePointApi && allFlags && hasUpdatePoint) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.equal(swState.hasRestorePointApi, true, `[${label}] new SW code (pbpRestorePointList) did not load`);
  assert.notEqual(
    swState.manifestVersion,
    snapshot.manifestVersion,
    `[${label}] upgraded manifest.version did not advance from ${snapshot.manifestVersion}`,
  );
  assert.equal(swState.flags._webhookSyncScrubDone, true, `[${label}] _webhookSyncScrubDone not set`);
  assert.equal(swState.flags._hlOwnerClaimDone, true, `[${label}] _hlOwnerClaimDone not set`);
  assert.equal(swState.flags._driveScopeKeysRetiredDone, true, `[${label}] _driveScopeKeysRetiredDone not set`);

  const updatePoint = swState.points.find((p) => p.reason === 'update');
  assert.ok(
    updatePoint,
    `[${label}] onInstalled({ reason: "update" }) restore point missing; points=${JSON.stringify(swState.points)}`,
  );

  const afterSw = await sw.evaluate(async ({ account, pointId }) => {
    const settings = await pbpReadSettingsWithSecrets({
      pinboardToken: '', openaiApiKey: '', personalLibraryAccount: '',
      optLang: '', optPrivateDefault: false, optReadlaterDefault: false,
      previewAiEnabled: true, previewSkimEnabled: false, aiProvider: '', tagSyncMode: '',
      optSyncEnabled: false, syncApiKeys: false, bookmarkService: '', bookmarkServiceActive: '',
    });
    const syncCheck = await chrome.storage.sync.get(['optLang', 'optPrivateDefault', 'optReadlaterDefault', 'previewAiEnabled', 'previewSkimEnabled', 'aiProvider', 'tagSyncMode', 'personalLibraryAccount']);
    const localCheck = await chrome.storage.local.get(['pinboardToken', 'openaiApiKey', 'optSyncEnabled', 'syncApiKeys', 'bookmarkServiceActive']);
    const offlineQueue = await readOfflineQueueWithIds();
    const owner = await pbpVocabCurrentOwner();
    const pointPayload = await pbpRestorePointRead(pointId, account);
    return {
      settings,
      syncCheck,
      localKeysPresent: {
        hasPinboardToken: !!localCheck.pinboardToken,
        hasOpenaiApiKey: !!localCheck.openaiApiKey,
        bookmarkServiceActive: localCheck.bookmarkServiceActive,
        optSyncEnabled: localCheck.optSyncEnabled,
      },
      offlineQueue: offlineQueue.map((q) => ({ url: q.url, description: q.description, extended: q.extended, tags: q.tags })),
      owner,
      pointPayload,
    };
  }, { account: snapshot.account, pointId: updatePoint.id });

  assertCategoryEqual(label, 'owner', afterSw.owner, snapshot.owner);
  assertCategoryEqual(label, 'settings', afterSw.settings, snapshot.settings);
  assertCategoryEqual(label, 'sync-settings', afterSw.syncCheck, snapshot.syncCheck);
  assertCategoryEqual(label, 'local-settings', afterSw.localKeysPresent, snapshot.localKeysPresent);
  assertCategoryEqual(label, 'offline-queue', afterSw.offlineQueue, snapshot.offlineQueue);
  assert.equal(afterSw.pointPayload?._vocabulary?.records?.length, snapshot.vocab.length, `[${label}] update restore point missing vocabulary`);
  for (const key of snapshot.hlKeys) {
    assert.equal(
      afterSw.pointPayload?._highlights?.[key]?.items?.length,
      snapshot.highlights[key].items.length,
      `[${label}] update restore point missing highlights for ${key}`,
    );
  }

  // Open options.html, library.html (all 3 tabs), and popup.html on the upgraded extension.
  const optsPage = await context.newPage();
  attachErrorCollectors(optsPage, errors);
  await optsPage.goto(`${base}/options.html`, { waitUntil: 'domcontentloaded' });
  await optsPage.waitForFunction(() => document.getElementById('opt-lang')?.value === 'zh_CN', { timeout: 10000 });
  await optsPage.close();

  const libPage = await context.newPage();
  attachErrorCollectors(libPage, errors);
  await libPage.goto(`${base}/library.html#vocab`, { waitUntil: 'domcontentloaded' });
  await libPage.waitForFunction(() =>
    typeof pbpVocabAll === 'function' &&
    typeof pbpDictArchiveRead === 'function' &&
    typeof pbpAskArchiveRead === 'function',
  );

  // Verify lossless reader parity + IDB counts on the upgraded runtime.
  const libState = await libPage.evaluate(async ({ owner, hlKeys }) => {
    const vocabRaw = await pbpVocabAll(owner);
    const hlRaw = await chrome.storage.local.get(hlKeys);
    const dictRead = await pbpDictArchiveRead({
      owner,
      term: 'ephemeral',
      sourceLanguage: 'en',
      target: { name: 'Chinese', lang: 'zh-CN' },
    });
    const askSessions = await pbpAskArchiveRead({ owner });
    return { vocabRaw, hlRaw, dictRead, askSessions };
  }, { owner: snapshot.owner, hlKeys: snapshot.hlKeys });

  const actualVocab = normalizeVocab(libState.vocabRaw);
  assert.equal(actualVocab.length, snapshot.vocab.length, `[${label}] vocab count changed (expected ${snapshot.vocab.length}, got ${actualVocab.length})`);
  assertCategoryEqual(label, 'vocabulary', actualVocab, snapshot.vocab);
  assertCategoryEqual(label, 'highlights', normalizeHighlights(libState.hlRaw), snapshot.highlights);
  assertCategoryEqual(label, 'dict-archive', normalizeDict(libState.dictRead), snapshot.dictArchive);
  assertCategoryEqual(label, 'ask-archive', normalizeAsk(libState.askSessions), snapshot.askArchive);

  const idbAfter = await readAllIdbCounts(libPage);
  for (const [dbName, stores] of [
    ['pbp-vocab', ['words', 'sync']],
    ['pbp-dict-archive', ['records', 'sync']],
    ['pbp-ask-archive', ['records', 'sync']],
  ]) {
    assert.ok(idbAfter[dbName], `[${label}] IndexedDB ${dbName} missing after upgrade`);
    for (const store of stores) {
      const prev = snapshot.idbCounts[dbName]?.stores?.[store] ?? 0;
      const curr = idbAfter[dbName]?.stores?.[store] ?? -1;
      assert.ok(curr >= prev, `[${label}] IDB ${dbName}.${store} shrank (${curr} < ${prev})`);
    }
  }
  assert.equal(idbAfter['pbp-vocab'].stores.words, snapshot.idbCounts['pbp-vocab'].stores.words, `[${label}] IDB pbp-vocab.words mismatch`);
  assert.equal(idbAfter['pbp-dict-archive'].stores.records, snapshot.idbCounts['pbp-dict-archive'].stores.records, `[${label}] IDB pbp-dict-archive.records mismatch`);
  assert.equal(idbAfter['pbp-ask-archive'].stores.records, snapshot.idbCounts['pbp-ask-archive'].stores.records, `[${label}] IDB pbp-ask-archive.records mismatch`);
  assert.ok((idbAfter['pbp-restore-points']?.stores?.meta ?? 0) >= 1, `[${label}] pbp-restore-points.meta empty`);
  assert.ok((idbAfter['pbp-restore-points']?.stores?.points ?? 0) >= 1, `[${label}] pbp-restore-points.points empty`);

  // Library UI tabs smoke + rendered DOM item counts: Vocabulary -> Notes -> Ask.
  await libPage.waitForFunction((want) => {
    return document.querySelectorAll('#vocab-list > .vocab-card').length === want;
  }, snapshot.vocab.length, { timeout: 10000 });
  const vocabDomCount = await libPage.locator('#vocab-list > .vocab-card').count();
  assert.equal(vocabDomCount, snapshot.vocab.length, `[${label}] #vocab-list DOM row count mismatch`);

  await libPage.click('#lib-tab-notes');
  const expectedHlCount = Object.values(snapshot.highlights).reduce((n, r) => n + r.items.length, 0);
  await libPage.waitForFunction((want) => {
    const view = document.getElementById('view-notes');
    return view && !view.hidden && document.querySelectorAll('#notes-list .notes-hit').length === want;
  }, expectedHlCount, { timeout: 10000 });
  const notesDomCount = await libPage.locator('#notes-list .notes-hit').count();
  assert.equal(notesDomCount, expectedHlCount, `[${label}] #notes-list DOM row count mismatch`);

  await libPage.click('#lib-tab-ask');
  await libPage.waitForFunction((want) => {
    const view = document.getElementById('view-ask');
    return view && !view.hidden && document.querySelectorAll('#ask-library-list .ask-library-hit').length === want;
  }, snapshot.askArchive.length, { timeout: 10000 });
  const askDomCount = await libPage.locator('#ask-library-list .ask-library-hit').count();
  assert.equal(askDomCount, snapshot.askArchive.length, `[${label}] #ask-library-list DOM row count mismatch`);
  await libPage.close();

  const popupPage = await context.newPage();
  attachErrorCollectors(popupPage, errors);
  await popupPage.goto(`${base}/popup.html`, { waitUntil: 'domcontentloaded' });
  await popupPage.waitForFunction(() => !!document.getElementById('saveBtn') || !!document.body.firstElementChild, { timeout: 10000 });
  await popupPage.close();

  assert.deepEqual(errors, [], `[${label}] runtime page/console errors detected`);
  assert.deepEqual(externalRequests, [], `[${label}] unexpected outgoing network requests`);
  return { swState, idbAfter, domCounts: { vocabDomCount, notesDomCount, askDomCount } };
}

const started = Date.now();
const tmpRoot = mkdtempSync(join(tmpdir(), 'pbp-upgrade-'));
const oldStageDir = join(tmpRoot, 'old-stage');
const extDir = join(tmpRoot, 'ext');
const brokenExtDir = join(tmpRoot, 'ext-broken');
const profileDir = join(tmpRoot, 'profile');
const brokenProfileDir = join(tmpRoot, 'profile-broken');
mkdirSync(profileDir, { recursive: true });

let activeContext = null;
const report = { oldTag: OLD_TAG, steps: [] };

try {
  // Step A: Install old approved store tag and seed using only its own writers.
  extractOldReleaseStage(OLD_TAG, oldStageDir);
  copyReleaseFiles(oldStageDir, extDir);
  const oldLaunch = await launchExtension(profileDir, extDir, 'old');
  activeContext = oldLaunch.context;
  const snapshot = await seedOldVersion(oldLaunch);
  assert.deepEqual(snapshot.seedPageErrors, [], `errors while seeding ${OLD_TAG}`);
  assert.deepEqual(oldLaunch.externalRequests, [], `outgoing requests while seeding ${OLD_TAG}`);
  report.steps.push({
    step: 'seed-old',
    version: snapshot.manifestVersion,
    vocabCount: snapshot.vocab.length,
    highlightArticles: snapshot.hlKeys.length,
    highlightsCount: Object.values(snapshot.highlights).reduce((n, r) => n + r.items.length, 0),
    dictRecords: snapshot.idbCounts['pbp-dict-archive']?.stores?.records,
    askRecords: snapshot.idbCounts['pbp-ask-archive']?.stores?.records,
    offlineQueue: snapshot.offlineQueue.length,
  });
  await oldLaunch.context.close();
  activeContext = null;

  // Clone the clean closed v3.0.3 profile before the real upgrade touches it so
  // the honesty check exercises the exact same pre-upgrade storage/IDB state.
  cpSync(profileDir, brokenProfileDir, { recursive: true });

  // Step B & C: Upgrade via disk swap + chrome://extensions reload, then verify.
  const upgradedLaunch = await runUpgradeRound(profileDir, oldStageDir, extDir, OLD_VERSION);
  activeContext = upgradedLaunch.context;
  const verified = await verifyPostUpgrade(upgradedLaunch, snapshot, { label: 'upgraded' });
  report.steps.push({
    step: 'upgrade-verified',
    newVersion: upgradedLaunch.newMeta.version,
    syntheticBump: upgradedLaunch.newMeta.syntheticBump,
    restorePointReason: verified.swState.points.find((p) => p.reason === 'update')?.reason,
    flags: verified.swState.flags,
    domCounts: verified.domCounts,
    idbAfter: verified.idbAfter,
  });
  await upgradedLaunch.context.close();
  activeContext = null;

  // Step D: Honesty check against a deliberately broken temp copy (IDB DB renamed without migration).
  const brokenLaunch = await runUpgradeRound(
    brokenProfileDir,
    oldStageDir,
    brokenExtDir,
    OLD_VERSION,
    (dir) => {
      const vocabStorePath = join(dir, 'vocab-store.js');
      const vocabSrc = readFileSync(vocabStorePath, 'utf8');
      const needle = 'const _PBP_VOCAB_DB_NAME = "pbp-vocab";';
      assert.ok(vocabSrc.includes(needle), 'honesty break target constant not found in vocab-store.js');
      writeFileSync(
        vocabStorePath,
        vocabSrc.replace(needle, 'const _PBP_VOCAB_DB_NAME = "pbp-vocab-broken-upgrade";'),
      );
    },
  );
  activeContext = brokenLaunch.context;
  let caughtError = '';
  try {
    await verifyPostUpgrade(brokenLaunch, snapshot, { label: 'honesty-broken' });
  } catch (err) {
    caughtError = err?.message || String(err);
  }
  await brokenLaunch.context.close();
  activeContext = null;

  assert.ok(
    caughtError && /\[honesty-broken\] update restore point missing vocabulary/.test(caughtError),
    `honesty check did not fail with expected vocab loss message; got: ${caughtError || '(passed unexpectedly)'}`,
  );
  report.steps.push({ step: 'honesty-check', expectedFailure: caughtError });
  const elapsedSec = ((Date.now() - started) / 1000).toFixed(2);
  report.elapsedSec = Number(elapsedSec);
  writeFileSync(join(EVIDENCE_DIR, 'results.json'), JSON.stringify(report, null, 2));

  console.log(
    `[upgrade-path] PASS ${OLD_TAG} -> ${upgradedLaunch.newMeta.version}` +
    `${upgradedLaunch.newMeta.syntheticBump ? ' (manifest bumped from repo ' + OLD_VERSION + ')' : ''}: ` +
    `onInstalled("update") restore point + 3 migrations + lossless reader/IDB parity + ` +
    `options/library(3+3+1 DOM rows)/popup 0 errors + honesty check caught "${caughtError.split('\n')[0]}" ` +
    `(${elapsedSec}s)`,
  );
} catch (err) {
  if (activeContext) {
    try {
      const pages = activeContext.pages();
      for (let i = 0; i < pages.length; i++) {
        await pages[i].screenshot({ path: join(EVIDENCE_DIR, `failure-${i}.png`) }).catch(() => {});
      }
    } catch {}
    await activeContext.close().catch(() => {});
  }
  report.error = err?.stack || err?.message || String(err);
  writeFileSync(join(EVIDENCE_DIR, 'results.json'), JSON.stringify(report, null, 2));
  console.error(`[upgrade-path] FAIL (${((Date.now() - started) / 1000).toFixed(2)}s): ${err?.message || err}`);
  process.exitCode = 1;
} finally {
  if (KEEP_TMP) {
    console.log(`[upgrade-path] kept tmp dir (--keep-tmp): ${tmpRoot}`);
  } else {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
