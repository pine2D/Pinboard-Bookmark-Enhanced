// Real generated site CSS against independently hand-written native page shapes.
// Catches missing selectors, inline state colors and ancestor-opacity regressions
// that palette-pair assertions cannot see. No login or network is required.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { chromium } from '../.qa-scan/node_modules/playwright/index.mjs';

const themes = vm.runInNewContext(readFileSync(new URL('../pinboard-themes.js', import.meta.url), 'utf8') + '; PINBOARD_THEMES');
const variants = Object.entries(themes).map(([key, { css }]) => ({ key, css, dark: false }));
variants.push({ key: 'flexoki:dark', css: themes.flexoki.css, dark: true });
const failures = [];
let checks = 0;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route(/^https?:/, route => route.abort());
  await page.goto(new URL('./fixtures/pinboard-theme-pages.html', import.meta.url).href);
  await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' });
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'theme-under-test';
    document.head.append(style);
  });

  async function fixture(name) {
    await page.evaluate(name => {
      document.getElementById('content').replaceChildren(document.querySelector('template#' + name).content.cloneNode(true));
    }, name);
    await page.mouse.move(1400, 950);
  }

  // Composite both the ink pixel and the background-only pixel from the leaf
  // outward. Each ancestor's opacity applies to the whole group, including its
  // own background; multiplying text alpha alone would miss nested surfaces.
  async function readable(key, selector, minimum = 4.5) {
    // A palette change or pointer move can start a color transition. Measure
    // its settled state rather than an arbitrary intermediate animation frame.
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => {}))));
    const rows = await page.locator(selector).evaluateAll(nodes => {
      const rgba = value => {
        const parts = value.match(/[\d.]+/g).map(Number);
        return [...parts.slice(0, 3), parts[3] ?? 1];
      };
      const over = (a, b) => {
        const alpha = a[3] + b[3] * (1 - a[3]);
        return alpha ? [...[0, 1, 2].map(i => (a[i] * a[3] + b[i] * b[3] * (1 - a[3])) / alpha), alpha] : [0, 0, 0, 0];
      };
      const luminance = c => c.slice(0, 3).map(v => {
        v /= 255;
        return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
      }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      return nodes.map(node => {
        let ink = rgba(getComputedStyle(node).color), background = [0, 0, 0, 0];
        for (let el = node; el; el = el.parentElement) {
          const style = getComputedStyle(el), fill = rgba(style.backgroundColor);
          ink = over(ink, fill); background = over(background, fill);
          ink[3] *= Number(style.opacity); background[3] *= Number(style.opacity);
        }
        const a = luminance(over(ink, [255, 255, 255, 1]));
        const b = luminance(over(background, [255, 255, 255, 1]));
        return { element: node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (node.className ? '.' + node.className.trim().replaceAll(' ', '.') : ''), ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), visible: node.checkVisibility() && node.getBoundingClientRect().height > 0 };
      });
    });
    assert.ok(rows.length, `fixture selector missing: ${selector}`);
    for (const row of rows) {
      checks++;
      if (!row.visible || row.ratio < minimum) failures.push(`${key} ${row.element}: ${row.ratio.toFixed(3)} < ${minimum}${row.visible ? '' : ' (hidden)'}`);
    }
  }

  for (const variant of variants) {
    await page.evaluate(({ css, dark }) => {
      document.getElementById('theme-under-test').textContent = css;
      document.documentElement.classList.toggle('pbp-dark', dark);
    }, variant);
    const { key } = variant;
    for (const [name, selector] of [
      ['note', 'blockquote.note, blockquote.note p, blockquote.note strong'],
      ['help', '#help_banner .logo, #help_content .tagNode'],
      ['howto', 'a.bookmarklet, code, tt, span.private, a.bundle.private'],
      ['editor', '#edit_bookmark_form p, #edit_bookmark_form label'],
      ['status', '#status_display'], ['token', '.api_token'],
      ['nav', '#sub_banner a.selected'], ['completion', '.pin-ac .active'],
    ]) {
      await fixture(name);
      await readable(key, selector);
      if (name === 'help') {
        await page.locator('.tagSelected').hover();
        await readable(key + ':hover', '.tagSelected');
      }
      if (name === 'nav') {
        await page.locator('a.selected').hover();
        await readable(key + ':hover', 'a.selected');
      }
    }
    await fixture('bulk');
    // The native toggle writes these two states, not a class on the link.
    for (const color of ['#aaa', '#fff']) {
      await page.locator('#bulk_edit').evaluate((node, color) => { node.style.cssText = `background:${color};color:#fff;border:1px solid #999`; }, color);
      await readable(`${key}:bulk-${color}`, '#bulk_edit');
    }
    await fixture('bookmarks');
    await readable(key, '.description, .description blockquote');
    await readable(key, '.star span', 3);
    await page.locator('.private .star').hover();
    await readable(key + ':hover', '.private .star span', 3);
    for (const [name, selector] of [['subscriptions', 'a.delete'], ['bundles', 'a.edit, a.destroy']]) {
      await fixture(name);
      await readable(key, selector);
      await page.locator('tr').hover();
      await readable(key + ':row-hover', selector);
    }
    await fixture('tag-nav');
    await readable(key, '#tag_cloud_header a');
    const sizes = await page.locator('#tag_cloud_header a').evaluateAll(nodes => nodes.map(n => parseFloat(getComputedStyle(n).fontSize)));
    for (const size of sizes) {
      checks++;
      if (size < 11) failures.push(`${key} tag navigation text shrank to ${size}px`);
    }
    for (const name of ['import-layout', 'toc-layout']) {
      await fixture(name);
      for (const width of [390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        const layout = await page.evaluate(() => {
          const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom }; };
          const history = document.getElementById('import_history_table');
          return { width: document.documentElement.scrollWidth, first: rect(history ? 'settings_panel' : 'left_toc'), second: rect(history ? 'import_history_table' : 'content_column') };
        });
        checks++;
        if (width < 1100) {
          if (layout.width > width || layout.second.right > width || layout.second.y < layout.first.bottom) failures.push(`${key} ${name}@${width}: narrow columns overflow or overlap ${JSON.stringify(layout)}`);
        } else if (layout.second.x < layout.first.right) failures.push(`${key} ${name}: desktop columns no longer side by side`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await fixture('widget');
    for (const state of ['rest', 'hover']) {
      if (state === 'hover') await page.locator('#right_column > div a').first().hover();
      const colors = await page.locator('#right_column > div a').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).color));
      checks++;
      if (colors.join('|') !== 'rgb(162, 97, 49)|rgb(140, 84, 42)') failures.push(`${key} widget:${state} replaced preview colors: ${colors}`);
    }
    await readable(key, '#right_column > p a');
    await fixture('blog-sidebar');
    await readable(key, '#right_column a');
  }
} finally {
  await browser.close();
}
if (failures.length) console.error(failures.slice(0, 45).join('\n'));
assert.equal(failures.length, 0, `${failures.length}/${checks} Pinboard render checks failed`);
console.log(`Pinboard theme render: ${checks} checks passed across ${variants.length} theme states`);
