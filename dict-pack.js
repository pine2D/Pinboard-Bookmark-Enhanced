// ============================================================
// Pinboard Bookmark Enhanced - dict-pack.js
// Offline CC-CEDICT Chinese dictionary pack. The user downloads the release
// from MDBG THEMSELVES (their page forbids scripted access) and imports the
// .gz/.txt via a file picker -- the extension makes zero network requests.
// Data: CC-CEDICT, CC BY-SA 4.0. Loaded statically by options.html; the
// reader (md-dict.js) lazy-injects this file on the first zh lookup.
// Pure helpers above PURE END load in tests/dict-pack-tests.html.
// ============================================================

// V1 line: 繁體 简体 [pin1 yin1] /sense/sense/
const PBP_CEDICT_LINE = /^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.+)\/\s*$/;

function pbpCedictParseLine(line) {
  const s = String(line == null ? "" : line).trim();
  if (!s || s.startsWith("#")) return null;
  const m = PBP_CEDICT_LINE.exec(s);
  if (!m) return null;
  const defs = m[4].split("/").filter(Boolean);
  if (!defs.length) return null;
  // Pinyin case is SEMANTIC (Wang2 vs wang2) -- never lowercase.
  return { trad: m[1], simp: m[2], pinyin: m[3], defs };
}

const PBP_PINYIN_MARKS = {
  a: "āáǎà", e: "ēéěè", i: "īíǐì", o: "ōóǒò", u: "ūúǔù", "ü": "ǖǘǚǜ",
  A: "ĀÁǍÀ", E: "ĒÉĚÈ", I: "ĪÍǏÌ", O: "ŌÓǑÒ", U: "ŪÚǓÙ", "Ü": "ǕǗǙǛ"
};

// Numbered syllable -> tone-marked (ni3 -> nǐ). Unconvertible syllables
// (xx5 markers, punctuation, already-marked) pass through untouched.
function _pbpCedictSyllable(raw) {
  const syl = raw.replace(/u:/g, "ü").replace(/U:/g, "Ü");
  if (/^xx5$/i.test(syl)) return raw; // CEDICT "no applicable pinyin" marker
  const m = /^([A-Za-züÜ]+)([0-5])$/.exec(syl);
  if (!m) return raw;
  const body = m[1], tone = Number(m[2]);
  if (tone === 0 || tone === 5) {
    // Neutral tone drops the digit only for real syllables (vowels, or the
    // erhua "r5"); anything else keeps its tag rather than losing it.
    return /^r$/i.test(body) || /[aeiouü]/i.test(body) ? body : raw;
  }
  const lower = body.toLowerCase();
  let idx = -1;
  if (lower.includes("a")) idx = lower.indexOf("a");
  else if (lower.includes("e")) idx = lower.indexOf("e");
  else if (lower.includes("ou")) idx = lower.indexOf("o");
  else {
    for (let i = body.length - 1; i >= 0; i--) {
      if (PBP_PINYIN_MARKS[body[i]]) { idx = i; break; }
    }
  }
  if (idx === -1) return raw;
  const marks = PBP_PINYIN_MARKS[body[idx]];
  return body.slice(0, idx) + (marks ? marks[tone - 1] : body[idx]) + body.slice(idx + 1);
}

function pbpCedictPinyinPretty(pinyin) {
  return String(pinyin == null ? "" : pinyin).trim().split(/\s+/).filter(Boolean)
    .map(_pbpCedictSyllable).join(" ");
}

// Selection -> longest-first prefix key sequence, capped at 16 CODE POINTS
// (Array.from, never UTF-16 slice -- astral Han chars are 2 units).
function pbpCedictLookupKeys(selection) {
  const cps = Array.from(String(selection == null ? "" : selection).normalize("NFC").trim());
  const capped = cps.slice(0, 16);
  const keys = [];
  for (let len = capped.length; len >= 1; len--) keys.push(capped.slice(0, len).join(""));
  return keys;
}

// rows (all CEDICT records for the matched key) -> md-dict's normalized
// entry contract. Every field present, empty arrays never omitted.
function pbpCedictEntryToNorm(rows, matched) {
  const entries = (Array.isArray(rows) ? rows : []).map((r) => ({
    pos: "",
    ipas: [{ text: pbpCedictPinyinPretty(r.pinyin), tags: ["Pinyin"] }],
    forms: r.trad !== r.simp
      ? [{ word: matched === r.trad ? r.simp : r.trad, tags: [matched === r.trad ? "simp" : "trad"] }]
      : [],
    senses: (r.defs || []).map((d) => ({ definition: d, examples: [] }))
  }));
  return {
    word: String(matched == null ? "" : matched),
    entries,
    sourceLabel: "CC-CEDICT",
    sourceUrl: "https://cc-cedict.org/wiki/",
    license: "CC BY-SA 4.0"
  };
}

// CRC32 (IEEE), accumulated chunk by chunk. This is a best-effort DIAGNOSTIC
// checksum for telling one imported file from another in the status line. It is
// 32 bits, so collisions exist: never use it for identity, licence or any
// enforcement decision.
const _PBP_CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function pbpCrc32Update(crc, bytes) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = (_PBP_CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function pbpCrc32Hex(crc) {
  return (crc >>> 0).toString(16).padStart(8, "0");
}

// Streaming line splitter over a (possibly gzip) ReadableStream. The
// TextDecoderStream handles UTF-8 across byte chunks; `carry` handles lines
// across text chunks. fatal:true rejects on invalid UTF-8 (wrong file).
// stats.bytes counts DECOMPRESSED bytes (capped by maxBytes; stored in meta).
// Pass a starting stats.crc to also accumulate a CRC32 over those same decoded
// bytes -- this is the only place that sees them, and doing it here costs no
// extra buffering (SubtleCrypto has no streaming digest, so a real hash would
// mean holding the whole file in memory).
// The line-length check runs BEFORE the yield too -- a 70KB line whose
// newline arrives in the same chunk must not slip through.
async function* pbpCedictLines(stream, gzip, stats, maxBytes) {
  stats = stats || { bytes: 0 };
  stats.bytes = 0;
  const cap = maxBytes || 64 * 1024 * 1024;
  const wantCrc = typeof stats.crc === "number";
  let text = stream;
  if (gzip) text = text.pipeThrough(new DecompressionStream("gzip"));
  text = text.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      stats.bytes += chunk.byteLength;
      if (stats.bytes > cap) throw new Error("CEDICT file too large");
      if (wantCrc) stats.crc = pbpCrc32Update(stats.crc, chunk);
      controller.enqueue(chunk);
    }
  }));
  text = text.pipeThrough(new TextDecoderStream("utf-8", { fatal: true }));
  let carry = "";
  for await (const chunk of text) {
    carry += chunk;
    let end;
    while ((end = carry.indexOf("\n")) !== -1) {
      // 65536 UTF-16 units (memory bound; NOT a byte-exact limit)
      if (end > 65536) throw new Error("CEDICT line too long");
      let line = carry.slice(0, end);
      carry = carry.slice(end + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      yield line;
    }
    // 65536 UTF-16 units (memory bound; NOT a byte-exact limit)
    if (carry.length > 65536) throw new Error("CEDICT line too long");
  }
  if (carry) yield carry.endsWith("\r") ? carry.slice(0, -1) : carry;
}

// ---- Minimal ZIP reader ---------------------------------------------------
// MDBG also publishes the release as a ZIP with ONE text entry. This parses
// the End-of-Central-Directory + central entries, picks the first file entry
// and returns its DECOMPRESSED byte stream (method 8 deflate via
// DecompressionStream("deflate-raw"), method 0 stored). CRC is not verified
// (the parser downstream rejects garbage anyway); zip64 and exotic methods
// are rejected with a clear error. Takes a Blob/File.
async function pbpPackZipTextStream(file) {
  const tailSize = Math.min(file.size, 65558); // EOCD = 22 bytes + max comment
  const tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("zip: no end record");
  const ed = new DataView(tail.buffer, tail.byteOffset + eocd);
  const count = ed.getUint16(10, true);
  const cdSize = ed.getUint32(12, true);
  const cdOfs = ed.getUint32(16, true);
  if (!count || cdOfs === 0xffffffff) throw new Error("zip: unsupported layout");
  const cd = new DataView(await file.slice(cdOfs, cdOfs + cdSize).arrayBuffer());
  let p = 0, chosen = null;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    const compSize = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOfs = cd.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    if (!name.endsWith("/") && !chosen) chosen = { method, compSize, localOfs };
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!chosen) throw new Error("zip: no file entry");
  if (chosen.compSize === 0xffffffff || chosen.localOfs === 0xffffffff) throw new Error("zip: zip64 unsupported");
  if (chosen.method !== 8 && chosen.method !== 0) throw new Error("zip: unsupported compression");
  const lh = new DataView(await file.slice(chosen.localOfs, chosen.localOfs + 30).arrayBuffer());
  if (lh.getUint32(0, true) !== 0x04034b50) throw new Error("zip: bad local header");
  const dataOfs = chosen.localOfs + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const raw = file.slice(dataOfs, dataOfs + chosen.compSize).stream();
  return chosen.method === 8 ? raw.pipeThrough(new DecompressionStream("deflate-raw")) : raw;
}

// ---- ECDICT (English -> Chinese) parse layer -----------------------------
// A reader for the ECDICT CSV field layout. The extension neither ships,
// fetches, points at, recommends nor validates the data: the user supplies the
// file. Design: docs/superpowers/specs/2026-07-30-ecdict-en-zh-pack-design-rev7
// plus its rev8 amendments.

