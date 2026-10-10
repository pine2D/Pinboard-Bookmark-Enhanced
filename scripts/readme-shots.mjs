#!/usr/bin/env node
// readme-shots — regenerates the README screenshots in docs/screenshots/readme/.
// Loads the REPO ROOT as an unpacked extension into Playwright's bundled
// Chromium (headed: the toolbar popup needs a real window), seeds English
// presentation fixtures (scripts/readme-shots-fixtures.mjs: original text, no
// real bookmarks), mocks every network dependency via context.route, drives
// the surfaces, then optionally composes the raw shots into framed images.
//
// PREREQUISITES  (same as qa-drive.mjs)
//   cd .qa-scan && npm install && npx playwright install chromium
//
// USAGE
//   node scripts/readme-shots.mjs --compose          # full rerun: shoot + compose + WebP
//   node scripts/readme-shots.mjs --surfaces reader,ask   # light scheme, subset (no compose)
//   node scripts/readme-shots.mjs --compose-only     # recompose from existing raw shots
//   Options: --surfaces popup,reader,ask,notes,vocab,themes,video
//            --scheme light|dark   (with --surfaces; default light)
//            --dsf 2   --video-t 95 (caption time shown in the video shot)
//   Default (no --surfaces): light = popup..themes, dark = popup only (hero),
//   video = its own light context (YouTube origin grant + relay stub).
//
// OUTPUT  .qa-scan/report/readme-shots/{raw/<scheme>,out}/ (gitignored);
//   --compose also writes 1800px-wide WebP (q86) to docs/screenshots/readme/:
//   hero, reader, ask, notes, vocab, video, themes.
//
// pinboard.in stylesheets (third-party copyright) are downloaded on demand to
// .qa-scan/cache/pbcss/ for the themes shots only; never commit them.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as F from "./readme-shots-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const { chromium } = createRequire(resolve(REPO, ".qa-scan/package.json"))("playwright");
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const DSF = Number(flag("--dsf", "2"));
const START_T = Number(flag("--video-t", "95"));
const ALL = ["popup", "reader", "ask", "notes", "vocab", "themes", "video"];
const OUT_ROOT = join(REPO, ".qa-scan/report/readme-shots");
const RAW = (scheme) => join(OUT_ROOT, "raw", scheme);
const COMPOSED = join(OUT_ROOT, "out");
const WEBP_DIR = join(REPO, "docs/screenshots/readme");
const PBCSS = join(REPO, ".qa-scan/cache/pbcss");
const T = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Job plan: [scheme, surfaces]. Video runs in its own context (extra origin
// grant, different route table) but through the same launch/seed code.
const jobs = (() => {
  if (has("--compose-only")) return [];
  if (flag("--surfaces")) {
    const s = flag("--surfaces").split(",").filter(Boolean);
    const bad = s.filter((x) => !ALL.includes(x));
    if (bad.length) throw new Error("unknown surface: " + bad.join(","));
    const scheme = flag("--scheme", "light");
    const rest = s.filter((x) => x !== "video");
    return [...(rest.length ? [{ scheme, surfaces: rest }] : []), ...(s.includes("video") ? [{ scheme, surfaces: ["video"] }] : [])];
  }
  return [
    { scheme: "light", surfaces: ["popup", "reader", "ask", "notes", "vocab", "themes"] },
    { scheme: "dark", surfaces: ["popup"] },
    { scheme: "light", surfaces: ["video"] },
  ];
})();

// ---------- pinboard.in stylesheet cache ----------
async function ensurePbCss() {
  const files = ["skeleton.css", "autocomplete.css", "bookmarks.css", "basic.css", "new_main.css", "blue-pin.png"];
  if (files.every((f) => existsSync(join(PBCSS, f)))) return;
  mkdirSync(PBCSS, { recursive: true });
  for (const f of files) {
    const p = join(PBCSS, f);
    if (existsSync(p)) continue;
    const url = f.endsWith(".css") ? `https://pinboard.in/stylesheets/${f}` : `https://pinboard.in/${f}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download ${url}: HTTP ${r.status}`);
    writeFileSync(p, Buffer.from(await r.arrayBuffer()));
    console.log("cached", f);
  }
}

