// Module registry for scripts/bookmark-service-live.mjs (opt-in real-service
// acceptance). Pure data plus the steps each module drives through the
// harness interface `t`; it never reads credentials, starts containers or
// touches the network by itself, so --plan and --list can import it freely.
//
// One row per module. The runner expands a row once per service listed in
// `services`; the instance id is `<service>.<row id>` (or the temporary
// instance name, e.g. `linkding-pg.<row id>`, when `needs.container` picks a
// non-default temporary container). Selection, budgets and target checks all
// read these rows; no second inventory exists.
//
// Row shape:
//   id        stable module id (dots allowed; globs match the expanded id)
//   services  service types the row runs against ('linkding' | 'karakeep' | 'pinboard')
//   surfaces  extension surfaces it drives: background|options|popup|reader.
//             --changed routes by them (see `files`), so list every page the
//             module loads, whether its steps open it or the product does;
//             the runner records the pages each module actually loads and
//             fails one that drives a surface left out here
//             (surface_undeclared). options and the worker need no entry.
//   features  fix/feature tags; the Chinese summary groups results by them
//   fixRefs   fix groups of feat/selfhosted-save-adaptation (G2, G24, ...) the
//             row's assertions depend on: they state the behaviour the user's
//             decisions require once those fixes land, so a row whose groups
//             are not committed yet is expected to fail on that tree; the
//             Chinese summary names the groups next to a failed row
//   needs     { fakeAi, target: 'temp'|'user'|'any', container, sharing: 'any'|'on'|'off',
//               headed, shots, pinboard, writes, urls, snapshots }
//             longTag: 'none' | 'injected' | 'server'. A row that sends a tag
//             past linkding's 64 characters says so: 'server' lets the
//             service answer (temporary instances only; the preflight holds
//             it to needs.target 'temp'), 'injected' has every such write
//             answered by t.inject. The runner refuses an over-long tag that
//             would reach a user instance either way (live_guard_long_tag_user).
//             ldRender: the linkding instance compares Notes through the
//             renderer replica (PBP_LD_RENDER_PYTHON / _SCRIPT); without it
//             the module fails as ld_render_missing and --plan lists it.
//             snapshots: the module waits for linkding's automatic HTML
//             snapshot. Temporary linkding instances start with automatic
//             snapshots off; the runner switches them on for such a module
//             only. A user instance keeps its own profile setting.
//   budget    { bookmarks, urls, node, browser, ai, tags, lists, seconds, tagReads }
//             any field may be a number or { <service>: number }
//             tagReads: full tag-list reads the extension makes in one pass
//             (measured on temporary instances: report.modules[].paths
//             "GET tags"). The browser budget covers each at TAG_PAGES
//             pages; a user library with more pages raises it at run time.
//   files     product files the module covers beyond its surfaces, for
//             --changed: paths or globs from the repository root, an array
//             or { all, <service> }; usually empty. The runner adds what each
//             surface in `surfaces` loads (read from the tree under test:
//             importScripts, script and stylesheet tags, injected files) and,
//             for every module, the worker, options.html (Connect) and the
//             default locale. A changed file selects every module covering
//             it; a product runtime file none covers is listed by --plan as
//             uncovered. `surfaces` must use background|options|popup|reader.
//   settings  chrome.storage.local overrides applied for this module only
//   steps(t)  drives the extension; verify(t) reads back (optional)
//
// Budgets are per module and per service. The runner adds them up per
// instance, refuses a plan that exceeds the target's caps, and aborts the
// whole run when a module overruns its own row at run time. `seconds` is a
// timeout, not an estimate: the modules took 1-11 s on temporary instances
// (snapshot waits aside), and the plan refuses a selection whose timeouts
// plus setup could outlast the run cap (20 minutes on --target user).

export const LIST_MARKER = 'Pinboard Bookmark Enhanced: Read Later';
export const META_DESCRIPTION = 'Public synthetic meta description.';

const NEEDS = Object.freeze({
  fakeAi: false, target: 'any', container: null, sharing: 'any', headed: false,
  shots: false, pinboard: false, writes: true, snapshots: false, longTag: 'none', ldRender: false,
});

// linkding builds HTML snapshots one at a time in the background. Only the
// snapshot module waits for one, polling every 5 s and stopping while its
// module still has SNAPSHOT_MARGIN_MS left for checks and cleanup.
export const SNAPSHOT_POLL_MS = 5000;
export const SNAPSHOT_MARGIN_MS = 15000;
// A temporary linkding finishes a snapshot in about 10 s; one run in four
// sat pending for the whole module. There it polls every 2 s (E26: loopback
// and tmpfs, so the wait ends within 2 s of completion, not 5) and stops
// after 15 polls (30 s) as snapshot_pending_timeout, still a failure, and
// records the container's snapshot task state. A user instance keeps the
// 5 s poll and the full wait.
export const SNAPSHOT_TEMP_POLL_MS = 2000;
export const SNAPSHOT_TEMP_POLLS = 15;
const needs = (over = {}) => ({ ...NEEDS, ...over });

// Row fields that vary by service resolve through this helper (number or map).
export function budgetValue(value, service) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return value;
  return Number(value[service] || 0);
}

// ---- shared module steps -------------------------------------------------

// The linkding popup must hide Pinboard's private box, leave sharing off,
// prefill Description from the page meta and keep it out of Notes.
async function linkdingPrefill(t, popup) {
  t.expect(await popup.locator('#private-check').isHidden(), 'linkding_private_control');
  t.expect(!await popup.locator('#share-check').isChecked(), 'linkding_default_shared');
  t.expectEq(await popup.locator('#linkding-description-input').inputValue(), META_DESCRIPTION, 'linkding_meta_description');
  t.expect(!(await popup.locator('#description-input').inputValue()).includes(META_DESCRIPTION), 'linkding_meta_repeated_in_notes');
}

// Read-back fields per service. Pinboard rows are posts/get post objects:
// description (title), extended (notes), tags (one space-separated string),
// shared / toread ("yes" | "no").
const noteOf = (t, row) => (t.service === 'linkding' ? row.notes : t.service === 'pinboard' ? row.extended : row.note);
const titleOf = (t, row) => (t.service === 'pinboard' ? row.description : row.title);
const tagNamesOf = (t, row) => (t.service === 'linkding' ? row.tag_names : t.service === 'pinboard' ? String(row.tags || '').split(/\s+/).filter(Boolean) : (row.tags || []).map(tag => tag.name));

// The tag count the extension itself reads: its client for linkding and
// Karakeep, the worker's tags/get wrapper for Pinboard.
const extensionTagCount = t => t.sw(async service => {
  const auth = await getCurrentBookmarkAuth();
  if (service === 'pinboard') return { tags: Object.keys(await pbpBookmarkTagCounts(auth)).length, recent: 0 };
  const client = pbpBookmarkClient(auth);
  return { tags: (await client.tags()).length, recent: (await client.recent(2)).length };
}, t.service);

// The Pinboard popup keeps its Private box; the run defaults to private.
async function pinboardPrefill(t, popup) {
  t.expect(await popup.locator('#private-check').isVisible(), 'pinboard_private_control');
  t.expect(await popup.locator('#private-check').isChecked(), 'pinboard_default_private');
}

async function karakeepLists(t, row) {
  return (await t.api('bookmarks/' + encodeURIComponent(row.id) + '/lists')).lists || [];
}

// ---- modules ---------------------------------------------------------------