// Resource ceilings. Policy caps anchored to the measured top rung (R3 =
// 181,921 entries / 11,128,429 B on ecdict.csv @ bc015ed2), NOT values derived
// from the format. Deliberately not reusing CC-CEDICT's 400,000.
const PBP_ECDICT_MAX_ENTRIES = 220000;
// 24 MiB, tightened from 32 after measurement: the widest-record fixture at
// 32 MiB peaked at 158 MiB of heap against a pre-registered 150 MiB budget.
// Still 2.26x the measured top rung (R3 = 10.61 MiB), so no real file is near it.
const PBP_ECDICT_MAX_PAYLOAD_BYTES = 24 * 1024 * 1024;
const PBP_ECDICT_MAX_BYTES = 96 * 1024 * 1024;
// Input boundaries. Observed maxima on that sample: line 12,504, word 100,
// translation 372. A record breaching WORD/KEY/TRANS counts as malformed; the
// ratio ceiling then rejects the file. An unclosed quote rejects immediately.
const PBP_ECDICT_MAX_MALFORMED_RATIO = 0.01;
const PBP_ECDICT_MAX_RECORD_UNITS = 65536;
const PBP_ECDICT_MAX_WORD_UNITS = 256;
const PBP_ECDICT_MAX_KEY_UNITS = 256;
const PBP_ECDICT_MAX_TRANS_UNITS = 4096;

const PBP_ECDICT_COLUMNS = Object.freeze([
  "word", "translation", "tag", "collins", "oxford", "frq", "bnc"
]);

// Must stay character-for-character the same rule as vocab-store's query
// identity -- pbpDictNormalizeTerm() followed by toLowerCase() -- and as the
// offline comparison script's norm(). If they drift, a row imports fine and can
// never be looked up. The `|| ""` coercion is copied verbatim rather than
// improved: `String(x == null ? "" : x)` reads better but disagrees on 0 and
// false, and "reads better" is not worth two subtly different identities.
function pbpEcdictKey(word) {
  return String(word || "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

// Quote-aware split of ONE physical line. ECDICT's phonetic column is quoted
// and contains commas, so split(",") mis-columns every such row. Returns null
// for an unclosed quote -- the caller must then reject the whole file rather
// than skip the line: without a safe record boundary, a continuation line can
// produce a phantom record that happens to satisfy the column count.
function pbpEcdictSplitLine(line) {
  const s = String(line == null ? "" : line);
  const out = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c !== '"') { cur += c; continue; }
      if (s[i + 1] === '"') { cur += '"'; i++; continue; }
      inQuote = false;
    } else if (c === '"') inQuote = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  if (inQuote) return null;
  out.push(cur);
  return out;
}

// Header -> column index map. Required names must each appear EXACTLY once;
// a duplicate or a missing name rejects the file (returns null) rather than
// silently reading the wrong column when upstream adds one.
function pbpEcdictParseHeader(line) {
  // A UTF-8 BOM turns the first column name into "\uFEFFword", which matches
  // nothing and rejects the whole file as "header missing or ambiguous". Any
  // round-trip through a spreadsheet adds one.
  const fields = pbpEcdictSplitLine(String(line == null ? "" : line).replace(/^\uFEFF/, ""));
  if (!fields) return null;
  const names = fields.map((f) => f.trim());
  const idx = { _count: names.length };
  for (const want of PBP_ECDICT_COLUMNS) {
    const hits = [];
    names.forEach((n, i) => { if (n === want) hits.push(i); });
    if (hits.length !== 1) return null;
    idx[want] = hits[0];
  }
  return idx;
}

// Strict integer. parseInt would accept "12abc" and silently rank a junk row.
function pbpEcdictInt(v) {
  const s = String(v == null ? "" : v).trim();
  return /^\d+$/.test(s) ? Number(s) : 0;
}

// Literal backslash-n, not a real newline: ECDICT writes "n. 罩\nv. 覆盖".
// Splitting into separate senses is required -- substituting a real newline
// renders as a space, because .xp-dict-senses li is white-space: normal.
function pbpEcdictSenses(translation) {
  return String(translation == null ? "" : translation)
    .split("\\n").map((s) => s.trim()).filter(Boolean);
}

// Cumulative, strictly monotone rungs: R1 subset of R2 subset of R3. Widening
// must only ever add. (R2 and R3 as two parallel "orthogonal signal" sets was
// the rev5 bug: switching between them dropped 11,552 words.)
function pbpEcdictRungOk(row, rung) {
  const base = row.tag !== "" ||
    (row.collins !== "" && row.collins !== "0") ||
    (row.oxford !== "" && row.oxford !== "0") ||
    (row.frq > 0 && row.frq <= 50000) ||
    (row.bnc > 0 && row.bnc <= 50000);
  if (base) return true;
  if (rung === "R1") return false;
  if (!row.clean) return false;
  if (row.hasExchange) return true;              // R2
  return rung === "R3" && row.hasDefinition;     // R3 adds to R2, never replaces
}

// A row worth keeping at all, independent of rung. The third condition is not
// redundant: trim("\\n") is non-empty yet splits into zero senses, which would
// store a headword with nothing to render.
function pbpEcdictBaseOk(key, translation) {
  return !!key && String(translation).trim() !== "" && pbpEcdictSenses(translation).length > 0;
}

const _PBP_ECDICT_AFFIX = /^['’-]|['’-]$/;

// "clean" gates the R2/R3 widening: a real English headword with a real gloss.
// All THREE parts matter. Dropping the web-only test admitted 200 extra rows at
// both rungs on the fixed sample -- entries whose whole gloss is scraped
// "[网络]" fragments, which is what the rung was meant to exclude.
function pbpEcdictClean(word, senses) {
  if (/\s/.test(word) || _PBP_ECDICT_AFFIX.test(word)) return false;
  return !(senses.length > 0 && senses.every((s) => s.startsWith("[网络]")));
}

// One physical line -> { ok, record } | { ok:false, fatal } | { ok:false, malformed }
// `fatal` rejects the whole file; `malformed` only counts toward the ratio.
function pbpEcdictParseRow(line, idx, rung) {
  if (String(line).length > PBP_ECDICT_MAX_RECORD_UNITS) return { ok: false, malformed: true };
  const f = pbpEcdictSplitLine(line);
  if (!f) return { ok: false, fatal: "unclosed-quote" };
  if (f.length !== idx._count) return { ok: false, malformed: true };
  const word = f[idx.word].trim();
  const translation = f[idx.translation].trim();
  const key = pbpEcdictKey(word);
  if (word.length > PBP_ECDICT_MAX_WORD_UNITS) return { ok: false, malformed: true };
  if (key.length > PBP_ECDICT_MAX_KEY_UNITS) return { ok: false, malformed: true };
  if (translation.length > PBP_ECDICT_MAX_TRANS_UNITS) return { ok: false, malformed: true };
  if (!pbpEcdictBaseOk(key, translation)) return { ok: false, skip: true };
  const row = {
    tag: f[idx.tag].trim(),
    collins: f[idx.collins].trim(),
    oxford: f[idx.oxford].trim(),
    frq: pbpEcdictInt(f[idx.frq]),
    bnc: pbpEcdictInt(f[idx.bnc]),
    clean: pbpEcdictClean(word, pbpEcdictSenses(translation)),
    hasExchange: idx.exchange !== undefined && (f[idx.exchange] || "").trim() !== "",
    hasDefinition: idx.definition !== undefined && (f[idx.definition] || "").trim() !== ""
  };
  if (!pbpEcdictRungOk(row, rung)) return { ok: false, skip: true };
  // Stored shape is exactly three fields. tag/exchange/definition decided
  // admission and are then discarded -- no consumer, so no reason to occupy
  // rows forever (an exam-tag badge would justify a re-import, not a column).
  return { ok: true, record: { key, word, translation } };
}

// The one payload definition. Any acceptance gate that quotes a byte figure
// must use this and nothing else; rev5 quietly added 16 bytes per record and
// every quoted size in the spec was wrong for two revisions.
//
// pbpEcdictRecordBytes is the per-record form, and the import path accumulates
// with it while parsing. Running the whole thing as one pass afterwards was
// measured pushing a 31 MB encode into a single task.
function pbpEcdictRecordBytes(r, enc) {
  const e = enc || new TextEncoder();
  return e.encode(r.key).length + e.encode(r.word).length + e.encode(r.translation).length;
}

function pbpEcdictPayloadBytes(records) {
  const enc = new TextEncoder();
  let n = 0;
  for (const r of records) n += pbpEcdictRecordBytes(r, enc);
  return n;
}

// rows -> md-dict's normalized entry contract. Chinese is an ADDITIONAL block:
// the online chain still runs, so this never claims the IPA/forms/source that
// the network entry owns.
function pbpEcdictEntryToNorm(rows, matched) {
  const entries = (Array.isArray(rows) ? rows : []).map((r) => ({
    pos: "",
    ipas: [],
    forms: [],
    senses: pbpEcdictSenses(r.translation).map((d) => ({
      definition: d, examples: [], tags: [], synonyms: [], antonyms: [], subsenses: []
    }))
  })).filter((e) => e.senses.length);
  return {
    word: String(matched == null ? "" : matched),
    entries,
    sourceLabel: "ECDICT",
    sourceUrl: "",
    license: ""
  };
}

// ---- PURE END ----

// ---- IDB layer (DB pbp-dict-packs) --------------------------------------
const _PBP_PACK_DB = "pbp-dict-packs";
const _PBP_PACK_STORE = "cedict";
const _PBP_ECDICT_STORE = "ecdict";
const _PBP_PACK_META = "packs";
const _PBP_PACK_VERSION = 2;
let _pbpPackDbPromise = null;
// Set when a stale page holding the old JS meets a database another tab already
// upgraded. Reopening at the old version yields VersionError, which no amount of
// retrying fixes -- only reloading the page does. Callers surface it as such.
let _pbpPackStale = false;

function pbpPackIsStale() { return _pbpPackStale; }

