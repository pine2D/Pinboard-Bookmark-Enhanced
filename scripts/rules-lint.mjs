#!/usr/bin/env node
// Lint for the rule files nobody else watches: CLAUDE.md, AGENTS.md,
// .claude/rules/*.md, .claude/skills/*/SKILL.md, .claude/expiring-items.md.
//
//   A. The index table at the end of CLAUDE.md matches the rule files: every
//      .claude/ file it names exists, every rule file is listed, the files a
//      row names are matched by that rule's frontmatter `paths:`, and every
//      `paths:` glob matches at least one tracked file.
//   B. Backticked references exist: paths, `--flags`, and identifiers.
//   C. Number claims in the docs (locales, themes, test pages, AI providers)
//      equal the real count, taken from the file list or an espree AST.
//
// Exceptions live in scripts/rules-lint-allow.json ({file, token, reason});
// an entry that excuses nothing is itself an error.
//
// lintRules(root, opts) is pure over the files under `root`. The CLI takes
// `--root <dir>` (or PBP_RULES_LINT_ROOT) so tests never touch the real repo.
//
//   node scripts/rules-lint.mjs [--root <dir>] [--allow <file>]
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_HEADING = "规则与技能索引";
const PATH_EXTS = new Set(["js", "mjs", "cjs", "json", "html", "css", "md", "sh", "py", "yml", "yaml", "txt", "png", "svg", "jpg", "mp4", "zip", "conf", "csv", "tsv", "woff2", "ttf", "toml"]);
const CODE_EXTS = new Set(["js", "mjs", "cjs", "json", "html", "css", "sh", "py", "yml", "yaml", "txt", "conf", "ts"]);
const FLAG_DIRS = ["scripts/", "tests/", "docs/theme-surface/tools/"];

// ---- file lists ----
export function listFiles(root) {
  // A git hook exports GIT_DIR / GIT_INDEX_FILE for the outer repo; drop them
  // so `root` is always judged on its own (a fixture folder is not the outer repo).
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete env[k];
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0 && r.stdout) {
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, env, encoding: "utf8" });
    if (top.status === 0 && resolve(top.stdout.trim()) === resolve(root)) return r.stdout.split("\0").filter(Boolean);
  }
  const out = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), p);
      else out.push(p);
    }
  };
  walk(root, "");
  return out;
}

// ---- globs ----
export function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i++; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const hasGlob = (s) => /[*?]/.test(s);

