#!/usr/bin/env node
// token-coverage - detect token references in composer code that don't
// resolve to a defined value in some theme's tokens.json (accounting for the
// fallback chain in _util.mjs#expandPalette and _base.mjs).
//
// Without this, a typo like v("text") or a missing definition silently emits
// `var(--pinboard-text)` and the browser falls back to CSS initial - invisible
// to drift-guard (which compares declaration strings, not their resolution)
// and to cascade-lint (which probes selectors, not custom-property resolution).
//
// Algorithm:
//   1. Scan all composers/*.mjs for v("token-name") and v('token-name')
//      call sites.
//   2. For each theme's tokens.json, invoke baseLayer(tokens) and extract the
//      `--pinboard-<name>` custom properties that resolve to a non-empty
//      value. This is the source-of-truth for what is available at runtime.
//   3. For each (theme x referenced-token) pair, verify the token is in the
//      theme's resolved set.
//   4. Exit 0 if all resolve, exit 1 with per-theme per-token report.
//
// Usage:
//   node docs/theme-surface/tools/token-coverage.mjs

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { baseLayer } from "../composers/_base.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SURFACE = resolve(__dirname, "..");
const COMPOSERS = resolve(SURFACE, "composers");
const PILOTS = resolve(SURFACE, "pilots");

// ----------------------------------------------------------------------------
// Step 1 - scan composer files for v("token") call sites.
// ----------------------------------------------------------------------------
function scanReferences() {
  const refs = new Map(); // token -> [{ file, line }]
  const files = readdirSync(COMPOSERS).filter(f => f.endsWith(".mjs"));
  for (const file of files) {
    const path = resolve(COMPOSERS, file);
    const src = readFileSync(path, "utf8");
    const lines = src.split("\n");
    const re = /\bv\(\s*["']([a-z][a-z0-9-]*)["']\s*\)/g;
    for (let i = 0; i < lines.length; i++) {
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        const name = m[1];
        if (!refs.has(name)) refs.set(name, []);
        refs.get(name).push({ file, line: i + 1 });
      }
    }
  }
  return refs;
}

// ----------------------------------------------------------------------------
// Step 2 - resolve the set of available --pinboard-<name> custom properties
// for a theme. We call the real baseLayer() instead of duplicating the
// fallback chain so this tool stays correct when _util.mjs or _base.mjs
// changes (e.g. when expandPalette gains a new fallback slot).
// ----------------------------------------------------------------------------
function resolvedTokens(tokens) {
  const css = baseLayer(tokens);
  const m = css.match(/:root\s*\{([\s\S]*?)\}/);
  if (!m) return new Set();
  const block = m[1];
  const out = new Set();
  const re = /--pinboard-([a-z0-9-]+)\s*:\s*([^;]+);/g;
  let hit;
  while ((hit = re.exec(block)) !== null) {
    const name = hit[1];
    const value = hit[2].trim();
    if (value === "" || value === "null" || value === "undefined") continue;
    out.add(name);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Step 3 - cross-check.
// ----------------------------------------------------------------------------
const refs = scanReferences();
const totalRefs = refs.size;

const themeFiles = readdirSync(PILOTS).filter(f => f.endsWith(".tokens.json")).sort();
const themes = themeFiles.map(f => {
  const slug = f.replace(/\.tokens\.json$/, "");
  const tokens = JSON.parse(readFileSync(resolve(PILOTS, f), "utf8"));
  return { slug, tokens, available: resolvedTokens(tokens) };
});

const unresolved = []; // { slug, token, sites: [{file, line}] }
for (const theme of themes) {
  for (const [token, sites] of refs) {
    if (theme.available.has(token)) continue;
    unresolved.push({ slug: theme.slug, token, sites });
  }
}

// ----------------------------------------------------------------------------
// Step 4 - report.
// ----------------------------------------------------------------------------
if (unresolved.length === 0) {
  console.log(`[token-coverage] PASS - ${themes.length} themes x ${totalRefs} referenced tokens, 0 unresolved`);
  process.exit(0);
}

console.log("[token-coverage] UNRESOLVED TOKENS DETECTED\n");
const byTheme = new Map();
for (const u of unresolved) {
  if (!byTheme.has(u.slug)) byTheme.set(u.slug, []);
  byTheme.get(u.slug).push(u);
}
for (const [slug, list] of byTheme) {
  console.log(`theme: ${slug}`);
  for (const u of list) {
    const site = u.sites[0];
    const moreSites = u.sites.length > 1 ? ` (+${u.sites.length - 1} more)` : "";
    console.log(`  token: "${u.token}" (referenced by composers/${site.file}:${site.line}${moreSites})`);
    console.log(`  hint: define "${u.token}" in palette / typo / space / radius / border,`);
    console.log(`        or add a fallback in composers/_util.mjs#expandPalette`);
  }
  console.log("");
}
const affectedThemes = byTheme.size;
const totalUnresolved = unresolved.length;
console.log(`[token-coverage] FAIL - ${affectedThemes} theme(s) with ${totalUnresolved} unresolved token(s)`);
process.exit(1);