function _pbpPackOpenDB() {
  if (_pbpPackDbPromise) return _pbpPackDbPromise;
  _pbpPackDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(_PBP_PACK_DB, _PBP_PACK_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      // Version-guarded and additive. Creating an existing store throws
      // ConstraintError and rolls the whole upgrade back, so `oldVersion < 1`
      // must not run for a v1 user; conversely a fresh install has to run BOTH
      // branches, so neither may be dropped.
      if (ev.oldVersion < 1) {
        // Inline autoIncrement id: getAll() only returns VALUES, so the id
        // must live in the record for merge/dedup/sort to see it.
        const store = db.createObjectStore(_PBP_PACK_STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("simp", "simp", { unique: false });
        store.createIndex("trad", "trad", { unique: false });
        db.createObjectStore(_PBP_PACK_META, { keyPath: "id" });
      }
      if (ev.oldVersion < 2) {
        const e = db.createObjectStore(_PBP_ECDICT_STORE, { keyPath: "id", autoIncrement: true });
        e.createIndex("key", "key", { unique: false });
      }
      // Nothing here touches cedict or packs data: a user who already imported
      // CC-CEDICT keeps it and must not be asked to import again.
    };
    req.onsuccess = () => {
      const db = req.result;
      // Close on versionchange and drop the cached promise so a long-lived
      // options tab doesn't block another tab's upgrade.
      db.onversionchange = () => { try { db.close(); } catch (_) {} _pbpPackDbPromise = null; };
      resolve(db);
    };
    // Two distinct failures. onblocked: our upgrade is waiting on another
    // connection. onerror with VersionError: the database is NEWER than the
    // version this page knows, i.e. this page's JS is stale.
    req.onblocked = () => { console.warn("[pack] db upgrade blocked by another connection"); };
    req.onerror = () => {
      const err = req.error;
      if (err && err.name === "VersionError") {
        _pbpPackStale = true;
        console.warn("[pack] db is newer than this page expects; reload required:", err.name);
      }
      _pbpPackDbPromise = null;
      reject(err || new Error("pack db open failed"));
    };
  });
  return _pbpPackDbPromise;
}

// `stores` is explicit per operation. A transaction's scope is fixed when it is
// created, so it cannot be widened later -- and scoping every call to all three
// stores would needlessly block the other pack and the shared meta store.
function _pbpPackTx(db, mode, fn, stores) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores || [_PBP_PACK_STORE, _PBP_PACK_META], mode);
    let out;
    // A synchronous throw part-way through fn() leaves whatever it already
    // queued on a live transaction, which then COMMITS. The import's first
    // transaction queues meta.delete() before clear(), so a throw from clear()
    // used to land the delete and nothing else: data still on disk, meta gone,
    // pack no longer ready or queryable. Abort so the caller's error means the
    // store is untouched. Rejecting with `e` rather than the abort error keeps
    // the original cause (onabort is not wired up yet at this point anyway).
    try { out = fn(tx); } catch (e) { try { tx.abort(); } catch (_) {} reject(e); return; }
    tx.oncomplete = () => resolve(out && typeof out.value === "function" ? out.value() : out);
    tx.onabort = () => reject(tx.error || new Error("pack tx aborted"));
    tx.onerror = () => reject(tx.error || new Error("pack tx failed"));
  });
}

// Head of the stream parsed BEFORE anything is written. 200 lines is a few
// tens of KB held for a moment -- no meaningful memory cost -- and wide enough
// that a real release (a comment header followed by entries) clears the ratio
// by a mile.
const PBP_PACK_PROBE_LINES = 200;
// Candidate = a line that is neither blank nor a `#` comment, i.e. one this
// parser is entitled to an opinion about. Under this many the window says
// nothing about a stream that is still running: a hand-made excerpt or a
// six-line fixture must still import.
const PBP_PACK_PROBE_MIN_CANDIDATES = 20;
// A genuine release parses at ~1.0, so this sits deliberately far below it:
// the gate exists to catch a file that is not CC-CEDICT at all, and a release
// carrying a block of lines this parser happens to reject (a future line
// shape, a locally edited copy) must still import rather than be refused.
const PBP_PACK_PROBE_MIN_RATIO = 0.5;

// Pulls up to PBP_PACK_PROBE_LINES lines off `it` and parses them. The lines
// are BUFFERED, never consumed: _pbpPackReplay feeds them back into the
// import ahead of the rest of the stream.
async function _pbpPackProbeHead(it) {
  const head = [];
  let candidates = 0;
  let parsed = 0;
  let done = false;
  while (head.length < PBP_PACK_PROBE_LINES) {
    const step = await it.next();
    if (step.done) { done = true; break; }
    head.push(step.value);
    const s = String(step.value == null ? "" : step.value).trim();
    if (!s || s.startsWith("#")) continue;
    candidates++;
    if (pbpCedictParseLine(step.value)) parsed++;
  }
  return { head, candidates, parsed, done };
}

// The verdict, evaluated before the store is touched. `done` (the window ate
// the whole file) is what makes the small-file case safe: `malformed > entries`
// downstream is algebraically the SAME 0.5 ratio test over the whole file, so
// a file the probe consumed entirely gets the identical verdict here, just
// before the clear instead of after it. While the stream is still running the
// window has to be wide enough to be representative: under the floor nothing
// is judged, not even a head where nothing parsed at all. A long `#` header is
// not evidence either way, which is why an all-comment window only condemns a
// file that ended inside it.
function _pbpPackProbeRejects(probe) {
  if (probe.parsed === 0 && (probe.done || probe.candidates >= PBP_PACK_PROBE_MIN_CANDIDATES)) return true;
  if (!probe.done && probe.candidates < PBP_PACK_PROBE_MIN_CANDIDATES) return false;
  return probe.parsed < probe.candidates * PBP_PACK_PROBE_MIN_RATIO;
}

// Replays the probed head, then keeps pulling the SAME iterator (an async
// generator hands `this` back from [Symbol.asyncIterator], so it resumes where
// the probe stopped rather than restarting).
async function* _pbpPackReplay(head, it) {
  try {
    for (const line of head) yield line;
    for (;;) {
      const step = await it.next();
      if (step.done) return;
      yield step.value;
    }
  } finally {
    // An early exit (the entry-count guard, a failed put) must still cancel the
    // underlying stream reader. A plain `for await` over the original iterator
    // used to do this for us; going through a wrapper means doing it here.
    try { if (typeof it.return === "function") await it.return(); } catch (_) {}
  }
}

// Stamps "the pack the user had is gone" onto an error escaping past the
// clear. Two traps, both real:
//   - THIS CODEBASE'S codes are STRINGS. A native DOMException carries a
//     legacy NUMERIC `code` (QuotaExceededError 22, NotFoundError 8,
//     InvalidStateError 11), and _pbpPackTx rejects with tx.error, a
//     DOMException. Testing `!error.code` therefore skipped exactly the
//     failure this exists for: a quota blowout mid-batch.
//   - `code` on DOMException is a getter-only accessor on the prototype, so
//     plain assignment silently does nothing. defineProperty shadows it with
//     an own property, which keeps the original object (its name, message and
//     stack reach the console intact).
// Only a frozen/sealed error falls through to a wrapper, and that keeps the
// message and hands the original over as `cause` so nothing is lost.
function _pbpPackMarkCleared(error) {
  if (typeof error?.code === "string") return error; // already one of ours
  try {
    Object.defineProperty(error, "code",
      { value: "pack_cleared", writable: true, configurable: true, enumerable: true });
    if (error.code === "pack_cleared") return error;
  } catch (_) { /* frozen, sealed, or not an object at all */ }
  const wrapped = new Error(error?.message || "pack import failed", { cause: error });
  wrapped.code = "pack_cleared";
  return wrapped;
}

// Import: Web Locks serialize writers; the probe gate runs BEFORE any write;
// then the first tx deletes meta AND clears the store in ONE transaction (old
// meta gone = half-pack invisible); batched puts; meta {state:"ready"} written
// LAST. A tab closed mid-import leaves no meta -> lookups refuse the data.
//
// Why this path stays NON-ATOMIC, unlike the ECDICT one below: CC-CEDICT is a
// public dataset the user re-downloads from MDBG in one click, so a lost pack
// costs a download, not data -- whereas the ECDICT file is the user's own and
// may be unrecoverable, which is what buys atomicity its ~15 MB buffer there.
// Buffering this parse to match would put every parsed record of a 24 MB+
// release in memory at once -- today nothing is held but the current batch,
// and every branch (plain, gzip, zip) reaches the parser as a stream -- and a
// shadow store would mean an IDB version bump. What IS defended is the failure
// mode that actually happens -- picking the wrong file -- by parsing the head
// of the stream and refusing before the store is touched. A truncated stream
// or an exhausted quota mid-write still loses the installed pack; those
// rejections carry code "pack_cleared" so options-vocab.js can say so, and
// only those (see the catch below: nothing before the clear may claim it).
async function pbpPackImport(lineIter, onProgress, stats) {
  return navigator.locks.request("pbp-cedict-import", async () => {
    const it = (lineIter && typeof lineIter[Symbol.asyncIterator] === "function")
      ? lineIter[Symbol.asyncIterator]()
      : (lineIter && typeof lineIter[Symbol.iterator] === "function")
        ? lineIter[Symbol.iterator]()
        : lineIter;
    const probe = await _pbpPackProbeHead(it);
    if (_pbpPackProbeRejects(probe)) {
      try { if (typeof it.return === "function") await it.return(); } catch (_) {}
      // `code` is the contract with the UI: this rejection alone leaves the
      // installed pack intact, so it gets its own message.
      const err = new Error("file does not look like a CC-CEDICT release");
      err.code = "implausible_pack";
      throw err;
    }
    const db = await _pbpPackOpenDB();
    // Everything above this line can fail with the installed pack still on
    // disk: a zip whose central directory does not parse, a read that
    // rejects, invalid UTF-8, an over-long line, a database that will not
    // open, and the clear transaction itself (which aborts as a unit, per
    // _pbpPackTx). Only once THIS await has committed is the old pack gone,
    // so only from here on may an error claim it was removed.
    // Read the old meta in the SAME transaction that deletes it (requests run
    // in order, so this sees the pre-delete value): "pack_cleared" has to mean
    // something the user HAD is now gone, and a first-ever import has nothing
    // to lose no matter how it fails.
    let hadPack = false;
    await _pbpPackTx(db, "readwrite", (tx) => {
      const metaStore = tx.objectStore(_PBP_PACK_META);
      const prior = metaStore.get("cedict");
      prior.onsuccess = () => { hadPack = !!(prior.result && prior.result.state === "ready"); };
      metaStore.delete("cedict");
      tx.objectStore(_PBP_PACK_STORE).clear();
    });
    try {
      let batch = [];
      let entries = 0;
      let malformed = 0;
      const flush = () => _pbpPackTx(db, "readwrite", (tx) => {
        const store = tx.objectStore(_PBP_PACK_STORE);
        for (const rec of batch) store.put(rec);
        batch = [];
      });
      for await (const line of _pbpPackReplay(probe.head, it)) {
        const rec = pbpCedictParseLine(line);
        if (!rec) { if (String(line).trim() && !String(line).startsWith("#")) malformed++; continue; }
        batch.push(rec);
        entries++;
        if (entries > 400000) throw new Error("entry count implausible");
        if (batch.length >= 2000) {
          await flush();
          if (onProgress) onProgress(entries);
          await new Promise((r) => setTimeout(r, 0)); // yield between batches
        }
      }
      if (batch.length) await flush();
      if (!entries || malformed > entries) throw new Error("import parsed no plausible data");
      await _pbpPackTx(db, "readwrite", (tx) => {
        tx.objectStore(_PBP_PACK_META).put({
          id: "cedict", state: "ready", entries, importedAt: Date.now(),
          bytes: (stats && stats.bytes) || 0
        });
      });
      return { entries, malformed };
    } catch (error) {
      // Reached only once the clear has committed. If a ready pack was there,
      // it is gone now and has to be imported again. A first-ever import had
      // nothing to lose, so its errors stay as they are and get the neutral
      // copy.
      throw hadPack ? _pbpPackMarkCleared(error) : error;
    }
  });
}