export const MODULES = [
  {
    id: 'readonly',
    services: ['linkding', 'karakeep', 'pinboard'],
    surfaces: ['options', 'popup'],
    features: ['connect', 'tags-recent', 'popup-prefill'],
    fixRefs: [],
    needs: needs({ writes: false }),
    budget: { bookmarks: 0, urls: 1, node: 4, browser: { linkding: 40, karakeep: 60, pinboard: 12 }, ai: 0, tags: 0, seconds: 60, calls: { pinboard: 4 }, tagReads: { linkding: 2, karakeep: 2 } },
    files: [],
    settings: {},
    async steps(t) {
      await t.phase('readonly_extension');
      const result = await extensionTagCount(t);
      t.check(`${t.service}: authenticated extension tags/recent passed (${result.tags} usable tags)`);
      await t.phase('readonly_popup');
      const form = await t.openPopup(t.claimUrl());
      if (t.service === 'linkding') await linkdingPrefill(t, form.popup);
      if (t.service === 'pinboard') await pinboardPrefill(t, form.popup);
      await t.shot(form.popup, 'prefill', { surface: 'popup', keys: ['#submit-btn'] });
      t.check(`${t.service}: synthetic article popup prefill without saving`);
      await form.close();
    },
  },

  // First writing module on purpose: linkding snapshots run one at a time,
  // so on a user instance this bookmark does not queue behind the others.
  {
    id: 'core.snapshot',
    services: ['linkding'],
    surfaces: ['background'],
    features: ['linkding-snapshot'],
    fixRefs: [],
    needs: needs({ snapshots: true }),
    // One assets read per poll: at most 21 in 120 s on a user instance (15 on
    // a temporary one), plus the create lookups.
    budget: { bookmarks: 1, urls: 1, node: 30, browser: 10, ai: 0, tags: 0, seconds: 120 },
    files: [],
    settings: {},
    async steps(t) {
      const url = t.claimUrl();
      await t.phase('snapshot_create');
      const saved = await t.sw(async intent => {
        const result = await submitSaveIntent(intent);
        return { status: result.status, reason: result.reason };
      }, { mode: 'create', url, title: t.prefix + ' 快照', notes: '', tags: '', private: true, toread: false, archive: false });
      t.expectEq(saved.status, 'saved', 'snapshot_create');
      const row = await t.ownRow(url);
      await t.phase('snapshot_wait');
      const started = Date.now();
      let status = 'missing', polls = 0;
      const pollMs = t.target === 'temp' ? SNAPSHOT_TEMP_POLL_MS : SNAPSHOT_POLL_MS;
      for (;;) {
        await t.sleep(pollMs);
        polls++;
        const assets = await t.api('bookmarks/' + row.id + '/assets/');
        status = (assets.results || []).find(a => a.asset_type === 'snapshot')?.status || 'missing';
        // linkding stores the pending asset inside the create request, so
        // "missing" already means automatic snapshots are off for this account.
        if (status !== 'pending' || t.remainingMs() < pollMs + SNAPSHOT_MARGIN_MS) break;
        if (t.target === 'temp' && polls >= SNAPSHOT_TEMP_POLLS) break;
      }
      t.note('snapshot', { status, polls, waitedMs: Date.now() - started });
      if (status === 'pending' && t.target === 'temp' && polls >= SNAPSHOT_TEMP_POLLS) {
        // Is it the temporary container? Its task queue, asset states, the
        // jobs process and Chromium, read-only.
        let tasks;
        try { tasks = await t.snapshotDiagnostics(); } catch (error) { tasks = { error: String(error?.code || error?.name || 'Error') }; }
        t.note('snapshotTasks', tasks);
        t.expectEq(status, 'complete', 'snapshot_pending_timeout');
      }
      t.expect(status !== 'missing', 'snapshot_not_queued');
      t.expect(status !== 'failure', 'snapshot_failed');
      t.expectEq(status, 'complete', 'snapshot_incomplete');
      t.check('linkding: a worker save gets a completed HTML snapshot');
    },
  },

  {
    id: 'core.popup-reader',
    services: ['linkding', 'karakeep', 'pinboard'],
    surfaces: ['popup', 'reader'],
    features: ['popup-save', 'linkding-description', 'pinboard-popup-format', 'reader-read-later', 'reader-edit', 'reader-tag-separator', 'reader-delete'],
    fixRefs: ['G2'],
    needs: needs(),
    budget: { bookmarks: 1, urls: 1, node: 16, browser: { linkding: 90, karakeep: 130, pinboard: 40 }, ai: 0, tags: 2, lists: { karakeep: 1 }, seconds: { linkding: 90, karakeep: 90, pinboard: 120 }, calls: { pinboard: 24 } },
    files: [],
    settings: {},
    async steps(t) {
      const { prefix } = t;
      const url = t.claimUrl();
      await t.phase('popup');
      const form = await t.openPopup(url);
      const { popup } = form;
      if (t.service === 'linkding') {
        await linkdingPrefill(t, popup);
        await popup.locator('#linkding-description-input').fill('手工描述，与笔记分开');
      }
      if (t.service === 'pinboard') await pinboardPrefill(t, popup);
      await popup.locator('#title-input').fill(prefix + ' 中文标题');
      await popup.locator('#description-input').fill('中文笔记\n第二行');
      await popup.locator('#tags-input').fill(prefix);
      await popup.locator('#tags-input').press('Enter');
      if (t.service === 'pinboard') {
        await popup.locator('#tags-input').fill(prefix + '_popup');
        await popup.locator('#tags-input').press('Enter');
      }
      await t.savePopup(popup);
      let row = await t.ownRow(url);
      t.expectEq(titleOf(t, row), prefix + ' 中文标题', 'popup_title');
      t.expectEq(noteOf(t, row), '中文笔记\n第二行', 'popup_note');
      if (t.service === 'linkding') {
        t.expectEq(row.shared, false, 'privacy');
        t.expectEq(row.description, '手工描述，与笔记分开', 'linkding_description');
      }
      if (t.service === 'pinboard') {
        // As before the self-hosted work: notes verbatim in extended, tags
        // one space-separated string in entry order, private, not to-read.
        t.expectEq(row.tags, prefix + ' ' + prefix + '_popup', 'pinboard_popup_tags');
        t.expectEq(row.shared, 'no', 'privacy');
        t.expectEq(row.toread, 'no', 'pinboard_popup_toread');
      }
      await form.close();

      await t.phase('reader_later');
      const reader = await t.openReader(url, { markdown: '# 合成文章\n\n不含个人资料。', title: '合成文章', ready: '#reader-bookmark-later' });
      await reader.locator('#reader-bookmark-later').click();
      await reader.waitForFunction(() => document.getElementById('reader-bookmark-later')?.getAttribute('aria-pressed') === 'true');
      row = await t.ownRow(url);
      if (t.service === 'linkding') t.expectEq(row.unread, true, 'read_later');
      else if (t.service === 'pinboard') {
        t.expectEq(row.toread, 'yes', 'read_later');
        t.expectEq(row.shared, 'no', 'later_changed_privacy');
      } else {
        const lists = await karakeepLists(t, row);
        t.expect(lists.some(l => l.type === 'manual' && !l.public && !l.hasCollaborators && l.userRole === 'owner'), 'private_read_later');
        t.expectEq(row.archived, false, 'later_changed_archive');
      }

      await t.phase('reader_edit');
      await reader.waitForFunction(() => document.getElementById('reader-bookmark-save')?.getAttribute('aria-busy') === 'false');
      await reader.locator('#reader-bookmark-edit').click();
      await reader.locator('#reader-bookmark-title').fill(prefix + ' 已编辑');
      await reader.locator('#reader-bookmark-notes').fill('编辑后的笔记\n第二行');
      // Pinboard tags hold no spaces and quotes are literal there: its reader
      // field is whitespace-separated, as in the popup.
      await reader.locator('#reader-bookmark-tags').fill(t.service === 'pinboard' ? prefix + '_reader ' + prefix : JSON.stringify(prefix + ' 空格'));
      await t.applyReader(reader);
      row = await t.ownRow(url);
      t.expectEq(titleOf(t, row), prefix + ' 已编辑', 'reader_fields');
      t.expectEq(noteOf(t, row), '编辑后的笔记\n第二行', 'reader_fields');
      if (t.service === 'pinboard') t.expectEq(row.tags, prefix + '_reader ' + prefix, 'reader_pinboard_tags');
      else t.expect(tagNamesOf(t, row).includes(prefix + '_空格'), 'new_tag_separator');
      if (t.service === 'linkding') t.expectEq(row.description, '手工描述，与笔记分开', 'reader_preserves_description');

      await t.phase('reader_mark_read');
      await reader.waitForFunction(() => document.getElementById('reader-bookmark-save')?.getAttribute('aria-busy') === 'false');
      await reader.locator('#reader-bookmark-save').click();
      await reader.waitForFunction(() => document.getElementById('reader-bookmark-later')?.getAttribute('aria-pressed') === 'false');
      row = await t.ownRow(url);
      if (t.service === 'linkding') t.expect(!row.unread, 'mark_read');
      else if (t.service === 'pinboard') t.expectEq(row.toread, 'no', 'mark_read');
      else t.expect(!(await karakeepLists(t, row)).some(l => l.description === LIST_MARKER), 'remove_later');

      await t.phase('reader_delete');
      await reader.waitForFunction(() => document.getElementById('reader-bookmark-save')?.getAttribute('aria-busy') === 'false');
      await reader.locator('#reader-bookmark-edit').click();
      await reader.locator('#reader-bookmark-delete').click();
      await reader.locator('.confirm-yes').click();
      await reader.waitForFunction(() => document.getElementById('reader-bookmark-status')?.textContent === 'Bookmark deleted');
      t.expect(await t.lookup(url) === null, 'reader_delete');
      await reader.close();
      t.check(`${t.service}: popup save, reader Read Later/edit/tags/read/delete`);
    },
  },

  {
    id: 'core.worker',
    services: ['linkding', 'karakeep', 'pinboard'],
    surfaces: ['background'],
    features: ['worker-create', 'worker-merge', 'worker-conflict', 'archived-preserved', 'tags-recent', 'pinboard-required', 'shared-library'],
    fixRefs: [],
    needs: needs(),
    budget: { bookmarks: 1, urls: 1, node: { linkding: 20, karakeep: 12, pinboard: 6 }, browser: { linkding: 30, karakeep: 40, pinboard: 16 }, ai: 0, tags: 2, seconds: { linkding: 60, karakeep: 60, pinboard: 90 }, calls: { pinboard: 9 }, tagReads: { linkding: 1, karakeep: 1 } },
    files: [],
    settings: {},
    async steps(t) {
      const { prefix } = t;
      const url = t.claimUrl();
      await t.phase('worker_create');
      // A save intent carries tags in the service's own text form: quoted
      // names for linkding / Karakeep, space-separated names for Pinboard.
      const intent = { mode: 'create', url, title: prefix + ' 第二条', notes: '第二条笔记', tags: t.service === 'pinboard' ? prefix + '_空格' : JSON.stringify(prefix + ' 空格'), private: true, toread: false, archive: false };
      const submit = value => t.sw(async intent => {
        const result = await submitSaveIntent(intent);
        return { status: result.status, reason: result.reason };
      }, value);
      t.expectEq((await submit(intent)).status, 'saved', 'worker_create');
      let row = await t.ownRow(url);
      if (t.service === 'pinboard') {
        t.expectEq(row.extended, intent.notes, 'worker_create_fields');
        t.expectEq(row.tags, prefix + '_空格', 'worker_create_fields');
        t.expectEq(row.shared, 'no', 'privacy');
      }
      await t.phase('worker_merge');
      // Pinboard has no archive flag to preserve (and the runner never
      // writes a Pinboard bookmark): the merge keeps title and notes, adds the tag.
      if (t.service !== 'pinboard') await t.api(t.recordPath(row.id), { method: 'PATCH', body: t.service === 'linkding' ? { is_archived: true } : { archived: true } });
      t.expectEq((await submit({ ...intent, mode: 'merge', title: 'must preserve original', notes: '', tags: prefix })).status, 'saved', 'worker_merge');
      row = await t.ownRow(url);
      t.expectEq(titleOf(t, row), intent.title, 'merge_preserves_fields');
      if (t.service === 'pinboard') {
        t.expectEq(row.extended, intent.notes, 'merge_preserves_fields');
        t.expect(tagNamesOf(t, row).includes(prefix) && tagNamesOf(t, row).includes(prefix + '_空格'), 'merge_adds_tags');
      } else t.expectEq(t.service === 'linkding' ? row.is_archived : row.archived, true, 'merge_preserves_fields');
      await t.phase('worker_conflict');
      t.expectEq((await submit(intent)).reason, 'conflict', 'duplicate_create');
      await t.phase('worker_tags_recent');
      const data = await extensionTagCount(t);
      t.expect(data.tags >= 1 && data.recent >= 0, 'tags_recent');
      // Self-hosted saves never need a Pinboard token; on Pinboard it is the connection.
      const hasPinboardToken = await t.sw(async () => !!(await pbpReadSettingsWithSecrets({ pinboardToken: '' })).pinboardToken);
      t.expect(t.service === 'pinboard' ? hasPinboardToken : !hasPinboardToken, 'pinboard_required');
      t.expectEq(await t.sw(() => pbpVocabCurrentOwner()), t.libraryOwner, 'library_changed');
      t.check(`${t.service}: worker create/merge/duplicate, archived-field preservation, tags/recent, shared library`);
    },
  },

  // handoff §9-17 (Pinboard regression): one quick save and one batch save,
  // through the product's own entry points (saveFromBackground with the qs*
  // settings the keyboard command resolves; handleBatchSave with the batch
  // snapshot shape the popup sends). The popup save is core.popup-reader's.
  // Expected values are the pre-change formats (9009bca2): quick-save default
  // tags split on spaces/commas and joined by spaces, a selected quote as
  // <blockquote> with &, <, > escaped; batch tags split on commas with inner
  // spaces turned into "-" (the default separator, set here).
  {
    id: 'core.save-paths',
    services: ['pinboard'],
    surfaces: ['background'],
    features: ['pinboard-quick-save-format', 'pinboard-quote-tag', 'pinboard-batch-save-format'],
    fixRefs: ['G4b'],
    needs: needs(),
    budget: { bookmarks: 2, urls: 2, node: 8, browser: 20, ai: 0, tags: 4, seconds: 100, calls: { pinboard: 8 } },
    files: [],
    settings: { aiTagSeparator: '-', optRespectTagCase: true, qsAutoNotes: true, qsBlockquote: true, qsAiTags: false, qsAiSummary: false, batchAiTags: false, batchAiSummary: false, batchSkipExisting: false, optReadlaterDefault: false },
    async steps(t) {
      const { prefix } = t;
      const openArticle = async (url, selection) => {
        const page = await t.ctx.newPage();
        await page.goto(url);
        if (selection) await page.evaluate(() => {
          const range = document.createRange();
          range.selectNodeContents(document.getElementById('quote-fixture'));
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
        });
        return page;
      };

      await t.phase('pinboard_quick_save');
      const quickUrl = t.claimUrl();
      const quoteTag = prefix + '_q"uote';
      await t.settings({ qsDefaultTags: prefix + '_qs ' + quoteTag });
      const quickPage = await openArticle(quickUrl, true);
      const quick = await t.sw(async url => {
        const tab = (await chrome.tabs.query({})).find(x => x.url === url);
        if (!tab) return { status: 'no_tab' };
        const result = await saveFromBackground({ url: tab.url, title: tab.title || tab.url, tab, settingsOverrides: resolvePrefixSettings(await loadSettings(), 'qs'), toread: false, notifyId: 'qs', notifyTitle: 'Quick saved', notifyCategory: 'quickSave' });
        return { status: result.status, reason: result.reason || '' };
      }, quickUrl);
      t.expectEq(quick.status, 'saved', 'quick_save_status');
      const quickRow = await t.ownRow(quickUrl);
      t.expectEq(quickRow.description, '联调样例', 'quick_save_title');
      t.expectEq(quickRow.extended, '<blockquote>First line\n\n# Heading\n**bold** &lt;tag&gt;\n1. item</blockquote>', 'quick_save_quote_format');
      t.expectEq(quickRow.tags, prefix + '_qs ' + quoteTag, 'quick_save_tags');
      t.expect(tagNamesOf(t, quickRow).includes(quoteTag), 'quick_save_quote_tag');
      t.expectEq(quickRow.shared, 'no', 'privacy');
      t.expectEq(quickRow.toread, 'no', 'quick_save_toread');
      await quickPage.close();

      await t.phase('pinboard_batch_save');
      const batchUrl = t.claimUrl();
      await t.settings({ optBatchTagEnabled: true, optBatchTag: prefix + '_batch, ' + prefix + ' two words' });
      const batchPage = await openArticle(batchUrl, false);
      const progress = await t.sw(async url => {
        const tabs = (await chrome.tabs.query({})).filter(x => x.url === url).map(tab => ({ id: tab.id, title: tab.title || tab.url, url: tab.url, incognito: !!tab.incognito }));
        if (tabs.length !== 1) return { error: 'no_tab' };
        await chrome.storage.local.remove('batch_progress');
        await handleBatchSave(tabs, (await getCurrentBookmarkAuth()).account);
        const { batch_progress: p } = await chrome.storage.local.get('batch_progress');
        return { done: p?.done, saved: p?.saved, failed: p?.failed, error: p?.error || '' };
      }, batchUrl);
      t.expect(progress.done === true && progress.saved === 1 && !progress.failed && !progress.error, 'batch_save_status');
      const batchRow = await t.ownRow(batchUrl);
      t.expectEq(batchRow.description, '联调样例', 'batch_save_title');
      t.expectEq(batchRow.extended, '', 'batch_save_notes');
      t.expectEq(batchRow.tags, prefix + '_batch ' + prefix + '-two-words', 'batch_save_tags');
      t.expectEq(batchRow.shared, 'no', 'privacy');
      t.expectEq(batchRow.toread, 'no', 'batch_save_toread');
      await batchPage.close();
      t.check('pinboard: quick save (selected quote, default tags incl. a " tag) and batch save (comma tags, default separator) keep the pre-change formats, read back from posts/get');
    },
  },

  {
    id: 'edges.tags',
    services: ['karakeep'],
    surfaces: ['popup', 'reader'],
    features: ['native-space-tag', 'tag-spelling-alignment', 'malformed-quote', 'library-majority', 'no-twin-tags'],
    fixRefs: ['G4'],
    needs: needs(),
    budget: { bookmarks: 4, urls: 4, node: 30, browser: 120, ai: 0, tags: 5, seconds: 90, tagReads: 4 },
    files: [],
    settings: { optBlockquote: true, optAutoDescription: true, optRespectTagCase: true, tagSyncMode: 'fresh' },
    async steps(t) {
      const { prefix } = t;
      const urls = [t.claimUrl(), t.claimUrl(), t.claimUrl(), t.claimUrl()];
      // Earlier modules leave their run-prefix tags until the run's cleanup:
      // only the tags this module adds are judged for twins.
      const runTagNames = () => t.sw(async prefix => (await pbpBookmarkClient(await getCurrentBookmarkAuth()).tags()).map(tag => tag.name).filter(name => name.startsWith(prefix)), prefix);
      await t.phase('karakeep_seed_spellings');
      const before = new Set(await runTagNames());
      const names = { own: prefix + ' machine learning', double: prefix + ' double  space', minority: prefix + ' popular topic', twin: prefix + '_machine_learning', majority: prefix + '_popular_topic' };
      // Independent service-native spellings through the real API, not the
      // extension's canonicalizer; every write still passes the Node guard.
      for (let i = 0; i < 3; i++) {
        await t.seed({ url: urls[i], title: prefix + ' seed ' + i, notes: 'Public synthetic tag fixture', tags: i === 0 ? [names.own, names.double, names.minority] : [names.twin, names.majority] });
        await t.ownRow(urls[i]);
      }
      const url = urls[0];
      const initial = await t.ownRow(url);
      const initialIds = initial.tags.map(tag => tag.id).sort().join(',');
      const preserved = async code => {
        const row = await t.ownRow(url);
        t.expectEq(row.tags.map(tag => tag.id).sort().join(','), initialIds, code);
        t.expectEq(row.tags.map(tag => tag.name).sort().join('|'), [names.own, names.double, names.minority].sort().join('|'), code + '_names');
      };
      await t.phase('karakeep_popup_existing_tags');
      const form = await t.openPopup(url);
      await form.popup.waitForFunction(name => allUserTagCounts[name] === 2, names.majority);
      const chips = await form.popup.locator('#tags-display .tag-item').allTextContents();
      t.expect(chips.length === 3 && chips.includes(names.own) && chips.includes(names.double), 'existing_tags_single_chips');
      await form.popup.locator('#title-input').fill(prefix + ' popup updated');
      await t.savePopup(form.popup);
      await preserved('popup_preserves_existing_tag_ids');
      await form.close();

      await t.phase('karakeep_reader_tag_boundaries');
      let reader = await t.openReader(url);
      await reader.locator('#reader-bookmark-edit').click();
      const quoted = await reader.locator('#reader-bookmark-tags').inputValue();
      t.expect(quoted.includes(JSON.stringify(names.own)) && quoted.includes(JSON.stringify(names.double)), 'reader_quotes_existing_space_tags');
      const writes = await t.writes();
      await reader.locator('#reader-bookmark-tags').fill('"' + names.own);
      await reader.locator('#reader-bookmark-apply').click();
      await reader.locator('#reader-bookmark-editor-status[data-state="error"]').waitFor();
      t.expectEq(await t.writes(), writes, 'malformed_quote_dispatched');
      await reader.locator('#reader-bookmark-tags').fill([names.twin, names.double, names.majority].map(n => JSON.stringify(n)).join(' '));
      await t.applyReader(reader);
      await preserved('reader_prefers_bookmark_spelling');
      await reader.close();
      // Disabling library spelling alignment must not rewrite or delete names
      // already on this bookmark, including consecutive spaces.
      await t.settings({ optRespectTagCase: false });
      reader = await t.openReader(url);
      await reader.locator('#reader-bookmark-edit').click();
      await reader.locator('#reader-bookmark-title').fill(prefix + ' case alignment off');
      await t.applyReader(reader);
      await preserved('disabled_alignment_preserves_existing_tags');
      await reader.close();
      await t.settings({ optRespectTagCase: true });

      await t.phase('karakeep_library_majority');
      const fresh = await t.openPopup(urls[3]);
      await fresh.popup.waitForFunction(name => allUserTagCounts[name] === 2, names.majority);
      await fresh.popup.locator('#tags-input').fill(JSON.stringify(names.minority));
      await fresh.popup.locator('#tags-input').press('Enter');
      t.expect((await fresh.popup.locator('#tags-display .tag-item').allTextContents()).includes(names.majority), 'popup_library_majority_chip');
      await t.savePopup(fresh.popup);
      const added = await t.ownRow(urls[3]);
      t.expect(added.tags.length === 1 && added.tags[0].name === names.majority, 'library_majority_reused');
      await fresh.close();
      const after = await runTagNames();
      t.expect(Object.values(names).every(name => after.includes(name)) && after.filter(name => !before.has(name)).every(name => Object.values(names).includes(name)), 'unexpected_twin_tag');
      t.check('karakeep: existing space/double-space tag IDs preserved in popup and reader; own spelling beats library majority; malformed quote sends no writes; alignment-off preservation; new bookmark reuses majority without a twin');
    },
  },

  {
    id: 'edges.quote-unread',
    services: ['linkding'],
    surfaces: ['popup'],
    features: ['selection-quote-escape', 'quote-description-separate', 'unread-link'],
    fixRefs: [],
    needs: needs(),
    budget: { bookmarks: 1, urls: 1, node: 4, browser: 40, ai: 0, tags: 0, seconds: 60, tagReads: 1 },
    files: [],
    settings: { optBlockquote: true, optAutoDescription: true, optRespectTagCase: true, tagSyncMode: 'fresh' },
    async steps(t) {
      await t.phase('linkding_quote_and_unread');
      const url = t.claimUrl();
      const quote = await t.openPopup(url, { selection: true });
      const expectedQuote = '> First line\n>\n> \\# Heading\n> \\*\\*bold\\*\\* &lt;tag>\n> 1\\. item';
      t.expectEq(await quote.popup.locator('#description-input').inputValue(), expectedQuote, 'selection_markdown_source');
      t.expectEq(await quote.popup.locator('#linkding-description-input').inputValue(), META_DESCRIPTION, 'quote_description_separate');
      await t.shot(quote.popup, 'selection-quote', { surface: 'popup', keys: ['#submit-btn'] });
      await t.savePopup(quote.popup);
      const row = await t.ownRow(url);
      t.expectEq(row.notes, expectedQuote, 'quote_server_fields');
      t.expectEq(row.description, META_DESCRIPTION, 'quote_server_fields');
      const probe = t.probe(t.base + 'bookmarks?unread=yes');
      t.expectEq(await quote.popup.locator('#unread-link').getAttribute('href'), probe.url, 'unread_filter_href');
      const opened = t.ctx.waitForEvent('page');
      await quote.popup.locator('#unread-link').click();
      const destination = await opened;
      await destination.waitForLoadState();
      t.expect(probe.observed(), 'unread_filter_click');
      await destination.close();
      probe.clear();
      await quote.close();
      t.check('linkding: selected multiline quote escapes Markdown and stays separate from Description; unread click emits bookmarks?unread=yes (destination rendering not tested)');
    },
  },

  {
    id: 'edges.offline',
    services: ['linkding'],
    surfaces: ['popup'],
    features: ['offline-queue', 'offline-create-fields', 'offline-update-fields', 'explicit-empty-description'],
    fixRefs: ['G2'],
    needs: needs(),
    budget: { bookmarks: 1, urls: 1, node: 6, browser: 60, ai: 0, tags: 1, seconds: 90, tagReads: 2 },
    files: [],
    settings: { optBlockquote: true, optAutoDescription: true, optRespectTagCase: true, tagSyncMode: 'fresh', offlineQueueEnabled: true },
    async steps(t) {
      const { prefix } = t;
      const url = t.claimUrl();
      const tag = prefix + '_offline_tag';
      const queueIsSafe = (expectedSummary, expectedNotes) => t.sw(async ({ url, tag, summary, notes }) => {
        const { offlineQueue = [] } = await chrome.storage.local.get('offlineQueue');
        const auth = await getCurrentBookmarkAuth(), item = offlineQueue[0];
        const fields = new Set(['account', 'mode', 'url', 'title', 'notes', 'summary', 'tags', 'private', 'sharedExplicit', 'toread', 'archive', 'time', 'queuedAt', 'queueId']);
        return offlineQueue.length === 1 && item.url === url && item.account === auth.account && item.summary === summary && item.notes === notes
          && item.tags === tag && item.private === true && Object.keys(item).every(key => fields.has(key)) && !JSON.stringify(item).includes(auth.token);
      }, { url, tag, summary: expectedSummary, notes: expectedNotes });
      // The popup opens as an inactive tab so the article stays the tab it
      // reads; Chromium then barely paints it, and a Playwright click could
      // wait about 2 s for its element to be "stable" (E27: that was most of
      // this module's 6-13 s; the retry button starts the replay at once).
      // Once open, the popup keeps the tab it read (_activeTabAtOpen) and
      // nothing here reads another, so it comes to the front, as a real
      // popup is.
      const open = async () => {
        const form = await t.openPopup(url);
        await form.popup.bringToFront();
        return form;
      };
      const replay = async (form, label) => {
        await form.popup.locator('#offline-queue-toggle').click();
        await t.offline('');
        await form.popup.locator('.offline-queue-retry').click();
        await t.until(() => t.sw(async () => (await chrome.storage.local.get('offlineQueue')).offlineQueue?.length === 0), label);
      };

      await t.phase('linkding_offline_create');
      let form = await open();
      await form.popup.locator('#title-input').fill(prefix + ' offline create');
      await form.popup.locator('#description-input').fill('Offline notes\nSecond line');
      await form.popup.locator('#linkding-description-input').fill('Offline description');
      await form.popup.locator('#tags-input').fill(JSON.stringify(prefix + ' offline tag'));
      await form.popup.locator('#tags-input').press('Enter');
      await form.popup.locator('#readlater-check').check();
      await t.phase('linkding_offline_create_queue');
      await t.offline('self');
      await form.popup.locator('#submit-btn').click();
      await form.popup.locator('#offline-queue-bar:not(.hidden)').waitFor();
      t.expect(await queueIsSafe('Offline description', 'Offline notes\nSecond line'), 'offline_create_queue_fields');
      await t.shot(form.popup, 'offline-queue', { surface: 'popup', keys: ['#offline-queue-bar'] });
      await t.settings({ aiTagSeparator: '-' });
      await t.phase('linkding_offline_create_replay');
      await replay(form, 'offline_create_replay');
      let row = await t.ownRow(url);
      t.expect(row.description === 'Offline description' && row.notes === 'Offline notes\nSecond line' && row.unread === true && row.shared === false, 'offline_create_fields');
      t.expect(row.tag_names.length === 1 && row.tag_names[0] === tag, 'offline_replay_reminted_tag');
      await form.close();

      await t.phase('linkding_offline_update');
      form = await open();
      await form.popup.locator('#description-input').fill('Updated offline notes');
      await form.popup.locator('#linkding-description-input').fill('');
      await form.popup.locator('#readlater-check').uncheck();
      await t.phase('linkding_offline_update_queue');
      await t.offline('self');
      await form.popup.locator('#submit-btn').click();
      await form.popup.locator('#offline-queue-bar:not(.hidden)').waitFor();
      t.expect(await queueIsSafe('', 'Updated offline notes'), 'offline_update_queue_fields');
      await t.phase('linkding_offline_update_replay');
      await replay(form, 'offline_update_replay');
      row = await t.ownRow(url);
      t.expect(row.description === '' && row.notes === 'Updated offline notes' && !row.unread && !row.shared && row.tag_names.length === 1 && row.tag_names[0] === tag, 'offline_update_fields');
      await form.close();
      t.check('linkding: offline popup create and update replay through queue UI; secret-free identity-bound records; explicit empty Description preserved; Notes/unread/default privacy preserved; changed separator does not remint queued tags');
    },
  },

  {
    id: 'ai.popup-summary-tags',
    services: ['linkding', 'karakeep'],
    surfaces: ['popup'],
    features: ['fake-ai', 'ai-summary-description', 'ai-summary-note', 'ai-tags-prefix'],
    fixRefs: ['G1'],
    needs: needs({ fakeAi: true, shots: true }),
    budget: { bookmarks: 1, urls: 1, node: 6, browser: { linkding: 40, karakeep: 60 }, ai: 3, tags: 2, seconds: 90 },
    // The fake AI provider is configured by the runner (needs.fakeAi); these
    // only reveal the popup's AI actions for this module.
    // Re-shot in zh_CN: that locale's messages are the one file it adds.
    files: ['_locales/zh_CN/messages.json'],
    settings: { optShowAiTags: true, optShowAiSummary: true, optAiAutoTags: false },
    async steps(t) {
      const url = t.claimUrl();
      const before = t.fakeAi.calls();
      await t.phase('ai_popup_open');
      const form = await t.openPopup(url);
      const { popup } = form;
      const field = t.service === 'linkding' ? '#linkding-description-input' : '#description-input';
      await t.phase('ai_summary');
      await popup.locator('#ai-summary-btn').click();
      await t.until(async () => (await popup.locator(field).inputValue()).includes(t.fakeAi.marker), 'ai_summary_written');
      const written = await popup.locator(field).inputValue();
      t.expect(!written.includes('[AI Summary]'), 'ai_summary_legacy_label');
      if (t.service === 'linkding') t.expect(!(await popup.locator('#description-input').inputValue()).includes(t.fakeAi.marker), 'ai_summary_in_notes');
      // The summary button is consumed by design (regenerate / remove links
      // replace it), so it is not a key control of the screenshot below.
      t.note('summaryActions', { summaryButtonVisible: await popup.locator('#ai-summary-btn').isVisible(), followUpLinks: await popup.locator('.cache-hint-wrap .regen-link').count() });
      await t.phase('ai_tags');
      await popup.locator('#ai-tags-btn').click();
      await popup.locator('#ai-suggest-tags .stag.ai').first().waitFor();
      const suggested = await popup.locator('#ai-suggest-tags .stag.ai').evaluateAll(els => els.map(el => el.dataset.tag));
      t.expect(suggested.length >= 1 && suggested.every(tag => tag.startsWith(t.prefix)), 'ai_tags_prefixed');
      await popup.locator('#ai-suggest-tags .add-all-link').click();
      // Re-shot in place for zh_CN and dark: no extra request or bookmark.
      await t.shot(popup, 'ai-summary-tags', { surface: 'popup', keys: ['#submit-btn'], locales: ['en', 'zh_CN'], schemes: ['light', 'dark'] });
      await t.phase('ai_save');
      await t.savePopup(popup);
      const row = await t.ownRow(url);
      const stored = t.service === 'linkding' ? row.description : row.note;
      t.expect(typeof stored === 'string' && stored.includes(t.fakeAi.marker), 'ai_summary_saved');
      t.expect(!stored.includes('[AI Summary]') && !stored.includes('<blockquote'), 'ai_summary_saved_plain');
      const saved = tagNamesOf(t, row);
      t.expect(suggested.every(tag => saved.includes(tag)), 'ai_tags_saved');
      t.expect(t.fakeAi.calls() - before >= 1, 'fake_ai_not_called');
      t.expect(t.fakeAi.unknown() === 0, 'fake_ai_unknown_request');
      await form.close();
      t.check(`${t.service}: popup AI summary and AI tags through the local fake provider, saved and read back`);
    },
  },

  {
    id: 'sharing.popup-reader',
    services: ['linkding'],
    surfaces: ['popup', 'reader'],
    features: ['linkding-sharing-control', 'linkding-explicit-share', 'linkding-untouched-share', 'linkding-reader-new-unshared'],
    fixRefs: ['G3'],
    // Sharing is switched on only inside a temporary instance; the runner
    // reconnects so the extension records it, and switches it back after.
    needs: needs({ target: 'temp', sharing: 'on', shots: true }),
    budget: { bookmarks: 2, urls: 2, node: 16, browser: 200, ai: 0, tags: 1, seconds: 150 },
    files: [],
    settings: {},
    async steps(t) {
      const { prefix } = t;
      const url = t.claimUrl();
      const title = prefix + ' sharing';
      const open = async expectedTitle => {
        const form = await t.openPopup(url);
        // Wait for the saved bookmark to land in the form before judging it.
        if (expectedTitle) await t.until(async () => (await form.popup.locator('#title-input').inputValue()) === expectedTitle, 'sharing_existing_prefill');
        await form.popup.waitForFunction(() => {
          const box = document.getElementById('share-check');
          return box && !box.disabled && !box.closest('label').hidden;
        });
        return form;
      };

      await t.phase('sharing_popup_new');
      let form = await open('');
      let { popup } = form;
      t.expect(await popup.locator('#private-check').isHidden(), 'linkding_private_control');
      t.expect(!await popup.locator('#share-check').isChecked(), 'linkding_default_shared');
      await t.shot(popup, 'sharing-new', { surface: 'popup', keys: ['#share-check', '#submit-btn'] });
      await popup.locator('#title-input').fill(title);
      await popup.locator('#tags-input').fill(prefix);
      await popup.locator('#tags-input').press('Enter');
      await t.savePopup(popup);
      let row = await t.ownRow(url);
      t.expectEq(row.shared, false, 'new_bookmark_shared');
      await form.close();

      await t.phase('sharing_popup_explicit');
      form = await open(title);
      popup = form.popup;
      t.expect(!await popup.locator('#share-check').isChecked(), 'existing_shared_prefill');
      await popup.locator('#share-check').check();
      await t.savePopup(popup);
      row = await t.ownRow(url);
      t.expectEq(row.shared, true, 'explicit_share');
      await form.close();

      await t.phase('sharing_popup_untouched');
      form = await open(title);
      popup = form.popup;
      t.expect(await popup.locator('#share-check').isChecked(), 'existing_shared_prefill');
      await popup.locator('#title-input').fill(title + ' edited');
      await t.savePopup(popup);
      row = await t.ownRow(url);
      t.expectEq(row.title, title + ' edited', 'popup_title');
      t.expectEq(row.shared, true, 'untouched_share_changed');
      await form.close();

      await t.phase('sharing_reader_edit');
      let reader = await t.openReader(url, { ready: '#reader-bookmark-edit' });
      await reader.locator('#reader-bookmark-edit').click();
      await reader.locator('#reader-bookmark-notes').fill('reader notes');
      await t.applyReader(reader);
      row = await t.ownRow(url);
      t.expectEq(row.notes, 'reader notes', 'reader_fields');
      t.expectEq(row.shared, true, 'reader_edit_changed_share');
      await reader.close();

      await t.phase('sharing_reader_new');
      const fresh = t.claimUrl();
      reader = await t.openReader(fresh, { ready: '#reader-bookmark-save' });
      await reader.locator('#reader-bookmark-save').click();
      await reader.waitForFunction(() => document.getElementById('reader-bookmark-save')?.dataset.saved === 'true');
      row = await t.ownRow(fresh);
      t.expectEq(row.shared, false, 'reader_new_shared');
      await reader.close();
      t.check('linkding (sharing on): Share box replaces Private, new saves unshared, explicit share kept, untouched share kept by popup and reader edits, reader-created bookmark unshared');
    },
  },

  {
    id: 'limits.long-tag',
    services: ['linkding'],
    surfaces: ['popup'],
    features: ['linkding-long-tag-500', 'linkding-long-tag-no-retry-loop'],
    fixRefs: ['G3', 'G4b'],
    // linkding keeps tag names in varchar(64): SQLite ignores the limit and
    // Postgres answers 500, so only the temporary Postgres-backed instance
    // reproduces it. The module records what the popup shows (notes) and
    // asserts only what must hold before and after the planned fix: no
    // reported success and no request storm.
    needs: needs({ target: 'temp', container: 'linkding-pg', shots: true, longTag: 'server' }),
    budget: { bookmarks: 2, urls: 2, node: 12, browser: 80, ai: 0, tags: 1, seconds: 120, tagReads: 1 },
    files: [],
    settings: { offlineQueueEnabled: true },
    async steps(t) {
      const { prefix } = t;
      const long = prefix + '_' + 'long'.repeat(6);
      t.expect(long.length > 64, 'long_tag_length');

      await t.phase('long_tag_server');
      const direct = t.claimUrl();
      const res = await t.api('bookmarks/', { method: 'POST', body: { url: direct, title: prefix + ' long tag (API)', tag_names: [long], is_archived: false, unread: false, shared: false }, allowStatus: [500] });
      t.expectEq(res?.failedStatus, 500, 'long_tag_server_status');
      // A non-atomic create may leave the bookmark without its tag; run
      // cleanup adopts such pool URLs, so this is only recorded.
      t.note('serverPartialCreate', !!(await t.api('bookmarks/check/?url=' + encodeURIComponent(direct)))?.bookmark);

      await t.phase('long_tag_popup');
      const url = t.claimUrl();
      const form = await t.openPopup(url);
      const { popup } = form;
      await popup.locator('#title-input').fill(prefix + ' long tag');
      await popup.locator('#tags-input').fill(long);
      await popup.locator('#tags-input').press('Enter');
      const writesBefore = await t.writes();
      await popup.locator('#submit-btn').click();
      let seen = null;
      await t.until(async () => {
        seen = await popup.evaluate(() => {
          const btn = document.getElementById('submit-btn');
          if (btn.classList.contains('saved-success')) return { outcome: 'saved', text: '' };
          const card = document.querySelector('.submit-bar + .feedback-card');
          if (card) return { outcome: card.dataset.variant === 'warning' ? 'queued' : 'error', text: card.innerText.trim().slice(0, 300) };
          if (btn.classList.contains('save-error')) return { outcome: 'error', text: document.getElementById('status-msg')?.innerText.trim().slice(0, 300) || '' };
          return null;
        });
        return seen;
      }, 'long_tag_outcome', 30000);
      t.note('popupOutcome', seen.outcome);
      t.note('popupMessage', seen.text);
      t.expect(seen.outcome !== 'saved', 'long_tag_reported_saved');
      await t.shot(popup, 'long-tag-' + seen.outcome, { surface: 'popup', keys: ['#submit-btn'] });
      // A permanent server failure must not turn into a request storm.
      const settled = await t.writes();
      await t.sleep(8000);
      const later = await t.writes();
      t.note('popupWrites', settled - writesBefore);
      t.note('writesWhileIdle', later - settled);
      t.expect(later - settled <= 1, 'long_tag_retry_loop');
      t.note('queuedItems', await t.sw(async () => ((await chrome.storage.local.get('offlineQueue')).offlineQueue || []).length));
      t.note('extensionPartialCreate', !!(await t.api('bookmarks/check/?url=' + encodeURIComponent(url)))?.bookmark);
      await form.close();
      t.check('linkding-pg: overlong tag reproduces the server 500; the popup does not report success or retry in a loop (outcome in notes)');
    },
  },
];

