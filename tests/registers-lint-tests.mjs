import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  lintDecisions, lintAcceptanceDebt, lintFlakeLedger, openAcceptanceItems,
  lintStoreLedger, storeReadiness, lintFreshness, loadProviderDefaults, repoFileInfo, dueItems,
  FRESH_STALE_DAYS,
} from '../scripts/registers-lint.mjs';
import { tempItems } from '../scripts/docs-lint.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const today = '2026-11-10';
const T = { today };

// ---- fixtures: written by hand in the documented file shapes ----
const DEC_HEAD = '| 日期 | 裁决 | 理由 | 范围 |\n|---|---|---|---|\n';
const decisions = (...rows) => `# 裁决登记册\n\n## 不做的功能\n\n${DEC_HEAD}${rows.join('\n')}\n`;
const DEC_OK = '| 2026-08-03 | 不做甲 | 用户否决 | 资料库 |';

const AD_PENDING_HEAD = '| 编号 | 登记日 | 来源 | 验什么 | 怎么验 | 到期日 |\n|---|---|---|---|---|---|\n';
const AD_DONE_HEAD = '| 编号 | 清账日 | 结果 |\n|---|---|---|\n';
const debt = (pending = [], done = []) =>
  `# 验收欠账\n\n## 待验\n\n${AD_PENDING_HEAD}${pending.join('\n')}\n\n## 已清\n\n${AD_DONE_HEAD}${done.join('\n')}\n`;
const pend = (id, due, reg = '2026-11-01') => `| ${id} | ${reg} | 来源 | 验什么 | 怎么验 | ${due} |`;

const FL_HEAD = '| 日期 | 用例 | 现象 | 状态 | 到期日 |\n|---|---|---|---|---|\n';
const flake = (...rows) => `# 抖动台账\n\n## 记录\n\n${FL_HEAD}${rows.join('\n')}\n`;
const fl = (c, status, due = '-', date = '2026-11-01') => `| ${date} | ${c} | 现象 | ${status} | ${due} |`;

const ST_SUB_HEAD = '| 版本 | 提交日 | 结果 | 结果日 | 备注 |\n|---|---|---|---|---|\n';
const ST_DATA_HEAD = '| 日期 | 周用户 | 安装 | 卸载 | 评分 | 评价数 |\n|---|---|---|---|---|---|\n';
const store = (subs = [], data = []) =>
  `# 商店台账\n\n## 提交\n\n${ST_SUB_HEAD}${subs.join('\n')}\n\n## 数据\n\n${ST_DATA_HEAD}${data.join('\n')}\n`;
const sb = (v, sent, result, day = '-', note = '-') => `| ${v} | ${sent} | ${result} | ${day} | ${note} |`;

const has = (list, re) => list.some((m) => re.test(m));

// ---- decisions ----
test('decisions: valid sample passes; escaped pipe stays inside the cell', () => {
  const r = lintDecisions(decisions(DEC_OK, '| 2026-08-04 | 乙 \\| 丙 | 理由 | 范围 |'), T);
  assert.deepEqual(r, { errors: [], warnings: [] });
});
test('decisions: wrong header is an error with file and line', () => {
  const text = decisions(DEC_OK).replace('| 范围 |', '| 地点 |');
  const r = lintDecisions(text, T);
  assert.ok(has(r.errors, /decisions\.md:5:.*表头/), r.errors.join('\n'));
});
test('decisions: a row with a missing cell fails', () => {
  const r = lintDecisions(decisions('| 2026-08-03 | 不做甲 | 用户否决 |'), T);
  assert.ok(has(r.errors, /decisions\.md:7:/), r.errors.join('\n'));
});
test('decisions: an empty cell fails', () => {
  const r = lintDecisions(decisions('| 2026-08-03 | 不做甲 |  | 资料库 |'), T);
  assert.ok(has(r.errors, /decisions\.md:7:.*空/), r.errors.join('\n'));
});
test('decisions: calendar-invalid date fails', () => {
  const r = lintDecisions(decisions('| 2026-02-30 | 不做甲 | 理由 | 范围 |'), T);
  assert.ok(has(r.errors, /decisions\.md:7:.*日期/), r.errors.join('\n'));
});
test('decisions: future date fails, today passes', () => {
  assert.ok(has(lintDecisions(decisions('| 2026-11-11 | 甲 | 理由 | 范围 |'), T).errors, /未来|晚于今天/));
  assert.deepEqual(lintDecisions(decisions('| 2026-11-10 | 甲 | 理由 | 范围 |'), T).errors, []);
});
test('decisions: same date + decision twice fails; same decision on another date passes', () => {
  const dup = lintDecisions(decisions(DEC_OK, DEC_OK), T);
  assert.ok(has(dup.errors, /decisions\.md:8:.*重复/), dup.errors.join('\n'));
  assert.deepEqual(lintDecisions(decisions(DEC_OK, DEC_OK.replace('2026-08-03', '2026-08-04')), T).errors, []);
});
test('decisions: no data rows fails', () => {
  assert.ok(has(lintDecisions(decisions(), T).errors, /至少一行/));
  assert.ok(has(lintDecisions('# 空\n', T).errors, /至少一行/));
});
test('decisions: every table is checked, not just the first', () => {
  const text = decisions(DEC_OK) + '\n## 另一组\n\n| 日期 | 裁决 |\n|---|---|\n| 2026-08-03 | x |\n';
  assert.ok(has(lintDecisions(text, T).errors, /表头/));
});

