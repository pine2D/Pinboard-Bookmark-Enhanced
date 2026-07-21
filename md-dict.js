// ============================================================
// Pinboard Bookmark Enhanced - md-preview dictionary (P1)
// 查 (freedictionaryapi.com + LLM contextual gloss) / 听 (speechSynthesis)
// 存 (pbp-vocab IDB) / 导 (Anki TSV)
// ============================================================
// TOP SECTION IS PURE: no chrome.*, no DOM, no fetch — loadable from
// file:// test pages (same contract as md-translate.js's top section).
// Runtime layers live below the PURE END marker.

const PBP_DICT_ORIGIN = "https://freedictionaryapi.com";
const PBP_DICT_SENSE_CAP = 5;
const PBP_DICT_EXAMPLE_CAP = 2;
const PBP_DICT_FORM_CAP = 6;
const PBP_DICT_IPA_CAP = 3;

// "en-US" / "ZH_cn" -> "en" / "zh"; falsy -> "".
function pbpDictPrimaryLang(code) {
  const s = String(code || "").trim().toLowerCase();
  if (!s) return "";
  return s.split(/[-_]/)[0];
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

// Public cache key (dict_ raw dictionary data is public, shared across
// accounts): "{primary}|{normalized}".
function pbpDictCacheKeyPublic(lang, term) {
  const t = String(term || "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  return pbpDictPrimaryLang(lang) + "|" + t;
}

// Vocab identity (account-isolation invariant): "{owner}|{primary}|{normalized}".
// owner is the non-secret scope from _pbpTrOwnerScope ("acct_..." / "ownerless").
function pbpDictVocabKey(owner, lang, term) {
  return (owner || "ownerless") + "|" + pbpDictCacheKeyPublic(lang, term);
}

// Only http/https may reach an href (external data must not smuggle
// javascript:/data: URLs past the extension CSP).
function pbpDictSafeUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return (u.protocol === "https:" || u.protocol === "http:") ? u.href : "";
  } catch (_) { return ""; }
}

// Lemma retry decision: 404 + a different lemma (after normalization) -> true.
function pbpDictLemmaRetry(status, lemma, term, lang) {
  if (status !== 404) return false;
  if (!lemma || lemma === "-") return false;
  return pbpDictCacheKeyPublic(lang, lemma) !== pbpDictCacheKeyPublic(lang, term);
}