// ---- self-hosted save modules (H3b) ----------------------------------------
// Each row asserts the behaviour the user's decisions (decisions-2026-11-02)
// require once its fixes land, never the code as it stood. `fixRefs` names
// the fix groups (feat/selfhosted-save-adaptation) a row depends on: a row
// whose fixes are not committed yet is expected to fail there, and the
// Chinese summary says which groups it waits for. A product setting or
// control a pending fix introduces is looked up by name (t.productSetting);
// until it exists the row fails as pending_setting_<label>.

// A pool page variant the browser gets instead of the shared fixture (t.inject
// on: 'page'): another title or meta description, or a #quote-fixture text.
export function articleHtml({ title = '联调样例', description = META_DESCRIPTION, quote = '' } = {}) {
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title>'
    + (description === null ? '' : '<meta name="description" content="' + esc(description) + '">') + '</head><body><article><h1>'
    + esc(title) + '</h1>' + (quote ? '<pre id="quote-fixture">' + esc(quote) + '</pre>' : '') + '<p>' + '公开合成文本，不含个人资料。 '.repeat(60) + '</p></article></body></html>';
}
const page = (t, url, html) => t.inject({ on: 'page', path: url, status: 200, contentType: 'text/html; charset=utf-8', body: html });

// The duplicate check each service answers (no server-side fetch on Karakeep).
const CHECK_PATH = { linkding: /^bookmarks\/check\/\?/, karakeep: /^bookmarks\/check-url\?/ };
// A bookmark create as the service sees it (linkding may add ?disable_scraping).
const isCreate = (t, r) => r.method === 'POST' && (t.service === 'linkding' ? /^bookmarks\/(\?|$)/.test(r.path) : /^bookmarks(\?|$)/.test(r.path));
const createsOf = (t, url, since = 0) => t.requests({ method: 'POST', since }).filter(r => isCreate(t, r) && (!url || r.body?.url === url));
const writesSince = (t, since) => t.requests({ since }).filter(r => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));

// Quick save (qs) or Read Later (rl) exactly as the keyboard command calls it.
async function shortcutSave(t, url, prefix = 'qs', { open = true } = {}) {
  let article = null;
  if (open) { article = await t.ctx.newPage(); await article.goto(url).catch(() => {}); }
  const result = await t.sw(async ({ url, prefix }) => {
    const tab = (await chrome.tabs.query({})).find(x => x.url === url);
    if (!tab) return { status: 'no_tab' };
    const r = await saveFromBackground({ url: tab.url, title: tab.title || tab.url, tab, settingsOverrides: resolvePrefixSettings(await loadSettings(), prefix), toread: prefix === 'rl', notifyId: prefix, notifyTitle: prefix, notifyCategory: prefix === 'rl' ? 'readLater' : 'quickSave' });
    return { status: r?.status || '', reason: r?.reason || '', mutation: r?.mutation || '' };
  }, { url, prefix });
  if (article) await article.close().catch(() => {});
  return result;
}

// Batch save of the given open tabs through the worker's own entry.
async function batchSave(t, urls) {
  const pages = [];
  for (const url of urls) { const p = await t.ctx.newPage(); await p.goto(url).catch(() => {}); pages.push(p); }
  const progress = await t.sw(async urls => {
    const all = await chrome.tabs.query({});
    const tabs = urls.map(url => all.find(x => x.url === url)).filter(Boolean).map(tab => ({ id: tab.id, title: tab.title || tab.url, url: tab.url, incognito: !!tab.incognito }));
    if (tabs.length !== urls.length) return { error: 'no_tab' };
    await chrome.storage.local.remove('batch_progress');
    await handleBatchSave(tabs, (await getCurrentBookmarkAuth()).account);
    const { batch_progress: p } = await chrome.storage.local.get('batch_progress');
    return { done: p?.done === true, saved: p?.saved || 0, failed: p?.failed || 0, skipped: p?.skipped || 0, queued: p?.queued || 0, tooLong: p?.tooLong || 0, error: p?.error || '' };
  }, urls);
  for (const p of pages) await p.close().catch(() => {});
  return progress;
}

const queue = t => t.sw(async () => { const { offlineQueue = [] } = await chrome.storage.local.get('offlineQueue'); return Array.isArray(offlineQueue) ? offlineQueue : []; });
const drainQueue = t => t.sw(async () => { await processOfflineQueue(); return true; });
// A SHA-256 of the stored connection (the <service>Token envelope with its
// gateway, the address and the chosen service, in local and sync), so a
// module can tell that a failed Connect left it alone without any value
// leaving the worker.
const connectionDigest = t => t.sw(async service => {
  const keys = [service + 'Token', service + 'Url', 'bookmarkService'];
  const [local, sync] = await Promise.all([chrome.storage.local.get(keys), chrome.storage.sync.get(keys)]);
  const bytes = new TextEncoder().encode(JSON.stringify(keys.map(k => [k, local[k] ?? null, sync[k] ?? null])));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}, t.service);

