#!/usr/bin/env node
// Lint for the three registers under .claude/: decisions.md, acceptance-debt.md,
// flake-ledger.md. Format contract: each file's header note and the Task 0
// brief. Expiry uses the same 14-day grace window as docs-lint's 临时事项 check:
// overdue 1-14 days WARNs, more than 14 days FAILs.
//
// The lint* functions are pure (text + { today } in, { errors, warnings } out).
// The CLI reads the files; PBP_LINT_TODAY and PBP_REGISTERS_DIR override the
// date and the directory (command-line tests only).
//
//   node scripts/registers-lint.mjs                       check the three files
//   node scripts/registers-lint.mjs --release-gate        list 待验; exit 1 on overdue
//   node scripts/registers-lint.mjs --release-gate --accept-debt
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GRACE_DAYS = 14;
const DAY_MS = 86400000;

const DECISIONS_HEADER = ["日期", "裁决", "理由", "范围"];
const PENDING_HEADER = ["编号", "登记日", "来源", "验什么", "怎么验", "到期日"];
const DONE_HEADER = ["编号", "清账日", "结果"];
const FLAKE_HEADER = ["日期", "用例", "现象", "状态", "到期日"];
const ID_RE = /^A-\d{3}$/;

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
function parseTables(text) {
  const lines = text.split("\n");
  const tables = [];
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s/.test(l)) { heading = l.replace(/^##\s+/, "").trim(); continue; }
    if (!l.trim().startsWith("|") || !lines[i + 1] || !isSeparator(lines[i + 1])) continue;
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
function checkDue(value, who, row, today, at, errors, warnings) {
  if (parseDate(value) === null) { errors.push(`${at(row.line)} ${who} 到期日 "${value}" 不是合法的 YYYY-MM-DD 日期`); return; }
  const over = daysBetween(today, value);
  if (over <= 0) return;
  if (over <= GRACE_DAYS) warnings.push(`${at(row.line)} ${who} 到期日 ${value} 已过期 ${over} 天，超过 ${GRACE_DAYS} 天会报错`);
  else errors.push(`${at(row.line)} ${who} 到期日 ${value} 已过期 ${over} 天，超过 ${GRACE_DAYS} 天宽限期，做完它或改期`);
}

// ---- decisions.md ----
export function lintDecisions(text, { today }) {
  const errors = [], warnings = [];
  const at = (n) => `decisions.md:${n}:`;
  const seen = new Map();
  let dataRows = 0;
  for (const t of parseTables(text)) {
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

export function lintAcceptanceDebt(text, { today }) {
  const errors = [], warnings = [];
  const at = (n) => `acceptance-debt.md:${n}:`;
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
      checkDue(due, id, row, today, at, errors, warnings);
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
  return { errors, warnings };
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
export function lintFlakeLedger(text, { today }) {
  const errors = [], warnings = [];
  const at = (n) => `flake-ledger.md:${n}:`;
  const byCase = new Map();
  for (const t of parseTables(text).filter((x) => x.heading === "记录")) {
    if (!checkShape(t, FLAKE_HEADER, at, errors)) continue;
    for (const row of t.rows) {
      if (!checkRow(row, FLAKE_HEADER, at, errors)) continue;
      const [date, name, , status, due] = row.cells;
      checkPastDate(date, "日期", row, today, at, errors);
      if (status === "已隔离") checkDue(due, `「${name}」`, row, today, at, errors, warnings);
      else if (status === "未处理" || /^已根治\s+\S+/.test(status)) {
        if (due !== "-") errors.push(`${at(row.line)} 状态「${status}」的到期日要写 -`);
      } else if (status.startsWith("已根治")) errors.push(`${at(row.line)} 「已根治」后面要跟提交号`);
      else errors.push(`${at(row.line)} 状态 "${status}" 不在允许范围内（未处理、已隔离、已根治 提交号）`);
      if (!byCase.has(name)) byCase.set(name, []);
      byCase.get(name).push({ line: row.line, status });
    }
  }
  if (!parseTables(text).some((x) => x.heading === "记录")) errors.push('flake-ledger.md: 缺少「## 记录」下的表');
  for (const [name, rows] of byCase) {
    const open = rows.find((r) => r.status === "未处理");
    if (rows.length >= 2 && open) {
      errors.push(`flake-ledger.md:${open.line}: 用例「${name}」已上榜 ${rows.length} 次，第二次上榜必须根治或隔离，不能留「未处理」`);
    }
  }
  return { errors, warnings };
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
  const dir = process.env.PBP_REGISTERS_DIR ||
    join(dirname(fileURLToPath(import.meta.url)), "..", ".claude");
  const files = [
    ["decisions.md", lintDecisions],
    ["acceptance-debt.md", lintAcceptanceDebt],
    ["flake-ledger.md", lintFlakeLedger],
  ];
  const errors = [], warnings = [];
  const texts = {};
  for (const [name, lint] of files) {
    try { texts[name] = readFileSync(join(dir, name), "utf8"); }
    catch (e) { errors.push(`${name}: 读不到文件（${e.code || e.message}）`); continue; }
    const r = lint(texts[name], { today });
    errors.push(...r.errors); warnings.push(...r.warnings);
  }
  for (const w of warnings) console.log(`[registers] WARN ${w}`);
  for (const e of errors) console.error(`[registers] FAIL ${e}`);

  if (!releaseGate) {
    if (errors.length) return 1;
    console.log(warnings.length ? `[registers] WARN ${warnings.length} 条警告，无错误` : "[registers] PASS");
    return 0;
  }
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
