// ============================================================
// Pinboard Bookmark Enhanced - md-preview dictionary (P1)
// 查 (freedictionaryapi.com + LLM contextual gloss) / 听 (speechSynthesis)
// 存 (pbp-vocab IDB) / 导 (Anki TSV)
// ============================================================
// TOP SECTION IS PURE: no chrome.*, no DOM, no fetch — loadable from
// file:// test pages (same contract as md-translate.js's top section).
// Runtime layers live below the PURE END marker.

const PBP_DICT_ORIGIN = "https://freedictionaryapi.com";
// Retention and display are separate concerns. The API orders senses roughly
// historically, so for a polysemous word the one a reader wants routinely sits
// outside the first five: measured on the live API, set has 96 senses, run 69,
// take 71. Keeping only five discarded the answer before it was ever cached.
// KEEP is what the model and the cache hold; SHOW is what renders, after the
// host sentence has had a chance to reorder them.
const PBP_DICT_SENSE_KEEP = 20;
const PBP_DICT_SENSE_SHOW = 5;
// Weight of the API's own sense order when ranking against the sentence.
// Tuned on the 60-case gold set; see pbpDictOrderForContext.
const PBP_DICT_SENSE_ORDER_PRIOR = 2;
const PBP_DICT_EXAMPLE_CAP = 2;
const PBP_DICT_FORM_CAP = 6;
const PBP_DICT_IPA_CAP = 3;
// These already arrive in every response and already sit in the dict2_ cache;
// rendering them costs no extra request. Caps are deliberately tight: this
// panel is a reading overlay, and density here has drawn real complaints.
// Attested quotations are deliberately NOT carried: they cost the most lines
// per sense and carry the least, so they were cut after seeing them rendered.
const PBP_DICT_REL_CAP = 6;       // synonyms / antonyms per sense
const PBP_DICT_SUBSENSE_CAP = 3;
const PBP_DICT_SENSE_TAG_CAP = 3;
const PBP_DICT_QUERY_LANGS = Object.freeze(["en", "de", "fr", "es", "it", "pt", "nl", "ru", "pl", "ja", "ko", "zh"]);
const PBP_DICT_CIRCUIT_THRESHOLD = 3;
const PBP_DICT_CIRCUIT_COOLDOWN_MS = 60000;

// User-facing language names come from the platform's locale data. Unknown
// or unsupported codes stay hidden instead of leaking technical identifiers.
function pbpDictLanguageLabel(code, locale) {
  const primary = pbpDictPrimaryLang(code);
  if (!primary || primary === "und") return "";
  try {
    const names = new Intl.DisplayNames([String(locale || "en").replace("_", "-")], { type: "language", fallback: "none" });
    const label = names.of(String(code).replace(/_/g, "-"));
    return label && label.toLowerCase() !== primary ? label : "";
  } catch (_) { return ""; }
}

function pbpDictDefinitionLang(norm) {
  if (norm && typeof norm.definitionLang === "string" && norm.definitionLang) return norm.definitionLang;
  return norm?.sourceLabel === "ECDICT" ? "zh" :
    ["Wiktionary", "CC-CEDICT"].includes(norm?.sourceLabel) ? "en" : "und";
}

// Shared by both save pickers: retain the matched headword and original
// definition, never the input reading or a translated/AI paraphrase.
function pbpDictNormChoices(norm, lang, sourcePrefix = "Source:") {
  if (!norm) return [];
  const term = pbpDictNormalizeTerm(norm.word);
  if (!term) return [];
  const choices = [];
  // The existing saved license field is a complete attribution notice. Keep
  // original dictionary metadata immutable; only an explicit save projection
  // adds the source identifier and its revision, with no inferred license.
  const license = norm.packId ? [
    norm.sourceLabel ? sourcePrefix + " " + [norm.sourceLabel, norm.packRevision].filter(Boolean).join(" · ") : "",
    norm.license, norm.attribution
  ].filter(Boolean).join("\n\n") : norm.license || "";
  for (const entry of norm.entries || []) {
    // Imported full articles (including old flattened rows) are readable,
    // but must never become an automatically selected vocabulary definition.
    if (entry.contentKind === "full-entry" || entry.contentKind === "legacy") continue;
    const visit = (sense) => {
      const gloss = typeof sense === "string" ? sense : sense?.definition;
      if (gloss) choices.push({ term, language: lang, gloss,
        ipa: entry.ipas?.[0]?.text || (norm.aiGenerated ? norm.pronunciation || "" : ""), sourceUrl: norm.sourceUrl || "", license,
        definitionLang: pbpDictDefinitionLang(norm), sourceLabel: norm.sourceLabel || "Wiktionary", packId: norm.packId || "" });
      for (const sub of sense?.subsenses || []) visit(sub);
    };
    for (const sense of entry.senses || []) visit(sense);
  }
  return choices;
}

// Definition language is independent of both the UI and the queried word.
// Codes use the platform's known English names in prompts; free-form names
// stay useful without pretending that their BCP47 metadata is known.
function pbpDictDefinitionLanguage(preference, uiLanguage) {
  const clean = (value) => typeof value === "string"
    ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 80) : "";
  const requested = clean(preference) || clean(uiLanguage) || "en";
  try {
    const lang = Intl.getCanonicalLocales(requested)[0];
    const name = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(lang);
    if (name && lang !== "und" && lang !== "mul" && lang !== "zxx") return { name, lang };
  } catch (_) { /* A user-entered name need not be a language code. */ }
  return { name: requested, lang: "und" };
}

// Language routing (spec §3): manual override wins; then a reliable
// detection; then the article-level fallback; "" = unknown. "und" never routes.
function pbpDictRouteLang(detected, isReliable, articleLang, manual) {
  const m = pbpDictPrimaryLang(manual);
  if (m) return m;
  const d = pbpDictPrimaryLang(detected);
  if (d && d !== "und" && isReliable) return d;
  return pbpDictPrimaryLang(articleLang);
}

// Japanese written without kana is indistinguishable from Chinese, and
// chrome.i18n.detectLanguage does not hedge about it: measured against the
// real API inside the extension, "東京大学工学部電気工学科教授会議" comes back as
// zh at 100% with isReliable TRUE, at every length from 30 to 640 characters.
// Reliable-and-wrong beats the whole detection ladder, so the article-level
// answer never gets a say -- and md-preview.js:105 computed that one by
// scanning 4000 characters for kana, which is a positive marker this sentence
// simply lacks.
//
// Hence the asymmetry: kana PRESENT proves Japanese, kana ABSENT proves
// nothing. Only zh-detected-inside-a-ja-article is corrected; a ja detection
// is never overridden. The cost is a genuinely Chinese sentence quoted in a
// Japanese article, which routes to ja -- but without kana nothing could have
// told those apart anyway, and the article is the better prior.
function pbpDictCorrectCjkLang(routed, articleLang) {
  return routed === "zh" && pbpDictPrimaryLang(articleLang) === "ja" ? "ja" : routed;
}

// Central acceptability gate for AUTOMATIC routes only (manual choice
// deliberately bypasses it): a route may only name a language the dictionary
// can actually query AND whose script is present in the selection. Without
// the gate, a reliable zh read on the Chinese sentence AROUND a Latin
// selection routes that Latin word to zh, and reliable fi/sv/ar detections
// leak requests to languages the dropdown cannot even display (the Auto
// label hides them: pbpDictLanguageLabel returns "" outside the query set).
const PBP_DICT_LATIN_QUERY_LANGS = Object.freeze(["en", "de", "fr", "es", "it", "pt", "nl", "pl"]);
const PBP_DICT_SCRIPT_RES = Object.freeze({
  latin: /\p{Script=Latin}/u,
  han: /\p{Script=Han}/u,
  kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
  hangul: /\p{Script=Hangul}/u,
  cyrillic: /\p{Script=Cyrillic}/u,
  // Letters that EXCLUDE Russian inside Cyrillic: Ukrainian (\u0456 \u0457 \u0454
  // \u0491), Belarusian (\u045E), Serbian (\u0452 \u0458 \u0459 \u045A \u045B \u045F),
  // Macedonian (\u045C \u0453 \u0455). Their absence proves nothing (Bulgarian is
  // indistinguishable on most words) -- same asymmetry as kana for Japanese.
  nonRuCyr: /[\u0452\u0453\u0454\u0455\u0456\u0457\u0458\u0459\u045A\u045B\u045C\u045E\u045F\u0491\u0402\u0403\u0404\u0405\u0406\u0407\u0408\u0409\u040A\u040B\u040C\u040E\u040F\u0490]/,
  // A Latin-script letter outside ASCII: positive orthographic evidence that
  // a word is NOT plain-English spelling (used by the fallback's lone-candidate rule).
  extLatin: /(?![\x00-\x7F])\p{Script=Latin}/u,
  // A letter that is NOT Latin-script. \p{L} alone would flag digits-free
  // words fine but also needs the lookahead so Latin letters pass; anything
  // this matches is counter-evidence against a Latin-language route.
  nonLatinLetter: /(?!\p{Script=Latin})\p{L}/u,
});
function pbpDictScriptCompatible(primary, selText, languageTag = primary) {
  const s = String(selText || "");
  const R = PBP_DICT_SCRIPT_RES;
  if (primary === "zh") return R.han.test(s);
  if (primary === "ja") return R.kana.test(s) || R.han.test(s);
  if (primary === "ko") return R.hangul.test(s) || R.han.test(s);
  if (primary === "ru") return R.cyrillic.test(s) && !R.nonRuCyr.test(s);
  if (PBP_DICT_LATIN_QUERY_LANGS.includes(primary)) return R.latin.test(s);
  // Installed languages need their own script fit, not the old Latin-only
  // fallback. CLD/explicit metadata establish the language; this only rejects
  // a contradictory alphabet and never guesses a new route from its script.
  try {
    const script = new Intl.Locale(String(languageTag).replace(/_/g, "-")).maximize().script;
    return !!script && new RegExp("\\p{Script=" + script + "}", "u").test(s);
  } catch (_) { return false; }
}
function pbpDictAcceptLang(code, selText, supported = PBP_DICT_QUERY_LANGS) {
  const p = pbpDictPrimaryLang(code);
  if (!supported.includes(p)) return "";
  return pbpDictScriptCompatible(p, selText, code) ? p : "";
}

// Selection-level script rung, AHEAD of CLD: for every non-Latin script in
// the query set the selection's own codepoints decide faster and more
// reliably than any statistical read of the surroundings (a Russian word
// quoted in an English article has an unreliable CLD read but an unambiguous
// alphabet -- ru is the only Cyrillic member of the query set). Kana proves
// ja and Hangul proves ko outright. Han alone is zh/ja/ko-ambiguous: kana or
// hangul in the SURROUNDING SENTENCE resolves it (a kanji word selected
// inside a Japanese sentence must not route to zh just because the article
// is English), otherwise zh -- with the ja-article correction applied by the
// caller, same documented tradeoff as before. Latin deliberately returns ""
// here: eight query languages share that script, CLD gets its chance first.
function pbpDictScriptLang(selText, sentence) {
  const R = PBP_DICT_SCRIPT_RES;
  const s = String(selText || "");
  if (R.kana.test(s)) return "ja";
  if (R.hangul.test(s)) return "ko";
  if (R.han.test(s)) {
    const ctx = String(sentence || "");
    if (R.kana.test(ctx)) return "ja";
    if (R.hangul.test(ctx)) return "ko";
    return "zh";
  }
  if (R.cyrillic.test(s)) {
    const cyrCtx = String(sentence || "");
    // ru is the only Cyrillic query language, but a letter unique to
    // Ukrainian/Belarusian/Serbian/Macedonian in the word or its sentence
    // DISPROVES Russian -- honest unknown beats a fabricated ru identity.
    return (R.nonRuCyr.test(s) || R.nonRuCyr.test(cyrCtx)) ? "" : "ru";
  }
  return "";
}

// Last rung, Latin script only. CLD flags nearly every short or jargon-heavy
// selection unreliable (measured in the extension SW: "Converts wiktionary
// data from kaikki (wiktextract) to yomitan -compatible dictionaries." ->
// en@100 isReliable:FALSE; the lone word "Converts" -> zh@100 FALSE), and
// detectArticleLang names only CJK/RTL scripts, so a Latin article has no
// article-level rung at all -- the ladder used to end at "" and the slot
// claimed "no entry" without ever querying. An unreliable candidate is still
// worth routing when it names a Latin-script query language (a German jargon
// sentence tops as de); anything else (zh on "Converts") falls to en, the
// technical web's prior. Positive classification, not a script blacklist:
// the selection must CONTAIN Latin letters and contain NO other-script
// letters ("zolc" with Polish diacritics is Latin; ASCII mixed with Bengali
// is not) -- a blacklist can never enumerate every other script.
function pbpDictLatinFallback(text, sentenceCand, blockCand) {
  const s = String(text || "");
  const R = PBP_DICT_SCRIPT_RES;
  if (!R.latin.test(s) || R.nonLatinLetter.test(s)) return "";
  const a = pbpDictPrimaryLang(sentenceCand);
  const b = pbpDictPrimaryLang(blockCand);
  const av = PBP_DICT_LATIN_QUERY_LANGS.includes(a) ? a : "";
  const bv = PBP_DICT_LATIN_QUERY_LANGS.includes(b) ? b : "";
  // Two low-confidence reads NAMING DIFFERENT Latin languages cancel out --
  // that disagreement is exactly what "unreliable" warned about, and en is
  // the better prior than whichever happened to be passed first.
  if (av && bv && av !== bv) return "en";
  const cand = av || bv;
  if (!cand || cand === "en") return "en";
  // A lone non-en candidate needs positive evidence beyond "CLD guessed it
  // once": either both context widths agreed, or the word itself carries
  // non-ASCII Latin orthography (zolc-with-diacritics, cafe-with-accent)
  // that plain-English spelling lacks. A bare-ASCII homograph (chat, gift)
  // riding a lone fr/da guess would render a CONVINCING wrong entry --
  // strictly worse than the honest miss en gives (Codex review HIGH 1).
  return (av && bv) || PBP_DICT_SCRIPT_RES.extLatin.test(s) ? cand : "en";
}

// Case-sensitive public query cache. The dict2_ prefix orphans old dict_
// entries whose folded key may already contain the wrong casing's result.
function pbpDictCacheKeyExact(lang, term) {
  return pbpDictPrimaryLang(lang) + "|" + pbpDictNormalizeTerm(term);
}

function pbpDictQueryCacheKey(lang, term) {
  return "dict2_" + pbpDictCacheKeyExact(lang, term);
}

function pbpDictLowerCandidate(term, lang) {
  const primary = pbpDictPrimaryLang(lang);
  const exact = pbpDictNormalizeTerm(term);
  if (!exact || !PBP_DICT_QUERY_LANGS.includes(primary)) return "";
  const lower = exact.toLocaleLowerCase(primary);
  return lower === exact ? "" : lower;
}

// Selection artifacts that keep a real headword from resolving. Reader prose
// writes curly apostrophes where Wiktionary titles use ASCII ' (don't -> 4
// entries, don’t -> 0), justified and PDF-derived text carries soft hyphens,
// and a drag routinely takes the sentence punctuation with the word
// ("ubiquitous." -> 0). The same defect class exists in other scripts: CJK has
// no inter-word spaces, so a Japanese drag almost always carries the following
// ideographic period (ja lookups return zero entries with it, a real entry
// without), and Spanish questions open with an inverted mark -- hence the CJK
// and inverted marks in the edge class. Hyphens are deliberately left alone:
// "pre-" and "-ing" are real entries. Edge quotes are safe to strip here even
// though "'tis" is a headword, because this is only ever tried AFTER the exact
// term missed.
const PBP_DICT_EDGE_PUNCT = "\\s.,;:!?\u2026\"'\u201C\u201D\u00AB\u00BB\u201E\u201A()[\\]{}<>" +
  "\u00A1\u00BF\u3000-\u3002\u3008-\u3011\uFF01\uFF02\uFF07-\uFF09\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\uFF61-\uFF64";
function pbpDictCleanCandidate(term, lang) {
  const exact = pbpDictNormalizeTerm(term);
  if (!exact || !PBP_DICT_QUERY_LANGS.includes(pbpDictPrimaryLang(lang))) return "";
  const cleaned = pbpDictNormalizeTerm(
    exact
      .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "")
      .replace(/[\u2018\u2019\u201B\u02BC]/g, "'")
      .replace(new RegExp("^[" + PBP_DICT_EDGE_PUNCT + "]+"), "")
      .replace(new RegExp("[" + PBP_DICT_EDGE_PUNCT + "]+$"), "")
  );
  return cleaned && cleaned !== exact ? cleaned : "";
}

