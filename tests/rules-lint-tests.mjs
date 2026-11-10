import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { lintRules, globToRegex, objectKeysFromSource, CLAIMS } from '../scripts/rules-lint.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rules-lint.mjs');

// ---- fixture repos: small trees in os.tmpdir(), never inside the repo ----
const made = [];
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'rules-lint-'));
  made.push(root);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}
test.after(() => { for (const r of made) rmSync(r, { recursive: true, force: true }); });

const rule = (paths, body = '# rule\n') => `---\npaths:\n${paths.map((p) => `  - "${p}"`).join('\n')}\n---\n\n${body}`;
const index = (...rows) => `# Proj\n\nintro\n\n## 规则与技能索引\n\n| 改这些文件 | 必读 |\n|---|---|\n${rows.join('\n')}\n`;
const row = (first, ref) => `| ${first} | \`${ref}\` |`;

// A tree that passes with no claims; tests break one thing at a time.
const base = (over = {}) => ({
  'CLAUDE.md': index(row('a.js、b.js', '.claude/rules/alpha.md'), row('发版', '.claude/skills/rel/SKILL.md'), row('迁移', '.claude/expiring-items.md')),
  '.claude/rules/alpha.md': rule(['a.js', 'b.js']),
  '.claude/skills/rel/SKILL.md': '---\nname: rel\n---\n\n# rel\n',
  '.claude/expiring-items.md': '# items\n',
  'a.js': 'const x = 1;\n',
  'b.js': 'const y = 2;\n',
  ...over,
});
const run = (files, opts = {}) => {
  const root = repo(files);
  return lintRules(root, { claims: [], ...opts });
};
const has = (list, re) => list.some((m) => re.test(m));
const errorsOf = (files, opts) => run(files, opts).errors;

test('baseline fixture passes', () => {
  assert.deepEqual(errorsOf(base()), []);
});

// ---- A: index and rule files ----
test('A: index names a rule file that does not exist', () => {
  const e = errorsOf(base({ 'CLAUDE.md': index(row('a.js', '.claude/rules/alpha.md'), row('c.js', '.claude/rules/ghost.md')) }));
  assert.ok(has(e, /ghost\.md.*不存在/), e.join('\n'));
});
test('A: a rule file missing from the index fails', () => {
  const e = errorsOf(base({ '.claude/rules/orphan.md': rule(['a.js']) }));
  assert.ok(has(e, /orphan\.md.*不在 CLAUDE\.md 的索引表里/), e.join('\n'));
});
test('A: a file the row names but the frontmatter does not match fails', () => {
  const e = errorsOf(base({ '.claude/rules/alpha.md': rule(['a.js']) }));
  assert.ok(has(e, /b\.js.*不在它的 paths/), e.join('\n'));
});
test('A: a wildcard in the row expands and every match must be covered', () => {
  const files = base({
    'CLAUDE.md': index(row('md-*.js', '.claude/rules/alpha.md')),
    '.claude/rules/alpha.md': rule(['md-one.js']),
    'md-one.js': '', 'md-two.js': '',
  });
  const e = errorsOf(files);
  assert.ok(has(e, /md-two\.js.*不在它的 paths/), e.join('\n'));
  assert.ok(!has(e, /md-one\.js/), e.join('\n'));
  // covering the second file turns it green
  assert.deepEqual(errorsOf({ ...files, '.claude/rules/alpha.md': rule(['md-*.js']) }), []);
});
test('A: a paths: glob that matches nothing fails; the allow-list excuses it', () => {
  const files = base({ '.claude/rules/alpha.md': rule(['a.js', 'b.js', 'nothing/**']) });
  assert.ok(has(errorsOf(files), /"nothing\/\*\*" 没有匹配任何已跟踪文件/));
  const ok = errorsOf(files, { allow: [{ file: '.claude/rules/alpha.md', token: 'nothing/**', reason: 'gitignored' }] });
  assert.deepEqual(ok, []);
});
test('A: a rule file without frontmatter paths fails', () => {
  const e = errorsOf(base({ '.claude/rules/alpha.md': '# no frontmatter\n' }));
  assert.ok(has(e, /alpha\.md: 没有 frontmatter paths/), e.join('\n'));
});
test('A: rows for registers and skills are accepted; the frontmatter check only runs for rules', () => {
  const files = base({
    'CLAUDE.md': index(row('a.js、b.js', '.claude/rules/alpha.md'), row('裁决 c.js', '.claude/decisions.md'), row('发版', '.claude/skills/rel/SKILL.md')),
    '.claude/decisions.md': '# d\n', 'c.js': '',
  });
  assert.deepEqual(errorsOf(files), []);
  const missing = { ...files };
  delete missing['.claude/decisions.md'];
  assert.ok(has(errorsOf(missing), /decisions\.md.*不存在/));
});
test('A: a missing index table fails', () => {
  const e = errorsOf(base({ 'CLAUDE.md': '# Proj\n' }));
  assert.ok(has(e, /找不到.*索引表/), e.join('\n'));
});
test('A: a row naming a bare file resolves by unique basename in a folder', () => {
  const files = base({
    'CLAUDE.md': index(row('a.js、smoke.mjs', '.claude/rules/alpha.md')),
    '.claude/rules/alpha.md': rule(['a.js', 'scripts/smoke.mjs']),
    'scripts/smoke.mjs': '',
  });
  assert.deepEqual(errorsOf(files), []);
  assert.ok(has(errorsOf({ ...files, '.claude/rules/alpha.md': rule(['a.js']) }), /smoke\.mjs.*不在它的 paths/));
});

