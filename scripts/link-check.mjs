#!/usr/bin/env node
// link-check: checks the http(s) links in the outward-facing docs. Used by
// the weekly sentinel (.github/workflows/sentinel.yml); not part of verify.sh,
// which stays offline.
//
//   node scripts/link-check.mjs                  README*.md, SECURITY.md, docs/privacy.md, docs/index.md, docs/troubleshooting.md, docs/data-format.md
//   node scripts/link-check.mjs a.md b.md        only these files
//   node scripts/link-check.mjs --json out.json  also write every result as JSON
//
// Each unique link gets HEAD, then GET when HEAD answers 403, 405 or 501.
// A timeout, a network error or a 5xx is tried again twice with a growing
// pause. Results:
//   ok            2xx or 3xx after redirects
//   broken        404 or 410, a host name that does not resolve, or 5xx on every try
//   unverifiable  401, 403, 429, a bot wall, a timeout, any other answer;
//                 the link may be fine, a script just cannot tell
// Loopback, example domains and URL templates are skipped; URLs inside code
// spans and fenced code are not links and are not read at all.
// Exit 0 when nothing is broken, 1 when something is, 2 when a file cannot be read.
import { readFileSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const USER_AGENT = "Mozilla/5.0 (compatible; docs-link-check/1.0)";
const DEFAULTS = { timeoutMs: 15000, retries: 2, backoffMs: 1000, concurrency: 4 };

// ---- extracting ----
const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
const TRAILING = /[.,;:!?*_]+$/;

// Code (fenced blocks and `inline` spans) names origins and endpoints, it does
// not link to them, so it is blanked out first.
export function stripCode(text) {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "").replace(/(`+)[^`]*?\1/g, "");
}

export function extractLinks(markdown) {
  const text = stripCode(markdown);
  const out = [];
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0].replace(TRAILING, "");
    // A Markdown link target may hold balanced parentheses (Wikipedia style).
    const after = text.slice(m.index + m[0].length);
    if (/\([^)\s]*$/.test(url) && after.startsWith(")")) url += ")";
    out.push(url);
  }
  return out;
}

const SKIP_HOSTS = /^(localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\]|::1)$|(^|\.)example\.(com|org|net)$|\.(example|invalid|test|localhost)$/i;
// Why a link is not checked, or "" when it is.
// PBP_LINK_CHECK_ALLOW_LOOPBACK=1 lets the command-line tests point links at a
// local server; nothing else sets it.
export function skipReason(url, { allowLoopback = process.env.PBP_LINK_CHECK_ALLOW_LOOPBACK === "1" } = {}) {
  if (/[{}$<>*]|%7B|%7D/i.test(url)) return "template";
  let u;
  try { u = new URL(url); } catch { return "not a URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "not http";
  if (allowLoopback && u.hostname === "127.0.0.1") return "";
  if (SKIP_HOSTS.test(u.hostname)) return "loopback or example";
  if (!u.hostname.includes(".")) return "no public host";
  return "";
}

// { url: [files] } for every unique link in the files, plus the skipped ones.
export function collectLinks(files, read = (f) => readFileSync(f, "utf8")) {
  const links = new Map(), skipped = new Map();
  for (const f of files) {
    for (const url of extractLinks(read(f))) {
      const why = skipReason(url);
      const map = why ? skipped : links;
      if (!map.has(url)) map.set(url, { files: [], why });
      if (!map.get(url).files.includes(f)) map.get(url).files.push(f);
    }
  }
  return { links, skipped };
}

// ---- checking ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DNS_CODES = new Set(["ENOTFOUND"]);
function errorCode(e) {
  if (e && (e.name === "AbortError" || e.name === "TimeoutError")) return "TIMEOUT";
  for (let x = e; x; x = x.cause) if (typeof x.code === "string") return x.code;
  return "";
}
function isBotWall(res) {
  return res.headers.get("cf-mitigated") === "challenge" || (res.status === 503 && /cloudflare/i.test(res.headers.get("server") || ""));
}

async function request(url, method, { fetchImpl, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method, redirect: "follow", signal: ac.signal, headers: { "user-agent": USER_AGENT, accept: "*/*" } });
    try { await res.body?.cancel(); } catch { /* swallow-ok: the body is not needed */ }
    return { res };
  } catch (e) {
    return { error: errorCode(e) || "NETWORK" };
  } finally { clearTimeout(timer); }
}

