#!/usr/bin/env node
// cws-shots — Chrome Web Store screenshots and promo tiles, composed from the
// raw captures that scripts/readme-shots.mjs leaves behind. No extension run
// here: every image is an HTML frame (real UI screenshots, cropped and placed)
// rendered in Playwright's bundled Chromium.
//
// PREREQUISITES
//   node scripts/readme-shots.mjs            # writes $PBP_QA_REPORT_DIR/readme-shots/raw/light/
//
// USAGE
//   node scripts/cws-shots.mjs               # all screenshots + both promo tiles
//   node scripts/cws-shots.mjs --only 1-save,marquee
//
// OUTPUT  docs/cws-assets/
//   screenshot-N-<name>-1280x800.png, marquee-promo-tile-1400x560.png,
//   small-promo-tile-440x280.png: the upload sizes, 24-bit PNG without alpha
//   (the store accepts PNG or JPEG only, no alpha channel).
//   originals/: the same frames at 2x (screenshots) and 3x (tiles).
//   Stale screenshot-* files from an earlier set are removed.
//
// COPY RULES (user direction, 2026-11-04): one idea per image, a headline of
// six words or fewer and at most one short subline. No feature lists, specs,
// settings names, version numbers, or lists of services, providers, formats
// or theme names. The UI shows the benefit; the words only name it.
//
// FONTS  Headlines use Bahnschrift (condensed), the tiles' serif uses Sitka,
// both read at render time from the Windows font folder (CWS_FONT_DIR,
// default /mnt/c/Windows/Fonts) as data URIs; they are never committed.
// Without them the stacks fall back to locally installed families.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const { chromium } = createRequire(resolve(REPO, ".qa-scan/package.json"))("playwright");
const RAW = join(process.env.PBP_QA_REPORT_DIR || join(homedir(), ".local/share/pbp-qa-report"), "readme-shots/raw/light");
const OUT = join(REPO, "docs/cws-assets");
const ORIG = join(OUT, "originals");
const RAW_DSF = 2; // readme-shots captures at deviceScaleFactor 2
const FONT_DIR = process.env.CWS_FONT_DIR || "/mnt/c/Windows/Fonts";
const argv = process.argv.slice(2);
const onlyArg = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] || "" : "";
const ONLY = onlyArg ? new Set(onlyArg.split(",")) : null;