// freedictionaryapi.com response -> internal render model. null when nothing
// renderable (zh returns {entries:[]}). Field-by-field copies only.
function pbpDictNormalizeEntry(json) {
  if (!json || !Array.isArray(json.entries) || !json.entries.length) return null;
  const entries = [];
  for (const e of json.entries) {
    if (!e || typeof e !== "object") continue;
    const ipas = [];
    for (const p of Array.isArray(e.pronunciations) ? e.pronunciations : []) {
      if (ipas.length >= PBP_DICT_IPA_CAP) break;
      if (p && p.type === "ipa" && typeof p.text === "string" && p.text) {
        ipas.push({ text: p.text, tags: Array.isArray(p.tags) ? p.tags.filter((x) => typeof x === "string") : [] });
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
      if (senses.length >= PBP_DICT_SENSE_CAP) break;
      if (!s || typeof s.definition !== "string" || !s.definition) continue;
      const examples = [];
      for (const x of Array.isArray(s.examples) ? s.examples : []) {
        if (examples.length >= PBP_DICT_EXAMPLE_CAP) break;
        if (typeof x === "string" && x) examples.push(x);
        else if (x && typeof x.text === "string" && x.text) examples.push(x.text);
      }
      senses.push({ definition: s.definition, examples });
    }
    if (ipas.length || senses.length || forms.length) {
      entries.push({ pos: typeof e.partOfSpeech === "string" ? e.partOfSpeech : "", ipas, forms, senses });
    }
  }
  if (!entries.length) return null;
  const src = json.source && typeof json.source === "object" ? json.source : {};
  const lic = src.license && typeof src.license === "object" ? src.license : {};
  return {
    word: typeof json.word === "string" ? json.word : "",
    entries,
    sourceUrl: pbpDictSafeUrl(src.url),
    license: typeof lic.name === "string" ? lic.name : ""
  };
}

// LEMMA-first-line protocol (spec §3). "LEMMA: -" or missing marker = none.
function pbpDictParseCtxAnswer(full) {
  const text = String(full || "");
  const m = text.match(/^\s*LEMMA:\s*(.*)\s*$/m);
  let lemma = "";
  if (m) {
    const v = m[1].trim();
    if (v && v !== "-") lemma = v;
  }
  const gloss = text.replace(/^\s*LEMMA:.*$/m, "").trim();
  return { lemma, gloss };
}

// Progressive-display helper: hide a complete LEMMA line, and hide the
// accumulator entirely while it is still a strict prefix of a LEMMA line
// ("L", "LE", ..., "LEMMA: ru" with no newline yet). Ordinary text like
// "Hello" or "AI" must pass through untouched.
function pbpDictStripLemmaLine(acc) {
  const s = String(acc || "");
  const firstLine = s.split("\n", 1)[0];
  if (s.indexOf("\n") === -1) {
    const marker = "LEMMA:";
    if (marker.startsWith(firstLine.trim()) && firstLine.trim() !== "") return "";
    if (firstLine.trim().startsWith(marker)) return "";
  }
  return s.replace(/^\s*LEMMA:.*$/m, "").replace(/^\s+/, "");
}

// djb2, base36 — context hash for the gloss cache key.
function pbpDictCtxHash(str) {
  let h = 5381;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Contextual-gloss prompt (spec §3): selection + host sentence + title ONLY.
function pbpDictBuildCtxPrompt(p) {
  const selection = String((p && p.selection) || "").slice(0, 400);
  const sentence = String((p && p.sentence) || "").slice(0, 1000);
  const title = String((p && p.title) || "(untitled)");
  const answerLang = (p && p.answerLang) || "English";
  const system = "You are a precise contextual dictionary embedded in an article reader. " +
    "Explain what the selected term means in this specific sentence, in " + answerLang + ". " +
    "The FIRST line of your answer must be exactly 'LEMMA: <dictionary base form of the selected term>' " +
    "(write 'LEMMA: -' if it is already the base form or has none). " +
    "Then a blank line, then 1-3 short sentences: the part of speech if known, and the sense the term carries in THIS sentence. " +
    "Do not output IPA or any phonetic transcription. Do not invent example sentences. No headings, no lists.";
  const parts = [];
  parts.push("Article title: " + title);
  if (sentence) parts.push("Sentence containing the term:\n" + sentence);
  parts.push("Selected term:\n" + selection);
  return { system, prompt: parts.join("\n\n") };
}

// contexts[] merge (spec §4.1): dedup by articleUrl+quote; fresh array.
function pbpDictMergeContext(contexts, ctx) {
  const list = Array.isArray(contexts) ? contexts.slice() : [];
  if (!ctx || !ctx.quote) return list;
  const dup = list.some((c) => c && c.articleUrl === ctx.articleUrl && c.quote === ctx.quote);
  if (!dup) list.push(ctx);
  return list;
}

// Anki CSV-style field quoting.
function pbpDictTsvField(v) {
  const s = String(v == null ? "" : v);
  if (/[\t\n\r"]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// TSV export (6 columns: Term/Reading/Definition/Context/Source/License).
function pbpDictTsv(rows) {
  const head = "#separator:Tab\n#html:false\n#columns:Term\tReading\tDefinition\tContext\tSource\tLicense\n";
  const body = (Array.isArray(rows) ? rows : []).map((r) => {
    const ctx = Array.isArray(r.contexts) ? r.contexts.filter(Boolean).join("\n") : String(r.contexts || "");
    return [r.term, r.reading, r.definition, ctx, r.source, r.license].map(pbpDictTsvField).join("\t");
  }).join("\n");
  return head + body + (body ? "\n" : "");
}

// ---- PURE END ----

// ---- Vocabulary store: OWN IndexedDB database (spec §4.1) ---------------
// NOT the ai-cache DB (vocab is permanent, never LRU'd, own version track).
// Account-isolation invariant: every record carries the non-secret owner
// scope and every read filters by it.
const _PBP_VOCAB_DB_NAME = "pbp-vocab";
const _PBP_VOCAB_DB_VERSION = 1;
const _PBP_VOCAB_STORE = "words";
let _pbpVocabDbPromise = null;

function _pbpVocabOpenDB() {
  if (_pbpVocabDbPromise) return _pbpVocabDbPromise;
  _pbpVocabDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(_PBP_VOCAB_DB_NAME, _PBP_VOCAB_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(_PBP_VOCAB_STORE)) {
        const store = db.createObjectStore(_PBP_VOCAB_STORE, { keyPath: "id" });
        store.createIndex("owner", "owner", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  _pbpVocabDbPromise.catch(() => { _pbpVocabDbPromise = null; });
  return _pbpVocabDbPromise;
}

async function pbpVocabGet(id) {
  try {
    const db = await _pbpVocabOpenDB();
    return await new Promise((resolve) => {
      const req = db.transaction(_PBP_VOCAB_STORE, "readonly").objectStore(_PBP_VOCAB_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_) { return null; }
}

async function pbpVocabAll(owner) {
  try {
    const db = await _pbpVocabOpenDB();
    const rows = await new Promise((resolve) => {
      const idx = db.transaction(_PBP_VOCAB_STORE, "readonly").objectStore(_PBP_VOCAB_STORE).index("owner");
      const req = idx.getAll(owner || "ownerless");
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return rows;
  } catch (_) { return []; }
}

// Transaction-complete semantics (Codex MEDIUM 3): resolve on tx.oncomplete,
// not on the request's onsuccess — a put that later aborts must not report
// success to the UI.
async function pbpVocabDelete(id) {
  try {
    const db = await _pbpVocabOpenDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(_PBP_VOCAB_STORE, "readwrite");
      tx.objectStore(_PBP_VOCAB_STORE).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onabort = () => resolve(false);
      tx.onerror = () => resolve(false);
    });
  } catch (_) { return false; }
}

async function pbpVocabSaveWord(owner, w) {
  try {
    const db = await _pbpVocabOpenDB();
    const scope = owner || "ownerless";
    const id = pbpDictVocabKey(scope, w.language, w.term);
    const now = Date.now();
    return await new Promise((resolve) => {
      const tx = db.transaction(_PBP_VOCAB_STORE, "readwrite");
      const store = tx.objectStore(_PBP_VOCAB_STORE);
      let result = null;
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const cur = getReq.result || {
          id, owner: scope,
          term: String(w.term || "").normalize("NFC").trim(),
          lemma: null, language: pbpDictPrimaryLang(w.language) || "und",
          gloss: "", ipa: null, sourceUrl: null, license: null,
          contexts: [], note: "", status: "new", createdAt: now, updatedAt: now
        };
        if (w.lemma && !cur.lemma) cur.lemma = String(w.lemma);
        if (w.gloss) cur.gloss = String(w.gloss); // latest lookup wins
        if (w.ipa && !cur.ipa) cur.ipa = String(w.ipa);
        // Attribution merges INDEPENDENTLY of IPA (a senses-only entry still
        // carries its CC BY-SA obligation — Codex HIGH 7).
        if (w.sourceUrl && !cur.sourceUrl) cur.sourceUrl = pbpDictSafeUrl(w.sourceUrl) || null;
        if (w.license && !cur.license) cur.license = String(w.license);
        cur.contexts = pbpDictMergeContext(cur.contexts, w.context);
        cur.updatedAt = now;
        store.put(cur);
        result = cur;
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => resolve(null);
      tx.onerror = () => resolve(null);
    });
  } catch (_) { return null; }
}
