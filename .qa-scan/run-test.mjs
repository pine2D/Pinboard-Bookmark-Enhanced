// Headless runner for the project's tests/*.html browser suites.
// Serves the repo root over a local HTTP server (so tests that fetch() source
// files work — file:// blocks fetch), loads the test in bundled Chromium, then
// waits for the suite's declared number of structured result rows, then for
// one second with no new row (a later row is counted, not missed). Exit 0 =
// green, 1 = red, 2 = unknown suite / invalid invocation.
//
// Usage: node .qa-scan/run-test.mjs tests/<file>.html
//        PBP_ONLY=<case name part>[,<part>...] node .qa-scan/run-test.mjs tests/<file>.html
// PBP_ONLY (dev-time only) runs just the cases whose name contains a part
// (case-insensitive), for pages that load tests/fixtures/case-filter.js. The
// row count is NOT checked against pbp-expected-count then: the run says
// "FILTERED ... row count not checked", reports how many cases ran, and exits
// 1 only for a failure, a page error, a stall or no matching case (exit 2 when
// the page has no filter support). It is never a substitute for the full run.
//        node .qa-scan/run-test.mjs --print-counts tests/<file>.html [more.html ...]
// --print-counts only reports: the rows a page actually rendered next to its
// <meta name="pbp-expected-count"> declaration. The page is measured once its registered count (any row,
// when unregistered) has been reached and no new row has come for a quiet window.
// A page's own end signal (document.title starting with PASS/FAIL, or a non-empty
// #summary) shortens that window to 1.5s, but only a trusted one: it was not yet
// showing when the page loaded and no row came after it appeared. Suites that
// write theirs at load, or on every row, get the 3s window. A #summary that is
// still empty keeps a 10s window, registered or not. An unregistered page never
// shortens its window to follow a signal (3s at least). After the
// window a later row is not seen, and the report names the window it used. A
// registered page that never reaches its count is UNCONFIRMED, exit 1, even if it
// announced its end below that count (the message says so). It edits nothing and
// leaves the normal mode untouched; exit 0 unless the page could not be measured.
//        PBP_BROWSER_EXECUTABLE=<path> node .qa-scan/run-test.mjs tests/<file>.html
// PBP_BROWSER_EXECUTABLE (the weekly sentinel) launches that browser binary
// instead of the bundled Chromium. Unset or empty, nothing changes.
//        PBP_COVERAGE_DIR=<dir> node .qa-scan/run-test.mjs tests/<file>.html
// PBP_COVERAGE_DIR (dev tool, scripts/coverage-report.mjs) also records V8 JS
// coverage for the page and writes <dir>/<page>.json: url + per-function
// ranges, no source text. The verdict and exit code are unchanged.
import { chromium } from "playwright";
import { createServer } from "http";
import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve, dirname, extname, relative } from "path";
import { fileURLToPath } from "url";

const argv = process.argv.slice(2);
const printCounts = argv.includes("--print-counts");
const onlyFilter = (process.env.PBP_ONLY || "").trim();
const coverageDir = (process.env.PBP_COVERAGE_DIR || "").trim();
const browserExecutable = (process.env.PBP_BROWSER_EXECUTABLE || "").trim();
if (onlyFilter && printCounts) {
  console.error("ERROR: PBP_ONLY cannot be combined with --print-counts (a filtered page has no row count to print)");
  process.exit(2);
}
const files = argv.filter((arg) => arg !== "--print-counts");
const file = files[0];
if (!file) {
  console.error("usage: node .qa-scan/run-test.mjs [--print-counts] <test.html> [...]");
  process.exit(2);
}
if (printCounts && files.length > 1) {
  // One page per process: the runner keeps its server and browser in module state.
  const { spawnSync } = await import("child_process");
  let worst = 0;
  for (const one of files) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--print-counts", one], { stdio: "inherit" });
    worst = Math.max(worst, child.status === null ? 1 : child.status);
  }
  process.exit(worst);
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const abs = resolve(file);
const rel = relative(ROOT, abs).split("\\").join("/");
// These larger suites include real asynchronous DOM/IDB work. Library's
// 561-row suite measured 38.89s wall time under load; a 45s outer deadline
// leaves less than 39s for rows after launch/navigation and the 6s diagnostic
// reserve below. Give only this suite 60s; conversion retains its 45s budget.
const TEST_TIMEOUT_MS = rel === "tests/library-vocab-tests.html" ? 60000
  : rel === "tests/md-convert-tests.html" ? 45000 : 30000;
