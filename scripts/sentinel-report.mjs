#!/usr/bin/env node
// sentinel-report: the weekly sentinel's (.github/workflows/sentinel.yml)
// findings file and report. Each check appends JSON lines to one file; the
// report step turns them into Markdown and decides whether the issue is
// written. The parsers and the renderer are pure functions (tests/sentinel-report-tests.mjs).
//
// A record is { check, kind, subject, message }:
//   kind "finding"  something a person should look at; goes to the issue
//   kind "broken"   a check could not run at all; goes to the issue and fails the job
//   kind "note"     context for the step summary only (unverifiable links, a
//                   registry that did not answer); never written to the issue
// `subject` is rendered as code (package names, versions, URLs from the repo's
// docs, repo paths, test page names); `message` is escaped plain text. The issue
// is public, so no record ever carries a log excerpt.
//
//   node scripts/sentinel-report.mjs add vendor  --findings F --log L --exit N
//   node scripts/sentinel-report.mjs add npm     --findings F --log L --exit N
//   node scripts/sentinel-report.mjs add links   --findings F --log L --exit N
//   node scripts/sentinel-report.mjs add due     --findings F --log L --exit N
//   node scripts/sentinel-report.mjs add browser --findings F --channel C [--version V]
//        [--install-failed] [--pages-log L --pages-exit N] [--smoke-exit N]
//   node scripts/sentinel-report.mjs add broken  --findings F --check C --message M
//   node scripts/sentinel-report.mjs add note    --findings F --check C --subject S --message M
//   node scripts/sentinel-report.mjs should-comment --previous P --body B   (prints true or false)
//   node scripts/sentinel-report.mjs report --findings F --event E [--dry-run true]
//        --run-url U --sha S --date D --summary S --body B --comment C --output O
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ISSUE_TITLE = "Weekly sentinel";
export const ISSUE_LABEL = "sentinel";
const CHECK_TITLES = {
  vendor: "Vendored libraries", npm: ".qa-scan npm packages", links: "Links in the docs",
  browser: "Chrome for Testing channels", due: "Registers due soon", sentinel: "Sentinel itself",
};

// `key` identifies the finding across weeks (findingsDigest); it defaults to
// the whole record and leaves out anything that changes by itself, such as a
// day count.
const rec = (check, kind, subject, message, key) => ({ check, kind, subject: String(subject), message: String(message),
  key: key === undefined ? `${check}|${kind}|${subject}|${message}` : String(key) });

// ---- parsers: tool output -> records ----

// scripts/update-vendor.sh --check-only: exit 0 current, 1 drift, 2 something unverified.
export function vendorRecords(output, exit) {
  if (![0, 1, 2].includes(exit)) return [rec("vendor", "broken", "scripts/update-vendor.sh --check-only", `exited ${exit}`)];
  const out = [];
  let verified = 0;
  for (const line of output.split("\n")) {
    if (/^\s{2}\S+\s+\S+\s+\S+\s+ok\b/.test(line) || /^\s{2}openrouter\s+\S+\s+ok\b/.test(line)) verified++;
    const pkg = /^\s{2}(\S+)\s+(\S+)\s+(\S+)\s+(BEHIND|manual|UNVERIFIED)/.exec(line);
    if (pkg) {
      const [, name, cur, latest, status] = pkg;
      if (status !== "UNVERIFIED") verified++;
      if (status === "BEHIND") out.push(rec("vendor", "finding", name, `vendored ${cur}, latest on npm ${latest}`));
      else if (status === "manual") out.push(rec("vendor", "finding", name, "has no entry in vendor/vendor-lock.json"));
      else out.push(rec("vendor", "note", name, "the npm registry did not answer, so this package was not checked"));
      continue;
    }
    const or = /^\s{2}openrouter\s+(\S+)\s+(DEAD|UNVERIFIED)/.exec(line);
    if (or) {
      if (or[2] === "DEAD") verified++;
      if (or[2] === "DEAD") out.push(rec("vendor", "finding", `openrouter ${or[1]}`, "the OpenRouter default model is no longer in the OpenRouter model list"));
      else out.push(rec("vendor", "note", "openrouter", "the OpenRouter model list was not checked"));
    }
  }
  if (exit === 1 && !out.some((r) => r.kind === "finding")) out.push(rec("vendor", "broken", "scripts/update-vendor.sh --check-only", "reported drift in a form this report cannot read"));
  // Nothing confirmed either way is not a clean week.
  if (exit === 2 && verified === 0) return [rec("vendor", "broken", "scripts/update-vendor.sh --check-only", "could not verify a single package or model (registry unreachable?)")];
  return out;
}

