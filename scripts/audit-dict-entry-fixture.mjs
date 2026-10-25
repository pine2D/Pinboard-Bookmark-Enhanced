// Render-only service boundaries. Free Dictionary and AI response fields are
// handwritten data; production request guards, parser, cache and UI run unchanged.
// No request reaches a real provider and no permission prompt is opened.
export async function installDictEntryFixture(page) {
  await page.evaluate(async () => {
    await chrome.storage.local.set({ dictDefaultView: "ai-saved" });
    if (typeof _pbpExplainSettings === "object" && _pbpExplainSettings) _pbpExplainSettings.dictDefaultView = "ai-saved";
    _pbpDictHasPerm = async () => true;
    _pbpDictCacheGet = async () => null;
    _pbpDictFetch = async (lang, term) => ({ status: 200, data: {
      word: term, entries: [{ language: { code: lang, name: 'English' }, partOfSpeech: 'noun',
        pronunciations: [], forms: [], synonyms: [], antonyms: [], senses: [
          { definition: 'An original dictionary definition. Its wording remains available when you switch sources.', tags: [], examples: [], quotes: [], synonyms: [], antonyms: [], subsenses: [] },
          { definition: 'Another common meaning from the original dictionary.', tags: [], examples: [], quotes: [], synonyms: [], antonyms: [], subsenses: [] }
        ] }], source: { url: 'https://en.wiktionary.org/wiki/fixture', license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' } }
    } });
    ensureAIHostPermissionWithGesture = async () => true;
    const cache = new Map();
    window._auditDictEntry = { entered: false, release: null, fail: false, calls: 0, reads: 0, cache };
    // Exercise the production archive against a fresh, isolated database. A
    // scenario reset discards only its fixture store, never the user's archive.
    window._auditDictEntry.resetArchive = async () => {
      if (_pbpDictArchiveStore) await _pbpDictArchiveStore.close();
      _pbpDictArchiveStore = pbpCreateDictArchiveStore({ dbName: "dict-render-" + crypto.randomUUID(), readLegacy: async () => [] });
      const read = _pbpDictArchiveStore.read;
      _pbpDictArchiveStore.read = async input => { window._auditDictEntry.reads++; return read(input); };
    };
    await window._auditDictEntry.resetArchive();
    pbpAiCacheGet = async key => {
      window._auditDictEntry.reads++;
      return cache.has(key) ? structuredClone(cache.get(key)) : null;
    };
    pbpAiCacheSet = async (key, result, ts) => { cache.set(key, structuredClone({ result, ts })); return true; };
    // The ordinary Explain opener is also used by other reader sweep states.
    callAIStream = async () => 'A short article-specific explanation for this render fixture.';
    callAI = async (_settings, prompt, opts) => {
      await opts.beforeRequest?.(); opts.signal?.throwIfAborted();
      let lookup;
      try { lookup = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)); } catch (_) {}
      if (!lookup || Object.keys(lookup).sort().join(',') !== 'sourceLanguage,targetLanguage,term' ||
        !lookup.term || !lookup.sourceLanguage || !lookup.targetLanguage?.name) {
        throw new Error('SETUP: expected a reusable dictionary entry request without article or dictionary content');
      }
      const state = window._auditDictEntry;
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
        ], etymology: '此处展示词源说明的布局，不依赖当前文章。', relatedWords: ['example', 'expression', 'meaning'] });
    };
  });
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
    return page.locator('.xp-dict-ai-stop:not([hidden])').isVisible();
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
    await page.locator('.xp-dict-ai-details > summary').first().click();
    return page.locator('.xp-dict-ai-details[open] .xp-dict-rel').isVisible();
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
      document.querySelector('.xp-dict-ai-status')?.textContent === t('dictEntryUnavailable'));
    return page.locator('.xp-dict-ai-status:not([hidden])').isVisible();
  }
  throw new Error('SETUP: unknown dictionary entry state ' + state);
}