// ---------- AI mock ----------
function aiAnswer(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const system = msgs.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const user = msgs.filter((m) => m.role !== "system").map((m) => m.content).join("\n");
  if (system.includes('"translations"')) {
    let segs = [];
    try {
      const walk = (v) => {
        if (Array.isArray(v)) {
          if (v.length && v.every((x) => x && typeof x === "object" && "id" in x && typeof x.text === "string")) segs = v; else v.forEach(walk);
        } else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(JSON.parse(user));
    } catch {}
    return JSON.stringify({ translations: segs.map((s) => ({ id: s.id, text: F.translate(s.text) })) });
  }
  if (/numbered paragraphs/.test(system)) return F.askAnswer(user);
  if (/"tags"|tags/i.test(user) && /"summary"|summary/i.test(user)) return F.AI_TAGS_SUMMARY;
  return "OK";
}
const sse = (content) => {
  const step = Math.max(1, Math.ceil(content.length / 6)); let out = "";
  for (let i = 0; i < content.length; i += step) out += `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + step) } }] })}\n\n`;
  return out + "data: [DONE]\n\n";
};
const ai = await new Promise((res) => {
  const server = createServer((req, rsp) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null; try { body = JSON.parse(raw); } catch {}
      const content = aiAnswer(body);
      if (body?.stream) { rsp.writeHead(200, { "Content-Type": "text/event-stream" }); rsp.end(sse(content)); }
      else { rsp.writeHead(200, { "Content-Type": "application/json" }); rsp.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] })); }
    });
  });
  server.listen(0, "127.0.0.1", () => res({ server, port: server.address().port }));
});

// ---------- video fixtures (route side) ----------
let SLIDE_PNG = null;
async function renderSlide() {
  if (SLIDE_PNG) return SLIDE_PNG;
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  await p.setContent(F.SLIDE_HTML, { waitUntil: "load" });
  SLIDE_PNG = await p.screenshot();
  await b.close();
  return SLIDE_PNG;
}
function videoRoute(url, req, route) {
  if (url.hostname === "www.youtube.com") {
    if (url.pathname === "/watch" && url.searchParams.get("v") === F.VID) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: F.WATCH_HTML });
    if (url.pathname === "/api/timedtext" && url.searchParams.get("v") === F.VID) {
      if (url.searchParams.get("fmt") === "json3") return route.fulfill({ status: 200, contentType: "application/json; charset=UTF-8", body: F.TIMEDTEXT_JSON3 });
      return route.fulfill({ status: 200, contentType: "text/xml; charset=UTF-8", body: F.TIMEDTEXT_XML });
    }
    return route.abort("blockedbyclient");
  }
  // The GitHub Pages relay page (static slide + relay protocol) and poster.
  if (url.hostname === "pine2d.github.io" && url.pathname.startsWith("/Pinboard-Bookmark-Enhanced/")) {
    if (url.pathname.endsWith("/yt-embed.html")) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: F.relayHtml(START_T) });
    if (url.pathname.endsWith("/slide.png")) return route.fulfill({ status: 200, contentType: "image/png", body: SLIDE_PNG });
  }
  if (url.hostname === "i.ytimg.com") return route.fulfill({ status: 200, contentType: "image/png", body: SLIDE_PNG });
  return null;
}

