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

// Non-secret owner scope for vocab records: "acct_<encoded username>" or
// "ownerless". Must stay format-identical to md-ai-core.js's _pbpTrOwnerScope
// (same value domain: preview writes, options reads).
function pbpDictOwnerScope(account) {
  return account ? "acct_" + encodeURIComponent(String(account)) : "ownerless";
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
// success to the UI. Account-isolation boundary (Codex HIGH 3): the delete
// re-reads the record inside the SAME transaction and refuses to delete
// (resolving false, no throw) when its owner doesn't match expectedOwner --
// a stale/forged id must never let one account erase another's vocab.
async function pbpVocabDelete(id, expectedOwner) {
  try {
    const db = await _pbpVocabOpenDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(_PBP_VOCAB_STORE, "readwrite");
      const store = tx.objectStore(_PBP_VOCAB_STORE);
      let allowed = true;
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if (rec && rec.owner !== expectedOwner) allowed = false;
        else store.delete(id);
      };
      tx.oncomplete = () => resolve(allowed);
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

// ---- Pronunciation (speechSynthesis + click-token guard) ----------------
const PBP_DICT_SPEAKER_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';

// Static inline SVG (Feather book-open). Constant string, never model text.
// Consumed by the highlight selection bar's dictionary button (md-highlight.js).
const PBP_DICT_BOOK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';

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
    const pick = () => {
      if (spoken || token !== _pbpDictSpeakSeq) return;
      spoken = true;
      if (primary) {
        const vs = synth.getVoices();
        const v = vs.find((x) => x.lang && x.lang.toLowerCase().startsWith(primary));
        if (v) u.voice = v;
      }
      synth.speak(u);
    };
    if (synth.getVoices().length) { pick(); return; }
    synth.addEventListener("voiceschanged", pick, { once: true });
    setTimeout(pick, 400);
  } catch (_) {}
}

// ---- Dictionary slot ----------------------------------------------------
async function _pbpDictHasPerm() {
  try { return await chrome.permissions.contains({ origins: [PBP_DICT_ORIGIN + "/*"] }); } catch (_) { return false; }
}

// Child signal = parent abort OR timeout (no AbortSignal.any: Chrome floor 110).
function _pbpDictChildSignal(parent, ms) {
  const c = new AbortController();
  const onAbort = () => c.abort();
  if (parent) {
    if (parent.aborted) c.abort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => c.abort(), ms);
  return {
    signal: c.signal,
    done: () => { clearTimeout(timer); if (parent) parent.removeEventListener("abort", onAbort); }
  };
}

async function _pbpDictFetch(lang, term, parentSignal) {
  const child = _pbpDictChildSignal(parentSignal, 8000);
  try {
    const res = await fetch(
      PBP_DICT_ORIGIN + "/api/v1/entries/" + encodeURIComponent(lang) + "/" + encodeURIComponent(term),
      { signal: child.signal }
    );
    if (res.status === 404) return { status: 404, data: null };
    if (!res.ok) return { status: res.status, data: null };
    return { status: 200, data: await res.json() };
  } finally { child.done(); }
}

// External dictionary data renders through textContent ONLY.
function _pbpDictRenderEntry(slot, norm, term, lang) {
  slot.replaceChildren();
  for (const e of norm.entries) {
    const ent = document.createElement("div");
    ent.className = "xp-dict-entry";
    if (e.ipas.length || e.pos) {
      const line = document.createElement("div");
      line.className = "xp-dict-ipa-line";
      if (e.pos) {
        const pos = document.createElement("span");
        pos.className = "xp-dict-pos";
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
          tag.textContent = p.tags.join(", ");
          line.appendChild(tag);
        }
      }
      ent.appendChild(line);
    }
    if (e.forms.length) {
      const forms = document.createElement("div");
      forms.className = "xp-dict-forms";
      forms.textContent = e.forms.map((f) => f.word + (f.tags.length ? " (" + f.tags.join(", ") + ")" : "")).join(" · ");
      ent.appendChild(forms);
    }
    if (e.senses.length) {
      const ol = document.createElement("ol");
      ol.className = "xp-dict-senses";
      for (const s of e.senses) {
        const li = document.createElement("li");
        li.textContent = s.definition;
        for (const x of s.examples) {
          const ex = document.createElement("div");
          ex.className = "xp-dict-example";
          ex.textContent = x;
          li.appendChild(ex);
        }
        ol.appendChild(li);
      }
      ent.appendChild(ol);
    }
    slot.appendChild(ent);
  }
  const src = document.createElement("div");
  src.className = "xp-dict-src";
  const label = document.createElement("span");
  label.textContent = t("dictSource") + " ";
  const a = document.createElement("a");
  a.href = norm.sourceUrl || ("https://" + (lang || "en") + ".wiktionary.org/wiki/" + encodeURIComponent(term));
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "Wiktionary · " + (norm.license || "CC BY-SA");
  src.appendChild(label);
  src.appendChild(a);
  slot.appendChild(src);
}

