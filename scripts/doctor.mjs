#!/usr/bin/env node
// doctor: a read-only check of this clone's local setup. It changes nothing.
// Each check prints ok / warn (or skip / info) and one plain line; a warn also
// prints the command that fixes it.
//
//   node scripts/doctor.mjs            human-readable, exit 0
//   node scripts/doctor.mjs --json     one JSON object on stdout
//   node scripts/doctor.mjs --offline  skip the one network check (remote tags)
//   node scripts/doctor.mjs --strict   exit 1 when any check warns
//   node scripts/doctor.mjs --help
//
// It never reads .env and never prints environment values.
// PBP_DOCTOR_FILE_LIMIT and PBP_LINT_TODAY override the file-count limit and
// today's date (tests only).
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dueItems } from "./registers-lint.mjs";

const HELP = `Usage: node scripts/doctor.mjs [--json] [--offline] [--strict]

Read-only check of the local setup: git hooks, .qa-scan dependencies and the
bundled Chromium, repo file count, stray files in .qa-scan/, local release
tags against origin, register items due within 14 days, baseline sizes.

  --json     print one JSON object instead of lines
  --offline  skip the remote tag check (the only network access)
  --strict   exit 1 when a check warns (skip and info never fail)
  --help     this text`;

// CLAUDE.md: keep the repo at about 20,000 files; Chrome loads it as an extension.
const FILE_LIMIT_DEFAULT = 20000;
const DUE_WITHIN = 14;
const HOOKS = [["pre-commit", "pre-commit-hook.sh"], ["commit-msg", "commit-msg-hook.sh"]];
// .qa-scan/ holds tool dependencies and the promo video project (CLAUDE.md);
// anything else untracked there belongs in $PBP_QA_REPORT_DIR.
const QA_KEEP = new Set(["node_modules", "promo-video"]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// git without anything the caller exported (a hook hands down GIT_DIR and
// GIT_INDEX_FILE; with those, git would answer for another repo).
function gitEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
}
function git(args, opts = {}) {
  const r = spawnSync("git", args, { cwd: ROOT, env: gitEnv(), encoding: "utf8", timeout: opts.timeout || 30000 });
  return { ok: r.status === 0 && !r.error, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() || (r.error ? r.error.message : "") };
}

const ok = (id, line) => ({ id, status: "ok", line });
const warn = (id, line, fix) => ({ id, status: "warn", line, fix });
const skip = (id, line) => ({ id, status: "skip", line });
const info = (id, line, data) => ({ id, status: "info", line, data });

function checkHooks() {
  const where = git(["rev-parse", "--git-path", "hooks"]);
  if (!where.ok) return warn("hooks", "git could not say where the hooks live", "git rev-parse --git-path hooks");
  // --git-path resolves to the common dir from a linked worktree, and honours core.hooksPath.
  const dir = resolve(ROOT, where.out);
  const bad = [];
  for (const [hook, script] of HOOKS) {
    const file = join(dir, hook);
    if (!existsSync(file)) { bad.push(`${hook} is not installed`); continue; }
    try { accessSync(file, constants.X_OK); } catch { bad.push(`${hook} is not executable`); continue; }
    if (!readFileSync(file, "utf8").includes(`exec "$REPO_ROOT/scripts/${script}"`)) bad.push(`${hook} does not delegate to scripts/${script}`);
  }
  if (bad.length) return warn("hooks", `git hooks: ${bad.join("; ")}`, "sh scripts/setup-hooks.sh");
  return ok("hooks", "git hooks delegate to the tracked scripts");
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function checkQaDeps() {
  const pkg = readJson(join(ROOT, ".qa-scan/package.json"));
  const want = pkg && pkg.dependencies && pkg.dependencies.playwright;
  if (!want) return warn("qa-deps", ".qa-scan/package.json names no playwright version", "git checkout -- .qa-scan/package.json");
  if (!existsSync(join(ROOT, ".qa-scan/node_modules"))) return warn("qa-deps", ".qa-scan/node_modules is missing", "npm ci --prefix .qa-scan");
  const got = readJson(join(ROOT, ".qa-scan/node_modules/playwright/package.json"));
  if (!got) return warn("qa-deps", "playwright is not installed in .qa-scan/node_modules", "npm ci --prefix .qa-scan");
  if (got.version !== want) return warn("qa-deps", `installed playwright ${got.version}, .qa-scan/package.json wants ${want}`, "npm ci --prefix .qa-scan");
  return ok("qa-deps", `.qa-scan dependencies installed, playwright ${got.version}`);
}

function checkChromium() {
  let path;
  try {
    const req = createRequire(join(ROOT, ".qa-scan/package.json"));
    path = req("playwright").chromium.executablePath();
  } catch {
    return warn("chromium", "playwright cannot be loaded, so its Chromium cannot be found", "npm ci --prefix .qa-scan");
  }
  if (!path || !existsSync(path)) return warn("chromium", "the Chromium build for this Playwright is not installed", "npx --prefix .qa-scan playwright install chromium");
  return ok("chromium", "the Chromium build for this Playwright is installed");
}

function countFiles(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (d === dir && e.name === ".git") continue;
      if (e.isDirectory()) stack.push(join(d, e.name));
      else if (e.isFile()) n++;
    }
  }
  return n;
}