// Ordered lookup candidates for one selection. The exact term goes first and
// always bypasses the cache; every later candidate is an alias whose result is
// also cached under the exact key. Candidates that collapse onto an earlier
// one are dropped, so an ordinary lowercase word still costs exactly one
// request. Once a term has artifacts the chain lowercases the CLEANED form and
// not the raw one: a headword containing a curly apostrophe or a soft hyphen
// does not exist (en/don’t answers with zero entries), so lowercasing the raw
// form would only buy a fourth request that cannot hit. A sentence-initial
// "Don’t" therefore reaches "don't" in three steps.
function pbpDictQueryCandidates(term, lang) {
  const exact = pbpDictNormalizeTerm(term);
  const out = [{ term: exact, skipCache: true, aliasExact: false }];
  if (!exact) return out;
  const cleaned = pbpDictCleanCandidate(exact, lang);
  const seen = new Set([exact]);
  for (const c of cleaned ? [cleaned, pbpDictLowerCandidate(cleaned, lang)] : [pbpDictLowerCandidate(exact, lang)]) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push({ term: c, skipCache: false, aliasExact: true });
  }
  return out;
}

function _pbpDictIsFormOfSense(s) {
  for (const x of Array.isArray(s && s.tags) ? s.tags : []) {
    if (typeof x === "string" && x.toLowerCase().replace(/-/g, " ").trim() === "form of") return true;
  }
  return false;
}

// Wiktionary answers an inflected form with a grammar pointer and nothing else
// -- es/aprovecho is only "first-person singular present indicative of
// aprovechar" -- tagged "form of". Rendering that and stopping strands the
// reader on a cross-reference, so the chain keeps it as a last resort and
// carries on to the lemma. Read from the RAW senses, never the normalized
// copy: tags arrive alphabetically and the marker already reaches the last
// slot PBP_DICT_SENSE_TAG_CAP keeps (pl/psa is index 2 of 6), so one more
// early tag would slice it off; senses are capped too, so a real sense can sit
// past the cut. Detection must not ride on a display cap.
function pbpDictEntriesAreFormOfOnly(rawEntries) {
  let sawSense = false;
  for (const e of Array.isArray(rawEntries) ? rawEntries : []) {
    for (const s of Array.isArray(e && e.senses) ? e.senses : []) {
      if (!s || typeof s.definition !== "string" || !s.definition) continue;
      sawSense = true;
      if (!_pbpDictIsFormOfSense(s)) return false;
    }
  }
  return sawSense;
}

// A form-of pointer ends with the lemma in plain sight ("first-person
// singular present indicative of aprovechar"). Users without an AI key have
// no lemma rescue, so the render layer turns that trailing word into a
// click-to-relookup; this helper isolates the (English-templated, since the
// source is English Wiktionary) split so it can be tested. null = leave the
// definition as plain text, exactly the old behaviour.
function pbpDictLemmaFromPointer(definition) {
  const m = /^(.*\bof\s+)(\S+?)([.。]?)$/.exec(String(definition || ""));
  return m && m[2] ? { prefix: m[1], lemma: m[2], suffix: m[3] } : null;
}

// Sense ranking. The reader is looking at a sentence, and the sentence is the
// one piece of context already in hand when the popup paints -- unlike the AI
// gloss, which arrives seconds later on its own stream and would reorder the
// list under the reader's eyes. So ordering happens once, at first paint, from
// the sentence alone.
//
// This only pays off when the sentence and the definitions share a language,
// which for English Wiktionary means an English article. Elsewhere -- a Spanish
// page, a CC-CEDICT Chinese gloss -- every score is zero and the stable sort
// leaves API order untouched, which is exactly the old behaviour.
const PBP_DICT_STOPWORDS = new Set(("the of and to in a is that it for on with as was at by an be this from or " +
  "which but not are have has had were been their they them its his her she him one all any can could would should " +
  "may might will shall must do does did done make made get got other into more most such than then there these " +
  "those when where who whom whose what why how also some each very much many out up down over under again " +
  "between during before after above below off through about against both few own same too only just").split(" "));