// Lookup status and index reads share ONE readonly transaction, so callers
// never need a racy second meta read. For each key BOTH indexes are queried
// and results merged (a form that is someone's simp and someone else's trad
// must surface both records).
async function pbpPackLookup(keys) {
  try {
    const db = await _pbpPackOpenDB();
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let tx;
      try { tx = db.transaction([_PBP_PACK_STORE, _PBP_PACK_META], "readonly"); }
      catch (error) { console.warn("[pack] lookup tx-open failed:", error?.name, error?.message); finish({ state: "error" }); return; }
      tx.onabort = tx.onerror = () => { console.warn("[pack] lookup tx failed:", tx.error?.name); finish({ state: "error" }); };
      const metaReq = tx.objectStore(_PBP_PACK_META).get("cedict");
      metaReq.onsuccess = () => {
        const meta = metaReq.result;
        if (!meta || meta.state !== "ready") { finish({ state: "unavailable" }); return; }
        const store = tx.objectStore(_PBP_PACK_STORE);
        const lookupKeys = Array.isArray(keys) ? keys : [];
        const tryKey = (i) => {
          if (i >= lookupKeys.length) { finish({ state: "ready-miss" }); return; }
          const key = lookupKeys[i];
          let bySimp;
          try { bySimp = store.index("simp").getAll(key); }
          catch (error) { console.warn("[pack] simp index read failed:", error?.name, error?.message); finish({ state: "error" }); return; }
          bySimp.onsuccess = () => {
            let byTrad;
            try { byTrad = store.index("trad").getAll(key); }
            catch (error) { console.warn("[pack] trad index read failed:", error?.name, error?.message); finish({ state: "error" }); return; }
            byTrad.onsuccess = () => {
              const seen = new Set();
              const rows = [];
              for (const r of [...(bySimp.result || []), ...(byTrad.result || [])]) {
                if (seen.has(r.id)) continue;
                seen.add(r.id);
                rows.push(r);
              }
              rows.sort((a, b) => a.id - b.id); // storage order across both indexes
              if (rows.length) finish({ state: "hit", matched: key, rows });
              else tryKey(i + 1);
            };
            byTrad.onerror = () => { console.warn("[pack] trad index read failed:", byTrad.error?.name); finish({ state: "error" }); };
          };
          bySimp.onerror = () => { console.warn("[pack] simp index read failed:", bySimp.error?.name); finish({ state: "error" }); };
        };
        tryKey(0);
      };
      metaReq.onerror = () => { console.warn("[pack] lookup meta read failed:", metaReq.error?.name); finish({ state: "error" }); };
    });
  } catch (error) { console.warn("[pack] lookup failed:", error?.name, error?.message); return { state: "error" }; }
}

async function pbpPackMeta() {
  try {
    const db = await _pbpPackOpenDB();
    return await new Promise((resolve) => {
      const req = db.transaction(_PBP_PACK_META, "readonly").objectStore(_PBP_PACK_META).get("cedict");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => { console.warn("[pack] meta failed:", req.error?.name); resolve({ state: "error" }); };
    });
  } catch (error) { console.warn("[pack] meta failed:", error?.name, error?.message); return { state: "error" }; }
}

async function pbpPackDelete() {
  return navigator.locks.request("pbp-cedict-import", async () => {
    const db = await _pbpPackOpenDB();
    await _pbpPackTx(db, "readwrite", (tx) => {
      tx.objectStore(_PBP_PACK_META).delete("cedict");
      tx.objectStore(_PBP_PACK_STORE).clear();
    });
    return true;
  });
}

// File import entry (options page): .gz sniffed by magic bytes 1f 8b, not
// by filename. Any thrown error surfaces to the caller's status line.
async function pbpPackImportFile(file, onProgress) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const stats = { bytes: 0 };
  if (head[0] === 0x50 && head[1] === 0x4b) { // "PK": the MDBG ZIP release
    const text = await pbpPackZipTextStream(file);
    return pbpPackImport(pbpCedictLines(text, false, stats), onProgress, stats);
  }
  const gzip = head[0] === 0x1f && head[1] === 0x8b;
  return pbpPackImport(pbpCedictLines(file.stream(), gzip, stats), onProgress, stats);
}

// ---- ECDICT IDB layer ----------------------------------------------------
// Import is ATOMIC, unlike the CC-CEDICT path: parse the whole file into memory
// first, and only then clear + write + mark ready inside ONE transaction. A
// user replacing their pack must not lose the working one to a parse error, a
// truncated stream, a failed write or an exhausted quota. Buffering costs memory
// (~15 MB at the top rung) and that is the trade being made on purpose.
// The asymmetry is deliberate, not an oversight: this file is the user's own
// and may be unrecoverable, while CC-CEDICT is one click away from MDBG. The
// comment above pbpPackImport records that trade and the probe gate that
// covers the wrong-file case there without buffering.

const _PBP_ECDICT_META_ID = "ecdict";
const _PBP_ECDICT_LOCK = "pbp-ecdict-import";
// A batch is bounded by BOTH a record count and a byte budget, and ends at
// whichever comes first. Counting records alone was measured at a 384 ms
// event-loop gap on the widest-record fixture: 1000 records of 12.8 KB is a
// 12.8 MB structured clone in one synchronous burst. The next burst is queued
// from the LAST request's success callback, which keeps the transaction alive
// without handing control back to a plain task, where it would be inactive.
// 1000 was measured at a 53-85 ms gap once the pack got large (182k records):
// the per-put cost is small but real, and the burst is one unyieldable task
// because the transaction must stay alive. 300 lands the same import at 37 ms
// max over five runs with no measurable wall-clock cost (24.8s both ways).
const PBP_ECDICT_PUT_BATCH = 300;
// UTF-16 units, a cheap proxy for clone cost that needs no encoder pass and adds
// no field to the stored record (which must stay exactly key/word/translation).
const PBP_ECDICT_PUT_BATCH_UNITS = 256 * 1024;

// Queues clear + every put + the ready meta record into one live transaction.
// Returns nothing: completion is the transaction's own oncomplete.
function _pbpEcdictCommit(tx, records, metaRecord, onProgress) {
  const store = tx.objectStore(_PBP_ECDICT_STORE);
  const metaStore = tx.objectStore(_PBP_PACK_META);
  store.clear();
  let i = 0;
  const queueBatch = () => {
    const end = Math.min(i + PBP_ECDICT_PUT_BATCH, records.length);
    let last = null, units = 0;
    for (; i < end; i++) {
      const r = records[i];
      last = store.put(r);
      units += r.key.length + r.word.length + r.translation.length;
      // Break AFTER putting record i, so i must advance past it here: the
      // break skips the loop's own increment.
      if (units >= PBP_ECDICT_PUT_BATCH_UNITS) { i++; break; }
    }
    // Callers guarantee records.length > 0, so `last` is never null here.
    last.onsuccess = () => {
      if (onProgress) { try { onProgress(i); } catch (_) {} }
      if (i < records.length) { queueBatch(); return; }
      // Final batch. This put MUST be queued synchronously inside this
      // callback: after any await or promise hop the transaction is inactive.
      metaStore.put(metaRecord);
    };
    // Deliberately no onerror handler. A failed request bubbles and aborts the
    // transaction, which is exactly what should happen; calling preventDefault
    // would let the next batch queue onto a doomed transaction and could land a
    // partial pack.
  };
  queueBatch();
}

// How much text to chew through before handing the event loop back, in UTF-16
// units. The stream only awaits between chunks, so without this every line in a
// chunk is parsed in one task and the block scales with chunk size and line
// width. Safe here and ONLY here: parsing finishes before any transaction is
// opened, so yielding cannot make one go inactive.
const PBP_ECDICT_PARSE_YIELD_UNITS = 64 * 1024;