// ---- acceptance debt ----
test('debt: valid sample passes, empty 已清 table is allowed', () => {
  const r = lintAcceptanceDebt(debt([pend('A-001', '2026-12-10')]), T);
  assert.deepEqual(r, { errors: [], warnings: [] });
  assert.deepEqual(lintAcceptanceDebt(debt([], []), T), { errors: [], warnings: [] });
});
test('debt: id format error', () => {
  const r = lintAcceptanceDebt(debt([pend('B-1', '2026-12-10')]), T);
  assert.ok(has(r.errors, /acceptance-debt\.md:\d+:.*编号/), r.errors.join('\n'));
});
test('debt: duplicate id inside 待验, and across the two tables', () => {
  const dup = lintAcceptanceDebt(debt([pend('A-001', '2026-12-10'), pend('A-001', '2026-12-11')]), T);
  assert.ok(has(dup.errors, /重复/), dup.errors.join('\n'));
  const cross = lintAcceptanceDebt(debt([pend('A-001', '2026-12-10')], ['| A-001 | 2026-11-09 | 通过 |']), T);
  assert.ok(has(cross.errors, /重复/), cross.errors.join('\n'));
});
test('debt: invalid due date fails', () => {
  const r = lintAcceptanceDebt(debt([pend('A-001', '2026-13-01')]), T);
  assert.ok(has(r.errors, /到期日/), r.errors.join('\n'));
});
test('debt: overdue 1 and 14 days warn, 15 days errors, not-yet-due and due-today are silent', () => {
  const day = (n) => { const d = new Date(Date.UTC(2026, 10, 10 - n)); return d.toISOString().slice(0, 10); };
  const one = lintAcceptanceDebt(debt([pend('A-001', day(1))]), T);
  assert.equal(one.errors.length, 0); assert.equal(one.warnings.length, 1);
  assert.match(one.warnings[0], /A-001/);
  const fourteen = lintAcceptanceDebt(debt([pend('A-001', day(14))]), T);
  assert.equal(fourteen.errors.length, 0); assert.equal(fourteen.warnings.length, 1);
  const fifteen = lintAcceptanceDebt(debt([pend('A-001', day(15))]), T);
  assert.equal(fifteen.errors.length, 1); assert.match(fifteen.errors[0], /A-001/);
  assert.deepEqual(lintAcceptanceDebt(debt([pend('A-001', day(0))]), T), { errors: [], warnings: [] });
  assert.deepEqual(lintAcceptanceDebt(debt([pend('A-001', day(-3))]), T), { errors: [], warnings: [] });
});
test('debt: 已清 row without result fails; invalid or future 清账日 fails', () => {
  assert.ok(has(lintAcceptanceDebt(debt([], ['| A-001 | 2026-11-09 |  |']), T).errors, /结果/));
  assert.ok(has(lintAcceptanceDebt(debt([], ['| A-001 | 2026-11-31 | 通过 |']), T).errors, /清账日/));
  assert.ok(has(lintAcceptanceDebt(debt([], ['| A-001 | 2026-11-11 | 通过 |']), T).errors, /清账日/));
});
test('debt: wrong header and missing section fail; future 登记日 fails', () => {
  const bad = debt([pend('A-001', '2026-12-10')]).replace('| 怎么验 |', '| 如何 |');
  assert.ok(has(lintAcceptanceDebt(bad, T).errors, /表头/));
  assert.ok(has(lintAcceptanceDebt('# x\n\n## 待验\n', T).errors, /已清|表/));
  assert.ok(has(lintAcceptanceDebt(debt([pend('A-001', '2026-12-10', '2026-11-11')]), T).errors, /登记日/));
});
test('openAcceptanceItems: returns every pending row with overdueDays', () => {
  const items = openAcceptanceItems(debt([pend('A-001', '2026-11-05'), pend('A-002', '2026-12-10')], ['| A-009 | 2026-11-09 | 通过 |']), T);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.id), ['A-001', 'A-002']);
  assert.equal(items[0].due, '2026-11-05'); assert.equal(items[0].overdueDays, 5);
  assert.equal(items[0].what, '验什么');
  assert.ok(items[1].overdueDays <= 0);
});