// Deliberately crude: enough to make "running" match "run" and "senses" match
// "sense" without carrying a stemmer. Over-stemming costs a point of precision
// in a ranking, never correctness.
function _pbpDictStem(w) {
  // "running" -> "runn" -> "run": without undoubling, the inflected form never
  // meets the base form and the whole point of stemming is lost.
  const undouble = (x) => (/([bdfglmnprt])\1$/.test(x) ? x.slice(0, -1) : x);
  if (w.length > 5 && w.endsWith("ing")) return undouble(w.slice(0, -3));
  if (w.length > 4 && w.endsWith("ed")) return undouble(w.slice(0, -2));
  if (w.length > 4 && w.endsWith("ly")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

function pbpDictContentTokens(text) {
  const out = new Set();
  for (const raw of String(text || "").toLowerCase().split(/[^a-z]+/)) {
    if (raw.length < 3 || PBP_DICT_STOPWORDS.has(raw)) continue;
    out.add(_pbpDictStem(raw));
  }
  return out;
}

// Everything the sense carries, not just the definition: examples and synonyms
// are where a sentence's wording most often shows up.
function _pbpDictSenseTokens(s) {
  return pbpDictContentTokens([
    s.definition, (s.examples || []).map(example => typeof example === "string" ? example
      : [example?.text, example?.translation].filter(Boolean).join(" ")).join(" "), (s.tags || []).join(" "),
    (s.synonyms || []).join(" "), (s.subsenses || []).join(" ")
  ].join(" "));
}

// Rank senses and entries against the host sentence. Returns a NEW view
// carrying the FULL ordered sense list -- the render layer cuts to SHOW and
// parks the rest behind a click-to-expand, so a mis-ranked sense is one
// click away instead of discarded. norm is never mutated, because the same
// object is what goes into the cache and what pbpDictSaveCurrent reads
// senses[0] out of when it writes a vocabulary record.
function pbpDictOrderForContext(entries, sentence) {
  const list = Array.isArray(entries) ? entries : [];
  const ctx = pbpDictContentTokens(sentence);
  if (!ctx.size) return list.map((e) => ({ ...e, senses: e.senses.slice() }));

  // Rarity is measured across the whole word's sense pool so scores stay
  // comparable between entries, which is what lets the matching entry lead.
  const pool = [];
  for (const e of list) for (const s of e.senses) pool.push(_pbpDictSenseTokens(s));
  const df = new Map();
  for (const toks of pool) for (const tok of toks) df.set(tok, (df.get(tok) || 0) + 1);
  const idf = (tok) => Math.log(1 + pool.length / (1 + (df.get(tok) || 0)));

  let i = 0;
  const scored = list.map((e) => {
    const senses = e.senses.map((s, k) => {
      // API order is itself a prior: the leading senses are the common ones,
      // and a bag of words will happily demote them on an incidental match.
      // Measured on the 60-case set, the sentence for "the first person to run
      // sub-9.7s races" pulled "To move swiftly." out of view in favour of a
      // competition sense. The prior decays as 1/(1+k) against an idf that
      // tops out near 3.6, so one rare shared word still wins and one common
      // one no longer does. Regressions 3 -> 1, gains unchanged at 22; the
      // plateau runs from 1.5 to 3.0, so this is not a knife-edge fit.
      let score = PBP_DICT_SENSE_ORDER_PRIOR / (1 + k);
      for (const tok of _pbpDictSenseTokens(s)) if (ctx.has(tok)) score += idf(tok);
      return { s, score, i: i++ };
    });
    // Stable everywhere: equal scores, and the all-zero case, keep API order.
    senses.sort((a, b) => (b.score - a.score) || (a.i - b.i));
    return { e, senses, best: senses.length ? senses[0].score : 0 };
  });
  scored.forEach((x, n) => { x.n = n; });
  scored.sort((a, b) => (b.best - a.best) || (a.n - b.n));
  return scored.map((x) => ({ ...x.e, senses: x.senses.map((y) => y.s) }));
}

// freedictionaryapi.com response -> internal render model. null when nothing
// renderable (zh returns {entries:[]}). Field-by-field copies only.
function pbpDictNormalizeEntry(json) {
  if (!json || !Array.isArray(json.entries) || !json.entries.length) return null;
  const entries = [];
  for (const e of json.entries) {
    if (!e || typeof e !== "object") continue;
    const ipas = [];
    let ipaTotal = 0;
    for (const p of Array.isArray(e.pronunciations) ? e.pronunciations : []) {
      if (p && p.type === "ipa" && typeof p.text === "string" && p.text) {
        ipaTotal++;
        if (ipas.length < PBP_DICT_IPA_CAP) {
          ipas.push({ text: p.text, tags: Array.isArray(p.tags) ? p.tags.filter((x) => typeof x === "string") : [] });
        }
      }
    }
    const forms = [];
    for (const f of Array.isArray(e.forms) ? e.forms : []) {
      if (forms.length >= PBP_DICT_FORM_CAP) break;
      if (f && typeof f.word === "string" && f.word) {
        forms.push({ word: f.word, tags: Array.isArray(f.tags) ? f.tags.filter((x) => typeof x === "string") : [] });
      }
    }
    const senses = [];
    for (const s of Array.isArray(e.senses) ? e.senses : []) {
      if (senses.length >= PBP_DICT_SENSE_KEEP) break;
      if (!s || typeof s.definition !== "string" || !s.definition) continue;
      const examples = [];
      for (const x of Array.isArray(s.examples) ? s.examples : []) {
        if (examples.length >= PBP_DICT_EXAMPLE_CAP) break;
        if (typeof x === "string" && x) examples.push(x);
        else if (x && typeof x.text === "string" && x.text) examples.push(x.text);
      }
      const rel = (list) => {
        const out = [];
        for (const y of Array.isArray(list) ? list : []) {
          if (out.length >= PBP_DICT_REL_CAP) break;
          if (typeof y === "string" && y) out.push(y);
        }
        return out;
      };
      const subsenses = [];
      for (const b of Array.isArray(s.subsenses) ? s.subsenses : []) {
        if (subsenses.length >= PBP_DICT_SUBSENSE_CAP) break;
        if (b && typeof b.definition === "string" && b.definition) subsenses.push(b.definition);
      }
      senses.push({
        definition: s.definition,
        examples,
        tags: (Array.isArray(s.tags) ? s.tags.filter((x) => typeof x === "string" && x) : []).slice(0, PBP_DICT_SENSE_TAG_CAP),
        synonyms: rel(s.synonyms),
        antonyms: rel(s.antonyms),
        subsenses
      });
    }
    if (ipas.length || senses.length || forms.length) {
      // ipaMore makes the cap visible instead of silent ("3 shown" used to be
      // indistinguishable from "3 exist"). Records cached before this field
      // existed read undefined and simply show no hint.
      entries.push({
        pos: typeof e.partOfSpeech === "string" ? e.partOfSpeech : "", ipas, forms, senses,
        ipaMore: Math.max(0, ipaTotal - PBP_DICT_IPA_CAP)
      });
    }
  }
  if (!entries.length) return null;
  const src = json.source && typeof json.source === "object" ? json.source : {};
  const lic = src.license && typeof src.license === "object" ? src.license : {};
  return {
    word: typeof json.word === "string" ? json.word : "",
    entries,
    // Carried on the model, not on the classify result, so it survives a round
    // trip through the dict2_ cache. Entries cached before this existed simply
    // read as undefined and behave the way they always did.
    formOfOnly: pbpDictEntriesAreFormOfOnly(json.entries),
    // Retention stamp. A record cached under a smaller KEEP holds fewer senses
    // than the ranker needs, and those are exactly the polysemous words the
    // ranking is for. Reading it as a miss refetches and overwrites the same
    // key, which beats bumping the cache prefix: no orphaned dict2_ records,
    // and no rename across ai-cache.js's 500-entry pool.
    senseKeep: PBP_DICT_SENSE_KEEP,
    sourceLabel: "Wiktionary",
    sourceUrl: pbpDictSafeUrl(src.url),
    license: typeof lic.name === "string" ? lic.name : ""
  };
}

// A healthy 404 and a healthy 200 with no renderable entries are both
// semantic misses. Transport/server failures must never become "no entry".
function pbpDictClassifyResponse(out) {
  const status = out && out.status;
  const norm = status === 200 ? pbpDictNormalizeEntry(out.data) : null;
  if (norm) return { kind: "hit", norm };
  if (status === 404 || status === 200) return { kind: "miss", norm: null };
  return { kind: "failure", norm: null, status: status || 0 };
}

// Which sentence a load failure gets. The reader cannot fix "unavailable";
// they can fix "offline" (reconnect) and wait out "busy" (429 / 5xx / the 8s
// timeout -- a parent cancel never reaches here). Anything else, a bad JSON
// body or a network error while the browser still says online, stays the
// neutral "unavailable". Pure: `online` is navigator.onLine, passed in.
function pbpDictFailureKey(err, online) {
  if (online === false) return "dictOffline";
  const status = err && err.status;
  if (status === 429 || status >= 500 || (err && err.name === "AbortError")) return "dictServiceBusy";
  return "dictLoadFailed";
}
function _pbpDictFailureError(res) {
  const err = new Error("Dictionary request failed");
  err.status = (res && res.status) || 0;
  return err;
}

function pbpDictWiktionaryUrl(term) {
  return "https://en.wiktionary.org/wiki/" + encodeURIComponent(pbpDictNormalizeTerm(term));
}

function pbpDictCircuitAfter(state, event, now) {
  const prev = state || { failures: 0, openUntil: 0 };
  if (event === "healthy") return { failures: 0, openUntil: 0 };
  if (event !== "failure") return { failures: prev.failures || 0, openUntil: prev.openUntil || 0 };
  const failures = (prev.failures || 0) + 1;
  return failures >= PBP_DICT_CIRCUIT_THRESHOLD
    ? { failures, openUntil: Number(now || 0) + PBP_DICT_CIRCUIT_COOLDOWN_MS }
    : { failures, openUntil: 0 };
}

// Anki CSV-style field quoting.
function pbpDictTsvField(v, columnIndex) {
  const s = String(v == null ? "" : v);
  // Anki treats an unquoted # at record start as a comment. Quote that first
  // field; # on a continuation line inside a quoted field is already data.
  if ((columnIndex === 0 && s.startsWith("#")) || /[\t\n\r"]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// TSV export (6 columns: Term/Reading/Definition/Context/Source/License).
// Six columns, always. A locally derived Chinese sense is appended INSIDE the
// Definition column and its labelled origin INSIDE License, so a device without
// the pack produces the same shape with those pieces simply absent -- never an
// empty seventh column, and never a dangling separator.
function pbpDictTsv(rows) {
  const head = "#separator:Tab\n#html:false\n#columns:Term\tReading\tDefinition\tContext\tSource\tLicense\n";
  const body = (Array.isArray(rows) ? rows : []).map((r) => {
    const ctx = Array.isArray(r.contexts) ? r.contexts.filter(Boolean).join("\n") : String(r.contexts || "");
    const def = r.zh ? [r.definition, r.zh].filter(Boolean).join("\n") : r.definition;
    const lic = r.zhNote ? [r.license, r.zhNote].filter(Boolean).join(" | ") : r.license;
    return [r.term, r.reading, def, ctx, r.source, lic].map(pbpDictTsvField).join("\t");
  }).join("\n");
  return head + body + (body ? "\n" : "");
}

// ---- PURE END ----

// ---- Pronunciation (speechSynthesis + click-token guard) ----------------
const PBP_DICT_SPEAKER_SVG = typeof PBP_ICONS !== "undefined" ? PBP_ICONS.speaker : "";

// Static inline SVG (Feather book-open). Constant string, never model text.
// Consumed by the highlight selection bar's dictionary button (md-highlight.js).
// Alias of the shared book icon (Lucide book-open) -- same glyph the
// explain-pop action switch and the highlight card use for Dictionary.
const PBP_DICT_BOOK_SVG = typeof PBP_ICONS !== "undefined" ? PBP_ICONS.book : "";

let _pbpDictSpeakSeq = 0;
function pbpDictSpeak(text, lang) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const token = ++_pbpDictSpeakSeq; // a newer click invalidates every pending pick()
    synth.cancel();
    const u = new SpeechSynthesisUtterance(String(text || "").slice(0, 200));
    const primary = pbpDictPrimaryLang(lang);
    if (primary) u.lang = primary;
    let spoken = false;
    let timer = 0;
    // Named handler (not { once: true }) so a stale-token bail-out or the
    // 400ms timeout firing FIRST still removes it -- otherwise a repeat click
    // before voiceschanged ever fires leaves the old listener registered
    // forever, accumulating one per click.
    const onVoicesChanged = () => pick();
    const cleanup = () => {
      clearTimeout(timer);
      synth.removeEventListener("voiceschanged", onVoicesChanged);
    };
    const pick = () => {
      if (spoken || token !== _pbpDictSpeakSeq) { cleanup(); return; }
      spoken = true;
      cleanup();
      // Prefer a LOCAL voice. Chrome ships "Google <language>" voices with
      // localService:false -- those synthesize on Google's servers, so picking
      // one would send the looked-up word off the device. Leaving u.voice unset
      // is NOT the safe default either: the UA default is frequently one of
      // those remote voices. Both residual paths (no local voice for the
      // language, and no language at all) are disclosed in docs/privacy.md.
      if (primary) {
        const vs = synth.getVoices().filter((x) => x.lang && x.lang.toLowerCase().startsWith(primary));
        const v = vs.find((x) => x.localService) || vs[0];
        if (v) u.voice = v;
      }
      synth.speak(u);
    };
    if (synth.getVoices().length) { pick(); return; }
    synth.addEventListener("voiceschanged", onVoicesChanged);
    timer = setTimeout(pick, 400);
  } catch (_) {}
}

// ---- Dictionary slot ----------------------------------------------------
async function _pbpDictHasPerm() {
  try { return await chrome.permissions.contains({ origins: [PBP_DICT_ORIGIN + "/*"] }); } catch (_) { return false; }
}

// Hand-rolled instead of AbortSignal.any: the circuit breaker needs to know
// WHICH cause fired -- a parent cancel must not count as a service failure.
// Keep the first cause so closing the popover never trips the service circuit.
function _pbpDictChildSignal(parent, ms) {
  const c = new AbortController();
  let reason = "";
  const abortWith = (next) => {
    if (c.signal.aborted) return;
    reason = next;
    c.abort();
  };
  const onAbort = () => abortWith("parent");
  if (parent) {
    if (parent.aborted) abortWith("parent");
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => abortWith("timeout"), ms);
  return {
    signal: c.signal,
    reason: () => reason,
    done: () => { clearTimeout(timer); if (parent) parent.removeEventListener("abort", onAbort); }
  };
}

let _pbpDictCircuit = { failures: 0, openUntil: 0 };

async function _pbpDictFetch(lang, term, parentSignal) {
  if (parentSignal && parentSignal.aborted) throw new DOMException("Aborted", "AbortError");
  const now = Date.now();
  if (_pbpDictCircuit.openUntil && now >= _pbpDictCircuit.openUntil) {
    _pbpDictCircuit = { failures: 0, openUntil: 0 };
  }
  if (_pbpDictCircuit.openUntil > now) {
    const err = new Error("Dictionary service cooling down");
    err.code = "dict_circuit_open";
    err.retryInMs = _pbpDictCircuit.openUntil - now; // lets the UI say when, not just that
    throw err;
  }
  const child = _pbpDictChildSignal(parentSignal, 8000);
  let failureRecorded = false;
  const failed = () => {
    if (failureRecorded) return;
    failureRecorded = true;
    _pbpDictCircuit = pbpDictCircuitAfter(_pbpDictCircuit, "failure", Date.now());
  };
  try {
    const res = await fetch(
      PBP_DICT_ORIGIN + "/api/v1/entries/" + encodeURIComponent(lang) + "/" + encodeURIComponent(term),
      { signal: child.signal }
    );
    if (res.status === 429 || res.status >= 500) {
      failed();
      return { status: res.status, data: null };
    }
    if (res.status === 404 || !res.ok) {
      _pbpDictCircuit = pbpDictCircuitAfter(_pbpDictCircuit, "healthy", Date.now());
      return { status: res.status, data: null };
    }
    const data = await res.json();
    _pbpDictCircuit = pbpDictCircuitAfter(_pbpDictCircuit, "healthy", Date.now());
    return { status: res.status, data };
  } catch (e) {
    if (child.reason() !== "parent") failed();
    throw e;
  } finally { child.done(); }
}

// External dictionary data renders through textContent ONLY.
function _pbpDictTagLabel(tag) {
  const key = { pinyin: "dictTagPinyin", simp: "dictTagSimplified", trad: "dictTagTraditional", reading: "dictTagReading" }[
    String(tag || "").toLowerCase()
  ];
  return key ? t(key) : String(tag || "");
}

// Shared by the online entry and the local ECDICT block. Every read is
// defensive: CC-CEDICT norms and dict2_ records cached before these fields
// existed carry none of them.
function _pbpDictSenseLi(s, formOf, termLang, definitionLang) {
  const li = document.createElement("li");
  // The dictionary edition owns the definition language; the query owns the
  // example/lemma language. Neither may inherit the extension's UI locale.
  li.lang = definitionLang || "und";
  li.dir = "auto";
  const stags = s.tags || [];
  if (stags.length) {
    const tg = document.createElement("span");
    tg.className = "xp-dict-sense-tag";
    tg.dir = "auto";
    tg.textContent = "(" + stags.join(", ") + ")";
    li.appendChild(tg);
    li.appendChild(document.createTextNode(" "));
  }
  // In a form-of-only entry the definition is a grammar pointer, and without
  // an AI key it used to be a dead end. Make the lemma itself the way out:
  // one click reruns the lookup on the base form. Parse miss = plain text.
  const pointer = formOf ? pbpDictLemmaFromPointer(s.definition) : null;
  if (pointer) {
    li.appendChild(document.createTextNode(pointer.prefix));
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "xp-dict-lemma-link";
    jump.lang = termLang || "und";
    jump.dir = "auto";
    jump.textContent = pointer.lemma;
    jump.addEventListener("click", () => {
      const live = _pbpDictCurrent;
      if (live && typeof live.rerunWith === "function") live.rerunWith(pointer.lemma);
    });
    li.appendChild(jump);
    if (pointer.suffix) li.appendChild(document.createTextNode(pointer.suffix));
  } else {
    li.appendChild(document.createTextNode(s.definition));
  }
  for (const d of s.subsenses || []) {
    const sub = document.createElement("div");
    sub.className = "xp-dict-subsense";
    sub.dir = "auto";
    sub.textContent = d;
    li.appendChild(sub);
  }
  for (const x of s.examples || []) {
    const pair = document.createElement("div");
    pair.className = "xp-dict-example-pair";
    const ex = document.createElement("div");
    ex.className = "xp-dict-example";
    ex.lang = (typeof x === "object" && x.lang) || termLang || "und";
    ex.dir = "auto";
    ex.textContent = typeof x === "string" ? x : x.text;
    pair.appendChild(ex);
    if (typeof x === "object" && x.translation) {
      const translation = document.createElement("div");
      translation.className = "xp-dict-example xp-dict-example-translation";
      translation.lang = x.translationLang || definitionLang || "und"; translation.dir = "auto";
      translation.textContent = x.translation; pair.appendChild(translation);
    }
    li.appendChild(pair);
  }
  for (const [key, words] of [["dictSynonyms", s.synonyms], ["dictAntonyms", s.antonyms]]) {
    if (!words || !words.length) continue;
    const row = document.createElement("div");
    row.className = "xp-dict-rel";
    row.lang = termLang || "und";
    row.dir = "auto";
    const lb = document.createElement("span");
    lb.className = "xp-dict-rel-label";
    lb.lang = document.documentElement.lang || "und";
    lb.textContent = t(key);
    row.appendChild(lb);
    row.appendChild(document.createTextNode(" " + words.join(", ")));
    li.appendChild(row);
  }
  return li;
}

// Default density is unchanged: SHOW senses render, the rest sit behind an
// explicit click ("expand the other N"). The data is already in memory and
// in the dict2_ cache -- the button costs no request. Click, never hover.
function _pbpDictRenderSenses(parent, senses, formOf, termLang, definitionLang) {
  const ol = document.createElement("ol");
  ol.className = "xp-dict-senses";
  const rest = senses.slice(PBP_DICT_SENSE_SHOW);
  for (const s of senses.slice(0, PBP_DICT_SENSE_SHOW)) ol.appendChild(_pbpDictSenseLi(s, formOf, termLang, definitionLang));
  parent.appendChild(ol);
  if (rest.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "xp-dict-more";
    more.textContent = t("dictMoreSenses", String(rest.length));
    more.addEventListener("click", () => {
      for (const s of rest) ol.appendChild(_pbpDictSenseLi(s, formOf, termLang, definitionLang));
      more.remove();
    });
    parent.appendChild(more);
  }
}

function _pbpDictRenderEntry(slot, norm, term, lang, selectedTerm, sentence) {
  slot.replaceChildren();
  const definitionLang = pbpDictDefinitionLang(norm);
  const actual = pbpDictNormalizeTerm(norm.word || term);
  const selected = pbpDictNormalizeTerm(selectedTerm);
  if (selected && actual && actual !== selected) {
    const matched = document.createElement("div");
    matched.className = "xp-dict-match";
    matched.textContent = t("dictMatchedHeadword", actual);
    slot.appendChild(matched);
  }
  for (const e of pbpDictOrderForContext(norm.entries, sentence)) {
    const ent = document.createElement("div");
    ent.className = "xp-dict-entry";
    if (e.ipas.length || e.pos) {
      const line = document.createElement("div");
      line.className = "xp-dict-ipa-line";
      if (e.pos) {
        const pos = document.createElement("span");
        pos.className = "xp-dict-pos";
        pos.lang = definitionLang;
        pos.textContent = e.pos;
        line.appendChild(pos);
      }
      for (const p of e.ipas) {
        const ipa = document.createElement("span");
        ipa.className = "xp-dict-ipa";
        ipa.textContent = p.text;
        line.appendChild(ipa);
        if (p.tags.length) {
          const tag = document.createElement("span");
          tag.className = "xp-dict-ipa-tag";
          tag.textContent = p.tags.map(_pbpDictTagLabel).join(", ");
          line.appendChild(tag);
        }
      }
      if (e.ipaMore > 0) {
        const moreIpa = document.createElement("span");
        moreIpa.className = "xp-dict-ipa-tag";
        moreIpa.textContent = t("dictMoreIpa", String(e.ipaMore));
        line.appendChild(moreIpa);
      }
      ent.appendChild(line);
    }
    if (e.forms.length) {
      const forms = document.createElement("div");
      forms.className = "xp-dict-forms";
      forms.textContent = e.forms.map((f) => f.word + (f.tags.length ? " (" + f.tags.map(_pbpDictTagLabel).join(", ") + ")" : "")).join(" · ");
      ent.appendChild(forms);
    }
    if (e.senses.length) _pbpDictRenderSenses(ent, e.senses, !!norm.formOfOnly, lang, definitionLang);
    if (e.etymology?.length) {
      _pbpDictEntryDisclosure(ent, t("dictEntryEtymology"), e.etymology.join("\n\n"), definitionLang);
    }
    if (e.fullText) {
      const full = e.fullText.replace(/\s+/gu, " ").trim();
      const definitions = e.senses.map(sense => sense.definition).join(" ").replace(/\s+/gu, " ").trim();
      if (!e.senses.length || full !== definitions) {
        _pbpDictEntryDisclosure(ent, t("dictFullEntry"), e.fullText, definitionLang, !e.senses.length);
      }
    }
    slot.appendChild(ent);
  }
  if (norm.hasFullEntry && !pbpDictNormChoices(norm, lang).length) {
    const hint = document.createElement("p"); hint.className = "xp-dict-msg";
    hint.textContent = t("dictFullEntryOnlyHint"); slot.appendChild(hint);
  }
  if (norm.needsReimport) {
    const hint = document.createElement("p"); hint.className = "xp-dict-msg";
    hint.textContent = t("multiPackReimportHint"); slot.appendChild(hint);
  }
  const src = document.createElement("div");
  src.className = "xp-dict-src";
  const label = document.createElement("span");
  // A label that already ends in full-width punctuation (zh "来源：") carries
  // its own spacing; only a half-width one (en "Source:", ja "出典:") gets a space.
  const srcLabel = t("dictSource");
  label.textContent = /[\u3000-\u303f\uff00-\uffef]$/.test(srcLabel) ? srcLabel : srcLabel + " ";
  const sourceUrl = pbpDictSafeUrl(norm.sourceUrl) || (!norm.packId && !norm.aiGenerated ? pbpDictWiktionaryUrl(term) : "");
  const a = document.createElement(sourceUrl ? "a" : "span");
  // Defense-in-depth: sourceUrl is already sanitized at the normalize/merge
  // layers, but this is the only point it reaches a live href.
  if (sourceUrl) { a.href = sourceUrl; a.target = "_blank"; a.rel = "noopener noreferrer"; }
  a.textContent = norm.aiGenerated ? t("dictAiLabel") :
    [norm.sourceLabel || "Wiktionary", norm.license || (!norm.packId ? "CC BY-SA" : ""), norm.attribution || ""].filter(Boolean).join(" · ");
  src.appendChild(label);
  src.appendChild(a);
  slot.appendChild(src);
  _pbpDictSyncSourceDividers(slot);
}

function _pbpDictEntryDisclosure(parent, label, text, lang, open = false) {
  const details = document.createElement("details"); details.className = "xp-dict-ai-details"; details.open = open;
  const summary = document.createElement("summary"); summary.textContent = label;
  const content = document.createElement("p"); content.className = "xp-dict-full-text";
  content.lang = lang || "und"; content.dir = "auto"; content.textContent = text;
  details.append(summary, content); parent.appendChild(details);
}

// Count populated sources in DOM order, not asynchronous arrival order. Empty
// local hosts are always mounted, so :not(:empty) on that host is misleading.
function _pbpDictSyncSourceDividers(node) {
  const slot = node.closest?.(".xp-dict-slot");
  if (!slot) return;
  let count = 0;
  for (const source of slot.querySelectorAll(".xp-dict-local-box, .xp-dict-online")) {
    const populated = !!source.childElementCount;
    source.toggleAttribute("data-source-break", populated && count > 0);
    if (populated) count++;
  }
}

function _pbpDictSlotMsg(slot, text) {
  slot.replaceChildren();
  const p = document.createElement("div");
  p.className = "xp-dict-msg";
  p.textContent = text;
  slot.appendChild(p);
  _pbpDictSyncSourceDividers(slot);
}

function _pbpDictSlotFallback(slot, text, term) {
  _pbpDictSlotMsg(slot, text);
  const src = document.createElement("div");
  src.className = "xp-dict-src";
  const a = document.createElement("a");
  a.href = pbpDictWiktionaryUrl(term);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = t("dictViewWiktionary");
  src.appendChild(a);
  slot.appendChild(src);
}

// ECDICT contributes an independent local section, alongside online results.
// CC-CEDICT follows the same independent-source pattern for Chinese queries.
// Six contracts:
//  1. English only.
//  2. Never awaited by the online chain -- the network request must not wait on
//     an IDB read. Launched fire-and-forget for that reason.
//  3. UI-silent on EVERY failure, including thrown ones, but platform errors
//     still get a console.warn (name and message only, never the term).
//  4. Re-checks abort and run identity after each await, so a late answer cannot
//     write into a container that belongs to a newer lookup.
//  5. Contributes nothing to _pbpDictSlotRun's return value.
//  6. Writes no cur.* field, so the saved vocabulary record is unaffected.
// The library may opt into the already-rendered normalized result through
// onResult. This synchronous notification adds no reads or reader wait and
// does not change this branch's undefined return value.
async function _pbpDictEcdictSide(localEl, term, lang, parentSignal, cur, onResult) {
  if (lang !== "en") return;
  const alive = () => !(parentSignal && parentSignal.aborted) && _pbpDictCurrent === cur && localEl.isConnected;
  try {
    const loaded = await _pbpDictLoadPack();
    if (!alive() || !loaded || typeof pbpEcdictLookup !== "function") return;
    let local = await pbpEcdictLookup(term);
    if (!alive()) return;
    // Exact first -- "e.g." is a real headword, so cleaning cannot run up
    // front. On a genuine miss, retry the cleaned form: "ubiquitous." and
    // "don’t" have no ECDICT key of their own.
    if (local && local.state === "ready-miss") {
      const cleaned = pbpDictCleanCandidate(term, lang);
      if (cleaned) {
        local = await pbpEcdictLookup(cleaned);
        if (!alive()) return;
      }
    }
    if (!local || local.state !== "hit") return;   // unavailable / miss / error: say nothing
    const norm = pbpEcdictEntryToNorm(local.rows, local.matched);
    if (!norm.entries.length) return;
    const box = document.createElement("div");
    box.className = "xp-dict-local-box";
    const title = document.createElement("div");
    title.className = "xp-dict-local-title";
    title.textContent = t("dictZhBlockTitle");
    box.appendChild(title);
    // EVERY entry, not just the first. Case folding puts distinct headwords on
    // one key -- "US" (the country) and "us" (the pronoun) both fold to "us" --
    // so rendering entries[0] would show whichever the file happened to list
    // first and silently drop the other.
    for (const e of norm.entries) _pbpDictRenderSenses(box, e.senses, false, lang, "zh");
    localEl.replaceChildren(box);
    _pbpDictSyncSourceDividers(localEl);
    if (typeof onResult === "function" && alive()) onResult(norm);
  } catch (e) {
    // Swallowing without a trace is what turns a platform fault into a silent
    // "no Chinese for this word" that nobody can diagnose.
    console.warn("[dict] local ECDICT lookup failed:", e && e.name, e && e.message);
  }
}

// Chinese local data is independent of the online source, just like ECDICT.
// A miss or an unavailable pack must never prevent an authorized online lookup.
async function _pbpDictCedictSide(localEl, term, lang, parentSignal, cur, onResult) {
  if (lang !== "zh") return;
  const alive = () => !parentSignal?.aborted && _pbpDictCurrent === cur && localEl.isConnected &&
    (!cur.isCurrent || cur.isCurrent());
  try {
    if (!(await _pbpDictLoadPack()) || !alive() || typeof pbpPackLookup !== "function") return;
    const exact = pbpDictNormalizeTerm(term);
    const local = await pbpPackLookup(pbpCedictLookupKeys(pbpDictCleanCandidate(exact, lang) || exact));
    if (!alive() || local?.state !== "hit") return;
    const norm = pbpCedictEntryToNorm(local.rows, local.matched);
    if (!norm.entries.length) return;
    const box = document.createElement("div"); box.className = "xp-dict-local-box";
    _pbpDictRenderEntry(box, norm, local.matched, lang, term, cur.sentence);
    localEl.replaceChildren(box);
    _pbpDictSyncSourceDividers(localEl);
    if (typeof onResult === "function" && alive()) onResult(norm);
  } catch (error) {
    console.warn("[dict] local CC-CEDICT lookup failed:", error?.name, error?.message);
  }
}

// Every enabled matching source has its own section. This leg neither waits
// for the online result nor mutates its cache/current-word save state.
const _pbpDictPackRefresh = new WeakMap();
async function _pbpDictPackSide(el, term, lang, signal, cur, onResult, preference, cachedResult) {
  const token = {}; _pbpDictPackRefresh.set(el, token);
  const alive = () => !signal?.aborted && _pbpDictPackRefresh.get(el) === token &&
    _pbpDictCurrent === cur && el.isConnected && (!cur.isCurrent || cur.isCurrent());
  const failed = () => {
    if (!alive()) return;
    _pbpDictSlotMsg(el, t("dictLoadFailed"));
    const retry = document.createElement("button");
    retry.type = "button"; retry.className = "xp-retry";
    retry.innerHTML = PBP_ICONS.refresh; // Static shared icon, never source data.
    retry.append(t("explainErrRetry"));
    retry.addEventListener("click", () => {
      if (!alive()) return;
      retry.disabled = true;
      _pbpDictPackSide(el, term, lang, signal, cur, onResult, preference);
    });
    el.appendChild(retry);
  };
  try {
    if (!lang || !(await _pbpDictLoadPack()) || !alive() || typeof pbpDictPackLookup !== "function") return;
    const result = cachedResult || await pbpDictPackLookup(term, { sourceLanguage: lang, limit: 20 });
    if (!alive()) return;
    if (result?.state === "error") { failed(); return; }
    if (result?.state !== "hit") return;
    if (preference === undefined && typeof pbpReadSettingsWithSecrets === "function") {
      const settings = await pbpReadSettingsWithSecrets({ dictDefinitionLang: "" });
      if (!alive()) return;
      preference = settings.dictDefinitionLang;
    }
    const locale = typeof uiLangToBCP47 === "function" ? uiLangToBCP47() : document.documentElement.lang || "en";
    const target = pbpDictDefinitionLanguage(preference, locale).lang;
    const score = (hit) => {
      const code = pbpDictDefinitionLang(hit.norm);
      return code === target ? 0 : pbpDictPrimaryLang(code) === pbpDictPrimaryLang(target) ? 1 : 2;
    };
    const hits = (result.hits || []).filter(hit => hit?.norm?.entries?.length && hit.pack?.enabled !== false)
      .slice().sort((a, b) => score(a) - score(b));
    el.replaceChildren();
    for (const hit of hits) {
      const norm = { ...hit.norm, attribution: hit.pack?.attribution || hit.norm.attribution || "",
        packRevision: hit.pack?.revision || "", generation: hit.pack?.activeGeneration || hit.norm.generation || "" };
      const box = document.createElement("div"); box.className = "xp-dict-local-box";
      box.dataset.packId = norm.packId;
      const title = document.createElement("div"); title.className = "xp-dict-local-title";
      title.textContent = [hit.pack?.title || norm.sourceLabel, pbpDictLanguageLabel(pbpDictDefinitionLang(norm), locale)].filter(Boolean).join(" · ");
      const entry = document.createElement("div");
      _pbpDictRenderEntry(entry, norm, norm.word, lang, term, cur.sentence);
      box.append(title, entry); el.appendChild(box);
      if (typeof onResult === "function" && alive()) onResult(norm, box);
    }
    if (result.truncated) {
      const hint = document.createElement("div"); hint.className = "xp-dict-msg";
      hint.textContent = t("dictPackResultsLimited"); el.appendChild(hint);
    }
    _pbpDictSyncSourceDividers(el);
  } catch (error) {
    console.warn("[dict] multilingual pack lookup failed:", error?.name, error?.message);
    failed();
  } finally {
    if (alive()) _pbpDictSyncSourceDividers(el);
  }
}

// Reading metadata is local-only. Keep both the shipped languages and the
// user's current choice; a stale page/run must never rebuild a newer select.
const _pbpDictLangRefresh = new WeakMap();
function _pbpDictSyncSelectFace(select) {
  // Only the reader uses customizable native selects; library has its listbox.
  if (!select.classList.contains("xp-dict-lang")) return;
  let face = select.querySelector("selectedcontent");
  if (!face) {
    const button = document.createElement("button"); button.type = "button";
    face = document.createElement("selectedcontent"); button.appendChild(face);
    select.prepend(button);
  }
  // Chromium does not always clone the initial option after a dynamic rebuild.
  // Explicit text also covers programmatic selection before the first paint.
  face.textContent = select.selectedOptions[0]?.textContent || "";
}

async function _pbpDictRefreshPackLangs(sel, locale, includeAuto, isCurrent = () => true) {
  const token = {}; _pbpDictLangRefresh.set(sel, token);
  try {
    if (!(await _pbpDictLoadPack()) || typeof pbpDictPackList !== "function") return [...PBP_DICT_QUERY_LANGS];
    const packs = await pbpDictPackList();
    const codes = new Set(PBP_DICT_QUERY_LANGS);
    for (const pack of packs) {
      const code = pbpDictPrimaryLang(pack.sourceLanguage);
      if (pack.enabled && pbpDictLanguageLabel(code, locale)) codes.add(code);
    }
    if (!sel.isConnected || !isCurrent() || _pbpDictLangRefresh.get(sel) !== token) return [...codes];
    const keep = sel.value, oldAuto = sel.querySelector('option[value=""]')?.textContent;
    sel.replaceChildren();
    if (includeAuto) sel.appendChild(new Option(oldAuto || t("dictLangAuto"), ""));
    for (const code of codes) sel.appendChild(new Option(pbpDictLanguageLabel(code, locale) || code, code));
    if (keep === "" && includeAuto || codes.has(keep)) sel.value = keep;
    _pbpDictSyncSelectFace(sel);
    if (typeof pbpListboxSync === "function") pbpListboxSync(sel);
    return [...codes];
  } catch (error) {
    console.warn("[dict] installed language read failed:", error?.name, error?.message);
    return [...PBP_DICT_QUERY_LANGS];
  }
}

function _pbpDictSlotSkeleton(slot) {
  slot.replaceChildren();
  const sk = document.createElement("div");
  sk.className = "xp-skel";
  slot.appendChild(sk);
  const sr = document.createElement("span");
  sr.className = "sr-only";
  sr.textContent = t("dictLoading");
  slot.appendChild(sr);
  _pbpDictSyncSourceDividers(slot);
}

let _pbpDictPackNoticeTimer = 0;
let _pbpDictLegacyNotice = false;
function _pbpDictPacksChanged(event) {
  if (event?.detail?.kind === "legacy" || event?.kind === "legacy") _pbpDictLegacyNotice = true;
  if (_pbpDictPackNoticeTimer) return;
  _pbpDictPackNoticeTimer = setTimeout(() => {
    _pbpDictPackNoticeTimer = 0;
    const legacy = _pbpDictLegacyNotice; _pbpDictLegacyNotice = false;
    if (legacy && _pbpDictCurrent?.refreshLegacy) _pbpDictCurrent.refreshLegacy();
    else _pbpDictCurrent?.refreshPacks?.();
    _pbpDictCurrent?.refreshLanguages?.();
    const select = document.getElementById("vocab-lookup-lang");
    if (select) _pbpDictRefreshPackLangs(select,
      typeof uiLangToBCP47 === "function" ? uiLangToBCP47() : document.documentElement.lang || "en", false);
  }, 0);
}
window.addEventListener("pbp-dict-packs-changed", _pbpDictPacksChanged);
try {
  const channel = new BroadcastChannel("pbp-dict-packs");
  channel.addEventListener("message", event => { if (event.data?.type === "changed") _pbpDictPacksChanged(event.data); });
  window.addEventListener("pagehide", () => channel.close(), { once: true });
} catch (_) { /* Same-page notifications still work without BroadcastChannel. */ }

// dict-pack.js is NOT in md-preview.html: most users never import the pack,
// and the reader stays lean. First zh lookup injects it once (CSP 'self').
let _pbpDictPackLoad = null;
function _pbpDictLoadPack() {
  if (_pbpDictPackLoad) return _pbpDictPackLoad;
  _pbpDictPackLoad = new Promise((resolve) => {
    if (typeof pbpPackLookup === "function") { resolve(true); return; }
    const s = document.createElement("script");
    s.src = "dict-pack.js";
    s.onload = () => resolve(true);
    // Drop the cached promise on failure (transient network blip, extension
    // update mid-flight) so the NEXT zh lookup retries the injection instead
    // of permanently remembering this one failure.
    s.onerror = () => { _pbpDictPackLoad = null; resolve(false); };
    document.head.appendChild(s);
  });
  return _pbpDictPackLoad;
}

async function _pbpDictCacheGet(lang, term) {
  try {
    const hit = await pbpAiCacheGet(pbpDictQueryCacheKey(lang, term));
    const rec = hit && hit.result ? hit.result : null;
    return rec && rec.senseKeep === PBP_DICT_SENSE_KEEP ? rec : null;
  } catch (_) { return null; }
}

async function _pbpDictCacheSet(lang, term, norm) {
  try { await pbpAiCacheSet(pbpDictQueryCacheKey(lang, term), norm, Date.now()); } catch (_) {}
}

async function _pbpDictLookupCandidate(lang, term, parentSignal, skipCache) {
  if (!skipCache) {
    const cached = await _pbpDictCacheGet(lang, term);
    if (parentSignal && parentSignal.aborted) return { kind: "aborted", norm: null };
    if (cached) return { kind: "hit", norm: cached };
  }
  const classified = pbpDictClassifyResponse(await _pbpDictFetch(lang, term, parentSignal));
  if (classified.kind === "hit") await _pbpDictCacheSet(lang, term, classified.norm);
  return classified;
}

// exact cache -> exact request -> lowercase candidate -> AI lemma -> degrade.
// Returns normalized entry or null; the RUN layer merges into _pbpDictCurrent.
// onRerun: run-level restart used after a permission grant (never slot-local
// recursion — Codex HIGH 2).
async function _pbpDictSlotRun(slot, term, lang, parentSignal, lemmaPromise, onRerun, sentence) {
  const exact = pbpDictNormalizeTerm(term);
  if (!exact) { _pbpDictSlotFallback(slot, t("dictNoEntry"), term); return null; }
  // Unknown language is NOT a dictionary miss: nothing was queried. Saying
  // "no entry" here reads as "the dictionary is missing this word" and makes
  // Auto look broken; name the visible control the reader can fix it with.
  if (!lang) { _pbpDictSlotFallback(slot, t("dictLangUnknown"), term); return null; }
  if (!PBP_DICT_QUERY_LANGS.includes(pbpDictPrimaryLang(lang))) {
    _pbpDictSlotMsg(slot, t("dictOnlineLanguageUnavailable")); return null;
  }
  const exactHit = await _pbpDictCacheGet(lang, exact);
  if (parentSignal && parentSignal.aborted) return null;
  if (exactHit && !exactHit.formOfOnly) {
    _pbpDictRenderEntry(slot, exactHit, exact, lang, term, sentence);
    return exactHit;
  }
  if (!(await _pbpDictHasPerm())) {
    // A cached grammar pointer is still useful offline. With permission it
    // must follow the same lemma chain as a freshly fetched pointer below.
    if (exactHit) {
      _pbpDictRenderEntry(slot, exactHit, exact, lang, term, sentence);
      return exactHit;
    }
    slot.replaceChildren();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "xp-dict-connect";
    btn.textContent = t("dictConnect");
    const hint = document.createElement("div");
    hint.className = "xp-dict-msg";
    hint.textContent = t("dictConnectHint");
    const feedback = document.createElement("div");
    feedback.className = "xp-dict-msg";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    feedback.hidden = true;
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      feedback.hidden = true;
      feedback.textContent = "";
      let granted = false;
      // FIRST await in the click chain must be the permission request.
      try { granted = await chrome.permissions.request({ origins: [PBP_DICT_ORIGIN + "/*"] }); } catch (_) {}
      if (!granted) {
        btn.textContent = t("dictConnectRetry");
        feedback.hidden = false;
        feedback.textContent = t("dictPermissionDenied");
        btn.disabled = false;
        return;
      }
      if (typeof onRerun === "function") onRerun(); // full-run restart merges results properly
    });
    slot.appendChild(btn);
    slot.appendChild(hint);
    slot.appendChild(feedback);
    return null;
  }
  _pbpDictSlotSkeleton(slot);
  const tried = new Set();
  const runCandidate = async (candidate, skipCache) => {
    const key = pbpDictCacheKeyExact(lang, candidate);
    if (tried.has(key)) return { kind: "miss", norm: null };
    tried.add(key);
    if (candidate === exact && exactHit) return { kind: "hit", norm: exactHit };
    return _pbpDictLookupCandidate(lang, candidate, parentSignal, skipCache);
  };
  const finish = async (candidate, result, aliasExact) => {
    if (result.kind !== "hit") return null;
    if (aliasExact) await _pbpDictCacheSet(lang, exact, result.norm);
    if (parentSignal && parentSignal.aborted) return null;
    _pbpDictRenderEntry(slot, result.norm, candidate, lang, term, sentence);
    return result.norm;
  };
  // A form-of-only answer is a grammar pointer, not a meaning. Hold it back and
  // keep looking; render it at the end only because a cross-reference still
  // beats "no entry".
  let pointer = null;
  try {
    for (const cand of pbpDictQueryCandidates(exact, lang)) {
      const res = await runCandidate(cand.term, cand.skipCache);
      if (res.kind === "failure") throw _pbpDictFailureError(res);
      if (res.kind !== "hit") continue;
      if (res.norm && res.norm.formOfOnly) {
        if (!pointer) pointer = [cand.term, res, cand.aliasExact];
        continue;
      }
      return finish(cand.term, res, cand.aliasExact);
    }

    const lemma = pbpDictNormalizeTerm(await lemmaPromise); // resolves on ALL ctx-slot exits
    if (parentSignal && parentSignal.aborted) return null;
    if (lemma && lemma !== "-" && !tried.has(pbpDictCacheKeyExact(lang, lemma))) {
      const third = await runCandidate(lemma, false);
      if (third.kind === "failure") throw _pbpDictFailureError(third);
      if (third.kind === "hit") {
        if (!(third.norm && third.norm.formOfOnly)) return finish(lemma, third, false);
        if (!pointer) pointer = [lemma, third, false];
      }
    }
    if (pointer) return finish(pointer[0], pointer[1], pointer[2]);
  } catch (e) {
    if (parentSignal && parentSignal.aborted) return null;
    if (e && e.code === "dict_circuit_open") {
      // The breaker is a self-protection pause, not a fault. Say when it
      // lifts instead of the generic "unavailable", and offer no retry:
      // clicking one inside the window would only re-throw this same error.
      const secs = Math.max(1, Math.ceil((e.retryInMs || PBP_DICT_CIRCUIT_COOLDOWN_MS) / 1000));
      _pbpDictSlotFallback(slot, t("dictCircuitCooling", String(secs)), term);
      return null;
    }
    _pbpDictSlotFallback(slot, t(pbpDictFailureKey(e, typeof navigator === "undefined" ? undefined : navigator.onLine)), term);
    // Same affordance the AI slot has had all along: a plain failure gets a
    // retry that restarts the whole run (never slot-local recursion).
    if (typeof onRerun === "function") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "xp-retry";
      retry.innerHTML = PBP_ICONS.refresh; // static shared constant, never page content
      retry.append(t("explainErrRetry"));
      retry.addEventListener("click", () => { retry.disabled = true; onRerun(); });
      slot.appendChild(retry);
    }
    return null;
  }
  _pbpDictSlotFallback(slot, t("dictNoEntry"), term);
  return null;
}

