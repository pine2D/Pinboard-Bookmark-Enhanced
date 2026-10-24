// On-demand drift / same-document comparison. No runtime dependency or page scripts.
// node scripts/site-rules-check.mjs                         (registry validation)
// node scripts/site-rules-check.mjs --rule=arxiv --live     (one public page)
// node scripts/site-rules-check.mjs --rule=arxiv --html=/tmp/page.html
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { chromium } from '../.qa-scan/node_modules/playwright/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const at = arg.indexOf('=');
  return at < 0 ? [arg.slice(2), true] : [arg.slice(2, at), arg.slice(at + 1)];
}));
if (Object.keys(args).some(k => !['rule', 'html', 'url', 'live'].includes(k))
    || ((args.live || args.html || args.url) && typeof args.rule !== 'string')
    || (args.live && args.html) || (args.url && !args.html && !args.live)) {
  throw new Error('Use --rule=<id> with either --live or --html=<path>, and optional --url=<source URL>.');
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.goto('about:blank');
  for (const file of ['vendor/defuddle.js', 'vendor/turndown.js', 'vendor/marked.min.js', 'vendor/purify.min.js', 'md-convert.js', 'site-rules.js']) {
    await page.addScriptTag({ content: await readFile(resolve(root, file), 'utf8') });
  }
  const registry = await page.evaluate(() => SITE_RULES.map(rule => ({
    id: rule.id, driftCheck: rule.driftCheck, sampleUrl: rule.sampleUrl || '',
    valid: rule.driftCheck !== 'auto' || (!!rule.sampleUrl && matchRule(rule.match, document, rule.sampleUrl))
  })));
  if (registry.some(r => !r.valid)) throw new Error('Invalid auto samples: ' + registry.filter(r => !r.valid).map(r => r.id).join(', '));
  const rule = args.rule && registry.find(r => r.id === args.rule);
  if (args.rule && !rule) throw new Error('Unknown rule: ' + args.rule);
  if (!args.live && !args.html) {
    console.log(JSON.stringify({ status: 'registry-ok', rules: registry }, null, 2));
  } else {
    const url = args.url || rule.sampleUrl;
    if (!url || !/^https?:$/.test(new URL(url).protocol)) throw new Error('A source http(s) URL is required.');
    let html = '', unavailable = '';
    if (args.html) html = await readFile(args.html, 'utf8');
    else {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) unavailable = 'HTTP ' + response.status;
        else if (new URL(response.url).origin !== new URL(url).origin) unavailable = 'Cross-origin redirect; verify the page manually';
        else html = await response.text();
      } catch (error) { unavailable = error.name + ': ' + error.message; }
    }
    if (!unavailable && /<title[^>]*>\s*(?:Just a moment|Access Denied|Attention Required|Security Verification)/i.test(html)) unavailable = 'Access challenge';
    if (unavailable) {
      console.log(JSON.stringify({ status: 'unverified', rule: rule.id, url, reason: unavailable }));
      process.exitCode = 2;
    } else {
      const report = await page.evaluate(({ id, html, url }) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const before = doc.documentElement.outerHTML;
        const matched = SITE_RULES.find(r => r.id === id);
        if (!matchRule(matched.match, doc, url)) throw new Error('URL does not match the selected rule');
        const custom = applySiteRule(doc, url);
        let native, nativeError;
        try { native = new Defuddle(doc.cloneNode(true), { url }).parse(); } catch (error) { nativeError = error.message; }
        const measure = content => {
          const box = doc.createElement('div');
          box.innerHTML = renderMarkdown(htmlToMarkdown(content || '', { baseUrl: url }));
          return { characters: box.textContent.trim().length, paragraphs: box.querySelectorAll('p').length,
            links: box.querySelectorAll('a[href]').length, images: box.querySelectorAll('img').length };
        };
        return { status: custom?.contentHtml && custom.id === id && before === doc.documentElement.outerHTML ? 'extracted' : 'drift',
          rule: id, url, title: custom?.title, math: custom?.math, error: custom?.error,
          sourceUnchanged: before === doc.documentElement.outerHTML,
          custom: measure(custom?.contentHtml), defuddle: measure(native?.content), defuddleError: nativeError };
      }, { id: rule.id, html, url });
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== 'extracted') process.exitCode = 1;
    }
  }
} finally { await browser.close(); }