// ---- flake ledger ----
test('flake: valid sample passes', () => {
  const r = lintFlakeLedger(flake(fl('用例甲', '未处理'), fl('用例乙', '已根治 abc1234'), fl('用例丙', '已隔离', '2026-12-01')), T);
  assert.deepEqual(r, { errors: [], warnings: [] });
});
test('flake: status outside the allowed set fails; 已根治 needs a commit id', () => {
  assert.ok(has(lintFlakeLedger(flake(fl('甲', '处理中')), T).errors, /flake-ledger\.md:7:.*状态/));
  assert.ok(has(lintFlakeLedger(flake(fl('甲', '已根治')), T).errors, /提交号/));
});
test('flake: 已隔离 without a valid due date fails; other statuses must write -', () => {
  assert.ok(has(lintFlakeLedger(flake(fl('甲', '已隔离', '-')), T).errors, /到期日/));
  assert.ok(has(lintFlakeLedger(flake(fl('甲', '已隔离', '2026-02-30')), T).errors, /到期日/));
  assert.ok(has(lintFlakeLedger(flake(fl('甲', '未处理', '2026-12-01')), T).errors, /到期日/));
});
test('flake: 已隔离 overdue 1 day warns, 15 days errors', () => {
  const w = lintFlakeLedger(flake(fl('甲', '已隔离', '2026-11-09')), T);
  assert.equal(w.errors.length, 0); assert.equal(w.warnings.length, 1);
  const e = lintFlakeLedger(flake(fl('甲', '已隔离', '2026-10-26')), T);
  assert.equal(e.errors.length, 1);
});
test('flake: same case twice with a 未处理 row fails; both 已根治 passes', () => {
  const bad = lintFlakeLedger(flake(fl('甲', '已根治 abc1234'), fl('甲', '未处理')), T);
  assert.ok(has(bad.errors, /甲.*(第二次|根治或隔离)/), bad.errors.join('\n'));
  const ok = lintFlakeLedger(flake(fl('甲', '已根治 abc1234'), fl('甲', '已根治 def5678', '-', '2026-11-02')), T);
  assert.deepEqual(ok.errors, []);
  const single = lintFlakeLedger(flake(fl('甲', '未处理'), fl('乙', '未处理')), T);
  assert.deepEqual(single.errors, []);
});
test('flake: wrong header, empty case, invalid or future date fail', () => {
  assert.ok(has(lintFlakeLedger(flake(fl('甲', '未处理')).replace('| 现象 |', '| 说明 |'), T).errors, /表头/));
  assert.ok(has(lintFlakeLedger(flake(fl(' ', '未处理')), T).errors, /用例/));
  assert.ok(has(lintFlakeLedger(flake(fl('甲', '未处理', '-', '2026-02-30')), T).errors, /日期/));
  assert.ok(has(lintFlakeLedger(flake(fl('甲', '未处理', '-', '2026-11-11')), T).errors, /日期/));
});