function checkFileCount() {
  const raw = process.env.PBP_DOCTOR_FILE_LIMIT;
  const limit = raw && /^\d+$/.test(raw) ? Number(raw) : FILE_LIMIT_DEFAULT;
  const n = countFiles(ROOT);
  if (n > limit) {
    return warn("file-count", `${n} files in the repo, over the ${limit} limit; Chrome slows down loading it`,
      "find . -path ./.git -prune -o -type f -print | cut -d/ -f2 | sort | uniq -c | sort -rn | head   # then move reports to \"$PBP_QA_REPORT_DIR\"");
  }
  return ok("file-count", `${n} files in the repo (limit ${limit})`);
}

function checkQaStray() {
  if (!existsSync(join(ROOT, ".qa-scan"))) return skip("qa-stray", ".qa-scan/ does not exist");
  // Untracked entries at the top of .qa-scan/, ignored or not, as git sees them;
  // only the tool dependencies and the promo video project belong there.
  const plain = git(["ls-files", "--others", "--directory", "--exclude-standard", "--", ".qa-scan"]);
  const ignored = git(["ls-files", "--others", "--directory", "--ignored", "--exclude-standard", "--", ".qa-scan"]);
  if (!plain.ok || !ignored.ok) return warn("qa-stray", "git ls-files failed, so stray files were not checked", "git ls-files --others -- .qa-scan");
  const top = new Set(`${plain.out}\n${ignored.out}`.split("\n").filter(Boolean).map((f) => f.split("/")[1]).filter(Boolean));
  const stray = [...top].filter((name) => !QA_KEEP.has(name)).sort();
  if (!stray.length) return ok("qa-stray", "nothing untracked in .qa-scan/ besides node_modules and promo-video");
  const shown = stray.slice(0, 5).join(", ") + (stray.length > 5 ? ", ..." : "");
  return warn("qa-stray", `${stray.length} untracked entr${stray.length === 1 ? "y" : "ies"} in .qa-scan/: ${shown}`, "move logs, screenshots and reports to \"$PBP_QA_REPORT_DIR\" (default ~/.local/share/pbp-qa-report); keep only node_modules and promo-video there");
}

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
function checkTags(offline) {
  if (offline) return skip("tags", "remote tags not checked (--offline)");
  const remote = git(["remote", "get-url", "origin"]);
  if (!remote.ok) return skip("tags", "no origin remote, so remote tags were not checked");
  const local = git(["tag", "-l"]);
  if (!local.ok) return warn("tags", "could not list local tags", "git tag -l");
  const ls = git(["ls-remote", "--tags", "origin"], { timeout: 20000 });
  if (!ls.ok) return warn("tags", "could not read the tags on origin (failed, not checked); is the network up?", "git ls-remote --tags origin");
  const have = new Set(local.out.split("\n").filter(Boolean));
  const theirs = new Set(ls.out.split("\n").map((l) => l.split("\t")[1] || "").filter((r) => r.startsWith("refs/tags/"))
    .map((r) => r.slice("refs/tags/".length).replace(/\^\{\}$/, "")).filter((t) => RELEASE_TAG.test(t)));
  const missing = [...theirs].filter((t) => !have.has(t)).sort();
  if (missing.length) return warn("tags", `${missing.length} release tag(s) on origin are missing here: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`, "git fetch --tags origin");
  return ok("tags", `all ${theirs.size} release tags on origin are here`);
}