const CLEANUP_TIMEOUT_MS = 5000;
// Cushion between "the wait-for-rows deadline + the diagnostic sample's own
// bound" and the outer bounded("test", TEST_TIMEOUT_MS) deadline (started
// before chromium.launch()). Without this, a fixed WAIT_TIMEOUT_MS computed
// only from TEST_TIMEOUT_MS ignores launch/navigation time that already
// elapsed before the wait even starts, and a worst-case diagnostic sample
// (bounded by CLEANUP_TIMEOUT_MS) can push the total past TEST_TIMEOUT_MS —
// the outer deadline then wins the race first and the whole diagnostic
// payload (STALLED marker, sample) is discarded, right in the "suite's main
// thread is genuinely wedged" scenario this fix exists for.
const SAFETY_MARGIN_MS = 1000;

// Completion is explicit: each suite declares `<meta name="pbp-expected-count" content="N">`
// in its `<head>` and must emit exactly that many DOM result ROWS carrying a
// pass/fail/skip class. NOTE: the row unit varies per page --
// md-dict/dict-pack/anki/eudic emit one row per assertion, md-ai emits one
// row per test() block. Count rows in the page, not assert calls; an
// undeclared suite is rejected instead of guessed complete.
async function readDeclaredExpectedCount(absPath, relPath) {
  let html = "";
  try {
    html = await readFile(absPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return undefined;
    throw err;
  }
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const metas = [...stripped.matchAll(/<meta\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => /\bname\s*=\s*(?:"pbp-expected-count"|'pbp-expected-count'|pbp-expected-count)(?=[\s/>])/i.test(tag));
  if (metas.length === 0) return undefined;
  if (metas.length > 1) {
    console.error(`ERROR: multiple <meta name="pbp-expected-count"> declarations in ${relPath}`);
    process.exit(2);
  }
  const contentMatch = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/i.exec(metas[0]);
  const raw = contentMatch ? (contentMatch[1] ?? contentMatch[2] ?? contentMatch[3] ?? "") : "";
  if (!/^[1-9]\d*$/.test(raw)) {
    console.error(`ERROR: invalid <meta name="pbp-expected-count"> value ${JSON.stringify(raw)} in ${relPath} (expected a positive integer)`);
    process.exit(2);
  }
  return Number(raw);
}
const expected = await readDeclaredExpectedCount(abs, rel);
if (expected === undefined && !printCounts && !onlyFilter) {
  console.error(`ERROR: no expected result count (<meta name="pbp-expected-count">) registered for ${rel}`);
  process.exit(2);
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
};

// Minimal static server rooted at the repo, so fetch("../shared.js") etc. resolve.
const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const target = resolve(ROOT, "." + urlPath);
    if (!target.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(target);
    res.writeHead(200, { "Content-Type": MIME[extname(target)] || "application/octet-stream" });
    res.end(body);
  } catch (_) {
    res.writeHead(404); res.end("not found");
  }
});

