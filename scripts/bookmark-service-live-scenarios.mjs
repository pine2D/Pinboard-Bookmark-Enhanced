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
//               headed, shots, pinboard, writes, urls }
//   budget    { bookmarks, urls, node, browser, ai, tags, lists, seconds }
//             any field may be a number or { <service>: number }
//   settings  chrome.storage.local overrides applied for this module only
//   steps(t)  drives the extension; verify(t) reads back (optional)
//
// Budgets are per module and per service. The runner adds them up per
// instance, refuses a plan that exceeds the target's caps, and aborts the
// whole run when a module overruns its own row at run time.

export const LIST_MARKER = 'Pinboard Bookmark Enhanced: Read Later';
export const META_DESCRIPTION = 'Public synthetic meta description.';

const NEEDS = Object.freeze({
  fakeAi: false, target: 'any', container: null, sharing: 'any', headed: false,
  shots: false, pinboard: false, writes: true,
});
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

const noteOf = (t, row) => (t.service === 'linkding' ? row.notes : row.note);
const tagNamesOf = (t, row) => (t.service === 'linkding' ? row.tag_names : (row.tags || []).map(tag => tag.name));

async function karakeepLists(t, row) {
  return (await t.api('bookmarks/' + encodeURIComponent(row.id) + '/lists')).lists || [];
}

// ---- modules ---------------------------------------------------------------

