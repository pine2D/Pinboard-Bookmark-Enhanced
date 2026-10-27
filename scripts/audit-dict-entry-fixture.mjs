// Render-only service boundaries. Free Dictionary and AI response fields are
// handwritten data; production request guards, parser, cache and UI run unchanged.
// No request reaches a real provider and no permission prompt is opened.
export async function installDictEntryFixture(page) {
  await page.evaluate(async () => {
    // Explanations intentionally remain Chinese while the surrounding controls
    // exercise every UI locale. This is an explicit language preference, not an
    // inference about the learner's native language.
    await chrome.storage.local.set({ dictDefaultView: "ai-saved", dictDefinitionLang: "zh-Hans" });
    if (typeof _pbpExplainSettings === "object" && _pbpExplainSettings) {
      Object.assign(_pbpExplainSettings, { dictDefaultView: "ai-saved", dictDefinitionLang: "zh-Hans" });
    }
    _pbpDictHasPerm = async () => true;
    _pbpDictCacheGet = async () => null;
    _pbpDictFetch = async (lang, term) => ({ status: 200, data: {
      word: term, entries: [{ language: { code: lang, name: 'English' }, partOfSpeech: 'noun',
        pronunciations: [], forms: [], synonyms: [], antonyms: [], senses: [
          { definition: 'An original dictionary definition. Its wording remains available when you switch sources.', tags: [], examples: [], quotes: [], synonyms: [], antonyms: [], subsenses: [] },
          { definition: 'Another common meaning from the original dictionary.', tags: [], examples: [], quotes: [], synonyms: [], antonyms: [], subsenses: [] }
        ] },
        // A one-sense entry: the lone-sense list is its own layout case
        // (render-audit DICT_LOOKUP_GEOMETRY: a lone sense stays indented).
        { language: { code: lang, name: 'English' }, partOfSpeech: 'verb',
          pronunciations: [], forms: [], synonyms: [], antonyms: [], senses: [
            { definition: 'The only verb sense in the original dictionary.', tags: [], examples: [], quotes: [], synonyms: [], antonyms: [], subsenses: [] }
          ] }], source: { url: 'https://en.wiktionary.org/wiki/fixture', license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' } }
    } });
    ensureAIHostPermissionWithGesture = async () => true;
    requestAIHostPermissions = async () => true;
    // Etymology finds no source. The free examples entry runs unchanged on top
    // of this hand-written evidence record (MediaWiki-derived fields as
    // pbpDictEvidenceFetch returns them); the guard still runs per request.
    pbpDictEvidenceFetch = async input => {
      if (input.kind !== "literature") return [];
      await input.beforeRequest();
      // The negative state's first search is a clean miss (plan 1C.4).
      if (window._auditDictEntry?.examplesMiss) return [];
      return [{ title: 'The Works of Charles Dickens/Volume 1/Chapter 14', url: 'https://en.wikisource.org/w/index.php?oldid=13788016',
        excerpt: 'It was a long sentence of the kind a lookup column has to wrap, with the queried word in the middle of its original context and a clause after it.',
        author: 'Charles Dickens', work: 'The Pickwick Papers', location: 'Chapter XIV · ¶ 2', language: 'en', genre: 'novel',
        revision: '13788016', retrievedAt: 1792800000000, truncated: true }];
    };
    // The examples action asks Chrome for one exact Wikisource origin; the
    // render fixture answers for Chrome so no permission prompt opens.
    _pbpDictExamplesRequestOrigin = async () => true;
    const cache = new Map();
    window._auditDictEntry = { entered: false, release: null, fail: false, calls: 0, reads: 0, cache };
    // Exercise the production archive against a fresh, isolated database. A
    // scenario reset discards only its fixture store, never the user's archive.
    window._auditDictEntry.resetArchive = async () => {
      if (_pbpDictArchiveStore) await _pbpDictArchiveStore.close();
      const dbName = "dict-render-" + crypto.randomUUID();
      _pbpDictArchiveStore = pbpCreateDictArchiveStore({ dbName, readLegacy: async () => [] });
      const store = _pbpDictArchiveStore, read = store.read;
      store.read = async input => {
        window._auditDictEntry.reads++;
        if (window._auditDictEntry.legacySeed) {
          window._auditDictEntry.legacySeed = false;
          // A seed the archive refuses is a broken fixture, never a silent miss.
          try { await seedLegacy(dbName, input); window._auditDictEntry.legacySeeded = true; }
          catch (error) { window._auditDictEntry.legacySeedError = (error?.code || error?.name || 'error') + ': ' + error?.message; }
        }
        return read(input);
      };
    };
    // The legacy state (plan 1B.7/1C.3): records an earlier version saved in
    // categories that can no longer be generated -- a literature quotation
    // with its AI translation, a culture explanation citing Wikipedia, and a
    // plain-text collocations record requested for a topic. They are written
    // through the production archive (its own validation runs) into the
    // fixture database for the lookup's real identity, so the page reads them
    // back as saved data. The seeding store answers the lookup's own owner,
    // which also covers a signed-out reader fixture (owner ""), and is not
    // bound to the reading query: the first read can belong to a lookup that
    // a settings change is already replacing, and the next one reads the seed.
    const seedLegacy = async (dbName, input) => {
      const store = pbpCreateDictArchiveStore({ dbName, readLegacy: async () => [], getCurrentOwner: async () => input.owner });
      const base = { owner: input.owner, term: input.term, sourceLanguage: input.sourceLanguage, target: input.target, isCurrent: () => true };
      const saved = await store.save({ ...base, record: { provider: 'fixture-provider', model: 'fixture-model-2025', generatedAt: 1760000000000, entry: {
        word: input.term, language: input.sourceLanguage, pronunciation: '/ˈwɜːd/', etymology: '', relatedWords: [], meanings: [
          { partOfSpeech: '名词', definition: '早先保存的一条 AI 释义，用来承载旧类别的补充。',
            examples: [{ text: 'An earlier saved example sentence.', translation: '一句早先保存的例句。' }] }
        ] } } });
      const language = { name: input.target.name, lang: input.target.lang };
      const common = { owner: input.owner, archiveId: saved.archiveId, provider: 'fixture-provider', model: 'fixture-model-2025',
        profile: { nativeLanguage: '', level: '', topic: '' }, isCurrent: () => true };
      const quotation = 'It was the best of times, it was the worst of times, and the queried word sat in the middle of a long original sentence.';
      await store.append({ ...common, generatedAt: 1760000001000, category: 'literature', content: '文学用例：原文引文与译文。',
        sources: [{ title: 'A Tale of Two Cities/Book 1/Chapter 1', url: 'https://en.wikisource.org/w/index.php?oldid=11223344', excerpt: quotation,
          author: 'Charles Dickens', work: 'A Tale of Two Cities', location: 'Book 1 · Chapter 1 · ¶ 1', language: 'en', genre: 'novel',
          revision: '11223344', retrievedAt: 1760000000500 }],
        learning: { version: 2, language, summary: '', replacesId: '', items: [{ sense: 1, title: 'the best of times',
          explanation: '小说开篇用这个词铺陈对照，读者据此进入时代背景。', example: quotation,
          translation: '那是最好的时代，也是最坏的时代，这个词就在一句很长的原文中间。', sourceIndex: 0 }] } });
      await store.append({ ...common, generatedAt: 1760000002000, category: 'culture', content: '文化用法：社群中的引申义。',
        sources: [{ title: 'Word (community usage)', url: 'https://en.wikipedia.org/w/index.php?oldid=55667788', excerpt: 'In this community the word is used for a distant ideal.',
          author: '', work: 'Word (community usage)', location: '¶ 1', language: 'en', genre: 'culture', revision: '55667788', retrievedAt: 1760000001500 }],
        learning: { version: 2, language, summary: '', replacesId: '', items: [{ sense: 1, title: 'a distant ideal',
          explanation: '在该社群中引申为遥不可及的理想，多见于讨论帖。', example: '', translation: '', sourceIndex: 0 }] } });
      await store.append({ ...common, generatedAt: 1760000003000, category: 'collocations', profile: { nativeLanguage: '', level: '', topic: 'work' },
        content: '早先按话题“work”保存的搭配说明：make a word count、keep one’s word。这是没有结构化条目的旧式纯文本补充。', sources: [] });
      await store.close();
    };
    await window._auditDictEntry.resetArchive();
    pbpAiCacheGet = async key => {
      window._auditDictEntry.reads++;
      return cache.has(key) ? structuredClone(cache.get(key)) : null;
    };
    pbpAiCacheSet = async (key, result, ts) => { cache.set(key, structuredClone({ result, ts })); return true; };
    // Dictionary generation streams (plan 2.7), so one callAIStream stub
    // serves both callers: the dictionary is the only one that declares
    // requireComplete with jsonMode and gets the whole answer at the end; the
    // ordinary Explain opener (also used by other reader sweep states) keeps
    // its article explanation. callAI is no longer a dictionary path at all.
    const dictionaryAnswer = async (_settings, prompt, opts) => {
      await opts.beforeRequest?.(); opts.signal?.throwIfAborted();
      let lookup;
      try { lookup = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)); } catch (_) {}
      if (lookup?.profile && lookup?.baseEntry) {
        if (lookup.targetLanguage?.lang !== 'zh-Hans' || lookup.sources?.length) throw new Error('SETUP: unexpected supplement request');
        const state = window._auditDictEntry;
        state.usageEntered = true; state.calls++;
        await new Promise(resolve => { state.usageRelease = resolve; });
        opts.signal?.throwIfAborted();
        if (state.usageFail) throw Object.assign(new Error('Synthetic truncated completion'), { code: 'output_truncated', status: 200 });
        // No etymology source is fixtured, so production asks for modern
        // formation only (plan 1B.4) and drops any other kind.
        if (lookup.category === 'etymology') return JSON.stringify({ language: 'zh-Hans', summary: '从构词成分理解这个词的含义。', items: [
          { sense: 0, kind: 'formation', title: 'word + -ing', explanation: '词根加上后缀，表示与该动作相关的过程或结果。', sourceIndex: -1 },
          { sense: 0, kind: 'formation', title: 'word + -less', explanation: '词根加上表示缺少的后缀，构成形容词。', sourceIndex: -1 }
        ] });
        return JSON.stringify({ language: 'zh-Hans', summary: '先选定要表达的含义，再选择与情境相符的搭配。以下为独立编写的例句。', items: [
          { sense: 1, title: 'a practical example', explanation: '用于把抽象的说明落实到可操作的例子中，适合讨论工作方法或学习步骤。', example: 'Please give us a practical example.', translation: '请给我们一个实际的例子。', sourceIndex: -1 },
          { sense: 2, title: 'a clear expression of an idea', explanation: '强调想法表达得明确，读者能够据此区分不同含义；可根据需要替换后面的名词。', example: 'This is a clear expression of the main idea.', translation: '这清楚地表达了中心思想。', sourceIndex: -1 }
        ] });
      }
      if (!lookup || Object.keys(lookup).sort().join(',') !== 'sourceLanguage,targetLanguage,term' ||
        !lookup.term || !lookup.sourceLanguage || lookup.targetLanguage?.lang !== 'zh-Hans') {
        throw new Error('SETUP: expected a reusable dictionary entry request without article or dictionary content');
      }
      const state = window._auditDictEntry;
      // The stream's phase reporter (plan 2.6): the progress state calls it
      // the way ai.js does, synchronously and with the phase alone.
      state.progress = opts.onProgress || null;
      state.entered = true; state.calls++;
      await new Promise(resolve => { state.release = resolve; });
      opts.signal?.throwIfAborted();
      if (state.fail) return '{"word":"invalid","execute":"not a dictionary entry"}';
      // Only request identity is echoed. All response content and protocol
      // fields are literals, never created by the parser/normalizer under test.
      return JSON.stringify({ word: lookup.term, language: lookup.sourceLanguage,
        pronunciation: '/ˈwɜːd/', meanings: [
          { partOfSpeech: '名词', definition: '用于日常表达的一种含义；这是一条独立的词条说明。',
            examples: [{ text: 'This is an original example sentence.', translation: '这是一句独立编写的例句。' }] },
          { partOfSpeech: '名词', definition: '另一种常见含义，便于区分不同用法。',
            examples: [{ text: 'The second example illustrates another use.', translation: '第二句例句展示另一种用法。' }] }
        ] });
    };
    callAIStream = async (settings, prompt, opts = {}) => (opts?.requireComplete === true && opts?.jsonMode === true
      ? dictionaryAnswer(settings, prompt, opts) : 'A short article-specific explanation for this render fixture.');
    callAI = async () => { throw new Error('SETUP: dictionary generation must stream through callAIStream'); };
  });
}

