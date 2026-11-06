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
//   node scripts/cws-shots.mjs --only 3-save,marquee
//   node scripts/cws-shots.mjs --out <dir>   # try a set outside the repo
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
const argOut = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "";
const OUT = argOut ? resolve(argOut) : join(REPO, "docs/cws-assets");
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
// PIN is the object that holds a card down; LOGO is the brand mark. app-128 has the
// store's 16px transparent margin, so show it at 4/3 the visible size you want.
const PIN = () => b64file(join(REPO, "icons/pin-saved-128.png"), "image/png");
const LOGO = () => b64file(join(REPO, "icons/app-128.png"), "image/png");
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
// A line from the clicked citation down to the sentence it opened.
const ASK_CHIP = { x: 740, y: 527 }, ASK_QUOTE = { x: 1150, y: 654 };
const citeLink = (c) => `<svg style="position:absolute;inset:0;z-index:3" width="1280" height="800" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
<circle cx="${c.x}" cy="${c.y}" r="21"/><path d="M${c.x + 21} ${c.y + 4}C${c.x + 240} ${c.y + 36} ${ASK_QUOTE.x} ${ASK_QUOTE.y - 92} ${ASK_QUOTE.x} ${ASK_QUOTE.y}"/>
<path d="M${ASK_QUOTE.x - 9} ${ASK_QUOTE.y - 11}L${ASK_QUOTE.x} ${ASK_QUOTE.y}L${ASK_QUOTE.x + 9} ${ASK_QUOTE.y - 11}"/></svg>`;
// The library's saved answer: question, then answer. The date and model line
// between them is cut; it says nothing to someone looking at the store.
function answerCard({ x, y, w }) {
  const r = raw("library-answer-sources"), s = 0.86, ox = 418;
  const part = (oy, h) => `<div class="vp" style="width:${w}px;height:${h}px"><img src="${r.uri}" style="width:${r.w * s}px;height:${r.h * s}px;left:${-ox * s}px;top:${-oy * s}px"></div>`;
  return `<div class="card" style="left:${x}px;top:${y}px;width:${w}px;z-index:2;background:#f7f7f7"><div style="height:10px"></div>${part(236, 30)}<div style="height:8px"></div>${part(300, 180)}</div>`;
}
const SHOT_CSS = `.s{position:absolute;inset:0;background:#eef1f6;overflow:hidden}
.s::before{content:"";position:absolute;left:0;top:0;bottom:0;width:14px;background:#3b82f6;z-index:9}
.copy{position:absolute;left:62px;top:0;bottom:0;width:450px;display:flex;flex-direction:column;justify-content:center;z-index:8}
.brand{font:600 18px/1 ${SANS};letter-spacing:.2em;color:#2f6fde;margin-bottom:26px}
.head{font-family:${DISPLAY};font-weight:700;font-stretch:75%;font-size:76px;line-height:1.02;color:#13213a;text-transform:uppercase;white-space:nowrap}
.sub{margin-top:30px;font:400 27px/1.42 ${SANS};color:#4a5568;max-width:440px;text-wrap:balance}`;
const shot = ({ head, sub, art }) => `<div class="s"><div class="copy"><div class="brand">BOOKMARK ENHANCED</div>
<div class="head">${head.join("<br>")}</div><div class="sub">${sub}</div></div>${art()}</div>`;

// The store shows five screenshots at most, so this set is five, reading first.
const SHOTS = [
  { id: "1-reader", head: ["Read it clean.", "In two languages."], sub: "Each paragraph with its translation right underneath.",
    art: () => view({ file: "reader-bilingual", x: 548, y: 40, w: 760, h: 690, ox: 386, oy: 0, s: 0.92, url: "Reader · The Case for Slow Reading" }) },
  { id: "2-ask", head: ["Ask the page.", "Get cited answers."], sub: "Every answer points back to the paragraph it came from.",
    art: () => view({ file: "ask-cited", card: true, x: 590, y: 30, w: 563, h: 514, ox: 953, oy: 54, s: 1.18, z: 1 })
      + view({ file: "ask-cited", card: true, x: 540, y: 566, w: 708, h: 198, ox: 256, oy: 412, s: 1.02, z: 2 })
      + citeLink(ASK_CHIP) },
  { id: "3-save", head: ["Save to the service", "you choose."], sub: "Pinboard or your own server. AI tags use your own API key.",
    art: () => view({ file: "options-services", card: true, x: 560, y: 30, w: 686, h: 212, z: 1 })
      + view({ file: "popup-save", card: true, x: 590, y: 262, w: 640, h: Math.round(530 * 640 / 671), s: 640 / 671, z: 2 }) },
  { id: "4-dictionary", head: ["Any word,", "explained."], sub: "Dictionary and AI entry, right beside the text.",
    art: () => view({ file: "reader-lookup", x: 532, y: 48, w: 724, h: 480, ox: 262, oy: 0, s: 0.6, url: "Reader · The Case for Slow Reading" })
      + view({ file: "reader-lookup", card: true, x: 846, y: 92, w: 408, h: 630, ox: 958, oy: 0, s: 0.86, z: 2 }) },
  { id: "5-library", head: ["Words and answers,", "kept."], sub: "Find them again in your library.",
    art: () => view({ file: "vocab-detail-crop", x: 548, y: 40, w: 720, h: 380, ox: 50, oy: 20, s: 0.86, url: "Library · Vocabulary" })
      + answerCard({ x: 600, y: 446, w: 640 }) },
];