// What the popup shows after Save: saved (button), queued / error (card or
// status line), with the visible text. Null while it is still working.
async function popupOutcome(popup) {
  return popup.evaluate(() => {
    const btn = document.getElementById('submit-btn');
    if (btn.classList.contains('saved-success')) return { outcome: 'saved', text: document.getElementById('status-msg')?.innerText.trim().slice(0, 300) || '' };
    const card = document.querySelector('.submit-bar + .feedback-card');
    if (card) return { outcome: card.dataset.variant === 'warning' ? 'queued' : 'error', text: card.innerText.trim().slice(0, 300) };
    const status = document.getElementById('status-msg');
    if (btn.classList.contains('save-error') || (status && status.innerText.trim() && !btn.disabled && !btn.classList.contains('loading'))) return { outcome: 'notice', text: status?.innerText.trim().slice(0, 300) || '' };
    return null;
  });
}
async function clickSave(t, popup, label, timeout = 30000) {
  await popup.locator('#submit-btn').click();
  let seen = null;
  await t.until(async () => (seen = await popupOutcome(popup)), label, timeout);
  return seen;
}

const titleOfRow = (t, row) => row.title;
const notesOfRow = (t, row) => (t.service === 'linkding' ? row.notes : row.note);
const tagsOfRow = (t, row) => (t.service === 'linkding' ? row.tag_names : (row.tags || []).map(tag => tag.name));
// "Changed elsewhere": a second client edits title and tags through the API.
async function editElsewhere(t, row, title, addTag) {
  if (t.service === 'linkding') {
    await t.api(t.recordPath(row.id), { method: 'PATCH', body: { title, tag_names: [...row.tag_names, addTag] } });
  } else {
    await t.api(t.recordPath(row.id), { method: 'PATCH', body: { title } });
    await t.api('bookmarks/' + encodeURIComponent(row.id) + '/tags', { method: 'POST', body: { tags: [{ tagName: addTag }] } });
  }
}

// Visible text of rendered HTML as a browser lays it out, line by line, with
// each line's whitespace collapsed (what a reader of linkding's page sees).
async function renderedLines(t, html) {
  const scratch = await t.ctx.newPage();
  try {
    await scratch.setContent('<!doctype html><meta charset="utf-8"><body>' + html + '</body>');
    return await scratch.evaluate(() => {
      const tags = [...document.body.querySelectorAll('*')].map(e => e.tagName.toLowerCase());
      return { tags, text: document.body.innerText };
    });
  } finally { await scratch.close().catch(() => {}); }
}
const visibleLines = text => String(text).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);

const LONG_TAG = t => t.prefix + '_' + 'long'.repeat(6);
// Selection quote inputs (G5), each rendered on its own as its own Notes
// block, so a construct sits where Python-Markdown acts on it: a setext
// underline as the second line of a block, an ordered list or heading at a
// block's start, an indent at a block's start or after a blank line, and
// text that is already an entity; inline markup (* _ ` [ ]), a leading
// backslash and an HTML tag stay literal too. The last case is the earlier merged
// matrix, kept as an extra. The saved selection joins all of them with
// blank lines (end to end through the popup).
export const QUOTE_CASES = Object.freeze([
  '    First line indented',
  'Setext title\n===',
  'Another title\n---',
  'a & b < c',
  '1) item',
  '1. item',
  '# heading',
  'literal &lt;tag&gt; &amp; text',
  'Paragraph line\n\n    indented after blank',
  'tab\tseparated',
  '\tleading tab',
  '**bold** _em_ `code` [link](https://example.com/)',
  '\\# not a heading',
  'x <b>y</b> z',
  ['    First line indented', 'Setext title', '===', 'Another', '---', 'a & b < c', '1) item', '', '    indented after blank', 'tab\tseparated', '\tleading tab'].join('\n'),
]);
// Tags whose presence means Markdown structure leaked out of the quote.
export const QUOTE_STRUCTURE_TAGS = Object.freeze(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'ol', 'ul', 'li', 'pre', 'code']);
// What one rendered case shows against its input (pure, for the preflight
// and the offline mutation check): the visible lines must match, inside a
// blockquote, with no Markdown structure.
export function judgeRenderedQuote(input, shown) {
  const problems = [];
  if (!shown.tags.includes('blockquote')) problems.push('not_blockquote');
  const leaked = [...new Set(shown.tags.filter(tag => QUOTE_STRUCTURE_TAGS.includes(tag)))];
  if (leaked.length) problems.push('structure:' + leaked.join('+'));
  const want = visibleLines(input).join('\n'), got = visibleLines(shown.text).join('\n');
  if (want !== got) problems.push('text');
  return { ok: !problems.length, problems, want, got };
}