const USAGE_ACTION = '[data-learning-block="usage"] .xp-dict-supplement-generate[data-category="confusables"]';
const USAGE_ROW = '[data-learning-block="usage"] .xp-dict-usage-actions:has(> [data-category="confusables"])';
const ENTRY_PROGRESS = '.xp-dict-ai > .xp-dict-usage-feedback[data-state="busy"]';

// A state that changes AI settings has to let the lookup's own rerun on that
// change land before it reruns the lookup again, or the settings rerun can
// replace the view the state is checking. The readiness is observed, not
// timed: armSettingsChange snapshots the given storage keys and marks the
// open view; settingsChangeSettled then returns at once when the write left
// those keys unchanged (Chrome fires no change event, so no rerun is coming),
// and otherwise waits for the change event and for the marked view to be
// replaced by the rerun's own view.
async function armSettingsChange(page, keys) {
  await page.evaluate(async keys => {
    const before = await chrome.storage.local.get(keys);
    const probe = { keys, before: JSON.stringify(keys.map(key => before[key])), events: 0 };
    probe.listener = (changes, area) => { if (area === 'local' && keys.some(key => key in changes)) probe.events++; };
    chrome.storage.onChanged.addListener(probe.listener);
    for (const view of document.querySelectorAll('.xp-dict-ai')) view.dataset.auditSettingsStale = 'true';
    window._auditDictEntry.settingsProbe = probe;
  }, keys);
}
async function settingsChangeSettled(page) {
  const changed = await page.evaluate(async () => {
    const probe = window._auditDictEntry.settingsProbe;
    const after = await chrome.storage.local.get(probe.keys);
    return JSON.stringify(probe.keys.map(key => after[key])) !== probe.before;
  });
  try {
    if (changed) {
      await page.waitForFunction(() => window._auditDictEntry.settingsProbe.events > 0 &&
        !document.querySelector('.xp-dict-ai[data-audit-settings-stale]') && !!document.querySelector('.xp-dict-ai'),
        null, { timeout: 10000 });
    }
  } catch (error) {
    throw new Error('SETUP: the settings change did not rerun the open lookup: ' + error.message);
  } finally {
    await page.evaluate(() => {
      const probe = window._auditDictEntry.settingsProbe;
      chrome.storage.onChanged.removeListener(probe.listener);
      for (const view of document.querySelectorAll('.xp-dict-ai[data-audit-settings-stale]')) delete view.dataset.auditSettingsStale;
      window._auditDictEntry.settingsProbe = null;
    });
  }
}

