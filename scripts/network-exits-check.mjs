// Network-exit contract check (roadmap #38). Cross-checks three parties that
// previously had no machine link: the hand-written oracle
// (docs/network-exits.json), the runtime scripts, and the privacy disclosure.
//
//  1. Every literal https host in a runtime script is classified in the
//     oracle (exit or non-exit) — a brand-new host fails loudly instead of
//     shipping undisclosed.
//  2. Every oracle exit host appears in docs/privacy.md.
//  3. Every manifest static host is a listed exit.
//  4. Every host in the AI provider registry (ai.js) is a disclosed exit —
//     the structural under-inclusion guard for the one place endpoint hosts
//     actually live, complementing step 1's text-scan over-inclusion guard.
//  5. Every loopback http:// literal (AnkiConnect, Ollama) is on a hardcoded
//     origin-granularity allowlist and disclosed in docs/privacy.md (K130).
//     Deliberately independent of steps 1-3: the https regex and the oracle
//     schema are untouched — see that step's own comment for why.
//
// The release gate only checks "was a monitored doc edited at all"; this is
// the missing "does the edit actually correspond" half. The oracle is hand-
// written on purpose — generating it from source would only prove the code
// agrees with itself.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const oracle = JSON.parse(readFileSync(join(ROOT, "docs", "network-exits.json"), "utf8"));
const privacy = readFileSync(join(ROOT, "docs", "privacy.md"), "utf8");
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

let failures = 0;
const fail = (msg) => { failures++; console.error(`[network-exits] FAIL: ${msg}`); };

const exits = new Set(Object.keys(oracle.exits));
const nonExits = new Set(Object.keys(oracle.nonExitHosts));

// Loopback HTTP allowlist for step 5 below (K130). Kept as a hardcoded list
// here rather than a docs/network-exits.json row on purpose: the oracle
// classifies by *host*, but a bare host classification would silently allow
// a brand-new *port* (a new undisclosed local endpoint) to pass — this check
// needs origin granularity. AnkiConnect's port is user-configurable
// (anki-connect.js concatenates "http://127.0.0.1:" + port at runtime), so
// its entry is a host+scheme prefix; Ollama's port is a fixed literal
// (ai.js), so its entry is an exact origin.
const LOOPBACK_ALLOWLIST = [
  { origin: "http://localhost:11434", disclosedAs: "local Ollama" },
  { origin: "http://127.0.0.1:", disclosedAs: "AnkiConnect" },
];
const loopbackAllowed = (origin, entry) =>
  origin === entry.origin || (entry.origin.endsWith(":") && origin.startsWith(entry.origin));

// Bracket-aware host extraction for an "http://<host>[:<port>]" origin —
// shared by step 3b below. IPv6 loopback ([::1]) wraps its host in brackets
// containing colons, so a naive "stop at the first colon" regex misreads
// "http://[::1]:1234" as host "[" instead of "[::1]". No script literal
// exercises the [::1] branch today (see step 5's own comment), so a self-
// check runs immediately below rather than relying on incidental coverage.
const hostFromOrigin = (origin) => {
  const m = /^http:\/\/(\[[^\]]+\]|[^:/]+)(?::\d+)?/.exec(origin);
  return m && m[1];
};
for (const [origin, expected] of [
  ["http://localhost:11434", "localhost"],
  ["http://127.0.0.1:8765", "127.0.0.1"],
  ["http://[::1]:1234", "[::1]"],
]) {
  const got = hostFromOrigin(origin);
  if (got !== expected) fail(`internal error: hostFromOrigin(${origin}) = ${got}, expected ${expected} — bracket-aware host extraction regressed`);
}

// 1. Classify every literal https host in runtime scripts.
const seen = new Set();
for (const f of readdirSync(ROOT).filter((n) => n.endsWith(".js"))) {
  const src = readFileSync(join(ROOT, f), "utf8");
  for (const m of src.matchAll(/https:\/\/([a-z0-9.-]+)/g)) seen.add(m[1]);
}
for (const host of [...seen].sort()) {
  if (!exits.has(host) && !nonExits.has(host)) {
    fail(`${host}: appears in a runtime script but is classified in docs/network-exits.json as neither exit nor non-exit`);
  }
}

// Reverse direction: a classified host that no script mentions any more is a
// stale oracle row — prune it so the list stays honest.
for (const host of [...exits, ...nonExits]) {
  if (!seen.has(host)) fail(`${host}: in the oracle but no runtime script mentions it — stale entry?`);
}

// 2. Every exit is disclosed in privacy.md — by host, or by the user-facing
// name the oracle records as disclosedAs (the disclosure speaks to users, so
// "OpenAI" instead of api.openai.com is fine as long as the mapping is here).
for (const [host, entry] of Object.entries(oracle.exits)) {
  const name = entry && entry.disclosedAs;
  if (!privacy.includes(host) && !(name && privacy.includes(name))) {
    fail(`${host}: network exit not mentioned in docs/privacy.md (neither the host nor disclosedAs "${name || ""}")`);
  }
}

// 3. Manifest static hosts are exits.
for (const pattern of manifest.host_permissions || []) {
  const m = /^https:\/\/([a-z0-9.-]+)\//.exec(pattern);
  if (m && !exits.has(m[1])) fail(`${m[1]}: manifest host_permissions entry missing from the oracle's exits`);
}