function _pbpDictSlotMsg(slot, text) {
  slot.replaceChildren();
  const p = document.createElement("div");
  p.className = "xp-dict-msg";
  p.textContent = text;
  slot.appendChild(p);
}

function _pbpDictSlotSkeleton(slot) {
  slot.replaceChildren();
  const sk = document.createElement("div");
  sk.className = "xp-skel";
  slot.appendChild(sk);
}

// perm? -> fetch -> 200 render / 404 wait-lemma -> refetch once / degrade.
// Returns normalized entry or null; the RUN layer merges into _pbpDictCurrent.
// onRerun: run-level restart used after a permission grant (never slot-local
// recursion — Codex HIGH 2).
async function _pbpDictSlotRun(slot, term, lang, parentSignal, lemmaPromise, onRerun) {
  if (!lang) { _pbpDictSlotMsg(slot, t("dictNoEntry")); return null; }
  const cacheKey = "dict_" + pbpDictCacheKeyPublic(lang, term);
  try {
    const hit = await pbpAiCacheGet(cacheKey);
    if (hit && hit.result) {
      _pbpDictRenderEntry(slot, hit.result, term, lang);
      return hit.result;
    }
  } catch (_) {}
  if (!(await _pbpDictHasPerm())) {
    slot.replaceChildren();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "xp-dict-connect";
    btn.textContent = t("dictConnect");
    const hint = document.createElement("div");
    hint.className = "xp-dict-msg";
    hint.textContent = t("dictConnectHint");
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      let granted = false;
      // FIRST await in the click chain must be the permission request.
      try { granted = await chrome.permissions.request({ origins: [PBP_DICT_ORIGIN + "/*"] }); } catch (_) {}
      if (!granted) { btn.disabled = false; return; }
      if (typeof onRerun === "function") onRerun(); // full-run restart merges results properly
    });
    slot.appendChild(btn);
    slot.appendChild(hint);
    return null;
  }
  _pbpDictSlotSkeleton(slot);
  let out;
  try {
    out = await _pbpDictFetch(lang, term, parentSignal);
  } catch (e) {
    if (parentSignal && parentSignal.aborted) return null;
    _pbpDictSlotMsg(slot, t("dictLoadFailed"));
    return null;
  }
  if (out.status === 404) {
    const lemma = await lemmaPromise; // resolved on ALL ctx-slot exits
    if (parentSignal && parentSignal.aborted) return null;
    if (pbpDictLemmaRetry(404, lemma, term, lang)) {
      let second;
      try { second = await _pbpDictFetch(lang, lemma.trim(), parentSignal); } catch (_) { second = { status: 0, data: null }; }
      if (parentSignal && parentSignal.aborted) return null;
      const norm2 = second.status === 200 ? pbpDictNormalizeEntry(second.data) : null;
      if (norm2) {
        _pbpDictRenderEntry(slot, norm2, lemma, lang);
        try { await pbpAiCacheSet("dict_" + pbpDictCacheKeyPublic(lang, lemma), norm2, Date.now()); } catch (_) {}
        return norm2;
      }
    }
    _pbpDictSlotMsg(slot, t("dictNoEntry"));
    return null;
  }
  if (out.status !== 200) { _pbpDictSlotMsg(slot, t("dictLoadFailed")); return null; }
  const norm = pbpDictNormalizeEntry(out.data);
  if (!norm) { _pbpDictSlotMsg(slot, t("dictNoEntry")); return null; }
  _pbpDictRenderEntry(slot, norm, term, lang);
  try { await pbpAiCacheSet(cacheKey, norm, Date.now()); } catch (_) {}
  return norm;
}

