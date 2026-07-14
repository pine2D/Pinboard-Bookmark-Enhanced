// A4 behavioral probe: real extension, hotlink server simulated via Playwright
// route (empty-Referer -> 403, else 200 PNG; +ACAO so the page fetch works
// without a real host grant -- the permission/DNR leg was live-verified on
// sspai in the hotlink round and is not re-tested here). Verifies: image 403s
// -> fix succeeds -> cache entry decoded -> Download(embed) reuses the cache
// with ZERO new requests and ZERO permission prompts. One-shot manual tool.
import { chromium } from "playwright";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXT = "/home/oumu/projects/Pinboard-Bookmark-Enhanced";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -- " + detail}`);
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
const IMG_URL = "https://cdn.a4probe.test/hotlinked.png";

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "a4-probe-")), {
  headless: false,
  viewport: { width: 1680, height: 950 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--no-default-browser-check"],
});
try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();

  let hits = 0;
  await page.route(`${IMG_URL}*`, async (route) => {
    hits++;
    const referer = route.request().headers()["referer"];
    if (!referer) { await route.fulfill({ status: 403, body: "no referer" }); return; }
    await route.fulfill({
      status: 200, body: PNG,
      headers: { "content-type": "image/png", "access-control-allow-origin": "*" },
    });
  });

  await page.goto(`chrome-extension://${extId}/md-preview.html`);
  await page.evaluate(async (img) => {
    await chrome.storage.local.set({
      md_preview_data: { contentHtml: `<h1>A4</h1><p>before</p><img src="${img}" alt="hot"><p>after</p>`, title: "a4", url: "https://probe.example.com/post", source: "defuddle" },
    });
  }, IMG_URL);
  await page.reload();
  await page.waitForSelector("#rendered-view img.pbp-img-broken", { timeout: 15000 });
  check("hotlink image 403s in preview (empty referer rejected)", true);
  const hitsAfterBreak = hits;

  // permissions.request never settles under automation -> stub granted + count
  // calls; the DNR rule the SW installs is real but the route answers first.
  // The fix-round fetch carries no referer either, so make the route accept
  // the RETRY by marker: cache:"reload" requests get a referer injected by the
  // DNR rule in production -- here we flip the route to 200 for the fix round.
  await page.unroute(`${IMG_URL}*`);
  let phase2Hits = 0;
  await page.route(`${IMG_URL}*`, async (route) => {
    phase2Hits++;
    await route.fulfill({ status: 200, body: PNG, headers: { "content-type": "image/png", "access-control-allow-origin": "*" } });
  });
  await page.evaluate(() => {
    window.__permCalls = 0;
    chrome.permissions.request = async () => { window.__permCalls++; return true; };
  });

  await page.waitForSelector(".pbp-img-fix-btn", { timeout: 5000 });
  await page.evaluate(() => document.querySelector(".pbp-img-fix-btn").click());
  await page.waitForFunction(() => {
    const img = document.querySelector('#rendered-view img[data-pbp-img-fixed="1"]');
    return img && img.naturalWidth > 0;
  }, { timeout: 15000 });
  check("fix flow succeeds and the image truly decodes", true);
  const permAfterFix = await page.evaluate(() => window.__permCalls);
  check("fix used exactly one permission request", permAfterFix === 1, String(permAfterFix));
  check("fix round hit the network", phase2Hits >= 1, String(phase2Hits));

  // let the load listener settle decoded=true, then export with embed
  await page.waitForTimeout(300);
  const hitsBeforeExport = phase2Hits;
  await page.evaluate(() => { const s = document.getElementById("exp-image-policy"); s.value = "embed"; s.dispatchEvent(new Event("change", { bubbles: true })); });
  const dl = page.waitForEvent("download", { timeout: 15000 });
  await page.evaluate(() => document.getElementById("btn-dl-md").click());
  const download = await dl;
  const outPath = join(mkdtempSync(join(tmpdir(), "a4-out-")), "out.md");
  await download.saveAs(outPath);
  const body = readFileSync(outPath, "utf8");

  check("export embeds the image as a data URI", body.includes("![hot](data:image/png;base64,"), body.slice(0, 300));
  check("export made ZERO new requests (cache reuse)", phase2Hits === hitsBeforeExport, `${hitsBeforeExport} -> ${phase2Hits}`);
  const permAfterExport = await page.evaluate(() => window.__permCalls);
  check("export asked for ZERO permissions (full cache hit)", permAfterExport === permAfterFix, `${permAfterFix} -> ${permAfterExport}`);
  const note = await page.evaluate(() => { const el = document.getElementById("export-note"); return el.hidden ? "" : el.textContent; });
  check("no partial-embed note (everything embedded)", !/could not be embedded|未能内嵌/.test(note), note);

  // regression leg: with the cache entry NOT yet decoded the export must
  // refetch -- simulate by reloading (session cache is in-memory, so a fresh
  // document has no cache) and exporting with embed straight away.
  await page.evaluate(async (img) => {
    await chrome.storage.local.set({ md_preview_data: { contentHtml: `<h1>A4</h1><img src="${img}" alt="hot">`, title: "a4", url: "https://probe.example.com/post", source: "defuddle" } });
  }, IMG_URL);
  await page.reload();
  await page.waitForSelector("#rendered-view img", { timeout: 15000 });
  await page.evaluate(() => { window.__permCalls = 0; chrome.permissions.request = async () => { window.__permCalls++; return true; }; });
  const hitsBeforeCold = phase2Hits;
  await page.evaluate(() => { const s = document.getElementById("exp-image-policy"); s.value = "embed"; s.dispatchEvent(new Event("change", { bubbles: true })); });
  const dl2 = page.waitForEvent("download", { timeout: 15000 });
  await page.evaluate(() => document.getElementById("btn-dl-md").click());
  await (await dl2).saveAs(join(mkdtempSync(join(tmpdir(), "a4-out2-")), "out2.md"));
  const coldPerm = await page.evaluate(() => window.__permCalls);
  check("cold export (no cache) still fetches + asks permission", phase2Hits > hitsBeforeCold && coldPerm === 1, `hits ${hitsBeforeCold} -> ${phase2Hits}, perm ${coldPerm}`);
} finally {
  await ctx.close();
}
const fails = results.filter((r) => !r.ok).length;
console.log(fails === 0 ? `\nA4 PROBE PASS ${results.length}/${results.length}` : `\nA4 PROBE FAIL ${fails}/${results.length}`);
process.exit(fails === 0 ? 0 : 1);