// npm outdated --json: exit 0 nothing outdated, 1 something outdated.
export function npmRecords(output, exit) {
  if (exit !== 0 && exit !== 1) return [rec("npm", "broken", "npm outdated --prefix .qa-scan", `exited ${exit}`)];
  let data;
  // An npm wrapper may print a line after the JSON, so read from the first { to the last }.
  const start = output.indexOf("{"), end = output.lastIndexOf("}");
  try { data = start === -1 && !output.trim() ? {} : JSON.parse(output.slice(start, end + 1)); }
  catch { return [rec("npm", "broken", "npm outdated --prefix .qa-scan", "printed something that is not JSON")]; }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.error) return [rec("npm", "broken", "npm outdated --prefix .qa-scan", "did not list packages")];
  const out = [];
  for (const [name, v] of Object.entries(data).sort(([a], [b]) => a.localeCompare(b))) {
    if (!v || v.current === v.latest) continue;
    let msg = `installed ${v.current || "nothing"}, latest ${v.latest}`;
    if (name === "playwright") msg += ". A Playwright bump replaces the bundled Chromium: re-check the render baselines before moving the pin";
    out.push(rec("npm", "finding", name, msg));
  }
  if (exit === 1 && !out.length) out.push(rec("npm", "broken", "npm outdated --prefix .qa-scan", "exited 1 but listed nothing outdated"));
  return out;
}

// scripts/link-check.mjs --json: exit 0 nothing broken, 1 something broken, 2 could not read the docs.
export function linkRecords(json, exit) {
  if (exit === 2 || !json || !Array.isArray(json.results)) return [rec("links", "broken", "scripts/link-check.mjs", exit === 2 ? "could not read the docs" : "wrote no results")];
  const out = [];
  for (const r of json.results) {
    const where = `in ${r.files.join(", ")}`;
    if (r.result === "broken") out.push(rec("links", "finding", r.url, `${r.detail}, ${where}`));
    else if (r.result === "unverifiable") out.push(rec("links", "note", r.url, `could not be verified (${r.detail}), ${where}`));
  }
  if (exit === 1 && !out.some((r) => r.kind === "finding")) out.push(rec("links", "broken", "scripts/link-check.mjs", "exited 1 but listed no broken link"));
  const unreachable = (r) => r.result === "unverifiable" && /^(timeout|network error)/.test(r.detail);
  if (json.results.length && json.results.every(unreachable)) return [rec("links", "broken", "scripts/link-check.mjs", `none of the ${json.results.length} links answered (timeout or network error); the network is probably down`)];
  return out;
}

// scripts/registers-lint.mjs --due-within 14 --json: exit 0, or 2 with problems listed.
export function dueRecords(json, exit) {
  if (!json || !Array.isArray(json.items) || !Array.isArray(json.problems) || (exit !== 0 && exit !== 2)) {
    return [rec("due", "broken", "scripts/registers-lint.mjs --due-within", `exited ${exit} without a readable list`)];
  }
  const out = json.items.map((i) => rec("due", "finding", i.where,
    `${i.what}: due ${i.due}, ${i.daysLeft < 0 ? `${-i.daysLeft} days overdue` : i.daysLeft === 0 ? "due today" : `in ${i.daysLeft} days`}`,
    `due|${i.where}|${i.what}|${i.due}`));
  for (const p of json.problems) out.push(rec("due", "finding", ".claude/", p));
  return out;
}

// Failed pages, as scripts/run-html-suites.mjs lists them at the end of its output.
export function failedPages(log) {
  return [...new Set([...log.matchAll(/^ {2}(tests\/[A-Za-z0-9._-]+-tests\.html)\b/gm)].map((m) => m[1]))].sort();
}
export function browserRecords({ channel, version = "", installFailed = false, pagesLog = "", pagesExit = 0, smokeExit = 0 }) {
  const ch = /^[a-z]+$/.test(channel) ? channel : "unknown";
  const ver = (/\d+(?:\.\d+)+/.exec(version) || [""])[0];
  const who = `Chrome for Testing ${ch}${ver ? " " + ver : ""}`;
  if (installFailed || !ver) return [rec("browser", "finding", `chrome@${ch}`, "Chrome for Testing could not be installed, so this channel was not tested")];
  const out = [];
  if (pagesExit !== 0) {
    const pages = failedPages(pagesLog);
    for (const p of pages) out.push(rec("browser", "finding", p, `fails on ${who}`));
    if (!pages.length) out.push(rec("browser", "finding", "scripts/run-html-suites.mjs", `the test pages stopped on ${who} before naming a page (exit ${pagesExit})`));
  }
  if (smokeExit !== 0) out.push(rec("browser", "finding", "scripts/zip-install-smoke.mjs", `the release ZIP install smoke fails on ${who} (exit ${smokeExit})`));
  return out;
}

