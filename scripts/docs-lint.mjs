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

if (errors.length) {
  console.error(`[docs-lint] FAIL (${errors.length}):`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log(`[docs-lint] PASS - ${READMES.length} READMEs mirrored (${counts[0].bullets} bullets, ${counts[0].subs} subsections), delimiter policy + EN prose dash ban hold`);
