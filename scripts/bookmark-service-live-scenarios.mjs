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
//   surfaces  extension surfaces it drives (report and summary only)
//   features  fix/feature tags; the Chinese summary groups results by them
//   needs     { fakeAi, target: 'temp'|'user'|'any', container, sharing: 'any'|'on'|'off',
//               headed, shots, pinboard, writes, urls, snapshots }
//             snapshots: the module waits for linkding's automatic HTML
//             snapshot. Temporary linkding instances start with automatic
//             snapshots off; the runner switches them on for such a module
//             only. A user instance keeps its own profile setting.
//   budget    { bookmarks, urls, node, browser, ai, tags, lists, seconds }
//             any field may be a number or { <service>: number }
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
  shots: false, pinboard: false, writes: true, snapshots: false,
});

// linkding builds HTML snapshots one at a time in the background. Only the
// snapshot module waits for one, polling every 5 s and stopping while its
// module still has SNAPSHOT_MARGIN_MS left for checks and cleanup.
export const SNAPSHOT_POLL_MS = 5000;
export const SNAPSHOT_MARGIN_MS = 15000;
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
    needs: needs({ writes: false }),
    budget: { bookmarks: 0, urls: 1, node: 4, browser: { linkding: 40, karakeep: 60, pinboard: 12 }, ai: 0, tags: 0, seconds: 60, calls: { pinboard: 4 } },
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
    needs: needs({ snapshots: true }),
    // One assets read per poll: at most 21 in 120 s, plus the create lookups.
    budget: { bookmarks: 1, urls: 1, node: 30, browser: 10, ai: 0, tags: 0, seconds: 120 },
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
      for (;;) {
        await t.sleep(SNAPSHOT_POLL_MS);
        polls++;
        const assets = await t.api('bookmarks/' + row.id + '/assets/');
        status = (assets.results || []).find(a => a.asset_type === 'snapshot')?.status || 'missing';
        // linkding stores the pending asset inside the create request, so
        // "missing" already means automatic snapshots are off for this account.
        if (status !== 'pending' || t.remainingMs() < SNAPSHOT_POLL_MS + SNAPSHOT_MARGIN_MS) break;
      }
      t.note('snapshot', { status, polls, waitedMs: Date.now() - started });
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
    needs: needs(),
    budget: { bookmarks: 1, urls: 1, node: 16, browser: { linkding: 90, karakeep: 130, pinboard: 40 }, ai: 0, tags: 2, lists: { karakeep: 1 }, seconds: { linkding: 90, karakeep: 90, pinboard: 120 }, calls: { pinboard: 24 } },
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
    needs: needs(),
    budget: { bookmarks: 1, urls: 1, node: { linkding: 20, karakeep: 12, pinboard: 6 }, browser: { linkding: 30, karakeep: 40, pinboard: 16 }, ai: 0, tags: 2, seconds: { linkding: 60, karakeep: 60, pinboard: 90 }, calls: { pinboard: 9 } },
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
    needs: needs(),
    budget: { bookmarks: 2, urls: 2, node: 8, browser: 20, ai: 0, tags: 4, seconds: 100, calls: { pinboard: 8 } },
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
    needs: needs(),
    budget: { bookmarks: 4, urls: 4, node: 30, browser: 120, ai: 0, tags: 5, seconds: 90 },
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
    needs: needs(),
    budget: { bookmarks: 1, urls: 1, node: 4, browser: 40, ai: 0, tags: 0, seconds: 60 },
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
    needs: needs(),
    budget: { bookmarks: 1, urls: 1, node: 6, browser: 60, ai: 0, tags: 1, seconds: 90 },
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
      const replay = async (form, label) => {
        await form.popup.locator('#offline-queue-toggle').click();
        await t.offline('');
        await form.popup.locator('.offline-queue-retry').click();
        await t.until(() => t.sw(async () => (await chrome.storage.local.get('offlineQueue')).offlineQueue?.length === 0), label);
      };

      await t.phase('linkding_offline_create');
      let form = await t.openPopup(url);
      await form.popup.locator('#title-input').fill(prefix + ' offline create');
      await form.popup.locator('#description-input').fill('Offline notes\nSecond line');
      await form.popup.locator('#linkding-description-input').fill('Offline description');
      await form.popup.locator('#tags-input').fill(JSON.stringify(prefix + ' offline tag'));
      await form.popup.locator('#tags-input').press('Enter');
      await form.popup.locator('#readlater-check').check();
      await t.offline('self');
      await form.popup.locator('#submit-btn').click();
      await form.popup.locator('#offline-queue-bar:not(.hidden)').waitFor();
      t.expect(await queueIsSafe('Offline description', 'Offline notes\nSecond line'), 'offline_create_queue_fields');
      await t.shot(form.popup, 'offline-queue', { surface: 'popup', keys: ['#offline-queue-bar'] });
      await t.settings({ aiTagSeparator: '-' });
      await replay(form, 'offline_create_replay');
      let row = await t.ownRow(url);
      t.expect(row.description === 'Offline description' && row.notes === 'Offline notes\nSecond line' && row.unread === true && row.shared === false, 'offline_create_fields');
      t.expect(row.tag_names.length === 1 && row.tag_names[0] === tag, 'offline_replay_reminted_tag');
      await form.close();

      await t.phase('linkding_offline_update');
      form = await t.openPopup(url);
      await form.popup.locator('#description-input').fill('Updated offline notes');
      await form.popup.locator('#linkding-description-input').fill('');
      await form.popup.locator('#readlater-check').uncheck();
      await t.offline('self');
      await form.popup.locator('#submit-btn').click();
      await form.popup.locator('#offline-queue-bar:not(.hidden)').waitFor();
      t.expect(await queueIsSafe('', 'Updated offline notes'), 'offline_update_queue_fields');
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
    needs: needs({ fakeAi: true, shots: true }),
    budget: { bookmarks: 1, urls: 1, node: 6, browser: { linkding: 40, karakeep: 60 }, ai: 3, tags: 2, seconds: 90 },
    // The fake AI provider is configured by the runner (needs.fakeAi); these
    // only reveal the popup's AI actions for this module.
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
    // Sharing is switched on only inside a temporary instance; the runner
    // reconnects so the extension records it, and switches it back after.
    needs: needs({ target: 'temp', sharing: 'on', shots: true }),
    budget: { bookmarks: 2, urls: 2, node: 16, browser: 200, ai: 0, tags: 1, seconds: 150 },
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
    // linkding keeps tag names in varchar(64): SQLite ignores the limit and
    // Postgres answers 500, so only the temporary Postgres-backed instance
    // reproduces it. The module records what the popup shows (notes) and
    // asserts only what must hold before and after the planned fix: no
    // reported success and no request storm.
    needs: needs({ target: 'temp', container: 'linkding-pg', shots: true }),
    budget: { bookmarks: 2, urls: 2, node: 12, browser: 80, ai: 0, tags: 1, seconds: 120 },
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

