// Public evidence for dictionary learning. HTML stays in an inert template;
// only bounded text and same-origin bibliographic links leave this module.
const PBP_DICT_EVIDENCE_LANGUAGES = Object.freeze({
  en: { name: /^(?:English)$/i, etymology: /^Etymology(?:\s+\d+)?$/i, chapter: "chapter", abbreviations: ["mr.", "mrs.", "ms.", "messrs.", "dr.", "st.", "jr.", "sr.", "mt.", "prof.", "rev.", "hon.", "capt.", "col.", "gen.", "lt.", "sgt.", "gov.", "esq.", "vs.", "cf."] },
  zh: { name: /^(?:漢語|汉语|中文)$/, etymology: /^(?:詞源|词源|語源|语源)(?:\s*\d+)?$/, chapter: "第" },
  es: { name: /^Español$/i, etymology: /^Etimología(?:\s+\d+)?$/i, chapter: "capítulo", abbreviations: ["sr.", "sra.", "srta.", "sres.", "dña.", "dr.", "dra.", "ud.", "uds.", "vd.", "vds.", "sto.", "sta."] },
  de: { name: /(?:^Deutsch$|\(Deutsch\)$)/i, etymology: /^Herkunft:?$/i, chapter: "kapitel", abbreviations: ["z.", "d.", "u.", "dr.", "hr.", "hrn.", "fr.", "prof.", "st.", "nr.", "bzw.", "vgl.", "ca."] },
  fr: { name: /^Français$/i, etymology: /^Étymologie(?:\s+\d+)?$/i, chapter: "chapitre", abbreviations: ["m.", "mm.", "mgr.", "dr.", "st.", "ste.", "cf."] },
  it: { name: /^Italiano$/i, etymology: /^Etimologia(?:\s+\d+)?$/i, chapter: "capitolo", abbreviations: ["sig.", "sigg.", "dott.", "prof.", "avv.", "ing.", "on.", "mons."] },
  pt: { name: /^Português$/i, etymology: /^Etimologia(?:\s+\d+)?$/i, chapter: "capítulo", abbreviations: ["sr.", "sra.", "srta.", "dr.", "dra.", "prof.", "exmo.", "exma."] },
  ru: { name: /^Русский$/i, etymology: /^Этимология(?:\s+\d+)?$/i, chapter: "глава", abbreviations: ["т.", "им.", "проф.", "акад.", "ул.", "св."] },
  ja: { name: /^日本語$/, etymology: /^語源(?:\s*\d+)?$/, chapter: "第" },
  ko: { name: /^한국어$/, etymology: /^어원(?:\s*\d+)?$/, chapter: "장" }
});
// Refine by the queried language, never by UI language or a particular word.
// General search remains a fallback: not all cultural uses are internet slang.
const PBP_DICT_CULTURE_SEARCH = Object.freeze({
  en: 'slang OR meme OR "internet culture"',
  zh: '俚语 OR 俚語 OR 网络用语 OR 網路用語 OR 迷因',
  es: 'jerga OR meme OR "cultura de internet"',
  de: 'Slang OR Meme OR Netzkultur',
  fr: 'argot OR mème OR "culture Internet"',
  it: 'gergo OR meme OR "cultura di Internet"',
  pt: 'gíria OR meme OR "cultura da internet"',
  ru: 'сленг OR мем OR "интернет-культура"',
  ja: 'スラング OR ネット用語 OR ミーム',
  ko: '은어 OR 신조어 OR "인터넷 밈"'
});
function _pbpDictEvidenceError(code) { return Object.assign(new Error(code), { code }); }
function _pbpDictEvidenceLang(language) {
  try { return Intl.getCanonicalLocales(language || "und")[0]; } catch (_) { return "und"; }
}
function pbpDictEvidenceOrigin(kind, language) {
  if (!["literature", "culture", "etymology"].includes(kind)) return "";
  const base = _pbpDictEvidenceLang(language).split("-")[0];
  if (!/^[a-z]{2,3}$/.test(base) || base === "und" ||
      (kind !== "culture" && !Object.hasOwn(PBP_DICT_EVIDENCE_LANGUAGES, base))) return "";
  return `https://${base}.${kind === "literature" ? "wikisource" : kind === "culture" ? "wikipedia" : "wiktionary"}.org`;
}
function _pbpDictEvidenceText(value) {
  return String(value || "").normalize("NFC").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2060\ufeff]/g, " ").replace(/\s+/g, " ").trim();
}
function _pbpDictEvidenceMatch(text, term, language) {
  const normalized = _pbpDictEvidenceText(text).toLocaleLowerCase(), needle = _pbpDictEvidenceText(term).toLocaleLowerCase();
  if (!needle) return -1;
  // CJK words do not require spaces. Other scripts require lexical boundaries;
  // e.g. provide must not turn providers/provision into a verified quotation.
  const cjk = /^(?:zh|ja)(?:-|$)/.test(language) && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(needle);
  for (let index = normalized.indexOf(needle); index >= 0; index = normalized.indexOf(needle, index + 1)) {
    if (cjk || (!/[\p{L}\p{N}\p{M}_]$/u.test(normalized.slice(0, index)) &&
        !/^[\p{L}\p{N}\p{M}_]/u.test(normalized.slice(index + needle.length)))) return index;
  }
  return -1;
}
function _pbpDictEvidenceDocument(html) {
  if (typeof html !== "string" || html.length > 1500000) throw _pbpDictEvidenceError("source_failed");
  // A template's contents are inert even for image/iframe loading. Never attach
  // the fragment to a document, adopt its nodes, or evaluate its attributes.
  const template = document.createElement("template"); template.innerHTML = html;
  const root = template.content;
  root.querySelectorAll("script,style,link,img,iframe,object,embed,video,audio,source,svg,math,form,input,button").forEach(node => node.remove());
  return root;
}
function _pbpDictEvidenceCategories(categories) {
  return categories.filter(row => row && !row.hidden && typeof (row.category ?? row["*"]) === "string")
    .map(row => (row.category ?? row["*"]).replace(/_/g, " ")).join(" | ");
}
function _pbpDictEvidenceForbidden(categories) {
  const text = _pbpDictEvidenceCategories(categories);
  return /(?:\b(?:laws?|legislation|treaties|government reports?|judicial|court cases?|bibliograph(?:y|ies)|catalog(?:ue)?s?|lists of)\b|(?:^|[^\p{L}])(?:Законы|Договоры)(?=$|[^\p{L}])|法律|法令|條約|条约|政府報告|政府报告|法規|法规|目錄|目录|\b(?:Gesetze|Verträge|Gesetzestexte|Leyes|Tratados|Lois|Traités|Законы|Договоры)\b)/iu.test(text);
}
function _pbpDictEvidenceGenre(categories) {
  if (_pbpDictEvidenceForbidden(categories)) return "";
  const text = _pbpDictEvidenceCategories(categories);
  const rules = [
    ["short-story", /(?:\b(?:short stories|short story|novellas?|Erzählungen|Kurzgeschichten|Cuentos|Nouvelles|Racconti|Contos|Рассказы)\b|(?:^|[^\p{L}])Рассказы(?=$|[^\p{L}])|短篇小說|短篇小说|短編小説|단편)/iu],
    ["novel", /(?:\b(?:novels?|Romane?|Novelas?|Romans?|Romanzi|Romances|Романы)\b|(?:^|[^\p{L}])Романы(?=$|[^\p{L}])|小說|小说|小説|소설)/iu],
    ["poetry", /(?:\b(?:poems?|poetry|poesía|poemas?|poésie|Gedichte|Lyrik|Poesie|Poesia|Поэзия|Стихотворения)\b|(?:^|[^\p{L}])(?:Поэзия|Стихотворения)(?=$|[^\p{L}])|詩|诗|詩歌|시집)/iu],
    ["drama", /(?:\b(?:plays|drama|Dramen|Schauspiele|Teatro|Théâtre|Pièces|Пьесы)\b|(?:^|[^\p{L}])Пьесы(?=$|[^\p{L}])|戲劇|戏剧|戯曲|희곡)/iu],
    ["literary-essay", /(?:\bliterary essays?\b|\bensayos literarios\b|\bessais littéraires\b|散文|随筆|隨筆)/iu]
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || "";
}
function _pbpDictEvidenceTitleLink(node, origin) {
  try {
    const url = new URL(node?.getAttribute("href") || "", origin);
    if (url.origin !== origin || !url.pathname.startsWith("/wiki/")) return "";
    const title = decodeURIComponent(url.pathname.slice(6)).replace(/_/g, " ");
    return title && title.length <= 200 && !title.includes(":") ? title : "";
  } catch (_) { return ""; }
}
function _pbpDictEvidenceMetadata(page, root, origin) {
  const text = selector => _pbpDictEvidenceText(root.querySelector(selector)?.textContent).slice(0, 200);
  let author = text("#ws-author, .ws-author, .contributor-text .fn, [itemprop='author'], #header-author, .header-author, .auteur");
  if (!author) {
    const node = [...root.querySelectorAll(".headertemplate a, .header a, .ws-header a, table a")].find(a =>
      /(?:\/wiki\/|title=)(?:Author|Autor|Auteur|Autore|Автор|作者|著者|저자)(?::|%3A)/i.test(a.getAttribute("href") || ""));
    author = _pbpDictEvidenceText(node?.textContent).slice(0, 200);
  }
  const workNode = root.querySelector(".wst-header-title-text, #header-title-text, #ws-title, .ws-title, [itemprop='name']");
  const work = _pbpDictEvidenceText(workNode?.textContent).split(/\s+[—–]\s+/)[0].slice(0, 200) || page.title.split("/")[0];
  const location = text(".header-section-text, #header-section-text, .ws-section") || page.title.split("/").slice(1).join(" / ").slice(0, 200);
  const links = [...root.querySelectorAll(".wst-header-title-text a, #header-title-text a, #ws-title a, .similar a, .autresversions a")]
    .map(node => _pbpDictEvidenceTitleLink(node, origin));
  const parent = page.title.includes("/") ? page.title.slice(0, page.title.lastIndexOf("/")) : "";
  if (parent && parent.length <= 200) links.push(parent);
  return { author, work, location, links: [...new Set(links.filter(title => title && title !== page.title))], genre: _pbpDictEvidenceGenre(page.categories), forbidden: _pbpDictEvidenceForbidden(page.categories) };
}
function _pbpDictEvidenceParagraphNodes(root) {
  const copy = root.cloneNode(true);
  copy.querySelectorAll(".ws-noexport,.wst-header,.headertemplate,.header,.toc,.mw-editsection,.references,.reflist,.navbox,.hatnote,.metadata,.catlinks,.pagenum,sup.reference,table,nav,header,footer").forEach(node => node.remove());
  const body = copy.querySelector(".prp-pages-output, .mw-parser-output") || copy;
  return [...body.querySelectorAll("p, .poem, .poem-stanza, .verse")].filter(node =>
    !node.parentElement?.closest("p, .poem, .poem-stanza, .verse"))
    .filter(node => _pbpDictEvidenceText(node.textContent).length >= 15);
}
// Original-text examples show one retrieved sentence (prose) or one line
// (verse), never a neighbouring sentence and never a translation (R1-8, Q10=A).
// _pbpDictEvidenceText flattens every break into a space, so line and block
// boundaries are read from the DOM first: <br> and block children become hard
// breaks, while newlines inside text nodes stay ordinary HTML whitespace.
const PBP_DICT_EVIDENCE_SENTENCE_MAX = 300;
const PBP_DICT_EVIDENCE_UNSUPPORTED = Object.freeze({ unsupported: true });
const _PBP_DICT_EVIDENCE_BLOCK_TAGS = new Set(["P", "DIV", "LI", "DD", "DT", "BLOCKQUOTE", "TR", "TD", "TH", "UL", "OL", "DL", "TABLE", "H1", "H2", "H3", "H4", "H5", "H6"]);
function _pbpDictEvidenceLines(node) {
  let out = "";
  const walk = parent => {
    for (const child of parent.childNodes) {
      if (child.nodeType === 3) out += child.data.replace(/[\r\n\t\f\v]+/g, " ");
      else if (child.nodeType === 1) {
        if (child.tagName === "BR") { out += "\n"; continue; }
        const block = _PBP_DICT_EVIDENCE_BLOCK_TAGS.has(child.tagName);
        if (block) out += "\n";
        walk(child);
        if (block) out += "\n";
      }
    }
  };
  walk(node);
  return out.split("\n").filter(line => line.trim());
}
// Segmenters break after "Mr." or a lone initial, and between `?”` and a
// lowercase speaker tag such as "inquired Tom." Rejoin by script features and
// the language's abbreviation list only, never by the queried word. Lists omit
// abbreviations that often close a sentence (etc., usw., г.): a split there is
// usually right, and joining would glue two unrelated sentences into one.
function _pbpDictEvidenceContinues(previous, next, abbreviations) {
  if (/^[\s\p{Ps}\p{Pi}\p{Pd}"']*\p{Ll}/u.test(next)) return true;
  const tokens = previous.trim().split(/\s+/).map(token => token.replace(/^[\p{Ps}\p{Pi}"']+/u, ""));
  const last = tokens.at(-1) || "", before = tokens.at(-2);
  if (abbreviations.includes(last.toLocaleLowerCase())) return true;
  // "J. R. R. Tolkien", "Thomas J. Smith"; but "It was I." still ends.
  return /^\p{Lu}\.$/u.test(last) && (before === undefined || /^\p{Lu}/u.test(before));
}
function _pbpDictEvidenceJoinSentences(parts, language) {
  const abbreviations = PBP_DICT_EVIDENCE_LANGUAGES[language.split("-")[0]]?.abbreviations || [], out = [];
  for (const part of parts) {
    if (out.length && _pbpDictEvidenceContinues(out[out.length - 1], part, abbreviations)) out[out.length - 1] += part;
    else out.push(part);
  }
  return out;
}
function _pbpDictEvidenceSplitSentences(text, language) {
  let parts;
  try { parts = [...new Intl.Segmenter(language, { granularity: "sentence" }).segment(text)].map(row => row.segment); }
  catch (_) { parts = text.match(/[^.!?。！？]+[.!?。！？]+["'”’»」』]?|[^.!?。！？]+$/gu) || [text]; }
  // Ideographic full stops end a sentence whatever the segmenter's locale data
  // says; closing quotes and brackets stay with the sentence they close.
  return _pbpDictEvidenceJoinSentences(parts, language).flatMap(part => part.match(/[^。！？]+(?:[。！？]+[」』”’）)]*)?|[。！？]+[」』”’）)]*/gu) || []);
}
// A sentence over the bound becomes a window around the hit, marked as cut so
// the reader can say so; no ellipsis is written into the source text itself.
function _pbpDictEvidenceWindow(text, term, language) {
  const at = _pbpDictEvidenceMatch(text, term, language);
  if (at < 0) return "";
  const size = _pbpDictEvidenceText(term).length, limit = PBP_DICT_EVIDENCE_SENTENCE_MAX;
  if (size >= limit) return "";
  let start = Math.max(0, at - Math.floor((limit - size) / 2)), end = Math.min(text.length, start + limit);
  start = Math.max(0, end - limit);
  // Prefer whole words where the script separates them; CJK simply cuts.
  if (start > 0) { const space = text.indexOf(" ", start); if (space >= 0 && space < at) start = space + 1; }
  if (end < text.length) { const space = text.lastIndexOf(" ", end); if (space > at + size) end = space; }
  const excerpt = text.slice(start, end).trim();
  // Case folding can shift offsets; an excerpt that lost the word is no example.
  return excerpt.length <= limit && _pbpDictEvidenceMatch(excerpt, term, language) >= 0 ? excerpt : "";
}
// source: a parse fragment from _pbpDictEvidenceDocument, or MediaWiki parse
// HTML. Returns hit sentences in document order, [] for a clean miss, or
// {unsupported: true} for a language without a supported edition, so a local
// negative cache can tell "nothing found" from "never searched" (1C.4).
function pbpDictEvidenceSentences(source, term, lang) {
  const language = _pbpDictEvidenceLang(lang);
  if (!Object.hasOwn(PBP_DICT_EVIDENCE_LANGUAGES, language.split("-")[0])) return PBP_DICT_EVIDENCE_UNSUPPORTED;
  if (typeof term !== "string" || !_pbpDictEvidenceText(term)) return [];
  const root = typeof source === "string" ? _pbpDictEvidenceDocument(source) : source;
  if (!root?.querySelectorAll) return [];
  const result = [], nodes = _pbpDictEvidenceParagraphNodes(root);
  for (let index = 0; index < nodes.length && result.length < 10; index++) {
    const node = nodes[index], verse = !node.matches("p");
    for (const line of _pbpDictEvidenceLines(node)) {
      // A verse line is the unit (Q10=A); prose is split into sentences.
      for (const raw of verse ? [line] : _pbpDictEvidenceSplitSentences(line, language)) {
        const text = _pbpDictEvidenceText(raw);
        if (!text || _pbpDictEvidenceMatch(text, term, language) < 0) continue;
        const truncated = text.length > PBP_DICT_EVIDENCE_SENTENCE_MAX;
        const excerpt = truncated ? _pbpDictEvidenceWindow(text, term, language) : text;
        if (excerpt && result.length < 10) result.push({ text: excerpt, paragraph: index + 1, truncated });
      }
    }
  }
  return result;
}
function _pbpDictCultureExcerpts(root, title, term, language) {
  const normalize = text => _pbpDictEvidenceText(text).normalize("NFC").toLocaleLowerCase();
  const name = normalize(term);
  const exactTitle = normalize(title.replace(/\s*[（(][^()（）]*[)）]\s*$/u, "")) === name;
  const result = [];
  const nodes = _pbpDictEvidenceParagraphNodes(root);
  for (let index = 0; index < nodes.length && result.length < 3; index++) {
    const node = nodes[index], text = _pbpDictEvidenceText(node.textContent);
    if (_pbpDictEvidenceMatch(text, term, language) < 0) continue;
    // A word occurring in an unrelated article is not evidence about its
    // cultural meaning. Prefer a dedicated entry or an explicitly mentioned
    // expression; the model still has to establish a distinctive use from it.
    const mentioned = exactTitle || [...node.querySelectorAll("b,strong,i,em,dfn")].some(el => normalize(el.textContent) === name) ||
      [...text.matchAll(/["'“‘«「『]([^"'“”‘’«»「」『』]{1,120})["'”’»」』]/gu)].some(match => normalize(match[1]) === name);
    if (!mentioned) continue;
    const excerpt = _pbpDictEvidenceExcerpt([text], term, language);
    if (excerpt && !result.some(item => item.text === excerpt.text)) result.push({ ...excerpt, paragraph: index + 1 });
  }
  return result;
}
function _pbpDictEvidenceExcerpt(paragraphs, term, language) {
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i], match = _pbpDictEvidenceMatch(paragraph, term, language);
    if (match < 0) continue;
    let excerpt = paragraph;
    if (excerpt.length > 600) {
      // Take complete sentences surrounding the hit; do not manufacture an
      // ellipsis or truncate a quotation into an apparently complete sentence.
      const sentences = [...paragraph.matchAll(/[^.!?。！？]+[.!?。！？]+["'”’»」』]?|[^.!?。！？]+$/gu)];
      const at = sentences.findIndex(value => _pbpDictEvidenceMatch(value[0], term, language) >= 0);
      if (at < 0 || sentences[at][0].trim().length > 600) continue;
      let start = sentences[at].index, end = start + sentences[at][0].length;
      if (at > 0 && end - sentences[at - 1].index < 500) start = sentences[at - 1].index;
      if (at + 1 < sentences.length && sentences[at + 1].index + sentences[at + 1][0].length - start <= 600) end = sentences[at + 1].index + sentences[at + 1][0].length;
      excerpt = paragraph.slice(start, end).trim();
    } else if (excerpt.length < 240) {
      if (i > 0 && paragraphs[i - 1].length + excerpt.length + 2 <= 500) excerpt = paragraphs[i - 1] + "\n\n" + excerpt;
      if (i + 1 < paragraphs.length && excerpt.length + paragraphs[i + 1].length + 2 <= 600) excerpt += "\n\n" + paragraphs[i + 1];
    }
    if (excerpt.length <= 600) return { text: excerpt, paragraph: i + 1 };
  }
  return null;
}
function _pbpDictEvidenceEtymology(page, root, language) {
  const config = PBP_DICT_EVIDENCE_LANGUAGES[language.split("-")[0]];
  if (!config) return null;
  const headings = [...root.querySelectorAll('h2,h3,h4,h5,h6, p[title="Etymologie und Morphologie"]')];
  for (const heading of headings) {
    if (!config.etymology.test(_pbpDictEvidenceText(heading.textContent))) continue;
    const preceding = headings.filter(node => node.tagName === "H2" && (node.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING)).pop();
    if (!preceding || !config.name.test(_pbpDictEvidenceText(preceding.textContent))) continue;
    const container = heading.parentElement?.classList.contains("mw-heading") ? heading.parentElement : heading;
    const parts = [], related = [];
    for (let sibling = container.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      if (/^H[2-6]$/.test(sibling.tagName) || sibling.classList.contains("mw-heading") ||
          (heading.tagName === "P" && sibling.tagName === "P")) break;
      if (!["P", "DL", "UL", "OL"].includes(sibling.tagName)) continue;
      const plain = _pbpDictEvidenceText(sibling.textContent);
      if (!plain || parts.join(" ").length + plain.length + 1 > 600) break;
      parts.push(plain);
      for (const node of sibling.querySelectorAll("[lang] a[href]")) {
        if (node.closest("[lang]")?.getAttribute("lang") !== language.split("-")[0]) continue;
        const title = _pbpDictEvidenceTitleLink(node, pbpDictEvidenceOrigin("etymology", language));
        if (title && !/^[-*]/.test(title) && title !== page.title) related.push(title);
      }
    }
    if (parts.length) return { text: parts.join(" "), location: _pbpDictEvidenceText(heading.textContent), related: [...new Set(related)] };
  }
  return null;
}
async function pbpDictEvidenceFetch({ term, sourceLanguage, kind, signal, beforeRequest } = {}) {
  const language = _pbpDictEvidenceLang(sourceLanguage), origin = pbpDictEvidenceOrigin(kind, language);
  if (typeof term !== "string" || !term.trim() || term.length > 256 || typeof beforeRequest !== "function") throw _pbpDictEvidenceError("invalid_request");
  // An unsupported example language is reported as such, never as a clean
  // miss; etymology keeps its array contract for the generation prompt.
  if (!origin) return kind === "literature" ? PBP_DICT_EVIDENCE_UNSUPPORTED : [];
  const controller = new AbortController(), abort = () => controller.abort();
  let timedOut = false, requests = 0;
  const check = async () => {
    if (signal?.aborted) throw new DOMException("Evidence cancelled", "AbortError");
    if (timedOut) throw _pbpDictEvidenceError("source_failed");
    await beforeRequest();
    if (timedOut) throw _pbpDictEvidenceError("source_failed");
    if (signal?.aborted) throw new DOMException("Evidence cancelled", "AbortError");
  };
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
  signal?.addEventListener("abort", abort, { once: true });
  const fetchJson = async params => {
    await check();
    if (++requests > 26) throw _pbpDictEvidenceError("source_failed");
    if (globalThis.chrome?.runtime?.id && !await chrome.permissions.contains({ origins: [origin + "/*"] })) throw _pbpDictEvidenceError("host_permission");
    await check();
    const url = origin + "/w/api.php?" + new URLSearchParams({ format: "json", formatversion: "2", ...params });
    try {
      const response = await fetch(url, { credentials: "omit", redirect: "error", signal: controller.signal });
      await check();
      if (!response.ok) throw _pbpDictEvidenceError("source_failed");
      const declared = Number(response.headers?.get?.("content-length") || 0);
      if (declared > 1800000) throw _pbpDictEvidenceError("source_failed");
      let raw = "";
      if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new TextDecoder(); let bytes = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); await check();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 1800000) throw _pbpDictEvidenceError("source_failed");
            raw += decoder.decode(value, { stream: true });
          }
          raw += decoder.decode();
        } finally { await reader.cancel().catch(() => {}); }
      } else raw = await response.text();
      await check();
      if (raw.length > 1800000) throw _pbpDictEvidenceError("source_failed");
      const json = JSON.parse(raw);
      if (!json || typeof json !== "object" || json.error) {
        if (["missingtitle", "invalidpageid", "nosuchpageid"].includes(json?.error?.code)) return null;
        throw _pbpDictEvidenceError("source_failed");
      }
      return json;
    } catch (error) {
      if (signal?.aborted) throw new DOMException("Evidence cancelled", "AbortError");
      if (typeof error?.code === "string") throw error;
      console.warn("[dict-evidence] retrieval failed:", error?.name);
      throw _pbpDictEvidenceError("source_failed");
    }
  };
  const pages = new Map();
  const load = async title => {
    if (pages.has(title)) return pages.get(title);
    const json = await fetchJson({ action: "parse", page: title, prop: "text|categories|revid", disableeditsection: "1" });
    if (!json) { pages.set(title, null); return null; }
    const page = json.parse;
    if (!page || typeof page.title !== "string" || page.title.length > 200 || !Number.isSafeInteger(page.pageid) || page.pageid <= 0 ||
        !Number.isSafeInteger(page.revid) || page.revid <= 0 || !Array.isArray(page.categories) || typeof page.text !== "string") throw _pbpDictEvidenceError("source_failed");
    if (page.title.includes(":")) { pages.set(title, null); return null; }
    const loaded = { page, root: _pbpDictEvidenceDocument(page.text) }; pages.set(title, loaded); return loaded;
  };
  const make = (page, excerpt, fields) => ({ title: page.title, url: origin + "/w/index.php?oldid=" + page.revid,
    excerpt, author: fields.author || "", work: fields.work || page.title, location: fields.location || "",
    language, genre: fields.genre || kind, revision: String(page.revid), retrievedAt: Date.now() });
  let sourceFailed = false;
  const optionalRead = async read => {
    try { return await read(); }
    catch (error) {
      // Independent candidates may fail without invalidating a verified
      // passage. Account, permission and cancellation errors still abort all.
      if (error?.code !== "source_failed") throw error;
      sourceFailed = true; return null;
    }
  };
  const candidate = async title => {
    const result = await optionalRead(() => load(title));
    if (!result) pages.set(title, null);
    return result;
  };
  try {
    await check();
    if (kind === "etymology") {
      const page = await load(term); if (!page || page.page.title.toLocaleLowerCase() !== term.toLocaleLowerCase()) return [];
      const found = _pbpDictEvidenceEtymology(page.page, page.root, language); if (!found) return [];
      const result = [make(page.page, found.text, found)];
      // Follow just one explicitly marked same-language formation component.
      // No model invents this link and it never expands the granted origin.
      if (found.related[0]) {
        const related = await candidate(found.related[0]);
        const part = related && _pbpDictEvidenceEtymology(related.page, related.root, language);
        if (part) result.push(make(related.page, part.text, part));
      }
      await check(); return result;
    }
    const escaped = term.replace(/["\\]/g, " ");
    const exact = '"' + escaped + '"', searches = [];
    if (kind === "literature") {
      const chapter = PBP_DICT_EVIDENCE_LANGUAGES[language.split("-")[0]].chapter;
      searches.push(exact + ' intitle:' + chapter +
        (language.startsWith("en") ? " -intitle:Code -intitle:Title -intitle:Manual -intitle:Report -intitle:Copyright" : ""));
    } else {
      const scope = PBP_DICT_CULTURE_SEARCH[language.split("-")[0]];
      searches.push(exact + (scope ? " (" + scope + ")" : " articletopic:internet-culture"));
    }
    searches.push(exact);
    // Direct page lookup is independent of full-text ranking (common words can
    // be buried under incidental mentions). Still verify the retrieved body.
    const candidates = kind === "culture" && term.length <= 200 && !term.includes(":") ? [term] : [], pools = [];
    for (const query of searches) {
      const json = await optionalRead(() => fetchJson({ action: "query", list: "search", srnamespace: "0", srsearch: query, srlimit: kind === "literature" ? "8" : "5", srprop: "" }));
      if (!Array.isArray(json?.query?.search)) { sourceFailed = true; continue; }
      pools.push(json.query.search.filter(row => row?.ns === 0 && Number.isSafeInteger(row.pageid) && row.pageid > 0 && typeof row.title === "string" && row.title.length <= 200 &&
        !row.title.includes(":")).map(row => row.title));
    }
    // Share the existing candidate budget: neither query may starve the other.
    for (let index = 0; index < Math.max(...pools.map(pool => pool.length)); index++) {
      for (const pool of pools) if (pool[index] && !candidates.includes(pool[index])) candidates.push(pool[index]);
    }
    const result = [], works = new Set(); let examined = 0;
    for (const title of candidates) {
      if (kind === "literature" && /(?:\b(?:United States Code|Copyright|Government Report|Report of (?:the|a) Commission|Agreement relating|Implementation Rules|Traffic Signs Manual|Treaty|Encyclopædia|Encyclopedia)\b|法律|法令|报告|報告|條約|条约)/i.test(title)) continue;
      if (++examined > 10 || result.length >= (kind === "literature" ? 1 : 3) || requests >= 22) break;
      const loaded = await candidate(title); if (!loaded) continue;
      const { page, root } = loaded;
      if (kind === "culture") {
        for (const excerpt of _pbpDictCultureExcerpts(root, page.title, term, language)) {
          const location = "¶ " + excerpt.paragraph;
          if (result.length < 3 && !result.some(source => source.revision === String(page.revid) && source.location === location)) {
            result.push(make(page, excerpt.text, { location }));
          }
        }
        continue;
      }
      // One sentence or verse line, not the old surrounding passage (R1-8).
      const hit = pbpDictEvidenceSentences(root, term, language)[0]; if (!hit) continue;
      const metadata = _pbpDictEvidenceMetadata(page, root, origin);
      if (metadata.forbidden) continue;
      let frontier = metadata.links;
      for (let depth = 0; (!metadata.genre || !metadata.author) && !metadata.forbidden && depth < 2; depth++) {
        const next = [];
        for (const parentTitle of frontier.slice(0, 2)) {
          const parent = await candidate(parentTitle); if (!parent) continue;
          const parentMeta = _pbpDictEvidenceMetadata(parent.page, parent.root, origin);
          if (parentMeta.forbidden) { metadata.forbidden = true; break; }
          if (!metadata.author) metadata.author = parentMeta.author;
          if (!metadata.work || metadata.work === page.title.split("/")[0]) metadata.work = parentMeta.work;
          metadata.genre ||= parentMeta.genre; next.push(...parentMeta.links);
          if (metadata.genre && metadata.author) break;
        }
        frontier = next;
      }
      if (metadata.forbidden || !metadata.genre || !metadata.author || !metadata.work || works.has(metadata.work)) continue;
      metadata.location = (metadata.location ? metadata.location + " · " : "") + "¶ " + hit.paragraph;
      metadata.location = metadata.location.slice(0, 200);
      result.push({ ...make(page, hit.text, metadata), truncated: hit.truncated }); works.add(metadata.work);
    }
    await check();
    if (!result.length && sourceFailed) throw _pbpDictEvidenceError("source_failed");
    return result;
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}