// ---------- routes ----------
async function routes(context, { scheme, video }) {
  await context.route(/^https?:\/\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    try {
      if (url.hostname === "127.0.0.1" && url.port === String(ai.port)) return route.continue();
      if (video) { const r = videoRoute(url, req, route); if (r) return r; }
      if (url.hostname === "api.openai.com") {
        let body = null; try { body = JSON.parse(req.postData() || "null"); } catch {}
        const content = aiAnswer(body);
        if (body?.stream) return route.fulfill({ status: 200, contentType: "text/event-stream", body: sse(content) });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 900, completion_tokens: 160 } }) });
      }
      if (req.url().split("#")[0] === F.ARTICLE_URL) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: F.ARTICLE_HTML(scheme) });
      if (url.hostname === "api.pinboard.in") {
        const body = F.PINBOARD_API.get(url.pathname);
        return body ? route.fulfill({ status: 200, contentType: "application/json", body }) : route.abort("blockedbyclient");
      }
      if (url.hostname === "pinboard.in") {
        const m = url.pathname.match(/^\/stylesheets\/([a-z_]+\.css)$/);
        if (m) { try { return route.fulfill({ status: 200, contentType: "text/css", body: readFileSync(join(PBCSS, m[1]), "utf8") }); } catch { return route.fulfill({ status: 200, contentType: "text/css", body: "" }); } }
        if (url.pathname === "/blue-pin.png") return route.fulfill({ status: 200, contentType: "image/png", body: readFileSync(join(PBCSS, "blue-pin.png")) });
        return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: F.pinboardHtml() });
      }
      if (url.hostname === "freedictionaryapi.com") {
        const w = decodeURIComponent(url.pathname.split("/").pop() || "").toLowerCase();
        return route.fulfill({ status: 200, contentType: "application/json", body: !video && F.DICT[w] ? JSON.stringify(F.DICT[w]) : '{"entries":[]}' });
      }
      return route.abort("blockedbyclient");
    } catch (e) { console.warn("[route]", e.message); }
  });
}

// ---------- launch + seed (single copy, shared by every job) ----------
async function startSession({ scheme, video }) {
  const profile = join(OUT_ROOT, `.profile-${video ? "video" : scheme}`);
  rmSync(profile, { recursive: true, force: true });
  const launch = () => chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(), headless: false,
    locale: "en-US", colorScheme: scheme, deviceScaleFactor: DSF, viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, "--no-first-run", "--no-default-browser-check",
      "--disable-default-apps", "--disable-background-networking", "--disable-component-update", "--disable-sync",
      "--lang=en-US", `--force-device-scale-factor=${DSF}`, "--autoplay-policy=no-user-gesture-required",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"],
  });
  const worker = async (c) => c.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"))
    || c.waitForEvent("serviceworker", { predicate: (w) => w.url().startsWith("chrome-extension://"), timeout: T });

  let ctx = await launch();
  await routes(ctx, { scheme, video });
  let sw = await worker(ctx);
  const extId = new URL(sw.url()).hostname;
  await sleep(1200);
  await sw.evaluate(async ({ token, scheme, video }) => {
    if (typeof primeSettings === "function") await primeSettings();
    await chrome.storage.local.set({
      optSyncEnabled: false, syncApiKeys: false, _hlOwnerClaimDone: true,
      pinboardToken: obfuscateKey(token), optLang: "en", optTheme: scheme, themePresetKey: "", optPopupFollowTheme: true,
      aiProvider: "openai", openaiApiKey: obfuscateKey("sk-mock"), openaiModel: "gpt-5.4-mini",
      previewAiEnabled: true, previewSkimEnabled: false, optAiAutoTags: false, dictEchoEnabled: true,
      translateTargetLang: "zh-CN", optShowSuggestTags: true,
      ...(video ? { mdVideoDarkScheme: false, mdVideoLangPref: "" } : {}),
    });
  }, { token: F.TOKEN, scheme, video });
  if (!video) {
    await sw.evaluate(async ({ words, user }) => {
      const owner = pbpDictOwnerScope(user);
      for (const w of [...words].reverse()) {
        for (const c of w.contexts || [{}]) {
          await pbpVocabSaveWord(owner, { term: w.term, language: "en", gloss: w.gloss,
            context: c.url ? { articleUrl: c.url, articleTitle: c.title, quote: c.quote } : undefined });
        }
        const id = pbpDictVocabKey(owner, "en", w.term);
        if (w.status && w.status !== "new") await pbpVocabBatchSetStatus([id], owner, w.status);
        if (w.note) await pbpVocabSetNote(id, owner, w.note);
        if (w.group) await pbpVocabBatchAddGroup([id], owner, w.group);
      }
    }, { words: F.VOCAB, user: F.USER });
    await sw.evaluate(async (records) => {
      const e = {}; for (const r of records) e[typeof pbpNotesArticleKey === "function" ? pbpNotesArticleKey(r.url) : r.key] = { url: r.url, title: r.title, items: r.items };
      await chrome.storage.local.set(e);
    }, F.HIGHLIGHTS(Date.now()));
  }
  {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/options.html#general`, { waitUntil: "load" });
    await p.evaluate(async ({ scheme, video }) => {
      const msgs = await (await fetch(chrome.runtime.getURL("_locales/en/messages.json"))).json();
      localStorage.setItem("pp-sync-enabled", "0"); localStorage.setItem("pp-i18n-lang", "en");
      localStorage.setItem("pp-i18n-msgs", JSON.stringify(msgs)); localStorage.setItem("pp-logged-in", "1");
      localStorage.setItem("pp-theme", scheme); localStorage.setItem("pp-theme-preset", ""); localStorage.setItem("pp-theme-follow", "1");
      localStorage.setItem("pp-popup-width", "550"); localStorage.setItem("md-preview-theme", scheme);
      if (video) localStorage.setItem("md-preview-video-dark", "0");
    }, { scheme, video });
    await p.close();
  }
  await ctx.close();

  // Grant hosts through the profile Preferences (no user gesture available), relaunch.
  {
    const prefsPath = join(profile, "Default", "Preferences");
    const prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
    const st = prefs.extensions.settings[extId];
    const hosts = ["http://127.0.0.1/*", "https://api.openai.com/*", "https://freedictionaryapi.com/*", ...(video ? ["https://www.youtube.com/*"] : ["https://example.com/*"])];
    for (const k of ["granted_permissions", "active_permissions"]) {
      const b = st[k] || (st[k] = { api: [], explicit_host: [], manifest_permissions: [], scriptable_host: [] });
      b.explicit_host = [...new Set([...(b.explicit_host || []), ...hosts])];
      if (!video) b.scriptable_host = [...new Set([...(b.scriptable_host || []), "https://example.com/*"])];
    }
    writeFileSync(prefsPath, JSON.stringify(prefs));
  }
  ctx = await launch();
  await routes(ctx, { scheme, video });
  sw = await worker(ctx);
  console.log("grants", await sw.evaluate(async () => ({
    ai: await chrome.permissions.contains({ origins: ["http://127.0.0.1/*"] }),
    yt: await chrome.permissions.contains({ origins: ["https://www.youtube.com/*"] }),
    ex: await chrome.permissions.contains({ origins: ["https://example.com/*"] }),
  })));
  return { ctx, sw, extId, scheme, profile, out: RAW(scheme) };
}

