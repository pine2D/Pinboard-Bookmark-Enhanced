#!/usr/bin/env node
// Lint for the five registers under .claude/: decisions.md, acceptance-debt.md,
// flake-ledger.md, store-ledger.md, freshness-ledger.md. Format contract: each file's header note and the Task 0
// brief. Expiry uses the same 14-day grace window as docs-lint's 临时事项 check:
// overdue 1-14 days WARNs, more than 14 days FAILs.
//
// The lint* functions are pure (text + { today } in, { errors, warnings } out).
// The CLI reads the files; PBP_LINT_TODAY and PBP_REGISTERS_DIR override the
// date and the directory, and PBP_REPO_ROOT the tree that holds ai.js and the
// fixture files freshness-ledger.md points at (command-line tests only).
//
//   node scripts/registers-lint.mjs                       check the five files
//   node scripts/registers-lint.mjs --due-within 14 [--json]
//                                                         list what is due within N days or overdue:
//                                                         临时事项, acceptance debt, stale freshness rows
//   node scripts/registers-lint.mjs --store-check 3.0.4   may this version go to the store yet?
//   node scripts/registers-lint.mjs --latest-store-tag    print v<version> of latest approved row
//   node scripts/registers-lint.mjs --compare-freshness <HEAD 版> <暂存版>
//                                                         a changed default model must not keep the old date
//   node scripts/registers-lint.mjs --release-gate        list 待验; exit 1 on overdue
//                                                         (the four registers only: freshness-ledger.md
//                                                         and ai.js are never read here)
//   node scripts/registers-lint.mjs --release-gate --accept-debt
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { tempItems } from "./docs-lint.mjs";

export const GRACE_DAYS = 14;
const DAY_MS = 86400000;

const DECISIONS_HEADER = ["日期", "裁决", "理由", "范围"];
const PENDING_HEADER = ["编号", "登记日", "来源", "验什么", "怎么验", "到期日"];
const DONE_HEADER = ["编号", "清账日", "结果"];
const FLAKE_HEADER = ["日期", "用例", "现象", "状态", "到期日"];
const ID_RE = /^A-\d{3}$/;
const STORE_SUBMIT_HEADER = ["版本", "提交日", "结果", "结果日", "备注"];
const STORE_DATA_HEADER = ["日期", "周用户", "安装", "卸载", "评分", "评价数"];
const STORE_RESULTS = ["审核中", "通过", "被拒", "撤回"];
const VERSION_RE = /^\d+\.\d+\.\d+$/;
// Release policy (user ruling 2026-11-10): a candidate is used for three days
// before it goes to the store, and the store gets a version every 2-4 weeks.
export const STORE_SOAK_DAYS = 3;
export const STORE_GAP_MIN_DAYS = 14;
export const STORE_GAP_MAX_DAYS = 28;

// ---- parsing ----
function splitCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; }
    else if (s[i] === "|") { cells.push(cur.trim()); cur = ""; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}
const isSeparator = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes("-");

// Every Markdown table: { heading (nearest "## ..." above), headerLine, header, rows: [{ line, cells }] }.
// `tables.orphans` lists table-looking lines that are not part of any parsed
// table: a header row whose separator row is missing, a row without its
// leading "|", and a table inside a blockquote or a list item. GitHub renders
// all of these as table rows, so skipping them would hide entries from the
// lint and from the release gate.
const unescapedPipes = (s) => (s.replace(/\\\|/g, "").match(/\|/g) || []).length;
function parseTables(text) {
  const lines = text.split("\n");
  const tables = [];
  tables.orphans = [];
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s/.test(l)) { heading = l.replace(/^##\s+/, "").trim(); continue; }
    if (!l.trim().startsWith("|")) {
      const bare = l.replace(/^\s*(?:>\s*|[-*+]\s+|\d+[.)]\s+)+/, "");
      if (bare !== l && bare.startsWith("|")) tables.orphans.push({ line: i + 1, text: l.trim(), why: "nested" });
      else if (unescapedPipes(l) >= 2) tables.orphans.push({ line: i + 1, text: l.trim(), why: "no-leading-pipe" });
      continue;
    }
    if (!lines[i + 1] || !isSeparator(lines[i + 1])) { tables.orphans.push({ line: i + 1, text: l.trim(), why: "no-separator" }); continue; }
    const t = { heading, headerLine: i + 1, header: splitCells(l), rows: [] };
    i += 2;
    for (; i < lines.length && lines[i].trim().startsWith("|"); i++) t.rows.push({ line: i + 1, cells: splitCells(lines[i]) });
    i--;
    tables.push(t);
  }
  return tables;
}

// ---- dates ----
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return t;
}
const daysBetween = (todayStr, dateStr) => Math.round((parseDate(todayStr) - parseDate(dateStr)) / DAY_MS);