async function bounded(label, timeoutMs, task) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let browser;
let browserDisconnected = false;
const runtimeErrors = [];
const blockedExternal = [];     // DOM subresources: blocked + reported, non-fatal
const blockedProgrammatic = []; // fetch/xhr/etc: a missed mock — fails the run
try {
  await bounded("server start", CLEANUP_TIMEOUT_MS, () => new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  }));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/${rel}` + (onlyFilter ? `?pbp_only=${encodeURIComponent(onlyFilter)}` : "");

  const dom = await bounded("test", TEST_TIMEOUT_MS, async () => {
    const taskStartedAt = Date.now();
    browser = await (browserExecutable ? chromium.launch({ executablePath: browserExecutable }) : chromium.launch());
    browser.once("disconnected", () => { browserDisconnected = true; });
    const page = await browser.newPage();
    page.on("pageerror", (error) => runtimeErrors.push("PAGEERROR: " + error.message));
    page.on("crash", () => runtimeErrors.push("PAGECRASH: renderer crashed"));
    const localOrigin = new URL(url).origin;
    // Closed network by default (same policy as scripts/perf-cold-sample.mjs):
    // any http(s) request off the local test server is aborted and reported.
    // A missed fetch mock must fail loudly here — not silently reach a real
    // API and go green-online / red-offline. A suite that genuinely needs an
    // external origin must mock it via page fixtures instead.
    await page.route("**/*", (route) => {
      const request = route.request();
      const requestUrl = request.url();
      if (/^https?:/.test(requestUrl) && new URL(requestUrl).origin !== localOrigin) {
        // Programmatic requests (fetch/xhr/websocket…) off-origin mean a
        // missed mock — those FAIL the run (Codex review: a NOTE alone lets
        // code that swallows the network error stay green). DOM subresources
        // (an <img src> in a layout fixture, a stylesheet) are expected
        // fixture noise: blocked and reported, not fatal. A subframe document
        // load is the same class: an <iframe src> fixture declares it in the
        // DOM, nothing programmatic swallowed an error. Main-frame navigation
        // off-origin still fails.
        const rt = request.resourceType();
        const subresource = rt === "image" || rt === "media" || rt === "font" || rt === "stylesheet"
          || (rt === "document" && request.frame() !== page.mainFrame());
        (subresource ? blockedExternal : blockedProgrammatic)
          .push(rt + " " + request.method() + " " + requestUrl);
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });

    if (coverageDir) await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
    const response = await page.goto(url, { waitUntil: "load", timeout: 0 });
    if (!response || !response.ok()) throw new Error(`test page failed to load: HTTP ${response && response.status()}`);

    // Real deadline (not the old timeout: 0 — infinite, leaving only the
    // outer bounded("test", TEST_TIMEOUT_MS) to ever cut this off). A suite
    // that stalls (pbp-expected-count miscounted, an awaited mock that never
    // settles, a case that dies mid-block) needs to fall through to the
    // sampling below instead of vanishing into one opaque "test timed out"
    // line once the outer deadline eventually fires. Computed from actual
    // elapsed time (not a fixed fraction of TEST_TIMEOUT_MS): launch + goto
    // above already spent part of the budget, and the diagnostic sample
    // below needs its own CLEANUP_TIMEOUT_MS reserved after this wait gives
    // up — both must still land inside TEST_TIMEOUT_MS, with SAFETY_MARGIN_MS
    // to spare, or the outer bounded() wins the race and discards everything
    // this fix gathers.
    const elapsedBeforeWait = Date.now() - taskStartedAt;
    const waitTimeoutMs = Math.max(
      1000,
      TEST_TIMEOUT_MS - elapsedBeforeWait - CLEANUP_TIMEOUT_MS - SAFETY_MARGIN_MS,
    );
    // Deliberately NOT passed as waitForFunction's own `timeout` option:
    // verified experimentally that Playwright's client-side deadline for
    // waitForFunction/evaluate does not fire reliably when the *page's own
    // main thread* is wedged (a synchronous busy loop, not just a pending
    // promise) — its polling loop awaits each round-trip evaluate() call,
    // and the deadline is only checked between round-trips, so a single
    // evaluate() that never returns (because the renderer can't run it)
    // leaves the "timeout" option honored 60s+ late in practice. Racing it
    // against our own plain setTimeout here — the same independent-of-the-
    // browser mechanism bounded() already uses below — is what actually
    // enforces the deadline for that failure mode.
    const STALL = Symbol("stall");
    let stallTimer;
    let stalled = false;
    // waitForRows is raced, not awaited directly: if the stall timer wins,
    // this promise is abandoned (still pending against a possibly-wedged
    // page) and will typically settle later on its own once the page or
    // browser closes — attach a no-op catch so that later settlement can't
    // surface as an unhandled rejection; it doesn't affect what Promise.race
    // observes below.
    // --print-counts must not call a page finished just because its row count
    // paused: a case that waits a second or two (a setTimeout, a mock delay)
    // looks exactly like the end. The count must reach the registered number
    // (any row, when unregistered) and then stay still for a quiet window: 3s by
    // default; 1.5s when the page's own end signal (title PASS/FAIL, non-empty
    // #summary) is trusted, i.e. it was absent at the first poll and no row came
    // after it showed up (ai-tags, md-ai and library-listbox write theirs at load
    // or per row, so they never qualify); 10s while a #summary is still empty, registered
    // or not. An unregistered page never shortens its window (3s at least). A registered page that never gets there
    // is UNCONFIRMED, not a smaller "actual" count.
    if (onlyFilter) {
      const supported = await bounded("filter probe", CLEANUP_TIMEOUT_MS, () => page.evaluate(() => !!(window.__pbpCases && window.__pbpCases.filtered)));
      if (!supported) {
        console.error(`ERROR: ${rel} has no case filter (tests/fixtures/case-filter.js); PBP_ONLY cannot be used with it`);
        process.exitCode = 2;
        return { unsupported: true, pass: 0, fail: 0, skip: 0, failures: [], stalled: false };
      }
    }
    const waitForRows = onlyFilter
      // Filtered: done when every call has been seen, no started case is still
      // pending, and nothing new has been called or rendered for a quiet window.
      ? page.waitForFunction(() => {
        const now = performance.now();
        const cases = window.__pbpCases;
        const rows = document.querySelectorAll(".pass, .fail, .skip").length;
        const key = cases.seen + ":" + cases.ran + ":" + cases.pending + ":" + rows;
        const w = window.__pbpFilterWatch || (window.__pbpFilterWatch = { key: "", since: now });
        if (w.key !== key) { w.key = key; w.since = now; }
        return cases.seen > 0 && cases.pending === 0 && now - w.since >= 1500;
      }, null, { polling: 100, timeout: 0 })
      : printCounts
      ? page.waitForFunction((registered) => {
        const now = performance.now();
        const total = document.querySelectorAll(".pass, .fail, .skip").length;
        const seen = window.__pbpCountWatch || (window.__pbpCountWatch = { total: -1, since: now, sigTotal: null, sigAtLoad: false, broken: false, trusted: false, windowMs: 3000 });
        const firstPoll = seen.total === -1;
        if (seen.total !== total) {
          if (seen.sigTotal !== null) seen.broken = true; // a row after the signal appeared
          seen.total = total; seen.since = now;
        }
        const summary = document.getElementById("summary");
        const summaryFilled = !!(summary && (summary.textContent || "").trim());
        const signalled = /^(PASS|FAIL)\b/.test(document.title || "") || summaryFilled;
        if (signalled && seen.sigTotal === null) { seen.sigTotal = total; seen.sigAtLoad = firstPoll; }
        seen.trusted = signalled && !seen.sigAtLoad && !seen.broken;
        seen.windowMs = registered !== undefined && seen.trusted ? 1500 : summary && !summaryFilled ? 10000 : 3000;
        const enough = registered === undefined ? total > 0 : total >= registered;
        return enough && now - seen.since >= seen.windowMs;
      }, expected, { polling: 100, timeout: 0 })
      // Normal: the registered count, then a short quiet window. Sampling the
      // moment the count was reached missed a case rendered after it (a new
      // case on a page whose count was not yet raised, seen 2026-11-04 on
      // reader-bookmark), so the run said "match" over a page with more rows.
      : page.waitForFunction((resultCount) => {
        const now = performance.now();
        const total = document.querySelectorAll(".pass, .fail, .skip").length;
        const w = window.__pbpRunWatch || (window.__pbpRunWatch = { total: -1, since: now });
        if (w.total !== total) { w.total = total; w.since = now; }
        return total >= resultCount && now - w.since >= 1000;
      }, expected, { polling: 50, timeout: 0 });
    waitForRows.catch(() => {});
    try {
      const outcome = await Promise.race([
        waitForRows,
        new Promise((resolveStall) => { stallTimer = setTimeout(() => resolveStall(STALL), waitTimeoutMs); }),
      ]);
      if (outcome === STALL) stalled = true;
    } finally {
      clearTimeout(stallTimer);
    }

    // Sample current DOM state either way — the page is still alive here
    // (only `finally` closes it). Bounded separately: page.evaluate() has no
    // built-in timeout, so a suite stuck in a synchronous infinite loop
    // would otherwise hang this call forever instead of letting the outer
    // "test timed out" message (and whatever this sample already gathered)
    // surface. A failed sample must not swallow the stall signal itself.
    let dom;
    try {
      dom = await bounded("diagnostic sample", CLEANUP_TIMEOUT_MS, () => page.evaluate(() => {
        let pass = 0, fail = 0, skip = 0;
        const failures = [];
        const rows = document.querySelectorAll(".pass, .fail, .skip");
        for (const el of rows) {
          if (el.classList.contains("fail")) { fail++; failures.push(el.textContent || "FAIL"); }
          else if (el.classList.contains("pass")) pass++;
          else if (el.classList.contains("skip")) skip++;
        }
        const lastRows = [...rows].slice(-3).map((el) => (el.textContent || "").trim());
        const watch = window.__pbpCountWatch;
        const cases = window.__pbpCases;
        return { pass, fail, skip, failures: failures.slice(0, 20), title: document.title || "", lastRows, cases: cases ? { seen: cases.seen, ran: cases.ran, pending: cases.pending } : null, trusted: !!(watch && watch.trusted), windowMs: watch ? watch.windowMs : 3000 };
      }));
    } catch (sampleError) {
      dom = {
        pass: 0, fail: 0, skip: 0, failures: [], title: "", lastRows: [],
        sampleError: sampleError && sampleError.message ? sampleError.message : String(sampleError),
      };
    }
    if (coverageDir) {
      try {
        const entries = await bounded("coverage", CLEANUP_TIMEOUT_MS, () => page.coverage.stopJSCoverage());
        const slim = entries.map((e) => ({ url: e.url, functions: e.functions }));
        await mkdir(coverageDir, { recursive: true });
        await writeFile(resolve(coverageDir, rel.split("/").pop().replace(/\.html$/, ".json")), JSON.stringify({ page: rel, entries: slim }));
      } catch (coverageError) {
        console.error(`ERROR: coverage could not be recorded: ${coverageError && coverageError.message ? coverageError.message : coverageError}`);
      }
    }
    return { ...dom, stalled };
  });

  const total = dom.pass + dom.fail + dom.skip;
  if (dom.unsupported) {
    // exit code 2 already set above
  } else if (onlyFilter) {
    const c = dom.cases || { seen: 0, ran: 0, pending: 0 };
    console.log(`FILTERED (PBP_ONLY=${onlyFilter}): ran ${c.ran} of ${c.seen} cases, pass=${dom.pass} fail=${dom.fail} skip=${dom.skip} rows=${total}; 已过滤，未做条数核对 (row count not checked against pbp-expected-count)${dom.stalled ? ` STALLED(pending=${c.pending}, last row: "${(dom.lastRows && dom.lastRows[dom.lastRows.length - 1]) || ""}")` : ""}`);
    if (dom.sampleError) console.error(`ERROR: diagnostic sample failed: ${dom.sampleError}`);
    if (dom.failures?.length) console.error("failures:\n  " + dom.failures.join("\n  "));
    if (runtimeErrors.length) console.error("errors:\n  " + runtimeErrors.slice(0, 25).join("\n  "));
    if (browserDisconnected) console.error("ERROR: browser disconnected before the suite completed");
    if (blockedProgrammatic.length) {
      const unique = [...new Set(blockedProgrammatic)];
      console.error(`ERROR: closed network blocked ${blockedProgrammatic.length} PROGRAMMATIC external request(s) — a mock is missing:\n  ` + unique.slice(0, 10).join("\n  "));
    }
    if (c.ran === 0 && !dom.stalled) { console.error(`ERROR: PBP_ONLY=${onlyFilter} matched no case (of ${c.seen})`); process.exitCode = 2; }
    else if (dom.fail > 0 || runtimeErrors.length > 0 || browserDisconnected || blockedProgrammatic.length > 0 || dom.stalled || dom.sampleError) process.exitCode = 1;
  } else if (printCounts) {
    const registered = expected === undefined ? "unregistered" : String(expected);
    const verdict = expected === undefined ? "NOT REGISTERED"
      : dom.stalled && total < expected ? `UNCONFIRMED (never reached ${expected} before the stall deadline${dom.trusted ? `; the page announced its end at ${total} rows, so the registered count may be too high` : ": a slow case or fewer rows"}, run the normal mode to see which)`
      : total === expected ? "match" : `DIFFERS (${total > expected ? "+" : ""}${total - expected})`;
    // Only a trusted end signal makes the measurement certain; otherwise say what the window could not see.
    const caveat = (dom.trusted && expected !== undefined) || verdict.startsWith("UNCONFIRMED") ? ""
      : expected === undefined
        ? ` (unregistered: sampled after no new row for ${dom.windowMs / 1000}s, so later rows are not seen)`
        : ` (no trusted end signal: no new row for ${dom.windowMs / 1000}s after the count was reached, so later rows are not seen)`;
    console.log(`${rel}: pass=${dom.pass} fail=${dom.fail} skip=${dom.skip} total=${total} expected=${registered} ${verdict}${caveat}${dom.stalled ? " STALLED" : ""}`);
    if (dom.failures?.length) console.error("failures:\n  " + dom.failures.join("\n  "));
    if (runtimeErrors.length) console.error("errors:\n  " + runtimeErrors.slice(0, 25).join("\n  "));
    if (dom.stalled || browserDisconnected || dom.sampleError) process.exitCode = 1;
  } else {
    const stalledNote = dom.stalled
      ? ` STALLED(rendered=${total}, last row: "${(dom.lastRows && dom.lastRows[dom.lastRows.length - 1]) || ""}")`
      : "";
    console.log(`pass=${dom.pass} fail=${dom.fail} skip=${dom.skip} expected=${expected} title="${dom.title}"${stalledNote}`);
    if (dom.sampleError) console.error(`ERROR: diagnostic sample failed after the suite stalled: ${dom.sampleError}`);
    if (dom.failures?.length) console.error("failures:\n  " + dom.failures.join("\n  "));
    if (total !== expected) console.error(`ERROR: expected ${expected} result rows, found ${total}`);
    if (runtimeErrors.length) console.error("errors:\n  " + runtimeErrors.slice(0, 25).join("\n  "));
    if (browserDisconnected) console.error("ERROR: browser disconnected before the suite completed");
    if (blockedExternal.length) {
      const unique = [...new Set(blockedExternal)];
      console.error(`NOTE: closed network blocked ${blockedExternal.length} external subresource(s):\n  ` + unique.slice(0, 10).join("\n  "));
    }
    if (blockedProgrammatic.length) {
      const unique = [...new Set(blockedProgrammatic)];
      console.error(`ERROR: closed network blocked ${blockedProgrammatic.length} PROGRAMMATIC external request(s) — a mock is missing:\n  ` + unique.slice(0, 10).join("\n  "));
    }
    if (dom.fail > 0 || total !== expected || runtimeErrors.length > 0 || browserDisconnected || blockedProgrammatic.length > 0 || dom.stalled) process.exitCode = 1;
  }
} catch (error) {
  console.error(`ERROR: ${error && error.message ? error.message : error}`);
  if (runtimeErrors.length) console.error("errors:\n  " + runtimeErrors.slice(0, 25).join("\n  "));
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  if (browser) {
    try {
      await bounded("browser close", CLEANUP_TIMEOUT_MS, () => browser.close());
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (server.listening) {
    try {
      await bounded("server close", CLEANUP_TIMEOUT_MS, () => new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      }));
    } catch (error) {
      if (server.closeAllConnections) server.closeAllConnections();
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) {
    for (const error of cleanupErrors) console.error(`ERROR: ${error.message || error}`);
    process.exitCode = 1;
  }
}

process.exit(process.exitCode || 0);
