#!/usr/bin/env node
// docs-lint: mechanical guardrails for the user-facing docs (2026-07).
// The judgment work lives in the content-l10n / humanizer skills at writing
// time; this lint freezes their OUTPUT CONTRACTS so later edits can't drift:
//   1. README x9 structural mirror (feature bullets, subsections, links,
//      code spans, bold pairing, the "13" claims in tagline).
//   2. Feature-bullet delimiter policy: colon-family for en/CJK/de/fr;
//      pl/ru keep the spaced dash ON PURPOSE (myslnik / tire are native
//      punctuation there, not an AI artifact -- do not "unify" them).
//   3. English prose dash ban: README.md and docs/privacy.md carry no
//      spaced em dash (the loudest AI tell; per-locale files follow their
//      own conventions and are exempt).
//   4. CLAUDE.md temporary-item expiry: every item under the
//      "## 临时事项" heading that carries a 到期日 must still be in the
//      future. Prose plus a human memory was the only thing retiring
//      one-time migrations; this makes the date machine-checkable.
// Run standalone (node scripts/docs-lint.mjs) or via verify.sh / CI.
import { readFileSync } from "node:fs";

const READMES = [
  "README.md", "README.zh-CN.md", "README.zh-TW.md", "README.zh-HK.md",
  "README.ja.md", "README.de.md", "README.fr.md", "README.pl.md", "README.ru.md",
];
const DASH_DELIM_ALLOWED = new Set(["README.pl.md", "README.ru.md"]);
const EN_PROSE_DASH_BAN = ["README.md", "docs/privacy.md"];

const errors = [];
const blocks = {};

for (const f of READMES) {
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  const h2 = lines.reduce((a, l, i) => (l.startsWith("## ") && a.push(i), a), []);
  if (h2.length < 2) { errors.push(`${f}: fewer than two H2 sections`); continue; }
  const block = lines.slice(h2[0] + 1, h2[1]).join("\n");
  blocks[f] = {
    bullets: (block.match(/^- \*\*/gm) || []).length,
    subs: (block.match(/^### /gm) || []).length,
  };
  if (!block.includes("](https://obsidian.md)")) errors.push(`${f}: Obsidian link missing from features`);
  if (!block.includes("](https://web.archive.org)")) errors.push(`${f}: Wayback link missing from features`);
  for (const span of ["`.md`", "`.html`", "`.epub`"]) {
    if ((block.split(span).length - 1) !== 1) errors.push(`${f}: expected exactly one ${span} span`);
  }
  if ((block.split("**").length - 1) % 2 !== 0) errors.push(`${f}: unbalanced ** in features block`);
  if (!(lines[4] || "").includes("13")) errors.push(`${f}: tagline (line 5) lost the "13 themes" claim`);
  const dashDelims = (block.match(/\*\* — /g) || []).length;
  if (DASH_DELIM_ALLOWED.has(f)) {
    if (dashDelims === 0) errors.push(`${f}: pl/ru keep the native spaced-dash delimiter; found none (policy drift?)`);
  } else if (dashDelims > 0) {
    errors.push(`${f}: ${dashDelims} "** — " bullet delimiter(s); this locale uses the colon family`);
  }
}

const counts = Object.values(blocks);
if (counts.length === READMES.length) {
  const b0 = counts[0].bullets, s0 = counts[0].subs;
  if (b0 < 10) errors.push(`README.md: only ${b0} feature bullets (structure damaged?)`);
  for (const [f, c] of Object.entries(blocks)) {
    if (c.bullets !== b0) errors.push(`${f}: ${c.bullets} feature bullets vs ${b0} in README.md (x9 mirror broken)`);
    if (c.subs !== s0) errors.push(`${f}: ${c.subs} subsections vs ${s0} in README.md`);
  }
}

for (const f of EN_PROSE_DASH_BAN) {
  const text = readFileSync(f, "utf8");
  text.split("\n").forEach((l, i) => {
    if (l.includes(" — ") || l.includes(" – ")) errors.push(`${f}:${i + 1}: spaced dash in English prose: ${l.trim().slice(0, 60)}`);
  });
}

// ---- 4. CLAUDE.md temporary items: no 到期日 may be in the past ----
// One-time migrations/sweeps are registered under "## 临时事项" with a 到期日.
// Retired items are rewritten as a parenthetical history line with no 到期日
// ("（... 已于 2026-08-26 退役 ...）"), which is why the date has to be read
// off the 到期日 marker and not off any date in the line.
const TEMP_HEADING = "## 临时事项";
const claude = readFileSync("CLAUDE.md", "utf8").split("\n");
const tempStart = claude.findIndex((l) => l.startsWith(TEMP_HEADING));
if (tempStart === -1) {
  errors.push(`CLAUDE.md: "${TEMP_HEADING}" section is gone (expiry gate has nothing to check)`);
} else {
  const rest = claude.slice(tempStart + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const section = end === -1 ? rest : rest.slice(0, end);
  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  for (const [i, line] of section.entries()) {
    if (!line.includes("到期日")) continue;
    const lineNo = tempStart + 2 + i;
    const due = /到期日[：:\s]*(\d{4}-\d{2}-\d{2})/.exec(line);
    // Title: the bolded lead of the bullet, e.g. "- **`x` 可退役（到期日 ...）**：..."
    const title = (/^-\s+\*\*(.+?)\*\*/.exec(line) || [])[1] || line.trim().slice(0, 60);
    if (!due) {
      errors.push(`CLAUDE.md:${lineNo}: 临时事项 "${title}" says 到期日 but carries no YYYY-MM-DD date`);
    } else if (due[1] < today) {
      errors.push(`CLAUDE.md:${lineNo}: 临时事项 "${title}" 到期日 ${due[1]} 已过期（今天 ${today}），删它或改期`);
    }
  }
}

if (errors.length) {
  console.error(`[docs-lint] FAIL (${errors.length}):`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log(`[docs-lint] PASS - ${READMES.length} READMEs mirrored (${counts[0].bullets} bullets, ${counts[0].subs} subsections), delimiter policy + EN prose dash ban hold, CLAUDE.md 临时事项 到期日 all in the future`);