// ---- Dictionary lookup + reusable AI entry -------------------------------
let _pbpDictRunSeq = 0;
// Manual language override: PER-DOCUMENT memory only (reset on pbp:rendered).
// It used to persist via settings, which silently forced every later lookup
// in every article to the stale choice -- a zh page kept "no entry"-ing
// because "en" was stuck from days earlier (real-device report).
let _pbpDictManualLang = "";
let _pbpDictCurrent = null;      // merged results of the LIVE run only
let _pbpDictChildCtrl = null;    // the live run's own controller (child of md-ask's)
let _pbpDictParentCleanup = null; // removes the previous run's parent-abort listener
let _pbpDictSaveTarget = null;   // {itemId} | {range} | null — explain-shaped
let _pbpDictOwner = "ownerless"; // set from pbp:rendered detail.account (Task 8 listener)

// Article-level CLD prior over the ORIGINAL prose (batch B). detectArticleLang
// (md-preview.js) is a font/RTL script heuristic that names no Latin or
// Cyrillic language, so Latin articles had no article rung at all. This one
// samples the original text -- .pb-tr overlays and PRE excluded, so a
// translated view never pollutes the prior -- and runs CLD once per document.
// A full-prose sample is where CLD is actually reliable (Chromium documents
// ~100+ chars); below that the prior abstains rather than guess.
let _pbpDictArticlePrior = null; // per-document Promise<{lang, reliable}>
// Excluded from the prior's sample: code (any nesting), translation overlays
// and their retry pills, and reader UI injected after render (image-fix rows).
// The sample is read lazily at first lookup, so translation-era nodes CAN be
// present -- the filter, not timing, is what keeps the original-prose promise.
const PBP_DICT_SAMPLE_EXCLUDE = "pre, code, .pb-tr, .pb-tr-err, .pbp-img-fix-ui";
function _pbpDictArticleSample() {
  const view = document.getElementById("rendered-view");
  if (!view) return "";
  let out = "";
  for (const el of view.children) {
    if (el.matches(PBP_DICT_SAMPLE_EXCLUDE)) continue;
    let text = el.textContent;
    if (el.querySelector(PBP_DICT_SAMPLE_EXCLUDE)) {
      const clone = el.cloneNode(true); // only blocks that actually need scrubbing pay the clone
      clone.querySelectorAll(PBP_DICT_SAMPLE_EXCLUDE).forEach((n) => n.remove());
      text = clone.textContent;
    }
    out += " " + text;
    if (out.length >= 800) break;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 800);
}
function _pbpDictArticleCld() {
  if (!_pbpDictArticlePrior) {
    const sample = _pbpDictArticleSample();
    _pbpDictArticlePrior = sample.length >= 100
      ? _pbpDictDetect(sample)
      : Promise.resolve({ lang: "", reliable: false });
  }
  return _pbpDictArticlePrior;
}

