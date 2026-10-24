// Render-only boundaries: handwritten official FreeDictionary data and strict
// AI JSON. The real normalizer, consent guard, candidate identity, UI builders
// and click handlers run unchanged. No real provider or permission prompt.
export async function installDictAssistFixture(page, { analyze = false } = {}) {
  await page.evaluate(analyze => {
    _pbpDictHasPerm = async () => true;
    _pbpDictCacheGet = async () => null;
    _pbpDictFetch = async (lang, term) => ({ status: 200, data: {
      word: term, entries: [{ language: { code: lang, name: 'English' }, partOfSpeech: 'noun',
        pronunciations: [], forms: [], synonyms: [], antonyms: [], senses: [
          { definition: 'An original dictionary meaning that fits this sentence.\nThe dictionary wording stays unchanged.' + (window._auditDictAssist?.long ? '\nA detailed source definition remains independent of the AI answer.'.repeat(100) : ''), tags: [], examples: [], quotes: [], synonyms: [], antonyms: [], subsenses: [] },
          { definition: 'A different meaning used in another context.', tags: [], examples: [], quotes: [], synonyms: [], antonyms: [], subsenses: [] }
        ] }], source: { url: 'https://en.wiktionary.org/wiki/fixture', license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' } }
    } });
    ensureAIHostPermissionWithGesture = async () => true;
    pbpAiCacheGet = async () => null;
    pbpAiCacheSet = async () => {};
    callAIStream = async () => 'LEMMA: -\nA separate contextual explanation.';
    window._auditDictAssist = { entered: false, release: null, long: false, fail: false };
    callAI = async (_settings, prompt, opts) => {
      await opts.beforeRequest?.(); opts.signal?.throwIfAborted();
      let task;
      for (const match of prompt.matchAll(/\{/g)) {
        try { const parsed = JSON.parse(prompt.slice(match.index)); if (parsed.task && (Array.isArray(parsed.candidates) || parsed.task === "analyze")) { task = parsed; break; } } catch (_) {}
      }
      if (analyze) {
        if (task?.task !== 'analyze' || !task.sentence?.includes(task.selectedTerm) || 'candidates' in task) throw new Error('SETUP: unexpected expression analysis prompt');
      } else if (task?.task !== 'recommend' || task.candidates.length !== 2 || !task.candidates[0].definition.startsWith('An original dictionary meaning')) throw new Error('SETUP: unexpected dictionary AI prompt');
      window._auditDictAssist.entered = true;
      await new Promise(resolve => { window._auditDictAssist.release = resolve; });
      opts.signal?.throwIfAborted();
      // Only echo the opaque input ID. Response fields are protocol literals,
      // never constructed by the implementation under test.
      if (window._auditDictAssist.fail) return '{"choiceId":"fabricated-id","explanation":"Invalid fixture response."}';
      if (analyze) return JSON.stringify({ suggestions: [
        { kind: 'lemma', headword: 'constrain', evidence: [task.selectedTerm], explanation: 'A possible base form, supported by the selected source fragment.\nThe saved word is unchanged.' },
        { kind: 'phrase', headword: 'a constraint', evidence: [task.selectedTerm], explanation: 'A possible expression for a separate dictionary lookup.' }
      ] });
      return JSON.stringify({ choiceId: task.candidates[0].id, explanation: '这条释义符合原句中的用法。\nThis separate AI explanation leaves the original dictionary definition intact.' });
    };
  }, analyze);
}

export async function openDictAssistState(page, state, { analyze = false } = {}) {
  const action = analyze ? '.dict-assist-analyze' : '.dict-assist-recommend';
  if (state === 'copy-failure') {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async () => { throw new DOMException('Synthetic clipboard denial', 'NotAllowedError'); } } }));
    await page.locator('.dict-assist-copy').click();
    await page.locator('.dict-assist-copy-status:not([hidden])').waitFor();
    return page.locator('.dict-assist-copy-status').isVisible();
  }
  if (state === 'derived') {
    await page.locator('.dict-assist-lookup').first().click();
    await page.locator('.xp-dict-origin').waitFor();
    return page.locator('.xp-dict-return').isVisible();
  }
  if (state === 'ready' || state === 'error') {
    await page.evaluate(fail => { Object.assign(window._auditDictAssist, { long: true, fail, entered: false }); }, state === 'error');
    // Refresh through each surface's real lookup action so a long official
    // source response places the eventual answer below its internal viewport.
    if (await page.locator('#vocab-lookup-go').count()) await page.locator('#vocab-lookup-go').click();
    else await page.locator('.xp-dict-head > .xp-dict-lang').selectOption('en');
    await page.locator(action + ':not([disabled])').waitFor();
    await page.locator(action).click();
    await page.waitForFunction(() => window._auditDictAssist?.entered);
    await page.evaluate(() => {
      (document.querySelector('.xp-body') || document.querySelector('#vocab-detail-pane')).scrollTop = 0;
      window._auditDictAssist.release();
    });
    await page.locator('.dict-assist-notice:not([hidden])').waitFor();
    return page.locator('.dict-assist-view').isVisible();
  }

  if (state === 'idle') {
    await page.locator(action + ':not([disabled])').waitFor();
    return page.locator('.xp-dict-assist').isVisible();
  }
  if (state === 'busy') {
    await page.locator(action).click();
    await page.waitForFunction(() => window._auditDictAssist?.entered);
    return page.locator('.dict-assist-stop:not([hidden])').isVisible();
  }
  await page.evaluate(() => { if (!window._auditDictAssist?.release) throw new Error('SETUP: no pending AI request'); window._auditDictAssist.release(); });
  await page.locator('.dict-assist-explanation').first().waitFor();
  return page.locator(analyze ? '.dict-assist-lookup' : '.dict-assist-use').first().isVisible();
}