// ---- report ----
export function escapeText(s) {
  // Markdown and HTML specials, and @ so a word never turns into a mention.
  return String(s).replace(/[\\`*_{}[\]<>|#~]/g, (c) => "\\" + c).replace(/&/g, "&amp;").replace(/@/g, "@​").replace(/\r?\n/g, " ");
}
export function code(s) {
  const t = String(s).replace(/\r?\n/g, " ");
  const longest = Math.max(0, ...[...t.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${/^`|`$/.test(t) ? " " + t + " " : t}${fence}`;
}

export function parseRecords(text) {
  const out = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!["finding", "broken", "note"].includes(r.kind)) throw new Error("bad kind");
      out.push(rec(r.check, r.kind, r.subject, r.message, typeof r.key === "string" ? r.key : undefined));
    } catch { out.push(rec("sentinel", "broken", "findings.jsonl", `line ${i + 1} is not a valid record`)); }
  }
  return out;
}

// Write the issue only on a schedule or manual run that is not a dry run, and
// only when there is something to report.
export function decide({ event, dryRun, records }) {
  const count = records.filter((r) => r.kind !== "note").length;
  if (!count) return { write: false, reason: "no findings, so the issue is left alone" };
  if (event === "pull_request") return { write: false, reason: "pull request run: would update the issue" };
  if (dryRun) return { write: false, reason: "dry run: would update the issue" };
  if (event === "schedule" || event === "workflow_dispatch") return { write: true, reason: "findings: the issue is updated" };
  return { write: false, reason: `event ${event}: the issue is only written on schedule or manual runs` };
}

const line = (r) => `- ${code(r.subject)}: ${escapeText(r.message)}`;
function grouped(records) {
  const out = [];
  for (const check of Object.keys(CHECK_TITLES)) {
    const rs = records.filter((r) => r.check === check);
    if (rs.length) out.push(`#### ${CHECK_TITLES[check]}`, "", ...rs.map(line), "");
  }
  const other = records.filter((r) => !Object.hasOwn(CHECK_TITLES, r.check));
  if (other.length) out.push("#### Other", "", ...other.map(line), "");
  return out;
}

// ---- digest: comment only when the set of findings changed ----
// The digest covers the keys of findings and broken checks, sorted and
// deduplicated, so the order of the checks, the run date and the run id never
// change it. It sits in the issue body as an HTML comment.
export function findingsDigest(records) {
  const keys = [...new Set(records.filter((r) => r.kind !== "note").map((r) => r.key))].sort();
  return createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 32);
}
const DIGEST_RE = /<!-- sentinel-digest: ([0-9a-f]{8,64}) -->/;
export function digestLine(digest) { return `<!-- sentinel-digest: ${digest} -->`; }
export function readDigest(body) { const m = DIGEST_RE.exec(body || ""); return m ? m[1] : ""; }
// The new body always replaces the old one; a comment (which is what notifies)
// goes out only for a new issue or a changed set of findings.
export function shouldComment({ previousBody, body }) {
  if (previousBody === null || previousBody === undefined || !String(previousBody).trim()) return true;
  const before = readDigest(previousBody), now = readDigest(body);
  return !before || !now || before !== now;
}

// GitHub rejects an issue body or comment over 65536 characters.
export const TEXT_LIMIT = 60000;
export function truncate(text, runUrl, limit = TEXT_LIMIT) {
  if (text.length <= limit) return text;
  const tail = `\n\n_The report was cut at about ${limit} characters. The full report is in the [run log](${runUrl})._\n`;
  let cut = text.slice(0, Math.max(0, limit - tail.length));
  const nl = cut.lastIndexOf("\n");
  if (nl > 0) cut = cut.slice(0, nl);
  return cut + tail;
}

export function buildReport({ records, event, dryRun = false, runUrl, sha = "", date }) {
  const findings = records.filter((r) => r.kind === "finding");
  const broken = records.filter((r) => r.kind === "broken");
  const notes = records.filter((r) => r.kind === "note");
  const decision = decide({ event, dryRun, records });
  const digest = findingsDigest(records);
  const head = [digestLine(digest), "", `## ${ISSUE_TITLE}`, "", `Latest run with findings: ${escapeText(date)}, [run log](${runUrl})${sha ? `, commit ${code(sha.slice(0, 8))}` : ""}.`, ""];
  const bodyLines = [...head];
  if (broken.length) bodyLines.push(`### Checks that could not run (${broken.length})`, "", ...grouped(broken));
  if (findings.length) bodyLines.push(`### Findings (${findings.length})`, "", ...grouped(findings));
  if (!broken.length && !findings.length) bodyLines.push("No findings.", "");
  bodyLines.push("This body is replaced on every run that has findings. A comment is added only when the set of findings changes.", "");
  const body = truncate(bodyLines.join("\n"), runUrl);
  const commentText = [`${escapeText(date)}: ${findings.length} finding(s)${broken.length ? `, ${broken.length} check(s) could not run` : ""}. [Run log](${runUrl})`, "",
    ...[...broken, ...findings].map(line), ""].join("\n");
  const comment = truncate(commentText, runUrl);
  // The decision comes first; on a pull request or dry run it reads "would
  // update the issue" and the body that would be written follows.
  const summary = [`**Issue:** ${escapeText(decision.reason)}`, "", body,
    ...(notes.length ? [`### Notes for this run only (${notes.length})`, "", ...grouped(notes)] : []), ""].join("\n");
  return { body, comment, summary, digest, write: decision.write, broken: broken.length > 0, decision };
}

