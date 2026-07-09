import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); };

const popupHtml = read("popup.html");
const optionsHtml = read("options.html");
const mdHtml = read("md-preview.html");
const optionsCss = read("options.css");
const optionsJs = read("options.js");
const popupTagsJs = read("popup-tags.js");

for (const [name, html] of [["popup.html", popupHtml], ["options.html", optionsHtml], ["md-preview.html", mdHtml]]) {
  const links = html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g);
  for (const [tag] of links) check(/\brel="[^"]*\bnoopener\b[^"]*"/.test(tag), `${name}: target=_blank missing rel=noopener -> ${tag}`);
}

const staticAccordionHeaders = optionsHtml.matchAll(/<(?<tag>\w+)\b(?<attrs>[^>]*class="accordion-header"[^>]*)>/g);
for (const m of staticAccordionHeaders) {
  const attrs = m.groups.attrs;
  const target = (attrs.match(/\bdata-target="([^"]+)"/) || [])[1];
  check(m.groups.tag === "button", `options.html: accordion ${target} is <${m.groups.tag}>`);
  check(/\btype="button"/.test(attrs), `options.html: accordion ${target} missing type=button`);
  check(new RegExp(`\\baria-controls="${target}"`).test(attrs), `options.html: accordion ${target} missing aria-controls`);
}

check(/const head = document\.createElement\("button"\);/.test(optionsJs), "options.js: dynamic accordion header is not a button");
check(/head\.type = "button";/.test(optionsJs), "options.js: dynamic accordion header missing type=button");
check(/head\.setAttribute\("aria-controls", head\.dataset\.target\);/.test(optionsJs), "options.js: dynamic accordion header missing aria-controls");

check(/@media \(max-width: 720px\)[\s\S]*\.container\s*{[\s\S]*grid-template-columns:\s*1fr/.test(optionsCss), "options.css: missing mobile one-column container rule");
check(/@media \(max-width: 720px\)[\s\S]*\.tabs\s*{[\s\S]*position:\s*static/.test(optionsCss), "options.css: missing mobile static tabs rule");

check(/const el = document\.createElement\("button"\);[\s\S]{0,240}el\.className = "stag";/.test(popupTagsJs), "popup-tags.js: suggested tag is not a button");
check(/const aa = document\.createElement\("button"\);[\s\S]{0,240}aa\.className = "add-all-link";/.test(popupTagsJs), "popup-tags.js: add-all is not a button");
check(/const rm = document\.createElement\("button"\);[\s\S]{0,240}rm\.className = "tag-remove";/.test(popupTagsJs), "popup-tags.js: tag remove is not a button");
check(/<button\b(?=[^>]*id="tags-last-used")(?=[^>]*type="button")[^>]*>/.test(popupHtml), "popup.html: #tags-last-used is not a button");

if (fail.length) {
  console.error(fail.join("\n"));
  process.exit(1);
}
console.log("ui contract ok");