async function rerunLookup(page) {
  if (await page.locator('#vocab-lookup-go').count()) await page.locator('#vocab-lookup-go').click();
  else await page.locator('.xp-dict-query-tools > .xp-dict-lang').selectOption('en');
}

export async function openDictEntryState(page, state) {
  const action = page.locator('.xp-dict-ai-generate');
  const result = page.locator('.xp-dict-ai-content:not([hidden])');
  if (state === 'idle') {
    await page.locator('.xp-dict-ai-generate:not([disabled])').waitFor();
    const calls = await page.evaluate(() => window._auditDictEntry.calls);
    if (calls !== 0) throw new Error('SETUP: manual-by-default lookup unexpectedly called AI');
    return action.isVisible();
  }
  if (state === 'busy') {
    await action.click();
    await page.waitForFunction(() => window._auditDictEntry?.entered);
    return page.locator(ENTRY_PROGRESS + ' .xp-dict-usage-stop').isVisible();
  }
  if (state === 'progress') {
    // The pending generation moves through thinking to streaming; the line
    // shows the streaming phase and, once a real second has passed since the
    // click, a nonzero count of seconds waited.
    await page.evaluate(() => {
      const report = window._auditDictEntry?.progress;
      if (typeof report !== 'function') throw new Error('SETUP: the pending entry generation has no phase reporter');
      report({ phase: 'thinking' }); report({ phase: 'streaming' });
    });
    await page.waitForFunction(selector => {
      const line = document.querySelector(selector);
      const elapsed = line?.querySelector('.xp-dict-usage-elapsed:not([hidden])')?.textContent || '';
      return !!line && line.querySelector('.xp-dict-usage-status')?.textContent === t('dictProgressStreaming') &&
        !!elapsed && elapsed !== t('dictProgressElapsed', '0');
    }, ENTRY_PROGRESS, { timeout: 5000 });
    return page.locator(ENTRY_PROGRESS + ' .xp-dict-usage-elapsed').isVisible();
  }
  if (state === 'result') {
    await page.evaluate(() => {
      if (!window._auditDictEntry?.release) throw new Error('SETUP: no pending entry generation');
      window._auditDictEntry.release();
    });
    await result.waitFor();
    return page.locator('.xp-dict-ai-switch:not([hidden])').isVisible();
  }
  if (state === 'details') {
    // The etymology block's own paid button (redesign 1B.8): no disclosure
    // to open, and its saved result is shown open in the block.
    const action = page.locator('.xp-dict-supplement-generate[data-category="etymology"]');
    await action.click();
    await page.waitForFunction(() => window._auditDictEntry?.usageEntered);
    await page.evaluate(() => window._auditDictEntry.usageRelease());
    const details = page.locator('.xp-dict-ai-details[data-supplement-id][open]').first();
    await details.locator('.xp-dict-supplement-text').waitFor({ state: 'visible' });
    // The scenario audits the opened state. User-triggered folds now animate;
    // wait for their actual endpoint rather than sampling the first frame.
    await details.evaluate(async node => {
      await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    return details.locator('.xp-dict-supplement-text').isVisible();
  }
  if (state === 'usage-busy') {
    // The usage-points block's "confusables" button; its answer is the v2
    // items shape above. Each paid category fails and saves on its own row.
    await page.evaluate(() => Object.assign(window._auditDictEntry, { usageEntered: false, usageRelease: null, usageFail: true }));
    await page.locator(USAGE_ACTION).click();
    await page.waitForFunction(() => window._auditDictEntry.usageEntered);
    return page.locator(USAGE_ROW + ' .xp-dict-usage-stop:not([hidden])').isVisible();
  }
  if (state === 'usage-error') {
    await page.evaluate(() => window._auditDictEntry.usageRelease());
    await page.locator(USAGE_ROW + ' .xp-dict-usage-feedback[data-state="error"]').waitFor();
    return page.locator(USAGE_ACTION).isVisible();
  }
  if (state === 'usage-result') {
    await page.evaluate(() => Object.assign(window._auditDictEntry, { usageEntered: false, usageRelease: null, usageFail: false }));
    await page.locator(USAGE_ACTION).click();
    await page.waitForFunction(() => window._auditDictEntry.usageEntered);
    await page.evaluate(() => window._auditDictEntry.usageRelease());
    await page.locator(USAGE_ROW + ' .xp-dict-usage-feedback[data-state="saved"]').waitFor();
    // The saved result replaces its button and opens in the block.
    const saved = page.locator('[data-learning-block="usage"] [data-supplement-category="confusables"][open]');
    await saved.evaluate(async node => {
      await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    return saved.locator('.xp-dict-supplement-text').isVisible();
  }
  if (state === 'panel') {
    await page.locator('#explain-pop .xp-dock').click();
    const session = page.locator('#ask-panel:not([hidden])[data-view="dict"] .reader-dict-session');
    await session.waitFor();
    await page.locator('#ask-panel').evaluate(async node => {
      await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    return session.isVisible();
  }
  if (state === 'cached') {
    const before = await page.evaluate(() => ({ calls: window._auditDictEntry.calls, reads: window._auditDictEntry.reads }));
    await rerunLookup(page);
    await result.waitFor();
    await page.waitForFunction(previous => window._auditDictEntry.reads > previous.reads, before);
    const calls = await page.evaluate(() => window._auditDictEntry.calls);
    if (calls !== before.calls) throw new Error('SETUP: cached lookup issued another AI request');
    return result.isVisible();
  }
  if (state === 'error') {
    await page.evaluate(async () => {
      window._auditDictEntry.cache.clear();
      await window._auditDictEntry.resetArchive();
      Object.assign(window._auditDictEntry, { fail: true, entered: false, release: null });
    });
    await rerunLookup(page);
    await page.locator('.xp-dict-ai-generate:not([disabled])').waitFor();
    await action.click();
    await page.waitForFunction(() => window._auditDictEntry?.entered);
    await page.evaluate(() => window._auditDictEntry.release());
    await page.waitForFunction(() => document.querySelector('.xp-dict-ai')?.getAttribute('aria-busy') === 'false' &&
      document.querySelector('.xp-dict-ai-status')?.textContent === t('dictSupplementInvalid'));
    return page.locator('.xp-dict-ai-status:not([hidden])').isVisible();
  }
  if (state === 'examples') {
    // Free original-text examples (plan 1C.2): no AI key and no AI entry.
    await armSettingsChange(page, ['openaiApiKey']);
    await page.evaluate(async () => {
      await chrome.storage.local.remove(['openaiApiKey']);
      if (typeof _pbpExplainSettings === 'object' && _pbpExplainSettings) delete _pbpExplainSettings.openaiApiKey;
      window._auditDictEntry.cache.clear();
      await window._auditDictEntry.resetArchive();
    });
    // The open lookup reruns on the settings change; rerun once more so the
    // checked view is the one built without a key.
    await settingsChangeSettled(page);
    await rerunLookup(page);
    await page.locator('.xp-dict-ai-configure:not([hidden])').waitFor();
    const before = await page.evaluate(() => window._auditDictEntry.calls);
    const find = page.locator('.xp-dict-examples .xp-dict-examples-find');
    await find.click();
    const item = page.locator('.xp-dict-examples .xp-dict-learning-item');
    await item.waitFor();
    if (await page.evaluate(() => window._auditDictEntry.calls) !== before) throw new Error('SETUP: free examples issued an AI request');
    return item.isVisible();
  }
  if (state === 'negative') {
    // Plan 1C.4: a real clean miss in a supported language writes the local
    // empty-result memory; the next lookup opens on "last time not found ·
    // retry" with the retrieval note. No AI key, no AI entry, no AI call.
    await armSettingsChange(page, ['openaiApiKey']);
    await page.evaluate(async () => {
      await chrome.storage.local.remove(['openaiApiKey']);
      if (typeof _pbpExplainSettings === 'object' && _pbpExplainSettings) delete _pbpExplainSettings.openaiApiKey;
      window._auditDictEntry.cache.clear();
      await window._auditDictEntry.resetArchive();
      window._auditDictEntry.examplesMiss = true;
    });
    await settingsChangeSettled(page);
    await rerunLookup(page);
    await page.locator('.xp-dict-ai-configure:not([hidden])').waitFor();
    const before = await page.evaluate(() => window._auditDictEntry.calls);
    const find = page.locator('.xp-dict-examples .xp-dict-examples-find');
    await find.waitFor();
    if (await find.getAttribute('data-remembered') !== 'true') {
      await find.click();
      await page.locator('.xp-dict-examples .xp-dict-usage-feedback[data-state="neutral"]').waitFor();
      const stored = await page.evaluate(async () => {
        for (let i = 0; i < 40; i++) {
          if (Object.keys(await chrome.storage.local.get(null)).some(key => key.startsWith('pbpDictNeg:'))) return true;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
      });
      if (!stored) throw new Error('SETUP: the clean miss left no local empty-result memory (is the fixture signed in?)');
      await rerunLookup(page);
    }
    const remembered = page.locator('.xp-dict-examples .xp-dict-examples-find[data-remembered="true"]');
    await remembered.waitFor();
    await page.evaluate(() => { window._auditDictEntry.examplesMiss = false; });
    if (await page.evaluate(() => window._auditDictEntry.calls) !== before) throw new Error('SETUP: free examples issued an AI request');
    return remembered.isVisible();
  }
  if (state === 'legacy') {
    // Old literature, culture and topic collocations records stay readable
    // with the old-category label and no update (plan 1B.7, 1C.3); reading
    // them needs no AI key and makes no request. Each fold is opened the way
    // a reader would, so its content is what the geometry checks measure.
    // The fixture key is configured here (the free states before this one
    // remove it, and the sweep seeds none when only free states run): without
    // it no record offers an update at all, and the no-update guard below
    // would pass on any code. Reading still issues no AI request.
    // The empty-result memory an earlier state left (an etymology retrieval
    // that found no source) is cleared too: this state is about old-category
    // records, not about a remembered paid action.
    await armSettingsChange(page, ['aiProvider', 'openaiApiKey', 'previewAiEnabled']);
    await page.evaluate(async () => {
      await chrome.storage.local.remove(Object.keys(await chrome.storage.local.get(null)).filter(key => key.startsWith('pbpDictNeg:')));
      await chrome.storage.local.set({ aiProvider: 'openai', openaiApiKey: obfuscateKey('render-fixture-key'), previewAiEnabled: true });
      if (typeof _pbpExplainSettings === 'object' && _pbpExplainSettings) {
        Object.assign(_pbpExplainSettings, { aiProvider: 'openai', openaiApiKey: 'render-fixture-key', previewAiEnabled: true });
      }
      window._auditDictEntry.cache.clear();
      await window._auditDictEntry.resetArchive();
      Object.assign(window._auditDictEntry, { legacySeed: true, legacySeeded: false, legacySeedError: '' });
    });
    // The open lookup reruns on the settings change; rerun once more so the
    // checked view is the one built with the key.
    await settingsChangeSettled(page);
    const before = await page.evaluate(() => window._auditDictEntry.calls);
    await rerunLookup(page);
    await page.waitForFunction(() => window._auditDictEntry.legacySeeded || window._auditDictEntry.legacySeedError);
    const seedError = await page.evaluate(() => window._auditDictEntry.legacySeedError);
    if (seedError) throw new Error('SETUP: the archive refused the old-category seed: ' + seedError);
    for (const category of ['literature', 'culture', 'collocations']) {
      const section = page.locator(`.xp-dict-ai-details[data-supplement-category="${category}"]`);
      await section.waitFor();
      if (!(await section.evaluate(node => node.open))) await section.locator(':scope > summary').click();
      await section.locator('.xp-dict-supplement-text').waitFor({ state: 'visible' });
      await section.evaluate(async node => {
        await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
      });
    }
    const legacy = await page.evaluate(() => ({
      labelled: ['literature', 'culture', 'collocations'].every(category =>
        document.querySelector(`.xp-dict-ai-details[data-supplement-category="${category}"] > summary`)?.textContent.endsWith(t('dictSupplementLegacyCategory'))),
      updates: document.querySelectorAll('.xp-dict-ai-details[data-supplement-category] .xp-dict-update-supplement').length,
      // A paid action on screen proves the key reached this view.
      paid: document.querySelectorAll('.xp-dict-supplement-generate:not([hidden])').length,
      calls: window._auditDictEntry.calls }));
    if (!legacy.paid) throw new Error('SETUP: the legacy view has no configured AI key, so its no-update check cannot fail');
    if (!legacy.labelled) throw new Error('SETUP: an old-category record lost its old-category label');
    if (legacy.updates) throw new Error('SETUP: an old-category record offers an update');
    if (legacy.calls !== before) throw new Error('SETUP: reading old-category records issued an AI request');
    return page.locator('.xp-dict-ai-details[data-supplement-category="literature"][open] .xp-dict-example-translation').isVisible();
  }
  throw new Error('SETUP: unknown dictionary entry state ' + state);
}
