// E2E probe (plan A + plan B): real extension, real md-preview page.
// Verifies: text-autospace wiring, heading balance, typography tiers (panel,
// persistence, anchor/top behavior, zen entry), the export honesty note, and
// the four Codex-acceptance regressions (load race / scroll grab / h4-h6
// pinning / print popover leak).
//
// MANUAL deep-probe, not a CI gate: run `node typo-export-probe.mjs` from
// .qa-scan/ after touching the reader typography or export-note paths. The
// per-verify gate for the same invariants is the static section in
// tests/ui-contract-tests.mjs -- this probe exists because static contracts
// can't see real layout/scroll/print behavior. Tracked via `git add -f`
// (.qa-scan/ is otherwise gitignored), same as run-test.mjs.
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXT = "/home/oumu/projects/Pinboard-Bookmark-Enhanced";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -- " + detail}`);
};

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "typo-probe-")), {
  headless: false,
  viewport: { width: 1680, height: 950 },
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--no-first-run", "--no-default-browser-check", "--disable-default-apps",
  ],
});
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
const extId = new URL(sw.url()).host;

const CONTENT = `
<h1>中文与English混排的排版探针标题很长一段用来测试balance效果的标题文本</h1>
<p>这是一段中文正文mixed with English词汇，用来验证text-autospace的插入语义。</p>
<p>Second paragraph with <code>inline中文code</code> to probe the code exemption.</p>
<ul><li>列表项one</li><li>列表项two</li></ul>
<pre><code>const x = "代码块CJK";</code></pre>
<img src="https://127.0.0.1:9/broken.png" alt="broken probe image">
<p>${"填充段落。".repeat(40)}</p>
<p>${"more filler text. ".repeat(60)}</p>
`;