// ---- Contextual-gloss slot + run assembly -------------------------------
let _pbpDictRunSeq = 0;
let _pbpDictCurrent = null;      // merged results of the LIVE run only
let _pbpDictChildCtrl = null;    // the live run's own controller (child of md-ask's)
let _pbpDictParentCleanup = null; // removes the previous run's parent-abort listener
let _pbpDictSaveTarget = null;   // {itemId} | {range} | null — explain-shaped
let _pbpDictOwner = "ownerless"; // set from pbp:rendered detail.account (Task 8 listener)

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

// Sentence -> block -> article-lang ladder (spec §3; Codex HIGH 6).
async function _pbpDictResolveLang(cap, ctx, manual) {
  const view = document.getElementById("rendered-view");
  const articleLang = view ? (view.getAttribute("lang") || "") : "";
  if (pbpDictPrimaryLang(manual)) return pbpDictPrimaryLang(manual);
  const bySentence = await _pbpDictDetect(ctx.sentence || cap.text);
  const first = pbpDictRouteLang(bySentence.lang, bySentence.reliable, "", "");
  if (first) return first;
  const byBlock = await _pbpDictDetect(ctx.blockText || "");
  return pbpDictRouteLang(byBlock.lang, byBlock.reliable, articleLang, "");
}

// Whole function wrapped so EVERY exit resolves the lemma exactly once
// (Codex HIGH 4) and no pre-try throw can hang the dictionary slot's 404 wait.
async function _pbpDictCtxRun(el, cap, ctx, s, signal, resolveLemmaOnce, lang) {
  try {
    if (typeof pbpAiAvailable === "function" && !pbpAiAvailable(s)) {
      const msg = document.createElement("div");
      msg.className = "xp-dict-msg";
      msg.textContent = t("dictAiNotConfigured");
      el.replaceChildren(msg);
      return null; // finally resolves lemma
    }
    const langName = pbpExplainLangName(uiLangToBCP47());
    const title = document.getElementById("preview-title").textContent;
    const { system, prompt } = pbpDictBuildCtxPrompt({
      selection: cap.text, sentence: ctx.sentence, title, answerLang: langName
    });
    const provider = s.aiProvider || "gemini";
    const model = (typeof pbpAiEffectiveModel === "function" ? pbpAiEffectiveModel(s) : "") || "";
    const cacheKey = "dictctx_" + _pbpDictOwner + "_" + provider + "_" + model + "_"
      + pbpDictCacheKeyPublic(lang, cap.text) + "_" + pbpDictCtxHash(ctx.sentence + "␟" + title + "␟" + langName);
    const finish = (full) => {
      const parsed = pbpDictParseCtxAnswer(full);
      const md = document.createElement("div");
      md.className = "xp-md";
      md.innerHTML = renderMarkdown(parsed.gloss); // single sanitize point
      const tag = document.createElement("div");
      tag.className = "xp-dict-ailabel";
      tag.textContent = t("dictAiLabel") + " · " + provider;
      el.replaceChildren(md, tag);
      return parsed;
    };
    const hit = await pbpAiCacheGet(cacheKey).catch(() => null);
    if (hit && typeof hit.result === "string") {
      const parsed = finish(hit.result);
      resolveLemmaOnce(parsed.lemma);
      return parsed;
    }
    const streamEl = document.createElement("div");
    streamEl.className = "xp-stream";
    let started = false, pending = "", rafId = 0;
    const flush = () => { rafId = 0; streamEl.textContent = pbpDictStripLemmaLine(pending); };
    try {
      pbpAiBumpCounter("explain"); // dict shares the explain usage bucket
      const full = await callAIStream(s, prompt, {
        maxTokens: 512, model: pbpAiResolveModelOverride(s), system, signal
      }, (delta, acc) => {
        if (!started) { started = true; el.replaceChildren(streamEl); }
        pending = acc;
        if (!rafId) rafId = requestAnimationFrame(flush);
      });
      if (rafId) cancelAnimationFrame(rafId);
      const parsed = finish(full);
      try { await pbpAiCacheSet(cacheKey, full, Date.now()); } catch (_) {}
      resolveLemmaOnce(parsed.lemma);
      return parsed;
    } catch (e) {
      if (rafId) cancelAnimationFrame(rafId);
      if (e && e.name === "AbortError") return null;
      const wrap = document.createElement("div");
      wrap.className = "xp-error";
      const msg = document.createElement("p");
      msg.textContent = (e && e.message) || "Request failed";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "xp-retry";
      retry.textContent = t(e && e.code === "host_permission" ? "aiGrantRetry" : "explainErrRetry");
      retry.addEventListener("click", async () => {
        if (retry.disabled) return;
        retry.disabled = true;
        try {
          // First await in the click chain: pbpAiRetryWithPermission issues the
          // exact-origin permissions.request for host_permission errors, then
          // runs the retry callback (a full run-level rerun, never slot recursion
          // — Codex HIGH 2).
          const recovered = await pbpAiRetryWithPermission(e, s, async () => {
            if (_pbpDictCurrent && typeof _pbpDictCurrent.rerun === "function") _pbpDictCurrent.rerun();
          });
          if (!recovered) retry.disabled = false;
        } catch (_) { retry.disabled = false; }
      });
      wrap.appendChild(msg);
      wrap.appendChild(retry);
      el.replaceChildren(wrap);
      return null;
    }
  } finally {
    resolveLemmaOnce(""); // once-only resolver: no-op if already resolved
  }
}