function _pbpDictDetect(text) {
  return new Promise((resolve) => {
    try {
      chrome.i18n.detectLanguage(String(text || "").slice(0, 800), (r) => {
        const top = r && Array.isArray(r.languages) && r.languages[0] ? r.languages[0].language : "";
        resolve({ lang: top, reliable: !!(r && r.isReliable) });
      });
    } catch (_) { resolve({ lang: "", reliable: false }); }
  });
}

// Ladder (spec §3, extended): manual -> explicit selection metadata
// (.pb-tr lang / highlight item.lang -- our own stamps, still gated for
// script fit so an untranslated Latin brand inside a zh translation block
// falls through) -> selection-script rung (deterministic, no CLD) ->
// reliable sentence CLD -> reliable block CLD (+article fallback) -> Latin
// last resort. EVERY automatic rung passes pbpDictAcceptLang, so a
// confident detection can no longer route a query the dropdown cannot
// express or the selection's script contradicts.
async function _pbpDictResolveLang(cap, ctx, manual, installedLanguages) {
  const view = document.getElementById("rendered-view");
  // "und" (an article whose language nothing could establish) is no route.
  const articleLang = view ? (view.getAttribute("lang") || "").replace(/^und$/i, "") : "";
  if (pbpDictPrimaryLang(manual)) {
    const code = pbpDictPrimaryLang(manual);
    if (PBP_DICT_QUERY_LANGS.includes(code) || (installedLanguages && (await installedLanguages).includes(code))) return code;
  }
  const sel = String(cap.text || "");
  const accept = async (code) => {
    if (!pbpDictPrimaryLang(code)) return "";
    if (PBP_DICT_QUERY_LANGS.includes(pbpDictPrimaryLang(code))) return pbpDictAcceptLang(code, sel);
    const supported = installedLanguages ? await installedLanguages : PBP_DICT_QUERY_LANGS;
    return pbpDictAcceptLang(code, sel, supported);
  };
  const explicit = await accept(ctx.selLang || "");
  if (explicit) return explicit;
  const byScript = pbpDictScriptLang(sel, ctx.sentence || "");
  if (byScript) {
    const supported = installedLanguages ? await installedLanguages : PBP_DICT_QUERY_LANGS;
    const ambiguous = supported.some(code => !PBP_DICT_QUERY_LANGS.includes(code) && pbpDictScriptCompatible(code, sel));
    if (!ambiguous) return pbpDictCorrectCjkLang(byScript, articleLang);
  }
  const bySentence = await _pbpDictDetect(ctx.sentence || cap.text);
  const first = await accept(pbpDictRouteLang(bySentence.lang, bySentence.reliable, "", ""));
  if (first) return pbpDictCorrectCjkLang(first, articleLang);
  const byBlock = await _pbpDictDetect(ctx.blockText || "");
  const routed = await accept(
    pbpDictCorrectCjkLang(pbpDictRouteLang(byBlock.lang, byBlock.reliable, articleLang, ""), articleLang));
  if (routed) return routed;
  // Article prior: a reliable full-prose read routes a selection whose local
  // context was too short or too jargon-heavy to decide (a German word
  // selected alone in a German article). Reliable-only: an unreliable
  // article read means the document itself is mixed, no prior to take.
  const byArticle = await _pbpDictArticleCld();
  const prior = await accept(pbpDictRouteLang(byArticle.lang, byArticle.reliable, "", ""));
  if (prior) return pbpDictCorrectCjkLang(prior, articleLang);
  return pbpDictLatinFallback(sel, bySentence.lang, byBlock.lang);
}

// One reusable entry view for reader and library. Ordinary dictionaries remain
// mounted in their stable host while the user switches between sources.
function pbpDictEntryNorm(record, target) {
  const entry = record.entry;
  const entries = [];
  for (const meaning of entry.meanings) {
    let group = entries.find(item => item.pos === meaning.partOfSpeech);
    if (!group) {
      group = { pos: meaning.partOfSpeech,
        ipas: !entries.length && entry.pronunciation ? [{ text: entry.pronunciation, tags: [] }] : [],
        ipaMore: 0, forms: [], senses: [] };
      entries.push(group);
    }
    group.senses.push({ definition: meaning.definition, tags: [], subsenses: [],
      examples: meaning.examples, synonyms: [], antonyms: [] });
  }
  return { word: entry.word, pronunciation: entry.pronunciation, definitionLang: target.lang, sourceLabel: "AI", sourceUrl: "",
    license: "AI-generated · " + record.provider + " / " + record.model, aiGenerated: true,
    entries };
}