// ---- store ledger ----
test('store: valid sample passes, with empty data, unknown dates and a review in progress', () => {
  const text = store([sb('3.0.1', '-', '通过', '-', '日期没记'), sb('3.0.3', '2026-11-01', '被拒', '2026-11-03', '关键词堆砌'), sb('3.0.4', '2026-11-09', '审核中')],
    ['| 2026-11-10 | 120 | 9 | 2 | 4.5 | 3 |', '| 2026-11-03 | 118 | - | - | - | - |']);
  assert.deepEqual(lintStoreLedger(text, T), { errors: [], warnings: [] });
  assert.deepEqual(lintStoreLedger(store(), T), { errors: [], warnings: [] });
});
test('store: both tables are required and the headers are fixed', () => {
  assert.ok(has(lintStoreLedger('# 商店台账\n', T).errors, /缺少「## 提交」/));
  assert.ok(has(lintStoreLedger('# 商店台账\n', T).errors, /缺少「## 数据」/));
  assert.ok(has(lintStoreLedger(store().replace('| 备注 |', '| 说明 |'), T).errors, /store-ledger\.md:5: 表头/));
  assert.ok(has(lintStoreLedger(store().replace('## 数据', '## 别的'), T).errors, /只允许在/));
});
test('store: submission rows reject bad versions, results and dates', () => {
  const e = (row) => lintStoreLedger(store([row]), T).errors;
  assert.ok(has(e(sb('v3.0.3', '2026-11-01', '通过')), /版本/));
  assert.ok(has(e(sb('3.0', '2026-11-01', '通过')), /版本/));
  assert.ok(has(e(sb('3.0.3', '2026-11-01', '过了')), /结果/));
  assert.ok(has(e(sb('3.0.3', '2026-02-30', '通过')), /提交日/));
  assert.ok(has(e(sb('3.0.3', '2026-11-11', '审核中')), /晚于今天/));
  assert.ok(has(e(sb('3.0.3', '2026-11-01', '通过', '2026-11-11')), /结果日/));
  assert.ok(has(e(sb('3.0.3', '2026-11-05', '通过', '2026-11-03')), /早于提交日/));
  assert.ok(has(e(sb('3.0.3', '', '通过')), /是空的/));
  assert.ok(has(e('| 3.0.3 | 2026-11-01 | 通过 | - |'), /4 格/));
});
test('store: a review in progress needs a submit day and no result day; a rejection needs a reason', () => {
  const e = (row) => lintStoreLedger(store([row]), T).errors;
  assert.ok(has(e(sb('3.0.3', '-', '审核中')), /提交日不能写 -/));
  assert.ok(has(e(sb('3.0.3', '2026-11-01', '审核中', '2026-11-03')), /结果日要写 -/));
  assert.ok(has(e(sb('3.0.3', '2026-11-01', '被拒', '2026-11-03')), /原因/));
  assert.deepEqual(e(sb('3.0.3', '2026-11-01', '撤回', '2026-11-02')), []);
});
test('store: the same version may be submitted again on another day, not twice on one day', () => {
  const again = store([sb('3.0.3', '2026-11-01', '被拒', '2026-11-02', '原因'), sb('3.0.3', '2026-11-04', '通过', '2026-11-05')]);
  assert.deepEqual(lintStoreLedger(again, T).errors, []);
  const twice = store([sb('3.0.3', '2026-11-01', '撤回'), sb('3.0.3', '2026-11-01', '通过')]);
  assert.ok(has(lintStoreLedger(twice, T).errors, /重复的「版本 \+ 提交日」/));
});
test('store: data rows need a past unique day and real numbers', () => {
  const e = (...rows) => lintStoreLedger(store([], rows), T).errors;
  assert.ok(has(e('| 2026-11-11 | 1 | 1 | 1 | 4 | 1 |'), /晚于今天/));
  assert.ok(has(e('| 2026-11-01 | 1 | 1 | 1 | 4 | 1 |', '| 2026-11-01 | 2 | 1 | 1 | 4 | 1 |'), /重复/));
  assert.ok(has(e('| 2026-11-01 | 约100 | 1 | 1 | 4 | 1 |'), /周用户.*数字/));
  assert.ok(has(e('| 2026-11-01 | 1.5 | 1 | 1 | 4 | 1 |'), /整数/));
  assert.ok(has(e('| 2026-11-01 | 1 | 1 | 1 | 5.1 | 1 |'), /超过 5/));
  assert.ok(has(e('| 2026-11-01 | -3 | 1 | 1 | 4 | 1 |'), /数字/));
  assert.ok(has(e('| 2026-11-01 | - | - | - | - | - |'), /没有任何数字/));
  assert.ok(has(e('| 2026-11-01 | 1 | 1 | 1 | 4 |'), /5 格/));
});
test('store: a table row that is not parsed is reported, not skipped', () => {
  assert.ok(has(lintStoreLedger(store() + '\n> | 3.0.9 | 2026-11-01 | 通过 | - | - |\n', T).errors, /引用块或列表/));
});
test('readiness: the three-day rule decides ready, counted from the release day', () => {
  const at = (releasedOn) => storeReadiness(store(), { today, version: '3.0.4', releasedOn });
  assert.equal(at('2026-11-08').ready, false);
  assert.match(at('2026-11-08').lines[0], /只用了 2 天.*最早 2026-11-11/);
  assert.equal(at('2026-11-07').ready, true);
  assert.match(at('2026-11-07').lines[0], /已用 3 天/);
  assert.match(at('2026-11-07').lines.join('\n'), /还没有商店提交记录/);
});
test('readiness: the gap is measured from the newest dated submission and ignores withdrawn ones', () => {
  const gap = (subs, todayStr = today) => storeReadiness(store(subs), { today: todayStr, version: '3.0.4', releasedOn: '2026-11-01' }).lines.join('\n');
  const rows = [sb('3.0.2', '2026-10-28', '通过', '2026-10-30'), sb('3.0.1', '2026-10-01', '通过', '2026-10-02'), sb('3.0.3', '2026-11-08', '撤回')];
  assert.match(gap(rows), /上次提交 v3\.0\.2（2026-10-28），距今 13 天，不到 14 天/);
  assert.match(gap(rows, '2026-11-11'), /距今 14 天，在 14 到 28 天之间/);
  assert.match(gap(rows, '2026-11-25'), /距今 28 天，在 14 到 28 天之间/);
  assert.match(gap(rows, '2026-11-26'), /距今 29 天，已超过 28 天/);
  assert.match(gap([sb('3.0.3', '-', '通过')]), /没记提交日/);
  assert.match(gap([sb('3.0.4', '2026-11-05', '审核中')]), /已有 v3\.0\.4 的提交记录（审核中）/);
  assert.doesNotMatch(gap([sb('3.0.4', '2026-11-05', '被拒', '2026-11-06', '原因')]), /已有 v3\.0\.4/);
});

// ---- freshness-ledger.md ----
// A fixture registry: the default models are computed, so only evaluating
// ai.js (not a regex over its text) reads them right.
const FAKE_ROOT = {
  'shared.js': 'const SETTINGS_DEFAULTS = { alphaModel: "a-1" };\n',
  'ai.js': 'const OPENAI_COMPAT_PROVIDERS = {\n  alpha: { defaultModel: "a-" + (1) },\n  custom: { defaultModel: "" },\n};\n' +
    'const _AI_BESPOKE_PROVIDERS = { beta: { defaultModel: ["b", "2"].join("-") } };\n',
  'fixture-tests.html': '<!doctype html>\n<script>\nconst FAKE_REPLY = {};\n</script>\n',
};
const FM_HEAD = '| 服务商 | 默认模型 | 最近核实 | 备注 |\n|---|---|---|---|\n';
const FF_HEAD = '| 服务 | 位置 | 最近核实 | 备注 |\n|---|---|---|---|\n';
const fresh = (models, fixtures) => `# 核实台账\n\n## 默认模型\n\n${FM_HEAD}${models.join('\n')}\n\n## 远端夹具\n\n${FF_HEAD}${fixtures.join('\n')}\n`;
const fm = (id, model, date = '未核实') => `| ${id} | ${model} | ${date} | - |`;
const ff = (svc, place, date = '未核实') => `| ${svc} | ${place} | ${date} | - |`;
const PROVIDERS = { alpha: 'a-1', beta: 'b-2' };
const files = { 'tests/x-tests.html': 'one\ntwo\nconst FAKE_REPLY = 1;\n' };
const FILE_INFO = (p) => (Object.hasOwn(files, p) ? { lines: files[p].split('\n').length, text: files[p] } : null);
const lf = (text, opts = {}) => lintFreshness(text, { today, providers: PROVIDERS, fileInfo: FILE_INFO, ...opts });
const okModels = [fm('alpha', 'a-1'), fm('beta', 'b-2')];

test('freshness: valid sample passes and counts 未核实 rows', () => {
  const r = lf(fresh(okModels, [ff('Svc', 'tests/x-tests.html', '2026-11-01'), ff('Svc', 'tests/x-tests.html:3'), ff('Svc', 'tests/x-tests.html#FAKE_REPLY')]));
  assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, []);
  assert.equal(r.unverified, 4);
});
test('freshness: a malformed row, a bad date and a future date fail', () => {
  assert.match(lf(fresh(okModels, ['| Svc | tests/x-tests.html | 未核实 |'])).errors.join('\n'), /3 格，应为 4 格/);
  assert.match(lf(fresh(okModels, [ff('Svc', 'tests/x-tests.html', '2026-02-30')])).errors.join('\n'), /不是合法的 YYYY-MM-DD/);
  assert.match(lf(fresh(okModels, [ff('Svc', 'tests/x-tests.html', 'last week')])).errors.join('\n'), /不是合法的 YYYY-MM-DD/);
  assert.match(lf(fresh(okModels, [ff('Svc', 'tests/x-tests.html', '2026-11-11')])).errors.join('\n'), /晚于今天/);
  assert.match(lf(fresh([fm('alpha', 'a-1', '2026-11-11'), fm('beta', 'b-2')], [])).errors.join('\n'), /晚于今天/);
  assert.equal(lf(fresh(okModels, [ff('Svc', 'tests/x-tests.html', today)])).errors.length, 0, 'today is not in the future');
});
test('freshness: a 位置 that does not exist, or points past the file, fails', () => {
  const err = (place) => lf(fresh(okModels, [ff('Svc', place)])).errors.join('\n');
  assert.match(err('tests/gone-tests.html'), /不存在/);
  assert.match(err('tests/x-tests.html:99'), /没有第 99 行/);
  assert.match(err('tests/x-tests.html#NO_SUCH'), /找不到夹具名/);
  for (const bad of ['/abs/tests/x-tests.html', '../tests/x-tests.html', 'tests/../tests/x-tests.html', 'tests/x-tests.html junk']) assert.match(err(bad), /相对路径/, bad);
});
test('freshness: a missing provider, an extra provider and a changed default model fail', () => {
  assert.match(lf(fresh([fm('alpha', 'a-1')], [])).errors.join('\n'), /服务商 beta（默认模型 b-2）.*没有行/);
  assert.match(lf(fresh([...okModels, fm('gone', 'g-1')], [])).errors.join('\n'), /gone 在 ai\.js 里已经没有了/);
  const changed = lf(fresh([fm('alpha', 'a-0', '2026-11-01'), fm('beta', 'b-2')], [])).errors.join('\n');
  assert.match(changed, /alpha 的默认模型在 ai\.js 里是 a-1，这里写的是 a-0/);
  assert.match(lf(fresh([...okModels, fm('alpha', 'a-1')], [])).errors.join('\n'), /alpha 重复/);
});
test('freshness: older than 90 days warns and never fails; 90 days is still fresh', () => {
  const old = lf(fresh([fm('alpha', 'a-1', '2026-08-11'), fm('beta', 'b-2')], [ff('Svc', 'tests/x-tests.html', '2026-01-01')]));
  assert.deepEqual(old.errors, []);
  assert.equal(old.warnings.length, 2); assert.match(old.warnings[0], /91 天/);
  assert.equal(old.stale.length, 2);
  const edge = lf(fresh([fm('alpha', 'a-1', '2026-08-12'), fm('beta', 'b-2')], []));
  assert.deepEqual(edge.warnings, []); assert.equal(FRESH_STALE_DAYS, 90);
});
test('freshness: both tables are required and the headers are fixed', () => {
  assert.match(lf('# x\n\n## 默认模型\n\n' + FM_HEAD + okModels.join('\n') + '\n').errors.join('\n'), /缺少「## 远端夹具」/);
  assert.match(lf(fresh(okModels, []).replace('| 服务 | 位置 |', '| 服务 | 文件 |')).errors.join('\n'), /表头必须是/);
  assert.match(lf(fresh(okModels, []) + '\n## 其他\n\n' + FF_HEAD).errors.join('\n'), /只允许在/);
});
test('freshness: the registry is read by evaluating ai.js, not by matching its text', () => withDir(FAKE_ROOT, (d) => {
  assert.deepEqual(loadProviderDefaults(d), { alpha: 'a-1', beta: 'b-2' });
}));
test('freshness: the real registry has every provider row, and the real ledger matches it', () => {
  const real = loadProviderDefaults(ROOT);
  assert.ok(Object.keys(real).length >= 10, 'the real registry lists the built-in providers');
  assert.ok(!Object.hasOwn(real, 'custom'));
  for (const m of Object.values(real)) assert.ok(m.length > 0);
  const r = lintFreshness(readFileSync(join(ROOT, '.claude/freshness-ledger.md'), 'utf8'), { today: '2026-11-11', providers: real, fileInfo: repoFileInfo(ROOT) });
  assert.deepEqual(r.errors, []);
  const dropOne = { ...real, zz_new_provider: 'zz-1' };
  assert.match(lintFreshness(readFileSync(join(ROOT, '.claude/freshness-ledger.md'), 'utf8'), { today: '2026-11-11', providers: dropOne, fileInfo: repoFileInfo(ROOT) }).errors.join('\n'), /zz_new_provider/);
});

// ---- 临时事项 parser shared with docs-lint, and the due-soon list ----
const TEMP = (lines) => `# x\n\n## 临时事项（说明）\n\n${lines.join('\n')}\n\n## 别的\n\n- **不算（到期日 2000-01-01）**\n`;
test('tempItems: kinds and dates, only inside the section', () => {
  const items = tempItems(TEMP(['- （甲已于 2026-01-01 退役）', '- **乙（到期日 2026-11-20）**：说明', '- 丙没有标记', '- **丁（到期日 不定）**', '- **戊（到期日 2026-02-30）**', '  - 子项（到期日 2000-01-01）']));
  assert.deepEqual(items.map((i) => [i.kind, i.due]), [['history', null], ['due', '2026-11-20'], ['no-marker', null], ['no-date', null], ['invalid-date', '2026-02-30']]);
  assert.equal(items[1].title, '乙（到期日 2026-11-20）');
  assert.equal(items[1].lineNo, 6);
  assert.equal(tempItems('# 没有这一节\n'), null);
});
test('dueItems: due within N days or overdue, from all three sources, sorted', () => withDir({
  ...FAKE_ROOT,
  'expiring-items.md': TEMP(['- **近（到期日 2026-11-20）**', '- **远（到期日 2027-01-01）**', '- **过（到期日 2026-11-01）**']),
  'acceptance-debt.md': debt([pend('A-001', '2026-11-24'), pend('A-002', '2026-11-25')]),
  'freshness-ledger.md': fresh([fm('alpha', 'a-1', '2026-08-01'), fm('beta', 'b-2', '2026-10-01')], [ff('Fake', 'fixture-tests.html')]),
}, (d) => {
  const r = dueItems({ dir: d, root: d, today, within: 14 });
  assert.deepEqual(r.problems, []);
  // alpha was checked 2026-08-01, so it turned stale on 2026-10-30; A-002 (15 days) and 远 stay out.
  assert.deepEqual(r.items.map((i) => [i.source, i.due, i.daysLeft]), [
    ['freshness', '2026-10-30', -11], ['expiring-items', '2026-11-01', -9], ['expiring-items', '2026-11-20', 10], ['acceptance-debt', '2026-11-24', 14],
  ]);
  assert.match(r.items.find((i) => i.source === 'freshness').what, /alpha/);
}));
test('dueItems: an unreadable or malformed register is a problem, not an empty list', () => withDir({
  ...FAKE_ROOT,
  'expiring-items.md': TEMP(['- 没有标记']),
  'freshness-ledger.md': fresh([fm('alpha', 'a-1')], []),
}, (d) => {
  const r = dueItems({ dir: d, root: d, today, within: 14 });
  const all = r.problems.join('\n');
  assert.match(all, /acceptance-debt\.md: 读不到文件/);
  assert.match(all, /到期日写法不对/);
  assert.match(all, /beta/);
}));
test('cli: --due-within --json lists items and exits 0; a problem exits 2; a bad number exits 2', () => withDir(set({
  'expiring-items.md': TEMP(['- **近（到期日 2026-11-20）**']),
}), (d) => {
  const r = run(d, ['--due-within', '14', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.today, today); assert.equal(j.within, 14);
  assert.deepEqual(j.items.map((i) => i.due), ['2026-11-20']);
  assert.equal(run(d, ['--due-within', '5', '--json']).status, 0);
  assert.deepEqual(JSON.parse(run(d, ['--due-within', '5', '--json']).stdout).items, []);
  assert.equal(run(d, ['--due-within', 'soon']).status, 2);
  const plain = run(d, ['--due-within', '14']);
  assert.match(plain.stdout, /还有 10 天（2026-11-20）/);
  rmSync(join(d, 'expiring-items.md'));
  assert.equal(run(d, ['--due-within', '14', '--json']).status, 2);
}));

// ---- command line ----
function withDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'registers-lint-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    return fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const run = (dir, args = [], todayStr = today) =>
  spawnSync('node', [join(ROOT, 'scripts/registers-lint.mjs'), ...args], {
    encoding: 'utf8', env: { ...process.env, PBP_REGISTERS_DIR: dir, PBP_REPO_ROOT: dir, PBP_LINT_TODAY: todayStr },
  });
const set = (over = {}) => ({
  ...FAKE_ROOT,
  'freshness-ledger.md': fresh([fm('alpha', 'a-1'), fm('beta', 'b-2')], [ff('Fake', 'fixture-tests.html')]),
  'decisions.md': decisions(DEC_OK),
  'acceptance-debt.md': debt([pend('A-001', '2026-12-10')]),
  'flake-ledger.md': flake(fl('甲', '未处理')),
  'store-ledger.md': store([sb('3.0.3', '2026-11-01', '通过', '2026-11-03')]),
  ...over,
});

test('cli: clean files print PASS and exit 0', () => withDir(set(), (d) => {
  const r = run(d); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /PASS/);
}));
test('cli: an error exits 1 and names the file and line', () => withDir(set({ 'decisions.md': decisions('| 2026-02-30 | a | b | c |') }), (d) => {
  const r = run(d); assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /decisions\.md:7/);
}));
test('cli: only warnings print WARN and exit 0', () => withDir(set({ 'acceptance-debt.md': debt([pend('A-001', '2026-11-05')]) }), (d) => {
  const r = run(d); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /WARN/);
}));
const check = (dir, version, releasedOn, todayStr = today) =>
  spawnSync('node', [join(ROOT, 'scripts/registers-lint.mjs'), '--store-check', version], {
    encoding: 'utf8', env: { ...process.env, PBP_REGISTERS_DIR: dir, PBP_LINT_TODAY: todayStr, PBP_STORE_RELEASED_ON: releasedOn },
  });
test('cli: --store-check exits 0 after three days, 1 before, 2 when it cannot tell', () => withDir(set(), (d) => {
  const ok = check(d, 'v3.0.4', '2026-11-07'); assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.match(ok.stdout, /满 3 天/);
  const early = check(d, '3.0.4', '2026-11-09'); assert.equal(early.status, 1); assert.match(early.stdout, /最早 2026-11-12/);
  assert.equal(check(d, '3.0', '2026-11-07').status, 2);
  assert.equal(check(d, '3.0.4', 'someday').status, 2);
  assert.equal(check(d, '3.0.4', '2026-11-12').status, 2);
}));
test('cli: --store-check refuses a broken ledger instead of reading around it', () => withDir(set({ 'store-ledger.md': store([sb('3.0.3', '2026-11-01', '过了')]) }), (d) => {
  const r = check(d, '3.0.4', '2026-11-01'); assert.equal(r.status, 2); assert.match(r.stderr, /结果/);
}));
test('cli: a broken store ledger fails the plain run', () => withDir(set({ 'store-ledger.md': store([sb('3.0.3', '-', '审核中')]) }), (d) => {
  const r = run(d); assert.equal(r.status, 1); assert.match(r.stderr, /store-ledger\.md:7/);
}));
test('cli: a missing register file is an error', () => withDir({ 'decisions.md': decisions(DEC_OK) }, (d) => {
  assert.equal(run(d).status, 1);
}));
test('cli: --release-gate lists pending items and passes when none is overdue', () => withDir(set(), (d) => {
  const r = run(d, ['--release-gate']);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /A-001/);
}));
test('cli: --release-gate blocks on an overdue item and points at --accept-debt', () => withDir(set({ 'acceptance-debt.md': debt([pend('A-001', '2026-11-05'), pend('A-002', '2026-12-10')]) }), (d) => {
  const r = run(d, ['--release-gate']);
  assert.equal(r.status, 1); const out = r.stdout + r.stderr;
  assert.match(out, /A-001/); assert.match(out, /A-002/); assert.match(out, /--accept-debt/);
}));
test('cli: --release-gate --accept-debt lists accepted overdue items and exits 0', () => withDir(set({ 'acceptance-debt.md': debt([pend('A-001', '2026-11-05')]) }), (d) => {
  const r = run(d, ['--release-gate', '--accept-debt']);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /A-001/); assert.match(r.stdout, /接受|accept/i);
}));
test('cli: --release-gate also fails on a format error, even with --accept-debt', () => withDir(set({ 'flake-ledger.md': flake(fl('甲', '处理中')) }), (d) => {
  assert.equal(run(d, ['--release-gate']).status, 1);
  assert.equal(run(d, ['--release-gate', '--accept-debt']).status, 1);
}));
test('cli: an item overdue beyond 14 days fails the plain run but is a gate item: --accept-debt exits 0, without exits 1', () => withDir(set({ 'acceptance-debt.md': debt([pend('A-001', '2026-10-01')]) }), (d) => {
  assert.equal(run(d).status, 1);
  const acc = run(d, ['--release-gate', '--accept-debt']);
  assert.equal(acc.status, 0, acc.stdout + acc.stderr);
  assert.match(acc.stdout, /A-001/); assert.match(acc.stdout, /接受/);
  const blocked = run(d, ['--release-gate']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout + blocked.stderr, /A-001/); assert.match(blocked.stdout + blocked.stderr, /--accept-debt/);
  assert.doesNotMatch(blocked.stdout + blocked.stderr, /格式有错/);
}));
test('cli: a flake quarantine overdue beyond 14 days fails the plain run but does not change the gate exit code', () => withDir(set({ 'flake-ledger.md': flake(fl('甲', '已隔离', '2026-10-01')) }), (d) => {
  assert.equal(run(d).status, 1);
  assert.equal(run(d, ['--release-gate']).status, 0);
  assert.equal(run(d, ['--release-gate', '--accept-debt']).status, 0);
  const bad = set({ 'flake-ledger.md': flake(fl('甲', '已隔离', '2026-10-01'), fl('乙', '处理中')) });
  return withDir(bad, (d2) => {
    const r = run(d2, ['--release-gate']);
    assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /格式有错/);
  });
}));
test('cli: the gate reason names a format error as a format error, and an invalid due date counts as one', () => withDir(set({ 'acceptance-debt.md': debt([pend('A-001', '2026-13-01')]) }), (d) => {
  const r = run(d, ['--release-gate', '--accept-debt']);
  assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /格式有错/);
}));
test('cli: the real committed registers lint clean with the real clock', () => {
  const r = spawnSync('node', [join(ROOT, 'scripts/registers-lint.mjs')], { encoding: 'utf8', env: { ...process.env, PBP_LINT_TODAY: '' } });
  // not asserted on content that depends on the date: only that the CLI can read all three files
  assert.doesNotMatch(r.stdout + r.stderr, /读不到文件/);
});