// ---------- promo tiles ----------
// Chrome asks tiles to carry the brand: little text, strong colour, no plain
// screenshot, and still clear at half size.
const TILE = { bg: "#2563eb", ink: "#ffffff", hlInk: "#10203f", y: "#ffd84d", b: "#9bdcff", g: "#86eab0", top: ".04em", bottom: ".08em" };
const TILE_CSS = (th) => `.t{position:absolute;inset:0;background:${th.bg};overflow:hidden}
.say{font-family:${SERIF};font-weight:700;color:${th.ink};letter-spacing:-.02em;font-variation-settings:"opsz" 72}
.say div{white-space:nowrap}
.hl{position:relative;z-index:0;color:${th.hlInk}}
.hl::before{content:"";position:absolute;z-index:-1;left:-.07em;right:-.05em;top:${th.top};bottom:${th.bottom};border-radius:.14em;background:var(--c);transform:rotate(-1.6deg)}
.y{--c:${th.y}}.b{--c:${th.b}}.g{--c:${th.g}}`;
const sayHtml = (size, x, y) => `<div class="say" style="position:absolute;left:${x}px;top:${y}px;font-size:${size}px;line-height:1.13">
<div><span class="hl y">Save</span> it.</div><div><span class="hl b">Read</span> it.</div><div><span class="hl g">Keep</span> it.</div></div>`;
const tileMark = (size, x, y) => `<div style="position:absolute;left:${x + size * 0.125}px;top:${y + size * 0.125}px;width:${size * 0.75}px;height:${size * 0.75}px;border-radius:22%;background:#fff;display:grid;place-items:center"><img src="${PIN()}" style="width:68%;height:68%"></div>`;

const MARQUEE_CSS = `.mk{position:absolute;left:560px;width:790px;height:152px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 14px 30px -14px rgba(10,20,50,.45)}
.mk img{position:absolute;display:block;max-width:none}
.lock{position:absolute;left:68px;top:476px;display:flex;align-items:center;gap:12px;font:600 19px/1 ${SANS};letter-spacing:.2em}`;
const clip = ({ file, ox, oy, s, x, y, w, h }) => { const r = raw(file);
  return `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;overflow:hidden"><img src="${r.uri}" style="width:${r.w * s}px;height:${r.h * s}px;left:${-ox * s}px;top:${-oy * s}px"></div>`; };
const markRow = (y, bg, ...parts) => `<div class="mk" style="top:${y}px;background:${bg}">${parts.map(clip).join("")}</div>`;
const MARQUEE = { id: "marquee", w: 1400, h: 560, dsf: 3, out: "marquee-promo-tile-1400x560.png", orig: "marquee-promo-tile.png", css: TILE_CSS(TILE) + MARQUEE_CSS,
  html: () => `<div class="t">${sayHtml(116, 68, 46)}
<div class="lock" style="color:${TILE.ink}">BOOKMARK ENHANCED</div>
${markRow(46, "#fff", { file: "popup-save", ox: 40, oy: 399, s: 1.25, x: 30, y: 24, w: 616, h: 44 }, { file: "popup-save", ox: 101, oy: 492, s: 1.25, x: 106, y: 84, w: 134, h: 46 })}
${markRow(210, "#fffdf0", { file: "reader-bilingual", ox: 384, oy: 478, s: 1.3, x: 0, y: 0, w: 790, h: 152 })}
${markRow(374, "#f7f7f7", { file: "vocab-detail-crop", ox: 136, oy: 66, s: 0.8, x: 0, y: 0, w: 660, h: 152 })}</div>` };
const SMALL = { id: "small", w: 440, h: 280, dsf: 3, out: "small-promo-tile-440x280.png", orig: "small-promo-tile.png", css: TILE_CSS(TILE),
  html: () => `<div class="t">${sayHtml(56, 34, 44)}${tileMark(124, 298, 78)}</div>` };

// ---------- render ----------
const PAGES = [
  ...SHOTS.map((d) => ({ id: d.id, w: 1280, h: 800, dsf: 2, out: `screenshot-${d.id}-1280x800.png`, orig: `screenshot-${d.id}.png`, css: SHOT_CSS, html: () => shot(d) })),
  MARQUEE, SMALL,
];
const NEEDS = ["popup-save", "options-services", "reader-bilingual", "reader-lookup", "ask-cited", "vocab-detail-crop", "library-answer-sources"];
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
      // A headline line never wraps: shrink that image's headline until its longest line fits the copy column.
      await page.evaluate(() => { for (const h of document.querySelectorAll(".head")) {
        let size = parseFloat(getComputedStyle(h).fontSize);
        while (h.scrollWidth > h.clientWidth && size > 40) h.style.fontSize = `${--size}px`;
      } });
      const png = pngWriteRGB(pngRead(await page.screenshot({ type: "png" })));
      await page.close();
      writeFileSync(file, png);
      console.log("wrote", file.replace(REPO + "/", ""), `${p.w * dsf}x${p.h * dsf}`, `${Math.round(png.length / 1024)} KB`);
    }
  }
} finally { await browser.close(); }

// Drop screenshots from an earlier set (renamed or retired ideas).
if (!ONLY && !argOut) {
  const keep = new Set(SHOTS.flatMap((d) => [`screenshot-${d.id}-1280x800.png`, `screenshot-${d.id}.png`]));
  for (const dir of [OUT, ORIG]) for (const f of readdirSync(dir)) {
    if (/^screenshot-.*\.png$/.test(f) && !keep.has(f)) { rmSync(join(dir, f)); console.log("removed stale", join(dir, f).slice(REPO.length + 1)); }
  }
}
