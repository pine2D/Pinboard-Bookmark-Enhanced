// Render-only boundaries: handwritten official FreeDictionary data and strict
// AI JSON. The real normalizer, consent guard, candidate identity, UI builders
// and click handlers run unchanged. No real provider or permission prompt.
export async function installDictAssistFixture(page) {
  await page.evaluate(() => {
    _pbpDictHasPerm = async () => true;
    _pbpDictCacheGet = async () => null;
    _pbpDictFetch = async (lang, term) => ({ status: 200, data: {
      word: term, entries: [{ language: { code: lang, name: 'English' }, partOfSpeech: 'noun',
        pronunciations: [], forms: [], synonyms: [], antonyms: [], senses: [
          { definition: 'An original dictionary meaning that fits this sentence.\nThe dictionary wording stays unchanged.', tags: [], examples: [], quotes: [], synonyms: [], antonyms: [], subsenses: [] },
          { definition: 'A different meaning used in another context.', tags: [], examples: [], quotes: [], synonyms: [], antonyms: [], subsenses: [] }
        ] }], source: { url: 'https://en.wiktionary.org/wiki/fixture', license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' } }
    } });
    ensureAIHostPermissionWithGesture = async () => true;
    pbpAiCacheGet = async () => null;
    pbpAiCacheSet = async () => {};
    callAIStream = async () => 'LEMMA: -\nA separate contextual explanation.';
    window._auditDictAssist = { entered: false, release: null };
    callAI = async (_settings, prompt, opts) => {
      await opts.beforeRequest?.(); opts.signal?.throwIfAborted();
      let task;
      for (const match of prompt.matchAll(/\{/g)) {
        try { const parsed = JSON.parse(prompt.slice(match.index)); if (parsed.task && Array.isArray(parsed.candidates)) { task = parsed; break; } } catch (_) {}
      }
      if (task?.task !== 'recommend' || task.candidates.length !== 2 || !task.candidates[0].definition.startsWith('An original dictionary meaning')) throw new Error('SETUP: unexpected dictionary AI prompt');
      window._auditDictAssist.entered = true;
      await new Promise(resolve => { window._auditDictAssist.release = resolve; });
      opts.signal?.throwIfAborted();
      // Only echo the opaque input ID. Response fields are protocol literals,
      // never constructed by the implementation under test.
      return JSON.stringify({ choiceId: task.candidates[0].id, explanation: '这条释义符合原句中的用法。\nThis separate AI explanation leaves the original dictionary definition intact.' });
    };
  });
}

export async function openDictAssistState(page, state) {
  if (state === 'idle') {
    await page.locator('.dict-assist-recommend:not([disabled])').waitFor();
    return page.locator('.xp-dict-assist').isVisible();
  }
  if (state === 'busy') {
    await page.locator('.dict-assist-recommend').click();
    await page.waitForFunction(() => window._auditDictAssist?.entered);
    return page.locator('.dict-assist-stop:not([hidden])').isVisible();
  }
  await page.evaluate(() => { if (!window._auditDictAssist?.release) throw new Error('SETUP: no pending AI request'); window._auditDictAssist.release(); });
  await page.locator('.dict-assist-explanation').waitFor();
  return page.locator('.dict-assist-use').isVisible();
}