// Group aliases. The pre-registry --scenario values keep their meaning:
// core = the original smoke, edges = tag/offline/quote regressions.
export const GROUPS = Object.freeze({
  core: ['*.core.*'],
  edges: ['*.edges.*'],
  readonly: ['*.readonly'],
  ai: ['*.ai.*'],
  all: ['*'],
});

// Known gaps the Chinese summary lists under 未覆盖项 (research survey). An
// entry with coveredBy drops out once a module matching that glob ran.
export const UNCOVERED = Object.freeze([
  { text: 'Pinboard 回归 §9-17（popup/快捷/批量保存格式、含 " 标签）：--target user --service pinboard --scenario core', coveredBy: 'pinboard.core.save-paths' },
  { text: 'Pinboard §9-18（分隔符说明文案中英文读感）：需人工阅读，无模块' },
  { text: '稍后读快捷键（rl* 设置）与 linkding / Karakeep 的快捷保存、批量保存' },
  { text: 'linkding 共享开启分支（只在临时容器跑：--scenario linkding.sharing.*）', coveredBy: 'linkding.sharing.*' },
  { text: 'linkding 超长标签 500（只在临时 Postgres 跑：--scenario linkding-pg.limits.*）', coveredBy: 'linkding-pg.limits.*' },
  { text: '上千标签下的标签缓存、补全与治理性能（临时容器批量造标签，尚无模块）' },
  { text: 'linkding / Karakeep 网页本身的渲染（Notes Markdown、note 显示）' },
  { text: '真实工具栏弹窗尺寸、焦点与冷启动字体（标签页模式无法覆盖）' },
]);