// lineIter must come from pbpCedictLines(..., stats, PBP_ECDICT_MAX_BYTES) with
// stats.crc pre-seeded to 0.
// opts: { rung, onProgress, onParsed, onPhase }.
async function pbpEcdictImport(lineIter, stats, opts) {
  const o = opts || {};
  const rung = o.rung || "R1";
  return navigator.locks.request(_PBP_ECDICT_LOCK, async () => {
    let idx = null;
    const records = [];
    const enc = new TextEncoder();
    let rows = 0, malformed = 0, payloadBytes = 0, sinceYield = 0;
    for await (const line of lineIter) {
      if (!line) continue;
      sinceYield += line.length;
      if (sinceYield >= PBP_ECDICT_PARSE_YIELD_UNITS) {
        sinceYield = 0;
        await new Promise((r) => setTimeout(r, 0));
      }
      if (!idx) {
        idx = pbpEcdictParseHeader(line);
        if (!idx) throw new Error("not an ECDICT csv: header missing or ambiguous");
        // Present-but-optional columns: they decide admission at R2/R3 and are
        // then discarded, so a file without them simply cannot reach those rungs.
        const names = pbpEcdictSplitLine(line).map((n) => n.trim());
        const ex = names.indexOf("exchange"), de = names.indexOf("definition");
        if (ex >= 0) idx.exchange = ex;
        if (de >= 0) idx.definition = de;
        continue;
      }
      rows++;
      const r = pbpEcdictParseRow(line, idx, rung);
      if (r.fatal) throw new Error("not an ECDICT csv: " + r.fatal);
      if (r.malformed) { malformed++; continue; }
      if (!r.ok) continue;
      records.push(r.record);
      // Accumulated here rather than in one pass afterwards: a single trailing
      // encode of the whole payload was measured as a long task on its own.
      payloadBytes += pbpEcdictRecordBytes(r.record, enc);
      // Retention is charged to the yield budget too. Counting only the source
      // text read makes the window scale with the FILE, not with the work: at
      // R3 the same 64K of input keeps ~3x the records of R1, and the measured
      // max gap went 22ms -> 53ms on the identical file for that reason alone.
      sinceYield += r.record.key.length + r.record.word.length + r.record.translation.length;
      if (records.length > PBP_ECDICT_MAX_ENTRIES) throw new Error("ECDICT entry count above the accepted ceiling");
      if (payloadBytes > PBP_ECDICT_MAX_PAYLOAD_BYTES) throw new Error("ECDICT payload above the accepted ceiling");
      if (records.length % 20000 === 0 && o.onParsed) { try { o.onParsed(records.length); } catch (_) {} }
    }
    // Every resource gate is checked BEFORE a transaction exists, so a rejected
    // file never touches the store.
    if (!idx) throw new Error("not an ECDICT csv: empty file");
    if (!records.length) throw new Error("ECDICT import parsed no usable rows");
    if (rows && malformed / rows > PBP_ECDICT_MAX_MALFORMED_RATIO) {
      throw new Error("not an ECDICT csv: too many malformed rows");
    }
    const metaRecord = {
      id: _PBP_ECDICT_META_ID,
      state: "ready",
      entries: records.length,
      rung,
      importedAt: Date.now(),
      decodedBytes: (stats && stats.bytes) || 0,
      // Diagnostic only. See pbpCrc32Update: 32 bits, collisions exist.
      decodedCrc32: stats && typeof stats.crc === "number" ? pbpCrc32Hex(stats.crc) : ""
    };
    // Phase marker: everything above is parsing, everything below is the one
    // transaction. Lets a harness attribute a main-thread stall to the phase
    // that can yield versus the phase that must not.
    if (o.onPhase) { try { o.onPhase("parsed"); } catch (_) {} }
    const db = await _pbpPackOpenDB();
    await _pbpPackTx(db, "readwrite", (tx) => {
      _pbpEcdictCommit(tx, records, metaRecord, o.onProgress);
    }, [_PBP_ECDICT_STORE, _PBP_PACK_META]);
    return { entries: records.length, malformed, rows, payloadBytes, rung };
  });
}

// Exact-key lookup. Meta and index read share ONE readonly transaction so no
// caller needs a racy second meta read.
async function pbpEcdictLookup(term) {
  try {
    const key = pbpEcdictKey(term);
    if (!key) return { state: "ready-miss" };
    const db = await _pbpPackOpenDB();
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
      let tx;
      try { tx = db.transaction([_PBP_ECDICT_STORE, _PBP_PACK_META], "readonly"); }
      catch (error) { console.warn("[pack] ecdict lookup tx-open failed:", error?.name, error?.message); finish({ state: "error" }); return; }
      tx.onabort = tx.onerror = () => { console.warn("[pack] ecdict lookup tx failed:", tx.error?.name); finish({ state: "error" }); };
      const metaReq = tx.objectStore(_PBP_PACK_META).get(_PBP_ECDICT_META_ID);
      metaReq.onsuccess = () => {
        const meta = metaReq.result;
        if (!meta || meta.state !== "ready") { finish({ state: "unavailable" }); return; }
        let rowsReq;
        try { rowsReq = tx.objectStore(_PBP_ECDICT_STORE).index("key").getAll(key); }
        catch (error) { console.warn("[pack] ecdict index read failed:", error?.name, error?.message); finish({ state: "error" }); return; }
        rowsReq.onsuccess = () => {
          const rows = rowsReq.result || [];
          finish(rows.length ? { state: "hit", matched: key, rows, meta } : { state: "ready-miss" });
        };
        rowsReq.onerror = () => { console.warn("[pack] ecdict index read failed:", rowsReq.error?.name); finish({ state: "error" }); };
      };
      metaReq.onerror = () => { console.warn("[pack] ecdict lookup meta read failed:", metaReq.error?.name); finish({ state: "error" }); };
    });
  } catch (error) { console.warn("[pack] ecdict lookup failed:", error?.name, error?.message); return { state: "error" }; }
}

// Batched exact lookup for the vocabulary/export paths: ONE readonly
// transaction for every key, never one transaction per visible row. Returns a
// Map of key -> rows for the keys that hit; a missing key is simply absent.
// Resolves to an empty Map when no pack is ready, so callers need no state check.
async function pbpEcdictLookupMany(keys) {
  const out = new Map();
  try {
    const wanted = [...new Set((Array.isArray(keys) ? keys : []).map(pbpEcdictKey).filter(Boolean))];
    if (!wanted.length) return out;
    const db = await _pbpPackOpenDB();
    return await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(out); } };
      let tx;
      try { tx = db.transaction([_PBP_ECDICT_STORE, _PBP_PACK_META], "readonly"); }
      catch (_) { finish(); return; }
      tx.onabort = tx.onerror = finish;
      tx.oncomplete = finish;
      const metaReq = tx.objectStore(_PBP_PACK_META).get(_PBP_ECDICT_META_ID);
      metaReq.onsuccess = () => {
        const meta = metaReq.result;
        if (!meta || meta.state !== "ready") return;   // tx.oncomplete resolves
        const index = tx.objectStore(_PBP_ECDICT_STORE).index("key");
        for (const k of wanted) {
          const req = index.getAll(k);
          req.onsuccess = () => { if (req.result && req.result.length) out.set(k, req.result); };
        }
      };
    });
  } catch (_) { return out; }
}

async function pbpEcdictMeta() {
  try {
    const db = await _pbpPackOpenDB();
    return await new Promise((resolve) => {
      const req = db.transaction(_PBP_PACK_META, "readonly").objectStore(_PBP_PACK_META).get(_PBP_ECDICT_META_ID);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => { console.warn("[pack] ecdict meta failed:", req.error?.name); resolve({ state: "error" }); };
    });
  } catch (error) { console.warn("[pack] ecdict meta failed:", error?.name, error?.message); return { state: "error" }; }
}

async function pbpEcdictDelete() {
  return navigator.locks.request(_PBP_ECDICT_LOCK, async () => {
    const db = await _pbpPackOpenDB();
    await _pbpPackTx(db, "readwrite", (tx) => {
      tx.objectStore(_PBP_PACK_META).delete(_PBP_ECDICT_META_ID);
      tx.objectStore(_PBP_ECDICT_STORE).clear();
    }, [_PBP_ECDICT_STORE, _PBP_PACK_META]);
    return true;
  });
}

// File import entry (options page). Sniffs gzip/zip by magic bytes, not by
// filename, so a mis-named .csv still works.
async function pbpEcdictImportFile(file, opts) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const stats = { bytes: 0, crc: 0 };
  if (head[0] === 0x50 && head[1] === 0x4b) {
    const text = await pbpPackZipTextStream(file);
    return pbpEcdictImport(pbpCedictLines(text, false, stats, PBP_ECDICT_MAX_BYTES), stats, opts);
  }
  const gzip = head[0] === 0x1f && head[1] === 0x8b;
  return pbpEcdictImport(pbpCedictLines(file.stream(), gzip, stats, PBP_ECDICT_MAX_BYTES), stats, opts);
}