// ---------- PNG: decode Chromium's output, re-encode as 8-bit RGB ----------
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
function pngRead(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), kind = buf.toString("latin1", off + 4, off + 8), body = buf.subarray(off + 8, off + 8 + len);
    if (kind === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (type !== 2 && type !== 6)) throw new Error(`unsupported PNG: depth ${depth}, colour type ${type}, interlace ${interlace}`);
  const ch = type === 6 ? 4 : 3, stride = w * ch, src = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = src[y * (stride + 1)], row = src.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride), prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? out[i - ch] : 0, b = prev ? prev[i] : 0, c = prev && i >= ch ? prev[i - ch] : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      out[i] = (row[i] + pred) & 255;
    }
  }
  return { w, h, ch, px };
}
function pngWriteRGB({ w, h, ch, px }) {
  const stride = w * 3, rgb = Buffer.alloc(h * stride);
  for (let i = 0, j = 0; i < w * h; i++) {
    const a = ch === 4 ? px[i * 4 + 3] : 255; // flatten onto white (frames are opaque anyway)
    for (let k = 0; k < 3; k++) rgb[j++] = Math.round((px[i * ch + k] * a + 255 * (255 - a)) / 255);
  }
  const out = Buffer.alloc(h * (stride + 1)), cand = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride), prev = y ? rgb.subarray((y - 1) * stride, y * stride) : null;
    const dst = out.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) { // libpng's heuristic: least sum of |residual|
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? row[i - 3] : 0, b = prev ? prev[i] : 0, c = prev && i >= 3 ? prev[i - 3] : 0;
        const v = (row[i] - (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c))) & 255;
        cand[i] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; cand.copy(dst); }
    }
    out[y * (stride + 1)] = best;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour, no alpha
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(out, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- raw captures ----------
const rawPath = (name) => join(RAW, name + ".png");
const rawCache = new Map();
function raw(name) {
  if (!rawCache.has(name)) {
    const buf = readFileSync(rawPath(name));
    rawCache.set(name, { uri: "data:image/png;base64," + buf.toString("base64"), w: buf.readUInt32BE(16) / RAW_DSF, h: buf.readUInt32BE(20) / RAW_DSF });
  }
  return rawCache.get(name);
}
const b64file = (p, mime) => `data:${mime};base64,${readFileSync(p).toString("base64")}`;

// ---------- fonts ----------
function fontFace(file, family, weight, stretch = "100%") {
  const p = join(FONT_DIR, file);
  if (!existsSync(p)) { console.warn(`[font] ${p} missing; ${family} falls back to local fonts`); return ""; }
  return `@font-face{font-family:"${family}";src:url(${b64file(p, "font/ttf")}) format("truetype");font-weight:${weight};font-stretch:${stretch}}`;
}
let FONTS = null;
const fonts = () => FONTS ??= fontFace("bahnschrift.ttf", "CWS Display", "300 700", "75% 100%")
  + fontFace("SitkaVF.ttf", "CWS Serif", "400 700")
  + fontFace("SitkaVF-Italic.ttf", "CWS Serif Italic", "400 700");
const DISPLAY = `"CWS Display","Bahnschrift","Oswald","Arial Narrow",sans-serif`;
const SERIF = `"CWS Serif","Sitka Banner","Sitka Display","Georgia",serif`;
const SANS = `"Segoe UI","Roboto","Helvetica Neue",Arial,sans-serif`;

// ---------- shared pieces ----------
const PIN = () => b64file(join(REPO, "icons/pin-saved-128.png"), "image/png");
const BASE_CSS = `*{box-sizing:border-box;margin:0;padding:0}html,body{width:var(--w);height:var(--h);overflow:hidden}
body{font-family:${SANS};-webkit-font-smoothing:antialiased}
.win,.card{position:absolute;overflow:hidden;background:#fff}
.win{border-radius:12px;box-shadow:0 30px 70px -24px rgba(30,40,70,.38),0 0 0 1px rgba(20,30,60,.08)}
.win.dark{background:#16181d;box-shadow:0 30px 70px -24px rgba(0,0,0,.55),0 0 0 1px rgba(20,30,60,.2)}
.bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#f3f4f7;border-bottom:1px solid #dcdfe6}
.dark .bar{background:#202329;border-color:#2c3038}
.dot{width:11px;height:11px;border-radius:50%;flex:none}
.pill{flex:1;height:24px;border-radius:12px;display:flex;align-items:center;padding:0 12px;font-size:12.5px;margin:0 60px 0 18px;background:#e6e8ee;color:#5b6170;white-space:nowrap;overflow:hidden}
.dark .pill{background:#2a2e36;color:#a3a9b6}
.vp{position:relative;overflow:hidden}
.vp img{position:absolute;display:block;max-width:none}
.card{border-radius:10px;box-shadow:0 24px 50px -18px rgba(30,40,70,.42),0 0 0 1px rgba(20,30,60,.10)}`;

// A framed window (or a frameless card) showing the region (ox, oy) of a raw
// capture at scale s; w/h are the visible content size in frame pixels.
function view({ file, x, y, w, h, ox = 0, oy = 0, s = 1, url = "", card = false, dark = false, z = 1 }) {
  const r = raw(file);
  const img = `<div class="vp" style="width:${w}px;height:${h}px"><img src="${r.uri}" style="width:${r.w * s}px;height:${r.h * s}px;left:${-ox * s}px;top:${-oy * s}px"></div>`;
  if (card) return `<div class="card" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:${z}">${img}</div>`;
  return `<div class="win${dark ? " dark" : ""}" style="left:${x}px;top:${y}px;width:${w}px;z-index:${z}"><div class="bar">
<span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>
<span class="pill">${url}</span></div>${img}</div>`;
}

// ---------- 1280x800 screenshots: one idea each, headline left ----------
const SHOT_CSS = `.s{position:absolute;inset:0;background:#eef1f6;overflow:hidden}
.s::before{content:"";position:absolute;left:0;top:0;bottom:0;width:14px;background:#3b82f6;z-index:9}
.copy{position:absolute;left:62px;top:0;bottom:0;width:452px;display:flex;flex-direction:column;justify-content:center;z-index:8}
.brand{font:600 15px/1 ${SANS};letter-spacing:.2em;color:#2f6fde;margin-bottom:24px}
.head{font-family:${DISPLAY};font-weight:700;font-stretch:75%;font-size:66px;line-height:1.02;color:#13213a;text-transform:uppercase}
.sub{margin-top:26px;font:400 22px/1.45 ${SANS};color:#4a5568;max-width:410px;text-wrap:balance}`;
const shot = ({ head, sub, art }) => `<div class="s"><div class="copy"><div class="brand">BOOKMARK ENHANCED</div>
<div class="head">${head.join("<br>")}</div><div class="sub">${sub}</div></div>${art()}</div>`;

const SHOTS = [
  { id: "1-save", head: ["One click.", "AI does the tags."], sub: "Tags that fit the page, ready to save.",
    art: () => view({ file: "article-page", x: 548, y: 40, w: 760, h: 702, url: "example.com/essays/the-case-for-slow-reading" })
      + view({ file: "popup-tags", card: true, x: 612, y: 96, w: 640, h: Math.round(526 * 640 / 671), s: 640 / 671, z: 2 }) },
  { id: "2-services", head: ["Your server.", "Your bookmarks."], sub: "Save to your own self-hosted server. No Pinboard account needed.",
    art: () => view({ file: "options-account", x: 540, y: 52, w: 760, h: 540, ox: 304, oy: 84, s: 0.86, url: "Settings · Account" })
      + view({ file: "popup-linkding", card: true, x: 742, y: 586, w: 512, h: 196, s: 0.75, z: 2 }) },
  { id: "3-reader", head: ["Read it clean.", "In two languages."], sub: "Each paragraph with its translation right underneath.",
    art: () => view({ file: "reader-bilingual", x: 548, y: 40, w: 760, h: 690, ox: 386, oy: 0, s: 0.92, url: "Reader · The Case for Slow Reading" }) },
  { id: "4-dictionary", head: ["Any word,", "explained."], sub: "Dictionary and AI entry, right beside the text.",
    art: () => view({ file: "reader-lookup", x: 532, y: 48, w: 724, h: 480, ox: 262, oy: 0, s: 0.6, url: "Reader · The Case for Slow Reading" })
      + view({ file: "reader-lookup", card: true, x: 846, y: 92, w: 408, h: 668, ox: 958, oy: 0, s: 0.86, z: 2 }) },
  { id: "5-ask", head: ["Ask the page.", "Get cited answers."], sub: "Every answer points back to the paragraph it came from.",
    art: () => view({ file: "ask-answer", x: 532, y: 48, w: 724, h: 468, ox: 262, oy: 0, s: 0.6, url: "Reader · Ask the page" })
      + view({ file: "ask-answer", card: true, x: 852, y: 92, w: 400, h: 686, ox: 953, oy: 54, s: 0.82, z: 2 }) },
  { id: "6-questions", head: ["Every answer,", "kept."], sub: "Your questions wait in your library, grouped by article.",
    art: () => view({ file: "library-questions", x: 548, y: 40, w: 742, h: 464, s: 0.58, url: "Library · Questions" })
      + view({ file: "library-questions", card: true, x: 588, y: 396, w: 382, h: 356, ox: 32, oy: 108, s: 1.0, z: 2 }) },
  { id: "7-themes", head: ["A fresh look", "for Pinboard."], sub: "Restyle the site you already use.",
    art: () => [["site-none-light", false], ["site-solarized-light", false], ["site-dracula-dark", true], ["site-terminal-dark", true]]
      .map(([f, dark], i) => view({ file: f, x: 556 + i * 64, y: 40 + i * 118, w: 700, h: 438, s: 700 / 1280, url: "pinboard.in", dark, z: i + 1 })).join("") },
];

// ---------- promo tiles ----------
const TILE_CSS = `.t{position:absolute;inset:0;background:#f8f4ec;overflow:hidden}
.say{font-family:${SERIF};font-weight:700;color:#1d1f24;letter-spacing:-.02em;font-variation-settings:"opsz" 72}
.say div{white-space:nowrap}
.hl{position:relative;z-index:0}
.hl::before{content:"";position:absolute;z-index:-1;left:-.07em;right:-.05em;top:.52em;bottom:.1em;border-radius:.14em;background:var(--c);transform:rotate(-1.6deg)}
.y{--c:#f9e3a0}.b{--c:#d3e2fb}.g{--c:#cdeccd}.p{--c:#f6d3dc}`;
const sayHtml = (size, x, y) => `<div class="say" style="position:absolute;left:${x}px;top:${y}px;font-size:${size}px;line-height:1.13">
<div><span class="hl y">Save</span> it.</div><div><span class="hl b">Read</span> it.</div><div><span class="hl g">Keep</span> it.</div></div>`;

const MARQUEE_CSS = `.brandrow{position:absolute;left:612px;top:58px;display:flex;align-items:center;gap:14px;font:600 20px/1 ${SANS};letter-spacing:.24em;color:#1d1f24}
.brandrow img{width:30px;height:30px}
.mc{position:absolute;width:336px;height:190px;background:#fff;border-radius:10px;box-shadow:0 14px 30px -14px rgba(40,40,30,.35),0 0 0 1px rgba(40,40,30,.08);padding:10px 10px 0}
.mc .shot{position:relative;height:132px;border-radius:6px;overflow:hidden;border:1px solid #e7e8ec;background:#fff}
.mc .shot img{position:absolute;display:block;max-width:none}
.mc .lab{display:flex;align-items:center;gap:12px;height:46px;font:600 13.5px/1 ${SANS};letter-spacing:.2em;color:#1d1f24}
.mc .sw{width:24px;height:8px;border-radius:4px;background:var(--c)}
.mc .no{font:italic 400 17px/1 "CWS Serif Italic",${SERIF};letter-spacing:0;color:#6b6f78}
.mc .pin{position:absolute;left:150px;top:-26px;width:38px;height:38px}`;
function markCard({ x, y, file, ox, oy, s, n, label, cls }) {
  const r = raw(file);
  return `<div class="mc ${cls}" style="left:${x}px;top:${y}px"><img class="pin" src="${PIN()}">
<div class="shot"><img src="${r.uri}" style="width:${r.w * s}px;height:${r.h * s}px;left:${-ox * s}px;top:${-oy * s}px"></div>
<div class="lab"><span class="sw"></span><span class="no">${n}</span><span>${label}</span></div></div>`;
}
const MARQUEE = { id: "marquee", w: 1400, h: 560, dsf: 3, out: "marquee-promo-tile-1400x560.png", orig: "marquee-promo-tile.png",
  html: () => `<div class="t">${sayHtml(128, 104, 64)}
<div class="brandrow"><img src="${PIN()}">BOOKMARK ENHANCED</div>
${markCard({ x: 612, y: 120, file: "popup-tags", ox: 84, oy: 245, s: 0.7, n: "01", label: "AI TAGS", cls: "y" })}
${markCard({ x: 972, y: 120, file: "reader-bilingual", ox: 398, oy: 476, s: 0.68, n: "02", label: "BILINGUAL READER", cls: "b" })}
${markCard({ x: 612, y: 340, file: "reader-lookup", ox: 962, oy: 494, s: 0.72, n: "03", label: "WORD LOOKUP", cls: "g" })}
${markCard({ x: 972, y: 340, file: "library-questions", ox: 30, oy: 120, s: 0.9, n: "04", label: "YOUR LIBRARY", cls: "p" })}</div>` };
const SMALL = { id: "small", w: 440, h: 280, dsf: 3, out: "small-promo-tile-440x280.png", orig: "small-promo-tile.png",
  html: () => `<div class="t">${sayHtml(52, 38, 30)}<img src="${PIN()}" style="position:absolute;left:342px;top:180px;width:66px;height:66px"></div>` };

// ---------- render ----------
const PAGES = [
  ...SHOTS.map((d) => ({ id: d.id, w: 1280, h: 800, dsf: 2, out: `screenshot-${d.id}-1280x800.png`, orig: `screenshot-${d.id}.png`, css: SHOT_CSS, html: () => shot(d) })),
  { ...MARQUEE, css: TILE_CSS + MARQUEE_CSS },
  { ...SMALL, css: TILE_CSS },
];
const NEEDS = ["article-page", "popup-tags", "popup-linkding", "options-account", "reader-bilingual", "reader-lookup", "ask-answer", "library-questions",
  "site-none-light", "site-solarized-light", "site-dracula-dark", "site-terminal-dark"];
const missing = NEEDS.filter((n) => !existsSync(rawPath(n)));
if (missing.length) { console.error(`missing raw captures (run node scripts/readme-shots.mjs first): ${missing.join(", ")}`); process.exit(1); }

mkdirSync(ORIG, { recursive: true });
const browser = await chromium.launch({ executablePath: chromium.executablePath() });
try {
  for (const p of PAGES) {
    if (ONLY && !ONLY.has(p.id)) continue;
    const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${fonts()}:root{--w:${p.w}px;--h:${p.h}px}${BASE_CSS}${p.css}</style></head><body>${p.html()}</body></html>`;
    for (const [dsf, file] of [[1, join(OUT, p.out)], [p.dsf, join(ORIG, p.orig)]]) {
      const page = await browser.newPage({ viewport: { width: p.w, height: p.h }, deviceScaleFactor: dsf });
      await page.setContent(doc, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      const png = pngWriteRGB(pngRead(await page.screenshot({ type: "png" })));
      await page.close();
      writeFileSync(file, png);
      console.log("wrote", file.slice(REPO.length + 1), `${p.w * dsf}x${p.h * dsf}`, `${Math.round(png.length / 1024)} KB`);
    }
  }
} finally { await browser.close(); }

// Drop screenshots from an earlier set (renamed or retired ideas).
if (!ONLY) {
  const keep = new Set(SHOTS.flatMap((d) => [`screenshot-${d.id}-1280x800.png`, `screenshot-${d.id}.png`]));
  for (const dir of [OUT, ORIG]) for (const f of readdirSync(dir)) {
    if (/^screenshot-.*\.png$/.test(f) && !keep.has(f)) { rmSync(join(dir, f)); console.log("removed stale", join(dir, f).slice(REPO.length + 1)); }
  }
}