export const MODULES = [
  {
    id: 'readonly',
    services: ['linkding', 'karakeep'],
    surfaces: ['options', 'popup'],
    features: ['connect', 'tags-recent', 'popup-prefill'],
    needs: needs({ writes: false }),
    budget: { bookmarks: 0, urls: 1, node: 4, browser: { linkding: 40, karakeep: 60 }, ai: 0, tags: 0, seconds: 90 },
    settings: {},
    async steps(t) {
      t.phase('readonly_extension');
      const result = await t.sw(async () => {
        const client = pbpBookmarkClient(await getCurrentBookmarkAuth());
        return { tags: (await client.tags()).length, recent: (await client.recent(2)).length };
      });
      t.check(`${t.service}: authenticated extension tags/recent passed (${result.tags} usable tags)`);
      t.phase('readonly_popup');
      const form = await t.openPopup(t.claimUrl());
      if (t.service === 'linkding') await linkdingPrefill(t, form.popup);
      t.check(`${t.service}: synthetic article popup prefill without saving`);
      await form.close();
    },
  },

  {
    id: 'core.popup-reader',
    services: ['linkding', 'karakeep'],
    surfaces: ['popup', 'reader'],
    features: ['popup-save', 'linkding-description', 'reader-read-later', 'reader-edit', 'reader-tag-separator', 'reader-delete'],
    needs: needs(),
    budget: { bookmarks: 1, urls: 1, node: 16, browser: { linkding: 90, karakeep: 130 }, ai: 0, tags: 2, lists: { karakeep: 1 }, seconds: 120 },
    settings: {},
    async steps(t) {
      const { prefix } = t;
      const url = t.claimUrl();
      t.phase('popup');
      const form = await t.openPopup(url);
      const { popup } = form;
      if (t.service === 'linkding') {
        await linkdingPrefill(t, popup);
        await popup.locator('#linkding-description-input').fill('手工描述，与笔记分开');
      }
      await popup.locator('#title-input').fill(prefix + ' 中文标题');
      await popup.locator('#description-input').fill('中文笔记\n第二行');
      await popup.locator('#tags-input').fill(prefix);
      await popup.locator('#tags-input').press('Enter');
      await t.savePopup(popup);
      let row = await t.ownRow(url);
      t.expectEq(row.title, prefix + ' 中文标题', 'popup_title');
      t.expectEq(noteOf(t, row), '中文笔记\n第二行', 'popup_note');
      if (t.service === 'linkding') {
        t.expectEq(row.shared, false, 'privacy');
        t.expectEq(row.description, '手工描述，与笔记分开', 'linkding_description');
      }
      await form.close();

      t.phase('reader_later');
      const reader = await t.openReader(url, { markdown: '# 合成文章\n\n不含个人资料。', title: '合成文章', ready: '#reader-bookmark-later' });
      await reader.locator('#reader-bookmark-later').click();
      await reader.waitForFunction(() => document.getElementById('reader-bookmark-later')?.getAttribute('aria-pressed') === 'true');
      row = await t.ownRow(url);
      if (t.service === 'linkding') t.expectEq(row.unread, true, 'read_later');
      else {
        const lists = await karakeepLists(t, row);
        t.expect(lists.some(l => l.type === 'manual' && !l.public && !l.hasCollaborators && l.userRole === 'owner'), 'private_read_later');
        t.expectEq(row.archived, false, 'later_changed_archive');
      }

      t.phase('reader_edit');
      await reader.waitForFunction(() => document.getElementById('reader-bookmark-save')?.getAttribute('aria-busy') === 'false');
      await reader.locator('#reader-bookmark-edit').click();
      await reader.locator('#reader-bookmark-title').fill(prefix + ' 已编辑');
      await reader.locator('#reader-bookmark-notes').fill('编辑后的笔记\n第二行');
      await reader.locator('#reader-bookmark-tags').fill(JSON.stringify(prefix + ' 空格'));
      await t.applyReader(reader);
      row = await t.ownRow(url);
      t.expectEq(row.title, prefix + ' 已编辑', 'reader_fields');
      t.expectEq(noteOf(t, row), '编辑后的笔记\n第二行', 'reader_fields');
      t.expect(tagNamesOf(t, row).includes(prefix + '_空格'), 'new_tag_separator');
      if (t.service === 'linkding') t.expectEq(row.description, '手工描述，与笔记分开', 'reader_preserves_description');

      t.phase('reader_mark_read');
      await reader.waitForFunction(() => document.getElementById('reader-bookmark-save')?.getAttribute('aria-busy') === 'false');
      await reader.locator('#reader-bookmark-save').click();
      await reader.waitForFunction(() => document.getElementById('reader-bookmark-later')?.getAttribute('aria-pressed') === 'false');
      row = await t.ownRow(url);
      if (t.service === 'linkding') t.expect(!row.unread, 'mark_read');
      else t.expect(!(await karakeepLists(t, row)).some(l => l.description === LIST_MARKER), 'remove_later');

      t.phase('reader_delete');
      await reader.waitForFunction(() => document.getElementById('reader-bookmark-save')?.getAttribute('aria-busy') === 'false');
      await reader.locator('#reader-bookmark-edit').click();
      await reader.locator('#reader-bookmark-delete').click();
      await reader.locator('.confirm-yes').click();
      await reader.waitForFunction(() => document.getElementById('reader-bookmark-status')?.textContent === 'Bookmark deleted');
      t.expect(await t.api(t.recordPath(row.id), { allow404: true }) === null, 'reader_delete');
      await reader.close();
      t.check(`${t.service}: popup save, reader Read Later/edit/tags/read/delete`);
    },
  },

  {
    id: 'core.worker',
    services: ['linkding', 'karakeep'],
    surfaces: ['background'],
    features: ['worker-create', 'worker-merge', 'worker-conflict', 'archived-preserved', 'linkding-snapshot', 'tags-recent', 'pinboard-required', 'shared-library'],
    needs: needs(),
    budget: { bookmarks: 1, urls: 1, node: { linkding: 75, karakeep: 12 }, browser: { linkding: 30, karakeep: 40 }, ai: 0, tags: 2, seconds: { linkding: 120, karakeep: 90 } },
    settings: {},
    async steps(t) {
      const { prefix } = t;
      const url = t.claimUrl();
      t.phase('worker_create');
      const intent = { mode: 'create', url, title: prefix + ' 第二条', notes: '第二条笔记', tags: JSON.stringify(prefix + ' 空格'), private: true, toread: false, archive: false };
      const submit = value => t.sw(async intent => {
        const result = await submitSaveIntent(intent);
        return { status: result.status, reason: result.reason };
      }, value);
      t.expectEq((await submit(intent)).status, 'saved', 'worker_create');
      let row = await t.ownRow(url);
      t.phase('worker_merge');
      await t.api(t.recordPath(row.id), { method: 'PATCH', body: t.service === 'linkding' ? { is_archived: true } : { archived: true } });
      t.expectEq((await submit({ ...intent, mode: 'merge', title: 'must preserve original', notes: '', tags: prefix })).status, 'saved', 'worker_merge');
      row = await t.ownRow(url);
      t.expectEq(row.title, intent.title, 'merge_preserves_fields');
      t.expectEq(t.service === 'linkding' ? row.is_archived : row.archived, true, 'merge_preserves_fields');
      t.phase('worker_conflict');
      t.expectEq((await submit(intent)).reason, 'conflict', 'duplicate_create');
      if (t.service === 'linkding') {
        t.phase('linkding_snapshot');
        let status = 'missing';
        // Inside the 120 s module cap (a temporary instance took about 60 s).
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
          const assets = await t.api('bookmarks/' + row.id + '/assets/');
          status = assets.results.find(a => a.asset_type === 'snapshot')?.status || 'missing';
          if (['complete', 'failure'].includes(status)) break;
          await t.sleep(2000);
        }
        t.note('snapshot', status);
        t.expectEq(status, 'complete', 'snapshot_incomplete');
      }
      t.phase('worker_tags_recent');
      const data = await t.sw(async () => {
        const client = pbpBookmarkClient(await getCurrentBookmarkAuth());
        return { tags: (await client.tags()).length, recent: (await client.recent(2)).length };
      });
      t.expect(data.tags >= 1 && data.recent >= 0, 'tags_recent');
      t.expect(await t.sw(async () => !(await pbpReadSettingsWithSecrets({ pinboardToken: '' })).pinboardToken), 'pinboard_required');
      t.expectEq(await t.sw(() => pbpVocabCurrentOwner()), t.libraryOwner, 'library_changed');
      t.check(`${t.service}: worker create/merge/duplicate, archived-field preservation, tags/recent, shared library${t.service === 'linkding' ? ', HTML snapshot' : ''}`);
    },
  },

  {
    id: 'edges.tags',
    services: ['karakeep'],
    surfaces: ['popup', 'reader'],
    features: ['native-space-tag', 'tag-spelling-alignment', 'malformed-quote', 'library-majority', 'no-twin-tags'],
    needs: needs(),
    budget: { bookmarks: 4, urls: 4, node: 30, browser: 120, ai: 0, tags: 5, seconds: 120 },
    settings: { optBlockquote: true, optAutoDescription: true, optRespectTagCase: true, tagSyncMode: 'fresh' },
    async steps(t) {
      const { prefix } = t;
      const urls = [t.claimUrl(), t.claimUrl(), t.claimUrl(), t.claimUrl()];
      t.phase('karakeep_seed_spellings');
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
      t.phase('karakeep_popup_existing_tags');
      const form = await t.openPopup(url);
      await form.popup.waitForFunction(name => allUserTagCounts[name] === 2, names.majority);
      const chips = await form.popup.locator('#tags-display .tag-item').allTextContents();
      t.expect(chips.length === 3 && chips.includes(names.own) && chips.includes(names.double), 'existing_tags_single_chips');
      await form.popup.locator('#title-input').fill(prefix + ' popup updated');
      await t.savePopup(form.popup);
      await preserved('popup_preserves_existing_tag_ids');
      await form.close();

      t.phase('karakeep_reader_tag_boundaries');
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

      t.phase('karakeep_library_majority');
      const fresh = await t.openPopup(urls[3]);
      await fresh.popup.waitForFunction(name => allUserTagCounts[name] === 2, names.majority);
      await fresh.popup.locator('#tags-input').fill(JSON.stringify(names.minority));
      await fresh.popup.locator('#tags-input').press('Enter');
      t.expect((await fresh.popup.locator('#tags-display .tag-item').allTextContents()).includes(names.majority), 'popup_library_majority_chip');
      await t.savePopup(fresh.popup);
      const added = await t.ownRow(urls[3]);
      t.expect(added.tags.length === 1 && added.tags[0].name === names.majority, 'library_majority_reused');
      await fresh.close();
      const runTags = await t.sw(async prefix => (await pbpBookmarkClient(await getCurrentBookmarkAuth()).tags()).filter(tag => tag.name.startsWith(prefix)), prefix);
      t.expect(runTags.length === 5 && runTags.every(tag => Object.values(names).includes(tag.name)), 'unexpected_twin_tag');
      t.check('karakeep: existing space/double-space tag IDs preserved in popup and reader; own spelling beats library majority; malformed quote sends no writes; alignment-off preservation; new bookmark reuses majority without a twin');
    },
  },

  {
    id: 'edges.quote-unread',
    services: ['linkding'],
    surfaces: ['popup'],
    features: ['selection-quote-escape', 'quote-description-separate', 'unread-link'],
    needs: needs(),
    budget: { bookmarks: 1, urls: 1, node: 4, browser: 40, ai: 0, tags: 0, seconds: 90 },
    settings: { optBlockquote: true, optAutoDescription: true, optRespectTagCase: true, tagSyncMode: 'fresh' },
    async steps(t) {
      t.phase('linkding_quote_and_unread');
      const url = t.claimUrl();
      const quote = await t.openPopup(url, { selection: true });
      const expectedQuote = '> First line\n>\n> \\# Heading\n> \\*\\*bold\\*\\* &lt;tag>\n> 1\\. item';
      t.expectEq(await quote.popup.locator('#description-input').inputValue(), expectedQuote, 'selection_markdown_source');
      t.expectEq(await quote.popup.locator('#linkding-description-input').inputValue(), META_DESCRIPTION, 'quote_description_separate');
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
    budget: { bookmarks: 1, urls: 1, node: 6, browser: 60, ai: 0, tags: 1, seconds: 120 },
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

      t.phase('linkding_offline_create');
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
      await t.settings({ aiTagSeparator: '-' });
      await replay(form, 'offline_create_replay');
      let row = await t.ownRow(url);
      t.expect(row.description === 'Offline description' && row.notes === 'Offline notes\nSecond line' && row.unread === true && row.shared === false, 'offline_create_fields');
      t.expect(row.tag_names.length === 1 && row.tag_names[0] === tag, 'offline_replay_reminted_tag');
      await form.close();

      t.phase('linkding_offline_update');
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

      t.phase('sharing_popup_new');
      let form = await open('');
      let { popup } = form;
      t.expect(await popup.locator('#private-check').isHidden(), 'linkding_private_control');
      t.expect(!await popup.locator('#share-check').isChecked(), 'linkding_default_shared');
      await popup.locator('#title-input').fill(title);
      await popup.locator('#tags-input').fill(prefix);
      await popup.locator('#tags-input').press('Enter');
      await t.savePopup(popup);
      let row = await t.ownRow(url);
      t.expectEq(row.shared, false, 'new_bookmark_shared');
      await form.close();

      t.phase('sharing_popup_explicit');
      form = await open(title);
      popup = form.popup;
      t.expect(!await popup.locator('#share-check').isChecked(), 'existing_shared_prefill');
      await popup.locator('#share-check').check();
      await t.savePopup(popup);
      row = await t.ownRow(url);
      t.expectEq(row.shared, true, 'explicit_share');
      await form.close();

      t.phase('sharing_popup_untouched');
      form = await open(title);
      popup = form.popup;
      t.expect(await popup.locator('#share-check').isChecked(), 'existing_shared_prefill');
      await popup.locator('#title-input').fill(title + ' edited');
      await t.savePopup(popup);
      row = await t.ownRow(url);
      t.expectEq(row.title, title + ' edited', 'popup_title');
      t.expectEq(row.shared, true, 'untouched_share_changed');
      await form.close();

      t.phase('sharing_reader_edit');
      let reader = await t.openReader(url, { ready: '#reader-bookmark-edit' });
      await reader.locator('#reader-bookmark-edit').click();
      await reader.locator('#reader-bookmark-notes').fill('reader notes');
      await t.applyReader(reader);
      row = await t.ownRow(url);
      t.expectEq(row.notes, 'reader notes', 'reader_fields');
      t.expectEq(row.shared, true, 'reader_edit_changed_share');
      await reader.close();

      t.phase('sharing_reader_new');
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

      t.phase('long_tag_server');
      const direct = t.claimUrl();
      const res = await t.api('bookmarks/', { method: 'POST', body: { url: direct, title: prefix + ' long tag (API)', tag_names: [long], is_archived: false, unread: false, shared: false }, allowStatus: [500] });
      t.expectEq(res?.failedStatus, 500, 'long_tag_server_status');
      // A non-atomic create may leave the bookmark without its tag; run
      // cleanup adopts such pool URLs, so this is only recorded.
      t.note('serverPartialCreate', !!(await t.api('bookmarks/check/?url=' + encodeURIComponent(direct)))?.bookmark);

      t.phase('long_tag_popup');
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
  all: ['*'],
});

// Known gaps the Chinese summary lists under 未覆盖项 (research survey). An
// entry with coveredBy drops out once a module matching that glob ran.
export const UNCOVERED = Object.freeze([
  { text: 'Pinboard 真实回归（§9-17/18）：等待 pinboardToken，注册表暂无 Pinboard 模块' },
  { text: '快捷保存与稍后读（saveFromBackground，qs*/rl* 设置）' },
  { text: '批量保存（startBatchSave，batchAi*）' },
  { text: 'linkding 共享开启分支（只在临时容器跑：--scenario linkding.sharing.*）', coveredBy: 'linkding.sharing.*' },
  { text: 'linkding 超长标签 500（只在临时 Postgres 跑：--scenario linkding-pg.limits.*）', coveredBy: 'linkding-pg.limits.*' },
  { text: '上千标签下的标签缓存、补全与治理性能（临时容器批量造标签，尚无模块）' },
  { text: 'linkding / Karakeep 网页本身的渲染（Notes Markdown、note 显示）' },
  { text: '真实工具栏弹窗尺寸、焦点与冷启动字体（标签页模式无法覆盖）' },
]);