// ---- User-supplied multilingual Yomitan v3 packs -------------------------
// Separate device-local DB: installing a generic pack never upgrades or clears
// the established CC-CEDICT/ECDICT stores. No network or permission requests.
// Format references: yomidevs/yomitan ext/data/schemas/dictionary-{index,
// term-bank-v3,tag-bank-v3}-schema.json. Imported content is DATA only.
const PBP_YOMITAN_LIMITS = Object.freeze({
  zipBytes: 128 * 1024 * 1024, decodedBytes: 640 * 1024 * 1024,
  bankBytes: 32 * 1024 * 1024, payloadBytes: 512 * 1024 * 1024,
  entries: 1500000, files: 8192, packs: 16, rowUnits: 65536,
  hits: 20, rowsPerHit: 40, sensesPerHit: 80
});
const _PBP_MULTI_DB = "pbp-multidict";
const _PBP_MULTI_LOCK = "pbp-multidict-write";
let _pbpMultiDbPromise = null;
function _pbpYomitanError(code, message) { return Object.assign(new Error(message), { code }); }
function _pbpYomitanCheck(ok, message, code = "invalid_pack") { if (!ok) throw _pbpYomitanError(code, message); }
function _pbpYomitanAbort(signal) { if (signal?.aborted) throw new DOMException("Dictionary import cancelled", "AbortError"); }
function _pbpYomitanPlain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function _pbpYomitanText(value, max, required = false) {
  _pbpYomitanCheck(typeof value === "string" && value.length <= max && (!required || value.trim()), "Invalid dictionary text");
  return value.normalize("NFC");
}
function _pbpYomitanLanguage(value) {
  if (value == null || value === "") return "";
  try {
    if (typeof value !== "string" || value.length > 80 || value.trim() !== value) throw new Error();
    const canonical = Intl.getCanonicalLocales(value)[0] || "";
    if (["und", "mul", "zxx"].includes(canonical.toLowerCase().split("-")[0])) throw new Error();
    return canonical;
  } catch (_) { throw _pbpYomitanError("invalid_language", "Invalid dictionary language tag"); }
}
function _pbpYomitanPrimary(value) { return String(value || "").toLowerCase().split("-")[0]; }
function _pbpYomitanKey(value) { return String(value || "").normalize("NFC").trim().replace(/\s+/g, " "); }
function _pbpYomitanSource(value) {
  if (value == null || value === "") return "";
  const text = _pbpYomitanText(value, 2048);
  try { const u = new URL(text); if (u.protocol !== "https:" || u.username || u.password) throw new Error(); return u.href; }
  catch (_) { throw _pbpYomitanError("invalid_pack", "Invalid dictionary source URL"); }
}
function _pbpYomitanPath(name) {
  _pbpYomitanCheck(name && name.length <= 512 && !/[\\:\u0000-\u001f\u007f]/.test(name) && !name.startsWith("/") &&
    name.split("/").every((part, i, all) => part !== "." && part !== ".." && (part !== "" || i === all.length - 1)), "Unsafe ZIP path");
  return name;
}
function _pbpYomitanFileKind(name) {
  if (name === "index.json") return "index";
  if (/^term_bank_[1-9]\d*\.json$/.test(name)) return "terms";
  if (/^tag_bank_[1-9]\d*\.json$/.test(name)) return "tags";
  if (/^(?:term_meta|kanji|kanji_meta)_bank_[1-9]\d*\.json$/.test(name)) return "ignored";
  if (name.endsWith("/") || name === "styles.css" || /(?:^|\/)(?:README|LICENSE|COPYING)(?:\.[a-z0-9]+)?$/i.test(name) ||
      /\.(?:png|jpe?g|gif|webp|svg|avif|mp3|ogg|wav|woff2?|ttf)$/i.test(name)) return "ignored";
  throw _pbpYomitanError("invalid_pack", "Unsupported dictionary archive member");
}

// Strict multi-member ZIP boundary. Unlike the legacy single-text reader,
// consumed members have CRC/size verification and local/central agreement.
async function _pbpYomitanZip(file, signal) {
  _pbpYomitanAbort(signal);
  _pbpYomitanCheck(file && Number.isSafeInteger(file.size) && file.size >= 22, "Not a ZIP file");
  _pbpYomitanCheck(file.size <= PBP_YOMITAN_LIMITS.zipBytes, "ZIP exceeds import limit", "too_large");
  const tailStart = Math.max(0, file.size - 65557);
  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50 && i + 22 + tv.getUint16(i + 20, true) === tail.length) { end = i; break; }
  }
  _pbpYomitanCheck(end >= 0, "ZIP end record missing");
  const count = tv.getUint16(end + 10, true), cdSize = tv.getUint32(end + 12, true), cdStart = tv.getUint32(end + 16, true);
  _pbpYomitanCheck(!tv.getUint16(end + 4, true) && !tv.getUint16(end + 6, true) && tv.getUint16(end + 8, true) === count &&
    count > 0 && count !== 65535 && cdStart !== 0xffffffff && cdSize !== 0xffffffff, "Unsupported multi-disk or ZIP64 archive");
  _pbpYomitanCheck(count <= PBP_YOMITAN_LIMITS.files && cdSize <= 4 * 1024 * 1024, "ZIP directory exceeds import limit", "too_large");
  _pbpYomitanCheck(cdStart + cdSize === tailStart + end, "Invalid ZIP directory boundary");
  const bytes = await file.slice(cdStart, cdStart + cdSize).arrayBuffer(), cd = new DataView(bytes);
  const decoder = new TextDecoder("utf-8", { fatal: true }), entries = [], names = new Set();
  let p = 0, total = 0;
  for (let i = 0; i < count; i++) {
    _pbpYomitanAbort(signal);
    _pbpYomitanCheck(p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50, "Invalid ZIP central entry");
    const flags = cd.getUint16(p + 8, true), method = cd.getUint16(p + 10, true), crc = cd.getUint32(p + 16, true);
    const compressed = cd.getUint32(p + 20, true), decoded = cd.getUint32(p + 24, true), local = cd.getUint32(p + 42, true);
    const nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
    _pbpYomitanCheck(p + 46 + nl + xl + cl <= cd.byteLength && nl > 0, "Truncated ZIP entry");
    _pbpYomitanCheck(!(flags & 0x2041) && !cd.getUint16(p + 34, true) && cd.getUint16(p + 6, true) <= 20 &&
      compressed !== 0xffffffff && decoded !== 0xffffffff && local !== 0xffffffff, "Unsupported encrypted or ZIP64 entry");
    _pbpYomitanCheck(method === 0 || method === 8, "Unsupported ZIP compression");
    _pbpYomitanCheck(((cd.getUint32(p + 38, true) >>> 16) & 0xf000) !== 0xa000, "ZIP symbolic links are unsupported");
    const name = _pbpYomitanPath(decoder.decode(new Uint8Array(bytes, p + 46, nl)));
    _pbpYomitanCheck(!names.has(name.normalize("NFC")), "Duplicate ZIP member"); names.add(name.normalize("NFC"));
    const kind = _pbpYomitanFileKind(name);
    total += decoded;
    _pbpYomitanCheck(total <= PBP_YOMITAN_LIMITS.decodedBytes && compressed <= PBP_YOMITAN_LIMITS.zipBytes &&
      (kind === "ignored" || decoded <= (kind === "index" ? 128 * 1024 : PBP_YOMITAN_LIMITS.bankBytes)), "ZIP member exceeds import limit", "too_large");
    _pbpYomitanCheck(local + 30 <= cdStart, "Invalid ZIP local offset");
    const header = new DataView(await file.slice(local, local + 30).arrayBuffer());
    _pbpYomitanCheck(header.byteLength === 30 && header.getUint32(0, true) === 0x04034b50 && header.getUint16(6, true) === flags &&
      header.getUint16(8, true) === method && header.getUint16(4, true) <= 20, "ZIP local and central headers disagree");
    const localNameLength = header.getUint16(26, true), localExtraLength = header.getUint16(28, true);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    _pbpYomitanCheck(dataStart + compressed <= cdStart, "ZIP payload crosses directory");
    const localName = decoder.decode(await file.slice(local + 30, local + 30 + localNameLength).arrayBuffer());
    _pbpYomitanCheck(localName === name, "ZIP local path differs from directory");
    let dataEnd = dataStart + compressed;
    if (!(flags & 8)) {
      _pbpYomitanCheck(header.getUint32(14, true) === crc && header.getUint32(18, true) === compressed && header.getUint32(22, true) === decoded, "ZIP local sizes or CRC disagree");
    } else {
      const descriptor = new DataView(await file.slice(dataEnd, Math.min(cdStart, dataEnd + 16)).arrayBuffer());
      _pbpYomitanCheck(descriptor.byteLength >= 12, "ZIP data descriptor missing");
      const d = descriptor.getUint32(0, true) === 0x08074b50 ? 4 : 0;
      _pbpYomitanCheck(descriptor.byteLength >= d + 12 && descriptor.getUint32(d, true) === crc && descriptor.getUint32(d + 4, true) === compressed && descriptor.getUint32(d + 8, true) === decoded, "ZIP data descriptor disagrees");
      dataEnd += d + 12;
    }
    entries.push({ name, kind, method, crc, compressed, decoded, local, dataStart, dataEnd });
    p += 46 + nl + xl + cl;
  }
  _pbpYomitanCheck(p === cd.byteLength, "Unexpected ZIP directory trailing data");
  const physical = entries.slice().sort((a, b) => a.local - b.local);
  for (let i = 1; i < physical.length; i++) _pbpYomitanCheck(physical[i - 1].dataEnd <= physical[i].local, "Overlapping ZIP entries");
  _pbpYomitanCheck(entries.some(e => e.kind === "index") && entries.some(e => e.kind === "terms"), "Dictionary index or term bank missing");
  return { entries, decodedBytes: total };
}
async function _pbpYomitanReadJson(file, entry, signal) {
  _pbpYomitanAbort(signal);
  const chunks = []; let length = 0, crc = 0;
  try {
    let stream = file.slice(entry.dataStart, entry.dataStart + entry.compressed).stream();
    if (entry.method === 8) stream = stream.pipeThrough(new DecompressionStream("deflate-raw"));
    for await (const chunk of stream) {
      _pbpYomitanAbort(signal); length += chunk.length;
      _pbpYomitanCheck(length <= entry.decoded && length <= PBP_YOMITAN_LIMITS.bankBytes, "ZIP decompression exceeds declared size", "too_large");
      crc = pbpCrc32Update(crc, chunk); chunks.push(chunk);
    }
  } catch (error) {
    if (typeof error?.code === "string" || error?.name === "AbortError") throw error;
    console.warn("[pack] dictionary decompression failed:", error?.name, "Unable to decode archive member");
    throw _pbpYomitanError("invalid_pack", "Unable to decode archive member");
  }
  _pbpYomitanCheck(length === entry.decoded && crc === entry.crc, "ZIP data size or CRC mismatch");
  const bytes = new Uint8Array(length); let p = 0;
  for (const chunk of chunks) { bytes.set(chunk, p); p += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (_) { throw _pbpYomitanError("invalid_pack", "Dictionary JSON or UTF-8 is invalid"); }
}
async function _pbpYomitanManifest(index, options = {}) {
  _pbpYomitanCheck(_pbpYomitanPlain(index) && (index.format ?? index.version) === 3 &&
    (index.format === undefined || index.version === undefined || index.format === index.version), "Only Yomitan v3 term dictionaries are supported");
  const title = _pbpYomitanText(index.title, 256, true).trim(), revision = _pbpYomitanText(index.revision, 256, true);
  const sourceLanguage = _pbpYomitanLanguage(options.sourceLanguage ?? index.sourceLanguage);
  const targetLanguage = _pbpYomitanLanguage(options.targetLanguage ?? index.targetLanguage);
  const sourceUrl = _pbpYomitanSource(options.sourceUrl ?? index.url);
  const license = _pbpYomitanText(options.license ?? index.license ?? "", 8192);
  const attribution = _pbpYomitanText(index.attribution ?? "", 65536);
  const description = _pbpYomitanText(index.description ?? "", 65536);
  const missingLanguages = [!sourceLanguage && "sourceLanguage", !targetLanguage && "targetLanguage"].filter(Boolean);
  let id = null;
  if (!missingLanguages.length) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([title, sourceLanguage, targetLanguage])));
    id = "yomitan-" + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  }
  return { id, title, revision, format: 3, sourceLanguage, targetLanguage, sourceUrl, license, attribution, description, missingLanguages };
}
async function pbpYomitanInspectFile(file, options = {}) {
  try {
    const zip = await _pbpYomitanZip(file, options.signal);
    return await _pbpYomitanManifest(await _pbpYomitanReadJson(file, zip.entries.find(e => e.kind === "index"), options.signal), options);
  } catch (error) {
    if (typeof error?.code === "string" || error?.name === "AbortError") throw error;
    console.warn("[pack] dictionary inspection failed:", error?.name, "Unable to read archive");
    throw _pbpYomitanError("invalid_pack", "Unable to read dictionary archive");
  }
}