const PBP_DICT_LANGS = ["auto", "en", "de", "fr", "es", "it", "pt", "nl", "ru", "pl", "ja", "ko", "zh"];

async function pbpDictRun(cap, ctx, pop, ctrl, s) {
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
  const cur = {
    runId, term: cap.text, lang: "", gloss: "", lemma: "", ipa: "",
    sourceUrl: "", license: "", sentence: ctx.sentence || "", saved: false,
    owner: _pbpDictOwner,
    rerun: () => { if (_pbpDictCurrent === cur) pbpDictRun(cap, ctx, pop, ctrl, s); }
  };
  _pbpDictCurrent = cur;

  const body = pop.querySelector(".xp-body");
  const wrap = document.createElement("div");
  wrap.className = "xp-dict";
  const head = document.createElement("div");
  head.className = "xp-dict-head";
  const sel = document.createElement("select");
  sel.className = "xp-dict-lang";
  sel.setAttribute("aria-label", t("dictLangAria"));
  for (const code of PBP_DICT_LANGS) {
    const o = document.createElement("option");
    o.value = code === "auto" ? "" : code;
    o.textContent = code === "auto" ? t("dictLangAuto") : code;
    sel.appendChild(o);
  }
  const speak = document.createElement("button");
  speak.type = "button";
  speak.className = "xp-dict-speak";
  speak.setAttribute("aria-label", t("dictSpeak")); // no title — a11y label only
  speak.innerHTML = PBP_DICT_SPEAKER_SVG; // static constant, never model text
  head.appendChild(sel);
  head.appendChild(speak);
  const slot = document.createElement("div");
  slot.className = "xp-dict-slot";
  const ctxEl = document.createElement("div");
  ctxEl.className = "xp-dict-ctx";
  wrap.appendChild(head);
  wrap.appendChild(slot);
  wrap.appendChild(ctxEl);
  body.replaceChildren(wrap);

  const manual = typeof s.dictLangManual === "string" ? s.dictLangManual : "";
  const lang = await _pbpDictResolveLang(cap, ctx, manual);
  if (signal.aborted || _pbpDictCurrent !== cur) return;
  cur.lang = lang;
  const effectiveLang = lang || "und"; // vocab identity: query and save agree (Codex HIGH 6)
  sel.value = PBP_DICT_LANGS.includes(lang) ? lang : "";
  sel.addEventListener("change", () => {
    const v = sel.value;
    s.dictLangManual = v;
    cur.rerun(); // abort old requests NOW; storage latency must not extend their life
    persistSettings({ dictLangManual: v }).then((r) => {
      if (!r || !r.ok) { /* in-memory value already applied; same swallow as _pbpExplainPersistTrigger */ }
    }).catch(() => {});
  });
  speak.addEventListener("click", () => pbpDictSpeak(cap.text, cur.lang));

  let lemmaSettled = false;
  let resolveLemmaRaw;
  const lemmaPromise = new Promise((r) => { resolveLemmaRaw = r; });
  const resolveLemmaOnce = (v) => { if (!lemmaSettled) { lemmaSettled = true; resolveLemmaRaw(v); } };

  // Vocab button: disabled until BOTH slots settle so a save is never empty
  // (Codex HIGH 3). dataset.runId guards stale promise writes.
  const vocabBtn = pop.querySelector(".xp-vocab");
  if (vocabBtn) {
    vocabBtn.hidden = false;
    vocabBtn.disabled = true;
    vocabBtn.dataset.runId = String(runId);
    vocabBtn.textContent = t("dictSaveVocab");
  }

  const results = await Promise.allSettled([
    _pbpDictSlotRun(slot, cap.text, lang, signal, lemmaPromise, cur.rerun),
    _pbpDictCtxRun(ctxEl, cap, ctx, s, signal, resolveLemmaOnce, lang)
  ]);
  if (signal.aborted || _pbpDictCurrent !== cur) return;
  const norm = results[0].status === "fulfilled" ? results[0].value : null;
  const parsed = results[1].status === "fulfilled" ? results[1].value : null;
  if (norm) {
    const first = norm.entries[0];
    cur.ipa = first && first.ipas[0] ? first.ipas[0].text : "";
    cur.sourceUrl = norm.sourceUrl;
    cur.license = norm.license;
    if (first && first.senses[0]) cur.gloss = first.senses[0].definition;
  }
  if (parsed) {
    if (parsed.gloss) cur.gloss = parsed.gloss;
    cur.lemma = parsed.lemma;
  }
  if (vocabBtn && vocabBtn.dataset.runId === String(runId)) {
    const hit = await pbpVocabGet(pbpDictVocabKey(cur.owner, effectiveLang, cap.text));
    if (_pbpDictCurrent !== cur || vocabBtn.dataset.runId !== String(runId)) return;
    if (hit) { cur.saved = true; vocabBtn.textContent = t("dictSavedVocab"); }
    vocabBtn.disabled = false;
  }
}
window.pbpDictRun = pbpDictRun;

