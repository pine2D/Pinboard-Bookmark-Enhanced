// Synthetic Yomitan v3 fixture, independent of the runtime importer. Store-only
// ZIP headers and CRCs are written here so both browser drivers upload a real file.
export const VOCAB_PACK_FIXTURE_TITLE = 'Render audit multilingual dictionary — Mehrsprachiges Wörterbuch';

export function vocabPackFixture() {
  const files = [
    ['index.json', { title: VOCAB_PACK_FIXTURE_TITLE, format: 3, revision: 'qa-1', sequenced: true }],
    ['term_bank_1.json', [['Wortschatz', '', 'noun', '', 0, ['The vocabulary available to a speaker or learner.'], 1, '']]],
  ];
  const locals = [], central = [];
  let offset = 0;
  for (const [path, json] of files) {
    const name = Buffer.from(path), data = Buffer.from(JSON.stringify(json));
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, name, data); central.push(entry, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return { name: 'render-audit-multilingual.zip', mimeType: 'application/zip', buffer: Buffer.concat([...locals, directory, end]) };
}

export async function openVocabPackPreview(page) {
  await page.locator('#tab-vocab').click();
  const disclosure = page.locator('#multi-pack-section');
  if (!(await disclosure.evaluate(el => el.open))) await disclosure.locator('summary').click();
  await page.locator('#multi-pack-file').setInputFiles(vocabPackFixture());
  await page.locator('#multi-pack-preview:not([hidden])').waitFor();
  await page.locator('#multi-pack-source-language').fill('de');
  await page.locator('#multi-pack-target-language').fill('en');
  await page.locator('#multi-pack-source-url').fill('https://dictionary.example.test/synthetic-source');
  await page.locator('#multi-pack-license').fill('Synthetic QA dictionary; no third-party content.');
  // Upload/fill do not move the pointer off the disclosure we clicked. Its
  // temporary hover color is not the resting section-heading face to audit.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
}

export async function installVocabPackFixture(page) {
  await page.locator('#multi-pack-install').click();
  await page.locator('#multi-pack-list .dict-pack-name').filter({ hasText: VOCAB_PACK_FIXTURE_TITLE }).waitFor();
  await page.locator('#multi-pack-preview').waitFor({ state: 'hidden' });
  const actions = await page.locator('#multi-pack-list button[data-pack-action]').evaluateAll(buttons => buttons.map(button => button.dataset.packAction).sort());
  if (actions.join(',') !== 'delete,enabled') throw new Error('SETUP: dictionary installed actions are incomplete');
}
