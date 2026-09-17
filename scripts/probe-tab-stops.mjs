#!/usr/bin/env node
// probe-tab-stops — ONE-OFF measurement probe for K72 (popup 标签区 Tab 停靠点
// 四态计数). This is NOT wired into verify.sh / pre-commit / CI and changes no
// product code: it only counts. See
// .superpowers/sdd/2026-09-17-opt-waveB/task-5-report.md for the numbers and
// the route decision (甲/乙/不做) this measurement feeds, left to the user.
//
// WHAT IT MEASURES
//   The number of visible, non-disabled keyboard tab stops strictly between
//   #tags-input (exclusive) and #private-check (exclusive) in the real popup,
//   using the exact selector + compareDocumentPosition range from the K72
//   task brief:
//     #main-section :is(button,a[href],input,select,textarea,[tabindex]):not(:disabled)
//     filtered by offsetParent !== null, ranged via compareDocumentPosition
//     against #tags-input (must FOLLOW it) and #private-check (must PRECEDE it)
//   across five states:
//     1. popup just opened, suggest request not returned yet (route held)
//     2. suggest returned (16 chips: 8 popular + 8 recommended), no tags added
//     3. 4 tags added, matching 4 popular chips -> those 4 disabled
//        (syncSuggestTagStates), same as the brief's "3-5 tags added"
//     4. AI tags rendered on top of state 3 (8 chips)
//     5. same as state 4, plus 3 tag presets configured (#tag-presets)
//     6. same as state 5, but the AI chips re-rendered from CACHE
//        (renderAITags(..., true)), which additionally appends the "cached"
//        hint's two .regen-link anchors inside #ai-suggest-tags
//
// WHY THE REAL TOOLBAR POPUP, NOT qa-drive's page-mode
//   qa-drive's drivePopupPage() opens popup.html as a plain Playwright page.
//   In that mode chrome.tabs.query({active:true, currentWindow:true}) returns
//   the popup.html tab ITSELF (its own chrome-extension:// URL) as the
//   "current tab" -- there is no other tab to be active over. popup.js then
//   takes the isUnsupportedUrl branch (popup.js ~line 540: url doesn't start
//   with http(s)://), which adds `.unsupported-url` to #main-section. Per
//   popup.css:610 that CSS class hides EVERY #main-section .form-body child
//   except #url-warning/#status-msg/.feedback-card -- so #tags-input,
//   #presets-row, #suggest-row, #ai-suggest-tags and the #private-check
//   checkbox are ALL display:none in page-mode. There is nothing to count.
//   This probe instead drives the REAL toolbar popup via
//   chrome.action.openPopup() + a CDP Target attach (lifted from
//   scripts/qa-drive.mjs's drivePopup(), itself lifted from
//   scripts/perf-cold-sample.mjs), with an "active" tab pointing at a fixture
//   http:// page so pageInfo.url is a supported URL and the whole form
//   renders normally.
//
// WHY renderAITags() IS CALLED DIRECTLY (no AI mock server)
//   State 4/5 only need the AI chip DOM shape, not a real AI round-trip.
//   renderAITags(tags, fromCache) is a plain synchronous function; calling it
//   directly via CDP Runtime.evaluate against the popup's own global scope
//   (popup.js/popup-tags.js/popup-ai.js are classic <script defer> tags that
//   share one global lexical scope -- `settings`, `currentTags`,
//   `renderAITags`, `addTag`, `setupTagPresets` are all reachable as bare
//   identifiers from an injected script) reaches the exact same DOM a real
//   "AI tags returned" moment would produce, without needing a chat-
//   completions mock. The task brief explicitly sanctions this fallback.
//
// USAGE
//   node scripts/probe-tab-stops.mjs
// PREREQUISITES (same as scripts/qa-drive.mjs)
//   cd .qa-scan && npm install && npx playwright install chromium
// Requires a display (headed Chromium only -- page-mode's headless path
// cannot see the tags UI at all per the note above). This repo's dev
// environment already has DISPLAY set.

import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, "..");
const QA_SCAN = resolve(REPO, ".qa-scan");
const TIMEOUT_MS = 15_000;

let chromium;
try {
  const req = createRequire(resolve(QA_SCAN, "package.json"));
  ({ chromium } = req("playwright"));
} catch {
  console.error("[probe-tab-stops] playwright not found. Install: cd .qa-scan && npm install && npx playwright install chromium");
  process.exit(2);
}