const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/md-preview.html`);
await page.evaluate(async (html) => {
  await chrome.storage.local.set({
    md_preview_data: { contentHtml: html, title: "排版探针", url: "https://probe.example.com/post", source: "defuddle" },
  });
}, CONTENT);
await page.reload();
await page.waitForSelector("#rendered-view p", { timeout: 15000 });

// ---- T1: CSS wiring ----
const t1 = await page.evaluate(() => {
  const view = document.getElementById("rendered-view");
  const code = view.querySelector("pre code");
  const h1 = view.querySelector("h1");
  const p = view.querySelector("p");
  const cs = getComputedStyle(p);
  return {
    autospaceView: getComputedStyle(view).textAutospace,
    autospaceCode: getComputedStyle(code).textAutospace,
    h1Wrap: getComputedStyle(h1).textWrap || getComputedStyle(h1).textWrapStyle,
    pFont: parseFloat(cs.fontSize),
    pLine: parseFloat(cs.lineHeight),
    liLine: parseFloat(getComputedStyle(view.querySelector("li")).lineHeight),
  };
});
check("view text-autospace normal", t1.autospaceView === "normal", t1.autospaceView);
check("code text-autospace no-autospace", t1.autospaceCode === "no-autospace", t1.autospaceCode);
check("h1 text-wrap balance", /balance/.test(t1.h1Wrap), t1.h1Wrap);
check("default leading 1.75", Math.abs(t1.pLine / t1.pFont - 1.75) < 0.02, `${t1.pLine}/${t1.pFont}`);
check("li follows the same leading", Math.abs(t1.liLine - t1.pLine) < 0.5, `${t1.liLine} vs ${t1.pLine}`);

// ---- T2: panel + tiers ----
await page.click("#rail-typo-btn");
await page.waitForSelector("#typo-pop:popover-open", { timeout: 5000 });
check("Aa panel opens from rail", true);
const val0 = await page.textContent("#typo-pop .typo-value");
check("readout starts at 100%", val0.trim() === "100%", val0);

await page.click("#typo-font-plus");
await page.waitForTimeout(150);
const afterPlus = await page.evaluate(() => ({
  scale: document.body.style.getPropertyValue("--pbp-font-scale"),
  font: parseFloat(getComputedStyle(document.querySelector("#rendered-view p")).fontSize),
  readout: document.querySelector("#typo-pop .typo-value").textContent,
  scrollY: window.scrollY,
}));
check("font +1 applies 1.1 scale", afterPlus.scale === "1.1", afterPlus.scale);
check("computed font grew ~10%", Math.abs(afterPlus.font / t1.pFont - 1.1) < 0.02, `${afterPlus.font} vs ${t1.pFont}`);
check("readout 110%", afterPlus.readout.trim() === "110%", afterPlus.readout);
check("tier change at top keeps scrollY=0", afterPlus.scrollY === 0, String(afterPlus.scrollY));

await page.click('#typo-pop .typo-seg-btn[data-tier="1"]');
await page.waitForTimeout(150);
const afterLead = await page.evaluate(() => {
  const p = document.querySelector("#rendered-view p");
  const cs = getComputedStyle(p);
  return { ratio: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize), pressed: document.querySelector('#typo-pop .typo-seg-btn[data-tier="1"]').getAttribute("aria-pressed") };
});
check("relaxed leading ≈1.9", Math.abs(afterLead.ratio - 1.9) < 0.02, String(afterLead.ratio));
check("segment aria-pressed", afterLead.pressed === "true", afterLead.pressed);

// stepper end-stop: +1 more → tier 2 → plus becomes aria-disabled but keeps focus
await page.click("#typo-font-plus");
await page.waitForTimeout(100);
const endStop = await page.evaluate(() => ({
  dis: document.getElementById("typo-font-plus").getAttribute("aria-disabled"),
  readout: document.querySelector("#typo-pop .typo-value").textContent,
  focusTag: document.activeElement && document.activeElement.id,
}));
check("plus end-stop aria-disabled at 120%", endStop.dis === "true" && endStop.readout.trim() === "120%", JSON.stringify(endStop));
check("end-stop keeps focus on the button", endStop.focusTag === "typo-font-plus", String(endStop.focusTag));

const stored = await page.evaluate(() => chrome.storage.local.get(["pbp_font_tier", "pbp_leading_tier"]));
check("tier IDs persisted", stored.pbp_font_tier === 2 && stored.pbp_leading_tier === 1, JSON.stringify(stored));

// Esc closes (native popover)
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
check("Esc closes the panel", await page.evaluate(() => !document.querySelector("#typo-pop:popover-open")));

// persistence across reload: applied pre-render from the payload read
await page.evaluate(async (html) => {
  await chrome.storage.local.set({ md_preview_data: { contentHtml: html, title: "排版探针", url: "https://probe.example.com/post", source: "defuddle" } });
}, CONTENT);
await page.reload();
await page.waitForSelector("#rendered-view p", { timeout: 15000 });
const reloaded = await page.evaluate(() => ({
  scale: document.body.style.getPropertyValue("--pbp-font-scale"),
  leading: document.body.style.getPropertyValue("--pbp-prose-leading"),
}));
check("tiers reapplied on reload (pre-render read)", reloaded.scale === "1.2" && reloaded.leading === "1.9", JSON.stringify(reloaded));

// mid-document tier change preserves the reading anchor
await page.evaluate(() => window.scrollTo(0, 600));
await page.waitForTimeout(200);
await page.click("#rail-typo-btn");
await page.waitForSelector("#typo-pop:popover-open");
await page.click("#typo-font-minus");
await page.waitForTimeout(400);
const midScroll = await page.evaluate(() => window.scrollY);
check("mid-document tier change keeps a reading anchor (scroll ≠ 0)", midScroll > 0, String(midScroll));
await page.keyboard.press("Escape");

// zen bar carries the Aa entry
await page.keyboard.press("z");
await page.waitForSelector("#zen-bar", { timeout: 5000 });
check("zen bar has Aa entry", await page.evaluate(() => !!document.getElementById("zen-typo-btn")));
await page.keyboard.press("z");

// ---- Plan A: export honesty note ----
await page.waitForSelector("#rendered-view img.pbp-img-broken", { timeout: 10000 });
check("broken probe image observed", true);

const policy = await page.evaluate(() => document.getElementById("exp-image-policy").value);
check("default policy is keep", policy === "keep", policy);

await page.evaluate(() => document.getElementById("btn-copy-md").click());
await page.waitForTimeout(300);
const note1 = await page.evaluate(() => {
  const el = document.getElementById("export-note");
  return { hidden: el.hidden, text: el.textContent };
});
check("Copy MD + keep + broken → honesty note", !note1.hidden && /1/.test(note1.text), JSON.stringify(note1));

await page.evaluate(() => { const s = document.getElementById("exp-image-policy"); s.value = "embed"; s.dispatchEvent(new Event("change", { bubbles: true })); });
await page.evaluate(() => document.getElementById("btn-copy-md").click());
await page.waitForTimeout(300);
const note2 = await page.evaluate(() => document.getElementById("export-note").textContent);
const embedNotHere = await page.evaluate(() => t("mdImgEmbedNotHere"));
check("Copy MD + embed → merged clamp note", note2.includes(embedNotHere.slice(0, 8)) && /1/.test(note2), note2);

await page.evaluate(() => { const s = document.getElementById("exp-image-policy"); s.value = "alt"; s.dispatchEvent(new Event("change", { bubbles: true })); });
// The note is transient per-action feedback with a 6s self-hide; blank it so
// this assertion sees only what the ALT click itself posts (nothing).
await page.evaluate(() => { const el = document.getElementById("export-note"); el.hidden = true; el.textContent = ""; });
await page.evaluate(() => document.getElementById("btn-copy-md").click());
await page.waitForTimeout(300);
const note3 = await page.evaluate(() => {
  const el = document.getElementById("export-note");
  return el.hidden ? "" : el.textContent;
});
check("alt policy → no note (no links shipped)", note3 === "" || !/1/.test(note3), note3);

// ---- Codex-acceptance regressions (4 fixed defects) ----

// (1) h4-h6 stay pinned while prose follows the relaxed tier (still active).
const heading = await page.evaluate(() => {
  const view = document.getElementById("rendered-view");
  const mk = (tag) => { const el = document.createElement(tag); el.textContent = "探针heading"; view.appendChild(el); return el; };
  const h4 = mk("h4");
  const p = view.querySelector("p");
  const r = (el) => { const cs = getComputedStyle(el); return parseFloat(cs.lineHeight) / parseFloat(cs.fontSize); };
  const out = { h4: r(h4), p: r(p) };
  h4.remove();
  return out;
});
check("h4 pinned at 1.75 while prose is at relaxed tier", Math.abs(heading.h4 - 1.75) < 0.02 && heading.p > 1.85, JSON.stringify(heading));

// (2) print: panel hidden, tiers respected.
await page.click("#rail-typo-btn");
await page.waitForSelector("#typo-pop:popover-open");
await page.emulateMedia({ media: "print" });
const printState = await page.evaluate(() => ({
  popDisplay: getComputedStyle(document.getElementById("typo-pop")).display,
  leadingVar: document.body.style.getPropertyValue("--pbp-prose-leading"),
  pRatio: (() => { const cs = getComputedStyle(document.querySelector("#rendered-view p")); return parseFloat(cs.lineHeight) / parseFloat(cs.fontSize); })(),
}));
await page.emulateMedia({ media: "screen" });
check("print hides #typo-pop", printState.popDisplay === "none", printState.popDisplay);
check("print respects the leading tier", Math.abs(printState.pRatio - 1.9) < 0.02, JSON.stringify(printState));
await page.keyboard.press("Escape");

// (3) sync settle never drags a user scroll back (no 300ms second phase).
await page.evaluate(() => window.scrollTo(0, 700));
await page.waitForTimeout(150);
await page.click("#rail-typo-btn");
await page.waitForSelector("#typo-pop:popover-open");
await page.click("#typo-font-plus"); // settles synchronously
await page.waitForTimeout(60);
await page.evaluate(() => window.scrollTo(0, window.scrollY + 900)); // user scrolls right after
const userY = await page.evaluate(() => window.scrollY);
await page.waitForTimeout(450); // past the old 300ms fallback window
const laterY = await page.evaluate(() => window.scrollY);
check("user scroll after a tier change is not dragged back", Math.abs(laterY - userY) < 2, `${userY} -> ${laterY}`);
await page.keyboard.press("Escape");

// (4) load race: delay md-reader.js 1.8s -- tiers still applied pre-render
// (pbpTypoApplyVars now lives in shared.js, which precedes md-preview.js).
const racePage = await ctx.newPage();
await racePage.route("**/md-reader.js", async (route) => {
  await new Promise((r) => setTimeout(r, 1800));
  await route.continue();
});
await racePage.goto(`chrome-extension://${extId}/md-preview.html`);
await racePage.evaluate(async (html) => {
  await chrome.storage.local.set({ md_preview_data: { contentHtml: html, title: "race", url: "https://probe.example.com/post", source: "defuddle" } });
}, CONTENT);
await racePage.reload();
await racePage.waitForSelector("#rendered-view p", { timeout: 15000 });
const race = await racePage.evaluate(() => ({
  scale: document.body.style.getPropertyValue("--pbp-font-scale"),
  leading: document.body.style.getPropertyValue("--pbp-prose-leading"),
  readerLoaded: typeof window._pbpTypoInited,
}));
check("tiers applied even with md-reader.js delayed 1.8s", race.scale !== "" && race.leading !== "", JSON.stringify(race));
await racePage.close();

const fails = results.filter((r) => !r.ok).length;
console.log(fails === 0 ? `\nPROBE PASS ${results.length}/${results.length}` : `\nPROBE FAIL ${fails}/${results.length}`);
await ctx.close();
process.exit(fails === 0 ? 0 : 1);
