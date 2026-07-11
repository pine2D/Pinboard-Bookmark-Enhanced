#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, "..");
const QA_SCAN = resolve(REPO, ".qa-scan");
const DEFAULT_OUT_DIR = "/tmp/pbp-batch5-perf";
const ACTIVE_URL = "http://127.0.0.1:43123/batch5-active";
const ACTIVE_TITLE = "Batch 5 synthetic page";
const PREVIEW_TITLE = "Batch 5 中文冷启动样本";
const PREVIEW_URL = "https://example.invalid/batch5-preview";
const PREVIEW_KEY = "batch5-perf-preview";
const ALL_SCENARIOS = ["popup", "options", "preview", "worker"];
const TIMEOUT_MS = 15_000;

const SYNTHETIC_MARKDOWN = [
  `# ${PREVIEW_TITLE}`,
  "这是固定的中文合成文章，只用于本地冷启动测量，不含真实书签或私人信息。",
  ...Array.from({ length: 25 }, (_, index) => [
    `## 固定章节 ${index + 1}`,
    `第 ${index + 1} 段用于稳定正文布局。它包含中文、Latin text 和数字 ${index + 1}，不引用任何远程资源。`.repeat(3),
  ]).flat(),
].join("\n\n");

function usage() {
  return `Usage: node scripts/perf-cold-sample.mjs [options]

  --runs <n>              independent cold processes per scenario (default: 20)
  --label <name>          output prefix, e.g. baseline or repeat (default: baseline)
  --out-dir <path>        evidence directory (default: ${DEFAULT_OUT_DIR})
  --scenarios <list>      popup,options,preview,worker (sw aliases worker)
  --headless              run without Popup (Popup needs an active headed desktop)
  --keep-profiles         preserve generated template/sample profiles
  --self-test             run pure parser/statistics checks only
  --help                  show this help

Popup requires an active headed desktop. With --headless, omit the popup scenario.
`;
}