// 3b. optional_host_permissions is the declaration ceiling Chrome grants
// runtime origins from (K130, near-zero-cost addition alongside step 5):
// every LOOPBACK_ALLOWLIST host must have a matching loopback pattern here,
// or Chrome could never actually grant that origin. The blanket
// "https://*/*" ceiling is skipped automatically — it has no "http://" prefix.
const declaredLoopbackHosts = new Set();
for (const pattern of manifest.optional_host_permissions || []) {
  const m = /^http:\/\/([^/]+)\/\*$/.exec(pattern);
  if (m) declaredLoopbackHosts.add(m[1]);
}
for (const entry of LOOPBACK_ALLOWLIST) {
  const host = hostFromOrigin(entry.origin);
  if (!declaredLoopbackHosts.has(host)) {
    fail(`${host}: LOOPBACK_ALLOWLIST entry has no matching manifest optional_host_permissions ceiling`);
  }
}

// 4. STRUCTURAL layer (Codex final review; CLAUDE.md's grep-is-not-consumption
// rule): evaluate the provider registry the runtime actually dispatches
// through and require every base host in it to be a disclosed exit. The text
// scan above stays as the wide net (over-inclusive is safe — it can only
// demand classification); this layer is the under-inclusion guard for the
// registry, the single structure where endpoint hosts actually live.
try {
  const aiSrc = readFileSync(join(ROOT, "ai.js"), "utf8");
  const regStart = aiSrc.indexOf("const OPENAI_COMPAT_PROVIDERS = {");
  const regEnd = aiSrc.indexOf("\n};", regStart);
  if (regStart < 0 || regEnd <= regStart) throw new Error("provider registry not found in ai.js");
  const registry = new Function(aiSrc.slice(regStart, regEnd + 3) + "\nreturn OPENAI_COMPAT_PROVIDERS;")();
  const bespoke = [
    "https://generativelanguage.googleapis.com", // gemini
    "https://api.anthropic.com",                 // claude
  ];
  const registryHosts = [
    ...Object.values(registry).map((cfg) => cfg.base).filter(Boolean),
    ...bespoke,
  ].map((u) => new URL(u).hostname);
  for (const host of registryHosts) {
    if (!exits.has(host)) fail(`${host}: dispatched through the AI provider registry but not a disclosed exit`);
  }
} catch (e) {
  fail(`provider-registry structural check failed to run: ${e.message}`);
}

// 5. Loopback http:// literals, at origin granularity (K130). Steps 1-3 are
// https-only by design (see the header comment): widening that regex or the
// oracle schema to host granularity would (a) let a brand-new port on an
// already-classified loopback host — e.g. a hypothetical local TTS or vector
// store on a different port — pass silently, defeating the point, and
// (b) drag in XML/SVG namespace URIs (www.w3.org, purl.org, www.idpf.org)
// that share no host with a loopback literal but would still need an
// oracle row under host-only classification. This check is independent:
// it does not touch `seen`, `exits`, `nonExits`, or docs/network-exits.json.
const LOOPBACK_RE = /http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/g;
const loopbackOrigins = new Set();
for (const f of readdirSync(ROOT).filter((n) => n.endsWith(".js"))) {
  const src = readFileSync(join(ROOT, f), "utf8");
  for (const m of src.matchAll(LOOPBACK_RE)) {
    // A loopback mention inside a `//` comment (e.g. anki-connect.js citing
    // AnkiConnect's own default CORS Access-Control-Allow-Origin value in
    // prose) is documentation, not a literal the runtime fetches — every
    // genuine data-exit literal in this codebase is a quoted string, so
    // require the match to be immediately preceded by a quote character.
    const before = src[m.index - 1];
    if (before !== '"' && before !== "'" && before !== "`") continue;
    let origin = m[0];
    // A string-concatenated port ("http://127.0.0.1:" + port, anki-connect.js)
    // leaves a bare colon right after the match with no digits for the regex
    // to consume; normalize that to a host+colon prefix template, since the
    // concrete port is runtime data, not a literal.
    if (!/:\d+$/.test(origin) && src[m.index + origin.length] === ":") origin += ":";
    loopbackOrigins.add(origin);
  }
}
for (const origin of [...loopbackOrigins].sort()) {
  if (!LOOPBACK_ALLOWLIST.some((entry) => loopbackAllowed(origin, entry))) {
    fail(`${origin}: loopback HTTP literal not in network-exits-check.mjs's LOOPBACK_ALLOWLIST — new local endpoints must be disclosed in docs/privacy.md and added to the allowlist`);
  }
}
for (const entry of LOOPBACK_ALLOWLIST) {
  if (![...loopbackOrigins].some((origin) => loopbackAllowed(origin, entry))) {
    fail(`${entry.origin}: allowlisted but no runtime script mentions it anymore — stale allowlist entry?`);
  }
  if (!privacy.includes(entry.disclosedAs)) {
    fail(`${entry.disclosedAs}: loopback allowlist entry not mentioned in docs/privacy.md`);
  }
}

if (failures) {
  console.error(`[network-exits] ${failures} problem(s)`);
  process.exit(1);
}
console.log(`[network-exits] PASS - ${seen.size} script hosts classified, ${exits.size} exits all disclosed, manifest hosts covered, ${loopbackOrigins.size} loopback origin(s) allowlisted`);