function _pbpDictEntryMount(host, opts) {
  if (typeof pbpDictEntryRead !== "function" || typeof pbpDictEntryRun !== "function") return null;
  const panel = document.createElement("div"); panel.className = "xp-dict-ai";
  const controls = document.createElement("div"); controls.className = "row xp-dict-ai-controls";
  const button = (key, name) => {
    const el = document.createElement("button"); el.type = "button";
    el.className = "xp-dict-connect " + name; el.textContent = t(key); return el;
  };
  const action = (el, key, icon) => {
    el.innerHTML = typeof PBP_ICONS === "object" ? PBP_ICONS[icon] || "" : "";
    el.title = t(key); el.setAttribute("aria-label", t(key));
  };
  const generate = button("dictEntryGenerate", "xp-dict-ai-generate");
  action(generate, "dictEntryGenerate", "wandSparkles");
  generate.disabled = true;
  const toggle = button("dictEntryShowDictionary", "xp-dict-ai-switch"); toggle.hidden = true;
  action(toggle, "dictEntryShowDictionary", "bookOpenText");
  const stop = button("askStop", "xp-dict-ai-stop"); stop.hidden = true;
  action(stop, "askStop", "stop");
  const configure = document.createElement("a"); configure.className = "xp-dict-connect xp-dict-ai-configure";
  configure.href = "options.html#ai"; configure.target = "_blank"; configure.rel = "noopener noreferrer";
  action(configure, "aiConfigure", "gear"); configure.hidden = true;
  controls.append(generate, toggle, stop, configure);
  const status = document.createElement("div"); status.className = "xp-dict-msg xp-dict-ai-status";
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.hidden = true;
  const content = document.createElement("div"); content.className = "xp-dict-ai-content"; content.hidden = true;
  if (opts.controlsHost) opts.controlsHost.appendChild(controls);
  else panel.appendChild(controls);
  panel.append(status, content); host.appendChild(panel);
  let settings = null, record = null, busy = false, active = null, epoch = 0, mode = "dictionary", viewRevision = 0;
  let usageCategory = "collocations", usageTopic = "";
  let renderedBase = "", baseDetails = null, baseRetry = null, usageForm = null;
  const supplementNodes = new Map();
  const preference = () => typeof pbpDictDefaultView === "function" ? pbpDictDefaultView(settings) :
    settings?.dictDefaultView || (settings?.dictAiAutoGenerate === true ? "ai-generate" : "ai-saved");
  const alive = () => !opts.signal?.aborted && panel.isConnected && opts.isCurrent();
  const configured = () => settings && settings.previewAiEnabled !== false && typeof hasAIKey === "function" && hasAIKey(settings);
  const target = () => pbpDictDefinitionLanguage(settings?.dictDefinitionLang,
    typeof uiLangToBCP47 === "function" ? uiLangToBCP47() : document.documentElement.lang || "en");
  const message = text => { status.textContent = text; status.hidden = !text; };
  const sync = () => {
    generate.hidden = !!record || !configured() || busy; generate.disabled = busy || !settings;
    toggle.hidden = !record && !busy; stop.hidden = !busy;
    configure.hidden = !!record || !settings || settings.previewAiEnabled === false || configured();
    panel.hidden = !record && !!settings && settings.previewAiEnabled === false;
    controls.hidden = panel.hidden;
    panel.setAttribute("aria-busy", busy ? "true" : "false");
  };
  const show = next => {
    if (!alive()) return;
    mode = next;
    if (opts.dictionaryHost) opts.dictionaryHost.hidden = mode === "ai";
    content.hidden = mode !== "ai";
    action(toggle, mode === "ai" ? "dictEntryShowDictionary" : "dictEntryShowAi", mode === "ai" ? "bookOpenText" : "sparkles");
    opts.onView?.(mode);
  };
  const render = (value, answerLanguage, reveal = true, revealSupplement = "") => {
    record = value;
    const norm = pbpDictEntryNorm(record, answerLanguage);
    // Supplement receipts and additions do not change the paid base entry.
    // Retaining these nodes also retains open disclosures and reading position.
    const baseKey = JSON.stringify([record.entry, record.provider, record.model, record.generatedAt, answerLanguage]);
    if (baseKey !== renderedBase) {
      const wasOpen = baseDetails?.open || false;
      _pbpDictRenderEntry(content, norm, opts.term, opts.lang, opts.term, "");
      if (!record.entry.meanings.length) {
        const empty = document.createElement("p"); empty.className = "xp-dict-msg";
        empty.textContent = t("dictEntryNoEntry"); content.prepend(empty);
      }
      const details = document.createElement("details"); details.className = "xp-dict-ai-details";
      const summary = document.createElement("summary");
      summary.textContent = t(record.entry.etymology || record.entry.relatedWords.length ? "dictEntryDetails" : "dictEntrySource");
      details.appendChild(summary);
      if (record.entry.etymology) {
        const p = document.createElement("p"); p.lang = answerLanguage.lang; p.dir = "auto";
        p.textContent = record.entry.etymology; details.appendChild(p);
      }
      if (record.entry.relatedWords.length) {
        const words = document.createElement("p"); words.className = "xp-dict-rel"; words.lang = opts.lang || "und"; words.dir = "auto";
        const label = document.createElement("span"); label.lang = document.documentElement.lang || "und";
        label.textContent = t("dictEntryRelated") + ": "; words.appendChild(label);
        record.entry.relatedWords.forEach((word, index) => {
          if (index) words.append(" · ");
          if (typeof opts.onLookup !== "function") { words.append(word); return; }
          const link = button("dictLookupSelection", "xp-dict-lemma-link");
          link.className = "xp-dict-lemma-link"; link.textContent = word;
          link.addEventListener("click", () => { if (alive()) opts.onLookup(word); }); words.appendChild(link);
        });
        details.appendChild(words);
      }
      const provenance = document.createElement("p"); provenance.className = "xp-dict-src";
      provenance.textContent = [t("dictAiLabel"), record.provider, record.model,
        new Date(record.generatedAt).toLocaleDateString()].join(" · ");
      details.appendChild(provenance); content.appendChild(details);
      details.open = wasOpen; baseDetails = details; renderedBase = baseKey;
    }
    renderSupplements(answerLanguage, revealSupplement);
    opts.onEntry?.(norm, record, content);
    // Move focus off a disappearing action without scrolling the article.
    const hadFocus = document.activeElement === generate || document.activeElement === stop;
    show(reveal ? "ai" : mode); sync();
    if (hadFocus) toggle.focus({ preventScroll: true });
    message(record.cacheSaved === false ? t("dictEntryNotCached") : "");
  };
  const input = (signal, isCurrent) => ({ term: opts.term, sourceLanguage: opts.lang || "und", target: target(),
    owner: opts.owner, settings, signal, isCurrent });
  const supplementId = addition => addition.id || String(addition.generatedAt);
  const focusAddition = id => {
    const section = supplementNodes.get(id)?.section;
    const heading = section?.querySelector("summary");
    if (!heading) return;
    heading.focus({ preventScroll: true });
    // Reveal only within the lookup's scroll owner. scrollIntoView would also
    // move the article behind a reader bubble or scroll the whole library.
    const scroller = content.closest(".xp-body, .vocab-detail-pane");
    if (!scroller) return;
    const view = scroller.getBoundingClientRect(), title = heading.getBoundingClientRect();
    const inset = parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
    const top = view.top + scroller.clientTop + inset;
    const bottom = view.top + scroller.clientTop + scroller.clientHeight;
    const previewBottom = Math.min(section.getBoundingClientRect().bottom, title.bottom + 32);
    if (title.top < top) scroller.scrollTop += title.top - top;
    else if (previewBottom > bottom) scroller.scrollTop += Math.min(previewBottom - bottom, title.top - top);
  };
  const renderSupplements = (answerLanguage, revealId) => {
    if (typeof pbpDictSupplementRun !== "function") return;
    if (record.archiveSaved === false) {
      if (!baseRetry) {
        baseRetry = button("dictEntryRetrySave", "xp-dict-retry-save");
        let saving = false;
        baseRetry.addEventListener("click", async () => {
          if (!alive() || busy || saving) return;
          saving = true; baseRetry.setAttribute("aria-disabled", "true");
          try {
            const saved = await pbpDictEntrySave(input(opts.signal, alive), record);
            if (alive()) {
              const hadFocus = document.activeElement === baseRetry;
              render(saved, answerLanguage, false);
              if (hadFocus) toggle.focus({ preventScroll: true });
            }
          } catch (error) {
            if (alive()) message(t("dictEntryNotCached"));
            console.warn("[dict-entry] save retry failed:", error?.name);
          } finally { saving = false; baseRetry.removeAttribute("aria-disabled"); }
        });
      }
      if (!baseRetry.isConnected) content.appendChild(baseRetry);
    } else baseRetry?.remove();
    const retained = new Set();
    for (const addition of record.supplements || []) {
      const id = supplementId(addition);
      retained.add(id);
      let item = supplementNodes.get(id);
      if (!item) {
        const section = document.createElement("details"); section.className = "xp-dict-ai-details";
        section.dataset.supplementId = id;
        const heading = document.createElement("summary");
        const text = document.createElement("p"); text.className = "xp-dict-supplement-text"; text.dir = "auto";
        const receipt = document.createElement("p"); receipt.className = "xp-dict-src";
        section.append(heading, text, receipt);
        item = { section, heading, text, receipt, sources: [], sourceKey: "", retry: null, addition };
        supplementNodes.set(id, item);
      }
      item.addition = addition;
      const { section, heading, text, receipt } = item;
      const title = t("dictSupplement" + addition.category[0].toUpperCase() + addition.category.slice(1)) +
        (addition.profile.topic ? " · " + addition.profile.topic : "");
      if (heading.textContent !== title) heading.textContent = title;
      if (text.textContent !== addition.content) text.textContent = addition.content;
      text.lang = answerLanguage.lang;
      const sourceKey = JSON.stringify(addition.sources || []);
      if (sourceKey !== item.sourceKey) {
        item.sources.forEach(node => node.remove()); item.sources = [];
        for (const [index, source] of (addition.sources || []).entries()) {
          const cite = document.createElement("p"); cite.className = "xp-dict-src";
          const link = document.createElement("a"); link.textContent = `[${index + 1}] ${source.title}`;
          link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer";
          cite.append(link);
          const excerpt = document.createElement("p"); excerpt.className = "xp-dict-example";
          excerpt.textContent = source.excerpt; excerpt.lang = opts.lang || "und"; excerpt.dir = "auto";
          section.insertBefore(cite, receipt); section.insertBefore(excerpt, receipt);
          item.sources.push(cite, excerpt);
        }
        item.sourceKey = sourceKey;
      }
      receipt.textContent = [t(addition.archiveSaved === false ? "dictSupplementSaveFailed" : "dictSupplementSaved"),
        addition.provider, addition.model, new Date(addition.generatedAt).toLocaleDateString()].join(" · ");
      if (addition.archiveSaved === false) {
        if (!item.retry) {
          item.retry = button("dictEntryRetrySave", "xp-dict-retry-save");
          let saving = false;
          item.retry.addEventListener("click", async () => {
            if (!alive() || busy || saving) return;
            saving = true; item.retry.setAttribute("aria-disabled", "true");
            try {
              const saved = await pbpDictSupplementSave(input(opts.signal, alive), item.addition);
              if (!alive()) return;
              const hadFocus = document.activeElement === item.retry;
              record.supplements = record.supplements.map(value => supplementId(value) === id ? saved : value);
              render(record, answerLanguage, false, section.open ? supplementId(saved) : "");
              if (hadFocus) supplementNodes.get(supplementId(saved))?.heading.focus({ preventScroll: true });
            } catch (error) { console.warn("[dict-entry] usage save retry failed:", error?.name); }
            finally { saving = false; item.retry.removeAttribute("aria-disabled"); }
          });
        }
        if (!item.retry.isConnected) section.appendChild(item.retry);
      } else item.retry?.remove();
      if (!section.isConnected) content.insertBefore(section, usageForm?.disclosure.isConnected ? usageForm.disclosure : null);
      if (id === revealId) section.open = true;
    }
    for (const [id, item] of supplementNodes) {
      if (!retained.has(id)) { item.section.remove(); supplementNodes.delete(id); }
    }
    if (!configured() || !record.archiveId) { usageForm?.disclosure.remove(); return; }
    if (usageForm) {
      if (!usageForm.disclosure.isConnected) content.appendChild(usageForm.disclosure);
      usageForm.refresh();
      return;
    }
    const disclosure = document.createElement("details"); disclosure.className = "xp-dict-ai-details xp-dict-supplement";
    const summary = document.createElement("summary"); summary.textContent = t("dictEntrySupplement");
    const kind = document.createElement("select");
    kind.className = "xp-dict-supplement-kind";
    kind.setAttribute("aria-label", t("dictSupplementCategory"));
    for (const category of PBP_DICT_SUPPLEMENT_CATEGORIES) kind.append(new Option(
      t("dictSupplement" + category[0].toUpperCase() + category.slice(1)), category));
    kind.value = usageCategory;
    const topicLabel = document.createElement("label"); topicLabel.className = "xp-dict-supplement-label";
    topicLabel.append(t("dictSupplementTopic"));
    const topic = document.createElement("input");
    topic.type = "text"; topic.className = "xp-dict-supplement-topic"; topic.maxLength = 120; topic.dir = "auto";
    topic.placeholder = t("dictSupplementTopicPlaceholder"); topic.setAttribute("aria-label", t("dictSupplementTopic"));
    topic.value = usageTopic; topicLabel.appendChild(topic);
    const hint = document.createElement("p"); hint.className = "xp-dict-src xp-dict-supplement-hint";
    hint.textContent = t("dictSupplementTopicHint");
    const submit = button("dictSupplementGenerate", "xp-dict-supplement-generate");
    const profile = document.createElement("p"); profile.className = "xp-dict-src xp-dict-supplement-profile";
    const learner = pbpDictSupplementProfile(settings);
    const values = [];
    if (learner.nativeLanguage) values.push(t("dictSupplementNativeLanguage", learner.nativeLanguage));
    if (learner.level) values.push(t("dictSupplementLevel", t("dictLearnerLevel" + learner.level[0].toUpperCase() + learner.level.slice(1))));
    if (values.length) {
      values.forEach((text, index) => {
        if (index) profile.append(" · ");
        const value = document.createElement("bdi"); value.textContent = text; profile.appendChild(value);
      });
      profile.append(" ");
    }
    const edit = document.createElement("a"); edit.className = "xp-dict-profile-link";
    edit.href = "options.html#vocab-learning"; edit.target = "_blank"; edit.rel = "noopener noreferrer";
    edit.textContent = t(values.length ? "dictSupplementProfileEdit" : "dictSupplementProfileSet");
    edit.title = t("dictLearnerProfileHint");
    profile.appendChild(edit);
    const sourceHint = document.createElement("p"); sourceHint.className = "xp-dict-src";
    sourceHint.textContent = t("dictSupplementSourceHint");
    disclosure.append(summary, kind, topicLabel, hint, submit, profile, sourceHint); content.append(disclosure);
    if (typeof window.pbpEnhanceListbox === "function") {
      kind.id = "dict-supplement-kind"; kind.dataset.listbox = "float"; window.pbpEnhanceListbox(kind);
    } else kind.classList.add("xp-dict-lang");
    const existing = () => {
      const profile = pbpDictSupplementProfile(settings, topic.value);
      return record.supplements?.find(item => item.category === kind.value &&
        item.profile.nativeLanguage === profile.nativeLanguage && item.profile.level === profile.level && item.profile.topic === profile.topic);
    };
    const refresh = () => {
      usageCategory = kind.value; usageTopic = topic.value;
      submit.textContent = t(existing() ? "dictSupplementShow" : "dictSupplementGenerate");
      sourceHint.hidden = !["culture", "literature"].includes(kind.value);
    };
    usageForm = { disclosure, refresh };
    kind.addEventListener("change", refresh); topic.addEventListener("input", refresh); refresh();
    submit.addEventListener("click", async () => {
      if (!alive() || busy) return;
      const hit = existing();
      if (hit) {
        const hadFocus = document.activeElement === submit;
        const id = supplementId(hit); render(record, answerLanguage, false, id);
        if (hadFocus) focusAddition(id);
        return;
      }
      const hadFocus = document.activeElement === submit;
      const version = ++epoch, controller = new AbortController(); active = controller; busy = true;
      const current = () => alive() && epoch === version && !controller.signal.aborted;
      const category = kind.value, request = { ...input(controller.signal, current), category, topic: topic.value };
      const origin = pbpDictSupplementOrigin(category, opts.lang);
      submit.disabled = true; kind.disabled = true; topic.disabled = true; window.pbpListboxSync?.(kind);
      message(t("dictSupplementGenerating")); sync();
      if (hadFocus) stop.focus({ preventScroll: true });
      try {
        // Request the model and one source origin together, directly from the
        // click. All subsequent fetches independently check that grant.
        if (origin) {
          if (!(await requestAIHostPermissions(settings, [origin + "/*"]))) throw { code: "host_permission" };
        } else await ensureAIHostPermissionWithGesture(settings);
        if (!current()) return;
        const addition = await pbpDictSupplementRun(request);
        if (!current()) return;
        record.supplements = [...(record.supplements || []).filter(item => !addition.id || item.id !== addition.id), addition];
        const id = supplementId(addition), focusStayed = document.activeElement === stop;
        render(record, answerLanguage, false, id);
        if (focusStayed) focusAddition(id);
        message(t(addition.archiveSaved === false ? "dictSupplementSaveFailed" : "dictSupplementSaved"));
      } catch (error) {
        if (!current()) return;
        console.warn("[dict-entry] usage generation failed:", error?.name, error?.code || "request_failed");
        message(t(error?.code === "host_permission" ? "aiGrantRetry" : error?.code === "sync_failed" ? "dictEntrySyncFailed" :
          error?.code === "no_sources" ? "dictSupplementNoSources" :
          error?.code === "unsupported_usage" ? "dictSupplementUnsupported" : "dictSupplementUnavailable"));
      } finally {
        if (epoch === version) { busy = false; active = null; }
        if (alive()) {
          const focusStayed = document.activeElement === stop;
          submit.disabled = false; kind.disabled = false; topic.disabled = false; window.pbpListboxSync?.(kind); sync();
          if (focusStayed && submit.isConnected) submit.focus({ preventScroll: true });
        }
      }
    });
  };
  const run = async manual => {
    if (!alive() || busy || !configured()) return;
    const hadFocus = manual && document.activeElement === generate;
    const version = ++epoch, viewAtStart = viewRevision, controller = new AbortController(); active = controller; busy = true;
    const current = () => alive() && epoch === version && !controller.signal.aborted;
    message(t("dictEntryGenerating"));
    if (!manual) show("ai");
    sync();
    if (hadFocus) stop.focus({ preventScroll: true });
    try {
      // The automatic path never requests permission. Only this direct click
      // can open Chrome's exact-origin permission prompt, before any other await.
      if (manual) await ensureAIHostPermissionWithGesture(settings);
      if (!current()) return;
      if (typeof pbpAiBumpCounter === "function") pbpAiBumpCounter("explain");
      const request = input(controller.signal, current);
      const result = await pbpDictEntryRun(request);
      if (current()) render(result, request.target, viewRevision === viewAtStart);
    } catch (error) {
      if (!current()) return;
      if (!record) show("dictionary");
      console.warn("[dict-entry] generation failed:", error?.name, error?.code || "request_failed");
      message(t(error?.code === "host_permission" ? "aiGrantRetry" :
        error?.code === "owner_changed" || error?.code === "account_changed" ? "vocabAccountChanged" :
        error?.code === "sync_failed" ? "dictEntrySyncFailed" : "dictEntryUnavailable"));
    } finally {
      if (epoch === version) {
        busy = false; active = null;
        if (alive()) {
          const stopFocused = document.activeElement === stop;
          sync();
          if (stopFocused && !generate.hidden) generate.focus({ preventScroll: true });
        }
      }
    }
  };
  generate.addEventListener("click", () => run(true));
  toggle.addEventListener("click", () => { viewRevision++; show(mode === "ai" ? "dictionary" : "ai"); });
  stop.addEventListener("click", () => {
    epoch++; active?.abort(); active = null; busy = false; message(""); sync();
    if (!record) show("dictionary");
    if (!generate.hidden) generate.focus({ preventScroll: true });
    else if (!toggle.hidden) toggle.focus({ preventScroll: true });
  });
  opts.signal?.addEventListener("abort", () => {
    epoch++; active?.abort();
    if (!record) { if (opts.dictionaryHost) opts.dictionaryHost.hidden = false; content.hidden = true; }
    if (opts.controlsHost) controls.remove();
  }, { once: true });
  const ready = Promise.resolve(opts.settings).then(async value => {
    if (!alive()) return;
    settings = value || {}; sync();
    const version = epoch;
    const request = input(opts.signal, () => alive() && epoch === version);
    let hit = await pbpDictEntryRead(request);
    if (!hit && alive() && epoch === version && typeof pbpDictArchiveRead === "function") {
      message(t("dictEntrySyncing"));
      hit = await pbpDictEntryRestore(request);
      if (alive() && epoch === version) message("");
    }
    if (!alive() || epoch !== version) return;
    if (hit) render(hit, request.target, !viewRevision && preference() !== "dictionary");
    else if (preference() === "ai-generate") await run(false);
  }).catch(error => {
    if (!alive() || error?.name === "AbortError" || error?.code === "stale") return;
    console.warn("[dict-entry] initialization failed:", error?.name, error?.code || "settings_failed");
    if (["owner_changed", "account_changed"].includes(error?.code)) message(t("vocabAccountChanged"));
    else if (error?.code === "sync_failed") message(t("dictEntrySyncFailed"));
    else message(t("dictEntryUnavailable"));
    sync();
  });
  if (globalThis.chrome?.runtime?.onMessage) {
    const refreshed = async message => {
      if (message?.type !== "PBP_DICT_ARCHIVE_SYNCED" || message.owner !== opts.owner || !alive() || !settings || busy || record?.archiveSaved === false ||
          content.contains(document.activeElement)) return;
      const version = epoch;
      try {
        const next = await pbpDictEntryRead(input(opts.signal, () => alive() && epoch === version));
        if (!next || !alive() || busy || epoch !== version || content.contains(document.activeElement)) return;
        if (JSON.stringify(next) === JSON.stringify(record)) return;
        next.supplements = [...(next.supplements || []), ...(record?.supplements || []).filter(item => item.archiveSaved === false)];
        render(next, target(), false);
      } catch (error) { console.warn("[dict-entry] synced entry refresh failed:", error?.name); }
    };
    const onMessage = message => { refreshed(message).catch(error => console.warn("[dict-entry] refresh failed:", error?.name)); };
    chrome.runtime.onMessage.addListener(onMessage);
    opts.signal?.addEventListener("abort", () => chrome.runtime.onMessage.removeListener(onMessage), { once: true });
  }
  // Settings changed in another extension tab must invalidate the old action
  // before it can dispatch with a stale enabled flag or language pair.
  if (opts.onSettingsChange && typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    let settingsSequence = 0, lastRelevant = 0;
    const listener = async (changes, area) => {
      const keys = Object.keys(changes);
      if (!alive() || !["sync", "local"].includes(area) || !keys.some(key =>
        ["dictDefaultView", "dictAiAutoGenerate", "dictLearnerNativeLanguage", "dictLearnerLevel", "dictDefinitionLang", "previewAiEnabled", "aiProvider", "previewAiModelByProvider", "optSyncEnabled", "syncApiKeys"].includes(key) ||
        /(?:Model|ApiKey|BaseUrl)$/.test(key))) return;
      const sequence = ++settingsSequence;
      if (!changes.optSyncEnabled && typeof pbpReadSecretSyncState === "function") {
        const flags = await pbpReadSecretSyncState({ persistInferredState: false });
        const mainArea = flags.optSyncEnabled ? "sync" : "local";
        const secretArea = typeof pbpSecretRoutingActive === "function" && pbpSecretRoutingActive(flags.optSyncEnabled, flags.syncApiKeys) ? "local" : mainArea;
        if (!keys.some(key => area === (typeof API_KEY_FIELDS !== "undefined" && API_KEY_FIELDS.includes(key) ? secretArea : mainArea))) return;
      } else if (!changes.optSyncEnabled && typeof pbpSettingsAreaName === "function" && area !== await pbpSettingsAreaName()) return;
      if (!alive() || sequence < lastRelevant) return;
      lastRelevant = sequence;
      const revision = ++epoch; active?.abort(); active = null; busy = false; generate.disabled = true;
      try {
        const next = await pbpReadSettingsWithSecrets(SETTINGS_DEFAULTS);
        if (alive() && epoch === revision) opts.onSettingsChange(next);
      } catch (error) {
        console.warn("[dict-entry] settings refresh failed:", error?.name);
        if (alive() && epoch === revision) { settings = null; message(t("dictEntryUnavailable")); sync(); }
      }
    };
    const changed = (changes, area) => listener(changes, area).catch(error =>
      console.warn("[dict-entry] settings routing read failed:", error?.name));
    chrome.storage.onChanged.addListener(changed);
    opts.signal?.addEventListener("abort", () => chrome.storage.onChanged.removeListener(changed), { once: true });
  }
  return { element: panel, controls, ready, show };
}