function sameHeader(a, b) {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

// Structure checks so nothing is silently skipped: table-like lines without a
// separator row, a table under a heading the file does not allow, and a second
// table under one heading. `allowed(heading)` says which headings may hold a table.
function checkStructure(tables, allowed, allowedText, at, errors) {
  for (const o of tables.orphans) {
    if (o.why === "nested") errors.push(`${at(o.line)} 表格不能放在引用块或列表里，这一行不会被检查。把它移到顶格`);
    else if (o.why === "no-leading-pipe") errors.push(`${at(o.line)} 这一行像表格行，但开头少了 |，不会被检查。在行首补上 |`);
    else errors.push(`${at(o.line)} 这一行像表格，但表头行后面没有分隔行 |---|---|，整张表会被跳过`);
  }
  const perHeading = new Map();
  for (const t of tables) {
    if (!allowed(t.heading)) {
      errors.push(`${at(t.headerLine)} 表格在「## ${t.heading || "（没有二级标题）"}」下，只允许在${allowedText}下放表`);
      continue;
    }
    if (perHeading.has(t.heading)) {
      errors.push(`${at(t.headerLine)} 「## ${t.heading}」下有第二张表，同一标题下只能有一张表（第 ${perHeading.get(t.heading)} 行已有）`);
    } else perHeading.set(t.heading, t.headerLine);
  }
}

// Shared per-row checks. `at(line)` builds the "file:line" prefix.
function checkShape(t, expected, at, errors) {
  if (!sameHeader(t.header, expected)) {
    errors.push(`${at(t.headerLine)} 表头必须是 | ${expected.join(" | ")} |，实际是 | ${t.header.join(" | ")} |`);
    return false;
  }
  return true;
}
function checkRow(row, header, at, errors) {
  const width = header.length;
  if (row.cells.length !== width) {
    errors.push(`${at(row.line)} 这一行有 ${row.cells.length} 格，应为 ${width} 格`);
    return false;
  }
  const empty = row.cells.findIndex((c) => c === "");
  if (empty !== -1) {
    errors.push(`${at(row.line)} 「${header[empty]}」是空的`);
    return false;
  }
  return true;
}
function checkPastDate(value, label, row, today, at, errors) {
  if (parseDate(value) === null) { errors.push(`${at(row.line)} ${label} "${value}" 不是合法的 YYYY-MM-DD 日期`); return false; }
  if (parseDate(value) > parseDate(today)) { errors.push(`${at(row.line)} ${label} ${value} 晚于今天 ${today}`); return false; }
  return true;
}
// Expiry with the grace window. Pushes a warning (1-14 days) or an error (>14).
// Format problems go to `errors`; expiry past the grace window goes to `dueErrors`
// so the release gate can treat the two differently.
function checkDue(value, who, row, today, at, errors, warnings, dueErrors) {
  if (parseDate(value) === null) { errors.push(`${at(row.line)} ${who} 到期日 "${value}" 不是合法的 YYYY-MM-DD 日期`); return; }
  const over = daysBetween(today, value);
  if (over <= 0) return;
  if (over <= GRACE_DAYS) warnings.push(`${at(row.line)} ${who} 到期日 ${value} 已过期 ${over} 天，超过 ${GRACE_DAYS} 天会报错`);
  else dueErrors.push(`${at(row.line)} ${who} 到期日 ${value} 已过期 ${over} 天，超过 ${GRACE_DAYS} 天宽限期，做完它或改期`);
}

// ---- decisions.md ----
export function lintDecisions(text, { today }) {
  const errors = [], warnings = [];
  const at = (n) => `decisions.md:${n}:`;
  const seen = new Map();
  let dataRows = 0;
  const tables = parseTables(text);
  checkStructure(tables, (h) => h !== "", "任一「## 标题」", at, errors);
  for (const t of tables) {
    if (t.heading === "") continue;
    if (!checkShape(t, DECISIONS_HEADER, at, errors)) continue;
    for (const row of t.rows) {
      dataRows++;
      if (!checkRow(row, DECISIONS_HEADER, at, errors)) continue;
      const [date, decision] = row.cells;
      checkPastDate(date, "日期", row, today, at, errors);
      const key = `${date}\u0000${decision}`;
      if (seen.has(key)) errors.push(`${at(row.line)} 重复的「日期 + 裁决」，第 ${seen.get(key)} 行已有`);
      else seen.set(key, row.line);
    }
  }
  if (dataRows === 0) errors.push("decisions.md: 全文件至少一行数据");
  return { errors, warnings };
}

// ---- acceptance-debt.md ----
function debtTables(text) {
  const tables = parseTables(text);
  return {
    pending: tables.find((t) => t.heading === "待验"),
    done: tables.find((t) => t.heading === "已清"),
  };
}

export function lintAcceptanceDebt(text, opts) {
  const r = lintAcceptanceDebtDetailed(text, opts);
  return { errors: [...r.errors, ...r.dueErrors], warnings: r.warnings };
}
// Same check, with expiry errors kept apart from format errors (release gate).
export function lintAcceptanceDebtDetailed(text, { today }) {
  const errors = [], warnings = [], dueErrors = [];
  const at = (n) => `acceptance-debt.md:${n}:`;
  const all = parseTables(text);
  checkStructure(all, (h) => h === "待验" || h === "已清", "「## 待验」和「## 已清」", at, errors);
  const { pending, done } = debtTables(text);
  const ids = new Map();
  const claimId = (id, row) => {
    if (!ID_RE.test(id)) { errors.push(`${at(row.line)} 编号 "${id}" 不是 A-001 这种形式`); return; }
    if (ids.has(id)) errors.push(`${at(row.line)} 编号 ${id} 重复，第 ${ids.get(id)} 行已有`);
    else ids.set(id, row.line);
  };
  if (!pending) errors.push('acceptance-debt.md: 缺少「## 待验」下的表');
  else if (checkShape(pending, PENDING_HEADER, at, errors)) {
    for (const row of pending.rows) {
      if (!checkRow(row, PENDING_HEADER, at, errors)) continue;
      const [id, reg, , , , due] = row.cells;
      claimId(id, row);
      checkPastDate(reg, "登记日", row, today, at, errors);
      checkDue(due, id, row, today, at, errors, warnings, dueErrors);
    }
  }
  if (!done) errors.push('acceptance-debt.md: 缺少「## 已清」下的表');
  else if (checkShape(done, DONE_HEADER, at, errors)) {
    for (const row of done.rows) {
      if (!checkRow(row, DONE_HEADER, at, errors)) continue;
      claimId(row.cells[0], row);
      checkPastDate(row.cells[1], "清账日", row, today, at, errors);
    }
  }
  return { errors, warnings, dueErrors };
}

// Pending rows for the release gate. overdueDays <= 0 means not yet due.
export function openAcceptanceItems(text, { today }) {
  const { pending } = debtTables(text);
  if (!pending || !sameHeader(pending.header, PENDING_HEADER)) return [];
  return pending.rows.filter((r) => r.cells.length === 6).map((r) => {
    const [id, , , what, , due] = r.cells;
    return { id, what, due, overdueDays: parseDate(due) === null ? 0 : daysBetween(today, due) };
  });
}

// ---- flake-ledger.md ----
export function lintFlakeLedger(text, opts) {
  const r = lintFlakeLedgerDetailed(text, opts);
  return { errors: [...r.errors, ...r.dueErrors], warnings: r.warnings };
}
// Same check, with quarantine-expiry errors kept apart from format errors.
export function lintFlakeLedgerDetailed(text, { today }) {
  const errors = [], warnings = [], dueErrors = [];
  const at = (n) => `flake-ledger.md:${n}:`;
  const byCase = new Map();
  const all = parseTables(text);
  checkStructure(all, (h) => h === "记录", "「## 记录」", at, errors);
  for (const t of all.filter((x) => x.heading === "记录").slice(0, 1)) {
    if (!checkShape(t, FLAKE_HEADER, at, errors)) continue;
    for (const row of t.rows) {
      if (!checkRow(row, FLAKE_HEADER, at, errors)) continue;
      const [date, name, , status, due] = row.cells;
      checkPastDate(date, "日期", row, today, at, errors);
      if (status === "已隔离") checkDue(due, `「${name}」`, row, today, at, errors, warnings, dueErrors);
      else if (status === "未处理" || /^已根治\s+\S+/.test(status)) {
        if (due !== "-") errors.push(`${at(row.line)} 状态「${status}」的到期日要写 -`);
      } else if (status.startsWith("已根治")) errors.push(`${at(row.line)} 「已根治」后面要跟提交号`);
      else errors.push(`${at(row.line)} 状态 "${status}" 不在允许范围内（未处理、已隔离、已根治 提交号）`);
      if (!byCase.has(name)) byCase.set(name, []);
      byCase.get(name).push({ line: row.line, status });
    }
  }
  if (!all.some((x) => x.heading === "记录")) errors.push('flake-ledger.md: 缺少「## 记录」下的表');
  for (const [name, rows] of byCase) {
    const open = rows.find((r) => r.status === "未处理");
    if (rows.length >= 2 && open) {
      errors.push(`flake-ledger.md:${open.line}: 用例「${name}」已上榜 ${rows.length} 次，第二次上榜必须根治或隔离，不能留「未处理」`);
    }
  }
  return { errors, warnings, dueErrors };
}

// ---- store-ledger.md ----
function storeTables(text) {
  const tables = parseTables(text);
  return { all: tables, submits: tables.find((t) => t.heading === "提交"), data: tables.find((t) => t.heading === "数据") };
}
export function lintStoreLedger(text, { today }) {
  const errors = [], warnings = [];
  const at = (n) => `store-ledger.md:${n}:`;
  const { all, submits, data } = storeTables(text);
  checkStructure(all, (h) => h === "提交" || h === "数据", "「## 提交」和「## 数据」", at, errors);
  if (!submits) errors.push("store-ledger.md: 缺少「## 提交」下的表");
  else if (checkShape(submits, STORE_SUBMIT_HEADER, at, errors)) {
    const seen = new Map();
    for (const row of submits.rows) {
      if (!checkRow(row, STORE_SUBMIT_HEADER, at, errors)) continue;
      const [version, sent, result, resultDay, note] = row.cells;
      if (!VERSION_RE.test(version)) errors.push(`${at(row.line)} 版本 "${version}" 不是 3.0.3 这种形式`);
      const sentOk = sent === "-" || checkPastDate(sent, "提交日", row, today, at, errors);
      if (!STORE_RESULTS.includes(result)) { errors.push(`${at(row.line)} 结果 "${result}" 不在允许范围内（${STORE_RESULTS.join("、")}）`); continue; }
      if (result === "审核中") {
        if (sent === "-") errors.push(`${at(row.line)} 「审核中」的提交日不能写 -`);
        if (resultDay !== "-") errors.push(`${at(row.line)} 「审核中」的结果日要写 -，出结果后再把两格一起改`);
      } else if (resultDay !== "-" && checkPastDate(resultDay, "结果日", row, today, at, errors)) {
        if (sentOk && sent !== "-" && parseDate(resultDay) < parseDate(sent)) errors.push(`${at(row.line)} 结果日 ${resultDay} 早于提交日 ${sent}`);
      }
      if (result === "被拒" && note === "-") errors.push(`${at(row.line)} 「被拒」要在备注里写原因`);
      const key = `${version}\u0000${sent}`;
      if (seen.has(key)) errors.push(`${at(row.line)} 重复的「版本 + 提交日」，第 ${seen.get(key)} 行已有`);
      else seen.set(key, row.line);
    }
  }
  if (!data) errors.push("store-ledger.md: 缺少「## 数据」下的表");
  else if (checkShape(data, STORE_DATA_HEADER, at, errors)) {
    const days = new Map();
    for (const row of data.rows) {
      if (!checkRow(row, STORE_DATA_HEADER, at, errors)) continue;
      const [day, ...nums] = row.cells;
      checkPastDate(day, "日期", row, today, at, errors);
      if (days.has(day)) errors.push(`${at(row.line)} 日期 ${day} 重复，第 ${days.get(day)} 行已有`);
      else days.set(day, row.line);
      nums.forEach((v, i) => {
        const label = STORE_DATA_HEADER[i + 1];
        if (v === "-") return;
        if (!/^\d+(\.\d+)?$/.test(v)) errors.push(`${at(row.line)} 「${label}」"${v}" 要写数字，没有就写 -`);
        else if (label === "评分" && Number(v) > 5) errors.push(`${at(row.line)} 评分 ${v} 超过 5`);
        else if (label !== "评分" && v.includes(".")) errors.push(`${at(row.line)} 「${label}」"${v}" 要写整数`);
      });
      if (nums.every((v) => v === "-")) errors.push(`${at(row.line)} 这一行没有任何数字`);
    }
  }
  return { errors, warnings };
}

// May `version` (released on `releasedOn`) go to the store today? `ready` only
// reflects the three-day rule; the 2-4 week spacing is advice in `lines`.
export function storeReadiness(text, { today, version, releasedOn }) {
  const lines = [];
  const used = daysBetween(today, releasedOn);
  const ready = used >= STORE_SOAK_DAYS;
  if (ready) lines.push(`v${version} 发版于 ${releasedOn}，已用 ${used} 天，满 ${STORE_SOAK_DAYS} 天`);
  else {
    const first = new Date(parseDate(releasedOn) + STORE_SOAK_DAYS * DAY_MS).toISOString().slice(0, 10);
    lines.push(`v${version} 发版于 ${releasedOn}，只用了 ${used} 天，不满 ${STORE_SOAK_DAYS} 天。最早 ${first} 提交`);
  }
  const { submits } = storeTables(text);
  const rows = submits && sameHeader(submits.header, STORE_SUBMIT_HEADER)
    ? submits.rows.filter((r) => r.cells.length === STORE_SUBMIT_HEADER.length) : [];
  const mine = rows.find((r) => r.cells[0] === version && r.cells[2] !== "被拒" && r.cells[2] !== "撤回");
  if (mine) lines.push(`台账里已有 v${version} 的提交记录（${mine.cells[2]}）`);
  const live = rows.filter((r) => r.cells[2] !== "撤回");
  const dated = live.filter((r) => parseDate(r.cells[1]) !== null).sort((a, b) => parseDate(b.cells[1]) - parseDate(a.cells[1]));
  if (!live.length) lines.push("台账里还没有商店提交记录");
  else if (!dated.length) lines.push(`上次提交 v${live[live.length - 1].cells[0]} 没记提交日，算不出间隔`);
  else {
    const [lastVersion, lastDay] = dated[0].cells;
    const gap = daysBetween(today, lastDay);
    const note = gap < STORE_GAP_MIN_DAYS ? `不到 ${STORE_GAP_MIN_DAYS} 天，没有急事可以再等`
      : gap > STORE_GAP_MAX_DAYS ? `已超过 ${STORE_GAP_MAX_DAYS} 天` : `在 ${STORE_GAP_MIN_DAYS} 到 ${STORE_GAP_MAX_DAYS} 天之间`;
    lines.push(`上次提交 v${lastVersion}（${lastDay}），距今 ${gap} 天，${note}`);
  }
  return { ready, lines };
}

function compareSemverParts(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Latest approved ("通过") version in store-ledger.md, e.g. "3.0.3", or null.
export function latestApprovedStoreVersion(text) {
  const { submits } = storeTables(text);
  if (!submits || !sameHeader(submits.header, STORE_SUBMIT_HEADER)) return null;
  const approved = submits.rows
    .filter((r) => r.cells.length === STORE_SUBMIT_HEADER.length && VERSION_RE.test(r.cells[0]) && r.cells[2] === "通过")
    .map((r) => r.cells[0]);
  if (!approved.length) return null;
  return approved.sort((a, b) => compareSemverParts(b, a))[0];
}

// The day a version was tagged. PBP_STORE_RELEASED_ON overrides it (tests).
function releasedOn(version, repoRoot) {
  if (process.env.PBP_STORE_RELEASED_ON) return process.env.PBP_STORE_RELEASED_ON;
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  try {
    return execFileSync("git", ["log", "-1", "--format=%cs", `v${version}^{commit}`], { cwd: repoRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return ""; }
}

// ---- freshness-ledger.md ----
// Every provider's factory-default model and every remote-API fixture carries
// the day it was last checked against the real service. The provider list and
// the default models come from ai.js itself (loadProviderDefaults), so a new
// provider, a removed one or a changed default fails here until its row is
// updated, and updating it is the moment to check it again.
const FRESH_MODEL_HEADER = ["服务商", "默认模型", "最近核实", "备注"];
const FRESH_FIXTURE_HEADER = ["服务", "位置", "最近核实", "备注"];
export const FRESH_UNVERIFIED = "未核实";
export const FRESH_STALE_DAYS = 90;
const LOCATION_RE = /^([^\s:#]+)(?::(\d+)|#(\S+))?$/;

// Evaluates shared.js and ai.js in a fresh context, the way
// tests/bookmark-live-preflight-tests.mjs loads them, and reads the two
// provider tables. Returns { id: defaultModel } without "custom" (user-added
// endpoints have no factory default; scripts/rules-lint.mjs counts the same way).
export function loadProviderDefaults(root) {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {}, info() {}, debug() {} }, URL, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, btoa, atob, encodeURIComponent, decodeURIComponent, escape, unescape });
  for (const file of ["shared.js", "ai.js"]) vm.runInContext(readFileSync(join(root, file), "utf8"), ctx, { filename: file });
  const tables = vm.runInContext("({ compat: OPENAI_COMPAT_PROVIDERS, bespoke: _AI_BESPOKE_PROVIDERS })", ctx);
  const out = {};
  for (const table of [tables.compat, tables.bespoke]) {
    for (const [id, cfg] of Object.entries(table)) {
      if (id === "custom") continue;
      out[id] = String(cfg.defaultModel);
    }
  }
  return out;
}

// What a 位置 cell points at, for lintFreshness. null when the file is missing.
export function repoFileInfo(root) {
  return (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    const text = readFileSync(abs, "utf8");
    return { lines: text.split("\n").length, text };
  };
}

function checkVerified(value, row, today, at, errors, warnings, stale, what) {
  if (value === FRESH_UNVERIFIED) return 1;
  if (!checkPastDate(value, "最近核实", row, today, at, errors)) return 0;
  const age = daysBetween(today, value);
  if (age > FRESH_STALE_DAYS) {
    warnings.push(`${at(row.line)} ${what} 最近核实 ${value}，已过去 ${age} 天，超过 ${FRESH_STALE_DAYS} 天，有空时再核实一次`);
    stale.push({ line: row.line, what, date: value, age });
  }
  return 0;
}

// Pure: text + { today, providers: { id: model }, fileInfo(path) -> null | { lines, text } }.
// Returns { errors, warnings, unverified, stale }.
export function lintFreshness(text, { today, providers, fileInfo }) {
  const errors = [], warnings = [], stale = [];
  let unverified = 0;
  const at = (n) => `freshness-ledger.md:${n}:`;
  const all = parseTables(text);
  checkStructure(all, (h) => h === "默认模型" || h === "远端夹具", "「## 默认模型」和「## 远端夹具」", at, errors);
  const models = all.find((t) => t.heading === "默认模型");
  const fixtures = all.find((t) => t.heading === "远端夹具");
  if (!models) errors.push("freshness-ledger.md: 缺少「## 默认模型」下的表");
  else if (checkShape(models, FRESH_MODEL_HEADER, at, errors)) {
    const seen = new Map();
    for (const row of models.rows) {
      if (!checkRow(row, FRESH_MODEL_HEADER, at, errors)) continue;
      const [id, model, verified] = row.cells;
      if (seen.has(id)) { errors.push(`${at(row.line)} 服务商 ${id} 重复，第 ${seen.get(id)} 行已有`); continue; }
      seen.set(id, row.line);
      if (!Object.hasOwn(providers, id)) { errors.push(`${at(row.line)} 服务商 ${id} 在 ai.js 里已经没有了，删掉这一行`); continue; }
      if (providers[id] !== model) {
        errors.push(`${at(row.line)} ${id} 的默认模型在 ai.js 里是 ${providers[id]}，这里写的是 ${model}。改成新模型，核实过再填日期，没核实就写 ${FRESH_UNVERIFIED}`);
        continue;
      }
      unverified += checkVerified(verified, row, today, at, errors, warnings, stale, `${id} 的默认模型 ${model}`);
    }
    for (const id of Object.keys(providers)) {
      if (!seen.has(id)) errors.push(`freshness-ledger.md: ai.js 里的服务商 ${id}（默认模型 ${providers[id]}）在「## 默认模型」里没有行`);
    }
  }
  if (!fixtures) errors.push("freshness-ledger.md: 缺少「## 远端夹具」下的表");
  else if (checkShape(fixtures, FRESH_FIXTURE_HEADER, at, errors)) {
    const seen = new Map();
    for (const row of fixtures.rows) {
      if (!checkRow(row, FRESH_FIXTURE_HEADER, at, errors)) continue;
      const [service, place, verified] = row.cells;
      const key = `${service}\u0000${place}`;
      if (seen.has(key)) { errors.push(`${at(row.line)} 「${service}」+「${place}」重复，第 ${seen.get(key)} 行已有`); continue; }
      seen.set(key, row.line);
      const m = LOCATION_RE.exec(place);
      const path = m && m[1];
      if (!m || isAbsolute(path) || normalize(path).startsWith("..") || normalize(path) !== path) {
        errors.push(`${at(row.line)} 位置 "${place}" 要写仓库内的相对路径，可以带 :行号 或 #夹具名`);
        continue;
      }
      const info = fileInfo(path);
      if (!info) { errors.push(`${at(row.line)} 位置 ${path} 这个文件不存在`); continue; }
      if (m[2] && Number(m[2]) > info.lines) { errors.push(`${at(row.line)} ${path} 只有 ${info.lines} 行，没有第 ${m[2]} 行`); continue; }
      if (m[3] && !info.text.includes(m[3])) { errors.push(`${at(row.line)} ${path} 里找不到夹具名 ${m[3]}`); continue; }
      unverified += checkVerified(verified, row, today, at, errors, warnings, stale, `${service} 夹具 ${place}`);
    }
  }
  return { errors, warnings, unverified, stale };
}

// A default model changed while its 最近核实 date stayed: the date belongs to
// the old model, so it must be cleared or replaced. Pure: the committed text
// (HEAD) and the staged text. Only rows present in both are compared; a first
// commit of the file has nothing to compare with and passes.
export function compareFreshness(oldText, newText) {
  const rows = (text) => {
    const t = parseTables(text).find((x) => x.heading === "默认模型");
    const out = new Map();
    if (!t || !sameHeader(t.header, FRESH_MODEL_HEADER)) return out;
    for (const r of t.rows) if (r.cells.length === FRESH_MODEL_HEADER.length) out.set(r.cells[0], { model: r.cells[1], verified: r.cells[2], line: r.line });
    return out;
  };
  const before = rows(oldText), after = rows(newText);
  const errors = [];
  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was || was.model === now.model) continue;
    if (now.verified === was.verified && now.verified !== FRESH_UNVERIFIED) {
      errors.push(`freshness-ledger.md:${now.line}: ${id} 的默认模型从 ${was.model} 改成了 ${now.model}，最近核实还是 ${now.verified}。这个日期核实的是旧模型：改成 ${FRESH_UNVERIFIED}，或者改成核实新模型的那一天`);
    }
  }
  return errors;
}

// ---- due soon (weekly sentinel, scripts/doctor.mjs) ----
// What needs attention within `within` days, read with the same parsers the
// lints use: 临时事项 (docs-lint's tempItems), pending acceptance debt, and
// freshness rows older than FRESH_STALE_DAYS (due = the day they turned stale).
// A register that cannot be read is listed in `problems`, never left out quietly.
export function dueItems({ dir, root, today, within }) {
  const items = [], problems = [];
  const read = (name) => {
    try { return readFileSync(join(dir, name), "utf8"); }
    catch (e) { problems.push(`${name}: 读不到文件（${e.code || e.message}）`); return null; }
  };
  const push = (source, where, what, due) => {
    const daysLeft = -daysBetween(today, due);
    if (daysLeft <= within) items.push({ source, where, what, due, daysLeft });
  };
  const temp = read("expiring-items.md");
  if (temp !== null) {
    const list = tempItems(temp);
    if (list === null) problems.push("expiring-items.md: 找不到「## 临时事项」一节");
    else for (const i of list) {
      if (i.kind === "due") push("expiring-items", `expiring-items.md:${i.lineNo}`, i.title, i.due);
      else if (i.kind !== "history") problems.push(`expiring-items.md:${i.lineNo}: 「${i.title}」的到期日写法不对`);
    }
  }
  const debt = read("acceptance-debt.md");
  if (debt !== null) {
    for (const i of openAcceptanceItems(debt, { today })) {
      if (parseDate(i.due) === null) problems.push(`acceptance-debt.md: ${i.id} 的到期日 "${i.due}" 不是合法日期`);
      else push("acceptance-debt", `acceptance-debt.md ${i.id}`, i.what, i.due);
    }
  }
  const fresh = read("freshness-ledger.md");
  if (fresh !== null) {
    let providers;
    try { providers = loadProviderDefaults(root); }
    catch (e) { problems.push(`ai.js: 读不到服务商注册表（${e.message}）`); }
    if (providers) {
      const r = lintFreshness(fresh, { today, providers, fileInfo: repoFileInfo(root) });
      for (const e of r.errors) problems.push(e);
      for (const st of r.stale) {
        const due = new Date(parseDate(st.date) + FRESH_STALE_DAYS * DAY_MS).toISOString().slice(0, 10);
        push("freshness", `freshness-ledger.md:${st.line}`, `${st.what} 该再核实了`, due);
      }
    }
  }
  items.sort((a, b) => a.daysLeft - b.daysLeft || a.where.localeCompare(b.where));
  return { items, problems };
}

// ---- command line ----
function localToday() {
  const n = new Date();
  return [n.getFullYear(), String(n.getMonth() + 1).padStart(2, "0"), String(n.getDate()).padStart(2, "0")].join("-");
}

function main(argv) {
  const releaseGate = argv.includes("--release-gate");
  const acceptDebt = argv.includes("--accept-debt");
  const today = process.env.PBP_LINT_TODAY || localToday();
  if (parseDate(today) === null) { console.error(`[registers] PBP_LINT_TODAY "${today}" 不是合法日期`); return 2; }
  const repoRoot = process.env.PBP_REPO_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = process.env.PBP_REGISTERS_DIR || join(repoRoot, ".claude");
  const cmpAt = argv.indexOf("--compare-freshness");
  if (cmpAt !== -1) {
    const [oldFile, newFile] = argv.slice(cmpAt + 1, cmpAt + 3);
    if (!oldFile || !newFile) { console.error("[registers] 用法：--compare-freshness <旧文件> <新文件>"); return 2; }
    let oldText, newText;
    try { oldText = readFileSync(oldFile, "utf8"); newText = readFileSync(newFile, "utf8"); }
    catch (e) { console.error(`[registers] 读不到文件（${e.code || e.message}）`); return 2; }
    const errs = compareFreshness(oldText, newText);
    for (const e of errs) console.error(`[registers] FAIL ${e}`);
    if (!errs.length) console.log("[registers] freshness-ledger.md: 改过默认模型的行都没有沿用旧日期");
    return errs.length ? 1 : 0;
  }
  const dueAt = argv.indexOf("--due-within");
  if (dueAt !== -1) {
    const raw = argv[dueAt + 1] || "";
    if (!/^\d+$/.test(raw)) { console.error("[registers] 用法：--due-within <天数> [--json]，例如 --due-within 14"); return 2; }
    const r = dueItems({ dir, root: repoRoot, today, within: Number(raw) });
    if (argv.includes("--json")) {
      console.log(JSON.stringify({ today, within: Number(raw), ...r }, null, 2));
    } else {
      console.log(`[registers] ${raw} 天内到期或已过期 ${r.items.length} 条`);
      for (const i of r.items) {
        const tag = i.daysLeft < 0 ? `已过期 ${-i.daysLeft} 天` : i.daysLeft === 0 ? "今天到期" : `还有 ${i.daysLeft} 天`;
        console.log(`  ${tag}（${i.due}）  ${i.where}  ${i.what}`);
      }
      for (const p of r.problems) console.error(`[registers] FAIL ${p}`);
    }
    return r.problems.length ? 2 : 0;
  }
  const storeAt = argv.indexOf("--store-check");
  if (storeAt !== -1) {
    const version = (argv[storeAt + 1] || "").replace(/^v/, "");
    if (!VERSION_RE.test(version)) { console.error("[registers] 用法：--store-check <版本>，例如 --store-check 3.0.4"); return 2; }
    let text;
    try { text = readFileSync(join(dir, "store-ledger.md"), "utf8"); }
    catch (e) { console.error(`[registers] store-ledger.md: 读不到文件（${e.code || e.message}）`); return 2; }
    const bad = lintStoreLedger(text, { today }).errors;
    if (bad.length) { for (const e of bad) console.error(`[registers] FAIL ${e}`); console.error("[registers] 商店台账格式有错，先修好"); return 2; }
    const day = releasedOn(version, repoRoot);
    if (parseDate(day) === null) { console.error(`[registers] 找不到 tag v${version} 的日期，先确认这个版本已经发版`); return 2; }
    if (parseDate(day) > parseDate(today)) { console.error(`[registers] v${version} 的发版日 ${day} 晚于今天 ${today}`); return 2; }
    const r = storeReadiness(text, { today, version, releasedOn: day });
    for (const l of r.lines) console.log(`[registers] ${l}`);
    return r.ready ? 0 : 1;
  }
  if (argv.includes("--latest-store-tag")) {
    let text;
    try { text = readFileSync(join(dir, "store-ledger.md"), "utf8"); }
    catch (e) { console.error(`[registers] store-ledger.md: 读不到文件（${e.code || e.message}）`); return 2; }
    const bad = lintStoreLedger(text, { today }).errors;
    if (bad.length) { for (const e of bad) console.error(`[registers] FAIL ${e}`); console.error("[registers] 商店台账格式有错，先修好"); return 2; }
    const version = latestApprovedStoreVersion(text);
    if (!version) { console.error("[registers] FAIL store-ledger.md: 「## 提交」里没有结果为「通过」的版本"); return 1; }
    console.log("v" + version);
    return 0;
  }
  // The release gate checks the four registers it always did. A freshness
  // problem is caught by pre-commit and CI and never stops a release, so the
  // gate neither reads freshness-ledger.md nor evaluates ai.js.
  let providers = null, providerError = "";
  if (!releaseGate) {
    try { providers = loadProviderDefaults(repoRoot); }
    catch (e) { providerError = e.message; }
  }
  let unverified = 0;
  const lintFresh = (t, o) => {
    if (!providers) return { errors: [`freshness-ledger.md: 读不到 ai.js 里的服务商注册表（${providerError}）`], warnings: [], dueErrors: [] };
    const r = lintFreshness(t, { ...o, providers, fileInfo: repoFileInfo(repoRoot) });
    unverified = r.unverified;
    return { errors: r.errors, warnings: r.warnings, dueErrors: [] };
  };
  const files = [
    ["decisions.md", (t, o) => ({ ...lintDecisions(t, o), dueErrors: [] })],
    ["acceptance-debt.md", lintAcceptanceDebtDetailed],
    ["flake-ledger.md", lintFlakeLedgerDetailed],
    ["store-ledger.md", (t, o) => ({ ...lintStoreLedger(t, o), dueErrors: [] })],
    ...(releaseGate ? [] : [["freshness-ledger.md", lintFresh]]),
  ];
  const errors = [], warnings = [], dueErrors = [];
  const texts = {};
  for (const [name, lint] of files) {
    try { texts[name] = readFileSync(join(dir, name), "utf8"); }
    catch (e) { errors.push(`${name}: 读不到文件（${e.code || e.message}）`); continue; }
    const r = lint(texts[name], { today });
    errors.push(...r.errors); warnings.push(...r.warnings);
    dueErrors.push(...r.dueErrors.map((m) => ({ file: name, m })));
  }
  for (const w of warnings) console.log(`[registers] WARN ${w}`);
  for (const e of errors) console.error(`[registers] FAIL ${e}`);
  if (unverified) console.log(`[registers] freshness-ledger.md 里 ${unverified} 行还没对真实服务核实过（${FRESH_UNVERIFIED}）`);

  if (!releaseGate) {
    for (const d of dueErrors) console.error(`[registers] FAIL ${d.m}`);
    if (errors.length || dueErrors.length) return 1;
    console.log(warnings.length ? `[registers] WARN ${warnings.length} 条警告，无错误` : "[registers] PASS");
    return 0;
  }
  // Gate mode: expiry is judged below (acceptance items) or does not concern the
  // release (flake quarantines); only format errors stop here.
  for (const d of dueErrors.filter((x) => x.file !== "acceptance-debt.md")) console.log(`[registers] WARN ${d.m}（不影响发版门）`);
  if (errors.length) { console.error("[registers] 登记册格式有错，先修好再发版"); return 1; }
  const items = openAcceptanceItems(texts["acceptance-debt.md"], { today });
  console.log(`[registers] 待验欠账 ${items.length} 条`);
  for (const i of items) {
    const tag = i.overdueDays > 0 ? `已过期 ${i.overdueDays} 天` : "未到期";
    console.log(`  ${i.id}  ${tag}（到期日 ${i.due}）  ${i.what}`);
  }
  const overdue = items.filter((i) => i.overdueDays > 0);
  if (!overdue.length) return 0;
  if (acceptDebt) {
    console.log(`[registers] 已用 --accept-debt 接受 ${overdue.length} 条过期欠账：${overdue.map((i) => i.id).join("、")}`);
    return 0;
  }
  console.error(`[registers] 有 ${overdue.length} 条过期欠账：${overdue.map((i) => i.id).join("、")}。先验完，或加 --accept-debt 接受后继续`);
  return 1;
}

// True when this file is the entry point, also when it was started through a
// symlink (argv[1] is the link; import.meta.url is the resolved file).
function isMainModule() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isMainModule()) {
  process.exitCode = main(process.argv.slice(2));
}
