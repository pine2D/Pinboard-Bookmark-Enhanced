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

// Keep explicit free-form language identities stable for paid legacy records.
// Only the new native-language default resolves names to known language codes.
function pbpDictLearningTarget(settings, uiLanguage) {
  const clean = value => typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim() : "";
  const explicit = clean(settings?.dictDefinitionLang);
  if (explicit) return pbpDictDefinitionLanguage(explicit, uiLanguage);
  const native = clean(settings?.dictLearnerNativeLanguage);
  if (!native) return pbpDictDefinitionLanguage("", uiLanguage);
  const code = pbpDictKnownLanguageName(native) || pbpDictDefinitionLanguage(native, uiLanguage).lang;
  const current = pbpDictDefinitionLanguage("", uiLanguage);
  const generic = !/[-_]/.test(native) && !/简体|繁体|繁體/.test(native);
  if (generic && code !== "und" && code.split("-")[0] === current.lang.split("-")[0]) return current;
  return pbpDictDefinitionLanguage(code === "und" ? native : code, uiLanguage);
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
  // One title per dictionary source (dict redesign 3.1): the online result and
  // CC-CEDICT name themselves like the packs and ECDICT do. Packs carry their
  // own title outside this entry; the AI entry has its block's title.
  if (!norm.packId && !norm.aiGenerated) {
    const locale = typeof uiLangToBCP47 === "function" ? uiLangToBCP47() : document.documentElement.lang || "en";
    const title = document.createElement("div"); title.className = "xp-dict-local-title";
    title.textContent = [norm.sourceLabel || "Wiktionary", pbpDictLanguageLabel(definitionLang, locale)].filter(Boolean).join(" · ");
    slot.appendChild(title);
  }
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
  // Metadata once per card (3b.3): the source is named by its title (above,
  // or the pack's box title), so the footer holds only its licence and any
  // declared attribution, linked to the source page; the link's accessible
  // name still says whose page it opens. The AI entry has no footer -- its
  // block title says what it is. With no licence or attribution, a source
  // page is still linked under the source's name; with neither, no footer.
  if (!norm.aiGenerated) {
    const sourceName = norm.sourceLabel || (!norm.packId ? "Wiktionary" : "");
    const sourceUrl = pbpDictSafeUrl(norm.sourceUrl) || (!norm.packId ? pbpDictWiktionaryUrl(term) : "");
    const notice = [norm.license || (!norm.packId ? "CC BY-SA" : ""), norm.attribution || ""].filter(Boolean).join(" · ");
    const text = notice || (sourceUrl ? sourceName : "");
    if (text) {
      const src = document.createElement("div");
      src.className = "xp-dict-src";
      const a = document.createElement(sourceUrl ? "a" : "span");
      // Defense-in-depth: sourceUrl is already sanitized at the normalize/merge
      // layers, but this is the only point it reaches a live href.
      if (sourceUrl) {
        a.href = sourceUrl; a.target = "_blank"; a.rel = "noopener noreferrer";
        if (notice && sourceName) a.setAttribute("aria-label", sourceName + " · " + notice);
      }
      a.textContent = text;
      src.appendChild(a);
      slot.appendChild(src);
    }
  }
  _pbpDictSyncSourceDividers(slot);
}

// "Label: value" fields take their colon from the UI language's dictFieldLabel
// template (zh "$1：", fr "$1 :"); a label ending in
// full-width punctuation carries its own spacing, a half-width one gets a space.
function _pbpDictFieldLabel(key) {
  const text = t("dictFieldLabel", t(key));
  return /[\u3000-\u303f\uff00-\uffef]$/.test(text) ? text : text + " ";
}

// Dates in lookup provenance follow the extension's UI language, not the
// browser's default locale.
function _pbpDictUiLocale() {
  try { return (typeof uiLangToBCP47 === "function" && uiLangToBCP47()) || document.documentElement.lang || undefined; }
  catch (_) { return undefined; }
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
    const say = text => _pbpDictLiveSay(feedback, value => { feedback.textContent = value; }, text);
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      say("");
      let granted = false;
      // FIRST await in the click chain must be the permission request.
      try { granted = await chrome.permissions.request({ origins: [PBP_DICT_ORIGIN + "/*"] }); } catch (_) {}
      if (!granted) {
        btn.textContent = t("dictConnectRetry");
        say(t("dictPermissionDenied"));
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
// With settings, a custom provider entry id in the provenance shows as that
// entry's name (or the generic custom name once the entry is gone), never as
// its internal id; without them the license reads exactly as stored.
function pbpDictEntryNorm(record, target, settings) {
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
  let provider = record.provider;
  if (settings && typeof pbpAiCustomEntryIdOk === "function" && pbpAiCustomEntryIdOk(provider) &&
      typeof pbpAiResolveTarget === "function") provider = pbpAiResolveTarget(settings, provider).label;
  return { word: entry.word, pronunciation: entry.pronunciation, definitionLang: target.lang, sourceLabel: "AI", sourceUrl: "",
    license: "AI-generated · " + provider + " / " + record.model, aiGenerated: true,
    entries };
}

// Only fixed validation labels and HTTP status may enter diagnostics; never log model output,
// lookup text, or a provider-supplied arbitrary reason string.
const PBP_DICT_FAILURE_REASONS = Object.freeze(["response_size", "response_json", "response_shape", "entry_fields", "entry_identity",
  "entry_pronunciation", "entry_meanings", "entry_meanings_all_invalid", "entry_meaning", "entry_example", "entry_learning", "entry_related", "entry_version",
  "entry_sources", "entry_legacy", "entry_unknown", "explanation_metadata", "explanation_script",
  "explanation_language", "supplement_fields", "supplement_item", "supplement_item_shape", "supplement_item_sense",
  "supplement_item_text", "supplement_source_index", "supplement_duplicate", "supplement_source", "supplement_quote",
  "supplement_example", "supplement_size", "supplement_summary_term", "internal_term"]);
function _pbpDictFailureReason(error) {
  if (PBP_DICT_FAILURE_REASONS.includes(error?.reason)) return error.reason;
  const status = error?.status;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? "http_" + status : "";
}

const PBP_DICT_GENERATION_ERROR_KEYS = Object.freeze({
  host_permission: "aiGrantRetry",
  owner_changed: "vocabAccountChanged",
  account_changed: "vocabAccountChanged",
  sync_failed: "dictEntrySyncFailed",
  no_sources: "dictSupplementNoSources",
  unsupported_usage: "dictSupplementUnsupported",
  wrong_language: "dictSupplementWrongLanguage",
  invalid_response: "dictSupplementInvalid",
  output_truncated: "dictGenerationTruncated",
  output_refused: "dictGenerationRefused",
  empty_response: "dictGenerationEmpty",
  // A provider error event inside a 200 stream (ai.js requireComplete path):
  // the service failed mid-answer, so say it is unavailable, as for a 5xx.
  stream_error: "dictGenerationServiceUnavailable",
  // The client stopped a 2xx stream past its output budget (ai.js
  // _pbpOutputBudget): the answer was cut short, exactly like a truncation,
  // and nothing was saved.
  output_budget_exceeded: "dictGenerationTruncated",
  model_not_found: "dictGenerationModelUnavailable"
});
function _pbpDictGenerationErrorKey(error, supplement = false) {
  if (typeof error?.code === "string" && Object.hasOwn(PBP_DICT_GENERATION_ERROR_KEYS, error.code)) return PBP_DICT_GENERATION_ERROR_KEYS[error.code];
  if (error?.name === "TimeoutError") return "trErrTimeout";
  if (error?.status === 401) return "trErrKey";
  if (error?.status === 402) return "dictGenerationBilling";
  // ai.js never files a 5xx as model_not_found: the service is down, so say that
  // instead of the generic retry text or a "change your model" hint.
  if (Number.isInteger(error?.status) && error.status >= 500 && error.status < 600) return "dictGenerationServiceUnavailable";
  return supplement ? "dictSupplementUnavailable" : "dictEntryUnavailable";
}
// Failure tone (dict redesign ruling 2026-10-26): a failure is an error --
// danger ink and a warning icon. "Nothing verifiable was found" and "this word
// has no such usage" are answers, not failures, so they read neutral with an
// info icon. source_failed stays an error: the retrieval itself broke.
const PBP_DICT_NEUTRAL_CODES = Object.freeze(["no_sources", "unsupported_usage"]);
function _pbpDictFailureTone(error) {
  return PBP_DICT_NEUTRAL_CODES.includes(error?.code) ? "neutral" : "error";
}
// Writes a status line with its tone: data-state carries it to the stylesheet
// and an error / neutral line leads with the shared warning / info icon. The
// icon is a static shared constant, never message text, and is aria-hidden,
// so textContent and what a screen reader hears stay the message alone.
function _pbpDictToneText(el, text, tone = "") {
  const icon = text && (tone === "error" ? "warning" : tone === "neutral" ? "info" : "");
  const svg = icon && typeof PBP_ICONS === "object" ? PBP_ICONS[icon] || "" : "";
  if (svg) {
    const mark = document.createElement("span"); mark.className = "xp-dict-msg-ic";
    mark.innerHTML = svg; // static shared icon, never model or page text
    el.replaceChildren(mark, document.createTextNode(text));
  } else el.textContent = text;
  if (text && tone) el.dataset.state = tone; else delete el.dataset.state;
}
// A status row is a live region, and a region that enters the accessibility
// tree together with its text is often not announced (VoiceOver with Chrome
// especially). Every lookup status row therefore stays in the tree for its
// whole life: it is never [hidden], and an empty row takes no space (a bare
// status line by its :empty rule, a feedback box by [data-live-empty]).
// Speaking only changes its text: a different message is written at once, and
// the same message again is cleared first and written two frames later, so
// the repeat is a change too. Two frames because a requestAnimationFrame
// callback runs BEFORE the style and layout of its own frame; the second one
// runs after the cleared row has been laid out. A row whose ancestor is still
// hidden (a block being revealed in the same task) waits the same two frames.
// A write while one is pending only replaces the pending text, and empty text
// cancels it, so the last call wins.
const _pbpDictLivePending = new WeakMap(), _pbpDictLiveText = new WeakMap();
// What the row says or is about to say; "" when it is empty.
function _pbpDictLiveHas(row) {
  return !!(_pbpDictLivePending.get(row)?.text || _pbpDictLiveText.get(row));
}
function _pbpDictLiveSay(row, paint, text) {
  text = text || "";
  const pending = _pbpDictLivePending.get(row);
  if (pending && text) { pending.paint = paint; pending.text = text; return; }
  _pbpDictLivePending.delete(row);
  const rendered = row.isConnected && row.getClientRects().length > 0;
  if (!text || (rendered && text !== _pbpDictLiveText.get(row))) {
    paint(text); _pbpDictLiveText.set(row, text); row.toggleAttribute("data-live-empty", !text);
    return;
  }
  paint(""); _pbpDictLiveText.set(row, "");
  row.toggleAttribute("data-live-empty", false);
  const job = { paint, text };
  _pbpDictLivePending.set(row, job);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (_pbpDictLivePending.get(row) !== job) return;
    _pbpDictLivePending.delete(row);
    job.paint(job.text); _pbpDictLiveText.set(row, job.text);
  }));
}
// An action's failure (plan 3.4) is its own role=alert line placed right
// after the button that failed -- in the same action row, so it reads where
// the retry is -- with the warning icon. It is removed and, for a new failure,
// inserted afresh, so each failure is announced once and never also spoken by
// a status line. Neutral answers and progress never use it: they stay in the
// polite status lines with the info icon (or none). Empty text clears it.
function _pbpDictActionError(trigger, text) {
  const old = trigger?.nextElementSibling;
  if (old?.classList.contains("xp-dict-action-error")) old.remove();
  if (!text || !trigger?.parentElement) return null;
  const error = document.createElement("p"); error.className = "xp-dict-msg xp-dict-action-error";
  error.setAttribute("role", "alert");
  _pbpDictToneText(error, text, "error");
  trigger.after(error);
  return error;
}
const PBP_DICT_FAILURE_EXTRA_CODES = Object.freeze(["ai_disabled", "ai_not_configured", "invalid_request", "not_saved",
  "source_failed", "stale", "network", "endpoint_invalid"]);
function _pbpDictFailureCode(error) {
  if (error?.name === "TimeoutError") return "request_timeout";
  const code = error?.code;
  return typeof code === "string" && (Object.hasOwn(PBP_DICT_GENERATION_ERROR_KEYS, code) ||
    PBP_DICT_FAILURE_EXTRA_CODES.includes(code)) ? code : "request_failed";
}

// Local failure ledger (2026-10-26 ruling): each row is exactly an error code,
// a stage, a category and a time -- never the term, a definition, model output
// or an arbitrary provider string. One chrome.storage.local key per owner,
// named by the owner's SHA-256 because the owner string carries the plaintext
// Pinboard username. It is neither a setting (outside SETTINGS_DEFAULTS, so no
// backup and no sync routing) nor archive data (outside pbp-dict-archive, so no
// Drive), and the options storage panel reclaims it with the "misc" category.
const PBP_DICT_LEDGER_PREFIX = "pbpDictFailures:";
const PBP_DICT_LEDGER_CAP = 200;
const PBP_DICT_LEDGER_STAGES = Object.freeze(["init", "permission", "preparing", "sources", "generating", "checking", "saving"]);
// Statuses worth telling apart in the ledger; any other status keeps only the
// top-level code so the set of strings that can ever be stored stays closed.
const PBP_DICT_LEDGER_HTTP = Object.freeze([400, 401, 402, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504, 524, 529]);
// The whitelist (Q13 = A): top-level codes plus fixed "code.detail" pairs. A
// detail joins only the code that really throws it -- explanation_* comes with
// wrong_language, every other validation label with invalid_response, and a
// bare HTTP status with request_failed. Anything else is filed as request_failed.
const PBP_DICT_LEDGER_CODES = Object.freeze(new Set([
  ...Object.keys(PBP_DICT_GENERATION_ERROR_KEYS), ...PBP_DICT_FAILURE_EXTRA_CODES,
  "request_timeout", "request_failed", "settings_failed",
  ...PBP_DICT_FAILURE_REASONS.map(reason => (reason.startsWith("explanation_") ? "wrong_language." : "invalid_response.") + reason),
  ...PBP_DICT_LEDGER_HTTP.map(status => "request_failed.http_" + status)
]));
function pbpDictLedgerCode(error) {
  const code = error?.code === "settings_failed" ? "settings_failed" : _pbpDictFailureCode(error);
  const detail = _pbpDictFailureReason(error), fine = detail ? code + "." + detail : "";
  return PBP_DICT_LEDGER_CODES.has(fine) ? fine : PBP_DICT_LEDGER_CODES.has(code) ? code : "request_failed";
}
// What a new supplement may be generated in (dict-entry.js); every other
// archive category is read-only and labelled as old (1B.7).
function _pbpDictGeneratableCategory(category) {
  return typeof PBP_DICT_GENERATABLE_CATEGORIES !== "undefined" && PBP_DICT_GENERATABLE_CATEGORIES.includes(category);
}
function _pbpDictLedgerCategory(category) {
  if (category === "entry") return category;
  const known = typeof PBP_DICT_ARCHIVE_CATEGORIES !== "undefined" ? PBP_DICT_ARCHIVE_CATEGORIES
    : typeof PBP_DICT_GENERATABLE_CATEGORIES !== "undefined" ? PBP_DICT_GENERATABLE_CATEGORIES : [];
  return known.includes(category) ? category : "";
}
function _pbpDictLedgerRow(row) {
  return !!row && typeof row === "object" && !Array.isArray(row) && Object.keys(row).length === 4 &&
    PBP_DICT_LEDGER_CODES.has(row.code) && (row.stage === "" || PBP_DICT_LEDGER_STAGES.includes(row.stage)) &&
    typeof row.category === "string" && row.category === _pbpDictLedgerCategory(row.category) &&
    Number.isSafeInteger(row.at) && row.at > 0;
}
// Same raw-UTF-8 SHA-256 as ask-archive.js's _pbpAskArchiveOwnerHash; repeated
// here because md-dict.js loads before ask-archive.js on the reader page.
async function _pbpDictLedgerKey(owner) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner));
  return PBP_DICT_LEDGER_PREFIX + Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