const PBP_DICT_LANGS = ["auto", ...PBP_DICT_QUERY_LANGS];

async function pbpDictRun(cap, ctx, pop, ctrl, s, navigation = null) {
  // Child controller: this run's own signal, chained to md-ask's parent ctrl.
  // A language switch / rerun aborts ONLY the old child (Codex HIGH 1).
  if (_pbpDictChildCtrl) _pbpDictChildCtrl.abort();
  if (_pbpDictParentCleanup) { _pbpDictParentCleanup(); _pbpDictParentCleanup = null; }
  const child = new AbortController();
  _pbpDictChildCtrl = child;
  const onParentAbort = () => child.abort();
  if (ctrl.signal.aborted) child.abort();
  else {
    ctrl.signal.addEventListener("abort", onParentAbort, { once: true });
    _pbpDictParentCleanup = () => { try { ctrl.signal.removeEventListener("abort", onParentAbort); } catch (_) {} };
  }
  const signal = child.signal;

  const runId = ++_pbpDictRunSeq;
  const origin = navigation && navigation.owner === _pbpDictOwner ? navigation :
    { cap, owner: _pbpDictOwner };
  const derived = cap.text !== origin.cap.text;
  const title = pop.querySelector(".xp-term");
  if (title) { title.textContent = cap.text; title.title = cap.text; }
  const cur = {
    runId, term: cap.text, queryTerm: cap.text, lang: "", gloss: "", lemma: "", ipa: "",
    sourceUrl: "", license: "", sentence: ctx.sentence || "", saved: false, entryView: "dictionary",
    owner: _pbpDictOwner,
    rerun: () => { if (cur.isCurrent() && !signal.aborted) pbpDictRun(cap, ctx, pop, ctrl, s, origin); },
    // Lemma click-through (form-of pointers): a fresh full run on the base
    // form, so language detection, vocab identity and the AI entry all see
    // the lemma as the selection. Same guard as rerun.
    rerunWith: (term) => {
      const next = pbpDictNormalizeTerm(term);
      if (next && cur.isCurrent() && !signal.aborted) pbpDictRun({ ...cap, text: next }, ctx, pop, ctrl, s, origin);
    }
  };
  _pbpDictCurrent = cur;
  cur.isCurrent = () => _pbpDictCurrent === cur && _pbpDictOwner === cur.owner;

  // Vocab button is reset before language detection so a stale lookup cannot save
  // (Codex HIGH 3). dataset.runId guards stale promise writes. Set the
  // moment this run becomes current -- BEFORE the first await
  // (_pbpDictResolveLang) below, not after -- otherwise the OLD run's button
  // (still showing "saved"/enabled) stays clickable through the async
  // language-detection gap and can save an und/empty record for a
  // selection this run has already superseded.
  const vocabBtn = pop.querySelector(".xp-vocab");
  // The Learning | Known control resets with the run, not just with the
  // action switch: a language-dropdown rerun that no longer hits a saved word
  // must not leave last run's control (wired to the OLD record id) in the foot.
  const statusReset = pop.querySelector(".xp-vocab-status");
  if (statusReset) { statusReset.hidden = true; statusReset.onclick = null; }
  if (vocabBtn) {
    vocabBtn.hidden = false;
    vocabBtn.disabled = true;
    vocabBtn.dataset.runId = String(runId);
    delete vocabBtn.dataset.face; // quiet "Update" face is per saved-word hit
    // Icon + tooltip, not text: assigning textContent here would strip the SVG
    // and leave a blank button. Guarded because md-dict.js can be injected
    // before md-ask.js has run in some entry points.
    if (typeof _pbpExplainIconBtn === "function") {
      _pbpExplainIconBtn(vocabBtn, PBP_EXPLAIN_VOCAB_ADD_SVG, t("dictSaveVocab"));
    } else {
      vocabBtn.textContent = t("dictSaveVocab");
    }
  }

  const body = pop.querySelector(".xp-body");
  const wrap = document.createElement("div");
  wrap.className = "xp-dict";
  const head = document.createElement("div");
  head.className = "panel-head xp-dict-head";
  const queryTools = document.createElement("div"); queryTools.className = "xp-dict-query-tools";
  const sel = document.createElement("select");
  sel.className = "xp-dict-lang";
  sel.setAttribute("aria-label", t("dictLangAria"));
  const languageLocale = typeof uiLangToBCP47 === "function" ? uiLangToBCP47() : document.documentElement.lang;
  for (const code of PBP_DICT_LANGS) {
    const o = document.createElement("option");
    o.value = code === "auto" ? "" : code;
    o.textContent = code === "auto" ? t("dictLangAuto") : (pbpDictLanguageLabel(code, languageLocale) || code);
    sel.appendChild(o);
  }
  const speak = document.createElement("button");
  speak.type = "button";
  speak.className = "xp-dict-speak";
  speak.setAttribute("aria-label", t("dictSpeak"));
  speak.title = t("dictSpeak");
  speak.innerHTML = PBP_DICT_SPEAKER_SVG; // static constant, never model text
  queryTools.append(sel, speak); head.appendChild(queryTools);
  const slot = document.createElement("div");
  slot.className = "xp-dict-slot";
  // Two stable children. Every online path -- skeleton, permission prompt,
  // result, no-entry, load failure -- calls replaceChildren on the SAME element,
  // so a Chinese block written straight into `slot` would be wiped by whichever
  // of them ran next. Nothing may ever replaceChildren on `slot` itself.
  const localEl = document.createElement("div");
  localEl.className = "xp-dict-local";
  const onlineEl = document.createElement("div");
  onlineEl.className = "xp-dict-online";
  slot.appendChild(localEl);
  slot.appendChild(onlineEl);
  wrap.appendChild(head);
  if (derived) {
    const source = document.createElement("div"); source.className = "xp-dict-origin";
    const label = document.createElement("span");
    // A marker keeps the source term in the translated sentence's own order,
    // with an independent language/direction span and no model-authored HTML.
    const marker = "\uFFF0", template = t("dictQueryFrom", marker), at = template.indexOf(marker);
    const original = document.createElement("span"); original.className = "xp-dict-origin-term";
    original.textContent = origin.cap.text; original.lang = "und"; original.dir = "auto";
    label.append(at < 0 ? template + " " : template.slice(0, at), original, at < 0 ? "" : template.slice(at + marker.length));
    const back = document.createElement("button"); back.type = "button"; back.className = "xp-dict-connect xp-dict-return";
    back.textContent = t("dictQueryBack");
    back.addEventListener("click", () => {
      if (cur.isCurrent() && !signal.aborted) pbpDictRun(origin.cap, ctx, pop, ctrl, s, origin);
    });
    source.append(label, back); wrap.appendChild(source);
  }
  wrap.appendChild(slot);
  body.replaceChildren(wrap);
  _pbpDictSlotSkeleton(onlineEl);

  const manual = _pbpDictManualLang;
  const installedLanguages = _pbpDictRefreshPackLangs(sel, languageLocale, true,
    () => !signal.aborted && _pbpDictCurrent === cur);
  const lang = await _pbpDictResolveLang(cap, ctx, manual, installedLanguages);
  if (signal.aborted || _pbpDictCurrent !== cur) return;
  cur.lang = lang;
  const effectiveLang = lang || "und"; // vocab identity: query and save agree (Codex HIGH 6)
  // Legible override state: auto-detection keeps "Auto" selected and
  // annotates it with the detected code ("Auto (zh)"); a bare code shows
  // ONLY when the user picked it this document. The old display put the
  // detected language in the box as a bare code, indistinguishable from a
  // stuck manual override.
  if (manual && [...sel.options].some(option => option.value === manual)) {
    sel.value = manual;
  } else {
    sel.value = "";
    const detectedLabel = pbpDictLanguageLabel(lang, languageLocale);
    sel.options[0].textContent = t("dictLangAuto") + (detectedLabel ? " (" + detectedLabel + ")" : "");
  }
  _pbpDictSyncSelectFace(sel);
  sel.addEventListener("change", () => {
    _pbpDictManualLang = sel.value; // per-document only; never persisted
    cur.rerun(); // abort old requests NOW
  });
  speak.addEventListener("click", () => {
    const visible = cur.entryView === "ai" ? cur.aiNorm : cur.dictionaryNorm;
    pbpDictSpeak(visible?.word || cap.text, lang);
  });
  cur.refreshLanguages = () => _pbpDictRefreshPackLangs(sel, languageLocale, true,
    () => !signal.aborted && _pbpDictCurrent === cur).then(codes => {
      if (!signal.aborted && _pbpDictCurrent === cur && _pbpDictManualLang && !codes.includes(_pbpDictManualLang)) _pbpDictManualLang = "";
    });
  cur.meaningSources = new Map();
  const aiHost = document.createElement("div"); slot.before(aiHost);
  const originalTerm = wrap.querySelector(".xp-dict-origin-term"); if (originalTerm) originalTerm.lang = lang || "und";
  cur.ai = _pbpDictEntryMount(aiHost, { term: cap.text, lang, owner: cur.owner,
    signal, isCurrent: cur.isCurrent, settings: s, dictionaryHost: slot, controlsHost: head,
    onSettingsChange: next => { if (cur.isCurrent()) pbpDictRun(cap, ctx, pop, ctrl, next, origin); },
    onLookup: term => cur.rerunWith(term),
    onEntry: (norm, record, content) => {
      cur.aiNorm = norm;
      _pbpDictReaderPackChoices(norm, content, cur, pop, signal);
    },
    onView: mode => {
      cur.entryView = mode;
      _pbpDictApplyVisibleChoice(cur);
      _pbpDictSyncMeaningSelect(cur);
      _pbpDictRefreshSave(pop, cur, signal).catch(error => console.warn("[dict] saved state read failed:", error?.name));
    } });

  // Local dictionaries load independently of the online request and AI entry.
  const ecdictEl = document.createElement("div"), packsEl = document.createElement("div");
  ecdictEl.className = "xp-dict-legacy"; packsEl.className = "xp-dict-packs";
  localEl.append(packsEl, ecdictEl);
  _pbpDictEcdictSide(ecdictEl, cap.text, lang, signal, cur,
    norm => _pbpDictReaderPackChoices(norm, ecdictEl, cur, pop, signal));
  _pbpDictCedictSide(ecdictEl, cap.text, lang, signal, cur, norm => {
    cur.localNorm = norm;
    if (!cur.dictionaryNorm) cur.dictionaryNorm = norm;
    _pbpDictReaderPackChoices(norm, ecdictEl, cur, pop, signal);
    _pbpDictApplyVisibleChoice(cur); _pbpDictSyncMeaningSelect(cur);
    _pbpDictRefreshSave(pop, cur, signal).catch(error => console.warn("[dict] saved state read failed:", error?.name));
  });
  const showPacks = () => _pbpDictPackSide(packsEl, cap.text, lang, signal, cur,
    (norm, box) => _pbpDictReaderPackChoices(norm, box, cur, pop, signal), s.dictDefinitionLang);
  cur.refreshPacks = () => {
    if (signal.aborted || _pbpDictCurrent !== cur) return;
    cur.packRevision = (cur.packRevision || 0) + 1;
    cur.packSelects = (cur.packSelects || []).filter(select => !select.dataset.packId);
    for (const [key, source] of cur.meaningSources) if (source.norm.packId) cur.meaningSources.delete(key);
    _pbpDictSyncMeaningSelect(cur);
    if (cur.packChoice?.packId) {
      cur.packChoice = null;
      // A revoked source must not silently change the selected headword or
      // leave its old definition collectible while the refreshed packs load.
      cur.packInvalidated = true;
      cur.gloss = ""; cur.ipa = ""; cur.sourceUrl = ""; cur.license = "";
      if (vocabBtn) { vocabBtn.hidden = false; vocabBtn.disabled = true; }
      const status = pop.querySelector(".xp-vocab-status");
      if (status) { status.hidden = true; status.onclick = null; }
    }
    packsEl.replaceChildren(); showPacks();
  };
  cur.refreshLegacy = cur.rerun;
  showPacks();

  const norm = await _pbpDictSlotRun(onlineEl, cap.text, lang, signal, Promise.resolve(""), cur.rerun, ctx.sentence);
  if (signal.aborted || _pbpDictCurrent !== cur) return;
  cur.dictionaryNorm = norm || cur.localNorm;
  if (norm) _pbpDictReaderPackChoices(norm, onlineEl, cur, pop, signal);
  if (cur.packInvalidated && !cur.packChoice) return;
  _pbpDictApplyVisibleChoice(cur);
  _pbpDictSyncMeaningSelect(cur);
  await _pbpDictRefreshSave(pop, cur, signal);
}

function _pbpDictApplyVisibleChoice(cur) {
  cur.fullEntryOnly = false;
  if (cur.packChoice) { _pbpDictApplyPackChoice(cur, cur.packChoice); return; }
  if (cur.packInvalidated) return;
  const sources = [...(cur.meaningSources?.values() || [])].filter(source => !source.norm.aiGenerated && source.choices.length);
  sources.sort((a, b) => a.box?.isConnected && b.box?.isConnected && a.box !== b.box
    ? (a.box.compareDocumentPosition(b.box) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1) : 0);
  const norm = cur.entryView === "ai" ? cur.aiNorm : sources[0]?.norm || cur.dictionaryNorm;
  const choice = norm && pbpDictNormChoices({ ...norm,
    entries: pbpDictOrderForContext(norm.entries, cur.entryView === "ai" ? "" : cur.sentence) }, cur.lang, t("dictSource"))[0];
  if (choice) _pbpDictApplyPackChoice(cur, choice);
  else {
    cur.fullEntryOnly = cur.entryView !== "ai" && [...(cur.meaningSources?.values() || [])].some(source => source.norm.hasFullEntry);
    Object.assign(cur, { term: cur.queryTerm || cur.term, gloss: "", ipa: "", sourceUrl: "", license: "", lemma: "" });
  }
}

function _pbpDictSyncMeaningSelect(cur) {
  const select = cur.meaningSelect;
  if (!select) return;
  const rows = [...cur.meaningSources.values()].flatMap(source => source.choices);
  cur.meaningChoices = rows;
  // base-select's anonymous selected-value box can wrap outside a fixed-height
  // control. An explicit selectedcontent gives the closed face its own clipping
  // boundary while the top-layer options retain their complete text.
  select.replaceChildren(new Option(t("vocabSaveDefinitionLabel"), ""));
  rows.forEach((choice, index) => {
    const option = new Option(choice.term + " · " + choice.gloss + " (" + choice.sourceLabel + ")", String(index));
    const label = option.textContent;
    const body = document.createElement("span"); body.className = "xp-dict-choice-text"; body.textContent = choice.term + " · " + choice.gloss;
    const source = document.createElement("span"); source.className = "xp-dict-choice-source"; source.textContent = " (" + choice.sourceLabel + ")";
    option.replaceChildren(body, source);
    option.title = label; option.setAttribute("aria-label", label);
    option.lang = choice.definitionLang; select.appendChild(option);
  });
  const selected = rows.findIndex(choice => choice.term === cur.term && choice.gloss === cur.gloss &&
    choice.sourceUrl === cur.sourceUrl && choice.license === cur.license);
  select.value = selected >= 0 ? String(selected) : "";
  const help = document.createElement("div"); help.className = "xp-dict-choice-help"; help.id = "xp-dict-choice-help";
  help.textContent = t(selected < 0 ? "dictMeaningChooseHelp" : cur.packChoice ? "dictMeaningManualHelp" : "dictMeaningDefaultHelp");
  select.prepend(help); select.setAttribute("aria-describedby", help.id);
  _pbpDictSyncSelectFace(select);
  cur.meaningHelpObserver?.disconnect();
  if (typeof ResizeObserver === "function") {
    cur.meaningHelpObserver = new ResizeObserver(() => {
      const height = Math.ceil(help.getBoundingClientRect().height);
      if (height > 0) select.style.setProperty("--xp-dict-help-height", height + "px");
    });
    cur.meaningHelpObserver.observe(help);
  }
  select.hidden = !rows.length || (rows.length === 1 && selected === 0 && !cur.packChoice);
  select.title = selected >= 0 ? rows[selected].gloss + " (" + rows[selected].sourceLabel + ")" : t("vocabSaveDefinitionLabel");
}

