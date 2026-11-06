#!/usr/bin/env node
// Generates every PNG in icons/ from the geometry below, so the icons have a
// single source. Run: node scripts/gen-icons.mjs [--out=<dir>]
//
// Two families:
//   pin-{default,saved,toread}-*.png  toolbar glyph, no tile, one per bookmark state
//   app-*.png                         tile for the store, chrome://extensions, notifications
//
// Each size has its own numbers on purpose: a pin scaled down from 128 turns to
// mush at 16. States share one silhouette: rimmed grey = not saved, blue = saved,
// blue + dot = unread. Grey and blue differ in lightness on purpose. The toolbar can
// be any color, so each state has an edge: a dark rim on grey, a white halo on blue.
// The tile keeps the store's 96px artwork + 16px padding.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(REPO, '.qa-scan/package.json'));
const { chromium } = require('playwright');

const BLUE = '#0066ff';
const BLUE_TOP = '#1f7bff';
const GREY = '#b4b8bd';
const RIM = '#54585d';
const AMBER = '#f5a623';

const GLYPH = {
  16: { capHW: 4.45, capT: -8.15, capH: 2.2, waist: 3.05, flareY: -0.6, skirtHW: 5.95, skirtB: 1.95, needle: 0.8, tip: 7.5, sw: 1.1, halo: 0.6, cx: 6.35, cy: 9.65, r: 2.8, dx: 12.9, dy: 12.9 },
  32: { capHW: 8.9, capT: -16.3, capH: 4.4, waist: 6.1, flareY: -1.2, skirtHW: 11.9, skirtB: 3.9, needle: 1.6, tip: 15, sw: 2.2, halo: 1.1, cx: 12.7, cy: 19.3, r: 5.4, dx: 25.9, dy: 25.9 },
  48: { capHW: 13.35, capT: -24.45, capH: 6.6, waist: 9.15, flareY: -1.8, skirtHW: 17.85, skirtB: 5.85, needle: 2.4, tip: 22.5, sw: 3.3, halo: 1.6, cx: 19.05, cy: 28.95, r: 8, dx: 38.8, dy: 38.8 },
  128: { capHW: 35.6, capT: -65.2, capH: 17.6, waist: 24.4, flareY: -4.8, skirtHW: 47.6, skirtB: 15.6, needle: 6.4, tip: 60, sw: 8.8, halo: 4.4, cx: 50.8, cy: 77.2, r: 21.5, dx: 103.5, dy: 103.5 },
};
// shift moves the pin toward the upper right. Its mass is already centered, but the
// point reaches the lower left while the flat cap stops short of the upper right,
// so a mass-centered pin looks low and left. This settles halfway to the extents.
const TILE = {
  16: { pad: 0, rx: 3.4, scale: 0.7, shift: 0.3 },
  32: { pad: 1, rx: 6.5, scale: 0.62, shift: 0.7 },
  48: { pad: 3, rx: 8.5, scale: 0.56, shift: 1 },
  128: { pad: 16, rx: 22, scale: 0.5, shift: 2.6 },
};

const fix = (value) => +value.toFixed(2);

function bodyPath(p) {
  const neck = fix(p.capT + p.capH);
  const shoulder = fix(p.skirtB - p.capH * 0.55);
  return `M${-p.capHW} ${p.capT}H${p.capHW}V${neck}H${p.waist}V${p.flareY}L${p.skirtHW} ${shoulder}`
    + `V${p.skirtB}H${-p.skirtHW}V${shoulder}L${-p.waist} ${p.flareY}V${neck}H${-p.capHW}Z`;
}

// Drawn upright, then turned so the point faces lower left.
const tilted = (p, inner) => `<g transform="translate(${p.cx} ${p.cy}) rotate(45)">${inner}</g>`;

const needle = (p, fill, width) => `<path d="M${-p.needle} ${p.skirtB}L0 ${p.tip}L${p.needle} ${p.skirtB}Z" fill="${fill}" stroke="${fill}" stroke-width="${fix(width * 0.5)}" stroke-linejoin="round"/>`;

const solid = (p, fill, width) => `<path d="${bodyPath(p)}" fill="${fill}" stroke="${fill}" stroke-width="${width}" stroke-linejoin="round"/>${needle(p, fill, width)}`;

function toolbarSvg(state, size) {
  const p = GLYPH[size];
  // Chrome has no dark variant for action icons, so one image must hold on both.
  // The mid fill carries a dark toolbar and the dark rim carries a light one. Both
  // are opaque: translucent layers melted into a soft smear on dark toolbars.
  if (state === 'default') return tilted(p, solid(p, RIM, p.sw + p.halo * 2.5) + solid(p, GREY, p.sw));
  const pin = tilted(p, solid(p, '#fff', p.sw + p.halo * 2) + solid(p, BLUE, p.sw));
  if (state === 'saved') return pin;
  return `${pin}<circle cx="${p.dx}" cy="${p.dy}" r="${fix(p.r * 1.3)}" fill="#fff"/><circle cx="${p.dx}" cy="${p.dy}" r="${p.r}" fill="${AMBER}"/>`;
}

function appSvg(size) {
  const p = GLYPH[size];
  const t = TILE[size];
  const side = size - t.pad * 2;
  const mid = size / 2;
  return `<defs><linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BLUE_TOP}"/><stop offset="1" stop-color="${BLUE}"/></linearGradient></defs>`
    + `<rect x="${t.pad}" y="${t.pad}" width="${side}" height="${side}" rx="${t.rx}" fill="url(#tile)"/>`
    + `<g transform="translate(${mid + t.shift} ${mid - t.shift}) scale(${t.scale}) translate(${-mid} ${-mid})">${tilted(p, solid(p, '#fff', p.sw))}</g>`;
}

const outArg = process.argv.find((arg) => arg.startsWith('--out='));
const outDir = outArg ? outArg.slice('--out='.length) : join(REPO, 'icons');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 200, height: 200 }, deviceScaleFactor: 1 })).newPage();
async function write(name, body, size) {
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`);
  writeFileSync(join(outDir, name), await page.locator('svg').screenshot({ omitBackground: true }));
}
for (const size of [16, 32, 48, 128]) {
  await write(`app-${size}.png`, appSvg(size), size);
  for (const state of ['default', 'saved', 'toread']) await write(`pin-${state}-${size}.png`, toolbarSvg(state, size), size);
}
await browser.close();
console.log(`wrote 16 icons to ${outDir}`);