export const SELFHOSTED_MODULES = [
  // 1a. linkding Description written elsewhere survives every entry point
  // that saves the bookmark without touching it (G2: untouched means unsent;
  // multi-line and repeated whitespace stay as the server holds them).
  {
    id: 'sh.description-keep',
    services: ['linkding'],
    surfaces: ['popup', 'reader'],
    features: ['linkding-description', 'description-untouched-kept'],
    fixRefs: ['G2', 'G2c'],
    needs: needs(),
    budget: { bookmarks: 1, urls: 1, node: 8, browser: 40, ai: 0, tags: 1, seconds: 45, tagReads: 1 },
    files: [],
    settings: { optAutoDescription: true, batchSkipExisting: false, batchAiTags: false, batchAiSummary: false, qsAiTags: false, qsAiSummary: false, qsAutoNotes: false, qsDefaultTags: '' },
    async steps(t) {
      const { prefix } = t;
      const url = t.claimUrl();
      const description = '第一行 keep\n\n第二行  两个空格\t制表';
      await t.phase('description_seed');
      await t.seed({ url, title: prefix + ' 多行描述', description, notes: 'seed notes', tags: [prefix] });
      const kept = async code => t.expectEq((await t.ownRow(url)).description, description, code);
      await t.phase('description_popup');
      const form = await t.openPopup(url);
      await t.until(async () => (await form.popup.locator('#title-input').inputValue()) === prefix + ' 多行描述', 'description_prefill');
      await form.popup.locator('#description-input').fill('popup notes');
      await t.savePopup(form.popup);
      await kept('popup_keeps_description');
      await form.close();
      await t.phase('description_quick_save');
      const quick = await shortcutSave(t, url, 'qs');
      t.note('quickSave', quick);
      t.expect(['saved', 'skipped'].includes(quick.status), 'quick_save_status');
      await kept('quick_save_keeps_description');
      await t.phase('description_reader');
      const reader = await t.openReader(url, { ready: '#reader-bookmark-edit' });
      await reader.locator('#reader-bookmark-edit').click();
      await reader.locator('#reader-bookmark-notes').fill('reader notes');
      await t.applyReader(reader);
      await kept('reader_keeps_description');
      await reader.close();
      await t.phase('description_batch');
      const batch = await batchSave(t, [url]);
      t.note('batch', batch);
      t.expect(batch.done && !batch.failed && !batch.error, 'batch_status');
      await kept('batch_keeps_description');
      t.check('linkding: a multi-line Description set elsewhere survives popup, quick save, reader and batch saves that leave it alone');
    },
  },

  // 1b. Page information (G2b, G26): no readable page leaves Description to
  // the server, with a grey hint; "use browser metadata" off prefills
  // /check/ metadata; the pre-read switch is off by default. Each in its own
  // part. The PDF case waits on a ruling (see the part).
  {
    id: 'sh.page-info',
    services: ['linkding'],
    surfaces: ['popup'],
    features: ['linkding-no-page-info', 'linkding-empty-description-hint', 'linkding-browser-metadata', 'linkding-preload'],
    fixRefs: ['G2', 'G2b', 'G26'],
    needs: needs({ shots: true }),
    budget: { bookmarks: 4, urls: 4, node: 6, browser: 70, ai: 0, tags: 0, seconds: 90, tagReads: 1 },
    files: [],
    settings: { optAutoDescription: true, optCheckBookmarkStatus: true, optAutoCloseAfterSave: false },
    async steps(t) {
      const { prefix } = t;
      // The grey hint as a reader meets it, whatever carries it: the field's
      // placeholder, what aria-describedby names, or a visible hint next to
      // the field (decision 14: only when the page could not be read and the
      // box is empty).
      const hintOf = popup => popup.evaluate(() => {
        const field = document.getElementById('linkding-description-input');
        const visible = el => !!el && el.offsetParent !== null && el.innerText.trim();
        const described = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)).filter(visible).map(el => el.innerText.trim());
        const near = [...(field.parentElement?.children || [])].filter(el => el !== field && /hint|help|note/i.test(el.className) && visible(el)).map(el => el.innerText.trim());
        return { placeholder: (field.getAttribute('placeholder') || '').trim(), described, near, any: !!((field.getAttribute('placeholder') || '').trim() || described.length || near.length) };
      });
      // Opens the unreadable page, records the field and its hint, saves.
      const unread = async (url, mode) => {
        const form = await t.openPopup(url, { article: 'error' });
        const field = form.popup.locator('#linkding-description-input');
        const value = await field.inputValue();
        const hint = await hintOf(form.popup);
        t.note(mode + 'Hint', hint);
        if (mode === 'abort') { await t.shot(form.popup, 'no-page-info', { surface: 'popup', keys: ['#linkding-description-input', '#submit-btn'] }); await t.axe(form.popup, 'no-page-info'); }
        await form.popup.locator('#title-input').fill(prefix + ' ' + mode);
        const since = t.now();
        await t.savePopup(form.popup);
        const [create] = createsOf(t, url, since);
        const sent = create ? { description: 'description' in (create.body || {}), scrapingDisabled: /disable_scraping/.test(create.path) } : null;
        if (create && 'description' in (create.body || {})) t.note(mode + 'SentDescription', { meta: create.body.description === META_DESCRIPTION, length: String(create.body.description).length, articleUrl: form.article.url().slice(0, 120) });
        t.note(mode + 'ServerDescription', (await t.ownRow(url)).description ? 'filled' : 'empty');
        await form.close();
        return { value, hint, sent };
      };
      let aborted = null, abortUrl = '';

      await t.part('unreadable_abort', ['G2b'], async () => {
        await t.phase('page_info_abort');
        abortUrl = t.claimUrl();
        t.inject({ on: 'page', path: abortUrl, abort: 'connectionrefused' });
        aborted = await unread(abortUrl, 'abort');
        t.expectEq(aborted.value, '', 'abort_description_empty');
        t.expect(!!aborted.sent, 'abort_create_sent');
        t.expect(!aborted.sent.description, 'abort_description_sent');
        t.expect(!aborted.sent.scrapingDisabled, 'abort_scraping_disabled');
      }, ['linkding-no-page-info']);
      await t.part('empty_hint', ['G26'], async () => {
        t.expect(!!aborted, 'abort_case_missing');
        t.expect(aborted.hint.any, 'abort_empty_hint');
      }, ['linkding-empty-description-hint']);

      await t.part('server_metadata', ['G26'], async () => {
        await t.phase('page_info_server_metadata');
        const metaKey = await t.productSetting(/linkding.*(browser|metadata)|browser.*meta/, 'linkding_browser_metadata');
        t.expectEq(await t.sw(key => SETTINGS_DEFAULTS[key], metaKey), true, 'browser_metadata_default');
        await t.settings({ [metaKey]: false });
        const meta = t.claimUrl();
        page(t, meta, articleHtml({ title: 'Browser-only title', description: 'Browser-only description.' }));
        const server = (await t.api('bookmarks/check/?url=' + encodeURIComponent(meta))).metadata || {};
        const form = await t.openPopup(meta);
        t.expectEq(await form.popup.locator('#title-input').inputValue(), server.title || '', 'server_metadata_title');
        t.expectEq(await form.popup.locator('#linkding-description-input').inputValue(), server.description || '', 'server_metadata_description');
        const since = t.now();
        await t.savePopup(form.popup);
        const [metaCreate] = createsOf(t, meta, since);
        t.expect(!!metaCreate && /disable_scraping/.test(metaCreate.path), 'server_metadata_disable_scraping');
        await form.close();
      }, ['linkding-browser-metadata']);

      // Pre-read off (the default): neither loading a page nor switching to
      // it asks /check/; on, switching tabs does and the icon follows.
      await t.part('preload', ['G26'], async () => {
        await t.phase('page_info_preload');
        const preloadKey = await t.productSetting(/linkding.*(preload|prefetch|preread|whilebrows|browsing)|(preload|prefetch).*page/, 'linkding_preload');
        t.expectEq(await t.sw(key => SETTINGS_DEFAULTS[key], preloadKey), false, 'preload_default');
        const seeded = t.claimUrl();
        await t.seed({ url: seeded, title: prefix + ' preload', notes: '' });
        let since = t.now();
        const first = await t.ctx.newPage();
        await first.goto(seeded).catch(() => {});
        const second = await t.ctx.newPage();
        await second.goto(abortUrl || seeded).catch(() => {});
        await t.activateTab(seeded);
        await t.activateTab(abortUrl || seeded);
        await t.sleep(1500);
        t.expectEq(t.requests({ path: CHECK_PATH.linkding, since }).length, 0, 'preload_off_checks');
        await t.settings({ [preloadKey]: true });
        since = t.now();
        await t.activateTab(seeded);
        await t.until(async () => t.requests({ path: CHECK_PATH.linkding, since }).length > 0, 'preload_on_checks', 8000);
        const icon = await t.sw(async url => { const tab = (await chrome.tabs.query({})).find(x => x.url === url); return tab ? _lastIconState.get(tab.id) || '' : 'no_tab'; }, seeded);
        t.expectEq(icon, 'saved', 'preload_icon_saved');
        await first.close();
        await second.close();
      }, ['linkding-preload']);

      // A PDF served for the URL. Chrome's PDF viewer page can still be
      // scripted, so the product may read it as a page: whether that counts
      // as "no page info" is the user's ruling (H3b open question). The
      // expectations are recorded as pending, not failed; last, so they
      // hold nothing up.
      await t.part('unreadable_pdf', ['G2b', 'G26'], async () => {
        await t.phase('page_info_pdf');
        const pdf = t.claimUrl();
        t.inject({ on: 'page', path: pdf, status: 200, contentType: 'application/pdf', body: '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n' });
        const r = await unread(pdf, 'pdf');
        const question = 'PDF 页（Chrome PDF 查看器可被脚本读取）是否按「读不到网页」处理';
        t.pending(r.value, '', 'pdf_description_empty', question);
        t.pending(!!r.sent && !r.sent.description && !r.sent.scrapingDisabled, true, 'pdf_left_to_server', question);
        t.pending(r.hint.any, true, 'pdf_empty_hint', question);
      });
      t.check('linkding: an unreadable page (aborted) leaves Description empty and unsent with a hint; server metadata prefill with disable_scraping when browser metadata is off; pre-read off by default (no /check/ on load or switch) and on when asked; the PDF case is recorded for a ruling');
    },
  },

  // 1c. SingleFile (decision 3c): only a popup or quick-save create of a new
  // linkding bookmark carries disable_html_snapshot and asks SingleFile;
  // batch, the reader and offline replay do not. Not installed here: a
  // non-blocking notice in the popup and a console.warn. Temp only: the
  // marker is in the extension's request; the user's instance adds nothing.
  {
    id: 'sh.singlefile',
    services: ['linkding'],
    surfaces: ['popup', 'reader'],
    features: ['linkding-singlefile', 'singlefile-paths', 'singlefile-missing-notice'],
    fixRefs: ['G26'],
    needs: needs({ target: 'temp', shots: true }),
    budget: { bookmarks: 5, urls: 5, node: 4, browser: 70, ai: 0, tags: 0, seconds: 90, tagReads: 1 },
    files: [],
    settings: { optAutoDescription: true, optAutoCloseAfterSave: false, offlineQueueEnabled: true, qsAiTags: false, qsAiSummary: false, batchAiTags: false, batchAiSummary: false, batchSkipExisting: false },
    async steps(t) {
      const marked = r => /disable_html_snapshot/.test(r.path + JSON.stringify(r.body || {}));
      const createOf = async (url, since, label) => {
        await t.until(async () => createsOf(t, url, since).length > 0, label, 15000);
        return createsOf(t, url, since)[0];
      };
      await t.phase('singlefile_setting');
      const singleKey = await t.productSetting(/singlefile/, 'singlefile');
      t.expectEq(await t.sw(key => SETTINGS_DEFAULTS[key], singleKey), false, 'singlefile_default');
      await t.settings({ [singleKey]: true });

      await t.part('popup', ['G26'], async () => {
        await t.phase('singlefile_popup');
        const url = t.claimUrl();
        const form = await t.openPopup(url);
        const mark = t.consoleMark(), since = t.now();
        await t.savePopup(form.popup);
        t.expect(marked(await createOf(url, since, 'singlefile_popup_create')), 'singlefile_popup_marker');
        await t.until(async () => t.consoleSince(mark).some(c => c.type === 'warning' && /singlefile/i.test(c.text)), 'singlefile_warn', 8000);
        // Non-blocking: saved, and the popup says SingleFile did not answer.
        const notice = await form.popup.evaluate(() => [...document.querySelectorAll('#status-msg, .feedback-card, [role="status"], [role="alert"]')].filter(el => el.offsetParent !== null).map(el => el.innerText.trim()).filter(Boolean).join(' | ').slice(0, 300));
        t.note('singlefileNotice', notice);
        t.expect(/singlefile/i.test(notice), 'singlefile_notice');
        t.expect(await form.popup.locator('#submit-btn.saved-success').count() === 1, 'singlefile_blocked_save');
        await t.shot(form.popup, 'singlefile-missing', { surface: 'popup', keys: ['#submit-btn'] });
        await t.axe(form.popup, 'singlefile-missing');
        await form.close();
      }, ['linkding-singlefile', 'singlefile-missing-notice']);
      await t.part('quick_save', ['G26'], async () => {
        await t.phase('singlefile_quick_save');
        const url = t.claimUrl(), since = t.now();
        const r = await shortcutSave(t, url, 'qs');
        t.note('quickSave', r);
        t.expect(marked(await createOf(url, since, 'singlefile_quick_create')), 'singlefile_quick_marker');
      }, ['linkding-singlefile', 'singlefile-paths']);
      await t.part('not_batch_reader_replay', ['G26'], async () => {
        await t.phase('singlefile_batch');
        const batchUrl = t.claimUrl();
        let since = t.now();
        await batchSave(t, [batchUrl]);
        t.expect(!marked(await createOf(batchUrl, since, 'singlefile_batch_create')), 'singlefile_batch_marker');
        await t.phase('singlefile_reader');
        const readerUrl = t.claimUrl();
        since = t.now();
        const reader = await t.openReader(readerUrl, { ready: '#reader-bookmark-save' });
        await reader.locator('#reader-bookmark-save').click();
        t.expect(!marked(await createOf(readerUrl, since, 'singlefile_reader_create')), 'singlefile_reader_marker');
        await reader.close();
        await t.phase('singlefile_replay');
        const replayUrl = t.claimUrl();
        await t.offline('self');
        const queued = await shortcutSave(t, replayUrl, 'qs');
        await t.offline('');
        t.expectEq(queued.status, 'queued', 'singlefile_replay_queued');
        since = t.now();
        await drainQueue(t);
        t.expect(!marked(await createOf(replayUrl, since, 'singlefile_replay_create')), 'singlefile_replay_marker');
      }, ['singlefile-paths']);
      t.check('linkding: with SingleFile on, popup and quick-save creates carry disable_html_snapshot, the popup saves and says SingleFile did not answer (console.warn too); batch, reader and offline replay creates do not');
    },
  },

  // 2. linkding AI summary in Description (G24, decision 4), fake AI.
  {
    id: 'sh.ai-description',
    services: ['linkding'],
    surfaces: ['popup'],
    features: ['fake-ai', 'ai-summary-description-rules', 'ai-summary-remove-restores'],
    fixRefs: ['G24'],
    needs: needs({ fakeAi: true, shots: true }),
    budget: { bookmarks: 2, urls: 2, node: 6, browser: 40, ai: 7, tags: 0, seconds: 90, tagReads: 1 },
    files: [],
    settings: { optShowAiSummary: true, optShowAiTags: false, optAutoDescription: true, aiCacheDuration: 0 },
    async steps(t) {
      const { prefix } = t;
      // The popup asks for a summary alone or, when it can, for summary and
      // tags in one call: both answer with the latest text, and the calls
      // of both kinds are counted.
      let n = 0, latest = '';
      const next = () => {
        latest = `${t.fakeAi.marker} summary ${++n}: one synthetic sentence.`;
        t.fakeAi.expect({ kind: 'summary', reply: () => latest });
        t.fakeAi.expect({ kind: 'combined', reply: () => JSON.stringify({ summary: latest, tags: [] }) });
        return latest;
      };
      const paid = () => t.fakeAi.calls('summary') + t.fakeAi.calls('combined');
      const before = paid();
      const field = popup => popup.locator('#linkding-description-input');
      const summarize = async (popup, expected, code) => {
        await popup.locator('#ai-summary-btn').click();
        try { await t.until(async () => (await field(popup).inputValue()).includes(expected), code, 15000); } catch (error) {
          t.note(code, { field: (await field(popup).inputValue()).slice(0, 160), notes: (await popup.locator('#description-input').inputValue()).slice(0, 160), status: (await popup.locator('#status-msg').innerText()).slice(0, 160) });
          throw error;
        }
      };
      const action = (popup, name) => popup.locator(`.cache-hint-wrap .regen-link[data-action="${name}"]`);
      const kept = t.message('aiSummaryKeptDescription');
      // "Another paragraph" after the user's words (decision 4). The box is
      // a single-line input, which drops line breaks: how the paragraph
      // shows is the user's ruling, so the exact two-newline join is
      // pending; the order, the kept words and the summary are not.
      const SPLIT = 'Description 控件形态与「另起一段」的写法（单行 input 会剥掉换行）';
      const appended = (value, head, summary, code) => {
        t.expect(value.startsWith(head) && value.endsWith(summary) && value.length > head.length + summary.length, code);
        t.pending(value, head + '\n\n' + summary, code + '_paragraph', SPLIT);
      };
      const url = t.claimUrl();
      const form = await t.openPopup(url);
      const { popup } = form;

      await t.part('replace_meta_or_empty', ['G24'], async () => {
        await t.phase('ai_description_meta');
        t.expectEq(await field(popup).inputValue(), META_DESCRIPTION, 'meta_prefill');
        let s = next();
        await summarize(popup, s, 'meta_summary');
        t.expectEq(await field(popup).inputValue(), s, 'meta_replaced');
        await action(popup, 'remove').click();
        t.expectEq(await field(popup).inputValue(), META_DESCRIPTION, 'remove_restores_meta');
        await t.phase('ai_description_empty');
        await field(popup).fill('');
        s = next();
        await summarize(popup, s, 'empty_summary');
        t.expectEq(await field(popup).inputValue(), s, 'empty_replaced');
        await action(popup, 'remove').click();
        t.expectEq(await field(popup).inputValue(), '', 'remove_restores_empty');
      }, ['ai-summary-description-rules', 'ai-summary-remove-restores']);

      await t.part('append_after_user_text', ['G24'], async () => {
        await t.phase('ai_description_user_text');
        const own = 'My own words.';
        await field(popup).fill(own);
        let s = next();
        await summarize(popup, s, 'user_summary');
        appended(await field(popup).inputValue(), own, s, 'user_text_appended');
        const old = s;
        s = next();
        await action(popup, 'regenerate').click();
        await t.until(async () => (await field(popup).inputValue()).includes(s), 'user_regenerated');
        const regenerated = await field(popup).inputValue();
        appended(regenerated, own, s, 'regenerate_replaces_ai_part');
        t.expect(!regenerated.includes(old), 'regenerate_kept_old_summary');
        await t.shot(popup, 'ai-appended', { surface: 'popup', keys: ['#linkding-description-input', '#submit-btn'] });
        await t.axe(popup, 'ai-appended');
        await action(popup, 'remove').click();
        t.expectEq(await field(popup).inputValue(), own, 'remove_restores_user_text');
        s = next();
        await summarize(popup, s, 'user_summary_again');
        const shown = await field(popup).inputValue();
        await popup.locator('#title-input').fill(prefix + ' ai description');
        await t.savePopup(popup);
        t.expectEq((await t.ownRow(url)).description, shown, 'saved_as_shown');
      }, ['ai-summary-description-rules', 'ai-summary-remove-restores']);
      await form.close();

      await t.part('append_after_server_text', ['G24'], async () => {
        await t.phase('ai_description_server_text');
        const seeded = t.claimUrl();
        await t.seed({ url: seeded, title: prefix + ' server description', description: 'Server words.', notes: '' });
        const again = await t.openPopup(seeded);
        await t.until(async () => (await field(again.popup).inputValue()) === 'Server words.', 'server_prefill');
        const s = next();
        await summarize(again.popup, s, 'server_summary');
        const shown = await field(again.popup).inputValue();
        appended(shown, 'Server words.', s, 'server_text_appended');
        if (kept) t.expect(!(await again.popup.locator('#status-msg').innerText()).includes(kept), 'paid_but_kept');
        await t.savePopup(again.popup);
        t.expectEq((await t.ownRow(seeded)).description, shown, 'server_text_saved');
        await again.close();
      }, ['ai-summary-description-rules']);
      // Every paid call wrote what it produced: no "generated, then kept".
      t.expectEq(paid() - before, n, 'summary_calls_match_writes');
      t.expect(t.fakeAi.unknown() === 0, 'fake_ai_unknown_request');
      t.check('linkding: AI summary replaces an empty or page-meta Description, follows the user\'s or server\'s words, regenerates only its own part, and Remove restores the earlier value; no paid summary is discarded; the paragraph join waits for a ruling');
    },
  },

  // 3. Selection quote escaping (G5): what linkding renders equals the
  // selection; Karakeep's note is plain text.
  {
    id: 'sh.quote-escape',
    services: ['linkding', 'karakeep'],
    surfaces: ['popup'],
    features: ['selection-quote-escape-matrix', 'karakeep-note-plain'],
    fixRefs: ['G5'],
    // Temp only (user-target rounds): the escaping is the extension's and
    // the rendering the replica's; the user's instance adds nothing to it.
    needs: needs({ target: 'temp', ldRender: true }),
    budget: { bookmarks: 1, urls: 1, node: 4, browser: { linkding: 20, karakeep: 30 }, ai: 0, tags: 0, seconds: 45, tagReads: 1 },
    files: [],
    settings: { optBlockquote: true, optAutoDescription: true },
    async steps(t) {
      const url = t.claimUrl();
      const quote = QUOTE_CASES.join('\n\n');
      page(t, url, articleHtml({ quote }));
      await t.phase('quote_popup');
      const form = await t.openPopup(url, { selection: true });
      // Each case as the product quotes it, from the page that saved it.
      const quoted = t.service === 'linkding' ? await form.popup.evaluate(cases => cases.map(text => pbpFormatQuote(text, 'linkding')), [...QUOTE_CASES]) : [];
      await form.popup.locator('#title-input').fill(t.prefix + ' quote matrix');
      await t.savePopup(form.popup);
      await form.close();
      const row = await t.ownRow(url);
      const notes = notesOfRow(t, row);
      if (t.service === 'karakeep') {
        // Plain text: no markup, and no escaping of the raw & and < (the
        // literal-entity case is meant to read "&lt;tag&gt;").
        t.expect(!notes.includes('<blockquote') && !notes.includes('a &amp; b') && !notes.includes('b &lt; c') && !notes.includes('&amp;lt;'), 'karakeep_note_markup');
        const lines = visibleLines(notes);
        t.expect(visibleLines(quote).every(line => lines.some(l => l.includes(line))), 'karakeep_note_text');
      } else {
        await t.phase('quote_render');
        // Every case on its own, then the saved Notes (the whole selection).
        const html = await t.renderNotes([...quoted, notes]);
        const verdicts = [];
        for (let i = 0; i < html.length; i++) {
          const input = i < QUOTE_CASES.length ? QUOTE_CASES[i] : quote;
          const verdict = judgeRenderedQuote(input, await renderedLines(t, html[i]));
          if (!verdict.ok) verdicts.push({ case: i < QUOTE_CASES.length ? i : 'saved', problems: verdict.problems, want: verdict.want.slice(0, 80), got: verdict.got.slice(0, 80) });
        }
        t.note('renderFailures', verdicts);
        t.expectEq(verdicts.map(v => v.case + ':' + v.problems.join('+')).join(' '), '', 'quote_rendered_cases');
      }
      t.check(`${t.service}: each selection case (setext ===/---, 1) and 1. items, # heading, literal entities, &, <, inline emphasis, code and link markup, a leading backslash, an HTML tag, indents, tabs) and the whole selection read back as written`);
    },
  },

  // 4. Over-long tags (G3, G4b): Postgres answers 500 and the save is
  // tag_too_long, not queued, not replayed.
  {
    id: 'sh.long-tag-pg',
    services: ['linkding'],
    surfaces: ['popup'],
    features: ['linkding-long-tag-500', 'linkding-long-tag-not-queued', 'queue-long-tag-needs-attention'],
    fixRefs: ['G3', 'G4b', 'G17'],
    needs: needs({ target: 'temp', container: 'linkding-pg', shots: true, longTag: 'server' }),
    // The queued replay's 500 may leave an untagged bookmark (G3) and holds
    // a slot: one more bookmark and URL.
    budget: { bookmarks: 4, urls: 4, node: 4, browser: 45, ai: 0, tags: 1, seconds: 75, tagReads: 1 },
    files: [],
    settings: { offlineQueueEnabled: true, qsAiTags: false, qsAiSummary: false },
    async steps(t) {
      const long = LONG_TAG(t);
      await t.phase('long_tag_pg_popup');
      const url = t.claimUrl();
      const form = await t.openPopup(url);
      await form.popup.locator('#title-input').fill(t.prefix + ' long tag pg');
      await form.popup.locator('#tags-input').fill(long);
      await form.popup.locator('#tags-input').press('Enter');
      const seen = await clickSave(t, form.popup, 'long_tag_outcome');
      t.note('popupOutcome', seen);
      t.expect(seen.outcome !== 'saved' && seen.outcome !== 'queued', 'long_tag_outcome');
      t.expectEq((await queue(t)).length, 0, 'long_tag_queued');
      await t.shot(form.popup, 'long-tag-pg', { surface: 'popup', keys: ['#submit-btn'] });
      const settled = await t.writes();
      await t.sleep(5000);
      t.expectEq(await t.writes(), settled, 'long_tag_retry_loop');
      await form.close();
      await t.phase('long_tag_pg_quick_save');
      await t.settings({ qsDefaultTags: long });
      const quickUrl = t.claimUrl();
      const quick = await shortcutSave(t, quickUrl, 'qs');
      t.note('quickSave', quick);
      t.expect(quick.status === 'failed' && quick.reason === 'tag_too_long', 'quick_save_tag_too_long');
      t.expectEq((await queue(t)).length, 0, 'quick_save_queued');

      // A queued save with the tag (taken offline, so it was never judged):
      // its replay meets the real 500 and the item is set aside as needing
      // attention for tag_too_long (G17 takes in G3's code); another replay
      // sends nothing.
      await t.part('queued_long_tag', ['G3', 'G17'], async () => {
        await t.phase('long_tag_pg_queued');
        const queuedUrl = t.claimUrl();
        await t.offline('self');
        const offline = await shortcutSave(t, queuedUrl, 'qs');
        await t.offline('');
        t.expectEq(offline.status, 'queued', 'queued_long_tag_offline');
        const since = t.now();
        await drainQueue(t);
        t.expect(createsOf(t, queuedUrl, since).length >= 1, 'queued_long_tag_replayed');
        const item = (await queue(t)).find(i => i.url === queuedUrl);
        t.note('queuedLongTag', item?.failure || null);
        t.expect(!!item, 'queued_long_tag_dropped');
        t.expectEq(item.failure?.code, 'tag_too_long', 'queued_long_tag_marker');
        const again = t.now();
        await drainQueue(t);
        await drainQueue(t);
        t.expectEq(writesSince(t, again).length, 0, 'queued_long_tag_retried');
      }, ['queue-long-tag-needs-attention']);
      t.check('linkding-pg: an over-long tag is tag_too_long in the popup and quick save, never queued or replayed; a queued one needs attention after its replay');
    },
  },
  // On any target: every write that carries the over-long tag is answered
  // by an injected 500 or 502, so the tag never reaches the service (a user
  // instance's database is not known; PostgreSQL would answer a real 500 and
  // may keep an untagged bookmark outside the ledger).
  {
    id: 'sh.long-tag-inject',
    services: ['linkding'],
    surfaces: ['popup'],
    features: ['linkding-long-tag-500-injected', 'linkding-502-queued'],
    fixRefs: ['G3', 'G4b'],
    needs: needs({ longTag: 'injected' }),
    // Injected 5xx creates keep a worker-guard slot each (the creation may
    // exist): the 500, the 502 and its replay.
    budget: { bookmarks: 3, urls: 3, node: 4, browser: 40, ai: 0, tags: 1, seconds: 45, tagReads: 1 },
    files: [],
    settings: { offlineQueueEnabled: true },
    async steps(t) {
      const long = LONG_TAG(t);
      const createPath = /^bookmarks\/(\?|$)/;
      const fill = async (popup, title) => {
        await popup.locator('#title-input').fill(t.prefix + ' ' + title);
        await popup.locator('#tags-input').fill(long);
        await popup.locator('#tags-input').press('Enter');
      };
      await t.phase('long_tag_injected_500');
      const failed = t.claimUrl();
      const fault500 = t.inject({ method: 'POST', path: createPath, status: 500, contentType: 'text/html', body: '<h1>Server Error (500)</h1>' });
      let form = await t.openPopup(failed);
      await fill(form.popup, 'long tag 500');
      const seen = await clickSave(t, form.popup, 'long_tag_500_outcome');
      t.note('popup500', seen);
      t.expect(fault500.hits() >= 1, 'injected_500_sent');
      t.expect(seen.outcome !== 'saved' && seen.outcome !== 'queued', 'injected_500_outcome');
      t.expectEq((await queue(t)).length, 0, 'injected_500_queued');
      const settled = await t.writes();
      await t.sleep(4000);
      t.expectEq(await t.writes(), settled, 'injected_500_retry_loop');
      fault500.clear();
      await form.close();

      await t.phase('long_tag_injected_502');
      // A 502 is the proxy's, not the tag's: queued as a server failure. The
      // replay meets the same 502 (never the service): still queued, sent
      // with the tag, and not set aside as needing attention.
      const proxied = t.claimUrl();
      const fault502 = t.inject({ method: 'POST', path: createPath, status: 502, contentType: 'text/html', body: '<h1>502 Bad Gateway</h1>' });
      form = await t.openPopup(proxied);
      await fill(form.popup, 'long tag 502');
      const proxiedSeen = await clickSave(t, form.popup, 'long_tag_502_outcome');
      t.note('popup502', proxiedSeen);
      t.expectEq(fault502.hits(), 1, 'injected_502_sent');
      let q = await queue(t);
      t.expect(q.length === 1 && q[0].url === proxied, 'injected_502_queued');
      await form.close();
      const replaySince = t.now();
      await drainQueue(t);
      const replays = createsOf(t, proxied, replaySince);
      t.expect(fault502.hits() === 2 && replays.length === 1, 'injected_502_replay_sent');
      t.expect((replays[0].body?.tag_names || []).includes(long), 'injected_502_replay_tag');
      q = await queue(t);
      t.expect(q.length === 1 && q[0].url === proxied && !q[0].failure, 'injected_502_still_queued');
      fault502.clear();
      await t.sw(async url => { const { offlineQueue = [] } = await chrome.storage.local.get('offlineQueue'); await chrome.storage.local.set({ offlineQueue: offlineQueue.filter(i => i.url !== url) }); }, proxied);
      t.check('linkding: an injected 500 with an over-long tag is tag_too_long and not queued; an injected 502 is a server failure, queued and replayed with the tag; the tag never reached the service');
    },
  },
  // Temporary SQLite linkding only: the over-long tag reaches the service.
  {
    id: 'sh.long-tag-sqlite',
    services: ['linkding'],
    surfaces: ['popup'],
    features: ['linkding-long-tag-sqlite', 'linkding-502-replayed'],
    fixRefs: ['G3', 'G4b'],
    // Temp only: SQLite stores the tag, and the replay after a 502 is real.
    needs: needs({ target: 'temp', longTag: 'server' }),
    budget: { bookmarks: 3, urls: 3, node: 5, browser: 40, ai: 0, tags: 1, seconds: 45, tagReads: 1 },
    files: [],
    settings: { offlineQueueEnabled: true },
    async steps(t) {
      const long = LONG_TAG(t);
      const fill = async (popup, title) => {
        await popup.locator('#title-input').fill(t.prefix + ' ' + title);
        await popup.locator('#tags-input').fill(long);
        await popup.locator('#tags-input').press('Enter');
      };
      await t.phase('long_tag_sqlite');
      const plain = t.claimUrl();
      let form = await t.openPopup(plain);
      await fill(form.popup, 'long tag sqlite');
      await t.savePopup(form.popup);
      t.expect(tagsOfRow(t, await t.ownRow(plain)).map(n => n.toLowerCase()).includes(long.toLowerCase()), 'sqlite_long_tag_saved');
      await form.close();

      await t.phase('long_tag_502_replayed');
      const proxied = t.claimUrl();
      const fault502 = t.inject({ method: 'POST', path: /^bookmarks\/(\?|$)/, status: 502, contentType: 'text/html', body: '<h1>502 Bad Gateway</h1>', times: 1 });
      form = await t.openPopup(proxied);
      await fill(form.popup, 'long tag 502');
      const proxiedSeen = await clickSave(t, form.popup, 'long_tag_502_outcome');
      t.note('popup502', proxiedSeen);
      t.expectEq(fault502.hits(), 1, 'injected_502_sent');
      const q = await queue(t);
      t.expect(q.length === 1 && q[0].url === proxied, 'injected_502_queued');
      await form.close();
      await drainQueue(t);
      t.expectEq((await queue(t)).length, 0, 'injected_502_replayed');
      t.expect(tagsOfRow(t, await t.ownRow(proxied)).length === 1, 'injected_502_replay_tag');
      t.check('linkding (temporary SQLite): an over-long tag is stored; after an injected 502 the queued save replays with it');
    },
  },

  // 5. Changed elsewhere (G25, decision 1): an update compares the
  // server's modification time with the one the form loaded.
  {
    id: 'sh.changed-elsewhere',
    services: ['linkding', 'karakeep'],
    surfaces: ['popup', 'reader'],
    features: ['update-checks-modified', 'changed-elsewhere-notice'],
    fixRefs: ['G25'],
    needs: needs({ shots: true }),
    budget: { bookmarks: 1, urls: 1, node: 12, browser: { linkding: 45, karakeep: 70 }, ai: 0, tags: 3, seconds: 45, tagReads: 1 },
    files: [],
    settings: {},
    async steps(t) {
      const { prefix } = t;
      const url = t.claimUrl();
      await t.phase('elsewhere_create');
      let form = await t.openPopup(url);
      await form.popup.locator('#title-input').fill(prefix + ' A');
      await form.popup.locator('#description-input').fill('n1');
      await form.popup.locator('#tags-input').fill(prefix);
      await form.popup.locator('#tags-input').press('Enter');
      await t.savePopup(form.popup);
      await form.close();
      await t.sleep(1100);
      await editElsewhere(t, await t.ownRow(url), prefix + ' B', prefix + '_else');

      await t.phase('elsewhere_popup');
      form = await t.openPopup(url);
      await form.popup.locator('#description-input').fill('n2');
      const since = t.now();
      const seen = await clickSave(t, form.popup, 'elsewhere_outcome');
      t.note('popupOutcome', seen);
      t.expect(seen.outcome !== 'saved', 'elsewhere_saved_over');
      t.expectEq(writesSince(t, since).length, 0, 'elsewhere_write_sent');
      await t.until(async () => (await form.popup.locator('#title-input').inputValue()) === prefix + ' B', 'elsewhere_latest_shown', 8000);
      t.expectEq(await form.popup.locator('#description-input').inputValue(), 'n2', 'elsewhere_user_edit_kept');
      await t.shot(form.popup, 'changed-elsewhere', { surface: 'popup', keys: ['#submit-btn'] });
      await t.axe(form.popup, 'changed-elsewhere');
      let row = await t.ownRow(url);
      t.expectEq(titleOfRow(t, row), prefix + ' B', 'elsewhere_title_reverted');
      t.expect(tagsOfRow(t, row).includes(prefix + '_else'), 'elsewhere_tag_reverted');
      await t.savePopup(form.popup);
      row = await t.ownRow(url);
      t.expect(notesOfRow(t, row) === 'n2' && titleOfRow(t, row) === prefix + ' B' && tagsOfRow(t, row).includes(prefix + '_else'), 'elsewhere_second_save');
      await form.close();

      await t.phase('elsewhere_reader');
      const reader = await t.openReader(url, { ready: '#reader-bookmark-edit' });
      await reader.locator('#reader-bookmark-edit').click();
      await t.sleep(1100);
      await editElsewhere(t, await t.ownRow(url), prefix + ' C', prefix + '_else2');
      await reader.locator('#reader-bookmark-notes').fill('n3');
      const readerSince = t.now();
      await reader.locator('#reader-bookmark-apply').click();
      await t.until(async () => reader.evaluate(() => {
        const s = document.getElementById('reader-bookmark-editor-status');
        return !!(s && s.textContent.trim()) || !document.getElementById('reader-bookmark-editor').matches(':popover-open');
      }), 'reader_elsewhere_outcome');
      await t.sleep(1000);
      t.expectEq(writesSince(t, readerSince).length, 0, 'reader_elsewhere_write_sent');
      t.expectEq(await reader.locator('#reader-bookmark-title').inputValue(), prefix + ' C', 'reader_latest_shown');
      row = await t.ownRow(url);
      t.expect(titleOfRow(t, row) === prefix + ' C' && tagsOfRow(t, row).includes(prefix + '_else2'), 'reader_elsewhere_reverted');
      await t.applyReader(reader);
      row = await t.ownRow(url);
      t.expect(notesOfRow(t, row) === 'n3' && titleOfRow(t, row) === prefix + ' C', 'reader_second_apply');
      await reader.close();
      t.check(`${t.service}: popup and reader updates stop when the bookmark changed elsewhere, show the latest, keep the user's edit and save on the second try`);
    },
  },

  // 6. Duplicate check failing (G12, G13; decisions 5, 5a).
  {
    id: 'sh.lookup-failure',
    services: ['linkding', 'karakeep'],
    surfaces: ['popup'],
    features: ['lookup-failure-popup-stops', 'lookup-failure-queued', 'replay-checks-first'],
    fixRefs: ['G12', 'G13'],
    needs: needs({ shots: true }),
    budget: { bookmarks: 2, urls: 3, node: 6, browser: { linkding: 50, karakeep: 70 }, ai: 0, tags: 0, seconds: 45, tagReads: 1 },
    files: [],
    settings: { offlineQueueEnabled: true, qsAiTags: false, qsAiSummary: false, batchAiTags: false, batchAiSummary: false, batchSkipExisting: false },
    async steps(t) {
      const fault = () => t.inject({ method: 'GET', path: CHECK_PATH[t.service], status: 503, contentType: 'application/json', body: { detail: 'unavailable' } });
      await t.phase('lookup_failure_popup');
      const url = t.claimUrl();
      let f = fault();
      const form = await t.openPopup(url, { settle: false });
      await form.popup.locator('#title-input').fill(t.prefix + ' lookup failed');
      await form.popup.locator('#description-input').fill('kept notes');
      const since = t.now();
      const seen = await clickSave(t, form.popup, 'lookup_failure_outcome');
      t.note('popupOutcome', seen);
      t.expect(seen.outcome !== 'saved' && seen.outcome !== 'queued', 'lookup_failure_saved');
      t.expectEq(writesSince(t, since).length, 0, 'lookup_failure_write_sent');
      t.expectEq(await form.popup.locator('#description-input').inputValue(), 'kept notes', 'lookup_failure_form_kept');
      t.expect(!await form.popup.locator('#submit-btn').isDisabled(), 'lookup_failure_submit_disabled');
      await t.shot(form.popup, 'lookup-failed', { surface: 'popup', keys: ['#submit-btn'] });
      await form.close();

      await t.phase('lookup_failure_quick_batch');
      const quickUrl = t.claimUrl(), batchUrl = t.claimUrl();
      const quick = await shortcutSave(t, quickUrl, 'qs');
      t.note('quickSave', quick);
      t.expectEq(quick.status, 'queued', 'quick_save_queued');
      const batch = await batchSave(t, [batchUrl]);
      t.note('batch', batch);
      let q = await queue(t);
      t.expect(q.some(i => i.url === quickUrl) && q.some(i => i.url === batchUrl), 'lookup_failure_queue');
      t.expectEq(createsOf(t, '', since).length, 0, 'lookup_failure_create_sent');
      await t.phase('lookup_failure_replay');
      const replaySince = t.now();
      await drainQueue(t);
      t.expectEq(writesSince(t, replaySince).length, 0, 'replay_without_check');
      t.expect((await queue(t)).length === 2, 'replay_dropped');
      f.clear();
      await drainQueue(t);
      q = await queue(t);
      t.expectEq(q.length, 0, 'replay_after_check');
      await t.ownRow(quickUrl);
      await t.ownRow(batchUrl);
      t.check(`${t.service}: a failing duplicate check stops the popup save with the form kept; quick save and batch queue, and replay checks before it saves`);
    },
  },

  // 7. Offline queue: deterministic failures need attention (G17, decision 2).
  {
    id: 'sh.offline-attention',
    services: ['linkding', 'karakeep'],
    surfaces: ['popup'],
    features: ['queue-needs-attention', 'queue-retry-after', 'queue-legacy-record'],
    fixRefs: ['G8', 'G13', 'G17'],
    needs: needs({ shots: true }),
    budget: { bookmarks: 2, urls: 4, node: 6, browser: { linkding: 70, karakeep: 90 }, ai: 0, tags: 0, seconds: 60, tagReads: 1 },
    files: [],
    settings: { offlineQueueEnabled: true, qsAiTags: false, qsAiSummary: false, qsDefaultTags: '' },
    async steps(t) {
      const FIELDS = new Set(['account', 'mode', 'url', 'title', 'notes', 'summary', 'tags', 'private', 'sharedExplicit', 'toread', 'archive', 'time', 'queuedAt', 'queueId', 'failure']);
      const createPath = t.service === 'linkding' ? /^bookmarks\/(\?|$)/ : /^bookmarks(\?|$)/;
      const queueOffline = async url => {
        await t.offline('self');
        const r = await shortcutSave(t, url, 'qs');
        await t.offline('');
        t.expectEq(r.status, 'queued', 'offline_queue');
        return (await queue(t)).find(i => i.url === url);
      };
      const marked = async (url, code) => {
        const item = (await queue(t)).find(i => i.url === url);
        t.expect(!!item, code + '_dropped');
        t.note(code, item.failure || null);
        t.expect(Object.keys(item).every(k => FIELDS.has(k)), code + '_fields');
        t.expect(item.failure && typeof item.failure === 'object' && typeof item.failure.code === 'string', code + '_marker');
        const since = t.now();
        await drainQueue(t);
        await drainQueue(t);
        t.expectEq(writesSince(t, since).length, 0, code + '_retried');
        return item;
      };
      const drop = url => t.sw(async url => { const { offlineQueue = [] } = await chrome.storage.local.get('offlineQueue'); await chrome.storage.local.set({ offlineQueue: offlineQueue.filter(i => i.url !== url) }); await chrome.storage.local.remove('offlineQueuePause'); }, url);

      // Parts, each with its own fix groups, so a pending group does not
      // hide the checks behind it. Each later part works without what an
      // earlier failed one left (its settings, queue and faults are put
      // back); the legacy record copies the first queued item, so it fails
      // as legacy_base_missing when there is none.
      let first = null, rejected = '', revoked = '';
      await t.part('attention_rejected', ['G13', 'G17'], async () => {
        await t.phase('attention_rejected');
        rejected = t.claimUrl();
        first = await queueOffline(rejected);
        const reject = t.inject({ method: 'POST', path: createPath, status: 400, body: t.service === 'linkding' ? { url: ['Enter a valid URL.'] } : { code: 'BAD_REQUEST', message: 'Invalid input' } });
        await drainQueue(t);
        t.expect(reject.hits() >= 1, 'rejected_sent');
        await marked(rejected, 'rejected');
        reject.clear();
        const form = await t.openPopup(rejected);
        await form.popup.bringToFront();
        await form.popup.locator('#offline-queue-bar:not(.hidden)').waitFor();
        await form.popup.locator('#offline-queue-toggle').click();
        const rowText = await form.popup.locator('#offline-queue-list').innerText();
        t.note('queueRow', rowText.slice(0, 200));
        t.expect(rowText.trim().length > 0 && await form.popup.locator('#offline-queue-list .offline-queue-retry').count() >= 1, 'attention_row_actions');
        await t.shot(form.popup, 'queue-attention', { surface: 'popup', keys: ['#offline-queue-bar'] });
        await t.axe(form.popup, 'queue-attention');
        await form.close();
        await drop(rejected);
      }, ['queue-needs-attention']);

      // linkding 401 / Karakeep 401: the connection is paused (G8 invariant
      // 4) and the item kept for attention.
      await t.part('attention_token', ['G8', 'G17'], async () => {
        await t.phase('attention_token');
        revoked = t.claimUrl();
        await queueOffline(revoked);
        const unauth = t.service === 'linkding'
          ? t.inject({ status: 401, body: { detail: 'Invalid token.' } })
          : t.inject({ status: 401, contentType: 'text/plain;charset=UTF-8', body: 'Unauthorized' });
        await drainQueue(t);
        // The 401 already fails the duplicate check (a GET): counting writes
        // alone could not tell a paused connection from one retried every
        // time. Paused means no request at all, and the pause names this
        // connection.
        const since = t.now();
        await drainQueue(t);
        t.expectEq(t.requests({ since }).length, 0, 'token_retried');
        t.expect((await queue(t)).some(i => i.url === revoked), 'token_dropped');
        const account = await t.sw(async () => (await getCurrentBookmarkAuth()).account || '');
        const pause = await t.sw(async () => (await chrome.storage.local.get('offlineQueuePause')).offlineQueuePause || null);
        t.note('tokenPause', pause ? { reason: pause.reason, sameAccount: pause.account === account } : null);
        t.expect(!!pause && pause.account === account, 'token_not_paused');
        unauth.clear();
        await drop(revoked);
      }, ['queue-needs-attention']);

      await t.part('attention_retry_after', ['G17'], async () => {
        await t.phase('attention_retry_after');
        const limited = t.claimUrl();
        await queueOffline(limited);
        const started = Date.now();
        t.inject({ method: 'POST', path: createPath, status: 429, headers: { 'Retry-After': '120' }, body: { detail: 'Request was throttled.' }, times: 1 });
        await drainQueue(t);
        const item = (await queue(t)).find(i => i.url === limited);
        t.expect(!!item, 'retry_after_dropped');
        const raw = item.failure?.retryAfter;
        const until = typeof raw === 'number' ? raw : Date.parse(raw || '') || 0;
        t.note('retryAfterMs', until ? until - started : null);
        t.expect(until >= started + 110000 && until <= Date.now() + 130000, 'retry_after_deadline');
        const limitedSince = t.now();
        await drainQueue(t);
        t.expectEq(writesSince(t, limitedSince).length, 0, 'retry_after_ignored');
        const manual = await t.openPopup(revoked || rejected || limited);
        await manual.popup.bringToFront();
        await manual.popup.locator('#offline-queue-toggle').click();
        await manual.popup.locator('#offline-queue-list .offline-queue-retry').first().click();
        await t.until(async () => !(await queue(t)).some(i => i.url === limited), 'manual_retry');
        await t.ownRow(limited);
        await manual.close();
      }, ['queue-retry-after']);

      await t.part('attention_legacy_title', ['G17'], async () => {
        await t.phase('attention_legacy_title');
        t.expect(!!first, 'legacy_base_missing');
        const legacy = t.claimUrl();
        const record = { ...first, url: legacy, queueId: 'pbp-it-legacy-' + t.runId.slice(0, 8), title: 'T'.repeat(1200), queuedAt: Date.now() };
        delete record.failure;
        await t.sw(async record => { const { offlineQueue = [] } = await chrome.storage.local.get('offlineQueue'); await chrome.storage.local.set({ offlineQueue: [...offlineQueue, record] }); }, record);
        const legacySince = t.now();
        await drainQueue(t);
        t.expectEq(createsOf(t, legacy, legacySince).length, 0, 'legacy_title_sent');
        await marked(legacy, 'legacy_title');
        await drop(legacy);
      }, ['queue-legacy-record']);
      t.check(`${t.service}: rejected, unauthorised and over-long queued saves need attention and stop retrying; 429 waits for Retry-After; the bar shows the reason with a retry`);
    },
  },

  // 8. URL variants (G14 decision 9; G10): # fragment, utm, host case.
  {
    id: 'sh.url-variants',
    services: ['linkding', 'karakeep'],
    surfaces: ['popup', 'reader'],
    features: ['hash-variant-notice', 'reader-cleaned-url'],
    fixRefs: ['G10', 'G14'],
    needs: needs({ shots: true }),
    budget: { bookmarks: 1, urls: 1, node: 4, browser: { linkding: 30, karakeep: 45 }, ai: 0, tags: 0, seconds: 30, tagReads: 1 },
    files: [],
    settings: {},
    async steps(t) {
      const url = t.claimUrl();
      await t.seed({ url, title: t.prefix + ' variants', notes: '' });
      // Parts: the reader's utm verdict (G10) does not wait on the # notice
      // (G14), which lands later.
      await t.part('variant_hash', ['G14'], async () => {
        await t.phase('variant_hash');
        const hashed = url + '#section-2';
        const since = t.now();
        const form = await t.openPopup(hashed);
        t.expectEq(await form.popup.locator('#url-input').inputValue(), hashed, 'hash_save_url_changed');
        const checks = t.requests({ path: CHECK_PATH[t.service], since }).map(r => new URL('http://x/' + r.path).searchParams.get('url'));
        t.note('hashChecks', checks.map(u => (u === url ? 'plain' : u === hashed ? 'hashed' : 'other')));
        t.expect(checks.includes(hashed) && checks.includes(url), 'hash_second_lookup');
        const notice = await form.popup.evaluate(() => ['existing-banner', 'url-warning', 'status-msg'].map(id => document.getElementById(id)).filter(el => el && el.offsetParent !== null && el.innerText.trim()).map(el => el.id + ': ' + el.innerText.trim().slice(0, 160)));
        t.note('hashNotice', notice);
        t.expect(notice.length > 0, 'hash_notice');
        await t.shot(form.popup, 'hash-variant', { surface: 'popup', keys: ['#submit-btn'] });
        await form.close();
      }, ['hash-variant-notice']);
      await t.part('variant_reader', ['G10'], async () => {
        await t.phase('variant_reader');
        const judge = async variant => {
          const reader = await t.openReader(variant, { ready: '#reader-bookmark-save' });
          const saved = await reader.locator('#reader-bookmark-save').getAttribute('data-saved');
          await reader.close();
          return saved === 'true';
        };
        const utm = url + '&utm_source=pbp-it';
        t.expect(await judge(utm), 'reader_utm_unsaved');
        const upper = url.replace(/^(\w+:\/\/)([^/]+)/, (m, scheme, host) => scheme + host.toUpperCase());
        const slash = url.replace('/?', '?');
        t.note('readerVariants', { utm: true, hostCase: await judge(upper), noSlash: await judge(slash) });
      }, ['reader-cleaned-url']);
      t.check(`${t.service}: a # variant of a saved URL is looked up again without #, noticed and left as typed; the reader judges a utm variant saved`);
    },
  },

  // 9. Merge result keeps the popup open (G12, decision 8).
  {
    id: 'sh.merge-autoclose',
    services: ['linkding', 'karakeep'],
    surfaces: ['popup'],
    features: ['autoclose-normal', 'autoclose-merge-stays'],
    fixRefs: ['G12'],
    // Temp only (user-target rounds): the merge is staged with injected
    // lookups, the same on any instance; it takes two pool URLs a round.
    needs: needs({ target: 'temp', shots: true }),
    budget: { bookmarks: 2, urls: 2, node: 6, browser: { linkding: 30, karakeep: 45 }, ai: 0, tags: 0, seconds: 45, tagReads: 1 },
    files: [],
    settings: { optAutoCloseAfterSave: true },
    async steps(t) {
      await t.phase('autoclose_normal');
      const plain = t.claimUrl();
      let form = await t.openPopup(plain);
      await form.popup.locator('#title-input').fill(t.prefix + ' autoclose');
      const closed = form.popup.waitForEvent('close', { timeout: 8000 }).then(() => true, () => false);
      await form.popup.locator('#submit-btn').click();
      t.expect(await closed, 'normal_save_stays_open');
      await t.ownRow(plain);
      await form.close();
      await t.phase('autoclose_merge');
      // A merge is the server's answer to a create of a URL another client
      // saved after the popup's checks: the bookmark is seeded, and every
      // duplicate check answers "not saved" as it did when the popup opened,
      // so the create reaches the server and merges (linkding judges a merge
      // by date_modified - date_added > 2 s, hence the wait).
      const merged = t.claimUrl();
      form = await t.openPopup(merged);
      await t.seed({ url: merged, title: t.prefix + ' seeded elsewhere', notes: 'seeded' });
      await t.sleep(2500);
      t.inject({ method: 'GET', path: CHECK_PATH[t.service], status: 200, body: t.service === 'linkding' ? { bookmark: null, metadata: { url: merged, title: '', description: '' }, auto_tags: [] } : { bookmarkId: null } });
      await form.popup.locator('#title-input').fill(t.prefix + ' merge');
      const since = t.now();
      const seen = await clickSave(t, form.popup, 'merge_outcome');
      t.note('mergeOutcome', seen);
      t.expectEq(createsOf(t, merged, since).length, 1, 'merge_create_sent');
      await t.sleep(4000);
      t.expect(!form.popup.isClosed(), 'merge_auto_closed');
      t.expect(!!seen.text, 'merge_notice');
      await t.shot(form.popup, 'merge-kept-open', { surface: 'popup', keys: ['#submit-btn'] });
      await form.close();
      t.check(`${t.service}: a normal save auto-closes; a merge into an existing bookmark keeps its notice open`);
    },
  },

  // 10. Batch (G13, decision 7): skip mode checks before AI; the merge-mode
  // confirmation says what it does; an over-long title fails.
  {
    id: 'sh.batch',
    services: ['linkding', 'karakeep'],
    surfaces: ['popup'],
    features: ['fake-ai', 'batch-skip-checks-first', 'batch-confirm-copy', 'batch-title-too-long'],
    fixRefs: ['G13'],
    needs: needs({ fakeAi: true }),
    budget: { bookmarks: 2, urls: 3, node: 8, browser: { linkding: 50, karakeep: 75 }, ai: 3, tags: 3, seconds: 45, tagReads: 1 },
    files: [],
    settings: { batchAiSummary: false, aiTagLang: 'en' },
    async steps(t) {
      const existing = t.claimUrl(), fresh = t.claimUrl(), long = t.claimUrl();
      await t.seed({ url: existing, title: t.prefix + ' batch existing', notes: 'kept', tags: [t.prefix] });
      await t.phase('batch_confirm_merge');
      await t.settings({ batchSkipExisting: false, batchAiTags: true });
      const form = await t.openPopup(existing);
      await form.popup.bringToFront();
      const since = t.now();
      await form.popup.locator('#batch-bookmark-btn').click();
      await form.popup.locator('#batch-permission:not(.hidden)').waitFor({ timeout: 8000 });
      const detail = await form.popup.locator('#batch-permission-detail').innerText();
      t.note('mergeConfirm', detail.slice(0, 200));
      t.expect(!/skip/i.test(detail), 'merge_confirm_says_skip');
      await form.popup.locator('#batch-permission-cancel').click();
      t.expectEq(writesSince(t, since).length, 0, 'confirm_cancel_wrote');
      await form.close();

      await t.phase('batch_skip_mode');
      await t.settings({ batchSkipExisting: true, batchAiTags: true });
      const before = t.fakeAi.calls();
      const skip = await batchSave(t, [existing, fresh]);
      t.note('skip', skip);
      t.expectEq(t.fakeAi.calls() - before, 1, 'skip_mode_ai_calls');
      t.expect(tagsOfRow(t, await t.ownRow(existing)).length === 1, 'skip_mode_existing_changed');
      await t.ownRow(fresh);

      await t.phase('batch_long_title');
      await t.settings({ batchSkipExisting: false, batchAiTags: false });
      page(t, long, articleHtml({ title: 'Long '.repeat(240) }));
      const longSince = t.now();
      const result = await batchSave(t, [long]);
      t.note('longTitle', result);
      t.expect(result.saved === 0 && (result.failed >= 1 || result.tooLong >= 1), 'long_title_not_failed');
      t.expectEq(createsOf(t, long, longSince).length, 0, 'long_title_sent');
      t.check(`${t.service}: batch merge confirmation does not promise skipping; skip mode checks before AI (one call for one new page); an over-long title fails without a request`);
    },
  },

  // 11. Read Later and recent (G16, decision 12): the shortcut's rl*
  // settings; Karakeep reuses its marked list; recent omits archived.
  {
    id: 'sh.read-later',
    services: ['linkding', 'karakeep'],
    surfaces: ['reader'],
    features: ['read-later-shortcut', 'read-later-list-reuse', 'recent-not-archived'],
    fixRefs: ['G16', 'G18'],
    needs: needs(),
    budget: { bookmarks: 3, urls: 3, node: { linkding: 8, karakeep: 18 }, browser: { linkding: 30, karakeep: 75 }, ai: 0, tags: 1, lists: { karakeep: 1 }, seconds: 45, tagReads: 1 },
    files: [],
    settings: { rlAutoNotes: false, rlBlockquote: false, rlAiTags: false, rlAiSummary: false },
    async steps(t) {
      const tag = t.prefix + '_rl';
      await t.settings({ rlDefaultTags: tag });
      const markerLists = async () => (await t.api('lists')).lists.filter(l => l.description === LIST_MARKER).map(l => l.id);
      const inList = async (row, ids) => (await karakeepLists(t, row)).some(l => ids.includes(l.id));
      const first = t.claimUrl(), second = t.claimUrl(), archived = t.claimUrl();
      await t.phase('read_later_shortcut');
      const listsBefore = t.service === 'karakeep' ? await markerLists() : [];
      const r = await shortcutSave(t, first, 'rl');
      t.note('readLater', r);
      t.expectEq(r.status, 'saved', 'read_later_status');
      let row = await t.ownRow(first);
      t.expect(tagsOfRow(t, row).includes(tag), 'read_later_tag');
      if (t.service === 'linkding') t.expectEq(row.unread, true, 'read_later_unread');
      else {
        const lists = await markerLists();
        t.expect(lists.length === 1 && (listsBefore.length === 0 || lists[0] === listsBefore[0]), 'read_later_list');
        t.expect(await inList(row, lists), 'read_later_member');
        await t.phase('read_later_list_reuse');
        await t.sw(async () => chrome.storage.local.set({ karakeepReadLaterListId: '', karakeepReadLaterListOwner: '' }));
        t.expectEq((await shortcutSave(t, second, 'rl')).status, 'saved', 'reuse_status');
        const after = await markerLists();
        t.expect(after.length === 1 && after[0] === lists[0], 'read_later_list_duplicated');
        const secondRow = await t.ownRow(second);
        t.expect(await inList(secondRow, after), 'reuse_member');
        const reader = await t.openReader(second, { ready: '#reader-bookmark-later' });
        await reader.locator('#reader-bookmark-save').click();
        await reader.waitForFunction(() => document.getElementById('reader-bookmark-later')?.getAttribute('aria-pressed') === 'false');
        await reader.close();
        t.expect(!(await inList(secondRow, after)), 'reuse_remove_member');
        t.expect(await inList(row, after), 'reuse_removed_other_member');
      }
      await t.phase('recent_not_archived');
      const seeded = await t.seed({ url: archived, title: t.prefix + ' archived', notes: '' });
      await t.api(t.recordPath(seeded.id), { method: 'PATCH', body: t.service === 'linkding' ? { is_archived: true } : { archived: true } });
      const recent = await t.sw(async () => (await pbpBookmarkClient(await getCurrentBookmarkAuth()).recent(20)).map(b => b.url));
      t.expect(recent.includes(first), 'recent_missing_unarchived');
      t.expect(!recent.includes(archived), 'recent_lists_archived');
      t.check(`${t.service}: the rl* Read Later shortcut tags and marks the bookmark${t.service === 'karakeep' ? ', reusing the one marked list and changing only its own members' : ''}; recent bookmarks omit archived ones`);
    },
  },

  // 12. Options: connect before switching, errors, disconnect (G22, G28;
  // decisions 6, 11). Temporary instances only: it sends wrong tokens,
  // removes the stored token and connects again.
  {
    id: 'sh.options-connect',
    services: ['linkding', 'karakeep'],
    surfaces: ['options', 'popup'],
    features: ['tag-panel-follows-service', 'connect-before-switch', 'connect-errors', 'connect-aria-invalid', 'failed-connect-keeps-credentials', 'disconnect', 'pinboard-roundtrip'],
    fixRefs: ['G5', 'G8', 'G22', 'G28'],
    needs: needs({ target: 'temp', shots: true }),
    budget: { bookmarks: 0, urls: 1, node: 4, browser: { linkding: 120, karakeep: 200 }, ai: 0, tags: 0, seconds: 120, tagReads: 3 },
    files: [],
    settings: {},
    async steps(t) {
      const s = t.service;
      const conn = () => t.sw(async () => { const c = await pbpReadBookmarkConnection(); return { service: c.service, account: c.account || '' }; });
      const original = await conn();
      t.expectEq(original.service, s, 'connected_service');
      // bookmarkService as another tab or a synced device changes it: a real
      // storage event in the area ordinary settings live in.
      const storeService = value => t.sw(async value => {
        const { optSyncEnabled } = await chrome.storage.local.get('optSyncEnabled');
        await (optSyncEnabled === true ? chrome.storage.sync : chrome.storage.local).set({ bookmarkService: value });
      }, value);

      // Landed fix first (49beb7a8, 0638cf0c): the Tags panel follows a
      // stored service change without a reload, both ways, and the popup
      // opens normally after the round trip through an unconfigured Pinboard.
      await t.part('tag_panel_roundtrip', ['G5'], async () => {
        await t.phase('options_tag_panel_roundtrip');
        const options = await t.openOptions('tags');
        const state = () => options.evaluate(() => document.getElementById('panel-tags')?.dataset.tagGovState || '');
        await t.until(async () => (await state()) === 'pinboard-only', 'tag_panel_pinboard_only');
        await storeService('pinboard');
        await t.until(async () => (await state()) !== 'pinboard-only', 'tag_panel_followed_pinboard', 8000);
        t.note('tagPanelUnderPinboard', { state: await state(), tokenPrompt: await options.locator('#tag-gov-need-token').isVisible() });
        t.expect(await options.locator('#tag-gov-need-token').isVisible(), 'tag_panel_token_prompt');
        await storeService(s);
        await t.until(async () => (await state()) === 'pinboard-only', 'tag_panel_followed_back', 8000);
        await options.close();
        t.expectEq((await conn()).service, s, 'roundtrip_service');
        const form = await t.openPopup(t.claimUrl());
        t.expect(await form.popup.locator('#main-section').isVisible(), 'popup_stuck_after_roundtrip');
        await form.close();
      }, ['tag-panel-follows-service', 'pinboard-roundtrip']);

      // Connect errors: a hint, aria-invalid on the field at fault, no
      // write, and the stored connection untouched (compared by digest in
      // the worker; no value leaves it).
      await t.part('connect_errors', ['G8', 'G22'], async () => {
        const writesBefore = await t.writes();
        const stored = await connectionDigest(t);
        const options = await t.openOptions();
        const connectError = async (code, invalidSelector) => {
          const status = options.locator(`#connect-${s}-status`);
          await options.locator(`#connect-${s}`).click();
          await t.until(async () => { const text = (await status.innerText()).trim(); return text && !/Connecting|Checking/i.test(text); }, code + '_status', 20000);
          const text = (await status.innerText()).trim();
          t.note(code, text.slice(0, 200));
          t.expect(!/^Connected/.test(text), code + '_connected');
          t.expectEq(await options.locator(invalidSelector).getAttribute('aria-invalid'), 'true', code + '_aria_invalid');
          return text;
        };
        await t.phase('options_wrong_token');
        await options.locator(`#opt-${s}-token`).fill('pbp-it-wrong-token-' + t.runId.slice(0, 8));
        const tokenText = await connectError('wrong_token', `#opt-${s}-token`);
        const auth = t.message('bookmarkConnectErrAuth');
        if (auth) t.expect(tokenText.includes(auth.split('$')[0].trim().slice(0, 20)), 'wrong_token_not_auth');
        await t.shot(options, 'wrong-token', { surface: 'options', keys: [`#connect-${s}`] });
        await t.axe(options, 'wrong-token');
        await t.phase('options_wrong_port');
        const other = t.otherBases().find(b => b.service !== s);
        if (other) {
          await options.locator(`#opt-${s}-url`).fill(other.base);
          await connectError('wrong_port', `#opt-${s}-url`);
        } else t.note('wrong_port', 'skipped: no other instance in this run');
        await t.phase('options_gateway_empty');
        await options.locator(`#opt-${s}-url`).fill(t.base);
        await options.evaluate(s => { const sel = document.getElementById('opt-' + s + '-gateway'); sel.value = 'cloudflare'; sel.dispatchEvent(new Event('change', { bubbles: true })); }, s);
        const gwSince = t.now();
        await connectError('gateway_empty', `#opt-${s}-cf-id`);
        t.expectEq(t.requests({ since: gwSince }).length, 0, 'gateway_empty_request');
        t.expectEq(await t.writes(), writesBefore, 'connect_errors_wrote');
        t.expect(JSON.stringify(await conn()) === JSON.stringify(original), 'failed_connect_changed_connection');
        t.expectEq(await connectionDigest(t), stored, 'failed_connect_overwrote_credentials');
        await options.close();
      }, ['connect-errors', 'connect-aria-invalid', 'failed-connect-keeps-credentials']);

      // Choosing a service only opens its form; the switch waits for a
      // successful Connect (decision 6).
      await t.part('switch_needs_connect', ['G28'], async () => {
        await t.phase('options_switch_needs_connect');
        const options = await t.openOptions();
        await options.locator('input[name="bookmark-service"][value="pinboard"]').check();
        await t.sleep(800);
        t.expectEq((await conn()).service, s, 'switched_before_connect');
        await options.locator(`input[name="bookmark-service"][value="${s}"]`).check();
        await options.close();
      }, ['connect-before-switch']);

      await t.part('disconnect', ['G22'], async () => {
        await t.phase('options_disconnect');
        const options = await t.openOptions();
        const disconnect = options.locator(`#disconnect-${s}`);
        t.expect(await disconnect.count() === 1, 'pending_disconnect_button');
        await disconnect.click();
        await options.locator('.confirm-yes').waitFor({ timeout: 5000 });
        const tokenKey = s + 'Token';
        const hasToken = () => t.sw(async key => !!(await pbpReadSettingsWithSecrets({ [key]: '' }))[key], tokenKey);
        t.expect(await hasToken(), 'disconnect_without_confirm');
        await options.locator('.confirm-yes').click();
        await t.until(async () => !(await hasToken()), 'disconnect_token_removed', 8000);
        await options.close();
      }, ['disconnect']);
      // Whatever the parts did, the module ends connected as it began.
      if ((await conn()).service !== s || !(await t.sw(async key => !!(await pbpReadSettingsWithSecrets({ [key]: '' }))[key], s + 'Token'))) await t.reconnect();
      t.expectEq((await conn()).service, s, 'reconnected');
      t.check(`${s}: the Tags panel follows a stored service change both ways and the popup opens after it; wrong token, wrong port and empty gateway fail with aria-invalid, no writes and the stored connection unchanged; choosing a service only opens its form; Disconnect asks first and removes the token`);
    },
  },

  // 13. Tag input (G21+G23 decision 13; G29): quoted names with spaces and a
  // long chip in German. No writes.
  {
    id: 'sh.tag-input',
    services: ['linkding', 'karakeep'],
    surfaces: ['popup'],
    features: ['quoted-tag-space', 'long-tag-chip-geometry'],
    fixRefs: ['G21+G23', 'G29'],
    // Temp only (user-target rounds): chip geometry and quote typing are
    // the popup's, not the server's; a temporary instance shows the same.
    needs: needs({ target: 'temp', writes: false, shots: true }),
    budget: { bookmarks: 0, urls: 1, node: 2, browser: { linkding: 15, karakeep: 25 }, ai: 0, tags: 0, seconds: 45, tagReads: 1 },
    files: ['_locales/de/messages.json'],
    settings: {},
    async steps(t) {
      const url = t.claimUrl();
      let form;
      await t.part('quoted_tag', ['G21+G23'], async () => {
        await t.phase('tag_input_quotes');
        form = await t.openPopup(url);
        const input = form.popup.locator('#tags-input');
        const chips = () => form.popup.locator('#tags-display .tag-item').allTextContents();
        await input.click();
        await form.popup.keyboard.type('"' + t.prefix + ' two');
        await form.popup.keyboard.press('Space');
        await form.popup.keyboard.type('words');
        t.expectEq((await chips()).length, 0, 'quote_space_committed');
        t.expectEq(await input.inputValue(), '"' + t.prefix + ' two words', 'quote_input_kept');
        await form.popup.keyboard.type('"');
        await form.popup.keyboard.press('Space');
        const chipNames = () => form.popup.locator('#tags-display .tag-item').evaluateAll(els => els.map(el => el.textContent.trim()));
        const committed = await chipNames();
        t.note('quotedChips', committed.length);
        t.expect(committed.length === 1, 'quote_closed_commit');
        // The closing quote commits what pasting the same text and pressing
        // Enter gives (pbpSplitTagInput, then the name minted by the
        // separator setting): the reference is the popup's own paste path,
        // not a spelling assumed here.
        await form.popup.locator('#tags-display .tag-remove').first().click();
        t.expectEq(await form.popup.locator('#tags-display .tag-item').count(), 0, 'quote_chip_removed');
        await input.fill('"' + t.prefix + ' two words"');
        await input.press('Enter');
        const pasted = await chipNames();
        t.note('quotedVsPasted', { typed: committed.map(n => n.slice(t.prefix.length)), pasted: pasted.map(n => n.slice(t.prefix.length)) });
        t.expect(pasted.length === 1, 'quote_paste_commit');
        t.expectEq(committed[0], pasted[0], 'quote_closed_matches_paste');
        t.expect(!committed[0].includes('"') && /two/.test(committed[0]) && /words/.test(committed[0]), 'quote_closed_name');
        await form.close();
      }, ['quoted-tag-space']);

      await t.part('long_chip', ['G29'], async () => {
        await t.phase('tag_input_long_chip');
        form = await t.openPopup(url, { locale: 'de', width: 550 });
        const long = (t.prefix + '_' + 'abcdefghijklmnopqrstuvwxyz').slice(0, 68);
        await form.popup.locator('#tags-input').fill(long);
        await form.popup.locator('#tags-input').press('Enter');
        const g = await form.popup.evaluate(() => {
          const chip = document.querySelector('#tags-display .tag-item');
          const wrap = chip?.closest('.tags-input-wrap') || document.getElementById('tags-display');
          const remove = chip?.querySelector('.tag-remove');
          if (!chip || !remove) return { missing: true };
          const c = chip.getBoundingClientRect(), w = wrap.getBoundingClientRect(), r = remove.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, chipRight: Math.round(c.right), wrapRight: Math.round(w.right), removeLeft: Math.round(r.left), removeRight: Math.round(r.right), hit: !!hit && (hit === remove || remove.contains(hit)) };
      }, ['long-tag-chip-geometry']);
      t.note('longChip', g);
      t.expect(!g.missing, 'long_chip_missing');
      t.expect(g.scrollWidth <= g.innerWidth, 'long_chip_page_overflow');
      t.expect(g.chipRight <= g.wrapRight + 1, 'long_chip_wrap_overflow');
      t.expect(g.removeLeft >= 0 && g.removeRight <= g.innerWidth && g.hit, 'long_chip_remove_unreachable');
      await t.shot(form.popup, 'long-chip-de', { surface: 'popup', keys: ['#tags-display .tag-remove', '#submit-btn'] });
      await t.axe(form.popup, 'long-chip-de');
      await form.popup.locator('#tags-display .tag-remove').first().click();
      t.expectEq(await form.popup.locator('#tags-display .tag-item').count(), 0, 'long_chip_not_removed');
      await form.close();
      });
      t.check(`${t.service}: a quoted tag keeps its spaces until the closing quote; a 68-character chip in German stays inside the popup with a reachable remove button`);
    },
  },

  // 14. Karakeep authentication (G8): a wrong key is an auth failure, not a
  // gateway refusal, and nothing pays for AI first.
  {
    id: 'sh.karakeep-auth',
    services: ['karakeep'],
    surfaces: ['options'],
    features: ['fake-ai', 'karakeep-auth-not-gateway', 'permission-before-ai', 'revoked-key-not-queued', 'batch-stops-on-auth'],
    fixRefs: ['G8'],
    // Temp only (user-target rounds): it sends a wrong key on purpose, which
    // has no place on the user's instance; the answer is Karakeep's own.
    needs: needs({ target: 'temp', fakeAi: true }),
    budget: { bookmarks: 0, urls: 4, node: 2, browser: 60, ai: 3, tags: 0, seconds: 75, tagReads: 1 },
    files: [],
    settings: { offlineQueueEnabled: true, qsAiTags: true, qsAiSummary: true, batchAiTags: true, batchAiSummary: false, batchSkipExisting: false },
    async steps(t) {
      const resetQueue = () => t.sw(async () => { await chrome.storage.local.remove('offlineQueuePause'); await chrome.storage.local.set({ offlineQueue: [] }); });
      await t.part('wrong_key', ['G8'], async () => {
        await t.phase('karakeep_wrong_key');
        const stored = await connectionDigest(t);
        const options = await t.openOptions();
        await options.locator('#opt-karakeep-token').fill('pbp-it-wrong-key-' + t.runId.slice(0, 8));
        const status = options.locator('#connect-karakeep-status');
        await options.locator('#connect-karakeep').click();
        await t.until(async () => { const text = (await status.innerText()).trim(); return text && !/Connecting|Checking/i.test(text); }, 'wrong_key_status', 20000);
        const text = (await status.innerText()).trim();
        t.note('wrongKey', text.slice(0, 200));
        const gateway = t.message('bookmarkErrGatewayDenied'), auth = t.message('bookmarkConnectErrAuth');
        if (gateway) t.expect(!text.includes(gateway.split('$')[0].trim().slice(0, 24)), 'wrong_key_gateway');
        if (auth) t.expect(text.includes(auth.split('$')[0].trim().slice(0, 20)), 'wrong_key_not_auth');
        await options.close();
        t.expectEq(await t.sw(async () => (await pbpReadBookmarkConnection()).service), 'karakeep', 'wrong_key_disconnected');
        t.expectEq(await connectionDigest(t), stored, 'wrong_key_overwrote_connection');
      }, ['karakeep-auth-not-gateway']);

      // G8 invariant 5: without the origin's host permission, quick save
      // neither extracts nor pays for AI, queues nothing and says so. The
      // worker's permissions.contains answers false for this origin only,
      // and is put back whatever happens.
      await t.part('permission_missing', ['G8'], async () => {
        await t.phase('karakeep_permission_missing');
        const origin = new URL(t.base).origin;
        const patched = await t.sw(async origin => {
          const api = chrome.permissions;
          if (!globalThis.pbpLiveContains) globalThis.pbpLiveContains = api.contains.bind(api);
          const real = globalThis.pbpLiveContains;
          try {
            api.contains = async (q, ...rest) => ((q?.origins || []).some(o => String(o).startsWith(origin)) ? false : real(q, ...rest));
          } catch (_) { return false; }
          return (await chrome.permissions.contains({ origins: [origin + '/*'] })) === false;
        }, origin);
        try {
          t.expect(patched, 'permission_patch_unavailable');
          const before = t.fakeAi.calls(), queued = (await queue(t)).length;
          const quick = await shortcutSave(t, t.claimUrl(), 'qs');
          t.note('permissionQuickSave', quick);
          t.expectEq(t.fakeAi.calls() - before, 0, 'permission_quick_save_paid_ai');
          t.expectEq((await queue(t)).length, queued, 'permission_quick_save_queued');
          t.expect(quick.status !== 'saved' && quick.status !== 'queued' && quick.reason === 'permission', 'permission_quick_save_reason');
        } finally {
          await t.sw(async () => { if (globalThis.pbpLiveContains) chrome.permissions.contains = globalThis.pbpLiveContains; });
        }
      }, ['permission-before-ai']);

      // A revoked key (401): quick save ends as an authentication failure,
      // not queued (G8 does not move its AI call before delivery).
      await t.part('revoked_quick_save', ['G8'], async () => {
        await t.phase('karakeep_revoked_quick_save');
        const fault = t.inject({ status: 401, contentType: 'text/plain;charset=UTF-8', body: 'Unauthorized' });
        const queued = (await queue(t)).length;
        const quick = await shortcutSave(t, t.claimUrl(), 'qs');
        t.note('quickSave', quick);
        t.expect(quick.status !== 'saved' && /auth|not_logged_in/.test(quick.reason), 'revoked_quick_save_reason');
        t.expectEq((await queue(t)).length, queued, 'revoked_quick_save_queued');
        fault.clear();
        await resetQueue();
      }, ['revoked-key-not-queued']);

      // Batch over two pages: a 401 on the first stops the run, so the AI
      // is asked at most once and the second page is never delivered.
      await t.part('revoked_batch', ['G8'], async () => {
        await t.phase('karakeep_revoked_batch');
        const fault = t.inject({ status: 401, contentType: 'text/plain;charset=UTF-8', body: 'Unauthorized' });
        const urls = [t.claimUrl(), t.claimUrl()];
        const before = t.fakeAi.calls(), since = t.now();
        const batch = await batchSave(t, urls);
        t.note('batch', { ...batch, ai: t.fakeAi.calls() - before });
        t.expect(batch.saved === 0, 'revoked_batch_saved');
        t.expect(t.fakeAi.calls() - before <= 1, 'revoked_batch_paid_ai');
        const second = t.requests({ since }).filter(r => r.body?.url === urls[1] || r.path.includes(encodeURIComponent(urls[1])));
        t.expectEq(second.length, 0, 'revoked_batch_second_page');
        fault.clear();
        await resetQueue();
      }, ['batch-stops-on-auth']);
      t.check('karakeep: a wrong key reads as an authentication failure and leaves the stored connection alone; without host permission quick save stops before AI; a revoked key is an auth failure, not queued; batch stops at the first 401 with at most one AI call');
    },
  },

  // 15. Karakeep tag library spelling (handoff §9-12, §9-16).
  {
    id: 'sh.karakeep-tag-library',
    services: ['karakeep'],
    surfaces: ['popup'],
    features: ['fake-ai', 'ai-tag-library-spelling', 'autocomplete-by-count'],
    fixRefs: ['G4'],
    needs: needs({ fakeAi: true, shots: true }),
    budget: { bookmarks: 4, urls: 4, node: 14, browser: 35, ai: 2, tags: 4, seconds: 45, tagReads: 2 },
    files: [],
    settings: { optShowAiTags: true, optRespectTagCase: true, tagSyncMode: 'fresh' },
    async steps(t) {
      const { prefix } = t;
      const names = { lib: prefix + ' machine learning', alpha: prefix + ' auto alpha', beta: prefix + ' auto beta', gamma: prefix + ' auto gamma' };
      const urls = [t.claimUrl(), t.claimUrl(), t.claimUrl(), t.claimUrl()];
      const runTags = () => t.sw(async prefix => (await pbpBookmarkClient(await getCurrentBookmarkAuth()).tags()).map(tag => tag.name).filter(n => n.startsWith(prefix)).sort(), prefix);
      await t.phase('library_seed');
      const seeds = [[names.lib, names.alpha, names.gamma], [names.lib, names.alpha, names.gamma], [names.alpha, names.beta]];
      for (let i = 0; i < 3; i++) await t.seed({ url: urls[i], title: prefix + ' library ' + i, notes: '', tags: seeds[i] });
      const before = await runTags();
      await t.phase('library_autocomplete');
      const form = await t.openPopup(urls[3]);
      const { popup } = form;
      await popup.waitForFunction(name => allUserTagCounts[name] === 3, names.alpha);
      await popup.locator('#tags-input').click();
      // The prefix alone: a space would commit what was typed as a chip.
      await popup.keyboard.type(prefix);
      await popup.locator('#tags-autocomplete .ac-item[data-tag]').first().waitFor();
      const order = await popup.locator('#tags-autocomplete .ac-item[data-tag]').evaluateAll(els => els.map(el => el.dataset.tag));
      t.note('autocomplete', order.map(n => n.slice(prefix.length)));
      t.expectEq(order.filter(n => [names.alpha, names.beta, names.gamma].includes(n)).join('|'), [names.alpha, names.gamma, names.beta].join('|'), 'autocomplete_by_count');
      await popup.locator('#tags-input').fill('');
      await popup.keyboard.press('Escape');
      t.expectEq(await popup.locator('#tags-display .tag-item').count(), 0, 'autocomplete_left_no_chip');
      await t.phase('library_ai_spelling');
      // The button asks for tags alone or for tags and summary in one call.
      const variant = [prefix + '_Machine-Learning'];
      t.fakeAi.expect({ kind: 'tags', reply: JSON.stringify(variant) });
      t.fakeAi.expect({ kind: 'combined', reply: JSON.stringify({ summary: t.fakeAi.marker + ' summary.', tags: variant }) });
      await popup.locator('#ai-tags-btn').click();
      await popup.locator('#ai-suggest-tags .stag.ai').first().waitFor();
      const suggested = await popup.locator('#ai-suggest-tags .stag.ai').evaluateAll(els => els.map(el => el.dataset.tag));
      t.expectEq(suggested.join('|'), names.lib, 'ai_chip_library_spelling');
      await popup.locator('#ai-suggest-tags .add-all-link').click();
      t.expect((await popup.locator('#tags-display .tag-item').allTextContents()).some(text => text.includes(names.lib)), 'chip_library_spelling');
      await t.shot(popup, 'ai-library-spelling', { surface: 'popup', keys: ['#submit-btn'] });
      await t.savePopup(popup);
      await form.close();
      const row = await t.ownRow(urls[3]);
      t.expectEq(tagsOfRow(t, row).join('|'), names.lib, 'saved_library_spelling');
      t.expectEq((await runTags()).join('|'), before.join('|'), 'prefix_tag_count_changed');
      t.check('karakeep: an AI tag in another spelling (case, hyphen, underscore) becomes the library\'s spelling; no new tag; autocomplete orders by use count');
    },
  },
];