// ---------- surfaces ----------
const PREVIEW_KEY = "readme-shot";
const shot = async (S, page, name, opts = {}) => { await page.screenshot({ path: join(S.out, name + ".png"), ...opts }); console.log("shot", S.scheme + "/" + name); };
async function openReader(S, page) {
  await S.sw.evaluate(async ({ k, md, title, url }) => {
    const auth = await getCurrentPinboardAuth();
    await chrome.storage.local.set({ [`md_preview_data_${k}`]: { markdown: md, contentHtml: "", title, url, baseUrl: url,
      tags: ["reading", "essay"], tokens: 0, hasApiKey: true, source: "local", math: false, forum: false, account: auth.account || "", ts: Date.now() } });
  }, { k: PREVIEW_KEY, md: F.ARTICLE_MARKDOWN, title: F.ARTICLE_TITLE, url: F.ARTICLE_URL });
  await page.goto(`chrome-extension://${S.extId}/md-preview.html?k=${PREVIEW_KEY}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("#rendered-view [data-pb]").length > 0, { timeout: T });
  await sleep(800);
}

// Opens the toolbar popup as a real action popup and drives it over a raw CDP
// session (it is not a Playwright page). WSLg focus races occasionally make
// openPopup fail with "Could not find an active browser window": retried.
async function popupOnce(S, attempt) {
  const { ctx, sw, extId } = S;
  const active = await ctx.newPage();
  let cdp, target;
  try {
    await active.goto(F.ARTICLE_URL, { waitUntil: "load" });
    await active.bringToFront();
    await (await ctx.newCDPSession(active)).send("Page.bringToFront").catch(() => {});
    await sleep(500);
    await shot(S, active, "article-page");
    cdp = await ctx.browser().newBrowserCDPSession();
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    const popupUrl = `chrome-extension://${extId}/popup.html`;
    const found = new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("popup target not seen")), T);
      const on = ({ targetInfo }) => { if (targetInfo.type === "page" && targetInfo.url === popupUrl) { clearTimeout(timer); res(targetInfo); } };
      cdp.on("Target.targetCreated", on); cdp.on("Target.targetInfoChanged", on);
    });
    found.catch(() => {});
    await sw.evaluate(async (kick) => { const w = await chrome.windows.getAll({ windowTypes: ["normal"] });
      if (kick) { // retry: bounce the window to force a fresh activation
        await chrome.windows.update(w[0].id, { state: "minimized" }); await new Promise((r) => setTimeout(r, 400));
        await chrome.windows.update(w[0].id, { state: "normal", focused: true }); await new Promise((r) => setTimeout(r, 600));
      }
      for (let i = 0; i < 20; i++) {
        await chrome.windows.update(w[0].id, { focused: true });
        if ((await chrome.windows.get(w[0].id)).focused) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      await chrome.action.openPopup({ windowId: w[0].id }); }, attempt > 1);
    target = await found;
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
    let id = 0; const pending = new Map();
    cdp.on("Target.receivedMessageFromTarget", (e) => {
      if (e.sessionId !== sessionId) return;
      const m = JSON.parse(e.message);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, { res, rej });
      cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: i, method, params }) });
    });
    const evalP = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
    for (let i = 0; i < 150; i++) {
      if (await evalP(`(() => { const m = document.getElementById("main-section"), u = document.getElementById("url-input"); return !!(m && !m.classList.contains("hidden") && u && u.value); })()`)) break;
      await sleep(100);
    }
    await sleep(1500);
    await evalP(`document.getElementById("ai-tags-btn")?.click(); document.getElementById("ai-summary-btn")?.click();`);
    await sleep(3500);
    await evalP(`[...document.querySelectorAll(".add-all-link")].filter(a => a.id !== "add-all-suggest").pop()?.click(); document.activeElement?.blur();`);
    await sleep(600);
    const img = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(S.out, "popup-ai-tagged.png"), Buffer.from(img.data, "base64"));
    console.log("shot", S.scheme + "/popup-ai-tagged", await evalP(`JSON.stringify({w: innerWidth, h: innerHeight})`));
  } finally {
    if (target) await cdp.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
    await active.close().catch(() => {});
  }
}
async function popup(S) {
  for (let attempt = 1; ; attempt++) {
    try { return await popupOnce(S, attempt); } catch (e) {
      if (attempt >= 3) throw e;
      console.warn(`[popup] attempt ${attempt} failed (${e.message}); retrying`);
      await sleep(1500);
    }
  }
}

