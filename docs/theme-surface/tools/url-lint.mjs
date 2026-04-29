#!/usr/bin/env node
// url-lint — verify all hardcoded github.com / *.github.io URLs in the repo
// agree on a single GitHub username. Catches the username-rename drift class
// (e.g. README references oumu/ while privacy.md references pine2D/).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");

function walk(dir, results = []) {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f === ".git" || f === "release" || f === "vendor") continue;
    const full = join(dir, f);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, results);
    else if (/\.(md|json|js|mjs|html|yml|yaml|sh|css)$/i.test(f)) results.push(full);
  }
  return results;
}

const files = walk(ROOT);
const userRe = /github\.com\/([A-Za-z0-9-]+)\/Pinboard-Bookmark-Enhanced/g;
const pagesRe = /([A-Za-z0-9-]+)\.github\.io\/Pinboard-Bookmark-Enhanced/gi;
const usernames = new Map();

for (const f of files) {
  const text = readFileSync(f, "utf8");
  let m;
  while ((m = userRe.exec(text)) !== null) {
    const u = m[1];
    if (!usernames.has(u)) usernames.set(u, []);
    usernames.get(u).push(f.replace(ROOT + "/", ""));
  }
  while ((m = pagesRe.exec(text)) !== null) {
    const u = m[1].toLowerCase();
    const key = u + " (Pages)";
    if (!usernames.has(key)) usernames.set(key, []);
    usernames.get(key).push(f.replace(ROOT + "/", ""));
  }
}

const githubUsers = [...usernames.keys()].filter(k => !k.endsWith(" (Pages)"));
const pagesUsers = [...usernames.keys()].filter(k => k.endsWith(" (Pages)"));

console.log("=== url-lint: hardcoded GitHub references ===");
for (const [u, fs] of usernames) {
  console.log(`  ${u.padEnd(28)} → ${[...new Set(fs)].length} file(s)`);
}

const fail = githubUsers.length > 1 || pagesUsers.length > 1;
if (fail) {
  console.log(`\n=== url-lint: FAIL — multiple usernames detected ===`);
  console.log(`Mixed github.com/<user>/: ${githubUsers.join(", ")}`);
  if (pagesUsers.length > 1) console.log(`Mixed *.github.io/: ${pagesUsers.join(", ")}`);
  process.exit(1);
} else {
  console.log("\n=== url-lint: PASS — all references agree ===");
  process.exit(0);
}