MODULES.push(...SELFHOSTED_MODULES);

// Group aliases. The pre-registry --scenario values keep their meaning:
// core = the original smoke, edges = tag/offline/quote regressions.
export const GROUPS = Object.freeze({
  core: ['*.core.*'],
  edges: ['*.edges.*'],
  readonly: ['*.readonly'],
  ai: ['*.ai.*'],
  selfhosted: ['*.sh.*'],
  all: ['*'],
});

// Known gaps the Chinese summary lists under 未覆盖项 (research survey). An
// entry with coveredBy drops out once a module matching that glob ran.
export const UNCOVERED = Object.freeze([
  { text: 'Pinboard 回归 §9-17（popup/快捷/批量保存格式、含 " 标签）：--target user --service pinboard --scenario core', coveredBy: 'pinboard.core.save-paths' },
  { text: 'Pinboard §9-18（分隔符说明文案中英文读感）：需人工阅读，无模块' },
  { text: '稍后读快捷键（rl* 设置）与 linkding / Karakeep 的快捷保存、批量保存', coveredBy: '*.sh.read-later' },
  { text: 'linkding 共享开启分支（只在临时容器跑：--scenario linkding.sharing.*）', coveredBy: 'linkding.sharing.*' },
  { text: 'linkding 超长标签 500（只在临时 Postgres 跑：--scenario linkding-pg.limits.*）', coveredBy: 'linkding-pg.limits.*' },
  { text: '上千标签下的标签缓存、补全与治理性能（临时容器批量造标签，尚无模块）' },
  { text: 'linkding / Karakeep 网页本身的渲染（Notes Markdown、note 显示）' },
  { text: '真实工具栏弹窗尺寸、焦点与冷启动字体（标签页模式无法覆盖）' },
]);