function _pbpDictApplyPackChoice(cur, choice) {
  Object.assign(cur, { fullEntryOnly: false, term: choice.term, lang: choice.language, gloss: choice.gloss,
    ipa: choice.ipa, sourceUrl: choice.sourceUrl, license: choice.license, lemma: "" });
}

function _pbpDictReaderPackChoices(norm, box, cur, pop, signal) {
  const choices = pbpDictNormChoices(norm, cur.lang, t("dictSource"));
  const key = (norm.packId || norm.sourceLabel) + ":" + norm.word;
  cur.meaningSources?.set(key, { norm, choices, box });
  if (!choices.length) {
    _pbpDictApplyVisibleChoice(cur); _pbpDictSyncMeaningSelect(cur);
    _pbpDictRefreshSave(pop, cur, signal).catch(error => console.warn("[dict] saved state read failed:", error?.name));
    return;
  }
  if (!cur.meaningSelect) {
    const select = document.createElement("select");
    select.className = "xp-dict-lang xp-dict-save-meaning";
    select.setAttribute("aria-label", t("vocabSaveDefinitionLabel"));
    cur.meaningSelect = select;
    (pop.querySelector(".xp-foot") || box).prepend(select);
    signal.addEventListener("abort", () => { cur.meaningHelpObserver?.disconnect(); select.remove(); }, { once: true });
    select.addEventListener("change", () => {
      const choice = cur.meaningChoices[Number(select.value)];
      if (signal.aborted || _pbpDictCurrent !== cur) return;
      if (select.value === "") {
        cur.packChoice = null; cur.packInvalidated = true;
        Object.assign(cur, { gloss: "", ipa: "", sourceUrl: "", license: "", lemma: "" });
      } else {
        if (!choice) return;
        cur.packChoice = choice; cur.packInvalidated = false;
        _pbpDictApplyPackChoice(cur, choice);
      }
      cur.packRevision = (cur.packRevision || 0) + 1;
      _pbpDictSyncMeaningSelect(cur);
      _pbpDictRefreshSave(pop, cur, signal).catch(error => console.warn("[dict] saved state read failed:", error?.name));
    });
  }
  _pbpDictApplyVisibleChoice(cur);
  _pbpDictSyncMeaningSelect(cur);
  _pbpDictRefreshSave(pop, cur, signal).catch(error => console.warn("[dict] saved state read failed:", error?.name));
}

async function _pbpDictRefreshSave(pop, cur, signal) {
  const vocabBtn = pop.querySelector(".xp-vocab"), runId = cur.runId, choice = cur.packChoice;
  if (signal.aborted || _pbpDictCurrent !== cur) return;
  cur.saved = false; cur.savedRecord = null;
  if (vocabBtn) {
    vocabBtn.hidden = false; vocabBtn.disabled = !!cur.fullEntryOnly || !!cur.packInvalidated;
    delete vocabBtn.dataset.face;
    if (typeof _pbpExplainIconBtn === "function") {
      _pbpExplainIconBtn(vocabBtn, PBP_EXPLAIN_VOCAB_ADD_SVG, t("dictSaveVocab"));
    } else vocabBtn.textContent = t("dictSaveVocab");
  }
  const status = pop.querySelector(".xp-vocab-status");
  if (status) { status.hidden = true; status.onclick = null; }
  if (vocabBtn && vocabBtn.dataset.runId === String(runId)) {
    // Owner gate on the READ side as well: `hit` comes out of cur.owner's
    // partition and everything derived from it -- the "already saved" face,
    // the Learning | Known control and the record id it carries -- answers "what is in
    // THAT account's vocabulary". After a switch this popover must not answer
    // that question for the account that is no longer signed in, so skip the
    // lookup and keep the neutral save face. The save button still enables:
    // its own commit gates refuse and flash, which reads better than a
    // permanently dead button. Snapshot comparison only (no extra live read)
    // -- this is display state on a per-lookup path, and the commit gates
    // below are the ones that must be fail-closed against a token swap this
    // page has not seen yet.
    if (cur.owner !== _pbpDictOwner) { vocabBtn.disabled = false; return; }
    const hit = await pbpVocabGet(pbpDictVocabKey(cur.owner, cur.lang || "und", cur.term));
    if (signal.aborted || _pbpDictCurrent !== cur || cur.packChoice !== choice || vocabBtn.dataset.runId !== String(runId)) return;
    if (cur.owner !== _pbpDictOwner) { vocabBtn.disabled = false; return; } // switch landed during the read
    if (hit) {
      cur.saved = true;
      // Saved-word face (critique 2026-10-21): the Learning | Known control
      // carries the state, so the save button is only needed when THIS lookup
      // has something the saved record lacks -- then it stays as a quiet
      // "Update" (re-saving merges the sentence as a new context and replaces
      // the gloss with this lookup's; see pbpVocabSaveWord). Icon-free: the
      // refresh glyph beside a two-state control read as "reset". Title and
      // aria-label keep "Update saved word". Without the control (an entry
      // point that did not build it) the old labeled Update face stays.
      const shown = _pbpDictShowSaved(pop, cur, hit);
      if (shown && !_pbpDictLookupAddsTo(hit, cur)) {
        vocabBtn.hidden = true;
      } else if (typeof _pbpExplainIconBtn === "function") {
        _pbpExplainIconBtn(vocabBtn, shown ? "" : PBP_ICONS.refresh, t("dictUpdateVocab"), shown ? t("update") : "");
        if (shown) vocabBtn.dataset.face = "update";
      } else {
        vocabBtn.textContent = t("dictUpdateVocab");
      }
    }
    vocabBtn.disabled = !!cur.fullEntryOnly || !!cur.packInvalidated;
  }
}

// Would re-saving this lookup change the saved record? Mirrors what
// pbpVocabSaveWord merges: a non-empty gloss replaces the stored one, lemma
// and IPA fill only when missing, and the sentence joins contexts[] unless it
// is already there. Context identity is articleUrl+quote in the store; the
// quote alone is compared here (the article URL can be a video deep link
// computed only at save time), so the same sentence met on another page does
// not re-offer Update -- the one case this under-reports, and a harmless one.
function _pbpDictLookupAddsTo(hit, cur) {
  if (cur.gloss && cur.gloss !== String(hit.gloss || "")) return true;
  if (cur.lemma && !hit.lemma) return true;
  if (cur.ipa && !hit.ipa) return true;
  if (!cur.sentence) return false;
  const contexts = Array.isArray(hit.contexts) ? hit.contexts : [];
  return !contexts.some((c) => c && c.quote === cur.sentence);
}

// Paint and arm the Learning | Known control for `record` (a vocab row read
// or just written under cur.owner). Returns false when it cannot be shown --
// no control in this popover, or no status write path loaded. onclick is a
// PROPERTY assignment on purpose: the control outlives runs, and
// addEventListener here would stack one handler per lookup.
function _pbpDictShowSaved(pop, cur, record) {
  const statusEl = pop.querySelector(".xp-vocab-status");
  if (!statusEl || !record || !record.id || typeof pbpVocabBatchSetStatus !== "function") return false;
  const segs = [...statusEl.querySelectorAll(".toggle-btn[data-status]")];
  if (segs.length !== 2) return false;
  let status = String(record.status || "new") === "known" ? "known" : "new";
  const paint = () => segs.forEach((b) => {
    const on = b.dataset.status === status;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  paint();
  statusEl.hidden = false;
  // Saved word: the jump to the vocabulary page has something to show.
  const openVocabBtn = pop.querySelector(".xp-open-vocab");
  if (openVocabBtn) openVocabBtn.hidden = false;
  // Refusal feedback, shared by the owner gates and by a failed write:
  // nothing was persisted either way, so the pressed segment stays where it
  // was and the control pulses instead of silently reading as "done". A run
  // that has been superseded owns the control now -- leave it alone.
  const refuse = () => {
    if (_pbpDictCurrent !== cur) return;
    statusEl.classList.remove("xp-flash-fail");
    void statusEl.offsetWidth; // restart the pulse on a repeat refusal
    statusEl.classList.add("xp-flash-fail");
  };
  // A busy flag, not `disabled`: disabling the segment the reader just
  // pressed would drop keyboard focus out of the popover mid-write.
  let busy = false;
  statusEl.onclick = async (e) => {
    const seg = e.target && e.target.closest ? e.target.closest(".toggle-btn[data-status]") : null;
    if (!seg || !statusEl.contains(seg) || busy) return;
    const next = seg.dataset.status === "known" ? "known" : "new";
    if (next === status) return; // the pressed segment is the current state: nothing to write
    busy = true;
    try {
      // This handler is closed over `record.id`, a record resolved under
      // cur.owner, so it needs the SAME two commit gates pbpDictSaveCurrent
      // applies -- re-scoping _pbpDictOwner on pbp:account-changed cannot
      // reach into this closure. Without them a Pinboard account switch left
      // the popover on screen fully live: the click would flip a status
      // inside the PREVIOUS account's partition and queue that change into
      // that account's Drive outbox. Snapshot check first (a switch this
      // page already saw), then the live account before the write (a token
      // swap made in another tab or in Options, which _pbpDictOwner has not
      // caught up with yet -- both sides of the snapshot comparison come
      // from the same previewAccount). Fail-closed: a read that throws
      // counts as a mismatch.
      if (cur.owner !== _pbpDictOwner) { refuse(); return; }
      if (typeof pbpVocabCurrentOwner === "function") {
        const live = await pbpVocabCurrentOwner().catch(() => null);
        if (live !== cur.owner) { refuse(); return; }
      }
      const ok = await pbpVocabBatchSetStatus([record.id], cur.owner, next).catch(() => false);
      if (_pbpDictCurrent !== cur) return; // superseded: leave the new run's control alone
      if (!ok) { refuse(); return; }
      status = next;
      paint();
      try {
        document.dispatchEvent(new CustomEvent("pbp:vocab-changed", { detail: { owner: cur.owner } }));
      } catch (_) {}
    } finally {
      busy = false;
    }
  };
  return true;
}

// md-ask.js's save handler, after a successful save or update: switch the
// footer to the saved-word face for the record just written. False when this
// run never captured one (superseded, or the write came from elsewhere).
window.pbpDictShowSavedFace = (pop) => {
  const cur = _pbpDictCurrent;
  if (!cur || !cur.savedRecord || !pop) return false;
  return _pbpDictShowSaved(pop, cur, cur.savedRecord);
};
window.pbpDictRun = pbpDictRun;

async function pbpDictSaveCurrent() {
  const cur = _pbpDictCurrent;
  const packRevision = cur?.packRevision || 0;
  if (!cur || !cur.term || cur.fullEntryOnly) return false;
  if (cur.owner !== _pbpDictOwner) return false; // owner re-check at commit time (invariant)
  const urlEl = document.getElementById("preview-url");
  const titleEl = document.getElementById("preview-title");
  let highlightId = null;
  const target = _pbpDictSaveTarget;
  if (target && target.itemId) highlightId = target.itemId;                 // card path keeps its id
  else if (target && target.range && typeof window.pbpHlItemIdAtRange === "function") {
    try { highlightId = window.pbpHlItemIdAtRange(target.range) || null; } catch (_) {}
  }
  let articleUrl = pbpDictSafeUrl(urlEl ? urlEl.href : "");
  // (research T1.3) A word learned from a transcript keeps the SECOND it was
  // heard at: articleUrl becomes the watch-page deep link (?t=). The context
  // schema is untouched -- articleUrl was always a free URL, pbpDictSafeUrl
  // still vets it, Drive/Anki/Eudic shapes stay identical. Dedup is
  // articleUrl+quote, so the same word at another moment keeps its own
  // context, which is the behaviour wanted. Node -> second comes from the
  // gutter paragraph (data-t) or timeline row (data-from) the selection
  // sits in; no time known = plain page URL, never a guess.
  if (document.body.classList.contains("video-mode")
      && typeof window.pbpVideoTimeForNode === "function" && typeof window.pbpVideoDeepLinkAt === "function") {
    try {
      let node = (target && target.range) ? target.range.startContainer : null;
      if (!node && typeof window.getSelection === "function") {
        const sel = window.getSelection();
        node = sel ? sel.anchorNode : null;
      }
      const sec = node ? window.pbpVideoTimeForNode(node) : null;
      if (sec != null) {
        const dl = pbpDictSafeUrl(window.pbpVideoDeepLinkAt(sec));
        if (dl) articleUrl = dl;
      }
    } catch (_) {}
  }
  // Commit-time owner check against the LIVE account, not the snapshot the
  // page render froze into _pbpDictOwner: both sides of that comparison come
  // from the same previewAccount, so a token swap in another tab (or in
  // Options) left this reader happily writing the PREVIOUS account's
  // partition -- invisible in the library, and uploaded to that account's
  // Drive by its outbox. Same fail-closed semantics options-vocab.js applies
  // before it builds an export (its vocabAccountChanged branch): refuse the
  // write and let the caller report the failure.
  if (typeof pbpVocabCurrentOwner === "function") {
    const live = await pbpVocabCurrentOwner().catch(() => null);
    if (live !== cur.owner) return false;
  }
  if (cur.fullEntryOnly || cur.packInvalidated || (cur.packRevision || 0) !== packRevision) return false;
  const entry = await pbpVocabSaveWord(cur.owner, {
    term: cur.term, lemma: cur.lemma, language: cur.lang || "und",
    gloss: cur.gloss, ipa: cur.ipa, sourceUrl: cur.sourceUrl, license: cur.license,
    context: {
      quote: cur.sentence, articleUrl,
      articleTitle: titleEl ? titleEl.textContent : "", highlightId, createdAt: Date.now()
    }
  });
  if (entry) {
    // The IDB write already happened -- report success unconditionally, even
    // if a newer dict run has since superseded `cur`. Only mutate the run's
    // own state when it is still the live one. The vocabulary list itself
    // lives in the options tab now (options-vocab.js); it rescans on its own
    // next activation, same as every other options panel.
    if (_pbpDictCurrent === cur) { cur.saved = true; cur.savedRecord = entry; }
    try {
      document.dispatchEvent(new CustomEvent("pbp:vocab-changed", { detail: { owner: cur.owner } }));
    } catch (_) {}
    return true;
  }
  return false;
}
window.pbpDictSaveCurrent = pbpDictSaveCurrent;
window.pbpDictSetSaveTarget = (tgt) => { _pbpDictSaveTarget = tgt || null; };
window.pbpDictOnActionSwitch = () => {
  _pbpDictSaveTarget = null;
  if (_pbpDictChildCtrl) _pbpDictChildCtrl.abort(); // invalidate the run, not just the range
  _pbpDictCurrent = null;
};

// Owner arrives with the page render (dict-run/save read _pbpDictOwner; the
// vocabulary panel itself now lives in the options tab, options-vocab.js).
// Article-scoped state, reset per document: the manual language override the
// reader picked for the PREVIOUS article, and the CLD prior sampled from its
// text. Both are wrong the moment the article underneath changes.
function pbpDictOnArticle(detail) {
  const account = detail ? detail.account : "";
  _pbpDictOwner = pbpDictOwnerScope(account);
  _pbpDictManualLang = ""; // language override is per-document, never carried over
  _pbpDictArticlePrior = null; // article CLD prior is per-document too
}
document.addEventListener("pbp:rendered", (e) => pbpDictOnArticle((e && e.detail) || null));
// In-place article replacement (md-preview.js _applyArticleCommit): pbp:rendered
// stays a once-per-page event, so the same reset has to ride the replacement
// lifecycle. NOT {once:true} -- a page can replace its article repeatedly.
// will: kill the query that is still resolving against the old article (the
// same teardown an action switch performs -- aborts the child request, drops
// the save target and the current entry). replaced: re-derive the per-document
// state, exactly as a fresh render would.
document.addEventListener("pbp:article-will-replace", () => window.pbpDictOnActionSwitch());
document.addEventListener("pbp:article-replaced", (e) => pbpDictOnArticle((e && e.detail) || null));
// An owner change ends the old query and its external completion cue. A
// same-owner token rotation keeps both: document language/prior are unchanged.
// Commit-time owner reads still guard writes that race an unseen storage event.
document.addEventListener("pbp:account-changed", (e) => {
  const next = pbpDictOwnerScope(e && e.detail ? e.detail.account : "");
  if (next === _pbpDictOwner) return;
  _pbpDictOwner = next;
  window.pbpDictOnActionSwitch();
});