// One attempt: HEAD, then GET when HEAD is refused.
async function attempt(url, opts) {
  let r = await request(url, "HEAD", opts);
  if (r.res && [403, 405, 501].includes(r.res.status)) r = await request(url, "GET", opts);
  return r;
}

// -> { url, result: "ok" | "broken" | "unverifiable", detail, tries }
export async function checkUrl(url, options = {}) {
  const opts = { ...DEFAULTS, fetchImpl: globalThis.fetch, ...options };
  let last;
  for (let tries = 1; tries <= opts.retries + 1; tries++) {
    last = await attempt(url, opts);
    if (last.res) {
      const s = last.res.status;
      if (isBotWall(last.res)) return { url, result: "unverifiable", detail: `bot wall (${s})`, tries };
      if (s >= 200 && s < 400) return { url, result: "ok", detail: String(s), tries };
      if (s === 404 || s === 410) return { url, result: "broken", detail: String(s), tries };
      if ([401, 403, 429].includes(s)) return { url, result: "unverifiable", detail: String(s), tries };
      if (s < 500) return { url, result: "unverifiable", detail: String(s), tries };
    } else if (DNS_CODES.has(last.error)) {
      return { url, result: "broken", detail: `host not found (${last.error})`, tries };
    }
    if (tries <= opts.retries) await sleep(opts.backoffMs * tries);
  }
  if (last.res) return { url, result: "broken", detail: `${last.res.status} on every try`, tries: opts.retries + 1 };
  return { url, result: "unverifiable", detail: last.error === "TIMEOUT" ? "timeout" : `network error (${last.error})`, tries: opts.retries + 1 };
}

export async function checkAll(urls, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const list = [...new Set(urls)];
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => { while (next < list.length) { const i = next++; results[i] = await checkUrl(list[i], opts); } };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, list.length) }, worker));
  return results;
}

// ---- command line ----
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export function defaultFiles(root = ROOT) {
  return [
    ...readdirSync(root).filter((f) => /^README(\.[^/]+)?\.md$/.test(f)).sort(),
    "SECURITY.md",
    "docs/privacy.md",
    "docs/index.md",
    "docs/troubleshooting.md",
    "docs/data-format.md",
  ];
}

async function main(argv) {
  const jsonAt = argv.indexOf("--json");
  const jsonFile = jsonAt === -1 ? "" : argv[jsonAt + 1];
  if (jsonAt !== -1 && !jsonFile) { console.error("[link-check] --json needs a file name"); return 2; }
  const named = argv.filter((a, i) => jsonAt === -1 || (i !== jsonAt && i !== jsonAt + 1));
  const files = named.length ? named : defaultFiles();
  let collected;
  try { collected = collectLinks(files.map((f) => (named.length ? f : join(ROOT, f))), (f) => readFileSync(f, "utf8")); }
  catch (e) { console.error(`[link-check] cannot read a file: ${e.message}`); return 2; }
  const rel = (f) => (f.startsWith(ROOT + "/") ? f.slice(ROOT.length + 1) : f);
  const results = (await checkAll([...collected.links.keys()])).map((r) => ({ ...r, files: collected.links.get(r.url).files.map(rel) }));
  const count = (k) => results.filter((r) => r.result === k).length;
  for (const r of results.filter((x) => x.result !== "ok")) console.log(`${r.result.padEnd(12)} ${r.url}  (${r.detail}; in ${r.files.join(", ")})`);
  console.log(`[link-check] ${results.length} links: ok ${count("ok")}, broken ${count("broken")}, unverifiable ${count("unverifiable")}, skipped ${collected.skipped.size}`);
  if (jsonFile) {
    const skipped = [...collected.skipped].map(([url, v]) => ({ url, why: v.why, files: v.files.map(rel) }));
    writeFileSync(jsonFile, JSON.stringify({ results, skipped }, null, 2) + "\n");
  }
  return count("broken") ? 1 : 0;
}

// True when this file is the entry point, also when it was started through a
// symlink (argv[1] is the link; import.meta.url is the resolved file).
function isMainModule() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isMainModule()) {
  process.exitCode = await main(process.argv.slice(2));
}