function localToday() {
  const n = new Date();
  return [n.getFullYear(), String(n.getMonth() + 1).padStart(2, "0"), String(n.getDate()).padStart(2, "0")].join("-");
}
function checkDue() {
  const today = process.env.PBP_LINT_TODAY || localToday();
  let r;
  try { r = dueItems({ dir: join(ROOT, ".claude"), root: ROOT, today, within: DUE_WITHIN }); }
  catch (e) { return warn("due", `could not read the registers (${e.message})`, "node scripts/registers-lint.mjs"); }
  if (r.problems.length) return warn("due", `${r.problems.length} register problem(s), for example: ${r.problems[0]}`, "node scripts/registers-lint.mjs");
  if (!r.items.length) return ok("due", `nothing due within ${DUE_WITHIN} days in the registers`);
  const overdue = r.items.filter((i) => i.daysLeft < 0).length;
  return warn("due", `${r.items.length} register item(s) due within ${DUE_WITHIN} days (${overdue} overdue), first: ${r.items[0].where} on ${r.items[0].due}`,
    `node scripts/registers-lint.mjs --due-within ${DUE_WITHIN}`);
}

function checkBaselines() {
  const data = {};
  const slice = readJson(join(ROOT, "scripts/slice-anchor-baseline.json"));
  data.sliceAnchors = slice && typeof slice.total === "number" ? slice.total : null;
  const sup = readJson(join(ROOT, "scripts/eslint-suppressions.json"));
  if (sup) {
    let all = 0, silent = 0;
    for (const rules of Object.values(sup)) for (const [rule, v] of Object.entries(rules)) {
      all += v.count || 0;
      if (rule === "pbp/no-silent-catch") silent += v.count || 0;
    }
    data.eslintSuppressions = all;
    data.silentCatches = silent;
  } else { data.eslintSuppressions = null; data.silentCatches = null; }
  const vocab = readJson(join(ROOT, "scripts/ui-vocabulary-baseline.json"));
  data.uiVocabularyEntries = vocab && Array.isArray(vocab.entries) ? vocab.entries.length : null;
  const known = readJson(join(ROOT, "tests/render-audit-known-failures.json"));
  data.renderKnownFailures = known === null ? null : Array.isArray(known) ? known.length : Object.keys(known).length;
  const show = (v) => (v === null ? "unreadable" : String(v));
  return info("baselines", `baselines: slice anchors ${show(data.sliceAnchors)}, eslint suppressions ${show(data.eslintSuppressions)} (silent catches ${show(data.silentCatches)}), ui-vocabulary entries ${show(data.uiVocabularyEntries)}, render known failures ${show(data.renderKnownFailures)}`, data);
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return 0; }
  const known = new Set(["--json", "--offline", "--strict"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length) { console.error(`[doctor] unknown argument: ${unknown.join(" ")}\n\n${HELP}`); return 2; }
  const offline = argv.includes("--offline");
  const checks = [checkHooks, checkQaDeps, checkChromium, checkFileCount, checkQaStray, () => checkTags(offline), checkDue, checkBaselines].map((f) => {
    try { return f(); } catch (e) { return warn("doctor", `a check crashed: ${e.message}`, "node scripts/doctor.mjs"); }
  });
  const warns = checks.filter((c) => c.status === "warn").length;
  if (argv.includes("--json")) console.log(JSON.stringify({ checks, warnings: warns }, null, 2));
  else {
    for (const c of checks) {
      console.log(`${c.status.padEnd(4)}  ${c.line}`);
      if (c.fix) console.log(`      fix: ${c.fix}`);
    }
    console.log(warns ? `[doctor] ${warns} warning(s)` : "[doctor] all checks ok");
  }
  return argv.includes("--strict") && warns ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