async function pbpDictSaveCurrent() {
  const cur = _pbpDictCurrent;
  if (!cur || !cur.term) return false;
  if (cur.owner !== _pbpDictOwner) return false; // owner re-check at commit time (invariant)
  const urlEl = document.getElementById("preview-url");
  const titleEl = document.getElementById("preview-title");
  let highlightId = null;
  const target = _pbpDictSaveTarget;
  if (target && target.itemId) highlightId = target.itemId;                 // card path keeps its id
  else if (target && target.range && typeof window.pbpHlItemIdAtRange === "function") {
    try { highlightId = window.pbpHlItemIdAtRange(target.range) || null; } catch (_) {}
  }
  const entry = await pbpVocabSaveWord(cur.owner, {
    term: cur.term, lemma: cur.lemma, language: cur.lang || "und",
    gloss: cur.gloss, ipa: cur.ipa, sourceUrl: cur.sourceUrl, license: cur.license,
    context: {
      quote: cur.sentence, articleUrl: pbpDictSafeUrl(urlEl ? urlEl.href : ""),
      articleTitle: titleEl ? titleEl.textContent : "", highlightId, createdAt: Date.now()
    }
  });
  if (entry) {
    // The IDB write already happened -- report success unconditionally, even
    // if a newer dict run has since superseded `cur`. Only mutate the run's
    // own state when it is still the live one. The vocabulary list itself
    // lives in the options tab now (options-vocab.js); it rescans on its own
    // next activation, same as every other options panel.
    if (_pbpDictCurrent === cur) cur.saved = true;
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
document.addEventListener("pbp:rendered", (e) => {
  const account = e && e.detail ? e.detail.account : "";
  _pbpDictOwner = pbpDictOwnerScope(account);
});
