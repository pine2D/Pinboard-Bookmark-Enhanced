#!/usr/bin/env node
// Regenerates docs/cws-assets/store-descriptions.md from the nine READMEs.
//
// The Chrome Web Store's detailed-description field is PLAIN TEXT: it renders no
// Markdown, so bold markers, backticks and [label](url) links would all show up
// literally. This converts the README feature list into what should actually be
// pasted, keeping the store listing and the READMEs from drifting apart.
//
// The paid-account disclosure is NOT taken from the README: it is the wording a
// CWS review already accepted (a missing paid disclosure got this extension
// rejected once), plus the sentence stating AI is optional and BYO-key. It is
// carried over verbatim from the previous generated file.
//
// Store keyword policy (CWS rejection "Keyword Spam / Yellow Argon",
// 2026-10-10): the reviewer flagged the export bullet's run of brand names and
// file formats plus its inline URL. The README keeps that detail (docs-lint
// pins the Obsidian/Wayback links and the .md/.html/.epub spans), so the store
// copy drops link URLs and swaps three list-shaped bullets for prose
// (STORE_REWRITES). STORE_BANNED then fails generation if any URL, dot-joined
// list, theme-name run or file-format name reaches the store text.
//
// Usage:
//   node scripts/sync-store-descriptions.mjs           rewrite the file
//   node scripts/sync-store-descriptions.mjs --check    exit 1 if it is stale
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "docs/cws-assets/store-descriptions.md");

const LOCALES = [
  ["English (en)", "README.md"],
  ["简体中文 (zh-CN)", "README.zh-CN.md"],
  ["繁體中文 (zh-TW)", "README.zh-TW.md"],
  ["繁體中文（香港） (zh-HK)", "README.zh-HK.md"],
  ["Deutsch (de)", "README.de.md"],
  ["Français (fr)", "README.fr.md"],
  ["日本語 (ja)", "README.ja.md"],
  ["Polski (pl)", "README.pl.md"],
  ["Русский (ru)", "README.ru.md"],
];

// Markdown -> the plain text the store actually shows.
function toPlainText(md) {
  return md
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")       // links: label only (store keyword policy)
    .replace(/\*\*([^*]+)\*\*/g, "$1")               // bold markers
    .replace(/`([^`]+)`/g, "$1")                     // code spans
    .replace(/[ \t]+$/gm, "");
}

// The disclosure block from the previous generation, one entry per locale, in
// LOCALES order. Regenerating never rewrites these.
function readExistingDisclosures() {
  const previous = readFileSync(OUT, "utf8");
  const blocks = [...previous.matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  if (blocks.length !== LOCALES.length) {
    throw new Error(`expected ${LOCALES.length} text blocks in the existing file, found ${blocks.length}`);
  }
  return blocks.map((block, index) => {
    const disclosure = block.split("\n\n")[0].trim();
    if (!disclosure) throw new Error(`empty disclosure for ${LOCALES[index][0]}`);
    return disclosure;
  });
}

function buildFeatures(readmePath) {
  const text = readFileSync(resolve(ROOT, readmePath), "utf8");
  const features = text.split(/^## /m).find((part) => /^### /m.test(part));
  if (!features) throw new Error(`no feature section in ${readmePath}`);
  const lines = [];
  for (const raw of features.split("\n")) {
    if (/^!\[/.test(raw)) continue;                       // screenshots
    const heading = raw.match(/^### (.+)$/);
    if (heading) { lines.push("", `# ${toPlainText(heading[1])}`); continue; }
    if (/^- /.test(raw)) {
      const label = (raw.match(/^- \*\*([^*]+)\*\*/) || [])[1];
      const rewrite = label && STORE_REWRITES[readmePath]?.[label];
      if (rewrite) used.add(`${readmePath}\u0000${label}`);
      lines.push(rewrite ? `- ${rewrite}` : toPlainText(raw));
      continue;
    }
  }
  const sections = lines.filter((line) => line.startsWith("# ")).length;
  const bullets = lines.filter((line) => line.startsWith("- ")).length;
  // 4 sections is the README structural contract (docs-lint asserts it too);
  // the bullet count is not pinned here — the nine locales must mirror each
  // other, with the first locale (EN) as the baseline. A hardcoded count went
  // stale silently when the READMEs grew from 15 to 17 bullets.
  if (sections !== 4) {
    throw new Error(`${readmePath}: expected 4 sections, got ${sections}`);
  }
  return { text: lines.join("\n").trim(), sections, bullets };
}