async function reader(S) {
  const page = await S.ctx.newPage();
  await openReader(S, page);
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.keyboard.press("t"); // bilingual translation (mock AI)
  await page.waitForFunction(() => document.querySelectorAll(".pb-tr").length > 3, { timeout: 20_000 }).catch(() => console.warn("translate slow"));
  await sleep(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await shot(S, page, "reader-bilingual");
  await page.close();
}

async function ask(S) {
  const page = await S.ctx.newPage();
  await openReader(S, page);
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.locator("#ask-open").click();
  await sleep(400);
  await page.locator("#ask-input").fill("Why does the author say saving isn't reading?");
  await page.locator("#ask-send").click();
  await sleep(3500);
  await shot(S, page, "ask-answer");
  await page.close();
}

async function notes(S) {
  const page = await S.ctx.newPage();
  await page.goto(`chrome-extension://${S.extId}/library.html#notes`, { waitUntil: "load" });
  await page.waitForSelector("#notes-list .notes-hit", { timeout: T }).catch(() => {});
  await sleep(500);
  await page.locator("#notes-list .notes-hit-btn").first().click().catch((e) => console.warn("notes click", e.message));
  await sleep(700);
  await shot(S, page, "notes-flow");
  await page.close();
}

async function vocab(S) {
  const page = await S.ctx.newPage();
  await page.setViewportSize({ width: 2200, height: 960 });
  await page.goto(`chrome-extension://${S.extId}/library.html#vocab`, { waitUntil: "load" });
  await page.waitForSelector("#vocab-list .vocab-card", { timeout: T }).catch(() => {});
  await sleep(500);
  await page.locator("#vocab-list .notes-card-head").filter({ hasText: "serendipity" }).first().click().catch((e) => console.warn("vocab click", e.message));
  await sleep(2500);
  await shot(S, page, "vocab-detail-2200");
  // detail + reference columns only (CSS px)
  await shot(S, page, "vocab-detail-crop", { clip: { x: 500, y: 0, width: 1690, height: 650 } });
  await page.close();
}

const THEME_SHOTS = [["", "light"], ["solarized", "light"], ["dracula", "dark"], ["terminal", "dark"]];
async function themes(S) {
  await ensurePbCss();
  const page = await S.ctx.newPage();
  for (const [preset, mode] of THEME_SHOTS) {
    await S.sw.evaluate(async ({ p, m }) => chrome.storage.local.set({ themePresetKey: p, optTheme: m }), { p: preset, m: mode });
    await page.goto(`https://pinboard.in/u:${F.USER}/?_=${preset}${mode}`, { waitUntil: "load" });
    await sleep(900);
    await shot(S, page, `site-${preset || "none"}-${mode}`);
  }
  await S.sw.evaluate(async (m) => chrome.storage.local.set({ themePresetKey: "", optTheme: m }), S.scheme);
  await page.close();
}

// Reader video workspace: real md-video.js path (granted www.youtube.com, no
// YouTube tab -> extension-page fetch of the stubbed watch page -> timedtext).
async function video(S) {
  await S.sw.evaluate(async ({ k, title, url, desc }) => {
    const auth = await getCurrentPinboardAuth();
    await chrome.storage.local.set({ [`md_preview_data_${k}`]: { markdown: desc, contentHtml: "", title, url, baseUrl: url,
      tags: ["reading", "talk"], tokens: 0, hasApiKey: true, source: "local", math: false, forum: false, account: auth.account || "", ts: Date.now() } });
  }, { k: "readme-video", title: F.TITLE, url: F.WATCH_URL, desc: F.PLAYER_RESPONSE.videoDetails.shortDescription });
  const page = await S.ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`chrome-extension://${S.extId}/md-preview.html?k=readme-video&video=1`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll(".pbv-list .pbv-row").length > 5, { timeout: 20_000 });
  await page.waitForFunction(() => !!document.querySelector(".pbv-row--current"), { timeout: 20_000 }).catch(() => console.warn("no current row"));
  await sleep(1500);
  const relay = () => page.frames().find((f) => f.url().includes("/yt-embed.html"));
  const setT = async (v) => { await relay()?.evaluate((x) => window.__setT(x), v); };
  // Focus mode hides the rail: the 1280px viewport then clears the 960px
  // container breakpoint and the workspace goes two-column (sticky player +
  // following timeline). In the stacked layout follow is disabled by design.
  await page.locator("#rail-zen-btn").click();
  await sleep(600);
  await page.locator('.pbv-view-toggle [data-view="timeline"]').click();
  // Harness-only hover shield: under WSLg the host pointer re-dispatches
  // trusted hover events into the window, painting a stray :hover row.
  await page.evaluate(() => { const d = document.createElement("div"); d.id = "__shot_shield";
    d.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:transparent"; document.body.appendChild(d); });
  await page.mouse.move(640, 400); await page.mouse.move(1279, 799);
  await setT(START_T);
  await sleep(3200); // row follow + zen bar idle fade (2s)
  await shot(S, page, "video-workspace");
  await page.close();
}

const SURF = { popup, reader, ask, notes, vocab, themes, video };

// ---------- compose ----------
const T_ = {
  light: { stage: "#eef1f6", win: "#ffffff", bar: "#f3f4f7", line: "#dcdfe6", pill: "#e6e8ee", txt: "#5b6170", shadow: "0 30px 70px -20px rgba(30,40,70,.35), 0 0 0 1px rgba(20,30,60,.08)" },
  dark: { stage: "#0d1016", win: "#16181d", bar: "#202329", line: "#2c3038", pill: "#2a2e36", txt: "#a3a9b6", shadow: "0 30px 70px -20px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.08)" },
};
const CSS = `*{box-sizing:border-box;margin:0}body{width:var(--w);height:var(--h);overflow:hidden;font-family:"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.stage{position:absolute;inset:0;z-index:0}
.win{position:absolute;border-radius:12px;overflow:hidden}
.bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid}
.dot{width:11px;height:11px;border-radius:50%}
.pill{flex:1;height:24px;border-radius:12px;display:flex;align-items:center;padding:0 12px;font-size:12.5px;margin:0 70px 0 18px}
.ext{width:26px;height:26px;border-radius:6px;display:grid;place-items:center}
.ext img{width:17px;height:17px}
.shot{display:block;width:100%}
.pop{position:absolute;border-radius:10px;overflow:hidden}
`;
const b64 = (p) => "data:image/png;base64," + readFileSync(p).toString("base64");
const raw = (p) => b64(join(OUT_ROOT, "raw", p));

function windowHtml({ x, y, w, img, aspect, theme, url = "", pin = false, pinActive = false, z = 1 }) {
  const t = T_[theme];
  const PIN = b64(join(REPO, "icons/pin-default-128.png"));
  return `<div class="win" style="left:${x}px;top:${y}px;width:${w}px;background:${t.win};box-shadow:${t.shadow};z-index:${z}">
  <div class="bar" style="background:${t.bar};border-color:${t.line}">
    <span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>
    <span class="pill" style="background:${t.pill};color:${t.txt}">${url}</span>
    ${pin ? `<span class="ext" style="background:${pinActive ? t.pill : "transparent"}"><img src="${PIN}"></span>` : ""}
  </div>
  <img class="shot" src="${img}" style="aspect-ratio:${aspect}">
</div>`;
}

// name -> { w, h, needs: [raw files], html(), webp: README asset name }
const PAGES = {};
// hero: dark scene behind up-left, light scene in front down-right
PAGES["hero-stacked"] = { webp: "hero", w: 1200, h: 820, needs: ["light/article-page", "light/popup-ai-tagged", "dark/article-page", "dark/popup-ai-tagged"], html: () => {
  const W = 860, s = W / 1280, pw = Math.round(683 * s);
  const scene = (theme, x, y, z) => windowHtml({ x, y, w: W, img: raw(`${theme}/article-page.png`), aspect: "1280/800", theme, url: "example.com/essays/the-case-for-slow-reading", pin: true, pinActive: true, z })
    + `<div class="pop" style="left:${x + W - pw - 14}px;top:${y + 42}px;width:${pw}px;box-shadow:${T_[theme].shadow};z-index:${z}"><img class="shot" src="${raw(`${theme}/popup-ai-tagged.png`)}"></div>`;
  return `<div class="stage" style="background:linear-gradient(135deg,#1b1f27 0%,#1b1f27 50%,#e9edf3 50%,#e9edf3 100%)">${scene("dark", 50, 40, 1)}${scene("light", 290, 230, 5)}</div>`;
} };
// plain framed single screenshots
const single = (name, webp, file, rw, rh, url, W = 1120) => {
  const h = Math.round(W * rh / rw) + 38;
  PAGES[name] = { webp, w: W + 80, h: h + 80, needs: [file], html: () => `<div class="stage" style="background:${T_.light.stage}">${windowHtml({ x: 40, y: 40, w: W, img: raw(file + ".png"), aspect: `${rw}/${rh}`, theme: "light", url })}</div>` };
};
single("reader", "reader", "light/reader-bilingual", 1280, 800, "Reader · The Case for Slow Reading");
single("ask", "ask", "light/ask-answer", 1280, 800, "Reader · Ask the page");
single("notes-flow", "notes", "light/notes-flow", 1280, 800, "Notes & Vocabulary");
single("vocab-detail-crop", "vocab", "light/vocab-detail-crop", 1690, 650, "Notes & Vocabulary");
single("video", "video", "light/video-workspace", 1280, 800, "Reader · YouTube");
// themes: four themed pinboard.in pages fanned diagonally
PAGES["themes"] = { webp: "themes", w: 1200, h: 800, needs: ["light/site-none-light", "light/site-solarized-light", "light/site-dracula-dark", "light/site-terminal-dark"], html: () => {
  const list = [["light/site-none-light.png", "light", "pinboard.in · default"], ["light/site-solarized-light.png", "light", "Solarized"], ["light/site-dracula-dark.png", "dark", "Dracula"], ["light/site-terminal-dark.png", "dark", "Terminal"]];
  return `<div class="stage" style="background:${T_.light.stage}">` + list.map(([f, th, label], i) =>
    windowHtml({ x: 40 + i * 130, y: 34 + i * 92, w: 700, img: raw(f), aspect: "1280/800", theme: th, url: label, z: i + 1 })).join("") + "</div>";
} };

// PNG -> 1800px-wide WebP (q86) via the browser's canvas encoder: the repo has
// no runtime/dev dependencies, so no sharp/cwebp.
async function toWebp(browser, pngPath, outPath) {
  const page = await browser.newPage();
  const b64Data = await page.evaluate(async (dataUrl) => {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const W = 1800, H = Math.round(bmp.height * W / bmp.width);
    const c = new OffscreenCanvas(W, H), g = c.getContext("2d");
    g.imageSmoothingQuality = "high"; g.drawImage(bmp, 0, 0, W, H);
    const blob = await c.convertToBlob({ type: "image/webp", quality: 0.86 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, b64(pngPath));
  await page.close();
  writeFileSync(outPath, Buffer.from(b64Data, "base64"));
}

async function compose() {
  mkdirSync(COMPOSED, { recursive: true });
  mkdirSync(WEBP_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromium.executablePath() });
  let missing = 0;
  try {
    for (const [name, p] of Object.entries(PAGES)) {
      const lack = p.needs.filter((n) => !existsSync(join(OUT_ROOT, "raw", n + ".png")));
      if (lack.length) { console.warn(`[compose] skip ${name}: missing raw ${lack.join(", ")}`); missing++; continue; }
      const page = await browser.newPage({ viewport: { width: p.w, height: p.h }, deviceScaleFactor: 2 });
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>:root{--w:${p.w}px;--h:${p.h}px}${CSS}</style></head><body>${p.html()}</body></html>`, { waitUntil: "load" });
      const png = join(COMPOSED, name + ".png");
      await page.screenshot({ path: png });
      await page.close();
      await toWebp(browser, png, join(WEBP_DIR, p.webp + ".webp"));
      console.log("composed", name, "->", `docs/screenshots/readme/${p.webp}.webp`);
    }
  } finally { await browser.close(); }
  return missing;
}

// ---------- main ----------
let failed = 0;
try {
  for (const job of jobs) {
    const video = job.surfaces.includes("video");
    if (video) await renderSlide(); // after the popup jobs: a headless launch before them steals window focus
    mkdirSync(RAW(job.scheme), { recursive: true });
    const S = await startSession({ scheme: job.scheme, video });
    try {
      for (const s of job.surfaces) {
        console.log("surface", job.scheme + "/" + s);
        try { await SURF[s](S); } catch (e) { failed++; console.error(`[${s}]`, e.stack); }
      }
    } finally {
      await S.ctx.close().catch(() => {});
      rmSync(S.profile, { recursive: true, force: true });
    }
  }
} finally { ai.server.close(); }
if (has("--compose") || has("--compose-only")) failed += await compose();
if (failed) { console.error(`${failed} problem(s)`); process.exit(1); }