// ---- table structure: nothing is silently skipped ----
test('structure: a second table under the same heading is an error (all three files)', () => {
  const extra = '\n| 编号 | 清账日 | 结果 |\n|---|---|---|\n| A-009 | 2026-11-09 | 通过 |\n';
  assert.ok(has(lintAcceptanceDebt(debt() + extra, T).errors, /第二张表|多张表|同一标题/), 'debt');
  const dec = decisions(DEC_OK) + '\n' + DEC_HEAD + '| 2026-08-04 | 乙 | 理由 | 范围 |\n';
  assert.ok(has(lintDecisions(dec, T).errors, /第二张表|多张表|同一标题/), 'decisions');
  const fk = flake(fl('甲', '未处理')) + '\n' + FL_HEAD + fl('乙', '未处理') + '\n';
  assert.ok(has(lintFlakeLedger(fk, T).errors, /第二张表|多张表|同一标题/), 'flake');
});
test('structure: a table outside the expected heading is an error (all three files)', () => {
  const stray = '\n## 杂项\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  assert.ok(has(lintAcceptanceDebt(debt() + stray, T).errors, /杂项/), 'debt');
  assert.ok(has(lintFlakeLedger(flake(fl('甲', '未处理')) + stray, T).errors, /杂项/), 'flake');
  const noHeading = '# 裁决登记册\n\n' + DEC_HEAD + DEC_OK + '\n';
  assert.ok(has(lintDecisions(noHeading, T).errors, /标题/), 'decisions before any ## heading');
});
test('structure: a header row without a separator row is an error (all three files)', () => {
  const nosep = (t) => t.replace(/\|---[|-]*\n/, '');
  assert.ok(has(lintDecisions(nosep(decisions(DEC_OK)), T).errors, /分隔行/), 'decisions');
  assert.ok(has(lintAcceptanceDebt(nosep(debt([pend('A-001', '2026-12-10')])), T).errors, /分隔行/), 'debt');
  assert.ok(has(lintFlakeLedger(nosep(flake(fl('甲', '未处理'))), T).errors, /分隔行/), 'flake');
});