// ---- Fixtures ----
const FAKE_TOKEN = "qa:0000000000000000000000000000000000000000"; // username "qa"
const ARTICLE_URL = "http://127.0.0.1:43123/probe-tab-stops-article";
const ARTICLE_TITLE = "K72 tab-stop probe fixture article";
const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>${ARTICLE_TITLE}</title></head><body><main><h1>${ARTICLE_TITLE}</h1><p>Fixed local page, only used so the popup has a supported http(s) "current tab".</p></main></body></html>`;

// 8 popular + 8 recommended = 16 unique suggest chips -- inside the "常见
// 十余到二十余个" range the K72 brief describes, without depending on any
// real account's real tag data.
const POPULAR_TAGS = Array.from({ length: 8 }, (_, i) => `pop-tag-${i + 1}`);
const RECOMMENDED_TAGS = Array.from({ length: 8 }, (_, i) => `rec-tag-${i + 1}`);
const AI_TAGS = Array.from({ length: 8 }, (_, i) => `ai-tag-${i + 1}`);
// State 3: 4 tags added, chosen to exactly match 4 of the popular chips so
// syncSuggestTagStates() disables (removes from the tab sequence) those 4 --
// this is the brief's "3-5 tags added (so chips are disabled)" state.
const ADDED_TAGS = POPULAR_TAGS.slice(0, 4);
const PRESETS_RAW = [
  "预设A: preset-a1,preset-a2",
  "预设B: preset-b1,preset-b2",
  "预设C: preset-c1,preset-c2",
].join("\n");

let releaseSuggestGate = null;
const suggestGate = new Promise((res) => { releaseSuggestGate = res; });

const PINBOARD_GET_FIXTURES = new Map([
  ["/v1/posts/get", '{"date":"2026-01-01T00:00:00Z","user":"qa","posts":[]}'],
  ["/v1/posts/recent", '{"date":"2026-01-01T00:00:00Z","user":"qa","posts":[]}'],
  ["/v1/tags/get", "{}"],
  ["/v1/user/api_token", '{"result":"0000000000000000000000000000000000000000"}'],
]);

async function installRoutes(context) {
  await context.route(/^https?:\/\//, async (route) => {
    const request = route.request();
    let url;
    try {
      url = new URL(request.url());
    } catch {
      await route.abort("blockedbyclient");
      return;
    }
    try {
      if (request.url() === ARTICLE_URL) {
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: ARTICLE_HTML });
        return;
      }
      if (url.hostname === "api.pinboard.in") {
        if (url.pathname === "/v1/posts/suggest") {
          // Held until the probe explicitly releases it -- this is what lets
          // state 1 ("suggest not returned yet") and state 2 be captured as
          // two distinct, deterministic moments instead of racing a real
          // network response.
          await suggestGate;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([{ popular: POPULAR_TAGS }, { recommended: RECOMMENDED_TAGS }]),
          });
          return;
        }
        const body = request.method() === "GET" ? PINBOARD_GET_FIXTURES.get(url.pathname) : null;
        if (body) {
          await route.fulfill({ status: 200, contentType: "application/json", body });
          return;
        }
        await route.abort("blockedbyclient");
        return;
      }
      await route.abort("blockedbyclient");
    } catch (e) {
      console.warn(`[probe-tab-stops] route handler: ${e.message}`);
    }
  });
}

// ---- Launch (subset of qa-drive.mjs's LAUNCH_ARGS; no AI/dictionary host
// permission grant needed here -- AI chips are injected directly, see header) ----
const LAUNCH_ARGS = [
  `--disable-extensions-except=${REPO}`,
  `--load-extension=${REPO}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--metrics-recording-only",
  "--no-pings",
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
];

function launchContext(profile) {
  return chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(),
    headless: false,
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 900 },
    args: LAUNCH_ARGS,
  });
}

async function getWorker(context) {
  const existing = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  if (existing) return existing;
  return context.waitForEvent("serviceworker", {
    predicate: (w) => w.url().startsWith("chrome-extension://"),
    timeout: TIMEOUT_MS,
  });
}

// ---- Real toolbar popup via CDP (lifted from scripts/qa-drive.mjs's
// createTargetSession/drivePopup, itself lifted from scripts/perf-cold-sample.mjs) ----
function createTargetSession(browserCdp, sessionId) {
  let commandId = 0;
  const pending = new Map();
  const eventHandlers = new Set();
  const onMessage = (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    for (const handler of eventHandlers) handler(message);
  };
  browserCdp.on("Target.receivedMessageFromTarget", onMessage);
  return {
    onEvent(handler) { eventHandlers.add(handler); },
    async send(method, params = {}) {
      const id = ++commandId;
      const reply = new Promise((resolveReply, rejectReply) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectReply(new Error(`${method} timed out`));
        }, TIMEOUT_MS);
        pending.set(id, { resolve: resolveReply, reject: rejectReply, timer });
      });
      await browserCdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) });
      return reply;
    },
    close() {
      browserCdp.off("Target.receivedMessageFromTarget", onMessage);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("target session closed")); }
      pending.clear();
    },
  };
}