// ---- B: backtick references ----
const doc = (body) => base({ '.claude/rules/alpha.md': rule(['a.js', 'b.js'], body) });
test('B: a dangling path reference fails; an existing one passes', () => {
  assert.ok(has(errorsOf(doc('see `missing/file.js` here\n')), /alpha\.md:\d+:.*missing\/file\.js/));
  assert.deepEqual(errorsOf(doc('see `a.js` and `a.js:12` here\n')), []);
});
test('B: a directory ending in / and a wildcard need a match', () => {
  const files = base({ 'docs/x/one.md': '', '.claude/rules/alpha.md': rule(['a.js', 'b.js'], 'dir `docs/x/` glob `docs/x/*.md`\n') });
  assert.deepEqual(errorsOf(files), []);
  assert.ok(has(errorsOf(doc('dir `docs/y/` here\n')), /docs\/y\//));
  assert.ok(has(errorsOf(doc('glob `docs/y/*.md` here\n')), /docs\/y\/\*\.md/));
});
test('B: a path relative to docs/theme-surface/ resolves', () => {
  const files = base({ 'docs/theme-surface/tools/sync.mjs': '', '.claude/rules/alpha.md': rule(['a.js', 'b.js'], 'run `tools/sync.mjs`\n') });
  assert.deepEqual(errorsOf(files), []);
  assert.ok(has(errorsOf(doc('run `tools/sync.mjs`\n')), /tools\/sync\.mjs/), 'without the file it must fail');
});
test('B: a sibling file in the same folder resolves', () => {
  const files = base({ '.claude/rules/beta.md': rule(['b.js']), 'CLAUDE.md': index(row('a.js', '.claude/rules/alpha.md'), row('b.js', '.claude/rules/beta.md')), '.claude/rules/alpha.md': rule(['a.js'], 'see `beta.md`\n') });
  assert.deepEqual(errorsOf(files), []);
  assert.ok(has(errorsOf(doc('see `gamma.md`\n')), /gamma\.md/));
});
test('B: a command-line flag must appear in scripts, tests or tools', () => {
  const body = 'use `node scripts/go.mjs --real-flag` or `--ghost-flag=1`\n';
  const files = doc(body);
  assert.ok(has(errorsOf({ ...files, 'scripts/go.mjs': '// --real-flag\n' }), /--ghost-flag/));
  assert.ok(!has(errorsOf({ ...files, 'scripts/go.mjs': '// --real-flag\n' }), /--real-flag/));
  assert.deepEqual(errorsOf({ ...files, 'scripts/go.mjs': '// --real-flag --ghost-flag\n' }), []);
  // a flag only mentioned in another doc does not count
  assert.ok(has(errorsOf({ ...files, 'scripts/go.mjs': '', 'notes.md': '--ghost-flag --real-flag' }), /--real-flag/));
});
test('B: a CSS custom property counts when a stylesheet defines it', () => {
  const body = 'token `--my-token`\n';
  assert.ok(has(errorsOf(doc(body)), /--my-token/));
  assert.deepEqual(errorsOf({ ...doc(body), 'x.css': ':root { --my-token: 1px; }' }), []);
});
test('B: an identifier must appear in a tracked code file', () => {
  const body = 'call `doTheThing` and `SOME_CONST`; `lowercase` is ignored\n';
  const e = errorsOf(doc(body));
  assert.ok(has(e, /doTheThing/) && has(e, /SOME_CONST/), e.join('\n'));
  assert.ok(!has(e, /lowercase/));
  assert.deepEqual(errorsOf({ ...doc(body), 'a.js': 'function doTheThing() {}\nconst SOME_CONST = 1;\n' }), []);
  // a doc that merely repeats the name is not code
  assert.ok(has(errorsOf({ ...doc(body), 'other.md': 'doTheThing SOME_CONST' }), /doTheThing/));
});
test('B: the allow-list file and the lint itself never count as evidence for a name', () => {
  const body = 'call `doTheThing`\n';
  const files = { ...doc(body), 'scripts/rules-lint-allow.json': '[{"token":"doTheThing"}]', 'scripts/rules-lint.mjs': '// doTheThing', 'tests/rules-lint-tests.mjs': '// doTheThing' };
  assert.ok(has(errorsOf(files), /doTheThing/));
});
test('B: a name family wildcard with no slash and no extension is not a path', () => {
  assert.deepEqual(errorsOf(doc('keys `pbp-*` and `field-*`\n')), []);
});
test('B: fenced code blocks are not scanned', () => {
  assert.deepEqual(errorsOf(doc('```\n`missing/file.js`\n```\n')), []);
});
test('B: retired history lines in expiring-items.md are skipped, other lines are not', () => {
  const retired = '- 旧迁移（`gone/old.js` 已于 2026-01-01 退役）\n';
  assert.deepEqual(errorsOf(base({ '.claude/expiring-items.md': retired })), []);
  const live = '- 迁移 `gone/old.js` 到期 2027-01-01\n';
  assert.ok(has(errorsOf(base({ '.claude/expiring-items.md': live })), /expiring-items\.md:1:.*gone\/old\.js/));
  // the skip is for that line only
  assert.ok(has(errorsOf(base({ '.claude/expiring-items.md': retired + live })), /expiring-items\.md:2:/));
});
test('B: the allow-list excuses a reference, and an unused entry is an error', () => {
  const files = doc('see `missing/file.js`\n');
  const entry = { file: '.claude/rules/alpha.md', token: 'missing/file.js', reason: 'gitignored' };
  assert.deepEqual(errorsOf(files, { allow: [entry] }), []);
  const stale = errorsOf(doc('nothing odd\n'), { allow: [entry] });
  assert.ok(has(stale, /用不上/), stale.join('\n'));
  // an entry for the wrong file does not excuse it
  assert.ok(has(errorsOf(files, { allow: [{ ...entry, file: 'CLAUDE.md' }] }), /missing\/file\.js/));
});
test('B: an allow-list entry without a reason is an error', () => {
  const e = errorsOf(doc('see `missing/file.js`\n'), { allow: [{ file: '.claude/rules/alpha.md', token: 'missing/file.js' }] });
  assert.ok(has(e, /缺 file、token 或 reason/), e.join('\n'));
});
test('B: AGENTS.md and skills are in scope', () => {
  assert.ok(has(errorsOf(base({ 'AGENTS.md': 'see `nope/x.js`\n' })), /AGENTS\.md:1:/));
  assert.ok(has(errorsOf(base({ '.claude/skills/rel/SKILL.md': '---\nname: rel\n---\nsee `nope/x.js`\n' })), /SKILL\.md:4:/));
});

// ---- C: number claims ----
const claimOf = (n, mode = 'exact') => [{
  label: '测试页数', file: 'CLAUDE.md', re: /(\d+)\+? 套页/g, mode,
  actual: (ctx) => ctx.files.filter((f) => /^tests\/.*-tests\.html$/.test(f)).length,
}];
const withClaim = (said, pages) => {
  const files = base();
  files['CLAUDE.md'] += `\n共 ${said} 套页\n`;
  for (let i = 0; i < pages; i++) files[`tests/p${i}-tests.html`] = '';
  return files;
};
test('C: an exact claim passes when equal and fails when not', () => {
  assert.deepEqual(errorsOf(withClaim(3, 3), { claims: claimOf(3) }), []);
  assert.ok(has(errorsOf(withClaim(3, 4), { claims: claimOf(3) }), /写 3，实际是 4/));
  assert.ok(has(errorsOf(withClaim(3, 2), { claims: claimOf(3) }), /写 3，实际是 2/));
});
test('C: an "N+" claim fails only when the real value is below N', () => {
  assert.deepEqual(errorsOf(withClaim(3, 3), { claims: claimOf(3, 'min') }), []);
  assert.deepEqual(errorsOf(withClaim(3, 7), { claims: claimOf(3, 'min') }), []);
  assert.ok(has(errorsOf(withClaim(3, 2), { claims: claimOf(3, 'min') }), /写 3\+，实际是 2/));
});
test('C: every occurrence of a claim is checked', () => {
  const files = withClaim(3, 3);
  files['CLAUDE.md'] += '\n又写 5 套页\n';
  assert.ok(has(errorsOf(files, { claims: claimOf(3) }), /写 5，实际是 3/));
});
test('C: a claim whose wording vanished from the doc is an error, not a silent skip', () => {
  const e = errorsOf(base(), { claims: claimOf(3) });
  assert.ok(has(e, /找不到数字声明/), e.join('\n'));
  const e2 = errorsOf(base(), { claims: [{ ...claimOf(3)[0], file: 'NOPE.md' }] });
  assert.ok(has(e2, /NOPE\.md.*不存在/), e2.join('\n'));
});
const AI_SRC = `
const OPENAI_COMPAT_PROVIDERS = {
  openai: { base: "x" },
  "my-gw": { base: "y" },
  custom: { base: "" },
};
const _AI_BESPOKE_PROVIDERS = {
  gemini: {},
  ollama: {},
};
`;

// A tree that satisfies every default claim: 2 locales, 2 READMEs, 2 test pages
// (plus one helper page that must not count), 3 pilots, 4 provider ids.
function claimsTree() {
  const files = base({
    'CLAUDE.md': base()['CLAUDE.md'] + '\n_locales/（2 locale）\n×2 locale\nREADME*.md ×2\nHTML 测试页 2+ 套\n3 套站点主题\n',
    '.claude/rules/theme-factory.md': rule(['a.js'], '3 套 preset 渲染\n'),
    'PRODUCT.md': '- AI providers (4, plus OpenAI-compatible endpoints)\n',
    'ai.js': AI_SRC,
    '_locales/en/messages.json': '{}', '_locales/ja/messages.json': '{}',
    'README.md': '', 'README.ja.md': '',
    'tests/a-tests.html': '', 'tests/b-tests.html': '', 'tests/helper.html': '',
    'docs/theme-surface/pilots/x.tokens.json': '{}', 'docs/theme-surface/pilots/y.tokens.json': '{}', 'docs/theme-surface/pilots/z.tokens.json': '{}',
  });
  files['CLAUDE.md'] = files['CLAUDE.md'].replace('| 迁移 |', '| 主题 | `.claude/rules/theme-factory.md` |\n| 迁移 |');
  return files;
}
test('C: the default claim table counts locales, themes and test pages from the file list', () => {
  const files = claimsTree();
  assert.deepEqual(errorsOf(files, { claims: CLAIMS }), []);
  // one locale directory too many in the real tree: the claim goes red
  const e = errorsOf({ ...files, '_locales/fr/messages.json': '{}' }, { claims: CLAIMS });
  assert.ok(has(e, /locale 数.*写 2，实际是 3/), e.join('\n'));
  // one README more
  assert.ok(has(errorsOf({ ...files, 'README.fr.md': '' }, { claims: CLAIMS }), /README 数.*写 2，实际是 3/));
  // a pilot fewer: both theme claims go red
  const f2 = { ...files };
  delete f2['docs/theme-surface/pilots/z.tokens.json'];
  const e2 = errorsOf(f2, { claims: CLAIMS });
  assert.equal(e2.filter((m) => /站点主题数.*写 3，实际是 2/.test(m)).length, 2, e2.join('\n'));
  // "2+" with only one test page: red; the helper page without -tests does not count
  const f3 = { ...files };
  delete f3['tests/b-tests.html'];
  assert.ok(has(errorsOf(f3, { claims: CLAIMS }), /测试页数.*写 2\+，实际是 1/));
  // a fifth provider id in ai.js makes the PRODUCT.md claim go red
  const f4 = { ...files, 'ai.js': AI_SRC.replace('gemini: {},', 'gemini: {}, extra: {},') };
  assert.ok(has(errorsOf(f4, { claims: CLAIMS }), /AI 服务商数.*写 4，实际是 5/));
});

test('C: the provider count comes from the ai.js AST and leaves out "custom"', () => {
  assert.deepEqual(objectKeysFromSource(AI_SRC, 'OPENAI_COMPAT_PROVIDERS'), ['openai', 'my-gw', 'custom']);
  const provider = CLAIMS.filter((c) => c.file === 'PRODUCT.md');
  assert.equal(provider.length, 1);
  const files = (said) => ({ ...base(), 'PRODUCT.md': `- AI providers (${said}, plus OpenAI-compatible endpoints)\n`, 'ai.js': AI_SRC });
  assert.deepEqual(errorsOf(files(4), { claims: provider }), []);
  assert.ok(has(errorsOf(files(5), { claims: provider }), /AI 服务商数.*写 5，实际是 4/));
  // a provider id in a comment or a string is not an entry: only the AST counts
  const sneaky = AI_SRC.replace('openai: { base: "x" },', '// fake: {},\n  openai: { base: "x", note: "extra: 1" },');
  assert.deepEqual(errorsOf({ ...files(4), 'ai.js': sneaky }, { claims: provider }), []);
  // the table is gone from ai.js: an error, not a pass
  assert.ok(has(errorsOf({ ...files(4), 'ai.js': 'const other = {};\n' }, { claims: provider }), /没有在源码里找到/));
});

// ---- helpers and the CLI ----
test('globToRegex: * stays inside a folder, ** crosses folders', () => {
  assert.ok(globToRegex('md-*.js').test('md-a.js'));
  assert.ok(!globToRegex('md-*.js').test('x/md-a.js'));
  assert.ok(globToRegex('docs/**').test('docs/a/b.md'));
  assert.ok(globToRegex('scripts/audit*.mjs').test('scripts/audit-x.mjs'));
  assert.ok(!globToRegex('a.js').test('abjs'));
});
test('CLI: a good fixture exits 0 with PASS; a broken one exits 1', () => {
  const good = repo(claimsTree());
  const ok = spawnSync(process.execPath, [SCRIPT, '--root', good], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /PASS rules-lint/);
  const bad = repo({ ...claimsTree(), '.claude/rules/orphan.md': rule(['a.js']) });
  const r = spawnSync(process.execPath, [SCRIPT, '--root', bad], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /orphan\.md/);
});
test('CLI: PBP_RULES_LINT_ROOT works and an allow file beside the fixture is read', () => {
  const root = repo({ ...claimsTree(), '.claude/rules/alpha.md': rule(['a.js', 'b.js'], 'see `missing/file.js`\n'), 'scripts/rules-lint-allow.json': JSON.stringify([{ file: '.claude/rules/alpha.md', token: 'missing/file.js', reason: 'test' }]) });
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, PBP_RULES_LINT_ROOT: root } });
  assert.equal(r.status, 0, r.stderr);
});
test('CLI: a malformed allow file exits 1', () => {
  const root = repo({ ...claimsTree(), 'scripts/rules-lint-allow.json': '{not json' });
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  assert.equal(r.status, 1);
});