test('structure: a row without its leading pipe is an error, and the gate does not lose sight of it', () => {
  const text = debt([pend('A-001', '2026-12-10')]).replace(/(\| A-001 [^\n]*\n)/, '$1A-002 | 2026-09-01 | s | w | h | 2026-10-01 |\n');
  assert.ok(text.includes('\nA-002 |'), 'fixture');
  const r = lintAcceptanceDebt(text, T);
  assert.ok(has(r.errors, /开头少了 \|/), r.errors.join('\n'));
  const dropLead = (t) => t.replace(/\n\| (2026-\d\d-\d\d \|)/, '\n$1');
  assert.ok(has(lintDecisions(dropLead(decisions(DEC_OK)), T).errors, /开头少了 \|/), 'decisions');
  assert.ok(has(lintFlakeLedger(dropLead(flake(fl('甲', '未处理'))), T).errors, /开头少了 \|/), 'flake');
});
test('structure: a table inside a blockquote or a list item is an error', () => {
  for (const prefix of ['> ', '- ', '  > ', '1. ']) {
    const nest = (t) => t.split('\n').map((l) => (l.startsWith('|') ? prefix + l : l)).join('\n');
    assert.ok(has(lintAcceptanceDebt(nest(debt([pend('A-001', '2026-12-10')])), T).errors, /引用块或列表/), `debt ${prefix}`);
    assert.ok(has(lintDecisions(nest(decisions(DEC_OK)), T).errors, /引用块或列表/), `decisions ${prefix}`);
    assert.ok(has(lintFlakeLedger(nest(flake(fl('甲', '未处理'))), T).errors, /引用块或列表/), `flake ${prefix}`);
  }
});
test('structure: prose with one pipe or an escaped pipe is not mistaken for a row', () => {
  const text = decisions(DEC_OK).replace('\n## ', '\n> 说明里写 a | b 这样一个竖线，或者 x \\\\| y \\\\| z。\n\n## ');
  assert.deepEqual(lintDecisions(text, T).errors, []);
});

// ---- release.sh surface ----
test('release.sh parses and documents --accept-debt; unknown flag exits 2', () => {
  assert.equal(spawnSync('bash', ['-n', join(ROOT, 'scripts/release.sh')]).status, 0);
  const help = spawnSync('bash', [join(ROOT, 'scripts/release.sh'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /--accept-debt/);
  const bad = spawnSync('bash', [join(ROOT, 'scripts/release.sh'), '--no-such-flag'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