// Structured content is traversed as JSON, never fed to a DOM parser. Styles,
// links, images and data attributes are not returned or executed. Limits bound
// hostile nesting as well as large flat child arrays before string assembly.
function _pbpYomitanGloss(value) {
  let nodes = 0, units = 0;
  function text(s) { _pbpYomitanCheck(typeof s === "string", "Invalid structured text"); units += s.length; _pbpYomitanCheck(units <= PBP_YOMITAN_LIMITS.rowUnits, "Dictionary definition too large", "too_large"); return s; }
  function walk(node, depth) {
    _pbpYomitanCheck(++nodes <= 8192 && depth <= 32, "Structured definition exceeds limits", "too_large");
    if (typeof node === "string") return text(node);
    if (Array.isArray(node)) return node.map(child => walk(child, depth + 1)).join("");
    _pbpYomitanCheck(_pbpYomitanPlain(node), "Invalid structured definition");
    const tag = node.tag;
    _pbpYomitanCheck(["br", "ruby", "rt", "rp", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "span", "div", "ol", "ul", "li", "details", "summary", "img", "a"].includes(tag), "Unsupported structured definition tag");
    _pbpYomitanCheck(Object.keys(node).every(key => ["tag", "content", "data", "lang", "style", "title", "open", "colSpan", "rowSpan", "href", "path", "width", "height", "alt", "description", "pixelated", "imageRendering", "appearance", "background", "collapsed", "collapsible", "verticalAlign", "border", "borderRadius", "sizeUnits"].includes(key)), "Unsupported structured definition property");
    if (tag === "br") return "\n";
    if (tag === "img") return typeof node.alt === "string" ? text(node.alt) : "";
    const body = node.content === undefined ? "" : walk(node.content, depth + 1);
    return ["div", "ol", "ul", "li", "details", "summary", "table", "tr"].includes(tag) ? "\n" + body + "\n" : body;
  }
  let result;
  if (typeof value === "string") result = text(value);
  else {
    _pbpYomitanCheck(_pbpYomitanPlain(value), "Invalid dictionary definition");
    if (value.type === "text") { _pbpYomitanCheck(Object.keys(value).every(k => ["type", "text"].includes(k)), "Invalid text definition"); result = text(value.text); }
    else if (value.type === "structured-content") { _pbpYomitanCheck(Object.keys(value).every(k => ["type", "content"].includes(k)), "Invalid structured definition"); result = walk(value.content, 0); }
    else if (value.type === "image") { result = typeof value.alt === "string" ? text(value.alt) : ""; }
    else throw _pbpYomitanError("invalid_pack", "Unsupported definition schema");
  }
  return result.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function _pbpYomitanRow(raw) {
  _pbpYomitanCheck(Array.isArray(raw) && raw.length === 8 && typeof raw[0] === "string" && typeof raw[1] === "string" &&
    (raw[2] === null || typeof raw[2] === "string") && typeof raw[3] === "string" && Number.isFinite(raw[4]) && Array.isArray(raw[5]) &&
    Number.isSafeInteger(raw[6]) && typeof raw[7] === "string", "Invalid Yomitan v3 term row");
  const term = _pbpYomitanKey(_pbpYomitanText(raw[0], 256, true)), reading = _pbpYomitanKey(_pbpYomitanText(raw[1], 256));
  _pbpYomitanText(raw[2] ?? "", 2048); _pbpYomitanText(raw[3], 2048); _pbpYomitanText(raw[7], 2048);
  _pbpYomitanCheck(raw[5].length <= 256, "Too many definitions in one row", "too_large");
  const definitions = [], lemmas = [];
  for (const item of raw[5]) {
    if (Array.isArray(item)) {
      _pbpYomitanCheck(item.length === 2 && typeof item[0] === "string" && Array.isArray(item[1]) && item[1].length <= 64 && item[1].every(rule => typeof rule === "string" && rule.length <= 128), "Invalid deinflection tuple");
      lemmas.push({ term: _pbpYomitanText(item[0], 256, true), rules: item[1].slice() });
    } else { const definition = _pbpYomitanGloss(item); if (definition) definitions.push(definition); }
  }
  _pbpYomitanCheck(definitions.length || lemmas.length, "Term contains no supported text definitions");
  const row = { term, reading, folded: term.toLowerCase(), definitions, lemmas, definitionTags: raw[2] || "", rules: raw[3], score: raw[4], sequence: raw[6], termTags: raw[7] };
  _pbpYomitanCheck(JSON.stringify(row).length <= PBP_YOMITAN_LIMITS.rowUnits, "Term row exceeds import limit", "too_large");
  return row;
}
function _pbpYomitanNorm(rows, pack) {
  let remaining = PBP_YOMITAN_LIMITS.sensesPerHit;
  const entries = rows.map(row => {
    const definitions = row.definitions.length ? row.definitions : row.lemmas.map(item => item.term);
    const senses = definitions.slice(0, remaining).map(definition => ({ definition, examples: [], tags: row.definitions.length ? [] : ["form-of"], synonyms: [], antonyms: [], subsenses: [] }));
    remaining -= senses.length;
    return { pos: row.definitionTags, ipas: row.reading ? [{ text: row.reading, tags: ["Reading"] }] : [], forms: row.lemmas.map(item => ({ word: item.term, tags: ["lemma"] })), senses };
  }).filter(entry => entry.senses.length);
  return { word: rows[0].term, entries, sourceLabel: pack.title, sourceUrl: pack.sourceUrl, license: pack.license,
    attribution: pack.attribution, definitionLang: pack.targetLanguage, sourceLanguage: pack.sourceLanguage,
    targetLanguage: pack.targetLanguage, packId: pack.id, aiAllowed: pack.aiAllowed === true,
    generation: pack.activeGeneration, revision: pack.revision,
    formOfOnly: rows.every(row => !row.definitions.length) };
}

function _pbpMultiOpenDB() {
  if (_pbpMultiDbPromise) return _pbpMultiDbPromise;
  _pbpMultiDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(_PBP_MULTI_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("packs", { keyPath: "id" });
      db.createObjectStore("generations", { keyPath: "id" });
      const terms = db.createObjectStore("terms", { keyPath: ["generation", "row"] });
      for (const [name, field] of [["term", "term"], ["folded", "folded"], ["reading", "reading"]]) terms.createIndex(name, ["generation", field]);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); _pbpMultiDbPromise = null; };
      resolve(db);
      // Another tab's import owns this same lock until activation/rollback.
      // Cleanup therefore never mistakes its in-progress generation for an orphan.
      navigator.locks.request(_PBP_MULTI_LOCK, () => _pbpMultiCleanup(db)).catch(error => console.warn("[pack] multidict cleanup failed:", error?.name, "Unable to remove incomplete generations"));
    };
    request.onblocked = () => console.warn("[pack] multidict database open blocked");
    request.onerror = () => { _pbpMultiDbPromise = null; console.warn("[pack] multidict open failed:", request.error?.name, "Dictionary database unavailable"); reject(_pbpYomitanError("storage", "Dictionary database unavailable")); };
  });
  return _pbpMultiDbPromise;
}
function _pbpMultiRange(generation) { return IDBKeyRange.bound([generation, 0], [generation, Number.MAX_SAFE_INTEGER]); }
async function _pbpMultiCleanup(db) {
  await _pbpPackTx(db, "readwrite", tx => {
    const request = tx.objectStore("packs").getAll();
    request.onsuccess = () => {
      const active = new Set(request.result.map(pack => pack.activeGeneration));
      const cursor = tx.objectStore("generations").openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result; if (!item) return;
        if (!active.has(item.key)) { tx.objectStore("terms").delete(_pbpMultiRange(item.key)); item.delete(); }
        item.continue();
      };
    };
  }, ["packs", "generations", "terms"]);
}
function _pbpMultiNotify(id, action) {
  const detail = { type: "changed", id, action };
  try { const channel = new BroadcastChannel("pbp-dict-packs"); channel.postMessage(detail); channel.close(); } catch (_) {}
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pbp-dict-packs-changed", { detail }));
}
async function pbpDictPackList() {
  try {
    const db = await _pbpMultiOpenDB();
    return await _pbpPackTx(db, "readonly", tx => { const r = tx.objectStore("packs").getAll(); return { value: () => r.result.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)) }; }, ["packs"]);
  } catch (error) { console.warn("[pack] multidict list failed:", error?.name, "Unable to read installed dictionaries"); throw _pbpYomitanError("storage", "Unable to read installed dictionaries"); }
}
async function _pbpMultiChange(id, field, value, expectedGeneration) {
  return navigator.locks.request(_PBP_MULTI_LOCK, async () => {
    let stale = false;
    try {
      const db = await _pbpMultiOpenDB(); let changed = false;
      await _pbpPackTx(db, "readwrite", tx => {
        const store = tx.objectStore("packs"), request = store.get(id);
        request.onsuccess = () => {
          const pack = request.result;
          // The confirmation describes one version's data and license. A
          // queued replacement must not inherit that previous consent.
          if (expectedGeneration !== undefined && pack?.activeGeneration !== expectedGeneration) {
            stale = true; tx.abort(); return;
          }
          if (!pack) return;
          changed = true;
          if (field === "delete") { store.delete(id); tx.objectStore("terms").delete(_pbpMultiRange(pack.activeGeneration)); tx.objectStore("generations").delete(pack.activeGeneration); }
          else { pack[field] = value === true; store.put(pack); }
        };
      }, field === "delete" ? ["packs", "terms", "generations"] : ["packs"]);
      if (changed) _pbpMultiNotify(id, field); return changed;
    } catch (error) {
      if (stale) throw _pbpYomitanError("stale_pack", "Dictionary version changed before confirmation");
      console.warn("[pack] multidict change failed:", error?.name, "Unable to update dictionary");
      throw _pbpYomitanError("storage", "Unable to update dictionary");
    }
  });
}
function pbpDictPackSetEnabled(id, enabled) { return _pbpMultiChange(id, "enabled", enabled); }
function pbpDictPackSetAiAllowed(id, allowed, expectedGeneration) { return _pbpMultiChange(id, "aiAllowed", allowed, expectedGeneration); }
function pbpDictPackDelete(id, expectedGeneration) { return _pbpMultiChange(id, "delete", undefined, expectedGeneration); }