// ---- command line ----
function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) { o[k] = argv[i + 1]; i++; } else o[k] = true;
  }
  return o;
}
const readOr = (f, fallback = "") => (f && existsSync(f) ? readFileSync(f, "utf8") : fallback);
function readJson(f) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } }
const num = (v) => (v === undefined || v === true || !/^-?\d+$/.test(String(v)) ? NaN : Number(v));

function main(argv) {
  const [cmd, kind] = argv;
  const o = args(argv.slice(1));
  if (!o.findings && cmd !== "should-comment") { console.error("[sentinel-report] --findings <file> is required"); return 2; }
  if (cmd === "add") {
    let records;
    if (kind === "vendor") records = vendorRecords(readOr(o.log), num(o.exit));
    else if (kind === "npm") records = npmRecords(readOr(o.log), num(o.exit));
    else if (kind === "links") records = linkRecords(readJson(o.log), num(o.exit));
    else if (kind === "due") records = dueRecords(readJson(o.log), num(o.exit));
    else if (kind === "browser") {
      records = browserRecords({ channel: String(o.channel || ""), version: typeof o.version === "string" ? o.version : "", installFailed: o["install-failed"] === true,
        pagesLog: readOr(o["pages-log"]), pagesExit: o["pages-exit"] === undefined ? 0 : num(o["pages-exit"]), smokeExit: o["smoke-exit"] === undefined ? 0 : num(o["smoke-exit"]) });
    } else if (kind === "note") records = [rec(String(o.check || "sentinel"), "note", String(o.subject || o.check || "sentinel"), String(o.message || ""))];
    else if (kind === "broken") records = [rec(String(o.check || "sentinel"), "broken", String(o.check || "sentinel"), String(o.message || "could not run"))];
    else { console.error(`[sentinel-report] unknown kind ${kind}`); return 2; }
    for (const r of records) appendFileSync(o.findings, JSON.stringify(r) + "\n");
    console.log(`[sentinel-report] ${kind}: ${records.filter((r) => r.kind === "finding").length} finding(s), ${records.filter((r) => r.kind === "broken").length} broken, ${records.filter((r) => r.kind === "note").length} note(s)`);
    return 0;
  }
  if (cmd === "should-comment") {
    // Prints true or false: --previous is the issue body now on GitHub (missing or empty means no issue yet).
    const previous = o.previous && existsSync(o.previous) ? readFileSync(o.previous, "utf8") : null;
    console.log(String(shouldComment({ previousBody: previous, body: readOr(o.body) })));
    return 0;
  }
  if (cmd === "report") {
    // No findings file means the checks never wrote anything: that is a broken sentinel, not a clean week.
    const records = existsSync(o.findings) ? parseRecords(readFileSync(o.findings, "utf8"))
      : [rec("sentinel", "broken", "findings.jsonl", "the findings file is missing, so no check recorded a result")];
    const r = buildReport({ records, event: String(o.event || ""), dryRun: o["dry-run"] === "true" || o["dry-run"] === true,
      runUrl: String(o["run-url"] || ""), sha: String(o.sha || ""), date: String(o.date || "") });
    if (o.summary) appendFileSync(o.summary, r.summary + "\n");
    if (o.body) writeFileSync(o.body, r.body);
    if (o.comment) writeFileSync(o.comment, r.comment);
    if (o.output) appendFileSync(o.output, `write=${r.write}\nbroken=${r.broken}\n`);
    console.log(`[sentinel-report] ${r.decision.reason}${r.broken ? "; a check could not run" : ""}`);
    return 0;
  }
  console.error("[sentinel-report] usage: add <kind> ... | report ... (see the header of this file)");
  return 2;
}

// True when this file is the entry point, also when it was started through a
// symlink (argv[1] is the link; import.meta.url is the resolved file).
function isMainModule() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isMainModule()) process.exitCode = main(process.argv.slice(2));