// ---- markdown helpers ----
function splitCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
// Inline code spans, skipping fenced blocks. [{ line, text }]
function codeSpans(text) {
  const spans = [];
  let fenced = false;
  text.split("\n").forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; return; }
    if (fenced) return;
    for (const m of l.matchAll(/`([^`\n]+)`/g)) spans.push({ line: i + 1, text: m[1].trim() });
  });
  return spans;
}
function parseFrontmatterPaths(text) {
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return null;
  const paths = [];
  let inPaths = false;
  for (const l of lines.slice(1, end)) {
    if (/^paths:\s*$/.test(l)) { inPaths = true; continue; }
    if (inPaths) {
      const m = /^\s+-\s+["']?(.*?)["']?\s*$/.exec(l);
      if (m) paths.push(m[1]);
      else if (/^\S/.test(l)) inPaths = false;
    }
  }
  return paths;
}
function parseIndex(text) {
  const lines = text.split("\n");
  const h = lines.findIndex((l) => /^##\s/.test(l) && l.includes(INDEX_HEADING));
  if (h < 0) return null;
  const rows = [];
  for (let i = h + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s/.test(l)) break;
    if (!l.trim().startsWith("|")) continue;
    const cells = splitCells(l);
    if (cells.length < 2 || /^[-:\s]+$/.test(cells[0])) continue;
    if (cells[1] === "必读") continue;
    const refs = [...cells[cells.length - 1].matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((p) => p.startsWith(".claude/"));
    rows.push({ line: i + 1, first: cells[0], refs });
  }
  return rows;
}

// Names a row's first column points at: file names with an extension, or globs.
function namedTokens(first) {
  const s = first.replace(/[（(][^）)]*[）)]/g, " ");
  const out = [];
  for (const m of s.matchAll(/[A-Za-z0-9_.*\/-]+/g)) {
    const t = m[0].replace(/\.+$/, "").replace(/^\/+|\/+$/g, "");
    if (!/[A-Za-z0-9*]/.test(t)) continue;
    const ext = /\.([a-z0-9]+)$/.exec(t);
    if (hasGlob(t) || (ext && PATH_EXTS.has(ext[1]))) out.push(t);
  }
  return out;
}

// ---- number claims ----
function loadEspree() {
  const req = createRequire(join(SELF_ROOT, ".qa-scan", "package.json"));
  return req("espree");
}
// Property names of a top-level `const NAME = { ... }` object literal, from the AST.
export function objectKeysFromSource(source, name) {
  const ast = loadEspree().parse(source, { ecmaVersion: "latest", sourceType: "script" });
  for (const node of ast.body) {
    if (node.type !== "VariableDeclaration") continue;
    for (const d of node.declarations) {
      if (d.id.type === "Identifier" && d.id.name === name && d.init && d.init.type === "ObjectExpression") {
        return d.init.properties
          .filter((p) => p.type === "Property" && !p.computed)
          .map((p) => (p.key.type === "Identifier" ? p.key.name : String(p.key.value)));
      }
    }
  }
  throw new Error(`没有在源码里找到顶层 const ${name} = {...}`);
}
const readText = (root, rel) => readFileSync(join(root, rel), "utf8");

// Each claim: where the number is written (file + a pattern with one capture
// group, only used to locate it) and where the real value comes from.
// mode "exact": equal; mode "min": the doc says "N+", real value must be >= N.
export const CLAIMS = [
  { label: "locale 数", file: "CLAUDE.md", re: /_locales\/（(\d+) locale）/g, mode: "exact",
    actual: (ctx) => new Set(ctx.files.filter((f) => /^_locales\/[^/]+\//.test(f)).map((f) => f.split("/")[1])).size },
  { label: "locale 数", file: "CLAUDE.md", re: /×(\d+) locale/g, mode: "exact",
    actual: (ctx) => new Set(ctx.files.filter((f) => /^_locales\/[^/]+\//.test(f)).map((f) => f.split("/")[1])).size },
  { label: "README 数", file: "CLAUDE.md", re: /README\*\.md ×(\d+)/g, mode: "exact",
    actual: (ctx) => ctx.files.filter((f) => /^README(\.[^/]+)?\.md$/.test(f)).length },
  { label: "测试页数", file: "CLAUDE.md", re: /HTML 测试页 (\d+)\+ 套/g, mode: "min",
    actual: (ctx) => ctx.files.filter((f) => /^tests\/[^/]*-tests\.html$/.test(f)).length },
  { label: "站点主题数", file: "CLAUDE.md", re: /(\d+) 套站点主题/g, mode: "exact",
    actual: (ctx) => ctx.files.filter((f) => /^docs\/theme-surface\/pilots\/[^/]+\.tokens\.json$/.test(f)).length },
  { label: "站点主题数", file: ".claude/rules/theme-factory.md", re: /(\d+) 套 preset/g, mode: "exact",
    actual: (ctx) => ctx.files.filter((f) => /^docs\/theme-surface\/pilots\/[^/]+\.tokens\.json$/.test(f)).length },
  { label: "AI 服务商数", file: "PRODUCT.md", re: /AI providers \((\d+)[,)]/g, mode: "exact",
    // ids in OPENAI_COMPAT_PROVIDERS + _AI_BESPOKE_PROVIDERS, minus "custom" (user-added endpoints)
    actual: (ctx) => {
      const src = readText(ctx.root, "ai.js");
      const ids = new Set([...objectKeysFromSource(src, "OPENAI_COMPAT_PROVIDERS"), ...objectKeysFromSource(src, "_AI_BESPOKE_PROVIDERS")]);
      ids.delete("custom");
      return ids.size;
    } },
];

// ---- main ----
export function lintRules(root, { files = listFiles(root), allow = [], claims = CLAIMS } = {}) {
  const errors = [];
  const notes = [];
  const fileSet = new Set(files);
  // The lint, its exceptions and its tests quote names on purpose; they never count as evidence.
  const SELF_FILES = new Set(["scripts/rules-lint.mjs", "scripts/rules-lint-allow.json", "tests/rules-lint-tests.mjs"]);
  const evidence = files.filter((f) => !SELF_FILES.has(f));
  const tracked = (p) => fileSet.has(p);
  const isDir = (p) => files.some((f) => f.startsWith(`${p}/`));

  // allow-list bookkeeping
  const used = new Set();
  const allowKey = (file, token) => `${file}\u0000${token}`;
  const allowMap = new Map(allow.map((a, i) => [allowKey(a.file, a.token), i]));
  const excused = (file, token) => {
    const i = allowMap.get(allowKey(file, token));
    if (i === undefined) return false;
    used.add(i);
    return true;
  };
  for (const [i, a] of allow.entries()) {
    if (!a || !a.file || !a.token || !a.reason) errors.push(`rules-lint-allow.json 第 ${i + 1} 条缺 file、token 或 reason`);
  }

  // ---------- A ----------
  const claudeMd = tracked("CLAUDE.md") ? readText(root, "CLAUDE.md") : null;
  const indexRows = claudeMd === null ? null : parseIndex(claudeMd);
  const ruleFiles = files.filter((f) => /^\.claude\/rules\/[^/]+\.md$/.test(f));
  const frontPaths = new Map(); // rule file -> globs
  for (const rf of ruleFiles) {
    const p = parseFrontmatterPaths(readText(root, rf));
    if (p === null || p.length === 0) errors.push(`${rf}: 没有 frontmatter paths:`);
    else frontPaths.set(rf, p);
  }
  if (indexRows === null) {
    errors.push(`CLAUDE.md: 找不到「${INDEX_HEADING}」索引表`);
  } else {
    const listed = new Set();
    for (const row of indexRows) {
      for (const ref of row.refs) {
        listed.add(ref);
        if (!tracked(ref)) errors.push(`CLAUDE.md:${row.line}: 索引引用的 ${ref} 不存在`);
      }
      const ruleRefs = row.refs.filter((r) => /^\.claude\/rules\/[^/]+\.md$/.test(r) && frontPaths.has(r));
      for (const rr of ruleRefs) {
        const regs = frontPaths.get(rr).map(globToRegex);
        const covered = (f) => regs.some((re) => re.test(f));
        for (const tok of namedTokens(row.first)) {
          let matches;
          if (tracked(tok)) matches = [tok];
          else if (hasGlob(tok)) matches = files.filter((f) => globToRegex(tok).test(f));
          else {
            const same = files.filter((f) => basename(f) === tok);
            matches = same.length === 1 ? same : [];
          }
          for (const m of matches) {
            if (!covered(m) && !excused(rr, `索引点名:${m}`)) {
              errors.push(`CLAUDE.md:${row.line}: 索引说「${tok}」归 ${rr} 管，但 ${m} 不在它的 paths: 里（补 paths:，或把索引改成实际覆盖的文件）`);
            }
          }
        }
      }
    }
    for (const rf of ruleFiles) {
      if (!listed.has(rf)) errors.push(`${rf}: 不在 CLAUDE.md 的索引表里`);
    }
  }
  for (const [rf, globs] of frontPaths) {
    for (const g of globs) {
      const re = globToRegex(g);
      if (!files.some((f) => re.test(f)) && !excused(rf, g)) errors.push(`${rf}: paths: 里的 "${g}" 没有匹配任何已跟踪文件`);
    }
  }

  // ---------- B ----------
  const scope = files.filter((f) =>
    f === "CLAUDE.md" || f === "AGENTS.md" || f === ".claude/expiring-items.md" ||
    /^\.claude\/rules\/[^/]+\.md$/.test(f) || /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(f));
  const flagFiles = evidence.filter((f) => FLAG_DIRS.some((d) => f.startsWith(d)) || f === ".qa-scan/run-test.mjs");
  let flagCorpus = null;
  let codeCorpus = null;
  const codeFiles = () => evidence.filter((f) => CODE_EXTS.has((/\.([a-z0-9]+)$/.exec(f) || [])[1]));
  const readSafe = (f) => { try { return readText(root, f); } catch { return ""; } };
  const flagText = () => (flagCorpus ??= flagFiles.map(readSafe).join("\n"));
  const codeText = () => (codeCorpus ??= codeFiles().map(readSafe).join("\n"));
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // A reference resolves against the repo root, the doc's own folder, then
  // docs/theme-surface/ (the theme docs write paths relative to it). A bare
  // file name (no slash, no wildcard) also resolves if any tracked file has it.
  const pathExists = (p, fromDir) => {
    for (const base of ["", fromDir, "docs/theme-surface/"]) {
      const q = base + p;
      if (hasGlob(p)) {
        const re = globToRegex(q.replace(/\/$/, ""));
        if (files.some((f) => re.test(f))) return true;
      } else if (tracked(q.replace(/\/$/, "")) || isDir(q.replace(/\/$/, ""))) return true;
    }
    return !p.includes("/") && !hasGlob(p) && files.some((f) => basename(f) === p);
  };
  let styleCorpus = null;
  const styleText = () => (styleCorpus ??= evidence.filter((f) => /\.(css|html)$/.test(f)).map(readSafe).join("\n"));

  for (const file of scope) {
    const lines = readText(root, file).split("\n");
    const skipLine = new Set();
    if (file === ".claude/expiring-items.md") {
      lines.forEach((l, i) => { if (/（[^）]*已于 \d{4}-\d{2}-\d{2} 退役[^）]*）/.test(l)) skipLine.add(i + 1); });
    }
    const seen = new Set();
    for (const span of codeSpans(lines.join("\n"))) {
      if (skipLine.has(span.line)) continue;
      const words = /\s/.test(span.text) ? span.text.split(/\s+/) : [span.text];
      const multi = words.length > 1;
      for (let w of words) {
        w = w.replace(/^\.\//, "").replace(/[,;。，]+$/, "").replace(/\(\)$/, "");
        const lineNo = /:\d+(-\d+)?$/.test(w) ? ":" : "";
        if (lineNo) w = w.replace(/:\d+(-\d+)?$/, "");
        if (!w || /^(https?:|~|\/|\$|<|-[^-])/.test(w)) continue;
        const key = `${w}`;
        if (seen.has(key)) continue;
        const report = (msg) => {
          seen.add(key);
          if (!excused(file, w)) errors.push(`${file}:${span.line}: ${msg}`);
        };
        // flag
        const fm = /^(--[A-Za-z][\w-]*)(=.*)?$/.exec(w);
        if (fm) {
          const flagRe = new RegExp(`${escapeRe(fm[1])}(?![\\w-])`);
          // a CSS custom property (--name) is fine if a stylesheet or page defines it
          if (!flagRe.test(flagText()) && !flagRe.test(styleText())) report(`开关 \`${fm[1]}\` 在 scripts/、tests/、docs/theme-surface/tools/、.qa-scan/run-test.mjs 里都找不到`);
          continue;
        }
        // path
        const ext = /\.([A-Za-z0-9]+)$/.exec(w);
        // A wildcard with no slash and no extension (pbp-*, field-*) names a family, not a path.
        const nameFamily = hasGlob(w) && !w.includes("/") && !ext;
        const pathLike = !nameFamily && /^[A-Za-z0-9_@.*+\/][\w@.*+\/-]*$/.test(w) && /[A-Za-z0-9]/.test(w) && (hasGlob(w) || w.endsWith("/") || (ext && PATH_EXTS.has(ext[1].toLowerCase())));
        if (nameFamily) continue;
        if (pathLike) {
          if (!pathExists(w, `${dirname(file) === "." ? "" : dirname(file) + "/"}`)) report(`引用的路径 \`${w}\` 在仓库里找不到`);
          continue;
        }
        // identifier (single-token spans only)
        if (!multi && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w) && w.length >= 4 && /[A-Z_]/.test(w)) {
          if (!new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(w)}(?![A-Za-z0-9_$])`).test(codeText())) report(`标识符 \`${w}\` 在任何已跟踪的代码文件里都找不到`);
        }
      }
    }
  }

  // ---------- C ----------
  const ctx = { root, files };
  for (const c of claims) {
    if (!tracked(c.file)) { errors.push(`${c.file}: 数字声明「${c.label}」所在的文件不存在`); continue; }
    const text = readText(root, c.file);
    const found = [...text.matchAll(new RegExp(c.re.source, c.re.flags.includes("g") ? c.re.flags : c.re.flags + "g"))];
    if (found.length === 0) { errors.push(`${c.file}: 找不到数字声明「${c.label}」（${c.re}），文档改了写法的话同步改 lint 的声明表`); continue; }
    let actual;
    try { actual = c.actual(ctx); } catch (e) { errors.push(`${c.file}: 算「${c.label}」的实际值失败：${e.message}`); continue; }
    for (const m of found) {
      const said = Number(m[1]);
      const line = text.slice(0, m.index).split("\n").length;
      if (c.mode === "min" ? actual < said : actual !== said) {
        errors.push(`${c.file}:${line}: 「${c.label}」文档写 ${said}${c.mode === "min" ? "+" : ""}，实际是 ${actual}`);
      }
    }
  }

  // unused allow-list entries
  allow.forEach((a, i) => {
    if (a && a.file && a.token && a.reason && !used.has(i)) errors.push(`rules-lint-allow.json: 条目 ${a.file} / ${a.token} 用不上，删掉它`);
  });

  // note: root runtime files no rule covers
  const allRegs = [...frontPaths.values()].flat().map(globToRegex);
  const uncovered = files.filter((f) => !f.includes("/") && /\.(js|html|css)$/.test(f) && !allRegs.some((re) => re.test(f)));
  if (uncovered.length) notes.push(`NOTE ${uncovered.length} 个运行时文件没有任何规则覆盖: ${uncovered.join(" ")}`);

  return { errors, notes };
}

// ---- CLI ----
function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const root = resolve(opt("--root") || process.env.PBP_RULES_LINT_ROOT || SELF_ROOT);
  const allowPath = resolve(opt("--allow") || join(root, "scripts", "rules-lint-allow.json"));
  let allow = [];
  if (existsSync(allowPath) && statSync(allowPath).isFile()) {
    try { allow = JSON.parse(readFileSync(allowPath, "utf8")); } catch (e) { console.error(`rules-lint: 豁免清单不是合法 JSON：${e.message}`); process.exit(1); }
    if (!Array.isArray(allow)) { console.error("rules-lint: 豁免清单必须是数组"); process.exit(1); }
  }
  const { errors, notes } = lintRules(root, { allow });
  for (const n of notes) console.log(n);
  if (errors.length) {
    for (const e of errors) console.error(`ERROR ${e}`);
    console.error(`FAIL rules-lint: ${errors.length} 个问题`);
    process.exit(1);
  }
  console.log("PASS rules-lint");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