function pbpYomitanImportFile(file, options = {}) {
  // Acquire at invocation, before any parsing await: a subsequent delete/toggle
  // queues after this install instead of being undone by its eventual commit.
  return navigator.locks.request(_PBP_MULTI_LOCK, { signal: options.signal }, async () => {
    let db, generation, activated = false;
    const progress = payload => { if (options.onProgress) { try { options.onProgress(payload); } catch (_) {} } };
    try {
      const zip = await _pbpYomitanZip(file, options.signal);
      const manifest = await _pbpYomitanManifest(await _pbpYomitanReadJson(file, zip.entries.find(e => e.kind === "index"), options.signal), options);
      _pbpYomitanCheck(!manifest.missingLanguages.length, "Dictionary languages must be supplied", "language_required");
      _pbpYomitanAbort(options.signal);
      db = await _pbpMultiOpenDB();
      const installed = await pbpDictPackList(), previous = installed.find(pack => pack.id === manifest.id);
      _pbpYomitanCheck(previous || installed.length < PBP_YOMITAN_LIMITS.packs, "Too many installed dictionary packs", "too_many_packs");
      generation = crypto.randomUUID();
      await _pbpPackTx(db, "readwrite", tx => tx.objectStore("generations").put({ id: generation, packId: manifest.id }), ["generations"]);
      let count = 0, payloadBytes = 0;
      const encoder = new TextEncoder(), tags = {};
      const banks = zip.entries.filter(entry => entry.kind === "terms" || entry.kind === "tags").sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
      for (const entry of banks) {
        _pbpYomitanAbort(options.signal);
        const raw = await _pbpYomitanReadJson(file, entry, options.signal);
        _pbpYomitanCheck(Array.isArray(raw), "Dictionary bank is not an array");
        if (entry.kind === "tags") {
          for (const tag of raw) {
            _pbpYomitanCheck(Array.isArray(tag) && tag.length === 5 && typeof tag[0] === "string" && typeof tag[1] === "string" && Number.isFinite(tag[2]) && typeof tag[3] === "string" && Number.isFinite(tag[4]), "Invalid dictionary tag bank");
            _pbpYomitanCheck(Object.keys(tags).length < 4096 && tag[0].length <= 256 && tag[3].length <= 4096, "Dictionary tags exceed limit", "too_large");
            Object.defineProperty(tags, tag[0], { value: { category: tag[1], notes: tag[3] }, enumerable: true, configurable: true });
          }
          continue;
        }
        for (let i = 0; i < raw.length; i += 200) {
          _pbpYomitanAbort(options.signal);
          const batch = raw.slice(i, i + 200).map(value => {
            const row = _pbpYomitanRow(value); payloadBytes += encoder.encode(JSON.stringify(row)).length; count++;
            _pbpYomitanCheck(count <= PBP_YOMITAN_LIMITS.entries && payloadBytes <= PBP_YOMITAN_LIMITS.payloadBytes, "Dictionary content exceeds import limit", "too_large");
            return { ...row, generation, row: count };
          });
          await _pbpPackTx(db, "readwrite", tx => { for (const row of batch) tx.objectStore("terms").put(row); }, ["terms"]);
          progress({ phase: "staging", entries: count, decodedBytes: zip.decodedBytes });
        }
      }
      _pbpYomitanCheck(count > 0, "Dictionary contains no terms");
      _pbpYomitanAbort(options.signal);
      const meta = { ...manifest, state: "ready", activeGeneration: generation, entries: count, payloadBytes,
        decodedBytes: zip.decodedBytes, importedAt: Date.now(), enabled: previous ? previous.enabled : true,
        aiAllowed: false, tags, ignoredFiles: zip.entries.filter(entry => entry.kind === "ignored" && !entry.name.endsWith("/")).length };
      await _pbpPackTx(db, "readwrite", tx => {
        _pbpYomitanAbort(options.signal); tx.objectStore("packs").put(meta);
        if (previous) { tx.objectStore("terms").delete(_pbpMultiRange(previous.activeGeneration)); tx.objectStore("generations").delete(previous.activeGeneration); }
      }, ["packs", "terms", "generations"]);
      activated = true; _pbpMultiNotify(meta.id, "import"); progress({ phase: "complete", entries: count, decodedBytes: zip.decodedBytes }); return meta;
    } catch (error) {
      if (db && generation && !activated) {
        try { await _pbpPackTx(db, "readwrite", tx => { tx.objectStore("terms").delete(_pbpMultiRange(generation)); tx.objectStore("generations").delete(generation); }, ["terms", "generations"]); }
        catch (cleanupError) { console.warn("[pack] staging cleanup failed:", cleanupError?.name, "Unable to remove incomplete generation"); }
      }
      if (typeof error?.code === "string" || error?.name === "AbortError") throw error;
      console.warn("[pack] multilingual import failed:", error?.name, "Unable to install dictionary");
      throw _pbpYomitanError(db ? "storage" : "invalid_pack", "Dictionary import failed");
    }
  });
}

async function pbpDictPackLookup(term, options = {}) {
  const empty = state => ({ state, hits: [], truncated: false, truncatedPackIds: [] });
  try {
    const key = _pbpYomitanKey(term), language = _pbpYomitanPrimary(_pbpYomitanLanguage(options.sourceLanguage));
    const target = _pbpYomitanPrimary(_pbpYomitanLanguage(options.targetLanguage));
    if (!key || key.length > 256 || !language) return empty("unavailable");
    const limit = Math.max(1, Math.min(PBP_YOMITAN_LIMITS.hits, Number.isInteger(options.limit) ? options.limit : PBP_YOMITAN_LIMITS.hits));
    const db = await _pbpMultiOpenDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(["packs", "terms"], "readonly"), perPack = [], truncated = new Set(); let candidates = 0;
      const packs = tx.objectStore("packs").getAll();
      packs.onsuccess = () => {
        for (const pack of packs.result) {
          if (!pack.enabled || (options.packId && options.packId !== pack.id) || _pbpYomitanPrimary(pack.sourceLanguage) !== language || (target && _pbpYomitanPrimary(pack.targetLanguage) !== target)) continue;
          candidates++;
          const queries = [["term", key], ["reading", key], ["folded", key.toLowerCase()]];
          const next = index => {
            const [field, value] = queries[index], request = tx.objectStore("terms").index(field).getAll([pack.activeGeneration, value], 161);
            request.onsuccess = () => {
              const rows = request.result;
              if (!rows.length) { if (index < queries.length - 1) next(index + 1); return; }
              if (rows.length > 160) truncated.add(pack.id);
              const groups = new Map();
              for (const row of rows.slice(0, 160)) {
                if (!groups.has(row.term)) groups.set(row.term, []);
                const group = groups.get(row.term);
                if (group.length < PBP_YOMITAN_LIMITS.rowsPerHit) group.push(row); else truncated.add(pack.id);
              }
              perPack.push([...groups.values()].map(group => {
                if (group.reduce((n, row) => n + (row.definitions.length || row.lemmas.length), 0) > PBP_YOMITAN_LIMITS.sensesPerHit) truncated.add(pack.id);
                return { pack, rows: group, norm: _pbpYomitanNorm(group, pack) };
              }));
            };
          };
          next(0);
        }
      };
      tx.oncomplete = () => {
        const hits = []; let n = 0;
        perPack.sort((a, b) => a[0].pack.title.localeCompare(b[0].pack.title) || a[0].pack.id.localeCompare(b[0].pack.id));
        while (perPack.some(groups => groups.length > n)) {
          for (const groups of perPack) { if (!groups[n]) continue; if (hits.length < limit) hits.push(groups[n]); else truncated.add(groups[n].pack.id); }
          n++;
        }
        resolve({ state: hits.length ? "hit" : candidates ? "ready-miss" : "unavailable", hits, truncated: truncated.size > 0, truncatedPackIds: [...truncated] });
      };
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("Dictionary lookup failed"));
    });
  } catch (error) { console.warn("[pack] multilingual lookup failed:", error?.name, "Unable to read dictionary results"); return empty("error"); }
}
