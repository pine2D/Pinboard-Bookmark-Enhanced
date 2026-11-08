// Real extension UI against an isolated production archive. All network is blocked.
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { installAskHistoryFixture } from '../scripts/audit-ask-history-fixture.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
// Evidence (screenshots, results.json) goes under $PBP_QA_REPORT_DIR, outside the repo and the system temp dir.
const reportBase = process.env.PBP_QA_REPORT_DIR || join(homedir(), '.local/share/pbp-qa-report');
mkdirSync(reportBase, { recursive: true });
const out = process.env.PBP_ASK_LIBRARY_QA_OUT || mkdtempSync(join(reportBase, 'ask-library-evidence-'));
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(root + '/.qa-scan/package.json')('playwright');
const profile = mkdtempSync(join(tmpdir(), 'pbp-ask-library-'));
const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: chromium.executablePath(), args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND'] });
const checks = [], errors = [];
function check(name, ok, detail) { checks.push({ name, ok, detail }); writeFileSync(out + '/results.json', JSON.stringify({ checks, errors }, null, 2)); if (!ok) throw new Error(name + ': ' + JSON.stringify(detail)); }
try {
  await context.route(/^https?:/, route => route.abort());
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const base = 'chrome-extension://' + new URL(sw.url()).hostname;
  await sw.evaluate(() => chrome.storage.local.set({ pinboardToken: 'obf:' + btoa('ask-library-fixture:test-only'), optSyncEnabled: false, optLang: 'zh_TW' }));
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(base + '/library.html#ask');
  await page.waitForFunction(() => typeof pbpAskArchiveAppend === 'function' && typeof _pbpLibAskCurrentOwner === 'function');
  await installAskHistoryFixture(page);
  check('sessions grouped by article', await page.locator('.ask-library-page').count() === 1 && await page.locator('.ask-library-hit').count() === 2);
  await page.locator('.ask-library-hit[data-session="render-session-main"]').click();
  check('latest answers and previous versions remain separate', await page.locator('#ask-library-detail > .ask-library-round').count() === 2 && await page.locator('#ask-library-detail > details .ask-library-round').count() === 1);
  check('raw provider CITES blocks stay archived but do not render as answer prose', await page.evaluate(() => _libAskSessions.some(session => session.records.some(record => /\nCITES[:：]\n/.test(record.a))) && [...document.querySelectorAll('.ask-library-answer')].every(answer => !answer.textContent.includes('CITES'))));
  const summary = page.locator('.ask-library-round .ask-library-evidence > summary').first();
  await summary.click(); await summary.focus(); await page.evaluate(() => pbpLibAskRefresh());
  check('refresh retains expanded evidence and keyboard focus', await page.evaluate(() => document.activeElement?.tagName === 'SUMMARY' && document.activeElement.parentElement.open));
  await page.locator('#ask-library-detail > details > summary').click();
  const exported = await page.evaluate(() => pbpLibAskExport(_libAskSessions.find(row => row.id === 'render-session-main')));
  check('export retains original answer, replacement, and evidence', exported.includes('surrounding words') && exported.includes('definitions explain it directly') && exported.includes('Context helps readers distinguish meanings.'));
  check('Markdown export removes both ASCII and CJK citation protocol tails', !/\nCITES[:：]/.test(exported) && (exported.match(/Context helps readers distinguish meanings\./g) || []).length === 2);
  check('CITES mentioned within prose is preserved while a real final block is parsed', await page.evaluate(() => { const record = { a: 'Explain CITES: as a format.\nCITES：这一行是正文说明\nThe explanation continues.\n\nCITES:\nP8: "source evidence"', cites: [] }; return _pbpLibAskAnswer(record).textContent.includes('这一行是正文说明') && _pbpLibAskAnswer(record).textContent.includes('The explanation continues.') && !_pbpLibAskAnswer(record).textContent.includes('source evidence') && pbpLibAskEvidence(record)[0].quote === 'source evidence'; }));
  await page.locator('#ask-library-search').fill('ｄｅｆｉｎｉｔｉｏｎｓ ｅｘｐｌａｉｎ');
  check('search normalizes width and finds answer text', await page.locator('.ask-library-hit').count() === 1);
  await page.locator('#ask-library-search').fill('no matching answer');
  check('empty search keeps its explicit state', await page.locator('.ask-library-hit').count() === 0 && await page.locator('#ask-library-empty').isVisible());
  await page.locator('#ask-library-search').fill('');
  await page.locator('.ask-library-hit').first().focus(); await page.keyboard.press('Control+Delete');
  check('modified list delete does not open confirmation', await page.locator('.confirm-popover').count() === 0);
  await page.evaluate(() => { const record = { a: '![hidden image](https://tracker.example/a.png)\n\n<script>window.xss=true</script>\n\n[bad](javascript:alert(1))\n\n[good](https://example.test)' }; window.testAnswer = _pbpLibAskAnswer(record); document.getElementById('ask-library-detail').append(testAnswer); });
  check('answers are sanitized without loading remote images', await page.evaluate(() => !testAnswer.querySelector('img, script, iframe, svg, a[href^="javascript:"]') && !window.xss && testAnswer.querySelector('a[href="https://example.test/"]').rel === 'noopener noreferrer'));
  await page.evaluate(() => testAnswer.remove());
  await page.evaluate(() => { window.permissionRequests = []; chrome.permissions.contains = async () => false; chrome.permissions.request = async request => { permissionRequests.push(request); return false; }; });
  await page.locator('.ask-library-actions button').first().click();
  await page.waitForFunction(() => !document.querySelector('.ask-library-actions button').disabled);
  check('declining only the exact source origin preserves history', await page.evaluate(() => permissionRequests.length === 1 && permissionRequests[0].origins[0] === 'https://example.test/*' && _libAskSessions.length === 2 && document.getElementById('ask-library-status').classList.contains('bad')));
  await page.evaluate(() => { chrome.permissions.request = () => new Promise(resolve => { window.finishPermission = resolve; }); });
  await page.locator('.ask-library-actions button').first().click();
  await page.waitForFunction(() => typeof finishPermission === 'function');
  await page.evaluate(() => pbpLibAskRefresh());
  check('history refresh cannot duplicate an in-flight reader open', await page.locator('.ask-library-actions button').first().isDisabled());
  await page.evaluate(() => finishPermission(false));
  await page.waitForFunction(() => !document.querySelector('.ask-library-actions button').disabled);
  // Continue opens the reader on the archived page address. The bookmark bar
  // there must ask about the address the toolbar icon asks about (the cleaned
  // one while the popup cleans on open), while the slot's url stays the page's
  // own so highlights keep their key.
  await page.evaluate(() => {
    window.readerSlots = [];
    window.askStubs = { query: chrome.tabs.query, get: chrome.tabs.get, create: chrome.tabs.create, contains: chrome.permissions.contains, set: chrome.storage.local.set };
    chrome.permissions.contains = async () => true;
    chrome.tabs.query = async () => [{ id: 4242, url: window.continueUrl, status: 'complete', incognito: false }];
    chrome.tabs.get = async () => ({ id: 4242, url: window.continueUrl, status: 'complete', incognito: false });
    window.createdUrls = [];
    chrome.tabs.create = async (props) => { createdUrls.push(props && props.url); return { id: 4243 }; };
    chrome.storage.local.set = function (items, ...rest) {
      const slots = Object.entries(items || {}).filter(([key]) => key.startsWith('md_preview_data_'));
      if (slots.length) { for (const [, slot] of slots) readerSlots.push(slot); return Promise.resolve(); }
      return askStubs.set.call(chrome.storage.local, items, ...rest);
    };
  });
  const tracked = 'https://example.test/reading?utm_source=newsletter&id=7';
  for (const [urlClean, expected] of [[undefined, 'https://example.test/reading?id=7'], [{ enabled: false, onPopupOpen: true, onPaste: true, aggressiveMode: false, customParams: [], excludeParams: [] }, tracked], [{ enabled: true, onPopupOpen: false, onPaste: true, aggressiveMode: false, customParams: [], excludeParams: [] }, tracked]]) {
    const slot = await page.evaluate(async ({ tracked, urlClean }) => {
      if (urlClean === undefined) await chrome.storage.local.remove('urlClean'); else await askStubs.set.call(chrome.storage.local, { urlClean });
      window.continueUrl = tracked; readerSlots.length = 0;
      const session = _libAskSessions.find(row => row.id === 'render-session-main');
      const saved = session.url; session.url = tracked;
      try { await _pbpLibAskContinue(session, document.querySelector('.ask-library-actions button')); }
      finally { session.url = saved; }
      return readerSlots[0] || null;
    }, { tracked, urlClean });
    check('Continue hands the reader the bookmark address under ' + JSON.stringify(urlClean ?? 'default'), slot && slot.url === tracked && slot.baseUrl === tracked && slot.sourceTabUrl === tracked && slot.bookmarkUrl === expected, slot);
  }
  // A video page opens with the same video=1 first-paint mark the popup and
  // the shortcut add, so the dark video default applies before first paint;
  // an ordinary page does not get it.
  for (const [pageUrl, wantMark] of [['https://www.youtube.com/watch?v=dQw4w9WgXcQ', true], ['https://www.bilibili.com/video/BV1xx411c7mD', true], ['https://example.test/reading', false]]) {
    const created = await page.evaluate(async (pageUrl) => {
      window.continueUrl = pageUrl; readerSlots.length = 0; createdUrls.length = 0;
      const session = _libAskSessions.find(row => row.id === 'render-session-main');
      const saved = session.url; session.url = pageUrl;
      try { await _pbpLibAskContinue(session, document.querySelector('.ask-library-actions button')); }
      finally { session.url = saved; }
      return createdUrls.slice();
    }, pageUrl);
    check('Continue on ' + pageUrl + (wantMark ? ' carries' : ' omits') + ' the video=1 mark', created.length === 1 && /[?&]video=1(&|$)/.test(created[0]) === wantMark && created[0].includes('askSession='), created);
  }
  // The slot's account is the bookmark connection, not the library owner: the
  // reader keeps the slot when it equals the current connection and retires
  // its bookmark data only when it does not.
  const continueSlot = () => page.evaluate(async () => {
    window.continueUrl = 'https://example.test/reading'; readerSlots.length = 0;
    await _pbpLibAskContinue(_libAskSessions.find(row => row.id === 'render-session-main'), document.querySelector('.ask-library-actions button'));
    return { slot: readerSlots[0] || null, connection: (await pbpReadBookmarkConnection()).account };
  });
  let handoff = await continueSlot();
  check('Continue under Pinboard hands over the bookmark connection account', handoff.slot && handoff.connection === 'ask-library-fixture' && handoff.slot.account === handoff.connection, handoff);
  // The device's active service (bookmarkServiceActive, local only) decides
  // the connection; the chosen bookmarkService alone does not switch it.
  for (const [service, userId] of [['karakeep', 'user-7'], ['linkding', 'conn-9']]) {
    await page.evaluate(async ({ service, userId }) => {
      const baseUrl = 'https://' + service + '.example/';
      const credential = { v: 1, baseUrl, token: 'fixture-token', connectionId: 'conn-9', ...(service === 'karakeep' ? { userId } : {}) };
      await askStubs.set.call(chrome.storage.local, { bookmarkService: service, [PBP_BOOKMARK_ACTIVE_KEY]: service, [service + 'Url']: baseUrl, [service + 'Token']: obfuscateKey(JSON.stringify(credential)) });
    }, { service, userId });
    handoff = await continueSlot();
    check('Continue under ' + service + ' hands over the current connection, matching what the reader compares', handoff.slot && handoff.connection === service + ':https://' + service + '.example/:' + userId && handoff.slot.account === handoff.connection && handoff.slot.account !== '', handoff);
  }
  await page.evaluate(() => askStubs.set.call(chrome.storage.local, { bookmarkService: 'pinboard', [PBP_BOOKMARK_ACTIVE_KEY]: 'pinboard' }));
  // An unreadable urlClean setting is traced and the reader still opens, with the unchanged page address (tracking parameters included) as the bookmark address.
  await page.evaluate(() => {
    window.warnings = []; window.warnStub = console.warn; console.warn = (...args) => warnings.push(args.join(' '));
    window.settingsStub = window.getSettingsStorage;
    window.getSettingsStorage = async () => ({ get: async () => { throw new Error('storage unavailable'); } });
  });
  handoff = await page.evaluate(async () => {
    const tracked = 'https://example.test/reading?utm_source=x';
    window.continueUrl = tracked; readerSlots.length = 0;
    const session = _libAskSessions.find(row => row.id === 'render-session-main'); const saved = session.url; session.url = tracked;
    try { await _pbpLibAskContinue(session, document.querySelector('.ask-library-actions button')); } finally { session.url = saved; }
    return { slot: readerSlots[0] || null };
  });
  await page.evaluate(() => { window.getSettingsStorage = settingsStub; console.warn = warnStub; });
  check('Continue still opens the reader when the urlClean read throws', handoff.slot && handoff.slot.bookmarkUrl === 'https://example.test/reading?utm_source=x' && handoff.slot.url === handoff.slot.bookmarkUrl && await page.evaluate(() => warnings.some(line => line.includes('urlClean'))), handoff);
  await page.evaluate(async () => {
    Object.assign(chrome.tabs, { query: askStubs.query, get: askStubs.get, create: askStubs.create });
    chrome.permissions.contains = askStubs.contains; chrome.storage.local.set = askStubs.set;
    await chrome.storage.local.remove('urlClean');
  });
  await page.waitForFunction(() => !document.querySelector('.ask-library-actions button').disabled);
  await page.locator('#lib-keys-open').click();
  check('Ask keyboard help exposes conversation keys without vocabulary selection actions', await page.evaluate(() => document.querySelector('#lib-keys [data-keys-for="ask"] dd').getClientRects().length > 0 && [...document.querySelectorAll('#lib-keys [data-keys-for="vocab"] dd, #lib-keys [data-keys-for="notes"] dd, #lib-keys [data-keys-for="selection"] dd')].every(el => !el.getClientRects().length)));
  await page.keyboard.press('/');
  check('search shortcut closes the help popover and focuses Ask search', await page.evaluate(() => document.activeElement.id === 'ask-library-search' && !document.getElementById('lib-keys').matches(':popover-open')));
  await page.setViewportSize({ width: 360, height: 900 });
  await page.locator('.ask-library-back').click(); await page.locator('.ask-library-hit').first().click();
  check('narrow detail focuses its back action', await page.evaluate(() => document.activeElement.classList.contains('ask-library-back') && document.body.classList.contains('lib-narrow-ask')));
  await page.screenshot({ path: out + '/ask-zh-TW-360.png' });
  await page.setViewportSize({ width: 320, height: 900 });
  for (const locale of ['en', 'zh_CN', 'zh_TW', 'zh_HK', 'de', 'fr', 'ja', 'pl', 'ru']) {
    await page.evaluate(async locale => { await chrome.storage.local.set({ optLang: locale }); await _refreshI18nAsync(); _pbpLibAskRenderList(); _pbpLibAskRenderDetail(); }, locale);
    check('detail fits 320px in ' + locale, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await page.evaluate(() => { _libAskSessions.find(row => row.id === _libAskSelected).title = 'An extremely long title with one uninterrupted segment ' + 'word'.repeat(80); _pbpLibAskRenderDetail(); });
  await page.setViewportSize({ width: 320, height: 900 });
  check('long article title wraps without horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  // Observe the bottom action after scrolling before opening a confirmation.
  // An automatic test click can otherwise deliver its own pending scroll
  // after opening, which intentionally light-dismisses the shared popover.
  await page.locator('.ask-library-delete').scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('.ask-library-delete').click(); await page.locator('.confirm-popover:not(.is-closing) .confirm-no').click();
  check('cancel deletion keeps the selected session', await page.evaluate(() => _libAskSelected === 'render-session-main' && _libAskSessions.length === 2));
  // A cancelled popover retains its inert DOM during the exit transition;
  // target the live confirmation rather than matching both copies.
  await page.locator('.ask-library-delete').click(); await page.locator('.confirm-popover:not(.is-closing) .confirm-yes').click();
  await page.waitForFunction(() => !_libAskSelected && _libAskSessions.length === 1);
  check('delete returns narrow screen to focusable list', await page.evaluate(() => !document.body.classList.contains('lib-narrow-ask') && document.activeElement.id === 'ask-library-search'));
  await page.locator('.ask-library-hit').click();
  await page.evaluate(async () => { await pbpAskArchiveDelete({ owner: _libAskOwner, sessionId: _libAskSelected }); await pbpLibAskRefresh(); });
  check('remote deletion of selected session leaves no blank narrow detail', await page.evaluate(() => !_libAskSelected && !document.body.classList.contains('lib-narrow-ask') && !document.getElementById('ask-library-empty').hidden));
  await installAskHistoryFixture(page); await page.setViewportSize({ width: 1280, height: 900 });
  // Both reads hang, so the order is ours: the previous owner's read is
  // released while the new owner's is still pending, and the history must
  // stay empty at that moment. (If the new read finished first, or the check
  // ran after it, a stale write would be overwritten and go unnoticed.)
  await page.evaluate(() => {
    window.oldRows = _libAskSessions; window.staleOwner = _libAskOwner; window.pendingReads = {};
    _pbpAskArchiveDefaultStore().read = args => new Promise(resolve => { pendingReads[args.owner === staleOwner ? 'old' : 'new'] = resolve; });
    window.oldRefresh = pbpLibAskRefresh();
  });
  await page.waitForFunction(() => typeof pendingReads.old === 'function');
  // The library owner is the fixed personal-library identity, not the current
  // bookmark login: switching it (not the Pinboard token) is what changes owner.
  await sw.evaluate(() => chrome.storage.local.set({ personalLibraryAccount: 'different-library:test-only' }));
  await page.waitForFunction(() => typeof pendingReads.new === 'function');
  await page.evaluate(async () => { pendingReads.old(oldRows); await oldRefresh; });
  check('late previous-account read cannot repopulate history', await page.locator('.ask-library-hit').count() === 0 && await page.evaluate(() => _libAskSessions.length === 0));
  await page.evaluate(() => pendingReads.new([]));
  await page.waitForFunction(() => !document.getElementById('ask-library-status').textContent);
  // Render cap: the list grows 100 sessions at a time like the notes and vocabulary lists, and picking a session never rebuilds it.
  await page.evaluate(() => {
    _libAskSessions = Array.from({ length: 250 }, (_, i) => ({ id: 's' + i, url: 'https://example.test/p' + (i % 40), title: 'Page ' + (i % 40), updatedAt: 1792800000000 - i, records: [{ id: 'r' + i, q: 'Question ' + i, a: 'Answer ' + i, ts: 1792800000000 - i }] }));
    _libAskSelected = ''; document.getElementById('ask-library-search').value = ''; _pbpLibAskRenderList(true);
  });
  const askCounts = () => page.evaluate(() => ({ hits: document.querySelectorAll('#ask-library-list .ask-library-hit').length, stops: document.querySelectorAll('#ask-library-list .ask-library-hit[tabindex="0"]').length, more: !!document.getElementById('ask-load-more') }));
  let askC = await askCounts();
  check('long Ask history renders one batch with a load-more control', askC.hits === 100 && askC.stops === 1 && askC.more, askC);
  await page.locator('#ask-library-list .ask-library-hit').nth(3).click();
  check('picking a session keeps the list nodes and moves the single tab stop', await page.evaluate(() => { const hits = [...document.querySelectorAll('#ask-library-list .ask-library-hit')]; return hits.length === 100 && hits[3].getAttribute('aria-current') === 'true' && hits.filter(b => b.getAttribute('aria-current') === 'true').length === 1 && hits.filter(b => b.tabIndex === 0).length === 1 && hits[3].tabIndex === 0 && _libAskSelected === hits[3].dataset.session; }));
  await page.evaluate(() => { window.askHitRef = document.querySelector('#ask-library-list .ask-library-hit'); });
  await page.locator('#ask-library-list .ask-library-hit').nth(4).click();
  check('second pick reuses the same button elements', await page.evaluate(() => askHitRef === document.querySelector('#ask-library-list .ask-library-hit') && document.activeElement === document.querySelectorAll('#ask-library-list .ask-library-hit')[4]));
  const idsBefore = await page.evaluate(() => [...document.querySelectorAll('#ask-library-list .ask-library-hit')].map(b => b.dataset.session));
  await page.locator('#ask-load-more').click();
  check('load more keeps the earlier rows in place and only appends', await page.evaluate(before => { const ids = [...document.querySelectorAll('#ask-library-list .ask-library-hit')].map(b => b.dataset.session); return ids.length > before.length && before.every((id, i) => ids[i] === id); }, idsBefore));
  askC = await askCounts();
  check('load more appends the next batch', askC.hits === 200 && askC.stops === 1 && askC.more, askC);
  await page.evaluate(() => _pbpLibAskRenderList());
  check('a background refresh keeps the expanded batch', (await askCounts()).hits === 200);
  const idsLast = await page.evaluate(() => [...document.querySelectorAll('#ask-library-list .ask-library-hit')].map(b => b.dataset.session));
  await page.locator('#ask-load-more').click();
  check('last batch hands focus to the first newly loaded row', await page.evaluate(before => { const ids = [...document.querySelectorAll('#ask-library-list .ask-library-hit')].map(b => b.dataset.session); return before.every((id, i) => ids[i] === id) && document.activeElement?.dataset.session === ids[before.length] && document.activeElement.tabIndex === 0; }, idsLast));
  askC = await askCounts();
  check('last batch removes the control', askC.hits === 250 && !askC.more, askC);
  await page.locator('#ask-library-search').fill('Question 1');
  askC = await askCounts();
  check('a new search starts again from one batch', askC.hits === 100 && askC.more, askC);
  await page.locator('#ask-library-search').fill('');
  askC = await askCounts();
  check('clearing the search resets the cap', askC.hits === 100 && askC.more, askC);
  await page.evaluate(() => { _libAskSelected = 's240'; _pbpLibAskRenderList(); });
  check('a selected session beyond the cap is rendered', await page.evaluate(() => !!document.querySelector('#ask-library-list [data-session="s240"][aria-current="true"]')));
  await page.evaluate(() => { _libAskSessions = []; _libAskSelected = ''; _pbpLibAskRenderList(true); });
  check('no browser exceptions', errors.length === 0, errors);
  console.log(JSON.stringify({ checks: checks.length, ok: true, out }));
} catch (error) {
  const page = context.pages().find(page => page.url().includes('library.html'));
  if (page) { await page.screenshot({ path: out + '/failure.png' }); console.error(await page.evaluate(() => [...document.querySelectorAll('.confirm-popover, .confirm-no, .ask-library-delete')].map(el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { html: el.outerHTML, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, z: s.zIndex, pointer: s.pointerEvents, hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.outerHTML.slice(0, 150) }; }))); }
  throw error;
} finally { await context.close(); rmSync(profile, { recursive: true, force: true }); }