function parseArgs(argv) {
  const config = {
    runs: 20,
    label: "baseline",
    outDir: DEFAULT_OUT_DIR,
    scenarios: [...ALL_SCENARIOS],
    headless: false,
    keepProfiles: false,
    selfTest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--headless") config.headless = true;
    else if (arg === "--keep-profiles") config.keepProfiles = true;
    else if (arg === "--self-test") config.selfTest = true;
    else if (arg === "--help" || arg === "-h") config.help = true;
    else if (["--runs", "--label", "--out-dir", "--scenarios"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--runs") config.runs = Number(value);
      if (arg === "--label") config.label = value;
      if (arg === "--out-dir") config.outDir = value;
      if (arg === "--scenarios") {
        config.scenarios = [...new Set(value.split(",").filter(Boolean).map((name) => name === "sw" ? "worker" : name))];
      }
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(config.runs) || config.runs < 1) throw new Error("--runs must be a positive integer");
  if (!/^[A-Za-z0-9._-]+$/.test(config.label)) throw new Error("--label may contain only letters, numbers, dot, underscore, and hyphen");
  if (!config.scenarios.length || config.scenarios.some((name) => !ALL_SCENARIOS.includes(name))) {
    throw new Error(`--scenarios must use: ${ALL_SCENARIOS.join(",")}`);
  }
  if (config.headless && config.scenarios.includes("popup")) {
    throw new Error("Popup requires an active headed desktop; omit popup or run headed");
  }
  config.outDir = resolve(config.outDir);
  return config;
}

function median(sorted) {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function roundMetric(value) {
  return value == null ? null : Math.round(value * 1000) / 1000;
}

function metricStats(values, expected) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const p50 = median(sorted);
  const deviations = p50 == null ? [] : sorted.map((value) => Math.abs(value - p50)).sort((a, b) => a - b);
  return {
    n: sorted.length,
    failures: expected - sorted.length,
    p50: roundMetric(p50),
    p90: roundMetric(percentile(sorted, 0.9)),
    max: roundMetric(sorted.length ? sorted[sorted.length - 1] : null),
    mad: roundMetric(median(deviations)),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(`self-test failed: ${message}`);
}

function runSelfTest() {
  const values = [1, 2, 3, 4];
  const stats = metricStats(values, 5);
  assert(stats.n === 4 && stats.failures === 1, "sample counts");
  assert(stats.p50 === 2.5 && stats.p90 === 3.7 && stats.max === 4 && stats.mad === 1, "summary math");
  const parsed = parseArgs(["--runs", "1", "--scenarios", "options,sw", "--headless"]);
  assert(parsed.runs === 1 && parsed.headless && parsed.scenarios.join(",") === "options,worker", "CLI parsing");
  assert(SYNTHETIC_MARKDOWN.split(/\n\n+/).length === 52, "52 synthetic Markdown blocks");
  assert((SYNTHETIC_MARKDOWN.match(/^## /gm) || []).length === 25, "25 synthetic TOC headings");
  console.log("[perf-cold] self-test PASS");
}

let config;
try {
  config = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`[perf-cold] ${error.message}`);
  console.error(usage());
  process.exit(2);
}

if (config.help) {
  console.log(usage());
  process.exit(0);
}
if (config.selfTest) {
  runSelfTest();
  process.exit(0);
}

let chromium;
try {
  const require = createRequire(resolve(QA_SCAN, "package.json"));
  ({ chromium } = require("playwright"));
} catch {
  console.error("[perf-cold] Playwright not found under .qa-scan");
  process.exit(2);
}

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
  "--lang=zh-CN",
  "--host-resolver-rules=MAP * ~NOTFOUND",
];

function launchContext(profile) {
  return chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(),
    headless: config.headless,
    locale: "zh-CN",
    colorScheme: "light",
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 900 },
    args: LAUNCH_ARGS,
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitUntil(check, message, timeout = TIMEOUT_MS, interval = 10) {
  const deadline = performance.now() + timeout;
  let lastError = null;
  while (performance.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

function safeError(error) {
  return {
    name: error?.name || "Error",
    message: String(error?.message || error || "unknown failure"),
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const PINBOARD_FIXTURES = new Map([
  ["/v1/tags/get", "{}"],
  ["/v1/posts/get", '{"posts":[]}'],
  ["/v1/posts/recent", '{"posts":[]}'],
  ["/v1/posts/suggest", "[{},{}]"],
]);

async function installClosedNetwork(context, records) {
  await context.route(/^https?:\/\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const record = { method: request.method(), origin: url.origin, path: url.pathname };
    if (request.url() === ACTIVE_URL && request.method() === "GET") {
      records.push({ ...record, disposition: "local-fixture" });
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="zh-CN"><head><title>${ACTIVE_TITLE}</title></head><body><main><h1>${ACTIVE_TITLE}</h1><p>固定本地活动页，不含任何外部资源。</p></main></body></html>`,
      });
      return;
    }
    if (url.protocol === "https:" && url.hostname === "api.pinboard.in") {
      const body = request.method() === "GET" ? PINBOARD_FIXTURES.get(url.pathname) : null;
      if (body == null) {
        records.push({ ...record, disposition: "blocked-pinboard" });
        await route.abort("blockedbyclient");
        return;
      }
      records.push({ ...record, disposition: "pinboard-fixture" });
      await route.fulfill({ status: 200, contentType: "application/json", body });
      return;
    }
    records.push({ ...record, disposition: "blocked-external" });
    await route.abort("blockedbyclient");
  });
}

async function getExtensionWorker(context) {
  const existing = context.serviceWorkers().find((worker) => worker.url().startsWith("chrome-extension://"));
  if (existing) return existing;
  return context.waitForEvent("serviceworker", {
    predicate: (worker) => worker.url().startsWith("chrome-extension://"),
    timeout: TIMEOUT_MS,
  });
}

function readyExpression(scenario) {
  if (scenario === "popup") {
    return `(() => {
      const main = document.getElementById("main-section");
      const url = document.getElementById("url-input");
      const title = document.getElementById("title-input");
      const tags = document.getElementById("tags-input");
      const submit = document.getElementById("submit-btn");
      const controls = [url, title, tags, submit];
      return !!(main && !main.classList.contains("hidden") && controls.every((control) => control && !control.disabled)
        && url.value === ${JSON.stringify(ACTIVE_URL)} && title.value === ${JSON.stringify(ACTIVE_TITLE)});
    })()`;
  }
  throw new Error(`no CDP ready expression for ${scenario}`);
}

function pageReady(args) {
  if (args.scenario === "options") {
    const panel = document.getElementById("panel-general");
    return !!panel && panel.classList.contains("active")
      && document.getElementById("opt-lang")?.value === "zh_CN"
      && document.getElementById("opt-theme")?.value === "light"
      && document.getElementById("opt-ai-provider")?.value === "gemini"
      && document.getElementById("opt-pinboard-token")?.value === args.fakeToken
      && !!document.getElementById("auto-save-status")?.textContent.trim()
      && document.documentElement.lang === "zh-Hans";
  }
  if (args.scenario === "preview") {
    return document.getElementById("preview-title")?.textContent === args.previewTitle
      && document.querySelectorAll("#rendered-view [data-pb]").length === 52
      && document.querySelectorAll("#toc-list a").length === 25
      && /%/.test(document.getElementById("reading-stats")?.textContent || "")
      && document.documentElement.lang === "zh-Hans";
  }
  return false;
}

function intersectionGeometryProof({ selectors, timeout }) {
  return new Promise((resolveProof, rejectProof) => {
    const nodes = selectors.map((selector) => ({ selector, element: document.querySelector(selector) }));
    const missing = nodes.filter((item) => !item.element).map((item) => item.selector);
    if (missing.length) {
      rejectProof(new Error(`geometry proof missing: ${missing.join(", ")}`));
      return;
    }
    const pending = new Set(nodes.map((item) => item.element));
    const observed = new Map();
    let observer;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      observer?.disconnect();
    };
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const rect = entry.boundingClientRect;
        if (!(rect.width > 0 && rect.height > 0)) continue;
        pending.delete(entry.target);
        const item = nodes.find((candidate) => candidate.element === entry.target);
        if (item) observed.set(item.selector, { width: rect.width, height: rect.height });
      }
      if (pending.size) return;
      cleanup();
      resolveProof(selectors.map((selector) => ({ selector, ...observed.get(selector) })));
    });
    for (const item of nodes) observer.observe(item.element);
    timer = setTimeout(() => {
      const unresolved = nodes.filter((item) => pending.has(item.element)).map((item) => item.selector);
      cleanup();
      rejectProof(new Error(`geometry proof timed out: ${unresolved.join(", ")}`));
    }, timeout);
  });
}

function pagePerformance() {
  const navigation = performance.getEntriesByType("navigation")[0];
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  return {
    readyNowMs: performance.now(),
    responseEndMs: navigation?.responseEnd || null,
    domInteractiveMs: navigation?.domInteractive || null,
    domContentLoadedEventStartMs: navigation?.domContentLoadedEventStart || null,
    domContentLoadedEndMs: navigation?.domContentLoadedEventEnd || null,
    loadEndMs: navigation?.loadEventEnd || null,
    fcpMs: fcp?.startTime || null,
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
    resourceCount: performance.getEntriesByType("resource").length,
  };
}

async function afterPaint(page) {
  await page.evaluate(() => new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
}

async function platformFonts(cdp, selectors) {
  const report = {};
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  for (const [name, selector] of Object.entries(selectors)) {
    try {
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error("selector not found");
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      report[name] = { selector, fonts };
    } catch (error) {
      report[name] = { selector, error: error.message };
    }
  }
  return report;
}

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
      await browserCdp.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      });
      return reply;
    },
    close() {
      browserCdp.off("Target.receivedMessageFromTarget", onMessage);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("target session closed"));
      }
      pending.clear();
    },
  };
}

async function targetEvaluate(session, expression, awaitPromise = false) {
  const result = await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "target evaluation failed");
  return result.result.value;
}

function armPopupTarget(browserCdp, extensionId, previousIds) {
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  let done = false;
  let claimed = false;
  let onTarget;
  let rejectPromise;
  let timer;
  const removeListeners = () => {
    browserCdp.off("Target.targetCreated", onTarget);
    browserCdp.off("Target.targetInfoChanged", onTarget);
  };
  const cleanup = () => {
    clearTimeout(timer);
    removeListeners();
  };
  const promise = new Promise((resolveTarget, rejectTarget) => {
    rejectPromise = rejectTarget;
    const consider = async (target) => {
      if (claimed || target.type !== "page" || target.url !== popupUrl || previousIds.has(target.targetId)) return;
      claimed = true;
      removeListeners();
      let sessionId = null;
      let session = null;
      const detach = async () => {
        session?.close();
        if (sessionId) await browserCdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      };
      try {
        ({ sessionId } = await browserCdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: false }));
        if (done) { await detach(); return; }
        session = createTargetSession(browserCdp, sessionId);
        const pageErrors = [];
        session.onEvent((message) => {
          if (message.method === "Runtime.exceptionThrown") {
            pageErrors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "popup exception");
          }
        });
        await session.send("Runtime.enable");
        await session.send("Page.enable");
        if (done) { await detach(); return; }
        done = true;
        cleanup();
        resolveTarget({ target, session, pageErrors });
      } catch (error) {
        await detach();
        if (done) return;
        done = true;
        cleanup();
        rejectTarget(error);
      }
    };
    onTarget = ({ targetInfo }) => { void consider(targetInfo); };
    browserCdp.on("Target.targetCreated", onTarget);
    browserCdp.on("Target.targetInfoChanged", onTarget);
    browserCdp.send("Target.getTargets").then(({ targetInfos }) => {
      for (const target of targetInfos) void consider(target);
    }).catch((error) => {
      if (done) return;
      done = true;
      cleanup();
      rejectTarget(error);
    });
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      rejectTarget(new Error("toolbar popup target setup timed out"));
    }, TIMEOUT_MS);
  });
  return {
    promise,
    cancel(error) {
      if (done) return;
      done = true;
      cleanup();
      rejectPromise(error);
    },
  };
}

async function measurePopupOpen(activePage, worker, browserCdp, extensionId, phase, capture) {
  await activePage.bringToFront();
  const { targetInfos: before } = await browserCdp.send("Target.getTargets");
  const previousIds = new Set(before.filter((target) => target.url.includes("/popup.html")).map((target) => target.targetId));
  const armed = armPopupTarget(browserCdp, extensionId, previousIds);
  const wallStart = performance.now();
  let openPopupPromiseMs;
  let attached;
  try {
    [openPopupPromiseMs, attached] = await Promise.all([
      worker.evaluate(async (timeout) => {
        const start = performance.now();
        let timer;
        try {
          await Promise.race([
            chrome.action.openPopup(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("openPopup timed out")), timeout); }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        return performance.now() - start;
      }, TIMEOUT_MS),
      armed.promise,
    ]);
  } catch (error) {
    armed.cancel(error);
    await armed.promise.catch(() => {});
    throw error;
  }
  const { target, session, pageErrors } = attached;
  let measurement = null;
  try {
    const expression = readyExpression("popup");
    await waitUntil(async () => targetEvaluate(session, expression), "toolbar popup did not become ready");
    const geometryProof = await targetEvaluate(session, `(${intersectionGeometryProof.toString()})(${JSON.stringify({
      selectors: ["#main-section", "#url-input", "#title-input", "#tags-input", "#submit-btn"],
      timeout: TIMEOUT_MS,
    })})`, true);
    const wallReadyMs = performance.now() - wallStart;
    const readyNowMs = await targetEvaluate(session, "performance.now()");
    await waitUntil(async () => targetEvaluate(session, 'document.activeElement?.id === "tags-input"'), "toolbar popup form did not become usable");
    const formReadyWallMs = performance.now() - wallStart;
    const formReadyNowMs = await targetEvaluate(session, "performance.now()");
    await waitUntil(async () => targetEvaluate(session, 'document.readyState === "complete"'), "toolbar popup navigation did not complete");
    await targetEvaluate(session, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true);
    const timing = await targetEvaluate(session, `(${pagePerformance.toString()})()`);
    let screenshot = null;
    let fonts = null;
    if (capture) {
      const image = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      screenshot = join(config.outDir, `${config.label}-popup-cold.png`);
      writeFileSync(screenshot, Buffer.from(image.data, "base64"));
      fonts = await platformFonts(session, { latin: "#user-info a", cjkLabel: ".row .label", cjkControl: "#submit-btn" });
    }
    measurement = {
      phase,
      wallReadyMs,
      readyNowMs,
      formReadyWallMs,
      formReadyNowMs,
      openPopupPromiseMs,
      responseEndMs: timing.responseEndMs,
      domInteractiveMs: timing.domInteractiveMs,
      domContentLoadedEventStartMs: timing.domContentLoadedEventStartMs,
      domContentLoadedEndMs: timing.domContentLoadedEndMs,
      loadEndMs: timing.loadEndMs,
      fcpMs: timing.fcpMs,
      viewport: timing.viewport,
      resourceCount: timing.resourceCount,
      geometryProof,
      pageErrors,
      screenshot,
      fonts,
    };
    return measurement;
  } finally {
    let nativeRequestError = null;
    try {
      await targetEvaluate(session, "(() => { window.close(); return true; })()");
    } catch (error) {
      nativeRequestError = error.message;
    }
    const nativeClosed = await waitUntil(async () => {
      const { targetInfos } = await browserCdp.send("Target.getTargets");
      return !targetInfos.some((item) => item.targetId === target.targetId);
    }, "toolbar popup target did not close natively", 3_000).then(() => true).catch(() => false);
    let forcedClose = false;
    if (!nativeClosed) {
      forcedClose = true;
      await browserCdp.send("Target.closeTarget", { targetId: target.targetId });
      await waitUntil(async () => {
        const { targetInfos } = await browserCdp.send("Target.getTargets");
        return !targetInfos.some((item) => item.targetId === target.targetId);
      }, "toolbar popup target did not close after fallback", 3_000);
    }
    const activePageAlive = await activePage.evaluate((url) => document.readyState === "complete" && location.href === url, ACTIVE_URL).catch(() => false);
    session.close();
    if (measurement) {
      measurement.closeProof = { nativeClosed, forcedClose, activePageAlive, nativeRequestError };
    }
  }
}

async function seedPreview(sender, key) {
  await sender.evaluate(async ({ storageKey, markdown, title, url }) => {
    await chrome.storage.local.set({
      [`md_preview_data_${storageKey}`]: {
        markdown,
        contentHtml: "",
        title,
        url,
        baseUrl: url,
        tags: ["batch5-perf"],
        tokens: 0,
        hasApiKey: false,
        source: "local",
        math: false,
        forum: false,
        ts: Date.now(),
      },
    });
  }, { storageKey: key, markdown: SYNTHETIC_MARKDOWN, title: PREVIEW_TITLE, url: PREVIEW_URL });
}

async function measurePageOpen(context, extensionId, scenario, phase, capture, fakeToken, existingPage = null, reload = false) {
  const page = existingPage || await context.newPage();
  const ownsPage = !existingPage;
  const pageErrors = [];
  const consoleErrors = [];
  const onPageError = (error) => pageErrors.push(error.message);
  const onConsole = (message) => { if (message.type() === "error") consoleErrors.push(message.text()); };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  const url = scenario === "options"
    ? `chrome-extension://${extensionId}/options.html#general`
    : `chrome-extension://${extensionId}/md-preview.html?k=${PREVIEW_KEY}`;
  await page.bringToFront();
  const wallStart = performance.now();
  try {
    if (reload) await page.reload({ waitUntil: "commit", timeout: TIMEOUT_MS });
    else await page.goto(url, { waitUntil: "commit", timeout: TIMEOUT_MS });
    await page.waitForFunction(pageReady, {
      scenario,
      fakeToken,
      previewTitle: PREVIEW_TITLE,
    }, { polling: "raf", timeout: TIMEOUT_MS });
    const geometryProof = scenario === "options" ? await page.evaluate(intersectionGeometryProof, {
      selectors: ["#panel-general", "#opt-lang", "#opt-pinboard-token", "#auto-save-status"],
      timeout: TIMEOUT_MS,
    }) : null;
    const wallReadyMs = performance.now() - wallStart;
    const readyNowMs = await page.evaluate(() => performance.now());
    await page.waitForLoadState("load", { timeout: TIMEOUT_MS });
    await afterPaint(page);
    const timing = await page.evaluate(pagePerformance);
    let screenshot = null;
    let fonts = null;
    if (capture) {
      screenshot = join(config.outDir, `${config.label}-${scenario}-cold.png`);
      await page.screenshot({ path: screenshot, fullPage: false });
      const cdp = await context.newCDPSession(page);
      fonts = await platformFonts(cdp, scenario === "options"
        ? { latin: "#panel-general .hint a", cjk: "#panel-general .section-title" }
        : { latin: "#preview-url", cjk: "#rendered-view p" });
      await cdp.detach();
    }
    return {
      phase,
      wallReadyMs,
      readyNowMs,
      responseEndMs: timing.responseEndMs,
      domInteractiveMs: timing.domInteractiveMs,
      domContentLoadedEventStartMs: timing.domContentLoadedEventStartMs,
      domContentLoadedEndMs: timing.domContentLoadedEndMs,
      loadEndMs: timing.loadEndMs,
      fcpMs: timing.fcpMs,
      viewport: timing.viewport,
      resourceCount: timing.resourceCount,
      geometryProof,
      pageErrors,
      consoleErrors,
      screenshot,
      fonts,
    };
  } finally {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
    if (ownsPage) await page.close().catch(() => {});
  }
}

async function measureWorker(context, extensionId) {
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/options.html#general`, { waitUntil: "load", timeout: TIMEOUT_MS });
  const browserCdp = await context.browser().newBrowserCDPSession();
  const pageCdp = await context.newCDPSession(page);
  const scriptUrl = `chrome-extension://${extensionId}/background.js`;
  const versions = new Map();
  const transitions = [];
  const onVersions = ({ versions: updates }) => {
    for (const version of updates || []) {
      versions.set(version.versionId, version);
      if (version.scriptURL === scriptUrl) transitions.push({ versionId: version.versionId, runningStatus: version.runningStatus, status: version.status });
    }
  };
  pageCdp.on("ServiceWorker.workerVersionUpdated", onVersions);
  await pageCdp.send("ServiceWorker.enable");
  let destroyedTargetId = null;
  const onDestroyed = ({ targetId }) => { if (targetId === destroyedTargetId) destroyedTargetId = `destroyed:${targetId}`; };
  browserCdp.on("Target.targetDestroyed", onDestroyed);
  try {
    const running = await waitUntil(() => [...versions.values()].find((version) => version.scriptURL === scriptUrl && version.runningStatus === "running"), "service worker was not running");
    const initialWorker = await getExtensionWorker(context);
    const marker = `batch5-${Date.now()}-${Math.random()}`;
    const initialState = await initialWorker.evaluate((value) => {
      globalThis.__pbpPerfColdMarker = value;
      return { marker: globalThis.__pbpPerfColdMarker, timeOrigin: performance.timeOrigin };
    }, marker);
    const { targetInfos } = await browserCdp.send("Target.getTargets");
    const initialTarget = targetInfos.find((target) => target.type === "service_worker" && target.url === scriptUrl);
    if (!initialTarget) throw new Error("service worker target not found before stop");
    destroyedTargetId = initialTarget.targetId;
    await pageCdp.send("ServiceWorker.stopWorker", { versionId: running.versionId });
    await waitUntil(() => versions.get(running.versionId)?.runningStatus === "stopped", "service worker did not report stopped");
    const targetDisappeared = await waitUntil(async () => {
      if (String(destroyedTargetId).startsWith("destroyed:")) return true;
      const current = await browserCdp.send("Target.getTargets");
      return !current.targetInfos.some((target) => target.targetId === initialTarget.targetId);
    }, "service worker target did not disappear");

    const coldStart = performance.now();
    const coldResponse = await page.evaluate(async (timeout) => {
      let timer;
      try {
        return await Promise.race([
          chrome.runtime.sendMessage({ type: "get_offline_queue" }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("cold worker message timed out")), timeout); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }, TIMEOUT_MS);
    const coldRoundTripMs = performance.now() - coldStart;
    if (!coldResponse?.ok || !Array.isArray(coldResponse.queue)) throw new Error("cold get_offline_queue returned an invalid response");

    const restartedState = await waitUntil(async () => {
      for (const worker of context.serviceWorkers().filter((item) => item.url() === scriptUrl).reverse()) {
        try {
          const state = await worker.evaluate(() => ({
            marker: globalThis.__pbpPerfColdMarker ?? null,
            timeOrigin: performance.timeOrigin,
          }));
          if (state.marker === null && state.timeOrigin !== initialState.timeOrigin) return state;
        } catch {}
      }
      return null;
    }, "service worker execution context was not replaced");
    const runningRestored = await waitUntil(() => [...versions.values()].find((version) => version.scriptURL === scriptUrl && version.runningStatus === "running"), "service worker did not return to running");
    const targetRestored = await waitUntil(async () => {
      const current = await browserCdp.send("Target.getTargets");
      return current.targetInfos.find((target) => target.type === "service_worker" && target.url === scriptUrl);
    }, "service worker target did not return");

    const warmStart = performance.now();
    const warmResponse = await page.evaluate(async (timeout) => {
      let timer;
      try {
        return await Promise.race([
          chrome.runtime.sendMessage({ type: "get_offline_queue" }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("warm worker message timed out")), timeout); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }, TIMEOUT_MS);
    const warmRoundTripMs = performance.now() - warmStart;
    if (!warmResponse?.ok || !Array.isArray(warmResponse.queue)) throw new Error("warm get_offline_queue returned an invalid response");

    return {
      cold: { roundTripMs: coldRoundTripMs, queueLength: coldResponse.queue.length },
      warm: { roundTripMs: warmRoundTripMs, queueLength: warmResponse.queue.length },
      proof: {
        runningBefore: running.runningStatus === "running",
        stopped: true,
        targetDisappeared: !!targetDisappeared,
        markerCleared: restartedState.marker === null,
        timeOriginChanged: restartedState.timeOrigin !== initialState.timeOrigin,
        runningRestored: runningRestored.runningStatus === "running",
        targetRestored: !!targetRestored,
        initialTimeOrigin: initialState.timeOrigin,
        restartedTimeOrigin: restartedState.timeOrigin,
        initialTargetId: initialTarget.targetId,
        restoredTargetId: targetRestored.targetId,
        transitions,
      },
      pageErrors,
    };
  } finally {
    browserCdp.off("Target.targetDestroyed", onDestroyed);
    await pageCdp.send("ServiceWorker.disable").catch(() => {});
    await pageCdp.detach().catch(() => {});
    await browserCdp.detach().catch(() => {});
    await page.close().catch(() => {});
  }
}

async function prepareTemplate(profile) {
  const network = [];
  const started = performance.now();
  const context = await launchContext(profile);
  await installClosedNetwork(context, network);
  try {
    const worker = await getExtensionWorker(context);
    const extensionId = new URL(worker.url()).hostname;
    const fakeToken = "perf:0000000000000000000000000000000000000000";
    await worker.evaluate(async ({ token }) => {
      if (typeof primeSettings === "function") await primeSettings();
      await chrome.storage.local.set({
        optSyncEnabled: false,
        syncApiKeys: false,
        pinboardToken: obfuscateKey(token),
        optLang: "zh_CN",
        optTheme: "light",
        themePresetKey: "",
        optPopupFollowTheme: true,
        popupWidth: 550,
        aiProvider: "gemini",
        optAiAutoTags: false,
        previewAiEnabled: false,
        previewSkimEnabled: false,
      });
    }, { token: fakeToken });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html#general`, { waitUntil: "load", timeout: TIMEOUT_MS });
    await page.evaluate(async () => {
      const response = await fetch(chrome.runtime.getURL("_locales/zh_CN/messages.json"));
      const messages = await response.json();
      localStorage.setItem("pp-sync-enabled", "0");
      localStorage.setItem("pp-i18n-lang", "zh_CN");
      localStorage.setItem("pp-i18n-msgs", JSON.stringify(messages));
      localStorage.setItem("pp-logged-in", "1");
      localStorage.setItem("pp-theme", "light");
      localStorage.setItem("pp-theme-preset", "");
      localStorage.setItem("pp-theme-follow", "1");
      localStorage.setItem("pp-popup-width", "550");
      localStorage.setItem("md-preview-theme", "light");
    });
    await page.goto("about:blank", { waitUntil: "load" });
    return {
      extensionId,
      fakeToken,
      chromiumVersion: context.browser()?.version() || null,
      navigator: await page.evaluate(() => ({ language: navigator.language, userAgent: navigator.userAgent, deviceScaleFactor: devicePixelRatio })),
      prepareMs: performance.now() - started,
      network,
    };
  } finally {
    await context.close();
  }
}

async function runSample(templateProfile, scenario, run, fakeToken) {
  const profile = join(profileRoot, `${String(run).padStart(2, "0")}-${scenario}`);
  cpSync(templateProfile, profile, { recursive: true, errorOnExist: true });
  const network = [];
  const launchStart = performance.now();
  let context = null;
  const sample = { scenario, run, cold: null, warm: null, proof: null, network, failure: null };
  try {
    context = await launchContext(profile);
    sample.launchMs = performance.now() - launchStart;
    await installClosedNetwork(context, network);
    const worker = await getExtensionWorker(context);
    const extensionId = new URL(worker.url()).hostname;
    if (scenario === "popup") {
      const active = context.pages()[0];
      if (!active) throw new Error("launch page not found");
      await active.goto(ACTIVE_URL, { waitUntil: "load", timeout: TIMEOUT_MS });
      const browserCdp = await context.browser().newBrowserCDPSession();
      await browserCdp.send("Target.setDiscoverTargets", { discover: true });
      try {
        sample.cold = await measurePopupOpen(active, worker, browserCdp, extensionId, "cold", run === 1);
        if (sample.cold.closeProof?.nativeClosed !== true || sample.cold.closeProof?.forcedClose || sample.cold.closeProof?.activePageAlive !== true) {
          throw new Error("cold toolbar Popup did not close natively");
        }
        sample.warm = await measurePopupOpen(active, worker, browserCdp, extensionId, "warm", false);
      } finally {
        await browserCdp.detach().catch(() => {});
      }
    } else if (scenario === "options") {
      const optionsPage = await context.newPage();
      try {
        sample.cold = await measurePageOpen(context, extensionId, scenario, "cold", run === 1, fakeToken, optionsPage);
        sample.warm = await measurePageOpen(context, extensionId, scenario, "warm", false, fakeToken, optionsPage, true);
      } finally {
        await optionsPage.close().catch(() => {});
      }
    } else if (scenario === "preview") {
      await seedPreview(worker, PREVIEW_KEY);
      sample.cold = await measurePageOpen(context, extensionId, scenario, "cold", run === 1, fakeToken);
      await seedPreview(worker, PREVIEW_KEY);
      sample.warm = await measurePageOpen(context, extensionId, scenario, "warm", false, fakeToken);
    } else {
      const result = await measureWorker(context, extensionId);
      sample.cold = result.cold;
      sample.warm = result.warm;
      sample.proof = result.proof;
      sample.pageErrors = result.pageErrors;
    }
  } catch (error) {
    sample.failure = safeError(error);
  } finally {
    await context?.close().catch(() => {});
    if (!config.keepProfiles) rmSync(profile, { recursive: true, force: true });
  }
  if (!sample.failure) {
    const hardMetrics = scenario === "worker"
      ? ["roundTripMs"]
      : ["wallReadyMs", "readyNowMs", "responseEndMs", "domInteractiveMs", "domContentLoadedEventStartMs", "domContentLoadedEndMs", "loadEndMs"];
    const missingMetrics = ["cold", "warm"].flatMap((phase) => hardMetrics
      .filter((metric) => !Number.isFinite(sample[phase]?.[metric]))
      .map((metric) => `${phase}.${metric}`));
    const environmentMismatches = scenario === "worker" || scenario === "popup" ? [] : ["cold", "warm"]
      .filter((phase) => sample[phase]?.viewport?.deviceScaleFactor !== 1)
      .map((phase) => `${phase}.viewport.deviceScaleFactor`);
    const lifecycleFailures = scenario !== "popup" ? [] : ["cold", "warm"]
      .filter((phase) => sample[phase]?.closeProof?.nativeClosed !== true || sample[phase]?.closeProof?.forcedClose || sample[phase]?.closeProof?.activePageAlive !== true)
      .map((phase) => `${phase}.closeProof`);
    const pageErrors = [
      ...(sample.pageErrors || []),
      ...(sample.cold?.pageErrors || []),
      ...(sample.warm?.pageErrors || []),
    ];
    const blocked = network.filter((entry) => entry.disposition.startsWith("blocked"));
    if (missingMetrics.length || environmentMismatches.length || lifecycleFailures.length || pageErrors.length || blocked.length) {
      sample.failure = {
        name: "ValidityError",
        message: `${missingMetrics.length} missing hard metric(s), ${environmentMismatches.length} environment mismatch(es), ${lifecycleFailures.length} popup lifecycle failure(s), ${pageErrors.length} page error(s), ${blocked.length} blocked external/write request(s)${missingMetrics.length || environmentMismatches.length || lifecycleFailures.length ? `: ${[...missingMetrics, ...environmentMismatches, ...lifecycleFailures].join(", ")}` : ""}`,
      };
    }
  }
  return sample;
}

const PAGE_METRICS = [
  "wallReadyMs",
  "readyNowMs",
  "responseEndMs",
  "domInteractiveMs",
  "domContentLoadedEventStartMs",
  "domContentLoadedEndMs",
  "loadEndMs",
  "fcpMs",
];

function summarize(samples) {
  const scenarios = {};
  for (const scenario of config.scenarios) {
    const group = samples.filter((sample) => sample.scenario === scenario);
    const valid = group.filter((sample) => !sample.failure);
    const metrics = scenario === "worker" ? ["roundTripMs"]
      : scenario === "popup" ? [...PAGE_METRICS, "formReadyWallMs", "formReadyNowMs"]
      : PAGE_METRICS;
    const summarizePhase = (phase) => Object.fromEntries(metrics.map((metric) => [
      metric,
      metricStats(valid.map((sample) => sample[phase]?.[metric]), group.length),
    ]));
    scenarios[scenario] = {
      requested: group.length,
      failures: group.filter((sample) => sample.failure).map((sample) => ({ run: sample.run, ...sample.failure })),
      cold: summarizePhase("cold"),
      warm: summarizePhase("warm"),
    };
  }
  return {
    schemaVersion: 1,
    label: config.label,
    generatedAt: new Date().toISOString(),
    scenarios,
  };
}

mkdirSync(config.outDir, { recursive: true });
const profileRoot = mkdtempSync(join(config.outDir, `.${config.label}-profiles-`));
const templateProfile = join(profileRoot, "template");
const rawPath = join(config.outDir, `${config.label}-raw.json`);
const summaryPath = join(config.outDir, `${config.label}-summary.json`);
const environmentPath = join(config.outDir, `${config.label}-environment.json`);
const raw = {
  schemaVersion: 1,
  label: config.label,
  generatedAt: new Date().toISOString(),
  config: { runs: config.runs, scenarios: config.scenarios, headless: config.headless },
  samples: [],
};

try {
  console.log(`[perf-cold] preparing isolated template profile (${config.headless ? "headless" : "headed"})`);
  const template = await prepareTemplate(templateProfile);
  const cpuList = cpus();
  const trackedDiff = execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  const environment = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    label: config.label,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(),
    gitStatusShort: execFileSync("git", ["status", "--short"], { cwd: REPO, encoding: "utf8" }).trimEnd(),
    trackedDiffSha256: createHash("sha256").update(trackedDiff).digest("hex"),
    samplerSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
    node: process.version,
    os: { platform: platform(), release: release(), arch: arch() },
    cpu: { count: cpuList.length, model: cpuList[0]?.model || null },
    chromium: { version: template.chromiumVersion, executable: chromium.executablePath() },
    browser: template.navigator,
    fixed: {
      locale: "zh-CN",
      theme: "light",
      pageViewport: { width: 1280, height: 900 },
      pageDeviceScaleFactor: 1,
      popupViewport: "toolbar-controlled; see each raw sample",
      activePage: ACTIVE_URL,
      previewBlocks: 52,
      previewBytes: Buffer.byteLength(SYNTHETIC_MARKDOWN),
    },
    run: { runs: config.runs, scenarios: config.scenarios, headless: config.headless },
    template: { prepareMs: template.prepareMs, network: template.network },
  };
  raw.environment = environment;
  writeJson(environmentPath, environment);
  const blockedTemplateRequests = template.network.filter((entry) => entry.disposition.startsWith("blocked"));
  if (blockedTemplateRequests.length) {
    throw new Error(`template made ${blockedTemplateRequests.length} blocked external/write request(s)`);
  }
  for (let run = 1; run <= config.runs; run += 1) {
    for (const scenario of config.scenarios) {
      console.log(`[perf-cold] ${scenario} ${run}/${config.runs}`);
      const sample = await runSample(templateProfile, scenario, run, template.fakeToken);
      raw.samples.push(sample);
      writeJson(rawPath, raw);
      console.log(sample.failure
        ? `[perf-cold] ${scenario} ${run} FAIL: ${sample.failure.message}`
        : `[perf-cold] ${scenario} ${run} cold=${roundMetric(sample.cold.wallReadyMs ?? sample.cold.roundTripMs)}ms warm=${roundMetric(sample.warm.wallReadyMs ?? sample.warm.roundTripMs)}ms`);
    }
  }
  const popupDeviceScaleFactors = [...new Set(raw.samples
    .filter((sample) => sample.scenario === "popup")
    .flatMap((sample) => [sample.cold?.viewport?.deviceScaleFactor, sample.warm?.viewport?.deviceScaleFactor])
    .filter(Number.isFinite))];
  environment.observed = { popupDeviceScaleFactors };
  if (config.scenarios.includes("popup")) {
    environment.popupUsesNativeDisplayScale = !config.headless;
    environment.popupTargetMode = config.headless ? "headless-toolbar-target" : "headed-toolbar-target";
    if (popupDeviceScaleFactors.length > 1) {
      const sample = raw.samples.find((item) => item.scenario === "popup" && !item.failure);
      if (sample) sample.failure = {
        name: "ValidityError",
        message: `Popup device scale factor changed within the sample set: ${popupDeviceScaleFactors.join(", ")}`,
      };
    }
  }
  raw.environment = environment;
  writeJson(environmentPath, environment);
  writeJson(rawPath, raw);
  const summary = summarize(raw.samples);
  writeJson(summaryPath, summary);
  const failures = raw.samples.filter((sample) => sample.failure).length;
  console.log(`[perf-cold] environment: ${environmentPath}`);
  console.log(`[perf-cold] raw: ${rawPath}`);
  console.log(`[perf-cold] summary: ${summaryPath}`);
  if (failures) {
    console.error(`[perf-cold] completed with ${failures} failed sample(s)`);
    process.exitCode = 1;
  } else {
    console.log(`[perf-cold] PASS (${raw.samples.length} samples)`);
  }
} catch (error) {
  raw.setupFailure = safeError(error);
  writeJson(rawPath, raw);
  console.error(`[perf-cold] fatal: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (config.keepProfiles) console.log(`[perf-cold] profiles kept: ${profileRoot}`);
  else rmSync(profileRoot, { recursive: true, force: true });
}
