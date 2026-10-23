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
      // Real native structures, synthetic content. Stress size and wrapping;
      // these inputs must not be derived from the theme's CSS or token values.
      if (name === 'tag-list') {
        document.querySelectorAll('.tag_table tbody').forEach((body, column) => {
          for (let i = 0; i < 508; i++) {
            const cell = body.insertRow().insertCell();
            cell.setAttribute('width', '138'); cell.style.overflow = 'hidden';
            const link = document.createElement('a'); link.className = 'tag'; link.href = '#tag';
            link.textContent = `${column ? 'topic' : 'archive'}-${i}` + (i % 97 === 0 ? '-long-unbroken-标签名称'.repeat(3) : '');
            link.style.fontSize = i % 17 === 0 ? '110%' : '100%';
            cell.append(link);
          }
        });
      }
      if (name === 'toc-layout') {
        const list = document.querySelector('#left_toc ul');
        for (let i = 0; i < 65; i++) {
          const li = document.createElement('li'), link = document.createElement('a');
          link.href = '#answer'; link.textContent = `How do I manage my saved bookmarks and tags? (${i + 1})`;
          li.append(link); list.append(li);
        }
      }
      if (name === 'bundle-density') {
        const body = document.querySelector('form[name="sort"] tbody');
        for (let i = 0; i < 16; i++) {
          const row = body.insertRow();
          const input = document.createElement('input'); input.name = `id_${i}`; input.type = 'text'; input.value = String(i + 1);
          input.style.cssText = 'border:1px dotted #bbb;width:20px;margin-right:10px';
          row.insertCell().append(input);
          const nameCell = row.insertCell(); nameCell.setAttribute('style', 'text-align:right');
          const bundle = document.createElement('a'); bundle.className = 'bundle'; bundle.href = '#bundle';
          bundle.textContent = ['Main topic classifications', 'archive_reference_collection_2026', 'Reading'][i % 3]; nameCell.append(bundle);
          const tags = row.insertCell();
          for (let j = 0; j < [1, 6, 12, 4][i % 4]; j++) {
            const link = document.createElement('a'); link.className = 'tag'; link.href = '#tag';
            link.textContent = ['agriculture', 'cooking', 'literature', 'technology'][j % 4]; tags.append(link, ' ');
          }
          const edit = document.createElement('a'); edit.className = 'edit'; edit.href = '#edit'; edit.textContent = 'edit'; row.insertCell().append(edit);
          const destroy = document.createElement('a'); destroy.className = 'destroy'; destroy.href = '#delete'; destroy.textContent = 'delete';
          const actions = row.insertCell(); actions.setAttribute('width', '100'); actions.append(destroy);
        }
      }
    }, name);
    await page.mouse.move(1400, 950);
  }

  // Composite both the ink pixel and the background-only pixel from the leaf
  // outward. Each ancestor's opacity applies to the whole group, including its
  // own background; multiplying text alpha alone would miss nested surfaces.
  async function readable(key, selector, minimum = 4.5, requireHover = false) {
    // A palette change or pointer move can start a color transition. Measure
    // its settled state rather than an arbitrary intermediate animation frame.
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => {}))));
    const rows = await (typeof selector === 'string' ? page.locator(selector) : selector).evaluateAll(nodes => {
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
        return { element: node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (node.className ? '.' + node.className.trim().replaceAll(' ', '.') : ''), ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), visible: node.checkVisibility() && node.getBoundingClientRect().height > 0, hovered: node.matches(':hover') };
      });
    });
    assert.ok(rows.length, `fixture selector missing: ${selector}`);
    for (const row of rows) {
      checks++;
      if (!row.visible || row.ratio < minimum) failures.push(`${key} ${row.element}: ${row.ratio.toFixed(3)} < ${minimum}${row.visible ? '' : ' (hidden)'}`);
      if (requireHover && !row.hovered) failures.push(`${key} ${row.element}: requested hover state was lost`);
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
    // Native sidebar/Tweets submit labels must stay readable after all dark
    // mode and literal overrides, not just in the derived palette pairs.
    for (const name of ['search-sidebar', 'search-tweets']) {
      await fixture(name);
      const selector = '#right_bar input[type="submit"]';
      await readable(`${key}:${name}`, selector);
      const buttons = page.locator(selector);
      for (let i = 0; i < await buttons.count(); i++) {
        await buttons.nth(i).hover();
        await readable(`${key}:${name}:hover`, `${selector}:hover`);
      }
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
    await fixture('tag-list');
    const tagLayout = await page.evaluate(() => {
      const columns = [...document.querySelectorAll('.tag_table')].map(n => n.getBoundingClientRect().toJSON());
      const clipped = [...document.querySelectorAll('.tag_table td')].filter(n => n.scrollWidth > n.clientWidth + 1).length;
      return { columns, clipped, count: document.querySelectorAll('.tag_table a.tag').length };
    });
    checks++;
    if (tagLayout.count !== 1016 || Math.abs(tagLayout.columns[0].y - tagLayout.columns[1].y) > 1 || tagLayout.columns[1].x < tagLayout.columns[0].right || tagLayout.clipped) {
      failures.push(`${key} tag list loses columns or clips labels: ${JSON.stringify(tagLayout)}`);
    }
    await fixture('tag-cloud');
    const cloud = await page.locator('#tag_cloud a.tag').evaluateAll(nodes => nodes.map(n => ({ size: parseFloat(getComputedStyle(n).fontSize), display: getComputedStyle(n).display })));
    checks++;
    if (cloud.some(n => n.display !== 'inline') || cloud[1].size / cloud[0].size < 2) failures.push(`${key} frequency-sized inline cloud was flattened`);
    {
      await fixture('sidebar-tag-frequency');
      const selector = '#tag_cloud a.tag:not(.selected)';
      await readable(`${key}:low-frequency`, selector);
      const frequency = await page.locator(selector).evaluateAll(nodes => nodes.map(n => {
        const s = getComputedStyle(n), r = n.getBoundingClientRect();
        return { opacity: s.opacity, size: parseFloat(s.fontSize), width: r.width, height: r.height };
      }));
      checks++;
      if (frequency.map(n => n.opacity).join('|') !== '0.7|0.83|1|0.71|0.91' || frequency[2].size / frequency[0].size < 2) failures.push(`${key} native frequency tiers changed`);
      const tags = page.locator(selector);
      for (let i = 0; i < await tags.count(); i++) {
        // Exercise the faint Latin/CJK boundary. The reduced native table's
        // fixed line-height can overlap a large tag with the row above it.
        if (Number(frequency[i].opacity) > .71) continue;
        await tags.nth(i).hover();
        await readable(`${key}:low-frequency:hover`, `${selector}:hover`);
        const size = await tags.nth(i).evaluate(n => { const r = n.getBoundingClientRect(); return { width: r.width, height: r.height, opacity: getComputedStyle(n).opacity }; });
        checks++;
        if (size.width !== frequency[i].width || size.height !== frequency[i].height || size.opacity !== frequency[i].opacity) failures.push(`${key} tag hover changes size or frequency opacity`);
      }
      await page.mouse.move(1400, 950);
      const scope = await page.evaluate(() => {
        const ink = selector => getComputedStyle(document.querySelector(selector)).color;
        return { selected: ink('#tag_cloud .selected'), control: ink('.bookmark .selected'), outside: ink('#right_bar > a.tag'), body: ink('.bookmark a.tag:not(.selected)') };
      });
      checks++;
      if (scope.selected !== scope.control || scope.outside !== scope.body) failures.push(`${key} sidebar tag colors leak outside the unselected cloud`);
      const selectedHover = [];
      for (const selected of ['#tag_cloud .selected', '.bookmark .selected']) {
        await page.locator(selected).hover();
        selectedHover.push(await page.locator(selected).evaluate(n => getComputedStyle(n).color));
      }
      checks++;
      if (selectedHover[0] !== selectedHover[1]) failures.push(`${key} sidebar selected-tag hover was recolored`);
    }
    await fixture('bundle-editor');
    await readable(`${key}:bundle-editor`, '#tagpicker .tagNode, #bundle .tagNode, #save_changes_marker, #tagPickerSelectLinks span');
    // Native arrow glyphs are graphical controls, like the star above; their
    // 3:1 floor is separate from save/filter/tag text's 4.5:1 floor.
    await readable(`${key}:bundle-move`, '#tagPickerNav input[type="button"]', 3);
    const pickerTags = page.locator('#tagpicker .tagNode, #bundle .tagNode');
    for (let i = 0; i < await pickerTags.count(); i++) {
      const tag = pickerTags.nth(i);
      const before = await tag.evaluate(n => {
        const r = n.getBoundingClientRect(), s = getComputedStyle(n);
        return { x: r.x, y: r.y, width: r.width, height: r.height, fontSize: s.fontSize, opacity: s.opacity };
      });
      for (const selected of [false, true]) {
        await page.mouse.move(1400, 950);
        await tag.evaluate((n, selected) => n.classList.toggle('tagSelected', selected), selected);
        if (selected) await readable(`${key}:bundle-editor:selected`, tag);
        await tag.hover();
        await readable(`${key}:bundle-editor:${selected ? 'selected-hover' : 'hover'}`, tag, 4.5, true);
        const after = await tag.evaluate(n => {
          const r = n.getBoundingClientRect(), s = getComputedStyle(n);
          return { x: r.x, y: r.y, width: r.width, height: r.height, fontSize: s.fontSize, opacity: s.opacity };
        });
        checks++;
        if (JSON.stringify(after) !== JSON.stringify(before)) failures.push(`${key} bundle tag ${selected ? 'selected-hover' : 'hover'} shifts native geometry or frequency: ${JSON.stringify({ before, after })}`);
      }
      await tag.evaluate(n => n.classList.remove('tagSelected'));
    }
    // TagPicker's hilight()/unhilight() write inline yellow/white fills.
    // Exercise both links in both states rather than pinning one current ID.
    const filterLinks = page.locator('#tagPickerSelectLinks a[id]');
    for (const active of [0, 1]) {
      await page.mouse.move(1400, 950);
      await filterLinks.evaluateAll((nodes, active) => nodes.forEach((n, i) => { n.style.backgroundColor = i === active ? '#ffffaa' : '#fff'; }), active);
      await readable(`${key}:bundle-filter`, '#tagPickerSelectLinks a[id]');
      for (let i = 0; i < await filterLinks.count(); i++) {
        await filterLinks.nth(i).hover();
        await readable(`${key}:bundle-filter:hover`, '#tagPickerSelectLinks a[id]:hover');
      }
    }
    for (const [selector, minimum] of [['#save_changes_marker', 4.5], ['#tagPickerNav input[type="button"]', 3]]) {
      for (let i = 0; i < await page.locator(selector).count(); i++) {
        await page.locator(selector).nth(i).hover();
        await readable(`${key}:bundle-action:hover`, `${selector}:hover`, minimum);
      }
    }
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.mouse.move(1, 1);
      const layout = await page.evaluate(() => {
        const rect = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        const toolbar = document.getElementById('tagPickerNav');
        const row = document.querySelector('#bundle_column > form > div:first-of-type');
        const column = document.getElementById('bundle_column');
        const bundle = document.getElementById('bundle');
        const rowParts = [...row.children].map(rect);
        return { toolbar: rect(toolbar), toolbarControls: [...toolbar.querySelectorAll('input, a')].map(rect), row: rect(row), rowParts, rowControls: [...row.querySelectorAll('input, a')].map(rect), column: rect(column), bundle: rect(bundle), table: rect(column.querySelector('table')) };
      });
      // Native bundle columns can overflow a phone viewport. Protect controls
      // inside their own native-sized rows, without redesigning that model.
      const within = (child, parent) => child.width > 0 && child.height > 0 && child.x >= parent.x - 1 && child.right <= parent.right + 1 && child.y >= parent.y - 1 && child.bottom <= parent.bottom + 1;
      const controlsOverlap = controls => controls.some((a, i) => controls.slice(i + 1).some(b => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1));
      checks++;
      if (!layout.toolbarControls.every(r => within(r, layout.toolbar)) || controlsOverlap(layout.toolbarControls)) failures.push(`${key} bundle toolbar controls escape their row or overlap@${width}: ${JSON.stringify(layout)}`);
      checks++;
      if (!layout.rowControls.every(r => within(r, layout.row)) || layout.rowParts[0].right > layout.rowParts[1].x + 1 || layout.rowParts[0].y >= layout.rowParts[1].bottom || layout.rowParts[1].y >= layout.rowParts[0].bottom) failures.push(`${key} bundle name/save controls wrap or overlap@${width}: ${JSON.stringify(layout)}`);
      checks++;
      if (layout.table.width < layout.column.width - 2 || layout.bundle.right > layout.column.right + 1) failures.push(`${key} bundle table shrinks or overflows its column@${width}: ${JSON.stringify(layout)}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await fixture('bundle-density');
    const bundleLayout = await page.evaluate(() => {
      const table = document.querySelector('form[name="sort"] > table');
      const style = document.getElementById('theme-under-test'), css = style.textContent;
      // Compare native table geometry in the SAME font family: a monospace
      // theme naturally wraps sooner than native Arial. No theme spacing,
      // widths or line-height rules are used to construct the reference.
      const family = getComputedStyle(table.querySelector('td')).fontFamily;
      style.textContent = ''; document.body.style.fontFamily = family;
      const native = table.getBoundingClientRect().toJSON();
      document.body.style.fontFamily = ''; style.textContent = css;
      return { native, themed: table.getBoundingClientRect().toJSON() };
    });
    checks++;
    if (bundleLayout.themed.width < bundleLayout.native.width - 1 || bundleLayout.themed.height > bundleLayout.native.height * 1.35) failures.push(`${key} bundle density: ${JSON.stringify(bundleLayout)}`);
    for (const name of ['import-layout', 'toc-layout']) {
      await fixture(name);
      for (const width of [390, 641, 768, 1024, 1080, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        const layout = await page.evaluate(() => {
          const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom }; };
          const history = document.getElementById('import_history_table');
          const image = document.querySelector('#content_column img');
          const imageStyle = image && getComputedStyle(image);
          const imageRatio = image && (image.getBoundingClientRect().width - parseFloat(imageStyle.borderLeftWidth) - parseFloat(imageStyle.borderRightWidth)) / (image.getBoundingClientRect().height - parseFloat(imageStyle.borderTopWidth) - parseFloat(imageStyle.borderBottomWidth));
          return { width: document.documentElement.scrollWidth, firstVisible: (history || document.getElementById('left_toc')).checkVisibility(), first: rect(history ? 'settings_panel' : 'left_toc'), second: rect(history ? 'import_history_table' : 'content_column'), imageRatio };
        });
        checks++;
        if (layout.width > width || layout.second.right > width) failures.push(`${key} ${name}@${width}: horizontal overflow ${JSON.stringify(layout)}`);
        if (name === 'toc-layout') {
          if (layout.second.y > 100 || (width > 640 && (!layout.firstVisible || layout.second.x < layout.first.right))) failures.push(`${key} TOC blocks the article@${width}: ${JSON.stringify(layout)}`);
          if (width <= 640 && layout.firstVisible) failures.push(`${key} native phone TOC visibility changed`);
          if (Math.abs(layout.imageRatio - 2) > .02) failures.push(`${key} tour image lost its aspect ratio@${width}`);
        } else if (width >= 1080) {
          if (layout.second.x < layout.first.right || layout.second.y > 100) failures.push(`${key} import history moved below a form that fits@${width}: ${JSON.stringify(layout)}`);
        } else if (layout.second.y < layout.first.bottom) failures.push(`${key} narrow import columns overlap@${width}: ${JSON.stringify(layout)}`);
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
