// Isolated production archive with handwritten completed-answer records.
// No model, Google request or user's archive participates in these UI states.
export async function installAskHistoryFixture(page) {
  await page.evaluate(async () => {
    const owner = await pbpVocabCurrentOwner();
    const scope = owner === 'ownerless' ? '' : owner;
    _pbpAskArchiveStore = pbpCreateAskArchiveStore({ dbName: 'ask-render-' + crypto.randomUUID(), getCurrentOwner: async () => {
      const current = await pbpVocabCurrentOwner(); return current === 'ownerless' ? '' : current;
    } });
    const input = { owner: scope, sessionId: 'render-session-main', url: 'https://example.test/reading', title: 'Learning across languages · 跨语言阅读' };
    const record = { q: 'How do examples help distinguish two meanings?', a: 'An example shows **how a word is used** in a sentence. [P1]\n\n- Check the surrounding words.\n- Compare the two definitions.\n\nCITES:\nP1: "Context helps readers distinguish meanings."', cites: [{ p: 1, quote: 'Context helps readers distinguish meanings.' }], ts: 1792800000000, model: 'Fixture model', blocksHash: 'fixture-hash', evidence: [{ p: 1, quote: 'Context helps readers distinguish meanings.', state: 'matched', sourceUrl: 'https://example.test/reading' }] };
    const old = await pbpAskArchiveAppend({ ...input, record });
    await pbpAskArchiveAppend({ ...input, replacesId: old.id, record: { ...record, ts: 1792800001000, a: 'Examples show the meaning **in use**, while definitions explain it directly. [P1]\n\nCompare the sentence with each definition and keep the one that fits the context.\n\nCITES：\nP1：「Context helps readers distinguish meanings.」' } });
    await pbpAskArchiveAppend({ ...input, record: { ...record, q: '如果母语和学习语言相反，也能这样做吗？', a: '可以。这个方法适用于不同语言方向；先确认要学习的词，再选择自己能读懂的释义语言。', cites: [], evidence: [], ts: 1792800002000 } });
    await pbpAskArchiveAppend({ ...input, sessionId: 'render-session-second', record: { ...record, q: 'A second conversation stays independent.', ts: 1792790000000 } });
    window._auditAskHistory = { sessionId: input.sessionId };
  });
  await page.locator('#lib-tab-ask').click();
  await page.waitForSelector('#ask-library-list .ask-library-hit');
  await page.waitForFunction(() => !document.getElementById('ask-library-status').textContent);
}
export async function openAskHistoryState(page, state) {
  if (state === 'list') return true;
  if (state === 'detail') {
    await page.locator('#ask-library-list .ask-library-hit').first().click();
    await page.waitForSelector('#ask-library-detail:not([hidden])');
  } else if (state === 'evidence') {
    await page.locator('.ask-library-round .ask-library-evidence > summary').first().click();
    await page.waitForSelector('.ask-library-round .ask-library-evidence[open]');
  } else if (state === 'versions') {
    await page.locator('#ask-library-detail > .ask-library-evidence > summary').click();
    await page.waitForSelector('#ask-library-detail > .ask-library-evidence[open]');
  } else if (state === 'delete') {
    await page.locator('.ask-library-delete').click();
    await page.waitForSelector('.confirm-popover');
  } else throw new Error('Unknown Ask history fixture state: ' + state);
  return true;
}