let _pbpDictLedgerQueue = Promise.resolve();
function _pbpDictLedgerLock(task) {
  if (globalThis.navigator?.locks?.request) return navigator.locks.request("pbp-dict-ledger", task);
  const run = _pbpDictLedgerQueue.then(task, task);
  _pbpDictLedgerQueue = run.catch(() => {});
  return run;
}
// Resolves true only when the row was stored. Never throws: a ledger failure is
// a console.warn with the error name, never a broken lookup.
async function pbpDictLedgerRecord(owner, failure = {}) {
  // Signed out ("ownerless") or unknown owner: fail closed, write nothing.
  if (typeof owner !== "string" || !owner.startsWith("acct_")) return false;
  const row = { code: PBP_DICT_LEDGER_CODES.has(failure.code) ? failure.code : "request_failed",
    stage: PBP_DICT_LEDGER_STAGES.includes(failure.stage) ? failure.stage : "",
    category: _pbpDictLedgerCategory(failure.category), at: Date.now() };
  const live = async () => typeof pbpVocabCurrentOwner === "function" && await pbpVocabCurrentOwner() === owner;
  try {
    return await _pbpDictLedgerLock(async () => {
      if (!(await live())) return false;
      const key = await _pbpDictLedgerKey(owner);
      const stored = (await chrome.storage.local.get(key))?.[key];
      const rows = Array.isArray(stored) ? stored.filter(_pbpDictLedgerRow) : [];
      rows.push(row);
      // The account can switch while the read is in flight; this row belongs to
      // the account that failed, so drop it rather than file it after a switch.
      if (!(await live())) return false;
      await chrome.storage.local.set({ [key]: rows.slice(-PBP_DICT_LEDGER_CAP) });
      return true;
    });
  } catch (error) {
    console.warn("[dict-ledger] write failed:", error?.name);
    return false;
  }
}
async function pbpDictLedgerRead(owner) {
  if (typeof owner !== "string" || !owner.startsWith("acct_")) return [];
  const key = await _pbpDictLedgerKey(owner);
  const stored = (await chrome.storage.local.get(key))?.[key];
  return Array.isArray(stored) ? stored.filter(_pbpDictLedgerRow) : [];
}
// Cancellation and a superseded query are not failures.
function _pbpDictLedgerFail(owner, error, stage, category) {
  if (error?.name === "AbortError" || error?.code === "stale") return;
  pbpDictLedgerRecord(owner, { code: pbpDictLedgerCode(error), stage, category });
}