// Store-only prose for the README bullets that read as keyword lists, keyed by
// README file and the bullet's bold label. Every entry must match exactly one
// bullet; a renamed label fails generation instead of silently reverting.
const STORE_REWRITES = {
  "README.md": {
    "Send or download": "Send or download: send articles to your notes app or your own webhook, or save them as e-books for your e-reader",
    "13 themes for pinboard.in": "13 themes for pinboard.in: light and dark looks for the site itself, plus room for your own custom CSS",
    "9 languages": "Private by default: your data stays in your browser with zero tracking; the interface comes in 9 languages and every shortcut is configurable",
  },
  "README.zh-CN.md": {
    "发送或下载": "发送或下载：把文章发到常用的笔记应用或你自己的 webhook，或者存成电子书放进阅读器",
    "13 套 pinboard.in 主题": "13 套 pinboard.in 主题：给网站本身换上浅色或深色外观，还能叠加自定义 CSS",
    "9 种语言": "隐私优先：数据留在你自己的浏览器里，零追踪；界面支持 9 种语言，快捷键可自定义",
  },
  "README.zh-TW.md": {
    "傳送或下載": "傳送或下載：把文章傳到常用的筆記應用程式或你自己的 webhook，或存成電子書放進閱讀器",
    "13 套 pinboard.in 佈景主題": "13 套 pinboard.in 佈景主題：替網站本身換上淺色或深色外觀，還可疊加自訂 CSS",
    "9 種語言": "隱私優先：資料留在你自己的瀏覽器裡，零追蹤；介面支援 9 種語言，快捷鍵可自訂",
  },
  "README.zh-HK.md": {
    "傳送或下載": "傳送或下載：把文章傳到常用的筆記應用程式或你自己的 webhook，或存成電子書放進閱讀器",
    "13 套 pinboard.in 佈景主題": "13 套 pinboard.in 佈景主題：為網站本身換上淺色或深色外觀，更可疊加自訂 CSS",
    "9 種語言": "私隱優先：資料留在你自己的瀏覽器內，零追蹤；介面支援 9 種語言，快捷鍵可自訂",
  },
  "README.de.md": {
    "Senden oder herunterladen": "Senden oder herunterladen: Artikel an deine Notiz-App oder deinen eigenen Webhook senden oder als E-Book für den E-Reader speichern",
    "13 Themes für pinboard.in": "13 Themes für pinboard.in: helle und dunkle Looks für die Seite selbst, dazu dein eigenes CSS",
    "9 Sprachen": "Privat von Anfang an: deine Daten bleiben im Browser, ohne Tracking; die Oberfläche gibt es in 9 Sprachen, alle Tastenkürzel sind anpassbar",
  },
  "README.fr.md": {
    "Envoyer ou télécharger": "Envoyer ou télécharger : envoyez vos articles vers votre application de notes ou votre propre webhook, ou enregistrez-les en livre numérique pour votre liseuse",
    "13 thèmes pour pinboard.in": "13 thèmes pour pinboard.in : des apparences claires et sombres pour le site lui-même, plus votre CSS personnalisé",
    "9 langues": "Confidentiel par défaut : vos données restent dans votre navigateur, sans aucun pistage ; l'interface existe en 9 langues et tous les raccourcis sont configurables",
  },
  "README.ja.md": {
    "送信もダウンロードも": "送信もダウンロードも：記事を普段使いのノートアプリや自分の webhook に送ったり、電子書籍として保存してリーダーで読んだりできます",
    "pinboard.in 用テーマ 13 種": "pinboard.in 用テーマ 13 種：サイト自体をライトにもダークにも着せ替えられ、自分のカスタム CSS も重ねられます",
    "9 言語対応": "プライバシー重視：データはブラウザー内に保存され、トラッキングは一切なし。9 言語に対応し、ショートカットも自由に変更できます",
  },
  "README.pl.md": {
    "Wyślij albo pobierz": "Wyślij albo pobierz — wyślij artykuł do swojej aplikacji z notatkami lub własnego webhooka albo zapisz go jako e-book na czytnik",
    "13 motywów dla pinboard.in": "13 motywów dla pinboard.in — jasne i ciemne wersje samej witryny oraz miejsce na własny CSS",
    "9 języków": "Prywatność przede wszystkim — dane zostają w przeglądarce, zero śledzenia; interfejs w 9 językach, a skróty można dowolnie zmieniać",
  },
  "README.ru.md": {
    "Отправить или скачать": "Отправить или скачать — отправляйте статьи в своё приложение для заметок или на собственный вебхук либо сохраняйте их как электронные книги для читалки",
    "13 тем для pinboard.in": "13 тем для pinboard.in — светлое и тёмное оформление самого сайта плюс место для своего CSS",
    "9 языков": "Конфиденциальность по умолчанию — данные остаются в браузере, никакого трекинга; интерфейс на 9 языках, все горячие клавиши настраиваются",
  },
};
// What the CWS reviewer reads as keyword stuffing; none may reach store text.
const STORE_BANNED = [
  [/https?:\/\//, "URL"],
  [/ · /, "dot-joined list"],
  [/Dracula|Catppuccin|Solarized/, "theme-name run"],
  [/\.(epub|html|md)\b/, "file-format name"],
  [/NotebookLM|GitHub Gist|Gist GitHub/, "export-target name run"],
];
const used = new Set();

const disclosures = readExistingDisclosures();
const parts = [
  "# Chrome Web Store — Store Descriptions (per locale)",
  "",
  "> Paste the matching locale block into **CWS Dashboard → Store listing → Detailed description**",
  "> for that language. **Plain text** — the Chrome Web Store renders no Markdown, so this file",
  "> already has the bold markers, backticks and link syntax removed.",
  ">",
  "> **Generated** by `node scripts/sync-store-descriptions.mjs` from the nine READMEs. Edit the",
  "> READMEs and regenerate; do not hand-edit the blocks below. The leading ⚠ paid-account",
  "> disclosure is the wording a CWS review already accepted and is carried across regenerations",
  "> untouched.",
  "",
];
let baseline = null;
LOCALES.forEach(([label, readme], index) => {
  const feat = buildFeatures(readme);
  if (!baseline) {
    baseline = { bullets: feat.bullets, path: readme };
  } else if (feat.bullets !== baseline.bullets) {
    throw new Error(`${readme}: ${feat.bullets} bullets do not mirror ${baseline.path} (${baseline.bullets})`);
  }
  parts.push("---", "", `## ${label}`, "", "```text", disclosures[index], "", feat.text, "```", "");
});
const output = parts.join("\n");

for (const [readme, map] of Object.entries(STORE_REWRITES)) {
  for (const label of Object.keys(map)) {
    if (!used.has(`${readme}\u0000${label}`)) throw new Error(`${readme}: store rewrite for "${label}" matched no bullet (label renamed?)`);
  }
}
const storeTexts = [...output.matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => m[1]);
storeTexts.forEach((text, i) => {
  for (const [re, what] of STORE_BANNED) {
    const hit = text.match(re);
    if (hit) throw new Error(`${LOCALES[i][0]}: store text contains a ${what} ("${hit[0]}"); CWS flags this as keyword spam`);
  }
});

if (process.argv.includes("--check")) {
  const current = readFileSync(OUT, "utf8");
  if (current !== output) {
    console.error("[store-descriptions] STALE — run: node scripts/sync-store-descriptions.mjs");
    process.exit(1);
  }
  console.log("[store-descriptions] up to date");
} else {
  writeFileSync(OUT, output);
  const chars = LOCALES.map(([label], i) => {
    const block = output.split("```text\n")[i + 1].split("\n```")[0];
    return `${label}: ${block.length}`;
  });
  console.log("[store-descriptions] written\n  " + chars.join("\n  "));
}