async function openToolbarPopup(worker, extId, browserCdp) {
  const popupUrl = `chrome-extension://${extId}/popup.html`;
  const found = new Promise((resolveFound, rejectFound) => {
    const timer = setTimeout(() => rejectFound(new Error("popup target not seen")), TIMEOUT_MS);
    const onTarget = ({ targetInfo }) => {
      if (targetInfo.type === "page" && targetInfo.url === popupUrl) {
        clearTimeout(timer);
        browserCdp.off("Target.targetCreated", onTarget);
        browserCdp.off("Target.targetInfoChanged", onTarget);
        resolveFound(targetInfo);
      }
    };
    browserCdp.on("Target.targetCreated", onTarget);
    browserCdp.on("Target.targetInfoChanged", onTarget);
  });
  // chrome.action.openPopup() rejects with "Could not find an active browser
  // window" when called before the freshly-launched headed window has picked
  // up OS-level focus (observed under this WSLg display on the very first
  // call after launch) -- retry with backoff rather than fail the whole run.
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await worker.evaluate((timeout) => Promise.race([
        chrome.action.openPopup(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("openPopup timed out")), timeout)),
      ]), TIMEOUT_MS);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`[probe-tab-stops] openPopup attempt ${attempt + 1} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  if (lastErr) throw lastErr;
  const target = await found;
  const { sessionId } = await browserCdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
  const session = createTargetSession(browserCdp, sessionId);
  session.onEvent((message) => {
    if (message.method === "Runtime.exceptionThrown") {
      console.warn(`[probe-tab-stops] popup exception: ${message.params?.exceptionDetails?.exception?.description || "unknown"}`);
    }
  });
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  return { session, targetId: target.targetId };
}

const READY_EXPR = `(() => {
  const main = document.getElementById("main-section");
  const tags = document.getElementById("tags-input");
  const suggestRow = document.getElementById("suggest-row");
  return !!(main && !main.classList.contains("hidden") && !main.classList.contains("unsupported-url")
    && tags && suggestRow && !suggestRow.classList.contains("hidden"));
})()`;

async function waitReady(session) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const r = await session.send("Runtime.evaluate", { expression: READY_EXPR, returnByValue: true });
    if (r.result?.value === true) return;
    if (Date.now() > deadline) throw new Error("popup did not become ready (main-section hidden or stuck on .unsupported-url)");
    await new Promise((r2) => setTimeout(r2, 100));
  }
}

// Exact selector + compareDocumentPosition range from the K72 task brief.
const COUNT_EXPR = `(() => {
  const s = document.getElementById('tags-input');
  const e = document.getElementById('private-check');
  if (!s || !e) return { error: 'markers-not-found' };
  const all = Array.from(document.querySelectorAll('#main-section :is(button,a[href],input,select,textarea,[tabindex]):not(:disabled)'));
  // tabindex="-1" is programmatically focusable but is NOT a tab stop, so it
  // cannot count toward a tab-stop total. This filter was added when K72 乙
  // landed (opt-wave C task 16) and the chip groups started using it; it is a
  // no-op on the pre-K72 baseline this probe first recorded, because the only
  // tabindex="-1" in popup.html is #batch-progress, which sits AFTER
  // #private-check and so was never inside the measured range. Without it the
  // probe measures "focusable elements", not the thing it is named for.
  const inRange = all.filter((el) => el.offsetParent !== null
    && el.getAttribute('tabindex') !== '-1'
    && (s.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
    && (e.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING));
  return {
    count: inRange.length,
    elements: inRange.map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: (el.className || '').toString().trim() || null,
      text: (el.textContent || '').trim().slice(0, 24),
    })),
  };
})()`;

async function measure(session, label) {
  const r = await session.send("Runtime.evaluate", { expression: COUNT_EXPR, returnByValue: true });
  const value = r.result?.value;
  if (!value || value.error) throw new Error(`measure(${label}) failed: ${JSON.stringify(value)}`);
  console.log(`[probe-tab-stops] ${label}: ${value.count} stops`);
  return { label, ...value };
}

async function evalInPopup(session, expression) {
  const r = await session.send("Runtime.evaluate", { expression });
  if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails)}`);
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "pbp-probe-tabstops-"));
  const results = [];
  let context = null;
  let browserCdp = null;
  let session = null;
  let active = null;
  try {
    context = await launchContext(profile);
    await installRoutes(context);
    const worker = await getWorker(context);
    const extId = new URL(worker.url()).hostname;
    console.log(`[probe-tab-stops] extension: ${extId}`);
    await new Promise((r) => setTimeout(r, 800)); // let the SW finish its first tick before we poke storage

    await worker.evaluate(async (token) => {
      if (typeof primeSettings === "function") await primeSettings();
      await chrome.storage.local.set({
        optSyncEnabled: false,
        syncApiKeys: false,
        pinboardToken: obfuscateKey(token),
        optShowSuggestTags: true,
        optAiAutoTags: false,
      });
    }, FAKE_TOKEN);

    active = await context.newPage();
    await active.goto(ARTICLE_URL, { waitUntil: "load", timeout: TIMEOUT_MS });
    await active.bringToFront();

    browserCdp = await context.browser().newBrowserCDPSession();
    await browserCdp.send("Target.setDiscoverTargets", { discover: true });
    ({ session } = await openToolbarPopup(worker, extId, browserCdp));
    await waitReady(session);
    await new Promise((r) => setTimeout(r, 200));

    // ---- State 1: just opened, suggest not yet returned (gate held) ----
    results.push(await measure(session, "1-just-opened-suggest-pending"));

    // ---- State 2: suggest returned (16 chips), no tags added ----
    releaseSuggestGate();
    await new Promise((r) => setTimeout(r, 400));
    results.push(await measure(session, "2-suggest-returned-no-tags"));

    // ---- State 3: 4 tags added, matching chips disabled ----
    for (const tag of ADDED_TAGS) {
      await evalInPopup(session, `addTag(${JSON.stringify(tag)});`);
    }
    results.push(await measure(session, "3-tags-added-matching-chips-disabled"));

    // ---- State 4: AI tags rendered (8 chips) on top of state 3 ----
    await evalInPopup(session, `renderAITags(${JSON.stringify(AI_TAGS)}, false);`);
    results.push(await measure(session, "4-ai-tags-rendered"));

    // ---- Row 5: state 4 + 3 tag presets configured ----
    // syncSuggestTagStates() is NOT probe-only bookkeeping: popup.js calls it
    // on the line immediately after setupTagPresets() during init (K72 乙 --
    // #tag-presets has no render path of its own, so it joins the roving
    // maintenance through that single point). This probe injects presets
    // long after init, so it has to reproduce that pair or it would be
    // measuring a DOM state the shipped popup never actually reaches.
    await evalInPopup(session, `settings.tagPresets = ${JSON.stringify(PRESETS_RAW)}; setupTagPresets(); syncSuggestTagStates();`);
    results.push(await measure(session, "5-state4-plus-3-presets"));

    // ---- State 6: the AI chips re-rendered from CACHE (fromCache=true) ----
    // The branch a returning user meets most: renderAITags then also appends a
    // .cache-hint-wrap holding two .regen-link <a href="#"> INSIDE
    // #ai-suggest-tags, i.e. inside the toolbar. They are focusables the
    // fromCache=false path never produces, so states 4/5 cannot see them and
    // this row is what proves they joined the ring instead of re-adding stops.
    await evalInPopup(session, `renderAITags(${JSON.stringify(AI_TAGS)}, true);`);
    results.push(await measure(session, "6-ai-tags-from-cache-regen-links"));
  } finally {
    try { if (session) await session.send("Runtime.evaluate", { expression: "window.close()" }); } catch { /* ignore */ }
    if (session) session.close();
    try { if (browserCdp) await browserCdp.detach(); } catch { /* ignore */ }
    try { if (active) await active.close(); } catch { /* ignore */ }
    await context?.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }

  console.log("\n[probe-tab-stops] summary:");
  for (const r of results) console.log(`  ${r.label}: ${r.count}`);

  const outPath = join(REPO, ".superpowers/sdd/2026-09-17-opt-waveB/task-5-raw-counts.json");
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`[probe-tab-stops] raw counts + element lists written to ${outPath}`);
  } catch (e) {
    console.warn(`[probe-tab-stops] could not write raw counts: ${e.message}`);
  }
}

main().catch((e) => {
  console.error(`[probe-tab-stops] fatal: ${e.message}`);
  process.exitCode = 2;
});