// Local empty-result memory (plan 1C.4, Q11=A, Q12=A): "the last search found
// no verifiable source text" (examples, etymology sources) and "the model
// judged there is nothing usable" (patterns, confusables) are remembered per
// account so the next lookup can say so beside its button. Nothing is retried
// automatically: retrying is the user's ordinary click, paid blocks pay again.
// One bounded chrome.storage.local key per owner, pbpDictNeg:<owner SHA-256>,
// holding { entryKey: at }. entryKey is the SHA-256 of [term, sourceLanguage,
// target or "", category], so no word is stored in plaintext (a small word
// space can still be guessed back, which is why privacy.md says "not stored
// in plaintext" rather than "not recorded"). Retrieval categories ignore the
// target language; AI categories keep it. The model never takes part. Rows
// older than 30 days read as absent and are pruned on the next write; past
// 500 rows the oldest go. Like the ledger it is outside SETTINGS_DEFAULTS
// (no backup, no sync routing), outside pbp-dict-archive (no Drive), and the
// options storage panel reclaims it with the "misc" category.
const PBP_DICT_NEG_PREFIX = "pbpDictNeg:";
const PBP_DICT_NEG_CAP = 500;
const PBP_DICT_NEG_TTL = 30 * 24 * 60 * 60 * 1000;
const PBP_DICT_NEG_RETRIEVAL = Object.freeze(["examples", "etymology"]);
const PBP_DICT_NEG_CATEGORIES = Object.freeze([...PBP_DICT_NEG_RETRIEVAL, "patterns", "confusables"]);
// The remembered AI judgement names its own category: the button above it
// no longer does (ruling 2026-10-28).
const PBP_DICT_NEG_NONE_KEYS = Object.freeze({ patterns: "dictPatternsNone", confusables: "dictConfusablesNone" });
async function _pbpDictSha256Hex(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
function _pbpDictNegOwner(owner) { return typeof owner === "string" && owner.startsWith("acct_"); }
// One answer language as the memory keys it: {lang, name}, a custom one
// ("und") told apart by name.
function _pbpDictLanguageKey(answer) {
  return answer && typeof answer === "object" ? (answer.lang === "und" ? "und:" + String(answer.name || "") : String(answer.lang || ""))
    : String(answer || "");
}
// null when the parts cannot name one entry (unknown category, no word).
async function _pbpDictNegEntryKey(parts = {}) {
  const category = parts?.category;
  if (!PBP_DICT_NEG_CATEGORIES.includes(category) || typeof parts.term !== "string" || !parts.term.trim()) return null;
  const target = PBP_DICT_NEG_RETRIEVAL.includes(category) ? "" : _pbpDictLanguageKey(parts.target);
  return _pbpDictSha256Hex(JSON.stringify([parts.term, String(parts.sourceLanguage || "und"), target, category]));
}
function _pbpDictNegRows(stored, now) {
  const rows = {};
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return rows;
  for (const [key, at] of Object.entries(stored)) {
    if (/^[0-9a-f]{64}$/.test(key) && Number.isSafeInteger(at) && at > 0 && now - at < PBP_DICT_NEG_TTL) rows[key] = at;
  }
  return rows;
}
function _pbpDictNegStorage() {
  return typeof chrome !== "undefined" && typeof chrome.storage?.local?.get === "function" && typeof chrome.storage.local.set === "function";
}
// Same lock-name prefix as the ledger: both are small per-owner diagnostics.
function _pbpDictNegLock(task) {
  if (globalThis.navigator?.locks?.request) return navigator.locks.request("pbp-dict-ledger:neg", task);
  return _pbpDictLedgerLock(task);
}
// Read-modify-write under the lock, with the live owner checked before the
// read and again before the write; resolves true only when it was stored.
async function _pbpDictNegUpdate(owner, parts, change) {
  if (!_pbpDictNegOwner(owner) || !_pbpDictNegStorage()) return false;
  const live = async () => typeof pbpVocabCurrentOwner === "function" && await pbpVocabCurrentOwner() === owner;
  try {
    const entry = await _pbpDictNegEntryKey(parts);
    if (!entry) return false;
    return await _pbpDictNegLock(async () => {
      if (!(await live())) return false;
      const key = PBP_DICT_NEG_PREFIX + await _pbpDictSha256Hex(owner);
      const now = Date.now();
      const rows = _pbpDictNegRows((await chrome.storage.local.get(key))?.[key], now);
      if (!change(rows, entry, now)) return false;
      const kept = Object.entries(rows).sort((a, b) => b[1] - a[1]).slice(0, PBP_DICT_NEG_CAP);
      // The account can switch while the read is in flight: this memory
      // belongs to the account that searched, so drop it after a switch.
      if (!(await live())) return false;
      await chrome.storage.local.set({ [key]: Object.fromEntries(kept) });
      return true;
    });
  } catch (error) {
    console.warn("[dict-neg] write failed:", error?.name);
    return false;
  }
}
function pbpDictNegRecord(owner, parts) {
  return _pbpDictNegUpdate(owner, parts, (rows, entry, now) => { rows[entry] = now; return true; });
}
// A success, a found source or a positive record from Drive forgets the row.
function pbpDictNegForget(owner, parts) {
  return _pbpDictNegUpdate(owner, parts, (rows, entry) => {
    if (!Object.hasOwn(rows, entry)) return false;
    delete rows[entry]; return true;
  });
}
// true when this account's last attempt for these parts found nothing within
// 30 days. Never throws: an unreadable memory is simply no memory.
async function pbpDictNegHas(owner, parts) {
  if (!_pbpDictNegOwner(owner) || !_pbpDictNegStorage()) return false;
  try {
    const entry = await _pbpDictNegEntryKey(parts);
    if (!entry) return false;
    const key = PBP_DICT_NEG_PREFIX + await _pbpDictSha256Hex(owner);
    const rows = _pbpDictNegRows((await chrome.storage.local.get(key))?.[key], Date.now());
    return Object.hasOwn(rows, entry);
  } catch (error) {
    console.warn("[dict-neg] read failed:", error?.name);
    return false;
  }
}

// The AI part of the one-column lookup (dict redesign 3.1, Q14=A). It sits
// after the dictionary results and holds, in this fixed order: the AI entry
// (its source title, its one action row, status, progress and content), the
// learning blocks -- usage points, the caller's free original-text examples
// block (opts.examples), etymology -- then readable old categories and earlier
// versions, and last the card's one metadata line (model, date, explanation
// language). There is no "dictionary | AI" switch: the dictionary stays where
// it is and the AI entry is either expanded or, for dictDefaultView
// "dictionary", folded into one free "view AI entry" line. opts.onView(expanded)
// reports that state; expanded means a rendered entry is on screen.
let _pbpDictEntryMountSeq = 0;

// Whether a changed settings key can change what the lookup's AI entry would
// send or where: the dictionary preferences, the provider choice and every
// field that forms a provider target (key, model, base URL, region, workspace,
// format; numbered custom-entry key slots), plus the custom-entry list and
// the first entry's display name.
const _PBP_DICT_SETTINGS_KEYS = new Set(["dictDefaultView", "dictAiAutoGenerate", "dictLearnerNativeLanguage", "dictLearnerLevel", "dictDefinitionLang", "previewAiEnabled", "aiProvider", "previewAiModelByProvider", "optSyncEnabled", "syncApiKeys", "aiCustomProviders", "customDisplayName"]);
function _pbpDictSettingsKeyRelevant(key) {
  return _PBP_DICT_SETTINGS_KEYS.has(key) || /(?:Model|ApiKey\d*|BaseUrl|Region|WorkspaceId|Protocol)$/.test(key);
}
function _pbpDictEntryMount(host, opts) {
  if (typeof pbpDictEntryRead !== "function" || typeof pbpDictEntryRun !== "function") return null;
  const panel = document.createElement("div"); panel.className = "xp-dict-ai";
  // The AI entry's source title, styled like each dictionary source's. It
  // takes focus (programmatically only) when its own action disappears.
  const title = document.createElement("div"); title.className = "xp-dict-local-title xp-dict-ai-title";
  title.textContent = t("dictEntrySource"); title.tabIndex = -1; title.hidden = true;
  const controls = document.createElement("div"); controls.className = "row xp-dict-ai-controls";
  const button = (key, name) => {
    const el = document.createElement("button"); el.type = "button";
    el.className = "xp-dict-connect " + name; el.textContent = t(key); return el;
  };
  // Every button in the lookup is its icon and its text: there is no
  // icon-only action in the body of the lookup (plan 3.3).
  const labelled = (el, key, icon) => {
    const svg = document.createElement("span");
    svg.innerHTML = typeof PBP_ICONS === "object" ? PBP_ICONS[icon] || "" : ""; // static shared icon
    const text = document.createElement("span"); text.textContent = t(key);
    el.replaceChildren(...svg.childNodes, text);
    return el;
  };
  // A paid action (plan 3.3): wandSparkles, its text and only the model name
  // beside it ([icon, label, .xp-dict-model] -- the note holds " ·", a space
  // and .xp-dict-model-name, see modelNotes). That it calls AI and uses
  // tokens is said in its description (title / aria-description), never in
  // the note, and no token count or price is shown. The model note follows
  // the current settings (modelNotes).
  const paidButton = (key, name, hintKey) => {
    const el = labelled(button(key, name), key, "wandSparkles");
    const model = document.createElement("span"); model.className = "xp-dict-model"; el.appendChild(model);
    el.title = t(hintKey); el.setAttribute("aria-description", el.title);
    return el;
  };
  const generate = paidButton("dictEntryGenerate", "xp-dict-ai-generate", "dictPaidActionHint");
  generate.disabled = true;
  // Free: shows the saved entry this lookup already has; it never generates.
  const reveal = labelled(button("dictEntryShowAi", "xp-dict-ai-reveal"), "dictEntryShowAi", "chevronDown");
  reveal.setAttribute("aria-expanded", "false"); reveal.hidden = true;
  const configure = labelled(document.createElement("a"), "aiConfigure", "gear"); configure.className = "xp-dict-connect xp-dict-ai-configure";
  configure.href = "options.html#ai"; configure.target = "_blank"; configure.rel = "noopener noreferrer"; configure.hidden = true;
  controls.append(generate, reveal, configure);
  const status = document.createElement("div"); status.className = "xp-dict-msg xp-dict-ai-status";
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const content = document.createElement("div"); content.className = "xp-dict-ai-content"; content.hidden = true;
  reveal.setAttribute("aria-controls", content.id = "xp-dict-ai-content-" + (++_pbpDictEntryMountSeq));
  // The card's one metadata line, after every AI block.
  const meta = document.createElement("p"); meta.className = "xp-dict-src xp-dict-ai-provenance"; meta.hidden = true;
  panel.append(title, controls);
  // Every generation reports its progress in place inside this panel (plan
  // 2.6). A busy ancestor delays live-region announcements, so the panel
  // never claims aria-busy while a phase line is speaking.
  panel.setAttribute("aria-busy", "false");
  let settings = null, record = null, busy = false, active = null, epoch = 0, expanded = false;
  // The one running generation: { kind: "entry" | "usage", feedback, origin,
  // version, startedAt, timer, key }. Its elapsed-seconds timer is cleared on
  // every way the run can end (complete, fail, cancel, settings change,
  // closing or replacing the query), not only in a finally that a pending
  // permission await could hold back.
  let activity = null, renderedLanguage = null;
  const usageFeedbacks = new WeakMap();
  // Local empty-result memory of the learning blocks (plan 1C.4): which
  // category this account's last attempt found nothing for. Read once the
  // settings (and so the answer language) are known, before the first render
  // chooses between the ordinary button and "last time not found · retry".
  const negState = {}, negTouched = new Set();
  // The language the memory above was read for; a render in another language
  // re-reads it, so a block never shows another language's "not found".
  let negLanguage = null;
  // True while that read is in flight: the learning blocks show no paid
  // action until it answers, so a plain button never renames itself to
  // "Not found last time · Try again" a moment later (first render and a
  // language-switching render alike).
  let negPending = false;
  let renderedBase = "", baseDetails = null, baseRetry = null, usageForm = null, previousSupplements = null;
  const supplementNodes = new Map();
  const preference = () => typeof pbpDictDefaultView === "function" ? pbpDictDefaultView(settings) :
    settings?.dictDefaultView || (settings?.dictAiAutoGenerate === true ? "ai-generate" : "ai-saved");
  const alive = () => !opts.signal?.aborted && panel.isConnected && opts.isCurrent();
  const configured = () => settings && settings.previewAiEnabled !== false && typeof hasAIKey === "function" && hasAIKey(settings);
  const target = () => pbpDictLearningTarget(settings,
    typeof uiLangToBCP47 === "function" ? uiLangToBCP47() : document.documentElement.lang || "en");
  const languageName = language => {
    const code = language.lang === "und" ? pbpDictKnownLanguageName(language.name) : language.lang;
    try { return code ? new Intl.DisplayNames([document.documentElement.lang || "en"], { type: "language" }).of(code) : language.name; }
    catch (_) { return language.name; }
  };
  // The panel's own line, for what belongs to no action (syncing, a settings
  // or account failure, a cache write that failed). The status node speaks
  // plain and neutral text politely; an error there is an alert line in its
  // place instead (plan 3.4), so only an error interrupts.
  const message = (text, tone = "") => {
    const error = tone === "error";
    _pbpDictLiveSay(status, value => _pbpDictToneText(status, value, error ? "" : tone), error ? "" : text);
    _pbpDictActionError(status, error ? text : "");
  };
  // One feedback box: the phase line (the only live region), the elapsed
  // seconds as plain text beside it -- never inside an aria-live or
  // role=status node, so a screen reader is not interrupted every second --
  // and the in-place cancel. Phase changes speak; the seconds do not.
  const feedbackBox = anchor => {
    const box = document.createElement("div"); box.className = "xp-dict-usage-feedback"; box.toggleAttribute("data-live-empty", true);
    const text = document.createElement("p"); text.className = "xp-dict-msg xp-dict-usage-status";
    text.setAttribute("role", "status"); text.setAttribute("aria-live", "polite"); text.setAttribute("aria-atomic", "true");
    const elapsed = document.createElement("span"); elapsed.className = "xp-dict-usage-elapsed"; elapsed.hidden = true;
    const cancel = labelled(button("askStop", "xp-dict-usage-stop"), "askStop", "stop"); cancel.hidden = true;
    cancel.addEventListener("click", () => cancelActive());
    box.append(text, elapsed, cancel);
    return { box, text, elapsed, cancel, anchor, activity: null };
  };
  // The base entry's first generation reports in its own row, just below the
  // action it replaces while running (the generate button hides when busy).
  const entryProgress = feedbackBox(null);
  panel.append(status, entryProgress.box, content);
  if (opts.examples) panel.appendChild(opts.examples);
  panel.appendChild(meta); host.appendChild(panel);
  const usageFeedback = anchor => {
    if (usageFeedbacks.has(anchor)) return usageFeedbacks.get(anchor);
    const hadFocus = document.activeElement === anchor;
    const row = document.createElement("div"); row.className = "xp-dict-usage-actions";
    anchor.before(row); row.appendChild(anchor);
    const feedback = feedbackBox(anchor);
    row.appendChild(feedback.box);
    usageFeedbacks.set(anchor, feedback);
    if (hadFocus) anchor.focus({ preventScroll: true });
    return feedback;
  };
  // An action's note. Progress, saved and neutral answers stay in its polite
  // status line; an error goes to an alert line right after the button that
  // failed (trigger: the feedback's own action, or the generate button for
  // the first entry), or to the panel's line when that button is gone.
  const usageMessage = (feedback, text, state = "", trigger = feedback.anchor) => {
    const error = state === "error" && !!text;
    if (error && !trigger?.isConnected) message(text, "error");
    else if (trigger) _pbpDictActionError(trigger, error ? text : "");
    if (error) { text = ""; state = ""; }
    const tone = state === "neutral" ? state : "";
    _pbpDictLiveSay(feedback.box, value => _pbpDictToneText(feedback.text, value, tone), text);
    feedback.box.dataset.state = state;
    feedback.cancel.hidden = state !== "busy";
    feedback.elapsed.hidden = state !== "busy" || !feedback.elapsed.textContent;
    if (feedback.anchor) feedback.anchor.hidden = state === "busy";
  };
  const elapsedText = act => t("dictProgressElapsed", String(Math.max(0, Math.floor((Date.now() - act.startedAt) / 1000))));
  const endProgress = act => {
    if (!act) return;
    clearInterval(act.timer); act.timer = 0;
    // A newer run may already own this box (cancel, then click again).
    if (act.feedback.activity === act) {
      act.feedback.activity = null; act.feedback.elapsed.textContent = ""; act.feedback.elapsed.hidden = true;
    }
    if (activity === act) activity = null;
  };
  // Starts counting at the click, so the seconds include the permission
  // prompt and any Drive pre-sync: they are not the transport's 180 s
  // deadline, which starts later in ai.js.
  const startProgress = (kind, feedback, origin, version) => {
    endProgress(activity);
    const act = { kind, feedback, origin, version, startedAt: Date.now(), timer: 0, key: "" };
    activity = act; feedback.activity = act;
    feedback.elapsed.textContent = elapsedText(act);
    act.timer = setInterval(() => {
      if (activity !== act || epoch !== version || !alive()) { endProgress(act); return; }
      feedback.elapsed.textContent = elapsedText(act);
    }, 1000);
    return act;
  };
  // The phase line changes only when the phase does: a repeated phase is not
  // re-announced. Stale runs never touch it.
  const progressPhase = (act, key) => {
    if (!key || activity !== act || act.key === key) return;
    act.key = key; usageMessage(act.feedback, t(key), "busy");
  };
  const PHASE_KEYS = { thinking: "dictProgressThinking", streaming: "dictProgressStreaming" };
  // The one model note every paid action carries, read from the current
  // settings on each sync: a settings change (another model) reaches the
  // generate, update and supplement buttons alike.
  const modelName = () => configured() && typeof pbpDictEntryModelName === "function" ? pbpDictEntryModelName(settings) || "" : "";
  const modelNotes = () => {
    const name = modelName();
    for (const note of panel.querySelectorAll("button > .xp-dict-model")) {
      // " ·" is glued to the end of the label (nowrap, and no break before a
      // space), the real space after it is the one break, and the name never
      // breaks: a wrapped note starts with the model name, never with "·".
      // The button's text reads "label · model" with ordinary spaces.
      if (!name) note.replaceChildren();
      else if (note.lastElementChild?.textContent !== name) {
        const sep = document.createElement("span"); sep.className = "xp-dict-model-sep"; sep.textContent = " ·";
        const model = document.createElement("span"); model.className = "xp-dict-model-name"; model.textContent = name;
        note.replaceChildren(sep, " ", model);
      }
      // A slot's buttons leave their category to the slot's label on screen;
      // their accessible name says it: category · text · model.
      const el = note.parentElement, category = el.dataset.categoryName;
      if (category) el.setAttribute("aria-label", [category, note.previousElementSibling?.textContent, name].filter(Boolean).join(" · "));
    }
  };
  const sync = () => {
    const off = !record && !!settings && settings.previewAiEnabled === false;
    generate.hidden = !!record || !configured() || busy; generate.disabled = busy || !settings;
    modelNotes();
    reveal.hidden = !record || expanded;
    configure.hidden = !!record || !settings || settings.previewAiEnabled === false || configured();
    controls.hidden = off || (generate.hidden && reveal.hidden && configure.hidden);
    title.hidden = !record || !expanded;
    content.hidden = !expanded;
    // With AI off and nothing saved, only the free examples block remains.
    panel.hidden = off && !opts.examples;
    if (!record || !expanded) meta.hidden = true;
    for (const node of panel.querySelectorAll(":scope > [data-ai-block]")) node.hidden = !expanded || node.dataset.aiBlockEmpty === "true";
  };
  // Expanding is one-way within a lookup: the saved entry stays shown once a
  // click, a generation or the preference has opened it.
  const show = open => {
    if (!alive()) return;
    if (open) expanded = true;
    reveal.setAttribute("aria-expanded", String(expanded));
    sync(); usageForm?.refresh(); syncMeta();
    opts.onView?.(expanded && !!record);
  };
  const render = (value, answerLanguage, open = true, revealSupplement = "") => {
    // Read before the base re-renders: an update's cancel sits inside the
    // content that is about to be replaced.
    const hadFocus = document.activeElement === generate || document.activeElement === reveal ||
      (activity?.kind === "entry" && document.activeElement === activity.feedback.cancel);
    record = value; renderedLanguage = answerLanguage;
    if (negLanguage !== null && _pbpDictLanguageKey(answerLanguage) !== negLanguage) {
      for (const category of Object.keys(negState)) delete negState[category];
      negTouched.clear();
      loadNeg().catch(error => console.warn("[dict-neg] state read failed:", error?.name));
    }
    const norm = pbpDictEntryNorm(record, answerLanguage, settings);
    // Supplement receipts and additions do not change the paid base entry.
    // Retaining these nodes also retains open disclosures and reading position.
    // norm.license carries the provider's display label: renaming a custom
    // provider entry must re-render the line that names it.
    const baseKey = JSON.stringify([record.entry, record.provider, record.model, record.generatedAt, answerLanguage, record.previousEntries?.map(v => v.archiveId), norm.license]);
    if (baseKey !== renderedBase) {
      const wasOpen = baseDetails?.open || false;
      _pbpDictRenderEntry(content, norm, opts.term, opts.lang, opts.term, "");
      if (!record.entry.meanings.length) {
        const empty = document.createElement("p"); empty.className = "xp-dict-msg";
        empty.textContent = t("dictEntryNoEntry"); content.prepend(empty);
      }
      // Etymology and related words of an older entry shape stay folded under
      // their own title; the entry's provenance is the card's metadata line.
      const details = document.createElement("details"); details.className = "xp-dict-ai-details";
      const summary = document.createElement("summary");
      summary.textContent = t("dictEntryDetails");
      details.appendChild(summary);
      if (record.entry.learning) {
        const learning = record.entry.learning;
        for (const [label, value] of [["dictEntryFormation", learning.formation], ["dictEntryHistory", learning.history]]) {
          if (!value) continue;
          const p = document.createElement("p"); p.lang = answerLanguage.lang; p.dir = "auto";
          const strong = document.createElement("strong"); strong.textContent = _pbpDictFieldLabel(label);
          p.append(strong, value); details.appendChild(p);
        }
        if (!learning.history && (learning.formation || learning.related.length)) {
          const p = document.createElement("p"); p.className = "xp-dict-src"; p.textContent = t("dictEntryNoHistory"); details.appendChild(p);
        }
        for (const relation of learning.related) {
          const p = document.createElement("p"); p.dir = "auto"; p.lang = answerLanguage.lang;
          const word = document.createElement(typeof opts.onLookup === "function" ? "button" : "bdi");
          word.lang = opts.lang || "und"; word.textContent = relation.word;
          if (word.tagName === "BUTTON") {
            word.type = "button"; word.className = "xp-dict-lemma-link"; word.title = t("dictLookupSelection");
            word.addEventListener("click", () => { if (alive()) opts.onLookup(relation.word); });
          }
          const label = t("dictEntryRelation" + relation.relation[0].toUpperCase() + relation.relation.slice(1));
          p.append(word, " · " + label + " — " + relation.note); details.appendChild(p);
        }
        for (const source of learning.sources || []) {
          const p = document.createElement("p"); p.className = "xp-dict-src";
          const link = document.createElement("a"); link.href = source.url; link.textContent = source.title;
          link.target = "_blank"; link.rel = "noopener noreferrer"; p.appendChild(link); details.appendChild(p);
        }
      } else if (record.entry.etymology) {
        const p = document.createElement("p"); p.lang = answerLanguage.lang; p.dir = "auto";
        p.textContent = record.entry.etymology; details.appendChild(p);
      }
      if (!record.entry.learning && record.entry.relatedWords.length) {
        const words = document.createElement("p"); words.className = "xp-dict-rel"; words.lang = opts.lang || "und"; words.dir = "auto";
        const label = document.createElement("span"); label.lang = document.documentElement.lang || "und";
        label.textContent = _pbpDictFieldLabel("dictEntryRelated"); words.appendChild(label);
        record.entry.relatedWords.forEach((word, index) => {
          if (index) words.append(" · ");
          if (typeof opts.onLookup !== "function") { words.append(word); return; }
          const link = button("dictLookupSelection", "xp-dict-lemma-link");
          link.className = "xp-dict-lemma-link"; link.textContent = word;
          link.addEventListener("click", () => { if (alive()) opts.onLookup(word); }); words.appendChild(link);
        });
        details.appendChild(words);
      }
      if (details.childElementCount > 1) content.appendChild(details);
      if (configured() && record.archiveId) {
        const update = paidButton("dictEntryUpdate", "xp-dict-update-entry", "dictEntryUpdateHint");
        update.addEventListener("click", () => run(true, record.archiveId, update)); content.appendChild(update);
      }
      if (record.previousEntries?.length) {
        const previous = document.createElement("details"); previous.className = "xp-dict-ai-details";
        const heading = document.createElement("summary"); heading.textContent = t("dictSupplementPrevious"); previous.appendChild(heading);
        previous.addEventListener("toggle", () => {
          if (!previous.open || previous.childElementCount > 1) return;
          for (const old of record.previousEntries) {
            const version = document.createElement("details"); version.className = "xp-dict-ai-details";
            const title = document.createElement("summary"); title.textContent = [new Date(old.generatedAt).toLocaleString(_pbpDictUiLocale()), old.model].join(" · ");
            const text = document.createElement("p"); text.dir = "auto"; text.lang = answerLanguage.lang;
            text.textContent = [old.entry.pronunciation, old.entry.meanings.map(m => [m.partOfSpeech, m.definition, ...m.examples.map(e => e.text + "\n" + e.translation)].filter(Boolean).join("\n")).join("\n\n"),
              old.entry.learning ? [old.entry.learning.formation, old.entry.learning.history, ...old.entry.learning.related.map(r => r.word + " — " + r.note)].filter(Boolean).join("\n\n") : old.entry.etymology + "\n" + old.entry.relatedWords.join(" · ")].filter(Boolean).join("\n\n");
            version.append(title, text);
            for (const source of old.entry.learning?.sources || []) {
              const p = document.createElement("p"); p.className = "xp-dict-src";
              const link = document.createElement("a"); link.href = source.url; link.textContent = source.title; link.target = "_blank"; link.rel = "noopener noreferrer";
              p.appendChild(link); version.appendChild(p);
            } previous.appendChild(version);
          }
        }); content.appendChild(previous);
      }
      details.open = wasOpen; baseDetails = details; renderedBase = baseKey;
    }
    // An entry is on screen now: a neutral note or a failure left by an
    // earlier first generation no longer answers anything (a running one
    // keeps its line), even when the entry came in a passive sync.
    if (entryProgress.box.dataset.state !== "busy") usageMessage(entryProgress, "", "", null);
    _pbpDictActionError(generate, "");
    renderSupplements(answerLanguage, revealSupplement);
    opts.onEntry?.(norm, record, content);
    show(open);
    // Move focus off a disappearing action without scrolling the article.
    if (hadFocus) focusEntry();
    // A failed local write: when the archive copy failed too, the retry
    // button is what answers it, so the alert sits beside that button (plan
    // 3.4) and a failed retry replaces it there -- one alert, never also in
    // the top line. A cache-only failure has no button: the top line.
    const notCached = record.cacheSaved === false ? t("dictEntryNotCached") : "";
    if (notCached && baseRetry?.isConnected) { message(""); _pbpDictActionError(baseRetry, notCached); }
    else message(notCached, "error");
  };
  // Focus lands on the AI entry's title when its action has gone; while the
  // entry is folded, the free reveal line is what remains.
  const focusEntry = () => {
    const next = !title.hidden ? title : !reveal.hidden ? reveal : !generate.hidden ? generate : null;
    next?.focus({ preventScroll: true });
  };
  // A slotted result has no title of its own: its slot's label stands in.
  const itemFocus = item => !item ? null : !item.heading.hidden ? item.heading : usageForm?.focusTarget(item.addition.category) || null;
  // The card's one metadata line (ruling 3.1): model, date and explanation
  // language, once, after every AI block -- not a receipt per block. The models
  // of the entry and its shown learning blocks are named once each; the date
  // is the latest generation among them.
  const syncMeta = () => {
    if (!record || !expanded) { meta.hidden = true; return; }
    const shown = [record, ...(record.supplements || []).filter(item => supplementNodes.get(supplementId(item))?.section.isConnected)];
    const models = [...new Set(shown.map(item => item.model).filter(Boolean))];
    const latest = Math.max(...shown.map(item => Number(item.generatedAt) || 0));
    meta.textContent = [...models, latest > 0 ? new Date(latest).toLocaleDateString(_pbpDictUiLocale()) : "",
      t("dictSupplementLanguage", languageName(renderedLanguage || target()))].filter(Boolean).join(" · ");
    meta.hidden = false;
  };
  const input = (signal, isCurrent) => ({ term: opts.term, sourceLanguage: opts.lang || "und", target: target(),
    owner: opts.owner, settings, signal, isCurrent });
  // The learning blocks belong to the entry on screen: once rendered, its
  // language (not a setting or interface language changed since) is what a
  // supplement request asks for, and what the AI-judgement memory is keyed by
  // (plan Q12=A), so the record and the lookup always name the same language.
  const learningLanguage = () => renderedLanguage || target();
  // Saving and refreshing the entry on screen ask for its language too: a
  // retry or a synced copy must land on the record the user is looking at.
  const entryInput = (signal, isCurrent) => ({ ...input(signal, isCurrent), target: learningLanguage() });
  const negParts = (category, language = learningLanguage()) => ({ term: opts.term, sourceLanguage: opts.lang || "und", target: language, category });
  const negForget = category => { negState[category] = false; pbpDictNegForget(opts.owner, negParts(category)); };
  const loadNeg = async () => {
    const language = learningLanguage(), key = _pbpDictLanguageKey(language);
    negLanguage = key; negPending = true;
    try {
      if (!_pbpDictNegOwner(opts.owner)) return;
      const categories = ["patterns", "confusables", "etymology"];
      const found = await Promise.all(categories.map(category => pbpDictNegHas(opts.owner, negParts(category, language))));
      // A later render switched the language: its own read answers that view.
      if (!alive() || negLanguage !== key) return;
      // A click made while this read was in flight already answered this view.
      categories.forEach((category, index) => { if (found[index] && !negTouched.has(category)) negState[category] = true; });
    } finally {
      // Only the read for the language on screen releases the actions; a
      // failed read shows the ordinary buttons rather than none.
      if (negLanguage === key) { negPending = false; if (alive()) usageForm?.refresh(); }
    }
  };
  const supplementId = addition => addition.id || String(addition.generatedAt);
  // A result outside its slot says which learner profile it was made for:
  // the native language, and the level for the categories that use it
  // (pbpDictSupplementProfile); an unset value reads "not specified".
  const profileTitle = addition => {
    const unset = t("dictLearnerLevelUnspecified"), level = ["beginner", "intermediate", "advanced"].includes(addition.profile.level) ? addition.profile.level : "";
    const parts = [t("dictSupplementNativeLanguage", addition.profile.nativeLanguage || unset)];
    if (addition.category !== "patterns") parts.push(t("dictSupplementLevel", level ? t("dictLearnerLevel" + level[0].toUpperCase() + level.slice(1)) : unset));
    return parts.join(" · ");
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
          _pbpDictActionError(baseRetry, "");
          try {
            const saved = await pbpDictEntrySave(entryInput(opts.signal, alive), record);
            if (alive()) {
              const hadFocus = document.activeElement === baseRetry;
              render(saved, answerLanguage, false);
              if (hadFocus) focusEntry();
            }
          } catch (error) {
            if (alive()) _pbpDictActionError(baseRetry, t("dictEntryNotCached"));
            console.warn("[dict-entry] save retry failed:", error?.name);
          } finally { saving = false; baseRetry.removeAttribute("aria-disabled"); }
        });
      }
      if (!baseRetry.isConnected) content.appendChild(baseRetry);
    } else if (baseRetry) { _pbpDictActionError(baseRetry, ""); baseRetry.remove(); }
    const retained = new Set(), legacySections = [];
    const replaced = new Set((record.supplements || []).map(item => item.learning?.replacesId).filter(Boolean));
    if (replaced.size && !previousSupplements) {
      previousSupplements = document.createElement("details"); previousSupplements.className = "xp-dict-ai-details";
      const summary = document.createElement("summary"); summary.textContent = t("dictSupplementPrevious"); previousSupplements.appendChild(summary);
    }
    const form = learningForm();
    // Each slot is for the current learner settings: it holds the newest
    // result made for them (or its button). A result made for another native
    // language or level -- the settings changed, or Drive brought it from a
    // device set up differently -- is read outside the blocks under a title
    // naming its profile, so a slot never shows a result beside its button
    // or two untitled results read as one card.
    const inSlot = new Set(["patterns", "confusables", "etymology"].map(category => form.current(category)).filter(Boolean).map(supplementId));
    const profileSections = [];
    for (const addition of record.supplements || []) {
      const id = supplementId(addition);
      retained.add(id);
      let item = supplementNodes.get(id);
      if (!item) {
        const section = document.createElement("details"); section.className = "xp-dict-ai-details";
        section.dataset.supplementId = id; section.dataset.supplementCategory = addition.category;
        // A generated block shows its content directly (no "view saved" step):
        // a current-category result opens where its button was. Older
        // categories and superseded versions stay folded.
        section.open = inSlot.has(id);
        const heading = document.createElement("summary");
        const text = document.createElement("div"); text.className = "xp-dict-supplement-text"; text.dir = "auto";
        const aiNote = document.createElement("p"); aiNote.className = "xp-dict-src"; aiNote.hidden = true;
        aiNote.lang = document.documentElement.lang || "und";
        const receipt = document.createElement("p"); receipt.className = "xp-dict-src";
        section.append(heading, text, aiNote, receipt);
        item = { section, heading, text, aiNote, receipt, sources: [], sourceKey: "", retry: null, addition, contentKey: "", update: null };
        supplementNodes.set(id, item);
      }
      item.addition = addition;
      const { section, heading, text, receipt } = item;
      // A category that can no longer be generated (1B.7) stays readable with
      // a neutral "old category" note after its title and offers no update;
      // a failed save can still be retried. dictSupplementLegacy is a
      // different note: old content without the v2 structure.
      const legacyCategory = !_pbpDictGeneratableCategory(addition.category);
      const slotted = inSlot.has(id);
      const otherProfile = !slotted && !replaced.has(id) && !legacyCategory;
      const name = t("dictSupplement" + addition.category[0].toUpperCase() + addition.category.slice(1)) +
        (addition.profile.topic ? " · " + addition.profile.topic : "") + (otherProfile ? " · " + profileTitle(addition) : "");
      const title = name + (legacyCategory ? " · " + t("dictSupplementLegacyCategory") : "");
      if (heading.textContent !== title) {
        heading.textContent = legacyCategory ? name + " · " : name;
        // "Old category" is a neutral state (plan 3.4): the info icon leads
        // it, aria-hidden and outside the text.
        if (legacyCategory) {
          const note = document.createElement("span");
          _pbpDictToneText(note, t("dictSupplementLegacyCategory"), "neutral");
          heading.append(...note.childNodes);
        }
      }
      const contentKey = JSON.stringify(addition.learning || addition.content);
      if (item.contentKey !== contentKey) {
        text.replaceChildren();
        let aiWritten = false;
        if (addition.learning?.version === 2) {
          const learning = addition.learning;
          if (learning.summary) { const p = document.createElement("p"); p.textContent = learning.summary; text.appendChild(p); }
          for (const point of learning.items) {
            const unit = document.createElement("div"); unit.className = "xp-dict-learning-item";
            const title = document.createElement("p"); const strong = document.createElement("strong"); strong.textContent = point.title; title.appendChild(strong);
            if (addition.category === "etymology" && ["family", "cognate", "synonym", "topic"].includes(point.kind) && typeof opts.onLookup === "function") {
              const word = button("dictLookupSelection", "xp-dict-lemma-link"); word.className = "xp-dict-lemma-link";
              word.textContent = point.title; word.lang = opts.lang || "und"; word.title = t("dictLookupSelection");
              word.addEventListener("click", () => { if (alive()) opts.onLookup(point.title); });
              strong.replaceChildren(word);
            }
            if (addition.category === "etymology" && point.kind) {
              const key = ["formation", "history"].includes(point.kind) ? "dictEntry" : "dictEntryRelation";
              const label = document.createElement("span"); label.className = "xp-dict-src";
              label.textContent = t(key + point.kind[0].toUpperCase() + point.kind.slice(1)); label.lang = document.documentElement.lang || "und";
              title.append(" · ", label);
            }
            const explanation = document.createElement("p"); explanation.textContent = point.explanation; unit.append(title, explanation);
            const parent = addition.archiveId === record.archiveId ? record : record.previousEntries?.find(entry => entry.archiveId === addition.archiveId);
            const meaning = parent?.entry.meanings[point.sense - 1]?.definition;
            if (meaning) {
              // A small source-style line, but its text is the AI entry's own
              // sense, so it keeps greedy wrapping like every AI-written line
              // (rules/dict.md, task 3d), not the short notes' balance.
              const sense = document.createElement("p"); sense.className = "xp-dict-src"; sense.dataset.text = "ai";
              sense.textContent = t("dictSupplementMeaning", meaning); unit.insertBefore(sense, explanation);
            }
            if (point.example) {
              const example = document.createElement("p"); example.className = "xp-dict-example";
              example.textContent = point.example; example.lang = opts.lang || "und"; example.dir = "auto";
              const translation = document.createElement("p"); translation.className = "xp-dict-example-translation"; translation.textContent = point.translation;
              unit.append(example, translation);
            }
            // A sourced item keeps its own citation; that an item is the
            // model's own writing is said once for the result (aiNote).
            const source = addition.sources?.[point.sourceIndex];
            if (source) {
              const note = document.createElement("p"); note.className = "xp-dict-src";
              const link = document.createElement("a"); link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer";
              link.textContent = [source.author, source.work || source.title, source.location].filter(Boolean).join(" · ");
              note.append(link, " · " + t("dictSupplementSourceVerified"));
              unit.appendChild(note);
            } else aiWritten = true;
            text.appendChild(unit);
          }
          if (learning.omittedItems) {
            const partial = document.createElement("p"); partial.className = "xp-dict-msg";
            partial.dataset.partialResult = "true"; partial.lang = document.documentElement.lang || "und"; partial.dir = "auto";
            // Part of the record's text, so it keeps the text column's edge:
            // no leading icon (the action row's partial status carries it).
            partial.textContent = t("dictSupplementPartial", String(learning.items.length), String(learning.omittedItems));
            text.appendChild(partial);
          }
        } else {
          const p = document.createElement("p"); p.textContent = addition.content;
          const legacy = document.createElement("p"); legacy.className = "xp-dict-src"; legacy.textContent = t("dictSupplementLegacy"); text.append(p, legacy);
        }
        // Metadata once per card (3b.3): one statement per AI result, right
        // after its items, that its unsourced items -- the usage examples, the
        // etymology's formation -- are the model's own writing (rules/dict.md
        // "明确标识的 AI 编写例句"), never a label under each item.
        item.aiNote.textContent = aiWritten ? t(addition.category === "etymology" ? "dictAiLabel" : "dictSupplementOriginal") : "";
        item.aiNote.hidden = !aiWritten;
        item.contentKey = contentKey;
      }
      text.lang = addition.learning?.language?.lang || answerLanguage.lang;
      const sourceKey = JSON.stringify(addition.sources || []);
      if (sourceKey !== item.sourceKey) {
        item.sources.forEach(node => node.remove()); item.sources = [];
        for (const [index, source] of (addition.learning ? [] : addition.sources || []).entries()) {
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
      // Model, date and language are the card's one metadata line; a block's
      // own line only says that its save failed.
      receipt.textContent = addition.archiveSaved === false ? t("dictSupplementSaveFailed") : "";
      receipt.hidden = !receipt.textContent;
      // Old categories (and every record saved with a topic, which only they
      // took) are read-only (1B.5, 1B.7).
      if (configured() && addition.id && addition.archiveSaved !== false && !replaced.has(id) && !legacyCategory && !addition.profile?.topic) {
        if (!item.update) {
          item.update = paidButton("dictSupplementUpdate", "xp-dict-update-supplement", "dictSupplementUpdateHint");
          item.update.dataset.categoryName = t("dictSupplement" + addition.category[0].toUpperCase() + addition.category.slice(1));
          item.update.addEventListener("click", () => usageForm?.update(item.addition));
        }
        if (!item.update.isConnected) section.appendChild(item.update);
      } else item.update?.remove();
      if (addition.archiveSaved === false) {
        if (!item.retry) {
          item.retry = button("dictEntryRetrySave", "xp-dict-retry-save");
          let saving = false;
          item.retry.addEventListener("click", async () => {
            if (!alive() || busy || saving) return;
            const feedback = usageFeedback(item.retry);
            saving = true; item.retry.setAttribute("aria-disabled", "true");
            usageMessage(feedback, t("dictSupplementSaving"), "saving");
            try {
              const saved = await pbpDictSupplementSave(entryInput(opts.signal, alive), item.addition);
              if (!alive()) return;
              const hadFocus = document.activeElement === item.retry;
              record.supplements = record.supplements.map(value => supplementId(value) === id ? saved : value);
              render(record, answerLanguage, false, section.open ? supplementId(saved) : "");
              usageMessage(feedback, t("dictSupplementSaved"), "saved");
              if (hadFocus) itemFocus(supplementNodes.get(supplementId(saved)))?.focus({ preventScroll: true });
            } catch (error) {
              if (alive()) usageMessage(feedback, t("dictSupplementSaveFailed"), "error");
              console.warn("[dict-entry] usage save retry failed:", error?.name);
            }
            finally { saving = false; item.retry.removeAttribute("aria-disabled"); }
          });
        }
        if (!item.retry.isConnected) section.appendChild(item.retry);
      } else item.retry?.remove();
      // A current result sits in its category's fixed slot (ruling
      // 2026-10-28), under the slot's label -- or, for etymology, under the
      // block heading -- so it carries no title of its own and stays open: a
      // second title would repeat the category. Old categories and earlier
      // versions keep their folded title.
      heading.hidden = slotted;
      if (slotted) { section.open = true; delete section.dataset.aiBlock; }
      if (replaced.has(id)) {
        if (section.parentElement !== previousSupplements) previousSupplements.appendChild(section);
      } else if (legacyCategory) legacySections.push(section);
      else if (otherProfile) profileSections.push(section);
      else if (section.parentElement !== form.slots[addition.category]) form.slotEnd(addition.category).before(section);
      if (id === revealId) section.open = true;
    }
    for (const [id, item] of supplementNodes) {
      if (!retained.has(id)) { item.section.remove(); supplementNodes.delete(id); }
    }
    // Fixed order after the AI entry: usage points, the free examples block,
    // etymology, then results made for another learner profile, readable old
    // categories and earlier versions, then the metadata line. A node moves only when it is out of order, so open folds
    // and keyboard focus survive re-renders.
    for (const node of legacySections) node.dataset.aiBlock = "legacy";
    for (const node of profileSections) node.dataset.aiBlock = "profile";
    if (previousSupplements) previousSupplements.dataset.aiBlock = "previous";
    let previous = content;
    for (const node of [form.usage, ...(opts.examples ? [opts.examples] : []), form.etymology, ...profileSections, ...legacySections,
      ...(replaced.size ? [previousSupplements] : []), meta]) {
      if (node.parentElement !== panel || !(previous.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) previous.after(node);
      previous = node;
    }
    form.refresh();
  };
  // The learning blocks (redesign 1B.8, Q8=A): "usage points" holds two paid
  // categories -- collocations and patterns, confusables -- each generating,
  // saving and failing on its own; "etymology" holds one. Each paid button is
  // the wandSparkles icon, its text and the model name. A category that has a
  // result shows it in the block instead of its button, so no control ever
  // switches between a free "view saved" and a paid "generate".
  //
  // Slots (ruling 2026-10-28): every category has one fixed slot, and
  // everything about that category -- its button or its result with the
  // result's update button, its progress, notes, receipts and alerts -- stays
  // inside it, so generating, updating, failing or remembering a miss never
  // reorders the block or leaves a receipt under the other category's button.
  // The usage block's two slots open with a small label line naming their
  // category (patterns, then confusables); the etymology block has one
  // category, so its heading is the slot's only label. A button inside a slot
  // never repeats the category name on screen ("Generate", or "Not found last
  // time · Try again", plus the model); its accessible name still starts with
  // the category.
  const learningForm = () => {
    if (usageForm) return usageForm;
    const block = (name, key) => {
      const el = document.createElement("section"); el.className = "xp-dict-learning-section"; el.dataset.learningBlock = name;
      el.dataset.aiBlock = name;
      el.setAttribute("role", "group"); el.setAttribute("aria-label", t(key));
      const heading = document.createElement("p"); heading.className = "xp-dict-learning-title"; heading.textContent = t(key);
      heading.tabIndex = -1;
      el.appendChild(heading); return el;
    };
    const labelKeys = { patterns: "dictSupplementPatterns", confusables: "dictSupplementConfusables", etymology: "dictSupplementEtymology" };
    const paid = category => {
      const el = paidButton("dictSlotGenerate", "xp-dict-supplement-generate", "dictPaidActionHint"); el.dataset.category = category;
      el.dataset.categoryName = t(labelKeys[category]);
      return el;
    };
    const usage = block("usage", "dictLearningUsagePoints"), etymology = block("etymology", "dictLearningEtymology");
    const slot = (category, labelled) => {
      const el = document.createElement("div"); el.className = "xp-dict-learning-slot"; el.dataset.slot = category;
      if (labelled) {
        const label = document.createElement("p"); label.className = "xp-dict-learning-label"; label.dataset.category = category;
        label.textContent = t(labelKeys[category]); label.tabIndex = -1; el.appendChild(label);
      }
      return el;
    };
    const slots = { patterns: slot("patterns", true), confusables: slot("confusables", true), etymology: slot("etymology", false) };
    const buttons = Object.fromEntries(Object.keys(labelKeys).map(category => [category, paid(category)]));
    // [icon..., label, model]: the label is the model span's previous sibling.
    const labels = Object.fromEntries(Object.entries(buttons).map(([category, el]) => [category, el.lastElementChild.previousElementSibling]));
    const etymologyHint = document.createElement("p"); etymologyHint.className = "xp-dict-src"; etymologyHint.textContent = t("dictEtymologyHint");
    slots.patterns.appendChild(buttons.patterns); slots.confusables.appendChild(buttons.confusables);
    slots.etymology.append(etymologyHint, buttons.etymology);
    usage.append(slots.patterns, slots.confusables); etymology.appendChild(slots.etymology);
    const feedbacks = Object.fromEntries(Object.entries(buttons).map(([category, el]) => [category, usageFeedback(el)]));
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
    // The explanation language is said once, in the card's metadata line.
    profile.appendChild(edit);
    usage.appendChild(profile);
    // A slot's results sit above its action row: below the label in the usage
    // slots, before the hint that introduces the etymology button.
    const slotEnd = category => category === "etymology" ? etymologyHint : feedbacks[category].box.parentElement;
    // Where focus goes once a result has replaced its button: the slot's
    // label, or the etymology block's heading.
    const focusTarget = category => category === "etymology" ? etymology.firstElementChild : slots[category]?.firstElementChild || null;
    // The topic no longer takes part in reuse (1B.5), as in dict-entry.js's find().
    const existing = category => {
      const profile = pbpDictSupplementProfile(settings, category);
      const matches = (record.supplements || []).filter(item => item.category === category &&
        item.profile.nativeLanguage === profile.nativeLanguage && item.profile.level === profile.level);
      const replaced = new Set(matches.map(item => item.learning?.replacesId).filter(Boolean));
      return matches.filter(item => !replaced.has(item.id)).sort((a, b) => b.generatedAt - a.generatedAt || String(b.id).localeCompare(String(a.id)))[0];
    };
    const slotHolds = addition => { const held = existing(addition.category); return !!held && supplementId(held) === supplementId(addition); };
    const refresh = () => {
      const canGenerate = configured() && !!record?.archiveId;
      const model = canGenerate ? modelName() : "";
      modelNotes();
      for (const [category, el] of Object.entries(buttons)) {
        const feedback = feedbacks[category];
        const saved = existing(category);
        el.hidden = feedback.box.dataset.state === "busy" || !canGenerate || !!saved || negPending;
        // A positive record (generated here or brought by Drive) wins over the
        // memory and forgets it; for etymology only one with sources does,
        // since a formation-only answer is itself a source miss.
        if (saved && negState[category] && (category !== "etymology" || saved.sources?.length)) negForget(category);
        const remembered = !el.hidden && negState[category] === true;
        // Ruling 2026-10-28: every learning block has its own heading, so the
        // remembered button drops the category name and reads only "Not found
        // last time · Try again" plus the model note -- one line in the
        // reader's 480px popover. Its accessible name still says what it
        // generates (category, retry, model). In the usage block each of the
        // two such buttons sits under its own slot's category label, with its
        // category-specific neutral note below it.
        labels[category].textContent = remembered ? t("dictNegRetry") : t("dictSlotGenerate");
        if (remembered) el.dataset.remembered = "true"; else delete el.dataset.remembered;
        // Retrieval and AI judgement read differently; both are neutral answers
        // with the info icon, never errors, and never claim the usage is absent.
        // A remembered miss never covers a failure still shown beside the button.
        if (remembered && !_pbpDictLiveHas(feedback.box) && !el.nextElementSibling?.classList.contains("xp-dict-action-error")) {
          usageMessage(feedback, t(PBP_DICT_NEG_RETRIEVAL.includes(category) ? "dictSupplementNoSources" : PBP_DICT_NEG_NONE_KEYS[category]), "neutral");
          feedback.remembered = true;
        } else if (!remembered && feedback.remembered) {
          usageMessage(feedback, ""); feedback.remembered = false;
        }
        // The row stays while it holds this button's error (a failed save
        // hides the button but must still be read beside it).
        feedback.box.parentElement.hidden = el.hidden && !_pbpDictLiveHas(feedback.box) &&
          !el.nextElementSibling?.classList.contains("xp-dict-action-error");
      }
      // The accessible names follow the faces just set (and the model).
      modelNotes();
      profile.hidden = buttons.patterns.hidden && buttons.confusables.hidden;
      etymologyHint.hidden = buttons.etymology.hidden;
      // A slot shows while it holds anything besides its label; a block
      // shows only while the AI entry is expanded and has something in it
      // besides its title.
      for (const el of Object.values(slots)) el.hidden = ![...el.children].some(node => !node.hidden && !node.matches(".xp-dict-learning-label"));
      for (const el of [usage, etymology]) {
        el.dataset.aiBlockEmpty = String(![...el.children].slice(1).some(node => !node.hidden));
        el.hidden = !expanded || el.dataset.aiBlockEmpty === "true";
      }
      syncMeta();
    };
    const enableForm = () => { for (const el of Object.values(buttons)) el.disabled = false; };
    const generateSupplement = async (updating = null, explicitCategory = "") => {
      if (!alive() || busy) return;
      const category = updating?.category || explicitCategory;
      const origin = updating ? supplementNodes.get(supplementId(updating))?.update : buttons[category];
      if (!origin?.isConnected || !_pbpDictGeneratableCategory(category)) return;
      const answerLanguage = learningLanguage();
      const feedback = usageFeedback(origin);
      // An update reports its progress and failures beside its own button,
      // but its outcome lands under the new version: the version it replaces
      // folds away with its row. A slotted result's outcome is the slot's own
      // row; a result for another learner profile clears only its own.
      const outcome = updating && !slotHolds(updating) ? feedback : feedbacks[category];
      // Retrying is this ordinary click: this attempt's own outcome replaces
      // the remembered "last time" state.
      negTouched.add(category); negState[category] = false; feedback.remembered = false; outcome.remembered = false;
      usageMessage(feedback, "");
      // The slot says one thing at a time: an earlier receipt goes.
      if (outcome !== feedback) usageMessage(outcome, "");
      let restoreFocus = null;
      const hadFocus = document.activeElement === origin || (updating && panel.contains(document.activeElement));
      const version = ++epoch, controller = new AbortController(); active = controller; busy = true;
      const act = startProgress("usage", feedback, origin, version);
      const current = () => alive() && epoch === version && !controller.signal.aborted;
      let ledgerStage = "permission";
      const request = { ...input(controller.signal, current), target: answerLanguage, category,
        updateId: updating?.id || "",
        // A blanked leaking summary (Q6=B) is a partial failure of this paid
        // answer: file its fixed code at the checking stage; the items save.
        onDrop: error => { if (current()) _pbpDictLedgerFail(opts.owner, error, "checking", category); },
        // An etymology retrieval that found nothing in a supported language is
        // remembered; one that found sources forgets the memory. Unsupported
        // languages have no source origin and never reach this.
        onSources: count => {
          if (!current() || category !== "etymology" || !sourceOrigin) return;
          if (count) pbpDictNegForget(opts.owner, negParts(category)); else pbpDictNegRecord(opts.owner, negParts(category));
        },
        // Called synchronously from the stream (thinking / streaming) as
        // well as between the awaited stages. The two stream phases change
        // the words only; the ledger keeps filing them under "generating".
        onStage: stage => {
          if (!current()) return;
          if (PBP_DICT_LEDGER_STAGES.includes(stage)) ledgerStage = stage;
          progressPhase(act, PHASE_KEYS[stage] || { sources: "dictSupplementRetrieving", checking: "dictSupplementChecking", saving: "dictSupplementSaving",
            generating: category === "etymology" ? "dictEtymologyGenerating" : "dictSupplementGenerating" }[stage]);
        } };
      if (updating) request.settings = { ...settings, dictLearnerNativeLanguage: updating.profile.nativeLanguage, dictLearnerLevel: updating.profile.level };
      const sourceOrigin = pbpDictSupplementOrigin(category, opts.lang);
      for (const el of Object.values(buttons)) el.disabled = true;
      progressPhase(act, category === "etymology" ? "dictEtymologyGenerating" : "dictSupplementGenerating"); sync();
      if (hadFocus) feedback.cancel.focus({ preventScroll: true });
      try {
        // Request the model and one source origin together, directly from the
        // click. All subsequent fetches independently check that grant.
        if (sourceOrigin) {
          if (!(await requestAIHostPermissions(settings, [sourceOrigin + "/*"]))) throw { code: "host_permission" };
        } else await ensureAIHostPermissionWithGesture(settings);
        if (!current()) return;
        ledgerStage = "preparing";
        const addition = await pbpDictSupplementRun(request);
        if (!current()) return;
        record.supplements = [addition, ...(record.supplements || []).filter(item => !addition.id || item.id !== addition.id)];
        if (category !== "etymology") pbpDictNegForget(opts.owner, negParts(category));
        const id = supplementId(addition), focusStayed = document.activeElement === feedback.cancel;
        render(record, answerLanguage, false, id);
        // The receipt sits under the version it describes: the slot's row
        // when it is the slot's result, else the row of its own update.
        const fresh = supplementNodes.get(id);
        const landing = slotHolds(addition) ? feedbacks[category] : fresh?.update?.isConnected ? usageFeedback(fresh.update) : feedback;
        if (landing !== feedback) usageMessage(feedback, "");
        // A failed save is an error; a partial result is a neutral answer
        // (info icon, no alert); a full one is a plain "saved".
        usageMessage(landing, addition.archiveSaved === false ? t("dictSupplementSaveFailed") : addition.learning?.omittedItems
          ? t("dictSupplementPartial", String(addition.learning.items.length), String(addition.learning.omittedItems)) : t("dictSupplementSaved"),
          addition.archiveSaved === false ? "error" : addition.learning?.omittedItems ? "neutral" : "saved");
        // The result replaces its button; focus moves to its heading without
        // scrolling, so the reader stays where they were while waiting.
        if (focusStayed) restoreFocus = itemFocus(supplementNodes.get(id));
      } catch (error) {
        if (!current()) return;
        console.warn("[dict-entry] usage generation failed:", error?.name, _pbpDictFailureCode(error), _pbpDictFailureReason(error));
        _pbpDictLedgerFail(opts.owner, error, ledgerStage, category);
        // The model judged there is nothing usable: remember it for this
        // account (plan 1C.4). Failures, cancels and timeouts are not answers.
        if (error?.code === "unsupported_usage" && category !== "etymology") pbpDictNegRecord(opts.owner, negParts(category));
        // "Nothing usable" for a usage point is an answer, not a retrieval
        // miss: it has its own neutral copy, apart from the no-sources one.
        const text = t(error?.code === "unsupported_usage" && category !== "etymology" ? "dictUsagePointsEmpty" : _pbpDictGenerationErrorKey(error, true));
        if (document.activeElement === feedback.cancel) restoreFocus = origin;
        usageMessage(feedback, text, _pbpDictFailureTone(error));
      } finally {
        endProgress(act);
        if (epoch === version) {
          busy = false; active = null;
          if (alive()) {
            const focusStayed = document.activeElement === feedback.cancel;
            enableForm(); refresh(); sync();
            const next = restoreFocus || (focusStayed && !origin.hidden ? origin : null);
            if (next?.isConnected) next.focus({ preventScroll: true });
          }
        }
      }
    };
    for (const [category, el] of Object.entries(buttons)) el.addEventListener("click", () => generateSupplement(null, category));
    usageForm = { usage, etymology, slots, slotEnd, focusTarget, current: existing, refresh, enable: enableForm, update: addition => generateSupplement(addition) };
    return usageForm;
  };
  const run = async (manual, updateId = "", origin = null) => {
    if (!alive() || busy || !configured()) return;
    const hadFocus = manual && (document.activeElement === generate || content.contains(document.activeElement));
    // An update reports beside its own button; the first generation in the
    // panel's progress line. Either one's error is the line right after the
    // button that was clicked (plan 3.4), never the panel's top line.
    const feedback = updateId && origin?.isConnected ? usageFeedback(origin) : entryProgress;
    const trigger = updateId ? origin : generate;
    _pbpDictActionError(trigger, "");
    const version = ++epoch, controller = new AbortController(); active = controller; busy = true;
    const current = () => alive() && epoch === version && !controller.signal.aborted;
    const act = startProgress("entry", feedback, feedback.anchor || generate, version);
    message(""); progressPhase(act, "dictEntryGenerating");
    sync();
    // Only a click moves focus, and only to this run's own cancel.
    if (hadFocus) feedback.cancel.focus({ preventScroll: true });
    let ledgerStage = manual ? "permission" : "generating", cancelFocused = false;
    try {
      // The automatic path never requests permission. Only this direct click
      // can open Chrome's exact-origin permission prompt, before any other await.
      if (manual) await ensureAIHostPermissionWithGesture(settings);
      if (!current()) return;
      ledgerStage = "generating";
      if (typeof pbpAiBumpCounter === "function") pbpAiBumpCounter("explain");
      // An update replaces the entry on screen, in its language (as the
      // supplements and the save retry ask), even if a setting or the
      // interface language changed since; a first generation has none yet
      // and asks for the current target.
      const request = entryInput(controller.signal, current);
      // A dropped sense (Q6=B) is a partial failure of this paid answer: file
      // its fixed code at the checking stage; the entry itself still saves.
      const onDrop = error => { if (current()) _pbpDictLedgerFail(opts.owner, error, "checking", "entry"); };
      // The stream's phases, synchronously from ai.js; the ledger stage
      // stays "generating".
      const onStage = phase => { if (current()) progressPhase(act, PHASE_KEYS[phase]); };
      const result = await pbpDictEntryRun({ ...request, updateId, onDrop, onStage });
      // A generated entry is what the click asked to see: it opens expanded.
      if (current()) render(result, request.target, true);
    } catch (error) {
      if (!current()) return;
      console.warn("[dict-entry] generation failed:", error?.name, _pbpDictFailureCode(error), _pbpDictFailureReason(error));
      _pbpDictLedgerFail(opts.owner, error, ledgerStage, "entry");
      // A failure is an alert beside the button; a neutral answer stays in
      // this run's own polite line with the info icon. Writing it hides the
      // cancel, so note first whether focus was there.
      cancelFocused = document.activeElement === feedback.cancel;
      usageMessage(feedback, t(_pbpDictGenerationErrorKey(error)), _pbpDictFailureTone(error), trigger);
    } finally {
      endProgress(act);
      if (epoch === version) {
        busy = false; active = null;
        if (alive()) {
          cancelFocused ||= document.activeElement === feedback.cancel;
          // Take down the progress, not the answer the catch just wrote.
          if (feedback.box.dataset.state === "busy") usageMessage(feedback, "", "", null);
          sync();
          if (cancelFocused) {
            if (origin?.isConnected && !origin.hidden) origin.focus({ preventScroll: true });
            else focusEntry();
          }
        }
      }
    }
  };
  generate.addEventListener("click", () => run(true));
  // Free: shows what this lookup already holds; no request of any kind.
  reveal.addEventListener("click", () => {
    if (!alive() || !record) return;
    const hadFocus = document.activeElement === reveal;
    show(true);
    if (hadFocus) focusEntry();
  });
  // The in-place cancel. Focus returns to the action that started the run --
  // the generate icon, the entry's update button or the supplement's button.
  const cancelActive = () => {
    const act = activity;
    if (!act) return;
    epoch++; active?.abort(); active = null; busy = false; endProgress(act);
    if (act.kind === "usage") {
      usageMessage(act.feedback, t("askStopped")); usageForm?.enable(); usageForm?.refresh();
      sync(); if (act.origin.isConnected) act.origin.focus({ preventScroll: true }); return;
    }
    usageMessage(act.feedback, ""); message(""); sync();
    const origin = act.origin?.isConnected && !act.origin.hidden ? act.origin : null;
    if (origin) origin.focus({ preventScroll: true });
    else focusEntry();
  };
  opts.signal?.addEventListener("abort", () => {
    endProgress(activity);
    epoch++; active?.abort();
    if (!record) content.hidden = true;
  }, { once: true });
  const ready = Promise.resolve(opts.settings).then(async value => {
    if (!alive()) return;
    settings = value || {}; sync();
    const version = epoch;
    const negLoaded = loadNeg().catch(error => console.warn("[dict-neg] state read failed:", error?.name));
    const request = input(opts.signal, () => alive() && epoch === version);
    let hit = await pbpDictEntryRead(request);
    if (!hit && alive() && epoch === version && typeof pbpDictArchiveRead === "function") {
      message(t("dictEntrySyncing"));
      hit = await pbpDictEntryRestore(request);
      if (alive() && epoch === version) message("");
    }
    if (!alive() || epoch !== version) return;
    // The memory is read before the first render picks each block's button.
    await negLoaded;
    if (!alive() || epoch !== version) return;
    // dictDefaultView (Q14=A): "dictionary" folds a saved entry into the free
    // reveal line; "ai-saved" and "ai-generate" open it.
    if (hit) render(hit, request.target, expanded || preference() !== "dictionary");
    else if (preference() === "ai-generate") await run(false);
  }).catch(error => {
    if (!alive() || error?.name === "AbortError" || error?.code === "stale") return;
    console.warn("[dict-entry] initialization failed:", error?.name, error?.code || "settings_failed");
    _pbpDictLedgerFail(opts.owner, typeof error?.code === "string" ? error : { code: "settings_failed" }, "init", "entry");
    if (["owner_changed", "account_changed"].includes(error?.code)) message(t("vocabAccountChanged"), "error");
    else if (error?.code === "sync_failed") message(t("dictEntrySyncFailed"), "error");
    else message(t("dictEntryUnavailable"), "error");
    sync();
  });
  if (globalThis.chrome?.runtime?.onMessage) {
    const refreshed = async message => {
      if (message?.type !== "PBP_DICT_ARCHIVE_SYNCED" || message.owner !== opts.owner || !alive() || !settings || busy || record?.archiveSaved === false ||
          panel.contains(document.activeElement)) return;
      const version = epoch;
      try {
        const request = entryInput(opts.signal, () => alive() && epoch === version);
        const next = await pbpDictEntryRead(request);
        if (!next || !alive() || busy || epoch !== version || panel.contains(document.activeElement)) return;
        if (JSON.stringify(next) === JSON.stringify(record)) return;
        next.supplements = [...(next.supplements || []), ...(record?.supplements || []).filter(item => item.archiveSaved === false)];
        render(next, request.target, false);
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
      if (!alive() || !["sync", "local"].includes(area) || !keys.some(_pbpDictSettingsKeyRelevant)) return;
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
      // The run is void: stop its clock and take its busy line down now, before
      // the settings read below can keep a stale cancel on screen.
      const stale = activity; endProgress(stale); if (stale && alive()) usageMessage(stale.feedback, "");
      try {
        const next = deobfuscateSettings(await pbpReadSettingsWithSecrets(SETTINGS_DEFAULTS));
        if (alive() && epoch === revision) opts.onSettingsChange(next);
      } catch (error) {
        console.warn("[dict-entry] settings refresh failed:", error?.name);
        if (alive() && epoch === revision) { settings = null; message(t("dictEntryUnavailable"), "error"); sync(); }
      }
    };
    const changed = (changes, area) => listener(changes, area).catch(error =>
      console.warn("[dict-entry] settings routing read failed:", error?.name));
    chrome.storage.onChanged.addListener(changed);
    opts.signal?.addEventListener("abort", () => chrome.storage.onChanged.removeListener(changed), { once: true });
  }
  return { element: panel, controls, ready, show: () => show(true), isExpanded: () => expanded && !!record };
}

// The free original-text examples action asks for one exact Wikisource origin.
// Called synchronously from the click, so Chrome sees the live user gesture:
// this request is the first await after the click (never the AI origin, never
// requestAIHostPermissions, which always adds the AI endpoint).
function _pbpDictExamplesRequestOrigin(origin) {
  if (typeof chrome === "undefined" || typeof chrome.permissions?.request !== "function") return Promise.resolve(false);
  return chrome.permissions.request({ origins: [origin + "/*"] });
}

// Original-text examples (plan 1C.2, Q20=A): a block of its own beside the
// AI panel, created by the lookup in the reader and on the Library page. It
// shows retrieved source sentences with their metadata and never calls AI or
// translates (ruling 2026-10-27), so it is there with AI off, with no key and
// with no AI entry. Its life is the query's: opts.signal and opts.isCurrent
// (which carries the owner) end it, and a new query builds a new block.
// Results are not archived, synced or cached; finding again is a fresh click.
function pbpDictExamplesView(opts) {
  if (typeof pbpDictUsageExamplesFetch !== "function" || typeof pbpDictEvidenceOrigin !== "function") return null;
  const language = String(opts.lang || "");
  if (!language || language === "und") return null;
  const block = document.createElement("section");
  block.className = "xp-dict-learning-section xp-dict-examples"; block.dataset.learningBlock = "examples";
  block.setAttribute("role", "group"); block.setAttribute("aria-label", t("dictExamplesTitle"));
  const heading = document.createElement("p"); heading.className = "xp-dict-learning-title"; heading.textContent = t("dictExamplesTitle");
  const hint = document.createElement("p"); hint.className = "xp-dict-src xp-dict-examples-hint"; hint.textContent = t("dictExamplesHint");
  const row = document.createElement("div"); row.className = "xp-dict-usage-actions";
  const find = document.createElement("button"); find.type = "button"; find.className = "xp-dict-connect xp-dict-examples-find";
  const icon = document.createElement("span");
  icon.innerHTML = typeof PBP_ICONS === "object" ? PBP_ICONS.quote || "" : ""; // static shared icon
  const label = document.createElement("span"); label.textContent = t("dictExamplesFind");
  find.replaceChildren(...icon.childNodes, label);
  const box = document.createElement("div"); box.className = "xp-dict-usage-feedback"; box.toggleAttribute("data-live-empty", true);
  const status = document.createElement("p"); status.className = "xp-dict-msg xp-dict-usage-status";
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.setAttribute("aria-atomic", "true");
  box.appendChild(status); row.append(find, box);
  block.append(heading, hint, row);
  const origin = pbpDictEvidenceOrigin("literature", language);
  const negParts = { term: opts.term, sourceLanguage: language, target: "", category: "examples" };
  let busy = false, remembered = false;
  const alive = () => !opts.signal?.aborted && block.isConnected && opts.isCurrent() === true;
  // Neutral answers and progress speak politely in the status line; a
  // failure is an alert line right after the find button (plan 3.4).
  const say = (text, state = "") => {
    const error = state === "error" && !!text;
    _pbpDictActionError(find, error ? text : "");
    if (error) { text = ""; state = ""; }
    const tone = state === "neutral" ? state : "";
    _pbpDictLiveSay(box, value => _pbpDictToneText(status, value, tone), text);
    box.dataset.state = state;
  };
  const results = [];
  const show = examples => {
    results.forEach(node => node.remove()); results.length = 0;
    for (const example of examples) {
      const unit = document.createElement("div"); unit.className = "xp-dict-learning-item";
      const sentence = document.createElement("p"); sentence.className = "xp-dict-example";
      sentence.textContent = example.sentence; sentence.lang = language; sentence.dir = "auto";
      const note = document.createElement("p"); note.className = "xp-dict-src";
      const cite = [example.author, example.work, example.location].filter(Boolean).join(" · ");
      // Only a revision link on the language's own Wikisource becomes a link.
      if (typeof example.url === "string" && example.url.startsWith(origin + "/w/index.php?oldid=")) {
        const link = document.createElement("a"); link.href = example.url; link.target = "_blank"; link.rel = "noopener noreferrer";
        link.textContent = cite || example.url; note.appendChild(link);
      } else note.textContent = cite;
      if (example.truncated) note.append(" · " + t("dictExamplesTruncated"));
      note.append(" · " + t("dictSupplementSourceVerified"));
      unit.append(sentence, note); hint.before(unit); results.push(unit);
    }
  };
  if (!origin) {
    // An unsupported language is said up front and never remembered.
    hint.hidden = true; find.hidden = true;
    say(t("dictExamplesUnsupported"), "neutral");
    return { element: block, ready: Promise.resolve() };
  }
  // Plan 1C.4: the local memory is read before the action is shown, so the
  // block opens either on its ordinary action or on "last time not found ·
  // retry" with the retrieval copy -- never one replaced by the other.
  const setRemembered = value => {
    remembered = value;
    // Under the block's own heading the remembered action drops its name
    // (ruling 2026-10-28); the accessible name keeps it.
    label.textContent = value ? t("dictNegRetry") : t("dictExamplesFind");
    if (value) find.setAttribute("aria-label", t("dictExamplesFind") + " · " + t("dictNegRetry"));
    else find.removeAttribute("aria-label");
    if (value) find.dataset.remembered = "true"; else delete find.dataset.remembered;
    if (value) say(t("dictSupplementNoSources"), "neutral");
  };
  row.hidden = true;
  const ready = pbpDictNegHas(opts.owner, negParts).then(found => {
    if (!alive()) return;
    if (found && !busy && !results.length) setRemembered(true);
    row.hidden = false;
  });
  const run = async permission => {
    let granted = false;
    try { granted = await permission === true; }
    catch (error) { console.warn("[dict] examples permission request failed:", error?.name); }
    if (!alive()) return;
    if (!granted) { say(t("dictExamplesGrantNeeded"), "error"); return; }
    say(t("dictSupplementRetrieving"), "busy");
    try {
      const found = await pbpDictUsageExamplesFetch({ term: opts.term, sourceLanguage: language, owner: opts.owner,
        signal: opts.signal, isCurrent: alive, beforeRequest: async () => { if (!alive()) throw Object.assign(new Error("stale"), { code: "stale" }); } });
      if (!alive()) return;
      if (found?.unsupported === true) { find.hidden = true; hint.hidden = true; say(t("dictExamplesUnsupported"), "neutral"); return; }
      // A clean miss in a supported language is remembered for this account;
      // a found sentence forgets it. Failures, refusals and cancels never write.
      if (!found.length) { pbpDictNegRecord(opts.owner, negParts); say(t("dictExamplesNone"), "neutral"); return; }
      pbpDictNegForget(opts.owner, negParts);
      show(found); say("");
      // A shown result replaces its action: finding again is not needed.
      find.hidden = true; hint.hidden = true;
    } catch (error) {
      if (!alive() || error?.name === "AbortError" || error?.code === "stale") return;
      console.warn("[dict] original-text examples failed:", error?.name, typeof error?.code === "string" ? error.code : "request_failed");
      say(t(["owner_changed", "account_changed"].includes(error?.code) ? "vocabAccountChanged"
        : error?.code === "host_permission" ? "dictExamplesGrantNeeded" : "dictExamplesFailed"), "error");
    }
  };
  find.addEventListener("click", () => {
    if (busy || !alive()) return;
    busy = true; find.disabled = true;
    // No await before this call (see _pbpDictExamplesRequestOrigin).
    const permission = _pbpDictExamplesRequestOrigin(origin);
    // Retrying is this ordinary click; its own outcome replaces "last time".
    if (remembered) { setRemembered(false); say(""); }
    run(permission).finally(() => {
      busy = false;
      if (block.isConnected) find.disabled = false;
    });
  });
  return { element: block, ready };
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
  let origin = navigation && navigation.owner === _pbpDictOwner ? navigation :
    { cap, owner: _pbpDictOwner };
  const derived = cap.text !== origin.cap.text;
  const title = pop.querySelector(".xp-term");
  if (title) { title.textContent = cap.text; title.title = cap.text; }
  const cur = {
    runId, term: cap.text, queryTerm: cap.text, lang: "", gloss: "", lemma: "", ipa: "",
    sourceUrl: "", license: "", sentence: ctx.sentence || "", saved: false, aiExpanded: false,
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
  cur.updateContext = (nextCap, nextContext) => {
    if (!cur.isCurrent() || signal.aborted) return false;
    cap = nextCap; ctx = nextContext || {}; origin = { cap, owner: cur.owner };
    cur.sentence = ctx.sentence || "";
    cur.contextRevision = (cur.contextRevision || 0) + 1;
    const priorOrigin = pop.querySelector(".xp-dict-origin");
    priorOrigin?.remove();
    if (cur.meaningChoices?.length || cur.saved) {
      _pbpDictRefreshSave(pop, cur, signal).catch(error => console.warn("[dict] saved state read failed:", error?.name));
    }
    return true;
  };

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
  // The docked reader already identifies the word in its search field. Keep
  // its return action with the dictionary tools, including across reruns. The
  // head row holds only the query tools and this action; the AI entry keeps
  // its own actions in its block.
  const sessionHead = pop.classList.contains("reader-dict-session") ? pop.querySelector(":scope > .panel-head") : null;
  const returnToBubble = sessionHead && pop.querySelector(".reader-dict-return");
  if (returnToBubble) { head.appendChild(returnToBubble); sessionHead.hidden = true; }
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
  let installedLanguages = _pbpDictRefreshPackLangs(sel, languageLocale, true,
    () => !signal.aborted && _pbpDictCurrent === cur);
  cur.resolveContextLanguage = async (nextCap, nextContext) => {
    const manual = _pbpDictManualLang, languages = installedLanguages;
    const current = () => cur.isCurrent() && !signal.aborted && manual === _pbpDictManualLang && languages === installedLanguages;
    if (!current()) return null;
    try {
      const resolved = await _pbpDictResolveLang(nextCap, nextContext || {}, manual, languages);
      return current() ? resolved : null;
    } catch (error) {
      console.warn("[dict] context language read failed:", error?.name);
      return null;
    }
  };
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
  // The head names the looked-up word form; speech reads exactly that form,
  // whichever source or saved meaning sits below it (dict redesign 3.2).
  speak.addEventListener("click", () => pbpDictSpeak(cap.text, lang));
  cur.refreshLanguages = () => (installedLanguages = _pbpDictRefreshPackLangs(sel, languageLocale, true,
    () => !signal.aborted && _pbpDictCurrent === cur)).then(codes => {
      if (!signal.aborted && _pbpDictCurrent === cur && _pbpDictManualLang && !codes.includes(_pbpDictManualLang)) _pbpDictManualLang = "";
    });
  cur.meaningSources = new Map();
  // One column (dict redesign 3.1): head, dictionary results, then the AI
  // entry with its learning blocks and the card's metadata line.
  const aiHost = document.createElement("div"); slot.after(aiHost);
  const originalTerm = wrap.querySelector(".xp-dict-origin-term"); if (originalTerm) originalTerm.lang = lang || "und";
  // Free original-text examples sit between the usage points and the
  // etymology blocks, independent of the AI entry (plan 1C.2): no AI setting
  // gates them.
  cur.examples = pbpDictExamplesView({ term: cap.text, lang, owner: cur.owner, signal, isCurrent: cur.isCurrent });
  cur.ai = _pbpDictEntryMount(aiHost, { term: cap.text, lang, owner: cur.owner,
    signal, isCurrent: cur.isCurrent, settings: s, examples: cur.examples?.element,
    onSettingsChange: next => { if (cur.isCurrent()) pbpDictRun(cap, ctx, pop, ctrl, next, origin); },
    onLookup: term => cur.rerunWith(term),
    onEntry: (norm, record, content) => {
      cur.aiNorm = norm;
      _pbpDictReaderPackChoices(norm, content, cur, pop, signal);
    },
    // The AI block's state changed: expanded means its entry is on screen,
    // and only then does the save default come from it (Q14=A).
    onView: expanded => {
      if (cur.aiExpanded === expanded) return;
      cur.aiExpanded = expanded;
      _pbpDictApplyVisibleChoice(cur);
      _pbpDictSyncMeaningSelect(cur);
      _pbpDictRefreshSave(pop, cur, signal).catch(error => console.warn("[dict] saved state read failed:", error?.name));
    } });
  if (!cur.ai && cur.examples) aiHost.appendChild(cur.examples.element);

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
  cur.keptSaved = false;
  if (cur.packChoice) { _pbpDictApplyPackChoice(cur, cur.packChoice); return; }
  if (cur.packInvalidated) return;
  const sources = [...(cur.meaningSources?.values() || [])].filter(source => !source.norm.aiGenerated && source.choices.length);
  sources.sort((a, b) => a.box?.isConnected && b.box?.isConnected && a.box !== b.box
    ? (a.box.compareDocumentPosition(b.box) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1) : 0);
  // Q14=A: the expanded AI entry's first sense, otherwise the first
  // dictionary sense in display order.
  const norm = cur.aiExpanded ? cur.aiNorm : sources[0]?.norm || cur.dictionaryNorm;
  const choice = norm && pbpDictNormChoices({ ...norm,
    entries: pbpDictOrderForContext(norm.entries, cur.aiExpanded ? "" : cur.sentence) }, cur.lang, t("dictSource"))[0];
  // A word already in the vocabulary keeps its saved definition: no default
  // is applied for it (ruling 2026-10-28, as in the library), so the save bar
  // shows the "Definition to save" prompt and Update stays disabled until the
  // reader picks one. The saved word itself stays the target, so its saved
  // face (Learning | Known) and the commit gates still answer for it.
  // savedKeys is filled by _pbpDictRefreshSave's owner-gated read.
  if (choice && cur.savedKeys?.has(pbpDictVocabKey(cur.owner, choice.language || "und", choice.term))) {
    cur.keptSaved = true;
    Object.assign(cur, { term: choice.term, lang: choice.language, gloss: "", ipa: "", sourceUrl: "", license: "", lemma: "" });
  } else if (choice) _pbpDictApplyPackChoice(cur, choice);
  else {
    cur.fullEntryOnly = !cur.aiExpanded && [...(cur.meaningSources?.values() || [])].some(source => source.norm.hasFullEntry);
    Object.assign(cur, { term: cur.queryTerm || cur.term, gloss: "", ipa: "", sourceUrl: "", license: "", lemma: "" });
  }
}

// The save bar's meaning control (dict redesign 3.2): a plain-text preview of
// the definition Save would write, plus "Change" when there is another one to
// pick. The preview shows even when only one definition can be saved, so the
// user always sees what the button commits. The choice list is a click-opened
// popover (the reader allows no hover-triggered overlays), operable by
// keyboard; Escape or a choice returns focus to "Change".
// A choice's text in the save bar and its list: the card's title already
// names the looked-up word, so the word is repeated only when the choice
// saves a different one (a linked lemma, a shorter CC-CEDICT headword).
function _pbpDictChoiceLabel(cur, term, gloss) {
  return term && pbpDictNormalizeTerm(term) !== pbpDictNormalizeTerm(cur.queryTerm || "") ? term + " · " + gloss : gloss;
}

function _pbpDictSyncMeaningSelect(cur) {
  const bar = cur.meaningBar;
  if (!bar) return;
  const rows = [...cur.meaningSources.values()].flatMap(source => source.choices);
  cur.meaningChoices = rows;
  const selected = rows.findIndex(choice => choice.term === cur.term && choice.gloss === cur.gloss &&
    choice.sourceUrl === cur.sourceUrl && choice.license === cur.license);
  const preview = bar.querySelector(".xp-dict-save-preview"), change = bar.querySelector(".xp-dict-save-change");
  const shown = selected >= 0 ? rows[selected] : null;
  // The face names what Save writes: the applied choice, or the prompt when
  // there is none (a revoked source, a full entry only).
  if (cur.gloss) {
    preview.textContent = _pbpDictChoiceLabel(cur, cur.term, cur.gloss);
    preview.lang = shown?.definitionLang || "und";
    preview.removeAttribute("data-empty");
  } else {
    preview.textContent = t("vocabSaveDefinitionLabel");
    preview.removeAttribute("lang");
    preview.dataset.empty = "true";
  }
  preview.title = shown ? shown.gloss + " (" + shown.sourceLabel + ")" : preview.textContent;
  change.hidden = rows.length < 2 && selected >= 0;
  bar.hidden = !rows.length;
  const help = cur.meaningMenu.querySelector(".xp-dict-choice-help");
  help.textContent = t(selected < 0 ? cur.keptSaved ? "dictMeaningSavedHelp" : "dictMeaningChooseHelp"
    : cur.packChoice ? "dictMeaningManualHelp" : "dictMeaningDefaultHelp");
  const list = cur.meaningMenu.querySelector(".xp-dict-save-options");
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.index : null;
  list.replaceChildren();
  rows.forEach((choice, index) => {
    const option = document.createElement("div");
    option.className = "xp-dict-save-option";
    option.setAttribute("role", "option");
    option.tabIndex = -1;
    option.dataset.index = String(index);
    option.setAttribute("aria-selected", String(index === selected));
    option.lang = choice.definitionLang;
    const body = document.createElement("span"); body.className = "xp-dict-choice-text"; body.textContent = _pbpDictChoiceLabel(cur, choice.term, choice.gloss);
    const source = document.createElement("span"); source.className = "xp-dict-choice-source"; source.textContent = choice.sourceLabel;
    option.append(body, source);
    list.appendChild(option);
  });
  if (cur.meaningMenuOpen()) {
    if (!rows.length || bar.hidden) cur.meaningMenuClose(false);
    else if (focused !== null) (list.children[Math.min(Number(focused), rows.length - 1)] || list.firstElementChild)?.focus({ preventScroll: true });
  }
}

// Fixed placement for the choice list: across the card's content box -- its
// left and right edges on the card's (the bubble's inner edges, or the docked
// panel's text column), so it never hangs past the card -- above "Change"
// (the bar sits at the bottom of the card), below it when the room above is
// too small, and kept 16px inside the viewport vertically either way.
function _pbpDictPlaceMeaningMenu(menu, anchor, frame) {
  const vw = document.documentElement.clientWidth || window.innerWidth, vh = window.innerHeight;
  const f = frame.getBoundingClientRect(), cs = getComputedStyle(frame);
  const inset = side => (parseFloat(cs["border" + side + "Width"]) || 0) + (parseFloat(cs["padding" + side]) || 0);
  // Whole CSS pixels: fractional rects would smear the 1px border and text
  // across device pixels at 125% / 150% zoom.
  const left = Math.round(Math.max(0, f.left + inset("Left"))), right = Math.round(Math.min(vw, f.right - inset("Right")));
  menu.style.left = left + "px";
  menu.style.width = Math.max(0, right - left) + "px";
  // Measured after the width is set: the height follows the wrapped text.
  const a = anchor.getBoundingClientRect(), m = menu.getBoundingClientRect();
  const above = a.top - m.height - 8, below = a.bottom + 8;
  const top = above >= 16 ? above : below + m.height <= vh - 16 ? below : Math.max(16, vh - 16 - m.height);
  menu.style.top = Math.round(Math.max(16, top)) + "px";
}

function _pbpDictMountMeaningBar(cur, pop, box, signal) {
  const bar = document.createElement("div");
  bar.className = "xp-dict-save-meaning";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", t("vocabSaveDefinitionLabel"));
  const preview = document.createElement("span");
  preview.className = "xp-dict-save-preview";
  preview.id = "xp-dict-save-preview-" + cur.runId;
  const change = document.createElement("button");
  change.type = "button";
  change.className = "xp-dict-connect xp-dict-save-change";
  change.textContent = t("dictMeaningChange");
  change.setAttribute("aria-haspopup", "listbox");
  change.setAttribute("aria-expanded", "false");
  change.setAttribute("aria-describedby", preview.id);
  bar.append(preview, change);
  const menu = document.createElement("div");
  menu.className = "pop-panel xp-dict-save-menu";
  menu.id = "xp-dict-save-menu-" + cur.runId;
  menu.setAttribute("popover", "auto");
  const help = document.createElement("div"); help.className = "xp-dict-choice-help"; help.id = menu.id + "-help";
  const list = document.createElement("div");
  list.className = "xp-dict-save-options";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", t("vocabSaveDefinitionLabel"));
  list.setAttribute("aria-describedby", help.id);
  menu.append(help, list);
  change.setAttribute("aria-controls", menu.id);
  cur.meaningBar = bar; cur.meaningMenu = menu;
  const host = pop.querySelector(".xp-foot") || box;
  host.prepend(bar); bar.after(menu);
  const isOpen = () => { try { return menu.matches(":popover-open"); } catch (_) { return false; } };
  const close = (restoreFocus) => {
    if (isOpen()) { try { menu.hidePopover(); } catch (_) {} }
    change.setAttribute("aria-expanded", "false");
    if (restoreFocus && !change.hidden) change.focus({ preventScroll: true });
  };
  cur.meaningMenuOpen = isOpen;
  cur.meaningMenuClose = close;
  const place = () => { if (isOpen()) _pbpDictPlaceMeaningMenu(menu, change, pop); };
  window.addEventListener("resize", place);
  signal.addEventListener("abort", () => {
    window.removeEventListener("resize", place);
    close(false); bar.remove(); menu.remove();
  }, { once: true });
  menu.addEventListener("beforetoggle", e => {
    change.setAttribute("aria-expanded", String(e.newState === "open"));
    // Never leave focus inside a closing list, whatever closed it.
    if (e.newState === "closed" && menu.contains(document.activeElement) && !change.hidden) change.focus({ preventScroll: true });
  });
  change.addEventListener("click", () => {
    if (signal.aborted || _pbpDictCurrent !== cur) return;
    if (isOpen()) { close(true); return; }
    _pbpDictSyncMeaningSelect(cur);
    try { menu.showPopover(); } catch (_) { return; }
    change.setAttribute("aria-expanded", "true");
    _pbpDictPlaceMeaningMenu(menu, change, pop);
    (list.querySelector('[aria-selected="true"]') || list.firstElementChild)?.focus({ preventScroll: true });
  });
  const choose = (option) => {
    const choice = cur.meaningChoices[Number(option.dataset.index)];
    if (signal.aborted || _pbpDictCurrent !== cur || !choice) return;
    cur.packChoice = choice; cur.packInvalidated = false;
    _pbpDictApplyPackChoice(cur, choice);
    cur.packRevision = (cur.packRevision || 0) + 1;
    _pbpDictSyncMeaningSelect(cur);
    close(true);
    if (change.hidden) pop.querySelector(".xp-vocab:not([hidden])")?.focus({ preventScroll: true });
    _pbpDictRefreshSave(pop, cur, signal).catch(error => console.warn("[dict] saved state read failed:", error?.name));
  };
  list.addEventListener("click", e => {
    const option = e.target?.closest?.(".xp-dict-save-option");
    if (option && list.contains(option)) choose(option);
  });
  list.addEventListener("keydown", e => {
    const options = [...list.querySelectorAll(".xp-dict-save-option")];
    const at = options.indexOf(document.activeElement);
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(options.length - 1, at + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, at - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    else if ((e.key === "Enter" || e.key === " ") && at >= 0) { e.preventDefault(); choose(options[at]); return; }
    else if (e.key === "Escape") {
      // Handled here, not left to the popover's light dismiss: the reader's
      // own Escape listeners would otherwise close the card or the panel.
      e.preventDefault(); e.stopPropagation(); close(true); return;
    } else if (e.key === "Tab") { close(false); return; }
    if (next < 0) return;
    e.preventDefault();
    options[next]?.focus({ preventScroll: true });
  });
}

function _pbpDictApplyPackChoice(cur, choice) {
  Object.assign(cur, { fullEntryOnly: false, keptSaved: false, term: choice.term, lang: choice.language, gloss: choice.gloss,
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
  if (!cur.meaningBar) _pbpDictMountMeaningBar(cur, pop, box, signal);
  _pbpDictApplyVisibleChoice(cur);
  _pbpDictSyncMeaningSelect(cur);
  _pbpDictRefreshSave(pop, cur, signal).catch(error => console.warn("[dict] saved state read failed:", error?.name));
}

async function _pbpDictRefreshSave(pop, cur, signal) {
  const vocabBtn = pop.querySelector(".xp-vocab"), runId = cur.runId, choice = cur.packChoice;
  const contextRevision = cur.contextRevision || 0;
  if (signal.aborted || _pbpDictCurrent !== cur) return;
  cur.saved = false; cur.savedRecord = null;
  // A saved word waiting for an explicit choice (ruling 2026-10-28) cannot be
  // updated with nothing picked.
  const blocked = () => !!cur.fullEntryOnly || !!cur.packInvalidated || !!cur.keptSaved;
  if (vocabBtn) {
    vocabBtn.dataset.contextRevision = String(contextRevision);
    vocabBtn.dataset.packRevision = String(cur.packRevision || 0);
    vocabBtn.hidden = false; vocabBtn.disabled = blocked();
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
    const key = pbpDictVocabKey(cur.owner, cur.lang || "und", cur.term);
    // runId is shared by the whole lookup, so reads started for different
    // head words in one run cannot cancel each other that way: number them,
    // and let only the newest read (for the current key) paint.
    const readSeq = cur.saveReadSeq = (cur.saveReadSeq || 0) + 1;
    const hit = await pbpVocabGet(key);
    if (cur.saveReadSeq !== readSeq || pbpDictVocabKey(cur.owner, cur.lang || "und", cur.term) !== key) return;
    if (signal.aborted || _pbpDictCurrent !== cur || cur.packChoice !== choice ||
        (cur.contextRevision || 0) !== contextRevision || vocabBtn.dataset.runId !== String(runId)) return;
    if (cur.owner !== _pbpDictOwner) { vocabBtn.disabled = false; return; } // switch landed during the read
    // What this owner has saved decides the default (ruling 2026-10-28): a
    // saved word gets none, a word deleted meanwhile gets Q14=A's again. The
    // term stays the same either way, so this read still answers for it.
    const savedKeys = cur.savedKeys || (cur.savedKeys = new Set());
    const had = savedKeys.has(key);
    if (hit) savedKeys.add(key); else savedKeys.delete(key);
    if (!cur.packChoice && had !== !!hit) { _pbpDictApplyVisibleChoice(cur); _pbpDictSyncMeaningSelect(cur); }
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
      // Waiting for a choice (ruling 2026-10-28), Update stays on screen,
      // disabled (below), while some definition on offer would change the
      // record: it shows what picking one enables. When none would, there is
      // nothing to update, as before.
      const adds = cur.keptSaved
        ? (cur.meaningChoices || []).some(c => c.language !== cur.lang ||
            pbpDictNormalizeTerm(c.term) !== pbpDictNormalizeTerm(cur.term) ||
            _pbpDictLookupAddsTo(hit, { ...cur, gloss: c.gloss, ipa: c.ipa, lemma: "" }))
        : _pbpDictLookupAddsTo(hit, cur);
      if (shown && !adds) {
        vocabBtn.hidden = true;
      } else if (typeof _pbpExplainIconBtn === "function") {
        _pbpExplainIconBtn(vocabBtn, shown ? "" : PBP_ICONS.refresh, t("dictUpdateVocab"), shown ? t("update") : "");
        if (shown) vocabBtn.dataset.face = "update";
      } else {
        vocabBtn.textContent = t("dictUpdateVocab");
      }
    }
    vocabBtn.disabled = blocked();
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
  const contextRevision = cur?.contextRevision || 0;
  if (!cur || !cur.term || cur.fullEntryOnly) return false;
  if (cur.keptSaved) return false; // a saved word is updated only with an explicit choice
  if (cur.owner !== _pbpDictOwner) return false; // owner re-check at commit time (invariant)
  // What the saved-state read below is about to check. A late source can swap
  // the default selection (term/gloss) during any await; the write must go
  // out under the identity that was actually checked.
  const checkedKey = pbpDictVocabKey(cur.owner, cur.lang || "und", cur.term), checkedGloss = cur.gloss;
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
  // A saved word keeps its definition until the reader picks one (ruling
  // 2026-10-28). The display read in _pbpDictRefreshSave may still be pending
  // when Save is clicked -- keptSaved is then false and Q14=A's default is
  // applied -- so without an explicit choice the commit asks the vocabulary
  // itself. A failed read refuses (fail-closed).
  if (!cur.packChoice && typeof pbpVocabGet === "function") {
    let saved;
    try { saved = await pbpVocabGet(checkedKey); }
    catch (error) { console.warn("[dict] saved state read failed:", error?.name); return false; }
    if (saved) return false;
  }
  // A reused lookup can acquire another selection during the owner read.
  // Never pair the earlier highlight target with the later sentence.
  if (cur.fullEntryOnly || cur.packInvalidated || cur.keptSaved || (cur.packRevision || 0) !== packRevision ||
      (cur.contextRevision || 0) !== contextRevision ||
      pbpDictVocabKey(cur.owner, cur.lang || "und", cur.term) !== checkedKey || cur.gloss !== checkedGloss) return false;
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
    if (_pbpDictCurrent === cur && (cur.contextRevision || 0) === contextRevision &&
        (cur.packRevision || 0) === packRevision) {
      cur.saved = true; cur.savedRecord = entry;
    }
    try {
      document.dispatchEvent(new CustomEvent("pbp:vocab-changed", { detail: { owner: cur.owner } }));
    } catch (_) {}
    return true;
  }
  return false;
}
window.pbpDictSaveCurrent = pbpDictSaveCurrent;
window.pbpDictSetSaveTarget = (tgt) => { _pbpDictSaveTarget = tgt || null; };
window.pbpDictCurrentIdentity = () => {
  const cur = _pbpDictCurrent;
  return cur?.isCurrent?.() && !_pbpDictChildCtrl?.signal.aborted
    ? { term: cur.queryTerm || cur.term, language: cur.lang, owner: cur.owner } : null;
};
window.pbpDictResolveContextLanguage = async (cap, ctx) => {
  const cur = _pbpDictCurrent;
  if (!cur?.isCurrent?.() || _pbpDictChildCtrl?.signal.aborted || !cap ||
      pbpDictNormalizeTerm(cap.text) !== pbpDictNormalizeTerm(cur.queryTerm || cur.term)) return null;
  return typeof cur.resolveContextLanguage === "function" ? cur.resolveContextLanguage(cap, ctx) : null;
};
window.pbpDictUpdateContext = (cap, ctx) => {
  const cur = _pbpDictCurrent;
  if (!cur?.isCurrent?.() || _pbpDictChildCtrl?.signal.aborted || cur.owner !== _pbpDictOwner ||
      !cap || pbpDictNormalizeTerm(cap.text) !== pbpDictNormalizeTerm(cur.queryTerm || cur.term)) return false;
  if (!cur.updateContext?.(cap, ctx)) return false;
  _pbpDictSaveTarget = cap.itemId ? { itemId: cap.itemId } : cap.range ? { range: cap.range } : null;
  return true;
};
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
